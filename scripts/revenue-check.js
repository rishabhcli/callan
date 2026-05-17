#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-revenue-'));
const results = [];
let dbModule;

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
  AGENTPHONE_API_KEY: '',
  AGENTPHONE_WEBHOOK_SECRET: '',
  AGENTMAIL_API_KEY: '',
  AGENTMAIL_INBOX_ID: '',
  AGENTMAIL_WEBHOOK_SECRET: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  BROWSER_USE_API_KEY: '',
  MOSS_PROJECT_ID: '',
  MOSS_PROJECT_KEY: ''
});

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : JSON.stringify(detail));
  } catch (err) {
    fail(name, err?.stack || err?.message || String(err));
  }
}

function stamp(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

try {
  const [
    dbImport,
    memoryImport,
    mailerImport,
    stripeWebhookImport,
    builderImport,
    paymentFlowImport
  ] = await Promise.all([
    import('../server/db.js'),
    import('../server/memory.js'),
    import('../server/workers/mailer.js'),
    import('../server/webhooks/stripe.js'),
    import('../server/workers/builder.js'),
    import('../server/paymentFlow.js')
  ]);
  dbModule = dbImport;

  const { leads, runs, calls, payments, builds, contactEvents, webhookEvents } = dbImport;
  const { containerTagFor } = memoryImport;
  const { runMailer, handleAgentMailInbound } = mailerImport;
  const { processStripeWebhookEvent } = stripeWebhookImport;
  const { runBuilder } = builderImport;
  const { revenueStatusForLead } = paymentFlowImport;

  const leadId = stamp('lead_revenue');
  const invoiceEmail = 'owner@riverbend-roofing.test';
  const transcript = [
    { role: 'agent', text: 'This call may be recorded so we can improve service quality. Hi, is this Riverbend Roofing?' },
    { role: 'user', text: 'Yes, this is Jordan.' },
    { role: 'agent', text: 'We build a simple website for $500 flat so people can see emergency roofing, service areas, and call you fast.' },
    { role: 'user', text: 'Yes, if it is really $500 flat, send me the invoice.' },
    { role: 'agent', text: 'What is the best email for the invoice?' },
    { role: 'user', text: `Use ${invoiceEmail}.` },
    { role: 'agent', text: `I have ${invoiceEmail}. Is that right? The invoice will come from AgentMail and you can reply there with questions.` },
    { role: 'user', text: 'Yes, that is correct.' }
  ].map((turn, index) => ({ ...turn, ts: Date.now() + index * 1000 }));

  await check('seed.synthetic_call_with_confirmed_email', () => {
    leads.insert({
      id: leadId,
      container_tag: containerTagFor(leadId),
      business_name: 'Riverbend Roofing',
      phone: '+14155550244',
      address: '20 Bay St, San Francisco, CA',
      niche: 'roofing',
      city: 'San Francisco',
      website: null,
      status: 'closing',
      research_status: 'complete',
      outreach_status: 'called',
      risk_status: 'callable',
      consent_status: 'operator_demo',
      phone_classification: 'business',
      next_action: 'send_invoice'
    });
    const callId = `call_${leadId}`;
    calls.start({
      id: callId,
      lead_id: leadId,
      to_phone: '+14155550244',
      provider_call_id: 'mock-agentphone-call',
      disclosure_text: 'This call may be recorded so we can improve service quality.',
      decision_reason: 'revenue check synthetic call'
    });
    calls.finish(callId, { outcome: 'won', transcript });

    const postMortem = {
      outcome: 'won',
      reason: 'Owner explicitly asked for the invoice after hearing the $500 flat offer.',
      replayMoments: [{ ts: transcript[3].ts, excerpt: transcript[3].text, note: 'Explicit invoice interest.' }],
      replayWorthy: transcript[3].text,
      invoiceEmail,
      confirmedEmail: true,
      emailConfirmation: {
        email: invoiceEmail,
        confirmed: true,
        source: 'transcript_readback',
        evidence: {
          provided: transcript[5].text,
          readBack: transcript[6].text,
          confirmation: transcript[7].text
        }
      },
      customerQuestions: ['Can the site show emergency roofing?'],
      whatWorked: ['Flat price was concrete.', 'Email was read back and confirmed.'],
      whatToTryNext: ['Ask for service area photos.'],
      followupEmailDraft: 'Thanks for the call. The invoice is below; once paid, the roof repair site build starts.'
    };
    const runId = `analyst_${leadId}`;
    runs.start({ id: runId, lead_id: leadId, worker: 'analyst' });
    runs.finish(runId, { state: 'completed', detail: { postMortem } });
    return { leadId, invoiceEmail };
  });

  let mailerResult;
  await check('invoice.agentmail_send_after_gate', async () => {
    mailerResult = await runMailer({ leadId, toEmail: invoiceEmail });
    assert(!mailerResult.blocked, `mailer blocked: ${JSON.stringify(mailerResult)}`);
    const payment = payments.listByLead(leadId)[0];
    assert(payment, 'payment row missing');
    assert(payment.customer_email === invoiceEmail, `unexpected customer email ${payment.customer_email}`);
    assert(payment.hosted_invoice_url, 'hosted invoice URL missing');
    assert(payment.invoice_pdf_url, 'invoice PDF URL missing');
    const consent = contactEvents.listByLead(leadId, { limit: 20 }).find((event) => event.type === 'invoice_consent');
    assert(consent, 'invoice consent event missing');
    const sent = contactEvents.listByLead(leadId, { limit: 20 }).find((event) => event.type === 'invoice_email');
    assert(sent, 'AgentMail invoice email event missing');
    const meta = JSON.parse(sent.metadata_json);
    assert(meta.paymentId === payment.id, 'invoice email did not store paymentId');
    assert(meta.messageId, 'invoice email did not store AgentMail messageId');
    return { paymentId: payment.id, invoiceId: payment.stripe_invoice_id, threadId: sent.thread_id };
  });

  let inboundResult;
  await check('agentmail.inbound_reply_auto_reply_idempotent', async () => {
    const inboundPayload = {
      id: `evt_agentmail_${leadId}`,
      type: 'message.received',
      direction: 'inbound',
      threadId: mailerResult.threadId,
      messageId: `msg_${leadId}`,
      from: { email: invoiceEmail },
      subject: 'Re: Your callmemaybe website invoice + meeting invite',
      extractedText: 'Can you make the emergency roofing call button obvious?',
      leadId
    };
    const eventId = `event:${inboundPayload.id}`;
    const recorded = webhookEvents.recordOnce({ provider: 'agentmail', event_id: eventId, type: inboundPayload.type, payload: inboundPayload });
    assert(recorded, 'first AgentMail webhook was not recorded');
    inboundResult = await handleAgentMailInbound({ body: inboundPayload, eventId });
    assert(inboundResult.ignored === false, `inbound ignored: ${JSON.stringify(inboundResult)}`);
    assert(inboundResult.outboundContactEventId, 'auto reply contact event missing');
    const duplicateRecorded = webhookEvents.recordOnce({ provider: 'agentmail', event_id: eventId, type: inboundPayload.type, payload: inboundPayload });
    assert(duplicateRecorded === false, 'duplicate AgentMail event was recorded twice');
    const events = contactEvents.listByLead(leadId, { limit: 40 });
    assert(events.filter((event) => event.type === 'customer_reply').length === 1, 'duplicate inbound customer reply created');
    assert(events.filter((event) => event.type === 'agent_reply').length === 1, 'expected one auto reply');
    return { inbound: inboundResult.inboundContactEventId, outbound: inboundResult.outboundContactEventId };
  });

  let buildStarts = [];
  await check('stripe.paid_webhook_triggers_one_build', async () => {
    const payment = payments.listByLead(leadId)[0];
    const stripeEvent = {
      id: `evt_stripe_${leadId}`,
      type: 'invoice.paid',
      livemode: false,
      data: {
        object: {
          id: payment.stripe_invoice_id,
          object: 'invoice',
          customer: payment.stripe_customer_id,
          customer_email: payment.customer_email,
          hosted_invoice_url: payment.hosted_invoice_url,
          invoice_pdf: payment.invoice_pdf_url,
          amount_paid: payment.amount_cents,
          due_date: Math.floor(payment.due_at / 1000),
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
          metadata: { leadId, offerVersion: payment.offer_version }
        }
      }
    };
    const first = processStripeWebhookEvent(stripeEvent, { startBuilder: (args) => buildStarts.push(args) });
    const duplicate = processStripeWebhookEvent(stripeEvent, { startBuilder: (args) => buildStarts.push(args) });
    assert(first.duplicate === false, `first Stripe event duplicate: ${JSON.stringify(first)}`);
    assert(duplicate.duplicate === true, `duplicate Stripe event not detected: ${JSON.stringify(duplicate)}`);
    assert(buildStarts.length === 1, `expected one builder start, got ${buildStarts.length}`);
    await runBuilder(buildStarts[0]);
    const buildRows = builds.listByLead(leadId);
    assert(buildRows.length === 1, `expected one build row, got ${buildRows.length}`);
    assert(buildRows[0].status === 'completed', `build not completed: ${buildRows[0].status}`);
    return { buildId: buildRows[0].id, duplicate: duplicate.duplicate };
  });

  await check('revenue.status_endpoint_model', () => {
    const status = revenueStatusForLead(leadId);
    assert(status?.gate?.ok === true, `revenue gate not ok: ${JSON.stringify(status?.gate)}`);
    assert(status.latestPayment?.status === 'paid', `latest payment not paid: ${status.latestPayment?.status}`);
    assert(status.thread?.threadId === mailerResult.threadId, 'thread not linked');
    assert(status.replies === 1, `expected one reply, got ${status.replies}`);
    return { paid: status.latestPayment.status, threadId: status.thread.threadId, replies: status.replies };
  });
} finally {
  if (dbModule?.db?.open) dbModule.db.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('\n=== REVENUE CHECK RESULTS ===\n');
for (const result of results) {
  console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length) process.exit(1);

console.log(JSON.stringify({
  ok: true,
  dataDir: resolve(dataDir),
  checks: results.length,
  passed: results.length - failed.length
}, null, 2));
