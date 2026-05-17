import { emit } from '../sse.js';
import { runs, leads, builds, payments, contactEvents } from '../db.js';
import { canBuild, env } from '../env.js';
import { log } from '../logger.js';
import { containerTagFor, getLatest } from '../memory.js';
import { generateText } from '../gemini.js';
import {
  BrowserUseLovableAdapter,
  browserUseLovableNavigationSmokeEnabled,
  createLovablePromptUrl
} from '../providers/browserUse.js';

export async function runBuilder({ leadId, buildId }) {
  const claimedBuildId = buildId || `bld_${Date.now().toString(36)}`;
  const claim = builds.claimStart({ id: claimedBuildId, lead_id: leadId });
  if (!claim.claimed) {
    log.info('builder.start_skipped', { leadId, buildId: claimedBuildId, reason: claim.reason });
    emit('builder.skipped', { worker: 'builder', leadId, buildId: claimedBuildId, reason: claim.reason });
    return { skipped: true, reason: claim.reason };
  }

  const runId = `build_${Date.now().toString(36)}`;
  buildId = claim.row.id;
  runs.start({ id: runId, lead_id: leadId, worker: 'builder' });
  emit('builder.start', { worker: 'builder', leadId, runId, buildId });

  try {
    const lead = leads.get(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);

    const tag = containerTagFor(leadId);
    const [profileDoc, postMortemDoc] = await Promise.all([
      getLatest(tag, 'profile').catch(() => null),
      getLatest(tag, 'post_mortem').catch(() => null)
    ]);

    const brief = await buildBrief({ lead, profileDoc, postMortemDoc });
    const lovableUrl = createLovablePromptUrl(brief);
    const isLive = canBuild();

    if (!isLive) {
      return await runMock({ leadId, lead, runId, buildId, brief, lovableUrl });
    }

    return await runLive({ leadId, lead, runId, buildId, brief, lovableUrl });
  } catch (err) {
    const message = err?.message || String(err);
    builds.update(buildId, { status: 'failed', finished_at: Date.now(), error: message });
    runs.finish(runId, { state: 'failed', error: message });
    emit('builder.error', { worker: 'builder', leadId, runId, buildId, error: message });
    throw err;
  }
}

async function runMock({ leadId, lead, runId, buildId, brief, lovableUrl }) {
  const liveUrl = `/api/leads/${encodeURIComponent(leadId)}/build-preview`;
  const projectUrl = `https://${slugify(lead.business_name)}.lovable.app`;

  builds.update(buildId, { browser_session_id: null, live_url: liveUrl, lovable_url: lovableUrl, brief, status: 'running' });
  emit('builder.live_url', {
    worker: 'builder',
    leadId,
    runId,
    buildId,
    liveUrl,
    lovableUrl,
    brief,
    mock: true
  });

  emit('builder.progress', { worker: 'builder', leadId, runId, buildId, summary: 'Generated the Lovable brief and opened the live preview session.', mock: true });
  await delay(1800);
  emit('builder.progress', { worker: 'builder', leadId, runId, buildId, summary: 'Lovable is composing the small-business site sections.', mock: true });
  await delay(2200);
  emit('builder.progress', { worker: 'builder', leadId, runId, buildId, summary: 'Final pass: contact CTA, service copy, and local trust cues are in place.', mock: true });
  await delay(1600);

  emit('builder.project_url', { worker: 'builder', leadId, runId, buildId, projectUrl, mock: true });

  builds.update(buildId, { project_url: projectUrl, status: 'completed', finished_at: Date.now() });
  leads.update(leadId, { website: projectUrl, status: 'shipped' });

  runs.finish(runId, { state: 'completed', detail: { mock: true, liveUrl, projectUrl } });
  emit('builder.done', {
    worker: 'builder',
    leadId,
    runId,
    buildId,
    liveUrl,
    projectUrl,
    mock: true
  });

  return { liveUrl, projectUrl, brief, mock: true };
}

