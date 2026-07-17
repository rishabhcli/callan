import {
  env,
  isProductionAcked,
  isValidRunMode,
  modePolicy,
  RUN_MODES,
  sideEffectMatrix
} from './env.js';
import { callAttempts, contactEvents, doNotCall, leads, providerSmoke, durableJobs, webhookEvents, memoryFailures, memoryWriteQueue } from './db.js';
import { complianceGateReport } from './compliance.js';
import { fulfillmentReadiness } from './fulfillment/targets.js';
import { v0ReadinessDetails } from './providers/v0.js';
import { reputationReadinessReport } from './reputation.js';
import { adminAuthPosture } from './adminAuth.js';
import { providerRuntimeIncident } from './providerIncidents.js';
import { operationalErrorSummary } from './operationalErrors.js';
import { existsSync, readFileSync } from 'node:fs';

export const PROVIDER_ORDER = ['gemini', 'supermemory', 'moss', 'agentphone', 'browserUse', 'lovable', 'v0', 'agentmail', 'stripe'];
const LIVE_PROVIDER_MODES = new Set(['demo_live', 'autonomous_live', 'production_review', 'production_live']);
export const PRODUCTION_REQUIRED_PROVIDERS = new Set(PROVIDER_ORDER.filter((name) => name !== 'v0'));
const REQUIRED_WEBHOOK_MODES = new Set(['demo_live', 'autonomous_live', 'production_review', 'production_live']);
const PRODUCTION_LIVE_ACK_VALUE = 'I_UNDERSTAND_LIVE_OUTREACH';
const LEGAL_REVIEW_ACK_VALUE = 'I_CONFIRM_COUNSEL_REVIEWED_OUTREACH_AND_PRIVACY';
const PROVIDER_SMOKE_FRESH_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const PRODUCTION_REVIEW_MODE = 'production_review';
const PRODUCTION_LIVE_MODE = 'production_live';

