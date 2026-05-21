#!/usr/bin/env node

// Deterministic local safety verification. This script never calls providers.

import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-safety-'));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  NODE_ENV: process.env.NODE_ENV || 'test',
  RUN_MODE: process.env.RUN_MODE || 'autonomous_live',
  AUTONOMOUS_OUTREACH_ENABLED: process.env.AUTONOMOUS_OUTREACH_ENABLED || 'true',
  MAX_ATTEMPTS_PER_PHONE: process.env.MAX_ATTEMPTS_PER_PHONE || '1',
  QUIET_HOURS_START: process.env.QUIET_HOURS_START || '20',
  QUIET_HOURS_END: process.env.QUIET_HOURS_END || '9',
  OUTREACH_TIMEZONE: process.env.OUTREACH_TIMEZONE || 'America/Los_Angeles'
});

const results = [];
const startedAt = Date.now();
let dbHandle = null;

try {
  const [
    { env, RUN_MODES, SIDE_EFFECTS, sideEffectMatrix },
    { REASON_CODES, callabilityForLead, gateOutboundCall, complianceGateReport, markLeadConsentApproved, recordOptOut, recordingDisclosure },
    { classifyMessage },
    { canDialPhone, recordProviderFlag },
    { customerTrustSummaryForLead },
    { verifyAgentPhone },
    { liveReadiness },
    dbModule
  ] = await Promise.all([
    import('../server/env.js'),
    import('../server/compliance.js'),
    import('../server/workers/mailReply.js'),
    import('../server/reputation.js'),
    import('../server/trust.js'),
    import('../server/webhooks/agentphone.js'),
    import('../server/readiness.js'),
    import('../server/db.js')
  ]);
  dbHandle = dbModule.db;

  const insertLead = (patch = {}) => {
    const id = patch.id || `safety_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    return dbModule.leads.insert({
      id,
      container_tag: patch.container_tag || id,
      business_name: patch.business_name || 'Safety Fixture',
      phone: patch.phone || '+14155551010',
      address: patch.address || '1 Market St, San Francisco, CA',
      niche: patch.niche || 'fixture',
      city: patch.city || 'San Francisco',
      website: patch.website || null,
      status: patch.status || 'discovered',
      research_status: patch.research_status || 'complete',
      outreach_status: patch.outreach_status || 'queued',
      risk_status: patch.risk_status || 'needs_callability_check',
      consent_status: patch.consent_status || 'public_business',
      phone_classification: patch.phone_classification || 'business_landline',
      next_action: patch.next_action || 'call',
      source_url: patch.source_url ?? `https://example.test/${id}`,
      research_json: patch.research_json || null,
      agentmail_thread_id: patch.agentmail_thread_id || null
    }).lead;
  };

  await check('mode_system.enumerates_required_modes', () => {
    const expected = ['mock', 'demo_live', 'autonomous_live', 'production_review', 'production_live'];
    assert(expected.every((mode) => RUN_MODES.includes(mode)), `missing mode from ${RUN_MODES.join(',')}`);
    return RUN_MODES.join(', ');
  });

  await check('side_effect_matrix.refuses_mock_and_review', () => {
    const originalMode = env.runMode;
    const originalLive = { ...env.live };
    const originalOutreach = env.outreach.enabled;
    Object.assign(env.live, {
      calls: true,
      emails: true,
      payments: true,
      invoices: true,
      browserSessions: true,
      publicOutreach: true,
      builds: true
    });
    env.outreach.enabled = true;
    const mock = sideEffectMatrix('mock');
    const review = sideEffectMatrix('production_review');
    env.runMode = originalMode;
    Object.assign(env.live, originalLive);
    env.outreach.enabled = originalOutreach;
    const unsafe = [...SIDE_EFFECTS].filter((action) => mock[action].allowed || review[action].allowed);
    assert(unsafe.length === 0, `unexpected allowed side effects: ${unsafe.join(', ')}`);
    return 'mock and production_review block calls, emails, invoices, browser sessions, public outreach, and builds';
  });

  await check('compliance.disclosure_contains_recording_and_opt_out', () => {
    const line = recordingDisclosure('Tony Barbershop');
    assert(/record(?:ed|ing)/i.test(line), 'recording disclosure missing');
    assert(/opt out|stop|remove/i.test(line), 'opt-out language missing');
    return line;
  });

  await check('compliance.gate_report_covers_required_controls', () => {
    const report = complianceGateReport({ mode: 'production_live' });
    const names = new Set(report.gates.map((gate) => gate.name));
    const required = ['dnc', 'opt_out', 'quiet_hours', 'max_attempts', 'business_phone_classification', 'recording_ai_disclosure', 'invoice_consent', 'unsubscribe', 'source_provenance_response', 'trust_ledger'];
    const missing = required.filter((name) => !names.has(name));
    assert(missing.length === 0, `missing gates: ${missing.join(', ')}`);
    return required.join(', ');
  });

  await check('compliance.dnc_blocks_before_call', () => {
    const phone = '+14155552001';
    const lead = insertLead({ id: 'safety_dnc', business_name: 'DNC Safety', phone });
    recordOptOut(phone, { source: 'safety-check', reason: 'customer_requested_stop', leadId: lead.id });
    const decision = callabilityForLead({
      lead,
      disclosureText: recordingDisclosure(lead.business_name),
      now: new Date('2026-01-15T20:00:00Z'),
      mode: 'autonomous_live'
    });
    assert(!decision.allowed, 'DNC lead was callable');
    assert(decision.reasonCodes.includes(REASON_CODES.DNC_OPT_OUT), JSON.stringify(decision.reasonCodes));
    return decision.reasonCodes.join(', ');
  });

  await check('compliance.quiet_hours_block_before_call', () => {
    const lead = insertLead({ id: 'safety_quiet', business_name: 'Quiet Hours Safety', phone: '+14155552002' });
    const decision = callabilityForLead({
      lead,
      disclosureText: recordingDisclosure(lead.business_name),
      now: new Date('2026-01-16T05:30:00Z'),
      mode: 'autonomous_live'
    });
    assert(!decision.allowed, 'quiet-hours lead was callable');
    assert(decision.reasonCodes.includes(REASON_CODES.OUTSIDE_CALLING_HOURS), JSON.stringify(decision.reasonCodes));
    return decision.reasonCodes.join(', ');
  });

  await check('compliance.mobile_and_unknown_risk_block_autonomous', () => {
    const mobile = callabilityForLead({
      lead: { id: 'safety_mobile', business_name: 'Mobile Safety', phone: '+14155552003' },
      profile: { phoneType: 'mobile', sourceUrl: 'https://example.test/mobile' },
      disclosureText: recordingDisclosure('Mobile Safety'),
      now: new Date('2026-01-15T20:00:00Z'),
      mode: 'autonomous_live'
    });
    const unknown = callabilityForLead({
      lead: { id: 'safety_unknown', phone: '+14155552004', phone_classification: 'unknown' },
      disclosureText: recordingDisclosure('Unknown Safety'),
      now: new Date('2026-01-15T20:00:00Z'),
      mode: 'autonomous_live'
    });
    assert(mobile.reasonCodes.includes(REASON_CODES.PHONE_MOBILE_RISK), `mobile not blocked: ${JSON.stringify(mobile.reasonCodes)}`);
    assert(unknown.reasonCodes.includes(REASON_CODES.PHONE_UNKNOWN_RISK), `unknown not blocked: ${JSON.stringify(unknown.reasonCodes)}`);
    return `mobile=${mobile.reasonCodes.join(', ')}; unknown=${unknown.reasonCodes.join(', ')}`;
  });

  await check('compliance.repeated_attempts_throttle', () => {
    const lead = insertLead({ id: 'safety_attempts', business_name: 'Attempt Safety', phone: '+14155552005' });
    const first = gateOutboundCall({
      lead,
      disclosureText: recordingDisclosure(lead.business_name),
      now: new Date('2026-01-15T20:00:00Z'),
      mode: 'autonomous_live'
    });
    const second = callabilityForLead({
      lead,
      disclosureText: recordingDisclosure(lead.business_name),
      now: new Date('2026-01-15T20:05:00Z'),
      mode: 'autonomous_live'
    });
    assert(first.allowed && first.decisionId, `first call was not persisted allowed: ${JSON.stringify(first)}`);
    assert(second.reasonCodes.includes(REASON_CODES.MAX_ATTEMPTS_PHONE), `phone throttle missing: ${JSON.stringify(second.reasonCodes)}`);
    assert(second.reasonCodes.includes(REASON_CODES.MAX_ATTEMPTS_BUSINESS), `business throttle missing: ${JSON.stringify(second.reasonCodes)}`);
    return second.reasonCodes.join(', ');
  });

  await check('trust.ledger_persists_call_and_opt_out_receipts', () => {
    const phone = '+14155552006';
    const lead = insertLead({ id: 'safety_trust', business_name: 'Trust Safety', phone, source_url: 'https://example.test/trust' });
    const first = gateOutboundCall({
      lead,
      disclosureText: recordingDisclosure(lead.business_name),
      now: new Date('2026-01-15T20:00:00Z'),
      mode: 'autonomous_live'
    });
    const portal = dbModule.portalTokens.ensureActive({ lead_id: lead.id, metadata: { source: 'safety-check' } });
    dbModule.portalTokens.resolve(portal.token);
    markLeadConsentApproved(lead.id, { reason: 'safety_email_invite', proof: 'safety-message-id', excerpt: 'Yes, call me tomorrow.' });
    recordOptOut(phone, { source: 'portal', reason: 'customer_portal_opt_out', leadId: lead.id });
    const events = dbModule.trustLedger.listByLead(lead.id);
    const types = new Set(events.map((event) => event.event_type));
    const customerTrust = customerTrustSummaryForLead(lead.id);
    assert(first.decisionId, 'call decision did not return an id');
    assert(types.has('call_decision'), `missing call_decision in ${[...types].join(', ')}`);
    assert(types.has('consent_status'), `missing consent_status in ${[...types].join(', ')}`);
    assert(types.has('portal_token_event'), `missing portal_token_event in ${[...types].join(', ')}`);
    assert(types.has('opt_out'), `missing opt_out in ${[...types].join(', ')}`);
    assert(customerTrust?.whyAmISeeingThis, 'customer trust explanation missing');
    assert(customerTrust?.optOutStatus?.optedOut, 'customer trust opt-out status missing');
    assert(/stop|opt/i.test(customerTrust?.howToStop || ''), 'customer stop-contact copy missing');
    return [...types].join(', ');
  });

  await check('agentmail.unsubscribe_policy_records_stop_intent', () => {
    const decision = classifyMessage({
      subject: 'Please unsubscribe',
      text: 'Please unsubscribe me and do not contact us again.'
    });
    assert(decision.kind === 'opt_out', `expected opt_out, got ${decision.kind}`);
    assert(decision.replyMode === 'opt_out_confirmation', `unexpected reply mode: ${decision.replyMode}`);
    return `${decision.kind}/${decision.replyMode}`;
  });

  await check('reputation.provider_complaint_blocks_dialing', async () => {
    const phone = '+14155552007';
    const lead = insertLead({ id: 'safety_complaint', business_name: 'Complaint Safety', phone });
    recordProviderFlag({
      provider: 'agentmail',
      kind: 'complaint',
      leadId: lead.id,
      phone,
      severity: 'alert',
      reason: 'safety customer complaint'
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const gate = canDialPhone(phone);
    const trustEvents = dbModule.trustLedger.listByLead(lead.id);
    assert(!gate.ok, `complaint did not block dialing: ${JSON.stringify(gate)}`);
    assert(/provider_complaint_pause/.test(gate.reason || ''), `unexpected gate reason: ${gate.reason}`);
    assert(trustEvents.some((event) => event.event_type === 'provider_complaint'), `provider complaint missing from trust ledger: ${trustEvents.map((event) => event.event_type).join(', ')}`);
    return `${gate.reason}; trust=${trustEvents.map((event) => event.event_type).join(', ')}`;
  });

  await check('readiness.provider_complaint_surfaces_reputation_blocker', () => {
    const readiness = liveReadiness();
    const blockers = [...(readiness.blockers || []), ...(readiness.productionBlockers || [])];
    assert(blockers.some((line) => /reputation gate provider_complaint failed/i.test(line)), blockers.join('; '));
    assert(readiness.reputation?.gates?.some((gate) => gate.name === 'provider_complaint' && gate.ok === false), 'provider_complaint gate not failed');
    return readiness.reputation.blockers.join('; ');
  });

  await check('webhook.agentphone_accepts_valid_hmac', () => {
    env.agentphone.webhookSecret = 'safety-agentphone-secret';
    const ts = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from(JSON.stringify({ event: 'agent.call_ended', callId: 'call_safety' }));
    const sig = crypto.createHmac('sha256', env.agentphone.webhookSecret).update(`${ts}.${body.toString('utf8')}`).digest('hex');
    const result = verifyAgentPhone({
      headers: {
        'x-webhook-signature': `sha256=${sig}`,
        'x-webhook-timestamp': ts,
        'x-webhook-id': 'wh_safety_valid'
      }
    }, body);
    assert(result.ok, result.reason || 'valid signature rejected');
    return `replayWindowSeconds=${result.replayWindowSeconds}`;
  });

  await check('webhook.agentphone_rejects_replay_and_missing_id', () => {
    env.agentphone.webhookSecret = 'safety-agentphone-secret';
    const oldTs = String(Math.floor((Date.now() - 10 * 60 * 1000) / 1000));
    const body = Buffer.from(JSON.stringify({ event: 'agent.call_ended', callId: 'call_safety' }));
    const oldSig = crypto.createHmac('sha256', env.agentphone.webhookSecret).update(`${oldTs}.${body.toString('utf8')}`).digest('hex');
    const replay = verifyAgentPhone({
      headers: {
        'x-webhook-signature': `sha256=${oldSig}`,
        'x-webhook-timestamp': oldTs,
        'x-webhook-id': 'wh_safety_old'
      }
    }, body);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', env.agentphone.webhookSecret).update(`${ts}.${body.toString('utf8')}`).digest('hex');
    const missingId = verifyAgentPhone({
      headers: {
        'x-webhook-signature': `sha256=${sig}`,
        'x-webhook-timestamp': ts
      }
    }, body);
    assert(!replay.ok && /replay/.test(replay.reason), `replay not rejected: ${JSON.stringify(replay)}`);
    assert(!missingId.ok && /Webhook-ID/.test(missingId.reason), `missing id not rejected: ${JSON.stringify(missingId)}`);
    return `${replay.reason}; ${missingId.reason}`;
  });

  await check('idempotency.webhook_events_record_once', () => {
    const first = dbModule.webhookEvents.recordOnce({ provider: 'agentphone', event_id: 'wh_safety_once', type: 'agent.call_ended', payload: { id: 1 } });
    const second = dbModule.webhookEvents.recordOnce({ provider: 'agentphone', event_id: 'wh_safety_once', type: 'agent.call_ended', payload: { id: 2 } });
    const count = dbModule.db.prepare(`SELECT COUNT(*) AS n FROM webhook_events WHERE provider = ? AND event_id = ?`).get('agentphone', 'wh_safety_once').n;
    assert(first === true, 'first insert was not recorded');
    assert(second === false, 'duplicate insert was not ignored');
    assert(count === 1, `expected one row, got ${count}`);
    return 'duplicate webhook delivery ignored';
  });

  await check('stripe.key_posture', () => {
    const key = env.stripe.secretKey;
    if (!key) return 'not set; production readiness will list Stripe as blocked';
    if (/^sk_live_/.test(key)) throw new Error('sk_live_ is not allowed; use a restricted key and production review first');
    if (/^rk_live_/.test(key) && env.runMode !== 'production_live') throw new Error('rk_live_ is only allowed in intentional production_live posture');
    if (/^sk_test_/.test(key)) return 'sk_test_ detected; safe for tests, restricted test key preferred';
    if (/^rk_test_/.test(key)) return 'restricted test key';
    return `unknown key prefix (${key.slice(0, 7)}...)`;
  });

  await check('readiness.production_live_fails_closed', () => {
    const readiness = liveReadiness();
    if (env.runMode === 'production_live') {
      assert(readiness.ready, `production_live blocked: ${readiness.blockers.join('; ')}`);
    }
    assert(Array.isArray(readiness.productionBlockers), 'productionBlockers missing');
    return env.runMode === 'production_live'
      ? 'production_live ready'
      : `${readiness.productionBlockers.length} production blockers surfaced`;
  });

  const summary = summarize();
  const payload = {
    ok: summary.failed === 0,
    name: 'safety-check',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    dataDir,
    summary,
    results
  };
  console.log(JSON.stringify(payload, null, 2));
  printHuman(summary);
  process.exitCode = payload.ok ? 0 : 1;
} catch (err) {
  console.error('safety-check crashed:', err?.stack || err?.message || String(err));
  process.exitCode = 2;
} finally {
  try { dbHandle?.close?.(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: formatDetail(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.message || String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formatDetail(detail) {
  if (detail === undefined || detail === null) return '';
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
}

function summarize() {
  const failed = results.filter((row) => !row.ok).length;
  return {
    total: results.length,
    passed: results.length - failed,
    failed
  };
}

function printHuman(summary) {
  console.log('\n=== SAFETY CHECK RESULTS ===');
  for (const row of results) {
    console.log(`[${row.ok ? 'PASS' : 'FAIL'}] ${row.name}${row.detail ? ` - ${row.detail}` : ''}`);
  }
  console.log(`[${summary.failed ? 'FAIL' : 'PASS'}] ${summary.passed}/${summary.total} checks passed`);
}
