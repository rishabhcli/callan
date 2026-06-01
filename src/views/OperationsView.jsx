import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import MemoryConsole from '../components/MemoryConsole.jsx';
import BrowserUseConsole from '../components/BrowserUseConsole.jsx';
import BrowserResearchConsole from '../components/BrowserResearchConsole.jsx';
import Inspector from '../components/Inspector.jsx';
import LiveInboundPanel from '../components/LiveInboundPanel.jsx';
import { api } from '../api.js';

const AgentScene = lazy(() => import('../components/AgentScene.jsx'));

/**
 * Lightweight metadata mirror of the 3D scene node list.
 * Kept here so the heavy AgentScene chunk only loads once the Operations
 * tab is actually opened — the detail panel still needs labels/colors
 * before the canvas is mounted.
 */
const NODE_META = {
  memory:  { id: 'memory',  label: 'Supermemory',  sub: 'long-term memory',          code: 'SM', accent: '#58A8FF', glow: '#A7CBF2', description: 'Knowledge graph linking every business, evidence shard, transcript, and outcome.' },
  caller:  { id: 'caller',  label: 'Agent Phone',  sub: 'Caller logs and sessions', code: 'AP', accent: '#FD9BB7', glow: '#FD9BB7', description: 'Multiple voice agent instances dialing leads, recording transcripts, pitching builds.' },
  scraper: { id: 'scraper', label: 'Browser Use',  sub: 'Browser Scraper',           code: 'SCR', accent: '#D8973C', glow: '#D8973C', description: 'Cloud browser fleet harvesting evidence, scoring needs, and writing growth postmortems.' },
  mailer:  { id: 'mailer',  label: 'Agent Mail',   sub: 'inbox + replies',          code: 'AM', accent: '#D8973C', glow: '#FD9BB7', description: 'AgentMail threads, Stripe payment links, autoreplies, mailbox routing.' },
  builder: { id: 'builder', label: 'Lovable',      sub: 'Lovable build session',    code: 'BU', accent: '#FD9BB7', glow: '#4B73FF', description: 'Browser Use drives the Lovable building session live, with a shareable preview.' }
};

const NODE_TO_INSPECTOR_TAB = {
  caller: 'Caller',
  mailer: 'Mailer',
  builder: 'Builder',
  memory: 'Memory'
};

export default function OperationsView({
  nodeStates,
  counters,
  selectedNodeId,
  onSelectNode,
  focusedLeadId,
  leadDetail,
  liveTranscript,
  liveCallId,
  liveCallActive,
  builderInfo,
  builderAction,
  health,
  onRetryBuild,
  outreach,
  onStartAutonomy,
  onStopAutonomy,
  onLeadChanged,
  handoffCases = [],
  onFocusLead,
  inbound,
  onDismissInbound
}) {
  const node = selectedNodeId ? NODE_META[selectedNodeId] : null;

  return (
    <div className="nyna-stage">
      <div className="nyna-stage-watermark">
        <strong>OPERATIONS</strong> · agent floor · real-time
      </div>
      <div className="nyna-stage-headline">
        <span className="nyna-stage-headline-eye">Callan</span>
        <div className="nyna-stage-headline-line">we sell the agency, not the agent.</div>
      </div>

      <ProductionCommandCenter />

      <div className="nyna-stage-scene">
        <Suspense fallback={<SceneFallback />}>
          <AgentScene
            states={nodeStates}
            counters={counters}
            selectedId={selectedNodeId}
            onSelect={onSelectNode}
          />
        </Suspense>
      </div>

      {inbound && (inbound.active || inbound.callId || inbound.threadId || inbound.sessionId) ? (
        <LiveInboundPanel inbound={inbound} onClose={onDismissInbound} />
      ) : null}

      <HandoffQueueOverlay cases={handoffCases} onFocusLead={onFocusLead} />

      {node ? (
        <NodeDetailOverlay
          node={node}
          onClose={() => onSelectNode(null)}
          focusedLeadId={focusedLeadId}
          leadDetail={leadDetail}
          liveTranscript={liveTranscript}
          liveCallId={liveCallId}
          liveCallActive={liveCallActive}
          builderInfo={builderInfo}
          builderAction={builderAction}
          health={health}
          onRetryBuild={onRetryBuild}
          outreach={outreach}
          onStartAutonomy={onStartAutonomy}
          onStopAutonomy={onStopAutonomy}
          onLeadChanged={onLeadChanged}
          counters={counters}
        />
      ) : null}
    </div>
  );
}

