import { createHash } from 'node:crypto';
import { env } from '../env.js';

export const COMMERCE_PLAN_TYPES = Object.freeze([
  'quote_request',
  'booking_deposit',
  'service_checkout',
  'product_catalog',
  'menu_inquiry',
  'subscription_membership',
  'handoff_only'
]);

export const CUSTOMER_COMMERCE_SCHEMA_VERSION = 'commerce_plan.v1';
export const CALLAN_REVENUE_OFFER_VERSION = 'website-flat-500-v1';

const LEGAL_RE = /\b(legal|lawyer|attorney|contract|terms and conditions|terms of service|liability|waiver|indemnity|compliance)\b/i;
const TAX_RE = /\b(sales tax|taxable|taxes|tax rate|vat|gst|1099|w-?9|cpa|accountant|tax exempt)\b/i;
const REGULATED_RE = /\b(alcohol|beer|wine|liquor|cannabis|cbd|tobacco|vape|firearm|gun|weapon|medical|prescription|pharmacy|financial advice|insurance|loan|lottery|gambling|crypto)\b/i;
const REFUND_POLICY_ADVICE_RE = /\b(write|draft|create|generate|decide|advise|recommend|review).{0,80}\b(refund|return|cancellation)\b|\b(refund|return|cancellation).{0,80}\b(policy|terms).{0,80}\b(write|draft|legal|advise|recommend|review|what should|can you make)\b|\bwhat should.{0,80}\b(refund|return|cancellation)\b/i;
const SUPPLIED_POLICY_RE = /\b(refund|return|cancellation).{0,40}\b(is|are|will be|:|-)\b/i;

const TYPE_PATTERNS = Object.freeze({
  subscription_membership: /\b(subscription|membership|member plan|recurring|monthly|maintenance plan|service plan|club)\b/i,
  menu_inquiry: /\b(menu|dish|entree|appetizer|catering|restaurant|food truck|pizza|bakery|coffee|takeout|dine[-\s]?in)\b/i,
  booking_deposit: /\b(deposit|appointment|booking|book|reserve|reservation|chair|barber|salon|spa|massage|tattoo)\b/i,
  product_catalog: /\b(catalog|product|sku|inventory|ship|shipping|delivery|pickup|pick up|store|retail|order online)\b/i,
  service_checkout: /\b(checkout|pay in full|full payment|buy now|service package|package checkout|online payment)\b/i,
  quote_request: /\b(quote|estimate|bid|consultation|inspection|diagnostic|plumb|hvac|roof|electric|contractor|repair)\b/i
});

const PAYMENT_WORDS_RE = /\b(stripe|payment link|checkout|pay online|online payment|card|deposit|subscription|membership|monthly|pay in full|full payment)\b/i;

