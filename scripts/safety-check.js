#!/usr/bin/env node

// Deterministic local safety verification. This script never calls providers.

import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-safety-'));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const results = [];
const startedAt = Date.now();
let dbHandle = null;

try {
  const [
    { env, RUN_MODES, SIDE_EFFECTS, sideEffectMatrix },
    { complianceGateReport, recordingDisclosure },
    { verifyAgentPhone },
    { liveReadiness },
    dbModule
  ] = await Promise.all([
    import('../server/env.js'),
    import('../server/compliance.js'),
    import('../server/webhooks/agentphone.js'),
    import('../server/readiness.js'),
    import('../server/db.js')
  ]);
  dbHandle = dbModule.db;

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
    const required = ['dnc', 'opt_out', 'quiet_hours', 'max_attempts', 'business_phone_classification', 'recording_ai_disclosure', 'invoice_consent', 'unsubscribe'];
    const missing = required.filter((name) => !names.has(name));
    assert(missing.length === 0, `missing gates: ${missing.join(', ')}`);
    return required.join(', ');
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
