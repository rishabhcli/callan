import { emit } from '../sse.js';
import { runs, leads, calls } from '../db.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { addDoc, getLatest, containerTagFor } from '../memory.js';
import { generateJson } from '../gemini.js';
import { ensureMossPitchIndex, shouldProvisionMossForCall } from '../providers/moss.js';
import {
  SalesPitchGenerationSchema,
  buildPitchResearchContext,
  createFallbackPitch,
  validateGeneratedPitch
} from '../pitch.js';
import { callabilityForLead, dncCheck, recordingDisclosure, recordCallDecision, transcriptHasOptOut, recordOptOut } from '../compliance.js';
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

const PITCH_SYSTEM = `You are a sales strategist for callmemaybe, a service that builds and hosts small-business websites for $500 flat. Generate a tight, conversational cold-call pitch tailored to ONE specific business. Anchor the pitch in the business's online-presence audit, what the business actually does, and the concrete things customers need to know. The owner is busy, suspicious of robocalls, and probably doing something else. Be respectful, specific, and human. Output only JSON that matches the supplied schema exactly.`;

const MOCK_TRANSCRIPT_SYSTEM = `You are simulating a realistic cold sales call transcript for demo purposes. Output a believable agent<->owner exchange. The agent represents callmemaybe (sells small-business websites for a $500 flat fee). Start with the pitch beginMessage exactly, including the recording disclosure. Make the owner skeptical for a few turns, then convinced. End with the agent asking for the best email, the owner spelling it, the agent reading it back, the owner confirming, and the agent saying the invoice will arrive from AgentMail and they can reply there with questions. 10 to 12 total turns, alternating roles, starting with the agent.`;

const MOCK_TRANSCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      minItems: 10,
      maxItems: 12,
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

function mask(phone) {
  if (!phone) return null;
  const s = String(phone);
  if (s.length < 5) return s;
  return `${s.slice(0, 3)}…${s.slice(-2)}`;
}

function pitchToSystemPrompt(pitch, lead) {
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
    `Invoice handoff: ${pitch.invoiceClose || 'The invoice will come from AgentMail, and you can reply there with questions.'}`,
    `Be warm, brief, and concrete. If the owner says any variant of "stop", "remove me", "do not call", or "take me off", acknowledge politely and end the call.`
  ].join('\n\n');
}

function mockEmailForProfile(profile) {
  const name = String(profile?.businessName || 'business')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 32) || 'business';
  return `owner@${name}.com`;
}

async function provisionMossIndex(containerTag, pitch) {
  if (!shouldProvisionMossForCall()) {
    if (env.moss.projectId || env.moss.projectKey) {
      log.info('moss.index.skipped', { containerTag, reason: 'live call gate disabled' });
    }
    return;
  }
  try {
    const result = await ensureMossPitchIndex(containerTag, pitch);
    log.info('moss.index.ready', { containerTag, ...result });
  } catch (err) {
    log.warn('moss.index.failed', { containerTag, error: err?.message });
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
    const raw = await generateJson({
      schema: SalesPitchGenerationSchema,
      prompt,
      systemInstruction: PITCH_SYSTEM,
      thinkingLevel: 'medium'
    });
    return validateGeneratedPitch(raw, { disclosure, profile, lead });
  } catch (err) {
    log.warn('pitch.generate.fallback', { leadId: lead?.id, error: err?.message || String(err) });
    return createFallbackPitch({ disclosure, profile, lead });
  }
}

