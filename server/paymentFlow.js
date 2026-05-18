import { createHash, randomBytes } from 'node:crypto';
import { builds, calls, contactEvents, db, leads, payments, runs } from './db.js';
import { canPay, env } from './env.js';
import { createHostedInvoice, normalizeStripeEmail } from './providers/stripe.js';
import { priceCentsForLead } from './verticalPacks/index.js';
import { currentArmForLead, recordOutcome as recordExperimentOutcome } from './experiments.js';
import { PITCH_EXPERIMENT_KEY } from './experimentArms.js';
import { log } from './logger.js';
import { recordStripeFee } from './costs.js';

/**
 * Pick the invoice amount for a lead, preferring the lead's matched vertical
 * pack and falling back to the env STRIPE_PRICE_USD_CENTS default. Always
 * returns a finite cents value so downstream Stripe calls do not blow up if a
 * pack file is malformed.
 */
export function revenuePriceCentsForLead(lead) {
  const packPrice = priceCentsForLead(lead);
  if (Number.isFinite(packPrice) && packPrice > 0) return packPrice;
  return env.stripe.priceCents;
}

export const REVENUE_OFFER_VERSION = 'website-flat-500-v1';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const OPT_OUT_RE = /\b(unsubscribe|remove me|opt[-\s]?out|take me off|stop (?:emailing|contacting|calling|messaging)|do not (?:email|contact|call|message)|don't (?:email|contact|call|message))\b/i;
const EXPLICIT_INTEREST_RE = [
  /\b(send|email).{0,60}\b(invoice|bill|payment link|stripe)\b/i,
  /\b(invoice|bill|payment link|stripe).{0,60}\b(send|email|over|link)\b/i,
  /\b(send it over|send that over|send me (?:it|the invoice|the bill|the link))\b/i,
  /\b(let'?s do it|go ahead|move forward|sign me up|sounds good|i'?ll pay|ready to pay)\b/i,
  /\b(five hundred|500|\$500).{0,80}\b(flat|works|okay|ok|fine|send|go ahead)\b/i
];

export function normalizeRevenueEmail(email) {
  return normalizeStripeEmail(email);
}

export function revenueInvoiceIdempotencyKey({ leadId, email, offerVersion = REVENUE_OFFER_VERSION }) {
  const normalizedEmail = normalizeRevenueEmail(email);
  if (!leadId || !normalizedEmail) return null;
  return `invoice:${leadId}:${shortHash(normalizedEmail)}:${offerVersion}`;
}

export function loadLatestPostMortemFromRuns(leadId) {
  const rows = runs.list({ lead_id: leadId, limit: 20 });
  for (const row of rows) {
    if (row.worker !== 'analyst' || !row.detail_json) continue;
    const detail = safeJson(row.detail_json);
    const postMortem = detail?.postMortem || detail?.post_mortem || detail?.analysis || null;
    if (postMortem) return postMortem;
  }
  return null;
}

export function evaluateInvoiceGate({
  lead,
  leadId = lead?.id,
  toEmail,
  postMortem,
  callRows,
  contactRows,
  offerVersion = REVENUE_OFFER_VERSION
} = {}) {
  const resolvedLead = lead || (leadId ? leads.get(leadId) : null);
  const resolvedLeadId = resolvedLead?.id || leadId || null;
  const normalizedEmail = normalizeRevenueEmail(toEmail || postMortem?.invoiceEmail || postMortem?.emailConfirmation?.email);
  const resolvedCalls = callRows || (resolvedLeadId ? calls.listByLead(resolvedLeadId) : []);
  const resolvedContacts = contactRows || (resolvedLeadId ? contactEvents.listByLead(resolvedLeadId, { limit: 80 }) : []);
  const transcripts = resolvedCalls.map((row) => parseTranscript(row.transcript_json)).filter((turns) => turns.length);
  const interest = findTranscriptInterest(transcripts);
  const emailProof = findConfirmedEmailProof({ transcripts, postMortem, normalizedEmail });
  const optOut = findOptOutEvidence({ lead: resolvedLead, transcripts, contactRows: resolvedContacts });
  const existingConsentEvent = findInvoiceConsentEvent({
    leadId: resolvedLeadId,
    email: normalizedEmail,
    offerVersion,
    contactRows: resolvedContacts
  });
  const idempotencyKey = revenueInvoiceIdempotencyKey({
    leadId: resolvedLeadId,
    email: normalizedEmail,
    offerVersion
  });
  const blockers = [];

  if (!resolvedLead) blockers.push(blocker('lead_missing', 'Lead was not found.'));
  if (!interest.ok) blockers.push(blocker('missing_transcript_backed_interest', 'No owner transcript turn explicitly asked to proceed or receive an invoice.'));
  // Email gate: we only require an email exists. We do NOT require a verbal read-back
  // confirmation in the transcript — when the customer says "send the invoice", the
  // invoice goes out immediately to the email they gave us.
  if (!normalizedEmail) blockers.push(blocker('missing_customer_email', 'No customer email is available to send the invoice to.'));
  if (optOut.found) blockers.push(blocker('customer_opted_out', optOut.reason));

  return {
    ok: blockers.length === 0,
    leadId: resolvedLeadId,
    normalizedEmail,
    offerVersion,
    idempotencyKey,
    blockers,
    evidence: {
      interest,
      email: emailProof,
      optOut,
      consentEvent: existingConsentEvent
        ? {
            id: existingConsentEvent.id,
            createdAt: existingConsentEvent.created_at,
            source: 'contact_events'
          }
        : null
    }
  };
}

export function ensureInvoiceConsentEvent({
  leadId,
  email,
  offerVersion = REVENUE_OFFER_VERSION,
  gate,
  source = 'paymentFlow'
} = {}) {
  const normalizedEmail = normalizeRevenueEmail(email || gate?.normalizedEmail);
  if (!leadId || !normalizedEmail) throw new Error('invoice consent requires leadId and email');
  const existing = findInvoiceConsentEvent({ leadId, email: normalizedEmail, offerVersion });
  if (existing) return { id: existing.id, inserted: false, row: existing };

  const id = `invoice_consent_${safeId(leadId)}_${shortHash(`${normalizedEmail}:${offerVersion}`)}`;
  try {
    const eventId = contactEvents.add({
      id,
      lead_id: leadId,
      type: 'invoice_consent',
      direction: 'internal',
      channel: 'revenue',
      provider_id: null,
      thread_id: null,
      subject: 'Transcript-backed invoice consent',
      body: gate?.evidence?.interest?.excerpt || 'Customer gave transcript-backed invoice consent.',
      metadata: {
        email: normalizedEmail,
        offerVersion,
        source,
        allowed: true,
        decisionCode: 'invoice_consent.transcript_backed',
        decisionReason: 'Transcript shows explicit interest and confirmed invoice email.',
        gate: compactGateForMetadata(gate)
      }
    });
    return { id: eventId, inserted: true, row: findInvoiceConsentEvent({ leadId, email: normalizedEmail, offerVersion }) };
  } catch (err) {
    if (!/UNIQUE constraint failed: contact_events\.id/i.test(err?.message || '') && !err?.code?.startsWith?.('SQLITE_CONSTRAINT')) throw err;
    const row = findInvoiceConsentEvent({ leadId, email: normalizedEmail, offerVersion });
    return { id, inserted: false, row };
  }
}

export async function createOrReuseRevenueInvoice({
  leadId,
  toEmail,
  postMortem,
  profile,
  offerVersion = REVENUE_OFFER_VERSION,
  amountCents,
  productName = env.stripe.productName,
  daysUntilDue = 7
} = {}) {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`lead ${leadId} not found`);
  const resolvedAmountCents = Number.isFinite(amountCents) && amountCents > 0
    ? amountCents
    : revenuePriceCentsForLead(lead);
  const callRows = calls.listByLead(leadId);
  const contactRows = contactEvents.listByLead(leadId, { limit: 100 });
  const gate = evaluateInvoiceGate({ lead, toEmail, postMortem, callRows, contactRows, offerVersion });
  if (!gate.ok) return { blocked: true, gate };

  const consent = ensureInvoiceConsentEvent({ leadId, email: gate.normalizedEmail, offerVersion, gate });
  gate.evidence.consentEvent = {
    id: consent.id,
    inserted: consent.inserted,
    source: 'contact_events'
  };

  const existingPayment = payments.getByIdempotency(gate.idempotencyKey);
  if (existingPayment) {
    return {
      blocked: false,
      gate,
      payment: existingPayment,
      invoice: invoiceFromPayment(existingPayment),
      idempotent: true,
      reused: true,
      mockInvoice: isMockPayment(existingPayment)
    };
  }

  const businessName = lead.business_name || profile?.businessName || 'your business';
  const invoice = shouldMockInvoices()
    ? createMockInvoice({
        leadId,
        businessName,
        toEmail: gate.normalizedEmail,
        idempotencyKey: gate.idempotencyKey,
        amountCents: resolvedAmountCents,
        productName,
        daysUntilDue
      })
    : await createHostedInvoice({
        leadId,
        businessName,
        toEmail: gate.normalizedEmail,
        idempotencyKey: gate.idempotencyKey,
        amountCents: resolvedAmountCents,
        productName,
        daysUntilDue,
        offerVersion,
        metadata: {
          offerVersion,
          invoiceConsentEventId: consent.id,
          confirmedEmail: gate.normalizedEmail,
          verticalPack: lead.vertical_pack || null
        }
      });

  const saved = payments.insertOrGetByIdempotency({
    id: `pay_${shortHash(gate.idempotencyKey)}_${randomBytes(3).toString('hex')}`,
    lead_id: leadId,
    stripe_session_id: invoice.id,
    stripe_invoice_id: invoice.id,
    stripe_customer_id: invoice.customerId || null,
    customer_email: gate.normalizedEmail,
    payment_link_url: invoice.url || invoice.hostedInvoiceUrl,
    hosted_invoice_url: invoice.hostedInvoiceUrl || invoice.url,
    invoice_pdf_url: invoice.invoicePdfUrl || invoice.invoicePdf || null,
    amount_cents: invoice.amountCents || resolvedAmountCents,
    status: invoice.status || 'open',
    due_at: invoice.dueAt || null,
    idempotency_key: gate.idempotencyKey,
    offer_version: offerVersion
  });

  const payment = saved.row;
  return {
    blocked: false,
    gate,
    payment,
    invoice: invoiceFromPayment(payment),
    idempotent: !saved.inserted,
    reused: !saved.inserted,
    mockInvoice: shouldMockInvoices()
  };
}

