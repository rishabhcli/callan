import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-aftercare-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BUILDS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false',
  ACCOUNT_MANAGER_ENABLED: 'false',
  ACCOUNT_MANAGER_LIVE_SENDS: 'false',
  ACCOUNT_MANAGER_FREQUENCY_CAP_HOURS: '120',
  ACCOUNT_MANAGER_PREVIEW_CAP_HOURS: '1',
  OUTREACH_TIMEZONE: 'America/Los_Angeles',
  QUIET_HOURS_START: '20',
  QUIET_HOURS_END: '9',
  GEMINI_API_KEY: '',
  SUPERMEMORY_API_KEY: '',
  AGENTMAIL_API_KEY: '',
  AGENTMAIL_INBOX_ID: '',
  STRIPE_SECRET_KEY: '',
  BROWSER_USE_API_KEY: '',
  MOSS_PROJECT_ID: '',
  MOSS_PROJECT_KEY: ''
});

const { accountManagerPlans, accountTasks, buildQaResults, contactEvents, db, leads, payments, portalActions } = await import('../server/db.js');
const { containerTagFor } = await import('../server/memory.js');
const {
  evaluateSendPolicy,
  generateAccountManagerPlanForLead,
  runAccountManagerScheduler
} = await import('../server/accountManager/index.js');
const { approveLaunch } = await import('../server/customerPortal.js');
const { ACCOUNT_MANAGER_SECTION_KEYS } = await import('../server/accountManager/schema.js');

