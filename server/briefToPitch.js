/**
 * Build a pitch-shaped object for a scheduled callback (outbound).
 *
 * The existing `pitchToSystemPrompt` in `server/workers/caller.js` reads a fixed set
 * of fields off a pitch and renders them into Callan's per-call system prompt.
 * For scheduled callbacks we don't want to run Gemini to "generate" a pitch — we
 * already know what the customer asked for. We seed all the boilerplate
 * (objections, close, emailAsk, readback, invoiceClose) from `createFallbackPitch`
 * and override only the four context-bearing fields:
 *
 *   - openingLine        — "Hey <name>, calling for our <time> chat about <ask>"
 *   - valueProp          — reframed around the ask
 *   - discoveryQuestions — three questions that loop in the actual context
 *   - beginMessage       — disclosure-first scheduled-call opener
 */

import { createFallbackPitch } from './pitch.js';
import { recordingDisclosure } from './compliance.js';

function firstName(name) {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  return parts[0] || null;
}

function friendlyTime(scheduledAtMs, timezone = 'America/Los_Angeles') {
  if (!scheduledAtMs) return 'our scheduled chat';
  try {
    const dt = new Date(scheduledAtMs);
    return dt.toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
      timeZoneName: 'short'
    });
  } catch {
    return 'our scheduled chat';
  }
}

function trim(value, max = 160) {
  if (!value) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trim()}…` : s;
}

/**
 * @param {object} brief
 * @param {string|null} brief.callerName        first or full name we have for the lead
 * @param {string|null} brief.business          business they own (if known)
 * @param {string|null} brief.ask               what they asked for in the email reply
 * @param {string|null} brief.emailExcerpt      the verbatim ask, used as context
 * @param {string|null} brief.priorCallSummary  prior call_analysis snippet from Supermemory
 * @param {string|null} brief.scheduledAtRaw    raw user-spoken time ("today at 5:14pm")
 * @param {number|null} brief.scheduledAtMs     epoch ms
 * @param {string|null} brief.fromPhone         number they're calling from
 * @param {string|null} brief.timezone          tz string (defaults to env)
 * @param {object}      ctx
 * @param {object}      ctx.lead                lead row (for createFallbackPitch)
 * @param {object}      ctx.profile             profile (for createFallbackPitch)
 */
export function briefToPitch(brief = {}, { lead = {}, profile = {} } = {}) {
  const disclosure = recordingDisclosure(lead.business_name || brief.business || 'this business');
  const base = createFallbackPitch({ disclosure, profile, lead });

  const name = firstName(brief.callerName) || firstName(lead.business_name) || 'there';
  const business = trim(brief.business || lead.business_name || '', 80);
  const ask = trim(brief.ask || 'what you asked about in your email', 140);
  const when = friendlyTime(brief.scheduledAtMs, brief.timezone);

  // The customer ASKED for this call. Open like a warm callback, not a cold pitch.
  const openingLine = business
    ? `Hey ${name} — Callan from callmemaybe, calling ${business} like you asked. Wanted to dig into ${ask}.`
    : `Hey ${name} — Callan from callmemaybe, calling like you asked. Wanted to dig into ${ask}.`;

  const priorBeat = brief.priorCallSummary
    ? `From our last conversation: ${trim(brief.priorCallSummary, 200)}.`
    : '';

  // valueProp is shorter here — the customer already knows what we do. Reinforce briefly.
  const valueProp = priorBeat
    ? `${priorBeat} You wanted a callback about ${ask}, so I'm here to actually answer that and figure out the next step.`
    : `You wanted a callback about ${ask}, so I'm here to actually answer that and figure out the next step. Quick reminder of what we offer: a focused $500 same-day website built around one clear next-action for your customers.`;

  // Discovery questions for a warm callback — pull on the ask, the prior context,
  // and what would make this concrete. NOT cold-call discovery.
  const discoveryQuestions = [
    `On ${ask} — what would be a good answer to walk away from this call with?`,
    `Has anything changed on your end since you emailed me?`,
    `If we ship this site today, what's the ONE thing a brand-new visitor should do when they land on the page?`
  ];

  // Objections tailored to a warm callback. The customer asked for this call —
  // they're not going to say "is this a scam"; they might say "I'm short on time"
  // or "I changed my mind" or "remind me what we said."
  const objections = [
    {
      objection: "I'm short on time.",
      response: `Totally fair — I'll keep it to two minutes. Just on ${ask}: I have the info I need to send a final answer by email if it's easier. Tell me what works.`
    },
    {
      objection: "Remind me what we talked about?",
      response: priorBeat
        ? `Sure — last time the main thread was ${trim(brief.priorCallSummary, 140)}. You wanted me to follow up on ${ask}.`
        : `Sure — you asked us to follow up about ${ask}. Want me to start there or somewhere else?`
    },
    {
      objection: "I changed my mind.",
      response: `No problem. I can take you off our list now and you won't hear from us again. Want me to do that, or hold off in case it's useful later?`
    },
    {
      objection: "Can you send it in writing instead?",
      response: `Yeah, I can drop the answer to ${ask} in AgentMail right now and end the call. Tell me your best email if it's different from before.`
    }
  ];

  // Close acknowledges they invited the call. No need for the cold-close "if this sounds useful."
  const close = `If you're good to move on ${ask}, I can send the $500 invoice from AgentMail and the build kicks off the moment it's paid. Otherwise I'll send a written recap and you decide later.`;

  const beginMessage = `${disclosure} Hey ${name} — calling like you asked, about ${ask}.`;

  return {
    ...base,
    openingLine,
    valueProp,
    discoveryQuestions,
    objections,
    close,
    beginMessage
  };
}
