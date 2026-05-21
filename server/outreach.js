import {
  callabilityForLead,
  normalizePhone,
  PHONE_CLASSIFICATIONS,
  REASON_CODES,
  recordingDisclosure,
  recordCallDecision,
  recordOptOut
} from './compliance.js';
import { callAttempts, contactEvents, db, leads } from './db.js';
import { env } from './env.js';
import { emit } from './sse.js';
import { liveReadiness } from './readiness.js';
import { enqueueJob } from './jobs.js';
import { runCaller } from './workers/caller.js';
import { scoreOnlinePresence } from './presenceScorer.js';
import { applyPriorityToLead, refreshAllPriorityScores } from './leadPriority.js';
import { executeDueChannel, listDueCadenceLeads } from './cadence.js';

export const OUTREACH_LEAD_JOB_TYPE = 'outreach.lead';

export const OUTREACH_STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED_VISIBLE: 'blocked_visible'
});

const LEGACY_QUEUE_STATES = new Set(['retry']);
const QUEUE_STATES = new Set([OUTREACH_STATES.QUEUED, ...LEGACY_QUEUE_STATES]);
const RUNNING_STATES = new Set([OUTREACH_STATES.RUNNING, 'calling']);
const BLOCKED_STATES = new Set([OUTREACH_STATES.BLOCKED_VISIBLE, 'blocked']);
const CONTROL_EVENT_TYPES = ['autonomy_paused', 'autonomy_resumed'];
const DEMO_CONSENT_STATUSES = new Set(['operator_owned', 'operator_seeded', 'operator_approved']);

const cfg = {
  dailyQuota: envNumber('OUTREACH_DAILY_CALL_QUOTA', envNumber('DAILY_CALL_QUOTA', 25)),
  retryBaseMs: envNumber('OUTREACH_RETRY_BASE_MS', 5 * 60 * 1000),
  retryMaxMs: envNumber('OUTREACH_RETRY_MAX_MS', 60 * 60 * 1000),
  activeJobTimeoutMs: envNumber('OUTREACH_ACTIVE_JOB_TIMEOUT_MS', 30 * 60 * 1000)
};

let timer = null;
const activeJobs = new Map();
let processingBatch = false;

export function startOutreachLoop() {
  recoverActiveJobs();
  try {
    refreshAllPriorityScores();
  } catch (err) {
    emit('outreach.error', { worker: 'leadPriority', error: err?.message || String(err) });
  }
  if (timer) return outreachStatus();
  timer = setInterval(() => {
    processOutreachBatch().catch((err) => {
      emit('outreach.error', { worker: 'caller', error: err?.message || String(err) });
    });
  }, env.outreach.intervalMs);
  processOutreachBatch().catch(() => {});
  emit('outreach.started', { mode: env.runMode, intervalMs: env.outreach.intervalMs, paused: autonomyControlState().paused });
  return outreachStatus();
}

export function stopOutreachLoop({ reason = 'operator_stop' } = {}) {
  setAutonomyPaused(true, reason);
  if (timer) clearInterval(timer);
  timer = null;
  emit('outreach.stopped', { paused: true, reason });
  return outreachStatus();
}

export function pauseOutreachLoop({ reason = 'operator_pause' } = {}) {
  setAutonomyPaused(true, reason);
  if (timer) clearInterval(timer);
  timer = null;
  emit('outreach.paused', { reason });
  return outreachStatus();
}

export function resumeOutreachLoop({ reason = 'operator_resume' } = {}) {
  setAutonomyPaused(false, reason);
  if (!timer) startOutreachLoop();
  emit('outreach.resumed', { reason });
  return outreachStatus();
}

export function outreachStatus() {
  const control = autonomyControlState();
  const jobs = activeJobList();
  const concurrency = outreachConcurrency();
  return {
    running: !!timer && !control.paused,
    loopActive: !!timer,
    paused: control.paused,
    pauseReason: control.reason,
    activeJob: jobs[0] || null,
    activeJobs: jobs,
    agents: {
      concurrency,
      active: jobs.length,
      available: Math.max(0, concurrency - jobs.length),
      activeJobs: jobs
    },
    states: Object.values(OUTREACH_STATES),
    queue: outreachQueueSummary(),
    quota: dailyQuotaStatus(),
    retry: {
      baseMs: cfg.retryBaseMs,
      maxMs: cfg.retryMaxMs,
      maxAttemptsPerPhone: env.outreach.maxAttemptsPerPhone
    },
    recovery: {
      activeJobTimeoutMs: cfg.activeJobTimeoutMs,
      recoverableStates: [...RUNNING_STATES]
    },
    readiness: liveReadiness()
  };
}

