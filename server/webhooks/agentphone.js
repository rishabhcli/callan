import crypto from 'node:crypto';
import { env } from '../env.js';
import { log } from '../logger.js';
import { calls, db, leads, webhookEvents } from '../db.js';
import { emit } from '../sse.js';
import { addDoc, containerTagFor } from '../memory.js';
import { recordOptOut, transcriptHasOptOut, normalizePhone } from '../compliance.js';
import {
  classifyAgentPhoneFailure,
  endAgentPhoneCall,
  fetchAgentPhoneFinalTranscript,
  normalizeAgentPhoneTranscript
} from '../providers/agentphone.js';
import { maybeFireInboundEmail } from '../inboundIntent.js';
import { hydrateInboundCall, persistInboundSummary } from '../inboundMemory.js';
import { startInboundCallerResearch, maybeKickOffBusinessResearch } from '../inboundResearch.js';
import { maybeMarkDemoMode, isDemoModeCall, clearDemoModeCall, fireDemoFollowupEmail } from '../demoMode.js';
import { shouldTransfer, transferCallToOperator, OPERATOR_TRANSFER_NUMBER } from '../operatorTransfer.js';
import { getCallbackContext } from '../emailCallback.js';
import { recordAgentPhoneCallCost } from '../costs.js';

const AGENTPHONE_REPLAY_WINDOW_SECONDS = 300;