export function existingInvoiceEmailEvent({ leadId, paymentId, idempotencyKey } = {}) {
  if (!leadId) return null;
  return contactEvents.listByLead(leadId, { limit: 100 }).find((event) => {
    if (event.channel !== 'agentmail' || event.type !== 'invoice_email') return false;
    const meta = safeJson(event.metadata_json) || {};
    return (
      (paymentId && meta.paymentId === paymentId) ||
      (idempotencyKey && meta.idempotencyKey === idempotencyKey)
    );
  }) || null;
}

export function revenueStatusForLead(leadId) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  const paymentRows = payments.listByLead(leadId);
  const contactRows = contactEvents.listByLead(leadId, { limit: 100 });
  const postMortem = loadLatestPostMortemFromRuns(leadId);
  const gate = evaluateInvoiceGate({
    lead,
    toEmail: paymentRows[0]?.customer_email || postMortem?.invoiceEmail,
    postMortem,
    contactRows
  });
  return {
    leadId,
    gate,
    latestPayment: paymentRows[0] || null,
    invoiceEmailEvent: existingInvoiceEmailEvent({
      leadId,
      paymentId: paymentRows[0]?.id,
      idempotencyKey: paymentRows[0]?.idempotency_key
    }),
    thread: latestThread(contactRows, lead),
    replies: contactRows.filter((event) => event.channel === 'agentmail' && event.direction === 'inbound').length,
    handoffFlags: contactRows.filter((event) => {
      const meta = safeJson(event.metadata_json) || {};
      return event.type === 'handoff_reply' || meta.classification?.operatorFlag || meta.deliveryRisk?.operatorFlag;
    }).length
  };
}

