/**
 * Live intent detection for inbound calls.
 *
 * Callan (the hosted AgentPhone LLM) can SAY "I'll email you the details" but it has no hands.
 * As transcript chunks arrive, we scan them for actionable intents — right now:
 *   - "send me email about callmemaybe" with an email address → fire AgentMail
 *
 * Each call only triggers each action once (tracked in `sentByCallId`).
 */

import { env } from './env.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { sendAgentMailMessage } from './providers/agentmail.js';
import { sendCallbackInvoiceEmail } from './emailCallback.js';
import { contactEvents, db } from './db.js';

// Per-call hot-path de-dupe keyed by call row id. Durable de-dupe is backed by
// contact_events so a worker restart after a successful send does not resend.
const sentByCallId = new Set();

const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const EMAIL_INTENT_RX = /\b(send|email|shoot|forward|fire|drop|kick|mail)\b/i;

/**
 * Reconstruct an email from spoken form like "rishabh dot bansal at gmail dot com"
 * or "r-i-s-h-a-b-h at gmail dot com" or "r i s h a b h dot r v at icloud dot com."
 *
 * Strategy:
 *   - Glue runs of 2+ single chars into one token (not 3+ — that drops trailing
 *     two-letter fragments like "r v" → "rv").
 *   - Trim the matched domain back to the first common TLD so cross-turn or
 *     cross-sentence text doesn't bleed into the address.
 *   - When there are multiple candidates, prefer the longest local part.
 */
function reconstructSpokenEmail(text) {
  if (!text) return null;
  let t = ` ${String(text).toLowerCase()} `;

  // normalize spoken punctuation
  t = t.replace(/\b(at the rate of|at the rate)\b/g, ' at ');
  t = t.replace(/\b(dot|period|point)\b/g, '.');
  t = t.replace(/\b(at|@)\b/g, '@');
  t = t.replace(/\b(underscore)\b/g, '_');
  t = t.replace(/\b(dash|hyphen|minus)\b/g, '-');
  t = t.replace(/\bplus\b/g, '+');

  // collapse spaces around address punctuation
  t = t.replace(/\s*\.\s*/g, '.');
  t = t.replace(/\s*@\s*/g, '@');
  t = t.replace(/\s*_\s*/g, '_');
  t = t.replace(/\s*-\s*/g, '-');
  t = t.replace(/\s*\+\s*/g, '+');

  // glue letter-by-letter spellings — 2+ single chars in a row collapse into one token.
  t = t.replace(/(?:\b[a-z0-9]\b\s+){1,}\b[a-z0-9]\b/g, (m) => m.replace(/\s+/g, ''));

  const matches = [...t.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)].map((m) => m[0]);
  if (!matches.length) return null;
  matches.sort((a, b) => b.split('@')[0].length - a.split('@')[0].length);
  return sanitizeEmail(matches[0]);
}

const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'co', 'io', 'me', 'edu', 'gov', 'us', 'uk',
  'shop', 'app', 'dev', 'ai', 'xyz', 'tech', 'design'
]);

function sanitizeEmail(email) {
  if (!email) return null;
  let e = String(email).toLowerCase().replace(/^[.\-_]+|[.\-_]+$/g, '');
  const at = e.indexOf('@');
  if (at < 0) return e;
  const local = e.slice(0, at);
  let domain = e.slice(at + 1);
  // The greedy domain match can grab text past the real TLD when periods
  // separate further words. Truncate at the first common TLD we see.
  const parts = domain.split('.');
  for (let i = 1; i < parts.length; i++) {
    if (COMMON_TLDS.has(parts[i])) {
      domain = parts.slice(0, i + 1).join('.');
      break;
    }
  }
  return `${local}@${domain}`;
}

