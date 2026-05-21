import { createHash } from 'node:crypto';

const PRESENCE_WEAKNESS = Object.freeze({
  none: 96,
  weak: 86,
  mixed: 56,
  strong: 8
});

const EMPTY_RE = /^(n\/a|na|none|null|unknown|not listed|not found|no)$/i;

export function buildLeadIntelligence(input = {}, context = {}) {
  const raw = objectLike(input.raw);
  const profile = {
    ...objectLike(input.profile),
    ...objectLike(input)
  };
  delete profile.profile;
  delete profile.raw;

  const businessName = firstText(profile.businessName, raw.businessName, context.businessName, 'the business');
  const niche = firstText(profile.niche, raw.niche, context.niche, 'local services');
  const city = firstText(profile.city, raw.city, context.city, 'the local area');
  const capturedAt = firstText(context.capturedAt, raw.capturedAt, new Date().toISOString());
  const sourceType = firstText(context.sourceType, raw.sourceType, 'research');
  const sourceUrl = firstText(
    profile.sourceUrl,
    raw.sourceUrl,
    profile.yelpUrl,
    profile.websiteUrl,
    context.sourceUrl,
    syntheticSourceUrl({ city, niche, sourceType, businessName })
  );
  const websiteUrl = firstText(profile.websiteUrl, raw.websiteUrl, context.websiteUrl, null);
  const presence = normalizePresence(firstText(profile.onlinePresenceStrength, raw.onlinePresenceStrength, context.onlinePresenceStrength, 'weak'));
  const confidence = clamp01(profile.presenceConfidence ?? profile.onlinePresenceConfidence ?? raw.presenceConfidence ?? raw.onlinePresenceConfidence ?? 0.72);

  const evidence = [];
  const addEvidence = (entry) => {
    const normalized = normalizeEvidenceEntry(entry, {
      sourceUrl,
      sourceType,
      capturedAt,
      index: evidence.length
    });
    if (!normalized) return null;
    const existing = evidence.find((item) => item.id === normalized.id);
    if (existing) return existing;
    evidence.push(normalized);
    return normalized;
  };

  for (const row of asArray(profile.sourceEvidence).concat(asArray(raw.sourceEvidence), asArray(input.sourceEvidence))) {
    addEvidence({
      id: row.id || row.sourceId,
      sourceId: row.sourceId || row.id,
      sourceType: row.sourceType || sourceType,
      source: row.source || row.sourceLabel || row.sourceType || sourceType,
      sourceUrl: row.sourceUrl || sourceUrl,
      category: row.category || row.field || 'source',
      field: row.field || row.category || 'profile',
      value: row.value,
      claim: row.claim || row.evidenceText || row.summary || row.quote,
      quote: row.quote || row.evidenceText || row.summary || row.claim,
      confidence: row.confidence,
      capturedAt: row.capturedAt || capturedAt
    });
  }

  for (const review of asArray(profile.reviews).concat(asArray(raw.reviews), asArray(input.reviews))) {
    addEvidence({
      id: review.id || review.sourceId,
      sourceId: review.sourceId || review.id,
      sourceType: 'reviews',
      source: review.source || review.platform || 'review source',
      sourceUrl: review.sourceUrl || review.url || sourceUrl,
      category: 'review',
      field: 'reviews',
      value: review.rating != null ? `${review.rating} stars${review.count != null ? ` over ${review.count} reviews` : ''}` : null,
      claim: review.summary || review.text || 'Review evidence captured.',
      quote: review.quote || review.summary || review.text,
      confidence: review.confidence ?? confidence,
      capturedAt
    });
  }

  addPresenceEvidence(evidence, addEvidence, profile, {
    sourceUrl,
    sourceType,
    capturedAt,
    businessName,
    confidence
  });

  if (!evidence.length) {
    addEvidence({
      sourceType,
      source: sourceType,
      sourceUrl,
      category: 'profile',
      field: 'businessName',
      value: businessName,
      claim: `Research identified ${businessName}.`,
      quote: profile.onlinePresenceSummary || raw.leadRecommendation || `Research identified ${businessName}.`,
      confidence,
      capturedAt
    });
  }

  const primaryEvidence = ids(evidence.slice(0, 3));
  const reviewThemes = normalizeClaimList(profile.reviewThemes || raw.reviewThemes, 'review-theme', evidence, () => inferReviewThemes(evidence, { businessName }));
  const positiveProof = normalizeClaimList(profile.positiveProof || raw.positiveProof, 'positive-proof', evidence, () => inferPositiveProof(evidence, profile));
  const complaintsPainPoints = normalizeClaimList(
    profile.complaintsPainPoints || profile.complaints || raw.complaintsPainPoints || raw.complaints,
    'complaint',
    evidence,
    () => inferComplaintsPainPoints(evidence, profile)
  );
  const missingCustomerInfo = normalizeClaimList(
    profile.missingCustomerInfo || raw.missingCustomerInfo,
    'missing-info',
    evidence,
    () => inferMissingCustomerInfo(evidence, profile)
  );
  const competitorComparison = normalizeClaimList(
    profile.competitorComparison || raw.competitorComparison,
    'competitor-gap',
    evidence,
    () => inferCompetitorComparison(evidence, { businessName, niche, city, sourceUrl, websiteUrl, presence })
  );
  const currentWebsiteIssues = normalizeClaimList(
    profile.currentWebsiteIssues || raw.currentWebsiteIssues,
    'website-issue',
    evidence,
    () => inferWebsiteIssues(evidence, { websiteUrl, presence, profile })
  );
  const socialListingConsistency = normalizeClaimList(
    profile.socialListingConsistency || raw.socialListingConsistency,
    'listing-consistency',
    evidence,
    () => inferListingConsistency(evidence, profile)
  );
  const contactConfidence = contactConfidenceFromEvidence({ evidence, profile, raw, confidence });
  const scores = buildScores({
    presence,
    confidence,
    hasWebsite: Boolean(websiteUrl || profile.hasWebsite),
    phone: profile.phone || raw.phone,
    evidence,
    missingCustomerInfo,
    currentWebsiteIssues,
    positiveProof,
    niche
  });
  const bestCtaRecommendation = normalizeSingleClaim(
    profile.bestCtaRecommendation || raw.bestCtaRecommendation,
    'best-cta',
    evidence,
    () => inferBestCta({ profile, raw, niche, evidence, contactConfidence })
  );
  const doNotCallBecauseAlreadyStrong = {
    skip: presence === 'strong',
    reason: presence === 'strong'
      ? firstText(profile.notWorthCallingReason, raw.notWorthCallingReason, 'Already has strong website/review/contact proof; do not spend a cold call here.')
      : null,
    evidenceIds: presence === 'strong' ? ids(bestEvidence(evidence, ['website', 'positive', 'reviews'], 4)) : [],
    sourceIds: sourceIdsFor(evidence, presence === 'strong' ? ids(bestEvidence(evidence, ['website', 'positive', 'reviews'], 4)) : [])
  };
  const whyThisLeadIsWorthCalling = normalizeSingleClaim(
    profile.whyThisLeadIsWorthCalling || raw.whyThisLeadIsWorthCalling,
    'why-call',
    evidence,
    () => inferWhyCall({
      businessName,
      presence,
      missingCustomerInfo,
      currentWebsiteIssues,
      positiveProof,
      doNotCallBecauseAlreadyStrong
    })
  );
  const callOpener = firstText(
    profile.callOpener,
    raw.callOpener,
    exactCallOpener({ businessName, presence, sourceUrl, reviewThemes, missingCustomerInfo, currentWebsiteIssues, positiveProof })
  );

  return {
    schemaVersion: 'lead_intelligence.v1',
    generatedAt: capturedAt,
    businessName,
    niche,
    city,
    sourceTrail: sourceTrail(evidence, sourceUrl),
    evidence,
    reviewThemes,
    positiveProof,
    complaintsPainPoints,
    missingCustomerInfo,
    competitorComparison,
    currentWebsiteIssues,
    socialListingConsistency,
    contactConfidence,
    bestCtaRecommendation,
    whyThisLeadIsWorthCalling,
    doNotCallBecauseAlreadyStrong,
    scores,
    callOpener: {
      text: callOpener,
      evidenceIds: ids(bestEvidence(evidence, ['review', 'website', 'gap', 'listing', 'phone'], 4)).length
        ? ids(bestEvidence(evidence, ['review', 'website', 'gap', 'listing', 'phone'], 4))
        : primaryEvidence,
      sourceIds: sourceIdsFor(evidence, ids(bestEvidence(evidence, ['review', 'website', 'gap', 'listing', 'phone'], 4)).length
        ? ids(bestEvidence(evidence, ['review', 'website', 'gap', 'listing', 'phone'], 4))
        : primaryEvidence)
    },
    audit: {
      everyClaimCitesEvidence: true,
      mockEvidence: evidence.some((item) => /demo\.callmemaybe\.local|example\.(test|com)/i.test(item.sourceUrl || '')),
      sourceUrlPreserved: Boolean(sourceUrl)
    }
  };
}

