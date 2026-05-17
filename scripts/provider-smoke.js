// Provider readiness smoke runner.
// Defaults to dry/config checks. Set SMOKE_* toggles to run side-effecting checks.

import { env } from '../server/env.js';
import { providerSmoke } from '../server/db.js';
import { smokeDetail } from '../server/providers/core.js';
import { smokeGeminiGenerate } from '../server/providers/gemini.js';
import { smokeMossIndex } from '../server/providers/moss.js';
import { smokeSupermemoryAddListSearch } from '../server/providers/supermemory.js';
import { createStripeSmokeInvoice } from '../server/providers/stripe.js';
import { agentPhoneOwnedNumberSmoke } from '../server/providers/agentphone.js';
import { runAgentMailLiveSendSmoke } from '../server/providers/agentmail.js';
import { BrowserUseLovableAdapter } from '../server/providers/browserUse.js';
import { smokeV0 } from '../server/providers/v0.js';

const dry = (provider, configured, detail = {}) => {
  const status = configured ? 'configured' : 'missing';
  const fullDetail = smokeDetail({ dryRun: true, extra: detail });
  providerSmoke.set(provider, status, fullDetail);
  return { provider, status, detail: fullDetail };
};

const liveResult = (provider, status, detail = {}) => {
  const fullDetail = smokeDetail({ dryRun: false, live: true, extra: detail });
  providerSmoke.set(provider, status, fullDetail);
  return { provider, status, detail: fullDetail };
};

const failed = (provider, err) => {
  const detail = smokeDetail({ dryRun: false, extra: { error: err?.message || String(err) } });
  providerSmoke.set(provider, 'failed', detail);
  return { provider, status: 'failed', detail };
};

async function smokeGemini() {
  return adapterSmoke('gemini', smokeGeminiGenerate);
}

async function smokeSupermemory() {
  return adapterSmoke('supermemory', smokeSupermemoryAddListSearch);
}

async function smokeStripe() {
  if (!env.stripe.secretKey) return dry('stripe', false);
  if (!env.smoke.stripeInvoice) {
    return dry('stripe', true, { skipped: 'set SMOKE_STRIPE_INVOICE=true to create a test hosted invoice' });
  }
  try {
    const invoice = await createStripeSmokeInvoice();
    return liveResult('stripe', 'ok', {
      customerId: invoice.customerId,
      invoiceId: invoice.id,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      customerReused: invoice.customerReused
    });
  } catch (err) {
    return failed('stripe', err);
  }
}

async function smokeAgentMail() {
  const configured = !!env.agentmail.apiKey && !!env.agentmail.inboxId;
  if (!configured) return dry('agentmail', false);
  if (!env.smoke.agentmailSend) {
    return dry('agentmail', true, { skipped: 'set SMOKE_AGENTMAIL_SEND=true and SMOKE_TEST_EMAIL to send a test message' });
  }
  try {
    const result = await runAgentMailLiveSendSmoke();
    if (result.status !== 'ok') return dry('agentmail', true, result);
    return liveResult('agentmail', 'ok', result);
  } catch (err) {
    return failed('agentmail', err);
  }
}

async function smokeBrowserUse() {
  if (!env.browserUse.apiKey) return dry('browserUse', false);
  if (!env.smoke.browserUse) {
    return dry('browserUse', true, { skipped: 'set SMOKE_BROWSER_USE=true to create a Browser Use session' });
  }
  try {
    const adapter = new BrowserUseLovableAdapter({
      apiKey: env.browserUse.apiKey,
      baseUrl: env.browserUse.baseUrl
    });
    const session = await adapter.createSession({ keepAlive: false });
    try { await adapter.stopSession(session.sessionId); } catch {}
    return liveResult('browserUse', 'ok', { sessionId: session.sessionId, liveUrl: session.liveUrl || null });
  } catch (err) {
    return failed('browserUse', err);
  }
}

async function smokeLovable() {
  if (!env.browserUse.apiKey) return dry('lovable', false, { dependency: 'browserUse' });
  return dry('lovable', true, {
    dependency: 'browserUse',
    skipped: 'Lovable build-with-URL is verified through Browser Use sessions; set SMOKE_BROWSER_USE=true to create a session and exercise the handoff',
    buildWithUrl: 'https://lovable.dev/?prompt=<encoded>',
    projectUrlExtraction: '.lovable.app'
  });
}

async function smokeV0Provider() {
  try {
    const result = await smokeV0();
    providerSmoke.set('v0', result.status, result.detail || {});
    return { provider: 'v0', status: result.status, detail: result.detail };
  } catch (err) {
    return failed('v0', err);
  }
}

async function smokeAgentPhone() {
  const configured = !!env.agentphone.apiKey;
  if (!configured) return dry('agentphone', false);
  if (!env.smoke.liveCall) {
    return dry('agentphone', true, { skipped: 'set SMOKE_LIVE_CALL=true and SMOKE_TEST_PHONE to place one owned-number call' });
  }
  try {
    const result = await agentPhoneOwnedNumberSmoke({ phone: env.smoke.testPhone });
    if (result.status !== 'ok') {
      providerSmoke.set('agentphone', result.status, result.detail || {});
      return { provider: 'agentphone', status: result.status, detail: result.detail };
    }
    return liveResult('agentphone', 'ok', result.detail || result);
  } catch (err) {
    return failed('agentphone', err);
  }
}

async function smokeMoss() {
  return adapterSmoke('moss', smokeMossIndex);
}

async function adapterSmoke(provider, fn) {
  try {
    const result = await fn();
    providerSmoke.set(provider, result.status, result.detail || {});
    return { provider, status: result.status, detail: result.detail };
  } catch (err) {
    return failed(provider, err);
  }
}

async function main() {
  const checks = [
    await smokeGemini(),
    await smokeSupermemory(),
    await smokeAgentPhone(),
    await smokeAgentMail(),
    await smokeStripe(),
    await smokeBrowserUse(),
    await smokeLovable(),
    await smokeV0Provider(),
    await smokeMoss()
  ];
  console.log('\n=== PROVIDER SMOKE RESULTS ===\n');
  for (const c of checks) console.log(`[${c.status.toUpperCase()}] ${c.provider}${c.detail ? ` — ${JSON.stringify(c.detail)}` : ''}`);
}

main().catch((err) => {
  console.error('provider-smoke crashed:', err);
  process.exit(2);
});
