import 'dotenv/config';

const bool = (v) => v === 'true' || v === '1' || v === 'yes';
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const RUN_MODES = Object.freeze([
  'mock',
  'demo_live',
  'autonomous_live',
  'production_review',
  'production_live'
]);

export const SIDE_EFFECTS = Object.freeze([
  'calls',
  'emails',
  'invoices',
  'browserSessions',
  'publicOutreach',
  'builds'
]);

const RUN_MODE_SET = new Set(RUN_MODES);
const SIDE_EFFECT_LABELS = Object.freeze({
  calls: 'outbound calls',
  emails: 'outbound emails',
  invoices: 'Stripe invoices',
  browserSessions: 'Browser Use sessions',
  publicOutreach: 'public outreach',
  builds: 'site builds'
});

const MODE_POLICIES = Object.freeze({
  mock: {
    label: 'Mock harness',
    description: 'Synthetic providers only. Exercises the orchestration path without live side effects.',
    sideEffects: { calls: false, emails: false, invoices: false, browserSessions: false, publicOutreach: false, builds: false }
  },
  demo_live: {
    label: 'Owned-target live demo',
    description: 'Live providers are allowed only for operator-owned or explicitly seeded targets.',
    sideEffects: { calls: 'allowlist', emails: 'allowlist', invoices: 'allowlist', browserSessions: true, publicOutreach: false, builds: true }
  },
  autonomous_live: {
    label: 'Autonomous live lab',
    description: 'Autonomous outreach can run against public business targets with strict compliance gates.',
    sideEffects: { calls: 'compliance', emails: 'compliance', invoices: 'invoice_consent', browserSessions: true, publicOutreach: 'compliance', builds: true }
  },
  production_review: {
    label: 'Production review',
    description: 'Production credentials and webhooks can be reviewed, but live side effects remain disabled.',
    sideEffects: { calls: false, emails: false, invoices: false, browserSessions: false, publicOutreach: false, builds: false }
  },
  production_live: {
    label: 'Production live',
    description: 'Full production operation. Requires every provider, webhook, compliance gate, quota, and emergency stop surface.',
    sideEffects: { calls: 'compliance', emails: 'compliance', invoices: 'invoice_consent', browserSessions: true, publicOutreach: 'compliance', builds: true }
  }
});

