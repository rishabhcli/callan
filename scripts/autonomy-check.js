// Deterministic local autonomy verification.
// Uses temporary SQLite data directories and mock provider posture only.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const results = [];
let dbModule;

function pass(name, detail = '') {
  results.push({ name, ok: true, detail });
}

function fail(name, detail = '') {
  results.push({ name, ok: false, detail });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hasReason(result, code) {
  return Array.isArray(result?.reasonCodes) && result.reasonCodes.includes(code);
}

function stamp(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function phone(suffix) {
  return `+1415555${suffix}`;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, formatDetail(detail));
  } catch (err) {
    fail(name, err?.stack || err?.message || String(err));
  }
}

function formatDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  return JSON.stringify(detail);
}

function configureIsolatedEnv(dataDir) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    RUN_MODE: 'autonomous_live',
    AUTONOMOUS_OUTREACH_ENABLED: 'true',
    LIVE_CALLS: 'false',
    LIVE_EMAILS: 'false',
    LIVE_PAYMENTS: 'false',
    LIVE_BUILDS: 'false',
    OUTREACH_INTERVAL_MS: '25',
    OUTREACH_BATCH_SIZE: '3',
    MAX_ATTEMPTS_PER_PHONE: '2',
    QUIET_HOURS_START: '0',
    QUIET_HOURS_END: '0',
    OUTREACH_TIMEZONE: 'America/Los_Angeles',
    ALLOWED_TARGET_PHONES: phone('0101'),
    ALLOWED_TARGET_EMAILS: 'owner@example.com',
    GEMINI_API_KEY: '',
    SUPERMEMORY_API_KEY: '',
    AGENTPHONE_API_KEY: '',
    AGENTPHONE_WEBHOOK_SECRET: 'verification-agentphone-secret',
    AGENTMAIL_API_KEY: '',
    AGENTMAIL_INBOX_ID: '',
    AGENTMAIL_WEBHOOK_SECRET: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: 'whsec_verification',
    BROWSER_USE_API_KEY: '',
    MOSS_PROJECT_ID: '',
    MOSS_PROJECT_KEY: ''
  });
}

function setQuietHours(env, start, end) {
  env.outreach.quietHoursStart = start;
  env.outreach.quietHoursEnd = end;
}

function resetComplianceEnv(env) {
  env.runMode = 'autonomous_live';
  env.allowedPhones.splice(0, env.allowedPhones.length, phone('0101'));
  env.outreach.maxAttemptsPerPhone = 2;
  setQuietHours(env, 0, 0);
}

function disclosure(recordingDisclosure, businessName = 'Verification Cafe') {
  return recordingDisclosure(businessName);
}

function insertLead(leads, containerTagFor, patch = {}) {
  const id = patch.id || stamp('lead');
  const result = leads.insert({
    id,
    container_tag: containerTagFor(id),
    business_name: patch.business_name || `Verification Cafe ${id.slice(-6)}`,
    phone: patch.phone ?? phone('0199'),
    address: patch.address ?? '1 Market St, San Francisco, CA',
    niche: patch.niche || 'cafe',
    city: patch.city || 'San Francisco',
    website: patch.website ?? null,
    status: patch.status || 'discovered',
    research_status: patch.research_status || 'complete',
    consent_status: patch.consent_status || 'public_business',
    phone_classification: patch.phone_classification || 'business',
    ...patch
  });
  return result.lead.id;
}

