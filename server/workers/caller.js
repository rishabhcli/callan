import { emit } from '../sse.js';
import { runs, leads, calls } from '../db.js';
import { env, modeAllowsSideEffect } from '../env.js';
import { log } from '../logger.js';
import { addDoc, getLatest, containerTagFor } from '../memory.js';
import { generateJson } from '../gemini.js';
import { ensureLeadHotIndex } from '../moss/hotIndex.js';
import {
  getComplianceSnippet,
  getCustomerNeedSnippet,
  getObjectionSnippet,
  getPreCallContext,
  getPricingSnippet
} from '../moss/retrieval.js';
import { detectMossRetrievalNeeds } from '../moss/detectors.js';
import {
  buildPitchResearchContext,
  createFallbackPitch,
  validateGeneratedPitch
} from '../pitch.js';
import { generateStructured } from '../reasoning/geminiReasoner.js';
import { CallScript } from '../reasoning/schemas.js';
import { callabilityForLead, dncCheck, recordingDisclosure, recordCallDecision, transcriptHasOptOut, recordOptOut } from '../compliance.js';
import { canDialPhone, recordCallAttempt as reputationRecordCallAttempt } from '../reputation.js';
import { applyAttemptOutcome } from '../cadence.js';
import {
  classifyAgentPhoneFailure,
  endAgentPhoneCall,
  ensureAgentPhoneAgent,
  fetchAgentPhoneFinalTranscript,
  normalizeAgentPhoneTranscript,
  placeAgentPhoneCall,
  streamAgentPhoneTranscript,
  verifyAgentPhoneVoice,
  waitForAgentPhoneFinalTranscript
} from '../providers/agentphone.js';
import { shouldTransfer, OPERATOR_TRANSFER_NUMBER } from '../operatorTransfer.js';
import { enqueueOperatorTransferJob } from '../operatorTransferQueue.js';
import { applyPackToPitch, pickPack } from '../verticalPacks/index.js';
import { applyPitchExperiment } from '../experimentArms.js';
import { recordOutcome as recordExperimentOutcome } from '../experiments.js';
import { recordAgentPhoneCallCost } from '../costs.js';
import { enqueueCallAnalysis } from '../analysisQueue.js';
import {
  advanceCallState,
  createInitialCallState,
  emitCallState,
  persistCallbackPromise,
  terminalCallState
} from '../callState.js';

const PITCH_SYSTEM = `You are a sales strategist for callmemaybe, a service that builds and hosts small-business websites for $500 flat. Generate a tight, conversational cold-call pitch tailored to ONE specific business. Anchor the pitch in the business's online-presence audit, what the business actually does, and the concrete things customers need to know. The owner is busy, suspicious of robocalls, and probably doing something else. Be respectful, specific, and human. Output only JSON that matches the supplied schema exactly.`;

const MOCK_TRANSCRIPT_SYSTEM = `You are simulating a realistic cold sales call transcript for demo purposes. Output a believable agent<->owner exchange. The agent represents callmemaybe (sells small-business websites for a flat fee). Start with the pitch beginMessage exactly, including the recording disclosure. Make the owner skeptical, ask whether this is AI, ask price, then get convinced. End with the agent asking for the best email, the owner giving or correcting it, the agent reading it back, the owner confirming, and the agent saying the invoice will arrive from AgentMail and they can reply there with questions. 12 to 16 total turns, alternating roles, starting with the agent.`;

const MOCK_TRANSCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      minItems: 10,
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['agent', 'user'] },
          text: { type: 'string' }
        },
        required: ['role', 'text']
      }
    }
  },
  required: ['turns']
};

const MOCK_TURN_DELAY_MS = Math.max(0, Number(process.env.CALLER_MOCK_TURN_DELAY_MS || 650));

function mask(phone) {
  if (!phone) return null;
  const s = String(phone);
  if (s.length < 5) return s;
  return `${s.slice(0, 3)}…${s.slice(-2)}`;
}

