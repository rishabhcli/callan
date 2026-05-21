// Live-operator warm-transfer for in-progress AgentPhone calls.
//
// Triggered when the on-call LLM transcript signals high human-intent
// ("can I talk to a human", "transfer me", "speak to a manager") or a
// strong objection it can't handle. Both the inbound webhook handler
// (server/webhooks/agentphone.js) and the outbound caller worker
// (server/workers/caller.js) call into this module after their transcript
// streaming loops emit `caller.transcript`.
//
// The shared dedupe set guarantees a single transfer per call across both
// paths. When OPERATOR_TRANSFER_NUMBER is unset the transfer is a no-op
// that emits `caller.transfer_unavailable`.

import { env } from './env.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { transferAgentPhoneCall, updateAgentPhoneAgent } from './providers/agentphone.js';
import { createHandoffCaseFromCallTransfer } from './handoff.js';

export const OPERATOR_TRANSFER_NUMBER = process.env.OPERATOR_TRANSFER_NUMBER || '';

// Phrases the user might say when they want a live human on the line.
const HUMAN_INTENT_PATTERNS = [
  /\b(speak (to|with) (a|the) (human|manager|real person|operator))\b/i,
  /\b(transfer|connect) me\b/i,
  /\b(human|live) (agent|person)\b/i,
  /\bcan i (talk|speak) to someone\b/i
];

