import { pickPack } from '../../verticalPacks/index.js';
import { buildReferralFooterText } from '../../referrals.js';
import { commercePlans } from '../../db.js';
import { compactLeadIntelligence, evidenceTraceText } from '../../research/leadIntelligence.js';

const REQUIRED_FIELDS = [
  'schemaVersion',
  'businessName',
  'phone',
  'locationOrServiceArea',
  'pages',
  'sections',
  'hero',
  'services',
  'serviceCards',
  'reviewProof',
  'location',
  'cta',
  'contactMethods',
  'commerceNeeds',
  'assets',
  'disclaimers',
  'customerNeed',
  'styleDirection',
  'prohibitedClaims'
];

const UNSUPPORTED_PATTERNS = [
  {
    code: 'unsupported_booking_claim',
    pattern: /\b(book|booking|appointment|schedule|reservation)s?\b/i,
    label: 'online booking or scheduling integration'
  },
  { code: 'unsupported_payment_claim', pattern: /\b(pay|payment|checkout|deposit|invoice|financing|subscription)s?\b/i, label: 'payment or checkout' }
];

const CLAIMY_PUBLIC_TEXT_RE = /\b(5[- ]?star|five[- ]?star|award[- ]winning|best rated|top rated|guarantee|guaranteed|licensed|insured|bonded|same[- ]day|24\/7|24-7|emergency)\b/i;
const INTERNAL_PUBLIC_TEXT_RE = /\b(source:|presence:|memory_write|lead intelligence|evidence\/source|customer supplied|use it as context|existing website|current website|no owned|weak owned|owned service page|tap-to-call mobile cta|conversion path|call should ask|not captured yet|agentmail|stripe)\b|https?:\/\//i;

const HALLUCINATION_GUARDS = [
  'Do not claim online booking, booking integrations, online payments, checkout, deposits, financing, guarantees, licenses, insurance, awards, reviews, staff names, pricing, same-day service, emergency availability, or years in business unless explicitly confirmed.',
  'Do not invent testimonials, badges, certifications, affiliations, legal/compliance claims, before-and-after results, or customer counts.',
  'If a fact is missing, omit it rather than filling the gap.'
];

export const WEBSITE_BRIEF_SCHEMA = {
  name: 'WebsiteBrief',
  schemaVersion: 2,
  required: REQUIRED_FIELDS,
  fields: {
    pages: 'Page specs with path, goal, and section keys.',
    sections: 'Executable page sections with key, name, goal, and required facts.',
    hero: 'Headline, subheadline, CTAs, proof line, and visual intent.',
    services: 'Plain service names used for provider compatibility and QA.',
    serviceCards: 'Display-ready service cards with description and proof constraints.',
    reviewProof: 'Evidence-backed trust proof, never invented testimonials.',
    location: 'Address, city, service area, hours, and area served.',
    contactMethods: 'Phone, email, form, and optional confirmed booking routes.',
    commerceNeeds: 'Invoice/payment state and explicit commerce boundaries.',
    assets: 'Customer assets or placeholders with required alt text.',
    disclaimers: 'Claims the generator must omit or qualify.'
  }
};