function pitchToSystemPrompt(pitch, lead, hotContext = null) {
  const objLines = (pitch.objections || []).map((o) => `- If they say: "${o.objection}" -> respond: ${o.response}`).join('\n');
  const discovery = (pitch.discoveryQuestions || []).map((q, i) => `${i + 1}. ${q}`).join('\n');
  return [
    `You are a sales agent for callmemaybe calling ${lead.business_name || 'a local business'} (${lead.niche || 'small business'}).`,
    `First spoken message / provider fallback: ${pitch.beginMessage}`,
    `After the disclosure-first greeting, use this opening line only if it fits naturally: ${pitch.openingLine}`,
    `Value proposition: ${pitch.valueProp}`,
    `Discovery questions to weave in naturally:\n${discovery}`,
    `Objection handling:\n${objLines}`,
    `Close: ${pitch.close}`,
    `If they give positive intent, ask for the best invoice email exactly like this: ${pitch.emailAsk}`,
    `Email readback rule: ${pitch.emailReadbackInstruction}`,
    `Do not say the invoice is coming until the owner confirms the read-back email. If the readback is wrong, ask them to repeat the address and read it back again.`,
    `State discipline: follow opener -> permission_check -> discovery -> value_pitch -> objection/pricing -> close -> email_capture -> readback_confirm. If they ask whether this is AI, disclose plainly and continue only if useful. If they ask where the number came from, say it came from public business listing/research evidence and offer opt-out.`,
    `Invoice handoff: ${pitch.invoiceClose || 'The invoice will come from AgentMail, and you can reply there with questions.'}`,
    `If they ask "where did you get my number?" or "why are you contacting me?", answer calmly: "We found ${lead.business_name || 'your business'} while reviewing public business listings/online-presence signals${lead.source_url ? `; the source attached here is ${lead.source_url}` : ''}. I can stop all future calls and emails right now if you want." Then offer opt-out.`,
    formatMossPrompt(hotContext),
    `Be warm, brief, and concrete. If the owner says any variant of "stop", "remove me", "do not call", or "take me off", acknowledge politely and end the call.`
  ].filter(Boolean).join('\n\n');
}

function mockEmailForProfile(profile) {
  const name = String(profile?.businessName || 'business')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 32) || 'business';
  return `owner@${name}.com`;
}

async function buildMossHotContext({ leadId, lead, profile, pitch, runId }) {
  try {
    const index = await ensureLeadHotIndex(leadId, { lead, profile, pitch, runId });
    const [preCall, compliance, pricing] = await Promise.all([
      getPreCallContext(leadId, { runId, source: 'caller_pre_call' }),
      getComplianceSnippet('recording disclosure and opt-out', { leadId, source: 'caller_pre_call' }),
      getPricingSnippet(leadId, { source: 'caller_pre_call' })
    ]);
    const hotContext = {
      indexName: index.indexName,
      preCall,
      compliance,
      pricing,
      snippets: [
        ...(preCall?.snippets || []),
        ...(compliance?.snippets || []),
        ...(pricing?.snippets || [])
      ]
    };
    emit('caller.hot_context', {
      worker: 'caller',
      leadId,
      runId,
      indexName: index.indexName,
      snippetIds: hotContext.snippets.map((snippet) => snippet.id),
      preCallLatencyMs: preCall?.latencyMs || null,
      noWebSearch: true
    });
    return hotContext;
  } catch (err) {
    log.warn('caller.moss.hot_context_failed', { leadId, error: err?.message || String(err) });
    emit('caller.hot_context_failed', {
      worker: 'caller',
      leadId,
      runId,
      error: err?.message || String(err),
      noWebSearch: true
    });
    return { error: err?.message || String(err), snippets: [] };
  }
}

async function loadProfile(leadId, lead) {
  try {
    const mem = await getLatest(containerTagFor(leadId), 'profile');
    if (mem) {
      const raw = mem.content || mem.summary || '';
      try {
        const parsed = JSON.parse(raw);
        return parsed;
      } catch {
        return { whatTheyDo: String(raw).slice(0, 800), businessName: lead.business_name };
      }
    }
  } catch (err) {
    log.warn('profile.load.failed', { leadId, error: err?.message });
  }
  return {
    businessName: lead.business_name,
    niche: lead.niche,
    city: lead.city,
    whatTheyDo: `${lead.business_name} is a ${lead.niche || 'small business'}${lead.city ? ` in ${lead.city}` : ''}.`
  };
}

