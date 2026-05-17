import {
  env,
  isProductionAcked,
  isValidRunMode,
  modePolicy,
  RUN_MODES,
  sideEffectMatrix
} from './env.js';
import { callAttempts, contactEvents, doNotCall, leads, providerSmoke } from './db.js';
import { complianceGateReport } from './compliance.js';
import { fulfillmentReadiness } from './fulfillment/targets.js';
import { v0ReadinessDetails } from './providers/v0.js';

const PROVIDER_ORDER = ['gemini', 'supermemory', 'moss', 'agentphone', 'browserUse', 'lovable', 'v0', 'agentmail', 'stripe'];
const LIVE_PROVIDER_MODES = new Set(['demo_live', 'autonomous_live', 'production_review', 'production_live']);
const PRODUCTION_REQUIRED_PROVIDERS = new Set(PROVIDER_ORDER.filter((name) => name !== 'v0'));
const REQUIRED_WEBHOOK_MODES = new Set(['demo_live', 'autonomous_live', 'production_review', 'production_live']);
const PRODUCTION_LIVE_ACK_VALUE = 'I_UNDERSTAND_LIVE_OUTREACH';

export const PROVIDER_DOCS = Object.freeze({
  agentphone: 'https://docs.agentphone.ai/documentation/guides/webhooks',
  agentphoneFaq: 'https://docs.agentphone.ai/documentation/reference/faq',
  agentmail: 'https://docs.agentmail.to/events',
  agentmailOverview: 'https://docs.agentmail.to/overview',
  stripeInvoices: 'https://docs.stripe.com/invoicing/integration',
  browserUseSessions: 'https://docs.browser-use.com/guides/sessions',
  browserUseStatus: 'https://docs.browser-use.com/cloud/api-v2/tasks/get-task-status',
  lovableBuildWithUrl: 'https://lovable-f9060f1e.mintlify.app/integrations/build-with-url',
  v0Platform: 'https://v0.app/docs/api/platform/overview',
  v0Deployments: 'https://v0.app/docs/api/platform/reference/deployments/create',
  supermemoryContainers: 'https://docs.supermemory.ai/memory-api/features/filtering',
  mossIndex: 'https://docs.moss.dev/docs/reference/js/classes/MossClient',
  geminiStructuredOutput: 'https://ai.google.dev/gemini-api/docs/structured-output'
});

export function liveReadiness() {
  const mode = env.runMode;
  const smoke = providerSmoke.all();
  const sideEffects = sideEffectMatrix(mode);
  const webhooks = webhookReadiness(mode);
  const providers = providerReadiness({ mode, smoke, webhooks });
  const compliance = complianceGateReport({ mode });
  const blockers = currentModeBlockers({ mode, providers, webhooks, sideEffects, compliance });
  const productionBlockers = productionLiveBlockers({ providers, webhooks, sideEffects, compliance });
  const nextActions = nextActionsFor([...blockers, ...productionBlockers]);

  return {
    mode,
    validModes: RUN_MODES,
    modePolicy: modePolicy(mode),
    autonomous: mode === 'autonomous_live' && env.outreach.enabled,
    ready: blockers.length === 0,
    canGoLive: productionBlockers.length === 0,
    blockers,
    productionBlockers,
    nextActions,
    providers,
    webhooks,
    fulfillment: fulfillmentReadiness(),
    sideEffects,
    compliance,
    smoke,
    smokeToggles: {
      gemini: env.smoke.gemini,
      supermemoryWrite: env.smoke.supermemoryWrite,
      mossIndex: env.smoke.mossIndex,
      liveCall: env.smoke.liveCall,
      agentmailSend: env.smoke.agentmailSend,
      stripeInvoice: env.smoke.stripeInvoice,
      browserUse: env.smoke.browserUse
    },
    outreach: outreachSummary(),
    quotas: quotaAndCostSummary(),
    docs: PROVIDER_DOCS,
    productionAck: {
      configured: isProductionAcked(),
      env: 'PRODUCTION_LIVE_ACK',
      expected: PRODUCTION_LIVE_ACK_VALUE
    }
  };
}

