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

function serviceLabel(service) {
  if (!service) return '';
  if (typeof service === 'string') return service;
  return service.name || service.title || service.description || '';
}

export default function BuildQAConsole({ qa, handoffCases = [] }) {
  const validation = useMemo(() => latestValidation(qa), [qa]);
  const hooks = useMemo(() => hookRows(qa), [qa]);
  const latestQa = qa?.latestQa || qa?.qaResults?.[0] || null;
  const checklist = latestQa?.checklist || [];
  const websiteBrief = qa?.websiteBrief || null;
  const launch = qa?.launchChecklist || latestQa?.launchReadiness || null;
  const launchItems = launch?.items || latestQa?.launchChecklist || latestQa?.claims?.launchChecklist || [];
  const screenshots = latestQa?.screenshots || latestQa?.claims?.screenshots || launch?.screenshotUrls || [];
  const revisions = qa?.revisions || [];

  if (!qa || (!hooks.length && !latestQa && !validation && !handoffCases.length)) {
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
            <span className="qa-title mono">website brief</span>
            <span className="note mono">v{websiteBrief?.schemaVersion || 'n/a'}</span>
          </div>
          {websiteBrief ? (
            <div className="qa-errors">
              <div className="qa-error-row"><span className="qa-error-code mono">hero</span><span>{websiteBrief.hero?.headline || websiteBrief.businessName}</span></div>
              <div className="qa-error-row"><span className="qa-error-code mono">cta</span><span>{websiteBrief.cta || websiteBrief.hero?.primaryCta || '—'}</span></div>
              <div className="qa-error-row"><span className="qa-error-code mono">area</span><span>{websiteBrief.locationOrServiceArea || websiteBrief.location?.serviceArea || '—'}</span></div>
              <div className="qa-error-row"><span className="qa-error-code mono">services</span><span>{(websiteBrief.services || []).map(serviceLabel).filter(Boolean).slice(0, 5).join(', ') || '—'}</span></div>
              <div className="qa-error-row"><span className="qa-error-code mono">contact</span><span>{(websiteBrief.contactMethods || []).map((m) => m.label || m.type).join(', ') || '—'}</span></div>
            </div>
          ) : (
            <div className="qa-muted mono">// no structured brief recorded yet</div>
          )}
        </div>

        <div className="qa-panel">
          <div className="qa-panel-head">
            <span className="qa-title mono">launch readiness</span>
            <span className={`qa-mini qa-mini-${launch?.readyToLaunch || launch?.launched ? 'good' : latestQa?.passed ? 'warn' : 'muted'}`}>
              {launch?.status || 'pending'}
            </span>
          </div>
          <div className="qa-errors">
            <div className="qa-error-row"><span className="qa-error-code mono">score</span><span>{launch?.score ?? latestQa?.score ?? 0}</span></div>
            <div className="qa-error-row"><span className="qa-error-code mono">preview</span><span>{launch?.previewUrl || qa?.build?.live_url || '—'}</span></div>
            <div className="qa-error-row"><span className="qa-error-code mono">final</span><span>{launch?.finalUrl || qa?.build?.project_url || '—'}</span></div>
            <div className="qa-error-row"><span className="qa-error-code mono">blocking</span><span>{(launch?.launchBlocking || launch?.errors || []).join(', ') || 'none'}</span></div>
          </div>
        </div>
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
          <span className="qa-title mono">launch checklist</span>
          <span className="note mono">{launchItems.length ? `${launchItems.filter((item) => item.passed).length}/${launchItems.length}` : 'pending'}</span>
        </div>
        <div className="qa-checklist">
          {launchItems.length ? launchItems.map((item) => (
            <div key={item.key || item.label} className={`qa-check qa-check-${item.passed ? 'good' : 'bad'}`}>
              <span className={`qa-check-state qa-check-state-${item.passed ? 'good' : 'bad'}`}>{item.passed ? 'pass' : 'wait'}</span>
              <span className="qa-check-label">{item.label || labelize(item.key)}</span>
              <span className="qa-check-detail">{item.detail}</span>
            </div>
          )) : (
            <div className="qa-muted mono">// launch checklist will appear after site QA</div>
          )}
        </div>
      </div>

      <div className="qa-panel">
        <div className="qa-panel-head">
          <span className="qa-title mono">proof artifacts</span>
          <span className="note mono">{screenshots.length ? `${screenshots.length} screenshots` : 'no screenshot capture'}</span>
        </div>
        <div className="qa-errors">
          <div className="qa-error-row"><span className="qa-error-code mono">inspected</span><span>{latestQa?.claims?.inspectedUrl || latestQa?.url || '—'}</span></div>
          <div className="qa-error-row"><span className="qa-error-code mono">links</span><span>{latestQa?.claims?.links?.length ?? 0}</span></div>
          <div className="qa-error-row"><span className="qa-error-code mono">claims</span><span>{latestQa?.claims?.found?.length ? latestQa.claims.found.map((c) => c.code).join(', ') : 'none'}</span></div>
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

      {handoffCases.length ? (
        <div className="qa-panel qa-handoff-panel">
          <div className="qa-panel-head">
            <span className="qa-title mono">operator handoff</span>
            <span className="qa-mini qa-mini-bad">{handoffCases.length} case{handoffCases.length === 1 ? '' : 's'}</span>
          </div>
          <div className="qa-errors">
            {handoffCases.slice(0, 3).map((item) => (
              <div key={item.id} className="qa-error-row">
                <span className="qa-error-code mono">{labelize(item.category)}</span>
                <span>{item.summary}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