export function normalizeCommerceIntake(input = {}, { lead = null, source = 'operator' } = {}) {
  const body = typeof input === 'string' ? { rawText: input } : (input || {});
  const sourceText = compactText([
    body.rawText,
    body.text,
    body.message,
    body.body,
    body.products,
    body.services,
    body.packages,
    body.prices,
    body.pricing,
    body.priceRanges,
    body.bookingRequirements,
    body.refundCancellationText,
    body.fulfillmentNotes,
    body.deliveryPickupNotes
  ].filter(Boolean).map(stringifyLoose).join('\n'), 6000);

  const offerings = uniqueOfferings([
    ...normalizeOfferingList(body.products, 'product'),
    ...normalizeOfferingList(body.services, 'service'),
    ...normalizeOfferingList(body.packages, 'package'),
    ...normalizeOfferingList(body.offerings, 'offering'),
    ...extractOfferingsFromText(sourceText)
  ], 12);

  const pricingNotes = firstText(
    body.prices,
    body.pricing,
    body.priceRanges,
    extractPriceText(sourceText),
    offerings.map((item) => item.priceText).filter(Boolean).join('; ')
  );

  const paymentPreference = normalizePaymentPreference(firstText(body.paymentPreference, body.paymentMode, body.payment, sourceText));
  const bookingRequirements = firstText(body.bookingRequirements, body.booking, extractLabeledText(sourceText, /(booking|appointment|reservation)\s*(requirements?|notes?)?/i));
  const refundCancellationText = firstText(body.refundCancellationText, body.refundPolicy, body.cancellationPolicy, extractSuppliedPolicyText(sourceText));
  const fulfillmentNotes = firstText(
    body.fulfillmentNotes,
    body.deliveryPickupNotes,
    body.deliveryNotes,
    body.pickupNotes,
    extractLabeledText(sourceText, /(delivery|pickup|fulfillment|shipping)\s*(notes?)?/i)
  );

  const explicitFlags = [
    ...listStrings(body.regulatedFlags),
    ...listStrings(body.taxSensitiveFlags),
    ...listStrings(body.riskFlags)
  ];
  const detectedRegulated = detectMatches(sourceText, REGULATED_RE);
  const detectedTax = detectMatches(sourceText, TAX_RE);
  const policyAdviceRequested = REFUND_POLICY_ADVICE_RE.test(sourceText) && !SUPPLIED_POLICY_RE.test(sourceText);

  return {
    source,
    rawText: sourceText,
    productsServicesPackages: offerings,
    pricesOrRanges: pricingNotes || null,
    paymentPreference,
    depositRequested: paymentPreference === 'deposit' || /\bdeposit\b/i.test(sourceText),
    fullPaymentRequested: paymentPreference === 'full_payment' || /\b(pay in full|full payment|checkout|buy now)\b/i.test(sourceText),
    bookingRequirements: bookingRequirements || null,
    refundCancellationText: refundCancellationText || null,
    fulfillmentDeliveryPickupNotes: fulfillmentNotes || null,
    regulatedFlags: unique([...explicitFlags.filter((f) => REGULATED_RE.test(f)), ...detectedRegulated]),
    taxSensitiveFlags: unique([...explicitFlags.filter((f) => TAX_RE.test(f)), ...detectedTax]),
    policyAdviceRequested,
    legalAdviceRequested: LEGAL_RE.test(sourceText),
    paymentInterest: PAYMENT_WORDS_RE.test(sourceText),
    businessContext: {
      leadId: lead?.id || null,
      businessName: lead?.business_name || null,
      niche: lead?.niche || null,
      city: lead?.city || null
    }
  };
}

export function createCommercePlan({ lead = null, intake = {}, source = 'operator', id = null, generatedAt = new Date().toISOString() } = {}) {
  const normalized = isNormalizedIntake(intake) ? { ...intake, source: intake.source || source } : normalizeCommerceIntake(intake, { lead, source });
  const type = chooseCommerceType({ lead, intake: normalized });
  const hardHandoff = type === 'handoff_only';
  const planId = id || `cp_${stableHash({ leadId: lead?.id, normalized, generatedAt }).slice(0, 18)}`;
  const riskFlags = buildRiskFlags(normalized, type);
  const stripeBoundary = buildStripeBoundary({ planId, type, intake: normalized });
  const siteComponents = siteComponentsFor(type, normalized);
  const customerCopy = customerCopyFor(type, normalized, lead);
  const commerceCta = commerceCtaFor(type, normalized, customerCopy);
  const launchChecklist = launchChecklistFor({ type, intake: normalized, stripeBoundary, riskFlags });
  const humanHandoff = humanHandoffFor({ type, intake: normalized, stripeBoundary, riskFlags });

  return {
    schemaVersion: CUSTOMER_COMMERCE_SCHEMA_VERSION,
    id: planId,
    leadId: lead?.id || normalized.businessContext.leadId || null,
    businessName: lead?.business_name || normalized.businessContext.businessName || null,
    generatedAt,
    source,
    type,
    status: hardHandoff ? 'handoff_required' : 'ready_for_truthful_site',
    intake: normalized,
    stripeBoundary,
    siteComponents,
    commerceCta,
    customerCopy,
    riskFlags,
    humanHandoff,
    launchChecklist,
    websiteBrief: {
      includeCommerceSection: true,
      ctaLabel: commerceCta.label,
      ctaBehavior: commerceCta.behavior,
      paymentLinkUrl: null,
      noFakeCheckoutLinks: true,
      summary: commerceSummary({ type, intake: normalized, stripeBoundary, riskFlags })
    },
    evidence: evidenceFor(normalized)
  };
}