export function compactLeadIntelligence(intelligence = {}, { evidenceLimit = 8 } = {}) {
  if (!intelligence || typeof intelligence !== 'object') return null;
  return {
    schemaVersion: intelligence.schemaVersion || 'lead_intelligence.v1',
    sourceTrail: asArray(intelligence.sourceTrail).slice(0, 6),
    callOpener: intelligence.callOpener || null,
    reviewThemes: asArray(intelligence.reviewThemes).slice(0, 5),
    positiveProof: asArray(intelligence.positiveProof).slice(0, 5),
    complaintsPainPoints: asArray(intelligence.complaintsPainPoints).slice(0, 5),
    missingCustomerInfo: asArray(intelligence.missingCustomerInfo).slice(0, 6),
    competitorComparison: asArray(intelligence.competitorComparison).slice(0, 5),
    currentWebsiteIssues: asArray(intelligence.currentWebsiteIssues).slice(0, 6),
    socialListingConsistency: asArray(intelligence.socialListingConsistency).slice(0, 5),
    contactConfidence: intelligence.contactConfidence || null,
    bestCtaRecommendation: intelligence.bestCtaRecommendation || null,
    whyThisLeadIsWorthCalling: intelligence.whyThisLeadIsWorthCalling || null,
    doNotCallBecauseAlreadyStrong: intelligence.doNotCallBecauseAlreadyStrong || null,
    scores: intelligence.scores || null,
    evidence: asArray(intelligence.evidence).slice(0, evidenceLimit)
  };
}

