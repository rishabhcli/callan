import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { calls, db, durableJobs, providerSmoke, safeToSellReports, scheduledCalls } from './db.js';
import { env } from './env.js';
import { drainDurableJobsOnce, enqueueJob } from './jobs.js';
import { log, redact } from './logger.js';
import { recordProviderPosture } from './providerPosture.js';
import { isProviderRuntimeError, providerRuntimeIncident } from './providerIncidents.js';
import { operationalErrorSummary } from './operationalErrors.js';
import { ACCOUNT_MANAGER_RUN_JOB_TYPE, enqueueAccountManagerRun, handleAccountManagerRunJob } from './accountManager/scheduler.js';

const BACKUP_PREFIX = 'callan-backup-';
const HOUR_MS = 60 * 60 * 1000;
const MIN_SCHEDULER_FRESH_MS = 15 * 60 * 1000;
const WORKER_PROVIDER_DEPENDENCIES = {
  analyst: ['gemini'],
  caller: ['agentphone'],
  scheduledCaller: ['agentphone'],
  mailer: ['agentmail'],
  mailReply: ['agentmail'],
  builder: ['browserUse', 'lovable'],
  scraper: ['browserUse'],
  account_manager: ['agentmail', 'supermemory'],
  hostingSubscription: ['stripe']
};
export const OPS_BACKUP_JOB_TYPE = 'ops.backup';
export const OPS_PROVIDER_POSTURE_JOB_TYPE = 'ops.provider_posture';
export const OPS_RECOVER_STUCK_JOB_TYPE = 'ops.recover_stuck';
const OPS_SAFE_TO_SELL_JOB_TYPE = 'ops.safe_to_sell';
let backupTimer = null;
let providerPostureTimer = null;
let recoveryTimer = null;

export function redactPii(value) {
  return redact(value);
}

export function exportOperationsData({ includePII = false, limit = 500 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 500, 2_000));
  const tables = {
    leads: db.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT ?`).all(n),
    payments: db.prepare(`SELECT * FROM payments ORDER BY created_at DESC LIMIT ?`).all(n),
    builds: db.prepare(`SELECT * FROM builds ORDER BY started_at DESC LIMIT ?`).all(n),
    contactEvents: db.prepare(`SELECT * FROM contact_events ORDER BY created_at DESC LIMIT ?`).all(n),
    calls: db.prepare(`SELECT * FROM calls ORDER BY started_at DESC LIMIT ?`).all(n),
    jobs: durableJobs.list({ limit: n }),
    safeToSellReports: safeToSellReports.list({ limit: n })
  };
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    includePII: !!includePII,
    redaction: {
      strategy: includePII ? 'none' : 'pii_secrets_and_local_paths'
    },
    persistence: {
      kind: 'sqlite',
      dataDir: env.dataDir
    },
    limits: {
      rowsPerTable: n
    },
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    tables
  };
  return includePII ? payload : redact(payload);
}

export function backupSqliteDataDir({
  dataDir = env.dataDir,
  outputDir = join(dataDir, 'backups'),
  now = new Date()
} = {}) {
  const sourceDir = resolve(dataDir);
  const destDir = resolve(outputDir);
  mkdirSync(destDir, { recursive: true });
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {}
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const files = readdirSync(sourceDir)
    .filter((name) => /^callmemaybe\.db(?:-(?:wal|shm))?$/.test(name))
    .map((name) => {
      const from = join(sourceDir, name);
      const to = join(destDir, `${BACKUP_PREFIX}${stamp}-${name}`);
      copyFileSync(from, to);
      const size = statSync(to).size;
      return { source: from, backup: to, file: basename(to), bytes: size };
    });
  return {
    ok: files.length > 0,
    dataDir: sourceDir,
    backupDir: destDir,
    files
  };
}

export function resetMockData({ confirm, dryRun = true, now = new Date() } = {}) {
  if (env.nodeEnv === 'production') {
    return { ok: false, refused: true, reason: 'reset_mock_data_refuses_production' };
  }
  if (confirm !== 'RESET_MOCK_DATA') {
    return { ok: false, refused: true, reason: 'confirm must equal RESET_MOCK_DATA' };
  }
  const plan = [
    {
      action: 'delete',
      table: 'jobs',
      where: "idempotency_key LIKE 'ops-check:%' OR payload_json LIKE '%ops-check%'"
    },
    {
      action: 'archive',
      table: 'leads',
      where: "id LIKE 'demo_%' OR container_tag LIKE 'demo_%' OR source_url LIKE 'https://example.test/%'"
    }
  ];
  const counts = plan.map((item) => ({
    ...item,
    count: db.prepare(`SELECT COUNT(*) AS n FROM ${item.table} WHERE ${item.where}`).get().n
  }));
  const totalMatched = counts.reduce((sum, item) => sum + item.count, 0);
  if (dryRun) return { ok: true, dryRun: true, counts, totalMatched };
  const backup = backupSqliteDataDir({ now: now instanceof Date ? now : new Date(now) });
  if (!backup.ok) {
    return {
      ok: false,
      dryRun: false,
      refused: true,
      reason: 'backup_before_reset_failed',
      backup
    };
  }
  const changed = [];
  const resetAt = now instanceof Date ? now : new Date(now);
  const resetAtMs = Number.isFinite(resetAt.getTime()) ? resetAt.getTime() : Date.now();
  const apply = db.transaction(() => {
    for (const item of plan) {
      if (item.action === 'archive' && item.table === 'leads') {
        const result = db.prepare(`
          UPDATE leads
          SET status = 'reset_archived',
              outreach_status = 'blocked',
              next_action = 'reset_archived',
              blocked_reason = 'reset_mock_data',
              updated_at = ?
          WHERE ${item.where}
        `).run(resetAtMs);
        changed.push({ action: item.action, table: item.table, count: result.changes || 0 });
      } else {
        const result = db.prepare(`DELETE FROM ${item.table} WHERE ${item.where}`).run();
        changed.push({ action: item.action, table: item.table, count: result.changes || 0 });
      }
    }
  });
  apply();
  const deleted = changed.filter((item) => item.action === 'delete');
  const archived = changed.filter((item) => item.action === 'archive');
  return {
    ok: true,
    dryRun: false,
    counts,
    totalMatched,
    changed,
    deleted,
    archived,
    totalDeleted: deleted.reduce((sum, item) => sum + item.count, 0),
    totalArchived: archived.reduce((sum, item) => sum + item.count, 0),
    totalChanged: changed.reduce((sum, item) => sum + item.count, 0),
    backup
  };
}

export function latestBackupManifest({ dataDir = env.dataDir } = {}) {
  const backupDir = resolve(join(dataDir, 'backups'));
  if (!existsSync(backupDir)) return { backupDir, files: [] };
  const files = readdirSync(backupDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .map((name) => {
      const full = join(backupDir, name);
      const stat = statSync(full);
      return { file: name, path: full, bytes: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { backupDir, files };
}

export function backupFreshness(backups = latestBackupManifest(), { now = Date.now(), maxAgeMs = 24 * HOUR_MS } = {}) {
  const latest = backups.files?.find((file) => file.bytes > 0);
  if (!latest) {
    return {
      ok: false,
      reason: 'No SQLite backup file exists',
      backupDir: backups.backupDir,
      latest: null
    };
  }
  const ageMs = Math.max(0, now - latest.mtimeMs);
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      reason: 'Latest SQLite backup is older than 24h',
      backupDir: backups.backupDir,
      latest,
      ageMs
    };
  }
  return {
    ok: true,
    reason: null,
    backupDir: backups.backupDir,
    latest,
    ageMs
  };
}

export function runOpsBackupJob(payload = {}) {
  const now = payload?.now ? new Date(payload.now) : new Date();
  const result = backupSqliteDataDir({ now });
  if (!result.ok) throw new Error('No SQLite files found to back up');
  return {
    ...result,
    reason: payload?.reason || 'durable_job'
  };
}

export function enqueueOpsBackup({
  now = Date.now(),
  intervalMs = env.ops.backupIntervalMs,
  reason = 'scheduler',
  runAt = now,
  maxAttempts = 3,
  idempotencyKey = null
} = {}) {
  const bucketMs = Math.max(HOUR_MS, Number(intervalMs) || 12 * HOUR_MS);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: OPS_BACKUP_JOB_TYPE,
    payload: {
      reason,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: idempotencyKey || `${OPS_BACKUP_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts
  });
}

