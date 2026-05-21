/**
 * Customer-facing self-serve portal handlers.
 *
 * Powers `/share/build/:token/*`: quote acceptance, edit requests, callbacks,
 * launch approval, commerce intake, and opt-out all land in the same lead,
 * audit, and build revision tables used by the operator console.
 */

import { createHash, randomBytes } from 'node:crypto';
import { env } from './env.js';
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
  scheduledCalls
} from './db.js';
import { createOrReuseRevenueInvoice } from './paymentFlow.js';
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