export function outreachRouteSmoke() {
  return {
    ok: true,
    states: Object.values(OUTREACH_STATES),
    routes: [
      ['GET', '/api/outreach/status'],
      ['GET', '/api/outreach/routes'],
      ['POST', '/api/outreach/start'],
      ['POST', '/api/outreach/stop'],
      ['POST', '/api/outreach/pause'],
      ['POST', '/api/outreach/resume'],
      ['POST', '/api/leads/:id/approve-live-call'],
      ['POST', '/api/leads/:id/block'],
      ['POST', '/api/leads/:id/opt-out'],
      ['POST', '/api/leads/:id/force-retry'],
      ['GET', '/api/leads/:id/callability']
    ].map(([method, path]) => ({ method, path })),
    controls: ['approve_live_call', 'block_lead', 'opt_out_lead', 'force_retry', 'pause_autonomy', 'resume_autonomy', 'explain_callability']
  };
}

export function queueLeadForOutreach({ leadId, profile }) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  const presence = scoreOnlinePresence(profile || {});
  const scoredProfile = { ...profile, ...presence };
  const strength = presence.onlinePresenceStrength || profile?.onlinePresenceStrength || 'mixed';
  const sourceUrl = presence.sourceUrl || profile?.sourceUrl || profile?.yelpUrl || lead.source_url || null;
  const confidence = presence.onlinePresenceConfidence ?? profile?.presenceConfidence ?? profile?.onlinePresenceConfidence ?? lead.presence_confidence ?? null;
  const phone = normalizePhone(lead.phone || profile?.phone);

  if (strength === 'strong') {
    const blockedReason = presence.notWorthCallingReason || profile?.callRecommendation?.whyNotCall || profile?.notWorthCallingReason || 'Strong online presence';
    const blocked = markLeadBlockedVisible(lead, 'strong_online_presence', {
      research_status: 'not_qualified',
      consent_status: 'not_required',
      phone_classification: lead.phone_classification || classifyQueuedPhone({ lead, profile: scoredProfile }),
      next_action: 'do_not_call_strong_presence',
      source_url: sourceUrl,
      online_presence_strength: strength,
      presence_confidence: confidence,
      blocked_reason: blockedReason
    }, { onlinePresenceReasons: presence.onlinePresenceReasons });
    return { queued: false, reason: blockedReason, lead: blocked, presence };
  }

  if (env.runMode === 'demo_live' && !demoLiveOwnedOrSeeded({ lead, profile: scoredProfile, phone })) {
    const blocked = markLeadBlockedVisible(lead, 'demo_live_requires_owned_seeded_number', {
      research_status: 'not_qualified',
      consent_status: lead.consent_status || 'needs_operator_owned',
      phone_classification: classifyQueuedPhone({ lead, profile: scoredProfile }),
      next_action: 'seed_or_allow_owned_number',
      source_url: sourceUrl,
      online_presence_strength: strength,
      presence_confidence: confidence,
      blocked_reason: 'Demo live calls require an operator-owned or seeded allowed phone number.'
    });
    return { queued: false, reason: 'demo_live only calls owned/seeded allowed numbers', lead: blocked };
  }

  leads.update(leadId, {
    research_status: 'qualified',
    outreach_status: OUTREACH_STATES.QUEUED,
    risk_status: 'needs_callability_check',
    consent_status: consentForQueuedLead({ lead, profile: scoredProfile, phone }),
    phone_classification: classifyQueuedPhone({ lead, profile: scoredProfile }),
    next_action: 'call',
    source_url: sourceUrl,
    online_presence_strength: strength,
    presence_confidence: confidence,
    callable_reason: presence.callRecommendation?.whyCall || 'Online presence is not strong enough to block outreach.',
    blocked_reason: null
  });
  recordOutreachEvent(leadId, 'outreach_queued', 'weak or mixed online presence', {
    strength,
    sourceUrl,
    confidence,
    reasons: presence.onlinePresenceReasons
  });
  try { applyPriorityToLead(leadId); } catch (err) { emit('outreach.error', { worker: 'leadPriority', leadId, error: err?.message || String(err) }); }
  return { queued: true, reason: 'weak or mixed online presence', lead: leads.get(leadId), presence };
}

export function approveLeadForLiveCall(leadId, { reason = 'operator_approved' } = {}) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  const phone = normalizePhone(lead.phone);
  const demoAllowed = env.runMode !== 'demo_live' || (phone && env.allowedPhones.includes(phone));
  leads.update(leadId, {
    outreach_status: demoAllowed ? OUTREACH_STATES.QUEUED : OUTREACH_STATES.BLOCKED_VISIBLE,
    risk_status: demoAllowed ? 'operator_approved' : 'demo_live_requires_allowed_phone',
    consent_status: 'operator_approved',
    phone_classification: phone && env.allowedPhones.includes(phone)
      ? PHONE_CLASSIFICATIONS.OWNED
      : lead.phone_classification || PHONE_CLASSIFICATIONS.BUSINESS_LANDLINE,
    next_action: demoAllowed ? 'call' : 'add_phone_to_allowed_targets'
  });
  recordOutreachEvent(leadId, 'outreach_approved', reason, { phoneAllowed: !!(phone && env.allowedPhones.includes(phone)) });
  const updated = leads.get(leadId);
  emit('outreach.lead_approved', { leadId, businessName: lead.business_name, queued: demoAllowed });
  return { ok: true, lead: updated, explanation: explainLeadCallability(leadId) };
}

