// Provider readiness smoke runner.
// Defaults to dry/config checks. Set SMOKE_* toggles to run side-effecting checks.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from '../server/env.js';
import { providerSmoke } from '../server/db.js';
import { redact } from '../server/logger.js';
import { smokeDetail } from '../server/providers/core.js';
import { smokeGeminiGenerate } from '../server/providers/gemini.js';
import { smokeMossIndex } from '../server/providers/moss.js';
import { smokeSupermemoryAddListSearch } from '../server/providers/supermemory.js';
import { createStripeSmokeInvoice } from '../server/providers/stripe.js';
import { agentPhoneOwnedNumberSmoke } from '../server/providers/agentphone.js';
import { runAgentMailLiveSendSmoke } from '../server/providers/agentmail.js';
import { BrowserUseLovableAdapter } from '../server/providers/browserUse.js';
import { smokeV0 } from '../server/providers/v0.js';

const PROVIDER_CHECKS = Object.freeze({
  gemini: smokeGemini,
  supermemory: smokeSupermemory,
  agentphone: smokeAgentPhone,
  agentmail: smokeAgentMail,
  stripe: smokeStripe,
  browserUse: smokeBrowserUse,
  lovable: smokeLovable,
  v0: smokeV0Provider,
  moss: smokeMoss
});

const dry = (provider, configured, detail = {}, timing = {}) => {
  const status = configured ? 'configured' : 'missing';
  const fullDetail = withDuration(smokeDetail({ dryRun: true, extra: detail }), timing);
  providerSmoke.set(provider, status, fullDetail, { durationMs: fullDetail.durationMs });
  return smokeResult(provider, status, fullDetail);
};

const liveResult = (provider, status, detail = {}, timing = {}) => {
  const fullDetail = withDuration(smokeDetail({ dryRun: false, live: true, extra: detail }), timing);
  providerSmoke.set(provider, status, fullDetail, { durationMs: fullDetail.durationMs, error: fullDetail.error || fullDetail.lastError });
  return smokeResult(provider, status, fullDetail);
};

const failed = (provider, err, timing = {}, { live = false } = {}) => {
  const error = err?.message || String(err);
  const detail = withDuration(smokeDetail({ dryRun: false, live, extra: { error } }), timing);
  providerSmoke.set(provider, 'failed', detail, { durationMs: detail.durationMs, error });
  return smokeResult(provider, 'failed', detail);
};

function withDuration(detail = {}, timing = {}) {
  if (timing.durationMs === undefined || timing.durationMs === null) return detail;
  return { ...detail, durationMs: Math.max(0, Math.round(Number(timing.durationMs) || 0)) };
}

function elapsed(startedAt) {
  return { durationMs: Date.now() - startedAt };
}

function smokeResult(provider, status, detail = {}) {
  return {
    provider,
    status,
    detail: redact(detail)
  };
}

export function formatProviderSmokeResult(result = {}) {
  const safe = redact(result);
  const status = String(safe.status || 'unknown').toUpperCase();
  const provider = safe.provider || 'unknown';
  return `[${status}] ${provider}${safe.detail ? ` — ${JSON.stringify(safe.detail)}` : ''}`;
}

export function providerSmokeExitCode(results = []) {
  return (results || []).some((result) => (
    result?.detail?.live === true
    && !['ok'].includes(String(result.status || '').toLowerCase())
  )) ? 1 : 0;
}

function formatProviderSmokeCrash(err) {
  return redact(err?.message || String(err));
}

