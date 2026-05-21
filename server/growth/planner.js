import { createHash, randomBytes } from 'node:crypto';
import { emit } from '../sse.js';
import { contactEvents, growthFollowups, growthPlans, leads, calls, runs } from '../db.js';
import { env } from '../env.js';
import { addDoc, containerTagFor, listKinds } from '../memory.js';
import { generateStructured } from '../reasoning/geminiReasoner.js';
import { GrowthPlan as ReasoningGrowthPlan } from '../reasoning/schemas.js';
import { log } from '../logger.js';
import { buildGrowthOffers } from './offerEngine.js';
import { PLAN_SECTION_KEYS, collectRecommendations, emptyGrowthPlan } from './schema.js';
import { compactLeadIntelligence } from '../research/leadIntelligence.js';

const GROWTH_SYSTEM = [
  'You write operational growth plans for small local businesses after a website delivery.',
  'Use only the supplied research, call, email, and delivery evidence.',
  'Recommend local SEO, Google Business Profile, review capture, booking/contact flow, analytics, content, maintenance, and simple automations.',
  'Every recommendation must cite evidenceIds from the evidence array.',
  'Do not provide legal, tax, financial, medical, or guaranteed SEO/ranking advice.',
  'If the customer asks for unsupported advice or guaranteed rankings, set the risk and unsupported flags and recommend human handoff.',
  'Output only JSON matching the schema.'
].join(' ');

const UNSUPPORTED_RE = /\b(legal|lawyer|attorney|contract|tax|cpa|guarantee|guaranteed|first page google|revenue promise|medical|diagnos)/i;
const SEO_GUARANTEE_RE = /\b(guarantee|guaranteed|promise).{0,40}\b(rank|ranking|first page|traffic|revenue|sales|leads?)\b/i;

export async function generateGrowthPlanForLead({ leadId, force = false, source = 'operator' } = {}) {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`lead not found: ${leadId}`);
  const existing = growthPlans.getLatest(leadId);
  if (existing && !force) {
    emit('growth.plan_reused', {
      worker: 'growth',
      leadId,
      growthPlanId: existing.id,
      source,
      nextRecommendedService: existing.next_service_id
    });
    return readGrowthPlanRow(existing);
  }

  const runId = `growth_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  runs.start({ id: runId, lead_id: leadId, worker: 'growth' });
  emit('growth.start', { worker: 'growth', leadId, runId, source });

  try {
    const context = await collectGrowthContext(lead);
    const provider = choosePlannerProvider();
    emit('growth.provider', {
      worker: 'growth',
      leadId,
      runId,
      provider: provider.name,
      synthetic: provider.synthetic
    });

    const rawPlan = await provider.generate({ lead, context });
    const plan = normalizeGrowthPlan(rawPlan, { lead, context });
    const offers = buildGrowthOffers(plan, { lead, profile: context.profile });
    const idempotencyKey = `growth_plan:${leadId}:${stableHash({
      profile: context.profileFingerprint,
      contact: context.contactFingerprint,
      build: context.deliveryFingerprint
    })}`;
    const row = growthPlans.upsert({
      id: `gp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
      lead_id: leadId,
      status: 'ready',
      plan,
      offers,
      next_service_id: offers.nextRecommendedService?.id || null,
      evidence_count: plan.evidence.length,
      unsupported_count: plan.unsupportedFlags.length,
      idempotency_key: idempotencyKey
    });

    await writeGrowthMemory(lead, plan, offers, row.id);

    runs.finish(runId, {
      state: 'completed',
      detail: {
        growthPlanId: row.id,
        nextRecommendedService: offers.nextRecommendedService?.id || null,
        evidenceCount: plan.evidence.length,
        unsupportedFlags: plan.unsupportedFlags,
        provider: provider.name
      }
    });

    emit('growth.plan_generated', {
      worker: 'growth',
      leadId,
      runId,
      growthPlanId: row.id,
      nextRecommendedService: offers.nextRecommendedService?.id,
      evidenceCount: plan.evidence.length,
      unsupportedFlags: plan.unsupportedFlags,
      provider: provider.name,
      synthetic: provider.synthetic
    });

    return { row, plan, offers };
  } catch (err) {
    runs.finish(runId, { state: 'failed', error: err?.message || String(err) });
    emit('growth.error', { worker: 'growth', leadId, runId, error: err?.message || String(err) });
    throw err;
  }
}

