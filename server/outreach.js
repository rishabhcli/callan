import { callabilityForLead, normalizePhone, recordingDisclosure, recordCallDecision } from './compliance.js';
import { contactEvents, leads } from './db.js';
import { env } from './env.js';
import { emit } from './sse.js';
import { liveReadiness } from './readiness.js';
import { runCaller } from './workers/caller.js';

let timer = null;
let activeJob = null;

export function startOutreachLoop() {
  if (timer) return outreachStatus();
  timer = setInterval(() => {
    processOutreachBatch().catch((err) => {
      emit('outreach.error', { worker: 'caller', error: err?.message || String(err) });
    });
  }, env.outreach.intervalMs);
  processOutreachBatch().catch(() => {});
  emit('outreach.started', { mode: env.runMode, intervalMs: env.outreach.intervalMs });
  return outreachStatus();
}

export function stopOutreachLoop() {
  if (timer) clearInterval(timer);
  timer = null;
  emit('outreach.stopped', {});
  return outreachStatus();
}

export function outreachStatus() {
  return {
    running: !!timer,
    activeJob,
    readiness: liveReadiness()
  };
}

export function queueLeadForOutreach({ leadId, profile }) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  const strength = profile?.onlinePresenceStrength || 'mixed';
  const sourceUrl = profile?.sourceUrl || profile?.yelpUrl || lead.source_url || null;
  if (strength === 'strong') {
    leads.update(leadId, {
      research_status: 'complete',
      outreach_status: 'blocked',
      risk_status: 'strong_presence',
      consent_status: 'not_required',
      phone_classification: lead.phone_classification || 'business',
      next_action: 'do_not_call_strong_presence',
      source_url: sourceUrl
    });
    return { queued: false, reason: 'strong online presence' };
  }
  leads.update(leadId, {
    research_status: 'complete',
    outreach_status: 'queued',
    risk_status: 'needs_callability_check',
    consent_status: env.runMode === 'demo_live' ? 'operator_owned' : 'public_business',
    phone_classification: classifyQueuedPhone({ lead, profile }),
    next_action: 'call',
    source_url: sourceUrl
  });
  return { queued: true, reason: 'weak or mixed online presence' };
}

export function approveLeadForLiveCall(leadId) {
  const lead = leads.get(leadId);
  if (!lead) return null;
  leads.update(leadId, {
    outreach_status: 'queued',
    risk_status: 'operator_approved',
    consent_status: 'operator_approved',
    phone_classification: 'allowed',
    next_action: 'call'
  });
  emit('outreach.lead_approved', { leadId, businessName: lead.business_name });
  return leads.get(leadId);
}

async function processOutreachBatch() {
  if (activeJob) return;
  const readiness = liveReadiness();
  if (env.runMode !== 'mock' && !readiness.ready) {
    emit('outreach.blocked', { blockers: readiness.blockers });
    return;
  }
  const batch = leads.listOutreachQueue({ limit: env.outreach.batchSize });
  if (!batch.length) return;

  for (const lead of batch) {
    activeJob = { leadId: lead.id, businessName: lead.business_name, startedAt: Date.now() };
    try {
      const disclosureText = recordingDisclosure(lead.business_name);
      const check = callabilityForLead({ lead, disclosureText });
      if (!check.ok) {
        recordCallDecision({
          leadId: lead.id,
          phone: lead.phone,
          allowed: false,
          reason: check.reason,
          disclosureText
        });
        leads.update(lead.id, {
          outreach_status: 'blocked',
          risk_status: check.reason,
          phone_classification: check.phoneClassification || lead.phone_classification || 'unknown',
          next_action: 'blocked'
        });
        emit('outreach.lead_blocked', { leadId: lead.id, businessName: lead.business_name, reason: check.reason });
        continue;
      }

      leads.update(lead.id, {
        outreach_status: 'calling',
        risk_status: 'callable',
        phone_classification: check.phoneClassification,
        last_contacted_at: Date.now(),
        next_action: 'call_in_progress'
      });
      contactEvents.add({
        lead_id: lead.id,
        type: 'call_queued',
        direction: 'outbound',
        channel: 'agentphone',
        body: check.reason,
        metadata: { phoneClassification: check.phoneClassification }
      });
      emit('outreach.calling', { leadId: lead.id, businessName: lead.business_name, phoneClassification: check.phoneClassification });
      await runCaller({ leadId: lead.id, toPhone: check.phone });
      leads.update(lead.id, { outreach_status: 'called', next_action: 'await_analysis' });
    } catch (err) {
      leads.update(lead.id, { outreach_status: 'retry', risk_status: 'provider-failed', next_action: 'retry_call' });
      emit('outreach.error', { leadId: lead.id, businessName: lead.business_name, error: err?.message || String(err) });
    } finally {
      activeJob = null;
    }
  }
}

function classifyQueuedPhone({ lead, profile }) {
  const phone = normalizePhone(lead.phone || profile?.phone);
  if (phone && env.allowedPhones.includes(phone)) return 'allowed';
  if (lead.phone || profile?.phone) return profile?.sourceUrl || profile?.yelpUrl || lead.address ? 'business' : 'unknown';
  return 'invalid';
}
