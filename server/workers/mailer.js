import { createHash, randomBytes } from 'node:crypto';
import { emit } from '../sse.js';
import { runs, payments, leads, contactEvents } from '../db.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { addDoc, containerTagFor, getLatest } from '../memory.js';
import { generateText } from '../gemini.js';
import { agentMailWebhookEventId, isInboundAgentMailWebhook, normalizeAgentMailWebhook } from '../webhooks/agentmail.js';
import { classifyMessage } from './mailReply.js';
import { createHostedInvoice } from '../providers/stripe.js';
import {
  createMockAgentMailSendResult,
  normalizeAgentMailMessage,
  replyAgentMailMessage,
  sendAgentMailMessage
} from '../providers/agentmail.js';

export { runAgentMailLiveSendSmoke } from '../providers/agentmail.js';

const ICS_DT_FMT = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const SUPPORTED_REPLY_SCOPE = [
  'invoice questions',
  'scheduling',
  'website brief and customer needs',
  'website revisions',
  'pricing',
  'build progress',
  'opt-out or unsubscribe'
].join(', ');

function pad(n) {
  return String(n).padStart(2, '0');
}

function maskEmail(addr) {
  if (!addr || typeof addr !== 'string' || !addr.includes('@')) return '***';
  const [local, domain] = addr.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0]}***@***.${tld}`;
}

function shouldMockInvoices() {
  return !['live', 'demo_live', 'autonomous_live'].includes(env.runMode) || !env.live.payments || !env.stripe.secretKey;
}

function shouldMockEmail(toEmail) {
  if (!['live', 'demo_live', 'autonomous_live'].includes(env.runMode)) return true;
  if (!env.live.emails) return true;
  if (!env.agentmail.apiKey || !env.agentmail.inboxId) return true;
  if (env.runMode === 'demo_live' && !env.allowedEmails.includes(toEmail)) return true;
  return false;
}

function readDoc(doc) {
  if (!doc) return null;
  const raw = doc.content || doc.text || doc.body || '';
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function nextWeekdayTen(now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start, end };
}

function buildIcs({ uid, summary, description, location, organizerEmail, attendeeEmail, start, end }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//callmemaybe//mailer//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${ICS_DT_FMT(new Date())}`,
    `DTSTART:${ICS_DT_FMT(start)}`,
    `DTEND:${ICS_DT_FMT(end)}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `LOCATION:${escapeIcs(location)}`,
    `ORGANIZER;CN=callmemaybe:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${attendeeEmail};RSVP=TRUE:mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lines.join('\r\n');
}