// Strong objection signals — flag so downstream can decide whether to
// warm-transfer. We don't track whether the agent has already countered
// these, so we surface them and let the caller gate via OPERATOR_TRANSFER_NUMBER.
const OBJECTION_PATTERNS = [
  /\b(i need to think|this is too expensive|i can'?t afford|too pricey|too much money)\b/i
];

const CONSENT_UNCERTAINTY_PATTERNS = [
  /\bdid(?:n'?t| not)\s+consent\b/i,
  /\bdo\s+not\s+record\b/i,
  /\bstop\s+recording\b/i,
  /\bare\s+you\s+recording\b/i,
  /\bwhere\s+did\s+you\s+get\s+my\s+number\b/i,
  /\bhow\s+did\s+you\s+get\s+my\s+number\b/i,
  /\btake\s+me\s+off\s+(?:your\s+)?call\s+list\b/i
];

// Per-process dedupe so we never warm-transfer the same call twice — keyed by
// the internal callRow.id (preferred) or the provider call id as a fallback.
// Exported so both the webhook handler and the outbound worker share the set.
export const transferredCallIds = new Set();

// Cache so ensureOperatorTransferConfigured() only PATCHes the agent record once.
let _operatorAgentPatched = false;

export function shouldTransfer(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return { transfer: false, reason: null };
  }
  // Scan the most-recent six turns from the user/caller side only — the
  // agent's own utterances should not trip our regexes.
  const tail = transcript.slice(-6);
  for (const turn of tail) {
    if (!turn || typeof turn.text !== 'string') continue;
    const role = String(turn.role || '').toLowerCase();
    if (role && role !== 'user' && role !== 'caller' && role !== 'human') continue;
    const text = turn.text;
    for (const rx of HUMAN_INTENT_PATTERNS) {
      const m = text.match(rx);
      if (m) return { transfer: true, reason: `human_intent:${m[0].toLowerCase()}` };
    }
    for (const rx of CONSENT_UNCERTAINTY_PATTERNS) {
      const m = text.match(rx);
      if (m) return { transfer: true, reason: `uncertain_consent:${m[0].toLowerCase()}` };
    }
    for (const rx of OBJECTION_PATTERNS) {
      const m = text.match(rx);
      if (m) return { transfer: true, reason: `objection:${m[0].toLowerCase()}` };
    }
  }
  return { transfer: false, reason: null };
}

export async function transferCallToOperator({ providerCallId, leadId, callId, reason } = {}) {
  const dedupeKey = callId || providerCallId;
  if (!dedupeKey) {
    log.warn('operator.transfer.missing_call_id', { providerCallId, leadId, reason });
    return { transferred: false, reason: 'missing_call_id' };
  }
  if (transferredCallIds.has(dedupeKey)) {
    return { transferred: false, reason: 'already_transferred' };
  }
  // Mark BEFORE awaiting the SDK so concurrent webhook + outbound paths can't
  // both fire a transfer for the same call.
  transferredCallIds.add(dedupeKey);

  const handoff = createHandoffCaseFromCallTransfer({
    leadId,
    callId,
    providerCallId,
    reason
  });

  emit('caller.transfer_requested', {
    worker: 'caller',
    leadId,
    callId,
    providerCallId,
    reason,
    handoffCaseId: handoff?.case?.id || null,
    to: OPERATOR_TRANSFER_NUMBER ? maskTail(OPERATOR_TRANSFER_NUMBER) : null
  });

  if (!OPERATOR_TRANSFER_NUMBER) {
    log.info('operator.transfer.unavailable', { leadId, callId, providerCallId, reason });
    emit('caller.transfer_unavailable', {
      worker: 'caller',
      leadId,
      callId,
      providerCallId,
      reason,
      detail: 'OPERATOR_TRANSFER_NUMBER not set'
    });
    return { transferred: false, reason: 'not_configured' };
  }

  if (!providerCallId) {
    log.warn('operator.transfer.no_provider_call_id', { leadId, callId, reason });
    emit('caller.transfer_failed', {
      worker: 'caller',
      leadId,
      callId,
      providerCallId,
      reason,
      error: 'no_provider_call_id'
    });
    return { transferred: false, reason: 'no_provider_call_id' };
  }

  try {
    const result = await transferAgentPhoneCall(providerCallId, OPERATOR_TRANSFER_NUMBER);
    log.info('operator.transfer.succeeded', { leadId, callId, providerCallId, reason });
    emit('caller.transfer_succeeded', {
      worker: 'caller',
      leadId,
      callId,
      providerCallId,
      reason,
      to: maskTail(OPERATOR_TRANSFER_NUMBER)
    });
    return { transferred: true, result };
  } catch (err) {
    // Clear the dedupe on hard failure so a later turn can retry. (The most
    // common failure is the call already ending — that's terminal, so the
    // retry will just no-op against a closed call.)
    transferredCallIds.delete(dedupeKey);
    const error = err?.message || String(err);
    log.warn('operator.transfer.failed', { leadId, callId, providerCallId, reason, error });
    emit('caller.transfer_failed', {
      worker: 'caller',
      leadId,
      callId,
      providerCallId,
      reason,
      error
    });
    return { transferred: false, reason: 'transfer_api_failed', error };
  }
}

// Boot-time helper: PATCH the platform agent so AgentPhone has a default
// transferNumber it can use for any future transfer requests. Cached so we
// only PATCH on the first boot after env changes — subsequent boots no-op.
export async function ensureOperatorTransferConfigured() {
  if (_operatorAgentPatched) return { patched: false, reason: 'already_patched' };
  if (!OPERATOR_TRANSFER_NUMBER) return { patched: false, reason: 'not_configured' };
  const agentId = env.agentphone?.agentId;
  if (!agentId) {
    log.info('operator.transfer.skip_agent_patch', { reason: 'no_agent_id_in_env' });
    return { patched: false, reason: 'no_agent_id' };
  }
  if (!env.agentphone?.apiKey) {
    log.info('operator.transfer.skip_agent_patch', { reason: 'no_api_key' });
    return { patched: false, reason: 'no_api_key' };
  }
  try {
    await updateAgentPhoneAgent(agentId, { transferNumber: OPERATOR_TRANSFER_NUMBER });
    _operatorAgentPatched = true;
    log.info('operator.transfer.agent_configured', {
      agentId,
      transferNumber: maskTail(OPERATOR_TRANSFER_NUMBER)
    });
    return { patched: true };
  } catch (err) {
    log.warn('operator.transfer.agent_configure_failed', {
      agentId,
      error: err?.message || String(err)
    });
    return { patched: false, reason: 'patch_failed', error: err?.message || String(err) };
  }
}

function maskTail(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `***${digits.slice(-4)}`;
}
