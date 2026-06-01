/**
 * Customer-facing self-serve portal handlers.
 *
 * Powers `/share/build/:token/*`: quote acceptance, edit requests, callbacks,
 * launch approval, commerce intake, and opt-out all land in the same lead,
 * audit, and build revision tables used by the operator console.
 */

import { createHash, randomBytes } from 'node:crypto';
import { canEmail, canPay, env } from './env.js';
import {
  buildQaResults,
  buildRevisions,
  builds,
  contactEvents,
  customerIntake,
  events as eventStore,
  growthPlans,
  leads,
  memoryDocuments,
	  payments,
	  portalActions,
	  portalTokens,
	  providerSmoke,
	  safeToRenewPlaybooks,
	  scheduledCalls,
	  subscriptions
	} from './db.js';
import { createOrReuseRevenueInvoice } from './paymentFlow.js';
import { sendAgentMailMessage } from './providers/agentmail.js';
import { applyStripeSubscriptionChange, stripeConfigured } from './providers/stripe.js';
import { recordProviderRuntimeIncident } from './providerIncidents.js';
import { createScheduledCall } from './scheduledCalls.js';
import { recordOptOut, normalizePhone } from './compliance.js';
import { addDoc, containerTagFor } from './memory.js';
import { emit } from './sse.js';
import { log } from './logger.js';
import { compactLeadIntelligence, evidenceTraceText } from './research/leadIntelligence.js';
import { buildQaReadModel } from './fulfillment/hooks/index.js';
import { createRevisionPlan } from './fulfillment/hooks/revision.js';
import { readAccountManagerState, runAccountManagerScheduler } from './accountManager/index.js';

function requireLead(leadId) {
  const lead = leads.get(leadId);
  if (!lead) {
    const err = new Error(`lead ${leadId} not found`);
    err.code = 'lead_not_found';
    throw err;
  }
  return lead;
}

export function ensurePortalTokenForLead({ leadId, purpose = 'build_share', ttlMs = 30 * 86400000, metadata = {} } = {}) {
  requireLead(leadId);
  if (!portalTokens?.ensureActive) return { token: leadId, path: `/share/build/${encodeURIComponent(leadId)}`, url: `/share/build/${encodeURIComponent(leadId)}`, fallback: true };
  const result = portalTokens.ensureActive({ lead_id: leadId, purpose, expiresInMs: ttlMs, metadata });
  const token = result?.token || result?.row?.token || leadId;
  return { token, row: result?.row || null, reused: !!result?.reused, path: `/share/build/${encodeURIComponent(token)}`, url: `/share/build/${encodeURIComponent(token)}` };
}

export function legacyPortalFallbackAllowed() {
  return env.runMode === 'demo_live' || (env.runMode === 'mock' && env.nodeEnv !== 'production');
}

export function resolvePortalAccess(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const result = portalTokens?.resolve?.(raw);
  if (result?.ok && result?.lead) {
    return {
      leadId: result.lead.id,
      lead: result.lead,
      token: raw,
      tokenRow: result.row,
      ok: true,
      canonicalUrl: `/share/build/${encodeURIComponent(raw)}`
    };
  }
  if (legacyPortalFallbackAllowed()) {
    const direct = leads.get(raw);
    if (direct) {
      const active = ensurePortalTokenForLead({
        leadId: direct.id,
        metadata: { source: 'share_portal', legacyFallbackFromLeadId: true }
      });
      return {
        leadId: direct.id,
        lead: direct,
        token: active.token,
        tokenRow: active.row,
        ok: true,
        legacy: true,
        canonicalUrl: active.url
      };
    }
  }
  return {
    ok: false,
    status: result?.reason === 'expired' ? 410 : result?.reason === 'revoked' ? 403 : 404,
    error: result?.reason === 'expired' ? 'portal link expired' : 'not found',
    reason: result?.reason || 'not_found'
  };
}

export function portalState({ leadId, access = null } = {}) {
  const lead = requireLead(leadId);
  const latestBuild = builds.listByLead(leadId)[0] || null;
  const builderEvents = eventStore.listByLead(leadId, { worker: 'builder', limit: 100 });
  const builderQa = latestBuild ? buildQaReadModelCompat({ leadId, buildId: latestBuild.id }) : buildQaReadModelCompat({ leadId });
  const intake = customerIntake.get(leadId) || emptyIntake(lead);
  const paymentsForLead = payments.listByLead(leadId);
  const latestPayment = paymentsForLead[0] || null;
  const actionRows = portalActions.listByLead?.(leadId, { limit: 120 }) || [];
  const revisionRows = buildRevisions.listByLead(leadId, { limit: 80 }) || [];
  const callbackRows = scheduledCalls.listForLead?.(leadId) || [];
  const contactRows = contactEvents.listByLead(leadId, { limit: 80 }) || [];
  const brief = portalBriefForLead(lead);
  const buildProgressLog = builderEvents
    .map((row) => {
      const payload = safeJson(row.payload_json) || {};
      return {
        ts: row.ts || row.created_at,
        type: row.type,
        text: payload.summary || payload.note || payload.error || payload.projectUrl || payload.liveUrl || ''
      };
    })
    .filter((item) => item.text)
    .slice(-12);
  const approvals = {
    scope: portalActionRow(actionRows.find((row) => row.type === 'scope_approved')),
    launch: portalActionRow(actionRows.find((row) => row.type === 'launch_approved'))
  };
  const pendingCallback = pendingCallbackForLead(leadId);
  const quoteStatus = quoteStatusForLead(lead);
  const payment = paymentLinksForLead(leadId);
  const optedOut = lead.consent_status === 'opted_out' || lead.risk_status === 'opt-out';
  const launchChecklist = portalLaunchChecklist({
    intake,
    quoteStatus,
    latestPayment,
    latestBuild,
    builderQa,
    revisionRows,
    approvals,
    optedOut
  });
  return {
    leadId,
    portal: {
      leadId,
      tokenId: access?.tokenRow?.id || null,
      tokenStatus: access?.tokenRow?.status || null,
      expiresAt: access?.tokenRow?.expires_at || null,
      legacyFallback: !!access?.legacy,
      canonicalUrl: access?.canonicalUrl || null,
      urlPattern: '/share/build/:token'
    },
    businessName: lead.business_name || null,
    business: {
      id: lead.id,
      name: lead.business_name || null,
      niche: lead.niche || null,
      city: lead.city || null,
      address: lead.address || null,
      phone: lead.phone || null,
      website: lead.website || null,
      sourceUrl: lead.source_url || null,
      onlinePresenceStrength: lead.online_presence_strength || null,
      profile: safeJson(lead.research_json)
    },
    brief: {
      ...brief,
      memoryHighlights: memoryBriefHighlights(leadId)
    },
    quoteStatus,
    quote: {
      status: quoteStatus,
      amountCents: 50000,
      priceLabel: '$500',
      productName: 'Website by callmemaybe',
      verticalPack: lead.vertical_pack || null,
      accepted: quoteStatus === 'accepted' || quoteStatus === 'paid',
      paid: quoteStatus === 'paid',
      scopeApproved: !!approvals.scope,
      lineItems: [
        'Mobile-first one-page website',
        'Copy based on the call, research, and intake',
        'Live build preview and revision queue',
        'Launch handoff after approval'
      ]
    },
    payment,
    invoice: latestPayment ? {
      id: latestPayment.id,
      status: latestPayment.status,
      amountCents: latestPayment.amount_cents,
      paymentLinkUrl: payment.paymentLinkUrl,
      invoiceUrl: payment.invoiceUrl,
      invoicePdfUrl: latestPayment.invoice_pdf_url || null,
      dueAt: latestPayment.due_at || null,
      paidAt: latestPayment.paid_at || null,
      createdAt: latestPayment.created_at || null
    } : {
      status: quoteStatus === 'accepted' ? 'pending' : 'not_created',
      amountCents: 50000,
      paymentLinkUrl: payment.paymentLinkUrl,
      invoiceUrl: payment.invoiceUrl
    },
    paymentLinkUrl: payment.paymentLinkUrl,
    invoiceUrl: payment.invoiceUrl,
    build: portalBuildRow(latestBuild, lead, buildProgressLog),
    builderQa,
    qa: builderQa,
    revisions: revisionRows.map(portalRevisionRow),
    pendingCallback: portalCallbackRow(pendingCallback),
    existingPendingCallback: portalCallbackRow(pendingCallback),
    callbacks: callbackRows.map(portalCallbackRow),
    intake,
    approvals,
    actions: actionRows.slice(0, 40).map(portalActionRow),
    contactEvents: contactRows.map(portalContactRow),
    subscriptionManagement: subscriptionManagementForLead(leadId, actionRows),
    growth: growthStateForLead(leadId),
    launchChecklist,
    nextAction: nextPortalAction(launchChecklist, { optedOut, quoteStatus }),
    accountManagerTimeline: accountManagerTimeline({ builderEvents, actionRows, contactRows, callbackRows }),
    timeline: builderEvents.map((e) => ({
      ts: e.ts || e.created_at,
      type: e.type || e.event_type,
      summary: safeJson(e.payload_json)?.summary || safeJson(e.payload_json)?.note || null
    })),
    vertical_pack: lead.vertical_pack || null
  };
}

export function reviewRenewalPlan({
  leadId,
  tokenId = null,
  subscriptionId = null,
  note = 'Customer reviewed renewal plan in portal.'
} = {}) {
  const lead = requireLead(leadId);
  const subscriptionRows = subscriptions.forLead(leadId) || [];
  const target = subscriptionId
    ? subscriptionRows.find((row) => row.id === subscriptionId)
    : subscriptionRows.find((row) => safeToRenewPlaybooks.latestBySubscription(row.id));
  if (!target) {
    const err = new Error(subscriptionId ? 'subscription not found for this portal' : 'no renewal playbook available');
    err.code = 'invalid_request';
    throw err;
  }
  const playbook = safeToRenewPlaybooks.latestBySubscription(target.id);
  if (!playbook || playbook.leadId !== leadId) {
    const err = new Error('renewal playbook not found for this subscription');
    err.code = 'invalid_request';
    throw err;
  }
  const existing = (portalActions.listByLead?.(leadId, { limit: 100, type: 'renewal_plan_reviewed' }) || [])
    .find((row) => row.related_id === playbook.id);
  if (existing) {
    return {
      ok: true,
      reused: true,
      action: portalActionRow(existing),
      subscription: portalSubscriptionRow(target, playbook, existing),
      playbook: portalRenewalPlaybookRow(playbook),
      liveSideEffects: false,
      customerMessageSent: false,
      subscriptionChanged: false
    };
  }
  const cleanNote = compactText(note, 500) || 'Customer reviewed renewal plan in portal.';
  const action = portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'renewal_plan_reviewed',
    status: 'reviewed',
    related_type: 'safe_to_renew_playbook',
    related_id: playbook.id,
    body: {
      subscriptionId: target.id,
      playbookId: playbook.id,
      note: cleanNote,
      recommendedMotion: playbook.recommendedMotion,
      churnRisk: playbook.churnRisk,
      expectedRetainedRevenueCents: playbook.expectedRetainedRevenueCents,
      customerMessageSent: false,
      subscriptionChanged: false
    },
    metadata: {
      source: 'share_portal',
      noLiveSideEffects: true,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false
    }
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'customer_renewal_plan_reviewed',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer reviewed renewal plan',
    body: `${lead.business_name || 'Customer'} reviewed the renewal plan. ${cleanNote}`,
    metadata: {
      source: 'share_portal',
      portalActionId: action.id,
      subscriptionId: target.id,
      playbookId: playbook.id,
      decisionCode: 'portal.renewal_plan_reviewed',
      decisionReason: 'Customer reviewed the renewal save plan in the portal without live subscription mutation.',
      customerMessageSent: false,
      subscriptionChanged: false
    }
  });
  emit('portal.renewal_plan_reviewed', {
    worker: 'portal',
    leadId,
    portalActionId: action.id,
    subscriptionId: target.id,
    playbookId: playbook.id
  });
  return {
    ok: true,
    action: portalActionRow(action),
    subscription: portalSubscriptionRow(target, playbook, action),
    playbook: portalRenewalPlaybookRow(playbook),
    liveSideEffects: false,
    customerMessageSent: false,
    subscriptionChanged: false
  };
}

export function requestRenewalChange({
  leadId,
  tokenId = null,
  subscriptionId = null,
  note = '',
  requestType = 'change'
} = {}) {
  const lead = requireLead(leadId);
  const subscriptionRows = subscriptions.forLead(leadId) || [];
  const target = subscriptionId
    ? subscriptionRows.find((row) => row.id === subscriptionId)
    : subscriptionRows.find((row) => safeToRenewPlaybooks.latestBySubscription(row.id));
  if (!target) {
    const err = new Error(subscriptionId ? 'subscription not found for this portal' : 'no renewal playbook available');
    err.code = 'invalid_request';
    throw err;
  }
  const playbook = safeToRenewPlaybooks.latestBySubscription(target.id);
  if (!playbook || playbook.leadId !== leadId) {
    const err = new Error('renewal playbook not found for this subscription');
    err.code = 'invalid_request';
    throw err;
  }
  const cleanNote = compactText(note, 1000) || 'Customer requested a renewal/subscription change without specifying details.';
  const cleanRequestType = String(requestType || 'change').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32) || 'change';
  const dedupeHash = shortHash(`${playbook.id}|${cleanRequestType}|${cleanNote.toLowerCase()}`);
  const existing = (portalActions.listByLead?.(leadId, { limit: 200, type: 'renewal_change_requested' }) || [])
    .find((row) => row.related_id === playbook.id && row.body?.dedupeHash === dedupeHash);
  if (existing) {
    return {
      ok: true,
      reused: true,
      action: portalActionRow(existing),
      subscription: portalSubscriptionRow(target, playbook, null, [existing]),
      playbook: portalRenewalPlaybookRow(playbook),
      liveSideEffects: false,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      discountApplied: false,
      priceChanged: false,
      checkoutLinkCreated: false,
      operatorReviewRequired: true
    };
  }
  const action = portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'renewal_change_requested',
    status: 'submitted',
    related_type: 'safe_to_renew_playbook',
    related_id: playbook.id,
    body: {
      subscriptionId: target.id,
      playbookId: playbook.id,
      note: cleanNote,
      requestType: cleanRequestType,
      dedupeHash,
      recommendedMotion: playbook.recommendedMotion,
      churnRisk: playbook.churnRisk,
      expectedRetainedRevenueCents: playbook.expectedRetainedRevenueCents,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      discountApplied: false,
      priceChanged: false,
      checkoutLinkCreated: false,
      operatorReviewRequired: true
    },
    metadata: {
      source: 'share_portal',
      noLiveSideEffects: true,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      discountApplied: false,
      priceChanged: false,
      checkoutLinkCreated: false,
      operatorReviewRequired: true
    }
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'customer_renewal_change_requested',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer requested renewal/subscription change',
    body: `${lead.business_name || 'Customer'} requested a renewal change (${cleanRequestType}): ${cleanNote}`,
    metadata: {
      source: 'share_portal',
      portalActionId: action.id,
      subscriptionId: target.id,
      playbookId: playbook.id,
      requestType: cleanRequestType,
      dedupeHash,
      decisionCode: 'portal.renewal_change_requested',
      decisionReason: 'Customer requested an operator-reviewed renewal/subscription change without live subscription mutation.',
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      discountApplied: false,
      priceChanged: false,
      checkoutLinkCreated: false,
      operatorReviewRequired: true
    }
  });
  emit('portal.renewal_change_requested', {
    worker: 'portal',
    leadId,
    portalActionId: action.id,
    subscriptionId: target.id,
    playbookId: playbook.id,
    requestType: cleanRequestType
  });
  return {
    ok: true,
    action: portalActionRow(action),
    subscription: portalSubscriptionRow(target, playbook, null, [action]),
    playbook: portalRenewalPlaybookRow(playbook),
    liveSideEffects: false,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false,
    operatorReviewRequired: true
  };
}

export function summarizeRenewalChangeRequestQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType('renewal_change_requested', { since, limit });
  const byStatus = {};
  const subscriptionMap = new Map();
  let latestAt = null;
  let latestRow = null;
  let pendingCount = 0;
  let submittedCount = 0;
  let resolvedCount = 0;
  let rejectedCount = 0;
  let reviewedCount = 0;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status === 'submitted') submittedCount += 1;
    if (status === 'resolved') resolvedCount += 1;
    if (status === 'rejected') rejectedCount += 1;
    if (status === 'reviewed') reviewedCount += 1;
    if (['submitted', 'pending', 'open'].includes(status) && !row.resolved_at) pendingCount += 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
    const subscriptionId = row.body?.subscriptionId || row.related_id || null;
    if (!subscriptionId) continue;
    const bucket = subscriptionMap.get(subscriptionId) || {
      subscriptionId,
      leadId: row.lead_id,
      playbookId: row.related_id || null,
      requestCount: 0,
      pendingCount: 0,
      latestAt: 0,
      requestTypes: new Set(),
      latestRequestType: null,
      latestStatus: null,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      discountApplied: false,
      priceChanged: false,
      checkoutLinkCreated: false,
      operatorReviewRequired: true
    };
    bucket.requestCount += 1;
    if (['submitted', 'pending', 'open'].includes(status) && !row.resolved_at) bucket.pendingCount += 1;
    if ((row.created_at || 0) > bucket.latestAt) {
      bucket.latestAt = row.created_at || 0;
      bucket.latestRequestType = row.body?.requestType || 'change';
      bucket.latestStatus = status;
    }
    if (row.body?.requestType) bucket.requestTypes.add(row.body.requestType);
    subscriptionMap.set(subscriptionId, bucket);
  }
  const subscriptionsList = Array.from(subscriptionMap.values())
    .sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0))
    .map((row) => ({
      ...row,
      requestTypes: Array.from(row.requestTypes)
    }));
  return {
    total: rows.length,
    pendingCount,
    submittedCount,
    resolvedCount,
    rejectedCount,
    reviewedCount,
    byStatus,
    subscriptionCount: subscriptionsList.length,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          subscriptionId: latestRow.body?.subscriptionId || null,
          playbookId: latestRow.related_id || null,
          requestType: latestRow.body?.requestType || 'change',
          status: latestRow.status,
          createdAt: latestRow.created_at || null
        }
      : null,
    subscriptions: subscriptionsList,
    windowMs,
    generatedAt: now,
    operatorReviewRequired: subscriptionsList.length > 0,
    liveSideEffects: false,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false
  };
}

const RENEWAL_CHANGE_REQUEST_OUTCOMES = new Set(['reviewed', 'resolved', 'rejected']);
const RENEWAL_CHANGE_REQUEST_OUTCOME_STATUS = {
  reviewed: 'reviewed',
  resolved: 'resolved',
  rejected: 'rejected'
};