export function revenueHealthSummary() {
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n
    FROM payments
    GROUP BY status
    ORDER BY status
  `).all();
  const recentWebhooks = db.prepare(`
    SELECT provider, type, received_at
    FROM webhook_events
    WHERE provider IN ('stripe', 'agentmail')
    ORDER BY received_at DESC
    LIMIT 8
  `).all();
  return {
    offerVersion: REVENUE_OFFER_VERSION,
    invoiceGate: {
      requires: ['transcript_backed_interest', 'confirmed_customer_email', 'no_opt_out', 'invoice_consent_event']
    },
    sideEffects: {
      liveStripeInvoices: canPay() ? 'enabled' : 'mock_or_blocked',
      liveAgentMail: env.live.emails ? 'enabled_when_provider_configured' : 'mock_or_blocked'
    },
    paymentsByStatus: Object.fromEntries(counts.map((row) => [row.status, row.n])),
    recentWebhooks
  };
}

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

  // Conversion outcome for the pitch_v2 experiment: count the paid invoice
  // toward the arm the lead was bucketed into. Re-recording is harmless (a
  // new outcome row each time) but we still gate on result.changed so a
  // duplicate Stripe webhook does not double-count revenue.
  if (result.changed) {
    try {
      const assignment = currentArmForLead(PITCH_EXPERIMENT_KEY, leadId);
      if (assignment) {
        const amountCents = Number.isFinite(result.row?.amount_cents) ? result.row.amount_cents : null;
        recordExperimentOutcome({
          assignment,
          outcome: 'converted',
          valueCents: amountCents,
          metadata: {
            paymentId: result.row?.id || null,
            stripeInvoiceId: result.row?.stripe_invoice_id || null
          }
        });
      }
    } catch (err) {
      log.warn('experiment.outcome.conversion_failed', { leadId, error: err?.message || String(err) });
    }
    // Stripe processing fee — only on the transition to paid so duplicate
    // webhooks don't double-charge the ledger.
    try {
      const amountCents = Number(result.row?.amount_cents) || 0;
      if (amountCents > 0) {
        recordStripeFee({ leadId, amountCents });
      }
    } catch (err) {
      log.warn('stripe.fee_record_failed', { leadId, error: err?.message || String(err) });
    }
  }

  if (!result.row) return { ...result, leadId, builderTriggerClaimed: false, build: { shouldStart: false, reason: 'missing_payment' } };
  if (typeof startBuilder !== 'function') {
    return { ...result, leadId, builderTriggerClaimed: false, build: { shouldStart: false, reason: 'no_start_builder' } };
  }

  const trigger = payments.claimBuilderTrigger(result.row.id);
  let build;
  if (!trigger.claimed) {
    build = { shouldStart: false, reason: 'already_triggered', row: null };
  } else {
    // Preview-build kickoff (fired on the customer's affirmative invoice reply) may already
    // be running for this lead under buildId 'bld_preview_<leadId>' with no payment trigger_key.
    // Don't start a second runner; let the existing build deliver the project URL.
    const activePreview = builds.findActiveForLead?.(leadId);
    if (activePreview) {
      build = { shouldStart: false, reason: 'preview_already_running', row: activePreview };
    } else {
      build = builds.reservePaidBuild({ lead_id: leadId, trigger_key: `payment:${result.row.id}`, staleAfterMs });
    }
  }
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
  const lineWithLead = obj.lines?.data?.find((line) => line.metadata?.leadId || line.metadata?.lead_id || line.metadata?.callmemaybeLeadId);
  return (
    obj.metadata?.leadId ||
    obj.metadata?.lead_id ||
    obj.metadata?.callmemaybeLeadId ||
    lineWithLead?.metadata?.leadId ||
    lineWithLead?.metadata?.lead_id ||
    lineWithLead?.metadata?.callmemaybeLeadId ||
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
  const hostedUrl = obj.hosted_invoice_url || obj.url || null;
  const paidAt = obj.status_transitions?.paid_at ? obj.status_transitions.paid_at * 1000 : Date.now();
  const dueAt = obj.due_date ? obj.due_date * 1000 : null;

  return {
    lead_id: leadIdFromStripeObject(obj),
    stripe_session_id: sessionId || invoiceId || obj.id,
    stripe_invoice_id: invoiceId || sessionId || obj.id,
    stripe_customer_id: normalizeStripeId(obj.customer),
    customer_email: obj.customer_email || obj.customer_details?.email || null,
    hosted_invoice_url: hostedUrl,
    payment_link_url: hostedUrl,
    invoice_pdf_url: obj.invoice_pdf || null,
    amount_cents: obj.amount_paid || obj.amount_total || obj.amount_due || obj.total || null,
    due_at: dueAt,
    paid_at: paidAt,
    offer_version: obj.metadata?.offerVersion || obj.metadata?.offer_version || null,
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

function shouldMockInvoices() {
  return !canPay();
}

function createMockInvoice({ leadId, toEmail, idempotencyKey, amountCents, productName, daysUntilDue }) {
  const hash = shortHash(idempotencyKey);
  const id = `in_mock_${hash}`;
  return {
    mock: true,
    id,
    customerId: `cus_mock_${shortHash(toEmail)}`,
    customerEmail: toEmail,
    amountCents,
    status: 'open',
    productName,
    url: `https://invoice.stripe.test/i/${encodeURIComponent(leadId)}_${hash}`,
    hostedInvoiceUrl: `https://invoice.stripe.test/i/${encodeURIComponent(leadId)}_${hash}`,
    invoicePdfUrl: `https://invoice.stripe.test/i/${encodeURIComponent(leadId)}_${hash}.pdf`,
    dueAt: Date.now() + daysUntilDue * 86_400_000,
    customerReused: true,
    customerReuseReason: 'mock_normalized_email'
  };
}

