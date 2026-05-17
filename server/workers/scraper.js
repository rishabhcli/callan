import { BrowserUse } from 'browser-use-sdk/v3';
import { emit } from '../sse.js';
import { leads, runs } from '../db.js';
import { log } from '../logger.js';
import { env } from '../env.js';
import { generateJson } from '../gemini.js';
import { addDoc, containerTagFor } from '../memory.js';
import { BusinessProfileSchema, CandidateListSchema } from '../types.js';

const MOCK_SYSTEM = 'You invent plausible small-business records for hackathon demos. Match the requested niche and city exactly. Never repeat names. Output ONLY JSON matching the provided schema.';
const NORMALIZE_SYSTEM = 'Normalize raw scraped text into a BusinessProfile. If the source clearly shows a website link, set hasWebsite=true; otherwise false. Never invent a website URL. Output ONLY JSON matching the provided schema.';

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
        website: null,
        status: 'discovered'
      });
      await addDoc(containerTag, 'profile', profile, {
        businessName: profile.businessName,
        niche: profile.niche,
        city: profile.city
      });
      emit('lead.created', {
        worker: 'scraper',
        runId,
        leadId,
        containerTag,
        businessName: profile.businessName,
        phone: profile.phone,
        niche: profile.niche,
        city: profile.city
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
    const normalized = enforceProfile(profile, { niche, city, forceNoWebsite: true });
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
      const normalized = enforceProfile(profile, { niche, city, forceNoWebsite: false });
      if (normalized.hasWebsite) {
        emit('scraper.profile.skipped', { worker: 'scraper', runId, businessName: normalized.businessName, reason: 'has_website' });
        continue;
      }
      profiles.push(normalized);
      emit('scraper.profile', { worker: 'scraper', runId, businessName: normalized.businessName });
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

function enforceProfile(profile, { niche, city, forceNoWebsite }) {
  const signals = Array.isArray(profile?.signals) ? profile.signals.slice(0, 8) : [];
  return {
    businessName: profile?.businessName || 'Unknown business',
    phone: profile?.phone || null,
    address: profile?.address || null,
    city: profile?.city || city,
    niche: profile?.niche || niche,
    hasWebsite: forceNoWebsite ? false : Boolean(profile?.hasWebsite),
    websiteUrl: forceNoWebsite ? null : (profile?.websiteUrl || null),
    ownerHypothesis: profile?.ownerHypothesis || null,
    hours: profile?.hours || null,
    whatTheyDo: profile?.whatTheyDo || `${niche} in ${city}`,
    signals,
    yelpUrl: profile?.yelpUrl || null,
    sourceUrl: profile?.sourceUrl || null
  };
}

function candidatePrompt({ niche, city, count }) {
  return `Invent ${count} plausible independently-owned ${niche} businesses in ${city} that would NOT have a website. Mix neighborhood-specific names (avoid generic "Downtown X" stuff). For each, include a realistic local-area phone with the right area code, a street address in a real ${city} neighborhood, and a short ownerHypothesis hint if obvious from the name. Return the CandidateList schema.`;
}

function mockProfilePrompt({ niche, city, candidate }) {
  return `Expand this candidate into a full BusinessProfile. The business is a ${niche} in ${city}. Set hasWebsite=false and websiteUrl=null (this lead has no site — that is why we're calling). Fill whatTheyDo (1-2 sentences) and signals (3-6 short tags like "cash-only", "instagram-active", "old-school", "owner-operated"). Candidate JSON:\n\n${JSON.stringify(candidate)}`;
}

function listTaskPrompt({ niche, city, count }) {
  return [
    `Open https://www.yelp.com and search for "${niche}" in "${city}".`,
    `Scroll through the first results page and pick up to ${count} small, independent businesses.`,
    `Strongly prefer entries whose Yelp card does NOT show an external "Website" link icon (we are looking for businesses without a website).`,
    `For each pick, capture: business name, Yelp listing URL, the phone number shown on the card if visible, and the neighborhood/address line.`,
    `Return a compact plain-text list, one business per block, fields labeled. Do not summarize — just dump the fields.`
  ].join(' ');
}

function detailTaskPrompt({ candidate, niche, city }) {
  const target = candidate?.yelpUrl || `${candidate?.businessName || ''} ${niche} ${city} site:yelp.com`;
  return [
    `Open the Yelp business page for: ${target}.`,
    `Read the "Business Info" / sidebar panel.`,
    `Capture: exact business name, full phone number, full street address, hours if shown, whether a "Business website" link is present (and the URL if yes), owner name if listed in "Meet the Owner" or "From the Business", and 3-6 short signal tags (categories, claims like "Family-owned", "Established in YYYY", "Cash only", "Walk-ins welcome").`,
    `Return labeled plain text. If there is no website link in the sidebar, say "Business website: none".`
  ].join(' ');
}
