import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const EMPTY = {
  sessions: [],
  counts: { total: 0, active: 0, completed: 0, failed: 0, auth_wall: 0 },
  telemetry: {
    totalCostUsd: '0',
    llmCostUsd: '0',
    browserCostUsd: '0',
    proxyCostUsd: '0',
    inputTokens: 0,
    outputTokens: 0,
    stepCount: 0,
    evidenceCount: 0,
    models: []
  }
};

const GROUPS = [
  { key: 'active', title: 'Active sessions' },
  { key: 'completed', title: 'Completed sessions' },
  { key: 'failed', title: 'Failed / auth-wall sessions', include: new Set(['failed', 'auth_wall']) }
];

export default function BrowserUseConsole({ onLeadChanged }) {
  const [data, setData] = useState(EMPTY);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [action, setAction] = useState(null);
  const [form, setForm] = useState({ niche: 'hvac repair', city: 'San Francisco', count: 3 });
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const [sessionData, eventData] = await Promise.all([
        requestJson('/api/browser-use/sessions'),
        requestJson('/api/browser-use/events?limit=80')
      ]);
      setData(sessionData || EMPTY);
      setEvents(eventData?.events || []);
    } catch (err) {
      setError(err.message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load({ quiet: true }), 5000);
    return () => clearInterval(id);
  }, [load]);

  const grouped = useMemo(() => {
    const out = { active: [], completed: [], failed: [] };
    for (const session of data.sessions || []) {
      if (session.statusGroup === 'active') out.active.push(session);
      else if (session.statusGroup === 'completed') out.completed.push(session);
      else out.failed.push(session);
    }
    return out;
  }, [data.sessions]);

  async function startResearch(event) {
    event.preventDefault();
    setAction('start');
    setError(null);
    try {
      await api.discover({
        niche: form.niche,
        city: form.city,
        count: Number(form.count) || 1
      });
      await load({ quiet: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setAction(null);
    }
  }

  async function stopSession(session) {
    setAction(`stop:${session.sessionId}`);
    setError(null);
    try {
      await requestJson(`/api/browser-use/sessions/${encodeURIComponent(session.sessionId)}/stop`, { method: 'POST' });
      await load({ quiet: true });
      onLeadChanged?.(session.leadId);
    } catch (err) {
      setError(err.message);
    } finally {
      setAction(null);
    }
  }

  async function retrySource(session) {
    setAction(`retry:${session.sessionId}`);
    setError(null);
    try {
      if (session.leadId && session.sourceType === 'lovable_build') {
        await api.build(session.leadId);
      } else {
        await api.discover({
          niche: session.niche || form.niche,
          city: session.city || form.city,
          count: 1
        });
      }
      await load({ quiet: true });
      onLeadChanged?.(session.leadId);
    } catch (err) {
      setError(err.message);
    } finally {
      setAction(null);
    }
  }

  const counts = data.counts || EMPTY.counts;
  const telemetry = data.telemetry || EMPTY.telemetry;

  return (
    <section className="bu-strip-card">
      <div
        className="bu-strip"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setExpanded((prev) => !prev);
          }
        }}
        aria-expanded={expanded}
      >
        <div className="bu-strip-left">
          <span className="bu-strip-label">Browser Use builds</span>
          <span className="bu-strip-stat"><span className="bu-strip-stat-key">total</span><span className="bu-strip-stat-val">{counts.total || 0}</span></span>
          <span className="bu-strip-stat"><span className="bu-strip-stat-key">active</span><span className="bu-strip-stat-val">{counts.active || 0}</span></span>
          <span className="bu-strip-stat"><span className="bu-strip-stat-key">done</span><span className="bu-strip-stat-val">{counts.completed || 0}</span></span>
          <span className="bu-strip-stat"><span className="bu-strip-stat-key">failed</span><span className="bu-strip-stat-val">{(counts.failed || 0) + (counts.auth_wall || 0)}</span></span>
          <span className="bu-strip-stat"><span className="bu-strip-stat-key">evidence</span><span className="bu-strip-stat-val">{telemetry.evidenceCount || 0}</span></span>
          <span className="bu-strip-stat"><span className="bu-strip-stat-key">cost</span><span className="bu-strip-stat-val">${Number(telemetry.totalCostUsd || 0).toFixed(2)}</span></span>
        </div>
        <span className="bu-strip-toggle">{expanded ? 'collapse ▴' : 'expand ▾'}</span>
      </div>
      {expanded ? (
        <div className="bu-strip-body">
          <div className="browser-console-head" style={{ padding: '10px 12px' }}>
            <div>
              <div className="browser-console-sub mono">
                {loading ? 'syncing' : `${counts.total || 0} sessions`} · {telemetry.models?.join(', ') || 'no model yet'}
              </div>
            </div>
            <form className="browser-research-form" onSubmit={startResearch}>
              <input
                aria-label="research niche"
                value={form.niche}
                onChange={(event) => setForm((prev) => ({ ...prev, niche: event.target.value }))}
              />
              <input
                aria-label="research city"
                value={form.city}
                onChange={(event) => setForm((prev) => ({ ...prev, city: event.target.value }))}
              />
              <input
                aria-label="research count"
                type="number"
                min="1"
                max="8"
                value={form.count}
                onChange={(event) => setForm((prev) => ({ ...prev, count: event.target.value }))}
              />
              <button className="btn btn-primary btn-mini" disabled={action === 'start'}>
                {action === 'start' ? 'starting' : 'start research'}
              </button>
            </form>
          </div>

          <TelemetryStrip telemetry={telemetry} counts={counts} />

          {error ? <div className="browser-console-error mono">{error}</div> : null}

          <div className="browser-console-grid">
            {GROUPS.map((group) => (
              <SessionColumn
                key={group.key}
                title={group.title}
                sessions={group.key === 'failed' ? grouped.failed : grouped[group.key]}
                action={action}
                onStop={stopSession}
                onRetry={retrySource}
              />
            ))}
            <ExtractionStream events={events} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TelemetryStrip({ telemetry, counts }) {
  return (
    <div className="browser-telemetry mono">
      <Metric label="active" value={counts.active || 0} tone="warn" />
      <Metric label="done" value={counts.completed || 0} tone="good" />
      <Metric label="blocked" value={(counts.failed || 0) + (counts.auth_wall || 0)} tone="bad" />
      <Metric label="steps" value={telemetry.stepCount || 0} />
      <Metric label="evidence" value={telemetry.evidenceCount || 0} />
      <Metric label="tokens" value={`${compactNumber(telemetry.inputTokens)} / ${compactNumber(telemetry.outputTokens)}`} />
      <Metric label="total cost" value={`$${telemetry.totalCostUsd || '0'}`} tone={telemetry.costCapped ? 'bad' : 'good'} />
      <Metric label="llm/browser/proxy" value={`$${telemetry.llmCostUsd || '0'} / $${telemetry.browserCostUsd || '0'} / $${telemetry.proxyCostUsd || '0'}`} />
    </div>
  );
}

function Metric({ label, value, tone = 'muted' }) {
  return (
    <div className={`browser-metric browser-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SessionColumn({ title, sessions, action, onStop, onRetry }) {
  return (
    <div className="browser-session-column">
      <div className="browser-column-head">
        <span className="hd-sub">{title}</span>
        <span className="browser-column-count mono">{sessions.length}</span>
      </div>
      <div className="browser-session-list">
        {sessions.length ? sessions.map((session) => (
          <SessionCard
            key={`${session.buildId}:${session.sessionId}`}
            session={session}
            stopping={action === `stop:${session.sessionId}`}
            retrying={action === `retry:${session.sessionId}`}
            onStop={() => onStop(session)}
            onRetry={() => onRetry(session)}
          />
        )) : (
          <div className="browser-empty mono">empty</div>
        )}
      </div>
    </div>
  );
}

function SessionCard({ session, stopping, retrying, onStop, onRetry }) {
  const canStop = session.statusGroup === 'active';
  const canRetry = session.statusGroup === 'failed' || session.statusGroup === 'auth_wall';
  const liveUrl = session.liveUrl || session.projectUrl;
  const summary = session.lastStepSummary || session.failure || session.task || 'no summary';

  return (
    <article className={`browser-session-card browser-session-${session.statusGroup}`}>
      <div className="browser-card-top">
        <div className="browser-card-title">
          <span className="browser-business">{session.businessName || 'Browser session'}</span>
          <span className="browser-session-id mono">{session.sessionId}</span>
        </div>
        <BadgeRow session={session} />
      </div>

      <div className="browser-card-fields">
        <Field label="model" value={session.model || 'default'} />
        <Field label="status" value={session.status} tone={session.statusGroup} />
        <Field label="source" value={session.source || session.sourceType} wide />
        <Field label="steps" value={session.stepCount ?? 0} />
        <Field label="cost" value={`$${session.totalCostUsd || '0'}`} tone={session.badges?.costCapped ? 'bad' : 'good'} />
        <Field label="evidence" value={session.evidenceCount || 0} />
      </div>

      <div className="browser-summary">{summary}</div>

      {session.screenshotUrl ? (
        <a className="browser-screenshot mono" href={session.screenshotUrl} target="_blank" rel="noreferrer">
          screenshotUrl
        </a>
      ) : null}

      <div className="browser-card-actions">
        {liveUrl ? (
          <a className="btn btn-mini" href={liveUrl} target="_blank" rel="noreferrer">open liveUrl</a>
        ) : <span className="browser-action-missing mono">no liveUrl</span>}
        <button className="btn btn-mini" disabled={!canStop || stopping} onClick={onStop}>
          {stopping ? 'stopping' : 'stop session'}
        </button>
        <button className="btn btn-mini" disabled={!canRetry || retrying} onClick={onRetry}>
          {retrying ? 'retrying' : 'retry failed source'}
        </button>
      </div>
    </article>
  );
}

function BadgeRow({ session }) {
  const badges = [];
  if (session.badges?.mock) badges.push(['mock', 'mock']);
  if (session.badges?.live) badges.push(['live', 'live']);
  if (session.badges?.authNeeded) badges.push(['auth-needed', 'bad']);
  if (session.badges?.costCapped) badges.push(['cost-capped', 'bad']);
  if (session.badges?.stopped) badges.push(['stopped', 'muted']);
  if (!badges.length) badges.push(['pending', 'muted']);
  return (
    <div className="browser-badges">
      {badges.map(([label, tone]) => (
        <span key={label} className={`browser-badge browser-badge-${tone}`}>{label}</span>
      ))}
    </div>
  );
}

function Field({ label, value, tone = 'muted', wide = false }) {
  return (
    <div className={`browser-field ${wide ? 'browser-field-wide' : ''}`}>
      <span className="mono">{label}</span>
      <strong className={`browser-field-${tone}`}>{value || '—'}</strong>
    </div>
  );
}

function ExtractionStream({ events }) {
  const stream = events.slice(-14).reverse();
  return (
    <div className="browser-extraction-stream">
      <div className="browser-column-head">
        <span className="hd-sub">Research extraction stream</span>
        <span className="browser-column-count mono">{events.length}</span>
      </div>
      <div className="browser-stream-list">
        {stream.length ? stream.map((event) => (
          <div key={`${event.id}:${event.ts}`} className={`browser-stream-row browser-stream-${event.status || 'unknown'}`}>
            <div className="browser-stream-meta mono">
              <span>{formatTime(event.ts)}</span>
              <span>{event.phase}</span>
              {event.model ? <span>{event.model}</span> : null}
              {event.mock !== null && event.mock !== undefined ? <span>{event.mock ? 'mock' : 'live'}</span> : null}
            </div>
            <div className="browser-stream-summary">{event.summary}</div>
            <div className="browser-stream-links mono">
              {event.liveUrl ? <a href={event.liveUrl} target="_blank" rel="noreferrer">liveUrl</a> : null}
              {event.screenshotUrl ? <a href={event.screenshotUrl} target="_blank" rel="noreferrer">screenshot</a> : null}
              {event.totalCostUsd ? <span>${event.totalCostUsd}</span> : null}
              {event.evidenceCount ? <span>{event.evidenceCount} evidence</span> : null}
            </div>
          </div>
        )) : (
          <div className="browser-empty mono">no extraction events</div>
        )}
      </div>
    </div>
  );
}

async function requestJson(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

function compactNumber(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatTime(ts) {
  if (!ts) return '--:--';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
