import { randomBytes } from 'node:crypto';
import { db, safeToRenewPlaybooks, safeToRenewReports, subscriptions } from './db.js';
import { enqueueJob } from './jobs.js';
import { env } from './env.js';
import { log, redact } from './logger.js';

export const SAFE_TO_RENEW_JOB_TYPE = 'ops.safe_to_renew';
export const SAFE_TO_RENEW_REPORT_VERSION = 1;
export const SAFE_TO_RENEW_SNAPSHOT_FRESH_MS = 26 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RENEWAL_STATUSES = ['active', 'trialing', 'past_due'];
const HOSTING_TASK_KIND = 'hosting_subscription_status';
let safeToRenewTimer = null;

export function safeToRenewSnapshotStatus(snapshot, {
  now = Date.now(),
  freshMs = SAFE_TO_RENEW_SNAPSHOT_FRESH_MS
} = {}) {
  const base = {
    ok: false,
    fresh: false,
    id: snapshot?.id || null,
    generatedAt: snapshot?.generatedAt || null,
    ageMs: null,
    freshMs,
    reason: 'safe-to-renew durable snapshot is missing',
    snapshot: null
  };
  if (!snapshot?.report || !snapshot.generatedAt) return base;
  if (snapshot.report.version !== SAFE_TO_RENEW_REPORT_VERSION) {
    return {
      ...base,
      id: snapshot.id,
      generatedAt: snapshot.generatedAt,
      ageMs: Math.max(0, now - snapshot.generatedAt),
      reason: 'safe-to-renew durable snapshot policy version is stale'
    };
  }
  const ageMs = Math.max(0, now - snapshot.generatedAt);
  if (ageMs > freshMs) {
    return {
      ...base,
      id: snapshot.id,
      generatedAt: snapshot.generatedAt,
      ageMs,
      reason: 'safe-to-renew durable snapshot is stale'
    };
  }
  return {
    ok: true,
    fresh: true,
    id: snapshot.id,
    generatedAt: snapshot.generatedAt,
    ageMs,
    freshMs,
    reason: null,
    snapshot: { ...snapshot, ageMs, freshMs }
  };
}

export function buildSafeToRenewStatus({
  now = Date.now(),
  taskFreshMs = 30 * DAY_MS,
  previewFreshMs = 14 * DAY_MS,
  limit = 500
} = {}) {
  const activeRows = listActiveSubscriptions({ limit });
  const tasksByLead = hostingTasksByLead(activeRows.map((row) => row.lead_id), { limit: limit * 2 });
  const customers = activeRows.map((subscriptionRow) => subscriptionRenewalStatus({
    subscription: subscriptionRow,
    tasks: tasksByLead.get(subscriptionRow.lead_id) || [],
    now,
    taskFreshMs,
    previewFreshMs
  }));
  const blockers = unique(customers.flatMap((row) => row.blockers || []));
  const renewalSavePlaybooks = customers
    .filter(shouldCreateRenewalSavePlaybook)
    .map((customer) => buildRenewalSavePlaybook({ customer, now }));
  const nextActions = renewalNextActions(customers);
  const hostingTasks = [...tasksByLead.values()].flat();
  const dueHostingTasks = hostingTasks.filter((task) => task.due_at <= now && ['pending', 'approved', 'paused'].includes(task.status));
  const blockedHostingTasks = hostingTasks.filter((task) => task.status === 'blocked' || task.policy?.blocked === true);
  const previewedHostingTasks = hostingTasks.filter((task) => hasRecentPreview(task, now, previewFreshMs));
  const staleHostingTasks = hostingTasks.filter((task) => isStaleTask(task, now, taskFreshMs));
  const sentHostingTasks = hostingTasks.filter((task) => Number.isFinite(Number(task.sent_at)));
  const status = blockers.length
    ? 'blocked'
    : activeRows.length
      ? 'ready'
      : 'no_active_subscriptions';

  return redact({
    version: SAFE_TO_RENEW_REPORT_VERSION,
    ok: blockers.length === 0,
    safeToRenew: blockers.length === 0,
    status,
    generatedAt: new Date(now).toISOString(),
    command: 'npm run safe-to-renew',
    activeSubscriptionCount: activeRows.length,
    activeMrrCents: subscriptions.activeMrrCents(),
    activeMrrUsd: round2(subscriptions.activeMrrCents() / 100),
    subscriptionsByStatus: statusCounts(),
    hostingTaskCount: hostingTasks.length,
    dueHostingTaskCount: dueHostingTasks.length,
    blockedHostingTaskCount: blockedHostingTasks.length,
    previewedHostingTaskCount: previewedHostingTasks.length,
    staleHostingTaskCount: staleHostingTasks.length,
    sentHostingTaskCount: sentHostingTasks.length,
    missingHostingTaskCount: customers.filter((row) => row.taskStatus === 'missing').length,
    dryRunProofCount: customers.filter((row) => row.dryRunProof).length,
    atRiskSubscriptionCount: renewalSavePlaybooks.length,
    renewalSavePlaybookCount: renewalSavePlaybooks.length,
    expectedRetainedRevenueCents: renewalSavePlaybooks.reduce((sum, row) => sum + (row.expectedRetainedRevenueCents || 0), 0),
    expectedRetainedRevenueUsd: round2(renewalSavePlaybooks.reduce((sum, row) => sum + (row.expectedRetainedRevenueCents || 0), 0) / 100),
    liveSideEffects: false,
    renewalMessageSentByCheck: false,
    blockers,
    nextActions,
    renewalSavePlaybooks: renewalSavePlaybooks.slice(0, 50),
    customers: customers.slice(0, 50)
  });
}

