import React, { useCallback, useEffect, useMemo, useState } from 'react';

const MEMORY_KINDS = [
  'research_evidence',
  'business_profile',
  'presence_score',
  'pitch',
  'call_transcript',
  'call_analysis',
  'mail_thread',
  'invoice',
  'build_brief',
  'build_result',
  'growth_plan',
  'commerce_plan',
  'compliance_decision'
];

const styles = {
  table: { display: 'flex', flexDirection: 'column', gap: 6 },
  businessRow: { display: 'grid', gridTemplateColumns: '1.2fr 1.2fr 70px 92px 70px', gap: 8, alignItems: 'center', minWidth: 0 },
  ledgerRow: { display: 'grid', gridTemplateColumns: '1fr 1.7fr 92px 1.25fr 80px', gap: 8, alignItems: 'center', minWidth: 0 },
  headRow: { color: 'var(--ink-400)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' },
  focusRow: { outline: '1px solid var(--accent)', outlineOffset: 2 },
  searchForm: { display: 'grid', gridTemplateColumns: '1fr 150px auto', gap: 8, alignItems: 'center' },
  input: { width: '100%', minWidth: 0, border: '1px solid var(--line-strong)', background: 'var(--bg-0)', color: 'var(--ink-100)', padding: '8px 9px', fontSize: 11 },
  hitList: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 },
  hit: { border: '1px solid var(--line)', background: 'var(--bg-1)', padding: 9, color: 'var(--ink-100)', fontSize: 12 },
  hitHead: { display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5, color: 'var(--ink-300)' },
  failureList: { display: 'flex', flexDirection: 'column', gap: 8 }
};

