import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { accountTasks, calls, db, durableJobs, portfolioOperatingModel, providerSmoke, safeToRenewPlaybooks, safeToRenewReports, safeToSellReports, scheduledCalls, workflowInstances, workflowReplayReceipts } from './db.js';
import { env } from './env.js';
import { drainDurableJobsOnce, enqueueJob } from './jobs.js';
import { log, redact } from './logger.js';
import { containsRawSecret } from './secretRedaction.js';
import { recordProviderPosture } from './providerPosture.js';
import { isProviderRuntimeError, providerRuntimeIncident } from './providerIncidents.js';
import { operationalErrorSummary } from './operationalErrors.js';
import { ACCOUNT_MANAGER_RUN_JOB_TYPE, enqueueAccountManagerRun, handleAccountManagerRunJob } from './accountManager/scheduler.js';
import { SAFE_TO_RENEW_JOB_TYPE, runSafeToRenewSelfCheck } from './safeToRenew.js';
import {
  RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE,
  RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE,
  RENEWAL_CUSTOMER_CONFIRMATION_CLOSEOUT_PACKET_ACTION_TYPE,
  RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE,
  RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE,
  RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE,
  summarizeRenewalBillingExecutionReceiptQueue,
  summarizeRenewalBillingChangePreflightQueue,
  summarizeRenewalCustomerConfirmationAcceptanceQueue,
  summarizeRenewalCustomerConfirmationAcknowledgementQueue,
  summarizeRenewalCustomerConfirmationCloseoutPacketQueue,
  summarizeRenewalCustomerConfirmationFollowupQueue,
  summarizeRenewalCustomerConfirmationQueue,
  summarizeRenewalCustomerMessageSendReceiptQueue,
  summarizeRenewalCustomerMessagePreflightQueue,
  summarizeRenewalChangeRequestQueue
} from './customerPortal.js';

const BACKUP_PREFIX = 'callan-backup-';
const HOUR_MS = 60 * 60 * 1000;
const MIN_SCHEDULER_FRESH_MS = 15 * 60 * 1000;
const WORKER_PROVIDER_DEPENDENCIES = {
  analyst: ['gemini'],
  caller: ['agentphone'],
  scheduledCaller: ['agentphone'],
  mailer: ['agentmail'],
  mailReply: ['agentmail'],
  builder: ['browserUse', 'lovable'],
  scraper: ['browserUse'],
  account_manager: ['agentmail', 'supermemory'],
  hostingSubscription: ['stripe']
};
export const OPS_BACKUP_JOB_TYPE = 'ops.backup';
export const OPS_PROVIDER_POSTURE_JOB_TYPE = 'ops.provider_posture';
export const OPS_RECOVER_STUCK_JOB_TYPE = 'ops.recover_stuck';
export const OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE = 'ops.retention_command_lease_maintenance';
const OPS_SAFE_TO_SELL_JOB_TYPE = 'ops.safe_to_sell';
let backupTimer = null;
let providerPostureTimer = null;
let recoveryTimer = null;
let retentionCommandLeaseMaintenanceTimer = null;

export function redactPii(value) {
  return redact(value);
}

function parseOpsJson(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseOpsJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeOpsBlockerCode(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '');
}

function formatOpsLabel(value) {
  const key = normalizeOpsBlockerCode(value);
  if (!key) return 'Proof';
  return key.split(/[_:-]+/g).filter(Boolean).map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(' ');
}

function toOpsIsoDate(value) {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function buildOpsMergeQueueConsolidatedBlockerRemediationActions({ warnings, escrow }) {
  const actions = [];
  if (warnings.includes('post_ledger_operator_release_attestation_missing')) {
    actions.push({
      code: 'restore_post_ledger_operator_release_attestation_receipt',
      missingReceiptId: escrow.merge_queue_post_ledger_operator_release_attestation_receipt_id || null,
      sourceTable: 'portfolio_eval_merge_queue_post_ledger_operator_release_attestation_receipts',
      operatorAction: 'restore_or_replay_parent_attestation_before_release_review',
      releaseBlockedUntilResolved: true
    });
  }
  if (warnings.includes('final_blocker_ledger_missing')) {
    actions.push({
      code: 'restore_final_blocker_ledger_receipt',
      missingReceiptId: escrow.merge_queue_final_blocker_ledger_receipt_id || null,
      sourceTable: 'portfolio_eval_merge_queue_final_blocker_ledger_receipts',
      operatorAction: 'restore_or_replay_final_blocker_ledger_before_release_review',
      releaseBlockedUntilResolved: true
    });
  }
  if (warnings.includes('live_merge_authorization_missing')) {
    actions.push({
      code: 'restore_live_merge_authorization_receipt',
      missingReceiptId: escrow.live_merge_authorization_receipt_id || null,
      sourceTable: 'portfolio_eval_live_merge_authorization_receipts',
      operatorAction: 'restore_or_replay_live_merge_authorization_preflight_before_release_review',
      releaseBlockedUntilResolved: true
    });
  }
  return actions;
}

export function buildOpsMergeQueueConsolidatedBlockerAudits(tables, limit) {
  const escrows = tables.portfolioEvalMergeQueuePostAttestationReleaseEscrowReceipts || [];
  const attestations = tables.portfolioEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipts || [];
  const ledgers = tables.portfolioEvalMergeQueueFinalBlockerLedgerReceipts || [];
  const authorizations = tables.portfolioEvalLiveMergeAuthorizationReceipts || [];
  return escrows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200))).map((escrow) => {
    const response = parseOpsJson(escrow.response_json);
    const attestation = attestations.find((item) => item.id === escrow.merge_queue_post_ledger_operator_release_attestation_receipt_id) || null;
    const ledger = ledgers.find((item) => item.id === escrow.merge_queue_final_blocker_ledger_receipt_id) || null;
    const authorization = authorizations.find((item) => item.id === escrow.live_merge_authorization_receipt_id) || null;
    const sourceReceipts = [
      { kind: 'post_attestation_release_escrow', id: escrow.id, table: 'portfolio_eval_merge_queue_post_attestation_release_escrow_receipts' },
      attestation ? { kind: 'post_ledger_operator_release_attestation', id: attestation.id, table: 'portfolio_eval_merge_queue_post_ledger_operator_release_attestation_receipts' } : null,
      ledger ? { kind: 'final_blocker_ledger', id: ledger.id, table: 'portfolio_eval_merge_queue_final_blocker_ledger_receipts' } : null,
      authorization ? { kind: 'live_merge_authorization', id: authorization.id, table: 'portfolio_eval_live_merge_authorization_receipts' } : null
    ].filter(Boolean);
    const warnings = [];
    if (!attestation) warnings.push('post_ledger_operator_release_attestation_missing');
    if (!ledger) warnings.push('final_blocker_ledger_missing');
    if (!authorization) warnings.push('live_merge_authorization_missing');
    const remediationActions = buildOpsMergeQueueConsolidatedBlockerRemediationActions({ warnings, escrow });
    const blockerCodes = [...new Set([
      ...(Array.isArray(response.remainingBlockers) ? response.remainingBlockers : []),
      'post_attestation_release_escrow_held_by_final_blocker_ledger',
      'operator_release_blocked_by_final_blocker_ledger',
      'final_blocker_ledger_sealed',
      'runtime_token_release_denied',
      'live_github_http_request',
      'live_merge_execution_attempt'
    ].map(normalizeOpsBlockerCode).filter(Boolean))].sort();
    return {
      key: `merge_queue_consolidated_blocker_audit:${escrow.id}`,
      kind: 'merge_queue_consolidated_blocker_audit',
      status: warnings.length ? 'warning' : 'blocked_release_escrow_held',
      generatedAt: new Date(escrow.updated_at || escrow.created_at || Date.now()).toISOString(),
      releaseEscrowReceiptId: escrow.id,
      postLedgerOperatorReleaseAttestationReceiptId: escrow.merge_queue_post_ledger_operator_release_attestation_receipt_id,
      finalBlockerLedgerReceiptId: escrow.merge_queue_final_blocker_ledger_receipt_id,
      liveMergeAuthorizationReceiptId: escrow.live_merge_authorization_receipt_id,
      serviceBusinessId: escrow.service_business_id || null,
      evalKey: escrow.eval_key,
      sourceReceipts,
      warnings,
      remediationActions,
      remediationActionCount: remediationActions.length,
      blockerCount: blockerCodes.length,
      blockers: blockerCodes.map((code) => ({ code, status: 'blocking', sourceReceiptIds: sourceReceipts.map((item) => item.id) })),
      releaseEscrowHeld: response.releaseEscrowHeld === true,
      escrowReleased: response.escrowReleased === true,
      releaseApproved: response.releaseApproved === true,
      tokenReleaseApproved: response.tokenReleaseApproved === true,
      tokenReleased: response.tokenReleased === true,
      tokenMaterialized: response.tokenMaterialized === true,
      authorizationHeaderMaterialized: response.authorizationHeaderMaterialized === true,
      httpRequestSent: response.httpRequestSent === true,
      liveGithubApiCalled: response.liveGithubApiCalled === true,
      liveVerificationPromoted: response.liveVerificationPromoted === true,
      mergeAllowed: response.mergeAllowed === true,
      mergeExecuted: response.mergeExecuted === true,
      liveSideEffects: response.liveSideEffects === true,
      readOnly: true,
      externalProvidersCalled: false
    };
  });
}

function buildOpsRetentionCommandWorkItemProofPacket({
  rollup,
  commandReceipts = [],
  commandWorkItems = [],
  lifecycleReceipts = []
} = {}) {
  const provider = 'retention_command_work_item_proof_packet_collector';
  const proofKeyFor = (value) => normalizeOpsBlockerCode(value || '');
  const approvedLifecycleReceipts = lifecycleReceipts.filter((receipt) => receipt.status === 'approved');
  const approvedProofKeys = [...new Set(approvedLifecycleReceipts.map((receipt) => proofKeyFor(receipt.proof_key)).filter(Boolean))];
  const requiredProofKeys = [...new Set([
    ...commandWorkItems.map((item) => {
      const instructions = parseOpsJson(item.instructions_json);
      return proofKeyFor(instructions.requiredProof || instructions.required_proof || item.proof_key);
    }),
    ...lifecycleReceipts.map((receipt) => proofKeyFor(receipt.proof_key))
  ].filter(Boolean))];
  const hasApprovedProof = (proofKey) => approvedProofKeys.includes(proofKey);
  const localProofBlockers = requiredProofKeys.filter((proofKey) => !hasApprovedProof(proofKey));
  return {
    kind: 'retention_command_work_item_proof_packet',
    provider,
    status: commandWorkItems.length
      ? (localProofBlockers.length ? 'operator_review_incomplete' : 'operator_review_complete')
      : 'no_work_items',
    retentionCohortRollupId: rollup?.id || commandReceipts[0]?.retention_cohort_rollup_id || null,
    workspaceId: rollup?.workspace_id || commandReceipts[0]?.workspace_id || commandWorkItems[0]?.workspace_id || lifecycleReceipts[0]?.workspace_id || null,
    serviceBusinessId: rollup?.service_business_id || commandReceipts[0]?.service_business_id || commandWorkItems[0]?.service_business_id || lifecycleReceipts[0]?.service_business_id || null,
    commandReceiptIds: commandReceipts.map((receipt) => receipt.id),
    commandWorkItemIds: commandWorkItems.map((item) => item.id),
    lifecycleReceiptIds: lifecycleReceipts.map((receipt) => receipt.id),
    approvedLifecycleReceiptIds: approvedLifecycleReceipts.map((receipt) => receipt.id),
    requiredProofKeys,
    operatorReviewedProofKeys: approvedProofKeys,
    localProof: {
      providerLiveSmokeOperatorReviewed: hasApprovedProof('provider_live_smoke'),
      liveAdapterImplementationOperatorReviewed: hasApprovedProof('live_adapter_implemented'),
      retentionRunModeApproved: hasApprovedProof('retention_run_mode_approval'),
      externalSideEffects: false
    },
    localProofBlockers,
    counts: {
      commandReceiptCount: commandReceipts.length,
      commandWorkItemCount: commandWorkItems.length,
      lifecycleReceiptCount: lifecycleReceipts.length,
      approvedLifecycleReceiptCount: approvedLifecycleReceipts.length,
      operatorReviewedProofKeyCount: approvedProofKeys.length,
      localProofBlockerCount: localProofBlockers.length
    },
    liveGateSemantics: {
      canClearCustomerRetentionLivePreflight: false,
      liveProviderSmokeSatisfied: false,
      liveAdapterImplementationSatisfied: false,
      reason: 'operator reviewed command work-item receipts are local evidence only',
      localReviewCannotClearGateKeys: ['provider_live_smoke', 'live_adapter_implemented'],
      requiredLiveEvidenceKeys: ['provider_live_smoke_receipt', 'live_adapter_implementation_receipt'],
      gateClearanceSource: 'live_provider_and_adapter_evidence_required'
    },
    safety: {
      kind: 'retention_command_work_item_proof_packet_safety',
      provider,
      evidenceOnly: true,
      localOperatorReviewOnly: true,
      externalSideEffects: false,
      customerMessageSent: false,
      offerSent: false,
      priceChangedLive: false,
      paymentLinkCreated: false,
      bookingScheduled: false,
      financeRollupMutated: false,
      budgetMoved: false,
      providerCalled: false,
      adapterInvoked: false,
      jobEnqueued: false,
      retentionCohortMutated: false,
      commandReceiptMutated: false,
      workItemMutated: false,
      livePreflightGateBypassed: false,
      liveProviderSmokeSatisfied: false,
      liveAdapterImplementationSatisfied: false
    }
  };
}

function buildOpsRetentionCohortCommandAction(blocker) {
  const key = normalizeOpsBlockerCode(blocker);
  if (key === 'retention_playbook_dry_run_required') return 'Record a dry-run retention playbook receipt before customer contact.';
  if (key === 'retention_playbook_live_preflight_required') return 'Run retention live preflight and keep live sends blocked until proof clears.';
  if (key === 'provider_live_smoke') return 'Attach fresh provider smoke proof before any retention send.';
  if (key === 'live_adapter_implemented') return 'Ship and verify the retention playbook live adapter before execution.';
  if (key === 'run_mode') return 'Keep retention follow-up in dry-run/local review until production mode is approved.';
  if (key === 'retention_capital_feedback_required') return 'Record retention capital feedback from the cohort before budget planning.';
  if (key === 'customer_retention_draft_review_required') return 'Complete the customer-retention draft review work item.';
  return `Resolve ${formatOpsLabel(key)} and attach retention evidence.`;
}

function buildOpsRetentionCohortCommandLiveEvidenceRequirement(blocker) {
  const key = normalizeOpsBlockerCode(blocker);
  if (key === 'provider_live_smoke') {
    return {
      requiredLiveEvidenceKey: 'provider_live_smoke_receipt',
      localReviewCannotClearLiveGate: true,
      gateClearanceSource: 'live_provider_and_adapter_evidence_required'
    };
  }
  if (key === 'live_adapter_implemented') {
    return {
      requiredLiveEvidenceKey: 'live_adapter_implementation_receipt',
      localReviewCannotClearLiveGate: true,
      gateClearanceSource: 'live_provider_and_adapter_evidence_required'
    };
  }
  return null;
}

