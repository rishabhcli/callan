import { env } from './env.js';
import { callAttempts, doNotCall, leads, providerSmoke, contactEvents } from './db.js';

const MODES = new Set(['mock', 'demo_live', 'autonomous_live', 'live']);

export function liveReadiness() {
  const smoke = providerSmoke.all();
  const providers = {
    gemini: provider('gemini', !!env.gemini.apiKey, smoke, {
      models: { pro: env.gemini.modelPro, flash: env.gemini.modelFlash },
      sideEffects: { generateContent: env.smoke.gemini ? 'enabled_by_SMOKE_GEMINI' : 'disabled_by_default' }
    }),
    supermemory: provider('supermemory', !!env.supermemory.apiKey, smoke, {
      isolation: 'containerTag_per_lead',
      supportedKinds: ['profile', 'pitch', 'call_log', 'post_mortem', 'mail_thread'],
      sideEffects: { addListSearchSmoke: env.smoke.supermemoryWrite ? 'enabled_by_SMOKE_SUPERMEMORY_WRITE' : 'disabled_by_default' }
    }),
    agentphone: provider('agentphone', !!env.agentphone.apiKey, smoke, {
      agentId: env.agentphone.agentId ? 'configured' : 'create_or_reuse',
      ownedNumberSmoke: env.smoke.liveCall ? 'enabled_by_SMOKE_LIVE_CALL' : 'disabled_by_default',
      fromNumber: env.agentphone.fromNumber ? 'configured' : 'missing'
    }),
    moss: provider('moss', !!env.moss.projectId && !!env.moss.projectKey, smoke, {
      role: 'quota_safe_in_call_index',
      sideEffects: { indexSmoke: env.smoke.mossIndex ? 'enabled_by_SMOKE_MOSS_INDEX' : 'disabled_by_default' }
    }),
    browserUse: provider('browserUse', !!env.browserUse.apiKey, smoke, {
      mode: 'cloud_agent_session',
      sideEffects: { sessionSmoke: env.smoke.browserUse ? 'enabled_by_SMOKE_BROWSER_USE' : 'disabled_by_default' }
    }),
    lovable: provider('lovable', !!env.browserUse.apiKey, smoke, {
      role: 'website_generation_target',
      execution: 'browserUse_cloud_session',
      buildWithUrl: 'https://lovable.dev/?prompt=<encoded>',
      authWall: 'blocked_auth_event',
      projectUrlExtraction: '.lovable.app',
      sideEffects: { submissionSmoke: env.smoke.browserUse ? 'covered_by_SMOKE_BROWSER_USE' : 'disabled_by_default' }
    }),
    agentmail: provider('agentmail', !!env.agentmail.apiKey && !!env.agentmail.inboxId, smoke, {
      inboxId: env.agentmail.inboxId ? 'configured' : 'missing',
      sideEffects: { sendSmoke: env.smoke.agentmailSend ? 'enabled_by_SMOKE_AGENTMAIL_SEND' : 'disabled_by_default' }
    }),
    stripe: provider('stripe', !!env.stripe.secretKey, smoke, {
      invoiceMode: 'hosted_invoice_primary',
      sideEffects: { invoiceSmoke: env.smoke.stripeInvoice ? 'enabled_by_SMOKE_STRIPE_INVOICE' : 'disabled_by_default' }
    })
  };

  const webhookStatus = {
    agentphone: env.agentphone.webhookSecret ? 'configured' : 'missing_secret',
    agentmail: env.agentmail.webhookSecret ? 'configured' : 'dev_accepting_unsigned',
    stripe: env.stripe.webhookSecret ? 'configured' : 'missing_secret'
  };

  const blockers = [];
  if (!MODES.has(env.runMode)) blockers.push(`invalid RUN_MODE: ${env.runMode}`);
  if (env.runMode === 'demo_live' && env.allowedPhones.length === 0) blockers.push('demo_live requires ALLOWED_TARGET_PHONES');
  if (env.runMode === 'autonomous_live' && !env.outreach.enabled) blockers.push('autonomous_live requires AUTONOMOUS_OUTREACH_ENABLED=true');
  if ((env.runMode === 'demo_live' || env.runMode === 'autonomous_live') && !env.agentphone.webhookSecret) {
    blockers.push('live calling requires AGENTPHONE_WEBHOOK_SECRET');
  }
  if ((env.runMode === 'demo_live' || env.runMode === 'autonomous_live') && !env.stripe.webhookSecret) {
    blockers.push('live invoices require STRIPE_WEBHOOK_SECRET');
  }
  for (const [name, status] of Object.entries(providers)) {
    if (!status.configured && requiredProvider(name)) blockers.push(`${name} not configured`);
  }

  return {
    mode: env.runMode,
    autonomous: env.runMode === 'autonomous_live' && env.outreach.enabled,
    ready: blockers.length === 0,
    blockers,
    providers,
    webhooks: webhookStatus,
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
    outreach: {
      ...leads.outreachSummary(),
      todaysCalls: callAttempts.todayCount(),
      optOuts: doNotCall.count(),
      repliesWaiting: contactEvents.repliesWaiting(),
      intervalMs: env.outreach.intervalMs,
      batchSize: env.outreach.batchSize
    },
    quotas: {
      outreachDailyAttempts: callAttempts.todayCount(),
      maxAttemptsPerPhone: env.outreach.maxAttemptsPerPhone,
      mossIndexPolicy: env.smoke.mossIndex ? 'smoke_can_create_delete_or_reuse' : 'no_index_side_effects_without_SMOKE_MOSS_INDEX',
      browserUseSessionPolicy: env.smoke.browserUse ? 'smoke_can_create_session' : 'no_session_side_effects_without_SMOKE_BROWSER_USE',
      stripeInvoicePolicy: env.smoke.stripeInvoice ? 'smoke_can_create_test_invoice' : 'no_invoice_side_effects_without_SMOKE_STRIPE_INVOICE'
    }
  };
}

function provider(name, configured, smoke, detail = {}) {
  const smokeRow = smoke[name] || null;
  const lastError = smokeRow?.detail?.error || smokeRow?.detail?.lastError || null;
  return {
    configured,
    required: requiredProvider(name),
    status: configured ? 'configured' : 'missing',
    smoke: smokeRow ? {
      status: smokeRow.status,
      checkedAt: smokeRow.checkedAt,
      dryRun: smokeRow.detail?.dryRun !== false,
      live: !!smokeRow.detail?.live
    } : null,
    lastError,
    detail
  };
}

function requiredProvider(name) {
  if (env.runMode === 'mock') return ['gemini', 'supermemory'].includes(name);
  return ['gemini', 'supermemory', 'agentphone', 'browserUse', 'lovable', 'agentmail', 'stripe'].includes(name);
}