async function runLive({ leadId, lead, runId, buildId, brief, lovableUrl }) {
  const adapter = new BrowserUseLovableAdapter({
    apiKey: env.browserUse.apiKey,
    baseUrl: env.browserUse.baseUrl
  });
  const session = await adapter.createSession({ keepAlive: true });
  const liveUrl = session.liveUrl;
  const sessionId = session.sessionId;
  if (!sessionId) throw new Error('browser-use session create returned no session id');

  let buildStarted = false;
  let finished = false;
  let projectUrl = null;

  const persistProjectUrl = (url) => {
    if (!url || url === projectUrl) return;
    projectUrl = url;
    builds.update(buildId, { project_url: projectUrl });
    emit('builder.project_url', { worker: 'builder', leadId, runId, buildId, projectUrl, sessionId });
  };

  const emitProgress = (event) => {
    if (!event?.summary) return;
    emit('builder.progress', {
      worker: 'builder',
      leadId,
      runId,
      buildId,
      phase: event.phase,
      summary: event.summary,
      providerType: event.providerType,
      screenshotUrl: event.screenshotUrl,
      messageId: event.messageId,
      providerTs: event.providerTs
    });
  };

  const finalizeBlockedAuth = (event = {}) => {
    finished = true;
    if (event.projectUrl) persistProjectUrl(event.projectUrl);
    const reason = event.reason || 'lovable_auth_needed';
    builds.update(buildId, { status: 'blocked_auth', finished_at: Date.now() });
    leads.update(leadId, { next_action: 'lovable_auth_needed' });
    runs.finish(runId, { state: 'blocked', detail: { liveUrl, projectUrl, sessionId, reason } });
    emit('builder.blocked_auth', {
      worker: 'builder',
      leadId,
      runId,
      buildId,
      liveUrl,
      sessionId,
      reason,
      phase: event.phase
    });
    return { liveUrl, projectUrl: null, brief, sessionId, blockedAuth: true, reason };
  };

  const finalizeMissingProjectUrl = (reason) => {
    finished = true;
    builds.update(buildId, { status: 'failed', finished_at: Date.now(), error: reason });
    leads.update(leadId, { next_action: 'lovable_project_url_missing' });
    runs.finish(runId, { state: 'failed', error: reason, detail: { liveUrl, projectUrl, sessionId } });
    emit('builder.error', { worker: 'builder', leadId, runId, buildId, liveUrl, sessionId, error: reason });
    return { liveUrl, projectUrl, brief, sessionId, error: reason };
  };

  const finalizeCompleted = (event = {}) => {
    if (event.projectUrl) persistProjectUrl(event.projectUrl);
    if (!projectUrl) return finalizeMissingProjectUrl('Lovable build finished without a .lovable.app URL');

    finished = true;
    builds.update(buildId, { project_url: projectUrl, status: 'completed', finished_at: Date.now() });
    leads.update(leadId, { website: projectUrl, status: 'shipped', next_action: null });
    runs.finish(runId, { state: 'completed', detail: { liveUrl, projectUrl, sessionId, successful: event.successful } });
    emit('builder.done', { worker: 'builder', leadId, runId, buildId, liveUrl, projectUrl, sessionId });
    return { liveUrl, projectUrl, brief, sessionId };
  };

  const consumeProviderEvent = (event) => {
    if (!event) return null;
    if (event.kind === 'progress') {
      emitProgress(event);
      return null;
    }
    if (event.kind === 'project_url') {
      persistProjectUrl(event.projectUrl);
      return null;
    }
    if (event.kind === 'blocked_auth') return finalizeBlockedAuth(event);
    if (event.kind === 'done') return finalizeCompleted(event);
    return null;
  };

  try {
    builds.update(buildId, { browser_session_id: sessionId, live_url: liveUrl, lovable_url: lovableUrl, brief, status: 'running' });
    buildStarted = true;
    emit('builder.live_url', {
      worker: 'builder',
      leadId,
      runId,
      buildId,
      liveUrl,
      lovableUrl,
      brief,
      sessionId,
      navigationSmoke: browserUseLovableNavigationSmokeEnabled(),
      note: 'Browser Use session should use a Lovable-authenticated profile when available; auth walls are reported as blocked_auth.'
    });

    if (browserUseLovableNavigationSmokeEnabled()) {
      for await (const event of adapter.smokeLovableNavigation({ sessionId })) {
        const terminal = consumeProviderEvent(event);
        if (terminal) return terminal;
      }
    }

    for await (const event of adapter.submitLovablePrompt({ sessionId, lovableUrl, brief })) {
      const terminal = consumeProviderEvent(event);
      if (terminal) return terminal;
    }

    return finalizeMissingProjectUrl('Browser Use Lovable task ended without a terminal event');
  } catch (err) {
    if (buildStarted && !finished) {
      builds.update(buildId, { status: 'failed', finished_at: Date.now(), error: err?.message || String(err) });
    }
    throw err;
  } finally {
    try {
      await adapter.stopSession(sessionId);
    } catch (err) {
      log.warn('browser-use session stop failed', { sessionId, error: err?.message || String(err) });
    }
  }
}

