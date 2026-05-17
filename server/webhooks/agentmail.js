import { createHash } from 'node:crypto';
import { Webhook } from 'svix';
import { env } from '../env.js';
import { log } from '../logger.js';

const DEFAULT_INBOX_ID = env.agentmail.inboxId || process.env.AGENTMAIL_INBOX_ID || '';

export function verifyAgentMail(req, rawBody) {
  const secret = env.agentmail.webhookSecret || process.env.AGENTMAIL_WEBHOOK_SECRET || '';
  if (!secret) {
    log.warn('AGENTMAIL_WEBHOOK_SECRET not set; accepting (dev only)');
    return { ok: true, dev: true };
  }
  try {
    const wh = new Webhook(secret);
    const headers = {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature']
    };
    if (!headers['svix-id'] || !headers['svix-timestamp'] || !headers['svix-signature']) {
      return { ok: false, reason: 'missing AgentMail Svix signature headers' };
    }
    wh.verify(rawBody, headers);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function normalizeAgentMailWebhook(body = {}) {
  const message = body.message || body.data?.message || body.data || {};
  const eventType = firstString(
    body.event_type,
    body.eventType,
    body.event,
    body.type,
    body.data?.event_type,
    body.data?.eventType,
    message.event_type,
    message.eventType,
    message.event,
    message.type
  );
  const eventId = firstString(
    body.event_id,
    body.eventId,
    body.id,
    body.data?.event_id,
    body.data?.eventId,
    message.event_id,
    message.eventId
  );
  const preview = firstString(body.preview, body.snippet, message.preview, message.snippet);
  const textPick = firstText([
    ['extractedText', body.extractedText, body.extracted_text, message.extractedText, message.extracted_text],
    ['text', body.text, message.text, message.plain, message.bodyText, message.body_text],
    ['body', body.body, message.body],
    ['html', body.html, message.html],
    ['preview', preview]
  ]);

  return {
    eventId,
    eventType,
    messageId: firstString(
      body.message_id,
      body.messageId,
      body.data?.message_id,
      body.data?.messageId,
      message.message_id,
      message.messageId,
      message.id
    ),
    threadId: firstString(
      body.thread_id,
      body.threadId,
      body.data?.thread_id,
      body.data?.threadId,
      message.thread_id,
      message.threadId
    ),
    inboxId: firstString(
      body.inbox_id,
      body.inboxId,
      body.data?.inbox_id,
      body.data?.inboxId,
      message.inbox_id,
      message.inboxId,
      DEFAULT_INBOX_ID
    ),
    fromEmail: emailOf(body.from) || emailOf(message.from) || emailOf(body.from_email) || emailOf(message.from_email),
    toEmail: emailOf(body.to) || emailOf(message.to) || emailOf(body.to_email) || emailOf(message.to_email),
    subject: firstString(body.subject, message.subject, '(no subject)'),
    preview: preview || '',
    text: textPick.text,
    textSource: textPick.source,
    direction: String(firstString(body.direction, message.direction, '')).toLowerCase(),
    rawMessage: message
  };
}

export function isInboundAgentMailWebhook(body = {}, normalized = normalizeAgentMailWebhook(body)) {
  const type = String(normalized.eventType || '').toLowerCase();
  return (
    normalized.direction === 'inbound' ||
    type.includes('inbound') ||
    type.includes('received') ||
    type === 'message.received' ||
    type === 'message_received'
  );
}

export function agentMailWebhookEventId(req, body = {}, normalized = normalizeAgentMailWebhook(body)) {
  const svixId = req?.headers?.['svix-id'];
  if (svixId) return `svix:${svixId}`;
  if (normalized.eventId) return `event:${normalized.eventId}`;
  if (normalized.messageId) return `message:${normalized.inboxId || 'inbox'}:${normalized.messageId}`;
  return `payload:${hashPayload({
    eventType: normalized.eventType,
    threadId: normalized.threadId,
    fromEmail: normalized.fromEmail,
    subject: normalized.subject,
    text: normalized.text,
    raw: body
  })}`;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstText(groups) {
  for (const [source, ...values] of groups) {
    for (const value of values) {
      if (typeof value !== 'string' || !value.trim()) continue;
      return {
        source,
        text: source === 'html' ? stripHtml(value).trim() : value.trim()
      };
    }
  }
  return { source: 'empty', text: '' };
}

function emailOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return extractEmail(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const email = emailOf(item);
      if (email) return email;
    }
    return null;
  }
  return emailOf(value.email || value.address || value.value || value.mail);
}

function extractEmail(value) {
  const match = String(value).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

function hashPayload(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

function stableStringify(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
