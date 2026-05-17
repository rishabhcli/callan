import { createHash, randomUUID } from 'node:crypto';
import Supermemory from 'supermemory';
import { env } from './env.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import {
  leads,
  memoryDocuments,
  memoryFailures,
  memorySearches,
  memoryWriteQueue
} from './db.js';
import { enrichBusinessProfile } from './profileEnrichment.js';
import { withProviderRetry, normalizeProviderError } from './providers/core.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SUPERMEMORY_TIMEOUT_MS || 15000);
const TAG_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const ID_PART_RE = /[^A-Za-z0-9._:-]/g;

export const MEMORY_KINDS = Object.freeze([
  'research_evidence',
  'business_profile',
  'presence_score',
  'pitch',
  'call_transcript',
  'call_analysis',
  'mail_thread',
  'invoice',
  'build_brief',
  'build_result',
  'growth_plan',
  'compliance_decision'
]);

const KIND_ALIASES = Object.freeze({
  profile: 'business_profile',
  call_log: 'call_transcript',
  post_mortem: 'call_analysis'
});

const KINDS = new Set(MEMORY_KINDS);
const LEGACY_KIND_KEYS = Object.keys(KIND_ALIASES);

const KIND_CATEGORY = Object.freeze({
  research_evidence: 'research',
  business_profile: 'research',
  presence_score: 'research',
  pitch: 'sales',
  call_transcript: 'call',
  call_analysis: 'call',
  mail_thread: 'mail',
  invoice: 'payment',
  build_brief: 'build',
  build_result: 'build',
  growth_plan: 'growth',
  compliance_decision: 'compliance'
});

const FILTER_CONTEXT_BY_KIND = Object.freeze({
  research_evidence: { category: 'research' },
  business_profile: { category: 'research' },
  presence_score: { category: 'research' },
  pitch: { category: ['research', 'sales'] },
  call_transcript: { category: ['sales', 'call'] },
  call_analysis: { category: ['sales', 'call'] },
  mail_thread: { category: ['call', 'mail', 'payment'] },
  invoice: { category: ['mail', 'payment'] },
  build_brief: { category: ['research', 'sales', 'build'] },
  build_result: { category: ['build'] },
  growth_plan: { category: ['research', 'sales', 'call', 'mail', 'build', 'growth'] },
  compliance_decision: { category: 'compliance' }
});

let _client;
let _providerOverride = null;

function client() {
  if (!_client) {
    if (!env.supermemory.apiKey) throw new Error('SUPERMEMORY_API_KEY missing');
    _client = new Supermemory({
      apiKey: env.supermemory.apiKey,
      baseURL: 'https://api.supermemory.ai',
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 2
    });
  }
  return _client;
}

export function containerTagFor(leadId) {
  const safeLeadId = safeIdPart(leadId || `lead_${randomUUID().slice(0, 8)}`);
  const tag = `lead:${safeLeadId}`;
  if (!TAG_RE.test(tag)) throw new Error(`bad containerTag: ${tag}`);
  return tag;
}

export function leadIdFromContainerTag(containerTag) {
  assertContainerTag(containerTag);
  if (containerTag.startsWith('lead:')) return containerTag.slice(5);
  if (containerTag.startsWith('biz_')) return containerTag.slice(4);
  return null;
}

export function canonicalMemoryKind(kind) {
  const canonical = KIND_ALIASES[kind] || kind;
  if (!KINDS.has(canonical)) throw new Error(`bad kind: ${kind}`);
  return canonical;
}

export function customIdFor(kind, leadId, sourceId) {
  const canonical = canonicalMemoryKind(kind);
  const safeLeadId = safeIdPart(leadId || 'unknown');
  const safeSource = safeIdPart(sourceId || stableHash(`${canonical}:${safeLeadId}`));
  const customId = `${canonical}:${safeLeadId}:${safeSource}`;
  if (customId.length <= 100) return customId;
  return `${canonical}:${safeLeadId.slice(0, 28)}:${stableHash(customId)}`.slice(0, 100);
}

