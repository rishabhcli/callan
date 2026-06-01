import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { env } from '../env.js';
import { normalizeProviderError, providerConfigured, sideEffectGate, smokeDetail } from './core.js';

export const STRIPE_API_VERSION = '2026-02-25.clover';
const PROVIDER = 'stripe';

let _stripe;

export function stripeClient() {
  if (!_stripe) {
    if (!env.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY missing');
    _stripe = new Stripe(env.stripe.secretKey, { apiVersion: STRIPE_API_VERSION });
  }
  return _stripe;
}

export function normalizeStripeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function stripeConfigured(config = env.stripe) {
  return providerConfigured({ STRIPE_SECRET_KEY: config.secretKey });
}

export function stripeReadinessDetails(config = env.stripe) {
  const configured = stripeConfigured(config);
  return {
    configured: configured.configured,
    missing: configured.missing,
    apiVersion: STRIPE_API_VERSION,
    keyMode: stripeKeyMode(config.secretKey),
    invoiceMode: 'hosted_invoice_primary',
    productName: config.productName,
    priceCents: config.priceCents,
    webhook: config.webhookSecret ? 'configured' : 'missing_secret',
    smoke: env.smoke.stripeInvoice ? 'enabled_by_SMOKE_STRIPE_INVOICE' : 'disabled_by_default'
  };
}

export function stripeKeyMode(key = env.stripe.secretKey) {
  if (!key) return 'missing';
  if (/^rk_test_/.test(key)) return 'restricted_test';
  if (/^sk_test_/.test(key)) return 'secret_test';
  if (/^rk_live_/.test(key)) return 'restricted_live';
  if (/^sk_live_/.test(key)) return 'secret_live';
  return 'unknown';
}

export function classifyStripeFailure(err) {
  const normalized = normalizeProviderError(err);
  const msg = String(normalized.message || '').toLowerCase();
  const status = Number(normalized.status || 0) || null;
  const code = String(normalized.code || '').toLowerCase();
  const type = String(err?.type || err?.rawType || err?.raw?.type || '').toLowerCase();

  let category = 'unknown';
  let retryable = normalized.retryable;
  if (status === 401 || status === 403 || /\b(auth|api key|permission|restricted|forbidden|unauthorized)\b/.test(msg)) {
    category = 'auth';
    retryable = false;
  } else if (status === 429 || type.includes('rate') || /\b(rate.?limit|too many requests)\b/.test(msg)) {
    category = 'rate-limited';
    retryable = true;
  } else if (type.includes('idempotency') || /\bidempotenc/.test(msg)) {
    category = 'idempotency-conflict';
    retryable = false;
  } else if (type.includes('invalid_request') || /\b(invalid|missing|required|bad request|parameter)\b/.test(msg)) {
    category = 'validation';
    retryable = false;
  } else if (type.includes('card') || code.includes('card')) {
    category = 'card-declined';
    retryable = false;
  } else if (/\b(test key|live key|livemode)\b/.test(msg)) {
    category = 'mode-mismatch';
    retryable = false;
  } else if (/\b(timeout|timed out|abort)\b/.test(msg) || code === 'timeout') {
    category = 'timeout';
    retryable = true;
  } else if (/\b(fetch failed|network|econn|enotfound|etimedout|socket)\b/.test(msg)) {
    category = 'network';
    retryable = true;
  } else if (status && status >= 500) {
    category = 'provider-error';
    retryable = true;
  } else if (status && status >= 400) {
    category = 'provider-rejected';
    retryable = false;
  }

  return {
    ...normalized,
    category,
    outcome: `failed:${category}`,
    retryable: retryable ?? true
  };
}

function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function cleanMetadata(value) {
  const out = {};
  for (const [key, val] of Object.entries(value || {})) {
    if (val === undefined || val === null) continue;
    out[key] = String(val).slice(0, 500);
  }
  return out;
}

export function isTestStripeKey(key = env.stripe.secretKey) {
  return /^s?k_test_/.test(key) || /^rk_test_/.test(key);
}

function bool(value) {
  return value === 'true' || value === '1' || value === 'yes';
}

async function findReusableCustomer(stripe, { email, leadId }) {
  const normalizedEmail = normalizeStripeEmail(email);
  if (!normalizedEmail) return { customer: null, reused: false, reason: 'missing_email' };

  const res = await stripe.customers.list({ email: normalizedEmail, limit: 10 });
  const exactMatches = (res?.data || []).filter((customer) => {
    if (customer.deleted) return false;
    return normalizeStripeEmail(customer.email) === normalizedEmail;
  });

  const sameLead = exactMatches.find((customer) => {
    const metadata = customer.metadata || {};
    return metadata.leadId === String(leadId) || metadata.callmemaybeLeadId === String(leadId);
  });
  if (sameLead) return { customer: sameLead, reused: true, reason: 'same_lead_metadata' };
  if (exactMatches.length) return { customer: exactMatches[0], reused: true, reason: exactMatches.length === 1 ? 'single_email_match' : 'first_normalized_email_match' };

  return {
    customer: null,
    reused: false,
    reason: 'not_found'
  };
}

async function getOrCreateInvoiceCustomer(stripe, { leadId, businessName, toEmail, idempotencyKey }) {
  const email = normalizeStripeEmail(toEmail);
  if (!email) throw new Error('Stripe invoice requires a customer email');

  const reusable = await findReusableCustomer(stripe, { email, leadId });
  if (reusable.customer) return reusable;

  const customer = await stripe.customers.create(
    {
      email,
      name: businessName,
      metadata: cleanMetadata({
        leadId,
        callmemaybeLeadId: leadId,
        source: 'callmemaybe',
        reuseSkipped: reusable.reason
      })
    },
    { idempotencyKey: `${idempotencyKey}:customer:${shortHash(email)}` }
  );

  return { customer, reused: false, reason: reusable.reason };
}

export async function createHostedInvoice({
  leadId,
  businessName,
  toEmail,
  idempotencyKey,
  amountCents = env.stripe.priceCents,
  productName = env.stripe.productName,
  daysUntilDue = 7,
  offerVersion,
  metadata = {}
}) {
  if (!idempotencyKey) throw new Error('Stripe invoice idempotencyKey missing');
  const email = normalizeStripeEmail(toEmail);

  try {
    const stripe = stripeClient();
    const customerResult = await getOrCreateInvoiceCustomer(stripe, {
      leadId,
      businessName,
      toEmail,
      idempotencyKey
    });
    const customer = customerResult.customer;
    const invoiceMetadata = cleanMetadata({
      leadId,
      callmemaybeLeadId: leadId,
      source: 'callmemaybe',
      offerVersion,
      ...metadata
    });

    await stripe.invoiceItems.create(
      {
        customer: customer.id,
        amount: amountCents,
        currency: 'usd',
        description: `${productName} for ${businessName}`,
        metadata: invoiceMetadata
      },
      { idempotencyKey: `${idempotencyKey}:item` }
    );

    const invoice = await stripe.invoices.create(
      {
        customer: customer.id,
        collection_method: 'send_invoice',
        days_until_due: daysUntilDue,
        auto_advance: false,
        metadata: invoiceMetadata
      },
      { idempotencyKey: `${idempotencyKey}:invoice` }
    );

    const finalized = invoice.status === 'draft'
      ? await stripe.invoices.finalizeInvoice(invoice.id, {}, { idempotencyKey: `${idempotencyKey}:finalize` })
      : invoice;

    if (!finalized.hosted_invoice_url) {
      throw new Error(`Stripe invoice ${finalized.id} finalized without a hosted_invoice_url`);
    }

    return {
      id: finalized.id,
      customerId: customer.id,
      customerEmail: email,
      amountCents,
      status: finalized.status || invoice.status || 'open',
      url: finalized.hosted_invoice_url,
      hostedInvoiceUrl: finalized.hosted_invoice_url,
      invoicePdf: finalized.invoice_pdf || null,
      invoicePdfUrl: finalized.invoice_pdf || null,
      dueAt: finalized.due_date ? finalized.due_date * 1000 : null,
      offerVersion: offerVersion || metadata.offerVersion || null,
      customerReused: customerResult.reused,
      customerReuseReason: customerResult.reason
    };
  } catch (err) {
    throw stripeAdapterError(err, 'createHostedInvoice');
  }
}

export async function applyStripeSubscriptionChange({
  stripeSubscriptionId,
  changeType = 'other',
  targetStripePriceId = null,
  idempotencyKey,
  metadata = {}
} = {}) {
  if (!stripeSubscriptionId) throw new Error('Stripe subscription id required');
  if (!idempotencyKey) throw new Error('Stripe subscription change idempotencyKey missing');
  const cleanChangeType = String(changeType || 'other').toLowerCase();
  const cleanMetadataPayload = cleanMetadata({
    source: 'callmemaybe_renewal_billing_change',
    changeType: cleanChangeType,
    ...metadata
  });

  try {
    const stripe = stripeClient();
    let updatePayload;
    if (cleanChangeType === 'cancel') {
      updatePayload = {
        cancel_at_period_end: true,
        metadata: cleanMetadataPayload
      };
    } else if (cleanChangeType === 'pause') {
      updatePayload = {
        pause_collection: { behavior: 'mark_uncollectible' },
        metadata: cleanMetadataPayload
      };
    } else if (cleanChangeType === 'resume') {
      updatePayload = {
        pause_collection: null,
        cancel_at_period_end: false,
        metadata: cleanMetadataPayload
      };
    } else if (targetStripePriceId) {
      const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
        expand: ['items.data.price']
      });
      const item = subscription?.items?.data?.[0] || null;
      if (!item?.id) throw new Error(`Stripe subscription ${stripeSubscriptionId} has no editable subscription item`);
      updatePayload = {
        items: [{ id: item.id, price: targetStripePriceId }],
        proration_behavior: 'none',
        metadata: cleanMetadataPayload
      };
    } else {
      throw new Error(`Stripe subscription change ${cleanChangeType} requires targetStripePriceId`);
    }

    const updated = await stripe.subscriptions.update(
      stripeSubscriptionId,
      updatePayload,
      { idempotencyKey }
    );
    const updatedItem = updated?.items?.data?.[0] || null;
    return {
      id: updated.id,
      status: updated.status || null,
      cancelAtPeriodEnd: updated.cancel_at_period_end === true,
      currentPeriodEnd: updated.current_period_end ? updated.current_period_end * 1000 : null,
      pauseCollection: updated.pause_collection || null,
      subscriptionItemId: updatedItem?.id || null,
      stripePriceId: updatedItem?.price?.id || updatedItem?.price || null,
      metadata: updated.metadata || {}
    };
  } catch (err) {
    throw stripeAdapterError(err, 'applyStripeSubscriptionChange');
  }
}

