/**
 * Scheduled-calls service: customer-requested outbound callbacks driven by
 * email replies. A separate setInterval drains due rows so we don't contend
 * with the autonomous-outreach quota or its activeJob gate.
 */

import { log } from './logger.js';
import { emit } from './sse.js';
import { scheduledCalls } from './db.js';

const LOOP_INTERVAL_MS = 5_000;
const STUCK_THRESHOLD_MS = 60_000;
const WARMING_WINDOW_MS = 30_000;       // emit "incoming in <30s" once per row
let timer = null;
let dispatcher = null;
const warmedIds = new Set();

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
    // Fire in the background so one slow call doesn't block other due rows.
    Promise.resolve()
      .then(() => dispatcher(row))
      .then((result) => {
        if (result?.call_id) {
          scheduledCalls.markPlaced(row.id, { call_id: result.call_id });
          emit('scheduledCall.placed', { worker: 'caller', id: row.id, leadId: row.lead_id, callId: result.call_id });
        } else {
          const reason = result?.failure || 'dispatcher_returned_no_call_id';
          scheduledCalls.markFailed(row.id, { reason });
          emit('scheduledCall.failed', { worker: 'caller', id: row.id, leadId: row.lead_id, reason });
        }
      })
      .catch((err) => {
        const reason = err?.message || String(err);
        scheduledCalls.markFailed(row.id, { reason });
        emit('scheduledCall.failed', { worker: 'caller', id: row.id, leadId: row.lead_id, reason });
        log.error('scheduledCall.dispatch_failed', { id: row.id, leadId: row.lead_id, error: reason });
      });
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
