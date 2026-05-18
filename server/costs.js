/**
 * Per-lead per-provider cost ledger. Every paid action our agent stack takes
 * funnels through `recordCost` so the dashboard can show real margin per lead.
 *
 * Pricing constants reflect publicly-disclosed sponsor pricing as of 2026-05.
 * Adjust as your contracts evolve.
 */

import crypto from 'node:crypto';
import { leadCosts, payments as paymentsDb } from './db.js';
import { log } from './logger.js';

const COST_PREFIX = 'cost_';

// ---- pricing knobs ---------------------------------------------------------
export const PRICING = Object.freeze({
  AGENTPHONE_USD_PER_MIN: 0.18,          // hosted voice + STT + TTS bundled
  GEMINI_USD_PER_1K_TOKENS_PRO: 0.0015,
  GEMINI_USD_PER_1K_TOKENS_FLASH: 0.00025,
  AGENTMAIL_USD_PER_SEND: 0.005,
  BROWSER_USE_USD_PER_STEP: 0.012,
  SUPERMEMORY_USD_PER_DOC: 0.0008,
  STRIPE_PCT_FEE: 0.029,
  STRIPE_FIXED_FEE_USD: 0.30
});

function shortId() {
  return `${COST_PREFIX}${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function safeRecord(args) {
  try {
    leadCosts.record({ id: shortId(), ...args });
  } catch (err) {
    log.warn('costs.record_failed', { error: err?.message || String(err), provider: args.provider, kind: args.kind });
  }
}

export function recordAgentPhoneCallCost({ leadId, durationSeconds, callId }) {
  if (!leadId || !Number.isFinite(durationSeconds)) return;
  const minutes = durationSeconds / 60;
  const usd = minutes * PRICING.AGENTPHONE_USD_PER_MIN;
  safeRecord({
    lead_id: leadId,
    provider: 'agentphone',
    kind: 'call_minute',
    usd,
    units: minutes,
    unit_label: 'min',
    metadata: { callId, durationSeconds }
  });
}

export function recordGeminiTokens({ leadId, model, inputTokens = 0, outputTokens = 0, kind = 'reasoning' }) {
  if (!leadId) return;
  const total = (Number(inputTokens) || 0) + (Number(outputTokens) || 0);
  if (!total) return;
  const isFlash = String(model || '').toLowerCase().includes('flash');
  const rate = isFlash ? PRICING.GEMINI_USD_PER_1K_TOKENS_FLASH : PRICING.GEMINI_USD_PER_1K_TOKENS_PRO;
  const usd = (total / 1000) * rate;
  safeRecord({
    lead_id: leadId,
    provider: 'gemini',
    kind,
    usd,
    units: total,
    unit_label: 'token',
    metadata: { model, inputTokens, outputTokens }
  });
}

export function recordAgentMailSend({ leadId, messageId, threadId, kind = 'email_send' }) {
  if (!leadId) return;
  safeRecord({
    lead_id: leadId,
    provider: 'agentmail',
    kind,
    usd: PRICING.AGENTMAIL_USD_PER_SEND,
    units: 1,
    unit_label: 'send',
    metadata: { messageId, threadId }
  });
}

export function recordBrowserUseSteps({ leadId, sessionId, steps }) {
  if (!leadId || !Number.isFinite(steps) || steps <= 0) return;
  safeRecord({
    lead_id: leadId,
    provider: 'browser_use',
    kind: 'browser_step',
    usd: steps * PRICING.BROWSER_USE_USD_PER_STEP,
    units: steps,
    unit_label: 'step',
    metadata: { sessionId }
  });
}

export function recordSupermemoryDoc({ leadId, customId, providerDocumentId }) {
  if (!leadId) return;
  safeRecord({
    lead_id: leadId,
    provider: 'supermemory',
    kind: 'doc_write',
    usd: PRICING.SUPERMEMORY_USD_PER_DOC,
    units: 1,
    unit_label: 'doc',
    metadata: { customId, providerDocumentId }
  });
}

export function recordStripeFee({ leadId, amountCents }) {
  if (!leadId || !Number.isFinite(amountCents) || amountCents <= 0) return;
  const usd = (amountCents / 100) * PRICING.STRIPE_PCT_FEE + PRICING.STRIPE_FIXED_FEE_USD;
  safeRecord({
    lead_id: leadId,
    provider: 'stripe',
    kind: 'processing_fee',
    usd,
    units: 1,
    unit_label: 'transaction',
    metadata: { amountCents }
  });
}

/**
 * Sum revenue (paid invoices + active subscription value) against ledger cost.
 */
export function marginForLead(leadId) {
  if (!leadId) return null;
  const costs = leadCosts.totalsForLead(leadId);
  const costUsd = costs.reduce((acc, r) => acc + r.usd, 0);
  const paymentRows = paymentsDb.listByLead?.(leadId) || [];
  const paidCents = paymentRows
    .filter((p) => p.status === 'paid')
    .reduce((acc, p) => acc + (Number(p.amount_cents) || 0), 0);
  const revenueUsd = paidCents / 100;
  return {
    costUsd,
    revenueUsd,
    marginUsd: revenueUsd - costUsd,
    byProvider: costs,
    paidInvoices: paymentRows.filter((p) => p.status === 'paid').length
  };
}
