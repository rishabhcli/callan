import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const PROVIDERS = [
  ['gemini', 'Gemini', 'structured reasoning'],
  ['supermemory', 'Supermemory', 'durable memory'],
  ['moss', 'Moss', 'call index'],
  ['agentphone', 'AgentPhone', 'voice calls'],
  ['browserUse', 'Browser Use', 'research browser'],
  ['lovable', 'Lovable', 'site builder'],
  ['v0', 'v0', 'alternate builder'],
  ['agentmail', 'AgentMail', 'mail threads'],
  ['stripe', 'Stripe', 'payments']
];

function dateLabel(value) {
  if (!value) return 'not checked';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function localStatus(receipt, readiness) {
  if (receipt?.status === 'verified_local') return 'verified locally';
  if (receipt?.status === 'blocked_configuration') return 'configuration blocked';
  if (readiness?.configured) return 'configured';
  return 'not configured';
}

export default function IntegrationsView({ health }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState('gemini');
  const [history, setHistory] = useState([]);
  const [state, setState] = useState({ loading: true, verifying: '', error: '', result: null });

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const result = await api.integrations();
      setData(result);
      setState((current) => ({ ...current, loading: false }));
    } catch (error) {
      setState({ loading: false, verifying: '', error: error?.message || 'Could not load integration posture.', result: null });
    }
  }, []);

  const loadHistory = useCallback(async (provider) => {
    try { setHistory((await api.integrationHistory(provider)).receipts || []); } catch { setHistory([]); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadHistory(selected); }, [selected, loadHistory, data]);

  const item = data?.providers?.[selected];
  const providerLabel = useMemo(() => PROVIDERS.find(([key]) => key === selected)?.[1] || selected, [selected]);

  async function verify() {
    setState((current) => ({ ...current, verifying: selected, error: '', result: null }));
    try {
      const result = await api.verifyIntegration(selected, `console:${selected}:${Date.now().toString(36)}`);
      setState((current) => ({ ...current, verifying: '', result }));
      await load();
      await loadHistory(selected);
    } catch (error) {
      setState((current) => ({ ...current, verifying: '', error: error?.message || 'Verification failed.' }));
    }
  }

  return (
    <div className="integration-workspace">
      <header className="integration-head"><div><div className="nyna-detail-subtitle">operator controls</div><h1>integration workbench</h1><p>Run a redacted local adapter check before spending a provider call. Local verification never clears a production live gate.</p></div><div className="integration-mode"><span>runtime mode</span><strong>{String(data?.mode || health?.mode || 'loading').toUpperCase()}</strong></div></header>
      {state.error ? <div className="request-alert" role="alert">{state.error}</div> : null}
      <div className="integration-layout">
        <section className="integration-provider-list" aria-label="Integration providers"><div className="request-panel-head"><span>provider registry</span><span>{PROVIDERS.length} adapters</span></div>{PROVIDERS.map(([key, label, purpose]) => { const provider = data?.providers?.[key]; return <button type="button" key={key} className={`integration-provider-row ${selected === key ? 'is-selected' : ''}`} onClick={() => setSelected(key)}><span className={`integration-provider-dot ${provider?.readiness?.configured ? 'is-configured' : ''}`} /><span><strong>{label}</strong><small>{purpose}</small></span><em>{localStatus(provider?.latestReceipt, provider?.readiness)}</em></button>; })}</section>
        <section className="integration-detail" aria-label={`${providerLabel} integration detail`}>
          {!item ? <div className="request-empty">Loading provider posture...</div> : (
            <>
              <div className="integration-detail-head"><div><div className="public-section-label">selected adapter</div><h2>{providerLabel}</h2><p>{PROVIDERS.find(([key]) => key === selected)?.[2]}</p></div><span className={`request-status-badge ${item.readiness?.configured ? 'is-configured' : 'is-blocked'}`}>{item.readiness?.configured ? 'configured' : 'credential gate'}</span></div>
              <div className="integration-facts"><div><span>adapter status</span><strong>{item.readiness?.status || 'unknown'}</strong></div><div><span>last local receipt</span><strong>{dateLabel(item.latestReceipt?.created_at)}</strong></div><div><span>required in mode</span><strong>{item.readiness?.required ? 'yes' : 'no'}</strong></div><div><span>live smoke</span><strong>{item.readiness?.liveSmoke?.status || 'not run'}</strong></div></div>
              <div className="integration-check-panel"><div><h3>Local adapter verification</h3><p>Checks the provider policy, required environment names, and redaction boundary. It makes no external request.</p></div><button className="nyna-action nyna-action-primary" type="button" onClick={verify} disabled={!!state.verifying}>{state.verifying === selected ? 'Verifying...' : 'Run local verification'} <span aria-hidden="true">-&gt;</span></button></div>
              {state.result ? <div className="integration-result" role="status"><div><strong>{state.result.receipt?.status === 'verified_local' ? 'Local adapter verified' : 'Configuration remains blocked'}</strong><span>receipt {state.result.receipt?.id}</span></div><p>{state.result.note}</p><dl><div><dt>external call</dt><dd>{String(state.result.receipt?.response?.externalCall ?? false)}</dd></div><div><dt>side effects</dt><dd>{String(state.result.receipt?.response?.sideEffects ?? false)}</dd></div><div><dt>next action</dt><dd>{state.result.receipt?.response?.nextAction || 'see readiness'}</dd></div></dl></div> : null}
              <div className="integration-blockers"><div className="public-section-label">readiness evidence</div><h3>What still blocks this provider</h3>{item.readiness?.blockerReasons?.length ? <ul>{item.readiness.blockerReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : <p>No current blocker is reported by the readiness contract.</p>}</div>
              <div className="integration-history"><div className="public-section-label">receipt history</div><h3>Local checks</h3>{history.length ? <ul>{history.slice(0, 8).map((receipt) => <li key={receipt.id}><span className={`integration-history-status is-${receipt.status}`}>{receipt.status.replaceAll('_', ' ')}</span><div><strong>{dateLabel(receipt.created_at)}</strong><small>{receipt.actor} · {receipt.verification_kind} · {receipt.duration_ms ?? 0}ms</small></div></li>)}</ul> : <p>No local receipt yet. Run the check to create one.</p>}</div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