function providerReadiness({ mode, smoke, webhooks }) {
  return Object.fromEntries(PROVIDER_ORDER.map((name) => {
    const configured = providerConfigured(name);
    const required = requiredProvider(name, mode);
    const smokeRow = smoke[name] || null;
    const smokeStatus = smokeRow?.status || 'not_run';
    const lastError = smokeRow?.detail?.error || smokeRow?.detail?.lastError || null;
    const webhook = webhookForProvider(name, webhooks);
    const blockerReasons = [];

    if (required && !configured.ok) blockerReasons.push(`${name} provider missing ${configured.missing.join(', ')}`);
    if (webhook?.required && !webhook.configured) blockerReasons.push(`${name} webhook missing: ${webhook.blockerReasons.join('; ')}`);
    if (['failed', 'blocked'].includes(smokeStatus)) blockerReasons.push(`${name} smoke ${smokeStatus}${lastError ? `: ${lastError}` : ''}`);
    if (mode === 'production_live' && required && smokeStatus !== 'ok') blockerReasons.push(`${name} smoke has not passed`);

    return [name, {
      configured: configured.ok,
      missing: configured.missing,
      required,
      status: configured.ok ? 'configured' : 'missing',
      webhookConfigured: webhook ? webhook.configured : null,
      smoke: smokeRow ? {
        status: smokeRow.status,
        checkedAt: smokeRow.checkedAt,
        dryRun: smokeRow.detail?.dryRun !== false,
        live: !!smokeRow.detail?.live
      } : {
        status: 'not_run',
        checkedAt: null,
        dryRun: true,
        live: false
      },
      smokeStatus,
      lastError,
      quotaCostStatus: quotaCostStatus(name, smokeRow),
      blockerReasons,
      nextAction: nextProviderAction({ name, configured, required, webhook, smokeStatus, blockerReasons }),
      detail: providerDetail(name)
    }];
  }));
}

function providerConfigured(name) {
  if (name === 'gemini') return requiredEnv({ GEMINI_API_KEY: env.gemini.apiKey });
  if (name === 'supermemory') return requiredEnv({ SUPERMEMORY_API_KEY: env.supermemory.apiKey });
  if (name === 'moss') return requiredEnv({ MOSS_PROJECT_ID: env.moss.projectId, MOSS_PROJECT_KEY: env.moss.projectKey });
  if (name === 'agentphone') return requiredEnv({ AGENTPHONE_API_KEY: env.agentphone.apiKey });
  if (name === 'browserUse') return requiredEnv({ BROWSER_USE_API_KEY: env.browserUse.apiKey });
  if (name === 'lovable') return requiredEnv({ BROWSER_USE_API_KEY: env.browserUse.apiKey });
  if (name === 'v0') return requiredEnv({ V0_API_KEY: process.env.V0_API_KEY });
  if (name === 'agentmail') return requiredEnv({ AGENTMAIL_API_KEY: env.agentmail.apiKey, AGENTMAIL_INBOX_ID: env.agentmail.inboxId });
  if (name === 'stripe') return requiredEnv({ STRIPE_SECRET_KEY: env.stripe.secretKey });
  return { ok: false, missing: ['unknown_provider'] };
}

function requiredEnv(required) {
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  return { ok: missing.length === 0, missing };
}

function requiredProvider(name, mode = env.runMode) {
  if (mode === 'mock') return false;
  if (mode === 'production_live' || mode === 'production_review') return PRODUCTION_REQUIRED_PROVIDERS.has(name);
  if (mode === 'demo_live' || mode === 'autonomous_live') return LIVE_PROVIDER_MODES.has(mode) && PRODUCTION_REQUIRED_PROVIDERS.has(name);
  return false;
}

