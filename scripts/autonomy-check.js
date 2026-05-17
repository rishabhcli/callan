// Local autonomy checks that avoid real provider side effects.
// Covers phone normalization, persistent opt-out, invoice idempotency,
// synthetic inbound AgentMail handling, and webhook idempotency.

import { normalizePhone, recordOptOut, dncCheck, recordingDisclosure } from '../server/compliance.js';
import { contactEvents, leads, payments, webhookEvents } from '../server/db.js';
import { containerTagFor } from '../server/memory.js';
import { handleAgentMailInbound } from '../server/workers/mailReply.js';

const results = [];
const pass = (name, detail = '') => results.push({ name, ok: true, detail });
const fail = (name, detail = '') => results.push({ name, ok: false, detail });

function checkPhoneNormalization() {
  const normalized = normalizePhone('(415) 555-0199');
  if (normalized === '+4155550199') pass('phone.normalize', normalized);
  else fail('phone.normalize', `got ${normalized}`);
}

function checkOptOutPersistence() {
  const phone = `+1415555${String(Date.now()).slice(-4)}`;
  recordOptOut(phone);
  const check = dncCheck(phone, { disclosureText: recordingDisclosure('Test Business') });
  if (!check.ok && /opt-out/i.test(check.reason)) pass('compliance.optout_persistent', check.reason);
  else fail('compliance.optout_persistent', JSON.stringify(check));
}

function checkInvoiceIdempotency() {
  const leadId = `autocheck_${Date.now().toString(36)}`;
  leads.insert({
    id: leadId,
    container_tag: containerTagFor(leadId),
    business_name: 'Autonomy Check Studio',
    phone: '+14155550111',
    address: '1 Market St, San Francisco, CA',
    niche: 'design',
    city: 'San Francisco',
    website: null,
    status: 'discovered'
  });
  const idempotencyKey = `invoice_${leadId}_50000`;
  payments.insert({
    id: `pay_${leadId}`,
    lead_id: leadId,
    stripe_session_id: `in_${leadId}`,
    stripe_invoice_id: `in_${leadId}`,
    stripe_customer_id: `cus_${leadId}`,
    payment_link_url: `https://invoice.stripe.com/i/${leadId}`,
    hosted_invoice_url: `https://invoice.stripe.com/i/${leadId}`,
    amount_cents: 50000,
    status: 'created',
    due_at: Date.now() + 86400000,
    idempotency_key: idempotencyKey
  });
  const found = payments.getByIdempotency(idempotencyKey);
  if (found?.stripe_invoice_id === `in_${leadId}`) pass('stripe.invoice_idempotency_lookup', found.id);
  else fail('stripe.invoice_idempotency_lookup', 'payment not found by idempotency key');
}

async function checkInboundAgentMail() {
  const leadId = `mailcheck_${Date.now().toString(36)}`;
  const threadId = `thread_${leadId}`;
  leads.insert({
    id: leadId,
    container_tag: containerTagFor(leadId),
    business_name: 'Mail Check Bakery',
    phone: '+14155550112',
    address: '2 Market St, San Francisco, CA',
    niche: 'bakery',
    city: 'San Francisco',
    website: null,
    status: 'awaiting_payment',
    agentmail_thread_id: threadId
  });
  const result = await handleAgentMailInbound({
    id: `evt_${leadId}`,
    type: 'message.received',
    direction: 'inbound',
    threadId,
    messageId: `msg_${leadId}`,
    from: { email: 'owner@example.com' },
    subject: 'Question',
    text: 'Please unsubscribe me from this.'
  });
  const events = contactEvents.listByLead(leadId);
  const hasInbound = events.some((e) => e.type === 'customer_reply');
  const hasReply = events.some((e) => e.direction === 'outbound' && e.channel === 'agentmail');
  if (!result.ignored && hasInbound && hasReply) pass('agentmail.inbound_auto_reply', result.classification.kind);
  else fail('agentmail.inbound_auto_reply', JSON.stringify({ result, events: events.length }));
}

function checkWebhookIdempotency() {
  const eventId = `evt_check_${Date.now().toString(36)}`;
  webhookEvents.record({ provider: 'stripe', event_id: eventId, type: 'invoice.paid', payload: { ok: true } });
  if (webhookEvents.seen('stripe', eventId)) pass('webhook.idempotency', eventId);
  else fail('webhook.idempotency', 'event not recorded');
}

async function main() {
  checkPhoneNormalization();
  checkOptOutPersistence();
  checkInvoiceIdempotency();
  await checkInboundAgentMail();
  checkWebhookIdempotency();

  console.log('\n=== AUTONOMY CHECK RESULTS ===\n');
  for (const r of results) console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('autonomy-check crashed:', err);
  process.exit(2);
});
