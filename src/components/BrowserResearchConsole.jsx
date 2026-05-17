import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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

const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running', 'idle']);

function mergeSessionInto(prev, evt) {
  const existing = prev.find((s) => s.id === evt.sessionId);
  const merged = {
    id: evt.sessionId,
    jobId: evt.jobId,
    providerSessionId: evt.providerSessionId,
    sourceType: evt.sourceType,
    sourceLabel: evt.sourceLabel,
    model: evt.model,
    status: evt.status,
    normalizedStatus: evt.normalizedStatus,
    liveUrl: evt.liveUrl || existing?.liveUrl,
    lastStepSummary: evt.lastStepSummary || existing?.lastStepSummary,
    outputCount: evt.outputCount ?? existing?.outputCount ?? 0,
    costUsd: evt.costUsd ?? existing?.costUsd ?? 0,
    maxCostUsd: evt.maxCostUsd ?? existing?.maxCostUsd ?? null,
    keepAlive: evt.keepAlive ?? existing?.keepAlive ?? false,
    updatedAt: Date.now()
  };
  if (existing) {
    return prev.map((s) => s.id === merged.id ? { ...existing, ...merged } : s);
  }
  return [...prev, merged];
}

function mergeBusinessInto(prev, evt) {
  if (!evt?.businessName) return prev;
  const name = evt.businessName;
  const lower = name.toLowerCase();
  const existing = prev.find((b) => b.businessName.toLowerCase() === lower);
  const sourcePatch = {
    sourceType: evt.sourceType,
    sourceUrl: evt.sourceUrl || null,
    evidenceCount: 1
  };
  if (existing) {
    return prev.map((b) => {
      if (b.businessName.toLowerCase() !== lower) return b;
      const sources = (b.sources || []).some((src) => src.sourceType === evt.sourceType) ? b.sources : [...(b.sources || []), sourcePatch];
      return {
        ...b,
        skipped: b.skipped && !!evt.skipped,
        skippedReason: b.skippedReason || evt.skippedReason || null,
        presenceStrength: b.presenceStrength || evt.presenceStrength || null,
        sources,
        flashTs: Date.now()
      };
    });
  }
  return [
    ...prev,
    {
      businessName: name,
      phone: null,
      address: null,
      hours: null,
      websiteUrl: null,
      presenceStrength: evt.presenceStrength || null,
      skipped: !!evt.skipped,
      skippedReason: evt.skippedReason || null,
      sources: [sourcePatch],
      services: [],
      socialUrls: [],
      flashTs: Date.now()
    }
  ];
}