export function resolveRenewalChangeRequest({
  portalActionId,
  outcome,
  note = '',
  operator = 'operator',
  now = Date.now()
} = {}) {
  if (!portalActionId) {
    const err = new Error('portalActionId required');
    err.code = 'invalid_request';
    throw err;
  }
  const cleanOutcome = String(outcome || '').toLowerCase().trim();
  if (!RENEWAL_CHANGE_REQUEST_OUTCOMES.has(cleanOutcome)) {
    const err = new Error(`outcome must be one of ${Array.from(RENEWAL_CHANGE_REQUEST_OUTCOMES).join(', ')}`);
    err.code = 'invalid_request';
    throw err;
  }
  const existing = portalActions.get(portalActionId);
  if (!existing) {
    const err = new Error(`portal action ${portalActionId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (existing.type !== 'renewal_change_requested') {
    const err = new Error(`portal action ${portalActionId} is not a renewal_change_requested action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  const nextStatus = RENEWAL_CHANGE_REQUEST_OUTCOME_STATUS[cleanOutcome];
  const resolvedAt = cleanOutcome === 'reviewed' ? null : now;
  const cleanNote = compactText(note, 1000);
  const cleanOperator = compactText(operator, 120) || 'operator';
  const reviewHistory = Array.isArray(existing.body?.operatorReviews)
    ? existing.body.operatorReviews.slice()
    : [];
  reviewHistory.push({
    outcome: cleanOutcome,
    note: cleanNote || null,
    operator: cleanOperator,
    reviewedAt: now,
    previousStatus: existing.status
  });
  const safetyFlags = {
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false,
    operatorReviewRequired: cleanOutcome === 'reviewed'
  };
  const nextBody = {
    ...(existing.body || {}),
    // preserve original customer request fields and just append review state
    operatorReviews: reviewHistory,
    latestOperatorReview: {
      outcome: cleanOutcome,
      note: cleanNote || null,
      operator: cleanOperator,
      reviewedAt: now,
      previousStatus: existing.status
    },
    ...safetyFlags
  };
  const nextMetadata = {
    ...(existing.metadata || {}),
    source: existing.metadata?.source || 'share_portal',
    noLiveSideEffects: true,
    ...safetyFlags,
    latestOperatorOutcome: cleanOutcome,
    latestOperatorReviewedAt: now,
    latestOperator: cleanOperator
  };
  const updated = portalActions.updateStatus(portalActionId, {
    status: nextStatus,
    body: nextBody,
    metadata: nextMetadata,
    resolved_at: resolvedAt,
    requireType: 'renewal_change_requested',
    actor: cleanOperator,
    decision_code: `ops.renewal_change_requested.${cleanOutcome}`,
    summary: `Operator ${cleanOperator} marked renewal change request ${portalActionId} as ${cleanOutcome} locally without billing/Stripe/customer-message side effects.`
  });
  contactEvents.add({
    lead_id: existing.lead_id,
    type: 'operator_renewal_change_resolved',
    direction: 'internal',
    channel: 'ops_console',
    subject: `operator ${cleanOutcome} renewal change request`,
    body: cleanNote || `Operator ${cleanOperator} marked the renewal change request ${cleanOutcome} locally.`,
    metadata: {
      source: 'ops_console',
      portalActionId,
      outcome: cleanOutcome,
      operator: cleanOperator,
      previousStatus: existing.status,
      decisionCode: `ops.renewal_change_requested.${cleanOutcome}`,
      decisionReason: 'Operator resolved a portal renewal change request locally without billing, Stripe, subscription, or customer message side effects.',
      ...safetyFlags
    }
  });
  emit('ops.renewal_change_requested.resolved', {
    worker: 'ops',
    leadId: existing.lead_id,
    portalActionId,
    outcome: cleanOutcome,
    previousStatus: existing.status,
    nextStatus
  });
  return {
    ok: true,
    action: portalActionRow(updated),
    previousStatus: existing.status,
    nextStatus,
    outcome: cleanOutcome,
    resolvedAt,
    liveSideEffects: false,
    ...safetyFlags
  };
}

export const RENEWAL_BILLING_PREFLIGHT_ACTION_TYPE = 'renewal_billing_change_preflight';
const RENEWAL_BILLING_PREFLIGHT_SOURCE_STATUS = new Set(['reviewed', 'resolved']);
const RENEWAL_BILLING_PREFLIGHT_CHANGE_TYPES = new Set([
  'pause',
  'resume',
  'downgrade',
  'upgrade',
  'discount',
  'cancel',
  'price_change',
  'plan_change',
  'reduce_scope',
  'extend_term',
  'other'
]);

function normalizeBillingPreflightChangeType(value, fallback = 'other') {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  if (!clean) return fallback;
  if (RENEWAL_BILLING_PREFLIGHT_CHANGE_TYPES.has(clean)) return clean;
  return 'other';
}

export function createRenewalBillingChangePreflight({
  portalActionId,
  proposedChange = {},
  operator = 'operator',
  evidence = {},
  now = Date.now()
} = {}) {
  if (!portalActionId) {
    const err = new Error('portalActionId required');
    err.code = 'invalid_request';
    throw err;
  }
  const existing = portalActions.get(portalActionId);
  if (!existing) {
    const err = new Error(`portal action ${portalActionId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (existing.type !== 'renewal_change_requested') {
    const err = new Error(`portal action ${portalActionId} is not a renewal_change_requested action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  if (!RENEWAL_BILLING_PREFLIGHT_SOURCE_STATUS.has(existing.status)) {
    const err = new Error(
      `renewal change request must be reviewed or resolved before creating a billing preflight packet (status=${existing.status})`
    );
    err.code = 'invalid_request';
    throw err;
  }
  const cleanOperator = compactText(operator, 120) || 'operator';
  const changeType = normalizeBillingPreflightChangeType(
    proposedChange?.type || existing.body?.requestType,
    'other'
  );
  const cleanSummary = compactText(proposedChange?.summary || proposedChange?.notes, 1000) || null;
  const rawTargetPriceCents = Number(proposedChange?.targetPriceCents);
  const targetPriceCents = Number.isFinite(rawTargetPriceCents)
    ? Math.max(0, Math.floor(rawTargetPriceCents))
    : null;
  const targetPlan = compactText(proposedChange?.targetPlan, 120) || null;
  const targetStripePriceId = compactText(
    proposedChange?.targetStripePriceId || proposedChange?.stripePriceId,
    160
  ) || null;
  const rawDurationDays = Number(proposedChange?.durationDays);
  const durationDays = Number.isFinite(rawDurationDays)
    ? Math.max(0, Math.floor(rawDurationDays))
    : null;
  const subscriptionId = existing.body?.subscriptionId || null;
  const playbookId = existing.related_id || existing.body?.playbookId || null;
  const subscriptionRow = subscriptionId
    ? (subscriptions.forLead(existing.lead_id) || []).find((row) => row.id === subscriptionId)
    : null;
  const currentPriceCents = subscriptionRow?.amount_cents ?? null;
  const currentPlan = subscriptionRow?.plan || null;
  const currentStatus = subscriptionRow?.status || null;
  const blockers = [
    'operator_live_approval_required',
    'stripe_subscription_not_mutated',
    'customer_message_not_sent',
    'payment_link_not_created',
    'discount_not_applied',
    'price_not_changed',
    'checkout_link_not_created',
    'portal_broadcast_not_sent'
  ];
  if (changeType === 'price_change' || changeType === 'discount') {
    blockers.push('pricing_policy_review_required');
  }
  if (changeType === 'cancel') {
    blockers.push('cancellation_save_attempt_required');
  }
  const incomingProofRequirements = Array.isArray(evidence?.proofRequirements)
    ? evidence.proofRequirements.map((entry) => compactText(entry, 200)).filter(Boolean)
    : [];
  const proofRequirements = incomingProofRequirements.length
    ? incomingProofRequirements
    : [
        'document_customer_consent_for_change',
        'document_operator_review_of_renewal_change_request',
        'document_post_change_billing_state_target'
      ];
  const evidenceLinks = Array.isArray(evidence?.links)
    ? evidence.links.map((link) => compactText(link, 300)).filter(Boolean).slice(0, 12)
    : [];
  const evidenceNotes = compactText(evidence?.notes, 1000) || null;
  const safetyFlags = {
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false,
    portalBroadcastSent: false,
    providerMutationPerformed: false,
    operatorLiveApprovalRequired: true,
    liveSideEffects: false
  };
  const dedupeHash = shortHash(
    `${portalActionId}|${changeType}|${targetPriceCents ?? ''}|${targetPlan ?? ''}|${targetStripePriceId ?? ''}|${durationDays ?? ''}|${cleanSummary ?? ''}`
  );
  const existingPreflight = (portalActions.listByLead?.(existing.lead_id, {
    limit: 200,
    type: RENEWAL_BILLING_PREFLIGHT_ACTION_TYPE
  }) || []).find((row) => row.related_id === portalActionId && row.body?.dedupeHash === dedupeHash);
  if (existingPreflight) {
    return {
      ok: true,
      reused: true,
      preflight: portalActionRow(existingPreflight),
      sourcePortalActionId: portalActionId,
      subscriptionId,
      playbookId,
      blockers: existingPreflight.body?.blockers || blockers,
      proofRequirements: existingPreflight.body?.proofRequirements || proofRequirements,
      ...safetyFlags
    };
  }
  const body = {
    sourcePortalActionId: portalActionId,
    leadId: existing.lead_id,
    subscriptionId,
    playbookId,
    proposedChange: {
      type: changeType,
      summary: cleanSummary,
      targetPriceCents,
      targetPlan,
      targetStripePriceId,
      durationDays,
      currentPriceCents,
      currentPlan,
      currentStatus
    },
    blockers,
    proofRequirements,
    evidenceLinks,
    evidenceNotes,
    operator: cleanOperator,
    sourceCustomerNote: existing.body?.note || null,
    sourceRequestType: existing.body?.requestType || null,
    sourceStatus: existing.status,
    sourceResolvedAt: existing.resolved_at || null,
    draftedAt: now,
    dedupeHash,
    ...safetyFlags
  };
  const metadata = {
    source: 'ops_console',
    noLiveSideEffects: true,
    sourcePortalActionId: portalActionId,
    subscriptionId,
    playbookId,
    changeType,
    targetStripePriceId,
    operator: cleanOperator,
    ...safetyFlags
  };
  const action = portalActions.add({
    lead_id: existing.lead_id,
    token_id: existing.token_id || null,
    type: RENEWAL_BILLING_PREFLIGHT_ACTION_TYPE,
    status: 'drafted',
    related_type: 'portal_action',
    related_id: portalActionId,
    body,
    metadata,
    actor: cleanOperator,
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_billing_change.preflight_drafted',
    summary: 'Operator drafted a local renewal billing-change preflight packet without billing, Stripe, payment, customer-message, portal-broadcast, or provider side effects.'
  });
  contactEvents.add({
    lead_id: existing.lead_id,
    type: 'operator_renewal_billing_preflight_drafted',
    direction: 'internal',
    channel: 'ops_console',
    subject: `operator drafted renewal billing-change preflight (${changeType})`,
    body: cleanSummary
      || `Operator ${cleanOperator} drafted a local renewal billing-change preflight (${changeType}) without any live billing, Stripe, payment, discount, customer-message, or portal-broadcast action.`,
    metadata: {
      source: 'ops_console',
      portalActionId: action.id,
      sourcePortalActionId: portalActionId,
      subscriptionId,
      playbookId,
      changeType,
      operator: cleanOperator,
      decisionCode: 'ops.renewal_billing_change.preflight_drafted',
      decisionReason: 'Operator drafted a local renewal billing-change preflight packet without billing/Stripe/payment/customer-message/portal-broadcast/provider side effects.',
      ...safetyFlags
    }
  });
  emit('ops.renewal_billing_change.preflight_drafted', {
    worker: 'ops',
    leadId: existing.lead_id,
    portalActionId: action.id,
    sourcePortalActionId: portalActionId,
    subscriptionId,
    playbookId,
    changeType
  });
  return {
    ok: true,
    preflight: portalActionRow(action),
    sourcePortalActionId: portalActionId,
    subscriptionId,
    playbookId,
    blockers,
    proofRequirements,
    ...safetyFlags
  };
}

export function summarizeRenewalBillingChangePreflightQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_BILLING_PREFLIGHT_ACTION_TYPE, { since, limit });
  const byStatus = {};
  const byChangeType = {};
  const subscriptionMap = new Map();
  let latestAt = null;
  let latestRow = null;
  let draftedCount = 0;
  let blockedCount = 0;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status === 'drafted') draftedCount += 1;
    const changeType = row.body?.proposedChange?.type || 'other';
    byChangeType[changeType] = (byChangeType[changeType] || 0) + 1;
    if (Array.isArray(row.body?.blockers) && row.body.blockers.length > 0) blockedCount += 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
    const subscriptionId = row.body?.subscriptionId || null;
    if (!subscriptionId) continue;
    const bucket = subscriptionMap.get(subscriptionId) || {
      subscriptionId,
      leadId: row.lead_id,
      preflightCount: 0,
      latestAt: 0,
      latestChangeType: null,
      latestStatus: null,
      operatorLiveApprovalRequired: true,
      subscriptionChanged: false,
      stripeStateChanged: false,
      customerMessageSent: false,
      paymentLinkCreated: false,
      discountApplied: false,
      priceChanged: false,
      checkoutLinkCreated: false,
      portalBroadcastSent: false
    };
    bucket.preflightCount += 1;
    if ((row.created_at || 0) > bucket.latestAt) {
      bucket.latestAt = row.created_at || 0;
      bucket.latestChangeType = row.body?.proposedChange?.type || 'other';
      bucket.latestStatus = status;
    }
    subscriptionMap.set(subscriptionId, bucket);
  }
  const subscriptionsList = Array.from(subscriptionMap.values()).sort(
    (a, b) => (b.latestAt || 0) - (a.latestAt || 0)
  );
  return {
    total: rows.length,
    draftedCount,
    blockedCount,
    byStatus,
    byChangeType,
    subscriptionCount: subscriptionsList.length,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          subscriptionId: latestRow.body?.subscriptionId || null,
          sourcePortalActionId: latestRow.related_id || latestRow.body?.sourcePortalActionId || null,
          changeType: latestRow.body?.proposedChange?.type || 'other',
          status: latestRow.status,
          createdAt: latestRow.created_at || null
        }
      : null,
    subscriptions: subscriptionsList,
    windowMs,
    generatedAt: now,
    operatorLiveApprovalRequired: subscriptionsList.length > 0,
    liveSideEffects: false,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false,
    portalBroadcastSent: false,
    providerMutationPerformed: false
  };
}

export const RENEWAL_BILLING_EXECUTION_RECEIPT_ACTION_TYPE = 'renewal_billing_change_execution_receipt';
const RENEWAL_BILLING_LIVE_SMOKE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RENEWAL_BILLING_PRICE_CHANGE_TYPES = new Set(['discount', 'downgrade', 'upgrade', 'price_change', 'plan_change']);

function renewalBillingChangeExecutionSafety({
  preflight,
  subscriptionRow,
  targetStripePriceId,
  live = false,
  operatorApproval = false,
  billingChangeApproved = false,
  customerConsentDocumented = false,
  pricingPolicyReviewed = false,
  now = Date.now()
} = {}) {
  const blockers = [];
  const proposedChange = preflight?.body?.proposedChange || {};
  const changeType = proposedChange.type || 'other';
  const priceSensitive = RENEWAL_BILLING_PRICE_CHANGE_TYPES.has(changeType);
  const configured = stripeConfigured();
  if (live !== true) blockers.push('live_execution_not_requested');
  if (operatorApproval !== true) blockers.push('operator_live_approval_required');
  if (billingChangeApproved !== true) blockers.push('billing_change_approval_required');
  if (customerConsentDocumented !== true) blockers.push('customer_consent_required');
  if (priceSensitive && pricingPolicyReviewed !== true) blockers.push('pricing_policy_review_required');
  if (!subscriptionRow) blockers.push('subscription_not_found');
  if (subscriptionRow && !subscriptionRow.stripe_subscription_id) blockers.push('stripe_subscription_id_missing');
  if (priceSensitive && !targetStripePriceId) blockers.push('target_stripe_price_id_required');
  if (!canPay()) blockers.push('stripe_side_effect_gate_closed');
  if (!configured.configured) blockers.push('stripe_config_missing');
  const liveSmoke = providerSmoke.latestEvent({ provider: 'stripe', live: true, statuses: ['ok'] });
  if (!liveSmoke?.checkedAt) {
    blockers.push('stripe_live_smoke_missing');
  } else if (Math.max(0, now - liveSmoke.checkedAt) > RENEWAL_BILLING_LIVE_SMOKE_MAX_AGE_MS) {
    blockers.push('stripe_live_smoke_stale');
  }
  return { blockers, changeType, priceSensitive, liveSmoke };
}

