/**
 * A/B (or N-arm) experiment harness.
 *
 *   assignArm({ experimentKey, leadId, arms })
 *       Deterministic hash on leadId so the same lead always lands in the same arm.
 *       Persists the assignment row once; subsequent calls return the same arm.
 *
 *   recordOutcome({ assignmentId, outcome, valueCents })
 *       Logs an outcome row (e.g. 'connected', 'converted', 'opted_out').
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

export function recordOutcome({ assignment, outcome, valueCents = null, metadata = null }) {
  if (!assignment?.id) {
    log.warn('experiment.outcome.no_assignment', { outcome });
    return;
  }
  experimentOutcomes.insert({
    id: shortId(OUTCOME_PREFIX),
    assignment_id: assignment.id,
    experiment_key: assignment.experiment_key,
    arm: assignment.arm,
    outcome,
    value_cents: valueCents ?? null,
    metadata
  });
  emit('experiment.outcome', {
    experimentKey: assignment.experiment_key,
    arm: assignment.arm,
    outcome,
    valueCents: valueCents ?? null
  });
}

export function rollup(experimentKey) {
  return experimentOutcomes.rollup(experimentKey).map((r) => ({
    arm: r.arm,
    assignments: r.assignments || 0,
    conversions: r.conversions || 0,
    conversionRate: r.assignments ? (r.conversions || 0) / r.assignments : 0,
    revenueCents: r.revenue_cents || 0,
    revenuePerAssignment: r.assignments ? (r.revenue_cents || 0) / r.assignments : 0
  }));
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
