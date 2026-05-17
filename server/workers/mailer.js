import { createHash, randomBytes } from 'node:crypto';
import { emit } from '../sse.js';
import { runs, leads, contactEvents } from '../db.js';
import { canEmail, env } from '../env.js';
import { log } from '../logger.js';
import { addDoc, containerTagFor, getLatest } from '../memory.js';
import { generateText } from '../gemini.js';
import { agentMailWebhookEventId, isInboundAgentMailWebhook, normalizeAgentMailWebhook } from '../webhooks/agentmail.js';
import { decideEmailReply } from './mailReply.js';
import {
  createOrReuseRevenueInvoice,
  existingInvoiceEmailEvent,
  loadLatestPostMortemFromRuns,
  normalizeRevenueEmail,
  REVENUE_OFFER_VERSION
} from '../paymentFlow.js';
import {
  createMockAgentMailSendResult,
  getAgentMailMessage,
  normalizeAgentMailMessage,
  replyAgentMailMessage,
  sendAgentMailMessage
} from '../providers/agentmail.js';

export { runAgentMailLiveSendSmoke } from '../providers/agentmail.js';

const ICS_DT_FMT = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

function pad(n) {
  return String(n).padStart(2, '0');
}

function maskEmail(addr) {
  if (!addr || typeof addr !== 'string' || !addr.includes('@')) return '***';
  const [local, domain] = addr.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0]}***@***.${tld}`;
}

function shouldMockEmail(toEmail) {
  return !canEmail(toEmail) || !env.agentmail.apiKey || !env.agentmail.inboxId;
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
    const postMortem = readDoc(postMortemDoc) || loadLatestPostMortemFromRuns(leadId) || {};

    const businessName = lead.business_name || profile.businessName || 'your business';
    const invoiceEmail = normalizeRevenueEmail(toEmail || postMortem.invoiceEmail || profile.bestContactEmail);
    const invoiceResult = await createOrReuseRevenueInvoice({
      leadId,
      toEmail: invoiceEmail,
      postMortem,
      profile,
      offerVersion: REVENUE_OFFER_VERSION
    });

    if (invoiceResult.blocked) {
      const reason = invoiceResult.gate.blockers.map((b) => b.code).join(', ') || 'invoice_gate_blocked';
      const blockedEvent = addContactEventOnce({
        id: `invoice_blocked_${safeId(leadId)}_${safeId(invoiceResult.gate.idempotencyKey || reason)}`,
        lead_id: leadId,
        type: 'invoice_blocked',
        direction: 'internal',
        channel: 'revenue',
        provider_id: null,
        thread_id: lead.agentmail_thread_id || null,
        subject: 'Invoice gate blocked',
        body: invoiceResult.gate.blockers.map((b) => b.reason).join(' '),
        metadata: {
          allowed: false,
          decisionCode: 'invoice_gate.blocked',
          decisionReason: reason,
          gate: invoiceResult.gate
        }
      });
      leads.update(leadId, {
        next_action: 'invoice_gate_blocked',
        outreach_status: lead.outreach_status === 'awaiting_payment' ? lead.outreach_status : 'called'
      });
      emit('mailer.invoice_blocked', {
        worker: 'mailer',
        leadId,
        runId,
        contactEventId: blockedEvent.id,
        reason,
        blockers: invoiceResult.gate.blockers,
        gate: invoiceResult.gate
      });
      runs.finish(runId, { state: 'blocked', detail: { reason, gate: invoiceResult.gate } });
      return { blocked: true, reason, gate: invoiceResult.gate };
    }

    const payment = invoiceResult.payment;
    const invoice = invoiceResult.invoice;
    const invoiceUrl = invoice.hostedInvoiceUrl || invoice.url;
    const priorEmail = existingInvoiceEmailEvent({
      leadId,
      paymentId: payment?.id,
      idempotencyKey: payment?.idempotency_key
    });
    if (priorEmail?.thread_id) {
      leads.update(leadId, {
        status: 'awaiting_payment',
        agentmail_thread_id: priorEmail.thread_id,
        next_action: 'await_payment',
        outreach_status: 'awaiting_payment'
      });
      const detail = {
        invoiceUrl,
        paymentLinkUrl: invoiceUrl,
        invoicePdfUrl: invoice.invoicePdfUrl,
        invoiceStatus: invoice.status,
        stripeInvoiceId: invoice.id,
        paymentId: payment?.id,
        threadId: priorEmail.thread_id,
        idempotentEmail: true,
        gate: invoiceResult.gate
      };
      runs.finish(runId, { state: 'completed', detail });
      emit('mailer.email_sent', {
        worker: 'mailer',
        leadId,
        runId,
        threadId: priorEmail.thread_id,
        paymentId: payment?.id,
        idempotent: true,
        subject: priorEmail.subject,
        toMasked: maskEmail(invoiceEmail),
        mock: safeJson(priorEmail.metadata_json)?.mockEmail
      });
      emit('mailer.done', {
        worker: 'mailer',
        leadId,
        runId,
        invoiceUrl,
        paymentLinkUrl: invoiceUrl,
        threadId: priorEmail.thread_id,
        paymentId: payment?.id,
        idempotent: true
      });
      return { invoiceUrl, threadId: priorEmail.thread_id, paymentId: payment?.id, idempotent: true };
    }

    const recap = await writeRecap({ businessName, profile, postMortem });
    emit('mailer.invoice_link', {
      worker: 'mailer',
      leadId,
      runId,
      invoiceUrl,
      paymentLinkUrl: invoiceUrl,
      invoicePdfUrl: invoice.invoicePdfUrl,
      invoiceStatus: invoice.status,
      amount: payment?.amount_cents || env.stripe.priceCents,
      paymentId: payment?.id,
      stripeInvoiceId: invoice.id,
      mock: invoiceResult.mockInvoice,
      gate: invoiceResult.gate
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
      attendeeEmail: invoiceEmail || 'guest@example.com',
      start,
      end
    });
    const icsBase64 = Buffer.from(ics, 'utf8').toString('base64');

    const subject = `Your callmemaybe website invoice + meeting invite`;
    const bodyText = [
      recap,
      '',
      `Invoice: ${invoiceUrl}`,
      `Follow-up meeting: ${meetingUrl} (calendar invite attached)`,
      `Reply to this email anytime — the agent will use this AgentMail thread to answer questions and keep the build moving.`
    ].join('\n');
    const invoiceHref = escapeHtml(invoiceUrl);
    const meetingHref = escapeHtml(meetingUrl);
    const bodyHtml = [
      htmlParagraphs(recap),
      `<p><a href="${invoiceHref}">Open invoice</a></p>`,
      `<p>Follow-up meeting: <a href="${meetingHref}">${meetingHref}</a> (calendar invite attached)</p>`,
      '<p>Reply to this email anytime — the agent will use this AgentMail thread to answer questions and keep the build moving.</p>'
    ].join('');

    let sendResult;
    if (shouldMockEmail(invoiceEmail)) {
      sendResult = createMockAgentMailSendResult({
        threadId: `mock-thread-${randomBytes(6).toString('hex')}`,
        messageId: `mock-agentmail-message-${randomBytes(6).toString('hex')}`,
        subject
      });
      log.info('mailer.email_mock', { leadId, toMasked: maskEmail(invoiceEmail) });
    } else {
      sendResult = await sendInvoiceAgentMail({
        toEmail: invoiceEmail,
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
        toMasked: maskEmail(invoiceEmail),
        messageId: sendResult.messageId,
        paymentId: payment?.id,
        idempotencyKey: payment?.idempotency_key,
        offerVersion: payment?.offer_version || REVENUE_OFFER_VERSION,
        invoiceId: invoice.id,
        invoiceUrl,
        invoiceStatus: invoice.status,
        invoicePdfUrl: invoice.invoicePdfUrl || null,
        stripeCustomerId: invoice.customerId,
        stripeCustomerReused: invoice.customerReused,
        mockEmail: sendResult.mock,
        mockInvoice: invoiceResult.mockInvoice,
        confirmedEmailProof: invoiceResult.gate.evidence.email,
        invoiceConsentEventId: invoiceResult.gate.evidence.consentEvent?.id || null,
        decisionCode: 'agentmail.outbound.invoice_email',
        decisionReason: 'Invoice gate passed and hosted invoice URL was sent through AgentMail.'
      }
    });

    try {
      await addDoc(tag, 'mail_thread', {
        direction: 'outbound',
        threadId,
        messageId: sendResult.messageId,
        subject,
        body: bodyText,
        invoiceUrl,
        invoicePdfUrl: invoice.invoicePdfUrl || null,
        paymentId: payment?.id,
        at: new Date().toISOString()
      }, { kind: 'invoice_email', mockEmail: sendResult.mock, paymentId: payment?.id });
    } catch (err) {
      log.warn('mailer.memory.add_failed', { leadId, error: err?.message || String(err) });
    }

    emit('mailer.email_sent', {
      worker: 'mailer',
      leadId,
      runId,
      threadId,
      messageId: sendResult.messageId,
      paymentId: payment?.id,
      subject,
      toMasked: maskEmail(invoiceEmail),
      mock: sendResult.mock
    });

    leads.update(leadId, {
      status: 'awaiting_payment',
      agentmail_thread_id: threadId,
      next_action: 'await_payment',
      outreach_status: 'awaiting_payment'
    });

    const detail = {
      invoiceUrl,
      paymentLinkUrl: invoiceUrl,
      invoicePdfUrl: invoice.invoicePdfUrl || null,
      invoiceStatus: invoice.status,
      stripeInvoiceId: invoice.id,
      paymentId: payment?.id,
      threadId,
      messageId: sendResult.messageId,
      mockEmail: sendResult.mock,
      mockInvoice: invoiceResult.mockInvoice,
      gate: invoiceResult.gate
    };
    runs.finish(runId, { state: 'completed', detail });
    emit('mailer.done', { worker: 'mailer', leadId, runId, invoiceUrl, paymentLinkUrl: invoiceUrl, threadId, paymentId: payment?.id });

    return { invoiceUrl, threadId, messageId: sendResult.messageId, paymentId: payment?.id };
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
  const history = leadId ? recentAgentMailEvents(leadId) : [];
  const deliveryRisk = agentMailDeliveryRisk(msg);
  const classification = deliveryRisk.operatorFlag
    ? deliveryRiskClassification(deliveryRisk)
    : await classifyAgentMailReply({
        lead,
        msg,
        subject: msg.subject,
        text: msg.text,
        history,
        eventId
      });
  const inboundEvent = addContactEventOnce({
    id: contactEventId('in', eventId, msg),
    lead_id: leadId,
    type: deliveryRisk.flagged ? 'customer_reply_flagged' : 'customer_reply',
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
      deliveryRisk,
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
    } else if (classification.operatorFlag || deliveryRisk.operatorFlag) {
      leads.update(leadId, {
        risk_status: deliveryRisk.flagged ? `agentmail-${deliveryRisk.kind}` : 'operator-handoff',
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
    deliveryRisk,
    policy: classification,
    preview: (msg.text || msg.preview || '').slice(0, 240)
  });

  if (deliveryRisk.flagged) {
    return {
      ignored: false,
      flagged: true,
      autoReplied: false,
      eventId,
      leadId,
      inboundContactEventId: inboundEvent.id,
      classification,
      deliveryRisk,
      msg
    };
  }

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

function agentMailDeliveryRisk(msg = {}) {
  const type = String(msg.eventType || '').toLowerCase().replace(/_/g, '.');
  const labels = (msg.labels || []).map((label) => String(label).toLowerCase());
  const has = (needle) => type.includes(needle) || labels.includes(needle);
  if (has('spam')) {
    return {
      flagged: true,
      kind: 'spam',
      operatorFlag: true,
      reason: 'AgentMail classified this inbound message as spam.'
    };
  }
  if (has('blocked')) {
    return {
      flagged: true,
      kind: 'blocked',
      operatorFlag: true,
      reason: 'AgentMail matched this inbound message against a block list.'
    };
  }
  if (has('unauthenticated')) {
    return {
      flagged: true,
      kind: 'unauthenticated',
      operatorFlag: true,
      reason: 'AgentMail received this message without verifiable authentication headers.'
    };
  }
  return { flagged: false, kind: 'standard', operatorFlag: false, reason: null };
}

function deliveryRiskClassification(deliveryRisk) {
  return {
    schemaVersion: 1,
    kind: 'handoff',
    scope: deliveryRisk.kind,
    scopes: [deliveryRisk.kind],
    supported: false,
    operatorFlag: true,
    replyMode: 'safe_handoff',
    reason: deliveryRisk.reason,
    matches: { supported: [], unsupported: [deliveryRisk.kind] },
    supportedScopes: ['invoice', 'price', 'schedule', 'brief', 'revisions', 'build status', 'unsubscribe'],
    unsupportedScopes: ['legal', 'custom contract', 'refund threat', 'security issue', 'spam', 'blocked', 'unauthenticated']
  };
}

async function classifyAgentMailReply(input) {
  return decideEmailReply(input);
}

async function hydrateInboundAgentMailMessage(msg) {
  if (!shouldFetchAgentMailMessage(msg)) return msg;
  if (!env.agentmail.apiKey || !msg.inboxId || !msg.messageId) {
    return { ...msg, fetchSkipped: 'missing_agentmail_config_or_message_id' };
  }

  try {
    const fetched = await getAgentMailMessage({
      inboxId: msg.inboxId,
      messageId: msg.messageId
    }, { timeoutSeconds: 12, maxRetries: 2 });
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
  if (classification.replyText && classification.replyText.trim().length > 15) {
    return classification.replyText.trim();
  }
  if (classification.kind === 'opt_out') {
    return 'Understood. We will stop emailing this thread. Thanks for letting us know.';
  }
  if (classification.operatorFlag) {
    return 'Thanks for asking. I can only handle invoice questions, scheduling, website briefs, revisions, pricing, build progress, and opt-outs in this automated thread. I have flagged the operator and paused the automated handling so a human can review this safely.';
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

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
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
