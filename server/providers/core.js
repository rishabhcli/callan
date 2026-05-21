import { log } from '../logger.js';
import { recordProviderRuntimeIncident } from '../providerIncidents.js';

const DEFAULT_RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function providerConfigured(required = {}) {
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return { configured: missing.length === 0, missing };
}

export function sideEffectGate({ provider, action, enabled, details = {} }) {
  if (enabled) return { ok: true, provider, action, live: true, details };
  return {
    ok: false,
    provider,
    action,
    live: false,
    reason: `${action} requires an explicit environment toggle`,
    details
  };
}

export async function withProviderRetry(provider, action, fn, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 250,
    retryableStatuses = DEFAULT_RETRYABLE,
    classify = normalizeProviderError,
    recordRuntimeIncident = true
  } = options;

  let lastError;
  let lastRetryable;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn({ attempt });
    } catch (err) {
      lastError = classify(err);
      const retryable = lastError.retryable !== false && (
        !lastError.status || retryableStatuses.has(Number(lastError.status))
      );
      lastRetryable = retryable;
      log.warn('provider.retry', { provider, action, attempt, retryable, error: lastError.message, status: lastError.status });
      if (!retryable || attempt === retries) break;
      await delay(baseDelayMs * 2 ** attempt);
    }
  }

  const error = new Error(`${provider}.${action} failed: ${lastError?.message || 'unknown error'}`);
  error.provider = provider;
  error.action = action;
  error.status = lastError?.status;
  error.code = lastError?.code;
  error.retryable = lastError?.retryable ?? lastRetryable;
  error.cause = lastError?.cause;
  if (recordRuntimeIncident) {
    recordProviderRuntimeIncident({ provider, action, error });
  }
  throw error;
}

export async function fetchJson(provider, action, url, init = {}, options = {}) {
  return withProviderRetry(provider, action, async ({ attempt }) => {
    const timeoutMs = options.timeoutMs || 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${provider}.${action} timeout`)), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      const body = parseMaybeJson(text);
      if (!res.ok) {
        const err = new Error(providerErrorMessage(body, text, res.statusText));
        err.status = res.status;
        err.body = body;
        err.retryable = options.retryableStatuses ? options.retryableStatuses.has(res.status) : undefined;
        throw err;
      }
      return body;
    } catch (err) {
      if (err?.name === 'AbortError') {
        const timeout = new Error(`${provider}.${action} timed out after ${timeoutMs}ms`);
        timeout.code = 'timeout';
        timeout.retryable = attempt < (options.retries ?? 2);
        throw timeout;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }, options);
}

export function normalizeProviderError(err) {
  const message = err?.message || String(err);
  const status = err?.status || err?.statusCode || err?.response?.status;
  const code = err?.code || err?.type || err?.raw?.code;
  const retryable = err?.retryable;
  return {
    message,
    status,
    code,
    retryable,
    cause: err
  };
}

export function smokeDetail({ dryRun = true, skipped, live = false, extra = {} } = {}) {
  return {
    dryRun,
    live,
    skipped,
    ...extra
  };
}

function providerErrorMessage(body, text, fallback) {
  if (body?.error?.message) return body.error.message;
  if (body?.message) return body.message;
  if (typeof body?.error === 'string') return body.error;
  if (text) return text.slice(0, 500);
  return fallback || 'provider request failed';
}

function parseMaybeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
