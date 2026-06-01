#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'callan-portal-check-'));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BROWSER_SESSIONS: 'false',
  LIVE_BUILDS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false',
  GEMINI_API_KEY: '',
  SUPERMEMORY_API_KEY: '',
  AGENTPHONE_API_KEY: '',
  AGENTMAIL_API_KEY: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: ''
});

try {
  const dbApi = await import('../server/db.js');
  const portal = await import('../server/customerPortal.js');

  const {
    leads,
    payments,
    builds,
    buildQaResults,
    buildRevisions,
    contactEvents,
    customerIntake,
    portalActions,
    portalTokens,
    safeToRenewPlaybooks,
    subscriptions
  } = dbApi;

  const leadId = `lead_portal_${Date.now().toString(36)}`;
  const now = Date.now();
  leads.insert({
    id: leadId,
    container_tag: `biz_${leadId}`,
    business_name: 'Portal Proof Plumbing',
    phone: '+14155550199',
    address: '99 Market St, San Francisco, CA',
    niche: 'plumber',
    city: 'San Francisco',
    website: null,
    status: 'awaiting_payment',
    research_status: 'complete',
    outreach_status: 'queued',
    risk_status: 'callable',
    consent_status: 'operator_demo',
    phone_classification: 'business',
    next_action: 'send_invoice',
    source_url: 'https://example.test/portal-proof',
    research_json: JSON.stringify({
      businessName: 'Portal Proof Plumbing',
      bestContactEmail: 'owner@portalproof.test',
      onlinePresenceSummary: 'No owned website; customers need emergency plumbing and quote requests.',
      needs: ['emergency repair copy', 'tap-to-call CTA', 'service area proof'],
      signals: ['weak owned presence', 'phone-forward business']
    })
  });

  payments.insertOrGetByIdempotency({
    id: `pay_${leadId}`,
    lead_id: leadId,
    stripe_invoice_id: `in_${leadId}`,
    stripe_session_id: `in_${leadId}`,
    stripe_customer_id: `cus_${leadId}`,
    customer_email: 'owner@portalproof.test',
    payment_link_url: `https://invoice.stripe.com/i/${leadId}`,
    hosted_invoice_url: `https://invoice.stripe.com/i/${leadId}`,
    amount_cents: 50000,
    status: 'paid',
    due_at: now + 7 * 86400000,
    idempotency_key: `portal_check_invoice_${leadId}`
  });

  const buildId = `bld_${leadId}`;
  builds.start({
    id: buildId,
    lead_id: leadId,
    browser_session_id: 'mock-session',
    live_url: `/api/leads/${encodeURIComponent(leadId)}/build-preview`,
    brief: 'Build a mobile-first emergency plumbing website.'
  });
  builds.update(buildId, {
    status: 'completed',
    project_url: 'https://portal-proof-plumbing.lovable.app',
    launch_status: 'ready_for_customer',
    operator_approved_at: now,
    finished_at: now
  });
  buildQaResults.upsert({
    build_id: buildId,
    lead_id: leadId,
    attempt: 0,
    provider: 'portal-check',
    url: 'https://portal-proof-plumbing.lovable.app',
    status: 'passed',
    passed: true,
    score: 96,
    checklist: [{ key: 'contact', label: 'Contact visible', passed: true }],
    errors: [],
    claims: { businessName: 'Portal Proof Plumbing' }
  });

  const token = portal.ensurePortalTokenForLead({ leadId, metadata: { source: 'portal_check' } });
  assert.match(token.token, /^pt_/, 'portal token should be opaque/random');
  assert.notEqual(token.token, leadId, 'portal token must not be the lead id');
  assert.equal(portal.resolvePortalAccess(token.token).leadId, leadId, 'active token should resolve');
  assert.equal(portal.resolvePortalAccess(leadId).leadId, leadId, 'mock legacy lead-id link should still resolve');

  const rotated = portalTokens.rotate({ lead_id: leadId, reason: 'portal_check_rotation' });
  assert.match(rotated.token, /^pt_/, 'rotated token should be opaque');
  assert.notEqual(rotated.token, token.token, 'rotation should issue a new token');
  assert.equal(portal.resolvePortalAccess(token.token).ok, false, 'old token should stop resolving after rotation');

  await portal.updateIntake({
    leadId,
    tokenId: rotated.row.id,
    intake: {
      contactName: 'Priya Owner',
      contactEmail: 'owner@portalproof.test',
      preferredPhone: '+14155550199',
      serviceArea: 'San Francisco and Daly City',
      primaryGoal: 'Turn emergency plumbing searches into phone calls.',
      brandVoice: 'clear, trustworthy, fast',
      mustHaveSections: ['hero', 'services', 'reviews', 'contact'],
      notes: 'Mention 24/7 emergency repairs.'
    }
  });
  assert.equal(customerIntake.get(leadId).primaryGoal.includes('emergency'), true, 'intake should persist');

  const scope = portal.approveScope({ leadId, tokenId: rotated.row.id, notes: 'Scope looks right.' });
  assert.equal(scope.action.status, 'approved', 'scope approval should persist as approved');

  const accepted = await portal.acceptQuote({ leadId, tokenId: rotated.row.id });
  assert.equal(accepted.ok, true, 'accept quote should succeed with existing paid invoice');

  const asset = await portal.recordAssetUrl({
    leadId,
    tokenId: rotated.row.id,
    url: 'mock://asset/logo.png',
    label: 'Logo',
    notes: 'Use this on the header.'
  });
  assert.equal(asset.asset.url, 'mock://asset/logo.png', 'mock asset should persist');

  const revision = await portal.requestRevision({
    leadId,
    tokenId: rotated.row.id,
    note: 'Make the emergency repair CTA stronger above the fold.'
  });
  assert.equal(revision.ok, true, 'revision request should succeed');
  assert.ok(buildRevisions.listByLead(leadId).length >= 1, 'revision should link into build_revisions');

  const callback = portal.bookCallback({
    leadId,
    tokenId: rotated.row.id,
    scheduledAtMs: now + 2 * 3600000,
    ask: 'Walk through the launch checklist.'
  });
  assert.equal(callback.ok, true, 'callback should be scheduled');

  const launch = await portal.approveLaunch({ leadId, tokenId: rotated.row.id, notes: 'Ready to launch.' });
  assert.equal(launch.ok, true, 'launch approval should succeed');

  const subscription = subscriptions.upsert({
    id: `sub_${leadId}`,
    lead_id: leadId,
    stripe_subscription_id: `stripe_sub_${leadId}`,
    stripe_customer_id: `cus_${leadId}`,
    stripe_price_id: `price_${leadId}`,
    status: 'past_due',
    plan: 'hosting_edit_care',
    amount_cents: 9900,
    currency: 'usd',
    started_at: now - 14 * 86400000,
    metadata: { source: 'portal-check' }
  });
  const renewalPlaybook = safeToRenewPlaybooks.record({
    id: `renewplay_${leadId}`,
    leadId,
    subscriptionId: subscription.id,
    status: 'planned',
    priority: 'high',
    churnRisk: 0.76,
    expectedRetainedRevenueCents: 118800,
    recommendedMotion: 'operator_billing_recovery_review',
    playbook: {
      proofRequired: ['operator_renewal_review', 'billing_status_review', 'consent_and_opt_out_check'],
      nextSteps: ['review billing state', 'prepare renewal save copy without sending it']
    },
    safety: {
      externalSideEffects: false,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      operatorApprovalRequired: true
    },
    evidence: [`subscription:${subscription.id}`]
  }, { now });
  const renewalReview = portal.reviewRenewalPlan({
    leadId,
    tokenId: rotated.row.id,
    subscriptionId: subscription.id,
    note: 'Customer reviewed the renewal save plan.'
  });
  assert.equal(renewalReview.ok, true, 'renewal review should persist');
  assert.equal(renewalReview.playbook.id, renewalPlaybook.id, 'renewal review should link latest playbook');
  assert.equal(renewalReview.customerMessageSent, false, 'renewal review should not send a customer message');
  assert.equal(renewalReview.subscriptionChanged, false, 'renewal review should not change subscription state');
  const renewalReviewAgain = portal.reviewRenewalPlan({
    leadId,
    tokenId: rotated.row.id,
    subscriptionId: subscription.id,
    note: 'Duplicate review should reuse the same action.'
  });
  assert.equal(renewalReviewAgain.reused, true, 'renewal review should be idempotent by playbook');

  const subscriptionsBeforeChange = subscriptions.forLead(leadId).map((row) => ({ ...row }));
  const change = portal.requestRenewalChange({
    leadId,
    tokenId: rotated.row.id,
    subscriptionId: subscription.id,
    note: 'Please reduce edit-care hours next renewal.',
    requestType: 'reduce_scope'
  });
  assert.equal(change.ok, true, 'renewal change request should persist');
  assert.equal(change.playbook.id, renewalPlaybook.id, 'change request should link the latest playbook');
  assert.equal(change.liveSideEffects, false, 'change request must not produce live side effects');
  assert.equal(change.customerMessageSent, false, 'change request must not send a customer message');
  assert.equal(change.subscriptionChanged, false, 'change request must not mutate subscription');
  assert.equal(change.stripeStateChanged, false, 'change request must not mutate Stripe state');
  assert.equal(change.paymentLinkCreated, false, 'change request must not create a payment link');
  assert.equal(change.discountApplied, false, 'change request must not apply a discount');
  assert.equal(change.priceChanged, false, 'change request must not change live price');
  assert.equal(change.checkoutLinkCreated, false, 'change request must not create checkout link');
  assert.equal(change.operatorReviewRequired, true, 'change request must require operator review');
  const changeDup = portal.requestRenewalChange({
    leadId,
    tokenId: rotated.row.id,
    subscriptionId: subscription.id,
    note: 'Please reduce edit-care hours next renewal.',
    requestType: 'reduce_scope'
  });
  assert.equal(changeDup.reused, true, 'duplicate change request with same note/type should be reused');
  assert.equal(changeDup.action.id, change.action.id, 'duplicate change request should reuse the same portal action');
  const changeSecond = portal.requestRenewalChange({
    leadId,
    tokenId: rotated.row.id,
    subscriptionId: subscription.id,
    note: 'Actually we may want to upgrade to launch coverage—please advise.',
    requestType: 'upgrade'
  });
  assert.equal(changeSecond.ok, true, 'second distinct change request should persist');
  assert.notEqual(changeSecond.action.id, change.action.id, 'distinct change request should produce a new portal action');
  assert.equal(changeSecond.subscriptionChanged, false, 'second change request must not mutate subscription');
  const subscriptionsAfterChange = subscriptions.forLead(leadId);
  assert.equal(subscriptionsAfterChange.length, subscriptionsBeforeChange.length, 'change requests must not add subscription rows');
  for (let i = 0; i < subscriptionsBeforeChange.length; i += 1) {
    const before = subscriptionsBeforeChange[i];
    const after = subscriptionsAfterChange[i];
    assert.equal(after.status, before.status, 'subscription status must not change on portal request');
    assert.equal(after.amount_cents, before.amount_cents, 'subscription amount must not change on portal request');
    assert.equal(after.plan, before.plan, 'subscription plan must not change on portal request');
  }
  const inboundChangeEvents = contactEvents
    .listByLead(leadId)
    .filter((row) => row.type === 'customer_renewal_change_requested');
  assert.equal(inboundChangeEvents.length, 2, 'inbound contact events should record each distinct change request');
  for (const eventRow of inboundChangeEvents) {
    assert.equal(eventRow.direction, 'inbound', 'change request contact events should be inbound');
    assert.equal(eventRow.channel, 'portal', 'change request contact events should be channel portal');
  }

  const optOut = portal.optOut({ leadId, tokenId: rotated.row.id, reason: 'portal proof opt-out' });
  assert.equal(optOut.ok, true, 'opt-out should succeed');

  const state = portal.portalState({ leadId, access: portal.resolvePortalAccess(rotated.token) });
  assert.equal(state.business.id, leadId, 'portal state should include business profile');
  assert.equal(state.invoice.status, 'paid', 'portal state should include invoice/payment');
  assert.ok(state.intake.primaryGoal, 'portal state should include intake');
  assert.ok(state.revisions.length >= 1, 'portal state should include revisions');
  assert.ok(state.callbacks.length >= 1, 'portal state should include callbacks');
  assert.ok(state.contactEvents.length >= 1, 'portal state should include contact events');
  assert.ok(state.brief.memoryHighlights, 'portal state should include memory-derived brief surface');
  assert.ok(state.launchChecklist.some((item) => item.id === 'launch' && item.done), 'launch approval should appear in checklist');
  assert.equal(state.nextAction.id, 'opted_out', 'opt-out should control next action');
  assert.ok(state.intake.assetUrls.some((row) => row.url === 'mock://asset/logo.png'), 'portal state should expose saved assets');
  assert.equal(Object.prototype.hasOwnProperty.call(state.actions[0] || {}, 'body_json'), false, 'portal state actions should not leak raw body_json');
  assert.equal(Object.prototype.hasOwnProperty.call(state.approvals.launch || {}, 'metadata_json'), false, 'portal approvals should be customer-shaped');
  assert.equal(Object.prototype.hasOwnProperty.call(state.build || {}, 'browser_session_id'), false, 'portal build should not leak provider session internals');
  assert.equal(state.subscriptionManagement.activeCount, 1, 'portal state should include active renewal subscription');
  assert.equal(state.subscriptionManagement.atRiskCount, 1, 'portal state should expose at-risk renewal plan count');
  assert.equal(state.subscriptionManagement.customerReviewedCount, 1, 'portal state should show reviewed renewal plan');
  assert.equal(state.subscriptionManagement.changeRequestCount, 2, 'portal state should aggregate renewal change request count');
  assert.equal(state.subscriptionManagement.subscriptionsWithChangeRequestCount, 1, 'portal state should count subscriptions with change requests');
  assert.equal(state.subscriptionManagement.liveSideEffects, false, 'portal subscription management should prove no live side effects');
  assert.equal(state.subscriptionManagement.subscriptionChanged, false, 'portal subscription management should prove no subscription mutation');
  assert.equal(state.subscriptionManagement.stripeStateChanged, false, 'portal subscription management should prove no Stripe state mutation');
  assert.equal(state.subscriptionManagement.paymentLinkCreated, false, 'portal subscription management should prove no payment link');
  assert.equal(state.subscriptionManagement.discountApplied, false, 'portal subscription management should prove no discount');
  assert.equal(state.subscriptionManagement.priceChanged, false, 'portal subscription management should prove no price change');
  assert.equal(state.subscriptionManagement.checkoutLinkCreated, false, 'portal subscription management should prove no checkout link');
  const portalSubscriptionRow = state.subscriptionManagement.subscriptions[0];
  assert.equal(portalSubscriptionRow.renewal.safety.customerMessageSent, false, 'portal renewal state should prove no message was sent');
  assert.equal(portalSubscriptionRow.renewal.safety.subscriptionChanged, false, 'portal renewal state should prove no subscription mutation');
  assert.equal(portalSubscriptionRow.renewal.changeRequestCount, 2, 'portal renewal state should expose per-subscription change request count');
  assert.equal(portalSubscriptionRow.renewal.changeRequests.length, 2, 'portal renewal state should include each change request');
  for (const requestRow of portalSubscriptionRow.renewal.changeRequests) {
    assert.equal(requestRow.customerMessageSent, false, 'change request row must prove no customer message');
    assert.equal(requestRow.subscriptionChanged, false, 'change request row must prove no subscription mutation');
    assert.equal(requestRow.stripeStateChanged, false, 'change request row must prove no Stripe mutation');
    assert.equal(requestRow.paymentLinkCreated, false, 'change request row must prove no payment link');
    assert.equal(requestRow.discountApplied, false, 'change request row must prove no discount');
    assert.equal(requestRow.priceChanged, false, 'change request row must prove no price change');
    assert.equal(requestRow.checkoutLinkCreated, false, 'change request row must prove no checkout link');
    assert.equal(requestRow.operatorReviewRequired, true, 'change request row must require operator review');
  }
  const appliedBillingReceipt = portalActions.add({
    lead_id: leadId,
    token_id: rotated.row.id,
    type: 'renewal_billing_change_execution_receipt',
    status: 'applied',
    related_type: 'portal_action',
    related_id: change.action.id,
    body: {
      sourcePortalActionId: change.action.id,
      subscriptionId: subscription.id,
      provider: 'stripe',
      changeType: 'discount',
      subscriptionChanged: true,
      stripeStateChanged: true,
      providerMutationPerformed: true,
      liveSideEffects: true,
      priceChanged: true,
      discountApplied: true,
      paymentLinkCreated: true,
      checkoutLinkCreated: true
    },
    metadata: { source: 'portal_check_fixture' },
    actor: 'portal_check_operator',
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_billing_change.applied',
    summary: 'Portal-check fixture for an already-applied renewal billing change.'
  });
  const sentMessageReceipt = portalActions.add({
    lead_id: leadId,
    token_id: rotated.row.id,
    type: 'renewal_customer_message_send_receipt',
    status: 'sent',
    related_type: 'portal_action',
    related_id: change.action.id,
    body: {
      sourcePortalActionId: change.action.id,
      subscriptionId: subscription.id,
      provider: 'agentmail',
      customerMessageSent: true,
      agentMailMessageSent: true,
      providerMutationPerformed: true,
      liveSideEffects: true
    },
    metadata: { source: 'portal_check_fixture' },
    actor: 'portal_check_operator',
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_customer_message.sent',
    summary: 'Portal-check fixture for an already-sent renewal customer message.'
  });
  const confirmation = portal.createRenewalCustomerConfirmationReceipt({
    billingExecutionReceiptId: appliedBillingReceipt.id,
    messageSendReceiptId: sentMessageReceipt.id,
    operator: 'portal_check_operator',
    summary: 'Your renewal update is now visible in this portal.'
  });
  assert.equal(confirmation.ok, true, 'renewal confirmation should persist after applied/sent source receipts');
  assert.equal(confirmation.confirmationLiveSideEffects, false, 'confirmation itself must not create new live side effects');
  assert.equal(confirmation.paymentLinkCreated, true, 'confirmation should surface source payment-link proof');
  assert.equal(confirmation.checkoutLinkCreated, true, 'confirmation should surface source checkout-link proof');
  const acknowledgement = portal.acknowledgeRenewalCustomerConfirmation({
    leadId,
    tokenId: rotated.row.id,
    confirmationId: confirmation.confirmation.id,
    note: 'Portal-check customer received the renewal confirmation.'
  });
  assert.equal(acknowledgement.ok, true, 'customer acknowledgement should persist for visible renewal confirmation');
  assert.equal(acknowledgement.customerMessageSent, false, 'acknowledgement must not send a customer message');
  assert.equal(acknowledgement.liveSideEffects, false, 'acknowledgement must not create live side effects');
  const acceptance = portal.acceptRenewalCustomerConfirmation({
    leadId,
    tokenId: rotated.row.id,
    confirmationId: confirmation.confirmation.id,
    note: 'Portal-check customer says the renewal confirmation looks good.'
  });
  assert.equal(acceptance.ok, true, 'customer acceptance should persist after acknowledgement');
  assert.equal(acceptance.customerAccepted, true, 'customer acceptance should set accepted truth');
  assert.equal(acceptance.customerMessageSent, false, 'acceptance must not send a customer message');
  assert.equal(acceptance.liveSideEffects, false, 'acceptance must not create live side effects');
  const followup = portal.createRenewalCustomerConfirmationFollowupWorkItem({
    leadId,
    acceptanceId: acceptance.acceptance.id,
    operator: 'portal_check_operator',
    priority: 'normal'
  });
  assert.equal(followup.ok, true, 'operator follow-up should persist after customer acceptance');
  const resolvedFollowup = portal.resolveRenewalCustomerConfirmationFollowupWorkItem({
    workItemId: followup.workItem.id,
    outcome: 'completed',
    note: 'Portal-check operator verified accepted renewal confirmation.',
    operator: 'portal_check_operator'
  });
  assert.equal(resolvedFollowup.ok, true, 'operator should be able to complete renewal follow-up locally');
  const closeout = portal.createRenewalCustomerConfirmationCloseoutPacket({
    followupReceiptId: resolvedFollowup.receipt.id,
    operator: 'portal_check_operator',
    summary: 'Your renewal update is verified, accepted, and closed out in this portal.'
  });
  assert.equal(closeout.ok, true, 'customer-visible renewal closeout packet should persist after completed follow-up');
  assert.equal(closeout.customerMessageSent, false, 'closeout packet must not send a customer message');
  assert.equal(closeout.liveSideEffects, false, 'closeout packet must not create live side effects');
  const confirmedState = portal.portalState({ leadId, access: portal.resolvePortalAccess(rotated.token) });
  const confirmedSubscription = confirmedState.subscriptionManagement.subscriptions.find((row) => row.id === subscription.id);
  assert.equal(confirmedState.subscriptionManagement.confirmationCount, 1, 'portal state should aggregate renewal confirmations');
  assert.equal(confirmedState.subscriptionManagement.acknowledgementCount, 1, 'portal state should aggregate renewal confirmation acknowledgements');
  assert.equal(confirmedState.subscriptionManagement.acceptanceCount, 1, 'portal state should aggregate renewal confirmation acceptances');
  assert.equal(confirmedState.subscriptionManagement.closeoutPacketCount, 1, 'portal state should aggregate renewal closeout packets');
  assert.equal(confirmedState.subscriptionManagement.subscriptionChanged, true, 'portal state should reflect confirmed source subscription change');
  assert.equal(confirmedState.subscriptionManagement.customerMessageSent, true, 'portal state should reflect confirmed source customer message');
  assert.equal(confirmedState.subscriptionManagement.paymentLinkCreated, true, 'portal state should reflect confirmed source payment link');
  assert.equal(confirmedState.subscriptionManagement.checkoutLinkCreated, true, 'portal state should reflect confirmed source checkout link');
  assert.equal(confirmedState.subscriptionManagement.confirmationMessageSent, false, 'portal confirmation must not send another message');
  assert.equal(confirmedState.subscriptionManagement.portalBroadcastSent, false, 'portal confirmation must not broadcast');
  assert.equal(confirmedSubscription.renewal.confirmationCount, 1, 'subscription row should expose confirmation count');
  assert.equal(confirmedSubscription.renewal.acknowledgementCount, 1, 'subscription row should expose acknowledgement count');
  assert.equal(confirmedSubscription.renewal.acceptanceCount, 1, 'subscription row should expose acceptance count');
  assert.equal(confirmedSubscription.renewal.closeoutPacketCount, 1, 'subscription row should expose closeout packet count');
  assert.equal(confirmedSubscription.renewal.latestConfirmation.id, confirmation.confirmation.id, 'subscription row should expose latest confirmation');
  assert.equal(confirmedSubscription.renewal.latestConfirmation.customerVisible, true, 'confirmation should be marked customer-visible');
  assert.equal(confirmedSubscription.renewal.latestConfirmation.acknowledged, true, 'confirmation should show customer acknowledgement');
  assert.equal(confirmedSubscription.renewal.latestConfirmation.accepted, true, 'confirmation should show customer acceptance');
  assert.equal(confirmedSubscription.renewal.latestConfirmation.closeoutPacketVisible, true, 'confirmation should show closeout packet visibility');
  assert.equal(confirmedSubscription.renewal.latestConfirmation.latestCloseoutPacket.id, closeout.packet.id, 'confirmation should expose latest closeout packet');
  assert.equal(confirmedSubscription.renewal.latestConfirmation.paymentLinkCreated, true, 'subscription row should expose source payment-link proof');
  assert.equal(confirmedSubscription.renewal.latestConfirmation.checkoutLinkCreated, true, 'subscription row should expose source checkout-link proof');
  assert.ok(portalActions.listByLead(leadId).some((row) => row.type === 'opt_out'), 'portal action log should include opt-out');
  assert.ok(portalActions.listByLead(leadId).some((row) => row.type === 'renewal_plan_reviewed'), 'portal action log should include renewal review');
  assert.ok(portalActions.listByLead(leadId).some((row) => row.type === 'renewal_customer_confirmation_receipt'), 'portal action log should include renewal confirmation');
  assert.ok(portalActions.listByLead(leadId).some((row) => row.type === 'renewal_customer_confirmation_closeout_packet'), 'portal action log should include renewal closeout packet');
  assert.equal(
    portalActions.listByLead(leadId).filter((row) => row.type === 'renewal_change_requested').length,
    2,
    'portal action log should record each distinct renewal change request'
  );

  console.log(JSON.stringify({
    ok: true,
    dataDir,
    leadId,
    tokenPrefix: rotated.token.slice(0, 10),
    portalPath: `/share/build/${rotated.token}`,
    checks: {
      token: true,
      rotation: true,
      legacyFallback: true,
      intake: true,
      accept: true,
      revision: true,
      asset: true,
      callback: true,
      renewalReview: true,
      renewalChangeRequest: true,
      optOut: true,
      approval: true,
      renewalConfirmation: true,
      renewalConfirmationAcceptance: true,
      richState: true,
      customerShapedState: true
    },
    counts: {
      portalActions: portalActions.listByLead(leadId).length,
      contactEvents: contactEvents.listByLead(leadId).length,
      revisions: buildRevisions.listByLead(leadId).length,
      subscriptions: state.subscriptionManagement.activeCount,
      renewalReviews: state.subscriptionManagement.customerReviewedCount,
      renewalChangeRequests: state.subscriptionManagement.changeRequestCount,
      renewalConfirmations: confirmedState.subscriptionManagement.confirmationCount,
      renewalConfirmationAcceptances: confirmedState.subscriptionManagement.acceptanceCount
    }
  }, null, 2));
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