export default function BrowserResearchConsole() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [businesses, setBusinesses] = useState([]);
  const [recentEvents, setRecentEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [focusedSessionId, setFocusedSessionId] = useState(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const pushEvent = useCallback((line) => {
    setRecentEvents((prev) => [{ ts: Date.now(), text: line }, ...prev].slice(0, 14));
  }, []);

  const applyStatusSnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    setStatus(snapshot);
    if (Array.isArray(snapshot.sessions)) setSessions(snapshot.sessions);
    if (Array.isArray(snapshot.businesses)) {
      setBusinesses((prev) => {
        const flashIndex = new Map(prev.map((b) => [b.businessName.toLowerCase(), b.flashTs]));
        return snapshot.businesses.map((b) => ({ ...b, flashTs: flashIndex.get(b.businessName.toLowerCase()) || null }));
      });
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await call('GET', '/api/research/status');
      applyStatusSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [applyStatusSnapshot]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const stream = new EventSource('/api/events/stream');
    const handle = (rawData) => {
      try {
        const evt = JSON.parse(rawData);
        if (!evt?.type) return;
        if (evt.type === 'research.job.started') {
          setSessions([]);
          setBusinesses([]);
          setFocusedSessionId(null);
          pushEvent(`job started · ${evt.city || ''} ${evt.niche || ''}`.trim());
          refresh();
        } else if (evt.type === 'research.job.completed' || evt.type === 'research.job.failed' || evt.type === 'research.job.stopped') {
          pushEvent(`job ${evt.type.split('.').pop()} · ${evt.acceptedCount ?? 0} accepted`);
          refresh();
        } else if (evt.type === 'research.session.started' || evt.type === 'research.session.live_url' || evt.type === 'research.session.progress' || evt.type === 'research.session.completed' || evt.type === 'research.session.failed' || evt.type === 'research.session.stopped') {
          setSessions((prev) => mergeSessionInto(prev, evt));
          if (evt.type === 'research.session.live_url' || (evt.type === 'research.session.started' && !focusedSessionId)) {
            setFocusedSessionId((curr) => curr || evt.sessionId);
          }
          if (evt.type === 'research.session.started') pushEvent(`session ${evt.sourceType} opening...`);
          if (evt.type === 'research.session.completed') pushEvent(`session ${evt.sourceType} done · ${evt.outputCount || 0} extracted`);
          if (evt.type === 'research.session.failed') pushEvent(`session ${evt.sourceType} FAILED`);
        } else if (evt.type === 'research.evidence.captured') {
          setBusinesses((prev) => mergeBusinessInto(prev, evt));
          pushEvent(`evidence · ${evt.businessName} (${evt.sourceType})`);
        } else if (evt.type === 'research.evidence.skipped') {
          setBusinesses((prev) => mergeBusinessInto(prev, evt));
          pushEvent(`skip · ${evt.businessName} (${evt.skippedReason || 'reason unknown'})`);
        } else if (evt.type === 'lead.created' && evt.worker === 'browser_research') {
          pushEvent(`memory · ${evt.businessName} mirrored to supermemory`);
          // also nudge a refresh so memory/businesses are in sync
          refresh();
        } else if (evt.type === 'memory.write.succeeded' || evt.type === 'memory.write.queued') {
          if (evt.kind === 'business_profile' || evt.kind === 'research_evidence') {
            pushEvent(`supermemory ${evt.type.split('.').pop()} · ${evt.kind}`);
          }
        }
      } catch {
        // Ignore malformed payloads.
      }
    };
    const onMessage = (event) => handle(event.data);
    stream.addEventListener('message', onMessage);
    const researchEvents = [
      'research.job.started',
      'research.job.completed',
      'research.job.failed',
      'research.job.stopped',
      'research.session.started',
      'research.session.live_url',
      'research.session.progress',
      'research.session.completed',
      'research.session.failed',
      'research.session.stopped',
      'research.evidence.captured',
      'research.evidence.skipped',
      'lead.created',
      'memory.write.succeeded',
      'memory.write.queued'
    ];
    for (const name of researchEvents) stream.addEventListener(name, onMessage);
    return () => stream.close();
  }, [pushEvent, refresh, focusedSessionId]);

  const summary = status?.summary || {};
  const blockers = status?.liveBlockers || [];
  const active = useMemo(() => sessions.filter((session) => ACTIVE_STATUSES.has(session.normalizedStatus)), [sessions]);
  const visibleSessions = useMemo(() => [...sessions].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)), [sessions]);
  const focused = focusedSessionId ? visibleSessions.find((s) => s.id === focusedSessionId) : visibleSessions[0] || null;
  const visibleBusinesses = useMemo(() => {
    return [...businesses].sort((a, b) => {
      if (a.skipped !== b.skipped) return a.skipped ? 1 : -1;
      return (b.flashTs || 0) - (a.flashTs || 0);
    });
  }, [businesses]);

  const updateForm = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const startResearch = async () => {
    setBusy(true);
    setError(null);
    try {
      setSessions([]);
      setBusinesses([]);
      setRecentEvents([{ ts: Date.now(), text: 'starting research...' }]);
      setFocusedSessionId(null);
      const data = await call('POST', '/api/research/start', {
        city: form.city,
        niche: form.niche,
        maxLeads: Number(form.maxLeads),
        concurrency: Number(form.concurrency),
        maxCostUsd: Number(form.maxCostUsd)
      });
      if (data?.status) applyStatusSnapshot(data.status);
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
      if (data?.status) applyStatusSnapshot(data.status);
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
            {status?.job ? `${status.job.status} · ${summary.acceptedCount || 0}/${status.job.maxLeads} accepted · ${summary.strongSkippedCount || 0} strong skipped · ${active.length} active windows` : 'idle'}
          </div>
        </div>
        <div className="brc-actions">
          <button className="btn btn-mini" type="button" onClick={stopResearch} disabled={busy || !active.length}>
            stop
          </button>
          <button className="btn btn-primary" type="button" onClick={startResearch} disabled={busy} data-testid="start-research">
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

      {visibleSessions.length ? (
        <div className="brc-windows">
          <div className="brc-window-tabs">
            {visibleSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={`brc-window-tab brc-window-tab-${session.normalizedStatus} ${focused?.id === session.id ? 'brc-window-tab-active' : ''}`}
                onClick={() => setFocusedSessionId(session.id)}
              >
                <span className={`brc-dot brc-dot-${session.normalizedStatus}`} />
                <span className="brc-window-tab-label">{session.sourceLabel || session.sourceType}</span>
                <span className="brc-window-tab-count">{session.outputCount || 0}</span>
              </button>
            ))}
          </div>
          {focused ? (
            <div className="brc-window">
              <div className="brc-window-bar mono">
                <span className={`brc-dot brc-dot-${focused.normalizedStatus}`} />
                <span className="brc-window-url">{focused.liveUrl || 'awaiting liveUrl from Browser Use...'}</span>
                <span className="brc-window-status">{focused.normalizedStatus}</span>
                {focused.liveUrl ? <a href={focused.liveUrl} target="_blank" rel="noreferrer" className="brc-window-open">open</a> : null}
              </div>
              {focused.liveUrl ? (
                <iframe
                  key={focused.id}
                  title={`browser-use ${focused.sourceLabel || focused.sourceType}`}
                  src={focused.liveUrl}
                  className="brc-window-frame"
                  sandbox="allow-scripts allow-same-origin"
                />
              ) : (
                <div className="brc-window-frame brc-window-empty mono">
                  spinning up cloud browser session...
                </div>
              )}
              <div className="brc-window-step mono">step · {focused.lastStepSummary || 'waiting'}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {recentEvents.length ? (
        <div className="brc-feed mono">
          {recentEvents.slice(0, 6).map((evt, idx) => (
            <div key={`${evt.ts}-${idx}`} className="brc-feed-row">
              <span className="brc-feed-ts">{new Date(evt.ts).toLocaleTimeString()}</span>
              <span className="brc-feed-text">{evt.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="brc-table">
        <div className="brc-table-head mono">
          <span>business</span>
          <span>presence</span>
          <span>evidence</span>
          <span>contact</span>
        </div>
        {visibleBusinesses.slice(0, 16).map((business) => {
          const flashing = business.flashTs && Date.now() - business.flashTs < 4000;
          return (
            <div className={`brc-row ${business.skipped ? 'brc-row-skipped' : ''} ${flashing ? 'brc-row-flash' : ''}`} key={business.businessName}>
              <div>
                <strong>{business.businessName}</strong>
                <small>{business.address || 'address pending'}</small>
              </div>
              <div className="mono">
                <span className={`brc-presence brc-presence-${business.presenceStrength}`}>{business.presenceStrength || 'unknown'}</span>
                {business.skippedReason ? <small>{business.skippedReason.replaceAll('_', ' ')}</small> : null}
              </div>
              <div className="mono">
                {(business.sources || []).length} source{(business.sources || []).length === 1 ? '' : 's'}
                <small>{(business.services || []).slice(0, 2).join(' · ') || 'services pending'}</small>
              </div>
              <div className="mono">
                {business.phone || 'phone pending'}
                <small>{business.websiteUrl || (business.socialUrls || [])[0] || 'no owned URL'}</small>
              </div>
            </div>
          );
        })}
        {!visibleBusinesses.length ? <div className="brc-empty mono">// click Start research now to spin up browser windows</div> : null}
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
.brc-window-bar,
.brc-window-tabs {
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

.brc-windows {
  border: 1px solid var(--line);
  background: var(--bg-0);
  border-radius: 4px;
  overflow: hidden;
}
.brc-window-tabs {
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-2);
}
.brc-window-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-1);
  border: 1px solid var(--line);
  color: var(--ink-300);
  padding: 4px 8px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
}
.brc-window-tab-active { color: var(--ink-100); border-color: var(--accent); }
.brc-window-tab-label { font-weight: 600; }
.brc-window-tab-count {
  font-size: 9px;
  background: var(--bg-0);
  padding: 0 5px;
  border-radius: 8px;
  color: var(--ink-400);
}
.brc-window-bar {
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-2);
  border-bottom: 1px solid var(--line);
  font-size: 11px;
}
.brc-window-url {
  flex: 1;
  background: var(--bg-0);
  border: 1px solid var(--line);
  padding: 2px 6px;
  color: var(--ink-300);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.brc-window-status {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--warn);
}
.brc-window-open {
  font-size: 10px;
  color: var(--accent);
  text-decoration: none;
}
.brc-window-frame {
  display: block;
  width: 100%;
  height: 280px;
  background: #0d1116;
  border: 0;
}
.brc-window-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-400);
  font-size: 11px;
}
.brc-window-step {
  padding: 6px 10px;
  border-top: 1px solid var(--line);
  color: var(--ink-300);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.brc-feed {
  border: 1px solid var(--line);
  background: var(--bg-0);
  padding: 6px 8px;
  display: grid;
  gap: 2px;
  max-height: 110px;
  overflow: hidden;
}
.brc-feed-row {
  display: flex;
  gap: 8px;
  font-size: 10px;
  color: var(--ink-300);
}
.brc-feed-ts { color: var(--ink-400); flex: 0 0 70px; }
.brc-feed-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
  max-height: 240px;
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
  transition: background 700ms ease-out;
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
.brc-row-flash {
  background: rgba(46, 160, 67, 0.12);
  animation: flashRow 2.5s ease-out;
}
@keyframes flashRow {
  from { background: rgba(46, 160, 67, 0.35); }
  to   { background: rgba(46, 160, 67, 0); }
}
.brc-presence { color: var(--ink-300); }
.brc-presence-none,
.brc-presence-weak { color: var(--accent); }
.brc-presence-mixed { color: var(--warn); }
.brc-presence-strong { color: var(--error); }
.brc-empty {
  padding: 12px;
  color: var(--ink-400);
  font-size: 11px;
  text-align: center;
}
@media (max-width: 1180px) {
  .brc-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .brc-table-head,
  .brc-row { grid-template-columns: minmax(140px, 1fr) 90px minmax(100px, 1fr); }
  .brc-table-head span:nth-child(4),
  .brc-row > div:nth-child(4) { display: none; }
}
`;