export function blockLeadForOutreach(leadId, { reason = 'operator_blocked' } = {}) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  const updated = markLeadBlockedVisible(lead, reason, { next_action: 'operator_blocked' });
  return { ok: true, lead: updated };
}

export function optOutLeadFromOutreach(leadId, { reason = 'operator_opt_out' } = {}) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  const phone = normalizePhone(lead.phone);
  if (phone) recordOptOut(phone);
  const updated = markLeadBlockedVisible(lead, 'opt-out', {
    consent_status: 'opted_out',
    phone_classification: phone ? lead.phone_classification || 'business' : 'invalid',
    next_action: 'do_not_call'
  }, { optOutRecorded: !!phone, reason });
  return { ok: true, lead: updated, phone, optOutRecorded: !!phone };
}

export function forceRetryLeadOutreach(leadId, { reason = 'operator_force_retry' } = {}) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  leads.update(leadId, {
    outreach_status: OUTREACH_STATES.QUEUED,
    risk_status: 'operator_forced_retry',
    next_action: 'call',
    last_contacted_at: null
  });
  recordOutreachEvent(leadId, 'outreach_force_retry', reason, { previousState: lead.outreach_status, previousRisk: lead.risk_status });
  const updated = leads.get(leadId);
  emit('outreach.force_retry', { leadId, businessName: lead.business_name, reason });
  return { ok: true, lead: updated, explanation: explainLeadCallability(leadId) };
}

export function explainLeadCallability(leadId, options = {}) {
  const lead = leads.get(leadId);
  if (!lead) {
    return {
      ok: false,
      callable: false,
      leadId,
      blockers: [{ name: 'lead_found', reason: 'lead not found' }],
      gates: [{ name: 'lead_found', ok: false, reason: 'lead not found' }]
    };
  }
  return explainCallabilityForLead(lead, options);
}

export function canRouteCallLead(leadId, options = {}) {
  const explanation = explainLeadCallability(leadId, {
    ...options,
    ignoreQueueState: true,
    ignoreRetryBackoff: true,
    ignorePause: true
  });
  return explanation.callable ? { ok: true, explanation } : { ok: false, explanation };
}

export function enqueueOutreachLeadJob({
  leadId,
  agentId = null,
  phoneClassification = null,
  source = 'outreach.loop',
  runAt = Date.now(),
  idempotencyKey = null,
  maxAttempts = 3
} = {}) {
  if (!leadId) throw new Error('enqueueOutreachLeadJob requires leadId');
  return enqueueJob({
    type: OUTREACH_LEAD_JOB_TYPE,
    payload: {
      leadId,
      agentId,
      phoneClassification,
      source
    },
    idempotencyKey: idempotencyKey || `${OUTREACH_LEAD_JOB_TYPE}:${leadId}:${source}:${runAt}`,
    runAt,
    maxAttempts
  });
}

export async function handleOutreachLeadJob(payload = {}) {
  const leadId = payload.leadId;
  if (!leadId) return { ok: false, skipped: true, reason: 'missing_leadId' };
  const lead = leads.get(leadId);
  if (!lead) return { ok: false, skipped: true, reason: 'lead_not_found', leadId };
  if (SKIP_OUTREACH_STATES.has(lead.outreach_status) || ['completed', 'called', 'paid'].includes(lead.outreach_status)) {
    return { ok: true, skipped: true, reason: `state:${lead.outreach_status}`, leadId };
  }
  const job = {
    agentId: payload.agentId || nextAgentId(),
    leadId,
    businessName: lead.business_name,
    startedAt: Date.now(),
    phoneClassification: payload.phoneClassification || lead.phone_classification || null,
    durable: true
  };
  const explanation = explainCallabilityForLead(lead, {
    ignoreQueueState: true,
    ignoreRetryBackoff: true,
    ignorePause: true
  });
  const result = await runLeadOutreach(lead, explanation, { job });
  return { ok: true, leadId, source: payload.source || 'durable_job', ...(result || {}) };
}

async function processOutreachBatch() {
  if (processingBatch) return;
  processingBatch = true;
  try {
    await processOutreachBatchOnce();
  } finally {
    processingBatch = false;
  }
}