export async function readGrowthState(leadId) {
  const latest = growthPlans.getLatest(leadId);
  if (!latest) return { plan: null, offers: null, row: null, followups: [] };
  return {
    ...readGrowthPlanRow(latest),
    followups: growthFollowups.listByLead(leadId)
  };
}

export function readGrowthPlanRow(row) {
  if (!row) return { row: null, plan: null, offers: null };
  return {
    row,
    plan: safeJson(row.plan_json),
    offers: safeJson(row.offer_json)
  };
}

export async function collectGrowthContext(lead) {
  const leadId = lead.id;
  const researchProfile = safeJson(lead.research_json) || {};
  const dbCalls = calls.listByLead(leadId).slice(0, 3);
  const dbContacts = contactEvents.listByLead(leadId, { limit: 20 });
  let memory = null;
  try {
    memory = await listKinds(lead.container_tag || containerTagFor(leadId));
  } catch (err) {
    memory = null;
  }

  const postMortem = parseDoc(memory?.post_mortem?.[0]) || latestAnalystDetail(leadId);
  const mailDocs = (memory?.mail_thread || []).slice(0, 5).map(parseDoc).filter(Boolean);
  const profile = {
    businessName: lead.business_name,
    phone: lead.phone,
    address: lead.address,
    city: lead.city,
    niche: lead.niche,
    websiteUrl: lead.website,
    ...researchProfile
  };
  profile.leadIntelligence = compactLeadIntelligence(profile.leadIntelligence, { evidenceLimit: 16 });
  const evidence = collectEvidence({ lead, profile, postMortem, mailDocs, contacts: dbContacts, calls: dbCalls });
  const conversationText = [
    JSON.stringify(postMortem || {}),
    dbContacts.map((event) => `${event.direction} ${event.type}: ${event.subject || ''} ${event.body || ''}`).join('\n')
  ].join('\n');

  return {
    lead,
    profile,
    postMortem,
    mailDocs,
    contacts: dbContacts,
    calls: dbCalls,
    evidence,
    unsupportedSignals: unsupportedSignals(conversationText),
    profileFingerprint: stableHash(profile),
    contactFingerprint: stableHash(dbContacts.map((event) => [event.type, event.direction, event.subject, event.body])),
    deliveryFingerprint: stableHash({ status: lead.status, website: lead.website })
  };
}

function choosePlannerProvider() {
  const liveGemini = env.runMode !== 'mock' && env.gemini.apiKey;
  return {
    name: liveGemini ? 'gemini-structured-reasoner' : 'synthetic-gemini-structured-reasoner',
    synthetic: !liveGemini,
    generate: (args) => generateStructuredGrowthPlan({ ...args, synthetic: !liveGemini })
  };
}

async function generateStructuredGrowthPlan({ lead, context, synthetic = false }) {
  const prompt = [
    GROWTH_SYSTEM,
    '',
    `Lead: ${lead.business_name} (${lead.niche || 'local services'}, ${lead.city || 'unknown city'}).`,
    `Delivery status: ${lead.status || 'unknown'}. Website: ${lead.website || context.profile.websiteUrl || 'not recorded'}.`,
    '',
    'EVIDENCE IDS AVAILABLE:',
    JSON.stringify(context.evidence, null, 2),
    '',
    'BUSINESS PROFILE:',
    JSON.stringify(context.profile, null, 2).slice(0, 12000),
    '',
    'CALL ANALYSIS:',
    JSON.stringify(context.postMortem || {}, null, 2).slice(0, 9000),
    '',
    'AGENTMAIL THREAD EVIDENCE:',
    JSON.stringify(context.contacts.map((event) => ({
      direction: event.direction,
      type: event.type,
      subject: event.subject,
      body: event.body,
      metadata: safeJson(event.metadata_json)
    })), null, 2).slice(0, 12000),
    '',
    'Return the central GrowthPlan strategy. The existing delivery adapter will turn your strategic channels and next actions into the persisted section plan.'
  ].join('\n');

  const { output, trace } = await generateStructured({
    kind: 'growthPlan',
    schema: ReasoningGrowthPlan,
    evidence: {
      lead,
      profile: context.profile,
      postMortem: context.postMortem,
      contacts: context.contacts,
      evidence: context.evidence,
      unsupportedSignals: context.unsupportedSignals
    },
    prompt,
    leadId: lead.id,
    worker: 'growth',
    eventId: `growth-plan:${lead.id}:${context.profileFingerprint}:${context.contactFingerprint}:${context.deliveryFingerprint}`,
    thinkingLevel: 'medium',
    forceMock: synthetic
  });

  return reasoningGrowthDecisionToPlan(output, { lead, context, trace });
}

