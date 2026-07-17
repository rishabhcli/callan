/**
 * A/B (or N-arm) experiment harness.
 *
 *   assignArm({ experimentKey, leadId, arms })
 *       Deterministic baseline assignment that persists once per bucket.
 *
 *   assignAdaptiveArm({ experimentKey, leadId, arms })
 *       Balances the baseline sample, then learns which arm to exploit while
 *       retaining deterministic exploration. Existing assignments stay sticky.
 *
 *   recordOutcome({ assignment, outcome, valueCents, idempotencyKey })
 *       Logs a retry-safe outcome row (e.g. 'connected', 'won', 'converted').
 *
 *   rollup(experimentKey)
 *       Returns per-arm assignment count, conversion count, revenue cents.
 */

import crypto from 'node:crypto';
import { experimentAssignments, experimentOutcomes } from './db.js';
import { log } from './logger.js';
import { emit } from './sse.js';

const ASSIGN_PREFIX = 'expa_';
const OUTCOME_PREFIX = 'expo_';

function shortId(prefix) {
  const tail = crypto.randomBytes(6).toString('hex');
  return `${prefix}${Date.now().toString(36)}_${tail}`;
}

function stableId(prefix, value) {
  const digest = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
  return `${prefix}${digest}`;
}

/**
 * Map a bucket-key (usually the lead id) to one of the provided arms via
 * a stable hash so the same input always lands in the same arm.
 */
function pickArm(bucketKey, arms) {
  if (!arms?.length) throw new Error('assignArm requires at least one arm');
  const digest = crypto.createHash('sha256').update(String(bucketKey)).digest();
  const idx = digest.readUInt32BE(0) % arms.length;
  return arms[idx];
}

export function assignArm({ experimentKey, leadId, bucketKey, arms, metadata = null }) {
  if (!experimentKey) throw new Error('assignArm requires experimentKey');
  const key = bucketKey || leadId || crypto.randomBytes(8).toString('hex');
  // If we've already assigned this bucket key, return the prior assignment.
  const existing = experimentAssignments.findByBucket(experimentKey, key);
  if (existing) return existing;
  const arm = pickArm(key, arms);
  const row = experimentAssignments.insert({
    id: shortId(ASSIGN_PREFIX),
    experiment_key: experimentKey,
    lead_id: leadId || null,
    bucket_key: key,
    arm,
    metadata
  });
  log.info('experiment.assigned', { experimentKey, leadId, bucketKey: key, arm });
  emit('experiment.assigned', { experimentKey, leadId, arm });
  return row;
}

/**
 * Assign a sticky arm while learning from completed outcomes across prior leads.
 *
 * The policy first balances every arm to `minSamplesPerArm`. After that it
 * exploits the best Bayesian-smoothed outcome score while reserving a stable
 * exploration slice. Hashing the bucket key makes retries deterministic, and
 * the persisted assignment remains the final authority for a lead.
 */
export function assignAdaptiveArm({
  experimentKey,
  leadId,
  bucketKey,
  arms,
  minSamplesPerArm = 5,
  explorationRate = 0.2,
  metadata = null
}) {
  if (!experimentKey) throw new Error('assignAdaptiveArm requires experimentKey');
  if (!arms?.length) throw new Error('assignAdaptiveArm requires at least one arm');
  const key = bucketKey || leadId || crypto.randomBytes(8).toString('hex');
  const existing = experimentAssignments.findByBucket(experimentKey, key);
  if (existing) return existing;

  const decision = adaptiveArmDecision({
    experimentKey,
    bucketKey: key,
    arms,
    minSamplesPerArm,
    explorationRate
  });
  return assignArm({
    experimentKey,
    leadId,
    bucketKey: key,
    arms: [decision.arm],
    metadata: {
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
      assignmentPolicy: decision.policy,
      minSamplesPerArm: decision.minSamplesPerArm,
      explorationRate: decision.explorationRate,
      selectedScore: decision.selectedScore,
      observed: decision.observed
    }
  });
}