async function processOutreachBatchOnce() {
  recoverActiveJobs();

  const control = autonomyControlState();
  if (control.paused) {
    emit('outreach.paused_blocked', { reason: control.reason });
    return;
  }

  const readiness = liveReadiness();
  if (env.runMode !== 'mock' && !readiness.ready) {
    emit('outreach.blocked', { blockers: readiness.blockers });
    return;
  }

  const quota = dailyQuotaStatus();
  if (!quota.ok) {
    emit('outreach.quota_blocked', { used: quota.used, limit: quota.limit, resetAt: quota.resetAt });
    return;
  }

  const slots = availableOutreachSlots({ quota });
  if (slots <= 0) return;

  const batch = listDueOutreachQueue({ limit: Math.max(slots * 4, slots, 10) });
  if (!batch.length) return;

  let started = 0;
  for (const lead of batch) {
    if (started >= slots) return;
    if (activeJobs.has(lead.id)) continue;
    const explanation = explainCallabilityForLead(lead);
    if (!explanation.callable) {
      handleUncallableQueuedLead(lead, explanation);
      continue;
    }
    const disclosureText = recordingDisclosure(lead.business_name);
    const check = callabilityForLead({ lead, disclosureText });
    if (!check.ok) {
      recordCallDecision({
        leadId: lead.id,
        phone: lead.phone,
        allowed: false,
        reason: check.reason,
        disclosureText
      });
      handleUncallableQueuedLead(lead, {
        ...explanation,
        blockers: [{ name: 'callability', reason: check.reason, terminal: true }],
        gates: [...(explanation.gates || []), { name: 'callability', ok: false, reason: check.reason, terminal: true }]
      });
      continue;
    }

    const now = Date.now();
    const claim = leads.claimOutreach(lead.id, {
      now,
      riskStatus: 'callable',
      phoneClassification: check.phoneClassification,
      nextAction: 'call_in_progress',
      actor: 'caller'
    });
    if (!claim.claimed || !claim.row) continue;

    const job = {
      agentId: nextAgentId(),
      leadId: claim.row.id,
      businessName: claim.row.business_name,
      startedAt: now,
      phoneClassification: check.phoneClassification
    };
    activeJobs.set(claim.row.id, job);
    recordOutreachEvent(claim.row.id, 'outreach_attempt', 'calling lead', {
      agentId: job.agentId,
      phoneClassification: check.phoneClassification,
      mode: env.runMode
    });
    emit('outreach.agent_claimed', { ...job, active: activeJobs.size, concurrency: outreachConcurrency() });
    try {
      const queued = enqueueOutreachLeadJob({
        leadId: claim.row.id,
        agentId: job.agentId,
        phoneClassification: check.phoneClassification,
        source: 'outreach.loop',
        runAt: now,
        idempotencyKey: `${OUTREACH_LEAD_JOB_TYPE}:${claim.row.id}:${now}`
      });
      emit('outreach.job_queued', {
        worker: 'caller',
        leadId: claim.row.id,
        jobId: queued.row?.id || null,
        jobStatus: queued.row?.status || null,
        duplicate: !queued.inserted
      });
    } catch (err) {
      activeJobs.delete(claim.row.id);
      leads.update(claim.row.id, {
        outreach_status: OUTREACH_STATES.QUEUED,
        risk_status: 'job_enqueue_failed',
        next_action: 'call'
      });
      emit('outreach.error', { worker: 'caller', leadId: claim.row.id, error: err?.message || String(err) });
      continue;
    }
    started += 1;
  }

  await drainDueCadence();
}

async function drainDueCadence() {
  let dueLeads = [];
  try {
    dueLeads = listDueCadenceLeads();
  } catch (err) {
    emit('cadence.drain_failed', { error: err?.message || String(err) });
    return;
  }
  if (!dueLeads.length) return;

  for (const lead of dueLeads) {
    if (activeJobs.size > 0 && lead.attempt_channel === 'call_retry') continue;
    const channel = lead.attempt_channel;
    if (!channel) {
      try {
        leads.update(lead.id, { next_attempt_at: null });
      } catch {
        // ignore — lead may have been archived/blocked concurrently
      }
      continue;
    }
    try {
      await executeDueChannel({ leadId: lead.id, channel });
    } catch (err) {
      emit('cadence.execute_failed', { leadId: lead.id, channel, error: err?.message || String(err) });
    }
  }
}

