/**
 * Scheduled-calls service: customer-requested outbound callbacks driven by
 * email replies. A separate setInterval drains due rows so we don't contend
 * with the autonomous-outreach quota or its activeJob gate.
 */

import { log } from './logger.js';
import { emit } from './sse.js';
import { scheduledCalls } from './db.js';
import { enqueueJob } from './jobs.js';

const LOOP_INTERVAL_MS = 5_000;
const STUCK_THRESHOLD_MS = 60_000;
const WARMING_WINDOW_MS = 30_000;       // emit "incoming in <30s" once per row
const JOB_RETRY_BASE_DELAY_MS = 30_000;
const JOB_RETRY_MAX_DELAY_MS = 15 * 60 * 1000;
let timer = null;
let dispatcher = null;
const warmedIds = new Set();

export const SCHEDULED_CALL_JOB_TYPE = 'call.scheduled';

/**
 * Register the worker that actually places the call. Wired by server/index.js
 * so this module doesn't import the caller worker directly (avoids a cycle).
 * The dispatcher signature: `async (row) => { call_id?: string, failure?: string }`.
 */
export function registerScheduledCallDispatcher(fn) {
  dispatcher = fn;
}

export function createScheduledCall({ id, leadId, threadId, inboundMessageId, scheduledAtMs, brief }) {
  if (!id || !leadId || !Number.isFinite(scheduledAtMs)) {
    throw new Error('createScheduledCall requires id, leadId, and scheduledAtMs');
  }
  // If a pending row already exists for this lead, cancel it first so the unique
  // index doesn't fail us. Reply-replaces-prior semantics.
  const existing = scheduledCalls.findPendingForLead(leadId);
  if (existing) {
    scheduledCalls.cancel(existing.id, { reason: 'replaced_by_new_email_reply' });
    emit('scheduledCall.replaced', {
      worker: 'caller',
      leadId,
      replacedId: existing.id,
      newId: id,
      scheduledAtMs
    });
  }
  const row = scheduledCalls.start({ id, lead_id: leadId, thread_id: threadId, inbound_message_id: inboundMessageId, scheduled_at_ms: scheduledAtMs, brief });
  emit('scheduledCall.created', {
    worker: 'caller',
    id,
    leadId,
    threadId,
    scheduledAtMs,
    brief
  });
  return row;
}

export function cancelScheduledCall(id, { reason } = {}) {
  const row = scheduledCalls.cancel(id, { reason });
  if (row?.status === 'canceled') {
    emit('scheduledCall.canceled', {
      worker: 'caller',
      id,
      leadId: row.lead_id,
      reason: reason || null
    });
  }
  return row;
}

export function enqueueScheduledCallPlacement(rowOrId, {
  reason = 'scheduled_call_due',
  maxAttempts = 3
} = {}) {
  const row = typeof rowOrId === 'string' ? scheduledCalls.get(rowOrId) : rowOrId;
  if (!row?.id) throw new Error('enqueueScheduledCallPlacement requires a scheduled call row or id');
  return enqueueJob({
    type: SCHEDULED_CALL_JOB_TYPE,
    payload: {
      scheduledCallId: row.id,
      leadId: row.lead_id || null,
      attempt: Number(row.attempts) || 0,
      reason
    },
    idempotencyKey: `${SCHEDULED_CALL_JOB_TYPE}:${row.id}:${Number(row.attempts) || 0}`,
    maxAttempts
  });
}

function retryLeaseMs(job = null) {
  const attempts = Math.max(1, Number(job?.attempts || 1));
  const delay = Math.min(JOB_RETRY_MAX_DELAY_MS, JOB_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1)));
  return delay + STUCK_THRESHOLD_MS + 5_000;
}

function isFinalJobAttempt(job = null) {
  return Number(job?.attempts || 1) >= Number(job?.max_attempts || 1);
}

function errorMessage(err) {
  return err?.message || String(err);
}

export async function handleScheduledCallPlacementJob(payload = {}, job = null, { dispatcherFn = dispatcher } = {}) {
  const scheduledCallId = payload.scheduledCallId;
  if (!scheduledCallId) return { ok: false, skipped: true, reason: 'missing_scheduledCallId' };
  let row = scheduledCalls.get(scheduledCallId);
  if (!row) return { ok: false, skipped: true, reason: 'scheduled_call_not_found', scheduledCallId };
  if (row.status === 'pending') {
    scheduledCalls.markPlacing(row.id);
    row = scheduledCalls.get(row.id);
  }
  if (row.status !== 'placing') {
    return {
      ok: true,
      skipped: true,
      reason: `scheduled_call_${row.status}`,
      scheduledCallId,
      status: row.status
    };
  }

  scheduledCalls.touchPlacing(row.id, { leaseMs: retryLeaseMs(job) });
  try {
    if (!dispatcherFn) {
      const err = new Error('scheduled call dispatcher is not registered');
      err.retryable = true;
      throw err;
    }
    const result = await dispatcherFn(row);
    const callId = result?.call_id || result?.callId || null;
    if (callId) {
      scheduledCalls.markPlaced(row.id, { call_id: callId });
      emit('scheduledCall.placed', { worker: 'caller', id: row.id, leadId: row.lead_id, callId });
      return { ok: true, scheduledCallId, callId };
    }
    const reason = result?.failure || 'dispatcher_returned_no_call_id';
    scheduledCalls.markFailed(row.id, { reason });
    emit('scheduledCall.failed', { worker: 'caller', id: row.id, leadId: row.lead_id, reason });
    return { ok: false, scheduledCallId, failure: reason, terminal: true };
  } catch (err) {
    const reason = errorMessage(err);
    const retryable = err?.retryable !== false;
    const finalAttempt = isFinalJobAttempt(job);
    if (!retryable || finalAttempt) {
      scheduledCalls.markFailed(row.id, { reason });
      emit('scheduledCall.failed', {
        worker: 'caller',
        id: row.id,
        leadId: row.lead_id,
        reason,
        retryable,
        finalAttempt
      });
      return { ok: false, scheduledCallId, failure: reason, retryable, finalAttempt, terminal: true };
    }

    scheduledCalls.touchPlacing(row.id, { leaseMs: retryLeaseMs(job) });
    emit('scheduledCall.retry', {
      worker: 'caller',
      id: row.id,
      leadId: row.lead_id,
      reason,
      attempts: job?.attempts || null,
      maxAttempts: job?.max_attempts || null
    });
    throw err;
  }
}

