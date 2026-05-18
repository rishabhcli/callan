export const ONLINE_PRESENCE_STRENGTHS = Object.freeze(['none', 'weak', 'mixed', 'strong']);

const SOCIAL_PLATFORMS = [
  { name: 'facebook', hosts: ['facebook.com', 'fb.com'], mention: /\bfacebook\b/i },
  { name: 'instagram', hosts: ['instagram.com'], mention: /\b(instagram|insta)\b/i },
  { name: 'tiktok', hosts: ['tiktok.com'], mention: /\btiktok\b/i },
  { name: 'x', hosts: ['x.com', 'twitter.com'], mention: /\b(twitter|x\.com)\b/i },
  { name: 'linkedin', hosts: ['linkedin.com'], mention: /\blinkedin\b/i },
  { name: 'youtube', hosts: ['youtube.com', 'youtu.be'], mention: /\byoutube\b/i }
];

const LISTING_PLATFORMS = [
  { name: 'yelp', hosts: ['yelp.com'], mention: /\byelp\b/i },
  { name: 'google maps', hosts: ['google.com', 'maps.google.com', 'goo.gl', 'g.co'], mention: /\b(google maps|google business|google profile)\b/i },
  { name: 'tripadvisor', hosts: ['tripadvisor.com'], mention: /\btripadvisor\b/i },
  { name: 'yellow pages', hosts: ['yellowpages.com'], mention: /\byellow pages\b/i },
  { name: 'bbb', hosts: ['bbb.org'], mention: /\b(bbb|better business bureau)\b/i },
  { name: 'thumbtack', hosts: ['thumbtack.com'], mention: /\bthumbtack\b/i },
  { name: 'angi', hosts: ['angi.com', 'angieslist.com'], mention: /\b(angi|angie's list)\b/i },
  { name: 'houzz', hosts: ['houzz.com'], mention: /\bhouzz\b/i },
  { name: 'opentable', hosts: ['opentable.com'], mention: /\bopentable\b/i },
  { name: 'foursquare', hosts: ['foursquare.com'], mention: /\bfoursquare\b/i },
  { name: 'mapquest', hosts: ['mapquest.com'], mention: /\bmapquest\b/i },
  { name: 'nextdoor', hosts: ['nextdoor.com'], mention: /\bnextdoor\b/i },
  { name: 'doordash', hosts: ['doordash.com'], mention: /\bdoordash\b/i },
  { name: 'ubereats', hosts: ['ubereats.com'], mention: /\b(uber eats|ubereats)\b/i },
  { name: 'grubhub', hosts: ['grubhub.com'], mention: /\bgrubhub\b/i }
];

const POSITIVE_SIGNAL_PATTERNS = [
  { label: 'services/menu are described online', pattern: /\b(services?|menu|treatments?|classes?|packages?)\b/i },
  { label: 'hours are visible online', pattern: /\bhours?\b/i },
  { label: 'online booking or ordering path exists', pattern: /\b(book(ing)? online|schedule online|reservations?|order online|online ordering|appointments?)\b/i },
  { label: 'contact path is visible online', pattern: /\b(contact form|tap[- ]?to[- ]?call|phone|email|contact)\b/i },
  { label: 'reviews or testimonials are visible', pattern: /\b(reviews?|ratings?|testimonials?|stars?)\b/i },
  { label: 'photos or portfolio are visible', pattern: /\b(photos?|gallery|portfolio|before and after|images?)\b/i },
  { label: 'prices or offers are visible', pattern: /\b(pric(e|ing)|rates?|quote|estimate|offers?)\b/i },
  { label: 'business story or trust proof is visible', pattern: /\b(family[- ]owned|owner[- ]operated|established|licensed|insured|certified)\b/i }
];

const GAP_PATTERNS = [
  { label: 'no owned website found', pattern: /\b(no|none|without|missing|does not have|doesn't have|not found)\b.{0,40}\b(owned )?(business )?(website|site)\b/i },
  { label: 'website field is explicitly empty', pattern: /\b(business )?website\s*:\s*(none|null|n\/a|not found|no)\b/i },
  { label: 'website appears outdated', pattern: /\b(outdated|old|stale|last updated|dated)\b/i },
  { label: 'website appears sparse', pattern: /\b(sparse|thin|bare|minimal|little detail|not clearly explain|does not clearly explain|unclear)\b/i },
  { label: 'website or link appears broken', pattern: /\b(broken|dead link|not loading|404|parked domain|expired)\b/i },
  { label: 'no online booking path found', pattern: /\b(no|missing|without)\b.{0,40}\b(booking|appointment|reservation|order online|scheduling)\b/i },
  { label: 'no clear services/menu detail found', pattern: /\b(no|missing|without|unclear)\b.{0,40}\b(services?|menu|pricing|offer)\b/i },
  { label: 'third-party listing only', pattern: /\b(directory|listing|third[- ]party|yelp)\b.{0,30}\b(only|presence)\b/i },
  { label: 'social profile only', pattern: /\b(facebook|instagram|social)\b.{0,30}\b(only|presence)\b/i }
];

export function scoreOnlinePresence(profile = {}, options = {}) {
  const forceWeakPresence = Boolean(options.forceWeakPresence);
  const rawText = String(options.rawText || '');
  const text = collectPresenceText(profile, rawText);
  const urls = collectUrls(profile, text);
  const classified = urls.map(classifyUrl);

  const ownedWebsiteUrls = unique(classified.filter((u) => u.kind === 'website').map((u) => u.url));
  const socialUrlRows = classified.filter((u) => u.kind === 'social');
  const listingUrlRows = classified.filter((u) => u.kind === 'listing');
  const negativeWebsiteEvidence = hasNegativeWebsiteEvidence(text);

  const existingEvidence = normalizeEvidence(profile.onlinePresenceEvidence);
  const socialPlatforms = unique([
    ...socialUrlRows.map((u) => u.platform),
    ...existingEvidence.social.platforms,
    ...mentionedPlatforms(text, SOCIAL_PLATFORMS),
    ...signalsMentionPlatforms(profile.signals, SOCIAL_PLATFORMS)
  ]).slice(0, 8);
  const listingPlatforms = unique([
    ...listingUrlRows.map((u) => u.platform),
    ...existingEvidence.listings.platforms,
    ...mentionedPlatforms(text, LISTING_PLATFORMS),
    ...signalsMentionPlatforms(profile.signals, LISTING_PLATFORMS)
  ]).slice(0, 8);

  const websiteUrl = forceWeakPresence ? null : firstOwnedWebsite(profile.websiteUrl, ownedWebsiteUrls);
  const hasWebsite = !forceWeakPresence && Boolean(
    websiteUrl ||
    (profile.hasWebsite === true && !negativeWebsiteEvidence) ||
    (existingEvidence.website.found && !negativeWebsiteEvidence)
  );
  const listingUrls = unique([
    ...listingUrlRows.map((u) => u.url),
    ...existingEvidence.listings.urls,
    normalizeUrl(profile.yelpUrl),
    normalizeUrl(profile.sourceUrl)
  ].filter(Boolean)).slice(0, 8);
  const socialUrls = unique([
    ...socialUrlRows.map((u) => u.url),
    ...existingEvidence.social.urls
  ]).slice(0, 8);

  const positiveSignals = unique([
    ...existingEvidence.positiveSignals,
    ...labelsFromPatterns(text, POSITIVE_SIGNAL_PATTERNS),
    ...positiveSignalsFromTags(profile.signals)
  ]).slice(0, 8);
  const gaps = unique([
    ...existingEvidence.gaps,
    ...labelsFromPatterns(text, GAP_PATTERNS),
    ...gapSignalsFromTags(profile.signals),
    ...(hasWebsite ? [] : ['no owned website found'])
  ]).slice(0, 8);

  const evidence = {
    website: {
      found: hasWebsite,
      url: websiteUrl,
      evidence: websiteEvidence({ hasWebsite, websiteUrl, negativeWebsiteEvidence, profile }).slice(0, 5)
    },
    social: {
      found: Boolean(socialPlatforms.length || socialUrls.length || existingEvidence.social.found),
      platforms: socialPlatforms,
      urls: socialUrls,
      evidence: socialEvidence({ socialPlatforms, socialUrls }).slice(0, 5)
    },
    listings: {
      found: Boolean(listingPlatforms.length || listingUrls.length || existingEvidence.listings.found),
      platforms: listingPlatforms,
      urls: listingUrls,
      evidence: listingEvidence({ listingPlatforms, listingUrls }).slice(0, 5)
    },
    gaps,
    positiveSignals
  };

  const requestedStrength = normalizePresenceStrength(profile.onlinePresenceStrength);
  const onlinePresenceStrength = inferStrength({
    forceWeakPresence,
    requestedStrength,
    evidence
  });
  const onlinePresenceReasons = buildReasons({ strength: onlinePresenceStrength, evidence }).slice(0, 8);
  const onlinePresenceSummary = chooseSummary({
    profile,
    requestedStrength,
    strength: onlinePresenceStrength,
    evidence
  });
  const onlinePresenceConfidence = confidenceScore({ profile, rawText, urls, evidence, requestedStrength });
  const notWorthCallingReason = onlinePresenceStrength === 'strong'
    ? buildNotWorthCallingReason({ evidence, websiteUrl })
    : null;

  return {
    hasWebsite,
    websiteUrl,
    yelpUrl: profile.yelpUrl || listingUrls.find((url) => classifyUrl(url).platform === 'yelp') || null,
    sourceUrl: profile.sourceUrl || profile.yelpUrl || listingUrls[0] || websiteUrl || null,
    onlinePresenceStrength,
    presenceConfidence: onlinePresenceConfidence,
    onlinePresenceSummary,
    onlinePresenceEvidence: evidence,
    onlinePresenceReasons,
    onlinePresenceConfidence,
    notWorthCallingReason,
    callRecommendation: buildCallRecommendation({
      strength: onlinePresenceStrength,
      onlinePresenceReasons,
      notWorthCallingReason
    })
  };
}

export function normalizePresenceStrength(value, fallback = null) {
  return ONLINE_PRESENCE_STRENGTHS.includes(value) ? value : fallback;
}

export function detectPresenceUrls(input = '') {
  return extractUrls(String(input)).map(classifyUrl);
}

// 0-100 numeric presence score. LOWER means worse online presence (more "callable").
// Used by lead prioritization so a weak-presence lead floats to the top of outreach.
const STRENGTH_BASE_SCORE = Object.freeze({
  none: 5,
  weak: 25,
  mixed: 55,
  strong: 90
});

export function presenceScoreFor(input = {}, options = {}) {
  // Accept either a raw profile or an already-computed scoreOnlinePresence result.
  const scored = input && typeof input === 'object' && input.onlinePresenceEvidence && 'onlinePresenceStrength' in input
    ? input
    : scoreOnlinePresence(input || {}, options);
  const strength = normalizePresenceStrength(scored.onlinePresenceStrength, 'weak');
  const evidence = scored.onlinePresenceEvidence || { website: {}, social: {}, listings: {}, positiveSignals: [], gaps: [] };
  let score = STRENGTH_BASE_SCORE[strength] ?? STRENGTH_BASE_SCORE.weak;
  // Layer in evidence so two leads with the same strength can be ranked.
  if (evidence.website?.found) score += 10;
  if (evidence.social?.found) score += 3;
  if (evidence.listings?.found) score += 2;
  score += Math.min(8, (evidence.positiveSignals?.length || 0) * 2);
  score -= Math.min(12, (evidence.gaps?.length || 0) * 2);
  if (typeof scored.presenceConfidence === 'number') {
    // Confidence pulls extreme strong/none scores toward their archetype.
    const pivot = strength === 'strong' || strength === 'mixed' ? 50 : 30;
    score = score + (score - pivot) * 0.15 * scored.presenceConfidence;
  }
  return clamp(Math.round(score), 0, 100);
}

function collectPresenceText(profile, rawText) {
  const chunks = [
    rawText,
    profile.onlinePresenceSummary,
    profile.websiteUrl,
    profile.yelpUrl,
    profile.sourceUrl,
    profile.whatTheyDo,
    profile.ownerHypothesis,
    profile.customerPersona,
    Array.isArray(profile.signals) ? profile.signals.join(' ') : '',
    Array.isArray(profile.onlinePresenceReasons) ? profile.onlinePresenceReasons.join(' ') : ''
  ];
  if (profile.onlinePresenceEvidence) {
    try {
      chunks.push(JSON.stringify(profile.onlinePresenceEvidence));
    } catch {
      // Ignore malformed evidence objects from model output.
    }
  }
  return chunks.filter(Boolean).join('\n');
}

function collectUrls(profile, text) {
  return unique([
    normalizeUrl(profile.websiteUrl),
    normalizeUrl(profile.yelpUrl),
    normalizeUrl(profile.sourceUrl),
    ...extractUrls(text)
  ].filter(Boolean));
}

function extractUrls(text) {
  const matches = String(text).match(/https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/gi) || [];
  return matches.map(normalizeUrl).filter(Boolean);
}

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/[.,;:)\]}]+$/g, '');
  if (!trimmed || /^(none|null|n\/a|not found)$/i.test(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

function classifyUrl(url) {
  const normalized = normalizeUrl(url) || url;
  const host = hostname(normalized);
  const social = SOCIAL_PLATFORMS.find((p) => hostMatches(host, p.hosts));
  if (social) return { url: normalized, kind: 'social', platform: social.name };
  const listing = LISTING_PLATFORMS.find((p) => hostMatches(host, p.hosts) && isListingUrl(host, normalized, p.name));
  if (listing) return { url: normalized, kind: 'listing', platform: listing.name };
  return { url: normalized, kind: 'website', platform: 'owned website' };
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(host, hosts) {
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

function isListingUrl(host, url, platform) {
  if (platform !== 'google maps') return true;
  return /\/maps\b|maps\.google\.com|goo\.gl|g\.co/i.test(`${host}${url}`);
}

function firstOwnedWebsite(profileWebsiteUrl, ownedWebsiteUrls) {
  const explicit = normalizeUrl(profileWebsiteUrl);
  if (explicit && classifyUrl(explicit).kind === 'website') return explicit;
  return ownedWebsiteUrls[0] || null;
}

function hasNegativeWebsiteEvidence(text) {
  return GAP_PATTERNS.slice(0, 2).some((item) => item.pattern.test(text));
}

function mentionedPlatforms(text, platforms) {
  return platforms.filter((p) => p.mention.test(text)).map((p) => p.name);
}

function signalsMentionPlatforms(signals, platforms) {
  const text = Array.isArray(signals) ? signals.join(' ') : '';
  return mentionedPlatforms(text, platforms);
}

function labelsFromPatterns(text, patterns) {
  return patterns.filter((item) => item.pattern.test(text)).map((item) => item.label);
}

function positiveSignalsFromTags(signals) {
  const text = Array.isArray(signals) ? signals.join(' ') : '';
  const out = [];
  if (/\binstagram-active|facebook-active|social-active\b/i.test(text)) out.push('active social proof is visible');
  if (/\bwell-reviewed|high-rating|reviews\b/i.test(text)) out.push('reviews or testimonials are visible');
  if (/\bonline-booking|booking\b/i.test(text)) out.push('online booking or ordering path exists');
  return out;
}

function gapSignalsFromTags(signals) {
  const text = Array.isArray(signals) ? signals.join(' ') : '';
  const out = [];
  if (/\b(no-website|website-missing)\b/i.test(text)) out.push('no owned website found');
  if (/\b(outdated-site|old-site)\b/i.test(text)) out.push('website appears outdated');
  if (/\b(directory-only|listing-only)\b/i.test(text)) out.push('third-party listing only');
  return out;
}

function normalizeEvidence(evidence = {}) {
  const legacySocialProfiles = stringArray(evidence?.socialProfiles);
  const legacyListings = Array.isArray(evidence?.listings) ? stringArray(evidence.listings) : [];
  const legacyNotes = stringArray(evidence?.notes);
  return {
    website: {
      found: Boolean(evidence?.website?.found),
      url: normalizeUrl(evidence?.website?.url),
      evidence: unique([
        ...stringArray(evidence?.website?.evidence),
        typeof evidence?.website?.signal === 'string' ? evidence.website.signal : null
      ])
    },
    social: {
      found: Boolean(evidence?.social?.found || legacySocialProfiles.length),
      platforms: unique([...stringArray(evidence?.social?.platforms), ...legacySocialProfiles.map(platformFromLabel)]),
      urls: unique([
        ...stringArray(evidence?.social?.urls),
        ...legacySocialProfiles
      ].map(normalizeUrl).filter(Boolean)),
      evidence: stringArray(evidence?.social?.evidence)
    },
    listings: {
      found: Boolean(evidence?.listings?.found || legacyListings.length),
      platforms: unique([...stringArray(evidence?.listings?.platforms), ...legacyListings.map(platformFromLabel)]),
      urls: unique([
        ...stringArray(evidence?.listings?.urls),
        ...legacyListings
      ].map(normalizeUrl).filter(Boolean)),
      evidence: stringArray(evidence?.listings?.evidence)
    },
    gaps: unique([...stringArray(evidence?.gaps), ...legacyNotes.filter((note) => /gap|weak|missing|no |none|outdated|sparse|broken/i.test(note))]),
    positiveSignals: unique([...stringArray(evidence?.positiveSignals), ...legacyNotes.filter((note) => /strong|complete|booking|reviews|hours|services/i.test(note))])
  };
}

function websiteEvidence({ hasWebsite, websiteUrl, negativeWebsiteEvidence, profile }) {
  if (hasWebsite && websiteUrl) return [`Owned website URL found: ${websiteUrl}`];
  if (hasWebsite) return ['Research reported an owned website, but no URL was captured.'];
  if (negativeWebsiteEvidence) return ['Research explicitly says no business website was found.'];
  if (profile.hasWebsite === false) return ['Profile reports no owned website.'];
  return ['No owned website URL was found in the research.'];
}

function socialEvidence({ socialPlatforms, socialUrls }) {
  const out = [];
  if (socialPlatforms.length) out.push(`Social platforms mentioned: ${socialPlatforms.join(', ')}`);
  if (socialUrls.length) out.push(`Social URLs found: ${socialUrls.join(', ')}`);
  if (!out.length) out.push('No social profile evidence found.');
  return out;
}

function listingEvidence({ listingPlatforms, listingUrls }) {
  const out = [];
  if (listingPlatforms.length) out.push(`Listings mentioned: ${listingPlatforms.join(', ')}`);
  if (listingUrls.length) out.push(`Listing URLs found: ${listingUrls.join(', ')}`);
  if (!out.length) out.push('No third-party listing evidence found.');
  return out;
}

function inferStrength({ forceWeakPresence, requestedStrength, evidence }) {
  if (forceWeakPresence) return 'weak';
  const hasWebsite = evidence.website.found;
  const hasSocial = evidence.social.found;
  const hasListing = evidence.listings.found;
  const hasAnyPresence = hasWebsite || hasSocial || hasListing;
  if (!hasAnyPresence) return 'none';

  const majorGaps = evidence.gaps.filter((gap) => (
    gap.includes('outdated') ||
    gap.includes('sparse') ||
    gap.includes('broken') ||
    gap.includes('explicitly empty') ||
    gap.includes('no clear services')
  ));
  const completeOwnedWebsite = hasWebsite && evidence.positiveSignals.length >= 3 && majorGaps.length === 0;
  const credibleStrongClaim = requestedStrength === 'strong' && hasWebsite && evidence.positiveSignals.length >= 2 && majorGaps.length === 0;
  if (completeOwnedWebsite || credibleStrongClaim) return 'strong';
  if (hasWebsite) return majorGaps.length >= 2 ? 'weak' : 'mixed';
  if (hasSocial && hasListing) return requestedStrength === 'none' ? 'weak' : 'mixed';
  return 'weak';
}

function buildReasons({ strength, evidence }) {
  const reasons = [];
  if (evidence.website.found) {
    reasons.push(evidence.website.url ? `Owned website found at ${evidence.website.url}.` : 'Owned website reported, but the URL is missing.');
  } else {
    reasons.push('No owned website was found.');
  }
  if (evidence.social.found) reasons.push(`Social evidence found: ${labelList(evidence.social.platforms, 'social profile')}.`);
  if (evidence.listings.found) reasons.push(`Listing evidence found: ${labelList(evidence.listings.platforms, 'third-party listing')}.`);
  if (evidence.positiveSignals.length) reasons.push(`Positive customer-facing signals: ${evidence.positiveSignals.slice(0, 3).join('; ')}.`);
  if (evidence.gaps.length) reasons.push(`Presence gaps: ${evidence.gaps.slice(0, 3).join('; ')}.`);
  if (strength === 'strong') reasons.push('Strong owned presence means this lead should be blocked from cold outreach.');
  if (strength === 'none') reasons.push('No meaningful public online presence evidence was captured.');
  return unique(reasons);
}

function chooseSummary({ profile, requestedStrength, strength, evidence }) {
  if (profile.onlinePresenceSummary && requestedStrength === strength) return profile.onlinePresenceSummary;
  if (strength === 'strong') {
    return 'Strong owned online presence: customers can already find the business, understand the offer, and take action without a cold call.';
  }
  if (strength === 'mixed') {
    return evidence.website.found
      ? 'Mixed online presence: an owned website exists, but the research still shows gaps in clarity, proof, or conversion.'
      : 'Mixed online presence: third-party listings or social pages exist, but there is no clear owned website presence.';
  }
  if (strength === 'none') return 'No meaningful public online presence was found in the available research.';
  return 'Weak online presence: customers can find limited public traces, but the business lacks a clear owned site or complete customer-facing details.';
}

function confidenceScore({ profile, rawText, urls, evidence, requestedStrength }) {
  let score = 0.35;
  if (rawText.length > 800) score += 0.2;
  else if (rawText.length > 200) score += 0.12;
  if (profile.websiteUrl || evidence.website.url) score += 0.15;
  else if (typeof profile.hasWebsite === 'boolean') score += 0.08;
  if (evidence.listings.urls.length || evidence.listings.platforms.length) score += 0.1;
  if (evidence.social.urls.length || evidence.social.platforms.length) score += 0.08;
  if (urls.length > 1) score += 0.06;
  if (evidence.positiveSignals.length + evidence.gaps.length >= 2) score += 0.1;
  if (requestedStrength) score += 0.06;
  if (typeof profile.onlinePresenceConfidence === 'number') score = Math.max(score, profile.onlinePresenceConfidence);
  return round2(clamp(score, 0.2, 0.98));
}

function buildNotWorthCallingReason({ evidence, websiteUrl }) {
  const positives = evidence.positiveSignals.slice(0, 3);
  const proof = positives.length ? ` Evidence: ${positives.join('; ')}.` : '';
  const site = websiteUrl ? ` at ${websiteUrl}` : '';
  return `Not worth calling: strong owned online presence${site} already gives customers enough information and a clear path to act.${proof}`;
}

function buildCallRecommendation({ strength, onlinePresenceReasons, notWorthCallingReason }) {
  if (strength === 'strong') {
    return {
      shouldCall: false,
      notWorthCalling: true,
      whyCall: null,
      whyNotCall: notWorthCallingReason
    };
  }
  return {
    shouldCall: true,
    notWorthCalling: false,
    whyCall: onlinePresenceReasons[0] || 'Online presence is not strong enough to block outreach.',
    whyNotCall: null
  };
}

function labelList(items, fallback) {
  return items.length ? items.join(', ') : fallback;
}

function platformFromLabel(value) {
  const label = String(value || '').toLowerCase();
  const social = SOCIAL_PLATFORMS.find((p) => p.hosts.some((host) => label.includes(host)) || p.mention.test(label));
  if (social) return social.name;
  const listing = LISTING_PLATFORMS.find((p) => p.hosts.some((host) => label.includes(host)) || p.mention.test(label));
  if (listing) return listing.name;
  return value;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()) : [];
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
