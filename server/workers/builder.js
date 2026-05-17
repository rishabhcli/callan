import { emit } from '../sse.js';
import { runs, leads, builds, payments, contactEvents } from '../db.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { containerTagFor, getLatest } from '../memory.js';
import { generateText } from '../gemini.js';

const LOVABLE_RE = /https:\/\/[a-z0-9-]+\.lovable\.app/i;

export async function runBuilder({ leadId }) {
  const runId = `build_${Date.now().toString(36)}`;
  runs.start({ id: runId, lead_id: leadId, worker: 'builder' });
  emit('builder.start', { worker: 'builder', leadId, runId });

  try {
    const lead = leads.get(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);

    const tag = containerTagFor(leadId);
    const [profileDoc, postMortemDoc] = await Promise.all([
      getLatest(tag, 'profile').catch(() => null),
      getLatest(tag, 'post_mortem').catch(() => null)
    ]);

    const brief = await buildBrief({ lead, profileDoc, postMortemDoc });
    const lovableUrl = `https://lovable.dev/?autosubmit=true#prompt=${encodeURIComponent(brief)}`;
    const isLive = ['live', 'demo_live', 'autonomous_live'].includes(env.runMode) && env.live.builds && !!env.browserUse.apiKey;
    const buildId = `bld_${Date.now().toString(36)}`;

    if (!isLive) {
      return await runMock({ leadId, lead, runId, buildId, brief, lovableUrl });
    }

    return await runLive({ leadId, lead, runId, buildId, brief, lovableUrl });
  } catch (err) {
    runs.finish(runId, { state: 'failed', error: err?.message || String(err) });
    emit('builder.error', { worker: 'builder', leadId, runId, error: err?.message || String(err) });
    throw err;
  }
}

async function runMock({ leadId, lead, runId, buildId, brief, lovableUrl }) {
  const liveUrl = `https://live.browser-use.com/preview?demo=${leadId}`;
  const projectUrl = `https://${slugify(lead.business_name)}.lovable.app`;

  builds.start({ id: buildId, lead_id: leadId, browser_session_id: null, live_url: liveUrl });
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

  await delay(8000);

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
  const { BrowserUse } = await import('browser-use-sdk/v3');
  const client = new BrowserUse({ apiKey: env.browserUse.apiKey });

  let session;
  try {
    session = await client.sessions.create({ keepAlive: true });
  } catch (err) {
    throw new Error(`browser-use session create failed: ${err?.message || err}`);
  }

  const liveUrl = session.liveUrl;
  const sessionId = session.id;

  builds.start({ id: buildId, lead_id: leadId, browser_session_id: sessionId, live_url: liveUrl });
  emit('builder.live_url', {
    worker: 'builder',
    leadId,
    runId,
    buildId,
    liveUrl,
    lovableUrl,
    brief,
    sessionId,
    note: 'Browser Use session must be pre-authenticated to Lovable; otherwise the autosubmit will stall at the login wall.'
  });

  let projectUrl = null;
  let blockedAuth = false;
  try {
    const task = client.run(
      `Open ${lovableUrl} and watch Lovable build the website. If a Lovable login or sign-in wall appears, stop and report BLOCKED_AUTH. When the build starts, stay on the page so the operator can watch progress. When a final .lovable.app URL appears, report it exactly.`,
      { sessionId }
    );

    for await (const msg of task) {
      const summary = summarizeMsg(msg);
      if (summary) {
        emit('builder.progress', { worker: 'builder', leadId, runId, buildId, summary });
        if (isAuthWall(summary)) {
          blockedAuth = true;
          break;
        }
      }
      const match = findLovableUrl(msg);
      if (match && !projectUrl) projectUrl = match;
    }

    const final = blockedAuth ? null : await task.result.catch(() => null);
    if (!projectUrl && final) projectUrl = findLovableUrl(final);
    if (!blockedAuth && isAuthWall(summarizeMsg(final))) blockedAuth = true;

    if (blockedAuth) {
      builds.update(buildId, { status: 'blocked_auth', finished_at: Date.now() });
      leads.update(leadId, { next_action: 'lovable_auth_needed' });
      runs.finish(runId, { state: 'blocked', detail: { liveUrl, sessionId, reason: 'lovable auth needed' } });
      emit('builder.blocked_auth', { worker: 'builder', leadId, runId, buildId, liveUrl, sessionId });
      return { liveUrl, projectUrl: null, brief, sessionId, blockedAuth: true };
    }

    const patch = { status: 'completed', finished_at: Date.now() };
    if (projectUrl) patch.project_url = projectUrl;
    builds.update(buildId, patch);
    if (projectUrl) leads.update(leadId, { website: projectUrl, status: 'shipped' });
    else leads.update(leadId, { status: 'shipped' });

    runs.finish(runId, { state: 'completed', detail: { liveUrl, projectUrl, sessionId } });
    emit('builder.done', { worker: 'builder', leadId, runId, buildId, liveUrl, projectUrl, sessionId });

    return { liveUrl, projectUrl, brief, sessionId };
  } finally {
    try {
      await client.sessions.stop(sessionId);
    } catch (err) {
      log.warn('browser-use session stop failed', { sessionId, error: err?.message || String(err) });
    }
  }
}

