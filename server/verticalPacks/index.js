import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACK_KEY = 'default';
const MIN_OBJECTION_LENGTH = 4;
const MIN_RESPONSE_LENGTH = 12;
const MAX_OBJECTIONS_PER_PITCH = 6;

let packsCache = null;

/**
 * Read and cache every JSON file in the verticalPacks directory.
 * Returns a list of pack objects in insertion order. The cache is populated
 * once per process; tests can reset it by calling `_resetPacksCacheForTests`.
 */
export function loadAllPacks() {
  if (packsCache) return packsCache;
  const files = readdirSync(PACKS_DIR).filter((name) => name.endsWith('.json'));
  const packs = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(PACKS_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      const normalized = normalizePack(data);
      if (normalized) packs.push(normalized);
    } catch (err) {
      // Surface but do not crash: a malformed pack file should not kill the worker.
      // eslint-disable-next-line no-console
      console.warn(`verticalPacks.loadAllPacks: skipped ${file}: ${err?.message || err}`);
    }
  }
  packsCache = packs;
  return packsCache;
}

export function getPackByKey(key) {
  if (!key) return null;
  const normalized = String(key).toLowerCase().trim();
  return loadAllPacks().find((pack) => pack.key === normalized) || null;
}

export function getDefaultPack() {
  return getPackByKey(DEFAULT_PACK_KEY) || loadAllPacks()[0] || null;
}

/**
 * Normalize a lead's niche by lowercasing and stripping noise words like
 * "repair" or "services" so that "AC Repair Services" maps the same as "AC".
 */
