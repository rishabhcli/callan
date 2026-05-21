import { db, leads, leadCosts } from './db.js';
import { emit } from './sse.js';
import { log } from './logger.js';
import { callingWindowStatus, normalizePhone } from './compliance.js';
import { env } from './env.js';
import { sendAgentMailMessage } from './providers/agentmail.js';
import { generateText } from './gemini.js';
import { addDoc, containerTagFor } from './memory.js';
import { enqueueJob } from './jobs.js';

/**
 * Cadence ladder for unresponsive leads.
 * Ordered: call retry → email nudge → SMS → archive.
 * `attempt_count` (0-indexed) chooses which step is next.
 */
export const CADENCE_LADDER = Object.freeze([
  { channel: 'call_retry', delayMs: 45 * 60 * 1000 },
  { channel: 'email', delayMs: 4 * 60 * 60 * 1000 },
  { channel: 'sms', delayMs: 24 * 60 * 60 * 1000 },
  { channel: 'archive', delayMs: 5 * 24 * 60 * 60 * 1000 }
]);

const ARCHIVED_STATUS = 'archived';
const SKIP_OUTREACH_STATES = new Set([ARCHIVED_STATUS, 'blocked', 'blocked_visible']);

/**
 * Returns true if the lead has a usable email destination for the email step.
 * AgentMail threads are recorded on the lead, and analyst extracts emails into
 * contact_events / postMortem; the cheapest available proxy is the thread id
 * or a confirmed invoice_email contact event.
 */
function leadHasEmailDestination(leadId, lead) {
  if (!lead) return false;
  if (lead.agentmail_thread_id) return true;
  try {
    const row = db.prepare(`
      SELECT 1 FROM contact_events
      WHERE lead_id = ?
        AND channel = 'agentmail'
        AND (type = 'invoice_email' OR direction = 'inbound')
      LIMIT 1
    `).get(leadId);
    if (row) return true;
  } catch (err) {
    log.warn('cadence.email_lookup_failed', { leadId, error: err?.message || String(err) });
  }
  return false;
}