function isMainModule() {
  return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

async function smokeGemini() {
  return adapterSmoke('gemini', smokeGeminiGenerate);
}

async function smokeSupermemory() {
  return adapterSmoke('supermemory', smokeSupermemoryAddListSearch);
}

async function smokeStripe() {
  const startedAt = Date.now();
  if (!env.stripe.secretKey) return dry('stripe', false, {}, elapsed(startedAt));
  if (!env.smoke.stripeInvoice) {
    return dry('stripe', true, { skipped: 'set SMOKE_STRIPE_INVOICE=true to create a test hosted invoice' }, elapsed(startedAt));
  }
  try {
    const invoice = await createStripeSmokeInvoice();
    return liveResult('stripe', 'ok', {
      customerId: invoice.customerId,
      invoiceId: invoice.id,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      customerReused: invoice.customerReused
    }, elapsed(startedAt));
  } catch (err) {
    return failed('stripe', err, elapsed(startedAt), { live: true });
  }
}

async function smokeAgentMail() {
  const startedAt = Date.now();
  const configured = !!env.agentmail.apiKey && !!env.agentmail.inboxId;
  if (!configured) return dry('agentmail', false, {}, elapsed(startedAt));
  if (!env.smoke.agentmailSend) {
    return dry('agentmail', true, { skipped: 'set SMOKE_AGENTMAIL_SEND=true and SMOKE_TEST_EMAIL to send a test message' }, elapsed(startedAt));
  }
  try {
    const result = await runAgentMailLiveSendSmoke();
    if (result.status !== 'ok') return dry('agentmail', true, result, elapsed(startedAt));
    return liveResult('agentmail', 'ok', result, elapsed(startedAt));
  } catch (err) {
    return failed('agentmail', err, elapsed(startedAt), { live: true });
  }
}

async function smokeBrowserUse() {
  const startedAt = Date.now();
  if (!env.browserUse.apiKey) return dry('browserUse', false, {}, elapsed(startedAt));
  if (!env.smoke.browserUse) {
    return dry('browserUse', true, { skipped: 'set SMOKE_BROWSER_USE=true to create a Browser Use session' }, elapsed(startedAt));
  }
  try {
    const adapter = new BrowserUseLovableAdapter({
      apiKey: env.browserUse.apiKey,
      baseUrl: env.browserUse.baseUrl
    });
    const session = await adapter.createSession({ keepAlive: false });
    try { await adapter.stopSession(session.sessionId); } catch {}
    return liveResult('browserUse', 'ok', { sessionId: session.sessionId, liveUrl: session.liveUrl || null }, elapsed(startedAt));
  } catch (err) {
    return failed('browserUse', err, elapsed(startedAt), { live: true });
  }
}

async function smokeLovable() {
  const startedAt = Date.now();
  if (!env.browserUse.apiKey) return dry('lovable', false, { dependency: 'browserUse' }, elapsed(startedAt));
  if (!env.smoke.lovableNavigation) {
    return dry('lovable', true, {
      dependency: 'browserUse',
      skipped: 'set SMOKE_LOVABLE_NAVIGATION=true to open Lovable through Browser Use without creating a project',
      buildWithUrl: 'https://lovable.dev/?prompt=<encoded>',
      projectUrlExtraction: '.lovable.app'
    }, elapsed(startedAt));
  }
  const adapter = new BrowserUseLovableAdapter({
    apiKey: env.browserUse.apiKey,
    baseUrl: env.browserUse.baseUrl
  });
  let session = null;
  const events = [];
  try {
    session = await adapter.createSession({ keepAlive: false });
    for await (const event of adapter.smokeLovableNavigation({ sessionId: session.sessionId })) {
      events.push(event);
      if (event.kind === 'blocked_auth') {
        return liveResult('lovable', 'blocked', {
          sessionId: session.sessionId,
          liveUrl: session.liveUrl || null,
          blockedAuth: true,
          reason: event.reason || 'lovable_auth_required',
          events: summarizeEvents(events)
        }, elapsed(startedAt));
      }
    }
    return liveResult('lovable', 'ok', {
      sessionId: session.sessionId,
      liveUrl: session.liveUrl || null,
      navigation: 'ok',
      events: summarizeEvents(events)
    }, elapsed(startedAt));
  } catch (err) {
    return failed('lovable', err, elapsed(startedAt), { live: true });
  } finally {
    try { await adapter.stopSession(session?.sessionId); } catch {}
  }
}

async function smokeV0Provider() {
  return adapterSmoke('v0', smokeV0);
}

async function smokeAgentPhone() {
  const startedAt = Date.now();
  const configured = !!env.agentphone.apiKey;
  if (!configured) return dry('agentphone', false, {}, elapsed(startedAt));
  if (!env.smoke.liveCall) {
    return dry('agentphone', true, { skipped: 'set SMOKE_LIVE_CALL=true and SMOKE_TEST_PHONE to place one owned-number call' }, elapsed(startedAt));
  }
  try {
    const result = await agentPhoneOwnedNumberSmoke({ phone: env.smoke.testPhone });
    if (result.status !== 'ok') {
      const detail = withDuration(result.detail || {}, elapsed(startedAt));
      providerSmoke.set('agentphone', result.status, detail, { durationMs: detail.durationMs, error: detail.error || detail.lastError });
      return smokeResult('agentphone', result.status, detail);
    }
    return liveResult('agentphone', 'ok', result.detail || result, elapsed(startedAt));
  } catch (err) {
    return failed('agentphone', err, elapsed(startedAt), { live: true });
  }
}

async function smokeMoss() {
  return adapterSmoke('moss', smokeMossIndex);
}

async function adapterSmoke(provider, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const detail = withDuration(result.detail || {}, elapsed(startedAt));
    providerSmoke.set(provider, result.status, detail, { durationMs: detail.durationMs, error: detail.error || detail.lastError });
    return smokeResult(provider, result.status, detail);
  } catch (err) {
    return failed(provider, err, elapsed(startedAt), { live: liveSmokeEnabled(provider) });
  }
}