async function runLeadOutreach(lead, explanation, { check = null, job = null } = {}) {
  const disclosureText = recordingDisclosure(lead.business_name);
  check = check || callabilityForLead({ lead, disclosureText });
  if (!check.ok) {
    recordCallDecision({
      leadId: lead.id,
      phone: lead.phone,
      allowed: false,
      reason: check.reason,
      disclosureText
    });
    handleUncallableQueuedLead(lead, {
      ...explanation,
      blockers: [{ name: 'callability', reason: check.reason, terminal: true }],
      gates: [...(explanation.gates || []), { name: 'callability', ok: false, reason: check.reason, terminal: true }]
    });
    return { ok: false, blocked: true, reason: check.reason };
  }

  const now = Date.now();
  if (!activeJobs.has(lead.id)) {
    activeJobs.set(lead.id, job || {
      agentId: nextAgentId(),
      leadId: lead.id,
      businessName: lead.business_name,
      startedAt: now,
      phoneClassification: check.phoneClassification
    });
  }

  try {
    leads.update(lead.id, {
      outreach_status: OUTREACH_STATES.RUNNING,
      risk_status: 'callable',
      phone_classification: check.phoneClassification,
      last_contacted_at: now,
      next_action: 'call_in_progress'
    });
    contactEvents.add({
      lead_id: lead.id,
      type: 'call_queued',
      direction: 'outbound',
      channel: 'agentphone',
      body: check.reason,
      metadata: { agentId: activeJobs.get(lead.id)?.agentId || null, phoneClassification: check.phoneClassification, mode: env.runMode }
    });
    emit('outreach.running', { leadId: lead.id, businessName: lead.business_name, agentId: activeJobs.get(lead.id)?.agentId || null, active: activeJobs.size, concurrency: outreachConcurrency(), phoneClassification: check.phoneClassification });
    emit('outreach.calling', { leadId: lead.id, businessName: lead.business_name, agentId: activeJobs.get(lead.id)?.agentId || null, active: activeJobs.size, concurrency: outreachConcurrency(), phoneClassification: check.phoneClassification });

    const callResult = await runCaller({ leadId: lead.id, toPhone: check.phone });

    const latest = leads.get(lead.id);
    if (latest && (BLOCKED_STATES.has(latest.outreach_status) || latest.risk_status === 'opt-out')) {
      markLeadBlockedVisible(latest, latest.risk_status || 'blocked_after_call', { next_action: latest.next_action || 'blocked' });
      return { ok: true, outcome: 'blocked_after_call', callId: callResult?.callId || null };
    }
    leads.update(lead.id, { outreach_status: OUTREACH_STATES.COMPLETED, next_action: 'await_analysis' });
    recordOutreachEvent(lead.id, 'outreach_completed', 'caller completed', { mode: env.runMode });
    emit('outreach.completed', { leadId: lead.id, businessName: lead.business_name, agentId: activeJobs.get(lead.id)?.agentId || null });
    return { ok: true, outcome: 'completed', callId: callResult?.callId || null };
  } catch (err) {
    const latest = leads.get(lead.id) || lead;
    if (BLOCKED_STATES.has(latest.outreach_status) || latest.risk_status === 'opt-out') {
      markLeadBlockedVisible(latest, latest.risk_status || 'call_refused', {
        next_action: latest.next_action || 'blocked'
      }, { error: err?.message || String(err) });
      return { ok: false, outcome: 'blocked_after_error', error: err?.message || String(err) };
    }
    scheduleRetryOrFail(latest, err);
    return { ok: false, outcome: 'retry_or_failed', error: err?.message || String(err) };
  } finally {
    activeJobs.delete(lead.id);
    emit('outreach.agent_released', { leadId: lead.id, businessName: lead.business_name, active: activeJobs.size, concurrency: outreachConcurrency() });
    if (timer) {
      queueMicrotask(() => {
        processOutreachBatch().catch((err) => {
          emit('outreach.error', { worker: 'caller', error: err?.message || String(err) });
        });
      });
    }
  }
}

function handleUncallableQueuedLead(lead, explanation) {
  const blocker = explanation.blockers?.[0] || { name: 'unknown', reason: 'not callable' };
  if (isTemporaryBlocker(blocker)) {
    emit('outreach.deferred', { leadId: lead.id, businessName: lead.business_name, blocker });
    return;
  }
  if (isFailedBlocker(blocker)) {
    leads.update(lead.id, {
      outreach_status: OUTREACH_STATES.FAILED,
      risk_status: blocker.reason || blocker.name,
      next_action: 'operator_review_retry'
    });
    recordOutreachEvent(lead.id, 'outreach_failed', blocker.reason || blocker.name, { blocker });
    emit('outreach.failed', { leadId: lead.id, businessName: lead.business_name, reason: blocker.reason || blocker.name });
    return;
  }
  markLeadBlockedVisible(lead, blocker.reason || blocker.name, { next_action: 'operator_review' }, { blocker });
}