export function buildWebsiteBrief({ lead, profileDoc, postMortemDoc, latestPayment } = {}) {
  const profile = parseDocContent(profileDoc) || parseJson(lead?.research_json) || {};
  const postMortem = parseDocContent(postMortemDoc) || {};
  const niche = firstText(lead?.niche, profile?.niche, 'local services');
  const city = firstText(lead?.city, profile?.city, null);
  const address = firstText(lead?.address, profile?.address, null);
  const serviceArea = firstText(profile?.serviceArea, profile?.service_area, city, address, null);
  const phone = firstText(lead?.phone, profile?.phone, null);
  const email = firstText(profile?.bestContactEmail, profile?.email, profile?.contactEmail, latestPayment?.customer_email, null);
  const businessName = firstText(lead?.business_name, profile?.businessName, profile?.business_name, null);
  const serviceCandidates = pickServices({ lead, profile, niche });
  const services = serviceCandidates.map((item) => formatServiceDisplayName(safePublicCopy(item))).filter(Boolean).slice(0, 6);
  if (!services.length && niche) services.push(`${niche} services`);
  const needs = uniqueItems([
    ...listItems(profile?.needs, 5, []),
    ...listItems(postMortem?.customerQuestions, 3, []),
    firstText(profile?.onlinePresenceSummary, profile?.whatTheyDo, null)
  ], 6);
  const publicNeeds = needs.map((item) => safePublicCopy(item)).filter(Boolean);
  const customerNeed = publicNeeds.length
    ? publicNeeds.join('; ')
    : 'local customers need quick proof, a clear service menu, and an obvious way to contact the business';
  const style = pickStyle(niche);
  const leadIntelligence = compactLeadIntelligence(profile?.leadIntelligence, { evidenceLimit: 10 });
  const commercePlan = latestCommercePlanForLead(lead) || profile?.commercePlan || null;
  // Honor an explicit profile.cta override (used by call-derived briefs where the
  // CTA was decided on the call, e.g. "Order today" or "Call to book"). Falls
  // back to the phone-call default. The validator still scans the final string
  // for unsupported online booking/payment claims.
  const cta = firstText(
    commercePlan?.commerceCta?.label,
    leadIntelligence?.bestCtaRecommendation?.summary,
    leadIntelligence?.bestCtaRecommendation?.claim,
    profile?.cta,
    phone ? `Call ${phone} for service or a quote` : 'Call for service or a quote'
  );
  const confirmedCapabilities = {
    booking: Boolean(
      profile?.bookingUrl ||
      profile?.booking_url ||
      profile?.supportsBooking ||
      isPhoneBookingCta(firstText(profile?.desiredCta, profile?.cta, null))
    ),
    payments: Boolean(profile?.paymentUrl || profile?.payment_url || profile?.supportsOnlinePayments)
  };
  const pack = safePickPack(lead);
  const contactMethods = buildContactMethods({ phone, email, confirmedCapabilities });
  const commerceNeeds = buildCommerceNeeds({ latestPayment, confirmedCapabilities, commercePlan });
  const reviewProof = buildReviewProof({ profile, postMortem });
  const location = {
    city,
    address,
    serviceArea: serviceArea || city || address,
    areaServed: uniqueItems(listItems(profile?.areaServed, 8, []).concat(serviceArea || city || []), 8),
    hours: firstText(profile?.hours, null)
  };
  const serviceCards = services.slice(0, 6).map((service) => ({
    name: service,
    description: serviceDescription({ service, area: location.serviceArea || 'the local area' }),
    proofNeeded: 'Use only confirmed service details; avoid pricing, guarantees, and availability claims unless supplied.'
  }));
  const hero = {
    headline: businessName || 'Local service business',
    subheadline: composeHeroSubheadline({ profile, niche, services, area: location.serviceArea || serviceArea || city, customerNeed }),
    primaryCta: cta,
    secondaryCta: email ? `Email ${email}` : 'Use the contact form',
    proofLine: safePublicCopy(leadIntelligence?.reviewThemes?.[0]?.summary) ||
      reviewProof.items[0] ||
      publicProofLine({ location, phone, email })
  };
  const sections = [
    { key: 'hero', name: 'Hero', goal: 'Make the business, location, and primary contact path obvious above the fold.', requiredFacts: [businessName, phone, location.serviceArea].filter(Boolean) },
    { key: 'services', name: 'Services', goal: 'Show the core paid services with plain explanations.', requiredFacts: services.slice(0, 6) },
    { key: 'proof', name: 'Trust proof', goal: 'Use only verified proof and clearly omit unverified reviews, licenses, guarantees, and awards.', requiredFacts: reviewProof.items },
    { key: 'location', name: 'Location and service area', goal: 'Show address, hours, city, and service area when confirmed.', requiredFacts: [address, location.hours, location.serviceArea].filter(Boolean) },
    { key: 'contact', name: 'Contact', goal: 'Offer click-to-call, email or form fallback, and clear next step.', requiredFacts: contactMethods.map((item) => item.value) }
  ];
  const pages = [
    { name: 'Home', path: '/', goal: 'A polished single-page small-business site with anchored sections.', sections: sections.map((section) => section.key) },
    { name: 'Contact', path: '#contact', goal: 'A direct conversion target for calls, email, and form requests.', sections: ['contact', 'location'] }
  ];
  const assets = buildAssets({ businessName, niche, services, profile });
  const disclaimers = uniqueItems([
    'Do not invent reviews, awards, staff, guarantees, licenses, insurance, pricing, or years in business.',
    confirmedCapabilities.booking ? null : 'Do not claim online booking; use phone/email/form contact only.',
    confirmedCapabilities.payments ? null : 'Do not claim online checkout or payment collection; invoice/payment happens outside the site.',
    reviewProof.disclaimer
  ], 6);

  return {
    schemaVersion: 2,
    businessName,
    phone,
    locationOrServiceArea: serviceArea || city || address,
    pages,
    sections,
    hero,
    services,
    serviceCards,
    reviewProof,
    location,
    cta,
    ctaPlan: {
      primary: { label: cta, href: phone ? `tel:${phone}` : '#contact' },
      secondary: email ? { label: `Email ${email}`, href: `mailto:${email}` } : { label: 'Send a request', href: '#contact-form' }
    },
    contactMethods,
    commerceNeeds,
    assets,
    disclaimers,
    customerNeed,
    styleDirection: `${style.tone}; ${style.palette}; ${style.layout}`,
    prohibitedClaims: HALLUCINATION_GUARDS,
    confirmedCapabilities,
    commercePlan: commercePlan ? summarizeCommercePlanForBrief(commercePlan) : null,
    commerceSections: commercePlan?.siteComponents || [],
    commerceLaunchChecklist: commercePlan?.launchChecklist || [],
    verticalPack: pack ? {
      key: pack.key,
      name: pack.name,
      siteTemplateHint: pack.siteTemplateHint || null,
      customerPersonaHint: pack.customerPersonaHint || null
    } : null,
    sourceFacts: {
      niche,
      city,
      address,
      hours: firstText(profile?.hours, null),
      email,
      existingWebsite: firstText(profile?.websiteUrl, lead?.website, null),
      sourceUrl: firstText(profile?.sourceUrl, lead?.source_url, null),
      invoiceStatus: latestPayment?.status || null,
      invoiceAmountCents: latestPayment?.amount_cents || null,
      customerPersona: firstText(profile?.customerPersona, postMortem?.customerCares, null),
      researchSummary: firstText(profile?.onlinePresenceSummary, profile?.summary, profile?.whatTheyDo, null),
      postCallSummary: firstText(postMortem?.reason, null),
      commerceSummary: commercePlan?.websiteBrief?.summary || null,
      leadIntelligence,
      evidenceTrace: leadIntelligence ? evidenceTraceText(leadIntelligence, { limit: 8 }) : null
    },
    evidenceTrace: leadIntelligence ? {
      reviewThemes: (leadIntelligence.reviewThemes || []).map(traceClaim).filter(Boolean),
      competitorComparison: (leadIntelligence.competitorComparison || []).map(traceClaim).filter(Boolean),
      currentWebsiteIssues: (leadIntelligence.currentWebsiteIssues || []).map(traceClaim).filter(Boolean),
      missingCustomerInfo: (leadIntelligence.missingCustomerInfo || []).map(traceClaim).filter(Boolean),
      bestCtaRecommendation: traceClaim(leadIntelligence.bestCtaRecommendation),
      callOpener: leadIntelligence.callOpener || null
    } : null,
    sourceQuality: {
      profileFound: Boolean(profile && Object.keys(profile).length),
      postMortemFound: Boolean(postMortem && Object.keys(postMortem).length),
      leadId: lead?.id || null
    }
  };
}

