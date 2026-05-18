import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { log } from './logger.js';
import { attachStream, emit } from './sse.js';
import { leads, runs, calls, payments, builds, contactEvents, webhookEvents, doNotCall, events as eventStore, auditTrail, reasoningTraces, db } from './db.js';
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
import { liveReadiness } from './readiness.js';
import { fulfillmentReadiness } from './fulfillment/targets.js';
import { fulfillmentQueueSnapshot } from './fulfillment/queue.js';
import { recoverTriggeredPaymentBuilds, revenueHealthSummary, revenueStatusForLead } from './paymentFlow.js';
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
import { runScraper } from './workers/scraper.js';
import { runCaller } from './workers/caller.js';
import { runAnalyst } from './workers/analyst.js';
import { handleAgentMailInbound, runMailer } from './workers/mailer.js';
import { runBuilder } from './workers/builder.js';
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

const startBuilder = (args) => fire('builder', args, runBuilder);

app.get('/api/health', (_req, res) => {
  const readiness = liveReadiness();
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
    revenue: revenueHealthSummary(),
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
    growth
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

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const v = verifyStripe(req.rawBody || req.body, sig);
  if (!v.ok) {
    log.warn('stripe webhook rejected', { reason: v.reason });
    return res.status(400).json({ error: v.reason });
  }
  const event = v.event;
  const result = processStripeWebhookEvent(event, { req, startBuilder });
  res.json(result);
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
    }))
  });
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
});

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

function agentMailEventId(req, body, msg) {
  return String(
    req.headers['svix-id'] ||
    msg.eventId ||
    body.id ||
    body.event_id ||
    `${msg.eventType || 'agentmail'}:${msg.threadId || 'thread'}:${msg.messageId || Date.now()}`
  );
}
