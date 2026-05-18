/**
 * Demo Mode for the Callan inbound voice agent.
 *
 * When the inbound caller says the EXACT phrase "Enter Demo Mode" Callan
 * flips persona: he behaves as if he were placing an outbound cold call to
 * a specific SF flower business (Bloom & Petal Florist) and the human plays
 * the owner (Sarah Chen). The LLM handles the persona switch organically
 * because the demo-mode instructions are baked into the agent's permanent
 * system prompt (see scripts/configure-agent.js + buildDemoSystemPromptAddendum).
 *
 * This module is the single source of truth for:
 *   - the demo target profile (business + weakness list)
 *   - the trigger phrase + detector
 *   - the system-prompt addendum (consumed by configure-agent.js)
 *   - the end-of-demo follow-up email content (subject + body + .ics invite)
 *   - the per-call de-dup Set used by the webhook handler
 */

import { env } from './env.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { sendAgentMailMessage } from './providers/agentmail.js';
import { buildIcs, nextWeekdayTen } from './workers/mailer.js';
import { generateText } from './gemini.js';

export const DEMO_TARGET = Object.freeze({
  business: 'Bloom & Petal Florist',
  owner: 'Sarah Chen',
  address: '2547 Mission Street, San Francisco, CA 94110',
  neighborhood: 'Mission District',
  website: 'bloompetalflorist.com',
  instagram: '@bloompetalsf',
  weaknesses: Object.freeze([
    'Site loads in 4.2s on mobile — Google penalizes anything over 2.5s (Core Web Vitals).',
    'Ranks #23 on Google for "flower delivery San Francisco" while Farmgirl Flowers sits top-3.',
    '4.8★ on Yelp but only 47 reviews — Farmgirl has 1,200+; discovery is gated.',
    'No wedding or event landing pages — missing the $2K–$5K average-order channel.',
    'Instagram @bloompetalsf has 2.3K followers but no direct purchase path.',
    'Phone-orders only on the website — losing the after-work async-order rush every weekday.'
  ]),
  pitch: '$500 flat — one-page custom site, mobile-first, Stripe Checkout for wedding deposits, an "order today" CTA above the fold. Same-day build. If we don\'t ship, the call doesn\'t bill.'
});

export const DEMO_RECIPIENT_EMAIL = 'river.beach@icloud.com';

// The trigger is a HARD phrase — case-insensitive, but no synonyms.
const DEMO_TRIGGER_RX = /\benter\s+demo\s+mode\b/i;

// Per-call de-dup so the demo email fires at most once per call.
// Mirrors the sentByCallId pattern in inboundIntent.js.
const demoModeCallIds = new Set();

export function detectDemoModeTrigger(transcript) {
  if (!Array.isArray(transcript)) return false;
  const recent = transcript.slice(-12);
  for (const turn of recent) {
    if (!turn || (turn.role !== 'user' && turn.role !== 'caller' && turn.role !== 'human')) continue;
    if (DEMO_TRIGGER_RX.test(String(turn.text || ''))) return true;
  }
  return false;
}

export function isDemoModeCall(callId) {
  return !!callId && demoModeCallIds.has(callId);
}

export function clearDemoModeCall(callId) {
  if (callId) demoModeCallIds.delete(callId);
}

/**
 * Called from the webhook handler on every transcript update for an inbound call.
 * On the first detection of the trigger phrase, mark this call as demo-mode and
 * emit a dashboard event. Idempotent per call.
 */
export function maybeMarkDemoMode({ callRow, transcript }) {
  if (!callRow?.id || demoModeCallIds.has(callRow.id)) return false;
  if (!detectDemoModeTrigger(transcript)) return false;
  demoModeCallIds.add(callRow.id);
  emit('caller.demo_mode.entered', {
    worker: 'caller',
    leadId: callRow.lead_id,
    callId: callRow.id,
    providerCallId: callRow.provider_call_id,
    target: {
      business: DEMO_TARGET.business,
      owner: DEMO_TARGET.owner,
      neighborhood: DEMO_TARGET.neighborhood,
      website: DEMO_TARGET.website,
      weaknesses: DEMO_TARGET.weaknesses.slice(0, 3)
    }
  });
  log.info('inbound.demo_mode.entered', {
    callId: callRow.id,
    leadId: callRow.lead_id,
    target: DEMO_TARGET.business
  });
  return true;
}

/**
 * The block appended to Callan's permanent system prompt. Bakes the demo
 * persona switch into the LLM so the transition happens organically when
 * the LLM hears the trigger phrase — no mid-call prompt PATCH needed
 * (AgentPhone hosted mode locks the prompt at call setup).
 */
