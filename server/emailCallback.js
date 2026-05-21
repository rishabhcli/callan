/**
 * Email → callback: if an inbound AgentMail says "call me" (with intent to
 * be called right now), parse the phone number, seed it into the allow-list,
 * and place an outbound call back within seconds.
 *
 * Flow:
 *   email arrives → /api/webhooks/agentmail
 *                 → handleAgentMailInbound (mailer.js)
 *                 → maybePlaceEmailCallback (this module, top of inbound handler)
 *                 → if intent + phone match: placeAgentPhoneCall with callback persona
 *
 * Phone resolution priority:
 *   1) E.164 / US-format phone in the email body
 *   2) Phone in the email subject line
 *   3) DEMO_CALLBACK_PHONE env var fallback (optional, for one-tap demos)
 *
 * The callback uses a per-call systemPrompt override on the existing AgentPhone
 * agent — so it doesn't disturb the agent's stored inbound / demo prompt config.
 */

import { env, seedAllowedPhone, canCallPhone } from './env.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { normalizePhone } from './compliance.js';
import { ensureAgentPhoneAgent, placeAgentPhoneCall } from './providers/agentphone.js';
import { calls, leads, db } from './db.js';
import { enqueueJob } from './jobs.js';
import { sendAgentMailMessage } from './providers/agentmail.js';
import { generateText } from './gemini.js';
import { buildIcs, nextWeekdayTen } from './workers/mailer.js';
import { stripeClient } from './providers/stripe.js';

export const EMAIL_CALLBACK_JOB_TYPE = 'email.callback_call';

/**
 * Map from providerCallId → { fromEmail, threadId, fromName, leadId }. Used by the
 * AgentPhone webhook handler to look up the originating email when transcript
 * intents (e.g. "send the invoice", "email me details") need a recipient.
 *
 * Without this, the webhook only knows the phone number it dialed, and the
 * "send email" intent path needs a transcript-mentioned address. The email
 * already gave us the address — preserve it across the placeCall boundary.
 */
const callbackContextByProviderCallId = new Map();
const CONTEXT_TTL_MS = 30 * 60 * 1000; // GC after 30 min — call is long-over by then

export function getCallbackContext(providerCallId) {
  if (!providerCallId) return null;
  const entry = callbackContextByProviderCallId.get(providerCallId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CONTEXT_TTL_MS) {
    callbackContextByProviderCallId.delete(providerCallId);
    return null;
  }
  return entry;
}

function setCallbackContext(providerCallId, data) {
  if (!providerCallId) return;
  callbackContextByProviderCallId.set(providerCallId, { ...data, ts: Date.now() });
  // Trim if grown too large.
  if (callbackContextByProviderCallId.size > 50) {
    const now = Date.now();
    for (const [k, v] of callbackContextByProviderCallId) {
      if (now - v.ts > CONTEXT_TTL_MS) callbackContextByProviderCallId.delete(k);
    }
  }
}

// Match "call me" / "give me a call" / "ring me" / "phone me" — verb forms only,
// not "missed call" or "call back" without "me".
const CALL_VERB_RX = /\b(?:call|ring|phone)\s+me\b/i;
const ALT_CALL_INTENT_RX = /\b(?:give\s+me\s+a\s+call|dial\s+me|call\s+me\s+back\s+now)\b/i;
// "don't call me", "do not call me", "stop calling me", "no more calls" — if any of
// these are present, treat as a refusal, not a request.
const CALL_NEGATION_RX = /\b(?:don'?t|do\s+not|stop|never|please\s+don'?t|no\s+more)\s+(?:call|ring|phone|calling|ringing|phoning)\s*(?:me)?\b/i;

// Per-call de-dupe — we don't want a thread's auto-reply triggering another callback.
const recentByEvent = new Map(); // eventId -> ts
const DEDUP_WINDOW_MS = 60 * 1000;

/** Match phone numbers — supports +1, parens, dots, dashes, spaces. */
const PHONE_RX = /(?:(?<!\d)\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})(?!\d)/g;

/**
 * Detect whether the email is asking us to call them right now.
 * We DON'T require an explicit "now" — most "call me" emails mean now.
 * If you explicitly schedule for later, the existing handleScheduleIntent
 * path will catch that first.
 */
