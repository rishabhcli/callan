import { enqueueJob } from './jobs.js';

export const CALL_ANALYSIS_JOB_TYPE = 'call.analysis';

export function enqueueCallAnalysis({
  leadId,
  callId,
  source = 'call_terminal',
  runAt = Date.now(),
  maxAttempts = 5
} = {}) {
  if (!leadId) throw new Error('enqueueCallAnalysis requires leadId');
  const stableId = callId || `${leadId}:${source}`;
  return enqueueJob({
    type: CALL_ANALYSIS_JOB_TYPE,
    payload: {
      leadId,
      callId: callId || null,
      source
    },
    idempotencyKey: `call.analysis:${stableId}`,
    runAt,
    maxAttempts
  });
}