export function normalizeNiche(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\b(repair|repairs|services|service|company|companies|llc|inc|co|shop|store|local|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pick the pack that matches a lead's niche, falling back to the default pack.
 * Match rules:
 *   - If `lead.vertical_pack` is already set, prefer that.
 *   - Otherwise, normalize the niche and compare against each pack's
 *     `matchNiches`. Entries that look like regex (start+end with /) are
 *     compiled and tested; everything else is treated as a substring.
 */
export function pickPack(lead = {}) {
  const packs = loadAllPacks();
  if (!packs.length) return null;

  const explicit = getPackByKey(lead?.vertical_pack);
  if (explicit) return explicit;

  const normalized = normalizeNiche(lead?.niche);
  if (normalized) {
    for (const pack of packs) {
      if (pack.key === DEFAULT_PACK_KEY) continue;
      for (const matcher of pack.matchNiches || []) {
        if (matchesNiche(normalized, matcher)) return pack;
      }
    }
  }
  return getDefaultPack();
}

/**
 * Return the price for a lead's matched pack, in cents. Falls back to the
 * default pack price if no specific pack matches.
 */
export function priceCentsForLead(lead = {}) {
  const pack = pickPack(lead);
  if (pack && Number.isFinite(pack.priceCents)) return pack.priceCents;
  const fallback = getDefaultPack();
  return fallback?.priceCents ?? null;
}

/**
 * Layer a pack's tuned value prop, objections, and price into a validated
 * pitch object. The returned object preserves every required pitch field and
 * stays inside the StrictSalesPitch shape (min/max constraints, etc.).
 */
export function applyPackToPitch(pitch, pack) {
  if (!pitch || typeof pitch !== 'object') return pitch;
  if (!pack || pack.key === DEFAULT_PACK_KEY) {
    // Default pack is intentionally a no-op so unmatched niches keep the
    // current $500 / current pitch behavior unchanged.
    return pitch;
  }

  const baseObjections = Array.isArray(pitch.objections) ? pitch.objections : [];
  const packObjections = Array.isArray(pack.objections) ? pack.objections : [];

  const next = { ...pitch };

  // 1. Tonal hook: weave the pack's hook into the value prop without losing
  // the call-script's own concrete signal text.
  if (pack.valuePropHook) {
    next.valueProp = mergeText(pitch.valueProp, pack.valuePropHook);
  }

  // 2. Objections: pack first, then existing pitch objections (deduped),
  // capped at the schema max so we do not break validateGeneratedPitch.
  const merged = dedupeObjections([
    ...packObjections.map((entry) => padObjection(entry, pack)),
    ...baseObjections.map((entry) => padObjection(entry, pack))
  ]).slice(0, MAX_OBJECTIONS_PER_PITCH);

  // Guarantee the strict-pitch minimum of 3.
  while (merged.length < 3) {
    merged.push(padObjection({
      objection: 'I need to think about it.',
      response: 'Take the time you need. I can send the invoice through AgentMail and you can reply with questions before deciding.'
    }, pack));
  }
  next.objections = merged;

  // 3. Close: include the pack price so the dollar figure in the close
  // matches what the invoice will actually charge.
  if (Number.isFinite(pack.priceCents) && typeof pitch.close === 'string') {
    next.close = rewriteCloseForPrice(pitch.close, pack.priceCents);
  }

  return next;
}

function normalizePack(data) {
  if (!data || typeof data !== 'object') return null;
  const key = data.key ? String(data.key).toLowerCase().trim() : null;
  if (!key) return null;
  return {
    key,
    name: data.name || key,
    matchNiches: Array.isArray(data.matchNiches) ? data.matchNiches.map((m) => String(m)) : [],
    priceCents: Number.isFinite(data.priceCents) ? Number(data.priceCents) : 50000,
    pitchTone: data.pitchTone || '',
    valuePropHook: data.valuePropHook || '',
    objections: Array.isArray(data.objections)
      ? data.objections.filter((o) => o && typeof o === 'object' && o.objection && o.response)
      : [],
    siteTemplateHint: data.siteTemplateHint || '',
    customerPersonaHint: data.customerPersonaHint || ''
  };
}

function matchesNiche(normalizedNiche, matcher) {
  if (!matcher) return false;
  const raw = String(matcher).trim();
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    try {
      const lastSlash = raw.lastIndexOf('/');
      const body = raw.slice(1, lastSlash);
      const flags = raw.slice(lastSlash + 1) || 'i';
      const re = new RegExp(body, flags);
      return re.test(normalizedNiche);
    } catch {
      // fall through to substring
    }
  }
  const normalizedMatcher = normalizeNiche(raw);
  if (!normalizedMatcher) return false;
  return normalizedNiche === normalizedMatcher || normalizedNiche.includes(normalizedMatcher);
}

function dedupeObjections(items) {
  const seen = new Set();
  const out = [];
  for (const entry of items) {
    if (!entry || !entry.objection || !entry.response) continue;
    const key = entry.objection.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function padObjection(entry, pack) {
  const objection = padToMinLength(entry?.objection, MIN_OBJECTION_LENGTH, 'No thanks.');
  const response = padToMinLength(
    entry?.response,
    MIN_RESPONSE_LENGTH,
    `Totally fair. ${pack?.valuePropHook || 'The offer is one flat fee, hosted, with no monthly cost.'}`
  );
  return { objection, response };
}

function padToMinLength(value, min, fallback) {
  const text = (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  if (text.length >= min) return text;
  const filler = String(fallback || '').replace(/\s+/g, ' ').trim();
  const combined = text ? `${text} ${filler}` : filler;
  return combined.length >= min ? combined : combined.padEnd(min, ' .').slice(0, Math.max(min, combined.length));
}

function mergeText(base, addition) {
  const baseText = (base == null ? '' : String(base)).replace(/\s+/g, ' ').trim();
  const add = (addition == null ? '' : String(addition)).replace(/\s+/g, ' ').trim();
  if (!add) return baseText;
  if (!baseText) return add;
  if (baseText.toLowerCase().includes(add.toLowerCase())) return baseText;
  const sep = /[.!?]$/.test(baseText) ? ' ' : '. ';
  return `${baseText}${sep}${add}`;
}

function rewriteCloseForPrice(close, priceCents) {
  const text = String(close || '').replace(/\s+/g, ' ').trim();
  if (!text) return text;
  const dollars = Math.round(priceCents / 100);
  const dollarPattern = /\$\s*\d{1,5}(?:[.,]\d{2})?/g;
  if (dollarPattern.test(text)) {
    return text.replace(dollarPattern, `$${dollars}`);
  }
  // No dollar amount in close — append the price phrase without breaking
  // the existing call-to-action language.
  const sep = /[.!?]$/.test(text) ? ' ' : '. ';
  return `${text}${sep}The flat fee is $${dollars}.`;
}

// Test-only helper: clears the in-memory cache so unit tests can rerun
// `loadAllPacks` against altered fixtures. Production code should never call it.
export function _resetPacksCacheForTests() {
  packsCache = null;
}
