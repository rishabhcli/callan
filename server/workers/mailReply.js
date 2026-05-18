import { randomBytes } from 'node:crypto';
import { emit } from '../sse.js';
import { contactEvents, leads, scheduledCalls as scheduledCallsDb } from '../db.js';
import { canEmail, env, seedAllowedPhone } from '../env.js';
import { log } from '../logger.js';
import { addDoc, containerTagFor } from '../memory.js';
import { generateStructured } from '../reasoning/geminiReasoner.js';
import { EmailReplyDecision, InvoiceAffirmation } from '../reasoning/schemas.js';
import {
  createMockAgentMailSendResult,
  fetchAgentMailIncomingMessages,
  isInboundAgentMailMessage,
  normalizeAgentMailMessage,
  replyAgentMailMessage
} from '../providers/agentmail.js';
import { classifyGrowthReply } from '../growth/replyPolicy.js';
import { classifyScheduleRequest } from './scheduleClassifier.js';
import { callingWindowStatus, markLeadConsentApproved } from '../compliance.js';
import { createScheduledCall, cancelScheduledCall } from '../scheduledCalls.js';

export { fetchAgentMailIncomingMessages };

const CLASSIFICATION_SCHEMA_VERSION = 1;

const SUPPORTED_SCOPES = Object.freeze([
  'invoice',
  'scheduling',
  'brief',
  'revisions',
  'pricing',
  'build progress',
  'opt-out',
  'growth follow-up'
]);

const UNSUPPORTED_SCOPES = Object.freeze([
  'legal',
  'custom contract',
  'refund threat',
  'security issue',
  'tax',
  'guarantees',
  'weird request'
]);

const SUPPORTED_SCOPE = [
  'invoice questions',
  'scheduling',
  'website brief and customer needs',
  'website revisions',
  'pricing',
  'build progress',
  'opt-out or unsubscribe',
  'post-delivery growth follow-up'
].join(', ');

