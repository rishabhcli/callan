import { env } from './env.js';
import { enqueueJob } from './jobs.js';
import { log } from './logger.js';
import { retryFailedWrites } from './memory.js';

export const MEMORY_RETRY_JOB_TYPE = 'memory.retry_failed';

let retryTimer = null;

export function runMemoryRetryJob(payload = {}) {
  return retryFailedWrites({
    limit: Math.max(1, Math.min(Number(payload.limit) || env.memory.retryBatchSize, 200))
  });
}

export function enqueueMemoryRetry({
  now = Date.now(),
  intervalMs = env.memory.retryIntervalMs,
  reason = 'scheduler',
  runAt = now,
  idempotencyKey = null
} = {}) {
  const bucketMs = Math.max(10_000, Number(intervalMs) || 60_000);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: MEMORY_RETRY_JOB_TYPE,
    payload: {
      reason,
      limit: env.memory.retryBatchSize,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: idempotencyKey || `${MEMORY_RETRY_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts: 3
  });
}

export function startMemoryRetryScheduler({
  enabled = env.memory.retryEnabled,
  intervalMs = env.memory.retryIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(10_000, Number(intervalMs) || 60_000);
  if (retryTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason) => {
    const result = enqueueMemoryRetry({ intervalMs: safeInterval, reason });
    log.info('memory.retry_enqueued', {
      jobId: result.row?.id || null,
      status: result.row?.status || null,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  retryTimer = setInterval(() => {
    try {
      enqueue('interval');
    } catch (err) {
      log.warn('memory.retry_scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  retryTimer.unref?.();
  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopMemoryRetryScheduler() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  return { running: false };
}
