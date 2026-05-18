import Database from 'better-sqlite3';
import { join } from 'node:path';
import { env } from './env.js';
import { callAttempts, doNotCall, leads, auditTrail } from './db.js';

const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
const POLICY_VERSION = 'callability-v2';

export const PHONE_CLASSIFICATIONS = Object.freeze({
  INVALID: 'invalid',
  OWNED: 'owned',
  BUSINESS_LANDLINE: 'business_landline',
  MOBILE_RISK: 'mobile_risk',
  UNKNOWN: 'unknown'
});

export const REASON_CODES = Object.freeze({
  CALL_ALLOWED: 'CALL_ALLOWED',
  INVALID_PHONE: 'INVALID_PHONE',
  DNC_OPT_OUT: 'DNC_OPT_OUT',
  OUTSIDE_CALLING_HOURS: 'OUTSIDE_CALLING_HOURS',
  TIMEZONE_INVALID: 'TIMEZONE_INVALID',
  MAX_ATTEMPTS_PHONE: 'MAX_ATTEMPTS_PHONE',
  MAX_ATTEMPTS_BUSINESS: 'MAX_ATTEMPTS_BUSINESS',
  RECORDING_DISCLOSURE_MISSING: 'RECORDING_DISCLOSURE_MISSING',
  LIVE_TARGET_NOT_OWNED: 'LIVE_TARGET_NOT_OWNED',
  DEMO_LIVE_TARGET_NOT_OWNED_OR_SEEDED: 'DEMO_LIVE_TARGET_NOT_OWNED_OR_SEEDED',
  AUTONOMOUS_PHONE_NOT_BUSINESS_LANDLINE: 'AUTONOMOUS_PHONE_NOT_BUSINESS_LANDLINE',
  PRODUCTION_REVIEW_NO_OUTBOUND_CALLS: 'PRODUCTION_REVIEW_NO_OUTBOUND_CALLS',
  PRODUCTION_PHONE_NOT_BUSINESS_LANDLINE: 'PRODUCTION_PHONE_NOT_BUSINESS_LANDLINE',
  PHONE_MOBILE_RISK: 'PHONE_MOBILE_RISK',
  PHONE_UNKNOWN_RISK: 'PHONE_UNKNOWN_RISK'
});

let policyDb;
const recentDecisions = new Map();

export function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!PHONE_RE.test(cleaned)) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

export function classifyPhone({ phone, lead, profile } = {}) {
  const normalized = normalizePhone(phone || lead?.phone || profile?.phone);
  if (!normalized) return PHONE_CLASSIFICATIONS.INVALID;
  if (isOwnedPhone(normalized)) return PHONE_CLASSIFICATIONS.OWNED;

  const explicit = explicitPhoneClassification({ lead, profile });
  if (explicit === PHONE_CLASSIFICATIONS.MOBILE_RISK) return explicit;
  if (explicit === PHONE_CLASSIFICATIONS.BUSINESS_LANDLINE && hasBusinessPhoneEvidence({ lead, profile })) return explicit;

  const lineHint = [
    profile?.phoneType,
    profile?.phone_type,
    profile?.lineType,
    profile?.line_type,
    profile?.phoneCarrierType,
    profile?.carrierType
  ].filter(Boolean).join(' ').toLowerCase();

  if (/\b(mobile|wireless|cell|cellular|personal)\b/.test(lineHint)) return PHONE_CLASSIFICATIONS.MOBILE_RISK;
  if (/\b(landline|fixed|business|commercial)\b/.test(lineHint)) return PHONE_CLASSIFICATIONS.BUSINESS_LANDLINE;
  if (hasBusinessPhoneEvidence({ lead, profile })) return PHONE_CLASSIFICATIONS.BUSINESS_LANDLINE;

  return PHONE_CLASSIFICATIONS.UNKNOWN;
}

export function dncCheck(phone, { lead, profile, disclosureText, skipAttemptLimit = false, mode = env.runMode, now = new Date() } = {}) {
  return evaluateOutboundCallability({ phone, lead, profile, disclosureText, skipAttemptLimit, mode, now, persistDecision: false });
}

export function recordingDisclosure(businessName) {
  return `Hi! This is callmemaybe calling${businessName ? ` about ${businessName}` : ''}. This call is automated and recorded for quality. If you'd like to opt out, just say "stop" or "remove me" and I'll take care of it.`;
}

