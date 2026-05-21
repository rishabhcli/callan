import { enqueueJob } from './jobs.js';
import { emit } from './sse.js';
import { generateGrowthPlanForLead, sendGrowthRecap } from './growth/index.js';

export const GROWTH_PLAN_JOB_TYPE = 'growth.plan';
export const GROWTH_FOLLOWUP_JOB_TYPE = 'growth.followup';

export function enqueueGrowthPlanJob({
  leadId,
  force = false,
  source = 'operator',
  runAt = Date.now(),
  maxAttempts = 5,
  idempotencyKey = null
} = {}) {
  if (!leadId) throw new Error('enqueueGrowthPlanJob requires leadId');
  const bucket = Math.floor(Number(runAt || Date.now()) / 60_000);
  const stableKey = idempotencyKey || `growth.plan:${leadId}:${force ? `force:${source}:${bucket}` : 'latest'}`;
  const result = enqueueJob({
    type: GROWTH_PLAN_JOB_TYPE,
    payload: { leadId, force: Boolean(force), source },
    idempotencyKey: stableKey,
    runAt,
    maxAttempts
  });
  emit(result.inserted ? 'growth.plan_queued' : 'growth.plan_duplicate', {
    worker: 'growth',
    leadId,
    jobId: result.row?.id || null,
    status: result.row?.status || null,
    force: Boolean(force),
    source,
    duplicate: !result.inserted
  });
  return result;
}

export function enqueueGrowthFollowupJob({
  leadId,
  toEmail = null,
  force = false,
  source = 'operator',
  runAt = Date.now(),
  maxAttempts = 5,
  idempotencyKey = null
} = {}) {
  if (!leadId) throw new Error('enqueueGrowthFollowupJob requires leadId');
  const bucket = Math.floor(Number(runAt || Date.now()) / 60_000);
  const recipientKey = toEmail ? String(toEmail).trim().toLowerCase() : 'default';
  const stableKey = idempotencyKey || `growth.followup:${leadId}:${recipientKey}:${force ? `force:${source}:${bucket}` : 'latest'}`;
  const result = enqueueJob({
    type: GROWTH_FOLLOWUP_JOB_TYPE,
    payload: { leadId, toEmail: toEmail || null, force: Boolean(force), source },
    idempotencyKey: stableKey,
    runAt,
    maxAttempts
  });
  emit(result.inserted ? 'growth.followup_queued' : 'growth.followup_duplicate', {
    worker: 'growth',
    leadId,
    jobId: result.row?.id || null,
    status: result.row?.status || null,
    force: Boolean(force),
    source,
    duplicate: !result.inserted
  });
  return result;
}

export async function handleGrowthPlanJob(payload = {}) {
  const result = await generateGrowthPlanForLead({
    leadId: payload.leadId,
    force: payload.force === true,
    source: payload.source || 'durable_job'
  });
  return {
    ok: true,
    leadId: payload.leadId,
    growthPlanId: result?.row?.id || null,
    nextRecommendedService: result?.offers?.nextRecommendedService?.id || null,
    evidenceCount: result?.plan?.evidence?.length || 0
  };
}

export async function handleGrowthFollowupJob(payload = {}) {
  const result = await sendGrowthRecap({
    leadId: payload.leadId,
    toEmail: payload.toEmail || undefined,
    force: payload.force === true
  });
  return {
    ok: true,
    leadId: payload.leadId,
    status: result?.status || null,
    followupId: result?.followup?.id || null,
    reused: Boolean(result?.reused),
    reason: result?.reason || null
  };
}
