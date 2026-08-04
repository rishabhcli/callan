import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const FILTERS = [
  ['', 'All requests'],
  ['received', 'Received'],
  ['claimed', 'Claimed'],
  ['researching', 'Researching'],
  ['ready_for_review', 'Ready for review'],
  ['failed', 'Needs attention'],
  ['rejected', 'Rejected']
];

const STATUS_LABELS = {
  received: 'received',
  claimed: 'claimed',
  researching: 'researching',
  ready_for_review: 'ready for review',
  contacted: 'contacted',
  failed: 'needs attention',
  rejected: 'rejected'
};

function dateLabel(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function RequestsView({ onFocusLead, onLeadChanged }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [data, setData] = useState({ requests: [], counts: {} });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [state, setState] = useState({ loading: true, error: '', action: '' });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const result = await api.listIntakeRequests({ q: query, status, limit: 200 });
      setData({ requests: result.requests || [], counts: result.counts || {} });
      setSelectedId((current) => (result.requests || []).some((row) => row.id === current) ? current : result.requests?.[0]?.id || null);
      setState((current) => ({ ...current, loading: false }));
    } catch (error) {
      setState({ loading: false, error: error?.message || 'Could not load intake requests.', action: '' });
    }
  }, [query, status]);

  const loadDetail = useCallback(async (id) => {
    if (!id) { setDetail(null); return; }
    try { setDetail(await api.intakeRequestEvents(id)); } catch (error) { setDetail({ error: error?.message || 'Could not load request history.' }); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDetail(selectedId); }, [selectedId, loadDetail]);

  const selected = useMemo(() => data.requests.find((row) => row.id === selectedId) || null, [data.requests, selectedId]);

  async function act(action) {
    if (!selected) return;
    setState((current) => ({ ...current, action }));
    try {
      await api.intakeAction(selected.id, action);
      await load();
      await loadDetail(selected.id);
      onLeadChanged?.(selected.lead_id);
    } catch (error) {
      setState((current) => ({ ...current, error: error?.message || `Could not ${action.replaceAll('_', ' ')}.`, action: '' }));
    } finally {
      setState((current) => ({ ...current, action: '' }));
    }
  }

  return (
    <div className="request-workspace">
      <header className="request-workspace-head">
        <div><div className="nyna-detail-subtitle">customer acquisition</div><h1>request queue</h1><p>Public briefs become reviewable work. Nothing here starts outreach by itself.</p></div>
        <div className="request-queue-total"><span>{Object.values(data.counts).reduce((sum, count) => sum + Number(count || 0), 0)}</span><small>saved requests</small></div>
      </header>

      <section className="request-controls" aria-label="Request filters">
        <label className="request-search"><span>Search requests</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Business, niche, city" /></label>
        <label className="request-filter"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}>{FILTERS.map(([value, label]) => <option value={value} key={value}>{label}{value && data.counts[value] ? ` / ${data.counts[value]}` : ''}</option>)}</select></label>
        <button className="nyna-action nyna-action-secondary" type="button" onClick={load} disabled={state.loading}>{state.loading ? 'Loading...' : 'Refresh queue'}</button>
      </section>

      {state.error ? <div className="request-alert" role="alert">{state.error}</div> : null}
      <div className="request-layout">
        <section className="request-list-panel" aria-label="Saved customer requests">
          <div className="request-panel-head"><span>{status ? STATUS_LABELS[status] : 'all requests'}</span><span>{data.requests.length} shown</span></div>
          {state.loading && !data.requests.length ? <div className="request-empty" role="status">Loading the request queue...</div> : null}
          {!state.loading && !data.requests.length ? <div className="request-empty"><strong>No requests match this view.</strong><span>Submit the public form to create a real request, or change the filter.</span><a href="/" className="nyna-action nyna-action-secondary">Open public form</a></div> : null}
          <div className="request-list">
            {data.requests.map((request) => <button type="button" className={`request-row ${selectedId === request.id ? 'is-selected' : ''}`} key={request.id} onClick={() => setSelectedId(request.id)}><span className={`request-status-dot is-${request.status}`} /><span className="request-row-main"><strong>{request.business_name}</strong><small>{request.niche} / {request.city}</small></span><span className="request-row-status">{STATUS_LABELS[request.status] || request.status}</span><time>{dateLabel(request.updated_at)}</time></button>)}
          </div>
        </section>

        <section className="request-detail-panel" aria-label="Selected request detail">
          {!selected ? <div className="request-detail-empty"><span className="request-detail-number">01</span><h2>Select a request</h2><p>Review the brief, research handoff, and auditable actions here.</p></div> : (
            <>
              <div className="request-detail-head"><div><div className="public-section-label">selected brief</div><h2>{selected.business_name}</h2><p>{selected.niche} / {selected.city}</p></div><span className={`request-status-badge is-${selected.status}`}>{STATUS_LABELS[selected.status] || selected.status}</span></div>
              <div className="request-fact-grid"><div><span>submitted</span><strong>{dateLabel(selected.created_at)}</strong></div><div><span>assigned</span><strong>{selected.assigned_to || 'unassigned'}</strong></div><div><span>research</span><strong>{selected.lead_research_status || 'new'}</strong></div><div><span>next action</span><strong>{selected.lead_next_action || 'review request'}</strong></div></div>
              <dl className="request-contact-grid"><div><dt>website</dt><dd>{selected.website || 'not supplied'}</dd></div><div><dt>phone</dt><dd>{selected.phone || 'not supplied'}</dd></div><div><dt>email</dt><dd>{selected.email || 'not supplied'}</dd></div><div><dt>notes</dt><dd>{selected.notes || 'No extra context.'}</dd></div></dl>
              <div className="request-actions"><button className="nyna-action nyna-action-secondary" type="button" onClick={() => act('claim')} disabled={state.action || selected.status === 'rejected'}>{state.action === 'claim' ? 'Claiming…' : 'Claim request'}</button><button className="nyna-action nyna-action-primary" type="button" onClick={() => act('start_research')} disabled={state.action || selected.status === 'researching' || selected.status === 'rejected'}>{state.action === 'start_research' ? 'Queueing…' : 'Start research'}</button><button className="nyna-action nyna-action-secondary" type="button" onClick={() => act('mark_reviewed')} disabled={state.action || selected.status === 'rejected'}>Mark ready for review</button><button className="nyna-action nyna-action-secondary" type="button" onClick={() => act('mark_contacted')} disabled={state.action || selected.status === 'rejected'}>Record contact</button><button className="nyna-action nyna-action-danger" type="button" onClick={() => act('reject')} disabled={state.action || selected.status === 'rejected'}>Reject</button></div>
              <div className="request-detail-footer"><button className="request-lead-link" type="button" onClick={() => onFocusLead?.(selected.lead_id)}>Focus linked lead <span aria-hidden="true">→</span></button>{selected.research_job_id ? <span className="mono">job {selected.research_job_id}</span> : null}</div>
              <div className="request-history"><div className="public-section-label">audit history</div><h3>Durable events</h3>{detail?.events?.length ? <ul>{detail.events.map((event) => <li key={event.id}><time>{dateLabel(event.createdAt)}</time><div><strong>{event.summary}</strong><small>{event.eventType.replaceAll('_', ' ')} · {event.actor}</small></div></li>)}</ul> : <p>No event history yet.</p>}</div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