function isNormalizedIntake(intake) {
  return Boolean(intake && typeof intake === 'object' && Array.isArray(intake.productsServicesPackages) && intake.businessContext);
}

export function classifyCommerceRequest(input = {}) {
  const normalized = normalizeCommerceIntake(input, { source: 'email' });
  const type = chooseCommerceType({ intake: normalized });
  const unsupported = type === 'handoff_only';
  const text = normalized.rawText || '';
  const commerceContext = /\b(products?|catalog|menu|prices?|packages?|services?|deposit|booking|appointment|membership|subscription|delivery|pickup|fulfillment|quote|estimate)\b/i.test(text);
  const setupSignals = normalized.productsServicesPackages.length > 0 ||
    Object.values(TYPE_PATTERNS).some((re) => re.test(text)) ||
    (normalized.paymentInterest && commerceContext);

  if (unsupported) {
    return {
      kind: 'handoff',
      scope: 'commerce handoff',
      supported: false,
      operatorFlag: true,
      type,
      reason: 'commerce request touches legal, tax, regulated, or refund/cancellation policy advice boundaries',
      riskFlags: buildRiskFlags(normalized, type)
    };
  }

  if (setupSignals) {
    return {
      kind: 'supported',
      scope: 'commerce setup',
      supported: true,
      operatorFlag: false,
      type,
      reason: `supported customer-commerce setup: ${type}`,
      riskFlags: buildRiskFlags(normalized, type)
    };
  }

  return {
    kind: 'none',
    scope: null,
    supported: false,
    operatorFlag: false,
    type: null,
    reason: 'no commerce setup signal matched',
    riskFlags: []
  };
}

export function commerceSummary({ type, intake, stripeBoundary, riskFlags }) {
  const offerings = intake.productsServicesPackages.map((item) => item.name).slice(0, 4).join(', ') || 'offerings not captured';
  const price = intake.pricesOrRanges || 'pricing not captured';
  const payment = stripeBoundary.requiresStripe ? `${stripeBoundary.mode}; ${stripeBoundary.requirements.join(', ')}` : 'no Stripe payment link required for first site flow';
  const risk = riskFlags.length ? `Risks: ${riskFlags.map((f) => f.code).join(', ')}.` : 'No hard handoff flags detected.';
  return `${type}: ${offerings}. Price/range: ${price}. Payment boundary: ${payment}. ${risk}`;
}

function chooseCommerceType({ lead = null, intake }) {
  const text = `${intake.rawText || ''} ${lead?.niche || ''}`.trim();
  if (intake.policyAdviceRequested || intake.legalAdviceRequested || intake.regulatedFlags.length || intake.taxSensitiveFlags.length) {
    return 'handoff_only';
  }
  if (TYPE_PATTERNS.subscription_membership.test(text)) return 'subscription_membership';
  if (TYPE_PATTERNS.menu_inquiry.test(text)) return 'menu_inquiry';
  if (TYPE_PATTERNS.booking_deposit.test(text) || intake.depositRequested) return 'booking_deposit';
  if (TYPE_PATTERNS.product_catalog.test(text)) return 'product_catalog';
  if (TYPE_PATTERNS.service_checkout.test(text) || intake.fullPaymentRequested) return 'service_checkout';
  if (TYPE_PATTERNS.quote_request.test(text)) return 'quote_request';
  return intake.paymentInterest ? 'service_checkout' : 'quote_request';
}