export function buildOpsRetentionCohortCommandCenter(tables, limit) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  const rollups = tables.portfolioRetentionCohortRollups || [];
  const playbooks = tables.portfolioCustomerRetentionPlaybooks || [];
  const playbookReceipts = tables.portfolioCustomerRetentionPlaybookReceipts || [];
  const capitalFeedbackReceipts = tables.portfolioRetentionCapitalFeedbackReceipts || [];
  const decisionWorkItems = tables.portfolioDecisionWorkItems || [];
  const decisionWorkItemReceipts = tables.portfolioDecisionWorkItemReceipts || [];
  const commandWorkItemReceipts = tables.portfolioRetentionCommandWorkItemReceipts || [];
  const commandWorkItems = tables.portfolioRetentionCommandWorkItems || [];
  const commandWorkItemLifecycleReceipts = tables.portfolioRetentionCommandWorkItemLifecycleReceipts || [];
  const commandWorkItemLeaseSweepReceipts = tables.portfolioRetentionCommandWorkItemLeaseSweepReceipts || [];
  const commandWorkItemLeaseMaintenanceReceipts = tables.portfolioRetentionCommandWorkItemLeaseMaintenanceReceipts || [];
  const serviceNames = new Map((tables.serviceBusinesses || []).map((row) => [row.id, row.name]));
  return rollups.slice(0, cap).map((rollup) => {
    const cohortKey = normalizeOpsBlockerCode(rollup.cohort_key) || 'retention_cohort';
    const serviceBusinessId = rollup.service_business_id || null;
    const servicePlaybooks = playbooks.filter((playbook) => playbook.service_business_id === serviceBusinessId);
    const cohortMatchedPlaybooks = servicePlaybooks.filter((playbook) => {
      const retentionStatus = normalizeOpsBlockerCode(playbook.retention_status);
      const playbookKind = normalizeOpsBlockerCode(playbook.playbook_kind);
      return (retentionStatus && cohortKey.includes(retentionStatus)) ||
        (playbookKind && cohortKey.includes(playbookKind));
    });
    const relatedPlaybooks = cohortMatchedPlaybooks.length ? cohortMatchedPlaybooks : servicePlaybooks;
    const playbookIds = new Set(relatedPlaybooks.map((playbook) => playbook.id));
    const relatedReceipts = playbookReceipts.filter((receipt) => playbookIds.has(receipt.retention_playbook_id));
    const relatedCapitalFeedback = capitalFeedbackReceipts.filter((receipt) => (
      receipt.retention_cohort_rollup_id === rollup.id ||
      (serviceBusinessId && receipt.service_business_id === serviceBusinessId)
    ));
    const relatedWorkItems = decisionWorkItems.filter((item) => (
      item.work_item_kind === 'customer_retention_draft_review' &&
      (!serviceBusinessId || item.service_business_id === serviceBusinessId)
    ));
    const workItemIds = new Set(relatedWorkItems.map((item) => item.id));
    const relatedWorkItemReceipts = decisionWorkItemReceipts.filter((receipt) => workItemIds.has(receipt.decision_work_item_id));
    const relatedCommandReceipts = commandWorkItemReceipts.filter((receipt) => (
      receipt.retention_cohort_rollup_id === rollup.id ||
      (serviceBusinessId && receipt.service_business_id === serviceBusinessId)
    ));
    const commandReceiptIds = new Set(relatedCommandReceipts.map((receipt) => receipt.id));
    const relatedCommandWorkItems = commandWorkItems.filter((item) => (
      item.retention_cohort_rollup_id === rollup.id ||
      commandReceiptIds.has(item.retention_command_work_item_receipt_id)
    ));
    const commandWorkItemIds = new Set(relatedCommandWorkItems.map((item) => item.id));
    const relatedCommandLifecycleReceipts = commandWorkItemLifecycleReceipts.filter((receipt) => (
      receipt.retention_cohort_rollup_id === rollup.id ||
      commandWorkItemIds.has(receipt.retention_command_work_item_id) ||
      commandReceiptIds.has(receipt.retention_command_work_item_receipt_id)
    ));
    const relatedCommandLeaseSweepReceipts = commandWorkItemLeaseSweepReceipts.filter((receipt) => (
      receipt.retention_cohort_rollup_id === rollup.id ||
      commandReceiptIds.has(receipt.retention_command_work_item_receipt_id) ||
      (serviceBusinessId && receipt.service_business_id === serviceBusinessId)
    ));
    const relatedCommandLeaseMaintenanceReceipts = commandWorkItemLeaseMaintenanceReceipts.filter((receipt) => (
      receipt.retention_cohort_rollup_id === rollup.id ||
      commandReceiptIds.has(receipt.retention_command_work_item_receipt_id) ||
      (serviceBusinessId && receipt.service_business_id === serviceBusinessId)
    ));
    const approvedCommandWorkItemCount = relatedCommandLifecycleReceipts.filter((receipt) => receipt.status === 'approved').length;
    const claimedCommandWorkItemCount = relatedCommandLifecycleReceipts.filter((receipt) => receipt.action_kind === 'claim' && receipt.status === 'claimed').length;
    const releasedCommandWorkItemCount = relatedCommandLifecycleReceipts.filter((receipt) => receipt.action_kind === 'release' && receipt.status === 'released').length;
    const expiredCommandWorkItemLeaseCount = relatedCommandLifecycleReceipts.filter((receipt) => receipt.action_kind === 'expire_claim' && receipt.status === 'expired').length;
    const leaseObservedAt = Date.now();
    const commandWorkItemLeases = relatedCommandWorkItems
      .map((item) => {
        const instructions = parseOpsJson(item.instructions_json);
        return instructions.lease && typeof instructions.lease === 'object' ? instructions.lease : null;
      })
      .filter(Boolean);
    const activeCommandWorkItemLeases = commandWorkItemLeases.filter((lease) => lease.status === 'active');
    const staleCommandWorkItemLeases = activeCommandWorkItemLeases.filter((lease) => {
      const leaseExpiresAt = Number(lease.leaseExpiresAt || lease.lease_expires_at || 0);
      return Number.isFinite(leaseExpiresAt) && leaseExpiresAt <= leaseObservedAt;
    });
    const nextCommandWorkItemLeaseExpiryAt = activeCommandWorkItemLeases
      .map((lease) => Number(lease.leaseExpiresAt || lease.lease_expires_at || 0))
      .filter((leaseExpiresAt) => Number.isFinite(leaseExpiresAt) && leaseExpiresAt > 0)
      .sort((a, b) => a - b)[0] || null;
    const leaseMaintenanceStatus = staleCommandWorkItemLeases.length
      ? 'sweep_required'
      : activeCommandWorkItemLeases.length
        ? 'leases_active'
        : 'no_active_leases';
    const retentionCommandProofPacket = buildOpsRetentionCommandWorkItemProofPacket({
      rollup,
      commandReceipts: relatedCommandReceipts,
      commandWorkItems: relatedCommandWorkItems,
      lifecycleReceipts: relatedCommandLifecycleReceipts
    });
    const dryRunReceipts = relatedReceipts.filter((receipt) => receipt.mode === 'dry_run');
    const livePreflightReceipts = relatedReceipts.filter((receipt) => receipt.mode === 'live_preflight');
    const latestLivePreflight = livePreflightReceipts[0] || null;
    const livePreflightResponse = parseOpsJson(latestLivePreflight?.response_json);
    const livePreflightBlockers = Array.isArray(livePreflightResponse.blockers)
      ? livePreflightResponse.blockers.map(normalizeOpsBlockerCode).filter(Boolean)
      : [];
    const reviewApproved = relatedWorkItemReceipts.some((receipt) => ['approved', 'completed', 'closed_with_evidence'].includes(receipt.status));
    const blockers = [...new Set([
      ...(dryRunReceipts.length ? [] : ['retention_playbook_dry_run_required']),
      ...(livePreflightReceipts.length ? [] : ['retention_playbook_live_preflight_required']),
      ...livePreflightBlockers,
      ...(relatedCapitalFeedback.length ? [] : ['retention_capital_feedback_required']),
      ...(relatedWorkItems.length && !reviewApproved ? ['customer_retention_draft_review_required'] : [])
    ].map(normalizeOpsBlockerCode).filter(Boolean))];
    const cleared = [
      ...(dryRunReceipts.length ? ['retention_playbook_dry_run_recorded'] : []),
      ...(livePreflightReceipts.length ? ['retention_playbook_live_preflight_recorded'] : []),
      ...(relatedCapitalFeedback.length ? ['retention_capital_feedback_recorded'] : []),
      ...(reviewApproved ? ['customer_retention_draft_review_approved'] : [])
    ];
    const sourceReceipts = [
      { kind: 'retention_cohort_rollup', id: rollup.id, table: 'portfolio_retention_cohort_rollups' },
      ...relatedPlaybooks.map((playbook) => ({ kind: 'customer_retention_playbook', id: playbook.id, table: 'portfolio_customer_retention_playbooks' })),
      ...relatedReceipts.map((receipt) => ({ kind: 'customer_retention_playbook_receipt', id: receipt.id, table: 'portfolio_customer_retention_playbook_receipts' })),
      ...relatedCapitalFeedback.map((receipt) => ({ kind: 'retention_capital_feedback_receipt', id: receipt.id, table: 'portfolio_retention_capital_feedback_receipts' })),
      ...relatedWorkItems.map((item) => ({ kind: 'decision_work_item', id: item.id, table: 'portfolio_decision_work_items' })),
      ...relatedWorkItemReceipts.map((receipt) => ({ kind: 'decision_work_item_receipt', id: receipt.id, table: 'portfolio_decision_work_item_receipts' })),
      ...relatedCommandReceipts.map((receipt) => ({ kind: 'retention_command_work_item_receipt', id: receipt.id, table: 'portfolio_retention_command_work_item_receipts' })),
      ...relatedCommandWorkItems.map((item) => ({ kind: 'retention_command_work_item', id: item.id, table: 'portfolio_retention_command_work_items' })),
      ...relatedCommandLifecycleReceipts.map((receipt) => ({ kind: 'retention_command_work_item_lifecycle_receipt', id: receipt.id, table: 'portfolio_retention_command_work_item_lifecycle_receipts' })),
      ...relatedCommandLeaseSweepReceipts.map((receipt) => ({ kind: 'retention_command_work_item_lease_sweep_receipt', id: receipt.id, table: 'portfolio_retention_command_work_item_lease_sweep_receipts' })),
      ...relatedCommandLeaseMaintenanceReceipts.map((receipt) => ({ kind: 'retention_command_work_item_lease_maintenance_receipt', id: receipt.id, table: 'portfolio_retention_command_work_item_lease_maintenance_receipts' }))
    ];
    return {
      id: `retention_command:${rollup.id}`,
      key: `retention_cohort_command_center:${rollup.id}`,
      kind: 'retention_cohort_command_center',
      readOnly: true,
      generatedAt: toOpsIsoDate(rollup.updated_at || rollup.created_at),
      workspaceId: rollup.workspace_id,
      retentionCohortRollupId: rollup.id,
      serviceBusinessId,
      serviceBusinessName: rollup.service_business_name || serviceNames.get(serviceBusinessId) || 'service business',
      cohortKey,
      segment: rollup.segment,
      status: blockers.length ? 'blocked' : 'ready_for_review',
      recommendation: rollup.recommendation,
      customerCount: Number(rollup.customer_count || 0),
      savedCustomerCount: Number(rollup.saved_customer_count || 0),
      atRiskCustomerCount: Number(rollup.at_risk_customer_count || 0),
      playbookCount: relatedPlaybooks.length || Number(rollup.playbook_count || 0),
      playbookReceiptCount: relatedReceipts.length || Number(rollup.playbook_receipt_count || 0),
      dryRunReceiptCount: dryRunReceipts.length,
      livePreflightReceiptCount: livePreflightReceipts.length,
      capitalFeedbackCount: relatedCapitalFeedback.length,
      workItemCount: relatedWorkItems.length,
      workItemReceiptCount: relatedWorkItemReceipts.length,
      commandWorkItemCount: relatedCommandWorkItems.length,
      commandWorkItemReceiptCount: relatedCommandReceipts.length,
      commandWorkItemLifecycleReceiptCount: relatedCommandLifecycleReceipts.length,
      commandWorkItemLeaseSweepReceiptCount: relatedCommandLeaseSweepReceipts.length,
      commandWorkItemLeaseMaintenanceReceiptCount: relatedCommandLeaseMaintenanceReceipts.length,
      commandWorkItemLeaseCount: commandWorkItemLeases.length,
      activeCommandWorkItemLeaseCount: activeCommandWorkItemLeases.length,
      staleCommandWorkItemLeaseCount: staleCommandWorkItemLeases.length,
      releasedCommandWorkItemLeaseStateCount: commandWorkItemLeases.filter((lease) => lease.status === 'released').length,
      expiredCommandWorkItemLeaseStateCount: commandWorkItemLeases.filter((lease) => lease.status === 'expired').length,
      nextCommandWorkItemLeaseExpiryAt,
      leaseMaintenanceStatus,
      approvedCommandWorkItemCount,
      claimedCommandWorkItemCount,
      releasedCommandWorkItemCount,
      expiredCommandWorkItemLeaseCount,
      commandWorkItemProofPacketStatus: retentionCommandProofPacket.status,
      operatorReviewedProofKeys: retentionCommandProofPacket.operatorReviewedProofKeys,
      localProofBlockers: retentionCommandProofPacket.localProofBlockers,
      retentionCommandProofPacket,
      latestCommandWorkItemReceiptId: relatedCommandReceipts[0]?.id || null,
      latestCommandWorkItemLifecycleReceiptId: relatedCommandLifecycleReceipts[0]?.id || null,
      latestCommandWorkItemLeaseSweepReceiptId: relatedCommandLeaseSweepReceipts[0]?.id || null,
      latestCommandWorkItemLeaseMaintenanceReceiptId: relatedCommandLeaseMaintenanceReceipts[0]?.id || null,
      queuedCommandWorkItemCount: relatedCommandWorkItems.filter((item) => ['queued', 'queued_review', 'open'].includes(item.status)).length,
      retainedRevenueCents: Number(rollup.retained_revenue_cents || 0),
      netRetentionValueCents: Number(rollup.net_retention_value_cents || 0),
      avgChurnRisk: Number(rollup.avg_churn_risk || 0),
      blockers,
      blockerCount: blockers.length,
      cleared,
      clearedCount: cleared.length,
      nextActions: blockers.map((blocker) => ({
        blocker,
        label: formatOpsLabel(blocker),
        action: buildOpsRetentionCohortCommandAction(blocker)
      })),
      actionCommands: [
        ...(blockers.length ? [{
          action: 'queue_retention_command_work_items',
          label: 'Queue work items',
          method: 'POST',
          endpoint: `/api/portfolio/retention-command-center/${encodeURIComponent(rollup.id)}/work-items`,
          blockerCount: blockers.length,
          externalSideEffects: false,
          enabled: true
        }] : []),
        ...(relatedCommandWorkItems.length ? [{
          action: 'collect_retention_command_work_item_proof_packet',
          label: 'Collect proof packet',
          method: 'POST',
          endpoint: `/api/portfolio/retention-command-center/${encodeURIComponent(rollup.id)}/proof-packet`,
          operatorReviewedProofKeyCount: retentionCommandProofPacket.operatorReviewedProofKeys.length,
          externalSideEffects: false,
          enabled: true
        }, {
          action: 'record_retention_command_lease_maintenance',
          label: 'Record lease maintenance',
          method: 'POST',
          endpoint: '/api/portfolio/retention-command-work-items/lease-maintenance',
          retentionCohortRollupId: rollup.id,
          activeLeaseCount: activeCommandWorkItemLeases.length,
          staleLeaseCount: staleCommandWorkItemLeases.length,
          leaseMaintenanceStatus,
          maintenanceReceiptCount: relatedCommandLeaseMaintenanceReceipts.length,
          latestMaintenanceReceiptId: relatedCommandLeaseMaintenanceReceipts[0]?.id || null,
          safety: {
            kind: 'retention_command_work_item_lease_maintenance_safety',
            externalSideEffects: false,
            readOnlyTelemetry: true,
            customerMessageSent: false,
            financeRollupMutated: false,
            providerCalled: false,
            adapterInvoked: false,
            jobEnqueued: false
          },
          externalSideEffects: false,
          enabled: true
        }, {
          action: 'expire_retention_command_work_item_leases',
          label: 'Expire leases',
          method: 'POST',
          endpoint: '/api/portfolio/retention-command-work-items/expire-leases',
          retentionCohortRollupId: rollup.id,
          safety: {
            kind: 'retention_command_work_item_lease_expiry_safety',
            externalSideEffects: false,
            localLeaseUpdated: true,
            customerMessageSent: false,
            financeRollupMutated: false,
            providerCalled: false,
            adapterInvoked: false,
            jobEnqueued: false
          },
          externalSideEffects: false,
          leaseSweepReceiptCount: relatedCommandLeaseSweepReceipts.length,
          latestLeaseSweepReceiptId: relatedCommandLeaseSweepReceipts[0]?.id || null,
          activeLeaseCount: activeCommandWorkItemLeases.length,
          staleLeaseCount: staleCommandWorkItemLeases.length,
          leaseMaintenanceStatus,
          enabled: true
        }] : []),
        ...blockers.map((blocker) => ({
          action: `resolve_${blocker}`,
          label: formatOpsLabel(blocker),
          blocker,
          ...(buildOpsRetentionCohortCommandLiveEvidenceRequirement(blocker) || {}),
          externalSideEffects: false,
          enabled: true
        }))
      ],
      sourceReceipts,
      sourceReceiptCount: sourceReceipts.length,
      safety: {
        kind: 'retention_cohort_command_center_safety',
        customerMessageSent: false,
        offerSent: false,
        priceChangedLive: false,
        paymentLinkCreated: false,
        bookingScheduled: false,
        financeRollupMutated: false,
        externalSideEffects: false
      },
      externalSideEffects: false,
      externalProvidersCalled: false,
      updatedAt: toOpsIsoDate(rollup.updated_at || rollup.created_at)
    };
  });
}