try {
  const now = Date.parse('2026-05-20T18:00:00Z');
  const deliveredAt = now - 25 * 60 * 60 * 1000;
  const leadId = insertLead({
    id: 'aftercare_mission_curl',
    businessName: 'Mission Curl Room',
    status: 'shipped',
    website: 'https://mission-curl-room.example.test',
    phone: '+14155550123',
    research: {
      businessName: 'Mission Curl Room',
      niche: 'hair salon',
      city: 'San Francisco',
      phone: '+14155550123',
      hours: 'Unknown; not found in source.',
      onlinePresenceStrength: 'weak',
      sourceUrl: 'https://example.test/mission-curl-room',
      needs: ['review capture', 'booking path', 'special hours']
    }
  });

  db.prepare(`
    INSERT INTO builds (
      id, lead_id, browser_session_id, live_url, project_url, status, started_at, finished_at, updated_at, trigger_key,
      launch_status, customer_approved_at
    )
    VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, 'customer_approved', ?)
  `).run(
    'bld_aftercare_mission_curl',
    leadId,
    'mock-browser-session',
    '/api/leads/aftercare_mission_curl/build-preview',
    'https://mission-curl-room.example.test',
    deliveredAt - 30 * 60 * 1000,
    deliveredAt,
    deliveredAt,
    'aftercare-test',
    deliveredAt
  );

  payments.insert({
    id: 'pay_aftercare_mission_curl',
    lead_id: leadId,
    stripe_session_id: 'mock_checkout_aftercare',
    stripe_invoice_id: 'mock_invoice_aftercare',
    customer_email: 'owner@mission-curl-room.test',
    amount_cents: 50000,
    status: 'paid',
    paid_at: deliveredAt - 10 * 60 * 1000,
    idempotency_key: 'aftercare-test-payment'
  });

  contactEvents.add({
    lead_id: leadId,
    type: 'customer_edit_request',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer edit request via share portal',
    body: 'Please add our curly hair consultation service and update the hero photo.',
    metadata: { synthetic: true }
  });
  const renewalCloseoutNextReviewAt = now + 14 * 24 * 60 * 60 * 1000;
  const renewalCloseout = portalActions.add({
    id: 'pa_aftercare_renewal_closeout',
    lead_id: leadId,
    type: 'renewal_customer_confirmation_closeout_packet',
    status: 'visible_to_customer',
    related_type: 'portal_action',
    related_id: 'pa_aftercare_followup_receipt',
    body: {
      leadId,
      subscriptionId: 'sub_aftercare_renewal',
      summary: 'Customer-visible renewal closeout is verified and ready for the next health review.',
      closeoutPacketVisible: true,
      customerVisible: true,
      portalVisible: true,
      customerMessageSent: false,
      liveSideEffects: false,
      closeoutLiveSideEffects: false,
      nextReviewAt: renewalCloseoutNextReviewAt
    },
    metadata: { synthetic: true },
    actor: 'ops_check_operator',
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_customer_confirmation.closeout_packet_recorded',
    summary: 'Synthetic renewal closeout packet for account-manager aftercare verification.'
  });

  const generated = await generateAccountManagerPlanForLead({ leadId, force: true, source: 'aftercare-check', now });
  assert.equal(generated.plan.schemaVersion, 'account_manager_plan.v1');
  for (const key of ACCOUNT_MANAGER_SECTION_KEYS) assert.ok(Array.isArray(generated.plan[key]), `${key} should be an array`);
  assert.ok(accountManagerPlans.getLatest(leadId), 'account manager plan should persist');

  const tasks = accountTasks.listByLead(leadId);
  const kinds = new Set(tasks.map((task) => task.kind));
  for (const kind of [
    'promised_edit',
    'stale_business_fact',
    'launch_followup',
    'review_capture',
    'google_business_profile_hygiene',
    'seasonal_hours',
    'service_menu_changes',
    'analytics_contact_flow_check',
    'hosting_subscription_status',
    'renewal_closeout_health_check'
  ]) {
    assert.ok(kinds.has(kind), `${kind} task should be persisted`);
  }
  for (const task of tasks) {
    assert.ok(Number.isFinite(task.due_at), `${task.kind} missing due_at`);
    assert.ok(task.priority, `${task.kind} missing priority`);
    assert.ok(task.channel, `${task.kind} missing channel`);
    assert.ok(task.owner, `${task.kind} missing owner`);
    assert.ok(task.idempotency_key, `${task.kind} missing idempotency key`);
    assert.ok(task.evidenceIds.length > 0, `${task.kind} missing evidence ids`);
  }

  const launch = tasks.find((task) => task.kind === 'launch_followup');
  assert.ok(launch.due_at <= now, '24h post-launch check should be due after 25h');
  const seasonal = tasks.find((task) => task.kind === 'seasonal_hours');
  assert.ok(seasonal.due_at > now, 'seasonal-hours reminder should be scheduled');
  const review = tasks.find((task) => task.kind === 'review_capture');
  assert.ok(review.due_at > launch.due_at, 'review request should happen after delivery check');
  const stale = tasks.find((task) => task.kind === 'stale_business_fact');
  assert.ok(stale.due_at <= now, 'stale phone/hours correction should be due immediately');
  const renewalCloseoutTask = tasks.find((task) => task.kind === 'renewal_closeout_health_check');
  assert.equal(renewalCloseoutTask.due_at, renewalCloseoutNextReviewAt, 'renewal closeout health check should use packet nextReviewAt');
  assert.equal(renewalCloseoutTask.channel, 'operator', 'renewal closeout health check should stay operator-owned');
  assert.ok(
    renewalCloseoutTask.evidenceIds.includes(`renewal-closeout-${renewalCloseout.id.replace(/_/g, '-')}`),
    'renewal closeout health check should cite the closeout packet evidence'
  );
  const boardEscalation = accountTasks.escalateToOperatorBoard(renewalCloseoutTask.id, {
    actor: 'aftercare-check',
    workItemKind: 'renewal_closeout_operator_review',
    requiredProof: 'renewal_closeout_operator_review',
    evidence: [{ id: 'aftercare-renewal-closeout-board-escalation', source: 'aftercare-check', summary: 'Renewal closeout health check escalates into operator-board review without customer contact.' }]
  });
  assert.equal(boardEscalation.inserted, true);
  assert.equal(boardEscalation.receipt.provider, 'account_manager_operator_board');
  assert.equal(boardEscalation.receipt.escalation_kind, 'account_manager_task_operator_board_review');
  assert.equal(boardEscalation.receipt.safety.customerMessageSent, false);
  assert.equal(boardEscalation.receipt.safety.subscriptionChanged, false);
  assert.equal(boardEscalation.receipt.safety.billingChanged, false);
  assert.equal(boardEscalation.workItem.work_item_kind, 'renewal_closeout_operator_review');
  assert.equal(boardEscalation.workItem.status, 'queued_review');
  assert.equal(boardEscalation.workItem.instructions.requiredProof, 'renewal_closeout_operator_review');
  assert.equal(boardEscalation.workItem.instructions.accountTaskId, renewalCloseoutTask.id);
  assert.equal(boardEscalation.workItem.safety.customerMessageSent, false);
  assert.equal(boardEscalation.task.owner, 'operator_board');
  const boardEscalationReused = accountTasks.escalateToOperatorBoard(renewalCloseoutTask.id, {
    actor: 'aftercare-check',
    workItemKind: 'renewal_closeout_operator_review',
    requiredProof: 'renewal_closeout_operator_review'
  });
  assert.equal(boardEscalationReused.inserted, false);
  assert.equal(boardEscalationReused.receipt.id, boardEscalation.receipt.id);
  assert(accountTasks.history(renewalCloseoutTask.id).some((row) => row.action === 'operator_board_escalated'));
  const boardClaim = accountTasks.claimOperatorBoardWorkItem(boardEscalation.workItem.id, {
    actor: 'aftercare-check',
    evidence: [{ id: 'aftercare-renewal-closeout-board-claim', source: 'aftercare-check', summary: 'Local operator claimed renewal closeout board review.' }]
  });
  assert.equal(boardClaim.inserted, true);
  assert.equal(boardClaim.receipt.provider, 'account_manager_operator_board_lifecycle');
  assert.equal(boardClaim.receipt.action_kind, 'claim');
  assert.equal(boardClaim.receipt.status, 'in_review');
  assert.equal(boardClaim.receipt.safety.customerMessageSent, false);
  assert.equal(boardClaim.receipt.safety.accountTaskCompleted, false);
  assert.equal(boardClaim.workItem.status, 'in_review');
  assert.equal(boardClaim.escalation.status, 'in_review');
  assert.notEqual(boardClaim.task.status, 'completed');
  const boardClaimReused = accountTasks.claimOperatorBoardWorkItem(boardEscalation.workItem.id, { actor: 'aftercare-check' });
  assert.equal(boardClaimReused.inserted, false);
  assert.equal(boardClaimReused.receipt.id, boardClaim.receipt.id);
  const boardResolve = accountTasks.resolveOperatorBoardWorkItem(boardEscalation.workItem.id, {
    actor: 'aftercare-check',
    proofKey: 'renewal_closeout_operator_review',
    proof: { reviewed: true, closeoutPacketId: renewalCloseout.id },
    note: 'Renewal closeout operator review resolved locally.',
    evidence: [{ id: 'aftercare-renewal-closeout-board-resolve', source: 'aftercare-check', summary: 'Local operator resolved renewal closeout board review without live side effects.' }]
  });
  assert.equal(boardResolve.inserted, true);
  assert.equal(boardResolve.receipt.action_kind, 'resolve');
  assert.equal(boardResolve.receipt.status, 'resolved');
  assert.equal(boardResolve.receipt.proof_key, 'renewal_closeout_operator_review');
  assert.equal(boardResolve.receipt.response.downstreamProof.renewal_closeout_operator_review, true);
  assert.equal(boardResolve.receipt.safety.customerMessageSent, false);
  assert.equal(boardResolve.receipt.safety.billingChanged, false);
  assert.equal(boardResolve.receipt.safety.accountTaskCompleted, false);
  assert.equal(boardResolve.workItem.status, 'resolved');
  assert.equal(boardResolve.workItem.instructions.lifecycle.receiptId, boardResolve.receipt.id);
  assert.equal(boardResolve.escalation.status, 'resolved');
  assert.notEqual(boardResolve.task.status, 'completed');
  assert(accountTasks.history(renewalCloseoutTask.id).some((row) => row.action === 'operator_board_resolve'));
  const boardResolveReused = accountTasks.resolveOperatorBoardWorkItem(boardEscalation.workItem.id, {
    actor: 'aftercare-check',
    proofKey: 'renewal_closeout_operator_review'
  });
  assert.equal(boardResolveReused.inserted, false);
  assert.equal(boardResolveReused.receipt.id, boardResolve.receipt.id);
  const boardRetentionFeedback = accountTasks.recordOperatorBoardRetentionFeedback(boardResolve.receipt.id, {
    actor: 'aftercare-check',
    recommendation: 'attach_to_retention_health_watch',
    evidence: [{ id: 'aftercare-renewal-closeout-board-retention-feedback', source: 'aftercare-check', summary: 'Resolved renewal board review can become a retention feedback signal without contacting the customer.' }]
  });
  assert.equal(boardRetentionFeedback.inserted, true);
  assert.equal(boardRetentionFeedback.receipt.provider, 'account_manager_operator_board_retention_feedback');
  assert.equal(boardRetentionFeedback.receipt.feedback_kind, 'account_board_retention_signal');
  assert.equal(boardRetentionFeedback.receipt.recommendation, 'attach_to_retention_health_watch');
  assert.equal(boardRetentionFeedback.receipt.safety.kind, 'account_manager_operator_board_retention_feedback_safety');
  assert.equal(boardRetentionFeedback.receipt.safety.customerMessageSent, false);
  assert.equal(boardRetentionFeedback.receipt.safety.retentionPlaybookMutated, false);
  assert.equal(boardRetentionFeedback.receipt.safety.accountTaskCompleted, false);
  assert.equal(boardRetentionFeedback.receipt.response.operatorBoardLifecycleReceiptId, boardResolve.receipt.id);
  assert.equal(boardRetentionFeedback.receipt.response.externalSideEffects, false);
  const boardRetentionFeedbackReused = accountTasks.recordOperatorBoardRetentionFeedback(boardResolve.receipt.id, { actor: 'aftercare-check' });
  assert.equal(boardRetentionFeedbackReused.inserted, false);
  assert.equal(boardRetentionFeedbackReused.receipt.id, boardRetentionFeedback.receipt.id);
  assert(accountTasks.history(renewalCloseoutTask.id).some((row) => row.action === 'operator_board_retention_feedback_recorded'));
  const operatorBoardSummary = accountTasks.operatorBoardSummary();
  assert.equal(operatorBoardSummary.escalations.total, 1);
  assert.equal(operatorBoardSummary.workItems.total, 1);
  assert.equal(operatorBoardSummary.workItems.byStatus.resolved, 1);
  assert.equal(operatorBoardSummary.lifecycleReceipts.total, 2);
  assert.equal(operatorBoardSummary.lifecycleReceipts.byAction.claim, 1);
  assert.equal(operatorBoardSummary.lifecycleReceipts.byAction.resolve, 1);
  assert.equal(operatorBoardSummary.retentionFeedback.total, 1);
  assert.equal(operatorBoardSummary.retentionFeedback.byRecommendation.attach_to_retention_health_watch, 1);

  const dryRun = await runAccountManagerScheduler({ leadId, dryRun: true, now, source: 'aftercare-check' });
  assert.ok(dryRun.processed >= 1, 'dry-run should process due tasks');
  assert.ok(dryRun.results.some((row) => row.preview?.body?.includes('I have this noted on my side')), 'dry-run preview should cite remembered evidence');
  assert.ok(accountTasks.listByLead(leadId).some((task) => task.preview?.body), 'preview message should persist on task');

  const prelaunchLeadId = insertLead({
    id: 'aftercare_waits_for_customer_launch',
    businessName: 'Prelaunch Proof Salon',
    status: 'awaiting_launch_approval',
    website: 'https://prelaunch-proof.example.test',
    research: {
      niche: 'hair salon',
      city: 'San Francisco',
      hours: 'Unknown; not found in source.',
      sourceUrl: 'https://example.test/prelaunch-proof'
    }
  });
  const prelaunchBuildId = 'bld_aftercare_waits_for_launch';
  db.prepare(`
    INSERT INTO builds (
      id, lead_id, browser_session_id, live_url, project_url, status, started_at, finished_at, updated_at, trigger_key,
      launch_status, operator_approved_at
    )
    VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, 'ready_for_customer', ?)
  `).run(
    prelaunchBuildId,
    prelaunchLeadId,
    'mock-browser-session-prelaunch',
    '/api/leads/aftercare_waits_for_customer_launch/build-preview',
    'https://prelaunch-proof.example.test',
    deliveredAt - 30 * 60 * 1000,
    deliveredAt,
    deliveredAt,
    'aftercare-prelaunch-test',
    deliveredAt
  );
  const prelaunchPlan = await generateAccountManagerPlanForLead({ leadId: prelaunchLeadId, force: true, source: 'aftercare-check-prelaunch', now });
  assert.ok(!prelaunchPlan.tasks.some((task) => task.kind === 'launch_followup'), 'launch follow-up must not start before customer launch approval');
  assert.ok(!prelaunchPlan.tasks.some((task) => task.kind === 'review_capture'), 'review request must not start before customer launch approval');

  buildQaResults.upsert({
    build_id: prelaunchBuildId,
    lead_id: prelaunchLeadId,
    attempt: 0,
    provider: 'aftercare-check',
    url: 'https://prelaunch-proof.example.test',
    status: 'passed',
    passed: true,
    score: 96,
    checklist: [{ key: 'contact_flow', passed: true }],
    errors: [],
    claims: { synthetic: true },
    idempotency_key: 'aftercare-prelaunch-qa'
  });
  const approvalAt = now + 30 * 60 * 1000;
  const launchApproval = await approveLaunch({ leadId: prelaunchLeadId, notes: 'Ready to launch.', now: approvalAt });
  assert.equal(launchApproval.ok, true, 'customer launch approval should succeed');
  assert.equal(launchApproval.aftercare?.ok, true, 'launch approval should seed aftercare automatically');
  assert.ok(launchApproval.aftercare.processed >= 1, 'launch approval should run a dry-run aftercare sweep for due tasks');
  const postApprovalTasks = accountTasks.listByLead(prelaunchLeadId);
  const seededLaunch = postApprovalTasks.find((task) => task.kind === 'launch_followup');
  assert.ok(seededLaunch, 'launch approval should persist a 24h launch follow-up task');
  assert.equal(seededLaunch.due_at, approvalAt + 24 * 60 * 60 * 1000, '24h launch follow-up should be scheduled from customer approval');
  assert.ok(postApprovalTasks.some((task) => task.preview?.body), 'launch approval dry-run should persist at least one preview');

  const liveGated = await runAccountManagerScheduler({
    taskId: stale.id,
    dryRun: false,
    now: now + 2 * 60 * 60 * 1000,
    operatorSend: true,
    source: 'aftercare-check-live-gate'
  });
  assert.ok(liveGated.results[0].policy.blockers.some((b) => b.code === 'live_emails_disabled'), 'LIVE_EMAILS=false should block live send');

  const optOutLeadId = insertLead({
    id: 'aftercare_optout',
    businessName: 'No More Mail HVAC',
    status: 'shipped',
    website: 'https://no-more-mail.example.test',
    risk_status: 'email-opt-out',
    next_action: 'do_not_email',
    research: { hours: 'Unknown; not found in source.' }
  });
  const optOutGenerated = await generateAccountManagerPlanForLead({ leadId: optOutLeadId, force: true, source: 'aftercare-check', now });
  const optOutTask = optOutGenerated.tasks.find((task) => task.kind === 'stale_business_fact') || accountTasks.listByLead(optOutLeadId)[0];
  const optOutRun = await runAccountManagerScheduler({ taskId: optOutTask.id, dryRun: false, now, operatorSend: true });
  assert.equal(optOutRun.results[0].status, 'blocked');
  assert.ok(optOutRun.results[0].policy.blockers.some((b) => /opt_out/.test(b.code)), 'opt-out should block proactive sends');

  contactEvents.add({
    lead_id: leadId,
    type: 'account_manager_checkin',
    direction: 'outbound',
    channel: 'agentmail',
    provider_id: 'mock_recent_aftercare',
    thread_id: 'thread_aftercare',
    subject: 'Recent check-in',
    body: 'Recent proactive send.',
    metadata: { synthetic: true }
  });
  const policy = evaluateSendPolicy({
    lead: leads.get(leadId),
    task: accountTasks.listByLead(leadId).find((task) => task.kind === 'launch_followup'),
    dryRun: false,
    now: now + 60 * 60 * 1000,
    operatorSend: true
  });
  assert.ok(policy.blockers.some((b) => b.code === 'frequency_cap'), 'frequency cap should block spam');

  const quietPolicy = evaluateSendPolicy({
    lead: leads.get(leadId),
    task: accountTasks.listByLead(leadId).find((task) => task.kind === 'launch_followup'),
    dryRun: false,
    now: Date.parse('2026-01-16T05:30:00Z'),
    operatorSend: true
  });
  assert.ok(quietPolicy.blockers.some((b) => b.code === 'quiet_window'), 'quiet window should block live proactive email');

  console.log('\n=== AFTERCARE CHECK RESULTS ===\n');
  console.log(`[PASS] account_manager_plan persisted for ${leadId}`);
  console.log(`[PASS] ${tasks.length} account_tasks persisted with due_at, priority, channel, owner, evidence, and idempotency keys`);
  console.log('[PASS] 24h launch, review capture, seasonal hours, stale facts, GBP, analytics, promised edit, and hosting checks exist');
  console.log('[PASS] customer-visible renewal closeout packets become operator-owned renewal health checks');
  console.log('[PASS] dry-run previews cite remembered evidence and persist to the task');
  console.log('[PASS] post-launch aftercare waits for customer approval, then seeds automatically from portal launch approval');
  console.log('[PASS] LIVE_EMAILS gate, opt-out block, frequency cap, and quiet-window block verified');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

function insertLead({
  id,
  businessName,
  status = 'shipped',
  website = null,
  phone = '+14155550199',
  risk_status = 'pending',
  next_action = 'account_manager_plan',
  research = {}
}) {
  const result = leads.insert({
    id,
    container_tag: containerTagFor(id),
    business_name: businessName,
    phone,
    address: '1 Market St, San Francisco, CA',
    niche: research.niche || 'local services',
    city: research.city || 'San Francisco',
    website,
    status,
    research_status: 'complete',
    outreach_status: 'not_queued',
    risk_status,
    consent_status: 'public_business',
    phone_classification: 'business',
    next_action,
    source_url: research.sourceUrl || 'https://example.test/local-listing',
    online_presence_strength: research.onlinePresenceStrength || 'weak',
    presence_confidence: research.presenceConfidence || 0.75,
    research_json: JSON.stringify({
      businessName,
      niche: research.niche || 'local services',
      city: research.city || 'San Francisco',
      hasWebsite: Boolean(website),
      websiteUrl: website,
      onlinePresenceStrength: research.onlinePresenceStrength || 'weak',
      presenceConfidence: research.presenceConfidence || 0.75,
      onlinePresenceSummary: 'Synthetic weak-presence lead for aftercare verification.',
      hours: research.hours || 'Unknown; not found in source.',
      phone,
      signals: ['synthetic lead'],
      needs: ['local SEO', 'review capture', 'contact path'],
      sourceUrl: research.sourceUrl || 'https://example.test/local-listing',
      ...research
    })
  });
  return result.lead.id;
}