export function recordOptOut(phone, { source = 'call-transcript', reason = REASON_CODES.DNC_OPT_OUT, leadId = null } = {}) {
  const p = normalizePhone(phone);
  if (!p) return;
  doNotCall.add({ phone: p, reason, source });
  // Mirror the opt-out into the reputation auto-throttle counters. Uses a
  // dynamic import to avoid the compliance ↔ reputation ↔ outreach cycle at
  // module-evaluation time. Fire-and-forget; reputation failures must not
  // break the existing DNC behaviour.
  import('./reputation.js')
    .then((mod) => {
      try {
        mod.recordOptOut?.({ leadId, phone: p });
      } catch {
        // swallow — DNC has already been recorded.
      }
    })
    .catch(() => { /* swallow */ });
}

/**
 * Promote a lead's consent_status to operator_approved with a TCPA-defensible audit row.
 * Used when the lead explicitly requests a callback via email reply — the email IS the
 * invitation to call, and the inbound message_id is the proof we attach.
 */
export function markLeadConsentApproved(leadId, { reason = 'email_invite', proof = null, excerpt = null, contactEventId = null } = {}) {
  if (!leadId) return null;
  const lead = leads.get(leadId);
  if (!lead) return null;
  const wasApproved = lead.consent_status === 'operator_approved';
  if (!wasApproved) {
    leads.update(leadId, { consent_status: 'operator_approved' });
  }
  auditTrail.add({
    event_type: 'consent_email_invite',
    lead_id: leadId,
    contact_event_id: contactEventId || null,
    entity_type: 'lead',
    entity_id: leadId,
    action: wasApproved ? 'reaffirmed' : 'promoted',
    decision_code: 'consent.promoted',
    decision_reason: reason,
    metadata: {
      proof,
      excerpt: typeof excerpt === 'string' ? excerpt.slice(0, 280) : null,
      priorStatus: lead.consent_status || null
    },
    dedupe_key: proof ? `consent_email_invite:${leadId}:${proof}` : `consent_email_invite:${leadId}:${Date.now()}`
  });
  return { promoted: !wasApproved, priorStatus: lead.consent_status };
}