function reasoningGrowthDecisionToPlan(decision, { lead, context, trace }) {
  const plan = emptyGrowthPlan({ leadId: lead.id });
  plan.evidence = context.evidence.length ? context.evidence : fallbackEvidence(lead);
  const evidenceIds = plan.evidence.map((entry) => entry.id);
  const channels = Array.isArray(decision?.acquisitionChannels) ? decision.acquisitionChannels : [];
  const targetSegments = Array.isArray(decision?.targetSegments) ? decision.targetSegments : [];
  const nextActions = Array.isArray(decision?.nextActions) ? decision.nextActions : [];
  const upsellPath = Array.isArray(decision?.upsellPath) ? decision.upsellPath : [];

  plan.localSeoGaps.push(item({
    id: 'reasoning-local-positioning',
    title: 'Strengthen local positioning',
    why: decision?.positioning || 'Gemini identified a need for clearer local positioning from captured evidence.',
    action: targetSegments.length
      ? `Tune the site and local profile around ${targetSegments.slice(0, 3).join(', ')}.`
      : 'Tune the site and local profile around the clearest service-area buyer segment.',
    priority: 'high',
    evidenceIds: bestEvidence(evidenceIds, ['profile', 'presence', 'delivery'])
  }));

  const googleChannel = pickChannel(channels, /google|local|seo|search|profile/i);
  plan.googleBusinessProfileTasks.push(item({
    id: 'reasoning-google-business-profile',
    title: 'Prioritize Google Business Profile hygiene',
    why: googleChannel?.rationale || 'Local discovery depends on accurate services, hours, contact, photos, and review signals.',
    action: googleChannel?.firstExperiment || 'Audit category, services, hours, phone, website URL, photos, and service area against the delivered site.',
    priority: 'high',
    evidenceIds: bestEvidence(evidenceIds, ['profile', 'presence', 'delivery'])
  }));

  const reviewChannel = pickChannel(channels, /review|reputation/i);
  plan.reviewCapturePlan.push(item({
    id: 'reasoning-review-capture',
    title: 'Add a review capture loop',
    why: reviewChannel?.rationale || 'The next growth step should make satisfied-customer proof easier to collect without pressure.',
    action: reviewChannel?.firstExperiment || 'Create a simple post-service review request message and route replies through AgentMail for operator visibility.',
    priority: 'medium',
    evidenceIds: bestEvidence(evidenceIds, ['mail', 'call', 'profile'])
  }));

  const bookingChannel = pickChannel(channels, /booking|schedule|appointment|contact|lead|form/i);
  plan.bookingContactFlowPlan.push(item({
    id: 'reasoning-contact-flow',
    title: 'Make booking or quote requests explicit',
    why: bookingChannel?.rationale || 'Gemini flagged the contact path as a practical conversion lever.',
    action: bookingChannel?.firstExperiment || 'Add one primary call, quote, or appointment CTA and make the follow-up path visible.',
    priority: 'high',
    evidenceIds: bestEvidence(evidenceIds, ['call', 'mail', 'delivery'])
  }));

  plan.analyticsSetup.push(item({
    id: 'reasoning-analytics-baseline',
    title: 'Measure calls and contact intent',
    why: 'Growth recommendations need a baseline for traffic sources and conversion actions.',
    action: 'Track phone taps, contact form submissions, invoice/payment intent, and source traffic before proposing larger growth work.',
    priority: 'medium',
    evidenceIds: bestEvidence(evidenceIds, ['delivery', 'profile'])
  }));

  for (const [index, channel] of channels.slice(0, 3).entries()) {
    plan.contentIdeas.push(item({
      id: `reasoning-channel-${index + 1}`,
      title: `Test ${channel.channel || 'growth'} content`,
      why: channel.rationale || 'Gemini selected this channel from the supplied evidence.',
      action: channel.firstExperiment || 'Run one small, evidence-backed content or outreach experiment before expanding scope.',
      priority: index === 0 ? 'medium' : 'low',
      evidenceIds: bestEvidence(evidenceIds, ['profile', 'mail', 'call'])
    }));
  }

  plan.monthlyMaintenancePlan.push(item({
    id: 'reasoning-maintenance-path',
    title: 'Package recurring site and profile hygiene',
    why: upsellPath.length ? `Gemini suggested upsells: ${upsellPath.slice(0, 3).join(', ')}.` : 'Ongoing profile/site hygiene is the safest recurring service after delivery.',
    action: 'Offer monthly checks for hours, photos, services, reviews, contact flows, broken links, and analytics anomalies.',
    priority: 'low',
    evidenceIds: bestEvidence(evidenceIds, ['delivery', 'profile'])
  }));

  for (const [index, action] of nextActions.slice(0, 3).entries()) {
    plan.automationIdeas.push(item({
      id: safeCode(action.code) || `reasoning-next-action-${index + 1}`,
      title: action.label || 'Automate the next growth action',
      why: action.reason || 'Gemini recommended this as the next best action.',
      action: action.label || 'Queue this for operator review before customer-facing follow-up.',
      priority: index === 0 ? 'medium' : 'low',
      evidenceIds: bestEvidence(evidenceIds, ['mail', 'call', 'delivery'])
    }));
  }

  if (trace?.id) plan.reasoningTraceId = trace.id;
  plan.risk.notes = unique([
    ...(Array.isArray(decision?.risks) ? decision.risks : []),
    trace?.id ? `Growth strategy generated from Gemini reasoning trace ${trace.id}.` : null
  ].filter(Boolean)).slice(0, 8);
  applyUnsupportedSignals(plan, context.unsupportedSignals, evidenceIds);
  return plan;
}

