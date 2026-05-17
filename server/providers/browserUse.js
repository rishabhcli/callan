import { BrowserUse } from 'browser-use-sdk/v3';
import { env } from '../env.js';
import { normalizeProviderError, providerConfigured, sideEffectGate, smokeDetail } from './core.js';

const DEFAULT_CREATE_TIMEOUT_MS = 45_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RETRIES = 2;
const PROVIDER = 'browserUse';

const LOVABLE_PROJECT_RE = /\bhttps:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lovable\.app(?:\/[^\s"'<>]*)?/ig;
const AUTH_WALL_RE = /\b(BLOCKED_AUTH|auth(?:entication)? (?:needed|required)|login required|log in|login|sign in|sign-in|signin|continue with (?:google|github|email)|create an account|session expired)\b/i;

export function browserUseConfigured(config = env.browserUse) {
  return providerConfigured({ BROWSER_USE_API_KEY: config.apiKey });
}

export function browserUseReadinessDetails(config = env.browserUse) {
  const configured = browserUseConfigured(config);
  return {
    configured: configured.configured,
    missing: configured.missing,
    baseUrl: config.baseUrl || 'https://api.browser-use.com/api/v3',
    mode: 'cloud_agent_session',
    lovable: {
      buildWithUrl: 'https://lovable.dev/?prompt=<encoded>',
      authWall: 'blocked_auth_event',
      projectUrlExtraction: '.lovable.app'
    },
    profileId: process.env.BROWSER_USE_PROFILE_ID ? 'configured' : 'default',
    sessionPolicy: env.smoke.browserUse ? 'smoke_can_create_stop_session' : 'no_session_side_effects_without_SMOKE_BROWSER_USE',
    navigationSmoke: browserUseLovableNavigationSmokeEnabled() ? 'enabled' : 'disabled_by_default'
  };
}

export function classifyBrowserUseFailure(err) {
  const normalized = normalizeProviderError(err);
  const msg = String(normalized.message || '').toLowerCase();
  const status = Number(normalized.status || 0) || null;
  const code = String(normalized.code || '').toLowerCase();

  let category = 'unknown';
  let retryable = normalized.retryable;
  if (detectLovableAuthWall(err) || /\bblocked_auth|login required|sign in\b/.test(msg)) {
    category = 'blocked-auth';
    retryable = false;
  } else if (status === 401 || status === 403 || /\b(auth|unauthorized|forbidden|api key|token)\b/.test(msg)) {
    category = 'auth';
    retryable = false;
  } else if (/\b(max cost|budget|insufficient credits)\b/.test(msg)) {
    category = 'budget-exhausted';
    retryable = false;
  } else if (status === 429 || /\b(rate.?limit|too many requests|quota|credits|cost)\b/.test(msg)) {
    category = 'rate-limited';
    retryable = true;
  } else if (/\b(timeout|timed out|abort)\b/.test(msg) || code === 'timeout') {
    category = 'timeout';
    retryable = true;
  } else if (/\b(fetch failed|network|econn|enotfound|etimedout|socket)\b/.test(msg)) {
    category = 'network';
    retryable = true;
  } else if (status && status >= 500) {
    category = 'provider-error';
    retryable = true;
  } else if (status && status >= 400) {
    category = 'provider-rejected';
    retryable = false;
  }

  return {
    ...normalized,
    category,
    outcome: `failed:${category}`,
    retryable: retryable ?? true
  };
}

export function createLovablePromptUrl(brief) {
  return `https://lovable.dev/?prompt=${encodeURIComponent(brief)}`;
}

export function browserUseLovableNavigationSmokeEnabled() {
  return bool(process.env.BROWSER_USE_LOVABLE_NAV_SMOKE) || bool(process.env.SMOKE_LOVABLE_NAVIGATION);
}

export function extractLovableAppUrl(value) {
  const text = searchableText(value);
  const matches = [...text.matchAll(LOVABLE_PROJECT_RE)].map((m) => cleanUrl(m[0]));
  return matches.find(Boolean) || null;
}

export function detectLovableAuthWall(value) {
  if (isUserMessage(value)) return null;

  const text = searchableText(value);
  if (!text) return null;
  if (/\bBLOCKED_AUTH\b/i.test(text)) return { reason: 'agent_reported_blocked_auth' };

  if (!AUTH_WALL_RE.test(text)) return null;
  return { reason: 'lovable_login_required' };
}

export function normalizeBrowserUseProgress(message, { phase } = {}) {
  const dataSummary = summarizeData(message?.data);
  const summary = firstString(message?.summary, dataSummary, message?.text, message?.message, message?.type);
  if (!summary) return null;

  return {
    kind: 'progress',
    phase: phase || 'browser_use',
    provider: 'browserUse',
    messageId: message?.id || null,
    providerType: message?.type || null,
    role: message?.role || null,
    summary: truncate(summary, 360),
    screenshotUrl: message?.screenshotUrl || null,
    providerTs: message?.createdAt || null
  };
}

export class BrowserUseLovableAdapter {
  constructor({
    apiKey = env.browserUse.apiKey,
    baseUrl = env.browserUse.baseUrl,
    model = process.env.BROWSER_USE_MODEL || undefined,
    profileId = process.env.BROWSER_USE_PROFILE_ID || undefined,
    maxCostUsd = process.env.BROWSER_USE_MAX_COST_USD || undefined,
    proxyCountryCode = process.env.BROWSER_USE_PROXY_COUNTRY || undefined,
    useOwnKey = bool(process.env.BROWSER_USE_USE_OWN_KEY),
    enableRecording = bool(process.env.BROWSER_USE_ENABLE_RECORDING),
    createTimeoutMs = numberEnv('BROWSER_USE_CREATE_TIMEOUT_MS', DEFAULT_CREATE_TIMEOUT_MS),
    stopTimeoutMs = numberEnv('BROWSER_USE_STOP_TIMEOUT_MS', DEFAULT_STOP_TIMEOUT_MS),
    runTimeoutMs = numberEnv('BROWSER_USE_RUN_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS),
    smokeTimeoutMs = numberEnv('BROWSER_USE_SMOKE_TIMEOUT_MS', DEFAULT_SMOKE_TIMEOUT_MS),
    pollIntervalMs = numberEnv('BROWSER_USE_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
    retries = numberEnv('BROWSER_USE_RETRIES', DEFAULT_RETRIES)
  } = {}) {
    this.client = new BrowserUse({
      apiKey,
      baseUrl,
      maxRetries: retries,
      timeout: numberEnv('BROWSER_USE_HTTP_TIMEOUT_MS', 30_000),
      useOwnKey
    });
    this.model = model;
    this.profileId = profileId;
    this.maxCostUsd = maxCostUsd;
    this.proxyCountryCode = proxyCountryCode ? proxyCountryCode.toLowerCase() : undefined;
    this.enableRecording = enableRecording;
    this.createTimeoutMs = createTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.runTimeoutMs = runTimeoutMs;
    this.smokeTimeoutMs = smokeTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.retries = retries;
  }

  async createSession({ keepAlive = true } = {}) {
    const body = compact({
      keepAlive,
      model: this.model,
      profileId: this.profileId,
      maxCostUsd: this.maxCostUsd,
      proxyCountryCode: this.proxyCountryCode,
      enableRecording: this.enableRecording,
      enableScheduledTasks: false,
      agentmail: false,
      skills: false,
      codeMode: false
    });

    const session = await retry(
      () => withTimeout(this.client.sessions.create(body), this.createTimeoutMs, 'browser-use session create timed out'),
      { label: 'browser-use session create', retries: this.retries }
    );

    return normalizeSession(session);
  }

  async *smokeLovableNavigation({ sessionId }) {
    const task = this.client.run(
      [
        'Open https://lovable.dev in this existing browser session.',
        'This is only a navigation smoke test. Do not sign in, do not create a project, and do not submit a prompt.',
        'If a login, sign-in, or account wall blocks the page, answer exactly BLOCKED_AUTH.',
        'If the page loads, answer exactly NAV_OK.'
      ].join(' '),
      this.runOptions({ sessionId, timeoutMs: this.smokeTimeoutMs })
    );

    for await (const message of task) {
      const progress = normalizeBrowserUseProgress(message, { phase: 'navigation_smoke' });
      if (progress) yield progress;

      const auth = detectLovableAuthWall(message);
      if (auth) {
        await this.stopTask(sessionId);
        yield { kind: 'blocked_auth', phase: 'navigation_smoke', ...auth };
        return;
      }
    }

    const result = task.result;
    const auth = detectLovableAuthWall(result);
    if (auth) {
      yield { kind: 'blocked_auth', phase: 'navigation_smoke', ...auth };
      return;
    }

    yield {
      kind: 'progress',
      phase: 'navigation_smoke',
      provider: 'browserUse',
      summary: 'Lovable navigation smoke completed.'
    };
  }

  async *submitLovablePrompt({ sessionId, lovableUrl, brief }) {
    const task = this.client.run(
      buildLovableSubmissionTask({ lovableUrl, brief }),
      this.runOptions({ sessionId, timeoutMs: this.runTimeoutMs })
    );

    let projectUrl = null;

    for await (const message of task) {
      const progress = normalizeBrowserUseProgress(message, { phase: 'lovable_build' });
      if (progress) yield progress;

      const auth = detectLovableAuthWall(message);
      if (auth) {
        await this.stopTask(sessionId);
        yield { kind: 'blocked_auth', phase: 'lovable_build', ...auth };
        return;
      }

      const foundUrl = extractLovableAppUrl(message);
      if (foundUrl && foundUrl !== projectUrl) {
        projectUrl = foundUrl;
        yield { kind: 'project_url', phase: 'lovable_build', projectUrl };
      }
    }

    const result = task.result;
    const auth = detectLovableAuthWall(result);
    if (auth) {
      yield { kind: 'blocked_auth', phase: 'lovable_build', ...auth };
      return;
    }

    const finalUrl = projectUrl || extractLovableAppUrl(result);
    if (finalUrl && finalUrl !== projectUrl) {
      projectUrl = finalUrl;
      yield { kind: 'project_url', phase: 'lovable_build', projectUrl };
    }

    yield {
      kind: 'done',
      phase: 'lovable_build',
      projectUrl,
      successful: result?.isTaskSuccessful ?? null,
      summary: result?.lastStepSummary || (projectUrl ? 'Lovable build completed.' : 'Lovable task completed without a project URL.'),
      output: truncate(searchableText(result?.output), 1_000)
    };
  }

  async stopTask(sessionId) {
    if (!sessionId) return;
    await retry(
      () => withTimeout(this.client.sessions.stop(sessionId, { strategy: 'task' }), this.stopTimeoutMs, 'browser-use task stop timed out'),
      { label: 'browser-use task stop', retries: 1 }
    ).catch(() => null);
  }

  async stopSession(sessionId) {
    if (!sessionId) return;
    await retry(
      () => withTimeout(this.client.sessions.stop(sessionId, { strategy: 'session' }), this.stopTimeoutMs, 'browser-use session stop timed out'),
      { label: 'browser-use session stop', retries: 1 }
    );
  }

  runOptions({ sessionId, timeoutMs }) {
    return compact({
      sessionId,
      keepAlive: true,
      model: this.model,
      maxCostUsd: this.maxCostUsd,
      enableRecording: this.enableRecording,
      enableScheduledTasks: false,
      agentmail: false,
      skills: false,
      codeMode: false,
      timeout: timeoutMs,
      interval: this.pollIntervalMs
    });
  }
}

export async function smokeBrowserUseSession({ config = env.browserUse } = {}) {
  const configured = browserUseConfigured(config);
  if (!configured.configured) {
    return { provider: PROVIDER, status: 'missing', detail: smokeDetail({ skipped: configured.missing.join(', ') }) };
  }

  const gate = sideEffectGate({
    provider: PROVIDER,
    action: 'cloud session smoke',
    enabled: env.smoke.browserUse,
    details: { toggle: 'SMOKE_BROWSER_USE' }
  });
  if (!gate.ok) {
    return { provider: PROVIDER, status: 'configured', detail: smokeDetail({ skipped: gate.reason, extra: gate.details }) };
  }

  const adapter = new BrowserUseLovableAdapter({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl
  });
  const session = await adapter.createSession({ keepAlive: false });
  if (!session.sessionId) throw new Error('Browser Use session create returned no id');
  try {
    await adapter.stopSession(session.sessionId);
  } catch {}
  return {
    provider: PROVIDER,
    status: 'ok',
    detail: smokeDetail({
      dryRun: false,
      live: true,
      extra: { sessionId: session.sessionId, liveUrl: session.liveUrl || null }
    })
  };
}

function buildLovableSubmissionTask({ lovableUrl, brief }) {
  return [
    'You are submitting a paid customer website build to Lovable.',
    `Open this exact URL: ${lovableUrl}`,
    'If the build-with-prompt flow does not start, paste the full brief below into Lovable and submit it.',
    'If Lovable shows any login, sign-in, account, Google/GitHub OAuth, or authentication wall, stop immediately and answer exactly BLOCKED_AUTH.',
    'While Lovable works, keep the session on the build page and report concise progress.',
    'When a final published .lovable.app URL is visible, copy it exactly.',
    'Your final answer must include either "PROJECT_URL: https://...lovable.app" or "BLOCKED_AUTH".',
    '',
    'Brief:',
    brief
  ].join('\n');
}

function normalizeSession(session) {
  return {
    sessionId: session?.id,
    liveUrl: session?.liveUrl || null,
    raw: session
  };
}

async function retry(fn, { label, retries }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = classifyBrowserUseFailure(err);
      if (attempt >= retries || lastError.retryable === false) break;
      await delay(Math.min(1_000 * 2 ** attempt, 5_000));
    }
  }
  const wrapped = new Error(`${label} failed: ${lastError?.message || 'provider request failed'}`);
  Object.assign(wrapped, lastError, { provider: PROVIDER });
  throw wrapped;
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function searchableText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeStringify(value);
}

function summarizeData(data) {
  if (!data) return null;
  if (typeof data !== 'string') return searchableText(data);
  try {
    const parsed = JSON.parse(data);
    return firstString(parsed?.summary, parsed?.text, parsed?.message, parsed?.url, parsed?.title, data);
  } catch {
    return data;
  }
}

function isUserMessage(value) {
  if (!value || typeof value !== 'object') return false;
  return value.role === 'human' || value.type === 'user_message';
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function cleanUrl(url) {
  return String(url || '').replace(/[.,;:!?'"`)\]}>\s]+$/g, '');
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== 'object' || nested === null) return nested;
      if (seen.has(nested)) return '[Circular]';
      seen.add(nested);
      return nested;
    });
  } catch {
    return String(value);
  }
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