export function safeToRenewNextActions(renewal = {}) {
  if (!renewal || renewal.safeToRenew !== false) return [];
  return renewal.nextActions || [];
}

export async function runSafeToRenewSelfCheck({
  record = true,
  source = 'self_check',
  now = Date.now()
} = {}) {
  const report = {
    ...buildSafeToRenewStatus({ now }),
    source
  };
  report.decisionReceipt = buildSafeToRenewDecisionReceipt(report);
  if (record) {
    const snapshotId = `renew_${now.toString(36)}_${randomBytes(4).toString('hex')}`;
    const plannedPlaybookIds = (report.renewalSavePlaybooks || []).map((row) => row.id).filter(Boolean);
    report.renewalSavePlaybookReceipts = {
      durable: true,
      count: plannedPlaybookIds.length,
      ids: plannedPlaybookIds,
      externalSideEffects: false,
      customerMessageSent: false,
      subscriptionChanged: false
    };
    report.decisionReceipt = {
      ...(report.decisionReceipt || buildSafeToRenewDecisionReceipt(report)),
      snapshotId,
      durable: true,
      proof: {
        ...((report.decisionReceipt || {}).proof || {}),
        renewalSavePlaybooks: plannedPlaybookIds.length,
        expectedRetainedRevenueCents: report.expectedRetainedRevenueCents || 0
      }
    };
    const snapshot = safeToRenewReports.record(report, { id: snapshotId, now });
    const recordedPlaybooks = safeToRenewPlaybooks.recordMany(report.renewalSavePlaybooks || [], {
      snapshotId: snapshot.id,
      now
    });
    report.snapshot = {
      id: snapshot.id,
      recordedAt: new Date(snapshot.createdAt).toISOString(),
      generatedAt: new Date(snapshot.generatedAt).toISOString()
    };
    report.renewalSavePlaybookReceipts = {
      durable: true,
      count: recordedPlaybooks.length,
      ids: recordedPlaybooks.map((row) => row.id),
      externalSideEffects: false,
      customerMessageSent: false,
      subscriptionChanged: false
    };
    report.decisionReceipt = {
      ...(report.decisionReceipt || buildSafeToRenewDecisionReceipt(report)),
      snapshotId: snapshot.id,
      durable: true,
      proof: {
        ...((report.decisionReceipt || {}).proof || {}),
        renewalSavePlaybooks: recordedPlaybooks.length,
        expectedRetainedRevenueCents: report.expectedRetainedRevenueCents || 0
      }
    };
  }
  return report;
}

