import { enqueueJob } from './jobs.js';
import { transferCallToOperator } from './operatorTransfer.js';

export const OPERATOR_TRANSFER_JOB_TYPE = 'operator.transfer';

export function enqueueOperatorTransferJob({
  providerCallId = null,
  leadId = null,
  callId = null,
  reason = null,
  source = 'caller',
  eventId = null,
  runAt = Date.now(),
  maxAttempts = 3
} = {}) {
  const dedupeId = callId || providerCallId;
  if (!dedupeId) throw new Error('callId or providerCallId is required for operator transfer');
  const payload = {
    providerCallId,
    leadId,
    callId,
    reason,
    source,
    eventId
  };
  return enqueueJob({
    type: OPERATOR_TRANSFER_JOB_TYPE,
    payload,
    idempotencyKey: `operator-transfer:${dedupeId}`,
    runAt,
    maxAttempts
  });
}

export async function handleOperatorTransferJob(payload = {}) {
  return transferCallToOperator({
    providerCallId: payload.providerCallId || null,
    leadId: payload.leadId || null,
    callId: payload.callId || null,
    reason: payload.reason || payload.source || 'operator_transfer_job'
  });
}