function buildStripeBoundary({ planId, type, intake }) {
  const requiresStripe = ['booking_deposit', 'service_checkout', 'product_catalog', 'subscription_membership'].includes(type) && type !== 'handoff_only';
  const sandbox = env.customerCommerce?.sandboxLinks || bool(process.env.CUSTOMER_COMMERCE_SANDBOX_LINKS);
  const explicitLiveGate = env.customerCommerce?.liveStripeLinks || bool(process.env.CUSTOMER_COMMERCE_LIVE_STRIPE_LINKS);
  const customerStripeAccount = env.customerCommerce?.stripeAccountId || process.env.CUSTOMER_COMMERCE_STRIPE_ACCOUNT_ID || '';
  const liveCustomerCommerceEnabled = Boolean(requiresStripe && explicitLiveGate && env.live.payments && customerStripeAccount);
  const mode = !requiresStripe
    ? 'not_required'
    : liveCustomerCommerceEnabled
      ? 'operator_live_gate_ready'
      : sandbox
        ? 'sandbox_mock'
        : 'operator_checklist';

  return {
    owner: 'customer_business',
    callanRevenueSeparated: true,
    callanInvoice: {
      offerVersion: CALLAN_REVENUE_OFFER_VERSION,
      sourceFile: 'server/paymentFlow.js',
      mayReuseForCustomerCommerce: false
    },
    hostingUpsellSeparated: {
      sourceFile: 'server/hostingSubscription.js',
      mayReuseForCustomerCommerce: false
    },
    requiresStripe,
    requirements: requirementsForStripe(type, intake),
    mode,
    liveCustomerCommerceEnabled,
    liveGenerationPerformed: false,
    liveGenerationGate: {
      requiredEnv: ['CUSTOMER_COMMERCE_LIVE_STRIPE_LINKS=true', 'LIVE_PAYMENTS=true', 'CUSTOMER_COMMERCE_STRIPE_ACCOUNT_ID'],
      satisfied: liveCustomerCommerceEnabled
    },
    paymentLinks: sandbox && requiresStripe ? [{
      label: 'Sandbox placeholder for operator setup',
      url: `https://commerce.stripe.test/payment-link/${encodeURIComponent(planId)}`,
      publishable: false,
      warning: 'Operator-only mock. Do not put this URL on the customer website.'
    }] : [],
    operatorChecklist: operatorStripeChecklist(type, intake, requiresStripe)
  };
}

function requirementsForStripe(type, intake) {
  if (type === 'handoff_only') return ['human review before any customer commerce setup'];
  if (type === 'quote_request' || type === 'menu_inquiry') return [];
  const reqs = [
    'customer-owned Stripe account or approved connected account',
    'customer-approved product/service names and prices',
    'customer-supplied refund/cancellation text before payments go live',
    'operator test-mode checkout verification',
    'explicit publish approval before adding any live payment URL'
  ];
  if (type === 'booking_deposit') reqs.unshift('deposit amount and booking rules approved by the customer');
  if (type === 'subscription_membership') reqs.unshift('recurring terms, cadence, and cancellation path approved by the customer');
  if (type === 'product_catalog') reqs.unshift('fulfillment, delivery, pickup, and inventory expectations approved by the customer');
  return reqs;
}

function operatorStripeChecklist(type, intake, requiresStripe) {
  const base = [
    { key: 'separate_callan_invoice', status: 'required', label: 'Do not use Callan $500 invoice/paymentFlow.js for customer commerce.' },
    { key: 'customer_owns_terms', status: 'required', label: 'Customer must approve product names, prices, taxes, fulfillment, and policies.' }
  ];
  if (!requiresStripe) {
    return [
      ...base,
      { key: 'no_payment_link_needed', status: 'ready', label: 'Use an inquiry form/contact CTA; no payment link is needed for launch.' }
    ];
  }
  return [
    ...base,
    { key: 'stripe_account', status: (env.customerCommerce?.stripeAccountId || process.env.CUSTOMER_COMMERCE_STRIPE_ACCOUNT_ID) ? 'ready' : 'missing', label: 'Verify customer-owned Stripe account or connected account.' },
    { key: 'test_checkout', status: (env.customerCommerce?.sandboxLinks || bool(process.env.CUSTOMER_COMMERCE_SANDBOX_LINKS)) ? 'ready' : 'missing', label: 'Run sandbox/test payment-link check before publishing.' },
    { key: 'policy_copy', status: intake.refundCancellationText ? 'ready' : 'missing', label: 'Capture customer-supplied refund/cancellation text.' },
    { key: 'publish_gate', status: (env.customerCommerce?.liveStripeLinks || bool(process.env.CUSTOMER_COMMERCE_LIVE_STRIPE_LINKS)) ? 'operator' : 'blocked', label: 'Live customer commerce needs explicit env gate and operator approval.' }
  ];
}

