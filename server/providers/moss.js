import { env, modeAllowsSideEffect } from '../env.js';
import { log } from '../logger.js';
import { providerConfigured, sideEffectGate, smokeDetail, withProviderRetry, normalizeProviderError } from './core.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.MOSS_TIMEOUT_MS || 45000);
const INDEX_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PROVIDER = 'moss';
const DEFAULT_ALPHA = 0.82;

let _client;
let _mockClient;
const loadedIndexes = new Set();

export function mossConfigured() {
  return providerConfigured({
    MOSS_PROJECT_ID: env.moss.projectId,
    MOSS_PROJECT_KEY: env.moss.projectKey
  });
}

export function mossRuntimeMode({ forceLive = false, forceMock = false } = {}) {
  if (forceMock || process.env.MOSS_FORCE_MOCK === 'true') return 'mock';
  if (forceLive && mossConfigured().configured) return 'live';
  if (env.runMode === 'mock') return 'mock';
  return 'live';
}

export function shouldProvisionMossForCall() {
  if (env.runMode === 'mock') return true;
  return mossConfigured().configured && env.live.calls && modeAllowsSideEffect('calls');
}

export async function ensureMossPitchIndex(indexName, pitch, options = {}) {
  return ensureMossIndex(indexName, docsForPitch(pitch), options);
}