export function buildSafeToRenewDecisionReceipt(report = {}) {
  const blockers = report.blockers || [];
  return {
    generatedAt: report.generatedAt || new Date().toISOString(),
    command: report.command || 'npm run safe-to-renew',
    decision: report.ok ? 'safe_to_renew' : 'hold',
    ok: !!report.ok,
    durable: false,
    snapshotId: report.snapshot?.id || null,
    proof: {
      activeSubscriptions: report.activeSubscriptionCount || 0,
      hostingTasks: report.hostingTaskCount || 0,
      dueHostingTasks: report.dueHostingTaskCount || 0,
      dryRunProofs: report.dryRunProofCount || 0,
      blockedHostingTasks: report.blockedHostingTaskCount || 0,
      missingHostingTasks: report.missingHostingTaskCount || 0,
      atRiskSubscriptions: report.atRiskSubscriptionCount || 0,
      renewalSavePlaybooks: report.renewalSavePlaybookCount || 0,
      expectedRetainedRevenueCents: report.expectedRetainedRevenueCents || 0,
      liveSideEffects: report.liveSideEffects === true,
      renewalMessageSentByCheck: report.renewalMessageSentByCheck === true
    },
    gates: {
      hostingTaskCoverage: Number(report.missingHostingTaskCount || 0) === 0,
      dueTasksHaveProof: !(report.blockers || []).some((blocker) => blocker.includes('due without recent dry-run proof')),
      pastDueOperatorReview: !(report.blockers || []).some((blocker) => blocker.includes('past_due')),
      noBlockedHostingTasks: Number(report.blockedHostingTaskCount || 0) === 0,
      renewalPlaybooksPrepared: Number(report.atRiskSubscriptionCount || 0) === Number(report.renewalSavePlaybookCount || 0),
      noLiveSideEffects: report.liveSideEffects !== true && report.renewalMessageSentByCheck !== true
    },
    status: report.status || null,
    blockerCount: blockers.length,
    topBlockers: blockers.slice(0, 8),
    nextActions: (report.nextActions || []).slice(0, 8)
  };
}

export function compactSafeToRenewReceiptHistory(history) {
  if (!history) return null;
  const recent = (history.recent || []).map(compactSafeToRenewReceiptRow).filter(Boolean);
  return redact({
    total: history.total || 0,
    okCount: history.okCount || 0,
    blockedCount: history.blockedCount || 0,
    lastGeneratedAt: history.lastGeneratedAt || null,
    latest: history.latest ? compactSafeToRenewReceiptRow(history.latest) : recent[0] || null,
    recent
  });
}

function compactSafeToRenewReceiptRow(snapshot) {
  if (!snapshot) return null;
  const report = snapshot.report || {};
  const receipt = report.decisionReceipt || buildSafeToRenewDecisionReceipt({
    ...report,
    ok: snapshot.ok,
    generatedAt: report.generatedAt || (snapshot.generatedAt ? new Date(snapshot.generatedAt).toISOString() : null),
    blockers: report.blockers || Array.from({ length: snapshot.blockerCount || 0 }, (_, i) => `blocked_${i}`)
  });
  return {
    id: snapshot.id,
    ok: !!snapshot.ok,
    status: snapshot.status || report.status || receipt.status || null,
    command: snapshot.command || receipt.command || null,
    generatedAt: snapshot.generatedAt || null,
    createdAt: snapshot.createdAt || null,
    decision: receipt.decision || (snapshot.ok ? 'safe_to_renew' : 'hold'),
    snapshotId: receipt.snapshotId || snapshot.id,
    durable: true,
    activeSubscriptionCount: snapshot.activeSubscriptionCount ?? receipt.proof?.activeSubscriptions ?? 0,
    hostingTaskCount: snapshot.hostingTaskCount ?? receipt.proof?.hostingTasks ?? 0,
    dryRunProofCount: snapshot.dryRunProofCount ?? receipt.proof?.dryRunProofs ?? 0,
    atRiskSubscriptionCount: report.atRiskSubscriptionCount ?? receipt.proof?.atRiskSubscriptions ?? 0,
    renewalSavePlaybookCount: report.renewalSavePlaybookCount ?? receipt.proof?.renewalSavePlaybooks ?? 0,
    expectedRetainedRevenueCents: report.expectedRetainedRevenueCents ?? receipt.proof?.expectedRetainedRevenueCents ?? 0,
    blockerCount: snapshot.blockerCount ?? receipt.blockerCount ?? 0,
    topBlockers: (receipt.topBlockers || []).slice(0, 5),
    nextActions: (receipt.nextActions || []).slice(0, 5)
  };
}

