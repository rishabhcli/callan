import { randomUUID } from 'node:crypto';
import Supermemory from 'supermemory';
import { env } from './env.js';
import { log } from './logger.js';
import { enrichBusinessProfile } from './profileEnrichment.js';
import { withProviderRetry, normalizeProviderError } from './providers/core.js';

let _client;
function client() {
  if (!_client) {
    if (!env.supermemory.apiKey) throw new Error('SUPERMEMORY_API_KEY missing');
    // The SDK appends /v3/* to baseURL itself. Stale SUPERMEMORY_BASE_URL values
    // in .env (e.g. ending in /v3) double the path and 404. Pin to the API host.
    _client = new Supermemory({
      apiKey: env.supermemory.apiKey,
      baseURL: 'https://api.supermemory.ai',
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 2
    });
  }
  return _client;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.SUPERMEMORY_TIMEOUT_MS || 15000);
const TAG_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const MEMORY_KINDS = Object.freeze(['profile', 'pitch', 'call_log', 'post_mortem', 'mail_thread']);
const KINDS = new Set(MEMORY_KINDS);

export function containerTagFor(leadId) {
  const tag = `biz_${leadId}`;
  if (!TAG_RE.test(tag)) throw new Error(`bad containerTag: ${tag}`);
  return tag;
}

export function leadIdFromContainerTag(containerTag) {
  if (!TAG_RE.test(containerTag)) throw new Error(`bad containerTag: ${containerTag}`);
  return containerTag.startsWith('biz_') ? containerTag.slice(4) : null;
}

export async function addDoc(containerTag, kind, content, metadata = {}) {
  if (!TAG_RE.test(containerTag)) throw new Error(`bad containerTag: ${containerTag}`);
  if (!KINDS.has(kind)) throw new Error(`bad kind: ${kind}`);
  const normalized = normalizeDocForMemory(kind, content, metadata);
  const sm = client();
  const body = typeof normalized.content === 'string' ? normalized.content : JSON.stringify(normalized.content, null, 2);
  const customId = safeCustomId(`${containerTag}-${kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`);
  const res = await withProviderRetry('supermemory', 'addDoc', () => sm.memories.add({
    content: body,
    containerTag,
    customId,
    metadata: stringifyMetadata({
      ...normalized.metadata,
      kind,
      containerTag,
      leadId: leadIdFromContainerTag(containerTag) || undefined,
      memoryScope: 'lead'
    })
  }, { timeout: DEFAULT_TIMEOUT_MS }), { classify: normalizeSupermemoryError });
  log.info('memory.add', { containerTag, kind, customId, id: res?.id });
  return res;
}

export async function search(containerTag, query, { kind, limit = 5 } = {}) {
  if (!TAG_RE.test(containerTag)) throw new Error(`bad containerTag: ${containerTag}`);
  const sm = client();
  const params = {
    q: String(query || '').slice(0, 1000),
    containerTags: [containerTag],
    limit: clampLimit(limit)
  };
  if (kind) {
    if (!KINDS.has(kind)) throw new Error(`bad kind: ${kind}`);
    params.filters = { AND: [{ key: 'kind', value: kind, filterType: 'metadata', negate: false }] };
  }
  const res = await withProviderRetry('supermemory', 'search', () => (
    sm.search.execute(params, { timeout: DEFAULT_TIMEOUT_MS })
  ), { classify: normalizeSupermemoryError });
  return normalizeResults(res?.results || [], containerTag, kind);
}

export async function listKinds(containerTag) {
  if (!TAG_RE.test(containerTag)) throw new Error(`bad containerTag: ${containerTag}`);
  const sm = client();
  const res = await withProviderRetry('supermemory', 'listKinds', () => (
    sm.memories.list({ containerTags: [containerTag], includeContent: true, limit: 50 }, { timeout: DEFAULT_TIMEOUT_MS })
  ), { classify: normalizeSupermemoryError });
  const out = { profile: [], pitch: [], call_log: [], post_mortem: [], mail_thread: [] };
  const docs = normalizeResults(res?.memories || [], containerTag);
  for (const d of docs) {
    const kind = d?.metadata?.kind;
    if (kind && out[kind]) out[kind].push(d);
  }
  for (const docsForKind of Object.values(out)) docsForKind.sort((a, b) => timestampOf(b) - timestampOf(a));
  return out;
}