function buildRiskFlags(intake, type) {
  const flags = [];
  if (intake.legalAdviceRequested) flags.push(flag('legal_boundary', 'blocker', 'Request asks for legal/contract/compliance advice.', true));
  if (intake.policyAdviceRequested) flags.push(flag('refund_policy_handoff', 'blocker', 'Refund/cancellation policy advice must be supplied by the customer or reviewed by a human.', true));
  if (intake.taxSensitiveFlags.length) flags.push(flag('tax_review_required', 'blocker', `Tax-sensitive terms detected: ${intake.taxSensitiveFlags.join(', ')}.`, true));
  if (intake.regulatedFlags.length) flags.push(flag('regulated_business_review', 'blocker', `Regulated terms detected: ${intake.regulatedFlags.join(', ')}.`, true));
  if (['booking_deposit', 'service_checkout', 'product_catalog', 'subscription_membership'].includes(type) && !intake.refundCancellationText) {
    flags.push(flag('customer_policy_text_missing', 'warning', 'Payment-oriented commerce should not launch until customer supplies refund/cancellation text.', false));
  }
  if (['booking_deposit', 'service_checkout', 'product_catalog', 'subscription_membership'].includes(type)) {
    flags.push(flag('no_live_customer_checkout_without_gate', 'info', 'Customer commerce payment links are operator-gated and separate from Callan revenue.', false));
  }
  return flags;
}

function flag(code, severity, reason, handoff) {
  return { code, severity, reason, handoff };
}

function siteComponentsFor(type, intake) {
  const priceCopy = intake.pricesOrRanges ? `Show customer-supplied price/range text: ${intake.pricesOrRanges}` : 'If prices are missing, ask visitors to request details instead of inventing prices.';
  const policyCopy = intake.refundCancellationText ? `Use customer policy note: ${intake.refundCancellationText}` : 'Do not invent refund, return, or cancellation policy.';
  if (type === 'handoff_only') {
    return [
      component('commerce_review_notice', 'Commerce review notice', 'Tell visitors to contact the business while payment/policy details are reviewed by a human.'),
      component('contact_capture', 'Contact capture', 'Collect name, email, phone, and request details without taking payment.')
    ];
  }
  if (type === 'menu_inquiry') {
    return [
      component('menu_section', 'Menu inquiry section', `List confirmed menu/package items only. ${priceCopy}`),
      component('availability_form', 'Menu availability form', 'Ask visitors what they are interested in, date/time, party size, and contact info.'),
      component('fulfillment_notes', 'Pickup/delivery notes', intake.fulfillmentDeliveryPickupNotes || 'Show only customer-supplied pickup, delivery, or catering notes.')
    ];
  }
  if (type === 'booking_deposit') {
    return [
      component('service_packages', 'Service packages', `Show confirmed service/package options. ${priceCopy}`),
      component('booking_request_form', 'Booking request form', intake.bookingRequirements || 'Ask for preferred date/time and contact info.'),
      component('deposit_notice', 'Upfront charge handoff note', 'Explain that transaction details are confirmed after the business reviews the request; do not add a fake transaction link.'),
      component('policy_note', 'Policy note', policyCopy)
    ];
  }
  if (type === 'service_checkout') {
    return [
      component('service_checkout_interest', 'Service package interest', `Show service packages and transaction interest honestly. ${priceCopy}`),
      component('checkout_setup_placeholder', 'Package setup placeholder', 'Use a request form until the operator has configured customer-owned transaction links.'),
      component('policy_note', 'Policy note', policyCopy)
    ];
  }
  if (type === 'product_catalog') {
    return [
      component('catalog_grid', 'Catalog grid', `Show products/catalog items with confirmed price/range text. ${priceCopy}`),
      component('fulfillment_notes', 'Delivery or pickup notes', intake.fulfillmentDeliveryPickupNotes || 'Ask the customer to supply delivery, pickup, shipping, and availability notes.'),
      component('product_inquiry_form', 'Product inquiry form', 'Collect requested item, quantity, fulfillment preference, and contact info.')
    ];
  }
  if (type === 'subscription_membership') {
    return [
      component('membership_section', 'Membership interest section', `Show recurring offer details only from customer-supplied copy. ${priceCopy}`),
      component('membership_interest_form', 'Membership interest form', 'Collect contact info and preferred plan without starting a recurring charge.'),
      component('recurring_terms_notice', 'Recurring terms handoff', 'Recurring billing terms and cancellation path require operator/customer approval before Stripe setup.'),
      component('policy_note', 'Policy note', policyCopy)
    ];
  }
  return [
    component('quote_request_form', 'Quote request form', 'Collect project/service details, timing, location, and contact info.'),
    component('service_range_section', 'Service and range section', priceCopy),
    component('contact_cta', 'Contact CTA', 'Invite visitors to request a quote; do not imply instant pricing or guaranteed availability.')
  ];
}