export function buildDemoSystemPromptAddendum() {
  const t = DEMO_TARGET;
  const first = t.owner.split(' ')[0];
  return [
    'DEMO MODE TRIGGER:',
    '',
    'If the caller says EXACTLY "Enter Demo Mode" (case-insensitive), flip',
    'persona instantly. You are now Callan from callmemaybe on an outbound',
    `cold call to ${t.business} (${t.neighborhood}, San Francisco). The person`,
    `on the line is ${t.owner}, the owner. Treat them as ${first} from your`,
    'very next word, for the rest of the call. Never reveal demo mode. Never',
    'break frame. Never say "demo mode" again after the opener.',
    '',
    '*** When you hear "Enter Demo Mode" — flip persona SILENTLY. Do NOT  ***',
    '*** acknowledge the phrase. Do NOT say "demo mode" or "got it." Do   ***',
    '*** NOT narrate the switch. Just pause for one beat (one ellipsis),  ***',
    '*** then BEGIN your cold call as if you just dialed her shop.        ***',
    '',
    'YOUR OPENER (entire first turn — say it, then SHUT UP and wait):',
    '',
    `"…${first}? Callan, callmemaybe. I was on your shop's site this morning`,
    '— you\'re bleeding weekend wedding orders. Got sixty seconds?"',
    '',
    `That is your ENTIRE first turn. After "sixty seconds?" you SHUT UP and`,
    `wait for ${first} to respond. Do NOT pre-empt. Do NOT list. Do NOT`,
    'pitch yet. Do NOT name a weakness yet. Just wait for her words.',
    '',
    'THE CONVERSATION:',
    `- React to what ${first} actually says. Real cold-call rhythm, not a`,
    '  monologue.',
    '- ONE or TWO sentences per turn. Never three. Then stop and let her',
    '  speak.',
    '- End each turn on a question or a sharp fact she has to react to.',
    '- Use her name occasionally — NOT every sentence. Once every couple of',
    '  turns, max. More than that sounds robotic.',
    '',
    `Research you have on ${t.business} — pull ONE point at a time when it`,
    `actually fits what ${first} just said. Never list more than one per turn,`,
    '  never dump them all:',
    ...t.weaknesses.map((w) => `  · ${w}`),
    '',
    'THE OFFER — only when she asks about cost or "what would you do":',
    `"${t.pitch}"`,
    '',
    'VOICE:',
    '- Closer who has done this 50 times today. Confident. Specific. Zero',
    '  hedging.',
    '- No "do you have a moment," no "sorry to bother you," no "I know',
    '  you\'re busy." You are not bothering her — you are saving her wedding',
    '  revenue.',
    '- React to her actual words. Do NOT preempt objections she hasn\'t made.',
    '- Push for a meeting every two or three turns once she\'s engaged:',
    `  "${first} — Tuesday 10 or Wednesday 2. Which one?"`,
    '',
    'OBJECTIONS — react in your own words when they come up, not preemptively:',
    '- "I already have a site" → her current site IS the problem; we replace,',
    '  we don\'t add.',
    `- "$500 is too much" → that's one centerpiece; she's losing centerpieces`,
    '  every Saturday she can\'t take deposits online.',
    '- "We\'re slammed" → that\'s exactly why; her site is dropping orders',
    '  right now.',
    '- "Send me info" → counter with the meeting: Tuesday 10 or Wednesday 2.',
    '',
    'ENDING THE CALL — only after a real back-and-forth has happened, when',
    `${first} has either booked, declined firmly, or the conversation has`,
    'run its course and you\'re ready to sign off: pause half a beat, then',
    'say EXACTLY this single sentence as the LAST thing before goodbye:',
    '',
    '"I sent the email."',
    '',
    `Then sign off naturally — "Talk Tuesday, ${first}." or similar.`,
    '',
    '*** CRITICAL: "I sent the email" is the LAST thing you say before    ***',
    '*** goodbye. NEVER say it in your opener. NEVER say it mid-call.     ***',
    '*** Only at the very end, after real conversation has happened.      ***',
    '',
    'The system fires the real follow-up in parallel based on what was',
    'actually discussed — you don\'t lift a finger.'
  ].join('\n');
}

/**
 * Ask Gemini for a personalized 3-line recap of what Callan flagged on the
 * actual call, based on the live transcript. Falls back to the top three
 * baked-in weaknesses if Gemini is unavailable or the call was too short
 * to recap meaningfully.
 */