function liveSmokeEnabled(provider) {
  if (provider === 'gemini') return env.smoke.gemini;
  if (provider === 'supermemory') return env.smoke.supermemoryWrite;
  if (provider === 'moss') return env.smoke.mossIndex;
  if (provider === 'agentphone') return env.smoke.liveCall;
  if (provider === 'agentmail') return env.smoke.agentmailSend;
  if (provider === 'stripe') return env.smoke.stripeInvoice;
  if (provider === 'browserUse') return env.smoke.browserUse;
  if (provider === 'lovable') return env.smoke.lovableNavigation;
  return false;
}

function summarizeEvents(events = []) {
  return events.slice(-8).map((event) => ({
    kind: event.kind || null,
    phase: event.phase || null,
    summary: event.summary || null,
    reason: event.reason || null
  }));
}

function selectedProviderNames(argv = process.argv.slice(2)) {
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') {
      console.log(Object.keys(PROVIDER_CHECKS).join('\n'));
      process.exit(0);
    }
    if (arg === '--provider' || arg === '-p') {
      names.push(...String(argv[i + 1] || '').split(','));
      i += 1;
      continue;
    }
    if (arg.startsWith('--provider=')) names.push(...arg.slice('--provider='.length).split(','));
  }
  const clean = names.map((name) => name.trim()).filter(Boolean);
  if (!clean.length) return Object.keys(PROVIDER_CHECKS);
  const unknown = clean.filter((name) => !PROVIDER_CHECKS[name]);
  if (unknown.length) {
    throw new Error(`Unknown provider(s): ${unknown.join(', ')}. Expected one of ${Object.keys(PROVIDER_CHECKS).join(', ')}`);
  }
  return [...new Set(clean)];
}

async function main() {
  const checks = [];
  for (const provider of selectedProviderNames()) {
    checks.push(await PROVIDER_CHECKS[provider]());
  }
  console.log('\n=== PROVIDER SMOKE RESULTS ===\n');
  for (const c of checks) console.log(formatProviderSmokeResult(c));
  process.exitCode = providerSmokeExitCode(checks);
}

if (isMainModule()) {
  main().catch((err) => {
    console.error('provider-smoke crashed:', formatProviderSmokeCrash(err));
    process.exit(2);
  });
}