function ProductionCommandCenter() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [actionResult, setActionResult] = useState('');
  const [resetReady, setResetReady] = useState(false);
  const [adminToken, setAdminToken] = useState(() => api.getAdminToken());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.opsCommandCenter();
      setData(next);
      setError('');
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (!live) return;
      await load();
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [load]);

  const safe = data?.safeToSellToday;
  const blockers = safe?.stillBlocked || data?.readiness?.productionBlockers || [];
  const nextActions = safe?.nextActions || data?.readiness?.nextActions || [];
  const dryRunVerified = safe?.dryRunVerified || [];
  const liveSmokeVerified = safe?.liveSmokeVerified || [];
  const evalSummary = safe?.evals?.summary || data?.evals?.summary;
  const economics = safe?.economics || data?.observability?.dailyEconomics || {};
  const queue = safe?.queue || {};
  const stuck = data?.observability?.stuck || {};
  const backup = safe?.backup || data?.backups || null;
  const providerHistory = data?.observability?.providerHistory || [];
  const providerIssues = providerIssueCount(providerHistory);
  const providerLatency = providerAverageLatency(providerHistory);
  const safeHistory = data?.observability?.safeToSellHistory || {};
  const schedulerHealth = safe?.schedulerHealth || data?.observability?.schedulerHealth || null;
  const economicsHealth = safe?.economicsHealth || data?.observability?.economicsHealth || null;
  const providerHealthSlo = safe?.providerHealthSlo || data?.observability?.providerHealthSlo || null;
  const workerHealthSlo = safe?.workerHealthSlo || data?.observability?.workerHealthSlo || null;
  const durableSnapshot = safe?.durableSnapshot || null;
  const providerProof = safe?.providerProof?.length ? safe.providerProof : data?.providerProof || [];
  const providerRows = useMemo(() => providerRowsFrom(data?.providers), [data?.providers]);
  const providerPreview = providerRows.slice(0, 8);
  const promotionGates = safe?.promotionGates || data?.promotionGates || data?.readiness?.promotionGates || {};
  const reviewStage = promotionGates.productionReview || null;
  const liveStage = promotionGates.productionLive || null;
  const decisionReceipt = safe?.decisionReceipt || null;
  const receiptHistory = data?.safeToSellReceipts || safe?.receiptHistory || data?.observability?.safeToSellReceiptHistory || null;
  const renewal = safe?.renewal || data?.safeToRenewToday || decisionReceipt?.renewal || null;
	  const renewalChangeQueue = data?.renewalChangeRequestQueue
	    || data?.observability?.renewalChangeRequestQueue
	    || null;
	  const renewalMessagePreflightQueue = data?.renewalCustomerMessagePreflightQueue
	    || data?.observability?.renewalCustomerMessagePreflightQueue
	    || null;
	  const renewalBillingExecutionQueue = data?.renewalBillingExecutionReceiptQueue
	    || data?.observability?.renewalBillingExecutionReceiptQueue
	    || null;
	  const renewalMessageSendQueue = data?.renewalCustomerMessageSendReceiptQueue
	    || data?.observability?.renewalCustomerMessageSendReceiptQueue
	    || null;
	  const renewalConfirmationQueue = data?.renewalCustomerConfirmationQueue
	    || data?.observability?.renewalCustomerConfirmationQueue
	    || null;
	  const renewalConfirmationAcknowledgementQueue = data?.renewalCustomerConfirmationAcknowledgementQueue
	    || data?.observability?.renewalCustomerConfirmationAcknowledgementQueue
	    || null;
	  const renewalConfirmationAcceptanceQueue = data?.renewalCustomerConfirmationAcceptanceQueue
	    || data?.observability?.renewalCustomerConfirmationAcceptanceQueue
	    || null;
	  const renewalConfirmationFollowupQueue = data?.renewalCustomerConfirmationFollowupQueue
	    || data?.observability?.renewalCustomerConfirmationFollowupQueue
	    || null;
	  const renewalConfirmationCloseoutPacketQueue = data?.renewalCustomerConfirmationCloseoutPacketQueue
	    || data?.observability?.renewalCustomerConfirmationCloseoutPacketQueue
	    || null;

  const runAction = async (label, fn) => {
    setAction(label);
    setActionResult('');
    setError('');
    try {
      const result = await fn();
      setActionResult(formatAdminActionResult(label, result));
      if (label === 'reset-scan') setResetReady(result?.ok === true);
      if (label === 'reset-apply') setResetReady(false);
      await load();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setAction('');
    }
  };

  const saveAdminToken = useCallback(() => {
    api.setAdminToken(adminToken);
    setAdminToken(api.getAdminToken());
    setError('');
    void load();
  }, [adminToken, load]);

  return (
    <section className="prod-command-center" aria-label="production command center">
      <div className="prod-command-head">
        <div>
          <div className="prod-command-kicker">safe to sell today</div>
          <div className={`prod-command-status ${safe?.ok ? 'is-good' : 'is-blocked'}`}>
            {safe?.ok ? 'yes' : 'no'}
          </div>
        </div>
        <div className="prod-command-mode">
          <span>{data?.mode || 'checking'}</span>
          <strong>{loading ? 'syncing' : 'live view'}</strong>
        </div>
      </div>

      <div className="prod-command-grid">
        <Metric label="evals" value={formatEvalSummary(evalSummary)} tone={data?.evals?.ok ? 'good' : 'warm'} />
        <Metric label="backup" value={backup?.ok ? 'fresh' : 'blocked'} tone={backup?.ok ? 'good' : 'bad'} />
        <Metric label="queue" value={`${queue.due || 0}/${queue.staleRunning || 0}`} tone={queue.staleRunning ? 'bad' : 'good'} />
        <Metric label="margin" value={formatUsd(economics.marginUsd)} tone={(economics.marginUsd || 0) >= 0 ? 'good' : 'warm'} />
        <Metric label="budget" value={formatEconomicsHealth(economicsHealth)} tone={economicsHealth?.ok === false ? 'bad' : 'good'} />
        <Metric label="provider SLO" value={formatProviderSlo(providerHealthSlo)} tone={providerHealthSlo?.ok === false ? 'bad' : 'good'} />
        <Metric label="worker SLO" value={formatWorkerSlo(workerHealthSlo)} tone={workerHealthSlo?.ok === false ? 'bad' : 'good'} />
        <Metric label="receipt" value={formatSnapshotStatus(durableSnapshot)} tone={durableSnapshot?.ok ? 'good' : 'bad'} />
	        <Metric label="renew" value={formatSafeToRenew(renewal)} tone={renewal?.safeToRenew === false ? 'bad' : 'good'} />
	        <Metric label="save plans" value={formatRenewalSavePlans(renewal)} tone={(renewal?.atRiskSubscriptionCount || 0) ? 'warm' : 'good'} />
	        <Metric label="change reqs" value={formatRenewalChangeQueue(renewalChangeQueue)} tone={formatRenewalChangeQueueTone(renewalChangeQueue)} />
	        <Metric label="msg proof" value={formatRenewalPreflightQueue(renewalMessagePreflightQueue)} tone={formatRenewalPreflightQueueTone(renewalMessagePreflightQueue)} />
	        <Metric label="bill gate" value={formatRenewalBillingExecutionQueue(renewalBillingExecutionQueue)} tone={formatRenewalBillingExecutionQueueTone(renewalBillingExecutionQueue)} />
	        <Metric label="send gate" value={formatRenewalSendQueue(renewalMessageSendQueue)} tone={formatRenewalSendQueueTone(renewalMessageSendQueue)} />
	        <Metric label="confirm" value={formatRenewalConfirmationQueue(renewalConfirmationQueue)} tone={formatRenewalConfirmationQueueTone(renewalConfirmationQueue)} />
	        <Metric label="ack" value={formatRenewalConfirmationAcknowledgementQueue(renewalConfirmationAcknowledgementQueue)} tone={formatRenewalConfirmationAcknowledgementQueueTone(renewalConfirmationAcknowledgementQueue)} />
	        <Metric label="accept" value={formatRenewalConfirmationAcceptanceQueue(renewalConfirmationAcceptanceQueue)} tone={formatRenewalConfirmationAcceptanceQueueTone(renewalConfirmationAcceptanceQueue)} />
	        <Metric label="followup" value={formatRenewalConfirmationFollowupQueue(renewalConfirmationFollowupQueue)} tone={formatRenewalConfirmationFollowupQueueTone(renewalConfirmationFollowupQueue)} />
	        <Metric label="closeout" value={formatRenewalConfirmationCloseoutPacketQueue(renewalConfirmationCloseoutPacketQueue)} tone={formatRenewalConfirmationCloseoutPacketQueueTone(renewalConfirmationCloseoutPacketQueue)} />
	      </div>

      <div className={`prod-snapshot-strip ${durableSnapshot?.ok ? 'is-good' : 'is-blocked'}`}>
        <span>{safe?.source || 'inline'}</span>
        <strong>{durableSnapshot?.id || 'no receipt'}</strong>
        <em>{formatSnapshotAge(durableSnapshot)}</em>
      </div>

      <div className="prod-promotion-strip">
        <PromotionStage label="review" stage={reviewStage} />
        <PromotionStage label="live" stage={liveStage} />
      </div>

      <div className="prod-command-split">
        <div className="prod-command-mini">
          <span>dry-run</span>
          <strong>{dryRunVerified.length}</strong>
        </div>
        <div className="prod-command-mini">
          <span>live-smoke</span>
          <strong>{liveSmokeVerified.length}</strong>
        </div>
        <div className="prod-command-mini">
          <span>errors</span>
          <strong>{providerIssues}</strong>
        </div>
        <div className="prod-command-mini">
          <span>latency</span>
          <strong>{providerLatency}</strong>
        </div>
        <div className="prod-command-mini">
          <span>checks</span>
          <strong>{safeHistory.total || 0}</strong>
        </div>
        <div className="prod-command-mini">
          <span>decision</span>
          <strong>{formatDecisionReceipt(decisionReceipt)}</strong>
        </div>
        <div className="prod-command-mini">
          <span>providers</span>
          <strong>{formatReceiptProviders(decisionReceipt)}</strong>
        </div>
        <div className="prod-command-mini">
          <span>ops jobs</span>
          <strong>{formatSchedulerHealth(schedulerHealth)}</strong>
        </div>
        <div className="prod-command-mini">
          <span>renewal</span>
          <strong>{formatRenewalProof(renewal)}</strong>
        </div>
        <div className="prod-command-mini">
          <span>save plans</span>
          <strong>{formatRenewalSavePlans(renewal)}</strong>
        </div>
        <div className="prod-command-mini">
          <span>stuck</span>
          <strong>{(stuck.jobs || 0) + (stuck.builds?.length || 0) + (stuck.calls?.length || 0)}</strong>
        </div>
      </div>

      <div className="prod-provider-strip">
        {providerPreview.map((row) => (
          <span key={row.provider} className={`prod-provider-pill is-${row.tone}`} title={row.title}>
            {row.provider}
          </span>
        ))}
      </div>

      {providerProof.length ? (
        <div className="prod-proof-table" aria-label="provider proof matrix">
          <div className="prod-proof-head">
            <span>provider</span>
            <span>dry</span>
            <span>live</span>
            <span>cost</span>
            <span>health</span>
            <span>next</span>
          </div>
          {providerProof.slice(0, 9).map((row) => (
            <div key={row.provider} className={`prod-proof-row is-${proofTone(row)}`}>
              <strong>{row.provider}</strong>
              <span>{formatProofSmoke(row.dryRun)}</span>
              <span>{formatProofSmoke(row.liveSmoke)}</span>
              <span>{formatUsd(row.cost?.costUsd24h || 0)}</span>
              <span>{formatProofHealth(row)}</span>
              <em title={row.nextAction || ''}>{row.nextAction || 'monitor'}</em>
            </div>
          ))}
        </div>
      ) : null}

      {receiptHistory?.recent?.length ? (
        <div className="prod-receipt-list" aria-label="safe-to-sell receipt history">
          <div className="prod-receipt-head">
            <span>receipt history</span>
            <strong>{receiptHistory.blockedCount || 0} holds</strong>
          </div>
          {receiptHistory.recent.slice(0, 4).map((row) => (
            <div key={row.id} className={`prod-receipt-row ${row.ok ? 'is-good' : 'is-blocked'}`}>
              <strong>{row.decision || (row.ok ? 'sell' : 'hold')}</strong>
              <span>{formatReceiptProof(row)}</span>
              <em>{formatReceiptAge(row.generatedAt)}</em>
            </div>
          ))}
        </div>
      ) : null}

      <div className="prod-blocker-list">
        {error ? <div className="prod-command-error">{error}</div> : null}
        {blockers.length ? blockers.slice(0, 6).map((blocker) => (
          <div key={blocker} className="prod-blocker-row">{blocker}</div>
        )) : (
          <div className="prod-blocker-row is-clear">no production blockers</div>
        )}
        {actionResult ? <div className="prod-command-note">{actionResult}</div> : null}
        {blockers.length > 6 ? <div className="prod-blocker-more">+{blockers.length - 6} more</div> : null}
      </div>

      {nextActions.length ? (
        <div className="prod-next-action-list">
          {nextActions.slice(0, 4).map((action) => (
            <div key={action} className="prod-next-action-row">{action}</div>
          ))}
          {nextActions.length > 4 ? <div className="prod-blocker-more">+{nextActions.length - 4} more actions</div> : null}
        </div>
      ) : null}

      <div className="prod-command-actions">
        <button type="button" onClick={load} disabled={loading || !!action}>refresh</button>
        <button type="button" onClick={() => runAction('backup', () => api.backupOps())} disabled={loading || !!action}>
          {action === 'backup' ? 'backing up' : 'backup'}
        </button>
        <button type="button" onClick={() => runAction('self-check', () => api.enqueueOpsSelfCheck({ reason: 'operator' }))} disabled={loading || !!action}>
          {action === 'self-check' ? 'checking' : 'self-check'}
        </button>
        <button type="button" onClick={() => runAction('renew-check', () => api.enqueueOpsSelfCheck({ reason: 'operator', scope: 'renew' }))} disabled={loading || !!action}>
          {action === 'renew-check' ? 'checking' : 'renew'}
        </button>
        <button type="button" onClick={() => runAction('recover', () => api.recoverStuckOps({ dryRun: false }))} disabled={loading || !!action}>
          {action === 'recover' ? 'recovering' : 'recover'}
        </button>
        <button type="button" onClick={() => runAction('lease-maint', () => api.runRetentionCommandLeaseMaintenance({ reason: 'operator', actor: 'operations_ui' }))} disabled={loading || !!action}>
          {action === 'lease-maint' ? 'queueing' : 'lease maint'}
        </button>
        <button type="button" onClick={() => runAction('export', async () => {
          const payload = await api.exportOps({ includePII: false, limit: 500 });
          downloadJson(payload, `callan-export-${Date.now()}.json`);
          return payload;
        })} disabled={loading || !!action}>
          {action === 'export' ? 'exporting' : 'export'}
        </button>
        <button type="button" onClick={() => runAction('reset-scan', () => api.resetMockData({ dryRun: true }))} disabled={loading || !!action}>
          {action === 'reset-scan' ? 'scanning' : 'reset scan'}
        </button>
        <button type="button" onClick={() => runAction('reset-apply', () => api.resetMockData({ dryRun: false }))} disabled={loading || !!action || !resetReady}>
          {action === 'reset-apply' ? 'resetting' : 'reset demo'}
        </button>
      </div>

      <div className="prod-admin-token">
        <input
          type="password"
          value={adminToken}
          onChange={(event) => setAdminToken(event.target.value)}
          onBlur={saveAdminToken}
          onKeyDown={(event) => {
            if (event.key === 'Enter') saveAdminToken();
          }}
          placeholder="admin token"
          aria-label="admin token"
          autoComplete="off"
        />
        <button type="button" onClick={saveAdminToken} disabled={loading || !!action}>
          {adminToken ? 'save' : 'clear'}
        </button>
      </div>
    </section>
  );
}