function pickChannel(channels, pattern) {
  return channels.find((channel) => pattern.test(`${channel?.channel || ''} ${channel?.rationale || ''} ${channel?.firstExperiment || ''}`));
}

function generateSyntheticPlan({ lead, context }) {
  const plan = emptyGrowthPlan({ leadId: lead.id });
  plan.evidence = context.evidence.length ? context.evidence : fallbackEvidence(lead);
  const evidenceIds = plan.evidence.map((item) => item.id);
  const primary = evidenceIds[0];
  const profile = context.profile || {};
  const intel = compactLeadIntelligence(profile.leadIntelligence, { evidenceLimit: 16 });
  const hasWebsite = Boolean(profile.hasWebsite || profile.websiteUrl || lead.website);
  const hoursUnknown = /unknown|not found|missing/i.test(String(profile.hours || ''));
  const weakPresence = ['none', 'weak', 'mixed', undefined, null].includes(profile.onlinePresenceStrength);
  const noReviewSignal = !JSON.stringify([profile.signals, intel?.reviewThemes]).match(/review|stars?|rating|customer/i);
  const bookingNeed = JSON.stringify([profile.needs, intel?.missingCustomerInfo, intel?.currentWebsiteIssues]).match(/book|schedule|appointment|quote|form|contact|cta/i);
  const noBookingSignal = bookingNeed || !JSON.stringify([profile.signals, profile.whatTheyDo]).match(/book|schedule|appointment|quote|form/i);

  if (!hasWebsite || weakPresence) {
    plan.localSeoGaps.push(item({
      id: 'local-seo-owned-surface',
      title: hasWebsite ? 'Strengthen owned local landing page' : 'Create an owned local landing page',
      why: hasWebsite ? 'The public profile still shows local search gaps.' : 'Research did not prove a strong owned website presence.',
      action: 'Publish or improve a service-area page with NAP, services, hours, and LocalBusiness structured data.',
      priority: 'high',
      evidenceIds: bestEvidence(evidenceIds, ['website', 'issue', 'missing', 'profile'])
    }));
  }

  for (const [index, gap] of (intel?.competitorComparison || []).slice(0, 2).entries()) {
    plan.localSeoGaps.push(item({
      id: `lead-intel-competitor-gap-${index + 1}`,
      title: gap.title || 'Close competitor positioning gap',
      why: gap.summary || gap.claim,
      action: 'Turn this gap into page copy, proof blocks, and Google Business Profile/service-area copy.',
      priority: 'high',
      evidenceIds: bestEvidence(evidenceIds, [...(gap.evidenceIds || []), 'competitor', 'website'])
    }));
  }

  plan.googleBusinessProfileTasks.push(item({
    id: 'gbp-complete-profile',
    title: 'Complete Google Business Profile basics',
    why: 'Complete and accurate business info, hours, reviews, and photos are operational local-search foundations.',
    action: 'Check category, services, address/service area, phone, website URL, photos, and current hours.',
    priority: 'high',
    evidenceIds: bestEvidence(evidenceIds, ['profile', 'presence'])
  }));
  if (hoursUnknown) {
    plan.googleBusinessProfileTasks.push(item({
      id: 'gbp-hours-special-hours',
      title: 'Verify regular and special hours',
      why: 'Research did not capture reliable hours.',
      action: 'Confirm regular hours and add special holiday/closure hours where applicable.',
      priority: 'medium',
      evidenceIds: bestEvidence(evidenceIds, ['profile'])
    }));
  }

  if (noReviewSignal) {
    plan.reviewCapturePlan.push(item({
      id: 'reviews-request-flow',
      title: 'Add a review request flow',
      why: 'The current evidence does not show an active review capture loop.',
      action: 'Create a simple post-service message asking satisfied customers for a review without incentives or pressure.',
      priority: 'medium',
      evidenceIds: bestEvidence(evidenceIds, ['profile', 'mail'])
    }));
  } else if (intel?.reviewThemes?.length) {
    plan.reviewCapturePlan.push(item({
      id: 'reviews-use-existing-themes',
      title: 'Turn review themes into proof blocks',
      why: intel.reviewThemes.slice(0, 2).map((theme) => theme.summary || theme.claim).join(' | '),
      action: 'Add a lightweight review/proof section and ask future happy customers around the same themes.',
      priority: 'medium',
      evidenceIds: bestEvidence(evidenceIds, [...intel.reviewThemes.flatMap((theme) => theme.evidenceIds || []), 'review'])
    }));
  }

  if (noBookingSignal) {
    plan.bookingContactFlowPlan.push(item({
      id: 'contact-booking-path',
      title: 'Make the contact path explicit',
      why: 'Research does not prove a reliable booking, quote, or contact flow.',
      action: 'Add one primary call-to-action for calls, quote requests, or appointment booking.',
      priority: 'high',
      evidenceIds: bestEvidence(evidenceIds, ['profile', 'call'])
    }));
  }

  plan.analyticsSetup.push(item({
    id: 'analytics-baseline',
    title: 'Set up traffic and conversion measurement',
    why: 'The delivered site needs a baseline for calls, contact submissions, and growth follow-up.',
    action: 'Install analytics and track phone/contact CTA clicks, form submissions, and traffic sources.',
    priority: 'medium',
    evidenceIds: bestEvidence(evidenceIds, ['delivery', 'profile'])
  }));

  plan.contentIdeas.push(item({
    id: 'content-service-faq',
    title: 'Publish service and FAQ content',
    why: 'The business can answer common buyer questions before a call.',
    action: 'Add short service sections, city/service-area copy, and answers to top customer questions.',
    priority: 'medium',
    evidenceIds: bestEvidence(evidenceIds, ['call', 'mail', 'profile'])
  }));

  plan.monthlyMaintenancePlan.push(item({
    id: 'maintenance-monthly-hygiene',
    title: 'Monthly profile and site hygiene',
    why: 'Local businesses need recurring hours, photos, services, review responses, and content checks.',
    action: 'Run a monthly check for broken links, hours changes, new photos, review response backlog, and analytics anomalies.',
    priority: 'low',
    evidenceIds: bestEvidence(evidenceIds, ['profile', 'delivery'])
  }));

  plan.automationIdeas.push(item({
    id: 'automation-missed-lead-followup',
    title: 'Automate missed-lead follow-up',
    why: 'A lightweight follow-up loop can catch quote, booking, or contact requests that would otherwise wait.',
    action: 'Route contact-form and email replies into a same-thread response workflow with operator handoff for unsupported asks.',
    priority: 'medium',
    evidenceIds: bestEvidence(evidenceIds, ['mail', 'call'])
  }));

  applyUnsupportedSignals(plan, context.unsupportedSignals, evidenceIds);
  return plan;
}

