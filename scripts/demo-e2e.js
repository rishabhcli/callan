#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const dataDir = args.dataDir || process.env.DATA_DIR || '.data';
const allowLiveEnv = args.allowLiveEnv || process.env.DEMO_ALLOW_LIVE_ENV === 'true';
forceMockEnv({ dataDir, allowLiveEnv });

if (args.resetDemoData) {
  await resetDemoData(dataDir);
}

const commandsRun = [];
const {
  leads,
  runs,
  calls,
  payments,
  builds,
  contactEvents,
  webhookEvents
} = await import('../server/db.js');
const { emit } = await import('../server/sse.js');
const { recordPaidPayment } = await import('../server/paymentFlow.js');
const { handleAgentMailInbound } = await import('../server/workers/mailer.js');

const demo = await seedLifecycle();

if (args.build) {
  commandsRun.push('npm run build');
  await runCommand('npm', ['run', 'build'], { label: 'vite build' });
}

let uiVerification = null;
if (args.verifyUi) {
  uiVerification = await verifyUiPath({ leadId: demo.leadId, dataDir, allowLiveEnv });
}

const summary = {
  ok: true,
  mode: allowLiveEnv ? 'mock-data-with-live-env-preserved' : 'mock',
  dataDir,
  leadId: demo.leadId,
  leadUrl: uiVerification ? `${uiVerification.baseUrl}` : null,
  invoiceUrl: demo.invoiceUrl,
  agentmailThreadId: demo.threadId,
  inboundReplyEventId: demo.inboundReplyEventId,
  autoReplyContactEventId: demo.autoReplyId,
  stripeEventId: demo.stripeEventId,
  liveBuildUrl: demo.liveUrl,
  projectUrl: demo.projectUrl,
  uiVerification,
  commandsRun
};

console.log(JSON.stringify(summary, null, 2));

