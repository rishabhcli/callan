import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { log } from './logger.js';
import { attachStream, emit } from './sse.js';
import { leads, runs, calls, payments, builds, contactEvents, webhookEvents } from './db.js';
import { DiscoverRequest, CallRequest, FollowupRequest, BuildRequest } from './types.js';
import { listKinds } from './memory.js';
import { verifyAgentPhone } from './webhooks/agentphone.js';
import { verifyAgentMail } from './webhooks/agentmail.js';
import { verifyStripe } from './webhooks/stripe.js';
import { liveReadiness } from './readiness.js';
import { approveLeadForLiveCall, startOutreachLoop, stopOutreachLoop, outreachStatus } from './outreach.js';
import { runScraper } from './workers/scraper.js';
import { runCaller } from './workers/caller.js';
import { runAnalyst } from './workers/analyst.js';
import { runMailer } from './workers/mailer.js';
import { runBuilder } from './workers/builder.js';
import { handleAgentMailInbound, isInboundAgentMailPayload, normalizeAgentMailPayload } from './workers/mailReply.js';

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
    quotas: readiness.outreach,
    webhooks: readiness.webhooks,
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
    memory,
    contactEvents: contactRows,
    outreachStatus: lead.outreach_status,
    riskStatus: lead.risk_status,
    latestThread: latestAgentMailThread(contactRows, lead),
    latestInvoice: paymentRows[0] || null,
    buildStatus: buildRows[0]?.status || null
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
  fire('caller', { leadId: lead.id, toPhone: phone }, runCaller);
  res.status(202).json({ accepted: true, mode: env.runMode });
});

app.post('/api/leads/:id/approve-live-call', (req, res) => {
  const lead = approveLeadForLiveCall(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json({ ok: true, lead });
});

app.post('/api/outreach/start', (_req, res) => {
  res.json(startOutreachLoop());
});

app.post('/api/outreach/stop', (_req, res) => {
  res.json(stopOutreachLoop());
});

app.get('/api/outreach/status', (_req, res) => {
  res.json(outreachStatus());
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

app.post('/api/webhooks/agentphone', async (req, res) => {
  const v = verifyAgentPhone(req, req.rawBody || Buffer.from(JSON.stringify(req.body)));
  if (!v.ok) {
    log.warn('agentphone webhook rejected', { reason: v.reason });
    return res.status(401).json({ error: v.reason });
  }
  const body = req.body || {};
  emit('agentphone.webhook', { worker: 'caller', providerType: body.event || body.type, callId: body.callId || body.call_id });
  if (body.event === 'call.ended' || body.type === 'call.ended') {
    const callRow = calls.get(body.callId || body.call_id);
    if (callRow) {
      calls.finish(callRow.id, { outcome: body.outcome || 'unknown', transcript: body.transcript });
      fire('analyst', { leadId: callRow.lead_id, callId: callRow.id }, runAnalyst);
    }
  }
  res.json({ ok: true });
});

app.post('/api/webhooks/agentmail', async (req, res) => {
  const v = verifyAgentMail(req, req.rawBody || Buffer.from(JSON.stringify(req.body)));
  if (!v.ok) return res.status(401).json({ error: v.reason });
  const body = req.body || {};
  const msg = normalizeAgentMailPayload(body);
  const eventId = agentMailEventId(req, body, msg);
  if (webhookEvents.seen('agentmail', eventId)) return res.json({ ok: true, duplicate: true });
  webhookEvents.record({ provider: 'agentmail', event_id: eventId, type: msg.eventType, payload: body });
  emit('agentmail.webhook', {
    worker: 'mailer',
    providerType: msg.eventType,
    threadId: msg.threadId,
    fromMasked: maskEmail(msg.fromEmail),
    subject: msg.subject,
    preview: typeof msg.text === 'string' ? msg.text.slice(0, 240) : undefined
  });
  if (isInboundAgentMailPayload(body)) {
    emit('mailer.inbound_message', {
      worker: 'mailer',
      threadId: msg.threadId,
      fromMasked: maskEmail(msg.fromEmail),
      subject: msg.subject,
      preview: typeof msg.text === 'string' ? msg.text.slice(0, 240) : undefined
    });
    try {
      await handleAgentMailInbound(body);
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
  webhookEvents.record({ provider: 'stripe', event_id: eventId, type: event.type, payload: event });
  emit('stripe.webhook', { providerType: event.type });
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    handlePaidPayment(session.id, session.metadata?.leadId);
  }
  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    handlePaidPayment(invoice.id, invoice.metadata?.leadId);
  }
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
});

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

function agentMailEventId(req, body, msg) {
  return String(
    req.headers['svix-id'] ||
    msg.eventId ||
    body.id ||
    body.event_id ||
    `${msg.eventType || 'agentmail'}:${msg.threadId || 'thread'}:${msg.messageId || Date.now()}`
  );
}

function handlePaidPayment(stripeId, metadataLeadId) {
  const result = payments.markPaid(stripeId);
  const leadId = metadataLeadId || result.row?.lead_id;
  if (!leadId) return;
  leads.update(leadId, { status: 'paid', next_action: 'build', outreach_status: 'paid' });
  if (result.changed) fire('builder', { leadId }, runBuilder);
}
