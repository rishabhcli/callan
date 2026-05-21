import { callabilityForLead, recordingDisclosure, REASON_CODES, transcriptHasOptOut } from './compliance.js';
import { buildLeadIntelligence } from './research/leadIntelligence.js';
import { inspectGeneratedSite } from './providers/browserUse.js';
import { classifyMessage } from './workers/mailReply.js';
import { evaluateInvoiceGate } from './paymentFlow.js';

export async function runProductionEvals({ storage = null } = {}) {
  const startedAt = Date.now();
  const cases = [];

  await runCase(cases, 'sales_transcript_eval', 'sales', salesTranscriptEval);
  await runCase(cases, 'email_reply_policy_eval', 'email_policy', emailReplyPolicyEval);
  await runCase(cases, 'website_qa_eval', 'website_qa', websiteQaEval);
  await runCase(cases, 'lead_research_evidence_eval', 'research', leadResearchEvidenceEval);
  await runCase(cases, 'invoice_build_exactly_once_eval', 'exactly_once', () => invoiceBuildExactlyOnceEval(storage));
  await runCase(cases, 'compliance_eval', 'compliance', complianceEval);

  const failed = cases.filter((item) => !item.ok && !item.skipped);
  const skipped = cases.filter((item) => item.skipped);
  return {
    ok: failed.length === 0,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary: {
      total: cases.length,
      passed: cases.filter((item) => item.ok && !item.skipped).length,
      failed: failed.length,
      skipped: skipped.length
    },
    cases
  };
}

async function runCase(cases, name, category, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    cases.push({
      name,
      category,
      ok: result?.skipped ? true : result?.ok !== false,
      skipped: !!result?.skipped,
      durationMs: Date.now() - startedAt,
      ...result
    });
  } catch (err) {
    cases.push({
      name,
      category,
      ok: false,
      skipped: false,
      durationMs: Date.now() - startedAt,
      error: err?.message || String(err)
    });
  }
}

function salesTranscriptEval() {
  const lead = evalLead();
  const transcript = [
    { role: 'agent', text: `${recordingDisclosure(lead.business_name)} I found that your menu and booking details are scattered. A focused same-day website is $500.` },
    { role: 'customer', text: 'That sounds good, send the invoice to owner@example.com.' },
    { role: 'agent', text: 'I have owner@example.com. Is that correct?' },
    { role: 'customer', text: 'Yes, that is correct.' }
  ];
  const wonGate = evaluateInvoiceGate({
    lead,
    toEmail: 'owner@example.com',
    callRows: [{ transcript_json: JSON.stringify(transcript) }],
    contactRows: []
  });
  const optOutGate = evaluateInvoiceGate({
    lead,
    toEmail: 'owner@example.com',
    callRows: [{ transcript_json: JSON.stringify([{ role: 'customer', text: 'Stop calling me and remove me.' }]) }],
    contactRows: []
  });
  const assertions = [
    assertion('explicit invoice interest is accepted', wonGate.ok, wonGate),
    assertion('email proof is read back and confirmed', wonGate.evidence?.email?.ok === true, wonGate.evidence?.email),
    assertion('opt-out language blocks invoice path', optOutGate.blockers.some((b) => b.code === 'customer_opted_out'), optOutGate.blockers),
    assertion('transcript opt-out detector fires', transcriptHasOptOut([{ role: 'customer', text: 'Please remove me from your call list.' }]), null)
  ];
  return evalResult(assertions, { wonGate: compactGate(wonGate), optOutBlockers: optOutGate.blockers });
}

function emailReplyPolicyEval() {
  const invoice = classifyMessage({ subject: 'Invoice', text: 'Please send me the payment link for the website.' });
  const optOut = classifyMessage({ subject: 'Stop', text: 'Unsubscribe and do not email me again.' });
  const legal = classifyMessage({ subject: 'Contract', text: 'Send a custom legal contract and guarantee revenue by Friday.' });
  const source = classifyMessage({ subject: 'Why me?', text: 'Where did you get my number and why did you contact us?' });
  const assertions = [
    assertion('invoice reply is supported', invoice.kind === 'supported' && !invoice.operatorFlag, invoice),
    assertion('opt-out replies confirm stop request', optOut.kind === 'opt_out' && optOut.replyMode === 'opt_out_confirmation', optOut),
    assertion('legal or guarantee request routes to handoff', legal.kind === 'handoff' && legal.operatorFlag, legal),
    assertion('source or consent challenge routes to safe handoff', source.kind === 'handoff' && source.operatorFlag, source)
  ];
  return evalResult(assertions, { invoice, optOut, legal, source });
}

