import { auditTrail, calls, contactEvents, db, leads, payments, trustLedger } from './db.js';
import { normalizePhone, recordingDisclosure } from './compliance.js';
import { canDialPhone, reputationReadinessReport } from './reputation.js';

const TRUST_POLICY_VERSION = 'trust-ledger-v1';

export function trustSummaryForLead(leadId, { includeEvents = true, eventLimit = 80 } = {}) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  const contactRows = contactEvents.listByLead(lead.id, { limit: Math.max(eventLimit, 100) });
  const callRows = calls.listByLead(lead.id);
  const paymentRows = payments.listByLead(lead.id);
  const ledgerRows = trustLedger.listByLead(lead.id, { limit: eventLimit });
  const auditTimeline = auditTrail.timelineByLead(lead.id, { limit: eventLimit });
  const researchProfile = safeJson(lead.research_json) || {};
  const sourceEvidence = sourceEvidenceForLead(lead, researchProfile, ledgerRows);
  const disclosure = latestDisclosure({ lead, callRows, ledgerRows });
  const optOut = optOutStatusForLead({ lead, contactRows, ledgerRows });
  const invoiceConsent = invoiceConsentForLead({ contactRows, paymentRows, ledgerRows });
  const portalEvents = ledgerRows.filter((row) => row.event_type === 'portal_token_event' || row.channel === 'portal').slice(0, 12);
  const providerFlags = ledgerRows.filter((row) => row.event_type === 'provider_flag' || row.event_type === 'provider_complaint').slice(0, 12);
  const reputationGate = canDialPhone(normalizePhone(lead.phone));
  const reputation = reputationReadinessReport();
  const operator = operatorState();

  const summary = {
    policyVersion: TRUST_POLICY_VERSION,
    leadId: lead.id,
    whyContacted: whyContacted({ lead, sourceEvidence, ledgerRows, researchProfile }),
    sourceEvidence,
    disclosureUsed: disclosure,
    consentStatus: lead.consent_status || 'unknown',
    optOutStatus: optOut,
    invoiceConsent,
    portalTokenEvents: portalEvents,
    complaintsProviderFlags: providerFlags,
    privacySafeData: privacySafeData({ lead, sourceEvidence, optOut }),
    blockers: trustBlockers({ lead, optOut, sourceEvidence, disclosure, reputationGate, providerFlags, operator }),
    lastDisclosure: disclosure?.text || null,
    optOutProof: optOut.proof || null,
    reputationThrottleState: {
      ok: reputationGate.ok,
      reason: reputationGate.reason || null,
      areaCode: reputationGate.areaCode || null,
      attempts24h: reputationGate.attempts24h ?? null,
      limit: reputationGate.limit ?? null,
      remainingBeforeBlock: reputationGate.remainingBeforeBlock ?? null,
      readiness: reputation
    },
    operatorState: operator
  };

  if (includeEvents) {
    summary.events = mergeTrustEvents({ ledgerRows, auditTimeline }).slice(0, eventLimit);
  }
  return summary;
}

export function customerTrustSummaryForLead(leadId) {
  const trust = trustSummaryForLead(leadId, { includeEvents: false });
  if (!trust) return null;
  return {
    whyAmISeeingThis: trust.whyContacted,
    howToStop: trust.optOutStatus.optedOut
      ? 'You are opted out. We will not call or email you again about this project.'
      : 'Use the opt-out button on this page and Callan will stop further calls and emails.',
    sourceEvidence: trust.sourceEvidence.map((item) => ({
      label: item.label,
      url: item.url || null,
      host: item.host || null,
      note: item.note || null
    })),
    disclosureUsed: trust.disclosureUsed ? {
      text: trust.disclosureUsed.text,
      source: trust.disclosureUsed.source,
      at: trust.disclosureUsed.at
    } : null,
    consentStatus: trust.consentStatus,
    optOutStatus: {
      optedOut: trust.optOutStatus.optedOut,
      reason: trust.optOutStatus.reason,
      source: trust.optOutStatus.source,
      at: trust.optOutStatus.at
    },
    privacySafeData: trust.privacySafeData
  };
}

export function recordTrustEvent(row = {}) {
  return trustLedger.add(row);
}

