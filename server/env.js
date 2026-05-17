import 'dotenv/config';

const bool = (v) => v === 'true' || v === '1' || v === 'yes';
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  port: Number(process.env.PORT || 8787),
  publicUrl: process.env.APP_PUBLIC_URL || 'http://localhost:8787',
  dataDir: process.env.DATA_DIR || '.data',
  nodeEnv: process.env.NODE_ENV || 'development',

  runMode: process.env.RUN_MODE || 'mock',
  live: {
    calls: bool(process.env.LIVE_CALLS),
    emails: bool(process.env.LIVE_EMAILS),
    payments: bool(process.env.LIVE_PAYMENTS),
    builds: bool(process.env.LIVE_BUILDS)
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
    sponsors: list(process.env.HACKATHON_SPONSORS || 'Google DeepMind,Stripe,Moss,Browser Use,AgentMail,Supermemory,Sponge')
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

export function canCallPhone(phone) {
  if (!phone) return false;
  if (env.runMode === 'mock' || !env.live.calls) return false;
  if (env.runMode === 'demo_live' || env.runMode === 'live') return env.allowedPhones.includes(phone);
  return env.runMode === 'autonomous_live';
}

export function canEmail(email) {
  if (!email) return false;
  if (env.runMode === 'mock' || !env.live.emails) return false;
  if (env.runMode === 'demo_live') return env.allowedEmails.includes(email);
  return ['live', 'autonomous_live'].includes(env.runMode);
}

export function canPay() {
  return ['live', 'demo_live', 'autonomous_live'].includes(env.runMode) && env.live.payments && env.stripe.secretKey;
}

export function canBuild() {
  return ['live', 'demo_live', 'autonomous_live'].includes(env.runMode) && env.live.builds && env.browserUse.apiKey;
}
