import { durableJobs } from './db.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { isRetryableOperationalError } from './operationalErrors.js';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_CONCURRENCY = 2;

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
  leaseMs = DEFAULT_LEASE_MS
} = {}) {
  loopHandlers = handlers || {};
  if (timer) return { running: true, workerId, intervalMs, concurrency };

  const recovered = durableJobs.recoverExpiredLeases({ limit: 100 });
  if (recovered) log.warn('jobs.recovered_expired_leases', { recovered });

  const tick = () => {
    drainDurableJobsOnce(loopHandlers, { workerId, concurrency, leaseMs }).catch((err) => {
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
    runJob(job, registered).catch((err) => {
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

async function runJob(job, handlers) {
  active += 1;
  emit('job.started', {
    worker: 'jobs',
    jobId: job.id,
    type: job.type,
    attempts: job.attempts,
    maxAttempts: job.max_attempts
  });
  const startedAt = Date.now();
  try {
    const handler = handlers[job.type];
    if (!handler) throw new Error(`No durable job handler registered for ${job.type}`);
    const result = await handler(job.payload || {}, job);
    durableJobs.complete(job.id, {
      result: {
        ...(result && typeof result === 'object' ? result : { value: result ?? null }),
        durationMs: Date.now() - startedAt
      }
    });
    emit('job.completed', {
      worker: 'jobs',
      jobId: job.id,
      type: job.type,
      durationMs: Date.now() - startedAt
    });
  } catch (err) {
    const retryable = isRetryableJobError(err);
    const row = durableJobs.fail(job.id, { error: err, retryable });
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
    active = Math.max(0, active - 1);
  }
}

export function isRetryableJobError(err) {
  return isRetryableOperationalError(err);
}