function scheduleRetryOrFail(lead, err) {
  const message = err?.message || String(err);
  const attempts = outreachAttemptCount(lead.id);
  const maxAttempts = Math.max(1, env.outreach.maxAttemptsPerPhone);
  if (attempts < maxAttempts) {
    const delayMs = retryDelayMs(attempts);
    const dueAt = Date.now() + delayMs;
    leads.update(lead.id, {
      outreach_status: OUTREACH_STATES.QUEUED,
      risk_status: 'provider_failed',
      next_action: `retry_after:${dueAt}`,
      last_contacted_at: Date.now()
    });
    recordOutreachEvent(lead.id, 'outreach_retry_scheduled', message, { attempts, maxAttempts, dueAt, delayMs });
    emit('outreach.retry_scheduled', { leadId: lead.id, businessName: lead.business_name, attempts, maxAttempts, dueAt, error: message });
    return;
  }

  leads.update(lead.id, {
    outreach_status: OUTREACH_STATES.FAILED,
    risk_status: 'provider_failed',
    next_action: 'operator_review_retry'
  });
  recordOutreachEvent(lead.id, 'outreach_failed', message, { attempts, maxAttempts });
  emit('outreach.error', { leadId: lead.id, businessName: lead.business_name, error: message });
}

function recoverActiveJobs() {
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM leads
    WHERE outreach_status IN ('running', 'calling')
    ORDER BY updated_at ASC
  `).all();

  for (const lead of rows) {
    const activeJob = activeJobs.get(lead.id);
    if (activeJob && now - activeJob.startedAt < cfg.activeJobTimeoutMs) continue;
    const touchedAt = lead.last_contacted_at || lead.updated_at || lead.created_at || 0;
    if (now - touchedAt < cfg.activeJobTimeoutMs) continue;

    const attempts = outreachAttemptCount(lead.id);
    const maxAttempts = Math.max(1, env.outreach.maxAttemptsPerPhone);
    if (attempts < maxAttempts) {
      const dueAt = now + retryDelayMs(attempts || 1);
      activeJobs.delete(lead.id);
      leads.update(lead.id, {
        outreach_status: OUTREACH_STATES.QUEUED,
        risk_status: 'recovered_active_job',
        next_action: `retry_after:${dueAt}`
      });
      recordOutreachEvent(lead.id, 'outreach_active_recovered', 'stale active job requeued', { attempts, maxAttempts, dueAt });
      emit('outreach.job_recovered', { leadId: lead.id, businessName: lead.business_name, status: 'queued', dueAt });
    } else {
      activeJobs.delete(lead.id);
      leads.update(lead.id, {
        outreach_status: OUTREACH_STATES.FAILED,
        risk_status: 'recovered_active_job',
        next_action: 'operator_review_retry'
      });
      recordOutreachEvent(lead.id, 'outreach_active_recovered', 'stale active job failed', { attempts, maxAttempts });
      emit('outreach.job_recovered', { leadId: lead.id, businessName: lead.business_name, status: 'failed' });
    }
  }
}

function outreachConcurrency() {
  return Math.max(1, Math.floor(Number(env.outreach.batchSize) || 1));
}

function activeJobList() {
  return [...activeJobs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

function availableOutreachSlots({ quota }) {
  const concurrency = outreachConcurrency();
  let slots = Math.max(0, concurrency - activeJobs.size);
  if (quota?.enforced) slots = Math.min(slots, Math.max(0, quota.remaining ?? 0));
  return slots;
}

function nextAgentId() {
  const used = new Set(activeJobs.values().map((job) => job.agentId));
  const concurrency = outreachConcurrency();
  for (let i = 1; i <= concurrency; i += 1) {
    const id = `caller-${i}`;
    if (!used.has(id)) return id;
  }
  return `caller-${activeJobs.size + 1}`;
}

function explainCallabilityForLead(lead, {
  explicitPhone,
  ignoreQueueState = false,
  ignoreRetryBackoff = false,
  ignorePause = false
} = {}) {
  const disclosureText = recordingDisclosure(lead.business_name);
  const readiness = liveReadiness();
  const control = autonomyControlState();
  const quota = dailyQuotaStatus();
  const retry = retryBackoffForLead(lead);
  const phone = normalizePhone(explicitPhone || lead.phone);
  const gates = [];

  gates.push({ name: 'lead_found', ok: true });
  if (!ignoreQueueState) {
    gates.push({
      name: 'queue_state',
      ok: QUEUE_STATES.has(lead.outreach_status),
      reason: QUEUE_STATES.has(lead.outreach_status) ? 'queued' : `state is ${lead.outreach_status}`,
      terminal: !QUEUE_STATES.has(lead.outreach_status)
    });
  }
  if (!ignorePause) {
    gates.push({ name: 'autonomy_paused', ok: !control.paused, reason: control.paused ? control.reason || 'paused' : 'not paused', temporary: true });
  }
  if (env.runMode !== 'mock') {
    gates.push({
      name: 'readiness',
      ok: readiness.ready,
      reason: readiness.ready ? 'ready' : readiness.blockers.join('; '),
      temporary: true
    });
  }
  gates.push({
    name: 'daily_quota',
    ok: quota.ok,
    reason: !quota.enforced ? 'not enforced in mock mode' : quota.ok ? `${quota.remaining} remaining` : `daily quota reached (${quota.used}/${quota.limit})`,
    temporary: true
  });
  if (!ignoreRetryBackoff) {
    gates.push({
      name: 'retry_backoff',
      ok: retry.due,
      reason: retry.due ? 'due now' : `retry after ${new Date(retry.dueAt).toISOString()}`,
      temporary: true,
      dueAt: retry.dueAt
    });
  }
  if (env.runMode === 'demo_live') {
    gates.push({
      name: 'demo_live_owned_or_seeded',
      ok: demoLiveOwnedOrSeeded({ lead, phone }),
      reason: 'demo_live only calls operator-owned/seeded numbers in ALLOWED_TARGET_PHONES',
      terminal: true
    });
  }

  const check = callabilityForLead({ lead, disclosureText, phone: explicitPhone || lead.phone });
  const callabilityGate = {
    ok: check.ok,
    reason: check.reason,
    reasonCode: check.reason,
    reasonCodes: check.reasonCodes || [check.reason].filter(Boolean),
    phone: check.phone || phone || null,
    phoneClassification: check.phoneClassification || lead.phone_classification || PHONE_CLASSIFICATIONS.UNKNOWN
  };
  gates.push({
    name: 'callability',
    ok: check.ok,
    reason: check.reason,
    temporary: isTemporaryComplianceReason(check.reason),
    terminal: !isTemporaryComplianceReason(check.reason)
  });

  const blockers = gates.filter((gate) => !gate.ok);
  return {
    ok: blockers.length === 0,
    callable: blockers.length === 0,
    decision: blockers.length === 0 ? 'callable' : 'blocked',
    callability: callabilityGate,
    leadId: lead.id,
    businessName: lead.business_name,
    mode: env.runMode,
    state: lead.outreach_status,
    phone,
    phoneClassification: check.phoneClassification || lead.phone_classification,
    nextAction: blockers.length ? actionForBlocker(blockers[0]) : 'call',
    blockers,
    gates,
    quota,
    retry
  };
}

function listDueOutreachQueue({ limit }) {
  const fetchLimit = Math.max(limit * 10, limit, 10);
  const rows = db.prepare(`
    SELECT * FROM leads
    WHERE outreach_status IN ('queued', 'retry')
    ORDER BY priority_score DESC NULLS LAST, created_at ASC
    LIMIT ?
  `).all(fetchLimit);
  return rows.filter((lead) => retryBackoffForLead(lead).due).slice(0, limit);
}

function outreachQueueSummary() {
  const rows = db.prepare(`SELECT outreach_status AS status, COUNT(*) AS n FROM leads GROUP BY outreach_status`).all();
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, row.n]));
  return {
    queued: (byStatus.queued || 0) + (byStatus.retry || 0),
    running: (byStatus.running || 0) + (byStatus.calling || 0),
    completed: (byStatus.completed || 0) + (byStatus.called || 0),
    failed: byStatus.failed || 0,
    blockedVisible: (byStatus.blocked_visible || 0) + (byStatus.blocked || 0),
    byStatus
  };
}

function dailyQuotaStatus() {
  const used = callAttempts.todayCount();
  const enforced = env.runMode !== 'mock';
  const limit = Math.max(0, cfg.dailyQuota);
  const remaining = enforced ? Math.max(0, limit - used) : null;
  const reset = new Date();
  reset.setHours(24, 0, 0, 0);
  return {
    enforced,
    limit,
    used,
    remaining,
    ok: !enforced || used < limit,
    resetAt: reset.getTime()
  };
}

function retryBackoffForLead(lead) {
  const dueAt = retryDueAt(lead);
  return {
    dueAt,
    due: !dueAt || dueAt <= Date.now()
  };
}

function retryDueAt(lead) {
  const text = String(lead.next_action || '');
  const match = text.match(/^retry_after:(\d+)$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function retryDelayMs(attempts) {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(cfg.retryMaxMs, cfg.retryBaseMs * (2 ** exponent));
}

function outreachAttemptCount(leadId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
    FROM contact_events
    WHERE lead_id = ?
      AND channel = 'outreach'
      AND type = 'outreach_attempt'
  `).get(leadId);
  const lead = leads.get(leadId);
  const phone = normalizePhone(lead?.phone);
  const phoneAttempts = phone ? callAttempts.countSince({ phone, since: 0 }) : 0;
  return Math.max(row?.n || 0, phoneAttempts);
}

