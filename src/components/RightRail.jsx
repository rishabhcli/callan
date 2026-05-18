import React, { useMemo } from 'react';

function statusLabel(lead) {
  const status = lead.status || lead.outreach_status || 'discovered';
  return String(status).replace(/_/g, ' ');
}

function statusTone(lead) {
  const status = lead.status || lead.outreach_status || 'discovered';
  if (status === 'calling' || status === 'building') return 'calling';
  if (status === 'paid' || status === 'shipped' || status === 'closing') return 'paid';
  if (status === 'blocked' || status === 'rejected' || status === 'blocked_auth') return 'blocked';
  if (status === 'shipped') return 'built';
  return '';
}

function progressForLead(lead) {
  const status = lead.status || 'discovered';
  if (status === 'shipped') return 1;
  if (status === 'paid') return 0.78;
  if (status === 'building') return 0.6;
  if (status === 'awaiting_payment') return 0.45;
  if (status === 'closing' || status === 'calling') return 0.28;
  if (status === 'discovered') return 0.08;
  return 0.2;
}

function leadCity(lead) {
  return lead.city || lead.region || lead.location || lead.niche || '—';
}

function formatPhone(p) {
  if (!p) return '— · —— · ——';
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 7) return p;
  const last = digits.slice(-4);
  const mid = digits.slice(-7, -4);
  return `(${digits.slice(0, digits.length - 7) || '—'}) ${mid} ${last}`;
}

export default function RightRail({
  leads = [],
  focusedLeadId,
  onFocus,
  queueCounts,
  sseStatus
}) {
  const activeLeads = useMemo(() => {
    const sorted = [...leads].sort((a, b) => {
      const aRank = rankFor(a);
      const bRank = rankFor(b);
      if (aRank !== bRank) return aRank - bRank;
      return new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
    });
    return sorted.slice(0, 24);
  }, [leads]);

  const liveCount = useMemo(
    () => activeLeads.filter((lead) => ['calling', 'building', 'closing'].includes(lead.status)).length,
    [activeLeads]
  );

  return (
    <aside className="nyna-rail">
      <header className="nyna-rail-head">
        <div>
          <div className="nyna-rail-title">live floor</div>
          <div className="nyna-rail-sub">{liveCount} active · {leads.length} total</div>
        </div>
        <span className={`nyna-rail-meta sse-${sseStatus}`}>
          <span className="nyna-rail-meta-dot" />
          {sseStatus === 'connected' ? 'streaming' : sseStatus}
        </span>
      </header>

      <div className="nyna-rail-body">
        <QueueSummary queueCounts={queueCounts} />

        <div className="nyna-rail-section-title">leads in motion</div>
        {activeLeads.length ? activeLeads.map((lead) => (
          <RailCard
            key={lead.id}
            lead={lead}
            focused={lead.id === focusedLeadId}
            onClick={() => onFocus?.(lead.id)}
          />
        )) : (
          <div className="nyna-rail-empty">// no leads yet — start research from the discover panel</div>
        )}
      </div>
    </aside>
  );
}

function QueueSummary({ queueCounts = {} }) {
  const stats = [
    { key: 'queued',          label: 'queued',  value: queueCounts.queued || 0 },
    { key: 'calling',         label: 'calling', value: queueCounts.calling || 0 },
    { key: 'awaitingPayment', label: 'pay',     value: queueCounts.awaitingPayment || 0 },
    { key: 'paid',            label: 'paid',    value: queueCounts.paid || 0 },
    { key: 'shipped',         label: 'shipped', value: queueCounts.shipped || 0 }
  ];
  return (
    <div className="nyna-rail-queue">
      {stats.map((stat) => (
        <div key={stat.key} className="nyna-rail-queue-cell">
          <div className="nyna-rail-queue-key">{stat.label}</div>
          <div className="nyna-rail-queue-val">{stat.value}</div>
        </div>
      ))}
    </div>
  );
}

function RailCard({ lead, focused, onClick }) {
  const tone = statusTone(lead);
  const progress = progressForLead(lead);
  return (
    <button
      type="button"
      className={`nyna-rail-card ${focused ? 'nyna-rail-card-focus' : ''}`}
      onClick={onClick}
    >
      <div className="nyna-rail-card-top">
        <div style={{ minWidth: 0 }}>
          <div className="nyna-rail-card-name">{lead.business_name || lead.businessName || lead.id}</div>
          <div className="nyna-rail-card-loc">{leadCity(lead)}</div>
        </div>
        <span className={`nyna-rail-card-status ${tone ? `nyna-rail-card-status-${tone}` : ''}`}>
          {statusLabel(lead)}
        </span>
      </div>
      <div className="nyna-rail-card-progress">
        <div className="nyna-rail-card-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="nyna-rail-card-meta">
        <span>{formatPhone(lead.phone)}</span>
        <span>{relTime(lead.updated_at || lead.created_at)}</span>
      </div>
    </button>
  );
}

function rankFor(lead) {
  const status = lead.status || lead.outreach_status || '';
  if (status === 'calling' || status === 'building' || status === 'closing') return 0;
  if (status === 'awaiting_payment') return 1;
  if (status === 'paid') return 2;
  if (status === 'shipped') return 3;
  if (status === 'blocked' || status === 'rejected') return 5;
  return 4;
}

function relTime(value) {
  if (!value) return '';
  const ts = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
