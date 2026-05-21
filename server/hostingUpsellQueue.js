import { leads } from './db.js';
import { enqueueJob } from './jobs.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { sendHostingUpsellEmail } from './hostingSubscription.js';

export const HOSTING_UPSELL_JOB_TYPE = 'hosting.upsell';

export function enqueueHostingUpsell({
  leadId,
  buildId = null,
  runId = null,
  projectUrl = null,
  target = null,
  mock = false,
  source = 'builder.done',
  runAt = Date.now(),
  maxAttempts = 5,
  idempotencyKey = null
} = {}) {
  if (!leadId) throw new Error('enqueueHostingUpsell requires leadId');
  const stableKey = idempotencyKey || `hosting.upsell:${leadId}:${buildId || 'latest'}`;
  const result = enqueueJob({
    type: HOSTING_UPSELL_JOB_TYPE,
    payload: {
      leadId,
      buildId: buildId || null,
      runId: runId || null,
      projectUrl: projectUrl || null,
      target: target || null,
      mock: Boolean(mock),
      source
    },
    idempotencyKey: stableKey,
    runAt,
    maxAttempts
  });
  emit(result.inserted ? 'builder.hosting_upsell_queued' : 'builder.hosting_upsell_duplicate', {
    worker: 'builder',
    leadId,
    buildId: buildId || null,
    runId: runId || null,
    projectUrl: projectUrl || null,
    target: target || null,
    jobId: result.row?.id || null,
    status: result.row?.status || null,
    duplicate: !result.inserted,
    source
  });
  return result;
}

export async function handleHostingUpsellJob(payload = {}, job = null, { sendFn = sendHostingUpsellEmail } = {}) {
  const leadId = payload.leadId;
  if (!leadId) return { ok: false, skipped: true, reason: 'missing_lead_id' };

  const lead = leads.get(leadId);
  if (!lead) return { ok: false, skipped: true, reason: 'lead_not_found', leadId };
  if (lead.subscription_id) {
    return { ok: true, skipped: true, reason: 'already_subscribed', leadId };
  }

  const result = await sendFn({ leadId, lead });
  if (result?.sent) {
    emit('builder.hosting_upsell_sent', {
      worker: 'builder',
      leadId,
      buildId: payload.buildId || null,
      runId: payload.runId || null,
      target: payload.target || null,
      projectUrl: payload.projectUrl || null,
      mock: Boolean(payload.mock),
      messageId: result.messageId || null,
      threadId: result.threadId || null,
      jobId: job?.id || null
    });
    return {
      ok: true,
      sent: true,
      leadId,
      buildId: payload.buildId || null,
      messageId: result.messageId || null,
      threadId: result.threadId || null,
      acceptUrl: result.acceptUrl || null
    };
  }

  const reason = result?.reason || 'unknown';
  const error = result?.error || null;
  emit('builder.hosting_upsell_skipped', {
    worker: 'builder',
    leadId,
    buildId: payload.buildId || null,
    runId: payload.runId || null,
    target: payload.target || null,
    projectUrl: payload.projectUrl || null,
    mock: Boolean(payload.mock),
    reason,
    error,
    jobId: job?.id || null
  });

  if (reason === 'send_failed') {
    const retryError = new Error(`hosting upsell send failed: ${error || 'unknown error'}`);
    retryError.reason = reason;
    retryError.leadId = leadId;
    log.warn('hosting_upsell.retryable_failure', {
      leadId,
      buildId: payload.buildId || null,
      jobId: job?.id || null,
      error: retryError.message
    });
    throw retryError;
  }

  return {
    ok: true,
    sent: false,
    skipped: true,
    leadId,
    buildId: payload.buildId || null,
    reason,
    error
  };
}