export async function executeRenewalBillingChangePreflight({
  preflightId,
  operator = 'operator',
  live = false,
  operatorApproval = false,
  billingChangeApproved = false,
  customerConsentDocumented = false,
  pricingPolicyReviewed = false,
  targetStripePriceId = null,
  now = Date.now()
} = {}) {
  if (!preflightId) {
    const err = new Error('preflightId required');
    err.code = 'invalid_request';
    throw err;
  }
  const preflight = portalActions.get(preflightId);
  if (!preflight) {
    const err = new Error(`billing-change preflight ${preflightId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (preflight.type !== RENEWAL_BILLING_PREFLIGHT_ACTION_TYPE) {
    const err = new Error(`portal action ${preflightId} is not a renewal_billing_change_preflight action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  const cleanOperator = compactText(operator, 120) || 'operator';
  const proposedChange = preflight.body?.proposedChange || {};
  const cleanTargetStripePriceId = compactText(targetStripePriceId || proposedChange.targetStripePriceId, 160) || null;
  const subscriptionId = preflight.body?.subscriptionId || null;
  const playbookId = preflight.body?.playbookId || null;
  const sourcePortalActionId = preflight.related_id || preflight.body?.sourcePortalActionId || null;
  const subscriptionRow = subscriptionId
    ? (subscriptions.forLead(preflight.lead_id) || []).find((row) => row.id === subscriptionId)
    : null;
  const safety = renewalBillingChangeExecutionSafety({
    preflight,
    subscriptionRow,
    targetStripePriceId: cleanTargetStripePriceId,
    live,
    operatorApproval,
    billingChangeApproved,
    customerConsentDocumented,
    pricingPolicyReviewed,
    now
  });
  const priceChanged = safety.priceSensitive && Boolean(cleanTargetStripePriceId);
  const discountApplied = safety.changeType === 'discount' && Boolean(cleanTargetStripePriceId);
  const baseNoSendFlags = {
    customerMessageSent: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    portalBroadcastSent: false
  };
  const dedupeHash = shortHash(
    `${preflightId}|${live ? 'live' : 'dry'}|${operatorApproval ? 'approved' : 'unapproved'}|${billingChangeApproved ? 'billing' : 'nobilling'}|${customerConsentDocumented ? 'consent' : 'noconsent'}|${pricingPolicyReviewed ? 'pricing' : 'nopricing'}|${cleanTargetStripePriceId || ''}`
  );
  const existingReceipt = (portalActions.listByLead?.(preflight.lead_id, {
    limit: 200,
    type: RENEWAL_BILLING_EXECUTION_RECEIPT_ACTION_TYPE
  }) || []).find((row) => row.related_id === preflightId && row.body?.dedupeHash === dedupeHash);
  if (existingReceipt) {
    const applied = existingReceipt.status === 'applied';
    const priorBlockers = existingReceipt.body?.blockers || [];
    const blockersUnchanged = JSON.stringify(priorBlockers) === JSON.stringify(safety.blockers);
    if (applied || (existingReceipt.status === 'blocked_live_preflight' && blockersUnchanged)) {
      return {
        ok: applied,
        reused: true,
        status: existingReceipt.status,
        receipt: portalActionRow(existingReceipt),
        preflightId,
        sourcePortalActionId,
        subscriptionId,
        blockers: priorBlockers,
        subscriptionChanged: applied,
        stripeStateChanged: applied,
        providerMutationPerformed: applied,
        liveSideEffects: applied,
        priceChanged: applied && existingReceipt.body?.priceChanged === true,
        discountApplied: applied && existingReceipt.body?.discountApplied === true,
        ...baseNoSendFlags
      };
    }
  }
  const blocked = safety.blockers.length > 0;
  if (blocked) {
    const body = {
      preflightId,
      sourcePortalActionId,
      leadId: preflight.lead_id,
      subscriptionId,
      playbookId,
      provider: 'stripe',
      changeType: safety.changeType,
      targetStripePriceId: cleanTargetStripePriceId,
      blockers: safety.blockers,
      liveRequested: live === true,
      operatorApproval: operatorApproval === true,
      billingChangeApproved: billingChangeApproved === true,
      customerConsentDocumented: customerConsentDocumented === true,
      pricingPolicyReviewed: pricingPolicyReviewed === true,
      liveSmokeCheckedAt: safety.liveSmoke?.checkedAt || null,
      status: 'blocked_live_preflight',
      dedupeHash,
      subscriptionChanged: false,
      stripeStateChanged: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      priceChanged: false,
      discountApplied: false,
      ...baseNoSendFlags
    };
    const metadata = {
      source: 'ops_console',
      noLiveSideEffects: true,
      preflightId,
      sourcePortalActionId,
      subscriptionId,
      provider: 'stripe',
      operator: cleanOperator,
      blockers: safety.blockers,
      ...body
    };
    const receipt = portalActions.add({
      lead_id: preflight.lead_id,
      token_id: preflight.token_id || null,
      type: RENEWAL_BILLING_EXECUTION_RECEIPT_ACTION_TYPE,
      status: 'blocked_live_preflight',
      related_type: 'portal_action',
      related_id: preflightId,
      body,
      metadata,
      actor: cleanOperator,
      channel: 'ops_console',
      direction: 'internal',
      decision_code: 'ops.renewal_billing_change.execution_blocked',
      summary: 'Renewal billing-change execution stayed blocked before any Stripe subscription mutation.'
    });
    contactEvents.add({
      lead_id: preflight.lead_id,
      type: 'operator_renewal_billing_change_execution_blocked',
      direction: 'internal',
      channel: 'ops_console',
      subject: 'renewal billing-change execution blocked',
      body: `Renewal billing-change execution stayed blocked: ${safety.blockers.join(', ')}`,
      metadata
    });
    emit('ops.renewal_billing_change.execution_blocked', {
      worker: 'ops',
      leadId: preflight.lead_id,
      portalActionId: receipt.id,
      preflightId,
      sourcePortalActionId,
      subscriptionId,
      blockers: safety.blockers
    });
    return {
      ok: false,
      status: 'blocked_live_preflight',
      receipt: portalActionRow(receipt),
      preflightId,
      sourcePortalActionId,
      subscriptionId,
      blockers: safety.blockers,
      subscriptionChanged: false,
      stripeStateChanged: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      priceChanged: false,
      discountApplied: false,
      ...baseNoSendFlags
    };
  }

  let providerResult;
  try {
    providerResult = await applyStripeSubscriptionChange({
      stripeSubscriptionId: subscriptionRow.stripe_subscription_id,
      changeType: safety.changeType,
      targetStripePriceId: cleanTargetStripePriceId,
      idempotencyKey: `renewal_billing_change:${preflightId}:${dedupeHash}`,
      metadata: {
        leadId: preflight.lead_id,
        subscriptionId,
        portalActionId: sourcePortalActionId,
        preflightId
      }
    });
  } catch (err) {
    recordProviderRuntimeIncident({
      provider: 'stripe',
      error: err,
      action: 'renewal_billing_change_execution',
      worker: 'ops',
      leadId: preflight.lead_id,
      eventId: preflightId,
      now
    });
    const body = {
      preflightId,
      sourcePortalActionId,
      leadId: preflight.lead_id,
      subscriptionId,
      playbookId,
      provider: 'stripe',
      changeType: safety.changeType,
      targetStripePriceId: cleanTargetStripePriceId,
      status: 'failed_provider',
      error: err?.message || String(err),
      dedupeHash,
      subscriptionChanged: false,
      stripeStateChanged: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      priceChanged: false,
      discountApplied: false,
      ...baseNoSendFlags
    };
    const receipt = portalActions.add({
      lead_id: preflight.lead_id,
      token_id: preflight.token_id || null,
      type: RENEWAL_BILLING_EXECUTION_RECEIPT_ACTION_TYPE,
      status: 'failed_provider',
      related_type: 'portal_action',
      related_id: preflightId,
      body,
      metadata: { source: 'ops_console', provider: 'stripe', operator: cleanOperator, error: body.error },
      actor: cleanOperator,
      channel: 'ops_console',
      direction: 'internal',
      decision_code: 'ops.renewal_billing_change.execution_failed',
      summary: 'Renewal billing-change execution reached Stripe but failed; runtime incident was recorded.'
    });
    contactEvents.add({
      lead_id: preflight.lead_id,
      type: 'operator_renewal_billing_change_execution_failed',
      direction: 'internal',
      channel: 'ops_console',
      subject: 'renewal billing-change execution failed',
      body: `Renewal billing-change execution reached Stripe but failed: ${body.error}`,
      metadata: {
        source: 'ops_console',
        portalActionId: receipt.id,
        preflightId,
        sourcePortalActionId,
        subscriptionId,
        provider: 'stripe',
        operator: cleanOperator,
        error: body.error,
        subscriptionChanged: false,
        stripeStateChanged: false,
        providerMutationPerformed: false,
        liveSideEffects: false,
        priceChanged: false,
        discountApplied: false,
        ...baseNoSendFlags
      }
    });
    emit('ops.renewal_billing_change.execution_failed', {
      worker: 'ops',
      leadId: preflight.lead_id,
      portalActionId: receipt.id,
      preflightId,
      sourcePortalActionId,
      subscriptionId,
      error: body.error
    });
    return {
      ok: false,
      status: 'failed_provider',
      receipt: portalActionRow(receipt),
      preflightId,
      sourcePortalActionId,
      subscriptionId,
      error: body.error,
      subscriptionChanged: false,
      stripeStateChanged: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      priceChanged: false,
      discountApplied: false,
      ...baseNoSendFlags
    };
  }

  const targetPriceCents = Number.isFinite(Number(proposedChange.targetPriceCents))
    ? Math.max(0, Math.floor(Number(proposedChange.targetPriceCents)))
    : subscriptionRow.amount_cents;
  const updatedSubscription = subscriptions.upsert({
    id: subscriptionRow.id,
    lead_id: subscriptionRow.lead_id,
    stripe_subscription_id: subscriptionRow.stripe_subscription_id,
    stripe_customer_id: subscriptionRow.stripe_customer_id,
    stripe_price_id: providerResult?.stripePriceId || cleanTargetStripePriceId || subscriptionRow.stripe_price_id,
    status: providerResult?.status || subscriptionRow.status,
    plan: proposedChange.targetPlan || subscriptionRow.plan,
    amount_cents: targetPriceCents,
    currency: subscriptionRow.currency || 'usd',
    started_at: subscriptionRow.started_at || null,
    canceled_at: safety.changeType === 'cancel' ? (providerResult?.currentPeriodEnd || subscriptionRow.canceled_at || null) : (subscriptionRow.canceled_at || null),
    metadata: {
      ...(safeJson(subscriptionRow.metadata_json) || {}),
      renewalBillingChange: {
        preflightId,
        sourcePortalActionId,
        changeType: safety.changeType,
        appliedAt: now,
        provider: 'stripe'
      }
    }
  });
  const body = {
    preflightId,
    sourcePortalActionId,
    leadId: preflight.lead_id,
    subscriptionId,
    playbookId,
    provider: 'stripe',
    changeType: safety.changeType,
    targetStripePriceId: cleanTargetStripePriceId,
    providerResult,
    updatedSubscription,
    status: 'applied',
    appliedAt: now,
    dedupeHash,
    subscriptionChanged: true,
    stripeStateChanged: true,
    providerMutationPerformed: true,
    liveSideEffects: true,
    priceChanged,
    discountApplied,
    ...baseNoSendFlags
  };
  const receipt = portalActions.add({
    lead_id: preflight.lead_id,
    token_id: preflight.token_id || null,
    type: RENEWAL_BILLING_EXECUTION_RECEIPT_ACTION_TYPE,
    status: 'applied',
    related_type: 'portal_action',
    related_id: preflightId,
    body,
    metadata: { source: 'ops_console', provider: 'stripe', operator: cleanOperator, providerResult },
    actor: cleanOperator,
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_billing_change.applied',
    summary: 'Operator-approved renewal billing change was applied through Stripe after live preflight passed.'
  });
  contactEvents.add({
    lead_id: preflight.lead_id,
    type: 'operator_renewal_billing_change_applied',
    direction: 'internal',
    channel: 'ops_console',
    subject: `renewal billing change applied (${safety.changeType})`,
    body: `Operator-approved renewal billing change was applied through Stripe for subscription ${subscriptionId}.`,
    metadata: {
      source: 'ops_console',
      portalActionId: receipt.id,
      preflightId,
      sourcePortalActionId,
      subscriptionId,
      provider: 'stripe',
      ...body
    }
  });
  emit('ops.renewal_billing_change.applied', {
    worker: 'ops',
    leadId: preflight.lead_id,
    portalActionId: receipt.id,
    preflightId,
    sourcePortalActionId,
    subscriptionId,
    stripeSubscriptionId: subscriptionRow.stripe_subscription_id
  });
  return {
    ok: true,
    status: 'applied',
    receipt: portalActionRow(receipt),
    preflightId,
    sourcePortalActionId,
    subscriptionId,
    providerResult,
    subscription: updatedSubscription,
    subscriptionChanged: true,
    stripeStateChanged: true,
    providerMutationPerformed: true,
    liveSideEffects: true,
    priceChanged,
    discountApplied,
    ...baseNoSendFlags
  };
}

export function summarizeRenewalBillingExecutionReceiptQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_BILLING_EXECUTION_RECEIPT_ACTION_TYPE, { since, limit });
  const byStatus = {};
  let latestAt = null;
  let latestRow = null;
  let blockedCount = 0;
  let appliedCount = 0;
  let failedCount = 0;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status === 'blocked_live_preflight') blockedCount += 1;
    if (status === 'applied') appliedCount += 1;
    if (status === 'failed_provider') failedCount += 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
  }
  return {
    total: rows.length,
    blockedCount,
    appliedCount,
    failedCount,
    byStatus,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          preflightId: latestRow.related_id || latestRow.body?.preflightId || null,
          subscriptionId: latestRow.body?.subscriptionId || null,
          sourcePortalActionId: latestRow.body?.sourcePortalActionId || null,
          changeType: latestRow.body?.changeType || null,
          status: latestRow.status,
          provider: latestRow.body?.provider || null,
          createdAt: latestRow.created_at || null
        }
      : null,
    windowMs,
    generatedAt: now,
    subscriptionChanged: appliedCount > 0,
    stripeStateChanged: appliedCount > 0,
    providerMutationPerformed: appliedCount > 0,
    liveSideEffects: appliedCount > 0,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    customerMessageSent: false,
    priceChanged: rows.some((row) => row.status === 'applied' && row.body?.priceChanged === true),
    discountApplied: rows.some((row) => row.status === 'applied' && row.body?.discountApplied === true)
  };
}

export const RENEWAL_CUSTOMER_MESSAGE_PREFLIGHT_ACTION_TYPE = 'renewal_customer_message_preflight';
const RENEWAL_CUSTOMER_MESSAGE_PREFLIGHT_SOURCE_STATUS = new Set(['reviewed', 'resolved']);
const RENEWAL_CUSTOMER_MESSAGE_CHANNELS = new Set(['email', 'sms', 'portal', 'phone_script', 'none']);

function normalizeCustomerMessageChannel(value) {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  if (!clean) return 'email';
  if (RENEWAL_CUSTOMER_MESSAGE_CHANNELS.has(clean)) return clean;
  return 'email';
}

export function createRenewalCustomerMessagePreflight({
  portalActionId,
  billingPreflightId = null,
  messageDraft = {},
  operator = 'operator',
  evidence = {},
  now = Date.now()
} = {}) {
  if (!portalActionId) {
    const err = new Error('portalActionId required');
    err.code = 'invalid_request';
    throw err;
  }
  const sourceAction = portalActions.get(portalActionId);
  if (!sourceAction) {
    const err = new Error(`portal action ${portalActionId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (sourceAction.type !== 'renewal_change_requested') {
    const err = new Error(`portal action ${portalActionId} is not a renewal_change_requested action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  if (!RENEWAL_CUSTOMER_MESSAGE_PREFLIGHT_SOURCE_STATUS.has(sourceAction.status)) {
    const err = new Error(
      `renewal change request must be reviewed or resolved before creating a customer-message preflight packet (status=${sourceAction.status})`
    );
    err.code = 'invalid_request';
    throw err;
  }
  let billingPreflight = null;
  if (billingPreflightId) {
    billingPreflight = portalActions.get(billingPreflightId);
    if (!billingPreflight) {
      const err = new Error(`billing preflight ${billingPreflightId} not found`);
      err.code = 'portal_action_not_found';
      throw err;
    }
    if (billingPreflight.type !== RENEWAL_BILLING_PREFLIGHT_ACTION_TYPE) {
      const err = new Error(`portal action ${billingPreflightId} is not a renewal_billing_change_preflight action`);
      err.code = 'portal_action_type_mismatch';
      throw err;
    }
    const linkedSourceId = billingPreflight.related_id || billingPreflight.body?.sourcePortalActionId || null;
    if (linkedSourceId !== portalActionId) {
      const err = new Error(`billing preflight ${billingPreflightId} does not belong to renewal change request ${portalActionId}`);
      err.code = 'invalid_request';
      throw err;
    }
  } else {
    billingPreflight = (portalActions.listByLead?.(sourceAction.lead_id, {
      limit: 200,
      type: RENEWAL_BILLING_PREFLIGHT_ACTION_TYPE
    }) || []).find((row) => row.related_id === portalActionId || row.body?.sourcePortalActionId === portalActionId) || null;
  }
  const cleanOperator = compactText(operator, 120) || 'operator';
  const channel = normalizeCustomerMessageChannel(messageDraft?.channel);
  const subject = compactText(messageDraft?.subject || messageDraft?.title, 240) || 'Renewal update';
  const bodyText = compactText(messageDraft?.body || messageDraft?.message || messageDraft?.notes, 2_400)
    || 'Draft renewal update for operator review before any customer message is sent.';
  const callToAction = compactText(messageDraft?.callToAction || messageDraft?.cta, 500) || null;
  const audience = compactText(messageDraft?.audience, 120) || 'renewal_customer';
  const subscriptionId = sourceAction.body?.subscriptionId || billingPreflight?.body?.subscriptionId || null;
  const playbookId = sourceAction.related_id || sourceAction.body?.playbookId || billingPreflight?.body?.playbookId || null;
  const subscriptionRow = subscriptionId
    ? (subscriptions.forLead(sourceAction.lead_id) || []).find((row) => row.id === subscriptionId)
    : null;
  const blockers = [
    'operator_live_approval_required',
    'customer_message_not_sent',
    'agentmail_live_smoke_required',
    'customer_consent_required',
    'message_copy_review_required',
    'compliance_policy_review_required',
    'subscription_not_mutated',
    'stripe_subscription_not_mutated',
    'payment_link_not_created',
    'checkout_link_not_created',
    'discount_not_applied',
    'price_not_changed',
    'portal_broadcast_not_sent'
  ];
  if (billingPreflight) blockers.push('billing_preflight_linked');
  if (channel === 'sms') blockers.push('sms_compliance_review_required', 'sms_provider_adapter_required');
  if (channel === 'portal') blockers.push('portal_broadcast_adapter_required');
  if (channel === 'phone_script') blockers.push('agentphone_live_smoke_required', 'call_script_review_required');
  const incomingProofRequirements = Array.isArray(evidence?.proofRequirements)
    ? evidence.proofRequirements.map((entry) => compactText(entry, 200)).filter(Boolean)
    : [];
  const proofRequirements = incomingProofRequirements.length
    ? incomingProofRequirements
    : [
        'document_customer_consent_for_message',
        'document_operator_review_of_message_copy',
        'document_fresh_agentmail_live_smoke_before_send'
      ];
  const evidenceLinks = Array.isArray(evidence?.links)
    ? evidence.links.map((link) => compactText(link, 300)).filter(Boolean).slice(0, 12)
    : [];
  const evidenceNotes = compactText(evidence?.notes, 1000) || null;
  const safetyFlags = {
    customerMessageSent: false,
    agentMailMessageSent: false,
    smsMessageSent: false,
    portalBroadcastSent: false,
    phoneCallPlaced: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false,
    providerMutationPerformed: false,
    operatorLiveApprovalRequired: true,
    liveSideEffects: false
  };
  const dedupeHash = shortHash(
    `${portalActionId}|${billingPreflight?.id || ''}|${channel}|${subject}|${bodyText}|${callToAction || ''}`
  );
  const existingPreflight = (portalActions.listByLead?.(sourceAction.lead_id, {
    limit: 200,
    type: RENEWAL_CUSTOMER_MESSAGE_PREFLIGHT_ACTION_TYPE
  }) || []).find((row) => row.related_id === portalActionId && row.body?.dedupeHash === dedupeHash);
  if (existingPreflight) {
    return {
      ok: true,
      reused: true,
      preflight: portalActionRow(existingPreflight),
      sourcePortalActionId: portalActionId,
      billingPreflightId: billingPreflight?.id || existingPreflight.body?.billingPreflightId || null,
      subscriptionId,
      playbookId,
      blockers: existingPreflight.body?.blockers || blockers,
      proofRequirements: existingPreflight.body?.proofRequirements || proofRequirements,
      ...safetyFlags
    };
  }
  const body = {
    sourcePortalActionId: portalActionId,
    billingPreflightId: billingPreflight?.id || null,
    leadId: sourceAction.lead_id,
    subscriptionId,
    playbookId,
    messageDraft: {
      channel,
      subject,
      body: bodyText,
      callToAction,
      audience,
      sourceRequestType: sourceAction.body?.requestType || null,
      sourceBillingChangeType: billingPreflight?.body?.proposedChange?.type || null
    },
    currentSubscription: subscriptionRow
      ? {
          status: subscriptionRow.status || null,
          plan: subscriptionRow.plan || null,
          amountCents: subscriptionRow.amount_cents ?? null,
          currency: subscriptionRow.currency || null
        }
      : null,
    blockers,
    proofRequirements,
    evidenceLinks,
    evidenceNotes,
    operator: cleanOperator,
    sourceCustomerNote: sourceAction.body?.note || null,
    sourceStatus: sourceAction.status,
    sourceResolvedAt: sourceAction.resolved_at || null,
    billingPreflightStatus: billingPreflight?.status || null,
    draftedAt: now,
    dedupeHash,
    ...safetyFlags
  };
  const metadata = {
    source: 'ops_console',
    noLiveSideEffects: true,
    sourcePortalActionId: portalActionId,
    billingPreflightId: billingPreflight?.id || null,
    subscriptionId,
    playbookId,
    channel,
    operator: cleanOperator,
    ...safetyFlags
  };
  const action = portalActions.add({
    lead_id: sourceAction.lead_id,
    token_id: sourceAction.token_id || null,
    type: RENEWAL_CUSTOMER_MESSAGE_PREFLIGHT_ACTION_TYPE,
    status: 'blocked_live_preflight',
    related_type: 'portal_action',
    related_id: portalActionId,
    body,
    metadata,
    actor: cleanOperator,
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_customer_message.preflight_drafted',
    summary: 'Operator drafted a blocked renewal customer-message preflight without sending email, SMS, portal broadcast, phone call, billing mutation, or provider side effects.'
  });
  contactEvents.add({
    lead_id: sourceAction.lead_id,
    type: 'operator_renewal_customer_message_preflight_drafted',
    direction: 'internal',
    channel: 'ops_console',
    subject: `operator drafted renewal customer-message preflight (${channel})`,
    body: `Operator ${cleanOperator} drafted renewal message copy for preflight only. No customer message or provider mutation was sent.`,
    metadata: {
      source: 'ops_console',
      portalActionId: action.id,
      sourcePortalActionId: portalActionId,
      billingPreflightId: billingPreflight?.id || null,
      subscriptionId,
      playbookId,
      channel,
      operator: cleanOperator,
      decisionCode: 'ops.renewal_customer_message.preflight_drafted',
      decisionReason: 'Operator drafted a local renewal customer-message preflight packet without email/SMS/portal/phone/customer-message/provider/billing side effects.',
      ...safetyFlags
    }
  });
  emit('ops.renewal_customer_message.preflight_drafted', {
    worker: 'ops',
    leadId: sourceAction.lead_id,
    portalActionId: action.id,
    sourcePortalActionId: portalActionId,
    billingPreflightId: billingPreflight?.id || null,
    subscriptionId,
    playbookId,
    channel
  });
  return {
    ok: true,
    preflight: portalActionRow(action),
    sourcePortalActionId: portalActionId,
    billingPreflightId: billingPreflight?.id || null,
    subscriptionId,
    playbookId,
    channel,
    blockers,
    proofRequirements,
    ...safetyFlags
  };
}

export function summarizeRenewalCustomerMessagePreflightQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_CUSTOMER_MESSAGE_PREFLIGHT_ACTION_TYPE, { since, limit });
  const byStatus = {};
  const byChannel = {};
  const subscriptionMap = new Map();
  let latestAt = null;
  let latestRow = null;
  let blockedCount = 0;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status === 'blocked_live_preflight' || (Array.isArray(row.body?.blockers) && row.body.blockers.length > 0)) {
      blockedCount += 1;
    }
    const channel = row.body?.messageDraft?.channel || 'email';
    byChannel[channel] = (byChannel[channel] || 0) + 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
    const subscriptionId = row.body?.subscriptionId || null;
    if (!subscriptionId) continue;
    const bucket = subscriptionMap.get(subscriptionId) || {
      subscriptionId,
      leadId: row.lead_id,
      preflightCount: 0,
      latestAt: 0,
      latestChannel: null,
      latestStatus: null,
      customerMessageSent: false,
      agentMailMessageSent: false,
      smsMessageSent: false,
      portalBroadcastSent: false,
      phoneCallPlaced: false,
      subscriptionChanged: false,
      stripeStateChanged: false
    };
    bucket.preflightCount += 1;
    if ((row.created_at || 0) > bucket.latestAt) {
      bucket.latestAt = row.created_at || 0;
      bucket.latestChannel = channel;
      bucket.latestStatus = status;
    }
    subscriptionMap.set(subscriptionId, bucket);
  }
  const subscriptionsList = Array.from(subscriptionMap.values()).sort(
    (a, b) => (b.latestAt || 0) - (a.latestAt || 0)
  );
  return {
    total: rows.length,
    blockedCount,
    byStatus,
    byChannel,
    subscriptionCount: subscriptionsList.length,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          subscriptionId: latestRow.body?.subscriptionId || null,
          sourcePortalActionId: latestRow.related_id || latestRow.body?.sourcePortalActionId || null,
          billingPreflightId: latestRow.body?.billingPreflightId || null,
          channel: latestRow.body?.messageDraft?.channel || 'email',
          status: latestRow.status,
          createdAt: latestRow.created_at || null
        }
      : null,
    subscriptions: subscriptionsList,
    windowMs,
    generatedAt: now,
    operatorLiveApprovalRequired: subscriptionsList.length > 0,
    liveSideEffects: false,
    customerMessageSent: false,
    agentMailMessageSent: false,
    smsMessageSent: false,
    portalBroadcastSent: false,
    phoneCallPlaced: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false,
    providerMutationPerformed: false
  };
}

