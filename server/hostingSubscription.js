// Hosting/edits monthly subscription ($29/mo) sold AFTER the one-shot $500 build
// ships. Flow:
//   1. builder.done -> durable hosting.upsell job -> sendHostingUpsellEmail.
//   2. /api/hosting/accept/:leadId -> acceptHostingSubscription -> Stripe Checkout
//      session (subscription mode) -> 302 to the Checkout URL.
//   3. customer.subscription.* webhook -> handleStripeSubscriptionEvent ->
//      subscriptions.upsert + leads.subscription_id link.
//
// Idempotency: callers must check that leads.subscription_id IS NULL (or no
// active row in subscriptions.forLead) before sending the upsell. Both
// sendHostingUpsellEmail and the builder.done hook guard against double-send.

import { randomBytes } from 'node:crypto';
import { env } from './env.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { leads, subscriptions, payments, contactEvents } from './db.js';
import { stripeClient } from './providers/stripe.js';
import { sendAgentMailMessage } from './providers/agentmail.js';

export const STRIPE_PRICE_ID_HOSTING = process.env.STRIPE_PRICE_ID_HOSTING || '';

const HOSTING_PLAN_LABEL = 'hosting_plus_edits_29';
const HOSTING_DEFAULT_AMOUNT_CENTS = 2900;
const HOSTING_DEFAULT_CURRENCY = 'usd';

function publicUrl() {
  return env.publicUrl || process.env.APP_PUBLIC_URL || 'http://localhost:8787';
}

function genId() {
  return `sub_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function pickLeadEmail(lead) {
  if (!lead) return null;
  // payments.customer_email is the most reliable source — it's what the
  // customer confirmed before the $500 invoice was finalized.
  const paymentRows = payments.listByLead(lead.id) || [];
  for (const row of paymentRows) {
    if (row?.customer_email) return row.customer_email;
  }
  if (lead.email) return lead.email;
  return null;
}

function alreadyHasSubscription(leadId) {
  const lead = leads.get(leadId);
  if (lead?.subscription_id) return true;
  const rows = subscriptions.forLead(leadId) || [];
  return rows.some((row) => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(row.status));
}

function alreadySentHostingUpsell(leadId) {
  if (!leadId) return false;
  return (contactEvents.listByLead(leadId, { limit: 200 }) || []).some((row) => (
    row.direction === 'outbound'
    && row.channel === 'agentmail'
    && row.type === 'hosting_upsell'
  ));
}

function buildHostingEmailBody({ leadId, businessName, acceptUrl, optOutUrl }) {
  const name = businessName || 'team';
  const text = [
    `Hi ${name},`,
    '',
    'Your new site is live — congrats. Want us to keep it that way?',
    '',
    'For $29/month we cover:',
    '  - Hosting + SSL + uptime monitoring on your custom domain',
    '  - 30 minutes of edits each month (copy, photos, sections, hours, menus, etc.)',
    '  - Priority email support — reply to this thread any time',
    '',
    'One-click accept (no signup, just Stripe Checkout):',
    acceptUrl,
    '',
    'Cancel any time from the Stripe customer portal — no contracts, no platform fees.',
    '',
    'Questions? Reply here and a human will answer.',
    '',
    `Don't want this email? Opt out: ${optOutUrl}`
  ].join('\n');

  const html = `
<p>Hi ${escapeHtml(name)},</p>
<p>Your new site is live — congrats. Want us to keep it that way?</p>
<p><strong>$29/month</strong> covers:</p>
<ul>
  <li>Hosting + SSL + uptime monitoring on your custom domain</li>
  <li><strong>30 minutes of edits each month</strong> (copy, photos, sections, hours, menus, etc.)</li>
  <li>Priority email support — reply to this thread any time</li>
</ul>
<p><a href="${escapeAttr(acceptUrl)}" style="display:inline-block;padding:12px 18px;background:#7dffb6;color:#0b1116;text-decoration:none;font-weight:600;border-radius:6px;">Accept &amp; subscribe — $29/mo</a></p>
<p style="color:#6b7280;font-size:13px;">Cancel any time from the Stripe customer portal — no contracts, no platform fees.</p>
<p>Questions? Reply here and a human will answer.</p>
<p style="color:#9ca3af;font-size:12px;">Don't want this email? <a href="${escapeAttr(optOutUrl)}">Opt out</a>.</p>
`.trim();

  return { text, html };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function maskEmail(value) {
  const text = String(value || '');
  const [local, domain] = text.split('@');
  if (!local || !domain) return text ? '***' : null;
  return `${local[0]}***@${domain}`;
}

/**
 * Send the $29/mo hosting upsell. Silent-skip with a log.warn when the price
 * isn't configured or the lead already has a subscription. Never throws — the
 * caller (builder.done) must keep running.
 */
