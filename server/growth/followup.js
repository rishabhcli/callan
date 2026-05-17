import { randomBytes } from 'node:crypto';
import { contactEvents, growthFollowups, growthPlans, leads } from '../db.js';
import { env, canEmail } from '../env.js';
import { emit } from '../sse.js';
import { addDoc, containerTagFor } from '../memory.js';
import { log } from '../logger.js';
import {
  createMockAgentMailSendResult,
  replyAgentMailMessage,
  sendAgentMailMessage
} from '../providers/agentmail.js';
import { generateGrowthPlanForLead, readGrowthPlanRow } from './planner.js';
import { classifyGrowthReply } from './replyPolicy.js';

export { classifyGrowthReply };

export async function sendGrowthRecap({ leadId, toEmail, force = false } = {}) {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`lead not found: ${leadId}`);
  let state = readGrowthPlanRow(growthPlans.getLatest(leadId));
  if (!state.plan) state = await generateGrowthPlanForLead({ leadId, source: 'growth_followup' });

  const optOut = growthOptOutStatus(leadId, lead);
  if (optOut.blocked) {
    const skipped = persistGrowthFollowup({
      leadId,
      growthPlanId: state.row?.id,
      status: 'skipped',
      direction: 'outbound',
      channel: 'agentmail',
      subject: 'Post-delivery growth recap',
      body: '',
      classification: { kind: 'blocked', reason: optOut.reason },
      metadata: { reason: optOut.reason, blocked: true },
      idempotencyKey: `growth_recap:${leadId}:${state.row?.id || 'none'}:blocked`
    });
    emit('growth.followup_skipped', {
      worker: 'growth',
      leadId,
      growthPlanId: state.row?.id,
      reason: optOut.reason,
      followupId: skipped.id
    });
    return { status: 'skipped', reason: optOut.reason, followup: skipped };
  }

  if (!force && !isDelivered(lead)) {
    const skipped = persistGrowthFollowup({
      leadId,
      growthPlanId: state.row?.id,
      status: 'skipped',
      direction: 'outbound',
      channel: 'agentmail',
      subject: 'Post-delivery growth recap',
      body: '',
      classification: { kind: 'not_delivered', reason: 'Growth recap waits until delivery.' },
      metadata: { reason: 'not_delivered' },
      idempotencyKey: `growth_recap:${leadId}:${state.row?.id || 'none'}:not_delivered`
    });
    emit('growth.followup_skipped', {
      worker: 'growth',
      leadId,
      growthPlanId: state.row?.id,
      reason: 'not_delivered',
      followupId: skipped.id
    });
    return { status: 'skipped', reason: 'not_delivered', followup: skipped };
  }

  const idempotencyKey = `growth_recap:${leadId}:${state.row?.id || 'none'}:post_delivery`;
  const existing = growthFollowups.getByIdempotency(idempotencyKey);
  if (existing && !force) {
    emit('growth.followup_reused', { worker: 'growth', leadId, growthPlanId: state.row?.id, followupId: existing.id });
    return { status: existing.status, reused: true, followup: existing };
  }

  const recipient = resolveRecipient({ lead, toEmail });
  const subject = `A few growth opportunities for ${lead.business_name}`;
  const body = buildGrowthRecapBody({ lead, plan: state.plan, offers: state.offers });
  const latestMessage = latestAgentMailMessage(leadId);
  const sendResult = await sendGrowthAgentMail({
    toEmail: recipient,
    subject,
    text: body,
    threadId: latestMessage?.thread_id || lead.agentmail_thread_id,
    messageId: latestMessage?.provider_id || null
  });

  const contactId = contactEvents.add({
    lead_id: leadId,
    type: 'growth_recap',
    direction: 'outbound',
    channel: 'agentmail',
    provider_id: sendResult.providerId,
    thread_id: sendResult.threadId || latestMessage?.thread_id || lead.agentmail_thread_id || null,
    subject,
    body,
    metadata: {
      growthPlanId: state.row?.id,
      nextRecommendedService: state.offers?.nextRecommendedService?.id,
      toMasked: maskEmail(recipient),
      mock: sendResult.mock,
      allowed: true,
      decisionCode: 'growth.post_delivery_recap',
      decisionReason: 'post-delivery growth recap sent only after opt-out check'
    }
  });

  const followup = persistGrowthFollowup({
    leadId,
    growthPlanId: state.row?.id,
    status: 'sent',
    direction: 'outbound',
    channel: 'agentmail',
    providerId: sendResult.providerId,
    threadId: sendResult.threadId || latestMessage?.thread_id || lead.agentmail_thread_id || null,
    subject,
    body,
    classification: { kind: 'growth_recap', reason: 'post-delivery growth recap' },
    metadata: {
      contactEventId: contactId,
      messageId: sendResult.messageId,
      mock: sendResult.mock,
      recipientMasked: maskEmail(recipient),
      nextRecommendedService: state.offers?.nextRecommendedService
    },
    idempotencyKey
  });

  await writeGrowthThreadMemory({ lead, direction: 'outbound', subject, body, followup, state, sendResult });

  emit('growth.followup_sent', {
    worker: 'growth',
    leadId,
    growthPlanId: state.row?.id,
    followupId: followup.id,
    threadId: sendResult.threadId,
    messageId: sendResult.messageId,
    nextRecommendedService: state.offers?.nextRecommendedService?.id,
    mock: sendResult.mock
  });

  return { status: 'sent', followup, contactId, sendResult };
}

