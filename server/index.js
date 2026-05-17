import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { log } from './logger.js';
import { attachStream, emit } from './sse.js';
import { leads, runs, calls, payments, builds, contactEvents, webhookEvents, doNotCall, events as eventStore, auditTrail } from './db.js';
import { DiscoverRequest, CallRequest, FollowupRequest, BuildRequest } from './types.js';
import { listKinds } from './memory.js';
import { handleAgentPhoneWebhook, verifyAgentPhone } from './webhooks/agentphone.js';
import { agentMailWebhookEventId, isInboundAgentMailWebhook, normalizeAgentMailWebhook, verifyAgentMail } from './webhooks/agentmail.js';
import { verifyStripe } from './webhooks/stripe.js';
import { liveReadiness } from './readiness.js';
import { leadIdFromStripeObject, recoverTriggeredPaymentBuilds, recordPaidPayment, stripePaymentDetails } from './paymentFlow.js';
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
    smoke: readiness.smoke,
    quotas: readiness.outreach,
    quotaPolicies: readiness.quotas,
    webhooks: readiness.webhooks,
    lastErrors: Object.fromEntries(Object.entries(readiness.providers).map(([k, v]) => [k, v.lastError]).filter(([, v]) => v)),
    hackathon: env.hackathon
  });
});

app.get('/api/events/stream', (req, res) => attachStream(req, res));

app.get('/api/leads', (_req, res) => {
  res.json({ leads: leads.list() });
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
  const builderEvents = eventStore.listByLead(lead.id, { worker: 'builder', limit: 100 });
  const builderState = buildBuilderReadModel({ lead, buildRows, builderEvents });
  const researchProfile = safeJson(lead.research_json);
  let memory = null;
  try {
    if (env.supermemory.apiKey) memory = await listKinds(lead.container_tag);
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
    builderState
  });
});

app.post('/api/leads/discover', (req, res) => {
  const parsed = DiscoverRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  fire('scraper', parsed.data, runScraper);
  res.status(202).json({ accepted: true });
});

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

app.post('/api/outreach/start', (_req, res) => {
  res.json(resumeOutreachLoop({ reason: 'operator_start' }));
});

app.post('/api/outreach/stop', (_req, res) => {
  res.json(stopOutreachLoop());
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

app.post('/api/leads/:id/followup', (req, res) => {
  const parsed = FollowupRequest.safeParse({ leadId: req.params.id, ...req.body });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const lead = leads.get(parsed.data.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  fire('mailer', { leadId: lead.id, toEmail: parsed.data.toEmail }, runMailer);
  res.status(202).json({ accepted: true });
});

app.post('/api/leads/:id/build', (req, res) => {
  const parsed = BuildRequest.safeParse({ leadId: req.params.id });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const lead = leads.get(parsed.data.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  fire('builder', { leadId: lead.id }, runBuilder);
  res.status(202).json({ accepted: true });
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
  const eventId = event.id || `${event.type}:${event.data?.object?.id || Date.now()}`;
  if (webhookEvents.seen('stripe', eventId)) return res.json({ received: true, duplicate: true });
  emit('stripe.webhook', { providerType: event.type });
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    handlePaidPayment(session.id, leadIdFromStripeObject(session), stripePaymentDetails(session, event.type));
  }
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    handlePaidPayment(invoice.id, leadIdFromStripeObject(invoice), stripePaymentDetails(invoice, event.type));
  }
  webhookEvents.recordOnce({ provider: 'stripe', event_id: eventId, type: event.type, payload: event });
  res.json({ received: true });
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

const BUILDER_LABELS = {
  'builder.start': 'Build requested',
  'builder.live_url': 'Live preview ready',
  'builder.progress': 'Progress update',
  'builder.project_url': 'Final site URL found',
  'builder.blocked_auth': 'Lovable auth needed',
  'builder.done': 'Build completed',
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
    .filter((item) => item.type === 'builder.progress' || item.error)
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
    error: latest?.error || lastValue(timeline, 'error'),
    brief: latest?.brief || lastValue(timeline, 'brief'),
    lovableUrl: latest?.lovable_url || lastValue(timeline, 'lovableUrl'),
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
    buildId: payload.buildId || null,
    runId: payload.runId || null,
    brief: payload.brief || null,
    lovableUrl: payload.lovableUrl || null,
    sessionId: payload.sessionId || null,
    error: payload.error || null,
    mock: !!payload.mock
  };
}

function builderStatusForEvent(type) {
  if (type === 'builder.start' || type === 'builder.live_url' || type === 'builder.progress' || type === 'builder.project_url') return 'running';
  if (type === 'builder.done') return 'completed';
  if (type === 'builder.blocked_auth') return 'blocked_auth';
  if (type === 'builder.error') return 'failed';
  return null;
}

function normalizeBuildStatus(status) {
  if (status === 'queued' || status === 'starting') return 'running';
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

function handlePaidPayment(stripeId, metadataLeadId, payment) {
  const result = recordPaidPayment(stripeId, metadataLeadId, { payment, startBuilder });
  if (!result.leadId) {
    log.warn('stripe.payment.unmatched', { stripeId });
    return;
  }
  if (!result.row) {
    log.warn('stripe.payment.no_local_invoice_row', { stripeId, leadId: result.leadId });
    return;
  }
}
