import crypto from 'node:crypto';
import { env } from '../env.js';
import { log } from '../logger.js';
import { calls, db, leads, webhookEvents } from '../db.js';
import { emit } from '../sse.js';
import { addDoc, containerTagFor } from '../memory.js';
import { recordOptOut, transcriptHasOptOut } from '../compliance.js';
import {
  classifyAgentPhoneFailure,
  endAgentPhoneCall,
  fetchAgentPhoneFinalTranscript,
  normalizeAgentPhoneTranscript
} from '../providers/agentphone.js';

// AgentPhone webhook signature: the provider emits the signature either as
// X-Webhook-Signature: sha256=<hex>  (upgrade.md / older spec)
// or as
// X-Signature-256: <hex>             (current API reference)
// We accept both, HMAC-SHA256 of either `${ts}.${raw}` (with timestamp header)
// or just `raw` (no timestamp). Constant-time compare on every candidate.
export function verifyAgentPhone(req, rawBody) {
  if (!env.agentphone.webhookSecret) {
    log.warn('AGENTPHONE_WEBHOOK_SECRET not set; rejecting webhook');
    return { ok: false, reason: 'no secret configured' };
  }

  const sig256 = String(req.headers['x-signature-256'] || '').trim();
  const sigGeneric = String(req.headers['x-webhook-signature'] || '').trim();
  const ts = String(req.headers['x-webhook-timestamp'] || req.headers['x-timestamp'] || req.headers['x-signature-timestamp'] || '').trim();

  const provided = pickHex(sigGeneric) || pickHex(sig256);
  if (!provided) return { ok: false, reason: 'no signature header' };

  const secret = env.agentphone.webhookSecret;
  const raw = rawBody.toString('utf8');
  const candidates = [
    ts ? `${ts}.${raw}` : null,
    ts ? `${ts}${raw}` : null,
    raw
  ].filter(Boolean);

  for (const payload of candidates) {
    const expected = crypto.createHmac('sha256', secret).update(payload).digest();
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'bad signature' };
}

export async function handleAgentPhoneWebhook(req) {
  const body = req.body || {};
  const normalized = normalizeAgentPhonePayload(body);
  const eventId = agentPhoneEventId(req, body, normalized);
  const recorded = recordWebhookOnce({ provider: 'agentphone', event_id: eventId, type: normalized.eventType, payload: body });
  if (!recorded) return { ok: true, duplicate: true, eventId };

  emit('agentphone.webhook', {
    worker: 'caller',
    providerType: normalized.eventType,
    providerCallId: normalized.providerCallId,
    callId: normalized.providerCallId
  });

  const callRow = findCallRow(normalized.providerCallId || normalized.internalCallId);
  if (!callRow) {
    log.warn('agentphone.webhook.call_missing', { eventType: normalized.eventType, providerCallId: normalized.providerCallId });
    return { ok: true, eventId, ignored: 'call_not_found' };
  }

  const turns = normalizeAgentPhoneTranscript(normalized.transcript);
  if (turns.length) {
    appendPartialTranscript(callRow, turns);
    for (const turn of turns) {
      emit('caller.transcript', {
        worker: 'caller',
        leadId: callRow.lead_id,
        callId: callRow.id,
        providerCallId: callRow.provider_call_id,
        role: turn.role,
        text: turn.text,
        ts: turn.ts,
        mock: false,
        source: 'webhook'
      });
    }
  }

  const optedOut = await handleWebhookOptOut({ callRow, turns, normalized });
  if (!normalized.terminal) {
    return { ok: true, eventId, callId: callRow.id, optOut: optedOut };
  }

  if (callRow.state === 'ended' && callRow.transcript_json) {
    return { ok: true, eventId, callId: callRow.id, alreadyEnded: true };
  }

  const finalTranscript = await resolveFinalTranscript(callRow, normalized);
  const outcome = optedOut ? 'opt-out' : outcomeForWebhook(normalized, finalTranscript);
  calls.finish(callRow.id, { outcome, transcript: finalTranscript || normalized.transcript || { note: 'no transcript from AgentPhone webhook' } });
  await safeAddCallMemory(callRow, finalTranscript || normalized.transcript, outcome);

  const failure = outcome.startsWith('failed:') ? classifyAgentPhoneFailure(normalized) : null;
  updateLeadAfterTerminalWebhook(callRow.lead_id, { outcome, failure });
  emit('caller.done', {
    worker: 'caller',
    leadId: callRow.lead_id,
    callId: callRow.id,
    providerCallId: callRow.provider_call_id,
    outcome,
    failureCategory: failure?.category,
    mock: false,
    source: 'webhook'
  });
  fireAnalyst(callRow.lead_id, callRow.id);
  return { ok: true, eventId, callId: callRow.id, outcome };
}

