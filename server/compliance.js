import { env } from './env.js';
import { callAttempts, doNotCall } from './db.js';

const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

export function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!PHONE_RE.test(cleaned)) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

export function classifyPhone({ phone, lead, profile } = {}) {
  const normalized = normalizePhone(phone || lead?.phone || profile?.phone);
  if (!normalized) return 'invalid';
  if (env.allowedPhones.includes(normalized)) return 'allowed';
  if (profile?.bestContactEmail && !lead?.phone) return 'email_only';
  const source = profile?.sourceUrl || profile?.yelpUrl || lead?.source_url;
  if (lead?.address || profile?.address || source) return 'business';
  return 'unknown';
}

export function dncCheck(phone, { lead, profile, disclosureText, skipAttemptLimit = false } = {}) {
  const p = normalizePhone(phone);
  if (!p) return { ok: false, reason: 'invalid phone format' };
  if (doNotCall.has(p)) return { ok: false, reason: 'opt-out (prior)' };
  if (isQuietHours()) return { ok: false, reason: 'outside configured calling hours' };
  if (!skipAttemptLimit && callAttempts.countSince({ phone: p, since: 0 }) >= env.outreach.maxAttemptsPerPhone) {
    return { ok: false, reason: 'max attempts reached' };
  }
  if (!disclosureText || !/recorded|recording/i.test(disclosureText)) {
    return { ok: false, reason: 'recording disclosure missing' };
  }
  if (env.runMode === 'live' || env.runMode === 'demo_live') {
    if (!env.allowedPhones.includes(p)) return { ok: false, reason: 'not in ALLOWED_TARGET_PHONES' };
  }
  if (env.runMode === 'autonomous_live') {
    const phoneClass = classifyPhone({ phone: p, lead, profile });
    if (!['allowed', 'business'].includes(phoneClass)) return { ok: false, reason: `phone risk: ${phoneClass}` };
  }
  return { ok: true, phone: p };
}

export function recordingDisclosure(businessName) {
  return `Hi! This is callmemaybe calling${businessName ? ` about ${businessName}` : ''}. This call is automated and recorded for quality. If you'd like to opt out, just say "stop" or "remove me" and I'll take care of it.`;
}

export function recordOptOut(phone) {
  const p = normalizePhone(phone);
  if (p) doNotCall.add({ phone: p, reason: 'opt-out', source: 'call-transcript' });
}

export function transcriptHasOptOut(transcript) {
  if (!transcript) return false;
  const text = (Array.isArray(transcript) ? transcript.map((t) => t.text || t.transcript || '').join(' ') : String(transcript)).toLowerCase();
  return /\b(stop calling|remove me|do not call|don't call|take me off)\b/.test(text);
}

export function recordCallDecision({ leadId, phone, allowed, reason, disclosureText }) {
  const p = normalizePhone(phone) || String(phone || '');
  callAttempts.add({ lead_id: leadId, phone: p, allowed, reason, disclosure_text: disclosureText });
}

export function callabilityForLead({ lead, profile, disclosureText, phone: explicitPhone }) {
  const phone = normalizePhone(explicitPhone || lead?.phone || profile?.phone);
  const phoneClassification = classifyPhone({ phone, lead, profile });
  const check = dncCheck(phone, { lead, profile, disclosureText });
  if (!check.ok) return { ...check, phone, phoneClassification };
  return { ok: true, reason: 'callable', phone, phoneClassification };
}

export function isQuietHours(now = new Date()) {
  if (env.runMode === 'mock') return false;
  const hour = now.getHours();
  const start = env.outreach.quietHoursStart;
  const end = env.outreach.quietHoursEnd;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}