function component(kind, title, copy) {
  return { kind, title, copy };
}

function customerCopyFor(type, intake, lead) {
  const name = lead?.business_name || 'the business';
  const offerings = intake.productsServicesPackages.map((item) => item.name).slice(0, 3).join(', ');
  const offeringText = offerings || 'the services you need';
  const map = {
    quote_request: {
      headline: `Request a quote from ${name}`,
      body: `Tell ${name} what you need and they will follow up with the right estimate details.`,
      ctaLabel: 'Request a quote'
    },
    booking_deposit: {
      headline: `Request an appointment with ${name}`,
      body: `Share your preferred time and service. Any upfront charge details are confirmed by the business before a transaction is started.`,
      ctaLabel: 'Request service details'
    },
    service_checkout: {
      headline: `Ask about ${offeringText}`,
      body: `Choose the package you are interested in and the business will send confirmed package details after review.`,
      ctaLabel: 'Request package details'
    },
    product_catalog: {
      headline: `Ask about ${offeringText}`,
      body: `Send the item, quantity, and delivery or pickup preference so the business can confirm availability.`,
      ctaLabel: 'Ask about availability'
    },
    menu_inquiry: {
      headline: `Ask about the menu`,
      body: `Send what you are interested in and the business will confirm availability, timing, and fulfillment details.`,
      ctaLabel: 'Ask about menu availability'
    },
    subscription_membership: {
      headline: `Ask about membership options`,
      body: `Share the plan you are interested in. Recurring billing details are confirmed before any subscription is started.`,
      ctaLabel: 'Ask about membership'
    },
    handoff_only: {
      headline: `Contact ${name} to finalize details`,
      body: `This request needs human review before commerce or policy details can be published.`,
      ctaLabel: 'Contact us'
    }
  };
  return map[type] || map.quote_request;
}

function commerceCtaFor(type, intake, copy) {
  return {
    label: copy.ctaLabel,
    behavior: type === 'handoff_only' ? 'operator_handoff' : 'lead_form',
    href: null,
    helperText: type === 'handoff_only'
      ? 'Human review required before publishing commerce details.'
      : 'No live checkout link is shown until customer-owned payment setup is approved.',
    fields: fieldsForType(type, intake)
  };
}

function fieldsForType(type, intake) {
  const base = ['name', 'email', 'phone', 'message'];
  if (type === 'booking_deposit') return ['name', 'email', 'phone', 'preferred_date_time', 'service_requested', 'message'];
  if (type === 'quote_request') return ['name', 'email', 'phone', 'service_needed', 'location', 'timeline', 'message'];
  if (type === 'menu_inquiry') return ['name', 'email', 'phone', 'menu_items', 'date_needed', 'pickup_delivery_catering', 'message'];
  if (type === 'product_catalog') return ['name', 'email', 'phone', 'item_requested', 'quantity', 'pickup_or_delivery', 'message'];
  if (type === 'subscription_membership') return ['name', 'email', 'phone', 'membership_interest', 'preferred_start', 'message'];
  if (type === 'service_checkout') return ['name', 'email', 'phone', 'package_interest', 'message'];
  return base;
}