export function normalizeAgentPhonePayload(body = {}) {
  const data = body.data || body.payload || body.call || body;
  const call = data.call || body.call || data;
  const eventType = normalizeEventType(body.event || body.type || data.event || data.type || call.event || call.type || call.status || 'agentphone.webhook');
  const providerCallId = firstText(
    body.callId,
    body.call_id,
    body.providerCallId,
    body.provider_call_id,
    data.callId,
    data.call_id,
    data.providerCallId,
    data.provider_call_id,
    call.callId,
    call.call_id,
    call.id,
    data.id
  );
  const transcript = firstPresent(
    body.transcript,
    body.transcripts,
    body.messages,
    data.transcript,
    data.transcripts,
    data.messages,
    call.transcript,
    call.transcripts,
    call.messages,
    body.message,
    data.message
  );
  const status = firstText(body.status, data.status, call.status, body.callStatus, data.callStatus);
  const outcome = firstText(body.outcome, data.outcome, call.outcome, body.disposition, data.disposition);
  const failureReason = firstText(body.failureReason, body.failure_reason, data.failureReason, data.failure_reason, call.failureReason, call.failure_reason, body.reason, data.reason);
  const terminal = isTerminalWebhook(eventType, status, outcome, failureReason);

  return {
    eventType,
    providerCallId,
    internalCallId: firstText(body.internalCallId, body.internal_call_id, data.internalCallId, data.internal_call_id),
    status,
    outcome,
    failureReason,
    transcript,
    terminal,
    raw: body
  };
}

export function agentPhoneEventId(req, body = {}, normalized = normalizeAgentPhonePayload(body)) {
  const explicit = firstText(
    req.headers['x-webhook-id'],
    req.headers['svix-id'],
    req.headers['x-event-id'],
    body.eventId,
    body.event_id,
    body.id,
    body.data?.eventId,
    body.data?.event_id
  );
  if (explicit && explicit !== normalized.providerCallId) return explicit;

  const ts = firstText(
    req.headers['x-webhook-timestamp'],
    req.headers['x-timestamp'],
    body.timestamp,
    body.createdAt,
    body.created_at,
    body.data?.timestamp,
    body.data?.createdAt,
    body.data?.created_at
  );
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      eventType: normalized.eventType,
      providerCallId: normalized.providerCallId,
      status: normalized.status,
      outcome: normalized.outcome,
      failureReason: normalized.failureReason,
      ts,
      transcript: normalizeAgentPhoneTranscript(normalized.transcript).map((t) => `${t.role}:${t.text}`).join('|')
    }))
    .digest('hex')
    .slice(0, 24);
  return `${normalized.eventType}:${normalized.providerCallId || 'unknown'}:${digest}`;
}

function pickHex(value) {
  if (!value) return null;
  const match = String(value).match(/(?:sha256=)?([a-f0-9]{32,128})/i);
  if (!match) return null;
  try {
    return Buffer.from(match[1], 'hex');
  } catch {
    return null;
  }
}

function findCallRow(callRef) {
  if (!callRef) return null;
  return db.prepare(`
    SELECT * FROM calls
    WHERE id = ? OR provider_call_id = ?
    ORDER BY started_at DESC
    LIMIT 1
  `).get(callRef, callRef);
}

function appendPartialTranscript(callRow, turns) {
  if (!turns.length || callRow.state === 'ended') return;
  const existing = parseTranscript(callRow.transcript_json);
  const merged = mergeTurns(normalizeAgentPhoneTranscript(existing), turns);
  db.prepare(`UPDATE calls SET transcript_json = ? WHERE id = ?`).run(JSON.stringify({ turns: merged, partial: true }), callRow.id);
}