export async function recordGrowthCustomerResponse({ leadId, message, subject = 'Growth reply', threadId, providerId } = {}) {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`lead not found: ${leadId}`);
  const classification = classifyGrowthReply({ subject, text: message });
  const contactId = contactEvents.add({
    lead_id: leadId,
    type: 'growth_reply',
    direction: 'inbound',
    channel: 'agentmail',
    provider_id: providerId || `mock-growth-reply-${Date.now().toString(36)}`,
    thread_id: threadId || lead.agentmail_thread_id || null,
    subject,
    body: message || '',
    metadata: { classification, growthReply: classification }
  });
  const followup = persistGrowthFollowup({
    leadId,
    growthPlanId: growthPlans.getLatest(leadId)?.id || null,
    status: 'received',
    direction: 'inbound',
    channel: 'agentmail',
    providerId: providerId || null,
    threadId: threadId || lead.agentmail_thread_id || null,
    subject,
    body: message || '',
    classification,
    metadata: { contactEventId: contactId },
    idempotencyKey: `growth_reply:${leadId}:${providerId || stableText(message)}`
  });
  await writeGrowthThreadMemory({
    lead,
    direction: 'inbound',
    subject,
    body: message || '',
    followup,
    state: readGrowthPlanRow(growthPlans.getLatest(leadId)),
    sendResult: { mock: true, messageId: providerId || null, threadId: threadId || null }
  });
  emit('growth.reply_classified', {
    worker: 'growth',
    leadId,
    contactId,
    followupId: followup.id,
    classification: classification.kind,
    operatorFlag: classification.operatorFlag
  });
  return { contactId, followup, classification };
}

export function growthOptOutStatus(leadId, lead = leads.get(leadId)) {
  if (!lead) return { blocked: true, reason: 'lead_not_found' };
  const risk = `${lead.risk_status || ''} ${lead.next_action || ''} ${lead.outreach_status || ''}`.toLowerCase();
  if (/opt.?out|do_not_email|unsubscribe/.test(risk)) return { blocked: true, reason: 'lead_opted_out' };
  const events = contactEvents.listByLead(leadId, { limit: 30 });
  const opted = events.some((event) => {
    const text = `${event.type || ''} ${event.subject || ''} ${event.body || ''} ${event.metadata_json || ''}`;
    return /opt.?out|unsubscribe|do not email|stop emailing|remove me/i.test(text);
  });
  return opted ? { blocked: true, reason: 'thread_opted_out' } : { blocked: false, reason: 'clear' };
}

