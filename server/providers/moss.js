import { env } from '../env.js';
import { log } from '../logger.js';
import { providerConfigured, sideEffectGate, smokeDetail, withProviderRetry, normalizeProviderError } from './core.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.MOSS_TIMEOUT_MS || 45000);
const INDEX_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PROVIDER = 'moss';

let _client;

export function mossConfigured() {
  return providerConfigured({
    MOSS_PROJECT_ID: env.moss.projectId,
    MOSS_PROJECT_KEY: env.moss.projectKey
  });
}

export function shouldProvisionMossForCall() {
  return mossConfigured().configured && env.live.calls && ['live', 'demo_live', 'autonomous_live'].includes(env.runMode);
}

export async function ensureMossPitchIndex(indexName, pitch, options = {}) {
  return ensureMossIndex(indexName, docsForPitch(pitch), options);
}

export async function ensureMossIndex(indexName, docs, { recreate = false } = {}) {
  assertIndexName(indexName);
  const cleanDocs = normalizeDocs(docs);
  if (!cleanDocs.length) return { status: 'skipped', reason: 'no docs' };

  const moss = await client();
  const existing = await getIndexIfExists(moss, indexName);
  if (existing && recreate) {
    await deleteMossIndex(indexName);
  } else if (existing) {
    await withProviderRetry(PROVIDER, 'addDocs', () => withTimeout(
      moss.addDocs(indexName, cleanDocs, { upsert: true }),
      DEFAULT_TIMEOUT_MS,
      `moss.addDocs timed out after ${DEFAULT_TIMEOUT_MS}ms`
    ), { retries: 1, classify: normalizeMossError });
    return { status: 'reused', indexName, docCount: cleanDocs.length, previousDocCount: existing.docCount };
  }

    await withProviderRetry(PROVIDER, 'createIndex', () => withTimeout(
    moss.createIndex(indexName, cleanDocs, { modelId: 'moss-minilm' }),
    DEFAULT_TIMEOUT_MS,
    `moss.createIndex timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { retries: 0, classify: normalizeMossError });
  return { status: 'created', indexName, docCount: cleanDocs.length };
}

export async function queryMossIndex(indexName, query, { topK = 3 } = {}) {
  assertIndexName(indexName);
  const moss = await client();
  return withProviderRetry(PROVIDER, 'query', () => withTimeout(
    moss.query(indexName, String(query || '').slice(0, 1000), { topK }),
    DEFAULT_TIMEOUT_MS,
    `moss.query timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { retries: 1, classify: normalizeMossError });
}

export async function listMossIndexes() {
  const moss = await client();
  return withProviderRetry(PROVIDER, 'listIndexes', () => withTimeout(
    moss.listIndexes(),
    DEFAULT_TIMEOUT_MS,
    `moss.listIndexes timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { retries: 1, classify: normalizeMossError });
}

export async function deleteMossIndex(indexName) {
  assertIndexName(indexName);
  const moss = await client();
  return withProviderRetry(PROVIDER, 'deleteIndex', () => withTimeout(
    moss.deleteIndex(indexName),
    DEFAULT_TIMEOUT_MS,
    `moss.deleteIndex timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { retries: 0, classify: normalizeMossError });
}

export async function smokeMossIndex() {
  const configured = mossConfigured();
  if (!configured.configured) {
    return { provider: PROVIDER, status: 'missing', detail: smokeDetail({ skipped: configured.missing.join(', ') }) };
  }

  const gate = sideEffectGate({
    provider: PROVIDER,
    action: 'index create/query/delete smoke',
    enabled: env.smoke.mossIndex,
    details: { toggle: 'SMOKE_MOSS_INDEX' }
  });
  if (!gate.ok) {
    return { provider: PROVIDER, status: 'configured', detail: smokeDetail({ skipped: gate.reason, extra: gate.details }) };
  }

  const indexName = 'callmemaybe_smoke';
  try {
    await deleteOldSmokeIndexes(indexName);
    const result = await ensureMossIndex(indexName, [
      { id: 'objection-price', text: 'If price comes up, explain the flat $500 same-day website package.' },
      { id: 'handoff-agentmail', text: 'AgentMail sends the invoice and keeps replies in the customer thread.' }
    ]);
    const query = await queryMossIndex(indexName, 'invoice reply channel', { topK: 1 });
    const hits = query?.docs?.length || query?.results?.length || 0;
    if (!hits) throw new Error('moss smoke query returned zero hits');
    return {
      provider: PROVIDER,
      status: 'ok',
      detail: smokeDetail({
        dryRun: false,
        live: true,
        extra: { indexName, indexStatus: result.status, hits }
      })
    };
  } catch (err) {
    if (isIndexLimit(err)) {
      return {
        status: 'blocked',
        provider: PROVIDER,
        detail: smokeDetail({
          dryRun: false,
          live: false,
          extra: {
            error: err?.message || String(err),
            reason: 'moss index limit reached and no reusable callmemaybe smoke index was available'
          }
        })
      };
    }
    throw err;
  } finally {
    try {
      await deleteMossIndex(indexName);
    } catch (err) {
      log.warn('moss.smoke.delete_failed', { indexName, error: err?.message || String(err) });
    }
  }
}

export function mossReadinessDetails() {
  const configured = mossConfigured();
  return {
    configured: configured.configured,
    missing: configured.missing,
    role: 'quota_safe_in_call_index',
    auth: 'project_id_project_key',
    baseUrl: env.moss.baseUrl || 'https://service.usemoss.dev/v1',
    runtime: 'sub_400ms_in_call_retrieval',
    provisionGate: shouldProvisionMossForCall() ? 'live_call_enabled' : 'disabled_until_live_call_gate',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    smoke: env.smoke.mossIndex ? 'enabled_by_SMOKE_MOSS_INDEX' : 'disabled_by_default'
  };
}

async function client() {
  if (!_client) {
    if (!env.moss.projectId || !env.moss.projectKey) throw new Error('MOSS_PROJECT_ID/MOSS_PROJECT_KEY missing');
    const { MossClient } = await import('@moss-dev/moss');
    _client = new MossClient(env.moss.projectId, env.moss.projectKey);
  }
  return _client;
}

async function getIndexIfExists(moss, indexName) {
  try {
    return await withProviderRetry(PROVIDER, 'getIndex', () => withTimeout(
      moss.getIndex(indexName),
      DEFAULT_TIMEOUT_MS,
      `moss.getIndex timed out after ${DEFAULT_TIMEOUT_MS}ms`
    ), { retries: 0, classify: normalizeMossError });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function deleteOldSmokeIndexes(keepName) {
  let indexes = [];
  try {
    indexes = await listMossIndexes();
  } catch (err) {
    log.warn('moss.smoke.list_failed', { error: err?.message || String(err) });
    return;
  }
  const oldSmoke = indexes
    .filter((index) => index?.name && index.name !== keepName && /^callmemaybe[-_]smoke/.test(index.name))
    .sort((a, b) => Date.parse(a.updatedAt || a.createdAt || '') - Date.parse(b.updatedAt || b.createdAt || ''));
  for (const index of oldSmoke) {
    try {
      await deleteMossIndex(index.name);
      log.info('moss.smoke.old_index_deleted', { indexName: index.name });
    } catch (err) {
      log.warn('moss.smoke.old_index_delete_failed', { indexName: index.name, error: err?.message || String(err) });
    }
  }
}

function docsForPitch(pitch) {
  return [
    { id: 'opening', text: pitch.openingLine },
    { id: 'value-prop', text: pitch.valueProp },
    { id: 'close', text: pitch.close },
    { id: 'email-ask', text: pitch.emailAsk || 'Ask for invoice email and confirm it.' },
    { id: 'email-readback', text: pitch.emailReadbackInstruction || 'Read back the email and ask for confirmation.' },
    { id: 'invoice-close', text: pitch.invoiceClose || 'AgentMail sends the invoice and handles replies.' },
    ...(pitch.discoveryQuestions || []).map((q, i) => ({ id: `discovery-${i}`, text: q })),
    ...(pitch.objections || []).map((o, i) => ({ id: `objection-${i}`, text: `${o.objection} :: ${o.response}` }))
  ];
}

function normalizeDocs(docs) {
  return (docs || [])
    .map((doc) => ({
      id: safeDocId(doc.id),
      text: String(doc.text || '').trim().slice(0, 2000),
      metadata: stringifyStringMetadata(doc.metadata)
    }))
    .filter((doc) => doc.id && doc.text);
}

function stringifyStringMetadata(metadata = {}) {
  const out = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value == null) continue;
    out[key] = String(value).slice(0, 500);
  }
  return out;
}

function assertIndexName(indexName) {
  if (!INDEX_RE.test(indexName)) throw new Error(`bad Moss indexName: ${indexName}`);
}

function safeDocId(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
}

export function normalizeMossError(err) {
  const normalized = normalizeProviderError(err);
  const msg = normalized.message || '';
  if (/not.?found|does not exist|404/i.test(msg)) normalized.status = normalized.status || 404;
  if (/UsageLimitExceeded|Index limit/i.test(msg)) {
    normalized.status = normalized.status || 429;
    normalized.code = normalized.code || 'quota';
    normalized.retryable = false;
  }
  if (/timeout|rate.?limit|temporar|ECONNRESET|ETIMEDOUT|503|504/i.test(msg)) normalized.retryable = true;
  return normalized;
}

export function classifyMossFailure(err) {
  const normalized = normalizeMossError(err);
  let category = 'unknown';
  const status = Number(normalized.status || 0) || null;
  const msg = String(normalized.message || '').toLowerCase();
  const code = String(normalized.code || '').toLowerCase();

  if (status === 401 || status === 403 || /\b(auth|unauthorized|forbidden|project key|project id)\b/.test(msg)) {
    category = 'auth';
    normalized.retryable = false;
  } else if (status === 429 || code === 'quota' || /\b(rate.?limit|quota|usage|index limit)\b/.test(msg)) {
    category = 'quota';
    normalized.retryable = normalized.retryable ?? false;
  } else if (status === 404 || /\b(not.?found|does not exist)\b/.test(msg)) {
    category = 'not-found';
    normalized.retryable = false;
  } else if (/\b(invalid|validation|bad index|bad request)\b/.test(msg)) {
    category = 'validation';
    normalized.retryable = false;
  } else if (/\b(timeout|timed out|abort)\b/.test(msg) || code === 'timeout') {
    category = 'timeout';
    normalized.retryable = true;
  } else if (/\b(fetch failed|network|econn|enotfound|etimedout|socket)\b/.test(msg)) {
    category = 'network';
    normalized.retryable = true;
  } else if (status && status >= 500) {
    category = 'provider-error';
    normalized.retryable = true;
  } else if (status && status >= 400) {
    category = 'provider-rejected';
    normalized.retryable = false;
  }

  return {
    ...normalized,
    category,
    outcome: `failed:${category}`,
    retryable: normalized.retryable ?? true
  };
}

function isNotFound(err) {
  const msg = err?.message || '';
  return err?.status === 404 || /not.?found|does not exist|404/i.test(msg);
}

function isIndexLimit(err) {
  const msg = err?.message || '';
  return err?.status === 429 || /UsageLimitExceeded|Index limit/i.test(msg);
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'timeout', retryable: true })), ms);
    })
  ]).finally(() => clearTimeout(timer));
}
