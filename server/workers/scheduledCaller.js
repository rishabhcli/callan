/**
 * Scheduled-callback dispatcher: invoked by the scheduledCalls loop when a row
 * becomes due. Builds a brief, hands a per-call pitch to runCaller, and reports
 * the resulting call id back to the loop for status persistence.
 */

import { log } from '../logger.js';
import { leads } from '../db.js';
import { search as memorySearch, containerTagFor } from '../memory.js';
import { briefToPitch } from '../briefToPitch.js';
import { runCaller } from './caller.js';
import { env } from '../env.js';
import { classifyAgentPhoneFailure } from '../providers/agentphone.js';

function parseBrief(briefJson) {
  if (!briefJson) return {};
  try { return JSON.parse(briefJson); } catch { return {}; }
}

async function fetchPriorCallSummary(leadId) {
  if (!leadId) return null;
  try {
    const containerTag = containerTagFor(leadId);
    const hits = await memorySearch(containerTag, 'previous inbound call summary', { limit: 3, kind: 'call_analysis' });
    if (!hits?.length) return null;
    const best = hits.find((h) => h.metadata?.kindHint === 'inbound_call_summary') || hits[0];
    const summary = best?.summary || best?.content || (best?.chunks?.[0]?.content) || null;
    if (!summary) return null;
    return String(summary).slice(0, 600);
  } catch (err) {
    log.warn('scheduledCaller.prior_summary_failed', { leadId, error: err?.message || String(err) });
    return null;
  }
}

/**
 * @param {object} row  scheduled_calls row
 * @returns {Promise<{call_id: string|null, failure: string|null}>}
 */
function permanentScheduledFailure(reason) {
  return /\b(lead_not_found|lead_has_no_phone|call refused|dnc:|invalid-number|blocked|auth)\b/i.test(String(reason || ''));
}

export async function runScheduledCaller(row, { callerFn = runCaller } = {}) {
  const lead = leads.get(row.lead_id);
  if (!lead) return { call_id: null, failure: 'lead_not_found' };
  if (!lead.phone) return { call_id: null, failure: 'lead_has_no_phone' };

  const briefData = parseBrief(row.brief_json);
  const priorCallSummary = await fetchPriorCallSummary(row.lead_id);

  const brief = {
    callerName: briefData.callerName || lead.business_name,
    business: briefData.business || lead.business_name,
    ask: briefData.ask || briefData.askSummary || 'what you asked about in your email',
    emailExcerpt: briefData.emailExcerpt || briefData.replySnippet || null,
    priorCallSummary,
    scheduledAtRaw: briefData.scheduledAtRaw || null,
    scheduledAtMs: row.scheduled_at_ms,
    fromPhone: lead.phone,
    timezone: briefData.timezone || env.outreach?.timezone || 'America/Los_Angeles'
  };

  const pitch = briefToPitch(brief, { lead, profile: {} });

  try {
    const result = await callerFn({
      leadId: row.lead_id,
      toPhone: lead.phone,
      pitchOverride: pitch,
      source: 'scheduled',
      scheduledCallId: row.id
    });
    return { call_id: result?.callId || null, failure: result?.callId ? null : 'no_call_id_returned' };
  } catch (err) {
    const reason = err?.message || String(err);
    const failure = classifyAgentPhoneFailure(err);
    const wrapped = new Error(reason);
    wrapped.retryable = permanentScheduledFailure(reason) ? false : failure.retryable !== false;
    wrapped.category = failure.category || 'unknown';
    wrapped.reason = failure.reason || reason;
    log.error('scheduledCaller.runCaller_failed', {
      id: row.id,
      leadId: row.lead_id,
      error: reason,
      retryable: wrapped.retryable,
      category: wrapped.category
    });
    throw wrapped;
  }
}