function invoiceFromPayment(payment = {}) {
  return {
    id: payment.stripe_invoice_id || payment.stripe_session_id || payment.id,
    customerId: payment.stripe_customer_id || null,
    customerEmail: payment.customer_email || null,
    status: payment.status || null,
    url: payment.hosted_invoice_url || payment.payment_link_url,
    hostedInvoiceUrl: payment.hosted_invoice_url || payment.payment_link_url,
    invoicePdfUrl: payment.invoice_pdf_url || null,
    dueAt: payment.due_at || null,
    amountCents: payment.amount_cents || null,
    paymentId: payment.id,
    idempotencyKey: payment.idempotency_key || null,
    offerVersion: payment.offer_version || null
  };
}

function isMockPayment(payment = {}) {
  return /mock|stripe\.test|demo/i.test([
    payment.stripe_invoice_id,
    payment.stripe_session_id,
    payment.hosted_invoice_url,
    payment.payment_link_url
  ].filter(Boolean).join(' '));
}

function findInvoiceConsentEvent({ leadId, email, offerVersion, contactRows } = {}) {
  if (!leadId || !email) return null;
  const rows = contactRows || contactEvents.listByLead(leadId, { limit: 100 });
  const normalizedEmail = normalizeRevenueEmail(email);
  return rows.find((event) => {
    if (event.type !== 'invoice_consent' || event.channel !== 'revenue') return false;
    const meta = safeJson(event.metadata_json) || {};
    return normalizeRevenueEmail(meta.email) === normalizedEmail && (!offerVersion || meta.offerVersion === offerVersion);
  }) || null;
}

