import { env } from './env.js';

const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
const optOuts = new Set();

export function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!PHONE_RE.test(cleaned)) return null;
  return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
}

export function dncCheck(phone) {
  const p = normalizePhone(phone);
  if (!p) return { ok: false, reason: 'invalid phone format' };
  if (optOuts.has(p)) return { ok: false, reason: 'opt-out (prior)' };
  if (env.runMode === 'live') {
    if (!env.allowedPhones.includes(p)) return { ok: false, reason: 'not in ALLOWED_TARGET_PHONES' };
  }
  return { ok: true, phone: p };
}

export function recordingDisclosure(businessName) {
  return `Hi! This is callmemaybe calling${businessName ? ` about ${businessName}` : ''}. This call is automated and recorded for quality. If you'd like to opt out, just say "stop" or "remove me" and I'll take care of it.`;
}

export function recordOptOut(phone) {
  const p = normalizePhone(phone);
  if (p) optOuts.add(p);
}

export function transcriptHasOptOut(transcript) {
  if (!transcript) return false;
  const text = (Array.isArray(transcript) ? transcript.map((t) => t.text || t.transcript || '').join(' ') : String(transcript)).toLowerCase();
  return /\b(stop calling|remove me|do not call|don't call|take me off)\b/.test(text);
}
