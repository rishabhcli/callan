import { createHash, randomBytes } from 'node:crypto';
import { commercePlans, contactEvents, leads } from '../db.js';
import { addDoc, containerTagFor } from '../memory.js';
import { emit } from '../sse.js';
import { log } from '../logger.js';
import {
  classifyCommerceRequest,
  commerceSummary,
  createCommercePlan,
  normalizeCommerceIntake
} from './planner.js';

export {
  classifyCommerceRequest,
  commerceSummary,
  createCommercePlan,
  normalizeCommerceIntake
};

export async function planCommerceForLead({
  leadId,
  intake = {},
  source = 'operator',
  force = false,
  contactEvent = null
} = {}) {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`lead not found: ${leadId}`);

  const normalized = normalizeCommerceIntake(intake, { lead, source });
  const idempotencyKey = force ? null : `commerce_plan:${leadId}:${stableHash(normalized)}`;
  const existing = idempotencyKey ? commercePlans.getByIdempotency(idempotencyKey) : null;
  if (existing && !force) {
    return {
      row: existing,
      plan: existing.plan,
      intake: existing.intake,
      reused: true,
      classification: classifyCommerceRequest(intake)
    };
  }

  const id = `cp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const plan = createCommercePlan({ lead, intake: normalized, source, id });
  const row = commercePlans.upsert({
    id,
    lead_id: leadId,
    status: plan.status,
    type: plan.type,
    intake: normalized,
    plan,
    risk_count: plan.riskFlags.length,
    handoff_required: plan.humanHandoff.required ? 1 : 0,
    stripe_mode: plan.stripeBoundary.mode,
    idempotency_key: idempotencyKey
  });

  const body = normalized.rawText || plan.websiteBrief.summary;
  const eventId = contactEvents.add({
    lead_id: leadId,
    type: 'commerce_intake',
    direction: source === 'operator' ? 'internal' : 'inbound',
    channel: source === 'share_portal' ? 'portal' : source === 'agentmail_reply' ? 'agentmail' : 'commerce',
    provider_id: contactEvent?.providerId || contactEvent?.provider_id || null,
    thread_id: contactEvent?.threadId || contactEvent?.thread_id || null,
    subject: contactEvent?.subject || `Commerce setup: ${plan.type}`,
    body,
    metadata: {
      source,
      commercePlanId: row.id,
      commerceType: plan.type,
      stripeMode: plan.stripeBoundary.mode,
      handoffRequired: plan.humanHandoff.required,
      decisionCode: plan.humanHandoff.required ? 'commerce.handoff_required' : 'commerce.plan_ready',
      decisionReason: plan.websiteBrief.summary
    }
  });

  await writeCommerceMemory(lead, plan, row.id, eventId);

  emit('commerce.plan_ready', {
    worker: 'commerce',
    leadId,
    commercePlanId: row.id,
    type: plan.type,
    status: plan.status,
    stripeMode: plan.stripeBoundary.mode,
    handoffRequired: plan.humanHandoff.required
  });

  return {
    row,
    plan,
    intake: normalized,
    contactEventId: eventId,
    reused: false,
    classification: classifyCommerceRequest(intake)
  };
}

export async function submitPortalCommerceIntake({ leadId, intake = {} } = {}) {
  return planCommerceForLead({ leadId, intake, source: 'share_portal' });
}

export async function recordCommerceEmailRequest({
  leadId,
  subject = '',
  text = '',
  threadId = null,
  providerId = null
} = {}) {
  const classification = classifyCommerceRequest({ subject, text });
  if (!leadId || classification.kind === 'none') return { classification, planned: false };
  if (classification.kind === 'handoff') {
    return { classification, planned: false };
  }
  const result = await planCommerceForLead({
    leadId,
    intake: { rawText: `${subject}\n${text}` },
    source: 'agentmail_reply',
    contactEvent: { subject, threadId, providerId }
  });
  return { classification, planned: true, ...result };
}

export function readCommerceState(leadId) {
  const latest = commercePlans.getLatest(leadId);
  return {
    row: latest,
    plan: latest?.plan || null,
    intake: latest?.intake || null,
    history: commercePlans.listByLead(leadId, { limit: 10 })
  };
}

export function commerceStatus() {
  return {
    plans: commercePlans.summary(),
    capabilities: {
      intake: [
        'products/services/packages',
        'prices/ranges',
        'deposit/full payment intent',
        'booking requirements',
        'customer-supplied refund/cancellation text',
        'fulfillment/delivery/pickup notes',
        'regulated/tax-sensitive flags'
      ],
      planTypes: [
        'quote_request',
        'booking_deposit',
        'service_checkout',
        'product_catalog',
        'menu_inquiry',
        'subscription_membership',
        'handoff_only'
      ],
      stripeBoundary: 'customer commerce is separate from Callan paymentFlow.js invoices and hostingSubscription.js',
      liveCustomerCommerceGate: ['CUSTOMER_COMMERCE_LIVE_STRIPE_LINKS=true', 'LIVE_PAYMENTS=true', 'CUSTOMER_COMMERCE_STRIPE_ACCOUNT_ID']
    }
  };
}

async function writeCommerceMemory(lead, plan, rowId, contactEventId) {
  try {
    await addDoc(
      lead.container_tag || containerTagFor(lead.id),
      'commerce_plan',
      plan,
      {
        source: plan.source,
        commercePlanId: rowId,
        contactEventId,
        businessName: lead.business_name || null,
        commerceType: plan.type,
        stripeMode: plan.stripeBoundary.mode
      }
    );
  } catch (err) {
    log.warn('commerce.memory.add_failed', {
      leadId: lead.id,
      commercePlanId: rowId,
      error: err?.message || String(err)
    });
  }
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}
