/**
 * Per-lead arm assignment + pitch rewriting for the `pitch_v2` experiment.
 *
 *   applyPitchExperiment({ lead, pitch, profile, disclosure })
 *
 * Returns `{ pitch, assignment }`. The pitch is rewritten in-place style
 * (we return a new object) per the assigned arm:
 *
 *   - control       — no change.
 *   - short_warm    — replace openingLine + valueProp with a short warm variant.
 *   - data_driven   — open with a concrete signal from the lead profile.
 *
 * The arm assignment is sticky: assignArm() is keyed on lead.id, so repeated
 * calls for the same lead return the same arm. beginMessage is never touched,
 * so the recording-disclosure-first contract enforced by validateGeneratedPitch
 * stays intact.
 */

import { assignArm } from './experiments.js';

const EXPERIMENT_KEY = 'pitch_v2';
const ARMS = ['control', 'short_warm', 'data_driven'];

const PITCH_FIELDS = [
  'openingLine',
  'valueProp',
  'discoveryQuestions',
  'objections',
  'close',
  'emailAsk',
  'emailReadbackInstruction',
  'invoiceClose',
  'beginMessage'
];

function pickStrictPitch(pitch) {
  const next = {};
  for (const key of PITCH_FIELDS) {
    if (key in pitch) next[key] = pitch[key];
  }
  return next;
}

function deriveFirstName(lead, profile) {
  const candidates = [
    profile?.ownerFirstName,
    profile?.firstName,
    profile?.ownerName,
    lead?.owner_first_name,
    lead?.owner_name,
    lead?.business_name,
    profile?.businessName
  ];
  for (const value of candidates) {
    if (!value) continue;
    const text = String(value).trim();
    if (!text) continue;
    // Take the first whitespace-delimited token. For a business name this is
    // imperfect but it lands the script with a friendly noun rather than a
    // hard placeholder. Strip trailing punctuation just in case.
    const token = text.split(/\s+/)[0].replace(/[.,;:!?]+$/, '');
    if (token) return token;
  }
  return 'there';
}

function deriveBusinessName(lead, profile) {
  const candidates = [lead?.business_name, profile?.businessName, profile?.name];
  for (const value of candidates) {
    if (!value) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return 'your business';
}

function deriveSignal(profile) {
  const signals = Array.isArray(profile?.signals) ? profile.signals : [];
  const needs = Array.isArray(profile?.needs) ? profile.needs : [];
  const candidates = [signals[0], needs[0], profile?.onlinePresenceSummary];
  for (const value of candidates) {
    if (!value) continue;
    const text = String(value).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
}

function lowerFirst(text) {
  if (!text) return text;
  return text[0].toLowerCase() + text.slice(1);
}

function ensureDisclosurePrefix(text, disclosure) {
  if (!disclosure) return text;
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith(disclosure)) return trimmed;
  return `${disclosure} ${trimmed}`.trim();
}

function shortWarmPitch({ pitch, disclosure, firstName, businessName }) {
  const next = pickStrictPitch(pitch);
  const opener = `Hey ${firstName}, quick one — I've been looking at ${businessName} and had one specific website question, two minutes.`;
  next.openingLine = ensureDisclosurePrefix(opener, disclosure);
  next.valueProp = `$500 flat, same day. One focused page around the next thing you want a visitor to do. That's it.`;
  return next;
}

function dataDrivenPitch({ pitch, disclosure, firstName, signal, businessName }) {
  const next = pickStrictPitch(pitch);
  if (!signal) {
    // Fall back to the short-warm variant if there is no signal to anchor on.
    return shortWarmPitch({ pitch, disclosure, firstName, businessName });
  }
  const cleanSignal = lowerFirst(signal.replace(/^[-•*\s]+/, ''));
  const opener = `Hey ${firstName} — I noticed ${cleanSignal}, so calling about a focused $500 page.`;
  next.openingLine = ensureDisclosurePrefix(opener, disclosure);
  return next;
}

/**
 * Apply the `pitch_v2` experiment to a pitch object.
 *
 * @param {object} input
 * @param {object} input.lead       Lead row (needs `id` and `business_name`).
 * @param {object} input.pitch      A validated StrictSalesPitch object.
 * @param {object} [input.profile]  Optional profile memory snapshot.
 * @param {string} [input.disclosure] Recording disclosure prefix; if provided,
 *                                    rewritten openers will be prefixed so the
 *                                    `disclosure + ...` invariant holds even
 *                                    when the agent voices the opening line.
 *                                    (beginMessage is never modified here.)
 * @returns {{ pitch: object, assignment: object | null }}
 */
export function applyPitchExperiment({ lead, pitch, profile = {}, disclosure = '' } = {}) {
  if (!lead?.id || !pitch || typeof pitch !== 'object') {
    return { pitch, assignment: null };
  }

  // assignArm is idempotent on (experiment_key, bucket_key) so we always pass
  // lead.id as both the leadId and bucketKey. Subsequent calls return the
  // same row.
  const assignment = assignArm({
    experimentKey: EXPERIMENT_KEY,
    leadId: lead.id,
    bucketKey: lead.id,
    arms: ARMS
  });

  const arm = assignment?.arm || 'control';
  const firstName = deriveFirstName(lead, profile);
  const businessName = deriveBusinessName(lead, profile);
  const signal = deriveSignal(profile);

  let armed = pitch;
  if (arm === 'short_warm') {
    armed = shortWarmPitch({ pitch, disclosure, firstName, businessName });
  } else if (arm === 'data_driven') {
    armed = dataDrivenPitch({ pitch, disclosure, firstName, signal, businessName });
  }

  return { pitch: armed, assignment };
}

export const PITCH_EXPERIMENT_KEY = EXPERIMENT_KEY;
export const PITCH_EXPERIMENT_ARMS = ARMS;