export async function createStripeSmokeInvoice() {
  if (!bool(process.env.SMOKE_STRIPE_INVOICE)) {
    throw new Error('SMOKE_STRIPE_INVOICE=true is required to create a Stripe smoke invoice');
  }
  if (!isTestStripeKey()) {
    throw new Error('Stripe smoke invoices require a test key (sk_test_ or rk_test_)');
  }

  const email = process.env.SMOKE_TEST_EMAIL || 'smoke@example.com';
  const amountCents = Number(process.env.SMOKE_STRIPE_PRICE_CENTS || 100);
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('SMOKE_STRIPE_PRICE_CENTS must be a positive integer');
  const smokeDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const idempotencyKey =
    process.env.SMOKE_STRIPE_IDEMPOTENCY_KEY ||
    `smoke_invoice_${smokeDate}_${shortHash(`${normalizeStripeEmail(email)}:${amountCents}`)}`;

  return createHostedInvoice({
    leadId: `smoke_${smokeDate}`,
    businessName: 'callmemaybe smoke test',
    toEmail: email,
    idempotencyKey,
    amountCents,
    productName: 'callmemaybe Stripe smoke invoice',
    metadata: { smoke: 'true' }
  });
}

export async function smokeStripeHostedInvoice() {
  const configured = stripeConfigured();
  if (!configured.configured) {
    return { provider: PROVIDER, status: 'missing', detail: smokeDetail({ skipped: configured.missing.join(', ') }) };
  }

  const gate = sideEffectGate({
    provider: PROVIDER,
    action: 'hosted invoice smoke',
    enabled: env.smoke.stripeInvoice,
    details: { toggle: 'SMOKE_STRIPE_INVOICE', keyMode: stripeKeyMode() }
  });
  if (!gate.ok) {
    return { provider: PROVIDER, status: 'configured', detail: smokeDetail({ skipped: gate.reason, extra: gate.details }) };
  }
  if (!isTestStripeKey()) {
    return {
      provider: PROVIDER,
      status: 'blocked',
      detail: smokeDetail({
        skipped: 'Stripe smoke invoices require a test key (sk_test_ or rk_test_)',
        extra: { keyMode: stripeKeyMode() }
      })
    };
  }

  const invoice = await createStripeSmokeInvoice();
  return {
    provider: PROVIDER,
    status: 'ok',
    detail: smokeDetail({
      dryRun: false,
      live: true,
      extra: {
        invoiceId: invoice.id,
        customerId: invoice.customerId,
        hostedInvoiceUrl: invoice.hostedInvoiceUrl,
        customerReused: invoice.customerReused
      }
    })
  };
}

function stripeAdapterError(err, action) {
  const classified = classifyStripeFailure(err);
  const wrapped = new Error(`${PROVIDER}.${action} failed: ${classified.message || 'provider request failed'}`);
  Object.assign(wrapped, classified, { provider: PROVIDER, action, cause: err });
  return wrapped;
}
