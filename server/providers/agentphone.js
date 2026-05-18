import { env, modeAllowsSideEffect } from '../env.js';
import { log } from '../logger.js';
import { normalizePhone } from '../compliance.js';
import { fetchJson, normalizeProviderError, providerConfigured, sideEffectGate, smokeDetail } from './core.js';

const PROVIDER = 'agentphone';
const AGENT_NAME = 'callmemaybe-agent-v1';
const DEFAULT_VOICE = 'Polly.Joanna';
const DEFAULT_AGENT_PROMPT = 'You are a friendly cold-call agent for callmemaybe. Per-call system prompts contain the actual sales script and compliance instructions.';
const DEFAULT_BEGIN_MESSAGE = 'Hi, this is callmemaybe. This call is automated and may be recorded.';
const VOICE_CACHE_MS = 10 * 60 * 1000;
const AGENT_CACHE_MS = 10 * 60 * 1000;
const TERMINAL_STATUSES = new Set([
  'ended',
  'completed',
  'complete',
  'failed',
  'error',
  'canceled',
  'cancelled',
  'busy',
  'no_answer',
  'no-answer',
  'not_answered',
  'voicemail',
  'disconnected'
]);

const _voiceCache = new Map();
const _agentCache = new Map();

export function agentPhoneConfigured(config = env.agentphone) {
  return providerConfigured({ AGENTPHONE_API_KEY: config.apiKey });
}

export function agentPhoneReadinessDetails(config = env.agentphone) {
  const configured = agentPhoneConfigured(config);
  return {
    configured: configured.configured,
    missing: configured.missing,
    baseUrl: apiUrl('/', config).replace(/\/$/, ''),
    auth: 'bearer_token',
    agentId: config.agentId ? 'configured' : 'create_or_reuse',
    voice: config.defaultVoice || DEFAULT_VOICE,
    voiceVerification: 'GET /agents/voices',
    hostedMode: true,
    transcript: {
      stream: 'GET /calls/{id}/transcript/stream',
      final: 'GET /calls/{id}/transcript'
    },
    webhook: {
      signature: 'hmac_sha256_timestamp_raw_body',
      secret: config.webhookSecret ? 'configured' : 'missing'
    },
    compliance: {
      recordingDisclosure: 'beginMessage',
      optOut: 'webhook_transcript_detection'
    },
    smoke: env.smoke.liveCall ? 'enabled_by_SMOKE_LIVE_CALL' : 'disabled_by_default'
  };
}

export async function listAgentPhoneVoices({ config = env.agentphone } = {}) {
  requireAgentPhone(config);
  const cacheKey = `${config.apiKey}:${config.baseUrl}:voices`;
  const cached = _voiceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < VOICE_CACHE_MS) return cached.voices;

  const body = await agentPhoneJson('listVoices', '/agents/voices', {
    method: 'GET'
  }, {
    config,
    timeoutMs: 12000,
    retries: 2
  });
  const voices = flattenVoices(body);
  _voiceCache.set(cacheKey, { at: Date.now(), voices });
  return voices;
}

export async function verifyAgentPhoneVoice(voice = env.agentphone.defaultVoice, options = {}) {
  const desired = voice || DEFAULT_VOICE;
  const voices = await listAgentPhoneVoices(options);
  const match = findVoice(voices, desired);
  if (!match) {
    const sample = voices.slice(0, 10).map((v) => v.id || v.name).filter(Boolean);
    throw new Error(`AgentPhone voice "${desired}" was not returned by /agents/voices${sample.length ? `; sample=${sample.join(',')}` : ''}`);
  }
  return {
    id: match.id || match.name || desired,
    name: match.name || match.id || desired,
    provider: match.provider || null,
    verified: true,
    raw: match.raw
  };
}

