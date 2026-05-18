import { createHash, randomBytes } from 'node:crypto';
import { emit } from '../sse.js';
import { runs, leads, contactEvents, builds, scheduledCalls as scheduledCallsDb } from '../db.js';
import { canEmail, env } from '../env.js';
import { log } from '../logger.js';
import { addDoc, containerTagFor, getLatest } from '../memory.js';
import { generateText } from '../gemini.js';
import { generateStructured } from '../reasoning/geminiReasoner.js';
import { PreviewRecap, PreviewRecapCritique } from '../reasoning/schemas.js';
import { agentMailWebhookEventId, isInboundAgentMailWebhook, normalizeAgentMailWebhook } from '../webhooks/agentmail.js';
import { classifyInvoiceAffirmation, decideEmailReply, handleScheduleIntent } from './mailReply.js';
import { maybePlaceEmailCallback } from '../emailCallback.js';
import { runPreviewBuilder } from './builder.js';
import {
  createOrReuseRevenueInvoice,
  existingInvoiceEmailEvent,
  loadLatestPostMortemFromRuns,
  normalizeRevenueEmail,
  revenuePriceCentsForLead,
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

export function nextWeekdayTen(now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() + 1);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return { start, end };
}

export function buildIcs({ uid, summary, description, location, organizerEmail, attendeeEmail, start, end }) {
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

async function writeRecap({ businessName, profile, postMortem, leadId = null }) {
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
    const text = await generateText({
      prompt,
      flash: true,
      thinkingLevel: 'minimal',
      leadId,
      kind: 'mailer_recap'
    });
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

async function sendInvoiceAgentMail({ toEmail, subject, text, html, icsBase64, leadId = null }) {
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
    ],
    leadId,
    costKind: 'invoice_email'
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

    const recap = await writeRecap({ businessName, profile, postMortem, leadId });
    emit('mailer.invoice_link', {
      worker: 'mailer',
      leadId,
      runId,
      invoiceUrl,
      paymentLinkUrl: invoiceUrl,
      invoicePdfUrl: invoice.invoicePdfUrl,
      invoiceStatus: invoice.status,
      amount: payment?.amount_cents || revenuePriceCentsForLead(lead),
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
        icsBase64,
        leadId
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

  // "Call me" intent → fire an outbound callback right now. Runs BEFORE the lead
  // / classification machinery so it works for non-lead senders (the operator
  // emailing in to test, a curious prospect with no lead row, etc.). If a
  // callback is placed, we short-circuit the rest of the inbound flow — the
  // phone is ringing within seconds, no email reply needed.
  const callback = await maybePlaceEmailCallback({ msg, eventId }).catch((err) => {
    log.warn('email_callback.handler_threw', { error: err?.message || String(err), eventId });
    return null;
  });
  if (callback?.fired) {
    return { ignored: false, eventId, msg, callbackPlaced: true, toPhone: callback.toPhone, callId: callback.callId };
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

  // Affirmative invoice reply → kick off the preview build and email a live Browser Use link.
  // Gates on outreach_status='awaiting_payment' and !preview_build_triggered_at, so a generic
  // "yes" on an unrelated thread can't trigger this. We intentionally do NOT gate on
  // classification.operatorFlag here — the broader email-reply classifier sometimes labels
  // affirmative invoice replies as "growth interested" handoffs (false positive). The
  // affirmation classifier has its own opt-out / lead-state / Gemini-confidence gates.
  let previewKickoff = null;
  if (
    leadId &&
    lead &&
    classification.kind !== 'opt_out' &&
    !deliveryRisk.flagged
  ) {
    const affirm = await classifyInvoiceAffirmation({
      lead,
      subject: msg.subject,
      text: msg.text || msg.preview || '',
      eventId
    });
    if (affirm.affirmative) {
      previewKickoff = startPreviewBuildKickoff({
        leadId,
        msg,
        affirm
      });
      // Short LARP ack so the customer sees an immediate response while the build spins up.
      // The follow-up email with the live link gets sent from the onLiveUrl callback.
      classification.replyText = "Locked in — kicking off the build now. You'll get the live link in a moment so you can watch it come together.";
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

  // Scheduling intent — when classification scope is 'scheduling' OR the lead already
  // has a pending scheduled callback (so cancel/reschedule replies catch the right
  // branch regardless of how Gemini labeled the scope), run the schedule classifier,
  // validate the time, promote consent, persist a row, and rewrite
  // classification.replyText so the existing draftAgentMailReply path delivers the
  // confirmation/decline reply.
  let scheduleOutcome = null;
  const bodyText = msg.text || msg.preview || '';
  const hasPendingSchedule = !!(leadId && scheduledCallsDb.findPendingForLead(leadId));
  const looksLikeCancel = /\b(cancel|abort|never\s*mind|nevermind|forget it)\b/i.test(bodyText);
  // Unambiguous cancels on a pending schedule bypass the operatorFlag gate — the
  // classifier sometimes flags vague replies for handoff, but "cancel" against an
  // active schedule is safe to handle deterministically.
  const unambiguousCancel = looksLikeCancel && hasPendingSchedule;
  const shouldRouteToSchedule =
    leadId && lead &&
    classification?.kind !== 'opt_out' &&
    (unambiguousCancel || (
      !classification?.operatorFlag &&
      (classification?.scope === 'scheduling' || hasPendingSchedule || looksLikeCancel)
    ));
  if (shouldRouteToSchedule) {
    try {
      scheduleOutcome = await handleScheduleIntent({
        lead,
        leadId,
        msg,
        bodyText,
        classification
      });
    } catch (err) {
      log.warn('agentmail.schedule.handler_failed', {
        leadId, threadId: msg.threadId, error: err?.message || String(err)
      });
    }
  }

  const replyText = await draftAgentMailReply({ lead, msg, classification, history });
  const sendResult = await sendAgentMailAutoReply({ msg, text: replyText, eventId, leadId });
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
    mock: sendResult.mock,
    schedule: scheduleOutcome ? {
      action: scheduleOutcome.action,
      scheduledCallId: scheduleOutcome.scheduledCallId || null,
      scheduledAtMs: scheduleOutcome.scheduledAtMs || null,
      reason: scheduleOutcome.reason || null
    } : null,
    previewKickoff: previewKickoff ? {
      triggeredAt: previewKickoff.triggeredAt,
      source: previewKickoff.source,
      pattern: previewKickoff.pattern,
      confidence: previewKickoff.confidence
    } : null
  });

  return {
    ignored: false,
    eventId,
    leadId,
    inboundContactEventId: inboundEvent.id,
    outboundContactEventId: outboundEvent.id,
    replyText,
    classification,
    sendResult,
    previewKickoff
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

async function sendAgentMailAutoReply({ msg, text, eventId, leadId = null }) {
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
    html: htmlParagraphs(text),
    leadId,
    costKind: 'auto_reply'
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

const PREVIEW_RECAP_SPECIFICITY_THRESHOLD = 0.7;
const PREVIEW_RECAP_FILLER_PHRASES = [
  'unique vibe',
  'translates perfectly',
  'comes together',
  'come together',
  'make booking a breeze',
  'breeze for your',
  'the energy of',
  'stoked to',
  'feeling authentic',
  'we got you',
  'cant wait',
  "can't wait"
];

function detectFillerPhrases(text) {
  const haystack = String(text || '').toLowerCase();
  return PREVIEW_RECAP_FILLER_PHRASES.filter((p) => haystack.includes(p));
}

function citationOverlap(body, citations) {
  if (!Array.isArray(citations) || citations.length === 0) return 0;
  const haystack = String(body || '').toLowerCase();
  let hit = 0;
  for (const c of citations) {
    const fact = String(c?.fact || '').toLowerCase().trim();
    if (!fact) continue;
    // Tokenize the fact: at least 60% of its non-stopword tokens should appear in the body.
    const tokens = fact.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    if (!tokens.length) {
      if (haystack.includes(fact)) hit++;
      continue;
    }
    const present = tokens.filter((t) => haystack.includes(t)).length;
    if (present / tokens.length >= 0.6) hit++;
  }
  return hit / citations.length;
}

function summarizeWebsiteBriefForPrompt(websiteBrief) {
  if (!websiteBrief || typeof websiteBrief !== 'object') return null;
  return {
    businessName: websiteBrief.businessName,
    targetCustomer: websiteBrief.targetCustomer,
    sections: Array.isArray(websiteBrief.sections)
      ? websiteBrief.sections.slice(0, 6).map((s) => ({
          name: s.name,
          goal: s.goal,
          content: Array.isArray(s.content) ? s.content.slice(0, 3) : []
        }))
      : [],
    style: websiteBrief.style || null,
    factualClaims: Array.isArray(websiteBrief.factualClaims) ? websiteBrief.factualClaims.slice(0, 6) : [],
    customerQuestions: Array.isArray(websiteBrief.customerQuestions) ? websiteBrief.customerQuestions.slice(0, 4) : []
  };
}

function summarizePostMortemForPrompt(postMortem) {
  if (!postMortem || typeof postMortem !== 'object') return null;
  return {
    replayWorthy: postMortem.replayWorthy || postMortem.summary || null,
    replayMoments: Array.isArray(postMortem.replayMoments)
      ? postMortem.replayMoments.slice(0, 4).map((m) => ({ excerpt: m.excerpt, why: m.why }))
      : [],
    customerQuestions: Array.isArray(postMortem.customerQuestions) ? postMortem.customerQuestions.slice(0, 4) : [],
    whatWorked: Array.isArray(postMortem.whatWorked) ? postMortem.whatWorked.slice(0, 3) : [],
    nextBestAction: postMortem.nextBestAction || null
  };
}

function summarizeProfileForPrompt(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    businessName: profile.businessName || profile.business_name,
    whatTheyDo: profile.whatTheyDo || profile.what_they_do,
    services: profile.services || profile.serviceList || [],
    hours: profile.hours || profile.businessHours || null,
    uniqueSellingPoints: profile.uniqueSellingPoints || profile.usps || []
  };
}

function previewRecapFallback(businessName, websiteBrief, postMortem) {
  const sectionName = websiteBrief?.sections?.[0]?.name;
  const replay = postMortem?.replayWorthy ? ` You mentioned: "${String(postMortem.replayWorthy).slice(0, 140)}".` : '';
  const sectionLine = sectionName ? ` We're starting with the ${sectionName.toLowerCase()} section right now.` : '';
  return `Locked in — we just kicked off the build for ${businessName}.${sectionLine}${replay} You can watch the session happen live in your browser; we'll send the final link the moment it's ready.`;
}

async function critiquePreviewRecap({ leadId, draft, citations, contextSummary }) {
  if (!env.gemini.apiKey) return null;
  const evidence = { draft, citations, context: contextSummary };
  const prompt = [
    `Critique an email paragraph that's about to be sent to a small-business owner whose website build is starting right now.`,
    `Score specificity 0–1. 0 = pure boilerplate. 1 = handcrafted, references at least two concrete facts from the supplied context (service names, hours, customer quotes, specific brief sections, customer's own questions).`,
    `Penalize: vague adjectives ("unique vibe", "translates", "energy of"), filler verbs ("comes together"), generic promises ("make booking a breeze").`,
    `Reward: proper nouns from the context, verbatim short quotes (≤8 words) from customerQuestions or replayMoments, brief section names referenced by name.`,
    `If score < ${PREVIEW_RECAP_SPECIFICITY_THRESHOLD}, write a rewrite that:`,
    `- Stays 50-100 words`,
    `- Cites ≥2 specific facts from the context (preferring customer quotes and brief section names)`,
    `- Keeps the warm "teammate texting an update" tone`,
    `- Does NOT include a greeting line, signature, or the live URL.`,
    `If score ≥ ${PREVIEW_RECAP_SPECIFICITY_THRESHOLD}, rewrite must be null.`
  ].join('\n');
  try {
    const { output } = await generateStructured({
      kind: 'previewRecapCritique',
      schema: PreviewRecapCritique,
      evidence,
      prompt,
      leadId: leadId || null,
      worker: 'mailer',
      eventId: leadId ? `preview_recap_critique:${leadId}` : null,
      thinkingLevel: 'minimal',
      flash: true
    });
    return output;
  } catch (err) {
    log.warn('mailer.preview_recap_critique_failed', { leadId, err: err?.message || String(err) });
    return null;
  }
}

export async function writePreviewRecap({ leadId = null, businessName, profile, postMortem, websiteBrief }) {
  const fallback = previewRecapFallback(businessName, websiteBrief, postMortem);
  if (!env.gemini.apiKey) return { body: fallback, source: 'fallback', specificity: null };

  const briefSummary = summarizeWebsiteBriefForPrompt(websiteBrief);
  const postMortemSummary = summarizePostMortemForPrompt(postMortem);
  const profileSummary = summarizeProfileForPrompt(profile);
  const hasAnyContext = !!(briefSummary || postMortemSummary || profileSummary);
  if (!hasAnyContext) return { body: fallback, source: 'fallback_no_context', specificity: null };

  const evidence = {
    businessName,
    profile: profileSummary,
    postMortem: postMortemSummary,
    websiteBrief: briefSummary
  };
  const prompt = [
    `Write a 50-100 word email paragraph telling ${businessName} we just kicked off the build for their website and they can watch the live Browser Use session.`,
    `Tone: a teammate texting a quick update. Warm, confident, NOT a marketing pitch.`,
    `HARD RULE: cite at least TWO concrete facts from the supplied data. Each cited fact must appear in the body (verbatim or near-verbatim). Citations must reference: customer quotes from replayMoments / customerQuestions, brief section names being built right now, or specific services/USPs from the profile.`,
    `FORBIDDEN: vague adjectives ("unique vibe", "translates perfectly", "comes together", "make booking a breeze", "stoked", "the energy of"). Replace them with the concrete facts above.`,
    `FORBIDDEN: greeting line, signature, the live URL, markdown, bullet lists, promises the customer did not ask for.`,
    `If you have <2 concrete facts to cite, output body="${fallback.replace(/"/g, "'")}" and citations=[{source:"lead",fact:"insufficient_data"},{source:"lead",fact:"insufficient_data"}] and confidence<0.4.`
  ].join('\n');

  let firstPass;
  try {
    const { output } = await generateStructured({
      kind: 'previewRecap',
      schema: PreviewRecap,
      evidence,
      prompt,
      leadId: leadId || null,
      worker: 'mailer',
      eventId: leadId ? `preview_recap:${leadId}` : null,
      thinkingLevel: 'minimal',
      flash: true
    });
    firstPass = output;
  } catch (err) {
    log.warn('mailer.preview_recap_first_pass_failed', { leadId, err: err?.message || String(err) });
    return { body: fallback, source: 'fallback_first_pass_failed', specificity: null };
  }

  const fillerHits = detectFillerPhrases(firstPass.body);
  const overlap = citationOverlap(firstPass.body, firstPass.citations);
  const needsRewrite = fillerHits.length > 0 || overlap < 0.5 || (firstPass.confidence || 0) < 0.6;

  if (!needsRewrite) {
    return {
      body: firstPass.body.trim(),
      source: 'first_pass',
      specificity: firstPass.confidence,
      citations: firstPass.citations,
      fillerHits,
      citationOverlap: overlap
    };
  }

  const critique = await critiquePreviewRecap({
    leadId,
    draft: firstPass.body,
    citations: firstPass.citations,
    contextSummary: evidence
  });
  if (!critique) {
    return {
      body: firstPass.body.trim(),
      source: 'first_pass_no_critique',
      specificity: firstPass.confidence,
      citations: firstPass.citations,
      fillerHits,
      citationOverlap: overlap
    };
  }
  if (critique.specificity >= PREVIEW_RECAP_SPECIFICITY_THRESHOLD || !critique.rewrite) {
    return {
      body: firstPass.body.trim(),
      source: 'first_pass_passed_critique',
      specificity: critique.specificity,
      citations: firstPass.citations,
      fillerHits,
      citationOverlap: overlap,
      critique: critique.critique
    };
  }
  const rewriteFiller = detectFillerPhrases(critique.rewrite);
  return {
    body: critique.rewrite.trim(),
    source: 'rewrite',
    specificity: critique.specificity,
    citations: firstPass.citations,
    fillerHits: rewriteFiller,
    citationOverlap: overlap,
    critique: critique.critique
  };
}

async function loadPreviewRecapContext(leadId, buildId = null) {
  const out = { profile: null, postMortem: null, websiteBrief: null };
  if (!leadId) return out;
  try {
    const tag = containerTagFor(leadId);
    const [profileDoc, postMortemDoc] = await Promise.all([
      getLatest(tag, 'profile').catch(() => null),
      getLatest(tag, 'post_mortem').catch(() => null)
    ]);
    out.profile = readDoc(profileDoc) || null;
    out.postMortem = readDoc(postMortemDoc) || null;
  } catch (err) {
    log.warn('mailer.preview_recap_context_failed', { leadId, err: err?.message || String(err) });
  }
  if (buildId) {
    try {
      const buildRow = builds.get(buildId);
      if (buildRow?.website_brief_json) {
        out.websiteBrief = safeJson(buildRow.website_brief_json);
      }
    } catch (err) {
      log.warn('mailer.preview_recap_brief_load_failed', { leadId, buildId, err: err?.message || String(err) });
    }
  }
  return out;
}

function absolutizeLiveUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(env.publicUrl || 'http://localhost:8787').replace(/\/+$/, '');
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

function previewScreenshotUrl(buildId) {
  const base = String(env.publicUrl || 'http://localhost:8787').replace(/\/+$/, '');
  return `${base}/api/preview-build/${encodeURIComponent(buildId)}/screenshot.png`;
}

function previewBuildThumbnailSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 630"><rect width="1120" height="630" fill="#0a0a0a"/><rect x="32" y="32" width="1056" height="566" rx="14" fill="#161616" stroke="#2a2a2a"/><circle cx="68" cy="68" r="6" fill="#ff5f56"/><circle cx="92" cy="68" r="6" fill="#ffbd2e"/><circle cx="116" cy="68" r="6" fill="#27c93f"/><rect x="160" y="58" width="880" height="22" rx="6" fill="#222"/><text x="180" y="74" font-family="-apple-system,Segoe UI,sans-serif" font-size="13" fill="#888">lovable.dev/your-site — building now</text><rect x="80" y="120" width="960" height="430" rx="10" fill="#0f0f0f" stroke="#222"/><circle cx="130" cy="180" r="10" fill="#e74c3c"/><text x="155" y="186" font-family="-apple-system,Segoe UI,sans-serif" font-size="16" fill="#e74c3c" font-weight="700">LIVE</text><text x="120" y="290" font-family="-apple-system,Segoe UI,sans-serif" font-size="40" fill="#fafafa" font-weight="700">Your site is being built</text><text x="120" y="340" font-family="-apple-system,Segoe UI,sans-serif" font-size="20" fill="#aaa">Tap to watch the live session in your browser →</text></svg>`;
}

function previewBuildEmailHtml({ businessName, liveUrl, recap, thumbnailUrl }) {
  const href = escapeHtml(liveUrl);
  const safeName = escapeHtml(businessName);
  const safeRecap = escapeHtml(recap || '').replace(/\n+/g, '</p><p>');
  const thumbSrc = thumbnailUrl
    ? escapeHtml(thumbnailUrl)
    : `data:image/svg+xml;utf8,${encodeURIComponent(previewBuildThumbnailSvg())}`;
  return [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#111;line-height:1.55;font-size:15px;max-width:560px;">`,
    `<p>Hey ${safeName},</p>`,
    `<p style="padding:10px 14px;background:#E8F5E9;border-left:3px solid #2E7D32;border-radius:4px;font-size:14px;margin:0 0 16px;"><strong>Payment received — $500.</strong> Your build is kicking off right now.</p>`,
    `<p>${safeRecap}</p>`,
    `<p style="text-align:center;margin:24px 0;">`,
    `<a href="${href}" style="text-decoration:none;">`,
    `<img src="${thumbSrc}" alt="Watch the build live" width="560" style="display:block;max-width:100%;border-radius:12px;border:1px solid #e5e5e5;" />`,
    `</a>`,
    `</p>`,
    `<p style="text-align:center;margin:24px 0;">`,
    `<a href="${href}" style="display:inline-block;background:#111;color:#fff;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Watch the build live</a>`,
    `</p>`,
    `<p style="font-size:13px;color:#666;">If the button doesn't open, paste this into your browser: <a href="${href}" style="color:#666;">${href}</a></p>`,
    `<p>Reply here any time if you want tweaks while it's running.</p>`,
    `<p>— the team at callmemaybe</p>`,
    `</div>`
  ].join('');
}

function previewBuildEmailText({ businessName, liveUrl, recap }) {
  return [
    `Hey ${businessName},`,
    '',
    `Payment received — $500. Your build is kicking off right now.`,
    '',
    recap,
    '',
    `Watch the build live: ${liveUrl}`,
    '',
    `Reply here any time if you want tweaks while it's running.`,
    '',
    `— the team at callmemaybe`
  ].join('\n');
}

function startPreviewBuildKickoff({ leadId, msg, affirm }) {
  const triggeredAt = Date.now();
  leads.update(leadId, {
    preview_build_triggered_at: triggeredAt,
    next_action: 'preview_build_running'
  });
  const kickoff = { triggeredAt, source: affirm.source, pattern: affirm.pattern || null, confidence: affirm.confidence };
  emit('mailer.preview_kickoff', {
    worker: 'mailer',
    leadId,
    threadId: msg.threadId,
    messageId: msg.messageId,
    source: affirm.source,
    pattern: affirm.pattern || null,
    confidence: affirm.confidence,
    excerpt: affirm.excerpt || null
  });

  const replyMessageId = msg.messageId;
  const fromEmail = msg.fromEmail;
  const businessNameInput = leads.get(leadId)?.business_name;

  // Fire-and-forget — the webhook handler returns immediately while the build runs in the background.
  Promise.resolve()
    .then(() => runPreviewBuilder({
      leadId,
      onLiveUrl: (liveUrl, ctx) => sendPreviewBuildEmail({
        leadId,
        liveUrl,
        inReplyToMessageId: replyMessageId,
        threadId: msg.threadId,
        toEmail: fromEmail,
        businessName: businessNameInput,
        buildId: ctx?.buildId || null,
        sessionId: ctx?.sessionId || null,
        mock: !!ctx?.mock
      })
    }))
    .catch((err) => {
      log.warn('mailer.preview_builder_failed', {
        leadId,
        err: err?.message || String(err)
      });
      // Roll back the trigger stamp so a future affirmative can retry.
      try { leads.update(leadId, { preview_build_triggered_at: null, next_action: 'await_payment' }); }
      catch (rollbackErr) { log.warn('mailer.preview_rollback_failed', { leadId, err: rollbackErr?.message }); }
    });

  return kickoff;
}

export async function sendPreviewBuildEmail({
  leadId,
  liveUrl,
  inReplyToMessageId,
  threadId,
  toEmail,
  businessName: businessNameInput,
  buildId = null,
  sessionId = null,
  mock = false
} = {}) {
  if (!leadId || !liveUrl || !toEmail) {
    log.warn('mailer.preview_email.missing_inputs', {
      hasLeadId: !!leadId,
      hasLiveUrl: !!liveUrl,
      hasToEmail: !!toEmail
    });
    return { ok: false, reason: 'missing_inputs' };
  }

  const lead = leads.get(leadId);
  if (!lead) return { ok: false, reason: 'lead_not_found' };
  if (lead.preview_build_email_sent_at) return { ok: false, reason: 'already_sent' };
  if (lead.risk_status === 'email-opt-out') return { ok: false, reason: 'opted_out' };

  const businessName = businessNameInput || lead.business_name || 'there';
  const absoluteLiveUrl = absolutizeLiveUrl(liveUrl);
  const { profile, postMortem, websiteBrief } = await loadPreviewRecapContext(leadId, buildId);
  const recap = await writePreviewRecap({ leadId, businessName, profile, postMortem, websiteBrief });
  const thumbnailUrl = buildId ? previewScreenshotUrl(buildId) : null;
  const subject = `Payment received — watch your ${businessName === 'there' ? 'site' : businessName + ' site'} come together live`;
  const text = previewBuildEmailText({ businessName, liveUrl: absoluteLiveUrl, recap: recap.body });
  const html = previewBuildEmailHtml({ businessName, liveUrl: absoluteLiveUrl, recap: recap.body, thumbnailUrl });

  let sendResult;
  if (!inReplyToMessageId || shouldMockEmail(toEmail)) {
    sendResult = createMockAgentMailSendResult({
      threadId: threadId || `mock-thread-${randomBytes(6).toString('hex')}`,
      messageId: `mock-preview-build-${randomBytes(6).toString('hex')}`,
      subject
    });
    log.info('mailer.preview_email_mock', { leadId, toMasked: maskEmail(toEmail) });
  } else {
    try {
      sendResult = await replyAgentMailMessage({
        inboxId: env.agentmail.inboxId,
        messageId: inReplyToMessageId,
        toEmail,
        subject,
        text,
        html,
        leadId,
        costKind: 'preview_build_email'
      }, { timeoutSeconds: 15, maxRetries: 2 });
    } catch (err) {
      log.warn('mailer.preview_email.send_failed', {
        leadId,
        err: err?.message || String(err)
      });
      return { ok: false, reason: 'send_failed', error: err?.message || String(err) };
    }
  }

  contactEvents.add({
    lead_id: leadId,
    type: 'preview_build_email',
    direction: 'outbound',
    channel: 'agentmail',
    provider_id: sendResult.providerId || null,
    thread_id: sendResult.threadId || threadId || null,
    subject,
    body: text,
    metadata: {
      liveUrl: absoluteLiveUrl,
      buildId,
      sessionId,
      mock: !!sendResult.mock || mock,
      messageId: sendResult.messageId,
      inReplyTo: inReplyToMessageId,
      toMasked: maskEmail(toEmail),
      recap: {
        source: recap.source,
        specificity: recap.specificity,
        citationOverlap: recap.citationOverlap || null,
        fillerHits: recap.fillerHits || [],
        citations: recap.citations || null,
        critique: recap.critique || null
      }
    }
  });

  leads.update(leadId, { preview_build_email_sent_at: Date.now() });
  emit('mailer.preview_build_sent', {
    worker: 'mailer',
    leadId,
    threadId: sendResult.threadId || threadId,
    liveUrl: absoluteLiveUrl,
    buildId,
    sessionId,
    mock: !!sendResult.mock || mock
  });

  return {
    ok: true,
    threadId: sendResult.threadId || threadId,
    messageId: sendResult.messageId,
    liveUrl: absoluteLiveUrl,
    mock: !!sendResult.mock || mock
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