/**
 * Emit `scheduledCall.warming` for any pending rows within WARMING_WINDOW_MS of
 * their scheduled time. Once per row. Lets the dashboard flash "incoming in 30s"
 * before the real fire so the operator can stop the call or take it over manually.
 */
export function warmDueScheduledCalls(now = Date.now()) {
  const upcoming = scheduledCalls.listPending({ limit: 25 }).filter((r) => {
    const delta = r.scheduled_at_ms - now;
    return delta <= WARMING_WINDOW_MS && delta > 0;
  });
  for (const row of upcoming) {
    if (warmedIds.has(row.id)) continue;
    warmedIds.add(row.id);
    emit('scheduledCall.warming', {
      worker: 'caller',
      id: row.id,
      leadId: row.lead_id,
      threadId: row.thread_id,
      scheduledAtMs: row.scheduled_at_ms,
      msUntilFire: Math.max(0, row.scheduled_at_ms - now)
    });
  }
  // Forget warmings older than 2 minutes so memory doesn't grow.
  if (warmedIds.size > 200) warmedIds.clear();
}

export async function drainDueScheduledCalls(now = Date.now()) {
  if (!dispatcher) return { drained: 0, skipped: 0, reason: 'no_dispatcher' };
  warmDueScheduledCalls(now);
  const due = scheduledCalls.listDue(now, { limit: 5 });
  let drained = 0;
  let skipped = 0;
  for (const row of due) {
    // CAS: only flip a still-pending row. If another tick beat us to it, skip.
    if (!scheduledCalls.markPlacing(row.id)) {
      skipped += 1;
      continue;
    }
    emit('scheduledCall.fired', {
      worker: 'caller',
      id: row.id,
      leadId: row.lead_id,
      threadId: row.thread_id,
      scheduledAtMs: row.scheduled_at_ms
    });
    try {
      const placing = scheduledCalls.get(row.id);
      const queued = enqueueScheduledCallPlacement(placing, { reason: 'scheduled_call_due' });
      emit('scheduledCall.job_queued', {
        worker: 'caller',
        id: row.id,
        leadId: row.lead_id,
        jobId: queued.row?.id || null,
        jobStatus: queued.row?.status || null,
        duplicate: !queued.inserted
      });
    } catch (err) {
      const reason = err?.message || String(err);
      scheduledCalls.markFailed(row.id, { reason });
      emit('scheduledCall.failed', { worker: 'caller', id: row.id, leadId: row.lead_id, reason });
      log.error('scheduledCall.enqueue_failed', { id: row.id, leadId: row.lead_id, error: reason });
    }
    drained += 1;
  }
  return { drained, skipped, considered: due.length };
}

/**
 * Operator override: flip a pending row's scheduled_at_ms to now so the loop
 * picks it up on the next tick. Returns the updated row or null when the row
 * doesn't exist / isn't pending.
 */
export function fireScheduledCallNow(id, { reason = 'operator_fire_now' } = {}) {
  const row = scheduledCalls.get(id);
  if (!row || row.status !== 'pending') return null;
  scheduledCalls.bringForward(id, Date.now());
  emit('scheduledCall.brought_forward', {
    worker: 'caller',
    id,
    leadId: row.lead_id,
    reason
  });
  return scheduledCalls.get(id);
}

export function startScheduledCallLoop() {
  if (timer) return { running: true, intervalMs: LOOP_INTERVAL_MS };
  // Crash recovery: sweep rows stuck in 'placing' back to 'pending'.
  const recovered = scheduledCalls.recoverStuck({ maxAgeMs: STUCK_THRESHOLD_MS });
  if (recovered > 0) log.info('scheduledCall.recovered_stuck', { count: recovered });
  timer = setInterval(() => {
    drainDueScheduledCalls().catch((err) => {
      log.error('scheduledCall.loop_error', { error: err?.message || String(err) });
    });
  }, LOOP_INTERVAL_MS);
  // First pass immediately on boot for anything already overdue.
  drainDueScheduledCalls().catch(() => {});
  emit('scheduledCall.loop_started', { intervalMs: LOOP_INTERVAL_MS });
  return { running: true, intervalMs: LOOP_INTERVAL_MS };
}

export function stopScheduledCallLoop() {
  if (timer) clearInterval(timer);
  timer = null;
  emit('scheduledCall.loop_stopped', {});
  return { running: false };
}