export async function getLatest(containerTag, kind) {
  const all = await listKinds(containerTag);
  return all[kind]?.[0] || null;
}

export async function createBusiness(profile) {
  const leadId = profile.id || `lead${Math.random().toString(36).slice(2, 10)}`;
  const containerTag = containerTagFor(leadId);
  await addDoc(containerTag, 'profile', profile, { businessName: profile.businessName, profileSource: 'provided' });
  return { leadId, containerTag };
}

function normalizeDocForMemory(kind, content, metadata) {
  if (kind !== 'profile') return { content, metadata };
  const { sourceText: _sourceText, ...persistedMetadata } = metadata || {};
  const input = typeof content === 'string' ? parseProfileString(content, persistedMetadata) : content;
  const normalized = enrichBusinessProfile(input, {
    profileSource: metadata.profileSource || 'memory_write',
    businessName: metadata.businessName,
    niche: metadata.niche,
    city: metadata.city,
    phone: metadata.phone,
    address: metadata.address,
    sourceUrl: metadata.sourceUrl,
    yelpUrl: metadata.yelpUrl,
    sourceText: metadata.sourceText,
    forceWeakPresence: metadata.forceWeakPresence,
    allowGeneratedUrls: metadata.allowGeneratedUrls
  });
  if (!normalized.valid || normalized.repaired) {
    log.warn('memory.profile.repaired', {
      businessName: normalized.profile.businessName,
      validBeforeRepair: normalized.valid,
      repairs: normalized.repairs
    });
  }
  return {
    content: normalized.profile,
    metadata: {
      ...persistedMetadata,
      businessName: normalized.profile.businessName,
      niche: normalized.profile.niche,
      city: normalized.profile.city,
      sourceUrl: normalized.profile.sourceUrl || normalized.profile.yelpUrl || persistedMetadata.sourceUrl,
      profileSchema: 'BusinessProfile.v2',
      schemaValid: true,
      schemaRepaired: normalized.repaired || !normalized.valid,
      repairs: normalized.repairs
    }
  };
}

function parseProfileString(content, metadata) {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return {
    businessName: metadata.businessName || 'Unknown business',
    city: metadata.city || 'local area',
    niche: metadata.niche || 'local services',
    whatTheyDo: content
  };
}

function normalizeResults(results, containerTag, kind) {
  return results
    .filter((doc) => belongsToContainer(doc, containerTag))
    .filter((doc) => !kind || doc?.metadata?.kind === kind)
    .map((doc) => ({ ...doc, metadata: doc.metadata || {} }));
}

function belongsToContainer(doc, containerTag) {
  const tags = doc?.containerTags || doc?.container_tags || [];
  if (Array.isArray(tags) && tags.length) return tags.includes(containerTag);
  const metadataTag = doc?.metadata?.containerTag || doc?.metadata?.container_tag;
  if (metadataTag) return metadataTag === containerTag;
  return true;
}

// Supermemory metadata values must be primitive (string|number|boolean|string[]).
function stringifyMetadata(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
    else out[k] = String(v).slice(0, 500);
  }
  return out;
}

function safeCustomId(value) {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
}

function clampLimit(limit, max = 50) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(1, Math.trunc(n)), max);
}

function timestampOf(doc) {
  return Date.parse(doc?.updatedAt || doc?.createdAt || doc?.updated_at || doc?.created_at || '') || 0;
}

function normalizeSupermemoryError(err) {
  const normalized = normalizeProviderError(err);
  const msg = normalized.message || '';
  if (/timeout|rate.?limit|temporar|ECONNRESET|ETIMEDOUT/i.test(msg)) normalized.retryable = true;
  if (/bad kind|bad containerTag/i.test(msg)) normalized.retryable = false;
  return normalized;
}