function webhookReadiness(mode = env.runMode) {
  const required = REQUIRED_WEBHOOK_MODES.has(mode);
  const httpsPublicUrl = isHttpsPublicUrl(env.publicUrl);
  return {
    agentphone: webhookRow({
      provider: 'agentphone',
      required,
      configured: !!env.agentphone.webhookSecret,
      endpoint: `${env.publicUrl.replace(/\/$/, '')}/api/webhooks/agentphone`,
      verifier: 'HMAC-SHA256 over X-Webhook-Timestamp.rawBody',
      replayWindowSeconds: 300,
      idempotency: 'X-Webhook-ID stored in webhook_events',
      blockerReasons: [
        !env.agentphone.webhookSecret ? 'AGENTPHONE_WEBHOOK_SECRET missing' : null,
        mode === 'production_live' && !httpsPublicUrl ? 'APP_PUBLIC_URL must be public https for AgentPhone webhooks' : null
      ]
    }),
    agentmail: webhookRow({
      provider: 'agentmail',
      required,
      configured: !!env.agentmail.webhookSecret,
      endpoint: `${env.publicUrl.replace(/\/$/, '')}/api/webhooks/agentmail`,
      verifier: 'Svix signature headers',
      idempotency: 'event_id/svix-id stored in webhook_events',
      hydration: 'message.received payloads are hydrated through AgentMail API if text/html is partial',
      blockerReasons: [
        !env.agentmail.webhookSecret ? 'AGENTMAIL_WEBHOOK_SECRET missing' : null,
        mode === 'production_live' && !httpsPublicUrl ? 'APP_PUBLIC_URL must be public https for AgentMail webhooks' : null
      ]
    }),
    stripe: webhookRow({
      provider: 'stripe',
      required,
      configured: !!env.stripe.webhookSecret,
      endpoint: `${env.publicUrl.replace(/\/$/, '')}/api/webhooks/stripe`,
      verifier: 'Stripe-Signature via stripe.webhooks.constructEvent',
      idempotency: 'Stripe event.id stored in webhook_events before fulfillment',
      lifecycle: 'invoice.paid and invoice.payment_succeeded mark paid; checkout.session.completed is retained for compatibility',
      blockerReasons: [
        !env.stripe.webhookSecret ? 'STRIPE_WEBHOOK_SECRET missing' : null,
        mode === 'production_live' && !httpsPublicUrl ? 'APP_PUBLIC_URL must be public https for Stripe webhooks' : null
      ]
    })
  };
}

function webhookRow(row) {
  const blockerReasons = row.blockerReasons.filter(Boolean);
  return {
    ...row,
    blockerReasons,
    configured: Boolean(row.configured && blockerReasons.length === 0),
    status: row.configured && blockerReasons.length === 0 ? 'configured' : row.required ? 'blocked' : 'not_required',
    nextAction: blockerReasons[0] || 'monitor webhook deliveries'
  };
}

function webhookForProvider(name, webhooks) {
  if (name === 'agentphone') return webhooks.agentphone;
  if (name === 'agentmail') return webhooks.agentmail;
  if (name === 'stripe') return webhooks.stripe;
  return null;
}