export function normalizeGrowthPlan(input, { lead, context }) {
  const plan = {
    ...emptyGrowthPlan({ leadId: lead.id }),
    ...(input && typeof input === 'object' ? input : {})
  };
  plan.schemaVersion = 'growth_plan.v1';
  plan.leadId = lead.id;
  plan.generatedAt = cleanText(plan.generatedAt) || new Date().toISOString();
  plan.evidence = normalizeEvidence(plan.evidence, context.evidence, lead);
  const validEvidence = new Set(plan.evidence.map((entry) => entry.id));
  const fallback = plan.evidence[0]?.id;

  for (const section of PLAN_SECTION_KEYS) {
    plan[section] = normalizeRecommendations(plan[section], section, validEvidence, fallback);
  }

  const text = JSON.stringify({ plan, unsupported: context.unsupportedSignals });
  const unsupported = new Set(Array.isArray(plan.unsupportedFlags) ? plan.unsupportedFlags.map(safeCode) : []);
  const legalFinancialAdviceRequested = Boolean(plan.risk?.legalFinancialAdviceRequested) || UNSUPPORTED_RE.test(text);
  const seoGuaranteeRequested = Boolean(plan.risk?.seoGuaranteeRequested) || SEO_GUARANTEE_RE.test(text);
  if (legalFinancialAdviceRequested) unsupported.add('legal_financial_or_contract_advice_requested');
  if (seoGuaranteeRequested) unsupported.add('seo_or_revenue_guarantee_requested');
  for (const signal of context.unsupportedSignals || []) unsupported.add(signal.code);

  plan.unsupportedFlags = [...unsupported].filter(Boolean);
  plan.risk = {
    legalFinancialAdviceRequested,
    seoGuaranteeRequested,
    handoffRequired: Boolean(plan.risk?.handoffRequired) || plan.unsupportedFlags.length > 0,
    notes: unique([
      ...(Array.isArray(plan.risk?.notes) ? plan.risk.notes : []),
      ...plan.unsupportedFlags.map((flag) => `Unsupported autonomous growth request: ${flag}`)
    ].map((note) => cleanText(note)).filter(Boolean)).slice(0, 8)
  };

  return plan;
}

