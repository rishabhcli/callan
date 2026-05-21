import { BrowserUse } from 'browser-use-sdk/v3';
import { emit } from '../sse.js';
import { leads, runs } from '../db.js';
import { log } from '../logger.js';
import { canStartBrowserSession, env } from '../env.js';
import { generateJson } from '../gemini.js';
import { addDoc, containerTagFor } from '../memory.js';
import { BusinessProfileSchema, CandidateListSchema } from '../types.js';
import { queueLeadForOutreach } from '../outreach.js';
import { scoreOnlinePresence } from '../presenceScorer.js';
import { enrichBusinessProfile } from '../profileEnrichment.js';
import { browserResearchLiveEnabled, discoverBrowserUseResearchProfiles } from '../research/browserUseSwarm.js';

const MOCK_SYSTEM = 'You invent plausible small-business records for hackathon demos. Match the requested niche and city exactly. Never repeat names. Evaluate online presence strength honestly. Include services, provenance, presence evidence, leadIntelligence with cited review themes, positive proof, pain points, missing customer info, competitor gaps, website issues, listing consistency, CTA, scores, and a null notWorthCallingReason unless presence is strong. Do not invent external URLs or contact emails; use null for external URL/email fields in mock data. Output ONLY JSON matching the provided schema.';
const NORMALIZE_SYSTEM = 'Normalize raw research into a BusinessProfile. Evaluate whether the business has no, weak, mixed, or strong online presence. Capture what the business does, what it likely needs, public phone/address provenance, website/social/listing evidence, business hours, services, reasons, a 0-1 confidence score, leadIntelligence with every claim cited to source evidence/source ids, and explicit notWorthCallingReason when strong enough to block outreach. Never invent a website URL or contact email; only include URLs/emails visible in the provided source text. Output ONLY JSON matching the provided schema.';

const MAX_RAW_TEXT = 12000;
const BROWSER_TASK_TIMEOUT_MS = 240000;
const DIRECTORY_TIMEOUT_MS = 12000;
const MAX_CANDIDATE_MULTIPLIER = 4;
const PROVIDER_FAILURE_RE = /\b(401|403|408|409|429|500|502|503|504|auth|unauthori[sz]ed|forbidden|login|captcha|quota|credit|balance|rate.?limit|resource_exhausted|timeout|timed out|network|fetch failed|econn|enotfound|etimedout|eai_again)\b/i;
const WEBSITE_NONE_RE = /\b(none|not shown|not listed|no website|n\/a|missing)\b/i;
const URL_RE = /https?:\/\/[^\s)"'<>]+/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const DIRECT_HEADERS = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
};

const DIRECTORY_SOURCES = [
  {
    id: 'yelp',
    label: 'Yelp',
    kind: 'directory',
    buildUrl: ({ niche, city }) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(niche)}&find_loc=${encodeURIComponent(city)}`,
    parse: parseYelpHtml
  },
  {
    id: 'yellowpages',
    label: 'Yellow Pages',
    kind: 'directory',
    buildUrl: ({ niche, city }) => `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(niche)}&geo_location_terms=${encodeURIComponent(city)}`,
    parse: parseYellowPagesHtml
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    kind: 'search',
    buildUrl: ({ niche, city }) => `https://duckduckgo.com/html/?q=${encodeURIComponent(`${niche} ${city} local business phone address`)}`,
    parse: parseSearchHtml
  }
];

export async function runScraper({ niche, city, count = 4 }) {
  const requestedCount = clampCount(count);
  const runId = `run_${Date.now().toString(36)}`;
  runs.start({ id: runId, lead_id: null, worker: 'scraper' });
  emit('scraper.start', { worker: 'scraper', niche, city, count: requestedCount, runId });

  try {
    const mode = pickMode();
    log.info('scraper.mode', { mode, niche, city, count: requestedCount, runId });

    const discovery = normalizeDiscoveryResult(mode === 'live'
      ? await discoverLive({ niche, city, count: requestedCount, runId })
      : await discoverMock({ niche, city, count: requestedCount, runId }), mode);

    const created = [];
    const skipped = [...discovery.skipped];
    const failed = [...discovery.failed];

    for (const profile of discovery.profiles.slice(0, requestedCount)) {
      const profileSource = profile?.provenance?.profileSource || 'unknown';
      const forceWeakPresence = profileSource === 'gemini_mock' || String(discovery.mode || mode).includes('mock');
      const normalized = enforceProfile(profile, {
        niche,
        city,
        forceWeakPresence,
        sourceUrl: profile?.sourceUrl || profile?.yelpUrl || null,
        yelpUrl: profile?.yelpUrl || null,
        rawText: profile?.onlinePresenceSummary || '',
        profileSource
      });
      const skipReason = profileSkipReason(normalized);
      if (skipReason) {
        const item = reportItem(normalized, skipReason, 'lead_create');
        skipped.push(item);
        emit('scraper.item.skipped', { worker: 'scraper', runId, ...item });
        continue;
      }

      try {
        const requestedLeadId = `lead_${Math.random().toString(36).slice(2, 11)}`;
        const requestedContainerTag = containerTagFor(requestedLeadId);
        const insertResult = leads.upsertResearch({
          id: requestedLeadId,
          container_tag: requestedContainerTag,
          business_name: normalized.businessName,
          phone: normalized.phone,
          address: normalized.address,
          niche: normalized.niche,
          city: normalized.city,
          website: normalized.websiteUrl || null,
          status: 'discovered',
          research_status: 'complete',
          outreach_status: 'not_queued',
          risk_status: 'pending',
          consent_status: 'public_business',
          phone_classification: normalized.phone ? 'business' : 'invalid',
          next_action: 'classify_outreach',
          source_url: normalized.sourceUrl || normalized.yelpUrl || null,
          online_presence_strength: normalized.onlinePresenceStrength,
          presence_confidence: normalized.presenceConfidence ?? normalized.onlinePresenceConfidence ?? null,
          callable_reason: normalized.callRecommendation?.whyCall || null,
          blocked_reason: normalized.callRecommendation?.whyNotCall || normalized.notWorthCallingReason || null,
          research_json: JSON.stringify(normalized)
        }, { actor: 'scraper', profile: normalized, runId });
        const lead = insertResult.lead;
        const leadId = lead.id;
        const containerTag = lead.container_tag;
        // Lazy-import to avoid an import cycle with outreach.js (which scraper also imports).
        try {
          const { applyPriorityToLead } = await import('../leadPriority.js');
          applyPriorityToLead(leadId);
        } catch (err) {
          log.warn('scraper.priority_score_failed', { leadId, error: err?.message || String(err) });
        }
        await safeAddProfileDoc(containerTag, normalized, {
          businessName: normalized.businessName,
          niche: normalized.niche,
          city: normalized.city,
          sourceUrl: normalized.sourceUrl || normalized.yelpUrl || null,
          yelpUrl: normalized.yelpUrl || null,
          profileSource: normalized.provenance?.profileSource || 'unknown',
          allowGeneratedUrls: normalized.provenance?.profileSource === 'live_browser'
        });
        const outreach = queueLeadForOutreach({ leadId, profile: normalized });
        if (insertResult.duplicate) {
          emit('lead.duplicate', {
            worker: 'scraper',
            runId,
            leadId,
            attemptedLeadId: insertResult.attemptedId,
            duplicateReasons: insertResult.duplicateReasons,
            businessName: normalized.businessName,
            phone: normalized.phone,
            niche: normalized.niche,
            city: normalized.city,
            sourceUrl: normalized.sourceUrl || normalized.yelpUrl || null
          });
        }
        emit('lead.created', {
          worker: 'scraper',
          runId,
          leadId,
          containerTag,
          duplicate: insertResult.duplicate,
          duplicateReasons: insertResult.duplicateReasons,
          attemptedLeadId: insertResult.attemptedId,
          businessName: normalized.businessName,
          phone: normalized.phone,
          niche: normalized.niche,
          city: normalized.city,
          sourceUrl: normalized.sourceUrl || normalized.yelpUrl || null,
          onlinePresenceStrength: normalized.onlinePresenceStrength,
          outreachStatus: outreach?.queued ? 'queued' : 'blocked'
        });
        created.push({ leadId, containerTag, profile: normalized, duplicate: insertResult.duplicate });
      } catch (err) {
        const item = reportItem(normalized, err?.message || String(err), 'lead_create');
        failed.push(item);
        emit('scraper.item.failed', { worker: 'scraper', runId, ...item });
        log.warn('scraper.lead_create_failed', { runId, item });
      }
    }

    const detail = {
      leadCount: created.length,
      duplicateCount: created.filter((lead) => lead.duplicate).length,
      insertedCount: created.filter((lead) => !lead.duplicate).length,
      requestedCount,
      mode: discovery.mode || mode,
      skippedCount: skipped.length,
      failedCount: failed.length,
      skipped,
      failed,
      providerFailures: discovery.providerFailures,
      fallbackEvents: discovery.fallbackEvents
    };
    runs.finish(runId, { state: 'completed', detail });
    emit('scraper.done', {
      worker: 'scraper',
      runId,
      count: created.length,
      duplicateCount: detail.duplicateCount,
      requested: requestedCount,
      mode: detail.mode,
      skippedCount: skipped.length,
      failedCount: failed.length
    });
    return {
      runId,
      leads: created,
      skipped,
      failed,
      mode: detail.mode,
      providerFailures: discovery.providerFailures,
      fallbackEvents: discovery.fallbackEvents
    };
  } catch (err) {
    runs.finish(runId, { state: 'failed', error: err.message });
    emit('scraper.error', { worker: 'scraper', runId, error: err.message });
    throw err;
  }
}

