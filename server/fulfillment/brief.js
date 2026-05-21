import { payments, contactEvents, commercePlans } from '../db.js';
import { generateStructured } from '../reasoning/geminiReasoner.js';
import { WebsiteBrief } from '../reasoning/schemas.js';
import { log } from '../logger.js';
import { compactLeadIntelligence, evidenceTraceText } from '../research/leadIntelligence.js';

export async function buildFulfillmentBrief({ lead, profileDoc, postMortemDoc } = {}) {
  if (!lead) throw new Error('build brief requires a lead');

  const profile = parseDocContent(profileDoc) || parseDocContent(lead.research_json);
  const postMortem = parseDocContent(postMortemDoc);
  const latestPayment = payments.listByLead(lead.id)[0];
  const latestCommerce = commercePlans.getLatest(lead.id)?.plan || null;
  const niche = (lead.niche || profile?.niche || 'local services').toLowerCase();
  const style = pickStyle(niche);
  const context = buildBriefContext({ lead, profile, postMortem, latestPayment, latestCommerce, niche, style });
  const prompt = buildFulfillmentPromptRequest(context);

  try {
    const { output, trace } = await generateStructured({
      kind: 'websiteBrief',
      schema: WebsiteBrief,
      evidence: context,
      prompt,
      leadId: lead.id,
      worker: 'builder',
      eventId: `brief:${lead.id}:${latestPayment?.id || 'no_payment'}`,
      thinkingLevel: 'medium'
    });
    const trimmed = websiteBriefToFulfillmentPrompt(output, context, trace).trim();
    if (trimmed.length > 50) return trimmed;
  } catch (err) {
    log.warn('builder brief gemini failed; using fallback', { error: err?.message || String(err) });
  }

  return fallbackBrief(context);
}

function websiteBriefToFulfillmentPrompt(decision, ctx, trace) {
  if (!decision?.brief) return fallbackBrief(ctx);
  const sections = (decision.sections || [])
    .map((section) => `${section.name}: ${section.goal} ${section.content.join('; ')}`)
    .join(' ');
  return [
    decision.brief,
    sections ? `Sections: ${sections}` : '',
    `Style: ${decision.style?.tone || ctx.style.tone}; ${decision.style?.palette || ctx.style.palette}; ${decision.style?.layout || ctx.style.layout}.`,
    decision.customerQuestions?.length ? `Answer customer questions: ${decision.customerQuestions.join('; ')}.` : '',
    decision.omittedClaims?.length ? `Do not include unsupported claims: ${decision.omittedClaims.join(', ')}.` : 'Do not include unsupported claims, fake reviews, guarantees, unconfirmed staff names, or unverified booking integrations.',
    trace?.id ? `Internal reasoning trace: ${trace.id}.` : ''
  ].filter(Boolean).join(' ');
}

export function buildBriefContext({ lead, profile, postMortem, latestPayment, latestCommerce, niche, style }) {
  const city = firstText(lead.city, profile?.city, 'the local area');
  const phone = firstText(lead.phone, profile?.phone, 'use a visible phone placeholder');
  const hours = firstText(profile?.hours, 'Hours not confirmed');
  const address = firstText(profile?.address, lead.address, null);
  const services = pickServices({ profile, niche });
  const needs = listItems(profile?.needs, 5, ['clear service menu', 'trust proof', 'tap-to-call contact path']);
  const agentMailQuestions = collectAgentMailQuestions(lead.id, postMortem);
  const postCall = postCallSummary(postMortem);
  const leadIntelligence = compactLeadIntelligence(profile?.leadIntelligence, { evidenceLimit: 10 });

  return {
    lead,
    profile,
    postMortem,
    latestPayment,
    niche,
    style,
    businessName: firstText(lead.business_name, profile?.businessName, 'this business'),
    city,
    phone,
    hours,
    address,
    services,
    needs,
    agentMailQuestions,
    postCall,
    commerce: commerceBriefSummary(latestCommerce),
    invoice: invoiceSummary(latestPayment, postMortem),
    research: researchSummary(profile),
    leadIntelligence,
    evidenceTrace: leadIntelligence ? evidenceTraceText(leadIntelligence, { limit: 8 }) : '',
    customer: customerSummary(profile, postMortem)
  };
}

