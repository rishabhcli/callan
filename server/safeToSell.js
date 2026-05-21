import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_REQUIRED_PROVIDERS, liveReadiness } from './readiness.js';
import { backupFreshness, latestBackupManifest, opsObservability, refreshStaleOpsMaintenance } from './ops.js';
import { safeToSellReports } from './db.js';
import { enqueueJob } from './jobs.js';
import { env } from './env.js';
import { log, redact } from './logger.js';
import { operationalErrorSummary } from './operationalErrors.js';

export const SAFE_TO_SELL_JOB_TYPE = 'ops.safe_to_sell';
export const SAFE_TO_SELL_REPORT_VERSION = 2;
export const SAFE_TO_SELL_SNAPSHOT_FRESH_MS = 26 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let safeToSellTimer = null;

export function safeToSellSnapshotStatus(snapshot, {
  now = Date.now(),
  freshMs = SAFE_TO_SELL_SNAPSHOT_FRESH_MS
} = {}) {
  const base = {
    ok: false,
    fresh: false,
    id: snapshot?.id || null,
    generatedAt: snapshot?.generatedAt || null,
    ageMs: null,
    freshMs,
    reason: 'safe-to-sell durable snapshot is missing',
    snapshot: null
  };
  if (!snapshot?.report || !snapshot.generatedAt) return base;
  if (snapshot.report.version !== SAFE_TO_SELL_REPORT_VERSION) {
    return {
      ...base,
      id: snapshot.id,
      generatedAt: snapshot.generatedAt,
      ageMs: Math.max(0, now - snapshot.generatedAt),
      reason: 'safe-to-sell durable snapshot policy version is stale'
    };
  }
  const ageMs = Math.max(0, now - snapshot.generatedAt);
  if (ageMs > freshMs) {
    return {
      ...base,
      id: snapshot.id,
      generatedAt: snapshot.generatedAt,
      ageMs,
      reason: 'safe-to-sell durable snapshot is stale'
    };
  }
  return {
    ok: true,
    fresh: true,
    id: snapshot.id,
    generatedAt: snapshot.generatedAt,
    ageMs,
    freshMs,
    reason: null,
    snapshot: { ...snapshot, ageMs, freshMs }
  };
}

export async function buildSafeToSellReport({
  now = Date.now(),
  evals = null
} = {}) {
  const readiness = liveReadiness();
  const observability = opsObservability({ now });
  const evalResult = evals || runEvalCheck();
  const backups = latestBackupManifest();
  const backupFresh = backupFreshness(backups, { now });

  const dryRunVerified = Object.entries(readiness.providers || {})
    .map(([provider, row]) => [provider, row.dryRunSmoke?.status !== 'not_run' ? row.dryRunSmoke : row.smoke])
    .filter(([, smoke]) => smoke?.dryRun && ['configured', 'ok'].includes(smoke.status))
    .map(([provider, row]) => ({
      provider,
      status: row.status,
      checkedAt: row.checkedAt,
      live: false
    }));
  const liveSmokeVerified = Object.entries(readiness.providers || {})
    .filter(([, row]) => row.liveSmoke?.live && row.liveSmoke?.status === 'ok')
    .map(([provider, row]) => ({
      provider,
      status: row.liveSmoke.status,
      checkedAt: row.liveSmoke.checkedAt,
      live: true
    }));
  const providerProof = buildProviderProofMatrix({ readiness, observability });
  const opsBlockers = [
    observability.stuck?.jobs ? `${observability.stuck.jobs} durable job(s) have stale leases` : null,
    observability.stuck?.builds?.length ? `${observability.stuck.builds.length} build(s) look stuck` : null,
    observability.stuck?.calls?.length ? `${observability.stuck.calls.length} call(s) look stuck` : null,
    !backupFresh.ok ? backupFresh.reason : null,
    ...(observability.providerHealthSlo?.blockers || []),
    ...(observability.workerHealthSlo?.blockers || []),
    ...(observability.economicsHealth?.blockers || []),
    ...(observability.schedulerHealth?.blockers || [])
  ].filter(Boolean);
  const evalBlockers = evalResult.ok ? [] : (evalResult.cases || [])
    .filter((item) => !item.ok && !item.skipped)
    .map((item) => `eval failed: ${item.name}${item.error ? ` (${item.error})` : ''}`);
  const stillBlocked = unique([
    ...(readiness.productionBlockers || []),
    ...opsBlockers,
    ...evalBlockers
  ]);
  const nextActions = buildSafeToSellNextActions({
    readiness,
    observability,
    backupFresh,
    evalResult
  });

  const report = {
    version: SAFE_TO_SELL_REPORT_VERSION,
    ok: readiness.canGoLive && evalResult.ok && opsBlockers.length === 0,
    generatedAt: new Date(now).toISOString(),
    command: 'npm run safe-to-sell',
    mode: readiness.mode,
    queue: readiness.jobs || null,
    dryRunVerified,
    liveSmokeVerified,
    providerProof,
    stillBlocked,
    nextActions,
    readiness: {
      currentModeReady: readiness.ready,
      productionLiveReady: readiness.canGoLive,
      blockers: readiness.blockers,
      productionBlockers: readiness.productionBlockers,
      promotionGates: readiness.promotionGates,
      admin: readiness.admin,
      nextActions: readiness.nextActions
    },
    promotionGates: readiness.promotionGates,
    evals: {
      ok: evalResult.ok,
      summary: evalResult.summary,
      cases: (evalResult.cases || []).map((item) => ({
        name: item.name,
        category: item.category,
        ok: item.ok,
        skipped: item.skipped,
        durationMs: item.durationMs,
        error: item.error || null
      }))
    },
    observability: {
      dailyEconomics: observability.dailyEconomics,
      economicsHealth: observability.economicsHealth,
      providerHealthSlo: observability.providerHealthSlo,
      workerHealthSlo: observability.workerHealthSlo,
      providerCosts: observability.providerCosts,
      providerHistory: observability.providerHistory,
      recentProviderFailures: observability.recentProviderFailures?.slice(0, 10) || [],
      workerHistory: observability.workerHistory,
      durableJobIssueHistory: observability.durableJobIssueHistory,
      safeToSellHistory: compactSafeToSellHistory(observability.safeToSellHistory),
      safeToSellReceiptHistory: compactSafeToSellReceiptHistory(observability.safeToSellHistory),
      schedulerHealth: observability.schedulerHealth,
      recentFailures: observability.recentFailures?.slice(0, 10) || [],
      stuck: observability.stuck,
      outreach: observability.outreach
    },
    backups: {
      ok: backupFresh.ok,
      reason: backupFresh.reason || null,
      backupDir: backups.backupDir,
      latest: backups.files?.[0] || null
    }
  };
  report.decisionReceipt = buildSafeToSellDecisionReceipt(report);
  return redact(report);
}

