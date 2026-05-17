import { canEmail, env } from '../env.js';
import { normalizeProviderError, providerConfigured, sideEffectGate, smokeDetail } from './core.js';

const DEFAULT_TIMEOUT_SECONDS = 12;
const DEFAULT_MAX_RETRIES = 2;
const PROVIDER = 'agentmail';

const bool = (v) => v === 'true' || v === '1' || v === 'yes';

export function agentMailConfigured(config = env.agentmail) {
  return providerConfigured({
    AGENTMAIL_API_KEY: config.apiKey,
    AGENTMAIL_INBOX_ID: config.inboxId
  });
}

export function isAgentMailConfigured() {
  return agentMailConfigured().configured;
}

export function agentMailReadinessDetails(config = env.agentmail) {
  const configured = agentMailConfigured(config);
  return {
    configured: configured.configured,
    missing: configured.missing,
    auth: 'bearer_token',
    inboxId: config.inboxId ? 'configured' : 'missing',
    objectModel: 'organization_inbox_thread_message',
    inbound: {
      webhook: config.webhookSecret ? 'svix_signature_configured' : 'dev_unsigned_or_polling',
      polling: 'inboxes.messages.list'
    },
    replyTextSource: 'extractedText_preferred',
    smoke: env.smoke.agentmailSend ? 'enabled_by_SMOKE_AGENTMAIL_SEND' : 'disabled_by_default'
  };
}

export function classifyAgentMailFailure(err) {
  const normalized = normalizeProviderError(err);
  const msg = String(normalized.message || '').toLowerCase();
  const status = Number(normalized.status || 0) || null;
  const code = String(normalized.code || '').toLowerCase();

  let category = 'unknown';
  let retryable = normalized.retryable;
  if (status === 401 || status === 403 || /\b(auth|unauthorized|forbidden|token|api key)\b/.test(msg)) {
    category = 'auth';
    retryable = false;
  } else if (status === 429 || /\b(rate.?limit|too many requests|quota)\b/.test(msg)) {
    category = 'rate-limited';
    retryable = true;
  } else if (status === 404 || /\b(not.?found|unknown inbox|unknown message|missing inbox)\b/.test(msg)) {
    category = 'not-found';
    retryable = false;
  } else if (/\b(invalid|malformed|bad request|recipient|email address|validation)\b/.test(msg)) {
    category = 'validation';
    retryable = false;
  } else if (/\b(blocked|suppressed|bounced|complaint|unsubscribe|opt.?out|denied)\b/.test(msg)) {
    category = 'delivery-blocked';
    retryable = false;
  } else if (/\b(timeout|timed out|abort)\b/.test(msg) || code === 'timeout') {
    category = 'timeout';
    retryable = true;
  } else if (/\b(fetch failed|network|econn|enotfound|etimedout|socket)\b/.test(msg)) {
    category = 'network';
    retryable = true;
  } else if (status && status >= 500) {
    category = 'provider-error';
    retryable = true;
  } else if (status && status >= 400) {
    category = 'provider-rejected';
    retryable = false;
  }

  return {
    ...normalized,
    category,
    outcome: `failed:${category}`,
    retryable: retryable ?? true
  };
}

export function createMockAgentMailSendResult({ threadId, messageId, subject } = {}) {
  const id = messageId || `mock-agentmail-message-${Date.now().toString(36)}`;
  return {
    mock: true,
    provider: 'agentmail',
    providerId: id,
    messageId: id,
    threadId: threadId || `mock-thread-${Date.now().toString(36)}`,
    subject: subject || null
  };
}

export async function sendAgentMailMessage({
  inboxId = env.agentmail.inboxId,
  toEmail,
  to,
  subject,
  text,
  html,
  attachments,
  labels,
  replyTo,
  cc,
  bcc
}, options = {}) {
  requireAgentMailConfig(inboxId);
  const recipients = normalizeAddressList(to || toEmail);
  if (!recipients.length) throw new Error('AgentMail send requires at least one recipient');

  const mail = await agentMailClient();
  const res = await agentMailCall('sendMessage', () => mail.inboxes.messages.send(inboxId, compact({
    labels,
    reply_to: normalizeOptionalAddressList(replyTo),
    to: recipients,
    cc: normalizeOptionalAddressList(cc),
    bcc: normalizeOptionalAddressList(bcc),
    subject,
    text,
    html,
    attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined
  }), requestOptions(options)));

  return normalizeAgentMailSendResult(res, { inboxId, subject, toEmail: recipients[0] });
}

