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
  const underscoreKey = normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return loadAllPacks().find((pack) => pack.key === normalized || pack.key === underscoreKey) || null;
}

export function getDefaultPack() {
  return getPackByKey(DEFAULT_PACK_KEY) || loadAllPacks()[0] || null;
}

export function listInstalledPacks() {
  return loadAllPacks().filter((pack) => pack.status !== 'retired');
}

export function listRetiredPacks() {
  return loadAllPacks().filter((pack) => pack.status === 'retired');
}

export function getPackVersion(key) {
  return getPackByKey(key)?.version || null;
}

export function isPackInstalled(key) {
  const pack = getPackByKey(key);
  return Boolean(pack && pack.status !== 'retired');
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
  const packs = listInstalledPacks();
  if (!packs.length) return null;

  const explicit = getPackByKey(lead?.vertical_pack);
  if (explicit && explicit.status !== 'retired') return explicit;

  const normalized = normalizeNiche(lead?.niche);
  if (normalized) {
    for (const pack of packs) {
      if (pack.key === DEFAULT_PACK_KEY) continue;
      for (const matcher of pack.matchNiches || []) {
        if (matchesNiche(normalized, matcher)) return pack;
      }
    }
  }
  return packs.find((pack) => pack.key === DEFAULT_PACK_KEY) || getDefaultPack();
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
  const packPriceCents = Number.isFinite(pack.priceCents) ? pack.priceCents : null;
  if (pack.valuePropHook) {
    next.valueProp = mergeText(rewriteTextForPrice(pitch.valueProp, packPriceCents), pack.valuePropHook);
  } else if (packPriceCents) {
    next.valueProp = rewriteTextForPrice(pitch.valueProp, packPriceCents);
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
  if (packPriceCents && typeof pitch.close === 'string') {
    next.close = rewriteCloseForPrice(pitch.close, packPriceCents);
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
    version: normalizePackVersion(data.version),
    status: normalizePackStatus(data.status),
    installedAt: normalizePackTimestamp(data.installedAt),
    retiredAt: normalizePackTimestamp(data.retiredAt),
    retiredReason: data.retiredReason ? String(data.retiredReason).replace(/\s+/g, ' ').trim() : '',
    supersededByKey: data.supersededByKey ? String(data.supersededByKey).toLowerCase().trim() : '',
    matchNiches: Array.isArray(data.matchNiches) ? data.matchNiches.map((m) => String(m)) : [],
    priceCents: Number.isFinite(data.priceCents) ? Number(data.priceCents) : 50000,
    pitchTone: data.pitchTone || '',
    valuePropHook: data.valuePropHook || '',
    objections: Array.isArray(data.objections)
      ? data.objections.filter((o) => o && typeof o === 'object' && o.objection && o.response)
      : [],
    objectionMap: data.objectionMap && typeof data.objectionMap === 'object' ? data.objectionMap : {},
    reviewValueProps: Array.isArray(data.reviewValueProps) ? data.reviewValueProps.map((v) => String(v)).filter(Boolean).slice(0, 8) : [],
    siteTemplateHint: data.siteTemplateHint || '',
    customerPersonaHint: data.customerPersonaHint || '',
    marketSignals: normalizeManifestList(data.marketSignals, 12),
    leadSources: normalizeManifestList(data.leadSources, 12),
    compliance: normalizeManifestObject(data.compliance),
    serviceOffer: normalizeServiceOffer(data.serviceOffer, data.priceCents),
    fulfillmentRequirements: normalizeManifestList(data.fulfillmentRequirements, 12),
    vendorRequirements: normalizeManifestList(data.vendorRequirements, 12),
    qaRules: normalizeManifestList(data.qaRules, 12),
    portalCopy: normalizeManifestObject(data.portalCopy),
    trustRequirements: normalizeManifestList(data.trustRequirements, 12),
    reviewStrategy: normalizeManifestList(data.reviewStrategy, 12),
    growthPaths: normalizeManifestList(data.growthPaths, 12),
    retentionLoops: normalizeManifestList(data.retentionLoops, 12),
    marginModel: normalizeMarginModel(data.marginModel, data.priceCents),
    launchChecklist: normalizeManifestList(data.launchChecklist, 16),
    evals: normalizeManifestList(data.evals, 12)
  };
}

function normalizePackVersion(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(text) ? text : '1.0.0';
}

function normalizePackStatus(value) {
  const text = String(value || 'installed').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return ['installed', 'retired', 'draft'].includes(text) ? text : 'installed';
}

function normalizePackTimestamp(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeManifestList(value, max = 12) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeManifestValue(item))
    .filter((item) => {
      if (!item) return false;
      if (typeof item === 'string') return item.length > 0;
      return Object.keys(item).length > 0;
    })
    .slice(0, max);
}

function normalizeManifestObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeManifestValue(item);
    if (normalized == null) continue;
    out[String(key)] = normalized;
  }
  return out;
}

function normalizeManifestValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return normalizeManifestList(value, 20);
  if (typeof value === 'object') return normalizeManifestObject(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

function normalizeServiceOffer(value, fallbackPriceCents) {
  const offer = normalizeManifestObject(value);
  const packages = normalizeManifestList(value?.packages, 8).map((pkg, index) => {
    if (typeof pkg === 'string') {
      return {
        key: `package-${index + 1}`,
        name: pkg,
        priceCents: Number.isFinite(fallbackPriceCents) ? fallbackPriceCents : 50000
      };
    }
    return {
      key: pkg.key || `package-${index + 1}`,
      name: pkg.name || pkg.key || `Package ${index + 1}`,
      description: pkg.description || '',
      priceCents: Number.isFinite(Number(pkg.priceCents)) ? Number(pkg.priceCents) : (Number.isFinite(fallbackPriceCents) ? fallbackPriceCents : 50000)
    };
  });
  return {
    headline: offer.headline || '',
    customerOutcome: offer.customerOutcome || '',
    packages,
    refundPolicy: offer.refundPolicy || '',
    proofAssets: normalizeManifestList(value?.proofAssets, 8)
  };
}

function normalizeMarginModel(value, fallbackPriceCents) {
  const model = normalizeManifestObject(value);
  const basePriceCents = Number(model.basePriceCents);
  const estimatedFulfillmentCostCents = Number(model.estimatedFulfillmentCostCents);
  const targetGrossMarginPct = Number(model.targetGrossMarginPct);
  const maxAcquisitionCostPct = Number(model.maxAcquisitionCostPct);
  return {
    basePriceCents: Number.isFinite(basePriceCents) ? basePriceCents : (Number.isFinite(fallbackPriceCents) ? fallbackPriceCents : 50000),
    estimatedFulfillmentCostCents: Number.isFinite(estimatedFulfillmentCostCents) ? estimatedFulfillmentCostCents : null,
    targetGrossMarginPct: Number.isFinite(targetGrossMarginPct) ? targetGrossMarginPct : 35,
    maxAcquisitionCostPct: Number.isFinite(maxAcquisitionCostPct) ? maxAcquisitionCostPct : 18,
    notes: model.notes || ''
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
    rewriteTextForPrice(entry?.response, pack?.priceCents),
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
  const rewritten = rewriteTextForPrice(text, priceCents);
  if (rewritten !== text) return rewritten;
  const dollars = Math.round(priceCents / 100);
  // No dollar amount in close — append the price phrase without breaking
  // the existing call-to-action language.
  const sep = /[.!?]$/.test(text) ? ' ' : '. ';
  return `${text}${sep}The flat fee is $${dollars}.`;
}

function rewriteTextForPrice(value, priceCents) {
  if (!Number.isFinite(priceCents)) return value;
  const text = value == null ? '' : String(value);
  if (!text) return text;
  const dollars = Math.round(priceCents / 100);
  const replacement = `$${dollars}`;
  return text
    .replace(/\$\s*\d{1,5}(?:[.,]\d{2})?/g, replacement)
    .replace(/\b(?:four|five|six)\s+hundred\b/gi, replacement);
}

// Test-only helper: clears the in-memory cache so unit tests can rerun
// `loadAllPacks` against altered fixtures. Production code should never call it.
export function _resetPacksCacheForTests() {
  packsCache = null;
}
