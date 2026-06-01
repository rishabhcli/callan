import express from 'express';
import cors from 'cors';
import { createHash } from 'node:crypto';
import { env } from './env.js';
import { log } from './logger.js';
import { attachStream, emit } from './sse.js';
import { leads, runs, calls, payments, builds, contactEvents, webhookEvents, doNotCall, events as eventStore, auditTrail, reasoningTraces, scheduledCalls as scheduledCallsDb, subscriptions, db, leadCosts, durableJobs, accountManagerPlans, accountTasks, handoffCases, portfolioOperatingModel, portfolioOperatorInbox } from './db.js';
import { marginForLead } from './costs.js';
import { DiscoverRequest, CallRequest, FollowupRequest, BuildRequest } from './types.js';
import {
  listKinds,
  memoryBusinesses,
  memoryForLead,
  memoryObservability,
  retryFailedWrites,
  search as searchMemory
} from './memory.js';
import { handleAgentPhoneWebhook, verifyAgentPhone } from './webhooks/agentphone.js';
import { agentMailWebhookEventId, isInboundAgentMailWebhook, normalizeAgentMailWebhook, verifyAgentMail } from './webhooks/agentmail.js';
import { processStripeWebhookEvent, verifyStripe } from './webhooks/stripe.js';
import { acceptHostingSubscription, handleStripeSubscriptionEvent } from './hostingSubscription.js';
import { liveReadiness } from './readiness.js';
import { fulfillmentReadiness } from './fulfillment/targets.js';
import { fulfillmentQueueSnapshot } from './fulfillment/queue.js';
import { recoverTriggeredPaymentBuilds, revenueHealthSummary, revenueStatusForLead } from './paymentFlow.js';
import { listExperimentKeys, rollup as experimentRollup } from './experiments.js';
import { callabilityForLead, normalizePhone, recordingDisclosure } from './compliance.js';
import {
  approveLeadForLiveCall,
  blockLeadForOutreach,
  canRouteCallLead,
  explainLeadCallability as explainOutreachCallability,
  forceRetryLeadOutreach,
  handleOutreachLeadJob,
  optOutLeadFromOutreach,
  OUTREACH_LEAD_JOB_TYPE,
  outreachRouteSmoke,
  outreachStatus,
  pauseOutreachLoop,
  resumeOutreachLoop,
  startOutreachLoop,
  stopOutreachLoop
} from './outreach.js';
import { reputationStatus, startReputationLoop } from './reputation.js';
import { topPriorityLeads, nicheWinRateMap } from './leadPriority.js';
import { LEAD_PRIORITY_SCORE_JOB_TYPE, handleLeadPriorityScoreJob } from './leadPriorityQueue.js';
import { runScraper } from './workers/scraper.js';
import { runCaller } from './workers/caller.js';
import { runAnalyst } from './workers/analyst.js';
import { handleAgentMailInbound, runMailer } from './workers/mailer.js';
import { runBuilder, runPreviewBuilder } from './workers/builder.js';
import { BUILDER_BUILD_JOB_TYPE, enqueueBuilderBuild } from './builderQueue.js';
import { HOSTING_UPSELL_JOB_TYPE, handleHostingUpsellJob } from './hostingUpsellQueue.js';
import { runScheduledCaller } from './workers/scheduledCaller.js';
import {
  registerScheduledCallDispatcher,
  SCHEDULED_CALL_JOB_TYPE,
  handleScheduledCallPlacementJob,
  startScheduledCallLoop,
  cancelScheduledCall,
  fireScheduledCallNow
} from './scheduledCalls.js';
import { ensureOperatorTransferConfigured } from './operatorTransfer.js';
import { handoffDeskSummary, performHandoffAction } from './handoff.js';
import { observeGithubCheckRuns, runBranchProtectionReadbackAdapterContract, runGithubPullRequestObservationAdapterContract, runMergeExecutionAdapterContract, runMergeQueueCredentialHandoffPacket, runMergeQueueFakeLiveReadReplayQuarantinePacket, runMergeQueueFinalBlockerLedgerPacket, runMergeQueueLiveHttpExecutionPreflightHandoffPacket, runMergeQueueLiveHttpOperatorReleaseAckPacket, runMergeQueueLiveReadAdapterContract, runMergeQueueLiveReadPreflightEnvelope, runMergeQueueLiveReadReadinessPacket, runMergeQueueLiveReadReconciliation, runMergeQueueLiveReadResponseIngestionPacket, runMergeQueueLiveReadVerificationPromotionPacket, runMergeQueueMemoryOnlyRuntimeTokenReleasePreflightPacket, runMergeQueuePostAttestationReleaseEscrowPacket, runMergeQueuePostLedgerOperatorReleaseAttestationPacket, runMergeQueueReadbackAdapterContract, runMergeQueueReleaseDenialCloseoutPacket, runMergeQueueRuntimeSecretProviderSmokeEvidenceReviewPacket, runMergeQueueRuntimeSecretProviderSmokeExecutionGatePacket, runMergeQueueRuntimeSecretProviderSmokeReadinessPacket, runMergeQueueRuntimeTokenReleaseDenialPacket, runMergeQueueRuntimeTokenReleaseGatePacket, runMergeQueueSuccessfulSmokeEvidenceIngestionPacket, runMergeQueueTokenQuarantinePacket, runOperatorHandoffEvalLiveAdapterContract, runSecretRedactionProof, runTokenScopeObservationAdapterContract } from './evalAdapters.js';
import {
  createBrowserUseResearchJob,
  getBrowserResearchStatus,
  listBrowserUseResearchSessions,
  runBrowserUseResearchJob,
  stopBrowserUseResearchJob
} from './research/browserUseSwarm.js';
import { BrowserUseLovableAdapter, normalizeBrowserUseSessionSnapshot } from './providers/browserUse.js';
import { growthStatus, readGrowthState, recordGrowthCustomerResponse } from './growth/index.js';
import { GROWTH_FOLLOWUP_JOB_TYPE, GROWTH_PLAN_JOB_TYPE, enqueueGrowthFollowupJob, enqueueGrowthPlanJob, handleGrowthFollowupJob, handleGrowthPlanJob } from './growthQueue.js';
import {
  ACCOUNT_MANAGER_RUN_JOB_TYPE,
  ACCOUNT_MANAGER_TASK_JOB_TYPE,
  accountManagerStatus,
  approveAccountTask,
  buildAftercarePreview,
  completeAccountTask,
  enqueueAccountManagerRun,
  enqueueAccountManagerTask,
  evaluateSendPolicy,
  generateAccountManagerPlanForLead,
  handleAccountManagerRunJob,
  handleAccountManagerTaskJob,
  pauseAccountTask,
  readAccountManagerState,
  reassignAccountTask,
  startAccountManagerLoop
} from './accountManager/index.js';
import { commerceStatus, planCommerceForLead, readCommerceState, submitPortalCommerceIntake } from './commerce/index.js';
import { mossStatusForLead } from './moss/hotIndex.js';
import { buildQaReadModel, renderMockGeneratedSite } from './fulfillment/hooks/index.js';
import { recordReferralClick, referralRollup, totalReferralClicks } from './referrals.js';
import {
  acceptQuote as portalAcceptQuote,
  acceptRenewalCustomerConfirmation as portalAcceptRenewalCustomerConfirmation,
  acknowledgeRenewalCustomerConfirmation as portalAcknowledgeRenewalCustomerConfirmation,
  approveLaunch as portalApproveLaunch,
  approveScope as portalApproveScope,
  bookCallback as portalBookCallback,
  optOut as portalOptOut,
  portalState,
	  recordAssetUrl as portalRecordAssetUrl,
	  requestRenewalChange as portalRequestRenewalChange,
	  requestRevision as portalRequestRevision,
	  resolvePortalAccess,
	  resolveRenewalChangeRequest as opsResolveRenewalChangeRequest,
	  createRenewalBillingChangePreflight as opsCreateRenewalBillingChangePreflight,
	  createRenewalCustomerConfirmationCloseoutPacket as opsCreateRenewalCustomerConfirmationCloseoutPacket,
	  createRenewalCustomerConfirmationFollowupWorkItem as opsCreateRenewalCustomerConfirmationFollowupWorkItem,
	  executeRenewalBillingChangePreflight as opsExecuteRenewalBillingChangePreflight,
	  createRenewalCustomerConfirmationReceipt as opsCreateRenewalCustomerConfirmationReceipt,
	  createRenewalCustomerMessagePreflight as opsCreateRenewalCustomerMessagePreflight,
	  executeRenewalCustomerMessagePreflight as opsExecuteRenewalCustomerMessagePreflight,
	  resolveRenewalCustomerConfirmationFollowupWorkItem as opsResolveRenewalCustomerConfirmationFollowupWorkItem,
	  reviewRenewalPlan as portalReviewRenewalPlan,
	  updateIntake as portalUpdateIntake
	} from './customerPortal.js';
import { customerTrustSummaryForLead, trustSummaryForLead } from './trust.js';
import { enqueueJob, jobQueueHealth, startDurableJobLoop } from './jobs.js';
import { EMAIL_CALLBACK_JOB_TYPE, handleEmailCallbackJob } from './emailCallback.js';
import { CALL_ANALYSIS_JOB_TYPE } from './analysisQueue.js';
import { MAIL_REPLY_JOB_TYPE, enqueueMailReplyJob } from './mailReplyQueue.js';
import { INBOUND_VOICE_FOLLOWUP_JOB_TYPE, handleInboundVoiceFollowupJob } from './inboundVoiceQueue.js';
import { INBOUND_MEMORY_HYDRATE_JOB_TYPE, handleInboundMemoryHydrationJob } from './inboundMemoryQueue.js';
import { OPERATOR_TRANSFER_JOB_TYPE, handleOperatorTransferJob } from './operatorTransferQueue.js';
import { runProductionEvals } from './evals.js';
import { OPS_BACKUP_JOB_TYPE, OPS_PROVIDER_POSTURE_JOB_TYPE, OPS_RECOVER_STUCK_JOB_TYPE, OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE, backupFreshness, backupSqliteDataDir, enqueueRetentionCommandLeaseMaintenance, exportOperationsData, latestBackupManifest, opsObservability, recoverStuckOperations, runOpsBackupJob, runOpsRecoveryJob, runProviderPostureJob, runRetentionCommandLeaseMaintenanceJob, resetMockData, startOpsBackupScheduler, startOpsRecoveryScheduler, startProviderPostureScheduler, startRetentionCommandLeaseMaintenanceScheduler } from './ops.js';
import { SAFE_TO_SELL_JOB_TYPE, buildProviderProofMatrix, buildSafeToSellDecisionReceipt, buildSafeToSellNextActions, compactSafeToSellReceiptHistory, enqueueSafeToSellSelfCheck, runSafeToSellSelfCheck, safeToSellSnapshotStatus, startSafeToSellSelfCheckScheduler } from './safeToSell.js';
import { SAFE_TO_RENEW_JOB_TYPE, buildSafeToRenewStatus, compactSafeToRenewReceiptHistory, enqueueSafeToRenewSelfCheck, runSafeToRenewSelfCheck, safeToRenewSnapshotStatus, startSafeToRenewSelfCheckScheduler } from './safeToRenew.js';
import { isOperatorProtectedRequest, requireAdmin } from './adminAuth.js';
import { aggregateLeadMarketOpportunities, planLaunchFromMarketOpportunity, recordMarketRecommendationOutcome } from './portfolio.js';

const app = express();
app.use(cors());

// Raw body for webhook signature checks
const rawBodySaver = (req, _res, buf) => { req.rawBody = buf; };
app.use('/api/webhooks', express.json({ verify: rawBodySaver }));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (!isOperatorProtectedRequest(req)) return next();
  return requireAdmin(req, res, next);
});

const fire = (worker, args, _fn, options = {}) => {
  const result = enqueueJob({
    type: options.type || worker,
    payload: args || {},
    idempotencyKey: options.idempotencyKey || null,
    runAt: options.runAt || Date.now(),
    maxAttempts: options.maxAttempts || 5
  });
  return result.row;
};

/**
 * Look up the customer-email-thread context for a paid lead so the builder's
 * onLiveUrl callback can send the "Watch your site come together" email in
 * the same AgentMail thread the invoice was in.
 *
 * Sources, in priority order:
 *   - `payments.customer_email` (set when Stripe webhook records the paid event)
 *   - the latest inbound AgentMail contact_event for the lead (their reply)
 *   - the latest outbound AgentMail contact_event provides messageId + threadId
 *
 * Returns null if we can't reconstruct enough to send.
 */
function findEmailContextForLead(leadId) {
  if (!leadId) return null;
  try {
    const lead = leads.get(leadId);
    if (!lead) return null;
    const outbound = db.prepare(`
      SELECT provider_id, thread_id, subject
      FROM contact_events
      WHERE lead_id = ? AND channel = 'agentmail' AND direction = 'outbound'
        AND provider_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(leadId);
    const payment = db.prepare(`
      SELECT customer_email
      FROM payments
      WHERE lead_id = ? AND customer_email IS NOT NULL AND customer_email != ''
      ORDER BY paid_at DESC, created_at DESC
      LIMIT 1
    `).get(leadId);
    const customerEmail = payment?.customer_email || null;
    if (!outbound || !customerEmail) return null;
    return {
      messageId: outbound.provider_id,
      threadId: outbound.thread_id || lead.agentmail_thread_id,
      customerEmail,
      businessName: lead.business_name
    };
  } catch (err) {
    log.warn('builder.email_context_lookup_failed', { leadId, error: err?.message || String(err) });
    return null;
  }
}

/**
 * Wraps runBuilder with the onLiveUrl callback that emails the customer the
 * Browser Use live URL the moment the build session starts. Lazy-imports
 * sendPreviewBuildEmail to avoid a circular dep at module load.
 */
async function runBuilderWithLiveEmail(a = {}) {
  const { sendPreviewBuildEmail } = await import('./workers/mailer.js');
  const onLiveUrl = async (liveUrl, ctx) => {
    const ec = findEmailContextForLead(a.leadId);
    if (!ec) {
      log.warn('builder.live_url.skipped', { leadId: a.leadId, reason: 'no_email_context' });
      return;
    }
    try {
      await sendPreviewBuildEmail({
        leadId: a.leadId,
        liveUrl,
        inReplyToMessageId: ec.messageId,
        threadId: ec.threadId,
        toEmail: ec.customerEmail,
        businessName: ec.businessName,
        buildId: ctx?.buildId,
        sessionId: ctx?.sessionId,
        mock: !!ctx?.mock
      });
    } catch (err) {
      log.warn('builder.live_url.email_failed', { leadId: a.leadId, error: err?.message || String(err) });
    }
  };
  return runBuilder({ ...a, onLiveUrl });
}

async function runPreviewBuilderWithReplyEmail(a = {}, job = null) {
  const previewEmail = a.previewEmail || {};
  const onLiveUrl = async (liveUrl, ctx) => {
    if (!previewEmail.messageId || !previewEmail.toEmail) {
      log.warn('builder.preview_live_url.skipped', { leadId: a.leadId, reason: 'missing_preview_email_context' });
      return;
    }
    const { sendPreviewBuildEmail } = await import('./workers/mailer.js');
    await sendPreviewBuildEmail({
      leadId: a.leadId,
      liveUrl,
      inReplyToMessageId: previewEmail.messageId,
      threadId: previewEmail.threadId || null,
      toEmail: previewEmail.toEmail,
      businessName: previewEmail.businessName || leads.get(a.leadId)?.business_name || null,
      buildId: ctx?.buildId || null,
      sessionId: ctx?.sessionId || null,
      mock: !!ctx?.mock
    });
  };
  try {
    return await runPreviewBuilder({ leadId: a.leadId, target: a.target, onLiveUrl });
  } catch (err) {
    const finalAttempt = Number(job?.attempts || 0) >= Number(job?.max_attempts || 1);
    log.warn('builder.preview_job_failed', {
      leadId: a.leadId,
      jobId: job?.id || null,
      finalAttempt,
      error: err?.message || String(err)
    });
    try {
      leads.update(a.leadId, {
        preview_build_triggered_at: finalAttempt ? null : leads.get(a.leadId)?.preview_build_triggered_at || null,
        next_action: finalAttempt ? 'await_payment' : 'preview_build_retry'
      });
    } catch (rollbackErr) {
      log.warn('builder.preview_job_state_update_failed', { leadId: a.leadId, error: rollbackErr?.message || String(rollbackErr) });
    }
    throw err;
  }
}

async function handleBuilderBuildJob(payload = {}, job = null) {
  if (payload.previewBuild) return runPreviewBuilderWithReplyEmail(payload, job);
  return runBuilderWithLiveEmail(payload);
}

const startBuilder = (args = {}) => enqueueBuilderBuild(args).row;

const durableJobHandlers = {
  'research.discover': runScraper,
  'research.browser_use': runBrowserUseResearchJob,
  'call.followup': runCaller,
  [SCHEDULED_CALL_JOB_TYPE]: handleScheduledCallPlacementJob,
  [CALL_ANALYSIS_JOB_TYPE]: runAnalyst,
  [OUTREACH_LEAD_JOB_TYPE]: handleOutreachLeadJob,
  [INBOUND_MEMORY_HYDRATE_JOB_TYPE]: handleInboundMemoryHydrationJob,
  [INBOUND_VOICE_FOLLOWUP_JOB_TYPE]: handleInboundVoiceFollowupJob,
  [OPERATOR_TRANSFER_JOB_TYPE]: handleOperatorTransferJob,
  [EMAIL_CALLBACK_JOB_TYPE]: handleEmailCallbackJob,
  [LEAD_PRIORITY_SCORE_JOB_TYPE]: handleLeadPriorityScoreJob,
  'mail.followup': runMailer,
  [MAIL_REPLY_JOB_TYPE]: (payload) => handleAgentMailInbound(payload),
  [BUILDER_BUILD_JOB_TYPE]: handleBuilderBuildJob,
  [HOSTING_UPSELL_JOB_TYPE]: handleHostingUpsellJob,
  [GROWTH_PLAN_JOB_TYPE]: handleGrowthPlanJob,
  [GROWTH_FOLLOWUP_JOB_TYPE]: handleGrowthFollowupJob,
  [ACCOUNT_MANAGER_RUN_JOB_TYPE]: handleAccountManagerRunJob,
  [ACCOUNT_MANAGER_TASK_JOB_TYPE]: handleAccountManagerTaskJob,
  [OPS_BACKUP_JOB_TYPE]: runOpsBackupJob,
  [OPS_PROVIDER_POSTURE_JOB_TYPE]: runProviderPostureJob,
  [OPS_RECOVER_STUCK_JOB_TYPE]: (payload) => runOpsRecoveryJob(payload, {
    recoverBuilds: (options) => recoverTriggeredPaymentBuilds({ startBuilder, ...options })
  }),
  [OPS_RETENTION_COMMAND_LEASE_MAINTENANCE_JOB_TYPE]: runRetentionCommandLeaseMaintenanceJob,
  [SAFE_TO_SELL_JOB_TYPE]: (payload) => runSafeToSellSelfCheck({ ...payload, source: 'durable_job' }),
  [SAFE_TO_RENEW_JOB_TYPE]: (payload) => runSafeToRenewSelfCheck({ ...payload, source: 'durable_job' }),
  scraper: runScraper,
  browser_research: runBrowserUseResearchJob,
  caller: runCaller,
  mailer: runMailer,
  builder: runBuilderWithLiveEmail
};

app.get('/api/ping', (_req, res) => {
  res.json({
    ok: true,
    service: 'callan',
    ts: Date.now()
  });
});

app.get('/api/health', (_req, res) => {
  const readiness = liveReadiness();
  const since24h = Date.now() - 24 * 3600 * 1000;
  let economics24h = null;
  try {
    economics24h = economicsByNiche({ since: since24h }).totals;
  } catch (err) {
    log.warn('health.economics_rollup_failed', { error: err?.message || String(err) });
    economics24h = { costUsd: 0, revenueUsd: 0, marginUsd: 0, marginPct: null, leads: 0 };
  }
  res.json({
    ok: true,
    ts: Date.now(),
    mode: env.runMode,
    live: env.live,
    readiness,
    providers: Object.fromEntries(Object.entries(readiness.providers).map(([k, v]) => [k, v.configured])),
    providerReadiness: readiness.providers,
    liveBlockers: readiness.blockers,
    productionBlockers: readiness.productionBlockers,
    canGoLive: readiness.canGoLive,
    promotionGates: readiness.promotionGates,
    admin: readiness.admin,
    sideEffects: readiness.sideEffects,
    compliance: readiness.compliance,
    reputation: readiness.reputation,
    nextActions: readiness.nextActions,
    smoke: readiness.smoke,
    quotas: readiness.outreach,
    quotaPolicies: readiness.quotas,
    webhooks: readiness.webhooks,
    browserUseStatus: browserUseStatusSummary(),
    reasoning: reasoningTraces.summary(),
    growth: growthStatus(),
    handoff: handoffCases.summary(),
    accountManager: accountManagerStatus(),
    commerce: commerceStatus(),
    jobs: jobQueueHealth(),
    revenue: {
      ...revenueHealthSummary(),
      mrrUsd: subscriptions.activeMrrCents() / 100,
      subscriptionsByStatus: subscriptions.countByStatus(),
      costsUsd24h: economics24h?.costUsd ?? 0,
      marginUsd24h: economics24h?.marginUsd ?? 0
    },
    referrals: {
      totalClicks: totalReferralClicks(),
      topReferrers: referralRollup({ limit: 10 })
    },
    lastErrors: Object.fromEntries(Object.entries(readiness.providers).map(([k, v]) => [k, v.lastError]).filter(([, v]) => v)),
    hackathon: env.hackathon
  });
});

app.get('/api/revenue/status', (_req, res) => {
  res.json(revenueHealthSummary());
});

app.get('/api/fulfillment/status', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    readiness: fulfillmentReadiness(),
    queue: fulfillmentQueueSnapshot()
  });
});

app.get('/api/status', (_req, res) => {
  const readiness = liveReadiness();
  res.json({
    ok: readiness.ready,
    mode: readiness.mode,
    ready: readiness.ready,
    canGoLive: readiness.canGoLive,
    blockers: readiness.blockers,
    productionBlockers: readiness.productionBlockers,
    promotionGates: readiness.promotionGates,
    admin: readiness.admin,
    sideEffects: readiness.sideEffects,
    outreach: readiness.outreach,
    reputation: readiness.reputation,
    nextActions: readiness.nextActions
  });
});

app.get('/api/readiness', (_req, res) => {
  res.json(liveReadiness());
});

app.get('/api/growth/status', (_req, res) => {
  res.json(growthStatus());
});

app.get('/api/portfolio/operating-model', (req, res) => {
  const workspaceId = cleanText(req.query?.workspaceId || req.query?.workspace_id) || 'ws_callan';
  res.json(portfolioOperatingModel.snapshot({
    workspaceId,
    limit: boundedLimit(req.query?.limit, 50, 200)
  }));
});

app.post('/api/portfolio/market-opportunities/aggregate', (req, res) => {
  res.json(aggregateLeadMarketOpportunities({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    minLeads: boundedLimit(req.body?.minLeads || req.body?.min_leads, 1, 25),
    limit: boundedLimit(req.body?.limit, 100, 1000)
  }));
});

app.post('/api/portfolio/market-opportunities/:id/plan-launch', (req, res) => {
  res.json(planLaunchFromMarketOpportunity({
    opportunityId: cleanText(req.params.id),
    brandName: cleanText(req.body?.brandName || req.body?.brand_name) || null,
    serviceName: cleanText(req.body?.serviceName || req.body?.service_name) || null,
    force: req.body?.force === true
  }));
});

app.post('/api/portfolio/market-opportunities/:id/record-outcome', (req, res) => {
  res.json(recordMarketRecommendationOutcome({
    opportunityId: cleanText(req.params.id),
    outcome: cleanText(req.body?.outcome) || 'false_positive',
    reasonKey: cleanText(req.body?.reasonKey || req.body?.reason_key) || null,
    summary: cleanText(req.body?.summary) || null,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
    observedAt: Number(req.body?.observedAt || req.body?.observed_at) || Date.now()
  }));
});

app.post('/api/portfolio/service-businesses/:id/evaluate-gates', (req, res) => {
  res.json(portfolioOperatingModel.evaluateServiceBusinessGates({
    serviceBusinessId: cleanText(req.params.id),
    persist: req.body?.persist !== false
  }));
});

app.post('/api/portfolio/service-businesses/:id/launch', (req, res) => {
  res.json(portfolioOperatingModel.launchServiceBusiness({
    serviceBusinessId: cleanText(req.params.id),
    surfaces: Array.isArray(req.body?.surfaces) ? req.body.surfaces : [],
    monitoringChecks: Array.isArray(req.body?.monitoringChecks || req.body?.monitoring_checks)
      ? (req.body.monitoringChecks || req.body.monitoring_checks)
      : [],
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : null
  }));
});

app.post('/api/portfolio/service-businesses/:id/acquisition-attempts', (req, res) => {
  res.json(portfolioOperatingModel.recordAcquisitionAttempt({
    serviceBusinessId: cleanText(req.params.id),
    launchSurfaceId: cleanText(req.body?.launchSurfaceId || req.body?.launch_surface_id) || null,
    customerId: cleanText(req.body?.customerId || req.body?.customer_id) || null,
    leadId: cleanText(req.body?.leadId || req.body?.lead_id) || null,
    channel: cleanText(req.body?.channel) || 'owned_acquisition_surface',
    status: cleanText(req.body?.status) || 'attempted',
    outcome: cleanText(req.body?.outcome) || 'pending',
    costCents: Number(req.body?.costCents ?? req.body?.cost_cents ?? 0),
    revenueCents: Number(req.body?.revenueCents ?? req.body?.revenue_cents ?? 0),
    attribution: req.body?.attribution && typeof req.body.attribution === 'object' ? req.body.attribution : null,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/service-businesses/:id/refresh-acquisition-strategy', (req, res) => {
  res.json(portfolioOperatingModel.refreshAcquisitionStrategy({
    serviceBusinessId: cleanText(req.params.id)
  }));
});

app.get('/api/portfolio/service-businesses/:id/operator-inbox', (req, res) => {
  const serviceBusinessId = cleanText(req.params.id);
  res.json({
    items: portfolioOperatorInbox.listItems({
      serviceBusinessId,
      status: cleanText(req.query?.status) || null,
      limit: boundedLimit(req.query?.limit, 100, 500)
    }),
    receipts: portfolioOperatorInbox.listActionReceipts({
      serviceBusinessId,
      limit: boundedLimit(req.query?.limit, 100, 500)
    }),
    assignments: portfolioOperatorInbox.listAssignments({
      serviceBusinessId,
      status: cleanText(req.query?.assignmentStatus || req.query?.assignment_status) || null,
      limit: boundedLimit(req.query?.limit, 100, 500)
    })
  });
});

app.post('/api/portfolio/operator-inbox/:id/receipt', (req, res) => {
  res.json(portfolioOperatorInbox.recordAction({
    inboxItemId: cleanText(req.params.id),
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    actionKind: cleanText(req.body?.actionKind || req.body?.action_kind || req.body?.action) || 'reviewed',
    decision: cleanText(req.body?.decision) || 'recorded',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'recorded',
    summary: cleanText(req.body?.summary) || 'Recorded local operator inbox action.',
    request: req.body?.request && typeof req.body.request === 'object' ? req.body.request : null,
    response: req.body?.response && typeof req.body.response === 'object' ? req.body.response : null,
    rollback: req.body?.rollback && typeof req.body.rollback === 'object' ? req.body.rollback : null,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/operator-inbox/:id/claim', (req, res) => {
  res.json(portfolioOperatorInbox.claimItem({
    inboxItemId: cleanText(req.params.id),
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    mode: cleanText(req.body?.mode) || 'local_review',
    leaseDurationMs: Number(req.body?.leaseDurationMs ?? req.body?.lease_duration_ms ?? 30 * 60 * 1000),
    leaseExpiresAt: Number(req.body?.leaseExpiresAt ?? req.body?.lease_expires_at ?? 0) || null,
    summary: cleanText(req.body?.summary) || 'Claimed local operator inbox item.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/operator-inbox/:id/release', (req, res) => {
  res.json(portfolioOperatorInbox.releaseItem({
    inboxItemId: cleanText(req.params.id),
    assignmentId: cleanText(req.body?.assignmentId || req.body?.assignment_id) || null,
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    mode: cleanText(req.body?.mode) || 'local_review',
    summary: cleanText(req.body?.summary) || 'Released local operator inbox claim.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/operator-inbox/expire-leases', (req, res) => {
  res.json(portfolioOperatorInbox.expireLeases({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || null,
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    assignmentId: cleanText(req.body?.assignmentId || req.body?.assignment_id) || null,
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    mode: cleanText(req.body?.mode) || 'local_review',
    summary: cleanText(req.body?.summary) || 'Expired local operator inbox claim leases.',
    limit: boundedLimit(req.body?.limit, 100, 500)
  }));
});

app.get('/api/portfolio/service-businesses/:id/operator-assignment-queues', (req, res) => {
  const serviceBusinessId = cleanText(req.params.id);
  if (String(req.query?.refresh || '').toLowerCase() === 'true') {
    portfolioOperatorInbox.materializeAssignmentQueues({ serviceBusinessId });
  }
  res.json({
    queues: portfolioOperatorInbox.listAssignmentQueues({
      serviceBusinessId,
      roleKey: cleanText(req.query?.roleKey || req.query?.role_key) || null,
      status: cleanText(req.query?.status) || null,
      limit: boundedLimit(req.query?.limit, 100, 500)
    }),
    bulkReviewReceipts: portfolioOperatorInbox.listBulkReviewReceipts({
      serviceBusinessId,
      roleKey: cleanText(req.query?.roleKey || req.query?.role_key) || null,
      limit: boundedLimit(req.query?.limit, 100, 500)
    }),
    handoffEvalCloseouts: portfolioOperatorInbox.listHandoffEvalCloseouts({
      serviceBusinessId,
      roleKey: cleanText(req.query?.roleKey || req.query?.role_key) || null,
      limit: boundedLimit(req.query?.limit, 100, 500)
    }),
    staffingAnalyticsReceipts: portfolioOperatorInbox.listStaffingAnalyticsReceipts({
      serviceBusinessId,
      roleKey: cleanText(req.query?.roleKey || req.query?.role_key) || null,
      limit: boundedLimit(req.query?.limit, 100, 500)
    })
  });
});

app.post('/api/portfolio/service-businesses/:id/operator-staffing-analytics', (req, res) => {
  res.json(portfolioOperatorInbox.recordStaffingAnalytics({
    serviceBusinessId: cleanText(req.params.id),
    roleKey: cleanText(req.body?.roleKey || req.body?.role_key) || null,
    analyticsKind: cleanText(req.body?.analyticsKind || req.body?.analytics_kind) || 'sla_staffing',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'recorded',
    summary: cleanText(req.body?.summary) || 'Recorded local operator SLA staffing analytics.'
  }));
});

app.post('/api/portfolio/operator-bulk-review-receipts/:id/eval-closeout', (req, res) => {
  res.json(portfolioOperatorInbox.closeoutBulkReviewEval({
    bulkReviewReceiptId: cleanText(req.params.id),
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    closeoutKind: cleanText(req.body?.closeoutKind || req.body?.closeout_kind) || 'handoff_eval_closeout',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'accepted_eval_artifact',
    summary: cleanText(req.body?.summary) || 'Closed local operator handoff review into an accepted eval artifact.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/operator-handoff-eval-closeouts/:id/publication-gate', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalPublicationGate({
    closeoutId: cleanText(req.params.id),
    publicationKind: cleanText(req.body?.publicationKind || req.body?.publication_kind) || 'operator_handoff_eval_publication_gate',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'blocked_publication',
    summary: cleanText(req.body?.summary) || 'Recorded local eval publication gate without writing executable tests.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-publication-receipts/:id/fixture-work-items', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalFixtureWorkItems({
    publicationReceiptId: cleanText(req.params.id),
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'queued_blocked',
    summary: cleanText(req.body?.summary) || 'Queued local eval fixture and harness work items without writing executable tests.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-publication-receipts/:id/fixture-runner-dry-run', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalFixtureRunnerDryRun({
    publicationReceiptId: cleanText(req.params.id),
    runKind: cleanText(req.body?.runKind || req.body?.run_kind) || 'eval_fixture_runner_dry_run',
    mode: cleanText(req.body?.mode) || 'dry_run',
    status: cleanText(req.body?.status) || 'blocked_runner_dry_run',
    summary: cleanText(req.body?.summary) || 'Recorded local eval fixture runner dry run without executing a harness.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-fixture-runner-receipts/:id/fixture-approval', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalFixtureApproval({
    runnerReceiptId: cleanText(req.params.id),
    approvalKind: cleanText(req.body?.approvalKind || req.body?.approval_kind) || 'operator_fixture_approval',
    decision: cleanText(req.body?.decision) || 'approved_for_non_live_fixture',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'approved_blocked_publication',
    summary: cleanText(req.body?.summary) || 'Recorded local eval fixture approval while keeping publication blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-fixture-approval-receipts/:id/golden-fixture-review', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalGoldenFixtureReview({
    approvalReceiptId: cleanText(req.params.id),
    reviewKind: cleanText(req.body?.reviewKind || req.body?.review_kind) || 'golden_fixture_review',
    decision: cleanText(req.body?.decision) || 'golden_fixture_accepted',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'reviewed_blocked_publication',
    summary: cleanText(req.body?.summary) || 'Recorded local golden fixture review while keeping executable publication blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-golden-fixture-review-receipts/:id/non-live-runner-binding', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalNonLiveRunnerBinding({
    goldenReviewReceiptId: cleanText(req.params.id),
    bindingKind: cleanText(req.body?.bindingKind || req.body?.binding_kind) || 'non_live_runner_binding',
    decision: cleanText(req.body?.decision) || 'runner_bound_non_live',
    mode: cleanText(req.body?.mode) || 'dry_run',
    status: cleanText(req.body?.status) || 'bound_blocked_publication',
    summary: cleanText(req.body?.summary) || 'Recorded non-live runner binding while keeping executable publication blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-non-live-runner-binding-receipts/:id/file-dry-run-manifest', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalFileDryRunManifest({
    runnerBindingReceiptId: cleanText(req.params.id),
    manifestKind: cleanText(req.body?.manifestKind || req.body?.manifest_kind) || 'executable_eval_file_dry_run_manifest',
    decision: cleanText(req.body?.decision) || 'file_manifest_reviewed_non_live',
    mode: cleanText(req.body?.mode) || 'dry_run',
    status: cleanText(req.body?.status) || 'manifest_ready_blocked_publication',
    summary: cleanText(req.body?.summary) || 'Recorded executable eval file dry-run manifest while keeping publication blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-file-dry-run-manifests/:id/ci-write-access-proof', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalCiWriteAccessProof({
    fileManifestId: cleanText(req.params.id),
    proofKind: cleanText(req.body?.proofKind || req.body?.proof_kind) || 'ci_write_access_proof',
    decision: cleanText(req.body?.decision) || 'ci_write_access_reviewed_local',
    mode: cleanText(req.body?.mode) || 'dry_run',
    status: cleanText(req.body?.status) || 'reviewed_blocked_ci_write_access',
    summary: cleanText(req.body?.summary) || 'Recorded CI write-access proof while keeping executable publication blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-ci-write-access-receipts/:id/live-adapter-readiness', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalLiveAdapterReadiness({
    ciWriteReceiptId: cleanText(req.params.id),
    readinessKind: cleanText(req.body?.readinessKind || req.body?.readiness_kind) || 'live_adapter_readiness_review',
    decision: cleanText(req.body?.decision) || 'live_adapter_blocked_local',
    mode: cleanText(req.body?.mode) || 'dry_run',
    status: cleanText(req.body?.status) || 'reviewed_blocked_live_adapter',
    summary: cleanText(req.body?.summary) || 'Recorded live-adapter readiness proof while keeping executable publication blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-live-adapter-readiness-receipts/:id/contract-test', (req, res) => {
  const contractResult = runOperatorHandoffEvalLiveAdapterContract();
  res.json(portfolioOperatorInbox.recordEvalLiveAdapterContractTest({
    liveAdapterReadinessReceiptId: cleanText(req.params.id),
    contractKind: cleanText(req.body?.contractKind || req.body?.contract_kind) || 'live_adapter_contract_test',
    decision: cleanText(req.body?.decision) || 'contract_test_passed_non_mutating',
    mode: cleanText(req.body?.mode) || 'dry_run',
    status: cleanText(req.body?.status) || 'contract_tested_blocked_ci_write_access',
    summary: cleanText(req.body?.summary) || 'Recorded non-mutating live-adapter contract test while keeping CI publication blocked.',
    contractResult,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-live-adapter-contract-test-receipts/:id/ci-workflow-publication', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalCiWorkflowPublication({
    contractTestReceiptId: cleanText(req.params.id),
    workflowKind: cleanText(req.body?.workflowKind || req.body?.workflow_kind) || 'ci_workflow_publication',
    decision: cleanText(req.body?.decision) || 'ci_workflow_published_local',
    mode: cleanText(req.body?.mode) || 'dry_run',
    status: cleanText(req.body?.status) || 'ci_workflow_published_local_blocked_external_run',
    summary: cleanText(req.body?.summary) || 'Recorded local CI workflow publication proof while external CI remains unobserved.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-ci-workflow-publication-receipts/:id/generated-eval-promotion', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalGeneratedArtifactPromotion({
    ciWorkflowPublicationReceiptId: cleanText(req.params.id),
    promotionKind: cleanText(req.body?.promotionKind || req.body?.promotion_kind) || 'generated_eval_artifact_promotion',
    decision: cleanText(req.body?.decision) || 'promoted_for_external_ci_review',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'promoted_blocked_external_ci_result',
    summary: cleanText(req.body?.summary) || 'Promoted generated eval artifact for external CI review while merge remains blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-generated-artifact-promotion-receipts/:id/pr-merge-proposal', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalPrMergeProposalGate({
    generatedArtifactPromotionReceiptId: cleanText(req.params.id),
    proposalKind: cleanText(req.body?.proposalKind || req.body?.proposal_kind) || 'pr_merge_proposal_gate',
    decision: cleanText(req.body?.decision) || 'proposal_prepared_merge_blocked',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'proposal_blocked_external_ci_and_operator_merge',
    summary: cleanText(req.body?.summary) || 'Prepared local PR merge proposal gate while external CI and merge remain blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-pr-merge-proposal-receipts/:id/pr-open-simulation', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalPrOpenSimulation({
    prMergeProposalReceiptId: cleanText(req.params.id),
    simulationKind: cleanText(req.body?.simulationKind || req.body?.simulation_kind) || 'pr_open_simulation',
    decision: cleanText(req.body?.decision) || 'pr_open_simulated_not_submitted',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'pr_open_simulated_blocked_submission',
    summary: cleanText(req.body?.summary) || 'Simulated local PR open payload without submitting a pull request.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-pr-open-simulation-receipts/:id/operator-merge-approval', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalOperatorMergeApprovalReview({
    prOpenSimulationReceiptId: cleanText(req.params.id),
    approvalKind: cleanText(req.body?.approvalKind || req.body?.approval_kind) || 'operator_merge_approval_review',
    decision: cleanText(req.body?.decision) || 'merge_approval_blocked_missing_external_ci',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'merge_approval_blocked_external_ci_and_pr_submission',
    summary: cleanText(req.body?.summary) || 'Reviewed operator merge approval and kept merge blocked until PR submission and external CI result exist.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-operator-merge-approval-receipts/:id/submitted-pr-evidence', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalSubmittedPrEvidence({
    operatorMergeApprovalReceiptId: cleanText(req.params.id),
    evidenceKind: cleanText(req.body?.evidenceKind || req.body?.evidence_kind) || 'submitted_pr_evidence_review',
    decision: cleanText(req.body?.decision) || 'submitted_pr_evidence_recorded_pending_ci',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'submitted_pr_evidence_blocked_external_ci',
    pullRequestUrl: cleanText(req.body?.pullRequestUrl || req.body?.pull_request_url) || null,
    summary: cleanText(req.body?.summary) || 'Recorded submitted PR evidence while external CI and merge remain blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-submitted-pr-evidence-receipts/:id/pr-external-verification', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalPrExternalVerificationReconciliation({
    submittedPrEvidenceReceiptId: cleanText(req.params.id),
    verificationKind: cleanText(req.body?.verificationKind || req.body?.verification_kind) || 'pr_external_verification_reconciliation',
    decision: cleanText(req.body?.decision) || 'pr_external_verification_blocked_no_github_observation',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'pr_external_verification_blocked',
    summary: cleanText(req.body?.summary) || 'Reconciled submitted PR evidence while GitHub verification, external CI, and merge remain blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-pr-external-verification-receipts/:id/external-ci-result', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalExternalCiResultIngestion({
    prExternalVerificationReceiptId: cleanText(req.params.id),
    resultKind: cleanText(req.body?.resultKind || req.body?.result_kind) || 'external_ci_result_ingestion',
    decision: cleanText(req.body?.decision) || 'external_ci_result_ingested_pending_pr_verification_and_operator_merge',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'external_ci_result_ingested_merge_blocked',
    ciProvider: cleanText(req.body?.ciProvider || req.body?.ci_provider) || 'github_actions',
    ciRunUrl: cleanText(req.body?.ciRunUrl || req.body?.ci_run_url) || null,
    ciStatus: cleanText(req.body?.ciStatus || req.body?.ci_status) || 'passed',
    summary: cleanText(req.body?.summary) || 'Ingested operator-provided external CI result while PR verification and merge remain blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-external-ci-result-receipts/:id/github-pr-verification', (req, res) => {
  res.json(portfolioOperatorInbox.recordEvalGithubPrVerificationPreflight({
    externalCiResultReceiptId: cleanText(req.params.id),
    verificationKind: cleanText(req.body?.verificationKind || req.body?.verification_kind) || 'github_pr_verification_preflight',
    decision: cleanText(req.body?.decision) || 'github_pr_verification_blocked_missing_live_observation',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'github_pr_verification_blocked',
    summary: cleanText(req.body?.summary) || 'Prepared GitHub PR verification preflight while live GitHub observation and merge remain blocked.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-github-pr-verification-receipts/:id/observation-contract', (req, res) => {
  const contractResult = runGithubPullRequestObservationAdapterContract();
  res.json(portfolioOperatorInbox.recordEvalGithubPrObservationAdapterContract({
    githubPrVerificationReceiptId: cleanText(req.params.id),
    observationKind: cleanText(req.body?.observationKind || req.body?.observation_kind) || 'github_pr_observation_adapter_contract',
    decision: cleanText(req.body?.decision) || 'github_pr_observation_contract_passed_live_blocked',
    mode: cleanText(req.body?.mode) || 'dry_run',
    status: cleanText(req.body?.status) || 'github_pr_observation_contract_passed_blocked_live_read',
    summary: cleanText(req.body?.summary) || 'Recorded non-mutating GitHub PR observation adapter contract while live GitHub observation and merge remain blocked.',
    contractResult,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/eval-github-pr-observation-receipts/:id/check-run-observation', async (req, res) => {
  try {
    const githubPrObservationReceipt = portfolioOperatorInbox.getEvalGithubPrObservationReceipt(cleanText(req.params.id));
    if (!githubPrObservationReceipt) {
      res.status(404).json({ error: 'GitHub PR observation receipt not found' });
      return;
    }
    const observationResult = await observeGithubCheckRuns({
      pullRequestUrl: githubPrObservationReceipt.pull_request_url,
      githubApiUrl: githubPrObservationReceipt.github_api_url,
      githubToken: process.env.GITHUB_TOKEN || '',
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalGithubCheckRunObservation({
      githubPrObservationReceiptId: githubPrObservationReceipt.id,
      observationKind: cleanText(req.body?.observationKind || req.body?.observation_kind) || 'github_check_run_observation',
      decision: cleanText(req.body?.decision) || (observationResult.observationMode === 'live' ? 'check_run_observation_live_merge_blocked' : 'check_run_observation_sandbox_live_blocked'),
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'check_run_observed_blocked_merge',
      summary: cleanText(req.body?.summary) || 'Recorded read-only GitHub check-run observation while operator approval and merge remain blocked.',
      observationResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

const recordEvalMergeExecutionAdapterContract = (req, res) => {
  try {
    const githubCheckRunObservationReceipt = portfolioOperatorInbox.getEvalGithubCheckRunObservationReceipt(cleanText(req.params.id));
    if (!githubCheckRunObservationReceipt) {
      res.status(404).json({ error: 'GitHub check-run observation receipt not found' });
      return;
    }
    const contractResult = runMergeExecutionAdapterContract({
      pullRequestUrl: githubCheckRunObservationReceipt.pull_request_url,
      githubApiUrl: githubCheckRunObservationReceipt.github_api_url,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeExecutionAdapterContract({
      githubCheckRunObservationReceiptId: githubCheckRunObservationReceipt.id,
      adapterKey: cleanText(req.body?.adapterKey || req.body?.adapter_key) || contractResult.adapterKey,
      contractKind: cleanText(req.body?.contractKind || req.body?.contract_kind) || contractResult.contractKind,
      decision: cleanText(req.body?.decision) || 'merge_execution_adapter_contract_recorded_live_merge_blocked',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_execution_adapter_contract_passed_blocked',
      summary: cleanText(req.body?.summary) || 'Recorded non-mutating merge execution adapter contract while live merge execution remains blocked.',
      contractResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-github-check-run-observation-receipts/:id/merge-execution-adapter-contract', recordEvalMergeExecutionAdapterContract);
app.post('/api/portfolio/eval-github-check-run-observation-receipts/:id/merge-execution-adapter', recordEvalMergeExecutionAdapterContract);

const recordEvalOperatorMergeCompletionGate = (req, res) => {
  try {
    res.json(portfolioOperatorInbox.recordEvalOperatorMergeCompletionGate({
      githubCheckRunObservationReceiptId: cleanText(req.params.id),
      gateKind: cleanText(req.body?.gateKind || req.body?.gate_kind) || 'operator_merge_completion_gate',
      decision: cleanText(req.body?.decision) || 'merge_completion_blocked_live_observation_required',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_completion_reviewed_blocked',
      summary: cleanText(req.body?.summary) || 'Reviewed operator merge completion gate while live GitHub proof, operator approval, merge adapter, and merge remain blocked.',
      operatorDecision: req.body?.operatorDecision && typeof req.body.operatorDecision === 'object' ? req.body.operatorDecision : null,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-github-check-run-observation-receipts/:id/operator-merge-completion', recordEvalOperatorMergeCompletionGate);
app.post('/api/portfolio/eval-github-check-run-observation-receipts/:id/operator-merge-completion-gate', recordEvalOperatorMergeCompletionGate);

const recordEvalLiveMergeAuthorization = (req, res) => {
  try {
    res.json(portfolioOperatorInbox.recordEvalLiveMergeAuthorization({
      operatorMergeCompletionGateReceiptId: cleanText(req.params.id),
      authorizationKind: cleanText(req.body?.authorizationKind || req.body?.authorization_kind) || 'live_merge_authorization_preflight',
      decision: cleanText(req.body?.decision) || 'live_merge_authorization_blocked_missing_branch_protection_and_token_scope_proof',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'live_merge_authorization_blocked',
      summary: cleanText(req.body?.summary) || 'Reviewed live merge authorization while real-token approval and live merge execution remain blocked.',
      authorizationRequest: req.body?.authorizationRequest && typeof req.body.authorizationRequest === 'object' ? req.body.authorizationRequest : null,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-operator-merge-completion-gate-receipts/:id/live-merge-authorization', recordEvalLiveMergeAuthorization);
app.post('/api/portfolio/eval-operator-merge-completion-gate-receipts/:id/live-merge-authorization-preflight', recordEvalLiveMergeAuthorization);

const recordEvalBranchProtectionReadbackAdapterContract = (req, res) => {
  try {
    const liveMergeAuthorizationReceipt = portfolioOperatorInbox.getEvalLiveMergeAuthorizationReceipt(cleanText(req.params.id));
    if (!liveMergeAuthorizationReceipt) {
      res.status(404).json({ error: 'Live merge authorization receipt not found' });
      return;
    }
    const contractResult = runBranchProtectionReadbackAdapterContract({
      pullRequestUrl: liveMergeAuthorizationReceipt.pull_request_url,
      githubApiUrl: liveMergeAuthorizationReceipt.github_api_url,
      targetBranch: liveMergeAuthorizationReceipt.response?.branchProtectionProof?.targetBranch || 'main',
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalBranchProtectionReadbackAdapterContract({
      liveMergeAuthorizationReceiptId: liveMergeAuthorizationReceipt.id,
      adapterKey: cleanText(req.body?.adapterKey || req.body?.adapter_key) || contractResult.adapterKey,
      contractKind: cleanText(req.body?.contractKind || req.body?.contract_kind) || contractResult.contractKind,
      decision: cleanText(req.body?.decision) || 'branch_protection_readback_contract_passed_blocked_live_read',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'branch_protection_readback_contract_passed_blocked_live_read',
      summary: cleanText(req.body?.summary) || 'Recorded non-mutating branch-protection readback adapter contract while live GitHub reads remain blocked.',
      contractResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-live-merge-authorization-receipts/:id/branch-protection-readback-adapter-contract', recordEvalBranchProtectionReadbackAdapterContract);
app.post('/api/portfolio/eval-live-merge-authorization-receipts/:id/branch-protection-readback', recordEvalBranchProtectionReadbackAdapterContract);

const recordEvalTokenScopeObservationAdapterContract = (req, res) => {
  try {
    const liveMergeAuthorizationReceipt = portfolioOperatorInbox.getEvalLiveMergeAuthorizationReceipt(cleanText(req.params.id));
    if (!liveMergeAuthorizationReceipt) {
      res.status(404).json({ error: 'Live merge authorization receipt not found' });
      return;
    }
    const contractResult = runTokenScopeObservationAdapterContract({
      pullRequestUrl: liveMergeAuthorizationReceipt.pull_request_url,
      githubApiUrl: liveMergeAuthorizationReceipt.github_api_url,
      requiredScopes: liveMergeAuthorizationReceipt.response?.requiredGithubTokenScopes || undefined,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalTokenScopeObservationAdapterContract({
      liveMergeAuthorizationReceiptId: liveMergeAuthorizationReceipt.id,
      branchProtectionReadbackAdapterContractReceiptId: cleanText(req.body?.branchProtectionReadbackAdapterContractReceiptId || req.body?.branch_protection_readback_adapter_contract_receipt_id) || null,
      adapterKey: cleanText(req.body?.adapterKey || req.body?.adapter_key) || contractResult.adapterKey,
      contractKind: cleanText(req.body?.contractKind || req.body?.contract_kind) || contractResult.contractKind,
      decision: cleanText(req.body?.decision) || 'token_scope_observation_contract_passed_blocked_live_token',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'token_scope_observation_contract_passed_blocked_live_token',
      summary: cleanText(req.body?.summary) || 'Recorded non-mutating token-scope observation adapter contract while real-token authorization remains blocked.',
      contractResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-live-merge-authorization-receipts/:id/token-scope-observation-adapter-contract', recordEvalTokenScopeObservationAdapterContract);
app.post('/api/portfolio/eval-live-merge-authorization-receipts/:id/token-scope-observation', recordEvalTokenScopeObservationAdapterContract);

const recordEvalSecretRedactionProof = (req, res) => {
  try {
    const tokenScopeObservationAdapterContractReceipt = portfolioOperatorInbox.getEvalTokenScopeObservationAdapterContractReceipt(cleanText(req.params.id));
    if (!tokenScopeObservationAdapterContractReceipt) {
      res.status(404).json({ error: 'Token scope observation adapter contract receipt not found' });
      return;
    }
    const proofResult = runSecretRedactionProof({ now: Date.now() });
    res.json(portfolioOperatorInbox.recordEvalSecretRedactionProof({
      tokenScopeObservationAdapterContractReceiptId: tokenScopeObservationAdapterContractReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || tokenScopeObservationAdapterContractReceipt.live_merge_authorization_receipt_id,
      proofKind: cleanText(req.body?.proofKind || req.body?.proof_kind) || proofResult.proofKind,
      decision: cleanText(req.body?.decision) || 'secret_redaction_proof_recorded_blocked_live_token',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'secret_redaction_proof_recorded',
      summary: cleanText(req.body?.summary) || 'Recorded secret redaction proof while raw token persistence and live merge execution remain blocked.',
      proofResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-token-scope-observation-adapter-contract-receipts/:id/secret-redaction-proof', recordEvalSecretRedactionProof);
app.post('/api/portfolio/eval-token-scope-observation-adapter-contract-receipts/:id/secret-redaction', recordEvalSecretRedactionProof);

const recordEvalMergeQueueReadbackAdapterContract = (req, res) => {
  try {
    const secretRedactionProofReceipt = portfolioOperatorInbox.getEvalSecretRedactionProofReceipt(cleanText(req.params.id));
    if (!secretRedactionProofReceipt) {
      res.status(404).json({ error: 'Secret redaction proof receipt not found' });
      return;
    }
    const liveMergeAuthorizationReceipt = portfolioOperatorInbox.getEvalLiveMergeAuthorizationReceipt(secretRedactionProofReceipt.live_merge_authorization_receipt_id);
    const branchProtectionProof = liveMergeAuthorizationReceipt?.response?.branchProtectionProof || {};
    const contractResult = runMergeQueueReadbackAdapterContract({
      pullRequestUrl: cleanText(req.body?.pullRequestUrl || req.body?.pull_request_url) || secretRedactionProofReceipt.pull_request_url,
      githubApiUrl: cleanText(req.body?.githubApiUrl || req.body?.github_api_url) || secretRedactionProofReceipt.github_api_url,
      repoFullName: cleanText(req.body?.repoFullName || req.body?.repo_full_name) || branchProtectionProof.repoFullName,
      targetBranch: cleanText(req.body?.targetBranch || req.body?.target_branch) || branchProtectionProof.targetBranch || liveMergeAuthorizationReceipt?.target_branch || 'main',
      requiredStatusChecks: Array.isArray(req.body?.requiredStatusChecks || req.body?.required_status_checks)
        ? (req.body.requiredStatusChecks || req.body.required_status_checks)
        : branchProtectionProof.requiredStatusChecks,
      requiredApprovingReviewCount: Number(req.body?.requiredApprovingReviewCount || req.body?.required_approving_review_count || branchProtectionProof.requiredApprovingReviewCount) || 1,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueReadbackAdapterContract({
      secretRedactionProofReceiptId: secretRedactionProofReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || secretRedactionProofReceipt.live_merge_authorization_receipt_id,
      adapterKey: cleanText(req.body?.adapterKey || req.body?.adapter_key) || contractResult.adapterKey,
      contractKind: cleanText(req.body?.contractKind || req.body?.contract_kind) || contractResult.contractKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_readback_contract_passed_blocked_live_read',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_readback_contract_passed_blocked_live_read',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue readback adapter contract while live GitHub reads and merge execution remain blocked.',
      contractResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-secret-redaction-proof-receipts/:id/merge-queue-readback-adapter-contract', recordEvalMergeQueueReadbackAdapterContract);
app.post('/api/portfolio/eval-secret-redaction-proof-receipts/:id/merge-queue-readback', recordEvalMergeQueueReadbackAdapterContract);

const recordEvalMergeQueueLiveReadReconciliation = (req, res) => {
  try {
    const mergeQueueReadbackAdapterContractReceipt = portfolioOperatorInbox.getEvalMergeQueueReadbackAdapterContractReceipt(cleanText(req.params.id));
    if (!mergeQueueReadbackAdapterContractReceipt) {
      res.status(404).json({ error: 'Merge queue readback adapter contract receipt not found' });
      return;
    }
    const response = mergeQueueReadbackAdapterContractReceipt.response || {};
    const reconciliationResult = runMergeQueueLiveReadReconciliation({
      localContractReceiptId: mergeQueueReadbackAdapterContractReceipt.id,
      pullRequestUrl: cleanText(req.body?.pullRequestUrl || req.body?.pull_request_url) || mergeQueueReadbackAdapterContractReceipt.pull_request_url,
      githubApiUrl: cleanText(req.body?.githubApiUrl || req.body?.github_api_url) || mergeQueueReadbackAdapterContractReceipt.github_api_url,
      repoFullName: cleanText(req.body?.repoFullName || req.body?.repo_full_name) || response.repoFullName,
      targetBranch: cleanText(req.body?.targetBranch || req.body?.target_branch) || mergeQueueReadbackAdapterContractReceipt.target_branch || response.targetBranch || 'main',
      requiredStatusChecks: Array.isArray(req.body?.requiredStatusChecks || req.body?.required_status_checks)
        ? (req.body.requiredStatusChecks || req.body.required_status_checks)
        : response.requiredStatusChecksContractShape,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueLiveReadReconciliation({
      mergeQueueReadbackAdapterContractReceiptId: mergeQueueReadbackAdapterContractReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || mergeQueueReadbackAdapterContractReceipt.live_merge_authorization_receipt_id,
      adapterKey: cleanText(req.body?.adapterKey || req.body?.adapter_key) || reconciliationResult.adapterKey,
      reconciliationKind: cleanText(req.body?.reconciliationKind || req.body?.reconciliation_kind) || reconciliationResult.reconciliationKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_live_read_reconciliation_blocked_real_token',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_live_read_reconciliation_blocked_real_token',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue live-read reconciliation as blocked until a real token and live GitHub readback exist.',
      reconciliationResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-readback-adapter-contract-receipts/:id/live-read-reconciliation', recordEvalMergeQueueLiveReadReconciliation);
app.post('/api/portfolio/eval-merge-queue-readback-adapter-contract-receipts/:id/merge-queue-live-read-reconciliation', recordEvalMergeQueueLiveReadReconciliation);

const recordEvalMergeQueueLiveReadAdapterContract = (req, res) => {
  try {
    const reconciliationReceipt = portfolioOperatorInbox.getEvalMergeQueueLiveReadReconciliationReceipt(cleanText(req.params.id));
    if (!reconciliationReceipt) {
      res.status(404).json({ error: 'Merge queue live-read reconciliation receipt not found' });
      return;
    }
    const response = reconciliationReceipt.response || {};
    const contractResult = runMergeQueueLiveReadAdapterContract({
      localReconciliationReceiptId: reconciliationReceipt.id,
      pullRequestUrl: cleanText(req.body?.pullRequestUrl || req.body?.pull_request_url) || reconciliationReceipt.pull_request_url,
      githubApiUrl: cleanText(req.body?.githubApiUrl || req.body?.github_api_url) || reconciliationReceipt.github_api_url,
      repoFullName: cleanText(req.body?.repoFullName || req.body?.repo_full_name) || response.repoFullName,
      targetBranch: cleanText(req.body?.targetBranch || req.body?.target_branch) || reconciliationReceipt.target_branch || response.targetBranch || 'main',
      requiredStatusChecks: Array.isArray(req.body?.requiredStatusChecks || req.body?.required_status_checks)
        ? (req.body.requiredStatusChecks || req.body.required_status_checks)
        : response.requiredStatusChecksContractShape,
      requiredTokenScopes: Array.isArray(req.body?.requiredTokenScopes || req.body?.required_token_scopes)
        ? (req.body.requiredTokenScopes || req.body.required_token_scopes)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueLiveReadAdapterContract({
      mergeQueueLiveReadReconciliationReceiptId: reconciliationReceipt.id,
      mergeQueueReadbackAdapterContractReceiptId: reconciliationReceipt.merge_queue_readback_adapter_contract_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || reconciliationReceipt.live_merge_authorization_receipt_id,
      adapterKey: cleanText(req.body?.adapterKey || req.body?.adapter_key) || contractResult.adapterKey,
      contractKind: cleanText(req.body?.contractKind || req.body?.contract_kind) || contractResult.contractKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_live_read_adapter_contract_blocked_real_token',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_live_read_adapter_contract_blocked_real_token',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue live-read adapter contract while real-token GitHub reads and merge execution remain blocked.',
      contractResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-live-read-reconciliation-receipts/:id/live-read-adapter-contract', recordEvalMergeQueueLiveReadAdapterContract);
app.post('/api/portfolio/eval-merge-queue-live-read-reconciliation-receipts/:id/merge-queue-live-read-adapter-contract', recordEvalMergeQueueLiveReadAdapterContract);

const recordEvalMergeQueueLiveReadReadiness = (req, res) => {
  try {
    const adapterContractReceipt = portfolioOperatorInbox.getEvalMergeQueueLiveReadAdapterContractReceipt(cleanText(req.params.id));
    if (!adapterContractReceipt) {
      res.status(404).json({ error: 'Merge queue live-read adapter contract receipt not found' });
      return;
    }
    const response = adapterContractReceipt.response || {};
    const readinessResult = runMergeQueueLiveReadReadinessPacket({
      adapterContractReceiptId: adapterContractReceipt.id,
      pullRequestUrl: cleanText(req.body?.pullRequestUrl || req.body?.pull_request_url) || adapterContractReceipt.pull_request_url,
      githubApiUrl: cleanText(req.body?.githubApiUrl || req.body?.github_api_url) || adapterContractReceipt.github_api_url,
      repoFullName: cleanText(req.body?.repoFullName || req.body?.repo_full_name) || response.repoFullName,
      targetBranch: cleanText(req.body?.targetBranch || req.body?.target_branch) || adapterContractReceipt.target_branch || response.targetBranch || 'main',
      requiredStatusChecks: Array.isArray(req.body?.requiredStatusChecks || req.body?.required_status_checks)
        ? (req.body.requiredStatusChecks || req.body.required_status_checks)
        : response.requiredStatusChecksContractShape,
      requiredTokenScopes: Array.isArray(req.body?.requiredTokenScopes || req.body?.required_token_scopes)
        ? (req.body.requiredTokenScopes || req.body.required_token_scopes)
        : response.requiredTokenScopesContractShape,
      requiredSecretRefs: Array.isArray(req.body?.requiredSecretRefs || req.body?.required_secret_refs)
        ? (req.body.requiredSecretRefs || req.body.required_secret_refs)
        : null,
      requiredOperatorApprovals: Array.isArray(req.body?.requiredOperatorApprovals || req.body?.required_operator_approvals)
        ? (req.body.requiredOperatorApprovals || req.body.required_operator_approvals)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueLiveReadReadiness({
      mergeQueueLiveReadAdapterContractReceiptId: adapterContractReceipt.id,
      mergeQueueLiveReadReconciliationReceiptId: adapterContractReceipt.merge_queue_live_read_reconciliation_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || adapterContractReceipt.live_merge_authorization_receipt_id,
      readinessKey: cleanText(req.body?.readinessKey || req.body?.readiness_key) || readinessResult.readinessKey,
      readinessKind: cleanText(req.body?.readinessKind || req.body?.readiness_kind) || readinessResult.readinessKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_live_read_readiness_blocked_credentials',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_live_read_readiness_blocked_credentials',
      summary: cleanText(req.body?.summary) || 'Recorded guarded merge-queue live-read readiness while credentials, live GitHub reads, and merge execution remain blocked.',
      readinessResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-live-read-adapter-contract-receipts/:id/live-read-readiness', recordEvalMergeQueueLiveReadReadiness);
app.post('/api/portfolio/eval-merge-queue-live-read-adapter-contract-receipts/:id/merge-queue-live-read-readiness', recordEvalMergeQueueLiveReadReadiness);

const recordEvalMergeQueueCredentialHandoff = (req, res) => {
  try {
    const readinessReceipt = portfolioOperatorInbox.getEvalMergeQueueLiveReadReadinessReceipt(cleanText(req.params.id));
    if (!readinessReceipt) {
      res.status(404).json({ error: 'Merge queue live-read readiness receipt not found' });
      return;
    }
    const response = readinessReceipt.response || {};
    const handoffResult = runMergeQueueCredentialHandoffPacket({
      readinessReceiptId: readinessReceipt.id,
      pullRequestUrl: cleanText(req.body?.pullRequestUrl || req.body?.pull_request_url) || readinessReceipt.pull_request_url,
      githubApiUrl: cleanText(req.body?.githubApiUrl || req.body?.github_api_url) || readinessReceipt.github_api_url,
      repoFullName: cleanText(req.body?.repoFullName || req.body?.repo_full_name) || response.repoFullName,
      targetBranch: cleanText(req.body?.targetBranch || req.body?.target_branch) || readinessReceipt.target_branch || response.targetBranch || 'main',
      requiredStatusChecks: Array.isArray(req.body?.requiredStatusChecks || req.body?.required_status_checks)
        ? (req.body.requiredStatusChecks || req.body.required_status_checks)
        : response.requiredStatusChecksReadinessShape,
      requiredTokenScopes: Array.isArray(req.body?.requiredTokenScopes || req.body?.required_token_scopes)
        ? (req.body.requiredTokenScopes || req.body.required_token_scopes)
        : response.requiredTokenScopesReadinessShape,
      requiredSecretRefs: Array.isArray(req.body?.requiredSecretRefs || req.body?.required_secret_refs)
        ? (req.body.requiredSecretRefs || req.body.required_secret_refs)
        : response.requiredSecretRefs,
      requiredOperatorApprovals: Array.isArray(req.body?.requiredOperatorApprovals || req.body?.required_operator_approvals)
        ? (req.body.requiredOperatorApprovals || req.body.required_operator_approvals)
        : null,
      secretStoreReference: cleanText(req.body?.secretStoreReference || req.body?.secret_store_reference) || null,
      custodyRequirements: Array.isArray(req.body?.custodyRequirements || req.body?.custody_requirements)
        ? (req.body.custodyRequirements || req.body.custody_requirements)
        : null,
      rotationPlan: Array.isArray(req.body?.rotationPlan || req.body?.rotation_plan)
        ? (req.body.rotationPlan || req.body.rotation_plan)
        : null,
      revocationPlan: Array.isArray(req.body?.revocationPlan || req.body?.revocation_plan)
        ? (req.body.revocationPlan || req.body.revocation_plan)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueCredentialHandoff({
      mergeQueueLiveReadReadinessReceiptId: readinessReceipt.id,
      mergeQueueLiveReadAdapterContractReceiptId: readinessReceipt.merge_queue_live_read_adapter_contract_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || readinessReceipt.live_merge_authorization_receipt_id,
      handoffKey: cleanText(req.body?.handoffKey || req.body?.handoff_key) || handoffResult.handoffKey,
      handoffKind: cleanText(req.body?.handoffKind || req.body?.handoff_kind) || handoffResult.handoffKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_credential_handoff_blocked_secret_value',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_credential_handoff_blocked_secret_value',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue credential handoff while secret values, live GitHub reads, and merge execution remain blocked.',
      handoffResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-live-read-readiness-receipts/:id/credential-handoff', recordEvalMergeQueueCredentialHandoff);
app.post('/api/portfolio/eval-merge-queue-live-read-readiness-receipts/:id/merge-queue-credential-handoff', recordEvalMergeQueueCredentialHandoff);

const recordEvalMergeQueueLiveReadPreflight = (req, res) => {
  try {
    const handoffReceipt = portfolioOperatorInbox.getEvalMergeQueueCredentialHandoffReceipt(cleanText(req.params.id));
    if (!handoffReceipt) {
      res.status(404).json({ error: 'Merge queue credential handoff receipt not found' });
      return;
    }
    const response = handoffReceipt.response || {};
    const preflightResult = runMergeQueueLiveReadPreflightEnvelope({
      credentialHandoffReceiptId: handoffReceipt.id,
      pullRequestUrl: cleanText(req.body?.pullRequestUrl || req.body?.pull_request_url) || handoffReceipt.pull_request_url,
      githubApiUrl: cleanText(req.body?.githubApiUrl || req.body?.github_api_url) || handoffReceipt.github_api_url,
      repoFullName: cleanText(req.body?.repoFullName || req.body?.repo_full_name) || response.repoFullName,
      targetBranch: cleanText(req.body?.targetBranch || req.body?.target_branch) || handoffReceipt.target_branch || response.targetBranch || 'main',
      requiredStatusChecks: Array.isArray(req.body?.requiredStatusChecks || req.body?.required_status_checks)
        ? (req.body.requiredStatusChecks || req.body.required_status_checks)
        : response.requiredStatusChecksHandoffShape,
      requiredTokenScopes: Array.isArray(req.body?.requiredTokenScopes || req.body?.required_token_scopes)
        ? (req.body.requiredTokenScopes || req.body.required_token_scopes)
        : response.requiredTokenScopesHandoffShape,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || response.requiredSecretRefs?.[0] || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      apiVersion: cleanText(req.body?.apiVersion || req.body?.api_version) || null,
      acceptedMediaType: cleanText(req.body?.acceptedMediaType || req.body?.accepted_media_type) || null,
      conditionalRequestHeader: cleanText(req.body?.conditionalRequestHeader || req.body?.conditional_request_header) || null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueLiveReadPreflight({
      mergeQueueCredentialHandoffReceiptId: handoffReceipt.id,
      mergeQueueLiveReadReadinessReceiptId: handoffReceipt.merge_queue_live_read_readiness_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || handoffReceipt.live_merge_authorization_receipt_id,
      preflightKey: cleanText(req.body?.preflightKey || req.body?.preflight_key) || preflightResult.preflightKey,
      preflightKind: cleanText(req.body?.preflightKind || req.body?.preflight_kind) || preflightResult.preflightKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_live_read_preflight_blocked_no_runtime_token',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_live_read_preflight_blocked_no_runtime_token',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue live-read preflight envelope while token materialization, GitHub HTTP, and merge execution remain blocked.',
      preflightResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-credential-handoff-receipts/:id/live-read-preflight', recordEvalMergeQueueLiveReadPreflight);
app.post('/api/portfolio/eval-merge-queue-credential-handoff-receipts/:id/merge-queue-live-read-preflight', recordEvalMergeQueueLiveReadPreflight);

const recordEvalMergeQueueTokenQuarantine = (req, res) => {
  try {
    const preflightReceipt = portfolioOperatorInbox.getEvalMergeQueueLiveReadPreflightReceipt(cleanText(req.params.id));
    if (!preflightReceipt) {
      res.status(404).json({ error: 'Merge queue live-read preflight receipt not found' });
      return;
    }
    const response = preflightReceipt.response || {};
    const quarantineResult = runMergeQueueTokenQuarantinePacket({
      liveReadPreflightReceiptId: preflightReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || response.runtimeSecretRef || null,
      quarantinePolicy: Array.isArray(req.body?.quarantinePolicy || req.body?.quarantine_policy)
        ? (req.body.quarantinePolicy || req.body.quarantine_policy)
        : null,
      releaseGates: Array.isArray(req.body?.releaseGates || req.body?.release_gates)
        ? (req.body.releaseGates || req.body.release_gates)
        : null,
      rollbackPlan: Array.isArray(req.body?.rollbackPlan || req.body?.rollback_plan)
        ? (req.body.rollbackPlan || req.body.rollback_plan)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueTokenQuarantine({
      mergeQueueLiveReadPreflightReceiptId: preflightReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || preflightReceipt.live_merge_authorization_receipt_id,
      quarantineKey: cleanText(req.body?.quarantineKey || req.body?.quarantine_key) || quarantineResult.quarantineKey,
      quarantineKind: cleanText(req.body?.quarantineKind || req.body?.quarantine_kind) || quarantineResult.quarantineKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_token_quarantine_blocked_materialization',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_token_quarantine_blocked_materialization',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue token materialization quarantine while token materialization, GitHub HTTP, and merge execution remain blocked.',
      quarantineResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-live-read-preflight-receipts/:id/token-quarantine', recordEvalMergeQueueTokenQuarantine);
app.post('/api/portfolio/eval-merge-queue-live-read-preflight-receipts/:id/merge-queue-token-quarantine', recordEvalMergeQueueTokenQuarantine);

const recordEvalMergeQueueLiveReadResponseIngestion = (req, res) => {
  try {
    const quarantineReceipt = portfolioOperatorInbox.getEvalMergeQueueTokenQuarantineReceipt(cleanText(req.params.id));
    if (!quarantineReceipt) {
      res.status(404).json({ error: 'Merge queue token quarantine receipt not found' });
      return;
    }
    const ingestionResult = runMergeQueueLiveReadResponseIngestionPacket({
      mergeQueueTokenQuarantineReceiptId: quarantineReceipt.id,
      responseSource: cleanText(req.body?.responseSource || req.body?.response_source) || null,
      observedHttpStatus: req.body?.observedHttpStatus || req.body?.observed_http_status || null,
      observedEtag: cleanText(req.body?.observedEtag || req.body?.observed_etag) || null,
      observedRulesetIds: Array.isArray(req.body?.observedRulesetIds || req.body?.observed_ruleset_ids)
        ? (req.body.observedRulesetIds || req.body.observed_ruleset_ids)
        : null,
      observedRequiredStatusChecks: Array.isArray(req.body?.observedRequiredStatusChecks || req.body?.observed_required_status_checks)
        ? (req.body.observedRequiredStatusChecks || req.body.observed_required_status_checks)
        : null,
      observedMergeQueueRequired: req.body?.observedMergeQueueRequired ?? req.body?.observed_merge_queue_required ?? true,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueLiveReadResponseIngestion({
      mergeQueueTokenQuarantineReceiptId: quarantineReceipt.id,
      mergeQueueLiveReadPreflightReceiptId: quarantineReceipt.merge_queue_live_read_preflight_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || quarantineReceipt.live_merge_authorization_receipt_id,
      ingestionKey: cleanText(req.body?.ingestionKey || req.body?.ingestion_key) || ingestionResult.ingestionKey,
      ingestionKind: cleanText(req.body?.ingestionKind || req.body?.ingestion_kind) || ingestionResult.ingestionKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_live_read_response_ingested_merge_blocked',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_live_read_response_ingested_merge_blocked',
      summary: cleanText(req.body?.summary) || 'Recorded operator-supplied merge-queue live-read response evidence while GitHub API calls and merge execution remain blocked.',
      ingestionResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-token-quarantine-receipts/:id/live-read-response-ingestion', recordEvalMergeQueueLiveReadResponseIngestion);
app.post('/api/portfolio/eval-merge-queue-token-quarantine-receipts/:id/merge-queue-live-read-response-ingestion', recordEvalMergeQueueLiveReadResponseIngestion);

const recordEvalMergeQueueRuntimeTokenReleaseGate = (req, res) => {
  try {
    const responseReceipt = portfolioOperatorInbox.getEvalMergeQueueLiveReadResponseIngestionReceipt(cleanText(req.params.id));
    if (!responseReceipt) {
      res.status(404).json({ error: 'Merge queue live-read response ingestion receipt not found' });
      return;
    }
    const gateResult = runMergeQueueRuntimeTokenReleaseGatePacket({
      mergeQueueLiveReadResponseIngestionReceiptId: responseReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      releaseGateChecks: Array.isArray(req.body?.releaseGateChecks || req.body?.release_gate_checks)
        ? (req.body.releaseGateChecks || req.body.release_gate_checks)
        : null,
      deniedReasons: Array.isArray(req.body?.deniedReasons || req.body?.denied_reasons)
        ? (req.body.deniedReasons || req.body.denied_reasons)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueRuntimeTokenReleaseGate({
      mergeQueueLiveReadResponseIngestionReceiptId: responseReceipt.id,
      mergeQueueTokenQuarantineReceiptId: responseReceipt.merge_queue_token_quarantine_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || responseReceipt.live_merge_authorization_receipt_id,
      gateKey: cleanText(req.body?.gateKey || req.body?.gate_key) || gateResult.gateKey,
      gateKind: cleanText(req.body?.gateKind || req.body?.gate_kind) || gateResult.gateKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_runtime_token_release_blocked_no_runtime_secret',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_runtime_token_release_blocked_no_runtime_secret',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue runtime token release gate while runtime token release, GitHub HTTP, and merge execution remain blocked.',
      gateResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-live-read-response-ingestion-receipts/:id/runtime-token-release-gate', recordEvalMergeQueueRuntimeTokenReleaseGate);
app.post('/api/portfolio/eval-merge-queue-live-read-response-ingestion-receipts/:id/merge-queue-runtime-token-release-gate', recordEvalMergeQueueRuntimeTokenReleaseGate);

const recordEvalMergeQueueLiveReadVerificationPromotion = (req, res) => {
  try {
    const gateReceipt = portfolioOperatorInbox.getEvalMergeQueueRuntimeTokenReleaseGateReceipt(cleanText(req.params.id));
    if (!gateReceipt) {
      res.status(404).json({ error: 'Merge queue runtime token release gate receipt not found' });
      return;
    }
    const promotionResult = runMergeQueueLiveReadVerificationPromotionPacket({
      mergeQueueRuntimeTokenReleaseGateReceiptId: gateReceipt.id,
      promotionChecklist: Array.isArray(req.body?.promotionChecklist || req.body?.promotion_checklist)
        ? (req.body.promotionChecklist || req.body.promotion_checklist)
        : null,
      liveVerificationPlan: Array.isArray(req.body?.liveVerificationPlan || req.body?.live_verification_plan)
        ? (req.body.liveVerificationPlan || req.body.live_verification_plan)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueLiveReadVerificationPromotion({
      mergeQueueRuntimeTokenReleaseGateReceiptId: gateReceipt.id,
      mergeQueueLiveReadResponseIngestionReceiptId: gateReceipt.merge_queue_live_read_response_ingestion_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || gateReceipt.live_merge_authorization_receipt_id,
      promotionKey: cleanText(req.body?.promotionKey || req.body?.promotion_key) || promotionResult.promotionKey,
      promotionKind: cleanText(req.body?.promotionKind || req.body?.promotion_kind) || promotionResult.promotionKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_live_read_verification_promotion_blocked_live_http',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_live_read_verification_promotion_blocked_live_http',
      summary: cleanText(req.body?.summary) || 'Queued merge-queue live-read verification promotion while live GitHub HTTP and merge execution remain blocked.',
      promotionResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-runtime-token-release-gate-receipts/:id/live-read-verification-promotion', recordEvalMergeQueueLiveReadVerificationPromotion);
app.post('/api/portfolio/eval-merge-queue-runtime-token-release-gate-receipts/:id/merge-queue-live-read-verification-promotion', recordEvalMergeQueueLiveReadVerificationPromotion);

const recordEvalMergeQueueLiveHttpExecutionPreflightHandoff = (req, res) => {
  try {
    const promotionReceipt = portfolioOperatorInbox.getEvalMergeQueueLiveReadVerificationPromotionReceipt(cleanText(req.params.id));
    if (!promotionReceipt) {
      res.status(404).json({ error: 'Merge queue live-read verification promotion receipt not found' });
      return;
    }
    const handoffResult = runMergeQueueLiveHttpExecutionPreflightHandoffPacket({
      mergeQueueLiveReadVerificationPromotionReceiptId: promotionReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      executionPreflightChecklist: Array.isArray(req.body?.executionPreflightChecklist || req.body?.execution_preflight_checklist)
        ? (req.body.executionPreflightChecklist || req.body.execution_preflight_checklist)
        : null,
      liveHttpExecutionPlan: Array.isArray(req.body?.liveHttpExecutionPlan || req.body?.live_http_execution_plan)
        ? (req.body.liveHttpExecutionPlan || req.body.live_http_execution_plan)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueLiveHttpExecutionPreflightHandoff({
      mergeQueueLiveReadVerificationPromotionReceiptId: promotionReceipt.id,
      mergeQueueRuntimeTokenReleaseGateReceiptId: promotionReceipt.merge_queue_runtime_token_release_gate_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || promotionReceipt.live_merge_authorization_receipt_id,
      handoffKey: cleanText(req.body?.handoffKey || req.body?.handoff_key) || handoffResult.handoffKey,
      handoffKind: cleanText(req.body?.handoffKind || req.body?.handoff_kind) || handoffResult.handoffKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_live_http_execution_preflight_handoff_blocked_operator_release',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_live_http_execution_preflight_handoff_blocked_operator_release',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue live HTTP execution preflight handoff while token release, GitHub HTTP, and merge execution remain blocked.',
      handoffResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-live-read-verification-promotion-receipts/:id/live-http-execution-preflight-handoff', recordEvalMergeQueueLiveHttpExecutionPreflightHandoff);
app.post('/api/portfolio/eval-merge-queue-live-read-verification-promotion-receipts/:id/merge-queue-live-http-execution-preflight-handoff', recordEvalMergeQueueLiveHttpExecutionPreflightHandoff);

const recordEvalMergeQueueLiveHttpOperatorReleaseAck = (req, res) => {
  try {
    const handoffReceipt = portfolioOperatorInbox.getEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt(cleanText(req.params.id));
    if (!handoffReceipt) {
      res.status(404).json({ error: 'Merge queue live HTTP execution preflight handoff receipt not found' });
      return;
    }
    const releaseAckResult = runMergeQueueLiveHttpOperatorReleaseAckPacket({
      mergeQueueLiveHttpExecutionPreflightHandoffReceiptId: handoffReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      acknowledgedRisks: Array.isArray(req.body?.acknowledgedRisks || req.body?.acknowledged_risks)
        ? (req.body.acknowledgedRisks || req.body.acknowledged_risks)
        : null,
      releaseAckChecklist: Array.isArray(req.body?.releaseAckChecklist || req.body?.release_ack_checklist)
        ? (req.body.releaseAckChecklist || req.body.release_ack_checklist)
        : null,
      liveHttpReleasePlan: Array.isArray(req.body?.liveHttpReleasePlan || req.body?.live_http_release_plan)
        ? (req.body.liveHttpReleasePlan || req.body.live_http_release_plan)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueLiveHttpOperatorReleaseAck({
      mergeQueueLiveHttpExecutionPreflightHandoffReceiptId: handoffReceipt.id,
      mergeQueueLiveReadVerificationPromotionReceiptId: handoffReceipt.merge_queue_live_read_verification_promotion_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || handoffReceipt.live_merge_authorization_receipt_id,
      releaseAckKey: cleanText(req.body?.releaseAckKey || req.body?.release_ack_key) || releaseAckResult.releaseAckKey,
      releaseAckKind: cleanText(req.body?.releaseAckKind || req.body?.release_ack_kind) || releaseAckResult.releaseAckKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_live_http_operator_release_ack_blocked_secret_smoke',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_live_http_operator_release_ack_blocked_secret_smoke',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue live HTTP operator release acknowledgement while secret smoke, token release, GitHub HTTP, and merge execution remain blocked.',
      releaseAckResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-live-http-execution-preflight-handoff-receipts/:id/operator-release-ack', recordEvalMergeQueueLiveHttpOperatorReleaseAck);
app.post('/api/portfolio/eval-merge-queue-live-http-execution-preflight-handoff-receipts/:id/merge-queue-live-http-operator-release-ack', recordEvalMergeQueueLiveHttpOperatorReleaseAck);

const recordEvalMergeQueueRuntimeSecretProviderSmokeReadiness = (req, res) => {
  try {
    const releaseAckReceipt = portfolioOperatorInbox.getEvalMergeQueueLiveHttpOperatorReleaseAckReceipt(cleanText(req.params.id));
    if (!releaseAckReceipt) {
      res.status(404).json({ error: 'Merge queue live HTTP operator release ack receipt not found' });
      return;
    }
    const smokeReadinessResult = runMergeQueueRuntimeSecretProviderSmokeReadinessPacket({
      mergeQueueLiveHttpOperatorReleaseAckReceiptId: releaseAckReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      smokeProvider: cleanText(req.body?.smokeProvider || req.body?.smoke_provider) || null,
      smokeCommand: cleanText(req.body?.smokeCommand || req.body?.smoke_command) || null,
      smokeReadinessChecklist: Array.isArray(req.body?.smokeReadinessChecklist || req.body?.smoke_readiness_checklist)
        ? (req.body.smokeReadinessChecklist || req.body.smoke_readiness_checklist)
        : null,
      liveHttpReleasePlan: Array.isArray(req.body?.liveHttpReleasePlan || req.body?.live_http_release_plan)
        ? (req.body.liveHttpReleasePlan || req.body.live_http_release_plan)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueRuntimeSecretProviderSmokeReadiness({
      mergeQueueLiveHttpOperatorReleaseAckReceiptId: releaseAckReceipt.id,
      mergeQueueLiveHttpExecutionPreflightHandoffReceiptId: releaseAckReceipt.merge_queue_live_http_execution_preflight_handoff_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || releaseAckReceipt.live_merge_authorization_receipt_id,
      smokeReadinessKey: cleanText(req.body?.smokeReadinessKey || req.body?.smoke_readiness_key) || smokeReadinessResult.smokeReadinessKey,
      smokeReadinessKind: cleanText(req.body?.smokeReadinessKind || req.body?.smoke_readiness_kind) || smokeReadinessResult.smokeReadinessKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_runtime_secret_provider_smoke_readiness_blocked_token_release',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_runtime_secret_provider_smoke_readiness_blocked_token_release',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue runtime secret-provider smoke readiness while smoke execution, token release, GitHub HTTP, and merge execution remain blocked.',
      smokeReadinessResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-live-http-operator-release-ack-receipts/:id/runtime-secret-provider-smoke-readiness', recordEvalMergeQueueRuntimeSecretProviderSmokeReadiness);
app.post('/api/portfolio/eval-merge-queue-live-http-operator-release-ack-receipts/:id/merge-queue-runtime-secret-provider-smoke-readiness', recordEvalMergeQueueRuntimeSecretProviderSmokeReadiness);

const recordEvalMergeQueueRuntimeSecretProviderSmokeExecutionGate = (req, res) => {
  try {
    const readinessReceipt = portfolioOperatorInbox.getEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt(cleanText(req.params.id));
    if (!readinessReceipt) {
      res.status(404).json({ error: 'Merge queue runtime secret-provider smoke readiness receipt not found' });
      return;
    }
    const smokeGateResult = runMergeQueueRuntimeSecretProviderSmokeExecutionGatePacket({
      mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId: readinessReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      smokeProvider: cleanText(req.body?.smokeProvider || req.body?.smoke_provider) || null,
      smokeCommand: cleanText(req.body?.smokeCommand || req.body?.smoke_command) || null,
      blockedReasons: Array.isArray(req.body?.blockedReasons || req.body?.blocked_reasons)
        ? (req.body.blockedReasons || req.body.blocked_reasons)
        : null,
      smokeExecutionChecklist: Array.isArray(req.body?.smokeExecutionChecklist || req.body?.smoke_execution_checklist)
        ? (req.body.smokeExecutionChecklist || req.body.smoke_execution_checklist)
        : null,
      liveHttpReleasePlan: Array.isArray(req.body?.liveHttpReleasePlan || req.body?.live_http_release_plan)
        ? (req.body.liveHttpReleasePlan || req.body.live_http_release_plan)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueRuntimeSecretProviderSmokeExecutionGate({
      mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId: readinessReceipt.id,
      mergeQueueLiveHttpOperatorReleaseAckReceiptId: readinessReceipt.merge_queue_live_http_operator_release_ack_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || readinessReceipt.live_merge_authorization_receipt_id,
      smokeGateKey: cleanText(req.body?.smokeGateKey || req.body?.smoke_gate_key) || smokeGateResult.smokeGateKey,
      smokeGateKind: cleanText(req.body?.smokeGateKind || req.body?.smoke_gate_kind) || smokeGateResult.smokeGateKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_runtime_secret_provider_smoke_execution_blocked_no_secret_access',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_runtime_secret_provider_smoke_execution_blocked_no_secret_access',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue runtime secret-provider smoke execution gate while secret access, token release, GitHub HTTP, and merge execution remain blocked.',
      smokeGateResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-readiness-receipts/:id/smoke-execution-gate', recordEvalMergeQueueRuntimeSecretProviderSmokeExecutionGate);
app.post('/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-readiness-receipts/:id/merge-queue-runtime-secret-provider-smoke-execution-gate', recordEvalMergeQueueRuntimeSecretProviderSmokeExecutionGate);

const recordEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReview = (req, res) => {
  try {
    const gateReceipt = portfolioOperatorInbox.getEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt(cleanText(req.params.id));
    if (!gateReceipt) {
      res.status(404).json({ error: 'Merge queue runtime secret-provider smoke execution gate receipt not found' });
      return;
    }
    const evidenceReviewResult = runMergeQueueRuntimeSecretProviderSmokeEvidenceReviewPacket({
      mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId: gateReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      smokeProvider: cleanText(req.body?.smokeProvider || req.body?.smoke_provider) || null,
      smokeCommand: cleanText(req.body?.smokeCommand || req.body?.smoke_command) || null,
      evidenceRequirements: Array.isArray(req.body?.evidenceRequirements || req.body?.evidence_requirements)
        ? (req.body.evidenceRequirements || req.body.evidence_requirements)
        : null,
      evidenceFindings: Array.isArray(req.body?.evidenceFindings || req.body?.evidence_findings)
        ? (req.body.evidenceFindings || req.body.evidence_findings)
        : null,
      releaseCriteria: Array.isArray(req.body?.releaseCriteria || req.body?.release_criteria)
        ? (req.body.releaseCriteria || req.body.release_criteria)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReview({
      mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId: gateReceipt.id,
      mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId: gateReceipt.merge_queue_runtime_secret_provider_smoke_readiness_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || gateReceipt.live_merge_authorization_receipt_id,
      evidenceReviewKey: cleanText(req.body?.evidenceReviewKey || req.body?.evidence_review_key) || evidenceReviewResult.evidenceReviewKey,
      evidenceReviewKind: cleanText(req.body?.evidenceReviewKind || req.body?.evidence_review_kind) || evidenceReviewResult.evidenceReviewKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_runtime_secret_smoke_evidence_review_blocked_no_success',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_runtime_secret_smoke_evidence_review_blocked_no_success',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue runtime secret-provider smoke evidence review while successful smoke proof, token release, GitHub HTTP, and merge execution remain blocked.',
      evidenceReviewResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-execution-gate-receipts/:id/smoke-evidence-review', recordEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReview);
app.post('/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-execution-gate-receipts/:id/merge-queue-runtime-secret-provider-smoke-evidence-review', recordEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReview);

const recordEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflight = (req, res) => {
  try {
    const reviewReceipt = portfolioOperatorInbox.getEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt(cleanText(req.params.id));
    if (!reviewReceipt) {
      res.status(404).json({ error: 'Merge queue runtime secret-provider smoke evidence review receipt not found' });
      return;
    }
    const tokenPreflightResult = runMergeQueueMemoryOnlyRuntimeTokenReleasePreflightPacket({
      mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId: reviewReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      releasePreflightRequirements: Array.isArray(req.body?.releasePreflightRequirements || req.body?.release_preflight_requirements)
        ? (req.body.releasePreflightRequirements || req.body.release_preflight_requirements)
        : null,
      releaseDeniedReasons: Array.isArray(req.body?.releaseDeniedReasons || req.body?.release_denied_reasons)
        ? (req.body.releaseDeniedReasons || req.body.release_denied_reasons)
        : null,
      nextLiveReadCriteria: Array.isArray(req.body?.nextLiveReadCriteria || req.body?.next_live_read_criteria)
        ? (req.body.nextLiveReadCriteria || req.body.next_live_read_criteria)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflight({
      mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId: reviewReceipt.id,
      mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId: reviewReceipt.merge_queue_runtime_secret_provider_smoke_execution_gate_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || reviewReceipt.live_merge_authorization_receipt_id,
      tokenPreflightKey: cleanText(req.body?.tokenPreflightKey || req.body?.token_preflight_key) || tokenPreflightResult.tokenPreflightKey,
      tokenPreflightKind: cleanText(req.body?.tokenPreflightKind || req.body?.token_preflight_kind) || tokenPreflightResult.tokenPreflightKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_memory_token_preflight_blocked_no_smoke_success',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_memory_token_preflight_blocked_no_smoke_success',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue memory-only runtime token release preflight while successful smoke evidence, token release, GitHub HTTP, and merge execution remain blocked.',
      tokenPreflightResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-evidence-review-receipts/:id/memory-only-runtime-token-release-preflight', recordEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflight);
app.post('/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-evidence-review-receipts/:id/merge-queue-memory-only-runtime-token-release-preflight', recordEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflight);

const recordEvalMergeQueueSuccessfulSmokeEvidenceIngestion = (req, res) => {
  try {
    const preflightReceipt = portfolioOperatorInbox.getEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt(cleanText(req.params.id));
    if (!preflightReceipt) {
      res.status(404).json({ error: 'Merge queue memory-only runtime token release preflight receipt not found' });
      return;
    }
    const smokeEvidenceIngestionResult = runMergeQueueSuccessfulSmokeEvidenceIngestionPacket({
      mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId: preflightReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      smokeProvider: cleanText(req.body?.smokeProvider || req.body?.smoke_provider) || null,
      claimedSmokeCommand: cleanText(req.body?.claimedSmokeCommand || req.body?.claimed_smoke_command) || null,
      evidenceSource: cleanText(req.body?.evidenceSource || req.body?.evidence_source) || null,
      evidenceRequirements: Array.isArray(req.body?.evidenceRequirements || req.body?.evidence_requirements)
        ? (req.body.evidenceRequirements || req.body.evidence_requirements)
        : null,
      rejectionReasons: Array.isArray(req.body?.rejectionReasons || req.body?.rejection_reasons)
        ? (req.body.rejectionReasons || req.body.rejection_reasons)
        : null,
      releaseCriteria: Array.isArray(req.body?.releaseCriteria || req.body?.release_criteria || req.body?.nextCriteria || req.body?.next_criteria)
        ? (req.body.releaseCriteria || req.body.release_criteria || req.body.nextCriteria || req.body.next_criteria)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueSuccessfulSmokeEvidenceIngestion({
      mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId: preflightReceipt.id,
      mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId: preflightReceipt.merge_queue_runtime_secret_provider_smoke_evidence_review_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || preflightReceipt.live_merge_authorization_receipt_id,
      smokeEvidenceIngestionKey: cleanText(req.body?.smokeEvidenceIngestionKey || req.body?.smoke_evidence_ingestion_key) || smokeEvidenceIngestionResult.smokeEvidenceIngestionKey,
      smokeEvidenceIngestionKind: cleanText(req.body?.smokeEvidenceIngestionKind || req.body?.smoke_evidence_ingestion_kind) || smokeEvidenceIngestionResult.smokeEvidenceIngestionKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_successful_smoke_evidence_ingestion_rejected_fake_success',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_successful_smoke_evidence_ingestion_rejected_fake_success',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue successful smoke evidence ingestion rejection while fake success, token release, GitHub HTTP, and merge execution remain blocked.',
      smokeEvidenceIngestionResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-memory-only-runtime-token-release-preflight-receipts/:id/successful-smoke-evidence-ingestion', recordEvalMergeQueueSuccessfulSmokeEvidenceIngestion);
app.post('/api/portfolio/eval-merge-queue-memory-only-runtime-token-release-preflight-receipts/:id/merge-queue-successful-smoke-evidence-ingestion', recordEvalMergeQueueSuccessfulSmokeEvidenceIngestion);

const recordEvalMergeQueueRuntimeTokenReleaseDenial = (req, res) => {
  try {
    const ingestionReceipt = portfolioOperatorInbox.getEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt(cleanText(req.params.id));
    if (!ingestionReceipt) {
      res.status(404).json({ error: 'Merge queue successful smoke evidence ingestion receipt not found' });
      return;
    }
    const tokenReleaseDenialResult = runMergeQueueRuntimeTokenReleaseDenialPacket({
      mergeQueueSuccessfulSmokeEvidenceIngestionReceiptId: ingestionReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      denialPolicy: cleanText(req.body?.denialPolicy || req.body?.denial_policy) || null,
      denialReasons: Array.isArray(req.body?.denialReasons || req.body?.denial_reasons)
        ? (req.body.denialReasons || req.body.denial_reasons)
        : null,
      retryCriteria: Array.isArray(req.body?.retryCriteria || req.body?.retry_criteria)
        ? (req.body.retryCriteria || req.body.retry_criteria)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueRuntimeTokenReleaseDenial({
      mergeQueueSuccessfulSmokeEvidenceIngestionReceiptId: ingestionReceipt.id,
      mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId: ingestionReceipt.merge_queue_memory_only_runtime_token_release_preflight_receipt_id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || ingestionReceipt.live_merge_authorization_receipt_id,
      tokenReleaseDenialKey: cleanText(req.body?.tokenReleaseDenialKey || req.body?.token_release_denial_key) || tokenReleaseDenialResult.tokenReleaseDenialKey,
      tokenReleaseDenialKind: cleanText(req.body?.tokenReleaseDenialKind || req.body?.token_release_denial_kind) || tokenReleaseDenialResult.tokenReleaseDenialKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_runtime_token_release_denied_fake_smoke_success',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_runtime_token_release_denied_fake_smoke_success',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue runtime token release denial after fake smoke evidence was rejected.',
      tokenReleaseDenialResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-successful-smoke-evidence-ingestion-receipts/:id/runtime-token-release-denial', recordEvalMergeQueueRuntimeTokenReleaseDenial);
app.post('/api/portfolio/eval-merge-queue-successful-smoke-evidence-ingestion-receipts/:id/merge-queue-runtime-token-release-denial', recordEvalMergeQueueRuntimeTokenReleaseDenial);

const recordEvalMergeQueueFakeLiveReadReplayQuarantine = (req, res) => {
  try {
    const denialReceipt = portfolioOperatorInbox.getEvalMergeQueueRuntimeTokenReleaseDenialReceipt(cleanText(req.params.id));
    if (!denialReceipt) {
      res.status(404).json({ error: 'Merge queue runtime token release denial receipt not found' });
      return;
    }
    const replayQuarantineResult = runMergeQueueFakeLiveReadReplayQuarantinePacket({
      mergeQueueRuntimeTokenReleaseDenialReceiptId: denialReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      replaySource: cleanText(req.body?.replaySource || req.body?.replay_source) || null,
      quarantineReasons: Array.isArray(req.body?.quarantineReasons || req.body?.quarantine_reasons)
        ? (req.body.quarantineReasons || req.body.quarantine_reasons)
        : null,
      nextCriteria: Array.isArray(req.body?.nextCriteria || req.body?.next_criteria)
        ? (req.body.nextCriteria || req.body.next_criteria)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueFakeLiveReadReplayQuarantine({
      mergeQueueRuntimeTokenReleaseDenialReceiptId: denialReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || denialReceipt.live_merge_authorization_receipt_id,
      replayQuarantineKey: cleanText(req.body?.replayQuarantineKey || req.body?.replay_quarantine_key) || replayQuarantineResult.replayQuarantineKey,
      replayQuarantineKind: cleanText(req.body?.replayQuarantineKind || req.body?.replay_quarantine_kind) || replayQuarantineResult.replayQuarantineKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_fake_live_read_replay_quarantined_after_token_denial',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_fake_live_read_replay_quarantined_after_token_denial',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue fake live-read replay quarantine after runtime token release was denied.',
      replayQuarantineResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-runtime-token-release-denial-receipts/:id/fake-live-read-replay-quarantine', recordEvalMergeQueueFakeLiveReadReplayQuarantine);
app.post('/api/portfolio/eval-merge-queue-runtime-token-release-denial-receipts/:id/merge-queue-fake-live-read-replay-quarantine', recordEvalMergeQueueFakeLiveReadReplayQuarantine);

const recordEvalMergeQueueFinalBlockerLedger = (req, res) => {
  try {
    const replayQuarantineReceipt = portfolioOperatorInbox.getEvalMergeQueueFakeLiveReadReplayQuarantineReceipt(cleanText(req.params.id));
    if (!replayQuarantineReceipt) {
      res.status(404).json({ error: 'Merge queue fake live-read replay quarantine receipt not found' });
      return;
    }
    const finalBlockerLedgerResult = runMergeQueueFinalBlockerLedgerPacket({
      mergeQueueFakeLiveReadReplayQuarantineReceiptId: replayQuarantineReceipt.id,
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      blockerEntries: Array.isArray(req.body?.blockerEntries || req.body?.blocker_entries)
        ? (req.body.blockerEntries || req.body.blocker_entries)
        : null,
      releaseCriteria: Array.isArray(req.body?.releaseCriteria || req.body?.release_criteria)
        ? (req.body.releaseCriteria || req.body.release_criteria)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueFinalBlockerLedger({
      mergeQueueFakeLiveReadReplayQuarantineReceiptId: replayQuarantineReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || replayQuarantineReceipt.live_merge_authorization_receipt_id,
      finalBlockerLedgerKey: cleanText(req.body?.finalBlockerLedgerKey || req.body?.final_blocker_ledger_key) || finalBlockerLedgerResult.finalBlockerLedgerKey,
      finalBlockerLedgerKind: cleanText(req.body?.finalBlockerLedgerKind || req.body?.final_blocker_ledger_kind) || finalBlockerLedgerResult.finalBlockerLedgerKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_final_blocker_ledger_blocks_merge_after_replay_quarantine',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_final_blocker_ledger_blocks_merge_after_replay_quarantine',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue final blocker ledger after fake live-read replay quarantine.',
      finalBlockerLedgerResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-fake-live-read-replay-quarantine-receipts/:id/final-blocker-ledger', recordEvalMergeQueueFinalBlockerLedger);
app.post('/api/portfolio/eval-merge-queue-fake-live-read-replay-quarantine-receipts/:id/merge-queue-final-blocker-ledger', recordEvalMergeQueueFinalBlockerLedger);

const recordEvalMergeQueuePostLedgerOperatorReleaseAttestation = (req, res) => {
  try {
    const finalBlockerLedgerReceipt = portfolioOperatorInbox.getEvalMergeQueueFinalBlockerLedgerReceipt(cleanText(req.params.id));
    if (!finalBlockerLedgerReceipt) {
      res.status(404).json({ error: 'Merge queue final blocker ledger receipt not found' });
      return;
    }
    const releaseAttestationResult = runMergeQueuePostLedgerOperatorReleaseAttestationPacket({
      mergeQueueFinalBlockerLedgerReceiptId: finalBlockerLedgerReceipt.id,
      operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || 'local_operator',
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      attestationReasons: Array.isArray(req.body?.attestationReasons || req.body?.attestation_reasons)
        ? (req.body.attestationReasons || req.body.attestation_reasons)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueuePostLedgerOperatorReleaseAttestation({
      mergeQueueFinalBlockerLedgerReceiptId: finalBlockerLedgerReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || finalBlockerLedgerReceipt.live_merge_authorization_receipt_id,
      releaseAttestationKey: cleanText(req.body?.releaseAttestationKey || req.body?.release_attestation_key) || releaseAttestationResult.releaseAttestationKey,
      releaseAttestationKind: cleanText(req.body?.releaseAttestationKind || req.body?.release_attestation_kind) || releaseAttestationResult.releaseAttestationKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_operator_release_blocked_by_final_blocker_ledger',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_operator_release_blocked_by_final_blocker_ledger',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue post-ledger operator release attestation while final blockers remain sealed.',
      operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
      releaseAttestationResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-final-blocker-ledger-receipts/:id/post-ledger-operator-release-attestation', recordEvalMergeQueuePostLedgerOperatorReleaseAttestation);
app.post('/api/portfolio/eval-merge-queue-final-blocker-ledger-receipts/:id/merge-queue-post-ledger-operator-release-attestation', recordEvalMergeQueuePostLedgerOperatorReleaseAttestation);

const recordEvalMergeQueuePostAttestationReleaseEscrow = (req, res) => {
  try {
    const releaseAttestationReceipt = portfolioOperatorInbox.getEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt(cleanText(req.params.id));
    if (!releaseAttestationReceipt) {
      res.status(404).json({ error: 'Merge queue post-ledger operator release attestation receipt not found' });
      return;
    }
    const releaseEscrowResult = runMergeQueuePostAttestationReleaseEscrowPacket({
      mergeQueuePostLedgerOperatorReleaseAttestationReceiptId: releaseAttestationReceipt.id,
      operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || 'local_operator',
      runtimeSecretRef: cleanText(req.body?.runtimeSecretRef || req.body?.runtime_secret_ref) || null,
      requestMethod: cleanText(req.body?.requestMethod || req.body?.request_method) || null,
      releaseScope: cleanText(req.body?.releaseScope || req.body?.release_scope) || null,
      escrowReasons: Array.isArray(req.body?.escrowReasons || req.body?.escrow_reasons)
        ? (req.body.escrowReasons || req.body.escrow_reasons)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueuePostAttestationReleaseEscrow({
      mergeQueuePostLedgerOperatorReleaseAttestationReceiptId: releaseAttestationReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || releaseAttestationReceipt.live_merge_authorization_receipt_id,
      releaseEscrowKey: cleanText(req.body?.releaseEscrowKey || req.body?.release_escrow_key) || releaseEscrowResult.releaseEscrowKey,
      releaseEscrowKind: cleanText(req.body?.releaseEscrowKind || req.body?.release_escrow_kind) || releaseEscrowResult.releaseEscrowKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_post_attestation_release_escrow_held_by_final_blocker_ledger',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_post_attestation_release_escrow_held_by_final_blocker_ledger',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue post-attestation release escrow while operator release remains blocked.',
      operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
      releaseEscrowResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-post-ledger-operator-release-attestation-receipts/:id/post-attestation-release-escrow', recordEvalMergeQueuePostAttestationReleaseEscrow);
app.post('/api/portfolio/eval-merge-queue-post-ledger-operator-release-attestation-receipts/:id/merge-queue-post-attestation-release-escrow', recordEvalMergeQueuePostAttestationReleaseEscrow);

const recordEvalMergeQueueReleaseDenialCloseout = (req, res) => {
  try {
    const releaseEscrowReceipt = portfolioOperatorInbox.getEvalMergeQueuePostAttestationReleaseEscrowReceipt(cleanText(req.params.id));
    if (!releaseEscrowReceipt) {
      res.status(404).json({ error: 'Merge queue post-attestation release escrow receipt not found' });
      return;
    }
    const closeoutResult = runMergeQueueReleaseDenialCloseoutPacket({
      mergeQueuePostAttestationReleaseEscrowReceiptId: releaseEscrowReceipt.id,
      operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || 'local_operator',
      denialReasons: Array.isArray(req.body?.denialReasons || req.body?.denial_reasons)
        ? (req.body.denialReasons || req.body.denial_reasons)
        : null,
      remediationActions: Array.isArray(req.body?.remediationActions || req.body?.remediation_actions)
        ? (req.body.remediationActions || req.body.remediation_actions)
        : null,
      now: Date.now()
    });
    res.json(portfolioOperatorInbox.recordEvalMergeQueueReleaseDenialCloseout({
      mergeQueuePostAttestationReleaseEscrowReceiptId: releaseEscrowReceipt.id,
      liveMergeAuthorizationReceiptId: cleanText(req.body?.liveMergeAuthorizationReceiptId || req.body?.live_merge_authorization_receipt_id) || releaseEscrowReceipt.live_merge_authorization_receipt_id,
      closeoutKey: cleanText(req.body?.closeoutKey || req.body?.closeout_key) || closeoutResult.closeoutKey,
      closeoutKind: cleanText(req.body?.closeoutKind || req.body?.closeout_kind) || closeoutResult.closeoutKind,
      decision: cleanText(req.body?.decision) || 'merge_queue_release_denied_after_post_attestation_escrow',
      mode: cleanText(req.body?.mode) || 'dry_run',
      status: cleanText(req.body?.status) || 'merge_queue_release_denied_after_post_attestation_escrow',
      summary: cleanText(req.body?.summary) || 'Recorded merge-queue release denial closeout after post-attestation escrow stayed held.',
      operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
      closeoutResult,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
};

app.post('/api/portfolio/eval-merge-queue-post-attestation-release-escrow-receipts/:id/release-denial-closeout', recordEvalMergeQueueReleaseDenialCloseout);
app.post('/api/portfolio/eval-merge-queue-post-attestation-release-escrow-receipts/:id/merge-queue-release-denial-closeout', recordEvalMergeQueueReleaseDenialCloseout);

app.post('/api/portfolio/service-businesses/:id/operator-bulk-review', (req, res) => {
  res.json(portfolioOperatorInbox.recordBulkReview({
    serviceBusinessId: cleanText(req.params.id),
    roleKey: cleanText(req.body?.roleKey || req.body?.role_key) || null,
    itemIds: Array.isArray(req.body?.itemIds || req.body?.item_ids) ? (req.body.itemIds || req.body.item_ids) : null,
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    reviewKind: cleanText(req.body?.reviewKind || req.body?.review_kind) || 'bulk_review',
    decision: cleanText(req.body?.decision) || 'needs_review',
    mode: cleanText(req.body?.mode) || 'local_review',
    status: cleanText(req.body?.status) || 'recorded',
    summary: cleanText(req.body?.summary) || 'Recorded local operator bulk review.',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/acquisition-actions/:id/decide', (req, res) => {
  res.json(portfolioOperatingModel.decideAcquisitionAction({
    actionId: cleanText(req.params.id),
    status: cleanText(req.body?.status) || 'approved',
    reviewedBy: cleanText(req.body?.reviewedBy || req.body?.reviewed_by) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/acquisition-actions/:id/execute', (req, res) => {
  res.json(portfolioOperatingModel.executeAcquisitionAction({
    actionId: cleanText(req.params.id),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : null
  }));
});

app.post('/api/portfolio/acquisition-actions/:id/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackAcquisitionAction({
    actionId: cleanText(req.params.id),
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/acquisition-actions/:id/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightAcquisitionAction({
    actionId: cleanText(req.params.id),
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveExternalSpend: req.body?.allowLiveExternalSpend === true || req.body?.allow_live_external_spend === true,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/capital-allocation/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioCapitalAllocation({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    availableBudgetCents: Number(req.body?.availableBudgetCents ?? req.body?.available_budget_cents ?? 0),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/capital-allocation/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioCapitalAllocation({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    availableBudgetCents: Number(req.body?.availableBudgetCents ?? req.body?.available_budget_cents ?? 0),
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveCapitalAllocation: req.body?.allowLiveCapitalAllocation === true || req.body?.allow_live_capital_allocation === true,
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/capital-allocation/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioCapitalAllocation({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    availableBudgetCents: Number(req.body?.availableBudgetCents ?? req.body?.available_budget_cents ?? 0),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/capital-allocation/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioCapitalAllocation({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/provider-fallback/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioProviderFallback({
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    primaryProvider: cleanText(req.body?.primaryProvider || req.body?.primary_provider) || null,
    fallbackProvider: cleanText(req.body?.fallbackProvider || req.body?.fallback_provider) || 'operator_handoff',
    workflowKey: cleanText(req.body?.workflowKey || req.body?.workflow_key) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/provider-fallback/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioProviderFallback({
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    primaryProvider: cleanText(req.body?.primaryProvider || req.body?.primary_provider) || null,
    fallbackProvider: cleanText(req.body?.fallbackProvider || req.body?.fallback_provider) || 'operator_handoff',
    workflowKey: cleanText(req.body?.workflowKey || req.body?.workflow_key) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveFallback: req.body?.allowLiveFallback === true || req.body?.allow_live_fallback === true,
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/provider-fallback/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioProviderFallback({
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    primaryProvider: cleanText(req.body?.primaryProvider || req.body?.primary_provider) || null,
    fallbackProvider: cleanText(req.body?.fallbackProvider || req.body?.fallback_provider) || 'operator_handoff',
    workflowKey: cleanText(req.body?.workflowKey || req.body?.workflow_key) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/provider-fallback/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioProviderFallback({
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id),
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/dispatch/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioDispatch({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/dispatch/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioDispatch({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveDispatch: req.body?.allowLiveDispatch === true || req.body?.allow_live_dispatch === true,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/dispatch/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioDispatch({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/dispatch/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioDispatch({
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/job-tracking/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioJobTracking({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    trackingStage: cleanText(req.body?.trackingStage || req.body?.tracking_stage) || 'vendor_eta_photo_status',
    etaMinutes: Number(req.body?.etaMinutes ?? req.body?.eta_minutes ?? 90),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/job-tracking/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioJobTracking({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    trackingStage: cleanText(req.body?.trackingStage || req.body?.tracking_stage) || 'vendor_eta_photo_status',
    etaMinutes: Number(req.body?.etaMinutes ?? req.body?.eta_minutes ?? 90),
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveTracking: req.body?.allowLiveTracking === true || req.body?.allow_live_tracking === true,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/job-tracking/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioJobTracking({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    trackingStage: cleanText(req.body?.trackingStage || req.body?.tracking_stage) || 'vendor_eta_photo_status',
    etaMinutes: Number(req.body?.etaMinutes ?? req.body?.eta_minutes ?? 90),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/job-tracking/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioJobTracking({
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-update/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioCustomerUpdate({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    contactId: cleanText(req.body?.contactId || req.body?.contact_id) || null,
    channel: cleanText(req.body?.channel) || 'email',
    updateStage: cleanText(req.body?.updateStage || req.body?.update_stage) || 'status_update',
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/customer-update/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioCustomerUpdate({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    contactId: cleanText(req.body?.contactId || req.body?.contact_id) || null,
    channel: cleanText(req.body?.channel) || 'email',
    updateStage: cleanText(req.body?.updateStage || req.body?.update_stage) || 'status_update',
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveCustomerUpdate: req.body?.allowLiveCustomerUpdate === true || req.body?.allow_live_customer_update === true,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-update/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioCustomerUpdate({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    contactId: cleanText(req.body?.contactId || req.body?.contact_id) || null,
    channel: cleanText(req.body?.channel) || 'email',
    updateStage: cleanText(req.body?.updateStage || req.body?.update_stage) || 'status_update',
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/customer-update/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioCustomerUpdate({
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/repeat-work/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioRepeatWorkScheduling({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    contactId: cleanText(req.body?.contactId || req.body?.contact_id) || null,
    repeatWorkKind: cleanText(req.body?.repeatWorkKind || req.body?.repeat_work_kind) || 'maintenance_followup',
    cadenceDays: Number(req.body?.cadenceDays ?? req.body?.cadence_days ?? 90),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/repeat-work/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioRepeatWorkScheduling({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    contactId: cleanText(req.body?.contactId || req.body?.contact_id) || null,
    repeatWorkKind: cleanText(req.body?.repeatWorkKind || req.body?.repeat_work_kind) || 'maintenance_followup',
    cadenceDays: Number(req.body?.cadenceDays ?? req.body?.cadence_days ?? 90),
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveRepeatWork: req.body?.allowLiveRepeatWork === true || req.body?.allow_live_repeat_work === true,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/repeat-work/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioRepeatWorkScheduling({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    contactId: cleanText(req.body?.contactId || req.body?.contact_id) || null,
    repeatWorkKind: cleanText(req.body?.repeatWorkKind || req.body?.repeat_work_kind) || 'maintenance_followup',
    cadenceDays: Number(req.body?.cadenceDays ?? req.body?.cadence_days ?? 90),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/repeat-work/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioRepeatWorkScheduling({
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/payout-settlement/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioPayoutSettlement({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    paymentId: cleanText(req.body?.paymentId || req.body?.payment_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/payout-settlement/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioPayoutSettlement({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    paymentId: cleanText(req.body?.paymentId || req.body?.payment_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveSettlement: req.body?.allowLiveSettlement === true || req.body?.allow_live_settlement === true,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/payout-settlement/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioPayoutSettlement({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    paymentId: cleanText(req.body?.paymentId || req.body?.payment_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/payout-settlement/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioPayoutSettlement({
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/refund-dispute/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioRefundDispute({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    paymentId: cleanText(req.body?.paymentId || req.body?.payment_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    caseType: cleanText(req.body?.caseType || req.body?.case_type) || 'refund_review',
    decision: cleanText(req.body?.decision) || 'review_required',
    amountCents: req.body?.amountCents === undefined && req.body?.amount_cents === undefined ? null : Number(req.body?.amountCents ?? req.body?.amount_cents),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/refund-dispute/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioRefundDispute({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    paymentId: cleanText(req.body?.paymentId || req.body?.payment_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    caseType: cleanText(req.body?.caseType || req.body?.case_type) || 'refund_review',
    decision: cleanText(req.body?.decision) || 'review_required',
    amountCents: req.body?.amountCents === undefined && req.body?.amount_cents === undefined ? null : Number(req.body?.amountCents ?? req.body?.amount_cents),
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveRefund: req.body?.allowLiveRefund === true || req.body?.allow_live_refund === true,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/refund-dispute/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioRefundDispute({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    paymentId: cleanText(req.body?.paymentId || req.body?.payment_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    caseType: cleanText(req.body?.caseType || req.body?.case_type) || 'refund_review',
    decision: cleanText(req.body?.decision) || 'review_required',
    amountCents: req.body?.amountCents === undefined && req.body?.amount_cents === undefined ? null : Number(req.body?.amountCents ?? req.body?.amount_cents),
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/refund-dispute/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioRefundDispute({
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/vendor-quality/plan', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioVendorQualityRouting({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    backupVendorId: cleanText(req.body?.backupVendorId || req.body?.backup_vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    mode: 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/vendor-quality/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightPortfolioVendorQualityRouting({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    backupVendorId: cleanText(req.body?.backupVendorId || req.body?.backup_vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    allowLiveVendorRouting: req.body?.allowLiveVendorRouting === true || req.body?.allow_live_vendor_routing === true,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/vendor-quality/execute', (req, res) => {
  res.json(portfolioOperatingModel.executePortfolioVendorQualityRouting({
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    taskId: cleanText(req.body?.taskId || req.body?.task_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    backupVendorId: cleanText(req.body?.backupVendorId || req.body?.backup_vendor_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}
  }));
});

app.post('/api/portfolio/vendor-quality/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackPortfolioVendorQualityRouting({
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-feedback', (req, res) => {
  res.json(portfolioOperatingModel.recordCustomerFeedback({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    customerId: cleanText(req.body?.customerId || req.body?.customer_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    completionReceiptId: cleanText(req.body?.completionReceiptId || req.body?.completion_receipt_id) || null,
    reviewRequestReceiptId: cleanText(req.body?.reviewRequestReceiptId || req.body?.review_request_receipt_id) || null,
    feedbackKind: cleanText(req.body?.feedbackKind || req.body?.feedback_kind) || 'completion_acceptance',
    channel: cleanText(req.body?.channel) || 'customer_portal',
    status: cleanText(req.body?.status) || 'recorded',
    rating: req.body?.rating === undefined || req.body?.rating === null ? null : Number(req.body.rating),
    sentiment: cleanText(req.body?.sentiment) || null,
    publicReviewIntent: cleanText(req.body?.publicReviewIntent || req.body?.public_review_intent) || 'none',
    summary: cleanText(req.body?.summary) || null,
    response: req.body?.response && typeof req.body.response === 'object' ? req.body.response : {},
    praise: Array.isArray(req.body?.praise) ? req.body.praise : [],
    issues: Array.isArray(req.body?.issues) ? req.body.issues : [],
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-remediation/plans', (req, res) => {
  res.json(portfolioOperatingModel.planCustomerRemediation({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    feedbackRecordId: cleanText(req.body?.feedbackRecordId || req.body?.feedback_record_id) || null,
    remediationKind: cleanText(req.body?.remediationKind || req.body?.remediation_kind) || 'warranty_recovery',
    priority: cleanText(req.body?.priority) || null,
    severity: cleanText(req.body?.severity) || null,
    status: cleanText(req.body?.status) || 'planned',
    summary: cleanText(req.body?.summary) || null,
    actionPlan: req.body?.actionPlan && typeof req.body.actionPlan === 'object'
      ? req.body.actionPlan
      : (req.body?.action_plan && typeof req.body.action_plan === 'object' ? req.body.action_plan : {}),
    estimatedCostCents: req.body?.estimatedCostCents === undefined && req.body?.estimated_cost_cents === undefined
      ? 0
      : Number(req.body?.estimatedCostCents ?? req.body?.estimated_cost_cents),
    dueAt: req.body?.dueAt === undefined && req.body?.due_at === undefined ? null : Number(req.body?.dueAt ?? req.body?.due_at),
    refundDisputeReceiptId: cleanText(req.body?.refundDisputeReceiptId || req.body?.refund_dispute_receipt_id) || null,
    vendorQualityReceiptId: cleanText(req.body?.vendorQualityReceiptId || req.body?.vendor_quality_receipt_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/vendor-corrective-actions', (req, res) => {
  res.json(portfolioOperatingModel.planVendorCorrectiveAction({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    remediationPlanId: cleanText(req.body?.remediationPlanId || req.body?.remediation_plan_id) || null,
    vendorId: cleanText(req.body?.vendorId || req.body?.vendor_id) || null,
    vendorQualityReceiptId: cleanText(req.body?.vendorQualityReceiptId || req.body?.vendor_quality_receipt_id) || null,
    actionKind: cleanText(req.body?.actionKind || req.body?.action_kind) || 'quality_coaching',
    priority: cleanText(req.body?.priority) || null,
    status: cleanText(req.body?.status) || 'planned',
    summary: cleanText(req.body?.summary) || null,
    correctiveAction: req.body?.correctiveAction && typeof req.body.correctiveAction === 'object'
      ? req.body.correctiveAction
      : (req.body?.corrective_action && typeof req.body.corrective_action === 'object' ? req.body.corrective_action : {}),
    dueAt: req.body?.dueAt === undefined && req.body?.due_at === undefined ? null : Number(req.body?.dueAt ?? req.body?.due_at),
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/remediation-budget/reserves', (req, res) => {
  res.json(portfolioOperatingModel.reserveRemediationBudget({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    remediationPlanId: cleanText(req.body?.remediationPlanId || req.body?.remediation_plan_id) || null,
    vendorCorrectiveActionId: cleanText(req.body?.vendorCorrectiveActionId || req.body?.vendor_corrective_action_id) || null,
    financeRollupId: cleanText(req.body?.financeRollupId || req.body?.finance_rollup_id) || null,
    reserveKind: cleanText(req.body?.reserveKind || req.body?.reserve_kind) || 'warranty_recovery_liability',
    status: cleanText(req.body?.status) || 'reserved',
    amountCents: req.body?.amountCents === undefined && req.body?.amount_cents === undefined ? null : Number(req.body?.amountCents ?? req.body?.amount_cents),
    probability: req.body?.probability === undefined ? undefined : Number(req.body.probability),
    priority: cleanText(req.body?.priority) || null,
    summary: cleanText(req.body?.summary) || null,
    reserve: req.body?.reserve && typeof req.body.reserve === 'object' ? req.body.reserve : {},
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/remediation-budget/closeouts', (req, res) => {
  res.json(portfolioOperatingModel.closeRemediationReserve({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    reserveId: cleanText(req.body?.reserveId || req.body?.reserve_id) || null,
    closeoutKind: cleanText(req.body?.closeoutKind || req.body?.closeout_kind) || 'warranty_recovery_closeout',
    status: cleanText(req.body?.status) || 'closed_local',
    actualCostCents: req.body?.actualCostCents === undefined && req.body?.actual_cost_cents === undefined ? 0 : Number(req.body?.actualCostCents ?? req.body?.actual_cost_cents),
    retainedRevenueCents: req.body?.retainedRevenueCents === undefined && req.body?.retained_revenue_cents === undefined ? 0 : Number(req.body?.retainedRevenueCents ?? req.body?.retained_revenue_cents),
    churnRiskDelta: req.body?.churnRiskDelta === undefined && req.body?.churn_risk_delta === undefined ? 0 : Number(req.body?.churnRiskDelta ?? req.body?.churn_risk_delta),
    retentionStatus: cleanText(req.body?.retentionStatus || req.body?.retention_status) || 'watch',
    summary: cleanText(req.body?.summary) || null,
    closeout: req.body?.closeout && typeof req.body.closeout === 'object' ? req.body.closeout : {},
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-retention-playbooks', (req, res) => {
  res.json(portfolioOperatingModel.planCustomerRetentionPlaybook({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    closeoutReceiptId: cleanText(req.body?.closeoutReceiptId || req.body?.closeout_receipt_id) || null,
    renewalCloseoutPacketId: cleanText(req.body?.renewalCloseoutPacketId || req.body?.renewal_closeout_packet_id) || null,
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    customerId: cleanText(req.body?.customerId || req.body?.customer_id) || null,
    jobId: cleanText(req.body?.jobId || req.body?.job_id) || null,
    offerBundleId: cleanText(req.body?.offerBundleId || req.body?.offer_bundle_id) || null,
    financeRollupId: cleanText(req.body?.financeRollupId || req.body?.finance_rollup_id) || null,
    playbookKind: cleanText(req.body?.playbookKind || req.body?.playbook_kind) || null,
    status: cleanText(req.body?.status) || 'planned',
    priority: cleanText(req.body?.priority) || null,
    retentionStatus: cleanText(req.body?.retentionStatus || req.body?.retention_status) || null,
    churnRisk: req.body?.churnRisk === undefined && req.body?.churn_risk === undefined ? null : Number(req.body?.churnRisk ?? req.body?.churn_risk),
    expectedRetainedRevenueCents: req.body?.expectedRetainedRevenueCents === undefined && req.body?.expected_retained_revenue_cents === undefined ? null : Number(req.body?.expectedRetainedRevenueCents ?? req.body?.expected_retained_revenue_cents),
    recommendedOfferKey: cleanText(req.body?.recommendedOfferKey || req.body?.recommended_offer_key) || null,
    summary: cleanText(req.body?.summary) || null,
    playbook: req.body?.playbook && typeof req.body.playbook === 'object' ? req.body.playbook : {},
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-retention-playbooks/:id/plan-execution', (req, res) => {
  res.json(portfolioOperatingModel.planCustomerRetentionPlaybookExecution({
    playbookId: cleanText(req.params.id),
    channel: cleanText(req.body?.channel) || 'operator_portal',
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-retention-playbooks/:id/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightCustomerRetentionPlaybookExecution({
    playbookId: cleanText(req.params.id),
    channel: cleanText(req.body?.channel) || 'operator_portal',
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-retention-playbooks/:id/execute', (req, res) => {
  res.json(portfolioOperatingModel.executeCustomerRetentionPlaybook({
    playbookId: cleanText(req.params.id),
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    channel: cleanText(req.body?.channel) || 'operator_portal',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/customer-retention-playbooks/:id/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackCustomerRetentionPlaybookExecution({
    playbookId: cleanText(req.params.id),
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    channel: cleanText(req.body?.channel) || 'operator_portal',
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/retention-cohorts/analyze', (req, res) => {
  res.json(portfolioOperatingModel.analyzeRetentionCohorts({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    cohortKey: cleanText(req.body?.cohortKey || req.body?.cohort_key) || 'post_remediation_retention',
    segment: cleanText(req.body?.segment) || 'all',
    status: cleanText(req.body?.status) || 'analyzed',
    summary: cleanText(req.body?.summary) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.get('/api/portfolio/customer-retention-playbooks', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const playbooks = filterRetentionPlaybooks(snapshot.customerRetentionPlaybooks || [], filters).slice(0, limit);
  res.json(retentionReadEnvelope(snapshot, {
    kind: 'customer_retention_playbook_list',
    filters,
    count: playbooks.length,
    playbooks
  }));
});

app.get('/api/portfolio/customer-retention-playbooks/:id/receipts', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const playbookId = cleanText(req.params.id);
  const playbook = (snapshot.customerRetentionPlaybooks || []).find((item) => item.id === playbookId) || null;
  if (!playbook) return res.status(404).json({ ok: false, code: 'RETENTION_PLAYBOOK_NOT_FOUND', id: playbookId });
  const receipts = filterRetentionPlaybookReceipts(snapshot.customerRetentionPlaybookReceipts || [], {
    ...filters,
    retentionPlaybookId: playbook.id
  }).slice(0, limit);
  return res.json(retentionReadEnvelope(snapshot, {
    kind: 'customer_retention_playbook_receipt_list',
    filters: { ...filters, retentionPlaybookId: playbook.id },
    playbook,
    count: receipts.length,
    receipts
  }));
});

app.get('/api/portfolio/customer-retention-playbooks/:id', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const playbookId = cleanText(req.params.id);
  const playbook = (snapshot.customerRetentionPlaybooks || []).find((item) => item.id === playbookId) || null;
  if (!playbook) return res.status(404).json({ ok: false, code: 'RETENTION_PLAYBOOK_NOT_FOUND', id: playbookId });
  const receipts = filterRetentionPlaybookReceipts(snapshot.customerRetentionPlaybookReceipts || [], {
    ...filters,
    retentionPlaybookId: playbook.id
  }).slice(0, limit);
  return res.json(retentionReadEnvelope(snapshot, {
    kind: 'customer_retention_playbook_detail',
    filters: { ...filters, retentionPlaybookId: playbook.id },
    playbook,
    receiptCount: receipts.length,
    receipts
  }));
});

app.get('/api/portfolio/retention-cohorts', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const rollups = filterRetentionCohortRollups(snapshot.retentionCohortRollups || [], filters).slice(0, limit);
  const rollupIds = new Set(rollups.map((item) => item.id));
  const commandCenter = (snapshot.retentionCohortCommandCenter || [])
    .filter((item) => rollupIds.has(item.retentionCohortRollupId))
    .slice(0, limit);
  res.json(retentionReadEnvelope(snapshot, {
    kind: 'retention_cohort_rollup_list',
    filters,
    count: rollups.length,
    rollups,
    commandCenter
  }));
});

app.get('/api/portfolio/retention-cohorts/:id', (req, res) => {
  const { snapshot, filters } = retentionReadSnapshot(req);
  const rollupId = cleanText(req.params.id);
  const rollup = (snapshot.retentionCohortRollups || []).find((item) => item.id === rollupId) || null;
  if (!rollup) return res.status(404).json({ ok: false, code: 'RETENTION_COHORT_ROLLUP_NOT_FOUND', id: rollupId });
  const commandCenter = (snapshot.retentionCohortCommandCenter || [])
    .find((item) => item.retentionCohortRollupId === rollup.id) || null;
  return res.json(retentionReadEnvelope(snapshot, {
    kind: 'retention_cohort_rollup_detail',
    filters: { ...filters, retentionCohortRollupId: rollup.id },
    rollup,
    commandCenter
  }));
});

app.get('/api/portfolio/retention-command-center', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const items = filterRetentionCommandCenter(snapshot.retentionCohortCommandCenter || [], filters).slice(0, limit);
  res.json(retentionReadEnvelope(snapshot, {
    kind: 'retention_command_center_list',
    filters,
    count: items.length,
    items
  }));
});

app.get('/api/portfolio/retention-command-center/:id', (req, res) => {
  const { snapshot, filters } = retentionReadSnapshot(req);
  const commandId = cleanText(req.params.id);
  const item = (snapshot.retentionCohortCommandCenter || [])
    .find((entry) => entry.id === commandId || entry.retentionCohortRollupId === commandId) || null;
  if (!item) return res.status(404).json({ ok: false, code: 'RETENTION_COMMAND_CENTER_NOT_FOUND', id: commandId });
  return res.json(retentionReadEnvelope(snapshot, {
    kind: 'retention_command_center_detail',
    filters: { ...filters, retentionCohortRollupId: item.retentionCohortRollupId },
    item
  }));
});

app.post('/api/portfolio/retention-command-center/:id/work-items', (req, res) => {
  res.json(portfolioOperatingModel.recordRetentionCommandWorkItems({
    retentionCohortRollupId: cleanText(req.params.id),
    blockerKeys: Array.isArray(req.body?.blockerKeys) ? req.body.blockerKeys : (Array.isArray(req.body?.blocker_keys) ? req.body.blocker_keys : null),
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/retention-command-center/:id/proof-packet', (req, res) => {
  res.json(portfolioOperatingModel.collectRetentionCommandWorkItemProofPacket({
    retentionCohortRollupId: cleanText(req.params.id),
    retentionCommandWorkItemReceiptId: cleanText(req.body?.retentionCommandWorkItemReceiptId || req.body?.retention_command_work_item_receipt_id) || null,
    actor: cleanText(req.body?.actor) || 'operator'
  }));
});

app.post('/api/portfolio/retention-capital-feedback', (req, res) => {
  res.json(portfolioOperatingModel.recordRetentionCapitalFeedback({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    retentionCohortRollupId: cleanText(req.body?.retentionCohortRollupId || req.body?.retention_cohort_rollup_id) || null,
    capitalAllocationReceiptId: cleanText(req.body?.capitalAllocationReceiptId || req.body?.capital_allocation_receipt_id) || null,
    strategyRecommendationId: cleanText(req.body?.strategyRecommendationId || req.body?.strategy_recommendation_id) || null,
    feedbackKind: cleanText(req.body?.feedbackKind || req.body?.feedback_kind) || 'retention_value_capital_signal',
    suggestedBudgetCents: req.body?.suggestedBudgetCents === undefined && req.body?.suggested_budget_cents === undefined ? null : Number(req.body?.suggestedBudgetCents ?? req.body?.suggested_budget_cents),
    priority: cleanText(req.body?.priority) || null,
    recommendation: cleanText(req.body?.recommendation) || null,
    summary: cleanText(req.body?.summary) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/service-decision-fusion', (req, res) => {
  res.json(portfolioOperatingModel.recordServiceDecisionFusion({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || 'ws_callan',
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    strategyRecommendationId: cleanText(req.body?.strategyRecommendationId || req.body?.strategy_recommendation_id) || null,
    financeRollupId: cleanText(req.body?.financeRollupId || req.body?.finance_rollup_id) || null,
    retentionCapitalFeedbackReceiptId: cleanText(req.body?.retentionCapitalFeedbackReceiptId || req.body?.retention_capital_feedback_receipt_id) || null,
    capitalAllocationReceiptId: cleanText(req.body?.capitalAllocationReceiptId || req.body?.capital_allocation_receipt_id) || null,
    vendorQualityReceiptId: cleanText(req.body?.vendorQualityReceiptId || req.body?.vendor_quality_receipt_id) || null,
    remediationCloseoutReceiptId: cleanText(req.body?.remediationCloseoutReceiptId || req.body?.remediation_closeout_receipt_id) || null,
    decisionKind: cleanText(req.body?.decisionKind || req.body?.decision_kind) || 'board_level_service_decision',
    status: cleanText(req.body?.status) || 'proposed',
    decision: cleanText(req.body?.decision) || null,
    priority: cleanText(req.body?.priority) || null,
    recommendedBudgetCents: req.body?.recommendedBudgetCents === undefined && req.body?.recommended_budget_cents === undefined ? null : Number(req.body?.recommendedBudgetCents ?? req.body?.recommended_budget_cents),
    summary: cleanText(req.body?.summary) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/service-decision-fusion/:id/plan-execution', (req, res) => {
  res.json(portfolioOperatingModel.planServiceDecisionFusionExecution({
    decisionFusionReceiptId: cleanText(req.params.id),
    executionKind: cleanText(req.body?.executionKind || req.body?.execution_kind) || 'board_decision_execution',
    executionScope: cleanText(req.body?.executionScope || req.body?.execution_scope) || 'service_scale_guardrails',
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/service-decision-fusion/:id/preflight-live', (req, res) => {
  res.json(portfolioOperatingModel.preflightServiceDecisionFusionExecution({
    decisionFusionReceiptId: cleanText(req.params.id),
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    executionKind: cleanText(req.body?.executionKind || req.body?.execution_kind) || 'board_decision_execution',
    executionScope: cleanText(req.body?.executionScope || req.body?.execution_scope) || 'service_scale_guardrails',
    allowLiveBoardDecisionExecution: req.body?.allowLiveBoardDecisionExecution === true || req.body?.allow_live_board_decision_execution === true,
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/service-decision-fusion/:id/execute', (req, res) => {
  res.json(portfolioOperatingModel.executeServiceDecisionFusion({
    decisionFusionReceiptId: cleanText(req.params.id),
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    executionKind: cleanText(req.body?.executionKind || req.body?.execution_kind) || 'board_decision_execution',
    executionScope: cleanText(req.body?.executionScope || req.body?.execution_scope) || 'service_scale_guardrails',
    mode: cleanText(req.body?.mode || req.body?.executionMode || req.body?.execution_mode) || 'dry_run',
    allowLiveBoardDecisionExecution: req.body?.allowLiveBoardDecisionExecution === true || req.body?.allow_live_board_decision_execution === true,
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/service-decision-fusion/:id/rollback', (req, res) => {
  res.json(portfolioOperatingModel.rollbackServiceDecisionFusionExecution({
    decisionFusionReceiptId: cleanText(req.params.id),
    receiptId: cleanText(req.body?.receiptId || req.body?.receipt_id) || null,
    executionKind: cleanText(req.body?.executionKind || req.body?.execution_kind) || 'board_decision_execution',
    executionScope: cleanText(req.body?.executionScope || req.body?.execution_scope) || 'service_scale_guardrails',
    actor: cleanText(req.body?.actor) || 'operator',
    reason: cleanText(req.body?.reason) || 'operator_requested_rollback',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/service-decision-executions/:id/work-items', (req, res) => {
  res.json(portfolioOperatingModel.distributeServiceDecisionWorkItems({
    serviceDecisionExecutionReceiptId: cleanText(req.params.id),
    distributionKind: cleanText(req.body?.distributionKind || req.body?.distribution_kind) || 'operator_work_item_distribution',
    status: cleanText(req.body?.status) || 'queued',
    priority: cleanText(req.body?.priority) || 'high',
    actor: cleanText(req.body?.actor) || 'operator',
    workItems: Array.isArray(req.body?.workItems) ? req.body.workItems : (Array.isArray(req.body?.work_items) ? req.body.work_items : null),
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
    dueAt: req.body?.dueAt === undefined && req.body?.due_at === undefined ? null : Number(req.body?.dueAt ?? req.body?.due_at)
  }));
});

app.get('/api/portfolio/retention-capital-feedback', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receipts = filterRetentionCapitalFeedbackReceipts(snapshot.retentionCapitalFeedbackReceipts || [], filters).slice(0, limit);
  res.json(decisionReadEnvelope(snapshot, {
    kind: 'retention_capital_feedback_list',
    filters,
    count: receipts.length,
    receipts
  }));
});

app.get('/api/portfolio/retention-capital-feedback/:id', (req, res) => {
  const { snapshot, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = (snapshot.retentionCapitalFeedbackReceipts || []).find((item) => item.id === receiptId) || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'RETENTION_CAPITAL_FEEDBACK_NOT_FOUND', id: receiptId });
  const cohortRollup = (snapshot.retentionCohortRollups || []).find((item) => item.id === receipt.retention_cohort_rollup_id) || null;
  const serviceDecisions = filterServiceDecisionFusionReceipts(snapshot.serviceDecisionFusionReceipts || [], {
    ...filters,
    retentionCapitalFeedbackReceiptId: receipt.id
  });
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'retention_capital_feedback_detail',
    filters: { ...filters, retentionCapitalFeedbackReceiptId: receipt.id },
    receipt,
    cohortRollup,
    serviceDecisionCount: serviceDecisions.length,
    serviceDecisions
  }));
});

app.get('/api/portfolio/service-decision-fusion', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receipts = filterServiceDecisionFusionReceipts(snapshot.serviceDecisionFusionReceipts || [], filters).slice(0, limit);
  res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_fusion_list',
    filters,
    count: receipts.length,
    receipts
  }));
});

app.get('/api/portfolio/service-decision-fusion/:id', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = (snapshot.serviceDecisionFusionReceipts || []).find((item) => item.id === receiptId) || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'SERVICE_DECISION_FUSION_NOT_FOUND', id: receiptId });
  const executionReceipts = filterServiceDecisionExecutionReceipts(snapshot.serviceDecisionExecutionReceipts || [], {
    ...filters,
    serviceDecisionFusionReceiptId: receipt.id
  }).slice(0, limit);
  const executionIds = new Set(executionReceipts.map((item) => item.id));
  const liveExecuteDenials = filterServiceDecisionLiveExecuteDenials(snapshot.serviceDecisionLiveExecuteDenials || [], {
    ...filters,
    serviceDecisionFusionReceiptId: receipt.id
  }).slice(0, limit);
  const distributions = (snapshot.decisionDistributionReceipts || [])
    .filter((item) => executionIds.has(item.service_decision_execution_receipt_id))
    .slice(0, limit);
  const workItems = (snapshot.decisionWorkItems || [])
    .filter((item) => executionIds.has(item.service_decision_execution_receipt_id))
    .slice(0, limit);
  const workItemIds = new Set(workItems.map((item) => item.id));
  const workItemReceipts = (snapshot.decisionWorkItemReceipts || [])
    .filter((item) => workItemIds.has(item.decision_work_item_id))
    .slice(0, limit);
  const readinessEvidence = (snapshot.liveReadinessEvidenceArtifacts || [])
    .filter((item) => executionIds.has(item.service_decision_execution_receipt_id))
    .slice(0, limit);
  const liveAdapterReceipts = (snapshot.liveAdapterReceipts || [])
    .filter((item) => executionIds.has(item.service_decision_execution_receipt_id))
    .slice(0, limit);
  const compensationPlans = (snapshot.workflowCompensationPlans || [])
    .filter((item) => executionIds.has(item.service_decision_execution_receipt_id))
    .slice(0, limit);
  const compensationReceipts = (snapshot.workflowCompensationReceipts || [])
    .filter((item) => executionIds.has(item.service_decision_execution_receipt_id))
    .slice(0, limit);
  const readinessReconciliations = (snapshot.serviceDecisionReadinessReconciliations || [])
    .filter((item) => executionIds.has(item.service_decision_execution_receipt_id))
    .slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_fusion_detail',
    filters: { ...filters, serviceDecisionFusionReceiptId: receipt.id },
    receipt,
    executionReceiptCount: executionReceipts.length,
    executionReceipts,
    liveExecuteDenialCount: liveExecuteDenials.length,
    liveExecuteDenials,
    distributions,
    workItems,
    workItemReceipts,
    readinessEvidence,
    liveAdapterReceipts,
    compensationPlans,
    compensationReceipts,
    readinessReconciliations
  }));
});

app.get('/api/portfolio/service-decision-executions', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receipts = filterServiceDecisionExecutionReceipts(snapshot.serviceDecisionExecutionReceipts || [], filters).slice(0, limit);
  res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_execution_list',
    filters,
    count: receipts.length,
    receipts
  }));
});

app.get('/api/portfolio/service-decision-live-execute-denials', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const denials = filterServiceDecisionLiveExecuteDenials(snapshot.serviceDecisionLiveExecuteDenials || [], filters).slice(0, limit);
  res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_live_execute_denial_list',
    filters,
    count: denials.length,
    denials
  }));
});

app.get('/api/portfolio/service-decision-live-execute-denial-incidents', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const denials = filterServiceDecisionLiveExecuteDenials(snapshot.serviceDecisionLiveExecuteDenials || [], filters);
  const incidents = aggregateServiceDecisionLiveExecuteDenialIncidents(denials).slice(0, limit);
  res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_live_execute_denial_incident_rollup',
    filters,
    count: incidents.length,
    deniedAttemptCount: denials.length,
    incidents
  }));
});

app.get('/api/portfolio/service-decision-executions/:id', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = (snapshot.serviceDecisionExecutionReceipts || []).find((item) => item.id === receiptId) || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'SERVICE_DECISION_EXECUTION_NOT_FOUND', id: receiptId });
  const fusion = (snapshot.serviceDecisionFusionReceipts || []).find((item) => item.id === receipt.service_decision_fusion_receipt_id) || null;
  const distributions = filterDecisionDistributionReceipts(snapshot.decisionDistributionReceipts || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const workItems = filterDecisionWorkItems(snapshot.decisionWorkItems || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const workItemIds = new Set(workItems.map((item) => item.id));
  const workItemReceipts = (snapshot.decisionWorkItemReceipts || [])
    .filter((item) => workItemIds.has(item.decision_work_item_id))
    .slice(0, limit);
  const readinessEvidence = (snapshot.liveReadinessEvidenceArtifacts || [])
    .filter((item) => item.service_decision_execution_receipt_id === receipt.id)
    .slice(0, limit);
  const liveAdapterReceipts = (snapshot.liveAdapterReceipts || [])
    .filter((item) => item.service_decision_execution_receipt_id === receipt.id)
    .slice(0, limit);
  const readinessEvidenceReviewReceipts = filterReadinessEvidenceReviewReceipts(snapshot.readinessEvidenceReviewReceipts || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const readinessReleasePreflightReceipts = filterReadinessReleasePreflightReceipts(snapshot.readinessReleasePreflightReceipts || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const liveExecuteDenials = filterServiceDecisionLiveExecuteDenials(snapshot.serviceDecisionLiveExecuteDenials || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const compensationPlans = filterWorkflowCompensationPlans(snapshot.workflowCompensationPlans || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const compensationReceipts = filterWorkflowCompensationReceipts(snapshot.workflowCompensationReceipts || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const readinessReconciliations = filterServiceDecisionReadinessReconciliations(snapshot.serviceDecisionReadinessReconciliations || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const readinessCommands = filterReadinessCommandCenter(snapshot.readinessCommandCenter || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_execution_detail',
    filters: { ...filters, serviceDecisionExecutionReceiptId: receipt.id },
    receipt,
    fusion,
    distributionCount: distributions.length,
    distributions,
    workItemCount: workItems.length,
    workItems,
    workItemReceipts,
    readinessEvidenceCount: readinessEvidence.length,
    readinessEvidence,
    liveAdapterReceiptCount: liveAdapterReceipts.length,
    liveAdapterReceipts,
    readinessEvidenceReviewReceiptCount: readinessEvidenceReviewReceipts.length,
    readinessEvidenceReviewReceipts,
    readinessReleasePreflightReceiptCount: readinessReleasePreflightReceipts.length,
    readinessReleasePreflightReceipts,
    liveExecuteDenialCount: liveExecuteDenials.length,
    liveExecuteDenials,
    compensationPlanCount: compensationPlans.length,
    compensationPlans,
    compensationReceiptCount: compensationReceipts.length,
    compensationReceipts,
    readinessReconciliationCount: readinessReconciliations.length,
    readinessReconciliations,
    readinessCommandCount: readinessCommands.length,
    readinessCommands
  }));
});

app.get('/api/portfolio/service-decision-executions/:id/distributions', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = (snapshot.serviceDecisionExecutionReceipts || []).find((item) => item.id === receiptId) || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'SERVICE_DECISION_EXECUTION_NOT_FOUND', id: receiptId });
  const distributions = filterDecisionDistributionReceipts(snapshot.decisionDistributionReceipts || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_distribution_list',
    filters: { ...filters, serviceDecisionExecutionReceiptId: receipt.id },
    execution: receipt,
    count: distributions.length,
    distributions
  }));
});

app.get('/api/portfolio/service-decision-executions/:id/work-items', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = (snapshot.serviceDecisionExecutionReceipts || []).find((item) => item.id === receiptId) || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'SERVICE_DECISION_EXECUTION_NOT_FOUND', id: receiptId });
  const workItems = filterDecisionWorkItems(snapshot.decisionWorkItems || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  const workItemIds = new Set(workItems.map((item) => item.id));
  const workItemReceipts = (snapshot.decisionWorkItemReceipts || [])
    .filter((item) => workItemIds.has(item.decision_work_item_id))
    .slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_work_item_list',
    filters: { ...filters, serviceDecisionExecutionReceiptId: receipt.id },
    execution: receipt,
    count: workItems.length,
    workItems,
    workItemReceipts
  }));
});

app.get('/api/portfolio/service-decision-executions/:id/proof-packet', (req, res) => {
  const { snapshot, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = (snapshot.serviceDecisionExecutionReceipts || []).find((item) => item.id === receiptId) || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'SERVICE_DECISION_EXECUTION_NOT_FOUND', id: receiptId });
  const proofPacket = portfolioOperatingModel.collectDecisionWorkItemProof({
    serviceDecisionExecutionReceiptId: receipt.id
  });
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_execution_proof_packet',
    filters: { ...filters, serviceDecisionExecutionReceiptId: receipt.id },
    execution: receipt,
    proofPacket
  }));
});

app.get('/api/portfolio/service-decision-executions/:id/live-execute-denials', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = (snapshot.serviceDecisionExecutionReceipts || []).find((item) => item.id === receiptId) || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'SERVICE_DECISION_EXECUTION_NOT_FOUND', id: receiptId });
  const denials = filterServiceDecisionLiveExecuteDenials(snapshot.serviceDecisionLiveExecuteDenials || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: receipt.id
  }).slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_live_execute_denial_list',
    filters: { ...filters, serviceDecisionExecutionReceiptId: receipt.id },
    execution: receipt,
    count: denials.length,
    denials
  }));
});

app.get('/api/portfolio/decision-distributions/:id/proof-packet', (req, res) => {
  const { snapshot, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = (snapshot.decisionDistributionReceipts || []).find((item) => item.id === receiptId) || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'DECISION_DISTRIBUTION_NOT_FOUND', id: receiptId });
  const proofPacket = portfolioOperatingModel.collectDecisionWorkItemProof({
    decisionDistributionReceiptId: receipt.id
  });
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'decision_distribution_proof_packet',
    filters: { ...filters, decisionDistributionReceiptId: receipt.id },
    distribution: receipt,
    proofPacket
  }));
});

app.get('/api/portfolio/readiness-command-center', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const commands = filterReadinessCommandCenter(snapshot.readinessCommandCenter || [], filters).slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_readiness_command_center_list',
    filters,
    count: commands.length,
    commands
  }));
});

app.get('/api/portfolio/readiness-command-center/live-release-blockers', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const queueFilters = liveReleaseBlockerQueueFilters(req.query, filters);
  const blockedCommands = filterReadinessCommandCenter(snapshot.readinessCommandCenter || [], queueFilters)
    .filter((command) => command.liveReleaseBlockerDigest?.releasePreflightBlocked === true);
  const commands = blockedCommands
    .filter((command) => matchesLiveReleaseBlockerQueueFilters(command, queueFilters))
    .sort((a, b) => {
      const aDigest = a.liveReleaseBlockerDigest || {};
      const bDigest = b.liveReleaseBlockerDigest || {};
      return ((bDigest.denialUrgency?.urgencyScore || 0) - (aDigest.denialUrgency?.urgencyScore || 0))
        || ((bDigest.liveExecuteDenials?.denialCount || 0) - (aDigest.liveExecuteDenials?.denialCount || 0))
        || ((bDigest.blockerCount || 0) - (aDigest.blockerCount || 0))
        || String(a.id || '').localeCompare(String(b.id || ''));
    })
    .slice(0, limit);
  const topCommand = commands[0] || null;
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_live_release_blocker_queue',
    filters: queueFilters,
    filterSummary: {
      urgencyBand: queueFilters.urgencyBand,
      denialReason: queueFilters.denialReason,
      staleOnly: queueFilters.staleOnly
    },
    facets: buildLiveReleaseBlockerQueueFacets(blockedCommands),
    count: commands.length,
    topUrgencyScore: topCommand?.liveReleaseBlockerDigest?.denialUrgency?.urgencyScore || 0,
    topUrgencyBand: topCommand?.liveReleaseBlockerDigest?.denialUrgency?.urgencyBand || 'none',
    commands
  }));
});

app.get('/api/portfolio/readiness-command-center/live-release-blockers/export', (req, res) => {
  const { workspaceId, snapshot, limit, filters } = retentionReadSnapshot(req);
  const queueFilters = liveReleaseBlockerQueueFilters(req.query, filters);
  const blockedCommands = filterReadinessCommandCenter(snapshot.readinessCommandCenter || [], queueFilters)
    .filter((command) => command.liveReleaseBlockerDigest?.releasePreflightBlocked === true);
  const commands = blockedCommands
    .filter((command) => matchesLiveReleaseBlockerQueueFilters(command, queueFilters))
    .sort((a, b) => {
      const aDigest = a.liveReleaseBlockerDigest || {};
      const bDigest = b.liveReleaseBlockerDigest || {};
      return ((bDigest.denialUrgency?.urgencyScore || 0) - (aDigest.denialUrgency?.urgencyScore || 0))
        || ((bDigest.liveExecuteDenials?.denialCount || 0) - (aDigest.liveExecuteDenials?.denialCount || 0))
        || ((bDigest.blockerCount || 0) - (aDigest.blockerCount || 0))
        || String(a.id || '').localeCompare(String(b.id || ''));
    })
    .slice(0, limit);
  const exportPacket = buildLiveReleaseBlockerQueueExport({
    filters: queueFilters,
    facets: buildLiveReleaseBlockerQueueFacets(blockedCommands),
    commands
  });
  return res.json(decisionReadEnvelope(snapshot, {
    ...exportPacket,
    reviewComparison: buildLiveReleaseBlockerQueueExportReviewComparison({
      workspaceId,
      filters: queueFilters,
      currentChecksum: exportPacket.integrityManifest?.checksum || null
    })
  }));
});

app.get('/api/portfolio/readiness-command-center/live-release-blockers/export-reviews', (req, res) => {
  const query = req.query || {};
  const workspaceId = cleanText(query.workspaceId || query.workspace_id) || 'ws_callan';
  const limit = boundedLimit(query.limit, 100, 500);
  const queueFilters = liveReleaseBlockerQueueFilters(query, retentionReadFilters(query));
  const receipts = listLiveReleaseBlockerQueueExportReviewReceiptsForFilters({
    workspaceId,
    checksum: cleanText(query.checksum),
    reviewKind: cleanText(query.reviewKind || query.review_kind),
    status: cleanText(query.status),
    filters: queueFilters,
    limit
  });
  res.json({
    kind: 'service_decision_live_release_blocker_queue_export_reviews',
    workspaceId,
    filters: queueFilters,
    count: receipts.length,
    receipts,
    readOnly: true,
    externalSideEffects: false
  });
});

app.post('/api/portfolio/readiness-command-center/live-release-blockers/export-review', (req, res) => {
  const body = req.body || {};
  const query = req.query || {};
  const integrityManifest = body.integrityManifest || body.integrity_manifest || {};
  try {
    const result = portfolioOperatingModel.recordLiveReleaseBlockerQueueExportReview({
      workspaceId: cleanText(body.workspaceId || body.workspace_id || query.workspaceId || query.workspace_id) || 'ws_callan',
      checksum: cleanText(body.checksum || integrityManifest.checksum),
      algorithm: cleanText(body.algorithm || integrityManifest.algorithm) || 'sha256',
      commandCount: body.commandCount ?? body.command_count ?? integrityManifest.commandCount,
      commandIds: Array.isArray(body.commandIds) ? body.commandIds : (Array.isArray(body.command_ids) ? body.command_ids : []),
      filterSummary: body.filterSummary || body.filter_summary || {},
      integrityManifest,
      reviewKind: cleanText(body.reviewKind || body.review_kind) || 'checksum_acknowledgement',
      operatorId: cleanText(body.operatorId || body.operator_id) || 'portfolio_ui',
      evidence: Array.isArray(body.evidence) ? body.evidence : []
    });
    res.json({
      kind: 'service_decision_live_release_blocker_queue_export_review',
      ...result,
      receipt: normalizeLiveReleaseBlockerQueueExportReviewReceipt(result.receipt),
      readOnly: true,
      externalSideEffects: false
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      code: 'LIVE_RELEASE_BLOCKER_QUEUE_EXPORT_REVIEW_INVALID',
      message: err?.message || String(err)
    });
  }
});

app.get('/api/portfolio/readiness-command-center/:id', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const commandId = cleanText(req.params.id);
  const command = (snapshot.readinessCommandCenter || []).find((item) => item.id === commandId) || null;
  if (!command) return res.status(404).json({ ok: false, code: 'READINESS_COMMAND_CENTER_NOT_FOUND', id: commandId });
  const executionId = command.serviceDecisionExecutionReceiptId;
  const reconciliation = (snapshot.serviceDecisionReadinessReconciliations || []).find((item) => item.id === command.id) || null;
  const execution = (snapshot.serviceDecisionExecutionReceipts || []).find((item) => item.id === executionId) || null;
  const workflow = (snapshot.workflowInstances || []).find((item) => item.id === command.workflowInstanceId) || null;
  const workflowEvents = (snapshot.workflowInstanceEvents || [])
    .filter((item) => item.instance_id === command.workflowInstanceId)
    .slice(0, limit);
  const workflowLinks = (snapshot.workflowEntityLinks || [])
    .filter((item) => item.instance_id === command.workflowInstanceId)
    .slice(0, limit);
  const compensationPlans = filterWorkflowCompensationPlans(snapshot.workflowCompensationPlans || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: executionId,
    workflowInstanceId: command.workflowInstanceId
  }).slice(0, limit);
  const compensationPlanIds = new Set(compensationPlans.map((item) => item.id));
  const compensationReceipts = filterWorkflowCompensationReceipts(snapshot.workflowCompensationReceipts || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: executionId,
    workflowInstanceId: command.workflowInstanceId
  })
    .filter((item) => !filters.compensationPlanId || compensationPlanIds.has(item.compensation_plan_id))
    .slice(0, limit);
  const readinessEvidence = (snapshot.liveReadinessEvidenceArtifacts || [])
    .filter((item) => item.service_decision_execution_receipt_id === executionId)
    .slice(0, limit);
  const liveAdapterReceipts = (snapshot.liveAdapterReceipts || [])
    .filter((item) => item.service_decision_execution_receipt_id === executionId)
    .slice(0, limit);
  const readinessEvidenceReviewReceipts = filterReadinessEvidenceReviewReceipts(snapshot.readinessEvidenceReviewReceipts || [], {
    ...filters,
    readinessReconciliationId: command.id,
    serviceDecisionExecutionReceiptId: executionId,
    workflowInstanceId: command.workflowInstanceId
  }).slice(0, limit);
  const readinessReleasePreflightReceipts = filterReadinessReleasePreflightReceipts(snapshot.readinessReleasePreflightReceipts || [], {
    ...filters,
    readinessReconciliationId: command.id,
    serviceDecisionExecutionReceiptId: executionId,
    workflowInstanceId: command.workflowInstanceId
  }).slice(0, limit);
  const liveExecuteDenials = filterServiceDecisionLiveExecuteDenials(snapshot.serviceDecisionLiveExecuteDenials || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: executionId
  }).slice(0, limit);
  const liveExecuteDenialIncidents = aggregateServiceDecisionLiveExecuteDenialIncidents(liveExecuteDenials).slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_readiness_command_center_detail',
    filters: { ...filters, readinessReconciliationId: command.id },
    command,
    reconciliation,
    execution,
    workflow,
    workflowEventCount: workflowEvents.length,
    workflowEvents,
    workflowLinkCount: workflowLinks.length,
    workflowLinks,
    compensationPlanCount: compensationPlans.length,
    compensationPlans,
    compensationReceiptCount: compensationReceipts.length,
    compensationReceipts,
    readinessEvidenceCount: readinessEvidence.length,
    readinessEvidence,
    liveAdapterReceiptCount: liveAdapterReceipts.length,
    liveAdapterReceipts,
    readinessEvidenceReviewReceiptCount: readinessEvidenceReviewReceipts.length,
    readinessEvidenceReviewReceipts,
    readinessReleasePreflightReceiptCount: readinessReleasePreflightReceipts.length,
    readinessReleasePreflightReceipts,
    liveExecuteDenialCount: liveExecuteDenials.length,
    liveExecuteDenials,
    liveExecuteDenialIncidentCount: liveExecuteDenialIncidents.length,
    liveExecuteDenialIncidents
  }));
});

app.get('/api/portfolio/readiness-command-center/:id/live-execute-denial-export', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const commandId = cleanText(req.params.id);
  const command = (snapshot.readinessCommandCenter || []).find((item) => item.id === commandId) || null;
  if (!command) return res.status(404).json({ ok: false, code: 'READINESS_COMMAND_CENTER_NOT_FOUND', id: commandId });
  const executionId = command.serviceDecisionExecutionReceiptId;
  const reconciliation = (snapshot.serviceDecisionReadinessReconciliations || []).find((item) => item.id === command.id) || null;
  const execution = (snapshot.serviceDecisionExecutionReceipts || []).find((item) => item.id === executionId) || null;
  const workflow = (snapshot.workflowInstances || []).find((item) => item.id === command.workflowInstanceId) || null;
  const denials = filterServiceDecisionLiveExecuteDenials(snapshot.serviceDecisionLiveExecuteDenials || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: executionId
  }).slice(0, limit);
  const incidents = aggregateServiceDecisionLiveExecuteDenialIncidents(denials).slice(0, limit);
  const exportPacket = buildServiceDecisionLiveExecuteDenialProvenanceExport({
    command,
    reconciliation,
    execution,
    workflow,
    denials,
    incidents
  });
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_live_execute_denial_redacted_provenance_export',
    filters: { ...filters, readinessReconciliationId: command.id },
    command,
    exportPacket,
    denialReceiptCount: denials.length,
    incidentCount: incidents.length
  }));
});

app.get('/api/portfolio/readiness-command-center/:id/compensation', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const commandId = cleanText(req.params.id);
  const command = (snapshot.readinessCommandCenter || []).find((item) => item.id === commandId) || null;
  if (!command) return res.status(404).json({ ok: false, code: 'READINESS_COMMAND_CENTER_NOT_FOUND', id: commandId });
  const compensationPlans = filterWorkflowCompensationPlans(snapshot.workflowCompensationPlans || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: command.serviceDecisionExecutionReceiptId,
    workflowInstanceId: command.workflowInstanceId
  }).slice(0, limit);
  const planIds = new Set(compensationPlans.map((item) => item.id));
  const compensationReceipts = filterWorkflowCompensationReceipts(snapshot.workflowCompensationReceipts || [], {
    ...filters,
    serviceDecisionExecutionReceiptId: command.serviceDecisionExecutionReceiptId,
    workflowInstanceId: command.workflowInstanceId
  })
    .filter((item) => !filters.compensationPlanId || planIds.has(item.compensation_plan_id))
    .slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'service_decision_readiness_compensation_list',
    filters: { ...filters, readinessReconciliationId: command.id },
    command,
    planCount: compensationPlans.length,
    compensationPlans,
    receiptCount: compensationReceipts.length,
    compensationReceipts
  }));
});

app.get('/api/portfolio/readiness-evidence-review-receipts', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receipts = filterReadinessEvidenceReviewReceipts(snapshot.readinessEvidenceReviewReceipts || [], filters).slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'readiness_evidence_review_receipt_list',
    filters,
    count: receipts.length,
    receipts
  }));
});

app.get('/api/portfolio/readiness-evidence-review-receipts/:id', (req, res) => {
  const { snapshot, limit, filters } = retentionReadSnapshot(req);
  const receiptId = cleanText(req.params.id);
  const receipt = filterReadinessEvidenceReviewReceipts(snapshot.readinessEvidenceReviewReceipts || [], {
    ...filters,
    readinessEvidenceReviewReceiptId: receiptId
  })[0] || null;
  if (!receipt) return res.status(404).json({ ok: false, code: 'READINESS_EVIDENCE_REVIEW_RECEIPT_NOT_FOUND', id: receiptId });
  const command = (snapshot.readinessCommandCenter || []).find((item) => item.id === receipt.readiness_reconciliation_id) || null;
  const reconciliation = (snapshot.serviceDecisionReadinessReconciliations || []).find((item) => item.id === receipt.readiness_reconciliation_id) || null;
  const execution = (snapshot.serviceDecisionExecutionReceipts || []).find((item) => item.id === receipt.service_decision_execution_receipt_id) || null;
  const workflow = (snapshot.workflowInstances || []).find((item) => item.id === receipt.workflow_instance_id) || null;
  const readinessEvidence = (snapshot.liveReadinessEvidenceArtifacts || [])
    .filter((item) => item.service_decision_execution_receipt_id === receipt.service_decision_execution_receipt_id)
    .slice(0, limit);
  const liveAdapterReceipts = (snapshot.liveAdapterReceipts || [])
    .filter((item) => item.service_decision_execution_receipt_id === receipt.service_decision_execution_receipt_id)
    .slice(0, limit);
  return res.json(decisionReadEnvelope(snapshot, {
    kind: 'readiness_evidence_review_receipt_detail',
    filters: { ...filters, readinessEvidenceReviewReceiptId: receipt.id },
    receipt,
    command,
    reconciliation,
    execution,
    workflow,
    readinessEvidenceCount: readinessEvidence.length,
    readinessEvidence,
    liveAdapterReceiptCount: liveAdapterReceipts.length,
    liveAdapterReceipts
  }));
});

app.post('/api/portfolio/decision-work-items/:id/decide', (req, res) => {
  res.json(portfolioOperatingModel.decideDecisionWorkItem({
    workItemId: cleanText(req.params.id),
    actionKind: cleanText(req.body?.actionKind || req.body?.action_kind) || 'approve',
    status: cleanText(req.body?.status) || null,
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    roleAssignmentId: cleanText(req.body?.roleAssignmentId || req.body?.role_assignment_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {},
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/retention-command-work-items/:id/decide', (req, res) => {
  res.json(portfolioOperatingModel.decideRetentionCommandWorkItem({
    workItemId: cleanText(req.params.id),
    actionKind: cleanText(req.body?.actionKind || req.body?.action_kind) || 'approve',
    status: cleanText(req.body?.status) || null,
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    roleAssignmentId: cleanText(req.body?.roleAssignmentId || req.body?.role_assignment_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : null,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/retention-command-work-items/:id/claim', (req, res) => {
  res.json(portfolioOperatingModel.claimRetentionCommandWorkItem({
    workItemId: cleanText(req.params.id),
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    roleAssignmentId: cleanText(req.body?.roleAssignmentId || req.body?.role_assignment_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    proof: {
      ...(req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : {}),
      leaseDurationMs: Number(req.body?.leaseDurationMs ?? req.body?.lease_duration_ms ?? 30 * 60 * 1000),
      leaseExpiresAt: Number(req.body?.leaseExpiresAt ?? req.body?.lease_expires_at ?? 0) || null
    },
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/retention-command-work-items/:id/release', (req, res) => {
  res.json(portfolioOperatingModel.releaseRetentionCommandWorkItem({
    workItemId: cleanText(req.params.id),
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    roleAssignmentId: cleanText(req.body?.roleAssignmentId || req.body?.role_assignment_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : null,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/retention-command-work-items/:id/expire-lease', (req, res) => {
  res.json(portfolioOperatingModel.expireRetentionCommandWorkItemLease({
    workItemId: cleanText(req.params.id),
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    roleAssignmentId: cleanText(req.body?.roleAssignmentId || req.body?.role_assignment_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : null,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/retention-command-work-items/expire-leases', (req, res) => {
  res.json(portfolioOperatingModel.expireRetentionCommandWorkItemLeases({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || null,
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    retentionCohortRollupId: cleanText(req.body?.retentionCohortRollupId || req.body?.retention_cohort_rollup_id) || null,
    retentionCommandWorkItemReceiptId: cleanText(req.body?.retentionCommandWorkItemReceiptId || req.body?.retention_command_work_item_receipt_id) || null,
    workItemId: cleanText(req.body?.workItemId || req.body?.work_item_id) || null,
    operatorId: cleanText(req.body?.operatorId || req.body?.operator_id) || null,
    roleAssignmentId: cleanText(req.body?.roleAssignmentId || req.body?.role_assignment_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
    limit: boundedLimit(req.body?.limit, 100, 500)
  }));
});

app.post('/api/portfolio/retention-command-work-items/lease-maintenance', (req, res) => {
  res.json(portfolioOperatingModel.recordRetentionCommandWorkItemLeaseMaintenance({
    workspaceId: cleanText(req.body?.workspaceId || req.body?.workspace_id) || null,
    serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.body?.service_business_id) || null,
    retentionCohortRollupId: cleanText(req.body?.retentionCohortRollupId || req.body?.retention_cohort_rollup_id) || null,
    retentionCommandWorkItemReceiptId: cleanText(req.body?.retentionCommandWorkItemReceiptId || req.body?.retention_command_work_item_receipt_id) || null,
    actor: cleanText(req.body?.actor) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : [],
    limit: boundedLimit(req.body?.limit, 500, 1000)
  }));
});

app.post('/api/portfolio/readiness-command-center/:id/plan-compensation', (req, res) => {
  try {
    res.json(portfolioOperatingModel.planReadinessCommandCompensation({
      readinessReconciliationId: cleanText(req.params.id),
      actor: cleanText(req.body?.actor) || 'operator',
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    return sendPortfolioCommandError(res, err, 'READINESS_COMMAND_PLAN_FAILED');
  }
});

app.post('/api/portfolio/readiness-command-center/:id/record-retry-receipts', (req, res) => {
  try {
    res.json(portfolioOperatingModel.recordReadinessCommandRetryReceipts({
      readinessReconciliationId: cleanText(req.params.id),
      actor: cleanText(req.body?.actor) || 'operator',
      proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : null,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    return sendPortfolioCommandError(res, err, 'READINESS_COMMAND_RETRY_FAILED');
  }
});

app.post('/api/portfolio/readiness-command-center/:id/evidence', (req, res) => {
  try {
    res.json(portfolioOperatingModel.submitReadinessCommandEvidence({
      readinessReconciliationId: cleanText(req.params.id),
      proofKey: cleanText(req.body?.proofKey || req.body?.proof_key) || 'provider_live_smoke',
      actor: cleanText(req.body?.actor) || 'operator',
      attestation: req.body?.attestation && typeof req.body.attestation === 'object' ? req.body.attestation : null,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    return sendPortfolioCommandError(res, err, 'READINESS_COMMAND_EVIDENCE_FAILED');
  }
});

app.post('/api/portfolio/readiness-command-center/:id/review-evidence', (req, res) => {
  try {
    res.json(portfolioOperatingModel.reviewReadinessCommandEvidence({
      readinessReconciliationId: cleanText(req.params.id),
      proofKey: cleanText(req.body?.proofKey || req.body?.proof_key) || 'provider_live_smoke',
      reviewKind: cleanText(req.body?.reviewKind || req.body?.review_kind) || 'submitted_evidence_closeout',
      decision: cleanText(req.body?.decision) || 'reviewed_pending_live_proof',
      actor: cleanText(req.body?.actor) || 'operator',
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    return sendPortfolioCommandError(res, err, 'READINESS_COMMAND_EVIDENCE_REVIEW_FAILED');
  }
});

app.post('/api/portfolio/readiness-command-center/:id/release-preflight', (req, res) => {
  try {
    res.json(portfolioOperatingModel.prepareReadinessReleasePreflight({
      readinessReconciliationId: cleanText(req.params.id),
      releaseKind: cleanText(req.body?.releaseKind || req.body?.release_kind) || 'reviewed_evidence_release_preflight',
      decision: cleanText(req.body?.decision) || 'release_blocked_unverified_live_proof',
      actor: cleanText(req.body?.actor) || 'operator',
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    return sendPortfolioCommandError(res, err, 'READINESS_COMMAND_RELEASE_PREFLIGHT_FAILED');
  }
});

app.post('/api/portfolio/readiness-command-center/:id/provider-smoke-receipt', (req, res) => {
  try {
    res.json(portfolioOperatingModel.recordReadinessProviderSmokeReceipt({
      readinessReconciliationId: cleanText(req.params.id),
      provider: cleanText(req.body?.provider) || null,
      runMode: cleanText(req.body?.runMode || req.body?.run_mode) || 'mock',
      liveFlagsAttested: Array.isArray(req.body?.liveFlagsAttested)
        ? req.body.liveFlagsAttested
        : (Array.isArray(req.body?.live_flags_attested) ? req.body.live_flags_attested : []),
      requiredLiveFlags: Array.isArray(req.body?.requiredLiveFlags)
        ? req.body.requiredLiveFlags
        : (Array.isArray(req.body?.required_live_flags) ? req.body.required_live_flags : null),
      actor: cleanText(req.body?.actor) || 'operator',
      proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : null,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    return sendPortfolioCommandError(res, err, 'READINESS_PROVIDER_SMOKE_RECEIPT_FAILED');
  }
});

app.post('/api/portfolio/readiness-command-center/:id/adapter-ledger', (req, res) => {
  try {
    res.json(portfolioOperatingModel.recordReadinessAdapterLedger({
      readinessReconciliationId: cleanText(req.params.id),
      adapterKey: cleanText(req.body?.adapterKey || req.body?.adapter_key) || 'service_decision_execution_controller',
      mode: cleanText(req.body?.mode) || 'dry_run',
      actor: cleanText(req.body?.actor) || 'operator',
      proof: req.body?.proof && typeof req.body.proof === 'object' ? req.body.proof : null,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    return sendPortfolioCommandError(res, err, 'READINESS_ADAPTER_LEDGER_FAILED');
  }
});

app.post('/api/portfolio/readiness-command-center/:id/reconcile', (req, res) => {
  try {
    res.json(portfolioOperatingModel.reconcileReadinessCommandCenter({
      readinessReconciliationId: cleanText(req.params.id),
      actor: cleanText(req.body?.actor) || 'operator',
      allowLiveBoardDecisionExecution: req.body?.allowLiveBoardDecisionExecution === true || req.body?.allow_live_board_decision_execution === true,
      evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
    }));
  } catch (err) {
    return sendPortfolioCommandError(res, err, 'READINESS_COMMAND_RECONCILE_FAILED');
  }
});

app.get('/portfolio/surfaces/:id', (req, res) => {
  const entry = portfolioOperatingModel.getLaunchSurface(cleanText(req.params.id));
  if (!entry) {
    res.status(404).type('html').send('<!doctype html><title>Surface not found</title><h1>Surface not found</h1>');
    return;
  }
  res.type('html').send(renderPortfolioLaunchSurfaceHtml(entry));
});

app.post('/api/portfolio/approvals/:id/decide', (req, res) => {
  res.json(portfolioOperatingModel.decidePortfolioApproval({
    approvalId: cleanText(req.params.id),
    status: cleanText(req.body?.status) || 'approved',
    decidedBy: cleanText(req.body?.decidedBy || req.body?.decided_by) || 'operator',
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.post('/api/portfolio/provider-links/:id/status', (req, res) => {
  res.json(portfolioOperatingModel.updatePortfolioProviderLink({
    providerLinkId: cleanText(req.params.id),
    status: cleanText(req.body?.status) || 'active',
    scopes: Array.isArray(req.body?.scopes) ? req.body.scopes : null,
    quality: req.body?.quality && typeof req.body.quality === 'object' ? req.body.quality : null
  }));
});

app.post('/api/portfolio/vendor-partners/:id/status', (req, res) => {
  res.json(portfolioOperatingModel.updatePortfolioVendorPartner({
    vendorId: cleanText(req.params.id),
    status: cleanText(req.body?.status) || 'active',
    quality: req.body?.quality && typeof req.body.quality === 'object' ? req.body.quality : null,
    compliance: req.body?.compliance && typeof req.body.compliance === 'object' ? req.body.compliance : null
  }));
});

app.post('/api/portfolio/payments/:id/status', (req, res) => {
  res.json(portfolioOperatingModel.updatePortfolioPaymentStatus({
    paymentId: cleanText(req.params.id),
    status: cleanText(req.body?.status) || 'authorized',
    consent: req.body?.consent && typeof req.body.consent === 'object' ? req.body.consent : null
  }));
});

app.post('/api/portfolio/incidents/:id/resolve', (req, res) => {
  res.json(portfolioOperatingModel.resolvePortfolioIncident({
    incidentId: cleanText(req.params.id),
    status: cleanText(req.body?.status) || 'resolved',
    rootCause: req.body?.rootCause && typeof req.body.rootCause === 'object' ? req.body.rootCause : req.body?.root_cause,
    evidence: Array.isArray(req.body?.evidence) ? req.body.evidence : []
  }));
});

app.get('/api/handoff/cases', (req, res) => {
  res.json(handoffDeskSummary({
    leadId: cleanText(req.query?.leadId || req.query?.lead_id) || null,
    status: cleanText(req.query?.status) || 'open',
    category: cleanText(req.query?.category) || null,
    limit: boundedLimit(req.query?.limit, 80, 500)
  }));
});

app.get('/api/leads/:id/handoff', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json(handoffDeskSummary({
    leadId: lead.id,
    status: cleanText(req.query?.status) || 'all',
    limit: boundedLimit(req.query?.limit, 80, 500)
  }));
});

app.post('/api/handoff/cases/:id/actions', async (req, res) => {
  try {
    const result = await performHandoffAction(req.params.id, {
      action: req.body?.action,
      actor: req.body?.actor || 'operator',
      note: req.body?.note || null,
      body: req.body?.body || req.body?.replyText || null,
      assignedTo: req.body?.assignedTo || req.body?.assigned_to || null,
      scheduledAtMs: req.body?.scheduledAtMs || req.body?.scheduled_at_ms || null,
      ask: req.body?.ask || null,
      resumeAutomation: req.body?.resumeAutomation === true || req.body?.resume_automation === true,
      target: req.body?.target || null,
      startBuilder
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.get('/api/commerce/status', (_req, res) => {
  res.json(commerceStatus());
});

app.get('/api/production-readiness', (_req, res) => {
  const readiness = liveReadiness();
  const observability = opsObservability();
  res.json({
    ok: readiness.canGoLive,
    mode: readiness.mode,
    canGoLive: readiness.canGoLive,
    productionBlockers: readiness.productionBlockers,
    promotionGates: readiness.promotionGates,
    providers: readiness.providers,
    providerProof: buildProviderProofMatrix({ readiness, observability }),
    webhooks: readiness.webhooks,
    admin: readiness.admin,
    sideEffects: readiness.sideEffects,
    compliance: readiness.compliance,
    reputation: readiness.reputation,
    quotas: readiness.quotas,
    nextActions: readiness.nextActions,
    docs: readiness.docs
  });
});

app.get('/api/jobs/health', (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    queue: jobQueueHealth(),
    recent: durableJobs.list({
      status: req.query?.status || undefined,
      type: req.query?.type || undefined,
      limit: boundedLimit(req.query?.limit, 50, 200)
    })
  });
});

app.post('/api/jobs/recover-stuck', requireAdmin, (_req, res) => {
  const recovered = durableJobs.recoverExpiredLeases({ limit: 200 });
  res.json({ ok: true, recovered, queue: jobQueueHealth() });
});

app.get('/api/ops/command-center', async (_req, res) => {
  const readiness = liveReadiness();
  const queue = jobQueueHealth();
  const observability = opsObservability();
  const durableSnapshot = safeToSellSnapshotStatus(observability.safeToSellHistory?.latest);
  const safeToSellReceipts = compactSafeToSellReceiptHistory(observability.safeToSellHistory);
  const durableRenewSnapshot = safeToRenewSnapshotStatus(observability.safeToRenewHistory?.latest);
  const safeToRenewReceipts = compactSafeToRenewReceiptHistory(observability.safeToRenewHistory);
  const safeSnapshot = durableSnapshot.snapshot;
  const evals = safeSnapshot?.report?.evals || await runProductionEvals();
  const backups = latestBackupManifest();
  const backup = backupFreshness(backups);
  const since24h = Date.now() - 24 * 3600 * 1000;
  const economics = economicsByNiche({ since: since24h });
  const safeToSellToday = safeSnapshot
    ? safeToSellSnapshotSummary({ snapshot: safeSnapshot, durableSnapshot })
    : safeToSellTodaySummary({ readiness, queue, evals, observability, backup, durableSnapshot });
  const safeToRenewToday = durableRenewSnapshot.snapshot
    ? safeToRenewSnapshotSummary({ snapshot: durableRenewSnapshot.snapshot, durableSnapshot: durableRenewSnapshot })
    : {
      ...buildSafeToRenewStatus(),
      source: 'inline',
      durableSnapshot: durableRenewSnapshot
    };
  const providerProof = safeToSellToday.providerProof?.length
    ? safeToSellToday.providerProof
    : buildProviderProofMatrix({ readiness, observability });
  res.json({
    ok: safeToSellToday.ok
      && readiness.canGoLive
      && queue.ok
      && evals.ok
      && backup.ok
      && observability.schedulerHealth?.ok !== false
      && observability.economicsHealth?.ok !== false
      && observability.providerHealthSlo?.ok !== false
      && observability.workerHealthSlo?.ok !== false,
    ts: Date.now(),
    mode: env.runMode,
    safeToSellToday,
    safeToSellReceipts,
    safeToRenewToday,
    safeToRenewReceipts,
	    renewalChangeRequestQueue: observability.renewalChangeRequestQueue || null,
	    renewalBillingChangePreflightQueue: observability.renewalBillingChangePreflightQueue || null,
	    renewalBillingExecutionReceiptQueue: observability.renewalBillingExecutionReceiptQueue || null,
	    renewalCustomerMessagePreflightQueue: observability.renewalCustomerMessagePreflightQueue || null,
	    renewalCustomerMessageSendReceiptQueue: observability.renewalCustomerMessageSendReceiptQueue || null,
	    renewalCustomerConfirmationQueue: observability.renewalCustomerConfirmationQueue || null,
	    renewalCustomerConfirmationAcknowledgementQueue: observability.renewalCustomerConfirmationAcknowledgementQueue || null,
	    renewalCustomerConfirmationAcceptanceQueue: observability.renewalCustomerConfirmationAcceptanceQueue || null,
	    renewalCustomerConfirmationFollowupQueue: observability.renewalCustomerConfirmationFollowupQueue || null,
	    renewalCustomerConfirmationCloseoutPacketQueue: observability.renewalCustomerConfirmationCloseoutPacketQueue || null,
	    readiness: {
      currentModeReady: readiness.ready,
      productionLiveReady: readiness.canGoLive,
      blockers: readiness.blockers,
      productionBlockers: readiness.productionBlockers,
      promotionGates: readiness.promotionGates,
      admin: readiness.admin,
      nextActions: readiness.nextActions
    },
    promotionGates: readiness.promotionGates,
    providers: readiness.providers,
    providerProof,
    webhooks: readiness.webhooks,
    queue,
    evals,
    observability,
    backups: {
      ...backup,
      files: backups.files
    },
    economics24h: economics,
    outreach: readiness.outreach,
    compliance: readiness.compliance
  });
});

app.get('/api/ops/observability', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    ...opsObservability()
  });
});

app.post('/api/ops/recover-stuck', requireAdmin, (req, res) => {
  const result = recoverStuckOperations({
    dryRun: req.body?.dryRun === true,
    maxCallAgeMs: Number(req.body?.maxCallAgeMs) || undefined
  });
  res.json(result);
});

app.post('/api/ops/renewal-change-requests/:id/resolve', requireAdmin, (req, res) => {
  try {
    const result = opsResolveRenewalChangeRequest({
      portalActionId: String(req.params?.id || ''),
      outcome: String(req.body?.outcome || ''),
      note: req.body?.note || '',
      operator: req.body?.operator || 'operator'
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/renewal-change-requests/:id/billing-preflight', requireAdmin, (req, res) => {
  try {
    const result = opsCreateRenewalBillingChangePreflight({
      portalActionId: String(req.params?.id || ''),
      proposedChange: req.body?.proposedChange || {},
      operator: req.body?.operator || 'operator',
      evidence: req.body?.evidence || {}
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/renewal-billing-change-preflights/:id/execute', requireAdmin, async (req, res) => {
  try {
    const result = await opsExecuteRenewalBillingChangePreflight({
      preflightId: String(req.params?.id || ''),
      operator: req.body?.operator || 'operator',
      live: req.body?.live === true,
      operatorApproval: req.body?.operatorApproval === true,
      billingChangeApproved: req.body?.billingChangeApproved === true,
      customerConsentDocumented: req.body?.customerConsentDocumented === true,
      pricingPolicyReviewed: req.body?.pricingPolicyReviewed === true,
      targetStripePriceId: req.body?.targetStripePriceId || req.body?.stripePriceId || null
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/renewal-change-requests/:id/customer-message-preflight', requireAdmin, (req, res) => {
  try {
    const result = opsCreateRenewalCustomerMessagePreflight({
      portalActionId: String(req.params?.id || ''),
      billingPreflightId: req.body?.billingPreflightId || null,
      messageDraft: req.body?.messageDraft || {},
      operator: req.body?.operator || 'operator',
      evidence: req.body?.evidence || {}
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/renewal-customer-message-preflights/:id/execute', requireAdmin, async (req, res) => {
  try {
    const result = await opsExecuteRenewalCustomerMessagePreflight({
      preflightId: String(req.params?.id || ''),
      targetEmail: req.body?.targetEmail || '',
      operator: req.body?.operator || 'operator',
      live: req.body?.live === true,
      operatorApproval: req.body?.operatorApproval === true,
      messageCopyApproved: req.body?.messageCopyApproved === true,
      customerConsentDocumented: req.body?.customerConsentDocumented === true
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/renewal-confirmations', requireAdmin, (req, res) => {
  try {
    const result = opsCreateRenewalCustomerConfirmationReceipt({
      leadId: req.body?.leadId || null,
      billingExecutionReceiptId: req.body?.billingExecutionReceiptId || null,
      messageSendReceiptId: req.body?.messageSendReceiptId || null,
      operator: req.body?.operator || 'operator',
      summary: req.body?.summary || ''
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/renewal-confirmation-acceptances/:id/followup', requireAdmin, (req, res) => {
  try {
    const result = opsCreateRenewalCustomerConfirmationFollowupWorkItem({
      leadId: req.body?.leadId || null,
      acceptanceId: String(req.params?.id || ''),
      operator: req.body?.operator || 'operator',
      priority: req.body?.priority || 'normal',
      dueAt: req.body?.dueAt || null
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/renewal-confirmation-followups/:id/resolve', requireAdmin, (req, res) => {
  try {
    const result = opsResolveRenewalCustomerConfirmationFollowupWorkItem({
      workItemId: String(req.params?.id || ''),
      outcome: req.body?.outcome || 'completed',
      note: req.body?.note || '',
      operator: req.body?.operator || 'operator'
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/renewal-confirmation-followup-receipts/:id/closeout', requireAdmin, (req, res) => {
  try {
    const result = opsCreateRenewalCustomerConfirmationCloseoutPacket({
      followupReceiptId: String(req.params?.id || ''),
      operator: req.body?.operator || 'operator',
      summary: req.body?.summary || '',
      nextReviewAt: req.body?.nextReviewAt || null
    });
    res.json(result);
  } catch (err) {
    const code = err?.code;
    if (code === 'invalid_request' || code === 'portal_action_type_mismatch') {
      return res.status(400).json({ ok: false, error: err.message, code });
    }
    if (code === 'portal_action_not_found') {
      return res.status(404).json({ ok: false, error: err.message, code });
    }
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/self-check', requireAdmin, async (req, res) => {
  try {
    const scope = cleanText(req.body?.scope || req.query?.scope || '').toLowerCase();
    const renewOnly = ['renew', 'safe-to-renew', 'safe_to_renew'].includes(scope);
    if (req.body?.runNow === true) {
      if (renewOnly) {
        const report = await runSafeToRenewSelfCheck({
          record: req.body?.record !== false,
          source: 'api'
        });
        return res.json({ ok: true, report });
      }
      const report = await runSafeToSellSelfCheck({
        record: req.body?.record !== false,
        source: 'api'
      });
      return res.json({ ok: true, report });
    }
    if (renewOnly) {
      const result = enqueueSafeToRenewSelfCheck({
        reason: cleanText(req.body?.reason) || 'api'
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        scope: 'safe_to_renew',
        jobId: result.row?.id || null,
        jobStatus: result.row?.status || null,
        inserted: result.inserted
      });
    }
    const result = enqueueSafeToSellSelfCheck({
      reason: cleanText(req.body?.reason) || 'api'
    });
    return res.status(202).json({
      ok: true,
      accepted: true,
      jobId: result.row?.id || null,
      jobStatus: result.row?.status || null,
      inserted: result.inserted
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/api/ops/retention-command-lease-maintenance', requireAdmin, async (req, res) => {
  try {
    const workspaceId = cleanText(req.body?.workspaceId || req.query?.workspaceId) || 'ws_callan';
    const body = {
      workspaceId,
      serviceBusinessId: cleanText(req.body?.serviceBusinessId || req.query?.serviceBusinessId) || null,
      retentionCohortRollupId: cleanText(req.body?.retentionCohortRollupId || req.query?.retentionCohortRollupId) || null,
      retentionCommandWorkItemReceiptId: cleanText(req.body?.retentionCommandWorkItemReceiptId || req.query?.retentionCommandWorkItemReceiptId) || null,
      reason: cleanText(req.body?.reason) || 'api',
      actor: cleanText(req.body?.actor) || 'api',
      limit: boundedLimit(req.body?.limit || req.query?.limit, 25, 100)
    };
    if (req.body?.runNow === true) {
      const report = runRetentionCommandLeaseMaintenanceJob(body);
      return res.json({ ok: true, report });
    }
    const result = enqueueRetentionCommandLeaseMaintenance(body);
    return res.status(202).json({
      ok: true,
      accepted: true,
      scope: 'retention_command_lease_maintenance',
      jobId: result.row?.id || null,
      jobStatus: result.row?.status || null,
      inserted: result.inserted
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  res.json(exportOperationsData({
    includePII: req.query?.includePII === 'true',
    limit: boundedLimit(req.query?.limit, 500, 2000)
  }));
});

app.post('/api/admin/backup', requireAdmin, (_req, res) => {
  res.json(backupSqliteDataDir());
});

app.get('/api/admin/backups', requireAdmin, (_req, res) => {
  res.json(latestBackupManifest());
});

app.post('/api/admin/reset-mock-data', requireAdmin, (req, res) => {
  const result = resetMockData({
    confirm: req.body?.confirm,
    dryRun: req.body?.dryRun !== false
  });
  res.status(result.ok ? 200 : 409).json(result);
});

app.get('/api/safety/status', (_req, res) => {
  const readiness = liveReadiness();
  res.json({
    ok: readiness.ready,
    mode: readiness.mode,
    sideEffects: readiness.sideEffects,
    compliance: readiness.compliance,
    reputation: readiness.reputation,
    webhooks: readiness.webhooks,
    blockers: readiness.blockers
  });
});

app.get('/api/events/stream', (req, res) => attachStream(req, res));

app.get('/api/reasoning/traces', (req, res) => {
  res.json({
    traces: reasoningTraces.list({
      lead_id: req.query?.leadId || undefined,
      worker: req.query?.worker || undefined,
      schema_name: req.query?.schemaName || undefined,
      limit: boundedLimit(req.query?.limit, 100, 500)
    })
  });
});

app.get('/api/leads', (_req, res) => {
  res.json({ leads: leads.list() });
});

app.get('/api/economics/by-niche', (req, res) => {
  try {
    const since = parseSince(req.query?.since);
    const rollup = economicsByNiche({ since });
    res.json({
      generatedAt: Date.now(),
      since,
      ...rollup
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/leads/priorities', (req, res) => {
  try {
    const limit = boundedLimit(req.query?.limit, 30, 100);
    const top = topPriorityLeads({ limit });
    const winRates = nicheWinRateMap({});
    res.json({
      generatedAt: Date.now(),
      limit,
      leads: top,
      nicheWinRates: winRates
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/memory/businesses', (_req, res) => {
  res.json({ businesses: memoryBusinesses() });
});

app.get('/api/memory/observability', (_req, res) => {
  res.json(memoryObservability());
});

app.post('/api/memory/retry-failed', async (req, res) => {
  try {
    const result = await retryFailedWrites({ limit: req.body?.limit || 25 });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'not found' });
  const callRows = calls.listByLead(lead.id);
  const paymentRows = payments.listByLead(lead.id);
  const buildRows = builds.listByLead(lead.id);
  const runRows = runs.list({ lead_id: lead.id });
  const contactRows = contactEvents.listByLead(lead.id);
  const auditTimeline = auditTrail.timelineByLead(lead.id, { limit: 150 });
  const leadHistory = leads.history(lead.id);
  const leadReasoningTraces = reasoningTraces.listByLead(lead.id, { limit: 80 });
  const builderEvents = eventStore.listByLead(lead.id, { worker: 'builder', limit: 100 });
  const callerEvents = eventStore.listByLead(lead.id, { worker: 'caller', limit: 150 });
  const builderState = buildBuilderReadModel({ lead, buildRows, builderEvents });
  const callState = buildCallStateReadModel({ lead, callRows, callerEvents });
  const builderQa = buildQaReadModel({ leadId: lead.id, buildId: buildRows[0]?.id || null });
  const researchProfile = safeJson(lead.research_json);
  const growth = await readGrowthState(lead.id);
  const accountManager = await readAccountManagerState(lead.id);
  const commerce = readCommerceState(lead.id);
  const leadHandoffCases = handoffCases.listByLead(lead.id, { status: 'all', limit: 80 });
  const moss = mossStatusForLead(lead.id);
  let memory = null;
  try {
    memory = await listKinds(lead.container_tag);
  } catch (err) {
    log.warn('memory.list failed', { error: err.message });
  }
  let margin = null;
  try {
    margin = marginForLead(lead.id);
  } catch (err) {
    log.warn('lead.margin_lookup_failed', { leadId: lead.id, error: err?.message || String(err) });
  }
  const trust = trustSummaryForLead(lead.id);
  res.json({
    lead,
    calls: callRows,
    payments: paymentRows,
    builds: buildRows,
    runs: runRows,
    leadHistory,
    auditTimeline,
    researchProfile,
    memory,
    contactEvents: contactRows,
    outreachStatus: lead.outreach_status,
    riskStatus: lead.risk_status,
    latestThread: latestAgentMailThread(contactRows, lead),
    latestInvoice: paymentRows[0] || null,
    buildStatus: builderState.status,
    builderState,
    callState,
    builderQa,
    reasoningTraces: leadReasoningTraces,
    moss,
    growth,
    accountManager,
    commerce,
    handoff: {
      cases: leadHandoffCases,
      openCases: leadHandoffCases.filter((row) => !['resolved', 'closed'].includes(row.status)),
      summary: {
        total: leadHandoffCases.length,
        open: leadHandoffCases.filter((row) => !['resolved', 'closed'].includes(row.status)).length
      }
    },
    margin,
    trust
  });
});

app.get('/api/leads/:id/reasoning', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json({
    leadId: lead.id,
    traces: reasoningTraces.listByLead(lead.id, { limit: boundedLimit(req.query?.limit, 100, 500) })
  });
});

app.get('/api/leads/:id/trust', (req, res) => {
  const summary = trustSummaryForLead(req.params.id, { eventLimit: boundedLimit(req.query?.limit, 80, 200) });
  if (!summary) return res.status(404).json({ error: 'lead not found' });
  res.json(summary);
});

app.get('/api/leads/:id/build-qa', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const buildRows = builds.listByLead(lead.id);
  res.json(buildQaReadModel({ leadId: lead.id, buildId: buildRows[0]?.id || null }));
});

app.get('/api/leads/:id/moss', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json({ leadId: lead.id, ...mossStatusForLead(lead.id) });
});

app.get('/api/leads/:id/memory', async (req, res) => {
  try {
    const memory = await memoryForLead(req.params.id);
    if (!memory) return res.status(404).json({ error: 'lead not found' });
    res.json(memory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/:id/memory/search', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const q = String(req.body?.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q is required' });
  try {
    const results = await searchMemory(lead.container_tag, q, {
      kind: req.body?.kind || undefined,
      limit: req.body?.limit || 8,
      filters: req.body?.filters || null
    });
    res.json({ leadId: lead.id, containerTag: lead.container_tag, q, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads/:id/growth', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json(await readGrowthState(lead.id));
});

app.post('/api/leads/:id/growth/plan', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = enqueueGrowthPlanJob({
      leadId: lead.id,
      force: req.body?.force === true,
      source: req.body?.source || 'api'
    });
    res.status(202).json({
      accepted: true,
      jobId: result.row?.id,
      jobStatus: result.row?.status,
      duplicate: !result.inserted
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/leads/:id/growth/followup', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = enqueueGrowthFollowupJob({
      leadId: lead.id,
      toEmail: req.body?.toEmail,
      force: req.body?.force === true,
      source: req.body?.source || 'api'
    });
    res.status(202).json({
      accepted: true,
      jobId: result.row?.id,
      jobStatus: result.row?.status,
      duplicate: !result.inserted
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/leads/:id/growth/replies', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = await recordGrowthCustomerResponse({
      leadId: lead.id,
      subject: req.body?.subject,
      message: req.body?.message || req.body?.body || '',
      threadId: req.body?.threadId,
      providerId: req.body?.providerId
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/account-manager/status', (_req, res) => {
  res.json(accountManagerStatus());
});

app.post('/api/account-manager/run', async (req, res) => {
  try {
    const result = enqueueAccountManagerRun({
      leadId: req.body?.leadId || req.body?.lead_id || null,
      taskId: req.body?.taskId || req.body?.task_id || null,
      dryRun: req.body?.dryRun !== false,
      forcePlan: req.body?.forcePlan === true,
      operatorSend: req.body?.operatorSend === true,
      source: req.body?.source || 'api',
      reason: req.body?.reason || 'api',
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || null
    });
    res.status(202).json({
      ok: true,
      accepted: true,
      jobId: result.row?.id || null,
      jobStatus: result.row?.status || null,
      inserted: result.inserted
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/leads/:id/account-manager', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json(await readAccountManagerState(lead.id));
});

app.post('/api/leads/:id/account-manager/plan', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = await generateAccountManagerPlanForLead({
      leadId: lead.id,
      force: req.body?.force === true,
      source: req.body?.source || 'api'
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/leads/:id/account-manager/run', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = enqueueAccountManagerRun({
      leadId: lead.id,
      dryRun: req.body?.dryRun !== false,
      forcePlan: req.body?.forcePlan === true,
      operatorSend: req.body?.operatorSend === true,
      source: req.body?.source || 'api',
      reason: req.body?.reason || 'lead_api',
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || null
    });
    res.status(202).json({
      ok: true,
      accepted: true,
      jobId: result.row?.id || null,
      jobStatus: result.row?.status || null,
      inserted: result.inserted
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/account-tasks/:id/explain', (req, res) => {
  const task = accountTasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'account task not found' });
  const lead = leads.get(task.lead_id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const plan = task.account_plan_id ? accountManagerPlans.get(task.account_plan_id) : accountManagerPlans.getLatest(lead.id);
  const preview = buildAftercarePreview({ lead, task, evidence: plan?.evidence || plan?.plan?.evidence || [] });
  const policy = evaluateSendPolicy({
    lead,
    task,
    dryRun: req.query?.dryRun !== 'false',
    operatorSend: req.query?.operatorSend === 'true',
    preview
  });
  res.json({
    task,
    planId: plan?.id || null,
    preview,
    policy,
    evidence: (plan?.evidence || plan?.plan?.evidence || []).filter((item) => task.evidenceIds?.includes(item.id)),
    history: accountTasks.history(task.id, { limit: 50 })
  });
});

app.post('/api/account-tasks/:id/escalate', (req, res) => {
  try {
    const result = accountTasks.escalateToOperatorBoard(req.params.id, {
      escalationKind: req.body?.escalationKind || req.body?.escalation_kind,
      workItemKind: req.body?.workItemKind || req.body?.work_item_kind,
      audience: req.body?.audience || 'operator',
      priority: req.body?.priority,
      title: req.body?.title,
      requiredProof: req.body?.requiredProof || req.body?.required_proof,
      checklist: req.body?.checklist,
      dueAt: req.body?.dueAt || req.body?.due_at,
      actor: req.body?.actor || 'operator',
      evidence: req.body?.evidence || [],
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || null
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/account task not found/.test(err?.message || '')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/account-operator-board/work-items/:id/lifecycle', (req, res) => {
  try {
    const result = accountTasks.recordOperatorBoardWorkItemLifecycle(req.params.id, {
      actionKind: req.body?.actionKind || req.body?.action_kind,
      status: req.body?.status,
      proofKey: req.body?.proofKey || req.body?.proof_key,
      proof: req.body?.proof,
      actor: req.body?.actor || 'operator',
      note: req.body?.note,
      evidence: req.body?.evidence || [],
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || null
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/operator-board work item not found/.test(err?.message || '')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/account-operator-board/work-items/:id/claim', (req, res) => {
  try {
    const result = accountTasks.claimOperatorBoardWorkItem(req.params.id, {
      actor: req.body?.actor || 'operator',
      note: req.body?.note,
      evidence: req.body?.evidence || [],
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || null
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/operator-board work item not found/.test(err?.message || '')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/account-operator-board/work-items/:id/resolve', (req, res) => {
  try {
    const result = accountTasks.resolveOperatorBoardWorkItem(req.params.id, {
      actionKind: req.body?.actionKind || req.body?.action_kind || 'resolve',
      status: req.body?.status || 'resolved',
      proofKey: req.body?.proofKey || req.body?.proof_key,
      proof: req.body?.proof,
      actor: req.body?.actor || 'operator',
      note: req.body?.note,
      evidence: req.body?.evidence || [],
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || null
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/operator-board work item not found/.test(err?.message || '')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/account-operator-board/lifecycle-receipts/:id/retention-feedback', (req, res) => {
  try {
    const result = accountTasks.recordOperatorBoardRetentionFeedback(req.params.id, {
      retentionPlaybookId: req.body?.retentionPlaybookId || req.body?.retention_playbook_id || null,
      feedbackKind: req.body?.feedbackKind || req.body?.feedback_kind,
      status: req.body?.status,
      recommendation: req.body?.recommendation,
      actor: req.body?.actor || 'operator',
      summary: req.body?.summary,
      evidence: req.body?.evidence || [],
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || null
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (/operator-board lifecycle receipt not found/.test(err?.message || '')) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/account-tasks/:id/approve', (req, res) => {
  const row = approveAccountTask(req.params.id, { note: req.body?.note });
  if (!row) return res.status(404).json({ error: 'account task not found' });
  res.json({ ok: true, task: row });
});

app.post('/api/account-tasks/:id/send', async (req, res) => {
  const task = accountTasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'account task not found' });
  try {
    const result = enqueueAccountManagerTask({
      taskId: task.id,
      dryRun: req.body?.dryRun === true,
      operatorSend: true,
      source: req.body?.source || 'operator_send',
      reason: req.body?.reason || 'operator_send',
      idempotencyKey: req.body?.idempotencyKey || req.body?.idempotency_key || null,
      maxAttempts: req.body?.dryRun === true ? 1 : 3
    });
    res.status(202).json({
      ok: true,
      accepted: true,
      jobId: result.row?.id || null,
      jobStatus: result.row?.status || null,
      inserted: result.inserted
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/account-tasks/:id/pause', (req, res) => {
  const pausedUntil = Number(req.body?.pausedUntil || req.body?.paused_until || 0) || null;
  const row = pauseAccountTask(req.params.id, { note: req.body?.note, pausedUntil });
  if (!row) return res.status(404).json({ error: 'account task not found' });
  res.json({ ok: true, task: row });
});

app.post('/api/account-tasks/:id/complete', (req, res) => {
  const row = completeAccountTask(req.params.id, { note: req.body?.note });
  if (!row) return res.status(404).json({ error: 'account task not found' });
  res.json({ ok: true, task: row });
});

app.post('/api/account-tasks/:id/reassign', (req, res) => {
  const owner = String(req.body?.owner || '').trim();
  if (!owner) return res.status(400).json({ error: 'owner required' });
  const row = reassignAccountTask(req.params.id, { owner, note: req.body?.note });
  if (!row) return res.status(404).json({ error: 'account task not found' });
  res.json({ ok: true, task: row });
});

app.get('/api/leads/:id/commerce', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  res.json(readCommerceState(lead.id));
});

app.post('/api/leads/:id/commerce/plan', async (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  try {
    const result = await planCommerceForLead({
      leadId: lead.id,
      intake: req.body?.intake || req.body || {},
      source: req.body?.source || 'api',
      force: req.body?.force === true
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/leads/discover', (req, res) => {
  const parsed = DiscoverRequest.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const job = fire('scraper', parsed.data, runScraper, { type: 'research.discover' });
  res.status(202).json({ accepted: true, jobId: job?.id, jobStatus: job?.status });
});

app.post('/api/research/start', (req, res) => {
  const parsed = researchStartBody(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  const job = createBrowserUseResearchJob(parsed.value);
  const durableJob = fire('browser_research', { jobId: job.id }, runBrowserUseResearchJob, {
    type: 'research.browser_use',
    idempotencyKey: `browser_research:${job.id}`
  });
  res.status(202).json({
    accepted: true,
    durableJobId: durableJob?.id,
    jobId: job.id,
    job,
    status: getBrowserResearchStatus({ jobId: job.id })
  });
});

app.post('/api/research/stop', async (req, res) => {
  try {
    const result = await stopBrowserUseResearchJob({
      jobId: cleanText(req.body?.jobId || req.body?.job_id),
      strategy: cleanText(req.body?.strategy) || 'session'
    });
    res.json({ ...result, status: getBrowserResearchStatus({ jobId: result.jobId }) });
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/research/status', (req, res) => {
  res.json(getBrowserResearchStatus({ jobId: cleanText(req.query?.jobId || req.query?.job_id) }));
});

app.get('/api/research/sessions', (req, res) => {
  res.json({
    sessions: listBrowserUseResearchSessions({
      jobId: cleanText(req.query?.jobId || req.query?.job_id),
      activeOnly: req.query?.active === '1' || req.query?.active === 'true'
    })
  });
});

// Visible mock browser-use window: gives operators something to see when
// LIVE_BROWSER_RESEARCH is off. Real Browser Use sessions return their own
// liveUrl that points to docs.browser-use.com.
app.get('/mock/browser-use/:jobId/:sourceType', (req, res) => {
  const jobId = String(req.params.jobId || '');
  const sourceType = String(req.params.sourceType || '');
  const status = getBrowserResearchStatus({ jobId });
  const session = (status?.sessions || []).find((s) => s.sourceType === sourceType) || null;
  const businesses = (status?.businesses || []).filter((b) => (b.sources || []).some((src) => src.sourceType === sourceType));
  const job = status?.job || null;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderMockBrowserWindow({ jobId, sourceType, session, businesses, job }));
});

function renderMockBrowserWindow({ jobId, sourceType, session, businesses, job }) {
  const sourceLabel = session?.sourceLabel || sourceType || 'source';
  const niche = job?.niche || 'business';
  const city = job?.city || 'city';
  const url = `https://example.com/${escapeHtml(sourceType)}/${encodeURIComponent(niche)}-${encodeURIComponent(city)}`;
  const step = session?.lastStepSummary || 'Waiting for Browser Use...';
  const status = session?.normalizedStatus || 'queued';
  const cards = (businesses || []).slice(0, 8).map((b) => `
    <div class="biz">
      <div class="biz-name">${escapeHtml(b.businessName)}</div>
      <div class="biz-meta">${escapeHtml(b.address || 'address pending')}</div>
      <div class="biz-meta">${escapeHtml(b.phone || 'phone pending')} · ${escapeHtml(b.websiteUrl || 'no owned site')}</div>
      <div class="biz-presence presence-${escapeHtml(b.presenceStrength || 'unknown')}">${escapeHtml((b.presenceStrength || 'unknown').toUpperCase())} presence</div>
    </div>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Browser Use · ${escapeHtml(sourceLabel)}</title>
<meta http-equiv="refresh" content="2">
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1116; color: #e6edf3; }
.chrome { background: #161b22; border-bottom: 1px solid #30363d; padding: 6px 10px; display: flex; align-items: center; gap: 8px; }
.dots { display: flex; gap: 4px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #ff5f56; }
.dot.y { background: #ffbd2e; }
.dot.g { background: #27c93f; }
.url { flex: 1; background: #0d1116; border: 1px solid #30363d; padding: 4px 10px; font-size: 12px; color: #8b949e; border-radius: 4px; }
.tag { font-size: 10px; padding: 2px 6px; border: 1px solid #30363d; color: #58a6ff; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
.tag.live { color: #f97316; border-color: #f97316; animation: pulse 1.5s infinite; }
.tag.completed { color: #2ea043; border-color: #2ea043; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.body { padding: 14px 18px; }
.crumb { color: #8b949e; font-size: 11px; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.08em; }
h1 { margin: 0 0 4px; font-size: 18px; }
.lead { color: #8b949e; font-size: 12px; margin-bottom: 14px; }
.step { background: #161b22; border: 1px solid #30363d; padding: 8px 10px; font-size: 12px; color: #c9d1d9; margin-bottom: 16px; border-radius: 4px; }
.cursor { display: inline-block; width: 7px; height: 13px; background: #58a6ff; vertical-align: middle; margin-left: 4px; animation: blink 1s steps(2, start) infinite; }
@keyframes blink { to { visibility: hidden; } }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.biz { border: 1px solid #30363d; background: #0d1116; padding: 10px; border-radius: 4px; }
.biz-name { font-weight: 600; font-size: 13px; margin-bottom: 4px; }
.biz-meta { color: #8b949e; font-size: 11px; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.biz-presence { margin-top: 6px; font-size: 10px; letter-spacing: 0.08em; padding: 1px 6px; border-radius: 2px; display: inline-block; }
.presence-none, .presence-weak { background: rgba(46, 160, 67, 0.15); color: #56d364; }
.presence-mixed { background: rgba(187, 128, 9, 0.2); color: #f0883e; }
.presence-strong { background: rgba(248, 81, 73, 0.15); color: #f85149; }
.empty { color: #6e7681; font-size: 12px; padding: 30px; text-align: center; border: 1px dashed #30363d; border-radius: 4px; }
</style></head>
<body>
  <div class="chrome">
    <div class="dots"><span class="dot"></span><span class="dot y"></span><span class="dot g"></span></div>
    <div class="url">${escapeHtml(url)}</div>
    <span class="tag ${escapeHtml(status === 'completed' ? 'completed' : 'live')}">${escapeHtml(status)}</span>
  </div>
  <div class="body">
    <div class="crumb">Browser Use · ${escapeHtml(sourceLabel)} · job ${escapeHtml(jobId)}</div>
    <h1>${escapeHtml(niche)} in ${escapeHtml(city)}</h1>
    <div class="lead">Mock browser session. Each refresh shows the latest agent step + extracted businesses.</div>
    <div class="step">${escapeHtml(step)}<span class="cursor"></span></div>
    ${cards ? `<div class="grid">${cards}</div>` : `<div class="empty">Agent is still reading the page...</div>`}
  </div>
</body></html>`;
}

app.post('/api/leads/:id/call', (req, res) => {
  const parsed = CallRequest.safeParse({ leadId: req.params.id, ...req.body });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const lead = leads.get(parsed.data.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const phone = parsed.data.toPhone || lead.phone;
  if (env.runMode !== 'mock') {
    const gate = canRouteCallLead(lead.id, { explicitPhone: phone });
    if (!gate.ok) return res.status(409).json({ error: 'callability blocked', explanation: gate.explanation });
  }
  const job = fire('caller', { leadId: lead.id, toPhone: phone }, runCaller, { type: 'call.followup' });
  res.status(202).json({ accepted: true, mode: env.runMode, jobId: job?.id, jobStatus: job?.status });
});

app.post('/api/leads/:id/approve-live-call', (req, res) => {
  const result = approveLeadForLiveCall(req.params.id, { reason: req.body?.reason });
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json(result);
});

app.post('/api/leads/:id/block', (req, res) => {
  const reasonCode = reasonCodeFor(req.body?.reasonCode || req.body?.code || 'operator_blocked');
  const reason = cleanText(req.body?.reason) || 'Operator blocked lead before outreach';
  const result = blockLeadForOutreach(req.params.id, { reason: reasonCode });
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json({ ...result, blocker: { code: reasonCode, reason, source: 'operator' } });
});

app.post('/api/leads/:id/opt-out', (req, res) => {
  const reasonCode = reasonCodeFor(req.body?.reasonCode || 'operator_opt_out');
  const reason = cleanText(req.body?.reason) || 'Operator recorded do-not-call opt-out';
  const result = optOutLeadFromOutreach(req.params.id, { reason });
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json({ ...result, blocker: { code: reasonCode, reason, source: 'operator', phone: result.phone } });
});

app.post('/api/leads/:id/force-retry', (req, res) => {
  const reasonCode = reasonCodeFor(req.body?.reasonCode || 'operator_force_retry');
  const reason = cleanText(req.body?.reason) || 'Operator forced retry into outreach queue';
  const result = forceRetryLeadOutreach(req.params.id, { reason });
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json({ ...result, queueStatus: 'queued', reason: { code: reasonCode, reason, source: 'operator' } });
});

app.get('/api/leads/:id/callability', (req, res) => {
  const result = explainOutreachCallability(req.params.id, { explicitPhone: req.query?.phone });
  if (!result.ok && result.blockers?.[0]?.name === 'lead_found') return res.status(404).json(result);
  res.json(result);
});

app.get('/api/leads/:id/revenue', (req, res) => {
  const result = revenueStatusForLead(req.params.id);
  if (!result) return res.status(404).json({ error: 'lead not found' });
  res.json(result);
});

app.post('/api/outreach/start', (_req, res) => {
  res.json(resumeOutreachLoop({ reason: 'operator_start' }));
});

app.post('/api/outreach/stop', (_req, res) => {
  res.json(stopOutreachLoop());
});

app.post('/api/emergency-stop', (req, res) => {
  const result = stopOutreachLoop({ reason: req.body?.reason || 'emergency_stop' });
  emit('safety.emergency_stop', { worker: 'operator', mode: env.runMode, reason: req.body?.reason || 'emergency_stop' });
  res.json({ ok: true, ...result });
});

app.post('/api/outreach/pause', (req, res) => {
  res.json(pauseOutreachLoop({ reason: req.body?.reason || 'operator_pause' }));
});

app.post('/api/outreach/resume', (req, res) => {
  res.json(resumeOutreachLoop({ reason: req.body?.reason || 'operator_resume' }));
});

app.get('/api/outreach/status', (_req, res) => {
  res.json(outreachStatus());
});

app.get('/api/outreach/routes', (_req, res) => {
  res.json(outreachRouteSmoke());
});

app.get('/api/reputation/status', async (_req, res) => {
  try {
    const payload = await reputationStatus();
    res.json(payload);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.get('/api/browser-use/sessions', async (req, res) => {
  const limit = boundedLimit(req.query?.limit, 80, 200);
  const hydrate = req.query?.hydrate !== 'false';
  const rows = db.prepare(`
    SELECT
      b.*,
      l.business_name,
      l.niche,
      l.city,
      l.source_url,
      l.website AS lead_website,
      l.status AS lead_status
    FROM builds b
    LEFT JOIN leads l ON l.id = b.lead_id
    ORDER BY COALESCE(b.updated_at, b.started_at, 0) DESC
    LIMIT ?
  `).all(limit);

  const sessions = [];
  for (const row of rows) {
    sessions.push(await browserUseSessionFromBuild(row, { hydrate }));
  }

  res.json({
    ok: true,
    ts: Date.now(),
    mode: env.runMode,
    docs: {
      getSession: 'https://docs.browser-use.com/cloud/api-v3/sessions/get-session',
      livePreview: 'https://docs.browser-use.com/cloud/browser/live-preview',
      pricing: 'https://docs.browser-use.com/cloud/pricing'
    },
    counts: countBrowserUseSessions(sessions),
    telemetry: browserUseTelemetry(sessions),
    sessions
  });
});

app.get('/api/browser-use/events', (req, res) => {
  const limit = boundedLimit(req.query?.limit, 120, 300);
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT *
      FROM events
      WHERE
        type LIKE 'browserUse.%'
        OR type LIKE 'builder.%'
        OR type IN ('scraper.profile', 'scraper.item.failed', 'scraper.item.skipped')
      ORDER BY ts DESC, id DESC
      LIMIT ?
    )
    ORDER BY ts ASC, id ASC
  `).all(limit);

  const events = rows.map((row) => normalizeBrowserUseEvent(row)).filter(Boolean);
  res.json({
    ok: true,
    ts: Date.now(),
    mode: env.runMode,
    count: events.length,
    events
  });
});

app.post('/api/browser-use/sessions/:id/stop', async (req, res) => {
  const sessionId = cleanText(req.params.id);
  if (!sessionId) return res.status(400).json({ error: 'session id required' });
  const row = findBrowserUseBuild(sessionId);
  if (!row) return res.status(404).json({ error: 'browser use session not found' });

  const before = await browserUseSessionFromBuild(row, { hydrate: false });
  const mock = before.badges.mock || !isBrowserUseUuid(sessionId);
  let providerSession = null;
  let liveStopped = false;

  if (!mock) {
    if (!env.live.builds || !env.browserUse.apiKey) {
      return res.status(409).json({
        error: 'live Browser Use stop is gated',
        reason: 'Set LIVE_BUILDS=true with BROWSER_USE_API_KEY to stop a real cloud session.',
        session: before
      });
    }
    const adapter = new BrowserUseLovableAdapter({
      apiKey: env.browserUse.apiKey,
      baseUrl: env.browserUse.baseUrl
    });
    providerSession = await adapter.stopSession(sessionId);
    liveStopped = true;
  } else {
    providerSession = normalizeBrowserUseSessionSnapshot({
      id: sessionId,
      status: 'stopped',
      model: before.model,
      liveUrl: before.liveUrl,
      stepCount: before.stepCount,
      lastStepSummary: 'Operator stopped the synthetic Browser Use session.',
      totalInputTokens: before.totalInputTokens,
      totalOutputTokens: before.totalOutputTokens,
      llmCostUsd: before.llmCostUsd,
      proxyCostUsd: before.proxyCostUsd,
      browserCostUsd: before.browserCostUsd,
      totalCostUsd: before.totalCostUsd,
      screenshotUrl: before.screenshotUrl,
      integrationsUsed: before.integrationsUsed,
      updatedAt: new Date().toISOString()
    });
  }

  builds.update(row.id, { status: 'stopped', finished_at: Date.now(), error: null });
  emit('browserUse.session.stopped', {
    worker: 'builder',
    leadId: row.lead_id,
    buildId: row.id,
    sessionId,
    model: providerSession?.model || before.model,
    status: 'stopped',
    summary: 'Operator stopped Browser Use session.',
    liveUrl: providerSession?.liveUrl || before.liveUrl,
    stepCount: providerSession?.stepCount ?? before.stepCount,
    totalCostUsd: providerSession?.totalCostUsd || before.totalCostUsd,
    mock: !liveStopped
  });
  emit('builder.progress', {
    worker: 'builder',
    leadId: row.lead_id,
    buildId: row.id,
    sessionId,
    summary: 'Operator stopped Browser Use session.',
    liveUrl: providerSession?.liveUrl || before.liveUrl,
    stepCount: providerSession?.stepCount ?? before.stepCount,
    totalCostUsd: providerSession?.totalCostUsd || before.totalCostUsd,
    mock: !liveStopped
  });

  const updated = findBrowserUseBuild(sessionId);
  res.json({
    ok: true,
    liveStopped,
    session: await browserUseSessionFromBuild(updated, { hydrate: false, providerSession })
  });
});

app.post('/api/leads/:id/followup', (req, res) => {
  const parsed = FollowupRequest.safeParse({ leadId: req.params.id, ...req.body });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const lead = leads.get(parsed.data.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const job = fire('mailer', { leadId: lead.id, toEmail: parsed.data.toEmail }, runMailer, { type: 'mail.followup' });
  res.status(202).json({ accepted: true, jobId: job?.id, jobStatus: job?.status });
});

app.post('/api/leads/:id/build', (req, res) => {
  const parsed = BuildRequest.safeParse({ leadId: req.params.id, ...req.body });
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const lead = leads.get(parsed.data.leadId);
  if (!lead) return res.status(404).json({ error: 'lead not found' });
  const target = parsed.data.target || req.query?.target || undefined;
  const job = enqueueBuilderBuild({ leadId: lead.id, target, images: parsed.data.images || [], source: 'api' }).row;
  res.status(202).json({ accepted: true, target: target || 'default', jobId: job?.id, jobStatus: job?.status });
});

const previewScreenshotAdapter = (() => {
  let adapter = null;
  return () => {
    if (!env.browserUse.apiKey) return null;
    if (!adapter) adapter = new BrowserUseLovableAdapter();
    return adapter;
  };
})();

function sendPreviewScreenshotFallback(res, businessName) {
  const safe = (businessName || 'Your site').replace(/[<>&]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 630"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0a0a0a"/><stop offset="1" stop-color="#191d24"/></linearGradient></defs><rect width="1120" height="630" fill="url(#g)"/><rect x="32" y="32" width="1056" height="566" rx="14" fill="#0f0f0f" stroke="#2a2a2a"/><circle cx="68" cy="68" r="6" fill="#ff5f56"/><circle cx="92" cy="68" r="6" fill="#ffbd2e"/><circle cx="116" cy="68" r="6" fill="#27c93f"/><rect x="160" y="58" width="880" height="22" rx="6" fill="#1a1a1a"/><text x="180" y="74" font-family="-apple-system,Segoe UI,sans-serif" font-size="13" fill="#888">lovable.dev/${safe.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)} — building now</text><circle cx="130" cy="180" r="10" fill="#e74c3c"/><text x="155" y="186" font-family="-apple-system,Segoe UI,sans-serif" font-size="16" fill="#e74c3c" font-weight="700">LIVE</text><text x="120" y="290" font-family="-apple-system,Segoe UI,sans-serif" font-size="40" fill="#fafafa" font-weight="700">${safe}</text><text x="120" y="340" font-family="-apple-system,Segoe UI,sans-serif" font-size="20" fill="#aaa">Tap to watch the live build session →</text></svg>`;
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Content-Type', 'image/svg+xml');
  res.send(svg);
}

app.get('/api/preview-build/:buildId/screenshot.png', async (req, res) => {
  const buildId = req.params.buildId;
  const buildRow = builds.get(buildId);
  if (!buildRow) {
    sendPreviewScreenshotFallback(res, 'Your site');
    return;
  }
  const lead = leads.get(buildRow.lead_id);
  const businessName = lead?.business_name || 'Your site';

  const sessionId = buildRow.browser_session_id;
  if (!sessionId || sessionId.startsWith('mock-')) {
    sendPreviewScreenshotFallback(res, businessName);
    return;
  }

  const adapter = previewScreenshotAdapter();
  if (!adapter) {
    sendPreviewScreenshotFallback(res, businessName);
    return;
  }

  try {
    const session = await adapter.getSession(sessionId);
    const shotUrl = session?.screenshotUrl;
    if (!shotUrl) {
      sendPreviewScreenshotFallback(res, businessName);
      return;
    }
    const upstream = await fetch(shotUrl);
    if (!upstream.ok) {
      sendPreviewScreenshotFallback(res, businessName);
      return;
    }
    const contentType = upstream.headers.get('content-type') || 'image/png';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    log.warn('preview_build.screenshot_failed', { buildId, sessionId, err: err?.message || String(err) });
    sendPreviewScreenshotFallback(res, businessName);
  }
});

app.get('/api/leads/:id/build-preview', (req, res) => {
  const lead = leads.get(req.params.id);
  if (!lead) return res.status(404).send('<!doctype html><html><body>Lead not found.</body></html>');
  const latest = builds.listByLead(lead.id)[0] || {};
  const websiteBrief = safeJson(latest.website_brief_json);
  if (latest.preview_html || websiteBrief) {
    res.type('html').send(latest.preview_html || renderMockGeneratedSite({ brief: websiteBrief }));
    return;
  }
  res.type('html').send(renderMockGeneratedSite({ brief: fallbackWebsiteBriefForPreview(lead) }));
});

app.post('/api/webhooks/agentphone', async (req, res) => {
  const v = verifyAgentPhone(req, req.rawBody || Buffer.from(JSON.stringify(req.body)));
  if (!v.ok) {
    log.warn('agentphone webhook rejected', { reason: v.reason });
    return res.status(401).json({ error: v.reason });
  }
  const result = await handleAgentPhoneWebhook(req);
  res.json(result);
});

app.post('/api/webhooks/agentmail', async (req, res) => {
  const v = verifyAgentMail(req, req.rawBody || Buffer.from(JSON.stringify(req.body)));
  if (!v.ok) return res.status(401).json({ error: v.reason });
  const body = req.body || {};
  const msg = normalizeAgentMailWebhook(body);
  const eventId = agentMailWebhookEventId(req, body, msg);
  const recorded = webhookEvents.recordOnce({ provider: 'agentmail', event_id: eventId, type: msg.eventType, payload: body });
  if (!recorded) return res.json({ ok: true, duplicate: true });
  emit('agentmail.webhook', {
    worker: 'mailer',
    providerType: msg.eventType,
    threadId: msg.threadId,
    fromMasked: maskEmail(msg.fromEmail),
    subject: msg.subject,
    preview: typeof msg.text === 'string' ? msg.text.slice(0, 240) : undefined
  });
  if (isInboundAgentMailWebhook(body, msg)) {
    const queued = enqueueMailReplyJob({
      body,
      normalized: msg,
      eventId,
      source: 'agentmail.webhook',
      idempotencyKey: `agentmail:${eventId}`
    });
    return res.status(202).json({ ok: true, queued: true, jobId: queued.row?.id, eventId });
  }
  res.json({ ok: true });
});

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const v = verifyStripe(req.rawBody || req.body, sig);
  if (!v.ok) {
    log.warn('stripe webhook rejected', { reason: v.reason });
    return res.status(400).json({ error: v.reason });
  }
  const event = v.event;
  const result = processStripeWebhookEvent(event, { req, startBuilder });
  let subscription = null;
  if (typeof event?.type === 'string' && event.type.startsWith('customer.subscription.')) {
    try {
      subscription = await handleStripeSubscriptionEvent(event);
    } catch (err) {
      log.warn('hosting_subscription.webhook_failed', {
        eventType: event.type,
        error: err?.message || String(err)
      });
      subscription = { ok: false, reason: 'handler_threw', error: err?.message || String(err) };
    }
  }
  res.json(subscription ? { ...result, subscription } : result);
});

// Customer-facing one-click accept link from the hosting upsell email.
// 302-redirects to the Stripe Checkout URL so the customer never sees JSON.
app.get('/api/hosting/accept/:leadId', async (req, res) => {
  const leadId = String(req.params.leadId || '').trim();
  if (!leadId) return res.status(400).send('leadId required');
  try {
    const { url } = await acceptHostingSubscription({ leadId });
    if (!url) return res.status(502).send('Stripe Checkout URL missing');
    return res.redirect(302, url);
  } catch (err) {
    log.warn('hosting_subscription.accept_failed', {
      leadId,
      error: err?.message || String(err)
    });
    return res.status(500).send(`Could not start hosting subscription: ${err?.message || 'unknown error'}`);
  }
});

function portalAccessForRequest(req, res) {
  const token = String(req.params.token || '').trim();
  if (!token) {
    res.status(400).json({ error: 'token required' });
    return null;
  }
  const access = resolvePortalAccess(token);
  if (access?.ok && access.lead) return access;
  if (!access?.lead) {
    res.status(access?.status || 404).json({ error: access?.error || 'not found', reason: access?.reason || 'not_found' });
    return null;
  }
  return access;
}

function portalActionFailed(res, eventType, err, metadata = {}) {
  log.warn(eventType, { ...metadata, error: err?.message || String(err) });
  const status = err?.code === 'invalid_request' || err?.code === 'portal_action_type_mismatch'
    ? 400
    : err?.code === 'lead_not_found' || err?.code === 'portal_action_not_found'
      ? 404
      : 500;
  res.status(status).json({ error: err?.message || 'portal_action_failed' });
}

function customerCommerceState(commerce) {
  if (!commerce?.plan) return null;
  return {
    type: commerce.plan.type,
    status: commerce.plan.status,
    commerceCta: commerce.plan.commerceCta,
    customerCopy: commerce.plan.customerCopy,
    launchChecklist: commerce.plan.launchChecklist,
    stripeBoundary: {
      mode: commerce.plan.stripeBoundary?.mode || null,
      requiresStripe: !!commerce.plan.stripeBoundary?.requiresStripe,
      liveCustomerCommerceEnabled: !!commerce.plan.stripeBoundary?.liveCustomerCommerceEnabled,
      paymentLinks: []
    },
    riskFlags: commerce.plan.riskFlags || [],
    humanHandoff: commerce.plan.humanHandoff || null
  };
}

// --- per-customer share link (browser-use live preview + client operating room) ---
app.get('/api/share/build/:token', (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const lead = access.lead;
    const commerce = readCommerceState(lead.id);
    const trust = customerTrustSummaryForLead(lead.id);
    const aftercareRows = accountTasks.listByLead(lead.id, { limit: 30 });
    const aftercare = {
      pending: aftercareRows
        .filter((task) => ['pending', 'approved', 'paused'].includes(task.status))
        .slice(0, 6)
        .map(rowToCustomerAftercareTask),
      recent: aftercareRows
        .filter((task) => ['sent', 'completed', 'blocked'].includes(task.status))
        .slice(0, 6)
        .map(rowToCustomerAftercareTask)
    };
    res.json({
      ...portalState({ leadId: lead.id, access }),
      trust,
      aftercare,
      commerce: customerCommerceState(commerce)
    });
  } catch (err) {
    log.warn('portal.state_failed', { token: req.params.token, error: err?.message || String(err) });
    res.status(500).json({ error: err?.message || 'portal_state_failed' });
  }
});

// Customer-portal POST endpoints (token-scoped, auditable, idempotent where providers allow).
app.post('/api/share/build/:token/accept', async (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = await portalAcceptQuote({ leadId: access.lead.id, tokenId: access.tokenRow?.id || null });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.accept_quote_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/edit', async (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'note required' });
  try {
    const result = await portalRequestRevision({ leadId: access.lead.id, tokenId: access.tokenRow?.id || null, note });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.request_edit_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/approve-launch', async (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = await portalApproveLaunch({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      notes: req.body?.notes || ''
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.approve_launch_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/intake', async (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = await portalUpdateIntake({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      intake: req.body || {}
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.update_intake_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/scope/approve', (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = portalApproveScope({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      notes: req.body?.notes || ''
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.approve_scope_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/launch/approve', async (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = await portalApproveLaunch({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      notes: req.body?.notes || ''
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.approve_launch_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/revision', async (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  const note = String(req.body?.note || '').trim();
  if (!note) return res.status(400).json({ error: 'note required' });
  try {
    const result = await portalRequestRevision({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      buildId: req.body?.buildId || null,
      note
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.request_revision_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/asset', async (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = await portalRecordAssetUrl({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      url: req.body?.url,
      label: req.body?.label,
      notes: req.body?.notes
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.record_asset_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/callback', (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  const scheduledAtMs = Number(req.body?.scheduledAtMs);
  if (!Number.isFinite(scheduledAtMs) || scheduledAtMs <= 0) {
    return res.status(400).json({ error: 'scheduledAtMs required (epoch ms)' });
  }
  const ask = String(req.body?.ask || '').trim();
  try {
    const result = portalBookCallback({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      scheduledAtMs,
      ask
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.book_callback_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/commerce', async (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = await submitPortalCommerceIntake({
      leadId: access.lead.id,
      intake: req.body?.intake || req.body || {}
    });
    res.json({
      ok: true,
      type: result.plan.type,
      status: result.plan.status,
      plan: result.plan,
      contactEventId: result.contactEventId
    });
  } catch (err) {
    portalActionFailed(res, 'portal.commerce_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/renewal/review', (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = portalReviewRenewalPlan({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      subscriptionId: req.body?.subscriptionId || null,
      note: req.body?.note || ''
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.renewal_review_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/renewal/change-request', (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = portalRequestRenewalChange({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      subscriptionId: req.body?.subscriptionId || null,
      note: req.body?.note || '',
      requestType: req.body?.requestType || 'change'
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.renewal_change_request_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/renewal/confirmations/:confirmationId/acknowledge', (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = portalAcknowledgeRenewalCustomerConfirmation({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      confirmationId: req.params.confirmationId,
      note: req.body?.note || ''
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.renewal_confirmation_acknowledge_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/renewal/confirmations/:confirmationId/accept', (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const result = portalAcceptRenewalCustomerConfirmation({
      leadId: access.lead.id,
      tokenId: access.tokenRow?.id || null,
      confirmationId: req.params.confirmationId,
      note: req.body?.note || ''
    });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.renewal_confirmation_accept_failed', err, { token: req.params.token });
  }
});

app.post('/api/share/build/:token/opt-out', (req, res) => {
  const access = portalAccessForRequest(req, res);
  if (!access) return;
  try {
    const reason = String(req.body?.reason || '').trim() || 'customer_portal_opt_out';
    const result = portalOptOut({ leadId: access.lead.id, tokenId: access.tokenRow?.id || null, reason });
    res.json(result);
  } catch (err) {
    portalActionFailed(res, 'portal.opt_out_failed', err, { token: req.params.token });
  }
});

// Experiments rollup. `GET /api/experiments` returns the full set of known
// experiment keys plus per-arm assignment/conversion/revenue rollups.
app.get('/api/experiments', (_req, res) => {
  const keys = listExperimentKeys();
  const rollups = {};
  for (const key of keys) {
    try { rollups[key] = experimentRollup(key); }
    catch (err) {
      log.warn('experiments.rollup_failed', { key, error: err?.message || String(err) });
      rollups[key] = [];
    }
  }
  res.json({ keys, rollups });
});

// `GET /api/experiments/:key` returns the rollup for a single experiment.
app.get('/api/experiments/:key', (req, res) => {
  const key = String(req.params.key || '').trim();
  if (!key) return res.status(400).json({ error: 'key required' });
  try {
    res.json({ key, rollup: experimentRollup(key) });
  } catch (err) {
    log.warn('experiments.rollup_failed', { key, error: err?.message || String(err) });
    res.status(500).json({ error: 'rollup_failed' });
  }
});

// Dashboard data: upcoming + recent scheduled callbacks.
app.get('/api/scheduled-calls', (req, res) => {
  const pending = scheduledCallsDb.listPending({ limit: 25 }).map(rowToScheduledCallDTO);
  const recent = scheduledCallsDb.listRecent({ limit: 25 }).map(rowToScheduledCallDTO);
  res.json({ pending, recent });
});

// Operator-cancel a pending scheduled callback (used by the right-rail card).
app.post('/api/scheduled-calls/:id/cancel', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });
  const row = cancelScheduledCall(id, { reason: req.body?.reason || 'operator_cancel' });
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, scheduledCall: rowToScheduledCallDTO(row) });
});

// Operator: fire a pending callback immediately (used by the right-rail "fire now" button).
app.post('/api/scheduled-calls/:id/fire', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id required' });
  const row = fireScheduledCallNow(id, { reason: req.body?.reason || 'operator_fire_now' });
  if (!row) return res.status(409).json({ error: 'row not pending or not found' });
  res.json({ ok: true, scheduledCall: rowToScheduledCallDTO(row) });
});

// --- referral loop -----------------------------------------------------------
// /r/:leadId — log the click, then 302 to the landing page. In production this
// would point to a marketing site; for now we redirect to the dashboard root.
app.get('/r/:leadId', (req, res) => {
  try {
    recordReferralClick(req, req.params?.leadId);
  } catch (err) {
    log.warn('referrals.record_failed', { error: err?.message || String(err) });
  }
  res.redirect(302, '/');
});

// /api/referrals/rollup — top-30 referring leads + total click count. Powers
// the "Built by callmemaybe" rollup in the operator dashboard.
app.get('/api/referrals/rollup', (req, res) => {
  const limit = Number(req.query?.limit);
  const top = referralRollup({ limit: Number.isFinite(limit) && limit > 0 ? limit : 30 });
  res.json({
    ok: true,
    ts: Date.now(),
    totalClicks: totalReferralClicks(),
    topReferrers: top
  });
});

// /api/referrals/landing-html — utility preview that mimics the page a referral
// visitor will land on. Lets the operator eyeball the funnel without leaving
// the dashboard. The form POSTs niche+city to /api/leads/discover.
app.get('/api/referrals/landing-html', (_req, res) => {
  res.type('html').send(renderReferralLandingHtml());
});

app.use(express.static('dist'));
app.get('*', (_req, res) => {
  res.sendFile(`${process.cwd()}/dist/index.html`, (err) => {
    if (err) res.status(200).send('<!doctype html><html><body><p>UI not built. Run <code>npm run build</code>.</p></body></html>');
  });
});

app.listen(env.port, () => {
  log.info(`callmemaybe server listening`, { port: env.port, mode: env.runMode });
  startDurableJobLoop(durableJobHandlers);
  try {
    log.info('ops.backup_scheduler_start', startOpsBackupScheduler());
  } catch (err) {
    log.warn('ops.backup_scheduler_start_failed', { error: err?.message || String(err) });
  }
  try {
    log.info('ops.provider_posture_scheduler_start', startProviderPostureScheduler());
  } catch (err) {
    log.warn('ops.provider_posture_scheduler_start_failed', { error: err?.message || String(err) });
  }
  try {
    log.info('ops.recover_stuck_scheduler_start', startOpsRecoveryScheduler());
  } catch (err) {
    log.warn('ops.recover_stuck_scheduler_start_failed', { error: err?.message || String(err) });
  }
  try {
    log.info('ops.retention_command_lease_maintenance_scheduler_start', startRetentionCommandLeaseMaintenanceScheduler());
  } catch (err) {
    log.warn('ops.retention_command_lease_maintenance_scheduler_start_failed', { error: err?.message || String(err) });
  }
  try {
    log.info('safe_to_sell.scheduler_start', startSafeToSellSelfCheckScheduler());
  } catch (err) {
    log.warn('safe_to_sell.scheduler_start_failed', { error: err?.message || String(err) });
  }
  try {
    log.info('safe_to_renew.scheduler_start', startSafeToRenewSelfCheckScheduler());
  } catch (err) {
    log.warn('safe_to_renew.scheduler_start_failed', { error: err?.message || String(err) });
  }
  const recovered = recoverTriggeredPaymentBuilds({ startBuilder });
  if (recovered.length) log.warn('builder.recovered_pending_payment_builds', { count: recovered.length });

  // Scheduled-callback service: wire dispatcher then start the loop.
  registerScheduledCallDispatcher(runScheduledCaller);
  startScheduledCallLoop();

  // Account-manager aftercare service. Dry-run by default; live AgentMail
  // still needs ACCOUNT_MANAGER_LIVE_SENDS, LIVE_EMAILS, allow-list/run-mode,
  // and operator-approved tasks.
  try {
    startAccountManagerLoop();
  } catch (err) {
    log.warn('account_manager.loop_start_failed', { error: err?.message || String(err) });
  }

  // Reputation auto-throttle: 30s sweep that emits reputation.alert and can
  // pause the outreach loop when opt-out or voicemail-only rates go red.
  try {
    startReputationLoop();
  } catch (err) {
    log.warn('reputation.loop_start_failed', { error: err?.message || String(err) });
  }

  // Inbound email poller — picks up "call me" emails even when the AgentMail
  // webhook isn't pointed at the local tunnel. Bootstraps on first tick.
  import('./agentmailPoller.js').then(({ startAgentMailPoller }) => {
    startAgentMailPoller();
  }).catch((err) => log.warn('agentmail.poll.start_failed', { error: err?.message || String(err) }));

  // One-shot: PATCH the AgentPhone agent record with the operator's transfer
  // number so the platform can warm-transfer any time our server requests it.
  // Cached internally so it only fires once per process boot.
  ensureOperatorTransferConfigured().catch((err) => log.warn('operator.transfer.boot_configure_failed', {
    error: err?.message || String(err)
  }));
});

function rowToScheduledCallDTO(row) {
  if (!row) return null;
  const lead = row.lead_id ? leads.get(row.lead_id) : null;
  let brief = null;
  if (row.brief_json) {
    try { brief = JSON.parse(row.brief_json); } catch { brief = null; }
  }
  return {
    id: row.id,
    leadId: row.lead_id,
    threadId: row.thread_id,
    scheduledAtMs: row.scheduled_at_ms,
    status: row.status,
    brief,
    ask: brief?.ask || null,
    attempts: row.attempts,
    createdAt: row.created_at,
    firedAt: row.fired_at,
    placedCallId: row.placed_call_id,
    failureReason: row.failure_reason,
    lead: lead ? {
      id: lead.id,
      business_name: lead.business_name,
      phone: lead.phone,
      city: lead.city,
      status: lead.status
    } : null
  };
}

function rowToCustomerAftercareTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    status: task.status,
    dueAt: task.due_at,
    priority: task.priority,
    channel: task.channel,
    summary: task.summary,
    lastPreviewedAt: task.last_previewed_at,
    sentAt: task.sent_at,
    completedAt: task.completed_at
  };
}

function explainLeadCallability(lead) {
  const disclosureText = recordingDisclosure(lead.business_name);
  const callability = callabilityForLead({ lead, disclosureText });
  const readiness = liveReadiness();
  const operatorBlock = latestOperatorBlock(lead.id);
  const blockers = [];

  if (!callability.ok) {
    blockers.push({
      code: reasonCodeFor(callability.reason),
      reason: callability.reason,
      source: 'callability'
    });
  }
  if (lead.outreach_status === 'blocked') {
    blockers.push({
      code: operatorBlock?.reasonCode || reasonCodeFor(lead.risk_status || 'blocked'),
      reason: operatorBlock?.reason || lead.risk_status || 'blocked',
      source: operatorBlock ? 'operator' : 'lead.risk_status'
    });
  }
  for (const reason of readiness.blockers || []) {
    blockers.push({
      code: reasonCodeFor(reason),
      reason,
      source: 'readiness'
    });
  }

  return {
    leadId: lead.id,
    decision: blockers.length ? 'blocked' : 'callable',
    callability: {
      ok: callability.ok,
      reason: callability.reason,
      reasonCode: reasonCodeFor(callability.reason),
      phone: callability.phone || null,
      phoneClassification: callability.phoneClassification || lead.phone_classification || 'unknown'
    },
    blockers: dedupeBlockers(blockers),
    status: statusSnapshot(lead),
    readiness: {
      ready: readiness.ready,
      mode: readiness.mode,
      blockers: readiness.blockers || []
    },
    disclosureText
  };
}

function recordOperatorEvent({ lead, type, reasonCode, reason, previous, extra = {} }) {
  contactEvents.add({
    lead_id: lead.id,
    type,
    direction: 'internal',
    channel: 'operator',
    body: reason,
    metadata: {
      reasonCode,
      previous,
      ...extra
    }
  });
}

function latestOperatorBlock(leadId) {
  const event = contactEvents
    .listByLead(leadId, { limit: 20 })
    .find((row) => row.channel === 'operator' && ['operator_blocked', 'operator_opt_out'].includes(row.type));
  if (!event) return null;
  const metadata = parseJson(event.metadata_json);
  return {
    reasonCode: metadata?.reasonCode || reasonCodeFor(event.type),
    reason: event.body || metadata?.reasonCode || event.type
  };
}

function statusSnapshot(lead) {
  return {
    outreachStatus: lead.outreach_status || 'unknown',
    riskStatus: lead.risk_status || 'unknown',
    consentStatus: lead.consent_status || 'unknown',
    phoneClassification: lead.phone_classification || 'unknown',
    nextAction: lead.next_action || null
  };
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function reasonCodeFor(value) {
  const code = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return code || 'unknown';
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function retentionReadSnapshot(req) {
  const query = req.query || {};
  const workspaceId = cleanText(query.workspaceId || query.workspace_id) || 'ws_callan';
  const limit = boundedLimit(query.limit, 50, 200);
  const snapshot = portfolioOperatingModel.snapshot({ workspaceId, limit });
  return {
    workspaceId,
    limit,
    snapshot,
    filters: retentionReadFilters(query)
  };
}

function retentionReadFilters(query = {}) {
  return {
    workspaceId: cleanText(query.workspaceId || query.workspace_id) || 'ws_callan',
    serviceBusinessId: cleanText(query.serviceBusinessId || query.service_business_id) || null,
    customerId: cleanText(query.customerId || query.customer_id) || null,
    jobId: cleanText(query.jobId || query.job_id) || null,
    status: cleanText(query.status) || null,
    provider: cleanText(query.provider) || null,
    priority: cleanText(query.priority) || null,
    retentionStatus: cleanText(query.retentionStatus || query.retention_status) || null,
    playbookKind: cleanText(query.playbookKind || query.playbook_kind) || null,
    recommendedOfferKey: cleanText(query.recommendedOfferKey || query.recommended_offer_key) || null,
    retentionPlaybookId: cleanText(query.retentionPlaybookId || query.retention_playbook_id) || null,
    receiptMode: cleanText(query.receiptMode || query.receipt_mode || query.mode) || null,
    receiptStatus: cleanText(query.receiptStatus || query.receipt_status) || null,
    retentionCohortRollupId: cleanText(query.retentionCohortRollupId || query.retention_cohort_rollup_id) || null,
    cohortKey: cleanText(query.cohortKey || query.cohort_key) || null,
    segment: cleanText(query.segment) || null,
    retentionCapitalFeedbackReceiptId: cleanText(query.retentionCapitalFeedbackReceiptId || query.retention_capital_feedback_receipt_id) || null,
    feedbackKind: cleanText(query.feedbackKind || query.feedback_kind) || null,
    recommendation: cleanText(query.recommendation) || null,
    serviceDecisionFusionReceiptId: cleanText(query.serviceDecisionFusionReceiptId || query.service_decision_fusion_receipt_id) || null,
    decisionKind: cleanText(query.decisionKind || query.decision_kind) || null,
    decision: cleanText(query.decision) || null,
    executionKind: cleanText(query.executionKind || query.execution_kind) || null,
    executionScope: cleanText(query.executionScope || query.execution_scope) || null,
    serviceDecisionExecutionReceiptId: cleanText(query.serviceDecisionExecutionReceiptId || query.service_decision_execution_receipt_id) || null,
    serviceDecisionLiveExecuteDenialId: cleanText(query.serviceDecisionLiveExecuteDenialId || query.service_decision_live_execute_denial_id) || null,
    denialReason: cleanText(query.denialReason || query.denial_reason) || null,
    runMode: cleanText(query.runMode || query.run_mode) || null,
    distributionKind: cleanText(query.distributionKind || query.distribution_kind) || null,
    decisionDistributionReceiptId: cleanText(query.decisionDistributionReceiptId || query.decision_distribution_receipt_id) || null,
    decisionWorkItemId: cleanText(query.decisionWorkItemId || query.decision_work_item_id) || null,
    workItemKind: cleanText(query.workItemKind || query.work_item_kind) || null,
    audience: cleanText(query.audience) || null,
    readinessReconciliationId: cleanText(query.readinessReconciliationId || query.readiness_reconciliation_id) || null,
    workflowInstanceId: cleanText(query.workflowInstanceId || query.workflow_instance_id) || null,
    compensationPlanId: cleanText(query.compensationPlanId || query.compensation_plan_id) || null,
    compensationReceiptId: cleanText(query.compensationReceiptId || query.compensation_receipt_id) || null,
    readinessEvidenceReviewReceiptId: cleanText(query.readinessEvidenceReviewReceiptId || query.readiness_evidence_review_receipt_id) || null,
    readinessReleasePreflightReceiptId: cleanText(query.readinessReleasePreflightReceiptId || query.readiness_release_preflight_receipt_id) || null,
    releaseKind: cleanText(query.releaseKind || query.release_kind) || null,
    blockerKey: cleanText(query.blockerKey || query.blocker_key) || null,
    reviewKind: cleanText(query.reviewKind || query.review_kind) || null,
    planKind: cleanText(query.planKind || query.plan_kind) || null,
    actionKind: cleanText(query.actionKind || query.action_kind) || null,
    proofKey: cleanText(query.proofKey || query.proof_key) || null
  };
}

function liveReleaseBlockerQueueFilters(query = {}, filters = {}) {
  const staleOnlyRaw = cleanText(query.staleOnly || query.stale_only).toLowerCase();
  return {
    ...filters,
    urgencyBand: cleanText(query.urgencyBand || query.urgency_band) || null,
    staleOnly: ['1', 'true', 'yes', 'stale'].includes(staleOnlyRaw)
  };
}

function normalizeLiveReleaseBlockerQueueExportReviewReceipt(receipt = {}) {
  const filterSummary = receipt.filterSummary || receipt.filter_summary || {};
  const integrityManifest = receipt.integrityManifest || receipt.integrity_manifest || {};
  return {
    ...receipt,
    filterSummary,
    integrityManifest,
    commandIds: receipt.commandIds || receipt.command_ids || [],
    readOnly: true,
    externalSideEffects: false
  };
}

function listLiveReleaseBlockerQueueExportReviewReceiptsForFilters({
  workspaceId,
  checksum = null,
  reviewKind = null,
  status = null,
  filters = {},
  limit = 100
} = {}) {
  const cappedLimit = boundedLimit(limit, 100, 500);
  return portfolioOperatingModel.listLiveReleaseBlockerQueueExportReviewReceipts({
    workspaceId,
    checksum,
    reviewKind,
    status,
    limit: 500
  })
    .map(normalizeLiveReleaseBlockerQueueExportReviewReceipt)
    .filter((receipt) => matchesLiveReleaseBlockerQueueExportReviewFilters(receipt, filters))
    .slice(0, cappedLimit);
}

function buildLiveReleaseBlockerQueueExportReviewComparison({ workspaceId, filters = {}, currentChecksum = null } = {}) {
  const checksum = cleanText(currentChecksum);
  const latest = listLiveReleaseBlockerQueueExportReviewReceiptsForFilters({
    workspaceId,
    filters,
    status: 'reviewed_redacted_queue_export',
    limit: 1
  })[0] || null;
  const status = latest
    ? latest.checksum === checksum ? 'matches_latest_acknowledgement' : 'changed_since_latest_acknowledgement'
    : 'unacknowledged';
  return {
    kind: 'service_decision_live_release_blocker_queue_export_review_comparison',
    status,
    filterSummary: {
      urgencyBand: filters.urgencyBand || null,
      denialReason: filters.denialReason || null,
      staleOnly: filters.staleOnly === true
    },
    currentChecksum: checksum || null,
    latestAcknowledgedChecksum: latest?.checksum || null,
    latestReceiptId: latest?.id || null,
    readOnly: true,
    blockersResolved: false,
    liveExecutionAllowed: false,
    externalSideEffects: false
  };
}

function matchesLiveReleaseBlockerQueueExportReviewFilters(receipt = {}, filters = {}) {
  const summary = receipt.filterSummary || receipt.filter_summary || {};
  if (filters.urgencyBand && summary.urgencyBand !== filters.urgencyBand) return false;
  if (filters.denialReason && summary.denialReason !== filters.denialReason) return false;
  if (filters.staleOnly && summary.staleOnly !== true) return false;
  return true;
}

function matchesLiveReleaseBlockerQueueFilters(command, filters = {}) {
  const digest = command?.liveReleaseBlockerDigest || {};
  const urgency = digest.denialUrgency || {};
  const denials = digest.liveExecuteDenials || {};
  if (filters.urgencyBand && urgency.urgencyBand !== filters.urgencyBand) return false;
  if (filters.denialReason) {
    const byDenialReason = denials.byDenialReason && typeof denials.byDenialReason === 'object'
      ? denials.byDenialReason
      : {};
    if ((byDenialReason[filters.denialReason] || 0) <= 0) return false;
  }
  if (filters.staleOnly && urgency.stale !== true) return false;
  return true;
}

function buildLiveReleaseBlockerQueueFacets(commands = []) {
  const urgencyBands = {};
  const denialReasons = {};
  const denialReasonCommandCounts = {};
  let staleCount = 0;
  for (const command of commands) {
    const digest = command?.liveReleaseBlockerDigest || {};
    const urgency = digest.denialUrgency || {};
    const band = urgency.urgencyBand || 'none';
    urgencyBands[band] = (urgencyBands[band] || 0) + 1;
    if (urgency.stale === true) staleCount += 1;
    const byDenialReason = digest.liveExecuteDenials?.byDenialReason || {};
    for (const [reason, count] of Object.entries(byDenialReason)) {
      const denialCount = Number(count) || 0;
      if (denialCount <= 0) continue;
      denialReasons[reason] = (denialReasons[reason] || 0) + denialCount;
      denialReasonCommandCounts[reason] = (denialReasonCommandCounts[reason] || 0) + 1;
    }
  }
  return {
    kind: 'service_decision_live_release_blocker_queue_facets',
    readOnly: true,
    externalSideEffects: false,
    totalReleaseBlockedCount: commands.length,
    staleCount,
    urgencyBands,
    denialReasons,
    denialReasonCommandCounts
  };
}

function buildLiveReleaseBlockerQueueExport({ filters = {}, facets = {}, commands = [] } = {}) {
  const redactedCommands = commands.map(redactedLiveReleaseBlockerCommand);
  const redactionManifest = {
    rawRequestPayloadsIncluded: false,
    rawResponsePayloadsIncluded: false,
    rawEvidencePayloadsIncluded: false,
    rawProofPayloadsIncluded: false,
    secretValuesIncluded: false,
    includedFields: [
      'ids',
      'service business labels',
      'blocker keys',
      'readiness counts',
      'denial counts',
      'urgency metadata',
      'safe action endpoints'
    ]
  };
  const integritySource = {
    filters,
    facets,
    commandIds: redactedCommands.map((command) => command.id),
    latestDenialIds: redactedCommands.map((command) => command.sourceAncestry?.latestDenialId || null),
    redaction: {
      rawRequestPayloadsIncluded: redactionManifest.rawRequestPayloadsIncluded,
      rawResponsePayloadsIncluded: redactionManifest.rawResponsePayloadsIncluded,
      rawEvidencePayloadsIncluded: redactionManifest.rawEvidencePayloadsIncluded,
      rawProofPayloadsIncluded: redactionManifest.rawProofPayloadsIncluded,
      secretValuesIncluded: redactionManifest.secretValuesIncluded
    }
  };
  return {
    kind: 'service_decision_live_release_blocker_queue_export',
    filters,
    filterSummary: {
      urgencyBand: filters.urgencyBand,
      denialReason: filters.denialReason,
      staleOnly: filters.staleOnly
    },
    redacted: true,
    readOnly: true,
    externalSideEffects: false,
    count: redactedCommands.length,
    facets,
    commands: redactedCommands,
    redactionManifest,
    integrityManifest: {
      kind: 'service_decision_live_release_blocker_queue_export_integrity',
      algorithm: 'sha256',
      checksum: createHash('sha256').update(stableJson(integritySource)).digest('hex'),
      commandCount: redactedCommands.length,
      commandIds: integritySource.commandIds,
      filterKeys: Object.keys(filters).filter((key) => filters[key] !== null && filters[key] !== undefined && filters[key] !== '').sort(),
      facetKeys: Object.keys(facets || {}).sort(),
      redactionSettings: integritySource.redaction,
      externalSideEffects: false,
      readOnly: true
    }
  };
}

function redactedLiveReleaseBlockerCommand(command = {}) {
  const digest = command.liveReleaseBlockerDigest || {};
  const denials = digest.liveExecuteDenials || {};
  return {
    id: command.id,
    workspaceId: command.workspace_id,
    serviceBusinessId: command.serviceBusinessId,
    serviceBusinessName: command.serviceBusinessName,
    serviceDecisionExecutionReceiptId: command.serviceDecisionExecutionReceiptId,
    workflowInstanceId: command.workflowInstanceId,
    workflowKey: command.workflowKey,
    status: command.status,
    releaseStatus: digest.status || null,
    releasePreflightBlocked: digest.releasePreflightBlocked === true,
    blockerCount: digest.blockerCount || 0,
    blockers: Array.isArray(digest.blockers) ? digest.blockers : [],
    clearedCount: digest.clearedCount || 0,
    remainingProofBlockers: Array.isArray(digest.remainingProofBlockers) ? digest.remainingProofBlockers : [],
    runtimeBlockers: Array.isArray(digest.runtimeBlockers) ? digest.runtimeBlockers : [],
    pendingReview: digest.pendingReview || {},
    evidence: digest.evidence || {},
    adapterLedger: digest.adapterLedger || {},
    providerSmoke: digest.providerSmoke || {},
    denialUrgency: digest.denialUrgency || {},
    liveExecuteDenials: {
      denialCount: denials.denialCount || 0,
      byDenialReason: denials.byDenialReason || {},
      repeatedAttemptCount: denials.repeatedAttemptCount || 0,
      latestDenialId: denials.latestDenialId || null,
      latestDenialReason: denials.latestDenialReason || null,
      latestRunMode: denials.latestRunMode || null,
      distinctBlockerKeys: Array.isArray(denials.distinctBlockerKeys) ? denials.distinctBlockerKeys : [],
      incidentEndpoint: denials.incidentEndpoint || null,
      denialsEndpoint: denials.denialsEndpoint || null,
      exportEndpoint: denials.exportEndpoint || null
    },
    sourceAncestry: {
      kind: 'service_decision_live_release_blocker_export_ancestry',
      readinessReconciliationId: command.id,
      serviceDecisionExecutionReceiptId: command.serviceDecisionExecutionReceiptId,
      workflowInstanceId: command.workflowInstanceId,
      latestDenialId: denials.latestDenialId || null,
      latestDenialReason: denials.latestDenialReason || null,
      commandEndpoint: `/api/portfolio/readiness-command-center/${encodeURIComponent(command.id || '')}`,
      denialsEndpoint: denials.denialsEndpoint || null,
      incidentEndpoint: denials.incidentEndpoint || null,
      redactedDenialExportEndpoint: denials.exportEndpoint || null,
      redacted: true,
      externalSideEffects: false
    },
    nextRequiredActions: Array.isArray(digest.nextRequiredActions)
      ? digest.nextRequiredActions.map((action) => ({
        blocker: action.blocker || null,
        label: action.label || null,
        action: action.action || null,
        endpoint: action.endpoint || null,
        denialCount: action.denialCount || undefined,
        urgencyBand: action.urgencyBand || undefined,
        redacted: action.redacted === true,
        externalSideEffects: action.externalSideEffects === true
      }))
      : []
  };
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
}

function redactKnownSecretText(value) {
  if (typeof value !== 'string') return value || null;
  return value
    .replace(/\bgithub_token\s*[:=]\s*\S+/gi, 'github_token=[redacted]')
    .replace(/\bstripe_live_secret\s*[:=]\s*\S+/gi, 'stripe_live_secret=[redacted]')
    .replace(/\bwebhook_secret\s*[:=]\s*\S+/gi, 'webhook_secret=[redacted]')
    .replace(/\bghp_[A-Za-z0-9_]+\b/g, '[redacted_github_token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[redacted_github_token]')
    .replace(/\bsk_live_[A-Za-z0-9_]+\b/g, '[redacted_stripe_secret]')
    .replace(/\bwhsec_[A-Za-z0-9_]+\b/g, '[redacted_webhook_secret]');
}

function retentionReadEnvelope(snapshot, payload = {}) {
  return {
    ok: true,
    workspaceId: snapshot.workspace?.id || payload.filters?.workspaceId || 'ws_callan',
    generatedAt: Date.now(),
    source: 'portfolio_operating_model_snapshot',
    readOnly: true,
    safety: {
      kind: 'retention_read_surface_safety',
      externalSideEffects: false,
      readOnly: true,
      customerMessageSent: false,
      offerSent: false,
      priceChangedLive: false,
      paymentLinkCreated: false,
      bookingScheduled: false,
      financeRollupMutated: false,
      playbookMutated: false,
      cohortRollupMutated: false,
      jobEnqueued: false,
      providerCalled: false,
      adapterInvoked: false
    },
    ...payload
  };
}

function decisionReadEnvelope(snapshot, payload = {}) {
  return {
    ok: true,
    workspaceId: snapshot.workspace?.id || payload.filters?.workspaceId || 'ws_callan',
    generatedAt: Date.now(),
    source: 'portfolio_operating_model_snapshot',
    readOnly: true,
    safety: {
      kind: 'service_decision_read_surface_safety',
      externalSideEffects: false,
      readOnly: true,
      customerMessageSent: false,
      offerSent: false,
      priceChangedLive: false,
      paymentLinkCreated: false,
      bookingScheduled: false,
      financeRollupMutated: false,
      playbookMutated: false,
      cohortRollupMutated: false,
      capitalAllocationMutated: false,
      budgetMoved: false,
      providerBudgetMutated: false,
      serviceShutdownChanged: false,
      vendorReassigned: false,
      refundIssued: false,
      workItemMutated: false,
      distributionMutated: false,
      jobEnqueued: false,
      providerCalled: false,
      adapterInvoked: false
    },
    ...payload
  };
}

function sendPortfolioCommandError(res, err, fallbackCode = 'PORTFOLIO_COMMAND_FAILED') {
  const message = err?.message || String(err || 'portfolio command failed');
  const isNotFound = /not found/i.test(message);
  const isBadRequest = /unsupported|required|invalid/i.test(message);
  const status = isNotFound ? 404 : isBadRequest ? 400 : 500;
  const code = isNotFound ? 'PORTFOLIO_COMMAND_NOT_FOUND' : isBadRequest ? 'PORTFOLIO_COMMAND_INVALID' : fallbackCode;
  return res.status(status).json({
    ok: false,
    code,
    error: message
  });
}

function matchesFilter(value, expected) {
  return !expected || value === expected;
}

function filterRetentionPlaybooks(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.customer_id, filters.customerId) &&
    matchesFilter(item.job_id, filters.jobId) &&
    matchesFilter(item.status, filters.status) &&
    matchesFilter(item.priority, filters.priority) &&
    matchesFilter(item.retention_status, filters.retentionStatus) &&
    matchesFilter(item.playbook_kind, filters.playbookKind) &&
    matchesFilter(item.recommended_offer_key, filters.recommendedOfferKey)
  ));
}

function filterRetentionPlaybookReceipts(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.customer_id, filters.customerId) &&
    matchesFilter(item.job_id, filters.jobId) &&
    matchesFilter(item.retention_playbook_id, filters.retentionPlaybookId) &&
    matchesFilter(item.mode, filters.receiptMode) &&
    matchesFilter(item.status, filters.receiptStatus)
  ));
}

function filterRetentionCohortRollups(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.retentionCohortRollupId) &&
    matchesFilter(item.cohort_key, filters.cohortKey) &&
    matchesFilter(item.segment, filters.segment) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterRetentionCommandCenter(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.serviceBusinessId, filters.serviceBusinessId) &&
    matchesFilter(item.retentionCohortRollupId, filters.retentionCohortRollupId) &&
    matchesFilter(item.cohortKey, filters.cohortKey) &&
    matchesFilter(item.segment, filters.segment) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterRetentionCapitalFeedbackReceipts(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.retentionCapitalFeedbackReceiptId) &&
    matchesFilter(item.retention_cohort_rollup_id, filters.retentionCohortRollupId) &&
    matchesFilter(item.feedback_kind, filters.feedbackKind) &&
    matchesFilter(item.recommendation, filters.recommendation) &&
    matchesFilter(item.priority, filters.priority) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterServiceDecisionFusionReceipts(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.serviceDecisionFusionReceiptId) &&
    matchesFilter(item.retention_capital_feedback_receipt_id, filters.retentionCapitalFeedbackReceiptId) &&
    matchesFilter(item.retention_cohort_rollup_id, filters.retentionCohortRollupId) &&
    matchesFilter(item.decision_kind, filters.decisionKind) &&
    matchesFilter(item.decision, filters.decision) &&
    matchesFilter(item.priority, filters.priority) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterServiceDecisionExecutionReceipts(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.service_decision_fusion_receipt_id, filters.serviceDecisionFusionReceiptId) &&
    matchesFilter(item.decision, filters.decision) &&
    matchesFilter(item.execution_kind, filters.executionKind) &&
    matchesFilter(item.execution_scope, filters.executionScope) &&
    matchesFilter(item.mode, filters.receiptMode) &&
    matchesFilter(item.status, filters.receiptStatus || filters.status)
  ));
}

function filterServiceDecisionLiveExecuteDenials(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.serviceDecisionLiveExecuteDenialId) &&
    matchesFilter(item.service_decision_fusion_receipt_id, filters.serviceDecisionFusionReceiptId) &&
    (!filters.serviceDecisionExecutionReceiptId ||
      item.source_service_decision_execution_receipt_id === filters.serviceDecisionExecutionReceiptId ||
      item.ready_live_preflight_receipt_id === filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.denial_reason, filters.denialReason) &&
    matchesFilter(item.run_mode, filters.runMode) &&
    matchesFilter(item.provider, filters.provider) &&
    matchesFilter(item.status, filters.status)
  ));
}

function aggregateServiceDecisionLiveExecuteDenialIncidents(denials = []) {
  const incidentsByKey = new Map();
  for (const denial of denials) {
    const key = `${denial.workspace_id || ''}:${denial.service_business_id || ''}:${denial.service_decision_fusion_receipt_id || ''}`;
    const response = denial.response && typeof denial.response === 'object' ? denial.response : {};
    const safety = denial.safety && typeof denial.safety === 'object' ? denial.safety : {};
    const blockers = Array.isArray(response.blockers) ? response.blockers : [];
    if (!incidentsByKey.has(key)) {
      incidentsByKey.set(key, {
        key,
        workspaceId: denial.workspace_id,
        serviceBusinessId: denial.service_business_id,
        serviceBusinessName: denial.service_business_name || null,
        serviceDecisionFusionReceiptId: denial.service_decision_fusion_receipt_id,
        fusionDecision: denial.fusion_decision || null,
        latestDenialId: denial.id,
        latestDenialReason: denial.denial_reason,
        latestRunMode: denial.run_mode,
        attemptCount: 0,
        byDenialReason: {},
        distinctBlockerKeys: [],
        distinctRunModes: [],
        distinctSourceExecutionReceiptIds: [],
        distinctReadyPreflightReceiptIds: [],
        firstDeniedAt: denial.created_at || null,
        lastDeniedAt: denial.created_at || null,
        externalSideEffects: false
      });
    }
    const incident = incidentsByKey.get(key);
    incident.attemptCount += 1;
    incident.byDenialReason[denial.denial_reason] = (incident.byDenialReason[denial.denial_reason] || 0) + 1;
    if ((denial.created_at || 0) >= (incident.lastDeniedAt || 0)) {
      incident.lastDeniedAt = denial.created_at || null;
      incident.latestDenialId = denial.id;
      incident.latestDenialReason = denial.denial_reason;
      incident.latestRunMode = denial.run_mode;
    }
    if ((denial.created_at || 0) < (incident.firstDeniedAt || Number.POSITIVE_INFINITY)) {
      incident.firstDeniedAt = denial.created_at || null;
    }
    incident.externalSideEffects = incident.externalSideEffects || response.externalSideEffects === true || safety.externalSideEffects === true;
    for (const blocker of blockers) {
      if (blocker && !incident.distinctBlockerKeys.includes(blocker)) incident.distinctBlockerKeys.push(blocker);
    }
    if (denial.run_mode && !incident.distinctRunModes.includes(denial.run_mode)) incident.distinctRunModes.push(denial.run_mode);
    if (denial.source_service_decision_execution_receipt_id && !incident.distinctSourceExecutionReceiptIds.includes(denial.source_service_decision_execution_receipt_id)) {
      incident.distinctSourceExecutionReceiptIds.push(denial.source_service_decision_execution_receipt_id);
    }
    if (denial.ready_live_preflight_receipt_id && !incident.distinctReadyPreflightReceiptIds.includes(denial.ready_live_preflight_receipt_id)) {
      incident.distinctReadyPreflightReceiptIds.push(denial.ready_live_preflight_receipt_id);
    }
  }
  return Array.from(incidentsByKey.values())
    .map((incident) => ({
      ...incident,
      distinctBlockerKeys: incident.distinctBlockerKeys.sort(),
      distinctRunModes: incident.distinctRunModes.sort(),
      distinctSourceExecutionReceiptIds: incident.distinctSourceExecutionReceiptIds.sort(),
      distinctReadyPreflightReceiptIds: incident.distinctReadyPreflightReceiptIds.sort(),
      firstDeniedAtIso: incident.firstDeniedAt ? new Date(incident.firstDeniedAt).toISOString() : null,
      lastDeniedAtIso: incident.lastDeniedAt ? new Date(incident.lastDeniedAt).toISOString() : null,
      repeatedAttemptCount: Math.max(0, incident.attemptCount - 1),
      actionRequired: incident.attemptCount > 0,
      readOnly: true
    }))
    .sort((a, b) => (b.attemptCount - a.attemptCount) || ((b.lastDeniedAt || 0) - (a.lastDeniedAt || 0)));
}

function buildServiceDecisionLiveExecuteDenialProvenanceExport({
  command = null,
  reconciliation = null,
  execution = null,
  workflow = null,
  denials = [],
  incidents = []
} = {}) {
  const generatedAt = Date.now();
  const redactedDenials = denials.map((denial) => {
    const request = denial.request && typeof denial.request === 'object' ? denial.request : {};
    const response = denial.response && typeof denial.response === 'object' ? denial.response : {};
    const safety = denial.safety && typeof denial.safety === 'object' ? denial.safety : {};
    const evidence = Array.isArray(denial.evidence) ? denial.evidence : [];
    const blockers = Array.isArray(response.blockers)
      ? Array.from(new Set(response.blockers.map((item) => cleanText(item)).filter(Boolean))).sort()
      : [];
    const gateResults = Array.isArray(response.gates)
      ? response.gates.map((gate) => ({
          key: cleanText(gate?.key) || 'gate',
          ok: gate?.ok === true
        }))
      : [];
    const proofKeys = Array.isArray(request.proofKeys)
      ? Array.from(new Set(request.proofKeys.map((item) => cleanText(item)).filter(Boolean))).sort()
      : [];
    return {
      kind: 'service_decision_live_execute_denial_redacted_receipt',
      table: 'portfolio_service_decision_live_execute_denials',
      id: denial.id,
      workspaceId: denial.workspace_id,
      serviceBusinessId: denial.service_business_id,
      serviceBusinessName: denial.service_business_name || null,
      serviceDecisionFusionReceiptId: denial.service_decision_fusion_receipt_id,
      sourceServiceDecisionExecutionReceiptId: denial.source_service_decision_execution_receipt_id || null,
      readyLivePreflightReceiptId: denial.ready_live_preflight_receipt_id || null,
      provider: denial.provider,
      mode: denial.mode,
      status: denial.status,
      denialReason: denial.denial_reason,
      runMode: denial.run_mode,
      actor: denial.actor,
      summary: redactKnownSecretText(denial.summary),
      blockers,
      gateResults,
      proofKeys,
      evidenceReferenceCount: evidence.length,
      evidenceReferencesRedacted: true,
      createdAt: denial.created_at,
      createdAtIso: denial.created_at ? new Date(denial.created_at).toISOString() : null,
      rawRequestPayloadIncluded: false,
      rawProofPayloadIncluded: false,
      rawEvidencePayloadIncluded: false,
      safety: {
        kind: safety.kind || 'service_decision_live_execute_denial_safety',
        externalSideEffects: safety.externalSideEffects === true,
        providerCalled: safety.providerCalled === true,
        adapterInvoked: safety.adapterInvoked === true,
        customerMessageSent: safety.customerMessageSent === true,
        paymentTransferCreated: safety.paymentTransferCreated === true,
        budgetMoved: safety.budgetMoved === true,
        sourceDecisionMutated: safety.sourceDecisionMutated === true
      }
    };
  });
  const byDenialReason = redactedDenials.reduce((counts, denial) => {
    counts[denial.denialReason] = (counts[denial.denialReason] || 0) + 1;
    return counts;
  }, {});
  const distinctBlockerKeys = Array.from(new Set(redactedDenials.flatMap((denial) => denial.blockers))).sort();
  const distinctRunModes = Array.from(new Set(redactedDenials.map((denial) => denial.runMode).filter(Boolean))).sort();
  const sourceReceipts = [
    reconciliation ? {
      kind: 'service_decision_readiness_reconciliation',
      table: 'portfolio_service_decision_readiness_reconciliations',
      id: reconciliation.id
    } : null,
    execution ? {
      kind: 'service_decision_execution_receipt',
      table: 'portfolio_service_decision_execution_receipts',
      id: execution.id
    } : null,
    workflow ? {
      kind: 'workflow_instance',
      table: 'workflow_instances',
      id: workflow.id
    } : null,
    ...redactedDenials.map((denial) => ({
      kind: 'service_decision_live_execute_denial',
      table: 'portfolio_service_decision_live_execute_denials',
      id: denial.id
    }))
  ].filter(Boolean);
  const incidentSummaries = incidents.map((incident) => ({
    kind: 'service_decision_live_execute_denial_incident_redacted_summary',
    key: incident.key,
    workspaceId: incident.workspaceId,
    serviceBusinessId: incident.serviceBusinessId,
    serviceBusinessName: incident.serviceBusinessName || null,
    serviceDecisionFusionReceiptId: incident.serviceDecisionFusionReceiptId,
    attemptCount: incident.attemptCount,
    byDenialReason: incident.byDenialReason,
    distinctBlockerKeys: incident.distinctBlockerKeys,
    distinctRunModes: incident.distinctRunModes,
    distinctSourceExecutionReceiptIds: incident.distinctSourceExecutionReceiptIds,
    distinctReadyPreflightReceiptIds: incident.distinctReadyPreflightReceiptIds,
    firstDeniedAt: incident.firstDeniedAt,
    firstDeniedAtIso: incident.firstDeniedAtIso,
    lastDeniedAt: incident.lastDeniedAt,
    lastDeniedAtIso: incident.lastDeniedAtIso,
    latestDenialId: incident.latestDenialId,
    latestDenialReason: incident.latestDenialReason,
    latestRunMode: incident.latestRunMode,
    repeatedAttemptCount: incident.repeatedAttemptCount,
    externalSideEffects: incident.externalSideEffects === true,
    readOnly: true
  }));
  const latestDenial = redactedDenials.reduce((latest, denial) => (
    !latest || (denial.createdAt || 0) >= (latest.createdAt || 0) ? denial : latest
  ), null);
  return {
    kind: 'service_decision_live_execute_denial_redacted_provenance_export',
    status: redactedDenials.length ? 'blocked_live_execute_audit_exported' : 'no_live_execute_denials',
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    workspaceId: command?.workspace_id || execution?.workspace_id || redactedDenials[0]?.workspaceId || null,
    serviceBusinessId: command?.serviceBusinessId || execution?.service_business_id || redactedDenials[0]?.serviceBusinessId || null,
    serviceBusinessName: command?.serviceBusinessName || redactedDenials[0]?.serviceBusinessName || null,
    readinessReconciliationId: command?.id || reconciliation?.id || null,
    serviceDecisionExecutionReceiptId: command?.serviceDecisionExecutionReceiptId || execution?.id || null,
    serviceDecisionFusionReceiptId: execution?.service_decision_fusion_receipt_id || redactedDenials[0]?.serviceDecisionFusionReceiptId || null,
    workflowInstanceId: command?.workflowInstanceId || workflow?.id || null,
    sourceReceipts,
    counts: {
      denialReceiptCount: redactedDenials.length,
      incidentCount: incidentSummaries.length,
      sourceReceiptCount: sourceReceipts.length,
      blockerCount: distinctBlockerKeys.length,
      denialReasonCount: Object.keys(byDenialReason).length,
      rawEvidenceReferenceCount: redactedDenials.reduce((total, denial) => total + denial.evidenceReferenceCount, 0)
    },
    byDenialReason,
    distinctBlockerKeys,
    distinctRunModes,
    latestDenialId: latestDenial?.id || null,
    latestDenialReason: latestDenial?.denialReason || null,
    latestRunMode: latestDenial?.runMode || null,
    incidents: incidentSummaries,
    denialReceipts: redactedDenials,
    redaction: {
      kind: 'service_decision_live_execute_denial_export_redaction_manifest',
      redacted: true,
      rawRequestPayloadsIncluded: false,
      rawProofPayloadsIncluded: false,
      rawEvidencePayloadsIncluded: false,
      rawProviderPayloadsIncluded: false,
      requestFieldsIncluded: ['operation', 'proofKeys', 'runMode', 'allowLiveBoardDecisionExecution'],
      excludedFields: ['request', 'request_json', 'response_json', 'safety_json', 'evidence_json', 'proofPacket', 'explicitProof', 'localProof', 'mergedProof'],
      secretPatternsSuppressed: ['github_token', 'stripe_live_secret', 'webhook_secret']
    },
    safety: {
      kind: 'service_decision_live_execute_denial_redacted_provenance_export_safety',
      readOnly: true,
      externalSideEffects: false,
      customerMessageSent: false,
      paymentTransferCreated: false,
      budgetMoved: false,
      providerCalled: false,
      adapterInvoked: false,
      sourceDecisionMutated: false,
      rawRequestPayloadsIncluded: false,
      rawProofPayloadsIncluded: false,
      rawEvidencePayloadsIncluded: false
    },
    handoff: {
      summary: redactedDenials.length
        ? `Redacted ${redactedDenials.length} blocked live-execute denial receipt(s) for operator handoff.`
        : 'No blocked live-execute denial receipts matched this readiness command.',
      recommendedNextActions: redactedDenials.length
        ? ['review_blocker_keys', 'collect_verified_live_evidence', 'rerun_readiness_reconciliation_before_live_execute']
        : ['no_live_execute_denials_to_review'],
      externalSideEffects: false
    }
  };
}

function filterDecisionDistributionReceipts(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.decisionDistributionReceiptId) &&
    matchesFilter(item.service_decision_execution_receipt_id, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.distribution_kind, filters.distributionKind) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterDecisionWorkItems(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.decisionWorkItemId) &&
    matchesFilter(item.service_decision_execution_receipt_id, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.decision_distribution_receipt_id, filters.decisionDistributionReceiptId) &&
    matchesFilter(item.work_item_kind, filters.workItemKind) &&
    matchesFilter(item.audience, filters.audience) &&
    matchesFilter(item.priority, filters.priority) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterServiceDecisionReadinessReconciliations(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.readinessReconciliationId) &&
    matchesFilter(item.service_decision_execution_receipt_id, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.workflow_instance_id, filters.workflowInstanceId) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterReadinessCommandCenter(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.serviceBusinessId, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.readinessReconciliationId) &&
    matchesFilter(item.serviceDecisionExecutionReceiptId, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.workflowInstanceId, filters.workflowInstanceId) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterReadinessEvidenceReviewReceipts(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.readinessEvidenceReviewReceiptId) &&
    matchesFilter(item.readiness_reconciliation_id, filters.readinessReconciliationId) &&
    matchesFilter(item.service_decision_execution_receipt_id, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.workflow_instance_id, filters.workflowInstanceId) &&
    matchesFilter(item.provider, filters.provider) &&
    matchesFilter(item.proof_key, filters.proofKey || filters.blockerKey) &&
    matchesFilter(item.review_kind, filters.reviewKind) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterReadinessReleasePreflightReceipts(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.readinessReleasePreflightReceiptId) &&
    matchesFilter(item.readiness_reconciliation_id, filters.readinessReconciliationId) &&
    matchesFilter(item.service_decision_execution_receipt_id, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.workflow_instance_id, filters.workflowInstanceId) &&
    matchesFilter(item.provider, filters.provider) &&
    matchesFilter(item.release_kind, filters.releaseKind) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterWorkflowCompensationPlans(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.compensationPlanId) &&
    matchesFilter(item.service_decision_execution_receipt_id, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.workflow_instance_id, filters.workflowInstanceId) &&
    matchesFilter(item.blocker_key, filters.blockerKey) &&
    matchesFilter(item.plan_kind, filters.planKind) &&
    matchesFilter(item.status, filters.status)
  ));
}

function filterWorkflowCompensationReceipts(items, filters) {
  return items.filter((item) => (
    matchesFilter(item.workspace_id, filters.workspaceId) &&
    matchesFilter(item.service_business_id, filters.serviceBusinessId) &&
    matchesFilter(item.id, filters.compensationReceiptId) &&
    matchesFilter(item.compensation_plan_id, filters.compensationPlanId) &&
    matchesFilter(item.service_decision_execution_receipt_id, filters.serviceDecisionExecutionReceiptId) &&
    matchesFilter(item.workflow_instance_id, filters.workflowInstanceId) &&
    matchesFilter(item.action_kind, filters.actionKind) &&
    matchesFilter(item.proof_key, filters.proofKey || filters.blockerKey) &&
    matchesFilter(item.status, filters.status)
  ));
}

function researchStartBody(body) {
  const city = cleanText(body.city);
  const niche = cleanText(body.niche);
  if (city.length < 2) return { ok: false, error: 'city is required' };
  if (niche.length < 2) return { ok: false, error: 'niche is required' };
  const maxLeads = boundedInt(body.maxLeads ?? body.max_leads ?? body.count, 1, 25, 8);
  const concurrency = boundedInt(body.concurrency, 1, 5, 5);
  const maxCostUsd = boundedMoney(body.maxCostUsd ?? body.max_cost_usd, 0.01, 5, 0.35);
  const mode = ['mock', 'live'].includes(body.mode) ? body.mode : undefined;
  return {
    ok: true,
    value: {
      city,
      niche,
      maxLeads,
      concurrency,
      maxCostUsd,
      mode,
      idempotencyKey: cleanText(body.idempotencyKey || body.idempotency_key) || null
    }
  };
}

function boundedInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseSince(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

function revenueByNiche({ since = 0 } = {}) {
  return db.prepare(`
    SELECT COALESCE(l.niche, 'unknown') AS niche,
           SUM(p.amount_cents) AS revenue_cents
    FROM payments p
    JOIN leads l ON l.id = p.lead_id
    WHERE p.status = 'paid'
      AND COALESCE(p.paid_at, p.created_at, 0) >= ?
    GROUP BY COALESCE(l.niche, 'unknown')
  `).all(since || 0).map((row) => ({
    niche: row.niche,
    revenueUsd: (Number(row.revenue_cents) || 0) / 100
  }));
}

function economicsByNiche({ since = 0 } = {}) {
  const costRows = leadCosts.rollupByNiche({ since });
  const revenueRows = revenueByNiche({ since });
  const byNiche = new Map();
  for (const row of costRows) {
    byNiche.set(row.niche, {
      niche: row.niche,
      leads: Number(row.lead_count) || 0,
      costUsd: Number(row.cost_usd) || 0,
      revenueUsd: 0
    });
  }
  for (const row of revenueRows) {
    const entry = byNiche.get(row.niche) || {
      niche: row.niche,
      leads: 0,
      costUsd: 0,
      revenueUsd: 0
    };
    entry.revenueUsd = Number(row.revenueUsd) || 0;
    byNiche.set(row.niche, entry);
  }
  const niches = Array.from(byNiche.values()).map((row) => {
    const marginUsd = row.revenueUsd - row.costUsd;
    const marginPct = row.revenueUsd > 0
      ? Number(((marginUsd / row.revenueUsd) * 100).toFixed(2))
      : null;
    return {
      niche: row.niche,
      leads: row.leads,
      costUsd: round2(row.costUsd),
      revenueUsd: round2(row.revenueUsd),
      marginUsd: round2(marginUsd),
      marginPct
    };
  });
  niches.sort((a, b) => (b.marginUsd || 0) - (a.marginUsd || 0));
  const totals = niches.reduce((acc, row) => {
    acc.leads += row.leads;
    acc.costUsd += row.costUsd;
    acc.revenueUsd += row.revenueUsd;
    acc.marginUsd += row.marginUsd;
    return acc;
  }, { leads: 0, costUsd: 0, revenueUsd: 0, marginUsd: 0 });
  return {
    niches,
    totals: {
      leads: totals.leads,
      costUsd: round2(totals.costUsd),
      revenueUsd: round2(totals.revenueUsd),
      marginUsd: round2(totals.marginUsd),
      marginPct: totals.revenueUsd > 0
        ? Number(((totals.marginUsd / totals.revenueUsd) * 100).toFixed(2))
        : null
    }
  };
}

function safeToSellTodaySummary({ readiness, queue, evals, observability, backup, durableSnapshot }) {
  const providerRows = Object.entries(readiness.providers || {});
  const dryRunVerified = providerRows
    .map(([name, row]) => [name, row.dryRunSmoke?.status !== 'not_run' ? row.dryRunSmoke : row.smoke])
    .filter(([, smoke]) => smoke?.dryRun && ['configured', 'ok'].includes(smoke.status))
    .map(([name, smoke]) => ({ provider: name, status: smoke.status, checkedAt: smoke.checkedAt }));
  const liveSmokeVerified = providerRows
    .filter(([, row]) => row.liveSmoke?.live && row.liveSmoke?.status === 'ok')
    .map(([name, row]) => ({ provider: name, status: row.liveSmoke.status, checkedAt: row.liveSmoke.checkedAt }));
  const stillBlocked = [
    ...(readiness.productionBlockers || []),
    ...(queue?.staleRunning ? [`${queue.staleRunning} durable job(s) have stale leases`] : []),
    ...(observability?.stuck?.builds?.length ? [`${observability.stuck.builds.length} build(s) look stuck`] : []),
    ...(observability?.stuck?.calls?.length ? [`${observability.stuck.calls.length} call(s) look stuck`] : []),
    ...(observability?.providerHealthSlo?.blockers || []),
    ...(observability?.workerHealthSlo?.blockers || []),
    ...(observability?.economicsHealth?.blockers || []),
    ...(observability?.schedulerHealth?.blockers || []),
    ...(durableSnapshot?.ok === false ? [durableSnapshot.reason] : []),
    ...(!backup?.ok ? [backup?.reason || 'SQLite backup is not fresh'] : []),
    ...(evals?.ok === false ? ['production eval suite is failing'] : [])
  ];
  const renewal = buildSafeToRenewStatus();
  if (renewal.safeToRenew === false) stillBlocked.push(...(renewal.blockers || []));
  const nextActions = buildSafeToSellNextActions({
    readiness,
    observability,
    backupFresh: backup,
    evalResult: evals,
    renewal
  });
  const providerProof = buildProviderProofMatrix({ readiness, observability });
  const ok = stillBlocked.length === 0;
  const summary = {
    ok,
    safe: ok,
    source: 'inline',
    generatedAt: new Date().toISOString(),
    command: 'npm run safe-to-sell',
    mode: readiness.mode,
    durableSnapshot: durableSnapshot || null,
    dryRunVerified,
    liveSmokeVerified,
    providerProof,
    stillBlocked,
    nextActions,
    promotionGates: readiness.promotionGates || null,
    renewal,
    schedulerHealth: observability?.schedulerHealth || null,
    providerHealthSlo: observability?.providerHealthSlo || null,
    workerHealthSlo: observability?.workerHealthSlo || null,
    economicsHealth: observability?.economicsHealth || null,
    evals: {
      ok: evals?.ok ?? null,
      summary: evals?.summary || null,
      command: 'npm run check:evals'
    },
    economics: observability?.dailyEconomics || null,
    backup: backup || null,
    queue: {
      due: queue?.due || 0,
      staleRunning: queue?.staleRunning || 0,
      failed: queue?.countsByStatus?.failed || 0,
      retrying: queue?.countsByStatus?.retry || 0
    }
  };
  summary.decisionReceipt = buildSafeToSellDecisionReceipt(summary);
  return summary;
}

function safeToSellSnapshotSummary({ snapshot, durableSnapshot }) {
  const report = snapshot.report || {};
  const queue = report.queue || {};
  const renewal = report.renewal || buildSafeToRenewStatus();
  const stillBlocked = dedupeBlockers([
    ...(report.stillBlocked || []),
    ...(renewal.safeToRenew === false ? renewal.blockers || [] : [])
  ]);
  const nextActions = dedupeBlockers([
    ...(report.nextActions || report.readiness?.nextActions || []),
    ...(renewal.safeToRenew === false ? renewal.nextActions || [] : [])
  ]);
  const ok = !!report.ok && renewal.safeToRenew !== false;
  const summary = {
    ok,
    safe: ok,
    source: 'safe_to_sell_snapshot',
    generatedAt: report.generatedAt || (snapshot.generatedAt ? new Date(snapshot.generatedAt).toISOString() : null),
    command: report.command || 'npm run safe-to-sell',
    mode: report.mode || null,
    durableSnapshot: durableSnapshot || null,
    snapshot: {
      id: snapshot.id,
      version: report.version || null,
      generatedAt: snapshot.generatedAt,
      ageMs: snapshot.ageMs,
      freshMs: snapshot.freshMs
    },
    dryRunVerified: report.dryRunVerified || [],
    liveSmokeVerified: report.liveSmokeVerified || [],
    providerProof: report.providerProof || [],
    stillBlocked,
    nextActions,
    promotionGates: report.promotionGates || report.readiness?.promotionGates || null,
    renewal,
    schedulerHealth: report.observability?.schedulerHealth || null,
    providerHealthSlo: report.observability?.providerHealthSlo || null,
    workerHealthSlo: report.observability?.workerHealthSlo || null,
    economicsHealth: report.observability?.economicsHealth || null,
    evals: report.evals || { ok: null, summary: null, command: 'npm run safe-to-sell' },
    economics: report.observability?.dailyEconomics || null,
    backup: report.backups || null,
    queue: {
      due: queue.due || 0,
      staleRunning: queue.staleRunning || 0,
      failed: queue.countsByStatus?.failed || 0,
      retrying: queue.countsByStatus?.retry || 0
    }
  };
  summary.decisionReceipt = report.decisionReceipt || {
    ...buildSafeToSellDecisionReceipt(summary),
    snapshotId: snapshot.id,
    durable: true
  };
  return summary;
}

function safeToRenewSnapshotSummary({ snapshot, durableSnapshot }) {
  const report = snapshot.report || {};
  return {
    ...(report || {}),
    ok: !!report.ok,
    safeToRenew: report.safeToRenew !== false,
    source: 'safe_to_renew_snapshot',
    durableSnapshot: durableSnapshot || null,
    snapshot: {
      id: snapshot.id,
      version: report.version || null,
      generatedAt: snapshot.generatedAt,
      ageMs: snapshot.ageMs,
      freshMs: snapshot.freshMs
    },
    decisionReceipt: report.decisionReceipt || null
  };
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function boundedMoney(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function dedupeBlockers(blockers) {
  const seen = new Set();
  return blockers.filter((blocker) => {
    const key = `${blocker.source}:${blocker.code}:${blocker.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return undefined;
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0] || '*'}***@***.${tld}`;
}

function latestAgentMailThread(contactRows, lead) {
  const event = (contactRows || []).find((e) => e.channel === 'agentmail' && e.thread_id);
  if (!event && !lead.agentmail_thread_id) return null;
  return {
    threadId: event?.thread_id || lead.agentmail_thread_id,
    subject: event?.subject || null,
    lastEventAt: event?.created_at || null
  };
}

function browserUseStatusSummary() {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM builds
    GROUP BY status
  `).all();
  const counts = Object.fromEntries(rows.map((row) => [normalizeBrowserUseStatus(row.status), row.n]));
  const latest = db.prepare(`
    SELECT b.id, b.lead_id, b.browser_session_id, b.live_url, b.project_url, b.status, b.updated_at, l.business_name
    FROM builds b
    LEFT JOIN leads l ON l.id = b.lead_id
    ORDER BY COALESCE(b.updated_at, b.started_at, 0) DESC
    LIMIT 1
  `).get();
  return {
    counts,
    latest: latest ? {
      buildId: latest.id,
      leadId: latest.lead_id,
      businessName: latest.business_name,
      sessionId: latest.browser_session_id || latest.id,
      liveUrl: latest.live_url,
      projectUrl: latest.project_url,
      status: normalizeBrowserUseStatus(latest.status),
      updatedAt: latest.updated_at
    } : null
  };
}

async function browserUseSessionFromBuild(row, { hydrate = true, providerSession = null } = {}) {
  const buildEvents = browserUseEventsForBuild(row);
  const latestPayload = latestBrowserUsePayload(buildEvents);
  const mock = buildEvents.some((event) => event.payload?.mock === true) ||
    String(row.live_url || '').startsWith('/api/') ||
    !row.browser_session_id ||
    String(row.browser_session_id || '').startsWith('mock');
  const sessionId = row.browser_session_id || latestPayload?.sessionId || row.id;
  const fallback = {
    sessionId,
    status: row.status,
    model: latestPayload?.model || process.env.BROWSER_USE_MODEL || (mock ? 'mock-bu-mini' : null),
    liveUrl: row.live_url || latestPayload?.liveUrl || null,
    screenshotUrl: latestPayload?.screenshotUrl || null,
    recordingUrls: latestPayload?.recordingUrls || [],
    output: latestPayload?.output || null,
    outputSchema: latestPayload?.outputSchema || null,
    stepCount: latestPayload?.stepCount || 0,
    lastStepSummary: latestPayload?.lastStepSummary || latestPayload?.summary || null,
    maxCostUsd: latestPayload?.maxCostUsd || null,
    totalInputTokens: latestPayload?.totalInputTokens || 0,
    totalOutputTokens: latestPayload?.totalOutputTokens || 0,
    proxyUsedMb: latestPayload?.proxyUsedMb || '0',
    llmCostUsd: latestPayload?.llmCostUsd || '0',
    proxyCostUsd: latestPayload?.proxyCostUsd || '0',
    browserCostUsd: latestPayload?.browserCostUsd || '0',
    totalCostUsd: latestPayload?.totalCostUsd || '0',
    agentmailEmail: latestPayload?.agentmailEmail || null,
    integrationsUsed: latestPayload?.integrationsUsed || [],
    createdAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };

  let liveSnapshot = providerSession;
  if (!liveSnapshot && hydrate && shouldHydrateBrowserUseSession({ row, sessionId, mock })) {
    try {
      const adapter = new BrowserUseLovableAdapter({
        apiKey: env.browserUse.apiKey,
        baseUrl: env.browserUse.baseUrl
      });
      liveSnapshot = await adapter.getSession(sessionId);
    } catch (err) {
      latestPayload.lastError = err?.message || String(err);
    }
  }

  const session = normalizeBrowserUseSessionSnapshot(liveSnapshot || fallback, fallback);
  const status = normalizeBrowserUseStatus(row.status || session.status);
  const statusGroup = browserUseStatusGroup(status);
  const source = row.lovable_url || row.source_url || row.lead_website || null;
  const evidence = browserUseEvidence({ row, session, events: buildEvents });
  const totalCost = moneyNumber(session.totalCostUsd);
  const maxCost = moneyNumber(session.maxCostUsd);

  return {
    ...session,
    status,
    statusGroup,
    buildId: row.id,
    leadId: row.lead_id,
    businessName: row.business_name || null,
    sourceType: 'lovable_build',
    source,
    task: row.brief || latestPayload?.brief || latestPayload?.summary || row.business_name || 'Browser Use task',
    niche: row.niche || null,
    city: row.city || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    liveUrl: session.liveUrl || row.live_url || null,
    projectUrl: row.project_url || latestPayload?.projectUrl || null,
    lovableUrl: row.lovable_url || latestPayload?.lovableUrl || null,
    failure: row.error || latestPayload?.error || (statusGroup === 'auth_wall' ? latestPayload?.reason || 'auth wall' : null),
    evidenceCount: Math.max(evidence.length, Number(latestPayload?.evidenceCount || 0) || 0),
    evidence,
    eventCount: buildEvents.length,
    events: buildEvents.slice(-8).map((event) => event.normalized),
    badges: {
      mock,
      live: !mock && Boolean(session.sessionId || session.liveUrl),
      authNeeded: statusGroup === 'auth_wall',
      costCapped: Boolean(maxCost && totalCost >= maxCost),
      stopped: status === 'stopped'
    },
    hydrationError: latestPayload?.lastError || null
  };
}

function browserUseEventsForBuild(row) {
  if (!row?.lead_id) return [];
  return eventStore
    .listByLead(row.lead_id, { worker: 'builder', limit: 160 })
    .map((eventRow) => {
      const payload = safeJson(eventRow.payload_json) || {};
      const matchesBuild = !payload.buildId || payload.buildId === row.id;
      const matchesSession = !payload.sessionId || payload.sessionId === row.browser_session_id || payload.sessionId === row.id;
      if (!matchesBuild && !matchesSession) return null;
      const normalized = normalizeBrowserUseEvent(eventRow);
      return normalized ? { row: eventRow, payload, normalized } : null;
    })
    .filter(Boolean);
}

function latestBrowserUsePayload(events) {
  const out = {};
  for (const event of events || []) {
    Object.assign(out, compactBrowserUsePayload(event.payload || {}));
  }
  return out;
}

function compactBrowserUsePayload(payload) {
  const keys = [
    'sessionId',
    'model',
    'status',
    'summary',
    'lastStepSummary',
    'liveUrl',
    'screenshotUrl',
    'recordingUrls',
    'output',
    'outputSchema',
    'stepCount',
    'maxCostUsd',
    'totalInputTokens',
    'totalOutputTokens',
    'proxyUsedMb',
    'llmCostUsd',
    'proxyCostUsd',
    'browserCostUsd',
    'totalCostUsd',
    'agentmailEmail',
    'integrationsUsed',
    'brief',
    'projectUrl',
    'lovableUrl',
    'error',
    'reason',
    'evidenceCount'
  ];
  const out = {};
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') out[key] = payload[key];
  }
  return out;
}

function normalizeBrowserUseEvent(row) {
  const payload = safeJson(row.payload_json) || {};
  const type = row.type || payload.type;
  const isBrowserUse = type?.startsWith('browserUse.') || type?.startsWith('builder.') || type?.startsWith('scraper.');
  if (!isBrowserUse) return null;
  return {
    id: row.id,
    ts: row.ts,
    type,
    leadId: row.lead_id || payload.leadId || null,
    worker: row.worker || payload.worker || null,
    buildId: payload.buildId || null,
    sessionId: payload.sessionId || null,
    phase: payload.phase || eventPhase(type),
    status: normalizeBrowserUseStatus(payload.status || builderStatusForEvent(type)),
    source: payload.lovableUrl || payload.sourceUrl || payload.source_url || payload.liveUrl || payload.projectUrl || null,
    summary: payload.summary || payload.note || payload.error || payload.reason || payload.projectUrl || payload.liveUrl || type,
    model: payload.model || null,
    stepCount: payload.stepCount ?? null,
    lastStepSummary: payload.lastStepSummary || null,
    liveUrl: payload.liveUrl || null,
    screenshotUrl: payload.screenshotUrl || null,
    totalCostUsd: payload.totalCostUsd || null,
    llmCostUsd: payload.llmCostUsd || null,
    browserCostUsd: payload.browserCostUsd || null,
    proxyCostUsd: payload.proxyCostUsd || null,
    evidenceCount: payload.evidenceCount || evidenceCount(payload.output || payload.summary || payload.projectUrl || payload.liveUrl),
    mock: payload.mock ?? null
  };
}

function browserUseEvidence({ row, session, events }) {
  const evidence = [];
  const push = (kind, value, label = kind) => {
    if (!value) return;
    const key = `${kind}:${value}`;
    if (evidence.some((item) => item.key === key)) return;
    evidence.push({ key, kind, label, value: String(value).slice(0, 500) });
  };

  push('source', row.source_url || row.lovable_url, 'source page');
  push('liveUrl', session.liveUrl || row.live_url, 'live browser');
  push('screenshotUrl', session.screenshotUrl, 'latest screenshot');
  push('projectUrl', row.project_url, 'published site');
  for (const url of session.recordingUrls || []) push('recordingUrl', url, 'recording');
  if (session.output) {
    for (const url of urlsFromText(searchableText(session.output)).slice(0, 8)) push('outputUrl', url, 'output URL');
    if (!urlsFromText(searchableText(session.output)).length) push('output', searchableText(session.output).slice(0, 280), 'structured output');
  }
  for (const event of events || []) {
    push('eventScreenshot', event.payload?.screenshotUrl, 'event screenshot');
    push('eventProject', event.payload?.projectUrl, 'event project');
    push('eventLive', event.payload?.liveUrl, 'event live URL');
    if (event.payload?.summary && /evidence|source|found|captured|extracted/i.test(event.payload.summary)) {
      push('eventSummary', event.payload.summary, 'extraction');
    }
  }
  return evidence.slice(0, 18);
}

function countBrowserUseSessions(sessions) {
  return sessions.reduce((acc, session) => {
    acc.total += 1;
    acc[session.statusGroup] = (acc[session.statusGroup] || 0) + 1;
    return acc;
  }, { total: 0, active: 0, completed: 0, failed: 0, auth_wall: 0 });
}

function browserUseTelemetry(sessions) {
  const totals = sessions.reduce((acc, session) => {
    acc.totalCostUsd += moneyNumber(session.totalCostUsd);
    acc.llmCostUsd += moneyNumber(session.llmCostUsd);
    acc.browserCostUsd += moneyNumber(session.browserCostUsd);
    acc.proxyCostUsd += moneyNumber(session.proxyCostUsd);
    acc.inputTokens += Number(session.totalInputTokens || 0);
    acc.outputTokens += Number(session.totalOutputTokens || 0);
    acc.stepCount += Number(session.stepCount || 0);
    acc.evidenceCount += Number(session.evidenceCount || 0);
    if (session.model) acc.models.add(session.model);
    if (session.badges.costCapped) acc.costCapped += 1;
    return acc;
  }, {
    totalCostUsd: 0,
    llmCostUsd: 0,
    browserCostUsd: 0,
    proxyCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    stepCount: 0,
    evidenceCount: 0,
    models: new Set(),
    costCapped: 0
  });
  return {
    totalCostUsd: moneyString(totals.totalCostUsd),
    llmCostUsd: moneyString(totals.llmCostUsd),
    browserCostUsd: moneyString(totals.browserCostUsd),
    proxyCostUsd: moneyString(totals.proxyCostUsd),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    stepCount: totals.stepCount,
    evidenceCount: totals.evidenceCount,
    models: [...totals.models],
    costCapped: totals.costCapped
  };
}

function findBrowserUseBuild(sessionId) {
  return db.prepare(`
    SELECT *
    FROM builds
    WHERE browser_session_id = ? OR id = ?
    ORDER BY COALESCE(updated_at, started_at, 0) DESC
    LIMIT 1
  `).get(sessionId, sessionId);
}

function shouldHydrateBrowserUseSession({ row, sessionId, mock }) {
  if (mock || !env.browserUse.apiKey || !sessionId || !isBrowserUseUuid(sessionId)) return false;
  const status = normalizeBrowserUseStatus(row.status);
  return ['running', 'queued', 'starting', 'created', 'idle'].includes(status);
}

function normalizeBrowserUseStatus(status) {
  const value = String(status || 'unknown').toLowerCase();
  if (['queued', 'starting'].includes(value)) return 'running';
  if (['blocked-auth', 'blocked_auth', 'auth_wall', 'auth-needed', 'auth_needed'].includes(value)) return 'blocked_auth';
  if (value.startsWith('failed')) return 'failed';
  return value;
}

function browserUseStatusGroup(status) {
  const value = normalizeBrowserUseStatus(status);
  if (['created', 'idle', 'running'].includes(value)) return 'active';
  if (['completed', 'done', 'success', 'stopped'].includes(value)) return 'completed';
  if (value === 'blocked_auth') return 'auth_wall';
  if (['failed', 'error', 'timed_out', 'timeout'].includes(value)) return 'failed';
  return 'active';
}

function eventPhase(type) {
  if (type === 'builder.live_url') return 'session';
  if (type === 'builder.project_url') return 'extraction';
  if (type === 'builder.blocked_auth') return 'auth';
  if (type?.startsWith('scraper.')) return 'research';
  return 'progress';
}

function boundedLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function moneyNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function moneyString(value) {
  return value.toFixed(4).replace(/\.?0+$/g, '') || '0';
}

function isBrowserUseUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function urlsFromText(text) {
  return [...String(text || '').matchAll(/https?:\/\/[^\s"'<>),]+/g)].map((match) => match[0]);
}

function evidenceCount(value) {
  const text = searchableText(value);
  if (!text) return 0;
  const urlCount = urlsFromText(text).length;
  if (urlCount) return urlCount;
  if (/\b(source|evidence|screenshot|captured|extracted)\b/i.test(text)) return 1;
  return 0;
}

function searchableText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

const BUILDER_LABELS = {
  'builder.start': 'Build requested',
  'builder.submission_created': 'Target submission created',
  'builder.live_url': 'Live preview ready',
  'builder.provider_action': 'Provider action',
  'builder.hook': 'Build hook',
  'builder.qa': 'Build QA',
  'builder.revision': 'Revision planned',
  'builder.progress': 'Progress update',
  'builder.project_url': 'Final site URL found',
  'builder.blocked_auth': 'Lovable auth needed',
  'builder.hosting_upsell_queued': 'Hosting upsell queued',
  'builder.hosting_upsell_duplicate': 'Hosting upsell already queued',
  'builder.hosting_upsell_sent': 'Hosting upsell sent',
  'builder.hosting_upsell_skipped': 'Hosting upsell skipped',
  'builder.done': 'Build completed',
  'browserUse.session.stopped': 'Browser Use stopped',
  'builder.error': 'Build failed'
};

function buildCallStateReadModel({ lead, callRows, callerEvents }) {
  const stateRows = (callerEvents || [])
    .filter((row) => row.type === 'caller.state')
    .map((row) => {
      const payload = safeJson(row.payload_json) || {};
      const event = payload.event || {};
      const mossSnippet = payload.mossSnippet || event.mossSnippet || null;
      const complianceState = payload.complianceState || event.complianceState || null;
      const safety = payload.safety || event.safety || null;
      const detectors = normalizeCallStateDetectors(payload.detectors || event.detectors || []);
      return {
        id: row.id,
        ts: row.ts,
        callId: payload.callId || event.callId || null,
        state: payload.currentState || payload.stage || event.stage || 'unknown',
        previousState: event.previousStage || null,
        nextLine: payload.nextLine || event.nextLine || null,
        objection: payload.objection || event.objection || null,
        detectors,
        mossSnippet,
        complianceState,
        safety,
        callback: payload.callback || event.callback || null,
        email: payload.email || event.email || null,
        transitionReason: payload.transitionReason || event.transitionReason || null,
        contextUsed: payload.contextUsed || event.contextUsed || null
      };
    });
  const latest = stateRows[stateRows.length - 1] || null;
  const latestCall = (callRows || [])[0] || null;
  return {
    leadId: lead?.id || null,
    callId: latest?.callId || latestCall?.id || null,
    currentState: latest?.state || null,
    nextLine: latest?.nextLine || null,
    objection: latest?.objection || null,
    mossSnippet: latest?.mossSnippet || null,
    complianceState: latest?.complianceState || null,
    safety: latest?.safety || {
      safe: lead?.outreach_status !== 'blocked',
      code: lead?.risk_status || 'unknown',
      reason: lead?.blocked_reason || lead?.callable_reason || 'No caller.state event has been emitted yet.'
    },
    callback: latest?.callback || null,
    email: latest?.email || null,
    detectors: latest?.detectors || [],
    transitionReason: latest?.transitionReason || null,
    contextUsed: latest?.contextUsed || null,
    timeline: stateRows.slice(-16)
  };
}

function normalizeCallStateDetectors(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return { type: item, excerpt: null };
    return {
      type: item?.type || item?.kind || 'signal',
      excerpt: item?.excerpt || null
    };
  }).filter((item) => item.type);
}

function buildBuilderReadModel({ lead, buildRows, builderEvents }) {
  const latest = buildRows[0] || null;
  const timeline = (builderEvents || [])
    .filter((row) => row.type?.startsWith('builder.'))
    .map(builderTimelineItem)
    .filter(Boolean);
  const status = normalizeBuildStatus(latest?.status || statusFromBuilderTimeline(timeline) || 'not_started');
  const progressLog = timeline
    .filter((item) => item.type === 'builder.progress' || item.type === 'builder.provider_action' || item.type === 'builder.submission_created' || item.error)
    .map((item) => ({
      ts: item.ts,
      text: item.error || item.summary || item.label,
      type: item.type
    }))
    .slice(-12);

  return {
    status,
    authNeeded: status === 'blocked_auth',
    latestBuildId: latest?.id || lastValue(timeline, 'buildId'),
    runId: lastValue(timeline, 'runId'),
    startedAt: latest?.started_at || firstTs(timeline),
    finishedAt: latest?.finished_at || terminalTs(timeline),
    liveUrl: latest?.live_url || lastValue(timeline, 'liveUrl'),
    projectUrl: latest?.project_url || lastValue(timeline, 'projectUrl'),
    finalSiteUrl: latest?.project_url || (['shipped', 'awaiting_launch_approval', 'launch_approved'].includes(lead.status) ? lead.website : null),
    launchStatus: latest?.launch_status || lastValue(timeline, 'launchStatus') || 'not_started',
    customerApprovedAt: latest?.customer_approved_at || null,
    operatorApprovedAt: latest?.operator_approved_at || null,
    launchedAt: latest?.launched_at || null,
    target: latest?.target || lastValue(timeline, 'target') || 'anything',
    submissionUrl: latest?.submission_url || latest?.lovable_url || lastValue(timeline, 'submissionUrl'),
    error: latest?.error || lastValue(timeline, 'error'),
    brief: latest?.brief || lastValue(timeline, 'brief'),
    lovableUrl: latest?.lovable_url || lastValue(timeline, 'lovableUrl'),
    providerProjectId: latest?.provider_project_id || lastValue(timeline, 'providerProjectId'),
    providerDeploymentId: latest?.provider_deployment_id || lastValue(timeline, 'providerDeploymentId'),
    sessionId: latest?.browser_session_id || lastValue(timeline, 'sessionId'),
    model: lastValue(timeline, 'model'),
    stepCount: lastNumber(timeline, 'stepCount'),
    lastStepSummary: lastValue(timeline, 'lastStepSummary') || lastValue(timeline, 'summary'),
    screenshotUrl: lastValue(timeline, 'screenshotUrl'),
    recordingUrls: lastArray(timeline, 'recordingUrls'),
    maxCostUsd: lastValue(timeline, 'maxCostUsd'),
    totalInputTokens: lastNumber(timeline, 'totalInputTokens'),
    totalOutputTokens: lastNumber(timeline, 'totalOutputTokens'),
    proxyUsedMb: lastValue(timeline, 'proxyUsedMb'),
    llmCostUsd: lastValue(timeline, 'llmCostUsd'),
    proxyCostUsd: lastValue(timeline, 'proxyCostUsd'),
    browserCostUsd: lastValue(timeline, 'browserCostUsd'),
    totalCostUsd: lastValue(timeline, 'totalCostUsd'),
    agentmailEmail: lastValue(timeline, 'agentmailEmail'),
    integrationsUsed: lastArray(timeline, 'integrationsUsed'),
    evidenceCount: lastNumber(timeline, 'evidenceCount'),
    outputSchema: lastValue(timeline, 'outputSchema'),
    progressLog,
    timeline
  };
}

function builderTimelineItem(row) {
  const payload = safeJson(row.payload_json) || {};
  return {
    id: row.id,
    ts: row.ts,
    type: row.type,
    label: BUILDER_LABELS[row.type] || row.type,
    status: builderStatusForEvent(row.type),
    summary: payload.summary || payload.note || payload.error || payload.projectUrl || payload.liveUrl || '',
    liveUrl: payload.liveUrl || null,
    projectUrl: payload.projectUrl || null,
    target: payload.target || null,
    submissionUrl: payload.submissionUrl || payload.submission_url || null,
    promptPreview: payload.promptPreview || null,
    providerAction: payload.providerAction || null,
    providerProjectId: payload.providerProjectId || null,
    providerDeploymentId: payload.providerDeploymentId || null,
    buildId: payload.buildId || null,
    runId: payload.runId || null,
    brief: payload.brief || null,
    lovableUrl: payload.lovableUrl || null,
    sessionId: payload.sessionId || null,
    error: payload.error || null,
    model: payload.model || null,
    stepCount: payload.stepCount ?? null,
    lastStepSummary: payload.lastStepSummary || null,
    screenshotUrl: payload.screenshotUrl || null,
    recordingUrls: payload.recordingUrls || [],
    maxCostUsd: payload.maxCostUsd || null,
    totalInputTokens: payload.totalInputTokens || null,
    totalOutputTokens: payload.totalOutputTokens || null,
    proxyUsedMb: payload.proxyUsedMb || null,
    llmCostUsd: payload.llmCostUsd || null,
    proxyCostUsd: payload.proxyCostUsd || null,
    browserCostUsd: payload.browserCostUsd || null,
    totalCostUsd: payload.totalCostUsd || null,
    launchStatus: payload.launchStatus || null,
    agentmailEmail: payload.agentmailEmail || null,
    integrationsUsed: payload.integrationsUsed || [],
    evidenceCount: payload.evidenceCount || evidenceCount(payload.output || payload.summary || payload.projectUrl || payload.liveUrl),
    outputSchema: payload.outputSchema || null,
    mock: !!payload.mock
  };
}

function builderStatusForEvent(type) {
  if (
    type === 'builder.start' ||
    type === 'builder.submission_created' ||
    type === 'builder.live_url' ||
    type === 'builder.provider_action' ||
    type === 'builder.hook' ||
    type === 'builder.qa' ||
    type === 'builder.revision' ||
    type === 'builder.progress' ||
    type === 'builder.project_url'
  ) return 'running';
  if (type === 'builder.done') return 'completed';
  if (type === 'builder.blocked_auth') return 'blocked_auth';
  if (type === 'browserUse.session.stopped') return 'stopped';
  if (type === 'builder.error') return 'failed';
  return null;
}

function normalizeBuildStatus(status) {
  if (status === 'queued' || status === 'starting' || status === 'qa_review') return 'running';
  if (status?.startsWith?.('failed')) return 'failed';
  return status || 'not_started';
}

function statusFromBuilderTimeline(timeline) {
  for (const item of [...timeline].reverse()) {
    if (item.status) return item.status;
  }
  return null;
}

function firstTs(timeline) {
  return timeline.length ? timeline[0].ts : null;
}

function terminalTs(timeline) {
  const terminal = [...timeline].reverse().find((item) => ['builder.done', 'builder.blocked_auth', 'builder.error'].includes(item.type));
  return terminal?.ts || null;
}

function lastValue(timeline, key) {
  for (const item of [...timeline].reverse()) {
    if (item[key]) return item[key];
  }
  return null;
}

function lastNumber(timeline, key) {
  for (const item of [...timeline].reverse()) {
    const n = Number(item[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function lastArray(timeline, key) {
  for (const item of [...timeline].reverse()) {
    if (Array.isArray(item[key]) && item[key].length) return item[key];
  }
  return [];
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function fallbackWebsiteBriefForPreview(lead) {
  const businessName = lead?.business_name || 'Your business';
  const phone = lead?.phone || '';
  const area = lead?.city || lead?.address || 'your service area';
  const niche = lead?.niche || 'local services';
  const services = [niche, 'service estimates', 'contact details'];
  return {
    businessName,
    phone,
    locationOrServiceArea: area,
    pages: [
      { name: 'Home', path: '/', goal: 'Preview the generated local-services site.', sections: ['hero', 'services', 'contact'] }
    ],
    sections: [
      { key: 'hero', name: 'Hero', goal: 'Show business name and contact path.', requiredFacts: [businessName, phone, area].filter(Boolean) },
      { key: 'services', name: 'Services', goal: 'Show core services.', requiredFacts: services },
      { key: 'contact', name: 'Contact', goal: 'Make contact obvious.', requiredFacts: [phone].filter(Boolean) }
    ],
    hero: {
      headline: businessName,
      subheadline: 'A clear, mobile-first local business site preview.',
      proofLine: 'Preview generated from confirmed lead details only.'
    },
    services,
    serviceCards: services.map((name) => ({ name, description: `${name} for customers in ${area}.` })),
    reviewProof: { items: [], disclaimer: 'Unverified credibility claims are omitted unless confirmed.' },
    location: { city: lead?.city || null, address: lead?.address || null, serviceArea: area, hours: null },
    cta: phone ? `Call ${phone} for service or a quote` : 'Call for service or a quote',
    contactMethods: phone ? [{ type: 'phone', value: phone, href: `tel:${phone}` }, { type: 'form', value: '#contact-form', href: '#contact-form' }] : [{ type: 'form', value: '#contact-form', href: '#contact-form' }],
    commerceNeeds: [{ key: 'invoice', status: 'pending', detail: 'Invoice/payment state lives outside the public site.' }],
    assets: [{ type: 'placeholder', alt: `${businessName} local service placeholder` }],
    prohibitedClaims: [],
    sourceFacts: { address: lead?.address || null, hours: null }
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPortfolioLaunchSurfaceHtml({ surface, serviceBusiness }) {
  const offer = serviceBusiness?.offer && typeof serviceBusiness.offer === 'object' ? serviceBusiness.offer : {};
  const isLocalSeo = surface.kind === 'local_seo_landing_page';
  const isDirectoryListing = surface.kind === 'directory_listing';
  const proof = surface.proof && typeof surface.proof === 'object' ? surface.proof : {};
  const packages = Array.isArray(offer.packages) && offer.packages.length
    ? offer.packages.slice(0, 4)
    : [{ name: 'Service response', description: serviceBusiness?.customer_outcome || 'Request service from this local operator.', priceCents: null }];
  const headline = offer.headline || serviceBusiness?.name || 'Local service response';
  const outcome = serviceBusiness?.customer_outcome || offer.customerOutcome || 'A clear local service offer with operator-reviewed claims.';
  const surfaceLabel = isLocalSeo
    ? 'Callan-owned local SEO page'
    : isDirectoryListing
      ? 'Callan-owned directory listing'
      : 'Callan-owned acquisition surface';
  const metaDescription = `${headline}. ${outcome}`.slice(0, 155);
  const packageHtml = packages.map((pkg) => {
    const price = Number.isFinite(Number(pkg.priceCents))
      ? `$${Math.round(Number(pkg.priceCents) / 100).toLocaleString('en-US')}`
      : (pkg.price ? String(pkg.price) : 'Quote after review');
    return `<article class="package">
      <div>
        <h2>${escapeHtml(pkg.name || 'Service package')}</h2>
        <p>${escapeHtml(pkg.description || outcome)}</p>
      </div>
      <strong>${escapeHtml(price)}</strong>
    </article>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeHtml(metaDescription)}" />
  <title>${escapeHtml((isLocalSeo || isDirectoryListing) ? `${headline} | ${serviceBusiness?.name || 'Callan'}` : (serviceBusiness?.name || 'Callan surface'))}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif; color: #15201c; background: #f5f7f1; }
    main { width: min(920px, calc(100vw - 32px)); margin: 0 auto; padding: 56px 0 72px; }
    .eyebrow { font-size: 13px; font-weight: 700; text-transform: uppercase; color: #557060; margin-bottom: 18px; }
    h1 { max-width: 12ch; font-size: clamp(40px, 8vw, 84px); line-height: 0.96; margin: 0 0 20px; letter-spacing: 0; }
    .lede { max-width: 62ch; font-size: 20px; line-height: 1.5; color: #314238; margin: 0 0 32px; }
    .proof { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 28px; }
    .proof span { border: 1px solid #ccd8cd; border-radius: 999px; padding: 8px 12px; background: #fff; font-size: 13px; color: #33463c; }
    .packages { display: grid; gap: 12px; }
    .package { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; padding: 18px; border: 1px solid #d9e1d8; border-radius: 8px; background: #fff; }
    .package h2 { font-size: 18px; margin: 0 0 6px; }
    .package p { margin: 0; color: #4a5c51; line-height: 1.45; }
    .package strong { white-space: nowrap; color: #163d2c; }
    .cta { display: inline-block; margin-top: 28px; padding: 14px 18px; border-radius: 8px; background: #173f2d; color: #fff; text-decoration: none; font-weight: 700; }
    footer { margin-top: 40px; font-size: 12px; color: #627469; }
    @media (max-width: 640px) {
      main { padding-top: 36px; }
      h1 { max-width: 100%; }
      .package { display: grid; }
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">${escapeHtml(surfaceLabel)}</div>
    <h1>${escapeHtml(headline)}</h1>
    <p class="lede">${escapeHtml(outcome)}</p>
    <div class="proof">
      <span>${escapeHtml(serviceBusiness?.name || 'Service business')}</span>
      <span>${escapeHtml(serviceBusiness?.vertical_key || 'local service')}</span>
      ${isLocalSeo ? `<span>${escapeHtml(proof.localSeo?.searchIntent || 'local search intent')}</span>` : ''}
      ${isDirectoryListing ? `<span>${escapeHtml(proof.directoryListing?.serviceArea || 'service area')}</span>` : ''}
      <span>${escapeHtml(surface.status || 'live')}</span>
      <span>No external ad spend</span>
      ${isDirectoryListing ? '<span>External directories untouched</span>' : ''}
    </div>
    <section class="packages" aria-label="service packages">
      ${packageHtml}
    </section>
    <a class="cta" href="mailto:operator@example.test?subject=${encodeURIComponent(serviceBusiness?.name || 'Service request')}">Request operator review</a>
    <footer>Surface ${escapeHtml(surface.id)}. Published from an operator-reviewed action receipt with no external provider mutation.</footer>
  </main>
</body>
</html>`;
}

// Minimal, server-rendered landing page used by /api/referrals/landing-html.
// Keep this string self-contained — the goal is for the operator to preview
// what a referred visitor sees without any frontend build step.
function renderReferralLandingHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>callmemaybe — same-day websites for local businesses</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif; color: #17201b; background: #f6f8f4; }
    main { width: min(640px, calc(100vw - 32px)); margin: 0 auto; padding: 64px 0 96px; }
    .brand { font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: #4b6650; margin-bottom: 24px; }
    h1 { font-size: clamp(32px, 6vw, 56px); line-height: 1.05; margin: 0 0 16px; }
    p.lede { font-size: 18px; line-height: 1.5; color: #2c3a31; max-width: 56ch; margin: 0 0 32px; }
    form { display: grid; gap: 12px; padding: 20px; background: white; border: 1px solid #d6ded8; border-radius: 12px; }
    label { font-size: 13px; font-weight: 600; color: #2c3a31; }
    input { padding: 12px 14px; font-size: 16px; border: 1px solid #d6ded8; border-radius: 8px; }
    button { padding: 12px 16px; font-size: 16px; font-weight: 600; background: #165a3a; color: white; border: 0; border-radius: 8px; cursor: pointer; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .status { font-size: 14px; color: #4b6650; min-height: 18px; }
    footer { margin-top: 48px; font-size: 12px; color: #6a7d70; }
  </style>
</head>
<body>
  <main>
    <div class="brand">callmemaybe</div>
    <h1>we build your website same-day for $500</h1>
    <p class="lede">Tell us the business and city. We research it, write the copy, ship a real one-page site, and email you the link before the day is over.</p>
    <form id="discover-form" autocomplete="off">
      <div>
        <label for="niche">Business / niche</label>
        <input id="niche" name="niche" type="text" placeholder="plumber, salon, law firm…" required minlength="2" />
      </div>
      <div>
        <label for="city">City</label>
        <input id="city" name="city" type="text" placeholder="Oakland, CA" required minlength="2" />
      </div>
      <button type="submit">Build my website</button>
      <div class="status" id="status" aria-live="polite"></div>
    </form>
    <footer>Referred by a site we built. callmemaybe ships small business websites same-day.</footer>
  </main>
  <script>
    (function () {
      var form = document.getElementById('discover-form');
      var status = document.getElementById('status');
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var btn = form.querySelector('button');
        btn.disabled = true;
        status.textContent = 'Sending to our crew…';
        var payload = {
          niche: form.niche.value.trim(),
          city: form.city.value.trim(),
          count: 1
        };
        fetch('/api/leads/discover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function () {
          status.textContent = 'Got it. We will reach out with your site.';
        }).catch(function (err) {
          status.textContent = 'Could not submit: ' + (err && err.message ? err.message : 'unknown');
          btn.disabled = false;
        });
      });
    })();
  </script>
</body>
</html>`;
}

function agentMailEventId(req, body, msg) {
  return String(
    req.headers['svix-id'] ||
    msg.eventId ||
    body.id ||
    body.event_id ||
    `${msg.eventType || 'agentmail'}:${msg.threadId || 'thread'}:${msg.messageId || Date.now()}`
  );
}
