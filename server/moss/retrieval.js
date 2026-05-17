import { createHash } from 'node:crypto';
import { leads, mossHotIndexes, mossRetrievals, mossSnippets } from '../db.js';
import { emit } from '../sse.js';
import {
  ensureMossIndex,
  mossRuntimeMode,
  normalizeMossSearchResult,
  queryMossIndex
} from '../providers/moss.js';
import { ensureLeadHotIndex } from './hotIndex.js';

const DEFAULT_TOP_K = 3;
const DEFAULT_ALPHA = 0.82;

export async function getPreCallContext(leadId, options = {}) {
  const retrieval = await retrieveLeadMoss(leadId, {
    intent: 'pre_call_context',
    query: options.query || 'lead facts pitch snippets objections compliance pricing call strategy',
    topK: options.topK || 10,
    alpha: options.alpha ?? 0.72,
    callId: options.callId || null,
    source: options.source || 'pre_call'
  });
  const snippets = mossSnippets.listByLead(leadId, { status: 'active', limit: 250 });
  return {
    ...retrieval,
    bundle: {
      leadFacts: topByKind(snippets, 'lead_fact', 3),
      pitchSnippets: topByKind(snippets, 'pitch_snippet', 5),
      objections: topByKind(snippets, 'objection', 5),
      complianceLines: topByKind(snippets, 'compliance', 4),
      pricingLines: topByKind(snippets, 'invoice_pricing', 4),
      callStrategy: topByKind(snippets, 'call_strategy', 3),
      customerFacts: topByKind(snippets, 'customer_need', 5)
    }
  };
}

export async function getObjectionSnippet(leadId, objection, options = {}) {
  return retrieveLeadMoss(leadId, {
    intent: 'objection',
    query: objection || 'customer objection',
    topK: options.topK || DEFAULT_TOP_K,
    alpha: options.alpha ?? DEFAULT_ALPHA,
    filter: kindFilter('objection'),
    callId: options.callId || null,
    source: options.source || 'transcript_objection'
  });
}

export async function getComplianceSnippet(intent, options = {}) {
  if (options.leadId) {
    return retrieveLeadMoss(options.leadId, {
      intent: `compliance:${intent || 'general'}`,
      query: intent || 'recording disclosure opt out compliance',
      topK: options.topK || 2,
      alpha: options.alpha ?? 0.78,
      filter: kindFilter('compliance'),
      callId: options.callId || null,
      source: options.source || 'compliance'
    });
  }
  return retrieveGlobalCompliance(intent, options);
}

export async function getPricingSnippet(leadId, options = {}) {
  return retrieveLeadMoss(leadId, {
    intent: 'pricing',
    query: options.query || 'price cost invoice payment flat fee website',
    topK: options.topK || 3,
    alpha: options.alpha ?? 0.76,
    filter: kindFilter('invoice_pricing'),
    callId: options.callId || null,
    source: options.source || 'pricing'
  });
}

export async function getCustomerNeedSnippet(leadId, question, options = {}) {
  return retrieveLeadMoss(leadId, {
    intent: 'customer_need',
    query: question || 'customer needs facts services',
    topK: options.topK || 3,
    alpha: options.alpha ?? DEFAULT_ALPHA,
    filter: kindFilter('customer_need'),
    callId: options.callId || null,
    source: options.source || 'customer_question'
  });
}

export async function retrieveLeadMoss(leadId, { intent, query, topK = DEFAULT_TOP_K, alpha = DEFAULT_ALPHA, filter = null, callId = null, source = null } = {}) {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`lead not found: ${leadId}`);
  let index = mossHotIndexes.getByLead(leadId);
  if (!index || index.status !== 'ready') {
    await ensureLeadHotIndex(leadId, { lead, callId });
    index = mossHotIndexes.getByLead(leadId);
  }
  if (!index) throw new Error(`Moss hot index missing for lead ${leadId}`);
  return retrieveFromMossIndex({
    leadId,
    callId,
    indexName: index.index_name,
    intent,
    query,
    topK,
    alpha,
    filter,
    source
  });
}

