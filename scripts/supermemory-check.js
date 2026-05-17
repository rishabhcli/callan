// Deterministic Supermemory memory-system check.
// Runs against the synthetic provider unless SUPERMEMORY_API_KEY is set by the caller.

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-supermemory-check-'));
process.env.DATA_DIR = dataDir;
process.env.RUN_MODE = process.env.RUN_MODE || 'mock';
process.env.SUPERMEMORY_API_KEY = process.env.SUPERMEMORY_API_KEY || '';

const { leads, memoryFailures, memoryWriteQueue } = await import('../server/db.js');
const {
  addDoc,
  containerTagFor,
  customIdFor,
  listKinds,
  memoryForLead,
  memoryObservability,
  search
} = await import('../server/memory.js');

const checks = [];

function pass(name, detail) {
  checks.push({ ok: true, name, detail });
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  checks.push({ ok: false, name, detail });
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}

function assert(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function contains(results, marker) {
  const needle = String(marker);
  return (results || []).some((result) => [
    result.content,
    result.summary,
    result.title,
    JSON.stringify(result.metadata || {}),
    ...(Array.isArray(result.chunks) ? result.chunks.map((chunk) => chunk?.content || '') : [])
  ].join('\n').includes(needle));
}

const stamp = Date.now().toString(36);
const leadA = `smcheck_${stamp}_a`;
const leadB = `smcheck_${stamp}_b`;
const tagA = containerTagFor(leadA);
const tagB = containerTagFor(leadB);

leads.insert({
  id: leadA,
  container_tag: tagA,
  business_name: 'Cobalt Robin Cafe',
  phone: '+14155550101',
  address: '1 Market St',
  niche: 'neighborhood cafe',
  city: 'San Francisco',
  website: null,
  status: 'discovered',
  research_status: 'complete',
  outreach_status: 'queued',
  risk_status: 'callable',
  source_url: 'https://example.test/cobalt-robin'
});

leads.insert({
  id: leadB,
  container_tag: tagB,
  business_name: 'Amber Otter Cafe',
  phone: '+14155550102',
  address: '2 Mission St',
  niche: 'neighborhood cafe',
  city: 'San Francisco',
  website: null,
  status: 'discovered',
  research_status: 'complete',
  outreach_status: 'queued',
  risk_status: 'callable',
  source_url: 'https://example.test/amber-otter'
});

await addDoc(tagA, 'business_profile', {
  businessName: 'Cobalt Robin Cafe',
  city: 'San Francisco',
  niche: 'neighborhood cafe',
  phone: '+14155550101',
  hasWebsite: false,
  whatTheyDo: 'Neighborhood espresso bar with the unique marker cobalt-robin and shared term espresso.'
}, { sourceId: 'profile', source: 'supermemory-check', sourceEvent: 'check.business_profile', profileSource: 'provided' });

await addDoc(tagA, 'research_evidence', {
  source: 'synthetic-directory',
  evidence: 'Cobalt Robin has no owned website; espresso appears in reviews; marker cobalt-robin.'
}, { sourceId: 'directory-evidence', source: 'supermemory-check', sourceEvent: 'check.research_evidence' });

await addDoc(tagA, 'pitch', {
  openingLine: 'Quick website question for Cobalt Robin',
  valueProp: 'A one-page site for espresso searches',
  close: 'Can I send the invoice link?'
}, { sourceId: 'sales-pitch', source: 'supermemory-check', sourceEvent: 'check.pitch' });

await addDoc(tagB, 'business_profile', {
  businessName: 'Amber Otter Cafe',
  city: 'San Francisco',
  niche: 'neighborhood cafe',
  phone: '+14155550102',
  hasWebsite: false,
  whatTheyDo: 'Neighborhood espresso bar with the unique marker amber-otter and shared term espresso.'
}, { sourceId: 'profile', source: 'supermemory-check', sourceEvent: 'check.business_profile', profileSource: 'provided' });

await addDoc(tagB, 'research_evidence', {
  source: 'synthetic-directory',
  evidence: 'Amber Otter has no owned website; espresso appears in reviews; marker amber-otter.'
}, { sourceId: 'directory-evidence', source: 'supermemory-check', sourceEvent: 'check.research_evidence' });

const kindsA = await listKinds(tagA);
const kindsB = await listKinds(tagB);
assert('new memory kinds are listed for lead A', kindsA.business_profile.length >= 1 && kindsA.research_evidence.length >= 1 && kindsA.pitch.length >= 1, JSON.stringify({
  business_profile: kindsA.business_profile.length,
  research_evidence: kindsA.research_evidence.length,
  pitch: kindsA.pitch.length
}));
assert('new memory kinds are listed for lead B', kindsB.business_profile.length >= 1 && kindsB.research_evidence.length >= 1, JSON.stringify({
  business_profile: kindsB.business_profile.length,
  research_evidence: kindsB.research_evidence.length
}));

const aOwnHits = await search(tagA, 'espresso cobalt-robin', { kind: 'research_evidence', limit: 5 });
const bOwnHits = await search(tagB, 'espresso amber-otter', { kind: 'research_evidence', limit: 5 });
const aBleedHits = await search(tagA, 'amber-otter', { limit: 5 });
const bBleedHits = await search(tagB, 'cobalt-robin', { limit: 5 });

assert('lead A retrieval finds its own marker', contains(aOwnHits, 'cobalt-robin'), `${aOwnHits.length} hit(s)`);
assert('lead B retrieval finds its own marker', contains(bOwnHits, 'amber-otter'), `${bOwnHits.length} hit(s)`);
assert('lead A retrieval has no lead B bleed', !contains(aBleedHits, 'amber-otter'), `${aBleedHits.length} scoped hit(s)`);
assert('lead B retrieval has no lead A bleed', !contains(bBleedHits, 'cobalt-robin'), `${bBleedHits.length} scoped hit(s)`);

await addDoc(tagA, 'growth_plan', {
  plan: 'This write is intentionally forced to fail so queue observability can be verified.'
}, {
  sourceId: 'forced-failure',
  source: 'supermemory-check-forced-failure',
  sourceEvent: 'check.forced_failure',
  simulateFailure: true
});

const failedCustomId = customIdFor('growth_plan', leadA, 'forced-failure');
const failedQueueRow = memoryWriteQueue.getByCustomId(failedCustomId);
const unresolvedFailures = memoryFailures.list({ lead_id: leadA, unresolved: true, limit: 20 });
assert('failed writes enter retry queue', failedQueueRow?.status === 'failed', JSON.stringify({
  customId: failedCustomId,
  status: failedQueueRow?.status,
  attempts: failedQueueRow?.attempt_count
}));
assert('failed writes are visible in memory_failures', unresolvedFailures.some((row) => row.custom_id === failedCustomId), `${unresolvedFailures.length} unresolved failure(s)`);

const leadMemory = await memoryForLead(leadA);
const observability = memoryObservability();
assert('per-lead ledger exposes documents/searches/failures', leadMemory.documents.length >= 4 && leadMemory.searches.length >= 2 && leadMemory.failures.length >= 1, JSON.stringify({
  documents: leadMemory.documents.length,
  searches: leadMemory.searches.length,
  failures: leadMemory.failures.length
}));
assert('observability reports container isolation', observability.totals.isolation.failed === 0, JSON.stringify(observability.totals.isolation));

const failed = checks.filter((check) => !check.ok);
console.log('\n=== SUPERMEMORY CHECK SUMMARY ===');
console.log(JSON.stringify({
  dataDir,
  leads: [leadA, leadB],
  containerTags: [tagA, tagB],
  passed: checks.length - failed.length,
  failed: failed.length,
  totals: observability.totals
}, null, 2));

if (failed.length) process.exit(1);