function pickMode() {
  if (['autonomous_live', 'production_live'].includes(env.runMode) && canStartBrowserSession() && browserResearchLiveEnabled()) return 'live';
  return 'mock';
}

async function safeAddProfileDoc(containerTag, profile, metadata) {
  try {
    return await addDoc(containerTag, 'profile', profile, metadata);
  } catch (err) {
    log.warn('scraper.memory.profile_write_failed', {
      containerTag,
      businessName: profile?.businessName,
      error: err?.message || String(err)
    });
    return null;
  }
}

async function discoverMock({ niche, city, count, runId }) {
  const report = createDiscoveryReport({ mode: 'mock', runId });
  emit('scraper.candidates', { worker: 'scraper', runId, source: 'gemini-mock', requested: count });

  let list = [];
  try {
    const candidates = await generateJson({
      prompt: candidatePrompt({ niche, city, count }),
      schema: CandidateListSchema,
      systemInstruction: MOCK_SYSTEM,
      thinkingLevel: 'low',
      flash: true
    });
    list = coerceGeneratedCandidates(candidates?.candidates || [], { sourceName: 'gemini-mock' })
      .slice(0, count)
      .map((candidate, index) => withMockSource(candidate, { niche, city, index }));
  } catch (err) {
    recordProviderFailure(report, 'gemini', err, 'mock_candidates');
    addFallback(report, 'deterministic-mock', `Gemini mock candidate generation failed: ${err?.message || String(err)}`);
  }

  if (list.length < count) {
    list = mergeCandidates([
      ...list,
      ...deterministicCandidates({ niche, city, count: count - list.length, offset: list.length })
    ], { limit: count, report, phase: 'mock_fill' });
  }

  emit('scraper.candidates.done', { worker: 'scraper', runId, found: list.length, source: 'mock' });

  for (const c of list) {
    try {
      const profile = await generateJson({
        prompt: mockProfilePrompt({ niche, city, candidate: c }),
        schema: BusinessProfileSchema,
        systemInstruction: MOCK_SYSTEM,
        thinkingLevel: 'low',
        flash: true
      });
      const normalized = enforceProfile(profile, {
        niche,
        city,
        forceWeakPresence: true,
        sourceUrl: c.sourceUrl || c.yelpUrl || null,
        yelpUrl: c.yelpUrl || null,
        rawText: JSON.stringify(c),
        profileSource: 'gemini_mock',
        candidate: c,
        allowGeneratedUrls: false
      });
      report.profiles.push(normalized);
      emit('scraper.profile', { worker: 'scraper', runId, businessName: normalized.businessName, sourceUrl: normalized.sourceUrl });
    } catch (err) {
      recordProviderFailure(report, 'gemini', err, 'mock_profile');
      addFallback(report, 'deterministic-profile', `Gemini mock profile failed for ${c.businessName}: ${err?.message || String(err)}`);
      const fallback = profileFromCandidate({ candidate: c, niche, city, rawText: '', forceWeakPresence: true });
      report.profiles.push(fallback);
      emit('scraper.profile', { worker: 'scraper', runId, businessName: fallback.businessName, sourceUrl: fallback.sourceUrl, fallback: true });
    }
  }

  return report;
}