function whyContacted({ lead, sourceEvidence, ledgerRows, researchProfile }) {
  const ledger = ledgerRows.find((row) => row.event_type === 'why_contacted');
  if (ledger?.summary) return ledger.summary;
  if (lead.callable_reason) return lead.callable_reason;
  const source = sourceEvidence[0]?.host || sourceEvidence[0]?.label || 'public business research';
  const niche = lead.niche || researchProfile.niche || 'local business';
  const city = lead.city || researchProfile.city || null;
  return `Callan saw ${lead.business_name || 'this business'} during ${source} research for ${city ? `${niche} in ${city}` : niche} and only proceeds when the record has business-contact evidence plus opt-out handling.`;
}

function sourceEvidenceForLead(lead, profile = {}, ledgerRows = []) {
  const rows = [
    { label: 'lead source', url: lead.source_url || lead.normalized_source_url || null, note: lead.callable_reason || null },
    { label: 'research source', url: profile.sourceUrl || profile.source_url || profile.yelpUrl || profile.googleUrl || null, note: profile.sourceProvenance || null },
    { label: 'business website', url: lead.website || profile.websiteUrl || profile.website || null, note: profile.onlinePresenceStrength ? `online presence: ${profile.onlinePresenceStrength}` : null }
  ];
  for (const row of ledgerRows) {
    if (row.source_url) rows.push({ label: row.event_type, url: row.source_url, note: row.summary });
  }
  const seen = new Set();
  return rows
    .map((row) => ({ ...row, url: cleanUrl(row.url), host: urlHost(row.url) }))
    .filter((row) => row.url || row.note)
    .filter((row) => {
      const key = `${row.label}:${row.url || row.note}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function latestDisclosure({ lead, callRows, ledgerRows }) {
  const call = callRows.find((row) => row.disclosure_text);
  if (call) {
    return {
      text: call.disclosure_text,
      source: 'call',
      subjectId: call.id,
      at: call.started_at || call.ended_at || null
    };
  }
  const ledger = ledgerRows.find((row) => row.disclosure_text);
  if (ledger) {
    return {
      text: ledger.disclosure_text,
      source: 'trust_ledger',
      subjectId: ledger.subject_id,
      at: ledger.created_at
    };
  }
  return {
    text: recordingDisclosure(lead.business_name),
    source: 'current_policy',
    subjectId: null,
    at: null
  };
}

function optOutStatusForLead({ lead, contactRows, ledgerRows }) {
  const phone = normalizePhone(lead.phone);
  const dnc = phone ? db.prepare(`SELECT * FROM do_not_call WHERE phone = ?`).get(phone) : null;
  const contact = contactRows.find((row) => /opt.?out|unsubscribe|do_not/i.test(`${row.type} ${row.body || ''}`));
  const ledger = ledgerRows.find((row) => row.event_type === 'opt_out' || row.event_type === 'opt_out_confirmation');
  const optedOut = Boolean(dnc || /opt.?out|do_not|email-opt-out/i.test(`${lead.risk_status || ''} ${lead.consent_status || ''}`) || contact || ledger);
  return {
    optedOut,
    reason: dnc?.reason || contact?.body || ledger?.summary || (optedOut ? lead.risk_status || 'opted_out' : 'none recorded'),
    source: dnc?.source || contact?.channel || ledger?.channel || null,
    at: dnc?.created_at || contact?.created_at || ledger?.created_at || null,
    proof: dnc ? {
      phone: maskPhone(dnc.phone),
      reason: dnc.reason,
      source: dnc.source,
      createdAt: dnc.created_at
    } : contact ? {
      contactEventId: contact.id,
      channel: contact.channel,
      type: contact.type,
      createdAt: contact.created_at
    } : ledger ? {
      trustEventId: ledger.id,
      type: ledger.event_type,
      createdAt: ledger.created_at
    } : null
  };
}

function invoiceConsentForLead({ contactRows, paymentRows, ledgerRows }) {
  const event = contactRows.find((row) => row.type === 'invoice_consent' && row.channel === 'revenue');
  const meta = safeJson(event?.metadata_json) || {};
  const payment = paymentRows[0] || null;
  const ledger = ledgerRows.find((row) => row.event_type === 'invoice_consent');
  return {
    recorded: Boolean(event || ledger),
    eventId: event?.id || ledger?.id || null,
    at: event?.created_at || ledger?.created_at || null,
    emailMasked: maskEmail(meta.email || payment?.customer_email || null),
    offerVersion: meta.offerVersion || payment?.offer_version || null,
    proof: event ? {
      source: 'contact_events',
      decisionCode: meta.decisionCode || null,
      gate: compactGate(meta.gate)
    } : ledger ? { source: 'trust_ledger', summary: ledger.summary } : null
  };
}

function trustBlockers({ lead, optOut, sourceEvidence, disclosure, reputationGate, providerFlags, operator }) {
  const blockers = [];
  if (optOut.optedOut) blockers.push({ code: 'TRUST_OPT_OUT', reason: optOut.reason || 'Customer opted out.', source: optOut.source || 'trust' });
  if (!sourceEvidence.length) blockers.push({ code: 'TRUST_SOURCE_EVIDENCE_MISSING', reason: 'No source evidence is attached to this lead.', source: 'trust' });
  if (!disclosure?.text) blockers.push({ code: 'TRUST_DISCLOSURE_MISSING', reason: 'No disclosure text is available.', source: 'trust' });
  if (!reputationGate.ok) blockers.push({ code: 'TRUST_REPUTATION_THROTTLE', reason: reputationGate.reason, source: 'reputation' });
  const complaint = providerFlags.find((row) => row.event_type === 'provider_complaint');
  if (complaint) blockers.push({ code: 'TRUST_PROVIDER_COMPLAINT', reason: complaint.summary, source: complaint.channel || 'provider' });
  if (operator.paused) blockers.push({ code: 'TRUST_OPERATOR_PAUSED', reason: operator.reason || 'Outreach is paused.', source: 'operator' });
  if (/mobile|unknown/i.test(lead.phone_classification || '')) {
    blockers.push({ code: 'TRUST_PHONE_UNCERTAIN', reason: `phone_classification is ${lead.phone_classification}`, source: 'lead' });
  }
  return blockers;
}

function privacySafeData({ lead, sourceEvidence, optOut }) {
  return {
    businessName: lead.business_name || null,
    niche: lead.niche || null,
    city: lead.city || null,
    phone: maskPhone(lead.phone),
    phoneClassification: lead.phone_classification || 'unknown',
    sourceHost: sourceEvidence[0]?.host || null,
    consentStatus: lead.consent_status || 'unknown',
    optOut: optOut.optedOut,
    outreachStatus: lead.outreach_status || 'unknown',
    riskStatus: lead.risk_status || 'unknown'
  };
}

function operatorState() {
  const row = db.prepare(`
    SELECT type, body, created_at
    FROM contact_events
    WHERE channel = 'outreach' AND lead_id IS NULL AND type IN ('autonomy_paused', 'autonomy_resumed')
    ORDER BY created_at DESC
    LIMIT 1
  `).get();
  const paused = row?.type === 'autonomy_paused';
  const reason = row?.body || null;
  const updatedAt = row?.created_at || null;
  return {
    paused,
    reason,
    updatedAt,
    emergencyStop: paused && /emergency/i.test(reason || '')
  };
}

function mergeTrustEvents({ ledgerRows, auditTimeline }) {
  const audit = auditTimeline
    .filter((row) => /trust|compliance|call|contact|invoice|portal|webhook|do_not_call/i.test(`${row.event_type || ''} ${row.decision_code || ''}`))
    .map((row) => ({
      id: `audit:${row.kind}:${row.id}`,
      created_at: row.created_at,
      event_type: row.event_type || row.decision_code || 'audit',
      actor: row.worker || row.entity_type || 'audit',
      channel: row.channel || null,
      direction: row.direction || null,
      subject_id: row.entity_id || row.subject_id || null,
      decision_code: row.decision_code || null,
      summary: row.decision_reason || row.action || row.event_type,
      source_url: row.source_url || null,
      metadata: row.metadata || null
    }));
  return [...ledgerRows, ...audit]
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

function cleanUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}

function urlHost(value) {
  try {
    return value ? new URL(value).host : null;
  } catch {
    return null;
  }
}

function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return value ? '***' : null;
  return `***-${digits.slice(-4)}`;
}

function maskEmail(value) {
  const email = String(value || '');
  if (!email.includes('@')) return null;
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local.slice(0, 1)}***@***.${tld}`;
}

function compactGate(gate) {
  if (!gate) return null;
  return {
    ok: gate.ok,
    blockers: gate.blockers || [],
    evidence: gate.evidence || null
  };
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}
