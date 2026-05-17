import { env } from './env.js';
import { callAttempts, doNotCall, leads, providerSmoke, contactEvents } from './db.js';

const MODES = new Set(['mock', 'demo_live', 'autonomous_live', 'live']);

export function liveReadiness() {
  const providers = {
    gemini: provider('gemini', !!env.gemini.apiKey),
    supermemory: provider('supermemory', !!env.supermemory.apiKey),
    agentphone: provider('agentphone', !!env.agentphone.apiKey),
    moss: provider('moss', !!env.moss.projectId && !!env.moss.projectKey),
    browserUse: provider('browserUse', !!env.browserUse.apiKey),
    agentmail: provider('agentmail', !!env.agentmail.apiKey && !!env.agentmail.inboxId),
    stripe: provider('stripe', !!env.stripe.secretKey)
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
    smoke: providerSmoke.all(),
    outreach: {
      ...leads.outreachSummary(),
      todaysCalls: callAttempts.todayCount(),
      optOuts: doNotCall.count(),
      repliesWaiting: contactEvents.repliesWaiting(),
      intervalMs: env.outreach.intervalMs,
      batchSize: env.outreach.batchSize
    }
  };
}

function provider(name, configured) {
  return { configured, status: configured ? 'configured' : 'missing' };
}

function requiredProvider(name) {
  if (env.runMode === 'mock') return ['gemini', 'supermemory'].includes(name);
  return ['gemini', 'supermemory', 'agentphone', 'browserUse', 'agentmail', 'stripe'].includes(name);
}