export function evidenceTraceText(intelligence = {}, { limit = 5 } = {}) {
  const evidence = asArray(intelligence.evidence).slice(0, limit);
  return evidence.map((item) => {
    const source = item.sourceUrl || item.source || item.sourceId || item.id;
    return `${item.id}: ${item.claim || item.quote} (${source})`;
  }).join(' | ');
}

function addPresenceEvidence(evidence, addEvidence, profile, defaults) {
  const presenceEvidence = objectLike(profile.onlinePresenceEvidence);
  const website = objectLike(presenceEvidence.website);
  const social = objectLike(presenceEvidence.social);
  const listings = objectLike(presenceEvidence.listings);
  for (const text of asArray(website.evidence)) {
    addEvidence({
      ...defaults,
      sourceType: 'website',
      source: 'website audit',
      sourceUrl: website.url || profile.websiteUrl || defaults.sourceUrl,
      category: 'current_website_issues',
      field: 'website',
      value: website.url || profile.websiteUrl || null,
      claim: text,
      quote: text
    });
  }
  for (const text of asArray(social.evidence)) {
    addEvidence({
      ...defaults,
      sourceType: 'social',
      source: 'social audit',
      sourceUrl: asArray(social.urls)[0] || defaults.sourceUrl,
      category: 'social_listing_consistency',
      field: 'social',
      value: asArray(social.platforms).join(', ') || null,
      claim: text,
      quote: text
    });
  }
  for (const text of asArray(listings.evidence)) {
    addEvidence({
      ...defaults,
      sourceType: 'directory',
      source: 'listing audit',
      sourceUrl: asArray(listings.urls)[0] || defaults.sourceUrl,
      category: 'social_listing_consistency',
      field: 'listing',
      value: asArray(listings.platforms).join(', ') || null,
      claim: text,
      quote: text
    });
  }
  for (const gap of asArray(presenceEvidence.gaps)) {
    addEvidence({
      ...defaults,
      source: 'presence scoring',
      category: 'missing_customer_info',
      field: 'gap',
      claim: gap,
      quote: gap
    });
  }
  for (const signal of asArray(presenceEvidence.positiveSignals)) {
    addEvidence({
      ...defaults,
      source: 'presence scoring',
      category: 'positive_proof',
      field: 'positiveSignal',
      claim: signal,
      quote: signal
    });
  }
}

