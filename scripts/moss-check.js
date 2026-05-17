#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-moss-check-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BUILDS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false',
  GEMINI_API_KEY: '',
  SUPERMEMORY_API_KEY: '',
  AGENTPHONE_API_KEY: '',
  MOSS_PROJECT_ID: '',
  MOSS_PROJECT_KEY: '',
  BROWSER_USE_API_KEY: '',
  AGENTMAIL_API_KEY: '',
  STRIPE_SECRET_KEY: '',
  MOSS_FORCE_MOCK: 'true',
  CALLER_MOCK_TURN_DELAY_MS: '1'
});

const fetchCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  fetchCalls.push(String(url));
  if (/\b(search|bing|brave|exa|perplexity|googleapis|yelp|maps)\b/i.test(String(url))) {
    throw new Error(`web search attempted during Moss check: ${url}`);
  }
  if (!originalFetch) throw new Error(`unexpected fetch during Moss check: ${url}`);
  return originalFetch(input, init);
};

const results = [];

try {
  const [
    dbModule,
    pitchModule,
    complianceModule,
    hotIndexModule,
    retrievalModule,
    mossProvider,
    callerModule
  ] = await Promise.all([
    import('../server/db.js'),
    import('../server/pitch.js'),
    import('../server/compliance.js'),
    import('../server/moss/hotIndex.js'),
    import('../server/moss/retrieval.js'),
    import('../server/providers/moss.js'),
    import('../server/workers/caller.js')
  ]);

  const { leads, mossRetrievals, mossSnippets } = dbModule;
  const { createFallbackPitch } = pitchModule;
  const { recordingDisclosure } = complianceModule;
  const { ensureLeadHotIndex, mossIndexNameForLead, mossStatusForLead } = hotIndexModule;
  const {
    getObjectionSnippet,
    getPreCallContext,
    getPricingSnippet
  } = retrievalModule;
  const { deleteMossIndex, listMossIndexes } = mossProvider;
  const { runCaller } = callerModule;

  const leadId = `lead_moss_${Date.now().toString(36)}`;
  const profile = {
    businessName: 'Moss Check Plumbing',
    city: 'San Francisco',
    niche: 'plumbing repair',
    phone: '+14155550188',
    address: '100 Market St, San Francisco, CA',
    hasWebsite: false,
    onlinePresenceStrength: 'weak',
    onlinePresenceSummary: 'No owned site explains emergency plumbing, service area, or same-day booking.',
    whatTheyDo: 'Emergency plumbing, leak repair, and drain clearing.',
    needs: ['emergency repair copy', 'tap-to-call CTA', 'trust proof', 'service areas'],
    signals: ['weak owned presence', 'reviews mention urgent repairs']
  };
  const insert = leads.insert({
    id: leadId,
    container_tag: `biz_${leadId}`,
    business_name: profile.businessName,
    phone: profile.phone,
    address: profile.address,
    niche: profile.niche,
    city: profile.city,
    website: null,
    research_status: 'complete',
    outreach_status: 'queued',
    risk_status: 'callable',
    consent_status: 'operator_demo',
    phone_classification: 'business',
    research_json: JSON.stringify(profile)
  });
  assert(insert.lead.id === leadId, 'lead insert failed');

  const disclosure = recordingDisclosure(profile.businessName);
  const pitch = createFallbackPitch({ disclosure, profile, lead: insert.lead });
  const indexName = mossIndexNameForLead(leadId);

  const index = await ensureLeadHotIndex(leadId, { lead: insert.lead, profile, pitch, runId: 'moss_check' });
  assert(index.indexName === indexName, 'hot index name mismatch');
  assert(index.activeDocs.length >= 10, `expected hot docs, got ${index.activeDocs.length}`);
  pass('mock.index.create', { indexName, docs: index.activeDocs.length });

  const preCall = await getPreCallContext(leadId, { source: 'moss_check' });
  const pricing = await getPricingSnippet(leadId, { query: 'How much does this cost?', source: 'moss_check' });
  const objection = await getObjectionSnippet(leadId, 'I already have a website', { source: 'moss_check' });
  assert(preCall.snippets.length > 0, 'pre-call Moss query had no snippets');
  assert(pricing.snippets.some((doc) => /500|invoice|price|flat/i.test(doc.text)), 'pricing query did not return pricing snippet');
  assert(objection.snippets.length > 0, 'objection query had no snippets');
  pass('mock.index.query', {
    preCall: preCall.snippetIds,
    pricing: pricing.snippetIds,
    objection: objection.snippetIds,
    latencyMs: pricing.latencyMs
  });

  await deleteMossIndex(indexName, { forceMock: true });
  const afterDelete = await listMossIndexes({ forceMock: true });
  assert(!afterDelete.some((row) => row.name === indexName), 'mock Moss index was not deleted');
  pass('mock.index.delete', { indexName });

  const callerResult = await runCaller({ leadId, toPhone: profile.phone });
  assert(callerResult.callId, 'caller did not return a call id');
  const callerRetrievals = mossRetrievals.listByLead(leadId, { call_id: callerResult.callId, limit: 50 });
  assert(callerRetrievals.length > 0, 'caller produced no Moss retrievals');
  assert(callerRetrievals.some((row) => row.snippetIds.length > 0), 'caller did not consume Moss snippets');
  const usedSnippets = mossSnippets.listByLead(leadId).filter((snippet) => snippet.use_count > 0);
  assert(usedSnippets.length > 0, 'Moss snippets were not marked used');
  pass('caller.consumes_moss', {
    callId: callerResult.callId,
    retrievals: callerRetrievals.length,
    usedSnippets: usedSnippets.map((snippet) => snippet.snippet_id).slice(0, 8)
  });

  const status = mossStatusForLead(leadId);
  assert(status.index?.status === 'ready', 'Moss status endpoint model is not ready after caller re-created index');
  assert(status.retrievals.length >= callerRetrievals.length, 'Moss status model is missing retrieval timeline');
  pass('status.read_model', {
    active: status.activeCount,
    dead: status.deadCount,
    retrievals: status.retrievals.length
  });

  const webSearchFetches = fetchCalls.filter((url) => /\b(search|bing|brave|exa|perplexity|yelp|maps)\b/i.test(url));
  assert(webSearchFetches.length === 0, `web search fetches detected: ${webSearchFetches.join(', ')}`);
  pass('no_web_search', { fetchCalls: fetchCalls.length, webSearchFetches: webSearchFetches.length });

  console.log(JSON.stringify({ ok: true, dataDir, checks: results }, null, 2));
} catch (err) {
  console.error(JSON.stringify({ ok: false, dataDir, checks: results, error: err?.stack || err?.message || String(err) }, null, 2));
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  rmSync(dataDir, { recursive: true, force: true });
}

function pass(name, detail = {}) {
  results.push({ name, ok: true, detail });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