export const RENEWAL_CUSTOMER_MESSAGE_SEND_RECEIPT_ACTION_TYPE = 'renewal_customer_message_send_receipt';
const RENEWAL_MESSAGE_LIVE_SMOKE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function renewalCustomerMessageExecutionSafety({
  preflight,
  targetEmail,
  live = false,
  operatorApproval = false,
  messageCopyApproved = false,
  customerConsentDocumented = false,
  now = Date.now()
} = {}) {
  const blockers = [];
  const channel = preflight?.body?.messageDraft?.channel || 'email';
  if (channel !== 'email') blockers.push('agentmail_adapter_supports_email_only');
  if (live !== true) blockers.push('live_execution_not_requested');
  if (operatorApproval !== true) blockers.push('operator_live_approval_required');
  if (messageCopyApproved !== true) blockers.push('message_copy_approval_required');
  if (customerConsentDocumented !== true) blockers.push('customer_consent_required');
  if (!targetEmail) blockers.push('target_email_required');
  if (targetEmail && !canEmail(targetEmail)) blockers.push('email_side_effect_gate_closed');
  if (!env.agentmail?.apiKey || !env.agentmail?.inboxId) blockers.push('agentmail_config_missing');
  const liveSmoke = providerSmoke.latestEvent({ provider: 'agentmail', live: true, statuses: ['ok'] });
  if (!liveSmoke?.checkedAt) {
    blockers.push('agentmail_live_smoke_missing');
  } else if (Math.max(0, now - liveSmoke.checkedAt) > RENEWAL_MESSAGE_LIVE_SMOKE_MAX_AGE_MS) {
    blockers.push('agentmail_live_smoke_stale');
  }
  return { blockers, channel, liveSmoke };
}

export async function executeRenewalCustomerMessagePreflight({
  preflightId,
  targetEmail = '',
  operator = 'operator',
  live = false,
  operatorApproval = false,
  messageCopyApproved = false,
  customerConsentDocumented = false,
  now = Date.now()
} = {}) {
  if (!preflightId) {
    const err = new Error('preflightId required');
    err.code = 'invalid_request';
    throw err;
  }
  const preflight = portalActions.get(preflightId);
  if (!preflight) {
    const err = new Error(`customer-message preflight ${preflightId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (preflight.type !== RENEWAL_CUSTOMER_MESSAGE_PREFLIGHT_ACTION_TYPE) {
    const err = new Error(`portal action ${preflightId} is not a renewal_customer_message_preflight action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  const cleanOperator = compactText(operator, 120) || 'operator';
  const cleanTargetEmail = compactText(targetEmail, 240) || null;
  const safety = renewalCustomerMessageExecutionSafety({
    preflight,
    targetEmail: cleanTargetEmail,
    live,
    operatorApproval,
    messageCopyApproved,
    customerConsentDocumented,
    now
  });
  const messageDraft = preflight.body?.messageDraft || {};
  const subscriptionId = preflight.body?.subscriptionId || null;
  const playbookId = preflight.body?.playbookId || null;
  const sourcePortalActionId = preflight.related_id || preflight.body?.sourcePortalActionId || null;
  const billingPreflightId = preflight.body?.billingPreflightId || null;
  const baseSafetyFlags = {
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false
  };
  const dedupeHash = shortHash(
    `${preflightId}|${cleanTargetEmail || ''}|${live ? 'live' : 'dry'}|${operatorApproval ? 'approved' : 'unapproved'}|${messageCopyApproved ? 'copy' : 'nocopy'}|${customerConsentDocumented ? 'consent' : 'noconsent'}`
  );
  const existingReceipt = (portalActions.listByLead?.(preflight.lead_id, {
    limit: 200,
    type: RENEWAL_CUSTOMER_MESSAGE_SEND_RECEIPT_ACTION_TYPE
  }) || []).find((row) => row.related_id === preflightId && row.body?.dedupeHash === dedupeHash);
  if (existingReceipt) {
    const sent = existingReceipt.status === 'sent';
    const priorBlockers = existingReceipt.body?.blockers || [];
    const blockersUnchanged = JSON.stringify(priorBlockers) === JSON.stringify(safety.blockers);
    if (sent || (existingReceipt.status === 'blocked_live_preflight' && blockersUnchanged)) {
      return {
        ok: sent,
        reused: true,
        status: existingReceipt.status,
        receipt: portalActionRow(existingReceipt),
        preflightId,
        sourcePortalActionId,
        billingPreflightId,
        subscriptionId,
        blockers: priorBlockers,
        customerMessageSent: sent,
        agentMailMessageSent: sent,
        providerMutationPerformed: sent,
        liveSideEffects: sent,
        ...baseSafetyFlags
      };
    }
  }
  const blocked = safety.blockers.length > 0;
  if (blocked) {
    const body = {
      preflightId,
      sourcePortalActionId,
      billingPreflightId,
      leadId: preflight.lead_id,
      subscriptionId,
      playbookId,
      channel: safety.channel,
      targetEmail: cleanTargetEmail,
      messageSubject: messageDraft.subject || null,
      blockers: safety.blockers,
      provider: 'agentmail',
      liveRequested: live === true,
      operatorApproval: operatorApproval === true,
      messageCopyApproved: messageCopyApproved === true,
      customerConsentDocumented: customerConsentDocumented === true,
      liveSmokeCheckedAt: safety.liveSmoke?.checkedAt || null,
      status: 'blocked_live_preflight',
      dedupeHash,
      customerMessageSent: false,
      agentMailMessageSent: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      ...baseSafetyFlags
    };
    const metadata = {
      source: 'ops_console',
      noLiveSideEffects: true,
      preflightId,
      sourcePortalActionId,
      billingPreflightId,
      subscriptionId,
      channel: safety.channel,
      provider: 'agentmail',
      operator: cleanOperator,
      blockers: safety.blockers,
      customerMessageSent: false,
      agentMailMessageSent: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      ...baseSafetyFlags
    };
    const receipt = portalActions.add({
      lead_id: preflight.lead_id,
      token_id: preflight.token_id || null,
      type: RENEWAL_CUSTOMER_MESSAGE_SEND_RECEIPT_ACTION_TYPE,
      status: 'blocked_live_preflight',
      related_type: 'portal_action',
      related_id: preflightId,
      body,
      metadata,
      actor: cleanOperator,
      channel: 'ops_console',
      direction: 'internal',
      decision_code: 'ops.renewal_customer_message.send_blocked',
      summary: 'Renewal customer-message execution stayed blocked before any AgentMail send or customer contact.'
    });
    contactEvents.add({
      lead_id: preflight.lead_id,
      type: 'operator_renewal_customer_message_send_blocked',
      direction: 'internal',
      channel: 'ops_console',
      subject: 'renewal customer-message send blocked',
      body: `Renewal customer-message send stayed blocked: ${safety.blockers.join(', ')}`,
      metadata
    });
    emit('ops.renewal_customer_message.send_blocked', {
      worker: 'ops',
      leadId: preflight.lead_id,
      portalActionId: receipt.id,
      preflightId,
      sourcePortalActionId,
      billingPreflightId,
      subscriptionId,
      blockers: safety.blockers
    });
    return {
      ok: false,
      status: 'blocked_live_preflight',
      receipt: portalActionRow(receipt),
      preflightId,
      sourcePortalActionId,
      billingPreflightId,
      subscriptionId,
      blockers: safety.blockers,
      customerMessageSent: false,
      agentMailMessageSent: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      ...baseSafetyFlags
    };
  }

  let providerResult;
  try {
    providerResult = await sendAgentMailMessage({
      toEmail: cleanTargetEmail,
      subject: messageDraft.subject || 'Renewal update',
      text: messageDraft.body || 'Renewal update',
      leadId: preflight.lead_id,
      costKind: 'renewal_customer_message'
    });
  } catch (err) {
    recordProviderRuntimeIncident({
      provider: 'agentmail',
      error: err,
      action: 'renewal_customer_message_send',
      worker: 'ops',
      leadId: preflight.lead_id,
      eventId: preflightId,
      now
    });
    const body = {
      preflightId,
      sourcePortalActionId,
      billingPreflightId,
      leadId: preflight.lead_id,
      subscriptionId,
      playbookId,
      channel: safety.channel,
      targetEmail: cleanTargetEmail,
      provider: 'agentmail',
      status: 'failed_provider',
      error: err?.message || String(err),
      dedupeHash,
      customerMessageSent: false,
      agentMailMessageSent: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      ...baseSafetyFlags
    };
    const receipt = portalActions.add({
      lead_id: preflight.lead_id,
      token_id: preflight.token_id || null,
      type: RENEWAL_CUSTOMER_MESSAGE_SEND_RECEIPT_ACTION_TYPE,
      status: 'failed_provider',
      related_type: 'portal_action',
      related_id: preflightId,
      body,
      metadata: {
        source: 'ops_console',
        provider: 'agentmail',
        operator: cleanOperator,
        error: body.error,
        customerMessageSent: false,
        agentMailMessageSent: false,
        providerMutationPerformed: false,
        liveSideEffects: false,
        ...baseSafetyFlags
      },
      actor: cleanOperator,
      channel: 'ops_console',
      direction: 'internal',
      decision_code: 'ops.renewal_customer_message.send_failed',
      summary: 'Renewal customer-message execution reached AgentMail but failed; runtime incident was recorded.'
    });
    contactEvents.add({
      lead_id: preflight.lead_id,
      type: 'operator_renewal_customer_message_send_failed',
      direction: 'internal',
      channel: 'ops_console',
      subject: 'renewal customer-message send failed',
      body: `Renewal customer-message send reached AgentMail but failed: ${body.error}`,
      metadata: {
        source: 'ops_console',
        portalActionId: receipt.id,
        preflightId,
        sourcePortalActionId,
        billingPreflightId,
        subscriptionId,
        provider: 'agentmail',
        operator: cleanOperator,
        error: body.error,
        customerMessageSent: false,
        agentMailMessageSent: false,
        providerMutationPerformed: false,
        liveSideEffects: false,
        ...baseSafetyFlags
      }
    });
    emit('ops.renewal_customer_message.send_failed', {
      worker: 'ops',
      leadId: preflight.lead_id,
      portalActionId: receipt.id,
      preflightId,
      sourcePortalActionId,
      billingPreflightId,
      subscriptionId,
      error: body.error
    });
    return {
      ok: false,
      status: 'failed_provider',
      receipt: portalActionRow(receipt),
      preflightId,
      sourcePortalActionId,
      billingPreflightId,
      subscriptionId,
      error: body.error,
      customerMessageSent: false,
      agentMailMessageSent: false,
      providerMutationPerformed: false,
      liveSideEffects: false,
      ...baseSafetyFlags
    };
  }

  const body = {
    preflightId,
    sourcePortalActionId,
    billingPreflightId,
    leadId: preflight.lead_id,
    subscriptionId,
    playbookId,
    channel: 'email',
    targetEmail: cleanTargetEmail,
    provider: 'agentmail',
    providerMessageId: providerResult?.messageId || null,
    providerThreadId: providerResult?.threadId || null,
    status: 'sent',
    sentAt: now,
    dedupeHash,
    customerMessageSent: true,
    agentMailMessageSent: true,
    providerMutationPerformed: true,
    liveSideEffects: true,
    ...baseSafetyFlags
  };
  const receipt = portalActions.add({
    lead_id: preflight.lead_id,
    token_id: preflight.token_id || null,
    type: RENEWAL_CUSTOMER_MESSAGE_SEND_RECEIPT_ACTION_TYPE,
    status: 'sent',
    related_type: 'portal_action',
    related_id: preflightId,
    body,
    metadata: {
      source: 'ops_console',
      provider: 'agentmail',
      operator: cleanOperator,
      providerResult,
      customerMessageSent: true,
      agentMailMessageSent: true,
      providerMutationPerformed: true,
      liveSideEffects: true,
      ...baseSafetyFlags
    },
    actor: cleanOperator,
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_customer_message.sent',
    summary: 'Operator-approved renewal customer message was sent through AgentMail after live preflight passed.'
  });
  contactEvents.add({
    lead_id: preflight.lead_id,
    type: 'renewal_customer_message_sent',
    direction: 'outbound',
    channel: 'agentmail',
    subject: messageDraft.subject || 'Renewal update',
    body: messageDraft.body || 'Renewal update',
    metadata: {
      source: 'ops_console',
      portalActionId: receipt.id,
      preflightId,
      provider: 'agentmail',
      messageId: providerResult?.messageId || null,
      threadId: providerResult?.threadId || null,
      ...body
    }
  });
  emit('ops.renewal_customer_message.sent', {
    worker: 'ops',
    leadId: preflight.lead_id,
    portalActionId: receipt.id,
    preflightId,
    sourcePortalActionId,
    billingPreflightId,
    subscriptionId,
    messageId: providerResult?.messageId || null
  });
  return {
    ok: true,
    status: 'sent',
    receipt: portalActionRow(receipt),
    preflightId,
    sourcePortalActionId,
    billingPreflightId,
    subscriptionId,
    providerResult,
    customerMessageSent: true,
    agentMailMessageSent: true,
    providerMutationPerformed: true,
    liveSideEffects: true,
    ...baseSafetyFlags
  };
}

export function summarizeRenewalCustomerMessageSendReceiptQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_CUSTOMER_MESSAGE_SEND_RECEIPT_ACTION_TYPE, { since, limit });
  const byStatus = {};
  let latestAt = null;
  let latestRow = null;
  let blockedCount = 0;
  let sentCount = 0;
  let failedCount = 0;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status === 'blocked_live_preflight') blockedCount += 1;
    if (status === 'sent') sentCount += 1;
    if (status === 'failed_provider') failedCount += 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
  }
  return {
    total: rows.length,
    blockedCount,
    sentCount,
    failedCount,
    byStatus,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          preflightId: latestRow.related_id || latestRow.body?.preflightId || null,
          subscriptionId: latestRow.body?.subscriptionId || null,
          sourcePortalActionId: latestRow.body?.sourcePortalActionId || null,
          status: latestRow.status,
          provider: latestRow.body?.provider || null,
          createdAt: latestRow.created_at || null
        }
      : null,
    windowMs,
    generatedAt: now,
    customerMessageSent: sentCount > 0,
    agentMailMessageSent: sentCount > 0,
    providerMutationPerformed: sentCount > 0,
    liveSideEffects: sentCount > 0,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false
  };
}

export const RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE = 'renewal_customer_confirmation_receipt';
export const RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE = 'renewal_customer_confirmation_acknowledged';
export const RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE = 'renewal_customer_confirmation_accepted';
export const RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE = 'renewal_customer_confirmation_followup_work_item';
export const RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE = 'renewal_customer_confirmation_followup_receipt';
export const RENEWAL_CUSTOMER_CONFIRMATION_CLOSEOUT_PACKET_ACTION_TYPE = 'renewal_customer_confirmation_closeout_packet';