function normalizeEvidenceEntry(entry, defaults) {
  const sourceUrl = cleanText(entry.sourceUrl) || defaults.sourceUrl;
  const claim = cleanText(entry.claim || entry.evidenceText || entry.summary || entry.quote || entry.value);
  const quote = cleanText(entry.quote || entry.evidenceText || entry.summary || claim);
  if (!claim && !quote) return null;
  const sourceType = cleanText(entry.sourceType) || defaults.sourceType || 'research';
  const field = cleanText(entry.field) || cleanText(entry.category) || 'profile';
  const id = safeId(entry.id || entry.sourceId || `ev_${sourceType}_${field}_${hash(`${sourceUrl}:${field}:${claim}:${defaults.index}`)}`);
  return {
    id,
    sourceId: safeId(entry.sourceId || id),
    sourceType,
    source: cleanText(entry.source) || sourceType,
    sourceUrl,
    category: safeCode(entry.category || field),
    field,
    value: cleanText(entry.value),
    claim: claim || quote,
    quote: quote || claim,
    confidence: clamp01(entry.confidence ?? 0.7),
    capturedAt: cleanText(entry.capturedAt) || defaults.capturedAt
  };
}

function normalizeClaimList(value, prefix, evidence, fallbackFn) {
  const raw = asArray(value);
  const list = raw.length ? raw : fallbackFn();
  return list.slice(0, 8).map((item, index) => normalizeClaim(item, prefix, index, evidence)).filter(Boolean);
}

function normalizeSingleClaim(value, prefix, evidence, fallbackFn) {
  const raw = value && typeof value === 'object' ? value : null;
  return normalizeClaim(raw || fallbackFn(), prefix, 0, evidence);
}

function normalizeClaim(item, prefix, index, evidence) {
  const obj = typeof item === 'string' ? { claim: item } : objectLike(item);
  const text = firstText(obj.claim, obj.summary, obj.finding, obj.gap, obj.reason, obj.theme, obj.title, obj.cta, obj.text, null);
  if (!text) return null;
  const preferred = evidenceByIds(evidence, asArray(obj.evidenceIds));
  const fallback = preferred.length ? preferred : bestEvidence(evidence, keywordsForClaim(text), 3);
  const evidenceIds = ids(fallback);
  if (!evidenceIds.length) return null;
  return {
    id: safeId(obj.id || `${prefix}-${index + 1}`),
    title: firstText(obj.title, obj.theme, obj.cta, text),
    claim: text,
    summary: firstText(obj.summary, obj.finding, obj.gap, obj.reason, text),
    sentiment: obj.sentiment || sentimentFor(text),
    priority: ['high', 'medium', 'low'].includes(obj.priority) ? obj.priority : priorityFor(text),
    evidenceIds,
    sourceIds: sourceIdsFor(evidence, evidenceIds),
    sourceUrls: sourceUrlsFor(evidence, evidenceIds),
    confidence: clamp01(obj.confidence ?? averageConfidence(fallback))
  };
}

function inferReviewThemes(evidence, { businessName }) {
  const reviews = evidence.filter((item) => item.category === 'review' || /review|rating|stars?/i.test(`${item.field} ${item.claim}`));
  if (reviews.length) {
    return reviews.slice(0, 4).map((item, index) => ({
      id: `review-theme-${index + 1}`,
      theme: themeFromText(item.claim),
      summary: item.claim,
      sentiment: sentimentFor(item.claim),
      evidenceIds: [item.id]
    }));
  }
  return [{
    id: 'review-theme-1',
    theme: 'review proof is thin',
    summary: `${businessName} has no detailed review themes captured yet; the call should ask what customers usually praise or question.`,
    sentiment: 'mixed',
    evidenceIds: ids(bestEvidence(evidence, ['review', 'listing'], 2))
  }];
}