export function detectEmailInTranscript(transcript) {
  if (!Array.isArray(transcript)) return null;
  // Walk last 8 user turns MOST RECENT FIRST. Parse each turn ALONE so the
  // regex never crosses turn boundaries (which previously let "Bye." or
  // "Thanks." get eaten into the email's domain).
  const userTurns = transcript
    .filter((t) => t && (t.role === 'user' || t.role === 'caller' || t.role === 'human'))
    .slice(-8)
    .reverse();

  for (const turn of userTurns) {
    const text = String(turn.text || '');
    if (!text.trim()) continue;
    const direct = text.match(EMAIL_RX)?.[0];
    if (direct) return sanitizeEmail(direct);
    const spoken = reconstructSpokenEmail(text);
    if (spoken) return spoken;
  }
  return null;
}

export function detectSendEmailIntent(transcript) {
  if (!Array.isArray(transcript)) return false;
  // Either the user asked for an email, OR the agent agreed to send one — both count.
  const recent = transcript.slice(-10);
  for (const turn of recent) {
    if (!turn?.text) continue;
    const text = String(turn.text);
    if (EMAIL_INTENT_RX.test(text)) return true;
    if (/\bemail\b/i.test(text) && /\b(me|over|info|details|callback|follow up|followup)\b/i.test(text)) return true;
  }
  return false;
}

function callmemaybeEmailBody({ businessName, fromPhone }) {
  const lines = [
    `Thanks for calling callmemaybe — this is the follow-up Callan promised on the line.`,
    ``,
    `Here is the short version of what we do:`,
    ``,
    `• We research a small business, call the owner, and build a focused $500 same-day website tailored to ONE clear next action a visitor should take (book, call, get a quote).`,
    `• Built live in the cloud with Browser Use + Lovable; you can watch the build happen.`,
    `• Paid via Stripe invoice. We ship same day or the call doesn't bill.`,
    ``,
    `If you want us to start, reply to this thread with your business name, what you sell, and the best callback number. We'll take it from there.`,
    ``,
    `— Callan, callmemaybe voice operator`,
    fromPhone ? `(inbound call from ${fromPhone})` : null,
    businessName ? `(matched lead: ${businessName})` : null
  ].filter(Boolean);
  return lines.join('\n');
}

function safeId(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'unknown';
}

function maskEmail(email) {
  if (!email) return null;
  const [name, domain] = String(email).split('@');
  if (!domain) return '***';
  const visible = name.length <= 2 ? name[0] || '*' : `${name[0]}***${name[name.length - 1]}`;
  return `${visible}@${domain}`;
}

function inboundEmailEventType(useContextualInvoice) {
  return useContextualInvoice ? 'callback_invoice' : 'inbound_voice_followup';
}

function inboundEmailEventId(callId, type) {
  return `agentmail_${type}_${safeId(callId)}`;
}

function parseMetadata(row) {
  try {
    return row?.metadata_json ? JSON.parse(row.metadata_json) : {};
  } catch {
    return {};
  }
}

function existingInboundVoiceEmailEvent(callRow, type) {
  if (!callRow?.id) return null;
  const expectedId = inboundEmailEventId(callRow.id, type);
  const byId = db.prepare('SELECT * FROM contact_events WHERE id = ? LIMIT 1').get(expectedId);
  if (byId) return { ...byId, metadata: parseMetadata(byId) };

  const leadId = callRow.lead_id || null;
  if (!leadId) return null;
  const rows = db.prepare(`
    SELECT * FROM contact_events
    WHERE lead_id = ?
      AND type = ?
      AND direction = 'outbound'
      AND channel = 'agentmail'
    ORDER BY created_at DESC
    LIMIT 200
  `).all(leadId, type);
  for (const row of rows) {
    const metadata = parseMetadata(row);
    if (metadata.callId === callRow.id || metadata.call_id === callRow.id) {
      return { ...row, metadata };
    }
  }
  return null;
}

function resultFromPersistedInboundEmail(row, email) {
  const metadata = row?.metadata || parseMetadata(row);
  return {
    email,
    reused: true,
    contactEventId: row?.id || null,
    providerId: row?.provider_id || metadata?.providerId || metadata?.messageId || null,
    messageId: metadata?.messageId || row?.provider_id || null,
    threadId: row?.thread_id || metadata?.threadId || null,
    subject: row?.subject || null
  };
}

