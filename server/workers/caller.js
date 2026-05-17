import { emit } from '../sse.js';
import { runs, leads, calls } from '../db.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { addDoc, getLatest, containerTagFor } from '../memory.js';
import { generateJson, generateText } from '../gemini.js';
import { SalesPitchSchema } from '../types.js';
import { dncCheck, recordingDisclosure, transcriptHasOptOut, recordOptOut } from '../compliance.js';

const _agentIdCache = new Map();

const PITCH_SYSTEM = `You are a sales strategist for callmemaybe, a service that builds and hosts small-business websites for $500 flat. Generate a tight, conversational cold-call pitch tailored to ONE specific business. The owner is busy, suspicious of robocalls, and probably doing something else. Be respectful, specific, and human.`;

const MOCK_TRANSCRIPT_SYSTEM = `You are simulating a realistic cold sales call transcript for demo purposes. Output a believable agent<->owner exchange. The agent represents callmemaybe (sells small-business websites for a $500 flat fee). Make the owner skeptical for a few turns, then convinced. End the conversation with the owner agreeing to receive a follow-up email with payment + a calendar invite. 8 to 12 total turns, alternating roles, starting with the agent.`;

const MOCK_TRANSCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      minItems: 8,
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
  const objLines = (pitch.objections || []).map((o) => `- If they say: "${o.objection}" → respond: ${o.response}`).join('\n');
  const discovery = (pitch.discoveryQuestions || []).map((q, i) => `${i + 1}. ${q}`).join('\n');
  return [
    `You are a sales agent for callmemaybe calling ${lead.business_name || 'a local business'} (${lead.niche || 'small business'}).`,
    `Opening line: ${pitch.openingLine}`,
    `Value proposition: ${pitch.valueProp}`,
    `Discovery questions to weave in naturally:\n${discovery}`,
    `Objection handling:\n${objLines}`,
    `Close: ${pitch.close}`,
    `Be warm, brief, and concrete. If the owner says any variant of "stop", "remove me", "do not call", or "take me off", acknowledge politely and end the call.`
  ].join('\n\n');
}

async function provisionMossIndex(containerTag, pitch) {
  if (!env.moss.projectId || !env.moss.projectKey) return;
  try {
    const { MossClient } = await import('@moss-dev/moss');
    const moss = new MossClient(env.moss.projectId, env.moss.projectKey);
    const docs = [
      { id: 'opening', text: pitch.openingLine },
      { id: 'value-prop', text: pitch.valueProp },
      { id: 'close', text: pitch.close },
      ...(pitch.discoveryQuestions || []).map((q, i) => ({ id: `discovery-${i}`, text: q })),
      ...(pitch.objections || []).map((o, i) => ({ id: `objection-${i}`, text: `${o.objection} :: ${o.response}` }))
    ];
    await moss.createIndex(containerTag, docs);
    log.info('moss.index.created', { containerTag, docCount: docs.length });
  } catch (err) {
    log.warn('moss.index.failed', { containerTag, error: err?.message });
  }
}

async function ensureAgentPersona({ voice }) {
  if (env.agentphone.agentId) return env.agentphone.agentId;
  const cacheKey = env.agentphone.apiKey;
  if (_agentIdCache.has(cacheKey)) return _agentIdCache.get(cacheKey);

  const res = await fetch(`${env.agentphone.baseUrl}/agents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.agentphone.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'callmemaybe-agent-v1',
      voiceMode: 'hosted',
      systemPrompt: 'You are a friendly cold-call agent for callmemaybe. Per-call systemPrompt overrides this.',
      beginMessage: 'Hello.',
      voice
    })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`agentphone.createAgent ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json?.id) throw new Error('agentphone.createAgent returned no id');
  _agentIdCache.set(cacheKey, json.id);
  return json.id;
}