export function detectCallMeNowIntent({ subject = '', text = '' } = {}) {
  const haystack = `${subject}\n${text}`.toLowerCase();
  if (CALL_NEGATION_RX.test(haystack)) {
    return { wantsCall: false, reason: 'negated' };
  }
  if (!CALL_VERB_RX.test(haystack) && !ALT_CALL_INTENT_RX.test(haystack)) {
    return { wantsCall: false };
  }
  // If the message is clearly scheduling a future call (mentions a specific day/time),
  // defer to the existing schedule handler instead.
  const hasFutureMarker = /\b(?:tomorrow|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+(?:an?\s+)?(?:hour|day|week)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(haystack);
  if (hasFutureMarker) return { wantsCall: false, deferToSchedule: true };
  return { wantsCall: true };
}

/** Pull the first plausible phone number out of `text`. Returns E.164 or null. */
export function extractPhoneFromText(text) {
  if (!text) return null;
  const matches = [...String(text).matchAll(PHONE_RX)];
  for (const m of matches) {
    const candidate = `+1${m[1]}${m[2]}${m[3]}`;
    const normalized = normalizePhone(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function callbackDedupKey({ msg = {}, eventId = null } = {}) {
  return eventId || `${msg.threadId || ''}:${msg.messageId || ''}`;
}

function clearRecentDedup(key) {
  if (key) recentByEvent.delete(key);
}

function resolveCallbackPhone(msg = {}) {
  const senderEmail = String(msg.fromEmail || '').toLowerCase();
  const senderPhone = senderEmail ? env.callbackPhoneByEmail?.[senderEmail] : null;
  return (
    (senderPhone && normalizePhone(senderPhone)) ||
    extractPhoneFromText(msg.text) ||
    extractPhoneFromText(msg.subject) ||
    normalizePhone(env.defaultCallbackPhone || process.env.DEMO_CALLBACK_PHONE || '')
  );
}

function compactCallbackMessage(msg = {}) {
  return {
    fromEmail: msg.fromEmail || null,
    fromName: msg.fromName || null,
    threadId: msg.threadId || null,
    messageId: msg.messageId || null,
    subject: msg.subject || null,
    text: msg.text || msg.preview || '',
    preview: msg.preview || null,
    eventType: msg.eventType || null,
    labels: Array.isArray(msg.labels) ? msg.labels.slice(0, 20) : []
  };
}

export function enqueueEmailCallbackJob({
  msg,
  eventId = null,
  source = 'agentmail.inbound',
  runAt = Date.now(),
  maxAttempts = 5,
  idempotencyKey = null
} = {}) {
  if (!msg) return { queued: false, reason: 'missing_message' };
  const intent = detectCallMeNowIntent({ subject: msg.subject, text: msg.text || msg.preview || '' });
  if (!intent.wantsCall) {
    return { queued: false, reason: intent.deferToSchedule ? 'defer_to_schedule' : (intent.reason || 'no_callback_intent') };
  }
  const resolvedPhone = resolveCallbackPhone(msg);
  if (!resolvedPhone) {
    log.warn('email_callback.no_phone', { fromEmail: msg.fromEmail, subject: msg.subject });
    emit('email_callback.no_phone', { fromEmail: msg.fromEmail, subject: msg.subject });
    return { queued: false, reason: 'no_phone' };
  }

  const stable = idempotencyKey || `email.callback:${callbackDedupKey({ msg, eventId }) || resolvedPhone}`;
  const result = enqueueJob({
    type: EMAIL_CALLBACK_JOB_TYPE,
    payload: {
      msg: compactCallbackMessage(msg),
      eventId: eventId || null,
      resolvedPhone,
      source
    },
    idempotencyKey: stable,
    runAt,
    maxAttempts
  });
  emit(result.inserted ? 'email_callback.queued' : 'email_callback.duplicate', {
    worker: 'caller',
    fromEmail: msg.fromEmail || null,
    threadId: msg.threadId || null,
    messageId: msg.messageId || null,
    eventId: eventId || null,
    toPhone: resolvedPhone,
    jobId: result.row?.id || null,
    status: result.row?.status || null,
    duplicate: !result.inserted,
    source
  });
  return { queued: true, inserted: result.inserted, row: result.row, toPhone: resolvedPhone };
}

export async function handleEmailCallbackJob(payload = {}, job = null, { callbackFn = maybePlaceEmailCallback } = {}) {
  const msg = payload.msg || {};
  const result = await callbackFn({
    msg,
    eventId: payload.eventId || job?.id || null,
    resolvedPhone: payload.resolvedPhone || null
  });
  if (result?.fired) {
    return {
      ok: true,
      fired: true,
      toPhone: result.toPhone || payload.resolvedPhone || null,
      callId: result.callId || null,
      providerCallId: result.providerCallId || null,
      leadId: result.leadId || null
    };
  }

  const reason = result?.reason || 'not_fired';
  if (['agent_resolve_failed', 'no_agent_id', 'place_failed'].includes(reason)) {
    const err = new Error(`email callback failed: ${reason}${result?.error ? `: ${result.error}` : ''}`);
    err.reason = reason;
    throw err;
  }
  return {
    ok: true,
    fired: false,
    skipped: true,
    reason,
    toPhone: result?.phone || payload.resolvedPhone || null
  };
}

function buildCallbackSystemPrompt({ fromEmail }) {
  return [
    'You are Callan, the live voice operator for callmemaybe (an agentic web agency that builds $500 same-day single-page websites for small businesses).',
    '',
    `The person you are calling just emailed our inbox a few seconds ago asking for a callback (from ${fromEmail || 'their email'}). You are returning their call within seconds of their email.`,
    '',
    'OPEN: warm and direct. Acknowledge that they emailed and asked you to call. Ask what is on their mind. Do not apologize for calling — they asked for this.',
    '',
    'STYLE:',
    '- One or two sentences per turn. Never three.',
    '- Listen first. React to what they actually say.',
    '- End every turn on a question or a clear next step.',
    '- No filler ("I would love to help you today!"). Be direct, human, useful.',
    '',
    'IF THEY ASK what callmemaybe does: we research small businesses, call them, and build a focused $500 same-day single-page website around ONE next action a visitor should take (book, call, get a quote). Built same day. If we do not ship, the call does not bill.',
    '',
    'IF THEY ASK who is this: "I am Callan, callmemaybe\'s AI voice operator. You emailed us about a minute ago asking for a call."',
    '',
    'IF THEY SAY "do not call", "remove me", "stop": "Got it, removing you. You will not hear from us again."',
    '',
    '*** SENDING EMAIL / INVOICE — YOU HAVE HANDS ***',
    `If they ask you to send anything to their email — an invoice, a follow-up, the details, the pitch, a Stripe link, a meeting time — say "Yep, I'll have that in your inbox in the next minute" and confirm. The system fires the real email automatically to ${fromEmail || 'the address they emailed from'} based on what you said you'd send. You do NOT need to ask them for their email address — we already have it from the email they sent us. Just promise it confidently and move on.`,
    '',
    'Stay warm, fast, and useful. Read back any phone numbers, emails, or dollar amounts they give you, digit by digit, before confirming.'
  ].join('\n');
}

function buildCallbackBeginMessage() {
  return 'Hey — it\'s Callan from callmemaybe. You just emailed me asking for a call. What\'s on your mind?';
}

/**
 * Top-level handler. Returns null if no callback fired, or
 * { fired: true, toPhone, callId, providerCallId } if one did.
 */
export async function maybePlaceEmailCallback({ msg, eventId, resolvedPhone = null }) {
  if (!msg) return null;
  const intent = detectCallMeNowIntent({ subject: msg.subject, text: msg.text });
  if (!intent.wantsCall) return null;

  // Dedupe — same webhook delivered twice, or a reply thread getting re-triggered.
  const dedupKey = callbackDedupKey({ msg, eventId });
  if (dedupKey) {
    const now = Date.now();
    const last = recentByEvent.get(dedupKey);
    if (last && now - last < DEDUP_WINDOW_MS) {
      log.info('email_callback.dedup_skip', { eventId: dedupKey });
      return null;
    }
    recentByEvent.set(dedupKey, now);
    for (const [k, t] of recentByEvent) {
      if (now - t > DEDUP_WINDOW_MS * 4) recentByEvent.delete(k);
    }
  }

  // Phone resolution priority:
  //   1) sender-keyed lookup (CALLBACK_PHONE_BY_EMAIL map)
  //   2) phone in the email body
  //   3) phone in the subject
  //   4) generic DEMO_CALLBACK_PHONE fallback
  const senderEmail = String(msg.fromEmail || '').toLowerCase();
  const phone = normalizePhone(resolvedPhone) || resolveCallbackPhone(msg);

  if (!phone) {
    log.warn('email_callback.no_phone', { fromEmail: msg.fromEmail, subject: msg.subject });
    emit('email_callback.no_phone', { fromEmail: msg.fromEmail, subject: msg.subject });
    return { fired: false, reason: 'no_phone' };
  }

  seedAllowedPhone(phone);
  if (!canCallPhone(phone)) {
    log.warn('email_callback.blocked', { phone, runMode: env.runMode });
    emit('email_callback.blocked', { phone, runMode: env.runMode });
    return { fired: false, reason: 'gate_blocked', phone };
  }

  let agent;
  try {
    agent = await ensureAgentPhoneAgent({});
  } catch (err) {
    clearRecentDedup(dedupKey);
    log.error('email_callback.agent_resolve_failed', { error: err?.message || String(err) });
    return { fired: false, reason: 'agent_resolve_failed' };
  }
  if (!agent?.id) {
    clearRecentDedup(dedupKey);
    log.error('email_callback.no_agent_id');
    return { fired: false, reason: 'no_agent_id' };
  }

  const systemPrompt = buildCallbackSystemPrompt({ fromEmail: msg.fromEmail });
  const beginMessage = buildCallbackBeginMessage();

  try {
    const placed = await placeAgentPhoneCall({
      agentId: agent.id,
      toNumber: phone,
      systemPrompt,
      initialGreeting: beginMessage,
      voice: env.agentphone.defaultVoice
    });

    // Persist the call as a tracked row so AgentPhone's terminal webhook can
    // find it and run transcript intent detection (otherwise call_missing →
    // no invoice ever fires).
    const callRow = persistCallbackCall({
      providerCallId: placed?.id,
      toPhone: phone,
      fromEmail: msg.fromEmail,
      subject: msg.subject
    });
    setCallbackContext(placed?.id, {
      fromEmail: senderEmail || msg.fromEmail,
      threadId: msg.threadId || null,
      subject: msg.subject || null,
      callId: callRow?.id || null,
      leadId: callRow?.lead_id || null
    });

    log.info('email_callback.placed', {
      fromEmail: msg.fromEmail,
      toPhone: phone,
      callId: placed?.id,
      callRowId: callRow?.id || null,
      threadId: msg.threadId
    });
    emit('email_callback.placed', {
      worker: 'caller',
      fromEmail: msg.fromEmail,
      toPhone: phone,
      callId: callRow?.id || placed?.id,
      providerCallId: placed?.id,
      leadId: callRow?.lead_id || null,
      threadId: msg.threadId,
      subject: msg.subject,
      direction: 'outbound'
    });
    return {
      fired: true,
      toPhone: phone,
      callId: callRow?.id || placed?.id,
      providerCallId: placed?.id,
      leadId: callRow?.lead_id || null
    };
  } catch (err) {
    clearRecentDedup(dedupKey);
    log.error('email_callback.place_failed', {
      fromEmail: msg.fromEmail,
      toPhone: phone,
      error: err?.message || String(err)
    });
    emit('email_callback.failed', {
      fromEmail: msg.fromEmail,
      toPhone: phone,
      error: err?.message || String(err)
    });
    return { fired: false, reason: 'place_failed', error: err?.message || String(err) };
  }
}

/**
 * Find or create a lead for the callback recipient and start a tracked calls
 * row. Mirrors `ensureInboundCallRow` in the AgentPhone webhook handler so
 * downstream transcript / intent / memory pipelines all light up.
 */
function persistCallbackCall({ providerCallId, toPhone, fromEmail, subject }) {
  if (!providerCallId || !toPhone) return null;

  // Already tracked? (Idempotent against double-fires.)
  const existing = db.prepare(`SELECT * FROM calls WHERE provider_call_id = ? ORDER BY started_at DESC LIMIT 1`).get(providerCallId);
  if (existing) return existing;

  // Find or create a lead keyed by phone.
  const normalizedPhone = normalizePhone(toPhone);
  let lead = null;
  try {
    lead = db.prepare(`
      SELECT * FROM leads
      WHERE normalized_phone = ? OR phone = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(normalizedPhone || toPhone, toPhone) || null;
  } catch (err) {
    log.warn('email_callback.lead_lookup_failed', { error: err?.message || String(err) });
  }

  if (!lead) {
    const leadId = `lead_callback_${Math.random().toString(36).slice(2, 10)}`;
    try {
      const ins = leads.insert({
        id: leadId,
        container_tag: `lead:${leadId}`,
        business_name: `Email callback ${fromEmail || normalizedPhone || toPhone}`,
        phone: toPhone,
        address: null,
        niche: 'email_callback',
        city: null,
        website: null,
        status: 'inbound',
        research_status: 'inbound',
        outreach_status: 'inbound',
        risk_status: 'inbound_unknown',
        consent_status: 'inbound',
        next_action: 'email_callback_in_progress',
        source_url: fromEmail ? `mailto:${fromEmail}` : null
      });
      lead = ins.lead;
    } catch (err) {
      log.error('email_callback.lead_create_failed', { error: err?.message || String(err), toPhone });
      return null;
    }
  }
  if (!lead) return null;

  const callId = `call_callback_${Math.random().toString(36).slice(2, 12)}`;
  try {
    calls.start({
      id: callId,
      lead_id: lead.id,
      to_phone: toPhone,
      provider_call_id: providerCallId,
      disclosure_text: null,
      decision_reason: 'agentphone_email_callback'
    });
  } catch (err) {
    log.error('email_callback.call_start_failed', { error: err?.message || String(err), providerCallId });
    return null;
  }

  emit('caller.placed', {
    worker: 'caller',
    leadId: lead.id,
    callId,
    providerCallId,
    direction: 'outbound',
    toPhone,
    fromEmail,
    subject,
    mock: false,
    source: 'email_callback'
  });

  return calls.get(callId);
}

/**
 * Pull the callmemaybe-relevant facts out of the actual transcript using
 * Gemini: business name, what they sell, location, the visitor action they
 * want, and 3 specific recap bullets referencing what was said. Returns
 * structured JSON or null if nothing useful could be extracted.
 */
export async function extractInvoiceContextFromTranscript({ transcript, leadId = null }) {
  const turns = (Array.isArray(transcript) ? transcript : []).filter((t) => t && t.text);
  if (!env.gemini?.apiKey || turns.length < 4) return null;
  const transcriptText = turns
    .map((t) => `${t.role === 'agent' ? 'Callan' : 'Caller'}: ${t.text}`)
    .join('\n');
  const prompt = [
    `You are Callan, callmemaybe's voice operator. You just got off the call below with a small-business owner and you are writing the invoice follow-up email. The owner wants to see RICH detail in the email — not a 3-bullet summary. Pull every concrete fact the caller actually said.`,
    ``,
    `Extract the following from the transcript (if not mentioned, use null):`,
    `- businessName: the business name they confirmed`,
    `- ownerFirstName: the owner's first name if they introduced themselves`,
    `- whatTheySell: a short phrase, what the business sells/does (be specific — products, sourcing, niche)`,
    `- city: city or neighborhood mentioned`,
    `- address: street address if confirmed`,
    `- displayPhone: phone number they want shown on the site, in pretty (415) 555-1212 format`,
    `- visitorAction: the single next-action the site is built around (book / call / get a quote / shop / order / etc.)`,
    `- meetingTime: any specific meeting day & time the caller agreed to ("Tuesday at 2 PM", "tomorrow 10am"), as a short string. Null if no time was locked.`,
    `- discussionPoints: array of 5–7 short bullets (~18 words each) of SPECIFIC things actually discussed on the call. Cover: who they are + what they sell, their current channels / gaps, the offer (price, scope, timing), any pain points, any commitments made by either side, and what they emphasized. Quote phrasing where helpful. Do NOT invent — only what was said.`,
    `- meetingAgenda: array of 3–5 short bullets of what to cover at the upcoming meeting (based on what they said they want). Concrete: "walk through wedding deposit form", "review draft of hero section", etc. Null if no meeting agenda is implied.`,
    `- callerQuote: ONE direct, short quote from the caller that captures the spirit of why they want this site (≤ 20 words, exact words from transcript). Null if no quote is strong enough.`,
    `- nextSteps: array of 2–3 short bullets describing what happens after they pay (e.g., "Stripe checkout → build kicks off → live link in your inbox within minutes").`,
    `- recapBullets: array of THREE short strings (~14 words each) — the 3 most important moments. (Backwards-compat with old email template.)`,
    ``,
    `Return ONLY a JSON object with those keys. No prose, no markdown fences.`,
    ``,
    `Transcript:`,
    transcriptText
  ].join('\n');
  try {
    const raw = await generateText({
      prompt,
      flash: true,
      thinkingLevel: 'minimal',
      leadId,
      kind: 'invoice_context_extract'
    });
    const cleaned = String(raw || '').trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '');
    const json = JSON.parse(cleaned);
    if (json && typeof json === 'object') return json;
  } catch (err) {
    log.warn('email_callback.invoice_extract_failed', { error: err?.message || String(err) });
  }
  return null;
}

/**
 * Build a transcript-aware invoice email body. If `context` (from
 * extractInvoiceContextFromTranscript) is present we use real call details;
 * otherwise the body falls back to a clean generic $500 invoice.
 */
export function buildCallbackInvoiceEmail({ recipient, context, stripeUrl }) {
  const checkoutUrl = stripeUrl || env.stripe?.successUrl || 'https://buy.callmemaybe.dev/website-500';
  const { start } = nextWeekdayTen();
  const meetingTime = start.toLocaleString('en-US', {
    weekday: 'long', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Los_Angeles', timeZoneName: 'short'
  });
  const business = context?.businessName?.trim();
  const ownerFirst = context?.ownerFirstName?.trim();
  const what = context?.whatTheySell?.trim();
  const city = context?.city?.trim();
  const addr = context?.address?.trim();
  const displayPhone = context?.displayPhone?.trim();
  const action = context?.visitorAction?.trim();
  const callerQuote = context?.callerQuote?.trim();
  const callerMeetingTime = context?.meetingTime?.trim();
  const finalMeetingTime = callerMeetingTime || meetingTime; // prefer what they actually agreed to on the call

  const discussionPoints = Array.isArray(context?.discussionPoints) && context.discussionPoints.length
    ? context.discussionPoints.filter((b) => typeof b === 'string' && b.trim()).slice(0, 7)
    : (Array.isArray(context?.recapBullets) ? context.recapBullets.filter((b) => typeof b === 'string' && b.trim()).slice(0, 5) : []);
  const meetingAgenda = Array.isArray(context?.meetingAgenda) && context.meetingAgenda.length
    ? context.meetingAgenda.filter((b) => typeof b === 'string' && b.trim()).slice(0, 5)
    : [];
  const nextSteps = Array.isArray(context?.nextSteps) && context.nextSteps.length
    ? context.nextSteps.filter((b) => typeof b === 'string' && b.trim()).slice(0, 3)
    : [
        'Pay the $500 Stripe Checkout below.',
        'Build kicks off the moment payment clears — you\'ll get a live Browser Use link to watch.',
        'Walkthrough call locked at the time below — reply to confirm.'
      ];

  const lineItem = business
    ? `One-page custom site for ${business}${what ? ` (${what})` : ''}`
    : 'One-page custom callmemaybe website';
  const subject = business
    ? `${business} — your callmemaybe invoice ($500) + meeting notes`
    : 'Your callmemaybe invoice — $500 + meeting notes';

  const greetName = ownerFirst || business || 'Hey';
  const intro = business
    ? `Good chat just now${ownerFirst ? `, ${ownerFirst}` : ''}. Below is the full recap from our call, your invoice, and what we'll cover at ${finalMeetingTime}.`
    : `Following up on our call. Below is the full recap, your invoice, and what we'll cover at ${finalMeetingTime}.`;

  const detailLines = [
    business ? `Business: ${business}` : null,
    ownerFirst ? `Owner: ${ownerFirst}` : null,
    what ? `What you sell: ${what}` : null,
    action ? `Site focused on: ${action}` : null,
    displayPhone ? `Phone to display on the site: ${displayPhone}` : null,
    [addr, city].filter(Boolean).join(', ') || null,
    finalMeetingTime ? `Walkthrough meeting: ${finalMeetingTime}` : null
  ].filter(Boolean);
  const detailsBlock = detailLines.length ? detailLines.map((l) => `  • ${l}`).join('\n') : '';

  const discussionBlock = discussionPoints.length
    ? '\nWhat we discussed on the call:\n' + discussionPoints.map((b) => `  • ${b.replace(/^\s*[•\-·]\s*/, '').trim()}`).join('\n') + '\n'
    : '';
  const agendaBlock = meetingAgenda.length
    ? `\nMeeting agenda — ${finalMeetingTime}:\n` + meetingAgenda.map((b) => `  • ${b.replace(/^\s*[•\-·]\s*/, '').trim()}`).join('\n') + '\n'
    : '';
  const quoteBlock = callerQuote
    ? `\nYou said: "${callerQuote.replace(/^"|"$/g, '')}"\nThat's what we're building toward.\n`
    : '';
  const nextStepsBlock = nextSteps.length
    ? '\nNext steps after you pay:\n' + nextSteps.map((b) => `  ${nextSteps.indexOf(b) + 1}. ${b.replace(/^\s*[•\-·\d.]\s*/, '').trim()}`).join('\n') + '\n'
    : '';

  const text = [
    business ? `${greetName} —` : 'Hey —',
    '',
    intro,
    '',
    detailsBlock || null,
    detailsBlock ? '' : null,
    discussionBlock || null,
    quoteBlock || null,
    agendaBlock || null,
    `${lineItem} — $500 flat. Mobile-first. Stripe Checkout wired up. Built same day. If we don't ship, the call doesn't bill — risk's on me.`,
    '',
    `Pay $500 on Stripe → ${checkoutUrl}`,
    `Walkthrough invite attached for ${finalMeetingTime}.`,
    nextStepsBlock || null,
    `Reply with anything you want changed on the brief and I'll fold it in before the build kicks off.`,
    '',
    `— Callan`,
    `callmemaybe · voice operator · reply to this thread anytime`
  ].filter((l) => l !== null).join('\n');

  const detailsHtml = detailLines.length
    ? `<table style="width:100%;border-collapse:collapse;margin:0 0 18px;font-size:13.5px;color:#444">${detailLines.map((l) => `<tr><td style="padding:4px 0">${escapeHtml(l)}</td></tr>`).join('')}</table>`
    : '';
  const discussionHtml = discussionPoints.length
    ? `<p style="margin:0 0 6px;font-size:14px;color:#1a1a1a"><strong>What we discussed on the call:</strong></p><ul style="padding-left:20px;margin:0 0 18px;font-size:13.5px;color:#444">${discussionPoints.map((b) => `<li style="margin:5px 0;line-height:1.5">${escapeHtml(b.replace(/^\s*[•\-·]\s*/, '').trim())}</li>`).join('')}</ul>`
    : '';
  const quoteHtml = callerQuote
    ? `<blockquote style="margin:0 0 18px;padding:10px 14px;background:#FBF4E0;border-left:3px solid #D8973C;border-radius:4px;font-size:14px;font-style:italic;color:#5a3a14">"${escapeHtml(callerQuote.replace(/^"|"$/g, ''))}" — that's what we're building toward.</blockquote>`
    : '';
  const agendaHtml = meetingAgenda.length
    ? `<p style="margin:0 0 6px;font-size:14px;color:#1a1a1a"><strong>Meeting agenda — ${escapeHtml(finalMeetingTime)}:</strong></p><ul style="padding-left:20px;margin:0 0 18px;font-size:13.5px;color:#444">${meetingAgenda.map((b) => `<li style="margin:5px 0;line-height:1.5">${escapeHtml(b.replace(/^\s*[•\-·]\s*/, '').trim())}</li>`).join('')}</ul>`
    : '';
  const nextStepsHtml = nextSteps.length
    ? `<p style="margin:0 0 6px;font-size:14px;color:#1a1a1a"><strong>Next steps after you pay:</strong></p><ol style="padding-left:20px;margin:0 0 18px;font-size:13.5px;color:#444">${nextSteps.map((b) => `<li style="margin:5px 0;line-height:1.5">${escapeHtml(b.replace(/^\s*[•\-·\d.]\s*/, '').trim())}</li>`).join('')}</ol>`
    : '';

  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:580px;color:#1a1a1a;line-height:1.55">',
    `<p style="margin:0 0 14px"><strong>${escapeHtml(greetName)}</strong> —</p>`,
    `<p style="margin:0 0 14px">${escapeHtml(intro)}</p>`,
    detailsHtml,
    discussionHtml,
    quoteHtml,
    agendaHtml,
    '<table style="width:100%;border-collapse:collapse;margin:0 0 18px;font-size:14px">',
    `<tr><td style="padding:10px 0;border-bottom:1px solid #eee">${escapeHtml(lineItem)}</td><td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right"><strong>$500</strong></td></tr>`,
    '<tr><td style="padding:10px 0"><em>Mobile-first · Stripe Checkout · same-day build · refund if we don\'t ship</em></td><td></td></tr>',
    '<tr><td style="padding:14px 0 0;border-top:2px solid #1a1a1a;font-weight:600">Total due today</td><td style="padding:14px 0 0;border-top:2px solid #1a1a1a;text-align:right;font-weight:600">$500.00</td></tr>',
    '</table>',
    `<p style="margin:0 0 18px"><a href="${escapeHtml(checkoutUrl)}" style="display:inline-block;padding:11px 20px;background:#AD2831;color:#F3E6BD;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Pay $500 on Stripe → start the build</a></p>`,
    `<p style="margin:0 0 6px;color:#666;font-size:13px">Direct link: <a href="${escapeHtml(checkoutUrl)}" style="color:#AD2831">${escapeHtml(checkoutUrl)}</a></p>`,
    `<p style="margin:14px 0">Walkthrough invite attached for <strong>${escapeHtml(finalMeetingTime)}</strong>.</p>`,
    nextStepsHtml,
    '<p style="margin:18px 0 0;padding:12px 14px;background:#FBF4E0;border-left:3px solid #D8973C;border-radius:4px;font-size:14px">Reply with anything you want changed on the brief and I\'ll fold it in before the build kicks off.</p>',
    '<p style="margin:22px 0 0">— Callan<br/><span style="color:#666;font-size:13px">callmemaybe · voice operator · reply to this thread anytime</span></p>',
    '</div>'
  ].join('\n');

  const ics = buildIcs({
    uid: `callmemaybe-invoice-${Date.now()}@callmemaybe.dev`,
    summary: `${business || 'Your business'} × callmemaybe — site walkthrough`,
    description: `30-minute walkthrough of your $500 same-day callmemaybe site${business ? ` for ${business}` : ''}. Callan.`,
    location: 'Google Meet — link sent on confirm',
    organizerEmail: env.agentmail?.inboxId || 'callan@agentmail.to',
    attendeeEmail: recipient,
    start, end: nextWeekdayTen().end
  });

  return {
    subject,
    text,
    html,
    attachments: [{
      filename: 'callmemaybe-walkthrough.ics',
      content: Buffer.from(ics, 'utf8').toString('base64'),
      contentType: 'text/calendar'
    }]
  };
}

/**
 * High-level: send a transcript-aware invoice to `recipient`. Used both by
 * the live email-callback flow (when Callan promises an invoice mid-call)
 * and by retroactive resends from operator tooling.
 */
export async function sendCallbackInvoiceEmail({ recipient, transcript, stripeUrl, callId, leadId = null }) {
  if (!recipient) throw new Error('sendCallbackInvoiceEmail requires recipient');
  const context = await extractInvoiceContextFromTranscript({ transcript, leadId }).catch((err) => {
    log.warn('email_callback.invoice_context_failed', { callId, error: err?.message || String(err) });
    return null;
  });

  // Enrich the lead with the Gemini-extracted context BEFORE minting checkout.
  // The Stripe webhook → recordPaidPayment → startBuilder → runBuilder path will
  // read lead.research_json + business_name + address + niche to build the brief.
  enrichLeadFromContext({ leadId, context, recipient });

  // Mint a fresh one-time Stripe Checkout Session carrying client_reference_id
  // + metadata.leadId, so the webhook can resolve which lead's build to kick
  // off when this customer pays. Replaces the old static Payment Link path
  // (which had no lead linkage and silently broke the post-payment flow).
  let checkoutUrl = stripeUrl || null;
  if (!checkoutUrl) {
    // Resolve a usable leadId: caller-supplied, or fall back to the call row's
    // lead_id. Operator-driven backfills sometimes forget to pass it; we don't
    // want to silently ship the placeholder URL.
    let resolvedLeadId = leadId;
    if (!resolvedLeadId && callId) {
      try {
        const { db } = await import('./db.js');
        const row = db.prepare('SELECT lead_id FROM calls WHERE provider_call_id = ? OR id = ? ORDER BY started_at DESC LIMIT 1').get(callId, callId);
        if (row?.lead_id) resolvedLeadId = row.lead_id;
      } catch { /* ignore — fall through */ }
    }
    if (resolvedLeadId) {
      checkoutUrl = await mintCheckoutSession({ leadId: resolvedLeadId, callId, recipient, context }).catch((err) => {
        log.warn('email_callback.checkout_mint_failed', { callId, leadId: resolvedLeadId, error: err?.message || String(err) });
        return null;
      });
    } else {
      log.warn('email_callback.no_lead_for_checkout', { callId, recipient, hint: 'pass leadId or use a callId tied to a calls row' });
    }
  }
  if (!checkoutUrl) {
    // Last-resort fallback. Should be unreachable in normal operation.
    log.warn('email_callback.using_placeholder_checkout_url', { callId, recipient });
    checkoutUrl = 'https://buy.callmemaybe.dev/website-500';
  }

  const payload = buildCallbackInvoiceEmail({ recipient, context, stripeUrl: checkoutUrl });
  try {
    const result = await sendAgentMailMessage({
      toEmail: recipient,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      attachments: payload.attachments,
      labels: ['invoice', 'callback_followup'],
      leadId,
      costKind: 'callback_invoice'
    });
    log.info('email_callback.invoice_sent', {
      callId,
      toEmail: recipient,
      messageId: result?.messageId || result?.providerId,
      threadId: result?.threadId,
      businessName: context?.businessName || null
    });
    emit('mailer.email_sent', {
      worker: 'mailer',
      callId,
      toEmail: recipient,
      subject: payload.subject,
      threadId: result?.threadId,
      messageId: result?.messageId,
      trigger: 'callback_invoice'
    });
    return {
      context,
      checkoutUrl,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      ...result
    };
  } catch (err) {
    log.error('email_callback.invoice_send_failed', {
      callId, toEmail: recipient, error: err?.message || String(err)
    });
    throw err;
  }
}

/**
 * Stuff the Gemini-extracted call context onto the lead so the post-payment
 * builder path (`buildWebsiteBrief` in fulfillment/hooks/brief.js) picks up
 * the real business name, services, CTA, and address instead of building a
 * generic brief from the placeholder "Email callback ..." business name.
 *
 * No-ops if leadId or context is missing — caller still gets to send an email
 * with a generic body.
 */
function enrichLeadFromContext({ leadId, context, recipient }) {
  if (!leadId || !context) return;
  try {
    const lead = leads.get(leadId);
    if (!lead) return;

    const businessName = (typeof context.businessName === 'string' && context.businessName.trim())
      || (lead.business_name && !String(lead.business_name).startsWith('Email callback')
            ? lead.business_name : null)
      || lead.business_name;
    const address = (typeof context.address === 'string' && context.address.trim()) || lead.address || null;
    const city = (typeof context.city === 'string' && context.city.trim()) || lead.city || null;
    const niche = inferNicheFromContext(context) || (lead.niche === 'email_callback' ? null : lead.niche) || 'email_callback';

    // Build a profile object the brief loader understands.
    const services = Array.isArray(context.services) && context.services.length
      ? context.services
      : [];
    const ctaText = typeof context.visitorAction === 'string' && context.visitorAction.trim()
      ? `${context.visitorAction.trim().replace(/\.$/, '')} today`
      : null;
    const profile = {
      businessName,
      whatTheyDo: context.whatTheySell || null,
      services,
      needs: [],
      customerPersona: null,
      city,
      address,
      phone: lead.phone || null,
      displayPhone: context.displayPhone || null,
      cta: ctaText,
      onlinePresenceSummary: context.whatTheySell || null,
      sourceUrl: recipient ? `mailto:${recipient}` : null
    };

    db.prepare(`
      UPDATE leads
         SET business_name = COALESCE(?, business_name),
             address = COALESCE(?, address),
             city = COALESCE(?, city),
             niche = COALESCE(?, niche),
             research_status = 'complete',
             research_json = ?,
             updated_at = ?
       WHERE id = ?
    `).run(
      businessName,
      address,
      city,
      niche,
      JSON.stringify(profile),
      Date.now(),
      leadId
    );
    log.info('email_callback.lead_enriched', { leadId, businessName, niche });
  } catch (err) {
    log.warn('email_callback.lead_enrich_failed', { leadId, error: err?.message || String(err) });
  }
}

function inferNicheFromContext(context) {
  const what = String(context?.whatTheySell || '').toLowerCase();
  if (/\b(cannabis|marijuana|weed|dispensary)\b/.test(what)) return 'cannabis';
  if (/\b(florist|flower)\b/.test(what)) return 'florist';
  if (/\b(restaurant|bakery|cafe|caterer|coffee|pizza)\b/.test(what)) return 'food_service';
  if (/\b(salon|barber|hair|spa)\b/.test(what)) return 'beauty';
  if (/\b(plumb|hvac|electric|roof|construction|contractor)\b/.test(what)) return 'home_services';
  if (/\b(law|legal|attorney)\b/.test(what)) return 'legal';
  if (/\b(dentist|doctor|medical|chiro)\b/.test(what)) return 'medical';
  return null;
}

/**
 * Create a one-time Stripe Checkout Session for the $500 callmemaybe build,
 * carrying client_reference_id + metadata.leadId. The Stripe webhook handler
 * in server/webhooks/stripe.js already resolves leadId from these fields, so
 * recordPaidPayment will mark the lead paid and trigger the builder.
 *
 * Uses the existing product/price `prod_UXL5sXKSTSrqfU` / `price_1TYGPR42nB81EBguVeZRTtGY`
 * minted in a prior turn; falls back to creating fresh ones if not found.
 */
async function mintCheckoutSession({ leadId, callId, recipient, context }) {
  const stripe = stripeClient();
  const price = await ensureWebsitePrice(stripe);
  const successUrl = env.stripe?.successUrl || 'http://localhost:8787/success';
  const cancelUrl = env.stripe?.cancelUrl || 'http://localhost:8787/cancel';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: price.id, quantity: 1 }],
    client_reference_id: leadId,
    customer_email: recipient || undefined,
    metadata: {
      leadId,
      callId: callId || '',
      source: 'email_callback',
      businessName: context?.businessName || ''
    },
    payment_intent_data: {
      metadata: {
        leadId,
        callId: callId || '',
        source: 'email_callback'
      }
    },
    success_url: successUrl,
    cancel_url: cancelUrl
  });
  log.info('email_callback.checkout_session_created', {
    leadId, callId,
    sessionId: session.id,
    url: session.url
  });
  return session.url;
}

let _cachedPriceId = null;
async function ensureWebsitePrice(stripe) {
  if (_cachedPriceId) {
    try { return await stripe.prices.retrieve(_cachedPriceId); } catch { _cachedPriceId = null; }
  }
  // Try a known existing price first (created in a prior turn).
  try {
    const p = await stripe.prices.retrieve('price_1TYGPR42nB81EBguVeZRTtGY');
    if (p && p.active) {
      _cachedPriceId = p.id;
      return p;
    }
  } catch { /* fall through to create */ }
  // Create fresh.
  const product = await stripe.products.create({
    name: 'callmemaybe Website ($500)',
    description: 'One-page custom callmemaybe website. Mobile-first. Same-day build.'
  });
  const price = await stripe.prices.create({ product: product.id, currency: 'usd', unit_amount: 50000 });
  _cachedPriceId = price.id;
  return price;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function _resetEmailCallbackState() {
  recentByEvent.clear();
  callbackContextByProviderCallId.clear();
}