function renewalConfirmationSource({ id, expectedType, expectedStatus, label }) {
  if (!id) return null;
  const row = portalActions.get(id);
  if (!row) {
    const err = new Error(`${label} ${id} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (row.type !== expectedType) {
    const err = new Error(`${label} ${id} is not a ${expectedType} action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  if (row.status !== expectedStatus) {
    const err = new Error(`${label} ${id} must be ${expectedStatus} before customer confirmation (status=${row.status})`);
    err.code = 'invalid_request';
    throw err;
  }
  return row;
}

export function createRenewalCustomerConfirmationReceipt({
  leadId: requestedLeadId = null,
  billingExecutionReceiptId = null,
  messageSendReceiptId = null,
  operator = 'operator',
  summary = '',
  now = Date.now()
} = {}) {
  if (!billingExecutionReceiptId && !messageSendReceiptId) {
    const err = new Error('billingExecutionReceiptId or messageSendReceiptId required');
    err.code = 'invalid_request';
    throw err;
  }
  const billingReceipt = renewalConfirmationSource({
    id: billingExecutionReceiptId,
    expectedType: RENEWAL_BILLING_EXECUTION_RECEIPT_ACTION_TYPE,
    expectedStatus: 'applied',
    label: 'billing execution receipt'
  });
  const messageReceipt = renewalConfirmationSource({
    id: messageSendReceiptId,
    expectedType: RENEWAL_CUSTOMER_MESSAGE_SEND_RECEIPT_ACTION_TYPE,
    expectedStatus: 'sent',
    label: 'message send receipt'
  });
  const sourceRows = [billingReceipt, messageReceipt].filter(Boolean);
  const sourceLeadId = sourceRows[0]?.lead_id || null;
  if (!sourceLeadId || sourceRows.some((row) => row.lead_id !== sourceLeadId)) {
    const err = new Error('renewal confirmation source receipts must belong to the same lead');
    err.code = 'invalid_request';
    throw err;
  }
  const cleanRequestedLeadId = compactText(requestedLeadId, 160) || null;
  if (cleanRequestedLeadId && cleanRequestedLeadId !== sourceLeadId) {
    const err = new Error('renewal confirmation source receipts do not belong to the requested lead');
    err.code = 'invalid_request';
    throw err;
  }
  const leadId = sourceLeadId;
  const sourceSubscriptionIds = sourceRows.map((row) => row.body?.subscriptionId).filter(Boolean);
  const subscriptionId = sourceSubscriptionIds[0] || null;
  if (sourceSubscriptionIds.some((id) => id !== subscriptionId)) {
    const err = new Error('renewal confirmation source receipts must belong to the same subscription');
    err.code = 'invalid_request';
    throw err;
  }
  const sourcePortalActionIds = sourceRows.map((row) => row.body?.sourcePortalActionId).filter(Boolean);
  const sourcePortalActionId = sourcePortalActionIds[0] || null;
  if (sourcePortalActionIds.some((id) => id !== sourcePortalActionId)) {
    const err = new Error('renewal confirmation source receipts must belong to the same renewal change request');
    err.code = 'invalid_request';
    throw err;
  }
  const playbookIds = sourceRows.map((row) => row.body?.playbookId).filter(Boolean);
  const playbookId = playbookIds[0] || null;
  if (playbookIds.some((id) => id !== playbookId)) {
    const err = new Error('renewal confirmation source receipts must belong to the same renewal playbook');
    err.code = 'invalid_request';
    throw err;
  }
  const cleanOperator = compactText(operator, 120) || 'operator';
  const cleanSummary = compactText(summary, 1000)
    || 'Your renewal update has been applied and recorded in this portal.';
  const sourceFlags = {
    subscriptionChanged: billingReceipt?.body?.subscriptionChanged === true,
    stripeStateChanged: billingReceipt?.body?.stripeStateChanged === true,
    priceChanged: billingReceipt?.body?.priceChanged === true,
    discountApplied: billingReceipt?.body?.discountApplied === true,
    customerMessageSent: messageReceipt?.body?.customerMessageSent === true,
    agentMailMessageSent: messageReceipt?.body?.agentMailMessageSent === true,
    providerMutationPerformed: sourceRows.some((row) => row.body?.providerMutationPerformed === true),
    sourceLiveSideEffects: sourceRows.some((row) => row.body?.liveSideEffects === true),
    paymentLinkCreated: sourceRows.some((row) => row.body?.paymentLinkCreated === true),
    checkoutLinkCreated: sourceRows.some((row) => row.body?.checkoutLinkCreated === true)
  };
  const dedupeHash = shortHash(`${billingReceipt?.id || ''}|${messageReceipt?.id || ''}`);
  const existing = (portalActions.listByLead?.(leadId, {
    limit: 200,
    type: RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE
  }) || []).find((row) => row.body?.dedupeHash === dedupeHash);
  if (existing) {
    return {
      ok: true,
      reused: true,
      confirmation: portalActionRow(existing),
      billingExecutionReceiptId: billingReceipt?.id || null,
      messageSendReceiptId: messageReceipt?.id || null,
      subscriptionId,
      sourcePortalActionId,
      ...sourceFlags,
      customerVisible: true,
      portalVisible: true,
      confirmationMessageSent: false,
      portalBroadcastSent: false,
      confirmationLiveSideEffects: false
    };
  }
  const body = {
    leadId,
    subscriptionId,
    playbookId,
    sourcePortalActionId,
    billingExecutionReceiptId: billingReceipt?.id || null,
    messageSendReceiptId: messageReceipt?.id || null,
    billingExecutionStatus: billingReceipt?.status || null,
    messageSendStatus: messageReceipt?.status || null,
    summary: cleanSummary,
    customerVisible: true,
    portalVisible: true,
    confirmationRecordedAt: now,
    confirmationMessageSent: false,
    portalBroadcastSent: false,
    confirmationLiveSideEffects: false,
    noNewLiveSideEffects: true,
    dedupeHash,
    ...sourceFlags
  };
  const metadata = {
    source: 'ops_console',
    operator: cleanOperator,
    customerVisible: true,
    portalVisible: true,
    noNewLiveSideEffects: true,
    ...body
  };
  const action = portalActions.add({
    lead_id: leadId,
    token_id: billingReceipt?.token_id || messageReceipt?.token_id || null,
    type: RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE,
    status: 'visible_to_customer',
    related_type: 'portal_action',
    related_id: billingReceipt?.id || messageReceipt?.id || null,
    body,
    metadata,
    actor: cleanOperator,
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_customer_confirmation.recorded',
    summary: 'Operator recorded a customer-visible renewal confirmation in the portal without sending a new customer message or triggering new provider side effects.'
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'operator_renewal_customer_confirmation_recorded',
    direction: 'internal',
    channel: 'ops_console',
    subject: 'renewal confirmation recorded for portal',
    body: cleanSummary,
    metadata: {
      source: 'ops_console',
      portalActionId: action.id,
      operator: cleanOperator,
      ...body
    }
  });
  emit('ops.renewal_customer_confirmation.recorded', {
    worker: 'ops',
    leadId,
    portalActionId: action.id,
    billingExecutionReceiptId: billingReceipt?.id || null,
    messageSendReceiptId: messageReceipt?.id || null,
    subscriptionId,
    sourcePortalActionId
  });
  return {
    ok: true,
    confirmation: portalActionRow(action),
    billingExecutionReceiptId: billingReceipt?.id || null,
    messageSendReceiptId: messageReceipt?.id || null,
    subscriptionId,
    sourcePortalActionId,
    ...sourceFlags,
    customerVisible: true,
    portalVisible: true,
    confirmationMessageSent: false,
    portalBroadcastSent: false,
    confirmationLiveSideEffects: false
  };
}

export function summarizeRenewalCustomerConfirmationQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE, { since, limit });
  const byStatus = {};
  let latestAt = null;
  let latestRow = null;
  let visibleCount = 0;
  let billingConfirmedCount = 0;
  let messageConfirmedCount = 0;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status === 'visible_to_customer') visibleCount += 1;
    if (row.body?.billingExecutionReceiptId) billingConfirmedCount += 1;
    if (row.body?.messageSendReceiptId) messageConfirmedCount += 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
  }
  return {
    total: rows.length,
    visibleCount,
    billingConfirmedCount,
    messageConfirmedCount,
    byStatus,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          subscriptionId: latestRow.body?.subscriptionId || null,
          sourcePortalActionId: latestRow.body?.sourcePortalActionId || null,
          billingExecutionReceiptId: latestRow.body?.billingExecutionReceiptId || null,
          messageSendReceiptId: latestRow.body?.messageSendReceiptId || null,
          status: latestRow.status,
          createdAt: latestRow.created_at || null
        }
      : null,
    windowMs,
    generatedAt: now,
    customerVisible: visibleCount > 0,
    portalVisible: visibleCount > 0,
    subscriptionChanged: rows.some((row) => row.body?.subscriptionChanged === true),
    stripeStateChanged: rows.some((row) => row.body?.stripeStateChanged === true),
    customerMessageSent: rows.some((row) => row.body?.customerMessageSent === true),
    sourceLiveSideEffects: rows.some((row) => row.body?.sourceLiveSideEffects === true),
    paymentLinkCreated: rows.some((row) => row.body?.paymentLinkCreated === true),
    checkoutLinkCreated: rows.some((row) => row.body?.checkoutLinkCreated === true),
    confirmationMessageSent: rows.some((row) => row.body?.confirmationMessageSent === true),
    portalBroadcastSent: rows.some((row) => row.body?.portalBroadcastSent === true),
    confirmationLiveSideEffects: rows.some((row) => row.body?.confirmationLiveSideEffects === true)
  };
}

export function acknowledgeRenewalCustomerConfirmation({
  leadId,
  tokenId = null,
  confirmationId,
  note = '',
  now = Date.now()
} = {}) {
  if (!leadId) {
    const err = new Error('leadId required');
    err.code = 'invalid_request';
    throw err;
  }
  if (!confirmationId) {
    const err = new Error('confirmationId required');
    err.code = 'invalid_request';
    throw err;
  }
  const confirmation = portalActions.get(confirmationId);
  if (!confirmation) {
    const err = new Error(`renewal confirmation ${confirmationId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (confirmation.type !== RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE) {
    const err = new Error(`portal action ${confirmationId} is not a ${RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE} action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  if (confirmation.lead_id !== leadId) {
    const err = new Error('renewal confirmation does not belong to this portal');
    err.code = 'invalid_request';
    throw err;
  }
  if (confirmation.status !== 'visible_to_customer') {
    const err = new Error(`renewal confirmation must be visible_to_customer before acknowledgement (status=${confirmation.status})`);
    err.code = 'invalid_request';
    throw err;
  }
  const existing = (portalActions.listByLead?.(leadId, {
    limit: 200,
    type: RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE
  }) || []).find((row) => row.related_id === confirmation.id);
  if (existing) {
    return {
      ok: true,
      reused: true,
      acknowledgement: portalActionRow(existing),
      confirmation: portalRenewalConfirmationRow(confirmation, [existing], []),
      confirmationId: confirmation.id,
      subscriptionId: confirmation.body?.subscriptionId || null,
      customerAcknowledged: true,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      checkoutLinkCreated: false,
      liveSideEffects: false
    };
  }
  const cleanNote = compactText(note, 500) || 'Customer acknowledged the renewal confirmation in the portal.';
  const body = {
    confirmationId: confirmation.id,
    subscriptionId: confirmation.body?.subscriptionId || null,
    billingExecutionReceiptId: confirmation.body?.billingExecutionReceiptId || null,
    messageSendReceiptId: confirmation.body?.messageSendReceiptId || null,
    sourcePortalActionId: confirmation.body?.sourcePortalActionId || null,
    note: cleanNote,
    customerAcknowledged: true,
    acknowledgedAt: now,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    confirmationAcknowledgementLiveSideEffects: false,
    portalBroadcastSent: false,
    noLiveSideEffects: true
  };
  const action = portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE,
    status: 'acknowledged',
    related_type: 'portal_action',
    related_id: confirmation.id,
    body,
    metadata: {
      source: 'share_portal',
      customerAcknowledged: true,
      noLiveSideEffects: true,
      ...body
    },
    actor: 'customer',
    channel: 'portal',
    direction: 'inbound',
    decision_code: 'portal.renewal_customer_confirmation.acknowledged',
    summary: 'Customer acknowledged a renewal confirmation in the portal without triggering billing, provider, or message side effects.'
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'customer_renewal_confirmation_acknowledged',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer acknowledged renewal confirmation',
    body: cleanNote,
    metadata: {
      source: 'share_portal',
      portalActionId: action.id,
      ...body
    }
  });
  emit('portal.renewal_customer_confirmation.acknowledged', {
    worker: 'portal',
    leadId,
    portalActionId: action.id,
    confirmationId: confirmation.id,
    subscriptionId: body.subscriptionId
  });
  return {
    ok: true,
    acknowledgement: portalActionRow(action),
    confirmation: portalRenewalConfirmationRow(confirmation, [action], []),
    confirmationId: confirmation.id,
    subscriptionId: body.subscriptionId,
    customerAcknowledged: true,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false
  };
}

export function acceptRenewalCustomerConfirmation({
  leadId,
  tokenId = null,
  confirmationId,
  note = '',
  now = Date.now()
} = {}) {
  if (!leadId) {
    const err = new Error('leadId required');
    err.code = 'invalid_request';
    throw err;
  }
  if (!confirmationId) {
    const err = new Error('confirmationId required');
    err.code = 'invalid_request';
    throw err;
  }
  const confirmation = portalActions.get(confirmationId);
  if (!confirmation) {
    const err = new Error(`renewal confirmation ${confirmationId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (confirmation.type !== RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE) {
    const err = new Error(`portal action ${confirmationId} is not a ${RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE} action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  if (confirmation.lead_id !== leadId) {
    const err = new Error('renewal confirmation does not belong to this portal');
    err.code = 'invalid_request';
    throw err;
  }
  if (confirmation.status !== 'visible_to_customer') {
    const err = new Error(`renewal confirmation must be visible_to_customer before acceptance (status=${confirmation.status})`);
    err.code = 'invalid_request';
    throw err;
  }
  const acknowledgementRows = (portalActions.listByLead?.(leadId, {
    limit: 200,
    type: RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE
  }) || []).filter((row) => row.related_id === confirmation.id);
  const latestAcknowledgement = acknowledgementRows
    .slice()
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0] || null;
  if (!latestAcknowledgement) {
    const err = new Error('renewal confirmation must be acknowledged before acceptance');
    err.code = 'invalid_request';
    throw err;
  }
  const existing = (portalActions.listByLead?.(leadId, {
    limit: 200,
    type: RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE
  }) || []).find((row) => row.related_id === confirmation.id);
  if (existing) {
    return {
      ok: true,
      reused: true,
      acceptance: portalActionRow(existing),
      confirmation: portalRenewalConfirmationRow(confirmation, acknowledgementRows, [existing]),
      confirmationId: confirmation.id,
      acknowledgementId: latestAcknowledgement.id,
      subscriptionId: confirmation.body?.subscriptionId || null,
      customerAccepted: true,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      checkoutLinkCreated: false,
      liveSideEffects: false
    };
  }
  const cleanNote = compactText(note, 500) || 'Customer accepted the renewal confirmation in the portal.';
  const body = {
    confirmationId: confirmation.id,
    acknowledgementId: latestAcknowledgement.id,
    subscriptionId: confirmation.body?.subscriptionId || null,
    billingExecutionReceiptId: confirmation.body?.billingExecutionReceiptId || null,
    messageSendReceiptId: confirmation.body?.messageSendReceiptId || null,
    sourcePortalActionId: confirmation.body?.sourcePortalActionId || null,
    note: cleanNote,
    customerAccepted: true,
    acceptedAt: now,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    confirmationAcceptanceLiveSideEffects: false,
    portalBroadcastSent: false,
    noLiveSideEffects: true
  };
  const action = portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE,
    status: 'accepted',
    related_type: 'portal_action',
    related_id: confirmation.id,
    body,
    metadata: {
      source: 'share_portal',
      customerAccepted: true,
      noLiveSideEffects: true,
      ...body
    },
    actor: 'customer',
    channel: 'portal',
    direction: 'inbound',
    decision_code: 'portal.renewal_customer_confirmation.accepted',
    summary: 'Customer accepted a renewal confirmation in the portal without triggering billing, provider, or message side effects.'
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'customer_renewal_confirmation_accepted',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer accepted renewal confirmation',
    body: cleanNote,
    metadata: {
      source: 'share_portal',
      portalActionId: action.id,
      ...body
    }
  });
  emit('portal.renewal_customer_confirmation.accepted', {
    worker: 'portal',
    leadId,
    portalActionId: action.id,
    confirmationId: confirmation.id,
    acknowledgementId: latestAcknowledgement.id,
    subscriptionId: body.subscriptionId
  });
  return {
    ok: true,
    acceptance: portalActionRow(action),
    confirmation: portalRenewalConfirmationRow(confirmation, acknowledgementRows, [action]),
    confirmationId: confirmation.id,
    acknowledgementId: latestAcknowledgement.id,
    subscriptionId: body.subscriptionId,
    customerAccepted: true,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false
  };
}

export function summarizeRenewalCustomerConfirmationAcceptanceQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE, { since, limit });
  const byStatus = {};
  let latestAt = null;
  let latestRow = null;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
  }
  return {
    total: rows.length,
    acceptedCount: rows.filter((row) => row.status === 'accepted').length,
    byStatus,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          confirmationId: latestRow.related_id || latestRow.body?.confirmationId || null,
          acknowledgementId: latestRow.body?.acknowledgementId || null,
          subscriptionId: latestRow.body?.subscriptionId || null,
          status: latestRow.status,
          createdAt: latestRow.created_at || null
        }
      : null,
    windowMs,
    generatedAt: now,
    customerAccepted: rows.some((row) => row.body?.customerAccepted === true),
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false,
    portalBroadcastSent: false
  };
}