async function jsonOr(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function request(method, path, body) {
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

function labelize(value) {
  return String(value || '').replace(/_/g, ' ');
}

function short(value, n = 80) {
  const s = String(value || '');
  return s.length > n ? `${s.slice(0, n - 1)}...` : s;
}

function time(value) {
  if (!value) return 'never';
  return new Date(value).toLocaleTimeString();
}

function rowTime(value) {
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

export default function MemoryConsole({ leadId }) {
  const [businesses, setBusinesses] = useState([]);
  const [observability, setObservability] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const selectedBusiness = useMemo(
    () => businesses.find((row) => row.leadId === leadId) || null,
    [businesses, leadId]
  );

  const refresh = useCallback(async () => {
    try {
      const [businessData, obsData, ledgerData] = await Promise.all([
        request('GET', '/api/memory/businesses'),
        request('GET', '/api/memory/observability'),
        leadId ? request('GET', `/api/leads/${leadId}/memory`) : Promise.resolve(null)
      ]);
      setBusinesses(businessData?.businesses || []);
      setObservability(obsData || null);
      setLedger(ledgerData);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [leadId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the memory panel in sync with live memory + research traffic so
  // discovered businesses appear without manual refresh.
  useEffect(() => {
    const stream = new EventSource('/api/events/stream');
    let timer = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 400);
    };
    const handle = (data) => {
      try {
        const evt = JSON.parse(data);
        if (!evt?.type) return;
        if (
          evt.type === 'lead.created' ||
          evt.type === 'memory.write.queued' ||
          evt.type === 'memory.write.succeeded' ||
          evt.type === 'memory.write.failed' ||
          evt.type === 'memory.status.checked' ||
          evt.type === 'research.evidence.captured' ||
          evt.type === 'research.job.completed'
        ) schedule();
      } catch {
        // ignore malformed event payloads
      }
    };
    const onMessage = (event) => handle(event.data);
    stream.addEventListener('message', onMessage);
    for (const name of [
      'lead.created',
      'memory.write.queued',
      'memory.write.succeeded',
      'memory.write.failed',
      'memory.status.checked',
      'research.evidence.captured',
      'research.job.completed'
    ]) stream.addEventListener(name, onMessage);
    return () => {
      if (timer) clearTimeout(timer);
      stream.close();
    };
  }, [refresh]);

  const runSearch = useCallback(async (event) => {
    event?.preventDefault?.();
    if (!leadId || !query.trim()) return;
    setBusy('search');
    try {
      const data = await request('POST', `/api/leads/${leadId}/memory/search`, {
        q: query.trim(),
        kind: kind || undefined,
        limit: 8
      });
      setHits(data?.results || []);
      await refresh();
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }, [kind, leadId, query, refresh]);

  const retryFailed = useCallback(async () => {
    setBusy('retry');
    try {
      await request('POST', '/api/memory/retry-failed', { limit: 25 });
      await refresh();
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const failedWrites = ledger?.failures?.filter((row) => !row.resolved_at && row.action === 'write') ||
    observability?.failedWrites?.filter((row) => row.action === 'write') ||
    [];
  const docs = ledger?.documents || [];
  const searches = ledger?.searches || [];
  const totals = observability?.totals || {};

  return (
    <section className="memory-console memory-console-overhaul">
      <div className="memory-obs-strip mono">
        <span><span className="memory-obs-key">provider</span> <span className="memory-obs-val">{observability?.provider?.mode || 'checking'}</span></span>
        <span><span className="memory-obs-key">docs</span> <span className="memory-obs-val">{totals.documents || 0}</span></span>
        <span><span className="memory-obs-key">searches</span> <span className="memory-obs-val">{totals.searches || 0}</span></span>
        <span><span className="memory-obs-key">isolation</span> <span className="memory-obs-val">{totals.isolation?.ok || 0}/{totals.isolation?.total || 0}</span></span>
        <span><span className="memory-obs-key">queue</span> <span className="memory-obs-val">{queueSummary(totals.queue)}</span></span>
        <span><span className="memory-obs-key">retryable</span> <span className="memory-obs-val">{totals.retryableFailures || 0}</span></span>
        <button className="btn btn-mini" onClick={refresh} disabled={busy === 'refresh'} style={{ marginLeft: 'auto' }}>refresh</button>
      </div>
      {error ? <div className="research-stop"><div className="research-stop-title">memory error</div><div className="research-stop-copy">{error}</div></div> : null}

      <div className="memcard open">
        <div className="memcard-head">
          <span className="mono memcard-key">businesses found</span>
          <span className="memcard-tag mono">{businesses.length} leads</span>
          <span />
        </div>
        <div className="memcard-body">
          <div className="memory-table memory-table-businesses" style={styles.table}>
            <div className="memory-row memory-row-head mono" style={{ ...styles.businessRow, ...styles.headRow }}>
              <span>business</span><span>container</span><span>docs</span><span>isolation</span><span>failures</span>
            </div>
            {businesses.map((business) => (
              <div
                key={business.leadId}
                className={`memory-row ${business.leadId === leadId ? 'memory-row-focus' : ''}`}
                style={{ ...styles.businessRow, ...(business.leadId === leadId ? styles.focusRow : null) }}
              >
                <span>{short(business.businessName, 34)}</span>
                <span className="mono">{business.containerTag}</span>
                <span className="mono">{business.documentCount}/{business.writtenCount}</span>
                <span className={`chip ${business.isolation?.ok ? 'chip-presence-strong' : 'chip-pay-failed'}`}>
                  {business.isolation?.ok ? 'isolated' : 'mismatch'}
                </span>
                <span className="mono">{business.unresolvedFailureCount || 0}</span>
              </div>
            ))}
            {!businesses.length ? <div className="mono note">// no business containers yet — click Start research now</div> : null}
          </div>
        </div>
      </div>

      {selectedBusiness ? (
        <div className="memcard open">
          <div className="memcard-head">
            <span className="mono memcard-key">per-lead ledger</span>
            <span className="mono memcard-tag">{selectedBusiness.businessName}</span>
            <span className={`chip ${ledger?.isolation?.ok ? 'chip-presence-strong' : 'chip-pay-failed'}`}>
              {ledger?.containerTag || selectedBusiness.containerTag}
            </span>
          </div>
          <div className="memcard-body">
            <div className="memory-table memory-table-ledger" style={styles.table}>
              <div className="memory-row memory-row-head mono" style={{ ...styles.ledgerRow, ...styles.headRow }}>
                <span>kind</span><span>customId</span><span>status</span><span>source event</span><span>updated</span>
              </div>
              {docs.map((doc) => (
                <div key={doc.custom_id} className="memory-row" style={styles.ledgerRow}>
                  <span>{labelize(doc.kind)}</span>
                  <span className="mono">{short(doc.custom_id, 44)}</span>
                  <span className={`chip ${doc.write_status === 'failed' ? 'chip-pay-failed' : doc.write_status === 'queued' ? 'chip-pay-created' : 'chip-presence-strong'}`}>{doc.write_status}</span>
                  <span className="mono">{short(doc.source_event, 34)}</span>
                  <span className="mono">{time(doc.updated_at)}</span>
                </div>
              ))}
              {!docs.length ? <div className="mono note">// no mirrored memory documents yet.</div> : null}
            </div>
          </div>
        </div>
      ) : null}

      <details className="memory-more">
        <summary>
          <span>search retrieval · {searches.length} logged</span>
          <span className="memory-more-toggle" />
        </summary>
        <div className="memory-more-body">
          <form className="memory-search-form" onSubmit={runSearch} style={styles.searchForm}>
            <input
              className="input mono"
              style={styles.input}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="search this lead's memory"
            />
            <select className="input mono" style={styles.input} value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">all kinds</option>
              {MEMORY_KINDS.map((item) => <option key={item} value={item}>{labelize(item)}</option>)}
            </select>
            <button className="btn" disabled={!query.trim() || busy === 'search'}>{busy === 'search' ? 'searching' : 'search'}</button>
          </form>
          <div className="memory-hit-list" style={styles.hitList}>
            {hits.map((hit, index) => (
              <div key={`${hit.documentId || hit.id || index}`} className="memory-hit" style={styles.hit}>
                <div className="memory-hit-head" style={styles.hitHead}>
                  <span className="mono">{hit.metadata?.kind || 'memory'}</span>
                  <span className="mono">{score(hit.score ?? hit.similarity)}</span>
                </div>
                <div>{short(hit.summary || hit.content || hit.chunks?.[0]?.content, 240)}</div>
                <div className="mono note">{hit.customId || hit.documentId || hit.id}</div>
              </div>
            ))}
            {!hits.length ? <div className="mono note">// run a scoped retrieval query to see hits.</div> : null}
          </div>
        </div>
      </details>

      <details className="memory-more" {...(failedWrites.length ? { open: true } : {})}>
        <summary>
          <span>failed writes · {failedWrites.length} unresolved</span>
          <span className="memory-more-toggle" />
        </summary>
        <div className="memory-more-body">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
            <button className="btn btn-mini" onClick={retryFailed} disabled={!failedWrites.length || busy === 'retry'}>
              {busy === 'retry' ? 'retrying' : 'retry all'}
            </button>
          </div>
          <div className="memory-failure-list" style={styles.failureList}>
            {failedWrites.slice(0, 12).map((failure) => (
              <div key={failure.id} className="memory-failure" style={styles.hit}>
                <div className="memory-hit-head" style={styles.hitHead}>
                  <span className="chip chip-pay-failed">{failure.category}</span>
                  <span className="mono">{rowTime(failure.created_at)}</span>
                </div>
                <div>{failure.error}</div>
                <div className="mono note">{failure.custom_id || failure.container_tag}</div>
              </div>
            ))}
            {!failedWrites.length ? <div className="mono note">// no failed Supermemory writes waiting for retry.</div> : null}
          </div>
        </div>
      </details>
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="research-item">
      <div className="research-key mono">{label}</div>
      <div className="research-value mono">{value}</div>
    </div>
  );
}

function queueSummary(queue = {}) {
  const entries = Object.entries(queue || {}).filter(([, value]) => value);
  if (!entries.length) return 'empty';
  return entries.map(([key, value]) => `${key}:${value}`).join(' ');
}

function score(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'score n/a';
  return `score ${n.toFixed(2)}`;
}
