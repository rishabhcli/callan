import React, { useMemo } from 'react';

const WORKERS = [
  { id: 'scraper', label: 'Research swarm',   sub: 'browser-use lanes' },
  { id: 'caller',  label: 'Phone agents',     sub: 'agentphone voices' },
  { id: 'memory',  label: 'Memory writer',    sub: 'supermemory mirror' },
  { id: 'analyst', label: 'Analyst engine',   sub: 'call postmortem + growth' },
  { id: 'mailer',  label: 'Mailer relay',     sub: 'agentmail + stripe' },
  { id: 'builder', label: 'Builder driver',   sub: 'browser-use + lovable' }
];

export default function AgentsView({ nodeStates = {}, counters = {}, leads = [], outreach = null, onFocusLead }) {
  const liveLeads = useMemo(() => leads.filter((l) => ['calling', 'building', 'closing'].includes(l.status)), [leads]);
  const callerAgents = outreach?.agents || {};
  const activeJobs = callerAgents.activeJobs || outreach?.activeJobs || [];
  const queued = outreach?.queue?.queued ?? leads.filter((l) => ['queued', 'retry'].includes(l.outreach_status)).length;

  return (
    <div className="nyna-agents-shell">
      <header className="nyna-agents-head">
        <div>
          <div className="nyna-detail-subtitle">agents · fleet</div>
          <div className="nyna-detail-title">workers on the floor</div>
          <div className="nyna-memory-tag" style={{ marginTop: 4 }}>
            Every box on the 3D scene is one or more concurrent worker instances.
            Below is the per-worker fleet rollup; the right rail tracks per-lead state.
          </div>
        </div>
        <div className="nyna-agents-meters">
          <Meter label="caller agents" value={`${callerAgents.active ?? 0}/${callerAgents.concurrency ?? 1}`} />
          <Meter label="available" value={callerAgents.available ?? 0} />
          <Meter label="queued" value={queued} />
        </div>
      </header>

      <section className="nyna-agents-grid">
        {WORKERS.map((w) => (
          <WorkerCard
            key={w.id}
            worker={w}
            state={nodeStates[w.id] || 'idle'}
            rate={counters[w.id] || 0}
            instances={w.id === 'caller' ? callerAgents : null}
          />
        ))}
      </section>

      {activeJobs.length ? (
        <section>
          <div className="nyna-section-title">active caller agents</div>
          <div className="nyna-workloads">
            {activeJobs.map((job) => (
              <button key={job.leadId} className="nyna-workload-row" onClick={() => onFocusLead?.(job.leadId)}>
                <div className="nyna-workload-name">
                  <span className="nyna-workload-dot" />
                  <span>{job.businessName || job.leadId}</span>
                </div>
                <span className="nyna-workload-status">{job.agentId || 'caller'}</span>
                <span className="nyna-workload-meta">{elapsed(job.startedAt)} running</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <div className="nyna-section-title">live workloads</div>
        {liveLeads.length ? (
          <div className="nyna-workloads">
            {liveLeads.map((lead) => (
              <button key={lead.id} className="nyna-workload-row" onClick={() => onFocusLead?.(lead.id)}>
                <div className="nyna-workload-name">
                  <span className="nyna-workload-dot" />
                  <span>{lead.business_name || lead.id}</span>
                </div>
                <span className="nyna-workload-status">{lead.status}</span>
                <span className="nyna-workload-meta">{lead.next_action || lead.outreach_status || ''}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="nyna-rail-empty" style={{ padding: 28 }}>
            // no live leads currently — start outreach or research a niche
          </div>
        )}
      </section>
    </div>
  );
}

function Meter({ label, value }) {
  return (
    <div className="nyna-agents-meter">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function WorkerCard({ worker, state, rate, instances }) {
  const active = instances?.active ?? 0;
  const concurrency = instances?.concurrency ?? null;
  return (
    <article className={`nyna-worker-card nyna-worker-${state}`}>
      <header className="nyna-worker-head">
        <span className="nyna-worker-eye">{worker.sub}</span>
        <span className={`nyna-worker-state nyna-worker-state-${state}`}>{state}</span>
      </header>
      <div className="nyna-worker-title">{worker.label}</div>
      <div className="nyna-worker-rate">
        <div className="nyna-worker-rate-val">{instances ? active : rate}</div>
        <div className="nyna-worker-rate-key">{instances ? `of ${concurrency || 1} agents active` : 'events/min'}</div>
      </div>
      <div className="nyna-worker-bar">
        <div className="nyna-worker-bar-fill" style={{ width: `${Math.min(100, instances ? (active / Math.max(1, concurrency || 1)) * 100 : rate * 8)}%` }} />
      </div>
    </article>
  );
}

function elapsed(startedAt) {
  if (!startedAt) return '0s';
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m`;
}
