import { builds, leads, payments } from './db.js';

export function recordPaidPayment(
  stripeId,
  metadataLeadId,
  { payment = {}, startBuilder, staleAfterMs = 10 * 60 * 1000 } = {}
) {
  const leadIdFromDetails = payment.lead_id || payment.leadId || metadataLeadId || null;
  const result = payments.markPaid(stripeId, {
    ...payment,
    lead_id: leadIdFromDetails || undefined
  });
  const leadId = leadIdFromDetails || result.row?.lead_id;
  if (!leadId) return { ...result, leadId: null, builderTriggerClaimed: false, build: { shouldStart: false, reason: 'missing_lead' } };

  leads.update(leadId, {
    status: 'paid',
    next_action: 'build',
    outreach_status: 'paid'
  });

  if (!result.row) return { ...result, leadId, builderTriggerClaimed: false, build: { shouldStart: false, reason: 'missing_payment' } };
  if (typeof startBuilder !== 'function') {
    return { ...result, leadId, builderTriggerClaimed: false, build: { shouldStart: false, reason: 'no_start_builder' } };
  }

  const trigger = payments.claimBuilderTrigger(result.row.id);
  const build = trigger.claimed
    ? builds.reservePaidBuild({ lead_id: leadId, trigger_key: `payment:${result.row.id}`, staleAfterMs })
    : { shouldStart: false, reason: 'already_triggered', row: null };
  if (build.shouldStart && build.row) startBuilder({ leadId, buildId: build.row.id, triggerKey: build.row.trigger_key });
  return {
    ...result,
    row: trigger.row || result.row,
    leadId,
    builderTriggerClaimed: trigger.claimed,
    build
  };
}

export function leadIdFromStripeObject(obj = {}) {
  const lineWithLead = obj.lines?.data?.find((line) => line.metadata?.leadId || line.metadata?.lead_id);
  return (
    obj.metadata?.leadId ||
    obj.metadata?.lead_id ||
    lineWithLead?.metadata?.leadId ||
    lineWithLead?.metadata?.lead_id ||
    obj.client_reference_id ||
    obj.subscription_details?.metadata?.leadId ||
    obj.parent?.subscription_details?.metadata?.leadId ||
    null
  );
}

export function stripePaymentDetails(obj = {}, eventType = 'stripe.paid') {
  const invoiceId = obj.object === 'invoice' || String(eventType).startsWith('invoice.')
    ? obj.id
    : obj.invoice || obj.metadata?.stripeInvoiceId || null;
  const sessionId = obj.object === 'checkout.session' || eventType === 'checkout.session.completed'
    ? obj.id
    : obj.metadata?.stripeSessionId || null;
  const hostedUrl = obj.hosted_invoice_url || obj.url || obj.invoice_pdf || null;
  const paidAt = obj.status_transitions?.paid_at ? obj.status_transitions.paid_at * 1000 : Date.now();
  const dueAt = obj.due_date ? obj.due_date * 1000 : null;

  return {
    lead_id: leadIdFromStripeObject(obj),
    stripe_session_id: sessionId || invoiceId || obj.id,
    stripe_invoice_id: invoiceId || sessionId || obj.id,
    stripe_customer_id: normalizeStripeId(obj.customer),
    hosted_invoice_url: hostedUrl,
    payment_link_url: hostedUrl,
    amount_cents: obj.amount_paid || obj.amount_total || obj.amount_due || obj.total || null,
    due_at: dueAt,
    paid_at: paidAt,
    idempotency_key: `stripe_paid:${obj.id || invoiceId || sessionId || eventType}`
  };
}

export function recoverTriggeredPaymentBuilds({ startBuilder, staleAfterMs = 10 * 60 * 1000, limit = 25 } = {}) {
  if (typeof startBuilder !== 'function') return [];
  const recovered = [];

  for (const payment of payments.listTriggeredBuildsMissingRows?.({ limit }) || []) {
    const triggerKey = `payment:${payment.id}`;
    const reserved = builds.reservePaidBuild?.({ lead_id: payment.lead_id, trigger_key: triggerKey, staleAfterMs });
    if (reserved?.shouldStart && reserved.row) {
      const claimed = builds.claimRecovery?.(reserved.row.id, { staleAfterMs });
      if (!claimed?.claimed) continue;
      startBuilder({ leadId: payment.lead_id, buildId: claimed.row.id, triggerKey, recovered: true });
      recovered.push({ leadId: payment.lead_id, paymentId: payment.id, buildId: claimed.row?.id, reason: reserved.reason });
    }
  }

  for (const build of builds.recoverablePaidBuilds?.({ staleAfterMs, limit }) || []) {
    const claimed = builds.claimRecovery?.(build.id, { staleAfterMs });
    if (claimed?.claimed) {
      startBuilder({ leadId: build.lead_id, buildId: build.id, triggerKey: build.trigger_key, recovered: true });
      recovered.push({ leadId: build.lead_id, buildId: build.id, reason: 'recoverable_build' });
    }
  }

  return recovered;
}

function normalizeStripeId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.id || null;
}