export const PROVIDER_DOCS = Object.freeze({
  agentphone: 'https://docs.agentphone.ai/documentation/guides/webhooks',
  agentphoneFaq: 'https://docs.agentphone.ai/documentation/reference/faq',
  agentmail: 'https://docs.agentmail.to/events',
  agentmailOverview: 'https://docs.agentmail.to/overview',
  stripeInvoices: 'https://docs.stripe.com/invoicing/integration',
  browserUseSessions: 'https://docs.browser-use.com/guides/sessions',
  browserUseStatus: 'https://docs.browser-use.com/cloud/api-v2/tasks/get-task-status',
  lovableBuildWithUrl: 'https://docs.lovable.dev/integrations/build-with-url',
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
  const reputation = reputationReadinessReport();
  const jobs = durableJobs.summary();
  const memory = memoryDurabilityReadiness();
  const admin = adminAuthPosture({ mode });
  const providerCertification = providerCertificationStatus();
  const blockers = currentModeBlockers({ mode, providers, webhooks, sideEffects, compliance, reputation, jobs, memory, admin, providerCertification });
  const productionBlockers = productionLiveBlockers({ providers, webhooks, sideEffects, compliance, reputation, jobs, memory, providerCertification });
  const promotionGates = promotionGateReport({ mode, providers, webhooks, compliance, reputation, jobs, memory });
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
    promotionGates,
    nextActions,
    providers,
    providerCertification,
    webhooks,
    fulfillment: fulfillmentReadiness(),
    sideEffects,
    compliance,
    reputation,
    admin,
    jobs,
    memory,
    smoke,
    smokeToggles: {
      gemini: env.smoke.gemini,
      supermemoryWrite: env.smoke.supermemoryWrite,
      mossIndex: env.smoke.mossIndex,
      liveCall: env.smoke.liveCall,
      agentmailSend: env.smoke.agentmailSend,
      stripeInvoice: env.smoke.stripeInvoice,
      browserUse: env.smoke.browserUse,
      lovableNavigation: env.smoke.lovableNavigation
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
  const now = Date.now();
  return Object.fromEntries(PROVIDER_ORDER.map((name) => {
    const configured = providerConfigured(name);
    const required = requiredProvider(name, mode);
    const smokeRow = smoke[name] || null;
    const smokeStatus = smokeRow?.status || 'not_run';
    const smokeAgeMs = smokeRow?.checkedAt ? Math.max(0, now - smokeRow.checkedAt) : null;
    const smokeFresh = smokeStatus === 'ok' && smokeAgeMs !== null && smokeAgeMs <= PROVIDER_SMOKE_FRESH_MS;
    const dryRunEvent = providerSmoke.latestEvent({ provider: name, dryRun: true });
    const liveEvent = providerSmoke.latestEvent({ provider: name, live: true });
    const dryRunSmoke = smokeEventSummary(dryRunEvent, now);
    const liveSmoke = smokeEventSummary(liveEvent, now);
    const lastError = smokeRow?.detail?.error || smokeRow?.detail?.lastError || null;
    const webhook = webhookForProvider(name, webhooks);
    const runtimeIncident = providerRuntimeIncident(name, { now });
    const blockerReasons = [];

    if (required && !configured.ok) blockerReasons.push(`${name} provider missing ${configured.missing.join(', ')}`);
    if (webhook?.required && !webhook.configured) blockerReasons.push(`${name} webhook missing: ${webhook.blockerReasons.join('; ')}`);
    if (required && runtimeIncident.blocked) blockerReasons.push(providerIncidentBlocker(name, runtimeIncident.reason));
    if (['failed', 'blocked'].includes(smokeStatus)) blockerReasons.push(`${name} smoke ${smokeStatus}${lastError ? `: ${operationalErrorSummary(lastError)}` : ''}`);
    if (mode === 'production_live' && required && !(liveSmoke.status === 'ok' && liveSmoke.live)) blockerReasons.push(`${name} live smoke has not passed`);
    if (mode === 'production_live' && required && liveSmoke.status === 'ok' && liveSmoke.live && !liveSmoke.fresh) blockerReasons.push(`${name} live smoke is stale`);

    return [name, {
      configured: configured.ok,
      missing: configured.missing,
      required,
      status: configured.ok ? 'configured' : 'missing',
      webhookConfigured: webhook ? webhook.configured : null,
      smoke: smokeRow ? {
        status: smokeRow.status,
        checkedAt: smokeRow.checkedAt,
        ageMs: smokeAgeMs,
        fresh: smokeFresh,
        dryRun: smokeRow.detail?.dryRun !== false,
        live: !!smokeRow.detail?.live
      } : {
        status: 'not_run',
        checkedAt: null,
        ageMs: null,
        fresh: false,
        dryRun: true,
        live: false
      },
      smokeStatus,
      smokeFresh,
      dryRunSmoke,
      liveSmoke,
      runtimeIncident: {
        blocked: !!runtimeIncident.blocked,
        reason: runtimeIncident.blocked && runtimeIncident.reason
          ? providerIncidentBlocker(name, runtimeIncident.reason)
          : null,
        checkedAt: runtimeIncident.incident?.checkedAt || null,
        ageMs: runtimeIncident.ageMs ?? null,
        clearedBy: runtimeIncident.clearedBy?.checkedAt || null
      },
      lastError: lastError ? operationalErrorSummary(lastError) : null,
      quotaCostStatus: quotaCostStatus(name, smokeRow),
      blockerReasons,
      nextAction: nextProviderAction({ name, configured, required, webhook, smokeStatus, blockerReasons }),
      detail: providerDetail(name)
    }];
  }));
}

export function providerConfigured(name) {
  if (name === 'gemini') return requiredEnv({ GEMINI_API_KEY: env.gemini.apiKey });
  if (name === 'supermemory') return requiredEnv({ SUPERMEMORY_API_KEY: env.supermemory.apiKey });
  if (name === 'moss') return requiredEnv({ MOSS_PROJECT_ID: env.moss.projectId, MOSS_PROJECT_KEY: env.moss.projectKey });
  if (name === 'agentphone') return requiredEnv({ AGENTPHONE_API_KEY: env.agentphone.apiKey });
  if (name === 'browserUse') return requiredEnv({ BROWSER_USE_API_KEY: env.browserUse.apiKey });
  if (name === 'lovable') return requiredEnv({
    BROWSER_USE_API_KEY: env.browserUse.apiKey,
    BROWSER_USE_PROFILE_ID: env.browserUse.profileId,
    LOVABLE_WORKSPACE_NAME: env.lovable.workspaceName
  });
  if (name === 'v0') return requiredEnv({ V0_API_KEY: process.env.V0_API_KEY });
  if (name === 'agentmail') return requiredEnv({ AGENTMAIL_API_KEY: env.agentmail.apiKey, AGENTMAIL_INBOX_ID: env.agentmail.inboxId });
  if (name === 'stripe') return requiredEnv({ STRIPE_SECRET_KEY: env.stripe.secretKey });
  return { ok: false, missing: ['unknown_provider'] };
}

function smokeEventSummary(event, now = Date.now()) {
  if (!event) {
    return {
      status: 'not_run',
      checkedAt: null,
      ageMs: null,
      fresh: false,
      dryRun: false,
      live: false,
      detail: null,
      error: null
    };
  }
  const ageMs = event.checkedAt ? Math.max(0, now - event.checkedAt) : null;
  return {
    status: event.status,
    checkedAt: event.checkedAt,
    ageMs,
    fresh: ageMs !== null && ageMs <= PROVIDER_SMOKE_FRESH_MS,
    dryRun: !!event.dryRun,
    live: !!event.live,
    detail: event.detail || {},
    error: event.error || null
  };
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
  const now = Date.now();
  return {
    agentphone: webhookRow({
      provider: 'agentphone',
      required,
      configured: !!env.agentphone.webhookSecret,
      lastReceivedAt: webhookEvents.lastReceived('agentphone'),
      now,
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
      lastReceivedAt: webhookEvents.lastReceived('agentmail'),
      now,
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
      lastReceivedAt: webhookEvents.lastReceived('stripe'),
      now,
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
  const ageMs = row.lastReceivedAt ? Math.max(0, (row.now || Date.now()) - row.lastReceivedAt) : null;
  const fresh = ageMs !== null && ageMs <= WEBHOOK_FRESH_MS;
  const freshnessBlocker = env.runMode === 'production_live' && row.required && !fresh
    ? `${row.provider} webhook has not been received in the last 7 days`
    : null;
  const blockerReasons = [...row.blockerReasons, freshnessBlocker].filter(Boolean);
  return {
    ...row,
    now: undefined,
    freshness: {
      lastReceivedAt: row.lastReceivedAt || null,
      ageMs,
      fresh
    },
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
      projectUrlExtraction: 'temporary shared preview on .lovable.app',
      persistentProfile: env.browserUse.profileId ? 'configured' : 'missing',
      workspaceName: env.lovable.workspaceName ? 'configured' : 'missing',
      releaseBoundary: 'explicit publish/security/domain/source/ownership evidence after customer approval',
      docs: PROVIDER_DOCS.lovableBuildWithUrl,
      sideEffects: {
        navigationSmoke: env.smoke.lovableNavigation ? 'enabled_by_SMOKE_LOVABLE_NAVIGATION' : 'disabled_by_default',
        submissionSmoke: env.smoke.browserUse ? 'covered_by_SMOKE_BROWSER_USE_for_build_flow' : 'disabled_by_default'
      }
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

export function memoryDurabilityReadiness() {
  const queue = Object.fromEntries(memoryWriteQueue.counts().map((row) => [row.status, Number(row.n) || 0]));
  const failures = memoryFailures.counts();
  const unresolvedFailures = Number(failures.unresolved) || 0;
  const pendingWrites = (queue.queued || 0) + (queue.retrying || 0) + (queue.failed || 0);
  const deadWrites = queue.dead || 0;
  const blockers = [
    !env.memory?.retryEnabled ? 'MEMORY_RETRY_ENABLED must be true for production memory durability' : null,
    pendingWrites ? `${pendingWrites} Supermemory write(s) are pending or failed` : null,
    deadWrites ? `${deadWrites} Supermemory write(s) are dead and require operator repair` : null,
    unresolvedFailures ? `${unresolvedFailures} unresolved memory failure(s) remain` : null
  ].filter(Boolean);
  return {
    ok: blockers.length === 0,
    retryEnabled: env.memory?.retryEnabled === true,
    retryIntervalMs: env.memory?.retryIntervalMs || null,
    retryBatchSize: env.memory?.retryBatchSize || null,
    pendingWrites,
    deadWrites,
    unresolvedFailures,
    retryableFailures: Number(failures.retryable) || 0,
    queue,
    blockers
  };
}

function currentModeBlockers({ mode, providers, webhooks, sideEffects, compliance, reputation, jobs, memory, admin, providerCertification }) {
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
    blockers.push(...productionLiveBlockers({ providers, webhooks, sideEffects, compliance, reputation, jobs, memory, providerCertification }));
  }
  if (admin?.required && !admin.ok) blockers.push(...admin.blockers);

  for (const [name, row] of Object.entries(providers)) {
    if (row.required) blockers.push(...row.blockerReasons);
  }
  for (const row of Object.values(webhooks)) {
    if (row.required && !row.configured) blockers.push(...row.blockerReasons);
  }
  for (const gate of compliance.gates || []) {
    if (!gate.ok) blockers.push(`compliance gate ${gate.name} failed: ${gate.detail}`);
  }
  if (['autonomous_live', 'production_review', 'production_live'].includes(mode)) {
    for (const gate of reputation?.gates || []) {
      if (!gate.ok) blockers.push(`reputation gate ${gate.name} failed: ${gate.detail}`);
    }
  }
  if (jobs?.staleRunning) blockers.push(`${jobs.staleRunning} durable job(s) have stale leases`);
  if (['production_review', 'production_live'].includes(mode) && memory?.ok === false) blockers.push(...memory.blockers);

  return unique(blockers);
}

function productionLiveBlockers({ providers, webhooks, sideEffects, compliance, reputation, jobs, memory, providerCertification = providerCertificationStatus() }) {
  const blockers = [];
  const admin = adminAuthPosture({ mode: PRODUCTION_LIVE_MODE });
  if (env.runMode !== 'production_live') blockers.push('RUN_MODE is not production_live');
  if (!isProductionAcked()) blockers.push(`PRODUCTION_LIVE_ACK must equal ${PRODUCTION_LIVE_ACK_VALUE}`);
  if (env.nodeEnv !== 'production') blockers.push('NODE_ENV must be production for production_live');
  if (!isHttpsPublicUrl(env.publicUrl)) blockers.push('APP_PUBLIC_URL must be a public https URL for production webhooks');
  if (!lovablePreviewFrameConfigured()) blockers.push('PREVIEW_FRAME_SOURCES must allow https://*.lovable.app for customer review previews');
  if (!env.outreach.enabled) blockers.push('AUTONOMOUS_OUTREACH_ENABLED must be true for production_live');
  if (String(env.portal?.tokenSecret || '').length < 32) blockers.push('PORTAL_TOKEN_SECRET must be at least 32 characters for production_live');
  if (String(env.safety?.interlockSecret || '').length < 32) blockers.push('SAFETY_INTERLOCK_SECRET must be at least 32 characters for production_live');
  if (!(env.admin?.operatorTokens || []).length) blockers.push('ADMIN_API_TOKENS_JSON must define named operator identities for production_live');
  if (!env.admin?.mfaEnforced) blockers.push('ADMIN_MFA_ENFORCED must be true for production_live');
  if (env.admin?.apiToken) blockers.push('ADMIN_API_TOKEN must be unset when production_live uses named operator identities');
  if (!env.privacy?.retentionEnabled) blockers.push('DATA_RETENTION_ENABLED must be true for production_live');
  if (!env.privacy?.dataAtRestEncrypted) blockers.push('DATA_AT_REST_ENCRYPTED must attest encrypted production storage');
  if (!env.privacy?.backupsEncrypted) blockers.push('BACKUPS_ENCRYPTED must attest encrypted backup storage');
  if (!isHttpsPublicUrl(env.legal?.privacyPolicyUrl)) blockers.push('PRIVACY_POLICY_URL must be a public https URL for production_live');
  if (!isHttpsPublicUrl(env.legal?.termsOfServiceUrl)) blockers.push('TERMS_OF_SERVICE_URL must be a public https URL for production_live');
  if (env.legal?.reviewAck !== LEGAL_REVIEW_ACK_VALUE) blockers.push(`LEGAL_REVIEW_ACK must equal ${LEGAL_REVIEW_ACK_VALUE}`);
  if (env.deployment?.replicaCount !== 1) blockers.push('SQLite deployment requires APP_REPLICA_COUNT=1');
  if (env.deployment?.singleNodePilotAck !== 'I_ACCEPT_SINGLE_NODE_PILOT_LIMITS') blockers.push('SINGLE_NODE_PILOT_ACK must equal I_ACCEPT_SINGLE_NODE_PILOT_LIMITS');
  blockers.push(...(providerCertification.blockers || []));
  blockers.push(...admin.blockers);

  for (const [name, row] of Object.entries(providers || {})) {
    if (!PRODUCTION_REQUIRED_PROVIDERS.has(name)) continue;
    const liveSmoke = row.liveSmoke || {};
    if (!row.configured) blockers.push(`${name} provider is not configured`);
    if (!(liveSmoke.status === 'ok' && liveSmoke.live === true)) blockers.push(`${name} live smoke has not passed`);
    if (liveSmoke.status === 'ok' && liveSmoke.live === true && !liveSmoke.fresh) blockers.push(`${name} live smoke is stale`);
    if (liveSmoke.error) blockers.push(`${name} last error: ${operationalErrorSummary(liveSmoke.error)}`);
    blockers.push(...(row.blockerReasons || []));
  }
  for (const [name, row] of Object.entries(webhooks || {})) {
    if (!row.configured) blockers.push(`${name} webhook is not configured`);
    if (row.required && !row.freshness?.fresh) blockers.push(`${name} webhook freshness has not been proven`);
  }
  for (const [action, row] of Object.entries(sideEffects || {})) {
    if (!row.allowed) blockers.push(`${row.label} are not enabled for production_live`);
    for (const reason of row.blockers || []) blockers.push(reason);
  }
  for (const gate of compliance?.gates || []) {
    if (!gate.ok) blockers.push(`compliance gate ${gate.name} failed: ${gate.detail}`);
  }
  for (const gate of reputation?.gates || []) {
    if (!gate.ok) blockers.push(`reputation gate ${gate.name} failed: ${gate.detail}`);
  }
  if (jobs?.staleRunning) blockers.push(`${jobs.staleRunning} durable job(s) have stale leases`);
  if (memory?.ok === false) blockers.push(...memory.blockers);
  if (stripeKeyMode(env.stripe.secretKey) === 'secret_live') blockers.push('STRIPE_SECRET_KEY is sk_live_; use a restricted rk_live_ key for production');
  return unique(blockers);
}

function promotionGateReport({ mode, providers, webhooks, compliance, reputation, jobs, memory }) {
  const productionReview = stageReport(PRODUCTION_REVIEW_MODE, [
    gate({
      name: 'target_mode',
      label: 'Run mode',
      ok: mode === PRODUCTION_REVIEW_MODE,
      blockers: mode === PRODUCTION_REVIEW_MODE ? [] : [`RUN_MODE is not ${PRODUCTION_REVIEW_MODE}`],
      nextAction: `set RUN_MODE=${PRODUCTION_REVIEW_MODE} to review production credentials without live side effects`,
      detail: { current: mode, expected: PRODUCTION_REVIEW_MODE }
    }),
    gate({
      name: 'live_side_effects_disabled',
      label: 'Live side effects disabled',
      ok: enabledLiveSideEffectRows().length === 0,
      blockers: enabledLiveSideEffectRows().map(([, row]) => `${row.label} flag must be disabled for production_review`),
      nextAction: 'turn off every LIVE_* flag before production_review',
      detail: { enabled: enabledLiveSideEffectRows().map(([key, row]) => ({ key, label: row.label })) }
    }),
    providerCredentialGate(providers),
    adminAuthGate(adminAuthPosture({ mode: PRODUCTION_REVIEW_MODE })),
    providerIncidentGate(providers),
    webhookSecretGate(),
    dryRunSmokeGate(providers),
    complianceGate(compliance),
    reputationGate(reputation),
    memoryDurabilityGate(memory),
    durableJobsGate(jobs)
  ]);

  const liveMatrix = sideEffectMatrix(PRODUCTION_LIVE_MODE);
  const productionLive = stageReport(PRODUCTION_LIVE_MODE, [
    gate({
      name: 'target_mode',
      label: 'Run mode',
      ok: mode === PRODUCTION_LIVE_MODE,
      blockers: mode === PRODUCTION_LIVE_MODE ? [] : [`RUN_MODE is not ${PRODUCTION_LIVE_MODE}`],
      nextAction: `set RUN_MODE=${PRODUCTION_LIVE_MODE} only after every live gate is green`,
      detail: { current: mode, expected: PRODUCTION_LIVE_MODE }
    }),
    gate({
      name: 'production_ack',
      label: 'Explicit launch ack',
      ok: isProductionAcked(),
      blockers: isProductionAcked() ? [] : [`PRODUCTION_LIVE_ACK must equal ${PRODUCTION_LIVE_ACK_VALUE}`],
      nextAction: `set PRODUCTION_LIVE_ACK=${PRODUCTION_LIVE_ACK_VALUE} when intentionally launching`,
      detail: { env: 'PRODUCTION_LIVE_ACK', expected: PRODUCTION_LIVE_ACK_VALUE }
    }),
    gate({
      name: 'node_env',
      label: 'Node production env',
      ok: env.nodeEnv === 'production',
      blockers: env.nodeEnv === 'production' ? [] : ['NODE_ENV must be production for production_live'],
      nextAction: 'run the server with NODE_ENV=production',
      detail: { current: env.nodeEnv, expected: 'production' }
    }),
    gate({
      name: 'public_https_url',
      label: 'Public HTTPS URL',
      ok: isHttpsPublicUrl(env.publicUrl),
      blockers: isHttpsPublicUrl(env.publicUrl) ? [] : ['APP_PUBLIC_URL must be a public https URL for production webhooks'],
      nextAction: 'set APP_PUBLIC_URL to the deployed https origin and register webhooks',
      detail: { current: env.publicUrl }
    }),
    gate({
      name: 'lovable_preview_csp',
      label: 'Lovable preview CSP',
      ok: lovablePreviewFrameConfigured(),
      blockers: lovablePreviewFrameConfigured() ? [] : ['PREVIEW_FRAME_SOURCES must allow https://*.lovable.app for customer review previews'],
      nextAction: 'set PREVIEW_FRAME_SOURCES=https://*.lovable.app before customer review',
      detail: { configured: env.security?.previewFrameSources || [] }
    }),
    gate({
      name: 'autonomous_outreach',
      label: 'Autonomous outreach enabled',
      ok: env.outreach.enabled,
      blockers: env.outreach.enabled ? [] : ['AUTONOMOUS_OUTREACH_ENABLED must be true for production_live'],
      nextAction: 'set AUTONOMOUS_OUTREACH_ENABLED=true after review gates are green'
    }),
    gate({
      name: 'portal_token_secret',
      label: 'Portal token signing secret',
      ok: String(env.portal?.tokenSecret || '').length >= 32,
      blockers: String(env.portal?.tokenSecret || '').length >= 32 ? [] : ['PORTAL_TOKEN_SECRET must be at least 32 characters for production_live'],
      nextAction: 'set a random PORTAL_TOKEN_SECRET of at least 32 characters and rotate existing portal links'
    }),
    gate({
      name: 'safety_interlock_secret',
      label: 'Signed safety interlock',
      ok: String(env.safety?.interlockSecret || '').length >= 32,
      blockers: String(env.safety?.interlockSecret || '').length >= 32 ? [] : ['SAFETY_INTERLOCK_SECRET must be at least 32 characters for production_live'],
      nextAction: 'set a random SAFETY_INTERLOCK_SECRET of at least 32 characters, then generate a fresh safe-to-sell snapshot'
    }),
    gate({
      name: 'operator_identity',
      label: 'Named operator identity and MFA',
      ok: (env.admin?.operatorTokens || []).length > 0 && env.admin?.mfaEnforced === true && !env.admin?.apiToken,
      blockers: [
        ...((env.admin?.operatorTokens || []).length ? [] : ['ADMIN_API_TOKENS_JSON must define named operator identities for production_live']),
        ...(env.admin?.mfaEnforced ? [] : ['ADMIN_MFA_ENFORCED must be true for production_live']),
        ...(env.admin?.apiToken ? ['ADMIN_API_TOKEN must be unset when production_live uses named operator identities'] : [])
      ],
      nextAction: 'configure named viewer/operator/admin credentials behind an MFA-enforced operator login and remove ADMIN_API_TOKEN'
    }),
    gate({
      name: 'sensitive_data_lifecycle',
      label: 'Sensitive data lifecycle',
      ok: env.privacy?.retentionEnabled === true && env.privacy?.dataAtRestEncrypted === true && env.privacy?.backupsEncrypted === true,
      blockers: [
        ...(env.privacy?.retentionEnabled ? [] : ['DATA_RETENTION_ENABLED must be true for production_live']),
        ...(env.privacy?.dataAtRestEncrypted ? [] : ['DATA_AT_REST_ENCRYPTED must attest encrypted production storage']),
        ...(env.privacy?.backupsEncrypted ? [] : ['BACKUPS_ENCRYPTED must attest encrypted backup storage'])
      ],
      nextAction: 'enable the retention scheduler and deploy the database and backups on encrypted storage'
    }),
    gate({
      name: 'legal_review',
      label: 'Customer policies and legal review',
      ok: isHttpsPublicUrl(env.legal?.privacyPolicyUrl)
        && isHttpsPublicUrl(env.legal?.termsOfServiceUrl)
        && env.legal?.reviewAck === LEGAL_REVIEW_ACK_VALUE,
      blockers: [
        ...(isHttpsPublicUrl(env.legal?.privacyPolicyUrl) ? [] : ['PRIVACY_POLICY_URL must be a public https URL for production_live']),
        ...(isHttpsPublicUrl(env.legal?.termsOfServiceUrl) ? [] : ['TERMS_OF_SERVICE_URL must be a public https URL for production_live']),
        ...(env.legal?.reviewAck === LEGAL_REVIEW_ACK_VALUE ? [] : [`LEGAL_REVIEW_ACK must equal ${LEGAL_REVIEW_ACK_VALUE}`])
      ],
      nextAction: 'have qualified counsel review outreach, privacy, and customer terms; publish both policies; then record the explicit legal review acknowledgement',
      detail: {
        privacyPolicyConfigured: isHttpsPublicUrl(env.legal?.privacyPolicyUrl),
        termsConfigured: isHttpsPublicUrl(env.legal?.termsOfServiceUrl),
        reviewed: env.legal?.reviewAck === LEGAL_REVIEW_ACK_VALUE
      }
    }),
    gate({
      name: 'single_node_pilot',
      label: 'Single-node pilot scope',
      ok: env.deployment?.replicaCount === 1 && env.deployment?.singleNodePilotAck === 'I_ACCEPT_SINGLE_NODE_PILOT_LIMITS',
      blockers: [
        ...(env.deployment?.replicaCount === 1 ? [] : ['SQLite deployment requires APP_REPLICA_COUNT=1']),
        ...(env.deployment?.singleNodePilotAck === 'I_ACCEPT_SINGLE_NODE_PILOT_LIMITS' ? [] : ['SINGLE_NODE_PILOT_ACK must equal I_ACCEPT_SINGLE_NODE_PILOT_LIMITS'])
      ],
      nextAction: 'limit this release to one controlled replica and explicitly accept the single-node availability boundary'
    }),
    providerCertificationGate(),
    gate({
      name: 'live_side_effect_flags',
      label: 'Live side-effect flags',
      ok: Object.values(liveMatrix).every((row) => row.allowed),
      blockers: Object.values(liveMatrix).flatMap((row) => row.allowed ? [] : [`${row.label} are not enabled for production_live`, ...(row.blockers || [])]),
      nextAction: 'enable the specific LIVE_* flags only when intentionally launching',
      detail: liveMatrix
    }),
    providerCredentialGate(providers),
    adminAuthGate(adminAuthPosture({ mode: PRODUCTION_LIVE_MODE })),
    providerIncidentGate(providers),
    liveSmokeGate(providers),
    webhookFreshnessGate(webhooks),
    complianceGate(compliance),
    reputationGate(reputation),
    memoryDurabilityGate(memory),
    durableJobsGate(jobs),
    gate({
      name: 'stripe_key_scope',
      label: 'Stripe key scope',
      ok: stripeKeyMode(env.stripe.secretKey) !== 'secret_live',
      blockers: stripeKeyMode(env.stripe.secretKey) === 'secret_live'
        ? ['STRIPE_SECRET_KEY is sk_live_; use a restricted rk_live_ key for production']
        : [],
      nextAction: 'replace sk_live_ with a restricted rk_live_ key',
      detail: { keyMode: stripeKeyMode(env.stripe.secretKey) }
    })
  ]);

  return { productionReview, productionLive };
}

function stageReport(targetMode, gates) {
  const blockers = unique(gates.flatMap((item) => item.blockers || []));
  return {
    targetMode,
    ok: gates.every((item) => item.ok),
    blockerCount: blockers.length,
    blockers,
    nextActions: nextActionsFor(blockers),
    gates
  };
}

function gate({ name, label, ok, blockers = [], nextAction = 'monitor', detail = undefined }) {
  return {
    name,
    label,
    ok: Boolean(ok),
    blockers: unique(blockers),
    nextAction: Boolean(ok) ? 'monitor' : nextAction,
    ...(detail === undefined ? {} : { detail })
  };
}

function providerCredentialGate(providers) {
  const blockers = [];
  const detail = {};
  for (const name of PRODUCTION_REQUIRED_PROVIDERS) {
    const row = providers?.[name];
    detail[name] = { configured: !!row?.configured, missing: row?.missing || [] };
    if (!row?.configured) blockers.push(`${name} provider is not configured`);
  }
  return gate({
    name: 'provider_credentials',
    label: 'Provider credentials',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'set missing provider credentials',
    detail
  });
}

function memoryDurabilityGate(memory) {
  return gate({
    name: 'persistent_memory',
    label: 'Persistent memory durability',
    ok: memory?.ok === true,
    blockers: memory?.blockers || ['persistent memory status is unavailable'],
    nextAction: 'enable durable memory retries and clear unresolved Supermemory writes before promotion',
    detail: memory || null
  });
}

function providerIncidentGate(providers) {
  const blockers = [];
  const detail = {};
  for (const name of PRODUCTION_REQUIRED_PROVIDERS) {
    const incident = providers?.[name]?.runtimeIncident || {};
    detail[name] = incident;
    if (incident.blocked && incident.reason) blockers.push(incident.reason);
  }
  return gate({
    name: 'provider_runtime_incidents',
    label: 'Provider runtime incidents',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'fix provider credentials/config, then run a successful live smoke for the named provider',
    detail
  });
}

function adminAuthGate(admin) {
  return gate({
    name: 'admin_auth',
    label: 'Admin auth',
    ok: admin?.ok === true,
    blockers: admin?.blockers || ['ADMIN_API_TOKEN posture is unavailable'],
    nextAction: admin?.nextAction || 'set ADMIN_API_TOKEN',
    detail: {
      required: !!admin?.required,
      configured: !!admin?.configured,
      strong: !!admin?.strong,
      namedOperatorCount: Number(admin?.namedOperatorCount || 0),
      identityBacked: !!admin?.identityBacked
    }
  });
}

function providerCertificationGate() {
  const status = providerCertificationStatus();
  return gate({
    name: 'provider_certification',
    label: 'Staging provider and capacity certification',
    ok: status.ok,
    blockers: status.blockers,
    nextAction: 'run owned-target provider certification plus the one-hour 3x-capacity soak, then set PROVIDER_CERTIFICATION_FILE',
    detail: { file: status.file || null, certifiedProviders: status.certifiedProviders || [], loadTest: status.loadTest || null }
  });
}

export function providerCertificationStatus({ now = Date.now(), file = env.deployment?.providerCertificationFile } = {}) {
  if (!file) return { ok: false, file: null, certifiedProviders: [], blockers: ['PROVIDER_CERTIFICATION_FILE is required for production_live'] };
  if (!existsSync(file)) return { ok: false, file, certifiedProviders: [], blockers: ['PROVIDER_CERTIFICATION_FILE does not exist'] };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, file, certifiedProviders: [], blockers: ['PROVIDER_CERTIFICATION_FILE is not valid JSON'] };
  }
  const rows = Array.isArray(manifest?.providers) ? manifest.providers : [];
  const blockers = [];
  const certifiedProviders = [];
  if (manifest?.version !== 1) blockers.push('provider certification version must be 1');
  if (manifest?.environment !== 'staging') blockers.push('provider certification environment must be staging');
  for (const provider of PRODUCTION_REQUIRED_PROVIDERS) {
    const row = rows.find((item) => item?.provider === provider);
    if (!row) {
      blockers.push(`${provider} staging certification is missing`);
      continue;
    }
    const certifiedAt = Date.parse(row.certifiedAt);
    if (!Number.isFinite(certifiedAt) || now - certifiedAt > 90 * 24 * 60 * 60 * 1000) blockers.push(`${provider} staging certification is missing or stale`);
    for (const field of ['ownedTarget', 'requestSchema', 'responseSchema', 'quotaVerified', 'retryPolicyVerified', 'webhookOrderingVerified', 'outageBehaviorVerified', 'credentialScopeVerified']) {
      if (!certificationEvidencePresent(row[field])) blockers.push(`${provider} certification missing ${field}`);
    }
    if (provider !== 'gemini' && !certificationEvidencePresent(row.idempotencyBehavior)) blockers.push(`${provider} certification missing idempotencyBehavior`);
    if (!blockers.some((blocker) => blocker.startsWith(`${provider} `))) certifiedProviders.push(provider);
  }
  const loadTest = manifest?.loadTest && typeof manifest.loadTest === 'object' ? manifest.loadTest : {};
  const loadCompletedAt = Date.parse(loadTest.completedAt);
  const forecastConcurrency = Number(loadTest.forecastConcurrentWorkflows);
  const testedConcurrency = Number(loadTest.testedConcurrentWorkflows);
  const durationMinutes = Number(loadTest.durationMinutes);
  const sqliteBusyErrors = Number(loadTest.sqliteBusyErrors);
  if (!Number.isFinite(loadCompletedAt) || now - loadCompletedAt > 90 * 24 * 60 * 60 * 1000) blockers.push('load/soak certification is missing or stale');
  if (!(forecastConcurrency > 0)) blockers.push('load/soak certification missing forecastConcurrentWorkflows');
  if (!(testedConcurrency >= forecastConcurrency * 3)) blockers.push('load/soak certification must exercise at least 3x forecast concurrency');
  if (!(durationMinutes >= 60)) blockers.push('load/soak certification must run for at least 60 minutes');
  if (sqliteBusyErrors !== 0) blockers.push('load/soak certification recorded SQLite busy errors');
  for (const field of ['webhookBurstVerified', 'sseFanoutVerified', 'slowProviderVerified']) {
    if (loadTest[field] !== true) blockers.push(`load/soak certification missing ${field}`);
  }
  return {
    ok: blockers.length === 0,
    file,
    certifiedProviders,
    blockers,
    loadTest: {
      completedAt: loadTest.completedAt || null,
      forecastConcurrentWorkflows: Number.isFinite(forecastConcurrency) ? forecastConcurrency : null,
      testedConcurrentWorkflows: Number.isFinite(testedConcurrency) ? testedConcurrency : null,
      durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
      sqliteBusyErrors: Number.isFinite(sqliteBusyErrors) ? sqliteBusyErrors : null,
      webhookBurstVerified: loadTest.webhookBurstVerified === true,
      sseFanoutVerified: loadTest.sseFanoutVerified === true,
      slowProviderVerified: loadTest.slowProviderVerified === true
    }
  };
}

function certificationEvidencePresent(value) {
  const text = String(value || '').trim();
  return text.length >= 8 && !/replace[-_ ]?with|placeholder|todo/i.test(text);
}

function dryRunSmokeGate(providers) {
  const blockers = [];
  const detail = {};
  for (const name of PRODUCTION_REQUIRED_PROVIDERS) {
    const row = providers?.[name];
    const dryRun = row?.dryRunSmoke?.status !== 'not_run' ? row.dryRunSmoke : row?.smoke;
    const status = dryRun?.status || 'not_run';
    const ageMs = dryRun?.ageMs;
    const fresh = Number.isFinite(ageMs) && ageMs <= PROVIDER_SMOKE_FRESH_MS;
    const acceptableStatus = ['configured', 'ok'].includes(status);
    detail[name] = {
      status,
      checkedAt: dryRun?.checkedAt || null,
      ageMs: ageMs ?? null,
      fresh,
      dryRun: dryRun?.dryRun === true,
      live: dryRun?.live === true
    };
    if (!acceptableStatus) blockers.push(`${name} dry-run/config smoke has not passed`);
    else if (!fresh) blockers.push(`${name} dry-run/config smoke is stale`);
  }
  return gate({
    name: 'dry_run_smoke_freshness',
    label: 'Dry-run smoke freshness',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'run npm run smoke:providers without live toggles',
    detail
  });
}

function liveSmokeGate(providers) {
  const blockers = [];
  const detail = {};
  for (const name of PRODUCTION_REQUIRED_PROVIDERS) {
    const row = providers?.[name];
    const liveSmoke = row?.liveSmoke || {};
    detail[name] = {
      status: liveSmoke.status || 'not_run',
      checkedAt: liveSmoke.checkedAt || null,
      ageMs: liveSmoke.ageMs ?? null,
      fresh: !!liveSmoke.fresh,
      live: liveSmoke.live === true,
      lastError: liveSmoke.error ? operationalErrorSummary(liveSmoke.error) : null
    };
    if (liveSmoke.status !== 'ok' || liveSmoke.live !== true) blockers.push(`${name} live smoke has not passed`);
    else if (!liveSmoke.fresh) blockers.push(`${name} live smoke is stale`);
    if (liveSmoke.error) blockers.push(`${name} last error: ${operationalErrorSummary(liveSmoke.error)}`);
  }
  return gate({
    name: 'live_smoke_freshness',
    label: 'Live smoke freshness',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'run one provider smoke at a time with SMOKE_* live toggles',
    detail
  });
}

function webhookSecretGate() {
  const rows = {
    agentphone: { configured: !!env.agentphone.webhookSecret, missing: 'AGENTPHONE_WEBHOOK_SECRET missing' },
    agentmail: { configured: !!env.agentmail.webhookSecret, missing: 'AGENTMAIL_WEBHOOK_SECRET missing' },
    stripe: { configured: !!env.stripe.webhookSecret, missing: 'STRIPE_WEBHOOK_SECRET missing' }
  };
  const blockers = Object.entries(rows)
    .filter(([, row]) => !row.configured)
    .map(([provider, row]) => `${provider} webhook missing: ${row.missing}`);
  return gate({
    name: 'webhook_secrets',
    label: 'Webhook secrets',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'configure provider webhook secrets before review',
    detail: rows
  });
}

function webhookFreshnessGate(webhooks) {
  const blockers = [];
  const detail = {};
  for (const [name, row] of Object.entries(webhooks || {})) {
    detail[name] = {
      configured: !!row.configured,
      lastReceivedAt: row.freshness?.lastReceivedAt || null,
      ageMs: row.freshness?.ageMs ?? null,
      fresh: !!row.freshness?.fresh,
      endpoint: row.endpoint
    };
    if (!row.configured) blockers.push(`${name} webhook is not configured`);
    if (row.required && !row.freshness?.fresh) blockers.push(`${name} webhook freshness has not been proven`);
    for (const reason of row.blockerReasons || []) blockers.push(reason);
  }
  return gate({
    name: 'webhook_freshness',
    label: 'Webhook freshness',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'deliver and verify provider webhooks on the public https endpoint',
    detail
  });
}

function complianceGate(compliance) {
  const blockers = (compliance?.gates || [])
    .filter((item) => !item.ok)
    .map((item) => `compliance gate ${item.name} failed: ${item.detail}`);
  return gate({
    name: 'compliance',
    label: 'Compliance gates',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'fix the named compliance gate before resuming outreach',
    detail: compliance?.gates || []
  });
}

function reputationGate(reputation) {
  const blockers = (reputation?.gates || [])
    .filter((item) => !item.ok)
    .map((item) => `reputation gate ${item.name} failed: ${item.detail}`);
  return gate({
    name: 'reputation',
    label: 'Reputation gates',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'pause or throttle outreach until reputation gates recover',
    detail: reputation?.gates || []
  });
}

function durableJobsGate(jobs) {
  const blockers = jobs?.staleRunning ? [`${jobs.staleRunning} durable job(s) have stale leases`] : [];
  return gate({
    name: 'durable_jobs',
    label: 'Durable jobs',
    ok: blockers.length === 0,
    blockers,
    nextAction: 'recover stale jobs before promotion',
    detail: jobs || null
  });
}

function enabledLiveSideEffectRows() {
  return Object.entries(sideEffectMatrix(PRODUCTION_LIVE_MODE)).filter(([, row]) => row.flagEnabled);
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
    lovableNavigationPolicy: env.smoke.lovableNavigation ? 'smoke_can_open_lovable_without_submission' : 'no_lovable_navigation_without_SMOKE_LOVABLE_NAVIGATION',
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

function providerIncidentBlocker(provider, reason) {
  return `${provider} provider has an uncleared runtime incident: ${operationalErrorSummary(reason)}`;
}

function nextActionsFor(blockers) {
  return unique(blockers).slice(0, 12).map((blocker) => {
    if (/RUN_MODE is not production_review/.test(blocker)) return 'set RUN_MODE=production_review to review production credentials without live side effects';
    if (/RUN_MODE/.test(blocker)) return 'set RUN_MODE=production_live only after review blockers are gone';
    if (/PRODUCTION_LIVE_ACK/.test(blocker)) return `set PRODUCTION_LIVE_ACK=${PRODUCTION_LIVE_ACK_VALUE} when intentionally launching`;
    if (/ADMIN_API_TOKEN/.test(blocker)) return 'set a strong ADMIN_API_TOKEN before production review/live';
    if (/APP_PUBLIC_URL/.test(blocker)) return 'set APP_PUBLIC_URL to the deployed https origin and register webhooks';
    if (/PREVIEW_FRAME_SOURCES/.test(blocker)) return 'set PREVIEW_FRAME_SOURCES=https://*.lovable.app for customer review previews';
    if (/PRIVACY_POLICY_URL|TERMS_OF_SERVICE_URL|LEGAL_REVIEW_ACK/.test(blocker)) return 'publish counsel-reviewed privacy and terms pages, then set the legal review acknowledgement';
    if (/WEBHOOK_SECRET|webhook/.test(blocker)) return 'configure provider webhook secret and endpoint';
    if (/dry-run\/config smoke/.test(blocker)) return 'run npm run smoke:providers without live toggles';
    if (/live smoke/.test(blocker)) return 'run one provider smoke at a time with SMOKE_* toggles';
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

function lovablePreviewFrameConfigured() {
  return (env.security?.previewFrameSources || []).some((source) => {
    const value = String(source || '').trim().toLowerCase().replace(/\/+$/, '');
    return value === 'https://*.lovable.app' || value === 'https://lovable.app';
  });
}