export async function runSafeToSellSelfCheck({
  record = true,
  source = 'self_check',
  now = Date.now(),
  refreshOps = true
} = {}) {
  const maintenance = refreshOps
    ? await refreshStaleOpsMaintenance({ now, reason: `safe_to_sell:${source}` })
    : { ok: true, skipped: true, reason: 'refreshOps_disabled' };
  const report = applySafeToSellMaintenanceGate(
    await buildSafeToSellReport({ now: Date.now() }),
    maintenance
  );
  report.source = source;
  if (record) {
    const snapshot = safeToSellReports.record(report, { now });
    report.snapshot = {
      id: snapshot.id,
      recordedAt: new Date(snapshot.createdAt).toISOString(),
      generatedAt: new Date(snapshot.generatedAt).toISOString()
    };
    report.decisionReceipt = {
      ...(report.decisionReceipt || buildSafeToSellDecisionReceipt(report)),
      snapshotId: snapshot.id,
      durable: true
    };
    const history = safeToSellReports.summary({ since: now - DAY_MS });
    report.observability.safeToSellHistory = compactSafeToSellHistory(history);
    report.observability.safeToSellReceiptHistory = compactSafeToSellReceiptHistory(history);
  }
  return report;
}

export function applySafeToSellMaintenanceGate(report, maintenance) {
  const blockers = maintenanceBlockers(maintenance);
  const maintenanceActions = maintenanceNextActions(maintenance);
  const next = {
    ...report,
    maintenance,
    nextActions: unique([...(report.nextActions || []), ...maintenanceActions])
  };
  if (blockers.length) {
    next.ok = false;
    next.stillBlocked = unique([...(report.stillBlocked || []), ...blockers]);
  }
  next.decisionReceipt = buildSafeToSellDecisionReceipt(next);
  return next;
}

export function buildSafeToSellNextActions({
  readiness = {},
  observability = {},
  backupFresh = null,
  evalResult = null
} = {}) {
  return unique([
    ...liveSmokeNextActions(readiness),
    ...webhookNextActions(readiness),
    ...(readiness.nextActions || []),
    ...stuckNextActions(observability.stuck),
    ...providerSloNextActions(observability.providerHealthSlo),
    ...workerSloNextActions(observability.workerHealthSlo, readiness),
    ...economicsNextActions(observability.economicsHealth),
    ...schedulerNextActions(observability.schedulerHealth),
    backupFresh && backupFresh.ok === false
      ? 'create a fresh SQLite backup and verify DATA_DIR/backups is writable'
      : null,
    evalResult && evalResult.ok === false
      ? 'run npm run check:evals and fix the failing production eval cases'
      : null
  ]);
}