async function placeCall({ agentId, toNumber, systemPrompt }) {
  const res = await fetch(`${env.agentphone.baseUrl}/calls`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.agentphone.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ agentId, toNumber, systemPrompt })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`agentphone.placeCall ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function* sseLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n');
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch {
          yield { text: payload };
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function fetchFinalTranscript(providerCallId) {
  const res = await fetch(`${env.agentphone.baseUrl}/calls/${providerCallId}/transcript`, {
    headers: { 'Authorization': `Bearer ${env.agentphone.apiKey}` }
  });
  if (!res.ok) {
    log.warn('agentphone.finalTranscript.failed', { status: res.status });
    return null;
  }
  return res.json();
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
  const prompt = [
    `Business profile:\n${JSON.stringify(profile, null, 2)}`,
    '',
    `We sell: a flat $500 single-page website built in front of the customer while they watch. Hosted on lovable.app. Ready same day.`,
    `Tone: warm, specific, never pushy. Use one concrete signal from the profile in the opening line.`,
    `IMPORTANT — beginMessage MUST start with EXACTLY this recording disclosure (verbatim, no edits), then a single space, then a one-sentence personal greeting:`,
    `"${disclosure}"`
  ].join('\n');

  const pitch = await generateJson({
    schema: SalesPitchSchema,
    prompt,
    systemInstruction: PITCH_SYSTEM,
    thinkingLevel: 'medium'
  });

  if (!pitch.beginMessage?.toLowerCase().includes('recorded')) {
    pitch.beginMessage = `${disclosure} ${pitch.beginMessage || pitch.openingLine}`;
  }
  return pitch;
}

async function synthesizeMockTranscript({ pitch, profile }) {
  try {
    const prompt = [
      `Business: ${profile.businessName || 'a local business'} — ${profile.whatTheyDo || ''}`,
      `Use this pitch as the agent's playbook:`,
      JSON.stringify(pitch, null, 2),
      `Generate the full transcript (8-12 turns). Owner agrees by the end. First agent turn should reflect the beginMessage (recording disclosure + greeting).`
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
  return [
    { role: 'agent', text: pitch.beginMessage },
    { role: 'user', text: 'Who is this? I am in the middle of something.' },
    { role: 'agent', text: pitch.openingLine },
    { role: 'user', text: pitch.objections?.[0]?.objection || 'I do not really need a website.' },
    { role: 'agent', text: pitch.objections?.[0]?.response || pitch.valueProp },
    { role: 'user', text: 'How much?' },
    { role: 'agent', text: pitch.close },
    { role: 'user', text: 'Okay, send me the details.' }
  ];
}

async function runMock({ leadId, lead, pitch, profile, runId }) {
  const callId = `call_${Date.now().toString(36)}`;
  const turns = await synthesizeMockTranscript({ pitch, profile });
  calls.start({ id: callId, lead_id: leadId, to_phone: mask(lead.phone) || 'mock', provider_call_id: null });
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

async function runLive({ leadId, lead, toPhone, pitch, runId }) {
  const dnc = dncCheck(toPhone);
  if (!dnc.ok) throw new Error(`DNC: ${dnc.reason}`);
  const normalized = dnc.phone;

  const agentId = await ensureAgentPersona({ voice: env.agentphone.defaultVoice });
  const systemPrompt = pitchToSystemPrompt(pitch, lead);
  const placed = await placeCall({ agentId, toNumber: normalized, systemPrompt });
  const providerCallId = placed.id;
  const callId = `call_${Date.now().toString(36)}`;
  calls.start({ id: callId, lead_id: leadId, to_phone: normalized, provider_call_id: providerCallId });
  emit('caller.placed', { worker: 'caller', leadId, runId, callId, providerCallId, toPhone: mask(normalized), mock: false });

  const streamRes = await fetch(`${env.agentphone.baseUrl}/calls/${providerCallId}/transcript/stream`, {
    headers: { 'Authorization': `Bearer ${env.agentphone.apiKey}`, 'Accept': 'text/event-stream' }
  });
  if (!streamRes.ok || !streamRes.body) {
    throw new Error(`agentphone.stream ${streamRes.status}`);
  }

  let optedOut = false;
  for await (const chunk of sseLines(streamRes.body)) {
    const role = chunk.role === 'agent' || chunk.role === 'user' ? chunk.role : 'agent';
    const text = chunk.text || chunk.transcript || '';
    if (!text) continue;
    const ts = chunk.ts || Date.now();
    emit('caller.transcript', { worker: 'caller', leadId, callId, role, text, ts, mock: false });
    if (role === 'user' && transcriptHasOptOut(text)) {
      recordOptOut(normalized);
      optedOut = true;
      log.warn('caller.optout', { leadId, callId });
      break;
    }
  }

  const finalTranscript = await fetchFinalTranscript(providerCallId);
  const outcome = optedOut ? 'opt-out' : 'ended';
  calls.finish(callId, { outcome, transcript: finalTranscript });
  await addDoc(containerTagFor(leadId), 'call_log', finalTranscript || { note: 'no transcript' }, {
    provider_call_id: providerCallId,
    outcome
  });
  emit('caller.done', { worker: 'caller', leadId, runId, callId, outcome, providerCallId, mock: false });
  return { callId, providerCallId };
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

    const live = env.runMode === 'live' && env.live.calls;
    const result = live
      ? await runLive({ leadId, lead, toPhone, pitch, runId })
      : await runMock({ leadId, lead, pitch, profile, runId });

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
