import { env, isProductionAcked, modeAllowsSideEffect, sideEffectFlagEnabled } from './env.js';
import { db, durableJobs, safeToSellReports } from './db.js';
import { currentDurableJobContext } from './jobExecutionContext.js';

const SAFE_TO_SELL_VERSION = 2;
const SAFE_TO_SELL_FRESH_MS = 26 * 60 * 60 * 1000;

const ACTION_TO_SIDE_EFFECT = Object.freeze({
  call: 'calls',
  email: 'emails',
  invoice: 'invoices',
  subscription: 'invoices',
  browser_session: 'browserSessions',
  build: 'builds',
  public_outreach: 'publicOutreach'
});

/**
 * Last-mile policy for requests that can create an external side effect.
 * Queue admission and UI readiness are advisory; this check runs again at the
 * provider boundary, using current pause, budget, launch, and lease state.
 */
export function authorizeLiveSideEffect({
  action,
  leadId = null,
  job = null,
  smoke = false,
  now = Date.now()
} = {}) {
  const execution = currentDurableJobContext();
  const effectiveJob = job || execution?.job || null;
  const effectiveLeadId = leadId || effectiveJob?.payload?.leadId || effectiveJob?.payload?.lead_id || null;
  const sideEffect = ACTION_TO_SIDE_EFFECT[action];
  const blockers = [];

  if (!sideEffect) blockers.push(`unknown live side-effect action: ${action || 'missing'}`);
  if (sideEffect && !modeAllowsSideEffect(sideEffect)) {
    blockers.push(`RUN_MODE=${env.runMode} disallows ${sideEffect}`);
  }
  if (sideEffect && !sideEffectFlagEnabled(sideEffect)) {
    blockers.push(`${sideEffect} live flag is disabled`);
  }

  const pause = globalPauseState();
  if (pause.paused) blockers.push(`emergency stop is active${pause.reason ? `: ${pause.reason}` : ''}`);

  if (execution?.signal?.aborted) blockers.push('durable job execution was canceled');

  const budget = leadCostBudgetStatus(effectiveLeadId);
  if (!budget.ok) blockers.push(budget.reason);

  const lease = jobLeaseStatus(effectiveJob, now);
  if (!lease.ok) blockers.push(lease.reason);

  // Controlled provider smokes have their own explicit toggle/allowlist gates.
  // They must not depend on a safe-to-sell report whose own proof requires the
  // smoke, otherwise the launch sequence becomes circular.
  const safeToSell = smoke ? { ok: true, exempt: true, reason: 'controlled provider smoke' } : safeToSellStatus(now);
  if (!safeToSell.ok) blockers.push(safeToSell.reason);

  return {
    ok: blockers.length === 0,
    action,
    sideEffect,
    leadId: effectiveLeadId,
    mode: env.runMode,
    blockers,
    pause,
    budget,
    lease,
    safeToSell,
    checkedAt: now
  };
}

export function requireLiveSideEffectAuthorization(input = {}) {
  const decision = authorizeLiveSideEffect(input);
  if (decision.ok) return decision;
  const err = new Error(`live side effect blocked: ${decision.blockers.join('; ')}`);
  err.code = 'LIVE_SIDE_EFFECT_BLOCKED';
  err.retryable = decision.pause.paused || decision.lease.reason === 'job lease is no longer owned';
  err.decision = decision;
  throw err;
}

export function globalPauseState() {
  const row = db.prepare(`
    SELECT type, body, created_at
    FROM contact_events
    WHERE channel = 'outreach'
      AND lead_id IS NULL
      AND type IN ('autonomy_paused', 'autonomy_resumed')
    ORDER BY created_at DESC
    LIMIT 1
  `).get();
  return {
    paused: row?.type === 'autonomy_paused',
    reason: row?.body || null,
    updatedAt: row?.created_at || null
  };
}

function safeToSellStatus(now) {
  if (env.runMode !== 'production_live') {
    return { ok: true, required: false, reason: null, snapshotId: null };
  }
  if (!isProductionAcked()) {
    return { ok: false, required: true, reason: 'production live acknowledgement is missing', snapshotId: null };
  }
  const snapshot = safeToSellReports.latest();
  if (!snapshot) {
    return { ok: false, required: true, reason: 'safe-to-sell snapshot is missing', snapshotId: null };
  }
  if (!safeToSellReports.verify(snapshot.id)) {
    return { ok: false, required: true, reason: 'safe-to-sell snapshot signature is invalid', snapshotId: snapshot.id };
  }
  const ageMs = Math.max(0, now - Number(snapshot.generatedAt || 0));
  if (snapshot.report?.version !== SAFE_TO_SELL_VERSION) {
    return { ok: false, required: true, reason: 'safe-to-sell policy version is stale', snapshotId: snapshot.id, ageMs };
  }
  if (!snapshot.ok || snapshot.report?.ok !== true) {
    return { ok: false, required: true, reason: 'latest safe-to-sell decision is blocked', snapshotId: snapshot.id, ageMs };
  }
  if (snapshot.mode !== 'production_live' || snapshot.report?.mode !== 'production_live') {
    return { ok: false, required: true, reason: 'safe-to-sell snapshot was not issued for production_live', snapshotId: snapshot.id, ageMs };
  }
  if (ageMs > SAFE_TO_SELL_FRESH_MS) {
    return { ok: false, required: true, reason: 'safe-to-sell snapshot is stale', snapshotId: snapshot.id, ageMs };
  }
  return { ok: true, required: true, reason: null, snapshotId: snapshot.id, ageMs };
}

function leadCostBudgetStatus(leadId) {
  const limitUsd = Math.max(0, Number(env.ops.economicsMaxCostPerLeadUsd) || 0);
  if (!leadId || !limitUsd) return { ok: true, enforced: false, leadId, limitUsd };
  const row = db.prepare(`
    SELECT COALESCE(SUM(usd_micros), 0) AS micros
    FROM lead_costs
    WHERE lead_id = ?
  `).get(leadId);
  const spentUsd = Number(row?.micros || 0) / 1_000_000;
  return spentUsd < limitUsd
    ? { ok: true, enforced: true, leadId, spentUsd, limitUsd }
    : {
        ok: false,
        enforced: true,
        leadId,
        spentUsd,
        limitUsd,
        reason: `per-lead cost ceiling reached (${spentUsd.toFixed(2)}/${limitUsd.toFixed(2)} USD)`
      };
}

function jobLeaseStatus(job, now) {
  if (!job?.id || !job?.locked_by || !job?.lease_generation) {
    return { ok: true, required: false, reason: null };
  }
  const owned = durableJobs.ownsLease({
    id: job.id,
    workerId: job.locked_by,
    leaseGeneration: job.lease_generation,
    now
  });
  return owned
    ? { ok: true, required: true, jobId: job.id, leaseGeneration: job.lease_generation, reason: null }
    : { ok: false, required: true, jobId: job.id, leaseGeneration: job.lease_generation, reason: 'job lease is no longer owned' };
}