function latestCommercePlanForLead(lead) {
  if (!lead?.id) return null;
  try {
    return commercePlans.getLatest(lead.id)?.plan || null;
  } catch {
    return null;
  }
}

function summarizeCommercePlanForBrief(plan) {
  if (!plan) return null;
  return {
    schemaVersion: plan.schemaVersion,
    type: plan.type,
    status: plan.status,
    ctaLabel: plan.commerceCta?.label || null,
    ctaBehavior: plan.commerceCta?.behavior || null,
    paymentLinkUrl: null,
    noFakeCheckoutLinks: true,
    customerCopy: plan.customerCopy || null,
    stripeBoundary: {
      owner: plan.stripeBoundary?.owner || 'customer_business',
      callanRevenueSeparated: !!plan.stripeBoundary?.callanRevenueSeparated,
      requiresStripe: !!plan.stripeBoundary?.requiresStripe,
      mode: plan.stripeBoundary?.mode || null,
      liveCustomerCommerceEnabled: !!plan.stripeBoundary?.liveCustomerCommerceEnabled,
      liveGenerationPerformed: !!plan.stripeBoundary?.liveGenerationPerformed
    },
    humanHandoff: plan.humanHandoff || null,
    riskFlags: plan.riskFlags || [],
    summary: plan.websiteBrief?.summary || null
  };
}

function safePickPack(lead) {
  try {
    return pickPack(lead || {}) || null;
  } catch {
    return null;
  }
}

export function validateWebsiteBrief(brief = {}) {
  const errors = [];
  const blockers = [];

  for (const field of REQUIRED_FIELDS) {
    const value = brief[field];
    const missing = Array.isArray(value) ? value.length === 0 : !firstText(value, null);
    if (missing) {
      const error = {
        code: `missing_${snake(field)}`,
        field,
        message: `${field} is required before submitting a website build.`
      };
      errors.push(error);
      if (['businessName', 'phone', 'services'].includes(field)) blockers.push(error);
    }
  }

  const unsupported = unsupportedClaims(brief);
  for (const claim of unsupported) {
    const error = {
      code: claim.code,
      field: 'claims',
      message: `The brief implies unsupported ${claim.label}.`
    };
    errors.push(error);
    blockers.push(error);
  }

  return {
    ok: blockers.length === 0 && errors.length === 0,
    blocked: blockers.length > 0,
    errors,
    blockers,
    requiredFields: REQUIRED_FIELDS,
    checkedAt: Date.now()
  };
}

