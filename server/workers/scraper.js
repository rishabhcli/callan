import { BrowserUse } from 'browser-use-sdk/v3';
import { emit } from '../sse.js';
import { leads, runs } from '../db.js';
import { log } from '../logger.js';
import { env } from '../env.js';
import { generateJson } from '../gemini.js';
import { addDoc, containerTagFor } from '../memory.js';
import { BusinessProfileSchema, CandidateListSchema } from '../types.js';
import { queueLeadForOutreach } from '../outreach.js';

const MOCK_SYSTEM = 'You invent plausible small-business records for hackathon demos. Match the requested niche and city exactly. Never repeat names. Evaluate online presence strength honestly. Output ONLY JSON matching the provided schema.';
const NORMALIZE_SYSTEM = 'Normalize raw research into a BusinessProfile. Evaluate whether the business has no, weak, mixed, or strong online presence. Capture what the business does, what it likely needs, a phone number, owner/customer persona clues, and evidence. Never invent a website URL or contact email. Output ONLY JSON matching the provided schema.';

export async function runScraper({ niche, city, count = 4 }) {
  const runId = `run_${Date.now().toString(36)}`;
  runs.start({ id: runId, lead_id: null, worker: 'scraper' });
  emit('scraper.start', { worker: 'scraper', niche, city, count, runId });

  try {
    const mode = pickMode();
    log.info('scraper.mode', { mode, niche, city, count, runId });

    const profiles = mode === 'live'
      ? await discoverLive({ niche, city, count, runId })
      : await discoverMock({ niche, city, count, runId });

    const created = [];
    for (const profile of profiles) {
      const leadId = `lead_${Math.random().toString(36).slice(2, 11)}`;
      const containerTag = containerTagFor(leadId);
      leads.insert({
        id: leadId,
        container_tag: containerTag,
        business_name: profile.businessName,
        phone: profile.phone,
        address: profile.address,
        niche: profile.niche,
        city: profile.city,
        website: profile.websiteUrl || null,
        status: 'discovered',
        research_status: 'complete',
        outreach_status: 'not_queued',
        risk_status: 'pending',
        consent_status: 'public_business',
        phone_classification: profile.phone ? 'business' : 'invalid',
        next_action: 'classify_outreach',
        source_url: profile.sourceUrl || profile.yelpUrl || null
      });
      await addDoc(containerTag, 'profile', profile, {
        businessName: profile.businessName,
        niche: profile.niche,
        city: profile.city
      });
      const outreach = queueLeadForOutreach({ leadId, profile });
      emit('lead.created', {
        worker: 'scraper',
        runId,
        leadId,
        containerTag,
        businessName: profile.businessName,
        phone: profile.phone,
        niche: profile.niche,
        city: profile.city,
        onlinePresenceStrength: profile.onlinePresenceStrength,
        outreachStatus: outreach?.queued ? 'queued' : 'blocked'
      });
      created.push({ leadId, containerTag, profile });
    }

    runs.finish(runId, { state: 'completed', detail: { leadCount: created.length, mode } });
    emit('scraper.done', { worker: 'scraper', runId, count: created.length, mode });
    return { runId, leads: created };
  } catch (err) {
    runs.finish(runId, { state: 'failed', error: err.message });
    emit('scraper.error', { worker: 'scraper', runId, error: err.message });
    throw err;
  }
}

function pickMode() {
  if (env.runMode === 'live' && env.browserUse.apiKey) return 'live';
  return 'mock';
}

async function discoverMock({ niche, city, count, runId }) {
  emit('scraper.candidates', { worker: 'scraper', runId, source: 'gemini-mock', requested: count });
  const candidates = await generateJson({
    prompt: candidatePrompt({ niche, city, count }),
    schema: CandidateListSchema,
    systemInstruction: MOCK_SYSTEM,
    thinkingLevel: 'low',
    flash: true
  });
  const list = (candidates?.candidates || []).slice(0, count);
  emit('scraper.candidates.done', { worker: 'scraper', runId, found: list.length });

  const profiles = [];
  for (const c of list) {
    const profile = await generateJson({
      prompt: mockProfilePrompt({ niche, city, candidate: c }),
      schema: BusinessProfileSchema,
      systemInstruction: MOCK_SYSTEM,
      thinkingLevel: 'low',
      flash: true
    });
    const normalized = enforceProfile(profile, { niche, city, forceWeakPresence: true });
    profiles.push(normalized);
    emit('scraper.profile', { worker: 'scraper', runId, businessName: normalized.businessName });
  }
  return profiles;
}

