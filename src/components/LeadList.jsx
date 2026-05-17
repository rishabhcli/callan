import React, { useState } from 'react';
import { api } from '../api.js';

function maskPhone(p) {
  if (!p) return '— · ——— · ——';
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 6) return p;
  const a = digits.slice(-10, -7) || digits.slice(0, 3);
  const tail = digits.slice(-2);
  return `${a} · ××× · ${tail}`;
}

function statusClass(s) {
  switch (s) {
    case 'discovered':       return 'st-neutral';
    case 'closing':          return 'st-running';
    case 'rejected':
    case 'unreachable':      return 'st-error';
    case 'callback':         return 'st-neutral';
    case 'awaiting_payment': return 'st-running';
    case 'paid':             return 'st-success';
    case 'building':         return 'st-running';
    case 'shipped':          return 'st-success';
    case 'blocked_auth':     return 'st-error';
    default:                 return 'st-neutral';
  }
}

const FALLBACK_EMAIL = 'owner@demo.callmemaybe.dev';
const PRESENCE_STRENGTHS = new Set(['none', 'weak', 'mixed', 'strong']);

function labelize(value) {
  return String(value || '').replace(/_/g, ' ');
}

function presenceStrength(lead) {
  const direct = lead.onlinePresenceStrength || lead.online_presence_strength || lead.presence_strength;
  const normalized = String(direct || '').toLowerCase();
  if (PRESENCE_STRENGTHS.has(normalized)) return normalized;
  if (lead.risk_status === 'strong_presence' || lead.risk_status === 'strong_online_presence') return 'strong';
  return null;
}

function presenceTone(strength) {
  if (strength === 'strong') return 'good';
  if (strength === 'mixed') return 'warn';
  if (strength === 'weak' || strength === 'none') return 'bad';
  return 'muted';
}

function callabilitySummary(lead) {
  const outreach = lead.outreach_status || 'not_queued';
  const risk = lead.risk_status || 'unknown';
  const phoneClass = lead.phone_classification || 'unknown';
  if (presenceStrength(lead) === 'strong' || risk === 'strong_presence' || risk === 'strong_online_presence') {
    return { text: 'not worth calling: strong presence already found', tone: 'bad' };
  }
  if (outreach === 'blocked') {
    return { text: `blocked: ${labelize(risk) || 'outreach gate'}`, tone: 'bad' };
  }
  if (risk === 'callable' || outreach === 'calling' || outreach === 'called') {
    return { text: `callable: ${labelize(phoneClass)} phone`, tone: 'good' };
  }
  if (outreach === 'queued' || outreach === 'retry') {
    return { text: `${labelize(outreach)}: ${labelize(risk || 'needs_callability_check')}`, tone: 'info' };
  }
  if (phoneClass === 'invalid') {
    return { text: 'blocked: invalid phone evidence', tone: 'bad' };
  }
  if (risk === 'needs_callability_check') {
    return { text: 'pending: callability check before dialing', tone: 'info' };
  }
  return { text: `research ${labelize(lead.research_status || 'new')}`, tone: 'muted' };
}

function buildStateForLead(lead) {
  const status = lead.build_status || lead.builder_status || lead.buildStatus || lead.build_state;
  if (status) return String(status);
  if (lead.status === 'shipped') return 'shipped';
  if (lead.status === 'paid') return 'building';
  return 'not_started';
}

function leadPipelineStages(lead) {
  const paid = lead.status === 'paid' || lead.status === 'shipped';
  const awaitingPayment = lead.status === 'awaiting_payment';
  const buildState = buildStateForLead(lead);
  const authNeeded = buildState === 'blocked_auth' || lead.next_action === 'builder_auth_needed';
  const shipped = lead.status === 'shipped' || buildState === 'completed' || buildState === 'shipped';
  const building = ['building', 'running', 'queued', 'starting'].includes(buildState);

  return [
    { label: 'pay', state: awaitingPayment ? 'active' : paid || shipped ? 'done' : 'idle' },
    { label: 'paid', state: paid || shipped ? 'done' : 'idle' },
    { label: authNeeded ? 'auth' : 'build', state: authNeeded ? 'bad' : building ? 'active' : shipped ? 'done' : paid ? 'active' : 'idle' },
    { label: 'ship', state: shipped ? 'done' : 'idle' }
  ];
}