async function handleWebhookOptOut({ callRow, turns, normalized }) {
  const transcript = turns.length ? turns : normalizeAgentPhoneTranscript(normalized.transcript);
  const optedOut = transcript.some((turn) => turn.role === 'user' && transcriptHasOptOut(turn.text));
  if (!optedOut) return false;

  recordOptOut(callRow.to_phone);
  leads.update(callRow.lead_id, { outreach_status: 'blocked', risk_status: 'opt-out', next_action: 'do_not_call' });
  emit('caller.optout', {
    worker: 'caller',
    leadId: callRow.lead_id,
    callId: callRow.id,
    providerCallId: callRow.provider_call_id,
    mock: false,
    source: 'webhook'
  });
  if (env.live.calls && env.agentphone.apiKey && callRow.provider_call_id) {
    try {
      await endAgentPhoneCall(callRow.provider_call_id);
    } catch (err) {
      log.warn('agentphone.webhook.optout_end_failed', { callId: callRow.id, providerCallId: callRow.provider_call_id, error: err?.message || String(err) });
    }
  }
  return true;
}

async function resolveFinalTranscript(callRow, normalized) {
  if (callRow.provider_call_id && env.agentphone.apiKey) {
    try {
      const finalTranscript = await fetchAgentPhoneFinalTranscript(callRow.provider_call_id);
      if (normalizeAgentPhoneTranscript(finalTranscript).length) return finalTranscript;
    } catch (err) {
      log.warn('agentphone.webhook.finalTranscript_failed', { callId: callRow.id, providerCallId: callRow.provider_call_id, error: err?.message || String(err) });
    }
  }
  if (normalizeAgentPhoneTranscript(normalized.transcript).length) return normalized.transcript;
  return parseTranscript(callRow.transcript_json);
}

function outcomeForWebhook(normalized, transcript) {
  if (transcriptHasOptOut(normalizeAgentPhoneTranscript(transcript))) return 'opt-out';
  if (failureSignal(normalized)) return classifyAgentPhoneFailure(normalized).outcome;
  const outcome = String(normalized.outcome || normalized.status || '').toLowerCase();
  if (outcome && !['completed', 'complete', 'ended'].includes(outcome)) return outcome;
  return 'ended';
}

function updateLeadAfterTerminalWebhook(leadId, { outcome, failure }) {
  if (outcome === 'opt-out') {
    leads.update(leadId, { outreach_status: 'blocked', risk_status: 'opt-out', next_action: 'do_not_call' });
    return;
  }
  if (failure) {
    leads.update(leadId, failure.retryable
      ? { outreach_status: 'retry', risk_status: failure.category, next_action: 'retry_call' }
      : { outreach_status: 'blocked', risk_status: failure.category, next_action: 'operator_review_call' });
    return;
  }
  leads.update(leadId, { outreach_status: 'called', next_action: 'analyze_call' });
}

async function safeAddCallMemory(callRow, transcript, outcome) {
  try {
    await addDoc(containerTagFor(callRow.lead_id), 'call_log', transcript || { note: 'no transcript' }, {
      provider_call_id: callRow.provider_call_id,
      outcome,
      webhook: true
    });
  } catch (err) {
    log.warn('agentphone.webhook.memory_failed', { callId: callRow.id, error: err?.message || String(err) });
  }
}

function fireAnalyst(leadId, callId) {
  setTimeout(() => {
    import('../workers/analyst.js').then(({ runAnalyst }) => runAnalyst({ leadId, callId })).catch((err) => {
      log.warn('agentphone.webhook.analyst_failed', { leadId, callId, error: err?.message || String(err) });
    });
  }, 0);
}

function recordWebhookOnce(args) {
  if (typeof webhookEvents.recordOnce === 'function') return webhookEvents.recordOnce(args);
  if (webhookEvents.seen(args.provider, args.event_id)) return false;
  webhookEvents.record(args);
  return true;
}

function parseTranscript(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function mergeTurns(existing, incoming) {
  const seen = new Set();
  return [...existing, ...incoming].filter((turn) => {
    const key = `${turn.role}:${turn.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTerminalWebhook(eventType, status, outcome, failureReason) {
  const value = `${eventType} ${status || ''} ${outcome || ''} ${failureReason || ''}`.toLowerCase().replace(/_/g, '.');
  return /\b(call\.)?(ended|completed|complete|failed|busy|voicemail|no.answer|not.answered|canceled|cancelled|disconnected)\b/.test(value);
}

function failureSignal(normalized) {
  const value = `${normalized.eventType || ''} ${normalized.status || ''} ${normalized.outcome || ''} ${normalized.failureReason || ''}`.toLowerCase().replace(/_/g, '-');
  return /\b(failed|failure|error|busy|voicemail|no-answer|not-answered|blocked|invalid|rejected|dnc)\b/.test(value);
}

function normalizeEventType(value) {
  return String(value || 'agentphone.webhook').trim().toLowerCase().replace(/_/g, '.');
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || null;
}
