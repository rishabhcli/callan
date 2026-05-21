import { scheduledCalls } from './db.js';
import { log } from './logger.js';
import { emit as emitSse } from './sse.js';

export const CALL_STATE_STAGES = Object.freeze([
  'opener',
  'permission_check',
  'discovery',
  'value_pitch',
  'objection',
  'pricing',
  'close',
  'email_capture',
  'readback_confirm',
  'callback',
  'opt_out',
  'handoff',
  'voicemail',
  'no_answer'
]);

const STAGE_SET = new Set(CALL_STATE_STAGES);

const BUSY_RE = /\b(busy|middle of|with a client|with someone|on a job|driving|can't talk|cannot talk|not now|bad time|in the weeds|make it quick|real quick|whoa|hold on|wait)\b/i;
const SKEPTICAL_RE = /\b(who is this|what is this|why are you calling|scam|legit|real person|trust|sell(?:ing)? me|cold call|spam)\b/i;
const PRICE_RE = /\b(how much|what'?s it cost|price|cost|charge|expensive|budget|afford|five hundred|\$ ?\d+|\b500\b)\b/i;
const AI_RE = /\b(ai|artificial intelligence|robot|bot|automated|recorded voice|real person|human)\b/i;
const SOURCE_RE = /\b(where did you get (?:my|this) number|how did you get (?:my|this) number|why do you have (?:my|this) number|who gave you (?:my|this) number)\b/i;
const SEND_INFO_RE = /\b(send|email|text).{0,40}\b(info|information|details|something|deck|proposal|quote)\b/i;
const CALL_LATER_RE = /\b(call (?:me )?(?:back|later)|try (?:me )?(?:later|again)|another time|tomorrow|next week|after lunch|later today|not now|this afternoon|this morning|tonight|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i;
const OPT_OUT_RE = /\b(stop calling|stop contacting|remove me|take me off|do not call|don't call|unsubscribe|no more calls|opt out|take my number off)\b/i;
const UNSUPPORTED_RE = /\b(guarantee (?:first page|rankings|revenue)|first page google|seo guarantee|legal contract|sign (?:an )?nda|w-?9|sales tax|tax advice|wire money|bank account|refund threat|medical advice|lawsuit|attorney|political donation|crypto wallet)\b/i;
const POSITIVE_RE = /\b(send (?:me )?(?:the )?(?:invoice|bill|payment link)|let'?s do it|sounds good|okay do it|go ahead|i'?m interested|that works|yes send)\b/i;
const NO_ANSWER_RE = /\b(no answer|not answered|did not answer|unanswered|not connected|failed:no[-_ ]?answer|no[-_ ]?answer)\b/i;
const VOICEMAIL_RE = /\b(voicemail|voice mail|answering machine|machine detected|left a message|beep)\b/i;

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
};

export function createConversationState({
  lead = null,
  profile = null,
  pitch = null,
  verticalPack = null,
  hotContext = null,
  disclosureText = null,
  now = Date.now()
} = {}) {
  return {
    version: 'call_state.v1',
    stage: null,
    turnCount: 0,
    transcript: [],
    startedAt: now,
    lastUpdatedAt: now,
    lastEmail: null,
    readbackEmail: null,
    callbackAtMs: null,
    callbackNeedsClarification: false,
    context: compactContext({ lead, profile, pitch, verticalPack, hotContext, disclosureText })
  };
}

export function createInitialCallState({
  lead = null,
  profile = null,
  pitch = null,
  verticalPack = null,
  hotContext = null,
  disclosureText = null,
  callId = null,
  runId = null,
  now = Date.now()
} = {}) {
  const state = createConversationState({
    lead,
    profile,
    pitch,
    verticalPack,
    hotContext,
    disclosureText,
    now
  });
  const stage = 'opener';
  const event = {
    schemaVersion: 'call_state.v1',
    stage,
    previousStage: null,
    state: stage,
    transitionReason: 'call initialized with disclosure-first opener',
    turnIndex: -1,
    turnRole: 'agent',
    turnText: excerpt(pitch?.beginMessage || pitch?.openingLine || ''),
    signals: emptySignals(),
    detectors: [],
    nextLine: pitch?.beginMessage || pitch?.openingLine || 'Open with the recording disclosure, then ask one quick website question.',
    objection: null,
    mossSnippet: pickMossSnippet({ hotContext, signals: emptySignals(), stage }),
    complianceState: {
      recordingDisclosed: /\b(record(?:ed|ing)|automated)\b/i.test(disclosureText || pitch?.beginMessage || ''),
      optOutRequired: false,
      aiDisclosureNeeded: false,
      sourceDisclosureNeeded: false,
      emailReadbackRequired: true,
      state: /\b(record(?:ed|ing)|automated)\b/i.test(disclosureText || pitch?.beginMessage || '') ? 'compliant' : 'missing_recording_disclosure',
      snippetId: null,
      copy: null
    },
    safety: { safe: true, code: 'callable', reason: 'Initial call state; live callability is gated before dialing.' },
    callback: emptyCallback(),
    email: emptyEmail(),
    handoff: { required: false, reason: null, excerpt: null },
    contextUsed: {
      leadName: lead?.business_name || profile?.businessName || null,
      verticalPack: verticalPack?.key || null,
      verticalPackName: verticalPack?.name || null,
      priorTurnCount: 0,
      mossSnippetId: null,
      complianceSnippetId: null,
      profileSignal: firstString(profile?.onlinePresenceSummary, profile?.whatTheyDo)
    }
  };
  return decorateCallState(state, {
    callId,
    runId,
    currentState: stage,
    latestEvent: event,
    callback: event.callback,
    email: event.email,
    nextLine: event.nextLine,
    safety: event.safety
  });
}

export function advanceCallState(callState, turn, options = {}) {
  const { state, event } = advanceConversationState(callState, {
    turn,
    transcript: [...(callState?.transcript || []), normalizeTurn(turn, (callState?.transcript || []).length)],
    retrieved: options.retrievals || options.retrieved || [],
    now: options.now || Date.now()
  });
  return decorateCallState(state, {
    callId: options.callId || callState?.callId || null,
    runId: options.runId || callState?.runId || null,
    currentState: event.stage,
    latestEvent: event,
    callback: event.callback,
    email: event.email,
    nextLine: event.nextLine,
    safety: event.safety,
    mossSnippet: event.mossSnippet,
    objection: event.objection
  });
}

export function terminalCallState(callState, outcome, options = {}) {
  if (!/\b(opt[-_ ]?out|stop|no[-_ ]?answer|no answer|voicemail|voice mail|failed:no[-_ ]?answer|failed:voicemail)\b/i.test(outcome || '')) {
    return decorateCallState(callState || createConversationState(options), {
      callId: callState?.callId || options.callId || null,
      runId: callState?.runId || options.runId || null,
      terminalOutcome: outcome || null
    });
  }
  const { state, event } = advanceConversationState(callState, {
    turn: { role: 'system', text: outcome || 'call ended', ts: Date.now() },
    transcript: callState?.transcript || [],
    callOutcome: outcome,
    now: Date.now()
  });
  return decorateCallState(state, {
    callId: callState?.callId || options.callId || null,
    runId: callState?.runId || options.runId || null,
    currentState: event.stage,
    latestEvent: event,
    callback: event.callback,
    email: event.email,
    nextLine: event.nextLine,
    safety: event.safety,
    mossSnippet: event.mossSnippet,
    objection: event.objection
  });
}

export function emitCallState(callState, { leadId, callId, runId, mock = false, turn = null } = {}) {
  const event = callState?.latestEvent;
  if (!event) return null;
  return emitSse('caller.state', {
    worker: 'caller',
    leadId,
    callId: callId || callState.callId || null,
    runId: runId || callState.runId || null,
    mock,
    currentState: event.stage,
    stage: event.stage,
    nextLine: event.nextLine,
    objection: event.objection,
    mossSnippet: event.mossSnippet,
    complianceState: event.complianceState,
    safety: event.safety,
    callback: event.callback,
    email: event.email,
    handoff: event.handoff,
    detectors: event.detectors,
    transitionReason: event.transitionReason,
    contextUsed: event.contextUsed,
    turn: turn ? { role: turn.role, text: excerpt(turn.text), ts: turn.ts || null } : null,
    event
  });
}

export function persistCallbackPromise({ leadId, callId, state, turn } = {}) {
  const callback = state?.callback || state?.latestEvent?.callback;
  if (!leadId || !callback?.scheduledAtMs) return null;
  const id = `sched_callstate_${safeId(leadId)}_${safeId(callId || 'call')}_${callback.scheduledAtMs}`;
  try {
    const row = scheduledCalls.start({
      id,
      lead_id: leadId,
      thread_id: null,
      inbound_message_id: callId || null,
      scheduled_at_ms: callback.scheduledAtMs,
      brief: {
        source: 'call_state',
        callId: callId || null,
        ask: callback.sourceExcerpt || turn?.text || null,
        spokenTime: callback.spokenTime || null
      }
    });
    emitSse('scheduledCall.created', {
      worker: 'caller',
      leadId,
      id: row.id,
      callId: callId || null,
      scheduledAtMs: row.scheduled_at_ms,
      source: 'call_state',
      ask: callback.sourceExcerpt || null
    });
    return row;
  } catch (err) {
    if (!/UNIQUE constraint failed/i.test(err?.message || String(err))) {
      log.warn('call_state.callback_persist_failed', { leadId, callId, error: err?.message || String(err) });
      emitSse('caller.callback_persist_failed', {
        worker: 'caller',
        leadId,
        callId: callId || null,
        scheduledAtMs: callback.scheduledAtMs,
        error: err?.message || String(err)
      });
    }
    return null;
  }
}

export function advanceConversationState(state, {
  turn = null,
  transcript = null,
  retrieved = [],
  callOutcome = null,
  now = Date.now()
} = {}) {
  const prior = state || createConversationState({ now });
  const turns = normalizeTranscriptTurns(transcript || prior.transcript);
  const normalizedTurn = normalizeTurn(turn, turns.length ? turns.length - 1 : 0);
  const effectiveTurns = turns.length
    ? turns
    : normalizedTurn.text
      ? [...prior.transcript, normalizedTurn]
      : [...prior.transcript];
  const signals = detectConversationSignals({
    turn: normalizedTurn,
    transcript: effectiveTurns,
    callOutcome,
    now
  });
  const stage = chooseStage({ turn: normalizedTurn, transcript: effectiveTurns, signals, callOutcome });
  const mossSnippet = pickMossSnippet({
    retrieved,
    hotContext: prior.context.hotContext,
    signals,
    stage
  });
  const complianceState = buildComplianceState({
    transcript: effectiveTurns,
    signals,
    disclosureText: prior.context.disclosureText,
    mossSnippet
  });
  const safety = leadSafety({
    lead: prior.context.lead,
    signals,
    stage,
    complianceState
  });
  const nextLine = buildNextLine({
    stage,
    signals,
    state: prior,
    transcript: effectiveTurns,
    mossSnippet,
    complianceState,
    safety
  });
  const nextState = {
    ...prior,
    stage,
    turnCount: effectiveTurns.length,
    transcript: effectiveTurns,
    lastUpdatedAt: now,
    lastEmail: signals.email.candidate || prior.lastEmail,
    readbackEmail: signals.email.readbackEmail || prior.readbackEmail,
    callbackAtMs: signals.callback.scheduledAtMs || prior.callbackAtMs,
    callbackNeedsClarification: signals.callback.requested ? !signals.callback.exact : prior.callbackNeedsClarification
  };
  const event = {
    schemaVersion: 'call_state.v1',
    stage,
    previousStage: prior.stage,
    state: stage,
    transitionReason: transitionReason({ stage, signals, turn: normalizedTurn, callOutcome }),
    turnIndex: Math.max(0, effectiveTurns.length - 1),
    turnRole: normalizedTurn.role || null,
    turnText: excerpt(normalizedTurn.text),
    signals,
    detectors: signals.detected.map((type) => ({ type, excerpt: excerpt(normalizedTurn.text) })),
    nextLine,
    objection: signals.objection || null,
    mossSnippet,
    complianceState,
    safety,
    callback: signals.callback,
    email: signals.email,
    handoff: signals.handoff,
    contextUsed: {
      leadName: prior.context.lead?.business_name || prior.context.profile?.businessName || null,
      verticalPack: prior.context.verticalPack?.key || null,
      verticalPackName: prior.context.verticalPack?.name || null,
      priorTurnCount: Math.max(0, effectiveTurns.length - 1),
      mossSnippetId: mossSnippet?.id || null,
      complianceSnippetId: complianceState.snippetId || null,
      profileSignal: firstString(prior.context.profile?.onlinePresenceSummary, prior.context.profile?.whatTheyDo)
    }
  };
  return { state: nextState, event };
}

export function detectConversationSignals({ turn, transcript = [], callOutcome = null, now = Date.now() } = {}) {
  const text = cleanText(turn?.text);
  const allText = [
    callOutcome || '',
    ...normalizeTranscriptTurns(transcript).map((t) => t.text)
  ].join('\n');
  const callback = parseCallbackRequest(text, { now });
  const email = detectEmailFlow({ turn, transcript });
  const detected = [];
  const customerTurn = turn?.role !== 'agent';
  const add = (key, yes) => {
    if (yes) detected.push(key);
    return Boolean(yes);
  };
  const interruptedBusy = add('interrupted_busy', customerTurn && BUSY_RE.test(text));
  const skeptical = add('skeptical', customerTurn && SKEPTICAL_RE.test(text));
  const pricing = add('pricing', customerTurn && PRICE_RE.test(text));
  const aiDisclosure = add('ai_disclosure_question', customerTurn && AI_RE.test(text) && /\?|\b(is this|are you|you are|you're)\b/i.test(text));
  const sourceQuestion = add('number_source_question', customerTurn && SOURCE_RE.test(text));
  const sendInfo = add('send_info', customerTurn && SEND_INFO_RE.test(text));
  const callLater = add('call_later', customerTurn && callback.requested);
  const optOut = add('opt_out', (customerTurn && OPT_OUT_RE.test(text)) || OPT_OUT_RE.test(callOutcome || ''));
  const unsupported = add('unsupported_request', customerTurn && UNSUPPORTED_RE.test(text));
  const positiveIntent = add('positive_intent', customerTurn && POSITIVE_RE.test(text));
  const voicemail = add('voicemail', VOICEMAIL_RE.test(allText));
  const noAnswer = add('no_answer', NO_ANSWER_RE.test(allText));
  if (email.correctionRequested) detected.push('email_correction');
  if (email.candidate) detected.push('email_candidate');
  if (email.confirmed) detected.push('email_readback_confirmed');

  const objection = classifyObjection({
    interruptedBusy,
    skeptical,
    pricing,
    aiDisclosure,
    sourceQuestion,
    sendInfo,
    unsupported,
    text
  });

  return {
    interruptedBusy,
    skeptical,
    pricing,
    aiDisclosure,
    sourceQuestion,
    sendInfo,
    callLater,
    optOut,
    unsupported,
    positiveIntent,
    voicemail,
    noAnswer,
    objection,
    callback,
    email,
    handoff: unsupported
      ? {
          required: true,
          reason: 'unsupported_request',
          excerpt: excerpt(text)
        }
      : { required: false, reason: null, excerpt: null },
    detected: [...new Set(detected)]
  };
}

export function parseCallbackRequest(text, { now = Date.now() } = {}) {
  const raw = cleanText(text);
  if (!raw || !CALL_LATER_RE.test(raw)) {
    return { requested: false, exact: false, scheduledAtMs: null, spokenTime: null, needsClarification: false, confidence: 0, sourceExcerpt: null };
  }
  const lower = raw.toLowerCase();
  const base = new Date(now);

  const relative = lower.match(/\bin\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].startsWith('hour') || relative[2].startsWith('hr') ? 60 * 60 * 1000 : 60 * 1000;
    const scheduled = new Date(base.getTime() + amount * unit);
    return callbackResult(raw, scheduled, true, 0.92);
  }

  const time = parseSpokenTime(lower);
  const date = parseSpokenDate(lower, base);

  if (time && date) {
    const scheduled = new Date(date.getTime());
    scheduled.setHours(time.hour, time.minute, 0, 0);
    if (scheduled.getTime() <= base.getTime() && !/\btoday\b/i.test(lower)) {
      scheduled.setDate(scheduled.getDate() + 7);
    }
    return callbackResult(raw, scheduled, true, 0.88);
  }

  if (time && !date) {
    const scheduled = new Date(base.getTime());
    scheduled.setHours(time.hour, time.minute, 0, 0);
    if (scheduled.getTime() <= base.getTime()) scheduled.setDate(scheduled.getDate() + 1);
    return callbackResult(raw, scheduled, true, 0.76);
  }

  return {
    requested: true,
    exact: false,
    scheduledAtMs: null,
    spokenTime: null,
    needsClarification: true,
    confidence: 0.32,
    sourceExcerpt: excerpt(raw),
    clarificationQuestion: 'What specific day and time works best for the callback?'
  };
}

export function normalizeTranscriptTurns(transcript) {
  if (!transcript) return [];
  const source = Array.isArray(transcript)
    ? transcript
    : Array.isArray(transcript?.turns)
      ? transcript.turns
      : Array.isArray(transcript?.messages)
        ? transcript.messages
        : [];
  return source.map((turn, i) => normalizeTurn(turn, i)).filter((turn) => turn.text);
}

function chooseStage({ turn, transcript, signals, callOutcome }) {
  if (signals.noAnswer || NO_ANSWER_RE.test(callOutcome || '')) return 'no_answer';
  if (signals.voicemail || VOICEMAIL_RE.test(callOutcome || '')) return 'voicemail';
  if (signals.optOut) return 'opt_out';
  if (signals.unsupported) return 'handoff';
  if (signals.callback.requested) return 'callback';
  if (signals.email.confirmed) return 'readback_confirm';
  if (signals.email.correctionRequested || signals.email.candidate || signals.email.agentAsked || signals.email.agentReadback) return 'email_capture';
  if (signals.interruptedBusy && !signals.skeptical && !signals.aiDisclosure && !signals.sourceQuestion && !signals.sendInfo && !signals.pricing) return 'permission_check';
  if (signals.pricing) return 'pricing';
  if (signals.skeptical || signals.aiDisclosure || signals.sourceQuestion || signals.sendInfo || signals.objection) return 'objection';
  if (signals.positiveIntent) return 'close';

  const role = turn?.role;
  const text = turn?.text || '';
  if (role === 'agent' && transcript.length <= 1) return 'opener';
  if (role === 'agent' && /\b(one|quick|couple).{0,20}questions?\b|\?/.test(text)) return 'discovery';
  if (role === 'agent' && /\b(flat|website|page|hosted|same-day|same day|customers?|service area|tap-to-call|booking)\b/i.test(text)) return 'value_pitch';
  if (role === 'agent' && /\b(invoice|send it|payment link|go ahead|start)\b/i.test(text)) return 'close';
  if (role === 'user' && /\b(google|yelp|instagram|referrals?|customers?|people ask|menu|hours|service area|booking)\b/i.test(text)) return 'discovery';
  return STAGE_SET.has(turn?.stage) ? turn.stage : 'discovery';
}

function buildNextLine({ stage, signals, state, mossSnippet }) {
  const ctx = state.context || {};
  const pitch = ctx.pitch || {};
  const pack = ctx.verticalPack || {};
  const businessName = ctx.lead?.business_name || ctx.profile?.businessName || 'your business';
  const price = priceLabel(pack.priceCents || 50000);
  const valueHook = firstString(pack.valuePropHook, pitch.valueProp, mossSnippet?.text);
  const proof = compactProof(firstString(
    ctx.profile?.onlinePresenceSummary,
    ctx.profile?.whatTheyDo,
    mossSnippet?.text
  ));

  if (stage === 'opt_out') return 'Understood. I will remove you from our call list and I will not keep pitching. Have a good day.';
  if (stage === 'handoff') return 'That is outside what I can handle safely on this automated call. I am going to flag it for a person and stop the sales pitch here.';
  if (stage === 'voicemail') return `Hi, this is Callan from callmemaybe. I was calling about a simple website for ${businessName}. You can ignore this if it is not useful.`;
  if (stage === 'no_answer') return 'No answer. Mark the attempt unreachable and retry only if the outreach policy still allows it.';
  if (stage === 'callback') {
    if (signals.callback.exact) return `Absolutely. I will call you back at ${signals.callback.spokenTime}.`;
    return signals.callback.clarificationQuestion || 'Sure. What specific day and time works best for the callback?';
  }
  if (signals.aiDisclosure) return pack.objectionMap?.ai_disclosure || 'Yes, I am Callan, an AI voice operator for callmemaybe. This call is automated and recorded, and if you say stop I will remove you.';
  if (signals.sourceQuestion) return pack.objectionMap?.number_source || `I am calling from public business listing research for ${businessName}. If you do not want outreach, say stop and I will remove the number.`;
  if (signals.interruptedBusy) return `Totally fair. I can be brief: I noticed ${businessName}${proof ? ` ${proof}` : ''}. Is it worth one quick website question, or should I call at a specific time?`;
  if (signals.sendInfo) return pack.objectionMap?.send_info || 'I can send details through AgentMail. Before I do, the real question is whether a flat same-day website is even worth considering.';
  if (signals.skeptical) return pack.objectionMap?.skeptical || `Fair question. I am Callan from callmemaybe. I am calling because ${proof || 'your public listing looked like it could use a clearer owned website'}; nothing starts unless you choose to pay an invoice.`;
  if (stage === 'pricing') return pack.objectionMap?.pricing || `It is a flat ${price} for the focused same-day page, hosted, with the main services, proof, and contact step. Nothing starts unless you decide to pay the invoice.`;
  if (stage === 'email_capture') {
    if (signals.email.correctionRequested && signals.email.candidate) return `Got it, thanks for correcting me. I have ${signals.email.candidate}. Is that right?`;
    if (signals.email.candidate) return `I have ${signals.email.candidate}. Is that right?`;
    return pitch.emailAsk || 'What is the best email for the invoice?';
  }
  if (stage === 'readback_confirm') return pitch.invoiceClose || 'Perfect. AgentMail will send the invoice, and you can reply to that email with questions or corrections.';
  if (stage === 'close') return pitch.close || `If that sounds useful, I can send the ${price} invoice and start from the public business details I already found.`;
  if (stage === 'value_pitch') {
    return [valueHook || `A focused ${price} same-day website can make the next customer step obvious.`, firstArrayItem(pack.reviewValueProps)]
      .filter(Boolean)
      .join(' ');
  }
  if (stage === 'opener') return pitch.openingLine || `I noticed ${businessName} and wanted to ask one quick website question.`;
  return firstArrayItem(pitch.discoveryQuestions) || 'What do customers usually need to know before they decide to call or visit?';
}

function detectEmailFlow({ turn, transcript = [] }) {
  const turns = normalizeTranscriptTurns(transcript);
  const normalized = normalizeTurn(turn, turns.length ? turns.length - 1 : 0);
  const text = normalized.text || '';
  const candidates = emailCandidatesFromText(text);
  const lastAgent = [...turns].reverse().find((t) => t.role === 'agent');
  const agentAsked = normalized.role === 'agent' && /\b(best|good).{0,20}email\b|\bemail.{0,20}invoice\b/i.test(text);
  const agentReadback = normalized.role === 'agent' && candidates.length > 0 && /\b(is that right|is that correct|did i get that right|confirm|right\?|correct\?)\b/i.test(text);
  const correctionRequested = normalized.role !== 'agent' && (
    /\b(no|nope|wrong|incorrect|not right|not correct|actually|correction)\b/i.test(text) ||
    (lastAgent && /\b(is that right|is that correct|did i get that right|confirm|right\?|correct\?)\b/i.test(lastAgent.text || '') && candidates.length > 0)
  );
  const confirmed = normalized.role !== 'agent' &&
    /\b(yes|yeah|yep|correct|right|that's right|that is right|confirmed|exactly|you got it|sounds good)\b/i.test(text) &&
    Boolean(lastAgent && /\b(is that right|is that correct|did i get that right|confirm|right\?|correct\?)\b/i.test(lastAgent.text || ''));
  return {
    candidate: candidates[0] || null,
    candidates,
    agentAsked,
    agentReadback,
    readbackEmail: agentReadback ? candidates[0] || null : null,
    correctionRequested,
    confirmed,
    confidence: confirmed ? 0.98 : candidates.length ? 0.64 : 0,
    sourceExcerpt: candidates.length || confirmed || correctionRequested ? excerpt(text || lastAgent?.text) : null
  };
}

export function emailCandidatesFromText(text) {
  const raw = String(text || '');
  const out = [];
  for (const match of raw.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    const email = sanitizeEmail(match[0]);
    if (email) out.push(email);
  }
  out.push(...spokenEmailCandidates(raw));
  return unique(out).slice(0, 10);
}

function spokenEmailCandidates(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/\b(at sign|at symbol)\b/g, ' at ')
    .replace(/\b(dot|period|point)\b/g, ' dot ')
    .replace(/[^a-z0-9@._%+\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const candidates = [];
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== 'at' && words[i] !== '@') continue;
    const local = collectEmailSide(words, i - 1, -1).reverse();
    const domain = collectEmailSide(words, i + 1, 1);
    const email = sanitizeEmail(`${joinEmailTokens(local)}@${joinEmailTokens(domain)}`);
    if (email) candidates.push(email);
  }
  return candidates;
}

function collectEmailSide(words, start, step) {
  const parts = [];
  for (let i = start; i >= 0 && i < words.length && parts.length < 8; i += step) {
    const token = words[i];
    if (EMAIL_STOP_WORDS.has(token)) break;
    if (token === 'dot' || token === '.') {
      parts.push('.');
      continue;
    }
    if (token === 'dash' || token === 'hyphen' || token === '-') {
      parts.push('-');
      continue;
    }
    if (!/^[a-z0-9._%+-]+$/.test(token)) break;
    parts.push(token);
  }
  return parts;
}

function classifyObjection({ interruptedBusy, skeptical, pricing, aiDisclosure, sourceQuestion, sendInfo, unsupported, text }) {
  if (unsupported) return { type: 'unsupported_request', excerpt: excerpt(text) };
  if (pricing) return { type: 'pricing', excerpt: excerpt(text) };
  if (aiDisclosure) return { type: 'ai_disclosure', excerpt: excerpt(text) };
  if (sourceQuestion) return { type: 'number_source', excerpt: excerpt(text) };
  if (sendInfo) return { type: 'send_info', excerpt: excerpt(text) };
  if (skeptical) return { type: 'skeptical', excerpt: excerpt(text) };
  if (interruptedBusy) return { type: 'busy', excerpt: excerpt(text) };
  if (/\b(already have|have a website|do not need|don't need|not interested|no thanks)\b/i.test(text || '')) {
    return { type: 'need', excerpt: excerpt(text) };
  }
  return null;
}

function buildComplianceState({ transcript, signals, disclosureText, mossSnippet }) {
  const firstAgent = normalizeTranscriptTurns(transcript).find((t) => t.role === 'agent');
  const disclosureSource = cleanText(disclosureText || firstAgent?.text);
  const recordingDisclosed = /\b(record(?:ed|ing)|automated)\b/i.test(disclosureSource);
  return {
    recordingDisclosed,
    optOutRequired: signals.optOut,
    aiDisclosureNeeded: signals.aiDisclosure,
    sourceDisclosureNeeded: signals.sourceQuestion,
    emailReadbackRequired: true,
    state: signals.optOut
      ? 'stop_required'
      : signals.unsupported
        ? 'handoff_required'
        : recordingDisclosed
          ? 'compliant'
          : 'missing_recording_disclosure',
    snippetId: mossSnippet?.kind === 'compliance' ? mossSnippet.id : null,
    copy: mossSnippet?.kind === 'compliance' ? mossSnippet.text : null
  };
}

function leadSafety({ lead, signals, stage, complianceState }) {
  if (signals.optOut) return { safe: false, code: 'opt_out', reason: 'Lead asked to stop outreach.' };
  if (signals.unsupported || stage === 'handoff') return { safe: false, code: 'operator_handoff', reason: 'Unsupported or risky request needs a human.' };
  if (stage === 'no_answer' || stage === 'voicemail') return { safe: false, code: stage, reason: 'No live owner conversation is active.' };
  if (lead?.risk_status && !/^(callable|unknown|low|safe)$/i.test(lead.risk_status)) {
    return { safe: false, code: lead.risk_status, reason: `Lead risk status is ${lead.risk_status}.` };
  }
  if (!complianceState.recordingDisclosed) {
    return { safe: false, code: 'missing_recording_disclosure', reason: 'Recording or automation disclosure has not been proven.' };
  }
  return { safe: true, code: 'callable', reason: 'Disclosure is present and no opt-out or handoff trigger is active.' };
}

function pickMossSnippet({ retrieved = [], hotContext = null, signals, stage }) {
  const docs = [
    ...retrieved.flatMap((item) => item?.snippets || []),
    ...(hotContext?.snippets || [])
  ].map((doc) => ({
    id: doc.id || doc.snippet_id,
    kind: doc.metadata?.kind || doc.kind || 'snippet',
    title: doc.metadata?.title || doc.title || doc.id || doc.snippet_id,
    text: cleanText(doc.text).slice(0, 360)
  })).filter((doc) => doc.id && doc.text);
  if (!docs.length) return null;
  const wantedKind = stage === 'pricing'
    ? 'invoice_pricing'
    : stage === 'handoff' || stage === 'opt_out' || signals.aiDisclosure || signals.sourceQuestion
      ? 'compliance'
      : stage === 'objection'
        ? 'objection'
        : stage === 'email_capture'
          ? 'invoice_pricing'
          : null;
  return docs.find((doc) => doc.kind === wantedKind) || docs[0];
}

function transitionReason({ stage, signals, turn, callOutcome }) {
  if (stage === 'no_answer' || stage === 'voicemail') return `${stage} detected from call outcome or transcript`;
  if (signals.detected.length) return signals.detected.join(', ');
  if (turn?.role === 'agent' && stage === 'opener') return 'first agent opener';
  if (callOutcome) return `call outcome ${callOutcome}`;
  return 'transcript progression';
}

function compactContext({ lead, profile, pitch, verticalPack, hotContext, disclosureText }) {
  return {
    lead: lead ? {
      id: lead.id,
      business_name: lead.business_name,
      niche: lead.niche,
      city: lead.city,
      risk_status: lead.risk_status,
      outreach_status: lead.outreach_status,
      phone_classification: lead.phone_classification
    } : null,
    profile: profile ? {
      businessName: profile.businessName,
      whatTheyDo: profile.whatTheyDo,
      onlinePresenceSummary: profile.onlinePresenceSummary,
      onlinePresenceStrength: profile.onlinePresenceStrength,
      needs: profile.needs,
      signals: profile.signals
    } : null,
    pitch: pitch ? {
      openingLine: pitch.openingLine,
      valueProp: pitch.valueProp,
      discoveryQuestions: pitch.discoveryQuestions,
      close: pitch.close,
      emailAsk: pitch.emailAsk,
      emailReadbackInstruction: pitch.emailReadbackInstruction,
      invoiceClose: pitch.invoiceClose
    } : null,
    verticalPack: verticalPack ? {
      key: verticalPack.key,
      name: verticalPack.name,
      priceCents: verticalPack.priceCents,
      valuePropHook: verticalPack.valuePropHook,
      objectionMap: verticalPack.objectionMap || {},
      reviewValueProps: verticalPack.reviewValueProps || []
    } : null,
    hotContext: hotContext ? {
      snippets: (hotContext.snippets || []).slice(0, 16)
    } : null,
    disclosureText: disclosureText || null
  };
}

function decorateCallState(state, additions = {}) {
  return {
    ...state,
    ...additions,
    currentState: additions.currentState || state.stage || null
  };
}

function emptySignals() {
  return {
    interruptedBusy: false,
    skeptical: false,
    pricing: false,
    aiDisclosure: false,
    sourceQuestion: false,
    sendInfo: false,
    callLater: false,
    optOut: false,
    unsupported: false,
    positiveIntent: false,
    voicemail: false,
    noAnswer: false,
    objection: null,
    callback: emptyCallback(),
    email: emptyEmail(),
    handoff: { required: false, reason: null, excerpt: null },
    detected: []
  };
}

function emptyCallback() {
  return {
    requested: false,
    exact: false,
    scheduledAtMs: null,
    spokenTime: null,
    needsClarification: false,
    confidence: 0,
    sourceExcerpt: null
  };
}

function emptyEmail() {
  return {
    candidate: null,
    candidates: [],
    agentAsked: false,
    agentReadback: false,
    readbackEmail: null,
    correctionRequested: false,
    confirmed: false,
    confidence: 0,
    sourceExcerpt: null
  };
}

function parseSpokenTime(text) {
  const clock = text.match(/\b(?:at|around|about)?\s*([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?\b/i);
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2]);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  const simple = text.match(/\b(?:at|around|about)?\s*(1[0-2]|0?[1-9])\s*(am|pm)\b/i);
  if (simple) {
    let hour = Number(simple[1]);
    const meridiem = simple[2].toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour, minute: 0 };
  }
  return null;
}

function parseSpokenDate(text, base) {
  const date = new Date(base.getTime());
  if (/\btoday\b/i.test(text)) return startOfDay(date);
  if (/\btomorrow\b/i.test(text)) {
    const out = startOfDay(date);
    out.setDate(out.getDate() + 1);
    return out;
  }
  for (const [name, day] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b(?:next\\s+)?${name}\\b`, 'i').test(text)) {
      const out = startOfDay(date);
      let diff = (day - out.getDay() + 7) % 7;
      if (diff === 0 || new RegExp(`\\bnext\\s+${name}\\b`, 'i').test(text)) diff += 7;
      out.setDate(out.getDate() + diff);
      return out;
    }
  }
  const monthMatch = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i);
  if (monthMatch) {
    const month = MONTHS[monthMatch[1].toLowerCase()];
    const day = Number(monthMatch[2]);
    const out = new Date(base.getFullYear(), month, day);
    if (out.getTime() < startOfDay(base).getTime()) out.setFullYear(out.getFullYear() + 1);
    return out;
  }
  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const month = Number(numeric[1]) - 1;
    const day = Number(numeric[2]);
    const year = numeric[3] ? normalizeYear(Number(numeric[3])) : base.getFullYear();
    const out = new Date(year, month, day);
    if (!numeric[3] && out.getTime() < startOfDay(base).getTime()) out.setFullYear(out.getFullYear() + 1);
    return out;
  }
  return null;
}

function callbackResult(raw, scheduled, exact, confidence) {
  return {
    requested: true,
    exact,
    scheduledAtMs: exact ? scheduled.getTime() : null,
    spokenTime: exact ? formatCallbackTime(scheduled) : null,
    needsClarification: !exact,
    confidence,
    sourceExcerpt: excerpt(raw),
    clarificationQuestion: exact ? null : 'What specific day and time works best for the callback?'
  };
}

function formatCallbackTime(date) {
  return date.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function startOfDay(date) {
  const out = new Date(date.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

function normalizeYear(year) {
  return year < 100 ? 2000 + year : year;
}

function normalizeTurn(turn, index = 0) {
  if (!turn) return { role: 'unknown', text: '', ts: index };
  if (typeof turn === 'string') return { role: 'unknown', text: cleanText(turn), ts: index };
  const rawRole = String(turn.role || turn.speaker || turn.type || '').toLowerCase();
  const role = /agent|assistant|caller|sales|bot|ai/.test(rawRole)
    ? 'agent'
    : /user|owner|customer|client|callee|human|lead/.test(rawRole)
      ? 'user'
      : 'unknown';
  return {
    role,
    text: cleanText(turn.text || turn.transcript || turn.content || turn.message || turn.utterance),
    ts: turn.ts || turn.timestamp || index,
    stage: turn.stage || null
  };
}

function sanitizeEmail(email) {
  const cleaned = cleanText(email).replace(/^mailto:/i, '').replace(/^[<>"'(),;]+|[<>"'(),;:.!?]+$/g, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned.toLowerCase() : null;
}

function joinEmailTokens(tokens) {
  return tokens.join('').replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
}

const EMAIL_STOP_WORDS = new Set([
  'email', 'mail', 'address', 'invoice', 'send', 'sent', 'is', 'it', 'its', 's', 'to', 'for', 'me',
  'my', 'the', 'a', 'an', 'best', 'would', 'be', 'please', 'thanks', 'thank', 'you', 'yes', 'yeah',
  'yep', 'right', 'correct', 'confirm', 'confirmed', 'use', 'using', 'with', 'on', 'at', 'no', 'nope',
  'wrong', 'incorrect', 'actually', 'correction', 'not', 'that', 'thatll', 'thatll'
]);

function priceLabel(cents) {
  return `$${Math.round(Number(cents || 50000) / 100).toLocaleString('en-US')}`;
}

function compactProof(value) {
  const text = cleanText(value);
  if (!text) return '';
  return text.length > 120 ? `${text.slice(0, 119)}...` : text;
}

function firstString(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return '';
}

function firstArrayItem(value) {
  return Array.isArray(value) ? cleanText(value[0]) : '';
}

function unique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = cleanText(item).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function excerpt(value, max = 220) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function cleanText(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function safeId(value) {
  return String(value || 'x').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 48) || 'x';
}
