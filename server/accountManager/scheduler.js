import { accountManagerPlans, accountTasks, builds, contactEvents, leads, payments } from '../db.js';
import { canEmail, env } from '../env.js';
import { emit } from '../sse.js';
import { log } from '../logger.js';
import { enqueueJob } from '../jobs.js';
import { callingWindowStatus } from '../compliance.js';
import {
  createMockAgentMailSendResult,
  replyAgentMailMessage,
  sendAgentMailMessage
} from '../providers/agentmail.js';
import { generateAccountManagerPlanForLead } from './planner.js';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
let loopTimer = null;

export const ACCOUNT_MANAGER_RUN_JOB_TYPE = 'account_manager.run';
export const ACCOUNT_MANAGER_TASK_JOB_TYPE = 'account_manager.task';

export async function runAccountManagerScheduler({
  leadId = null,
  taskId = null,
  dryRun = env.accountManager.dryRun,
  forcePlan = false,
  now = Date.now(),
  limit = 25,
  operatorSend = false,
  source = 'scheduler'
} = {}) {
  if (leadId) {
    await generateAccountManagerPlanForLead({ leadId, force: forcePlan, source, now });
  } else if (!taskId) {
    await ensureDeliveredLeadTasks({ now, limit: 25, source });
  }

  const tasks = taskId
    ? [accountTasks.get(taskId)].filter(Boolean)
    : accountTasks.listDue({ now, lead_id: leadId || undefined, limit });
  const results = [];
  for (const task of tasks) {
    results.push(await processAccountTask({ task, dryRun, now, operatorSend, source }));
  }
  emit('account_manager.scheduler.ran', {
    worker: 'account_manager',
    dryRun,
    leadId,
    taskId,
    processed: results.length,
    liveSent: results.filter((row) => row.status === 'sent').length,
    previews: results.filter((row) => row.status === 'previewed' || row.status === 'blocked').length
  });
  return {
    ok: true,
    dryRun,
    processed: results.length,
    results
  };
}