function liveSmokeNextActions(readiness = {}) {
  const providers = readiness.providers || {};
  return [...PRODUCTION_REQUIRED_PROVIDERS]
    .map((provider) => {
      const row = providers[provider];
      if (!row?.required) return null;
      const liveSmoke = row.liveSmoke || {};
      const liveOk = liveSmoke.status === 'ok' && liveSmoke.live === true;
      if (liveOk && liveSmoke.fresh) return null;
      if (!row.configured) return `set missing ${provider} credentials before live smoke: ${(row.missing || []).join(', ')}`;
      if (liveSmokeFailed(liveSmoke)) {
        return `fix ${provider} live smoke failure${liveSmokeErrorSuffix(liveSmoke)} and rerun ${liveSmokeCommand(provider)} to prove ${provider} live smoke freshness`;
      }
      const verb = liveOk ? 'refresh stale' : 'run';
      const incident = row.runtimeIncident?.blocked ? ' after clearing the runtime incident' : '';
      return `${verb} ${liveSmokeCommand(provider)}${incident} to prove ${provider} live smoke freshness`;
    })
    .filter(Boolean);
}

function liveSmokeFailed(liveSmoke = {}) {
  return liveSmoke.live === true && ['failed', 'blocked'].includes(liveSmoke.status);
}

function liveSmokeErrorSuffix(liveSmoke = {}) {
  const error = liveSmoke.error || liveSmoke.detail?.error || liveSmoke.detail?.lastError;
  const summary = providerFailureSummary(error);
  return summary ? ` (${summary})` : '';
}

function providerFailureSummary(error) {
  return operationalErrorSummary(error);
}

function webhookNextActions(readiness = {}) {
  const blockers = readiness.productionBlockers || [];
  const actions = [];
  const publicUrlProviders = [];

  for (const [provider, row] of Object.entries(readiness.webhooks || {})) {
    if (!row?.required) continue;
    const secret = webhookSecretEnv(provider);
    const label = webhookProviderLabel(provider);
    const endpoint = webhookEndpointTarget(row, provider);
    const reasons = row.blockerReasons || [];
    const missingSecret = secret && reasons.some((reason) => reason.includes(secret));
    const publicUrlMissing = reasons.some((reason) => reason.includes('APP_PUBLIC_URL'))
      || blockers.some((blocker) => blocker.includes('APP_PUBLIC_URL'));
    const freshnessMissing = blockers.some((blocker) => (
      blocker.includes(`${provider} webhook freshness has not been proven`)
      || blocker.includes(`${provider} webhook has not been received`)
    ));

    if (missingSecret) {
      actions.push(`set ${secret} and register ${label} webhook endpoint ${endpoint}`);
    }
    if (publicUrlMissing) {
      publicUrlProviders.push(provider);
    }
    if (!missingSecret && !publicUrlMissing && freshnessMissing) {
      actions.push(`deliver a test ${label} webhook to ${endpoint} and rerun npm run check:production to prove freshness`);
    }
  }

  if (publicUrlProviders.length) {
    const endpoints = publicUrlProviders.map(webhookPath).join(', ');
    actions.unshift(`set APP_PUBLIC_URL to the public https origin before registering provider webhook endpoints: ${endpoints}`);
  }
  return actions;
}

function webhookSecretEnv(provider) {
  if (provider === 'agentphone') return 'AGENTPHONE_WEBHOOK_SECRET';
  if (provider === 'agentmail') return 'AGENTMAIL_WEBHOOK_SECRET';
  if (provider === 'stripe') return 'STRIPE_WEBHOOK_SECRET';
  return null;
}

function webhookProviderLabel(provider) {
  if (provider === 'agentphone') return 'AgentPhone';
  if (provider === 'agentmail') return 'AgentMail';
  if (provider === 'stripe') return 'Stripe';
  return provider;
}

function webhookEndpointTarget(row = {}, provider) {
  const endpoint = row.endpoint || '';
  try {
    const url = new URL(endpoint);
    const localHost = ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
    if (url.protocol === 'https:' && !localHost) return endpoint;
  } catch {}
  return `APP_PUBLIC_URL${webhookPath(provider)}`;
}

function webhookPath(provider) {
  return `/api/webhooks/${provider}`;
}