async function seedLifecycle() {
  const suffix = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomBytes(2).toString('hex')}`;
  const requestedLeadId = args.leadId || `lead_demo_${suffix}`;
  const requestedContainerTag = `biz_${requestedLeadId}`;
  const invoiceEmail = 'maria@lunaridgehvac.test';
  const phone = '+14155550137';

  const profile = {
    businessName: 'Luna Ridge HVAC',
    phone,
    address: '1844 Clement St, San Francisco, CA',
    city: 'San Francisco',
    niche: 'hvac repair',
    hasWebsite: false,
    websiteUrl: null,
    onlinePresenceStrength: 'weak',
    onlinePresenceSummary: 'Google and Yelp listings exist, but there is no owned website for service areas, emergency repair, financing, or booking.',
    ownerHypothesis: 'Maria Luna, owner-operator',
    customerPersona: 'Homeowners who need same-day repair and want proof the crew is local and insured.',
    hours: 'Mon-Sat 7am-7pm; emergency calls by request',
    whatTheyDo: 'Residential HVAC repair, seasonal tuneups, and furnace replacement.',
    needs: ['owned service page', 'tap-to-call mobile CTA', 'emergency repair copy', 'trust proof', 'simple quote request'],
    signals: ['weak owned presence', 'phone-forward business', 'reviews mention fast repair', 'no booking page'],
    bestContactEmail: invoiceEmail,
    yelpUrl: 'https://example.test/luna-ridge-hvac-yelp',
    sourceUrl: 'https://example.test/luna-ridge-hvac'
  };

  const insertResult = leads.insert({
    id: requestedLeadId,
    container_tag: requestedContainerTag,
    business_name: profile.businessName,
    phone: profile.phone,
    address: profile.address,
    niche: profile.niche,
    city: profile.city,
    website: null,
    status: 'discovered',
    research_status: 'complete',
    outreach_status: 'queued',
    risk_status: 'callable',
    consent_status: 'operator_demo',
    phone_classification: 'business',
    next_action: 'call',
    source_url: profile.sourceUrl
  });
  const leadId = insertResult.lead.id;
  const containerTag = insertResult.lead.container_tag;

  completeRun({
    worker: 'scraper',
    leadId,
    startEvent: { niche: profile.niche, city: profile.city, mocked: true },
    detail: { profile, mocked: true }
  });
  emit('lead.created', {
    worker: 'scraper',
    leadId,
    containerTag,
    duplicate: insertResult.duplicate,
    duplicateReasons: insertResult.duplicateReasons,
    attemptedLeadId: insertResult.attemptedId,
    businessName: profile.businessName,
    phone: profile.phone,
    niche: profile.niche,
    city: profile.city,
    onlinePresenceStrength: profile.onlinePresenceStrength,
    outreachStatus: 'queued',
    demo: true
  });
  emit('scraper.profile', {
    worker: 'scraper',
    leadId,
    containerTag,
    onlinePresenceStrength: profile.onlinePresenceStrength,
    summary: profile.onlinePresenceSummary,
    demo: true
  });

  const pitch = {
    openingLine: 'I saw Luna Ridge has strong reviews but no owned page for emergency HVAC calls.',
    valueProp: 'We build a simple $500 site that makes the phone number, service areas, trust proof, and quote path obvious on mobile.',
    discoveryQuestions: [
      'Which neighborhoods do you want more repair calls from?',
      'Do you prefer phone calls or quote-form requests?',
      'What proof should customers see before calling?'
    ],
    objections: [
      { objection: 'We get enough calls already.', response: 'Totally. This is mostly about making the good calls easier to choose you before they call someone else.' },
      { objection: 'I do not have time.', response: 'That is why we keep it flat, same-day, and invoice-backed. You answer a few questions and we build it.' },
      { objection: 'Can I change it later?', response: 'Yes. We send the first version and keep the AgentMail thread open for edits and questions.' }
    ],
    close: 'If this sounds useful, I can send the $500 invoice and start the build as soon as it is paid.',
    emailAsk: 'What is the best email for the invoice?',
    invoiceClose: 'The invoice will come from AgentMail, and you can reply there with questions.',
    beginMessage: 'This call may be recorded so we can improve service quality. Hi, is this Maria at Luna Ridge HVAC?'
  };

  const callerRunId = startRun('caller', leadId, { toPhone: maskPhone(phone), mocked: true });
  emit('pitch.created', {
    worker: 'caller',
    leadId,
    runId: callerRunId,
    keys: Object.keys(pitch),
    openingLine: pitch.openingLine,
    objectionCount: pitch.objections.length,
    demo: true
  });

  const callId = `call_demo_${suffix}`;
  calls.start({
    id: callId,
    lead_id: leadId,
    to_phone: maskPhone(phone),
    provider_call_id: null,
    disclosure_text: 'This call may be recorded so we can improve service quality.',
    decision_reason: 'demo mock call'
  });
  emit('caller.placed', { worker: 'caller', leadId, runId: callerRunId, callId, providerCallId: null, mock: true });

  const transcript = [
    { role: 'agent', text: pitch.beginMessage },
    { role: 'user', text: 'This is Maria. I only have a minute.' },
    { role: 'agent', text: pitch.openingLine },
    { role: 'user', text: 'We never got around to making a website. How much is this?' },
    { role: 'agent', text: pitch.valueProp },
    { role: 'user', text: 'If it is really five hundred flat, send it over.' },
    { role: 'agent', text: pitch.emailAsk },
    { role: 'user', text: `Use ${invoiceEmail}.` },
    { role: 'agent', text: `I have ${invoiceEmail}. Is that right? ${pitch.invoiceClose}` },
    { role: 'user', text: 'Yes, that is correct. I will pay it after this call.' }
  ].map((turn, index) => ({ ...turn, ts: Date.now() + index * 1000 }));

  for (const turn of transcript) {
    emit('caller.transcript', { worker: 'caller', leadId, callId, role: turn.role, text: turn.text, ts: turn.ts, mock: true });
  }
  calls.finish(callId, { outcome: 'demo-yes', transcript });
  finishRun(callerRunId, { state: 'completed', detail: { callId, mock: true } });
  emit('caller.done', { worker: 'caller', leadId, runId: callerRunId, callId, outcome: 'demo-yes', mock: true });

  const postMortem = {
    outcome: 'won',
    reason: 'The owner agreed after hearing a flat price and a concrete mobile repair-call use case.',
    whatWorked: ['Opened with a specific weak-presence gap.', 'Kept the offer flat and same-day.', 'Confirmed the invoice email out loud.'],
    whatToTryNext: ['Ask earlier about emergency-call geography.', 'Bring up trust proof before pricing.'],
    replayMoments: [
      { ts: transcript[3].ts, excerpt: transcript[3].text, note: 'Owner surfaces website gap.' },
      { ts: transcript[7].ts, excerpt: transcript[7].text, note: 'Invoice email captured.' }
    ],
    invoiceEmail,
    confirmedEmail: true,
    customerQuestions: ['Can it show emergency repair?', 'Can customers call from mobile?'],
    followupEmailDraft: 'Thanks for the quick call. The invoice is below; once paid, we will start the Luna Ridge HVAC site with mobile call CTAs, service areas, and trust proof.'
  };

  const analystRunId = startRun('analyst', leadId, { callId, mocked: true });
  leads.update(leadId, { status: 'closing', next_action: 'send_invoice', outreach_status: 'called' });
  finishRun(analystRunId, { state: 'completed', detail: { postMortem, extractedInvoiceEmail: invoiceEmail, mock: true } });
  emit('analyst.done', {
    worker: 'analyst',
    leadId,
    runId: analystRunId,
    outcome: postMortem.outcome,
    reason: postMortem.reason,
    invoiceEmail,
    demo: true
  });

  const invoiceId = `in_demo_${suffix}`;
  const invoiceUrl = `https://invoice.stripe.com/i/demo_${leadId}`;
  const threadId = `mock-thread-${suffix}`;
  const paymentId = `pay_demo_${suffix}`;

  const mailerRunId = startRun('mailer', leadId, { toEmailMasked: maskEmail(invoiceEmail), mocked: true });
  const paymentInsert = payments.insertOrGetByIdempotency({
    id: paymentId,
    lead_id: leadId,
    stripe_session_id: invoiceId,
    stripe_invoice_id: invoiceId,
    stripe_customer_id: `cus_demo_${suffix}`,
    payment_link_url: invoiceUrl,
    hosted_invoice_url: invoiceUrl,
    amount_cents: 50000,
    status: 'created',
    due_at: Date.now() + 7 * 86400000,
    idempotency_key: `invoice_${leadId}_50000`
  });
  const paymentRow = paymentInsert.row || { stripe_invoice_id: invoiceId, hosted_invoice_url: invoiceUrl };
  const effectiveInvoiceId = paymentRow.stripe_invoice_id || invoiceId;
  const effectiveInvoiceUrl = paymentRow.hosted_invoice_url || paymentRow.payment_link_url || invoiceUrl;
  emit('mailer.invoice_link', {
    worker: 'mailer',
    leadId,
    runId: mailerRunId,
    invoiceUrl: effectiveInvoiceUrl,
    paymentLinkUrl: effectiveInvoiceUrl,
    amount: 50000,
    mock: true
  });

  const subject = 'Your callmemaybe website invoice + meeting invite';
  const emailBody = [
    'Hi Maria,',
    '',
    'Thanks for the quick call. The invoice is below. Once it is paid, we will start the Luna Ridge HVAC site with emergency repair copy, mobile call CTAs, service areas, and trust proof.',
    '',
    `Invoice: ${effectiveInvoiceUrl}`,
    'Follow-up meeting: https://meet.new',
    '',
    'Reply here with questions; this AgentMail thread stays attached to the build.'
  ].join('\n');

  contactEvents.add({
    lead_id: leadId,
    type: 'invoice_email',
    direction: 'outbound',
    channel: 'agentmail',
    provider_id: threadId,
    thread_id: threadId,
    subject,
    body: emailBody,
    metadata: { mockEmail: true, invoiceId: effectiveInvoiceId, invoiceUrl: effectiveInvoiceUrl, extractedInvoiceEmail: invoiceEmail }
  });
  webhookEvents.record({
    provider: 'agentmail',
    event_id: `evt_agentmail_${suffix}`,
    type: 'message.sent',
    payload: { threadId, leadId, invoiceId: effectiveInvoiceId, mock: true }
  });
  emit('agentmail.webhook', {
    worker: 'mailer',
    providerType: 'message.sent',
    threadId,
    fromMasked: maskEmail('demo@agentmail.test'),
    subject,
    preview: emailBody.slice(0, 240),
    demo: true
  });
  emit('mailer.email_sent', {
    worker: 'mailer',
    leadId,
    runId: mailerRunId,
    threadId,
    subject,
    toMasked: maskEmail(invoiceEmail),
    mock: true
  });

  const inboundPayload = {
    id: `evt_agentmail_reply_${suffix}`,
    type: 'message.received',
    direction: 'inbound',
    threadId,
    messageId: `msg_demo_${suffix}`,
    from: { email: invoiceEmail },
    subject: 'Re: Your callmemaybe website invoice + meeting invite',
    text: 'Paid it. Please make emergency repair and same-day scheduling obvious.',
    leadId
  };
  const inboundEventId = `event:${inboundPayload.id}`;
  webhookEvents.record({
    provider: 'agentmail',
    event_id: inboundEventId,
    type: inboundPayload.type,
    payload: inboundPayload
  });
  emit('agentmail.webhook', {
    worker: 'mailer',
    providerType: inboundPayload.type,
    leadId,
    threadId,
    fromMasked: maskEmail(invoiceEmail),
    subject: inboundPayload.subject,
    preview: inboundPayload.text,
    demo: true
  });
  const inboundResult = await handleAgentMailInbound({ body: inboundPayload, eventId: inboundEventId });
  if (inboundResult.ignored) {
    throw new Error(`demo inbound AgentMail reply was ignored: ${JSON.stringify(inboundResult)}`);
  }

  leads.update(leadId, {
    status: 'awaiting_payment',
    agentmail_thread_id: threadId,
    next_action: 'await_payment',
    outreach_status: 'awaiting_payment'
  });
  finishRun(mailerRunId, {
    state: 'completed',
    detail: { invoiceUrl: effectiveInvoiceUrl, paymentLinkUrl: effectiveInvoiceUrl, stripeInvoiceId: effectiveInvoiceId, threadId, mockEmail: true, mockInvoice: true }
  });
  emit('mailer.done', { worker: 'mailer', leadId, runId: mailerRunId, invoiceUrl: effectiveInvoiceUrl, paymentLinkUrl: effectiveInvoiceUrl, threadId, mock: true });

  const stripeEventId = `evt_stripe_${suffix}`;
  const stripeEvent = {
    id: stripeEventId,
    type: 'invoice.paid',
    data: { object: { id: effectiveInvoiceId, metadata: { leadId } } }
  };
  webhookEvents.record({ provider: 'stripe', event_id: stripeEventId, type: stripeEvent.type, payload: stripeEvent });
  emit('stripe.webhook', { providerType: stripeEvent.type, eventId: stripeEventId, leadId, mock: true });
  const paidBuildTriggers = [];
  const paid = recordPaidPayment(effectiveInvoiceId, leadId, {
    payment: {
      lead_id: leadId,
      stripe_invoice_id: effectiveInvoiceId,
      stripe_session_id: effectiveInvoiceId,
      stripe_customer_id: `cus_demo_${suffix}`,
      hosted_invoice_url: effectiveInvoiceUrl,
      payment_link_url: effectiveInvoiceUrl,
      amount_cents: 50000
    },
    startBuilder: (payload) => paidBuildTriggers.push(payload)
  });
  emit('stripe.paid', {
    worker: 'mailer',
    leadId,
    invoiceId: effectiveInvoiceId,
    paymentChanged: paid.changed,
    builderTriggerClaimed: paid.builderTriggerClaimed,
    buildTrigger: paid.build?.reason,
    mock: true
  });

  const builderRunId = startRun('builder', leadId, { triggeredBy: 'stripe.invoice.paid', mocked: true });
  const buildId = paid.build?.row?.id || paidBuildTriggers[0]?.buildId || `bld_demo_${suffix}`;
  const liveUrl = `/api/leads/${encodeURIComponent(leadId)}/build-preview`;
  const projectUrl = `https://luna-ridge-hvac-${suffix.slice(-4)}.lovable.app`;
  const brief = [
    'Build a clean, mobile-first website for Luna Ridge HVAC in San Francisco.',
    'Emphasize emergency HVAC repair, seasonal tuneups, furnace replacement, same-day scheduling, service areas, trust proof, and tap-to-call CTAs.',
    'Use a dependable blue and white palette with one warm accent.'
  ].join(' ');

  if (paid.build?.row?.id) {
    builds.update(buildId, {
      status: 'running',
      browser_session_id: null,
      live_url: liveUrl,
      lovable_url: `https://lovable.dev/?autosubmit=true#prompt=${encodeURIComponent(brief)}`,
      brief,
      started_at: Date.now()
    });
  } else {
    builds.start({ id: buildId, lead_id: leadId, browser_session_id: null, live_url: liveUrl });
  }
  emit('builder.start', { worker: 'builder', leadId, runId: builderRunId, triggeredBy: 'stripe.invoice.paid', mock: true });
  emit('builder.live_url', {
    worker: 'builder',
    leadId,
    runId: builderRunId,
    buildId,
    liveUrl,
    lovableUrl: `https://lovable.dev/?autosubmit=true#prompt=${encodeURIComponent(brief)}`,
    brief,
    mock: true
  });
  emit('builder.progress', {
    worker: 'builder',
    leadId,
    runId: builderRunId,
    buildId,
    summary: 'Generated the Lovable-ready brief from call, invoice, AgentMail, and research context.',
    mock: true
  });
  emit('builder.progress', {
    worker: 'builder',
    leadId,
    runId: builderRunId,
    buildId,
    summary: 'Mock Browser Use preview opened and is ready for the operator to watch.',
    mock: true
  });
  emit('builder.progress', {
    worker: 'builder',
    leadId,
    runId: builderRunId,
    buildId,
    summary: 'Final project URL captured and stored on the lead.',
    mock: true
  });
  emit('builder.project_url', { worker: 'builder', leadId, runId: builderRunId, buildId, projectUrl, mock: true });
  builds.update(buildId, { project_url: projectUrl, status: 'completed', finished_at: Date.now() });
  leads.update(leadId, { website: projectUrl, status: 'shipped', next_action: 'demo_complete', outreach_status: 'shipped' });
  finishRun(builderRunId, { state: 'completed', detail: { mock: true, liveUrl, projectUrl, buildId } });
  emit('builder.done', { worker: 'builder', leadId, runId: builderRunId, buildId, liveUrl, projectUrl, mock: true });

  return {
    leadId,
    invoiceUrl: effectiveInvoiceUrl,
    threadId,
    stripeEventId,
    liveUrl,
    projectUrl,
    inboundReplyEventId: inboundEventId,
    autoReplyId: inboundResult.outboundContactEventId
  };
}