function PromotionStage({ label, stage }) {
  const ok = stage?.ok === true;
  const count = stage?.blockerCount ?? stage?.blockers?.length ?? null;
  return (
    <div className={`prod-promotion-card ${ok ? 'is-good' : 'is-blocked'}`} title={(stage?.blockers || []).slice(0, 4).join('\n')}>
      <span>{label}</span>
      <strong>{stage ? (ok ? 'ready' : `${count || 0} blocked`) : 'pending'}</strong>
    </div>
  );
}

function Metric({ label, value, tone = 'muted' }) {
  return (
    <div className={`prod-command-metric is-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function providerRowsFrom(providers = {}) {
  return Object.entries(providers || {}).map(([provider, row]) => {
    const smokeStatus = row?.smokeStatus || row?.smoke?.status || 'unknown';
    const liveSmoke = row?.liveSmoke || {};
    const dryRunSmoke = row?.dryRunSmoke || {};
    const live = liveSmoke.live === true && liveSmoke.status === 'ok' && liveSmoke.fresh === true;
    const dry = dryRunSmoke.dryRun === true && ['configured', 'ok'].includes(dryRunSmoke.status);
    const configured = row?.providerConfigured ?? row?.configured ?? false;
    let tone = 'muted';
    if (live) tone = 'good';
    else if (dry || smokeStatus === 'ok' || smokeStatus === 'configured') tone = 'warm';
    else if (!configured || smokeStatus === 'failed' || smokeStatus === 'missing') tone = 'bad';
    return {
      provider,
      tone,
      title: `${provider}: dry=${dryRunSmoke.status || 'not_run'} live=${liveSmoke.status || 'not_run'}${liveSmoke.fresh ? ' fresh' : liveSmoke.checkedAt ? ' stale' : ''}`
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider));
}

function proofTone(row) {
  if (!row?.configured || row?.status === 'missing_credentials') return 'bad';
  if ((row.blockers || []).length) return 'bad';
  if (row.liveSmoke?.verified && row.liveSmoke?.fresh) return 'good';
  if (row.dryRun?.verified) return 'warm';
  return 'muted';
}

function formatProofSmoke(smoke) {
  if (!smoke) return 'n/a';
  if (smoke.verified && smoke.fresh) return 'fresh';
  if (smoke.verified) return smoke.live ? 'ok' : 'ready';
  if (smoke.status === 'not_run') return 'none';
  return smoke.status || 'n/a';
}

function formatProofHealth(row) {
  if ((row.blockers || []).length) return `${row.blockers.length} block`;
  if (row.slo?.issueRatePct) return `${row.slo.issueRatePct}%`;
  if (row.slo?.ok === false) return 'blocked';
  return 'ok';
}

function formatEvalSummary(summary) {
  if (!summary) return 'pending';
  const skipped = summary.skipped ? `/${summary.skipped}s` : '';
  return `${summary.passed || 0}/${summary.total || 0}${skipped}`;
}

function formatUsd(value) {
  const n = Number(value || 0);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function providerIssueCount(rows = []) {
  return rows.reduce((sum, row) => sum + (row.failedCount || 0) + (row.blockedCount || 0) + (row.degradedCount || 0), 0);
}

function providerAverageLatency(rows = []) {
  const totals = rows.reduce((acc, row) => {
    if (row.avgDurationMs === null || row.avgDurationMs === undefined || !row.total) return acc;
    acc.ms += row.avgDurationMs * row.total;
    acc.events += row.total;
    return acc;
  }, { ms: 0, events: 0 });
  if (!totals.events) return 'n/a';
  return `${Math.round(totals.ms / totals.events)}ms`;
}

function formatSchedulerHealth(health) {
  if (!health) return 'n/a';
  return `${health.healthy || 0}/${health.enabled || 0}`;
}

function formatEconomicsHealth(health) {
  if (!health) return 'n/a';
  return health.ok === false ? 'blocked' : 'healthy';
}

function formatProviderSlo(slo) {
  if (!slo) return 'n/a';
  return slo.ok === false ? `${slo.blockers?.length || 0} blocked` : 'healthy';
}

function formatWorkerSlo(slo) {
  if (!slo) return 'n/a';
  return slo.ok === false ? `${slo.blockers?.length || 0} blocked` : 'healthy';
}

function formatSnapshotStatus(snapshot) {
  if (!snapshot) return 'missing';
  if (snapshot.ok) return 'fresh';
  return snapshot.reason?.includes('stale') ? 'stale' : 'missing';
}

function formatSnapshotAge(snapshot) {
  if (!snapshot?.ageMs && snapshot?.ageMs !== 0) return snapshot?.reason || 'missing';
  const minutes = Math.round(snapshot.ageMs / 60_000);
  if (minutes < 60) return `${minutes}m old`;
  return `${Math.round(minutes / 60)}h old`;
}

function formatDecisionReceipt(receipt) {
  if (!receipt) return 'pending';
  return receipt.ok ? 'sell' : 'hold';
}

function formatReceiptProviders(receipt) {
  const proof = receipt?.proof;
  if (!proof) return 'n/a';
  return `${proof.requiredLiveReady || 0}/${proof.requiredProviders || 0}`;
}

function formatSafeToRenew(renewal) {
  if (!renewal) return 'n/a';
  if (renewal.safeToRenew === false) return 'blocked';
  return renewal.activeSubscriptionCount ? 'ready' : 'none';
}

function formatRenewalProof(renewal) {
  if (!renewal) return 'n/a';
  const active = renewal.activeSubscriptionCount || 0;
  const proof = renewal.dryRunProofCount || 0;
  return `${proof}/${active}`;
}

function formatRenewalSavePlans(renewal) {
  if (!renewal) return 'n/a';
  return `${renewal.renewalSavePlaybookCount || renewal.renewalSavePlaybooks?.length || 0}/${renewal.atRiskSubscriptionCount || 0}`;
}

function formatRenewalChangeQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.pendingCount || 0}/${queue.total || 0}`;
}

function formatRenewalChangeQueueTone(queue) {
  if (!queue) return 'good';
  if (queue.pendingCount > 0) return 'warm';
  return 'good';
}

function formatRenewalPreflightQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.blockedCount || 0}/${queue.total || 0}`;
}

function formatRenewalPreflightQueueTone(queue) {
  if (!queue) return 'good';
  if (queue.blockedCount > 0) return 'warm';
  return 'good';
}

function formatRenewalBillingExecutionQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.appliedCount || 0}/${queue.blockedCount || 0}`;
}

