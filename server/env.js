import 'dotenv/config';

const bool = (v) => v === 'true' || v === '1' || v === 'yes';
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

/**
 * Parse "email:phone,email:phone" into a lowercased {email→phone} map. Used by
 * the "call me" email handler to look up the sender's phone when their email
 * is on file. Whitespace around tokens is trimmed.
 */
function parseEmailPhoneMap(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of String(raw).split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf(':');
    if (idx <= 0) continue;
    const email = trimmed.slice(0, idx).trim().toLowerCase();
    const phone = trimmed.slice(idx + 1).trim();
    if (email && phone) out[email] = phone;
  }
  return out;
}
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
  admin: {
    apiToken: process.env.ADMIN_API_TOKEN || ''
  },

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
    lovableNavigation: bool(process.env.SMOKE_LOVABLE_NAVIGATION),
    testPhone: process.env.SMOKE_TEST_PHONE || '',
    testEmail: process.env.SMOKE_TEST_EMAIL || ''
  },
  allowedPhones: list(process.env.ALLOWED_TARGET_PHONES),
  allowedEmails: list(process.env.ALLOWED_TARGET_EMAILS),
  // email→phone map for the "call me" email handler. Format:
  //   CALLBACK_PHONE_BY_EMAIL=river.beach@icloud.com:+15109530626,other@x.com:+14155551234
  // Used in server/emailCallback.js to look up the sender's phone when their
  // email is on file, so they don't have to include a number in the body.
  callbackPhoneByEmail: parseEmailPhoneMap(process.env.CALLBACK_PHONE_BY_EMAIL),
  // Generic "default" fallback if neither sender lookup nor body parsing finds a phone.
  defaultCallbackPhone: (process.env.DEMO_CALLBACK_PHONE || '').trim(),
  outreach: {
    enabled: bool(process.env.AUTONOMOUS_OUTREACH_ENABLED),
    intervalMs: num(process.env.OUTREACH_INTERVAL_MS, 15000),
    batchSize: num(process.env.OUTREACH_BATCH_SIZE, 3),
    maxAttemptsPerPhone: num(process.env.MAX_ATTEMPTS_PER_PHONE, 1),
    quietHoursStart: num(process.env.QUIET_HOURS_START, 20),
    quietHoursEnd: num(process.env.QUIET_HOURS_END, 9),
    timezone: process.env.OUTREACH_TIMEZONE || 'America/Los_Angeles'
  },

  accountManager: {
    enabled: process.env.ACCOUNT_MANAGER_ENABLED === undefined && process.env.AFTERCARE_ENABLED === undefined
      ? true
      : bool(process.env.ACCOUNT_MANAGER_ENABLED || process.env.AFTERCARE_ENABLED),
    dryRun: !bool(process.env.ACCOUNT_MANAGER_LIVE_SENDS),
    intervalMs: num(process.env.ACCOUNT_MANAGER_INTERVAL_MS, 60_000),
    frequencyCapHours: num(process.env.ACCOUNT_MANAGER_FREQUENCY_CAP_HOURS, 120),
    previewCapHours: num(process.env.ACCOUNT_MANAGER_PREVIEW_CAP_HOURS, 6),
    timezone: process.env.ACCOUNT_MANAGER_TIMEZONE || process.env.OUTREACH_TIMEZONE || 'America/Los_Angeles'
  },

  ops: {
    safeToSellCheckEnabled: process.env.SAFE_TO_SELL_SELF_CHECK_ENABLED !== 'false',
    safeToSellCheckIntervalMs: num(process.env.SAFE_TO_SELL_SELF_CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000),
    backupEnabled: process.env.OPS_BACKUP_ENABLED !== 'false',
    backupIntervalMs: num(process.env.OPS_BACKUP_INTERVAL_MS, 12 * 60 * 60 * 1000),
    providerPostureEnabled: process.env.OPS_PROVIDER_POSTURE_ENABLED !== 'false',
    providerPostureIntervalMs: num(process.env.OPS_PROVIDER_POSTURE_INTERVAL_MS, 6 * 60 * 60 * 1000),
    recoveryEnabled: process.env.OPS_RECOVERY_ENABLED !== 'false',
    recoveryIntervalMs: num(process.env.OPS_RECOVERY_INTERVAL_MS, 5 * 60 * 1000),
    recoveryMaxCallAgeMs: num(process.env.OPS_RECOVERY_MAX_CALL_AGE_MS, 45 * 60 * 1000),
    recoveryMaxScheduledCallAgeMs: num(process.env.OPS_RECOVERY_MAX_SCHEDULED_CALL_AGE_MS, 60 * 1000),
    recoveryMaxBuildAgeMs: num(process.env.OPS_RECOVERY_MAX_BUILD_AGE_MS, 10 * 60 * 1000),
    economicsMaxDailyCostUsd: num(process.env.OPS_MAX_DAILY_COST_USD, 25),
    economicsMaxDailyLossUsd: num(process.env.OPS_MAX_DAILY_LOSS_USD, 25),
    economicsMinMarginPct: num(process.env.OPS_MIN_MARGIN_PCT, 20),
    providerMaxIssueRatePct: num(process.env.OPS_PROVIDER_MAX_ISSUE_RATE_PCT, 20),
    providerMinEventsForIssueRate: num(process.env.OPS_PROVIDER_MIN_EVENTS_FOR_ISSUE_RATE, 3),
    providerMaxAvgLatencyMs: num(process.env.OPS_PROVIDER_MAX_AVG_LATENCY_MS, 15_000),
    workerMaxFailuresPer24h: num(process.env.OPS_WORKER_MAX_FAILURES_24H, 3),
    workerMaxFailureRatePct: num(process.env.OPS_WORKER_MAX_FAILURE_RATE_PCT, 25),
    workerMinRunsForFailureRate: num(process.env.OPS_WORKER_MIN_RUNS_FOR_FAILURE_RATE, 4),
    jobMaxIssuesPer24h: num(process.env.OPS_JOB_MAX_ISSUES_24H, 5)
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
  },

  customerCommerce: {
    sandboxLinks: bool(process.env.CUSTOMER_COMMERCE_SANDBOX_LINKS),
    liveStripeLinks: bool(process.env.CUSTOMER_COMMERCE_LIVE_STRIPE_LINKS),
    stripeAccountId: process.env.CUSTOMER_COMMERCE_STRIPE_ACCOUNT_ID || ''
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

/**
 * Add a phone number to the in-memory allow list at runtime. Used when a
 * customer explicitly emails asking for a callback — the request itself is
 * consent under TCPA-friendly express-invitation rules, so we let them
 * through `demo_live`'s `ALLOWED_TARGET_PHONES` gate without an operator
 * having to edit `.env`. Pushes both the raw input and an E.164-normalized
 * form because different call sites check different shapes.
 *
 * Returns true if a new entry was added.
 */
export function seedAllowedPhone(phone) {
  if (!phone) return false;
  const inputs = [];
  const raw = String(phone).trim();
  if (raw) inputs.push(raw);
  const digits = raw.replace(/\D/g, '');
  if (digits) {
    let e164;
    if (raw.startsWith('+')) e164 = '+' + digits;
    else if (digits.length === 11 && digits.startsWith('1')) e164 = '+' + digits;
    else if (digits.length === 10) e164 = '+1' + digits;
    else e164 = '+' + digits;
    if (!inputs.includes(e164)) inputs.push(e164);
  }
  let added = false;
  for (const candidate of inputs) {
    if (!env.allowedPhones.includes(candidate)) {
      env.allowedPhones.push(candidate);
      added = true;
    }
  }
  return added;
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
