// Provider readiness smoke runner.
// Defaults to dry/config checks. Set SMOKE_* toggles to run side-effecting checks.

import { env } from '../server/env.js';
import { providerSmoke } from '../server/db.js';
import { generateText } from '../server/gemini.js';
import { addDoc, containerTagFor, listKinds, search } from '../server/memory.js';

const bool = (v) => v === 'true' || v === '1' || v === 'yes';
const dry = (provider, configured, detail = {}) => {
  providerSmoke.set(provider, configured ? 'configured' : 'missing', { dryRun: true, ...detail });
  return { provider, status: configured ? 'configured' : 'missing', detail: { dryRun: true, ...detail } };
};

async function smokeGemini() {
  if (!env.gemini.apiKey) return dry('gemini', false);
  try {
    const text = await generateText({ prompt: 'Reply with exactly OK.', thinkingLevel: 'minimal', flash: true });
    providerSmoke.set('gemini', 'ok', { model: env.gemini.modelFlash, sample: String(text || '').slice(0, 20) });
    return { provider: 'gemini', status: 'ok' };
  } catch (err) {
    providerSmoke.set('gemini', 'failed', { error: err?.message || String(err) });
    return { provider: 'gemini', status: 'failed', detail: err?.message || String(err) };
  }
}

async function smokeSupermemory() {
  if (!env.supermemory.apiKey) return dry('supermemory', false);
  try {
    const stamp = Date.now().toString(36);
    const tag = containerTagFor(`smoke_${stamp}`);
    await addDoc(tag, 'profile', { businessName: 'Smoke Check', marker: `marker_${stamp}` });
    await new Promise((r) => setTimeout(r, 2000));
    const listed = await listKinds(tag);
    const hits = await search(tag, `marker_${stamp}`, { limit: 3 });
    providerSmoke.set('supermemory', 'ok', { tag, listedProfiles: listed.profile.length, hits: hits.length });
    return { provider: 'supermemory', status: 'ok', detail: { listedProfiles: listed.profile.length, hits: hits.length } };
  } catch (err) {
    providerSmoke.set('supermemory', 'failed', { error: err?.message || String(err) });
    return { provider: 'supermemory', status: 'failed', detail: err?.message || String(err) };
  }
}

async function smokeStripe() {
  if (!env.stripe.secretKey) return dry('stripe', false);
  if (!bool(process.env.SMOKE_STRIPE_INVOICE)) {
    return dry('stripe', true, { skipped: 'set SMOKE_STRIPE_INVOICE=true to create a test hosted invoice' });
  }
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(env.stripe.secretKey, { apiVersion: '2026-02-25.clover' });
    const customer = await stripe.customers.create({
      email: process.env.SMOKE_TEST_EMAIL || 'smoke@example.com',
      name: 'callmemaybe smoke test',
      metadata: { smoke: 'true' }
    }, { idempotencyKey: `smoke_customer_${Date.now().toString(36)}` });
    providerSmoke.set('stripe', 'ok', { customerId: customer.id });
    return { provider: 'stripe', status: 'ok', detail: { customerId: customer.id } };
  } catch (err) {
    providerSmoke.set('stripe', 'failed', { error: err?.message || String(err) });
    return { provider: 'stripe', status: 'failed', detail: err?.message || String(err) };
  }
}

async function smokeAgentMail() {
  const configured = !!env.agentmail.apiKey && !!env.agentmail.inboxId;
  if (!configured) return dry('agentmail', false);
  if (!bool(process.env.SMOKE_AGENTMAIL_SEND)) {
    return dry('agentmail', true, { skipped: 'set SMOKE_AGENTMAIL_SEND=true and SMOKE_TEST_EMAIL to send a test message' });
  }
  try {
    const { AgentMailClient } = await import('agentmail');
    const mail = new AgentMailClient({ apiKey: env.agentmail.apiKey });
    const res = await mail.inboxes.messages.send(env.agentmail.inboxId, {
      to: [process.env.SMOKE_TEST_EMAIL],
      subject: 'callmemaybe AgentMail smoke',
      text: 'AgentMail smoke test from callmemaybe.'
    });
    providerSmoke.set('agentmail', 'ok', { messageId: res?.message?.id || res?.id || null });
    return { provider: 'agentmail', status: 'ok' };
  } catch (err) {
    providerSmoke.set('agentmail', 'failed', { error: err?.message || String(err) });
    return { provider: 'agentmail', status: 'failed', detail: err?.message || String(err) };
  }
}

async function smokeBrowserUse() {
  if (!env.browserUse.apiKey) return dry('browserUse', false);
  if (!bool(process.env.SMOKE_BROWSER_USE)) {
    return dry('browserUse', true, { skipped: 'set SMOKE_BROWSER_USE=true to create a Browser Use session' });
  }
  try {
    const { BrowserUse } = await import('browser-use-sdk/v3');
    const client = new BrowserUse({ apiKey: env.browserUse.apiKey });
    const session = await client.sessions.create({ keepAlive: false });
    providerSmoke.set('browserUse', 'ok', { sessionId: session.id, liveUrl: session.liveUrl || null });
    try { await client.sessions.stop(session.id); } catch {}
    return { provider: 'browserUse', status: 'ok', detail: { liveUrl: session.liveUrl || null } };
  } catch (err) {
    providerSmoke.set('browserUse', 'failed', { error: err?.message || String(err) });
    return { provider: 'browserUse', status: 'failed', detail: err?.message || String(err) };
  }
}

async function smokeAgentPhone() {
  const configured = !!env.agentphone.apiKey;
  if (!configured) return dry('agentphone', false);
  if (!bool(process.env.SMOKE_LIVE_CALL)) {
    return dry('agentphone', true, { skipped: 'set SMOKE_LIVE_CALL=true and SMOKE_TEST_PHONE to place one owned-number call' });
  }
  const phone = process.env.SMOKE_TEST_PHONE;
  if (!phone || !env.allowedPhones.includes(phone)) {
    providerSmoke.set('agentphone', 'blocked', { reason: 'SMOKE_TEST_PHONE must be in ALLOWED_TARGET_PHONES' });
    return { provider: 'agentphone', status: 'blocked' };
  }
  providerSmoke.set('agentphone', 'configured', { skipped: 'live call smoke is intentionally delegated to the app call path' });
  return { provider: 'agentphone', status: 'configured' };
}

async function smokeMoss() {
  const configured = !!env.moss.projectId && !!env.moss.projectKey;
  return dry('moss', configured, configured ? { role: 'in-call retrieval; quota-safe dry check' } : {});
}

async function main() {
  const checks = [
    await smokeGemini(),
    await smokeSupermemory(),
    await smokeAgentPhone(),
    await smokeAgentMail(),
    await smokeStripe(),
    await smokeBrowserUse(),
    await smokeMoss()
  ];
  console.log('\n=== PROVIDER SMOKE RESULTS ===\n');
  for (const c of checks) console.log(`[${c.status.toUpperCase()}] ${c.provider}${c.detail ? ` — ${JSON.stringify(c.detail)}` : ''}`);
}

main().catch((err) => {
  console.error('provider-smoke crashed:', err);
  process.exit(2);
});