export const env = {
  port: Number(process.env.PORT || 8787),
  publicUrl: process.env.APP_PUBLIC_URL || 'http://localhost:8787',
  dataDir: process.env.DATA_DIR || '.data',
  nodeEnv: process.env.NODE_ENV || 'development',

  runMode: process.env.RUN_MODE || 'mock',
  productionLiveAck: process.env.PRODUCTION_LIVE_ACK || '',
  live: {
    calls: bool(process.env.LIVE_CALLS),
    emails: bool(process.env.LIVE_EMAILS),
    payments: bool(process.env.LIVE_PAYMENTS),
    invoices: bool(process.env.LIVE_PAYMENTS),
    browserSessions: bool(process.env.LIVE_BROWSER_SESSIONS) || bool(process.env.LIVE_BUILDS),
    publicOutreach: bool(process.env.LIVE_PUBLIC_OUTREACH),
    builds: bool(process.env.LIVE_BUILDS)
  },
  smoke: {
    gemini: bool(process.env.SMOKE_GEMINI),
    supermemoryWrite: bool(process.env.SMOKE_SUPERMEMORY_WRITE),
    mossIndex: bool(process.env.SMOKE_MOSS_INDEX),
    liveCall: bool(process.env.SMOKE_LIVE_CALL),
    agentmailSend: bool(process.env.SMOKE_AGENTMAIL_SEND),
    stripeInvoice: bool(process.env.SMOKE_STRIPE_INVOICE),
    browserUse: bool(process.env.SMOKE_BROWSER_USE),
    testPhone: process.env.SMOKE_TEST_PHONE || '',
    testEmail: process.env.SMOKE_TEST_EMAIL || ''
  },
  allowedPhones: list(process.env.ALLOWED_TARGET_PHONES),
  allowedEmails: list(process.env.ALLOWED_TARGET_EMAILS),
  outreach: {
    enabled: bool(process.env.AUTONOMOUS_OUTREACH_ENABLED),
    intervalMs: num(process.env.OUTREACH_INTERVAL_MS, 15000),
    batchSize: num(process.env.OUTREACH_BATCH_SIZE, 1),
    maxAttemptsPerPhone: num(process.env.MAX_ATTEMPTS_PER_PHONE, 1),
    quietHoursStart: num(process.env.QUIET_HOURS_START, 20),
    quietHoursEnd: num(process.env.QUIET_HOURS_END, 9),
    timezone: process.env.OUTREACH_TIMEZONE || 'America/Los_Angeles'
  },

  hackathon: {
    name: process.env.HACKATHON_NAME || 'Call My Agent Hackathon',
    date: process.env.HACKATHON_DATE || '2026-05-17',
    location: process.env.HACKATHON_LOCATION || 'Y Combinator, San Francisco',
    url: process.env.HACKATHON_URL || 'https://events.ycombinator.com/CallMyAgentHackathon',
    sponsors: list(process.env.HACKATHON_SPONSORS || 'Google DeepMind,AgentPhone,AgentMail,Supermemory,Moss,Browser Use,Lovable,Stripe')
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    projectName: process.env.GEMINI_PROJECT_NAME || '',
    projectNumber: process.env.GEMINI_PROJECT_NUMBER || '',
    modelPro: process.env.GEMINI_MODEL_PRO || 'gemini-3.1-pro-preview',
    modelFlash: process.env.GEMINI_MODEL_FLASH || 'gemini-3-flash-preview'
  },

  supermemory: {
    apiKey: process.env.SUPERMEMORY_API_KEY || ''
  },

  agentphone: {
    apiKey: process.env.AGENTPHONE_API_KEY || '',
    baseUrl: process.env.AGENTPHONE_BASE_URL || 'https://api.agentphone.ai/v1',
    agentId: process.env.AGENTPHONE_AGENT_ID || '',
    defaultVoice: process.env.AGENTPHONE_DEFAULT_VOICE || 'Polly.Joanna',
    webhookSecret: process.env.AGENTPHONE_WEBHOOK_SECRET || '',
    fromNumber: process.env.AGENTPHONE_FROM_NUMBER || ''
  },

  moss: {
    projectId: process.env.MOSS_PROJECT_ID || '',
    projectKey: process.env.MOSS_PROJECT_KEY || '',
    baseUrl: process.env.MOSS_BASE_URL || 'https://service.usemoss.dev/v1'
  },

  browserUse: {
    apiKey: process.env.BROWSER_USE_API_KEY || '',
    baseUrl: process.env.BROWSER_USE_BASE_URL || 'https://api.browser-use.com/api/v3'
  },

  agentmail: {
    apiKey: process.env.AGENTMAIL_API_KEY || '',
    inboxId: process.env.AGENTMAIL_INBOX_ID || '',
    displayName: process.env.AGENTMAIL_DISPLAY_NAME || 'callmemaybe',
    webhookSecret: process.env.AGENTMAIL_WEBHOOK_SECRET || ''
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    startupBenefitsUrl: process.env.STRIPE_STARTUP_BENEFITS_URL || '',
    priceCents: Number(process.env.STRIPE_PRICE_USD_CENTS || 50000),
    productName: process.env.STRIPE_PRODUCT_NAME || 'Website by callmemaybe',
    successUrl: process.env.STRIPE_SUCCESS_URL || 'http://localhost:8787/success',
    cancelUrl: process.env.STRIPE_CANCEL_URL || 'http://localhost:8787/cancel'
  }
};

export function validRunModes() {
  return [...RUN_MODES];
}

export function isValidRunMode(mode = env.runMode) {
  return RUN_MODE_SET.has(mode);
}

export function modePolicy(mode = env.runMode) {
  return MODE_POLICIES[mode] || null;
}

export function isMockMode(mode = env.runMode) {
  return mode === 'mock';
}

export function isProductionReviewMode(mode = env.runMode) {
  return mode === 'production_review';
}

export function isProductionLiveMode(mode = env.runMode) {
  return mode === 'production_live';
}