function buildOpsServiceDecisionReadinessCommandAction(blocker) {
  const key = normalizeOpsBlockerCode(blocker);
  if (key === 'provider_live_smoke') return 'Run isolated provider smoke and attach the smoke receipt.';
  if (key === 'live_adapter_implemented') return 'Ship the live adapter behind the existing run-mode gates.';
  if (key === 'run_mode') return 'Move runtime mode only after production review approval.';
  if (key === 'side_effect_flag_runtime') return 'Enable runtime side-effect flags only after all live approvals and smoke receipts exist.';
  if (key === 'live_board_execution_guardrail') return 'Record explicit board-execution guardrail approval before live preflight.';
  return `Resolve ${formatOpsLabel(key)} and attach evidence.`;
}

const OPS_LIVE_PROVIDER_RUN_MODES = new Set(['demo_live', 'autonomous_live', 'production_live']);
const OPS_PROVIDER_LIVE_FLAG_REQUIREMENTS = {
  agentmail: ['LIVE_EMAILS'],
  agentphone: ['LIVE_CALLS'],
  stripe: ['LIVE_PAYMENTS'],
  browser_use: ['LIVE_BROWSER_SESSIONS'],
  browseruse: ['LIVE_BROWSER_SESSIONS'],
  owned_surface_builder: ['LIVE_BUILDS'],
  service_decision_execution_controller: ['LIVE_PUBLIC_OUTREACH', 'LIVE_PAYMENTS', 'LIVE_BUILDS']
};

function normalizeOpsLiveFlagName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!normalized) return null;
  return normalized.startsWith('LIVE_') ? normalized : `LIVE_${normalized}`;
}

function normalizeOpsLiveFlagList(values = []) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(normalizeOpsLiveFlagName).filter(Boolean))].sort();
}

function opsProviderLiveFlagRequirements(provider, overrides = null) {
  const overrideList = normalizeOpsLiveFlagList(overrides);
  if (overrideList.length) return overrideList;
  return OPS_PROVIDER_LIVE_FLAG_REQUIREMENTS[normalizeOpsBlockerCode(provider)] || ['LIVE_PROVIDER_SMOKE'];
}

function latestOpsReadinessProviderSmokeReceipt(reconciliation, { now = Date.now(), limit = 500 } = {}) {
  if (!reconciliation?.id || !reconciliation.service_decision_execution_receipt_id) return null;
  return providerSmoke.events({ since: 0, limit }).find((event) => {
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
    if (detail.readinessReconciliationId !== reconciliation.id) return false;
    if (detail.serviceDecisionExecutionReceiptId !== reconciliation.service_decision_execution_receipt_id) return false;
    const requiredFlags = opsProviderLiveFlagRequirements(event.provider, detail.requiredLiveFlags || detail.required_live_flags);
    const attestedFlags = normalizeOpsLiveFlagList(detail.liveFlagsAttested || detail.live_flags_attested);
    const runMode = normalizeOpsBlockerCode(detail.runMode || detail.run_mode || 'mock');
    return event.status === 'ok'
      && event.live === true
      && detail.source === 'readiness_command_center'
      && OPS_LIVE_PROVIDER_RUN_MODES.has(runMode)
      && requiredFlags.every((flag) => attestedFlags.includes(flag))
      && (detail.liveSmokePassed === true || detail.live_smoke_passed === true)
      && (detail.operatorVerified === true || detail.operator_verified === true)
      && detail.providerCalledByCallan !== true
      && detail.providerCalled !== true
      && detail.externalSideEffects !== true
      && now - Number(event.checkedAt || 0) <= 24 * 60 * 60 * 1000;
  }) || null;
}