async function discoverLive({ niche, city, count, runId }) {
  const report = createDiscoveryReport({ mode: 'live', runId });
  let client = null;
  let session = null;
  let browserCandidates = [];

  try {
    const swarm = await discoverBrowserUseResearchProfiles({ niche, city, count, runId, mode: 'live' });
    mergeDiscoveryReports(report, swarm);
    if (report.profiles.length) {
      emit('scraper.candidates.done', {
        worker: 'scraper',
        runId,
        found: report.profiles.length,
        source: 'browser-use-swarm',
        browserUseCount: report.profiles.length,
        directoryCount: 0
      });
      return report;
    }
    addFallback(report, 'legacy-browser-use-search', 'Browser Use swarm returned no callable profiles.');
  } catch (err) {
    recordProviderFailure(report, 'browser-use-swarm', err, 'research_swarm');
    addFallback(report, 'legacy-browser-use-search', `Browser Use swarm failed: ${err?.message || String(err)}`);
  }

  try {
    client = new BrowserUse({
      apiKey: env.browserUse.apiKey,
      baseUrl: env.browserUse.baseUrl,
      maxRetries: 1,
      timeout: BROWSER_TASK_TIMEOUT_MS
    });
    session = await client.sessions.create({ keepAlive: true });
    emit('scraper.session', { worker: 'scraper', runId, sessionId: session.id, liveUrl: session.liveUrl || null });
    browserCandidates = await discoverBrowserUseCandidates({ client, session, niche, city, count, report });
  } catch (err) {
    recordProviderFailure(report, 'browser-use', err, 'candidate_search');
    addFallback(report, 'directory-search', `Browser Use candidate search failed: ${err?.message || String(err)}`);
  }

  const directoryCandidates = await discoverDirectoryCandidates({ niche, city, count, report });
  const candidates = mergeCandidates([...browserCandidates, ...directoryCandidates], {
    limit: Math.max(count * MAX_CANDIDATE_MULTIPLIER, count + 4),
    report,
    phase: 'candidate_merge'
  });

  emit('scraper.candidates.done', {
    worker: 'scraper',
    runId,
    found: candidates.length,
    source: 'live',
    browserUseCount: browserCandidates.length,
    directoryCount: directoryCandidates.length
  });

  for (const candidate of candidates) {
    if (report.profiles.length >= count) break;
    await hydrateLiveCandidate({ candidate, niche, city, client, session, report });
  }

  if (!report.profiles.length) {
    addFallback(report, 'mock', 'Live and directory discovery did not produce any usable profiles.');
    const mock = await discoverMock({ niche, city, count, runId });
    mergeDiscoveryReports(report, mock);
  }

  if (session?.id && client) {
    try {
      await client.sessions.stop(session.id);
      emit('scraper.session.stopped', { worker: 'scraper', runId, sessionId: session.id });
    } catch (stopErr) {
      log.warn('scraper.session.stop_failed', { runId, message: stopErr.message });
    }
  }

  return report;
}

async function discoverBrowserUseCandidates({ client, session, niche, city, count, report }) {
  const task = listTaskPrompt({ niche, city, count });
  emit('scraper.candidates', { worker: 'scraper', runId: report.runId, source: 'browser-use', requested: count });
  const result = await client.run(task, {
    sessionId: session.id,
    timeout: BROWSER_TASK_TIMEOUT_MS,
    interval: 2500
  });
  const raw = String(result?.output || '').slice(0, MAX_RAW_TEXT);
  const parsed = parseBrowserDiscoveryOutput(raw, { sourceName: 'browser-use', report, phase: 'browser_use_candidates' });
  emit('scraper.candidates.raw', {
    worker: 'scraper',
    runId: report.runId,
    source: 'browser-use',
    length: raw.length,
    parsed: parsed.candidates.length,
    skipped: parsed.skipped.length
  });
  for (const item of parsed.skipped) addSkipped(report, item, item.reason || 'Browser Use skipped candidate', 'browser_use_candidates');
  return parsed.candidates;
}

async function discoverDirectoryCandidates({ niche, city, count, report }) {
  const out = [];
  emit('scraper.candidates', { worker: 'scraper', runId: report.runId, source: 'directory-search', requested: count });

  for (const source of DIRECTORY_SOURCES) {
    const url = source.buildUrl({ niche, city });
    try {
      const html = await fetchText(url, { timeoutMs: DIRECTORY_TIMEOUT_MS });
      const parsed = source.parse(html, {
        sourceUrl: url,
        sourceName: source.label,
        sourceKind: source.kind,
        niche,
        city
      });
      emit('scraper.directory.parsed', {
        worker: 'scraper',
        runId: report.runId,
        source: source.id,
        url,
        found: parsed.length
      });
      out.push(...parsed);
    } catch (err) {
      recordProviderFailure(report, source.id, err, 'directory_search');
      addFailed(report, { sourceName: source.label, sourceUrl: url }, err, 'directory_search');
    }
  }

  return mergeCandidates(out, {
    limit: Math.max(count * MAX_CANDIDATE_MULTIPLIER, count + 4),
    report,
    phase: 'directory_merge'
  });
}

async function hydrateLiveCandidate({ candidate, niche, city, client, session, report }) {
  let rawDetail = '';
  let detailSource = candidate.sourceUrl || candidate.yelpUrl || null;

  if (client && session?.id) {
    try {
      const detailTask = client.run(detailTaskPrompt({ candidate, niche, city }), {
        sessionId: session.id,
        timeout: BROWSER_TASK_TIMEOUT_MS,
        interval: 2500
      });
      const detailResult = await detailTask;
      rawDetail = String(detailResult?.output || '').slice(0, MAX_RAW_TEXT);
      detailSource = sanitizeUrl(matchField(rawDetail, ['source url', 'public source url'])) || extractSourceUrl(rawDetail) || detailSource;
    } catch (err) {
      recordProviderFailure(report, 'browser-use', err, 'candidate_detail');
      addFailed(report, candidate, err, 'browser_use_detail');
      addFallback(report, 'direct-detail-fetch', `Browser Use detail failed for ${candidate.businessName}: ${err?.message || String(err)}`);
    }
  }

  if (!rawDetail && detailSource) {
    try {
      const html = await fetchText(detailSource, { timeoutMs: DIRECTORY_TIMEOUT_MS });
      rawDetail = htmlToText(html).slice(0, MAX_RAW_TEXT);
    } catch (err) {
      addFailed(report, candidate, err, 'direct_detail_fetch');
    }
  }

  const profile = await normalizeCandidateProfile({
    candidate: { ...candidate, sourceUrl: detailSource || candidate.sourceUrl || candidate.yelpUrl || null },
    niche,
    city,
    rawDetail,
    report
  });
  if (!profile) return;

  const skipReason = profileSkipReason(profile);
  if (skipReason) {
    addSkipped(report, profile, skipReason, 'profile_validation');
    return;
  }

  report.profiles.push(profile);
  emit('scraper.profile', {
    worker: 'scraper',
    runId: report.runId,
    businessName: profile.businessName,
    sourceUrl: profile.sourceUrl || profile.yelpUrl || null,
    onlinePresenceStrength: profile.onlinePresenceStrength
  });
}

async function normalizeCandidateProfile({ candidate, niche, city, rawDetail, report }) {
  if (rawDetail && env.gemini.apiKey) {
    try {
      const profile = await generateJson({
        prompt: liveNormalizePrompt({ candidate, niche, city, rawDetail }),
        schema: BusinessProfileSchema,
        systemInstruction: NORMALIZE_SYSTEM,
        thinkingLevel: 'low',
        flash: true
      });
      return enforceProfile(profile, {
        niche,
        city,
        forceWeakPresence: false,
        sourceUrl: candidate.sourceUrl || candidate.yelpUrl || null,
        yelpUrl: candidate.yelpUrl || null,
        rawText: rawDetail,
        profileSource: 'live_browser',
        candidate,
        allowGeneratedUrls: true
      });
    } catch (err) {
      recordProviderFailure(report, 'gemini', err, 'profile_normalize');
      addFallback(report, 'deterministic-profile', `Gemini normalization failed for ${candidate.businessName}: ${err?.message || String(err)}`);
    }
  }

  return profileFromCandidate({ candidate, niche, city, rawText: rawDetail, forceWeakPresence: false });
}