function escapeIcs(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

async function writeRecap({ businessName, profile, postMortem }) {
  try {
    if (!env.gemini.apiKey) throw new Error('no gemini');
    const whatTheyDo = profile?.whatTheyDo || profile?.what_they_do || 'their services';
    const replay = postMortem?.replayWorthy || postMortem?.summary || '';
    const prompt = [
      `Write a 100-150 word follow-up email body to ${businessName}.`,
      `What they do: ${whatTheyDo}.`,
      replay ? `From our call: ${replay}.` : '',
      `Reference: we agreed on a simple website that highlights what they do, includes contact info, hours, and a way for customers to reach them.`,
      `Warm, specific, no markdown, no headers, no bullet lists. Sign as "the team at callmemaybe".`
    ]
      .filter(Boolean)
      .join('\n');
    const text = await generateText({ prompt, flash: true, thinkingLevel: 'minimal' });
    if (text && text.trim().length > 40) return text.trim();
  } catch (err) {
    log.warn('mailer.recap_fallback', { err: err.message });
  }
  return [
    `Hi ${businessName},`,
    '',
    `Thanks for the chat earlier. As we discussed, we will put together a simple, polished website that shows off what you do, makes you easy to find, and gives your customers a clear way to reach you.`,
    '',
      `Your invoice is below. Once it is paid, the build kicks off and you can watch it happen live. You can also reply to this AgentMail thread with questions before or after payment.`,
    '',
    `Talk soon,`,
    `the team at callmemaybe`
  ].join('\n');
}

async function createStripeInvoice({ leadId, businessName, toEmail, idempotencyKey }) {
  return createHostedInvoice({ leadId, businessName, toEmail, idempotencyKey });
}

async function sendInvoiceAgentMail({ toEmail, subject, text, html, icsBase64 }) {
  return sendAgentMailMessage({
    toEmail,
    subject,
    text,
    html,
    attachments: [
      {
        filename: 'meeting.ics',
        content: icsBase64,
        contentType: 'text/calendar'
      }
    ]
  }, { timeoutSeconds: 15, maxRetries: 2 });
}

export async function runMailer({ leadId, toEmail }) {
  const runId = `mail_${Date.now().toString(36)}`;
  runs.start({ id: runId, lead_id: leadId, worker: 'mailer' });
  emit('mailer.start', { worker: 'mailer', leadId, runId });

  try {
    const lead = leads.get(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);

    const tag = containerTagFor(leadId);
    const [profileDoc, postMortemDoc] = await Promise.all([
      getLatest(tag, 'profile').catch(() => null),
      getLatest(tag, 'post_mortem').catch(() => null)
    ]);
    const profile = readDoc(profileDoc) || {};
    const postMortem = readDoc(postMortemDoc) || {};

    const businessName = lead.business_name || profile.businessName || 'your business';
    const recap = await writeRecap({ businessName, profile, postMortem });

    const idempotencyKey = `invoice_${leadId}_${env.stripe.priceCents}`;
    const existingPayment = payments.getByIdempotency(idempotencyKey);
    let invoice = existingPayment ? {
      id: existingPayment.stripe_invoice_id || existingPayment.stripe_session_id,
      customerId: existingPayment.stripe_customer_id,
      url: existingPayment.hosted_invoice_url || existingPayment.payment_link_url,
      dueAt: existingPayment.due_at
    } : { id: `in_demo_${leadId}`, customerId: null, url: `https://invoice.stripe.com/i/demo_${leadId}`, dueAt: Date.now() + 7 * 86400000 };
    if (existingPayment) {
      log.info('mailer.invoice_reuse', { leadId, paymentId: existingPayment.id });
    } else if (shouldMockInvoices()) {
      log.info('mailer.invoice_mock', { leadId });
    } else {
      invoice = await createStripeInvoice({ leadId, businessName, toEmail, idempotencyKey });
      log.info('mailer.invoice_created', {
        leadId,
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        customerReused: invoice.customerReused,
        customerReuseReason: invoice.customerReuseReason
      });
    }

    if (!existingPayment) {
      const savedPayment = payments.insertOrGetByIdempotency({
        id: `pay_${randomBytes(6).toString('hex')}`,
        lead_id: leadId,
        stripe_session_id: invoice.id,
        stripe_invoice_id: invoice.id,
        stripe_customer_id: invoice.customerId,
        payment_link_url: invoice.url,
        hosted_invoice_url: invoice.url,
        amount_cents: env.stripe.priceCents,
        status: 'created',
        due_at: invoice.dueAt,
        idempotency_key: idempotencyKey
      });
      if (!savedPayment.inserted && savedPayment.row) {
        invoice = {
          ...invoice,
          id: savedPayment.row.stripe_invoice_id || savedPayment.row.stripe_session_id || invoice.id,
          customerId: savedPayment.row.stripe_customer_id || invoice.customerId,
          url: savedPayment.row.hosted_invoice_url || savedPayment.row.payment_link_url || invoice.url,
          dueAt: savedPayment.row.due_at || invoice.dueAt
        };
        log.info('mailer.invoice_idempotent_race_reuse', { leadId, paymentId: savedPayment.row.id });
      }
    }
    emit('mailer.invoice_link', {
      worker: 'mailer',
      leadId,
      runId,
      invoiceUrl: invoice.url,
      paymentLinkUrl: invoice.url,
      amount: env.stripe.priceCents
    });

    const { start, end } = nextWeekdayTen();
    const meetingUrl = 'https://meet.new';
    const organizer = `${env.agentmail.displayName || 'callmemaybe'}@agentmail.to`;
    const ics = buildIcs({
      uid: `${leadId}-${runId}@callmemaybe`,
      summary: `Website kickoff with callmemaybe`,
      description: `30-minute follow-up to walk through your new site. Join here: ${meetingUrl}`,
      location: meetingUrl,
      organizerEmail: organizer,
      attendeeEmail: toEmail || 'guest@example.com',
      start,
      end
    });
    const icsBase64 = Buffer.from(ics, 'utf8').toString('base64');

    const subject = `Your callmemaybe website invoice + meeting invite`;
    const bodyText = [
      recap,
      '',
      `Invoice: ${invoice.url}`,
      `Follow-up meeting: ${meetingUrl} (calendar invite attached)`,
      `Reply to this email anytime — the agent will use this AgentMail thread to answer questions and keep the build moving.`
    ].join('\n');
    const invoiceHref = escapeHtml(invoice.url);
    const meetingHref = escapeHtml(meetingUrl);
    const bodyHtml = [
      htmlParagraphs(recap),
      `<p><a href="${invoiceHref}">Open invoice</a></p>`,
      `<p>Follow-up meeting: <a href="${meetingHref}">${meetingHref}</a> (calendar invite attached)</p>`,
      '<p>Reply to this email anytime — the agent will use this AgentMail thread to answer questions and keep the build moving.</p>'
    ].join('');

    let sendResult;
    if (shouldMockEmail(toEmail)) {
      sendResult = createMockAgentMailSendResult({
        threadId: `mock-thread-${randomBytes(6).toString('hex')}`,
        messageId: `mock-agentmail-message-${randomBytes(6).toString('hex')}`,
        subject
      });
      log.info('mailer.email_mock', { leadId, toMasked: maskEmail(toEmail) });
    } else {
      sendResult = await sendInvoiceAgentMail({
        toEmail,
        subject,
        text: bodyText,
        html: bodyHtml,
        icsBase64
      });
    }
    const threadId = sendResult.threadId;

    contactEvents.add({
      lead_id: leadId,
      type: 'invoice_email',
      direction: 'outbound',
      channel: 'agentmail',
      provider_id: sendResult.providerId,
      thread_id: threadId,
      subject,
      body: bodyText,
      metadata: {
        toMasked: maskEmail(toEmail),
        messageId: sendResult.messageId,
        invoiceId: invoice.id,
        invoiceUrl: invoice.url,
        stripeCustomerId: invoice.customerId,
        stripeCustomerReused: invoice.customerReused,
        mockEmail: sendResult.mock,
        mockInvoice: shouldMockInvoices()
      }
    });

    try {
      await addDoc(tag, 'mail_thread', {
        direction: 'outbound',
        threadId,
        messageId: sendResult.messageId,
        subject,
        body: bodyText,
        invoiceUrl: invoice.url,
        at: new Date().toISOString()
      }, { kind: 'invoice_email', mockEmail: sendResult.mock });
    } catch (err) {
      log.warn('mailer.memory.add_failed', { leadId, error: err?.message || String(err) });
    }

    emit('mailer.email_sent', {
      worker: 'mailer',
      leadId,
      runId,
      threadId,
      messageId: sendResult.messageId,
      subject,
      toMasked: maskEmail(toEmail),
      mock: sendResult.mock
    });

    leads.update(leadId, {
      status: 'awaiting_payment',
      agentmail_thread_id: threadId,
      next_action: 'await_payment',
      outreach_status: 'awaiting_payment'
    });

    const detail = {
      invoiceUrl: invoice.url,
      paymentLinkUrl: invoice.url,
      stripeInvoiceId: invoice.id,
      threadId,
      messageId: sendResult.messageId,
      mockEmail: sendResult.mock,
      mockInvoice: shouldMockInvoices()
    };
    runs.finish(runId, { state: 'completed', detail });
    emit('mailer.done', { worker: 'mailer', leadId, runId, invoiceUrl: invoice.url, paymentLinkUrl: invoice.url, threadId });

    return { invoiceUrl: invoice.url, threadId, messageId: sendResult.messageId };
  } catch (err) {
    runs.finish(runId, { state: 'failed', error: err.message });
    emit('mailer.error', { worker: 'mailer', leadId, runId, error: err.message });
    log.error('mailer.failed', { leadId, runId, err: err.message });
    throw err;
  }
}

export async function handleAgentMailInbound(input = {}, options = {}) {
  const body = input.body || input;
  let msg = input.normalized || normalizeAgentMailWebhook(body);
  const eventId = input.eventId || options.eventId || agentMailWebhookEventId(input.req || options.req, body, msg);

  if (!isInboundAgentMailWebhook(body, msg)) {
    return { ignored: true, reason: 'not_inbound', eventId, msg };
  }

  msg = await hydrateInboundAgentMailMessage(msg);
  if (isSelfAgentMailAddress(msg.fromEmail)) {
    return { ignored: true, reason: 'self_message', eventId, msg };
  }

  const lead = findLeadForAgentMail(msg, body);
  const leadId = lead?.id || body.leadId || body.lead_id || null;
  const classification = classifyAgentMailReply({ subject: msg.subject, text: msg.text });
  const inboundEvent = addContactEventOnce({
    id: contactEventId('in', eventId, msg),
    lead_id: leadId,
    type: 'customer_reply',
    direction: 'inbound',
    channel: 'agentmail',
    provider_id: msg.messageId,
    thread_id: msg.threadId,
    subject: msg.subject,
    body: msg.text || msg.preview || '',
    metadata: {
      eventId,
      inboxId: msg.inboxId,
      fromMasked: maskEmail(msg.fromEmail),
      textSource: msg.textSource,
      fetched: !!msg.fetched,
      fetchError: msg.fetchError || null,
      classification
    }
  });

  if (!inboundEvent.inserted) {
    log.info('agentmail.inbound_duplicate_contact_event', { eventId, contactEventId: inboundEvent.id, threadId: msg.threadId });
    return { ignored: true, duplicate: true, eventId, leadId, msg };
  }

  if (leadId) {
    await writeMailMemory(leadId, 'inbound', msg, { eventId, classification });
    if (classification.kind === 'opt_out') {
      leads.update(leadId, {
        risk_status: 'email-opt-out',
        next_action: 'do_not_email'
      });
    } else if (classification.operatorFlag) {
      leads.update(leadId, {
        risk_status: 'operator-handoff',
        next_action: 'operator_review_mail'
      });
    }
  }

  emit('mailer.inbound_message', {
    worker: 'mailer',
    leadId,
    threadId: msg.threadId,
    messageId: msg.messageId,
    fromMasked: maskEmail(msg.fromEmail),
    subject: msg.subject,
    classification: classification.kind,
    classificationScope: classification.scope,
    supported: classification.supported,
    operatorFlag: classification.operatorFlag,
    policy: classification,
    preview: (msg.text || msg.preview || '').slice(0, 240)
  });

  const history = leadId ? recentAgentMailEvents(leadId) : [];
  const replyText = await draftAgentMailReply({ lead, msg, classification, history });
  const sendResult = await sendAgentMailAutoReply({ msg, text: replyText, eventId });
  const replySubject = `Re: ${stripRe(msg.subject)}`;

  const outboundEvent = addContactEventOnce({
    id: contactEventId('out', eventId, msg),
    lead_id: leadId,
    type: classification.operatorFlag ? 'handoff_reply' : 'agent_reply',
    direction: 'outbound',
    channel: 'agentmail',
    provider_id: sendResult.providerId,
    thread_id: sendResult.threadId || msg.threadId,
    subject: replySubject,
    body: replyText,
    metadata: {
      eventId,
      inboxId: sendResult.inboxId || msg.inboxId,
      messageId: sendResult.messageId,
      inReplyTo: msg.messageId,
      toMasked: maskEmail(msg.fromEmail),
      mock: sendResult.mock,
      classification
    }
  });

  if (leadId) {
    await writeMailMemory(leadId, 'outbound', {
      ...msg,
      threadId: sendResult.threadId || msg.threadId,
      messageId: sendResult.messageId,
      subject: replySubject,
      text: replyText
    }, { eventId, classification, mock: sendResult.mock });
  }

  emit('mailer.auto_reply', {
    worker: 'mailer',
    leadId,
    threadId: sendResult.threadId || msg.threadId,
    messageId: sendResult.messageId || sendResult.providerId,
    subject: replySubject,
    classification: classification.kind,
    classificationScope: classification.scope,
    supported: classification.supported,
    operatorFlag: classification.operatorFlag,
    policy: classification,
    mock: sendResult.mock
  });

  return {
    ignored: false,
    eventId,
    leadId,
    inboundContactEventId: inboundEvent.id,
    outboundContactEventId: outboundEvent.id,
    replyText,
    classification,
    sendResult
  };
}

function classifyAgentMailReply(input) {
  return classifyMessage(input);
}

async function hydrateInboundAgentMailMessage(msg) {
  if (!shouldFetchAgentMailMessage(msg)) return msg;
  if (!env.agentmail.apiKey || !msg.inboxId || !msg.messageId) {
    return { ...msg, fetchSkipped: 'missing_agentmail_config_or_message_id' };
  }

  try {
    const { AgentMailClient } = await import('agentmail');
    const mail = new AgentMailClient({ apiKey: env.agentmail.apiKey });
    const fetched = await mail.inboxes.messages.get(msg.inboxId, msg.messageId, {
      timeoutInSeconds: 12,
      maxRetries: 2
    });
    const providerMsg = normalizeAgentMailMessage(fetched, msg);
    const webhookMsg = normalizeAgentMailWebhook({
      event_type: msg.eventType,
      event_id: msg.eventId,
      message: fetched
    });
    return mergeAgentMailMessage(msg, providerMsg, webhookMsg, { fetched: true });
  } catch (err) {
    log.warn('agentmail.inbound_fetch_failed', {
      inboxId: msg.inboxId,
      messageId: msg.messageId,
      error: err?.message || String(err)
    });
    return { ...msg, fetchError: err?.message || String(err) };
  }
}

function shouldFetchAgentMailMessage(msg) {
  if (!msg.messageId) return false;
  if (!msg.text || msg.textSource === 'preview' || msg.textSource === 'empty') return true;
  return !msg.threadId || !msg.fromEmail || !msg.subject;
}

function mergeAgentMailMessage(...parts) {
  const merged = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part || {})) {
      if (value === undefined || value === null || value === '') continue;
      merged[key] = value;
    }
  }
  return merged;
}