function providerDetail(name) {
  if (name === 'gemini') {
    return {
      models: { pro: env.gemini.modelPro, flash: env.gemini.modelFlash },
      structuredOutput: 'responseMimeType application/json with responseJsonSchema and local schema validation',
      docs: PROVIDER_DOCS.geminiStructuredOutput,
      sideEffects: { generateContent: env.smoke.gemini ? 'enabled_by_SMOKE_GEMINI' : 'disabled_by_default' }
    };
  }
  if (name === 'supermemory') {
    return {
      isolation: 'containerTags scoped per lead',
      supportedKinds: ['profile', 'pitch', 'call_log', 'post_mortem', 'mail_thread'],
      docs: PROVIDER_DOCS.supermemoryContainers,
      sideEffects: { addListSearchSmoke: env.smoke.supermemoryWrite ? 'enabled_by_SMOKE_SUPERMEMORY_WRITE' : 'disabled_by_default' }
    };
  }
  if (name === 'moss') {
    return {
      role: 'low_latency_in_call_hot_index',
      readiness: 'per-lead index ready; retrieval events visible at /api/leads/:id/moss',
      docs: PROVIDER_DOCS.mossIndex,
      retrieval: { topK: 3, alpha: 0.82, noWebSearch: true },
      sideEffects: { indexSmoke: env.smoke.mossIndex ? 'enabled_by_SMOKE_MOSS_INDEX' : 'disabled_by_default' }
    };
  }
  if (name === 'agentphone') {
    return {
      agentId: env.agentphone.agentId ? 'configured' : 'create_or_reuse',
      fromNumber: env.agentphone.fromNumber ? 'configured' : 'missing',
      transcript: 'call_ended webhook, final transcript endpoint, and transcript SSE stream',
      docs: [PROVIDER_DOCS.agentphone, PROVIDER_DOCS.agentphoneFaq],
      ownedNumberSmoke: env.smoke.liveCall ? 'enabled_by_SMOKE_LIVE_CALL' : 'disabled_by_default'
    };
  }
  if (name === 'browserUse') {
    return {
      mode: 'cloud_agent_session',
      status: 'sessions expose status/liveUrl; tasks expose status/cost',
      docs: [PROVIDER_DOCS.browserUseSessions, PROVIDER_DOCS.browserUseStatus],
      sideEffects: { sessionSmoke: env.smoke.browserUse ? 'enabled_by_SMOKE_BROWSER_USE' : 'disabled_by_default' }
    };
  }
  if (name === 'lovable') {
    return {
      role: 'website_generation_target',
      execution: 'Browser Use cloud session',
      buildWithUrl: 'https://lovable.dev/?autosubmit=true#prompt=<encoded>',
      authWall: 'blocked_auth_event',
      projectUrlExtraction: '.lovable.app',
      docs: PROVIDER_DOCS.lovableBuildWithUrl,
      sideEffects: { submissionSmoke: env.smoke.browserUse ? 'covered_by_SMOKE_BROWSER_USE' : 'disabled_by_default' }
    };
  }
  if (name === 'v0') {
    return {
      role: 'optional_website_generation_target',
      docs: [PROVIDER_DOCS.v0Platform, PROVIDER_DOCS.v0Deployments],
      ...v0ReadinessDetails()
    };
  }
  if (name === 'agentmail') {
    return {
      inboxId: env.agentmail.inboxId ? 'configured' : 'missing',
      events: 'event_id based idempotency; partial message payloads hydrate through API',
      docs: [PROVIDER_DOCS.agentmail, PROVIDER_DOCS.agentmailOverview],
      sideEffects: { sendSmoke: env.smoke.agentmailSend ? 'enabled_by_SMOKE_AGENTMAIL_SEND' : 'disabled_by_default' }
    };
  }
  if (name === 'stripe') {
    return {
      invoiceMode: 'hosted_invoice_primary',
      lifecycle: 'listen to invoice.paid; invoice.payment_succeeded and checkout.session.completed supported',
      docs: PROVIDER_DOCS.stripeInvoices,
      keyMode: stripeKeyMode(env.stripe.secretKey),
      sideEffects: { invoiceSmoke: env.smoke.stripeInvoice ? 'enabled_by_SMOKE_STRIPE_INVOICE' : 'disabled_by_default' }
    };
  }
  return {};
}