function enforceProfile(profile, {
  niche,
  city,
  forceWeakPresence,
  sourceUrl,
  yelpUrl,
  rawText = '',
  profileSource = 'unknown',
  candidate = null,
  allowGeneratedUrls
} = {}) {
  const source = profileSource !== 'unknown'
    ? profileSource
    : (profile?.provenance?.profileSource || (forceWeakPresence ? 'gemini_mock' : 'live_browser'));
  const finalSourceUrl = profile?.sourceUrl || sourceUrl || profile?.yelpUrl || yelpUrl || candidate?.sourceUrl || null;
  const finalYelpUrl = profile?.yelpUrl || yelpUrl || candidate?.yelpUrl || (isYelpUrl(finalSourceUrl) ? finalSourceUrl : null);
  const seeded = {
    ...profile,
    businessName: cleanBusinessName(profile?.businessName || candidate?.businessName || 'Unknown business'),
    city: profile?.city || city,
    niche: profile?.niche || niche,
    yelpUrl: finalYelpUrl,
    sourceUrl: finalSourceUrl,
    services: Array.isArray(profile?.services) && profile.services.length ? profile.services : defaultServices(profile, niche),
    needs: Array.isArray(profile?.needs) ? profile.needs.slice(0, 6) : [],
    signals: Array.isArray(profile?.signals) ? profile.signals.slice(0, 8) : []
  };
  const directoryOnlySource = finalSourceUrl && isDirectoryUrl(finalSourceUrl) && !seeded.websiteUrl;
  const scoreSeed = directoryOnlySource
    ? { ...seeded, sourceUrl: null, yelpUrl: null, sourceUrls: [] }
    : seeded;
  const scored = scoreOnlinePresence(scoreSeed, { rawText, forceWeakPresence });
  if (directoryOnlySource) applyDirectorySourceEvidence(scored, finalSourceUrl, finalYelpUrl);
  const { profile: enriched } = enrichBusinessProfile({ ...seeded, ...scored }, {
    niche,
    city,
    candidate,
    sourceText: rawText,
    sourceUrl: finalSourceUrl,
    yelpUrl: finalYelpUrl,
    profileSource: source,
    forceWeakPresence,
    allowGeneratedUrls: allowGeneratedUrls ?? source === 'live_browser'
  });
  return enriched;
}

function profileFromCandidate({ candidate, niche, city, rawText = '', forceWeakPresence = false }) {
  const sourceUrl = candidate.sourceUrl || candidate.yelpUrl || null;
  const websiteUrl = forceWeakPresence ? null : firstNonDirectoryUrl(
    candidate.websiteHint || extractWebsiteUrl(rawText),
    sourceUrl
  );
  const phone = candidate.phoneHint || extractPhone(rawText);
  const address = candidate.addressHint || extractAddress(rawText, city);
  const strength = forceWeakPresence
    ? 'weak'
    : inferPresenceStrength({ candidate, rawText, websiteUrl });
  const profile = {
    businessName: candidate.businessName || 'Unknown business',
    phone: phone || null,
    address: address || null,
    city,
    niche,
    hasWebsite: Boolean(websiteUrl),
    websiteUrl: websiteUrl || null,
    onlinePresenceStrength: strength,
    onlinePresenceSummary: candidate.presenceReason || summarizePresence({ strength, profile: { websiteUrl } }),
    ownerHypothesis: candidate.ownerHypothesis || null,
    customerPersona: candidate.customerPersona || null,
    hours: extractHours(rawText),
    whatTheyDo: candidate.whatTheyDo || `${candidate.businessName || 'This business'} appears to provide ${niche} services in ${city}.`,
    needs: defaultNeeds({ hasWebsite: Boolean(websiteUrl), whatTheyDo: `${niche} services` }, niche),
    signals: buildSignals(candidate, rawText, websiteUrl),
    bestContactEmail: extractEmail(rawText),
    yelpUrl: candidate.yelpUrl || (isYelpUrl(sourceUrl) ? sourceUrl : null),
    sourceUrl
  };
  return enforceProfile(profile, {
    niche,
    city,
    forceWeakPresence,
    sourceUrl,
    yelpUrl: candidate.yelpUrl || null,
    rawText,
    profileSource: forceWeakPresence ? 'gemini_mock' : 'live_browser',
    candidate,
    allowGeneratedUrls: !forceWeakPresence
  });
}

function parseBrowserDiscoveryOutput(raw, { sourceName, report, phase }) {
  const parsed = parseJsonBlock(raw);
  if (parsed) {
    const candidates = coerceGeneratedCandidates(parsed.candidates || parsed.leads || parsed.results || (Array.isArray(parsed) ? parsed : []), { sourceName });
    const skipped = (parsed.skipped || parsed.rejected || [])
      .map((item) => ({ ...coerceCandidate(item, { sourceName }), reason: item?.reason || item?.skipReason || 'not selected' }))
      .filter((item) => item.businessName || item.sourceUrl);
    return { candidates, skipped };
  }

  const candidates = parseLabeledCandidates(raw, { sourceName });
  if (!candidates.length && raw.trim()) {
    addFailed(report, { sourceName, snippet: raw.slice(0, 500) }, new Error('Could not parse Browser Use candidate output'), phase);
  }
  return { candidates, skipped: [] };
}

function parseYelpHtml(html, { sourceUrl, sourceName, sourceKind }) {
  const out = [];
  const seen = new Set();
  const jsonUrlRe = /"name"\s*:\s*"([^"]{2,160})"[\s\S]{0,700}?"url"\s*:\s*"([^"]*\/biz\/[^"]+)"/gi;
  for (const match of html.matchAll(jsonUrlRe)) {
    const candidate = buildDirectoryCandidate({
      businessName: decodeText(match[1]),
      sourceUrl: absoluteUrl(unescapeJsonUrl(match[2]), 'https://www.yelp.com'),
      sourceName,
      sourceKind
    });
    pushCandidate(out, seen, candidate);
  }

  const anchorRe = /<a\b[^>]*href=["']([^"']*\/biz\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRe)) {
    const candidate = buildDirectoryCandidate({
      businessName: cleanText(match[2]),
      sourceUrl: absoluteUrl(decodeText(match[1]), 'https://www.yelp.com'),
      sourceName,
      sourceKind
    });
    pushCandidate(out, seen, candidate);
  }

  return out.map((candidate) => ({
    ...candidate,
    yelpUrl: candidate.sourceUrl,
    directorySearchUrl: sourceUrl
  }));
}

