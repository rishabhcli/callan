import { BusinessProfile } from './types.js';

const PRESENCE = new Set(['none', 'weak', 'mixed', 'strong']);
const PROFILE_SOURCES = new Set(['live_browser', 'gemini_mock', 'provided', 'memory_write', 'memory_repair', 'unknown']);
const DIRECT_PROFILE_SOURCES = new Set(['provided', 'memory_write']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY_RE = /^(n\/a|na|none|null|unknown|not listed|not found|no email|no website)$/i;

export function enrichBusinessProfile(input, context = {}) {
  const raw = objectLike(input);
  const candidate = objectLike(context.candidate);
  const sourceText = cleanText(context.sourceText, { max: 20000 }) || '';
  const profileSource = normalizeProfileSource(context.profileSource);
  const repaired = [];

  const businessName = firstText(raw.businessName, context.businessName, candidate.businessName, 'Unknown business');
  const niche = firstText(raw.niche, context.niche, 'local services');
  const city = firstText(raw.city, context.city, 'local area');
  const forceWeakPresence = Boolean(context.forceWeakPresence);
  const capturedAt = firstText(raw?.provenance?.capturedAt, context.capturedAt, new Date().toISOString());
  const trustedNormalizedUrls = raw?.sourceProvenance?.website === 'Website URL kept only after source/provided evidence check.'
    ? [raw.websiteUrl, ...(Array.isArray(raw.sourceUrls) ? raw.sourceUrls : [])].filter(Boolean)
    : [];
  const allowedUrls = DIRECT_PROFILE_SOURCES.has(profileSource) ? [
    context.sourceUrl,
    context.yelpUrl,
    candidate.yelpUrl,
    raw.sourceUrl,
    raw.yelpUrl,
    raw.websiteUrl
  ].filter(Boolean) : [
    context.sourceUrl,
    context.yelpUrl,
    candidate.yelpUrl,
    ...trustedNormalizedUrls
  ].filter(Boolean);

  const yelpUrl = sanitizeUrl(firstText(raw.yelpUrl, candidate.yelpUrl, context.yelpUrl), {
    sourceText,
    allowedUrls,
    profileSource,
    allowGenerated: context.allowGeneratedUrls
  });
  const sourceUrl = sanitizeUrl(firstText(raw.sourceUrl, context.sourceUrl, yelpUrl), {
    sourceText,
    allowedUrls: [...allowedUrls, yelpUrl].filter(Boolean),
    profileSource,
    allowGenerated: context.allowGeneratedUrls
  });
  const websiteUrl = forceWeakPresence ? null : sanitizeUrl(raw.websiteUrl, {
    sourceText,
    allowedUrls,
    profileSource,
    allowGenerated: context.allowGeneratedUrls
  });
  const bestContactEmail = sanitizeEmail(raw.bestContactEmail, { sourceText, profileSource });

  noteDropped('websiteUrl', raw.websiteUrl, websiteUrl, repaired);
  noteDropped('bestContactEmail', raw.bestContactEmail, bestContactEmail, repaired);
  noteDropped('sourceUrl', raw.sourceUrl, sourceUrl, repaired);
  noteDropped('yelpUrl', raw.yelpUrl, yelpUrl, repaired);

  const phone = firstText(raw.phone, context.phone, candidate.phoneHint, null);
  const address = firstText(raw.address, context.address, candidate.addressHint, null);
  const hasWebsite = forceWeakPresence ? false : Boolean(raw.hasWebsite || websiteUrl);
  const onlinePresenceStrength = forceWeakPresence
    ? 'weak'
    : (PRESENCE.has(raw.onlinePresenceStrength) ? raw.onlinePresenceStrength : 'mixed');
  if (!PRESENCE.has(raw.onlinePresenceStrength) && raw.onlinePresenceStrength) repaired.push('onlinePresenceStrength');

  const whatTheyDo = firstText(raw.whatTheyDo, raw.summary, raw.description, `${businessName} offers ${niche} in ${city}.`);
  const onlinePresenceSummary = firstText(
    raw.onlinePresenceSummary,
    summarizePresence({ strength: onlinePresenceStrength, hasWebsite })
  );
  const services = boundedList(raw.services, 8);
  const needs = boundedList(raw.needs, 6);
  const signals = boundedList(raw.signals, 8);
  const sourceUrls = sanitizeUrlList(raw.sourceUrls, {
    sourceText,
    allowedUrls,
    profileSource,
    allowGenerated: context.allowGeneratedUrls
  });
  const normalizedSourceUrls = unique([sourceUrl, yelpUrl, websiteUrl, ...sourceUrls].filter(Boolean)).slice(0, 10);
  const phoneProvenance = fieldProvenance({
    value: phone,
    field: 'phone',
    candidateValue: candidate.phoneHint || context.phone,
    sourceText,
    sourceUrl: sourceUrl || yelpUrl,
    profileSource
  });
  const addressProvenance = fieldProvenance({
    value: address,
    field: 'address',
    candidateValue: candidate.addressHint || context.address,
    sourceText,
    sourceUrl: sourceUrl || yelpUrl,
    profileSource
  });
  const confidence = numberOr(raw.onlinePresenceConfidence, numberOr(raw.presenceConfidence, defaultPresenceConfidence(onlinePresenceStrength)));
  const notWorthCallingReason = firstText(
    raw.notWorthCallingReason,
    onlinePresenceStrength === 'strong' ? 'Strong public presence; deprioritize outbound call.' : null
  );
  const profile = {
    businessName,
    phone,
    address,
    city,
    niche,
    hasWebsite,
    websiteUrl,
    onlinePresenceStrength,
    presenceConfidence: confidence,
    onlinePresenceSummary,
    onlinePresenceEvidence: buildOnlinePresenceEvidence({
      raw,
      hasWebsite,
      websiteUrl,
      yelpUrl,
      sourceUrl,
      sourceUrls: normalizedSourceUrls,
      signals,
      needs,
      onlinePresenceStrength,
      sourceText,
      allowedUrls,
      profileSource,
      allowGenerated: context.allowGeneratedUrls
    }),
    onlinePresenceReasons: boundedList(raw.onlinePresenceReasons, 8).length
      ? boundedList(raw.onlinePresenceReasons, 8)
      : [onlinePresenceSummary].filter(Boolean),
    onlinePresenceConfidence: confidence,
    notWorthCallingReason,
    callRecommendation: {
      shouldCall: onlinePresenceStrength !== 'strong',
      notWorthCalling: onlinePresenceStrength === 'strong',
      whyCall: onlinePresenceStrength === 'strong' ? null : onlinePresenceSummary,
      whyNotCall: notWorthCallingReason
    },
    ownerHypothesis: firstText(raw.ownerHypothesis, defaultOwnerHypothesis(businessName), null),
    customerPersona: firstText(raw.customerPersona, defaultCustomerPersona({ niche, city }), null),
    hours: normalizeHours(raw.hours),
    services: services.length ? services : defaultServices({ niche, whatTheyDo }),
    whatTheyDo,
    needs: needs.length ? needs : defaultNeeds({ hasWebsite, niche, whatTheyDo }),
    signals: signals.length ? signals : defaultSignals({ profileSource, onlinePresenceStrength }),
    bestContactEmail,
    yelpUrl,
    sourceUrl,
    sourceUrls: normalizedSourceUrls,
    sourceProvenance: {
      phone: phoneProvenance.evidence,
      address: addressProvenance.evidence,
      website: websiteUrl ? 'Website URL kept only after source/provided evidence check.' : null,
      profile: `${profileSource} profile normalized at ${capturedAt}.`
    },
    provenance: {
      profileSource,
      sourceUrl,
      yelpUrl,
      capturedAt,
      phone: phoneProvenance,
      address: addressProvenance
    }
  };

  const parsed = BusinessProfile.safeParse(profile);
  if (parsed.success) {
    return { profile: parsed.data, valid: true, repaired: repaired.length > 0, repairs: unique(repaired) };
  }

  const fallback = repairHard(profile);
  const fallbackParsed = BusinessProfile.safeParse(fallback);
  if (fallbackParsed.success) {
    return {
      profile: fallbackParsed.data,
      valid: false,
      repaired: true,
      repairs: unique([...repaired, ...Object.keys(parsed.error.flatten().fieldErrors)])
    };
  }

  throw new Error(`BusinessProfile repair failed: ${fallbackParsed.error.message}`);
}

export function repairBusinessProfile(input, context = {}) {
  return enrichBusinessProfile(input, context).profile;
}

export function validateBusinessProfile(input) {
  return BusinessProfile.safeParse(input);
}

function objectLike(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeProfileSource(value) {
  return PROFILE_SOURCES.has(value) ? value : 'unknown';
}

function firstText(...values) {
  for (const value of values) {
    const out = cleanText(value);
    if (out) return out;
  }
  return null;
}

function cleanText(value, { max = 500 } = {}) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || EMPTY_RE.test(trimmed)) return null;
  return trimmed.replace(/\s+/g, ' ').slice(0, max);
}