export function startOpsBackupScheduler({
  enabled = env.ops.backupEnabled,
  intervalMs = env.ops.backupIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(HOUR_MS, Number(intervalMs) || 12 * HOUR_MS);
  if (backupTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason) => {
    const result = enqueueOpsBackup({ intervalMs: safeInterval, reason });
    log.info('ops.backup_job_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  backupTimer = setInterval(() => {
    try {
      enqueue('interval');
    } catch (err) {
      log.warn('ops.backup_scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  backupTimer.unref?.();
  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopOpsBackupScheduler() {
  if (backupTimer) clearInterval(backupTimer);
  backupTimer = null;
  return { running: false };
}

export function runProviderPostureJob(payload = {}) {
  return recordProviderPosture({
    now: parseJobNow(payload?.now),
    source: payload?.reason || payload?.source || 'durable_job',
    updateLatest: false
  });
}

export function enqueueProviderPostureRefresh({
  now = Date.now(),
  intervalMs = env.ops.providerPostureIntervalMs,
  reason = 'scheduler',
  runAt = now,
  maxAttempts = 2,
  idempotencyKey = null
} = {}) {
  const bucketMs = Math.max(60_000, Number(intervalMs) || 6 * HOUR_MS);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: OPS_PROVIDER_POSTURE_JOB_TYPE,
    payload: {
      reason,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: idempotencyKey || `${OPS_PROVIDER_POSTURE_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts
  });
}

export function startProviderPostureScheduler({
  enabled = env.ops.providerPostureEnabled,
  intervalMs = env.ops.providerPostureIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(60_000, Number(intervalMs) || 6 * HOUR_MS);
  if (providerPostureTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason) => {
    const result = enqueueProviderPostureRefresh({ intervalMs: safeInterval, reason });
    log.info('ops.provider_posture_job_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  providerPostureTimer = setInterval(() => {
    try {
      enqueue('interval');
    } catch (err) {
      log.warn('ops.provider_posture_scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  providerPostureTimer.unref?.();
  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopProviderPostureScheduler() {
  if (providerPostureTimer) clearInterval(providerPostureTimer);
  providerPostureTimer = null;
  return { running: false };
}

export function runOpsRecoveryJob(payload = {}, { recoverBuilds = null } = {}) {
  const now = parseJobNow(payload?.now);
  const dryRun = payload?.dryRun === true;
  const result = recoverStuckOperations({
    now,
    dryRun,
    recoverJobs: payload?.recoverJobs !== false,
    recoverCalls: payload?.recoverCalls !== false,
    recoverScheduledCalls: payload?.recoverScheduledCalls !== false,
    maxCallAgeMs: Number(payload?.maxCallAgeMs) || env.ops.recoveryMaxCallAgeMs,
    maxScheduledCallAgeMs: Number(payload?.maxScheduledCallAgeMs) || env.ops.recoveryMaxScheduledCallAgeMs
  });
  if (typeof recoverBuilds === 'function' && payload?.recoverBuilds !== false) {
    if (dryRun) {
      result.builds = { dryRun: true, recovered: 0, skipped: true };
    } else {
      const rows = recoverBuilds({
        staleAfterMs: Number(payload?.maxBuildAgeMs) || env.ops.recoveryMaxBuildAgeMs,
        limit: Number(payload?.limit) || 25
      }) || [];
      result.builds = { recovered: rows.length, rows };
    }
  } else {
    result.builds = { recovered: 0, skipped: true, reason: 'no_build_recovery_handler' };
  }
  result.reason = payload?.reason || 'durable_job';
  return result;
}

export function enqueueOpsRecovery({
  now = Date.now(),
  intervalMs = env.ops.recoveryIntervalMs,
  reason = 'scheduler',
  runAt = now,
  maxAttempts = 2,
  idempotencyKey = null
} = {}) {
  const bucketMs = Math.max(60_000, Number(intervalMs) || 5 * 60 * 1000);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: OPS_RECOVER_STUCK_JOB_TYPE,
    payload: {
      reason,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: idempotencyKey || `${OPS_RECOVER_STUCK_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts
  });
}

export function startOpsRecoveryScheduler({
  enabled = env.ops.recoveryEnabled,
  intervalMs = env.ops.recoveryIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(60_000, Number(intervalMs) || 5 * 60 * 1000);
  if (recoveryTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason) => {
    const result = enqueueOpsRecovery({ intervalMs: safeInterval, reason });
    log.info('ops.recover_stuck_job_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  recoveryTimer = setInterval(() => {
    try {
      enqueue('interval');
    } catch (err) {
      log.warn('ops.recover_stuck_scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  recoveryTimer.unref?.();
  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopOpsRecoveryScheduler() {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  return { running: false };
}

function parseJobNow(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function opsObservability({ now = Date.now(), windowMs = 24 * HOUR_MS } = {}) {
  const since = now - windowMs;
  const dailyRevenueCents = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS cents
    FROM payments
    WHERE status = 'paid'
      AND COALESCE(paid_at, created_at, 0) >= ?
  `).get(since).cents || 0;
  const dailyCostMicros = db.prepare(`
    SELECT COALESCE(SUM(usd_micros), 0) AS micros
    FROM lead_costs
    WHERE created_at >= ?
  `).get(since).micros || 0;
  const providerCosts = db.prepare(`
    SELECT provider,
           COUNT(*) AS events,
           COALESCE(SUM(usd_micros), 0) AS micros,
           COALESCE(SUM(units), 0) AS units,
           MAX(created_at) AS lastAt
    FROM lead_costs
    WHERE created_at >= ?
    GROUP BY provider
    ORDER BY micros DESC
  `).all(since).map((row) => ({
    provider: row.provider,
    events: row.events,
    costUsd: round2(row.micros / 1_000_000),
    units: row.units,
    lastAt: row.lastAt
  }));
  const providerHealth = Object.entries(providerSmoke.all()).map(([provider, row]) => ({
    provider,
    status: row.status,
    checkedAt: row.checkedAt,
    ageMs: row.checkedAt ? Math.max(0, now - row.checkedAt) : null,
    detail: row.detail
  }));
  const providerHistory = providerSmoke.historySummary({ since });
  const providerHealthSloResult = providerHealthSlo(providerHistory);
  const recentProviderFailures = providerSmoke.issues({ since, limit: 25 });
  const safeToSellHistory = safeToSellReports.summary({ since, limit: 10 });
  const workerHistory = workerRunHistory({ since, now });
  const durableJobIssueHistory = durableJobIssues({ since });
  const workerHealthSloResult = workerHealthSlo(workerHistory, durableJobIssueHistory);
  const recentFailures = db.prepare(`
    SELECT id, worker, state, lead_id, started_at, finished_at, error
    FROM worker_runs
    WHERE COALESCE(finished_at, started_at, 0) >= ?
      AND (state = 'failed' OR error IS NOT NULL)
    ORDER BY COALESCE(finished_at, started_at, 0) DESC
    LIMIT 25
  `).all(since).map((row) => {
    const safe = redact(row);
    return {
      ...safe,
      error: safe.error ? operationalErrorSummary(safe.error) : null
    };
  });
  const stuck = {
    jobs: durableJobs.summary({ now }).staleRunning,
    builds: db.prepare(`
      SELECT id, lead_id, status, COALESCE(updated_at, started_at, 0) AS lastAt, error
      FROM builds
      WHERE status IN ('queued', 'starting', 'running')
        AND COALESCE(updated_at, started_at, 0) < ?
      ORDER BY lastAt ASC
      LIMIT 25
    `).all(now - 30 * 60 * 1000),
    calls: db.prepare(`
      SELECT id, lead_id, provider_call_id, state, started_at
      FROM calls
      WHERE state IN ('in_progress', 'ringing', 'active')
        AND started_at < ?
      ORDER BY started_at ASC
      LIMIT 25
    `).all(now - 45 * 60 * 1000)
  };
  const outreach = {
    byStatus: Object.fromEntries(db.prepare(`
      SELECT outreach_status, COUNT(*) AS n
      FROM leads
      GROUP BY outreach_status
    `).all().map((row) => [row.outreach_status || 'unknown', row.n])),
    nextActions: db.prepare(`
      SELECT COALESCE(next_action, 'none') AS nextAction, COUNT(*) AS n
      FROM leads
      GROUP BY COALESCE(next_action, 'none')
      ORDER BY n DESC
      LIMIT 20
    `).all()
  };
  const revenueUsd = dailyRevenueCents / 100;
  const costUsd = dailyCostMicros / 1_000_000;
  const dailyEconomics = {
    revenueUsd: round2(revenueUsd),
    costUsd: round2(costUsd),
    marginUsd: round2(revenueUsd - costUsd),
    marginPct: revenueUsd > 0 ? Number((((revenueUsd - costUsd) / revenueUsd) * 100).toFixed(2)) : null
  };
  const schedulerHealth = recurringOpsJobHealth({ now });
  const economicsHealthResult = economicsHealth(dailyEconomics);
  return {
    generatedAt: new Date(now).toISOString(),
    windowMs,
    schedulerHealth,
    economicsHealth: economicsHealthResult,
    providerHealth,
    providerHealthSlo: providerHealthSloResult,
    providerHistory,
    recentProviderFailures,
    workerHealthSlo: workerHealthSloResult,
    workerHistory,
    durableJobIssueHistory,
    safeToSellHistory,
    providerCosts,
    recentFailures,
    stuck,
    outreach,
    dailyEconomics
  };
}

function workerRunHistory({ since = 0, now = Date.now() } = {}) {
  const checkedSince = Math.max(0, Number(since) || 0);
  const rows = db.prepare(`
    SELECT worker,
           COUNT(*) AS total,
           SUM(CASE WHEN state = 'failed' OR error IS NOT NULL THEN 1 ELSE 0 END) AS failed_count,
           SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
           SUM(CASE WHEN state NOT IN ('failed', 'running', 'blocked') AND error IS NULL THEN 1 ELSE 0 END) AS ok_count,
           MAX(COALESCE(finished_at, started_at, 0)) AS last_at
    FROM worker_runs
    WHERE COALESCE(finished_at, started_at, 0) >= ?
    GROUP BY worker
    ORDER BY worker
  `).all(checkedSince);
  const latestErrors = db.prepare(`
    SELECT worker, error
    FROM worker_runs
    WHERE COALESCE(finished_at, started_at, 0) >= ?
      AND error IS NOT NULL
    ORDER BY COALESCE(finished_at, started_at, 0) DESC
  `).all(checkedSince);
  const errorByWorker = new Map();
  for (const row of latestErrors) {
    if (!errorByWorker.has(row.worker)) errorByWorker.set(row.worker, operationalErrorSummary(redact(row.error)));
  }
  return rows.map((row) => {
    const total = Number(row.total) || 0;
    const failureCount = Number(row.failed_count) || 0;
    const providerRecovery = workerProviderRecovery({ worker: row.worker, since: checkedSince, now });
    const recoveredFailureCount = Math.min(failureCount, providerRecovery.recoveredFailureCount || 0);
    const effectiveFailureCount = Math.max(0, failureCount - recoveredFailureCount);
    return {
      worker: row.worker,
      total,
      okCount: Number(row.ok_count) || 0,
      blockedCount: Number(row.blocked_count) || 0,
      failureCount,
      recoveredFailureCount,
      effectiveFailureCount,
      failureRatePct: total > 0 ? Number(((failureCount / total) * 100).toFixed(2)) : 0,
      effectiveFailureRatePct: total > 0 ? Number(((effectiveFailureCount / total) * 100).toFixed(2)) : 0,
      providerRecovery: providerRecovery.providers,
      lastAt: row.last_at || null,
      lastError: errorByWorker.get(row.worker) || null
    };
  });
}

function workerProviderRecovery({ worker, since = 0, now = Date.now() } = {}) {
  const providers = WORKER_PROVIDER_DEPENDENCIES[worker] || [];
  if (!providers.length) return { recoveredFailureCount: 0, providers: [] };
  const rows = db.prepare(`
    SELECT id, error, COALESCE(finished_at, started_at, 0) AS at
    FROM worker_runs
    WHERE worker = ?
      AND COALESCE(finished_at, started_at, 0) >= ?
      AND error IS NOT NULL
    ORDER BY at DESC
    LIMIT 100
  `).all(worker, Math.max(0, Number(since) || 0));
  const recoveredRunIds = new Set();
  const providerRows = providers.map((provider) => {
    const failures = rows.filter((row) => providerFailureMatches(row.error, provider));
    const latestFailureAt = failures.reduce((max, row) => Math.max(max, Number(row.at) || 0), 0) || null;
    const liveOk = providerSmoke.latestEvent({ provider, live: true, statuses: ['ok'] });
    const incident = providerRuntimeIncident(provider, { now });
    const recovered = failures.length > 0
      && latestFailureAt
      && liveOk?.checkedAt
      && liveOk.checkedAt > latestFailureAt
      && !incident.blocked;
    if (recovered) {
      for (const row of failures) recoveredRunIds.add(row.id);
    }
    return {
      provider,
      failureCount: failures.length,
      latestFailureAt,
      liveSmokeOkAt: liveOk?.checkedAt || null,
      incidentBlocked: !!incident.blocked,
      recovered: !!recovered,
      reason: failures.length
        ? recovered
          ? `${provider} live smoke passed after latest ${worker} failure`
          : `${provider} has not passed a live smoke after latest ${worker} failure`
        : null
    };
  });
  return {
    recoveredFailureCount: recoveredRunIds.size,
    providers: providerRows.filter((row) => row.failureCount > 0)
  };
}

function providerFailureMatches(error, provider) {
  if (isProviderRuntimeError(error, provider)) return true;
  const normalizedError = String(error || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedProvider = String(provider || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!normalizedProvider && normalizedError.includes(normalizedProvider);
}

function durableJobIssues({ since = 0 } = {}) {
  const checkedSince = Math.max(0, Number(since) || 0);
  const rows = db.prepare(`
    SELECT type,
           COUNT(*) AS issue_count,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
           SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry_count,
           MAX(updated_at) AS last_at
    FROM jobs
    WHERE updated_at >= ?
      AND status IN ('failed', 'retry')
    GROUP BY type
    ORDER BY type
  `).all(checkedSince);
  const latestErrors = db.prepare(`
    SELECT type, error
    FROM jobs
    WHERE updated_at >= ?
      AND status IN ('failed', 'retry')
      AND error IS NOT NULL
    ORDER BY updated_at DESC
  `).all(checkedSince);
  const errorByType = new Map();
  for (const row of latestErrors) {
    if (!errorByType.has(row.type)) errorByType.set(row.type, operationalErrorSummary(redact(row.error)));
  }
  return rows.map((row) => ({
    type: row.type,
    issueCount: Number(row.issue_count) || 0,
    failedCount: Number(row.failed_count) || 0,
    retryCount: Number(row.retry_count) || 0,
    lastAt: row.last_at || null,
    lastError: errorByType.get(row.type) || null
  }));
}

export function workerHealthSlo(workerHistory = [], durableJobIssueHistory = [], {
  maxFailuresPer24h = env.ops.workerMaxFailuresPer24h,
  maxFailureRatePct = env.ops.workerMaxFailureRatePct,
  minRunsForFailureRate = env.ops.workerMinRunsForFailureRate,
  maxJobIssuesPer24h = env.ops.jobMaxIssuesPer24h
} = {}) {
  const failureLimit = finiteNumber(maxFailuresPer24h, 3);
  const rateLimit = finiteNumber(maxFailureRatePct, 25);
  const minRuns = Math.max(1, Math.round(finiteNumber(minRunsForFailureRate, 4)));
  const jobIssueLimit = finiteNumber(maxJobIssuesPer24h, 5);
  const workers = (workerHistory || []).map((row) => {
    const blockers = [];
    const effectiveFailureCount = Number.isFinite(Number(row.effectiveFailureCount))
      ? Number(row.effectiveFailureCount)
      : Number(row.failureCount) || 0;
    const effectiveFailureRatePct = Number.isFinite(Number(row.effectiveFailureRatePct))
      ? Number(row.effectiveFailureRatePct)
      : Number(row.failureRatePct) || 0;
    if (effectiveFailureCount > failureLimit) {
      blockers.push(workerSloBlocker(row.worker, `${effectiveFailureCount} unrecovered failures exceed OPS_WORKER_MAX_FAILURES_24H ${failureLimit}`));
    }
    if (row.total >= minRuns && effectiveFailureRatePct > rateLimit) {
      blockers.push(workerSloBlocker(row.worker, `unrecovered failure rate ${effectiveFailureRatePct.toFixed(2)}% exceeds OPS_WORKER_MAX_FAILURE_RATE_PCT ${rateLimit.toFixed(2)}%`));
    }
    return {
      ...row,
      effectiveFailureCount,
      effectiveFailureRatePct,
      ok: blockers.length === 0,
      blockers
    };
  });
  const durableJobs = (durableJobIssueHistory || []).map((row) => {
    const blockers = row.issueCount > jobIssueLimit
      ? [jobSloBlocker(row.type, `${row.issueCount} retry/failed jobs exceed OPS_JOB_MAX_ISSUES_24H ${jobIssueLimit}`)]
      : [];
    return {
      ...row,
      ok: blockers.length === 0,
      blockers
    };
  });
  const blockers = [
    ...workers.flatMap((row) => row.blockers),
    ...durableJobs.flatMap((row) => row.blockers)
  ];
  return {
    ok: blockers.length === 0,
    blockers,
    thresholds: {
      maxFailuresPer24h: failureLimit,
      maxFailureRatePct: rateLimit,
      minRunsForFailureRate: minRuns,
      maxJobIssuesPer24h: jobIssueLimit
    },
    workers,
    durableJobs
  };
}

export function providerHealthSlo(history = [], {
  maxIssueRatePct = env.ops.providerMaxIssueRatePct,
  minEventsForIssueRate = env.ops.providerMinEventsForIssueRate,
  maxAvgLatencyMs = env.ops.providerMaxAvgLatencyMs,
  now = Date.now()
} = {}) {
  const issueRateLimit = finiteNumber(maxIssueRatePct, 20);
  const minEvents = Math.max(1, Math.round(finiteNumber(minEventsForIssueRate, 3)));
  const latencyLimit = finiteNumber(maxAvgLatencyMs, 15_000);
  const issueStatuses = new Set(['failed', 'blocked', 'degraded']);
  const providers = (history || []).map((row) => {
    const total = Number(row.total) || 0;
    const issueCount = (Number(row.failedCount) || 0) + (Number(row.blockedCount) || 0) + (Number(row.degradedCount) || 0);
    const issueRatePct = total > 0 ? Number(((issueCount / total) * 100).toFixed(2)) : 0;
    const avgDurationMs = row.avgDurationMs === null || row.avgDurationMs === undefined ? null : Number(row.avgDurationMs);
    const runtimeIncident = providerRuntimeIncident(row.provider, { now });
    const blockers = [];

    if (runtimeIncident.blocked) {
      blockers.push(providerSloBlocker(row.provider, `${row.provider} provider has an uncleared runtime incident: ${operationalErrorSummary(runtimeIncident.reason)}`));
    }
    if (issueStatuses.has(row.currentStatus)) {
      blockers.push(providerSloBlocker(row.provider, `latest smoke status is ${row.currentStatus}${row.lastError ? `: ${operationalErrorSummary(row.lastError)}` : ''}`));
    }
    if (total >= minEvents && issueRatePct > issueRateLimit) {
      blockers.push(providerSloBlocker(row.provider, `issue rate ${issueRatePct.toFixed(2)}% exceeds OPS_PROVIDER_MAX_ISSUE_RATE_PCT ${issueRateLimit.toFixed(2)}%`));
    }
    if (avgDurationMs !== null && Number.isFinite(avgDurationMs) && avgDurationMs > latencyLimit) {
      blockers.push(providerSloBlocker(row.provider, `average latency ${Math.round(avgDurationMs)}ms exceeds OPS_PROVIDER_MAX_AVG_LATENCY_MS ${Math.round(latencyLimit)}ms`));
    }

    return {
      provider: row.provider,
      ok: blockers.length === 0,
      total,
      issueCount,
      issueRatePct,
      avgDurationMs,
      currentStatus: row.currentStatus || null,
      lastCheckedAt: row.lastCheckedAt || null,
      lastError: row.lastError ? operationalErrorSummary(row.lastError) : null,
      runtimeIncident: {
        blocked: !!runtimeIncident.blocked,
        reason: runtimeIncident.blocked && runtimeIncident.reason
          ? `${row.provider} provider has an uncleared runtime incident: ${operationalErrorSummary(runtimeIncident.reason)}`
          : null,
        checkedAt: runtimeIncident.incident?.checkedAt || null,
        ageMs: runtimeIncident.ageMs ?? null,
        clearedBy: runtimeIncident.clearedBy?.checkedAt || null
      },
      blockers
    };
  });
  const blockers = providers.flatMap((row) => row.blockers);
  return {
    ok: blockers.length === 0,
    blockers,
    thresholds: {
      maxIssueRatePct: issueRateLimit,
      minEventsForIssueRate: minEvents,
      maxAvgLatencyMs: latencyLimit
    },
    providers
  };
}

export function economicsHealth(economics = {}, {
  maxDailyCostUsd = env.ops.economicsMaxDailyCostUsd,
  maxDailyLossUsd = env.ops.economicsMaxDailyLossUsd,
  minMarginPct = env.ops.economicsMinMarginPct
} = {}) {
  const revenueUsd = round2(economics.revenueUsd);
  const costUsd = round2(economics.costUsd);
  const marginUsd = round2(economics.marginUsd ?? (revenueUsd - costUsd));
  const marginPct = revenueUsd > 0
    ? Number((economics.marginPct ?? ((marginUsd / revenueUsd) * 100)).toFixed(2))
    : null;
  const blockers = [];

  if (isFiniteThreshold(maxDailyCostUsd) && costUsd > maxDailyCostUsd) {
    blockers.push(`daily cost $${costUsd.toFixed(2)} exceeds OPS_MAX_DAILY_COST_USD $${Number(maxDailyCostUsd).toFixed(2)}`);
  }
  if (isFiniteThreshold(maxDailyLossUsd) && marginUsd < -maxDailyLossUsd) {
    blockers.push(`daily loss $${Math.abs(marginUsd).toFixed(2)} exceeds OPS_MAX_DAILY_LOSS_USD $${Number(maxDailyLossUsd).toFixed(2)}`);
  }
  if (revenueUsd > 0 && isFiniteThreshold(minMarginPct) && marginPct !== null && marginPct < minMarginPct) {
    blockers.push(`daily margin ${marginPct.toFixed(2)}% is below OPS_MIN_MARGIN_PCT ${Number(minMarginPct).toFixed(2)}%`);
  }

  return {
    ok: blockers.length === 0,
    blockers,
    status: blockers.length ? 'blocked' : 'healthy',
    thresholds: {
      maxDailyCostUsd: Number(maxDailyCostUsd),
      maxDailyLossUsd: Number(maxDailyLossUsd),
      minMarginPct: Number(minMarginPct)
    },
    dailyEconomics: {
      revenueUsd,
      costUsd,
      marginUsd,
      marginPct
    }
  };
}

export function recurringOpsJobHealth({ now = Date.now() } = {}) {
  const jobs = recurringOpsJobSpecs().map((spec) => {
    const latest = latestDurableJob({ type: spec.type });
    const latestCompleted = latestDurableJob({ type: spec.type, statuses: ['completed'] });
    const latestIssue = latestDurableJob({ type: spec.type, statuses: ['failed', 'retry'] });
    const completedAt = jobTime(latestCompleted);
    const ageMs = completedAt ? Math.max(0, now - completedAt) : null;
    const maxAgeMs = schedulerFreshnessWindow(spec.intervalMs);
    const blockers = [];

    if (spec.enabled) {
      if (!latestCompleted) blockers.push(`${spec.type} has not completed`);
      else if (ageMs > maxAgeMs) blockers.push(`${spec.type} last completed job is stale`);
      if (latestIssue && jobTime(latestIssue) > (completedAt || 0)) {
        blockers.push(`${spec.type} latest job ${latestIssue.status}${latestIssue.error ? `: ${latestIssue.error}` : ''}`);
      }
    }

    return {
      type: spec.type,
      label: spec.label,
      enabled: spec.enabled,
      intervalMs: spec.intervalMs,
      maxAgeMs,
      ok: !spec.enabled || blockers.length === 0,
      blockers,
      lastCompletedAt: completedAt,
      ageMs,
      latest: compactJob(latest),
      latestCompleted: compactJob(latestCompleted),
      latestIssue: compactJob(latestIssue)
    };
  });
  const blockers = jobs.flatMap((job) => job.blockers || []);
  return {
    ok: blockers.length === 0,
    generatedAt: new Date(now).toISOString(),
    blockers,
    total: jobs.length,
    enabled: jobs.filter((job) => job.enabled).length,
    healthy: jobs.filter((job) => job.enabled && job.ok).length,
    jobs
  };
}

export async function refreshStaleOpsMaintenance({
  now = Date.now(),
  reason = 'safe_to_sell_preflight',
  timeoutMs = 10_000
} = {}) {
  const before = recurringOpsJobHealth({ now });
  const handlers = {
    [OPS_BACKUP_JOB_TYPE]: runOpsBackupJob,
    [OPS_PROVIDER_POSTURE_JOB_TYPE]: runProviderPostureJob,
    [OPS_RECOVER_STUCK_JOB_TYPE]: runOpsRecoveryJob,
    [ACCOUNT_MANAGER_RUN_JOB_TYPE]: handleAccountManagerRunJob
  };
  const stale = before.jobs.filter((job) => job.enabled && !job.ok && handlers[job.type]);
  if (!stale.length) {
    return {
      ok: true,
      refreshed: 0,
      jobs: [],
      before,
      after: before
    };
  }

  const queued = [];
  for (const job of stale) {
    const key = `safe-to-sell-preflight:${job.type}:${now}`;
    const common = {
      now,
      reason,
      runAt: now,
      idempotencyKey: key
    };
    if (job.type === OPS_BACKUP_JOB_TYPE) queued.push(enqueueOpsBackup(common));
    if (job.type === OPS_PROVIDER_POSTURE_JOB_TYPE) queued.push(enqueueProviderPostureRefresh(common));
    if (job.type === OPS_RECOVER_STUCK_JOB_TYPE) queued.push(enqueueOpsRecovery(common));
    if (job.type === ACCOUNT_MANAGER_RUN_JOB_TYPE) {
      queued.push(enqueueAccountManagerRun({
        ...common,
        intervalMs: job.intervalMs,
        dryRun: true,
        source: 'safe_to_sell_preflight'
      }));
    }
  }

  const selectedHandlers = Object.fromEntries(stale.map((job) => [job.type, handlers[job.type]]));
  const drained = await drainDurableJobsOnce(selectedHandlers, {
    workerId: 'safe-to-sell-preflight',
    concurrency: stale.length + 1,
    maxJobs: stale.length
  });
  const settled = await waitForDurableJobs(queued.map((item) => item.row?.id).filter(Boolean), { timeoutMs });
  const after = recurringOpsJobHealth({ now: Date.now() });
  const failed = settled.filter((row) => row?.status !== 'completed');
  return {
    ok: failed.length === 0,
    refreshed: settled.filter((row) => row?.status === 'completed').length,
    jobs: stale.map((job, index) => ({
      type: job.type,
      previousBlockers: job.blockers,
      queued: queued[index]?.row?.id || null,
      inserted: !!queued[index]?.inserted,
      status: settled[index]?.status || 'missing',
      error: settled[index]?.error || null
    })),
    drained,
    before,
    after
  };
}

function recurringOpsJobSpecs() {
  return [
    {
      type: OPS_BACKUP_JOB_TYPE,
      label: 'SQLite backup',
      enabled: env.ops.backupEnabled,
      intervalMs: env.ops.backupIntervalMs
    },
    {
      type: OPS_PROVIDER_POSTURE_JOB_TYPE,
      label: 'Provider posture',
      enabled: env.ops.providerPostureEnabled,
      intervalMs: env.ops.providerPostureIntervalMs
    },
    {
      type: OPS_RECOVER_STUCK_JOB_TYPE,
      label: 'Stuck recovery',
      enabled: env.ops.recoveryEnabled,
      intervalMs: env.ops.recoveryIntervalMs
    },
    {
      type: OPS_SAFE_TO_SELL_JOB_TYPE,
      label: 'Safe-to-sell self-check',
      enabled: env.ops.safeToSellCheckEnabled,
      intervalMs: env.ops.safeToSellCheckIntervalMs
    },
    {
      type: ACCOUNT_MANAGER_RUN_JOB_TYPE,
      label: 'Account manager',
      enabled: env.accountManager.enabled,
      intervalMs: env.accountManager.intervalMs
    }
  ];
}

function latestDurableJob({ type, statuses = [] } = {}) {
  if (!type) return null;
  const statusList = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
  const params = [type];
  const statusWhere = statusList.length ? `AND status IN (${statusList.map(() => '?').join(', ')})` : '';
  params.push(...statusList);
  const row = db.prepare(`
    SELECT *
    FROM jobs
    WHERE type = ?
      ${statusWhere}
    ORDER BY COALESCE(finished_at, updated_at, created_at, 0) DESC
    LIMIT 1
  `).get(...params);
  if (!row) return null;
  return {
    ...row,
    payload: safeJson(row.payload_json) || {},
    result: safeJson(row.result_json) || null
  };
}

function compactJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null
  };
}

function jobTime(row) {
  return row ? Number(row.finished_at || row.updated_at || row.created_at || 0) : null;
}

async function waitForDurableJobs(ids, { timeoutMs = 10_000 } = {}) {
  if (!ids.length) return [];
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 10_000);
  const terminal = new Set(['completed', 'failed', 'canceled']);
  while (Date.now() < deadline) {
    const rows = ids.map((id) => durableJobs.get(id));
    if (rows.every((row) => row && terminal.has(row.status))) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ids.map((id) => durableJobs.get(id));
}

function schedulerFreshnessWindow(intervalMs) {
  const interval = Number(intervalMs) || 0;
  return Math.max(MIN_SCHEDULER_FRESH_MS, interval * 2);
}

export function recoverStuckOperations({
  now = Date.now(),
  dryRun = false,
  recoverJobs = true,
  recoverCalls = true,
  recoverScheduledCalls = true,
  maxCallAgeMs = 45 * 60 * 1000,
  maxScheduledCallAgeMs = 60 * 1000
} = {}) {
  const staleJobs = durableJobs.summary({ now }).staleRunning;
  const jobs = recoverJobs
    ? {
        stale: staleJobs,
        recovered: dryRun ? 0 : durableJobs.recoverExpiredLeases({ now, limit: 200 })
      }
    : { stale: staleJobs, recovered: 0, skipped: true };
  const callRecovery = recoverCalls
    ? calls.recoverStuck({ maxAgeMs: maxCallAgeMs, now, limit: 200, dryRun })
    : { dryRun, matched: 0, recovered: 0, rows: [], skipped: true };
  const scheduledMatched = recoverScheduledCalls ? db.prepare(`
    SELECT COUNT(*) AS n
    FROM scheduled_calls
    WHERE status = 'placing'
      AND fired_at IS NOT NULL
      AND fired_at < ?
  `).get(now - maxScheduledCallAgeMs).n : 0;
  const scheduledCallRecovery = recoverScheduledCalls
    ? {
        dryRun,
        matched: scheduledMatched,
        recovered: dryRun ? 0 : scheduledCalls.recoverStuck({ maxAgeMs: maxScheduledCallAgeMs, now })
      }
    : { dryRun, matched: 0, recovered: 0, skipped: true };
  return {
    ok: true,
    dryRun,
    generatedAt: new Date(now).toISOString(),
    jobs,
    calls: callRecovery,
    scheduledCalls: scheduledCallRecovery,
    observability: opsObservability({ now })
  };
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function providerSloBlocker(provider, reason) {
  return `provider health SLO blocked: ${provider} ${reason}`;
}

function workerSloBlocker(worker, reason) {
  return `worker health SLO blocked: ${worker} ${reason}`;
}

function jobSloBlocker(type, reason) {
  return `durable job health SLO blocked: ${type} ${reason}`;
}

function isFiniteThreshold(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