export function transcriptHasOptOut(transcript) {
  if (!transcript) return false;
  const text = (Array.isArray(transcript) ? transcript.map((t) => t.text || t.transcript || '').join(' ') : String(transcript)).toLowerCase();
  return /\b(stop calling|remove me|do not call|don't call|take me off)\b/.test(text);
}

export function recordCallDecision({
  leadId,
  lead,
  profile,
  phone,
  allowed,
  mode = env.runMode,
  reason,
  reasonCodes,
  blockers,
  phoneClassification,
  sourceUrl,
  disclosureText,
  decision
} = {}) {
  const hydratedLead = lead || lookupLead(leadId);
  const resolvedPhone = normalizePhone(phone || hydratedLead?.phone || profile?.phone);
  const recentDecision = decision || findRecentDecision({ lead: hydratedLead, phone: resolvedPhone, mode });
  const resolvedAllowed = allowed ?? recentDecision?.allowed ?? false;
  const resolvedDisclosureText = disclosureText ?? recentDecision?.disclosureText ?? null;
  const codes = normalizeReasonCodes(reasonCodes || recentDecision?.reasonCodes || reason, resolvedAllowed);
  const metadata = buildDecisionMetadata({
    lead: hydratedLead,
    profile,
    phone: resolvedPhone,
    rawPhone: phone || hydratedLead?.phone || profile?.phone,
    allowed: Boolean(resolvedAllowed),
    mode,
    reasonCodes: codes,
    blockers: blockers || recentDecision?.blockers || blockersFromReasonCodes(codes),
    phoneClassification: phoneClassification || recentDecision?.phoneClassification || classifyPhone({ phone: resolvedPhone, lead: hydratedLead, profile }),
    sourceUrl: sourceUrl || recentDecision?.sourceUrl || sourceUrlFor({ lead: hydratedLead, profile }),
    disclosureText: resolvedDisclosureText,
    callingWindow: recentDecision?.callingWindow,
    attempts: recentDecision?.attempts
  });
  return persistDecision(metadata);
}

export function callabilityForLead({ lead, profile, disclosureText, phone: explicitPhone, mode = env.runMode, now = new Date(), skipAttemptLimit = false } = {}) {
  return evaluateOutboundCallability({ lead, profile, disclosureText, phone: explicitPhone, mode, now, skipAttemptLimit, persistDecision: false });
}

export function gateOutboundCall({ lead, profile, disclosureText, phone: explicitPhone, mode = env.runMode, now = new Date(), skipAttemptLimit = false } = {}) {
  return evaluateOutboundCallability({
    lead,
    profile,
    disclosureText,
    phone: explicitPhone,
    mode,
    now,
    skipAttemptLimit,
    persistDecision: true
  });
}

export function evaluateOutboundCallability({
  lead,
  profile,
  disclosureText,
  phone: explicitPhone,
  mode = env.runMode,
  now = new Date(),
  skipAttemptLimit = false,
  persistDecision: shouldPersist = false
} = {}) {
  const phone = normalizePhone(explicitPhone || lead?.phone || profile?.phone);
  const phoneClassification = classifyPhone({ phone: phone || explicitPhone, lead, profile });
  const sourceUrl = sourceUrlFor({ lead, profile });
  const seeded = isSeededLead({ lead, profile });
  const owned = phoneClassification === PHONE_CLASSIFICATIONS.OWNED;
  const blockers = [];
  const callingWindow = callingWindowStatus(now, { mode });
  const attempts = attemptStatus({ lead, phone, skipAttemptLimit });

  if (!phone) {
    blockers.push({ code: REASON_CODES.INVALID_PHONE });
  } else {
    if (doNotCall.has(phone)) blockers.push({ code: REASON_CODES.DNC_OPT_OUT });
    if (callingWindow.timezoneValid === false) {
      blockers.push({ code: REASON_CODES.TIMEZONE_INVALID, timezone: env.outreach.timezone });
    } else if (!callingWindow.allowed) {
      blockers.push({
        code: REASON_CODES.OUTSIDE_CALLING_HOURS,
        timezone: callingWindow.timezone,
        localHour: callingWindow.localHour,
        quietHoursStart: callingWindow.quietHoursStart,
        quietHoursEnd: callingWindow.quietHoursEnd
      });
    }
    if (!skipAttemptLimit) {
      if (attempts.phoneAttempts >= attempts.limit) {
        blockers.push({ code: REASON_CODES.MAX_ATTEMPTS_PHONE, count: attempts.phoneAttempts, limit: attempts.limit });
      }
      if (attempts.businessAttempts >= attempts.limit) {
        blockers.push({ code: REASON_CODES.MAX_ATTEMPTS_BUSINESS, count: attempts.businessAttempts, limit: attempts.limit });
      }
    }
    if (mode === 'production_review') {
      blockers.push({ code: REASON_CODES.PRODUCTION_REVIEW_NO_OUTBOUND_CALLS });
    }
    if (mode === 'demo_live' && !(owned || seeded)) {
      blockers.push({ code: REASON_CODES.DEMO_LIVE_TARGET_NOT_OWNED_OR_SEEDED });
    }
    if ((mode === 'autonomous_live' || mode === 'production_live') && !(owned || phoneClassification === PHONE_CLASSIFICATIONS.BUSINESS_LANDLINE)) {
      const code = phoneClassification === PHONE_CLASSIFICATIONS.MOBILE_RISK
        ? REASON_CODES.PHONE_MOBILE_RISK
        : phoneClassification === PHONE_CLASSIFICATIONS.UNKNOWN
          ? REASON_CODES.PHONE_UNKNOWN_RISK
          : mode === 'production_live'
            ? REASON_CODES.PRODUCTION_PHONE_NOT_BUSINESS_LANDLINE
            : REASON_CODES.AUTONOMOUS_PHONE_NOT_BUSINESS_LANDLINE;
      blockers.push({ code, phoneClassification });
    }
  }

  if (!hasRecordingDisclosure(disclosureText)) {
    blockers.push({ code: REASON_CODES.RECORDING_DISCLOSURE_MISSING });
  }

  const reasonCodes = blockers.length ? uniqueCodes(blockers.map((b) => b.code)) : [REASON_CODES.CALL_ALLOWED];
  const allowed = blockers.length === 0;
  const decision = buildDecisionMetadata({
    lead,
    profile,
    phone,
    rawPhone: explicitPhone || lead?.phone || profile?.phone,
    allowed,
    mode,
    reasonCodes,
    blockers,
    phoneClassification,
    sourceUrl,
    disclosureText,
    callingWindow,
    attempts,
    seeded,
    owned
  });
  rememberDecision(decision);
  const persisted = shouldPersist ? persistDecision(decision) : { decisionId: null, decision };
  return {
    allowed,
    ok: allowed,
    mode,
    reason: reasonCodes[0],
    reasonCodes,
    blockers,
    phone,
    phoneClassification,
    decisionId: persisted.decisionId,
    decision: persisted.decision
  };
}

export function hasRecordingDisclosure(disclosureText) {
  return /\brecord(?:ed|ing)\b/i.test(String(disclosureText || ''));
}

export function isQuietHours(now = new Date(), { mode = env.runMode, timezone = env.outreach.timezone } = {}) {
  return !callingWindowStatus(now, { mode, timezone }).allowed;
}

export function callingWindowStatus(now = new Date(), { mode = env.runMode, timezone = env.outreach.timezone } = {}) {
  if (mode === 'mock') {
    return { allowed: true, timezone, timezoneValid: true, localHour: null, quietHoursStart: env.outreach.quietHoursStart, quietHoursEnd: env.outreach.quietHoursEnd };
  }
  const start = env.outreach.quietHoursStart;
  const end = env.outreach.quietHoursEnd;
  const local = timePartsInTimezone(now, timezone);
  if (!local) {
    return { allowed: false, timezone, timezoneValid: false, localHour: null, quietHoursStart: start, quietHoursEnd: end };
  }
  if (start === end) return { allowed: true, timezone, timezoneValid: true, localHour: local.hour, quietHoursStart: start, quietHoursEnd: end };
  const quiet = start < end ? local.hour >= start && local.hour < end : local.hour >= start || local.hour < end;
  return { allowed: !quiet, timezone, timezoneValid: true, localHour: local.hour, localMinute: local.minute, quietHoursStart: start, quietHoursEnd: end };
}

export function complianceGateReport({ mode = env.runMode, now = new Date() } = {}) {
  const disclosure = recordingDisclosure('Example Business');
  const callingWindow = callingWindowStatus(now, { mode });
  const maxAttempts = Math.max(0, Number(env.outreach.maxAttemptsPerPhone) || 0);
  return {
    policyVersion: POLICY_VERSION,
    gates: [
      gate('dnc', true, 'do_not_call table blocks recorded phone opt-outs before any call'),
      gate('opt_out', true, 'call transcripts and AgentMail replies persist stop/remove/unsubscribe requests'),
      gate('quiet_hours', callingWindow.timezoneValid !== false, callingWindow.timezoneValid === false ? `invalid timezone ${env.outreach.timezone}` : `${env.outreach.quietHoursStart}:00-${env.outreach.quietHoursEnd}:00 ${env.outreach.timezone}`),
      gate('max_attempts', maxAttempts > 0, `MAX_ATTEMPTS_PER_PHONE=${maxAttempts}`),
      gate('business_phone_classification', true, 'production/autonomous calls require owned or business-landline evidence'),
      gate('recording_ai_disclosure', hasRecordingDisclosure(disclosure), disclosure),
      gate('invoice_consent', true, 'invoice gate requires transcript-backed interest + a customer email; no readback confirmation required'),
      gate('unsubscribe', true, 'AgentMail opt-out classification records email-opt-out and stops automated replies')
    ],
    outboundCallReasonCodes: REASON_CODES,
    phoneClassifications: PHONE_CLASSIFICATIONS
  };
}

function sourceUrlFor({ lead, profile } = {}) {
  return firstString(profile?.sourceUrl, profile?.source_url, profile?.yelpUrl, profile?.googleUrl, lead?.source_url);
}

function hasBusinessPhoneEvidence({ lead, profile } = {}) {
  return Boolean(sourceUrlFor({ lead, profile }) || lead?.address || profile?.address || profile?.businessName || lead?.business_name);
}

function explicitPhoneClassification({ lead, profile } = {}) {
  return canonicalPhoneClassification(
    profile?.phoneClassification ||
    profile?.phone_classification ||
    profile?.classification ||
    lead?.phone_classification
  );
}

function canonicalPhoneClassification(value) {
  const v = String(value || '').toLowerCase();
  if (!v) return null;
  if (v === 'invalid') return PHONE_CLASSIFICATIONS.INVALID;
  if (v === 'owned') return PHONE_CLASSIFICATIONS.OWNED;
  if (v === 'mobile_risk' || v === 'mobile' || v === 'wireless' || v === 'cell') return PHONE_CLASSIFICATIONS.MOBILE_RISK;
  if (v === 'business_landline' || v === 'business' || v === 'landline') return PHONE_CLASSIFICATIONS.BUSINESS_LANDLINE;
  return null;
}

function isOwnedPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  return new Set(env.allowedPhones.map((p) => normalizePhone(p)).filter(Boolean)).has(normalized);
}