export async function writeDemoRecap({ transcript, leadId = null }) {
  const t = DEMO_TARGET;
  const turns = (Array.isArray(transcript) ? transcript : []).filter((turn) => turn && turn.text);
  const fallback = t.weaknesses.slice(0, 3).map((w) => `• ${w}`).join('\n');
  if (!env.gemini?.apiKey || turns.length < 4) return fallback;
  const first = t.owner.split(' ')[0];
  const transcriptText = turns
    .map((turn) => {
      const speaker = turn.role === 'agent' ? 'Callan' : first;
      return `${speaker}: ${turn.text}`;
    })
    .join('\n');
  const prompt = [
    `You are Callan from callmemaybe writing a 3-bullet recap inside a follow-up email to ${t.owner}, owner of ${t.business} in ${t.neighborhood}, San Francisco.`,
    `You just got off a cold call with her. Pick the THREE most important things you actually said or that she actually pushed back on during the call.`,
    `Do NOT invent things that weren't discussed. Reference specific moments from the transcript — what she said, what you flagged.`,
    `Output JUST three bullets, one per line, each starting with "• ".`,
    `Each bullet: ~15 words. Tight, specific, conversational, no markdown beyond the bullet.`,
    `If the call was short or off-topic, fall back to these baseline points — pick the 3 most relevant:`,
    ...t.weaknesses.map((w) => `  - ${w}`),
    ``,
    `Transcript:`,
    transcriptText
  ].join('\n');
  try {
    const text = await generateText({
      prompt,
      flash: true,
      thinkingLevel: 'minimal',
      leadId,
      kind: 'demo_recap'
    });
    const cleaned = String(text || '').trim();
    if (cleaned.length > 30 && cleaned.includes('•')) return cleaned;
  } catch (err) {
    log.warn('demo.email.recap_fallback', { error: err?.message || String(err) });
  }
  return fallback;
}

/**
 * Build the polished pitch follow-up email that fires at the end of a demo
 * call. Mirrors the structure of the real callmemaybe invoice email:
 * pain-points recap → $500 value prop → mock Stripe checkout → meeting invite.
 *
 * The `recap` param should be the 3-bullet block produced by writeDemoRecap()
 * — it's what makes the email feel like a real follow-up to the actual
 * conversation rather than a canned template.
 */
export function buildDemoFollowupEmail({ recap } = {}) {
  const t = DEMO_TARGET;
  const recapText = (typeof recap === 'string' && recap.trim()) ? recap.trim() : t.weaknesses.slice(0, 3).map((w) => `• ${w}`).join('\n');
  const recapLines = recapText.split('\n').filter(Boolean);
  const checkoutUrl = 'https://buy.callmemaybe.dev/bloom-petal-500';
  const { start, end } = nextWeekdayTen();
  const organizerEmail = env.agentmail?.inboxId || 'callan@agentmail.to';
  const meetingSummary = `${t.business} × callmemaybe — site walkthrough`;
  const meetingDescription = `30-minute walkthrough of the $500 same-day site for ${t.business}. Callan from callmemaybe.`;
  const ics = buildIcs({
    uid: `callmemaybe-demo-${Date.now()}@callmemaybe.dev`,
    summary: meetingSummary,
    description: meetingDescription,
    location: 'Google Meet — link sent on confirm',
    organizerEmail,
    attendeeEmail: DEMO_RECIPIENT_EMAIL,
    start,
    end
  });
  const meetingTime = start.toLocaleString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short'
  });

  const first = t.owner.split(' ')[0];
  const subject = `Re: your shop's site — $500 fix, ${meetingTime.split(',')[0].toLowerCase()}`;

  const htmlBullets = recapLines
    .map((line) => line.replace(/^\s*[•\-·]\s*/, '').trim())
    .filter(Boolean)
    .map((s) => `<li style="margin:6px 0;line-height:1.5">${escapeHtml(s)}</li>`)
    .join('');

  const textLines = [
    `${first} —`,
    '',
    `Good chat just now. The three things I'd hit first, in order:`,
    '',
    ...recapLines.map((line) => `  ${line.trim()}`),
    '',
    `The fix: $500 flat. One-page custom site, mobile-first, Stripe Checkout wired for wedding deposits, "order today" button above the fold. Built same day. If we don't ship, the call doesn't bill — risk's on me.`,
    '',
    `Pay & kick it off → ${checkoutUrl}`,
    `Or grab the walkthrough I held: ${meetingTime} (invite attached).`,
    '',
    `P.S. Saturday's wedding order alone covers this twice over. I'd move on it before then.`,
    '',
    `— Callan`,
    `callmemaybe · voice operator`,
    `${t.website} · reply to this thread anytime`
  ];

  const html = [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;color:#1a1a1a;line-height:1.55">`,
    `<p style="margin:0 0 14px"><strong>${escapeHtml(first)}</strong> —</p>`,
    `<p style="margin:0 0 14px">Good chat just now. The three things I'd hit first, in order:</p>`,
    `<ul style="padding-left:20px;margin:0 0 18px">${htmlBullets}</ul>`,
    `<p style="margin:0 0 14px">The fix: <strong>$500 flat.</strong> One-page custom site, mobile-first, Stripe Checkout wired for wedding deposits, "order today" button above the fold. Built same day. If we don't ship, the call doesn't bill — risk's on me.</p>`,
    `<p style="margin:0 0 18px">`,
    `<a href="${escapeHtml(checkoutUrl)}" style="display:inline-block;padding:11px 20px;background:#AD2831;color:#F3E6BD;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Pay the $500 → start the build</a>`,
    `</p>`,
    `<p style="margin:0 0 14px">Or grab the walkthrough I held: <strong>${escapeHtml(meetingTime)}</strong> — invite attached. Accept and I'll send the Meet link.</p>`,
    `<p style="margin:18px 0 0;padding:12px 14px;background:#FBF4E0;border-left:3px solid #D8973C;border-radius:4px;font-size:14px"><strong>P.S.</strong> Saturday's wedding order alone covers this twice over. I'd move on it before then.</p>`,
    `<p style="margin:22px 0 0">— Callan<br/><span style="color:#666;font-size:13px">callmemaybe · voice operator<br/><a href="https://${escapeHtml(t.website)}" style="color:#AD2831;text-decoration:none">${escapeHtml(t.website)}</a> · reply to this thread anytime</span></p>`,
    `</div>`
  ].join('\n');

  const attachments = [{
    filename: 'callmemaybe-walkthrough.ics',
    content: Buffer.from(ics, 'utf8').toString('base64'),
    contentType: 'text/calendar'
  }];

  return { subject, text: textLines.join('\n'), html, attachments };
}