function parseYellowPagesHtml(html, { sourceUrl, sourceName, sourceKind, city }) {
  const blocks = html.split(/<div[^>]+class=["'][^"']*\bresult\b/gi).slice(1);
  const out = [];
  const seen = new Set();

  for (const block of blocks) {
    const link = block.match(/<a\b[^>]+class=["'][^"']*\bbusiness-name\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const street = cleanText(matchFirst(block, /class=["'][^"']*\bstreet-address\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i));
    const locality = cleanText(matchFirst(block, /class=["'][^"']*\blocality\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i));
    const phone = cleanText(matchFirst(block, /class=["'][^"']*\bphones?\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i));
    const candidate = buildDirectoryCandidate({
      businessName: cleanText(link[2]),
      sourceUrl: absoluteUrl(decodeText(link[1]), 'https://www.yellowpages.com'),
      sourceName,
      sourceKind,
      phoneHint: phone || null,
      addressHint: [street, locality].filter(Boolean).join(', ') || (street ? `${street}, ${city}` : null),
      snippet: cleanText(block).slice(0, 500),
      directorySearchUrl: sourceUrl
    });
    pushCandidate(out, seen, candidate);
  }

  return out;
}

function parseSearchHtml(html, { sourceUrl, sourceName, sourceKind, niche, city }) {
  const out = [];
  const seen = new Set();
  const resultRe = /<a\b[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>([\s\S]{0,1200}?)(?=<a\b[^>]+class=["'][^"']*result__a|$)/gi;

  for (const match of html.matchAll(resultRe)) {
    const href = decodeDuckDuckGoUrl(decodeText(match[1]));
    const title = cleanText(match[2]);
    const snippet = cleanText(match[3]).slice(0, 500);
    if (isAggregateSearchResult({ title, href, snippet, niche })) continue;
    const businessName = cleanSearchTitle(title, { city, niche });
    if (!isPlausibleBusinessName(businessName)) continue;

    const candidate = buildDirectoryCandidate({
      businessName,
      sourceUrl: href,
      sourceName,
      sourceKind,
      snippet,
      websiteHint: isDirectoryUrl(href) ? null : href,
      presenceReason: isDirectoryUrl(href)
        ? 'Search result points to a directory listing rather than an owned site.'
        : 'Search result points to an owned or third-party web presence that should be audited.',
      directorySearchUrl: sourceUrl
    });
    pushCandidate(out, seen, candidate);
  }

  return out;
}

function parseLabeledCandidates(raw, { sourceName }) {
  const blocks = raw
    .split(/\n\s*\n|(?=\n?\s*\d+[\).]\s+)/)
    .map((block) => block.trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();

  for (const block of blocks) {
    const sourceUrl = extractSourceUrl(block);
    const businessName = cleanBusinessName(
      matchField(block, ['business name', 'name', 'business'])
      || block.match(/^\s*(?:\d+[\).]\s*)?([^\n:]{3,120})/)?.[1]
    );
    const candidate = buildDirectoryCandidate({
      businessName,
      sourceUrl,
      sourceName,
      sourceKind: 'browser-use',
      yelpUrl: isYelpUrl(sourceUrl) ? sourceUrl : matchField(block, ['yelp url', 'yelp']),
      phoneHint: matchField(block, ['phone', 'phone number']),
      addressHint: matchField(block, ['address', 'neighborhood']),
      websiteHint: normalizeWebsiteField(matchField(block, ['website', 'business website', 'website/social clues'])),
      presenceReason: matchField(block, ['why', 'presence', 'online presence', 'reason']),
      snippet: block.slice(0, 800)
    });
    pushCandidate(out, seen, candidate);
  }

  return out;
}

function coerceGeneratedCandidates(items, { sourceName }) {
  const out = [];
  const seen = new Set();
  for (const item of items) pushCandidate(out, seen, coerceCandidate(item, { sourceName }));
  return out;
}

function coerceCandidate(item, { sourceName }) {
  const sourceUrl = item?.sourceUrl || item?.url || item?.listingUrl || item?.yelpUrl || null;
  return buildDirectoryCandidate({
    businessName: item?.businessName || item?.name || item?.title || 'Unknown business',
    yelpUrl: item?.yelpUrl || (isYelpUrl(sourceUrl) ? sourceUrl : null),
    phoneHint: item?.phoneHint || item?.phone || null,
    addressHint: item?.addressHint || item?.address || null,
    sourceUrl,
    sourceName: item?.sourceName || sourceName,
    sourceKind: item?.sourceKind || 'browser-use',
    websiteHint: normalizeWebsiteField(item?.websiteHint || item?.websiteUrl || item?.website || null),
    presenceReason: item?.presenceReason || item?.onlinePresenceSummary || item?.reason || null,
    ownerHypothesis: item?.ownerHypothesis || null,
    customerPersona: item?.customerPersona || null,
    whatTheyDo: item?.whatTheyDo || null,
    snippet: item?.snippet || item?.description || null
  });
}

function buildDirectoryCandidate(fields) {
  const sourceUrl = sanitizeUrl(fields.sourceUrl || fields.yelpUrl || null);
  const yelpUrl = sanitizeUrl(fields.yelpUrl || (isYelpUrl(sourceUrl) ? sourceUrl : null));
  return {
    businessName: cleanBusinessName(fields.businessName),
    yelpUrl,
    phoneHint: normalizeNullable(fields.phoneHint),
    addressHint: normalizeNullable(fields.addressHint),
    sourceUrl,
    sourceName: fields.sourceName || 'directory',
    sourceKind: fields.sourceKind || 'directory',
    websiteHint: normalizeWebsiteField(fields.websiteHint),
    presenceReason: normalizeNullable(fields.presenceReason),
    ownerHypothesis: normalizeNullable(fields.ownerHypothesis),
    customerPersona: normalizeNullable(fields.customerPersona),
    whatTheyDo: normalizeNullable(fields.whatTheyDo),
    snippet: normalizeNullable(fields.snippet),
    directorySearchUrl: sanitizeUrl(fields.directorySearchUrl || null)
  };
}

function pushCandidate(out, seen, candidate) {
  if (!candidate?.businessName || !isPlausibleBusinessName(candidate.businessName)) return;
  const key = candidateKey(candidate);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(candidate);
}

function mergeCandidates(candidates, { limit, report, phase }) {
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = coerceCandidate(candidate, { sourceName: candidate?.sourceName || 'unknown' });
    if (!normalized.businessName || normalized.businessName === 'Unknown business') {
      if (report) addSkipped(report, normalized, 'Missing business name', phase);
      continue;
    }
    const key = candidateKey(normalized);
    if (seen.has(key)) {
      if (report) addSkipped(report, normalized, 'Duplicate candidate already captured', phase);
      continue;
    }
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function mergeDiscoveryReports(base, extra) {
  base.profiles.push(...(extra.profiles || []));
  base.skipped.push(...(extra.skipped || []));
  base.failed.push(...(extra.failed || []));
  base.providerFailures.push(...(extra.providerFailures || []));
  base.fallbackEvents.push(...(extra.fallbackEvents || []));
  base.mode = `${base.mode}+fallback:${extra.mode || 'unknown'}`;
}

function normalizeDiscoveryResult(result, fallbackMode) {
  if (Array.isArray(result)) {
    return {
      mode: fallbackMode,
      profiles: result,
      skipped: [],
      failed: [],
      providerFailures: [],
      fallbackEvents: []
    };
  }
  return {
    mode: result?.mode || fallbackMode,
    profiles: Array.isArray(result?.profiles) ? result.profiles : [],
    skipped: Array.isArray(result?.skipped) ? result.skipped : [],
    failed: Array.isArray(result?.failed) ? result.failed : [],
    providerFailures: Array.isArray(result?.providerFailures) ? result.providerFailures : [],
    fallbackEvents: Array.isArray(result?.fallbackEvents) ? result.fallbackEvents : []
  };
}

function createDiscoveryReport({ mode, runId }) {
  return {
    mode,
    runId,
    profiles: [],
    skipped: [],
    failed: [],
    providerFailures: [],
    fallbackEvents: []
  };
}

function addSkipped(report, item, reason, phase) {
  const entry = reportItem(item, reason, phase);
  report.skipped.push(entry);
  emit('scraper.item.skipped', { worker: 'scraper', runId: report.runId, ...entry });
}

function addFailed(report, item, err, phase) {
  const entry = reportItem(item, err?.message || String(err), phase);
  report.failed.push(entry);
  emit('scraper.item.failed', { worker: 'scraper', runId: report.runId, ...entry });
}

function recordProviderFailure(report, provider, err, phase) {
  const entry = {
    provider,
    phase,
    recoverable: isRecoverableProviderError(err),
    reason: err?.message || String(err)
  };
  report.providerFailures.push(entry);
  emit('scraper.provider.failed', { worker: 'scraper', runId: report.runId, ...entry });
  log.warn('scraper.provider_failed', { runId: report.runId, ...entry });
}

function addFallback(report, to, reason) {
  const entry = { from: report.mode, to, reason };
  report.fallbackEvents.push(entry);
  emit('scraper.fallback', { worker: 'scraper', runId: report.runId, ...entry });
}

function reportItem(item, reason, phase) {
  return {
    businessName: item?.businessName || item?.name || null,
    sourceUrl: item?.sourceUrl || item?.yelpUrl || null,
    sourceName: item?.sourceName || null,
    phase,
    reason
  };
}

function profileSkipReason(profile) {
  if (!profile?.businessName || profile.businessName === 'Unknown business') return 'Missing business name';
  if (!profile.sourceUrl && !profile.yelpUrl) return 'Missing source URL';
  return null;
}

function candidatePrompt({ niche, city, count }) {
  return `Invent ${count} plausible independently-owned ${niche} businesses in ${city} whose online presence is weak or mixed, even if they have a sparse listing or old social page. Mix neighborhood-specific names (avoid generic "Downtown X" stuff). For each, include a realistic local-area phone with the right area code, a street address in a real ${city} neighborhood, and a short ownerHypothesis hint if obvious from the name. Return the CandidateList schema.`;
}

function mockProfilePrompt({ niche, city, candidate }) {
  return `Expand this candidate into a full BusinessProfile. The business is a ${niche} in ${city}. Set hasWebsite=false, websiteUrl=null, onlinePresenceStrength="weak", onlinePresenceConfidence around 0.75, presenceConfidence around 0.75, and notWorthCallingReason=null. Fill onlinePresenceEvidence with no owned website, listing/social clues, gaps, and positiveSignals; onlinePresenceReasons with 3-5 concrete reasons; services; whatTheyDo (1-2 sentences); needs (3-5 concrete website/business needs); customerPersona; provenance; signals (3-6 short tags like "cash-only", "instagram-active", "old-school", "owner-operated"); and leadIntelligence with review themes, proof, pain points, missing customer info, competitor gaps, website issues, listing consistency, CTA, scores, and exact call opener. Candidate JSON:\n\n${JSON.stringify(candidate)}`;
}

function listTaskPrompt({ niche, city, count }) {
  const yelpUrl = `https://www.yelp.com/search?find_desc=${encodeURIComponent(niche)}&find_loc=${encodeURIComponent(city)}`;
  const ypUrl = `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(niche)}&geo_location_terms=${encodeURIComponent(city)}`;
  return [
    `Find up to ${count} real ${niche} businesses in ${city} that look like plausible web-agency leads.`,
    `Start with Yelp: ${yelpUrl}. If Yelp blocks, asks for login, or has sparse results, use Yellow Pages: ${ypUrl}, then a normal web search for "${niche} ${city} local business".`,
    'Prefer small independent businesses. Do not invent businesses.',
    'Return JSON only with this shape: {"candidates":[{"businessName":"...","sourceUrl":"exact listing/search URL","sourceName":"Yelp|Yellow Pages|Search","phoneHint":"... or null","addressHint":"... or null","websiteHint":"... or null","presenceReason":"why this is none/weak/mixed/strong"}],"skipped":[{"businessName":"...","sourceUrl":"...","reason":"why skipped"}]}.',
    'Every candidate must have a sourceUrl. If an item is rejected because it is a duplicate, chain, irrelevant, login-gated, or already has a strong owned site, put it in skipped with a reason.'
  ].join(' ');
}

function detailTaskPrompt({ candidate, niche, city }) {
  const target = candidate?.sourceUrl || candidate?.yelpUrl || `${candidate?.businessName || ''} ${niche} ${city}`;
  return [
    `Open and audit this public business source: ${target}.`,
    `Business hint: ${candidate?.businessName || 'unknown'} (${niche}, ${city}).`,
    'Capture exact business name, public source URL, full phone number, full street address, hours if shown, business website/social URL if visible, whether the website is missing/weak/mixed/strong, review themes, positive proof, complaints/pain points, missing customer info, competitor gaps, website issues, listing/social consistency, best CTA, presence evidence and reasons, confidence, owner/persona clues, what the business actually does, customer decision info, and 3-6 signal tags.',
    'Return labeled plain text. Include "Source URL:" and "Business website:" fields. If there is no website link, say "Business website: none". If the page is blocked, login-gated, or quota/network fails, say exactly what failed.'
  ].join(' ');
}

function liveNormalizePrompt({ candidate, niche, city, rawDetail }) {
  return [
    `Normalize this public lead research into a BusinessProfile. Niche: ${niche}. City: ${city}.`,
    'Never invent a website URL or email. Use the provided source URL if it is the only evidence URL.',
    'Include onlinePresenceEvidence.website/social/listings/gaps/positiveSignals, onlinePresenceReasons, onlinePresenceConfidence, presenceConfidence, services, provenance, leadIntelligence with evidenceIds/sourceIds on every claim, and notWorthCallingReason only when the presence is strong enough to block outreach.',
    `Candidate hint JSON:\n${JSON.stringify(candidate)}`,
    `Source text follows between BEGIN/END markers.\n\nBEGIN\n${rawDetail.slice(0, MAX_RAW_TEXT)}\nEND`
  ].join('\n\n');
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

function defaultServices(profile, niche) {
  const primary = profile?.whatTheyDo || `${niche} services`;
  return unique([primary, `${niche} services`]).slice(0, 8);
}

function normalizeProvenance(profile, { profileSource, sourceUrl, yelpUrl, phone, address }) {
  return {
    profileSource: normalizeProfileSource(profile?.provenance?.profileSource || profileSource),
    sourceUrl: sourceUrl || profile?.provenance?.sourceUrl || profile?.sourceUrl || null,
    yelpUrl: yelpUrl || profile?.provenance?.yelpUrl || profile?.yelpUrl || null,
    capturedAt: profile?.provenance?.capturedAt || new Date().toISOString(),
    phone: normalizeFieldProvenance(profile?.provenance?.phone, {
      field: 'phone',
      value: phone || profile?.phone || null,
      profileSource
    }),
    address: normalizeFieldProvenance(profile?.provenance?.address, {
      field: 'address',
      value: address || profile?.address || null,
      profileSource
    })
  };
}

function normalizeProfileSource(value) {
  return ['live_browser', 'gemini_mock', 'provided', 'memory_write', 'memory_repair', 'unknown'].includes(value)
    ? value
    : 'unknown';
}

function normalizeFieldProvenance(existing, { field, value, profileSource }) {
  const validSources = ['source_text', 'candidate', 'provided', 'model', 'mock', 'repair', 'none'];
  if (existing && typeof existing === 'object') {
    return {
      value: typeof existing.value === 'string' ? existing.value : value,
      source: validSources.includes(existing.source) ? existing.source : (value ? 'model' : 'none'),
      sourceUrl: typeof existing.sourceUrl === 'string' ? existing.sourceUrl : null,
      evidence: typeof existing.evidence === 'string' ? existing.evidence : null
    };
  }
  if (!value) return { value: null, source: 'none', sourceUrl: null, evidence: null };
  return {
    value,
    source: profileSource === 'gemini_mock' ? 'mock' : 'source_text',
    sourceUrl: null,
    evidence: profileSource === 'gemini_mock'
      ? `Demo ${field} generated in mock mode.`
      : `${field} captured from research output.`
  };
}

function applyDirectorySourceEvidence(scored, sourceUrl, yelpUrl) {
  const platform = listingPlatformName(sourceUrl);
  scored.sourceUrl = sourceUrl;
  scored.yelpUrl = yelpUrl || (isYelpUrl(sourceUrl) ? sourceUrl : null);
  scored.hasWebsite = false;
  scored.websiteUrl = null;
  scored.onlinePresenceEvidence = scored.onlinePresenceEvidence || {};
  scored.onlinePresenceEvidence.website = {
    found: false,
    url: null,
    evidence: ['No owned website URL confirmed from source evidence.']
  };
  scored.onlinePresenceEvidence.listings = {
    found: true,
    platforms: unique([...(scored.onlinePresenceEvidence.listings?.platforms || []), platform]).slice(0, 8),
    urls: unique([...(scored.onlinePresenceEvidence.listings?.urls || []), sourceUrl]).slice(0, 8),
    evidence: unique([
      ...(scored.onlinePresenceEvidence.listings?.evidence || []),
      `Directory/listing source captured from ${platform}.`
    ]).slice(0, 5)
  };
  scored.onlinePresenceEvidence.gaps = unique([
    ...(scored.onlinePresenceEvidence.gaps || []),
    'third-party listing only',
    'no owned website found'
  ]).slice(0, 8);
  if (scored.onlinePresenceStrength === 'none' || scored.onlinePresenceStrength === 'strong') {
    scored.onlinePresenceStrength = 'weak';
    scored.notWorthCallingReason = null;
    scored.onlinePresenceSummary = 'Directory listing found, but no owned website URL was confirmed from the available source evidence.';
    scored.onlinePresenceReasons = [
      'third-party listing only',
      'no owned website found'
    ];
    scored.callRecommendation = {
      shouldCall: true,
      notWorthCalling: false,
      whyCall: scored.onlinePresenceSummary,
      whyNotCall: null
    };
  }
}

function listingPlatformName(url) {
  const host = hostFor(url);
  if (!host) return 'directory';
  if (host.includes('yellowpages')) return 'yellow pages';
  if (host.includes('allbiz')) return 'allbiz';
  if (host.includes('yelp')) return 'yelp';
  return host.split('.')[0] || 'directory';
}

function deterministicCandidates({ niche, city, count, offset = 0 }) {
  const neighborhoods = ['Northside', 'Mission', 'Lakeview', 'Parkside', 'Market Street', 'Cedar'];
  const suffixes = ['Studio', 'Works', 'Collective', 'Shop', 'Company', 'House'];
  return Array.from({ length: count }, (_, index) => {
    const n = offset + index;
    const name = `${city.split(',')[0].trim()} ${titleCase(niche)} ${suffixes[n % suffixes.length]}`;
    return buildDirectoryCandidate({
      businessName: n === 0 ? name : `${neighborhoods[n % neighborhoods.length]} ${titleCase(niche)} ${suffixes[n % suffixes.length]}`,
      phoneHint: null,
      addressHint: `${100 + n * 37} ${neighborhoods[n % neighborhoods.length]} Ave, ${city}`,
      sourceUrl: mockSourceUrl({ city, niche, index: n }),
      sourceName: 'deterministic-mock',
      sourceKind: 'mock',
      presenceReason: 'Deterministic demo fallback used because live providers were unavailable.'
    });
  });
}

function withMockSource(candidate, { niche, city, index }) {
  if (candidate.sourceUrl || candidate.yelpUrl) return candidate;
  return {
    ...candidate,
    sourceUrl: mockSourceUrl({ city, niche, index }),
    sourceName: candidate.sourceName || 'gemini-mock'
  };
}

function mockSourceUrl({ city, niche, index }) {
  return `https://demo.callmemaybe.local/lead-discovery/${slugify(city)}/${slugify(niche)}/${index + 1}`;
}

async function fetchText(url, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: DIRECT_HEADERS,
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonBlock(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const firstObject = cleaned.indexOf('{');
  const firstArray = cleaned.indexOf('[');
  const start = [firstObject, firstArray].filter((n) => n >= 0).sort((a, b) => a - b)[0];
  if (start == null) return null;
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function matchField(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*(.+?)(?=\\n\\s*[A-Za-z][A-Za-z /-]{1,40}\\s*:|\\n\\s*\\d+[\\).]|$)`, 'is');
    const match = text.match(re);
    if (match) return cleanText(match[1]);
  }
  return null;
}

function matchFirst(text, re) {
  return text.match(re)?.[1] || '';
}

function htmlToText(html) {
  return decodeText(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim());
}

function cleanText(value) {
  return decodeText(String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function decodeText(value) {
  return String(value || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function unescapeJsonUrl(value) {
  return decodeText(String(value || '').replace(/\\u0026/g, '&'));
}

function cleanBusinessName(value) {
  return cleanText(value)
    .replace(/^\d+[\).]\s*/, '')
    .replace(/\s+-\s+(Yelp|Yellow Pages|Facebook|Instagram|BBB|Chamber of Commerce).*$/i, '')
    .replace(/\s+\|\s+.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanSearchTitle(title, { city, niche }) {
  return cleanBusinessName(title)
    .replace(new RegExp(`\\b${escapeRegExp(city.split(',')[0].trim())}\\b`, 'ig'), '')
    .replace(new RegExp(`\\b${escapeRegExp(niche)}\\b`, 'ig'), (m) => m)
    .replace(/\s+-\s+The Real Yellow Pages.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeNullable(value) {
  const text = cleanText(value);
  if (!text || /^null$/i.test(text)) return null;
  return text;
}

function normalizeWebsiteField(value) {
  if (!value || WEBSITE_NONE_RE.test(String(value))) return null;
  const direct = sanitizeUrl(String(value));
  if (direct) return direct;
  return extractSourceUrl(String(value));
}

function sanitizeUrl(value) {
  if (!value) return null;
  const cleaned = decodeText(String(value)).trim().replace(/[),.;]+$/g, '');
  if (/^demo:\/\//i.test(cleaned)) return cleaned;
  if (!/^https?:\/\//i.test(cleaned)) return null;
  try {
    const url = new URL(cleaned);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function absoluteUrl(value, base) {
  if (!value) return null;
  const decoded = decodeText(value).replace(/[),.;]+$/g, '');
  try {
    return new URL(decoded, base).toString();
  } catch {
    return null;
  }
}

function decodeDuckDuckGoUrl(href) {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return sanitizeUrl(uddg ? decodeURIComponent(uddg) : url.toString());
  } catch {
    return sanitizeUrl(href);
  }
}

function extractSourceUrl(text) {
  const urls = String(text || '').match(URL_RE) || [];
  return sanitizeUrl(urls[0]);
}

function extractWebsiteUrl(text) {
  const explicit = matchField(String(text || ''), ['business website', 'website', 'website url']);
  const normalized = normalizeWebsiteField(explicit);
  if (normalized) return normalized;
  const urls = String(text || '').match(URL_RE) || [];
  return urls.map((url) => sanitizeUrl(url)).find((url) => url && !isDirectoryUrl(url)) || null;
}

function firstNonDirectoryUrl(value, sourceUrl) {
  const url = sanitizeUrl(value);
  if (!url) return null;
  if (sourceUrl && stripTracking(url) === stripTracking(sourceUrl)) return null;
  return isDirectoryUrl(url) ? null : url;
}

function extractPhone(text) {
  return String(text || '').match(PHONE_RE)?.[0] || null;
}

function extractEmail(text) {
  return String(text || '').match(EMAIL_RE)?.[0] || null;
}

function extractAddress(text, city) {
  const lines = String(text || '').split(/\n| {2,}/).map((line) => cleanText(line)).filter(Boolean);
  const cityName = city.split(',')[0].trim();
  return lines.find((line) => /\d{1,6}\s+[A-Za-z0-9 .'-]+/.test(line) && line.toLowerCase().includes(cityName.toLowerCase())) || null;
}

function extractHours(text) {
  const hours = matchField(String(text || ''), ['hours', 'business hours']);
  if (hours && hours.length < 500) return hours;
  return null;
}

function buildSignals(candidate, rawText, websiteUrl) {
  const signals = [
    candidate.sourceName ? `${String(candidate.sourceName).toLowerCase().replace(/\s+/g, '-')}-source` : null,
    candidate.sourceKind ? `${candidate.sourceKind}-parsed` : null,
    websiteUrl ? 'owned-website-visible' : 'no-owned-website-found',
    candidate.phoneHint || extractPhone(rawText) ? 'public-phone' : null,
    candidate.addressHint || extractAddress(rawText, '') ? 'public-address' : null
  ].filter(Boolean);
  if (/family-owned|locally owned/i.test(rawText)) signals.push('owner-operated');
  if (/walk-ins?|appointment/i.test(rawText)) signals.push('visit-intent');
  return [...new Set(signals)].slice(0, 8);
}

function inferPresenceStrength({ candidate, rawText, websiteUrl }) {
  const hint = `${candidate.presenceReason || ''} ${rawText || ''}`;
  const explicit = hint.match(/\b(none|weak|mixed|strong)\b/i)?.[1]?.toLowerCase();
  if (['none', 'weak', 'mixed', 'strong'].includes(explicit)) return explicit;
  if (!websiteUrl && candidate.sourceKind === 'directory') return 'weak';
  if (!websiteUrl) return 'mixed';
  if (/old|outdated|broken|sparse|missing|weak|facebook|instagram/i.test(hint)) return 'mixed';
  return 'mixed';
}

function isRecoverableProviderError(err) {
  return PROVIDER_FAILURE_RE.test(err?.message || String(err));
}

function isYelpUrl(url) {
  return /https?:\/\/([^/]+\.)?yelp\.com\/biz\//i.test(String(url || ''));
}

function isDirectoryUrl(url) {
  const host = hostFor(url);
  return /(^|\.)yelp\.com$|(^|\.)yellowpages\.com$|(^|\.)allbiz\.com$|(^|\.)facebook\.com$|(^|\.)instagram\.com$|(^|\.)bbb\.org$|(^|\.)chamberofcommerce\.com$|(^|\.)manta\.com$|(^|\.)angi\.com$|(^|\.)nextdoor\.com$|(^|\.)tripadvisor\.com$/.test(host);
}

function isAggregateSearchResult({ title, href, snippet, niche }) {
  const haystack = `${title || ''} ${snippet || ''}`.toLowerCase();
  if (/\b(best|top)\s+\d+\b|\bnear me\b|\bdirectory\b|\blist of\b|\bsearch results\b/.test(haystack)) return true;
  if (new RegExp(`\\b${escapeRegExp(niche)}s?\\s+in\\b`, 'i').test(haystack) && /\b(yellow pages|yelp|tripadvisor|bbb|chamber|manta)\b/i.test(haystack)) return true;
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const path = url.pathname.toLowerCase();
    if (['barbershops.net', 'local.yahoo.com', 'mapquest.com'].includes(host)) return true;
    if (host === 'yellowpages.com' && !path.includes('/mip/')) return true;
    if (host === 'yelp.com' && !path.includes('/biz/')) return true;
    if (/\/(search|categories?|directory)\b/.test(path)) return true;
  } catch {
    return false;
  }
  return false;
}

function hostFor(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function stripTracking(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function isPlausibleBusinessName(name) {
  const clean = cleanBusinessName(name);
  if (clean.length < 3 || clean.length > 120) return false;
  if (/^[,.;:|/\\-]/.test(clean)) return false;
  if (/^(home|menu|reviews?|photos?|more|website|directions?|search|sponsored|ad)$/i.test(clean)) return false;
  if (/\b(best|top)\s+\d+\b/i.test(clean)) return false;
  if (/\b[a-z0-9.-]+\.(com|net|org|biz|info)\//i.test(clean)) return false;
  return /[A-Za-z]/.test(clean);
}

function candidateKey(candidate) {
  const url = stripTracking(candidate.sourceUrl || candidate.yelpUrl || '');
  if (url) return `url:${url.toLowerCase()}`;
  return `name:${cleanBusinessName(candidate.businessName).toLowerCase()}`;
}

function clampCount(count) {
  const n = Number(count);
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(8, Math.floor(n)));
}

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ''}${part.slice(1).toLowerCase()}`)
    .join(' ');
}

function slugify(value) {
  return String(value || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
