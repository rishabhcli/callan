import express from 'express';
import cors from 'cors';
import { env } from './env.js';
import { log } from './logger.js';
import { attachStream, emit } from './sse.js';
import { leads, runs, calls, payments, builds } from './db.js';
import { DiscoverRequest, CallRequest, FollowupRequest, BuildRequest } from './types.js';
import { listKinds } from './memory.js';
import { dncCheck } from './compliance.js';
import { verifyAgentPhone } from './webhooks/agentphone.js';
import { verifyAgentMail } from './webhooks/agentmail.js';
import { verifyStripe } from './webhooks/stripe.js';
import { runScraper } from './workers/scraper.js';
import { runCaller } from './workers/caller.js';
import { runAnalyst } from './workers/analyst.js';
import { runMailer } from './workers/mailer.js';
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

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    mode: env.runMode,
    live: env.live,
    providers: {
      gemini: !!env.gemini.apiKey,
      supermemory: !!env.supermemory.apiKey,
      agentphone: !!env.agentphone.apiKey,
      moss: !!env.moss.projectKey,
      browserUse: !!env.browserUse.apiKey,
      agentmail: !!env.agentmail.apiKey,
      stripe: !!env.stripe.secretKey
    },
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
  let memory = null;
  try {
    if (env.supermemory.apiKey) memory = await listKinds(lead.container_tag);
  } catch (err) {
    log.warn('memory.list failed', { error: err.message });
  }
  res.json({ lead, calls: callRows, payments: paymentRows, builds: buildRows, runs: runRows, memory });
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
  const check = dncCheck(phone);
  if (env.runMode === 'live' && env.live.calls && !check.ok) {
    return res.status(403).json({ error: `call refused: ${check.reason}` });
  }
  fire('caller', { leadId: lead.id, toPhone: phone }, runCaller);
  res.status(202).json({ accepted: true, mode: env.runMode });
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
  emit('agentphone.webhook', { worker: 'caller', type: body.event || body.type, callId: body.callId || body.call_id });
  if (body.event === 'call.ended' || body.type === 'call.ended') {
    const callRow = calls.get(body.callId || body.call_id);
    if (callRow) {
      calls.finish(callRow.id, { outcome: body.outcome || 'unknown', transcript: body.transcript });
      fire('analyst', { leadId: callRow.lead_id, callId: callRow.id }, runAnalyst);
    }
  }
  res.json({ ok: true });
});

app.post('/api/webhooks/agentmail', (req, res) => {
  const v = verifyAgentMail(req, req.rawBody || Buffer.from(JSON.stringify(req.body)));
  if (!v.ok) return res.status(401).json({ error: v.reason });
  emit('agentmail.webhook', { type: req.body?.type, threadId: req.body?.threadId || req.body?.thread_id });
  res.json({ ok: true });
});

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const v = verifyStripe(req.body, sig);
  if (!v.ok) {
    log.warn('stripe webhook rejected', { reason: v.reason });
    return res.status(400).json({ error: v.reason });
  }
  const event = v.event;
  emit('stripe.webhook', { type: event.type });
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    payments.markPaid(session.id);
    const leadId = session.metadata?.leadId;
    if (leadId) {
      fire('builder', { leadId }, runBuilder);
      leads.update(leadId, { status: 'paid' });
    }
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