export function buildProviderProofMatrix({
  readiness = {},
  observability = {}
} = {}) {
  const providers = readiness.providers || {};
  const providerNames = unique([...Object.keys(providers), ...PRODUCTION_REQUIRED_PROVIDERS]);
  const costsByProvider = providerCostMap(observability.providerCosts || []);
  const sloByProvider = new Map((observability.providerHealthSlo?.providers || [])
    .map((row) => [row.provider, row]));
  const recentFailureByProvider = new Map();
  for (const event of observability.recentProviderFailures || []) {
    if (event?.provider && !recentFailureByProvider.has(event.provider)) {
      recentFailureByProvider.set(event.provider, event);
    }
  }

  return providerNames.map((provider) => {
    const row = providers[provider] || {};
    const drySource = row.dryRunSmoke?.status !== 'not_run' ? row.dryRunSmoke : row.smoke;
    const liveSource = row.liveSmoke || {};
    const webhook = providerWebhook(provider, readiness.webhooks || {});
    const slo = sloByProvider.get(provider) || null;
    const cost = costsByProvider.get(provider) || null;
    const recentFailure = recentFailureByProvider.get(provider) || null;
    const dryRun = compactProofSmoke(drySource, { dryRun: true });
    const liveSmoke = compactProofSmoke(liveSource, { live: true });
    const blockers = unique([
      ...(row.blockerReasons || []),
      ...(slo?.blockers || []),
      ...(webhook?.required && !webhook.configured ? webhook.blockerReasons || [] : []),
      row.required && !liveSmoke.verified ? `${provider} live smoke has not passed` : null,
      row.required && liveSmoke.verified && !liveSmoke.fresh ? `${provider} live smoke is stale` : null
    ]);
    const lastError = row.lastError
      || liveSmoke.error
      || dryRun.error
      || (recentFailure?.error ? operationalErrorSummary(recentFailure.error) : null);

    return {
      provider,
      requiredForProduction: PRODUCTION_REQUIRED_PROVIDERS.has(provider),
      configured: !!row.configured,
      status: providerProofStatus({ row, blockers, dryRun, liveSmoke }),
      dryRun,
      liveSmoke,
      webhook: webhook ? {
        configured: !!webhook.configured,
        status: webhook.status || null,
        fresh: !!webhook.freshness?.fresh,
        lastReceivedAt: webhook.freshness?.lastReceivedAt || null,
        endpoint: webhook.endpoint || null
      } : null,
      slo: slo ? {
        ok: slo.ok !== false,
        issueCount: slo.issueCount || 0,
        issueRatePct: slo.issueRatePct || 0,
        avgDurationMs: slo.avgDurationMs ?? null,
        lastCheckedAt: slo.lastCheckedAt || null
      } : null,
      cost: {
        events24h: cost?.events || 0,
        costUsd24h: cost?.costUsd || 0,
        units24h: cost?.units || 0,
        lastAt: cost?.lastAt || null
      },
      lastError: lastError ? operationalErrorSummary(lastError) : null,
      blockers,
      nextAction: providerProofNextAction({ provider, row, liveSmoke, blockers })
    };
  });
}

export function buildSafeToSellDecisionReceipt(report = {}) {
  const providerProof = report.providerProof || [];
  const requiredProviderProof = providerProof.filter((row) => row.requiredForProduction !== false);
  const liveReady = requiredProviderProof.filter((row) => row.liveSmoke?.verified && row.liveSmoke?.fresh);
  const blockedProviders = requiredProviderProof.filter((row) => (row.blockers || []).length || ['blocked', 'missing_credentials'].includes(row.status));
  const missingCredentials = requiredProviderProof.filter((row) => row.configured === false || row.status === 'missing_credentials');
  const stillBlocked = report.stillBlocked || [];
  const promotionGates = report.promotionGates || report.readiness?.promotionGates || {};
  const observability = report.observability || {};
  const backup = report.backups || report.backup || {};
  const evals = report.evals || {};
  const evalSummary = evals.summary || {};

  return {
    generatedAt: report.generatedAt || new Date().toISOString(),
    command: report.command || 'npm run safe-to-sell',
    mode: report.mode || null,
    decision: report.ok ? 'safe_to_sell' : 'hold',
    ok: !!report.ok,
    durable: false,
    snapshotId: report.snapshot?.id || null,
    proof: {
      dryRunVerified: report.dryRunVerified?.length || 0,
      liveSmokeVerified: report.liveSmokeVerified?.length || 0,
      requiredProviders: requiredProviderProof.length,
      requiredLiveReady: liveReady.length,
      blockedProviders: blockedProviders.length,
      missingCredentialProviders: missingCredentials.length
    },
    gates: {
      evals: evals.ok === true,
      backup: backup.ok === true,
      economics: (observability.economicsHealth || report.economicsHealth)?.ok !== false,
      providers: (observability.providerHealthSlo || report.providerHealthSlo)?.ok !== false,
      workers: (observability.workerHealthSlo || report.workerHealthSlo)?.ok !== false,
      schedulers: (observability.schedulerHealth || report.schedulerHealth)?.ok !== false,
      productionReview: promotionGates.productionReview?.ok === true,
      productionLive: promotionGates.productionLive?.ok === true
    },
    evals: {
      passed: evalSummary.passed || 0,
      total: evalSummary.total || 0,
      failed: evalSummary.failed || 0,
      skipped: evalSummary.skipped || 0
    },
    economics: observability.dailyEconomics || report.economics || null,
    blockerCount: stillBlocked.length,
    topBlockers: stillBlocked.slice(0, 8),
    providerBlockers: blockedProviders.slice(0, 8).map((row) => ({
      provider: row.provider,
      status: row.status || 'unknown',
      live: row.liveSmoke?.status || 'not_run',
      blockerCount: row.blockers?.length || 0,
      nextAction: row.nextAction || null
    })),
    nextActions: (report.nextActions || []).slice(0, 8)
  };
}

