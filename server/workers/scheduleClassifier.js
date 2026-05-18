/**
 * Decide whether an inbound email reply is asking us to schedule a callback,
 * and if so when. Powered by Gemini with the ScheduleCallDecision schema.
 *
 * Only invoke when the deterministic classifier already routed scope='scheduling' —
 * we don't want to double Gemini latency on every reply.
 */

import { env } from '../env.js';
import { log } from '../logger.js';
import { generateStructured } from '../reasoning/geminiReasoner.js';
import { ScheduleCallDecision } from '../reasoning/schemas.js';

const FALLBACK_TIMEZONE = 'America/Los_Angeles';

function buildPrompt({ timezone }) {
  return [
    `Classify an inbound email reply from a small-business owner who got an automated voice followup from Callan.`,
    `If they ask for a callback, extract WHEN and WHAT they want to discuss.`,
    ``,
    `Rules:`,
    `- wantsCall = true only when the reply explicitly asks us to call (e.g., "call me at 5pm", "let's schedule a call today", "give me a ring tomorrow").`,
    `- isCancel = true only when they say to cancel/abort a previously scheduled call.`,
    `- scheduledAtIso must be a real ISO-8601 timestamp WITH explicit timezone offset. If the customer named a relative time, resolve it against the timezone hint ${timezone} and the current server time the prompt provides.`,
    `- If the time is past, ambiguous, or missing, set scheduledAtIso=null and put the verbatim phrase in scheduledAtRaw.`,
    `- ask: one sentence, plain language ("wants pricing details on the build", "questions about timeline", "wants demo").`,
    `- Avoid extra prose in fields. Concise English only.`,
    ``,
    `Output the full ScheduleCallDecision JSON. Reference evidence quotes briefly.`
  ].join('\n');
}

/**
 * @param {object} args
 * @param {object|null} args.lead         lead row (for context only)
 * @param {string} args.subject           inbound email subject
 * @param {string} args.replyText         inbound email body
 * @param {string|null} args.threadId
 * @param {string|null} args.eventId      idempotency hint for the reasoning trace
 * @param {boolean} args.forceMock        run in synthetic mode (tests)
 */
export async function classifyScheduleRequest({
  lead = null,
  subject = '',
  replyText = '',
  threadId = null,
  eventId = null,
  forceMock = false
} = {}) {
  if (!replyText || !replyText.trim()) {
    return mockDecision({ wantsCall: false, reason: 'empty reply' });
  }

  const timezone = env.outreach?.timezone || FALLBACK_TIMEZONE;
  const nowIso = new Date().toISOString();

  const evidence = {
    nowIso,
    timezone,
    leadCity: lead?.city || null,
    leadName: lead?.business_name || null,
    subject: subject || '',
    text: replyText.slice(0, 4000),
    threadId
  };

  const prompt = buildPrompt({ timezone });

  try {
    const { output } = await generateStructured({
      kind: 'scheduleCallDecision',
      schema: ScheduleCallDecision,
      evidence,
      prompt,
      leadId: lead?.id || null,
      worker: 'mailer',
      eventId: eventId || threadId || null,
      flash: true,
      thinkingLevel: 'medium',
      forceMock: forceMock || !env.gemini?.apiKey
    });
    return finalize(output, { timezone });
  } catch (err) {
    log.warn('schedule.classifier.fallback', { error: err?.message || String(err), threadId });
    return finalize(fallbackHeuristic(replyText, { timezone }), { timezone });
  }
}

function finalize(decision, { timezone }) {
  const out = {
    wantsCall: !!decision?.wantsCall,
    isCancel: !!decision?.isCancel,
    scheduledAtIso: decision?.scheduledAtIso ?? null,
    scheduledAtMs: null,
    scheduledAtRaw: decision?.scheduledAtRaw || '',
    ask: decision?.ask || '',
    reason: decision?.reason || '',
    confidence: typeof decision?.confidence === 'number' ? decision.confidence : 0,
    timezone
  };
  if (out.scheduledAtIso) {
    const ms = Date.parse(out.scheduledAtIso);
    if (Number.isFinite(ms)) out.scheduledAtMs = ms;
    else out.scheduledAtIso = null;
  }
  return out;
}

/**
 * Best-effort regex fallback when Gemini is unavailable or fails. Handles a small
 * set of common phrasings: "call me [today|tomorrow] at HH(:MM)? am|pm".
 */
function fallbackHeuristic(text, { timezone }) {
  const isCancel = /\b(cancel|abort|never mind|nevermind|forget it)\b.*\bcall\b/i.test(text)
                || /\bcancel the (call|callback)\b/i.test(text);

  const wantsCall = /\b(call me|schedule a call|give me a (?:call|ring)|hop on a call|let'?s (?:get on|hop on) a call)\b/i.test(text);

  const timeMatch = text.match(/\b(today|tomorrow|tonight)?\b[^.]{0,30}?\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);

  let scheduledAtIso = null;
  let scheduledAtRaw = '';
  if (timeMatch && wantsCall) {
    const dayWord = (timeMatch[1] || 'today').toLowerCase();
    let hour = Number(timeMatch[2]);
    const min = Number(timeMatch[3] || '0');
    const mer = (timeMatch[4] || '').toLowerCase();
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;

    const now = new Date();
    const offsetHours = computeOffsetHours(timezone, now);
    const utc = new Date(now.toISOString());
    if (dayWord === 'tomorrow') utc.setUTCDate(utc.getUTCDate() + 1);
    utc.setUTCHours(hour - offsetHours, min, 0, 0);
    scheduledAtIso = utc.toISOString();
    scheduledAtRaw = timeMatch[0];
  }

  return {
    wantsCall,
    isCancel,
    scheduledAtIso,
    scheduledAtRaw,
    ask: '',
    reason: 'heuristic fallback',
    confidence: wantsCall && scheduledAtIso ? 0.55 : 0.2,
    sourceEvidence: []
  };
}

function computeOffsetHours(timezone, date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false, hour: '2-digit'
    });
    const localHour = Number(fmt.format(date));
    const utcHour = date.getUTCHours();
    let diff = localHour - utcHour;
    if (diff > 12) diff -= 24;
    if (diff < -12) diff += 24;
    return diff;
  } catch {
    return -8; // PT fallback
  }
}

function mockDecision(partial = {}) {
  return finalize({
    wantsCall: false,
    isCancel: false,
    scheduledAtIso: null,
    scheduledAtRaw: '',
    ask: '',
    reason: '',
    confidence: 0,
    ...partial
  }, { timezone: env.outreach?.timezone || FALLBACK_TIMEZONE });
}
