import React, { useMemo } from 'react';

function labelize(value) {
  return String(value || '').replace(/_/g, ' ');
}

function formatWhen(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function statusTone(status, passed) {
  if (passed === true || status === 'completed' || status === 'passed' || status === 'submitted') return 'good';
  if (passed === false || status === 'failed' || status === 'blocked') return 'bad';
  if (status === 'running' || status === 'planned') return 'warn';
  return 'muted';
}

function latestValidation(qa) {
  return qa?.validation || [...(qa?.hooks || [])].reverse().find((hook) => hook.hook === 'briefValidate')?.output || null;
}

function hookRows(qa) {
  return [...(qa?.hooks || [])].slice().sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
}

export default function BuildQAConsole({ qa }) {
  const validation = useMemo(() => latestValidation(qa), [qa]);
  const hooks = useMemo(() => hookRows(qa), [qa]);
  const latestQa = qa?.latestQa || qa?.qaResults?.[0] || null;
  const checklist = latestQa?.checklist || [];
  const revisions = qa?.revisions || [];

  if (!qa || (!hooks.length && !latestQa && !validation)) {
    return (
      <section className="build-qa-console build-qa-empty">
        <div className="section-head">
          <span className="hd">build qa</span>
          <span className="mono note">waiting</span>
        </div>
        <div className="build-qa-empty-line mono">// hook validation and generated-site QA will appear before shipment.</div>
      </section>
    );
  }

  return (
    <section className="build-qa-console">
      <div className="section-head">
        <span className="hd">build qa</span>
        <span className={`qa-chip qa-chip-${statusTone(qa.status, latestQa?.passed)}`}>
          {latestQa ? `${latestQa.passed ? 'passed' : 'failed'} · ${latestQa.score ?? 0}` : labelize(qa.status)}
        </span>
      </div>

      <div className="qa-grid">
        <div className="qa-panel">
          <div className="qa-panel-head">
            <span className="qa-title mono">hook timeline</span>
            <span className="note mono">{hooks.length} hooks</span>
          </div>
          <div className="qa-hook-list">
            {hooks.map((hook) => (
              <div key={hook.id} className="qa-hook-row">
                <span className={`qa-dot qa-dot-${statusTone(hook.status)}`} />
                <span className="qa-hook-name">{hook.hook}</span>
                <span className={`qa-mini qa-mini-${statusTone(hook.status)}`}>{labelize(hook.status)}</span>
                <span className="qa-time mono">{formatWhen(hook.finished_at || hook.started_at)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="qa-panel">
          <div className="qa-panel-head">
            <span className="qa-title mono">brief validation</span>
            <span className={`qa-mini qa-mini-${validation?.ok ? 'good' : validation ? 'bad' : 'muted'}`}>
              {validation?.ok ? 'valid' : validation ? 'blocked' : 'pending'}
            </span>
          </div>
          <div className="qa-errors">
            {(validation?.errors || []).length ? validation.errors.map((error) => (
              <div key={`${error.code}:${error.field}`} className="qa-error-row">
                <span className="qa-error-code mono">{error.code}</span>
                <span>{error.message}</span>
              </div>
            )) : (
              <div className="qa-muted mono">// no validation errors</div>
            )}
          </div>
        </div>
      </div>

      <div className="qa-panel">
        <div className="qa-panel-head">
          <span className="qa-title mono">site checklist</span>
          <span className="note mono">{latestQa?.url || 'no generated URL inspected'}</span>
        </div>
        <div className="qa-checklist">
          {checklist.length ? checklist.map((item) => (
            <div key={item.key} className={`qa-check qa-check-${item.passed ? 'good' : 'bad'}`}>
              <span className={`qa-check-state qa-check-state-${item.passed ? 'good' : 'bad'}`}>{item.passed ? 'pass' : 'fail'}</span>
              <span className="qa-check-label">{item.label || labelize(item.key)}</span>
              <span className="qa-check-detail">{item.detail}</span>
            </div>
          )) : (
            <div className="qa-muted mono">// no generated site inspected yet</div>
          )}
        </div>
      </div>

      <div className="qa-panel">
        <div className="qa-panel-head">
          <span className="qa-title mono">revisions</span>
          <span className="note mono">{revisions.length}/{qa.maxRevisions ?? 0}</span>
        </div>
        <div className="qa-revisions">
          {revisions.length ? revisions.map((revision) => (
            <details key={revision.id} className="qa-revision">
              <summary>
                <span className={`qa-mini qa-mini-${statusTone(revision.status)}`}>{labelize(revision.status)}</span>
                <span>revision {revision.attempt}</span>
                <span className="qa-time mono">{formatWhen(revision.finished_at || revision.created_at)}</span>
              </summary>
              <pre className="raw mono">{revision.prompt}</pre>
              {revision.result ? <pre className="raw mono">{JSON.stringify(revision.result, null, 2)}</pre> : null}
            </details>
          )) : (
            <div className="qa-muted mono">// no revision prompts needed yet</div>
          )}
        </div>
      </div>
    </section>
  );
}