export async function replyAgentMailMessage({
  inboxId = env.agentmail.inboxId,
  messageId,
  toEmail,
  subject,
  text,
  html,
  attachments,
  labels,
  replyTo,
  cc,
  bcc
}, options = {}) {
  if (!messageId) {
    return sendAgentMailMessage({ inboxId, toEmail, subject, text, html, attachments, labels, replyTo, cc, bcc }, options);
  }

  requireAgentMailConfig(inboxId);
  const mail = await agentMailClient();
  const res = await agentMailCall('replyMessage', () => mail.inboxes.messages.reply(inboxId, messageId, compact({
    labels,
    reply_to: normalizeOptionalAddressList(replyTo),
    cc: normalizeOptionalAddressList(cc),
    bcc: normalizeOptionalAddressList(bcc),
    text,
    html,
    attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined
  }), requestOptions(options)));

  return normalizeAgentMailSendResult(res, { inboxId, subject, repliedToMessageId: messageId });
}

export async function fetchAgentMailIncomingMessages({
  inboxId = env.agentmail.inboxId,
  limit = 25,
  pageToken,
  labels,
  ascending = false,
  hydrate = true,
  inboundOnly = true
} = {}, options = {}) {
  requireAgentMailConfig(inboxId);
  const mail = await agentMailClient();
  const listResponse = await agentMailCall('listMessages', () => mail.inboxes.messages.list(inboxId, compact({
    limit,
    page_token: pageToken,
    labels,
    ascending
  }), requestOptions(options)));

  const items = Array.isArray(listResponse?.messages) ? listResponse.messages : [];
  const hydrated = hydrate
    ? await Promise.all(items.map((item) => hydrateMessage(mail, inboxId, item, options)))
    : items;
  const messages = hydrated
    .map((message) => normalizeAgentMailMessage(message, { inboxId, eventType: 'message.listed' }))
    .filter((message) => !inboundOnly || isInboundAgentMailMessage(message));

  return {
    provider: 'agentmail',
    inboxId,
    count: listResponse?.count ?? messages.length,
    nextPageToken: listResponse?.next_page_token || listResponse?.nextPageToken || null,
    messages
  };
}

export async function fetchAgentMailThread({ inboxId = env.agentmail.inboxId, threadId } = {}, options = {}) {
  requireAgentMailConfig(inboxId);
  if (!threadId) throw new Error('AgentMail thread fetch requires threadId');
  const mail = await agentMailClient();
  const thread = await agentMailCall('getThread', () => mail.inboxes.threads.get(inboxId, threadId, requestOptions(options)));
  return {
    provider: 'agentmail',
    inboxId,
    threadId: thread?.thread_id || thread?.threadId || threadId,
    subject: thread?.subject || null,
    preview: thread?.preview || null,
    messages: (thread?.messages || []).map((message) => normalizeAgentMailMessage(message, { inboxId, threadId }))
  };
}

export async function runAgentMailLiveSendSmoke({
  toEmail = process.env.SMOKE_TEST_EMAIL,
  subject = 'callmemaybe AgentMail smoke',
  text = 'AgentMail smoke test from callmemaybe.'
} = {}) {
  return smokeAgentMailSend({ toEmail, subject, text });
}