function findLeadForAgentMail(msg, body = {}) {
  if (msg.threadId) {
    const byThread = contactEvents.findLeadByThread(msg.threadId);
    if (byThread) return byThread;
  }
  const leadId = body.leadId || body.lead_id || body.data?.leadId || body.data?.lead_id;
  return leadId ? leads.get(leadId) : null;
}

function recentAgentMailEvents(leadId) {
  return contactEvents.listByLead(leadId, { limit: 8 })
    .slice()
    .reverse()
    .filter((event) => event.channel === 'agentmail')
    .map((event) => ({
      direction: event.direction,
      type: event.type,
      subject: event.subject,
      body: event.body
    }));
}

async function draftAgentMailReply({ lead, msg, classification, history }) {
  if (classification.kind === 'opt_out') {
    return 'Understood. We will stop emailing this thread. Thanks for letting us know.';
  }
  if (classification.operatorFlag) {
    return 'Thanks for asking. I can only handle invoice questions, scheduling, website briefs, revisions, pricing, build progress, and opt-outs in this automated thread. I have flagged the operator and paused the automated handling so a human can review this safely.';
  }

  try {
    if (!env.gemini.apiKey) throw new Error('GEMINI_API_KEY missing');
    const prompt = [
      `Business: ${lead?.business_name || 'unknown small business'}`,
      `Customer email subject: ${msg.subject}`,
      `Customer message:`,
      msg.text || msg.preview || '(empty)',
      '',
      `Policy classification: ${classification.scope} (${classification.reason}).`,
      history?.length ? `Recent AgentMail context:\n${formatAgentMailHistory(history)}` : '',
      '',
      `Reply as callmemaybe's autonomous AgentMail agent.`,
      `Stay strictly inside this service scope: ${SUPPORTED_REPLY_SCOPE}.`,
      `Be brief, concrete, and useful. If they ask for anything outside scope, say a human will review it.`,
      `Do not make legal promises, SEO guarantees, custom contract commitments, or unsupported delivery claims.`,
      `No markdown. No subject line.`
    ].filter(Boolean).join('\n');
    const text = await generateText({
      prompt,
      systemInstruction: 'You write concise customer-service email replies for a small-business website agency. No markdown.',
      thinkingLevel: 'low',
      flash: true
    });
    if (text && text.trim().length > 15) return text.trim();
  } catch (err) {
    log.warn('agentmail.reply.gemini_fallback', { error: err?.message || String(err) });
  }

  return 'Thanks for the note. The invoice, scheduling, website brief, revisions, pricing, and build progress can all be handled right here in this thread. Send any details you want reflected on the site and I will keep the build moving.';
}