function startRun(worker, leadId, payload = {}) {
  const runId = `${worker}_demo_${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
  runs.start({ id: runId, lead_id: leadId, worker });
  emit(`${worker}.start`, { worker, leadId, runId, ...payload, demo: true });
  return runId;
}

function finishRun(runId, { state = 'completed', detail = {}, error = null } = {}) {
  runs.finish(runId, { state, error, detail });
}

function completeRun({ worker, leadId, startEvent = {}, detail = {} }) {
  const runId = startRun(worker, leadId, startEvent);
  finishRun(runId, { state: 'completed', detail });
  emit(`${worker}.done`, { worker, leadId, runId, ...detail, demo: true });
  return runId;
}

async function verifyUiPath({ leadId, dataDir, allowLiveEnv }) {
  const port = await getFreePort();
  const childEnv = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir
  };
  forceMockEnv({ dataDir, allowLiveEnv, target: childEnv });

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (buf) => logs.push(buf.toString()));
  child.stderr.on('data', (buf) => logs.push(buf.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child);
    const [health, leadList, detail, html] = await Promise.all([
      fetchJson(`${baseUrl}/api/health`),
      fetchJson(`${baseUrl}/api/leads`),
      fetchJson(`${baseUrl}/api/leads/${leadId}`),
      fetchText(`${baseUrl}/`)
    ]);

    const found = (leadList.leads || []).some((lead) => lead.id === leadId);
    const analystRun = (detail.runs || []).find((run) => run.worker === 'analyst');
    const analystDetail = safeJson(analystRun?.detail_json);
    const checks = {
      healthOk: health.ok === true,
      mockMode: health.mode === 'mock' || allowLiveEnv,
      leadListed: found,
      leadDetail: detail.lead?.id === leadId,
      postCallContext: analystDetail?.postMortem?.invoiceEmail === 'maria@lunaridgehvac.test',
      invoicePaid: detail.latestInvoice?.status === 'paid',
      agentmailContact: (detail.contactEvents || []).some((event) => event.channel === 'agentmail'),
      buildCompleted: detail.buildStatus === 'completed',
      htmlServed: html.includes('id="root"') || html.includes('callmemaybe')
    };
    const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    if (failures.length) throw new Error(`UI/API verification failed: ${failures.join(', ')}`);

    commandsRun.push(`PORT=${port} DATA_DIR=${dataDir} node server/index.js`);
    return {
      baseUrl,
      checks,
      leadStatus: detail.lead.status,
      paymentStatus: detail.latestInvoice?.status,
      buildStatus: detail.buildStatus,
      agentmailEvents: (detail.contactEvents || []).filter((event) => event.channel === 'agentmail').length
    };
  } finally {
    await stopChild(child);
  }
}

async function runCommand(cmd, cmdArgs, { label }) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: args.verbose ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    if (!args.verbose) {
      child.stdout.on('data', (buf) => { output += buf.toString(); });
      child.stderr.on('data', (buf) => { output += buf.toString(); });
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolvePromise();
      const tail = output.split('\n').slice(-30).join('\n');
      reject(new Error(`${label} failed with exit ${code}\n${tail}`));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < 10000) {
    if (child.exitCode != null) throw new Error(`server exited during UI verification with code ${child.exitCode}`);
    try {
      const health = await fetchJson(`${baseUrl}/api/health`);
      if (health.ok) return health;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`server did not become healthy: ${lastErr?.message || 'timeout'}`);
}

async function stopChild(child) {
  if (child.exitCode != null || child.killed) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    sleep(1500).then(() => false)
  ]);
  if (!exited && child.exitCode == null) child.kill('SIGKILL');
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${url} ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function getFreePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
    server.on('error', reject);
  });
}

async function resetDemoData(dataDir) {
  const dbPath = resolve(repoRoot, dataDir, 'callmemaybe.db');
  for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
    if (existsSync(path)) await rm(path, { force: true });
  }
}

function forceMockEnv({ dataDir, allowLiveEnv, target = process.env }) {
  target.DATA_DIR = dataDir;
  if (allowLiveEnv) return;

  target.RUN_MODE = 'mock';
  target.LIVE_CALLS = 'false';
  target.LIVE_EMAILS = 'false';
  target.LIVE_PAYMENTS = 'false';
  target.LIVE_BUILDS = 'false';
  target.AUTONOMOUS_OUTREACH_ENABLED = 'false';

  for (const key of [
    'GEMINI_API_KEY',
    'SUPERMEMORY_API_KEY',
    'AGENTPHONE_API_KEY',
    'MOSS_PROJECT_ID',
    'MOSS_PROJECT_KEY',
    'BROWSER_USE_API_KEY',
    'AGENTMAIL_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET'
  ]) {
    target[key] = '';
  }
}

function parseArgs(argv) {
  const parsed = {
    build: true,
    verifyUi: true,
    dataDir: null,
    leadId: null,
    resetDemoData: false,
    allowLiveEnv: false,
    verbose: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--no-build') parsed.build = false;
    else if (arg === '--no-verify-ui') parsed.verifyUi = false;
    else if (arg === '--reset-demo-data') parsed.resetDemoData = true;
    else if (arg === '--allow-live-env') parsed.allowLiveEnv = true;
    else if (arg === '--verbose') parsed.verbose = true;
    else if (arg === '--data-dir') parsed.dataDir = argv[++i];
    else if (arg.startsWith('--data-dir=')) parsed.dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--lead-id') parsed.leadId = argv[++i];
    else if (arg.startsWith('--lead-id=')) parsed.leadId = arg.slice('--lead-id='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`callmemaybe end-to-end demo

Usage:
  npm run demo:e2e
  npm run demo:e2e -- --data-dir .data/demo --reset-demo-data

Options:
  --no-build          Skip npm run build before API/static verification.
  --no-verify-ui     Seed the mocked lifecycle only; do not start a local server.
  --data-dir <path>  SQLite data directory. Default: DATA_DIR or .data.
  --lead-id <id>     Use a specific lead id instead of a generated one.
  --reset-demo-data  Delete the target demo SQLite files before seeding.
  --allow-live-env   Preserve provider env vars for verification reads. Default blanks them.
  --verbose          Stream child command output.
`);
}

function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 5) return s;
  return `${s.slice(0, 3)}...${s.slice(-2)}`;
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0]}***@***.${tld}`;
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
