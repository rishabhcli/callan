import React, { useCallback, useEffect, useMemo, useState } from 'react';

const DEFAULT_FORM = {
  city: 'San Francisco, CA',
  niche: 'barber',
  maxLeads: 8,
  concurrency: 5,
  maxCostUsd: 0.35
};

async function jsonOr(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function call(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await jsonOr(res);
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

export default function BrowserResearchConsole() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await call('GET', '/api/research/status');
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const stream = new EventSource('/api/events/stream');
    const onMessage = (event) => {
      try {
        const evt = JSON.parse(event.data);
        if (evt?.type?.startsWith('research.') || evt?.type?.startsWith('provider.browserUse.')) refresh();
      } catch {
        // Ignore malformed event payloads from browser extensions or proxies.
      }
    };
    stream.addEventListener('message', onMessage);
    const researchEvents = [
      'research.job.started',
      'research.job.completed',
      'research.job.failed',
      'research.job.stopped',
      'research.session.started',
      'research.session.progress',
      'research.session.completed',
      'research.session.failed',
      'research.evidence.captured',
      'research.evidence.skipped'
    ];
    for (const name of researchEvents) stream.addEventListener(name, onMessage);
    return () => stream.close();
  }, [refresh]);

  const sessions = status?.sessions || [];
  const businesses = status?.businesses || [];
  const summary = status?.summary || {};
  const blockers = status?.liveBlockers || [];

  const active = useMemo(() => sessions.filter((session) => ['queued', 'starting', 'running', 'idle'].includes(session.normalizedStatus)), [sessions]);

  const updateForm = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const startResearch = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await call('POST', '/api/research/start', {
        city: form.city,
        niche: form.niche,
        maxLeads: Number(form.maxLeads),
        concurrency: Number(form.concurrency),
        maxCostUsd: Number(form.maxCostUsd)
      });
      setStatus(data.status);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const stopResearch = async () => {
    if (!status?.job?.id) return;
    setBusy(true);
    setError(null);
    try {
      const data = await call('POST', '/api/research/stop', { jobId: status.job.id });
      setStatus(data.status);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <section className="brc">
      <style>{styles}</style>
      <div className="brc-head">
        <div>
          <span className="hd">browser research</span>
          <div className="brc-sub mono">
            {status?.job ? `${status.job.status} · ${summary.acceptedCount || 0}/${status.job.maxLeads} accepted · ${summary.strongSkippedCount || 0} strong skipped` : 'idle'}
          </div>
        </div>
        <div className="brc-actions">
          <button className="btn btn-mini" type="button" onClick={stopResearch} disabled={busy || !active.length}>
            stop
          </button>
          <button className="btn btn-primary" type="button" onClick={startResearch} disabled={busy}>
            {busy ? 'starting' : 'Start research now'}
          </button>
        </div>
      </div>

      <div className="brc-controls">
        <label className="field">
          <span className="field-key">city</span>
          <input value={form.city} onChange={(e) => updateForm('city', e.target.value)} />
        </label>
        <label className="field">
          <span className="field-key">niche</span>
          <input value={form.niche} onChange={(e) => updateForm('niche', e.target.value)} />
        </label>
        <label className="field">
          <span className="field-key">max leads</span>
          <input type="number" min="1" max="25" value={form.maxLeads} onChange={(e) => updateForm('maxLeads', e.target.value)} />
        </label>
        <label className="field">
          <span className="field-key">concurrency</span>
          <input type="number" min="1" max="5" value={form.concurrency} onChange={(e) => updateForm('concurrency', e.target.value)} />
        </label>
        <label className="field">
          <span className="field-key">max $/session</span>
          <input type="number" min="0.01" max="5" step="0.01" value={form.maxCostUsd} onChange={(e) => updateForm('maxCostUsd', e.target.value)} />
        </label>
      </div>

      <div className="brc-meta mono">
        <span className={`brc-pill ${status?.liveResearchEnabled ? 'brc-live' : 'brc-mock'}`}>
          {status?.liveResearchEnabled ? 'live cloud' : 'mock harness'}
        </span>
        <span>{summary.totalSessions || 0} sessions</span>
        <span>{summary.evidenceCount || 0} evidence</span>
        <span>${Number(summary.costUsd || 0).toFixed(3)} cost</span>
        {blockers.length ? <span className="brc-blocked">{blockers[0]}</span> : null}
      </div>

      {error ? <div className="brc-error mono">{error}</div> : null}

      <div className="brc-sessions">
        {sessions.map((session) => (
          <article className="brc-session" key={session.id}>
            <div className="brc-session-top">
              <span className={`brc-dot brc-dot-${session.normalizedStatus}`} />
              <span className="brc-session-source">{session.sourceLabel || session.sourceType}</span>
              <span className="brc-session-status mono">{session.normalizedStatus}</span>
            </div>
            <div className="brc-session-grid mono">
              <span>model {session.model || 'pending'}</span>
              <span>out {session.outputCount || 0}</span>
              <span>${Number(session.costUsd || 0).toFixed(3)}</span>
            </div>
            <div className="brc-step">{session.lastStepSummary || 'waiting'}</div>
            {session.liveUrl ? (
              <a className="brc-live-url mono" href={session.liveUrl} target="_blank" rel="noreferrer">
                liveUrl
              </a>
            ) : null}
          </article>
        ))}
      </div>

      <div className="brc-table">
        <div className="brc-table-head mono">
          <span>business</span>
          <span>presence</span>
          <span>evidence</span>
          <span>contact</span>
        </div>
        {businesses.slice(0, 12).map((business) => (
          <div className={`brc-row ${business.skipped ? 'brc-row-skipped' : ''}`} key={business.businessName}>
            <div>
              <strong>{business.businessName}</strong>
              <small>{business.address || 'address pending'}</small>
            </div>
            <div className="mono">
              <span className={`brc-presence brc-presence-${business.presenceStrength}`}>{business.presenceStrength || 'unknown'}</span>
              {business.skippedReason ? <small>{business.skippedReason.replaceAll('_', ' ')}</small> : null}
            </div>
            <div className="mono">
              {business.sources.length} source{business.sources.length === 1 ? '' : 's'}
              <small>{business.services.slice(0, 2).join(' · ') || 'services pending'}</small>
            </div>
            <div className="mono">
              {business.phone || 'phone pending'}
              <small>{business.websiteUrl || business.socialUrls[0] || 'no owned URL'}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const styles = `
.brc {
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  display: grid;
  gap: 8px;
  padding: 10px 14px 12px;
  flex: 0 0 auto;
}
.brc-head,
.brc-actions,
.brc-meta,
.brc-session-top,
.brc-session-grid {
  display: flex;
  align-items: center;
}
.brc-head { justify-content: space-between; gap: 12px; }
.brc-actions { gap: 8px; }
.brc-sub { color: var(--ink-300); font-size: 10px; margin-top: 2px; }
.brc-controls {
  display: grid;
  grid-template-columns: minmax(120px, 1.2fr) minmax(100px, 1fr) 72px 78px 92px;
  gap: 8px;
  align-items: end;
}
.brc-controls .field input { height: 31px; min-width: 0; }
.brc-meta {
  gap: 10px;
  color: var(--ink-300);
  font-size: 10px;
  overflow: hidden;
  white-space: nowrap;
}
.brc-pill {
  border: 1px solid var(--line-strong);
  padding: 1px 5px;
  text-transform: uppercase;
  font-size: 9px;
}
.brc-live { color: var(--accent); border-color: var(--accent-dim); }
.brc-mock { color: var(--warn); border-color: var(--warn); }
.brc-blocked,
.brc-error { color: var(--warn); overflow: hidden; text-overflow: ellipsis; }
.brc-error { font-size: 10px; }
.brc-sessions {
  display: grid;
  grid-template-columns: repeat(5, minmax(120px, 1fr));
  gap: 6px;
}
.brc-session {
  border: 1px solid var(--line);
  background: var(--bg-0);
  padding: 7px;
  min-width: 0;
}
.brc-session-top { gap: 6px; min-width: 0; }
.brc-session-source {
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.brc-session-status { color: var(--ink-300); margin-left: auto; font-size: 9px; }
.brc-session-grid {
  justify-content: space-between;
  gap: 6px;
  color: var(--ink-400);
  font-size: 9px;
  margin-top: 5px;
}
.brc-step {
  color: var(--ink-300);
  font-size: 11px;
  line-height: 1.35;
  min-height: 30px;
  margin-top: 6px;
  overflow: hidden;
}
.brc-live-url { display: inline-block; margin-top: 5px; color: var(--accent); font-size: 9px; }
.brc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink-500);
  flex: 0 0 auto;
}
.brc-dot-running,
.brc-dot-starting,
.brc-dot-queued { background: var(--warn); animation: pulse 1s infinite; }
.brc-dot-completed { background: var(--accent); }
.brc-dot-failed,
.brc-dot-timed_out { background: var(--error); }
.brc-table {
  border: 1px solid var(--line);
  background: var(--bg-0);
  max-height: 210px;
  overflow: auto;
}
.brc-table-head,
.brc-row {
  display: grid;
  grid-template-columns: minmax(150px, 1.3fr) 95px minmax(110px, 1fr) minmax(130px, 1fr);
  gap: 8px;
  align-items: start;
  padding: 6px 8px;
}
.brc-table-head {
  position: sticky;
  top: 0;
  z-index: 1;
  color: var(--ink-400);
  background: var(--bg-2);
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.brc-row {
  border-top: 1px solid var(--line);
  color: var(--ink-200);
}
.brc-row strong,
.brc-row small {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}
.brc-row strong { color: var(--ink-100); font-size: 12px; }
.brc-row small { color: var(--ink-400); font-size: 10px; margin-top: 2px; }
.brc-row-skipped { opacity: 0.75; }
.brc-presence { color: var(--ink-300); }
.brc-presence-none,
.brc-presence-weak { color: var(--accent); }
.brc-presence-mixed { color: var(--warn); }
.brc-presence-strong { color: var(--error); }
@media (max-width: 1180px) {
  .brc-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .brc-sessions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .brc-table-head,
  .brc-row { grid-template-columns: minmax(140px, 1fr) 90px minmax(100px, 1fr); }
  .brc-table-head span:nth-child(4),
  .brc-row > div:nth-child(4) { display: none; }
}
`;