async function discoverLive({ niche, city, count, runId }) {
  const client = new BrowserUse({ apiKey: env.browserUse.apiKey });
  const session = await client.sessions.create({ keepAlive: true });
  emit('scraper.session', { worker: 'scraper', runId, sessionId: session.id, liveUrl: session.liveUrl || null });

  try {
    const listTask = client.run(listTaskPrompt({ niche, city, count }), { sessionId: session.id });
    const listResult = await listTask;
    const rawList = String(listResult?.output || '').slice(0, 8000);
    emit('scraper.candidates.done', { worker: 'scraper', runId, length: rawList.length });

    const candidates = await generateJson({
      prompt: `Extract up to ${count} business candidates from this Yelp listing dump. Drop any that already show a website link in their Yelp card. Source text follows between BEGIN/END markers.\n\nBEGIN\n${rawList}\nEND`,
      schema: CandidateListSchema,
      systemInstruction: NORMALIZE_SYSTEM,
      thinkingLevel: 'low',
      flash: true
    });
    const shortlist = (candidates?.candidates || []).slice(0, count);

    const profiles = [];
    for (const c of shortlist) {
      const detailTask = client.run(detailTaskPrompt({ candidate: c, niche, city }), { sessionId: session.id });
      const detailResult = await detailTask;
      const rawDetail = String(detailResult?.output || '').slice(0, 8000);

      const profile = await generateJson({
        prompt: `Normalize this Yelp business page dump into a BusinessProfile. Listed business name hint: ${c.businessName}. Niche: ${niche}. City: ${city}. Source text:\n\nBEGIN\n${rawDetail}\nEND`,
        schema: BusinessProfileSchema,
        systemInstruction: NORMALIZE_SYSTEM,
        thinkingLevel: 'low',
        flash: true
      });
      const normalized = enforceProfile(profile, { niche, city, forceWeakPresence: false });
      profiles.push(normalized);
      emit('scraper.profile', {
        worker: 'scraper',
        runId,
        businessName: normalized.businessName,
        onlinePresenceStrength: normalized.onlinePresenceStrength
      });
    }
    return profiles;
  } finally {
    try {
      await client.sessions.stop(session.id);
      emit('scraper.session.stopped', { worker: 'scraper', runId, sessionId: session.id });
    } catch (stopErr) {
      log.warn('scraper.session.stop_failed', { runId, message: stopErr.message });
    }
  }
}

function enforceProfile(profile, { niche, city, forceWeakPresence }) {
  const signals = Array.isArray(profile?.signals) ? profile.signals.slice(0, 8) : [];
  const needs = Array.isArray(profile?.needs) ? profile.needs.slice(0, 6) : [];
  const strength = ['none', 'weak', 'mixed', 'strong'].includes(profile?.onlinePresenceStrength)
    ? profile.onlinePresenceStrength
    : (forceWeakPresence ? 'weak' : 'mixed');
  return {
    businessName: profile?.businessName || 'Unknown business',
    phone: profile?.phone || null,
    address: profile?.address || null,
    city: profile?.city || city,
    niche: profile?.niche || niche,
    hasWebsite: forceWeakPresence ? false : Boolean(profile?.hasWebsite),
    websiteUrl: forceWeakPresence ? null : (profile?.websiteUrl || null),
    onlinePresenceStrength: forceWeakPresence ? 'weak' : strength,
    onlinePresenceSummary: profile?.onlinePresenceSummary || summarizePresence({ strength: forceWeakPresence ? 'weak' : strength, profile }),
    ownerHypothesis: profile?.ownerHypothesis || null,
    customerPersona: profile?.customerPersona || null,
    hours: profile?.hours || null,
    whatTheyDo: profile?.whatTheyDo || `${niche} in ${city}`,
    needs: needs.length ? needs : defaultNeeds(profile, niche),
    signals,
    bestContactEmail: profile?.bestContactEmail || null,
    yelpUrl: profile?.yelpUrl || null,
    sourceUrl: profile?.sourceUrl || null
  };
}