function normalizeRecommendations(items, section, validEvidence, fallback) {
  const raw = Array.isArray(items) ? items : [];
  return raw.map((entry, index) => {
    const evidenceIds = unique((Array.isArray(entry?.evidenceIds) ? entry.evidenceIds : [])
      .filter((id) => validEvidence.has(id)));
    if (!evidenceIds.length && fallback) evidenceIds.push(fallback);
    return {
      id: safeCode(entry?.id) || `${section}-${index + 1}`,
      title: cleanText(entry?.title) || titleFromSection(section),
      why: cleanText(entry?.why) || 'Recommended from the captured lead evidence.',
      action: cleanText(entry?.action) || 'Review with the operator before sending to the customer.',
      priority: ['high', 'medium', 'low'].includes(entry?.priority) ? entry.priority : 'medium',
      evidenceIds,
      unsupported: Boolean(entry?.unsupported)
    };
  }).filter((entry) => entry.evidenceIds.length);
}

function normalizeEvidence(modelEvidence, contextEvidence, lead) {
  const out = [];
  const add = (entry) => {
    if (!entry) return;
    const id = safeCode(entry.id) || `evidence-${out.length + 1}`;
    if (out.some((row) => row.id === id)) return;
    const summary = cleanText(entry.summary, { max: 240 });
    if (!summary) return;
    out.push({
      id,
      source: cleanText(entry.source, { max: 80 }) || 'lead',
      summary,
      url: cleanText(entry.url, { max: 500 }) || null,
      confidence: clamp01(entry.confidence ?? 0.7)
    });
  };
  for (const entry of contextEvidence || []) add(entry);
  for (const entry of Array.isArray(modelEvidence) ? modelEvidence : []) add(entry);
  if (!out.length) return fallbackEvidence(lead);
  return out.slice(0, 24);
}

