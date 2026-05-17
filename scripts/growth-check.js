import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-growth-'));

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
  AGENTMAIL_API_KEY: '',
  AGENTMAIL_INBOX_ID: '',
  STRIPE_SECRET_KEY: '',
  BROWSER_USE_API_KEY: '',
  MOSS_PROJECT_ID: '',
  MOSS_PROJECT_KEY: ''
});

const { leads, contactEvents, growthPlans, growthFollowups } = await import('../server/db.js');
const { containerTagFor } = await import('../server/memory.js');
const {
  classifyGrowthReply,
  generateGrowthPlanForLead,
  recordGrowthCustomerResponse,
  sendGrowthRecap
} = await import('../server/growth/index.js');
const { collectRecommendations } = await import('../server/growth/schema.js');

try {
  const leadId = insertSyntheticLead({
    id: 'growth_synthetic_cafe',
    businessName: 'Mission Curl Room',
    status: 'shipped',
    website: 'https://mission-curl-room.example.test',
    research: {
      businessName: 'Mission Curl Room',
      niche: 'hair salon',
      city: 'San Francisco',
      hasWebsite: false,
      onlinePresenceStrength: 'weak',
      presenceConfidence: 0.83,
      onlinePresenceSummary: 'No owned website was found. Yelp-style listing has phone, sparse categories, no booking link, and no review request flow evidence.',
      hours: 'Unknown; not found in source.',
      signals: ['directory listing', 'no-owned-website-found'],
      needs: ['owned website', 'clear booking path', 'review request flow'],
      sourceUrl: 'https://www.yelp.com/biz/mission-curl-room-san-francisco'
    }
  });

  contactEvents.add({
    lead_id: leadId,
    type: 'customer_reply',
    direction: 'inbound',
    channel: 'agentmail',
    provider_id: 'msg_growth_question',
    thread_id: 'thread_growth',
    subject: 'Question after launch',
    body: 'Can you also help us get more local reviews and add a booking request form?',
    metadata: { synthetic: true }
  });

  const generated = await generateGrowthPlanForLead({ leadId, force: true, source: 'growth-check' });
  assert.equal(generated.plan.schemaVersion, 'growth_plan.v1');
  assert.ok(generated.plan.evidence.length >= 1, 'growth plan should include evidence');
  assert.ok(generated.offers.offers.length === 5, 'offer engine should return all five offers');
  assert.ok(generated.offers.nextRecommendedService?.id, 'next recommended service should be present');
  assertEveryRecommendationCitesEvidence(generated.plan);
  assert.ok(growthPlans.getLatest(leadId), 'growth plan should persist to SQLite');

  const followup = await sendGrowthRecap({ leadId });
  assert.equal(followup.status, 'sent');
  assert.ok(growthFollowups.listByLead(leadId).some((row) => row.status === 'sent'), 'growth recap should persist');

  const optOutLeadId = insertSyntheticLead({
    id: 'growth_optout_shop',
    businessName: 'No More Mail Repairs',
    status: 'shipped',
    risk_status: 'email-opt-out',
    next_action: 'do_not_email'
  });
  await generateGrowthPlanForLead({ leadId: optOutLeadId, force: true, source: 'growth-check' });
  const optOut = await sendGrowthRecap({ leadId: optOutLeadId });
  assert.equal(optOut.status, 'skipped');
  assert.match(optOut.reason, /opted_out|opt_out/i);

  const handoff = classifyGrowthReply('Can you guarantee first page Google rankings and review our legal contract terms?');
  assert.equal(handoff.kind, 'handoff');
  assert.equal(handoff.operatorFlag, true);

  const unsupportedLeadId = insertSyntheticLead({
    id: 'growth_unsupported_owner',
    businessName: 'Guarantee Me Plumbing',
    status: 'shipped'
  });
  contactEvents.add({
    lead_id: unsupportedLeadId,
    type: 'customer_reply',
    direction: 'inbound',
    channel: 'agentmail',
    provider_id: 'msg_unsupported',
    thread_id: 'thread_unsupported',
    subject: 'Guarantees',
    body: 'Can you guarantee first page Google ranking and give legal advice on our customer contract?',
    metadata: { synthetic: true }
  });
  const unsupportedPlan = await generateGrowthPlanForLead({ leadId: unsupportedLeadId, force: true, source: 'growth-check' });
  assert.equal(unsupportedPlan.plan.risk.handoffRequired, true);
  assert.ok(unsupportedPlan.plan.unsupportedFlags.length >= 1, 'unsupported flags should be recorded');

  const response = await recordGrowthCustomerResponse({
    leadId,
    subject: 'Growth recap',
    message: 'Interested. Send details about local SEO and review capture.',
    providerId: 'msg_growth_interested'
  });
  assert.equal(response.classification.kind, 'interested');
  assert.ok(growthFollowups.listByLead(leadId).some((row) => row.classification === 'interested'), 'customer response should persist');

  console.log('\n=== GROWTH CHECK RESULTS ===\n');
  console.log(`[PASS] synthetic business produced growth plan ${generated.row.id}`);
  console.log(`[PASS] ${collectRecommendations(generated.plan).length} recommendations cite valid evidence`);
  console.log(`[PASS] opt-out blocked post-delivery recap for ${optOutLeadId}`);
  console.log(`[PASS] unsupported legal/guarantee ask routed to handoff`);
  console.log(`[PASS] customer response classified and persisted as ${response.classification.kind}`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

function insertSyntheticLead({
  id,
  businessName,
  status = 'discovered',
  website = null,
  risk_status = 'pending',
  next_action = 'growth_plan',
  research = null
}) {
  const result = leads.insert({
    id,
    container_tag: containerTagFor(id),
    business_name: businessName,
    phone: syntheticPhone(id),
    address: '1 Market St, San Francisco, CA',
    niche: research?.niche || 'local services',
    city: research?.city || 'San Francisco',
    website,
    status,
    research_status: 'complete',
    outreach_status: 'not_queued',
    risk_status,
    consent_status: 'public_business',
    phone_classification: 'business',
    next_action,
    source_url: research?.sourceUrl || 'https://example.test/local-listing',
    online_presence_strength: research?.onlinePresenceStrength || 'weak',
    presence_confidence: research?.presenceConfidence || 0.75,
    research_json: JSON.stringify(research || {
      businessName,
      niche: 'local services',
      city: 'San Francisco',
      hasWebsite: Boolean(website),
      websiteUrl: website,
      onlinePresenceStrength: 'weak',
      presenceConfidence: 0.75,
      onlinePresenceSummary: 'Synthetic weak-presence lead for growth verification.',
      hours: 'Unknown; not found in source.',
      signals: ['synthetic lead'],
      needs: ['local SEO', 'review capture', 'contact path'],
      sourceUrl: 'https://example.test/local-listing'
    })
  });
  return result.lead.id;
}

function assertEveryRecommendationCitesEvidence(plan) {
  const evidenceIds = new Set((plan.evidence || []).map((item) => item.id));
  for (const item of collectRecommendations(plan)) {
    assert.ok(Array.isArray(item.evidenceIds) && item.evidenceIds.length > 0, `${item.id} is missing evidenceIds`);
    for (const id of item.evidenceIds) {
      assert.ok(evidenceIds.has(id), `${item.id} cites unknown evidence id ${id}`);
    }
  }
}

function syntheticPhone(id) {
  let sum = 0;
  for (const ch of String(id)) sum = (sum + ch.charCodeAt(0)) % 9000;
  return `+14155${String(100000 + sum).slice(-6)}`;
}
