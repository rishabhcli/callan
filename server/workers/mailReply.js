import { emit } from '../sse.js';
import { contactEvents, leads } from '../db.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { addDoc, containerTagFor } from '../memory.js';
import { generateText } from '../gemini.js';

const SUPPORTED_SCOPE = [
  'invoice questions',
  'scheduling',
  'website brief and customer needs',
  'website revisions',
  'pricing',
  'build progress',
  'opt-out or unsubscribe'
].join(', ');

const HANDOFF_RE = /\b(legal|lawyer|attorney|lawsuit|contract|custom contract|nda|indemnity|liability|tax advice|licensed professional|guarantee ranking|guarantee revenue)\b/i;
const OPT_OUT_RE = /\b(unsubscribe|stop emailing|stop contacting|do not email|remove me|opt out)\b/i;

export function normalizeAgentMailPayload(body = {}) {
  const message = body.message || body.data?.message || body.data || {};
  const from = body.from || message.from || {};
  const to = body.to || message.to || {};
  const text = body.text || body.body || body.preview || message.text || message.body || message.plain || message.snippet || '';
  return {
    eventId: body.id || body.event_id || body.eventId || message.eventId || message.id || body['svix-id'] || null,
    eventType: body.event || body.type || message.event || message.type || null,
    messageId: body.messageId || body.message_id || message.messageId || message.message_id || message.id || null,
    threadId: body.threadId || body.thread_id || message.threadId || message.thread_id || null,
    inboxId: body.inboxId || body.inbox_id || message.inboxId || message.inbox_id || env.agentmail.inboxId,
    fromEmail: emailOf(from) || emailOf(message.from_email) || emailOf(body.from_email),
    toEmail: emailOf(to) || emailOf(message.to_email) || emailOf(body.to_email),
    subject: body.subject || message.subject || '(no subject)',
    text: typeof text === 'string' ? text : safeString(text),
    direction: String(body.direction || message.direction || '').toLowerCase()
  };
}

export function isInboundAgentMailPayload(body = {}) {
  const msg = normalizeAgentMailPayload(body);
  const type = String(msg.eventType || '').toLowerCase();
  return msg.direction === 'inbound' || type.includes('inbound') || type.includes('received') || type === 'message.received';
}

export async function handleAgentMailInbound(body = {}) {
  const msg = normalizeAgentMailPayload(body);
  if (!isInboundAgentMailPayload(body)) return { ignored: true, reason: 'not inbound', msg };

  const lead = msg.threadId ? contactEvents.findLeadByThread(msg.threadId) : null;
  const leadId = lead?.id || body.leadId || body.lead_id || null;
  const bodyText = msg.text || '';
  const classification = classifyMessage(bodyText);

  contactEvents.add({
    lead_id: leadId,
    type: 'customer_reply',
    direction: 'inbound',
    channel: 'agentmail',
    provider_id: msg.messageId,
    thread_id: msg.threadId,
    subject: msg.subject,
    body: bodyText,
    metadata: { fromMasked: maskEmail(msg.fromEmail), classification }
  });

  if (leadId) {
    await writeMailMemory(leadId, 'inbound', msg, { classification });
    if (classification.kind === 'opt_out') {
      leads.update(leadId, {
        risk_status: 'email-opt-out',
        next_action: 'do_not_email'
      });
    } else if (classification.kind === 'handoff') {
      leads.update(leadId, {
        risk_status: 'operator-handoff',
        next_action: 'operator_review_mail'
      });
    }
  }

  const replyText = await draftReply({ lead, msg, classification });
  const sendResult = await sendReply({ msg, text: replyText, classification });

  contactEvents.add({
    lead_id: leadId,
    type: classification.kind === 'handoff' ? 'handoff_reply' : 'agent_reply',
    direction: 'outbound',
    channel: 'agentmail',
    provider_id: sendResult.providerId,
    thread_id: sendResult.threadId || msg.threadId,
    subject: `Re: ${stripRe(msg.subject)}`,
    body: replyText,
    metadata: { mock: sendResult.mock, classification }
  });

  if (leadId) await writeMailMemory(leadId, 'outbound', { ...msg, text: replyText }, { classification, mock: sendResult.mock });

  emit('mailer.auto_reply', {
    worker: 'mailer',
    leadId,
    threadId: sendResult.threadId || msg.threadId,
    messageId: sendResult.providerId || msg.messageId,
    subject: msg.subject,
    classification: classification.kind,
    mock: sendResult.mock
  });

  return { ignored: false, leadId, replyText, classification, sendResult };
}

