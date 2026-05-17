import { BrowserUse } from 'browser-use-sdk/v3';
import { env } from '../env.js';
import { emit } from '../sse.js';
import { normalizeProviderError, providerConfigured, sideEffectGate, smokeDetail } from './core.js';
import {
  buildLovableSubmissionTask as buildLovableTargetSubmissionTask,
  createLovablePromptUrl as createLovableTargetPromptUrl,
  detectLovableAuthWall as detectLovableTargetAuthWall,
  extractLovableAppUrl as extractLovableTargetAppUrl
} from './lovable.js';

const DEFAULT_CREATE_TIMEOUT_MS = 45_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_GET_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_RETRIES = 2;
const PROVIDER = 'browserUse';
const DEFAULT_RESEARCH_MAX_COST_USD = '0.35';
const BROWSER_USE_MODELS = new Set([
  'bu-mini',
  'bu-max',
  'bu-ultra',
  'gemini-3-flash',
  'claude-sonnet-4.6',
  'claude-opus-4.6',
  'claude-opus-4.7',
  'gpt-5.4-mini'
]);
const TERMINAL_STATUSES = new Set(['stopped', 'timed_out', 'error']);

const LOVABLE_PROJECT_RE = /\bhttps:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lovable\.app(?:\/[^\s"'<>]*)?/ig;
const AUTH_WALL_RE = /\b(BLOCKED_AUTH|auth(?:entication)? (?:needed|required)|login required|log in|login|sign in|sign-in|signin|continue with (?:google|github|email)|create an account|session expired)\b/i;
const CLAIM_PATTERNS = [
  { code: 'online_booking', pattern: /\b(book online|online booking|schedule online|appointment booking|booking system)\b/i },
  { code: 'online_payment', pattern: /\b(pay online|online payment|checkout|deposit|financing|payment plan)\b/i },
  { code: 'guarantee', pattern: /\b(guaranteed|satisfaction guarantee|money back)\b/i },
  { code: 'license_or_insurance', pattern: /\b(licensed|insured|bonded)\b/i },
  { code: 'reviews_or_awards', pattern: /\b(5[- ]?star|five[- ]?star|award[- ]winning|best rated|top rated)\b/i },
  { code: 'same_day_or_emergency', pattern: /\b(same[- ]day|24\/7|24-7|emergency service)\b/i }
];

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
      buildWithUrl: 'https://lovable.dev/?autosubmit=true#prompt=<encoded>',
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
  return createLovableTargetPromptUrl(brief);
}

export function browserUseLovableNavigationSmokeEnabled() {
  return bool(process.env.BROWSER_USE_LOVABLE_NAV_SMOKE) || bool(process.env.SMOKE_LOVABLE_NAVIGATION);
}

export function browserUseSiteInspectionEnabled() {
  return bool(process.env.BUILDER_QA_BROWSER_USE) || bool(process.env.SMOKE_BUILDER_QA_BROWSER_USE);
}

export function extractLovableAppUrl(value) {
  return extractLovableTargetAppUrl(value);
}

export function detectLovableAuthWall(value) {
  return detectLovableTargetAuthWall(value);
}

export function normalizeBrowserUseProgress(message, { phase } = {}) {
  const session = normalizeBrowserUseSessionSnapshot(message);
  const dataSummary = summarizeData(message?.data);
  const summary = firstString(message?.summary, session.lastStepSummary, dataSummary, message?.text, message?.message, message?.type);
  if (!summary) return null;

  return {
    kind: 'progress',
    phase: phase || 'browser_use',
    provider: 'browserUse',
    sessionId: session.sessionId,
    model: session.model,
    status: session.status,
    messageId: message?.id || null,
    providerType: message?.type || null,
    role: message?.role || null,
    summary: truncate(summary, 360),
    liveUrl: session.liveUrl,
    screenshotUrl: session.screenshotUrl,
    recordingUrls: session.recordingUrls,
    output: session.output == null ? null : truncate(searchableText(session.output), 1_000),
    outputSchema: session.outputSchema,
    stepCount: session.stepCount,
    lastStepSummary: session.lastStepSummary,
    isTaskSuccessful: session.isTaskSuccessful,
    maxCostUsd: session.maxCostUsd,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    proxyUsedMb: session.proxyUsedMb,
    llmCostUsd: session.llmCostUsd,
    proxyCostUsd: session.proxyCostUsd,
    browserCostUsd: session.browserCostUsd,
    totalCostUsd: session.totalCostUsd,
    agentmailEmail: session.agentmailEmail,
    integrationsUsed: session.integrationsUsed,
    providerTs: message?.createdAt || session.createdAt || null
  };
}

export async function inspectGeneratedSite({ url, html, brief, lead, mock = false, timeoutMs = numberEnv('BUILDER_QA_FETCH_TIMEOUT_MS', 10_000) }) {
  const startedAt = Date.now();
  let sourceHtml = html || null;
  let fetchError = null;
  const inspectedUrl = absolutizeUrl(url);

  if (!sourceHtml && inspectedUrl) {
    try {
      sourceHtml = await fetchText(inspectedUrl, timeoutMs);
    } catch (err) {
      fetchError = err?.message || String(err);
    }
  }

  const visibleText = visibleTextFromHtml(sourceHtml || '');
  const checklist = [
    checkBusinessName({ visibleText, brief, lead }),
    checkPhone({ visibleText, html: sourceHtml, brief, lead }),
    checkServices({ visibleText, brief }),
    checkCta({ visibleText, html: sourceHtml, brief }),
    checkMobile({ html: sourceHtml }),
    checkHallucinatedClaims({ visibleText, brief })
  ];

  if (fetchError) {
    checklist.unshift({
      key: 'fetch_generated_url',
      label: 'Generated URL reachable',
      passed: false,
      severity: 'blocker',
      detail: fetchError
    });
  }

  const errors = checklist.filter((item) => !item.passed).map((item) => item.key);
  const passed = errors.length === 0;
  const score = Math.round((checklist.filter((item) => item.passed).length / checklist.length) * 100);

  return {
    provider: html ? 'html' : 'fetch',
    url: inspectedUrl || url || null,
    mock,
    passed,
    status: passed ? 'passed' : 'failed',
    score,
    checklist,
    errors,
    warnings: checklist.filter((item) => !item.passed && item.severity !== 'blocker').map((item) => item.key),
    claims: claimReport(visibleText),
    mobile: {
      viewportMeta: /<meta[^>]+name=["']viewport["'][^>]*>/i.test(sourceHtml || ''),
      responsiveHint: /width=device-width|@media|\bclamp\(|max-width:\s*100%/i.test(sourceHtml || '')
    },
    inspectedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    visibleTextSample: truncate(visibleText, 700)
  };
}

export function modelSelectionPolicy({
  sourceType = 'search',
  requestedModel,
  strongModel = process.env.BROWSER_USE_RESEARCH_STRONG_MODEL || process.env.BROWSER_USE_STRONG_MODEL || 'bu-max',
  cheapModel = process.env.BROWSER_USE_RESEARCH_MODEL || process.env.BROWSER_USE_MODEL || 'bu-mini',
  ambiguous = false
} = {}) {
  const requested = validBrowserUseModel(requestedModel);
  if (requested) return requested;

  const needsStrongerModel = ambiguous || sourceType === 'website';
  if (needsStrongerModel) return validBrowserUseModel(strongModel) || 'bu-max';
  return validBrowserUseModel(cheapModel) || 'bu-mini';
}

export function normalizeSessionStatus(session = {}) {
  const providerStatus = String(session.status || 'unknown');
  const hasOutput = session.output !== undefined && session.output !== null;
  const successful = session.isTaskSuccessful === undefined ? null : session.isTaskSuccessful;
  let state = providerStatus;

  if (providerStatus === 'created') state = 'starting';
  if (providerStatus === 'running') state = 'running';
  if (providerStatus === 'idle') state = hasOutput || successful !== null ? 'completed' : 'idle';
  if (providerStatus === 'stopped') state = hasOutput || successful === true ? 'completed' : 'stopped';
  if (providerStatus === 'timed_out') state = 'timed_out';
  if (providerStatus === 'error' || successful === false) state = 'failed';

  return {
    providerStatus,
    state,
    terminal: TERMINAL_STATUSES.has(providerStatus) || state === 'completed' || state === 'failed',
    successful,
    stepCount: Number(session.stepCount || 0),
    lastStepSummary: session.lastStepSummary || null,
    liveUrl: session.liveUrl || null
  };
}

export function normalizeCostAndTokenUsage(session = {}) {
  return {
    totalInputTokens: numberOrZero(session.totalInputTokens),
    totalOutputTokens: numberOrZero(session.totalOutputTokens),
    proxyUsedMb: numberOrZero(session.proxyUsedMb),
    llmCostUsd: numberOrZero(session.llmCostUsd),
    proxyCostUsd: numberOrZero(session.proxyCostUsd),
    browserCostUsd: numberOrZero(session.browserCostUsd),
    totalCostUsd: numberOrZero(session.totalCostUsd),
    maxCostUsd: session.maxCostUsd == null ? null : String(session.maxCostUsd)
  };
}

export class BrowserUseCloudAdapter {
  constructor({
    apiKey = env.browserUse.apiKey,
    baseUrl = env.browserUse.baseUrl,
    profileId = process.env.BROWSER_USE_PROFILE_ID || undefined,
    workspaceId = process.env.BROWSER_USE_WORKSPACE_ID || undefined,
    proxyCountryCode = process.env.BROWSER_USE_PROXY_COUNTRY || undefined,
    useOwnKey = bool(process.env.BROWSER_USE_USE_OWN_KEY),
    enableRecording = bool(process.env.BROWSER_USE_ENABLE_RECORDING),
    createTimeoutMs = numberEnv('BROWSER_USE_CREATE_TIMEOUT_MS', DEFAULT_CREATE_TIMEOUT_MS),
    getTimeoutMs = numberEnv('BROWSER_USE_GET_TIMEOUT_MS', DEFAULT_GET_TIMEOUT_MS),
    stopTimeoutMs = numberEnv('BROWSER_USE_STOP_TIMEOUT_MS', DEFAULT_STOP_TIMEOUT_MS),
    retries = numberEnv('BROWSER_USE_RETRIES', DEFAULT_RETRIES),
    eventWorker = 'browser_research'
  } = {}) {
    this.client = new BrowserUse({
      apiKey,
      baseUrl,
      maxRetries: retries,
      timeout: numberEnv('BROWSER_USE_HTTP_TIMEOUT_MS', 30_000),
      useOwnKey
    });
    this.profileId = profileId;
    this.workspaceId = workspaceId;
    this.proxyCountryCode = proxyCountryCode ? proxyCountryCode.toLowerCase() : undefined;
    this.enableRecording = enableRecording;
    this.createTimeoutMs = createTimeoutMs;
    this.getTimeoutMs = getTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.retries = retries;
    this.eventWorker = eventWorker;
  }

  async createSessionAndRunTask({
    task,
    sourceType,
    model,
    outputSchema,
    keepAlive = false,
    maxCostUsd = process.env.BROWSER_USE_RESEARCH_MAX_COST_USD || DEFAULT_RESEARCH_MAX_COST_USD,
    profileId = this.profileId,
    workspaceId = this.workspaceId,
    proxyCountryCode = this.proxyCountryCode,
    ambiguous = false
  } = {}) {
    if (!task) throw new Error('Browser Use task is required');
    const selectedModel = modelSelectionPolicy({ sourceType, requestedModel: model, ambiguous });
    const body = compact({
      task,
      model: selectedModel,
      keepAlive,
      maxCostUsd,
      profileId,
      workspaceId,
      proxyCountryCode,
      outputSchema,
      enableScheduledTasks: false,
      enableRecording: this.enableRecording,
      agentmail: false,
      codeMode: false,
      skills: true
    });
    this.emitProviderAction('create_session_and_run_task', { sourceType, model: selectedModel, keepAlive, maxCostUsd });
    const session = await retry(
      () => withTimeout(this.client.sessions.create(body), this.createTimeoutMs, 'browser-use session task create timed out'),
      { label: 'browser-use session task create', retries: this.retries }
    );
    return this.normalizeSession(session, { sourceType, model: selectedModel });
  }

  async dispatchTaskToExistingSession(sessionId, {
    task,
    sourceType,
    model,
    outputSchema,
    keepAlive = true,
    maxCostUsd = process.env.BROWSER_USE_RESEARCH_MAX_COST_USD || DEFAULT_RESEARCH_MAX_COST_USD,
    ambiguous = false
  } = {}) {
    if (!sessionId) throw new Error('Browser Use sessionId is required');
    if (!task) throw new Error('Browser Use task is required');
    const selectedModel = modelSelectionPolicy({ sourceType, requestedModel: model, ambiguous });
    const body = compact({
      sessionId,
      task,
      model: selectedModel,
      keepAlive,
      maxCostUsd,
      outputSchema,
      enableScheduledTasks: false,
      enableRecording: this.enableRecording,
      agentmail: false,
      codeMode: false,
      skills: true
    });
    this.emitProviderAction('dispatch_task_to_existing_session', { sessionId, sourceType, model: selectedModel, keepAlive, maxCostUsd });
    const session = await retry(
      () => withTimeout(this.client.sessions.create(body), this.createTimeoutMs, 'browser-use existing session dispatch timed out'),
      { label: 'browser-use existing session dispatch', retries: this.retries }
    );
    return this.normalizeSession(session, { sourceType, model: selectedModel });
  }

  async getSession(sessionId, { sourceType } = {}) {
    if (!sessionId) throw new Error('Browser Use sessionId is required');
    this.emitProviderAction('get_session', { sessionId, sourceType });
    const session = await retry(
      () => withTimeout(this.client.sessions.get(sessionId), this.getTimeoutMs, 'browser-use session get timed out'),
      { label: 'browser-use session get', retries: this.retries }
    );
    return this.normalizeSession(session, { sourceType });
  }

  async stopSession(sessionId, { strategy = 'session', sourceType } = {}) {
    if (!sessionId) return null;
    this.emitProviderAction('stop_session', { sessionId, sourceType, strategy });
    const session = await retry(
      () => withTimeout(this.client.sessions.stop(sessionId, { strategy }), this.stopTimeoutMs, 'browser-use session stop timed out'),
      { label: 'browser-use session stop', retries: 1 }
    );
    return this.normalizeSession(session, { sourceType });
  }

  normalizeSession(session, extra = {}) {
    const status = normalizeSessionStatus(session);
    const usage = normalizeCostAndTokenUsage(session);
    return {
      sessionId: session?.id || extra.sessionId || null,
      model: session?.model || extra.model || null,
      liveUrl: status.liveUrl,
      status,
      usage,
      output: session?.output ?? null,
      outputSchema: session?.outputSchema || null,
      raw: session,
      ...extra
    };
  }

  emitProviderAction(action, data = {}) {
    emit(`provider.${PROVIDER}.${action}`, {
      worker: this.eventWorker,
      provider: PROVIDER,
      action,
      ...data
    });
  }
}

export function normalizeBrowserUseSessionSnapshot(session, fallback = {}) {
  const raw = session?.raw && (session.sessionId || session.id)
    ? { ...session.raw, id: session.sessionId || session.id, liveUrl: session.liveUrl || session.raw?.liveUrl }
    : (session || {});
  const output = raw.output ?? fallback.output ?? null;

  return {
    provider: 'browserUse',
    sessionId: raw.id || raw.sessionId || fallback.sessionId || null,
    status: raw.status || fallback.status || null,
    model: raw.model || fallback.model || process.env.BROWSER_USE_MODEL || null,
    title: raw.title || fallback.title || null,
    output,
    outputSchema: raw.outputSchema || fallback.outputSchema || null,
    stepCount: numberOr(raw.stepCount, fallback.stepCount, 0),
    lastStepSummary: firstString(raw.lastStepSummary, fallback.lastStepSummary),
    isTaskSuccessful: raw.isTaskSuccessful ?? fallback.isTaskSuccessful ?? null,
    liveUrl: raw.liveUrl || fallback.liveUrl || null,
    recordingUrls: arrayOr(raw.recordingUrls, fallback.recordingUrls),
    profileId: raw.profileId || fallback.profileId || null,
    workspaceId: raw.workspaceId || fallback.workspaceId || null,
    proxyCountryCode: raw.proxyCountryCode || fallback.proxyCountryCode || null,
    maxCostUsd: stringOr(raw.maxCostUsd, fallback.maxCostUsd),
    totalInputTokens: numberOr(raw.totalInputTokens, fallback.totalInputTokens, 0),
    totalOutputTokens: numberOr(raw.totalOutputTokens, fallback.totalOutputTokens, 0),
    proxyUsedMb: stringOr(raw.proxyUsedMb, fallback.proxyUsedMb, '0'),
    llmCostUsd: stringOr(raw.llmCostUsd, fallback.llmCostUsd, '0'),
    proxyCostUsd: stringOr(raw.proxyCostUsd, fallback.proxyCostUsd, '0'),
    browserCostUsd: stringOr(raw.browserCostUsd, fallback.browserCostUsd, '0'),
    totalCostUsd: stringOr(raw.totalCostUsd, fallback.totalCostUsd, '0'),
    screenshotUrl: raw.screenshotUrl || fallback.screenshotUrl || null,
    agentmailEmail: raw.agentmailEmail || fallback.agentmailEmail || null,
    integrationsUsed: arrayOr(raw.integrationsUsed, fallback.integrationsUsed),
    createdAt: raw.createdAt || fallback.createdAt || null,
    updatedAt: raw.updatedAt || fallback.updatedAt || null,
    raw
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

    return normalizeBrowserUseSessionSnapshot(session);
  }

  async getSession(sessionId) {
    if (!sessionId) return null;
    const session = await retry(
      () => withTimeout(this.client.sessions.get(sessionId), this.createTimeoutMs, 'browser-use session get timed out'),
      { label: 'browser-use session get', retries: 1 }
    );

    return normalizeBrowserUseSessionSnapshot(session, { sessionId });
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
    const task = this.runTask({
      sessionId,
      task: buildLovableSubmissionTask({ lovableUrl, brief }),
      timeoutMs: this.runTimeoutMs
    });

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

  async *submitLovableRevision({ sessionId, projectUrl, revisionPrompt }) {
    const task = this.runTask({
      sessionId,
      task: buildLovableRevisionTask({ projectUrl, revisionPrompt }),
      timeoutMs: this.runTimeoutMs
    });

    let finalProjectUrl = projectUrl || null;

    for await (const message of task) {
      const progress = normalizeBrowserUseProgress(message, { phase: 'lovable_revision' });
      if (progress) yield progress;

      const auth = detectLovableAuthWall(message);
      if (auth) {
        await this.stopTask(sessionId);
        yield { kind: 'blocked_auth', phase: 'lovable_revision', ...auth };
        return;
      }

      const foundUrl = extractLovableAppUrl(message);
      if (foundUrl && foundUrl !== finalProjectUrl) {
        finalProjectUrl = foundUrl;
        yield { kind: 'project_url', phase: 'lovable_revision', projectUrl: finalProjectUrl };
      }
    }

    const result = await Promise.resolve(task.result);
    const auth = detectLovableAuthWall(result);
    if (auth) {
      yield { kind: 'blocked_auth', phase: 'lovable_revision', ...auth };
      return;
    }

    const foundUrl = extractLovableAppUrl(result);
    if (foundUrl) finalProjectUrl = foundUrl;
    yield {
      kind: 'done',
      phase: 'lovable_revision',
      projectUrl: finalProjectUrl,
      successful: result?.isTaskSuccessful ?? null,
      summary: result?.lastStepSummary || 'Lovable revision task completed.',
      output: truncate(searchableText(result?.output), 1_000)
    };
  }

  async inspectPublishedSite({ sessionId, url, brief }) {
    const task = this.runTask({
      sessionId,
      task: buildSiteInspectionTask({ url, brief }),
      timeoutMs: numberEnv('BUILDER_QA_BROWSER_USE_TIMEOUT_MS', DEFAULT_SMOKE_TIMEOUT_MS)
    });

    let lastSummary = null;
    for await (const message of task) {
      const progress = normalizeBrowserUseProgress(message, { phase: 'site_inspection' });
      if (progress?.summary) lastSummary = progress.summary;
    }

    const result = await Promise.resolve(task.result);
    const raw = searchableText(result?.output || result);
    const parsed = parseLooseJson(raw);
    if (parsed) return normalizeBrowserQa(parsed, { url, lastSummary });

    return {
      provider: 'browserUse',
      url,
      passed: false,
      status: 'failed',
      score: 0,
      checklist: [{
        key: 'browser_use_structured_result',
        label: 'Browser Use structured inspection',
        passed: false,
        severity: 'warn',
        detail: 'Browser Use did not return parseable JSON.'
      }],
      errors: ['browser_use_structured_result'],
      summary: lastSummary || truncate(raw, 300)
    };
  }

  runTask({ sessionId, task, timeoutMs }) {
    return this.client.run(
      task,
      this.runOptions({ sessionId, timeoutMs: timeoutMs || this.runTimeoutMs })
    );
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
    const session = await retry(
      () => withTimeout(this.client.sessions.stop(sessionId, { strategy: 'session' }), this.stopTimeoutMs, 'browser-use session stop timed out'),
      { label: 'browser-use session stop', retries: 1 }
    );
    return normalizeBrowserUseSessionSnapshot(session, { sessionId, status: 'stopped' });
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

export { BrowserUseLovableAdapter as BrowserUseFulfillmentAdapter };

export class MockBrowserUseAdapter {
  constructor({
    liveUrl = '/api/leads/mock/build-preview',
    projectUrl = 'https://mock-site.lovable.app',
    sessionId = `mock_bu_${Date.now().toString(36)}`,
    delayMs = Number(process.env.FULFILLMENT_MOCK_DELAY_MS || 5)
  } = {}) {
    this.liveUrl = liveUrl;
    this.projectUrl = projectUrl;
    this.sessionId = sessionId;
    this.delayMs = Number.isFinite(delayMs) ? delayMs : 5;
  }

  async createSession() {
    return {
      sessionId: this.sessionId,
      liveUrl: this.liveUrl,
      raw: { id: this.sessionId, liveUrl: this.liveUrl, mock: true }
    };
  }

  runTask() {
    const messages = [
      { id: `${this.sessionId}_1`, type: 'status', summary: 'Opened the Lovable build-with-URL submission.', role: 'assistant' },
      { id: `${this.sessionId}_2`, type: 'status', summary: 'Lovable is composing the paid customer site.', role: 'assistant' },
      { id: `${this.sessionId}_3`, type: 'status', summary: `PROJECT_URL: ${this.projectUrl}`, role: 'assistant' }
    ];
    return mockAsyncTask(messages, {
      id: this.sessionId,
      isTaskSuccessful: true,
      lastStepSummary: 'Mock Browser Use Lovable task completed.',
      output: `PROJECT_URL: ${this.projectUrl}`,
      mock: true
    }, this.delayMs);
  }

  async stopTask() {}

  async stopSession() {}
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
  return buildLovableTargetSubmissionTask({ submissionUrl: lovableUrl, brief });
}

function buildLovableRevisionTask({ projectUrl, revisionPrompt }) {
  return [
    'You are revising a generated Lovable customer website after QA.',
    projectUrl ? `Open the existing project/site URL: ${projectUrl}` : 'Stay in the current Lovable project.',
    'Submit only the targeted revision prompt below. Do not create a new unrelated app.',
    'If Lovable shows any login, sign-in, account, Google/GitHub OAuth, or authentication wall, stop immediately and answer exactly BLOCKED_AUTH.',
    'When the revised published .lovable.app URL is visible, copy it exactly.',
    'Your final answer must include either "PROJECT_URL: https://...lovable.app" or "BLOCKED_AUTH".',
    '',
    'Revision prompt:',
    revisionPrompt
  ].join('\n');
}

function buildSiteInspectionTask({ url, brief }) {
  return [
    'Inspect this generated customer website for shipment QA.',
    `Open: ${url}`,
    'Return only JSON with keys: passed boolean, score number 0-100, checklist array of {key,label,passed,detail,severity}, errors array, summary string.',
    'Checklist: visible business name, visible phone/contact, service sections, primary CTA, mobile sanity, no invented booking/payment/guarantee/license/review/same-day claims.',
    `Expected business name: ${brief.businessName}`,
    `Expected phone: ${brief.phone}`,
    `Expected services: ${(brief.services || []).join(', ')}`,
    `Expected CTA: ${brief.cta}`,
    `Prohibited claims: ${(brief.prohibitedClaims || []).join(' ')}`
  ].join('\n');
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function absolutizeUrl(url) {
  if (!url) return null;
  const text = String(url);
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return new URL(text, env.publicUrl).href;
  return text;
}

function visibleTextFromHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkBusinessName({ visibleText, brief, lead }) {
  const expected = brief?.businessName || lead?.business_name;
  const passed = includesLoose(visibleText, expected);
  return {
    key: 'visible_business_name',
    label: 'Visible business name',
    passed,
    severity: 'blocker',
    detail: passed ? `${expected} is visible.` : `${expected || 'Business name'} was not visible.`
  };
}

function checkPhone({ visibleText, html, brief, lead }) {
  const expected = brief?.phone || lead?.phone;
  const digits = normalizeDigits(expected);
  const haystack = `${visibleText} ${html || ''}`;
  const passed = digits ? normalizeDigits(haystack).includes(digits.slice(-10)) : false;
  return {
    key: 'visible_phone_contact',
    label: 'Visible phone/contact',
    passed,
    severity: 'blocker',
    detail: passed ? 'Phone/contact is visible.' : `Expected phone ${expected || 'missing'} was not visible.`
  };
}

function checkServices({ visibleText, brief }) {
  const services = (brief?.services || []).filter(Boolean);
  const found = services.filter((service) => includesLoose(visibleText, service));
  const passed = services.length > 0 && found.length >= Math.min(2, services.length);
  return {
    key: 'service_sections',
    label: 'Service sections',
    passed,
    severity: 'blocker',
    detail: passed ? `${found.length}/${services.length} services visible.` : `Only ${found.length}/${services.length} expected services were visible.`
  };
}

function checkCta({ visibleText, html, brief }) {
  const cta = brief?.cta || '';
  const passed = includesLoose(visibleText, cta) || /\b(call now|call today|request (a )?(quote|estimate)|get (a )?(quote|estimate)|contact us)\b/i.test(`${visibleText} ${html || ''}`);
  return {
    key: 'primary_cta',
    label: 'Primary CTA',
    passed,
    severity: 'blocker',
    detail: passed ? 'Primary CTA is visible.' : `Expected CTA "${cta}" was not visible.`
  };
}

function checkMobile({ html }) {
  const source = html || '';
  const viewport = /<meta[^>]+name=["']viewport["'][^>]*>/i.test(source);
  const responsiveHint = /width=device-width|@media|\bclamp\(|max-width:\s*100%/i.test(source);
  const passed = viewport && responsiveHint;
  return {
    key: 'mobile_sanity',
    label: 'Mobile sanity',
    passed,
    severity: 'warn',
    detail: passed ? 'Viewport and responsive hints found.' : 'Missing viewport or responsive layout hints.'
  };
}

function checkHallucinatedClaims({ visibleText }) {
  const claims = claimReport(visibleText);
  const passed = claims.found.length === 0;
  return {
    key: 'no_hallucinated_claims',
    label: 'No hallucinated claims',
    passed,
    severity: 'blocker',
    detail: passed ? 'No prohibited claims detected.' : `Detected: ${claims.found.map((c) => c.code).join(', ')}.`
  };
}

function claimReport(text) {
  const found = [];
  for (const item of CLAIM_PATTERNS) {
    const match = String(text || '').match(item.pattern);
    if (match) found.push({ code: item.code, match: match[0] });
  }
  return { found };
}

function normalizeBrowserQa(value, { url, lastSummary }) {
  const checklist = Array.isArray(value.checklist) ? value.checklist.map((item) => ({
    key: item.key || item.label || 'browser_use_check',
    label: item.label || item.key || 'Browser Use check',
    passed: Boolean(item.passed),
    severity: item.severity || 'warn',
    detail: item.detail || ''
  })) : [];
  const errors = Array.isArray(value.errors)
    ? value.errors.map(String)
    : checklist.filter((item) => !item.passed).map((item) => item.key);
  const passed = value.passed === true && errors.length === 0;
  return {
    provider: 'browserUse',
    url,
    passed,
    status: passed ? 'passed' : 'failed',
    score: Number.isFinite(Number(value.score)) ? Number(value.score) : (passed ? 100 : 0),
    checklist,
    errors,
    summary: value.summary || lastSummary || null
  };
}

function parseLooseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  return null;
}

function mockAsyncTask(messages, result, delayMs) {
  return {
    result,
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        await delay(delayMs);
        yield message;
      }
    }
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

function includesLoose(haystack, needle) {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  if (!h || !n) return false;
  if (h.includes(n)) return true;
  const tokens = n.split(' ').filter((token) => token.length > 2);
  if (!tokens.length) return false;
  return tokens.filter((token) => h.includes(token)).length >= Math.min(tokens.length, 2);
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function numberOr(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function stringOr(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

function arrayOr(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value.filter(Boolean);
  }
  return [];
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

function validBrowserUseModel(value) {
  return BROWSER_USE_MODELS.has(value) ? value : null;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