async function websiteQaEval() {
  const lead = evalLead({ status: 'paid' });
  const brief = {
    businessName: lead.business_name,
    phone: lead.phone,
    services: ['emergency plumbing', 'water heater repair', 'drain cleaning'],
    cta: 'Call now for a quote',
    sourceFacts: {
      invoiceStatus: 'paid',
      email: 'owner@example.com',
      address: lead.address,
      hours: 'Mon-Fri 8am-6pm'
    },
    location: {
      serviceArea: 'Oakland',
      address: lead.address,
      hours: 'Mon-Fri 8am-6pm'
    },
    confirmedCapabilities: {}
  };
  const html = `<!doctype html>
<html>
  <head>
    <title>${lead.business_name}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>main{max-width:960px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}@media(max-width:700px){.grid{grid-template-columns:1fr}}img{max-width:100%}</style>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"${lead.business_name}","telephone":"${lead.phone}","address":"${lead.address}"}</script>
  </head>
  <body>
    <main>
      <h1>${lead.business_name}</h1>
      <p>Oakland plumbing help. Mon-Fri 8am-6pm. ${lead.address}.</p>
      <a href="tel:${lead.phone}">Call now for a quote</a>
      <a href="mailto:owner@example.com">Email us</a>
      <section class="grid">
        <article><h2>Emergency plumbing</h2><p>Fast diagnostics and repairs.</p></article>
        <article><h2>Water heater repair</h2><p>Repairs and replacement guidance.</p></article>
        <article><h2>Drain cleaning</h2><p>Clear next step for clogged drains.</p></article>
      </section>
      <img alt="Technician work van for ${lead.business_name}" src="/mock.jpg" />
    </main>
  </body>
</html>`;
  const qa = await inspectGeneratedSite({ html, brief, lead, mock: true });
  const blockingFailures = qa.checklist.filter((item) => !item.passed && item.blocksBuild !== false);
  const assertions = [
    assertion('generated page passes blocking QA', qa.passed, { errors: qa.errors, score: qa.score }),
    assertion('business name, CTA, contact paths, and schema are checked', ['visible_business_name', 'primary_cta', 'contact_paths', 'localbusiness_schema'].every((key) => qa.checklist.some((item) => item.key === key)), qa.checklist.map((i) => i.key)),
    assertion('no blocking launch/site failures remain', blockingFailures.length === 0, blockingFailures)
  ];
  return evalResult(assertions, { score: qa.score, errors: qa.errors, warnings: qa.warnings });
}

function leadResearchEvidenceEval() {
  const intelligence = buildLeadIntelligence({
    businessName: 'Eval Plumbing',
    niche: 'plumber',
    city: 'Oakland',
    phone: '+14155550111',
    onlinePresenceStrength: 'weak',
    websiteUrl: '',
    sourceUrl: 'https://example.test/eval-plumbing',
    services: ['drain cleaning', 'water heaters'],
    needs: ['clear service page', 'visible tap-to-call'],
    sourceEvidence: [
      {
        sourceId: 'src_google_1',
        sourceType: 'google',
        sourceUrl: 'https://example.test/eval-plumbing',
        category: 'listing',
        field: 'services',
        claim: 'Listing mentions drain cleaning and water heater repair.',
        quote: 'Drain cleaning and water heater repair',
        confidence: 0.86
      }
    ]
  }, { sourceType: 'eval', capturedAt: '2026-05-20T00:00:00.000Z' });
  const evidenceIds = new Set((intelligence.evidence || []).map((item) => item.id));
  const citedClaims = [
    intelligence.callOpener,
    intelligence.whyThisLeadIsWorthCalling,
    intelligence.bestCtaRecommendation,
    ...(intelligence.missingCustomerInfo || []),
    ...(intelligence.currentWebsiteIssues || [])
  ].filter(Boolean);
  const assertions = [
    assertion('research produced evidence trail', evidenceIds.size > 0 && intelligence.sourceTrail?.length > 0, intelligence.sourceTrail),
    assertion('call opener cites existing evidence', (intelligence.callOpener?.evidenceIds || []).every((id) => evidenceIds.has(id)), intelligence.callOpener),
    assertion('all major claims cite evidence', citedClaims.every((claim) => (claim.evidenceIds || []).every((id) => evidenceIds.has(id))), citedClaims),
    assertion('audit marks source URL preserved', intelligence.audit?.sourceUrlPreserved === true, intelligence.audit)
  ];
  return evalResult(assertions, { evidenceCount: evidenceIds.size, sourceTrail: intelligence.sourceTrail, audit: intelligence.audit });
}