async function generatePitch({ profile, lead, disclosure }) {
  const researchContext = buildPitchResearchContext({ profile, lead });
  const prompt = [
    `Lead and research context. Use only this data; do not invent owner names, services, locations, or website facts:\n${JSON.stringify(researchContext, null, 2)}`,
    '',
    `We sell: a flat $500 single-page website built in front of the customer while they watch. Hosted on lovable.app. Ready same day.`,
    `Research frame: callmemaybe first audits whether the business has a strong online presence. If it is weak/mixed, the call describes the gap, what the business does, what customers need to know, and why a clear owned page helps.`,
    `Tone: warm, specific, never pushy. Use at least one concrete signal from the research in the opening line and one online-presence gap in the value proposition.`,
    `Discovery questions: produce exactly 3 natural questions about customer needs, current acquisition channels, and what the owner most wants customers to notice.`,
    `Objection handling: include practical responses for at least price, already-has-website, send-info, busy, and not-interested if possible.`,
    `Email flow: if the owner agrees, the agent must ask for the best invoice email, read it back exactly, ask for confirmation, then say an AgentMail invoice is coming and replies to that email go back to the agent for questions.`,
    `Schema: return every required field and no extra fields. The emailReadbackInstruction field must explicitly require reading the email back and confirming it.`,
    `IMPORTANT — beginMessage MUST start with EXACTLY this recording disclosure (verbatim, no edits), then a single space, then a one-sentence personal greeting:`,
    `"${disclosure}"`
  ].join('\n');

  try {
    const { output: raw, trace } = await generateStructured({
      kind: 'callScript',
      schema: CallScript,
      evidence: {
        lead,
        profile,
        researchContext,
        disclosure
      },
      prompt,
      leadId: lead.id,
      worker: 'caller',
      eventId: `pitch:${lead.id}`,
      thinkingLevel: 'medium'
    });
    const pitch = validateGeneratedPitch(raw, { disclosure, profile, lead });
    pitch.reasoningTraceId = trace?.id || null;
    pitch.strategySummary = raw.strategySummary || null;
    pitch.confidence = raw.confidence ?? null;
    return pitch;
  } catch (err) {
    log.warn('pitch.generate.fallback', { leadId: lead?.id, error: err?.message || String(err) });
    return createFallbackPitch({ disclosure, profile, lead });
  }
}

async function synthesizeMockTranscript({ pitch, profile, hotContext }) {
  try {
    const invoiceEmail = mockEmailForProfile(profile);
    const prompt = [
      `Business: ${profile.businessName || 'a local business'} — ${profile.whatTheyDo || ''}`,
      `Use this invoice email in the final confirmation sequence: ${invoiceEmail}`,
      `Use this pitch as the agent's playbook:`,
      JSON.stringify(pitch, null, 2),
      `Use these Moss hot-context snippets when objections/questions appear:`,
      JSON.stringify(compactMossSnippets(hotContext), null, 2),
      `Generate the full transcript (10-12 turns). Owner agrees by the end. First agent turn should reflect the beginMessage (recording disclosure + greeting).`
    ].join('\n\n');
    const out = await generateJson({
      schema: MOCK_TRANSCRIPT_SCHEMA,
      prompt,
      systemInstruction: MOCK_TRANSCRIPT_SYSTEM,
      thinkingLevel: 'low',
      flash: true
    });
    if (Array.isArray(out?.turns) && out.turns.length >= 6) return out.turns;
  } catch (err) {
    log.warn('mock.transcript.gemini.failed', { error: err?.message });
  }
  const invoiceEmail = mockEmailForProfile(profile);
  return [
    { role: 'agent', text: pitch.beginMessage },
    { role: 'user', text: 'Wait, what is this and why are you calling me? Is this AI?' },
    { role: 'agent', text: `Fair question. I am Callan from callmemaybe, an AI voice operator. ${pitch.openingLine}` },
    { role: 'user', text: 'I am busy, so make it quick.' },
    { role: 'agent', text: pitch.valueProp },
    { role: 'user', text: 'How much?' },
    { role: 'agent', text: pitch.close },
    { role: 'user', text: 'Okay, send me the invoice.' },
    { role: 'agent', text: pitch.emailAsk || 'Perfect. What is the best email for the invoice?' },
    { role: 'user', text: `Use owner at ${String(profile.businessName || 'business').toLowerCase().replace(/[^a-z0-9]+/g, '')} dot com. Actually, sorry, use ${invoiceEmail}.` },
    { role: 'agent', text: `I have ${invoiceEmail}. Is that right?` },
    { role: 'user', text: 'Yes, that is right.' },
    { role: 'agent', text: pitch.invoiceClose || 'The invoice will come from AgentMail, and you can reply there with questions.' }
  ];
}

