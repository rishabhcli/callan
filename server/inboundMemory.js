/**
 * Cross-call memory for inbound callers.
 *
 * - On call.started: look up prior call_log / call_summary docs by phone and
 *   surface what we know (name, email, business, last ask). Personalize the
 *   agent's beginMessage so returning callers are greeted by name.
 * - On call.ended: write a structured call_summary doc to Supermemory so the
 *   NEXT inbound call has it.
 *
 * Limitation: AgentPhone hosted mode locks in the system prompt at call setup.
 * We mutate the agent's beginMessage just before/during call.started — the
 * existing call may or may not pick it up, but subsequent calls always will.
 * After the call ends we restore the default greeting.
 */

import { env } from './env.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { addDoc, containerTagFor, search } from './memory.js';
import { calls } from './db.js';
import { updateAgentPhoneAgent } from './providers/agentphone.js';

const DEFAULT_BEGIN_MESSAGE = "Hey, this is Callan over at callmemaybe — who am I talking to?";

const inFlightGreetings = new Map(); // callId -> { personalized: boolean }

const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const NAME_TURN_RX = /(?:my name is|i['’]m|this is|it['’]s|name['’]s)\s+([a-z][a-z'-]{1,40})/i;
const BUSINESS_RX = /(?:i run|i own|i'?m with|my (?:business|shop|company|store)(?: is)?(?: called)?|we'?re|i work at|over at)\s+([a-z0-9 &'\-]{2,60})/i;

function firstMatch(text, rx) {
  if (!text) return null;
  const m = String(text).match(rx);
  return m?.[1]?.trim() || null;
}

function extractFactsFromTranscript(turns) {
  const list = Array.isArray(turns) ? turns : turns?.turns || [];
  const userTurns = list.filter((t) => t && (t.role === 'user' || t.role === 'caller' || t.role === 'human'));
  const joinedUser = userTurns.map((t) => String(t.text || '')).join('\n');
  return {
    name: firstMatch(joinedUser, NAME_TURN_RX),
    email: joinedUser.match(EMAIL_RX)?.[0]?.toLowerCase() || null,
    business: firstMatch(joinedUser, BUSINESS_RX),
    firstLine: userTurns[0]?.text || null,
    turnCount: list.length
  };
}

/**
 * Search Supermemory for prior context for this caller, summarize it.
 */
export async function priorContextForLead(lead, fromNumber) {
  if (!lead?.id) return null;
  const containerTag = containerTagFor(lead.id);
  const query = `inbound caller previous calls ${fromNumber || ''}`.trim();
  try {
    const hits = await search(containerTag, query, { limit: 5 });
    if (!hits?.length) return null;
    // Try to pull a structured inbound summary; fall back to the freshest hit.
    const summaryHit = hits.find((h) => h.metadata?.kindHint === 'inbound_call_summary')
                    || hits.find((h) => h.metadata?.kind === 'call_analysis')
                    || hits[0];
    const meta = summaryHit?.metadata || {};
    return {
      name: meta.callerName || meta.name || lead.business_name?.replace(/^Inbound caller .*/, '')?.trim() || null,
      email: meta.callerEmail || meta.email || null,
      business: meta.business || meta.businessName || null,
      lastAsk: meta.lastAsk || summaryHit?.summary || null,
      lastSeen: meta.endedAt || meta.ts || null,
      hitCount: hits.length
    };
  } catch (err) {
    log.warn('inbound.memory.search_failed', { leadId: lead.id, error: err?.message || String(err) });
    return null;
  }
}

/**
 * On call.started for an inbound: look up prior context and personalize the greeting.
 */
export async function hydrateInboundCall({ callRow, lead, fromNumber }) {
  if (!lead?.id) return null;
  const context = await priorContextForLead(lead, fromNumber);

  emit('caller.context_loaded', {
    worker: 'caller',
    leadId: lead.id,
    callId: callRow?.id,
    fromNumber,
    context,
    returning: !!(context?.name || context?.email || context?.business || context?.hitCount)
  });

  if (!context?.name && !context?.business) return context;

  // Personalize the greeting. We try to land this PATCH before AgentPhone's hosted
  // LLM begins speaking the begin message. If it misses this call, the next one
  // catches it. We restore on call.ended to keep the static greeting clean.
  const firstName = context.name?.split(/\s+/)[0] || null;
  const personalized = firstName
    ? `Hey ${firstName}, this is Callan over at callmemaybe — good to hear from you again. What's on your mind?`
    : `Hey — this is Callan over at callmemaybe. Glad you called back. What's going on?`;

  try {
    await updateAgentPhoneAgent(env.agentphone.agentId, { beginMessage: personalized });
    inFlightGreetings.set(callRow.id, { personalized: true, restoredAt: null });
    log.info('inbound.memory.personalized_greeting', {
      callId: callRow.id, leadId: lead.id, firstName: firstName || null
    });
  } catch (err) {
    log.warn('inbound.memory.personalize_failed', {
      callId: callRow.id, error: err?.message || String(err)
    });
  }
  return context;
}

/**
 * On call.ended: write a structured call_summary doc + restore the default greeting.
 */
export async function persistInboundSummary({ callRow, lead, transcript, outcome }) {
  if (!callRow || !lead?.id) return null;
  const turns = Array.isArray(transcript) ? transcript : transcript?.turns || [];
  const facts = extractFactsFromTranscript(turns);
  const summaryText = buildSummaryText({ facts, callRow, lead, outcome });

  try {
    const doc = await addDoc(containerTagFor(lead.id), 'call_analysis', summaryText, {
      kindHint: 'inbound_call_summary',
      callId: callRow.id,
      providerCallId: callRow.provider_call_id,
      callerName: facts.name,
      callerEmail: facts.email,
      business: facts.business,
      lastAsk: facts.firstLine,
      fromPhone: callRow.to_phone || lead.phone || null,
      turnCount: facts.turnCount,
      outcome: outcome || null,
      endedAt: Date.now(),
      direction: 'inbound'
    });
    emit('caller.summary_saved', {
      worker: 'memory',
      leadId: lead.id,
      callId: callRow.id,
      callerName: facts.name,
      callerEmail: facts.email,
      business: facts.business,
      docId: doc?.id || null
    });
    return { facts, doc };
  } catch (err) {
    log.warn('inbound.memory.summary_failed', {
      callId: callRow.id, leadId: lead.id, error: err?.message || String(err)
    });
    return null;
  } finally {
    // Always restore the default greeting so the next NEW caller doesn't get
    // someone else's personalized line.
    if (inFlightGreetings.has(callRow.id)) {
      inFlightGreetings.delete(callRow.id);
      try {
        await updateAgentPhoneAgent(env.agentphone.agentId, { beginMessage: DEFAULT_BEGIN_MESSAGE });
      } catch (err) {
        log.warn('inbound.memory.greeting_restore_failed', {
          callId: callRow.id, error: err?.message || String(err)
        });
      }
    }
  }
}

function buildSummaryText({ facts, callRow, lead, outcome }) {
  const lines = [];
  if (facts.name) lines.push(`Caller name: ${facts.name}`);
  if (facts.email) lines.push(`Caller email: ${facts.email}`);
  if (facts.business) lines.push(`Caller business: ${facts.business}`);
  if (callRow.to_phone || lead.phone) lines.push(`Phone: ${callRow.to_phone || lead.phone}`);
  if (facts.firstLine) lines.push(`Opening line: ${facts.firstLine}`);
  if (outcome) lines.push(`Outcome: ${outcome}`);
  lines.push(`Turn count: ${facts.turnCount}`);
  return lines.join('\n');
}