export function compactSafeToSellReceiptHistory(history) {
  if (!history) return null;
  const recent = (history.recent || []).map(compactSafeToSellReceiptRow).filter(Boolean);
  return redact({
    total: history.total || 0,
    okCount: history.okCount || 0,
    blockedCount: history.blockedCount || 0,
    lastGeneratedAt: history.lastGeneratedAt || null,
    latest: history.latest ? compactSafeToSellReceiptRow(history.latest) : recent[0] || null,
    recent
  });
}

function compactSafeToSellReceiptRow(snapshot) {
  if (!snapshot) return null;
  const report = snapshot.report || {};
  const receipt = report.decisionReceipt || buildSafeToSellDecisionReceipt({
    ...report,
    ok: snapshot.ok,
    mode: snapshot.mode,
    command: snapshot.command,
    generatedAt: report.generatedAt || (snapshot.generatedAt ? new Date(snapshot.generatedAt).toISOString() : null),
    dryRunVerified: report.dryRunVerified || Array.from({ length: snapshot.dryRunCount || 0 }, (_, i) => ({ provider: `dry_${i}` })),
    liveSmokeVerified: report.liveSmokeVerified || Array.from({ length: snapshot.liveSmokeCount || 0 }, (_, i) => ({ provider: `live_${i}` })),
    stillBlocked: report.stillBlocked || Array.from({ length: snapshot.blockerCount || 0 }, (_, i) => `blocked_${i}`)
  });
  return {
    id: snapshot.id,
    ok: !!snapshot.ok,
    mode: snapshot.mode || receipt.mode || null,
    command: snapshot.command || receipt.command || null,
    generatedAt: snapshot.generatedAt || null,
    createdAt: snapshot.createdAt || null,
    decision: receipt.decision || (snapshot.ok ? 'safe_to_sell' : 'hold'),
    snapshotId: receipt.snapshotId || snapshot.id,
    durable: true,
    blockerCount: snapshot.blockerCount ?? receipt.blockerCount ?? 0,
    dryRunCount: snapshot.dryRunCount ?? receipt.proof?.dryRunVerified ?? 0,
    liveSmokeCount: snapshot.liveSmokeCount ?? receipt.proof?.liveSmokeVerified ?? 0,
    requiredProviders: receipt.proof?.requiredProviders || 0,
    requiredLiveReady: receipt.proof?.requiredLiveReady || 0,
    blockedProviders: receipt.proof?.blockedProviders || 0,
    topBlockers: (receipt.topBlockers || []).slice(0, 5),
    nextActions: (receipt.nextActions || []).slice(0, 5)
  };
}

function compactProofSmoke(smoke = {}, { dryRun = false, live = false } = {}) {
  const status = smoke?.status || 'not_run';
  const error = smoke?.error || smoke?.detail?.error || smoke?.detail?.lastError || null;
  return {
    status,
    checkedAt: smoke?.checkedAt || null,
    ageMs: smoke?.ageMs ?? null,
    fresh: !!smoke?.fresh,
    dryRun: !!smoke?.dryRun,
    live: !!smoke?.live,
    verified: live
      ? !!smoke?.live && status === 'ok'
      : dryRun
        ? !!smoke?.dryRun && ['configured', 'ok'].includes(status)
        : status !== 'not_run',
    error: error ? operationalErrorSummary(error) : null
  };
}

function providerProofStatus({ row = {}, blockers = [], dryRun = {}, liveSmoke = {} } = {}) {
  if (!row.configured) return 'missing_credentials';
  if (blockers.length) return 'blocked';
  if (liveSmoke.verified && liveSmoke.fresh) return 'live_ready';
  if (liveSmoke.verified) return 'live_stale';
  if (dryRun.verified) return 'dry_run_ready';
  return 'unverified';
}

function providerProofNextAction({ provider, row = {}, liveSmoke = {}, blockers = [] } = {}) {
  if (!blockers.length) return row.nextAction || 'monitor';
  if (liveSmoke.live && ['failed', 'blocked'].includes(liveSmoke.status)) {
    return `fix ${provider} live smoke failure${liveSmoke.error ? ` (${liveSmoke.error})` : ''} and rerun ${liveSmokeCommand(provider)}`;
  }
  if (blockers.some((blocker) => blocker.includes('live smoke has not passed') || blocker.includes('live smoke is stale'))) {
    return `run ${liveSmokeCommand(provider)} to prove ${provider} live smoke freshness`;
  }
  return row.nextAction || blockers[0];
}