async function runMock({ leadId, lead, pitch, profile, runId, disclosureText, hotContext, verticalPack = null, experimentAssignment = null }) {
  const callId = `call_${Date.now().toString(36)}`;
  const turns = await synthesizeMockTranscript({ pitch, profile, hotContext });
  const armReason = experimentAssignment?.arm ? `arm=${experimentAssignment.arm}` : null;
  calls.start({
    id: callId,
    lead_id: leadId,
    to_phone: mask(lead.phone) || 'mock',
    provider_call_id: null,
    disclosure_text: disclosureText,
    decision_reason: armReason ? `mock call (${armReason})` : 'mock call'
  });
  emit('caller.placed', { worker: 'caller', leadId, runId, callId, providerCallId: null, mock: true });

  const transcript = [];
  let callState = createInitialCallState({
    lead,
    profile,
    pitch,
    verticalPack,
    hotContext,
    callId,
    runId,
    disclosureText
  });
  emitCallState(callState, { leadId, callId, runId, mock: true });
  for (const turn of turns) {
    await new Promise((r) => setTimeout(r, MOCK_TURN_DELAY_MS));
    const ts = Date.now();
    const chunk = { role: turn.role, text: turn.text, ts };
    transcript.push(chunk);
    emit('caller.transcript', { worker: 'caller', leadId, callId, role: chunk.role, text: chunk.text, ts, mock: true });
    const retrievals = chunk.role === 'user'
      ? await maybeRetrieveMossForTurn({ leadId, callId, turn: chunk, mock: true })
      : [];
    callState = advanceCallState(callState, chunk, {
      lead,
      profile,
      pitch,
      verticalPack,
      hotContext,
      retrievals,
      disclosureText,
      callId,
      runId,
      now: ts
    });
    emitCallState(callState, { leadId, callId, runId, mock: true, turn: chunk });
    if (callState.currentState === 'callback' && callState.callback?.scheduledAtMs) {
      persistCallbackPromise({ leadId, callId, state: callState, turn: chunk });
    }
  }

  calls.finish(callId, { outcome: 'demo-yes', transcript });
  try {
    // Mock calls don't hit AgentPhone, but we still book a synthetic 60s of call
    // time so the unit-economics ledger renders something for demos.
    recordAgentPhoneCallCost({ leadId, durationSeconds: 60, callId });
  } catch (err) {
    log.warn('caller.cost_record_mock_failed', { leadId, callId, error: err?.message || String(err) });
  }
  try {
    reputationRecordCallAttempt({ leadId, phone: lead.phone, outcome: 'demo-yes' });
  } catch (err) {
    log.warn('reputation.record_mock_attempt_failed', { leadId, callId, error: err?.message || String(err) });
  }
  await safeAddMemory(containerTagFor(leadId), 'call_log', { turns: transcript }, {
    provider_call_id: null,
    outcome: 'demo-yes',
    mock: true
  });
  if (experimentAssignment) {
    try {
      recordExperimentOutcome({ assignment: experimentAssignment, outcome: 'connected', valueCents: null });
    } catch (err) {
      log.warn('experiment.outcome.mock_failed', { leadId, callId, error: err?.message || String(err) });
    }
  }
  emit('caller.done', { worker: 'caller', leadId, runId, callId, outcome: 'demo-yes', mock: true });

  fireAnalyst(leadId, callId, 'caller.mock');
  return { callId };
}

function fireAnalyst(leadId, callId, source = 'caller') {
  try {
    const result = enqueueCallAnalysis({ leadId, callId, source });
    emit('analyst.queued', {
      worker: 'analyst',
      leadId,
      callId,
      source,
      jobId: result.row?.id || null,
      duplicate: !result.inserted
    });
    return result.row || null;
  } catch (err) {
    log.warn('analyst.queue.failed', { leadId, callId, source, error: err?.message || String(err) });
    return null;
  }
}

async function maybeRetrieveMossForTurn({ leadId, callId, turn, mock }) {
  const needs = detectMossRetrievalNeeds(turn).slice(0, 3);
  if (!needs.length) return [];
  const retrieved = [];
  for (const need of needs) {
    try {
      if (need.kind === 'pricing') {
        retrieved.push(await getPricingSnippet(leadId, { callId, query: need.query, source: 'transcript_stream' }));
      } else if (need.kind === 'customer_need') {
        retrieved.push(await getCustomerNeedSnippet(leadId, need.query, { callId, source: 'transcript_stream' }));
      } else if (need.kind === 'compliance') {
        retrieved.push(await getComplianceSnippet(need.reason || need.query, { leadId, callId, source: 'transcript_stream' }));
      } else {
        retrieved.push(await getObjectionSnippet(leadId, need.query, { callId, source: 'transcript_stream' }));
      }
      if (/stop|remove me|take me off|do not call|unsubscribe/i.test(need.query)) {
        retrieved.push(await getComplianceSnippet('opt out handling', { leadId, callId, source: 'transcript_stream' }));
      }
    } catch (err) {
      log.warn('caller.moss.turn_retrieval_failed', { leadId, callId, kind: need.kind, reason: need.reason, error: err?.message || String(err) });
    }
  }
  emit('caller.moss_context', {
    worker: 'caller',
    leadId,
    callId,
    mock,
    turnTs: turn.ts,
    needs: needs.map((need) => ({ kind: need.kind, reason: need.reason })),
    snippetIds: retrieved.flatMap((item) => item?.snippetIds || []),
    noWebSearch: true
  });
  return retrieved;
}