async function runCoreChecks(mods) {
  const {
    env,
    db,
    leads,
    payments,
    builds,
    contactEvents,
    webhookEvents,
    callAttempts,
    doNotCall,
    normalizePhone,
    recordOptOut,
    dncCheck,
    recordingDisclosure,
    transcriptHasOptOut,
    isQuietHours,
    callabilityForLead,
    recordCallDecision,
    queueLeadForOutreach,
    containerTagFor,
    recordPaidPayment,
    recoverTriggeredPaymentBuilds,
    extractConfirmedInvoiceEmail,
    classifyMessage,
    handleAgentMailInbound
  } = mods;

  await check('compliance.phone_normalization', () => {
    const normalized = normalizePhone('(415) 555-0199');
    assert(normalized === '+4155550199', `expected +4155550199, got ${normalized}`);
    return normalized;
  });

  await check('compliance.gates_invalid_phone', () => {
    resetComplianceEnv(env);
    const res = dncCheck('not-a-phone', { disclosureText: disclosure(recordingDisclosure) });
    assert(!res.ok && hasReason(res, 'INVALID_PHONE'), `unexpected result ${JSON.stringify(res)}`);
    return res.reason;
  });

  await check('compliance.gates_recording_disclosure_required', () => {
    resetComplianceEnv(env);
    const res = dncCheck(phone('0202'), {
      lead: { address: '1 Market St' },
      disclosureText: 'hello from a bot'
    });
    assert(!res.ok && hasReason(res, 'RECORDING_DISCLOSURE_MISSING'), `unexpected result ${JSON.stringify(res)}`);
    return res.reason;
  });

  await check('compliance.gates_demo_live_allowlist', () => {
    resetComplianceEnv(env);
    env.runMode = 'demo_live';
    env.allowedPhones.splice(0, env.allowedPhones.length, phone('0101'));
    const blocked = dncCheck(phone('0203'), {
      lead: { address: '1 Market St' },
      disclosureText: disclosure(recordingDisclosure)
    });
    const allowed = dncCheck(phone('0101'), {
      lead: { address: '1 Market St' },
      disclosureText: disclosure(recordingDisclosure)
    });
    assert(!blocked.ok && hasReason(blocked, 'DEMO_LIVE_TARGET_NOT_OWNED_OR_SEEDED'), `unexpected blocked ${JSON.stringify(blocked)}`);
    assert(allowed.ok, `allowed phone should pass, got ${JSON.stringify(allowed)}`);
    return { blocked: blocked.reason, allowed: allowed.reason || 'ok' };
  });

  await check('compliance.gates_autonomous_business_only', () => {
    resetComplianceEnv(env);
    const unknown = dncCheck(phone('0204'), { disclosureText: disclosure(recordingDisclosure) });
    const business = dncCheck(phone('0205'), {
      lead: { address: '2 Market St' },
      disclosureText: disclosure(recordingDisclosure)
    });
    assert(!unknown.ok && hasReason(unknown, 'PHONE_UNKNOWN_RISK'), `unexpected unknown ${JSON.stringify(unknown)}`);
    assert(business.ok, `business phone should pass, got ${JSON.stringify(business)}`);
    return { unknown: unknown.reason, business: business.reason || 'ok' };
  });

  await check('compliance.quiet_hours_window', () => {
    resetComplianceEnv(env);
    setQuietHours(env, 20, 9);
    assert(isQuietHours(new Date(2026, 4, 17, 21, 0, 0)), '21:00 should be quiet');
    assert(isQuietHours(new Date(2026, 4, 17, 8, 0, 0)), '08:00 should be quiet');
    assert(!isQuietHours(new Date(2026, 4, 17, 12, 0, 0)), '12:00 should be callable');

    const currentHour = new Date().getHours();
    setQuietHours(env, currentHour, (currentHour + 1) % 24);
    const gated = dncCheck(phone('0206'), {
      lead: { address: '3 Market St' },
      disclosureText: disclosure(recordingDisclosure)
    });
    assert(!gated.ok && hasReason(gated, 'OUTSIDE_CALLING_HOURS'), `unexpected gate ${JSON.stringify(gated)}`);
    return gated.reason;
  });

  await check('compliance.max_attempts_per_phone', () => {
    resetComplianceEnv(env);
    const target = phone('0207');
    callAttempts.add({ id: stamp('attempt'), phone: target, allowed: true, reason: 'first' });
    callAttempts.add({ id: stamp('attempt'), phone: target, allowed: true, reason: 'second' });
    const res = dncCheck(target, {
      lead: { address: '4 Market St' },
      disclosureText: disclosure(recordingDisclosure)
    });
    assert(!res.ok && hasReason(res, 'MAX_ATTEMPTS_PHONE'), `unexpected result ${JSON.stringify(res)}`);
    return res.reason;
  });

  await check('compliance.optout_persistence', () => {
    resetComplianceEnv(env);
    const target = phone('0208');
    assert(transcriptHasOptOut('Please remove me from your calling list.'), 'transcript opt-out phrase not detected');
    recordOptOut(target);
    assert(doNotCall.has(target), 'phone was not persisted in do_not_call');
    const res = dncCheck(target, {
      lead: { address: '5 Market St' },
      disclosureText: disclosure(recordingDisclosure)
    });
    assert(!res.ok && hasReason(res, 'DNC_OPT_OUT'), `unexpected result ${JSON.stringify(res)}`);
    return res.reason;
  });

  await check('compliance.call_decision_audit_trail', () => {
    resetComplianceEnv(env);
    const target = phone('0209');
    recordCallDecision({
      leadId: null,
      phone: target,
      allowed: false,
      reason: 'verification blocked',
      disclosureText: disclosure(recordingDisclosure)
    });
    const count = callAttempts.countSince({ phone: target, since: 0 });
    assert(count === 1, `expected one audit attempt, got ${count}`);
    return `${count} call_attempt row`;
  });

  await check('queue.strong_presence_blocked', () => {
    resetComplianceEnv(env);
    const leadId = insertLead(leads, containerTagFor, {
      id: stamp('strong'),
      phone: phone('0210')
    });
    const result = queueLeadForOutreach({
      leadId,
      profile: {
        onlinePresenceStrength: 'strong',
        hasWebsite: true,
        websiteUrl: 'https://verification-cafe.example.test',
        onlinePresenceSummary: 'Modern website with menu, hours, reviews, photos, and online ordering.',
        signals: ['menu online', 'hours visible', 'reviews visible', 'photos gallery', 'order online'],
        sourceUrl: 'https://example.test/strong-presence'
      }
    });
    const row = leads.get(leadId);
    assert(result?.queued === false, `expected queued=false, got ${JSON.stringify(result)}`);
    assert(['blocked', 'blocked_visible'].includes(row.outreach_status), `expected blocked, got ${row.outreach_status}`);
    assert(row.next_action === 'do_not_call_strong_presence', `unexpected next_action ${row.next_action}`);
    return result.reason;
  });

  await check('queue.backoff_recent_retry_deprioritized', () => {
    resetComplianceEnv(env);
    const neverContacted = insertLead(leads, containerTagFor, { id: stamp('queue_never'), phone: phone('0211') });
    const staleRetry = insertLead(leads, containerTagFor, { id: stamp('queue_stale'), phone: phone('0212') });
    const recentRetry = insertLead(leads, containerTagFor, { id: stamp('queue_recent'), phone: phone('0213') });
    const now = Date.now();
    leads.update(neverContacted, { research_status: 'qualified', outreach_status: 'queued', last_contacted_at: null });
    leads.update(staleRetry, { research_status: 'qualified', outreach_status: 'retry', last_contacted_at: now - 60_000 });
    leads.update(recentRetry, { research_status: 'qualified', outreach_status: 'retry', last_contacted_at: now - 1_000 });

    const ids = new Set([neverContacted, staleRetry, recentRetry]);
    const order = leads.listOutreachQueue({ limit: 50 }).map((l) => l.id).filter((id) => ids.has(id));
    assert(
      order.join(',') === [neverContacted, staleRetry, recentRetry].join(','),
      `unexpected queue order ${order.join(' > ')}`
    );
    return order.join(' > ');
  });

  await check('queue.claims_multiple_outreach_agents_without_duplicates', () => {
    resetComplianceEnv(env);
    env.outreach.batchSize = 3;
    const first = insertLead(leads, containerTagFor, { id: stamp('claim_first'), phone: phone('0230') });
    const second = insertLead(leads, containerTagFor, { id: stamp('claim_second'), phone: phone('0231') });
    const future = insertLead(leads, containerTagFor, { id: stamp('claim_future'), phone: phone('0232') });
    const now = Date.now();
    leads.update(first, { research_status: 'qualified', outreach_status: 'queued', next_action: 'call', last_contacted_at: null });
    leads.update(second, { research_status: 'qualified', outreach_status: 'queued', next_action: 'call', last_contacted_at: null });
    leads.update(future, { research_status: 'qualified', outreach_status: 'retry', next_action: `retry_after:${now + 60_000}`, last_contacted_at: now });

    const claimA = leads.claimOutreach(first, { now, phoneClassification: 'business_landline' });
    const duplicate = leads.claimOutreach(first, { now: now + 1, phoneClassification: 'business_landline' });
    const claimB = leads.claimOutreach(second, { now: now + 2, phoneClassification: 'business_landline' });
    const blockedByBackoff = leads.claimOutreach(future, { now: now + 3, phoneClassification: 'business_landline' });
    const runningCount = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE outreach_status = 'running' AND id IN (?, ?)`).get(first, second).n;

    assert(claimA.claimed === true, `first claim failed: ${JSON.stringify(claimA)}`);
    assert(duplicate.claimed === false, `duplicate claim succeeded: ${JSON.stringify(duplicate)}`);
    assert(claimB.claimed === true, `second claim failed: ${JSON.stringify(claimB)}`);
    assert(blockedByBackoff.claimed === false, `future retry was claimed: ${JSON.stringify(blockedByBackoff)}`);
    assert(runningCount === 2, `expected two running claims, got ${runningCount}`);
    assert(leads.get(first).outreach_status === 'running', 'first was not running');
    assert(leads.get(second).outreach_status === 'running', 'second was not running');
    assert(leads.get(future).outreach_status === 'retry', 'future retry should remain queued');
    return { claimed: [claimA.row.id, claimB.row.id], duplicate: duplicate.reason, future: blockedByBackoff.reason };
  });

  await check('idempotency.payment_lookup_and_unique_key', () => {
    const leadId = insertLead(leads, containerTagFor, { id: stamp('payment'), phone: phone('0214') });
    const key = `invoice_${leadId}_50000`;
    payments.insert({
      id: `pay_${leadId}_a`,
      lead_id: leadId,
      stripe_session_id: `sess_${leadId}`,
      stripe_invoice_id: `in_${leadId}`,
      stripe_customer_id: `cus_${leadId}`,
      payment_link_url: `https://invoice.stripe.test/${leadId}`,
      hosted_invoice_url: `https://invoice.stripe.test/${leadId}`,
      amount_cents: 50000,
      status: 'created',
      due_at: Date.now() + 86_400_000,
      idempotency_key: key
    });
    const found = payments.getByIdempotency(key);
    assert(found?.stripe_invoice_id === `in_${leadId}`, 'payment was not found by idempotency key');

    let duplicateFailed = false;
    try {
      payments.insert({
        id: `pay_${leadId}_b`,
        lead_id: leadId,
        stripe_session_id: `sess_${leadId}_b`,
        stripe_invoice_id: `in_${leadId}_b`,
        stripe_customer_id: `cus_${leadId}_b`,
        payment_link_url: `https://invoice.stripe.test/${leadId}/b`,
        hosted_invoice_url: `https://invoice.stripe.test/${leadId}/b`,
        amount_cents: 50000,
        status: 'created',
        due_at: Date.now() + 86_400_000,
        idempotency_key: key
      });
    } catch (err) {
      duplicateFailed = /UNIQUE constraint failed/i.test(err?.message || String(err));
    }
    assert(duplicateFailed, 'duplicate idempotency key insert did not fail');
    return found.id;
  });

  await check('idempotency.webhook_event_replay_ignored', () => {
    const eventId = stamp('evt_replay');
    webhookEvents.record({ provider: 'stripe', event_id: eventId, type: 'invoice.paid', payload: { n: 1 } });
    webhookEvents.record({ provider: 'stripe', event_id: eventId, type: 'invoice.paid', payload: { n: 2 } });
    assert(webhookEvents.seen('stripe', eventId), 'webhook event was not recorded');
    const count = db.prepare(`SELECT COUNT(*) AS n FROM webhook_events WHERE provider = ? AND event_id = ?`).get('stripe', eventId).n;
    assert(count === 1, `expected replay count 1, got ${count}`);
    return `${eventId} count=${count}`;
  });

  await check('sales.transcript_confirmed_invoice_email_extraction', () => {
    const confirmedTranscript = [
      { role: 'agent', text: 'What is the best email for the invoice?', ts: 1 },
      { role: 'user', text: 'Use maria at lunaridge dot com.', ts: 2 },
      { role: 'agent', text: 'I have maria@lunaridge.com. Is that right?', ts: 3 },
      { role: 'user', text: 'Yes, that is correct.', ts: 4 }
    ];
    const confirmed = extractConfirmedInvoiceEmail({ transcript: confirmedTranscript });
    assert(confirmed.confirmed === true, `expected confirmed email, got ${JSON.stringify(confirmed)}`);
    assert(confirmed.email === 'maria@lunaridge.com', `unexpected email ${confirmed.email}`);

    const unconfirmed = extractConfirmedInvoiceEmail({
      transcript: [
        { role: 'agent', text: 'What is the best email for the invoice?', ts: 1 },
        { role: 'user', text: 'owner@example.com', ts: 2 },
        { role: 'agent', text: 'Great, I will send it now.', ts: 3 }
      ]
    });
    assert(unconfirmed.confirmed === false, `readback-free email should not be confirmed: ${JSON.stringify(unconfirmed)}`);
    return { confirmed: confirmed.email, unconfirmed: unconfirmed.email };
  });

  await check('agentmail.policy_classifies_supported_and_unsupported_scopes', () => {
    const cases = [
      { text: 'Can I pay the invoice with a different card?', scope: 'invoice', supported: true, operatorFlag: false },
      { text: 'Can we schedule the kickoff for next Tuesday?', scope: 'scheduling', supported: true, operatorFlag: false },
      { text: 'Please use these photos, menu, and service details on the website.', scope: 'brief', supported: true, operatorFlag: false },
      { text: 'Can you revise the homepage headline?', scope: 'revisions', supported: true, operatorFlag: false },
      { text: 'How much does the package cost after the first page?', scope: 'pricing', supported: true, operatorFlag: false },
      { text: 'What is the build progress and preview link?', scope: 'build progress', supported: true, operatorFlag: false },
      { text: 'Please unsubscribe me and stop emailing.', scope: 'opt-out', supported: true, operatorFlag: false },
      { text: 'Can you review this legal contract and sign our NDA?', scope: 'legal', supported: false, operatorFlag: true },
      { text: 'Can you guarantee first page Google rankings?', scope: 'guarantees', supported: false, operatorFlag: true },
      { text: 'Can you help with sales tax and a W-9?', scope: 'tax', supported: false, operatorFlag: true },
      { text: 'Can you wire money to this bank account?', scope: 'weird request', supported: false, operatorFlag: true }
    ];
    const failures = [];
    for (const item of cases) {
      const actual = classifyMessage(item.text);
      if (
        actual.scope !== item.scope ||
        actual.supported !== item.supported ||
        actual.operatorFlag !== item.operatorFlag
      ) {
        failures.push({ item, actual });
      }
    }
    assert(failures.length === 0, JSON.stringify(failures));
    return `${cases.length} cases`;
  });

  await check('agentmail.reply_idempotency_prevents_duplicate_auto_send', async () => {
    const leadId = insertLead(leads, containerTagFor, {
      id: stamp('agentmail_idem'),
      phone: phone('0218'),
      status: 'awaiting_payment',
      agentmail_thread_id: null
    });
    const threadId = `thread_${leadId}`;
    leads.update(leadId, { agentmail_thread_id: threadId });
    const payload = {
      id: `evt_${leadId}`,
      type: 'message.received',
      direction: 'inbound',
      threadId,
      messageId: `msg_${leadId}`,
      from: { email: 'owner@example.com' },
      subject: 'Invoice question',
      text: 'Can you add our Sunday hours to the website brief?',
      leadId
    };
    const eventId = `event:${payload.id}`;
    const first = await handleAgentMailInbound({ body: payload, eventId });
    const duplicate = await handleAgentMailInbound({ body: payload, eventId });
    const events = contactEvents.listByLead(leadId, { limit: 20 });
    const inbound = events.filter((event) => event.channel === 'agentmail' && event.direction === 'inbound');
    const outbound = events.filter((event) => event.channel === 'agentmail' && event.direction === 'outbound');
    assert(first.ignored === false, `first inbound was ignored: ${JSON.stringify(first)}`);
    assert(duplicate.duplicate === true, `duplicate inbound was not idempotent: ${JSON.stringify(duplicate)}`);
    assert(inbound.length === 1, `expected 1 inbound event, got ${inbound.length}`);
    assert(outbound.length === 1, `expected 1 outbound auto reply, got ${outbound.length}`);
    return { inbound: inbound.length, outbound: outbound.length, duplicate: duplicate.duplicate };
  });

  await check('payment_build.invoice_paid_starts_builder_once', () => {
    const leadId = insertLead(leads, containerTagFor, { id: stamp('paid_once'), phone: phone('0216'), status: 'awaiting_payment' });
    const invoiceId = `in_${leadId}`;
    payments.insert({
      id: `pay_${leadId}`,
      lead_id: leadId,
      stripe_session_id: invoiceId,
      stripe_invoice_id: invoiceId,
      stripe_customer_id: `cus_${leadId}`,
      payment_link_url: `https://invoice.stripe.test/${leadId}`,
      hosted_invoice_url: `https://invoice.stripe.test/${leadId}`,
      amount_cents: 50000,
      status: 'created',
      due_at: Date.now() + 86_400_000,
      idempotency_key: `invoice_${leadId}_50000`
    });

    const starts = [];
    const startBuilder = (args) => starts.push(args);
    const first = recordPaidPayment(invoiceId, null, { startBuilder });
    const duplicate = recordPaidPayment(invoiceId, leadId, { startBuilder });

    const eventId = `evt_${invoiceId}`;
    if (webhookEvents.recordOnce({ provider: 'stripe', event_id: eventId, type: 'invoice.paid', payload: { id: eventId } })) {
      recordPaidPayment(invoiceId, leadId, { startBuilder });
    }
    if (webhookEvents.recordOnce({ provider: 'stripe', event_id: eventId, type: 'invoice.paid', payload: { id: eventId } })) {
      recordPaidPayment(invoiceId, leadId, { startBuilder });
    }

    const payment = payments.getByInvoice(invoiceId);
    const buildRows = builds.listByLead(leadId);
    assert(first.builderTriggerClaimed === true, `first trigger not claimed: ${JSON.stringify(first)}`);
    assert(duplicate.builderTriggerClaimed === false, `duplicate trigger claimed: ${JSON.stringify(duplicate)}`);
    assert(starts.length === 1, `expected one builder start, got ${starts.length}`);
    assert(payment.status === 'paid', `payment status ${payment.status}`);
    assert(payment.build_triggered_at, 'payment build trigger timestamp missing');
    assert(buildRows.length === 1, `expected one build row, got ${buildRows.length}`);
    assert(buildRows[0].id === starts[0].buildId, 'start did not use reserved build id');
    builds.update(starts[0].buildId, { status: 'completed', finished_at: Date.now() });
    return { buildId: starts[0].buildId, triggerKey: starts[0].triggerKey };
  });

  await check('payment_build.recovers_crashed_builder_without_new_build', () => {
    const leadId = insertLead(leads, containerTagFor, { id: stamp('paid_recover'), phone: phone('0217'), status: 'awaiting_payment' });
    const invoiceId = `in_${leadId}`;
    payments.insert({
      id: `pay_${leadId}`,
      lead_id: leadId,
      stripe_session_id: invoiceId,
      stripe_invoice_id: invoiceId,
      stripe_customer_id: `cus_${leadId}`,
      payment_link_url: `https://invoice.stripe.test/${leadId}`,
      hosted_invoice_url: `https://invoice.stripe.test/${leadId}`,
      amount_cents: 50000,
      status: 'created',
      due_at: Date.now() + 86_400_000,
      idempotency_key: `invoice_${leadId}_50000`
    });

    const initialStarts = [];
    recordPaidPayment(invoiceId, null, { startBuilder: (args) => initialStarts.push(args) });
    assert(initialStarts.length === 1, `expected initial builder start, got ${initialStarts.length}`);
    const buildId = initialStarts[0].buildId;
    const claim = builds.claimStart({ id: buildId, lead_id: leadId });
    assert(claim.claimed, `builder claim failed: ${JSON.stringify(claim)}`);
    builds.update(buildId, { status: 'running', updated_at: Date.now() - 20_000 });

    const recoveredStarts = [];
    const recovered = recoverTriggeredPaymentBuilds({
      startBuilder: (args) => recoveredStarts.push(args),
      staleAfterMs: 1
    });
    const secondRecovery = recoverTriggeredPaymentBuilds({
      startBuilder: (args) => recoveredStarts.push(args),
      staleAfterMs: 60_000
    });
    const buildRows = builds.listByLead(leadId);
    assert(recoveredStarts.length === 1, `expected one recovery start, got ${recoveredStarts.length}`);
    assert(recoveredStarts[0].buildId === buildId, `recovery used different build ${recoveredStarts[0].buildId}`);
    assert(buildRows.length === 1, `expected one build row after recovery, got ${buildRows.length}`);
    assert(secondRecovery.length === 0, `fresh recovery lock rescheduled: ${JSON.stringify(secondRecovery)}`);
    return { buildId, recovered: recovered.length };
  });

  await check('compliance.callability_public_api', () => {
    resetComplianceEnv(env);
    const leadId = insertLead(leads, containerTagFor, { id: stamp('callable'), phone: phone('0215') });
    const lead = leads.get(leadId);
    const res = callabilityForLead({ lead, disclosureText: disclosure(recordingDisclosure, lead.business_name) });
    assert(res.ok && res.phoneClassification === 'business_landline', `unexpected callability ${JSON.stringify(res)}`);
    return res.phoneClassification;
  });
}

