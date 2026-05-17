import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-reasoning-'));

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dataDir;
process.env.RUN_MODE = 'mock';
process.env.GEMINI_API_KEY = '';
process.env.SUPERMEMORY_API_KEY = '';
process.env.LIVE_CALLS = 'false';
process.env.LIVE_EMAILS = 'false';
process.env.LIVE_PAYMENTS = 'false';
process.env.LIVE_BROWSER_SESSIONS = 'false';
process.env.LIVE_BUILDS = 'false';

let db;

try {
  const reasoning = await import('../server/reasoning/geminiReasoner.js');
  const schemas = await import('../server/reasoning/schemas.js');
  const dbModule = await import('../server/db.js');
  db = dbModule.db;

  const messyEvidence = {
    leadId: 'reasoning_lead_1',
    businessName: 'Mission Curl Room',
    phone: '+1 415 555 0199',
    city: 'San Francisco',
    niche: 'curl salon',
    sourceUrl: 'https://www.yelp.com/biz/mission-curl-room-san-francisco',
    websiteUrl: null,
    notes: [
      'Yelp-like listing shows phone and city. No owned website found.',
      'Possible Instagram mention, but no canonical URL in evidence.',
      'Owner name is not confirmed. Do not invent it.'
    ]
  };
  dbModule.leads.insert({
    id: messyEvidence.leadId,
    container_tag: `lead:${messyEvidence.leadId}`,
    business_name: messyEvidence.businessName,
    phone: messyEvidence.phone,
    address: null,
    niche: messyEvidence.niche,
    city: messyEvidence.city,
    website: null,
    status: 'discovered',
    research_status: 'researched',
    source_url: messyEvidence.sourceUrl,
    online_presence_strength: 'weak',
    presence_confidence: 0.72,
    research_json: JSON.stringify(messyEvidence)
  });

  const profile = await reasoning.generateStructured({
    kind: 'businessProfile',
    schema: schemas.BusinessProfile,
    evidence: messyEvidence,
    prompt: 'Build the structured business profile from messy local-business research.',
    leadId: messyEvidence.leadId,
    worker: 'reasoning-check',
    eventId: 'business-profile'
  });
  assert.equal(profile.trace.valid, true);
  assert.equal(profile.output.businessName, 'Mission Curl Room');
  assert.equal(profile.output.hasWebsite, false);
  schemas.BusinessProfile.parse(profile.output);

  const invalidJson = await reasoning.generateStructured({
    kind: 'emailReplyDecision',
    schema: schemas.EmailReplyDecision,
    evidence: {
      leadId: messyEvidence.leadId,
      businessName: messyEvidence.businessName,
      body: 'Can you add our services and confirm when the invoice is due?'
    },
    prompt: 'Classify this inbound AgentMail reply.',
    leadId: messyEvidence.leadId,
    worker: 'reasoning-check',
    eventId: 'invalid-json-repair',
    mockRawOutput: '```json\n{"schemaVersion":1,"kind":"supported" bad}\n```'
  });
  assert.equal(invalidJson.trace.valid, true);
  assert.equal(invalidJson.trace.repairAttempts, 1);
  assert.ok(invalidJson.trace.validationErrors.length >= 1);
  schemas.EmailReplyDecision.parse(invalidJson.output);

  const hallucinated = await reasoning.generateStructured({
    kind: 'websiteBrief',
    schema: schemas.WebsiteBrief,
    evidence: {
      leadId: messyEvidence.leadId,
      businessName: 'Mission Curl Room',
      city: 'San Francisco',
      niche: 'curl salon',
      sourceUrl: 'https://real.example/mission-curl-room',
      invoiceEmail: 'owner@real.example'
    },
    prompt: 'Create a paid website brief, using only supplied evidence.',
    leadId: messyEvidence.leadId,
    worker: 'reasoning-check',
    eventId: 'hallucinated-refs-repair',
    mockRawOutput: JSON.stringify(validWebsiteBrief({
      source: 'https://fake.example/not-in-evidence',
      quote: 'The owner said to use owner@fake.example and https://fake.example/not-in-evidence.',
      brief: 'Build the site and publish contact owner@fake.example at https://fake.example/not-in-evidence.'
    }))
  });
  assert.equal(hallucinated.trace.valid, true);
  assert.equal(hallucinated.trace.repairAttempts, 1);
  assert.ok(hallucinated.trace.validationErrors.some((err) => /URL not present in evidence/i.test(err)));
  assert.ok(hallucinated.trace.validationErrors.some((err) => /email not present in evidence/i.test(err)));
  assert.doesNotMatch(JSON.stringify(hallucinated.output), /fake\.example/i);
  schemas.WebsiteBrief.parse(hallucinated.output);

  const evidenceBacked = await reasoning.generateStructured({
    kind: 'websiteBrief',
    schema: schemas.WebsiteBrief,
    evidence: {
      leadId: messyEvidence.leadId,
      businessName: 'Mission Curl Room',
      city: 'San Francisco',
      niche: 'curl salon',
      sourceUrl: 'https://real.example/mission-curl-room',
      invoiceEmail: 'owner@real.example'
    },
    prompt: 'Create a paid website brief with evidence-backed references.',
    leadId: messyEvidence.leadId,
    worker: 'reasoning-check',
    eventId: 'evidence-backed-refs',
    mockRawOutput: JSON.stringify(validWebsiteBrief({
      source: 'https://real.example/mission-curl-room',
      quote: 'Evidence includes owner@real.example and https://real.example/mission-curl-room.',
      brief: 'Build a factual site for Mission Curl Room. Internal contact evidence owner@real.example and https://real.example/mission-curl-room are supplied.'
    }))
  });
  assert.equal(evidenceBacked.trace.valid, true);
  assert.equal(evidenceBacked.trace.repairAttempts, 0);
  assert.equal(evidenceBacked.trace.validationErrors.length, 0);
  schemas.WebsiteBrief.parse(evidenceBacked.output);

  const traces = dbModule.reasoningTraces.list({ lead_id: messyEvidence.leadId, limit: 20 });
  assert.ok(traces.length >= 4);
  assert.ok(traces.every((trace) => trace.provider === 'gemini'));

  console.log('[PASS] reasoning structured outputs validate, repair invalid JSON, and reject hallucinated refs.');
} finally {
  try { db?.close?.(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
}

function validWebsiteBrief({ source, quote, brief }) {
  return {
    brief,
    businessName: 'Mission Curl Room',
    targetCustomer: 'San Francisco customers looking for curl salon services.',
    sections: [
      { name: 'Hero', goal: 'Say what the salon does and how to contact it.', content: ['Mission Curl Room', 'curl salon', 'San Francisco'] },
      { name: 'Services', goal: 'Make the core service easy to understand.', content: ['curl care', 'consultations'] },
      { name: 'Contact', goal: 'Make the next step obvious.', content: ['phone call', 'simple inquiry form'] }
    ],
    style: {
      tone: 'warm and professional',
      palette: 'neutral with one lively accent',
      layout: 'clear hero, service sections, contact CTA'
    },
    factualClaims: ['Mission Curl Room', 'curl salon', 'San Francisco'],
    omittedClaims: ['reviews', 'guarantees', 'unconfirmed staff names'],
    customerQuestions: [],
    confidence: 0.74,
    sourceEvidence: [{ source, quote, weight: 'high' }]
  };
}
