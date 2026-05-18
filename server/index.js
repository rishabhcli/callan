import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { log } from './logger.js';
import { attachStream, emit } from './sse.js';
import { leads, runs, calls, payments, builds, contactEvents, webhookEvents, doNotCall, events as eventStore, auditTrail, reasoningTraces, scheduledCalls as scheduledCallsDb, subscriptions, db, leadCosts } from './db.js';
import { marginForLead } from './costs.js';
import { DiscoverRequest, CallRequest, FollowupRequest, BuildRequest } from './types.js';
import {
  listKinds,
  memoryBusinesses,
  memoryForLead,
  memoryObservability,
  retryFailedWrites,
  search as searchMemory
} from './memory.js';
import { handleAgentPhoneWebhook, verifyAgentPhone } from './webhooks/agentphone.js';
import { agentMailWebhookEventId, isInboundAgentMailWebhook, normalizeAgentMailWebhook, verifyAgentMail } from './webhooks/agentmail.js';
import { processStripeWebhookEvent, verifyStripe } from './webhooks/stripe.js';
import { acceptHostingSubscription, handleStripeSubscriptionEvent } from './hostingSubscription.js';
import { liveReadiness } from './readiness.js';
import { fulfillmentReadiness } from './fulfillment/targets.js';
import { fulfillmentQueueSnapshot } from './fulfillment/queue.js';
import { recoverTriggeredPaymentBuilds, revenueHealthSummary, revenueStatusForLead } from './paymentFlow.js';
import { listExperimentKeys, rollup as experimentRollup } from './experiments.js';
import { callabilityForLead, normalizePhone, recordingDisclosure } from './compliance.js';
import {
  approveLeadForLiveCall,
  blockLeadForOutreach,
  canRouteCallLead,
  explainLeadCallability as explainOutreachCallability,
  forceRetryLeadOutreach,
  optOutLeadFromOutreach,
  outreachRouteSmoke,
  outreachStatus,
  pauseOutreachLoop,
  resumeOutreachLoop,
  startOutreachLoop,
  stopOutreachLoop
} from './outreach.js';
import { reputationStatus, startReputationLoop } from './reputation.js';
import { topPriorityLeads, nicheWinRateMap } from './leadPriority.js';
import { runScraper } from './workers/scraper.js';
import { runCaller } from './workers/caller.js';
import { runAnalyst } from './workers/analyst.js';
import { handleAgentMailInbound, runMailer } from './workers/mailer.js';
import { runBuilder } from './workers/builder.js';
import { runScheduledCaller } from './workers/scheduledCaller.js';
import {
  registerScheduledCallDispatcher,
  startScheduledCallLoop,
  cancelScheduledCall,
  fireScheduledCallNow
} from './scheduledCalls.js';
import { ensureOperatorTransferConfigured } from './operatorTransfer.js';
import {
  createBrowserUseResearchJob,
  getBrowserResearchStatus,
  listBrowserUseResearchSessions,
  runBrowserUseResearchJob,
  stopBrowserUseResearchJob
} from './research/browserUseSwarm.js';
import { BrowserUseLovableAdapter, normalizeBrowserUseSessionSnapshot } from './providers/browserUse.js';
import { generateGrowthPlanForLead, growthStatus, readGrowthState, recordGrowthCustomerResponse, sendGrowthRecap } from './growth/index.js';
import { mossStatusForLead } from './moss/hotIndex.js';
import { buildQaReadModel } from './fulfillment/hooks/index.js';
import { recordReferralClick, referralRollup, totalReferralClicks } from './referrals.js';
import {
  acceptQuote as portalAcceptQuote,
  requestEdit as portalRequestEdit,
  bookCallback as portalBookCallback,
  optOut as portalOptOut,
  quoteStatusForLead,
  paymentLinksForLead,
  pendingCallbackForLead
} from './customerPortal.js';

const app = express();
app.use(cors());

// Raw body for webhook signature checks
const rawBodySaver = (req, _res, buf) => { req.rawBody = buf; };
app.use('/api/webhooks', express.json({ verify: rawBodySaver }));
app.use(express.json({ limit: '1mb' }));

const fire = (worker, args, fn) => {
  Promise.resolve()
    .then(() => fn(args))
    .catch((err) => {
      log.error(`${worker}.unhandled`, { error: err.message });
      emit(`${worker}.error`, { worker, error: err.message, ...args });
    });
};

/**
 * Look up the customer-email-thread context for a paid lead so the builder's
 * onLiveUrl callback can send the "Watch your site come together" email in
 * the same AgentMail thread the invoice was in.
 *
 * Sources, in priority order:
 *   - `payments.customer_email` (set when Stripe webhook records the paid event)
 *   - the latest inbound AgentMail contact_event for the lead (their reply)
 *   - the latest outbound AgentMail contact_event provides messageId + threadId
 *
 * Returns null if we can't reconstruct enough to send.
 */
