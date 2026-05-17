import { builds, payments } from '../db.js';
import { normalizeBuildTarget } from './targets.js';

export function fulfillmentQueueSnapshot({ limit = 25 } = {}) {
  const pendingPayments = payments.listTriggeredBuildsMissingRows?.({ limit }) || [];
  const recoverable = builds.recoverablePaidBuilds?.({ limit }) || [];
  return {
    defaultTarget: normalizeBuildTarget(),
    pendingPaymentTriggers: pendingPayments.length,
    recoverableBuilds: recoverable.length,
    blockedAuthBuilds: recoverable.filter((build) => build.status === 'blocked_auth').length,
    policy: {
      paidInvoice: 'payment build_triggered_at plus builds.trigger_key ensures one build per paid invoice',
      retry: 'queued, failed, or stale running provider errors are recoverable',
      blockedAuth: 'blocked_auth is terminal until an operator retries manually'
    }
  };
}