async function buildBrief({ lead, profileDoc, postMortemDoc }) {
  const profile = parseDocContent(profileDoc);
  const postMortem = parseDocContent(postMortemDoc);
  const latestPayment = payments.listByLead(lead.id)[0];
  const recentMail = contactEvents
    .listByLead(lead.id, { limit: 8 })
    .filter((e) => e.channel === 'agentmail')
    .map((e) => `${e.direction}: ${e.subject || ''} ${e.body || ''}`.trim())
    .slice(0, 5)
    .join('\n');
  const niche = (lead.niche || profile?.niche || 'local services').toLowerCase();
  const style = pickStyle(niche);

  const prompt = [
    `Write a ~300-word Lovable build brief for a small business website.`,
    `Business: ${lead.business_name}`,
    `Niche: ${niche}`,
    `City: ${lead.city || profile?.city || 'their local area'}`,
    `Phone: ${lead.phone || profile?.phone || '(use placeholder)'}`,
    `Hours: ${profile?.hours || 'unknown'}`,
    `Online presence audit: ${profile?.onlinePresenceStrength || 'unknown'} — ${profile?.onlinePresenceSummary || 'no summary'}`,
    `Owner hypothesis: ${profile?.ownerHypothesis || profile?.owner || 'unknown'}`,
    `What they do: ${profile?.summary || profile?.whatTheyDo || profile?.description || 'see profile'}`,
    `Specific business needs: ${Array.isArray(profile?.needs) ? profile.needs.join('; ') : 'contact path, service clarity, trust proof'}`,
    `From the post-mortem, the customer cared about: ${postMortem?.customerCares || postMortem?.summary || postMortem?.reason || 'standard concerns for this niche'}`,
    `Customer questions/details from AgentMail: ${recentMail || 'none yet'}`,
    `Invoice/customer context: ${latestPayment ? `invoice ${latestPayment.stripe_invoice_id || latestPayment.id}, status ${latestPayment.status}, amount $${((latestPayment.amount_cents || 0) / 100).toFixed(2)}` : 'no invoice row found'}`,
    `Required pages: Home, Services, Contact. Add Hours if relevant.`,
    `Tone/style: ${style.tone}. Color palette: ${style.palette}.`,
    `Primary CTAs: tap-to-call phone number, "Book online" button.`,
    `Avoid generic stock-photo language; reference real services and local credibility.`,
    `Output a single concrete brief addressed to Lovable — no markdown headings, no preamble, just the brief.`
  ].join('\n');

  try {
    const text = await generateText({
      prompt,
      systemInstruction: 'You write tight, concrete website briefs for Lovable. No fluff. No headings.',
      thinkingLevel: 'low'
    });
    const trimmed = (text || '').trim();
    if (trimmed.length > 50) return trimmed;
  } catch (err) {
    log.warn('builder brief gemini failed; using fallback', { error: err?.message || String(err) });
  }

  return fallbackBrief({ lead, niche, style });
}

function fallbackBrief({ lead, niche, style }) {
  return [
    `Build a ${style.tone} website for ${lead.business_name}, a ${niche} business in ${lead.city || 'the local area'}.`,
    `Pages: Home (hero with phone and Book Online CTA), Services (list typical ${niche} services with short copy), Contact (address, hours, embedded map, tap-to-call ${lead.phone || 'TBD'}).`,
    `Use a ${style.palette} palette. Avoid generic stock photos; lean on credible local-business imagery and clear typography.`,
    `Make the phone number tap-to-call on mobile and pin a sticky "Call now" button in the header.`,
    `Keep copy concrete and local; reference the city by name once on the home page.`
  ].join(' ');
}

function pickStyle(niche) {
  const n = niche || '';
  if (/(barber|salon|spa|nail|tattoo|hair)/i.test(n)) return { tone: 'warm and stylish', palette: 'warm neutrals with a single bold accent' };
  if (/(law|legal|accountant|tax|cpa|bookkeep|paralegal|finance)/i.test(n)) return { tone: 'professional and trustworthy', palette: 'navy and white with subtle gold' };
  if (/(kids|party|toy|playground|daycare|ice cream|cafe|bakery)/i.test(n)) return { tone: 'playful and friendly', palette: 'soft pastels with a punchy accent' };
  if (/(plumb|hvac|electric|roof|contractor|landscap|auto|repair|mechanic)/i.test(n)) return { tone: 'rugged and dependable', palette: 'deep blue and safety orange on white' };
  return { tone: 'clean and professional', palette: 'neutral with a single brand accent' };
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

function summarizeMsg(msg) {
  if (!msg) return null;
  if (typeof msg === 'string') return msg.slice(0, 240);
  const text = msg?.summary || msg?.text || msg?.message || msg?.action || msg?.event || msg?.type;
  if (text) return String(text).slice(0, 240);
  try { return JSON.stringify(msg).slice(0, 240); } catch { return null; }
}

function findLovableUrl(value) {
  if (!value) return null;
  const haystack = typeof value === 'string' ? value : safeStringify(value);
  const m = haystack.match(LOVABLE_RE);
  return m ? m[0] : null;
}

function isAuthWall(text) {
  return /\b(BLOCKED_AUTH|login wall|sign in|sign-in|log in|auth needed|authenticate|continue with google)\b/i.test(text || '');
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