export async function sendHostingUpsellEmail({ leadId, toEmail, lead } = {}) {
  if (!leadId) {
    log.warn('hosting_upsell.skipped', { reason: 'missing_lead_id' });
    return { sent: false, reason: 'missing_lead_id' };
  }

  if (!STRIPE_PRICE_ID_HOSTING) {
    log.warn('hosting_upsell.skipped', { leadId, reason: 'missing_STRIPE_PRICE_ID_HOSTING' });
    return { sent: false, reason: 'missing_price_id' };
  }

  const leadRow = lead || leads.get(leadId);
  if (!leadRow) {
    log.warn('hosting_upsell.skipped', { leadId, reason: 'lead_not_found' });
    return { sent: false, reason: 'lead_not_found' };
  }

  if (alreadyHasSubscription(leadId)) {
    log.info('hosting_upsell.skipped', { leadId, reason: 'already_subscribed' });
    return { sent: false, reason: 'already_subscribed' };
  }

  if (alreadySentHostingUpsell(leadId)) {
    log.info('hosting_upsell.skipped', { leadId, reason: 'already_sent' });
    return { sent: false, reason: 'already_sent' };
  }

  const recipient = toEmail || pickLeadEmail(leadRow);
  if (!recipient) {
    log.warn('hosting_upsell.skipped', { leadId, reason: 'no_recipient_email' });
    return { sent: false, reason: 'no_recipient_email' };
  }

  const base = publicUrl().replace(/\/+$/, '');
  const acceptUrl = `${base}/api/hosting/accept/${encodeURIComponent(leadId)}`;
  const optOutUrl = `${base}/api/optout?lead=${encodeURIComponent(leadId)}&topic=hosting`;
  const { text, html } = buildHostingEmailBody({
    leadId,
    businessName: leadRow.business_name,
    acceptUrl,
    optOutUrl
  });
  const subject = `Keep ${leadRow.business_name || 'your site'} online — $29/mo hosting + 30 min of edits`;

  try {
    const result = await sendAgentMailMessage({
      toEmail: recipient,
      subject,
      text,
      html,
      labels: ['hosting_upsell'],
      leadId,
      costKind: 'hosting_upsell'
    }, { timeoutSeconds: 15, maxRetries: 2 });

    try {
      contactEvents.add({
        lead_id: leadId,
        type: 'hosting_upsell',
        direction: 'outbound',
        channel: 'agentmail',
        provider_id: result?.providerId || result?.messageId || null,
        thread_id: result?.threadId || null,
        subject,
        body: text,
        metadata: {
          plan: HOSTING_PLAN_LABEL,
          amountCents: HOSTING_DEFAULT_AMOUNT_CENTS,
          currency: HOSTING_DEFAULT_CURRENCY,
          acceptUrl,
          optOutUrl,
          messageId: result?.messageId || null,
          toMasked: maskEmail(recipient),
          decisionCode: 'agentmail.outbound.hosting_upsell',
          decisionReason: 'customer received a completed site and no active hosting/edit-care subscription is linked'
        }
      });
    } catch (err) {
      log.warn('hosting_upsell.contact_event_failed', { leadId, error: err?.message || String(err) });
    }

    emit('hosting_upsell.sent', {
      worker: 'hostingSubscription',
      leadId,
      messageId: result?.messageId || null,
      threadId: result?.threadId || null
    });
    log.info('hosting_upsell.sent', {
      leadId,
      messageId: result?.messageId || null,
      threadId: result?.threadId || null
    });
    return {
      sent: true,
      messageId: result?.messageId || null,
      threadId: result?.threadId || null,
      acceptUrl
    };
  } catch (err) {
    log.warn('hosting_upsell.failed', { leadId, error: err?.message || String(err) });
    return { sent: false, reason: 'send_failed', error: err?.message || String(err) };
  }
}

/**
 * Customer-facing accept handler. Creates a Stripe Checkout session in
 * subscription mode for $29/mo hosting and returns the URL for a 302.
 */
export async function acceptHostingSubscription({ leadId } = {}) {
  if (!leadId) throw new Error('acceptHostingSubscription requires leadId');
  if (!STRIPE_PRICE_ID_HOSTING) throw new Error('STRIPE_PRICE_ID_HOSTING is not configured');

  const lead = leads.get(leadId);
  if (!lead) throw new Error(`lead ${leadId} not found`);

  const customerEmail = pickLeadEmail(lead);
  const base = publicUrl().replace(/\/+$/, '');
  const successUrl = `${base}/hosting/thanks?lead=${encodeURIComponent(leadId)}`;
  const cancelUrl = `${base}/share/build/${encodeURIComponent(leadId)}`;

  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: STRIPE_PRICE_ID_HOSTING, quantity: 1 }],
    customer_email: customerEmail || undefined,
    client_reference_id: leadId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: {
        leadId,
        callmemaybeLeadId: leadId,
        plan: HOSTING_PLAN_LABEL,
        source: 'callmemaybe.hosting_upsell'
      }
    },
    metadata: {
      leadId,
      callmemaybeLeadId: leadId,
      plan: HOSTING_PLAN_LABEL
    }
  });

  emit('hosting_subscription.checkout_created', {
    worker: 'hostingSubscription',
    leadId,
    sessionId: session.id
  });
  log.info('hosting_subscription.checkout_created', {
    leadId,
    sessionId: session.id,
    customerEmailMasked: customerEmail ? `${customerEmail[0]}…@${customerEmail.split('@')[1] || '…'}` : null
  });

  return { url: session.url, sessionId: session.id };
}