export function createRenewalCustomerConfirmationFollowupWorkItem({
  leadId: requestedLeadId = null,
  acceptanceId,
  operator = 'operator',
  priority = 'normal',
  dueAt = null,
  now = Date.now()
} = {}) {
  if (!acceptanceId) {
    const err = new Error('acceptanceId required');
    err.code = 'invalid_request';
    throw err;
  }
  const acceptance = portalActions.get(acceptanceId);
  if (!acceptance) {
    const err = new Error(`renewal confirmation acceptance ${acceptanceId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (acceptance.type !== RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE) {
    const err = new Error(`portal action ${acceptanceId} is not a ${RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE} action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  if (acceptance.status !== 'accepted') {
    const err = new Error(`renewal confirmation acceptance must be accepted before follow-up (status=${acceptance.status})`);
    err.code = 'invalid_request';
    throw err;
  }
  const cleanRequestedLeadId = compactText(requestedLeadId, 160) || null;
  if (cleanRequestedLeadId && cleanRequestedLeadId !== acceptance.lead_id) {
    const err = new Error('renewal confirmation acceptance does not belong to the requested lead');
    err.code = 'invalid_request';
    throw err;
  }
  const leadId = acceptance.lead_id;
  const confirmationId = acceptance.body?.confirmationId || acceptance.related_id || null;
  const confirmation = confirmationId ? portalActions.get(confirmationId) : null;
  if (!confirmation || confirmation.type !== RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE || confirmation.lead_id !== leadId) {
    const err = new Error('renewal confirmation acceptance is missing its source confirmation');
    err.code = 'invalid_request';
    throw err;
  }
  const acknowledgementId = acceptance.body?.acknowledgementId || null;
  const acknowledgement = acknowledgementId ? portalActions.get(acknowledgementId) : null;
  if (!acknowledgement || acknowledgement.type !== RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE || acknowledgement.lead_id !== leadId) {
    const err = new Error('renewal confirmation acceptance is missing its source acknowledgement');
    err.code = 'invalid_request';
    throw err;
  }
  const existing = (portalActions.listByLead?.(leadId, {
    limit: 200,
    type: RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE
  }) || []).find((row) => row.related_id === acceptance.id);
  if (existing) {
    return {
      ok: true,
      reused: true,
      workItem: portalActionRow(existing),
      acceptanceId: acceptance.id,
      confirmationId,
      acknowledgementId,
      subscriptionId: acceptance.body?.subscriptionId || null,
      operatorFollowupRequired: existing.status !== 'completed',
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      checkoutLinkCreated: false,
      liveSideEffects: false
    };
  }
  const cleanOperator = compactText(operator, 120) || 'operator';
  const cleanPriority = ['low', 'normal', 'high', 'urgent'].includes(String(priority || '').toLowerCase())
    ? String(priority || '').toLowerCase()
    : 'normal';
  const cleanDueAt = Number.isFinite(Number(dueAt)) ? Number(dueAt) : now + 48 * 60 * 60 * 1000;
  const body = {
    leadId,
    acceptanceId: acceptance.id,
    confirmationId,
    acknowledgementId,
    subscriptionId: acceptance.body?.subscriptionId || null,
    billingExecutionReceiptId: acceptance.body?.billingExecutionReceiptId || null,
    messageSendReceiptId: acceptance.body?.messageSendReceiptId || null,
    sourcePortalActionId: acceptance.body?.sourcePortalActionId || null,
    priority: cleanPriority,
    dueAt: cleanDueAt,
    openedAt: now,
    customerAccepted: true,
    operatorFollowupRequired: true,
    recommendedNextSteps: [
      'verify accepted renewal outcome against billing and message receipts',
      'attach accepted state to the renewal/account-manager record',
      'schedule the next renewal health check or operator reminder'
    ],
    proofRequired: [
      'source_confirmation_visible_to_customer',
      'customer_acknowledgement_receipt',
      'customer_acceptance_receipt',
      'operator_closeout_note'
    ],
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    followupLiveSideEffects: false,
    portalBroadcastSent: false,
    noLiveSideEffects: true
  };
  const action = portalActions.add({
    lead_id: leadId,
    token_id: acceptance.token_id || acknowledgement.token_id || null,
    type: RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE,
    status: 'open',
    related_type: 'portal_action',
    related_id: acceptance.id,
    body,
    metadata: {
      source: 'ops_console',
      operator: cleanOperator,
      customerAccepted: true,
      noLiveSideEffects: true,
      ...body
    },
    actor: cleanOperator,
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_customer_confirmation.followup_opened',
    summary: 'Operator follow-up work item opened after customer accepted a renewal confirmation, without billing, provider, or customer-message side effects.'
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'operator_renewal_confirmation_followup_opened',
    direction: 'internal',
    channel: 'ops_console',
    subject: 'renewal confirmation follow-up opened',
    body: 'Customer accepted the renewal confirmation; operator follow-up is required before closeout.',
    metadata: {
      source: 'ops_console',
      portalActionId: action.id,
      operator: cleanOperator,
      ...body
    }
  });
  emit('ops.renewal_customer_confirmation.followup_opened', {
    worker: 'ops',
    leadId,
    portalActionId: action.id,
    acceptanceId: acceptance.id,
    confirmationId,
    acknowledgementId,
    subscriptionId: body.subscriptionId
  });
  return {
    ok: true,
    workItem: portalActionRow(action),
    acceptanceId: acceptance.id,
    confirmationId,
    acknowledgementId,
    subscriptionId: body.subscriptionId,
    operatorFollowupRequired: true,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false
  };
}

const RENEWAL_CONFIRMATION_FOLLOWUP_OUTCOMES = new Set(['completed', 'escalated', 'canceled']);

export function resolveRenewalCustomerConfirmationFollowupWorkItem({
  workItemId,
  outcome = 'completed',
  note = '',
  operator = 'operator',
  now = Date.now()
} = {}) {
  if (!workItemId) {
    const err = new Error('workItemId required');
    err.code = 'invalid_request';
    throw err;
  }
  const cleanOutcome = String(outcome || '').toLowerCase().trim();
  if (!RENEWAL_CONFIRMATION_FOLLOWUP_OUTCOMES.has(cleanOutcome)) {
    const err = new Error(`outcome must be one of ${Array.from(RENEWAL_CONFIRMATION_FOLLOWUP_OUTCOMES).join(', ')}`);
    err.code = 'invalid_request';
    throw err;
  }
  const existing = portalActions.get(workItemId);
  if (!existing) {
    const err = new Error(`renewal confirmation follow-up ${workItemId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (existing.type !== RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE) {
    const err = new Error(`portal action ${workItemId} is not a ${RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE} action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  const cleanOperator = compactText(operator, 120) || 'operator';
  const cleanNote = compactText(note, 1000);
  const resolutionHistory = Array.isArray(existing.body?.resolutionHistory)
    ? existing.body.resolutionHistory.slice()
    : [];
  resolutionHistory.push({
    outcome: cleanOutcome,
    note: cleanNote || null,
    operator: cleanOperator,
    resolvedAt: now,
    previousStatus: existing.status
  });
  const nextStatus = cleanOutcome;
  const resolvedAt = cleanOutcome === 'escalated' ? null : now;
  const safetyFlags = {
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    followupLiveSideEffects: false,
    portalBroadcastSent: false,
    noLiveSideEffects: true
  };
  const nextBody = {
    ...(existing.body || {}),
    resolutionHistory,
    latestResolution: {
      outcome: cleanOutcome,
      note: cleanNote || null,
      operator: cleanOperator,
      resolvedAt: now,
      previousStatus: existing.status
    },
    operatorFollowupRequired: cleanOutcome === 'escalated',
    followupResolved: cleanOutcome !== 'escalated',
    ...safetyFlags
  };
  const nextMetadata = {
    ...(existing.metadata || {}),
    source: existing.metadata?.source || 'ops_console',
    operator: cleanOperator,
    latestOperatorOutcome: cleanOutcome,
    latestOperatorResolvedAt: now,
    ...safetyFlags
  };
  const updated = portalActions.updateStatus(workItemId, {
    status: nextStatus,
    body: nextBody,
    metadata: nextMetadata,
    resolved_at: resolvedAt,
    requireType: RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE,
    actor: cleanOperator,
    decision_code: `ops.renewal_customer_confirmation.followup_${cleanOutcome}`,
    summary: `Operator ${cleanOperator} marked renewal confirmation follow-up ${workItemId} as ${cleanOutcome} locally without billing/provider/customer-message side effects.`
  });
  const dedupeHash = shortHash(`${workItemId}|${cleanOutcome}`);
  let receipt = (portalActions.listByLead?.(existing.lead_id, {
    limit: 200,
    type: RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE
  }) || []).find((row) => row.body?.dedupeHash === dedupeHash);
  if (!receipt) {
    const receiptBody = {
      workItemId,
      acceptanceId: existing.body?.acceptanceId || existing.related_id || null,
      confirmationId: existing.body?.confirmationId || null,
      acknowledgementId: existing.body?.acknowledgementId || null,
      subscriptionId: existing.body?.subscriptionId || null,
      outcome: cleanOutcome,
      note: cleanNote || null,
      operator: cleanOperator,
      resolvedAt: now,
      dedupeHash,
      ...safetyFlags
    };
    receipt = portalActions.add({
      lead_id: existing.lead_id,
      token_id: existing.token_id || null,
      type: RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE,
      status: cleanOutcome,
      related_type: 'portal_action',
      related_id: workItemId,
      body: receiptBody,
      metadata: {
        source: 'ops_console',
        operator: cleanOperator,
        noLiveSideEffects: true,
        ...receiptBody
      },
      actor: cleanOperator,
      channel: 'ops_console',
      direction: 'internal',
      decision_code: `ops.renewal_customer_confirmation.followup_receipt.${cleanOutcome}`,
      summary: 'Operator recorded a renewal confirmation follow-up receipt without billing, provider, or customer-message side effects.'
    });
  }
  contactEvents.add({
    lead_id: existing.lead_id,
    type: 'operator_renewal_confirmation_followup_resolved',
    direction: 'internal',
    channel: 'ops_console',
    subject: `renewal confirmation follow-up ${cleanOutcome}`,
    body: cleanNote || `Operator ${cleanOperator} marked the renewal confirmation follow-up ${cleanOutcome}.`,
    metadata: {
      source: 'ops_console',
      portalActionId: workItemId,
      receiptId: receipt.id,
      outcome: cleanOutcome,
      operator: cleanOperator,
      previousStatus: existing.status,
      ...safetyFlags
    }
  });
  emit('ops.renewal_customer_confirmation.followup_resolved', {
    worker: 'ops',
    leadId: existing.lead_id,
    portalActionId: workItemId,
    receiptId: receipt.id,
    outcome: cleanOutcome,
    previousStatus: existing.status,
    nextStatus
  });
  return {
    ok: true,
    workItem: portalActionRow(updated),
    receipt: portalActionRow(receipt),
    previousStatus: existing.status,
    nextStatus,
    outcome: cleanOutcome,
    resolvedAt,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false,
    portalBroadcastSent: false
  };
}

export function summarizeRenewalCustomerConfirmationFollowupQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE, { since, limit });
  const receipts = portalActions.listByType(RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE, { since, limit });
  const byStatus = {};
  let latestAt = null;
  let latestRow = null;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
  }
  const pendingStatuses = new Set(['open', 'in_progress', 'escalated']);
  return {
    total: rows.length,
    receiptCount: receipts.length,
    openCount: rows.filter((row) => row.status === 'open').length,
    completedCount: rows.filter((row) => row.status === 'completed').length,
    escalatedCount: rows.filter((row) => row.status === 'escalated').length,
    canceledCount: rows.filter((row) => row.status === 'canceled').length,
    pendingCount: rows.filter((row) => pendingStatuses.has(row.status) && !row.resolved_at).length,
    byStatus,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          acceptanceId: latestRow.related_id || latestRow.body?.acceptanceId || null,
          confirmationId: latestRow.body?.confirmationId || null,
          acknowledgementId: latestRow.body?.acknowledgementId || null,
          subscriptionId: latestRow.body?.subscriptionId || null,
          status: latestRow.status,
          dueAt: latestRow.body?.dueAt || null,
          createdAt: latestRow.created_at || null,
          resolvedAt: latestRow.resolved_at || null
        }
      : null,
    windowMs,
    generatedAt: now,
    operatorFollowupRequired: rows.some((row) => pendingStatuses.has(row.status) && !row.resolved_at),
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false,
    portalBroadcastSent: false
  };
}

export function createRenewalCustomerConfirmationCloseoutPacket({
  followupReceiptId,
  operator = 'operator',
  summary = '',
  nextReviewAt = null,
  now = Date.now()
} = {}) {
  if (!followupReceiptId) {
    const err = new Error('followupReceiptId required');
    err.code = 'invalid_request';
    throw err;
  }
  const receipt = portalActions.get(followupReceiptId);
  if (!receipt) {
    const err = new Error(`renewal confirmation follow-up receipt ${followupReceiptId} not found`);
    err.code = 'portal_action_not_found';
    throw err;
  }
  if (receipt.type !== RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE) {
    const err = new Error(`portal action ${followupReceiptId} is not a ${RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE} action`);
    err.code = 'portal_action_type_mismatch';
    throw err;
  }
  if (receipt.status !== 'completed' || receipt.body?.outcome !== 'completed') {
    const err = new Error(`renewal confirmation follow-up receipt must be completed before closeout (status=${receipt.status})`);
    err.code = 'invalid_request';
    throw err;
  }
  const workItemId = receipt.body?.workItemId || receipt.related_id || null;
  const workItem = workItemId ? portalActions.get(workItemId) : null;
  if (!workItem || workItem.type !== RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_ACTION_TYPE || workItem.lead_id !== receipt.lead_id) {
    const err = new Error('renewal confirmation closeout is missing its completed follow-up work item');
    err.code = 'invalid_request';
    throw err;
  }
  if (workItem.status !== 'completed') {
    const err = new Error(`renewal confirmation follow-up work item must be completed before closeout (status=${workItem.status})`);
    err.code = 'invalid_request';
    throw err;
  }
  const acceptanceId = receipt.body?.acceptanceId || workItem.body?.acceptanceId || workItem.related_id || null;
  const acceptance = acceptanceId ? portalActions.get(acceptanceId) : null;
  if (!acceptance || acceptance.type !== RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE || acceptance.lead_id !== receipt.lead_id) {
    const err = new Error('renewal confirmation closeout is missing its customer acceptance receipt');
    err.code = 'invalid_request';
    throw err;
  }
  const confirmationId = receipt.body?.confirmationId || acceptance.body?.confirmationId || acceptance.related_id || null;
  const confirmation = confirmationId ? portalActions.get(confirmationId) : null;
  if (!confirmation || confirmation.type !== RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE || confirmation.lead_id !== receipt.lead_id) {
    const err = new Error('renewal confirmation closeout is missing its customer-visible confirmation receipt');
    err.code = 'invalid_request';
    throw err;
  }
  const acknowledgementId = receipt.body?.acknowledgementId || acceptance.body?.acknowledgementId || null;
  const acknowledgement = acknowledgementId ? portalActions.get(acknowledgementId) : null;
  if (!acknowledgement || acknowledgement.type !== RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE || acknowledgement.lead_id !== receipt.lead_id) {
    const err = new Error('renewal confirmation closeout is missing its customer acknowledgement receipt');
    err.code = 'invalid_request';
    throw err;
  }
  const existing = (portalActions.listByLead?.(receipt.lead_id, {
    limit: 200,
    type: RENEWAL_CUSTOMER_CONFIRMATION_CLOSEOUT_PACKET_ACTION_TYPE
  }) || []).find((row) => row.related_id === receipt.id);
  const cleanOperator = compactText(operator, 120) || 'operator';
  const cleanSummary = compactText(summary, 1000)
    || 'Your renewal update has been verified and closed out in this portal.';
  const cleanNextReviewAt = Number.isFinite(Number(nextReviewAt)) ? Number(nextReviewAt) : now + 30 * 24 * 60 * 60 * 1000;
  if (existing) {
    return {
      ok: true,
      reused: true,
      packet: portalActionRow(existing),
      followupReceiptId: receipt.id,
      workItemId,
      acceptanceId,
      confirmationId,
      acknowledgementId,
      subscriptionId: existing.body?.subscriptionId || receipt.body?.subscriptionId || null,
      customerVisible: true,
      portalVisible: true,
      customerMessageSent: false,
      subscriptionChanged: false,
      stripeStateChanged: false,
      paymentLinkCreated: false,
      checkoutLinkCreated: false,
      liveSideEffects: false,
      portalBroadcastSent: false
    };
  }
  const safetyFlags = {
    customerMessageSent: false,
    agentMailMessageSent: false,
    providerMutationPerformed: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    closeoutLiveSideEffects: false,
    portalBroadcastSent: false,
    noLiveSideEffects: true
  };
  const body = {
    leadId: receipt.lead_id,
    followupReceiptId: receipt.id,
    workItemId,
    acceptanceId,
    confirmationId,
    acknowledgementId,
    subscriptionId: receipt.body?.subscriptionId || acceptance.body?.subscriptionId || confirmation.body?.subscriptionId || null,
    billingExecutionReceiptId: receipt.body?.billingExecutionReceiptId || confirmation.body?.billingExecutionReceiptId || null,
    messageSendReceiptId: receipt.body?.messageSendReceiptId || confirmation.body?.messageSendReceiptId || null,
    sourcePortalActionId: receipt.body?.sourcePortalActionId || acceptance.body?.sourcePortalActionId || confirmation.body?.sourcePortalActionId || null,
    summary: cleanSummary,
    closeoutRecordedAt: now,
    nextReviewAt: cleanNextReviewAt,
    customerVisible: true,
    portalVisible: true,
    closeoutPacketVisible: true,
    sourceFollowupOutcome: receipt.body?.outcome || receipt.status,
    packetItems: [
      {
        key: 'confirmation_visible',
        label: 'Renewal update visible in the portal',
        sourceType: RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE,
        sourceId: confirmation.id
      },
      {
        key: 'customer_acceptance',
        label: 'Customer accepted the renewal outcome',
        sourceType: RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE,
        sourceId: acceptance.id
      },
      {
        key: 'operator_followup_completed',
        label: 'Operator completed renewal follow-up',
        sourceType: RENEWAL_CUSTOMER_CONFIRMATION_FOLLOWUP_RECEIPT_ACTION_TYPE,
        sourceId: receipt.id
      },
      {
        key: 'next_review_scheduled',
        label: 'Next renewal health check planned',
        nextReviewAt: cleanNextReviewAt
      }
    ],
    customerNextSteps: [
      'No action is needed right now.',
      'Use this portal if the renewal details look wrong later.',
      'The next renewal health check is scheduled locally before any future billing or message step.'
    ],
    proofIncluded: [
      'source_confirmation_visible_to_customer',
      'customer_acknowledgement_receipt',
      'customer_acceptance_receipt',
      'operator_followup_completion_receipt'
    ],
    ...safetyFlags
  };
  const action = portalActions.add({
    lead_id: receipt.lead_id,
    token_id: receipt.token_id || workItem.token_id || acceptance.token_id || acknowledgement.token_id || null,
    type: RENEWAL_CUSTOMER_CONFIRMATION_CLOSEOUT_PACKET_ACTION_TYPE,
    status: 'visible_to_customer',
    related_type: 'portal_action',
    related_id: receipt.id,
    body,
    metadata: {
      source: 'ops_console',
      operator: cleanOperator,
      customerVisible: true,
      portalVisible: true,
      noLiveSideEffects: true,
      ...body
    },
    actor: cleanOperator,
    channel: 'ops_console',
    direction: 'internal',
    decision_code: 'ops.renewal_customer_confirmation.closeout_packet_recorded',
    summary: 'Operator recorded a customer-visible renewal closeout packet without billing, provider, or customer-message side effects.'
  });
  contactEvents.add({
    lead_id: receipt.lead_id,
    type: 'operator_renewal_confirmation_closeout_packet_recorded',
    direction: 'internal',
    channel: 'ops_console',
    subject: 'renewal confirmation closeout packet recorded',
    body: cleanSummary,
    metadata: {
      source: 'ops_console',
      portalActionId: action.id,
      operator: cleanOperator,
      ...body
    }
  });
  emit('ops.renewal_customer_confirmation.closeout_packet_recorded', {
    worker: 'ops',
    leadId: receipt.lead_id,
    portalActionId: action.id,
    followupReceiptId: receipt.id,
    workItemId,
    acceptanceId,
    confirmationId,
    acknowledgementId,
    subscriptionId: body.subscriptionId
  });
  return {
    ok: true,
    packet: portalActionRow(action),
    followupReceiptId: receipt.id,
    workItemId,
    acceptanceId,
    confirmationId,
    acknowledgementId,
    subscriptionId: body.subscriptionId,
    customerVisible: true,
    portalVisible: true,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false,
    portalBroadcastSent: false
  };
}

export function summarizeRenewalCustomerConfirmationCloseoutPacketQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_CUSTOMER_CONFIRMATION_CLOSEOUT_PACKET_ACTION_TYPE, { since, limit });
  const byStatus = {};
  let latestAt = null;
  let latestRow = null;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
  }
  return {
    total: rows.length,
    visibleCount: rows.filter((row) => row.status === 'visible_to_customer').length,
    completedSourceCount: rows.filter((row) => row.body?.sourceFollowupOutcome === 'completed').length,
    byStatus,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          followupReceiptId: latestRow.related_id || latestRow.body?.followupReceiptId || null,
          workItemId: latestRow.body?.workItemId || null,
          acceptanceId: latestRow.body?.acceptanceId || null,
          confirmationId: latestRow.body?.confirmationId || null,
          acknowledgementId: latestRow.body?.acknowledgementId || null,
          subscriptionId: latestRow.body?.subscriptionId || null,
          status: latestRow.status,
          nextReviewAt: latestRow.body?.nextReviewAt || null,
          createdAt: latestRow.created_at || null
        }
      : null,
    windowMs,
    generatedAt: now,
    customerVisible: rows.some((row) => row.body?.customerVisible === true),
    portalVisible: rows.some((row) => row.body?.portalVisible === true),
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false,
    portalBroadcastSent: false
  };
}

export function summarizeRenewalCustomerConfirmationAcknowledgementQueue({
  windowMs = 30 * 24 * 60 * 60 * 1000,
  now = Date.now(),
  limit = 200
} = {}) {
  const since = Math.max(0, now - windowMs);
  const rows = portalActions.listByType(RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE, { since, limit });
  const byStatus = {};
  let latestAt = null;
  let latestRow = null;
  for (const row of rows) {
    const status = row.status || 'unknown';
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (!latestAt || (row.created_at || 0) > latestAt) {
      latestAt = row.created_at || 0;
      latestRow = row;
    }
  }
  return {
    total: rows.length,
    acknowledgedCount: rows.filter((row) => row.status === 'acknowledged').length,
    byStatus,
    latestAt: latestAt || null,
    latest: latestRow
      ? {
          id: latestRow.id,
          leadId: latestRow.lead_id,
          confirmationId: latestRow.related_id || latestRow.body?.confirmationId || null,
          subscriptionId: latestRow.body?.subscriptionId || null,
          status: latestRow.status,
          createdAt: latestRow.created_at || null
        }
      : null,
    windowMs,
    generatedAt: now,
    customerAcknowledged: rows.some((row) => row.body?.customerAcknowledged === true),
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    checkoutLinkCreated: false,
    liveSideEffects: false,
    portalBroadcastSent: false
  };
}

export async function updateIntake({ leadId, tokenId = null, intake = {} } = {}) {
  const lead = requireLead(leadId);
  const updated = customerIntake.upsert(leadId, normalizeIntakePayload(intake));
  const action = portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'intake_updated',
    status: 'submitted',
    related_type: 'customer_intake',
    related_id: leadId,
    body: updated,
    metadata: { source: 'share_portal' }
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'customer_intake_updated',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer updated build intake',
    body: [
      updated.contactName ? `Contact: ${updated.contactName}` : null,
      updated.contactEmail ? `Email: ${updated.contactEmail}` : null,
      updated.primaryGoal ? `Goal: ${updated.primaryGoal}` : null,
      updated.mustHaveSections?.length ? `Sections: ${updated.mustHaveSections.join(', ')}` : null
    ].filter(Boolean).join('\n') || 'Customer updated intake.',
    metadata: {
      source: 'share_portal',
      portalActionId: action.id,
      decisionCode: 'portal.intake_updated',
      decisionReason: 'Customer supplied build intake details in the portal.'
    }
  });
  try {
    await addDoc(
      containerTagFor(leadId),
      'build_brief',
      { intake: updated, source: 'share_portal' },
      { kindHint: 'customer_intake', source: 'share_portal', portalActionId: action.id, businessName: lead.business_name || null }
    );
  } catch (err) {
    log.warn('portal.intake.memory_failed', { leadId, error: err?.message || String(err) });
  }
  emit('portal.intake_updated', { worker: 'portal', leadId, portalActionId: action.id });
  return { ok: true, intake: updated, action };
}