export function enqueueAccountManagerRun({
  leadId = null,
  taskId = null,
  dryRun = env.accountManager.dryRun,
  forcePlan = false,
  operatorSend = false,
  source = 'api',
  reason = 'manual',
  now = Date.now(),
  runAt = now,
  intervalMs = MINUTE_MS,
  maxAttempts = 2,
  idempotencyKey = null
} = {}) {
  const bucketMs = Math.max(MINUTE_MS, Number(intervalMs) || MINUTE_MS);
  const bucket = Math.floor(now / bucketMs);
  const key = idempotencyKey || [
    ACCOUNT_MANAGER_RUN_JOB_TYPE,
    leadId || 'all',
    taskId || 'due',
    dryRun ? 'dry' : 'live',
    forcePlan ? 'force' : 'normal',
    operatorSend ? 'operator' : 'auto',
    bucket
  ].join(':');
  return enqueueJob({
    type: ACCOUNT_MANAGER_RUN_JOB_TYPE,
    payload: {
      leadId,
      taskId,
      dryRun,
      forcePlan,
      operatorSend,
      source,
      reason,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: key,
    runAt,
    maxAttempts
  });
}

export function enqueueAccountManagerTask({
  taskId,
  dryRun = true,
  operatorSend = true,
  source = 'operator_send',
  reason = 'manual',
  now = Date.now(),
  runAt = now,
  intervalMs = MINUTE_MS,
  maxAttempts = 2,
  idempotencyKey = null
} = {}) {
  if (!taskId) throw new Error('taskId is required');
  const bucketMs = Math.max(MINUTE_MS, Number(intervalMs) || MINUTE_MS);
  const bucket = Math.floor(now / bucketMs);
  const key = idempotencyKey || [
    ACCOUNT_MANAGER_TASK_JOB_TYPE,
    taskId,
    dryRun ? 'preview' : 'send',
    operatorSend ? 'operator' : 'auto',
    bucket
  ].join(':');
  return enqueueJob({
    type: ACCOUNT_MANAGER_TASK_JOB_TYPE,
    payload: {
      taskId,
      dryRun,
      operatorSend,
      source,
      reason,
      enqueuedAt: new Date(now).toISOString()
    },
    idempotencyKey: key,
    runAt,
    maxAttempts
  });
}

export async function handleAccountManagerRunJob(payload = {}) {
  return runAccountManagerScheduler({
    leadId: payload.leadId || payload.lead_id || null,
    taskId: payload.taskId || payload.task_id || null,
    dryRun: payload.dryRun !== false,
    forcePlan: payload.forcePlan === true,
    operatorSend: payload.operatorSend === true,
    source: payload.source || 'durable_job'
  });
}

export async function handleAccountManagerTaskJob(payload = {}) {
  const taskId = payload.taskId || payload.task_id;
  if (!taskId) throw new Error('taskId is required');
  return runAccountManagerScheduler({
    taskId,
    dryRun: payload.dryRun !== false,
    operatorSend: payload.operatorSend !== false,
    source: payload.source || 'durable_task_job'
  });
}

export async function processAccountTask({ task, dryRun = true, now = Date.now(), operatorSend = false, source = 'scheduler' } = {}) {
  if (!task) return { ok: false, status: 'missing', reason: 'task_not_found' };
  const lead = leads.get(task.lead_id);
  if (!lead) return { ok: false, taskId: task.id, status: 'missing', reason: 'lead_not_found' };
  const planRow = task.account_plan_id ? accountManagerPlans.get(task.account_plan_id) : accountManagerPlans.getLatest(lead.id);
  const evidence = planRow?.evidence || planRow?.plan?.evidence || [];
  const preview = buildAftercarePreview({ lead, task, evidence, now });
  const policy = evaluateSendPolicy({ lead, task, dryRun, now, operatorSend, preview });
  const payload = { ...preview, policy, blocked: policy.blocked, dryRun };

  if (policy.permanentBlock) {
    const row = accountTasks.update(task.id, {
      status: 'blocked',
      preview: payload,
      policy,
      last_previewed_at: now
    }, {
      actor: 'account_manager',
      action: 'blocked',
      note: policy.blockers.map((b) => b.reason).join(' '),
      metadata: { source }
    });
    emit('account_manager.task_blocked', eventPayload({ lead, task: row || task, preview: payload, policy }));
    return { ok: false, status: 'blocked', task: row, preview: payload, policy };
  }

  if (dryRun || policy.blocked || task.channel !== 'agentmail') {
    const row = accountTasks.markPreviewed(task.id, {
      preview: payload,
      policy,
      note: dryRun ? 'Dry-run preview generated.' : policy.blockers.map((b) => b.reason).join(' ')
    });
    emit('account_manager.task_previewed', eventPayload({ lead, task: row || task, preview: payload, policy }));
    return {
      ok: !policy.blocked,
      status: policy.blocked ? 'blocked' : 'previewed',
      task: row,
      preview: payload,
      policy
    };
  }

  try {
    const sendResult = await sendAftercareAgentMail({ lead, task, preview });
    const contactId = contactEvents.add({
      lead_id: lead.id,
      type: 'account_manager_checkin',
      direction: 'outbound',
      channel: 'agentmail',
      provider_id: sendResult.providerId || sendResult.messageId || null,
      thread_id: sendResult.threadId || latestAgentMailMessage(lead.id)?.thread_id || lead.agentmail_thread_id || null,
      subject: preview.subject,
      body: preview.body,
      metadata: {
        accountTaskId: task.id,
        accountPlanId: task.account_plan_id,
        evidenceIds: task.evidenceIds || [],
        mock: !!sendResult.mock,
        allowed: true,
        decisionCode: 'account_manager.aftercare_send',
        decisionReason: policy.reason,
        policy
      }
    });
    const row = accountTasks.markSent(task.id, {
      provider_id: sendResult.providerId || sendResult.messageId || null,
      thread_id: sendResult.threadId || null,
      preview: { ...payload, contactEventId: contactId },
      policy
    });
    emit('account_manager.task_sent', eventPayload({ lead, task: row || task, preview: payload, policy, sendResult }));
    return { ok: true, status: 'sent', task: row, preview: payload, policy, sendResult, contactId };
  } catch (err) {
    const row = accountTasks.markPreviewed(task.id, {
      preview: { ...payload, sendError: err?.message || String(err) },
      policy: { ...policy, blocked: true, blockers: [...policy.blockers, { code: 'send_failed', reason: err?.message || String(err), permanent: false }] },
      note: `Live send failed: ${err?.message || String(err)}`
    });
    log.warn('account_manager.send_failed', { taskId: task.id, leadId: lead.id, error: err?.message || String(err) });
    emit('account_manager.task_send_failed', eventPayload({ lead, task: row || task, preview: payload, policy, error: err?.message || String(err) }));
    return { ok: false, status: 'send_failed', task: row, preview: payload, policy, error: err?.message || String(err) };
  }
}

export function buildAftercarePreview({ lead, task, evidence = [], now = Date.now() } = {}) {
  const evidenceMap = new Map((evidence || []).map((item) => [item.id, item]));
  const cited = (task.evidenceIds || []).map((id) => evidenceMap.get(id)).filter(Boolean).slice(0, 2);
  const citeLine = cited.length
    ? `I have this noted on my side: ${cited.map((item) => item.summary).join(' ')}`
    : `I have ${task.title.toLowerCase()} queued for your account.`;
  const subject = subjectForTask(lead, task);
  const body = bodyForTask({ lead, task, citeLine, now });
  return {
    subject,
    body,
    evidence: cited,
    whyNow: task.summary || task.title,
    taskKind: task.kind,
    dueAt: task.due_at,
    generatedAt: now,
    accountManagerTone: true
  };
}

export function evaluateSendPolicy({ lead, task, dryRun = true, now = Date.now(), operatorSend = false, preview = null } = {}) {
  const blockers = [];
  const recipient = resolveRecipient(lead);
  const optOut = optOutStatus(lead);
  if (optOut.blocked) blockers.push({ code: optOut.reason, reason: 'Customer opted out of proactive contact.', permanent: true });
  const unsupported = unsupportedStatus(lead);
  if (unsupported.blocked) blockers.push({ code: unsupported.reason, reason: 'Unsupported or handoff state requires operator review first.', permanent: true });
  const lastSentAt = lastProactiveSentAt(lead.id);
  const capMs = Math.max(1, env.accountManager.frequencyCapHours) * HOUR_MS;
  if (lastSentAt && now - lastSentAt < capMs) {
    blockers.push({
      code: 'frequency_cap',
      reason: `Last proactive account-manager send was ${Math.round((now - lastSentAt) / HOUR_MS)}h ago; cap is ${env.accountManager.frequencyCapHours}h.`,
      permanent: false,
      lastSentAt
    });
  }
  const previewCapMs = Math.max(1, env.accountManager.previewCapHours) * HOUR_MS;
  if (task.last_previewed_at && now - task.last_previewed_at < previewCapMs && !operatorSend) {
    blockers.push({
      code: 'preview_frequency_cap',
      reason: `A dry-run preview was already generated less than ${env.accountManager.previewCapHours}h ago.`,
      permanent: false,
      lastPreviewedAt: task.last_previewed_at
    });
  }
  const quietMode = dryRun ? env.runMode : (env.runMode === 'mock' ? 'production_live' : env.runMode);
  const windowStatus = callingWindowStatus(new Date(now), { mode: quietMode, timezone: env.accountManager.timezone });
  if (!windowStatus.allowed && !dryRun) {
    blockers.push({
      code: 'quiet_window',
      reason: `Quiet window is active in ${env.accountManager.timezone}.`,
      permanent: false,
      quietHoursStart: windowStatus.quietHoursStart,
      quietHoursEnd: windowStatus.quietHoursEnd
    });
  }
  if (!recipient) blockers.push({ code: 'missing_recipient', reason: 'No customer email is known for AgentMail.', permanent: false });
  if (!dryRun && !env.live.emails) blockers.push({ code: 'live_emails_disabled', reason: 'LIVE_EMAILS is not enabled.', permanent: false });
  if (!dryRun && (!env.agentmail.apiKey || !env.agentmail.inboxId)) blockers.push({ code: 'agentmail_unconfigured', reason: 'AgentMail credentials are missing.', permanent: false });
  if (!dryRun && recipient && !canEmail(recipient)) blockers.push({ code: 'recipient_not_allowed', reason: 'Recipient is not allowed by current run mode/email allow-list.', permanent: false });
  if (!dryRun && task.status !== 'approved' && !operatorSend) blockers.push({ code: 'operator_approval_required', reason: 'Task must be approved before live proactive send.', permanent: false });
  if (task.status === 'paused') blockers.push({ code: 'task_paused', reason: 'Task is paused by the operator.', permanent: false });
  if (['sent', 'completed', 'canceled', 'blocked'].includes(task.status)) blockers.push({ code: `task_${task.status}`, reason: `Task is already ${task.status}.`, permanent: task.status === 'blocked' });

  return {
    dryRun,
    blocked: blockers.length > 0,
    permanentBlock: blockers.some((b) => b.permanent),
    blockers,
    recipientMasked: maskEmail(recipient),
    channel: task.channel,
    reason: blockers.length ? blockers.map((b) => b.code).join(',') : `Allowed ${dryRun ? 'dry-run preview' : 'live AgentMail send'} for ${task.kind}.`,
    liveCapable: !dryRun && blockers.length === 0 && task.channel === 'agentmail',
    previewSubject: preview?.subject || null
  };
}

export function approveAccountTask(taskId, { note } = {}) {
  return accountTasks.approve(taskId, { note: note || 'Operator approved aftercare send.' });
}

export function pauseAccountTask(taskId, { note, pausedUntil } = {}) {
  return accountTasks.pause(taskId, { note: note || 'Operator paused aftercare task.', pausedUntil: pausedUntil || null });
}

export function completeAccountTask(taskId, { note } = {}) {
  return accountTasks.complete(taskId, { note: note || 'Aftercare task completed.' });
}

export function reassignAccountTask(taskId, { owner, note } = {}) {
  return accountTasks.reassign(taskId, { owner: owner || 'operator', note });
}

export function startAccountManagerLoop() {
  if (loopTimer) return { running: true, alreadyRunning: true };
  if (!env.accountManager.enabled) return { running: false, reason: 'ACCOUNT_MANAGER_ENABLED is false' };
  const enqueue = (reason) => {
    const result = enqueueAccountManagerRun({
      dryRun: env.accountManager.dryRun,
      source: 'loop',
      reason,
      intervalMs: env.accountManager.intervalMs
    });
    log.info('account_manager.loop_job_enqueued', {
      jobId: result.row?.id,
      status: result.row?.status,
      inserted: result.inserted,
      reason
    });
    return result;
  };
  const first = enqueue('boot');
  loopTimer = setInterval(() => {
    try {
      enqueue('interval');
    } catch (err) {
      log.warn('account_manager.loop_error', { error: err?.message || String(err) });
      emit('account_manager.loop_error', { worker: 'account_manager', error: err?.message || String(err) });
    }
  }, env.accountManager.intervalMs);
  loopTimer.unref?.();
  emit('account_manager.loop_started', {
    worker: 'account_manager',
    intervalMs: env.accountManager.intervalMs,
    dryRun: env.accountManager.dryRun,
    durableJobId: first.row?.id || null
  });
  return {
    running: true,
    dryRun: env.accountManager.dryRun,
    intervalMs: env.accountManager.intervalMs,
    firstJobId: first.row?.id || null,
    firstInserted: first.inserted
  };
}

export function stopAccountManagerLoop() {
  if (!loopTimer) return { running: false };
  clearInterval(loopTimer);
  loopTimer = null;
  emit('account_manager.loop_stopped', { worker: 'account_manager' });
  return { running: false, stopped: true };
}

async function ensureDeliveredLeadTasks({ now, limit = 25, source = 'scheduler' } = {}) {
  const delivered = leads.list({ limit: 500 })
    .filter((lead) => isAftercareEligibleLead(lead))
    .slice(0, limit);
  for (const lead of delivered) {
    const existing = accountManagerPlans.getLatest(lead.id);
    if (!existing || now - existing.updated_at > 24 * HOUR_MS) {
      await generateAccountManagerPlanForLead({ leadId: lead.id, source, now });
    }
  }
}

function isAftercareEligibleLead(lead) {
  if (!lead) return false;
  if (['shipped', 'launch_approved'].includes(lead.status)) return true;
  const latestBuild = builds.listByLead(lead.id)[0] || null;
  return Boolean(
    latestBuild?.launched_at ||
    latestBuild?.customer_approved_at ||
    ['launched', 'customer_approved'].includes(latestBuild?.launch_status)
  );
}

async function sendAftercareAgentMail({ lead, task, preview }) {
  const recipient = resolveRecipient(lead);
  const latest = latestAgentMailMessage(lead.id);
  if (!env.live.emails || !env.agentmail.apiKey || !env.agentmail.inboxId || !canEmail(recipient)) {
    return createMockAgentMailSendResult({
      threadId: latest?.thread_id || lead.agentmail_thread_id || `mock-aftercare-thread-${lead.id}`,
      messageId: `mock-aftercare-${task.id}`,
      subject: preview.subject
    });
  }
  if (latest?.provider_id) {
    return replyAgentMailMessage({
      inboxId: env.agentmail.inboxId,
      messageId: latest.provider_id,
      toEmail: recipient,
      subject: preview.subject,
      text: preview.body,
      html: htmlParagraphs(preview.body),
      labels: ['account_manager_aftercare'],
      leadId: lead.id,
      costKind: 'account_manager_aftercare'
    }, { timeoutSeconds: 15, maxRetries: 2 });
  }
  return sendAgentMailMessage({
    inboxId: env.agentmail.inboxId,
    toEmail: recipient,
    subject: preview.subject,
    text: preview.body,
    html: htmlParagraphs(preview.body),
    labels: ['account_manager_aftercare'],
    leadId: lead.id,
    costKind: 'account_manager_aftercare'
  }, { timeoutSeconds: 15, maxRetries: 2 });
}

function subjectForTask(lead, task) {
  const name = lead.business_name || 'your site';
  if (task.kind === 'launch_followup') return `Quick check on ${name}`;
  if (task.kind === 'review_capture') return `Small favor after launch`;
  if (task.kind === 'seasonal_hours') return `Do your hours change soon?`;
  if (task.kind === 'stale_business_fact') return `Quick fact check for ${name}`;
  if (task.kind === 'hosting_subscription_status') return `Keeping ${name} online`;
  return `Following up on ${name}`;
}

function bodyForTask({ lead, task, citeLine }) {
  const name = lead.business_name || 'there';
  const opener = `Hi ${name},`;
  const closing = 'Callan';
  const optOut = 'If you do not want these project check-ins, reply unsubscribe and I will stop.';
  if (task.kind === 'stale_business_fact') {
    return [
      opener,
      '',
      citeLine,
      '',
      'Before I make any more updates, can you confirm the current phone and regular hours? I do not want to keep old business info on the site or profile.',
      '',
      optOut,
      '',
      closing
    ].join('\n');
  }
  if (task.kind === 'launch_followup') {
    return [
      opener,
      '',
      citeLine,
      '',
      'I am doing the 24-hour launch check: links, phone taps, contact flow, and anything that felt off after seeing it live. If one thing needs attention, reply with it and I will track it here.',
      '',
      optOut,
      '',
      closing
    ].join('\n');
  }
  if (task.kind === 'review_capture') {
    return [
      opener,
      '',
      citeLine,
      '',
      'If the launch felt good, would you be open to leaving a short review or sending me a one-sentence testimonial? No pressure. I am just collecting proof while the work is fresh.',
      '',
      optOut,
      '',
      closing
    ].join('\n');
  }
  if (task.kind === 'seasonal_hours') {
    return [
      opener,
      '',
      citeLine,
      '',
      'Do your hours change for the upcoming season or holiday window? If yes, send the dates and hours and I will keep the site/profile notes from going stale.',
      '',
      optOut,
      '',
      closing
    ].join('\n');
  }
  if (task.kind === 'hosting_subscription_status') {
    return [
      opener,
      '',
      citeLine,
      '',
      'I am checking the care side now: hosting, SSL/domain status, and whether you want ongoing edits covered. If you already have this handled somewhere else, just say so and I will mark it.',
      '',
      optOut,
      '',
      closing
    ].join('\n');
  }
  return [
    opener,
    '',
    citeLine,
    '',
    task.action || 'I am checking this so you do not have to re-explain it later.',
    '',
    optOut,
    '',
    closing
  ].join('\n');
}

function resolveRecipient(lead) {
  const paymentRows = payments.listByLead(lead.id);
  const paymentEmail = paymentRows.find((row) => row.customer_email)?.customer_email;
  if (paymentEmail) return paymentEmail;
  const inbound = contactEvents.listByLead(lead.id, { limit: 50 }).find((event) => event.channel === 'agentmail' && event.direction === 'inbound');
  const meta = safeJson(inbound?.metadata_json);
  if (meta?.fromEmail) return meta.fromEmail;
  if (env.runMode === 'mock') {
    const slug = String(lead.business_name || lead.id || 'business').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'business';
    return `owner@${slug}.test`;
  }
  return env.smoke.testEmail || env.allowedEmails[0] || '';
}

function latestAgentMailMessage(leadId) {
  return contactEvents.listByLead(leadId, { limit: 30 })
    .find((event) => event.channel === 'agentmail' && event.provider_id);
}

function lastProactiveSentAt(leadId) {
  const events = contactEvents.listByLead(leadId, { limit: 100 });
  const latestEvent = events.find((event) => (
    event.direction === 'outbound' &&
    event.channel === 'agentmail' &&
    ['account_manager_checkin', 'growth_recap'].includes(event.type)
  ));
  const latestTask = accountTasks.listByLead(leadId, { limit: 100 })
    .filter((task) => task.sent_at)
    .sort((a, b) => b.sent_at - a.sent_at)[0];
  return Math.max(latestEvent?.created_at || 0, latestTask?.sent_at || 0) || null;
}

function optOutStatus(lead) {
  const text = `${lead.risk_status || ''} ${lead.consent_status || ''} ${lead.next_action || ''} ${lead.outreach_status || ''}`;
  if (/opt.?out|unsubscribe|do_not_email|do_not_call/i.test(text)) return { blocked: true, reason: 'opt_out' };
  const events = contactEvents.listByLead(lead.id, { limit: 50 });
  const opted = events.some((event) => /opt.?out|unsubscribe|do not email|stop emailing|remove me/i.test(`${event.type || ''} ${event.subject || ''} ${event.body || ''} ${event.metadata_json || ''}`));
  return opted ? { blocked: true, reason: 'thread_opt_out' } : { blocked: false, reason: 'clear' };
}

function unsupportedStatus(lead) {
  const text = `${lead.risk_status || ''} ${lead.next_action || ''}`;
  if (/operator-handoff|operator_review|unsupported/i.test(text)) return { blocked: true, reason: 'operator_handoff' };
  const events = contactEvents.listByLead(lead.id, { limit: 50 });
  const unsupported = events.some((event) => /unsupported|legal|contract|guarantee|refund|tax|security/i.test(`${event.body || ''} ${event.metadata_json || ''}`));
  return unsupported ? { blocked: true, reason: 'unsupported_thread' } : { blocked: false, reason: 'clear' };
}

function eventPayload({ lead, task, preview, policy, sendResult = null, error = null }) {
  return {
    worker: 'account_manager',
    leadId: lead.id,
    taskId: task.id,
    kind: task.kind,
    status: task.status,
    dryRun: policy?.dryRun,
    blocked: policy?.blocked,
    blockers: policy?.blockers || [],
    subject: preview?.subject,
    providerId: sendResult?.providerId || sendResult?.messageId || null,
    threadId: sendResult?.threadId || null,
    mock: sendResult?.mock,
    error
  };
}

function htmlParagraphs(text) {
  return `<p>${escapeHtml(text).replace(/\n+/g, '</p><p>')}</p>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0] || '*'}***@***.${tld}`;
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}
