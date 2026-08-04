import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const STEPS = [
  ['received', 'Request received'],
  ['claimed', 'Operator review'],
  ['researching', 'Research in progress'],
  ['ready_for_review', 'Ready for next step'],
  ['contacted', 'Contact recorded']
];

function statusIndex(status) {
  if (status === 'rejected' || status === 'failed') return -1;
  const index = STEPS.findIndex(([key]) => key === status);
  return index < 0 ? 0 : index;
}

function formatDate(value) {
  if (!value) return 'not recorded';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function PublicIntakeTrackView({ token }) {
  const [state, setState] = useState({ loading: true, error: '', data: null });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState((current) => ({ ...current, loading: true, error: '' }));
    else setRefreshing(true);
    try {
      const data = await api.publicIntakeStatus(token);
      setState({ loading: false, error: '', data });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error?.message || 'Tracking link unavailable.' }));
    } finally {
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    const interval = window.setInterval(() => load(true), 6000);
    return () => window.clearInterval(interval);
  }, [load]);

  const request = state.data?.request;
  const currentIndex = statusIndex(request?.status);
  const terminal = request?.status === 'failed' || request?.status === 'rejected';

  return (
    <div className="public-site public-track-site">
      <header className="public-nav"><a className="public-brand" href="/"><span className="public-brand-mark">*</span><span>Callan</span></a><a className="public-nav-console" href="/">New request</a></header>
      <main className="public-track-main">
        <div className="public-section-label">private request status</div>
        {state.loading && !state.data ? <div className="public-track-loading" role="status">Loading your request...</div> : null}
        {state.error && !state.data ? <section className="public-track-error" role="alert"><h1>That tracking link is unavailable.</h1><p>{state.error}</p><a className="public-button public-button-primary" href="/">Start a new request</a></section> : null}
        {request ? (
          <>
            <section className="public-track-heading"><div><h1>{request.businessName}</h1><p>{request.niche} / {request.city}</p></div><button className="public-refresh-button" type="button" onClick={() => load(true)} disabled={refreshing}>{refreshing ? 'Refreshing...' : 'Refresh status'} <span aria-hidden="true">[refresh]</span></button></section>
            <section className={`public-track-state ${terminal ? 'is-terminal' : ''}`} aria-live="polite">
              <div><span className="public-status-dot" /><strong>{terminal ? (request.status === 'failed' ? 'Needs operator attention' : 'Request closed') : STEPS[currentIndex]?.[1]}</strong><p>{request.finalMessage || 'The request is saved. Progress and next actions will appear here.'}</p></div>
              <span className="public-track-updated">Updated {formatDate(request.updatedAt)}</span>
            </section>
            <ol className="public-progress-list" aria-label="Request progress">
              {STEPS.map(([key, label], index) => {
                const done = !terminal && index < currentIndex;
                const active = !terminal && index === currentIndex;
                return <li key={key} className={`${done ? 'is-done' : ''} ${active ? 'is-active' : ''}`}><span>{done ? 'done' : String(index + 1).padStart(2, '0')}</span><div><strong>{label}</strong><small>{active ? 'Current state' : done ? 'Complete' : 'Waiting'}</small></div></li>;
              })}
            </ol>
            <section className="public-track-timeline"><div className="public-section-label">activity</div><h2>What has happened</h2>{state.data.events?.length ? <ul>{state.data.events.map((event) => <li key={`${event.eventType}-${event.createdAt}`}><span>{formatDate(event.createdAt)}</span><div><strong>{event.summary}</strong><small>{event.eventType.replaceAll('_', ' ')}</small></div></li>)}</ul> : <p>No activity has been recorded yet.</p>}</section>
            <p className="public-track-boundary">This link shows request progress only. Contact details and operator controls stay private.</p>
          </>
        ) : null}
      </main>
      <footer className="public-footer"><a className="public-brand" href="/"><span className="public-brand-mark">*</span><span>Callan</span></a><span>Visible work for local businesses.</span><a href="/app">Operator console</a></footer>
    </div>
  );
}