function inferPositiveProof(evidence, profile) {
  const rows = bestEvidence(evidence, ['positive', 'review', 'phone', 'address', 'hours', 'services'], 5);
  return rows.map((item, index) => ({
    id: `positive-proof-${index + 1}`,
    claim: item.claim,
    summary: item.claim,
    evidenceIds: [item.id]
  })).concat(profile.phone ? [{
    id: 'positive-proof-phone',
    claim: 'Public phone number is available for a direct call CTA.',
    evidenceIds: ids(bestEvidence(evidence, ['phone'], 1))
  }] : []).slice(0, 6);
}

function inferComplaintsPainPoints(evidence, profile) {
  const complaintRows = evidence.filter((item) => /complain|slow|wait|hard|unclear|confus|missing|outdated|broken|sparse|thin|no owned|not found/i.test(item.claim));
  const rows = complaintRows.length ? complaintRows : bestEvidence(evidence, ['gap', 'website', 'missing'], 3);
  return rows.map((item, index) => ({
    id: `complaint-${index + 1}`,
    claim: item.claim,
    summary: item.claim,
    evidenceIds: [item.id]
  })).concat(!profile.websiteUrl && !profile.hasWebsite ? [{
    id: 'complaint-no-site',
    claim: 'A customer who wants details beyond the listing has no owned website to inspect.',
    evidenceIds: ids(bestEvidence(evidence, ['website', 'listing', 'gap'], 2))
  }] : []).slice(0, 6);
}

function inferMissingCustomerInfo(evidence, profile) {
  const out = [];
  if (!profile.websiteUrl && !profile.hasWebsite) out.push('No owned website was confirmed from the source trail.');
  if (!profile.hours || /unknown|not found/i.test(profile.hours)) out.push('Reliable hours were not confirmed.');
  if (!asArray(profile.services).length) out.push('Services/menu details are sparse.');
  if (!JSON.stringify([profile.signals, profile.onlinePresenceSummary]).match(/book|schedule|appointment|quote|order|reservation/i)) {
    out.push('No clear booking, quote, order, or contact conversion path was proven.');
  }
  if (!out.length) out.push('The existing online presence still needs clearer services, proof, and next-step copy.');
  const refs = ids(bestEvidence(evidence, ['website', 'hours', 'services', 'gap', 'listing'], 3));
  return out.map((claim, index) => ({ id: `missing-info-${index + 1}`, claim, evidenceIds: refs }));
}