function launchChecklistFor({ type, intake, stripeBoundary, riskFlags }) {
  const blockers = new Set(riskFlags.filter((flag) => flag.severity === 'blocker').map((flag) => flag.code));
  return [
    checklist('offerings_captured', intake.productsServicesPackages.length ? 'ready' : 'needs_info', 'Products/services/packages captured'),
    checklist('pricing_captured', intake.pricesOrRanges ? 'ready' : 'needs_info', 'Prices or ranges captured'),
    checklist('booking_requirements', type === 'booking_deposit' ? (intake.bookingRequirements ? 'ready' : 'needs_info') : 'not_required', 'Booking requirements captured'),
    checklist('refund_cancellation_copy', intake.refundCancellationText ? 'ready' : stripeBoundary.requiresStripe ? 'needs_customer' : 'not_required', 'Customer-supplied refund/cancellation copy captured'),
    checklist('fulfillment_notes', ['product_catalog', 'menu_inquiry'].includes(type) ? (intake.fulfillmentDeliveryPickupNotes ? 'ready' : 'needs_info') : 'not_required', 'Fulfillment/delivery/pickup notes captured'),
    checklist('risk_review', blockers.size ? 'blocked' : 'ready', 'Tax/legal/regulated/refund-policy review'),
    checklist('stripe_boundary', stripeBoundary.requiresStripe ? (stripeBoundary.liveCustomerCommerceEnabled ? 'operator' : 'blocked') : 'not_required', 'Customer commerce Stripe/payment-link gate')
  ];
}

function checklist(key, status, label) {
  return { key, status, label };
}

function humanHandoffFor({ type, intake, stripeBoundary, riskFlags }) {
  const blockerFlags = riskFlags.filter((flag) => flag.handoff);
  const paymentSetup = stripeBoundary.requiresStripe && !stripeBoundary.liveCustomerCommerceEnabled;
  return {
    required: blockerFlags.length > 0,
    operatorSetupRequired: paymentSetup,
    boundary: blockerFlags.length
      ? 'Automation must not provide legal, tax, refund-policy, or regulated-commerce advice. Collect customer facts and hand off.'
      : paymentSetup
        ? 'Automation may build an inquiry/interest flow, but a human/operator must configure any real customer-owned payment links.'
        : 'Automation may publish an inquiry flow using only supplied facts.',
    flags: blockerFlags.map((flag) => flag.code),
    notes: [
      paymentSetup ? 'No live customer-business payment link will be published from this plan.' : null,
      intake.refundCancellationText ? 'Refund/cancellation text was supplied by the customer.' : null
    ].filter(Boolean)
  };
}

function evidenceFor(intake) {
  const evidence = [];
  if (intake.rawText) evidence.push({ id: 'commerce-intake-text', source: intake.source, summary: compactText(intake.rawText, 240), confidence: 0.8 });
  if (intake.productsServicesPackages.length) evidence.push({ id: 'commerce-offerings', source: 'commerce_intake', summary: intake.productsServicesPackages.map((item) => item.name).join(', '), confidence: 0.9 });
  if (intake.refundCancellationText) evidence.push({ id: 'customer-policy-copy', source: 'commerce_intake', summary: intake.refundCancellationText, confidence: 0.85 });
  if (intake.regulatedFlags.length || intake.taxSensitiveFlags.length) evidence.push({ id: 'commerce-risk-flags', source: 'commerce_policy', summary: [...intake.regulatedFlags, ...intake.taxSensitiveFlags].join(', '), confidence: 0.95 });
  return evidence.length ? evidence : [{ id: 'commerce-default', source: 'commerce_intake', summary: 'No detailed commerce text supplied yet.', confidence: 0.3 }];
}

