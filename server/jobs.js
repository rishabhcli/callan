import { durableJobs } from './db.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { isRetryableOperationalError } from './operationalErrors.js';
import { runWithDurableJobContext } from './jobExecutionContext.js';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_HANDLER_TIMEOUT_MS = 15 * 60 * 1000;

let timer = null;
let active = 0;
let loopHandlers = {};

export function enqueueJob({
  type,
  payload = {},
  idempotencyKey = null,
  runAt = Date.now(),
  maxAttempts = 5
} = {}) {
  const result = durableJobs.enqueue({
    type,
    payload,
    idempotency_key: idempotencyKey || null,
    runAt,
    maxAttempts
  });
  emit(result.inserted ? 'job.enqueued' : 'job.duplicate', {
    worker: 'jobs',
    jobId: result.row?.id,
    type,
    status: result.row?.status,
    idempotent: !!idempotencyKey
  });
  return result;
}

export function startDurableJobLoop(handlers, {
  workerId = `callan-${process.pid}`,
  intervalMs = DEFAULT_INTERVAL_MS,
  concurrency = DEFAULT_CONCURRENCY,
  leaseMs = DEFAULT_LEASE_MS,
  handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS
} = {}) {
  loopHandlers = handlers || {};
  if (timer) return { running: true, workerId, intervalMs, concurrency };

  const recovered = durableJobs.recoverExpiredLeases({ limit: 100 });
  if (recovered) log.warn('jobs.recovered_expired_leases', { recovered });

  const tick = () => {
    drainDurableJobsOnce(loopHandlers, { workerId, concurrency, leaseMs, handlerTimeoutMs }).catch((err) => {
      log.error('jobs.loop_error', { error: err?.message || String(err) });
      emit('job.loop_error', { worker: 'jobs', error: err?.message || String(err) });
    });
  };
  timer = setInterval(tick, Math.max(250, intervalMs));
  tick();
  emit('job.loop_started', { worker: 'jobs', workerId, intervalMs, concurrency, leaseMs });
  return { running: true, workerId, intervalMs, concurrency, leaseMs };
}

export function stopDurableJobLoop() {
  if (timer) clearInterval(timer);
  timer = null;
  emit('job.loop_stopped', { worker: 'jobs' });
  return { running: false };
}

export async function drainDurableJobsOnce(handlers, {
  workerId = `callan-${process.pid}`,
  concurrency = DEFAULT_CONCURRENCY,
  leaseMs = DEFAULT_LEASE_MS,
  handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS,
  maxJobs = concurrency
} = {}) {
  const registered = handlers || {};
  let claimed = 0;
  const started = [];
  while (active < concurrency && claimed < maxJobs) {
    const job = durableJobs.claimNext({
      workerId,
      leaseMs,
      types: Object.keys(registered)
    });
    if (!job) break;
    claimed += 1;
    started.push(job.id);
    runJob(job, registered, { leaseMs, handlerTimeoutMs }).catch((err) => {
      log.error('jobs.run_detached_error', { jobId: job.id, type: job.type, error: err?.message || String(err) });
    });
  }
  return { claimed, active, started };
}

export function jobQueueHealth({ now = Date.now() } = {}) {
  const summary = durableJobs.summary({ now });
  return {
    ok: summary.staleRunning === 0,
    ...summary,
    running: active,
    loopRunning: !!timer,
    handlers: Object.keys(loopHandlers).sort()
  };
}

async function runJob(job, handlers, { leaseMs, handlerTimeoutMs }) {
  active += 1;
  emit('job.started', {
    worker: 'jobs',
    jobId: job.id,
    type: job.type,
    attempts: job.attempts,
    maxAttempts: job.max_attempts
  });
  const startedAt = Date.now();
  const controller = new AbortController();
  const heartbeatMs = Math.max(1_000, Math.min(30_000, Math.floor(leaseMs / 3)));
  const heartbeat = setInterval(() => {
    const renewed = durableJobs.renewLease(job.id, {
      workerId: job.locked_by,
      leaseGeneration: job.lease_generation,
      leaseMs
    });
    if (!renewed) controller.abort(new Error('durable job lease was lost'));
  }, heartbeatMs);
  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`No durable job handler registered for ${job.type}`);
    const result = await withHandlerTimeout(
      runWithDurableJobContext({ job, signal: controller.signal }, () => handler(job.payload || {}, job, {
          signal: controller.signal,
          fencingToken: `${job.id}:${job.lease_generation}`
        })),
      handlerTimeoutMs,
      controller
    );
    const completed = durableJobs.complete(job.id, {
      result: {
        ...(result && typeof result === 'object' ? result : { value: result ?? null }),
        durationMs: Date.now() - startedAt
      },
      workerId: job.locked_by,
      leaseGeneration: job.lease_generation
    });
    if (completed?.status !== 'completed' || completed?.lease_generation !== job.lease_generation) {
      log.warn('jobs.fenced_out', { jobId: job.id, type: job.type, phase: 'complete', leaseGeneration: job.lease_generation });
      emit('job.fenced_out', { worker: 'jobs', jobId: job.id, type: job.type, phase: 'complete' });
      return;
    }
    emit('job.completed', {
      worker: 'jobs',
      jobId: job.id,
      type: job.type,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    const retryable = isRetryableJobError(err);
    const row = durableJobs.fail(job.id, {
      error: err,
      retryable,
      workerId: job.locked_by,
      leaseGeneration: job.lease_generation
    });
    if (row?.status === 'running' || row?.lease_generation !== job.lease_generation) {
      log.warn('jobs.fenced_out', { jobId: job.id, type: job.type, phase: 'fail', leaseGeneration: job.lease_generation });
      emit('job.fenced_out', { worker: 'jobs', jobId: job.id, type: job.type, phase: 'fail' });
      return;
    }
    log.warn('jobs.failed', {
      jobId: job.id,
      type: job.type,
      status: row?.status,
      attempts: row?.attempts,
      retryable,
      error: err?.message || String(err)
    });
    emit('job.failed', {
      worker: 'jobs',
      jobId: job.id,
      type: job.type,
      status: row?.status,
      attempts: row?.attempts,
      retryable,
      error: err?.message || String(err)
    });
  } finally {
    clearInterval(heartbeat);
    controller.abort();
    active = Math.max(0, active - 1);
  }
}

async function withHandlerTimeout(value, timeoutMs, controller) {
  const ms = Math.max(1_000, Number(timeoutMs) || DEFAULT_HANDLER_TIMEOUT_MS);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`durable job handler timed out after ${ms}ms`);
          err.code = 'JOB_HANDLER_TIMEOUT';
          err.retryable = true;
          controller.abort(err);
          reject(err);
        }, ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isRetryableJobError(err) {
  return isRetryableOperationalError(err);
}