function candidatePrompt({ niche, city, count }) {
  return `Invent ${count} plausible independently-owned ${niche} businesses in ${city} whose online presence is weak or mixed, even if they have a sparse listing or old social page. Mix neighborhood-specific names (avoid generic "Downtown X" stuff). For each, include a realistic local-area phone with the right area code, a street address in a real ${city} neighborhood, and a short ownerHypothesis hint if obvious from the name. Return the CandidateList schema.`;
}

function mockProfilePrompt({ niche, city, candidate }) {
  return `Expand this candidate into a full BusinessProfile. The business is a ${niche} in ${city}. Set hasWebsite=false, websiteUrl=null, onlinePresenceStrength="weak", and explain the weak online presence. Fill whatTheyDo (1-2 sentences), needs (3-5 concrete website/business needs), customerPersona, and signals (3-6 short tags like "cash-only", "instagram-active", "old-school", "owner-operated"). Candidate JSON:\n\n${JSON.stringify(candidate)}`;
}

function listTaskPrompt({ niche, city, count }) {
  return [
    `Open https://www.yelp.com and search for "${niche}" in "${city}".`,
    `Scroll through the first results page and pick up to ${count} small, independent businesses.`,
    `Audit online presence strength. Prefer businesses with no website, an outdated/sparse website, weak search presence, weak social proof, or listings that do not clearly explain what they do.`,
    `For each pick, capture: business name, Yelp listing URL, phone number, neighborhood/address line, website/social clues, review/signaling clues, and why the online presence is weak/mixed/strong.`,
    `Return a compact plain-text list, one business per block, fields labeled. Do not summarize — just dump the fields.`
  ].join(' ');
}

function detailTaskPrompt({ candidate, niche, city }) {
  const target = candidate?.yelpUrl || `${candidate?.businessName || ''} ${niche} ${city} site:yelp.com`;
  return [
    `Open the Yelp business page for: ${target}.`,
    `Read the "Business Info" / sidebar panel and any public page text that describes the business.`,
    `Capture: exact business name, full phone number, full street address, hours if shown, whether a business website/social page exists (and the URL if visible), owner/persona clues, what the business actually does, what customers likely need to know before visiting, and 3-6 signal tags (categories, claims like "Family-owned", "Established in YYYY", "Cash only", "Walk-ins welcome").`,
    `Give an onlinePresenceStrength of none, weak, mixed, or strong with a one-sentence evidence summary.`,
    `Return labeled plain text. If there is no website link in the sidebar, say "Business website: none".`
  ].join(' ');
}

function summarizePresence({ strength, profile }) {
  const hasWebsite = Boolean(profile?.websiteUrl || profile?.hasWebsite);
  if (strength === 'strong') return 'Strong public presence with enough online detail for customers to understand and contact the business.';
  if (strength === 'mixed') return hasWebsite
    ? 'Some online presence exists, but the offer, proof, or conversion path is not clearly packaged.'
    : 'Directory listings exist, but there is no clear owned website presence.';
  if (strength === 'none') return 'No meaningful owned online presence found from the available research.';
  return 'Weak online presence: customers can find a listing, but the business story, services, proof, and booking path need clearer packaging.';
}

function defaultNeeds(profile, niche) {
  const needs = [
    `clear explanation of ${profile?.whatTheyDo || `${niche} services`}`,
    'tap-to-call contact path',
    'hours, location, and trust signals'
  ];
  if (!profile?.hasWebsite) needs.unshift('owned website');
  return needs.slice(0, 6);
}