/**
 * Process a customer.subscription.{created|updated|deleted} event. Upsert into
 * subscriptions, set leads.subscription_id. Resolves the lead from
 * client_reference_id (when present on the parent Checkout session), the
 * subscription metadata (leadId / callmemaybeLeadId), or the customer's
 * metadata.leadId as a last resort.
 */
export async function handleStripeSubscriptionEvent(event = {}) {
  const eventType = event.type || '';
  if (!eventType.startsWith('customer.subscription.')) {
    return { ok: false, reason: 'not_subscription_event' };
  }

  const subscription = event.data?.object || {};
  const stripeSubscriptionId = subscription.id || null;
  if (!stripeSubscriptionId) {
    log.warn('hosting_subscription.event_missing_id', { eventType });
    return { ok: false, reason: 'missing_subscription_id' };
  }

  const stripeCustomerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : (subscription.customer?.id || null);

  const item = subscription.items?.data?.[0] || {};
  const price = item.price || {};
  const stripePriceId = price.id || null;
  const amountCents = Number.isFinite(price.unit_amount) ? price.unit_amount : null;
  const currency = price.currency || subscription.currency || HOSTING_DEFAULT_CURRENCY;

  const status = subscription.status || 'unknown';
  const startedAt = subscription.start_date ? subscription.start_date * 1000
    : subscription.created ? subscription.created * 1000
      : null;
  const canceledAt = subscription.canceled_at ? subscription.canceled_at * 1000
    : (eventType === 'customer.subscription.deleted' && subscription.ended_at ? subscription.ended_at * 1000 : null);

  let leadId = subscription.metadata?.leadId
    || subscription.metadata?.lead_id
    || subscription.metadata?.callmemaybeLeadId
    || null;

  // Fall back to the Checkout session that originated this subscription —
  // client_reference_id is set when we call acceptHostingSubscription.
  if (!leadId && stripeSubscriptionId) {
    try {
      const stripe = stripeClient();
      const sessions = await stripe.checkout.sessions.list({ subscription: stripeSubscriptionId, limit: 1 });
      const session = sessions?.data?.[0];
      leadId = session?.client_reference_id
        || session?.metadata?.leadId
        || session?.metadata?.lead_id
        || session?.metadata?.callmemaybeLeadId
        || null;
    } catch (err) {
      log.warn('hosting_subscription.session_lookup_failed', {
        stripeSubscriptionId,
        error: err?.message || String(err)
      });
    }
  }

  // As a final fallback, try to find a prior subscription row that already
  // has the customer linked (handles renewal/updated events when metadata
  // was lost on initial create).
  if (!leadId && stripeSubscriptionId) {
    const prior = subscriptions.byStripeId(stripeSubscriptionId);
    if (prior?.lead_id) leadId = prior.lead_id;
  }

  if (!leadId) {
    log.warn('hosting_subscription.unlinked_event', {
      eventType,
      stripeSubscriptionId,
      stripeCustomerId
    });
    return { ok: false, reason: 'no_lead_id', stripeSubscriptionId };
  }

  const planLabel = subscription.metadata?.plan || HOSTING_PLAN_LABEL;
  const row = subscriptions.upsert({
    id: genId(),
    lead_id: leadId,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_customer_id: stripeCustomerId,
    stripe_price_id: stripePriceId,
    status,
    plan: planLabel,
    amount_cents: amountCents ?? HOSTING_DEFAULT_AMOUNT_CENTS,
    currency,
    started_at: startedAt,
    canceled_at: canceledAt,
    metadata: {
      eventType,
      cancel_at_period_end: !!subscription.cancel_at_period_end,
      current_period_end: subscription.current_period_end || null
    }
  });

  if (row?.id) {
    const lead = leads.get(leadId);
    if (lead && lead.subscription_id !== row.id) {
      leads.update(leadId, { subscription_id: row.id });
    }
  }

  emit('hosting_subscription.event', {
    worker: 'hostingSubscription',
    leadId,
    eventType,
    status,
    stripeSubscriptionId,
    subscriptionRowId: row?.id || null
  });
  log.info('hosting_subscription.event', {
    eventType,
    leadId,
    status,
    stripeSubscriptionId
  });

  return { ok: true, leadId, stripeSubscriptionId, status, row };
}