function quotaCostStatus(name, smokeRow) {
  const detail = smokeRow?.detail || {};
  if (name === 'browserUse') {
    const cost = detail.totalCostUsd || detail.cost || detail.maxCostUsd;
    return cost ? `last known Browser Use cost ${cost}` : 'cost not observed; set BROWSER_USE_MAX_COST_USD for live sessions';
  }
  if (name === 'stripe') return `keyMode=${stripeKeyMode(env.stripe.secretKey)} priceCents=${env.stripe.priceCents}`;
  if (name === 'moss') return env.smoke.mossIndex ? 'smoke may create/query/delete one temporary index' : 'no Moss index side effects without SMOKE_MOSS_INDEX';
  if (name === 'agentphone') return `callsToday=${callAttempts.todayCount()}`;
  if (name === 'agentmail') return `repliesWaiting=${contactEvents.repliesWaiting()}`;
  if (name === 'v0') return process.env.V0_API_KEY ? 'v0 key configured; live builds gated by LIVE_BUILDS' : 'v0 optional target missing V0_API_KEY';
  return detail.quota || detail.usage || 'not reported';
}

function currentModeBlockers({ mode, providers, webhooks, sideEffects, compliance }) {
  const blockers = [];
  if (!isValidRunMode(mode)) blockers.push(`invalid RUN_MODE: ${mode}; expected one of ${RUN_MODES.join(', ')}`);

  if (mode === 'demo_live') {
    if (env.live.calls && env.allowedPhones.length === 0) blockers.push('demo_live with LIVE_CALLS requires ALLOWED_TARGET_PHONES');
    if ((env.live.emails || env.live.payments) && env.allowedEmails.length === 0) blockers.push('demo_live email/invoice path requires ALLOWED_TARGET_EMAILS');
  }
  if (mode === 'autonomous_live' && !env.outreach.enabled) blockers.push('autonomous_live requires AUTONOMOUS_OUTREACH_ENABLED=true');
  if (mode === 'production_review') {
    for (const [action, row] of Object.entries(sideEffects)) {
      if (row.flagEnabled) blockers.push(`production_review must keep ${row.label} disabled`);
    }
  }
  if (mode === 'production_live') {
    blockers.push(...productionLiveBlockers({ providers, webhooks, sideEffects, compliance }));
  }

  for (const [name, row] of Object.entries(providers)) {
    if (row.required) blockers.push(...row.blockerReasons);
  }
  for (const row of Object.values(webhooks)) {
    if (row.required && !row.configured) blockers.push(...row.blockerReasons);
  }
  for (const gate of compliance.gates || []) {
    if (!gate.ok) blockers.push(`compliance gate ${gate.name} failed: ${gate.detail}`);
  }

  return unique(blockers);
}

function productionLiveBlockers({ providers, webhooks, sideEffects, compliance }) {
  const blockers = [];
  if (env.runMode !== 'production_live') blockers.push('RUN_MODE is not production_live');
  if (!isProductionAcked()) blockers.push(`PRODUCTION_LIVE_ACK must equal ${PRODUCTION_LIVE_ACK_VALUE}`);
  if (env.nodeEnv !== 'production') blockers.push('NODE_ENV must be production for production_live');
  if (!isHttpsPublicUrl(env.publicUrl)) blockers.push('APP_PUBLIC_URL must be a public https URL for production webhooks');
  if (!env.outreach.enabled) blockers.push('AUTONOMOUS_OUTREACH_ENABLED must be true for production_live');

  for (const [name, row] of Object.entries(providers || {})) {
    if (!PRODUCTION_REQUIRED_PROVIDERS.has(name)) continue;
    if (!row.configured) blockers.push(`${name} provider is not configured`);
    if (row.smokeStatus !== 'ok') blockers.push(`${name} smoke has not passed`);
    if (row.lastError) blockers.push(`${name} last error: ${row.lastError}`);
  }
  for (const [name, row] of Object.entries(webhooks || {})) {
    if (!row.configured) blockers.push(`${name} webhook is not configured`);
  }
  for (const [action, row] of Object.entries(sideEffects || {})) {
    if (!row.allowed) blockers.push(`${row.label} are not enabled for production_live`);
    for (const reason of row.blockers || []) blockers.push(reason);
  }
  for (const gate of compliance?.gates || []) {
    if (!gate.ok) blockers.push(`compliance gate ${gate.name} failed: ${gate.detail}`);
  }
  if (stripeKeyMode(env.stripe.secretKey) === 'secret_live') blockers.push('STRIPE_SECRET_KEY is sk_live_; use a restricted rk_live_ key for production');
  return unique(blockers);
}

