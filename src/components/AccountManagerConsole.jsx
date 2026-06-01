import React, { useMemo, useState } from 'react';
import { api } from '../api.js';

const KIND_LABELS = {
  promised_edit: 'Promised edit',
  stale_business_fact: 'Fact check',
  launch_followup: '24h launch',
  review_capture: 'Review',
  google_business_profile_hygiene: 'GBP hygiene',
  seasonal_hours: 'Seasonal hours',
  service_menu_changes: 'Service/menu',
  analytics_contact_flow_check: 'Analytics/contact',
  hosting_subscription_status: 'Hosting',
  renewal_closeout_health_check: 'Renewal closeout'
};

export default function AccountManagerConsole({ detail, focusedLeadId, onLeadChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [explain, setExplain] = useState({});
  const state = detail?.accountManager || {};
  const plan = state.plan;
  const tasks = state.tasks || [];
  const operatorBoard = state.operatorBoard || {};
  const boardItems = operatorBoard.workItems || [];
  const boardReceipts = operatorBoard.lifecycleReceipts || [];
  const boardRetentionFeedback = operatorBoard.retentionFeedbackReceipts || [];
  const evidence = useMemo(() => new Map((plan?.evidence || []).map((item) => [item.id, item])), [plan]);
  const pending = tasks.filter((task) => ['pending', 'approved', 'paused', 'blocked'].includes(task.status));
  const recent = tasks.filter((task) => ['sent', 'completed'].includes(task.status));

  async function run(action, task = null, body = {}) {
    if (!focusedLeadId && !task) return;
    const key = task ? `${action}:${task.id}` : action;
    setBusy(key);
    setError(null);
    try {
      if (action === 'plan') await api.generateAccountManagerPlan(focusedLeadId, { source: 'ui' });
      if (action === 'refresh') await api.generateAccountManagerPlan(focusedLeadId, { force: true, source: 'ui_refresh' });
      if (action === 'dry-run') await api.runAccountManager(focusedLeadId, { dryRun: true, forcePlan: !plan, source: 'ui_dry_run' });
      if (action === 'approve') await api.approveAccountTask(task.id);
      if (action === 'preview') await api.sendAccountTask(task.id, { dryRun: true });
      if (action === 'send') await api.sendAccountTask(task.id, { dryRun: false });
      if (action === 'pause') await api.pauseAccountTask(task.id, { note: 'Paused from operator console.' });
      if (action === 'complete') await api.completeAccountTask(task.id, { note: 'Completed from operator console.' });
      if (action === 'reassign') await api.reassignAccountTask(task.id, { owner: body.owner || 'operator' });
      if (action === 'escalate') await api.escalateAccountTask(task.id, {
        actor: 'operator_console',
        evidence: [{ id: `operator-console-escalation-${task.id}`, source: 'operator_console', summary: 'Operator escalated account-manager task into board review.' }]
      });
      if (action === 'why') {
        const data = await api.explainAccountTask(task.id);
        setExplain((prev) => ({ ...prev, [task.id]: data }));
        return;
      }
      onLeadChanged?.(focusedLeadId || task?.lead_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function runBoard(action, item, body = {}) {
    const key = `board-${action}:${item.id}`;
    setBusy(key);
    setError(null);
    try {
      if (action === 'claim') await api.claimAccountOperatorBoardWorkItem(item.id, {
        actor: 'operator_console',
        evidence: [{ id: `operator-console-board-claim-${item.id}`, source: 'operator_console', summary: 'Operator claimed account-manager board work locally.' }]
      });
      if (action === 'resolve') await api.resolveAccountOperatorBoardWorkItem(item.id, {
        actor: 'operator_console',
        proofKey: item.instructions?.requiredProof,
        proof: body.proof || { reviewed: true, source: 'operator_console' },
        note: 'Resolved from operator console without live side effects.',
        evidence: [{ id: `operator-console-board-resolve-${item.id}`, source: 'operator_console', summary: 'Operator resolved account-manager board work locally.' }]
      });
      onLeadChanged?.(focusedLeadId || item.lead_id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!focusedLeadId) {
    return (
      <div className="empty-inspector">
        <div className="hd">aftercare</div>
        <div className="mono note">// focus a delivered lead to see account-manager tasks.</div>
      </div>
    );
  }

  return (
    <div className="growthtab accounttab">
      <div className="growth-head">
        <div>
          <div className="hd">account manager</div>
          <div className="growth-headline">
            {plan ? 'Persistent aftercare, dry-run previews, and live-send gates.' : 'No account-manager plan has been generated yet.'}
          </div>
        </div>
        <div className="growth-actions">
          <button className="btn btn-mini" disabled={!!busy} onClick={() => run(plan ? 'refresh' : 'plan')}>
            {busy === 'plan' || busy === 'refresh' ? 'working...' : plan ? 'refresh plan' : 'generate plan'}
          </button>
          <button className="btn btn-mini btn-primary" disabled={!!busy} onClick={() => run('dry-run')}>
            {busy === 'dry-run' ? 'previewing...' : 'dry-run due'}
          </button>
        </div>
      </div>

      {error ? <div className="growth-error mono">{error}</div> : null}

      <section className="growth-next account-summary">
        <div>
          <div className="outcome-key mono">aftercare state</div>
          <div className="growth-next-title">{pending.length} pending · {recent.length} recent</div>
          <div className="growth-next-copy">
            Tasks cite remembered launch, edit, hours, review, GBP, analytics, and hosting evidence before they ask the customer anything.
          </div>
        </div>
        <div className="growth-next-evidence">
          <span className="thread-flag thread-flag-info">dry-run default</span>
          <span className="thread-flag thread-flag-muted">LIVE_EMAILS gated</span>
        </div>
      </section>

      <TaskList
        title="pending aftercare"
        tasks={pending}
        evidence={evidence}
        busy={busy}
        explain={explain}
        onRun={run}
      />

      <OperatorBoardList
        items={boardItems}
        receipts={boardReceipts}
        retentionFeedback={boardRetentionFeedback}
        busy={busy}
        onRun={runBoard}
      />

      <TaskList
        title="recent aftercare"
        tasks={recent}
        evidence={evidence}
        busy={busy}
        explain={explain}
        onRun={run}
        compact
      />
    </div>
  );
}

function OperatorBoardList({ items, receipts, retentionFeedback, busy, onRun }) {
  const receiptCount = new Map();
  for (const receipt of receipts || []) {
    receiptCount.set(receipt.operator_board_work_item_id, (receiptCount.get(receipt.operator_board_work_item_id) || 0) + 1);
  }
  const retentionCount = new Map();
  for (const receipt of retentionFeedback || []) {
    retentionCount.set(receipt.operator_board_work_item_id, (retentionCount.get(receipt.operator_board_work_item_id) || 0) + 1);
  }
  return (
    <section className="growth-opportunities">
      <div className="section-head">
        <span className="hd">operator board</span>
        <span className="mono note">{items.length} work items</span>
      </div>
      {items.length ? (
        <div className="growth-list">
          {items.map((item) => (
            <div key={item.id} className={`growth-item account-task account-task-${item.status}`}>
              <div className="growth-item-top">
                <span className="growth-section mono">{item.work_item_kind}</span>
                <span className={`thread-flag thread-flag-${statusTone(item.status, item.priority)}`}>{item.status}</span>
              </div>
              <div className="growth-item-title">{item.title}</div>
              <div className="growth-item-copy">
                {(item.instructions?.checklist || []).slice(0, 2).join(' ')}
              </div>
              <div className="account-task-meta mono">
                due {formatDate(item.due_at)} · {item.priority} · receipts {receiptCount.get(item.id) || 0} · retention {retentionCount.get(item.id) || 0}
              </div>
              <div className="account-actions">
                <button className="btn btn-mini" disabled={!!busy || item.status === 'resolved'} onClick={() => onRun('claim', item)}>
                  {busy === `board-claim:${item.id}` ? 'claiming...' : 'claim'}
                </button>
                <button className="btn btn-mini btn-primary" disabled={!!busy || item.status === 'resolved'} onClick={() => onRun('resolve', item)}>
                  {busy === `board-resolve:${item.id}` ? 'resolving...' : 'resolve'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="growth-empty mono">// no account-manager board work yet.</div>
      )}
    </section>
  );
}

function TaskList({ title, tasks, evidence, busy, explain, onRun, compact = false }) {
  return (
    <section className="growth-opportunities">
      <div className="section-head">
        <span className="hd">{title}</span>
        <span className="mono note">{tasks.length} tasks</span>
      </div>
      {tasks.length ? (
        <div className="growth-list">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              evidence={evidence}
              busy={busy}
              explain={explain[task.id]}
              onRun={onRun}
              compact={compact}
            />
          ))}
        </div>
      ) : (
        <div className="growth-empty mono">// nothing in this lane yet.</div>
      )}
    </section>
  );
}

function TaskCard({ task, evidence, busy, explain, onRun, compact }) {
  const key = (action) => `${action}:${task.id}`;
  return (
    <div className={`growth-item account-task account-task-${task.status}`}>
      <div className="growth-item-top">
        <span className="growth-section mono">{KIND_LABELS[task.kind] || task.kind}</span>
        <span className={`thread-flag thread-flag-${statusTone(task.status, task.priority)}`}>{task.status}</span>
      </div>
      <div className="growth-item-title">{task.title}</div>
      <div className="growth-item-copy">{task.summary}</div>
      <div className="account-task-meta mono">
        due {formatDate(task.due_at)} · {task.priority} · {task.channel} · owner {task.owner || 'account_manager'}
      </div>
      <div className="growth-evidence-row">
        {(task.evidenceIds || []).map((id) => <EvidencePill key={id} id={id} evidence={evidence.get(id)} />)}
      </div>
      {task.preview?.body && !compact ? (
        <pre className="account-preview">{task.preview.body}</pre>
      ) : null}
      {!compact ? (
        <div className="account-actions">
          <button className="btn btn-mini" disabled={!!busy} onClick={() => onRun('approve', task)}>
            {busy === key('approve') ? 'approving...' : 'approve'}
          </button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => onRun('preview', task)}>
            {busy === key('preview') ? 'previewing...' : 'preview'}
          </button>
          <button className="btn btn-mini btn-primary" disabled={!!busy} onClick={() => onRun('send', task)}>
            {busy === key('send') ? 'sending...' : 'send'}
          </button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => onRun('pause', task)}>pause</button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => onRun('complete', task)}>complete</button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => onRun('reassign', task, { owner: task.owner === 'operator' ? 'account_manager' : 'operator' })}>
            reassign
          </button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => onRun('escalate', task)}>
            {busy === key('escalate') ? 'escalating...' : 'board'}
          </button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => onRun('why', task)}>
            {busy === key('why') ? 'checking...' : 'why now'}
          </button>
        </div>
      ) : null}
      {explain ? <ExplainBlock explain={explain} /> : null}
    </div>
  );
}

function ExplainBlock({ explain }) {
  const blockers = explain.policy?.blockers || [];
  return (
    <div className="account-explain">
      <div className="mono">why now: {explain.preview?.whyNow || explain.task?.summary}</div>
      {blockers.length ? blockers.map((blocker) => (
        <div key={blocker.code} className="mono">gate {blocker.code}: {blocker.reason}</div>
      )) : <div className="mono">gates clear for dry-run preview.</div>}
      {(explain.evidence || []).slice(0, 3).map((item) => (
        <div key={item.id} className="account-evidence-line">
          <span className="mono">{item.source}</span>
          <span>{item.summary}</span>
        </div>
      ))}
    </div>
  );
}

function EvidencePill({ id, evidence }) {
  return (
    <span className="growth-evidence-pill mono" title={evidence?.summary || id}>
      {evidence?.source || id}
    </span>
  );
}

function statusTone(status, priority) {
  if (status === 'blocked') return 'bad';
  if (status === 'approved' || status === 'sent' || status === 'completed' || status === 'resolved') return 'good';
  if (priority === 'urgent' || priority === 'high') return 'warn';
  if (status === 'paused') return 'muted';
  return 'info';
}

function formatDate(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