export async function recordAssetUrl({ leadId, tokenId = null, url, label = null, notes = '' } = {}) {
  const lead = requireLead(leadId);
  const cleanUrl = String(url || '').trim();
  if (!/^(https?:\/\/|mock:\/\/)/i.test(cleanUrl)) {
    const err = new Error('asset URL must be http(s) or mock://');
    err.code = 'invalid_request';
    throw err;
  }
  const asset = { url: cleanUrl, label: label || 'Customer asset', notes: String(notes || '').trim(), addedAt: Date.now() };
  const intake = customerIntake.appendAsset(leadId, asset);
  const action = portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'asset_added',
    status: 'submitted',
    related_type: 'customer_intake',
    related_id: leadId,
    body: asset,
    metadata: { source: 'share_portal' }
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'customer_asset_added',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer added asset URL',
    body: `${asset.label}: ${asset.url}${asset.notes ? `\n${asset.notes}` : ''}`,
    metadata: {
      source: 'share_portal',
      portalActionId: action.id,
      decisionCode: 'portal.asset_added',
      decisionReason: 'Customer attached an asset URL for the website build.'
    }
  });
  try {
    await addDoc(
      containerTagFor(leadId),
      'build_brief',
      { asset, source: 'share_portal' },
      { kindHint: 'customer_asset', source: 'share_portal', portalActionId: action.id, businessName: lead.business_name || null }
    );
  } catch (err) {
    log.warn('portal.asset.memory_failed', { leadId, error: err?.message || String(err) });
  }
  emit('portal.asset_added', { worker: 'portal', leadId, portalActionId: action.id, url: cleanUrl });
  return { ok: true, asset, intake, action };
}

export function approveScope({ leadId, tokenId = null, notes = '' } = {}) {
  requireLead(leadId);
  leads.update(leadId, { next_action: 'pay_invoice' });
  const action = portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'scope_approved',
    status: 'approved',
    body: { notes: String(notes || '').trim() },
    metadata: { source: 'share_portal' },
    resolved_at: Date.now()
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'scope_approved',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer approved website scope',
    body: String(notes || '').trim() || 'Customer approved the $500 website scope.',
    metadata: {
      source: 'share_portal',
      portalActionId: action.id,
      decisionCode: 'portal.scope_approved',
      decisionReason: 'Customer approved the proposed scope before payment/build.'
    }
  });
  emit('portal.scope_approved', { worker: 'portal', leadId, portalActionId: action.id });
  return { ok: true, action };
}

export async function requestRevision({ leadId, tokenId = null, note } = {}) {
  return requestEdit({ leadId, tokenId, note });
}

export async function acceptQuote({ leadId, tokenId = null } = {}) {
  const lead = requireLead(leadId);
  const previousStatus = lead.outreach_status || null;
  if (previousStatus !== 'accepted' && previousStatus !== 'paid') {
    leads.update(leadId, { outreach_status: 'accepted' });
  }

  const existingPayment = payments.listByLead(leadId)[0] || null;
  let invoiceUrl = existingPayment?.hosted_invoice_url || existingPayment?.payment_link_url || null;
  let paymentLinkUrl = existingPayment?.payment_link_url || invoiceUrl || null;
  let blocked = false;
  let blockers = [];
  let invoiceResult = null;

  if (!existingPayment) {
    try {
      invoiceResult = await createOrReuseRevenueInvoice({ leadId });
      if (invoiceResult?.blocked) {
        blocked = true;
        blockers = invoiceResult.gate?.blockers || [];
      } else if (invoiceResult?.invoice) {
        invoiceUrl = invoiceResult.invoice.hostedInvoiceUrl || invoiceResult.invoice.url || null;
        paymentLinkUrl = invoiceResult.payment?.payment_link_url || invoiceUrl;
      }
    } catch (err) {
      blocked = true;
      blockers = [{ code: 'invoice_create_failed', reason: err?.message || String(err) }];
      log.warn('portal.accept_quote.invoice_failed', { leadId, error: err?.message || String(err) });
    }
  }

  portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'quote_accepted',
    status: blocked ? 'blocked' : 'accepted',
    body: { invoiceUrl, paymentLinkUrl },
    metadata: { previousStatus, blockers }
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'quote_accepted',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer accepted quote',
    body: blocked ? 'Quote accepted, invoice blocked by current gate.' : 'Quote accepted in customer portal.',
    metadata: {
      source: 'share_portal',
      blocked,
      blockers,
      decisionCode: 'portal.quote_accepted',
      decisionReason: 'Customer accepted the $500 website quote from the share portal.'
    }
  });
  emit('portal.quote_accepted', { worker: 'portal', leadId, previousStatus, invoiceUrl, paymentLinkUrl, blocked, blockers });
  return {
    ok: !blocked,
    blocked,
    blockers,
    invoiceUrl,
    paymentLinkUrl,
    paymentId: invoiceResult?.payment?.id || existingPayment?.id || null
  };
}

export async function requestEdit({ leadId, tokenId = null, note } = {}) {
  const lead = requireLead(leadId);
  const trimmedNote = String(note || '').trim();
  if (!trimmedNote) {
    const err = new Error('note required');
    err.code = 'invalid_request';
    throw err;
  }

  const eventId = contactEvents.add({
    lead_id: leadId,
    type: 'customer_edit_request',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer edit request via share portal',
    body: trimmedNote,
    metadata: {
      source: 'share_portal',
      decisionCode: 'portal.edit_request',
      decisionReason: 'Customer submitted an edit request from the self-serve portal.'
    }
  });
  portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'revision_requested',
    status: 'submitted',
    related_type: 'contact_event',
    related_id: eventId,
    body: { note: trimmedNote },
    metadata: { source: 'share_portal' }
  });

  let memory = { ok: false };
  try {
    const doc = await addDoc(
      containerTagFor(leadId),
      'build_brief',
      { note: trimmedNote, requestedAt: Date.now() },
      {
        kindHint: 'customer_edit_request',
        source: 'share_portal',
        contactEventId: eventId,
        businessName: lead.business_name || null
      }
    );
    memory = { ok: true, customId: doc?.customId || null };
  } catch (err) {
    memory = { ok: false, error: err?.message || String(err) };
    log.warn('portal.edit_request.memory_failed', { leadId, error: err?.message || String(err) });
  }

  const revision = await persistCustomerRevisionPrompt({ leadId, note: trimmedNote, contactEventId: eventId });
  emit('portal.edit_requested', {
    worker: 'portal',
    leadId,
    contactEventId: eventId,
    revisionId: revision?.revisionId || null,
    notePreview: trimmedNote.slice(0, 200)
  });
  return { ok: true, contactEventId: eventId, memory, revision };
}

export async function approveLaunch({ leadId, tokenId = null, notes = '', now = Date.now() } = {}) {
  const lead = requireLead(leadId);
  const latestBuild = builds.listByLead(leadId)[0] || null;
  if (!latestBuild) {
    const err = new Error('no build found to approve');
    err.code = 'build_not_found';
    throw err;
  }
  const latestQa = buildQaResults.listByBuild(latestBuild.id)[0] || null;
  if (!latestQa?.passed) {
    const err = new Error('build QA has not passed yet');
    err.code = 'qa_not_passed';
    throw err;
  }
  if (latestBuild.customer_approved_at || latestBuild.launch_status === 'customer_approved' || latestBuild.launch_status === 'launched') {
    const aftercare = await seedAftercareAfterLaunchApproval({ leadId, now, source: 'portal_launch_approval_reused' });
    return {
      ok: true,
      reused: true,
      buildId: latestBuild.id,
      launchStatus: latestBuild.launch_status,
      projectUrl: latestBuild.project_url || lead.website || null,
      aftercare
    };
  }

  now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const nextLaunchStatus = 'customer_approved';
  builds.update(latestBuild.id, {
    launch_status: nextLaunchStatus,
    customer_approved_at: now
  });
  leads.update(leadId, {
    status: 'launch_approved',
    next_action: 'operator_launch',
    website: latestBuild.project_url || lead.website || null
  });
  const eventId = contactEvents.add({
    id: `contact_launch_${latestBuild.id}`,
    lead_id: leadId,
    type: 'customer_launch_approved',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer approved site launch',
    body: `Customer approved launch for build ${latestBuild.id}.`,
    metadata: {
      source: 'share_portal',
      buildId: latestBuild.id,
      projectUrl: latestBuild.project_url || null,
      decisionCode: 'portal.launch_approved',
      decisionReason: 'Customer approved the generated website for launch.'
    }
  });
  portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'launch_approved',
    status: 'approved',
    related_type: 'build',
    related_id: latestBuild.id,
    body: { projectUrl: latestBuild.project_url || null, notes: String(notes || '').trim() },
    metadata: { contactEventId: eventId, source: 'share_portal' },
    resolved_at: now
  });
  emit('portal.launch_approved', {
    worker: 'portal',
    leadId,
    buildId: latestBuild.id,
    launchStatus: 'customer_approved',
    projectUrl: latestBuild.project_url || null,
    contactEventId: eventId
  });
  const aftercare = await seedAftercareAfterLaunchApproval({ leadId, now, source: 'portal_launch_approval' });
  return { ok: true, buildId: latestBuild.id, launchStatus: 'customer_approved', projectUrl: latestBuild.project_url || null, contactEventId: eventId, aftercare };
}

async function seedAftercareAfterLaunchApproval({ leadId, now = Date.now(), source = 'portal_launch_approval' } = {}) {
  try {
    const run = await runAccountManagerScheduler({
      leadId,
      dryRun: true,
      forcePlan: true,
      now,
      source
    });
    const state = await readAccountManagerState(leadId);
    return {
      ok: true,
      dryRun: true,
      processed: run.processed,
      planId: state.row?.id || null,
      taskCount: state.tasks?.length || 0,
      pending: state.summary?.pending || 0,
      overdue: state.summary?.overdue || 0
    };
  } catch (err) {
    log.warn('portal.aftercare_seed_failed', { leadId, error: err?.message || String(err) });
    return { ok: false, error: err?.message || String(err) };
  }
}

