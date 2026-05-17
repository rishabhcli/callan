import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-compliance-'));

Object.assign(process.env, {
  DATA_DIR: dataDir,
  RUN_MODE: 'autonomous_live',
  LIVE_CALLS: 'true',
  ALLOWED_TARGET_PHONES: '+14155550199',
  MAX_ATTEMPTS_PER_PHONE: '1',
  QUIET_HOURS_START: '20',
  QUIET_HOURS_END: '9',
  OUTREACH_TIMEZONE: 'America/Los_Angeles'
});

const { leads } = await import('../server/db.js');
const {
  REASON_CODES,
  PHONE_CLASSIFICATIONS,
  callabilityForLead,
  gateOutboundCall,
  recordCallDecision,
  recordOptOut,
  recordingDisclosure
} = await import('../server/compliance.js');

const checks = [];

function expect(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail });
}

function insertLead(row) {
  const result = leads.insert({
    id: row.id,
    container_tag: row.container_tag || row.id,
    business_name: row.business_name || 'Compliance Fixture',
    phone: row.phone,
    address: row.address || '1 Market St, San Francisco, CA',
    niche: row.niche || 'fixture',
    city: row.city || 'San Francisco',
    website: null,
    status: 'discovered',
    research_status: 'complete',
    outreach_status: 'queued',
    risk_status: row.risk_status || 'needs_callability_check',
    consent_status: row.consent_status || 'public_business',
    phone_classification: row.phone_classification || 'unknown',
    next_action: 'call',
    source_url: row.source_url || null
  });
  return leads.get(result.lead.id);
}

const goodTime = new Date('2026-01-15T20:00:00Z'); // noon America/Los_Angeles
const quietTime = new Date('2026-01-16T05:30:00Z'); // 9:30 PM America/Los_Angeles
const disclosure = recordingDisclosure('Compliance Fixture');

const invalid = callabilityForLead({
  lead: { id: 'lead_invalid', business_name: 'Bad Phone', phone: 'abc' },
  disclosureText: disclosure
});
expect('invalid phone is explicit', invalid.reasonCodes.includes(REASON_CODES.INVALID_PHONE), JSON.stringify(invalid.reasonCodes));
expect('invalid classification is explicit', invalid.phoneClassification === PHONE_CLASSIFICATIONS.INVALID, invalid.phoneClassification);

const optOutPhone = '+14155550122';
recordOptOut(optOutPhone);
const dnc = callabilityForLead({
  lead: { id: 'lead_dnc', business_name: 'DNC Fixture', phone: optOutPhone, address: '2 Market St' },
  disclosureText: disclosure
});
expect('opt-out blocks with code', dnc.reasonCodes.includes(REASON_CODES.DNC_OPT_OUT), JSON.stringify(dnc.reasonCodes));

const ownedQuiet = callabilityForLead({
  lead: { id: 'lead_quiet', business_name: 'Owned Quiet', phone: '+14155550199' },
  disclosureText: disclosure,
  phone: '+14155550199',
  now: quietTime,
  mode: 'demo_live'
});
expect('configured timezone quiet hours block', ownedQuiet.reasonCodes.includes(REASON_CODES.OUTSIDE_CALLING_HOURS), JSON.stringify(ownedQuiet.reasonCodes));

const unseededDemo = callabilityForLead({
  lead: { id: 'lead_demo_unseeded', business_name: 'Real Business', phone: '+14155550123', address: '3 Market St' },
  disclosureText: disclosure,
  now: goodTime,
  mode: 'demo_live'
});
expect('demo_live blocks unowned unseeded target', unseededDemo.reasonCodes.includes(REASON_CODES.DEMO_LIVE_TARGET_NOT_OWNED_OR_SEEDED), JSON.stringify(unseededDemo.reasonCodes));