export function buildFulfillmentPromptRequest(ctx) {
  return [
    'Create the final build prompt for a paid small-business website fulfillment target.',
    'Keep it 180-260 words. Be concrete, brief, and implementation-ready.',
    'Use only the confirmed facts below. Do not invent services, hours, reviews, guarantees, booking integrations, pricing, or staff names.',
    'Make it read as one prompt a website builder can execute, with compact labeled lines allowed.',
    '',
    `Business: ${ctx.businessName}`,
    `Niche/location: ${ctx.niche} in ${ctx.city}`,
    `Research findings: ${ctx.research}`,
    ctx.leadIntelligence?.callOpener?.text ? `Evidence-based call opener that sold the fit: ${ctx.leadIntelligence.callOpener.text}` : null,
    ctx.leadIntelligence?.reviewThemes?.length ? `Review/customer themes to reflect: ${ctx.leadIntelligence.reviewThemes.map((item) => item.summary || item.claim).join('; ')}` : null,
    ctx.leadIntelligence?.currentWebsiteIssues?.length ? `Website issues to fix: ${ctx.leadIntelligence.currentWebsiteIssues.map((item) => item.summary || item.claim).join('; ')}` : null,
    ctx.leadIntelligence?.missingCustomerInfo?.length ? `Missing info customers need: ${ctx.leadIntelligence.missingCustomerInfo.map((item) => item.summary || item.claim).join('; ')}` : null,
    ctx.leadIntelligence?.bestCtaRecommendation ? `Recommended CTA: ${ctx.leadIntelligence.bestCtaRecommendation.summary || ctx.leadIntelligence.bestCtaRecommendation.claim}.` : null,
    ctx.evidenceTrace ? `Evidence/source ids: ${ctx.evidenceTrace}` : null,
    `Phone/hours/address: phone ${ctx.phone}; hours ${ctx.hours}; address ${ctx.address || 'not confirmed'}`,
    `Services to feature: ${ctx.services.join('; ')}`,
    `Confirmed needs: ${ctx.needs.join('; ')}`,
    `Likely customers/persona: ${ctx.customer}`,
    `Style direction: ${ctx.style.tone}; ${ctx.style.palette}; ${ctx.style.layout}`,
    `Customer questions from AgentMail/call: ${ctx.agentMailQuestions.length ? ctx.agentMailQuestions.join('; ') : 'none yet'}`,
    `Customer-business commerce: ${ctx.commerce}`,
    `Invoice/customer context: ${ctx.invoice}`,
    `Post-call objections/commitments: ${ctx.postCall}`,
    '',
    'Required output: only the finished website-build prompt, no analysis or preamble.'
  ].filter((line) => line !== null && line !== undefined).join('\n');
}

export function fallbackBrief(ctx) {
  return [
    `Build a concise, polished website for ${ctx.businessName}, a ${ctx.niche} business in ${ctx.city}.`,
    `Use research findings: ${ctx.research}.`,
    ctx.leadIntelligence?.reviewThemes?.length ? `Reflect review/customer themes: ${ctx.leadIntelligence.reviewThemes.map((item) => item.summary || item.claim).join('; ')}.` : null,
    ctx.leadIntelligence?.currentWebsiteIssues?.length ? `Fix website issues: ${ctx.leadIntelligence.currentWebsiteIssues.map((item) => item.summary || item.claim).join('; ')}.` : null,
    ctx.leadIntelligence?.bestCtaRecommendation ? `Use primary CTA: ${ctx.leadIntelligence.bestCtaRecommendation.summary || ctx.leadIntelligence.bestCtaRecommendation.claim}.` : null,
    `Show phone ${ctx.phone}, hours ${ctx.hours}${ctx.address ? `, and address ${ctx.address}` : ''}.`,
    `Feature services: ${ctx.services.join(', ')}.`,
    `Solve confirmed customer needs: ${ctx.needs.join(', ')}.`,
    `Style: ${ctx.style.tone}; ${ctx.style.palette}; ${ctx.style.layout}.`,
    `Include Home, Services, and Contact sections with tap-to-call and a simple inquiry form; do not imply unsupported booking or guarantees.`,
    `Answer customer questions: ${ctx.agentMailQuestions.length ? ctx.agentMailQuestions.join('; ') : 'make invoice, timing, and revision expectations clear'}.`,
    `Customer-business commerce: ${ctx.commerce}.`,
    `Invoice/customer context: ${ctx.invoice}.`,
    `Respect post-call context: ${ctx.postCall}.`
  ].filter(Boolean).join(' ');
}

