import Supermemory from 'supermemory';
import { env } from './env.js';
import { log } from './logger.js';

let _client;
function client() {
  if (!_client) {
    if (!env.supermemory.apiKey) throw new Error('SUPERMEMORY_API_KEY missing');
    // The SDK appends /v3/* to baseURL itself. Stale SUPERMEMORY_BASE_URL values
    // in .env (e.g. ending in /v3) double the path and 404. Pin to the API host.
    _client = new Supermemory({
      apiKey: env.supermemory.apiKey,
      baseURL: 'https://api.supermemory.ai'
    });
  }
  return _client;
}

const TAG_RE = /^[A-Za-z0-9._-]{1,100}$/;
const KINDS = new Set(['profile', 'pitch', 'call_log', 'post_mortem', 'mail_thread']);

export function containerTagFor(leadId) {
  const tag = `biz_${leadId}`;
  if (!TAG_RE.test(tag)) throw new Error(`bad containerTag: ${tag}`);
  return tag;
}

export async function addDoc(containerTag, kind, content, metadata = {}) {
  if (!TAG_RE.test(containerTag)) throw new Error(`bad containerTag: ${containerTag}`);
  if (!KINDS.has(kind)) throw new Error(`bad kind: ${kind}`);
  const sm = client();
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  const customId = `${containerTag}-${kind}-${Date.now().toString(36)}`;
  const res = await sm.memories.add({
    content: body,
    containerTag,
    customId,
    metadata: stringifyMetadata({ ...metadata, kind })
  });
  log.info('memory.add', { containerTag, kind, customId, id: res?.id });
  return res;
}

export async function search(containerTag, query, { kind, limit = 5 } = {}) {
  if (!TAG_RE.test(containerTag)) throw new Error(`bad containerTag: ${containerTag}`);
  const sm = client();
  const params = {
    q: query,
    containerTags: [containerTag],
    limit
  };
  if (kind) {
    if (!KINDS.has(kind)) throw new Error(`bad kind: ${kind}`);
    params.filters = { AND: [{ key: 'kind', value: kind, negate: false }] };
  }
  const res = await sm.search.execute(params);
  return res?.results || [];
}

export async function listKinds(containerTag) {
  if (!TAG_RE.test(containerTag)) throw new Error(`bad containerTag: ${containerTag}`);
  const sm = client();
  const res = await sm.memories.list({ containerTags: [containerTag], includeContent: true, limit: 50 });
  const out = { profile: [], pitch: [], call_log: [], post_mortem: [], mail_thread: [] };
  const docs = res?.memories || [];
  for (const d of docs) {
    const kind = d?.metadata?.kind;
    if (kind && out[kind]) out[kind].push(d);
  }
  return out;
}

export async function getLatest(containerTag, kind) {
  const all = await listKinds(containerTag);
  return all[kind]?.[0] || null;
}

export async function createBusiness(profile) {
  const leadId = profile.id || `lead${Math.random().toString(36).slice(2, 10)}`;
  const containerTag = containerTagFor(leadId);
  await addDoc(containerTag, 'profile', profile, { businessName: profile.businessName });
  return { leadId, containerTag };
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