function persistGrowthFollowup({
  leadId,
  growthPlanId,
  status,
  direction,
  channel,
  providerId,
  threadId,
  subject,
  body,
  classification,
  metadata,
  idempotencyKey
}) {
  return growthFollowups.insertOrGetByIdempotency({
    id: `gf_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
    lead_id: leadId,
    growth_plan_id: growthPlanId || null,
    direction,
    channel,
    status,
    classification: classification?.kind || null,
    provider_id: providerId || null,
    thread_id: threadId || null,
    subject: subject || null,
    body: body || null,
    metadata: { classification, ...metadata },
    idempotency_key: idempotencyKey
  }).row;
}

async function sendGrowthAgentMail({ toEmail, subject, text, threadId, messageId }) {
  if (shouldMockGrowthEmail(toEmail)) {
    return createMockAgentMailSendResult({
      threadId: threadId || `mock-growth-thread-${randomBytes(4).toString('hex')}`,
      messageId: `mock-growth-recap-${randomBytes(4).toString('hex')}`,
      subject
    });
  }
  if (messageId) {
    return replyAgentMailMessage({
      inboxId: env.agentmail.inboxId,
      messageId,
      toEmail,
      subject,
      text,
      html: htmlParagraphs(text)
    }, { timeoutSeconds: 15, maxRetries: 2 });
  }
  return sendAgentMailMessage({
    inboxId: env.agentmail.inboxId,
    toEmail,
    subject,
    text,
    html: htmlParagraphs(text)
  }, { timeoutSeconds: 15, maxRetries: 2 });
}

function buildGrowthRecapBody({ lead, plan, offers }) {
  const next = offers?.nextRecommendedService;
  const evidence = new Map((plan?.evidence || []).map((item) => [item.id, item]));
  const citations = (next?.evidenceIds || []).map((id) => evidence.get(id)?.summary).filter(Boolean).slice(0, 2);
  return [
    `Hi ${lead.business_name},`,
    '',
    `Your site is delivered, so I took a quick operational look at what would help the business next.`,
    next ? `The next best service is ${next.name}: ${next.summary}` : 'The next best service is a light monthly growth and maintenance loop.',
    citations.length ? `Why now: ${citations.join(' ')}` : '',
    '',
    'This is practical growth support only: local SEO basics, Google Business Profile hygiene, review capture, contact/booking flow, analytics, content, maintenance, and simple automations. I will not make ranking, revenue, legal, tax, or financial promises in this thread.',
    '',
    'Reply with "interested" if you want the next step, "not now" if timing is bad, or "unsubscribe" and I will stop these growth follow-ups.',
    '',
    'the team at callmemaybe'
  ].filter(Boolean).join('\n');
}

async function writeGrowthThreadMemory({ lead, direction, subject, body, followup, state, sendResult }) {
  try {
    await addDoc(lead.container_tag || containerTagFor(lead.id), 'mail_thread', {
      direction,
      threadId: followup.thread_id || sendResult.threadId || null,
      messageId: sendResult.messageId || followup.provider_id || null,
      subject,
      body,
      growthPlanId: state?.row?.id || null,
      growthFollowupId: followup.id,
      at: new Date().toISOString()
    }, {
      kind: 'growth_customer_response',
      growthPlanId: state?.row?.id || null,
      growthFollowupId: followup.id,
      direction,
      mock: sendResult.mock
    });
  } catch (err) {
    log.warn('growth.mail_thread.memory.add_failed', { leadId: lead.id, error: err?.message || String(err) });
  }
}

function latestAgentMailMessage(leadId) {
  return contactEvents.listByLead(leadId, { limit: 20 })
    .find((event) => event.channel === 'agentmail' && event.provider_id);
}

function resolveRecipient({ lead, toEmail }) {
  if (toEmail) return toEmail;
  if (env.runMode === 'mock') {
    const slug = String(lead.business_name || 'business').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business';
    return `owner@${slug}.test`;
  }
  return env.smoke.testEmail || env.allowedEmails[0] || '';
}

function shouldMockGrowthEmail(toEmail) {
  if (!env.live.emails || !env.agentmail.apiKey || !env.agentmail.inboxId) return true;
  if (!canEmail(toEmail)) return true;
  return false;
}

function isDelivered(lead) {
  return lead.status === 'shipped' || Boolean(lead.website);
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

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0] || '*'}***@***.${tld}`;
}

function stableText(value) {
  return String(value || 'empty').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
}