async function runRouteSmoke() {
  const port = await getOpenPort();
  const dataDir = mkdtempSync(join(tmpdir(), 'callan-routes-'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    PORT: String(port),
    RUN_MODE: 'mock',
    AUTONOMOUS_OUTREACH_ENABLED: 'false',
    LIVE_CALLS: 'false',
    LIVE_EMAILS: 'false',
    LIVE_PAYMENTS: 'false',
    LIVE_BUILDS: 'false',
    GEMINI_API_KEY: 'verification-gemini-key',
    SUPERMEMORY_API_KEY: 'verification-supermemory-key',
    AGENTPHONE_API_KEY: '',
    AGENTPHONE_WEBHOOK_SECRET: '',
    AGENTMAIL_API_KEY: '',
    AGENTMAIL_INBOX_ID: '',
    AGENTMAIL_WEBHOOK_SECRET: '',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    BROWSER_USE_API_KEY: '',
    MOSS_PROJECT_ID: '',
    MOSS_PROJECT_KEY: '',
    ALLOWED_TARGET_PHONES: ''
  };

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });
  child.stderr.on('data', (chunk) => { output = `${output}${chunk}`.slice(-4000); });

  try {
    const base = `http://127.0.0.1:${port}`;
    const health = await waitForJson(`${base}/api/health`, child);
    assert(health.ok === true, `health not ok: ${JSON.stringify(health)}`);
    assert(health.mode === 'mock', `expected mock mode, got ${health.mode}`);
    assert(health.readiness?.ready === true, `mock readiness should be true: ${JSON.stringify(health.liveBlockers)}`);

    const leadsRes = await fetchJson(`${base}/api/leads`);
    assert(Array.isArray(leadsRes.leads), 'GET /api/leads did not return a leads array');

    const status = await fetchJson(`${base}/api/outreach/status`);
    assert(status.running === false, `outreach should start stopped: ${JSON.stringify(status)}`);

    const started = await fetchJson(`${base}/api/outreach/start`, { method: 'POST' });
    assert(started.running === true, `outreach did not start: ${JSON.stringify(started)}`);

    const stopped = await fetchJson(`${base}/api/outreach/stop`, { method: 'POST' });
    assert(stopped.running === false, `outreach did not stop: ${JSON.stringify(stopped)}`);

    const missing = await fetch(`${base}/api/leads/verification-missing-lead`);
    assert(missing.status === 404, `expected missing lead 404, got ${missing.status}`);

    return {
      health: '/api/health',
      leads: '/api/leads',
      outreach: '/api/outreach/status start stop',
      missingLead: 404
    };
  } catch (err) {
    err.message = `${err.message}\nserver output:\n${output}`;
    throw err;
  } finally {
    await stopChild(child);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function waitForJson(url, child, timeoutMs = 8_000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      return await fetchJson(url);
    } catch (err) {
      lastErr = err;
      await delay(100);
    }
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr?.message || 'no response'}`);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(1_500)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${url} returned non-JSON status ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

async function getOpenPort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.on('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (port) resolvePort(port);
        else rejectPort(new Error('could not allocate port'));
      });
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(1_000).then(() => false)
  ]);
  if (exited === false && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolveExit) => child.once('exit', resolveExit));
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'callan-autonomy-'));
  configureIsolatedEnv(dataDir);

  try {
    const [
      envImport,
      dbImport,
      complianceImport,
      outreachImport,
      memoryImport,
      paymentFlowImport,
      analystImport,
      mailReplyImport,
      mailerImport
    ] = await Promise.all([
      import('../server/env.js'),
      import('../server/db.js'),
      import('../server/compliance.js'),
      import('../server/outreach.js'),
      import('../server/memory.js'),
      import('../server/paymentFlow.js'),
      import('../server/workers/analyst.js'),
      import('../server/workers/mailReply.js'),
      import('../server/workers/mailer.js')
    ]);
    dbModule = dbImport;

    await runCoreChecks({
      ...envImport,
      ...dbImport,
      ...complianceImport,
      ...outreachImport,
      ...memoryImport,
      ...paymentFlowImport,
      ...analystImport,
      ...mailReplyImport,
      ...mailerImport
    });

    await check('routes.smoke_health_leads_outreach', runRouteSmoke);
  } finally {
    if (dbModule?.db?.open) dbModule.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('\n=== AUTONOMY CHECK RESULTS ===\n');
  for (const r of results) {
    console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` - ${r.detail}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('autonomy-check crashed:', err);
  process.exit(2);
});