export function adaptiveArmDecision({
  experimentKey,
  bucketKey,
  arms,
  minSamplesPerArm = 5,
  explorationRate = 0.2
}) {
  const sampleFloor = Math.max(1, Math.floor(Number(minSamplesPerArm) || 5));
  const explore = Math.min(1, Math.max(0, Number(explorationRate) || 0));
  const observed = completeRollup(experimentKey, arms);
  const minimumObserved = Math.min(...observed.map((row) => row.assignments));
  const underSampled = observed.filter((row) => row.assignments < sampleFloor);

  let policy;
  let selected;
  if (underSampled.length) {
    policy = 'balanced_baseline';
    const leastSampled = underSampled.filter((row) => row.assignments === minimumObserved);
    selected = leastSampled[pickIndex(`${bucketKey}:baseline`, leastSampled.length)];
  } else if (hashFraction(`${bucketKey}:explore`) < explore) {
    policy = 'explore';
    selected = observed[pickIndex(`${bucketKey}:arm`, observed.length)];
  } else {
    policy = 'exploit';
    selected = [...observed].sort((a, b) => (
      b.adaptiveScore - a.adaptiveScore ||
      b.revenuePerAssignment - a.revenuePerAssignment ||
      arms.indexOf(a.arm) - arms.indexOf(b.arm)
    ))[0];
  }

  return {
    arm: selected.arm,
    policy,
    selectedScore: selected.adaptiveScore,
    minSamplesPerArm: sampleFloor,
    explorationRate: explore,
    observed
  };
}

export function recordOutcome({ assignment, outcome, valueCents = null, metadata = null, idempotencyKey = null }) {
  if (!assignment?.id) {
    log.warn('experiment.outcome.no_assignment', { outcome });
    return { inserted: false, row: null };
  }
  const stableKey = idempotencyKey
    ? `${assignment.id}:${outcome}:${idempotencyKey}`
    : null;
  const result = experimentOutcomes.insert({
    id: stableKey ? stableId(OUTCOME_PREFIX, stableKey) : shortId(OUTCOME_PREFIX),
    assignment_id: assignment.id,
    experiment_key: assignment.experiment_key,
    arm: assignment.arm,
    outcome,
    value_cents: valueCents ?? null,
    metadata
  });
  if (result?.inserted !== false) {
    emit('experiment.outcome', {
      experimentKey: assignment.experiment_key,
      arm: assignment.arm,
      outcome,
      valueCents: valueCents ?? null
    });
  }
  return result;
}

export function rollup(experimentKey) {
  return experimentOutcomes.rollup(experimentKey).map(normalizeRollupRow);
}

export function listExperimentKeys() {
  return experimentOutcomes.listKeys();
}

/**
 * Convenience: fetch the lead's current arm for a given experiment without
 * needing the bucket key. Returns null when the lead has never been assigned.
 */
export function currentArmForLead(experimentKey, leadId) {
  if (!leadId) return null;
  return experimentAssignments.findForLead(experimentKey, leadId);
}

function completeRollup(experimentKey, arms) {
  const rows = new Map(rollup(experimentKey).map((row) => [row.arm, row]));
  return arms.map((arm) => rows.get(arm) || normalizeRollupRow({ arm }));
}

function normalizeRollupRow(row) {
  const assignments = Number(row.assignments) || 0;
  const connections = Number(row.connections) || 0;
  const wins = Number(row.wins) || 0;
  const losses = Number(row.losses) || 0;
  const callbacks = Number(row.callbacks) || 0;
  const unreachable = Number(row.unreachable) || 0;
  const conversions = Number(row.conversions) || 0;
  const revenueCents = Number(row.revenue_cents ?? row.revenueCents) || 0;
  const trials = Math.max(connections, conversions, wins, assignments);
  const paidWins = Math.min(conversions, trials);
  const verbalOnlyWins = Math.max(0, Math.min(wins, trials) - paidWins);
  const weightedSuccesses = paidWins + verbalOnlyWins * 0.35;
  const adaptiveScore = (weightedSuccesses + 1) / (trials + 2);
  return {
    arm: row.arm,
    assignments,
    connections,
    wins,
    losses,
    callbacks,
    unreachable,
    conversions,
    conversionRate: trials ? conversions / trials : 0,
    winRate: trials ? wins / trials : 0,
    revenueCents,
    revenuePerAssignment: assignments ? revenueCents / assignments : 0,
    adaptiveScore
  };
}

function pickIndex(value, length) {
  if (length <= 1) return 0;
  const digest = crypto.createHash('sha256').update(String(value)).digest();
  return digest.readUInt32BE(0) % length;
}

function hashFraction(value) {
  const digest = crypto.createHash('sha256').update(String(value)).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}