function findEmailContextForLead(leadId) {
  if (!leadId) return null;
  try {
    const lead = leads.get(leadId);
    if (!lead) return null;
    const outbound = db.prepare(`
      SELECT provider_id, thread_id, subject
      FROM contact_events
      WHERE lead_id = ? AND channel = 'agentmail' AND direction = 'outbound'
        AND provider_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(leadId);
    const payment = db.prepare(`
      SELECT customer_email
      FROM payments
      WHERE lead_id = ? AND customer_email IS NOT NULL AND customer_email != ''
      ORDER BY paid_at DESC, created_at DESC
      LIMIT 1
    `).get(leadId);
    const customerEmail = payment?.customer_email || null;
    if (!outbound || !customerEmail) return null;
    return {
      messageId: outbound.provider_id,
      threadId: outbound.thread_id || lead.agentmail_thread_id,
      customerEmail,
      businessName: lead.business_name
    };
  } catch (err) {
    log.warn('builder.email_context_lookup_failed', { leadId, error: err?.message || String(err) });
    return null;
  }
}

/**
 * Wraps runBuilder with the onLiveUrl callback that emails the customer the
 * Browser Use live URL the moment the build session starts. Lazy-imports
 * sendPreviewBuildEmail to avoid a circular dep at module load.
 */
const startBuilder = (args) => fire('builder', { ...args }, async (a) => {
  const { sendPreviewBuildEmail } = await import('./workers/mailer.js');
  const onLiveUrl = async (liveUrl, ctx) => {
    const ec = findEmailContextForLead(a.leadId);
    if (!ec) {
      log.warn('builder.live_url.skipped', { leadId: a.leadId, reason: 'no_email_context' });
      return;
    }
    try {
      await sendPreviewBuildEmail({
        leadId: a.leadId,
        liveUrl,
        inReplyToMessageId: ec.messageId,
        threadId: ec.threadId,
        toEmail: ec.customerEmail,
        businessName: ec.businessName,
        buildId: ctx?.buildId,
        sessionId: ctx?.sessionId,
        mock: !!ctx?.mock
      });
    } catch (err) {
      log.warn('builder.live_url.email_failed', { leadId: a.leadId, error: err?.message || String(err) });
    }
  };
  return runBuilder({ ...a, onLiveUrl });
});

app.get('/api/health', (_req, res) => {
  const readiness = liveReadiness();
  const since24h = Date.now() - 24 * 3600 * 1000;
  let economics24h = null;
  try {
    economics24h = economicsByNiche({ since: since24h }).totals;
  } catch (err) {
    log.warn('health.economics_rollup_failed', { error: err?.message || String(err) });
    economics24h = { costUsd: 0, revenueUsd: 0, marginUsd: 0, marginPct: null, leads: 0 };
  }
  res.json({
    ok: true,
    ts: Date.now(),
    mode: env.runMode,
    live: env.live,
    readiness,
    providers: Object.fromEntries(Object.entries(readiness.providers).map(([k, v]) => [k, v.configured])),
    providerReadiness: readiness.providers,
    liveBlockers: readiness.blockers,
    productionBlockers: readiness.productionBlockers,
    canGoLive: readiness.canGoLive,
    sideEffects: readiness.sideEffects,
    compliance: readiness.compliance,
    nextActions: readiness.nextActions,
    smoke: readiness.smoke,
    quotas: readiness.outreach,
    quotaPolicies: readiness.quotas,
    webhooks: readiness.webhooks,
    browserUseStatus: browserUseStatusSummary(),
    reasoning: reasoningTraces.summary(),
    growth: growthStatus(),
    revenue: {
      ...revenueHealthSummary(),
      mrrUsd: subscriptions.activeMrrCents() / 100,
      subscriptionsByStatus: subscriptions.countByStatus(),
      costsUsd24h: economics24h?.costUsd ?? 0,
      marginUsd24h: economics24h?.marginUsd ?? 0
    },
    referrals: {
      totalClicks: totalReferralClicks(),
      topReferrers: referralRollup({ limit: 10 })
    },
    lastErrors: Object.fromEntries(Object.entries(readiness.providers).map(([k, v]) => [k, v.lastError]).filter(([, v]) => v)),
    hackathon: env.hackathon
  });
});

app.get('/api/revenue/status', (_req, res) => {
  res.json(revenueHealthSummary());
});

app.get('/api/fulfillment/status', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    readiness: fulfillmentReadiness(),
    queue: fulfillmentQueueSnapshot()
  });
});

app.get('/api/status', (_req, res) => {
  const readiness = liveReadiness();
  res.json({
    ok: readiness.ready,
    mode: readiness.mode,
    ready: readiness.ready,
    canGoLive: readiness.canGoLive,
    blockers: readiness.blockers,
    productionBlockers: readiness.productionBlockers,
    sideEffects: readiness.sideEffects,
    outreach: readiness.outreach,
    nextActions: readiness.nextActions
  });
});

app.get('/api/readiness', (_req, res) => {
  res.json(liveReadiness());
});

app.get('/api/growth/status', (_req, res) => {
  res.json(growthStatus());
});

app.get('/api/production-readiness', (_req, res) => {
  const readiness = liveReadiness();
  res.json({
    ok: readiness.canGoLive,
    mode: readiness.mode,
    canGoLive: readiness.canGoLive,
    productionBlockers: readiness.productionBlockers,
    providers: readiness.providers,
    webhooks: readiness.webhooks,
    sideEffects: readiness.sideEffects,
    compliance: readiness.compliance,
    quotas: readiness.quotas,
    nextActions: readiness.nextActions,
    docs: readiness.docs
  });
});

app.get('/api/safety/status', (_req, res) => {
  const readiness = liveReadiness();
  res.json({
    ok: readiness.ready,
    mode: readiness.mode,
    sideEffects: readiness.sideEffects,
    compliance: readiness.compliance,
    webhooks: readiness.webhooks,
    blockers: readiness.blockers
  });
});

app.get('/api/events/stream', (req, res) => attachStream(req, res));

app.get('/api/reasoning/traces', (req, res) => {
  res.json({
    traces: reasoningTraces.list({
      lead_id: req.query?.leadId || undefined,
      worker: req.query?.worker || undefined,
      schema_name: req.query?.schemaName || undefined,
      limit: boundedLimit(req.query?.limit, 100, 500)
    })
  });
});

app.get('/api/leads', (_req, res) => {
  res.json({ leads: leads.list() });
});

app.get('/api/economics/by-niche', (req, res) => {
  try {
    const since = parseSince(req.query?.since);
    const rollup = economicsByNiche({ since });
    res.json({
      generatedAt: Date.now(),
      since,
      ...rollup
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/leads/priorities', (req, res) => {
  try {
    const limit = boundedLimit(req.query?.limit, 30, 100);
    const top = topPriorityLeads({ limit });
    const winRates = nicheWinRateMap({});
    res.json({
      generatedAt: Date.now(),
      limit,
      leads: top,
      nicheWinRates: winRates
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/memory/businesses', (_req, res) => {
  res.json({ businesses: memoryBusinesses() });
});

app.get('/api/memory/observability', (_req, res) => {
  res.json(memoryObservability());
});

app.post('/api/memory/retry-failed', async (req, res) => {
  try {
    const result = await retryFailedWrites({ limit: req.body?.limit || 25 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const callRows = calls.listByLead(lead.id);
  const paymentRows = payments.listByLead(lead.id);
  const buildRows = builds.listByLead(lead.id);
  const runRows = runs.list({ lead_id: lead.id });
  const contactRows = contactEvents.listByLead(lead.id);
  const auditTimeline = auditTrail.timelineByLead(lead.id, { limit: 150 });
  const leadHistory = leads.history(lead.id);
  const leadReasoningTraces = reasoningTraces.listByLead(lead.id, { limit: 80 });
  const builderEvents = eventStore.listByLead(lead.id, { worker: 'builder', limit: 100 });
  const builderState = buildBuilderReadModel({ lead, buildRows, builderEvents });
  const builderQa = buildQaReadModel({ leadId: lead.id, buildId: buildRows[0]?.id || null });
  const researchProfile = safeJson(lead.research_json);
  const growth = await readGrowthState(lead.id);
  const moss = mossStatusForLead(lead.id);
  let memory = null;
  try {
    memory = await listKinds(lead.container_tag);
  } catch (err) {
    log.warn('memory.list failed', { error: err.message });
  }
  let margin = null;
  try {
    margin = marginForLead(lead.id);
  } catch (err) {
    log.warn('lead.margin_lookup_failed', { leadId: lead.id, error: err?.message || String(err) });
  }
  res.json({
    lead,
    calls: callRows,
    payments: paymentRows,
    builds: buildRows,
    runs: runRows,
    leadHistory,
    auditTimeline,
    researchProfile,
    memory,
    contactEvents: contactRows,
    outreachStatus: lead.outreach_status,
    riskStatus: lead.risk_status,
    latestThread: latestAgentMailThread(contactRows, lead),
    latestInvoice: paymentRows[0] || null,
    buildStatus: builderState.status,
    builderState,
    builderQa,
    reasoningTraces: leadReasoningTraces,
    moss,
    growth,
    margin
  });
});

app.get('/api/leads/:id/reasoning', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json({
    leadId: lead.id,
    traces: reasoningTraces.listByLead(lead.id, { limit: boundedLimit(req.query?.limit, 100, 500) })
  });
});

app.get('/api/leads/:id/build-qa', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const buildRows = builds.listByLead(lead.id);
  res.json(buildQaReadModel({ leadId: lead.id, buildId: buildRows[0]?.id || null }));
});

app.get('/api/leads/:id/moss', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json({ leadId: lead.id, ...mossStatusForLead(lead.id) });
});

app.get('/api/leads/:id/memory', async (req, res) => {
  try {
    const memory = await memoryForLead(req.params.id);
    if (!memory) return res.status(404).json({ error: 'lead not found' });
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/:id/memory/search', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const q = String(req.body?.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const results = await searchMemory(lead.container_tag, q, {
      kind: req.body?.kind || undefined,
      limit: req.body?.limit || 8,
      filters: req.body?.filters || null
    });
    res.json({ leadId: lead.id, containerTag: lead.container_tag, q, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id/growth', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json(await readGrowthState(lead.id));
});

app.post('/api/leads/:id/growth/plan', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = await generateGrowthPlanForLead({
      leadId: lead.id,
      force: req.body?.force === true,
      source: req.body?.source || 'api'
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/leads/:id/growth/followup', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = await sendGrowthRecap({
      leadId: lead.id,
      toEmail: req.body?.toEmail,
      force: req.body?.force === true
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/leads/:id/growth/replies', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = await recordGrowthCustomerResponse({
      leadId: lead.id,
      subject: req.body?.subject,
      message: req.body?.message || req.body?.body || '',
      threadId: req.body?.threadId,
      providerId: req.body?.providerId
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/leads/discover', (req, res) => {
  const parsed = DiscoverRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  fire('scraper', parsed.data, runScraper);
  res.status(202).json({ accepted: true });
});

app.post('/api/research/start', (req, res) => {
  const parsed = researchStartBody(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const job = createBrowserUseResearchJob(parsed.value);
  fire('browser_research', { jobId: job.id }, runBrowserUseResearchJob);
  res.status(202).json({
    accepted: true,
    jobId: job.id,
    job,
    status: getBrowserResearchStatus({ jobId: job.id })
  });
});

app.post('/api/research/stop', async (req, res) => {
  try {
    const result = await stopBrowserUseResearchJob({
      jobId: cleanText(req.body?.jobId || req.body?.job_id),
      strategy: cleanText(req.body?.strategy) || 'session'
    });
    res.json({ ...result, status: getBrowserResearchStatus({ jobId: result.jobId }) });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/research/status', (req, res) => {
  res.json(getBrowserResearchStatus({ jobId: cleanText(req.query?.jobId || req.query?.job_id) }));
});

app.get('/api/research/sessions', (req, res) => {
  res.json({
    sessions: listBrowserUseResearchSessions({
      jobId: cleanText(req.query?.jobId || req.query?.job_id),
      activeOnly: req.query?.active === '1' || req.query?.active === 'true'
    })
  });
});

// Visible mock browser-use window: gives operators something to see when
// LIVE_BROWSER_RESEARCH is off. Real Browser Use sessions return their own
// liveUrl that points to docs.browser-use.com.
app.get('/mock/browser-use/:jobId/:sourceType', (req, res) => {
  const jobId = String(req.params.jobId || '');
  const sourceType = String(req.params.sourceType || '');
  const status = getBrowserResearchStatus({ jobId });
  const session = (status?.sessions || []).find((s) => s.sourceType === sourceType) || null;
  const businesses = (status?.businesses || []).filter((b) => (b.sources || []).some((src) => src.sourceType === sourceType));
  const job = status?.job || null;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderMockBrowserWindow({ jobId, sourceType, session, businesses, job }));
});

function renderMockBrowserWindow({ jobId, sourceType, session, businesses, job }) {
  const sourceLabel = session?.sourceLabel || sourceType || 'source';
  const niche = job?.niche || 'business';
  const city = job?.city || 'city';
  const url = `https://example.com/${escapeHtml(sourceType)}/${encodeURIComponent(niche)}-${encodeURIComponent(city)}`;
  const step = session?.lastStepSummary || 'Waiting for Browser Use...';
  const status = session?.normalizedStatus || 'queued';
  const cards = (businesses || []).slice(0, 8).map((b) => `
    <div class="biz">
      <div class="biz-name">${escapeHtml(b.businessName)}</div>
      <div class="biz-meta">${escapeHtml(b.address || 'address pending')}</div>
      <div class="biz-meta">${escapeHtml(b.phone || 'phone pending')} · ${escapeHtml(b.websiteUrl || 'no owned site')}</div>
      <div class="biz-presence presence-${escapeHtml(b.presenceStrength || 'unknown')}">${escapeHtml((b.presenceStrength || 'unknown').toUpperCase())} presence</div>
    </div>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Browser Use · ${escapeHtml(sourceLabel)}</title>
<meta http-equiv="refresh" content="2">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1116; color: #e6edf3; }
.chrome { background: #161b22; border-bottom: 1px solid #30363d; padding: 6px 10px; display: flex; align-items: center; gap: 8px; }
.dots { display: flex; gap: 4px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #ff5f56; }
.dot.y { background: #ffbd2e; }
.dot.g { background: #27c93f; }
.url { flex: 1; background: #0d1116; border: 1px solid #30363d; padding: 4px 10px; font-size: 12px; color: #8b949e; border-radius: 4px; }
.tag { font-size: 10px; padding: 2px 6px; border: 1px solid #30363d; color: #58a6ff; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
.tag.live { color: #f97316; border-color: #f97316; animation: pulse 1.5s infinite; }
.tag.completed { color: #2ea043; border-color: #2ea043; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.body { padding: 14px 18px; }
.crumb { color: #8b949e; font-size: 11px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
h1 { margin: 0 0 4px; font-size: 18px; }
.lead { color: #8b949e; font-size: 12px; margin-bottom: 14px; }
.step { background: #161b22; border: 1px solid #30363d; padding: 8px 10px; font-size: 12px; color: #c9d1d9; margin-bottom: 16px; border-radius: 4px; }
.cursor { display: inline-block; width: 7px; height: 13px; background: #58a6ff; vertical-align: middle; margin-left: 4px; animation: blink 1s steps(2, start) infinite; }
@keyframes blink { to { visibility: hidden; } }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.biz { border: 1px solid #30363d; background: #0d1116; padding: 10px; border-radius: 4px; }
.biz-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.biz-meta { color: #8b949e; font-size: 11px; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.biz-presence { margin-top: 6px; font-size: 10px; letter-spacing: 0.08em; padding: 1px 6px; border-radius: 2px; display: inline-block; }
.presence-none, .presence-weak { background: rgba(46, 160, 67, 0.15); color: #56d364; }
.presence-mixed { background: rgba(187, 128, 9, 0.2); color: #f0883e; }
.presence-strong { background: rgba(248, 81, 73, 0.15); color: #f85149; }
.empty { color: #6e7681; font-size: 12px; padding: 30px; text-align: center; border: 1px dashed #30363d; border-radius: 4px; }
</style></head>
<body>
  <div class="chrome">
    <div class="dots"><span class="dot"></span><span class="dot y"></span><span class="dot g"></span></div>
    <div class="url">${escapeHtml(url)}</div>
    <span class="tag ${escapeHtml(status === 'completed' ? 'completed' : 'live')}">${escapeHtml(status)}</span>
  </div>
  <div class="body">
    <div class="crumb">Browser Use · ${escapeHtml(sourceLabel)} · job ${escapeHtml(jobId)}</div>
    <h1>${escapeHtml(niche)} in ${escapeHtml(city)}</h1>
    <div class="lead">Mock browser session. Each refresh shows the latest agent step + extracted businesses.</div>
    <div class="step">${escapeHtml(step)}<span class="cursor"></span></div>
    ${cards ? `<div class="grid">${cards}</div>` : `<div class="empty">Agent is still reading the page...</div>`}
  </div>
</body></html>`;
}

app.post('/api/leads/:id/call', (req, res) => {
  const parsed = CallRequest.safeParse({ leadId: req.params.id, ...req.body });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const lead = leads.get(parsed.data.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const phone = parsed.data.toPhone || lead.phone;
  if (env.runMode !== 'mock') {
    const gate = canRouteCallLead(lead.id, { explicitPhone: phone });
    if (!gate.ok) return res.status(409).json({ error: 'callability blocked', explanation: gate.explanation });
  }
  fire('caller', { leadId: lead.id, toPhone: phone }, runCaller);
  res.status(202).json({ accepted: true, mode: env.runMode });
});

app.post('/api/leads/:id/approve-live-call', (req, res) => {
  const result = approveLeadForLiveCall(req.params.id, { reason: req.body?.reason });
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json(result);
});

app.post('/api/leads/:id/block', (req, res) => {
  const reasonCode = reasonCodeFor(req.body?.reasonCode || req.body?.code || 'operator_blocked');
  const reason = cleanText(req.body?.reason) || 'Operator blocked lead before outreach';
  const result = blockLeadForOutreach(req.params.id, { reason: reasonCode });
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json({ ...result, blocker: { code: reasonCode, reason, source: 'operator' } });
});

app.post('/api/leads/:id/opt-out', (req, res) => {
  const reasonCode = reasonCodeFor(req.body?.reasonCode || 'operator_opt_out');
  const reason = cleanText(req.body?.reason) || 'Operator recorded do-not-call opt-out';
  const result = optOutLeadFromOutreach(req.params.id, { reason });
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json({ ...result, blocker: { code: reasonCode, reason, source: 'operator', phone: result.phone } });
});

app.post('/api/leads/:id/force-retry', (req, res) => {
  const reasonCode = reasonCodeFor(req.body?.reasonCode || 'operator_force_retry');
  const reason = cleanText(req.body?.reason) || 'Operator forced retry into outreach queue';
  const result = forceRetryLeadOutreach(req.params.id, { reason });
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json({ ...result, queueStatus: 'queued', reason: { code: reasonCode, reason, source: 'operator' } });
});

app.get('/api/leads/:id/callability', (req, res) => {
  const result = explainOutreachCallability(req.params.id, { explicitPhone: req.query?.phone });
  if (!result.ok && result.blockers?.[0]?.name === 'lead_found') return res.status(404).json(result);
  res.json(result);
});

app.get('/api/leads/:id/revenue', (req, res) => {
  const result = revenueStatusForLead(req.params.id);
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json(result);
});

app.post('/api/outreach/start', (_req, res) => {
  res.json(resumeOutreachLoop({ reason: 'operator_start' }));
});

app.post('/api/outreach/stop', (_req, res) => {
  res.json(stopOutreachLoop());
});

app.post('/api/emergency-stop', (req, res) => {
  const result = stopOutreachLoop({ reason: req.body?.reason || 'emergency_stop' });
  emit('safety.emergency_stop', { worker: 'operator', mode: env.runMode, reason: req.body?.reason || 'emergency_stop' });
  res.json({ ok: true, ...result });
});

app.post('/api/outreach/pause', (req, res) => {
  res.json(pauseOutreachLoop({ reason: req.body?.reason || 'operator_pause' }));
});

app.post('/api/outreach/resume', (req, res) => {
  res.json(resumeOutreachLoop({ reason: req.body?.reason || 'operator_resume' }));
});

app.get('/api/outreach/status', (_req, res) => {
  res.json(outreachStatus());
});

app.get('/api/outreach/routes', (_req, res) => {
  res.json(outreachRouteSmoke());
});

app.get('/api/reputation/status', async (_req, res) => {
  try {
    const payload = await reputationStatus();
    res.json(payload);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get('/api/browser-use/sessions', async (req, res) => {
  const limit = boundedLimit(req.query?.limit, 80, 200);
  const hydrate = req.query?.hydrate !== 'false';
  const rows = db.prepare(`
    SELECT
      b.*,
      l.business_name,
      l.niche,
      l.city,
      l.source_url,
      l.website AS lead_website,
      l.status AS lead_status
    FROM builds b
    LEFT JOIN leads l ON l.id = b.lead_id
    ORDER BY COALESCE(b.updated_at, b.started_at, 0) DESC
    LIMIT ?
  `).all(limit);

  const sessions = [];
  for (const row of rows) {
    sessions.push(await browserUseSessionFromBuild(row, { hydrate }));
  }

  res.json({
    ok: true,
    ts: Date.now(),
    mode: env.runMode,
    docs: {
      getSession: 'https://docs.browser-use.com/cloud/api-v3/sessions/get-session',
      livePreview: 'https://docs.browser-use.com/cloud/browser/live-preview',
      pricing: 'https://docs.browser-use.com/cloud/pricing'
    },
    counts: countBrowserUseSessions(sessions),
    telemetry: browserUseTelemetry(sessions),
    sessions
  });
});

app.get('/api/browser-use/events', (req, res) => {
  const limit = boundedLimit(req.query?.limit, 120, 300);
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT *
      FROM events
      WHERE
        type LIKE 'browserUse.%'
        OR type LIKE 'builder.%'
        OR type IN ('scraper.profile', 'scraper.item.failed', 'scraper.item.skipped')
      ORDER BY ts DESC, id DESC
      LIMIT ?
    )
    ORDER BY ts ASC, id ASC
  `).all(limit);

  const events = rows.map((row) => normalizeBrowserUseEvent(row)).filter(Boolean);
  res.json({
    ok: true,
    ts: Date.now(),
    mode: env.runMode,
    count: events.length,
    events
  });
});

app.post('/api/browser-use/sessions/:id/stop', async (req, res) => {
  const sessionId = cleanText(req.params.id);
  if (!sessionId) return res.status(400).json({ error: 'session id required' });
  const row = findBrowserUseBuild(sessionId);
  if (!row) return res.status(404).json({ error: 'browser use session not found' });

  const before = await browserUseSessionFromBuild(row, { hydrate: false });
  const mock = before.badges.mock || !isBrowserUseUuid(sessionId);
  let providerSession = null;
  let liveStopped = false;

  if (!mock) {
    if (!env.live.builds || !env.browserUse.apiKey) {
      return res.status(409).json({
        error: 'live Browser Use stop is gated',
        reason: 'Set LIVE_BUILDS=true with BROWSER_USE_API_KEY to stop a real cloud session.',
        session: before
      });
    }
    const adapter = new BrowserUseLovableAdapter({
      apiKey: env.browserUse.apiKey,
      baseUrl: env.browserUse.baseUrl
    });
    providerSession = await adapter.stopSession(sessionId);
    liveStopped = true;
  } else {
    providerSession = normalizeBrowserUseSessionSnapshot({
      id: sessionId,
      status: 'stopped',
      model: before.model,
      liveUrl: before.liveUrl,
      stepCount: before.stepCount,
      lastStepSummary: 'Operator stopped the synthetic Browser Use session.',
      totalInputTokens: before.totalInputTokens,
      totalOutputTokens: before.totalOutputTokens,
      llmCostUsd: before.llmCostUsd,
      proxyCostUsd: before.proxyCostUsd,
      browserCostUsd: before.browserCostUsd,
      totalCostUsd: before.totalCostUsd,
      screenshotUrl: before.screenshotUrl,
      integrationsUsed: before.integrationsUsed,
      updatedAt: new Date().toISOString()
    });
  }

  builds.update(row.id, { status: 'stopped', finished_at: Date.now(), error: null });
  emit('browserUse.session.stopped', {
    worker: 'builder',
    leadId: row.lead_id,
    buildId: row.id,
    sessionId,
    model: providerSession?.model || before.model,
    status: 'stopped',
    summary: 'Operator stopped Browser Use session.',
    liveUrl: providerSession?.liveUrl || before.liveUrl,
    stepCount: providerSession?.stepCount ?? before.stepCount,
    totalCostUsd: providerSession?.totalCostUsd || before.totalCostUsd,
    mock: !liveStopped
  });
  emit('builder.progress', {
    worker: 'builder',
    leadId: row.lead_id,
    buildId: row.id,
    sessionId,
    summary: 'Operator stopped Browser Use session.',
    liveUrl: providerSession?.liveUrl || before.liveUrl,
    stepCount: providerSession?.stepCount ?? before.stepCount,
    totalCostUsd: providerSession?.totalCostUsd || before.totalCostUsd,
    mock: !liveStopped
  });

  const updated = findBrowserUseBuild(sessionId);
  res.json({
    ok: true,
    liveStopped,
    session: await browserUseSessionFromBuild(updated, { hydrate: false, providerSession })
  });
});

app.post('/api/leads/:id/followup', (req, res) => {
  const parsed = FollowupRequest.safeParse({ leadId: req.params.id, ...req.body });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const lead = leads.get(parsed.data.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  fire('mailer', { leadId: lead.id, toEmail: parsed.data.toEmail }, runMailer);
  res.status(202).json({ accepted: true });
});

app.post('/api/leads/:id/build', (req, res) => {
  const parsed = BuildRequest.safeParse({ leadId: req.params.id, ...req.body });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const lead = leads.get(parsed.data.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const target = parsed.data.target || req.query?.target || undefined;
  fire('builder', { leadId: lead.id, target, images: parsed.data.images || [] }, runBuilder);
  res.status(202).json({ accepted: true, target: target || 'default' });
});

const previewScreenshotAdapter = (() => {
  let adapter = null;
  return () => {
    if (!env.browserUse.apiKey) return null;
    if (!adapter) adapter = new BrowserUseLovableAdapter();
    return adapter;
  };
})();

function sendPreviewScreenshotFallback(res, businessName) {
  const safe = (businessName || 'Your site').replace(/[<>&]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 630"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a0a0a"/><stop offset="1" stop-color="#191d24"/></linearGradient></defs><rect width="1120" height="630" fill="url(#g)"/><rect x="32" y="32" width="1056" height="566" rx="14" fill="#0f0f0f" stroke="#2a2a2a"/><circle cx="68" cy="68" r="6" fill="#ff5f56"/><circle cx="92" cy="68" r="6" fill="#ffbd2e"/><circle cx="116" cy="68" r="6" fill="#27c93f"/><rect x="160" y="58" width="880" height="22" rx="6" fill="#1a1a1a"/><text x="180" y="74" font-family="-apple-system,Segoe UI,sans-serif" font-size="13" fill="#888">lovable.dev/${safe.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)} — building now</text><circle cx="130" cy="180" r="10" fill="#e74c3c"/><text x="155" y="186" font-family="-apple-system,Segoe UI,sans-serif" font-size="16" fill="#e74c3c" font-weight="700">LIVE</text><text x="120" y="290" font-family="-apple-system,Segoe UI,sans-serif" font-size="40" fill="#fafafa" font-weight="700">${safe}</text><text x="120" y="340" font-family="-apple-system,Segoe UI,sans-serif" font-size="20" fill="#aaa">Tap to watch the live build session →</text></svg>`;
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Content-Type', 'image/svg+xml');
  res.send(svg);
}

app.get('/api/preview-build/:buildId/screenshot.png', async (req, res) => {
  const buildId = req.params.buildId;
  const buildRow = builds.get(buildId);
  if (!buildRow) {
    sendPreviewScreenshotFallback(res, 'Your site');
    return;
  }
  const lead = leads.get(buildRow.lead_id);
  const businessName = lead?.business_name || 'Your site';

  const sessionId = buildRow.browser_session_id;
  if (!sessionId || sessionId.startsWith('mock-')) {
    sendPreviewScreenshotFallback(res, businessName);
    return;
  }

  const adapter = previewScreenshotAdapter();
  if (!adapter) {
    sendPreviewScreenshotFallback(res, businessName);
    return;
  }

  try {
    const session = await adapter.getSession(sessionId);
    const shotUrl = session?.screenshotUrl;
    if (!shotUrl) {
      sendPreviewScreenshotFallback(res, businessName);
      return;
    }
    const upstream = await fetch(shotUrl);
    if (!upstream.ok) {
      sendPreviewScreenshotFallback(res, businessName);
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'image/png';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    log.warn('preview_build.screenshot_failed', { buildId, sessionId, err: err?.message || String(err) });
    sendPreviewScreenshotFallback(res, businessName);
  }
});

app.get('/api/leads/:id/build-preview', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).send('<!doctype html><html><body>Lead not found.</body></html>');
  const latest = builds.listByLead(lead.id)[0] || {};
  const projectUrl = latest.project_url || lead.website || '';
  const status = latest.status || 'running';
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(lead.business_name)} build preview</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; background: #080b0d; color: #f1f3f4; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: linear-gradient(135deg, #080b0d 0%, #101820 55%, #172218 100%); }
    main { width: min(760px, calc(100vw - 40px)); border: 1px solid #2c3540; background: rgba(11, 14, 16, 0.92); padding: 28px; }
    .eyebrow { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; color: #7dffb6; }
    h1 { margin: 10px 0 8px; font-size: clamp(28px, 6vw, 48px); line-height: 1; letter-spacing: 0; }
    p { margin: 0; max-width: 56ch; color: #c9ced3; font-size: 16px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 22px; }
    .cell { border: 1px solid #1d242c; background: #10141a; padding: 12px; min-height: 82px; }
    .key { font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: #8b9098; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 8px; font-size: 14px; color: #f1f3f4; overflow-wrap: anywhere; }
    .bar { height: 6px; margin-top: 24px; background: #1d242c; overflow: hidden; }
    .bar span { display: block; height: 100%; width: ${status === 'completed' ? '100' : status === 'failed' ? '42' : '70'}%; background: #7dffb6; }
    a { color: #7dffb6; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">mock Browser Use live preview · ${escapeHtml(status)}</div>
    <h1>${escapeHtml(lead.business_name)}</h1>
    <p>The paid-build path is active. In live mode this panel is replaced by the Browser Use session URL while Lovable generates the site.</p>
    <div class="grid">
      <div class="cell"><div class="key">niche</div><div class="value">${escapeHtml(lead.niche || 'local services')}</div></div>
      <div class="cell"><div class="key">phone</div><div class="value">${escapeHtml(lead.phone || 'not set')}</div></div>
      <div class="cell"><div class="key">final URL</div><div class="value">${projectUrl ? `<a href="${escapeHtml(projectUrl)}" target="_blank" rel="noreferrer">${escapeHtml(projectUrl)}</a>` : 'publishing'}</div></div>
    </div>
    <div class="bar"><span></span></div>
  </main>
</body>
</html>`);
});

app.post('/api/webhooks/agentphone', async (req, res) => {
  const v = verifyAgentPhone(req, req.rawBody || Buffer.from(JSON.stringify(req.body)));
  if (!v.ok) {
    log.warn('agentphone webhook rejected', { reason: v.reason });
    return res.status(401).json({ error: v.reason });
  }
  const result = await handleAgentPhoneWebhook(req);
  res.json(result);
});

app.post('/api/webhooks/agentmail', async (req, res) => {
  const v = verifyAgentMail(req, req.rawBody || Buffer.from(JSON.stringify(req.body)));
  if (!v.ok) return res.status(401).json({ error: v.reason });
  const body = req.body || {};
  const msg = normalizeAgentMailWebhook(body);
  const eventId = agentMailWebhookEventId(req, body, msg);
  const recorded = webhookEvents.recordOnce({ provider: 'agentmail', event_id: eventId, type: msg.eventType, payload: body });
  if (!recorded) return res.json({ ok: true, duplicate: true });
  emit('agentmail.webhook', {
    worker: 'mailer',
    providerType: msg.eventType,
    threadId: msg.threadId,
    fromMasked: maskEmail(msg.fromEmail),
    subject: msg.subject,
    preview: typeof msg.text === 'string' ? msg.text.slice(0, 240) : undefined
  });
  if (isInboundAgentMailWebhook(body, msg)) {
    try {
      const result = await handleAgentMailInbound({ body, normalized: msg, eventId, req });
      return res.json({ ok: true, inbound: result });
    } catch (err) {
      log.error('agentmail.inbound.failed', { error: err?.message || String(err), threadId: msg.threadId });
      emit('mailer.error', { worker: 'mailer', threadId: msg.threadId, error: err?.message || String(err) });
      return res.status(500).json({ error: err?.message || String(err) });
    }
  }
  res.json({ ok: true });
});

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const v = verifyStripe(req.rawBody || req.body, sig);
  if (!v.ok) {
    log.warn('stripe webhook rejected', { reason: v.reason });
    return res.status(400).json({ error: v.reason });
  }
  const event = v.event;
  const result = processStripeWebhookEvent(event, { req, startBuilder });
  let subscription = null;
  if (typeof event?.type === 'string' && event.type.startsWith('customer.subscription.')) {
    try {
      subscription = await handleStripeSubscriptionEvent(event);
    } catch (err) {
      log.warn('hosting_subscription.webhook_failed', {
        eventType: event.type,
        error: err?.message || String(err)
      });
      subscription = { ok: false, reason: 'handler_threw', error: err?.message || String(err) };
    }
  }
  res.json(subscription ? { ...result, subscription } : result);
});

// Customer-facing one-click accept link from the hosting upsell email.
// 302-redirects to the Stripe Checkout URL so the customer never sees JSON.
app.get('/api/hosting/accept/:leadId', async (req, res) => {
  const leadId = String(req.params.leadId || '').trim();
  if (!leadId) return res.status(400).send('leadId required');
  try {
    const { url } = await acceptHostingSubscription({ leadId });
    if (!url) return res.status(502).send('Stripe Checkout URL missing');
    return res.redirect(302, url);
  } catch (err) {
    log.warn('hosting_subscription.accept_failed', {
      leadId,
      error: err?.message || String(err)
    });
    return res.status(500).send(`Could not start hosting subscription: ${err?.message || 'unknown error'}`);
  }
});

// --- per-customer share link (browser-use live preview) ---
// Token is the opaque lead.id (already unguessable in this demo). When we move
// to multi-tenant production, replace this with a signed JWT carrying lead+build+exp.
app.get('/api/share/build/:token', (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  const lead = leads.get(token);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const buildRows = builds.listByLead(lead.id) || [];
  const latest = buildRows[0] || null;
  const builderEvents = eventStore.listByLead(lead.id, { worker: 'builder', limit: 60 });
  const quoteStatus = quoteStatusForLead(lead);
  const { paymentLinkUrl, invoiceUrl } = paymentLinksForLead(lead.id);
  const pendingCallback = pendingCallbackForLead(lead.id);
  res.json({
    business: {
      name: lead.business_name || null,
      niche: lead.niche || null,
      city: lead.city || null
    },
    build: latest ? {
      id: latest.id,
      status: latest.status,
      sessionId: latest.browser_session_id || null,
      liveUrl: latest.live_url || null,
      projectUrl: latest.project_url || null,
      updatedAt: latest.updated_at || null
    } : null,
    timeline: builderEvents.map((e) => ({
      ts: e.ts || e.created_at,
      type: e.type || e.event_type,
      summary: e.summary || e.note || null
    })),
    // Customer-portal state — drives the action cards in ShareView.
    quoteStatus,
    paymentLinkUrl,
    invoiceUrl,
    vertical_pack: lead.vertical_pack || null,
    existingPendingCallback: pendingCallback ? {
      id: pendingCallback.id,
      scheduledAtMs: pendingCallback.scheduled_at_ms,
      status: pendingCallback.status,
      createdAt: pendingCallback.created_at
    } : null
  });
});

// Customer-portal POST endpoints (idempotent; lock by lead.id token).
app.post('/api/share/build/:token/accept', async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!leads.get(token)) return res.status(404).json({ error: 'not found' });
  try {
    const result = await portalAcceptQuote({ leadId: token });
    res.json(result);
  } catch (err) {
    log.warn('portal.accept_quote_failed', { token, error: err?.message || String(err) });
    res.status(500).json({ error: err?.message || 'accept_failed' });
  }
});

app.post('/api/share/build/:token/edit', async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!leads.get(token)) return res.status(404).json({ error: 'not found' });
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'note required' });
  try {
    const result = await portalRequestEdit({ leadId: token, note });
    res.json(result);
  } catch (err) {
    log.warn('portal.request_edit_failed', { token, error: err?.message || String(err) });
    res.status(500).json({ error: err?.message || 'edit_failed' });
  }
});

app.post('/api/share/build/:token/callback', (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!leads.get(token)) return res.status(404).json({ error: 'not found' });
  const scheduledAtMs = Number(req.body?.scheduledAtMs);
  if (!Number.isFinite(scheduledAtMs) || scheduledAtMs <= 0) {
    return res.status(400).json({ error: 'scheduledAtMs required (epoch ms)' });
  }
  const ask = String(req.body?.ask || '').trim();
  try {
    const result = portalBookCallback({ leadId: token, scheduledAtMs, ask });
    res.json(result);
  } catch (err) {
    log.warn('portal.book_callback_failed', { token, error: err?.message || String(err) });
    res.status(500).json({ error: err?.message || 'callback_failed' });
  }
});

app.post('/api/share/build/:token/opt-out', (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!leads.get(token)) return res.status(404).json({ error: 'not found' });
  try {
    const reason = String(req.body?.reason || '').trim() || 'customer_portal_opt_out';
    const result = portalOptOut({ leadId: token, reason });
    res.json(result);
  } catch (err) {
    log.warn('portal.opt_out_failed', { token, error: err?.message || String(err) });
    res.status(500).json({ error: err?.message || 'opt_out_failed' });
  }
});

// Experiments rollup. `GET /api/experiments` returns the full set of known
// experiment keys plus per-arm assignment/conversion/revenue rollups.
app.get('/api/experiments', (_req, res) => {
  const keys = listExperimentKeys();
  const rollups = {};
  for (const key of keys) {
    try { rollups[key] = experimentRollup(key); }
    catch (err) {
      log.warn('experiments.rollup_failed', { key, error: err?.message || String(err) });
      rollups[key] = [];
    }
  }
  res.json({ keys, rollups });
});

// `GET /api/experiments/:key` returns the rollup for a single experiment.
app.get('/api/experiments/:key', (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    res.json({ key, rollup: experimentRollup(key) });
  } catch (err) {
    log.warn('experiments.rollup_failed', { key, error: err?.message || String(err) });
    res.status(500).json({ error: 'rollup_failed' });
  }
});

// Dashboard data: upcoming + recent scheduled callbacks.
app.get('/api/scheduled-calls', (req, res) => {
  const pending = scheduledCallsDb.listPending({ limit: 25 }).map(rowToScheduledCallDTO);
  const recent = scheduledCallsDb.listRecent({ limit: 25 }).map(rowToScheduledCallDTO);
  res.json({ pending, recent });
});

// Operator-cancel a pending scheduled callback (used by the right-rail card).
app.post('/api/scheduled-calls/:id/cancel', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });
  const row = cancelScheduledCall(id, { reason: req.body?.reason || 'operator_cancel' });
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, scheduledCall: rowToScheduledCallDTO(row) });
});

// Operator: fire a pending callback immediately (used by the right-rail "fire now" button).
app.post('/api/scheduled-calls/:id/fire', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });
  const row = fireScheduledCallNow(id, { reason: req.body?.reason || 'operator_fire_now' });
  if (!row) return res.status(409).json({ error: 'row not pending or not found' });
  res.json({ ok: true, scheduledCall: rowToScheduledCallDTO(row) });
});

// --- referral loop -----------------------------------------------------------
// /r/:leadId — log the click, then 302 to the landing page. In production this
// would point to a marketing site; for now we redirect to the dashboard root.
app.get('/r/:leadId', (req, res) => {
  try {
    recordReferralClick(req, req.params?.leadId);
  } catch (err) {
    log.warn('referrals.record_failed', { error: err?.message || String(err) });
  }
  res.redirect(302, '/');
});

// /api/referrals/rollup — top-30 referring leads + total click count. Powers
// the "Built by callmemaybe" rollup in the operator dashboard.
app.get('/api/referrals/rollup', (req, res) => {
  const limit = Number(req.query?.limit);
  const top = referralRollup({ limit: Number.isFinite(limit) && limit > 0 ? limit : 30 });
  res.json({
    ok: true,
    ts: Date.now(),
    totalClicks: totalReferralClicks(),
    topReferrers: top
  });
});

// /api/referrals/landing-html — utility preview that mimics the page a referral
// visitor will land on. Lets the operator eyeball the funnel without leaving
// the dashboard. The form POSTs niche+city to /api/leads/discover.
app.get('/api/referrals/landing-html', (_req, res) => {
  res.type('html').send(renderReferralLandingHtml());
});

app.use(express.static('dist'));
app.get('*', (_req, res) => {
  res.sendFile(`${process.cwd()}/dist/index.html`, (err) => {
    if (err) res.status(200).send('<!doctype html><html><body><p>UI not built. Run <code>npm run build</code>.</p></body></html>');
  });
});

app.listen(env.port, () => {
  log.info(`callmemaybe server listening`, { port: env.port, mode: env.runMode });
  const recovered = recoverTriggeredPaymentBuilds({ startBuilder });
  if (recovered.length) log.warn('builder.recovered_pending_payment_builds', { count: recovered.length });

  // Scheduled-callback service: wire dispatcher then start the loop.
  registerScheduledCallDispatcher(runScheduledCaller);
  startScheduledCallLoop();

  // Reputation auto-throttle: 30s sweep that emits reputation.alert and can
  // pause the outreach loop when opt-out or voicemail-only rates go red.
  try {
    startReputationLoop();
  } catch (err) {
    log.warn('reputation.loop_start_failed', { error: err?.message || String(err) });
  }

  // Inbound email poller — picks up "call me" emails even when the AgentMail
  // webhook isn't pointed at the local tunnel. Bootstraps on first tick.
  import('./agentmailPoller.js').then(({ startAgentMailPoller }) => {
    startAgentMailPoller();
  }).catch((err) => log.warn('agentmail.poll.start_failed', { error: err?.message || String(err) }));

  // One-shot: PATCH the AgentPhone agent record with the operator's transfer
  // number so the platform can warm-transfer any time our server requests it.
  // Cached internally so it only fires once per process boot.
  ensureOperatorTransferConfigured().catch((err) => log.warn('operator.transfer.boot_configure_failed', {
    error: err?.message || String(err)
  }));
});

function rowToScheduledCallDTO(row) {
  if (!row) return null;
  const lead = row.lead_id ? leads.get(row.lead_id) : null;
  let brief = null;
  if (row.brief_json) {
    try { brief = JSON.parse(row.brief_json); } catch { brief = null; }
  }
  return {
    id: row.id,
    leadId: row.lead_id,
    threadId: row.thread_id,
    scheduledAtMs: row.scheduled_at_ms,
    status: row.status,
    brief,
    ask: brief?.ask || null,
    attempts: row.attempts,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    placedCallId: row.placed_call_id,
    failureReason: row.failure_reason,
    lead: lead ? {
      id: lead.id,
      business_name: lead.business_name,
      phone: lead.phone,
      city: lead.city,
      status: lead.status
    } : null
  };
}

function explainLeadCallability(lead) {
  const disclosureText = recordingDisclosure(lead.business_name);
  const callability = callabilityForLead({ lead, disclosureText });
  const readiness = liveReadiness();
  const operatorBlock = latestOperatorBlock(lead.id);
  const blockers = [];

  if (!callability.ok) {
    blockers.push({
      code: reasonCodeFor(callability.reason),
      reason: callability.reason,
      source: 'callability'
    });
  }
  if (lead.outreach_status === 'blocked') {
    blockers.push({
      code: operatorBlock?.reasonCode || reasonCodeFor(lead.risk_status || 'blocked'),
      reason: operatorBlock?.reason || lead.risk_status || 'blocked',
      source: operatorBlock ? 'operator' : 'lead.risk_status'
    });
  }
  for (const reason of readiness.blockers || []) {
    blockers.push({
      code: reasonCodeFor(reason),
      reason,
      source: 'readiness'
    });
  }

  return {
    leadId: lead.id,
    decision: blockers.length ? 'blocked' : 'callable',
    callability: {
      ok: callability.ok,
      reason: callability.reason,
      reasonCode: reasonCodeFor(callability.reason),
      phone: callability.phone || null,
      phoneClassification: callability.phoneClassification || lead.phone_classification || 'unknown'
    },
    blockers: dedupeBlockers(blockers),
    status: statusSnapshot(lead),
    readiness: {
      ready: readiness.ready,
      mode: readiness.mode,
      blockers: readiness.blockers || []
    },
    disclosureText
  };
}

function recordOperatorEvent({ lead, type, reasonCode, reason, previous, extra = {} }) {
  contactEvents.add({
    lead_id: lead.id,
    type,
    direction: 'internal',
    channel: 'operator',
    body: reason,
    metadata: {
      reasonCode,
      previous,
      ...extra
    }
  });
}

function latestOperatorBlock(leadId) {
  const event = contactEvents
    .listByLead(leadId, { limit: 20 })
    .find((row) => row.channel === 'operator' && ['operator_blocked', 'operator_opt_out'].includes(row.type));
  if (!event) return null;
  const metadata = parseJson(event.metadata_json);
  return {
    reasonCode: metadata?.reasonCode || reasonCodeFor(event.type),
    reason: event.body || metadata?.reasonCode || event.type
  };
}

function statusSnapshot(lead) {
  return {
    outreachStatus: lead.outreach_status || 'unknown',
    riskStatus: lead.risk_status || 'unknown',
    consentStatus: lead.consent_status || 'unknown',
    phoneClassification: lead.phone_classification || 'unknown',
    nextAction: lead.next_action || null
  };
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function reasonCodeFor(value) {
  const code = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return code || 'unknown';
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function researchStartBody(body) {
  const city = cleanText(body.city);
  const niche = cleanText(body.niche);
  if (city.length < 2) return { ok: false, error: 'city is required' };
  if (niche.length < 2) return { ok: false, error: 'niche is required' };
  const maxLeads = boundedInt(body.maxLeads ?? body.max_leads ?? body.count, 1, 25, 8);
  const concurrency = boundedInt(body.concurrency, 1, 5, 5);
  const maxCostUsd = boundedMoney(body.maxCostUsd ?? body.max_cost_usd, 0.01, 5, 0.35);
  const mode = ['mock', 'live'].includes(body.mode) ? body.mode : undefined;
  return {
    ok: true,
    value: {
      city,
      niche,
      maxLeads,
      concurrency,
      maxCostUsd,
      mode,
      idempotencyKey: cleanText(body.idempotencyKey || body.idempotency_key) || null
    }
  };
}

function boundedInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseSince(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function revenueByNiche({ since = 0 } = {}) {
  return db.prepare(`
    SELECT COALESCE(l.niche, 'unknown') AS niche,
           SUM(p.amount_cents) AS revenue_cents
    FROM payments p
    JOIN leads l ON l.id = p.lead_id
    WHERE p.status = 'paid'
      AND COALESCE(p.paid_at, p.created_at, 0) >= ?
    GROUP BY COALESCE(l.niche, 'unknown')
  `).all(since || 0).map((row) => ({
    niche: row.niche,
    revenueUsd: (Number(row.revenue_cents) || 0) / 100
  }));
}

function economicsByNiche({ since = 0 } = {}) {
  const costRows = leadCosts.rollupByNiche({ since });
  const revenueRows = revenueByNiche({ since });
  const byNiche = new Map();
  for (const row of costRows) {
    byNiche.set(row.niche, {
      niche: row.niche,
      leads: Number(row.lead_count) || 0,
      costUsd: Number(row.cost_usd) || 0,
      revenueUsd: 0
    });
  }
  for (const row of revenueRows) {
    const entry = byNiche.get(row.niche) || {
      niche: row.niche,
      leads: 0,
      costUsd: 0,
      revenueUsd: 0
    };
    entry.revenueUsd = Number(row.revenueUsd) || 0;
    byNiche.set(row.niche, entry);
  }
  const niches = Array.from(byNiche.values()).map((row) => {
    const marginUsd = row.revenueUsd - row.costUsd;
    const marginPct = row.revenueUsd > 0
      ? Number(((marginUsd / row.revenueUsd) * 100).toFixed(2))
      : null;
    return {
      niche: row.niche,
      leads: row.leads,
      costUsd: round2(row.costUsd),
      revenueUsd: round2(row.revenueUsd),
      marginUsd: round2(marginUsd),
      marginPct
    };
  });
  niches.sort((a, b) => (b.marginUsd || 0) - (a.marginUsd || 0));
  const totals = niches.reduce((acc, row) => {
    acc.leads += row.leads;
    acc.costUsd += row.costUsd;
    acc.revenueUsd += row.revenueUsd;
    acc.marginUsd += row.marginUsd;
    return acc;
  }, { leads: 0, costUsd: 0, revenueUsd: 0, marginUsd: 0 });
  return {
    niches,
    totals: {
      leads: totals.leads,
      costUsd: round2(totals.costUsd),
      revenueUsd: round2(totals.revenueUsd),
      marginUsd: round2(totals.marginUsd),
      marginPct: totals.revenueUsd > 0
        ? Number(((totals.marginUsd / totals.revenueUsd) * 100).toFixed(2))
        : null
    }
  };
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function boundedMoney(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function dedupeBlockers(blockers) {
  const seen = new Set();
  return blockers.filter((blocker) => {
    const key = `${blocker.source}:${blocker.code}:${blocker.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return undefined;
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0] || '*'}***@***.${tld}`;
}

function latestAgentMailThread(contactRows, lead) {
  const event = (contactRows || []).find((e) => e.channel === 'agentmail' && e.thread_id);
  if (!event && !lead.agentmail_thread_id) return null;
  return {
    threadId: event?.thread_id || lead.agentmail_thread_id,
    subject: event?.subject || null,
    lastEventAt: event?.created_at || null
  };
}

function browserUseStatusSummary() {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM builds
    GROUP BY status
  `).all();
  const counts = Object.fromEntries(rows.map((row) => [normalizeBrowserUseStatus(row.status), row.n]));
  const latest = db.prepare(`
    SELECT b.id, b.lead_id, b.browser_session_id, b.live_url, b.project_url, b.status, b.updated_at, l.business_name
    FROM builds b
    LEFT JOIN leads l ON l.id = b.lead_id
    ORDER BY COALESCE(b.updated_at, b.started_at, 0) DESC
    LIMIT 1
  `).get();
  return {
    counts,
    latest: latest ? {
      buildId: latest.id,
      leadId: latest.lead_id,
      businessName: latest.business_name,
      sessionId: latest.browser_session_id || latest.id,
      liveUrl: latest.live_url,
      projectUrl: latest.project_url,
      status: normalizeBrowserUseStatus(latest.status),
      updatedAt: latest.updated_at
    } : null
  };
}

async function browserUseSessionFromBuild(row, { hydrate = true, providerSession = null } = {}) {
  const buildEvents = browserUseEventsForBuild(row);
  const latestPayload = latestBrowserUsePayload(buildEvents);
  const mock = buildEvents.some((event) => event.payload?.mock === true) ||
    String(row.live_url || '').startsWith('/api/') ||
    !row.browser_session_id ||
    String(row.browser_session_id || '').startsWith('mock');
  const sessionId = row.browser_session_id || latestPayload?.sessionId || row.id;
  const fallback = {
    sessionId,
    status: row.status,
    model: latestPayload?.model || process.env.BROWSER_USE_MODEL || (mock ? 'mock-bu-mini' : null),
    liveUrl: row.live_url || latestPayload?.liveUrl || null,
    screenshotUrl: latestPayload?.screenshotUrl || null,
    recordingUrls: latestPayload?.recordingUrls || [],
    output: latestPayload?.output || null,
    outputSchema: latestPayload?.outputSchema || null,
    stepCount: latestPayload?.stepCount || 0,
    lastStepSummary: latestPayload?.lastStepSummary || latestPayload?.summary || null,
    maxCostUsd: latestPayload?.maxCostUsd || null,
    totalInputTokens: latestPayload?.totalInputTokens || 0,
    totalOutputTokens: latestPayload?.totalOutputTokens || 0,
    proxyUsedMb: latestPayload?.proxyUsedMb || '0',
    llmCostUsd: latestPayload?.llmCostUsd || '0',
    proxyCostUsd: latestPayload?.proxyCostUsd || '0',
    browserCostUsd: latestPayload?.browserCostUsd || '0',
    totalCostUsd: latestPayload?.totalCostUsd || '0',
    agentmailEmail: latestPayload?.agentmailEmail || null,
    integrationsUsed: latestPayload?.integrationsUsed || [],
    createdAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };

  let liveSnapshot = providerSession;
  if (!liveSnapshot && hydrate && shouldHydrateBrowserUseSession({ row, sessionId, mock })) {
    try {
      const adapter = new BrowserUseLovableAdapter({
        apiKey: env.browserUse.apiKey,
        baseUrl: env.browserUse.baseUrl
      });
      liveSnapshot = await adapter.getSession(sessionId);
    } catch (err) {
      latestPayload.lastError = err?.message || String(err);
    }
  }

  const session = normalizeBrowserUseSessionSnapshot(liveSnapshot || fallback, fallback);
  const status = normalizeBrowserUseStatus(row.status || session.status);
  const statusGroup = browserUseStatusGroup(status);
  const source = row.lovable_url || row.source_url || row.lead_website || null;
  const evidence = browserUseEvidence({ row, session, events: buildEvents });
  const totalCost = moneyNumber(session.totalCostUsd);
  const maxCost = moneyNumber(session.maxCostUsd);

  return {
    ...session,
    status,
    statusGroup,
    buildId: row.id,
    leadId: row.lead_id,
    businessName: row.business_name || null,
    sourceType: 'lovable_build',
    source,
    task: row.brief || latestPayload?.brief || latestPayload?.summary || row.business_name || 'Browser Use task',
    niche: row.niche || null,
    city: row.city || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    liveUrl: session.liveUrl || row.live_url || null,
    projectUrl: row.project_url || latestPayload?.projectUrl || null,
    lovableUrl: row.lovable_url || latestPayload?.lovableUrl || null,
    failure: row.error || latestPayload?.error || (statusGroup === 'auth_wall' ? latestPayload?.reason || 'auth wall' : null),
    evidenceCount: Math.max(evidence.length, Number(latestPayload?.evidenceCount || 0) || 0),
    evidence,
    eventCount: buildEvents.length,
    events: buildEvents.slice(-8).map((event) => event.normalized),
    badges: {
      mock,
      live: !mock && Boolean(session.sessionId || session.liveUrl),
      authNeeded: statusGroup === 'auth_wall',
      costCapped: Boolean(maxCost && totalCost >= maxCost),
      stopped: status === 'stopped'
    },
    hydrationError: latestPayload?.lastError || null
  };
}

function browserUseEventsForBuild(row) {
  if (!row?.lead_id) return [];
  return eventStore
    .listByLead(row.lead_id, { worker: 'builder', limit: 160 })
    .map((eventRow) => {
      const payload = safeJson(eventRow.payload_json) || {};
      const matchesBuild = !payload.buildId || payload.buildId === row.id;
      const matchesSession = !payload.sessionId || payload.sessionId === row.browser_session_id || payload.sessionId === row.id;
      if (!matchesBuild && !matchesSession) return null;
      const normalized = normalizeBrowserUseEvent(eventRow);
      return normalized ? { row: eventRow, payload, normalized } : null;
    })
    .filter(Boolean);
}

function latestBrowserUsePayload(events) {
  const out = {};
  for (const event of events || []) {
    Object.assign(out, compactBrowserUsePayload(event.payload || {}));
  }
  return out;
}

function compactBrowserUsePayload(payload) {
  const keys = [
    'sessionId',
    'model',
    'status',
    'summary',
    'lastStepSummary',
    'liveUrl',
    'screenshotUrl',
    'recordingUrls',
    'output',
    'outputSchema',
    'stepCount',
    'maxCostUsd',
    'totalInputTokens',
    'totalOutputTokens',
    'proxyUsedMb',
    'llmCostUsd',
    'proxyCostUsd',
    'browserCostUsd',
    'totalCostUsd',
    'agentmailEmail',
    'integrationsUsed',
    'brief',
    'projectUrl',
    'lovableUrl',
    'error',
    'reason',
    'evidenceCount'
  ];
  const out = {};
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') out[key] = payload[key];
  }
  return out;
}

function normalizeBrowserUseEvent(row) {
  const payload = safeJson(row.payload_json) || {};
  const type = row.type || payload.type;
  const isBrowserUse = type?.startsWith('browserUse.') || type?.startsWith('builder.') || type?.startsWith('scraper.');
  if (!isBrowserUse) return null;
  return {
    id: row.id,
    ts: row.ts,
    type,
    leadId: row.lead_id || payload.leadId || null,
    worker: row.worker || payload.worker || null,
    buildId: payload.buildId || null,
    sessionId: payload.sessionId || null,
    phase: payload.phase || eventPhase(type),
    status: normalizeBrowserUseStatus(payload.status || builderStatusForEvent(type)),
    source: payload.lovableUrl || payload.sourceUrl || payload.source_url || payload.liveUrl || payload.projectUrl || null,
    summary: payload.summary || payload.note || payload.error || payload.reason || payload.projectUrl || payload.liveUrl || type,
    model: payload.model || null,
    stepCount: payload.stepCount ?? null,
    lastStepSummary: payload.lastStepSummary || null,
    liveUrl: payload.liveUrl || null,
    screenshotUrl: payload.screenshotUrl || null,
    totalCostUsd: payload.totalCostUsd || null,
    llmCostUsd: payload.llmCostUsd || null,
    browserCostUsd: payload.browserCostUsd || null,
    proxyCostUsd: payload.proxyCostUsd || null,
    evidenceCount: payload.evidenceCount || evidenceCount(payload.output || payload.summary || payload.projectUrl || payload.liveUrl),
    mock: payload.mock ?? null
  };
}

function browserUseEvidence({ row, session, events }) {
  const evidence = [];
  const push = (kind, value, label = kind) => {
    if (!value) return;
    const key = `${kind}:${value}`;
    if (evidence.some((item) => item.key === key)) return;
    evidence.push({ key, kind, label, value: String(value).slice(0, 500) });
  };

  push('source', row.source_url || row.lovable_url, 'source page');
  push('liveUrl', session.liveUrl || row.live_url, 'live browser');
  push('screenshotUrl', session.screenshotUrl, 'latest screenshot');
  push('projectUrl', row.project_url, 'published site');
  for (const url of session.recordingUrls || []) push('recordingUrl', url, 'recording');
  if (session.output) {
    for (const url of urlsFromText(searchableText(session.output)).slice(0, 8)) push('outputUrl', url, 'output URL');
    if (!urlsFromText(searchableText(session.output)).length) push('output', searchableText(session.output).slice(0, 280), 'structured output');
  }
  for (const event of events || []) {
    push('eventScreenshot', event.payload?.screenshotUrl, 'event screenshot');
    push('eventProject', event.payload?.projectUrl, 'event project');
    push('eventLive', event.payload?.liveUrl, 'event live URL');
    if (event.payload?.summary && /evidence|source|found|captured|extracted/i.test(event.payload.summary)) {
      push('eventSummary', event.payload.summary, 'extraction');
    }
  }
  return evidence.slice(0, 18);
}

function countBrowserUseSessions(sessions) {
  return sessions.reduce((acc, session) => {
    acc.total += 1;
    acc[session.statusGroup] = (acc[session.statusGroup] || 0) + 1;
    return acc;
  }, { total: 0, active: 0, completed: 0, failed: 0, auth_wall: 0 });
}

function browserUseTelemetry(sessions) {
  const totals = sessions.reduce((acc, session) => {
    acc.totalCostUsd += moneyNumber(session.totalCostUsd);
    acc.llmCostUsd += moneyNumber(session.llmCostUsd);
    acc.browserCostUsd += moneyNumber(session.browserCostUsd);
    acc.proxyCostUsd += moneyNumber(session.proxyCostUsd);
    acc.inputTokens += Number(session.totalInputTokens || 0);
    acc.outputTokens += Number(session.totalOutputTokens || 0);
    acc.stepCount += Number(session.stepCount || 0);
    acc.evidenceCount += Number(session.evidenceCount || 0);
    if (session.model) acc.models.add(session.model);
    if (session.badges.costCapped) acc.costCapped += 1;
    return acc;
  }, {
    totalCostUsd: 0,
    llmCostUsd: 0,
    browserCostUsd: 0,
    proxyCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    stepCount: 0,
    evidenceCount: 0,
    models: new Set(),
    costCapped: 0
  });
  return {
    totalCostUsd: moneyString(totals.totalCostUsd),
    llmCostUsd: moneyString(totals.llmCostUsd),
    browserCostUsd: moneyString(totals.browserCostUsd),
    proxyCostUsd: moneyString(totals.proxyCostUsd),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    stepCount: totals.stepCount,
    evidenceCount: totals.evidenceCount,
    models: [...totals.models],
    costCapped: totals.costCapped
  };
}

function findBrowserUseBuild(sessionId) {
  return db.prepare(`
    SELECT *
    FROM builds
    WHERE browser_session_id = ? OR id = ?
    ORDER BY COALESCE(updated_at, started_at, 0) DESC
    LIMIT 1
  `).get(sessionId, sessionId);
}

function shouldHydrateBrowserUseSession({ row, sessionId, mock }) {
  if (mock || !env.browserUse.apiKey || !sessionId || !isBrowserUseUuid(sessionId)) return false;
  const status = normalizeBrowserUseStatus(row.status);
  return ['running', 'queued', 'starting', 'created', 'idle'].includes(status);
}

function normalizeBrowserUseStatus(status) {
  const value = String(status || 'unknown').toLowerCase();
  if (['queued', 'starting'].includes(value)) return 'running';
  if (['blocked-auth', 'blocked_auth', 'auth_wall', 'auth-needed', 'auth_needed'].includes(value)) return 'blocked_auth';
  if (value.startsWith('failed')) return 'failed';
  return value;
}

function browserUseStatusGroup(status) {
  const value = normalizeBrowserUseStatus(status);
  if (['created', 'idle', 'running'].includes(value)) return 'active';
  if (['completed', 'done', 'success', 'stopped'].includes(value)) return 'completed';
  if (value === 'blocked_auth') return 'auth_wall';
  if (['failed', 'error', 'timed_out', 'timeout'].includes(value)) return 'failed';
  return 'active';
}

function eventPhase(type) {
  if (type === 'builder.live_url') return 'session';
  if (type === 'builder.project_url') return 'extraction';
  if (type === 'builder.blocked_auth') return 'auth';
  if (type?.startsWith('scraper.')) return 'research';
  return 'progress';
}

function boundedLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function moneyNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function moneyString(value) {
  return value.toFixed(4).replace(/\.?0+$/g, '') || '0';
}

function isBrowserUseUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function urlsFromText(text) {
  return [...String(text || '').matchAll(/https?:\/\/[^\s"'<>),]+/g)].map((match) => match[0]);
}

function evidenceCount(value) {
  const text = searchableText(value);
  if (!text) return 0;
  const urlCount = urlsFromText(text).length;
  if (urlCount) return urlCount;
  if (/\b(source|evidence|screenshot|captured|extracted)\b/i.test(text)) return 1;
  return 0;
}

function searchableText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

const BUILDER_LABELS = {
  'builder.start': 'Build requested',
  'builder.submission_created': 'Target submission created',
  'builder.live_url': 'Live preview ready',
  'builder.provider_action': 'Provider action',
  'builder.hook': 'Build hook',
  'builder.qa': 'Build QA',
  'builder.revision': 'Revision planned',
  'builder.progress': 'Progress update',
  'builder.project_url': 'Final site URL found',
  'builder.blocked_auth': 'Lovable auth needed',
  'builder.done': 'Build completed',
  'browserUse.session.stopped': 'Browser Use stopped',
  'builder.error': 'Build failed'
};

function buildBuilderReadModel({ lead, buildRows, builderEvents }) {
  const latest = buildRows[0] || null;
  const timeline = (builderEvents || [])
    .filter((row) => row.type?.startsWith('builder.'))
    .map(builderTimelineItem)
    .filter(Boolean);
  const status = normalizeBuildStatus(latest?.status || statusFromBuilderTimeline(timeline) || 'not_started');
  const progressLog = timeline
    .filter((item) => item.type === 'builder.progress' || item.type === 'builder.provider_action' || item.type === 'builder.submission_created' || item.error)
    .map((item) => ({
      ts: item.ts,
      text: item.error || item.summary || item.label,
      type: item.type
    }))
    .slice(-12);

  return {
    status,
    authNeeded: status === 'blocked_auth',
    latestBuildId: latest?.id || lastValue(timeline, 'buildId'),
    runId: lastValue(timeline, 'runId'),
    startedAt: latest?.started_at || firstTs(timeline),
    finishedAt: latest?.finished_at || terminalTs(timeline),
    liveUrl: latest?.live_url || lastValue(timeline, 'liveUrl'),
    projectUrl: latest?.project_url || lastValue(timeline, 'projectUrl'),
    finalSiteUrl: latest?.project_url || (lead.status === 'shipped' ? lead.website : null),
    target: latest?.target || lastValue(timeline, 'target') || 'lovable',
    submissionUrl: latest?.submission_url || latest?.lovable_url || lastValue(timeline, 'submissionUrl'),
    error: latest?.error || lastValue(timeline, 'error'),
    brief: latest?.brief || lastValue(timeline, 'brief'),
    lovableUrl: latest?.lovable_url || lastValue(timeline, 'lovableUrl'),
    providerProjectId: latest?.provider_project_id || lastValue(timeline, 'providerProjectId'),
    providerDeploymentId: latest?.provider_deployment_id || lastValue(timeline, 'providerDeploymentId'),
    sessionId: latest?.browser_session_id || lastValue(timeline, 'sessionId'),
    model: lastValue(timeline, 'model'),
    stepCount: lastNumber(timeline, 'stepCount'),
    lastStepSummary: lastValue(timeline, 'lastStepSummary') || lastValue(timeline, 'summary'),
    screenshotUrl: lastValue(timeline, 'screenshotUrl'),
    recordingUrls: lastArray(timeline, 'recordingUrls'),
    maxCostUsd: lastValue(timeline, 'maxCostUsd'),
    totalInputTokens: lastNumber(timeline, 'totalInputTokens'),
    totalOutputTokens: lastNumber(timeline, 'totalOutputTokens'),
    proxyUsedMb: lastValue(timeline, 'proxyUsedMb'),
    llmCostUsd: lastValue(timeline, 'llmCostUsd'),
    proxyCostUsd: lastValue(timeline, 'proxyCostUsd'),
    browserCostUsd: lastValue(timeline, 'browserCostUsd'),
    totalCostUsd: lastValue(timeline, 'totalCostUsd'),
    agentmailEmail: lastValue(timeline, 'agentmailEmail'),
    integrationsUsed: lastArray(timeline, 'integrationsUsed'),
    evidenceCount: lastNumber(timeline, 'evidenceCount'),
    outputSchema: lastValue(timeline, 'outputSchema'),
    progressLog,
    timeline
  };
}

function builderTimelineItem(row) {
  const payload = safeJson(row.payload_json) || {};
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    label: BUILDER_LABELS[row.type] || row.type,
    status: builderStatusForEvent(row.type),
    summary: payload.summary || payload.note || payload.error || payload.projectUrl || payload.liveUrl || '',
    liveUrl: payload.liveUrl || null,
    projectUrl: payload.projectUrl || null,
    target: payload.target || null,
    submissionUrl: payload.submissionUrl || payload.submission_url || null,
    promptPreview: payload.promptPreview || null,
    providerAction: payload.providerAction || null,
    providerProjectId: payload.providerProjectId || null,
    providerDeploymentId: payload.providerDeploymentId || null,
    buildId: payload.buildId || null,
    runId: payload.runId || null,
    brief: payload.brief || null,
    lovableUrl: payload.lovableUrl || null,
    sessionId: payload.sessionId || null,
    error: payload.error || null,
    model: payload.model || null,
    stepCount: payload.stepCount ?? null,
    lastStepSummary: payload.lastStepSummary || null,
    screenshotUrl: payload.screenshotUrl || null,
    recordingUrls: payload.recordingUrls || [],
    maxCostUsd: payload.maxCostUsd || null,
    totalInputTokens: payload.totalInputTokens || null,
    totalOutputTokens: payload.totalOutputTokens || null,
    proxyUsedMb: payload.proxyUsedMb || null,
    llmCostUsd: payload.llmCostUsd || null,
    proxyCostUsd: payload.proxyCostUsd || null,
    browserCostUsd: payload.browserCostUsd || null,
    totalCostUsd: payload.totalCostUsd || null,
    agentmailEmail: payload.agentmailEmail || null,
    integrationsUsed: payload.integrationsUsed || [],
    evidenceCount: payload.evidenceCount || evidenceCount(payload.output || payload.summary || payload.projectUrl || payload.liveUrl),
    outputSchema: payload.outputSchema || null,
    mock: !!payload.mock
  };
}

function builderStatusForEvent(type) {
  if (
    type === 'builder.start' ||
    type === 'builder.submission_created' ||
    type === 'builder.live_url' ||
    type === 'builder.provider_action' ||
    type === 'builder.hook' ||
    type === 'builder.qa' ||
    type === 'builder.revision' ||
    type === 'builder.progress' ||
    type === 'builder.project_url'
  ) return 'running';
  if (type === 'builder.done') return 'completed';
  if (type === 'builder.blocked_auth') return 'blocked_auth';
  if (type === 'browserUse.session.stopped') return 'stopped';
  if (type === 'builder.error') return 'failed';
  return null;
}

function normalizeBuildStatus(status) {
  if (status === 'queued' || status === 'starting' || status === 'qa_review') return 'running';
  if (status?.startsWith?.('failed')) return 'failed';
  return status || 'not_started';
}

function statusFromBuilderTimeline(timeline) {
  for (const item of [...timeline].reverse()) {
    if (item.status) return item.status;
  }
  return null;
}

function firstTs(timeline) {
  return timeline.length ? timeline[0].ts : null;
}

function terminalTs(timeline) {
  const terminal = [...timeline].reverse().find((item) => ['builder.done', 'builder.blocked_auth', 'builder.error'].includes(item.type));
  return terminal?.ts || null;
}

function lastValue(timeline, key) {
  for (const item of [...timeline].reverse()) {
    if (item[key]) return item[key];
  }
  return null;
}

function lastNumber(timeline, key) {
  for (const item of [...timeline].reverse()) {
    const n = Number(item[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function lastArray(timeline, key) {
  for (const item of [...timeline].reverse()) {
    if (Array.isArray(item[key]) && item[key].length) return item[key];
  }
  return [];
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Minimal, server-rendered landing page used by /api/referrals/landing-html.
// Keep this string self-contained — the goal is for the operator to preview
// what a referred visitor sees without any frontend build step.
function renderReferralLandingHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>callmemaybe — same-day websites for local businesses</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif; color: #17201b; background: #f6f8f4; }
    main { width: min(640px, calc(100vw - 32px)); margin: 0 auto; padding: 64px 0 96px; }
    .brand { font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: #4b6650; margin-bottom: 24px; }
    h1 { font-size: clamp(32px, 6vw, 56px); line-height: 1.05; margin: 0 0 16px; }
    p.lede { font-size: 18px; line-height: 1.5; color: #2c3a31; max-width: 56ch; margin: 0 0 32px; }
    form { display: grid; gap: 12px; padding: 20px; background: white; border: 1px solid #d6ded8; border-radius: 12px; }
    label { font-size: 13px; font-weight: 600; color: #2c3a31; }
    input { padding: 12px 14px; font-size: 16px; border: 1px solid #d6ded8; border-radius: 8px; }
    button { padding: 12px 16px; font-size: 16px; font-weight: 600; background: #165a3a; color: white; border: 0; border-radius: 8px; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .status { font-size: 14px; color: #4b6650; min-height: 18px; }
    footer { margin-top: 48px; font-size: 12px; color: #6a7d70; }
  </style>
</head>
<body>
  <main>
    <div class="brand">callmemaybe</div>
    <h1>we build your website same-day for $500</h1>
    <p class="lede">Tell us the business and city. We research it, write the copy, ship a real one-page site, and email you the link before the day is over.</p>
    <form id="discover-form" autocomplete="off">
      <div>
        <label for="niche">Business / niche</label>
        <input id="niche" name="niche" type="text" placeholder="plumber, salon, law firm…" required minlength="2" />
      </div>
      <div>
        <label for="city">City</label>
        <input id="city" name="city" type="text" placeholder="Oakland, CA" required minlength="2" />
      </div>
      <button type="submit">Build my website</button>
      <div class="status" id="status" aria-live="polite"></div>
    </form>
    <footer>Referred by a site we built. callmemaybe ships small business websites same-day.</footer>
  </main>
  <script>
    (function () {
      var form = document.getElementById('discover-form');
      var status = document.getElementById('status');
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var btn = form.querySelector('button');
        btn.disabled = true;
        status.textContent = 'Sending to our crew…';
        var payload = {
          niche: form.niche.value.trim(),
          city: form.city.value.trim(),
          count: 1
        };
        fetch('/api/leads/discover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function () {
          status.textContent = 'Got it. We will reach out with your site.';
        }).catch(function (err) {
          status.textContent = 'Could not submit: ' + (err && err.message ? err.message : 'unknown');
          btn.disabled = false;
        });
      });
    })();
  </script>
</body>
</html>`;
}

function agentMailEventId(req, body, msg) {
  return String(
    req.headers['svix-id'] ||
    msg.eventId ||
    body.id ||
    body.event_id ||
    `${msg.eventType || 'agentmail'}:${msg.threadId || 'thread'}:${msg.messageId || Date.now()}`
  );
}