function leadBadges(lead) {
  const out = [];
  const presence = presenceStrength(lead);
  const riskStatus = lead.risk_status || '';
  if (presence) {
    out.push({ text: `${presence} presence`, tone: presenceTone(presence) });
  }
  if (presence === 'strong') {
    out.push({ text: 'not worth calling', tone: 'bad' });
  }
  if (riskStatus.includes('handoff')) {
    out.push({ text: 'handoff', tone: 'warn' });
  }
  if ((lead.duplicate_count || 0) > 0) {
    out.push({ text: `${lead.duplicate_count} duplicate${lead.duplicate_count === 1 ? '' : 's'} merged`, tone: 'info' });
  }
  if (lead.next_action === 'operator_review_mail') {
    out.push({ text: 'unsupported ask', tone: 'bad' });
  }
  if (lead.risk_status && !['unknown', 'pending', 'needs_callability_check', 'callable', 'strong_presence', 'strong_online_presence', 'operator-handoff'].includes(lead.risk_status)) {
    out.push({ text: labelize(lead.risk_status), tone: lead.risk_status === 'strong_presence' ? 'bad' : 'warn' });
  }
  if (lead.phone_classification && !['unknown', 'business'].includes(lead.phone_classification)) {
    out.push({ text: labelize(lead.phone_classification), tone: lead.phone_classification === 'invalid' ? 'bad' : 'info' });
  }
  if (lead.outreach_status) out.push({ text: labelize(lead.outreach_status), tone: outreachTone(lead.outreach_status) });
  if (['paid', 'shipped'].includes(lead.status)) out.push({ text: lead.status, tone: 'good' });
  if (buildStateForLead(lead) === 'building') out.push({ text: 'building', tone: 'warn' });
  if (buildStateForLead(lead) === 'blocked_auth') out.push({ text: 'auth needed', tone: 'bad' });
  const seen = new Set();
  return out
    .filter((badge) => {
      const key = `${badge.text}:${badge.tone}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function outreachTone(status) {
  if (['blocked', 'retry'].includes(status)) return 'bad';
  if (['queued', 'calling', 'awaiting_payment'].includes(status)) return 'info';
  if (['paid', 'shipped', 'called'].includes(status)) return 'good';
  return 'muted';
}

export default function LeadList({ leads, queueCounts, focusedLeadId, onFocus, onChanged }) {
  const [actionId, setActionId] = useState(null);
  const [actionErr, setActionErr] = useState(null);
  const counts = queueCounts || {};

  async function act(action, leadId) {
    setActionId(`${leadId}:${action}`);
    setActionErr(null);
    try {
      if (action === 'call') await api.startCall(leadId);
      else if (action === 'approve') await api.approveLiveCall(leadId);
      else if (action === 'followup') await api.followup(leadId, FALLBACK_EMAIL);
      else if (action === 'build') await api.build(leadId);
      onChanged?.(leadId);
    } catch (e) {
      setActionErr(`${action} → ${e.message}`);
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="leadlist">
      <div className="leadlist-head">
        <div className="leadlist-title">
          <span className="hd">leads</span>
          <span className="hd-count mono">{String(leads.length).padStart(3, '0')}</span>
        </div>
        <div className="leadlist-queues mono" aria-label="outreach queue counts">
          <span>queued {counts.queued ?? 0}</span>
          <span>calling {counts.calling ?? 0}</span>
          <span>blocked {counts.blocked ?? 0}</span>
          <span>awaiting pay {counts.awaitingPayment ?? 0}</span>
          <span>replies {counts.repliesWaiting ?? 0}</span>
          <span>paid {counts.paid ?? 0}</span>
          <span>shipped {counts.shipped ?? 0}</span>
        </div>
      </div>
      <div className="leadlist-body">
        {leads.length === 0 && (
          <div className="leadlist-empty">no leads yet — discover above.</div>
        )}
        {leads.map((lead) => {
          const focused = focusedLeadId === lead.id;
          const badges = leadBadges(lead);
          const callability = callabilitySummary(lead);
          const stages = leadPipelineStages(lead);
          return (
            <div
              key={lead.id}
              className={`lead ${focused ? 'lead-focus' : ''}`}
              onClick={() => onFocus(lead.id)}
            >
              <div className="lead-main">
                <div className="lead-top">
                  <span className="lead-name">{lead.business_name}</span>
                  <span className={`status ${statusClass(lead.status)}`}>{(lead.status || 'unknown').replace(/_/g, ' ')}</span>
                </div>
                <div className="lead-meta mono">
                  <span>{lead.city || '—'}</span>
                  <span className="dot">·</span>
                  <span>{lead.niche || '—'}</span>
                  <span className="dot">·</span>
                  <span className="lead-phone">{maskPhone(lead.phone)}</span>
                </div>
                <div className="lead-id mono">{lead.id}</div>
                <div className="lead-badges">
                  {badges.map((b, i) => (
                    <span key={`${lead.id}:${b.text}:${b.tone}:${i}`} className={`lead-badge lead-badge-${b.tone}`}>{b.text}</span>
                  ))}
                </div>
                <div className={`lead-callability lead-callability-${callability.tone} mono`}>
                  {callability.text}
                </div>
                <div className="lead-pipeline" aria-label="payment build shipment state">
                  {stages.map((stage) => (
                    <span key={`${lead.id}:${stage.label}`} className={`lead-pipe lead-pipe-${stage.state}`}>{stage.label}</span>
                  ))}
                </div>
              </div>
              <div className="lead-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="btn btn-mini"
                  disabled={actionId === `${lead.id}:call`}
                  onClick={() => act('call', lead.id)}
                  title="Place call"
                >
                  call
                </button>
                <button
                  className="btn btn-mini"
                  disabled={actionId === `${lead.id}:approve`}
                  onClick={() => act('approve', lead.id)}
                  title="Manual demo/live override"
                >
                  approve
                </button>
                <button
                  className="btn btn-mini"
                  disabled={actionId === `${lead.id}:followup`}
                  onClick={() => act('followup', lead.id)}
                  title="Send invoice through AgentMail"
                >
                  invoice
                </button>
                <button
                  className="btn btn-mini"
                  disabled={actionId === `${lead.id}:build`}
                  onClick={() => act('build', lead.id)}
                  title="Trigger build"
                >
                  build
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {actionErr ? <div className="leadlist-error mono">{actionErr}</div> : null}
    </div>
  );
}