export async function ensureAgentPhoneAgent({
  name = AGENT_NAME,
  voice = env.agentphone.defaultVoice || DEFAULT_VOICE,
  systemPrompt = DEFAULT_AGENT_PROMPT,
  beginMessage = DEFAULT_BEGIN_MESSAGE,
  config = env.agentphone
} = {}) {
  requireAgentPhone(config);
  const cacheKey = `${config.apiKey}:${config.baseUrl}:${config.agentId || name}:${voice}`;
  const cached = _agentCache.get(cacheKey);
  if (cached && Date.now() - cached.at < AGENT_CACHE_MS) return cached.agent;

  if (config.agentId) {
    const agent = await getAgentPhoneAgent(config.agentId, { config });
    const normalized = normalizeAgent(agent, { source: 'env', reused: true });
    _agentCache.set(cacheKey, { at: Date.now(), agent: normalized });
    return normalized;
  }

  const existing = await findReusableAgent({ name, config });
  if (existing?.id) {
    const normalized = normalizeAgent(existing, { source: 'list', reused: true });
    _agentCache.set(cacheKey, { at: Date.now(), agent: normalized });
    return normalized;
  }

  const created = await agentPhoneJson('createAgent', '/agents', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'callmemaybe hosted sales caller',
      voiceMode: 'hosted',
      enableMessaging: false,
      modelTier: 'balanced',
      systemPrompt,
      beginMessage,
      voice,
      sttMode: 'accurate',
      ambientSound: 'none',
      denoisingMode: 'noise-cancellation',
      maxSilenceMs: 120000
    })
  }, {
    config,
    timeoutMs: 20000,
    retries: 0
  });

  const normalized = normalizeAgent(created, { source: 'created', reused: false });
  if (!normalized.id) throw new Error('AgentPhone createAgent returned no id');
  _agentCache.set(cacheKey, { at: Date.now(), agent: normalized });
  return normalized;
}

export async function getAgentPhoneAgent(agentId, { config = env.agentphone } = {}) {
  requireAgentPhone(config);
  return agentPhoneJson('getAgent', `/agents/${encodeURIComponent(agentId)}`, {
    method: 'GET'
  }, {
    config,
    timeoutMs: 12000,
    retries: 2
  });
}