async function retrieveGlobalCompliance(intent, { topK = 2, alpha = 0.78, callId = null, source = 'global_compliance' } = {}) {
  const indexName = 'cmm_hot_compliance';
  const docs = [
    {
      id: 'global.recording_disclosure',
      text: 'Start outbound calls with the recording disclosure before the sales pitch.',
      metadata: { kind: 'compliance', title: 'Recording disclosure', complianceIntent: 'recording_disclosure' }
    },
    {
      id: 'global.opt_out',
      text: 'If a person asks not to be called, stop the pitch, end politely, and persist do-not-call.',
      metadata: { kind: 'compliance', title: 'Opt-out handling', complianceIntent: 'opt_out' }
    },
    {
      id: 'global.email_readback',
      text: 'Read invoice email addresses back exactly and ask for confirmation before sending the invoice.',
      metadata: { kind: 'compliance', title: 'Email readback', complianceIntent: 'email_readback' }
    }
  ];
  await ensureMossIndex(indexName, docs, { load: true });
  return retrieveFromMossIndex({
    leadId: null,
    callId,
    indexName,
    intent: `compliance:${intent || 'general'}`,
    query: intent || 'recording disclosure opt out email readback',
    topK,
    alpha,
    filter: kindFilter('compliance'),
    source
  });
}

async function retrieveFromMossIndex({ leadId, callId, indexName, intent, query, topK, alpha, filter, source }) {
  const started = Date.now();
  const cleanQuery = cleanText(query).slice(0, 1000) || intent || 'moss retrieval';
  const cleanTopK = clampInt(topK, 1, 20);
  const cleanAlpha = clampAlpha(alpha);
  try {
    const result = await queryMossIndex(indexName, cleanQuery, {
      topK: cleanTopK,
      alpha: cleanAlpha,
      filter
    });
    const normalized = normalizeMossSearchResult(result);
    const latencyMs = normalized.timeTakenInMs || Math.max(1, Date.now() - started);
    const snippetIds = normalized.docs.map((doc) => doc.id);
    if (leadId) mossSnippets.markUsed(leadId, snippetIds);
    const mode = mossRuntimeMode();
    const retrieval = mossRetrievals.record({
      dedupe_key: retrievalKey({ leadId, callId, indexName, intent, query: cleanQuery, topK: cleanTopK, alpha: cleanAlpha }),
      lead_id: leadId,
      call_id: callId,
      index_name: indexName,
      intent,
      query: cleanQuery,
      top_k: cleanTopK,
      alpha: cleanAlpha,
      latency_ms: latencyMs,
      snippet_ids: snippetIds,
      mode,
      source,
      outcome: snippetIds.length ? 'hit' : 'miss',
      metadata: { filter, noWebSearch: true }
    });
    emit('moss.retrieval', {
      worker: 'moss',
      leadId,
      callId,
      indexName,
      intent,
      query: cleanQuery,
      topK: cleanTopK,
      alpha: cleanAlpha,
      latencyMs,
      snippetIds,
      resultCount: snippetIds.length,
      mode,
      source,
      noWebSearch: true
    });
    return {
      retrievalId: retrieval?.id || null,
      leadId,
      callId,
      indexName,
      intent,
      query: cleanQuery,
      topK: cleanTopK,
      alpha: cleanAlpha,
      latencyMs,
      snippetIds,
      snippets: normalized.docs,
      mode,
      source,
      noWebSearch: true
    };
  } catch (err) {
    const latencyMs = Math.max(1, Date.now() - started);
    mossRetrievals.record({
      dedupe_key: retrievalKey({ leadId, callId, indexName, intent, query: cleanQuery, topK: cleanTopK, alpha: cleanAlpha }),
      lead_id: leadId,
      call_id: callId,
      index_name: indexName,
      intent,
      query: cleanQuery,
      top_k: cleanTopK,
      alpha: cleanAlpha,
      latency_ms: latencyMs,
      snippet_ids: [],
      mode: mossRuntimeMode(),
      source,
      outcome: 'error',
      metadata: { error: err?.message || String(err), filter, noWebSearch: true }
    });
    emit('moss.retrieval.error', {
      worker: 'moss',
      leadId,
      callId,
      indexName,
      intent,
      query: cleanQuery,
      topK: cleanTopK,
      alpha: cleanAlpha,
      latencyMs,
      error: err?.message || String(err),
      source,
      noWebSearch: true
    });
    throw err;
  }
}

function topByKind(snippets, kind, limit) {
  return (snippets || [])
    .filter((snippet) => snippet.kind === kind && snippet.status !== 'dead')
    .sort((a, b) => (b.help_score - a.help_score) || (b.use_count - a.use_count) || (b.updated_at - a.updated_at))
    .slice(0, limit);
}

function kindFilter(kind) {
  return { field: 'kind', condition: { $eq: kind } };
}

function retrievalKey({ leadId, callId, indexName, intent, query, topK, alpha }) {
  const hash = createHash('sha1')
    .update([leadId || 'global', callId || 'pre', indexName, intent, query, topK, alpha].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `moss:${leadId || 'global'}:${callId || 'pre'}:${intent}:${hash}`;
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

function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}