async function safeAddMemory(containerTag, kind, content, metadata) {
  try {
    return await addDoc(containerTag, kind, content, metadata);
  } catch (err) {
    log.warn('memory.add.skipped', { containerTag, kind, error: err?.message || String(err) });
    emit('memory.add.skipped', {
      worker: 'memory',
      leadId: containerTag.startsWith('biz_') ? containerTag.slice(4) : null,
      kind,
      reason: err?.message || String(err)
    });
    return null;
  }
}

function formatMossPrompt(hotContext) {
  const snippets = compactMossSnippets(hotContext);
  if (!snippets.length) return '';
  return [
    'Moss hot context for this call. Use these as low-latency retrieval hints; do not invent beyond them:',
    ...snippets.slice(0, 10).map((snippet) => `- [${snippet.kind || 'snippet'}:${snippet.id}] ${snippet.text}`)
  ].join('\n');
}

function compactMossSnippets(hotContext) {
  const seen = new Set();
  return (hotContext?.snippets || [])
    .map((snippet) => ({
      id: snippet.id,
      kind: snippet.metadata?.kind || snippet.kind || 'snippet',
      text: String(snippet.text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    }))
    .filter((snippet) => {
      if (!snippet.id || !snippet.text || seen.has(snippet.id)) return false;
      seen.add(snippet.id);
      return true;
    })
    .slice(0, 14);
}

function computeCallDurationSeconds(callRow) {
  if (!callRow) return 0;
  const started = Number(callRow.started_at) || 0;
  const ended = Number(callRow.ended_at) || 0;
  if (!started || !ended || ended < started) return 0;
  return Math.round((ended - started) / 1000);
}

async function runLive({ leadId, lead, toPhone, pitch, profile, disclosureText, runId, hotContext, verticalPack = null, experimentAssignment = null }) {
  const dnc = dncCheck(toPhone || lead.phone, { lead, profile, disclosureText, skipAttemptLimit: true });
  if (!dnc.ok) throw new Error(`DNC: ${dnc.reason}`);
  const normalized = dnc.phone;

  let callId = null;
  let providerCallId = null;
  const streamedTurns = [];
  const seenTurns = new Set();
  let optedOut = false;
  let callState = null;

  const emitTurn = async (turn, source = 'stream') => {
    const role = turn.role === 'user' ? 'user' : 'agent';
    const text = String(turn.text || '').trim();
    if (!text) return;
    const key = `${role}:${text}`;
    if (seenTurns.has(key)) return;
    seenTurns.add(key);
    const ts = turn.ts || Date.now();
    const chunk = { role, text, ts };
    streamedTurns.push(chunk);
    emit('caller.transcript', { worker: 'caller', leadId, callId, role, text, ts, mock: false, source });
    const retrievals = role === 'user'
      ? await maybeRetrieveMossForTurn({ leadId, callId, turn: chunk, mock: false })
      : [];
    if (callState) {
      callState = advanceCallState(callState, chunk, {
        lead,
        profile,
        pitch,
        verticalPack,
        hotContext,
        retrievals,
        disclosureText,
        callId,
        runId,
        now: ts
      });
      emitCallState(callState, { leadId, callId, runId, mock: false, turn: chunk });
      if (callState.currentState === 'callback' && callState.callback?.scheduledAtMs) {
        persistCallbackPromise({ leadId, callId, state: callState, turn: chunk });
      }
    }
    // Live operator warm-transfer check. Per-call dedupe lives in
    // operatorTransfer.js, so it's safe to evaluate on every user turn. Only
    // fires when OPERATOR_TRANSFER_NUMBER is set; otherwise the transfer
    // function emits caller.transfer_unavailable and no-ops.
    if (role === 'user' && OPERATOR_TRANSFER_NUMBER) {
      const decision = shouldTransfer(streamedTurns);
      if (decision.transfer) {
        const transfer = enqueueOperatorTransferJob({
          providerCallId,
          leadId,
          callId,
          reason: decision.reason,
          source: 'caller.worker',
          eventId: `${callId}:${streamedTurns.length}`
        });
        emit('operator.transfer.queued', {
          worker: 'caller',
          callId,
          leadId,
          providerCallId,
          reason: decision.reason,
          jobId: transfer.row?.id,
          source: 'caller.worker'
        });
      }
    }
    if (role === 'user' && transcriptHasOptOut(text)) {
      recordOptOut(normalized);
      optedOut = true;
      leads.update(leadId, { outreach_status: 'blocked', risk_status: 'opt-out', next_action: 'do_not_call' });
      log.warn('caller.optout', { leadId, callId });
      emit('caller.optout', { worker: 'caller', leadId, callId, providerCallId, mock: false });
      try {
        await endAgentPhoneCall(providerCallId);
      } catch (err) {
        log.warn('agentphone.optout.end_failed', { leadId, callId, providerCallId, error: err?.message || String(err) });
      }
    }
  };

  try {
    const voice = await verifyAgentPhoneVoice(env.agentphone.defaultVoice);
    const agent = await ensureAgentPhoneAgent({
      voice: voice.id,
      beginMessage: pitch.beginMessage,
      systemPrompt: 'You are a friendly cold-call agent for callmemaybe. Per-call system prompts contain the actual pitch, disclosure, opt-out rule, and email readback rule.'
    });
    const systemPrompt = pitchToSystemPrompt(pitch, lead, hotContext);

    // Reputation auto-throttle pre-call gate. Blocks ONLY when an area code has
    // hit its daily ceiling — rolling opt-out / voicemail-only rates pause the
    // outreach loop via the 30s scheduler, not the per-call path.
    const reputationGate = canDialPhone(normalized || toPhone || lead.phone);
    if (!reputationGate.ok) {
      const blockReason = reputationGate.reason || 'reputation_blocked';
      const blockedCallId = `call_${Date.now().toString(36)}`;
      calls.start({
        id: blockedCallId,
        lead_id: leadId,
        to_phone: normalized,
        provider_call_id: null,
        disclosure_text: disclosureText,
        decision_reason: blockReason
      });
      calls.finish(blockedCallId, {
        outcome: 'failed:reputation_block',
        transcript: { error: blockReason, areaCode: reputationGate.areaCode }
      });
      try {
        reputationRecordCallAttempt({ leadId, phone: normalized, outcome: 'failed:reputation_block' });
      } catch (recErr) {
        log.warn('reputation.record_block_failed', { leadId, callId: blockedCallId, error: recErr?.message || String(recErr) });
      }
      leads.update(leadId, {
        outreach_status: 'retry',
        risk_status: 'reputation_block',
        next_action: 'retry_after_reputation_cooldown'
      });
      emit('caller.error', {
        worker: 'caller',
        leadId,
        runId,
        callId: blockedCallId,
        outcome: 'failed:reputation_block',
        reason: blockReason,
        areaCode: reputationGate.areaCode || null,
        attempts24h: reputationGate.attempts24h ?? null,
        limit: reputationGate.limit ?? null,
        mock: false
      });
      throw new Error(`reputation_block: ${blockReason}`);
    }

    const placed = await placeAgentPhoneCall({
      agentId: agent.id,
      toNumber: normalized,
      systemPrompt,
      initialGreeting: pitch.beginMessage,
      voice: voice.id
    });
    providerCallId = placed.id;
    callId = `call_${Date.now().toString(36)}`;
    const liveReason = dnc.reason || 'live call allowed';
    const liveReasonWithArm = experimentAssignment?.arm
      ? `${liveReason} | arm=${experimentAssignment.arm}`
      : liveReason;
    calls.start({
      id: callId,
      lead_id: leadId,
      to_phone: normalized,
      provider_call_id: providerCallId,
      disclosure_text: disclosureText,
      decision_reason: liveReasonWithArm
    });
    callState = createInitialCallState({
      lead,
      profile,
      pitch,
      verticalPack,
      hotContext,
      callId,
      runId,
      disclosureText
    });
    emitCallState(callState, { leadId, callId, runId, mock: false });
    emit('caller.placed', {
      worker: 'caller',
      leadId,
      runId,
      callId,
      providerCallId,
      agentId: agent.id,
      voice: voice.id,
      toPhone: mask(normalized),
      mock: false
    });

    try {
      await streamAgentPhoneTranscript(providerCallId, {
        onTurn: (turn) => emitTurn(turn, 'stream')
      });
    } catch (err) {
      const failure = classifyAgentPhoneFailure(err);
      log.warn('agentphone.stream.fallback', { leadId, callId, providerCallId, category: failure.category, error: err?.message || String(err) });
      emit('caller.transcript_fallback', { worker: 'caller', leadId, callId, providerCallId, reason: failure.category, mock: false });
      const fallback = await waitForAgentPhoneFinalTranscript(providerCallId, { timeoutMs: 3 * 60 * 1000, intervalMs: 5000 });
      for (const turn of normalizeAgentPhoneTranscript(fallback.transcript)) {
        await emitTurn(turn, 'final-poll');
      }
    }

    let finalTranscript = null;
    try {
      finalTranscript = await fetchAgentPhoneFinalTranscript(providerCallId);
    } catch (err) {
      log.warn('agentphone.finalTranscript.failed', { leadId, callId, providerCallId, error: err?.message || String(err) });
    }
    if (!finalTranscript) {
      const fallback = await waitForAgentPhoneFinalTranscript(providerCallId, { timeoutMs: 30 * 1000, intervalMs: 5000 });
      finalTranscript = fallback.transcript;
    }

    const finalTurns = normalizeAgentPhoneTranscript(finalTranscript);
    if (!optedOut && transcriptHasOptOut(finalTurns)) {
      recordOptOut(normalized);
      optedOut = true;
      leads.update(leadId, { outreach_status: 'blocked', risk_status: 'opt-out', next_action: 'do_not_call' });
    }

    const transcriptForStorage = finalTranscript || { turns: streamedTurns, source: 'agentphone-stream-fallback' };
    const outcome = optedOut ? 'opt-out' : 'ended';
    calls.finish(callId, { outcome, transcript: transcriptForStorage });
    if (callState) {
      callState = terminalCallState(callState, outcome, {
        lead,
        profile,
        pitch,
        verticalPack,
        hotContext,
        disclosureText
      });
      emitCallState(callState, { leadId, callId, runId, mock: false });
    }
    try {
      const finishedRow = calls.get(callId);
      const durationSeconds = computeCallDurationSeconds(finishedRow);
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
        recordAgentPhoneCallCost({ leadId, durationSeconds, callId });
      }
    } catch (recErr) {
      log.warn('caller.cost_record_live_failed', { leadId, callId, error: recErr?.message || String(recErr) });
    }
    try {
      reputationRecordCallAttempt({ leadId, phone: normalized, outcome });
    } catch (recErr) {
      log.warn('reputation.record_live_attempt_failed', { leadId, callId, error: recErr?.message || String(recErr) });
    }
    await safeAddMemory(containerTagFor(leadId), 'call_log', transcriptForStorage || { note: 'no transcript' }, {
      provider_call_id: providerCallId,
      outcome,
      stream_turns: streamedTurns.length
    });
    if (!optedOut) leads.update(leadId, { outreach_status: 'called', next_action: 'analyze_call' });
    if (experimentAssignment && !optedOut) {
      // Non-failure terminal outcome = the live call connected and ran to a normal end.
      try {
        recordExperimentOutcome({ assignment: experimentAssignment, outcome: 'connected', valueCents: null });
      } catch (err) {
        log.warn('experiment.outcome.live_failed', { leadId, callId, error: err?.message || String(err) });
      }
    }
    emit('caller.done', { worker: 'caller', leadId, runId, callId, outcome, providerCallId, mock: false });
    fireAnalyst(leadId, callId);
    return { callId, providerCallId };
  } catch (err) {
    // Pre-call reputation block already recorded its own outcome + caller.error
    // event before throwing, so we re-throw without double-counting.
    if (/^reputation_block:/.test(err?.message || '')) {
      throw err;
    }
    const failure = classifyAgentPhoneFailure(err);
    if (callId) {
      calls.finish(callId, {
        outcome: failure.outcome,
        transcript: streamedTurns.length ? { turns: streamedTurns, error: failure.reason } : { error: failure.reason }
      });
      if (callState) {
        callState = terminalCallState(callState, failure.outcome, {
          lead,
          profile,
          pitch,
          verticalPack,
          hotContext,
          disclosureText
        });
        emitCallState(callState, { leadId, callId, runId, mock: false });
      }
      try {
        const finishedRow = calls.get(callId);
        const durationSeconds = computeCallDurationSeconds(finishedRow);
        if (durationSeconds > 0) {
          recordAgentPhoneCallCost({ leadId, durationSeconds, callId });
        }
      } catch (recErr) {
        log.warn('caller.cost_record_failure_failed', { leadId, callId, error: recErr?.message || String(recErr) });
      }
    }
    try {
      reputationRecordCallAttempt({ leadId, phone: normalized, outcome: failure.outcome });
    } catch (recErr) {
      log.warn('reputation.record_live_failure_failed', { leadId, callId, error: recErr?.message || String(recErr) });
    }
    leads.update(leadId, failure.retryable
      ? { outreach_status: 'retry', risk_status: failure.category, next_action: 'retry_call' }
      : { outreach_status: 'blocked', risk_status: failure.category, next_action: 'operator_review_call' });
    emit('caller.call_failed', {
      worker: 'caller',
      leadId,
      runId,
      callId,
      providerCallId,
      outcome: failure.outcome,
      category: failure.category,
      retryable: failure.retryable,
      mock: false
    });
    try {
      applyAttemptOutcome({ leadId, outcome: failure.outcome });
    } catch (cadenceErr) {
      log.warn('cadence.apply_failed', { leadId, error: cadenceErr?.message || String(cadenceErr) });
    }
    throw err;
  }
}