function pickStyle(niche) {
  const n = niche || '';
  if (/(barber|salon|spa|nail|tattoo|hair)/i.test(n)) return { tone: 'warm and stylish', palette: 'warm neutrals with a single bold accent', layout: 'photo-led hero, service cards, visible call CTA' };
  if (/(law|legal|accountant|tax|cpa|bookkeep|paralegal|finance)/i.test(n)) return { tone: 'professional and trustworthy', palette: 'navy and white with subtle gold', layout: 'credibility-first hero, service proof, calm contact section' };
  if (/(kids|party|toy|playground|daycare|ice cream|cafe|bakery)/i.test(n)) return { tone: 'playful and friendly', palette: 'soft pastels with a punchy accent', layout: 'bright hero, visual menu, family-friendly contact flow' };
  if (/(plumb|hvac|electric|roof|contractor|landscap|auto|repair|mechanic)/i.test(n)) return { tone: 'rugged and dependable', palette: 'deep blue and safety orange on white', layout: 'service-area hero, emergency/contact CTA, trust badges' };
  return { tone: 'clean and professional', palette: 'neutral with a single brand accent', layout: 'clear hero, short service sections, sticky mobile call CTA' };
}

function pickServices({ profile, niche }) {
  const explicit = [
    ...listItems(profile?.services, 6, []),
    ...listItems(profile?.serviceList, 6, []),
    ...listItems(profile?.offerings, 6, [])
  ];
  if (explicit.length) return uniqueItems(explicit, 6);

  const needs = listItems(profile?.needs, 4, []);
  const whatTheyDo = firstText(profile?.whatTheyDo, profile?.summary, profile?.description, null);
  if (whatTheyDo) return [whatTheyDo, ...needs].slice(0, 6);

  return [`core ${niche} services`, 'consultations or estimates', 'contact and location details'];
}

function researchSummary(profile) {
  if (!profile) return 'No profile doc found; use only confirmed lead details and keep claims modest.';
  const parts = [
    compactText(`${profile.onlinePresenceStrength || 'unknown'} online presence: ${profile.onlinePresenceSummary || 'no summary captured'}`, 220),
    profile.hasWebsite === false ? 'no confirmed owned website' : null,
    profile.websiteUrl ? `existing site: ${profile.websiteUrl}` : null,
    profile.sourceUrl ? `source: ${profile.sourceUrl}` : null,
    profile.yelpUrl ? `Yelp/listing: ${profile.yelpUrl}` : null,
    listItems(profile.signals, 5, []).length ? `signals: ${listItems(profile.signals, 5, []).join(', ')}` : null,
    profile.leadIntelligence?.whyThisLeadIsWorthCalling ? `why call: ${profile.leadIntelligence.whyThisLeadIsWorthCalling.summary || profile.leadIntelligence.whyThisLeadIsWorthCalling.claim}` : null,
    profile.leadIntelligence?.bestCtaRecommendation ? `CTA: ${profile.leadIntelligence.bestCtaRecommendation.summary || profile.leadIntelligence.bestCtaRecommendation.claim}` : null
  ].filter(Boolean);
  return compactText(parts.join('; '), 420);
}

