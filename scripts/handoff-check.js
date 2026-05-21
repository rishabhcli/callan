#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-handoff-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BUILDS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false',
  GEMINI_API_KEY: '',
  SUPERMEMORY_API_KEY: '',
  AGENTMAIL_API_KEY: '',
  AGENTMAIL_INBOX_ID: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  BROWSER_USE_API_KEY: '',
  MOSS_PROJECT_ID: '',
  MOSS_PROJECT_KEY: ''
});

const results = [];
let leadSeq = 0;

try {
  const [
    dbApi,
    memoryApi,
    mailerApi,
    handoffApi,
    stripeApi
  ] = await Promise.all([
    import('../server/db.js'),
    import('../server/memory.js'),
    import('../server/workers/mailer.js'),
    import('../server/handoff.js'),
    import('../server/webhooks/stripe.js')
  ]);

  const legalLeadId = insertLead(dbApi, memoryApi.containerTagFor, {
    id: 'handoff_legal_owner',
    business_name: 'Contract Care HVAC'
  });
  const caseIds = {};

  await check('legal request creates case and safe reply', async () => {
    const inbound = await mailerApi.handleAgentMailInbound({
      body: agentMailPayload({
        leadId: legalLeadId,
        eventId: 'evt_legal',
        messageId: 'msg_legal',
        threadId: 'thread_legal',
        subject: 'Contract question',
        text: 'Can you review our legal contract and tell us if the liability clause is okay?'
      }),
      eventId: 'evt_legal'
    });
    const cases = dbApi.handoffCases.listByLead(legalLeadId, { status: 'open' });
    const outbound = dbApi.contactEvents.listByLead(legalLeadId).find((event) => event.type === 'handoff_reply');
    assert.equal(inbound.classification.operatorFlag, true);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].category, 'legal');
    assert.ok(outbound?.body.includes('flagged the operator'), 'safe handoff reply should be sent');
    assert.ok(cases[0].copilot?.whyNotAutonomous, 'copilot why-not-autonomous should persist');
    caseIds.legal = cases[0].id;
    return { caseId: cases[0].id, outboundEventId: outbound.id };
  });

  await check('idempotency avoids duplicate case', async () => {
    await mailerApi.handleAgentMailInbound({
      body: agentMailPayload({
        leadId: legalLeadId,
        eventId: 'evt_legal',
        messageId: 'msg_legal',
        threadId: 'thread_legal',
        subject: 'Contract question',
        text: 'Can you review our legal contract and tell us if the liability clause is okay?'
      }),
      eventId: 'evt_legal'
    });
    const cases = dbApi.handoffCases.listByLead(legalLeadId, { status: 'all' });
    assert.equal(cases.length, 1);
    return { count: cases.length };
  });

  const refundLeadId = insertLead(dbApi, memoryApi.containerTagFor, {
    id: 'handoff_refund_owner',
    business_name: 'Refund Ridge Plumbing'
  });

  await check('refund threat creates high severity case', async () => {
    await mailerApi.handleAgentMailInbound({
      body: agentMailPayload({
        leadId: refundLeadId,
        eventId: 'evt_refund',
        messageId: 'msg_refund',
        threadId: 'thread_refund',
        subject: 'Not happy',
        text: 'This is unacceptable. I want a refund or I will file a chargeback.'
      }),
      eventId: 'evt_refund'
    });
    const [row] = dbApi.handoffCases.listByLead(refundLeadId, { status: 'open' });
    assert.equal(row.category, 'refund_threat');
    assert.equal(row.severity, 'high');
    caseIds.refund = row.id;
    return { caseId: row.id, severity: row.severity };
  });

  await check('auth wall creates builder case', () => {
    const leadId = insertLead(dbApi, memoryApi.containerTagFor, {
      id: 'handoff_auth_wall',
      business_name: 'Auth Wall Electric',
      status: 'paid'
    });
    const result = handoffApi.createHandoffCaseFromBuilderAuthWall({
      leadId,
      buildId: 'bld_auth_wall',
      sessionId: 'sess_auth_wall',
      target: 'lovable',
      reason: 'Sign in required'
    });
    assert.equal(result.case.category, 'build_auth_wall');
    assert.equal(result.case.status, 'open');
    caseIds.authWall = result.case.id;
    return { caseId: result.case.id };
  });

  const rewriteLeadId = insertLead(dbApi, memoryApi.containerTagFor, {
    id: 'handoff_rewrite_owner',
    business_name: 'Weird Wire Wellness'
  });

  await check('operator rewrites and sends reply', async () => {
    await mailerApi.handleAgentMailInbound({
      body: agentMailPayload({
        leadId: rewriteLeadId,
        eventId: 'evt_weird_rewrite',
        messageId: 'msg_weird_rewrite',
        threadId: 'thread_weird_rewrite',
        subject: 'Unusual request',
        text: 'Can you route the project payment to a bitcoin wallet or gift cards?'
      }),
      eventId: 'evt_weird_rewrite'
    });
    const weirdCase = dbApi.handoffCases.listByLead(rewriteLeadId, { status: 'open' }).find((row) => row.category === 'weird_request');
    assert.ok(weirdCase, 'weird request should create an operator case');
    const result = await handoffApi.performHandoffAction(weirdCase.id, {
      action: 'rewrite_send_reply',
      actor: 'operator',
      body: 'Thanks for checking. An operator reviewed this and will follow up on the normal invoice thread.'
    });
    assert.equal(result.case.status, 'operator_reply_sent');
    assert.ok(result.action.payload.outboundEventId, 'rewritten reply should persist an outbound operator event');
    assert.ok(dbApi.contactEvents.listByLead(rewriteLeadId).some((event) => event.type === 'operator_reply' && event.body.includes('operator reviewed')));
    caseIds.rewrite = weirdCase.id;
    return { caseId: result.case.id, outboundEventId: result.action.payload.outboundEventId };
  });

  await check('operator approves and rejects replies', async () => {
    const legalCase = dbApi.handoffCases.get(caseIds.legal);
    assert.ok(legalCase, 'legal case should exist for approval');
    const approved = await handoffApi.performHandoffAction(legalCase.id, {
      action: 'approve_reply',
      actor: 'operator',
      note: 'Draft is safe to send.'
    });
    assert.equal(approved.case.status, 'operator_reply_sent');
    assert.ok(dbApi.contactEvents.listByLead(legalLeadId).some((event) => event.type === 'operator_reply'));

    const refundCase = dbApi.handoffCases.get(caseIds.refund);
    assert.ok(refundCase, 'refund case should exist for rejection');
    const rejected = await handoffApi.performHandoffAction(refundCase.id, {
      action: 'reject_reply',
      actor: 'operator',
      note: 'Refund answer needs custom handling.'
    });
    assert.equal(rejected.case.status, 'needs_operator');
    assert.notEqual(approved.case.id, rejected.case.id, 'approve and reject should cover distinct cases');
    return { approved: approved.case.id, rejected: rejected.case.id };
  });

  await check('resolved case resumes safe automation', async () => {
    const row = dbApi.handoffCases.get(caseIds.legal);
    assert.ok(row, 'legal case should exist for resolution');
    await handoffApi.performHandoffAction(row.id, { action: 'pause_automation', actor: 'operator' });
    assert.equal(dbApi.leads.get(legalLeadId).next_action, 'operator_paused');
    const resumed = await handoffApi.performHandoffAction(row.id, { action: 'resume_automation', actor: 'operator' });
    assert.equal(resumed.case.status, 'in_progress');
    assert.equal(dbApi.leads.get(legalLeadId).next_action, null);
    const resolved = await handoffApi.performHandoffAction(row.id, {
      action: 'resolve',
      actor: 'operator',
      resumeAutomation: true,
      note: 'Human reviewed and cleared the thread.'
    });
    const lead = dbApi.leads.get(legalLeadId);
    assert.equal(resolved.case.status, 'resolved');
    assert.equal(lead.risk_status, 'operator-resolved');
    assert.equal(lead.next_action, null);
    return { caseId: resolved.case.id, riskStatus: lead.risk_status };
  });

  await check('operator callback and retry build/QA actions persist', async () => {
    const refundCase = dbApi.handoffCases.get(caseIds.refund);
    assert.ok(refundCase, 'refund case should exist for callback and retry');
    const callback = await handoffApi.performHandoffAction(refundCase.id, {
      action: 'assign_callback',
      actor: 'operator',
      scheduledAtMs: Date.now() + 30 * 60_000,
      ask: 'Refund de-escalation call'
    });
    let retryArgs = null;
    const retry = await handoffApi.performHandoffAction(refundCase.id, {
      action: 'retry_build',
      actor: 'operator',
      startBuilder: (args) => { retryArgs = args; }
    });
    let qaRetryArgs = null;
    const retryQa = await handoffApi.performHandoffAction(refundCase.id, {
      action: 'retry_qa',
      actor: 'operator',
      startBuilder: (args) => { qaRetryArgs = args; }
    });
    assert.ok(callback.action.payload.scheduledCall?.id, 'callback should be scheduled');
    assert.deepEqual(retryArgs, { leadId: refundLeadId, target: undefined });
    assert.deepEqual(qaRetryArgs, { leadId: refundLeadId, target: undefined });
    assert.equal(retry.case.status, 'in_progress');
    assert.equal(retryQa.case.status, 'in_progress');
    return { scheduledCallId: callback.action.payload.scheduledCall.id, retryLeadId: retryArgs.leadId, retryQaLeadId: qaRetryArgs.leadId };
  });

  await check('remaining classifiers route to handoff', () => {
    const security = handoffApi.classifyHandoffRisk({ text: 'We had a security breach and password leak.' });
    const tax = handoffApi.classifyHandoffRisk({ text: 'Can you decide whether sales tax or a W-9 applies?' });
    const contract = handoffApi.classifyHandoffRisk({ text: 'Please redline the indemnity clause in our custom contract.' });
    const guarantee = handoffApi.classifyHandoffRisk({ text: 'Can you guarantee first page Google rankings and revenue?' });
    const payment = handoffApi.classifyHandoffRisk({ text: 'Stripe says the payment failed and my card was declined.' });
    const angry = handoffApi.classifyHandoffRisk({ text: 'This is a scam and I am furious.' });
    const consent = handoffApi.classifyHandoffRisk({ text: 'Are you recording? I did not consent to this call.' });
    const provider = handoffApi.classifyHandoffRisk({ text: 'Browser provider timeout and API failure.' });
    const qa = handoffApi.classifyHandoffRisk({ text: 'QA failed after max revisions.' });
    const weird = handoffApi.classifyHandoffRisk({ text: 'Send me a wire transfer for bitcoin and gift cards.' });
    assert.equal(security.category, 'security_issue');
    assert.equal(tax.category, 'tax');
    assert.equal(contract.category, 'custom_contract');
    assert.equal(guarantee.category, 'guarantee');
    assert.equal(payment.category, 'payment_failure');
    assert.equal(angry.category, 'angry_customer');
    assert.equal(consent.category, 'uncertain_call_consent');
    assert.equal(provider.category, 'provider_failure');
    assert.equal(qa.category, 'qa_failure');
    assert.equal(weird.category, 'weird_request');
    return {
      categories: [
        security.category,
        tax.category,
        contract.category,
        guarantee.category,
        payment.category,
        angry.category,
        consent.category,
        provider.category,
        qa.category,
        weird.category
      ]
    };
  });

  await check('stripe payment failure creates case', () => {
    const leadId = insertLead(dbApi, memoryApi.containerTagFor, {
      id: 'handoff_payment_owner',
      business_name: 'Payment Fail Cafe'
    });
    const event = {
      id: 'evt_stripe_failed',
      type: 'invoice.payment_failed',
      livemode: false,
      data: {
        object: {
          id: 'in_failed',
          object: 'invoice',
          customer: 'cus_failed',
          customer_email: 'owner@example.test',
          amount_due: 50000,
          status: 'open',
          metadata: { leadId },
          last_payment_error: { message: 'card declined' }
        }
      }
    };
    const result = stripeApi.processStripeWebhookEvent(event, {});
    assert.equal(result.paymentFailure, true);
    assert.equal(result.handoff.category, 'payment_failure');
    return { caseId: result.handoff.id };
  });

  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({ ok, dataDir: resolve(dataDir), results }, null, 2));
  for (const result of results) {
    console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
  }
  if (!ok) process.exitCode = 1;
} finally {
  if (!process.env.KEEP_HANDOFF_CHECK_DATA) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: formatDetail(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.stack || err?.message || String(err) });
  }
}

