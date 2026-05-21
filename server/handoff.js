import { createHash, randomBytes } from 'node:crypto';
import { emit } from './sse.js';
import { contactEvents, handoffCases, leads, scheduledCalls as scheduledCallsDb } from './db.js';
import { createScheduledCall } from './scheduledCalls.js';
import { log } from './logger.js';

const SAFE_REPLY = 'Thanks for asking. I can only handle invoice questions, scheduling, website briefs, revisions, pricing, build progress, and opt-outs in this automated thread. I have flagged the operator and paused the automated handling so a human can review this safely.';

const CATEGORY_RULES = Object.freeze([
  rule('refund_threat', 'high', [
    /\brefund\b/i,
    /\bchargeback\b/i,
    /\bdispute\s+(?:the\s+)?(?:charge|payment|invoice)\b/i,
    /\bget\s+my\s+money\s+back\b/i,
    /\brefund\s+if\b/i
  ]),
  rule('security_issue', 'high', [
    /\bsecurity\b/i,
    /\bbreach\b/i,
    /\bvulnerability\b/i,
    /\bdata\s+leak\b/i,
    /\bpassword\b/i,
    /\bhacked\b/i,
    /\baccount\s+(?:takeover|compromised)\b/i
  ]),
  rule('legal', 'high', [
    /\blegal\b/i,
    /\blawyer\b/i,
    /\battorney\b/i,
    /\blawsuit\b/i,
    /\bsue\b/i,
    /\bcourt\b/i,
    /\bregulatory\b/i
  ]),
  rule('custom_contract', 'high', [
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
  ]),
  rule('tax', 'high', [
    /\btax(?:es|ing|able)?\b/i,
    /\bsales\s+tax\b/i,
    /\bvat\b/i,
    /\bw-?9\b/i,
    /\b1099\b/i,
    /\bcpa\b/i,
    /\baccountant\b/i
  ]),
  rule('guarantee', 'high', [
    /\bguarantee(?:d|s)?\b/i,
    /\bpromise\s+(?:me\s+)?(?:ranking|rankings|revenue|sales|traffic|leads?)\b/i,
    /\bfirst\s+page\s+(?:of\s+)?google\b/i,
    /\bseo\s+guarantee\b/i,
    /\brevenue\s+guarantee\b/i
  ]),
  rule('angry_customer', 'high', [
    /\bangry\b/i,
    /\bfurious\b/i,
    /\bupset\b/i,
    /\bunacceptable\b/i,
    /\bridiculous\b/i,
    /\bscam\b/i,
    /\breport\s+(?:you|this|it)\b/i,
    /\bbb\b|\bbetter\s+business\s+bureau\b/i,
    /\bnever\s+(?:agreed|asked)\b/i
  ]),
  rule('payment_failure', 'medium', [
    /\bpayment\s+(?:failed|failure|error|declined|won'?t\s+go\s+through)\b/i,
    /\bcard\s+(?:failed|declined|rejected|won'?t\s+work)\b/i,
    /\bstripe\s+(?:error|declined|failed)\b/i,
    /\bcheckout\s+(?:failed|error|won'?t\s+work|is\s+broken)\b/i,
    /\binvoice\s+link\s+(?:failed|broken|doesn'?t\s+work)\b/i
  ]),
  rule('uncertain_call_consent', 'high', [
    /\bdid(?:n'?t| not)\s+consent\b/i,
    /\bdo\s+not\s+record\b/i,
    /\bstop\s+recording\b/i,
    /\bare\s+you\s+recording\b/i,
    /\bwhere\s+did\s+you\s+get\s+my\s+number\b/i,
    /\bhow\s+did\s+you\s+get\s+my\s+number\b/i,
    /\btake\s+me\s+off\s+(?:your\s+)?call\s+list\b/i
  ]),
  rule('build_auth_wall', 'medium', [
    /\bauth(?:entication)?\s+(?:wall|needed|required|blocked)\b/i,
    /\bsign[-\s]?in\s+(?:required|needed|wall)\b/i,
    /\blogin\s+(?:required|needed|wall)\b/i
  ]),
  rule('qa_failure', 'medium', [
    /\bqa\s+(?:failed|failure)\b/i,
    /\bfailed\s+after\s+(?:max\s+)?revisions?\b/i,
    /\brevision\s+limit\b/i
  ]),
  rule('provider_failure', 'medium', [
    /\bprovider\s+(?:failed|failure|outage|error)\b/i,
    /\bapi\s+(?:failed|failure|error|timeout)\b/i,
    /\btimeout\b/i,
    /\bunauthorized\b/i,
    /\bforbidden\b/i
  ]),
  rule('weird_request', 'medium', [
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
    /\bimmigration\b/i,
    /\bpassport\b/i,
    /\bweapon\b/i,
    /\bnude\b/i,
    /\blottery\b/i
  ])
]);

const SCOPE_TO_CATEGORY = Object.freeze({
  legal: 'legal',
  'custom contract': 'custom_contract',
  'refund threat': 'refund_threat',
  'security issue': 'security_issue',
  tax: 'tax',
  guarantees: 'guarantee',
  'weird request': 'weird_request',
  spam: 'provider_failure',
  blocked: 'provider_failure',
  unauthenticated: 'provider_failure'
});

export function safeHandoffReply() {
  return SAFE_REPLY;
}

export function classifyHandoffRisk({
  subject = '',
  text = '',
  source = 'message',
  classification = null,
  forcedCategory = null,
  reason = null
} = {}) {
  const policyText = normalizeText(`${subject}\n${text}`);
  const matches = [];

  for (const item of CATEGORY_RULES) {
    const hit = item.patterns.find((pattern) => pattern.test(policyText));
    if (hit) matches.push({ category: item.category, severity: item.severity, pattern: hit.source });
  }

  const scopes = [
    classification?.scope,
    ...(classification?.scopes || []),
    ...(classification?.matches?.unsupported || [])
  ].filter(Boolean);
  for (const scope of scopes) {
    const category = SCOPE_TO_CATEGORY[String(scope).toLowerCase()];
    if (category && !matches.some((item) => item.category === category)) {
      matches.push({ category, severity: severityForCategory(category), pattern: `scope:${scope}` });
    }
  }

  if (forcedCategory && !matches.some((item) => item.category === forcedCategory)) {
    matches.push({ category: normalizeCode(forcedCategory), severity: severityForCategory(forcedCategory), pattern: 'forced' });
  }

  if (classification?.operatorFlag && !matches.length) {
    matches.push({ category: 'weird_request', severity: 'medium', pattern: 'operator_flag' });
  }

  const ranked = matches.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const primary = ranked[0] || null;
  return {
    caseRequired: Boolean(primary),
    source,
    category: primary?.category || null,
    severity: primary?.severity || null,
    categories: ranked.map((item) => item.category),
    matches: ranked,
    reason: reason || classification?.reason || (primary ? `handoff trigger: ${primary.category}` : 'no handoff trigger')
  };
}

export function createHandoffCaseFromMail({
  lead = null,
  leadId = lead?.id || null,
  msg = {},
  inboundEventId,
  classification,
  risk,
  draftReply = SAFE_REPLY
} = {}) {
  const resolvedRisk = risk?.caseRequired
    ? risk
    : classifyHandoffRisk({
        subject: msg.subject,
        text: msg.text || msg.preview || '',
        source: 'agentmail',
        classification
      });
  if (!resolvedRisk.caseRequired && !classification?.operatorFlag) return null;

  const category = resolvedRisk.category || 'weird_request';
  const summary = summarizeCustomerMessage({ category, subject: msg.subject, text: msg.text || msg.preview });
  const evidence = mailEvidence({ msg, inboundEventId, classification, risk: resolvedRisk });
  return createHandoffCase({
    leadId,
    sourceType: 'agentmail',
    sourceId: msg.messageId || msg.threadId || null,
    sourceEventId: inboundEventId || null,
    severity: resolvedRisk.severity || severityForCategory(category),
    category,
    summary,
    evidence,
    recommendedAction: recommendedActionFor(category),
    copilot: copilotForCase({
      summary,
      evidence,
      category,
      severity: resolvedRisk.severity || severityForCategory(category),
      draftReply,
      policyNotes: policyNotesFor(category),
      whyNotAutonomous: whyNotAutonomousFor(category)
    }),
    idempotencyKey: `handoff:agentmail:${inboundEventId || msg.messageId || stableHash({ msg, leadId })}`
  });
}

export function createHandoffCaseFromBuilderAuthWall({
  leadId,
  buildId,
  sessionId = null,
  target = 'lovable',
  reason = 'Builder hit an authentication wall.',
  liveUrl = null
} = {}) {
  const evidence = [
    evidenceItem('build', buildId, reason, { buildId, sessionId, target, liveUrl })
  ];
  return createHandoffCase({
    leadId,
    sourceType: 'builder',
    sourceId: buildId,
    severity: 'medium',
    category: 'build_auth_wall',
    summary: `${target} build needs a human sign-in before automation can continue.`,
    evidence,
    recommendedAction: 'Open the live builder session, complete sign-in if appropriate, then retry the build from the operator desk.',
    copilot: copilotForCase({
      summary: `${target} blocked on authentication.`,
      evidence,
      category: 'build_auth_wall',
      severity: 'medium',
      draftReply: null,
      policyNotes: ['Do not ask the agent to bypass authentication or MFA.'],
      whyNotAutonomous: 'The agent cannot safely handle credentials, MFA, or account consent on its own.'
    }),
    idempotencyKey: `handoff:builder_auth:${buildId || sessionId || leadId}`
  });
}

export function createHandoffCaseFromQaFailure({
  leadId,
  buildId,
  qaResultId = null,
  errors = [],
  maxRevisions = null,
  projectUrl = null
} = {}) {
  const evidence = [
    evidenceItem('build_qa', qaResultId || buildId, `QA failed after ${maxRevisions ?? 'the'} revision limit.`, {
      buildId,
      qaResultId,
      errors,
      projectUrl,
      maxRevisions
    })
  ];
  return createHandoffCase({
    leadId,
    sourceType: 'builder_qa',
    sourceId: qaResultId || buildId,
    severity: 'medium',
    category: 'qa_failure',
    summary: `Build QA failed after the revision limit: ${errors.slice(0, 3).join(', ') || 'manual review needed'}.`,
    evidence,
    recommendedAction: 'Review the failed checklist, decide whether to manually edit, retry the build, or explain the blocker to the customer.',
    copilot: copilotForCase({
      summary: 'Generated site did not pass the shipping gate.',
      evidence,
      category: 'qa_failure',
      severity: 'medium',
      draftReply: null,
      policyNotes: ['Do not mark the site shipped until finalAccept passes.'],
      whyNotAutonomous: 'The automated revision loop reached its configured limit and must not keep retrying blindly.'
    }),
    idempotencyKey: `handoff:qa_failure:${qaResultId || buildId}`
  });
}

export function createHandoffCaseFromProviderFailure({
  leadId,
  provider,
  sourceId = null,
  error,
  category = 'provider_failure',
  severity = 'medium'
} = {}) {
  const summary = `${provider || 'Provider'} failed: ${cleanText(error || 'unknown provider error')}`;
  const evidence = [evidenceItem(provider || 'provider', sourceId, summary, { provider, sourceId, error })];
  return createHandoffCase({
    leadId,
    sourceType: provider || 'provider',
    sourceId,
    severity,
    category,
    summary,
    evidence,
    recommendedAction: 'Check provider status and credentials, then retry only when the failure is understood.',
    copilot: copilotForCase({
      summary,
      evidence,
      category,
      severity,
      draftReply: null,
      policyNotes: ['Do not loop retries without a changed provider condition.'],
      whyNotAutonomous: 'Provider failure can consume budget or duplicate work if retried blindly.'
    }),
    idempotencyKey: `handoff:provider:${provider || 'provider'}:${sourceId || stableHash(error)}`
  });
}

export function createHandoffCaseFromPaymentFailure({
  normalized,
  eventId,
  event = {}
} = {}) {
  const leadId = normalized?.leadId || null;
  const objectId = normalized?.invoiceId || normalized?.sessionId || normalized?.objectId || event?.data?.object?.id || null;
  const reason = paymentFailureReason(event?.data?.object || {}, normalized);
  const evidence = [
    evidenceItem('stripe', objectId, reason, {
      eventId,
      eventType: normalized?.eventType,
      invoiceId: normalized?.invoiceId,
      objectId,
      amountCents: normalized?.amountCents
    })
  ];
  return createHandoffCase({
    leadId,
    sourceType: 'stripe',
    sourceId: objectId,
    severity: 'medium',
    category: 'payment_failure',
    summary: `Stripe reported a payment failure${leadId ? ` for ${leadId}` : ''}: ${reason}`,
    evidence,
    recommendedAction: 'Check the invoice/payment status, then send the customer a human-reviewed payment help note or alternate link.',
    copilot: copilotForCase({
      summary: 'Payment failed or was declined.',
      evidence,
      category: 'payment_failure',
      severity: 'medium',
      draftReply: 'I saw the payment did not go through. I am flagging this for a human review so we can help without sending you in circles.',
      policyNotes: ['Do not claim the payment succeeded until Stripe confirms it.'],
      whyNotAutonomous: 'Payment failures can involve card, bank, invoice, or account issues that need a human-safe path.'
    }),
    idempotencyKey: `handoff:stripe_payment_failure:${eventId || objectId || stableHash(event)}`
  });
}

export function createHandoffCaseFromCallTransfer({
  leadId,
  callId,
  providerCallId,
  reason
} = {}) {
  const category = String(reason || '').startsWith('uncertain_consent:')
    ? 'uncertain_call_consent'
    : String(reason || '').startsWith('objection:')
      ? 'angry_customer'
      : 'weird_request';
  const evidence = [
    evidenceItem('call', callId || providerCallId, reason || 'Call needs live operator.', { callId, providerCallId, reason })
  ];
  return createHandoffCase({
    leadId,
    sourceType: 'agentphone',
    sourceId: callId || providerCallId || null,
    severity: severityForCategory(category),
    category,
    summary: category === 'uncertain_call_consent'
      ? 'Caller raised recording/contact consent uncertainty.'
      : 'Caller asked for a human or raised an objection that needs operator judgment.',
    evidence,
    recommendedAction: category === 'uncertain_call_consent'
      ? 'Stop autonomous handling, verify consent/disclosure state, and only resume if the operator records a safe basis.'
      : 'Take over the call or schedule a callback; do not push the autonomous pitch.',
    copilot: copilotForCase({
      summary: reason || 'Call requires operator takeover.',
      evidence,
      category,
      severity: severityForCategory(category),
      draftReply: null,
      policyNotes: category === 'uncertain_call_consent' ? ['Consent uncertainty must be resolved by a human.'] : ['Honor requests for a live human.'],
      whyNotAutonomous: 'Live calls can create consent, pressure, or escalation risk that should not be guessed through.'
    }),
    idempotencyKey: `handoff:call:${callId || providerCallId || stableHash(reason)}`
  });
}

export function recordHandoffSafeReply({ caseId, outboundEventId, replyText, mock = false } = {}) {
  const row = handoffCases.get(caseId);
  if (!row) return null;
  const action = handoffCases.recordAction({
    case_id: row.id,
    lead_id: row.lead_id,
    action: 'safe_reply_sent',
    actor: 'mailer',
    note: 'Safe handoff reply was sent before operator review.',
    payload: { outboundEventId, replyText, mock }
  });
  emit('handoff.action', { worker: 'operator', leadId: row.lead_id, caseId: row.id, action: 'safe_reply_sent' });
  return action;
}

export function createHandoffCase(input) {
  const result = handoffCases.createOrGet({
    lead_id: input.leadId,
    source_type: input.sourceType,
    source_id: input.sourceId,
    source_event_id: input.sourceEventId,
    source_url: input.sourceUrl,
    severity: input.severity,
    category: input.category,
    status: input.status || 'open',
    assigned_to: input.assignedTo,
    summary: input.summary,
    evidence: input.evidence,
    recommended_action: input.recommendedAction,
    copilot: input.copilot,
    idempotency_key: input.idempotencyKey
  });
  if (result.inserted) {
    if (input.leadId) markLeadForHandoff(input.leadId, input.category);
    try {
      contactEvents.add({
        id: `handoff_${safeId(result.case.id)}`,
        lead_id: input.leadId || null,
        type: 'handoff_case_created',
        direction: 'internal',
        channel: 'operator',
        subject: input.category,
        body: input.summary,
        metadata: {
          caseId: result.case.id,
          severity: result.case.severity,
          category: result.case.category,
          recommendedAction: result.case.recommended_action,
          sourceType: result.case.source_type,
          sourceEventId: result.case.source_event_id
        }
      });
    } catch (err) {
      if (!isDuplicate(err)) log.warn('handoff.contact_event_failed', { caseId: result.case.id, error: err?.message || String(err) });
    }
    emit('handoff.case_created', {
      worker: 'operator',
      leadId: result.case.lead_id,
      caseId: result.case.id,
      severity: result.case.severity,
      category: result.case.category,
      status: result.case.status,
      summary: result.case.summary
    });
  }
  return result;
}

export async function performHandoffAction(caseId, {
  action,
  actor = 'operator',
  note = null,
  body = null,
  assignedTo = null,
  scheduledAtMs = null,
  ask = null,
  resumeAutomation = false,
  startBuilder = null,
  target = null
} = {}) {
  const current = handoffCases.get(caseId);
  if (!current) throw new Error(`handoff case ${caseId} not found`);
  const normalized = normalizeCode(action);
  let payload = {};
  let nextStatus = null;

  if (normalized === 'approve_reply') {
    const replyText = current.copilot?.draftReply || current.copilot?.draft_reply || SAFE_REPLY;
    payload = { outboundEventId: persistOperatorReply(current, replyText, { actor, action: normalized }), replyText };
    nextStatus = 'operator_reply_sent';
  } else if (normalized === 'rewrite_send_reply') {
    const replyText = cleanText(body);
    if (!replyText) throw new Error('rewrite_send_reply requires body');
    payload = { outboundEventId: persistOperatorReply(current, replyText, { actor, action: normalized }), replyText };
    nextStatus = 'operator_reply_sent';
  } else if (normalized === 'reject_reply') {
    payload = { rejectedDraft: current.copilot?.draftReply || null };
    nextStatus = 'needs_operator';
  } else if (normalized === 'pause_automation') {
    pauseAutomationForLead(current.lead_id);
    payload = { leadPaused: true };
    nextStatus = 'paused';
  } else if (normalized === 'resume_automation') {
    payload = { resumed: resumeAutomationForLead(current.lead_id, current.category) };
    nextStatus = current.status === 'resolved' ? 'resolved' : 'in_progress';
  } else if (normalized === 'assign_callback') {
    payload = { scheduledCall: assignCallback(current, { scheduledAtMs, ask }) };
    nextStatus = 'assigned';
  } else if (normalized === 'retry_build' || normalized === 'retry_qa') {
    if (typeof startBuilder === 'function' && current.lead_id) {
      startBuilder({ leadId: current.lead_id, target: target || undefined });
      payload = { retryStarted: true, target: target || null };
    } else {
      payload = { retryStarted: false, reason: 'no_start_builder' };
    }
    nextStatus = 'in_progress';
  } else if (normalized === 'resolve' || normalized === 'mark_resolved') {
    if (resumeAutomation) payload.resumed = resumeAutomationForLead(current.lead_id, current.category);
    nextStatus = 'resolved';
  } else {
    payload = { noteOnly: true };
  }

  const actionRow = handoffCases.recordAction({
    case_id: current.id,
    lead_id: current.lead_id,
    action: normalized,
    actor,
    note,
    payload
  });
  const updated = nextStatus ? handoffCases.update(current.id, {
    status: nextStatus,
    assignedTo: assignedTo ?? current.assigned_to ?? null
  }) : handoffCases.get(current.id);
  if (assignedTo && nextStatus !== 'resolved') {
    handoffCases.update(current.id, { assignedTo });
  }
  emit('handoff.action', {
    worker: 'operator',
    leadId: current.lead_id,
    caseId: current.id,
    action: normalized,
    status: updated?.status || current.status
  });
  return { ok: true, case: handoffCases.get(current.id), action: actionRow };
}

export function handoffDeskSummary({ leadId = null, status = 'open', limit = 80, category = null } = {}) {
  const cases = handoffCases.list({ lead_id: leadId, status, category, limit });
  return {
    ok: true,
    ts: Date.now(),
    summary: handoffCases.summary(),
    cases
  };
}

function rule(category, severity, patterns) {
  return { category, severity, patterns };
}

function markLeadForHandoff(leadId, category) {
  const lead = leads.get(leadId);
  if (!lead) return;
  const nextAction = category?.startsWith?.('build') || category === 'qa_failure'
    ? 'operator_review_build'
    : category === 'payment_failure'
      ? 'operator_review_payment'
      : 'operator_review_mail';
  leads.update(leadId, {
    risk_status: 'operator-handoff',
    next_action: nextAction
  });
}

function pauseAutomationForLead(leadId) {
  if (!leadId || !leads.get(leadId)) return false;
  leads.update(leadId, {
    outreach_status: 'blocked',
    risk_status: 'operator-paused',
    next_action: 'operator_paused'
  });
  return true;
}

function resumeAutomationForLead(leadId, category) {
  if (!leadId) return false;
  const lead = leads.get(leadId);
  if (!lead) return false;
  const patch = {
    risk_status: 'operator-resolved',
    next_action: null
  };
  if (
    lead.outreach_status === 'blocked' &&
    !['uncertain_call_consent', 'legal', 'refund_threat', 'security_issue', 'custom_contract', 'tax'].includes(category)
  ) {
    patch.outreach_status = 'queued';
  }
  leads.update(leadId, patch);
  return true;
}

function assignCallback(current, { scheduledAtMs, ask }) {
  if (!current.lead_id) throw new Error('assign_callback requires a lead_id on the case');
  const ts = Number(scheduledAtMs) || Date.now() + 15 * 60_000;
  const existing = scheduledCallsDb.findPendingForLead(current.lead_id);
  if (existing) return existing;
  return createScheduledCall({
    id: `sched_handoff_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
    leadId: current.lead_id,
    threadId: threadIdFromCase(current),
    inboundMessageId: current.source_id || current.source_event_id || null,
    scheduledAtMs: ts,
    brief: {
      ask: cleanText(ask) || current.summary,
      source: 'handoff_case',
      caseId: current.id,
      category: current.category
    }
  });
}

function persistOperatorReply(current, replyText, { actor, action }) {
  const sourceEvent = current.source_event_id
    ? contactEvents.listByLead(current.lead_id, { limit: 200 }).find((event) => event.id === current.source_event_id)
    : null;
  return contactEvents.add({
    lead_id: current.lead_id,
    type: 'operator_reply',
    direction: 'outbound',
    channel: 'agentmail',
    provider_id: `operator-${current.id}-${Date.now().toString(36)}`,
    thread_id: sourceEvent?.thread_id || null,
    subject: sourceEvent?.subject ? `Re: ${stripRe(sourceEvent.subject)}` : 'Operator reply',
    body: replyText,
    metadata: {
      caseId: current.id,
      actor,
      action,
      mock: true,
      allowed: true,
      decisionCode: 'handoff.operator_reply',
      decisionReason: 'Operator approved or rewrote the customer-facing reply.'
    }
  });
}

function threadIdFromCase(current) {
  if (!current.lead_id) return null;
  const event = contactEvents
    .listByLead(current.lead_id, { limit: 100 })
    .find((row) => row.id === current.source_event_id || (row.channel === 'agentmail' && row.thread_id));
  return event?.thread_id || null;
}

function summarizeCustomerMessage({ category, subject, text }) {
  const excerpt = cleanText(text).slice(0, 220);
  return `${labelize(category)} request${subject ? ` (${cleanText(subject).slice(0, 80)})` : ''}: ${excerpt || 'No message body captured.'}`;
}

function mailEvidence({ msg, inboundEventId, classification, risk }) {
  return [
    evidenceItem('contact_events', inboundEventId, msg.text || msg.preview || msg.subject || 'AgentMail inbound message.', {
      contactEventId: inboundEventId || null,
      messageId: msg.messageId || null,
      threadId: msg.threadId || null,
      subject: msg.subject || null
    }),
    evidenceItem('mail_policy', classification?.reason || risk?.reason, classification?.reason || risk?.reason, {
      classification,
      risk
    })
  ].filter((item) => item.excerpt || item.ref);
}

function evidenceItem(source, ref, excerpt, metadata = {}) {
  return {
    source,
    ref: ref || null,
    excerpt: cleanText(excerpt).slice(0, 500),
    metadata
  };
}

function copilotForCase({ summary, evidence, category, severity, draftReply, policyNotes, whyNotAutonomous }) {
  return {
    summary: cleanText(summary).slice(0, 500),
    evidenceCitations: (evidence || []).map((item) => `${item.source}${item.ref ? `:${item.ref}` : ''}`),
    safestNextAction: recommendedActionFor(category),
    draftReply,
    policyNotes,
    whyNotAutonomous,
    severity,
    category
  };
}

function recommendedActionFor(category) {
  switch (category) {
    case 'refund_threat':
      return 'Pause automation, review payment/build facts, and have a human answer with a concrete resolution path.';
    case 'legal':
    case 'custom_contract':
    case 'tax':
    case 'security_issue':
      return 'Do not provide advice. A human should acknowledge the ask and route to the appropriate professional or internal owner.';
    case 'guarantee':
      return 'Human should clarify what can be promised without making SEO, revenue, legal, or refund guarantees.';
    case 'angry_customer':
      return 'Human should de-escalate, summarize the concern, and choose a callback or written reply.';
    case 'payment_failure':
      return 'Human should inspect Stripe and send a payment help reply or fresh link if safe.';
    case 'build_auth_wall':
      return 'Operator should complete sign-in if appropriate, then retry the build.';
    case 'qa_failure':
      return 'Operator should review failed QA and decide between manual fix, retry, or customer update.';
    case 'provider_failure':
      return 'Operator should inspect provider status/credentials before retrying.';
    case 'uncertain_call_consent':
      return 'Stop autonomous call handling until consent and disclosure are verified.';
    default:
      return 'Operator should review the evidence and choose the safest next step.';
  }
}

function policyNotesFor(category) {
  switch (category) {
    case 'refund_threat':
      return ['Do not promise refunds or admit fault without operator review.'];
    case 'legal':
    case 'custom_contract':
      return ['Do not provide legal advice or interpret contract terms.'];
    case 'tax':
      return ['Do not provide tax advice.'];
    case 'security_issue':
      return ['Do not request passwords or secrets in email.'];
    case 'guarantee':
      return ['Do not guarantee rankings, revenue, sales, traffic, or outcomes.'];
    case 'payment_failure':
      return ['Do not claim payment succeeded until Stripe confirms it.'];
    default:
      return ['Keep the automated system conservative until a human resolves the case.'];
  }
}

function whyNotAutonomousFor(category) {
  switch (category) {
    case 'refund_threat':
      return 'Refund or chargeback threats can create financial and reputational risk.';
    case 'legal':
    case 'custom_contract':
    case 'tax':
      return 'The request asks for professional judgment outside the supported autonomous scopes.';
    case 'security_issue':
      return 'Security issues may involve sensitive data or credentials.';
    case 'guarantee':
      return 'The agent must not make outcome guarantees.';
    case 'angry_customer':
      return 'The customer is escalated; tone and remedy need human judgment.';
    case 'payment_failure':
      return 'Payment failures require checking provider truth before giving instructions.';
    default:
      return 'The request is outside the safe autonomous policy surface.';
  }
}

function paymentFailureReason(object = {}, normalized = {}) {
  return cleanText(
    object.last_payment_error?.message ||
    object.failure_message ||
    object.status ||
    normalized?.eventType ||
    'payment failed'
  );
}

function severityForCategory(category) {
  const found = CATEGORY_RULES.find((item) => item.category === normalizeCode(category));
  return found?.severity || 'medium';
}

function severityRank(severity) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity] ?? 2;
}

function normalizeText(value) {
  return cleanText(value)
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function labelize(value) {
  return String(value || '').replace(/_/g, ' ');
}

function normalizeCode(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'unknown';
}

function safeId(value) {
  return normalizeCode(value).slice(0, 120);
}

function stableHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function stripRe(subject = '') {
  return String(subject || '').replace(/^re:\s*/i, '').trim() || '(no subject)';
}

function isDuplicate(err) {
  return err?.code?.startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(err?.message || '');
}
