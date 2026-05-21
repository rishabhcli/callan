import { createHash, randomBytes } from 'node:crypto';
import { db, leads, contactEvents, payments, scheduledCalls as scheduledCallsDb } from './db.js';
import { env, canEmail } from './env.js';
import { emit } from './sse.js';
import { log } from './logger.js';
import { addDoc, containerTagFor } from './memory.js';
import { normalizePhone } from './compliance.js';
import { createScheduledCall } from './scheduledCalls.js';
import { createOrReuseRevenueInvoice, revenuePriceCentsForLead } from './paymentFlow.js';
import { buildWebsiteBrief, validateWebsiteBrief } from './fulfillment/hooks/brief.js';
import {
  createMockAgentMailSendResult,
  sendAgentMailMessage
} from './providers/agentmail.js';

export const INBOUND_REQUIRED_FIELDS = Object.freeze([
  'businessName',
  'niche',
  'city',
  'phone',
  'email',
  'services',
  'desiredCta',
  'priceAcknowledged'
]);

export const INBOUND_OPTIONAL_FIELDS = Object.freeze([
  'serviceArea',
  'hours',
  'currentSite',
  'socials',
  'urgency'
]);

const CHANNEL_SOURCE = Object.freeze({
  voice: 'inbound_voice',
  phone: 'inbound_voice',
  email: 'inbound_email',
  agentmail: 'inbound_email'
});

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const URL_RE = /\bhttps?:\/\/[^\s<>()"']+|\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?[^\s<>()"']*/gi;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/;
const SERVICE_SPLIT_RE = /\s*(?:,|;|\/|\band\b|\&|\+|\n)\s*/i;

const NICHE_KEYWORDS = [
  ['barber shop', /\bbarber(?:\s+shop)?\b|\bhaircuts?\b|\bbeard\b|\bshaves?\b/i],
  ['hair salon', /\bsalon\b|\bhair\s+salon\b|\bstylist\b/i],
  ['restaurant', /\brestaurant\b|\bcafe\b|\bdiner\b|\bpizza\b|\btacos?\b|\bmenu\b/i],
  ['plumbing', /\bplumb(?:er|ing)?\b|\bpipe\b|\bleak\b/i],
  ['hvac repair', /\bhvac\b|\bfurnace\b|\bair\s*conditioning\b|\bac repair\b/i],
  ['dental clinic', /\bdent(?:ist|al)\b|\borthodont/i],
  ['auto repair', /\bauto\s+repair\b|\bmechanic\b|\bcar\s+repair\b/i],
  ['fitness studio', /\bgym\b|\bfitness\b|\byoga\b|\bpilates\b/i],
  ['cleaning service', /\bclean(?:er|ing)\b|\bmaid\b/i],
  ['landscaping', /\blandscap(?:e|ing)\b|\blawn\b|\bgarden\b/i]
];

const DEFAULT_SERVICES_BY_NICHE = [
  ['barber', ['haircuts', 'beard trims', 'shaves']],
  ['salon', ['haircuts', 'styling', 'color services']],
  ['restaurant', ['menu highlights', 'takeout details', 'location and hours']],
  ['hvac', ['diagnostics', 'repairs', 'seasonal tuneups']],
  ['plumb', ['repairs', 'estimates', 'emergency service requests']],
  ['dental', ['appointments', 'preventive care', 'patient questions']],
  ['auto', ['diagnostics', 'repairs', 'maintenance']],
  ['fitness', ['classes', 'memberships', 'intro sessions']],
  ['clean', ['residential cleaning', 'deep cleans', 'recurring service']],
  ['landscap', ['yard care', 'maintenance', 'estimates']]
];

const INTENT_PATTERNS = [
  ['opt-out', /\b(unsubscribe|remove me|opt[-\s]?out|stop contacting|do not contact|don't contact|stop emailing|stop calling)\b/i],
  ['invoice', /\b(invoice|payment link|stripe|pay|billing|checkout)\b/i],
  ['callback', /\b(call me|callback|call back|phone me|talk by phone|schedule a call|book a call)\b/i],
  ['build_start', /\b(build|make|create|start|ship|launch)\b.{0,50}\b(site|website|page|landing page)\b|\b(go ahead|approved|green light|proceed|let'?s do it|ship it|start)\b/i],
  ['edits', /\b(edit|revision|change|update|tweak|fix|replace|remove|add)\b/i],
  ['quote', /\b(quote|estimate|price|pricing|cost|how much|package)\b/i],
  ['info', /\b(info|details|learn more|what do you do|how does this work)\b/i]
];

const QUESTION_BY_FIELD = Object.freeze({
  businessName: 'What is the exact business name you want on the site?',
  niche: 'What kind of business is it?',
  city: 'What city or main service area should the site target?',
  phone: 'What phone number should customers use on the site?',
  email: 'What email should I use for the quote and portal?',
  services: 'What are the main services or offers the site should feature?',
  desiredCta: 'What should the main button ask visitors to do: call, book, order, or request a quote?',
  priceAcknowledged: 'The starter site is $500 flat; is that okay if the scope matches what we discussed?'
});

export function normalizeInboundChannel(channel) {
  const key = String(channel || '').toLowerCase();
  return CHANNEL_SOURCE[key] || 'inbound_email';
}

export function normalizeInboundTranscript(input) {
  const source = Array.isArray(input) ? input : Array.isArray(input?.turns) ? input.turns : [];
  return source
    .map((turn, index) => ({
      role: normalizeRole(turn?.role || turn?.speaker || turn?.type),
      text: cleanText(turn?.text || turn?.content || turn?.message || turn?.transcript || turn),
      ts: turn?.ts || turn?.timestamp || index
    }))
    .filter((turn) => turn.text);
}

export function extractInboundFacts({
  text = '',
  subject = '',
  transcript = null,
  channel = 'email',
  fromPhone = null,
  fromEmail = null
} = {}) {
  const turns = normalizeInboundTranscript(transcript);
  const humanText = turns.length
    ? turns.filter((turn) => turn.role !== 'agent').map((turn) => turn.text).join('\n')
    : '';
  const raw = cleanText([subject, text, humanText].filter(Boolean).join('\n'));
  const source = normalizeInboundChannel(channel);
  const email = normalizeEmail(fromEmail || raw.match(EMAIL_RE)?.[0]);
  const phone = normalizePhone(fromPhone || raw.match(PHONE_RE)?.[0] || '');
  const urls = extractUrls(raw);
  const currentSite = pickCurrentSite(urls);
  const socials = extractSocials(raw, urls);
  const niche = extractNiche(raw);
  const city = extractCity(raw);
  const services = extractServices(raw, niche);
  const desiredCta = extractDesiredCta(raw);
  const businessName = extractBusinessName(raw, { subject, niche, city });
  const serviceArea = extractServiceArea(raw) || city || null;
  const hours = extractHours(raw);
  const urgency = extractUrgency(raw);
  const priceAcknowledged = /\b(\$?\s*500|five[\s-]?hundred|flat\s+fee|price\s+(?:works|is fine|sounds good)|budget\s+is\s+\$?\s*500|500\s+(?:works|is fine|sounds good|ok|okay))\b/i.test(raw);

  return compactFacts({
    businessName,
    niche,
    city,
    phone,
    email,
    services,
    serviceArea,
    hours,
    currentSite,
    socials,
    desiredCta,
    urgency,
    priceAcknowledged,
    suppliedText: raw.slice(0, 2500),
    source
  });
}

export function classifyInboundIntent({ text = '', subject = '', transcript = null, facts = null } = {}) {
  const turns = normalizeInboundTranscript(transcript);
  const haystack = cleanText([
    subject,
    text,
    turns.filter((turn) => turn.role !== 'agent').map((turn) => turn.text).join('\n'),
    facts?.suppliedText
  ].filter(Boolean).join('\n'));

  for (const [intent, re] of INTENT_PATTERNS) {
    if (re.test(haystack)) return intent;
  }
  if (facts?.priceAcknowledged) return 'quote';
  if (facts?.businessName || facts?.niche || facts?.services?.length) return 'build_start';
  return 'info';
}

export function reduceInboundIntake({ facts = {}, priorFacts = {}, channel = 'email', intent = null } = {}) {
  const mergedFacts = compactFacts(mergeFacts(priorFacts, facts));
  const source = normalizeInboundChannel(channel);
  const resolvedIntent = intent || classifyInboundIntent({ facts: mergedFacts });
  const missingFields = [
    ...INBOUND_REQUIRED_FIELDS.filter((field) => isMissingField(field, mergedFacts)),
    ...INBOUND_OPTIONAL_FIELDS.filter((field) => isMissingField(field, mergedFacts))
  ];
  const requiredMissingFields = INBOUND_REQUIRED_FIELDS.filter((field) => isMissingField(field, mergedFacts));
  const nextQuestion = requiredMissingFields.length ? QUESTION_BY_FIELD[requiredMissingFields[0]] : null;
  const readyForQuote = resolvedIntent !== 'opt-out' && requiredMissingFields.length === 0;
  const nextAction = nextActionFor({ intent: resolvedIntent, readyForQuote, requiredMissingFields });

  return {
    source,
    intent: resolvedIntent,
    facts: mergedFacts,
    missingFields,
    requiredMissingFields,
    optionalMissingFields: missingFields.filter((field) => !requiredMissingFields.includes(field)),
    nextQuestion,
    nextAction,
    readyForQuote,
    readyForBuild: readyForQuote && !!mergedFacts.priceAcknowledged
  };
}

export async function processInboundIntake({
  channel = 'email',
  fromPhone = null,
  fromEmail = null,
  threadId = null,
  messageId = null,
  subject = '',
  text = '',
  transcript = null,
  callRow = null,
  lead: knownLead = null,
  eventId = null,
  stage = 'final',
  writeMemory = true,
  recordSession = true,
  createQuote = true,
  sendAutoReply = false,
  forceMockSend = false,
  scheduleCallbacks = true
} = {}) {
  const source = normalizeInboundChannel(channel);
  const sessionKey = stableSessionKey({ source, fromPhone, fromEmail, threadId, messageId, callRow, eventId });
  const candidateLead = knownLead || findLeadForInbound({ fromPhone, fromEmail, threadId, facts: null });
  const priorFacts = readPriorIntakeFacts(candidateLead);
  const extractedFacts = extractInboundFacts({ text, subject, transcript, channel, fromPhone, fromEmail });
  const reduced = reduceInboundIntake({
    facts: extractedFacts,
    priorFacts,
    channel: source,
    intent: classifyInboundIntent({ text, subject, transcript, facts: extractedFacts })
  });

  let lead = upsertInboundLead({
    source,
    facts: reduced.facts,
    candidateLead,
    threadId,
    sessionKey,
    nextAction: reduced.nextAction,
    readyForQuote: reduced.readyForQuote
  });

  const profile = buildInboundProfile({ lead, facts: reduced.facts, source, intent: reduced.intent });
  lead = leads.update(lead.id, {
    business_name: reduced.facts.businessName || lead.business_name,
    phone: reduced.facts.phone || lead.phone,
    niche: reduced.facts.niche || lead.niche,
    city: reduced.facts.city || lead.city,
    website: reduced.facts.currentSite || lead.website,
    research_status: 'complete',
    source_url: reduced.facts.currentSite || firstSocialUrl(reduced.facts.socials) || lead.source_url || null,
    research_json: JSON.stringify(profile),
    next_action: reduced.nextAction,
    outreach_status: reduced.intent === 'opt-out'
      ? 'blocked'
      : reduced.readyForQuote ? 'awaiting_payment' : 'inbound_intake',
    risk_status: reduced.intent === 'opt-out' ? 'email-opt-out' : (lead.risk_status || 'inbound_unknown'),
    consent_status: lead.consent_status === 'unknown' ? 'inbound' : lead.consent_status,
    agentmail_thread_id: threadId || lead.agentmail_thread_id || null
  }) || lead;

  const sessionEvent = recordSession
    ? recordInboundSessionEvent({
        lead,
        source,
        sessionKey,
        eventId,
        threadId,
        messageId,
        callRow,
        subject,
        text,
        transcript,
        reduced,
        profile
      })
    : null;

  const brief = buildWebsiteBrief({
    lead,
    profileDoc: { content: JSON.stringify(profile) },
    postMortemDoc: null,
    latestPayment: payments.listByLead(lead.id)[0] || null
  });
  const briefValidation = validateWebsiteBrief(brief);
  let memory = null;
  if (writeMemory) {
    memory = await persistInboundMemory({
      lead,
      source,
      sessionKey,
      eventId,
      reduced,
      profile,
      brief,
      briefValidation
    });
  }

  let quote = null;
  if (createQuote && reduced.readyForQuote) {
    quote = await createInboundQuote({ lead, facts: reduced.facts, source }).catch((err) => {
      log.warn('inbound.intake.quote_failed', {
        leadId: lead.id,
        source,
        error: err?.message || String(err)
      });
      return {
        blocked: true,
        error: err?.message || String(err),
        blockers: [{ code: 'quote_failed', reason: err?.message || String(err) }]
      };
    });
  }

  let scheduledCall = null;
  if (scheduleCallbacks && reduced.intent === 'callback' && reduced.facts.phone) {
    scheduledCall = scheduleInboundCallback({ lead, threadId, messageId, ask: reduced.facts.suppliedText });
  }

  const portal = portalForLead(lead);
  const replyText = draftInboundIntakeReply({
    lead,
    reduced,
    portal,
    quote,
    scheduledCall,
    source
  });

  let autoReply = null;
  if (sendAutoReply && reduced.facts.email && source === 'inbound_voice') {
    autoReply = await sendVoiceIntakeEmail({
      lead,
      toEmail: reduced.facts.email,
      subject: `Your callmemaybe quote for ${lead.business_name}`,
      text: replyText,
      source,
      sessionKey,
      forceMockSend
    });
  }

  const payload = {
    worker: 'inbound',
    source,
    channel: source === 'inbound_voice' ? 'voice' : 'email',
    stage,
    ts: Date.now(),
    sessionId: sessionKey,
    leadId: lead.id,
    callId: callRow?.id || null,
    providerCallId: callRow?.provider_call_id || null,
    threadId,
    messageId,
    subject: subject || null,
    preview: cleanText(text || transcriptText(transcript) || reduced.facts.suppliedText).slice(0, 600),
    intent: reduced.intent,
    facts: reduced.facts,
    missingFields: reduced.missingFields,
    requiredMissingFields: reduced.requiredMissingFields,
    optionalMissingFields: reduced.optionalMissingFields,
    nextQuestion: reduced.nextQuestion,
    nextAction: reduced.nextAction,
    readyForQuote: reduced.readyForQuote,
    readyForBuild: reduced.readyForBuild,
    portalPath: portal.path,
    portalUrl: portal.url,
    invoiceUrl: quote?.invoiceUrl || quote?.paymentLinkUrl || null,
    quoteBlocked: !!quote?.blocked,
    quoteBlockers: quote?.blockers || quote?.gate?.blockers || [],
    briefValidation,
    contactEventId: sessionEvent?.id || null,
    autoReply: autoReply ? { mock: !!autoReply.mock, messageId: autoReply.messageId, threadId: autoReply.threadId } : null,
    scheduledCall: scheduledCall ? {
      id: scheduledCall.id,
      scheduledAtMs: scheduledCall.scheduled_at_ms,
      status: scheduledCall.status
    } : null
  };
  emit('inbound.intake.updated', payload);

  return {
    ...payload,
    lead,
    profile,
    websiteBrief: brief,
    memory,
    quote,
    scheduledCall,
    replyText,
    autoReply,
    ignored: false
  };
}

function upsertInboundLead({ source, facts, candidateLead, threadId, sessionKey, nextAction, readyForQuote }) {
  const existing = candidateLead || findLeadForInbound({ facts, fromPhone: facts.phone, fromEmail: facts.email, threadId });
  const placeholder = source === 'inbound_voice'
    ? `Inbound caller ${maskPhoneForName(facts.phone)}`
    : `Inbound email ${maskEmailForName(facts.email)}`;
  const businessName = facts.businessName || existing?.business_name || placeholder;
  const leadId = existing?.id || `lead_${source}_${shortHash(sessionKey)}_${randomBytes(3).toString('hex')}`;
  const row = {
    id: leadId,
    container_tag: existing?.container_tag || containerTagFor(leadId),
    business_name: businessName,
    phone: facts.phone || existing?.phone || null,
    address: existing?.address || null,
    niche: facts.niche || existing?.niche || 'inbound',
    city: facts.city || existing?.city || null,
    website: facts.currentSite || existing?.website || null,
    status: existing?.status || 'inbound',
    research_status: 'complete',
    outreach_status: facts.priceAcknowledged && readyForQuote ? 'awaiting_payment' : (existing?.outreach_status || 'inbound_intake'),
    risk_status: existing?.risk_status || 'inbound_unknown',
    consent_status: existing?.consent_status || 'inbound',
    phone_classification: existing?.phone_classification || (facts.phone ? 'business' : 'unknown'),
    next_action: nextAction,
    source_url: facts.currentSite || firstSocialUrl(facts.socials) || existing?.source_url || null,
    agentmail_thread_id: threadId || existing?.agentmail_thread_id || null,
    research_json: existing?.research_json || null
  };
  const result = leads.insert(row);
  return result.lead;
}

function findLeadForInbound({ facts = null, fromPhone = null, fromEmail = null, threadId = null } = {}) {
  if (threadId) {
    const byThread = contactEvents.findLeadByThread(threadId);
    if (byThread) return byThread;
  }
  const phone = normalizePhone(fromPhone || facts?.phone || '');
  if (phone) {
    const byPhone = db.prepare(`
      SELECT * FROM leads
      WHERE normalized_phone = ? OR phone = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(phone, fromPhone || facts?.phone || phone);
    if (byPhone) return byPhone;
  }
  const email = normalizeEmail(fromEmail || facts?.email);
  if (email) {
    const byEmail = findLeadByEmail(email);
    if (byEmail) return byEmail;
  }
  if (facts?.businessName || facts?.city || facts?.currentSite) {
    const duplicate = leads.findDuplicate({
      id: null,
      container_tag: 'lead:inbound_probe',
      business_name: facts.businessName || 'Unknown Business',
      phone: facts.phone || null,
      city: facts.city || null,
      source_url: facts.currentSite || firstSocialUrl(facts.socials) || null
    });
    if (duplicate?.lead) return duplicate.lead;
  }
  return null;
}

function findLeadByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const like = `%${normalized.replace(/[%_]/g, '')}%`;
  return db.prepare(`
    SELECT l.*
    FROM leads l
    LEFT JOIN contact_events c ON c.lead_id = l.id
    LEFT JOIN payments p ON p.lead_id = l.id
    WHERE lower(COALESCE(c.body, '')) LIKE ?
       OR lower(COALESCE(c.metadata_json, '')) LIKE ?
       OR lower(COALESCE(p.customer_email, '')) = ?
    ORDER BY COALESCE(c.created_at, p.created_at, l.updated_at) DESC
    LIMIT 1
  `).get(like, like, normalized) || null;
}

function recordInboundSessionEvent({
  lead,
  source,
  sessionKey,
  eventId,
  threadId,
  messageId,
  callRow,
  subject,
  text,
  transcript,
  reduced,
  profile
}) {
  const id = `inbound_intake_${safeId(sessionKey)}`;
  try {
    contactEvents.add({
      id,
      lead_id: lead.id,
      type: 'inbound_intake',
      direction: 'internal',
      channel: source,
      provider_id: messageId || callRow?.provider_call_id || eventId || null,
      thread_id: threadId || null,
      subject: subject || `${source} intake`,
      body: text || transcriptText(transcript) || reduced.facts.suppliedText || '',
      metadata: {
        source,
        eventId,
        callId: callRow?.id || null,
        providerCallId: callRow?.provider_call_id || null,
        messageId,
        threadId,
        email: reduced.facts.email || null,
        phone: reduced.facts.phone || null,
        intent: reduced.intent,
        facts: reduced.facts,
        missingFields: reduced.missingFields,
        requiredMissingFields: reduced.requiredMissingFields,
        nextAction: reduced.nextAction,
        readyForQuote: reduced.readyForQuote,
        profileEvidenceCount: profile.sourceEvidence.length,
        decisionCode: 'inbound.intake.state',
        decisionReason: reduced.readyForQuote
          ? 'Inbound customer supplied enough facts for a portal and quote path.'
          : `Inbound customer missing ${reduced.requiredMissingFields.join(', ') || 'optional facts'}.`
      }
    });
    return { id, inserted: true };
  } catch (err) {
    if (isDuplicate(err)) return { id, inserted: false };
    throw err;
  }
}

async function persistInboundMemory({ lead, source, sessionKey, eventId, reduced, profile, brief, briefValidation }) {
  const tag = containerTagFor(lead.id);
  const metadata = {
    source,
    sourceId: `inbound:${sessionKey}`,
    sourceEvent: eventId || 'inbound.intake',
    customId: null,
    businessName: lead.business_name,
    intent: reduced.intent,
    readyForQuote: reduced.readyForQuote
  };
  const [profileDoc, evidenceDoc, briefDoc] = await Promise.all([
    addDoc(tag, 'business_profile', profile, {
      ...metadata,
      sourceId: `profile:${sessionKey}`,
      kindHint: 'inbound_business_profile'
    }),
    addDoc(tag, 'research_evidence', {
      suppliedFacts: reduced.facts,
      publicEvidence: profile.sourceEvidence,
      missingFields: reduced.missingFields,
      nextQuestion: reduced.nextQuestion
    }, {
      ...metadata,
      sourceId: `evidence:${sessionKey}`,
      kindHint: 'inbound_research_evidence'
    }),
    addDoc(tag, 'build_brief', {
      source: 'inbound_intake',
      readyForQuote: reduced.readyForQuote,
      validation: briefValidation,
      brief
    }, {
      ...metadata,
      sourceId: `brief:${sessionKey}`,
      kindHint: 'inbound_website_brief'
    })
  ]);
  return { profileDoc, evidenceDoc, briefDoc };
}

async function createInboundQuote({ lead, facts, source }) {
  if (!facts.email) {
    return {
      blocked: true,
      blockers: [{ code: 'missing_email', reason: 'No customer email is available for the quote.' }]
    };
  }
  const result = await createOrReuseRevenueInvoice({
    leadId: lead.id,
    toEmail: facts.email,
    profile: safeJson(lead.research_json) || null
  });
  if (result.blocked) {
    return {
      blocked: true,
      gate: result.gate,
      blockers: result.gate?.blockers || []
    };
  }
  const invoiceUrl = result.invoice?.hostedInvoiceUrl || result.invoice?.url || result.payment?.hosted_invoice_url || result.payment?.payment_link_url || null;
  try {
    contactEvents.add({
      id: `inbound_quote_${safeId(lead.id)}_${shortHash(invoiceUrl || source)}`,
      lead_id: lead.id,
      type: 'quote_ready',
      direction: 'internal',
      channel: 'revenue',
      provider_id: result.payment?.id || null,
      thread_id: lead.agentmail_thread_id || null,
      subject: 'Inbound quote ready',
      body: invoiceUrl || 'Inbound quote path ready in customer portal.',
      metadata: {
        source,
        email: facts.email,
        invoiceUrl,
        paymentId: result.payment?.id || null,
        amountCents: result.payment?.amount_cents || revenuePriceCentsForLead(lead),
        mockInvoice: result.mockInvoice,
        decisionCode: 'inbound.quote_ready',
        decisionReason: 'Inbound intake supplied the required business facts and price acknowledgement.'
      }
    });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
  }
  leads.update(lead.id, {
    status: 'awaiting_payment',
    outreach_status: 'awaiting_payment',
    next_action: 'await_payment'
  });
  return {
    blocked: false,
    invoiceUrl,
    paymentLinkUrl: result.payment?.payment_link_url || invoiceUrl,
    paymentId: result.payment?.id || null,
    gate: result.gate,
    mockInvoice: result.mockInvoice
  };
}

function scheduleInboundCallback({ lead, threadId, messageId, ask }) {
  const existing = scheduledCallsDb.findPendingForLead(lead.id);
  if (existing) return existing;
  const scheduledAtMs = nextBusinessCallbackMs();
  const id = `sched_inbound_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  try {
    return createScheduledCall({
      id,
      leadId: lead.id,
      threadId,
      inboundMessageId: messageId,
      scheduledAtMs,
      brief: {
        source: 'inbound_intake',
        ask: cleanText(ask).slice(0, 500) || 'Inbound customer requested a callback.',
        requestedAtMs: Date.now()
      }
    });
  } catch (err) {
    log.warn('inbound.intake.schedule_failed', { leadId: lead.id, error: err?.message || String(err) });
    return null;
  }
}

async function sendVoiceIntakeEmail({ lead, toEmail, subject, text, source, sessionKey, forceMockSend }) {
  let sendResult;
  if (forceMockSend || !canSendEmail(toEmail)) {
    sendResult = createMockAgentMailSendResult({
      threadId: lead.agentmail_thread_id || `mock-thread-${safeId(sessionKey)}`,
      messageId: `mock-inbound-summary-${safeId(sessionKey)}`,
      subject
    });
  } else {
    sendResult = await sendAgentMailMessage({
      toEmail,
      subject,
      text,
      html: `<p>${escapeHtml(text).replace(/\n+/g, '</p><p>')}</p>`,
      leadId: lead.id,
      costKind: 'inbound_intake_summary'
    }, { timeoutSeconds: 15, maxRetries: 2 });
  }
  try {
    contactEvents.add({
      id: `inbound_voice_summary_${safeId(sessionKey)}`,
      lead_id: lead.id,
      type: 'intake_summary',
      direction: 'outbound',
      channel: 'agentmail',
      provider_id: sendResult.providerId,
      thread_id: sendResult.threadId || lead.agentmail_thread_id || null,
      subject,
      body: text,
      metadata: {
        source,
        toMasked: maskEmailForName(toEmail),
        messageId: sendResult.messageId,
        mock: !!sendResult.mock,
        decisionCode: 'inbound.voice.summary_sent',
        decisionReason: 'Voice intake reached a quote or missing-info handoff and had a customer email.'
      }
    });
  } catch (err) {
    if (!isDuplicate(err)) throw err;
  }
  emit('mailer.email_sent', {
    worker: 'mailer',
    leadId: lead.id,
    threadId: sendResult.threadId,
    messageId: sendResult.messageId,
    subject,
    toEmail,
    mock: !!sendResult.mock,
    trigger: 'inbound_voice'
  });
  return sendResult;
}

function draftInboundIntakeReply({ lead, reduced, portal, quote, scheduledCall, source }) {
  if (reduced.intent === 'opt-out') {
    return 'Understood. I will stop contact on this thread.';
  }
  if (scheduledCall) {
    return `Got it - I have ${lead.business_name} in the intake queue and scheduled a follow-up callback. Your portal is ${portal.url}.`;
  }
  if (reduced.nextQuestion) {
    return [
      `Thanks - I started the intake for ${lead.business_name}.`,
      reduced.nextQuestion,
      portal.url ? `Portal draft: ${portal.url}` : null
    ].filter(Boolean).join('\n');
  }
  if (quote?.blocked) {
    const blocker = quote.blockers?.[0]?.reason || quote.error || 'the quote needs one more internal check';
    return [
      `I have enough to draft the site brief for ${lead.business_name}.`,
      `Portal: ${portal.url}`,
      `Quote status: ${blocker}. Reply here and I will keep it moving.`
    ].join('\n');
  }
  const invoice = quote?.invoiceUrl || quote?.paymentLinkUrl;
  return [
    `Locked in - I have enough to prepare the ${lead.business_name} website brief and quote path.`,
    `Portal: ${portal.url}`,
    invoice ? `Invoice/quote: ${invoice}` : `Quote: $${(revenuePriceCentsForLead(lead) / 100).toFixed(0)} flat starter site.`,
    source === 'inbound_email'
      ? `Reply "approved" when you want Callan to start the build path.`
      : `I also saved the call summary so Callan can continue from here.`
  ].join('\n');
}

function buildInboundProfile({ lead, facts, source, intent }) {
  const sourceEvidence = buildSourceEvidence({ facts, source });
  const services = facts.services?.length ? facts.services : defaultServices(facts.niche);
  const onlinePresenceSummary = facts.currentSite
    ? `Customer supplied an existing website (${facts.currentSite}); use it as context and improve the conversion path.`
    : `No owned website was supplied during intake; public evidence should prioritize directories, socials, and direct contact details.`;
  return {
    businessName: facts.businessName || lead.business_name,
    business_name: facts.businessName || lead.business_name,
    niche: facts.niche || lead.niche || 'local services',
    city: facts.city || lead.city || null,
    phone: facts.phone || lead.phone || null,
    bestContactEmail: facts.email || null,
    serviceArea: facts.serviceArea || facts.city || null,
    hours: facts.hours || null,
    websiteUrl: facts.currentSite || lead.website || null,
    sourceUrl: facts.currentSite || firstSocialUrl(facts.socials) || lead.source_url || null,
    socials: facts.socials || [],
    services,
    desiredCta: facts.desiredCta || null,
    cta: facts.desiredCta || null,
    urgency: facts.urgency || null,
    supportsBooking: /\b(book|appointment|schedule)\b/i.test(facts.desiredCta || ''),
    hasWebsite: !!facts.currentSite,
    onlinePresenceStrength: facts.currentSite ? 'mixed' : 'weak',
    onlinePresenceSummary,
    whatTheyDo: `${facts.businessName || lead.business_name} is a ${facts.niche || 'local business'}${facts.city ? ` in ${facts.city}` : ''}.`,
    needs: [
      'clear service menu',
      facts.desiredCta || 'obvious contact path',
      facts.city ? `${facts.city} local relevance` : 'local trust proof'
    ],
    sourceEvidence,
    priceAcknowledged: !!facts.priceAcknowledged,
    intake: {
      source,
      intent,
      facts
    },
    provenance: {
      profileSource: 'provided',
      intakeSource: source,
      intakeFacts: facts,
      intent,
      generatedAt: Date.now()
    }
  };
}

function buildSourceEvidence({ facts, source }) {
  const evidence = [
    {
      source,
      kind: 'supplied_intake',
      confidence: 0.92,
      quote: facts.suppliedText || 'Customer described the business through inbound intake.',
      facts: {
        businessName: facts.businessName,
        niche: facts.niche,
        city: facts.city,
        services: facts.services,
        desiredCta: facts.desiredCta
      }
    }
  ];
  if (facts.currentSite) {
    evidence.push({
      source: facts.currentSite,
      kind: 'owned_site',
      confidence: 0.78,
      quote: `Customer supplied current site ${facts.currentSite}.`
    });
  } else {
    evidence.push({
      source: `${facts.city || 'local'} public web mock`,
      kind: 'public_enrichment',
      confidence: 0.62,
      quote: `Dry-run enrichment queued directory/social checks for ${facts.businessName || facts.niche || 'the inbound business'}.`
    });
  }
  for (const social of facts.socials || []) {
    evidence.push({
      source: social,
      kind: 'social',
      confidence: 0.72,
      quote: `Customer supplied social presence ${social}.`
    });
  }
  return evidence;
}

function readPriorIntakeFacts(lead) {
  const parsed = safeJson(lead?.research_json) || {};
  const intake = parsed?.intake?.facts || parsed?.provenance?.intakeFacts || null;
  const direct = {
    businessName: parsed.businessName || parsed.business_name,
    niche: parsed.niche,
    city: parsed.city,
    phone: parsed.phone,
    email: parsed.bestContactEmail,
    services: parsed.services,
    serviceArea: parsed.serviceArea,
    hours: parsed.hours,
    currentSite: parsed.websiteUrl || parsed.sourceUrl,
    socials: parsed.socials,
    desiredCta: parsed.desiredCta || parsed.cta,
    urgency: parsed.urgency,
    priceAcknowledged: parsed.priceAcknowledged
  };
  return compactFacts({ ...direct, ...(intake || {}) });
}

function nextActionFor({ intent, readyForQuote, requiredMissingFields }) {
  if (intent === 'opt-out') return 'do_not_contact';
  if (requiredMissingFields.length) return `ask_${requiredMissingFields[0]}`;
  if (intent === 'callback') return 'schedule_callback';
  if (readyForQuote && ['quote', 'invoice', 'build_start', 'info'].includes(intent)) return 'send_portal_quote';
  if (intent === 'edits') return 'collect_revision_details';
  return 'continue_intake';
}

function isMissingField(field, facts) {
  if (field === 'services' || field === 'socials') return !Array.isArray(facts[field]) || facts[field].length === 0;
  if (field === 'priceAcknowledged') return facts[field] !== true;
  return !cleanText(facts[field]);
}

function mergeFacts(prior = {}, incoming = {}) {
  const out = { ...prior };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (key === 'services' || key === 'socials') {
      out[key] = unique([...(prior[key] || []), ...(Array.isArray(value) ? value : value ? [value] : [])], 8);
    } else if (key === 'priceAcknowledged') {
      out[key] = Boolean(prior[key] || value);
    } else if (value !== null && value !== undefined && value !== '') {
      out[key] = value;
    }
  }
  return out;
}

function compactFacts(facts = {}) {
  return {
    businessName: cleanEntityName(facts.businessName),
    niche: cleanText(facts.niche)?.toLowerCase() || null,
    city: cleanEntityName(facts.city),
    phone: normalizePhone(facts.phone || '') || null,
    email: normalizeEmail(facts.email),
    services: unique((facts.services || []).map((s) => cleanText(s)).filter(Boolean), 8),
    serviceArea: cleanEntityName(facts.serviceArea),
    hours: cleanText(facts.hours) || null,
    currentSite: normalizeUrl(facts.currentSite),
    socials: unique((facts.socials || []).map((s) => normalizeUrl(s) || cleanText(s)).filter(Boolean), 6),
    desiredCta: cleanText(facts.desiredCta) || null,
    urgency: cleanText(facts.urgency) || null,
    priceAcknowledged: facts.priceAcknowledged === true,
    suppliedText: cleanText(facts.suppliedText) || null,
    source: facts.source || null
  };
}

function extractBusinessName(text, { subject = '', niche = null, city = null } = {}) {
  const combined = `${subject}\n${text}`;
  const patterns = [
    /\b(?:called|named)\s+([A-Z0-9][A-Za-z0-9 &'’.-]{2,70})(?=[,.;!\n]|$)/,
    /\b(?:business|shop|company|studio|restaurant|salon|clinic|store)\s+(?:is|is called|name is)\s+([A-Z0-9][A-Za-z0-9 &'’.-]{2,70})(?=[,.;!\n]|$)/i,
    /\b(?:this is|i am|i'm)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:from|with|at)\s+([A-Z0-9][A-Za-z0-9 &'’.-]{2,70})(?=[,.;!\n]|$)/,
    /\bwebsite\s+for\s+([A-Z0-9][A-Za-z0-9 &'’.-]{2,70})(?=[,.;!\n]|$)/i
  ];
  for (const re of patterns) {
    const hit = combined.match(re)?.[1];
    const cleaned = cleanBusinessCandidate(hit, { niche, city });
    if (cleaned) return cleaned;
  }
  return null;
}

function extractNiche(text) {
  const explicit = text.match(/\b(?:i run|i own|we run|we own|my business is|we are|we're|i have)\s+(?:a|an|the)?\s*([a-z][a-z0-9 &'-]{2,45}?)(?=\s+(?:in|near|called|named|and|with|that|where|from)\b|[,.;!\n]|$)/i)?.[1];
  if (explicit) {
    const cleaned = cleanText(explicit)
      .replace(/\b(?:small|local|new)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned && !/\b(site|website|business)\b/i.test(cleaned)) return cleaned.toLowerCase();
  }
  for (const [label, re] of NICHE_KEYWORDS) {
    if (re.test(text)) return label;
  }
  return null;
}

function extractCity(text) {
  const re = /\b(?:in|near|around|based in|serving)\s+([A-Z][A-Za-z .'-]{2,40})(?=[,.;!\n]|\s+(?:and|with|for|but|so|that|where|we|i|build|make|create)\b|$)/g;
  for (const match of text.matchAll(re)) {
    const candidate = cleanEntityName(match[1]);
    if (candidate && !/\b(the|our|my|a|an|this|that|site|website|minute|morning|afternoon|evening)\b/i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractServiceArea(text) {
  const hit = text.match(/\b(?:service area is|serve|serving|we cover|covers)\s+([A-Za-z0-9 ,&'.-]{3,90})(?=[.;!\n]|$)/i)?.[1];
  return hit ? cleanEntityName(hit) : null;
}

function extractServices(text, niche) {
  const explicit = text.match(/\b(?:services include|we do|we offer|offering|specialize in|feature)\s+([^.;!\n]{3,160})/i)?.[1];
  if (explicit) {
    const items = explicit
      .split(SERVICE_SPLIT_RE)
      .map((item) => cleanText(item).replace(/\b(?:and|plus)\b/gi, '').trim())
      .filter((item) => item.length > 2 && !/\b(site|website|page)\b/i.test(item));
    if (items.length) return unique(items, 8);
  }
  return defaultServices(niche);
}

function extractHours(text) {
  const patterns = [
    /\b((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s*[-–]\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm))/i,
    /\b(?:hours are|open)\s+([^.;!\n]{4,90})/i
  ];
  for (const re of patterns) {
    const hit = text.match(re)?.[1];
    if (hit) return cleanText(hit);
  }
  return null;
}

function extractDesiredCta(text) {
  const explicit = text.match(/\b(?:cta|button|main action|call to action)\s+(?:is|should be|should say|to)\s+([^.;!\n]{2,80})/i)?.[1];
  if (explicit) return sentenceCase(cleanText(explicit));
  if (/\b(book|appointment|schedule)\b/i.test(text)) return 'Call to book an appointment';
  if (/\b(request|get)\s+(?:a\s+)?quote\b/i.test(text)) return 'Request a quote';
  if (/\border\b/i.test(text)) return 'Order today';
  if (/\bcall\b/i.test(text)) return 'Call now';
  return null;
}

function extractUrgency(text) {
  const patterns = [
    /\b(asap|urgent|today|tonight|tomorrow|this week|next week|same day|before [^.;!\n]{2,40})\b/i,
    /\b(?:need|want)\s+it\s+([^.;!\n]{2,50})/i
  ];
  for (const re of patterns) {
    const hit = text.match(re)?.[1] || text.match(re)?.[0];
    if (hit) return cleanText(hit).toLowerCase();
  }
  return null;
}

function extractUrls(text) {
  const urls = [];
  for (const match of text.matchAll(URL_RE)) {
    const normalized = normalizeUrl(match[0]);
    if (normalized && !urls.includes(normalized)) urls.push(normalized);
  }
  return urls;
}

function pickCurrentSite(urls) {
  return urls.find((url) => !/(instagram|facebook|tiktok|x\.com|twitter|yelp|google|maps\.app|linkedin)/i.test(url)) || null;
}

function extractSocials(text, urls) {
  const socials = urls.filter((url) => /(instagram|facebook|tiktok|x\.com|twitter|yelp|google|maps\.app|linkedin)/i.test(url));
  const handle = text.match(/(?:instagram|ig|tiktok|facebook)\s*(?:is|:|@)?\s*(@[a-z0-9_.-]{2,40})/i)?.[1];
  if (handle) socials.push(handle.toLowerCase());
  return unique(socials, 6);
}

function defaultServices(niche) {
  const key = String(niche || '').toLowerCase();
  for (const [needle, services] of DEFAULT_SERVICES_BY_NICHE) {
    if (key.includes(needle)) return services;
  }
  return [];
}

function cleanBusinessCandidate(value, { niche, city } = {}) {
  let text = cleanText(value);
  if (!text) return null;
  text = text
    .replace(/\.\s+[A-Z].*$/g, '')
    .replace(/\s+(?:in|near|with|and|for|that|where|to build|build me).*$/i, '')
    .replace(/[.;,!?:]+$/g, '')
    .trim();
  if (!text || text.length < 3) return null;
  const lower = text.toLowerCase();
  if (niche && lower === String(niche).toLowerCase()) return null;
  if (city && lower === String(city).toLowerCase()) return null;
  if (/\b(site|website|page|business|shop|company)\b/i.test(text) && text.split(/\s+/).length <= 2) return null;
  return cleanEntityName(text);
}

function cleanEntityName(value) {
  const text = cleanText(value)
    .replace(/[.;,!?:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text
    .split(/\s+/)
    .map((part) => /^(and|of|the|at|in)$/i.test(part) ? part.toLowerCase() : part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

function sentenceCase(value) {
  const text = cleanText(value);
  return text ? text[0].toUpperCase() + text.slice(1) : null;
}

function normalizeRole(role) {
  const text = String(role || '').toLowerCase();
  if (/agent|assistant|callan|bot/.test(text)) return 'agent';
  if (/user|caller|human|owner|customer|client|lead/.test(text)) return 'user';
  return 'user';
}

function normalizeEmail(value) {
  const match = String(value || '').match(EMAIL_RE);
  return match ? match[0].toLowerCase() : null;
}

function normalizeUrl(value) {
  const raw = cleanText(value).replace(/[),.;!?]+$/g, '');
  if (!raw) return null;
  if (raw.startsWith('@')) return raw.toLowerCase();
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function portalForLead(lead) {
  const base = String(env.publicUrl || 'http://localhost:8787').replace(/\/+$/, '');
  const path = `/share/build/${encodeURIComponent(lead.id)}`;
  return { path, url: `${base}${path}` };
}

function firstSocialUrl(socials = []) {
  return (socials || []).find((item) => /^https?:\/\//i.test(item)) || null;
}

function transcriptText(transcript) {
  return normalizeInboundTranscript(transcript).map((turn) => `${turn.role}: ${turn.text}`).join('\n');
}

function stableSessionKey({ source, fromPhone, fromEmail, threadId, messageId, callRow, eventId }) {
  return [
    source,
    callRow?.id || callRow?.provider_call_id || '',
    threadId || '',
    messageId || '',
    normalizePhone(fromPhone || '') || '',
    normalizeEmail(fromEmail) || '',
    eventId || ''
  ].filter(Boolean).join(':') || `${source}:${Date.now().toString(36)}`;
}

function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 10);
}

function safeId(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90) || 'unknown';
}

function unique(values, limit = 20) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = cleanText(value);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function maskPhoneForName(phone) {
  if (!phone) return 'unknown';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return 'unknown';
  return `${digits.slice(0, 1)}-XXX-XXX-${digits.slice(-4)}`;
}

function maskEmailForName(email) {
  if (!email || !String(email).includes('@')) return 'unknown';
  const [local, domain] = String(email).split('@');
  const tld = domain?.split('.').pop() || 'email';
  return `${local?.[0] || 'e'}***.${tld}`;
}

function canSendEmail(toEmail) {
  return canEmail(toEmail) && !!env.agentmail.apiKey && !!env.agentmail.inboxId;
}

function nextBusinessCallbackMs() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setHours(10, 0, 0, 0);
  return d.getTime();
}

function isDuplicate(err) {
  return err?.code?.startsWith?.('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(err?.message || '');
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