/**
 * Send the end-of-demo follow-up to river.beach@icloud.com. Goes through the
 * same canEmail() gate as any other send — caller must have set LIVE_EMAILS=true
 * and added river.beach@icloud.com to ALLOWED_TARGET_EMAILS.
 */
export async function fireDemoFollowupEmail({ callRow, transcript }) {
  if (!env.agentmail?.apiKey || !env.agentmail?.inboxId) {
    log.warn('demo.email.skipped', { callId: callRow?.id, reason: 'agentmail_not_configured' });
    return null;
  }
  const recap = await writeDemoRecap({ transcript, leadId: callRow?.lead_id || null }).catch((err) => {
    log.warn('demo.email.recap_failed', { callId: callRow?.id, error: err?.message || String(err) });
    return null;
  });
  const payload = buildDemoFollowupEmail({ recap });
  try {
    const result = await sendAgentMailMessage({
      toEmail: DEMO_RECIPIENT_EMAIL,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      attachments: payload.attachments,
      labels: ['demo_mode'],
      leadId: callRow?.lead_id || null,
      costKind: 'demo_followup'
    });
    log.info('demo.email.sent', {
      callId: callRow?.id,
      leadId: callRow?.lead_id,
      toEmail: DEMO_RECIPIENT_EMAIL,
      messageId: result?.messageId || null,
      threadId: result?.threadId || null
    });
    emit('mailer.email_sent', {
      worker: 'mailer',
      leadId: callRow?.lead_id,
      callId: callRow?.id,
      toEmail: DEMO_RECIPIENT_EMAIL,
      subject: payload.subject,
      threadId: result?.threadId,
      messageId: result?.messageId,
      trigger: 'demo_mode'
    });
    return { email: DEMO_RECIPIENT_EMAIL, ...result };
  } catch (err) {
    log.error('demo.email.send_failed', {
      callId: callRow?.id,
      toEmail: DEMO_RECIPIENT_EMAIL,
      error: err?.message || String(err)
    });
    emit('mailer.error', {
      worker: 'mailer',
      leadId: callRow?.lead_id,
      callId: callRow?.id,
      toEmail: DEMO_RECIPIENT_EMAIL,
      error: err?.message || String(err),
      trigger: 'demo_mode'
    });
    return null;
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Test hook to clear the per-call cache between unit checks.
export function _resetDemoModeState() {
  demoModeCallIds.clear();
}
