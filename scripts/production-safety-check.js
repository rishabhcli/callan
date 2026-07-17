#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-production-safety-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  GEMINI_API_KEY: '',
  PORTAL_TOKEN_SECRET: 'production-safety-portal-secret-0123456789',
  SAFETY_INTERLOCK_SECRET: 'production-safety-interlock-secret-0123456789',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BROWSER_SESSIONS: 'false',
  LIVE_PUBLIC_OUTREACH: 'false',
  LIVE_BUILDS: 'false'
});

const results = [];
let db;

try {
  const { env } = await import('../server/env.js');
  const dbModule = await import('../server/db.js');
  const { assertMockProvenanceAllowed } = await import('../server/sse.js');
  const { startInboundCallerResearch } = await import('../server/inboundResearch.js');
  const { assertSafePublicHttpUrl, MockBrowserUseAdapter } = await import('../server/providers/browserUse.js');
  const { createMockAgentMailSendResult } = await import('../server/providers/agentmail.js');
  const { generateStructured } = await import('../server/reasoning/geminiReasoner.js');
  const { BusinessProfile } = await import('../server/reasoning/schemas.js');
  const { evaluateInvoiceGate } = await import('../server/paymentFlow.js');
  const { purgeExpiredSensitiveData } = await import('../server/dataLifecycle.js');
  db = dbModule.db;

  await check('mock provenance is rejected in every live mode', async () => {
    for (const mode of ['demo_live', 'autonomous_live', 'production_review', 'production_live']) {
      assert.throws(
        () => assertMockProvenanceAllowed('test.mock', { mock: true }, mode),
        (err) => err?.code === 'MOCK_PROVENANCE_VIOLATION'
      );
    }
    const previousMode = env.runMode;
    env.runMode = 'autonomous_live';
    try {
      assert.throws(() => createMockAgentMailSendResult(), (err) => err?.code === 'MOCK_PROVENANCE_VIOLATION');
      assert.throws(() => new MockBrowserUseAdapter(), (err) => err?.code === 'MOCK_PROVENANCE_VIOLATION');
    } finally {
      env.runMode = previousMode;
    }
  });

  await check('live inbound calls schedule no synthetic evidence', async () => {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    const previousMode = env.runMode;
    env.runMode = 'autonomous_live';
    try {
      startInboundCallerResearch({ callRow: { id: 'live-inbound-test', lead_id: null }, fromNumber: '+14155550199' });
    } finally {
      env.runMode = previousMode;
    }
    const after = db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
    assert.equal(after, before);
  });

  await check('Gemini cannot fall back to mock output outside mock mode', async () => {
    const previousMode = env.runMode;
    env.runMode = 'autonomous_live';
    try {
      await assert.rejects(
        generateStructured({
          kind: 'businessProfile',
          schema: BusinessProfile,
          evidence: { businessName: 'Safety Test' },
          prompt: 'Return a business profile.'
        }),
        /GEMINI_API_KEY is required/
      );
    } finally {
      env.runMode = previousMode;
    }
  });

  await check('invoice gate requires customer-controlled email confirmation', async () => {
    const lead = { id: 'invoice-safety', business_name: 'Invoice Safety' };
    const unconfirmed = evaluateInvoiceGate({
      lead,
      toEmail: 'owner@example.com',
      callRows: [{ transcript_json: JSON.stringify([{ role: 'user', text: 'Send the invoice to owner@example.com.' }]) }],
      contactRows: []
    });
    assert(unconfirmed.blockers.some((row) => row.code === 'missing_confirmed_customer_email'));
    const confirmed = evaluateInvoiceGate({
      lead,
      toEmail: 'owner@example.com',
      callRows: [{ transcript_json: JSON.stringify([
        { role: 'user', text: 'Send the invoice to owner@example.com.' },
        { role: 'assistant', text: 'I have owner@example.com. Is that correct?' },
        { role: 'user', text: 'Yes, that is correct.' }
      ]) }],
      contactRows: []
    });
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed.blockers));
  });

  await check('site inspection rejects SSRF destinations and DNS rebinding answers', async () => {
    const resolver = async () => [{ address: '169.254.169.254', family: 4 }];
    for (const value of ['http://127.0.0.1/', 'http://[::1]/', 'http://metadata.google.internal/', 'http://public.example/']) {
      await assert.rejects(assertSafePublicHttpUrl(value, { resolver }), /unsafe site inspection URL/);
    }
    const publicResult = await assertSafePublicHttpUrl('https://example.com/', {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }]
    });
    assert.equal(publicResult.addresses[0].address, '93.184.216.34');
  });

  await check('portal secrets are hashed at rest and sensitive OTP attempts are bounded', async () => {
    dbModule.leads.insert({
      id: 'portal-safety',
      container_tag: 'lead:portal-safety',
      business_name: 'Portal Safety',
      phone: '+14155550100',
      address: '1 Safety Way',
      niche: 'testing',
      city: 'Oakland',
      website: null,
      status: 'discovered'
    });
    const issued = dbModule.portalTokens.ensureActive({ lead_id: 'portal-safety' });
    const stored = db.prepare(`SELECT * FROM portal_tokens WHERE id = ?`).get(issued.row.id);
    assert.notEqual(stored.token, issued.token);
    assert.match(stored.token, /^sha256:/);
    assert.equal(stored.token_hash.length, 64);
    assert.equal(dbModule.portalTokens.resolve(issued.token).ok, true);
    dbModule.portalTokens.beginSensitiveVerification({ id: issued.row.id, code: '123456' });
    for (let i = 0; i < 5; i += 1) dbModule.portalTokens.confirmSensitiveVerification({ id: issued.row.id, code: '000000' });
    assert.equal(dbModule.portalTokens.confirmSensitiveVerification({ id: issued.row.id, code: '123456' }).reason, 'verification_attempts_exhausted');
  });

  await check('durable job fencing rejects an expired worker generation', async () => {
    dbModule.durableJobs.enqueue({ id: 'fencing-test', type: 'test.fencing', now: 1_000, runAt: 1_000 });
    const first = dbModule.durableJobs.claimNext({ workerId: 'worker-a', leaseMs: 1_000, now: 1_000, types: ['test.fencing'] });
    assert.equal(first.lease_generation, 1);
    dbModule.durableJobs.recoverExpiredLeases({ now: 2_001 });
    const second = dbModule.durableJobs.claimNext({ workerId: 'worker-b', leaseMs: 10_000, now: 2_001, types: ['test.fencing'] });
    assert.equal(second.lease_generation, 2);
    dbModule.durableJobs.complete(first.id, { result: { stale: true }, workerId: first.locked_by, leaseGeneration: first.lease_generation, now: 2_002 });
    const afterStale = dbModule.durableJobs.get(first.id);
    assert.equal(afterStale.status, 'running');
    assert.equal(afterStale.locked_by, 'worker-b');
    assert(dbModule.durableJobs.renewLease(first.id, { workerId: 'worker-b', leaseGeneration: 2, leaseMs: 10_000, now: 2_002 }));
  });

  await check('safe-to-sell snapshots are signed and tamper evident', async () => {
    const snapshot = dbModule.safeToSellReports.record({
      version: 2,
      ok: true,
      mode: 'production_live',
      generatedAt: new Date().toISOString(),
      stillBlocked: []
    });
    assert.equal(dbModule.safeToSellReports.verify(snapshot.id), true);
    db.prepare(`UPDATE safe_to_sell_reports SET report_json = ? WHERE id = ?`).run('{"ok":false,"tampered":true}', snapshot.id);
    assert.equal(dbModule.safeToSellReports.verify(snapshot.id), false);
  });

  await check('retention scheduler redacts expired transcript payloads', async () => {
    dbModule.calls.start({ id: 'old-call', lead_id: 'portal-safety', provider_call_id: 'old-provider', to_phone: '+14155550100' });
    dbModule.calls.finish('old-call', { outcome: 'completed', transcript: [{ role: 'user', text: 'sensitive transcript' }] });
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    db.prepare(`UPDATE calls SET started_at = ?, ended_at = ? WHERE id = 'old-call'`).run(old, old);
    const result = purgeExpiredSensitiveData({ now: Date.now() });
    assert(result.changed.callTranscripts >= 1);
    assert.equal(dbModule.calls.get('old-call').transcript_json, null);
  });

  console.log(JSON.stringify({ ok: true, name: 'production-safety-check', checks: results }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, name: 'production-safety-check', checks: results, error: err?.stack || err?.message || String(err) }, null, 2));
  process.exitCode = 1;
} finally {
  try { db?.close?.(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
}

async function check(name, fn) {
  const startedAt = Date.now();
  await fn();
  results.push({ name, ok: true, durationMs: Date.now() - startedAt });
}