async function synthesizeMockTranscript({ pitch, profile }) {
  try {
    const invoiceEmail = mockEmailForProfile(profile);
    const prompt = [
      `Business: ${profile.businessName || 'a local business'} — ${profile.whatTheyDo || ''}`,
      `Use this invoice email in the final confirmation sequence: ${invoiceEmail}`,
      `Use this pitch as the agent's playbook:`,
      JSON.stringify(pitch, null, 2),
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
    { role: 'user', text: 'Who is this? I am in the middle of something.' },
    { role: 'agent', text: pitch.openingLine },
    { role: 'user', text: pitch.objections?.[0]?.objection || 'I do not really need a website.' },
    { role: 'agent', text: pitch.objections?.[0]?.response || pitch.valueProp },
    { role: 'user', text: 'How much?' },
    { role: 'agent', text: pitch.close },
    { role: 'user', text: 'Okay, send me the invoice.' },
    { role: 'agent', text: pitch.emailAsk || 'Perfect. What is the best email for the invoice?' },
    { role: 'user', text: invoiceEmail },
    { role: 'agent', text: `${invoiceEmail}, is that right? ${pitch.invoiceClose || 'The invoice will come from AgentMail, and you can reply there with questions.'}` },
    { role: 'user', text: 'Yes, that is right.' }
  ];
}

async function runMock({ leadId, lead, pitch, profile, runId, disclosureText }) {
  const callId = `call_${Date.now().toString(36)}`;
  const turns = await synthesizeMockTranscript({ pitch, profile });
  calls.start({
    id: callId,
    lead_id: leadId,
    to_phone: mask(lead.phone) || 'mock',
    provider_call_id: null,
    disclosure_text: disclosureText,
    decision_reason: 'mock call'
  });
  emit('caller.placed', { worker: 'caller', leadId, runId, callId, providerCallId: null, mock: true });

  const transcript = [];
  for (const turn of turns) {
    await new Promise((r) => setTimeout(r, 600 + Math.floor(Math.random() * 300)));
    const ts = Date.now();
    const chunk = { role: turn.role, text: turn.text, ts };
    transcript.push(chunk);
    emit('caller.transcript', { worker: 'caller', leadId, callId, role: chunk.role, text: chunk.text, ts, mock: true });
  }

  calls.finish(callId, { outcome: 'demo-yes', transcript });
  await addDoc(containerTagFor(leadId), 'call_log', { turns: transcript }, {
    provider_call_id: null,
    outcome: 'demo-yes',
    mock: true
  });
  emit('caller.done', { worker: 'caller', leadId, runId, callId, outcome: 'demo-yes', mock: true });

  setTimeout(() => {
    import('./analyst.js').then(({ runAnalyst }) => runAnalyst({ leadId, callId })).catch((err) => {
      log.warn('analyst.fire.failed', { leadId, callId, error: err?.message });
    });
  }, 0);
  return { callId };
}

function fireAnalyst(leadId, callId) {
  setTimeout(() => {
    import('./analyst.js').then(({ runAnalyst }) => runAnalyst({ leadId, callId })).catch((err) => {
      log.warn('analyst.fire.failed', { leadId, callId, error: err?.message });
    });
  }, 0);
}

async function runLive({ leadId, lead, toPhone, pitch, profile, disclosureText, runId }) {
  const dnc = dncCheck(toPhone || lead.phone, { lead, profile, disclosureText, skipAttemptLimit: true });
  if (!dnc.ok) throw new Error(`DNC: ${dnc.reason}`);
  const normalized = dnc.phone;

  let callId = null;
  let providerCallId = null;
  const streamedTurns = [];
  const seenTurns = new Set();
  let optedOut = false;

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
    const systemPrompt = pitchToSystemPrompt(pitch, lead);
    const placed = await placeAgentPhoneCall({
      agentId: agent.id,
      toNumber: normalized,
      systemPrompt,
      initialGreeting: pitch.beginMessage,
      voice: voice.id
    });
    providerCallId = placed.id;
    callId = `call_${Date.now().toString(36)}`;
    calls.start({
      id: callId,
      lead_id: leadId,
      to_phone: normalized,
      provider_call_id: providerCallId,
      disclosure_text: disclosureText,
      decision_reason: dnc.reason || 'live call allowed'
    });
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
    await addDoc(containerTagFor(leadId), 'call_log', transcriptForStorage || { note: 'no transcript' }, {
      provider_call_id: providerCallId,
      outcome,
      stream_turns: streamedTurns.length
    });
    if (!optedOut) leads.update(leadId, { outreach_status: 'called', next_action: 'analyze_call' });
    emit('caller.done', { worker: 'caller', leadId, runId, callId, outcome, providerCallId, mock: false });
    fireAnalyst(leadId, callId);
    return { callId, providerCallId };
  } catch (err) {
    const failure = classifyAgentPhoneFailure(err);
    if (callId) {
      calls.finish(callId, {
        outcome: failure.outcome,
        transcript: streamedTurns.length ? { turns: streamedTurns, error: failure.reason } : { error: failure.reason }
      });
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
    throw err;
  }
}

export async function runCaller({ leadId, toPhone }) {
  const runId = `run_${Date.now().toString(36)}`;
  runs.start({ id: runId, lead_id: leadId, worker: 'caller' });
  emit('caller.start', { worker: 'caller', leadId, runId, toPhone: mask(toPhone) });

  try {
    const lead = leads.get(leadId);
    if (!lead) throw new Error(`lead not found: ${leadId}`);

    const profile = await loadProfile(leadId, lead);
    const disclosure = recordingDisclosure(lead.business_name);
    const pitch = await generatePitch({ profile, lead, disclosure });

    await addDoc(containerTagFor(leadId), 'pitch', pitch, { generatedFor: leadId });
    emit('pitch.created', {
      worker: 'caller',
      leadId,
      runId,
      keys: Object.keys(pitch),
      openingLine: pitch.openingLine,
      objectionCount: (pitch.objections || []).length
    });

    await provisionMossIndex(containerTagFor(leadId), pitch);

    const live = ['live', 'demo_live', 'autonomous_live'].includes(env.runMode) && env.live.calls;
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
      ? await runLive({ leadId, lead, toPhone, pitch, profile, disclosureText: disclosure, runId })
      : await runMock({ leadId, lead, pitch, profile, disclosureText: disclosure, runId });

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