export async function runCaller({ leadId, toPhone, pitchOverride = null, source = null, scheduledCallId = null }) {
  const runId = `run_${Date.now().toString(36)}`;
  runs.start({ id: runId, lead_id: leadId, worker: 'caller' });
  emit('caller.start', { worker: 'caller', leadId, runId, toPhone: mask(toPhone), source: source || 'manual', scheduledCallId });

  try {
    const lead = leads.get(leadId);
    if (!lead) throw new Error(`lead not found: ${leadId}`);

    const profile = await loadProfile(leadId, lead);
    const disclosure = recordingDisclosure(lead.business_name);
    const generatedPitch = pitchOverride || await generatePitch({ profile, lead, disclosure });

    let pack = null;
    let pitch = generatedPitch;
    try {
      pack = pickPack(lead);
      if (pack) {
        pitch = applyPackToPitch(generatedPitch, pack) || generatedPitch;
        if (lead.vertical_pack !== pack.key) {
          try {
            leads.update(leadId, { vertical_pack: pack.key });
          } catch (err) {
            log.warn('verticalPack.persist_failed', { leadId, packKey: pack.key, error: err?.message || String(err) });
          }
        }
      }
    } catch (err) {
      log.warn('verticalPack.apply_failed', { leadId, error: err?.message || String(err) });
      pitch = generatedPitch;
    }

    // Layer in the active pitch_v2 experiment arm AFTER the vertical pack
    // applies so arm rewrites win over the pack tone and the assignment is
    // sticky on lead.id (assignArm is idempotent by bucket key).
    let experimentAssignment = null;
    try {
      const armed = applyPitchExperiment({ lead, pitch, profile, disclosure });
      pitch = armed.pitch || pitch;
      experimentAssignment = armed.assignment || null;
    } catch (err) {
      log.warn('experiment.apply_failed', { leadId, error: err?.message || String(err) });
    }

    if (!pitchOverride) {
      await safeAddMemory(containerTagFor(leadId), 'pitch', pitch, {
        generatedFor: leadId,
        verticalPack: pack?.key || null,
        experimentArm: experimentAssignment?.arm || null
      });
    }
    emit('pitch.created', {
      worker: 'caller',
      leadId,
      runId,
      keys: Object.keys(pitch),
      openingLine: pitch.openingLine,
      objectionCount: (pitch.objections || []).length,
      source: source || (pitchOverride ? 'override' : 'generated'),
      verticalPack: pack?.key || null,
      experimentArm: experimentAssignment?.arm || null
    });

    const hotContext = await buildMossHotContext({ leadId, lead, profile, pitch, runId });

    const live = modeAllowsSideEffect('calls') && env.live.calls;
    if (live) {
      const allowed = callabilityForLead({ lead, profile, disclosureText: disclosure, phone: toPhone || lead.phone });
      recordCallDecision({
        leadId,
        phone: toPhone || lead.phone,
        allowed: allowed.ok,
        reason: allowed.reason,
        disclosureText: disclosure
      });
      if (!allowed.ok) {
        leads.update(leadId, {
          outreach_status: 'blocked',
          risk_status: allowed.reason,
          phone_classification: allowed.phoneClassification || 'unknown',
          next_action: 'blocked'
        });
        throw new Error(`call refused: ${allowed.reason}`);
      }
      leads.update(leadId, {
        outreach_status: 'calling',
        risk_status: 'callable',
        phone_classification: allowed.phoneClassification,
        next_action: 'call_in_progress'
      });
    }
    const result = live
      ? await runLive({ leadId, lead, toPhone, pitch, profile, disclosureText: disclosure, runId, hotContext, verticalPack: pack, experimentAssignment })
      : await runMock({ leadId, lead, pitch, profile, disclosureText: disclosure, runId, hotContext, verticalPack: pack, experimentAssignment });

    runs.finish(runId, { state: 'completed', detail: { ...result, mock: !live } });
    return result;
  } catch (err) {
    const message = err?.message || String(err);
    log.error('caller.failed', { leadId, error: message });
    runs.finish(runId, { state: 'failed', error: message });
    emit('caller.error', { worker: 'caller', leadId, runId, error: message });
    throw err;
  }
}