function inferCompetitorComparison(evidence, { businessName, niche, city, sourceUrl, websiteUrl, presence }) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(`${niche} ${city} online booking reviews website`)}`;
  const refs = ids(bestEvidence(evidence, ['website', 'gap', 'listing', 'review'], 3));
  const claim = presence === 'strong'
    ? `${businessName} already has the kind of online proof weaker competitors lack.`
    : `${businessName} is easier to beat online than competitors with owned pages that show services, proof, hours, and a single CTA.`;
  return [{
    id: 'competitor-gap-owned-surface',
    claim,
    summary: claim,
    sourceUrl: websiteUrl || sourceUrl || searchUrl,
    comparisonSourceUrl: searchUrl,
    evidenceIds: refs
  }];
}

function inferWebsiteIssues(evidence, { websiteUrl, presence, profile }) {
  const refs = ids(bestEvidence(evidence, ['website', 'gap', 'services', 'booking', 'contact'], 4));
  if (!websiteUrl && !profile.hasWebsite) {
    return [{ id: 'website-issue-no-owned-site', claim: 'No owned website was confirmed; customers are pushed to listings or social fragments.', evidenceIds: refs }];
  }
  if (presence === 'strong') {
    return [{ id: 'website-issue-none-strong', claim: 'Current website appears strong enough that outbound website replacement is low value.', evidenceIds: refs }];
  }
  return [{ id: 'website-issue-thin-conversion', claim: 'Current website or web presence does not prove a clean conversion path for services, proof, and contact.', evidenceIds: refs }];
}

function inferListingConsistency(evidence, profile) {
  const refs = ids(bestEvidence(evidence, ['phone', 'address', 'hours', 'listing', 'social'], 4));
  const findings = [];
  findings.push(profile.phone ? 'Phone evidence is present.' : 'Phone evidence is missing or untrusted.');
  findings.push(profile.address ? 'Address evidence is present.' : 'Address evidence is missing or untrusted.');
  findings.push(profile.hours && !/unknown|not found/i.test(profile.hours) ? 'Hours evidence is present.' : 'Hours were not confidently confirmed.');
  return findings.map((claim, index) => ({ id: `listing-consistency-${index + 1}`, claim, evidenceIds: refs }));
}

function contactConfidenceFromEvidence({ evidence, profile, raw, confidence }) {
  return {
    hours: contactFieldConfidence('hours', firstText(profile.hours, raw.hours, null), evidence, confidence),
    address: contactFieldConfidence('address', firstText(profile.address, raw.address, null), evidence, confidence),
    phone: contactFieldConfidence('phone', firstText(profile.phone, raw.phone, null), evidence, confidence)
  };
}

function contactFieldConfidence(field, value, evidence, fallbackConfidence) {
  const rows = bestEvidence(evidence, [field], 3);
  return {
    value,
    confidence: value ? clamp01(Math.max(fallbackConfidence, averageConfidence(rows))) : 0.2,
    evidenceIds: ids(rows),
    sourceIds: sourceIdsFor(evidence, ids(rows)),
    note: value ? `${field} has public evidence.` : `${field} is not confidently proven.`
  };
}

function buildScores({ presence, confidence, hasWebsite, phone, evidence, missingCustomerInfo, currentWebsiteIssues, positiveProof, niche }) {
  const weakness = clampScore((PRESENCE_WEAKNESS[presence] ?? 70) + (hasWebsite ? -8 : 8));
  const urgency = clampScore(45 + missingCustomerInfo.length * 10 + currentWebsiteIssues.length * 8 + (presence === 'weak' || presence === 'none' ? 12 : 0));
  const websiteValue = clampScore(hasWebsite ? (presence === 'strong' ? 15 : 62) : 92);
  const contactability = clampScore((phone ? 72 : 28) + Math.round(confidence * 15));
  const verticalFit = clampScore(/barber|salon|spa|restaurant|cafe|plumb|hvac|electric|repair|dental|clinic|law|tax|account|contractor|landscap/i.test(niche) ? 84 : 66);
  const refs = ids(bestEvidence(evidence, ['website', 'phone', 'positive', 'gap'], 4));
  return {
    presenceWeakness: { score: weakness, reason: `${presence} online presence means ${weakness >= 70 ? 'high' : weakness >= 40 ? 'medium' : 'low'} website-sales fit.`, evidenceIds: refs },
    urgency: { score: urgency, reason: 'Urgency rises with missing customer info and visible website issues.', evidenceIds: idsForClaims(missingCustomerInfo, currentWebsiteIssues, refs) },
    websiteValue: { score: websiteValue, reason: hasWebsite ? 'Website value depends on fixing the current conversion gaps.' : 'No owned website makes a simple site immediately valuable.', evidenceIds: refs },
    contactability: { score: contactability, reason: phone ? 'Public phone evidence supports calling.' : 'No trusted phone lowers contactability.', evidenceIds: ids(bestEvidence(evidence, ['phone'], 2)) },
    verticalFit: { score: verticalFit, reason: `${niche} usually benefits from fast local proof, hours, services, and tap-to-call.`, evidenceIds: refs },
    totalScore: Math.round((weakness * 0.26) + (urgency * 0.22) + (websiteValue * 0.24) + (contactability * 0.14) + (verticalFit * 0.14))
  };
}

function inferBestCta({ profile, raw, niche, evidence, contactConfidence }) {
  const phone = firstText(profile.phone, raw.phone, null);
  const service = asArray(profile.services)[0] || `${niche} help`;
  const cta = phone ? `Call ${phone} for ${service}` : `Request ${service} details`;
  return {
    id: 'best-cta-primary',
    title: cta,
    cta,
    claim: cta,
    summary: cta,
    reason: phone ? 'Phone is the clearest proven conversion path.' : 'Use a request/details CTA until a phone is confirmed.',
    evidenceIds: phone ? contactConfidence.phone.evidenceIds : ids(bestEvidence(evidence, ['services', 'website', 'gap'], 3))
  };
}

function inferWhyCall({ businessName, presence, missingCustomerInfo, currentWebsiteIssues, positiveProof, doNotCallBecauseAlreadyStrong }) {
  if (doNotCallBecauseAlreadyStrong.skip) {
    return {
      id: 'why-call-skip-strong',
      claim: `${businessName} should be skipped because the online presence is already strong.`,
      evidenceIds: doNotCallBecauseAlreadyStrong.evidenceIds
    };
  }
  const missing = sentenceFragment(missingCustomerInfo[0]?.summary || missingCustomerInfo[0]?.claim || 'key customer info is missing');
  const issue = sentenceFragment(currentWebsiteIssues[0]?.summary || currentWebsiteIssues[0]?.claim || 'the online path is thin');
  const proof = sentenceFragment(positiveProof[0]?.summary || positiveProof[0]?.claim || 'the business appears real and reachable');
  const need = combineNeedAndIssue(missing, issue);
  return {
    id: 'why-call-earned',
    claim: `${businessName} is worth calling because ${proof}, but ${need}.`,
    evidenceIds: unique([
      ...asArray(positiveProof[0]?.evidenceIds),
      ...asArray(missingCustomerInfo[0]?.evidenceIds),
      ...asArray(currentWebsiteIssues[0]?.evidenceIds)
    ])
  };
}

function exactCallOpener({ businessName, presence, sourceUrl, reviewThemes, missingCustomerInfo, currentWebsiteIssues, positiveProof }) {
  if (presence === 'strong') {
    const proof = positiveProof[0]?.summary || positiveProof[0]?.claim || 'your site already shows strong proof';
    return `I looked at ${businessName} and saw ${lowerFirst(proof)}; this probably is not a fit for a website cold call.`;
  }
  const review = reviewThemes[0]?.summary || reviewThemes[0]?.claim || positiveProof[0]?.summary || positiveProof[0]?.claim;
  const missing = missingCustomerInfo[0]?.summary || missingCustomerInfo[0]?.claim || currentWebsiteIssues[0]?.summary || currentWebsiteIssues[0]?.claim;
  const sourcePhrase = sourceUrl ? 'your public listing' : 'your public profile';
  if (review && missing) {
    return negativeFinding(missing)
      ? `I was looking at ${sourcePhrase} for ${businessName}; I saw ${sentenceFragment(review)}, but ${sentenceFragment(missing)}.`
      : `I was looking at ${sourcePhrase} for ${businessName}; I saw ${sentenceFragment(review)}, but I could not find ${sentenceFragment(missing)}.`;
  }
  if (missing) {
    return negativeFinding(missing)
      ? `I was looking at ${sourcePhrase} for ${businessName}, and ${sentenceFragment(missing)}.`
      : `I was looking at ${sourcePhrase} for ${businessName}, and I could not find ${sentenceFragment(missing)}.`;
  }
  return `I was looking at ${businessName} and had one specific website question.`;
}

function sourceTrail(evidence, fallbackSourceUrl) {
  const seen = new Set();
  return evidence.map((item) => ({
    id: item.sourceId,
    type: item.sourceType,
    label: item.source,
    url: item.sourceUrl || fallbackSourceUrl,
    evidenceIds: [item.id]
  })).filter((item) => {
    const key = `${item.type}:${item.url}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);
}