function normalizePaymentPreference(text) {
  const t = String(text || '').toLowerCase();
  if (/\bdeposit\b/.test(t)) return 'deposit';
  if (/\b(full payment|pay in full|checkout|buy now|online payment)\b/.test(t)) return 'full_payment';
  if (/\b(subscription|membership|monthly|recurring)\b/.test(t)) return 'recurring';
  if (/\bquote|estimate|inquiry|contact us|call\b/.test(t)) return 'quote_or_inquiry';
  return 'unspecified';
}

function normalizeOfferingList(value, fallbackKind) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(/\n|;/);
  return items.map((item) => normalizeOffering(item, fallbackKind)).filter(Boolean);
}

function normalizeOffering(item, fallbackKind) {
  if (!item) return null;
  if (typeof item === 'object') {
    const name = firstText(item.name, item.title, item.service, item.product, item.package, item.text);
    if (!name) return null;
    return {
      kind: firstText(item.kind, item.type, fallbackKind) || fallbackKind,
      name,
      description: firstText(item.description, item.summary, item.note) || null,
      priceText: firstText(item.price, item.priceText, item.range, item.priceRange) || extractPriceText(name) || null
    };
  }
  const text = compactText(item, 240);
  if (!text) return null;
  return {
    kind: fallbackKind,
    name: text.replace(/\s*[-:]\s*\$?\d.*$/, '').trim() || text,
    description: null,
    priceText: extractPriceText(text)
  };
}

function extractOfferingsFromText(text) {
  const lines = String(text || '')
    .split(/\n/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length >= 3 && line.length <= 180);
  return lines
    .filter((line) => /\$|\b(package|service|menu|item|membership|deposit|quote|estimate|cut|repair|maintenance)\b/i.test(line))
    .slice(0, 10)
    .map((line) => normalizeOffering(line, 'offering'))
    .filter(Boolean);
}

function extractPriceText(text) {
  const value = String(text || '');
  const matches = value.match(/\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?[-–]\s?\$?\s?\d[\d,]*(?:\.\d{2})?)?|\b\d+\s?(?:dollars|usd)\b/gi);
  return matches?.length ? unique(matches.map((m) => m.replace(/\s+/g, ' ').trim())).slice(0, 6).join(', ') : null;
}

function extractLabeledText(text, labelRe) {
  const lines = String(text || '').split(/\n/);
  const found = lines.find((line) => labelRe.test(line));
  if (!found) return null;
  return found.replace(labelRe, '').replace(/^[:\s-]+/, '').trim() || found.trim();
}

function extractSuppliedPolicyText(text) {
  if (!SUPPLIED_POLICY_RE.test(text || '')) return null;
  const lines = String(text || '').split(/\n/);
  return lines.find((line) => SUPPLIED_POLICY_RE.test(line))?.trim() || null;
}

function detectMatches(text, re) {
  if (!re.test(text || '')) return [];
  const out = [];
  if (LEGAL_RE.test(text || '')) out.push('legal');
  if (TAX_RE.test(text || '')) out.push('tax');
  if (/alcohol|beer|wine|liquor/i.test(text || '')) out.push('alcohol');
  if (/cannabis|cbd/i.test(text || '')) out.push('cannabis');
  if (/medical|prescription|pharmacy/i.test(text || '')) out.push('medical');
  if (/firearm|gun|weapon/i.test(text || '')) out.push('firearms');
  if (/financial advice|insurance|loan/i.test(text || '')) out.push('financial');
  if (!out.length) out.push('regulated');
  return unique(out);
}

function listStrings(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : String(value).split(/,|;/);
  return arr.map((item) => compactText(item, 80)).filter(Boolean);
}

function uniqueOfferings(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.name) continue;
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function firstText(...values) {
  for (const value of values) {
    const text = compactText(value, 700);
    if (text) return text;
  }
  return null;
}

function compactText(value, max = 240) {
  if (value === null || value === undefined) return null;
  const raw = stringifyLoose(value);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function stringifyLoose(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(stringifyLoose).join('\n');
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value ?? '');
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bool(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}