function formatRenewalBillingExecutionQueueTone(queue) {
  if (!queue) return 'good';
  if (queue.failedCount > 0) return 'bad';
  if (queue.blockedCount > 0) return 'warm';
  return 'good';
}

function formatRenewalSendQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.sentCount || 0}/${queue.blockedCount || 0}`;
}

function formatRenewalSendQueueTone(queue) {
  if (!queue) return 'good';
  if (queue.failedCount > 0) return 'bad';
  if (queue.blockedCount > 0) return 'warm';
  return 'good';
}

function formatRenewalConfirmationQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.visibleCount || 0}/${queue.total || 0}`;
}

function formatRenewalConfirmationQueueTone(queue) {
  if (!queue) return 'good';
  return (queue.visibleCount || 0) > 0 ? 'good' : 'warm';
}

function formatRenewalConfirmationAcknowledgementQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.acknowledgedCount || 0}/${queue.total || 0}`;
}

function formatRenewalConfirmationAcknowledgementQueueTone(queue) {
  if (!queue) return 'good';
  return (queue.acknowledgedCount || 0) > 0 ? 'good' : 'warm';
}

function formatRenewalConfirmationAcceptanceQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.acceptedCount || 0}/${queue.total || 0}`;
}

function formatRenewalConfirmationAcceptanceQueueTone(queue) {
  if (!queue) return 'good';
  return (queue.acceptedCount || 0) > 0 ? 'good' : 'warm';
}

function formatRenewalConfirmationFollowupQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.pendingCount || 0}/${queue.completedCount || 0}`;
}

function formatRenewalConfirmationFollowupQueueTone(queue) {
  if (!queue) return 'good';
  if (queue.escalatedCount > 0) return 'bad';
  if (queue.pendingCount > 0) return 'warm';
  return 'good';
}

function formatRenewalConfirmationCloseoutPacketQueue(queue) {
  if (!queue) return 'n/a';
  return `${queue.visibleCount || 0}/${queue.total || 0}`;
}

function formatRenewalConfirmationCloseoutPacketQueueTone(queue) {
  if (!queue) return 'good';
  return (queue.visibleCount || 0) > 0 ? 'good' : 'warm';
}

function formatReceiptProof(row) {
  if (!row) return 'n/a';
  const required = row.requiredProviders || 0;
  const liveReady = row.requiredLiveReady ?? row.liveSmokeCount ?? 0;
  const blockers = row.blockerCount || 0;
  return `${liveReady}/${required || 'n/a'} live, ${blockers} blocks`;
}

function formatReceiptAge(generatedAt) {
  const ts = Number(generatedAt || 0);
  if (!ts) return 'pending';
  const ageMs = Math.max(0, Date.now() - ts);
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function formatAdminActionResult(label, result) {
  if (!result) return '';
  if (label === 'backup') return `backup ${result.ok ? 'ready' : 'blocked'} (${result.files?.length || 0} files)`;
  if (label === 'self-check') return result.report?.snapshot?.id || result.jobId || 'self-check queued';
  if (label === 'renew-check') return result.report?.snapshot?.id || result.jobId || 'safe-to-renew queued';
  if (label === 'recover') return `recovered ${result.jobs?.recovered || 0} jobs, ${result.calls?.recovered || 0} calls`;
  if (label === 'lease-maint') return result.report?.receiptCount !== undefined ? `recorded ${result.report.receiptCount} lease receipts` : result.jobId || 'lease maintenance queued';
  if (label === 'export') return `exported ${Object.keys(result.tables || {}).length} tables`;
  if (label === 'reset-scan') return `reset scan found ${result.totalMatched || 0} rows`;
  if (label === 'reset-apply') return `reset changed ${result.totalChanged || 0} rows after backup`;
  return result.ok ? 'done' : 'blocked';
}

function downloadJson(payload, filename) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function SceneFallback() {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-mono)', fontSize: 11,
      color: 'var(--ink-400)', letterSpacing: '0.18em',
      textTransform: 'uppercase'
    }}>
      conjuring the floor…
    </div>
  );
}

function HandoffQueueOverlay({ cases = [], onFocusLead }) {
  const open = cases.filter((item) => !['resolved', 'closed'].includes(item.status)).slice(0, 4);
  if (!open.length) return null;
  return (
    <div className="handoff-stage-queue">
      <div className="handoff-stage-head">
        <span>handoff queue</span>
        <strong>{open.length}</strong>
      </div>
      <div className="handoff-stage-list">
        {open.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`handoff-stage-card handoff-severity-${item.severity}`}
            onClick={() => item.lead_id && onFocusLead?.(item.lead_id)}
          >
            <span className="handoff-stage-meta">{item.severity} · {labelize(item.category)}</span>
            <span className="handoff-stage-summary">{item.summary}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function labelize(value) {
  return String(value || '').replace(/_/g, ' ');
}

function NodeDetailOverlay({
  node,
  onClose,
  focusedLeadId,
  leadDetail,
  liveTranscript,
  liveCallId,
  liveCallActive,
  builderInfo,
  builderAction,
  health,
  onRetryBuild,
  outreach,
  onStartAutonomy,
  onStopAutonomy,
  onLeadChanged,
  counters
}) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const inspectorTab = NODE_TO_INSPECTOR_TAB[node.id];
  const useInspector = focusedLeadId && inspectorTab && inspectorTab !== 'Memory';

  const stats = useMemo(() => statsForNode(node.id, { counters, builderInfo, leadDetail }), [node.id, counters, builderInfo, leadDetail]);

  return (
    <div className="nyna-detail-overlay">
      <div className="nyna-detail-overlay-scrim" onClick={onClose} />
      <div className="nyna-detail-panel">
        <div className="nyna-detail-head">
          <div className="nyna-detail-head-left">
            <div className="nyna-detail-icon" style={{ background: `linear-gradient(135deg, ${node.accent}, ${node.glow})` }}>
              <DetailProviderMark id={node.id} fallback={node.code} />
            </div>
            <div>
              <div className="nyna-detail-subtitle">{node.sub}</div>
              <div className="nyna-detail-title">{node.label}</div>
            </div>
          </div>
          <div className="nyna-detail-stats">
            {stats.map((s) => (
              <div key={s.key}>
                <div className="nyna-detail-stat-key">{s.key}</div>
                <div className={`nyna-detail-stat-val${s.tone ? ` is-${s.tone}` : ''}`}>{s.value}</div>
              </div>
            ))}
            <button className="nyna-detail-close" onClick={onClose}>
              <span>close</span>
              <span style={{ opacity: 0.6 }}>esc</span>
            </button>
          </div>
        </div>

        <div className="nyna-detail-body">
          {node.id === 'memory' ? (
            <MemoryDetail leadId={focusedLeadId} />
          ) : node.id === 'scraper' ? (
            <ScraperDetail
              focusedLeadId={focusedLeadId}
              leadDetail={leadDetail}
              liveTranscript={liveTranscript}
              liveCallId={liveCallId}
              liveCallActive={liveCallActive}
              builderInfo={builderInfo}
              builderAction={builderAction}
              health={health}
              onRetryBuild={onRetryBuild}
              outreach={outreach}
              onStartAutonomy={onStartAutonomy}
              onStopAutonomy={onStopAutonomy}
              onLeadChanged={onLeadChanged}
            />
          ) : node.id === 'builder' ? (
            <BuilderDetail
              focusedLeadId={focusedLeadId}
              leadDetail={leadDetail}
              builderInfo={builderInfo}
              builderAction={builderAction}
              onRetryBuild={onRetryBuild}
              onLeadChanged={onLeadChanged}
              useInspector={!!focusedLeadId}
            />
          ) : useInspector ? (
            <InspectorPanel
              tab={inspectorTab}
              focusedLeadId={focusedLeadId}
              leadDetail={leadDetail}
              liveTranscript={liveTranscript}
              liveCallId={liveCallId}
              liveCallActive={liveCallActive}
              builderInfo={builderInfo}
              builderAction={builderAction}
              health={health}
              onRetryBuild={onRetryBuild}
              outreach={outreach}
              onStartAutonomy={onStartAutonomy}
              onStopAutonomy={onStopAutonomy}
              onLeadChanged={onLeadChanged}
            />
          ) : (
            <FleetDetailEmpty node={node} />
          )}
        </div>
      </div>
    </div>
  );
}

function FleetDetailEmpty({ node }) {
  return (
    <div className="nyna-card" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="nyna-card-title">{node.label}</div>
      <div className="nyna-card-body" style={{ marginBottom: 18 }}>
        {node.description} Focus a lead from the live floor on the right to see this worker's
        per-lead detail; otherwise this panel shows fleet-wide rollups when populated.
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-400)', letterSpacing: '0.1em' }}>
        // hint: click any business in the right rail
      </div>
    </div>
  );
}

function MemoryDetail({ leadId }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SuperMemoryEmbed />
      <div className="nyna-card" style={{ padding: 0, overflow: 'hidden' }}>
        <MemoryConsole leadId={leadId} />
      </div>
    </div>
  );
}

function SuperMemoryEmbed() {
  // Supermemory provides a console at app.supermemory.ai with a knowledge graph view
  // per project. Because most embedding flows require auth, we render an in-app
  // graph synopsis as the default and link out for the full interactive view.
  return (
    <div className="nyna-supermem">
      <div className="nyna-supermem-head">
        <div>
          <div className="nyna-supermem-eyebrow">supermemory</div>
          <div className="nyna-supermem-title">knowledge graph synopsis</div>
        </div>
        <a className="nyna-mini-btn" href="https://app.supermemory.ai" target="_blank" rel="noreferrer">
          open full graph ↗
        </a>
      </div>
      <div className="nyna-supermem-viz">
        <SupermemSpiderweb />
        <div className="nyna-supermem-legend">
          <div className="nyna-supermem-legend-row"><span className="nyna-supermem-dot" style={{ background: 'var(--apricot)' }} /> business profile</div>
          <div className="nyna-supermem-legend-row"><span className="nyna-supermem-dot" style={{ background: 'var(--candy)' }} /> evidence</div>
          <div className="nyna-supermem-legend-row"><span className="nyna-supermem-dot" style={{ background: 'var(--pearl)' }} /> transcripts</div>
          <div className="nyna-supermem-legend-row"><span className="nyna-supermem-dot" style={{ background: 'var(--brown-red)', boxShadow: '0 0 0 1px var(--pearl)' }} /> outcomes</div>
        </div>
      </div>
    </div>
  );
}

function SupermemSpiderweb() {
  // Decorative SVG mini-graph hinting at the supermemory knowledge web.
  const nodes = useMemo(() => generateMockGraph(), []);
  return (
    <svg viewBox="-200 -120 400 240" className="nyna-supermem-svg">
      {nodes.edges.map((e, i) => (
        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
          stroke="rgba(216, 151, 60, 0.3)" strokeWidth="0.6" />
      ))}
      {nodes.points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.r}
          fill={p.color}
          stroke="rgba(243, 230, 189, 0.4)"
          strokeWidth="0.4"
        >
          <animate attributeName="r" values={`${p.r};${p.r * 1.18};${p.r}`} dur={`${1.6 + (i % 5) * 0.4}s`} repeatCount="indefinite" />
        </circle>
      ))}
    </svg>
  );
}

function generateMockGraph() {
  const center = { x: 0, y: 0, r: 8, color: '#D8973C' };
  const orbiters = [];
  const COLORS = ['#FD9BB7', '#F3E6BD', '#AD2831', '#D8973C'];
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2;
    const radius = 60 + (i % 3) * 22;
    orbiters.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.55,
      r: 3 + (i % 3),
      color: COLORS[i % COLORS.length]
    });
  }
  const fringe = [];
  for (let i = 0; i < 22; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 100 + Math.random() * 70;
    fringe.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.5,
      r: 1.4 + Math.random() * 1.2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]
    });
  }
  const points = [center, ...orbiters, ...fringe];
  const edges = [];
  orbiters.forEach((o) => edges.push({ x1: center.x, y1: center.y, x2: o.x, y2: o.y }));
  for (let i = 0; i < orbiters.length; i++) {
    const next = orbiters[(i + 1) % orbiters.length];
    edges.push({ x1: orbiters[i].x, y1: orbiters[i].y, x2: next.x, y2: next.y });
  }
  fringe.forEach((f, i) => {
    const anchor = orbiters[i % orbiters.length];
    edges.push({ x1: anchor.x, y1: anchor.y, x2: f.x, y2: f.y });
  });
  return { points, edges };
}

function DetailProviderMark({ id, fallback }) {
  if (id === 'memory') {
    return (
      <svg viewBox="0 0 30 24" aria-hidden="true">
        <path d="M29.3388 9.46767H18.448V0.00146484H14.9293V10.2725C14.9293 11.3634 15.36 12.411 16.1254 13.183L25.018 22.151L27.506 19.6419L20.938 13.0183H29.3408V9.46975L29.3388 9.46767Z" />
        <path d="M1.82839 4.36056L8.39633 10.9842H-0.00646973V14.5328H10.8843V23.999H14.403V13.728C14.403 12.637 13.9723 11.5894 13.2069 10.8175L4.31635 1.85147L1.82839 4.36056Z" />
      </svg>
    );
  }
  if (id === 'mailer') {
    return (
      <svg viewBox="0 0 32 24" aria-hidden="true">
        <rect x="3" y="5" width="26" height="16" rx="3" />
        <path d="M5.5 7.5 16 14.7 26.5 7.5" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5.5 19 12.2 13.8M26.5 19 19.8 13.8" fill="none" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (id === 'builder') {
    return (
      <svg viewBox="0 0 121 122" aria-hidden="true" className="is-lovable">
        <defs>
          <linearGradient id="lovable-detail-gradient" x1="28" x2="92" y1="18" y2="118" gradientUnits="userSpaceOnUse">
            <stop offset="0.03" stopColor="#FE7B02" />
            <stop offset="0.48" stopColor="#FF66F4" />
            <stop offset="0.95" stopColor="#4B73FF" />
          </linearGradient>
        </defs>
        <path d="M36.069 0c19.92 0 36.068 16.155 36.068 36.084v13.713h12.004c19.92 0 36.069 16.156 36.069 36.084 0 19.928-16.149 36.083-36.069 36.083H0v-85.88C0 16.155 16.148 0 36.069 0Z" fill="url(#lovable-detail-gradient)" />
      </svg>
    );
  }
  if (id === 'caller') {
    return (
      <img
        className="is-agentphone"
        src="https://agentphone.ai/logo.png"
        alt=""
        draggable="false"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (id === 'scraper') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="4" y="6" width="24" height="17" rx="3" />
        <path d="M4.5 11h23" fill="none" strokeWidth="2" />
        <circle cx="12" cy="18" r="3" fill="none" strokeWidth="2.2" />
        <path d="m14.2 20.2 4.6 4.6M19 18h5" fill="none" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return <span>{fallback}</span>;
}

function ScraperDetail({
  focusedLeadId,
  leadDetail,
  liveTranscript,
  liveCallId,
  liveCallActive,
  builderInfo,
  builderAction,
  health,
  onRetryBuild,
  outreach,
  onStartAutonomy,
  onStopAutonomy,
  onLeadChanged
}) {
  return (
    <div className="nyna-scraper-merged">
      <div className="nyna-card" style={{ padding: 0, overflow: 'hidden' }}>
        <BrowserResearchConsole />
      </div>
      {focusedLeadId ? (
        <InspectorPanel
          tab="Analyst"
          focusedLeadId={focusedLeadId}
          leadDetail={leadDetail}
          liveTranscript={liveTranscript}
          liveCallId={liveCallId}
          liveCallActive={liveCallActive}
          builderInfo={builderInfo}
          builderAction={builderAction}
          health={health}
          onRetryBuild={onRetryBuild}
          outreach={outreach}
          onStartAutonomy={onStartAutonomy}
          onStopAutonomy={onStopAutonomy}
          onLeadChanged={onLeadChanged}
        />
      ) : (
        <div className="nyna-card nyna-scraper-analysis-card">
          <div className="nyna-card-title">analysis folded into scraper</div>
          <div className="nyna-card-body">
            Needs assessment, growth planning, call postmortems, and presence scoring now live under the browser research lane. Focus a lead to inspect the analyst output here.
          </div>
        </div>
      )}
    </div>
  );
}

function BuilderDetail({
  focusedLeadId,
  leadDetail,
  builderInfo,
  builderAction,
  onRetryBuild,
  onLeadChanged,
  useInspector
}) {
  if (useInspector) {
    return (
      <InspectorPanel
        tab="Builder"
        focusedLeadId={focusedLeadId}
        leadDetail={leadDetail}
        builderInfo={builderInfo}
        builderAction={builderAction}
        onRetryBuild={onRetryBuild}
        onLeadChanged={onLeadChanged}
      />
    );
  }
  return (
    <div className="nyna-card" style={{ padding: 0, overflow: 'hidden' }}>
      <BrowserUseConsole onLeadChanged={onLeadChanged} />
    </div>
  );
}

function InspectorPanel(props) {
  // Inspector expects activeTab + setActiveTab to manage internal tabbing.
  // We pin it open to the relevant tab; users still get the sub-tabs strip
  // if they want to pivot between Memory/Caller/Analyst/Mailer/Builder.
  const [activeTab, setActiveTab] = React.useState(props.tab || 'Memory');
  React.useEffect(() => { setActiveTab(props.tab || 'Memory'); }, [props.tab]);
  return (
    <Inspector
      {...props}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
    />
  );
}

function statsForNode(id, { counters, builderInfo, leadDetail }) {
  switch (id) {
    case 'memory':
      return [
        { key: 'docs/min', value: counters.memory || 0 },
        { key: 'cluster', value: 'isolated', tone: 'good' }
      ];
    case 'caller':
      return [
        { key: 'live calls', value: counters.caller || 0, tone: counters.caller > 0 ? 'warm' : undefined }
      ];
    case 'scraper':
      return [
        { key: 'browser fleet', value: counters.scraper || 0, tone: counters.scraper > 0 ? 'good' : undefined },
        { key: 'analysis/min', value: counters.analyst || 0, tone: counters.analyst > 0 ? 'warm' : undefined }
      ];
    case 'mailer':
      return [
        { key: 'threads', value: counters.mailer || 0 }
      ];
    case 'builder':
      return [
        { key: 'session', value: builderInfo?.status === 'not_started' ? 'idle' : builderInfo?.status || 'idle', tone: builderInfo?.status === 'running' ? 'warm' : undefined },
        { key: 'cost', value: builderInfo?.totalCostUsd ? `$${builderInfo.totalCostUsd}` : '—' }
      ];
    default:
      return [];
  }
}