function collectEvidence({ lead, profile, postMortem, mailDocs, contacts, calls: callRows }) {
  const out = [];
  addEvidence(out, {
    id: 'lead-profile',
    source: 'lead research',
    summary: `${lead.business_name} is a ${lead.niche || 'local business'} in ${lead.city || 'the local area'}; presence is ${profile.onlinePresenceStrength || lead.online_presence_strength || 'unknown'}.`,
    url: profile.sourceUrl || profile.yelpUrl || lead.source_url || null,
    confidence: profile.presenceConfidence || lead.presence_confidence || 0.7
  });
  if (profile.onlinePresenceSummary) addEvidence(out, {
    id: 'presence-summary',
    source: 'research summary',
    summary: profile.onlinePresenceSummary,
    url: profile.websiteUrl || lead.website || profile.sourceUrl || null,
    confidence: profile.onlinePresenceConfidence || profile.presenceConfidence || 0.7
  });
  const intel = compactLeadIntelligence(profile.leadIntelligence, { evidenceLimit: 16 });
  for (const item of intel?.evidence || []) {
    addEvidence(out, {
      id: item.id,
      source: item.source || item.sourceType || 'lead intelligence',
      summary: item.claim || item.quote || item.id,
      url: item.sourceUrl || null,
      confidence: item.confidence ?? 0.72
    });
  }
  for (const item of [
    ...(intel?.reviewThemes || []),
    ...(intel?.competitorComparison || []),
    ...(intel?.currentWebsiteIssues || []),
    ...(intel?.missingCustomerInfo || [])
  ]) {
    addEvidence(out, {
      id: item.id,
      source: 'lead intelligence',
      summary: item.summary || item.claim || item.title,
      url: item.sourceUrls?.[0] || null,
      confidence: item.confidence ?? 0.74
    });
  }
  if (intel?.bestCtaRecommendation) addEvidence(out, {
    id: intel.bestCtaRecommendation.id || 'best-cta',
    source: 'lead intelligence',
    summary: intel.bestCtaRecommendation.summary || intel.bestCtaRecommendation.claim,
    url: intel.bestCtaRecommendation.sourceUrls?.[0] || profile.sourceUrl || null,
    confidence: intel.bestCtaRecommendation.confidence ?? 0.74
  });
  if (profile.hours) addEvidence(out, {
    id: 'profile-hours',
    source: 'business profile',
    summary: `Hours evidence: ${profile.hours}`,
    url: profile.sourceUrl || null,
    confidence: 0.65
  });
  if (postMortem?.customerQuestions?.length) addEvidence(out, {
    id: 'call-customer-questions',
    source: 'call analysis',
    summary: `Customer questions: ${postMortem.customerQuestions.slice(0, 3).join(' | ')}`,
    url: null,
    confidence: 0.8
  });
  if (postMortem?.reason) addEvidence(out, {
    id: 'call-outcome',
    source: 'post-call analysis',
    summary: postMortem.reason,
    url: null,
    confidence: 0.78
  });
  for (const event of contacts.slice(0, 6)) {
    addEvidence(out, {
      id: `mail-${safeCode(event.type)}-${safeCode(event.direction)}-${out.length}`,
      source: 'AgentMail thread',
      summary: `${event.direction} ${event.type}: ${event.subject || event.body || 'message recorded'}`.slice(0, 240),
      url: null,
      confidence: event.direction === 'inbound' ? 0.8 : 0.65
    });
  }
  for (const row of callRows.slice(0, 2)) {
    addEvidence(out, {
      id: `call-${safeCode(row.outcome || row.state || row.id)}`,
      source: 'call record',
      summary: `Call ${row.state || 'recorded'}${row.outcome ? ` with outcome ${row.outcome}` : ''}.`,
      url: null,
      confidence: 0.7
    });
  }
  for (const doc of mailDocs.slice(0, 3)) {
    addEvidence(out, {
      id: `memory-mail-${out.length}`,
      source: 'Supermemory mail_thread',
      summary: `${doc.direction || 'message'}: ${doc.subject || doc.body || 'mail memory'}`.slice(0, 240),
      url: null,
      confidence: 0.72
    });
  }
  addEvidence(out, {
    id: 'delivery-status',
    source: 'delivery state',
    summary: `Lead status is ${lead.status || 'unknown'}${lead.website ? `; website ${lead.website}` : ''}.`,
    url: lead.website || null,
    confidence: 0.7
  });
  return out;
}

