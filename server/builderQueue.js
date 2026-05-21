import { enqueueJob } from './jobs.js';
import { emit } from './sse.js';

export const BUILDER_BUILD_JOB_TYPE = 'builder.build';

export function enqueueBuilderBuild({
  leadId,
  buildId = null,
  target = undefined,
  images = [],
  triggerKey = null,
  source = 'operator',
  runAt = Date.now(),
  maxAttempts = 5,
  idempotencyKey = null
} = {}) {
  if (!leadId) throw new Error('enqueueBuilderBuild requires leadId');
  const stableKey = idempotencyKey
    || (triggerKey ? `builder:${triggerKey}` : buildId ? `builder:${buildId}` : null);
  const result = enqueueJob({
    type: BUILDER_BUILD_JOB_TYPE,
    payload: {
      leadId,
      buildId: buildId || undefined,
      target,
      images: Array.isArray(images) ? images : [],
      triggerKey: triggerKey || null,
      source
    },
    idempotencyKey: stableKey,
    runAt,
    maxAttempts
  });
  emit(result.inserted ? 'builder.queued' : 'builder.duplicate', {
    worker: 'builder',
    leadId,
    buildId,
    target: target || 'default',
    jobId: result.row?.id || null,
    status: result.row?.status || null,
    source,
    duplicate: !result.inserted
  });
  return result;
}

export function enqueuePreviewBuilderBuild({
  leadId,
  target = undefined,
  threadId = null,
  messageId = null,
  toEmail = null,
  businessName = null,
  source = 'mailer.preview_kickoff',
  runAt = Date.now(),
  maxAttempts = 5,
  idempotencyKey = null
} = {}) {
  if (!leadId) throw new Error('enqueuePreviewBuilderBuild requires leadId');
  const stableMessage = messageId || threadId || 'latest';
  const result = enqueueJob({
    type: BUILDER_BUILD_JOB_TYPE,
    payload: {
      leadId,
      buildId: `bld_preview_${leadId}`,
      target,
      images: [],
      source,
      previewBuild: true,
      previewEmail: {
        threadId: threadId || null,
        messageId: messageId || null,
        toEmail: toEmail || null,
        businessName: businessName || null
      }
    },
    idempotencyKey: idempotencyKey || `builder:preview:${leadId}:${stableMessage}`,
    runAt,
    maxAttempts
  });
  emit(result.inserted ? 'builder.preview_queued' : 'builder.preview_duplicate', {
    worker: 'builder',
    leadId,
    buildId: `bld_preview_${leadId}`,
    jobId: result.row?.id || null,
    status: result.row?.status || null,
    source,
    threadId: threadId || null,
    messageId: messageId || null,
    duplicate: !result.inserted
  });
  return result;
}
