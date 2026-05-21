import { calls, leads } from './db.js';
import { enqueueJob } from './jobs.js';
import { log } from './logger.js';
import { maybeFireInboundEmail } from './inboundIntent.js';
import { processInboundIntake } from './inboundIntake.js';
import { fireDemoFollowupEmail, isDemoModeCall, clearDemoModeCall } from './demoMode.js';
import { persistInboundSummary } from './inboundMemory.js';

export const INBOUND_VOICE_FOLLOWUP_JOB_TYPE = 'inbound.voice_followup';

export function enqueueInboundVoiceFollowup({
  callId,
  leadId = null,
  transcript = [],
  eventId = null,
  stage = 'partial',
  fromPhone = null,
  overrideEmail = null,
  outcome = null,
  source = 'agentphone.webhook',
  writeMemory = true,
  runAt = Date.now(),
  maxAttempts = 5
} = {}) {
  if (!callId) throw new Error('callId is required for inbound voice follow-up');
  const normalizedStage = stage === 'terminal' ? 'terminal' : 'partial';
  const payload = {
    callId,
    leadId,
    transcript: Array.isArray(transcript) ? transcript : [],
    eventId,
    stage: normalizedStage,
    fromPhone,
    overrideEmail,
    outcome,
    source,
    writeMemory: writeMemory !== false
  };
  const idempotencyKey = `inbound-voice:${callId}:${normalizedStage}:${eventId || 'event'}`;
  return enqueueJob({
    type: INBOUND_VOICE_FOLLOWUP_JOB_TYPE,
    payload,
    idempotencyKey,
    runAt,
    maxAttempts
  });
}

export async function handleInboundVoiceFollowupJob(payload = {}) {
  const callId = payload.callId;
  if (!callId) return { ok: false, skipped: true, reason: 'missing_callId' };
  const callRow = calls.get(callId);
  if (!callRow) return { ok: false, skipped: true, reason: 'call_not_found', callId };
  const lead = callRow.lead_id ? leads.get(callRow.lead_id) : (payload.leadId ? leads.get(payload.leadId) : null);
  const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
  const stage = payload.stage === 'terminal' ? 'terminal' : 'partial';
  const fromPhone = payload.fromPhone || callRow.to_phone || lead?.phone || null;
  const result = {
    ok: true,
    callId,
    leadId: lead?.id || callRow.lead_id || null,
    stage,
    email: null,
    intake: null,
    demoFollowup: null,
    memory: null
  };

  result.intake = await processInboundIntake({
    channel: 'voice',
    fromPhone,
    transcript,
    callRow,
    lead,
    eventId: payload.eventId || `${callId}:${stage}`,
    stage,
    writeMemory: payload.writeMemory !== false,
    createQuote: stage === 'terminal',
    sendAutoReply: stage === 'terminal'
  });

  if (stage === 'terminal') {
    if (isDemoModeCall(callRow.id)) {
      result.demoFollowup = await fireDemoFollowupEmail({ callRow, transcript });
      clearDemoModeCall(callRow.id);
    }
    if (payload.writeMemory !== false) {
      result.memory = await persistInboundSummary({
        callRow,
        lead: result.intake?.lead || lead,
        transcript,
        outcome: payload.outcome || null
      });
    }
  }

  result.email = await maybeFireInboundEmail({
    callRow,
    lead: result.intake?.lead || lead,
    transcript,
    overrideEmail: payload.overrideEmail || null,
    throwOnFailure: true
  });

  log.info('inbound.voice_followup.completed', {
    callId,
    leadId: result.leadId,
    stage,
    emailSent: !!result.email,
    intakeLeadId: result.intake?.leadId || result.intake?.lead?.id || null
  });
  return result;
}
