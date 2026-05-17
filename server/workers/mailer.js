import { randomBytes } from 'node:crypto';
import { emit } from '../sse.js';
import { runs, payments, leads } from '../db.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { containerTagFor, getLatest } from '../memory.js';
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

function shouldMockPayments() {
  return env.runMode !== 'live' || !env.live.payments || !env.stripe.secretKey;
}

function shouldMockEmail(toEmail) {
  if (env.runMode !== 'live') return true;
  if (!env.live.emails) return true;
  if (!env.agentmail.apiKey || !env.agentmail.inboxId) return true;
  if (!env.allowedEmails.includes(toEmail)) return true;
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
    `Once payment is in, the build kicks off and you can watch it happen live. There is also a 30-minute follow-up on the calendar so we can lock in the details.`,
    '',
    `Talk soon,`,
    `the team at callmemaybe`
  ].join('\n');
}

async function createStripeLink({ leadId, businessName }) {
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(env.stripe.secretKey, { apiVersion: '2024-12-18.acacia' });
  const product = await stripe.products.create({
    name: `${env.stripe.productName} for ${businessName}`
  });
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: env.stripe.priceCents,
    currency: 'usd'
  });
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    after_completion: { type: 'redirect', redirect: { url: env.stripe.successUrl } },
    metadata: { leadId }
  });
  return link.url;
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

    let paymentLinkUrl;
    if (shouldMockPayments()) {
      paymentLinkUrl = `https://buy.stripe.com/test_demo/${leadId}`;
      log.info('mailer.payment_mock', { leadId });
    } else {
      paymentLinkUrl = await createStripeLink({ leadId, businessName });
    }

    payments.insert({
      id: `pay_${randomBytes(6).toString('hex')}`,
      lead_id: leadId,
      payment_link_url: paymentLinkUrl,
      amount_cents: env.stripe.priceCents,
      status: 'created'
    });
    emit('mailer.payment_link', {
      worker: 'mailer',
      leadId,
      runId,
      paymentLinkUrl,
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

    const subject = `Your website with callmemaybe — payment link + meeting invite`;
    const bodyText = [
      recap,
      '',
      `Pay here to kick off the build: ${paymentLinkUrl}`,
      `Follow-up meeting: ${meetingUrl} (calendar invite attached)`
    ].join('\n');
    const bodyHtml = `<p>${recap.replace(/\n+/g, '</p><p>')}</p><p><a href="${paymentLinkUrl}">Pay here to kick off the build</a></p><p>Follow-up meeting: <a href="${meetingUrl}">${meetingUrl}</a> (calendar invite attached)</p>`;

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

    emit('mailer.email_sent', {
      worker: 'mailer',
      leadId,
      runId,
      threadId,
      subject,
      toMasked: maskEmail(toEmail),
      mock
    });

    leads.update(leadId, { status: 'awaiting_payment' });

    const detail = { paymentLinkUrl, threadId, mockEmail: mock, mockPayment: shouldMockPayments() };
    runs.finish(runId, { state: 'completed', detail });
    emit('mailer.done', { worker: 'mailer', leadId, runId, paymentLinkUrl, threadId });

    return { paymentLinkUrl, threadId };
  } catch (err) {
    runs.finish(runId, { state: 'failed', error: err.message });
    emit('mailer.error', { worker: 'mailer', leadId, runId, error: err.message });
    log.error('mailer.failed', { leadId, runId, err: err.message });
    throw err;
  }
}