function markLeadBlockedVisible(lead, reason, patch = {}, metadata = {}) {
  leads.update(lead.id, {
    outreach_status: OUTREACH_STATES.BLOCKED_VISIBLE,
    risk_status: reason,
    next_action: 'blocked',
    ...patch
  });
  recordOutreachEvent(lead.id, 'outreach_blocked_visible', reason, { ...patch, ...metadata });
  emit('outreach.lead_blocked', { leadId: lead.id, businessName: lead.business_name, reason, visible: true });
  return leads.get(lead.id);
}

function recordOutreachEvent(leadId, type, body, metadata = {}) {
  contactEvents.add({
    lead_id: leadId,
    type,
    direction: 'internal',
    channel: 'outreach',
    body,
    metadata
  });
}

function autonomyControlState() {
  const row = db.prepare(`
    SELECT type, body, metadata_json, created_at
    FROM contact_events
    WHERE channel = 'outreach'
      AND lead_id IS NULL
      AND type IN (${CONTROL_EVENT_TYPES.map(() => '?').join(', ')})
    ORDER BY created_at DESC
    LIMIT 1
  `).get(...CONTROL_EVENT_TYPES);
  if (!row) return { paused: false, reason: null, updatedAt: null };
  return {
    paused: row.type === 'autonomy_paused',
    reason: row.body || null,
    updatedAt: row.created_at,
    metadata: safeJson(row.metadata_json)
  };
}

