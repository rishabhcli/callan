import React, { useMemo } from 'react';
import './LoopView.css';

const STAGE_COPY = [
  { key: 'spec', label: 'Spec', copy: 'Turn business evidence into explicit constraints.' },
  { key: 'plan', label: 'Plan', copy: 'Choose the next action and define acceptance checks.' },
  { key: 'act', label: 'Act', copy: 'Build the customer site through the provider runtime.' },
  { key: 'observe', label: 'Observe', copy: 'Inspect the output against claims, content, and launch gates.' },
  { key: 'repair', label: 'Repair', copy: 'Write a targeted revision from the failed checks.' },
  { key: 'verify', label: 'Verify', copy: 'Re-test and release only when the evidence passes.' }
];

const EVENT_LABELS = {
  'builder.start': 'Build started',
  'builder.submission_created': 'Plan submitted',
  'builder.live_url': 'Preview opened',
  'builder.provider_action': 'Provider action completed',
  'builder.progress': 'Build advanced',
  'builder.qa': 'Output inspected',
  'builder.revision': 'Correction planned',
  'builder.project_url': 'Project URL captured',
  'builder.done': 'Build verified',
  'builder.released': 'Customer site released',
  'builder.error': 'Build stopped'
};

function timeLabel(value) {
  if (!value) return 'pending';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'pending';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function sentence(value) {
  const text = String(value || '').replace(/[_-]+/g, ' ').trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
}

function stageStates({ lead, qa, buildState }) {
  const hooks = qa?.hooks || [];
  const qaResults = qa?.qaResults || [];
  const revisions = qa?.revisions || [];
  const latestQa = qa?.latestQa || qaResults[0] || null;
  const buildStatus = buildState?.status || qa?.build?.status || 'not_started';
  const buildRunning = ['queued', 'running', 'qa_review', 'building'].includes(buildStatus);
  const buildStarted = Boolean(qa?.build || buildState?.latestBuildId || buildRunning);
  const specDone = Boolean(qa?.websiteBrief || hooks.some((hook) => hook.hook === 'preBrief'));
  const planDone = Boolean(qa?.validation?.ok || hooks.some((hook) => ['briefValidate', 'preSubmit'].includes(hook.hook)));
  const observed = qaResults.length > 0;
  const repaired = revisions.length > 0;
  const verified = latestQa?.passed === true;
  const exhausted = latestQa?.passed === false && revisions.length >= Number(qa?.maxRevisions ?? 0);

  return {
    spec: specDone ? 'done' : lead ? 'active' : 'waiting',
    plan: planDone ? 'done' : specDone ? 'active' : 'waiting',
    act: buildRunning ? 'active' : buildStarted ? 'done' : planDone ? 'active' : 'waiting',
    observe: observed ? 'done' : buildStarted && !buildRunning ? 'active' : 'waiting',
    repair: repaired ? 'done' : verified ? 'skipped' : latestQa?.passed === false ? 'active' : 'waiting',
    verify: verified ? 'done' : exhausted ? 'failed' : observed ? 'active' : 'waiting'
  };
}

function proofCopy(qa) {
  const results = qa?.qaResults || [];
  const failed = results.find((row) => row?.passed === false) || null;
  const latest = qa?.latestQa || results[0] || null;
  const revision = qa?.revisions?.[0] || null;
  const errors = failed?.errors || [];

  return {
    failed,
    latest,
    revision,
    observed: failed
      ? `${errors.length} acceptance ${errors.length === 1 ? 'check' : 'checks'} failed: ${errors.slice(0, 3).map(sentence).join(', ')}${errors.length > 3 ? ', and more' : ''}.`
      : latest?.passed
        ? 'The first inspected output met every recorded acceptance check.'
        : 'No generated output has been inspected yet.',
    repaired: revision
      ? `Callan created revision ${revision.attempt || 1} from the failed checks and submitted a narrower correction.`
      : latest?.passed
        ? 'No correction was necessary for this run.'
        : 'A correction will be generated from the failed checks, not from a generic retry.',
    verified: latest?.passed
      ? `The corrected output passed with a QA score of ${latest.score ?? '—'} and moved to customer approval.`
      : latest
        ? `Verification is still blocked by ${(latest.errors || []).length || 'unresolved'} checks.`
        : 'Release remains blocked until a fresh inspection passes.'
  };
}

function eventSummary(event) {
  return event.error || event.summary || event.lastStepSummary || EVENT_LABELS[event.type] || sentence(event.type);
}

export default function LoopView({
  leads = [],
  focusedLeadId,
  leadDetail,
  builderInfo,
  builderAction,
  sseStatus,
  health,
  onFocusLead,
  onRunBuild,
  onOpenWorkbench
}) {
  const lead = leadDetail?.lead || leads.find((row) => row.id === focusedLeadId) || null;
  const qa = leadDetail?.builderQa || null;
  const persistedBuild = leadDetail?.builderState || null;
  const liveBuild = builderInfo?.leadId === lead?.id ? builderInfo : null;
  const buildState = liveBuild?.status && liveBuild.status !== 'not_started'
    ? { ...persistedBuild, ...liveBuild }
    : persistedBuild;
  const stages = stageStates({ lead, qa, buildState });
  const proof = proofCopy(qa);
  const latestPayment = leadDetail?.payments?.[0] || null;
  const hasPaid = Boolean(latestPayment?.status === 'paid' || latestPayment?.paid_at || ['paid', 'awaiting_launch_approval', 'shipped'].includes(lead?.status));
  const buildRunning = builderAction?.running || ['queued', 'running', 'qa_review', 'building'].includes(buildState?.status);
  const previewUrl = buildState?.liveUrl || qa?.build?.live_url || null;
  const finalUrl = buildState?.finalSiteUrl || qa?.build?.published_url || null;
  const openCases = leadDetail?.handoff?.summary?.open || 0;

  const timeline = useMemo(() => {
    const rows = [...(persistedBuild?.timeline || [])];
    if (liveBuild?.timeline?.length) rows.push(...liveBuild.timeline);
    if (!rows.length && qa?.hooks?.length) {
      rows.push(...qa.hooks.map((hook) => ({
        id: hook.id,
        ts: hook.finished_at || hook.started_at,
        type: `hook.${hook.hook}`,
        summary: hook.summary || `${sentence(hook.hook)} ${hook.status || 'completed'}`
      })));
    }
    const coreEventTypes = new Set([
      'builder.start',
      'builder.live_url',
      'builder.progress',
      'builder.project_url',
      'builder.qa',
      'builder.revision',
      'builder.done',
      'builder.released',
      'builder.error'
    ]);
    const coreRows = rows.filter((row) => coreEventTypes.has(row.type) || row.type?.startsWith('hook.'));
    const seen = new Set();
    return (coreRows.length ? coreRows : rows)
      .filter((row) => {
        const key = row.id || `${row.type}:${row.ts}:${row.summary || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
      .slice(-7)
      .reverse();
  }, [liveBuild?.timeline, persistedBuild?.timeline, qa?.hooks]);

  const runStatus = proof.latest?.passed
    ? 'verified'
    : buildRunning
      ? 'running'
      : proof.latest
        ? 'blocked'
        : lead
          ? 'ready'
          : 'empty';

  return (
    <div className="loop-view">
      <div className="loop-canvas">
        <header className="loop-hero">
          <div className="loop-hero-copy">
            <div className="loop-kicker">Self-directing delivery loop</div>
            <h1>An agency that corrects its own work.</h1>
            <p>
              Callan researches a business, sells the work, builds the site, inspects the result,
              and writes its own revision when the output misses the spec.
            </p>
          </div>

          <div className="loop-run-control">
            <label htmlFor="loop-lead">Run in focus</label>
            <select
              id="loop-lead"
              value={focusedLeadId || ''}
              onChange={(event) => onFocusLead?.(event.target.value || null)}
              disabled={!leads.length}
            >
              {!leads.length ? <option value="">No runs yet</option> : null}
              {leads.map((row) => (
                <option key={row.id} value={row.id}>{row.business_name || row.id}</option>
              ))}
            </select>
            <div className="loop-runtime-line">
              <span className={`loop-runtime-dot is-${sseStatus || 'connecting'}`} />
              {String(health?.mode || 'initializing').replace(/_/g, ' ')} · {sseStatus || 'connecting'}
            </div>
          </div>
        </header>

        <section className="loop-stage-section" aria-labelledby="loop-stage-title">
          <div className="loop-section-head">
            <div>
              <span className="loop-section-index">01</span>
              <h2 id="loop-stage-title">The full build cycle</h2>
            </div>
            <span className={`loop-state loop-state-${runStatus}`}>{runStatus}</span>
          </div>

          <ol className="loop-stage-track">
            {STAGE_COPY.map((stage, index) => (
              <li key={stage.key} className={`loop-stage is-${stages[stage.key]}`}>
                <span className="loop-stage-number">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{stage.label}</strong>
                  <p>{stage.copy}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="loop-proof" aria-labelledby="loop-proof-title">
          <div className="loop-proof-intro">
            <span className="loop-section-index">02</span>
            <h2 id="loop-proof-title">Proof, not a loop diagram</h2>
            <p>
              {lead
                ? `Showing the persisted decisions for ${lead.business_name}. Every state below comes from the build and QA ledger.`
                : 'Run the mock lifecycle once and this surface will show the actual failed check, correction, and final acceptance.'}
            </p>
          </div>

          <div className="loop-proof-steps">
            <article>
              <span>Observed</span>
              <h3>{proof.failed ? 'The first pass failed.' : 'Inspection waits for output.'}</h3>
              <p>{proof.observed}</p>
            </article>
            <article>
              <span>Corrected</span>
              <h3>{proof.revision ? 'A targeted revision ran.' : 'Repair is conditional.'}</h3>
              <p>{proof.repaired}</p>
            </article>
            <article>
              <span>Verified</span>
              <h3>{proof.latest?.passed ? 'The second check passed.' : 'Shipment stays gated.'}</h3>
              <p>{proof.verified}</p>
            </article>
          </div>
        </section>

        <section className="loop-evidence" aria-labelledby="loop-evidence-title">
          <div className="loop-run-summary">
            <div className="loop-section-head">
              <div>
                <span className="loop-section-index">03</span>
                <h2 id="loop-evidence-title">Run evidence</h2>
              </div>
            </div>

            {lead ? (
              <dl className="loop-facts">
                <div><dt>Business</dt><dd>{lead.business_name}</dd></div>
                <div><dt>Current state</dt><dd>{sentence(lead.status || 'discovered')}</dd></div>
                <div><dt>QA result</dt><dd>{proof.latest ? `${proof.latest.passed ? 'Passed' : 'Failed'} · ${proof.latest.score ?? '—'}` : 'Not inspected'}</dd></div>
                <div><dt>Self-corrections</dt><dd>{qa?.revisions?.length || 0}</dd></div>
                <div><dt>Human handoffs</dt><dd>{openCases}</dd></div>
                <div><dt>Final site</dt><dd>{finalUrl ? 'Released' : 'Pending'}</dd></div>
              </dl>
            ) : (
              <div className="loop-empty">
                <strong>No lifecycle has been seeded.</strong>
                <p>Run the safe mock demo, then return here to inspect its evidence.</p>
                <code>npm run demo:e2e -- --data-dir .data/demo --reset-demo-data</code>
              </div>
            )}

            <div className="loop-actions">
              {previewUrl ? (
                <a className="loop-primary" href={previewUrl} target="_blank" rel="noreferrer">Open generated preview</a>
              ) : hasPaid ? (
                <button className="loop-primary" type="button" onClick={() => onRunBuild?.({})} disabled={buildRunning}>
                  {buildRunning ? 'Loop running…' : 'Run the build loop'}
                </button>
              ) : null}
              <button className="loop-secondary" type="button" onClick={onOpenWorkbench}>Open advanced workbench</button>
            </div>
            {builderAction?.error ? <p className="loop-action-error" role="alert">{builderAction.error}</p> : null}
          </div>

          <div className="loop-timeline">
            <div className="loop-timeline-head">
              <h3>Decision ledger</h3>
              <span>{timeline.length ? `${timeline.length} latest` : 'waiting'}</span>
            </div>
            {timeline.length ? (
              <ol>
                {timeline.map((event, index) => (
                  <li key={event.id || `${event.type}-${event.ts}-${index}`}>
                    <span className="loop-event-dot" />
                    <div>
                      <strong>{EVENT_LABELS[event.type] || sentence(event.type?.replace('hook.', ''))}</strong>
                      <p>{eventSummary(event)}</p>
                    </div>
                    <time>{timeLabel(event.ts)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="loop-timeline-empty">Events appear here as the builder plans, acts, inspects, and repairs.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