export function bookCallback({ leadId, tokenId = null, scheduledAtMs, ask } = {}) {
  requireLead(leadId);
  const ts = Number(scheduledAtMs);
  if (!Number.isFinite(ts) || ts <= 0) throw new Error('scheduledAtMs must be a positive number');
  if (ts < Date.now() - 60_000) throw new Error('scheduledAtMs is in the past');

  const id = `sched_portal_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const row = createScheduledCall({
    id,
    leadId,
    threadId: null,
    inboundMessageId: null,
    scheduledAtMs: ts,
    brief: {
      ask: String(ask || '').trim() || 'Customer requested a callback via share portal.',
      source: 'share_portal',
      requestedAtMs: Date.now()
    }
  });
  portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'callback_booked',
    status: 'scheduled',
    related_type: 'scheduled_call',
    related_id: row?.id || id,
    body: { scheduledAtMs: ts, ask }
  });
  contactEvents.add({
    lead_id: leadId,
    type: 'callback_booked',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer booked callback',
    body: String(ask || '').trim() || 'Customer requested a callback via share portal.',
    metadata: {
      source: 'share_portal',
      scheduledCallId: row?.id || id,
      scheduledAtMs: ts,
      decisionCode: 'portal.callback_booked',
      decisionReason: 'Customer booked a callback from the portal.'
    }
  });
  emit('portal.callback_booked', { worker: 'portal', leadId, scheduledCallId: row?.id || id, scheduledAtMs: ts });
  return { ok: true, scheduledCall: row, scheduledCallId: row?.id || id };
}

export function optOut({ leadId, tokenId = null, reason = 'customer_portal_opt_out' } = {}) {
  const lead = requireLead(leadId);
  const phone = normalizePhone(lead.phone);
  if (phone) recordOptOut(phone, { source: 'customer_portal', leadId });

  leads.update(leadId, {
    risk_status: 'opt-out',
    next_action: 'do_not_call',
    consent_status: 'opted_out',
    outreach_status: 'blocked'
  });
  const eventId = contactEvents.add({
    lead_id: leadId,
    type: 'customer_opt_out',
    direction: 'inbound',
    channel: 'portal',
    subject: 'customer opt-out via share portal',
    body: reason,
    metadata: {
      source: 'share_portal',
      reason,
      phoneRecorded: !!phone,
      decisionCode: 'portal.opt_out',
      decisionReason: 'Customer opted out from the share portal.'
    }
  });
  portalActions.add({
    lead_id: leadId,
    token_id: tokenId,
    type: 'opt_out',
    status: 'completed',
    related_type: 'contact_event',
    related_id: eventId,
    body: { reason, phoneRecorded: !!phone },
    resolved_at: Date.now()
  });
  emit('portal.opted_out', { worker: 'portal', leadId, phoneRecorded: !!phone, reason });
  return { ok: true, phoneRecorded: !!phone };
}

export function quoteStatusForLead(lead) {
  if (!lead) return 'not_yet';
  const paymentRows = payments.listByLead(lead.id);
  if (paymentRows.some((p) => p.status === 'paid')) return 'paid';
  if (lead.outreach_status === 'paid') return 'paid';
  if (lead.outreach_status === 'accepted' || paymentRows.length > 0) return 'accepted';
  return 'not_yet';
}

export function paymentLinksForLead(leadId) {
  const rows = payments.listByLead(leadId);
  if (!rows.length) return { paymentLinkUrl: null, invoiceUrl: null };
  const latest = rows[0];
  const invoiceUrl = latest.hosted_invoice_url || latest.payment_link_url || null;
  const paymentLinkUrl = latest.payment_link_url || invoiceUrl;
  return { paymentLinkUrl, invoiceUrl };
}

export function pendingCallbackForLead(leadId) {
  return scheduledCalls.findPendingForLead(leadId) || null;
}

export function portalBriefForLead(lead) {
  const profile = safeJson(lead?.research_json) || {};
  const intelligence = compactLeadIntelligence(profile.leadIntelligence, { evidenceLimit: 8 });
  return {
    businessName: lead?.business_name || profile.businessName || null,
    exactCallOpener: intelligence?.callOpener?.text || null,
    whyThisLeadWasCalled: intelligence?.whyThisLeadIsWorthCalling || null,
    recommendedCta: intelligence?.bestCtaRecommendation || null,
    reviewThemes: intelligence?.reviewThemes || [],
    websiteIssues: intelligence?.currentWebsiteIssues || [],
    missingCustomerInfo: intelligence?.missingCustomerInfo || [],
    sourceTrail: intelligence?.sourceTrail || [],
    evidenceTrace: intelligence ? evidenceTraceText(intelligence, { limit: 6 }) : null,
    confidence: {
      phone: intelligence?.contactConfidence?.phone || null,
      address: intelligence?.contactConfidence?.address || null,
      hours: intelligence?.contactConfidence?.hours || null
    }
  };
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function normalizeIntakePayload(raw = {}) {
  return {
    contactName: raw.contactName ?? raw.contact_name,
    contactEmail: raw.contactEmail ?? raw.contact_email,
    preferredPhone: raw.preferredPhone ?? raw.preferred_phone,
    serviceArea: raw.serviceArea ?? raw.service_area,
    primaryGoal: raw.primaryGoal ?? raw.primary_goal,
    brandVoice: raw.brandVoice ?? raw.brand_voice,
    mustHaveSections: raw.mustHaveSections ?? raw.must_have_sections,
    assetUrls: raw.assetUrls ?? raw.asset_urls,
    notes: raw.notes
  };
}

function buildQaReadModelCompat({ leadId, buildId } = {}) {
  try {
    return buildQaReadModel({ leadId, buildId });
  } catch (err) {
    log.warn('portal.qa_read_failed', { leadId, buildId, error: err?.message || String(err) });
    return { leadId, buildId: buildId || null, status: 'unknown', qaResults: [], latestQa: null, revisions: [], launchChecklist: [] };
  }
}

function emptyIntake(lead) {
  const profile = safeJson(lead.research_json) || {};
  return {
    leadId: lead.id,
    contactName: '',
    contactEmail: profile.bestContactEmail || '',
    preferredPhone: lead.phone || '',
    serviceArea: lead.city || '',
    primaryGoal: '',
    brandVoice: '',
    mustHaveSections: [],
    assetUrls: [],
    notes: '',
    created_at: null,
    updated_at: null
  };
}

function memoryBriefHighlights(leadId) {
  return (memoryDocuments.listByLead?.(leadId, { limit: 30 }) || [])
    .filter((doc) => ['business_profile', 'call_analysis', 'mail_thread', 'invoice', 'build_brief', 'growth_plan'].includes(doc.kind))
    .map((doc) => ({
      kind: doc.kind,
      text: compactText(doc.content_text, 280),
      updatedAt: doc.updated_at,
      source: doc.source_event || doc.source_id || null
    }))
    .slice(0, 8);
}

function portalLaunchChecklist({ intake, quoteStatus, latestPayment, latestBuild, builderQa, revisionRows, approvals, optedOut }) {
  const intakeDone = !!(
    intake?.contactName &&
    intake?.contactEmail &&
    intake?.serviceArea &&
    intake?.primaryGoal &&
    Array.isArray(intake?.mustHaveSections) &&
    intake.mustHaveSections.length
  );
  const openRevisions = (revisionRows || []).filter((row) => !['completed', 'accepted', 'skipped'].includes(row.status));
  const qaPassed = !!(builderQa?.latestQa?.passed || builderQa?.qaResults?.some((row) => row.passed));
  return [
    { id: 'intake', label: 'Intake complete', done: intakeDone, detail: intakeDone ? 'Customer brief is ready.' : 'Need contact, goal, service area, and sections.' },
    { id: 'scope', label: 'Scope approved', done: !!approvals.scope, detail: approvals.scope ? 'Scope approved.' : 'Customer needs to approve scope.' },
    { id: 'quote', label: 'Quote accepted', done: quoteStatus === 'accepted' || quoteStatus === 'paid', detail: `Quote status: ${quoteStatus}.` },
    { id: 'payment', label: 'Invoice paid', done: latestPayment?.status === 'paid' || quoteStatus === 'paid', detail: latestPayment ? `Invoice is ${latestPayment.status}.` : 'Invoice not created yet.' },
    { id: 'build', label: 'Build visible', done: !!(latestBuild?.live_url || latestBuild?.project_url), detail: latestBuild ? `Build is ${latestBuild.status}.` : 'Build not started.' },
    { id: 'qa', label: 'QA passed', done: qaPassed, detail: qaPassed ? 'Latest QA is passing.' : 'QA pending or needs fixes.' },
    { id: 'revisions', label: 'Revision queue clear', done: openRevisions.length === 0, detail: openRevisions.length ? `${openRevisions.length} revision request(s) open.` : 'No open revision requests.' },
    { id: 'launch', label: 'Launch approved', done: !!approvals.launch, detail: approvals.launch ? 'Launch approved.' : 'Customer has not approved launch.' },
    { id: 'privacy', label: 'Privacy preference honored', done: !optedOut, detail: optedOut ? 'Customer opted out.' : 'Contact allowed.' }
  ];
}

function nextPortalAction(checklist, { optedOut, quoteStatus }) {
  if (optedOut) return { id: 'opted_out', label: 'No further contact', tone: 'blocked' };
  const next = checklist.find((item) => !item.done && item.id !== 'privacy');
  if (!next) return { id: 'complete', label: 'Launch approved', tone: 'done' };
  const labels = {
    intake: 'Finish intake',
    scope: 'Approve the scope',
    quote: 'Accept the quote',
    payment: quoteStatus === 'not_yet' ? 'Accept quote first' : 'Pay the invoice',
    build: 'Watch the build',
    qa: 'Wait for QA',
    revisions: 'Review revision queue',
    launch: 'Approve launch'
  };
  return { id: next.id, label: labels[next.id] || next.label, tone: next.id === 'payment' ? 'money' : 'active' };
}

function portalBuildRow(row, lead, progressLog = []) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    liveUrl: row.live_url || null,
    live_url: row.live_url || null,
    projectUrl: row.project_url || null,
    project_url: row.project_url || null,
    finalSiteUrl: row.project_url || lead?.website || null,
    launchStatus: row.launch_status || null,
    launch_status: row.launch_status || null,
    customerApprovedAt: row.customer_approved_at || null,
    customer_approved_at: row.customer_approved_at || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    updatedAt: row.updated_at || null,
    progressLog
  };
}

function portalRevisionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    buildId: row.build_id || null,
    attempt: row.attempt || 1,
    status: row.status,
    prompt: row.prompt,
    result: row.result || null,
    createdAt: row.created_at || null,
    finishedAt: row.finished_at || null
  };
}

function portalActionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    relatedType: row.related_type || null,
    relatedId: row.related_id || null,
    body: row.body || null,
    metadata: row.metadata || null,
    createdAt: row.created_at || null,
    resolvedAt: row.resolved_at || null
  };
}

function portalCallbackRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    scheduledAtMs: row.scheduled_at_ms,
    status: row.status,
    brief: safeJson(row.brief_json),
    createdAt: row.created_at,
    firedAt: row.fired_at || null,
    placedCallId: row.placed_call_id || null
  };
}

function portalContactRow(row) {
  return {
    id: row.id,
    type: row.type,
    direction: row.direction,
    channel: row.channel,
    subject: row.subject,
    body: compactText(row.body, 500),
    metadata: safeJson(row.metadata_json) || {},
    createdAt: row.created_at
  };
}

function subscriptionManagementForLead(leadId, actionRows = []) {
  const rows = subscriptions.forLead(leadId) || [];
  const reviewedByPlaybook = new Map(
    (actionRows || [])
      .filter((row) => row.type === 'renewal_plan_reviewed' && row.related_id)
      .map((row) => [row.related_id, row])
  );
  const changeRequestsByPlaybook = new Map();
  for (const row of actionRows || []) {
    if (row.type !== 'renewal_change_requested' || !row.related_id) continue;
    if (!changeRequestsByPlaybook.has(row.related_id)) changeRequestsByPlaybook.set(row.related_id, []);
    changeRequestsByPlaybook.get(row.related_id).push(row);
  }
  const confirmationsBySubscription = new Map();
  const acknowledgementsByConfirmation = new Map();
  const acceptancesByConfirmation = new Map();
  const closeoutPacketsByConfirmation = new Map();
  for (const row of actionRows || []) {
    if (row.type !== RENEWAL_CUSTOMER_CONFIRMATION_RECEIPT_ACTION_TYPE || !row.body?.subscriptionId) continue;
    const key = row.body.subscriptionId;
    if (!confirmationsBySubscription.has(key)) confirmationsBySubscription.set(key, []);
    confirmationsBySubscription.get(key).push(row);
  }
  for (const row of actionRows || []) {
    if (row.type !== RENEWAL_CUSTOMER_CONFIRMATION_ACK_ACTION_TYPE || !row.related_id) continue;
    if (!acknowledgementsByConfirmation.has(row.related_id)) acknowledgementsByConfirmation.set(row.related_id, []);
    acknowledgementsByConfirmation.get(row.related_id).push(row);
  }
  for (const row of actionRows || []) {
    if (row.type !== RENEWAL_CUSTOMER_CONFIRMATION_ACCEPT_ACTION_TYPE || !row.related_id) continue;
    if (!acceptancesByConfirmation.has(row.related_id)) acceptancesByConfirmation.set(row.related_id, []);
    acceptancesByConfirmation.get(row.related_id).push(row);
  }
  for (const row of actionRows || []) {
    if (row.type !== RENEWAL_CUSTOMER_CONFIRMATION_CLOSEOUT_PACKET_ACTION_TYPE || !row.body?.confirmationId) continue;
    if (!closeoutPacketsByConfirmation.has(row.body.confirmationId)) closeoutPacketsByConfirmation.set(row.body.confirmationId, []);
    closeoutPacketsByConfirmation.get(row.body.confirmationId).push(row);
  }
  const subscriptionRows = rows.map((row) => {
    const playbook = safeToRenewPlaybooks.latestBySubscription(row.id);
    const reviewAction = playbook ? reviewedByPlaybook.get(playbook.id) : null;
    const changeRequests = playbook ? (changeRequestsByPlaybook.get(playbook.id) || []) : [];
    const confirmations = confirmationsBySubscription.get(row.id) || [];
    return portalSubscriptionRow(row, playbook, reviewAction, changeRequests, confirmations, acknowledgementsByConfirmation, acceptancesByConfirmation, closeoutPacketsByConfirmation);
  });
  const active = subscriptionRows.filter((row) => row.active);
  const atRisk = subscriptionRows.filter((row) => row.renewal?.atRisk);
  const confirmations = subscriptionRows.flatMap((row) => row.renewal?.confirmations || []);
  const totalChangeRequests = subscriptionRows.reduce(
    (sum, row) => sum + (row.renewal?.changeRequestCount || 0),
    0
  );
  return {
    subscriptions: subscriptionRows,
    activeCount: active.length,
    atRiskCount: atRisk.length,
    expectedRetainedRevenueCents: atRisk.reduce((sum, row) => sum + (row.renewal?.expectedRetainedRevenueCents || 0), 0),
    customerReviewedCount: subscriptionRows.filter((row) => row.renewal?.customerReviewed).length,
    changeRequestCount: totalChangeRequests,
    confirmationCount: confirmations.length,
    acknowledgementCount: confirmations.filter((row) => row.acknowledged).length,
    acceptanceCount: confirmations.filter((row) => row.accepted).length,
    closeoutPacketCount: confirmations.filter((row) => row.closeoutPacketVisible).length,
    subscriptionsWithConfirmationCount: subscriptionRows.filter((row) => (row.renewal?.confirmationCount || 0) > 0).length,
    subscriptionsWithAcknowledgementCount: subscriptionRows.filter((row) => (row.renewal?.acknowledgementCount || 0) > 0).length,
    subscriptionsWithAcceptanceCount: subscriptionRows.filter((row) => (row.renewal?.acceptanceCount || 0) > 0).length,
    subscriptionsWithCloseoutPacketCount: subscriptionRows.filter((row) => (row.renewal?.closeoutPacketCount || 0) > 0).length,
    subscriptionsWithChangeRequestCount: subscriptionRows.filter((row) => (row.renewal?.changeRequestCount || 0) > 0).length,
    liveSideEffects: confirmations.some((row) => row.sourceLiveSideEffects === true),
    customerMessageSent: confirmations.some((row) => row.customerMessageSent === true),
    subscriptionChanged: confirmations.some((row) => row.subscriptionChanged === true),
    stripeStateChanged: confirmations.some((row) => row.stripeStateChanged === true),
    paymentLinkCreated: confirmations.some((row) => row.paymentLinkCreated === true),
    discountApplied: confirmations.some((row) => row.discountApplied === true),
    priceChanged: confirmations.some((row) => row.priceChanged === true),
    checkoutLinkCreated: confirmations.some((row) => row.checkoutLinkCreated === true),
    confirmationMessageSent: false,
    portalBroadcastSent: false,
    acknowledgementMessageSent: false,
    acceptanceMessageSent: false,
    closeoutMessageSent: false
  };
}

function portalSubscriptionRow(row, playbook = null, reviewAction = null, changeRequestRows = [], confirmationRows = [], acknowledgementsByConfirmation = new Map(), acceptancesByConfirmation = new Map(), closeoutPacketsByConfirmation = new Map()) {
  const changeRequests = Array.isArray(changeRequestRows) ? changeRequestRows : [];
  const confirmations = (Array.isArray(confirmationRows) ? confirmationRows : []).map((action) => (
    portalRenewalConfirmationRow(action, acknowledgementsByConfirmation.get(action.id) || [], acceptancesByConfirmation.get(action.id) || [], closeoutPacketsByConfirmation.get(action.id) || [])
  ));
  const formattedChangeRequests = changeRequests.map((action) => ({
    id: action.id,
    requestType: action.body?.requestType || 'change',
    note: action.body?.note || null,
    status: action.status,
    createdAt: action.created_at,
    operatorReviewRequired: true,
    customerMessageSent: false,
    subscriptionChanged: false,
    stripeStateChanged: false,
    paymentLinkCreated: false,
    discountApplied: false,
    priceChanged: false,
    checkoutLinkCreated: false
  }));
  return {
    id: row.id,
    status: row.status,
    plan: row.plan || null,
    amountCents: row.amount_cents || 0,
    currency: row.currency || 'usd',
    startedAt: row.started_at || null,
    canceledAt: row.canceled_at || null,
    lastEventAt: row.last_event_at || null,
    active: ['active', 'trialing', 'past_due'].includes(row.status),
    renewal: playbook ? {
      ...portalRenewalPlaybookRow(playbook),
      customerReviewed: !!reviewAction,
      reviewAction: reviewAction ? portalActionRow(reviewAction) : null,
      changeRequests: formattedChangeRequests,
      changeRequestCount: formattedChangeRequests.length,
      confirmations,
      confirmationCount: confirmations.length,
      acknowledgementCount: confirmations.filter((confirmation) => confirmation.acknowledged).length,
      acceptanceCount: confirmations.filter((confirmation) => confirmation.accepted).length,
      closeoutPacketCount: confirmations.filter((confirmation) => confirmation.closeoutPacketVisible).length,
      latestConfirmationAt: confirmations[0]?.createdAt || null,
      latestConfirmation: confirmations.length ? confirmations[0] : null,
      latestCloseoutPacketAt: confirmations.find((confirmation) => confirmation.closeoutPacketVisible)?.latestCloseoutPacket?.createdAt || null,
      latestCloseoutPacket: confirmations.find((confirmation) => confirmation.closeoutPacketVisible)?.latestCloseoutPacket || null,
      latestChangeRequestAt: formattedChangeRequests[0]?.createdAt || null,
      latestChangeRequest: formattedChangeRequests.length ? formattedChangeRequests[0] : null
    } : null
  };
}

function portalRenewalConfirmationRow(action, acknowledgementRows = [], acceptanceRows = [], closeoutPacketRows = []) {
  const acknowledgements = (Array.isArray(acknowledgementRows) ? acknowledgementRows : [])
    .slice()
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const latestAcknowledgement = acknowledgements[0] || null;
  const acceptances = (Array.isArray(acceptanceRows) ? acceptanceRows : [])
    .slice()
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const latestAcceptance = acceptances[0] || null;
  const closeoutPackets = (Array.isArray(closeoutPacketRows) ? closeoutPacketRows : [])
    .slice()
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const latestCloseoutPacket = closeoutPackets[0] || null;
  return {
    id: action.id,
    status: action.status,
    createdAt: action.created_at,
    summary: action.body?.summary || null,
    billingExecutionReceiptId: action.body?.billingExecutionReceiptId || null,
    messageSendReceiptId: action.body?.messageSendReceiptId || null,
    sourcePortalActionId: action.body?.sourcePortalActionId || null,
    customerVisible: action.body?.customerVisible === true,
    portalVisible: action.body?.portalVisible === true,
    sourceLiveSideEffects: action.body?.sourceLiveSideEffects === true,
    confirmationLiveSideEffects: action.body?.confirmationLiveSideEffects === true,
    confirmationMessageSent: action.body?.confirmationMessageSent === true,
    portalBroadcastSent: action.body?.portalBroadcastSent === true,
    subscriptionChanged: action.body?.subscriptionChanged === true,
    stripeStateChanged: action.body?.stripeStateChanged === true,
    customerMessageSent: action.body?.customerMessageSent === true,
    agentMailMessageSent: action.body?.agentMailMessageSent === true,
    providerMutationPerformed: action.body?.providerMutationPerformed === true,
    discountApplied: action.body?.discountApplied === true,
    priceChanged: action.body?.priceChanged === true,
    paymentLinkCreated: action.body?.paymentLinkCreated === true,
    checkoutLinkCreated: action.body?.checkoutLinkCreated === true,
    acknowledged: !!latestAcknowledgement,
    acknowledgementCount: acknowledgements.length,
    acknowledgedAt: latestAcknowledgement?.created_at || null,
    latestAcknowledgement: latestAcknowledgement
      ? {
          id: latestAcknowledgement.id,
          status: latestAcknowledgement.status,
          note: latestAcknowledgement.body?.note || null,
          createdAt: latestAcknowledgement.created_at,
          customerMessageSent: false,
          subscriptionChanged: false,
          stripeStateChanged: false,
          paymentLinkCreated: false,
          checkoutLinkCreated: false,
          liveSideEffects: false,
          portalBroadcastSent: false
        }
      : null,
    accepted: !!latestAcceptance,
    acceptanceCount: acceptances.length,
    acceptedAt: latestAcceptance?.created_at || null,
    latestAcceptance: latestAcceptance
      ? {
          id: latestAcceptance.id,
          status: latestAcceptance.status,
          note: latestAcceptance.body?.note || null,
          acknowledgementId: latestAcceptance.body?.acknowledgementId || null,
          createdAt: latestAcceptance.created_at,
          customerMessageSent: false,
          subscriptionChanged: false,
          stripeStateChanged: false,
          paymentLinkCreated: false,
          checkoutLinkCreated: false,
          liveSideEffects: false,
          portalBroadcastSent: false
        }
      : null,
    closeoutPacketVisible: !!latestCloseoutPacket,
    closeoutPacketCount: closeoutPackets.length,
    closeoutPacketAt: latestCloseoutPacket?.created_at || null,
    latestCloseoutPacket: latestCloseoutPacket
      ? {
          id: latestCloseoutPacket.id,
          status: latestCloseoutPacket.status,
          summary: latestCloseoutPacket.body?.summary || null,
          followupReceiptId: latestCloseoutPacket.body?.followupReceiptId || latestCloseoutPacket.related_id || null,
          workItemId: latestCloseoutPacket.body?.workItemId || null,
          acceptanceId: latestCloseoutPacket.body?.acceptanceId || null,
          acknowledgementId: latestCloseoutPacket.body?.acknowledgementId || null,
          nextReviewAt: latestCloseoutPacket.body?.nextReviewAt || null,
          packetItems: Array.isArray(latestCloseoutPacket.body?.packetItems) ? latestCloseoutPacket.body.packetItems : [],
          customerNextSteps: Array.isArray(latestCloseoutPacket.body?.customerNextSteps) ? latestCloseoutPacket.body.customerNextSteps : [],
          createdAt: latestCloseoutPacket.created_at,
          customerMessageSent: false,
          subscriptionChanged: false,
          stripeStateChanged: false,
          paymentLinkCreated: false,
          checkoutLinkCreated: false,
          liveSideEffects: false,
          portalBroadcastSent: false
        }
      : null
  };
}

function portalRenewalPlaybookRow(playbook) {
  if (!playbook) return null;
  return {
    id: playbook.id,
    status: playbook.status,
    priority: playbook.priority,
    churnRisk: playbook.churnRisk,
    atRisk: true,
    expectedRetainedRevenueCents: playbook.expectedRetainedRevenueCents,
    recommendedMotion: playbook.recommendedMotion,
    proofRequired: Array.isArray(playbook.playbook?.proofRequired) ? playbook.playbook.proofRequired : [],
    nextSteps: Array.isArray(playbook.playbook?.nextSteps) ? playbook.playbook.nextSteps : [],
    safety: {
      externalSideEffects: playbook.safety?.externalSideEffects === true,
      customerMessageSent: playbook.safety?.customerMessageSent === true,
      subscriptionChanged: playbook.safety?.subscriptionChanged === true,
      stripeStateChanged: playbook.safety?.stripeStateChanged === true,
      paymentLinkCreated: playbook.safety?.paymentLinkCreated === true,
      operatorApprovalRequired: playbook.safety?.operatorApprovalRequired !== false
    },
    updatedAt: playbook.updatedAt
  };
}

function growthStateForLead(leadId) {
  const latest = growthPlans.getLatest?.(leadId);
  if (!latest) return null;
  return {
    id: latest.id,
    status: latest.status,
    plan: safeJson(latest.plan_json),
    offers: safeJson(latest.offer_json),
    nextServiceId: latest.next_service_id || null,
    generatedAt: latest.generated_at,
    updatedAt: latest.updated_at
  };
}

function accountManagerTimeline({ builderEvents, actionRows, contactRows, callbackRows }) {
  const builder = (builderEvents || []).map((event) => {
    const payload = safeJson(event.payload_json) || {};
    return {
      ts: event.ts || event.created_at,
      type: event.type,
      title: labelize(event.type),
      summary: payload.summary || payload.note || payload.error || payload.projectUrl || payload.liveUrl || '',
      source: 'builder'
    };
  });
  const actions = (actionRows || []).map((action) => ({
    ts: action.created_at,
    type: `portal.${action.type}`,
    title: labelize(action.type),
    summary: compactText(action.body?.note || action.body?.url || action.status, 180),
    source: 'portal'
  }));
  const contacts = (contactRows || []).map((event) => ({
    ts: event.created_at,
    type: `contact.${event.type}`,
    title: labelize(event.type),
    summary: event.subject || compactText(event.body, 180),
    source: event.channel
  }));
  const callbacks = (callbackRows || []).map((row) => ({
    ts: row.created_at,
    type: 'callback.scheduled',
    title: 'Callback scheduled',
    summary: row.scheduled_at_ms ? `Scheduled for ${new Date(row.scheduled_at_ms).toLocaleString()}` : row.status,
    source: 'calls'
  }));
  return [...builder, ...actions, ...contacts, ...callbacks]
    .filter((item) => item.ts)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 40);
}

function compactText(value, max = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function labelize(value) {
  return String(value || 'update').replace(/^builder\./, '').replace(/_/g, ' ');
}

async function persistCustomerRevisionPrompt({ leadId, note, contactEventId }) {
  const latestBuild = builds.listByLead(leadId)[0] || null;
  if (!latestBuild) return { ok: false, skipped: 'no_build' };
  const lead = leads.get(leadId);
  const websiteBrief = parseJson(latestBuild.website_brief_json) || {
    businessName: lead?.business_name || 'the business',
    phone: lead?.phone || '',
    locationOrServiceArea: lead?.city || '',
    services: [],
    cta: 'Call for service or a quote',
    prohibitedClaims: []
  };
  const latestQa = buildQaResults.listByBuild(latestBuild.id)[0] || null;
  const noteHash = shortHash(note);
  const key = `build:${latestBuild.id}:customer_revision:${noteHash}`;
  const existing = buildRevisions.getByIdempotency(key);
  if (existing) return { ok: true, deduped: true, revisionId: existing.id, attempt: existing.attempt, status: existing.status };

  const previous = buildRevisions.listByBuild(latestBuild.id);
  const attempt = Math.max(0, ...previous.map((row) => Number(row.attempt) || 0)) + 1;
  const plan = await createCustomerRevisionPlan({ brief: websiteBrief, qaResult: latestQa, note, attempt, contactEventId });
  const row = buildRevisions.start({
    build_id: latestBuild.id,
    lead_id: leadId,
    attempt,
    qa_result_id: latestQa?.id || null,
    prompt: plan.prompt,
    idempotency_key: key
  });
  const finished = buildRevisions.finish(row.id, {
    status: 'requested',
    result: { source: 'customer_portal', contactEventId, dedupeHash: noteHash, focus: plan.focus, requestedAt: Date.now() }
  });
  builds.update(latestBuild.id, { launch_status: 'revision_requested', customer_approved_at: null, launched_at: null });
  leads.update(leadId, { status: 'revision_requested', next_action: 'builder_customer_revision' });
  emit('builder.revision', {
    worker: 'builder',
    leadId,
    buildId: latestBuild.id,
    attempt,
    revisionId: row.id,
    summary: 'Customer edit request converted into a revision prompt.',
    prompt: plan.prompt,
    source: 'customer_portal'
  });
  return { ok: true, deduped: false, revisionId: finished.id, attempt, status: finished.status };
}

async function createCustomerRevisionPlan({ brief, qaResult, note, attempt, contactEventId }) {
  const seedQa = qaResult || {
    checklist: [{ key: 'customer_edit_request', label: 'Customer edit request', passed: false, severity: 'warn', detail: note }],
    errors: ['customer_edit_request']
  };
  const base = await createRevisionPlan({ brief, qaResult: seedQa, attempt });
  return {
    ...base,
    prompt: [
      `Customer-requested revision ${attempt}: update the generated site for ${brief.businessName}.`,
      '',
      'Apply the customer note below as a targeted edit. Preserve the approved structure, business facts, contact paths, schema, and no-fake-claims guardrails.',
      '',
      `Customer note (${contactEventId}): ${note}`,
      '',
      'Base QA revision guidance:',
      base.prompt
    ].join('\n'),
    focus: unique(['customer_edit_request', ...(base.focus || [])]),
    expectedFixes: unique(['customer requested edit', ...(base.expectedFixes || [])])
  };
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function shortHash(value) {
  return createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex').slice(0, 16);
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}