function bestEvidence(evidence, keywords, limit = 3) {
  const terms = keywords.map((term) => String(term).toLowerCase());
  const scored = evidence.map((item) => {
    const haystack = `${item.id} ${item.sourceType} ${item.category} ${item.field} ${item.claim} ${item.quote}`.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    return { item, score };
  }).sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence);
  const preferred = scored.filter((row) => row.score > 0).map((row) => row.item);
  return (preferred.length ? preferred : evidence).slice(0, limit);
}

function evidenceByIds(evidence, evidenceIds) {
  const idsSet = new Set(evidenceIds);
  return evidence.filter((item) => idsSet.has(item.id));
}

function ids(rows) {
  return unique(asArray(rows).map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean));
}

function idsForClaims(a, b, fallback) {
  const out = unique([
    ...asArray(a).flatMap((item) => asArray(item.evidenceIds)),
    ...asArray(b).flatMap((item) => asArray(item.evidenceIds))
  ]);
  return out.length ? out.slice(0, 6) : fallback;
}

function sourceIdsFor(evidence, evidenceIds) {
  const idsSet = new Set(evidenceIds);
  return unique(evidence.filter((item) => idsSet.has(item.id)).map((item) => item.sourceId || item.id));
}

function sourceUrlsFor(evidence, evidenceIds) {
  const idsSet = new Set(evidenceIds);
  return unique(evidence.filter((item) => idsSet.has(item.id)).map((item) => item.sourceUrl).filter(Boolean));
}