function invoiceBuildExactlyOnceEval(storage) {
  if (!storage?.leads || !storage?.payments || !storage?.builds) {
    return {
      ok: true,
      skipped: true,
      reason: 'storage adapter not provided; run scripts/eval-check.js for isolated SQLite exactly-once proof'
    };
  }
  const leadId = `eval_exactly_once_${Date.now().toString(36)}`;
  storage.leads.insert({
    id: leadId,
    container_tag: leadId,
    business_name: 'Exactly Once Plumbing',
    phone: '+14155550111',
    address: '1 Eval Way',
    niche: 'plumber',
    city: 'Oakland',
    website: 'https://example.test/exactly-once',
    status: 'paid',
    source_url: 'https://example.test/exactly-once'
  });
  const idempotencyKey = `invoice:${leadId}:owner@example.com:eval`;
  const firstPayment = storage.payments.insertOrGetByIdempotency({
    id: `pay_${leadId}_a`,
    lead_id: leadId,
    stripe_invoice_id: `in_${leadId}_a`,
    amount_cents: 50000,
    status: 'paid',
    idempotency_key: idempotencyKey,
    customer_email: 'owner@example.com'
  });
  const secondPayment = storage.payments.insertOrGetByIdempotency({
    id: `pay_${leadId}_b`,
    lead_id: leadId,
    stripe_invoice_id: `in_${leadId}_b`,
    amount_cents: 50000,
    status: 'paid',
    idempotency_key: idempotencyKey,
    customer_email: 'owner@example.com'
  });
  const triggerKey = `payment:${firstPayment.row.id}`;
  const firstBuild = storage.builds.reservePaidBuild({ lead_id: leadId, trigger_key: triggerKey });
  const secondBuild = storage.builds.reservePaidBuild({ lead_id: leadId, trigger_key: triggerKey });
  const assertions = [
    assertion('invoice idempotency reuses existing payment', firstPayment.inserted === true && secondPayment.inserted === false && firstPayment.row.id === secondPayment.row.id, { first: firstPayment, second: secondPayment }),
    assertion('paid-build reservation starts once', firstBuild.shouldStart === true && secondBuild.shouldStart === false && firstBuild.row.id === secondBuild.row.id, { first: firstBuild, second: secondBuild })
  ];
  return evalResult(assertions, {
    leadId,
    paymentId: firstPayment.row.id,
    buildId: firstBuild.row.id,
    secondBuildReason: secondBuild.reason
  });
}

function complianceEval() {
  const lead = evalLead({ phone_classification: 'business_landline' });
  const disclosure = recordingDisclosure(lead.business_name);
  const review = callabilityForLead({
    lead,
    disclosureText: disclosure,
    mode: 'production_review',
    now: new Date('2026-05-20T18:00:00-07:00'),
    skipAttemptLimit: true
  });
  const mobile = callabilityForLead({
    lead: { ...lead, phone_classification: 'mobile_risk' },
    disclosureText: disclosure,
    mode: 'production_live',
    now: new Date('2026-05-20T12:00:00-07:00'),
    skipAttemptLimit: true
  });
  const missingDisclosure = callabilityForLead({
    lead,
    disclosureText: 'Hi, quick question.',
    mode: 'autonomous_live',
    now: new Date('2026-05-20T12:00:00-07:00'),
    skipAttemptLimit: true
  });
  const assertions = [
    assertion('production_review blocks outbound calls', review.reasonCodes.includes(REASON_CODES.PRODUCTION_REVIEW_NO_OUTBOUND_CALLS), review),
    assertion('production_live blocks mobile-risk phones', mobile.reasonCodes.includes(REASON_CODES.PHONE_MOBILE_RISK), mobile),
    assertion('missing recording disclosure blocks calls', missingDisclosure.reasonCodes.includes(REASON_CODES.RECORDING_DISCLOSURE_MISSING), missingDisclosure)
  ];
  return evalResult(assertions, {
    review: compactCallability(review),
    mobile: compactCallability(mobile),
    missingDisclosure: compactCallability(missingDisclosure)
  });
}

function evalLead(overrides = {}) {
  return {
    id: 'eval_lead',
    business_name: 'Eval Plumbing',
    phone: '+14155550111',
    address: '1 Eval Way, Oakland, CA',
    niche: 'plumber',
    city: 'Oakland',
    website: null,
    status: 'discovered',
    outreach_status: 'queued',
    phone_classification: 'business_landline',
    source_url: 'https://example.test/eval-plumbing',
    ...overrides
  };
}

function assertion(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}

function evalResult(assertions, observed = {}) {
  return {
    ok: assertions.every((item) => item.ok),
    assertions,
    observed
  };
}

function compactGate(gate) {
  return {
    ok: gate.ok,
    leadId: gate.leadId,
    normalizedEmail: gate.normalizedEmail,
    blockers: gate.blockers,
    evidence: gate.evidence
  };
}

function compactCallability(result) {
  return {
    ok: result.ok,
    mode: result.mode,
    reasonCodes: result.reasonCodes,
    phoneClassification: result.phoneClassification
  };
}
