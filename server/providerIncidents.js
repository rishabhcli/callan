import { providerSmoke } from './db.js';
import { operationalErrorMessage, isRetryableOperationalError } from './operationalErrors.js';

const INCIDENT_FRESH_MS = 24 * 60 * 60 * 1000;

export function recordProviderRuntimeIncident({
  provider,
  error,
  action = 'runtime_call',
  worker = null,
  leadId = null,
  eventId = null,
  now = Date.now()
} = {}) {
  if (!provider) return null;
  const retryable = isRetryableOperationalError(error);
  const status = retryable === false ? 'blocked' : 'failed';
  const message = operationalErrorMessage(error) || 'provider runtime failure';
  const detail = providerIncidentDetail({
    dryRun: false,
    live: true,
    extra: {
      source: 'runtime_provider_call',
      runtimeIncident: true,
      smoke: false,
      action,
      worker,
      leadId,
      eventId,
      retryable,
      error: message,
      clearWith: `run a successful live ${provider} smoke after fixing credentials/config`
    }
  });
  const write = status === 'blocked' ? providerSmoke.set : providerSmoke.recordEvent;
  write.call(providerSmoke, provider, status, detail, {
    checkedAt: now,
    error: message
  });
  return {
    provider,
    status,
    retryable,
    checkedAt: now,
    error: message
  };
}

function providerIncidentDetail({ dryRun = true, live = false, skipped, extra = {} } = {}) {
  return {
    dryRun,
    live,
    skipped,
    ...extra
  };
}

export function providerRuntimeIncident(provider, {
  now = Date.now(),
  maxAgeMs = INCIDENT_FRESH_MS
} = {}) {
  if (!provider) return { blocked: false, provider: null, reason: null };
  const incident = providerSmoke.latestEvent({ provider, statuses: ['blocked'] });
  if (!incident?.detail?.runtimeIncident || incident.detail.retryable !== false) {
    return { blocked: false, provider, reason: null, incident: incident || null };
  }
  const ageMs = incident.checkedAt ? Math.max(0, now - incident.checkedAt) : null;
  const liveOk = providerSmoke.latestEvent({ provider, live: true, statuses: ['ok'] });
  if (liveOk?.checkedAt && liveOk.checkedAt > incident.checkedAt) {
    return {
      blocked: false,
      provider,
      reason: null,
      incident,
      clearedBy: liveOk,
      ageMs
    };
  }
  if (ageMs !== null && ageMs > maxAgeMs) {
    return {
      blocked: false,
      provider,
      reason: null,
      incident,
      stale: true,
      ageMs
    };
  }
  const error = incident.error || incident.detail?.error || 'non-retryable provider runtime failure';
  return {
    blocked: true,
    provider,
    incident,
    ageMs,
    reason: `${provider} provider has an uncleared runtime incident: ${error}`
  };
}

export function assertProviderOperational(provider, context = {}) {
  const incident = providerRuntimeIncident(provider, context);
  if (!incident.blocked) return incident;
  const err = new Error(`${incident.reason}; ${incident.incident?.detail?.clearWith || `run a successful live ${provider} smoke`}`);
  err.provider = provider;
  err.code = 'provider_runtime_incident';
  err.retryable = false;
  err.operationalState = 'blocked';
  err.blocker = incident.reason;
  err.incident = incident;
  throw err;
}

export function isProviderRuntimeError(err, provider) {
  const message = operationalErrorMessage(err).toLowerCase();
  const expected = String(provider || '').toLowerCase();
  if (!expected) return false;
  return err?.provider === provider || message.includes(`${expected}.`);
}