export async function smokeAgentMailSend({
  toEmail = process.env.SMOKE_TEST_EMAIL,
  subject = 'callmemaybe AgentMail smoke',
  text = 'AgentMail smoke test from callmemaybe.'
} = {}) {
  const configured = agentMailConfigured();
  if (!configured.configured) {
    return { provider: PROVIDER, status: 'missing', detail: smokeDetail({ skipped: configured.missing.join(', ') }) };
  }

  const gate = sideEffectGate({
    provider: PROVIDER,
    action: 'send message smoke',
    enabled: env.smoke.agentmailSend || bool(process.env.SMOKE_AGENTMAIL_SEND),
    details: { toggle: 'SMOKE_AGENTMAIL_SEND' }
  });
  if (!gate.ok) {
    return { provider: PROVIDER, status: 'configured', detail: smokeDetail({ skipped: gate.reason, extra: gate.details }) };
  }
  if (!toEmail) {
    return { provider: PROVIDER, status: 'blocked', detail: smokeDetail({ skipped: 'SMOKE_TEST_EMAIL is required' }) };
  }
  if (!canEmail(toEmail)) {
    return {
      provider: PROVIDER,
      status: 'blocked',
      detail: smokeDetail({
        skipped: 'RUN_MODE/LIVE_EMAILS/ALLOWED_TARGET_EMAILS do not allow this smoke recipient',
        extra: { mode: env.runMode, liveEmails: env.live.emails }
      })
    };
  }

  const result = await sendAgentMailMessage({ toEmail, subject, text }, { maxRetries: 1, timeoutSeconds: 10 });
  return {
    provider: PROVIDER,
    status: 'ok',
    messageId: result.messageId,
    threadId: result.threadId,
    detail: smokeDetail({
      dryRun: false,
      live: true,
      extra: { messageId: result.messageId, threadId: result.threadId, inboxId: result.inboxId }
    })
  };
}

export function normalizeAgentMailMessage(raw = {}, fallback = {}) {
  const source = raw?.message || raw?.data?.message || raw?.data || raw || {};
  const eventType = first(raw.event, raw.type, raw.event_type, source.event, source.type, fallback.eventType);
  const labels = normalizeStringList(first(raw.labels, source.labels, fallback.labels));
  const text = first(
    raw.text,
    raw.body,
    raw.plain,
    raw.snippet,
    source.text,
    source.body,
    source.plain,
    source.snippet,
    source.preview,
    htmlToText(first(raw.html, source.html))
  );
  const direction = normalizeDirection(first(raw.direction, source.direction, fallback.direction), eventType, labels);
  const toEmails = normalizeAddressList(first(raw.to, raw.to_email, raw.toEmail, source.to, source.to_email, source.toEmail, fallback.to));
  const fromValue = first(raw.from, raw.from_email, raw.fromEmail, source.from, source.from_email, source.fromEmail, fallback.from);

  return {
    eventId: first(raw.eventId, raw.event_id, raw.id, source.eventId, source.event_id, fallback.eventId),
    eventType: eventType || null,
    messageId: first(raw.messageId, raw.message_id, source.messageId, source.message_id, source.id, fallback.messageId),
    threadId: first(raw.threadId, raw.thread_id, source.threadId, source.thread_id, fallback.threadId),
    inboxId: first(raw.inboxId, raw.inbox_id, source.inboxId, source.inbox_id, fallback.inboxId, env.agentmail.inboxId),
    fromEmail: emailOf(fromValue),
    toEmail: toEmails[0] || null,
    toEmails,
    subject: first(raw.subject, source.subject, fallback.subject, '(no subject)'),
    text: typeof text === 'string' ? text : safeString(text || ''),
    html: first(raw.html, source.html, fallback.html) || null,
    preview: first(raw.preview, source.preview, fallback.preview) || null,
    direction,
    labels,
    inReplyTo: first(raw.inReplyTo, raw.in_reply_to, source.inReplyTo, source.in_reply_to, fallback.inReplyTo),
    references: normalizeStringList(first(raw.references, source.references, fallback.references)),
    timestamp: first(raw.timestamp, source.timestamp, raw.created_at, source.created_at, fallback.timestamp) || null,
    fetchError: raw._fetchError || null
  };
}