async function buildBrief({ lead, profileDoc, postMortemDoc }) {
  const profile = parseDocContent(profileDoc);
  const postMortem = parseDocContent(postMortemDoc);
  const latestPayment = payments.listByLead(lead.id)[0];
  const niche = (lead.niche || profile?.niche || 'local services').toLowerCase();
  const style = pickStyle(niche);
  const context = buildBriefContext({ lead, profile, postMortem, latestPayment, niche, style });

  const prompt = buildLovablePromptRequest(context);

  try {
    const text = await generateText({
      prompt,
      systemInstruction: 'You write tight, concrete website build prompts for Lovable. No fluff, no invented facts.',
      thinkingLevel: 'low'
    });
    const trimmed = (text || '').trim();
    if (trimmed.length > 50) return trimmed;
  } catch (err) {
    log.warn('builder brief gemini failed; using fallback', { error: err?.message || String(err) });
  }

  return fallbackBrief(context);
}

function buildBriefContext({ lead, profile, postMortem, latestPayment, niche, style }) {
  const city = firstText(lead.city, profile?.city, 'the local area');
  const phone = firstText(lead.phone, profile?.phone, 'use a visible phone placeholder');
  const hours = firstText(profile?.hours, 'Hours not confirmed');
  const address = firstText(profile?.address, lead.address, null);
  const services = pickServices({ profile, niche });
  const needs = listItems(profile?.needs, 5, ['clear service menu', 'trust proof', 'tap-to-call contact path']);
  const agentMailQuestions = collectAgentMailQuestions(lead.id, postMortem);
  const postCall = postCallSummary(postMortem);

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
    invoice: invoiceSummary(latestPayment, postMortem),
    research: researchSummary(profile),
    customer: customerSummary(profile, postMortem)
  };
}

function buildLovablePromptRequest(ctx) {
  return [
    'Create the final Lovable prompt for a paid small-business website build.',
    'Keep it 180-240 words. Be concrete, brief, and implementation-ready.',
    'Include the real facts below. Do not invent services, hours, reviews, guarantees, booking integrations, pricing, or staff names.',
    'Make it read as one prompt Lovable can execute, with compact labeled lines allowed.',
    '',
    `Business: ${ctx.businessName}`,
    `Niche/location: ${ctx.niche} in ${ctx.city}`,
    `Research findings: ${ctx.research}`,
    `Phone/hours/address: phone ${ctx.phone}; hours ${ctx.hours}; address ${ctx.address || 'not confirmed'}`,
    `Services to feature: ${ctx.services.join('; ')}`,
    `Customer needs: ${ctx.needs.join('; ')}`,
    `Likely customers/persona: ${ctx.customer}`,
    `Style direction: ${ctx.style.tone}; ${ctx.style.palette}; ${ctx.style.layout}`,
    `Customer questions from AgentMail/call: ${ctx.agentMailQuestions.length ? ctx.agentMailQuestions.join('; ') : 'none yet'}`,
    `Invoice/customer context: ${ctx.invoice}`,
    `Post-call objections/commitments: ${ctx.postCall}`,
    '',
    'Required output: only the finished Lovable prompt, no analysis or preamble.'
  ].join('\n');
}

function fallbackBrief(ctx) {
  return [
    `Build a concise, polished website for ${ctx.businessName}, a ${ctx.niche} business in ${ctx.city}.`,
    `Use research findings: ${ctx.research}.`,
    `Show phone ${ctx.phone}, hours ${ctx.hours}${ctx.address ? `, and address ${ctx.address}` : ''}.`,
    `Feature services: ${ctx.services.join(', ')}.`,
    `Solve customer needs: ${ctx.needs.join(', ')}.`,
    `Style: ${ctx.style.tone}; ${ctx.style.palette}; ${ctx.style.layout}.`,
    `Include Home, Services, and Contact sections with tap-to-call and a simple inquiry form; do not imply unsupported booking or guarantees.`,
    `Answer customer questions: ${ctx.agentMailQuestions.length ? ctx.agentMailQuestions.join('; ') : 'make invoice, timing, and revision expectations clear'}.`,
    `Invoice/customer context: ${ctx.invoice}.`,
    `Respect post-call context: ${ctx.postCall}.`
  ].join(' ');
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
    listItems(profile.signals, 5, []).length ? `signals: ${listItems(profile.signals, 5, []).join(', ')}` : null
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
  return compactText(`invoice ${invoiceId}, ${status}, ${amount}; ${emailStatus}${url ? `; payment URL available` : ''}`, 260);
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
  const c = doc?.content;
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

function slugify(s) {
  return String(s || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