function addEvidence(out, entry) {
  const id = safeCode(entry.id);
  if (!id || out.some((row) => row.id === id)) return;
  const summary = cleanText(entry.summary, { max: 240 });
  if (!summary) return;
  out.push({ ...entry, id, summary, confidence: clamp01(entry.confidence ?? 0.7) });
}

function fallbackEvidence(lead) {
  return [{
    id: 'lead-profile',
    source: 'lead record',
    summary: `${lead.business_name || 'The business'} has a local-business lead record but limited growth evidence.`,
    url: lead.source_url || lead.website || null,
    confidence: 0.5
  }];
}

function latestAnalystDetail() {
  return null;
}

function applyUnsupportedSignals(plan, signals, evidenceIds) {
  if (!signals.length) return;
  const fallback = evidenceIds[0] || plan.evidence[0]?.id;
  for (const signal of signals) {
    plan.unsupportedFlags.push(signal.code);
  }
  plan.automationIdeas.push(item({
    id: 'automation-human-handoff',
    title: 'Route unsupported asks to a human',
    why: 'The customer thread contains unsupported advice or guarantee language.',
    action: 'Pause autonomous growth replies and hand the thread to the operator.',
    priority: 'high',
    evidenceIds: fallback ? [fallback] : [],
    unsupported: true
  }));
  plan.risk.handoffRequired = true;
}

function unsupportedSignals(text) {
  const signals = [];
  if (/\b(legal|lawyer|attorney|contract|tax|cpa)\b/i.test(text)) {
    signals.push({ code: 'legal_financial_or_contract_advice_requested' });
  }
  if (SEO_GUARANTEE_RE.test(text)) {
    signals.push({ code: 'seo_or_revenue_guarantee_requested' });
  }
  return signals;
}

function item({ id, title, why, action, priority = 'medium', evidenceIds, unsupported = false }) {
  return { id, title, why, action, priority, evidenceIds: unique(evidenceIds), unsupported };
}

function bestEvidence(evidenceIds, preferredTerms) {
  const terms = preferredTerms.map((term) => String(term).toLowerCase());
  const preferred = evidenceIds.filter((id) => terms.some((term) => id.includes(term)));
  return (preferred.length ? preferred : evidenceIds).slice(0, 3);
}

async function writeGrowthMemory(lead, plan, offers, growthPlanId) {
  try {
    await addDoc(lead.container_tag || containerTagFor(lead.id), 'growth_plan', {
      plan,
      offers,
      storedAt: new Date().toISOString()
    }, {
      growthPlanId,
      businessName: lead.business_name,
      nextRecommendedService: offers.nextRecommendedService?.id,
      unsupportedFlags: plan.unsupportedFlags,
      schemaVersion: plan.schemaVersion
    });
    emit('growth.memory_stored', { worker: 'growth', leadId: lead.id, growthPlanId, kind: 'growth_plan' });
  } catch (err) {
    log.warn('growth.memory.add_failed', { leadId: lead.id, error: err?.message || String(err) });
    emit('growth.memory_skipped', { worker: 'growth', leadId: lead.id, growthPlanId, reason: err?.message || String(err) });
  }
}

function parseDoc(doc) {
  if (!doc) return null;
  const raw = doc.content ?? doc.body ?? doc.text ?? '';
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function stableHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 18);
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function titleFromSection(section) {
  return section.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function cleanText(value, { max = 500 } = {}) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeCode(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n));
}