function boundedList(value, max) {
  const input = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/\n|;|\|/) : []);
  return unique(input.map((x) => cleanText(x, { max: 140 })).filter(Boolean)).slice(0, max);
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeHours(value) {
  if (typeof value === 'string') return cleanText(value, { max: 220 }) || 'Unknown; not found in source.';
  if (Array.isArray(value)) {
    const parts = boundedList(value, 14);
    if (parts.length) return parts.join('; ');
  }
  if (value && typeof value === 'object') {
    const parts = Object.entries(value)
      .map(([day, hours]) => `${day}: ${String(hours)}`)
      .map((x) => cleanText(x, { max: 80 }))
      .filter(Boolean);
    if (parts.length) return parts.join('; ').slice(0, 220);
  }
  return 'Unknown; not found in source.';
}

function sanitizeUrlList(value, options) {
  const input = Array.isArray(value) ? value : [];
  return unique(input.map((url) => sanitizeUrl(url, options)).filter(Boolean)).slice(0, 10);
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function defaultPresenceConfidence(strength) {
  if (strength === 'strong') return 0.8;
  if (strength === 'none') return 0.55;
  return 0.65;
}

function buildOnlinePresenceEvidence({
  raw,
  hasWebsite,
  websiteUrl,
  yelpUrl,
  sourceUrl,
  sourceUrls,
  signals,
  needs,
  onlinePresenceStrength,
  sourceText,
  allowedUrls,
  profileSource,
  allowGenerated
}) {
  const rawEvidence = objectLike(raw.onlinePresenceEvidence);
  const rawWebsite = objectLike(rawEvidence.website);
  const rawSocial = objectLike(rawEvidence.social);
  const rawListings = objectLike(rawEvidence.listings);
  const listingUrls = unique([yelpUrl, sourceUrl, ...sourceUrls].filter(Boolean)).slice(0, 8);
  return {
    website: {
      found: hasWebsite,
      url: websiteUrl,
      evidence: boundedList(rawWebsite.evidence, 5).length
        ? boundedList(rawWebsite.evidence, 5)
        : [hasWebsite ? 'Website evidence survived URL provenance checks.' : 'No owned website URL survived provenance checks.']
    },
    social: {
      found: Boolean(rawSocial.found),
      platforms: boundedList(rawSocial.platforms, 8),
      urls: sanitizeUrlList(rawSocial.urls, { sourceText, allowedUrls, profileSource, allowGenerated }),
      evidence: boundedList(rawSocial.evidence, 5)
    },
    listings: {
      found: listingUrls.length > 0,
      platforms: yelpUrl ? ['yelp'] : boundedList(rawListings.platforms, 8),
      urls: listingUrls,
      evidence: boundedList(rawListings.evidence, 5).length
        ? boundedList(rawListings.evidence, 5)
        : (listingUrls.length ? ['Directory/listing source URL retained with provenance.'] : [])
    },
    gaps: boundedList(rawEvidence.gaps, 8).length
      ? boundedList(rawEvidence.gaps, 8)
      : defaultPresenceGaps({ hasWebsite, onlinePresenceStrength, needs }),
    positiveSignals: boundedList(rawEvidence.positiveSignals, 8).length
      ? boundedList(rawEvidence.positiveSignals, 8)
      : signals.slice(0, 8)
  };
}

function defaultPresenceGaps({ hasWebsite, onlinePresenceStrength, needs }) {
  if (onlinePresenceStrength === 'strong') return [];
  const gaps = [];
  if (!hasWebsite) gaps.push('No owned website URL confirmed from source evidence.');
  gaps.push(...needs.slice(0, 4));
  return unique(gaps).slice(0, 8);
}

function sanitizeEmail(value, { sourceText, profileSource }) {
  const email = cleanText(value, { max: 254 })?.replace(/^mailto:/i, '').toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return null;
  if (DIRECT_PROFILE_SOURCES.has(profileSource)) return email;
  return sourceText.toLowerCase().includes(email) ? email : null;
}

function sanitizeUrl(value, { sourceText, allowedUrls = [], profileSource, allowGenerated }) {
  const raw = cleanText(value, { max: 1200 });
  if (!raw) return null;
  const url = normalizeUrl(raw);
  if (!url) return null;
  if (DIRECT_PROFILE_SOURCES.has(profileSource)) return url;
  if (hasUrlEvidence(url, sourceText, allowedUrls)) return url;
  if (allowGenerated === false) return null;
  return null;
}

function normalizeUrl(value) {
  const stripped = String(value)
    .replace(/[),.;\]}]+$/g, '')
    .replace(/^<|>$/g, '')
    .trim();
  if (/^demo:\/\//i.test(stripped)) return stripped;
  const withScheme = /^https?:\/\//i.test(stripped)
    ? stripped
    : (/^(www\.|[a-z0-9-]+\.)[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(stripped) ? `https://${stripped}` : stripped);
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function hasUrlEvidence(url, sourceText, allowedUrls) {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  const host = hostKey(normalized);
  const lowerSource = String(sourceText || '').toLowerCase();
  if (lowerSource.includes(normalized.toLowerCase()) || (host && lowerSource.includes(host))) return true;
  return allowedUrls.some((candidate) => {
    const normalizedCandidate = normalizeUrl(candidate);
    return normalizedCandidate && (normalizedCandidate === normalized || hostKey(normalizedCandidate) === host);
  });
}

function hostKey(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function fieldProvenance({ value, field, candidateValue, sourceText, sourceUrl, profileSource }) {
  if (!value) return { value: null, source: 'none', sourceUrl: null, evidence: null };
  const evidence = field === 'phone'
    ? phoneEvidence(value, sourceText)
    : addressEvidence(value, sourceText);
  if (evidence) return { value, source: 'source_text', sourceUrl: sourceUrl || null, evidence };
  if (candidateValue && sameLoose(value, candidateValue)) {
    return { value, source: 'candidate', sourceUrl: sourceUrl || null, evidence: `${field} came from candidate listing hint.` };
  }
  if (profileSource === 'gemini_mock') return { value, source: 'mock', sourceUrl: null, evidence: 'Demo profile generated in mock mode.' };
  if (DIRECT_PROFILE_SOURCES.has(profileSource)) return { value, source: 'provided', sourceUrl: sourceUrl || null, evidence: `${field} provided by caller.` };
  return { value, source: 'model', sourceUrl: sourceUrl || null, evidence: `${field} extracted during profile normalization; verify before live use.` };
}

function phoneEvidence(phone, sourceText) {
  const target = digits(phone).slice(-7);
  if (!target || !sourceText) return null;
  return digits(sourceText).includes(target) ? 'Matching phone digits found in source text.' : null;
}

function addressEvidence(address, sourceText) {
  if (!address || !sourceText) return null;
  const normalizedSource = sourceText.toLowerCase();
  const normalizedAddress = String(address).toLowerCase();
  if (normalizedSource.includes(normalizedAddress)) return 'Exact address found in source text.';
  const streetNo = normalizedAddress.match(/\b\d{1,6}\b/)?.[0];
  const streetWord = normalizedAddress.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).find((w) => w.length > 4);
  if (streetNo && streetWord && normalizedSource.includes(streetNo) && normalizedSource.includes(streetWord)) {
    return 'Address number and street token found in source text.';
  }
  return null;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function sameLoose(a, b) {
  if (!a || !b) return false;
  if (digits(a) && digits(b)) return digits(a).slice(-7) === digits(b).slice(-7);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function noteDropped(field, original, sanitized, repaired) {
  if (original && !sanitized) repaired.push(`${field}:dropped_unproven`);
}

function summarizePresence({ strength, hasWebsite }) {
  if (strength === 'strong') return 'Strong public presence with enough online detail for customers to understand and contact the business.';
  if (strength === 'mixed') return hasWebsite
    ? 'Some online presence exists, but the offer, proof, or conversion path is not clearly packaged.'
    : 'Directory listings exist, but there is no clear owned website presence.';
  if (strength === 'none') return 'No meaningful owned online presence found from the available research.';
  return 'Weak online presence: customers can find a listing, but the business story, services, proof, and booking path need clearer packaging.';
}

function defaultOwnerHypothesis(businessName) {
  const owner = String(businessName || '').match(/^([A-Z][a-z]+)'s\b/)?.[1];
  if (owner) return `Owner-operated hypothesis from business name; verify that ${owner} is the owner before using their name.`;
  return 'Owner/operator unknown; verify decision-maker before personalizing.';
}

function defaultCustomerPersona({ niche, city }) {
  return `Local customers in ${city} looking for clear ${niche} options, pricing or trust signals, and a fast way to contact the business.`;
}

function defaultServices({ niche, whatTheyDo }) {
  const base = cleanText(whatTheyDo, { max: 80 });
  return unique([base, `${niche} services`].filter(Boolean)).slice(0, 8);
}

function defaultNeeds({ hasWebsite, niche, whatTheyDo }) {
  const needs = [
    `clear explanation of ${whatTheyDo || `${niche} services`}`,
    'tap-to-call contact path',
    'hours, location, and trust signals'
  ];
  if (!hasWebsite) needs.unshift('owned website');
  return needs.slice(0, 6);
}

function defaultSignals({ profileSource, onlinePresenceStrength }) {
  return unique([
    `source:${profileSource}`,
    `presence:${onlinePresenceStrength}`
  ]).slice(0, 8);
}

function repairHard(profile) {
  return {
    ...profile,
    businessName: profile.businessName || 'Unknown business',
    city: profile.city || 'local area',
    niche: profile.niche || 'local services',
    onlinePresenceStrength: PRESENCE.has(profile.onlinePresenceStrength) ? profile.onlinePresenceStrength : 'mixed',
    services: Array.isArray(profile.services) ? profile.services.slice(0, 8) : ['local services'],
    needs: Array.isArray(profile.needs) ? profile.needs.slice(0, 6) : ['clear service information'],
    signals: Array.isArray(profile.signals) ? profile.signals.slice(0, 8) : [],
    provenance: {
      profileSource: PROFILE_SOURCES.has(profile?.provenance?.profileSource) ? profile.provenance.profileSource : 'memory_repair',
      sourceUrl: profile?.provenance?.sourceUrl || profile.sourceUrl || null,
      yelpUrl: profile?.provenance?.yelpUrl || profile.yelpUrl || null,
      capturedAt: profile?.provenance?.capturedAt || new Date().toISOString(),
      phone: repairFieldProvenance(profile?.provenance?.phone, profile.phone),
      address: repairFieldProvenance(profile?.provenance?.address, profile.address)
    }
  };
}

function repairFieldProvenance(value, fieldValue) {
  if (value && typeof value === 'object') {
    return {
      value: typeof value.value === 'string' ? value.value : fieldValue || null,
      source: ['source_text', 'candidate', 'provided', 'model', 'mock', 'repair', 'none'].includes(value.source) ? value.source : 'repair',
      sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : null,
      evidence: typeof value.evidence === 'string' ? value.evidence : null
    };
  }
  return {
    value: fieldValue || null,
    source: fieldValue ? 'repair' : 'none',
    sourceUrl: null,
    evidence: fieldValue ? 'Repaired from legacy profile field.' : null
  };
}