function customerSummary(profile, postMortem) {
  const parts = [
    firstText(profile?.customerPersona, null),
    firstText(profile?.ownerHypothesis, profile?.owner, null),
    firstText(postMortem?.customerCares, null)
  ].filter(Boolean);
  return parts.length ? compactText(parts.join('; '), 260) : 'local customers who need quick trust, services, hours, and a clear way to contact the business';
}

function collectAgentMailQuestions(leadId, postMortem) {
  const fromPostMortem = listItems(postMortem?.customerQuestions, 5, []);
  const fromMail = contactEvents
    .listByLead(leadId, { limit: 12 })
    .filter((e) => e.channel === 'agentmail' && e.direction === 'inbound')
    .map((e) => firstText(e.body, e.subject, null))
    .filter(Boolean)
    .map((text) => compactText(text, 180));
  return uniqueItems([...fromPostMortem, ...fromMail], 6);
}

function invoiceSummary(payment, postMortem) {
  const email = firstText(postMortem?.invoiceEmail, null);
  const emailStatus = email ? `customer email ${email}${postMortem?.confirmedEmail ? ' confirmed' : ' unconfirmed'}` : 'no customer email in post-call notes';
  if (!payment) return `${emailStatus}; no invoice row found yet`;

  const cents = Number(payment.amount_cents);
  const amount = Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : 'unknown amount';
  const invoiceId = payment.stripe_invoice_id || payment.stripe_session_id || payment.id;
  const status = payment.status || 'unknown status';
  const url = payment.hosted_invoice_url || payment.payment_link_url;
  return compactText(`invoice ${invoiceId}, ${status}, ${amount}; ${emailStatus}${url ? '; payment URL available' : ''}`, 260);
}

function commerceBriefSummary(plan) {
  if (!plan) {
    return 'No customer-business commerce plan captured; use contact/quote form only and do not invent checkout, booking, tax, refund, or policy details.';
  }
  const cta = plan.commerceCta?.label || 'Contact us';
  const stripe = plan.stripeBoundary?.requiresStripe
    ? `${plan.stripeBoundary.mode}; no public payment link unless customer-owned setup is approved`
    : 'no customer-business payment link required';
  const handoff = plan.humanHandoff?.required ? `handoff required: ${plan.humanHandoff.boundary}` : 'no hard handoff flags';
  return compactText(`${plan.type}; CTA "${cta}" as an inquiry/contact action; ${stripe}; ${handoff}; do not use Callan's $500 invoice as customer commerce.`, 520);
}

function postCallSummary(postMortem) {
  if (!postMortem) return 'No post-call notes yet; keep the site simple, transparent, and easy to revise.';

  const replayNotes = Array.isArray(postMortem.replayMoments)
    ? postMortem.replayMoments.map((m) => firstText(m?.note, m?.excerpt, null)).filter(Boolean)
    : [];
  const objections = [
    firstText(postMortem.reason, null),
    ...listItems(postMortem.whatToTryNext, 3, []),
    ...replayNotes.slice(0, 2)
  ].filter(Boolean);
  const commitments = [];
  if (postMortem.outcome === 'won') commitments.push('customer agreed to move forward after the call');
  if (postMortem.confirmedEmail && postMortem.invoiceEmail) commitments.push(`invoice email confirmed as ${postMortem.invoiceEmail}`);
  if (postMortem.followupEmailDraft) commitments.push('follow-up email was drafted');

  return compactText([
    `outcome ${postMortem.outcome || 'unknown'}`,
    objections.length ? `objections/next steps: ${uniqueItems(objections, 4).join('; ')}` : null,
    commitments.length ? `commitments: ${commitments.join('; ')}` : 'commitments not confirmed'
  ].filter(Boolean).join('; '), 420);
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

function parseDocContent(doc) {
  const c = doc?.content ?? doc;
  if (!c) return null;
  if (typeof c === 'object') return c;
  if (typeof c === 'string') {
    try { return JSON.parse(c); } catch { return { summary: c }; }
  }
  return null;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}
