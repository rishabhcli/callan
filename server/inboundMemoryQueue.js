import { calls, leads } from './db.js';
import { enqueueJob } from './jobs.js';
import { hydrateInboundCall } from './inboundMemory.js';

export const INBOUND_MEMORY_HYDRATE_JOB_TYPE = 'inbound.memory_hydrate';

export function enqueueInboundMemoryHydration({
  callId,
  leadId = null,
  fromNumber = null,
  source = 'agentphone.webhook',
  eventId = null,
  runAt = Date.now(),
  maxAttempts = 3
} = {}) {
  if (!callId) throw new Error('callId is required for inbound memory hydration');
  return enqueueJob({
    type: INBOUND_MEMORY_HYDRATE_JOB_TYPE,
    payload: {
      callId,
      leadId,
      fromNumber,
      source,
      eventId
    },
    idempotencyKey: `inbound-memory:${callId}`,
    runAt,
    maxAttempts
  });
}

export async function handleInboundMemoryHydrationJob(payload = {}) {
  const callId = payload.callId;
  if (!callId) return { ok: false, skipped: true, reason: 'missing_callId' };
  const callRow = calls.get(callId);
  if (!callRow) return { ok: false, skipped: true, reason: 'call_not_found', callId };
  const lead = callRow.lead_id ? leads.get(callRow.lead_id) : (payload.leadId ? leads.get(payload.leadId) : null);
  if (!lead) return { ok: false, skipped: true, reason: 'lead_not_found', callId, leadId: payload.leadId || callRow.lead_id || null };
  const context = await hydrateInboundCall({
    callRow,
    lead,
    fromNumber: payload.fromNumber || callRow.to_phone || lead.phone || null
  });
  return {
    ok: true,
    callId,
    leadId: lead.id,
    returning: !!(context?.name || context?.email || context?.business || context?.hitCount),
    context
  };
}