function leadEmailAddress(leadId) {
  try {
    const row = db.prepare(`
      SELECT metadata_json, body FROM contact_events
      WHERE lead_id = ?
        AND channel = 'agentmail'
        AND (direction = 'inbound' OR type = 'invoice_email')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(leadId);
    if (!row) return null;
    if (row.metadata_json) {
      try {
        const meta = JSON.parse(row.metadata_json);
        const email = meta?.toEmail || meta?.email || meta?.fromEmail || meta?.to || meta?.from;
        if (email && typeof email === 'string') return email;
      } catch {
        // fall through
      }
    }
    if (typeof row.body === 'string') {
      const match = row.body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (match) return match[0];
    }
  } catch (err) {
    log.warn('cadence.email_address_lookup_failed', { leadId, error: err?.message || String(err) });
  }
  return null;
}

function channelViable({ channel, lead, leadId }) {
  if (channel === 'call_retry') return Boolean(normalizePhone(lead?.phone));
  if (channel === 'sms') return Boolean(normalizePhone(lead?.phone));
  if (channel === 'email') return leadHasEmailDestination(leadId, lead);
  return true; // archive always viable
}

/**
 * Push a moment forward into the next allowed local-time call window
 * (defaults to 10:00 local) when it falls inside quiet hours.
 */
function shiftIntoCallingWindow(atMs, { timezone = env.outreach.timezone, openHour = 10 } = {}) {
  let cursor = new Date(atMs);
  // Guard: at most 8 day-shifts before bailing out (TZ misconfig).
  for (let i = 0; i < 8; i += 1) {
    const status = callingWindowStatus(cursor, { timezone });
    if (status.allowed) return cursor.getTime();
    // Compute "next 10am local". When status.localHour is null (invalid tz),
    // fall back to the original time — we still emit it so the operator can fix.
    const localHour = Number.isFinite(status.localHour) ? status.localHour : null;
    if (localHour === null) return cursor.getTime();
    let hoursToAdd;
    if (localHour < openHour) {
      hoursToAdd = openHour - localHour;
    } else {
      hoursToAdd = (24 - localHour) + openHour;
    }
    const localMinute = Number.isFinite(status.localMinute) ? status.localMinute : 0;
    const minutesToAdd = hoursToAdd * 60 - localMinute;
    cursor = new Date(cursor.getTime() + minutesToAdd * 60 * 1000);
  }
  return cursor.getTime();
}

/**
 * Plan the next cadence step for a lead given the current outcome.
 * Returns `{ nextAttemptAtMs, channel, stepIndex }` or null if archived.
 *
 * - Uses `lead.attempt_count` as the 0-indexed cursor of the LAST attempt.
 *   The next ladder step is `attempt_count` itself (we increment after firing).
 * - Skips steps whose channel is not viable on this lead (e.g. no phone for sms).
 */
export function planNextAttempt({ lead, outcome, now = Date.now() } = {}) {
  if (!lead) return null;
  if (SKIP_OUTREACH_STATES.has(lead.outreach_status)) return null;

  const startIndex = Math.max(0, Number(lead.attempt_count) || 0);
  for (let stepIndex = startIndex; stepIndex < CADENCE_LADDER.length; stepIndex += 1) {
    const step = CADENCE_LADDER[stepIndex];
    if (step.channel === 'archive') {
      const raw = now + step.delayMs;
      return { nextAttemptAtMs: raw, channel: step.channel, stepIndex, reason: outcome || null };
    }
    if (!channelViable({ channel: step.channel, lead, leadId: lead.id })) continue;
    const raw = now + step.delayMs;
    const shifted = shiftIntoCallingWindow(raw);
    return { nextAttemptAtMs: shifted, channel: step.channel, stepIndex, reason: outcome || null };
  }
  return null;
}

/**
 * Persist the next-attempt scheduling for a lead, increment attempt_count,
 * and emit a `cadence.scheduled` SSE event.
 *
 * Call this from runCaller's terminal failure path (or analyst) with the
 * outcome string (e.g. `failed:no_answer`).
 */
export function applyAttemptOutcome({ leadId, outcome, now = Date.now() } = {}) {
  if (!leadId) return null;
  const lead = leads.get(leadId);
  if (!lead) return null;

  const plan = planNextAttempt({ lead, outcome, now });
  if (!plan) {
    emit('cadence.exhausted', { leadId, businessName: lead.business_name, outcome });
    return null;
  }

  const nextAttemptCount = (Number(lead.attempt_count) || 0) + 1;
  leads.update(leadId, {
    next_attempt_at: plan.nextAttemptAtMs,
    attempt_channel: plan.channel,
    attempt_count: nextAttemptCount,
    next_action: 'cadence_retry'
  });

  emit('cadence.scheduled', {
    leadId,
    businessName: lead.business_name,
    channel: plan.channel,
    stepIndex: plan.stepIndex,
    attemptCount: nextAttemptCount,
    nextAttemptAt: plan.nextAttemptAtMs,
    outcome
  });
  return { ...plan, attemptCount: nextAttemptCount };
}

/**
 * Find leads whose cadence retry is due now.
 */
export function listDueCadenceLeads(now = Date.now()) {
  return db.prepare(`
    SELECT * FROM leads
    WHERE next_attempt_at IS NOT NULL
      AND next_attempt_at <= ?
      AND outreach_status NOT IN ('archived', 'blocked', 'blocked_visible')
    ORDER BY next_attempt_at ASC
  `).all(now);
}

/**
 * Clear cadence scheduling fields on a lead (call after firing the step).
 */
function clearCadenceSchedule(leadId, { keepCount = true } = {}) {
  const patch = { next_attempt_at: null, attempt_channel: null };
  if (!keepCount) patch.attempt_count = 0;
  leads.update(leadId, patch);
}

async function executeCallRetry({ leadId, lead }) {
  emit('cadence.executing', { leadId, channel: 'call_retry', businessName: lead.business_name });
  const result = enqueueJob({
    type: 'call.followup',
    payload: {
      leadId,
      toPhone: lead.phone || null,
      source: 'cadence_retry'
    },
    idempotencyKey: `call.followup:cadence:${leadId}:${lead.next_attempt_at || Date.now()}`,
    maxAttempts: 5
  });
  emit('cadence.call_retry_queued', {
    leadId,
    channel: 'call_retry',
    jobId: result.row?.id || null,
    jobStatus: result.row?.status || null,
    duplicate: !result.inserted
  });
  return { ok: true, fired: 'call.followup', jobId: result.row?.id || null, duplicate: !result.inserted };
}

async function executeEmailNudge({ leadId, lead }) {
  emit('cadence.executing', { leadId, channel: 'email', businessName: lead.business_name });
  const toEmail = leadEmailAddress(leadId);
  if (!toEmail) {
    emit('cadence.skipped', { leadId, channel: 'email', reason: 'no_email_address' });
    return { ok: false, reason: 'no_email_address' };
  }

  const businessName = lead.business_name || 'your business';
  const prompt = [
    `Write a SHORT (under 70 words) follow-up email nudge from callmemaybe to ${businessName}.`,
    `Context: we tried to reach them by phone and could not. We sell a flat-$500 single-page website built same-day.`,
    `Tone: warm, specific, no pressure. Plain text only. No subject line, no signature block, just the body.`,
    `Mention that we will try once more, but they can simply reply to this email to schedule a callback.`
  ].join('\n');

  let bodyText;
  try {
    bodyText = await generateText({
      prompt,
      systemInstruction: 'You write tight, human-sounding follow-up emails for a small-business sales team. No fluff.',
      thinkingLevel: 'low',
      flash: true,
      leadId,
      kind: 'cadence_email_text'
    });
  } catch (err) {
    log.warn('cadence.email.text_fallback', { leadId, error: err?.message || String(err) });
    bodyText = `Hi! This is callmemaybe — I tried to reach ${businessName} by phone and couldn't get through. ` +
      `We help small businesses get a clean single-page website live the same day for a flat $500. ` +
      `If now's a bad time, just reply to this email and we'll schedule a callback that works for you.`;
  }

  const subject = `Quick follow-up for ${businessName}`;
  try {
    const result = await sendAgentMailMessage({
      toEmail,
      subject,
      text: bodyText,
      leadId,
      costKind: 'cadence_nudge'
    });
    emit('cadence.email_sent', {
      leadId,
      channel: 'email',
      toEmail,
      messageId: result.messageId,
      threadId: result.threadId
    });
    return { ok: true, messageId: result.messageId, threadId: result.threadId };
  } catch (err) {
    log.warn('cadence.email.send_failed', { leadId, error: err?.message || String(err) });
    emit('cadence.email_failed', { leadId, channel: 'email', error: err?.message || String(err) });
    return { ok: false, reason: err?.message || String(err) };
  }
}

async function executeSmsNudge({ leadId, lead }) {
  emit('cadence.executing', { leadId, channel: 'sms', businessName: lead.business_name });
  const phone = normalizePhone(lead.phone);
  if (!phone) {
    emit('cadence.skipped', { leadId, channel: 'sms', reason: 'no_phone' });
    return { ok: false, reason: 'no_phone' };
  }

  // AgentPhone SDK exposes messages.sendMessage, but it requires an agent_id and
  // a messaging-enabled number; our hosted caller agent has enableMessaging=false.
  // Per spec, fake the send: emit SSE, record a $0.01 cost, and write a mail_thread doc.
  const businessName = lead.business_name || 'your business';
  const body = `Hi! This is callmemaybe — I left you a voicemail about a $500 same-day website for ${businessName}. ` +
    `Reply YES to schedule a callback, or STOP to opt out.`;

  const fakeMessageId = `sms-fake-${Date.now().toString(36)}`;
  emit('caller.sms_attempt', {
    worker: 'caller',
    leadId,
    channel: 'sms',
    toPhone: phone,
    body,
    messageId: fakeMessageId,
    mock: true,
    note: 'agentphone SMS not wired; recorded as fake $0.01 send'
  });

  try {
    leadCosts.record({
      id: `cost_sms_${fakeMessageId}`,
      lead_id: leadId,
      provider: 'agentphone',
      kind: 'sms',
      usd: 0.01,
      units: 1,
      unit_label: 'message',
      metadata: { mock: true, messageId: fakeMessageId, phone }
    });
  } catch (err) {
    log.warn('cadence.sms.cost_record_failed', { leadId, error: err?.message || String(err) });
  }

  try {
    await addDoc(containerTagFor(leadId), 'mail_thread', { channel: 'sms', body, toPhone: phone }, {
      kind: 'sms_nudge',
      messageId: fakeMessageId,
      mock: true
    });
  } catch (err) {
    log.warn('cadence.sms.memory_failed', { leadId, error: err?.message || String(err) });
  }

  return { ok: true, messageId: fakeMessageId, mock: true };
}

function executeArchive({ leadId, lead }) {
  emit('cadence.executing', { leadId, channel: 'archive', businessName: lead.business_name });
  leads.update(leadId, {
    outreach_status: ARCHIVED_STATUS,
    next_action: null,
    risk_status: lead.risk_status || 'cadence_exhausted'
  });
  emit('cadence.archived', { leadId, businessName: lead.business_name });
  return { ok: true, archived: true };
}

/**
 * Fire the channel action for a lead whose `next_attempt_at` is due.
 * Returns `{ ok, result }` for diagnostics. Always clears the schedule
 * before returning (so we don't loop on the same row).
 */
export async function executeDueChannel({ leadId, channel } = {}) {
  if (!leadId) return { ok: false, reason: 'missing_leadId' };
  const lead = leads.get(leadId);
  if (!lead) return { ok: false, reason: 'lead_not_found' };

  const chosenChannel = channel || lead.attempt_channel;
  if (!chosenChannel) {
    clearCadenceSchedule(leadId);
    return { ok: false, reason: 'no_channel' };
  }

  try {
    let result;
    if (chosenChannel === 'call_retry') {
      result = await executeCallRetry({ leadId, lead });
    } else if (chosenChannel === 'email') {
      result = await executeEmailNudge({ leadId, lead });
    } else if (chosenChannel === 'sms') {
      result = await executeSmsNudge({ leadId, lead });
    } else if (chosenChannel === 'archive') {
      result = executeArchive({ leadId, lead });
    } else {
      result = { ok: false, reason: `unknown_channel:${chosenChannel}` };
    }
    return { ok: result.ok !== false, channel: chosenChannel, result };
  } catch (err) {
    log.error('cadence.execute_failed', { leadId, channel: chosenChannel, error: err?.message || String(err) });
    emit('cadence.execute_failed', { leadId, channel: chosenChannel, error: err?.message || String(err) });
    return { ok: false, reason: err?.message || String(err) };
  } finally {
    if (chosenChannel !== 'archive') clearCadenceSchedule(leadId);
  }
}