function providerWebhook(provider, webhooks = {}) {
  if (provider === 'agentphone') return webhooks.agentphone || null;
  if (provider === 'agentmail') return webhooks.agentmail || null;
  if (provider === 'stripe') return webhooks.stripe || null;
  return null;
}

function providerCostMap(rows = []) {
  const out = new Map();
  for (const row of rows || []) {
    for (const key of providerCostKeys(row.provider)) out.set(key, row);
  }
  return out;
}

function providerCostKeys(provider) {
  if (provider === 'browser_use') return ['browser_use', 'browserUse'];
  if (provider === 'browserUse') return ['browserUse', 'browser_use'];
  return [provider].filter(Boolean);
}

export function enqueueSafeToSellSelfCheck({
  now = Date.now(),
  intervalMs = env.ops.safeToSellCheckIntervalMs,
  reason = 'scheduler',
  runAt = now
} = {}) {
  const bucketMs = Math.max(60_000, Number(intervalMs) || DAY_MS);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: SAFE_TO_SELL_JOB_TYPE,
    payload: {
      reason,
      source: 'durable_job',
      intervalMs: bucketMs,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: `${SAFE_TO_SELL_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts: 2
  });
}

export function startSafeToSellSelfCheckScheduler({
  enabled = env.ops.safeToSellCheckEnabled,
  intervalMs = env.ops.safeToSellCheckIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(60_000, Number(intervalMs) || DAY_MS);
  if (safeToSellTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason = 'scheduler') => {
    const result = enqueueSafeToSellSelfCheck({ intervalMs: safeInterval, reason });
    log.info('safe_to_sell.self_check_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  safeToSellTimer = setInterval(() => {
    try {
      enqueue('scheduler');
    } catch (err) {
      log.warn('safe_to_sell.scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  safeToSellTimer.unref?.();

  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopSafeToSellSelfCheckScheduler() {
  if (safeToSellTimer) clearInterval(safeToSellTimer);
  safeToSellTimer = null;
  return { running: false };
}

export function printSafeToSellReport(report) {
  console.log('\n=== SAFE TO SELL TODAY ===');
  console.log(`safe: ${report.ok ? 'yes' : 'no'}`);
  console.log(`mode: ${report.mode}`);
  console.log(`evals: ${report.evals.ok ? 'passed' : 'blocked'} (${report.evals.summary?.passed || 0}/${report.evals.summary?.total || 0})`);
  console.log(`backup: ${report.backups.ok ? 'fresh' : report.backups.reason}`);
  console.log(`daily margin: $${report.observability.dailyEconomics.marginUsd} on $${report.observability.dailyEconomics.revenueUsd} revenue`);
  if (report.observability.economicsHealth) {
    console.log(`economics guard: ${report.observability.economicsHealth.ok ? 'healthy' : 'blocked'}`);
  }
  if (report.observability.providerHealthSlo) {
    console.log(`provider SLO: ${report.observability.providerHealthSlo.ok ? 'healthy' : 'blocked'}`);
  }
  if (report.observability.workerHealthSlo) {
    console.log(`worker SLO: ${report.observability.workerHealthSlo.ok ? 'healthy' : 'blocked'}`);
  }
  console.log(`provider health events: ${providerHealthEventCount(report.observability.providerHistory)} (${providerIssueCount(report.observability.providerHistory)} issues)`);
  if (report.observability.schedulerHealth) {
    const scheduler = report.observability.schedulerHealth;
    console.log(`recurring ops jobs: ${scheduler.healthy}/${scheduler.enabled} healthy`);
  }
  if (report.maintenance && !report.maintenance.skipped) {
    const refreshed = Number(report.maintenance.refreshed || 0);
    console.log(`maintenance preflight: ${report.maintenance.ok ? 'healthy' : 'blocked'}${refreshed ? `, refreshed ${refreshed}` : ''}`);
  }
  if (report.snapshot?.id) console.log(`self-check snapshot: ${report.snapshot.id}`);
  if (report.decisionReceipt) {
    const receipt = report.decisionReceipt;
    console.log(`decision receipt: ${receipt.decision || (report.ok ? 'safe_to_sell' : 'hold')}; required live-ready ${receipt.proof?.requiredLiveReady || 0}/${receipt.proof?.requiredProviders || 0}; blockers ${receipt.blockerCount || 0}`);
  }
  console.log(`dry-run verified providers: ${report.dryRunVerified.map((row) => row.provider).join(', ') || 'none'}`);
  console.log(`live-smoke verified providers: ${report.liveSmokeVerified.map((row) => row.provider).join(', ') || 'none'}`);
  printProviderProof(report.providerProof);
  if (report.promotionGates) {
    const review = report.promotionGates.productionReview;
    const live = report.promotionGates.productionLive;
    console.log(`promotion gates: review ${review?.ok ? 'ready' : `blocked (${review?.blockerCount || 0})`}; live ${live?.ok ? 'ready' : `blocked (${live?.blockerCount || 0})`}`);
  }
  if (report.stillBlocked.length) {
    console.log('\nStill blocked:');
    for (const blocker of report.stillBlocked.slice(0, 30)) console.log(`- ${blocker}`);
  }
  if (report.nextActions?.length) {
    console.log('\nNext actions:');
    for (const action of report.nextActions.slice(0, 16)) console.log(`- ${action}`);
  }
}

function printProviderProof(providerProof = []) {
  const requiredRows = (providerProof || []).filter((row) => row.requiredForProduction);
  if (!requiredRows.length) return;
  console.log('Provider proof:');
  for (const row of requiredRows) {
    const parts = [
      `${row.provider}: ${row.status || 'unknown'}`,
      `dry=${providerProofSmokeLabel(row.dryRun)}`,
      `live=${providerProofSmokeLabel(row.liveSmoke)}`,
      `cost=$${Number(row.cost?.costUsd24h || 0).toFixed(2)}/24h`,
      `health=${providerProofHealthLabel(row)}`,
      `next=${row.nextAction || 'monitor'}`
    ];
    console.log(redact(`- ${parts.join('; ')}`));
  }
}

function providerProofSmokeLabel(smoke = {}) {
  if (!smoke || smoke.status === 'not_run') return 'none';
  if (smoke.verified && smoke.fresh) return 'fresh';
  if (smoke.verified) return 'stale';
  return smoke.status || 'unknown';
}

function providerProofHealthLabel(row = {}) {
  const blockerCount = Number(row.blockers?.length || 0);
  if (blockerCount) return `${blockerCount} ${blockerCount === 1 ? 'blocker' : 'blockers'}`;
  if (row.slo && row.slo.ok === false) return 'slo_blocked';
  return 'ok';
}

function runEvalCheck() {
  try {
    const stdout = execFileSync(process.execPath, [join(repoRoot, 'scripts/eval-check.js')], {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return JSON.parse(stdout);
  } catch (err) {
    const stdout = String(err.stdout || '').trim();
    try {
      return JSON.parse(stdout);
    } catch {
      return {
        ok: false,
        summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
        cases: [{
          name: 'eval_check_process',
          category: 'eval_runner',
          ok: false,
          skipped: false,
          error: err?.message || String(err)
        }]
      };
    }
  }
}

function compactSafeToSellHistory(history) {
  if (!history) return null;
  return {
    total: history.total || 0,
    okCount: history.okCount || 0,
    blockedCount: history.blockedCount || 0,
    lastGeneratedAt: history.lastGeneratedAt || null,
    latest: history.latest ? {
      id: history.latest.id,
      ok: history.latest.ok,
      mode: history.latest.mode,
      generatedAt: history.latest.generatedAt,
      blockerCount: history.latest.blockerCount,
      dryRunCount: history.latest.dryRunCount,
      liveSmokeCount: history.latest.liveSmokeCount
    } : null
  };
}

function providerHealthEventCount(rows = []) {
  return rows.reduce((sum, row) => sum + (row.total || 0), 0);
}

function providerIssueCount(rows = []) {
  return rows.reduce((sum, row) => sum + (row.failedCount || 0) + (row.blockedCount || 0) + (row.degradedCount || 0), 0);
}

function maintenanceBlockers(maintenance) {
  if (!maintenance || maintenance.ok !== false) return [];
  const failedJobs = (maintenance.jobs || []).filter((job) => job.status !== 'completed');
  if (failedJobs.length) {
    return failedJobs.map((job) => {
      const detail = job.error || (job.status && job.status !== 'missing' ? `status=${job.status}` : job.status);
      return `safe-to-sell maintenance failed: ${job.type || 'unknown'}${detail ? ` (${detail})` : ''}`;
    });
  }
  if (maintenance.error) return [`safe-to-sell maintenance failed: ${maintenance.error}`];
  return ['safe-to-sell maintenance preflight failed'];
}

function maintenanceNextActions(maintenance) {
  if (!maintenance || maintenance.ok !== false) return [];
  const failedJobs = (maintenance.jobs || []).filter((job) => job.status !== 'completed');
  if (failedJobs.length) {
    return failedJobs.map((job) => `repair and rerun stale ops maintenance job ${job.type || 'unknown'} before launch`);
  }
  return ['repair safe-to-sell maintenance preflight before launch'];
}

function providerSloNextActions(slo = {}) {
  if (!slo || slo.ok !== false) return [];
  const providers = (slo.providers || [])
    .filter((row) => row.ok === false)
    .map((row) => row.provider)
    .filter(Boolean);
  return [
    providers.length
      ? `fix provider health for ${providers.join(', ')} and rerun npm run smoke:providers with the needed SMOKE_* toggles`
      : 'fix provider health SLO blockers and rerun npm run smoke:providers'
  ];
}

function workerSloNextActions(slo = {}, readiness = {}) {
  if (!slo || slo.ok !== false) return [];
  const blockedWorkers = (slo.workers || [])
    .filter((row) => row.ok === false);
  const workers = blockedWorkers
    .map((row) => row.worker)
    .filter(Boolean);
  const jobTypes = (slo.durableJobs || [])
    .filter((row) => row.ok === false)
    .map((row) => row.type)
    .filter(Boolean);
  return [
    ...workerProviderRecoveryNextActions(blockedWorkers, readiness),
    workers.length
      ? `inspect recent worker failures for ${workers.join(', ')} in /api/ops/observability`
      : null,
    jobTypes.length
      ? `drain or repair failing durable job types ${jobTypes.join(', ')} then rerun npm run check:ops`
      : null,
    !workers.length && !jobTypes.length
      ? 'repair worker/job SLO blockers then rerun npm run check:ops'
      : null
  ];
}

function workerProviderRecoveryNextActions(workers = [], readiness = {}) {
  const byProvider = new Map();
  for (const worker of workers) {
    for (const recovery of worker.providerRecovery || []) {
      if (!recovery?.failureCount || recovery.recovered) continue;
      const provider = recovery.provider;
      if (!provider) continue;
      const entry = byProvider.get(provider) || {
        provider,
        workers: new Set(),
        failures: 0,
        incidentBlocked: false,
        liveSmokeOkAt: null,
        latestFailureAt: null
      };
      entry.workers.add(worker.worker);
      entry.failures += Number(recovery.failureCount) || 0;
      entry.incidentBlocked = entry.incidentBlocked || !!recovery.incidentBlocked;
      entry.liveSmokeOkAt = Math.max(entry.liveSmokeOkAt || 0, Number(recovery.liveSmokeOkAt) || 0) || null;
      entry.latestFailureAt = Math.max(entry.latestFailureAt || 0, Number(recovery.latestFailureAt) || 0) || null;
      byProvider.set(provider, entry);
    }
  }
  return [...byProvider.values()].map((entry) => {
    const workerNames = [...entry.workers].filter(Boolean).join(', ');
    const smoke = liveSmokeCommand(entry.provider);
    const verb = entry.liveSmokeOkAt ? 'rerun' : 'run';
    const incident = entry.incidentBlocked ? ' after clearing the runtime incident' : '';
    const suffix = entry.failures === 1 ? 'failure' : 'failures';
    const liveSmoke = readiness.providers?.[entry.provider]?.liveSmoke || {};
    const prefix = liveSmokeFailed(liveSmoke)
      ? `fix ${entry.provider} live smoke failure${liveSmokeErrorSuffix(liveSmoke)} and rerun ${smoke}`
      : `${verb} ${smoke}${incident}`;
    return `${prefix} after the latest ${workerNames} failure to clear ${entry.failures} unrecovered provider-caused worker ${suffix}`;
  });
}

function liveSmokeCommand(provider) {
  const toggles = {
    gemini: 'SMOKE_GEMINI=true',
    supermemory: 'SMOKE_SUPERMEMORY_WRITE=true',
    moss: 'SMOKE_MOSS_INDEX=true',
    agentphone: 'SMOKE_LIVE_CALL=true SMOKE_TEST_PHONE=<owned-number>',
    agentmail: 'SMOKE_AGENTMAIL_SEND=true SMOKE_TEST_EMAIL=<operator-email>',
    stripe: 'SMOKE_STRIPE_INVOICE=true SMOKE_TEST_EMAIL=<operator-email>',
    browserUse: 'SMOKE_BROWSER_USE=true',
    lovable: 'SMOKE_LOVABLE_NAVIGATION=true'
  };
  return `${toggles[provider] || 'SMOKE_<PROVIDER>=true'} npm run smoke:providers -- --provider ${provider}`;
}

function economicsNextActions(health = {}) {
  if (!health || health.ok !== false) return [];
  return ['review /api/economics/by-niche, pause expensive channels, or adjust OPS_* economics thresholds after operator review'];
}

function schedulerNextActions(health = {}) {
  if (!health || health.ok !== false) return [];
  const jobTypes = (health.jobs || [])
    .filter((job) => job.enabled && job.ok === false)
    .map((job) => job.type)
    .filter(Boolean);
  return [
    jobTypes.length
      ? `restart the durable job loop or manually refresh stale recurring jobs: ${jobTypes.join(', ')}`
      : 'restart the durable job loop and verify recurring ops jobs complete'
  ];
}

function stuckNextActions(stuck = {}) {
  const actions = [];
  if (stuck?.jobs) actions.push('run stuck-job recovery and confirm no durable job leases remain stale');
  if (stuck?.builds?.length) actions.push('recover or cancel stuck builds before launch');
  if (stuck?.calls?.length) actions.push('recover or close stuck calls before launch');
  return actions;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
