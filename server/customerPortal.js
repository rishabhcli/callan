/**
 * Customer-facing self-serve portal handlers.
 *
 * Powers `/share/build/:token/*` endpoints — the customer can accept the quote,
 * pay the invoice, request edits, book callbacks, or opt out from a single
 * URL gated by `token === lead.id`. Each handler is a thin, idempotent shim
 * over existing flow modules (paymentFlow, scheduledCalls, compliance, memory)
 * so the portal stays in lockstep with the rest of the system.
 */

import { randomBytes } from 'node:crypto';
import { leads, payments, contactEvents, scheduledCalls } from './db.js';
import { createOrReuseRevenueInvoice } from './paymentFlow.js';
import { createScheduledCall } from './scheduledCalls.js';
import { recordOptOut, normalizePhone } from './compliance.js';
import { addDoc, containerTagFor } from './memory.js';
import { emit } from './sse.js';
import { log } from './logger.js';

/** Throws if the lead does not exist. Returns the lead row otherwise. */
function requireLead(leadId) {
  const lead = leads.get(leadId);
  if (!lead) {
    const err = new Error(`lead ${leadId} not found`);
    err.code = 'lead_not_found';
    throw err;
  }
  return lead;
}

/**
 * Flip a lead to `accepted` and create-or-reuse the Stripe revenue invoice.
 *
 * Idempotent: relies on `createOrReuseRevenueInvoice`'s idempotency_key
 * lookup so re-clicks of "Accept" never spawn a duplicate invoice. If the
 * invoice gate blocks (e.g. no confirmed email), we still flip outreach_status
 * so the operator/dashboard reflects intent, and surface a structured
 * `blocked` flag in the response.
 */
export async function acceptQuote({ leadId } = {}) {
  const lead = requireLead(leadId);
  const previousStatus = lead.outreach_status || null;

  // Flip outreach_status idempotently. We don't change it again if Stripe
  // later marks the payment 'paid' — webhooks own that transition.
  if (previousStatus !== 'accepted' && previousStatus !== 'paid') {
    leads.update(leadId, { outreach_status: 'accepted' });
  }

  // Reuse an existing invoice when one is already on file for this lead.
  // The paymentFlow gate also re-uses any prior payment row keyed by the
  // (lead, email, offer_version) idempotency key.
  const existingPayments = payments.listByLead(leadId);
  const existingPayment = existingPayments[0] || null;
  let invoiceUrl = existingPayment?.hosted_invoice_url || null;
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
      log.warn('portal.accept_quote.invoice_failed', {
        leadId,
        error: err?.message || String(err)
      });
      blocked = true;
      blockers = [{ code: 'invoice_create_failed', reason: err?.message || String(err) }];
    }
  } else {
    invoiceUrl = existingPayment.hosted_invoice_url || existingPayment.payment_link_url || null;
    paymentLinkUrl = existingPayment.payment_link_url || invoiceUrl;
  }

  emit('portal.quote_accepted', {
    worker: 'portal',
    leadId,
    previousStatus,
    invoiceUrl,
    paymentLinkUrl,
    blocked,
    blockers
  });

  return {
    ok: !blocked,
    blocked,
    blockers,
    invoiceUrl,
    paymentLinkUrl,
    paymentId: invoiceResult?.payment?.id || existingPayment?.id || null
  };
}

/**
 * Persist a customer edit request:
 *   - one `contact_events` row (type=customer_edit_request, inbound, portal)
 *   - one Supermemory doc (`build_brief`) so the builder picks it up
 */
export async function requestEdit({ leadId, note } = {}) {
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
      decisionReason: 'Customer submitted edit request from self-serve portal.'
    }
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
    log.warn('portal.edit_request.memory_failed', {
      leadId,
      error: err?.message || String(err)
    });
    memory = { ok: false, error: err?.message || String(err) };
  }

  emit('portal.edit_requested', {
    worker: 'portal',
    leadId,
    contactEventId: eventId,
    notePreview: trimmedNote.slice(0, 200)
  });

  return { ok: true, contactEventId: eventId, memory };
}

/**
 * Book an outbound callback. Reuses `createScheduledCall` (the same path as
 * an inbound email reply), so the scheduled-call loop owns dispatch.
 */
export function bookCallback({ leadId, scheduledAtMs, ask } = {}) {
  requireLead(leadId);
  const ts = Number(scheduledAtMs);
  if (!Number.isFinite(ts) || ts <= 0) {
    const err = new Error('scheduledAtMs must be a positive number');
    err.code = 'invalid_request';
    throw err;
  }
  if (ts < Date.now() - 60_000) {
    const err = new Error('scheduledAtMs is in the past');
    err.code = 'invalid_request';
    throw err;
  }

  const id = `sched_portal_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const brief = {
    ask: String(ask || '').trim() || 'Customer requested a callback via share portal.',
    source: 'share_portal',
    requestedAtMs: Date.now()
  };

  const row = createScheduledCall({
    id,
    leadId,
    threadId: null,
    inboundMessageId: null,
    scheduledAtMs: ts,
    brief
  });

  emit('portal.callback_booked', {
    worker: 'portal',
    leadId,
    scheduledCallId: row?.id || id,
    scheduledAtMs: ts
  });

  return { ok: true, scheduledCall: row, scheduledCallId: row?.id || id };
}

/**
 * Customer-initiated opt-out. Mirrors `optOutLeadFromOutreach` but routed
 * through the portal channel so we can audit it separately. Adds the lead's
 * phone to the DNC list and stamps `risk_status = 'opt-out'`.
 */
export function optOut({ leadId, reason = 'customer_portal_opt_out' } = {}) {
  const lead = requireLead(leadId);
  const phone = normalizePhone(lead.phone);
  if (phone) {
    recordOptOut(phone, { source: 'customer_portal', leadId });
  }

  leads.update(leadId, {
    risk_status: 'opt-out',
    next_action: 'do_not_call',
    consent_status: 'opted_out',
    outreach_status: 'blocked'
  });

  contactEvents.add({
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

  emit('portal.opted_out', {
    worker: 'portal',
    leadId,
    phoneRecorded: !!phone,
    reason
  });

  return { ok: true, phoneRecorded: !!phone };
}

/**
 * Compute the quote status for a lead, used by the polling GET endpoint.
 * Returns one of: 'accepted' | 'not_yet' | 'paid'.
 */
export function quoteStatusForLead(lead) {
  if (!lead) return 'not_yet';
  const paymentRows = payments.listByLead(lead.id);
  if (paymentRows.some((p) => p.status === 'paid')) return 'paid';
  if (lead.outreach_status === 'paid') return 'paid';
  if (lead.outreach_status === 'accepted' || paymentRows.length > 0) return 'accepted';
  return 'not_yet';
}

/**
 * Pick the customer-facing payment link for a lead (latest open payment).
 */
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