function insertLead(api, containerTagFor, patch = {}) {
  const id = patch.id || `handoff_${Date.now().toString(36)}`;
  const seq = String(1000 + (++leadSeq)).slice(-4);
  const result = api.leads.insert({
    id,
    container_tag: containerTagFor(id),
    business_name: patch.business_name || 'Handoff Test Business',
    phone: patch.phone || `+1415555${seq}`,
    address: '1 Market St, San Francisco, CA',
    niche: patch.niche || 'local services',
    city: patch.city || 'San Francisco',
    website: patch.website || null,
    status: patch.status || 'awaiting_payment',
    research_status: 'complete',
    outreach_status: patch.outreach_status || 'awaiting_payment',
    risk_status: patch.risk_status || 'callable',
    consent_status: 'operator_demo',
    phone_classification: 'business',
    source_url: patch.source_url || `https://example.test/handoff/${id}`,
    ...patch
  });
  return result.lead.id;
}

function agentMailPayload({ leadId, eventId, messageId, threadId, subject, text }) {
  return {
    type: 'message.received',
    event_id: eventId,
    message_id: messageId,
    thread_id: threadId,
    direction: 'inbound',
    from: { email: 'owner@example.test' },
    subject,
    text,
    leadId
  };
}

function formatDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  return JSON.stringify(detail);
}
