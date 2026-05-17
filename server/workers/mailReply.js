import { randomBytes } from 'node:crypto';
import { emit } from '../sse.js';
import { contactEvents, leads } from '../db.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { addDoc, containerTagFor } from '../memory.js';
import { generateText } from '../gemini.js';
import {
  createMockAgentMailSendResult,
  fetchAgentMailIncomingMessages,
  isInboundAgentMailMessage,
  normalizeAgentMailMessage,
  replyAgentMailMessage
} from '../providers/agentmail.js';

export { fetchAgentMailIncomingMessages };

const CLASSIFICATION_SCHEMA_VERSION = 1;

const SUPPORTED_SCOPES = Object.freeze([
  'invoice',
  'scheduling',
  'brief',
  'revisions',
  'pricing',
  'build progress',
  'opt-out'
]);

const UNSUPPORTED_SCOPES = Object.freeze([
  'legal',
  'custom contract',
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
  'opt-out or unsubscribe'
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
  const classification = classifyMessage({ subject: msg.subject, text: bodyText });

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

  const replyText = await draftReply({ lead: resolvedLead, msg, classification, forceFallbackReply });
  const sendResult = await sendReply({ msg, text: replyText, classification, forceMockSend });
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
    mock: sendResult.mock
  });

  return { ignored: false, leadId, replyText, classification, sendResult };
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

  if (optOutMatches.length) {
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
      }
    });
  }

  if (unsupportedMatches.length) {
    const scope = unsupportedMatches[0].scope;
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
      }
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
      }
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
    }
  });
}

async function draftReply({ lead, msg, classification, forceFallbackReply = false }) {
  if (classification.kind === 'opt_out') {
    return 'Understood. We will stop emailing this thread. Thanks for letting us know.';
  }
  if (classification.operatorFlag) {
    return safeHandoffResponse();
  }
  if (forceFallbackReply) {
    return fallbackSupportedReply(classification.scope);
  }

  try {
    if (!env.gemini.apiKey) throw new Error('GEMINI_API_KEY missing');
    const prompt = [
      `Business: ${lead?.business_name || 'unknown small business'}`,
      `Customer email subject: ${msg.subject}`,
      `Customer message:`,
      msg.text || '(empty)',
      '',
      `Classification: ${classification.scope} (${classification.reason}).`,
      `Reply as callmemaybe's autonomous AgentMail agent.`,
      `Stay strictly inside this service scope: ${SUPPORTED_SCOPE}.`,
      `Be brief, concrete, and useful. If they ask for anything outside scope, say a human will review it.`,
      `Do not make legal promises, SEO guarantees, custom contract commitments, or unsupported delivery claims.`
    ].join('\n');
    const text = await generateText({
      prompt,
      systemInstruction: 'You write concise customer-service email replies for a website agency. No markdown.',
      thinkingLevel: 'low',
      flash: true
    });
    if (text && text.trim().length > 15) return text.trim();
  } catch (err) {
    log.warn('agentmail.reply.gemini_fallback', { error: err?.message || String(err) });
  }

  return fallbackSupportedReply(classification.scope);
}

async function sendReply({ msg, text, classification, forceMockSend = false }) {
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
    html
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

function classificationResult({ kind, scope, scopes, supported, operatorFlag, replyMode, reason, matches }) {
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
    unsupportedScopes: UNSUPPORTED_SCOPES
  };
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
  if (!['live', 'demo_live', 'autonomous_live'].includes(env.runMode)) return false;
  if (!env.live.emails || !env.agentmail.apiKey || !env.agentmail.inboxId) return false;
  if (env.runMode === 'demo_live' && !env.allowedEmails.includes(toEmail)) return false;
  return !!toEmail;
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