export async function updateAgentPhoneAgent(agentId, patch = {}, { config = env.agentphone } = {}) {
  requireAgentPhone(config);
  if (!agentId) throw new Error('updateAgentPhoneAgent requires agentId');
  const allowedKeys = [
    'name', 'description', 'voiceMode', 'enableMessaging', 'modelTier',
    'systemPrompt', 'beginMessage', 'voice', 'transferNumber',
    'voicemailMessage', 'sttMode', 'ambientSound', 'denoisingMode', 'maxSilenceMs'
  ];
  const body = {};
  for (const key of allowedKeys) {
    if (patch[key] !== undefined) body[key] = patch[key];
  }
  const result = await agentPhoneJson('updateAgent', `/agents/${encodeURIComponent(agentId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  }, {
    config,
    timeoutMs: 15000,
    retries: 1
  });
  // bust agent cache so the next outbound call refetches the new prompt
  _agentCache.clear();
  return result;
}

export async function placeAgentPhoneCall({
  agentId,
  toNumber,
  systemPrompt,
  initialGreeting,
  voice,
  variables,
  config = env.agentphone
} = {}) {
  requireAgentPhone(config);
  if (!agentId) throw new Error('AgentPhone call requires agentId');
  if (!toNumber) throw new Error('AgentPhone call requires toNumber');

  const body = compactObject({
    agentId,
    toNumber,
    systemPrompt,
    initialGreeting,
    voice,
    variables
  });

  const placed = await agentPhoneJson('placeCall', '/calls', {
    method: 'POST',
    body: JSON.stringify(body)
  }, {
    config,
    timeoutMs: 20000,
    retries: 0
  });

  const id = agentPhoneCallId(placed);
  if (!id) throw new Error('AgentPhone placeCall returned no call id');
  return { ...placed, id, raw: placed };
}

export async function endAgentPhoneCall(callId, { config = env.agentphone } = {}) {
  requireAgentPhone(config);
  if (!callId) return null;
  return agentPhoneJson('endCall', `/calls/${encodeURIComponent(callId)}/end`, {
    method: 'POST'
  }, {
    config,
    timeoutMs: 10000,
    retries: 1
  });
}

export async function getAgentPhoneCall(callId, { config = env.agentphone } = {}) {
  requireAgentPhone(config);
  return agentPhoneJson('getCall', `/calls/${encodeURIComponent(callId)}`, {
    method: 'GET'
  }, {
    config,
    timeoutMs: 12000,
    retries: 2
  });
}

export async function fetchAgentPhoneFinalTranscript(callId, { config = env.agentphone } = {}) {
  requireAgentPhone(config);
  if (!callId) return null;
  const body = await agentPhoneJson('finalTranscript', `/calls/${encodeURIComponent(callId)}/transcript`, {
    method: 'GET'
  }, {
    config,
    timeoutMs: 15000,
    retries: 2
  });
  return body;
}

export async function waitForAgentPhoneFinalTranscript(callId, {
  config = env.agentphone,
  timeoutMs = 10 * 60 * 1000,
  intervalMs = 5000
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastTranscript = null;
  let lastCall = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      lastTranscript = await fetchAgentPhoneFinalTranscript(callId, { config });
    } catch (err) {
      lastError = err;
      log.warn('agentphone.finalTranscript.poll_failed', { callId, error: err?.message || String(err) });
    }

    try {
      lastCall = await getAgentPhoneCall(callId, { config });
    } catch (err) {
      lastError = err;
      log.warn('agentphone.call.poll_failed', { callId, error: err?.message || String(err) });
    }

    const callTranscript = transcriptFromCall(lastCall);
    if (callTranscript && normalizeAgentPhoneTranscript(callTranscript).length > normalizeAgentPhoneTranscript(lastTranscript).length) {
      lastTranscript = callTranscript;
    }

    if (isTerminalAgentPhoneCall(lastCall)) {
      return { transcript: lastTranscript, call: lastCall, terminal: true, error: lastError };
    }

    await delay(intervalMs);
  }

  return { transcript: lastTranscript, call: lastCall, terminal: false, timedOut: true, error: lastError };
}

export async function streamAgentPhoneTranscript(callId, {
  config = env.agentphone,
  timeoutMs = 10 * 60 * 1000,
  onTurn
} = {}) {
  requireAgentPhone(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const turns = [];
  let ended = false;

  try {
    const res = await fetch(apiUrl(`/calls/${encodeURIComponent(callId)}/transcript/stream`, config), {
      method: 'GET',
      headers: {
        ...authHeaders(config),
        Accept: 'text/event-stream'
      },
      signal: controller.signal
    });
    if (!res.ok || !res.body) {
      const text = await safeText(res);
      const err = new Error(`AgentPhone transcript stream ${res.status}: ${text.slice(0, 240)}`);
      err.status = res.status;
      throw err;
    }

    for await (const event of sseEvents(res.body)) {
      if (event.event && isTerminalEvent(event.event)) ended = true;
      const eventTurns = normalizeAgentPhoneTranscript(event.data);
      for (const turn of eventTurns) {
        turns.push(turn);
        await onTurn?.(turn, event);
      }
      if (ended) break;
    }

    return { streamed: true, ended, turns };
  } catch (err) {
    if (err?.name === 'AbortError') {
      const timeout = new Error(`AgentPhone transcript stream timed out after ${timeoutMs}ms`);
      timeout.code = 'timeout';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeAgentPhoneTranscript(value) {
  const turns = [];
  collectTranscriptTurns(value, turns);
  return turns
    .filter((turn) => turn.text)
    .map((turn) => ({
      role: normalizeRole(turn.role),
      text: String(turn.text).trim(),
      ts: normalizeTimestamp(turn.ts),
      providerId: turn.providerId || null
    }));
}

export function classifyAgentPhoneFailure(input) {
  const text = failureText(input).toLowerCase();
  const status = Number(input?.status || input?.statusCode || input?.response?.status || 0) || null;
  const code = String(input?.code || input?.type || input?.errorCode || '').toLowerCase();

  if (status === 401 || status === 403 || /\b(auth|unauthorized|forbidden|token|api key)\b/.test(text)) {
    return failure('auth', false, input);
  }
  if (status === 429 || /\b(rate.?limit|too many requests|quota)\b/.test(text)) {
    return failure('rate-limited', true, input);
  }
  if (/\b(opt.?out|do not call|dnc|blocked)\b/.test(text)) {
    return failure('blocked', false, input);
  }
  if (/\b(invalid|malformed|e\.?164|not a valid phone)\b/.test(text)) {
    return failure('invalid-number', false, input);
  }
  if (/\b(no.?answer|not.?answered|unanswered)\b/.test(text)) {
    return failure('no-answer', true, input);
  }
  if (/\bbusy\b/.test(text)) {
    return failure('busy', true, input);
  }
  if (/\b(voicemail|answering machine|machine detected)\b/.test(text)) {
    return failure('voicemail', true, input);
  }
  if (/\b(timeout|timed out|abort)\b/.test(text) || code === 'timeout') {
    return failure('timeout', true, input);
  }
  if (/\b(fetch failed|network|econn|enotfound|etimedout|socket)\b/.test(text)) {
    return failure('network', true, input);
  }
  if (status && status >= 500) {
    return failure('provider-error', true, input);
  }
  if (status && status >= 400) {
    return failure('provider-rejected', false, input);
  }
  return failure('unknown', true, input);
}

export function normalizeAgentPhoneError(err) {
  const normalized = normalizeProviderError(err);
  const failureInfo = classifyAgentPhoneFailure({
    ...normalized,
    message: normalized.message,
    status: normalized.status,
    code: normalized.code
  });
  return {
    ...normalized,
    category: failureInfo.category,
    outcome: failureInfo.outcome,
    retryable: normalized.retryable ?? failureInfo.retryable
  };
}

export function agentPhoneCallId(value) {
  return value?.id ||
    value?.callId ||
    value?.call_id ||
    value?.call?.id ||
    value?.data?.id ||
    value?.data?.callId ||
    value?.data?.call_id ||
    null;
}

export function isTerminalAgentPhoneCall(call) {
  const status = String(call?.status || call?.call?.status || call?.data?.status || '').toLowerCase();
  return TERMINAL_STATUSES.has(status) || Boolean(call?.endedAt || call?.ended_at || call?.call?.endedAt);
}

export async function agentPhoneOwnedNumberSmoke({
  phone = process.env.SMOKE_TEST_PHONE,
  live = process.env.SMOKE_LIVE_CALL === 'true' || process.env.SMOKE_LIVE_CALL === '1',
  config = env.agentphone
} = {}) {
  const configured = agentPhoneConfigured(config);
  if (!configured.configured) {
    return { provider: PROVIDER, status: 'missing', detail: smokeDetail({ skipped: configured.missing.join(', ') }) };
  }
  if (!live) {
    return {
      provider: PROVIDER,
      status: 'configured',
      detail: smokeDetail({ skipped: 'set SMOKE_LIVE_CALL=true and SMOKE_TEST_PHONE to place one owned-number call' })
    };
  }

  const normalized = normalizePhone(phone);
  const gate = sideEffectGate({
    provider: PROVIDER,
    action: 'owned-number smoke call',
    enabled: env.live.calls && modeAllowsSideEffect('calls') && normalized && env.allowedPhones.includes(normalized),
    details: { mode: env.runMode, phoneAllowed: Boolean(normalized && env.allowedPhones.includes(normalized)) }
  });
  if (!gate.ok) return { provider: PROVIDER, status: 'blocked', detail: smokeDetail({ skipped: gate.reason, extra: gate.details }) };

  const verifiedVoice = await verifyAgentPhoneVoice(config.defaultVoice, { config });
  const agent = await ensureAgentPhoneAgent({
    voice: verifiedVoice.id,
    systemPrompt: 'You are making a single owned-number smoke-test call for callmemaybe. Say it is a smoke test, then end politely.',
    beginMessage: 'Hi, this is a callmemaybe owned-number smoke test. This call is automated and recorded.'
  });
  const placed = await placeAgentPhoneCall({
    agentId: agent.id,
    toNumber: normalized,
    voice: verifiedVoice.id,
    initialGreeting: 'Hi, this is a callmemaybe owned-number smoke test. This call is automated and recorded.',
    systemPrompt: 'Say this is a smoke test, ask whether audio is clear, then end politely.'
  });
  return {
    provider: PROVIDER,
    status: 'ok',
    detail: smokeDetail({ dryRun: false, live: true, extra: { callId: placed.id, agentId: agent.id, voice: verifiedVoice.id } })
  };
}

async function findReusableAgent({ name, config }) {
  const body = await agentPhoneJson('listAgents', '/agents?limit=100', {
    method: 'GET'
  }, {
    config,
    timeoutMs: 12000,
    retries: 2
  });
  const agents = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return agents.find((agent) => agent?.name === name && (!agent.voiceMode || agent.voiceMode === 'hosted')) ||
    agents.find((agent) => agent?.name === name) ||
    null;
}

async function agentPhoneJson(action, path, init, { config = env.agentphone, ...options } = {}) {
  return fetchJson(PROVIDER, action, apiUrl(path, config), {
    ...init,
    headers: {
      ...authHeaders(config),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {})
    }
  }, { classify: normalizeAgentPhoneError, ...options });
}

function requireAgentPhone(config) {
  const configured = agentPhoneConfigured(config);
  if (!configured.configured) throw new Error(`AgentPhone not configured: ${configured.missing.join(', ')}`);
}

function apiUrl(path, config = env.agentphone) {
  const base = String(config.baseUrl || 'https://api.agentphone.ai/v1').replace(/\/+$/, '');
  const versioned = base.endsWith('/v1') ? base : `${base}/v1`;
  return `${versioned}${path.startsWith('/') ? path : `/${path}`}`;
}

function authHeaders(config) {
  return { Authorization: `Bearer ${config.apiKey}` };
}

function normalizeAgent(agent, extra = {}) {
  return {
    ...agent,
    id: agent?.id || agent?.agentId || agent?.agent_id || null,
    voiceMode: agent?.voiceMode || agent?.voice_mode || null,
    voice: agent?.voice || null,
    ...extra
  };
}

function flattenVoices(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    out.push({ id: value, name: value, raw: value });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenVoices(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;

  const id = value.id || value.voiceId || value.voice_id || value.name || value.label || value.value;
  if (id) {
    out.push({
      id: String(id),
      name: value.name || value.label || String(id),
      provider: value.provider || value.providerName || value.engine || null,
      raw: value
    });
  }

  for (const key of ['data', 'voices', 'results', 'items']) flattenVoices(value[key], out);
  if (!id) {
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) flattenVoices(nested, out);
    }
  }
  return dedupeVoices(out);
}

function dedupeVoices(voices) {
  const seen = new Set();
  return voices.filter((voice) => {
    const key = String(voice.id || voice.name || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findVoice(voices, desired) {
  const needle = normVoice(desired);
  return voices.find((voice) => normVoice(voice.id) === needle || normVoice(voice.name) === needle);
}

function normVoice(value) {
  return String(value || '').trim().toLowerCase();
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

async function* sseEvents(stream) {
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
        const parsed = parseSseEvent(raw);
        if (parsed) yield parsed;
      }
    }
    if (buf.trim()) {
      const parsed = parseSseEvent(buf);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock?.();
  }
}

function parseSseEvent(raw) {
  const event = { event: null, data: null };
  const data = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event.event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length && !event.event) return null;
  const payload = data.join('\n');
  if (payload === '[DONE]') return { event: event.event || 'done', data: null };
  if (!payload) return event;
  try {
    event.data = JSON.parse(payload);
  } catch {
    event.data = { text: payload };
  }
  return event;
}

function collectTranscriptTurns(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    out.push({ role: 'unknown', text: value });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTranscriptTurns(item, out);
    return;
  }
  if (typeof value !== 'object') return;

  const text = value.text || value.transcript || value.content || value.message || value.utterance || value.sentence;
  if (typeof text === 'string' && text.trim()) {
    out.push({
      role: value.role || value.speaker || value.source || value.from || value.type,
      text,
      ts: value.ts || value.timestamp || value.createdAt || value.created_at || value.time,
      providerId: value.id || value.messageId || value.message_id || null
    });
  }

  for (const key of ['turns', 'messages', 'transcript', 'transcripts', 'data', 'items', 'conversation']) {
    if (value[key] && value[key] !== value) collectTranscriptTurns(value[key], out);
  }
}

function normalizeRole(role) {
  const value = String(role || '').toLowerCase();
  if (/\b(user|caller|customer|human|recipient|owner)\b/.test(value)) return 'user';
  if (/\b(agent|assistant|ai|bot|system)\b/.test(value)) return 'agent';
  return 'agent';
}

function normalizeTimestamp(value) {
  if (!value) return Date.now();
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function transcriptFromCall(call) {
  return call?.transcript ||
    call?.transcripts ||
    call?.messages ||
    call?.conversation ||
    call?.call?.transcript ||
    call?.data?.transcript ||
    null;
}

function isTerminalEvent(event) {
  const normalized = String(event || '').toLowerCase().replace(/_/g, '.');
  return normalized === 'done' || normalized.endsWith('.ended') || normalized.endsWith('.failed') || normalized === 'ended';
}

function failure(category, retryable, input) {
  return {
    category,
    outcome: `failed:${category}`,
    retryable,
    status: input?.status || input?.statusCode || input?.response?.status || null,
    reason: failureText(input).slice(0, 500)
  };
}

function failureText(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message || input.name || '';
  const parts = [
    input.message,
    input.error,
    input.reason,
    input.failureReason,
    input.failure_reason,
    input.status,
    input.statusCode,
    input.code,
    input.type
  ].filter(Boolean);
  if (parts.length) return parts.map(String).join(' ');
  try { return JSON.stringify(input); } catch { return String(input); }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