function isDuplicateContactEvent(err) {
  return err?.code?.startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed: contact_events\.id/i.test(err?.message || '');
}

function recordInboundVoiceEmailEvent({
  callRow,
  lead,
  type,
  trigger,
  email,
  subject,
  body,
  result,
  checkoutUrl = null,
  context = null
}) {
  const eventId = inboundEmailEventId(callRow.id, type);
  const metadata = {
    callId: callRow.id,
    leadId: callRow.lead_id || lead?.id || null,
    trigger,
    toMasked: maskEmail(email),
    messageId: result?.messageId || result?.providerId || null,
    threadId: result?.threadId || null,
    providerId: result?.providerId || result?.messageId || null,
    checkoutUrl,
    businessName: context?.businessName || lead?.business_name || null,
    decisionCode: `agentmail.outbound.${type}`,
    decisionReason: type === 'callback_invoice'
      ? 'Transcript-triggered invoice email was sent after the caller requested payment details.'
      : 'Transcript-triggered inbound voice follow-up email was sent after the caller requested details.'
  };
  try {
    const id = contactEvents.add({
      id: eventId,
      lead_id: callRow.lead_id || lead?.id || null,
      type,
      direction: 'outbound',
      channel: 'agentmail',
      provider_id: result?.providerId || result?.messageId || null,
      thread_id: result?.threadId || null,
      subject,
      body,
      metadata
    });
    return { id, inserted: true, metadata };
  } catch (err) {
    if (!isDuplicateContactEvent(err)) throw err;
    const row = existingInboundVoiceEmailEvent(callRow, type);
    return { id: row?.id || eventId, inserted: false, metadata: row?.metadata || metadata };
  }
}

/**
 * Called after each transcript update on an inbound call.
 * If we detect a valid email + a send intent, fire AgentMail (once per call).
 *
 * For email-callback calls (where Callan dialed the user because they emailed
 * us first), pass `overrideEmail` so we use the originating address without
 * needing the caller to dictate their email back to the agent.
 */