const OPT_OUT_PATTERNS = Object.freeze([
  /\bunsubscribe\b/i,
  /\bremove\s+me\b/i,
  /\bopt[-\s]?out\b/i,
  /\btake\s+me\s+off\b/i,
  /\bstop\s+(?:emailing|contacting|messaging)\b/i,
  /\b(?:do\s+not|don't)\s+(?:email|contact|message)\b/i,
  /\bno\s+more\s+emails?\b/i
]);

export const AFFIRMATIVE_INVOICE_REPLY_PATTERNS = Object.freeze([
  /\b(?:looks?|sounds?)\s+good\b/i,
  /\bgo\s+ahead\b/i,
  /\bapproved?\b/i,
  /\blet'?s\s+(?:do\s+it|go|roll|ship)\b/i,
  /\bproceed\b/i,
  /\bconfirmed?\b/i,
  /\b(?:yes|yep|yeah|yup|sure|absolutely)\b/i,
  /\bdo\s+it\b/i,
  /\bgreen\s*light\b/i,
  /\bmove\s+forward\b/i,
  /\bship\s+it\b/i,
  /\bsign\s+me\s+up\b/i
]);

const AFFIRMATIVE_NEGATION_GUARD = /\b(?:not\s+yet|hold\s+off|hold\s+on|wait|cancel|stop|no\s+thanks?|don'?t|never\s*mind|nevermind)\b/i;

export function detectAffirmativeInvoiceReply({ lead = null, subject = '', text = '' } = {}) {
  if (!lead) return { affirmative: false, reason: 'no_lead' };
  if (lead.outreach_status !== 'awaiting_payment') return { affirmative: false, reason: 'gate_outreach_status' };
  if (lead.preview_build_triggered_at) return { affirmative: false, reason: 'already_triggered' };
  if (lead.risk_status === 'email-opt-out') return { affirmative: false, reason: 'opted_out' };
  const policy = normalizePolicyText(`${subject}\n${text}`);
  if (!policy) return { affirmative: false, reason: 'empty' };
  if (AFFIRMATIVE_NEGATION_GUARD.test(policy)) return { affirmative: false, reason: 'negation' };
  const matched = AFFIRMATIVE_INVOICE_REPLY_PATTERNS.find((re) => re.test(policy));
  if (!matched) return { affirmative: false, reason: 'no_match' };
  return { affirmative: true, reason: 'matched', pattern: matched.source };
}

const LLM_AFFIRMATIVE_CONFIDENCE_THRESHOLD = 0.7;
const LLM_ELIGIBLE_REASONS = new Set(['no_match', 'negation']);

export async function classifyInvoiceAffirmation({ lead = null, subject = '', text = '', eventId = null } = {}) {
  const det = detectAffirmativeInvoiceReply({ lead, subject, text });
  if (det.affirmative) {
    return { affirmative: true, source: 'regex', confidence: 1, reason: det.reason, pattern: det.pattern, scope: 'affirm' };
  }
  // Only ask Gemini when the gates passed but the regex itself didn't find a match
  // (or the negation guard matched — Gemini may still rule the overall intent affirmative).
  if (!LLM_ELIGIBLE_REASONS.has(det.reason)) {
    return { affirmative: false, source: 'regex', confidence: 0, reason: det.reason };
  }
  if (!env.gemini.apiKey) {
    return { affirmative: false, source: 'regex', confidence: 0, reason: det.reason };
  }

  const evidence = {
    lead: lead ? {
      id: lead.id,
      businessName: lead.business_name,
      status: lead.status,
      outreachStatus: lead.outreach_status,
      nextAction: lead.next_action
    } : null,
    message: {
      subject: subject || '',
      text: text || ''
    },
    deterministic: det
  };
  const prompt = [
    `Classify a customer reply to a website-build invoice email.`,
    `We sent the customer an invoice. We need to decide if their reply is them approving the quoted scope and giving us the green light to start building — meaning we should kick off the website build immediately.`,
    `confirmed=true ONLY when the reply unambiguously approves the work (any phrasing, any language, any informality). Examples that should be true: "ya sounds dope", "love it, when do we start", "let's pull the trigger", "i'm in", "estoy listo", "go for it".`,
    `confirmed=false when the reply is a question, a revision request, a price pushback, a hesitation ("not yet", "let me think"), a negation, or anything other than approval.`,
    `Excerpt the most decisive phrase from the reply (≤120 chars).`,
    `Reply with the InvoiceAffirmation schema.`
  ].join('\n');

  try {
    const { output, trace } = await generateStructured({
      kind: 'invoiceAffirmation',
      schema: InvoiceAffirmation,
      evidence,
      prompt,
      leadId: lead?.id || null,
      worker: 'mailer',
      eventId: eventId || null,
      thinkingLevel: 'minimal',
      flash: true
    });
    const affirmative = !!output.confirmed && output.confidence >= LLM_AFFIRMATIVE_CONFIDENCE_THRESHOLD;
    return {
      affirmative,
      source: 'llm',
      confidence: output.confidence,
      reason: affirmative ? 'llm_confirmed' : 'llm_not_confirmed',
      scope: output.scope,
      excerpt: output.excerpt,
      llmReason: output.reason,
      traceId: trace?.id || null
    };
  } catch (err) {
    log.warn('mailer.affirmative_llm_failed', { err: err?.message || String(err), leadId: lead?.id });
    return { affirmative: false, source: 'llm_failed', confidence: 0, reason: det.reason };
  }
}

const UNSUPPORTED_SCOPE_PATTERNS = Object.freeze([
  {
    scope: 'legal',
    patterns: [
      /\blegal\b/i,
      /\blawyer\b/i,
      /\battorney\b/i,
      /\blawsuit\b/i,
      /\bsue\b/i,
      /\bcourt\b/i,
      /\blicensed\s+professional\b/i,
      /\bregulatory\b/i
    ]
  },
  {
    scope: 'custom contract',
    patterns: [
      /\bcustom\s+contract\b/i,
      /\bcontract\s+(?:review|redline|change|term|language|clause|negotiation)\b/i,
      /\bredline\b/i,
      /\bmaster\s+services?\s+agreement\b/i,
      /\bmsa\b/i,
      /\bnda\b/i,
      /\bindemnity\b/i,
      /\bliability\b/i,
      /\bvendor\s+agreement\b/i,
      /\bsign\s+(?:our|my|a)\s+contract\b/i
    ]
  },
  {
    scope: 'refund threat',
    patterns: [
      /\brefund\b/i,
      /\bchargeback\b/i,
      /\bdispute\s+(?:the\s+)?(?:charge|payment|invoice)\b/i,
      /\bthreaten(?:ing)?\s+(?:a\s+)?refund\b/i,
      /\bget\s+my\s+money\s+back\b/i
    ]
  },
  {
    scope: 'security issue',
    patterns: [
      /\bsecurity\b/i,
      /\bbreach\b/i,
      /\bvulnerability\b/i,
      /\bdata\s+leak\b/i,
      /\bpassword\b/i,
      /\baccount\s+(?:takeover|compromised|hacked)\b/i,
      /\bhacked\b/i
    ]
  },
  {
    scope: 'tax',
    patterns: [
      /\btax(?:es|ing|able)?\b/i,
      /\bsales\s+tax\b/i,
      /\bvat\b/i,
      /\bw-?9\b/i,
      /\b1099\b/i,
      /\baccountant\b/i,
      /\bcpa\b/i
    ]
  },
  {
    scope: 'guarantees',
    patterns: [
      /\bguarantee(?:d|s)?\b/i,
      /\bpromise\s+(?:me\s+)?(?:ranking|rankings|revenue|sales|traffic|leads?)\b/i,
      /\bfirst\s+page\s+(?:of\s+)?google\b/i,
      /\bseo\s+guarantee\b/i,
      /\brevenue\s+guarantee\b/i,
      /\brefund\s+if\b/i
    ]
  },
  {
    scope: 'weird request',
    patterns: [
      /\bhack(?:ing)?\b/i,
      /\bexploit\b/i,
      /\bmalware\b/i,
      /\bphishing\b/i,
      /\bcrypto(?:currency)?\b/i,
      /\bbitcoin\b/i,
      /\bgift\s+cards?\b/i,
      /\bwire\s+transfer\b/i,
      /\bbank\s+account\b/i,
      /\bmedical\s+advice\b/i,
      /\bdiagnos(?:e|is)\b/i,
      /\bprescription\b/i,
      /\bhomework\b/i,
      /\bwrite\s+my\s+essay\b/i,
      /\bdating\s+advice\b/i,
      /\bimmigration\b/i,
      /\bpassport\b/i,
      /\bweapon\b/i,
      /\bnude\b/i,
      /\blottery\b/i
    ]
  }
]);

const SUPPORTED_SCOPE_PATTERNS = Object.freeze([
  {
    scope: 'invoice',
    patterns: [
      /\binvoice\b/i,
      /\bpayment\b/i,
      /\bpaid\b/i,
      /\bpay\b/i,
      /\bstripe\b/i,
      /\bcheckout\b/i,
      /\breceipt\b/i,
      /\bbilling\b/i,
      /\bcharge\b/i,
      /\bcard\b/i,
      /\bdeposit\b/i
    ]
  },
  {
    scope: 'scheduling',
    patterns: [
      /\bschedul(?:e|ing)\b/i,
      /\breschedule\b/i,
      /\bmeeting\b/i,
      /\bappointment\b/i,
      /\bcalendar\b/i,
      /\bavailability\b/i,
      /\bavailable\b/i,
      /\bbook\s+(?:a\s+)?(?:call|meeting|time)\b/i,
      /\bcall\s+(?:me|us|you)\b/i,
      /\btomorrow\b/i,
      /\bnext\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
    ]
  },
  {
    scope: 'revisions',
    patterns: [
      /\brevisions?\b/i,
      /\brevis(?:e|ing)\b/i,
      /\bchange\b/i,
      /\bedit\b/i,
      /\bupdate\b/i,
      /\btweak\b/i,
      /\breplace\b/i,
      /\bremove\b/i,
      /\badd\b/i,
      /\bfix\s+(?:the\s+)?(?:typo|copy|text|image|page|link|button)\b/i,
      /\bmake\s+it\b/i
    ]
  },
  {
    scope: 'pricing',
    patterns: [
      /\bpricing\b/i,
      /\bprice\b/i,
      /\bcost\b/i,
      /\bquote\b/i,
      /\bestimate\b/i,
      /\bpackage\b/i,
      /\bbudget\b/i,
      /\bhow\s+much\b/i,
      /\bfee\b/i,
      /\bmonthly\b/i,
      /\bsubscription\b/i
    ]
  },
  {
    scope: 'build progress',
    patterns: [
      /\bbuild\s+progress\b/i,
      /\bprogress\b/i,
      /\bstatus\b/i,
      /\beta\b/i,
      /\bready\b/i,
      /\bfinished\b/i,
      /\bdone\b/i,
      /\bpreview\b/i,
      /\blive\s+url\b/i,
      /\blink\b/i,
      /\bdeploy(?:ed|ment)?\b/i,
      /\blaunch\b/i,
      /\bship(?:ped)?\b/i
    ]
  },
  {
    scope: 'brief',
    patterns: [
      /\bbrief\b/i,
      /\bneeds?\b/i,
      /\bwebsite\b/i,
      /\bsite\b/i,
      /\bpages?\b/i,
      /\bcontent\b/i,
      /\bcopy\b/i,
      /\blogo\b/i,
      /\bbrand(?:ing)?\b/i,
      /\bcolors?\b/i,
      /\bphotos?\b/i,
      /\bimages?\b/i,
      /\bservices?\b/i,
      /\bmenu\b/i,
      /\bdomain\b/i,
      /\babout\s+us\b/i
    ]
  }
]);

export function normalizeAgentMailPayload(body = {}) {
  return normalizeAgentMailMessage(body, { inboxId: env.agentmail.inboxId });
}

export function isInboundAgentMailPayload(body = {}) {
  return isInboundAgentMailMessage(normalizeAgentMailPayload(body));
}

export async function fetchNormalizedAgentMailIncomingMessages(params = {}, requestOptions = {}) {
  return fetchAgentMailIncomingMessages(params, requestOptions);
}

export async function handleAgentMailInbound(body = {}, {
  forceMockSend = false,
  forceFallbackReply = false,
  writeMemory = true
} = {}) {
  const msg = normalizeAgentMailPayload(body);
  if (!isInboundAgentMailPayload(body)) return { ignored: true, reason: 'not inbound', msg };

  const lead = msg.threadId ? contactEvents.findLeadByThread(msg.threadId) : null;
  const leadId = lead?.id || body.leadId || body.lead_id || null;
  const resolvedLead = lead || (leadId ? leads.get(leadId) : null);
  const bodyText = msg.text || '';
  const classification = await decideEmailReply({ lead: resolvedLead, msg, subject: msg.subject, text: bodyText });

  contactEvents.add({
    lead_id: leadId,
    type: 'customer_reply',
    direction: 'inbound',
    channel: 'agentmail',
    provider_id: msg.messageId,
    thread_id: msg.threadId,
    subject: msg.subject,
    body: bodyText,
    metadata: { fromMasked: maskEmail(msg.fromEmail), classification }
  });

  if (leadId) {
    persistThreadForLead(leadId, msg.threadId, resolvedLead);
    if (writeMemory) await writeMailMemory(leadId, 'inbound', msg, { classification });
    if (classification.kind === 'opt_out') {
      leads.update(leadId, {
        risk_status: 'email-opt-out',
        next_action: 'do_not_email'
      });
    } else if (classification.operatorFlag) {
      leads.update(leadId, {
        risk_status: 'operator-handoff',
        next_action: 'operator_review_mail'
      });
    }
  }

  // Scheduling intent: only run the Gemini schedule classifier when the deterministic
  // pass already routed scope='scheduling'. Mutates `classification.replyText` so the
  // existing sendReply path delivers the confirmation/decline reply for free.
  let scheduleOutcome = null;
  if (
    leadId &&
    resolvedLead &&
    classification?.scope === 'scheduling' &&
    classification?.kind !== 'opt_out' &&
    !classification?.operatorFlag
  ) {
    try {
      scheduleOutcome = await handleScheduleIntent({
        lead: resolvedLead,
        leadId,
        msg,
        bodyText,
        classification
      });
    } catch (err) {
      log.warn('agentmail.schedule.handler_failed', {
        leadId, threadId: msg.threadId, error: err?.message || String(err)
      });
    }
  }

  const replyText = await draftReply({ lead: resolvedLead, msg, classification, forceFallbackReply });
  const sendResult = await sendReply({ msg, text: replyText, classification, forceMockSend, leadId });
  if (leadId) persistThreadForLead(leadId, sendResult.threadId || msg.threadId, resolvedLead);

  contactEvents.add({
    lead_id: leadId,
    type: classification.replyMode === 'safe_handoff' ? 'handoff_reply' : 'agent_reply',
    direction: 'outbound',
    channel: 'agentmail',
    provider_id: sendResult.providerId,
    thread_id: sendResult.threadId || msg.threadId,
    subject: `Re: ${stripRe(msg.subject)}`,
    body: replyText,
    metadata: { mock: sendResult.mock, classification }
  });

  if (leadId && writeMemory) {
    await writeMailMemory(leadId, 'outbound', { ...msg, text: replyText }, { classification, mock: sendResult.mock });
  }

  emit('mailer.auto_reply', {
    worker: 'mailer',
    leadId,
    threadId: sendResult.threadId || msg.threadId,
    messageId: sendResult.providerId || msg.messageId,
    subject: msg.subject,
    classification: classification.kind,
    classificationScope: classification.scope,
    supported: classification.supported,
    operatorFlag: classification.operatorFlag,
    policy: classification,
    mock: sendResult.mock,
    schedule: scheduleOutcome ? {
      action: scheduleOutcome.action,
      scheduledCallId: scheduleOutcome.scheduledCallId || null,
      scheduledAtMs: scheduleOutcome.scheduledAtMs || null,
      reason: scheduleOutcome.reason || null
    } : null
  });

  return { ignored: false, leadId, replyText, classification, sendResult, scheduleOutcome };
}

const MAX_FUTURE_DAYS = 7;
const MIN_FUTURE_BUFFER_MS = 60_000; // require at least 1 minute in the future

const DETERMINISTIC_CANCEL_RX = /\b(cancel|abort|never\s*mind|nevermind|forget it)\b/i;

export async function handleScheduleIntent({ lead, leadId, msg, bodyText, classification }) {
  const decision = await classifyScheduleRequest({
    lead,
    subject: msg.subject || '',
    replyText: bodyText || '',
    threadId: msg.threadId || null,
    eventId: msg.messageId || msg.threadId || null
  });

  // Deterministic cancel safety net — if the reply has unambiguous cancel language and
  // there is a pending row, treat as a cancel regardless of what Gemini decided.
  const hasPending = !!scheduledCallsDb.findPendingForLead(leadId);
  const deterministicCancel = DETERMINISTIC_CANCEL_RX.test(bodyText) && hasPending;

  // Customer is canceling a previously-scheduled call.
  if (decision.isCancel || deterministicCancel) {
    const existing = scheduledCallsDb.findPendingForLead(leadId);
    if (existing) {
      cancelScheduledCall(existing.id, { reason: 'customer_email_cancel' });
      classification.replyText = "Got it — canceled the callback. Reply here whenever you'd like to pick a new time.";
      return { action: 'canceled', scheduledCallId: existing.id, reason: 'customer_email_cancel' };
    }
    classification.replyText = "No callback was scheduled on my side, but you're all good — I won't call you. Reply if you'd like one set up.";
    return { action: 'cancel_no_pending', reason: 'no_pending_to_cancel' };
  }

  if (!decision.wantsCall || decision.confidence < 0.4) {
    return { action: 'no_intent', reason: 'low_confidence_or_no_intent' };
  }

  // Parse-failed or no concrete time given.
  if (!decision.scheduledAtMs) {
    classification.replyText = "Happy to call. What time works for you? Tell me something like 'today at 3pm' or 'tomorrow morning at 10' and I'll get it on the books.";
    return { action: 'needs_time', reason: 'no_time_parsed' };
  }

  // Time in the past.
  if (decision.scheduledAtMs - Date.now() < MIN_FUTURE_BUFFER_MS) {
    classification.replyText = `Looks like ${decision.scheduledAtRaw || 'that time'} has already passed. Want to pick a future time?`;
    return { action: 'past_time', reason: 'time_in_past', scheduledAtMs: decision.scheduledAtMs };
  }

  // Too far in the future.
  if (decision.scheduledAtMs - Date.now() > MAX_FUTURE_DAYS * 86_400_000) {
    classification.replyText = `That's a bit far out — I can schedule callbacks within the next ${MAX_FUTURE_DAYS} days. Want to pick a closer time?`;
    return { action: 'too_far', reason: 'time_too_far_out', scheduledAtMs: decision.scheduledAtMs };
  }

  // Quiet-hours check using the existing compliance helper at the target moment.
  const windowStatus = callingWindowStatus(new Date(decision.scheduledAtMs), { timezone: decision.timezone });
  if (!windowStatus.allowed && env.runMode !== 'mock') {
    classification.replyText = `That falls inside our quiet hours (we only call between ${windowStatus.quietHoursEnd}:00 and ${windowStatus.quietHoursStart}:00 ${decision.timezone}). Want to pick a time inside that window?`;
    return { action: 'quiet_hours', reason: 'outside_calling_window', scheduledAtMs: decision.scheduledAtMs };
  }

  // Promote consent + seed phone allow list.
  if (lead.phone) seedAllowedPhone(lead.phone);
  if (decision.confidence >= 0.6) {
    markLeadConsentApproved(leadId, {
      reason: 'email_invite',
      proof: msg.messageId || null,
      excerpt: bodyText
    });
  }

  // Build the brief that the scheduled caller will turn into a per-call pitch.
  const brief = {
    ask: decision.ask || classification.scope || '',
    replySnippet: (bodyText || '').slice(0, 400),
    scheduledAtIso: decision.scheduledAtIso,
    scheduledAtRaw: decision.scheduledAtRaw,
    timezone: decision.timezone,
    callerName: lead.business_name && !String(lead.business_name).startsWith('Inbound caller')
      ? lead.business_name : null,
    business: lead.business_name && !String(lead.business_name).startsWith('Inbound caller')
      ? lead.business_name : null,
    confidence: decision.confidence,
    classifierReason: decision.reason
  };

  const id = `sched_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  let row;
  try {
    row = createScheduledCall({
      id,
      leadId,
      threadId: msg.threadId || null,
      inboundMessageId: msg.messageId || null,
      scheduledAtMs: decision.scheduledAtMs,
      brief
    });
  } catch (err) {
    log.error('agentmail.schedule.create_failed', { leadId, error: err?.message || String(err) });
    classification.replyText = "I tried to schedule that but hit a snag on my end. Reply with a time and I'll try again.";
    return { action: 'create_failed', reason: err?.message || String(err) };
  }

  const localTime = formatLocalTime(decision.scheduledAtMs, decision.timezone);
  classification.replyText = `Got it — I'll have Callan call you at ${localTime} from +1 (662) 602-1352. Reply CANCEL to abort. If you wanted a different time, just send another reply with the time and I'll update it.`;

  return {
    action: 'scheduled',
    scheduledCallId: row?.id || id,
    scheduledAtMs: decision.scheduledAtMs,
    reason: null
  };
}

function formatLocalTime(ms, timezone) {
  try {
    return new Date(ms).toLocaleString('en-US', {
      timeZone: timezone || 'America/Los_Angeles',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

export function classifyMessageScope(input = '') {
  const { subject, text } = normalizeClassificationInput(input);
  const policyText = normalizePolicyText(`${subject}\n${text}`);
  const optOutMatches = matchingPatterns(policyText, OPT_OUT_PATTERNS);
  if (optOutMatches.length) {
    return classificationResult({
      kind: 'opt_out',
      scope: 'opt-out',
      scopes: ['opt-out'],
      supported: true,
      operatorFlag: false,
      replyMode: 'opt_out_confirmation',
      reason: 'customer asked to stop email contact',
      matches: { supported: ['opt-out'], unsupported: [] }
    });
  }

  const supportedMatches = matchingScopePatterns(policyText, SUPPORTED_SCOPE_PATTERNS);
  if (!supportedMatches.length) {
    return classificationResult({
      kind: 'unknown',
      scope: 'unknown',
      scopes: [],
      supported: false,
      operatorFlag: false,
      replyMode: 'needs_policy_check',
      reason: 'no supported scope matched',
      matches: { supported: [], unsupported: [] }
    });
  }

  const scopes = unique(supportedMatches.map((m) => m.scope));
  return classificationResult({
    kind: 'supported',
    scope: scopes[0],
    scopes,
    supported: true,
    operatorFlag: false,
    replyMode: 'autonomous_reply',
    reason: `supported scope: ${scopes[0]}`,
    matches: { supported: scopes, unsupported: [] }
  });
}

export function classifySafeHandoff(input = '') {
  const { subject, text } = normalizeClassificationInput(input);
  const policyText = normalizePolicyText(`${subject}\n${text}`);
  const unsupportedMatches = matchingScopePatterns(policyText, UNSUPPORTED_SCOPE_PATTERNS);
  const scopes = unique(unsupportedMatches.map((m) => m.scope));
  return {
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    required: scopes.length > 0,
    operatorFlag: scopes.length > 0,
    kind: scopes.length ? 'handoff' : 'none',
    scope: scopes[0] || null,
    scopes,
    reason: scopes.length ? `unsupported scope: ${scopes[0]}` : 'no safe handoff trigger matched',
    unsupportedScopes: UNSUPPORTED_SCOPES
  };
}

export async function runSyntheticAgentMailInboundTest({
  leadId = `synthetic_mail_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
  threadId,
  fromEmail = 'owner@example.test',
  subject = 'Synthetic AgentMail question',
  text = 'Can you update the website brief with our new hours?',
  forceMockSend = true
} = {}) {
  let finalThreadId = threadId || `thread_${leadId}`;
  if (!leads.get(leadId)) {
    const insertResult = leads.insert({
      id: leadId,
      container_tag: containerTagFor(leadId),
      business_name: 'Synthetic AgentMail Test',
      phone: '+14155550199',
      address: '1 Test Way, San Francisco, CA',
      niche: 'synthetic-test',
      city: 'San Francisco',
      website: null,
      status: 'awaiting_payment',
      agentmail_thread_id: finalThreadId
    });
    leadId = insertResult.lead.id;
    finalThreadId = insertResult.lead.agentmail_thread_id || finalThreadId;
  }

  const result = await handleAgentMailInbound({
    id: `evt_${leadId}`,
    type: 'message.received',
    direction: 'inbound',
    threadId: finalThreadId,
    messageId: `msg_${leadId}`,
    from: { email: fromEmail },
    subject,
    text,
    leadId
  }, { forceMockSend, forceFallbackReply: true, writeMemory: false });

  const events = contactEvents.listByLead(leadId);
  const inboundEvents = events.filter((event) => event.direction === 'inbound' && event.channel === 'agentmail');
  const outboundEvents = events.filter((event) => event.direction === 'outbound' && event.channel === 'agentmail');
  return {
    ok: !result.ignored && inboundEvents.length > 0 && outboundEvents.length > 0,
    leadId,
    threadId: finalThreadId,
    classification: result.classification,
    inboundEvents: inboundEvents.length,
    outboundEvents: outboundEvents.length,
    result
  };
}

export function classifyMessage(input = '') {
  const { subject, text } = normalizeClassificationInput(input);
  const policyText = normalizePolicyText(`${subject}\n${text}`);

  const optOutMatches = matchingPatterns(policyText, OPT_OUT_PATTERNS);
  const unsupportedMatches = matchingScopePatterns(policyText, UNSUPPORTED_SCOPE_PATTERNS);
  const supportedMatches = matchingScopePatterns(policyText, SUPPORTED_SCOPE_PATTERNS);
  const growthReply = classifyGrowthReply({ subject, text });

  if (optOutMatches.length || growthReply.kind === 'unsubscribe') {
    return classificationResult({
      kind: 'opt_out',
      scope: 'opt-out',
      scopes: ['opt-out'],
      supported: true,
      operatorFlag: unsupportedMatches.length > 0,
      replyMode: 'opt_out_confirmation',
      reason: 'customer asked to stop email contact',
      matches: {
        supported: ['opt-out'],
        unsupported: unsupportedMatches.map((m) => m.scope)
      },
      growthReply
    });
  }

  if (unsupportedMatches.length) {
    const scope = unsupportedMatches[0]?.scope;
    return classificationResult({
      kind: 'handoff',
      scope,
      scopes: unique(unsupportedMatches.map((m) => m.scope)),
      supported: false,
      operatorFlag: true,
      replyMode: 'safe_handoff',
      reason: `unsupported scope: ${scope}`,
      matches: {
        supported: supportedMatches.map((m) => m.scope),
        unsupported: unsupportedMatches.map((m) => m.scope)
      },
      growthReply
    });
  }

  if (growthReply.kind === 'interested' || growthReply.kind === 'not_now') {
    const scope = `growth ${growthReply.kind.replace('_', ' ')}`;
    return classificationResult({
      kind: 'supported',
      scope,
      scopes: [scope, 'growth follow-up'],
      supported: true,
      operatorFlag: false,
      replyMode: 'autonomous_reply',
      reason: growthReply.reason,
      matches: {
        supported: [scope, 'growth follow-up'],
        unsupported: []
      },
      growthReply
    });
  }

  if (supportedMatches.length) {
    const scope = supportedMatches[0].scope;
    const scopes = unique(supportedMatches.map((m) => m.scope));
    return classificationResult({
      kind: 'supported',
      scope,
      scopes,
      supported: true,
      operatorFlag: false,
      replyMode: 'autonomous_reply',
      reason: `supported scope: ${scope}`,
      matches: {
        supported: scopes,
        unsupported: []
      },
      growthReply
    });
  }

  if (growthReply.kind === 'handoff') {
    return classificationResult({
      kind: 'handoff',
      scope: 'growth follow-up',
      scopes: ['growth follow-up'],
      supported: false,
      operatorFlag: true,
      replyMode: 'safe_handoff',
      reason: growthReply.reason,
      matches: {
        supported: [],
        unsupported: ['growth follow-up']
      },
      growthReply
    });
  }

  return classificationResult({
    kind: 'handoff',
    scope: 'weird request',
    scopes: ['weird request'],
    supported: false,
    operatorFlag: true,
    replyMode: 'safe_handoff',
    reason: 'outside supported autonomous reply scopes',
    matches: {
      supported: [],
      unsupported: ['weird request']
    },
    growthReply
  });
}

export async function decideEmailReply({
  lead = null,
  msg = {},
  subject = '',
  text = '',
  history = [],
  eventId = null,
  forceMock = false
} = {}) {
  const deterministic = classifyMessage({ subject: subject || msg.subject, text: text || msg.text || msg.body || msg.preview });
  const evidence = {
    lead: lead ? {
      id: lead.id,
      businessName: lead.business_name,
      status: lead.status,
      nextAction: lead.next_action
    } : null,
    message: {
      subject: subject || msg.subject || '',
      text: text || msg.text || msg.body || msg.preview || '',
      fromEmail: msg.fromEmail || null,
      threadId: msg.threadId || null
    },
    deterministicPolicy: deterministic,
    history
  };
  const prompt = [
    `Classify the AgentMail customer reply and draft the exact reply body when autonomous reply is allowed.`,
    `Supported autonomous scopes: ${SUPPORTED_SCOPE}.`,
    `Unsupported scopes: ${UNSUPPORTED_SCOPES.join(', ')}.`,
    `Opt-out requests must be kind="opt_out" and replyMode="opt_out_confirmation".`,
    `Legal, custom contract, refund threats, security issues, tax, SEO/revenue guarantees, banking, medical, or weird requests must be safe handoff.`,
    `Reply text must be concise, no markdown, no subject line, no unsupported promises.`
  ].join('\n');

  try {
    const { output, trace } = await generateStructured({
      kind: 'emailReplyDecision',
      schema: EmailReplyDecision,
      evidence,
      prompt,
      leadId: lead?.id || null,
      worker: 'mailer',
      eventId: eventId || msg.messageId || msg.threadId || null,
      thinkingLevel: 'medium',
      flash: true,
      forceMock: forceMock || !env.gemini.apiKey
    });
    return normalizeModelEmailDecision(output, deterministic, { trace });
  } catch (err) {
    log.warn('agentmail.policy.gemini_fallback', { error: err?.message || String(err), leadId: lead?.id });
    return deterministic;
  }
}

async function draftReply({ lead, msg, classification, forceFallbackReply = false }) {
  if (!forceFallbackReply && classification.replyText && classification.replyText.trim().length > 15) {
    return classification.replyText.trim();
  }
  if (classification.kind === 'opt_out') {
    return 'Understood. We will stop emailing this thread. Thanks for letting us know.';
  }
  if (classification.operatorFlag) {
    return safeHandoffResponse();
  }
  if (forceFallbackReply) {
    return fallbackSupportedReply(classification.scope);
  }

  return fallbackSupportedReply(classification.scope);
}

async function sendReply({ msg, text, classification, forceMockSend = false, leadId = null }) {
  if (forceMockSend || !canSend(msg.fromEmail)) {
    return {
      ...createMockAgentMailSendResult({
        threadId: msg.threadId,
        messageId: `mock-agentmail-reply-${Date.now().toString(36)}`,
        subject: `Re: ${stripRe(msg.subject)}`
      }),
      classification: classification.kind,
      classificationScope: classification.scope,
      operatorFlag: classification.operatorFlag
    };
  }

  const html = `<p>${escapeHtml(text).replace(/\n+/g, '</p><p>')}</p>`;
  const result = await replyAgentMailMessage({
    inboxId: msg.inboxId || env.agentmail.inboxId,
    messageId: msg.messageId,
    toEmail: msg.fromEmail,
    subject: `Re: ${stripRe(msg.subject)}`,
    text,
    html,
    leadId,
    costKind: 'reply_classified'
  }, { timeoutSeconds: 12, maxRetries: 2 });

  return {
    ...result,
    mock: false,
    providerId: result.providerId || msg.messageId || null,
    threadId: result.threadId || msg.threadId,
    classification: classification.kind,
    classificationScope: classification.scope,
    operatorFlag: classification.operatorFlag
  };
}

function normalizeClassificationInput(input) {
  if (typeof input === 'string') return { subject: '', text: input };
  return {
    subject: policyString(input?.subject),
    text: policyString(input?.text || input?.body || input?.message)
  };
}

function policyString(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value : safeString(value);
}

function normalizePolicyText(text) {
  return String(text || '')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchingPatterns(text, patterns) {
  return patterns.filter((pattern) => pattern.test(text));
}

function matchingScopePatterns(text, scopePatterns) {
  return scopePatterns
    .map(({ scope, patterns }) => ({ scope, matched: matchingPatterns(text, patterns).length }))
    .filter((entry) => entry.matched > 0);
}

function classificationResult({ kind, scope, scopes, supported, operatorFlag, replyMode, reason, matches, growthReply = null }) {
  return {
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    kind,
    scope,
    scopes: unique(scopes),
    supported,
    operatorFlag,
    replyMode,
    reason,
    matches: {
      supported: unique(matches?.supported || []),
      unsupported: unique(matches?.unsupported || [])
    },
    supportedScopes: SUPPORTED_SCOPES,
    unsupportedScopes: UNSUPPORTED_SCOPES,
    growthReply
  };
}

function normalizeModelEmailDecision(model, deterministic, { trace } = {}) {
  const safeBase = safetyFloor(deterministic, model);
  if (safeBase !== model) {
    return {
      ...safeBase,
      replyText: safeBase.kind === 'opt_out' ? 'Understood. We will stop emailing this thread. Thanks for letting us know.' : safeHandoffResponse(),
      confidence: model?.confidence ?? deterministic.confidence ?? 0.7,
      reasoningTraceId: trace?.id || null,
      reasoningSchemaValid: trace?.valid ?? true,
      reasoningRepairAttempts: trace?.repairAttempts || 0
    };
  }

  const scope = SUPPORTED_SCOPES.includes(model.scope) || model.scope === 'opt-out'
    ? model.scope
    : deterministic.scope;
  const supported = model.kind === 'supported' && SUPPORTED_SCOPES.includes(scope);
  const operatorFlag = Boolean(model.operatorFlag || model.kind === 'handoff' || !supported);
  const kind = model.kind === 'opt_out' ? 'opt_out' : operatorFlag ? 'handoff' : 'supported';
  return {
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    kind,
    scope: kind === 'opt_out' ? 'opt-out' : scope,
    scopes: unique(model.scopes?.length ? model.scopes : [scope]),
    supported: kind === 'opt_out' ? true : supported,
    operatorFlag: kind === 'handoff' || operatorFlag,
    replyMode: kind === 'opt_out' ? 'opt_out_confirmation' : kind === 'handoff' ? 'safe_handoff' : 'autonomous_reply',
    reason: model.reason || deterministic.reason,
    matches: {
      supported: unique(model.matches?.supported || deterministic.matches?.supported || []),
      unsupported: unique(model.matches?.unsupported || deterministic.matches?.unsupported || [])
    },
    supportedScopes: SUPPORTED_SCOPES,
    unsupportedScopes: UNSUPPORTED_SCOPES,
    replyText: cleanReplyText(model.replyText),
    confidence: model.confidence ?? 0.7,
    sourceEvidence: model.sourceEvidence || [],
    reasoningTraceId: trace?.id || null,
    reasoningSchemaValid: trace?.valid ?? true,
    reasoningRepairAttempts: trace?.repairAttempts || 0
  };
}

function safetyFloor(deterministic, model) {
  if (deterministic.kind === 'opt_out') return deterministic;
  if (deterministic.operatorFlag) return deterministic;
  if (model?.kind === 'opt_out' || model?.kind === 'handoff') return model;
  return model;
}

function cleanReplyText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 15) return null;
  return text.slice(0, 1200);
}

