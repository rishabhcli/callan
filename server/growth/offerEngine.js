import { GROWTH_OFFER_IDS, PLAN_SECTION_KEYS, collectRecommendations } from './schema.js';

const OFFER_DEFS = Object.freeze({
  starter_website: {
    id: 'starter_website',
    name: 'Starter website',
    summary: 'A compact site with services, hours, phone, contact path, and local business basics.',
    setupCents: 50000,
    monthlyCents: 0,
    sections: ['localSeoGaps', 'bookingContactFlowPlan', 'contentIdeas']
  },
  website_local_seo: {
    id: 'website_local_seo',
    name: 'Website + local SEO',
    summary: 'Site foundation plus local search basics, structured data, NAP consistency, and Google Business Profile tasks.',
    setupCents: 85000,
    monthlyCents: 0,
    sections: ['localSeoGaps', 'googleBusinessProfileTasks', 'contentIdeas', 'analyticsSetup']
  },
  review_system: {
    id: 'review_system',
    name: 'Review system',
    summary: 'Simple review request flow, reply prompts, and owner-safe review follow-up tracking.',
    setupCents: 25000,
    monthlyCents: 7500,
    sections: ['reviewCapturePlan', 'automationIdeas']
  },
  booking_contact_automation: {
    id: 'booking_contact_automation',
    name: 'Booking/contact automation',
    summary: 'Contact form, booking/quote intake, missed-call follow-up, and lead routing basics.',
    setupCents: 35000,
    monthlyCents: 10000,
    sections: ['bookingContactFlowPlan', 'automationIdeas']
  },
  monthly_maintenance: {
    id: 'monthly_maintenance',
    name: 'Monthly maintenance',
    summary: 'Monthly content, hours/profile checks, analytics review, and lightweight website updates.',
    setupCents: 0,
    monthlyCents: 15000,
    sections: ['monthlyMaintenancePlan', 'analyticsSetup', 'contentIdeas']
  }
});

export function buildGrowthOffers(plan, context = {}) {
  const evidenceIdsBySection = evidenceIdsForSections(plan);
  const fallbackEvidence = firstEvidenceId(plan);
  const recommendedSections = new Set();
  for (const key of PLAN_SECTION_KEYS) {
    if (Array.isArray(plan?.[key]) && plan[key].some((item) => !item.unsupported)) recommendedSections.add(key);
  }

  const offers = GROWTH_OFFER_IDS.map((id) => {
    const def = OFFER_DEFS[id];
    const sectionEvidence = unique(def.sections.flatMap((section) => evidenceIdsBySection.get(section) || []));
    const evidenceIds = sectionEvidence.length ? sectionEvidence : (fallbackEvidence ? [fallbackEvidence] : []);
    const opportunityCount = def.sections.reduce((sum, section) => sum + (plan?.[section]?.filter((item) => !item.unsupported).length || 0), 0);
    return {
      ...def,
      recommended: opportunityCount > 0,
      opportunityCount,
      evidenceIds,
      reason: reasonForOffer(id, plan, context)
    };
  });

  const nextRecommendedService = pickNextService(offers, plan, context);
  return {
    schemaVersion: 'growth_offers.v1',
    offers,
    nextRecommendedService
  };
}

function pickNextService(offers, plan, context) {
  const profile = context.profile || {};
  const hasWebsite = Boolean(profile.hasWebsite || profile.websiteUrl || context.lead?.website);
  const hasHighSeo = hasHighPriority(plan, ['localSeoGaps', 'googleBusinessProfileTasks']);
  const order = hasWebsite
    ? ['website_local_seo', 'review_system', 'booking_contact_automation', 'monthly_maintenance', 'starter_website']
    : ['website_local_seo', 'starter_website', 'booking_contact_automation', 'review_system', 'monthly_maintenance'];

  if (hasHighSeo) order.unshift('website_local_seo');
  for (const id of unique(order)) {
    const offer = offers.find((item) => item.id === id && item.recommended && item.evidenceIds.length);
    if (offer) return {
      id: offer.id,
      name: offer.name,
      summary: offer.summary,
      reason: offer.reason,
      evidenceIds: offer.evidenceIds
    };
  }
  const fallback = offers.find((item) => item.id === 'monthly_maintenance') || offers[0];
  return {
    id: fallback.id,
    name: fallback.name,
    summary: fallback.summary,
    reason: fallback.reason,
    evidenceIds: fallback.evidenceIds
  };
}

function evidenceIdsForSections(plan) {
  const map = new Map();
  for (const item of collectRecommendations(plan)) {
    if (!Array.isArray(item.evidenceIds)) continue;
    const list = map.get(item.section) || [];
    list.push(...item.evidenceIds);
    map.set(item.section, unique(list));
  }
  return map;
}

function hasHighPriority(plan, sections) {
  return sections.some((section) => (plan?.[section] || []).some((item) => item.priority === 'high' && !item.unsupported));
}

function reasonForOffer(id, plan, context) {
  const profile = context.profile || {};
  if (id === 'starter_website') {
    return profile.hasWebsite ? 'The business already has a web surface, so this is a fallback package.' : 'Research shows the business needs an owned website foundation before more advanced growth work.';
  }
  if (id === 'website_local_seo') {
    return 'Local search and Google Business Profile tasks are backed by the current lead evidence.';
  }
  if (id === 'review_system') {
    return 'The plan found review capture or review response opportunities that can be operationalized without ranking guarantees.';
  }
  if (id === 'booking_contact_automation') {
    return 'The customer path needs a cleaner contact, booking, quote, or missed-lead follow-up loop.';
  }
  if (id === 'monthly_maintenance') {
    return 'The business needs recurring updates, analytics review, and profile hygiene after delivery.';
  }
  return 'Recommended from the evidence-backed growth plan.';
}

function firstEvidenceId(plan) {
  return plan?.evidence?.[0]?.id || null;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}