export async function maybeFireInboundEmail({
  callRow,
  lead,
  transcript,
  overrideEmail = null,
  throwOnFailure = false,
  mailSender = sendAgentMailMessage,
  invoiceSender = sendCallbackInvoiceEmail,
  requireAgentMailConfig = true
}) {
  if (!callRow || sentByCallId.has(callRow.id)) return null;
  const email = overrideEmail || detectEmailInTranscript(transcript);
  if (!email) return null;
  const wantsEmail = detectSendEmailIntent(transcript);
  if (!wantsEmail) return null;

  // Decide whether to send a CONTEXTUAL invoice (Stripe checkout + meeting
  // invite + Gemini recap) vs the generic callmemaybe follow-up body.
  //   - Email-callback calls always use the contextual invoice (the whole
  //     point of the callback was to send an invoice).
  //   - Inbound calls use the contextual invoice WHEN the caller mentioned
  //     "invoice", "the $500", or an explicit ask for the build (vs a vague
  //     "send me info"). This is the bug the previous Floral Beauties call
  //     hit — caller asked for the invoice, we sent the generic followup.
  const transcriptText = (Array.isArray(transcript) ? transcript : [])
    .map((t) => (t && typeof t.text === 'string' ? t.text : ''))
    .join(' ');
  const wantsInvoice = /\b(invoice|the\s+\$?500|the\s+five[\s-]?hundred|the\s+build|the\s+website\s+build|the\s+deal|the\s+offer)\b/i.test(transcriptText);
  const useContextualInvoice = callRow.decision_reason === 'agentphone_email_callback' || wantsInvoice;
  const eventType = inboundEmailEventType(useContextualInvoice);
  const persisted = existingInboundVoiceEmailEvent(callRow, eventType);
  if (persisted) {
    sentByCallId.add(callRow.id);
    log.info('inbound.email.reused_persisted_receipt', {
      callId: callRow.id,
      leadId: callRow.lead_id || null,
      type: eventType,
      contactEventId: persisted.id
    });
    return resultFromPersistedInboundEmail(persisted, email);
  }

  if (requireAgentMailConfig && (!env.agentmail?.apiKey || !env.agentmail?.inboxId)) {
    log.warn('inbound.email.skipped', { callId: callRow.id, reason: 'agentmail_not_configured' });
    return null;
  }

  // Mark BEFORE the await so concurrent transcript events don't double-fire.
  sentByCallId.add(callRow.id);

  if (useContextualInvoice) {
    try {
      const result = await invoiceSender({
        recipient: email,
        transcript,
        callId: callRow.id,
        leadId: callRow.lead_id || null
      });
      const receipt = recordInboundVoiceEmailEvent({
        callRow,
        lead,
        type: eventType,
        trigger: 'callback_invoice',
        email,
        subject: result?.subject || 'Your callmemaybe invoice — $500 + meeting notes',
        body: result?.text || 'Callback invoice email sent.',
        result,
        checkoutUrl: result?.checkoutUrl || null,
        context: result?.context || null
      });
      log.info('callback.invoice.sent', {
        callId: callRow.id, toEmail: email,
        businessName: result?.context?.businessName || null,
        path: callRow.decision_reason === 'agentphone_email_callback' ? 'email_callback' : 'inbound_invoice_intent',
        contactEventId: receipt.id,
        receiptInserted: receipt.inserted
      });
      return { email, contactEventId: receipt.id, ...result };
    } catch (err) {
      sentByCallId.delete(callRow.id);
      log.error('callback.invoice.send_failed', {
        callId: callRow.id, toEmail: email, error: err?.message || String(err)
      });
      emit('mailer.error', {
        worker: 'mailer',
        leadId: callRow.lead_id,
        callId: callRow.id,
        toEmail: email,
        error: err?.message || String(err),
        trigger: 'callback_invoice'
      });
      if (throwOnFailure) throw err;
      return null;
    }
  }

  const subject = `Following up from your call — callmemaybe`;
  const text = callmemaybeEmailBody({
    businessName: lead?.business_name && !String(lead.business_name).startsWith('Inbound caller')
      ? lead.business_name : null,
    fromPhone: callRow.to_phone || lead?.phone || null
  });

  try {
    const result = await mailSender({
      toEmail: email,
      subject,
      text,
      leadId: callRow.lead_id || null,
      costKind: 'inbound_followup'
    });
    const receipt = recordInboundVoiceEmailEvent({
      callRow,
      lead,
      type: eventType,
      trigger: 'inbound_voice',
      email,
      subject,
      body: text,
      result
    });
    log.info('inbound.email.sent', {
      callId: callRow.id,
      leadId: callRow.lead_id,
      toEmail: email,
      messageId: result?.messageId || null,
      threadId: result?.threadId || null,
      contactEventId: receipt.id,
      receiptInserted: receipt.inserted
    });
    emit('mailer.email_sent', {
      worker: 'mailer',
      leadId: callRow.lead_id,
      callId: callRow.id,
      toEmail: email,
      subject,
      threadId: result?.threadId,
      messageId: result?.messageId,
      trigger: 'inbound_voice'
    });
    return { email, contactEventId: receipt.id, ...result };
  } catch (err) {
    // Roll back so we'll retry on the next transcript chunk.
    sentByCallId.delete(callRow.id);
    log.error('inbound.email.send_failed', {
      callId: callRow.id, leadId: callRow.lead_id, toEmail: email, error: err?.message || String(err)
    });
    emit('mailer.error', {
      worker: 'mailer',
      leadId: callRow.lead_id,
      callId: callRow.id,
      toEmail: email,
      error: err?.message || String(err),
      trigger: 'inbound_voice'
    });
    if (throwOnFailure) throw err;
    return null;
  }
}

// Test hook so we can clear the per-call cache between unit checks if ever needed.
export function _resetInboundIntentState() {
  sentByCallId.clear();
}