const seededDemo = callabilityForLead({
  lead: { id: 'lead_seed_fixture', business_name: 'Seed Business', phone: '+14155550124', consent_status: 'operator_seeded', address: '4 Market St' },
  disclosureText: disclosure,
  now: goodTime,
  mode: 'demo_live'
});
expect('demo_live allows seeded target', seededDemo.allowed, JSON.stringify(seededDemo.reasonCodes));

const mobileRisk = callabilityForLead({
  lead: { id: 'lead_mobile', business_name: 'Mobile Owner', phone: '+14155550125' },
  profile: { sourceUrl: 'https://example.test/mobile', phoneType: 'mobile' },
  disclosureText: disclosure,
  now: goodTime,
  mode: 'autonomous_live'
});
expect('autonomous_live blocks mobile risk', mobileRisk.reasonCodes.includes(REASON_CODES.PHONE_MOBILE_RISK), JSON.stringify(mobileRisk.reasonCodes));

const attemptLead = insertLead({
  id: 'lead_attempt',
  business_name: 'Attempt Fixture',
  phone: '+14155550126',
  source_url: 'https://example.test/attempt'
});
const firstDecision = gateOutboundCall({
  lead: attemptLead,
  disclosureText: disclosure,
  now: goodTime,
  mode: 'autonomous_live'
});
expect('first autonomous business-landline decision allowed', firstDecision.allowed, JSON.stringify(firstDecision.reasonCodes));
expect('persistent decision returns id', Boolean(firstDecision.decisionId), firstDecision.decisionId || '');

const db = new Database(join(dataDir, 'callmemaybe.db'), { readonly: true });
const persisted = db.prepare('SELECT reason FROM call_attempts WHERE id = ?').get(firstDecision.decisionId);
const persistedReason = JSON.parse(persisted.reason);
expect('persisted decision stores source URL', persistedReason.sourceUrl === 'https://example.test/attempt', persisted.reason);
expect('persisted decision stores explicit reason code', persistedReason.primaryReasonCode === REASON_CODES.CALL_ALLOWED, persisted.reason);

const legacyLead = insertLead({
  id: 'lead_legacy_record',
  business_name: 'Legacy Record Fixture',
  phone: '+14155550127',
  source_url: 'https://example.test/legacy'
});
const legacyGate = callabilityForLead({
  lead: legacyLead,
  disclosureText: disclosure,
  now: goodTime,
  mode: 'autonomous_live'
});
const legacyRecord = recordCallDecision({
  leadId: legacyLead.id,
  phone: legacyLead.phone,
  allowed: legacyGate.ok,
  reason: legacyGate.reason,
  disclosureText: disclosure
});
const legacyPersisted = db.prepare('SELECT reason FROM call_attempts WHERE id = ?').get(legacyRecord.decisionId);
const legacyReason = JSON.parse(legacyPersisted.reason);
expect('legacy recordCallDecision stores source URL', legacyReason.sourceUrl === 'https://example.test/legacy', legacyPersisted.reason);
expect('legacy recordCallDecision stores reason codes', legacyReason.reasonCodes.includes(REASON_CODES.CALL_ALLOWED), legacyPersisted.reason);

const secondDecision = callabilityForLead({
  lead: attemptLead,
  disclosureText: disclosure,
  now: goodTime,
  mode: 'autonomous_live'
});
expect('second phone attempt blocked', secondDecision.reasonCodes.includes(REASON_CODES.MAX_ATTEMPTS_PHONE), JSON.stringify(secondDecision.reasonCodes));
expect('second business attempt blocked', secondDecision.reasonCodes.includes(REASON_CODES.MAX_ATTEMPTS_BUSINESS), JSON.stringify(secondDecision.reasonCodes));

const failed = checks.filter((c) => !c.ok);
for (const check of checks) {
  const prefix = check.ok ? 'PASS' : 'FAIL';
  console.log(`${prefix} ${check.name}${check.detail ? ` :: ${check.detail}` : ''}`);
}

if (failed.length) {
  process.exitCode = 1;
}