export function normalizeAgentMailSendResult(raw = {}, fallback = {}) {
  const message = raw?.message || raw?.data?.message || raw?.data || raw || {};
  const messageId = first(message.message_id, message.messageId, message.id, raw.message_id, raw.messageId, fallback.messageId);
  const threadId = first(message.thread_id, message.threadId, raw.thread_id, raw.threadId, fallback.threadId, messageId);
  return {
    mock: false,
    provider: 'agentmail',
    providerId: messageId || threadId,
    messageId: messageId || null,
    threadId: threadId || null,
    inboxId: first(message.inbox_id, message.inboxId, raw.inbox_id, raw.inboxId, fallback.inboxId, env.agentmail.inboxId),
    subject: first(message.subject, raw.subject, fallback.subject) || null
  };
}

export function isInboundAgentMailMessage(raw = {}) {
  const message = raw.messageId || raw.threadId || raw.eventType || raw.labels ? raw : normalizeAgentMailMessage(raw);
  const direction = String(message.direction || '').toLowerCase();
  if (direction === 'inbound') return true;
  if (direction === 'outbound') return false;

  const labels = (message.labels || []).map((label) => String(label).toLowerCase());
  if (labels.some((label) => ['sent', 'outbound'].includes(label))) return false;
  if (labels.some((label) => ['inbox', 'inbound', 'received'].includes(label))) return true;

  const type = String(message.eventType || '').toLowerCase();
  if (type.includes('sent') || type.includes('outbound')) return false;
  return type.includes('inbound') || type.includes('received') || type === 'message.received';
}

async function hydrateMessage(mail, inboxId, item, options) {
  const messageId = item?.message_id || item?.messageId || item?.id;
  if (!messageId) return item;
  try {
    return await agentMailCall('getMessage', () => mail.inboxes.messages.get(inboxId, messageId, requestOptions(options)));
  } catch (err) {
    return { ...item, _fetchError: err?.message || String(err) };
  }
}

async function agentMailClient() {
  const { AgentMailClient } = await import('agentmail');
  return new AgentMailClient({ apiKey: env.agentmail.apiKey });
}

function requireAgentMailConfig(inboxId) {
  if (!env.agentmail.apiKey) throw new Error('AGENTMAIL_API_KEY is required');
  if (!inboxId) throw new Error('AGENTMAIL_INBOX_ID is required');
}

function requestOptions({ timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, maxRetries = DEFAULT_MAX_RETRIES, abortSignal } = {}) {
  return compact({
    timeoutInSeconds: timeoutSeconds,
    maxRetries,
    abortSignal
  });
}

async function agentMailCall(action, fn) {
  try {
    return await fn();
  } catch (err) {
    const classified = classifyAgentMailFailure(err);
    const wrapped = new Error(`${PROVIDER}.${action} failed: ${classified.message || 'provider request failed'}`);
    Object.assign(wrapped, classified, { provider: PROVIDER, action, cause: err });
    throw wrapped;
  }
}

function normalizeDirection(value, eventType, labels = []) {
  const explicit = String(value || '').toLowerCase();
  if (explicit === 'inbound' || explicit === 'outbound') return explicit;

  const labelText = labels.map((label) => String(label).toLowerCase());
  if (labelText.some((label) => ['sent', 'outbound'].includes(label))) return 'outbound';
  if (labelText.some((label) => ['inbox', 'inbound', 'received'].includes(label))) return 'inbound';

  const type = String(eventType || '').toLowerCase();
  if (type.includes('sent') || type.includes('outbound')) return 'outbound';
  if (type.includes('received') || type.includes('inbound')) return 'inbound';
  return '';
}

function normalizeOptionalAddressList(value) {
  const list = normalizeAddressList(value);
  return list.length ? list : undefined;
}

function normalizeAddressList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => emailOf(item)).filter(Boolean);
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map((item) => emailOf(item)).filter(Boolean);
  }
  const email = emailOf(value);
  return email ? [email] : [];
}

function emailOf(value) {
  if (!value) return null;
  if (Array.isArray(value)) return emailOf(value[0]);
  if (typeof value === 'object') return value.email || value.address || value.value || null;
  const text = String(value);
  const angle = text.match(/<([^>]+@[^>]+)>/);
  if (angle) return angle[1].trim();
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].trim() : null;
}

function normalizeStringList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return [String(value)].filter(Boolean);
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null));
}

function htmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function safeString(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