function outreachSummary() {
  return {
    ...leads.outreachSummary(),
    todaysCalls: callAttempts.todayCount(),
    optOuts: doNotCall.count(),
    repliesWaiting: contactEvents.repliesWaiting(),
    intervalMs: env.outreach.intervalMs,
    batchSize: env.outreach.batchSize,
    publicOutreachEnabled: env.outreach.enabled
  };
}

function quotaAndCostSummary() {
  return {
    outreachDailyAttempts: callAttempts.todayCount(),
    maxAttemptsPerPhone: env.outreach.maxAttemptsPerPhone,
    mossIndexPolicy: env.smoke.mossIndex ? 'smoke_can_create_delete_or_reuse' : 'no_index_side_effects_without_SMOKE_MOSS_INDEX',
    browserUseSessionPolicy: env.smoke.browserUse ? 'smoke_can_create_session' : 'no_session_side_effects_without_SMOKE_BROWSER_USE',
    browserUseMaxCostUsd: process.env.BROWSER_USE_MAX_COST_USD || null,
    stripeInvoicePolicy: env.smoke.stripeInvoice ? 'smoke_can_create_test_invoice' : 'no_invoice_side_effects_without_SMOKE_STRIPE_INVOICE',
    stripeKeyMode: stripeKeyMode(env.stripe.secretKey)
  };
}

function nextProviderAction({ name, configured, required, webhook, smokeStatus, blockerReasons }) {
  if (blockerReasons.length) return blockerReasons[0];
  if (required && !configured.ok) return `set ${configured.missing.join(', ')}`;
  if (webhook?.required && !webhook.configured) return webhook.nextAction;
  if (smokeStatus === 'not_run') return `run ${name} smoke when credentials are ready`;
  if (smokeStatus === 'ok') return 'monitor';
  return `investigate ${name} smoke status ${smokeStatus}`;
}

function nextActionsFor(blockers) {
  return unique(blockers).slice(0, 12).map((blocker) => {
    if (/RUN_MODE/.test(blocker)) return 'set RUN_MODE=production_live only after review blockers are gone';
    if (/PRODUCTION_LIVE_ACK/.test(blocker)) return `set PRODUCTION_LIVE_ACK=${PRODUCTION_LIVE_ACK_VALUE} when intentionally launching`;
    if (/APP_PUBLIC_URL/.test(blocker)) return 'set APP_PUBLIC_URL to the deployed https origin and register webhooks';
    if (/WEBHOOK_SECRET|webhook/.test(blocker)) return 'configure provider webhook secret and endpoint';
    if (/smoke has not passed/.test(blocker)) return 'run one provider smoke at a time with SMOKE_* toggles';
    if (/LIVE_/.test(blocker) || /not enabled/.test(blocker)) return 'enable the specific LIVE_* flag only for the side effect being launched';
    if (/provider/.test(blocker) || /not configured/.test(blocker)) return 'set missing provider credentials';
    if (/compliance/.test(blocker)) return 'fix the named compliance gate before resuming outreach';
    return blocker;
  });
}

function isHttpsPublicUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function stripeKeyMode(key) {
  if (!key) return 'missing';
  if (/^rk_test_/.test(key)) return 'restricted_test';
  if (/^sk_test_/.test(key)) return 'secret_test';
  if (/^rk_live_/.test(key)) return 'restricted_live';
  if (/^sk_live_/.test(key)) return 'secret_live';
  return 'unknown';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