function setAutonomyPaused(paused, reason) {
  const current = autonomyControlState();
  if (current.paused === paused) return { changed: false, paused, reason: current.reason };
  contactEvents.add({
    lead_id: null,
    type: paused ? 'autonomy_paused' : 'autonomy_resumed',
    direction: 'internal',
    channel: 'outreach',
    body: reason,
    metadata: { mode: env.runMode }
  });
  return { changed: true, paused, reason };
}

function classifyQueuedPhone({ lead, profile }) {
  const phone = normalizePhone(lead.phone || profile?.phone);
  if (phone && env.allowedPhones.includes(phone)) return PHONE_CLASSIFICATIONS.OWNED;
  if (lead.phone || profile?.phone) {
    return profile?.sourceUrl || profile?.yelpUrl || lead.address
      ? PHONE_CLASSIFICATIONS.BUSINESS_LANDLINE
      : PHONE_CLASSIFICATIONS.UNKNOWN;
  }
  return PHONE_CLASSIFICATIONS.INVALID;
}

function consentForQueuedLead({ lead, profile, phone }) {
  if (env.runMode === 'demo_live') return lead.consent_status && DEMO_CONSENT_STATUSES.has(lead.consent_status) ? lead.consent_status : 'operator_owned';
  if (DEMO_CONSENT_STATUSES.has(lead.consent_status)) return lead.consent_status;
  if (profile?.operatorOwned || profile?.seeded || (phone && env.allowedPhones.includes(phone))) return 'operator_seeded';
  return 'public_business';
}

function demoLiveOwnedOrSeeded({ lead, profile, phone }) {
  const p = phone || normalizePhone(lead.phone || profile?.phone);
  if (!p || !env.allowedPhones.includes(p)) return false;
  return (
    DEMO_CONSENT_STATUSES.has(lead.consent_status) ||
    lead.phone_classification === 'allowed' ||
    lead.phone_classification === PHONE_CLASSIFICATIONS.OWNED ||
    lead.risk_status === 'operator_approved' ||
    profile?.operatorOwned === true ||
    profile?.seeded === true ||
    profile?.ownedNumber === true
  );
}

function isTemporaryBlocker(blocker) {
  return blocker?.temporary || ['autonomy_paused', 'readiness', 'daily_quota', 'retry_backoff'].includes(blocker?.name);
}

function isFailedBlocker(blocker) {
  return /max attempts/i.test(blocker?.reason || '') ||
    [REASON_CODES.MAX_ATTEMPTS_PHONE, REASON_CODES.MAX_ATTEMPTS_BUSINESS].includes(blocker?.reason) ||
    blocker?.name === 'queue_state';
}

function isTemporaryComplianceReason(reason) {
  return reason === REASON_CODES.OUTSIDE_CALLING_HOURS || /outside configured calling hours/i.test(reason || '');
}

function actionForBlocker(blocker) {
  if (!blocker) return 'call';
  if (blocker.name === 'autonomy_paused') return 'resume_autonomy';
  if (blocker.name === 'daily_quota') return 'wait_for_quota_reset';
  if (blocker.name === 'retry_backoff') return 'wait_for_retry_backoff';
  if (blocker.name === 'readiness') return 'fix_live_readiness';
  if (/max attempts/i.test(blocker.reason || '') ||
    [REASON_CODES.MAX_ATTEMPTS_PHONE, REASON_CODES.MAX_ATTEMPTS_BUSINESS].includes(blocker.reason)) return 'operator_review_retry';
  return 'operator_review';
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
