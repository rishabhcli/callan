#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-inbound-anything-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BUILDS: 'false',
  LIVE_BROWSER_SESSIONS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false',
  GEMINI_API_KEY: '',
  SUPERMEMORY_API_KEY: '',
  AGENTMAIL_API_KEY: '',
  AGENTMAIL_INBOX_ID: '',
  AGENTPHONE_API_KEY: '',
  AGENTPHONE_FROM_NUMBER: '+16626021352',
  STRIPE_SECRET_KEY: '',
  BROWSER_USE_API_KEY: '',
  FULFILLMENT_MOCK_DELAY_MS: '1'
});

const results = [];

const [
  dbApi,
  agentPhoneWebhook,
  mailer,
  customerPortal,
  inboundVoiceQueue,
  builderWorker,
  builderQueue
] = await Promise.all([
  import('../server/db.js'),
  import('../server/webhooks/agentphone.js'),
  import('../server/workers/mailer.js'),
  import('../server/customerPortal.js'),
  import('../server/inboundVoiceQueue.js'),
  import('../server/workers/builder.js'),
  import('../server/builderQueue.js')
]);

try {
  await check('voice inbound creates lead, memory, quote, portal, and summary', async () => {
    const req = fakeReq({
      event: 'call.ended',
      direction: 'inbound',
      callId: 'ap_voice_barber_1',
      from: '+15105550100',
      to: '+16626021352',
      status: 'completed',
      transcript: {
        turns: [
          {
            role: 'user',
            text: 'Hi, this is Maya. I run a barber shop in Oakland called Temescal Barber Co. We do haircuts, beard trims, and hot towel shaves. Our phone is (510) 555-0100 and email is owner@temescalbarber.test. We are open Tue-Sat 9am-6pm. The CTA should be call to book. The $500 flat price works, build me a site this week.'
          },
          {
            role: 'agent',
            text: 'Perfect, I have enough to prepare the quote path and send a summary.'
          }
        ]
      }
    });

    const result = await agentPhoneWebhook.handleAgentPhoneWebhook(req);
    assert(result.ok, `webhook failed: ${JSON.stringify(result)}`);
    await runQueuedInboundVoiceFollowups(dbApi, inboundVoiceQueue);
    const call = dbApi.db.prepare('SELECT * FROM calls WHERE provider_call_id = ?').get('ap_voice_barber_1');
    assert(call?.lead_id, 'voice call did not create a call row with lead_id');
    const lead = dbApi.leads.get(call.lead_id);
    const profile = parseJson(lead.research_json);
    const docs = dbApi.memoryDocuments.listByLead(lead.id);
    const payments = dbApi.payments.listByLead(lead.id);
    const contacts = dbApi.contactEvents.listByLead(lead.id, { limit: 50 });
    assert(lead.business_name === 'Temescal Barber Co', `voice lead name not extracted: ${lead.business_name}`);
    assert(lead.outreach_status === 'awaiting_payment', `voice lead not quote-ready: ${lead.outreach_status}`);
    assert(profile?.provenance?.intakeSource === 'inbound_voice', `voice source missing: ${JSON.stringify(profile?.provenance)}`);
    assert(docs.some((doc) => doc.kind === 'business_profile'), 'voice business_profile memory missing');
    assert(docs.some((doc) => doc.kind === 'build_brief'), 'voice build_brief memory missing');
    assert(payments[0]?.hosted_invoice_url, 'voice mock invoice missing');
    assert(contacts.some((event) => event.type === 'intake_summary' && event.direction === 'outbound'), 'voice summary email missing');
    return {
      leadId: lead.id,
      portal: `/share/build/${lead.id}`,
      invoice: payments[0].hosted_invoice_url,
      memoryDocs: docs.length
    };
  });

  await check('email inbound asks one missing question, then dedupes and quotes', async () => {
    const first = await mailer.handleAgentMailInbound(agentmailBody({
      eventId: 'evt_email_missing',
      messageId: 'msg_email_missing',
      threadId: 'thread_email_barber',
      fromEmail: 'owner@piedmontcuts.test',
      subject: 'Build me a site',
      text: 'I run a barber shop in Oakland; build me a site.'
    }));
    assert(!first.ignored, 'first email was ignored');
    assert(first.intake?.leadId, 'first email did not create a lead');
    assert(first.intake.requiredMissingFields[0] === 'businessName', `expected businessName question, got ${first.intake.requiredMissingFields.join(',')}`);
    assert(/exact business name/i.test(first.replyText), `missing-info reply wrong: ${first.replyText}`);

    const leadAfterFirst = dbApi.leads.get(first.intake.leadId);
    const second = await mailer.handleAgentMailInbound(agentmailBody({
      eventId: 'evt_email_complete',
      messageId: 'msg_email_complete',
      threadId: 'thread_email_barber',
      fromEmail: 'owner@piedmontcuts.test',
      subject: 'Re: Build me a site',
      text: 'The shop is called Piedmont Cuts. Phone is 510-555-0199. Services include haircuts, beard trims, and hot towel shaves. Hours are Tue-Sat 9am-6pm. CTA should be call to book. The $500 flat price works.'
    }));
    assert(second.leadId === leadAfterFirst.id, 'second email did not dedupe to the same lead');
    assert(second.intake.readyForQuote === true, `second email not quote-ready: ${JSON.stringify(second.intake)}`);
    assert(/Portal:/i.test(second.replyText), `portal missing from ready reply: ${second.replyText}`);
    assert(/invoice\.stripe\.test/i.test(second.replyText), `mock invoice missing from ready reply: ${second.replyText}`);

    const lead = dbApi.leads.get(second.leadId);
    const profile = parseJson(lead.research_json);
    const payments = dbApi.payments.listByLead(lead.id);
    assert(lead.business_name === 'Piedmont Cuts', `email lead name not updated: ${lead.business_name}`);
    assert(profile?.provenance?.intakeSource === 'inbound_email', `email source missing: ${JSON.stringify(profile?.provenance)}`);
    assert(payments[0]?.hosted_invoice_url, 'email mock invoice missing');
    return {
      leadId: lead.id,
      duplicateCount: lead.duplicate_count,
      invoice: payments[0].hosted_invoice_url
    };
  });

  await check('email approval reply starts preview build path', async () => {
    const approval = await mailer.handleAgentMailInbound(agentmailBody({
      eventId: 'evt_email_approve',
      messageId: 'msg_email_approve',
      threadId: 'thread_email_barber',
      fromEmail: 'owner@piedmontcuts.test',
      subject: 'Re: Build me a site',
      text: 'Approved, go ahead and start the build.'
    }));
    assert(!approval.ignored, 'approval reply ignored');
    assert(approval.previewKickoff?.triggeredAt, `preview kickoff missing: ${JSON.stringify(approval.previewKickoff)}`);
    const lead = dbApi.leads.get(approval.leadId);
    await runQueuedPreviewBuilds(dbApi, builderWorker, builderQueue, lead.id);
    const builds = await waitForBuild(dbApi, lead.id);
    assert(lead.preview_build_triggered_at, 'lead preview_build_triggered_at missing');
    assert(builds[0], 'preview build row missing');
    assert(['running', 'qa_review', 'completed'].includes(builds[0].status), `unexpected build status ${builds[0].status}: ${builds[0].error || 'no error'}`);
    return {
      leadId: lead.id,
      buildId: builds[0].id,
      buildStatus: builds[0].status,
      nextAction: lead.next_action
    };
  });

  await check('portal accept reuses inbound quote path', async () => {
    const lead = dbApi.db.prepare(`
      SELECT * FROM leads
      WHERE agentmail_thread_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get('thread_email_barber');
    assert(lead, 'email lead missing for portal accept');
    const result = await customerPortal.acceptQuote({ leadId: lead.id });
    assert(result.ok === true, `portal accept blocked: ${JSON.stringify(result)}`);
    assert(result.invoiceUrl || result.paymentLinkUrl, 'portal accept did not return invoice path');
    return {
      leadId: lead.id,
      invoiceUrl: result.invoiceUrl || result.paymentLinkUrl
    };
  });

  await check('callback intent schedules a follow-up call', async () => {
    const callback = await mailer.handleAgentMailInbound(agentmailBody({
      eventId: 'evt_email_callback',
      messageId: 'msg_email_callback',
      threadId: 'thread_email_callback',
      fromEmail: 'owner@greenfernyards.test',
      subject: 'Schedule a call',
      text: 'Please schedule a call tomorrow at 10am at 510-555-0123. I run a landscaping company in Oakland called Green Fern Yards. Services include yard maintenance and garden cleanup. CTA should be request a quote. The $500 flat price works.'
    }));
    assert(!callback.ignored, 'callback email ignored');
    assert(callback.intake?.scheduledCall?.id, `scheduled call missing: ${JSON.stringify(callback.intake)}`);
    assert(callback.intake.nextAction === 'schedule_callback', `callback next action wrong: ${callback.intake.nextAction}`);
    assert(/scheduled a follow-up callback|call you at/i.test(callback.replyText), `callback reply wrong: ${callback.replyText}`);
    const lead = dbApi.leads.get(callback.leadId);
    const row = dbApi.scheduledCalls.findPendingForLead(lead.id);
    assert(row?.id === callback.intake.scheduledCall.id, 'pending scheduled call was not persisted');
    return {
      leadId: lead.id,
      scheduledCallId: row.id,
      status: row.status
    };
  });
} finally {
  const ok = results.every((result) => result.ok);
  console.log('\n=== INBOUND ANYTHING CHECK ===');
  for (const result of results) {
    console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] inbound-anything ${ok ? 'passed' : 'failed'}`);
  rmSync(dataDir, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: formatDetail(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.stack || err?.message || String(err) });
  }
}

function fakeReq(body) {
  return { headers: {}, body };
}

function agentmailBody({ eventId, messageId, threadId, fromEmail, subject, text }) {
  return {
    event_id: eventId,
    event_type: 'message.received',
    direction: 'inbound',
    inbox_id: 'inbox_mock',
    message_id: messageId,
    thread_id: threadId,
    from: { email: fromEmail },
    subject,
    text
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

async function runQueuedInboundVoiceFollowups(dbApi, inboundVoiceQueue) {
  const jobs = dbApi.durableJobs
    .list({ status: 'queued', type: inboundVoiceQueue.INBOUND_VOICE_FOLLOWUP_JOB_TYPE, limit: 20 })
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  for (const job of jobs) {
    const result = await inboundVoiceQueue.handleInboundVoiceFollowupJob(job.payload || {});
    dbApi.durableJobs.complete(job.id, { result });
  }
}

async function runQueuedPreviewBuilds(dbApi, builderWorker, builderQueue, leadId) {
  const jobs = dbApi.durableJobs
    .list({ status: 'queued', type: builderQueue.BUILDER_BUILD_JOB_TYPE, limit: 20 })
    .filter((job) => job.payload?.previewBuild && job.payload?.leadId === leadId)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  for (const job of jobs) {
    const result = await builderWorker.runPreviewBuilder({
      leadId: job.payload.leadId,
      target: job.payload.target
    });
    dbApi.durableJobs.complete(job.id, { result });
  }
}

async function waitForBuild(dbApi, leadId, { timeoutMs = 1500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const builds = dbApi.builds.listByLead(leadId);
    if (builds[0]) return builds;
    await delay(50);
  }
  return dbApi.builds.listByLead(leadId);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  return JSON.stringify(detail);
}