// AgentPhone webhook security per provider docs:
// X-Webhook-Signature = sha256=<hex HMAC>
// X-Webhook-Timestamp = Unix timestamp used for replay protection
// X-Webhook-ID = unique delivery id used for idempotency
// The signed string is `${timestamp}.${raw_body}`.
export function verifyAgentPhone(req, rawBody) {
  if (!env.agentphone.webhookSecret) {
    log.warn('AGENTPHONE_WEBHOOK_SECRET not set; rejecting webhook');
    return { ok: false, reason: 'no secret configured' };
  }

  const sig = String(req.headers['x-webhook-signature'] || req.headers['x-signature-256'] || '').trim();
  const ts = String(req.headers['x-webhook-timestamp'] || '').trim();
  const webhookId = String(req.headers['x-webhook-id'] || '').trim();
  const timestamp = parseAgentPhoneTimestamp(ts);
  const provided = pickHex(sig);
  if (!provided) return { ok: false, reason: 'no signature header' };
  if (!timestamp) return { ok: false, reason: 'missing or invalid X-Webhook-Timestamp' };
  if (Math.abs(Date.now() - timestamp) > AGENTPHONE_REPLAY_WINDOW_SECONDS * 1000) {
    return { ok: false, reason: 'timestamp outside replay window' };
  }
  if (!webhookId) return { ok: false, reason: 'missing X-Webhook-ID' };

  const secret = env.agentphone.webhookSecret;
  const raw = rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest();
  if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
    return { ok: true, webhookId, replayWindowSeconds: AGENTPHONE_REPLAY_WINDOW_SECONDS };
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

  let callRow = findCallRow(normalized.providerCallId || normalized.internalCallId);
  let bootstrappedInbound = false;
  if (!callRow && isInboundCall(normalized)) {
    callRow = ensureInboundCallRow(normalized);
    bootstrappedInbound = !!callRow;
  }
  if (bootstrappedInbound && callRow?.lead_id) {
    const lead = leads.get(callRow.lead_id);
    // Fire-and-forget — hydrate looks up Supermemory + (maybe) personalizes greeting.
    hydrateInboundCall({ callRow, lead, fromNumber: normalized.fromNumber })
      .catch((err) => log.warn('inbound.memory.hydrate_failed', {
        callId: callRow.id, error: err?.message || String(err)
      }));
    // Light up the dashboard's Scraper box with a 5-lane synthetic research burst
    // keyed off the caller's phone. Looks like we're actively probing them.
    startInboundCallerResearch({ callRow, lead, fromNumber: normalized.fromNumber });
  }
  if (!callRow) {
    log.warn('agentphone.webhook.call_missing', { eventType: normalized.eventType, providerCallId: normalized.providerCallId, direction: normalized.direction });
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

  // Live operator warm-transfer: scan the latest merged turns for human-intent
  // or strong-objection signals. Per-call dedupe lives in operatorTransfer.js,
  // so it's safe to fire on every webhook tick.
  if (!normalized.terminal && OPERATOR_TRANSFER_NUMBER) {
    const mergedForTransfer = mergeTurns(
      normalizeAgentPhoneTranscript(parseTranscript(callRow.transcript_json)),
      turns
    );
    const decision = shouldTransfer(mergedForTransfer);
    if (decision.transfer) {
      transferCallToOperator({
        providerCallId: callRow.provider_call_id,
        leadId: callRow.lead_id,
        callId: callRow.id,
        reason: decision.reason
      }).catch((err) => log.warn('operator.transfer.webhook_failed', {
        callId: callRow.id,
        providerCallId: callRow.provider_call_id,
        error: err?.message || String(err)
      }));
    }
  }

  // Inbound calls AND email-callbacks: if the transcript reveals a send-intent,
  // fire AgentMail. Hosted-LLM Callan can verbally promise "I'll email you" but
  // has no hands — this gives it hands.
  //   - agentphone_inbound: extract recipient email from transcript
  //   - agentphone_email_callback: the recipient is already known (the address
  //     they emailed us from); we look it up via getCallbackContext.
  if (callRow.decision_reason === 'agentphone_inbound' || callRow.decision_reason === 'agentphone_email_callback') {
    const merged = mergeTurns(
      normalizeAgentPhoneTranscript(parseTranscript(callRow.transcript_json)),
      turns
    );
    const lead = callRow.lead_id ? leads.get(callRow.lead_id) : null;
    const overrideEmail = callRow.decision_reason === 'agentphone_email_callback'
      ? getCallbackContext(callRow.provider_call_id)?.fromEmail || null
      : null;
    maybeFireInboundEmail({ callRow, lead, transcript: merged, overrideEmail }).catch((err) => {
      log.warn('inbound.email.fire_failed', { callId: callRow.id, error: err?.message || String(err) });
    });

    // "Enter Demo Mode" trigger — only on inbound. Demo mode persona switch
    // only makes sense when we receive a call.
    if (callRow.decision_reason === 'agentphone_inbound') {
      maybeMarkDemoMode({ callRow, transcript: merged });
    }

    // Mine the latest user turns for a business mention; kick off a real research
    // job against it. De-duped per call so we only fire once.
    const businessHit = extractBusinessMention(merged);
    if (businessHit) {
      maybeKickOffBusinessResearch({ callRow, businessName: businessHit.name, city: businessHit.city })
        .catch((err) => log.warn('inbound.research.kick_off_failed', {
          callId: callRow.id, error: err?.message || String(err)
        }));
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
  try {
    const finishedRow = calls.get(callRow.id) || callRow;
    const durationSeconds = resolveCallDurationSeconds(normalized, finishedRow);
    if (callRow.lead_id && durationSeconds > 0) {
      recordAgentPhoneCallCost({ leadId: callRow.lead_id, durationSeconds, callId: callRow.id });
    }
  } catch (err) {
    log.warn('agentphone.webhook.cost_record_failed', { callId: callRow.id, error: err?.message || String(err) });
  }
  await safeAddCallMemory(callRow, finalTranscript || normalized.transcript, outcome);

  // Last chance to fire the follow-up email — final transcript may contain
  // the email or send-intent when the streaming chunks didn't. Also persist
  // the cross-call summary.
  if ((callRow.decision_reason === 'agentphone_inbound' || callRow.decision_reason === 'agentphone_email_callback') && !optedOut) {
    const lead = callRow.lead_id ? leads.get(callRow.lead_id) : null;
    const finalTurns = normalizeAgentPhoneTranscript(finalTranscript || normalized.transcript);
    const overrideEmail = callRow.decision_reason === 'agentphone_email_callback'
      ? getCallbackContext(callRow.provider_call_id)?.fromEmail || null
      : null;
    // Demo trigger re-check only applies to inbound calls.
    if (callRow.decision_reason === 'agentphone_inbound') {
      maybeMarkDemoMode({ callRow, transcript: finalTurns });
    }
    await maybeFireInboundEmail({ callRow, lead, transcript: finalTurns, overrideEmail })
      .catch((err) => log.warn('inbound.email.terminal_fire_failed', {
        callId: callRow.id, error: err?.message || String(err)
      }));
    if (isDemoModeCall(callRow.id)) {
      await fireDemoFollowupEmail({ callRow, transcript: finalTurns })
        .catch((err) => log.warn('inbound.demo_mode.email_failed', {
          callId: callRow.id, error: err?.message || String(err)
        }));
      clearDemoModeCall(callRow.id);
    }
    persistInboundSummary({ callRow, lead, transcript: finalTurns, outcome })
      .catch((err) => log.warn('inbound.memory.persist_failed', {
        callId: callRow.id, error: err?.message || String(err)
      }));
  }

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
  const direction = firstText(body.direction, data.direction, call.direction);
  const fromNumber = firstText(body.fromNumber, body.from_number, body.from, data.fromNumber, data.from_number, data.from, call.fromNumber, call.from_number, call.from);
  const toNumber = firstText(body.toNumber, body.to_number, body.to, data.toNumber, data.to_number, data.to, call.toNumber, call.to_number, call.to);
  const terminal = isTerminalWebhook(eventType, status, outcome, failureReason);
  const durationSeconds = firstNumber(
    body.durationSeconds, body.duration_seconds, body.duration,
    data.durationSeconds, data.duration_seconds, data.duration,
    call.durationSeconds, call.duration_seconds, call.duration
  );
  const startedAt = firstNumber(
    body.startedAt, body.started_at,
    data.startedAt, data.started_at,
    call.startedAt, call.started_at
  );
  const endedAt = firstNumber(
    body.endedAt, body.ended_at,
    data.endedAt, data.ended_at,
    call.endedAt, call.ended_at
  );

  return {
    eventType,
    providerCallId,
    internalCallId: firstText(body.internalCallId, body.internal_call_id, data.internalCallId, data.internal_call_id),
    status,
    outcome,
    failureReason,
    transcript,
    direction,
    fromNumber,
    toNumber,
    terminal,
    durationSeconds,
    startedAt,
    endedAt,
    raw: body
  };
}

function isInboundCall(normalized = {}) {
  if (String(normalized.direction || '').toLowerCase() === 'inbound') return true;
  const ownedRaw = env.agentphone.fromNumber || '';
  if (!ownedRaw || !normalized.toNumber) return false;
  return normalizePhone(normalized.toNumber) === normalizePhone(ownedRaw);
}

function findLeadByPhone(phone) {
  if (!phone) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return db.prepare(`
    SELECT * FROM leads
    WHERE normalized_phone = ? OR phone = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(normalized, phone) || null;
}

function maskPhoneForName(phone) {
  if (!phone) return 'unknown';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return phone;
  return `${digits.slice(0, 1)}-XXX-XXX-${digits.slice(-4)}`;
}

function ensureInboundCallRow(normalized) {
  const fromNumber = normalized.fromNumber || null;
  const providerCallId = normalized.providerCallId || `inbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Already created this call row in a prior webhook event?
  const existingByProvider = providerCallId
    ? db.prepare(`SELECT * FROM calls WHERE provider_call_id = ? ORDER BY started_at DESC LIMIT 1`).get(providerCallId)
    : null;
  if (existingByProvider) return existingByProvider;

  // Find or create a lead for this inbound caller.
  let lead = findLeadByPhone(fromNumber);
  if (!lead) {
    const leadId = `lead_inbound_${Math.random().toString(36).slice(2, 10)}`;
    try {
      const ins = leads.insert({
        id: leadId,
        container_tag: `lead:${leadId}`,
        business_name: `Inbound caller ${maskPhoneForName(fromNumber)}`,
        phone: fromNumber || null,
        address: null,
        niche: 'inbound',
        city: null,
        website: null,
        status: 'inbound',
        research_status: 'inbound',
        outreach_status: 'inbound',
        risk_status: 'inbound_unknown',
        consent_status: 'inbound',
        next_action: 'live_inbound',
        source_url: null
      });
      lead = ins.lead;
    } catch (err) {
      log.error('agentphone.inbound.lead_create_failed', { error: err?.message || String(err), fromNumber });
      return null;
    }
  } else {
    leads.update?.(lead.id, { next_action: 'live_inbound', outreach_status: 'inbound' });
  }
  if (!lead) return null;

  // Create the call row.
  const callId = `call_inbound_${Math.random().toString(36).slice(2, 12)}`;
  try {
    calls.start({
      id: callId,
      lead_id: lead.id,
      to_phone: fromNumber, // from the agent's perspective, this is the live caller's number
      provider_call_id: providerCallId,
      disclosure_text: null,
      decision_reason: 'agentphone_inbound'
    });
  } catch (err) {
    log.error('agentphone.inbound.call_start_failed', { error: err?.message || String(err), providerCallId });
    return null;
  }

  emit('caller.placed', {
    worker: 'caller',
    leadId: lead.id,
    callId,
    providerCallId,
    direction: 'inbound',
    fromNumber,
    toNumber: normalized.toNumber || env.agentphone.fromNumber || null,
    mock: false,
    source: 'webhook_inbound'
  });
  emit('caller.inbound', {
    worker: 'caller',
    leadId: lead.id,
    callId,
    providerCallId,
    fromNumber,
    toNumber: normalized.toNumber || env.agentphone.fromNumber || null
  });

  log.info('agentphone.inbound.bootstrapped', { callId, leadId: lead.id, fromNumber, providerCallId });
  return calls.get(callId);
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

function parseAgentPhoneTimestamp(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const millis = n > 10_000_000_000 ? n : n * 1000;
  return Number.isFinite(millis) ? millis : null;
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

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function resolveCallDurationSeconds(normalized, callRow) {
  // Provider-supplied duration wins (avoids clock skew). Fall back to
  // payload startedAt/endedAt → call row started_at/ended_at.
  if (Number.isFinite(normalized?.durationSeconds) && normalized.durationSeconds > 0) {
    return Math.round(normalized.durationSeconds);
  }
  const startedFromPayload = toMs(normalized?.startedAt);
  const endedFromPayload = toMs(normalized?.endedAt);
  if (startedFromPayload && endedFromPayload && endedFromPayload >= startedFromPayload) {
    return Math.round((endedFromPayload - startedFromPayload) / 1000);
  }
  const started = Number(callRow?.started_at) || 0;
  const ended = Number(callRow?.ended_at) || 0;
  if (started && ended && ended >= started) {
    return Math.round((ended - started) / 1000);
  }
  return 0;
}

function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Heuristic: anything below ~10^11 looks like seconds; otherwise milliseconds.
  return n < 10_000_000_000 ? n * 1000 : n;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || null;
}

// Capture up to a sentence break, a continuation word ("in", "and", "can"...), or punctuation.
const BUSINESS_MENTION_RX = /(?:i (?:own|run|work at)|my (?:business|shop|company|store)(?: is)?(?: called)?|over at|we'?re|i'?m with)\s+([a-z0-9][^.,;!?\n]{2,60}?)(?=\s+(?:in|near|over|on|and|or|but|so|because|can|could|would|will|please|right)\b|[.,;!?\n]|$)/i;
const CITY_HINT_RX = /\bin\s+([a-z][a-z .'-]{2,40}?)(?=[,.\n]|\s+(?:and|or|but|because|so|can|could|would|will|—)\b|$)/i;
const BUSINESS_STOPWORDS = new Set(['the', 'a', 'an', 'good', 'great', 'a small', 'a little', 'something']);

function extractBusinessMention(turns) {
  if (!Array.isArray(turns)) return null;
  const userText = turns
    .filter((t) => t && (t.role === 'user' || t.role === 'caller' || t.role === 'human'))
    .slice(-10)
    .map((t) => String(t.text || ''))
    .join('\n');
  if (!userText.trim()) return null;
  const m = userText.match(BUSINESS_MENTION_RX);
  if (!m) return null;
  const raw = m[1].trim().replace(/[.,;!?]+$/, '');
  if (BUSINESS_STOPWORDS.has(raw.toLowerCase())) return null;
  if (raw.length < 3) return null;
  const cityMatch = userText.match(CITY_HINT_RX);
  return {
    name: raw,
    city: cityMatch ? cityMatch[1].trim() : null
  };
}