function findTranscriptInterest(transcripts = []) {
  for (const turns of transcripts) {
    for (const [index, turn] of turns.entries()) {
      if (!isCustomerTurn(turn)) continue;
      const text = cleanText(turn.text);
      if (!text || OPT_OUT_RE.test(text)) continue;
      if (EXPLICIT_INTEREST_RE.some((re) => re.test(text))) {
        return {
          ok: true,
          source: 'call_transcript',
          turnIndex: index,
          excerpt: excerpt(text),
          pattern: 'explicit_invoice_or_purchase_interest'
        };
      }
    }
  }
  return {
    ok: false,
    source: 'call_transcript',
    reason: 'no explicit owner interest turn found'
  };
}

function findConfirmedEmailProof({ transcripts = [], postMortem, normalizedEmail }) {
  const pmEmail = normalizeRevenueEmail(postMortem?.invoiceEmail || postMortem?.emailConfirmation?.email);
  if (normalizedEmail && postMortem?.confirmedEmail && pmEmail === normalizedEmail) {
    return {
      ok: true,
      source: 'post_mortem',
      email: normalizedEmail,
      evidence: postMortem.emailConfirmation?.evidence || null
    };
  }

  for (const turns of transcripts) {
    const proof = confirmedEmailFromTurns(turns, normalizedEmail);
    if (proof.ok) return proof;
  }

  return {
    ok: false,
    source: 'call_transcript',
    email: normalizedEmail || null,
    reason: normalizedEmail ? 'email was not read back and confirmed' : 'no email candidate'
  };
}

function confirmedEmailFromTurns(turns = [], wantedEmail) {
  const normalizedWanted = normalizeRevenueEmail(wantedEmail);
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (!isCustomerTurn(turn)) continue;
    const candidates = emailCandidates(turn.text);
    for (const candidate of candidates) {
      if (normalizedWanted && candidate !== normalizedWanted) continue;
      const readback = findReadback(turns, i, candidate);
      if (!readback) continue;
      const confirmation = findConfirmation(turns, readback.index);
      if (!confirmation) continue;
      return {
        ok: true,
        source: 'call_transcript',
        email: candidate,
        evidence: {
          provided: excerpt(turn.text),
          readBack: excerpt(readback.turn.text),
          confirmation: excerpt(confirmation.turn.text)
        }
      };
    }
  }
  return { ok: false };
}

function findReadback(turns, startIndex, email) {
  for (let i = startIndex + 1; i < Math.min(turns.length, startIndex + 5); i += 1) {
    const turn = turns[i];
    if (isCustomerTurn(turn)) continue;
    if (mentionsEmail(turn.text, email) && /\b(is that right|is that correct|did i get that right|confirm|right\?|correct\?)\b/i.test(turn.text || '')) {
      return { index: i, turn };
    }
  }
  return null;
}