export async function addDoc(containerTag, kind, content, metadata = {}, options = {}) {
  const prepared = prepareMemoryWrite({ containerTag, kind, content, metadata });
  const queueRow = memoryWriteQueue.upsert({
    ...prepared,
    status: 'queued',
    attempt_count: prepared.attempt_count || 0,
    next_attempt_at: Date.now()
  });
  let doc = memoryDocuments.upsert({
    ...prepared,
    provider_status: 'queued',
    write_status: 'queued',
    attempt_count: queueRow?.attempt_count || 0
  });

  emit('memory.write.queued', memoryEventPayload(prepared, {
    providerStatus: 'queued',
    writeStatus: 'queued'
  }));

  try {
    const provider = providerForRequest();
    const res = await provider.add(prepared);
    const providerStatus = res?.status || 'done';
    const writeStatus = provider.synthetic ? 'mocked' : 'succeeded';
    const attemptCount = (queueRow?.attempt_count || 0) + 1;
    memoryWriteQueue.mark(prepared.custom_id, {
      status: writeStatus,
      attempt_count: attemptCount,
      provider_document_id: res?.id || prepared.custom_id,
      last_error: null
    });
    memoryFailures.resolveByCustomId(prepared.custom_id, 'write');
    doc = memoryDocuments.markProviderStatus(prepared.custom_id, {
      provider_document_id: res?.id || prepared.custom_id,
      provider_status: providerStatus,
      write_status: writeStatus,
      attempt_count: attemptCount,
      last_error: null,
      last_provider_checked_at: Date.now()
    });
    emit('memory.write.succeeded', memoryEventPayload(prepared, {
      providerDocumentId: res?.id || prepared.custom_id,
      providerStatus,
      writeStatus,
      synthetic: !!provider.synthetic
    }));
    log.info('memory.add', {
      containerTag: prepared.container_tag,
      kind: prepared.kind,
      customId: prepared.custom_id,
      providerDocumentId: res?.id,
      status: writeStatus
    });
    return providerResult(doc, res);
  } catch (err) {
    const failure = classifySupermemoryError(err);
    const attemptCount = (queueRow?.attempt_count || 0) + 1;
    const retryAt = Date.now() + retryDelayMs(attemptCount, failure.retryable);
    memoryWriteQueue.mark(prepared.custom_id, {
      status: failure.retryable ? 'failed' : 'dead',
      attempt_count: attemptCount,
      next_attempt_at: retryAt,
      last_error: failure.message
    });
    doc = memoryDocuments.markProviderStatus(prepared.custom_id, {
      provider_status: failure.outcome,
      write_status: 'failed',
      attempt_count: attemptCount,
      last_error: failure.message,
      last_provider_checked_at: Date.now()
    });
    memoryFailures.add({
      lead_id: prepared.lead_id,
      container_tag: prepared.container_tag,
      custom_id: prepared.custom_id,
      kind: prepared.kind,
      action: 'write',
      category: failure.category,
      retryable: failure.retryable,
      error: failure.message,
      source_event: prepared.source_event,
      attempt_count: attemptCount,
      payload: {
        metadata: prepared.metadata,
        filterByMetadata: prepared.filter_by_metadata,
        providerStatus: failure.outcome
      }
    });
    emit('memory.write.failed', memoryEventPayload(prepared, {
      providerStatus: failure.outcome,
      writeStatus: 'failed',
      category: failure.category,
      retryable: failure.retryable,
      error: failure.message
    }));
    log.warn('memory.add.failed', {
      containerTag: prepared.container_tag,
      kind: prepared.kind,
      customId: prepared.custom_id,
      category: failure.category,
      retryable: failure.retryable,
      error: failure.message
    });
    if (options.throwOnFailure) throw err;
    return providerResult(doc, null, failure);
  }
}

