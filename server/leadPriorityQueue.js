import { applyPriorityToLead } from './leadPriority.js';
import { enqueueJob } from './jobs.js';
import { emit } from './sse.js';

export const LEAD_PRIORITY_SCORE_JOB_TYPE = 'lead.priority_score';

export function enqueueLeadPriorityScore({
  leadId,
  source = 'research',
  runId = null,
  runAt = Date.now(),
  maxAttempts = 3,
  idempotencyKey = null
} = {}) {
  if (!leadId) throw new Error('enqueueLeadPriorityScore requires leadId');
  const stableKey = idempotencyKey || `lead.priority_score:${leadId}:${source}:${runId || 'latest'}`;
  const result = enqueueJob({
    type: LEAD_PRIORITY_SCORE_JOB_TYPE,
    payload: {
      leadId,
      source,
      runId: runId || null
    },
    idempotencyKey: stableKey,
    runAt,
    maxAttempts
  });
  emit(result.inserted ? 'lead.priority_queued' : 'lead.priority_duplicate', {
    worker: 'leadPriority',
    leadId,
    source,
    runId: runId || null,
    jobId: result.row?.id || null,
    duplicate: !result.inserted
  });
  return result;
}

export async function handleLeadPriorityScoreJob(payload = {}) {
  const score = applyPriorityToLead(payload.leadId);
  if (score === null || score === undefined) {
    return {
      ok: false,
      skipped: true,
      reason: 'lead_not_found_or_score_failed',
      leadId: payload.leadId || null
    };
  }
  emit('lead.priority_scored', {
    worker: 'leadPriority',
    leadId: payload.leadId,
    score,
    source: payload.source || 'durable_job',
    runId: payload.runId || null
  });
  return {
    ok: true,
    leadId: payload.leadId,
    score,
    source: payload.source || 'durable_job',
    runId: payload.runId || null
  };
}