export function enqueueSafeToRenewSelfCheck({
  now = Date.now(),
  intervalMs = env.ops.safeToRenewCheckIntervalMs,
  reason = 'scheduler',
  runAt = now
} = {}) {
  const bucketMs = Math.max(60_000, Number(intervalMs) || DAY_MS);
  const bucket = Math.floor(now / bucketMs);
  return enqueueJob({
    type: SAFE_TO_RENEW_JOB_TYPE,
    payload: {
      reason,
      source: 'durable_job',
      intervalMs: bucketMs,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: `${SAFE_TO_RENEW_JOB_TYPE}:${bucket}`,
    runAt,
    maxAttempts: 2
  });
}

export function startSafeToRenewSelfCheckScheduler({
  enabled = env.ops.safeToRenewCheckEnabled,
  intervalMs = env.ops.safeToRenewCheckIntervalMs
} = {}) {
  if (!enabled) return { running: false, disabled: true };
  const safeInterval = Math.max(60_000, Number(intervalMs) || DAY_MS);
  if (safeToRenewTimer) return { running: true, intervalMs: safeInterval, alreadyRunning: true };

  const enqueue = (reason = 'scheduler') => {
    const result = enqueueSafeToRenewSelfCheck({ intervalMs: safeInterval, reason });
    log.info('safe_to_renew.self_check_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };

  const first = enqueue('boot');
  safeToRenewTimer = setInterval(() => {
    try {
      enqueue('scheduler');
    } catch (err) {
      log.warn('safe_to_renew.scheduler_failed', { error: err?.message || String(err) });
    }
  }, safeInterval);
  safeToRenewTimer.unref?.();

  return {
    running: true,
    intervalMs: safeInterval,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopSafeToRenewSelfCheckScheduler() {
  if (safeToRenewTimer) clearInterval(safeToRenewTimer);
  safeToRenewTimer = null;
  return { running: false };
}

export function printSafeToRenewReport(report) {
  console.log('\n=== SAFE TO RENEW TODAY ===');
  console.log(`safe: ${report.ok ? 'yes' : 'no'}`);
  console.log(`status: ${report.status}`);
  console.log(`active subscriptions: ${report.activeSubscriptionCount || 0}`);
  console.log(`active MRR: $${Number(report.activeMrrUsd || 0).toFixed(2)}`);
  console.log(`hosting tasks: ${report.hostingTaskCount || 0}`);
  console.log(`dry-run renewal proofs: ${report.dryRunProofCount || 0}`);
  console.log(`at-risk subscriptions: ${report.atRiskSubscriptionCount || 0}`);
  console.log(`renewal save playbooks: ${report.renewalSavePlaybookCount || 0}`);
  console.log(`expected retained revenue: $${Number(report.expectedRetainedRevenueUsd || 0).toFixed(2)}`);
  if (report.snapshot?.id) console.log(`self-check snapshot: ${report.snapshot.id}`);
  if (report.renewalSavePlaybookReceipts?.count) {
    console.log(`playbook receipts: ${report.renewalSavePlaybookReceipts.count}`);
  }
  if (report.decisionReceipt) {
    const receipt = report.decisionReceipt;
    console.log(`decision receipt: ${receipt.decision || (report.ok ? 'safe_to_renew' : 'hold')}; blockers ${receipt.blockerCount || 0}`);
  }
  if (report.blockers?.length) {
    console.log('\nRenewal blockers:');
    for (const blocker of report.blockers.slice(0, 30)) console.log(`- ${blocker}`);
  }
  if (report.nextActions?.length) {
    console.log('\nNext actions:');
    for (const action of report.nextActions.slice(0, 16)) console.log(`- ${action}`);
  }
}

function listActiveSubscriptions({ limit = 500 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 500, 2_000));
  return db.prepare(`
    SELECT s.id, s.lead_id, s.status, s.plan, s.amount_cents, s.currency, s.started_at, s.canceled_at,
           s.last_event_at, s.created_at, s.updated_at,
           l.business_name, l.city, l.niche, l.status AS lead_status
    FROM subscriptions s
    LEFT JOIN leads l ON l.id = s.lead_id
    WHERE s.status IN (${ACTIVE_RENEWAL_STATUSES.map(() => '?').join(',')})
    ORDER BY s.updated_at DESC, s.created_at DESC
    LIMIT ?
  `).all(...ACTIVE_RENEWAL_STATUSES, n);
}

function hostingTasksByLead(leadIds, { limit = 1_000 } = {}) {
  const ids = unique(leadIds.filter(Boolean));
  const out = new Map();
  if (!ids.length) return out;
  const n = Math.max(1, Math.min(Number(limit) || 1_000, 5_000));
  const rows = db.prepare(`
    SELECT id, lead_id, account_plan_id, kind, title, summary, due_at, priority, channel, status,
           evidence_ids_json, owner, idempotency_key, preview_json, risk_json, policy_json,
           completion_notes, created_at, updated_at, last_previewed_at, sent_at, completed_at,
           paused_until, provider_id, thread_id
    FROM account_tasks
    WHERE kind = ?
      AND lead_id IN (${ids.map(() => '?').join(',')})
    ORDER BY updated_at DESC, due_at ASC
    LIMIT ?
  `).all(HOSTING_TASK_KIND, ...ids, n).map(hydrateTask);
  for (const row of rows) {
    if (!out.has(row.lead_id)) out.set(row.lead_id, []);
    out.get(row.lead_id).push(row);
  }
  return out;
}

function subscriptionRenewalStatus({
  subscription,
  tasks = [],
  now,
  taskFreshMs,
  previewFreshMs
}) {
  const sortedTasks = [...tasks].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
  const latestTask = sortedTasks[0] || null;
  const dueTasks = sortedTasks.filter((task) => task.due_at <= now && ['pending', 'approved', 'paused'].includes(task.status));
  const blockedTasks = sortedTasks.filter((task) => task.status === 'blocked' || task.policy?.blocked === true);
  const dryRunProof = sortedTasks.some((task) => hasRecentPreview(task, now, previewFreshMs) || hasRecentResolution(task, now, taskFreshMs));
  const blockers = [];
  if (subscription.status === 'past_due') {
    blockers.push(`subscription ${subscription.id} is past_due and needs operator renewal review`);
  }
  if (!latestTask) {
    blockers.push(`hosting_subscription_status task missing for subscription ${subscription.id}`);
  } else {
    if (blockedTasks.length) blockers.push(`hosting_subscription_status blocked for subscription ${subscription.id}`);
    if (dueTasks.length && !dryRunProof) {
      blockers.push(`hosting_subscription_status due without recent dry-run proof for subscription ${subscription.id}`);
    }
    if (isStaleTask(latestTask, now, taskFreshMs) && !dryRunProof) {
      blockers.push(`hosting_subscription_status stale for subscription ${subscription.id}`);
    }
  }
  return {
    leadId: subscription.lead_id,
    businessName: subscription.business_name || null,
    city: subscription.city || null,
    niche: subscription.niche || null,
    leadStatus: subscription.lead_status || null,
    subscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    amountCents: subscription.amount_cents || 0,
    plan: subscription.plan || null,
    taskStatus: latestTask ? latestTask.status : 'missing',
    taskId: latestTask?.id || null,
    taskDueAt: latestTask?.due_at || null,
    taskLastPreviewedAt: latestTask?.last_previewed_at || null,
    taskSentAt: latestTask?.sent_at || null,
    taskUpdatedAt: latestTask?.updated_at || null,
    dueTaskCount: dueTasks.length,
    blockedTaskCount: blockedTasks.length,
    dryRunProof,
    blockers
  };
}

export function buildRenewalSavePlaybook({ customer, now = Date.now() } = {}) {
  const blockers = customer?.blockers || [];
  const churnRisk = renewalChurnRisk(customer);
  const priority = churnRisk >= 0.7 ? 'high' : churnRisk >= 0.4 ? 'medium' : 'low';
  const motion = renewalSaveMotion(customer);
  const expectedRetainedRevenueCents = Math.max(0, Math.round(Number(customer?.amountCents || 0) * 12));
  const proofRequired = unique([
    'operator_renewal_review',
    customer?.taskStatus === 'missing' ? 'hosting_subscription_status_task' : null,
    customer?.dryRunProof ? null : 'fresh_dry_run_aftercare_preview',
    customer?.subscriptionStatus === 'past_due' ? 'billing_status_review' : null,
    customer?.blockedTaskCount ? 'blocked_aftercare_task_resolution' : null,
    'consent_and_opt_out_check',
    'safe_to_email_or_portal_message_gate'
  ]);
  const nextSteps = unique([
    customer?.taskStatus === 'missing' ? 'create hosting/subscription account-manager task' : null,
    customer?.dryRunProof ? null : 'generate a dry-run renewal health preview',
    customer?.subscriptionStatus === 'past_due' ? 'review Stripe status and customer-facing billing language before any recovery contact' : null,
    customer?.blockedTaskCount ? 'resolve blocked hosting/subscription status task with operator evidence' : null,
    'prepare retention/save copy for operator review without sending it',
    'record proof before any subscription, discount, payment-link, or customer-message mutation'
  ]);
  const playbook = {
    generatedAt: new Date(now).toISOString(),
    source: 'safe_to_renew_churn_recovery_planner',
    leadId: customer?.leadId || null,
    businessName: customer?.businessName || null,
    city: customer?.city || null,
    niche: customer?.niche || null,
    subscriptionId: customer?.subscriptionId || null,
    subscriptionStatus: customer?.subscriptionStatus || null,
    taskId: customer?.taskId || null,
    taskStatus: customer?.taskStatus || null,
    recommendedMotion: motion,
    churnRisk,
    priority,
    expectedRetainedRevenueCents,
    blockers,
    proofRequired,
    nextSteps,
    draftOfferGuardrails: {
      discountRequiresApproval: true,
      priceChangeRequiresApproval: true,
      paymentLinkRequiresApproval: true,
      subscriptionMutationRequiresApproval: true,
      customerMessageRequiresApproval: true
    }
  };
  const safety = {
    kind: 'safe_to_renew_churn_recovery_playbook_safety',
    externalSideEffects: false,
    customerMessageSent: false,
    emailSent: false,
    smsSent: false,
    portalMessagePublished: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    subscriptionChanged: false,
    discountApplied: false,
    priceChangedLive: false,
    bookingScheduled: false,
    reviewRequested: false,
    financeRollupMutated: false,
    playbookOnly: true,
    operatorApprovalRequired: true,
    consentReviewRequired: true
  };
  return {
    id: `renewplay_${safeId(customer?.subscriptionId)}_${safeId(String(now))}`,
    leadId: customer?.leadId || null,
    subscriptionId: customer?.subscriptionId || null,
    status: 'planned',
    priority,
    churnRisk,
    expectedRetainedRevenueCents,
    recommendedMotion: motion,
    playbook,
    safety,
    evidence: unique([
      customer?.taskId ? `account_task:${customer.taskId}` : null,
      customer?.subscriptionId ? `subscription:${customer.subscriptionId}` : null,
      ...(blockers || [])
    ])
  };
}

function shouldCreateRenewalSavePlaybook(customer) {
  if (!customer) return false;
  if (customer.subscriptionStatus === 'past_due') return true;
  if ((customer.blockers || []).length) return true;
  if (customer.taskStatus === 'missing') return true;
  if (customer.dueTaskCount > 0 && !customer.dryRunProof) return true;
  if (customer.blockedTaskCount > 0) return true;
  return false;
}

function renewalChurnRisk(customer = {}) {
  let risk = 0.22;
  if (customer.subscriptionStatus === 'past_due') risk += 0.35;
  if (customer.taskStatus === 'missing') risk += 0.22;
  if (customer.dueTaskCount > 0 && !customer.dryRunProof) risk += 0.16;
  if (customer.blockedTaskCount > 0) risk += 0.18;
  if ((customer.blockers || []).some((blocker) => blocker.includes('stale'))) risk += 0.1;
  if (customer.dryRunProof) risk -= 0.12;
  return Math.max(0.05, Math.min(0.95, Number(risk.toFixed(2))));
}

function renewalSaveMotion(customer = {}) {
  if (customer.subscriptionStatus === 'past_due') return 'operator_billing_recovery_review';
  if (customer.blockedTaskCount > 0) return 'blocked_aftercare_resolution';
  if (customer.taskStatus === 'missing') return 'create_aftercare_coverage_then_dry_run';
  if (customer.dueTaskCount > 0 && !customer.dryRunProof) return 'dry_run_renewal_health_preview';
  return 'operator_retention_review';
}

function renewalNextActions(customers = []) {
  const missing = customers.filter((row) => row.taskStatus === 'missing').length;
  const due = customers.filter((row) => row.blockers.some((blocker) => blocker.includes('due without recent dry-run proof'))).length;
  const blocked = customers.filter((row) => row.blockedTaskCount > 0).length;
  const pastDue = customers.filter((row) => row.subscriptionStatus === 'past_due').length;
  return unique([
    missing ? `generate account-manager plans for ${missing} active subscription(s) missing hosting/subscription status tasks` : null,
    due ? `run the account-manager scheduler in dry-run mode for ${due} due hosting/subscription status task(s)` : null,
    blocked ? `review ${blocked} blocked hosting/subscription status task(s) before claiming renewal safety` : null,
    pastDue ? `route ${pastDue} past-due hosting/edit-care subscription(s) to operator renewal review` : null
  ]);
}

function hasRecentPreview(task, now, previewFreshMs) {
  const ts = Number(task.last_previewed_at);
  return Number.isFinite(ts) && ts > 0 && now - ts <= previewFreshMs;
}

function hasRecentResolution(task, now, taskFreshMs) {
  const ts = Number(task.sent_at || task.completed_at);
  return Number.isFinite(ts) && ts > 0 && now - ts <= taskFreshMs;
}

function isStaleTask(task, now, taskFreshMs) {
  const ts = Number(task.updated_at || task.created_at || 0);
  return Number.isFinite(ts) && ts > 0 && now - ts > taskFreshMs;
}

function statusCounts() {
  return Object.fromEntries(subscriptions.countByStatus().map((row) => [row.status, row.n]));
}

function hydrateTask(row) {
  return {
    ...row,
    evidenceIds: safeJson(row.evidence_ids_json) || [],
    preview: safeJson(row.preview_json),
    risk: safeJson(row.risk_json),
    policy: safeJson(row.policy_json)
  };
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function safeId(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}