export function isAutonomousLiveMode(mode = env.runMode) {
  return mode === 'autonomous_live';
}

export function isDemoLiveMode(mode = env.runMode) {
  return mode === 'demo_live';
}

export function isLiveProviderMode(mode = env.runMode) {
  return ['demo_live', 'autonomous_live', 'production_live'].includes(mode);
}

export function isPublicOutreachMode(mode = env.runMode) {
  return ['autonomous_live', 'production_live'].includes(mode);
}

export function isProductionAcked() {
  return env.productionLiveAck === 'I_UNDERSTAND_LIVE_OUTREACH';
}

export function modeAllowsSideEffect(action, mode = env.runMode) {
  const value = modePolicy(mode)?.sideEffects?.[action];
  return value === true || typeof value === 'string';
}

export function sideEffectMatrix(mode = env.runMode) {
  const policy = modePolicy(mode);
  return Object.fromEntries(SIDE_EFFECTS.map((action) => {
    const requirement = policy?.sideEffects?.[action] ?? false;
    const modeAllowed = modeAllowsSideEffect(action, mode);
    const flagEnabled = sideEffectFlagEnabled(action);
    const blockers = [];
    if (!policy) blockers.push(`invalid RUN_MODE ${mode}`);
    if (!modeAllowed) blockers.push(`${mode || 'unknown mode'} disallows ${SIDE_EFFECT_LABELS[action]}`);
    if (modeAllowed && !flagEnabled) blockers.push(`${envNameForSideEffect(action)} is not enabled`);
    if (action === 'publicOutreach' && modeAllowed && !env.outreach.enabled) blockers.push('AUTONOMOUS_OUTREACH_ENABLED is not enabled');
    return [action, {
      label: SIDE_EFFECT_LABELS[action],
      requirement,
      modeAllowed,
      flagEnabled,
      allowed: Boolean(policy && modeAllowed && flagEnabled),
      blockers
    }];
  }));
}

export function sideEffectFlagEnabled(action) {
  if (action === 'calls') return !!env.live.calls;
  if (action === 'emails') return !!env.live.emails;
  if (action === 'invoices') return !!env.live.payments;
  if (action === 'browserSessions') return !!env.live.browserSessions;
  if (action === 'publicOutreach') return !!env.outreach.enabled && !!env.live.publicOutreach;
  if (action === 'builds') return !!env.live.builds;
  return false;
}

export function envNameForSideEffect(action) {
  if (action === 'calls') return 'LIVE_CALLS';
  if (action === 'emails') return 'LIVE_EMAILS';
  if (action === 'invoices') return 'LIVE_PAYMENTS';
  if (action === 'browserSessions') return 'LIVE_BROWSER_SESSIONS';
  if (action === 'publicOutreach') return 'LIVE_PUBLIC_OUTREACH/AUTONOMOUS_OUTREACH_ENABLED';
  if (action === 'builds') return 'LIVE_BUILDS';
  return 'UNKNOWN_SIDE_EFFECT';
}

export function canCallPhone(phone) {
  if (!phone) return false;
  if (!modeAllowsSideEffect('calls') || !env.live.calls) return false;
  if (env.runMode === 'demo_live') return env.allowedPhones.includes(phone);
  return ['autonomous_live', 'production_live'].includes(env.runMode);
}

export function canEmail(email) {
  if (!email) return false;
  if (!modeAllowsSideEffect('emails') || !env.live.emails) return false;
  if (env.runMode === 'demo_live') return env.allowedEmails.includes(email);
  return ['autonomous_live', 'production_live'].includes(env.runMode);
}

export function canPay() {
  return modeAllowsSideEffect('invoices') && env.live.payments && !!env.stripe.secretKey;
}

export function canBuild() {
  return modeAllowsSideEffect('builds') && env.live.builds && !!env.browserUse.apiKey;
}

export function canStartBrowserSession() {
  return modeAllowsSideEffect('browserSessions') && env.live.browserSessions && !!env.browserUse.apiKey;
}

export function canPublicOutreach() {
  return modeAllowsSideEffect('publicOutreach') && env.outreach.enabled;
}
