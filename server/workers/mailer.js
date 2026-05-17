import { randomBytes } from 'node:crypto';
import { emit } from '../sse.js';
import { runs, payments, leads, contactEvents } from '../db.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { addDoc, containerTagFor, getLatest } from '../memory.js';
import { generateText } from '../gemini.js';

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
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(env.stripe.secretKey, { apiVersion: '2026-02-25.clover' });
  const customer = await stripe.customers.create({
    email: toEmail,
    name: businessName,
    metadata: { leadId }
  }, {
    idempotencyKey: `${idempotencyKey}:customer`
  });
  await stripe.invoiceItems.create({
    customer: customer.id,
    amount: env.stripe.priceCents,
    currency: 'usd',
    description: `${env.stripe.productName} for ${businessName}`,
    metadata: { leadId }
  }, {
    idempotencyKey: `${idempotencyKey}:item`
  });
  const invoice = await stripe.invoices.create({
    customer: customer.id,
    collection_method: 'send_invoice',
    days_until_due: 7,
    auto_advance: false,
    metadata: { leadId }
  }, {
    idempotencyKey: `${idempotencyKey}:invoice`
  });
  const finalized = await stripe.invoices.finalizeInvoice(invoice.id, {}, {
    idempotencyKey: `${idempotencyKey}:finalize`
  });
  return {
    id: finalized.id,
    customerId: customer.id,
    url: finalized.hosted_invoice_url || finalized.invoice_pdf,
    dueAt: finalized.due_date ? finalized.due_date * 1000 : null
  };
}

async function sendAgentMail({ toEmail, subject, text, html, icsBase64 }) {
  const { AgentMailClient } = await import('agentmail');
  const mail = new AgentMailClient({ apiKey: env.agentmail.apiKey });
  const res = await mail.inboxes.messages.send(env.agentmail.inboxId, {
    to: [toEmail],
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
  });
  const message = res?.message || res;
  return message?.threadId || message?.thread_id || message?.id || `am-${Date.now().toString(36)}`;
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
    }

    if (!existingPayment) {
      payments.insert({
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
    const bodyHtml = `<p>${recap.replace(/\n+/g, '</p><p>')}</p><p><a href="${invoice.url}">Open invoice</a></p><p>Follow-up meeting: <a href="${meetingUrl}">${meetingUrl}</a> (calendar invite attached)</p><p>Reply to this email anytime — the agent will use this AgentMail thread to answer questions and keep the build moving.</p>`;

    let threadId;
    let mock = false;
    if (shouldMockEmail(toEmail)) {
      mock = true;
      threadId = `mock-thread-${randomBytes(6).toString('hex')}`;
      log.info('mailer.email_mock', { leadId, toMasked: maskEmail(toEmail) });
    } else {
      threadId = await sendAgentMail({
        toEmail,
        subject,
        text: bodyText,
        html: bodyHtml,
        icsBase64
      });
    }

    contactEvents.add({
      lead_id: leadId,
      type: 'invoice_email',
      direction: 'outbound',
      channel: 'agentmail',
      provider_id: threadId,
      thread_id: threadId,
      subject,
      body: bodyText,
      metadata: {
        toMasked: maskEmail(toEmail),
        invoiceId: invoice.id,
        invoiceUrl: invoice.url,
        mockEmail: mock,
        mockInvoice: shouldMockInvoices()
      }
    });

    try {
      await addDoc(tag, 'mail_thread', {
        direction: 'outbound',
        threadId,
        subject,
        body: bodyText,
        invoiceUrl: invoice.url,
        at: new Date().toISOString()
      }, { kind: 'invoice_email', mockEmail: mock });
    } catch (err) {
      log.warn('mailer.memory.add_failed', { leadId, error: err?.message || String(err) });
    }

    emit('mailer.email_sent', {
      worker: 'mailer',
      leadId,
      runId,
      threadId,
      subject,
      toMasked: maskEmail(toEmail),
      mock
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
      mockEmail: mock,
      mockInvoice: shouldMockInvoices()
    };
    runs.finish(runId, { state: 'completed', detail });
    emit('mailer.done', { worker: 'mailer', leadId, runId, invoiceUrl: invoice.url, paymentLinkUrl: invoice.url, threadId });

    return { invoiceUrl: invoice.url, threadId };
  } catch (err) {
    runs.finish(runId, { state: 'failed', error: err.message });
    emit('mailer.error', { worker: 'mailer', leadId, runId, error: err.message });
    log.error('mailer.failed', { leadId, runId, err: err.message });
    throw err;
  }
}
