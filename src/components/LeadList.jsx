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
    case 'shipped':          return 'st-success';
    default:                 return 'st-neutral';
  }
}

const FALLBACK_EMAIL = 'owner@demo.callmemaybe.dev';

export default function LeadList({ leads, focusedLeadId, onFocus }) {
  const [actionId, setActionId] = useState(null);
  const [actionErr, setActionErr] = useState(null);

  async function act(action, leadId) {
    setActionId(`${leadId}:${action}`);
    setActionErr(null);
    try {
      if (action === 'call') await api.startCall(leadId);
      else if (action === 'followup') await api.followup(leadId, FALLBACK_EMAIL);
      else if (action === 'build') await api.build(leadId);
    } catch (e) {
      setActionErr(`${action} → ${e.message}`);
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="leadlist">
      <div className="leadlist-head">
        <span className="hd">leads</span>
        <span className="hd-count mono">{String(leads.length).padStart(3, '0')}</span>
      </div>
      <div className="leadlist-body">
        {leads.length === 0 && (
          <div className="leadlist-empty">no leads yet — discover above.</div>
        )}
        {leads.map((lead) => {
          const focused = focusedLeadId === lead.id;
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
                  disabled={actionId === `${lead.id}:followup`}
                  onClick={() => act('followup', lead.id)}
                  title="Send follow-up"
                >
                  mail
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