async function sendAgentMailAutoReply({ msg, text, eventId }) {
  const subject = `Re: ${stripRe(msg.subject)}`;
  if (!msg.fromEmail || shouldMockEmail(msg.fromEmail)) {
    return createMockAgentMailSendResult({
      threadId: msg.threadId || `mock-thread-${safeId(eventId)}`,
      messageId: `mock-agentmail-reply-${safeId(eventId)}`,
      subject
    });
  }

  return replyAgentMailMessage({
    inboxId: msg.inboxId || env.agentmail.inboxId,
    messageId: msg.messageId,
    toEmail: msg.fromEmail,
    subject,
    text,
    html: htmlParagraphs(text)
  }, { timeoutSeconds: 15, maxRetries: 2 });
}

function addContactEventOnce(event) {
  try {
    return { id: contactEvents.add(event), inserted: true };
  } catch (err) {
    if (isDuplicateContactEvent(err)) return { id: event.id, inserted: false };
    throw err;
  }
}

function isDuplicateContactEvent(err) {
  return err?.code?.startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed: contact_events\.id/i.test(err?.message || '');
}

function contactEventId(direction, eventId, msg) {
  return `agentmail_${direction}_${safeId(eventId || msg.messageId || stableHash(msg))}`;
}

function safeId(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'unknown';
}

function stableHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function formatAgentMailHistory(history = []) {
  return history.map((event) => {
    const body = String(event.body || '').replace(/\s+/g, ' ').slice(0, 280);
    return `${event.direction || 'unknown'} ${event.type || 'message'}: ${body}`;
  }).join('\n');
}

async function writeMailMemory(leadId, direction, msg, metadata = {}) {
  try {
    await addDoc(containerTagFor(leadId), 'mail_thread', {
      direction,
      threadId: msg.threadId,
      messageId: msg.messageId,
      subject: msg.subject,
      body: msg.text,
      at: new Date().toISOString()
    }, metadata);
  } catch (err) {
    log.warn('agentmail.memory.add_failed', { leadId, direction, error: err?.message || String(err) });
  }
}

function stripRe(subject = '') {
  return String(subject || '').replace(/^re:\s*/i, '') || 'callmemaybe';
}

function isSelfAgentMailAddress(email) {
  const self = `${env.agentmail.displayName || 'callmemaybe'}@agentmail.to`.toLowerCase();
  return String(email || '').toLowerCase() === self;
}

function htmlParagraphs(text) {
  return `<p>${escapeHtml(text).replace(/\n+/g, '</p><p>')}</p>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