export function createLovableBuildPrompt(brief) {
  const services = (brief.services || []).slice(0, 6).join(', ');
  const facts = brief.sourceFacts || {};
  const pack = brief.verticalPack || null;
  const commerce = brief.commercePlan || null;
  const commerceSections = Array.isArray(brief.commerceSections) ? brief.commerceSections : [];
  const commerceChecklist = Array.isArray(brief.commerceLaunchChecklist) ? brief.commerceLaunchChecklist : [];
  const leadId = brief?.sourceQuality?.leadId || null;
  // Build the verbatim footer line up-front so the prompt can quote it
  // exactly. We only emit the instruction if we have a lead id to attribute
  // the click to — otherwise the link would 404 the rollup.
  let footerLine = null;
  try {
    if (leadId) footerLine = buildReferralFooterText(leadId);
  } catch {
    footerLine = null;
  }
  const prompt = [
    `Build a polished $500 small-business website for ${brief.businessName}.`,
    `Pages: ${(brief.pages || []).map((page) => `${page.name} (${page.path})`).join(', ') || 'Home, Contact anchors'}.`,
    `Hero: ${brief.hero?.headline || brief.businessName} — ${brief.hero?.subheadline || brief.customerNeed}.`,
    `Location/service area: ${brief.locationOrServiceArea}.`,
    `Phone/contact: ${brief.phone}.`,
    facts.email ? `Email/contact fallback: ${facts.email}.` : null,
    `Services to feature: ${services}.`,
    `Primary CTA: ${brief.cta}.`,
    `Contact methods: ${(brief.contactMethods || []).map((m) => `${m.type}:${m.value}`).join(', ') || 'phone and form'}.`,
    `Commerce/payment: ${(brief.commerceNeeds || []).map((m) => `${m.key}=${m.status}`).join(', ') || 'outside-site invoice only'}.`,
    commerce ? `Customer-business commerce plan (${commerce.type}): ${commerce.summary}` : null,
    commerce ? `Commerce CTA: "${commerce.ctaLabel}" as a lead form/contact action only; paymentLinkUrl is intentionally null.` : null,
    commerceSections.length ? `Commerce sections to include: ${commerceSections.map((section) => `${section.title}: ${section.copy}`).join(' ')}` : null,
    commerceChecklist.length ? `Commerce launch checklist: ${commerceChecklist.map((item) => `${item.key}=${item.status}`).join(', ')}.` : null,
    commerce ? 'Commerce guardrail: do not add fake checkout, Stripe, payment, subscription, deposit, tax, refund, return, or cancellation links. Only use customer-supplied policy copy, and route unsafe commerce details to contact/operator review.' : null,
    `Review/trust proof: ${brief.reviewProof?.items?.length ? brief.reviewProof.items.join('; ') : brief.reviewProof?.disclaimer || 'Use only confirmed facts; do not invent reviews.'}`,
    `Required sections: ${(brief.sections || []).map((section) => `${section.name}: ${section.goal}`).join(' | ')}.`,
    `Assets/placeholders: ${(brief.assets || []).map((asset) => `${asset.type}:${asset.alt}`).join(' | ')}.`,
    `Customer need: ${brief.customerNeed}.`,
    `Style: ${brief.styleDirection}.`,
    facts.hours ? `Confirmed hours: ${facts.hours}.` : null,
    facts.address ? `Confirmed address: ${facts.address}.` : null,
    facts.researchSummary ? `Context: ${facts.researchSummary}.` : null,
    facts.leadIntelligence?.reviewThemes?.length ? `Review/customer themes: ${facts.leadIntelligence.reviewThemes.map((item) => item.summary || item.claim).join('; ')}.` : null,
    facts.leadIntelligence?.competitorComparison?.length ? `Competitor gaps: ${facts.leadIntelligence.competitorComparison.map((item) => item.summary || item.claim).join('; ')}.` : null,
    facts.leadIntelligence?.currentWebsiteIssues?.length ? `Website issues to solve: ${facts.leadIntelligence.currentWebsiteIssues.map((item) => item.summary || item.claim).join('; ')}.` : null,
    facts.leadIntelligence?.bestCtaRecommendation ? `Evidence-based CTA: ${facts.leadIntelligence.bestCtaRecommendation.summary || facts.leadIntelligence.bestCtaRecommendation.claim}.` : null,
    facts.evidenceTrace ? `Evidence/source trail: ${facts.evidenceTrace}.` : null,
    pack && pack.key !== 'default' && pack.siteTemplateHint ? `Vertical template hint (${pack.name || pack.key}): ${pack.siteTemplateHint}` : null,
    pack && pack.key !== 'default' && pack.customerPersonaHint ? `Vertical customer persona: ${pack.customerPersonaHint}` : null,
    'Required launch readiness: mobile + desktop responsive, visible tap-to-call CTA, email or form fallback, LocalBusiness JSON-LD, hours/address/service-area when confirmed, alt text on every image, no broken internal links, no fake claims, and no checkout/booking claims unless confirmed.',
    `Guardrails: ${brief.prohibitedClaims.join(' ')}`,
    (brief.disclaimers || []).length ? `Disclaimers to obey: ${brief.disclaimers.join(' ')}` : null,
    footerLine
      ? `Referral footer (required): Add a <footer> below the main content containing this single line, with the URL as a clickable link: "${footerLine}". Render this verbatim in a small footer below the main content — small, muted, unobtrusive text (about 12px, low-contrast color, centered). Do not paraphrase, shorten, or remove the URL.`
      : null
  ].filter(Boolean).join('\n');

  return compactText(prompt, 2800);
}

