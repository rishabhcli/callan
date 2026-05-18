import React, { useCallback, useEffect, useState } from 'react';

const EMPTY = { sessions: [], counts: {}, telemetry: {} };

async function jsonOr(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function get(path) {
  const res = await fetch(path);
  const data = await jsonOr(res);
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await jsonOr(res);
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

function statusClass(group) {
  if (group === 'active') return 'is-active';
  if (group === 'failed' || group === 'auth_wall') return 'is-blocked';
  return '';
}

export default function ScraperView() {
  const [data, setData] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [layout, setLayout] = useState('grid'); // grid | focus
  const [focusId, setFocusId] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await get('/api/browser-use/sessions');
      setData(res || EMPTY);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const sessions = data.sessions || [];
  const counts = data.counts || {};
  const telemetry = data.telemetry || {};

  const focusSession = focusId ? sessions.find((s) => s.sessionId === focusId) : null;

  const startDiscovery = async () => {
    setBusy('start');
    try {
      await post('/api/leads/discover', { niche: 'hvac repair', city: 'San Francisco', count: 3 });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="nyna-scraper-shell">
      <header className="nyna-scraper-header">
        <div>
          <div className="nyna-detail-subtitle">scraper · browser-use cloud</div>
          <div className="nyna-detail-title">live cloud windows</div>
        </div>
        <div className="nyna-scraper-stats">
          <Stat k="active" v={counts.active || 0} good={counts.active > 0} />
          <Stat k="done" v={counts.completed || 0} />
          <Stat k="auth-wall" v={counts.auth_wall || 0} bad={counts.auth_wall > 0} />
          <Stat k="failed" v={counts.failed || 0} bad={counts.failed > 0} />
          <Stat k="evidence" v={telemetry.evidenceCount || 0} />
          <Stat k="cost" v={`$${Number(telemetry.totalCostUsd || 0).toFixed(2)}`} />
        </div>
        <div className="nyna-scraper-actions">
          <button className={`nyna-mini-btn ${layout === 'grid' ? 'is-on' : ''}`} onClick={() => { setLayout('grid'); setFocusId(null); }}>grid</button>
          <button className={`nyna-mini-btn ${layout === 'focus' && focusId ? 'is-on' : ''}`} onClick={() => setLayout('focus')} disabled={!focusId}>focus</button>
          <button className="nyna-action nyna-action-primary" onClick={startDiscovery} disabled={busy === 'start'}>
            {busy === 'start' ? 'starting…' : 'start research'}
          </button>
        </div>
      </header>

      {error ? <div className="nyna-scraper-error">{error}</div> : null}

      {layout === 'focus' && focusSession ? (
        <div className="nyna-scraper-focus">
          <FocusFrame session={focusSession} onBack={() => setLayout('grid')} />
        </div>
      ) : (
        <div className="nyna-scraper-grid">
          {sessions.length ? sessions.map((s) => (
            <SessionCard
              key={`${s.buildId || s.sessionId}:${s.sessionId}`}
              session={s}
              onFocus={() => { setFocusId(s.sessionId); setLayout('focus'); }}
            />
          )) : (
            <div className="nyna-rail-empty" style={{ gridColumn: '1 / -1', padding: 40 }}>
              // no browser-use sessions yet — kick off research above
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, good, bad }) {
  return (
    <div className={`nyna-scraper-stat ${good ? 'is-good' : ''} ${bad ? 'is-bad' : ''}`}>
      <span className="nyna-scraper-stat-k">{k}</span>
      <span className="nyna-scraper-stat-v">{v}</span>
    </div>
  );
}

function SessionCard({ session, onFocus }) {
  const liveUrl = session.liveUrl || session.projectUrl;
  return (
    <article className="nyna-scraper-card">
      <header className="nyna-scraper-card-head">
        <div style={{ minWidth: 0 }}>
          <div className="nyna-scraper-card-title">{session.businessName || 'Browser session'}</div>
          <div className="nyna-scraper-card-meta">
            <span>{session.source || session.sourceType || 'browser'}</span>
            <span>step {session.stepCount ?? 0}</span>
            <span>${session.totalCostUsd || '0'}</span>
          </div>
        </div>
        <span className={`nyna-scraper-card-status-pill ${statusClass(session.statusGroup)}`}>
          <span className="nyna-scraper-card-status-pill-dot" />
          {session.statusGroup || 'idle'}
        </span>
      </header>

      <div className="nyna-scraper-card-frame">
        {liveUrl ? (
          <iframe
            title={`browser-use ${session.sessionId}`}
            src={liveUrl}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
          />
        ) : session.screenshotUrl ? (
          <img src={session.screenshotUrl} alt="screenshot" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div className="nyna-scraper-card-placeholder">
            no live url yet · {session.lastStepSummary || session.task || 'waiting'}
          </div>
        )}
      </div>

      <footer className="nyna-scraper-card-foot">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <div className="nyna-scraper-card-meta" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.lastStepSummary || session.task || '—'}
          </div>
        </div>
        <div className="nyna-scraper-card-foot-actions">
          {liveUrl ? <a className="nyna-mini-btn" href={liveUrl} target="_blank" rel="noreferrer">open ↗</a> : null}
          <button className="nyna-mini-btn" onClick={onFocus} disabled={!liveUrl}>focus</button>
        </div>
      </footer>
    </article>
  );
}

function FocusFrame({ session, onBack }) {
  const liveUrl = session.liveUrl || session.projectUrl;
  return (
    <div className="nyna-scraper-focus-frame">
      <header className="nyna-scraper-focus-head">
        <button className="nyna-mini-btn" onClick={onBack}>← back to grid</button>
        <div className="nyna-scraper-focus-title">{session.businessName || session.sessionId}</div>
        <span className="nyna-scraper-card-meta">{session.source || session.sourceType} · step {session.stepCount ?? 0}</span>
      </header>
      <div className="nyna-scraper-focus-iframe">
        {liveUrl ? (
          <iframe title="browser-use focus" src={liveUrl} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
        ) : (
          <div className="nyna-scraper-card-placeholder">waiting for live url…</div>
        )}
      </div>
    </div>
  );
}