function findConfirmation(turns, startIndex) {
  for (let i = startIndex + 1; i < Math.min(turns.length, startIndex + 4); i += 1) {
    const turn = turns[i];
    if (!isCustomerTurn(turn)) continue;
    if (/\b(no|nope|wrong|incorrect|not right|not correct)\b/i.test(turn.text || '')) return null;
    if (/\b(yes|yeah|yep|correct|right|that's right|that is right|confirmed|exactly|you got it|sounds good)\b/i.test(turn.text || '')) {
      return { index: i, turn };
    }
  }
  return null;
}

function findOptOutEvidence({ lead, transcripts = [], contactRows = [] } = {}) {
  if (lead?.risk_status && /opt.?out|do_not|do-not/i.test(lead.risk_status)) {
    return { found: true, reason: `lead risk_status is ${lead.risk_status}`, source: 'lead' };
  }
  for (const turns of transcripts) {
    for (const turn of turns) {
      if (isCustomerTurn(turn) && OPT_OUT_RE.test(turn.text || '')) {
        return { found: true, reason: excerpt(turn.text), source: 'call_transcript' };
      }
    }
  }
  for (const event of contactRows) {
    if (event.channel !== 'agentmail' || event.direction !== 'inbound') continue;
    const meta = safeJson(event.metadata_json) || {};
    const classification = meta.classification || {};
    if (event.type === 'customer_reply' && classification.kind === 'opt_out') {
      return { found: true, reason: event.body || classification.reason || event.type, source: 'agentmail' };
    }
    if ((event.type === 'customer_reply' || event.type === 'customer_reply_flagged') && OPT_OUT_RE.test(event.body || '')) {
      return { found: true, reason: event.body || event.type, source: 'agentmail' };
    }
  }
  return { found: false };
}

function latestThread(contactRows, lead) {
  const event = (contactRows || []).find((row) => row.channel === 'agentmail' && row.thread_id);
  if (!event && !lead?.agentmail_thread_id) return null;
  return {
    threadId: event?.thread_id || lead.agentmail_thread_id,
    lastEventAt: event?.created_at || null,
    subject: event?.subject || null
  };
}

function parseTranscript(value) {
  const raw = safeJson(value) || value;
  if (!raw) return [];
  const source = Array.isArray(raw) ? raw : Array.isArray(raw.turns) ? raw.turns : [];
  return source
    .map((turn, index) => ({
      role: normalizeRole(turn?.role || turn?.speaker || turn?.type),
      text: cleanText(turn?.text || turn?.content || turn?.message || turn?.transcript || turn),
      ts: turn?.ts || turn?.timestamp || index
    }))
    .filter((turn) => turn.text);
}

function normalizeRole(role) {
  const text = String(role || '').toLowerCase();
  if (/agent|assistant|caller|sales|bot/.test(text)) return 'agent';
  if (/user|owner|customer|client|callee|human|lead/.test(text)) return 'customer';
  return 'unknown';
}

function isCustomerTurn(turn) {
  return turn?.role === 'customer' || turn?.role === 'user' || turn?.role === 'unknown';
}

function emailCandidates(text) {
  return [...String(text || '').matchAll(EMAIL_RE)]
    .map((match) => normalizeRevenueEmail(match[0]))
    .filter(Boolean);
}

function mentionsEmail(text, email) {
  const normalized = normalizeRevenueEmail(email);
  if (!normalized) return false;
  if (emailCandidates(text).includes(normalized)) return true;
  const [local, domain] = normalized.split('@');
  const compact = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return compact.includes(local.replace(/[^a-z0-9]+/g, '')) && compact.includes(domain.replace(/[^a-z0-9]+/g, ''));
}

function blocker(code, reason) {
  return { code, reason };
}

function compactGateForMetadata(gate) {
  return {
    ok: gate?.ok,
    leadId: gate?.leadId,
    normalizedEmail: gate?.normalizedEmail,
    offerVersion: gate?.offerVersion,
    blockers: gate?.blockers || [],
    evidence: {
      interest: gate?.evidence?.interest,
      email: gate?.evidence?.email,
      optOut: gate?.evidence?.optOut
    }
  };
}

function normalizeStripeId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.id || null;
}

function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function safeId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_:-]+/g, '_').slice(0, 80) || 'unknown';
}

function cleanText(value) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return value.replace(/\s+/g, ' ').trim();
}

function excerpt(value, max = 220) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
