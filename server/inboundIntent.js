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

// Per-call de-dupe — keyed by call row id. In-memory is fine; calls are short-lived.
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

/**
 * Called after each transcript update on an inbound call.
 * If we detect a valid email + a send intent, fire AgentMail (once per call).
 *
 * For email-callback calls (where Callan dialed the user because they emailed
 * us first), pass `overrideEmail` so we use the originating address without
 * needing the caller to dictate their email back to the agent.
 */
export async function maybeFireInboundEmail({ callRow, lead, transcript, overrideEmail = null }) {
  if (!callRow || sentByCallId.has(callRow.id)) return null;
  if (!env.agentmail?.apiKey || !env.agentmail?.inboxId) {
    log.warn('inbound.email.skipped', { callId: callRow.id, reason: 'agentmail_not_configured' });
    return null;
  }
  const email = overrideEmail || detectEmailInTranscript(transcript);
  if (!email) return null;
  const wantsEmail = detectSendEmailIntent(transcript);
  if (!wantsEmail) return null;

  // Mark BEFORE the await so concurrent transcript events don't double-fire.
  sentByCallId.add(callRow.id);

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

  if (useContextualInvoice) {
    try {
      const result = await sendCallbackInvoiceEmail({
        recipient: email,
        transcript,
        callId: callRow.id,
        leadId: callRow.lead_id || null
      });
      log.info('callback.invoice.sent', {
        callId: callRow.id, toEmail: email,
        businessName: result?.context?.businessName || null,
        path: callRow.decision_reason === 'agentphone_email_callback' ? 'email_callback' : 'inbound_invoice_intent'
      });
      return { email, ...result };
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
    const result = await sendAgentMailMessage({
      toEmail: email,
      subject,
      text,
      leadId: callRow.lead_id || null,
      costKind: 'inbound_followup'
    });
    log.info('inbound.email.sent', {
      callId: callRow.id,
      leadId: callRow.lead_id,
      toEmail: email,
      messageId: result?.messageId || null,
      threadId: result?.threadId || null
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
    return { email, ...result };
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
    return null;
  }
}

// Test hook so we can clear the per-call cache between unit checks if ever needed.
export function _resetInboundIntentState() {
  sentByCallId.clear();
}