export async function ensureMossIndex(indexName, docs, { recreate = false, forceLive = false, forceMock = false, load = true } = {}) {
  assertIndexName(indexName);
  const cleanDocs = normalizeDocs(docs);
  if (!cleanDocs.length) return { status: 'skipped', reason: 'no docs', indexName, docCount: 0, mode: mossRuntimeMode({ forceLive, forceMock }) };

  const mode = mossRuntimeMode({ forceLive, forceMock });
  const moss = await client({ forceLive, forceMock });
  const existing = await getIndexIfExists(moss, indexName, { forceLive, forceMock });

  if (existing && recreate) {
    await deleteMossIndex(indexName, { forceLive, forceMock });
  } else if (existing) {
    await runMossAction('addDocs', () => withTimeout(
      moss.addDocs(indexName, cleanDocs, { upsert: true }),
      DEFAULT_TIMEOUT_MS,
      `moss.addDocs timed out after ${DEFAULT_TIMEOUT_MS}ms`
    ), { mode });
    if (load) await loadMossIndex(indexName, { forceLive, forceMock });
    return { status: 'reused', indexName, docCount: cleanDocs.length, previousDocCount: existing.docCount, mode };
  }

  await runMossAction('createIndex', () => withTimeout(
    moss.createIndex(indexName, cleanDocs, { modelId: 'moss-minilm' }),
    DEFAULT_TIMEOUT_MS,
    `moss.createIndex timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { mode, retries: 0 });
  if (load) await loadMossIndex(indexName, { forceLive, forceMock });
  return { status: 'created', indexName, docCount: cleanDocs.length, mode };
}

export async function queryMossIndex(indexName, query, { topK = 3, alpha = DEFAULT_ALPHA, filter = null, cloud = false, forceLive = false, forceMock = false } = {}) {
  assertIndexName(indexName);
  const mode = mossRuntimeMode({ forceLive, forceMock });
  const moss = await client({ forceLive, forceMock });
  if (mode === 'live' && !cloud) await loadMossIndex(indexName, { forceLive, forceMock });
  const options = { topK: clampInt(topK, 1, 50), alpha: clampAlpha(alpha) };
  if (filter) options.filter = filter;
  return runMossAction('query', () => withTimeout(
    moss.query(indexName, String(query || '').slice(0, 1000), options),
    DEFAULT_TIMEOUT_MS,
    `moss.query timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { mode, retries: 1 });
}

export async function listMossIndexes(options = {}) {
  const mode = mossRuntimeMode(options);
  const moss = await client(options);
  return runMossAction('listIndexes', () => withTimeout(
    moss.listIndexes(),
    DEFAULT_TIMEOUT_MS,
    `moss.listIndexes timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { mode, retries: 1 });
}

export async function getMossDocs(indexName, options = {}) {
  assertIndexName(indexName);
  const mode = mossRuntimeMode(options);
  const moss = await client(options);
  return runMossAction('getDocs', () => withTimeout(
    moss.getDocs(indexName),
    DEFAULT_TIMEOUT_MS,
    `moss.getDocs timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { mode, retries: 1 });
}

export async function deleteMossDocs(indexName, docIds, options = {}) {
  assertIndexName(indexName);
  const ids = [...new Set((docIds || []).map(safeDocId).filter(Boolean))];
  if (!ids.length) return { status: 'skipped', reason: 'no doc ids' };
  const mode = mossRuntimeMode(options);
  const moss = await client(options);
  return runMossAction('deleteDocs', () => withTimeout(
    moss.deleteDocs(indexName, ids),
    DEFAULT_TIMEOUT_MS,
    `moss.deleteDocs timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { mode, retries: 0 });
}

export async function deleteMossIndex(indexName, options = {}) {
  assertIndexName(indexName);
  const mode = mossRuntimeMode(options);
  const moss = await client(options);
  loadedIndexes.delete(indexName);
  return runMossAction('deleteIndex', () => withTimeout(
    moss.deleteIndex(indexName),
    DEFAULT_TIMEOUT_MS,
    `moss.deleteIndex timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { mode, retries: 0 });
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
  const docs = [
    { id: 'objection-price', text: 'If price comes up, explain the flat $500 same-day website package.', metadata: { kind: 'pricing' } },
    { id: 'handoff-agentmail', text: 'AgentMail sends the invoice and keeps replies in the customer thread.', metadata: { kind: 'invoice' } }
  ];
  let createdOrReused = null;
  let shouldDelete = true;

  try {
    const existing = await getIndexIfExists(await client({ forceLive: true }), indexName, { forceLive: true });
    if (existing) {
      createdOrReused = await ensureMossIndex(indexName, docs, { forceLive: true, load: true });
      shouldDelete = false;
    } else {
      await deleteOldSmokeIndexes(indexName);
      createdOrReused = await ensureMossIndex(indexName, docs, { forceLive: true, load: true });
      shouldDelete = createdOrReused.status === 'created';
    }
    const query = await queryMossIndex(indexName, 'invoice reply channel', { topK: 1, alpha: 0.8, forceLive: true });
    const normalized = normalizeMossSearchResult(query);
    if (!normalized.docs.length) throw new Error('moss smoke query returned zero hits');
    return {
      provider: PROVIDER,
      status: 'ok',
      detail: smokeDetail({
        dryRun: false,
        live: true,
        extra: {
          indexName,
          indexStatus: createdOrReused.status,
          hits: normalized.docs.length,
          latencyMs: normalized.timeTakenInMs,
          cleanup: shouldDelete ? 'delete_after_query' : 'quota_safe_reuse'
        }
      })
    };
  } catch (err) {
    if (isIndexLimit(err)) {
      const reused = await queryReusableSmokeIndex(indexName).catch((reuseErr) => ({ error: reuseErr?.message || String(reuseErr) }));
      if (!reused.error) {
        return {
          provider: PROVIDER,
          status: 'ok',
          detail: smokeDetail({
            dryRun: false,
            live: true,
            extra: {
              indexName: reused.indexName,
              indexStatus: 'quota_safe_reused',
              hits: reused.hits,
              latencyMs: reused.latencyMs
            }
          })
        };
      }
      return {
        status: 'blocked',
        provider: PROVIDER,
        detail: smokeDetail({
          dryRun: false,
          live: false,
          extra: {
            error: err?.message || String(err),
            reuseError: reused.error,
            reason: 'moss index limit reached and no reusable callmemaybe smoke index was available'
          }
        })
      };
    }
    throw err;
  } finally {
    if (shouldDelete) {
      try {
        await deleteMossIndex(indexName, { forceLive: true });
      } catch (err) {
        log.warn('moss.smoke.delete_failed', { indexName, error: err?.message || String(err) });
      }
    }
  }
}

export function mossReadinessDetails() {
  const configured = mossConfigured();
  return {
    configured: configured.configured,
    missing: configured.missing,
    role: 'low_latency_in_call_hot_index',
    auth: 'project_id_project_key',
    baseUrl: env.moss.baseUrl || 'https://service.usemoss.dev/v1',
    runtime: 'local_loaded_index_with_cloud_fallback',
    queryDefaults: { topK: 3, alpha: DEFAULT_ALPHA },
    provisionGate: shouldProvisionMossForCall() ? 'enabled_for_current_call_mode' : 'mock_or_disabled_until_live_call_gate',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    smoke: env.smoke.mossIndex ? 'enabled_by_SMOKE_MOSS_INDEX' : 'disabled_by_default'
  };
}

export function normalizeMossSearchResult(result) {
  const docs = Array.isArray(result?.docs)
    ? result.docs
    : Array.isArray(result?.results)
      ? result.results
      : [];
  return {
    query: result?.query || null,
    timeTakenInMs: Math.round(Number(result?.timeTakenInMs ?? result?.timeTakenMs ?? result?.latencyMs ?? 0)),
    docs: docs.map((doc, index) => ({
      id: String(doc.id || doc.docId || doc.documentId || `doc_${index}`),
      text: String(doc.text || doc.content || ''),
      score: Number(doc.score ?? doc.similarity ?? 0),
      metadata: doc.metadata || {}
    }))
  };
}

async function client({ forceLive = false, forceMock = false } = {}) {
  const mode = mossRuntimeMode({ forceLive, forceMock });
  if (mode === 'mock') {
    if (!_mockClient) _mockClient = new InMemoryMossClient();
    return _mockClient;
  }
  if (!_client) {
    if (!env.moss.projectId || !env.moss.projectKey) throw new Error('MOSS_PROJECT_ID/MOSS_PROJECT_KEY missing');
    const { MossClient } = await import('@moss-dev/moss');
    _client = new MossClient(env.moss.projectId, env.moss.projectKey);
  }
  return _client;
}

async function loadMossIndex(indexName, options = {}) {
  const mode = mossRuntimeMode(options);
  const moss = await client(options);
  if (mode === 'live' && loadedIndexes.has(indexName)) return indexName;
  await runMossAction('loadIndex', () => withTimeout(
    moss.loadIndex(indexName),
    DEFAULT_TIMEOUT_MS,
    `moss.loadIndex timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), { mode, retries: 1 });
  if (mode === 'live') loadedIndexes.add(indexName);
  return indexName;
}

async function getIndexIfExists(moss, indexName, options = {}) {
  const mode = mossRuntimeMode(options);
  try {
    return await runMossAction('getIndex', () => withTimeout(
      moss.getIndex(indexName),
      DEFAULT_TIMEOUT_MS,
      `moss.getIndex timed out after ${DEFAULT_TIMEOUT_MS}ms`
    ), { mode, retries: 0 });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function deleteOldSmokeIndexes(keepName) {
  let indexes = [];
  try {
    indexes = await listMossIndexes({ forceLive: true });
  } catch (err) {
    log.warn('moss.smoke.list_failed', { error: err?.message || String(err) });
    return;
  }
  const oldSmoke = indexes
    .filter((index) => index?.name && index.name !== keepName && /^callmemaybe[-_]smoke/.test(index.name))
    .sort((a, b) => Date.parse(a.updatedAt || a.createdAt || '') - Date.parse(b.updatedAt || b.createdAt || ''));
  for (const index of oldSmoke) {
    try {
      await deleteMossIndex(index.name, { forceLive: true });
      log.info('moss.smoke.old_index_deleted', { indexName: index.name });
    } catch (err) {
      log.warn('moss.smoke.old_index_delete_failed', { indexName: index.name, error: err?.message || String(err) });
    }
  }
}

async function queryReusableSmokeIndex(preferredName) {
  const indexes = await listMossIndexes({ forceLive: true });
  const reusable = indexes.find((index) => index?.name === preferredName) ||
    indexes.find((index) => /^callmemaybe[-_]smoke/.test(index?.name || ''));
  if (!reusable?.name) throw new Error('no reusable smoke index found');
  const query = await queryMossIndex(reusable.name, 'invoice reply channel', { topK: 1, forceLive: true });
  const normalized = normalizeMossSearchResult(query);
  if (!normalized.docs.length) throw new Error('reusable smoke index returned zero hits');
  return { indexName: reusable.name, hits: normalized.docs.length, latencyMs: normalized.timeTakenInMs };
}

export function docsForPitch(pitch) {
  return [
    { id: 'pitch.opening', text: pitch.openingLine, metadata: { kind: 'pitch_snippet', section: 'opening' } },
    { id: 'pitch.value', text: pitch.valueProp, metadata: { kind: 'pitch_snippet', section: 'value_prop' } },
    { id: 'pitch.close', text: pitch.close, metadata: { kind: 'pitch_snippet', section: 'close' } },
    { id: 'pitch.email_ask', text: pitch.emailAsk || 'Ask for invoice email and confirm it.', metadata: { kind: 'invoice_pricing', section: 'email_ask' } },
    { id: 'pitch.email_readback', text: pitch.emailReadbackInstruction || 'Read back the email and ask for confirmation.', metadata: { kind: 'compliance', section: 'email_readback' } },
    { id: 'pitch.invoice_close', text: pitch.invoiceClose || 'AgentMail sends the invoice and handles replies.', metadata: { kind: 'invoice_pricing', section: 'invoice_close' } },
    ...(pitch.discoveryQuestions || []).map((q, i) => ({ id: `pitch.discovery.${i}`, text: q, metadata: { kind: 'customer_need', section: 'discovery' } })),
    ...(pitch.objections || []).map((o, i) => ({ id: `pitch.objection.${i}`, text: `${o.objection} :: ${o.response}`, metadata: { kind: 'objection', section: 'objection', objection: o.objection } }))
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

async function runMossAction(action, fn, { mode, retries = 1 } = {}) {
  if (mode === 'mock') return fn();
  return withProviderRetry(PROVIDER, action, fn, { retries, classify: normalizeMossError });
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

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function clampAlpha(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ALPHA;
  return Math.max(0, Math.min(1, n));
}

class InMemoryMossClient {
  constructor() {
    this.indexes = new Map();
  }

  async createIndex(indexName, docs) {
    if (this.indexes.has(indexName)) throw Object.assign(new Error(`index already exists: ${indexName}`), { status: 409, retryable: false });
    const now = new Date().toISOString();
    this.indexes.set(indexName, { name: indexName, docs: normalizeDocs(docs), createdAt: now, updatedAt: now, loaded: false });
    return { indexName, docCount: docs.length, jobId: `mock_${Date.now().toString(36)}` };
  }

  async addDocs(indexName, docs, { upsert = true } = {}) {
    const index = this.mustGet(indexName);
    const incoming = normalizeDocs(docs);
    const byId = new Map(index.docs.map((doc) => [doc.id, doc]));
    for (const doc of incoming) {
      if (!upsert && byId.has(doc.id)) continue;
      byId.set(doc.id, doc);
    }
    index.docs = [...byId.values()];
    index.updatedAt = new Date().toISOString();
    return { indexName, docCount: index.docs.length, jobId: `mock_${Date.now().toString(36)}` };
  }

  async deleteDocs(indexName, docIds) {
    const index = this.mustGet(indexName);
    const ids = new Set(docIds || []);
    index.docs = index.docs.filter((doc) => !ids.has(doc.id));
    index.updatedAt = new Date().toISOString();
    return { indexName, docCount: index.docs.length, jobId: `mock_${Date.now().toString(36)}` };
  }

  async getDocs(indexName) {
    return this.mustGet(indexName).docs.map((doc) => ({ ...doc }));
  }

  async getIndex(indexName) {
    const index = this.mustGet(indexName);
    return {
      id: `mock_${indexName}`,
      name: index.name,
      status: 'Ready',
      docCount: index.docs.length,
      createdAt: index.createdAt,
      updatedAt: index.updatedAt,
      model: { id: 'mock-minilm' }
    };
  }

  async listIndexes() {
    return [...this.indexes.values()].map((index) => ({
      id: `mock_${index.name}`,
      name: index.name,
      status: 'Ready',
      docCount: index.docs.length,
      createdAt: index.createdAt,
      updatedAt: index.updatedAt,
      model: { id: 'mock-minilm' }
    }));
  }

  async deleteIndex(indexName) {
    this.mustGet(indexName);
    this.indexes.delete(indexName);
    return true;
  }

  async loadIndex(indexName) {
    const index = this.mustGet(indexName);
    index.loaded = true;
    return indexName;
  }

  async query(indexName, query, options = {}) {
    const started = Date.now();
    const index = this.mustGet(indexName);
    const topK = clampInt(options.topK ?? 5, 1, 50);
    const alpha = clampAlpha(options.alpha ?? DEFAULT_ALPHA);
    const q = String(query || '');
    const docs = index.docs
      .filter((doc) => matchesFilter(doc.metadata || {}, options.filter))
      .map((doc) => ({ ...doc, score: scoreDoc(q, doc, alpha) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return {
      query: q,
      timeTakenInMs: Math.max(1, Date.now() - started),
      docs
    };
  }

  mustGet(indexName) {
    const index = this.indexes.get(indexName);
    if (!index) throw Object.assign(new Error(`index not found: ${indexName}`), { status: 404, retryable: false });
    return index;
  }
}

function scoreDoc(query, doc, alpha) {
  const qTokens = tokens(query);
  const textTokens = tokens(`${doc.text} ${Object.values(doc.metadata || {}).join(' ')}`);
  if (!qTokens.length || !textTokens.length) return 0;
  const textSet = new Set(textTokens);
  const overlap = qTokens.filter((token) => textSet.has(token)).length;
  const semantic = overlap / Math.max(qTokens.length, 1);
  const haystack = `${doc.id} ${doc.text} ${Object.values(doc.metadata || {}).join(' ')}`.toLowerCase();
  const keyword = qTokens.some((token) => haystack.includes(token)) ? 1 : 0;
  const exact = haystack.includes(String(query || '').toLowerCase()) ? 0.25 : 0;
  return Math.min(1, alpha * semantic + (1 - alpha) * keyword + exact);
}

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function matchesFilter(metadata, filter) {
  if (!filter) return true;
  if (filter.$and) return filter.$and.every((item) => matchesFilter(metadata, item));
  if (filter.$or) return filter.$or.some((item) => matchesFilter(metadata, item));
  const field = filter.field;
  const condition = filter.condition || {};
  if (!field) return true;
  const value = metadata[field];
  if (condition.$eq !== undefined) return String(value) === String(condition.$eq);
  if (condition.$ne !== undefined) return String(value) !== String(condition.$ne);
  if (condition.$in) return condition.$in.map(String).includes(String(value));
  if (condition.$nin) return !condition.$nin.map(String).includes(String(value));
  if (condition.$lt !== undefined) return Number(value) < Number(condition.$lt);
  if (condition.$lte !== undefined) return Number(value) <= Number(condition.$lte);
  if (condition.$gt !== undefined) return Number(value) > Number(condition.$gt);
  if (condition.$gte !== undefined) return Number(value) >= Number(condition.$gte);
  return true;
}