function classifyMessage(text) {
  if (OPT_OUT_RE.test(text || '')) return { kind: 'opt_out', reason: 'customer asked to stop email contact' };
  if (HANDOFF_RE.test(text || '')) return { kind: 'handoff', reason: 'unsupported legal/custom-contract request' };
  return { kind: 'service_scope', reason: 'inside autonomous reply scope' };
}

async function draftReply({ lead, msg, classification }) {
  if (classification.kind === 'opt_out') {
    return 'Understood. We will stop emailing this thread. Thanks for letting us know.';
  }
  if (classification.kind === 'handoff') {
    return 'Thanks for asking. That needs a human review on our side, so I am flagging the operator and will keep this thread paused until they take a look.';
  }

  try {
    if (!env.gemini.apiKey) throw new Error('GEMINI_API_KEY missing');
    const prompt = [
      `Business: ${lead?.business_name || 'unknown small business'}`,
      `Customer email subject: ${msg.subject}`,
      `Customer message:`,
      msg.text || '(empty)',
      '',
      `Reply as callmemaybe's autonomous AgentMail agent.`,
      `Stay strictly inside this service scope: ${SUPPORTED_SCOPE}.`,
      `Be brief, concrete, and useful. If they ask for anything outside scope, say a human will review it.`,
      `Do not make legal promises, SEO guarantees, custom contract commitments, or unsupported delivery claims.`
    ].join('\n');
    const text = await generateText({
      prompt,
      systemInstruction: 'You write concise customer-service email replies for a website agency. No markdown.',
      thinkingLevel: 'low',
      flash: true
    });
    if (text && text.trim().length > 15) return text.trim();
  } catch (err) {
    log.warn('agentmail.reply.gemini_fallback', { error: err?.message || String(err) });
  }

  return 'Thanks for the note. The invoice, scheduling, website brief, revisions, pricing, and build progress can all be handled right here in this thread. Send any details you want reflected on the site and I will keep the build moving.';
}

async function sendReply({ msg, text, classification }) {
  if (!canSend(msg.fromEmail)) {
    return {
      mock: true,
      providerId: `mock-agentmail-reply-${Date.now().toString(36)}`,
      threadId: msg.threadId
    };
  }

  const { AgentMailClient } = await import('agentmail');
  const mail = new AgentMailClient({ apiKey: env.agentmail.apiKey });
  const html = `<p>${escapeHtml(text).replace(/\n+/g, '</p><p>')}</p>`;
  let res;
  if (msg.messageId) {
    res = await mail.inboxes.messages.reply(msg.inboxId || env.agentmail.inboxId, msg.messageId, {
      text,
      html
    });
  } else {
    res = await mail.inboxes.messages.send(msg.inboxId || env.agentmail.inboxId, {
      to: [msg.fromEmail],
      subject: `Re: ${stripRe(msg.subject)}`,
      text,
      html
    });
  }
  const message = res?.message || res;
  return {
    mock: false,
    providerId: message?.id || message?.messageId || msg.messageId || null,
    threadId: message?.threadId || message?.thread_id || msg.threadId,
    classification: classification.kind
  };
}

function canSend(toEmail) {
  if (!['live', 'demo_live', 'autonomous_live'].includes(env.runMode)) return false;
  if (!env.live.emails || !env.agentmail.apiKey || !env.agentmail.inboxId) return false;
  if (env.runMode === 'demo_live' && !env.allowedEmails.includes(toEmail)) return false;
  return !!toEmail;
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

function emailOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.includes('@') ? value : null;
  if (Array.isArray(value)) return emailOf(value[0]);
  return value.email || value.address || null;
}

function stripRe(subject = '') {
  return String(subject || '').replace(/^re:\s*/i, '') || 'callmemaybe';
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return undefined;
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0] || '*'}***@***.${tld}`;
}

function safeString(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
