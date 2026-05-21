import { enqueueJob } from './jobs.js';

export const MAIL_REPLY_JOB_TYPE = 'mail.reply';

export function enqueueMailReplyJob({
  body = {},
  normalized = null,
  eventId = null,
  source = 'agentmail',
  idempotencyKey = null,
  runAt = Date.now(),
  maxAttempts = 5
} = {}) {
  const payload = {
    body: body || {},
    normalized: normalized || null,
    eventId: eventId || null,
    source
  };
  return enqueueJob({
    type: MAIL_REPLY_JOB_TYPE,
    payload,
    idempotencyKey: idempotencyKey || (eventId ? `agentmail:${eventId}` : null),
    runAt,
    maxAttempts
  });
}
