import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { log } from '../logger.js';
import { stripeClient } from '../providers/stripe.js';
import { webhookEvents } from '../db.js';
import { emit } from '../sse.js';
import {
  leadIdFromStripeObject,
  recordPaidPayment,
  stripePaymentDetails
} from '../paymentFlow.js';

export function verifyStripe(rawBody, signatureHeader) {
  if (!env.stripe.webhookSecret) {
    log.warn('STRIPE_WEBHOOK_SECRET not set');
    return { ok: false, reason: 'no secret configured' };
  }
  try {
    const event = stripeClient().webhooks.constructEvent(rawBody, signatureHeader, env.stripe.webhookSecret);
    return { ok: true, event };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export function normalizeStripeWebhook(event = {}) {
  const object = event.data?.object || {};
  const eventType = firstString(event.type, object.type, 'stripe.webhook');
  const objectId = stripeId(object.id);
  const invoiceId = eventType.startsWith('invoice.')
    ? objectId
    : stripeId(object.invoice, object.metadata?.stripeInvoiceId);
  const sessionId = eventType === 'checkout.session.completed'
    ? objectId
    : stripeId(object.metadata?.stripeSessionId, object.checkout_session);
  const customerId = stripeId(object.customer, object.customer_details?.customer);
  const leadId = firstString(
    object.metadata?.leadId,
    object.metadata?.lead_id,
    object.client_reference_id,
    object.subscription_details?.metadata?.leadId,
    object.parent?.subscription_details?.metadata?.leadId,
    lineLeadId(object)
  );

  return {
    eventId: firstString(event.id),
    eventType,
    objectType: object.object || null,
    objectId,
    invoiceId,
    sessionId,
    customerId,
    leadId,
    paid: isPaidStripeEvent(eventType, object),
    livemode: Boolean(event.livemode ?? object.livemode),
    created: event.created ? event.created * 1000 : null,
    amountCents: object.amount_paid || object.amount_total || object.amount_due || object.total || null,
    hostedInvoiceUrl: object.hosted_invoice_url || object.url || object.invoice_pdf || null,
    rawObject: object
  };
}

export function stripeWebhookEventId(_req, event = {}, normalized = normalizeStripeWebhook(event)) {
  if (normalized.eventId) return `event:${normalized.eventId}`;
  if (normalized.objectId) return `${normalized.eventType}:${normalized.objectId}`;
  return `payload:${hashPayload({
    eventType: normalized.eventType,
    objectType: normalized.objectType,
    invoiceId: normalized.invoiceId,
    sessionId: normalized.sessionId,
    customerId: normalized.customerId,
    amountCents: normalized.amountCents,
    raw: event
  })}`;
}

export function processStripeWebhookEvent(event = {}, { req = null, startBuilder } = {}) {
  const normalized = normalizeStripeWebhook(event);
  const eventId = stripeWebhookEventId(req, event, normalized);
  const recorded = webhookEvents.recordOnce({
    provider: 'stripe',
    event_id: eventId,
    type: normalized.eventType,
    payload: event
  });
  if (!recorded) return { received: true, duplicate: true, eventId, normalized };

  emit('stripe.webhook', {
    providerType: normalized.eventType,
    eventId,
    leadId: normalized.leadId || null,
    invoiceId: normalized.invoiceId || null,
    objectId: normalized.objectId || null,
    livemode: normalized.livemode
  });

  if (!normalized.paid) {
    return { received: true, duplicate: false, eventId, normalized, paid: false };
  }

  const object = event.data?.object || {};
  const stripeId = normalized.invoiceId || normalized.sessionId || normalized.objectId || object.id;
  const paid = recordPaidPayment(
    stripeId,
    normalized.leadId || leadIdFromStripeObject(object),
    { payment: stripePaymentDetails(object, normalized.eventType), startBuilder }
  );

  emit('stripe.paid', {
    worker: 'stripe',
    leadId: paid.leadId || normalized.leadId || null,
    invoiceId: normalized.invoiceId || stripeId,
    eventId,
    paymentChanged: paid.changed,
    builderTriggerClaimed: paid.builderTriggerClaimed,
    buildTrigger: paid.build?.reason,
    duplicate: false
  });

  return { received: true, duplicate: false, eventId, normalized, paid };
}

export function isPaidStripeEvent(eventType, object = {}) {
  if (eventType === 'checkout.session.completed') {
    return object.payment_status === 'paid' || object.status === 'complete';
  }
  if (eventType === 'invoice.paid' || eventType === 'invoice.payment_succeeded') return true;
  return false;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function stripeId(...values) {
  for (const value of values) {
    if (!value) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'object' && typeof value.id === 'string' && value.id.trim()) return value.id.trim();
  }
  return null;
}

function lineLeadId(object = {}) {
  const line = object.lines?.data?.find((item) => item.metadata?.leadId || item.metadata?.lead_id);
  return firstString(line?.metadata?.leadId, line?.metadata?.lead_id);
}

function hashPayload(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 32);
}

function stableStringify(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