function isSeededLead({ lead, profile } = {}) {
  const tags = [
    lead?.consent_status,
    lead?.risk_status,
    lead?.container_tag,
    lead?.id,
    profile?.consentStatus,
    profile?.seeded ? 'seeded' : null
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(operator_seeded|seeded|demo_seed|test_seed|lead_seed)\b/.test(tags);
}

function attemptStatus({ lead, phone, skipAttemptLimit = false } = {}) {
  const limit = Math.max(0, Number(env.outreach.maxAttemptsPerPhone) || 0);
  if (skipAttemptLimit || !phone) {
    return { limit, phoneAttempts: 0, businessAttempts: 0, since: 0, skipped: Boolean(skipAttemptLimit) };
  }
  return {
    limit,
    phoneAttempts: countAllowedPhoneAttempts({ phone, since: 0 }),
    businessAttempts: countAllowedBusinessAttempts({ lead, since: 0 }),
    since: 0,
    skipped: false
  };
}

function countAllowedPhoneAttempts({ phone, since }) {
  try {
    return readDb().prepare(`
      SELECT COUNT(*) AS n
      FROM call_attempts
      WHERE phone = ? AND allowed = 1 AND created_at >= ?
    `).get(phone, since).n;
  } catch {
    return 0;
  }
}

function countAllowedBusinessAttempts({ lead, since }) {
  const leadId = lead?.id || null;
  const businessName = firstString(lead?.business_name, lead?.businessName);
  if (!leadId && !businessName) return 0;
  try {
    if (leadId && businessName) {
      return readDb().prepare(`
        SELECT COUNT(*) AS n
        FROM call_attempts ca
        LEFT JOIN leads l ON l.id = ca.lead_id
        WHERE ca.allowed = 1
          AND ca.created_at >= ?
          AND (ca.lead_id = ? OR lower(l.business_name) = lower(?))
      `).get(since, leadId, businessName).n;
    }
    if (leadId) {
      return readDb().prepare(`
        SELECT COUNT(*) AS n
        FROM call_attempts
        WHERE allowed = 1 AND created_at >= ? AND lead_id = ?
      `).get(since, leadId).n;
    }
    return readDb().prepare(`
      SELECT COUNT(*) AS n
      FROM call_attempts ca
      LEFT JOIN leads l ON l.id = ca.lead_id
      WHERE ca.allowed = 1 AND ca.created_at >= ? AND lower(l.business_name) = lower(?)
    `).get(since, businessName).n;
  } catch {
    return 0;
  }
}

function readDb() {
  if (!policyDb) {
    policyDb = new Database(join(env.dataDir, 'callmemaybe.db'), { readonly: true, fileMustExist: false });
    policyDb.pragma('query_only = ON');
  }
  return policyDb;
}

function lookupLead(leadId) {
  if (!leadId) return null;
  try {
    return leads.get(leadId) || null;
  } catch {
    return null;
  }
}

function rememberDecision(decision) {
  const key = decisionKey({ leadId: decision.leadId, phone: decision.phone, mode: decision.mode });
  recentDecisions.set(key, decision);
  if (recentDecisions.size > 100) {
    const oldest = recentDecisions.keys().next().value;
    recentDecisions.delete(oldest);
  }
}

function findRecentDecision({ lead, phone, mode }) {
  const leadId = lead?.id || null;
  const exact = recentDecisions.get(decisionKey({ leadId, phone, mode }));
  if (exact) return exact;
  if (phone) {
    return recentDecisions.get(decisionKey({ leadId: null, phone, mode })) || null;
  }
  return null;
}

function decisionKey({ leadId, phone, mode }) {
  return `${mode || env.runMode}|${leadId || ''}|${phone || ''}`;
}

function buildDecisionMetadata({
  lead,
  profile,
  phone,
  rawPhone,
  allowed,
  mode,
  reasonCodes,
  blockers,
  phoneClassification,
  sourceUrl,
  disclosureText,
  callingWindow,
  attempts,
  seeded = isSeededLead({ lead, profile }),
  owned = phoneClassification === PHONE_CLASSIFICATIONS.OWNED
}) {
  return {
    policyVersion: POLICY_VERSION,
    leadId: lead?.id || null,
    businessName: firstString(lead?.business_name, profile?.businessName) || null,
    phone: phone || null,
    rawPhone: rawPhone || null,
    mode,
    allowed: Boolean(allowed),
    reasonCodes,
    blockers,
    phoneClassification,
    sourceUrl: sourceUrl || null,
    disclosureRequired: true,
    disclosurePresent: hasRecordingDisclosure(disclosureText),
    disclosureText: disclosureText || null,
    callingWindow: callingWindow || null,
    attempts: attempts || null,
    seeded: Boolean(seeded),
    owned: Boolean(owned),
    checkedAt: Date.now()
  };
}

function persistDecision(decision) {
  const decisionId = decision.id || `decision_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const storedDecision = { ...decision, id: decisionId };
  callAttempts.add({
    id: decisionId,
    lead_id: storedDecision.leadId,
    phone: storedDecision.phone || storedDecision.rawPhone || '',
    allowed: storedDecision.allowed,
    reason: JSON.stringify({
      policyVersion: storedDecision.policyVersion,
      primaryReasonCode: storedDecision.reasonCodes[0],
      reasonCodes: storedDecision.reasonCodes,
      blockers: storedDecision.blockers,
      mode: storedDecision.mode,
      phoneClassification: storedDecision.phoneClassification,
      sourceUrl: storedDecision.sourceUrl
    }),
    disclosure_text: decision.disclosureText || null
  });
  return { decisionId, decision: storedDecision };
}

function normalizeReasonCodes(input, allowed = false) {
  if (Array.isArray(input)) return uniqueCodes(input.map(canonicalReasonCode));
  if (typeof input === 'string' && input.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed.reasonCodes)) return uniqueCodes(parsed.reasonCodes.map(canonicalReasonCode));
      if (parsed.primaryReasonCode) return [canonicalReasonCode(parsed.primaryReasonCode)];
    } catch {
      // Fall through to legacy string handling.
    }
  }
  if (!input && allowed) return [REASON_CODES.CALL_ALLOWED];
  return [canonicalReasonCode(input || (allowed ? REASON_CODES.CALL_ALLOWED : REASON_CODES.AUTONOMOUS_PHONE_NOT_BUSINESS_LANDLINE))];
}

function canonicalReasonCode(value) {
  const v = String(value || '').trim();
  if (Object.values(REASON_CODES).includes(v)) return v;
  const lower = v.toLowerCase();
  if (/invalid phone/.test(lower)) return REASON_CODES.INVALID_PHONE;
  if (/opt[-_ ]?out|do not call/.test(lower)) return REASON_CODES.DNC_OPT_OUT;
  if (/quiet|outside configured calling hours/.test(lower)) return REASON_CODES.OUTSIDE_CALLING_HOURS;
  if (/max attempts/.test(lower)) return REASON_CODES.MAX_ATTEMPTS_PHONE;
  if (/recording disclosure/.test(lower)) return REASON_CODES.RECORDING_DISCLOSURE_MISSING;
  if (/allowed|callable|live call allowed|mock call/.test(lower)) return REASON_CODES.CALL_ALLOWED;
  if (/not in allowed_target_phones/.test(lower)) return REASON_CODES.LIVE_TARGET_NOT_OWNED;
  if (/mobile/.test(lower)) return REASON_CODES.PHONE_MOBILE_RISK;
  if (/unknown/.test(lower)) return REASON_CODES.PHONE_UNKNOWN_RISK;
  return v.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || REASON_CODES.PHONE_UNKNOWN_RISK;
}

function blockersFromReasonCodes(reasonCodes) {
  return reasonCodes.filter((code) => code !== REASON_CODES.CALL_ALLOWED).map((code) => ({ code }));
}

function uniqueCodes(codes) {
  return [...new Set(codes.filter(Boolean))];
}

function timePartsInTimezone(now, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { hour, minute };
  } catch {
    return null;
  }
}

function firstString(...values) {
  return values.find((v) => typeof v === 'string' && v.trim())?.trim() || null;
}

function gate(name, ok, detail) {
  return {
    name,
    ok: Boolean(ok),
    detail,
    nextAction: ok ? 'monitor' : `fix_${name}`
  };
}