function keywordsForClaim(text) {
  const lower = String(text || '').toLowerCase();
  const terms = [];
  if (/review|rating|star|customer/.test(lower)) terms.push('review');
  if (/website|site|owned|booking|cta|contact/.test(lower)) terms.push('website', 'gap');
  if (/hour/.test(lower)) terms.push('hours');
  if (/phone|call/.test(lower)) terms.push('phone');
  if (/address|location/.test(lower)) terms.push('address');
  if (/social|instagram|facebook|listing|directory/.test(lower)) terms.push('social', 'listing');
  return terms.length ? terms : ['profile'];
}

function themeFromText(text) {
  const clean = cleanText(text) || 'review theme';
  if (/friendly|kind|helpful|staff/i.test(clean)) return 'friendly service';
  if (/fast|quick|same.?day|responsive/i.test(clean)) return 'fast response';
  if (/quality|great|excellent|reliable/i.test(clean)) return 'quality proof';
  if (/price|value|affordable/i.test(clean)) return 'value perception';
  if (/unclear|missing|sparse|thin/i.test(clean)) return 'thin public detail';
  return clean.split(/[.;]/)[0].slice(0, 80);
}

function priorityFor(text) {
  if (/no owned|missing|broken|strong|not worth|phone|website/i.test(text)) return 'high';
  if (/hours|reviews|booking|contact/i.test(text)) return 'medium';
  return 'low';
}

function sentimentFor(text) {
  if (/complain|bad|poor|slow|broken|missing|unclear|sparse|thin|no owned|not found/i.test(text)) return 'negative';
  if (/great|excellent|friendly|positive|strong|visible|confirmed|available|helpful/i.test(text)) return 'positive';
  return 'mixed';
}

function normalizePresence(value) {
  return ['none', 'weak', 'mixed', 'strong'].includes(value) ? value : 'weak';
}

function averageConfidence(rows) {
  const values = asArray(rows).map((item) => Number(item.confidence)).filter(Number.isFinite);
  if (!values.length) return 0.7;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function safeId(value) {
  return safeCode(value || 'item') || 'item';
}

function safeCode(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function syntheticSourceUrl({ city, niche, sourceType, businessName }) {
  return `https://demo.callmemaybe.local/research/${safeCode(city)}/${safeCode(niche)}/${safeCode(sourceType)}/${safeCode(businessName)}`;
}

function hash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return null;
}

function cleanText(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return null;
  }
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || EMPTY_RE.test(trimmed)) return null;
  return trimmed.slice(0, 1000);
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item != null);
  return [value];
}

function objectLike(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unique(values) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n));
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function lowerFirst(text) {
  const clean = cleanText(text) || '';
  return clean ? clean.charAt(0).toLowerCase() + clean.slice(1) : clean;
}

function sentenceFragment(text) {
  return lowerFirst(String(cleanText(text) || '').replace(/[.!?]+$/g, ''));
}

function combineNeedAndIssue(missing, issue) {
  const main = sentenceFragment(missing || 'key customer info is missing');
  const secondary = sentenceFragment(issue || 'the online path is thin');
  if (!secondary || sameResearchFinding(main, secondary)) return main;

  const secondaryParts = secondary
    .split(/\s*;\s*/)
    .map(sentenceFragment)
    .filter(Boolean);
  if (secondaryParts.length > 1) {
    const extraParts = secondaryParts.filter((part) => !sameResearchFinding(main, part));
    if (extraParts.length) return `${main} and ${extraParts.join(' and ')}`;
    return main;
  }
  return `${main} and ${secondary}`;
}

function sameResearchFinding(a, b) {
  const left = safeCode(a);
  const right = safeCode(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  const bothNoOwnedWebsite = left.includes('no-owned-website') && right.includes('no-owned-website');
  const bothWebsiteNotFound = /website/.test(left) && /website/.test(right) && /(not-found|no|without|missing|unconfirmed)/.test(left) && /(not-found|no|without|missing|unconfirmed)/.test(right);
  return bothNoOwnedWebsite || bothWebsiteNotFound;
}

function negativeFinding(text) {
  return /^(no|not|without|missing|unclear|reliable|services\/menu|the existing)/i.test(cleanText(text) || '');
}