export function renderMockGeneratedSite({ brief, revisionPrompt = null, flawed = false } = {}) {
  const name = flawed ? 'Generated Local Site' : brief.businessName;
  const phone = flawed ? '' : brief.phone;
  const services = flawed ? [] : (brief.serviceCards || (brief.services || []).map((name) => ({ name, description: `${name} for local customers.` }))).slice(0, 6);
  const cta = flawed ? 'Learn more' : brief.cta;
  const commerce = flawed ? null : brief.commercePlan;
  const commerceSections = flawed ? [] : (brief.commerceSections || []).slice(0, 4);
  const email = brief.sourceFacts?.email || brief.contactMethods?.find((m) => m.type === 'email')?.value || null;
  const hours = brief.location?.hours || brief.sourceFacts?.hours || null;
  const address = brief.location?.address || brief.sourceFacts?.address || null;
  const area = brief.location?.serviceArea || brief.locationOrServiceArea || '';
  const publicInvoiceNote = safePublicInvoiceNote((brief.commerceNeeds || []).find((item) => item.key === 'invoice')?.detail);
  const primaryHref = phone ? `tel:${escapeHtml(phone)}` : '#contact';
  const secondaryHref = email ? `mailto:${escapeHtml(email)}` : '#contact-form';
  const serviceMarkup = services.map((service) => `<article class="service-card" id="${escapeHtml(slug(service.name))}">
        <h3>${escapeHtml(service.name)}</h3>
        <p>${escapeHtml(service.description || `${service.name} for customers in ${area}.`)}</p>
      </article>`).join('\n');
  const proofItems = (brief.reviewProof?.items || [])
    .map((item) => safePublicCopy(item))
    .filter(Boolean)
    .filter(publicProofAllowed)
    .slice(0, 4);
  const proofMarkup = proofItems.length
    ? proofItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n')
    : publicProofFallbackItems({ brief, area, address, hours }).map((item) => `<li>${escapeHtml(item)}</li>`).join('\n');
  const commerceMarkup = commerce ? `
    <section id="commerce" aria-label="Commerce details">
      <h2>${escapeHtml(commerce.customerCopy?.headline || 'Request details')}</h2>
      <p>${escapeHtml(commerce.customerCopy?.body || commerce.summary || 'Send a request and the business will confirm the details.')}</p>
      ${commerceSections.length ? `<div class="services">${commerceSections.map((section) => `<article class="service-card"><h3>${escapeHtml(section.title)}</h3><p>${escapeHtml(section.copy)}</p></article>`).join('\n')}</div>` : ''}
      <p><a class="cta" href="#contact">${escapeHtml(commerce.ctaLabel || 'Contact us')}</a></p>
      <p class="micro">No transaction link is published until customer-owned setup is approved.</p>
    </section>` : '';
  const asset = (brief.assets || [])[0] || { alt: `${name} local service visual` };
  const assetAlt = publicAssetAlt(asset.alt, { name, area });
  const assetCaption = publicAssetCaption(asset, { name, area });
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name,
    telephone: phone || undefined,
    address: address ? { '@type': 'PostalAddress', streetAddress: address } : undefined,
    areaServed: area || undefined,
    openingHours: hours || undefined,
    url: publicUrl(brief.sourceFacts?.existingWebsite) || undefined
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(name)}</title>
  <meta name="description" content="${escapeHtml(`${name} services in ${area}. Call ${phone || 'the business'} for service details.`)}" />
  <script type="application/ld+json">${escapeScriptJson(schema)}</script>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #18211d; background: #f7f8f5; }
    a { color: #145c43; }
    nav { position: sticky; top: 0; z-index: 2; display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 12px max(20px, calc((100vw - 1120px) / 2)); background: rgba(247,248,245,.94); border-bottom: 1px solid #dbe3dc; backdrop-filter: blur(12px); }
    nav .links { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; }
    main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; }
    header, section, footer { padding: clamp(36px, 8vw, 84px) 0; }
    .hero { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(280px, .92fr); gap: clamp(24px, 6vw, 56px); align-items: center; min-height: 78vh; }
    h1 { font-size: clamp(40px, 7vw, 82px); line-height: 1; margin: 0 0 18px; letter-spacing: 0; }
    h2 { font-size: clamp(28px, 4vw, 44px); margin: 0 0 14px; letter-spacing: 0; }
    h3 { font-size: 21px; margin: 0 0 8px; }
    p, li { font-size: 17px; line-height: 1.58; }
    p { max-width: 64ch; }
    .cta-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
    .cta { display: inline-flex; min-height: 46px; align-items: center; justify-content: center; padding: 12px 18px; border-radius: 6px; background: #145c43; color: white; text-decoration: none; font-weight: 750; }
    .cta.secondary { background: transparent; color: #145c43; border: 1px solid #145c43; }
    .hero-card { background: #ffffff; border: 1px solid #d8e0d9; border-radius: 8px; overflow: hidden; box-shadow: 0 18px 50px rgba(21,45,35,.12); }
    .hero-card img { display: block; width: 100%; max-width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: #dbe7df; }
    .hero-card .caption { padding: 18px; color: #4f5b54; }
    .services { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; }
    .service-card, .proof-box, .contact-box { border: 1px solid #d6ded8; border-radius: 8px; padding: 18px; background: white; }
    .proof-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, .7fr); gap: 18px; }
    .contact-grid { display: grid; grid-template-columns: minmax(0, .9fr) minmax(280px, 1.1fr); gap: 18px; align-items: start; }
    form { display: grid; gap: 10px; }
    input, textarea { width: 100%; border: 1px solid #cad5cd; border-radius: 6px; padding: 12px; font: inherit; background: #fff; }
    button { border: 0; border-radius: 6px; padding: 12px 16px; background: #145c43; color: white; font: inherit; font-weight: 750; }
    .micro { color: #66736c; font-size: 13px; }
    footer { border-top: 1px solid #dbe3dc; color: #5b6961; }
    @media (max-width: 760px) {
      nav { align-items: flex-start; flex-direction: column; }
      .hero, .proof-grid, .contact-grid { grid-template-columns: 1fr; min-height: auto; }
      header { padding-top: 42px; }
      .cta-row { position: sticky; bottom: 10px; z-index: 1; }
      .cta { flex: 1 1 180px; }
    }
  </style>
</head>
<body>
  <nav aria-label="Primary navigation">
    <strong>${escapeHtml(name)}</strong>
    <div class="links">
      <a href="#services">Services</a>
      <a href="#proof">Proof</a>
      <a href="#area">Area</a>
      <a href="#contact">Contact</a>
    </div>
  </nav>
  <main>
    <header class="hero">
      <div>
        <h1>${escapeHtml(name)}</h1>
        <p>${escapeHtml(safePublicCopy(brief.hero?.subheadline) || 'Clear service details, local context, and a direct way to request help.')}</p>
        <div class="cta-row">
          <a class="cta" href="${primaryHref}">${escapeHtml(cta)}</a>
          <a class="cta secondary" href="${secondaryHref}">${email ? `Email ${escapeHtml(email)}` : 'Send a request'}</a>
        </div>
        <p class="micro">${escapeHtml(safePublicCopy(brief.hero?.proofLine) || 'Service details and contact paths are easy to find.')}</p>
      </div>
      <figure class="hero-card">
        <img alt="${escapeHtml(assetAlt)}" src="${placeholderImageDataUrl(name, area)}" />
        <figcaption class="caption">${escapeHtml(assetCaption)}</figcaption>
      </figure>
    </header>
    <section id="services" aria-label="Services">
      <h2>Services</h2>
      <div class="services">${serviceMarkup}</div>
    </section>
    <section id="proof" aria-label="Trust proof">
      <h2>Trust proof</h2>
      <div class="proof-grid">
        <div class="proof-box"><ul>${proofMarkup}</ul></div>
        <div class="proof-box"><p>${escapeHtml(publicReviewDisclaimer(brief.reviewProof?.disclaimer))}</p></div>
      </div>
    </section>
    <section id="area" aria-label="Service area">
      <h2>${escapeHtml(area || 'Service area')}</h2>
      <p>${address ? `Address: ${escapeHtml(address)}. ` : ''}${hours ? `Hours: ${escapeHtml(hours)}. ` : ''}Clear service information, practical contact details, and a simple quote path.</p>
    </section>
    ${commerceMarkup}
    <footer id="contact">
      <div class="contact-grid">
        <div class="contact-box">
          <h2>Contact ${escapeHtml(name)}</h2>
          <p>${phone ? `Call ${escapeHtml(phone)} to get started.` : 'Contact details pending.'}</p>
          ${email ? `<p>Email <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>.</p>` : ''}
          <p class="micro">${escapeHtml(publicInvoiceNote)}</p>
        </div>
        <form id="contact-form" class="contact-box" action="#contact" method="get">
          <label>Name<input name="name" autocomplete="name" /></label>
          <label>How can we help?<textarea name="message" rows="4"></textarea></label>
          <button type="submit">Request contact</button>
        </form>
      </div>
      ${revisionPrompt ? `<p data-revision="true">${escapeHtml(revisionPrompt.slice(0, 180))}</p>` : ''}
    </footer>
  </main>
</body>
</html>`;
}

function safePublicInvoiceNote(detail) {
  const text = firstText(detail, null);
  if (!text || /\b(pay online|online payment|checkout|deposit|financing|payment plan)\b/i.test(text)) {
    return 'Use the form or email for quote details.';
  }
  return text;
}

function unsupportedClaims(brief) {
  const allowed = brief.confirmedCapabilities || {};
  const text = publicBriefText(brief);

  const out = [];
  for (const item of UNSUPPORTED_PATTERNS) {
    if (item.code.includes('booking') && allowed.booking) continue;
    if (item.code.includes('payment') && allowed.payments) continue;
    if (item.pattern.test(text)) out.push(item);
  }
  return out;
}

function isPhoneBookingCta(value) {
  return /\b(call\s+to\s+book|call\s+.*\bappointment|book\s+(?:an?\s+)?appointment|schedule\s+(?:an?\s+)?appointment)\b/i.test(value || '');
}

function traceClaim(item) {
  if (!item) return null;
  return {
    id: item.id || null,
    summary: item.summary || item.claim || item.title || null,
    evidenceIds: item.evidenceIds || [],
    sourceIds: item.sourceIds || [],
    sourceUrls: item.sourceUrls || []
  };
}

function buildContactMethods({ phone, email, confirmedCapabilities }) {
  return [
    phone ? { type: 'phone', label: 'Tap-to-call', value: phone, href: `tel:${phone}`, required: true } : null,
    email ? { type: 'email', label: 'Email', value: email, href: `mailto:${email}`, required: false } : null,
    { type: 'form', label: 'Simple inquiry form', value: '#contact-form', href: '#contact-form', required: true },
    confirmedCapabilities.booking ? { type: 'booking', label: 'Confirmed booking link', value: 'confirmed', href: null, required: false } : null
  ].filter(Boolean);
}

function buildCommerceNeeds({ latestPayment, confirmedCapabilities, commercePlan = null }) {
  const base = [
    {
      key: 'invoice',
      status: latestPayment?.status || 'pending',
      detail: latestPayment?.status === 'paid'
        ? 'Customer invoice is paid; public site should not expose checkout unless explicitly configured.'
        : 'Invoice/payment state lives in Stripe and the customer portal, not as public checkout copy.'
    },
    {
      key: 'online_payments',
      status: confirmedCapabilities.payments ? 'confirmed' : 'not_confirmed',
      detail: confirmedCapabilities.payments ? 'Online payment capability was confirmed.' : 'Do not add online checkout or deposit collection.'
    },
    {
      key: 'booking',
      status: confirmedCapabilities.booking ? 'confirmed' : 'not_confirmed',
      detail: confirmedCapabilities.booking ? 'Booking capability was confirmed.' : 'Use call/email/form requests instead of booking claims.'
    }
  ];
  if (!commercePlan) return base;
  return [
    ...base,
    {
      key: 'customer_commerce_type',
      status: commercePlan.type,
      detail: commercePlan.websiteBrief?.summary || 'Customer commerce plan is captured.'
    },
    {
      key: 'customer_commerce_stripe',
      status: commercePlan.stripeBoundary?.mode || 'not_required',
      detail: commercePlan.stripeBoundary?.requiresStripe
        ? 'Customer-business payment setup is separate from Callan revenue and requires operator approval before any public link.'
        : 'Use inquiry/contact flow; no customer-business payment link is needed for the first site flow.'
    },
    {
      key: 'customer_commerce_readiness',
      status: commercePlan.humanHandoff?.required ? 'handoff_required' : commercePlan.status,
      detail: commercePlan.humanHandoff?.boundary || 'Use only customer-supplied commerce facts.'
    }
  ];
}

function buildReviewProof({ profile, postMortem }) {
  const items = uniqueItems([
    ...listItems(profile?.signals, 4, []),
    ...listItems(profile?.proof, 4, []),
    firstText(profile?.onlinePresenceSummary, null),
    firstText(postMortem?.reason, null)
  ], 4).map((item) => safePublicCopy(item)).filter(Boolean).filter(publicProofAllowed);
  return {
    status: items.length ? 'evidence_backed' : 'limited',
    items,
    disclaimer: items.length
      ? 'Use these proof points only as supplied; unverified credibility claims must stay omitted.'
      : 'No public credibility proof was verified, so omit unverified credibility claims.'
  };
}

function publicProofAllowed(item) {
  return !INTERNAL_PUBLIC_TEXT_RE.test(item || '') &&
    !/\b(5[- ]?star|five[- ]?star|top rated|best rated|award|licensed|insured|guarantee|invoice|payment|pay|paid|stripe|price|pricing|\$\s*\d+)\b/i.test(item || '');
}

function composeHeroSubheadline({ profile, niche, services, area, customerNeed }) {
  const core = serviceSentenceList((services || []).slice(0, 3)) ||
    publicWhatTheyDo(profile?.whatTheyDo) ||
    safePublicCopy(niche) ||
    safePublicCopy(customerNeed) ||
    'Local service help';
  const cleanedCore = stripSentencePunctuation(core);
  const areaText = safePublicCopy(area);
  const areaPhrase = areaText && !normalizeText(cleanedCore).includes(normalizeText(areaText)) ? ` in ${areaText}` : '';
  return capitalizeSentence(`${cleanedCore}${areaPhrase}, with clear service details and a direct way to request help.`);
}

function serviceDescription({ service, area }) {
  const name = sentenceCaseService(service);
  const areaText = safePublicCopy(area) || 'the local area';
  return `Clear information about ${name} for customers in ${areaText}.`;
}

function serviceSentenceList(services) {
  const values = (services || []).map(sentenceCaseService).filter(Boolean);
  return readableList(values);
}

function publicWhatTheyDo(value) {
  const text = safePublicCopy(value);
  if (!text) return null;
  if (/\bis\s+an?\s+[\w\s-]+\s+in\s+/i.test(text)) return null;
  return text;
}

function sentenceCaseService(value) {
  const text = safePublicCopy(value);
  if (!text) return null;
  return text.toLowerCase().replace(/\bhvac\b/g, 'HVAC');
}

function publicProofLine({ location, phone, email }) {
  const pieces = [];
  if (location?.serviceArea) pieces.push(`${location.serviceArea} service area`);
  if (location?.hours) pieces.push('hours');
  if (phone || email) pieces.push('contact details');
  if (!pieces.length) return 'Service details and contact paths are easy to find.';
  return `${capitalizeSentence(readableList(pieces))} are easy to find.`;
}

function publicProofFallbackItems({ brief, area, address, hours }) {
  return [
    area ? `${brief.businessName} lists service details for ${area}.` : `${brief.businessName} lists services clearly before launch.`,
    address ? `Address details are shown for customers who need the service area.` : null,
    hours ? `Hours are shown so customers know when to reach out.` : null,
    'Phone, email, and form paths are easy to find.'
  ].filter(Boolean);
}

function publicAssetAlt(value, { name, area }) {
  const text = safePublicCopy(value);
  if (!text) return `${name || 'Local business'} service visual${area ? ` for ${area}` : ''}`;
  return text.replace(/\s+placeholder\b/ig, '').replace(/\bhvac\b/ig, 'HVAC').trim() || `${name || 'Local business'} service visual`;
}

function publicAssetCaption(asset, { name, area }) {
  if (asset?.type && String(asset.type).includes('placeholder')) {
    return `${name || 'This business'} service area and core services at a glance.`;
  }
  return safePublicCopy(asset?.caption) || `${name || 'This business'} serves ${area || 'local customers'} with a direct contact path.`;
}

function publicReviewDisclaimer(value) {
  const text = safePublicCopy(value);
  if (/\b(no public credibility proof|credibility proof|unverified|verified)\b/i.test(text || '')) {
    return 'Only confirmed business details are shown here.';
  }
  return text || 'Only confirmed business details are shown here.';
}

function publicUrl(value) {
  const text = firstText(value, null);
  if (!text || !/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (/\.(test|example|invalid)$/i.test(url.hostname) || /^example\./i.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function buildAssets({ businessName, niche, services, profile }) {
  const images = listItems(profile?.images, 6, []);
  const baseAlt = `${businessName || 'Local business'} ${niche || 'service'} work area`;
  const supplied = images.map((url, index) => ({
    type: 'customer_image',
    url,
    alt: `${baseAlt} image ${index + 1}`,
    caption: `${businessName || 'The business'} supplied image ${index + 1}.`
  }));
  if (supplied.length) return supplied;
  return [
    {
      type: 'placeholder',
      url: null,
      alt: `${baseAlt} placeholder`,
      caption: `${businessName || 'This business'} can replace this placeholder with real work photos before launch.`
    },
    {
      type: 'icon_placeholder',
      url: null,
      alt: `${services?.[0] || niche || 'Service'} icon placeholder`,
      caption: 'Simple service visual, not a fabricated customer photo.'
    }
  ];
}

function safePublicCopy(value) {
  const text = compactText(value, 220);
  if (!text) return null;
  if (INTERNAL_PUBLIC_TEXT_RE.test(text)) return null;
  if (UNSUPPORTED_PATTERNS.some((item) => item.pattern.test(text))) return null;
  if (CLAIMY_PUBLIC_TEXT_RE.test(text)) return null;
  return text;
}

function formatServiceDisplayName(value) {
  const text = safePublicCopy(value);
  if (!text) return null;
  const small = new Set(['and', 'or', 'for', 'of', 'the', 'a', 'an', 'to', 'in']);
  return text
    .split(/\s+/)
    .map((word, index) => {
      const clean = word.toLowerCase();
      if (clean === 'hvac') return 'HVAC';
      if (index > 0 && small.has(clean)) return clean;
      return `${clean.slice(0, 1).toUpperCase()}${clean.slice(1)}`;
    })
    .join(' ');
}

function readableList(items) {
  const values = (items || []).map((item) => safePublicCopy(item)).filter(Boolean);
  if (!values.length) return null;
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function stripSentencePunctuation(value) {
  return String(value || '').trim().replace(/[.。]+$/g, '');
}

function capitalizeSentence(value) {
  const text = String(value || '').trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function publicBriefText(brief) {
  return [
    brief.cta,
    brief.customerNeed,
    brief.styleDirection,
    brief.hero?.headline,
    brief.hero?.subheadline,
    brief.hero?.primaryCta,
    ...(brief.services || []),
    ...(brief.serviceCards || []).flatMap((service) => [service.name, service.description]),
    ...(brief.sections || []).flatMap((section) => [section.name, section.goal, ...(section.requiredFacts || [])]),
    ...(brief.reviewProof?.items || [])
  ].filter(Boolean).join(' ');
}

function pickServices({ lead, profile, niche }) {
  const explicit = [
    ...listItems(profile?.services, 8, []),
    ...listItems(profile?.serviceList, 8, []),
    ...listItems(profile?.offerings, 8, [])
  ];
  if (explicit.length) return uniqueItems(explicit, 6);

  const whatTheyDo = firstText(profile?.whatTheyDo, profile?.summary, profile?.description, null);
  const needs = listItems(profile?.needs, 4, []);
  if (whatTheyDo) return uniqueItems([whatTheyDo, ...needs], 6);

  if (firstText(niche, null)) {
    return uniqueItems([
      `${niche} services`,
      'consultations or estimates',
      'contact and location details'
    ], 6);
  }

  return [];
}

function pickStyle(niche) {
  const n = String(niche || '');
  if (/(barber|salon|spa|nail|tattoo|hair)/i.test(n)) return { tone: 'warm and stylish', palette: 'warm neutrals with one bold accent', layout: 'photo-led hero, service cards, visible call CTA' };
  if (/(law|legal|accountant|tax|cpa|bookkeep|paralegal|finance)/i.test(n)) return { tone: 'professional and trustworthy', palette: 'white, charcoal, and one restrained accent', layout: 'credibility-first hero, service proof, calm contact section' };
  if (/(kids|party|toy|playground|daycare|ice cream|cafe|bakery)/i.test(n)) return { tone: 'playful and friendly', palette: 'bright accents on clean white', layout: 'bright hero, visual menu, family-friendly contact flow' };
  if (/(plumb|hvac|electric|roof|contractor|landscap|auto|repair|mechanic)/i.test(n)) return { tone: 'dependable and direct', palette: 'white, deep green, and safety yellow accents', layout: 'service-area hero, urgent contact CTA, trust proof' };
  return { tone: 'clean and professional', palette: 'neutral base with one brand accent', layout: 'clear hero, short service sections, sticky mobile call CTA' };
}

function parseDocContent(doc) {
  const c = doc?.content;
  if (!c) return null;
  if (typeof c === 'object') return c;
  return parseJson(c) || { summary: String(c) };
}

function parseJson(value) {
  if (!value || typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try { return JSON.parse(value); } catch { return null; }
}

function listItems(value, limit, fallback = []) {
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(/\n|;|\u2022|,/);
  else if (value && typeof value === 'object') items = Object.values(value);

  const cleaned = items
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'object') return firstText(item.text, item.name, item.title, item.note, item.excerpt, safeStringify(item));
      return compactText(item, 180);
    })
    .filter(Boolean);

  const result = uniqueItems(cleaned, limit);
  return result.length ? result : fallback.slice(0, limit);
}

function uniqueItems(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = compactText(item, 220);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function firstText(...values) {
  for (const value of values) {
    const text = compactText(value, 260);
    if (text) return text;
  }
  return null;
}

function compactText(value, max = 240) {
  if (value === null || value === undefined) return null;
  const raw = Array.isArray(value) ? value.join('; ') : typeof value === 'object' ? safeStringify(value) : String(value);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function snake(value) {
  return String(value || '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, '');
}

function slug(value) {
  return String(value || 'section')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'section';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeScriptJson(value) {
  return JSON.stringify(value, (_key, nested) => nested === undefined ? undefined : nested)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function placeholderImageDataUrl(name, area) {
  const title = escapeSvg(`${name || 'Local business'}`.slice(0, 34));
  const subtitle = escapeSvg(`${area || 'Local service area'}`.slice(0, 42));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720" viewBox="0 0 960 720"><rect width="960" height="720" fill="#dfeae2"/><circle cx="760" cy="180" r="118" fill="#f0c977"/><rect x="86" y="408" width="788" height="178" rx="28" fill="#ffffff" opacity=".82"/><path d="M140 392 L330 232 L474 354 L565 276 L820 392 Z" fill="#86a990"/><text x="112" y="486" font-family="Arial, sans-serif" font-size="52" font-weight="700" fill="#173f31">${title}</text><text x="112" y="544" font-family="Arial, sans-serif" font-size="30" fill="#48645a">${subtitle}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeSvg(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