export async function search(containerTag, query, { kind, limit = 5, filters = null } = {}) {
  const started = Date.now();
  assertContainerTag(containerTag);
  const leadId = leadIdFromContainerTag(containerTag);
  const canonicalKind = kind ? canonicalMemoryKind(kind) : null;
  const cleanQuery = String(query || '').slice(0, 1000);
  const requestFilters = buildSearchFilters({ kind: canonicalKind, filters });
  const searchId = `memsearch_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

  try {
    const provider = providerForRequest();
    const res = await provider.search({
      containerTag,
      q: cleanQuery,
      limit: clampLimit(limit),
      filters: requestFilters,
      kind: canonicalKind
    });
    const rawResults = res?.results || [];
    const bleedDetected = rawResults.some((result) => !belongsToContainer(result, containerTag));
    const results = normalizeResults(rawResults, containerTag, canonicalKind);
    const row = memorySearches.add({
      id: searchId,
      lead_id: leadId || 'unknown',
      container_tag: containerTag,
      query: cleanQuery,
      kind: canonicalKind,
      filters: requestFilters,
      result_count: results.length,
      results: compactSearchResults(results),
      status: bleedDetected ? 'isolation_failed' : 'succeeded',
      bleed_detected: bleedDetected,
      duration_ms: Date.now() - started
    });
    emit('memory.search.succeeded', {
      worker: 'memory',
      leadId,
      containerTag,
      kind: canonicalKind,
      query: cleanQuery,
      resultCount: results.length,
      bleedDetected,
      searchId: row.id,
      synthetic: !!provider.synthetic
    });
    return results;
  } catch (err) {
    const failure = classifySupermemoryError(err);
    memorySearches.add({
      id: searchId,
      lead_id: leadId || 'unknown',
      container_tag: containerTag,
      query: cleanQuery,
      kind: canonicalKind,
      filters: requestFilters,
      status: 'failed',
      error: failure.message,
      duration_ms: Date.now() - started
    });
    memoryFailures.add({
      lead_id: leadId,
      container_tag: containerTag,
      kind: canonicalKind,
      action: 'search',
      category: failure.category,
      retryable: failure.retryable,
      error: failure.message,
      payload: { query: cleanQuery, filters: requestFilters }
    });
    emit('memory.search.failed', {
      worker: 'memory',
      leadId,
      containerTag,
      kind: canonicalKind,
      query: cleanQuery,
      category: failure.category,
      retryable: failure.retryable,
      error: failure.message
    });
    throw err;
  }
}

export async function listKinds(containerTag) {
  assertContainerTag(containerTag);
  const provider = providerForRequest();
  let docs = [];
  try {
    docs = await provider.list({ containerTag, limit: 100 });
    for (const doc of docs) mirrorProviderDocument(containerTag, doc);
    emit('memory.status.checked', {
      worker: 'memory',
      leadId: leadIdFromContainerTag(containerTag),
      containerTag,
      documentCount: docs.length,
      synthetic: !!provider.synthetic
    });
  } catch (err) {
    const failure = classifySupermemoryError(err);
    memoryFailures.add({
      lead_id: leadIdFromContainerTag(containerTag),
      container_tag: containerTag,
      action: 'status',
      category: failure.category,
      retryable: failure.retryable,
      error: failure.message
    });
    emit('memory.status.failed', {
      worker: 'memory',
      leadId: leadIdFromContainerTag(containerTag),
      containerTag,
      category: failure.category,
      retryable: failure.retryable,
      error: failure.message
    });
    docs = memoryDocuments.listByContainer(containerTag);
  }

  const out = emptyKindMap();
  const normalizedDocs = normalizeResults(docs, containerTag);
  for (const d of normalizedDocs) {
    const kind = canonicalKindFromMetadata(d?.metadata);
    if (kind && out[kind]) {
      const normalized = normalizeDocShape(d, kind);
      out[kind].push(normalized);
      const legacy = LEGACY_KIND_KEYS.find((key) => KIND_ALIASES[key] === kind);
      if (legacy && out[legacy]) out[legacy].push(normalized);
    }
  }
  for (const docsForKind of Object.values(out)) docsForKind.sort((a, b) => timestampOf(b) - timestampOf(a));
  return out;
}

export async function getLatest(containerTag, kind) {
  const canonical = canonicalMemoryKind(kind);
  const all = await listKinds(containerTag);
  return all[canonical]?.[0] || all[kind]?.[0] || null;
}

export async function createBusiness(profile) {
  const leadId = profile.id || `lead_${Math.random().toString(36).slice(2, 10)}`;
  const containerTag = containerTagFor(leadId);
  await addDoc(containerTag, 'business_profile', profile, {
    businessName: profile.businessName,
    profileSource: 'provided',
    sourceId: 'provided_profile'
  });
  return { leadId, containerTag };
}

export async function retryFailedWrites({ limit = 25 } = {}) {
  const due = memoryWriteQueue.due({ limit });
  const results = [];
  for (const row of due) {
    memoryWriteQueue.mark(row.custom_id, {
      status: 'retrying',
      attempt_count: row.attempt_count,
      next_attempt_at: Date.now()
    });
    try {
      const res = await addDoc(row.container_tag, row.kind, row.content_text, {
        ...row.metadata,
        sourceId: row.source_id,
        sourceEvent: row.source_event,
        filterByMetadata: row.filter_by_metadata
      }, { throwOnFailure: true });
      results.push({ customId: row.custom_id, ok: true, providerDocumentId: res?.id || res?.provider_document_id });
    } catch (err) {
      results.push({ customId: row.custom_id, ok: false, error: err?.message || String(err) });
    }
  }
  return {
    attempted: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results
  };
}

export async function memoryForLead(leadId) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  const kinds = await listKinds(lead.container_tag);
  return {
    lead,
    containerTag: lead.container_tag,
    kinds,
    documents: memoryDocuments.listByLead(lead.id, { limit: 300 }),
    queue: memoryWriteQueue.list({ lead_id: lead.id, limit: 100 }),
    searches: memorySearches.listByLead(lead.id, { limit: 80 }),
    failures: memoryFailures.list({ lead_id: lead.id, limit: 100 }),
    isolation: isolationForLead(lead)
  };
}

export function memoryBusinesses() {
  const docCounts = mapByLead(memoryDocuments.countByLead());
  const searchCounts = mapByLead(memorySearches.countByLead());
  const failureCounts = mapByLead(memoryFailures.countByLead());
  return leads.list({ limit: 500 }).map((lead) => {
    const docs = docCounts.get(lead.id) || {};
    const searches = searchCounts.get(lead.id) || {};
    const failures = failureCounts.get(lead.id) || {};
    return {
      leadId: lead.id,
      businessName: lead.business_name,
      city: lead.city,
      niche: lead.niche,
      status: lead.status,
      researchStatus: lead.research_status,
      containerTag: lead.container_tag,
      expectedContainerTag: containerTagFor(lead.id),
      isolation: isolationForLead(lead),
      documentCount: docs.document_count || 0,
      writtenCount: docs.written_count || 0,
      queuedCount: docs.queued_count || 0,
      failedCount: docs.failed_count || 0,
      searchCount: searches.search_count || 0,
      failureCount: failures.failure_count || 0,
      unresolvedFailureCount: failures.unresolved_failure_count || 0,
      lastMemoryAt: docs.last_memory_at || null,
      lastSearchAt: searches.last_search_at || null,
      lastFailureAt: failures.last_failure_at || null
    };
  });
}

export function memoryObservability() {
  const businesses = memoryBusinesses();
  const docCounts = memoryDocuments.counts();
  const searchCounts = memorySearches.counts();
  const failureCounts = memoryFailures.counts();
  const queueCounts = Object.fromEntries(memoryWriteQueue.counts().map((row) => [row.status, row.n]));
  const isolation = businesses.reduce((acc, business) => {
    acc.total += 1;
    if (business.isolation.ok) acc.ok += 1;
    else acc.failed += 1;
    return acc;
  }, { total: 0, ok: 0, failed: 0 });
  return {
    provider: {
      configured: !!env.supermemory.apiKey,
      mode: env.supermemory.apiKey ? 'live' : 'synthetic',
      baseUrl: 'https://api.supermemory.ai',
      containerPolicy: 'containerTag = lead:<leadId>',
      customIdPolicy: '<kind>:<leadId>:<sourceId>',
      supportedKinds: MEMORY_KINDS
    },
    totals: {
      documents: docCounts.total || 0,
      written: docCounts.written || 0,
      queued: docCounts.queued || 0,
      failedWrites: docCounts.failed || 0,
      searches: searchCounts.total || 0,
      failedSearches: searchCounts.failed || 0,
      bleedDetectedSearches: searchCounts.bleed_detected || 0,
      failures: failureCounts.total || 0,
      unresolvedFailures: failureCounts.unresolved || 0,
      retryableFailures: failureCounts.retryable || 0,
      queue: queueCounts,
      isolation
    },
    businesses,
    failedWrites: memoryFailures.list({ unresolved: true, limit: 100 }),
    recentSearches: memorySearches.recent({ limit: 50 }),
    recentDocuments: memoryDocuments.listRecent({ limit: 50 })
  };
}

export function __setSupermemoryProviderForTest(provider) {
  _providerOverride = provider;
}

function prepareMemoryWrite({ containerTag, kind, content, metadata }) {
  assertContainerTag(containerTag);
  const canonical = canonicalMemoryKind(kind);
  const leadId = metadata.leadId || leadIdFromContainerTag(containerTag);
  if (!leadId) throw new Error(`cannot infer leadId from containerTag: ${containerTag}`);
  const sourceId = sourceIdFor(canonical, leadId, content, metadata);
  const customId = metadata.customId || customIdFor(canonical, leadId, sourceId);
  const normalized = normalizeDocForMemory(canonical, content, metadata);
  const contentText = typeof normalized.content === 'string'
    ? normalized.content
    : JSON.stringify(normalized.content, null, 2);
  const category = KIND_CATEGORY[canonical] || 'memory';
  const source = stringValue(metadata.source || metadata.profileSource || metadata.provider || metadata.channel || 'callmemaybe');
  const sourceEvent = stringValue(metadata.sourceEvent || metadata.eventType || `${canonical}.write`);
  const providerMetadata = stringifyMetadata({
    ...normalized.metadata,
    category,
    source,
    leadId,
    kind: canonical,
    sourceId,
    sourceEvent,
    containerTag,
    memoryScope: 'lead'
  });
  const filterByMetadata = normalizeFilterByMetadata(metadata.filterByMetadata || filteredContextForKind(canonical, leadId));
  const lead = leads.get(leadId);
  const entityContext = stringValue(metadata.entityContext || buildEntityContext({ lead, leadId, containerTag, kind: canonical, sourceId, metadata: providerMetadata }));
  return {
    custom_id: customId,
    lead_id: leadId,
    container_tag: containerTag,
    kind: canonical,
    source_id: sourceId,
    source_event: sourceEvent,
    content_text: contentText,
    metadata: providerMetadata,
    filter_by_metadata: filterByMetadata,
    entity_context: entityContext,
    simulate_failure: shouldSimulateFailure(metadata)
  };
}

function providerForRequest() {
  if (_providerOverride) return _providerOverride;
  if (!env.supermemory.apiKey) return syntheticProvider();
  return liveProvider();
}

function liveProvider() {
  return {
    synthetic: false,
    async add(prepared) {
      if (prepared.simulate_failure) throw simulatedFailure();
      return withProviderRetry('supermemory', 'addDoc', () => client().add({
        content: prepared.content_text,
        containerTag: prepared.container_tag,
        customId: prepared.custom_id,
        metadata: prepared.metadata,
        filterByMetadata: prepared.filter_by_metadata,
        entityContext: prepared.entity_context
      }, { timeout: DEFAULT_TIMEOUT_MS }), { classify: classifySupermemoryError });
    },
    async search({ containerTag, q, limit, filters }) {
      return withProviderRetry('supermemory', 'search', () => client().search.execute({
        q,
        containerTags: [containerTag],
        limit,
        filters,
        includeSummary: true,
        includeFullDocs: true
      }, { timeout: DEFAULT_TIMEOUT_MS }), { classify: classifySupermemoryError });
    },
    async list({ containerTag, limit }) {
      const res = await withProviderRetry('supermemory', 'listKinds', () => client().memories.list({
        containerTags: [containerTag],
        includeContent: true,
        limit
      }, { timeout: DEFAULT_TIMEOUT_MS }), { classify: classifySupermemoryError });
      return res?.memories || [];
    }
  };
}

function syntheticProvider() {
  return {
    synthetic: true,
    async add(prepared) {
      if (prepared.simulate_failure) throw simulatedFailure();
      return {
        id: `synthetic_${stableHash(prepared.custom_id)}`,
        status: 'done',
        customId: prepared.custom_id
      };
    },
    async search({ containerTag, q, limit, kind, filters }) {
      const results = localSearch({ containerTag, q, limit, kind, filters });
      return { results, total: results.length, timing: 0 };
    },
    async list({ containerTag, limit }) {
      return memoryDocuments.listByContainer(containerTag, { limit });
    }
  };
}

function localSearch({ containerTag, q, limit, kind }) {
  const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return memoryDocuments
    .listByContainer(containerTag, { limit: 500 })
    .filter((doc) => !kind || doc.kind === kind)
    .map((doc) => {
      const haystack = `${doc.content_text}\n${JSON.stringify(doc.metadata || {})}`.toLowerCase();
      const matches = terms.length ? terms.filter((term) => haystack.includes(term)).length : 1;
      const explicit = terms.length && terms.some((term) => haystack.includes(term));
      return { doc, matches, explicit };
    })
    .filter((row) => !terms.length || row.explicit)
    .sort((a, b) => b.matches - a.matches || (b.doc.updated_at || 0) - (a.doc.updated_at || 0))
    .slice(0, clampLimit(limit))
    .map(({ doc, matches }) => ({
      documentId: doc.provider_document_id || doc.custom_id,
      id: doc.provider_document_id || doc.custom_id,
      customId: doc.custom_id,
      content: doc.content_text,
      summary: doc.content_text.slice(0, 280),
      title: `${doc.kind} ${doc.source_id}`,
      score: terms.length ? matches / terms.length : 1,
      metadata: doc.metadata,
      containerTags: [doc.container_tag],
      createdAt: new Date(doc.first_seen_at).toISOString(),
      updatedAt: new Date(doc.updated_at).toISOString(),
      chunks: [{ content: doc.content_text.slice(0, 1000), isRelevant: true, score: terms.length ? matches / terms.length : 1 }]
    }));
}

function mirrorProviderDocument(containerTag, doc) {
  const metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  const kind = canonicalKindFromMetadata(metadata);
  if (!kind) return null;
  const leadId = metadata.leadId || leadIdFromContainerTag(containerTag);
  if (!leadId) return null;
  const sourceId = metadata.sourceId || doc.customId || doc.id || stableHash(doc.content || doc.summary || kind);
  const customId = doc.customId || customIdFor(kind, leadId, sourceId);
  return memoryDocuments.upsert({
    custom_id: customId,
    lead_id: leadId,
    container_tag: containerTag,
    kind,
    source_id: sourceId,
    source_event: metadata.sourceEvent || `${kind}.provider_status`,
    provider_document_id: doc.id || doc.documentId || null,
    provider_status: doc.status || 'done',
    write_status: doc.status === 'failed' ? 'failed' : 'succeeded',
    content_text: doc.content ?? doc.content_text ?? doc.summary ?? '',
    metadata,
    filter_by_metadata: filteredContextForKind(kind, leadId),
    entity_context: buildEntityContext({ lead: leads.get(leadId), leadId, containerTag, kind, sourceId, metadata }),
    last_error: doc.status === 'failed' ? 'provider marked failed' : null,
    attempt_count: 1,
    first_seen_at: Date.parse(doc.createdAt || doc.created_at || '') || Date.now(),
    updated_at: Date.parse(doc.updatedAt || doc.updated_at || '') || Date.now(),
    last_provider_checked_at: Date.now()
  });
}

function normalizeDocForMemory(kind, content, metadata) {
  if (kind !== 'business_profile') return { content, metadata: publicMemoryMetadata(metadata) };
  const {
    sourceText: _sourceText,
    filterByMetadata: _filterByMetadata,
    entityContext: _entityContext,
    customId: _customId,
    forceFailure: _forceFailure,
    forceProviderFailure: _forceProviderFailure,
    simulateFailure: _simulateFailure,
    ...persistedMetadata
  } = metadata || {};
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

function publicMemoryMetadata(metadata = {}) {
  const {
    customId: _customId,
    entityContext: _entityContext,
    filterByMetadata: _filterByMetadata,
    forceFailure: _forceFailure,
    forceProviderFailure: _forceProviderFailure,
    simulateFailure: _simulateFailure,
    ...rest
  } = metadata || {};
  return rest;
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

function buildSearchFilters({ kind, filters }) {
  const and = [];
  if (kind) and.push({ key: 'kind', value: kind, filterType: 'metadata', negate: false });
  for (const [key, value] of Object.entries(filters || {})) {
    if (value == null || key === 'kind') continue;
    and.push({ key, value, filterType: 'metadata', negate: false });
  }
  return and.length ? { AND: and } : undefined;
}

function normalizeResults(results, containerTag, kind) {
  return results
    .filter((doc) => belongsToContainer(doc, containerTag))
    .filter((doc) => !kind || canonicalKindFromMetadata(doc?.metadata) === kind)
    .map((doc) => normalizeDocShape(doc, canonicalKindFromMetadata(doc?.metadata)));
}

function normalizeDocShape(doc, kind) {
  const metadata = doc?.metadata || {};
  return {
    ...doc,
    id: doc?.id || doc?.documentId || doc?.provider_document_id || doc?.custom_id,
    documentId: doc?.documentId || doc?.provider_document_id || doc?.id || doc?.custom_id,
    customId: doc?.customId || doc?.custom_id || metadata.customId,
    content: doc?.content ?? doc?.content_text ?? doc?.summary ?? '',
    metadata: { ...metadata, kind: kind || metadata.kind },
    containerTags: doc?.containerTags || doc?.container_tags || [doc?.container_tag].filter(Boolean)
  };
}

function belongsToContainer(doc, containerTag) {
  const tags = doc?.containerTags || doc?.container_tags || [];
  if (Array.isArray(tags) && tags.length) return tags.includes(containerTag);
  const metadataTag = doc?.metadata?.containerTag || doc?.metadata?.container_tag;
  if (metadataTag) return metadataTag === containerTag;
  const rowTag = doc?.container_tag;
  if (rowTag) return rowTag === containerTag;
  return true;
}

function canonicalKindFromMetadata(metadata = {}) {
  const raw = metadata?.kind;
  if (!raw) return null;
  try { return canonicalMemoryKind(raw); } catch { return null; }
}

function emptyKindMap() {
  const out = {};
  for (const kind of MEMORY_KINDS) out[kind] = [];
  for (const legacy of LEGACY_KIND_KEYS) out[legacy] = [];
  return out;
}

function sourceIdFor(kind, leadId, content, metadata = {}) {
  const explicit = metadata.sourceId ||
    metadata.source_id ||
    metadata.callId ||
    metadata.call_id ||
    metadata.provider_call_id ||
    metadata.threadId ||
    metadata.thread_id ||
    metadata.messageId ||
    metadata.message_id ||
    metadata.invoiceId ||
    metadata.invoice_id ||
    metadata.paymentId ||
    metadata.payment_id ||
    metadata.buildId ||
    metadata.build_id ||
    metadata.generatedFor ||
    metadata.sourceUrl ||
    metadata.yelpUrl;
  if (explicit) return safeIdPart(explicit);
  return safeIdPart(`${kind}_${stableHash({ leadId, content })}`);
}

function filteredContextForKind(kind, leadId) {
  return normalizeFilterByMetadata({
    leadId,
    ...(FILTER_CONTEXT_BY_KIND[kind] || { category: KIND_CATEGORY[kind] || 'memory' })
  });
}

function normalizeFilterByMetadata(filter) {
  const out = {};
  for (const [key, value] of Object.entries(filter || {})) {
    if (value == null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.map((item) => String(item)).filter(Boolean).slice(0, 20);
  }
  return out;
}

function buildEntityContext({ lead, leadId, containerTag, kind, sourceId, metadata }) {
  const businessName = lead?.business_name || metadata.businessName || 'unknown business';
  const city = lead?.city || metadata.city || 'unknown city';
  const niche = lead?.niche || metadata.niche || 'local services';
  const status = lead?.status || 'unknown';
  const presence = lead?.online_presence_strength || metadata.onlinePresenceStrength || 'unknown';
  return [
    `Business memory for ${businessName}.`,
    `Lead ${leadId} is a ${niche} business in ${city}; status ${status}; online presence ${presence}.`,
    `Only remember facts for container ${containerTag}. Never merge facts from another lead.`,
    `Current memory kind: ${kind}; source: ${sourceId}.`,
    'Prioritize durable customer facts, evidence, outreach decisions, call/mail/payment/build outcomes, and follow-up obligations.'
  ].join(' ').slice(0, 1500);
}

function stringifyMetadata(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (v == null) continue;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
    else out[k] = String(v).slice(0, 500);
  }
  return out;
}

function compactSearchResults(results) {
  return (results || []).slice(0, 20).map((result) => ({
    id: result?.id || result?.documentId,
    documentId: result?.documentId || result?.id,
    customId: result?.customId || result?.metadata?.customId,
    kind: result?.metadata?.kind || null,
    score: result?.score ?? result?.similarity ?? null,
    title: result?.title || null,
    summary: String(result?.summary || result?.content || result?.chunks?.[0]?.content || '').slice(0, 500),
    metadata: result?.metadata || {}
  }));
}

function providerResult(doc, providerResponse, failure = null) {
  return {
    ...(providerResponse || {}),
    ...doc,
    id: providerResponse?.id || doc?.provider_document_id || doc?.custom_id,
    status: providerResponse?.status || doc?.provider_status,
    failure
  };
}

function memoryEventPayload(prepared, extra = {}) {
  return {
    worker: 'memory',
    leadId: prepared.lead_id,
    containerTag: prepared.container_tag,
    customId: prepared.custom_id,
    kind: prepared.kind,
    sourceId: prepared.source_id,
    sourceEvent: prepared.source_event,
    ...extra
  };
}

function mapByLead(rows) {
  return new Map(rows.map((row) => [row.lead_id, row]));
}

function isolationForLead(lead) {
  const expected = containerTagFor(lead.id);
  const actual = lead.container_tag;
  const ok = actual === expected && TAG_RE.test(actual);
  return {
    ok,
    expectedContainerTag: expected,
    actualContainerTag: actual,
    reason: ok ? 'per-lead containerTag matches lead:<leadId>' : 'containerTag does not match lead:<leadId>'
  };
}

function safeIdPart(value) {
  return String(value || 'unknown')
    .replace(ID_PART_RE, '_')
    .replace(/:+/g, ':')
    .slice(0, 80) || 'unknown';
}

function stableHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function stringValue(value) {
  return String(value || '').slice(0, 500);
}

function assertContainerTag(containerTag) {
  if (!TAG_RE.test(containerTag || '')) throw new Error(`bad containerTag: ${containerTag}`);
}

function clampLimit(limit, max = 50) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(1, Math.trunc(n)), max);
}

function timestampOf(doc) {
  return Date.parse(doc?.updatedAt || doc?.createdAt || doc?.updated_at || doc?.created_at || '') ||
    doc?.updated_at ||
    doc?.first_seen_at ||
    0;
}

function shouldSimulateFailure(metadata = {}) {
  return metadata.simulateFailure === true ||
    metadata.forceFailure === true ||
    metadata.forceProviderFailure === true ||
    metadata.source === 'supermemory-check-forced-failure';
}

function simulatedFailure() {
  const err = new Error('synthetic Supermemory write failure requested');
  err.status = 503;
  err.retryable = true;
  return err;
}

function retryDelayMs(attempt, retryable) {
  if (!retryable) return 365 * 24 * 60 * 60 * 1000;
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function classifySupermemoryError(err) {
  const normalized = normalizeProviderError(err);
  const msg = String(normalized.message || '').toLowerCase();
  const status = Number(normalized.status || 0) || null;
  const code = String(normalized.code || '').toLowerCase();

  let category = 'unknown';
  let retryable = normalized.retryable;
  if (status === 401 || status === 403 || /\b(auth|unauthorized|forbidden|api key|token)\b/.test(msg)) {
    category = 'auth';
    retryable = false;
  } else if (status === 429 || /\b(rate.?limit|too many requests|quota|usage|credits)\b/.test(msg)) {
    category = 'rate-limited';
    retryable = true;
  } else if (status === 404 || /\b(not.?found|missing document)\b/.test(msg)) {
    category = 'not-found';
    retryable = false;
  } else if (/\b(container.?tag|custom.?id|metadata|invalid|validation|bad request)\b/.test(msg)) {
    category = 'validation';
    retryable = false;
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
