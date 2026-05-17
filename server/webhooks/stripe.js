import Stripe from 'stripe';
import { env } from '../env.js';
import { log } from '../logger.js';

let _stripe;
export function stripeClient() {
  if (!_stripe) {
    if (!env.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY missing');
    _stripe = new Stripe(env.stripe.secretKey, { apiVersion: '2024-12-18.acacia' });
  }
  return _stripe;
}

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