function fallbackSupportedReply(scope) {
  if (scope === 'invoice') {
    return 'Thanks for the note. I can help with invoice and payment questions right here. Send over what you are seeing on the invoice or checkout page and I will keep it moving.';
  }
  if (scope === 'scheduling') {
    return 'Thanks for the note. Send a couple of times that work for you and I will keep scheduling simple from this thread.';
  }
  if (scope === 'brief') {
    return 'Thanks for the details. Send the pages, services, photos, colors, or copy you want reflected on the site and I will fold them into the brief.';
  }
  if (scope === 'revisions') {
    return 'Thanks for the revision note. Send the exact change you want made, plus the page or section it belongs on, and I will use that to keep the build moving.';
  }
  if (scope === 'pricing') {
    return 'Thanks for asking. I can help with pricing and package questions right here in this thread. Tell me what scope you have in mind and I will keep the answer concrete.';
  }
  if (scope === 'build progress') {
    return 'Thanks for checking in. I can help with build progress, preview links, and launch status here. I will keep the next update focused on where the site stands.';
  }
  return 'Thanks for the note. The invoice, scheduling, website brief, revisions, pricing, and build progress can all be handled right here in this thread. Send any details you want reflected on the site and I will keep the build moving.';
}

function safeHandoffResponse() {
  return 'Thanks for asking. I can only handle invoice questions, scheduling, website briefs, revisions, pricing, build progress, and opt-outs in this automated thread. I have flagged the operator and paused the automated handling so a human can review this safely.';
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function canSend(toEmail) {
  return canEmail(toEmail) && !!env.agentmail.apiKey && !!env.agentmail.inboxId;
}

function persistThreadForLead(leadId, threadId, knownLead) {
  if (!leadId || !threadId) return;
  const lead = knownLead || leads.get(leadId);
  if (!lead || lead.agentmail_thread_id) return;
  leads.update(leadId, { agentmail_thread_id: threadId });
}

async function writeMailMemory(leadId, direction, msg, metadata = {}) {
  try {
    await addDoc(containerTagFor(leadId), 'mail_thread', {
      direction,
      threadId: msg.threadId,
      messageId: msg.messageId,
      subject: msg.subject,
      body: msg.text,
      at: new Date().toISOString()
    }, metadata);
  } catch (err) {
    log.warn('agentmail.memory.add_failed', { leadId, direction, error: err?.message || String(err) });
  }
}

function emailOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.includes('@') ? value : null;
  if (Array.isArray(value)) return emailOf(value[0]);
  return value.email || value.address || null;
}

function stripRe(subject = '') {
  return String(subject || '').replace(/^re:\s*/i, '') || 'callmemaybe';
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return undefined;
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0] || '*'}***@***.${tld}`;
}

function safeString(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
