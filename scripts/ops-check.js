#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'callan-ops-check-'));
const strictDir = mkdtempSync(join(tmpdir(), 'callan-readiness-strict-'));
const startedAt = Date.now();
const checks = [];
let dbHandle = null;
const productionSmokeProviders = ['gemini', 'supermemory', 'moss', 'agentphone', 'browserUse', 'lovable', 'agentmail', 'stripe'];

try {
  configureEnv(dataDir);
  const dbModule = await import('../server/db.js');
  const { env } = await import('../server/env.js');
  const { containerTagFor } = await import('../server/memory.js');
  const { drainDurableJobsOnce } = await import('../server/jobs.js');
  const { withProviderRetry } = await import('../server/providers/core.js');
  const { assertProviderOperational, providerRuntimeIncident, recordProviderRuntimeIncident } = await import('../server/providerIncidents.js');
  const { CALL_ANALYSIS_JOB_TYPE, enqueueCallAnalysis } = await import('../server/analysisQueue.js');
  const { EMAIL_CALLBACK_JOB_TYPE, enqueueEmailCallbackJob, handleEmailCallbackJob } = await import('../server/emailCallback.js');
  const { MAIL_REPLY_JOB_TYPE, enqueueMailReplyJob } = await import('../server/mailReplyQueue.js');
  const { INBOUND_MEMORY_HYDRATE_JOB_TYPE, enqueueInboundMemoryHydration } = await import('../server/inboundMemoryQueue.js');
  const { INBOUND_VOICE_FOLLOWUP_JOB_TYPE, enqueueInboundVoiceFollowup, handleInboundVoiceFollowupJob } = await import('../server/inboundVoiceQueue.js');
  const { maybeFireInboundEmail, _resetInboundIntentState } = await import('../server/inboundIntent.js');
  const { OPERATOR_TRANSFER_JOB_TYPE, enqueueOperatorTransferJob, handleOperatorTransferJob } = await import('../server/operatorTransferQueue.js');
  const { INBOUND_BUSINESS_RESEARCH_JOB_TYPE, maybeKickOffBusinessResearch } = await import('../server/inboundResearch.js');
  const { _resetAgentMailPollerState, processAgentMailPollerMessages } = await import('../server/agentmailPoller.js');
  const { executeDueChannel } = await import('../server/cadence.js');
  const { OUTREACH_LEAD_JOB_TYPE, enqueueOutreachLeadJob } = await import('../server/outreach.js');
  const { LEAD_PRIORITY_SCORE_JOB_TYPE, enqueueLeadPriorityScore, handleLeadPriorityScoreJob } = await import('../server/leadPriorityQueue.js');
  const { SCHEDULED_CALL_JOB_TYPE, enqueueScheduledCallPlacement, handleScheduledCallPlacementJob } = await import('../server/scheduledCalls.js');
  const { BUILDER_BUILD_JOB_TYPE, enqueueBuilderBuild, enqueuePreviewBuilderBuild } = await import('../server/builderQueue.js');
  const { HOSTING_UPSELL_JOB_TYPE, enqueueHostingUpsell, handleHostingUpsellJob } = await import('../server/hostingUpsellQueue.js');
  const { startPreviewBuildKickoff } = await import('../server/workers/mailer.js');
  const { runAnalyst } = await import('../server/workers/analyst.js');
  const { GROWTH_FOLLOWUP_JOB_TYPE, GROWTH_PLAN_JOB_TYPE, enqueueGrowthFollowupJob, enqueueGrowthPlanJob, handleGrowthFollowupJob, handleGrowthPlanJob } = await import('../server/growthQueue.js');
  const { SAFE_TO_SELL_JOB_TYPE, SAFE_TO_SELL_REPORT_VERSION, applySafeToSellMaintenanceGate, buildProviderProofMatrix, buildSafeToSellDecisionReceipt, buildSafeToSellReport, compactSafeToSellReceiptHistory, enqueueSafeToSellSelfCheck, printSafeToSellReport, runSafeToSellSelfCheck, safeToSellSnapshotStatus } = await import('../server/safeToSell.js');
  const { formatProviderSmokeResult, providerSmokeExitCode } = await import('../scripts/provider-smoke.js');
  const { ACCOUNT_MANAGER_RUN_JOB_TYPE, enqueueAccountManagerRun, handleAccountManagerRunJob } = await import('../server/accountManager/index.js');
  const { adminAuthPosture, adminAuthStatus, extractAdminToken, isOperatorControlMutation, isOperatorDataRead, isOperatorProtectedRequest } = await import('../server/adminAuth.js');
  const { liveReadiness } = await import('../server/readiness.js');
  const { marginForLead } = await import('../server/costs.js');
  const { OPS_BACKUP_JOB_TYPE, OPS_PROVIDER_POSTURE_JOB_TYPE, OPS_RECOVER_STUCK_JOB_TYPE, backupFreshness, backupSqliteDataDir, enqueueOpsBackup, enqueueOpsRecovery, enqueueProviderPostureRefresh, exportOperationsData, latestBackupManifest, opsObservability, recoverStuckOperations, redactPii, refreshStaleOpsMaintenance, resetMockData, runOpsBackupJob, runOpsRecoveryJob, runProviderPostureJob } = await import('../server/ops.js');
  dbHandle = dbModule.db;

  await check('jobs.idempotency_and_stale_lease_recovery', async () => {
    const first = dbModule.durableJobs.enqueue({
      type: 'ops.test',
      payload: { email: 'owner@example.com', phone: '+14155550199' },
      idempotency_key: 'ops-check:once',
      maxAttempts: 3,
      now: Date.now()
    });
    const second = dbModule.durableJobs.enqueue({
      type: 'ops.test',
      payload: { email: 'different@example.com' },
      idempotency_key: 'ops-check:once',
      maxAttempts: 3,
      now: Date.now()
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    const claimed = dbModule.durableJobs.claimNext({ workerId: 'ops-check', leaseMs: 1, now: Date.now() });
    assert.equal(claimed.status, 'running');
    const recovered = dbModule.durableJobs.recoverExpiredLeases({ now: Date.now() + 1_000 });
    assert.equal(recovered, 1);
    const retry = dbModule.durableJobs.claimNext({ workerId: 'ops-check-retry', leaseMs: 30_000, now: Date.now() + 1_000 });
    assert.equal(retry.id, first.row.id);
    dbModule.durableJobs.complete(retry.id, { result: { ok: true } });
    assert.equal(dbModule.durableJobs.get(retry.id).status, 'completed');
  });

  await check('jobs.worker_drain_completes_handler', async () => {
    const job = dbModule.durableJobs.enqueue({
      type: 'ops.handler',
      payload: { marker: 'ops-check-handler' },
      idempotency_key: 'ops-check:handler'
    }).row;
    const drained = await drainDurableJobsOnce({
      'ops.handler': async (payload) => ({ handled: payload.marker === 'ops-check-handler' })
    }, { workerId: 'ops-check-worker', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    assert.equal(dbModule.durableJobs.get(job.id).status, 'completed');
  });

  await check('jobs.non_retryable_errors_fail_fast', async () => {
    const job = dbModule.durableJobs.enqueue({
      type: 'ops.non_retryable',
      payload: { provider: 'gemini' },
      idempotency_key: 'ops-check:non-retryable',
      maxAttempts: 5,
      runAt: Date.now()
    }).row;
    const drained = await drainDurableJobsOnce({
      'ops.non_retryable': async () => {
        throw new Error('gemini.generateContent failed: API key not valid');
      }
    }, { workerId: 'ops-non-retryable-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const failed = await waitForJob(dbModule.durableJobs, job.id, ['failed', 'retry'], 8000);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.max_attempts, 5);
  });

  await check('jobs.summary_summarizes_recent_failure_errors', async () => {
    const job = dbModule.durableJobs.enqueue({
      type: 'ops.summary_redaction',
      payload: { provider: 'gemini' },
      idempotency_key: 'ops-check:summary-redaction',
      maxAttempts: 1,
      runAt: Date.now()
    }).row;
    const claimed = dbModule.durableJobs.claimNext({
      workerId: 'ops-summary-redaction-check',
      types: ['ops.summary_redaction'],
      now: Date.now()
    });
    assert.equal(claimed.id, job.id);
    dbModule.durableJobs.fail(claimed.id, {
      error: 'gemini.generateContent failed for owner@example.com at +14155550123 with key AIzaSySecret987654: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo"}]}}',
      retryable: false
    });
    const summary = dbModule.durableJobs.summary({ recentLimit: 20 });
    const recent = summary.recentFailures.find((row) => row.id === job.id);
    assert(recent, JSON.stringify(summary.recentFailures));
    assert.equal(recent.error, 'API key not valid');
    const serialized = JSON.stringify(summary.recentFailures);
    assert(!serialized.includes('owner@example.com'), 'durable job summary leaked email');
    assert(!serialized.includes('+14155550123'), 'durable job summary leaked phone');
    assert(!serialized.includes('AIzaSySecret987654'), 'durable job summary leaked provider key');
    assert(!serialized.includes('type.googleapis.com'), 'durable job summary leaked raw provider payload');
  });

  await check('provider_incidents.require_live_smoke_to_clear_non_retryable_runtime_failure', async () => {
    const now = Date.now();
    recordProviderRuntimeIncident({
      provider: 'gemini',
      error: new Error('gemini.generateContent failed: API key not valid'),
      action: 'generateContent',
      worker: 'ops-check',
      eventId: 'ops-provider-incident',
      now
    });

    const incident = providerRuntimeIncident('gemini', { now: now + 1 });
    assert.equal(incident.blocked, true);
    assert.match(incident.reason, /gemini provider has an uncleared runtime incident/);
    let thrown = null;
    try {
      assertProviderOperational('gemini', { now: now + 2 });
    } catch (err) {
      thrown = err;
    }
    assert(thrown, 'expected provider operational guard to throw');
    assert.equal(thrown.retryable, false);
    assert.equal(thrown.operationalState, 'blocked');

    dbModule.providerSmoke.set('gemini', 'configured', { dryRun: true, live: false, opsCheck: true }, { checkedAt: now + 3 });
    assert.equal(providerRuntimeIncident('gemini', { now: now + 4 }).blocked, true, 'dry-run smoke must not clear a live runtime incident');
    const observed = opsObservability({ windowMs: 60_000 });
    assert.equal(observed.providerHealthSlo.ok, false);
    assert(observed.providerHealthSlo.blockers.some((blocker) => blocker.includes('gemini provider has an uncleared runtime incident')), observed.providerHealthSlo.blockers.join('\n'));

    dbModule.providerSmoke.set('gemini', 'ok', { dryRun: false, live: true, opsCheck: true }, { checkedAt: now + 5 });
    assert.equal(providerRuntimeIncident('gemini', { now: now + 6 }).blocked, false, 'successful live smoke should clear the runtime incident');
  });

  await check('provider_retry.records_non_retryable_runtime_incident_for_any_provider', async () => {
    const now = Date.now();
    let attempts = 0;
    await assert.rejects(
      withProviderRetry('agentmail', 'send', () => {
        attempts += 1;
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }, {
        retries: 3,
        baseDelayMs: 1
      }),
      /agentmail\.send failed/
    );
    assert.equal(attempts, 1, 'non-retryable provider errors should not retry inside provider retry helper');
    const incident = providerRuntimeIncident('agentmail', { now: now + 1 });
    assert.equal(incident.blocked, true);
    assert.match(incident.reason, /agentmail provider has an uncleared runtime incident/);

    dbModule.providerSmoke.set('agentmail', 'configured', { dryRun: true, live: false, opsCheck: true }, { checkedAt: now + 2 });
    assert.equal(providerRuntimeIncident('agentmail', { now: now + 3 }).blocked, true, 'dry-run/config smoke must not clear runtime provider incident');
    dbModule.providerSmoke.set('agentmail', 'ok', { dryRun: false, live: true, opsCheck: true }, { checkedAt: now + 4 });
    assert.equal(providerRuntimeIncident('agentmail', { now: now + 5 }).blocked, false);
  });

  await check('call_analysis.durable_job_enqueues_idempotently', async () => {
    const leadId = 'ops_analysis_lead';
    const callId = 'call_ops_analysis';
    dbModule.leads.insert({
      id: leadId,
      container_tag: containerTagFor(leadId),
      business_name: 'Ops Analysis Studio',
      phone: '+14155550166',
      address: '5 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-analysis',
      source_url: 'https://example.test/ops-analysis',
      status: 'called'
    });
    dbModule.calls.start({
      id: callId,
      lead_id: leadId,
      provider_call_id: 'provider_ops_analysis',
      to_phone: '+14155550166',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'ops analysis durable check'
    });
    dbModule.calls.finish(callId, {
      outcome: 'demo-yes',
      transcript: { turns: [{ role: 'agent', text: 'Thanks for confirming the website order.' }] }
    });
    const first = enqueueCallAnalysis({ leadId, callId, source: 'ops-check' });
    const second = enqueueCallAnalysis({ leadId, callId, source: 'ops-check-duplicate' });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, CALL_ANALYSIS_JOB_TYPE);
    assert.equal(first.row.payload.leadId, leadId);
    const drained = await drainDurableJobsOnce({
      [CALL_ANALYSIS_JOB_TYPE]: async (payload) => {
        assert.equal(payload.leadId, leadId);
        assert.equal(payload.callId, callId);
        return { analyzed: true };
      }
    }, { workerId: 'ops-analysis-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.analyzed, true);
  });

  await check('call_analysis.provider_incident_blocks_without_gemini_retry_loop', async () => {
    const leadId = 'ops_analysis_provider_blocked';
    const callId = 'call_ops_analysis_provider_blocked';
    dbModule.leads.insert({
      id: leadId,
      container_tag: containerTagFor(leadId),
      business_name: 'Ops Blocked Analysis Studio',
      phone: '+14155550167',
      address: '55 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-analysis-blocked',
      source_url: 'https://example.test/ops-analysis-blocked',
      status: 'called'
    });
    dbModule.calls.start({
      id: callId,
      lead_id: leadId,
      provider_call_id: 'provider_ops_analysis_blocked',
      to_phone: '+14155550167',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'ops analysis provider blocked check'
    });
    dbModule.calls.finish(callId, {
      outcome: 'demo-yes',
      transcript: { turns: [{ role: 'agent', text: 'Thanks for confirming the order.' }] }
    });

    const incidentAt = Date.now();
    recordProviderRuntimeIncident({
      provider: 'gemini',
      error: new Error('gemini.generateContent failed: API key not valid'),
      action: 'callAnalysis',
      worker: 'analyst',
      leadId,
      eventId: callId,
      now: incidentAt
    });

    try {
      const queued = enqueueCallAnalysis({ leadId, callId, source: 'ops-provider-incident', maxAttempts: 5 });
      const drained = await drainDurableJobsOnce({
        [CALL_ANALYSIS_JOB_TYPE]: (payload) => runAnalyst({ leadId: payload.leadId, callId: payload.callId })
      }, { workerId: 'ops-analysis-provider-blocked-check', concurrency: 1, maxJobs: 1 });
      assert.equal(drained.claimed, 1);
      const failed = await waitForJob(dbModule.durableJobs, queued.row.id, ['failed', 'retry'], 8000);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.attempts, 1);
      assert.equal(failed.max_attempts, 5);
      assert.match(failed.error || '', /uncleared runtime incident/);

      const run = dbModule.db.prepare(`
        SELECT * FROM worker_runs
        WHERE lead_id = ? AND worker = 'analyst'
        ORDER BY started_at DESC
        LIMIT 1
      `).get(leadId);
      assert.equal(run.state, 'blocked');
      assert.equal(run.error, null);
      const detail = JSON.parse(run.detail_json || '{}');
      assert.equal(detail.provider, 'gemini');
      assert.match(detail.blocker || '', /uncleared runtime incident/);
    } finally {
      dbModule.providerSmoke.set('gemini', 'ok', { dryRun: false, live: true, opsCheck: true }, { checkedAt: Date.now() + 10 });
    }
  });

  await check('outreach_lead.durable_job_enqueues_idempotently', async () => {
    const leadId = 'ops_outreach_lead';
    dbModule.leads.insert({
      id: leadId,
      container_tag: containerTagFor(leadId),
      business_name: 'Ops Outreach Studio',
      phone: '+14155550165',
      address: '6 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-outreach',
      source_url: 'https://example.test/ops-outreach',
      status: 'discovered',
      outreach_status: 'running',
      next_action: 'call_in_progress'
    });
    const first = enqueueOutreachLeadJob({
      leadId,
      agentId: 'caller-ops',
      phoneClassification: 'business_landline',
      source: 'ops-check',
      idempotencyKey: 'ops-check:outreach-lead'
    });
    const second = enqueueOutreachLeadJob({
      leadId,
      agentId: 'caller-ops-duplicate',
      phoneClassification: 'business_landline',
      source: 'ops-check',
      idempotencyKey: 'ops-check:outreach-lead'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, OUTREACH_LEAD_JOB_TYPE);
    assert.equal(first.row.payload.leadId, leadId);
    const drained = await drainDurableJobsOnce({
      [OUTREACH_LEAD_JOB_TYPE]: async (payload) => {
        assert.equal(payload.leadId, leadId);
        assert.equal(payload.agentId, 'caller-ops');
        return { routed: true };
      }
    }, { workerId: 'ops-outreach-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.routed, true);
  });

  await check('cadence_call_retry.enqueues_durable_call_followup', async () => {
    const now = Date.now();
    const leadId = 'ops_cadence_call_retry';
    dbModule.leads.insert({
      id: leadId,
      container_tag: leadId,
      business_name: 'Ops Cadence Studio',
      phone: '+14155550164',
      address: '7 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-cadence',
      source_url: 'https://example.test/ops-cadence',
      status: 'discovered',
      outreach_status: 'retry',
      next_attempt_at: now - 1_000,
      attempt_channel: 'call_retry',
      attempt_count: 1,
      next_action: 'cadence_retry'
    });
    const fired = await executeDueChannel({ leadId, channel: 'call_retry' });
    assert.equal(fired.ok, true);
    assert.equal(fired.result?.fired, 'call.followup');
    const job = hydrateJobRow(dbModule.durableJobs.get(fired.result.jobId));
    assert.equal(job.type, 'call.followup');
    assert.equal(job.payload.leadId, leadId);
    assert.equal(job.payload.source, 'cadence_retry');
    const lead = dbModule.leads.get(leadId);
    assert.equal(lead.next_attempt_at, null);
    assert.equal(lead.attempt_channel, null);
    const drained = await drainDurableJobsOnce({
      'call.followup': async (payload) => {
        assert.equal(payload.leadId, leadId);
        return { called: true };
      }
    }, { workerId: 'ops-cadence-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, job.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.called, true);
  });

  await check('scheduled_callback.enqueues_durable_placement_job', async () => {
    const now = Date.now();
    const leadId = 'ops_scheduled_callback_lead';
    const scheduledCallId = 'sched_ops_callback_due';
    dbModule.leads.insert({
      id: leadId,
      container_tag: leadId,
      business_name: 'Ops Callback Studio',
      phone: '+14155550163',
      address: '8 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-callback',
      source_url: 'https://example.test/ops-callback',
      status: 'callback',
      outreach_status: 'inbound',
      next_action: 'scheduled_callback'
    });
    dbModule.scheduledCalls.start({
      id: scheduledCallId,
      lead_id: leadId,
      thread_id: 'thread_ops_callback',
      inbound_message_id: 'msg_ops_callback',
      scheduled_at_ms: now - 1_000,
      brief: { ask: 'Call me back after lunch', timezone: 'America/Los_Angeles' }
    });
    assert.equal(dbModule.scheduledCalls.markPlacing(scheduledCallId), true);
    const placing = dbModule.scheduledCalls.get(scheduledCallId);
    const first = enqueueScheduledCallPlacement(placing, { reason: 'ops-check' });
    const second = enqueueScheduledCallPlacement(placing, { reason: 'ops-check-duplicate' });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, SCHEDULED_CALL_JOB_TYPE);
    assert.equal(first.row.payload.scheduledCallId, scheduledCallId);
    const drained = await drainDurableJobsOnce({
      [SCHEDULED_CALL_JOB_TYPE]: async (payload) => {
        assert.equal(payload.scheduledCallId, scheduledCallId);
        assert.equal(payload.leadId, leadId);
        dbModule.scheduledCalls.markPlaced(scheduledCallId, { call_id: 'call_ops_scheduled_callback' });
        return { callId: 'call_ops_scheduled_callback' };
      }
    }, { workerId: 'ops-scheduled-call-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.callId, 'call_ops_scheduled_callback');
    const row = dbModule.scheduledCalls.get(scheduledCallId);
    assert.equal(row.status, 'placed');
    assert.equal(row.placed_call_id, 'call_ops_scheduled_callback');
  });

  await check('scheduled_callback.durable_job_retries_transient_dispatcher_failure', async () => {
    const leadId = 'ops_scheduled_retry_lead';
    const scheduledCallId = 'sched_ops_retry_callback';
    const now = Date.now();
    dbModule.leads.insert({
      id: leadId,
      container_tag: leadId,
      business_name: 'Ops Retry Callback Studio',
      phone: '+14155550172',
      address: '8 Retry Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-retry-callback',
      source_url: 'https://example.test/ops-retry-callback',
      status: 'callback',
      outreach_status: 'inbound',
      next_action: 'scheduled_callback'
    });
    dbModule.scheduledCalls.start({
      id: scheduledCallId,
      lead_id: leadId,
      thread_id: 'thread_ops_retry_callback',
      inbound_message_id: 'msg_ops_retry_callback',
      scheduled_at_ms: now - 1_000,
      brief: { ask: 'Please retry if AgentPhone hiccups', timezone: 'America/Los_Angeles' }
    });
    const queued = enqueueScheduledCallPlacement(dbModule.scheduledCalls.get(scheduledCallId), {
      reason: 'ops-check-retry',
      maxAttempts: 3
    });
    let dispatchAttempts = 0;
    const dispatcherFn = async () => {
      dispatchAttempts += 1;
      if (dispatchAttempts === 1) {
        const err = new Error('temporary AgentPhone network outage');
        err.retryable = true;
        throw err;
      }
      return { call_id: 'call_ops_retry_callback' };
    };
    const firstDrain = await drainDurableJobsOnce({
      [SCHEDULED_CALL_JOB_TYPE]: (payload, job) => handleScheduledCallPlacementJob(payload, job, { dispatcherFn })
    }, { workerId: 'ops-scheduled-retry-check', concurrency: 1, maxJobs: 1 });
    assert.equal(firstDrain.claimed, 1);
    const retrying = await waitForJob(dbModule.durableJobs, queued.row.id, ['retry', 'failed'], 8000);
    assert.equal(retrying.status, 'retry');
    assert.equal(dispatchAttempts, 1);
    const placing = dbModule.scheduledCalls.get(scheduledCallId);
    assert.equal(placing.status, 'placing');
    assert(Number(placing.lease_expires_at) > Date.now(), 'scheduled callback should keep a retry lease while the durable job retries');

    dbModule.db.prepare(`UPDATE jobs SET next_attempt_at = ? WHERE id = ?`).run(Date.now() - 1, queued.row.id);
    const secondDrain = await drainDurableJobsOnce({
      [SCHEDULED_CALL_JOB_TYPE]: (payload, job) => handleScheduledCallPlacementJob(payload, job, { dispatcherFn })
    }, { workerId: 'ops-scheduled-retry-check', concurrency: 1, maxJobs: 1 });
    assert.equal(secondDrain.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, queued.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.callId, 'call_ops_retry_callback');
    assert.equal(dispatchAttempts, 2);
    const placed = dbModule.scheduledCalls.get(scheduledCallId);
    assert.equal(placed.status, 'placed');
    assert.equal(placed.placed_call_id, 'call_ops_retry_callback');
  });

  await check('email_callback.durable_job_retries_callback_placement', async () => {
    const msg = {
      threadId: 'thread_ops_email_callback',
      messageId: 'msg_ops_email_callback_call_me',
      fromEmail: 'owner@ops-callback.test',
      subject: 'Please call me',
      text: 'Can you call me at (415) 555-0179 right now?'
    };
    const first = enqueueEmailCallbackJob({
      msg,
      eventId: 'evt_ops_email_callback',
      source: 'ops-check'
    });
    const second = enqueueEmailCallbackJob({
      msg,
      eventId: 'evt_ops_email_callback',
      source: 'ops-check-duplicate'
    });
    assert.equal(first.queued, true);
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, EMAIL_CALLBACK_JOB_TYPE);
    assert.equal(first.row.payload.resolvedPhone, '+14155550179');

    const failedDrain = await drainDurableJobsOnce({
      [EMAIL_CALLBACK_JOB_TYPE]: (payload, job) => handleEmailCallbackJob(payload, job, {
        callbackFn: async ({ msg: callbackMsg, resolvedPhone }) => {
          assert.equal(callbackMsg.messageId, 'msg_ops_email_callback_call_me');
          assert.equal(resolvedPhone, '+14155550179');
          return { fired: false, reason: 'place_failed', error: 'temporary AgentPhone outage' };
        }
      })
    }, { workerId: 'ops-email-callback-fail-check', concurrency: 1, maxJobs: 1 });
    assert.equal(failedDrain.claimed, 1);
    const retry = await waitForJob(dbModule.durableJobs, first.row.id, ['retry'], 8000);
    assert.equal(retry.status, 'retry');
    assert.match(retry.error || '', /temporary AgentPhone outage/);

    dbModule.db.prepare(`UPDATE jobs SET next_attempt_at = ? WHERE id = ?`).run(Date.now() - 1, first.row.id);
    const successDrain = await drainDurableJobsOnce({
      [EMAIL_CALLBACK_JOB_TYPE]: (payload, job) => handleEmailCallbackJob(payload, job, {
        callbackFn: async ({ resolvedPhone }) => ({
          fired: true,
          toPhone: resolvedPhone,
          callId: 'call_ops_email_callback',
          providerCallId: 'provider_ops_email_callback',
          leadId: 'lead_ops_email_callback'
        })
      })
    }, { workerId: 'ops-email-callback-success-check', concurrency: 1, maxJobs: 1 });
    assert.equal(successDrain.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.fired, true);
    assert.equal(completed.result?.providerCallId, 'provider_ops_email_callback');
    assert.equal(completed.attempts, 2);
  });

  await check('builder_build.enqueues_durable_job_idempotently', async () => {
    const leadId = 'ops_builder_lead';
    dbModule.leads.insert({
      id: leadId,
      container_tag: containerTagFor(leadId),
      business_name: 'Ops Builder Studio',
      phone: '+14155550164',
      address: '4 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: '',
      source_url: 'https://example.test/ops-builder',
      status: 'paid'
    });
    const first = enqueueBuilderBuild({
      leadId,
      buildId: 'bld_ops_builder',
      target: 'lovable',
      source: 'ops-check'
    });
    const second = enqueueBuilderBuild({
      leadId,
      buildId: 'bld_ops_builder',
      target: 'lovable',
      source: 'ops-check-duplicate'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, BUILDER_BUILD_JOB_TYPE);
    assert.equal(first.row.payload.leadId, leadId);
    assert.equal(first.row.payload.buildId, 'bld_ops_builder');
    const drained = await drainDurableJobsOnce({
      [BUILDER_BUILD_JOB_TYPE]: async (payload) => {
        assert.equal(payload.leadId, leadId);
        assert.equal(payload.buildId, 'bld_ops_builder');
        assert.equal(payload.target, 'lovable');
        return { buildId: payload.buildId, target: payload.target };
      }
    }, { workerId: 'ops-builder-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.buildId, 'bld_ops_builder');
  });

  await check('hosting_upsell.durable_job_retries_send_failures', async () => {
    const leadId = 'ops_hosting_upsell_lead';
    dbModule.leads.insert({
      id: leadId,
      container_tag: containerTagFor(leadId),
      business_name: 'Ops Hosting Studio',
      phone: '+14155550178',
      address: '8 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://ops-hosting.example.test',
      source_url: 'https://example.test/ops-hosting-upsell',
      status: 'awaiting_launch_approval',
      outreach_status: 'paid',
      next_action: 'customer_launch_approval'
    });
    const first = enqueueHostingUpsell({
      leadId,
      buildId: 'bld_ops_hosting',
      runId: 'build_ops_hosting',
      projectUrl: 'https://ops-hosting.example.test',
      target: 'lovable',
      mock: true,
      source: 'ops-check'
    });
    const second = enqueueHostingUpsell({
      leadId,
      buildId: 'bld_ops_hosting',
      runId: 'build_ops_hosting_duplicate',
      projectUrl: 'https://ops-hosting.example.test',
      target: 'lovable',
      mock: true,
      source: 'ops-check-duplicate'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, HOSTING_UPSELL_JOB_TYPE);
    assert.equal(first.row.payload.leadId, leadId);
    assert.equal(first.row.payload.buildId, 'bld_ops_hosting');

    const failDrain = await drainDurableJobsOnce({
      [HOSTING_UPSELL_JOB_TYPE]: (payload, job) => handleHostingUpsellJob(payload, job, {
        sendFn: async ({ leadId: sendLeadId, lead }) => {
          assert.equal(sendLeadId, leadId);
          assert.equal(lead.business_name, 'Ops Hosting Studio');
          return { sent: false, reason: 'send_failed', error: 'temporary AgentMail outage' };
        }
      })
    }, { workerId: 'ops-hosting-upsell-fail-check', concurrency: 1, maxJobs: 1 });
    assert.equal(failDrain.claimed, 1);
    const retry = await waitForJob(dbModule.durableJobs, first.row.id, ['retry'], 8000);
    assert.equal(retry.status, 'retry');
    assert.match(retry.error || '', /temporary AgentMail outage/);

    dbModule.db.prepare(`UPDATE jobs SET next_attempt_at = ? WHERE id = ?`).run(Date.now() - 1, first.row.id);
    const successDrain = await drainDurableJobsOnce({
      [HOSTING_UPSELL_JOB_TYPE]: (payload, job) => handleHostingUpsellJob(payload, job, {
        sendFn: async () => ({
          sent: true,
          messageId: 'msg_ops_hosting_upsell',
          threadId: 'thread_ops_hosting_upsell',
          acceptUrl: 'https://callan.example.test/api/hosting/accept/ops_hosting_upsell_lead'
        })
      })
    }, { workerId: 'ops-hosting-upsell-success-check', concurrency: 1, maxJobs: 1 });
    assert.equal(successDrain.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.sent, true);
    assert.equal(completed.result?.messageId, 'msg_ops_hosting_upsell');
    assert.equal(completed.attempts, 2);
  });

  await check('mailer_preview_build.enqueues_durable_builder_job_with_reply_context', async () => {
    const requestedLeadId = 'ops_preview_builder_lead';
    const inserted = dbModule.leads.insert({
      id: requestedLeadId,
      container_tag: containerTagFor(requestedLeadId),
      business_name: 'Ops Preview Studio',
      phone: '+14155550169',
      address: '10 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: '',
      source_url: 'https://example.test/ops-preview-builder',
      status: 'closing',
      outreach_status: 'awaiting_payment',
      next_action: 'await_payment'
    });
    const leadId = inserted.lead.id;
    const kickoff = startPreviewBuildKickoff({
      leadId,
      msg: {
        threadId: 'thread_ops_preview_builder',
        messageId: 'msg_ops_preview_builder_yes',
        fromEmail: 'owner@ops-preview.test'
      },
      affirm: {
        source: 'ops-check',
        pattern: 'yes',
        confidence: 0.99,
        excerpt: 'yes, please start'
      }
    });
    assert(kickoff.durableJobId, 'preview kickoff should expose durable job id');
    const job = hydrateJobRow(dbModule.durableJobs.get(kickoff.durableJobId));
    assert.equal(job.type, BUILDER_BUILD_JOB_TYPE);
    assert.equal(job.payload.leadId, leadId);
    assert.equal(job.payload.previewBuild, true);
    assert.equal(job.payload.buildId, `bld_preview_${leadId}`);
    assert.equal(job.payload.previewEmail.messageId, 'msg_ops_preview_builder_yes');
    assert.equal(job.payload.previewEmail.threadId, 'thread_ops_preview_builder');
    assert.equal(job.payload.previewEmail.toEmail, 'owner@ops-preview.test');
    const duplicate = enqueuePreviewBuilderBuild({
      leadId,
      threadId: 'thread_ops_preview_builder',
      messageId: 'msg_ops_preview_builder_yes',
      toEmail: 'owner@ops-preview.test',
      businessName: 'Ops Preview Studio'
    });
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.row.id, job.id);
    const lead = dbModule.leads.get(leadId);
    assert(lead.preview_build_triggered_at, 'preview trigger timestamp should be persisted before async work');
    assert.equal(lead.next_action, 'preview_build_running');
    const drained = await drainDurableJobsOnce({
      [BUILDER_BUILD_JOB_TYPE]: async (payload) => {
        assert.equal(payload.previewBuild, true);
        assert.equal(payload.previewEmail.messageId, 'msg_ops_preview_builder_yes');
        return { previewBuild: true, buildId: payload.buildId };
      }
    }, { workerId: 'ops-preview-builder-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, job.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.previewBuild, true);
  });

  await check('lead_priority.durable_job_scores_research_lead', async () => {
    const leadId = 'ops_priority_lead';
    dbModule.leads.insert({
      id: leadId,
      container_tag: containerTagFor(leadId),
      business_name: 'Ops Priority Studio',
      phone: '+14155550162',
      address: '2 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: '',
      source_url: 'https://example.test/ops-priority',
      status: 'discovered',
      outreach_status: 'not_queued',
      phone_classification: 'business_landline',
      research_json: JSON.stringify({
        businessName: 'Ops Priority Studio',
        hasWebsite: false,
        onlinePresenceStrength: 'weak',
        onlinePresenceConfidence: 0.9,
        needs: ['owned website'],
        sourceUrl: 'https://example.test/ops-priority'
      })
    });
    const first = enqueueLeadPriorityScore({
      leadId,
      source: 'ops-check',
      runId: 'priority-proof'
    });
    const second = enqueueLeadPriorityScore({
      leadId,
      source: 'ops-check',
      runId: 'priority-proof'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, LEAD_PRIORITY_SCORE_JOB_TYPE);
    const drained = await drainDurableJobsOnce({
      [LEAD_PRIORITY_SCORE_JOB_TYPE]: handleLeadPriorityScoreJob
    }, { workerId: 'ops-priority-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.leadId, leadId);
    assert(Number(completed.result?.score) > 0, `expected positive priority score, got ${completed.result?.score}`);
    const lead = dbModule.leads.get(leadId);
    assert.equal(lead.priority_score, completed.result.score);
  });

  await check('growth_plan.durable_job_generates_evidence_backed_plan', async () => {
    const requestedLeadId = 'ops_growth_plan_lead';
    const inserted = dbModule.leads.insert({
      id: requestedLeadId,
      container_tag: containerTagFor(requestedLeadId),
      business_name: 'Ops Growth Studio',
      phone: '+14155550165',
      address: '6 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-growth',
      source_url: 'https://example.test/ops-growth',
      status: 'shipped',
      research_json: JSON.stringify({
        businessName: 'Ops Growth Studio',
        niche: 'salon',
        city: 'Oakland',
        hasWebsite: true,
        onlinePresenceStrength: 'medium',
        onlinePresenceSummary: 'Website exists, but review capture and booking evidence are weak.',
        needs: ['review capture', 'booking request flow'],
        sourceUrl: 'https://example.test/ops-growth'
      })
    });
    const leadId = inserted.lead.id;
    dbModule.contactEvents.add({
      lead_id: leadId,
      type: 'customer_reply',
      direction: 'inbound',
      channel: 'agentmail',
      provider_id: 'msg_ops_growth_plan',
      thread_id: 'thread_ops_growth_plan',
      subject: 'After launch',
      body: 'Can you help us improve reviews and booking requests?',
      metadata: { opsCheck: true }
    });
    const first = enqueueGrowthPlanJob({
      leadId,
      force: true,
      source: 'ops-check',
      idempotencyKey: 'ops-check:growth-plan'
    });
    const second = enqueueGrowthPlanJob({
      leadId,
      force: true,
      source: 'ops-check-duplicate',
      idempotencyKey: 'ops-check:growth-plan'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, GROWTH_PLAN_JOB_TYPE);
    const drained = await drainDurableJobsOnce({
      [GROWTH_PLAN_JOB_TYPE]: handleGrowthPlanJob
    }, { workerId: 'ops-growth-plan-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert(completed.result?.growthPlanId, 'durable growth plan job did not return growthPlanId');
    const row = dbModule.growthPlans.getLatest(leadId);
    assert(row, 'growth plan should persist to SQLite');
    const plan = JSON.parse(row.plan_json);
    assert(plan.evidence?.length >= 1, 'growth plan should keep evidence citations');
  });

  await check('growth_followup.durable_job_sends_or_reuses_recap', async () => {
    const requestedLeadId = 'ops_growth_followup_lead';
    const inserted = dbModule.leads.insert({
      id: requestedLeadId,
      container_tag: containerTagFor(requestedLeadId),
      business_name: 'Ops Followup Studio',
      phone: '+14155550167',
      address: '7 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-growth-followup',
      source_url: 'https://example.test/ops-growth-followup',
      status: 'shipped',
      research_json: JSON.stringify({
        businessName: 'Ops Followup Studio',
        hasWebsite: true,
        needs: ['maintenance', 'analytics'],
        onlinePresenceSummary: 'Delivered website needs baseline analytics and launch maintenance.',
        sourceUrl: 'https://example.test/ops-growth-followup'
      })
    });
    const leadId = inserted.lead.id;
    await handleGrowthPlanJob({ leadId, force: true, source: 'ops-check-preseed' });
    const first = enqueueGrowthFollowupJob({
      leadId,
      source: 'ops-check',
      idempotencyKey: 'ops-check:growth-followup'
    });
    const second = enqueueGrowthFollowupJob({
      leadId,
      source: 'ops-check-duplicate',
      idempotencyKey: 'ops-check:growth-followup'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, GROWTH_FOLLOWUP_JOB_TYPE);
    const drained = await drainDurableJobsOnce({
      [GROWTH_FOLLOWUP_JOB_TYPE]: handleGrowthFollowupJob
    }, { workerId: 'ops-growth-followup-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.status, 'sent');
    assert(dbModule.growthFollowups.listByLead(leadId).some((row) => row.status === 'sent'), 'growth followup should persist sent recap');
  });

  await check('agentmail_poller.enqueues_durable_mail_reply', async () => {
    _resetAgentMailPollerState();
    const oldMessage = {
      messageId: 'msg_ops_mail_old',
      threadId: 'thread_ops_mail_old',
      fromEmail: 'old-owner@example.com',
      subject: 'Old message',
      text: 'This existed before the poller booted.'
    };
    const bootstrap = await processAgentMailPollerMessages([oldMessage], {
      enqueue: () => {
        throw new Error('bootstrap should not enqueue historical AgentMail messages');
      }
    });
    assert.equal(bootstrap.bootstrapped, true);
    assert.equal(bootstrap.queued, 0);

    const newMessage = {
      messageId: 'msg_ops_mail_new',
      threadId: 'thread_ops_mail_new',
      fromEmail: 'owner@example.com',
      subject: 'Can you call me?',
      text: 'Please call me back this afternoon.'
    };
    const first = await processAgentMailPollerMessages([newMessage], { enqueue: enqueueMailReplyJob });
    const duplicatePoll = await processAgentMailPollerMessages([newMessage], { enqueue: enqueueMailReplyJob });
    assert.equal(first.queued, 1);
    assert.equal(duplicatePoll.queued, 0);
    assert.equal(first.jobs[0].eventId, 'poll:msg_ops_mail_new');
    const job = hydrateJobRow(dbModule.durableJobs.get(first.jobs[0].jobId));
    assert.equal(job.type, MAIL_REPLY_JOB_TYPE);
    assert.equal(job.payload.eventId, 'poll:msg_ops_mail_new');
    assert.equal(job.payload.source, 'agentmail.poller');
    assert.equal(job.payload.normalized.messageId, 'msg_ops_mail_new');
    const duplicateJob = enqueueMailReplyJob({
      normalized: newMessage,
      body: newMessage,
      eventId: 'poll:msg_ops_mail_new',
      source: 'ops-check-duplicate'
    });
    assert.equal(duplicateJob.inserted, false);
    assert.equal(duplicateJob.row.id, job.id);
    const drained = await drainDurableJobsOnce({
      [MAIL_REPLY_JOB_TYPE]: async (payload) => {
        assert.equal(payload.eventId, 'poll:msg_ops_mail_new');
        assert.equal(payload.normalized.messageId, 'msg_ops_mail_new');
        return { replied: true };
      }
    }, { workerId: 'ops-agentmail-poller-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, job.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.replied, true);
  });

  await check('inbound_voice_followup.durable_job_runs_intake', async () => {
    const requestedLeadId = 'ops_inbound_voice_lead';
    const callId = 'call_ops_inbound_voice';
    const inserted = dbModule.leads.insert({
      id: requestedLeadId,
      container_tag: containerTagFor(requestedLeadId),
      business_name: 'Ops Voice Bakery',
      phone: '+14155550168',
      address: '9 Ops Way',
      niche: 'bakery',
      city: 'Oakland',
      website: 'https://example.test/ops-voice',
      source_url: 'https://example.test/ops-voice',
      status: 'inbound',
      outreach_status: 'inbound_intake',
      next_action: 'inbound_intake'
    });
    const leadId = inserted.lead.id;
    dbModule.calls.start({
      id: callId,
      lead_id: leadId,
      provider_call_id: 'provider_ops_inbound_voice',
      to_phone: '+14155550168',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'agentphone_inbound'
    });
    const transcript = [
      { role: 'user', text: 'My business is Ops Voice Bakery in Oakland. I need a website quote for my bakery.' },
      { role: 'agent', text: 'I can save the intake details from this call.' }
    ];
    const first = enqueueInboundVoiceFollowup({
      callId,
      leadId,
      transcript,
      eventId: 'ops-inbound-voice-terminal',
      stage: 'terminal',
      fromPhone: '+14155550168',
      outcome: 'demo-yes',
      writeMemory: false
    });
    const second = enqueueInboundVoiceFollowup({
      callId,
      leadId,
      transcript,
      eventId: 'ops-inbound-voice-terminal',
      stage: 'terminal',
      fromPhone: '+14155550168',
      outcome: 'demo-yes',
      writeMemory: false
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, INBOUND_VOICE_FOLLOWUP_JOB_TYPE);
    assert.equal(first.row.payload.stage, 'terminal');
    const drained = await drainDurableJobsOnce({
      [INBOUND_VOICE_FOLLOWUP_JOB_TYPE]: handleInboundVoiceFollowupJob
    }, { workerId: 'ops-inbound-voice-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.stage, 'terminal');
    assert.equal(completed.result?.intake?.leadId, leadId);
    const updated = dbModule.leads.get(leadId);
    assert(['awaiting_payment', 'inbound_intake'].includes(updated.outreach_status), updated.outreach_status);
  });

  await check('inbound_voice_email.persists_contact_event_and_reuses_on_retry', async () => {
    const requestedLeadId = 'ops_inbound_email_lead';
    const callId = 'call_ops_inbound_email';
    const inserted = dbModule.leads.insert({
      id: requestedLeadId,
      container_tag: containerTagFor(requestedLeadId),
      business_name: 'Ops Email Bakery',
      phone: '+14155550171',
      address: '10 Ops Way',
      niche: 'bakery',
      city: 'Oakland',
      website: 'https://example.test/ops-email',
      source_url: 'https://example.test/ops-email',
      status: 'inbound',
      outreach_status: 'inbound_intake',
      next_action: 'inbound_email'
    });
    const leadId = inserted.lead.id;
    dbModule.calls.start({
      id: callId,
      lead_id: leadId,
      provider_call_id: 'provider_ops_inbound_email',
      to_phone: '+14155550171',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'agentphone_inbound'
    });
    const transcript = [
      { role: 'user', text: 'Can you email me the details at owner@example.com?' },
      { role: 'agent', text: 'Yep, I will send the details to your inbox.' }
    ];
    let genericSends = 0;
    const first = await maybeFireInboundEmail({
      callRow: dbModule.calls.get(callId),
      lead: inserted.lead,
      transcript,
      requireAgentMailConfig: false,
      throwOnFailure: true,
      mailSender: async ({ toEmail, subject, text }) => {
        genericSends += 1;
        assert.equal(toEmail, 'owner@example.com');
        assert.match(subject, /Following up/);
        assert.match(text, /callmemaybe/);
        return {
          providerId: 'msg_ops_inbound_email',
          messageId: 'msg_ops_inbound_email',
          threadId: 'thread_ops_inbound_email'
        };
      }
    });
    assert.equal(genericSends, 1);
    assert.equal(first.email, 'owner@example.com');
    const genericEvents = dbModule.contactEvents.listByLead(leadId, { limit: 20 })
      .filter((event) => event.type === 'inbound_voice_followup');
    assert.equal(genericEvents.length, 1);
    const genericMeta = safeJson(genericEvents[0].metadata_json);
    assert.equal(genericMeta.callId, callId);
    assert.equal(genericMeta.trigger, 'inbound_voice');
    assert.equal(genericMeta.toMasked, 'o***r@example.com');

    _resetInboundIntentState();
    const reused = await maybeFireInboundEmail({
      callRow: dbModule.calls.get(callId),
      lead: inserted.lead,
      transcript,
      requireAgentMailConfig: false,
      throwOnFailure: true,
      mailSender: async () => {
        genericSends += 1;
        throw new Error('persisted inbound voice receipt should prevent resend');
      }
    });
    assert.equal(genericSends, 1);
    assert.equal(reused.reused, true);
    assert.equal(reused.contactEventId, genericEvents[0].id);

    const invoiceLeadId = 'ops_inbound_invoice_lead';
    const invoiceCallId = 'call_ops_inbound_invoice_email';
    const invoiceInserted = dbModule.leads.insert({
      id: invoiceLeadId,
      container_tag: containerTagFor(invoiceLeadId),
      business_name: 'Ops Invoice Florist',
      phone: '+14155550170',
      address: '12 Ops Way',
      niche: 'florist',
      city: 'Oakland',
      website: 'https://example.test/ops-invoice',
      source_url: 'https://example.test/ops-invoice',
      status: 'inbound',
      outreach_status: 'awaiting_payment',
      next_action: 'invoice_email'
    });
    dbModule.calls.start({
      id: invoiceCallId,
      lead_id: invoiceLeadId,
      provider_call_id: 'provider_ops_inbound_invoice_email',
      to_phone: '+14155550170',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'agentphone_inbound'
    });
    const invoiceTranscript = [
      { role: 'user', text: 'Please email me the invoice for the $500 website build at florist@example.com.' },
      { role: 'agent', text: 'Yep, I will have that invoice in your inbox in the next minute.' }
    ];
    let invoiceSends = 0;
    const invoiceFirst = await maybeFireInboundEmail({
      callRow: dbModule.calls.get(invoiceCallId),
      lead: invoiceInserted.lead,
      transcript: invoiceTranscript,
      requireAgentMailConfig: false,
      throwOnFailure: true,
      invoiceSender: async ({ recipient, callId: sentCallId, leadId: sentLeadId }) => {
        invoiceSends += 1;
        assert.equal(recipient, 'florist@example.com');
        assert.equal(sentCallId, invoiceCallId);
        assert.equal(sentLeadId, invoiceLeadId);
        return {
          context: { businessName: 'Ops Invoice Florist' },
          checkoutUrl: 'https://checkout.example.test/session_ops_invoice',
          subject: 'Ops Invoice Florist - invoice',
          text: 'Pay $500 on Stripe.',
          providerId: 'msg_ops_inbound_invoice',
          messageId: 'msg_ops_inbound_invoice',
          threadId: 'thread_ops_inbound_invoice'
        };
      }
    });
    assert.equal(invoiceSends, 1);
    assert.equal(invoiceFirst.checkoutUrl, 'https://checkout.example.test/session_ops_invoice');
    const invoiceEvents = dbModule.contactEvents.listByLead(invoiceLeadId, { limit: 20 })
      .filter((event) => event.type === 'callback_invoice');
    assert.equal(invoiceEvents.length, 1);
    const invoiceMeta = safeJson(invoiceEvents[0].metadata_json);
    assert.equal(invoiceMeta.callId, invoiceCallId);
    assert.equal(invoiceMeta.trigger, 'callback_invoice');
    assert.equal(invoiceMeta.checkoutUrl, 'https://checkout.example.test/session_ops_invoice');

    _resetInboundIntentState();
    const invoiceReused = await maybeFireInboundEmail({
      callRow: dbModule.calls.get(invoiceCallId),
      lead: invoiceInserted.lead,
      transcript: invoiceTranscript,
      requireAgentMailConfig: false,
      throwOnFailure: true,
      invoiceSender: async () => {
        invoiceSends += 1;
        throw new Error('persisted callback invoice receipt should prevent resend');
      }
    });
    assert.equal(invoiceSends, 1);
    assert.equal(invoiceReused.reused, true);
    assert.equal(invoiceReused.contactEventId, invoiceEvents[0].id);
  });

  await check('inbound_memory_hydration.durable_job_enqueues_idempotently', async () => {
    const leadId = 'ops_inbound_memory_lead';
    const callId = 'call_ops_inbound_memory';
    dbModule.leads.insert({
      id: leadId,
      container_tag: leadId,
      business_name: 'Inbound caller memory',
      phone: '+14155550160',
      address: '11 Ops Way',
      niche: 'inbound',
      city: 'Oakland',
      website: 'https://example.test/ops-memory',
      source_url: 'https://example.test/ops-memory',
      status: 'inbound',
      outreach_status: 'inbound',
      next_action: 'hydrate_memory'
    });
    dbModule.calls.start({
      id: callId,
      lead_id: leadId,
      provider_call_id: 'provider_ops_inbound_memory',
      to_phone: '+14155550160',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'agentphone_inbound'
    });
    const first = enqueueInboundMemoryHydration({
      callId,
      leadId,
      fromNumber: '+14155550160',
      eventId: 'ops-inbound-memory',
      source: 'ops-check'
    });
    const second = enqueueInboundMemoryHydration({
      callId,
      leadId,
      fromNumber: '+14155550160',
      eventId: 'ops-inbound-memory-duplicate',
      source: 'ops-check-duplicate'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, INBOUND_MEMORY_HYDRATE_JOB_TYPE);
    assert.equal(first.row.payload.callId, callId);
    const drained = await drainDurableJobsOnce({
      [INBOUND_MEMORY_HYDRATE_JOB_TYPE]: async (payload) => {
        assert.equal(payload.callId, callId);
        assert.equal(payload.leadId, leadId);
        return { hydrated: true, returning: false };
      }
    }, { workerId: 'ops-inbound-memory-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.hydrated, true);
  });

  await check('inbound_business_research.enqueues_durable_browser_research', async () => {
    const leadId = 'ops_inbound_research_lead';
    const callId = 'call_ops_inbound_research';
    dbModule.leads.insert({
      id: leadId,
      container_tag: leadId,
      business_name: 'Inbound caller research',
      phone: '+14155550159',
      address: '12 Ops Way',
      niche: 'inbound',
      city: 'Oakland',
      website: 'https://example.test/ops-research',
      source_url: 'https://example.test/ops-research',
      status: 'inbound',
      outreach_status: 'inbound',
      next_action: 'research_business'
    });
    dbModule.calls.start({
      id: callId,
      lead_id: leadId,
      provider_call_id: 'provider_ops_inbound_research',
      to_phone: '+14155550159',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'agentphone_inbound'
    });
    const callRow = dbModule.calls.get(callId);
    const first = maybeKickOffBusinessResearch({
      callRow,
      businessName: 'Ops Research Bakery',
      city: 'Oakland'
    });
    const second = maybeKickOffBusinessResearch({
      callRow,
      businessName: 'Ops Research Bakery',
      city: 'Oakland'
    });
    assert(first?.jobId, 'inbound research did not create a browser research job');
    assert.equal(first.jobId, second.jobId);
    const job = hydrateJobRow(dbModule.durableJobs.get(first.durableJobId));
    assert.equal(job.type, INBOUND_BUSINESS_RESEARCH_JOB_TYPE);
    assert.equal(job.payload.jobId, first.jobId);
    assert.equal(job.payload.callId, callId);
    assert.equal(job.payload.leadId, leadId);
    const drained = await drainDurableJobsOnce({
      [INBOUND_BUSINESS_RESEARCH_JOB_TYPE]: async (payload) => {
        assert.equal(payload.jobId, first.jobId);
        assert.equal(payload.source, 'inbound_business_mention');
        return { researchQueued: true, jobId: payload.jobId };
      }
    }, { workerId: 'ops-inbound-business-research-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, job.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.researchQueued, true);
  });

  await check('operator_transfer.durable_job_enqueues_idempotently', async () => {
    const leadId = 'ops_operator_transfer_lead';
    const callId = 'call_ops_operator_transfer';
    dbModule.leads.insert({
      id: leadId,
      container_tag: leadId,
      business_name: 'Ops Transfer Studio',
      phone: '+14155550161',
      address: '10 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-transfer',
      source_url: 'https://example.test/ops-transfer',
      status: 'calling',
      outreach_status: 'running',
      next_action: 'operator_transfer'
    });
    dbModule.calls.start({
      id: callId,
      lead_id: leadId,
      provider_call_id: 'provider_ops_operator_transfer',
      to_phone: '+14155550161',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'ops operator transfer durable check'
    });
    const first = enqueueOperatorTransferJob({
      callId,
      leadId,
      providerCallId: 'provider_ops_operator_transfer',
      reason: 'human_intent:speak to a human',
      source: 'ops-check'
    });
    const second = enqueueOperatorTransferJob({
      callId,
      leadId,
      providerCallId: 'provider_ops_operator_transfer',
      reason: 'human_intent:speak to a manager',
      source: 'ops-check-duplicate'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    assert.equal(first.row.type, OPERATOR_TRANSFER_JOB_TYPE);
    assert.equal(first.row.payload.callId, callId);
    const drained = await drainDurableJobsOnce({
      [OPERATOR_TRANSFER_JOB_TYPE]: handleOperatorTransferJob
    }, { workerId: 'ops-operator-transfer-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.transferred, false);
    assert.equal(completed.result?.reason, 'not_configured');
  });

  await check('ops_backup.durable_job_creates_fresh_sqlite_backup', async () => {
    const now = Date.now();
    const first = enqueueOpsBackup({
      now,
      intervalMs: 60_000,
      reason: 'ops-check'
    });
    const second = enqueueOpsBackup({
      now: now + 1,
      intervalMs: 60_000,
      reason: 'ops-check'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    const drained = await drainDurableJobsOnce({
      [OPS_BACKUP_JOB_TYPE]: runOpsBackupJob
    }, { workerId: 'ops-backup-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.ok, true);
    assert(completed.result.files?.some((file) => file.bytes > 0), 'backup job did not copy sqlite files');
    assert.equal(backupFreshness(latestBackupManifest()).ok, true);
  });

  await check('safe_to_sell_self_check.durable_job_records_snapshot', async () => {
    const now = Date.now();
    const first = enqueueSafeToSellSelfCheck({
      now,
      intervalMs: 60_000,
      reason: 'ops-check'
    });
    const second = enqueueSafeToSellSelfCheck({
      now: now + 1,
      intervalMs: 60_000,
      reason: 'ops-check'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    const drained = await drainDurableJobsOnce({
      [SAFE_TO_SELL_JOB_TYPE]: (payload) => runSafeToSellSelfCheck({ ...payload, source: 'ops-check-job' })
    }, { workerId: 'ops-safe-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert(completed.result?.snapshot?.id, 'safe-to-sell job did not record a snapshot');
    assert.equal(dbModule.safeToSellReports.latest().id, completed.result.snapshot.id);
    let scheduler = opsObservability({ now, windowMs: 60_000 }).schedulerHealth;
    let safeCheckHealth = scheduler.jobs.find((job) => job.type === SAFE_TO_SELL_JOB_TYPE);
    assert.equal(safeCheckHealth.enabled, true, 'safe-to-sell self-check should be part of recurring scheduler health');
    assert.equal(safeCheckHealth.ok, true, JSON.stringify(safeCheckHealth));
    dbModule.db.prepare(`
      UPDATE jobs
      SET finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now - 49 * 3600 * 1000, now - 49 * 3600 * 1000, first.row.id);
    scheduler = opsObservability({ now, windowMs: 60_000 }).schedulerHealth;
    safeCheckHealth = scheduler.jobs.find((job) => job.type === SAFE_TO_SELL_JOB_TYPE);
    assert.equal(safeCheckHealth.ok, false, 'scheduler health should flag stale safe-to-sell self-check jobs');
    assert(scheduler.blockers.some((blocker) => /ops\.safe_to_sell last completed job is stale/.test(blocker)), scheduler.blockers.join('\n'));
    dbModule.db.prepare(`
      UPDATE jobs
      SET finished_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, first.row.id);
  });

  await check('account_manager_aftercare.durable_job_previews_due_task', async () => {
    const now = Date.now();
    const leadId = 'ops_aftercare_lead';
    dbModule.leads.insert({
      id: leadId,
      container_tag: leadId,
      business_name: 'Ops Aftercare Studio',
      phone: '+14155550177',
      address: '3 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-aftercare',
      source_url: 'https://example.test/ops-aftercare',
      status: 'shipped',
      research_json: JSON.stringify({ hours: 'Unknown; not found in source.', needs: ['review capture'] })
    });
    const task = dbModule.accountTasks.insertOrUpdate({
      id: 'acctask_ops_aftercare',
      lead_id: leadId,
      account_plan_id: null,
      kind: 'launch_followup',
      title: '24h launch check',
      summary: 'Check that the launched site is still working for the customer.',
      due_at: now - 1_000,
      priority: 'high',
      channel: 'agentmail',
      evidence_ids: ['ops_aftercare_evidence'],
      idempotency_key: 'ops-check:aftercare-task'
    }).row;
    const first = enqueueAccountManagerRun({
      taskId: task.id,
      dryRun: true,
      now,
      intervalMs: 60_000,
      source: 'ops-check',
      reason: 'ops-check'
    });
    const second = enqueueAccountManagerRun({
      taskId: task.id,
      dryRun: true,
      now: now + 1,
      intervalMs: 60_000,
      source: 'ops-check',
      reason: 'ops-check'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    const drained = await drainDurableJobsOnce({
      [ACCOUNT_MANAGER_RUN_JOB_TYPE]: handleAccountManagerRunJob
    }, { workerId: 'ops-aftercare-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.processed, 1);
    const updated = dbModule.accountTasks.get(task.id);
    assert(updated.preview?.body, 'durable aftercare job did not persist preview body');
    assert(updated.preview.body.includes('Ops Aftercare Studio'), 'preview should be customer-specific');
  });

  await check('readiness.stale_smoke_blocks_production_live', async () => {
    configureProductionReadyPosture(env);
    seedFreshWebhooks(dbModule.webhookEvents);
    resetProductionProviderSmoke(dbModule);
    const now = Date.now();
    const staleAt = now - 48 * 3600 * 1000;
    for (const provider of productionSmokeProviders) {
      dbModule.providerSmoke.set(provider, 'ok', {
        dryRun: false,
        live: true,
        opsCheck: true
      }, { checkedAt: provider === 'gemini' ? staleAt : now - 1_000 });
    }
    const readiness = liveReadiness();
    assert(readiness.productionBlockers.some((blocker) => /gemini live smoke is stale/i.test(blocker)), readiness.productionBlockers.join('\n'));
  });

  await check('readiness.promotion_gates_require_live_smoke_for_production_live', async () => {
    configureProductionReadyPosture(env);
    seedFreshWebhooks(dbModule.webhookEvents);
    resetProductionProviderSmoke(dbModule);
    for (const provider of productionSmokeProviders) {
      dbModule.providerSmoke.set(provider, 'ok', { dryRun: true, live: false, opsCheck: true });
    }
    const readiness = liveReadiness();
    assert.equal(readiness.canGoLive, false, 'dry-run ok smoke must not allow production_live');
    assert(readiness.productionBlockers.some((blocker) => /live smoke has not passed/i.test(blocker)), readiness.productionBlockers.join('\n'));
    assert.equal(readiness.promotionGates.productionLive.ok, false);
    assert(readiness.promotionGates.productionLive.gates.some((gate) => gate.name === 'live_smoke_freshness' && gate.ok === false), 'missing live smoke promotion gate');

    const report = await buildSafeToSellReport({
      now: Date.now(),
      evals: {
        ok: true,
        summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
        cases: []
      }
    });
    assert(report.nextActions.some((action) => action.includes('SMOKE_GEMINI=true npm run smoke:providers -- --provider gemini')), report.nextActions.join('\n'));
    assert(report.nextActions.some((action) => action.includes('SMOKE_MOSS_INDEX=true npm run smoke:providers -- --provider moss')), report.nextActions.join('\n'));
    assert(report.nextActions.some((action) => action.includes('SMOKE_LIVE_CALL=true SMOKE_TEST_PHONE=<owned-number> npm run smoke:providers -- --provider agentphone')), report.nextActions.join('\n'));
    assert(report.nextActions.some((action) => action.includes('SMOKE_AGENTMAIL_SEND=true SMOKE_TEST_EMAIL=<operator-email> npm run smoke:providers -- --provider agentmail')), report.nextActions.join('\n'));
  });

  await check('safe_to_sell.next_actions_fix_failed_live_smoke_before_rerun', async () => {
    configureProductionReadyPosture(env);
    seedFreshWebhooks(dbModule.webhookEvents);
    resetProductionProviderSmoke(dbModule);
    const now = Date.now();
    for (const provider of productionSmokeProviders) {
      dbModule.providerSmoke.set(provider, 'ok', {
        dryRun: false,
        live: true,
        opsCheck: true
      }, { checkedAt: now - 1_000 });
    }
    dbModule.providerSmoke.set('gemini', 'failed', {
      dryRun: false,
      live: true,
      error: 'gemini.generateText failed: API_KEY_INVALID for key AIzaSySecret987654',
      opsCheck: true
    }, { checkedAt: now, error: 'API_KEY_INVALID for key AIzaSySecret987654' });

    const report = await buildSafeToSellReport({
      now,
      evals: {
        ok: true,
        summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
        cases: []
      }
    });
    const action = report.nextActions.find((item) => item.includes('SMOKE_GEMINI=true npm run smoke:providers -- --provider gemini'));
    assert(action, report.nextActions.join('\n'));
    assert(action.includes('fix gemini live smoke failure (API key not valid)'), action);
    assert(action.includes('and rerun'), action);
    assert(!action.includes('AIzaSySecret987654'), action);
    assert(report.stillBlocked.some((blocker) => blocker === 'gemini last error: API key not valid'), report.stillBlocked.join('\n'));
    assert(!JSON.stringify(report.stillBlocked).includes('type.googleapis.com'), report.stillBlocked.join('\n'));
    assert(!JSON.stringify(report.nextActions).includes('AIzaSySecret987654'), report.nextActions.join('\n'));
  });

  await check('readiness.live_smoke_gate_survives_newer_dry_run_smoke', async () => {
    configureProductionReadyPosture(env);
    seedFreshWebhooks(dbModule.webhookEvents);
    resetProductionProviderSmoke(dbModule);
    const now = Date.now();
    for (const provider of productionSmokeProviders) {
      dbModule.providerSmoke.set(provider, 'ok', {
        dryRun: false,
        live: true,
        opsCheck: true
      }, { checkedAt: now - 1_000 });
      dbModule.providerSmoke.set(provider, 'configured', {
        dryRun: true,
        live: false,
        opsCheck: true
      }, { checkedAt: now });
    }
    const readiness = liveReadiness();
    const liveGate = readiness.promotionGates.productionLive.gates.find((gate) => gate.name === 'live_smoke_freshness');
    assert.equal(liveGate.ok, true, JSON.stringify(liveGate));
    assert.equal(readiness.canGoLive, true, readiness.productionBlockers.join('\n'));
    for (const provider of productionSmokeProviders) {
      assert.equal(readiness.providers[provider].smokeStatus, 'configured');
      assert.equal(readiness.providers[provider].dryRunSmoke.status, 'configured');
      assert.equal(readiness.providers[provider].liveSmoke.status, 'ok');
      assert.equal(readiness.providers[provider].liveSmoke.live, true);
    }
  });

	  await check('admin_auth.production_modes_require_strong_operator_token', async () => {
    const missing = adminAuthPosture({ mode: 'production_live', nodeEnv: 'production', token: '' });
    assert.equal(missing.ok, false);
    assert(missing.blockers.some((blocker) => blocker.includes('ADMIN_API_TOKEN is required')), missing.blockers.join('\n'));
    const weak = adminAuthPosture({ mode: 'production_review', nodeEnv: 'test', token: 'short' });
    assert.equal(weak.ok, false);
    assert(weak.blockers.some((blocker) => blocker.includes('at least 24 characters')), weak.blockers.join('\n'));
    assert.equal(adminAuthStatus({ providedToken: 'short', configuredToken: 'short', mode: 'production_review', nodeEnv: 'test' }).code, 'ADMIN_AUTH_WEAK_TOKEN');
    const token = 'ops-admin-token-0123456789';
    const ready = adminAuthPosture({ mode: 'production_live', nodeEnv: 'production', token });
    assert.equal(ready.ok, true);
    assert.equal(adminAuthStatus({ providedToken: token, configuredToken: token, mode: 'production_live', nodeEnv: 'production' }).ok, true);
    const wrong = adminAuthStatus({ providedToken: 'wrong', configuredToken: token, mode: 'production_live', nodeEnv: 'production' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'ADMIN_AUTH_REQUIRED');
    const local = adminAuthStatus({ providedToken: '', configuredToken: '', mode: 'mock', nodeEnv: 'test' });
    assert.equal(local.ok, true);
    assert.equal(local.enforced, false);
    assert.equal(isOperatorControlMutation({ method: 'POST', path: '/api/leads/lead_123/call' }), true);
    assert.equal(isOperatorControlMutation({ method: 'POST', path: '/api/outreach/start' }), true);
    assert.equal(isOperatorControlMutation({ method: 'POST', path: '/api/webhooks/stripe' }), false);
    assert.equal(isOperatorControlMutation({ method: 'POST', path: '/api/share/build/token123/accept' }), false);
    assert.equal(isOperatorControlMutation({ method: 'GET', path: '/api/leads' }), false);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/ping' }), false);
    assert.equal(isOperatorDataRead({ method: 'HEAD', path: '/api/ping' }), false);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/ops/command-center' }), true);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/jobs/health' }), true);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/leads' }), true);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/health' }), true);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/admin/export' }), true);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/admin/backups' }), true);
    assert.equal(isOperatorControlMutation({ method: 'POST', path: '/api/admin/backup' }), true);
    assert.equal(isOperatorControlMutation({ method: 'POST', path: '/api/admin/reset-mock-data' }), true);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/share/build/token123' }), false);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/hosting/accept/lead123' }), false);
    assert.equal(isOperatorDataRead({ method: 'GET', path: '/api/preview-build/build123/screenshot.png' }), false);
    assert.equal(isOperatorProtectedRequest({ method: 'GET', path: '/api/ping' }), false);
    assert.equal(isOperatorProtectedRequest({ method: 'GET', path: '/api/ops/observability' }), true);
    assert.equal(isOperatorProtectedRequest({ method: 'POST', path: '/api/leads/discover' }), true);
    assert.equal(extractAdminToken({
      get: (name) => name === 'cookie' ? 'callan_admin_token=ops-admin-token-0123456789' : ''
    }), token);
  });

  await check('readiness.production_review_gate_allows_dry_run_only_posture', async () => {
    configureProductionReadyPosture(env);
    env.runMode = 'production_review';
    env.nodeEnv = 'test';
    env.publicUrl = 'http://localhost:8787';
    env.outreach.enabled = true;
    Object.assign(env.live, {
      calls: false,
      emails: false,
      payments: false,
      invoices: false,
      browserSessions: false,
      publicOutreach: false,
      builds: false
    });
    seedFreshWebhooks(dbModule.webhookEvents);
    for (const provider of ['gemini', 'supermemory', 'moss', 'agentphone', 'browserUse', 'lovable', 'agentmail', 'stripe']) {
      dbModule.providerSmoke.set(provider, 'configured', { dryRun: true, live: false, opsCheck: true });
    }
    const readiness = liveReadiness();
    assert.equal(readiness.promotionGates.productionReview.ok, true, JSON.stringify(readiness.promotionGates.productionReview.blockers));
    assert.equal(readiness.promotionGates.productionLive.ok, false, 'production_review dry-run posture must not imply production_live readiness');
    assert(readiness.promotionGates.productionLive.blockers.some((blocker) => /RUN_MODE is not production_live/.test(blocker)));
  });

  await check('safe_to_sell.next_actions_name_missing_webhook_secret_and_endpoint', async () => {
    configureProductionReadyPosture(env);
    env.runMode = 'production_review';
    env.nodeEnv = 'test';
    env.publicUrl = 'https://callan.example.com';
    env.agentmail.webhookSecret = '';
    Object.assign(env.live, {
      calls: false,
      emails: false,
      payments: false,
      invoices: false,
      browserSessions: false,
      publicOutreach: false,
      builds: false
    });
    seedFreshWebhooks(dbModule.webhookEvents);
    for (const provider of productionSmokeProviders) {
      dbModule.providerSmoke.set(provider, 'configured', { dryRun: true, live: false, opsCheck: true });
    }
    const report = await buildSafeToSellReport({
      now: Date.now(),
      evals: {
        ok: true,
        summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
        cases: []
      }
    });
    assert(report.nextActions.some((action) => (
      action.includes('set AGENTMAIL_WEBHOOK_SECRET')
      && action.includes('register AgentMail webhook endpoint https://callan.example.com/api/webhooks/agentmail')
    )), report.nextActions.join('\n'));
  });

  await check('safe_to_sell.next_actions_group_public_webhook_url', async () => {
    configureProductionReadyPosture(env);
    env.publicUrl = 'http://localhost:8787';
    seedFreshWebhooks(dbModule.webhookEvents);
    for (const provider of productionSmokeProviders) {
      dbModule.providerSmoke.set(provider, 'configured', { dryRun: true, live: false, opsCheck: true });
    }
    const report = await buildSafeToSellReport({
      now: Date.now(),
      evals: {
        ok: true,
        summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
        cases: []
      }
    });
    const grouped = report.nextActions.filter((action) => (
      action.startsWith('set APP_PUBLIC_URL to the public https origin before registering provider webhook endpoints:')
    ));
    assert.equal(grouped.length, 1, report.nextActions.join('\n'));
    assert(grouped[0].includes('/api/webhooks/agentphone'), grouped[0]);
    assert(grouped[0].includes('/api/webhooks/agentmail'), grouped[0]);
    assert(grouped[0].includes('/api/webhooks/stripe'), grouped[0]);
    assert(!report.nextActions.some((action) => (
      action.startsWith('set APP_PUBLIC_URL to the public https origin before registering AgentPhone webhook endpoint')
    )), report.nextActions.join('\n'));
  });

  await check('provider_posture.durable_job_records_dry_run_without_overwriting_latest_smoke', async () => {
    configureProductionReadyPosture(env);
    env.runMode = 'production_review';
    env.nodeEnv = 'test';
    env.publicUrl = 'http://localhost:8787';
    Object.assign(env.live, {
      calls: false,
      emails: false,
      payments: false,
      invoices: false,
      browserSessions: false,
      publicOutreach: false,
      builds: false
    });
    dbModule.providerSmoke.set('agentphone', 'failed', {
      dryRun: false,
      live: true,
      error: 'owned-number smoke failed before posture refresh',
      opsCheck: true
    }, { checkedAt: Date.now() - 1_000, error: 'owned-number smoke failed before posture refresh' });
    const before = dbModule.providerSmoke.all().agentphone;
    const now = Date.now();
    const first = enqueueProviderPostureRefresh({
      now,
      intervalMs: 60_000,
      reason: 'ops-check'
    });
    const second = enqueueProviderPostureRefresh({
      now: now + 1,
      intervalMs: 60_000,
      reason: 'ops-check'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    const drained = await drainDurableJobsOnce({
      [OPS_PROVIDER_POSTURE_JOB_TYPE]: runProviderPostureJob
    }, { workerId: 'ops-provider-posture-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.liveSideEffects, false);
    assert.equal(completed.result?.providers?.length >= 8, true);

    const after = dbModule.providerSmoke.all().agentphone;
    assert.equal(after.status, 'failed', 'posture refresh must not overwrite the latest smoke row');
    assert.equal(after.checkedAt, before.checkedAt, 'posture refresh must leave latest smoke timestamp intact');
    const dryRun = dbModule.providerSmoke.latestEvent({ provider: 'agentphone', dryRun: true });
    assert.equal(dryRun.status, 'configured');
    assert.equal(dryRun.detail.postureOnly, true);

    const readiness = liveReadiness();
    const dryRunGate = readiness.promotionGates.productionReview.gates.find((gate) => gate.name === 'dry_run_smoke_freshness');
    assert.equal(dryRunGate.detail.agentphone.status, 'configured');
    assert(readiness.providers.agentphone.lastError.includes('owned-number smoke failed'), 'latest live failure should remain visible');
  });

  await check('ops_recovery.durable_job_recovers_stale_jobs_calls_and_scheduled_calls', async () => {
    const now = Date.now();
    const staleJob = dbModule.durableJobs.enqueue({
      type: 'ops.recovery.fixture',
      payload: { marker: 'recover me' },
      idempotency_key: 'ops-check:recovery-fixture',
      maxAttempts: 3,
      now
    }).row;
    const claimed = dbModule.durableJobs.claimNext({
      workerId: 'ops-check-stale-worker',
      leaseMs: 1,
      now
    });
    assert.equal(claimed.id, staleJob.id);
    dbModule.db.prepare(`
      UPDATE jobs
      SET lease_expires_at = ?, locked_at = ?
      WHERE id = ?
    `).run(now - 1_000, now - 2_000, staleJob.id);

    const leadId = 'demo_ops_recovery_lead';
    dbModule.leads.insert({
      id: leadId,
      container_tag: leadId,
      business_name: 'Ops Recovery Studio',
      phone: '+14155550188',
      address: '4 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/ops-recovery',
      source_url: 'https://example.test/ops-recovery',
      status: 'called'
    });
    dbModule.calls.start({
      id: 'call_ops_recovery_stale',
      lead_id: leadId,
      provider_call_id: 'provider_ops_recovery_stale',
      to_phone: '+14155550188',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'ops durable recovery check'
    });
    dbModule.db.prepare(`UPDATE calls SET started_at = ? WHERE id = ?`).run(now - 2 * 3600 * 1000, 'call_ops_recovery_stale');
    dbModule.scheduledCalls.start({
      id: 'sched_ops_recovery_stale',
      lead_id: leadId,
      thread_id: 'thread_ops_recovery',
      inbound_message_id: 'msg_ops_recovery',
      scheduled_at_ms: now - 60_000,
      brief: { source: 'ops-check' }
    });
    assert.equal(dbModule.scheduledCalls.markPlacing('sched_ops_recovery_stale'), true);
    dbModule.db.prepare(`UPDATE scheduled_calls SET fired_at = ?, lease_expires_at = ? WHERE id = ?`)
      .run(now - 5 * 60 * 1000, now - 60_000, 'sched_ops_recovery_stale');

    const first = enqueueOpsRecovery({
      now,
      intervalMs: 60_000,
      reason: 'ops-check'
    });
    const second = enqueueOpsRecovery({
      now: now + 1,
      intervalMs: 60_000,
      reason: 'ops-check'
    });
    assert.equal(first.row.id, second.row.id);
    assert.equal(second.inserted, false);
    const drained = await drainDurableJobsOnce({
      [OPS_RECOVER_STUCK_JOB_TYPE]: runOpsRecoveryJob
    }, { workerId: 'ops-recovery-check', concurrency: 1, maxJobs: 1 });
    assert.equal(drained.claimed, 1);
    const completed = await waitForJob(dbModule.durableJobs, first.row.id, ['completed', 'failed'], 8000);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result?.jobs?.recovered >= 1, true);
    assert.equal(completed.result?.calls?.recovered, 1);
    assert.equal(completed.result?.scheduledCalls?.recovered, 1);
    assert.equal(dbModule.durableJobs.get(staleJob.id).status, 'retry');
    assert.equal(dbModule.calls.get('call_ops_recovery_stale').state, 'ended');
    assert.equal(dbModule.scheduledCalls.get('sched_ops_recovery_stale').status, 'pending');

    let scheduler = opsObservability({ now, windowMs: 60_000 }).schedulerHealth;
    let recoveryHealth = scheduler.jobs.find((job) => job.type === OPS_RECOVER_STUCK_JOB_TYPE);
    assert.equal(recoveryHealth.ok, true, JSON.stringify(recoveryHealth));
    dbModule.db.prepare(`
      UPDATE jobs
      SET finished_at = ?, updated_at = ?
      WHERE type = ? AND status = 'completed'
    `).run(now - 20 * 60 * 1000, now - 20 * 60 * 1000, OPS_RECOVER_STUCK_JOB_TYPE);
    scheduler = opsObservability({ now, windowMs: 60_000 }).schedulerHealth;
    recoveryHealth = scheduler.jobs.find((job) => job.type === OPS_RECOVER_STUCK_JOB_TYPE);
    assert.equal(recoveryHealth.ok, false, 'scheduler health should flag stale recurring recovery jobs');
    assert(scheduler.blockers.some((blocker) => /ops\.recover_stuck last completed job is stale/.test(blocker)), scheduler.blockers.join('\n'));
  });

  await check('safe_to_sell.preflight_refreshes_stale_ops_maintenance', async () => {
    const now = Date.now();
    const recovery = enqueueOpsRecovery({
      now,
      intervalMs: 60_000,
      reason: 'ops-check-preflight-seed',
      idempotencyKey: `ops-check:preflight-recovery:${now}`
    });
    const accountManager = enqueueAccountManagerRun({
      now,
      intervalMs: 60_000,
      reason: 'ops-check-preflight-seed',
      source: 'ops-check-preflight',
      idempotencyKey: `ops-check:preflight-account-manager:${now}`
    });
    const drained = await drainDurableJobsOnce({
      [OPS_RECOVER_STUCK_JOB_TYPE]: runOpsRecoveryJob,
      [ACCOUNT_MANAGER_RUN_JOB_TYPE]: handleAccountManagerRunJob
    }, { workerId: 'ops-preflight-seed', concurrency: 2, maxJobs: 2 });
    assert.equal(drained.claimed, 2);
    const seeded = await waitForJob(dbModule.durableJobs, recovery.row.id, ['completed', 'failed'], 8000);
    assert.equal(seeded.status, 'completed');
    const seededAccountManager = await waitForJob(dbModule.durableJobs, accountManager.row.id, ['completed', 'failed'], 8000);
    assert.equal(seededAccountManager.status, 'completed');
    dbModule.db.prepare(`
      UPDATE jobs
      SET finished_at = ?, updated_at = ?
      WHERE status = 'completed'
        AND type IN (?, ?)
    `).run(now - 60 * 60 * 1000, now - 60 * 60 * 1000, OPS_RECOVER_STUCK_JOB_TYPE, ACCOUNT_MANAGER_RUN_JOB_TYPE);
    let scheduler = opsObservability({ now, windowMs: 60_000 }).schedulerHealth;
    assert(scheduler.blockers.some((blocker) => /ops\.recover_stuck last completed job is stale/.test(blocker)), scheduler.blockers.join('\n'));
    assert(scheduler.blockers.some((blocker) => /account_manager\.run last completed job is stale/.test(blocker)), scheduler.blockers.join('\n'));

    const report = await runSafeToSellSelfCheck({
      record: false,
      source: 'ops-check-preflight',
      now
    });
    const refreshedRecovery = report.maintenance?.jobs?.find((job) => job.type === OPS_RECOVER_STUCK_JOB_TYPE);
    assert(refreshedRecovery, 'safe-to-sell preflight did not select stale ops.recover_stuck');
    assert.equal(refreshedRecovery.status, 'completed');
    const refreshedAccountManager = report.maintenance?.jobs?.find((job) => job.type === ACCOUNT_MANAGER_RUN_JOB_TYPE);
    assert(refreshedAccountManager, 'safe-to-sell preflight did not select stale account_manager.run');
    assert.equal(refreshedAccountManager.status, 'completed');
    assert.equal(report.observability.schedulerHealth.ok, true, JSON.stringify(report.observability.schedulerHealth.blockers));
    assert(!report.stillBlocked.some((blocker) => /ops\.recover_stuck last completed job is stale/.test(blocker)), report.stillBlocked.join('\n'));
    assert(!report.stillBlocked.some((blocker) => /account_manager\.run last completed job is stale/.test(blocker)), report.stillBlocked.join('\n'));
  });

  await check('safe_to_sell.preflight_failure_fails_closed', async () => {
    const gated = applySafeToSellMaintenanceGate({
      ok: true,
      stillBlocked: []
    }, {
      ok: false,
      refreshed: 0,
      jobs: [{
        type: OPS_BACKUP_JOB_TYPE,
        status: 'failed',
        error: 'disk full'
      }]
    });
    assert.equal(gated.ok, false);
    assert.equal(gated.maintenance.ok, false);
    assert(gated.stillBlocked.some((blocker) => blocker === 'safe-to-sell maintenance failed: ops.backup (disk full)'), gated.stillBlocked.join('\n'));
  });

  await check('provider_health_events.capture_latency_and_failures', async () => {
    const provider = 'ops_history_provider';
    const since = Date.now() - 60_000;
    dbModule.providerSmoke.set(provider, 'ok', {
      dryRun: false,
      live: true,
      durationMs: 123,
      opsCheck: true
    }, { checkedAt: Date.now() - 1_000, durationMs: 123 });
    dbModule.providerSmoke.set(provider, 'failed', {
      dryRun: false,
      live: false,
      error: 'boom',
      durationMs: 45,
      opsCheck: true
    }, { durationMs: 45 });

    const events = dbModule.providerSmoke.events({ provider, since, limit: 10 });
    assert.equal(events.length, 2);
    assert.equal(events[0].status, 'failed');
    assert.equal(events[0].error, 'boom');
    const summary = dbModule.providerSmoke.historySummary({ since }).find((row) => row.provider === provider);
    assert(summary, 'missing provider history summary');
    assert.equal(summary.total, 2);
    assert.equal(summary.okCount, 1);
    assert.equal(summary.failedCount, 1);
    assert.equal(summary.liveCount, 1);
    assert.equal(summary.avgDurationMs, 84);
    assert.equal(summary.lastError, 'boom');
    const observability = opsObservability({ now: Date.now(), windowMs: 60_000 });
    assert(observability.providerHistory.some((row) => row.provider === provider), 'ops observability missing provider history');
    assert(observability.recentProviderFailures.some((row) => row.provider === provider && row.error === 'boom'), 'ops observability missing provider failure');
    dbModule.providerSmoke.set('ops_pii_provider', 'failed', {
      dryRun: false,
      live: false,
      error: 'provider failed for owner@example.com at +14155550123',
      durationMs: 12,
      opsCheck: true
    }, { checkedAt: Date.now(), durationMs: 12 });
    const piiIssue = dbModule.providerSmoke.issues({ since, limit: 10 }).find((row) => row.provider === 'ops_pii_provider');
    assert(piiIssue, 'missing PII provider issue');
    const piiSerialized = JSON.stringify(piiIssue);
    assert(!piiSerialized.includes('owner@example.com'), 'provider health event leaked email');
    assert(!piiSerialized.includes('+14155550123'), 'provider health event leaked phone');
  });

  await check('safe_to_sell_reports.persist_self_check_history', async () => {
    const now = Date.now();
    const report = {
      version: SAFE_TO_SELL_REPORT_VERSION,
      ok: false,
      generatedAt: new Date(now).toISOString(),
      command: 'npm run safe-to-sell',
      mode: 'production_review',
      dryRunVerified: [{ provider: 'agentmail', status: 'configured', checkedAt: Date.now() }],
      liveSmokeVerified: [{ provider: 'stripe', status: 'ok', checkedAt: Date.now() }],
      stillBlocked: ['ops check blocker for owner@example.com and +14155550123'],
      queue: { staleRunning: 0 },
      evals: { ok: true, summary: { total: 6, passed: 6, failed: 0 } },
      observability: { dailyEconomics: { revenueUsd: 0, costUsd: 1, marginUsd: -1 } },
      backups: {
        ok: true,
        backupDir: `${dataDir}/backups`,
        latest: { file: 'callan-backup-test-callmemaybe.db', path: `${dataDir}/backups/callan-backup-test-callmemaybe.db` }
      }
    };
    report.providerProof = [
      {
        provider: 'agentmail',
        requiredForProduction: true,
        configured: true,
        status: 'blocked',
        dryRun: { status: 'configured', verified: true, fresh: true, dryRun: true },
        liveSmoke: { status: 'not_run', verified: false, fresh: false, live: false },
        cost: { costUsd24h: 0 },
        blockers: ['agentmail live smoke has not passed'],
        nextAction: 'run AgentMail live smoke for owner@example.com'
      },
      {
        provider: 'stripe',
        requiredForProduction: true,
        configured: true,
        status: 'live_ready',
        dryRun: { status: 'configured', verified: true, fresh: true, dryRun: true },
        liveSmoke: { status: 'ok', verified: true, fresh: true, live: true },
        cost: { costUsd24h: 0 },
        blockers: [],
        nextAction: 'monitor'
      }
    ];
    report.decisionReceipt = buildSafeToSellDecisionReceipt(report);
    assert.equal(report.decisionReceipt.decision, 'hold');
    assert.equal(report.decisionReceipt.proof.requiredProviders, 2);
    assert.equal(report.decisionReceipt.proof.requiredLiveReady, 1);
    assert.equal(report.decisionReceipt.proof.blockedProviders, 1);
    assert.equal(report.decisionReceipt.blockerCount, 1);
    const recorded = dbModule.safeToSellReports.record(report);
    assert(recorded.id, 'missing safe-to-sell report id');
    assert.equal(recorded.ok, false);
    assert.equal(recorded.blockerCount, 1);
    assert.equal(recorded.dryRunCount, 1);
    assert.equal(recorded.liveSmokeCount, 1);
    const latest = dbModule.safeToSellReports.latest();
    assert.equal(latest.id, recorded.id);
    const latestSerialized = JSON.stringify(latest.report);
    assert.equal(latest.report.decisionReceipt.snapshotId, recorded.id);
    assert.equal(latest.report.decisionReceipt.durable, true);
    assert.equal(latest.report.decisionReceipt.proof.requiredLiveReady, 1);
    assert.equal(latest.report.decisionReceipt.providerBlockers[0].provider, 'agentmail');
    assert(!latestSerialized.includes('owner@example.com'), 'durable safe-to-sell report leaked email');
    assert(!latestSerialized.includes('+14155550123'), 'durable safe-to-sell report leaked phone');
    assert(!latestSerialized.includes(dataDir), 'durable safe-to-sell report leaked local data dir path');
    assert(latestSerialized.includes('callan-backup-test-callmemaybe.db'), 'durable safe-to-sell report should preserve backup filename');
    assert.equal(latest.report.generatedAt, new Date(now).toISOString(), 'redaction should preserve generatedAt dates');
    const freshStatus = safeToSellSnapshotStatus(latest, { now });
    assert.equal(freshStatus.ok, true);
    assert.equal(freshStatus.snapshot.id, recorded.id);
    const staleStatus = safeToSellSnapshotStatus(latest, { now: now + 27 * 3600 * 1000 });
    assert.equal(staleStatus.ok, false);
    assert.equal(staleStatus.reason, 'safe-to-sell durable snapshot is stale');
    const versionStatus = safeToSellSnapshotStatus({ ...latest, report: { ...latest.report, version: SAFE_TO_SELL_REPORT_VERSION - 1 } }, { now });
    assert.equal(versionStatus.ok, false);
    assert.equal(versionStatus.reason, 'safe-to-sell durable snapshot policy version is stale');
    const missingStatus = safeToSellSnapshotStatus(null, { now });
    assert.equal(missingStatus.ok, false);
    assert.equal(missingStatus.reason, 'safe-to-sell durable snapshot is missing');
    const runtimeReport = await buildSafeToSellReport({
      now,
      evals: {
        ok: false,
        summary: { total: 1, passed: 0, failed: 1, skipped: 0 },
        cases: [{
          name: 'pii_redaction_runtime',
          category: 'privacy',
          ok: false,
          skipped: false,
          error: 'owner@example.com called from +14155550123'
        }]
      }
    });
    const runtimeSerialized = JSON.stringify(runtimeReport);
    assert(!runtimeSerialized.includes('owner@example.com'), 'safe-to-sell runtime report leaked email');
    assert(!runtimeSerialized.includes('+14155550123'), 'safe-to-sell runtime report leaked phone');
    assert(!runtimeSerialized.includes(dataDir), 'safe-to-sell runtime report leaked local data dir path');
    const observability = opsObservability({ now: Date.now(), windowMs: 60_000 });
    assert.equal(observability.safeToSellHistory.latest.id, recorded.id);
    assert.equal(observability.safeToSellHistory.blockedCount >= 1, true);
    const receiptHistory = compactSafeToSellReceiptHistory(observability.safeToSellHistory);
    assert.equal(receiptHistory.latest.id, recorded.id);
    assert.equal(receiptHistory.latest.snapshotId, recorded.id);
    assert.equal(receiptHistory.latest.decision, 'hold');
    assert.equal(receiptHistory.latest.requiredLiveReady, 1);
    assert.equal(receiptHistory.recent[0].blockedProviders, 1);
    const receiptHistorySerialized = JSON.stringify(receiptHistory);
    assert(!receiptHistorySerialized.includes('owner@example.com'), 'safe-to-sell receipt history leaked email');
    assert(!receiptHistorySerialized.includes('+14155550123'), 'safe-to-sell receipt history leaked phone');
    assert(!receiptHistorySerialized.includes(dataDir), 'safe-to-sell receipt history leaked local path');
    const exported = exportOperationsData({ includePII: false });
    assert(exported.tables.safeToSellReports.some((row) => row.id === recorded.id), 'export missing safe-to-sell history');
    assert(!JSON.stringify(exported).includes('owner@example.com'), 'redacted export leaked safe-to-sell report email');
    assert(!JSON.stringify(exported).includes('+14155550123'), 'redacted export leaked safe-to-sell report phone');
    assert(!JSON.stringify(exported).includes(dataDir), 'redacted export leaked local safe-to-sell path');
  });

  await check('provider_health_slo.blocks_safe_to_sell_on_error_rate_and_latency', async () => {
    const now = Date.now();
    const originalThresholds = {
      issueRate: env.ops.providerMaxIssueRatePct,
      minEvents: env.ops.providerMinEventsForIssueRate,
      latency: env.ops.providerMaxAvgLatencyMs
    };
    try {
      env.ops.providerMaxIssueRatePct = 25;
      env.ops.providerMinEventsForIssueRate = 3;
      env.ops.providerMaxAvgLatencyMs = 1_000;

      dbModule.providerSmoke.recordEvent('ops_slo_flaky', 'failed', {
        dryRun: false,
        live: true,
        error: 'first failure',
        durationMs: 100
      }, { checkedAt: now - 4_000, durationMs: 100, error: 'first failure' });
      dbModule.providerSmoke.recordEvent('ops_slo_flaky', 'failed', {
        dryRun: false,
        live: true,
        error: 'second failure',
        durationMs: 150
      }, { checkedAt: now - 3_000, durationMs: 150, error: 'second failure' });
      dbModule.providerSmoke.recordEvent('ops_slo_flaky', 'ok', {
        dryRun: false,
        live: true,
        durationMs: 100
      }, { checkedAt: now - 2_000, durationMs: 100 });
      dbModule.providerSmoke.set('ops_slo_flaky', 'ok', {
        dryRun: false,
        live: true,
        durationMs: 100
      }, { checkedAt: now - 1_000, durationMs: 100 });
      dbModule.providerSmoke.set('ops_slo_slow', 'ok', {
        dryRun: false,
        live: true,
        durationMs: 5_000
      }, { checkedAt: now - 500, durationMs: 5_000 });

      const observed = opsObservability({ now, windowMs: 60_000 });
      assert.equal(observed.providerHealthSlo.ok, false, JSON.stringify(observed.providerHealthSlo));
      assert(observed.providerHealthSlo.blockers.some((blocker) => blocker.includes('ops_slo_flaky issue rate')), observed.providerHealthSlo.blockers.join('\n'));
      assert(observed.providerHealthSlo.blockers.some((blocker) => blocker.includes('ops_slo_slow average latency')), observed.providerHealthSlo.blockers.join('\n'));

      const report = await buildSafeToSellReport({
        now,
        evals: {
          ok: true,
          summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
          cases: []
        }
      });
      assert(report.stillBlocked.some((blocker) => blocker.includes('provider health SLO blocked: ops_slo_flaky')), report.stillBlocked.join('\n'));
      assert(report.observability.providerHealthSlo.blockers.some((blocker) => blocker.includes('ops_slo_slow average latency')), report.observability.providerHealthSlo.blockers.join('\n'));
      assert(report.nextActions.some((action) => action.includes('fix provider health for') && action.includes('ops_slo_flaky') && action.includes('ops_slo_slow')), report.nextActions.join('\n'));
    } finally {
      env.ops.providerMaxIssueRatePct = originalThresholds.issueRate;
      env.ops.providerMinEventsForIssueRate = originalThresholds.minEvents;
      env.ops.providerMaxAvgLatencyMs = originalThresholds.latency;
    }
  });

  await check('safe_to_sell.provider_proof_matrix_joins_smoke_slo_webhook_and_cost', async () => {
    configureProductionReadyPosture(env);
    seedFreshWebhooks(dbModule.webhookEvents);
    resetProductionProviderSmoke(dbModule);
    const now = Date.now();
    const leadId = 'ops_provider_proof_lead';
    const lead = dbModule.leads.insert({
      id: leadId,
      container_tag: 'ops_provider_proof_lead',
      business_name: 'Ops Provider Proof Studio',
      phone: '+14155550188',
      address: '88 Ops Way',
      niche: 'salon',
      city: 'Oakland',
      website: 'https://example.test/provider-proof',
      source_url: 'https://example.test/provider-proof',
      status: 'qualified'
    }).lead;
    dbModule.leadCosts.record({
      id: 'cost_ops_provider_proof_browser',
      lead_id: lead.id,
      provider: 'browser_use',
      kind: 'browser_step',
      usd: 3.25,
      units: 12,
      unit_label: 'step',
      metadata: { sessionId: 'provider-proof-session', email: 'owner@example.com' }
    });
    for (const provider of productionSmokeProviders) {
      dbModule.providerSmoke.set(provider, 'ok', {
        dryRun: false,
        live: true,
        opsCheck: true,
        durationMs: 25
      }, { checkedAt: now - 1_000, durationMs: 25 });
    }
    dbModule.providerSmoke.set('gemini', 'failed', {
      dryRun: false,
      live: true,
      error: 'gemini.generateContent failed for owner@example.com with key AIzaSySecret987654: API key not valid',
      opsCheck: true
    }, {
      checkedAt: now,
      durationMs: 30,
      error: 'gemini.generateContent failed for owner@example.com with key AIzaSySecret987654: API key not valid'
    });

    const readiness = liveReadiness();
    const observability = opsObservability({ now: now + 1_000, windowMs: 60_000 });
    const matrix = buildProviderProofMatrix({ readiness, observability });
    const browserUse = matrix.find((row) => row.provider === 'browserUse');
    assert(browserUse, JSON.stringify(matrix));
    assert.equal(browserUse.liveSmoke.verified, true);
    assert.equal(browserUse.liveSmoke.fresh, true);
    assert.equal(browserUse.cost.costUsd24h, 3.25);
    assert.equal(browserUse.cost.events24h, 1);

    const agentmail = matrix.find((row) => row.provider === 'agentmail');
    assert.equal(agentmail.webhook.configured, true);
    assert.equal(agentmail.webhook.fresh, true);

    const gemini = matrix.find((row) => row.provider === 'gemini');
    assert.equal(gemini.status, 'blocked');
    assert.equal(gemini.liveSmoke.status, 'failed');
    assert.equal(gemini.liveSmoke.error, 'API key not valid');
    assert(gemini.blockers.some((blocker) => blocker.includes('API key not valid')), gemini.blockers.join('\n'));
    assert(!JSON.stringify(matrix).includes('owner@example.com'), 'provider proof matrix leaked email');
    assert(!JSON.stringify(matrix).includes('AIzaSySecret987654'), 'provider proof matrix leaked provider key');

    const report = await buildSafeToSellReport({
      now: now + 1_000,
      evals: {
        ok: true,
        summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
        cases: []
      }
    });
    assert(report.providerProof.some((row) => row.provider === 'browserUse' && row.cost.costUsd24h === 3.25), 'safe-to-sell report missing provider proof cost');
    assert(report.providerProof.some((row) => row.provider === 'gemini' && row.liveSmoke.error === 'API key not valid'), 'safe-to-sell report missing provider proof failure summary');

    const printLines = [];
    const originalLog = console.log;
    try {
      console.log = (...args) => printLines.push(args.join(' '));
      printSafeToSellReport(report);
    } finally {
      console.log = originalLog;
    }
    const printed = printLines.join('\n');
    assert(printed.includes('Provider proof:'), 'safe-to-sell CLI summary should include provider proof section');
    assert(printed.includes('- gemini: blocked;'), printed);
    assert(printed.includes('- browserUse: live_ready;'), printed);
    assert(printed.includes('cost=$3.25/24h'), printed);
    assert(!printed.includes('owner@example.com'), 'safe-to-sell CLI provider proof leaked email');
    assert(!printed.includes('AIzaSySecret987654'), 'safe-to-sell CLI provider proof leaked provider key');
  });

  await check('worker_health_slo.recovers_provider_caused_failures_after_live_smoke', async () => {
    const base = Date.now() + 120_000;
    const originalThresholds = {
      workerFailures: env.ops.workerMaxFailuresPer24h,
      workerRate: env.ops.workerMaxFailureRatePct,
      workerMinRuns: env.ops.workerMinRunsForFailureRate,
      jobIssues: env.ops.jobMaxIssuesPer24h
    };
    try {
      env.ops.workerMaxFailuresPer24h = 1;
      env.ops.workerMaxFailureRatePct = 50;
      env.ops.workerMinRunsForFailureRate = 3;
      env.ops.jobMaxIssuesPer24h = 99;

      dbModule.runs.start({ id: 'run_ops_worker_provider_recovery_1', lead_id: null, worker: 'analyst' });
      dbModule.runs.finish('run_ops_worker_provider_recovery_1', {
        state: 'failed',
        error: 'gemini.generateContent failed: API key not valid'
      });
      dbModule.db.prepare(`UPDATE worker_runs SET started_at = ?, finished_at = ? WHERE id = ?`)
        .run(base - 3_000, base - 2_000, 'run_ops_worker_provider_recovery_1');

      dbModule.runs.start({ id: 'run_ops_worker_provider_recovery_2', lead_id: null, worker: 'analyst' });
      dbModule.runs.finish('run_ops_worker_provider_recovery_2', {
        state: 'failed',
        error: 'gemini.generateStructuredText failed: gemini.generateContent failed: API key not valid'
      });
      dbModule.db.prepare(`UPDATE worker_runs SET started_at = ?, finished_at = ? WHERE id = ?`)
        .run(base - 2_000, base - 1_000, 'run_ops_worker_provider_recovery_2');

      dbModule.runs.start({ id: 'run_ops_worker_provider_recovery_ok', lead_id: null, worker: 'analyst' });
      dbModule.runs.finish('run_ops_worker_provider_recovery_ok', {
        state: 'completed',
        detail: { ok: true }
      });
      dbModule.db.prepare(`UPDATE worker_runs SET started_at = ?, finished_at = ? WHERE id = ?`)
        .run(base - 1_500, base - 500, 'run_ops_worker_provider_recovery_ok');

      let observed = opsObservability({ now: base, windowMs: 60_000 });
      let analyst = observed.workerHealthSlo.workers.find((row) => row.worker === 'analyst');
      assert(analyst, 'expected analyst worker SLO row before recovery');
      assert.equal(analyst.failureCount, 2);
      assert.equal(analyst.recoveredFailureCount, 0);
      assert.equal(analyst.effectiveFailureCount, 2);
      assert.equal(analyst.ok, false, JSON.stringify(analyst));
      assert(observed.workerHealthSlo.blockers.some((blocker) => blocker.includes('analyst 2 unrecovered failures')), observed.workerHealthSlo.blockers.join('\n'));

      const report = await buildSafeToSellReport({
        now: base,
        evals: {
          ok: true,
          summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
          cases: []
        }
      });
      assert(report.nextActions.some((action) => (
        action.includes('SMOKE_GEMINI=true npm run smoke:providers -- --provider gemini')
        && action.includes('latest analyst failure')
        && action.includes('2 unrecovered provider-caused worker failures')
      )), report.nextActions.join('\n'));

      dbModule.providerSmoke.set('gemini', 'ok', {
        dryRun: false,
        live: true,
        opsCheck: true
      }, { checkedAt: base + 1_000 });

      observed = opsObservability({ now: base + 2_000, windowMs: 60_000 });
      analyst = observed.workerHealthSlo.workers.find((row) => row.worker === 'analyst');
      assert(analyst, 'expected analyst worker SLO row after recovery');
      assert.equal(analyst.failureCount, 2);
      assert.equal(analyst.recoveredFailureCount, 2);
      assert.equal(analyst.effectiveFailureCount, 0);
      assert.equal(analyst.providerRecovery[0]?.provider, 'gemini');
      assert.equal(analyst.providerRecovery[0]?.recovered, true);
      assert.equal(analyst.ok, true, JSON.stringify(analyst));
      assert(!observed.workerHealthSlo.blockers.some((blocker) => blocker.includes('analyst')), observed.workerHealthSlo.blockers.join('\n'));
    } finally {
      env.ops.workerMaxFailuresPer24h = originalThresholds.workerFailures;
      env.ops.workerMaxFailureRatePct = originalThresholds.workerRate;
      env.ops.workerMinRunsForFailureRate = originalThresholds.workerMinRuns;
      env.ops.jobMaxIssuesPer24h = originalThresholds.jobIssues;
    }
  });

  await check('worker_health_slo.blocks_safe_to_sell_on_worker_and_job_failures', async () => {
    const now = Date.now();
    const originalThresholds = {
      workerFailures: env.ops.workerMaxFailuresPer24h,
      workerRate: env.ops.workerMaxFailureRatePct,
      workerMinRuns: env.ops.workerMinRunsForFailureRate,
      jobIssues: env.ops.jobMaxIssuesPer24h
    };
    try {
      env.ops.workerMaxFailuresPer24h = 1;
      env.ops.workerMaxFailureRatePct = 50;
      env.ops.workerMinRunsForFailureRate = 3;
      env.ops.jobMaxIssuesPer24h = 1;

      dbModule.runs.start({ id: 'run_ops_worker_slo_1', lead_id: null, worker: 'ops_slo_worker' });
      dbModule.runs.finish('run_ops_worker_slo_1', {
        state: 'failed',
        error: 'failed for owner@example.com at +14155550123',
        detail: { email: 'owner@example.com', phone: '+14155550123' }
      });
      dbModule.runs.start({ id: 'run_ops_worker_slo_2', lead_id: null, worker: 'ops_slo_worker' });
      dbModule.runs.finish('run_ops_worker_slo_2', {
        state: 'failed',
        error: 'second failure',
        detail: { reason: 'temporary outage' }
      });
      dbModule.runs.start({ id: 'run_ops_worker_slo_3', lead_id: null, worker: 'ops_slo_worker' });
      dbModule.runs.finish('run_ops_worker_slo_3', {
        state: 'completed',
        detail: { ok: true }
      });

      const failedJob = dbModule.durableJobs.enqueue({
        type: 'ops.worker_slo_job',
	        payload: { pii: 'owner@example.com +14155550123' },
	        idempotency_key: 'ops-check:worker-slo-job-1',
	        maxAttempts: 1,
	        runAt: now,
	        now
	      }).row;
      const claimedFailed = dbModule.durableJobs.claimNext({ workerId: 'ops-worker-slo', types: ['ops.worker_slo_job'], now });
      assert.equal(claimedFailed.id, failedJob.id);
      dbModule.durableJobs.fail(claimedFailed.id, { error: new Error('job failed for owner@example.com'), now });

      const retryJob = dbModule.durableJobs.enqueue({
        type: 'ops.worker_slo_job',
	        payload: { reason: 'retry budget' },
	        idempotency_key: 'ops-check:worker-slo-job-2',
	        maxAttempts: 2,
	        runAt: now,
	        now
	      }).row;
      const claimedRetry = dbModule.durableJobs.claimNext({ workerId: 'ops-worker-slo', types: ['ops.worker_slo_job'], now });
      assert.equal(claimedRetry.id, retryJob.id);
      dbModule.durableJobs.fail(claimedRetry.id, { error: new Error('job retry for +14155550123'), now });

      const observed = opsObservability({ now, windowMs: 60_000 });
      assert.equal(observed.workerHealthSlo.ok, false, JSON.stringify(observed.workerHealthSlo));
      assert(observed.workerHealthSlo.blockers.some((blocker) => blocker.includes('ops_slo_worker 2 unrecovered failures')), observed.workerHealthSlo.blockers.join('\n'));
      assert(observed.workerHealthSlo.blockers.some((blocker) => blocker.includes('ops_slo_worker unrecovered failure rate')), observed.workerHealthSlo.blockers.join('\n'));
      assert(observed.workerHealthSlo.blockers.some((blocker) => blocker.includes('ops.worker_slo_job 2 retry/failed jobs')), observed.workerHealthSlo.blockers.join('\n'));
      const recentSerialized = JSON.stringify(observed.recentFailures);
      assert(!recentSerialized.includes('owner@example.com'), 'ops observability worker failures leaked email');
      assert(!recentSerialized.includes('+14155550123'), 'ops observability worker failures leaked phone');

      const report = await buildSafeToSellReport({
        now,
        evals: {
          ok: true,
          summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
          cases: []
        }
      });
      assert(report.stillBlocked.some((blocker) => blocker.includes('worker health SLO blocked: ops_slo_worker')), report.stillBlocked.join('\n'));
      assert(report.stillBlocked.some((blocker) => blocker.includes('durable job health SLO blocked: ops.worker_slo_job')), report.stillBlocked.join('\n'));
      assert(report.nextActions.some((action) => action.includes('inspect recent worker failures for ops_slo_worker')), report.nextActions.join('\n'));
      assert(report.nextActions.some((action) => action.includes('drain or repair failing durable job types ops.worker_slo_job')), report.nextActions.join('\n'));
    } finally {
      env.ops.workerMaxFailuresPer24h = originalThresholds.workerFailures;
      env.ops.workerMaxFailureRatePct = originalThresholds.workerRate;
      env.ops.workerMinRunsForFailureRate = originalThresholds.workerMinRuns;
      env.ops.jobMaxIssuesPer24h = originalThresholds.jobIssues;
    }
  });

  await check('safe_to_sell_cli.fails_closed_without_report_only', async () => {
    const cliDir = mkdtempSync(join(tmpdir(), 'callan-safe-cli-'));
    try {
      let failedClosed = false;
      let stdout = '';
      try {
        execFileSync(process.execPath, [join(repoRoot, 'scripts/safe-to-sell.js'), '--no-record', '--no-maintenance'], {
          cwd: repoRoot,
          env: {
            ...process.env,
            DATA_DIR: cliDir,
            RUN_MODE: 'mock',
            NODE_ENV: 'test',
            LIVE_CALLS: 'false',
            LIVE_EMAILS: 'false',
            LIVE_PAYMENTS: 'false',
            LIVE_BROWSER_SESSIONS: 'false',
            LIVE_PUBLIC_OUTREACH: 'false',
            LIVE_BUILDS: 'false'
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (err) {
        failedClosed = true;
        stdout = String(err.stdout || '');
        assert.equal(err.status, 1, stdout);
      }
      assert.equal(failedClosed, true, 'safe-to-sell CLI should exit nonzero when unsafe without --report-only');
      assert(stdout.includes('safe: no'), 'safe-to-sell CLI failure output should still print the summary');
      assert(stdout.includes('decision receipt:'), 'safe-to-sell CLI failure output should include decision receipt summary');
      assert(stdout.includes('Provider proof:'), 'safe-to-sell CLI failure output should include provider proof');
      assert(stdout.includes('Still blocked:'), 'safe-to-sell CLI failure output should include blockers');
      assert(stdout.includes('Next actions:'), 'safe-to-sell CLI failure output should include next actions');

      const reportOnly = execFileSync(process.execPath, [
        join(repoRoot, 'scripts/safe-to-sell.js'),
        '--report-only',
        '--no-record',
        '--no-maintenance'
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: cliDir,
          RUN_MODE: 'mock',
          NODE_ENV: 'test',
          LIVE_CALLS: 'false',
          LIVE_EMAILS: 'false',
          LIVE_PAYMENTS: 'false',
          LIVE_BROWSER_SESSIONS: 'false',
          LIVE_PUBLIC_OUTREACH: 'false',
          LIVE_BUILDS: 'false'
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      assert(reportOnly.includes('safe: no'), 'safe-to-sell --report-only should print unsafe summary while exiting 0');
      assert(reportOnly.includes('decision receipt:'), 'safe-to-sell --report-only should include decision receipt');
      assert(reportOnly.includes('Provider proof:'), 'safe-to-sell --report-only should include provider proof');
    } finally {
      rmSync(cliDir, { recursive: true, force: true });
    }
  });

  await check('provider_smoke.cli_output_redacts_sensitive_details', async () => {
    const line = formatProviderSmokeResult({
      provider: 'agentmail',
      status: 'failed',
      detail: {
        dryRun: false,
        live: true,
        generatedAt: '2026-05-21T05:14:39.299Z',
        error: 'send failed for owner@example.com at +14155550123 with key AIzaSySecret987654',
        apiKey: 'sk_live_abcdef123456789'
      }
    });
    assert(!line.includes('owner@example.com'), 'provider smoke CLI leaked email');
    assert(!line.includes('+14155550123'), 'provider smoke CLI leaked phone');
    assert(!line.includes('AIzaSySecret987654'), 'provider smoke CLI leaked provider key');
    assert(!line.includes('sk_live_abcdef123456789'), 'provider smoke CLI leaked API key field');
    assert(line.includes('2026-05-21T05:14:39.299Z'), 'provider smoke CLI redaction damaged timestamp');
  });

  await check('provider_smoke.live_failure_sets_nonzero_exit_code', async () => {
    assert.equal(providerSmokeExitCode([
      { provider: 'gemini', status: 'failed', detail: { dryRun: false, live: true, error: 'API_KEY_INVALID' } }
    ]), 1);
    assert.equal(providerSmokeExitCode([
      { provider: 'gemini', status: 'configured', detail: { dryRun: true, live: false, skipped: 'toggle disabled' } }
    ]), 0);
  });

  await check('provider_smoke.cli_targets_one_provider', async () => {
    const smokeDir = mkdtempSync(join(tmpdir(), 'callan-provider-smoke-'));
    try {
      const output = execFileSync(process.execPath, [
        join(repoRoot, 'scripts/provider-smoke.js'),
        '--provider',
        'lovable'
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: smokeDir,
          DOTENV_CONFIG_PATH: '/dev/null',
          RUN_MODE: 'mock',
          NODE_ENV: 'test',
          BROWSER_USE_API_KEY: '',
          SMOKE_LOVABLE_NAVIGATION: 'false'
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      assert(output.includes('[MISSING] lovable'), output);
      assert(!/^\[[^\]]+\] gemini\b/m.test(output), output);
      assert(!/^\[[^\]]+\] browserUse\b/m.test(output), output);
    } finally {
      rmSync(smokeDir, { recursive: true, force: true });
    }
  });

  await check('economics.margin_rollup', async () => {
    dbModule.leads.insert({
      id: 'demo_ops_margin',
      container_tag: 'demo_ops_margin',
      business_name: 'Ops Margin Bakery',
      phone: '+14155550123',
      address: '1 Ops Way',
      niche: 'bakery',
      city: 'Oakland',
      website: 'https://example.test/ops-margin-site',
      source_url: 'https://example.test/ops-margin',
      status: 'paid'
    });
    dbModule.payments.insert({
      id: 'pay_ops_margin',
      lead_id: 'demo_ops_margin',
      amount_cents: 50000,
      status: 'paid',
      paid_at: Date.now(),
      customer_email: 'owner@example.com'
    });
    dbModule.leadCosts.record({
      id: 'cost_ops_margin',
      lead_id: 'demo_ops_margin',
      provider: 'browser_use',
      kind: 'browser_step',
      usd: 12.25,
      units: 20,
      unit_label: 'step',
      metadata: { sessionId: 'ops-check-session' }
    });
    const margin = marginForLead('demo_ops_margin');
    assert.equal(margin.revenueUsd, 500);
    assert.equal(Number(margin.costUsd.toFixed(2)), 12.25);
    assert.equal(Number(margin.marginUsd.toFixed(2)), 487.75);
    const originalThresholds = {
      maxCost: env.ops.economicsMaxDailyCostUsd,
      maxLoss: env.ops.economicsMaxDailyLossUsd,
      minMargin: env.ops.economicsMinMarginPct
    };
    try {
      env.ops.economicsMaxDailyCostUsd = 1;
      env.ops.economicsMaxDailyLossUsd = 1;
      env.ops.economicsMinMarginPct = 99;
      const observed = opsObservability({ now: Date.now(), windowMs: 60_000 });
      assert.equal(observed.economicsHealth.ok, false, JSON.stringify(observed.economicsHealth));
      assert(observed.economicsHealth.blockers.some((blocker) => blocker.includes('OPS_MAX_DAILY_COST_USD')), observed.economicsHealth.blockers.join('\n'));
      assert(observed.economicsHealth.blockers.some((blocker) => blocker.includes('OPS_MIN_MARGIN_PCT')), observed.economicsHealth.blockers.join('\n'));
      const report = await buildSafeToSellReport({
        now: Date.now(),
        evals: {
          ok: true,
          summary: { total: 6, passed: 6, failed: 0, skipped: 0 },
          cases: []
        }
      });
      assert(report.stillBlocked.some((blocker) => blocker.includes('OPS_MAX_DAILY_COST_USD')), report.stillBlocked.join('\n'));
    } finally {
      env.ops.economicsMaxDailyCostUsd = originalThresholds.maxCost;
      env.ops.economicsMaxDailyLossUsd = originalThresholds.maxLoss;
      env.ops.economicsMinMarginPct = originalThresholds.minMargin;
    }
  });

  await check('admin.backup_export_redaction_reset_smoke', async () => {
    const exported = exportOperationsData({ includePII: false });
    assert.equal(exported.version, 1);
    assert.equal(exported.includePII, false);
    assert.equal(exported.redaction.strategy, 'pii_secrets_and_local_paths');
    assert.equal(exported.persistence.kind, 'sqlite');
    assert.equal(exported.limits.rowsPerTable, 500);
    assert.equal(exported.counts.leads, exported.tables.leads.length);
    assert.equal(exported.counts.safeToSellReports, exported.tables.safeToSellReports.length);
    const serialized = JSON.stringify(exported);
    assert(!serialized.includes('owner@example.com'), 'redacted export leaked email');
    assert(!serialized.includes('+14155550123'), 'redacted export leaked phone');
    assert(!serialized.includes(dataDir), 'redacted export leaked local data dir path');
    assert(!JSON.stringify(redactPii({ email: 'owner@example.com', phone: '+14155550123' })).includes('owner@example.com'));
    assert.equal(redactPii({ generatedAt: '2026-05-21T05:14:39.299Z' }).generatedAt, '2026-05-21T05:14:39.299Z');
    assert.equal(redactPii({ key: 'calls', keyMode: 'secret_test', apiKey: 'abcdef123456' }).key, 'calls');
    assert.equal(redactPii({ key: 'calls', keyMode: 'secret_test', apiKey: 'abcdef123456' }).keyMode, 'secret_test');
    assert.notEqual(redactPii({ key: 'calls', keyMode: 'secret_test', apiKey: 'abcdef123456' }).apiKey, 'abcdef123456');
    const redactedPath = redactPii({
      path: `${dataDir}/backups/callan-backup-test-callmemaybe.db`,
      backupDir: `${dataDir}/backups`
    });
    assert(!JSON.stringify(redactedPath).includes(dataDir), 'redactPii leaked local filesystem path');
    assert(JSON.stringify(redactedPath).includes('callan-backup-test-callmemaybe.db'), 'redactPii should preserve backup filename');
    const backup = backupSqliteDataDir();
    assert.equal(backup.ok, true);
    assert(backup.files.some((file) => file.bytes > 0), 'backup did not copy sqlite files');
    env.nodeEnv = 'test';
    env.runMode = 'mock';
    dbModule.leads.insert({
      id: 'demo_ops_reset_apply',
      container_tag: 'demo_ops_reset_apply',
      business_name: 'Ops Reset Fixture',
      phone: '+14155550120',
      address: '20 Ops Way',
      niche: 'plumber',
      city: 'Oakland',
      website: 'https://example.test/ops-reset',
      source_url: 'https://example.test/ops-reset',
      status: 'discovered'
    });
    const resetDryRun = resetMockData({ confirm: 'RESET_MOCK_DATA', dryRun: true });
    assert.equal(resetDryRun.ok, true);
    assert.equal(resetDryRun.dryRun, true);
    assert.equal(resetDryRun.totalMatched >= 1, true);
    env.nodeEnv = 'production';
    const refused = resetMockData({ confirm: 'RESET_MOCK_DATA', dryRun: false });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'reset_mock_data_refuses_production');
    env.nodeEnv = 'test';
    const resetApplied = resetMockData({
      confirm: 'RESET_MOCK_DATA',
      dryRun: false,
      now: new Date('2026-05-21T00:00:00.000Z')
    });
	    assert.equal(resetApplied.ok, true);
	    assert.equal(resetApplied.dryRun, false);
	    assert.equal(resetApplied.backup.ok, true, 'mock reset should create a backup before deleting rows');
	    assert(resetApplied.archived.some((row) => row.table === 'leads' && row.count >= 1), JSON.stringify(resetApplied.archived));
	    assert.equal(dbModule.leads.get('demo_ops_reset_apply').status, 'reset_archived');
	    assert.equal(dbModule.leads.get('demo_ops_reset_apply').blocked_reason, 'reset_mock_data');
	  });

  await check('ops.recover_stale_calls_with_audit', async () => {
    dbModule.leads.insert({
      id: 'demo_ops_stale_call',
      container_tag: 'demo_ops_stale_call',
      business_name: 'Ops Stale Call',
      phone: '+14155550124',
      address: '2 Ops Way',
      niche: 'plumber',
      city: 'Oakland',
      website: 'https://example.test/ops-stale-call',
      source_url: 'https://example.test/ops-stale-call',
      status: 'called'
    });
    dbModule.calls.start({
      id: 'call_ops_stale',
      lead_id: 'demo_ops_stale_call',
      provider_call_id: 'provider_ops_stale',
      to_phone: '+14155550124',
      disclosure_text: 'This call is automated and recorded.',
      decision_reason: 'ops recovery check'
    });
    const staleStartedAt = Date.now() - 2 * 3600 * 1000;
    dbModule.db.prepare(`UPDATE calls SET started_at = ? WHERE id = ?`).run(staleStartedAt, 'call_ops_stale');
    const dryRun = recoverStuckOperations({ dryRun: true, maxCallAgeMs: 45 * 60 * 1000 });
    assert.equal(dryRun.calls.matched, 1);
    assert.equal(dbModule.calls.get('call_ops_stale').state, 'in_progress');
    const recovered = recoverStuckOperations({ dryRun: false, maxCallAgeMs: 45 * 60 * 1000 });
    assert.equal(recovered.calls.recovered, 1);
    const call = dbModule.calls.get('call_ops_stale');
    assert.equal(call.state, 'ended');
    assert.equal(call.outcome, 'failed:stale_recovered');
    const audit = dbModule.db.prepare(`
      SELECT * FROM audit_events
      WHERE event_type = 'call.recovered' AND entity_id = ?
    `).get('call_ops_stale');
    assert(audit, 'missing call recovery audit event');
  });

  await check('readiness.strict_mode_exits_nonzero_with_blockers', async () => {
    let failed = false;
    let output = '';
    try {
      execFileSync(process.execPath, [join(repoRoot, 'scripts/production-readiness-check.js'), '--strict'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATA_DIR: strictDir,
          RUN_MODE: 'production_live',
          NODE_ENV: 'production',
          CHECK_PRODUCTION_STRICT: 'true'
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      failed = true;
      output = `${err.stdout || ''}\n${err.stderr || ''}`;
    }
    assert.equal(failed, true, 'strict readiness should fail closed when blockers remain');
    assert(output.includes('PRODUCTION READINESS') || output.includes('productionBlockers'));
  });

  const payload = {
    ok: checks.every((item) => item.ok),
    name: 'ops-check',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    data: { dir: dataDir, strictDir },
    checks
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.ok ? 0 : 1;
} catch (err) {
  checks.push({
    name: 'ops-check.crashed',
    ok: false,
    error: err?.message || String(err),
    stack: err?.stack || null
  });
  console.log(JSON.stringify({
    ok: false,
    name: 'ops-check',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    data: { dir: dataDir, strictDir },
    checks
  }, null, 2));
  process.exitCode = 1;
} finally {
  try { dbHandle?.close?.(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(strictDir, { recursive: true, force: true });
}

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    checks.push({ name, ok: true, durationMs: Date.now() - started });
  } catch (err) {
    checks.push({ name, ok: false, durationMs: Date.now() - started, error: err?.message || String(err) });
    throw err;
  }
}

function configureEnv(dir) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATA_DIR: dir,
    RUN_MODE: 'mock',
    LIVE_CALLS: 'false',
    LIVE_EMAILS: 'false',
    LIVE_PAYMENTS: 'false',
    LIVE_BROWSER_SESSIONS: 'false',
    LIVE_PUBLIC_OUTREACH: 'false',
    LIVE_BUILDS: 'false',
    ADMIN_API_TOKEN: '',
    GEMINI_API_KEY: '',
    SUPERMEMORY_API_KEY: '',
    MOSS_PROJECT_ID: '',
    MOSS_PROJECT_KEY: '',
    AGENTPHONE_API_KEY: '',
    BROWSER_USE_API_KEY: '',
    LOVABLE_API_KEY: '',
    AGENTMAIL_API_KEY: '',
    AGENTMAIL_INBOX_ID: '',
    STRIPE_SECRET_KEY: '',
    SMOKE_GEMINI: 'false',
    SMOKE_SUPERMEMORY_WRITE: 'false',
    SMOKE_MOSS_INDEX: 'false',
    SMOKE_LIVE_CALL: 'false',
    SMOKE_AGENTMAIL_SEND: 'false',
    SMOKE_STRIPE_INVOICE: 'false',
    SMOKE_BROWSER_USE: 'false',
    SMOKE_LOVABLE_NAVIGATION: 'false',
    OPERATOR_TRANSFER_NUMBER: ''
  });
}

function configureProductionReadyPosture(env) {
  env.runMode = 'production_live';
  env.nodeEnv = 'production';
  env.publicUrl = 'https://callan.example.com';
  env.productionLiveAck = 'I_UNDERSTAND_LIVE_OUTREACH';
  env.admin.apiToken = 'ops-admin-token-0123456789';
  env.outreach.enabled = true;
  Object.assign(env.live, {
    calls: true,
    emails: true,
    payments: true,
    invoices: true,
    browserSessions: true,
    publicOutreach: true,
    builds: true
  });
  env.gemini.apiKey = 'ops_gemini_key';
  env.supermemory.apiKey = 'ops_supermemory_key';
  env.moss.projectId = 'ops_moss_project';
  env.moss.projectKey = 'ops_moss_key';
  env.agentphone.apiKey = 'ops_agentphone_key';
  env.agentphone.webhookSecret = 'ops_agentphone_secret';
  env.agentmail.apiKey = 'ops_agentmail_key';
  env.agentmail.inboxId = 'ops_inbox';
  env.agentmail.webhookSecret = 'ops_agentmail_secret';
  env.browserUse.apiKey = 'ops_browser_use_key';
  env.stripe.secretKey = 'rk_live_ops_check';
  env.stripe.webhookSecret = 'whsec_ops';
}

function seedFreshWebhooks(webhookEvents) {
  for (const provider of ['agentphone', 'agentmail', 'stripe']) {
    webhookEvents.record({
      provider,
      event_id: `ops-check-${provider}-${Date.now()}`,
      type: 'ops.check',
      payload: { metadata: { leadId: 'demo_ops_margin' } }
    });
  }
}

function resetProductionProviderSmoke(dbModule) {
  const placeholders = productionSmokeProviders.map(() => '?').join(', ');
  dbModule.db.prepare(`DELETE FROM provider_smoke WHERE provider IN (${placeholders})`).run(...productionSmokeProviders);
  dbModule.db.prepare(`DELETE FROM provider_health_events WHERE provider IN (${placeholders})`).run(...productionSmokeProviders);
}

async function waitForJob(durableJobs, id, statuses, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const wanted = new Set(statuses);
  while (Date.now() < deadline) {
    const row = hydrateJobRow(durableJobs.get(id));
    if (row && wanted.has(row.status)) return row;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  const row = hydrateJobRow(durableJobs.get(id));
  throw new Error(`job ${id} did not reach ${statuses.join('/')} before timeout; status=${row?.status || 'missing'}`);
}

function hydrateJobRow(row) {
  if (!row) return null;
  return {
    ...row,
    payload: safeJson(row.payload_json) || {},
    result: safeJson(row.result_json)
  };
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