export function buildOpsServiceDecisionReadinessCommandCenter(tables, limit) {
  const cap = Math.max(1, Math.min(Number(limit) || 50, 200));
  const reconciliations = tables.portfolioServiceDecisionReadinessReconciliations || [];
  const compensationPlans = tables.portfolioWorkflowCompensationPlans || [];
  const compensationReceipts = tables.portfolioWorkflowCompensationReceipts || [];
  const liveReadinessEvidenceArtifacts = tables.portfolioLiveReadinessEvidenceArtifacts || [];
  const liveAdapterReceipts = tables.portfolioLiveAdapterReceipts || [];
  const workflowInstanceRows = tables.workflowInstances || [];
  const workflowLinks = tables.workflowEntityLinks || [];
  const serviceNames = new Map((tables.serviceBusinesses || []).map((row) => [row.id, row.name]));
  const buildEvidenceSummary = (artifacts) => {
    const pendingReviewStatuses = new Set(['submitted_smoke_pending_review', 'submitted_adapter_pending_review']);
    const verifiedStatuses = new Set(['verified', 'passed', 'ready', 'satisfied']);
    const pendingReviewArtifacts = artifacts.filter((artifact) => pendingReviewStatuses.has(artifact.status));
    const pendingReviewProofKeys = Array.from(new Set(pendingReviewArtifacts.map((artifact) => artifact.proof_key).filter(Boolean))).sort();
    const verifiedProofKeys = Array.from(new Set(artifacts
      .filter((artifact) => {
        const safety = parseOpsJson(artifact.safety_json);
        return verifiedStatuses.has(artifact.status) || safety.proofVerified === true;
      })
      .map((artifact) => artifact.proof_key)
      .filter(Boolean))).sort();
    const pendingReviewSafety = pendingReviewArtifacts.reduce((safety, artifact) => {
      const artifactSafety = parseOpsJson(artifact.safety_json);
      const attestation = parseOpsJson(artifact.attestation_json)?.attestation || {};
      return {
        ...safety,
        providerCalled: safety.providerCalled || artifactSafety.providerCalled === true || attestation.providerCalledByCallan === true,
        adapterInvoked: safety.adapterInvoked || artifactSafety.adapterInvoked === true || attestation.adapterInvokedByCallan === true,
        jobEnqueued: safety.jobEnqueued || artifactSafety.jobEnqueued === true
      };
    }, {
      kind: 'readiness_pending_review_evidence_safety',
      externalSideEffects: false,
      providerCalled: false,
      adapterInvoked: false,
      jobEnqueued: false,
      canClearLiveGate: false
    });
    return {
      artifactCount: artifacts.length,
      verifiedArtifactCount: artifacts.filter((artifact) => verifiedStatuses.has(artifact.status)).length,
      pendingReviewCount: pendingReviewArtifacts.length,
      pendingReviewProofKeys,
      pendingReviewStatuses: Array.from(new Set(pendingReviewArtifacts.map((artifact) => artifact.status).filter(Boolean))).sort(),
      providerSmokePendingReview: pendingReviewProofKeys.includes('provider_live_smoke'),
      adapterPendingReview: pendingReviewProofKeys.includes('live_adapter_implemented'),
      verifiedProofKeys,
      pendingReviewCanClearLiveGate: false,
      pendingReviewRequiresVerifiedLiveEvidence: pendingReviewArtifacts.length > 0,
      pendingReviewSafety
    };
  };
  return reconciliations.slice(0, cap).map((reconciliation) => {
    const report = parseOpsJson(reconciliation.report_json);
    const executionId = reconciliation.service_decision_execution_receipt_id;
    const workflowInstance = workflowInstanceRows.find((item) => item.id === reconciliation.workflow_instance_id) || null;
    const plans = compensationPlans.filter((plan) => plan.service_decision_execution_receipt_id === executionId);
    const receipts = compensationReceipts.filter((receipt) => receipt.service_decision_execution_receipt_id === executionId);
    const artifacts = liveReadinessEvidenceArtifacts.filter((artifact) => artifact.service_decision_execution_receipt_id === executionId);
    const adapterReceipts = liveAdapterReceipts.filter((receipt) => receipt.service_decision_execution_receipt_id === executionId);
    const latestAdapterReceipt = adapterReceipts[0] || null;
    const latestImplementationReceipt = adapterReceipts.find((receipt) => (
      receipt.mode === 'implementation_verified' && receipt.status === 'verified_implemented'
    )) || null;
    const latestProviderSmokeReceipt = latestOpsReadinessProviderSmokeReceipt(reconciliation);
    const latestProviderSmokeDetail = latestProviderSmokeReceipt?.detail && typeof latestProviderSmokeReceipt.detail === 'object'
      ? latestProviderSmokeReceipt.detail
      : {};
    const links = workflowLinks.filter((link) => link.instance_id === reconciliation.workflow_instance_id);
    const openPlans = plans.filter((plan) => !['closed_with_evidence', 'rolled_back'].includes(plan.status));
    const retryablePlans = openPlans.filter((plan) => ['provider_live_smoke', 'live_adapter_implemented'].includes(plan.blocker_key));
    const remainingProofBlockers = Array.isArray(report.remainingProofBlockers)
      ? report.remainingProofBlockers.map(normalizeOpsBlockerCode).filter(Boolean)
      : [];
    const runtimeBlockers = Array.isArray(report.runtimeBlockers)
      ? report.runtimeBlockers.map(normalizeOpsBlockerCode).filter(Boolean)
      : [];
    const blockerRows = parseOpsJsonArray(reconciliation.blockers_json).map(normalizeOpsBlockerCode).filter(Boolean);
    const blockers = blockerRows.length ? blockerRows : [...remainingProofBlockers, ...runtimeBlockers];
    const clearedRows = parseOpsJsonArray(reconciliation.cleared_json).map(normalizeOpsBlockerCode).filter(Boolean);
    const cleared = clearedRows.length
      ? clearedRows
      : (Array.isArray(report.cleared) ? report.cleared.map(normalizeOpsBlockerCode).filter(Boolean) : []);
    const sourceReceipts = [
      { kind: 'service_decision_readiness_reconciliation', id: reconciliation.id, table: 'portfolio_service_decision_readiness_reconciliations' },
      ...plans.map((plan) => ({ kind: 'workflow_compensation_plan', id: plan.id, table: 'portfolio_workflow_compensation_plans' })),
      ...receipts.map((receipt) => ({ kind: 'workflow_compensation_receipt', id: receipt.id, table: 'portfolio_workflow_compensation_receipts' })),
      ...artifacts.map((artifact) => ({ kind: 'live_readiness_evidence_artifact', id: artifact.id, table: 'portfolio_live_readiness_evidence_artifacts' })),
      ...adapterReceipts.map((receipt) => ({ kind: 'live_adapter_receipt', id: receipt.id, table: 'portfolio_live_adapter_receipts' })),
      ...links.map((link) => ({ kind: 'workflow_entity_link', id: link.id, table: 'workflow_entity_links' }))
    ];
    return {
      id: reconciliation.id,
      key: `service_decision_readiness_command_center:${reconciliation.id}`,
      kind: 'service_decision_readiness_command_center',
      readOnly: true,
      generatedAt: toOpsIsoDate(reconciliation.updated_at || reconciliation.created_at),
      workspaceId: reconciliation.workspace_id,
      serviceBusinessId: reconciliation.service_business_id,
      serviceBusinessName: reconciliation.service_business_name || serviceNames.get(reconciliation.service_business_id) || 'service business',
      serviceDecisionExecutionReceiptId: executionId,
      workflowInstanceId: reconciliation.workflow_instance_id,
      workflowKey: workflowInstance?.workflow_key || null,
      workflowState: workflowInstance?.state || null,
      status: reconciliation.status,
      cleared,
      blockers,
      remainingProofBlockers,
      runtimeBlockers,
      blockerCount: blockers.length,
      clearedCount: cleared.length,
      nextActions: blockers.map((blocker) => ({
        blocker,
        label: formatOpsLabel(blocker),
        action: buildOpsServiceDecisionReadinessCommandAction(blocker)
      })),
      actionCommands: [
        {
          action: 'plan_compensation',
          label: 'Plan compensation',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/plan-compensation`,
          enabled: !!reconciliation.workflow_instance_id,
          externalSideEffects: false
        },
        {
          action: 'record_retry_receipts',
          label: 'Record retry receipts',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/record-retry-receipts`,
          enabled: !!reconciliation.workflow_instance_id && retryablePlans.length > 0,
          openPlanCount: openPlans.length,
          retryablePlanCount: retryablePlans.length,
          externalSideEffects: false
        },
        ...(blockers.includes('provider_live_smoke') ? [{
          action: 'record_provider_smoke_receipt',
          label: 'Record smoke receipt',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/provider-smoke-receipt`,
          enabled: !!executionId,
          proofKey: 'provider_live_smoke',
          provider: latestProviderSmokeReceipt?.provider || 'agentmail',
          runMode: 'production_live',
          requiredLiveFlags: normalizeOpsLiveFlagList(latestProviderSmokeDetail.requiredLiveFlags || latestProviderSmokeDetail.required_live_flags || ['LIVE_EMAILS']),
          externalSideEffects: false
        }, {
          action: 'attach_provider_smoke_evidence',
          label: 'Attach smoke packet',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/evidence`,
          enabled: !!executionId,
          proofKey: 'provider_live_smoke',
          provider: latestProviderSmokeReceipt?.provider || null,
          providerReceiptId: latestProviderSmokeReceipt?.id || null,
          requiredLiveFlags: normalizeOpsLiveFlagList(latestProviderSmokeDetail.requiredLiveFlags || latestProviderSmokeDetail.required_live_flags),
          verifiedSmokeReady: !!latestProviderSmokeReceipt,
          externalSideEffects: false
        }] : []),
        ...(blockers.includes('live_adapter_implemented') ? [{
          action: 'plan_adapter_ledger',
          label: 'Plan adapter ledger',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/adapter-ledger`,
          enabled: !!executionId,
          adapterKey: 'service_decision_execution_controller',
          mode: 'dry_run',
          externalSideEffects: false
        }, {
          action: 'run_adapter_contract_tests',
          label: 'Run contract tests',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/adapter-ledger`,
          enabled: !!executionId,
          adapterKey: 'service_decision_execution_controller',
          mode: 'contract_test',
          externalSideEffects: false
        }, {
          action: 'verify_adapter_implementation',
          label: 'Verify adapter packet',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/adapter-ledger`,
          enabled: !!executionId,
          adapterKey: 'service_decision_execution_controller',
          mode: 'implementation_verified',
          externalSideEffects: false
        }, {
          action: 'preflight_adapter_ledger',
          label: 'Preflight adapter',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/adapter-ledger`,
          enabled: !!executionId,
          adapterKey: 'service_decision_execution_controller',
          mode: 'live_preflight',
          externalSideEffects: false
        }, {
          action: 'attach_adapter_evidence',
          label: 'Attach adapter packet',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/evidence`,
          enabled: !!executionId,
          proofKey: 'live_adapter_implemented',
          adapterReceiptId: latestImplementationReceipt?.id || null,
          verifiedImplementationReady: !!latestImplementationReceipt,
          externalSideEffects: false
        }] : []),
        {
          action: 'rerun_reconciliation',
          label: 'Reconcile again',
          method: 'POST',
          endpoint: `/api/portfolio/readiness-command-center/${reconciliation.id}/reconcile`,
          enabled: !!executionId,
          externalSideEffects: false
        }
      ],
      compensation: {
        planCount: plans.length,
        receiptCount: receipts.length,
        openPlans: openPlans.length,
        retryPlanned: receipts.filter((receipt) => receipt.status === 'retry_planned').length,
        closedWithEvidence: receipts.filter((receipt) => receipt.status === 'closed_with_evidence').length,
        rolledBack: receipts.filter((receipt) => receipt.status === 'rolled_back').length
      },
      evidence: {
        ...buildEvidenceSummary(artifacts),
        workflowLinkCount: links.length
      },
      providerSmoke: {
        receiptId: latestProviderSmokeReceipt?.id || null,
        provider: latestProviderSmokeReceipt?.provider || null,
        verified: !!latestProviderSmokeReceipt
      },
      adapterLedger: {
        receiptCount: adapterReceipts.length,
        latestStatus: latestAdapterReceipt?.status || null,
        latestMode: latestAdapterReceipt?.mode || null,
        implementationReceiptId: latestImplementationReceipt?.id || null,
        verifiedImplemented: adapterReceipts.some((receipt) => receipt.status === 'verified_implemented'),
        contractTestsPassed: adapterReceipts.some((receipt) => receipt.status === 'contract_tests_passed'),
        livePreflightBlocked: adapterReceipts.some((receipt) => receipt.status === 'blocked_live_preflight'),
        implementationRequired: adapterReceipts.some((receipt) => receipt.status === 'implementation_required')
      },
      sourceReceipts,
      sourceReceiptCount: sourceReceipts.length,
      safety: {
        kind: 'service_decision_readiness_command_center_safety',
        providerCalled: false,
        adapterInvoked: false,
        workflowMutated: false,
        customerMessageSent: false,
        budgetMoved: false,
        sideEffectFlagChanged: false,
        externalSideEffects: false
      },
      externalSideEffects: false,
      externalProvidersCalled: false,
      updatedAt: toOpsIsoDate(reconciliation.updated_at || reconciliation.created_at)
    };
  });
}

export function exportOperationsData({ includePII = false, limit = 500 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 500, 2_000));
  const tables = {
    leads: db.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT ?`).all(n),
    payments: db.prepare(`SELECT * FROM payments ORDER BY created_at DESC LIMIT ?`).all(n),
    builds: db.prepare(`SELECT * FROM builds ORDER BY started_at DESC LIMIT ?`).all(n),
    contactEvents: db.prepare(`SELECT * FROM contact_events ORDER BY created_at DESC LIMIT ?`).all(n),
    calls: db.prepare(`SELECT * FROM calls ORDER BY started_at DESC LIMIT ?`).all(n),
    jobs: durableJobs.list({ limit: n }),
    accountManagerPlans: db.prepare(`SELECT * FROM account_manager_plans ORDER BY updated_at DESC LIMIT ?`).all(n),
    accountTasks: db.prepare(`SELECT * FROM account_tasks ORDER BY due_at ASC, updated_at DESC LIMIT ?`).all(n),
    accountTaskOperatorBoardEscalations: db.prepare(`SELECT * FROM account_task_operator_board_escalations ORDER BY updated_at DESC LIMIT ?`).all(n),
    accountOperatorBoardWorkItems: db.prepare(`SELECT * FROM account_operator_board_work_items ORDER BY due_at ASC, updated_at DESC LIMIT ?`).all(n),
    accountOperatorBoardWorkItemReceipts: db.prepare(`SELECT * FROM account_operator_board_work_item_receipts ORDER BY updated_at DESC LIMIT ?`).all(n),
    accountOperatorBoardRetentionFeedbackReceipts: db.prepare(`SELECT * FROM account_operator_board_retention_feedback_receipts ORDER BY updated_at DESC LIMIT ?`).all(n),
    workflowInstances: workflowInstances.list({ limit: n }),
    workflowInstanceEvents: db.prepare(`SELECT * FROM workflow_instance_events ORDER BY created_at DESC LIMIT ?`).all(n),
    workflowEntityLinks: db.prepare(`SELECT * FROM workflow_entity_links ORDER BY updated_at DESC LIMIT ?`).all(n),
    workflowReplayReceipts: workflowReplayReceipts.list({ limit: n }),
    safeToSellReports: safeToSellReports.list({ limit: n }),
    safeToRenewReports: safeToRenewReports.list({ limit: n }),
    safeToRenewPlaybooks: safeToRenewPlaybooks.list({ limit: n }),
    renewalChangeRequests: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = 'renewal_change_requested'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(n),
    renewalBillingChangePreflights: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = 'renewal_billing_change_preflight'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(n),
    renewalBillingExecutionReceipts: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = 'renewal_billing_change_execution_receipt'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(n),
    renewalCustomerMessagePreflights: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = 'renewal_customer_message_preflight'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(n),
    renewalCustomerMessageSendReceipts: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = 'renewal_customer_message_send_receipt'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(n),
    renewalCustomerConfirmationReceipts: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE, n),
    renewalCustomerConfirmationAcknowledgements: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE, n),
    renewalCustomerConfirmationAcceptances: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE, n),
    renewalCustomerConfirmationFollowupWorkItems: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE, n),
    renewalCustomerConfirmationFollowupReceipts: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE, n),
    renewalCustomerConfirmationCloseoutPackets: db.prepare(`
      SELECT * FROM portal_actions
      WHERE type = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(RENEWAL_CUSTOMER_CONFIRMATION_CLOSEOUT_PACKET_ACTION_TYPE, n),
    organizations: db.prepare(`SELECT * FROM organizations ORDER BY created_at DESC LIMIT ?`).all(n),
    workspaces: db.prepare(`SELECT * FROM workspaces ORDER BY created_at DESC LIMIT ?`).all(n),
    operators: db.prepare(`SELECT * FROM operators ORDER BY updated_at DESC LIMIT ?`).all(n),
    territories: db.prepare(`SELECT * FROM territories ORDER BY created_at DESC LIMIT ?`).all(n),
    brands: db.prepare(`SELECT * FROM brands ORDER BY created_at DESC LIMIT ?`).all(n),
    marketOpportunities: db.prepare(`SELECT * FROM market_opportunities ORDER BY updated_at DESC LIMIT ?`).all(n),
    serviceBusinesses: db.prepare(`SELECT * FROM service_businesses ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioCustomers: db.prepare(`SELECT * FROM portfolio_customers ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioCustomerContacts: db.prepare(`SELECT * FROM portfolio_customer_contacts ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioJobs: db.prepare(`SELECT * FROM portfolio_jobs ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioFulfillmentTasks: db.prepare(`SELECT * FROM portfolio_fulfillment_tasks ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioPayments: db.prepare(`SELECT * FROM portfolio_payments ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioLaborCostEntries: db.prepare(`SELECT * FROM portfolio_labor_cost_entries ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioFinanceRollups: db.prepare(`SELECT * FROM portfolio_finance_rollups ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioOfferBundles: db.prepare(`SELECT * FROM portfolio_offer_bundles ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioProviderLinks: db.prepare(`SELECT * FROM portfolio_provider_links ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioProviderCredentialReceipts: db.prepare(`SELECT * FROM portfolio_provider_credential_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioTenantIsolationReceipts: db.prepare(`SELECT * FROM portfolio_tenant_isolation_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioTenantControlReceipts: db.prepare(`SELECT * FROM portfolio_tenant_control_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioTenantLifecycleReceipts: db.prepare(`SELECT * FROM portfolio_tenant_lifecycle_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioRoleAssignments: db.prepare(`SELECT * FROM portfolio_role_assignments ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioRoleAccessReceipts: db.prepare(`SELECT * FROM portfolio_role_access_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioApprovals: db.prepare(`SELECT * FROM portfolio_approvals ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioOperatorInboxItems: db.prepare(`SELECT * FROM portfolio_operator_inbox_items ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioOperatorActionReceipts: db.prepare(`SELECT * FROM portfolio_operator_action_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioOperatorAssignmentQueues: db.prepare(`SELECT * FROM portfolio_operator_assignment_queues ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioOperatorBulkReviewReceipts: db.prepare(`SELECT * FROM portfolio_operator_bulk_review_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioOperatorHandoffEvalCloseouts: db.prepare(`SELECT * FROM portfolio_operator_handoff_eval_closeouts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalPublicationReceipts: db.prepare(`SELECT * FROM portfolio_eval_publication_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalFixtureWorkItems: db.prepare(`SELECT * FROM portfolio_eval_fixture_work_items ORDER BY priority ASC, created_at DESC LIMIT ?`).all(n),
    portfolioEvalFixtureRunnerReceipts: db.prepare(`SELECT * FROM portfolio_eval_fixture_runner_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalFixtureApprovalReceipts: db.prepare(`SELECT * FROM portfolio_eval_fixture_approval_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalGoldenFixtureReviewReceipts: db.prepare(`SELECT * FROM portfolio_eval_golden_fixture_review_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalNonLiveRunnerBindingReceipts: db.prepare(`SELECT * FROM portfolio_eval_non_live_runner_binding_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalFileDryRunManifests: db.prepare(`SELECT * FROM portfolio_eval_file_dry_run_manifests ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalCiWriteAccessReceipts: db.prepare(`SELECT * FROM portfolio_eval_ci_write_access_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalLiveAdapterReadinessReceipts: db.prepare(`SELECT * FROM portfolio_eval_live_adapter_readiness_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalLiveAdapterContractTestReceipts: db.prepare(`SELECT * FROM portfolio_eval_live_adapter_contract_test_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalCiWorkflowPublicationReceipts: db.prepare(`SELECT * FROM portfolio_eval_ci_workflow_publication_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalGeneratedArtifactPromotionReceipts: db.prepare(`SELECT * FROM portfolio_eval_generated_artifact_promotion_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalPrMergeProposalReceipts: db.prepare(`SELECT * FROM portfolio_eval_pr_merge_proposal_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalPrOpenSimulationReceipts: db.prepare(`SELECT * FROM portfolio_eval_pr_open_simulation_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalOperatorMergeApprovalReceipts: db.prepare(`SELECT * FROM portfolio_eval_operator_merge_approval_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalSubmittedPrEvidenceReceipts: db.prepare(`SELECT * FROM portfolio_eval_submitted_pr_evidence_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalPrExternalVerificationReceipts: db.prepare(`SELECT * FROM portfolio_eval_pr_external_verification_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalExternalCiResultReceipts: db.prepare(`SELECT * FROM portfolio_eval_external_ci_result_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalGithubPrVerificationReceipts: db.prepare(`SELECT * FROM portfolio_eval_github_pr_verification_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalGithubPrObservationReceipts: db.prepare(`SELECT * FROM portfolio_eval_github_pr_observation_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalGithubCheckRunObservationReceipts: db.prepare(`SELECT * FROM portfolio_eval_github_check_run_observation_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeExecutionAdapterContractReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_execution_adapter_contract_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalOperatorMergeCompletionGateReceipts: db.prepare(`SELECT * FROM portfolio_eval_operator_merge_completion_gate_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalLiveMergeAuthorizationReceipts: db.prepare(`SELECT * FROM portfolio_eval_live_merge_authorization_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalBranchProtectionReadbackAdapterContractReceipts: db.prepare(`SELECT * FROM portfolio_eval_branch_protection_readback_adapter_contract_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalTokenScopeObservationAdapterContractReceipts: db.prepare(`SELECT * FROM portfolio_eval_token_scope_observation_adapter_contract_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalSecretRedactionProofReceipts: db.prepare(`SELECT * FROM portfolio_eval_secret_redaction_proof_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueReadbackAdapterContractReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_readback_adapter_contract_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueLiveReadReconciliationReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_live_read_reconciliation_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueLiveReadAdapterContractReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_live_read_adapter_contract_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueLiveReadReadinessReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_live_read_readiness_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueCredentialHandoffReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_credential_handoff_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueLiveReadPreflightReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_live_read_preflight_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueTokenQuarantineReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_token_quarantine_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueLiveReadResponseIngestionReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_live_read_response_ingestion_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueRuntimeTokenReleaseGateReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_runtime_token_release_gate_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueLiveReadVerificationPromotionReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_live_read_verification_promotion_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_live_http_execution_preflight_handoff_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueLiveHttpOperatorReleaseAckReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_live_http_operator_release_ack_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_runtime_secret_provider_smoke_readiness_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_runtime_secret_provider_smoke_execution_gate_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_runtime_secret_provider_smoke_evidence_review_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_memory_only_runtime_token_release_preflight_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_successful_smoke_evidence_ingestion_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueRuntimeTokenReleaseDenialReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_runtime_token_release_denial_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueFakeLiveReadReplayQuarantineReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_fake_live_read_replay_quarantine_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueFinalBlockerLedgerReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_final_blocker_ledger_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_post_ledger_operator_release_attestation_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueuePostAttestationReleaseEscrowReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_post_attestation_release_escrow_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioEvalMergeQueueReleaseDenialCloseoutReceipts: db.prepare(`SELECT * FROM portfolio_eval_merge_queue_release_denial_closeout_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioOperatorInboxAssignments: db.prepare(`SELECT * FROM portfolio_operator_inbox_assignments ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioOperatorStaffingAnalyticsReceipts: db.prepare(`SELECT * FROM portfolio_operator_staffing_analytics_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioIncidents: db.prepare(`SELECT * FROM portfolio_incidents ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioLearningRecords: db.prepare(`SELECT * FROM portfolio_learning_records ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioGateEvaluations: db.prepare(`SELECT * FROM portfolio_gate_evaluations ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioLaunchSurfaces: db.prepare(`SELECT * FROM portfolio_launch_surfaces ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioMonitoringChecks: db.prepare(`SELECT * FROM portfolio_monitoring_checks ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioAcquisitionAttempts: db.prepare(`SELECT * FROM portfolio_acquisition_attempts ORDER BY attempted_at DESC LIMIT ?`).all(n),
    portfolioStrategyRecommendations: db.prepare(`SELECT * FROM portfolio_strategy_recommendations ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioAcquisitionActions: db.prepare(`SELECT * FROM portfolio_acquisition_actions ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioAcquisitionActionReceipts: db.prepare(`SELECT * FROM portfolio_acquisition_action_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioCapitalAllocationReceipts: db.prepare(`SELECT * FROM portfolio_capital_allocation_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioProviderFallbackReceipts: db.prepare(`SELECT * FROM portfolio_provider_fallback_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioDispatchReceipts: db.prepare(`SELECT * FROM portfolio_dispatch_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioJobTrackingReceipts: db.prepare(`SELECT * FROM portfolio_job_tracking_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioCustomerPrivacyControlReceipts: db.prepare(`SELECT * FROM portfolio_customer_privacy_control_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioCompletionReceipts: db.prepare(`SELECT * FROM portfolio_completion_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioPayoutReceipts: db.prepare(`SELECT * FROM portfolio_payout_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioRefundDisputeReceipts: db.prepare(`SELECT * FROM portfolio_refund_dispute_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioVendorQualityReceipts: db.prepare(`SELECT * FROM portfolio_vendor_quality_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioCustomerUpdateReceipts: db.prepare(`SELECT * FROM portfolio_customer_update_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioCustomerFeedbackRecords: db.prepare(`SELECT * FROM portfolio_customer_feedback_records ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioCustomerRemediationPlans: db.prepare(`SELECT * FROM portfolio_customer_remediation_plans ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioVendorCorrectiveActions: db.prepare(`SELECT * FROM portfolio_vendor_corrective_actions ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioRemediationBudgetReserves: db.prepare(`SELECT * FROM portfolio_remediation_budget_reserves ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioRemediationCloseoutReceipts: db.prepare(`SELECT * FROM portfolio_remediation_closeout_receipts ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioCustomerRetentionPlaybooks: db.prepare(`SELECT * FROM portfolio_customer_retention_playbooks ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioCustomerRetentionPlaybookReceipts: db.prepare(`SELECT * FROM portfolio_customer_retention_playbook_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioRetentionCohortRollups: db.prepare(`SELECT * FROM portfolio_retention_cohort_rollups ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioRetentionCapitalFeedbackReceipts: db.prepare(`SELECT * FROM portfolio_retention_capital_feedback_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioRetentionCommandWorkItemReceipts: db.prepare(`SELECT * FROM portfolio_retention_command_work_item_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioRetentionCommandWorkItems: db.prepare(`SELECT * FROM portfolio_retention_command_work_items ORDER BY due_at ASC, created_at DESC LIMIT ?`).all(n),
    portfolioRetentionCommandWorkItemLifecycleReceipts: db.prepare(`SELECT * FROM portfolio_retention_command_work_item_lifecycle_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioRetentionCommandWorkItemLeaseSweepReceipts: db.prepare(`SELECT * FROM portfolio_retention_command_work_item_lease_sweep_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioRetentionCommandWorkItemLeaseMaintenanceReceipts: db.prepare(`SELECT * FROM portfolio_retention_command_work_item_lease_maintenance_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioServiceDecisionFusionReceipts: db.prepare(`SELECT * FROM portfolio_service_decision_fusion_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioServiceDecisionExecutionReceipts: db.prepare(`SELECT * FROM portfolio_service_decision_execution_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioDecisionDistributionReceipts: db.prepare(`SELECT * FROM portfolio_decision_distribution_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioDecisionWorkItems: db.prepare(`SELECT * FROM portfolio_decision_work_items ORDER BY due_at ASC, created_at DESC LIMIT ?`).all(n),
    portfolioDecisionWorkItemReceipts: db.prepare(`SELECT * FROM portfolio_decision_work_item_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioLiveReadinessEvidenceArtifacts: db.prepare(`SELECT * FROM portfolio_live_readiness_evidence_artifacts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioLiveAdapterReceipts: db.prepare(`SELECT * FROM portfolio_live_adapter_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioWorkflowCompensationPlans: db.prepare(`SELECT * FROM portfolio_workflow_compensation_plans ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioWorkflowCompensationReceipts: db.prepare(`SELECT * FROM portfolio_workflow_compensation_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioServiceDecisionReadinessReconciliations: db.prepare(`SELECT * FROM portfolio_service_decision_readiness_reconciliations ORDER BY created_at DESC LIMIT ?`).all(n),
    portfolioRepeatWorkReceipts: db.prepare(`SELECT * FROM portfolio_repeat_work_receipts ORDER BY created_at DESC LIMIT ?`).all(n),
    serviceCapabilities: db.prepare(`SELECT * FROM service_capabilities ORDER BY updated_at DESC LIMIT ?`).all(n),
    vendorPartners: db.prepare(`SELECT * FROM vendor_partners ORDER BY updated_at DESC LIMIT ?`).all(n),
    workflowDefinitions: db.prepare(`SELECT * FROM workflow_definitions ORDER BY updated_at DESC LIMIT ?`).all(n),
    portfolioEvents: db.prepare(`SELECT * FROM portfolio_events ORDER BY created_at DESC LIMIT ?`).all(n)
  };
  tables.portfolioEvalMergeQueueConsolidatedBlockerAudits = buildOpsMergeQueueConsolidatedBlockerAudits(tables, n);
  tables.portfolioRetentionCohortCommandCenter = buildOpsRetentionCohortCommandCenter(tables, n);
  tables.portfolioServiceDecisionReadinessCommandCenter = buildOpsServiceDecisionReadinessCommandCenter(tables, n);
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    includePII: !!includePII,
    redaction: {
      strategy: includePII ? 'none' : 'pii_secrets_and_local_paths'
    },
    persistence: {
      kind: 'sqlite',
      dataDir: env.dataDir
    },
    limits: {
      rowsPerTable: n
    },
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    tables
  };
  const safePayload = includePII ? payload : redact(payload);
  return {
    ...safePayload,
    redaction: {
      ...(safePayload.redaction || {}),
      manifest: buildOperationsExportRedactionManifest(safePayload, { includePII })
    }
  };
}

export function buildOperationsExportRedactionManifest(payload, { includePII = false } = {}) {
  const tables = payload?.tables && typeof payload.tables === 'object' ? payload.tables : {};
  const counts = payload?.counts && typeof payload.counts === 'object' ? payload.counts : {};
  const serialized = JSON.stringify(payload || {});
  const redactedPlaceholderKinds = [...new Set([...serialized.matchAll(/\[redacted:([^\]]+)\]/g)].map((match) => match[1]))].sort();
  const receiptTableNames = Object.keys(tables).filter((name) => (
    /Receipt|Receipts|Proof|Contract|Manifest|Gate|Authorization|Observation|Audit/i.test(name)
  ));
  const rowCount = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const secretPatternScan = {
    rawTokenPatternFound: containsRawSecret(payload),
    checkedPatterns: ['github_classic_token', 'github_fine_grained_token', 'stripe_live_secret', 'stripe_restricted_key', 'webhook_secret'],
    redactedPlaceholderKinds
  };
  const manifest = {
    schemaVersion: 1,
    kind: 'ops_export_redaction_manifest',
    generatedAt: payload?.generatedAt || new Date().toISOString(),
    includePII: !!includePII,
    redacted: !includePII,
    redactionStrategy: payload?.redaction?.strategy || (includePII ? 'none' : 'pii_secrets_and_local_paths'),
    tableCount: Object.keys(tables).length,
    rowCount,
    receiptTableCount: receiptTableNames.length,
    receiptTables: Object.fromEntries(receiptTableNames.map((name) => [name, Number(counts[name]) || 0])),
    proofReceipts: {
      secretRedactionProofReceipts: Number(counts.portfolioEvalSecretRedactionProofReceipts) || 0,
      mergeQueueReadbackAdapterContractReceipts: Number(counts.portfolioEvalMergeQueueReadbackAdapterContractReceipts) || 0,
      mergeQueueLiveReadReconciliationReceipts: Number(counts.portfolioEvalMergeQueueLiveReadReconciliationReceipts) || 0,
      mergeQueueLiveReadAdapterContractReceipts: Number(counts.portfolioEvalMergeQueueLiveReadAdapterContractReceipts) || 0,
      mergeQueueLiveReadReadinessReceipts: Number(counts.portfolioEvalMergeQueueLiveReadReadinessReceipts) || 0,
      mergeQueueCredentialHandoffReceipts: Number(counts.portfolioEvalMergeQueueCredentialHandoffReceipts) || 0,
      mergeQueueLiveReadPreflightReceipts: Number(counts.portfolioEvalMergeQueueLiveReadPreflightReceipts) || 0,
      mergeQueueTokenQuarantineReceipts: Number(counts.portfolioEvalMergeQueueTokenQuarantineReceipts) || 0,
      mergeQueueLiveReadResponseIngestionReceipts: Number(counts.portfolioEvalMergeQueueLiveReadResponseIngestionReceipts) || 0,
      mergeQueueRuntimeTokenReleaseGateReceipts: Number(counts.portfolioEvalMergeQueueRuntimeTokenReleaseGateReceipts) || 0,
      mergeQueueLiveReadVerificationPromotionReceipts: Number(counts.portfolioEvalMergeQueueLiveReadVerificationPromotionReceipts) || 0,
      mergeQueueLiveHttpExecutionPreflightHandoffReceipts: Number(counts.portfolioEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipts) || 0,
      mergeQueueLiveHttpOperatorReleaseAckReceipts: Number(counts.portfolioEvalMergeQueueLiveHttpOperatorReleaseAckReceipts) || 0,
      mergeQueueRuntimeSecretProviderSmokeReadinessReceipts: Number(counts.portfolioEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipts) || 0,
      mergeQueueRuntimeSecretProviderSmokeExecutionGateReceipts: Number(counts.portfolioEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipts) || 0,
      mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipts: Number(counts.portfolioEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipts) || 0,
      mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipts: Number(counts.portfolioEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipts) || 0,
      mergeQueueSuccessfulSmokeEvidenceIngestionReceipts: Number(counts.portfolioEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipts) || 0,
      mergeQueueRuntimeTokenReleaseDenialReceipts: Number(counts.portfolioEvalMergeQueueRuntimeTokenReleaseDenialReceipts) || 0,
      mergeQueueFakeLiveReadReplayQuarantineReceipts: Number(counts.portfolioEvalMergeQueueFakeLiveReadReplayQuarantineReceipts) || 0,
      mergeQueueFinalBlockerLedgerReceipts: Number(counts.portfolioEvalMergeQueueFinalBlockerLedgerReceipts) || 0,
      mergeQueuePostLedgerOperatorReleaseAttestationReceipts: Number(counts.portfolioEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipts) || 0,
      mergeQueuePostAttestationReleaseEscrowReceipts: Number(counts.portfolioEvalMergeQueuePostAttestationReleaseEscrowReceipts) || 0,
      mergeQueueReleaseDenialCloseoutReceipts: Number(counts.portfolioEvalMergeQueueReleaseDenialCloseoutReceipts) || 0,
      mergeQueueConsolidatedBlockerAudits: Number(counts.portfolioEvalMergeQueueConsolidatedBlockerAudits) || 0,
      retentionCohortCommandCenter: Number(counts.portfolioRetentionCohortCommandCenter) || 0,
      retentionCommandWorkItemReceipts: Number(counts.portfolioRetentionCommandWorkItemReceipts) || 0,
      retentionCommandWorkItemLifecycleReceipts: Number(counts.portfolioRetentionCommandWorkItemLifecycleReceipts) || 0,
      retentionCommandWorkItemLeaseSweepReceipts: Number(counts.portfolioRetentionCommandWorkItemLeaseSweepReceipts) || 0,
      retentionCommandWorkItemLeaseMaintenanceReceipts: Number(counts.portfolioRetentionCommandWorkItemLeaseMaintenanceReceipts) || 0,
      serviceDecisionReadinessCommandCenter: Number(counts.portfolioServiceDecisionReadinessCommandCenter) || 0,
      tokenScopeObservationAdapterContractReceipts: Number(counts.portfolioEvalTokenScopeObservationAdapterContractReceipts) || 0,
      branchProtectionReadbackAdapterContractReceipts: Number(counts.portfolioEvalBranchProtectionReadbackAdapterContractReceipts) || 0
    },
    secretPatternScan,
    noRawSecretPatterns: secretPatternScan.rawTokenPatternFound === false,
    exportRedactionProofManifestRecorded: true,
    ok: includePII ? false : secretPatternScan.rawTokenPatternFound === false
  };
  return redact(manifest);
}

export function backupSqliteDataDir({
  dataDir = env.dataDir,
  outputDir = join(dataDir, 'backups'),
  now = new Date()
} = {}) {
  const sourceDir = resolve(dataDir);
  const destDir = resolve(outputDir);
  mkdirSync(destDir, { recursive: true });
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch {}
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const files = readdirSync(sourceDir)
    .filter((name) => /^callmemaybe\.db(?:-(?:wal|shm))?$/.test(name))
    .map((name) => {
      const from = join(sourceDir, name);
      const to = join(destDir, `${BACKUP_PREFIX}${stamp}-${name}`);
      copyFileSync(from, to);
      const size = statSync(to).size;
      return { source: from, backup: to, file: basename(to), bytes: size };
    });
  return {
    ok: files.length > 0,
    dataDir: sourceDir,
    backupDir: destDir,
    files
  };
}

export function resetMockData({ confirm, dryRun = true, now = new Date() } = {}) {
  if (env.nodeEnv === 'production') {
    return { ok: false, refused: true, reason: 'reset_mock_data_refuses_production' };
  }
  if (confirm !== 'RESET_MOCK_DATA') {
    return { ok: false, refused: true, reason: 'confirm must equal RESET_MOCK_DATA' };
  }
  const plan = [
    {
      action: 'delete',
      table: 'jobs',
      where: "idempotency_key LIKE 'ops-check:%' OR payload_json LIKE '%ops-check%'"
    },
    {
      action: 'archive',
      table: 'leads',
      where: "id LIKE 'demo_%' OR container_tag LIKE 'demo_%' OR source_url LIKE 'https://example.test/%'"
    }
  ];
  const counts = plan.map((item) => ({
    ...item,
    count: db.prepare(`SELECT COUNT(*) AS n FROM ${item.table} WHERE ${item.where}`).get().n
  }));
  const totalMatched = counts.reduce((sum, item) => sum + item.count, 0);
  if (dryRun) return { ok: true, dryRun: true, counts, totalMatched };
  const backup = backupSqliteDataDir({ now: now instanceof Date ? now : new Date(now) });
  if (!backup.ok) {
    return {
      ok: false,
      dryRun: false,
      refused: true,
      reason: 'backup_before_reset_failed',
      backup
    };
  }
  const changed = [];
  const resetAt = now instanceof Date ? now : new Date(now);
  const resetAtMs = Number.isFinite(resetAt.getTime()) ? resetAt.getTime() : Date.now();
  const apply = db.transaction(() => {
    for (const item of plan) {
      if (item.action === 'archive' && item.table === 'leads') {
        const result = db.prepare(`
          UPDATE leads
          SET status = 'reset_archived',
              outreach_status = 'blocked',
              next_action = 'reset_archived',
              blocked_reason = 'reset_mock_data',
              updated_at = ?
          WHERE ${item.where}
        `).run(resetAtMs);
        changed.push({ action: item.action, table: item.table, count: result.changes || 0 });
      } else {
        const result = db.prepare(`DELETE FROM ${item.table} WHERE ${item.where}`).run();
        changed.push({ action: item.action, table: item.table, count: result.changes || 0 });
      }
    }
  });
  apply();
  const deleted = changed.filter((item) => item.action === 'delete');
  const archived = changed.filter((item) => item.action === 'archive');
  return {
    ok: true,
    dryRun: false,
    counts,
    totalMatched,
    changed,
    deleted,
    archived,
    totalDeleted: deleted.reduce((sum, item) => sum + item.count, 0),
    totalArchived: archived.reduce((sum, item) => sum + item.count, 0),
    totalChanged: changed.reduce((sum, item) => sum + item.count, 0),
    backup
  };
}

export function latestBackupManifest({ dataDir = env.dataDir } = {}) {
  const backupDir = resolve(join(dataDir, 'backups'));
  if (!existsSync(backupDir)) return { backupDir, files: [] };
  const files = readdirSync(backupDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX))
    .map((name) => {
      const full = join(backupDir, name);
      const stat = statSync(full);
      return { file: name, path: full, bytes: stat.size, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { backupDir, files };
}

export function backupFreshness(backups = latestBackupManifest(), { now = Date.now(), maxAgeMs = 24 * HOUR_MS } = {}) {
  const latest = backups.files?.find((file) => file.bytes > 0);
  if (!latest) {
    return {
      ok: false,
      reason: 'No SQLite backup file exists',
      backupDir: backups.backupDir,
      latest: null
    };
  }
  const ageMs = Math.max(0, now - latest.mtimeMs);
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      reason: 'Latest SQLite backup is older than 24h',
      backupDir: backups.backupDir,
      latest,
      ageMs
    };
  }
  return {
    ok: true,
    reason: null,
    backupDir: backups.backupDir,
    latest,
    ageMs
  };
}

export function runOpsBackupJob(payload = {}) {
  const now = payload?.now ? new Date(payload.now) : new Date();
  const result = backupSqliteDataDir({ now });
  if (!result.ok) throw new Error('No SQLite files found to back up');
  return {
    ...result,
    reason: payload?.reason || 'durable_job'
  };
}

export function enqueueOpsBackup({
  now = Date.now(),
  intervalMs = env.ops.backupIntervalMs,
  reason = 'scheduler',
  runAt = now,
  maxAttempts = 3,
  idempotencyKey = null
} = {}) {
  const bucketMs = Math.max(HOUR_MS, Number(intervalMs) || 12 * HOUR_MS);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: OPS_BACKUP_JOB_TYPE,
    payload: {
      reason,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: idempotencyKey || `${OPS_BACKUP_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts
  });
}

export function startOpsBackupScheduler({
  enabled = env.ops.backupEnabled,
  intervalMs = env.ops.backupIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(HOUR_MS, Number(intervalMs) || 12 * HOUR_MS);
  if (backupTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason) => {
    const result = enqueueOpsBackup({ intervalMs: safeInterval, reason });
    log.info('ops.backup_job_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  backupTimer = setInterval(() => {
    try {
      enqueue('interval');
    } catch (err) {
      log.warn('ops.backup_scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  backupTimer.unref?.();
  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopOpsBackupScheduler() {
  if (backupTimer) clearInterval(backupTimer);
  backupTimer = null;
  return { running: false };
}

export function runProviderPostureJob(payload = {}) {
  return recordProviderPosture({
    now: parseJobNow(payload?.now),
    source: payload?.reason || payload?.source || 'durable_job',
    updateLatest: false
  });
}

export function enqueueProviderPostureRefresh({
  now = Date.now(),
  intervalMs = env.ops.providerPostureIntervalMs,
  reason = 'scheduler',
  runAt = now,
  maxAttempts = 2,
  idempotencyKey = null
} = {}) {
  const bucketMs = Math.max(60_000, Number(intervalMs) || 6 * HOUR_MS);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: OPS_PROVIDER_POSTURE_JOB_TYPE,
    payload: {
      reason,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: idempotencyKey || `${OPS_PROVIDER_POSTURE_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts
  });
}

export function startProviderPostureScheduler({
  enabled = env.ops.providerPostureEnabled,
  intervalMs = env.ops.providerPostureIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(60_000, Number(intervalMs) || 6 * HOUR_MS);
  if (providerPostureTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason) => {
    const result = enqueueProviderPostureRefresh({ intervalMs: safeInterval, reason });
    log.info('ops.provider_posture_job_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  providerPostureTimer = setInterval(() => {
    try {
      enqueue('interval');
    } catch (err) {
      log.warn('ops.provider_posture_scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  providerPostureTimer.unref?.();
  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopProviderPostureScheduler() {
  if (providerPostureTimer) clearInterval(providerPostureTimer);
  providerPostureTimer = null;
  return { running: false };
}

export function runOpsRecoveryJob(payload = {}, { recoverBuilds = null } = {}) {
  const now = parseJobNow(payload?.now);
  const dryRun = payload?.dryRun === true;
  const result = recoverStuckOperations({
    now,
    dryRun,
    recoverJobs: payload?.recoverJobs !== false,
    recoverCalls: payload?.recoverCalls !== false,
    recoverScheduledCalls: payload?.recoverScheduledCalls !== false,
    maxCallAgeMs: Number(payload?.maxCallAgeMs) || env.ops.recoveryMaxCallAgeMs,
    maxScheduledCallAgeMs: Number(payload?.maxScheduledCallAgeMs) || env.ops.recoveryMaxScheduledCallAgeMs
  });
  if (typeof recoverBuilds === 'function' && payload?.recoverBuilds !== false) {
    if (dryRun) {
      result.builds = { dryRun: true, recovered: 0, skipped: true };
    } else {
      const rows = recoverBuilds({
        staleAfterMs: Number(payload?.maxBuildAgeMs) || env.ops.recoveryMaxBuildAgeMs,
        limit: Number(payload?.limit) || 25
      }) || [];
      result.builds = { recovered: rows.length, rows };
    }
  } else {
    result.builds = { recovered: 0, skipped: true, reason: 'no_build_recovery_handler' };
  }
  result.reason = payload?.reason || 'durable_job';
  return result;
}

export function enqueueOpsRecovery({
  now = Date.now(),
  intervalMs = env.ops.recoveryIntervalMs,
  reason = 'scheduler',
  runAt = now,
  maxAttempts = 2,
  idempotencyKey = null
} = {}) {
  const bucketMs = Math.max(60_000, Number(intervalMs) || 5 * 60 * 1000);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: OPS_RECOVER_STUCK_JOB_TYPE,
    payload: {
      reason,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: idempotencyKey || `${OPS_RECOVER_STUCK_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts
  });
}

export function startOpsRecoveryScheduler({
  enabled = env.ops.recoveryEnabled,
  intervalMs = env.ops.recoveryIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(60_000, Number(intervalMs) || 5 * 60 * 1000);
  if (recoveryTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason) => {
    const result = enqueueOpsRecovery({ intervalMs: safeInterval, reason });
    log.info('ops.recover_stuck_job_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  recoveryTimer = setInterval(() => {
    try {
      enqueue('interval');
    } catch (err) {
      log.warn('ops.recover_stuck_scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  recoveryTimer.unref?.();
  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopOpsRecoveryScheduler() {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  return { running: false };
}

export function runRetentionCommandLeaseMaintenanceJob(payload = {}) {
  const now = parseJobNow(payload?.now);
  const workspaceId = payload?.workspaceId || 'ws_callan';
  const limit = Math.max(1, Math.min(Number(payload?.limit) || 25, 100));
  const snapshot = portfolioOperatingModel.snapshot({ workspaceId, limit: Math.max(limit, 50) });
  const candidates = (snapshot.retentionCohortCommandCenter || [])
    .filter((item) => Number(item.commandWorkItemCount || 0) > 0)
    .filter((item) => !payload?.serviceBusinessId || item.serviceBusinessId === payload.serviceBusinessId)
    .filter((item) => !payload?.retentionCohortRollupId || item.retentionCohortRollupId === payload.retentionCohortRollupId)
    .filter((item) => !payload?.retentionCommandWorkItemReceiptId || item.latestCommandWorkItemReceiptId === payload.retentionCommandWorkItemReceiptId)
    .slice(0, limit);
  const evidence = Array.isArray(payload?.evidence) ? payload.evidence : [];
  const actor = payload?.actor || payload?.source || 'retention_command_lease_maintenance_job';
  const receipts = candidates.map((item) => {
    const result = portfolioOperatingModel.recordRetentionCommandWorkItemLeaseMaintenance({
      workspaceId: item.workspace_id || workspaceId,
      serviceBusinessId: item.serviceBusinessId,
      retentionCohortRollupId: item.retentionCohortRollupId,
      retentionCommandWorkItemReceiptId: item.latestCommandWorkItemReceiptId,
      actor,
      evidence: [
        {
          id: `retention-command-lease-maintenance-job:${item.retentionCohortRollupId}:${now}`,
          source: OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE,
          reason: payload?.reason || 'durable_job',
          jobType: OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE,
          safetyKind: 'retention_command_work_item_lease_maintenance_job_safety',
          externalSideEffects: false,
          readOnlyTelemetry: true,
          summary: 'Recorded scheduled retention command lease maintenance without live side effects.'
        },
        ...evidence
      ],
      limit: payload?.workItemLimit || 500,
      now
    });
    return {
      id: result.receipt.id,
      status: result.receipt.status,
      retentionCohortRollupId: result.receipt.retention_cohort_rollup_id,
      retentionCommandWorkItemReceiptId: result.receipt.retention_command_work_item_receipt_id,
      workItemCount: result.receipt.work_item_count,
      activeLeaseCount: result.receipt.active_lease_count,
      staleLeaseCount: result.receipt.stale_lease_count,
      releasedLeaseCount: result.receipt.released_lease_count,
      expiredLeaseCount: result.receipt.expired_lease_count,
      nextLeaseExpiryAt: result.receipt.next_lease_expiry_at || null
    };
  });
  return {
    ok: true,
    type: OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE,
    reason: payload?.reason || 'durable_job',
    workspaceId,
    limit,
    scope: {
      serviceBusinessId: payload?.serviceBusinessId || null,
      retentionCohortRollupId: payload?.retentionCohortRollupId || null,
      retentionCommandWorkItemReceiptId: payload?.retentionCommandWorkItemReceiptId || null
    },
    scannedCommandCenterCount: candidates.length,
    receiptCount: receipts.length,
    receipts,
    safety: {
      kind: 'retention_command_work_item_lease_maintenance_job_safety',
      externalSideEffects: false,
      readOnlyTelemetry: true,
      localMaintenanceReceiptRecorded: receipts.length > 0,
      customerMessageSent: false,
      providerCalled: false,
      adapterInvoked: false,
      jobEnqueued: false,
      localLeaseUpdated: false
    }
  };
}

export function enqueueRetentionCommandLeaseMaintenance({
  now = Date.now(),
  intervalMs = env.ops.retentionCommandLeaseMaintenanceIntervalMs,
  reason = 'scheduler',
  runAt = now,
  maxAttempts = 2,
  idempotencyKey = null,
  workspaceId = 'ws_callan',
  serviceBusinessId = null,
  retentionCohortRollupId = null,
  retentionCommandWorkItemReceiptId = null,
  limit = 25
} = {}) {
  const bucketMs = Math.max(60_000, Number(intervalMs) || 15 * 60 * 1000);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE,
    payload: {
      reason,
      workspaceId,
      serviceBusinessId,
      retentionCohortRollupId,
      retentionCommandWorkItemReceiptId,
      limit,
      source: 'durable_job',
      intervalMs: bucketMs,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: idempotencyKey || `${OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE}:${workspaceId}:${bucket}`,
    runAt,
    maxAttempts
  });
}

export function startRetentionCommandLeaseMaintenanceScheduler({
  enabled = env.ops.retentionCommandLeaseMaintenanceEnabled,
  intervalMs = env.ops.retentionCommandLeaseMaintenanceIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(60_000, Number(intervalMs) || 15 * 60 * 1000);
  if (retentionCommandLeaseMaintenanceTimer) {
    return { running: true, intervalMs: safeInterval, alreadyRunning: true };
  }

  const enqueue = (reason = 'scheduler') => {
    const result = enqueueRetentionCommandLeaseMaintenance({ intervalMs: safeInterval, reason });
    log.info('ops.retention_command_lease_maintenance_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  retentionCommandLeaseMaintenanceTimer = setInterval(() => {
    try {
      enqueue('scheduler');
    } catch (err) {
      log.warn('ops.retention_command_lease_maintenance_scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  retentionCommandLeaseMaintenanceTimer.unref?.();
  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopRetentionCommandLeaseMaintenanceScheduler() {
  if (retentionCommandLeaseMaintenanceTimer) clearInterval(retentionCommandLeaseMaintenanceTimer);
  retentionCommandLeaseMaintenanceTimer = null;
  return { running: false };
}

function parseJobNow(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function opsObservability({ now = Date.now(), windowMs = 24 * HOUR_MS } = {}) {
  const since = now - windowMs;
  const dailyRevenueCents = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS cents
    FROM payments
    WHERE status = 'paid'
      AND COALESCE(paid_at, created_at, 0) >= ?
  `).get(since).cents || 0;
  const dailyCostMicros = db.prepare(`
    SELECT COALESCE(SUM(usd_micros), 0) AS micros
    FROM lead_costs
    WHERE created_at >= ?
  `).get(since).micros || 0;
  const providerCosts = db.prepare(`
    SELECT provider,
           COUNT(*) AS events,
           COALESCE(SUM(usd_micros), 0) AS micros,
           COALESCE(SUM(units), 0) AS units,
           MAX(created_at) AS lastAt
    FROM lead_costs
    WHERE created_at >= ?
    GROUP BY provider
    ORDER BY micros DESC
  `).all(since).map((row) => ({
    provider: row.provider,
    events: row.events,
    costUsd: round2(row.micros / 1_000_000),
    units: row.units,
    lastAt: row.lastAt
  }));
  const providerHealth = Object.entries(providerSmoke.all()).map(([provider, row]) => ({
    provider,
    status: row.status,
    checkedAt: row.checkedAt,
    ageMs: row.checkedAt ? Math.max(0, now - row.checkedAt) : null,
    detail: row.detail
  }));
  const providerHistory = providerSmoke.historySummary({ since });
  const providerHealthSloResult = providerHealthSlo(providerHistory);
  const recentProviderFailures = providerSmoke.issues({ since, limit: 25 });
  const safeToSellHistory = safeToSellReports.summary({ since, limit: 10 });
  const safeToRenewHistory = safeToRenewReports.summary({ since, limit: 10 });
  const safeToRenewPlaybookHistory = safeToRenewPlaybooks.summary({ since, limit: 10 });
  const accountOperatorBoard = accountTasks.operatorBoardSummary();
  const renewalChangeRequestQueue = summarizeRenewalChangeRequestQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalBillingChangePreflightQueue = summarizeRenewalBillingChangePreflightQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalBillingExecutionReceiptQueue = summarizeRenewalBillingExecutionReceiptQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalCustomerMessagePreflightQueue = summarizeRenewalCustomerMessagePreflightQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalCustomerMessageSendReceiptQueue = summarizeRenewalCustomerMessageSendReceiptQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalCustomerConfirmationQueue = summarizeRenewalCustomerConfirmationQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalCustomerConfirmationAcknowledgementQueue = summarizeRenewalCustomerConfirmationAcknowledgementQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalCustomerConfirmationAcceptanceQueue = summarizeRenewalCustomerConfirmationAcceptanceQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalCustomerConfirmationFollowupQueue = summarizeRenewalCustomerConfirmationFollowupQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const renewalCustomerConfirmationCloseoutPacketQueue = summarizeRenewalCustomerConfirmationCloseoutPacketQueue({
    windowMs: 30 * 24 * HOUR_MS,
    now,
    limit: 200
  });
  const workerHistory = workerRunHistory({ since, now });
  const durableJobIssueHistory = durableJobIssues({ since });
  const workerHealthSloResult = workerHealthSlo(workerHistory, durableJobIssueHistory);
  const recentFailures = db.prepare(`
    SELECT id, worker, state, lead_id, started_at, finished_at, error
    FROM worker_runs
    WHERE COALESCE(finished_at, started_at, 0) >= ?
      AND (state = 'failed' OR error IS NOT NULL)
    ORDER BY COALESCE(finished_at, started_at, 0) DESC
    LIMIT 25
  `).all(since).map((row) => {
    const safe = redact(row);
    return {
      ...safe,
      error: safe.error ? operationalErrorSummary(safe.error) : null
    };
  });
  const stuck = {
    jobs: durableJobs.summary({ now }).staleRunning,
    builds: db.prepare(`
      SELECT id, lead_id, status, COALESCE(updated_at, started_at, 0) AS lastAt, error
      FROM builds
      WHERE status IN ('queued', 'starting', 'running')
        AND COALESCE(updated_at, started_at, 0) < ?
      ORDER BY lastAt ASC
      LIMIT 25
    `).all(now - 30 * 60 * 1000),
    calls: db.prepare(`
      SELECT id, lead_id, provider_call_id, state, started_at
      FROM calls
      WHERE state IN ('in_progress', 'ringing', 'active')
        AND started_at < ?
      ORDER BY started_at ASC
      LIMIT 25
    `).all(now - 45 * 60 * 1000)
  };
  const outreach = {
    byStatus: Object.fromEntries(db.prepare(`
      SELECT outreach_status, COUNT(*) AS n
      FROM leads
      GROUP BY outreach_status
    `).all().map((row) => [row.outreach_status || 'unknown', row.n])),
    nextActions: db.prepare(`
      SELECT COALESCE(next_action, 'none') AS nextAction, COUNT(*) AS n
      FROM leads
      GROUP BY COALESCE(next_action, 'none')
      ORDER BY n DESC
      LIMIT 20
    `).all()
  };
  const revenueUsd = dailyRevenueCents / 100;
  const costUsd = dailyCostMicros / 1_000_000;
  const dailyEconomics = {
    revenueUsd: round2(revenueUsd),
    costUsd: round2(costUsd),
    marginUsd: round2(revenueUsd - costUsd),
    marginPct: revenueUsd > 0 ? Number((((revenueUsd - costUsd) / revenueUsd) * 100).toFixed(2)) : null
  };
  const schedulerHealth = recurringOpsJobHealth({ now });
  const economicsHealthResult = economicsHealth(dailyEconomics);
  return {
    generatedAt: new Date(now).toISOString(),
    windowMs,
    schedulerHealth,
    economicsHealth: economicsHealthResult,
    providerHealth,
    providerHealthSlo: providerHealthSloResult,
    providerHistory,
    recentProviderFailures,
    workerHealthSlo: workerHealthSloResult,
    workerHistory,
    durableJobIssueHistory,
    safeToSellHistory,
    safeToRenewHistory,
    safeToRenewPlaybookHistory,
    accountOperatorBoard,
    renewalChangeRequestQueue,
    renewalBillingChangePreflightQueue,
    renewalBillingExecutionReceiptQueue,
    renewalCustomerMessagePreflightQueue,
    renewalCustomerMessageSendReceiptQueue,
    renewalCustomerConfirmationQueue,
    renewalCustomerConfirmationAcknowledgementQueue,
    renewalCustomerConfirmationAcceptanceQueue,
    renewalCustomerConfirmationFollowupQueue,
    renewalCustomerConfirmationCloseoutPacketQueue,
    providerCosts,
    recentFailures,
    stuck,
    outreach,
    dailyEconomics
  };
}

function workerRunHistory({ since = 0, now = Date.now() } = {}) {
  const checkedSince = Math.max(0, Number(since) || 0);
  const rows = db.prepare(`
    SELECT worker,
           COUNT(*) AS total,
           SUM(CASE WHEN state = 'failed' OR error IS NOT NULL THEN 1 ELSE 0 END) AS failed_count,
           SUM(CASE WHEN state = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
           SUM(CASE WHEN state NOT IN ('failed', 'running', 'blocked') AND error IS NULL THEN 1 ELSE 0 END) AS ok_count,
           MAX(COALESCE(finished_at, started_at, 0)) AS last_at
    FROM worker_runs
    WHERE COALESCE(finished_at, started_at, 0) >= ?
    GROUP BY worker
    ORDER BY worker
  `).all(checkedSince);
  const latestErrors = db.prepare(`
    SELECT worker, error
    FROM worker_runs
    WHERE COALESCE(finished_at, started_at, 0) >= ?
      AND error IS NOT NULL
    ORDER BY COALESCE(finished_at, started_at, 0) DESC
  `).all(checkedSince);
  const errorByWorker = new Map();
  for (const row of latestErrors) {
    if (!errorByWorker.has(row.worker)) errorByWorker.set(row.worker, operationalErrorSummary(redact(row.error)));
  }
  return rows.map((row) => {
    const total = Number(row.total) || 0;
    const failureCount = Number(row.failed_count) || 0;
    const providerRecovery = workerProviderRecovery({ worker: row.worker, since: checkedSince, now });
    const recoveredFailureCount = Math.min(failureCount, providerRecovery.recoveredFailureCount || 0);
    const effectiveFailureCount = Math.max(0, failureCount - recoveredFailureCount);
    return {
      worker: row.worker,
      total,
      okCount: Number(row.ok_count) || 0,
      blockedCount: Number(row.blocked_count) || 0,
      failureCount,
      recoveredFailureCount,
      effectiveFailureCount,
      failureRatePct: total > 0 ? Number(((failureCount / total) * 100).toFixed(2)) : 0,
      effectiveFailureRatePct: total > 0 ? Number(((effectiveFailureCount / total) * 100).toFixed(2)) : 0,
      providerRecovery: providerRecovery.providers,
      lastAt: row.last_at || null,
      lastError: errorByWorker.get(row.worker) || null
    };
  });
}

function workerProviderRecovery({ worker, since = 0, now = Date.now() } = {}) {
  const providers = WORKER_PROVIDER_DEPENDENCIES[worker] || [];
  if (!providers.length) return { recoveredFailureCount: 0, providers: [] };
  const rows = db.prepare(`
    SELECT id, error, COALESCE(finished_at, started_at, 0) AS at
    FROM worker_runs
    WHERE worker = ?
      AND COALESCE(finished_at, started_at, 0) >= ?
      AND error IS NOT NULL
    ORDER BY at DESC
    LIMIT 100
  `).all(worker, Math.max(0, Number(since) || 0));
  const recoveredRunIds = new Set();
  const providerRows = providers.map((provider) => {
    const failures = rows.filter((row) => providerFailureMatches(row.error, provider));
    const latestFailureAt = failures.reduce((max, row) => Math.max(max, Number(row.at) || 0), 0) || null;
    const liveOk = providerSmoke.latestEvent({ provider, live: true, statuses: ['ok'] });
    const incident = providerRuntimeIncident(provider, { now });
    const recovered = failures.length > 0
      && latestFailureAt
      && liveOk?.checkedAt
      && liveOk.checkedAt > latestFailureAt
      && !incident.blocked;
    if (recovered) {
      for (const row of failures) recoveredRunIds.add(row.id);
    }
    return {
      provider,
      failureCount: failures.length,
      latestFailureAt,
      liveSmokeOkAt: liveOk?.checkedAt || null,
      incidentBlocked: !!incident.blocked,
      recovered: !!recovered,
      reason: failures.length
        ? recovered
          ? `${provider} live smoke passed after latest ${worker} failure`
          : `${provider} has not passed a live smoke after latest ${worker} failure`
        : null
    };
  });
  return {
    recoveredFailureCount: recoveredRunIds.size,
    providers: providerRows.filter((row) => row.failureCount > 0)
  };
}

function providerFailureMatches(error, provider) {
  if (isProviderRuntimeError(error, provider)) return true;
  const normalizedError = String(error || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedProvider = String(provider || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!normalizedProvider && normalizedError.includes(normalizedProvider);
}

function durableJobIssues({ since = 0 } = {}) {
  const checkedSince = Math.max(0, Number(since) || 0);
  const rows = db.prepare(`
    SELECT type,
           COUNT(*) AS issue_count,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
           SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry_count,
           MAX(updated_at) AS last_at
    FROM jobs
    WHERE updated_at >= ?
      AND status IN ('failed', 'retry')
    GROUP BY type
    ORDER BY type
  `).all(checkedSince);
  const latestErrors = db.prepare(`
    SELECT type, error
    FROM jobs
    WHERE updated_at >= ?
      AND status IN ('failed', 'retry')
      AND error IS NOT NULL
    ORDER BY updated_at DESC
  `).all(checkedSince);
  const errorByType = new Map();
  for (const row of latestErrors) {
    if (!errorByType.has(row.type)) errorByType.set(row.type, operationalErrorSummary(redact(row.error)));
  }
  return rows.map((row) => ({
    type: row.type,
    issueCount: Number(row.issue_count) || 0,
    failedCount: Number(row.failed_count) || 0,
    retryCount: Number(row.retry_count) || 0,
    lastAt: row.last_at || null,
    lastError: errorByType.get(row.type) || null
  }));
}

export function workerHealthSlo(workerHistory = [], durableJobIssueHistory = [], {
  maxFailuresPer24h = env.ops.workerMaxFailuresPer24h,
  maxFailureRatePct = env.ops.workerMaxFailureRatePct,
  minRunsForFailureRate = env.ops.workerMinRunsForFailureRate,
  maxJobIssuesPer24h = env.ops.jobMaxIssuesPer24h
} = {}) {
  const failureLimit = finiteNumber(maxFailuresPer24h, 3);
  const rateLimit = finiteNumber(maxFailureRatePct, 25);
  const minRuns = Math.max(1, Math.round(finiteNumber(minRunsForFailureRate, 4)));
  const jobIssueLimit = finiteNumber(maxJobIssuesPer24h, 5);
  const workers = (workerHistory || []).map((row) => {
    const blockers = [];
    const effectiveFailureCount = Number.isFinite(Number(row.effectiveFailureCount))
      ? Number(row.effectiveFailureCount)
      : Number(row.failureCount) || 0;
    const effectiveFailureRatePct = Number.isFinite(Number(row.effectiveFailureRatePct))
      ? Number(row.effectiveFailureRatePct)
      : Number(row.failureRatePct) || 0;
    if (effectiveFailureCount > failureLimit) {
      blockers.push(workerSloBlocker(row.worker, `${effectiveFailureCount} unrecovered failures exceed OPS_WORKER_MAX_FAILURES_24H ${failureLimit}`));
    }
    if (row.total >= minRuns && effectiveFailureRatePct > rateLimit) {
      blockers.push(workerSloBlocker(row.worker, `unrecovered failure rate ${effectiveFailureRatePct.toFixed(2)}% exceeds OPS_WORKER_MAX_FAILURE_RATE_PCT ${rateLimit.toFixed(2)}%`));
    }
    return {
      ...row,
      effectiveFailureCount,
      effectiveFailureRatePct,
      ok: blockers.length === 0,
      blockers
    };
  });
  const durableJobs = (durableJobIssueHistory || []).map((row) => {
    const blockers = row.issueCount > jobIssueLimit
      ? [jobSloBlocker(row.type, `${row.issueCount} retry/failed jobs exceed OPS_JOB_MAX_ISSUES_24H ${jobIssueLimit}`)]
      : [];
    return {
      ...row,
      ok: blockers.length === 0,
      blockers
    };
  });
  const blockers = [
    ...workers.flatMap((row) => row.blockers),
    ...durableJobs.flatMap((row) => row.blockers)
  ];
  return {
    ok: blockers.length === 0,
    blockers,
    thresholds: {
      maxFailuresPer24h: failureLimit,
      maxFailureRatePct: rateLimit,
      minRunsForFailureRate: minRuns,
      maxJobIssuesPer24h: jobIssueLimit
    },
    workers,
    durableJobs
  };
}

export function providerHealthSlo(history = [], {
  maxIssueRatePct = env.ops.providerMaxIssueRatePct,
  minEventsForIssueRate = env.ops.providerMinEventsForIssueRate,
  maxAvgLatencyMs = env.ops.providerMaxAvgLatencyMs,
  now = Date.now()
} = {}) {
  const issueRateLimit = finiteNumber(maxIssueRatePct, 20);
  const minEvents = Math.max(1, Math.round(finiteNumber(minEventsForIssueRate, 3)));
  const latencyLimit = finiteNumber(maxAvgLatencyMs, 15_000);
  const issueStatuses = new Set(['failed', 'blocked', 'degraded']);
  const providers = (history || []).map((row) => {
    const total = Number(row.total) || 0;
    const issueCount = (Number(row.failedCount) || 0) + (Number(row.blockedCount) || 0) + (Number(row.degradedCount) || 0);
    const issueRatePct = total > 0 ? Number(((issueCount / total) * 100).toFixed(2)) : 0;
    const avgDurationMs = row.avgDurationMs === null || row.avgDurationMs === undefined ? null : Number(row.avgDurationMs);
    const runtimeIncident = providerRuntimeIncident(row.provider, { now });
    const blockers = [];

    if (runtimeIncident.blocked) {
      blockers.push(providerSloBlocker(row.provider, `${row.provider} provider has an uncleared runtime incident: ${operationalErrorSummary(runtimeIncident.reason)}`));
    }
    if (issueStatuses.has(row.currentStatus)) {
      blockers.push(providerSloBlocker(row.provider, `latest smoke status is ${row.currentStatus}${row.lastError ? `: ${operationalErrorSummary(row.lastError)}` : ''}`));
    }
    if (total >= minEvents && issueRatePct > issueRateLimit) {
      blockers.push(providerSloBlocker(row.provider, `issue rate ${issueRatePct.toFixed(2)}% exceeds OPS_PROVIDER_MAX_ISSUE_RATE_PCT ${issueRateLimit.toFixed(2)}%`));
    }
    if (avgDurationMs !== null && Number.isFinite(avgDurationMs) && avgDurationMs > latencyLimit) {
      blockers.push(providerSloBlocker(row.provider, `average latency ${Math.round(avgDurationMs)}ms exceeds OPS_PROVIDER_MAX_AVG_LATENCY_MS ${Math.round(latencyLimit)}ms`));
    }

    return {
      provider: row.provider,
      ok: blockers.length === 0,
      total,
      issueCount,
      issueRatePct,
      avgDurationMs,
      currentStatus: row.currentStatus || null,
      lastCheckedAt: row.lastCheckedAt || null,
      lastError: row.lastError ? operationalErrorSummary(row.lastError) : null,
      runtimeIncident: {
        blocked: !!runtimeIncident.blocked,
        reason: runtimeIncident.blocked && runtimeIncident.reason
          ? `${row.provider} provider has an uncleared runtime incident: ${operationalErrorSummary(runtimeIncident.reason)}`
          : null,
        checkedAt: runtimeIncident.incident?.checkedAt || null,
        ageMs: runtimeIncident.ageMs ?? null,
        clearedBy: runtimeIncident.clearedBy?.checkedAt || null
      },
      blockers
    };
  });
  const blockers = providers.flatMap((row) => row.blockers);
  return {
    ok: blockers.length === 0,
    blockers,
    thresholds: {
      maxIssueRatePct: issueRateLimit,
      minEventsForIssueRate: minEvents,
      maxAvgLatencyMs: latencyLimit
    },
    providers
  };
}

export function economicsHealth(economics = {}, {
  maxDailyCostUsd = env.ops.economicsMaxDailyCostUsd,
  maxDailyLossUsd = env.ops.economicsMaxDailyLossUsd,
  minMarginPct = env.ops.economicsMinMarginPct
} = {}) {
  const revenueUsd = round2(economics.revenueUsd);
  const costUsd = round2(economics.costUsd);
  const marginUsd = round2(economics.marginUsd ?? (revenueUsd - costUsd));
  const marginPct = revenueUsd > 0
    ? Number((economics.marginPct ?? ((marginUsd / revenueUsd) * 100)).toFixed(2))
    : null;
  const blockers = [];

  if (isFiniteThreshold(maxDailyCostUsd) && costUsd > maxDailyCostUsd) {
    blockers.push(`daily cost $${costUsd.toFixed(2)} exceeds OPS_MAX_DAILY_COST_USD $${Number(maxDailyCostUsd).toFixed(2)}`);
  }
  if (isFiniteThreshold(maxDailyLossUsd) && marginUsd < -maxDailyLossUsd) {
    blockers.push(`daily loss $${Math.abs(marginUsd).toFixed(2)} exceeds OPS_MAX_DAILY_LOSS_USD $${Number(maxDailyLossUsd).toFixed(2)}`);
  }
  if (revenueUsd > 0 && isFiniteThreshold(minMarginPct) && marginPct !== null && marginPct < minMarginPct) {
    blockers.push(`daily margin ${marginPct.toFixed(2)}% is below OPS_MIN_MARGIN_PCT ${Number(minMarginPct).toFixed(2)}%`);
  }

  return {
    ok: blockers.length === 0,
    blockers,
    status: blockers.length ? 'blocked' : 'healthy',
    thresholds: {
      maxDailyCostUsd: Number(maxDailyCostUsd),
      maxDailyLossUsd: Number(maxDailyLossUsd),
      minMarginPct: Number(minMarginPct)
    },
    dailyEconomics: {
      revenueUsd,
      costUsd,
      marginUsd,
      marginPct
    }
  };
}

export function recurringOpsJobHealth({ now = Date.now() } = {}) {
  const jobs = recurringOpsJobSpecs().map((spec) => {
    const latest = latestDurableJob({ type: spec.type });
    const latestCompleted = latestDurableJob({ type: spec.type, statuses: ['completed'] });
    const latestIssue = latestDurableJob({ type: spec.type, statuses: ['failed', 'retry'] });
    const completedAt = jobTime(latestCompleted);
    const ageMs = completedAt ? Math.max(0, now - completedAt) : null;
    const maxAgeMs = schedulerFreshnessWindow(spec.intervalMs);
    const blockers = [];

    if (spec.enabled) {
      if (!latestCompleted) blockers.push(`${spec.type} has not completed`);
      else if (ageMs > maxAgeMs) blockers.push(`${spec.type} last completed job is stale`);
      if (latestIssue && jobTime(latestIssue) > (completedAt || 0)) {
        blockers.push(`${spec.type} latest job ${latestIssue.status}${latestIssue.error ? `: ${latestIssue.error}` : ''}`);
      }
    }

    return {
      type: spec.type,
      label: spec.label,
      enabled: spec.enabled,
      intervalMs: spec.intervalMs,
      maxAgeMs,
      ok: !spec.enabled || blockers.length === 0,
      blockers,
      lastCompletedAt: completedAt,
      ageMs,
      latest: compactJob(latest),
      latestCompleted: compactJob(latestCompleted),
      latestIssue: compactJob(latestIssue)
    };
  });
  const blockers = jobs.flatMap((job) => job.blockers || []);
  return {
    ok: blockers.length === 0,
    generatedAt: new Date(now).toISOString(),
    blockers,
    total: jobs.length,
    enabled: jobs.filter((job) => job.enabled).length,
    healthy: jobs.filter((job) => job.enabled && job.ok).length,
    jobs
  };
}

export async function refreshStaleOpsMaintenance({
  now = Date.now(),
  reason = 'safe_to_sell_preflight',
  timeoutMs = 10_000
} = {}) {
  const before = recurringOpsJobHealth({ now });
  const handlers = {
    [OPS_BACKUP_JOB_TYPE]: runOpsBackupJob,
    [OPS_PROVIDER_POSTURE_JOB_TYPE]: runProviderPostureJob,
    [OPS_RECOVER_STUCK_JOB_TYPE]: runOpsRecoveryJob,
    [OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE]: runRetentionCommandLeaseMaintenanceJob,
    [ACCOUNT_MANAGER_RUN_JOB_TYPE]: handleAccountManagerRunJob,
    [SAFE_TO_RENEW_JOB_TYPE]: runSafeToRenewSelfCheck
  };
  const stale = before.jobs.filter((job) => job.enabled && !job.ok && handlers[job.type]);
  if (!stale.length) {
    return {
      ok: true,
      refreshed: 0,
      jobs: [],
      before,
      after: before
    };
  }

  const queued = [];
  for (const job of stale) {
    const key = `safe-to-sell-preflight:${job.type}:${now}`;
    const common = {
      now,
      reason,
      runAt: now,
      idempotencyKey: key
    };
    if (job.type === OPS_BACKUP_JOB_TYPE) queued.push(enqueueOpsBackup(common));
    if (job.type === OPS_PROVIDER_POSTURE_JOB_TYPE) queued.push(enqueueProviderPostureRefresh(common));
    if (job.type === OPS_RECOVER_STUCK_JOB_TYPE) queued.push(enqueueOpsRecovery(common));
    if (job.type === OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE) queued.push(enqueueRetentionCommandLeaseMaintenance(common));
    if (job.type === SAFE_TO_RENEW_JOB_TYPE) queued.push(enqueueJob({
      type: SAFE_TO_RENEW_JOB_TYPE,
      payload: {
        reason,
        source: 'safe_to_sell_preflight',
        enqueuedAt: new Date(now).toISOString()
      },
      idempotencyKey: key,
      runAt: now,
      maxAttempts: 2
    }));
    if (job.type === ACCOUNT_MANAGER_RUN_JOB_TYPE) {
      queued.push(enqueueAccountManagerRun({
        ...common,
        intervalMs: job.intervalMs,
        dryRun: true,
        source: 'safe_to_sell_preflight'
      }));
    }
  }

  const selectedHandlers = Object.fromEntries(stale.map((job) => [job.type, handlers[job.type]]));
  const drained = await drainDurableJobsOnce(selectedHandlers, {
    workerId: 'safe-to-sell-preflight',
    concurrency: stale.length + 1,
    maxJobs: stale.length
  });
  const settled = await waitForDurableJobs(queued.map((item) => item.row?.id).filter(Boolean), { timeoutMs });
  const after = recurringOpsJobHealth({ now: Date.now() });
  const failed = settled.filter((row) => row?.status !== 'completed');
  return {
    ok: failed.length === 0,
    refreshed: settled.filter((row) => row?.status === 'completed').length,
    jobs: stale.map((job, index) => ({
      type: job.type,
      previousBlockers: job.blockers,
      queued: queued[index]?.row?.id || null,
      inserted: !!queued[index]?.inserted,
      status: settled[index]?.status || 'missing',
      error: settled[index]?.error || null
    })),
    drained,
    before,
    after
  };
}

function recurringOpsJobSpecs() {
  return [
    {
      type: OPS_BACKUP_JOB_TYPE,
      label: 'SQLite backup',
      enabled: env.ops.backupEnabled,
      intervalMs: env.ops.backupIntervalMs
    },
    {
      type: OPS_PROVIDER_POSTURE_JOB_TYPE,
      label: 'Provider posture',
      enabled: env.ops.providerPostureEnabled,
      intervalMs: env.ops.providerPostureIntervalMs
    },
    {
      type: OPS_RECOVER_STUCK_JOB_TYPE,
      label: 'Stuck recovery',
      enabled: env.ops.recoveryEnabled,
      intervalMs: env.ops.recoveryIntervalMs
    },
    {
      type: OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE,
      label: 'Retention command lease maintenance',
      enabled: env.ops.retentionCommandLeaseMaintenanceEnabled,
      intervalMs: env.ops.retentionCommandLeaseMaintenanceIntervalMs
    },
    {
      type: OPS_SAFE_TO_SELL_JOB_TYPE,
      label: 'Safe-to-sell self-check',
      enabled: env.ops.safeToSellCheckEnabled,
      intervalMs: env.ops.safeToSellCheckIntervalMs
    },
    {
      type: SAFE_TO_RENEW_JOB_TYPE,
      label: 'Safe-to-renew self-check',
      enabled: env.ops.safeToRenewCheckEnabled,
      intervalMs: env.ops.safeToRenewCheckIntervalMs
    },
    {
      type: ACCOUNT_MANAGER_RUN_JOB_TYPE,
      label: 'Account manager',
      enabled: env.accountManager.enabled,
      intervalMs: env.accountManager.intervalMs
    }
  ];
}

function latestDurableJob({ type, statuses = [] } = {}) {
  if (!type) return null;
  const statusList = Array.isArray(statuses) ? statuses.filter(Boolean) : [];
  const params = [type];
  const statusWhere = statusList.length ? `AND status IN (${statusList.map(() => '?').join(', ')})` : '';
  params.push(...statusList);
  const row = db.prepare(`
    SELECT *
    FROM jobs
    WHERE type = ?
      ${statusWhere}
    ORDER BY COALESCE(finished_at, updated_at, created_at, 0) DESC
    LIMIT 1
  `).get(...params);
  if (!row) return null;
  return {
    ...row,
    payload: safeJson(row.payload_json) || {},
    result: safeJson(row.result_json) || null
  };
}

function compactJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    error: row.error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at || null
  };
}

function jobTime(row) {
  return row ? Number(row.finished_at || row.updated_at || row.created_at || 0) : null;
}

async function waitForDurableJobs(ids, { timeoutMs = 10_000 } = {}) {
  if (!ids.length) return [];
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 10_000);
  const terminal = new Set(['completed', 'failed', 'canceled']);
  while (Date.now() < deadline) {
    const rows = ids.map((id) => durableJobs.get(id));
    if (rows.every((row) => row && terminal.has(row.status))) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ids.map((id) => durableJobs.get(id));
}

function schedulerFreshnessWindow(intervalMs) {
  const interval = Number(intervalMs) || 0;
  return Math.max(MIN_SCHEDULER_FRESH_MS, interval * 2);
}

export function recoverStuckOperations({
  now = Date.now(),
  dryRun = false,
  recoverJobs = true,
  recoverCalls = true,
  recoverScheduledCalls = true,
  maxCallAgeMs = 45 * 60 * 1000,
  maxScheduledCallAgeMs = 60 * 1000
} = {}) {
  const staleJobs = durableJobs.summary({ now }).staleRunning;
  const jobs = recoverJobs
    ? {
        stale: staleJobs,
        recovered: dryRun ? 0 : durableJobs.recoverExpiredLeases({ now, limit: 200 })
      }
    : { stale: staleJobs, recovered: 0, skipped: true };
  const callRecovery = recoverCalls
    ? calls.recoverStuck({ maxAgeMs: maxCallAgeMs, now, limit: 200, dryRun })
    : { dryRun, matched: 0, recovered: 0, rows: [], skipped: true };
  const scheduledMatched = recoverScheduledCalls ? db.prepare(`
    SELECT COUNT(*) AS n
    FROM scheduled_calls
    WHERE status = 'placing'
      AND fired_at IS NOT NULL
      AND fired_at < ?
  `).get(now - maxScheduledCallAgeMs).n : 0;
  const scheduledCallRecovery = recoverScheduledCalls
    ? {
        dryRun,
        matched: scheduledMatched,
        recovered: dryRun ? 0 : scheduledCalls.recoverStuck({ maxAgeMs: maxScheduledCallAgeMs, now })
      }
    : { dryRun, matched: 0, recovered: 0, skipped: true };
  return {
    ok: true,
    dryRun,
    generatedAt: new Date(now).toISOString(),
    jobs,
    calls: callRecovery,
    scheduledCalls: scheduledCallRecovery,
    observability: opsObservability({ now })
  };
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function providerSloBlocker(provider, reason) {
  return `provider health SLO blocked: ${provider} ${reason}`;
}

function workerSloBlocker(worker, reason) {
  return `worker health SLO blocked: ${worker} ${reason}`;
}

function jobSloBlocker(type, reason) {
  return `durable job health SLO blocked: ${type} ${reason}`;
}

function isFiniteThreshold(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
