import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const DEFAULT_WORKSPACE_ID = 'ws_callan';
const LIVE_RELEASE_QUEUE_FILTERS = [
  { key: 'all', label: 'All blockers', buttonLabel: 'All', params: {} },
  { key: 'high', label: 'High urgency', buttonLabel: 'High urgency', params: { urgencyBand: 'high_repeated_denials' } },
  { key: 'stale', label: 'Stale blockers', buttonLabel: 'Stale', params: { staleOnly: 'true' } },
  { key: 'runtime', label: 'Runtime guardrails', buttonLabel: 'Runtime', params: { denialReason: 'runtime_guardrails' } }
];

function normalizeLiveFlagInput(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export default function PortfolioView() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [planningId, setPlanningId] = useState('');
  const [outcomeId, setOutcomeId] = useState('');
  const [actionResult, setActionResult] = useState(null);
  const [planResult, setPlanResult] = useState(null);
  const [gateId, setGateId] = useState('');
  const [gateResult, setGateResult] = useState(null);
  const [fixingId, setFixingId] = useState('');
  const [fixResult, setFixResult] = useState(null);
  const [liveReleaseQueueFilter, setLiveReleaseQueueFilter] = useState('all');
  const [lastLiveReleaseQueueExport, setLastLiveReleaseQueueExport] = useState(null);
  const [liveReleaseQueueReviewReceipts, setLiveReleaseQueueReviewReceipts] = useState([]);
  const [providerSmokeProofs, setProviderSmokeProofs] = useState({});
  const [adapterProofs, setAdapterProofs] = useState({});

  const load = useCallback(async () => {
    try {
      const next = await api.portfolioOperatingModel({ workspaceId: snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID, limit: 50 });
      setSnapshot(next);
      setError('');
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

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

  const selectedLiveReleaseQueueFilter = useMemo(() => (
    LIVE_RELEASE_QUEUE_FILTERS.find((item) => item.key === liveReleaseQueueFilter) || LIVE_RELEASE_QUEUE_FILTERS[0]
  ), [liveReleaseQueueFilter]);

  const currentLiveReleaseQueueReviewReceipt = useMemo(() => {
    const checksum = lastLiveReleaseQueueExport?.integrityManifest?.checksum || '';
    if (!checksum) return null;
    return liveReleaseQueueReviewReceipts.find((receipt) => receipt.checksum === checksum) || null;
  }, [lastLiveReleaseQueueExport, liveReleaseQueueReviewReceipts]);

  const refreshLiveReleaseBlockerQueueExportReviews = useCallback(async (overrides = {}) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const params = {
      workspaceId,
      limit: 5,
      ...(selectedLiveReleaseQueueFilter.params || {}),
      ...overrides
    };
    const result = await api.listPortfolioLiveReleaseBlockerQueueExportReviews(params);
    const receipts = Array.isArray(result?.receipts) ? result.receipts : [];
    setLiveReleaseQueueReviewReceipts(receipts);
    return receipts;
  }, [selectedLiveReleaseQueueFilter, snapshot?.workspace?.id]);

  useEffect(() => {
    let live = true;
    refreshLiveReleaseBlockerQueueExportReviews()
      .then((receipts) => {
        if (!live) return;
        setLiveReleaseQueueReviewReceipts(receipts);
      })
      .catch(() => {
        if (live) setLiveReleaseQueueReviewReceipts([]);
      });
    return () => {
      live = false;
    };
  }, [refreshLiveReleaseBlockerQueueExportReviews]);

  useEffect(() => {
    setLastLiveReleaseQueueExport(null);
  }, [liveReleaseQueueFilter]);

  const aggregateLeads = useCallback(async () => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setAction('aggregate');
    setError('');
    setActionResult(null);
    setPlanResult(null);
    setGateResult(null);
    setFixResult(null);
    try {
      const result = await api.aggregatePortfolioMarketOpportunities({ workspaceId, minLeads: 2, limit: 250 });
      setActionResult({
        createdOrUpdated: result?.createdOrUpdated || 0,
        consideredLeads: result?.consideredLeads || 0,
        groups: result?.groups || 0
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setAction('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const planLaunch = useCallback(async (opportunityId) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setPlanningId(opportunityId);
    setError('');
    setPlanResult(null);
    setGateResult(null);
    setFixResult(null);
    try {
      const result = await api.planPortfolioLaunch(opportunityId, {});
      setPlanResult({
        created: result?.created === true,
        name: result?.launch?.serviceBusiness?.name || result?.blueprint?.serviceName || 'launch plan'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setPlanningId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordFalsePositive = useCallback(async (item) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setOutcomeId(item.id);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioMarketOutcome(item.id, {
        outcome: 'false_positive',
        reasonKey: 'operator_marked_false_positive',
        summary: 'Operator marked this market recommendation as a false positive after reviewing launch evidence.',
        evidence: [
          {
            source: 'portfolio_ui',
            id: item.id,
            decision: item.decision,
            score: item.score
          }
        ]
      });
      setFixResult({ label: result?.learning?.state || 'market learning', type: 'market_outcome' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setOutcomeId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const evaluateGates = useCallback(async (serviceBusinessId) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setGateId(serviceBusinessId);
    setError('');
    setGateResult(null);
    setFixResult(null);
    try {
      const result = await api.evaluatePortfolioGates(serviceBusinessId, { persist: true });
      const blocked = (result?.gates || []).filter((gate) => !gate.ok).length;
      setGateResult({
        allowed: (result?.gates || []).filter((gate) => gate.ok).length,
        blocked,
        name: result?.serviceBusiness?.name || 'service business'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setGateId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const runBlockerAction = useCallback(async (item) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(item.actionId);
    setError('');
    setFixResult(null);
    try {
      if (item.type === 'approval') {
        await api.decidePortfolioApproval(item.id, { status: 'approved', evidence: [{ source: 'portfolio_ui', id: item.actionId }] });
      } else if (item.type === 'provider') {
        await api.updatePortfolioProviderLink(item.id, { status: 'active', quality: { source: 'portfolio_ui', checkedAt: Date.now() } });
      } else if (item.type === 'vendor') {
        await api.updatePortfolioVendorPartner(item.id, { status: 'active', quality: { source: 'portfolio_ui', checkedAt: Date.now() } });
      } else if (item.type === 'payment') {
        await api.updatePortfolioPaymentStatus(item.id, { status: 'authorized', consent: { source: 'portfolio_ui', operatorConfirmed: true } });
      } else if (item.type === 'incident') {
        await api.resolvePortfolioIncident(item.id, {
          status: 'resolved',
          evidence: [{ source: 'portfolio_ui', id: item.actionId }]
        });
      }
      setFixResult({ label: item.label, type: item.type });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const runAcquisitionAction = useCallback(async (item) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(item.id);
    setError('');
    setFixResult(null);
    try {
      let actionRow = item;
      if (item.status !== 'approved') {
        actionRow = await api.decidePortfolioAcquisitionAction(item.id, {
          status: 'approved',
          reviewedBy: 'portfolio_ui',
          evidence: [{ source: 'portfolio_ui', id: item.id, actionType: item.action_type }]
        });
      }
      const executed = await api.executePortfolioAcquisitionAction(actionRow.id, {
        actor: 'portfolio_ui',
        mode: 'dry_run',
        proof: {
          source: 'portfolio_ui',
          summary: 'Operator reviewed and executed this local acquisition channel action.',
          externalSideEffects: false
        }
      });
      setFixResult({ label: executed?.action?.channel || item.channel, type: executed?.action?.action_type || item.action_type });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const rollbackAcquisitionAction = useCallback(async (item) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(`${item.id}:rollback`);
    setError('');
    setFixResult(null);
    try {
      const rolledBack = await api.rollbackPortfolioAcquisitionAction(item.id, {
        actor: 'portfolio_ui',
        reason: 'Operator rolled back this local acquisition channel action from the review queue.',
        evidence: [{ source: 'portfolio_ui', id: item.id, actionType: item.action_type }]
      });
      setFixResult({ label: rolledBack?.action?.channel || item.channel, type: 'rolled_back' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const preflightAcquisitionAction = useCallback(async (item) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(`${item.id}:preflight`);
    setError('');
    setFixResult(null);
    try {
      const preflight = await api.preflightPortfolioAcquisitionAction(item.id, {
        actor: 'portfolio_ui',
        allowLiveExternalSpend: false,
        evidence: [{ source: 'portfolio_ui', id: item.id, actionType: item.action_type }]
      });
      setFixResult({ label: preflight?.receipt?.status || item.channel, type: 'live_preflight' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const publishAcquisitionAction = useCallback(async (item) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(`${item.id}:publish`);
    setError('');
    setFixResult(null);
    try {
      const published = await api.executePortfolioAcquisitionAction(item.id, {
        actor: 'portfolio_ui',
        mode: 'live',
        proof: {
          source: 'portfolio_ui',
          summary: 'Published this reviewed acquisition action to a first-party owned surface.',
          externalSideEffects: false,
          allowLiveExternalSpend: false
        }
      });
      setFixResult({ label: published?.launchSurface?.url || published?.receipt?.status || item.channel, type: 'live_publish' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const runReadinessCommand = useCallback(async (item, command) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(`${item.id}:${command.action}`);
    setError('');
    setFixResult(null);
    try {
      const payload = {
        actor: 'portfolio_ui',
        evidence: [{ source: 'portfolio_ui', id: item.id, action: command.action }]
      };
      let result = null;
      if (command.action === 'plan_compensation') {
        result = await api.planReadinessCommandCompensation(item.id, payload);
      } else if (command.action === 'record_retry_receipts') {
        result = await api.recordReadinessCommandRetryReceipts(item.id, {
          ...payload,
          proof: {
            source: 'portfolio_ui',
            retryWindowApproved: true,
            providerSmokeWillRunOnlyInLivePreflight: true,
            adapterWorkWillStayBehindRunModeGates: true,
            externalSideEffects: false
          }
        });
	      } else if (command.action === 'attach_provider_smoke_evidence' || command.action === 'attach_adapter_evidence') {
	        const verifiedProviderSmokeReady = command.action === 'attach_provider_smoke_evidence'
	          && command.proofKey === 'provider_live_smoke'
	          && command.providerReceiptId;
	        const verifiedAdapterReceiptReady = command.action === 'attach_adapter_evidence'
	          && command.proofKey === 'live_adapter_implemented'
	          && command.adapterReceiptId;
	        result = await api.submitReadinessCommandEvidence(item.id, {
	          ...payload,
	          proofKey: command.proofKey,
	          attestation: verifiedProviderSmokeReady
	            ? {
	                source: 'portfolio_ui',
	                provider: command.provider,
	                providerReceiptId: command.providerReceiptId,
	                liveSmokePassed: true,
	                operatorVerified: true,
	                requiredLiveFlags: command.requiredLiveFlags || [],
	                externalReceiptReviewed: true,
	                externalSideEffects: false
	              }
	            : verifiedAdapterReceiptReady
	            ? {
	                source: 'portfolio_ui',
	                adapterReceiptId: command.adapterReceiptId,
                adapterImplemented: true,
                adapterSmokePassed: true,
                operatorVerified: true,
                externalReceiptReviewed: true,
                externalSideEffects: false
              }
            : {
                source: 'portfolio_ui',
                operatorSubmitted: true,
                operatorVerified: false,
                externalReceiptReviewed: false,
                externalSideEffects: false
              }
	        });
	      } else if (command.action === 'record_provider_smoke_receipt') {
	        const smokeProof = providerSmokeProofs[item.id] || {};
	        const provider = smokeProof.provider || command.provider || 'agentmail';
	        const requiredLiveFlags = normalizeLiveFlagInput(smokeProof.liveFlags || command.requiredLiveFlags || ['LIVE_EMAILS']);
	        result = await api.recordReadinessProviderSmokeReceipt(item.id, {
	          ...payload,
	          provider,
	          runMode: command.runMode || 'production_live',
	          liveFlagsAttested: requiredLiveFlags,
	          requiredLiveFlags,
	          proof: {
	            source: 'portfolio_ui',
	            liveSmokePassed: smokeProof.liveSmokePassed === true,
	            operatorVerified: smokeProof.operatorVerified === true,
	            externalSideEffects: false,
	            providerCalledByCallan: false
	          }
	        });
	      } else if (
	        command.action === 'plan_adapter_ledger' ||
        command.action === 'run_adapter_contract_tests' ||
        command.action === 'verify_adapter_implementation' ||
        command.action === 'preflight_adapter_ledger'
      ) {
        const adapterProof = adapterProofs[item.id] || {};
        const verifiedAdapterProofReady = command.action === 'verify_adapter_implementation'
          && adapterProof.adapterImplemented === true
          && adapterProof.operatorVerified === true
          && adapterProof.rollbackPlanAttached === true;
        const proof = verifiedAdapterProofReady
          ? {
              source: 'portfolio_ui',
              adapterImplemented: true,
              operatorVerified: true,
              rollbackPlan: {
                source: 'portfolio_ui',
                summary: String(adapterProof.rollbackReference || '').trim() || 'Operator attached rollback proof in Portfolio.',
                restoresExternalState: false,
                rollbackAdapterInvoked: false,
                externalSideEffects: false
              },
              adapterInvoked: false,
              externalSideEffects: false
            }
          : {
              source: 'portfolio_ui',
              adapterInvoked: false,
              externalSideEffects: false
            };
        result = await api.recordReadinessAdapterLedger(item.id, {
          ...payload,
          adapterKey: command.adapterKey || 'service_decision_execution_controller',
          mode: command.mode || 'dry_run',
          proof
        });
      } else if (command.action === 'rerun_reconciliation') {
        result = await api.reconcileReadinessCommandCenter(item.id, {
          ...payload,
          allowLiveBoardDecisionExecution: false
        });
      }
      setFixResult({
        label: result?.summary || item.serviceBusinessName,
        type: command.action,
        operatorStatus: result?.operatorStatus?.status || null,
        requiredLiveEvidenceKey: result?.operatorStatus?.requiredLiveEvidenceKey || null,
        liveGateClearedByThisSubmission: result?.operatorStatus?.liveGateClearedByThisSubmission,
        localReviewCanClearLiveGate: result?.operatorStatus?.localReviewCanClearLiveGate
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
	  }, [adapterProofs, providerSmokeProofs, snapshot?.workspace?.id]);

	  const exportReadinessLiveExecuteDenial = useCallback(async (item) => {
	    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
	    const actionKey = 'export_live_execute_denial_provenance';
	    setFixingId(`${item.id}:${actionKey}`);
	    setError('');
	    setFixResult(null);
	    try {
	      const result = await api.exportPortfolioLiveExecuteDenial(item.id, { workspaceId, limit: 200 });
	      const packet = result?.exportPacket || {};
	      setFixResult({
	        label: packet.status || result?.kind || 'denial export ready',
	        type: actionKey,
	        operatorStatus: packet.redacted === true ? 'redacted' : null
	      });
	    } catch (err) {
	      setError(err?.message || String(err));
	    } finally {
	      setFixingId('');
	    }
	  }, [snapshot?.workspace?.id]);

	  const exportLiveReleaseBlockerQueue = useCallback(async () => {
	    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
	    const actionKey = 'export_live_release_blocker_queue';
	    const params = {
	      workspaceId,
	      limit: 50,
	      ...(selectedLiveReleaseQueueFilter.params || {})
	    };
	    setFixingId(actionKey);
	    setError('');
	    setFixResult(null);
	    try {
	      const queue = await api.getPortfolioLiveReleaseBlockerQueue(params);
	      const exported = await api.exportPortfolioLiveReleaseBlockerQueue(params);
	      const checksum = exported?.integrityManifest?.checksum || '';
	      const count = Number(queue?.count ?? exported?.commandCount ?? 0);
	      const urgencyBand = queue?.topUrgencyBand || exported?.topUrgencyBand || 'none';
	      const receipts = checksum ? await refreshLiveReleaseBlockerQueueExportReviews({ checksum }) : [];
	      const reviewedReceipt = receipts.find((receipt) => receipt.checksum === checksum) || null;
	      setLastLiveReleaseQueueExport(checksum ? {
	        workspaceId,
	        filterLabel: selectedLiveReleaseQueueFilter.label,
	        filterSummary: exported?.filterSummary || {},
	        integrityManifest: exported?.integrityManifest || {},
	        reviewComparison: exported?.reviewComparison || null,
	        commandCount: exported?.integrityManifest?.commandCount ?? exported?.count ?? count,
	        commandIds: exported?.integrityManifest?.commandIds || [],
	        reviewedReceiptId: reviewedReceipt?.id || null
	      } : null);
	      setFixResult({
	        label: `${selectedLiveReleaseQueueFilter.label}: ${count} blockers · ${formatLabel(urgencyBand)} · ${checksum ? checksum.slice(0, 12) : 'no checksum'}`,
	        type: actionKey,
	        operatorStatus: reviewedReceipt ? 'already acknowledged' : selectedLiveReleaseQueueFilter.label,
	        requiredLiveEvidenceKey: checksum ? `sha256 ${checksum.slice(0, 12)}` : null
	      });
	    } catch (err) {
	      setError(err?.message || String(err));
	    } finally {
	      setFixingId('');
	    }
	  }, [refreshLiveReleaseBlockerQueueExportReviews, selectedLiveReleaseQueueFilter, snapshot?.workspace?.id]);

	  const acknowledgeLiveReleaseBlockerQueueExportReview = useCallback(async () => {
	    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
	    const actionKey = 'acknowledge_live_release_blocker_queue_export_review';
	    const packet = lastLiveReleaseQueueExport;
	    if (!packet?.integrityManifest?.checksum) {
	      setError('Export a blocker queue before acknowledging its checksum.');
	      return;
	    }
	    const existingReceipt = currentLiveReleaseQueueReviewReceipt;
	    if (existingReceipt) {
	      setFixResult({
	        label: existingReceipt.summary || `Reviewed queue checksum ${packet.integrityManifest.checksum.slice(0, 12)}`,
	        type: actionKey,
	        operatorStatus: 'already acknowledged',
	        requiredLiveEvidenceKey: 'live execution still blocked'
	      });
	      return;
	    }
	    setFixingId(actionKey);
	    setError('');
	    setFixResult(null);
	    try {
	      const result = await api.recordPortfolioLiveReleaseBlockerQueueExportReview({
	        workspaceId,
	        integrityManifest: packet.integrityManifest,
	        filterSummary: packet.filterSummary,
	        commandCount: packet.commandCount,
	        commandIds: packet.commandIds,
	        operatorId: 'portfolio_ui',
	        evidence: [{
	          source: 'portfolio_ui',
	          action: actionKey,
	          checksum: packet.integrityManifest.checksum,
	          blockersResolved: false,
	          liveExecutionAllowed: false,
	          externalSideEffects: false
	        }]
	      });
	      const receipt = result?.receipt || {};
	      setFixResult({
	        label: receipt.summary || `Reviewed queue checksum ${packet.integrityManifest.checksum.slice(0, 12)}`,
	        type: actionKey,
	        operatorStatus: receipt.status || 'reviewed_redacted_queue_export',
	        requiredLiveEvidenceKey: 'live execution still blocked'
	      });
	      const receipts = await refreshLiveReleaseBlockerQueueExportReviews({ checksum: packet.integrityManifest.checksum });
	      const reviewedReceipt = receipts.find((item) => item.checksum === packet.integrityManifest.checksum) || receipt;
	      setLastLiveReleaseQueueExport((current) => current?.integrityManifest?.checksum === packet.integrityManifest.checksum
	        ? {
	            ...current,
	            reviewedReceiptId: reviewedReceipt?.id || receipt.id || null,
	            reviewComparison: {
	              ...(current.reviewComparison || {}),
	              status: 'matches_latest_acknowledgement',
	              latestAcknowledgedChecksum: packet.integrityManifest.checksum,
	              latestReceiptId: reviewedReceipt?.id || receipt.id || null
	            }
	          }
	        : current);
	    } catch (err) {
	      setError(err?.message || String(err));
	    } finally {
	      setFixingId('');
	    }
	  }, [currentLiveReleaseQueueReviewReceipt, lastLiveReleaseQueueExport, refreshLiveReleaseBlockerQueueExportReviews, snapshot?.workspace?.id]);

	  const updateReadinessAdapterProof = useCallback((itemId, patch) => {
	    setAdapterProofs((current) => ({
	      ...current,
	      [itemId]: {
	        ...(current[itemId] || {}),
	        ...patch
	      }
	    }));
	  }, []);

	  const updateReadinessProviderSmokeProof = useCallback((itemId, patch) => {
	    setProviderSmokeProofs((current) => ({
	      ...current,
	      [itemId]: {
	        ...(current[itemId] || {}),
	        ...patch
	      }
	    }));
	  }, []);

  const queueRetentionCommandWorkItems = useCallback(async (item, command) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(`${item.id}:${command.action}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordRetentionCommandWorkItems(item.retentionCohortRollupId || item.id, {
        actor: 'portfolio_ui',
        blockerKeys: item.blockers || [],
        evidence: [{ source: 'portfolio_ui', id: item.id, action: command.action }]
      });
      setFixResult({
        label: result?.summary || item.serviceBusinessName,
        type: command.action
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const decideRetentionCommandWorkItem = useCallback(async (item, workItem, actionKind = 'approve') => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const key = `${workItem.id}:${actionKind}`;
    setFixingId(key);
    setError('');
    setFixResult(null);
    try {
      const result = await api.decideRetentionCommandWorkItem(workItem.id, {
        actor: 'portfolio_ui',
        actionKind,
        proof: {
          source: 'portfolio_ui',
          requiredProof: workItem.proofKey,
          externalSideEffects: false
        },
        evidence: [{ source: 'portfolio_ui', id: item.id, workItemId: workItem.id, action: actionKind }]
      });
      setFixResult({
        label: result?.receipt?.summary || workItem.title,
        type: `retention_command_work_item_${actionKind}`
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const claimRetentionCommandWorkItem = useCallback(async (item, workItem) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const operatorId = snapshot?.operators?.[0]?.id || null;
    const key = `${workItem.id}:claim`;
    setFixingId(key);
    setError('');
    setFixResult(null);
    try {
      const result = await api.claimRetentionCommandWorkItem(workItem.id, {
        actor: 'portfolio_ui',
        operatorId,
        leaseDurationMs: 30 * 60 * 1000,
        proof: {
          source: 'portfolio_ui',
          requiredProof: workItem.proofKey,
          externalSideEffects: false
        },
        evidence: [{ source: 'portfolio_ui', id: item.id, workItemId: workItem.id, action: 'claim' }]
      });
      setFixResult({
        label: result?.receipt?.summary || workItem.title,
        type: 'retention_command_work_item_claim'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.operators, snapshot?.workspace?.id]);

  const releaseRetentionCommandWorkItem = useCallback(async (item, workItem) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const operatorId = workItem.lease?.operatorId || snapshot?.operators?.[0]?.id || null;
    const key = `${workItem.id}:release`;
    setFixingId(key);
    setError('');
    setFixResult(null);
    try {
      const result = await api.releaseRetentionCommandWorkItem(workItem.id, {
        actor: 'portfolio_ui',
        operatorId,
        proof: {
          source: 'portfolio_ui',
          requiredProof: workItem.proofKey,
          externalSideEffects: false
        },
        evidence: [{ source: 'portfolio_ui', id: item.id, workItemId: workItem.id, action: 'release' }]
      });
      setFixResult({
        label: result?.receipt?.summary || workItem.title,
        type: 'retention_command_work_item_release'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.operators, snapshot?.workspace?.id]);

  const expireRetentionCommandWorkItemLeases = useCallback(async (item, command) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const operatorId = snapshot?.operators?.[0]?.id || null;
    const key = `${item.id}:${command.action}`;
    setFixingId(key);
    setError('');
    setFixResult(null);
    try {
      const result = await api.expireRetentionCommandWorkItemLeases({
        actor: 'portfolio_ui',
        operatorId,
        workspaceId,
        retentionCohortRollupId: item.retentionCohortRollupId || item.id,
        retentionCommandWorkItemReceiptId: item.latestCommandWorkItemReceiptId || null,
        evidence: [{ source: 'portfolio_ui', id: item.id, action: command.action }]
      });
      setFixResult({
        label: result?.summary || `${result?.expiredCount || 0} expired`,
        type: command.action
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.operators, snapshot?.workspace?.id]);

  const recordRetentionCommandLeaseMaintenance = useCallback(async (item, command) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const key = `${item.id}:${command.action}`;
    setFixingId(key);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordRetentionCommandLeaseMaintenance({
        actor: 'portfolio_ui',
        workspaceId,
        retentionCohortRollupId: item.retentionCohortRollupId || item.id,
        retentionCommandWorkItemReceiptId: item.latestCommandWorkItemReceiptId || null,
        evidence: [{ source: 'portfolio_ui', id: item.id, action: command.action }]
      });
      setFixResult({
        label: result?.receipt?.summary || result?.summary || item.serviceBusinessName,
        type: command.action
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const collectRetentionCommandWorkItemProofPacket = useCallback(async (item, command) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const key = `${item.id}:${command.action}`;
    setFixingId(key);
    setError('');
    setFixResult(null);
    try {
      const result = await api.collectRetentionCommandWorkItemProofPacket(item.retentionCohortRollupId || item.id, {
        actor: 'portfolio_ui',
        retentionCommandWorkItemReceiptId: item.latestCommandWorkItemReceiptId || null
      });
      setFixResult({
        label: result?.summary || result?.proofPacket?.status || item.serviceBusinessName,
        type: command.action
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const refreshOperatorQueues = useCallback(async (serviceBusinessId) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(`operator-queues:${serviceBusinessId}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.listPortfolioOperatorAssignmentQueues(serviceBusinessId, { refresh: true, limit: 50 });
      setFixResult({ label: `${result?.queues?.length || 0} role queues`, type: 'operator_queue_refresh' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const claimOperatorQueueItem = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const operatorId = snapshot?.operators?.[0]?.id || 'portfolio_ui';
    if (!row?.claimableItem) return;
    setFixingId(`operator-claim:${row.claimableItem.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.claimPortfolioOperatorInboxItem(row.claimableItem.id, {
        operatorId,
        leaseDurationMs: 30 * 60 * 1000,
        summary: 'Portfolio UI claimed this local operator queue item.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key
        }]
      });
      setFixResult({ label: result?.assignment?.role_key || row.queue.role_key, type: 'operator_claim' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.operators, snapshot?.workspace?.id]);

  const releaseOperatorAssignment = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const operatorId = row?.activeAssignment?.operator_id || snapshot?.operators?.[0]?.id || 'portfolio_ui';
    if (!row?.activeAssignment) return;
    setFixingId(`operator-release:${row.activeAssignment.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.releasePortfolioOperatorInboxItem(row.activeAssignment.inbox_item_id, {
        assignmentId: row.activeAssignment.id,
        operatorId,
        summary: 'Portfolio UI released this local operator queue item.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key
        }]
      });
      setFixResult({ label: result?.assignment?.role_key || row.queue.role_key, type: 'operator_release' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.operators, snapshot?.workspace?.id]);

  const expireOperatorLeases = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const operatorId = snapshot?.operators?.[0]?.id || 'portfolio_ui';
    setFixingId(`operator-expire:${row.queue.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.expirePortfolioOperatorInboxLeases({
        serviceBusinessId: row.queue.service_business_id,
        operatorId,
        summary: 'Portfolio UI expired local operator claim leases.'
      });
      setFixResult({ label: `${result?.expiredCount || 0} expired`, type: 'operator_expire_leases' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.operators, snapshot?.workspace?.id]);

  const recordOperatorBulkReview = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const operatorId = snapshot?.operators?.[0]?.id || 'portfolio_ui';
    setFixingId(`operator-bulk:${row.queue.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioOperatorBulkReview(row.queue.service_business_id, {
        roleKey: row.queue.role_key,
        operatorId,
        decision: 'needs_operator_review',
        summary: 'Portfolio UI grouped this queue for local bulk review.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          itemCount: row.queueItems.length
        }]
      });
      setFixResult({ label: result?.receipt?.decision || row.queue.role_key, type: 'operator_bulk_review' });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.operators, snapshot?.workspace?.id]);

  const recordOperatorStaffingAnalytics = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    setFixingId(`operator-staffing:${row.queue.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioOperatorStaffingAnalytics(row.queue.service_business_id, {
        roleKey: row.queue.role_key,
        summary: 'Portfolio UI recorded local SLA staffing analytics for this operator queue.'
      });
      setFixResult({
        label: `${result?.summary?.staffingGapCount || 0} gap / ${result?.summary?.overdueItemCount || 0} overdue`,
        type: 'operator_staffing_analytics'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const closeoutOperatorHandoffEval = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    const operatorId = snapshot?.operators?.[0]?.id || 'portfolio_ui';
    if (!row?.latestReceipt) return;
    setFixingId(`operator-eval-closeout:${row.latestReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.closeoutPortfolioOperatorHandoffEval(row.latestReceipt.id, {
        operatorId,
        summary: 'Portfolio UI accepted this local handoff review as an eval artifact.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key
        }]
      });
      setFixResult({
        label: result?.closeout?.eval_key || row.queue.role_key,
        type: 'operator_handoff_eval_closeout'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.operators, snapshot?.workspace?.id]);

  const recordEvalPublicationGate = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestCloseout) return;
    setFixingId(`eval-publication:${row.latestCloseout.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalPublicationGate(row.latestCloseout.id, {
        summary: 'Portfolio UI recorded this accepted handoff eval as a blocked executable publication gate.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          closeoutId: row.latestCloseout.id
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestCloseout.eval_key || row.queue.role_key,
        type: 'eval_publication_gate'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalFixtureWorkItems = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestPublicationReceipt) return;
    setFixingId(`eval-fixtures:${row.latestPublicationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalFixtureWorkItems(row.latestPublicationReceipt.id, {
        summary: 'Portfolio UI queued local eval fixture and harness work items without writing tests or touching CI.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          publicationReceiptId: row.latestPublicationReceipt.id
        }]
      });
      setFixResult({
        label: result?.publicationReceipt?.eval_key || row.latestPublicationReceipt.eval_key || row.queue.role_key,
        type: 'eval_fixture_work_items'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalFixtureRunnerDryRun = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestPublicationReceipt) return;
    setFixingId(`eval-runner:${row.latestPublicationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalFixtureRunnerDryRun(row.latestPublicationReceipt.id, {
        summary: 'Portfolio UI recorded a local eval fixture runner dry run without executing a harness, writing tests, or touching CI.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          publicationReceiptId: row.latestPublicationReceipt.id
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestPublicationReceipt.eval_key || row.queue.role_key,
        type: 'eval_fixture_runner_dry_run'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalFixtureApproval = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestFixtureRunnerReceipt) return;
    setFixingId(`eval-approval:${row.latestFixtureRunnerReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalFixtureApproval(row.latestFixtureRunnerReceipt.id, {
        summary: 'Portfolio UI approved this local eval fixture for non-live runner use while keeping executable publication blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          runnerReceiptId: row.latestFixtureRunnerReceipt.id
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestFixtureRunnerReceipt.eval_key || row.queue.role_key,
        type: 'eval_fixture_approval'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalGoldenFixtureReview = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestFixtureApprovalReceipt) return;
    setFixingId(`eval-golden:${row.latestFixtureApprovalReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalGoldenFixtureReview(row.latestFixtureApprovalReceipt.id, {
        summary: 'Portfolio UI reviewed this golden fixture locally while keeping executable eval publication blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          approvalReceiptId: row.latestFixtureApprovalReceipt.id
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestFixtureApprovalReceipt.eval_key || row.queue.role_key,
        type: 'eval_golden_fixture_review'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalNonLiveRunnerBinding = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestGoldenFixtureReviewReceipt) return;
    setFixingId(`eval-binding:${row.latestGoldenFixtureReviewReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalNonLiveRunnerBinding(row.latestGoldenFixtureReviewReceipt.id, {
        summary: 'Portfolio UI bound this accepted golden fixture to a non-live runner manifest without executing commands or publishing evals.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          goldenReviewReceiptId: row.latestGoldenFixtureReviewReceipt.id
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestGoldenFixtureReviewReceipt.eval_key || row.queue.role_key,
        type: 'eval_non_live_runner_binding'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalFileDryRunManifest = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestNonLiveRunnerBindingReceipt) return;
    setFixingId(`eval-file-manifest:${row.latestNonLiveRunnerBindingReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalFileDryRunManifest(row.latestNonLiveRunnerBindingReceipt.id, {
        summary: 'Portfolio UI reviewed this executable eval file manifest locally without writing files, running commands, or publishing evals.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          runnerBindingReceiptId: row.latestNonLiveRunnerBindingReceipt.id
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestNonLiveRunnerBindingReceipt.eval_key || row.queue.role_key,
        type: 'eval_file_dry_run_manifest'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalCiWriteAccessProof = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalFileDryRunManifest) return;
    setFixingId(`eval-ci-write:${row.latestEvalFileDryRunManifest.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalCiWriteAccessProof(row.latestEvalFileDryRunManifest.id, {
        summary: 'Portfolio UI reviewed CI write-access proof locally without mutating workflow files or publishing executable evals.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          fileManifestId: row.latestEvalFileDryRunManifest.id,
          ciWorkflowMutated: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalFileDryRunManifest.eval_key || row.queue.role_key,
        type: 'eval_ci_write_access_proof'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalLiveAdapterReadiness = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalCiWriteAccessReceipt) return;
    setFixingId(`eval-live-adapter:${row.latestEvalCiWriteAccessReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalLiveAdapterReadiness(row.latestEvalCiWriteAccessReceipt.id, {
        summary: 'Portfolio UI reviewed live-adapter readiness locally without invoking adapters or publishing executable evals.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          ciWriteReceiptId: row.latestEvalCiWriteAccessReceipt.id,
          liveAdapterInvoked: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalCiWriteAccessReceipt.eval_key || row.queue.role_key,
        type: 'eval_live_adapter_readiness'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalLiveAdapterContractTest = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalLiveAdapterReadinessReceipt) return;
    setFixingId(`eval-live-adapter-contract:${row.latestEvalLiveAdapterReadinessReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalLiveAdapterContractTest(row.latestEvalLiveAdapterReadinessReceipt.id, {
        summary: 'Portfolio UI ran the local live-adapter contract test through in-process handoff fixtures without live side effects.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          liveAdapterReadinessReceiptId: row.latestEvalLiveAdapterReadinessReceipt.id,
          inProcessContractTest: true,
          liveAdapterInvoked: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalLiveAdapterReadinessReceipt.eval_key || row.queue.role_key,
        type: 'eval_live_adapter_contract_test'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalCiWorkflowPublication = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalLiveAdapterContractTestReceipt) return;
    setFixingId(`eval-ci-workflow:${row.latestEvalLiveAdapterContractTestReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalCiWorkflowPublication(row.latestEvalLiveAdapterContractTestReceipt.id, {
        summary: 'Portfolio UI recorded local CI workflow publication proof while external CI remains unobserved.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          contractTestReceiptId: row.latestEvalLiveAdapterContractTestReceipt.id,
          localCiWriteAccessGranted: true,
          externalCiRunObserved: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalLiveAdapterContractTestReceipt.eval_key || row.queue.role_key,
        type: 'eval_ci_workflow_publication'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalGeneratedArtifactPromotion = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalCiWorkflowPublicationReceipt) return;
    setFixingId(`eval-promotion:${row.latestEvalCiWorkflowPublicationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalGeneratedArtifactPromotion(row.latestEvalCiWorkflowPublicationReceipt.id, {
        summary: 'Portfolio UI promoted generated eval artifact for external CI review while merge and live side effects remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          ciWorkflowPublicationReceiptId: row.latestEvalCiWorkflowPublicationReceipt.id,
          externalCiResultIngested: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalCiWorkflowPublicationReceipt.eval_key || row.queue.role_key,
        type: 'eval_generated_artifact_promotion'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalPrMergeProposalGate = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalGeneratedArtifactPromotionReceipt) return;
    setFixingId(`eval-pr-proposal:${row.latestEvalGeneratedArtifactPromotionReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalPrMergeProposalGate(row.latestEvalGeneratedArtifactPromotionReceipt.id, {
        summary: 'Portfolio UI prepared local PR merge proposal gate while external CI and merge remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          generatedArtifactPromotionReceiptId: row.latestEvalGeneratedArtifactPromotionReceipt.id,
          pullRequestOpened: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalGeneratedArtifactPromotionReceipt.eval_key || row.queue.role_key,
        type: 'eval_pr_merge_proposal'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalPrOpenSimulation = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalPrMergeProposalReceipt) return;
    setFixingId(`eval-pr-open:${row.latestEvalPrMergeProposalReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalPrOpenSimulation(row.latestEvalPrMergeProposalReceipt.id, {
        summary: 'Portfolio UI simulated a local PR open payload without submitting a pull request.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          prMergeProposalReceiptId: row.latestEvalPrMergeProposalReceipt.id,
          pullRequestSubmitted: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalPrMergeProposalReceipt.eval_key || row.queue.role_key,
        type: 'eval_pr_open_simulation'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalOperatorMergeApprovalReview = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalPrOpenSimulationReceipt) return;
    setFixingId(`eval-merge-approval:${row.latestEvalPrOpenSimulationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalOperatorMergeApprovalReview(row.latestEvalPrOpenSimulationReceipt.id, {
        summary: 'Portfolio UI reviewed operator merge approval and kept merge blocked until PR submission and external CI exist.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          prOpenSimulationReceiptId: row.latestEvalPrOpenSimulationReceipt.id,
          operatorMergeApproved: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalPrOpenSimulationReceipt.eval_key || row.queue.role_key,
        type: 'eval_operator_merge_approval'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalSubmittedPrEvidence = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalOperatorMergeApprovalReceipt) return;
    const prUrl = `https://github.com/callan-ai/callan/pull/${String(row.latestEvalOperatorMergeApprovalReceipt.id || row.queue.id).replace(/[^0-9]/g, '').slice(-3) || '145'}`;
    setFixingId(`eval-submitted-pr:${row.latestEvalOperatorMergeApprovalReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalSubmittedPrEvidence(row.latestEvalOperatorMergeApprovalReceipt.id, {
        pullRequestUrl: prUrl,
        summary: 'Portfolio UI recorded submitted PR evidence while external CI, merge approval, and merge remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          operatorMergeApprovalReceiptId: row.latestEvalOperatorMergeApprovalReceipt.id,
          pullRequestMutatedByReceipt: false,
          pullRequestExternallyVerified: false,
          externalCiResultIngested: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalOperatorMergeApprovalReceipt.eval_key || row.queue.role_key,
        type: 'eval_submitted_pr_evidence'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalPrExternalVerification = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalSubmittedPrEvidenceReceipt) return;
    setFixingId(`eval-pr-verify:${row.latestEvalSubmittedPrEvidenceReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalPrExternalVerification(row.latestEvalSubmittedPrEvidenceReceipt.id, {
        summary: 'Portfolio UI reconciled submitted PR evidence while GitHub verification, external CI, and merge remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          submittedPrEvidenceReceiptId: row.latestEvalSubmittedPrEvidenceReceipt.id,
          githubApiCalled: false,
          pullRequestExternallyVerified: false,
          externalCiResultIngested: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalSubmittedPrEvidenceReceipt.eval_key || row.queue.role_key,
        type: 'eval_pr_external_verification'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalExternalCiResult = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalPrExternalVerificationReceipt) return;
    const runId = String(row.latestEvalPrExternalVerificationReceipt.id || row.queue.id).replace(/[^0-9]/g, '').slice(-6) || '148000';
    setFixingId(`eval-external-ci:${row.latestEvalPrExternalVerificationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalExternalCiResult(row.latestEvalPrExternalVerificationReceipt.id, {
        ciProvider: 'github_actions',
        ciRunUrl: `https://github.com/callan-ai/callan/actions/runs/${runId}`,
        ciStatus: 'passed',
        summary: 'Portfolio UI ingested operator-provided external CI result while GitHub verification, merge approval, and merge remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          prExternalVerificationReceiptId: row.latestEvalPrExternalVerificationReceipt.id,
          githubApiCalled: false,
          ciRunnerExecuted: false,
          externalCiResultVerifiedByApp: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalPrExternalVerificationReceipt.eval_key || row.queue.role_key,
        type: 'eval_external_ci_result'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalGithubPrVerification = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalExternalCiResultReceipt) return;
    setFixingId(`eval-github-pr:${row.latestEvalExternalCiResultReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalGithubPrVerification(row.latestEvalExternalCiResultReceipt.id, {
        summary: 'Portfolio UI prepared GitHub PR verification preflight while live GitHub API observation, operator approval, and merge remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          externalCiResultReceiptId: row.latestEvalExternalCiResultReceipt.id,
          githubApiCalled: false,
          pullRequestExternallyVerified: false,
          githubMutation: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalExternalCiResultReceipt.eval_key || row.queue.role_key,
        type: 'eval_github_pr_verification'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalGithubPrObservation = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalGithubPrVerificationReceipt) return;
    setFixingId(`eval-github-pr-observe:${row.latestEvalGithubPrVerificationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalGithubPrObservation(row.latestEvalGithubPrVerificationReceipt.id, {
        summary: 'Portfolio UI recorded the non-mutating GitHub PR observation adapter contract while live GitHub reads, operator approval, and merge remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          githubPrVerificationReceiptId: row.latestEvalGithubPrVerificationReceipt.id,
          contractPassed: true,
          githubApiCalled: false,
          liveGithubObservation: false,
          pullRequestExternallyVerified: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalGithubPrVerificationReceipt.eval_key || row.queue.role_key,
        type: 'eval_github_pr_observation'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalGithubCheckRunObservation = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalGithubPrObservationReceipt) return;
    setFixingId(`eval-github-check-run:${row.latestEvalGithubPrObservationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalGithubCheckRunObservation(row.latestEvalGithubPrObservationReceipt.id, {
        summary: 'Portfolio UI recorded read-only GitHub check-run observation while operator approval and merge remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          githubPrObservationReceiptId: row.latestEvalGithubPrObservationReceipt.id,
          requestedFromPortfolioOperatorQueue: true,
          githubMutation: false,
          pullRequestMutatedByReceipt: false,
          mergeAllowed: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalGithubPrObservationReceipt.eval_key || row.queue.role_key,
        type: 'eval_github_check_run_observation'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeExecutionAdapterContract = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalGithubCheckRunObservationReceipt) return;
    setFixingId(`eval-merge-adapter-contract:${row.latestEvalGithubCheckRunObservationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalMergeExecutionAdapterContract(row.latestEvalGithubCheckRunObservationReceipt.id, {
        summary: 'Portfolio UI recorded the non-mutating merge execution adapter contract while live merge execution remains blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          githubCheckRunObservationReceiptId: row.latestEvalGithubCheckRunObservationReceipt.id,
          requestedFromPortfolioOperatorQueue: true,
          adapterMutationAttempted: false,
          githubMutation: false,
          mergeAllowed: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalGithubCheckRunObservationReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_execution_adapter_contract'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalOperatorMergeCompletionGate = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalGithubCheckRunObservationReceipt || !row?.latestEvalMergeExecutionAdapterContractReceipt) return;
    setFixingId(`eval-merge-completion:${row.latestEvalGithubCheckRunObservationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalOperatorMergeCompletionGate(row.latestEvalGithubCheckRunObservationReceipt.id, {
        summary: 'Portfolio UI reviewed the operator merge completion gate with merge adapter contract proof while live GitHub proof, operator approval, and merge execution remain blocked.',
        operatorDecision: {
          operatorMergeApproved: false,
          mergeAllowed: false,
          mergeExecuted: false
        },
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          githubCheckRunObservationReceiptId: row.latestEvalGithubCheckRunObservationReceipt.id,
          mergeExecutionAdapterContractReceiptId: row.latestEvalMergeExecutionAdapterContractReceipt.id,
          requestedFromPortfolioOperatorQueue: true,
          sandboxCheckRunEvidenceRejected: true,
          mergeExecutionAdapterContractObserved: true,
          operatorMergeApproved: false,
          mergeAllowed: false,
          mergeExecuted: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalGithubCheckRunObservationReceipt.eval_key || row.queue.role_key,
        type: 'eval_operator_merge_completion_gate'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalLiveMergeAuthorization = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalOperatorMergeCompletionGateReceipt) return;
    setFixingId(`eval-live-merge-auth:${row.latestEvalOperatorMergeCompletionGateReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalLiveMergeAuthorization(row.latestEvalOperatorMergeCompletionGateReceipt.id, {
        summary: 'Portfolio UI reviewed live merge authorization while real-token approval, branch protection proof, and live merge execution remain blocked.',
        authorizationRequest: {
          realTokenAuthorizationPresent: false,
          mergeExecutionAuthorized: false,
          mergeAllowed: false,
          mergeExecuted: false
        },
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          operatorMergeCompletionGateReceiptId: row.latestEvalOperatorMergeCompletionGateReceipt.id,
          mergeExecutionAdapterContractReceiptId: row.latestEvalMergeExecutionAdapterContractReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          realTokenAuthorizationPresent: false,
          branchProtectionVerified: false,
          mergeExecutionAuthorized: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalOperatorMergeCompletionGateReceipt.eval_key || row.queue.role_key,
        type: 'eval_live_merge_authorization'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalBranchProtectionReadbackAdapterContract = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalLiveMergeAuthorizationReceipt) return;
    setFixingId(`eval-branch-protection-readback:${row.latestEvalLiveMergeAuthorizationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalBranchProtectionReadbackAdapterContract(row.latestEvalLiveMergeAuthorizationReceipt.id, {
        summary: 'Portfolio UI recorded the branch-protection readback adapter contract while live GitHub reads, token observation, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt.id,
          requestedFromPortfolioOperatorQueue: true,
          liveGithubApiCalled: false,
          branchProtectionMutated: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalLiveMergeAuthorizationReceipt.eval_key || row.queue.role_key,
        type: 'eval_branch_protection_readback_adapter_contract'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalTokenScopeObservationAdapterContract = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalLiveMergeAuthorizationReceipt) return;
    setFixingId(`eval-token-scope-observation:${row.latestEvalLiveMergeAuthorizationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalTokenScopeObservationAdapterContract(row.latestEvalLiveMergeAuthorizationReceipt.id, {
        branchProtectionReadbackAdapterContractReceiptId: row.latestEvalBranchProtectionReadbackAdapterContractReceipt?.id || null,
        summary: 'Portfolio UI recorded the token-scope observation adapter contract while real-token authorization, token reads, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt.id,
          branchProtectionReadbackAdapterContractReceiptId: row.latestEvalBranchProtectionReadbackAdapterContractReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          tokenPresenceObserved: false,
          tokenValuePersisted: false,
          liveGithubApiCalled: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalLiveMergeAuthorizationReceipt.eval_key || row.queue.role_key,
        type: 'eval_token_scope_observation_adapter_contract'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalSecretRedactionProof = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalTokenScopeObservationAdapterContractReceipt) return;
    setFixingId(`eval-secret-redaction:${row.latestEvalTokenScopeObservationAdapterContractReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalSecretRedactionProof(row.latestEvalTokenScopeObservationAdapterContractReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        summary: 'Portfolio UI recorded secret redaction proof while raw token persistence, live GitHub calls, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          tokenScopeObservationAdapterContractReceiptId: row.latestEvalTokenScopeObservationAdapterContractReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          redactionVerified: true,
          rawSecretPersisted: false,
          tokenValuePersisted: false,
          liveGithubApiCalled: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalTokenScopeObservationAdapterContractReceipt.eval_key || row.queue.role_key,
        type: 'eval_secret_redaction_proof'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueReadbackAdapterContract = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalSecretRedactionProofReceipt) return;
    setFixingId(`eval-merge-queue-readback:${row.latestEvalSecretRedactionProofReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const branchProtectionProof = row.latestEvalLiveMergeAuthorizationReceipt?.response?.branchProtectionProof || {};
      const result = await api.recordPortfolioEvalMergeQueueReadbackAdapterContract(row.latestEvalSecretRedactionProofReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        targetBranch: branchProtectionProof.targetBranch || row.latestEvalBranchProtectionReadbackAdapterContractReceipt?.target_branch || 'main',
        requiredStatusChecks: branchProtectionProof.requiredStatusChecks || ['check', 'check:maygoals', 'build'],
        summary: 'Portfolio UI recorded merge queue readback contract while live GitHub reads, merge-queue mutation, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          secretRedactionProofReceiptId: row.latestEvalSecretRedactionProofReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          mergeQueueReadbackAdapterContractObserved: true,
          liveGithubApiCalled: false,
          mergeQueueMutated: false,
          mergeQueueLiveVerified: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalSecretRedactionProofReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_readback_adapter_contract'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueLiveReadReconciliation = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueReadbackAdapterContractReceipt) return;
    setFixingId(`eval-merge-queue-live-read:${row.latestEvalMergeQueueReadbackAdapterContractReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueReadbackAdapterContractReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueLiveReadReconciliation(row.latestEvalMergeQueueReadbackAdapterContractReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        targetBranch: row.latestEvalMergeQueueReadbackAdapterContractReceipt.target_branch || response.targetBranch || 'main',
        requiredStatusChecks: response.requiredStatusChecksContractShape || ['check', 'check:maygoals', 'build'],
        summary: 'Portfolio UI recorded merge queue live-read reconciliation as blocked until a real token and live GitHub readback exist.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueReadbackAdapterContractReceiptId: row.latestEvalMergeQueueReadbackAdapterContractReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          mergeQueueLiveReadReconciled: true,
          localContractObserved: true,
          realTokenObserved: false,
          mergeQueueLiveReadAttempted: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeQueueLiveVerified: false,
          mergeQueueMutated: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueReadbackAdapterContractReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_live_read_reconciliation'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueLiveReadAdapterContract = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueLiveReadReconciliationReceipt) return;
    setFixingId(`eval-merge-queue-live-read-adapter:${row.latestEvalMergeQueueLiveReadReconciliationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueLiveReadReconciliationReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueLiveReadAdapterContract(row.latestEvalMergeQueueLiveReadReconciliationReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        targetBranch: row.latestEvalMergeQueueLiveReadReconciliationReceipt.target_branch || response.targetBranch || 'main',
        requiredStatusChecks: response.requiredStatusChecksContractShape || ['check', 'check:maygoals', 'build'],
        requiredTokenScopes: ['contents:read', 'metadata:read', 'pull_requests:read', 'administration:read'],
        summary: 'Portfolio UI recorded merge queue live-read adapter contract while real-token GitHub reads and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueLiveReadReconciliationReceiptId: row.latestEvalMergeQueueLiveReadReconciliationReceipt.id,
          mergeQueueReadbackAdapterContractReceiptId: row.latestEvalMergeQueueReadbackAdapterContractReceipt?.id || null,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          liveReadAdapterContractObserved: true,
          localReconciliationObserved: true,
          realTokenObserved: false,
          liveReadAttempted: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeQueueLiveVerified: false,
          adapterMutationAttempted: false,
          mergeQueueMutated: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueLiveReadReconciliationReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_live_read_adapter_contract'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueLiveReadReadiness = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueLiveReadAdapterContractReceipt) return;
    setFixingId(`eval-merge-queue-live-read-readiness:${row.latestEvalMergeQueueLiveReadAdapterContractReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueLiveReadAdapterContractReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueLiveReadReadiness(row.latestEvalMergeQueueLiveReadAdapterContractReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        targetBranch: row.latestEvalMergeQueueLiveReadAdapterContractReceipt.target_branch || response.targetBranch || 'main',
        requiredStatusChecks: response.requiredStatusChecksContractShape || ['check', 'check:maygoals', 'build'],
        requiredTokenScopes: response.requiredTokenScopesContractShape || ['contents:read', 'metadata:read', 'pull_requests:read', 'administration:read'],
        requiredSecretRefs: ['GITHUB_MERGE_QUEUE_READ_TOKEN'],
        requiredOperatorApprovals: ['live_github_readback_approval', 'merge_queue_readback_operator_ack'],
        summary: 'Portfolio UI recorded guarded merge queue live-read readiness while token values, live GitHub reads, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueLiveReadAdapterContractReceiptId: row.latestEvalMergeQueueLiveReadAdapterContractReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          adapterContractObserved: true,
          requiredSecretRefs: ['GITHUB_MERGE_QUEUE_READ_TOKEN'],
          tokenValueIncluded: false,
          tokenValuePersisted: false,
          realTokenObserved: false,
          liveReadAttempted: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeQueueLiveVerified: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueLiveReadAdapterContractReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_live_read_readiness'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueCredentialHandoff = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueLiveReadReadinessReceipt) return;
    setFixingId(`eval-merge-queue-credential-handoff:${row.latestEvalMergeQueueLiveReadReadinessReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueLiveReadReadinessReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueCredentialHandoff(row.latestEvalMergeQueueLiveReadReadinessReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        targetBranch: row.latestEvalMergeQueueLiveReadReadinessReceipt.target_branch || response.targetBranch || 'main',
        requiredStatusChecks: response.requiredStatusChecksReadinessShape || ['check', 'check:maygoals', 'build'],
        requiredTokenScopes: response.requiredTokenScopesReadinessShape || ['contents:read', 'metadata:read', 'pull_requests:read', 'administration:read'],
        requiredSecretRefs: response.requiredSecretRefs || ['github_merge_queue_read_token'],
        requiredOperatorApprovals: ['credential_handoff_operator_ack', 'live_github_readback_approval'],
        secretStoreReference: 'github_actions_secret:GITHUB_MERGE_QUEUE_READ_TOKEN',
        custodyRequirements: ['secret_reference_only', 'operator_runtime_injection', 'no_database_persistence', 'redacted_logs_only', 'rotation_plan_required', 'revocation_plan_required'],
        rotationPlan: ['rotate_after_live_read', 'rotate_after_failed_live_read', 'rotate_before_operator_reassignment'],
        revocationPlan: ['revoke_on_failed_scope_check', 'revoke_on_operator_cancel', 'revoke_after_merge_closeout'],
        summary: 'Portfolio UI recorded merge queue credential handoff while secret values, live GitHub reads, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueLiveReadReadinessReceiptId: row.latestEvalMergeQueueLiveReadReadinessReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          readinessObserved: true,
          credentialReferenceDeclared: true,
          secretStoreReferenceDeclared: true,
          secretValueIncluded: false,
          secretValuePersisted: false,
          secretValueLogged: false,
          realTokenObserved: false,
          liveReadAttempted: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeQueueLiveVerified: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueLiveReadReadinessReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_credential_handoff'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueLiveReadPreflight = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueCredentialHandoffReceipt) return;
    setFixingId(`eval-merge-queue-live-read-preflight:${row.latestEvalMergeQueueCredentialHandoffReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueCredentialHandoffReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueLiveReadPreflight(row.latestEvalMergeQueueCredentialHandoffReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        targetBranch: row.latestEvalMergeQueueCredentialHandoffReceipt.target_branch || response.targetBranch || 'main',
        requiredStatusChecks: response.requiredStatusChecksHandoffShape || ['check', 'check:maygoals', 'build'],
        requiredTokenScopes: response.requiredTokenScopesHandoffShape || ['contents:read', 'metadata:read', 'pull_requests:read', 'administration:read'],
        runtimeSecretRef: response.requiredSecretRefs?.[0] || 'github_merge_queue_read_token',
        requestMethod: 'GET',
        apiVersion: '2022-11-28',
        acceptedMediaType: 'application/vnd.github+json',
        conditionalRequestHeader: 'If-None-Match',
        summary: 'Portfolio UI recorded merge queue live-read preflight envelope while token materialization, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueCredentialHandoffReceiptId: row.latestEvalMergeQueueCredentialHandoffReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          credentialHandoffObserved: true,
          requestEnvelopeBuilt: true,
          authHeaderPlanned: true,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          tokenValueIncluded: false,
          tokenValuePersisted: false,
          realTokenObserved: false,
          liveReadAttempted: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeQueueLiveVerified: false,
          mergeAllowed: false,
          mergeExecuted: false,
          githubMutation: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueCredentialHandoffReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_live_read_preflight'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueTokenQuarantine = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueLiveReadPreflightReceipt) return;
    setFixingId(`eval-merge-queue-token-quarantine:${row.latestEvalMergeQueueLiveReadPreflightReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueLiveReadPreflightReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueTokenQuarantine(row.latestEvalMergeQueueLiveReadPreflightReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        quarantinePolicy: ['memory_only', 'single_request_scope', 'redacted_observability', 'no_database_persistence', 'operator_release_required'],
        releaseGates: ['operator_release_ack', 'fresh_preflight_envelope', 'runtime_secret_provider_smoke', 'secret_redaction_guardrail'],
        rollbackPlan: ['discard_runtime_reference', 'clear_in_memory_header_builder', 'record_no_token_persisted'],
        summary: 'Portfolio UI recorded merge queue token materialization quarantine while token materialization, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueLiveReadPreflightReceiptId: row.latestEvalMergeQueueLiveReadPreflightReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          liveReadPreflightObserved: true,
          runtimeSecretRefObserved: true,
          quarantinePolicyRecorded: true,
          tokenMaterialized: false,
          tokenValuePersisted: false,
          tokenValueLogged: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueLiveReadPreflightReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_token_quarantine'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueLiveReadResponseIngestion = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueTokenQuarantineReceipt) return;
    setFixingId(`eval-merge-queue-live-read-response:${row.latestEvalMergeQueueTokenQuarantineReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalMergeQueueLiveReadResponseIngestion(row.latestEvalMergeQueueTokenQuarantineReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        responseSource: 'operator_supplied_github_rulesets_readback',
        observedHttpStatus: 200,
        observedEtag: 'W/"operator-supplied-merge-queue-rulesets"',
        observedRulesetIds: ['ruleset-merge-queue-main'],
        observedRequiredStatusChecks: ['build', 'test', 'lint'],
        observedMergeQueueRequired: true,
        summary: 'Portfolio UI recorded operator-supplied merge queue live-read response evidence while GitHub API calls and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueTokenQuarantineReceiptId: row.latestEvalMergeQueueTokenQuarantineReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          operatorSuppliedResponseObserved: true,
          tokenQuarantineObserved: true,
          responsePayloadSchemaObserved: true,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeQueueLiveVerified: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueTokenQuarantineReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_live_read_response_ingestion'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueRuntimeTokenReleaseGate = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueLiveReadResponseIngestionReceipt) return;
    setFixingId(`eval-merge-queue-runtime-token-gate:${row.latestEvalMergeQueueLiveReadResponseIngestionReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalMergeQueueRuntimeTokenReleaseGate(row.latestEvalMergeQueueLiveReadResponseIngestionReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: 'github_merge_queue_read_token',
        releaseGateChecks: ['operator_release_ack', 'runtime_secret_provider_smoke', 'secret_redaction_guardrail', 'fresh_response_ingestion_receipt'],
        deniedReasons: ['operator_release_ack_missing', 'runtime_secret_provider_smoke_missing', 'live_github_http_not_allowed_by_receipt'],
        summary: 'Portfolio UI recorded merge queue runtime token release gate while token release, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueLiveReadResponseIngestionReceiptId: row.latestEvalMergeQueueLiveReadResponseIngestionReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          responseIngestionObserved: true,
          operatorReleaseAckRequired: true,
          runtimeSecretProviderSmokeRequired: true,
          tokenReleaseDenied: true,
          tokenReleased: false,
          tokenMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueLiveReadResponseIngestionReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_runtime_token_release_gate'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueLiveReadVerificationPromotion = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt) return;
    setFixingId(`eval-merge-queue-live-read-promotion:${row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalMergeQueueLiveReadVerificationPromotion(row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        promotionChecklist: ['runtime_token_gate_recorded', 'operator_response_evidence_present', 'live_http_execution_blocked', 'operator_live_verification_required'],
        liveVerificationPlan: ['obtain_operator_release_ack', 'run_secret_provider_smoke', 'materialize_header_in_memory_only', 'perform_single_github_ruleset_get'],
        summary: 'Portfolio UI queued merge queue live-read verification promotion while live GitHub HTTP and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueRuntimeTokenReleaseGateReceiptId: row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          runtimeTokenReleaseGateObserved: true,
          operatorResponseEvidenceObserved: true,
          liveVerificationPlanRecorded: true,
          liveVerificationPromoted: false,
          tokenReleased: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_live_read_verification_promotion'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueLiveHttpExecutionPreflightHandoff = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueLiveReadVerificationPromotionReceipt) return;
    setFixingId(`eval-merge-queue-live-http-preflight-handoff:${row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt?.response || {};
      const result = await api.recordPortfolioEvalMergeQueueLiveHttpExecutionPreflightHandoff(row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: 'GET',
        executionPreflightChecklist: ['live_read_verification_promotion_recorded', 'runtime_token_gate_recorded', 'operator_release_ack_required', 'runtime_secret_provider_smoke_required', 'single_github_ruleset_get_planned'],
        liveHttpExecutionPlan: ['verify_operator_live_http_release', 'run_secret_provider_smoke', 'materialize_authorization_header_in_memory_only', 'perform_single_github_ruleset_get', 'record_response_without_merge'],
        summary: 'Portfolio UI recorded merge queue live HTTP execution preflight handoff while token release, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueLiveReadVerificationPromotionReceiptId: row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt.id,
          mergeQueueRuntimeTokenReleaseGateReceiptId: row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt?.id || null,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          liveReadVerificationPromotionObserved: true,
          runtimeTokenReleaseGateObserved: true,
          operatorReleaseAckRequired: true,
          runtimeSecretProviderSmokeRequired: true,
          httpExecutionPlanRecorded: true,
          authorizationHeaderPlanRecorded: true,
          tokenReleased: false,
          tokenMaterialized: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_live_http_execution_preflight_handoff'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueLiveHttpOperatorReleaseAck = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt) return;
    setFixingId(`eval-merge-queue-live-http-release-ack:${row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueLiveHttpOperatorReleaseAck(row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        acknowledgedRisks: ['runtime_token_materialization', 'github_http_request', 'redacted_observability_required', 'no_merge_execution'],
        releaseAckChecklist: ['live_http_preflight_handoff_recorded', 'operator_release_ack_recorded', 'runtime_secret_provider_smoke_required', 'secret_redaction_guardrail_required'],
        liveHttpReleasePlan: ['run_runtime_secret_provider_smoke', 'verify_redaction_guardrail', 'release_runtime_token_memory_only', 'perform_single_github_ruleset_get', 'record_response_without_merge'],
        summary: 'Portfolio UI recorded merge queue live HTTP operator release acknowledgement while secret smoke, token release, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueLiveHttpExecutionPreflightHandoffReceiptId: row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          liveHttpExecutionPreflightHandoffObserved: true,
          operatorReleaseAckRecorded: true,
          operatorReleaseAckRequired: false,
          operatorLiveHttpRiskAcknowledged: true,
          runtimeSecretProviderSmokeRequired: true,
          secretRedactionGuardrailRequired: true,
          tokenReleaseApproved: false,
          tokenReleased: false,
          tokenMaterialized: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_live_http_operator_release_ack'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueRuntimeSecretProviderSmokeReadiness = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt) return;
    setFixingId(`eval-merge-queue-runtime-secret-smoke-readiness:${row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueRuntimeSecretProviderSmokeReadiness(row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        smokeProvider: 'runtime_secret_provider',
        smokeCommand: 'npm run smoke:provider -- --provider=github --secret-ref=github_merge_queue_read_token --dry-run',
        smokeReadinessChecklist: ['operator_release_ack_recorded', 'runtime_secret_ref_present', 'secret_redaction_guardrail_observed', 'dry_run_smoke_command_recorded'],
        liveHttpReleasePlan: ['execute_runtime_secret_provider_smoke', 'release_runtime_token_memory_only', 'perform_single_github_ruleset_get', 'record_response_without_merge'],
        summary: 'Portfolio UI recorded merge queue runtime secret-provider smoke readiness while smoke execution, token release, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueLiveHttpOperatorReleaseAckReceiptId: row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          liveHttpOperatorReleaseAckObserved: true,
          operatorReleaseAckRecorded: true,
          runtimeSecretProviderSmokeReadinessRecorded: true,
          runtimeSecretProviderSmokeExecuted: false,
          runtimeSecretProviderSmokePassed: false,
          runtimeSecretValueObserved: false,
          tokenReleaseApproved: false,
          tokenReleased: false,
          tokenMaterialized: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_runtime_secret_provider_smoke_readiness'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueRuntimeSecretProviderSmokeExecutionGate = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt) return;
    setFixingId(`eval-merge-queue-runtime-secret-smoke-execution-gate:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueRuntimeSecretProviderSmokeExecutionGate(row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        smokeProvider: response.smokeProvider || 'runtime_secret_provider',
        smokeCommand: 'npm run smoke:provider -- --provider=github --secret-ref=github_merge_queue_read_token --live',
        blockedReasons: ['live_runtime_secret_provider_not_enabled', 'runtime_secret_value_access_disallowed', 'token_release_requires_passed_smoke'],
        smokeExecutionChecklist: ['smoke_readiness_recorded', 'operator_release_ack_recorded', 'secret_access_blocked', 'token_release_denied'],
        liveHttpReleasePlan: ['run_successful_runtime_secret_provider_smoke', 'release_runtime_token_memory_only', 'perform_single_github_ruleset_get', 'record_response_without_merge'],
        summary: 'Portfolio UI recorded merge queue runtime secret-provider smoke execution gate while secret access, token release, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId: row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          runtimeSecretProviderSmokeReadinessObserved: true,
          runtimeSecretProviderSmokeExecutionBlocked: true,
          runtimeSecretProviderSmokeAttempted: false,
          runtimeSecretProviderSmokeExecuted: false,
          runtimeSecretProviderSmokePassed: false,
          runtimeSecretValueObserved: false,
          tokenReleaseApproved: false,
          tokenReleased: false,
          tokenMaterialized: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_runtime_secret_provider_smoke_execution_gate'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReview = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt) return;
    setFixingId(`eval-merge-queue-runtime-secret-smoke-evidence-review:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReview(row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        smokeProvider: response.smokeProvider || 'runtime_secret_provider',
        smokeCommand: response.smokeCommand || 'npm run smoke:provider -- --provider=github --secret-ref=github_merge_queue_read_token --live',
        evidenceRequirements: ['timestamped_smoke_command', 'provider_status_snapshot', 'redacted_success_output', 'operator_attestation', 'no_secret_value_logged'],
        evidenceFindings: ['successful_smoke_evidence_missing', 'runtime_secret_value_not_observed', 'token_release_still_denied'],
        releaseCriteria: ['successful_runtime_secret_provider_smoke_verified', 'memory_only_token_release_preflight', 'single_github_ruleset_get_response_capture', 'operator_merge_blocker_review'],
        summary: 'Portfolio UI recorded merge queue runtime secret-provider smoke evidence review while successful smoke proof, token release, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId: row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          runtimeSecretProviderSmokeExecutionGateObserved: true,
          successfulSmokeEvidenceRequired: true,
          successfulSmokeEvidenceObserved: false,
          runtimeSecretProviderSmokeVerified: false,
          runtimeSecretProviderSmokeAttempted: false,
          runtimeSecretProviderSmokeExecuted: false,
          runtimeSecretProviderSmokePassed: false,
          runtimeSecretValueObserved: false,
          tokenReleaseApproved: false,
          tokenReleased: false,
          tokenMaterialized: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_runtime_secret_provider_smoke_evidence_review'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflight = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt) return;
    setFixingId(`eval-merge-queue-memory-only-runtime-token-preflight:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflight(row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        releasePreflightRequirements: ['successful_smoke_evidence_observed', 'runtime_secret_provider_smoke_verified', 'memory_only_token_scope', 'redacted_authorization_header_plan'],
        releaseDeniedReasons: ['successful_smoke_evidence_missing', 'runtime_secret_provider_smoke_not_verified', 'token_materialization_disallowed'],
        nextLiveReadCriteria: ['memory_only_token_release_allowed', 'single_github_ruleset_get_only', 'record_response_without_merge'],
        summary: 'Portfolio UI recorded merge queue memory-only runtime token release preflight while successful smoke evidence, token release, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId: row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          runtimeSecretProviderSmokeEvidenceReviewObserved: true,
          successfulSmokeEvidenceObserved: false,
          runtimeSecretProviderSmokeVerified: false,
          memoryOnlyTokenReleaseAllowed: false,
          tokenReleaseApproved: false,
          tokenReleased: false,
          tokenMaterialized: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_memory_only_runtime_token_release_preflight'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueSuccessfulSmokeEvidenceIngestion = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt) return;
    setFixingId(`eval-merge-queue-successful-smoke-evidence-ingestion:${row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueSuccessfulSmokeEvidenceIngestion(row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        smokeProvider: 'runtime_secret_provider',
        claimedSmokeCommand: 'npm run smoke:provider -- --provider=github --secret-ref=github_merge_queue_read_token --live',
        evidenceSource: 'portfolio_operator_queue_panel',
        evidenceRequirements: ['timestamped_smoke_command', 'provider_status_snapshot', 'redacted_success_output', 'operator_attestation', 'no_secret_value_logged'],
        rejectionReasons: ['successful_smoke_claim_not_backed_by_execution_gate', 'runtime_secret_provider_smoke_not_verified', 'token_release_preflight_denied'],
        nextCriteria: ['real_runtime_secret_provider_smoke_execution_receipt', 'redacted_success_output_review', 'memory_only_token_release_recheck'],
        summary: 'Portfolio UI recorded merge queue successful smoke evidence ingestion rejection while fake success, token release, GitHub HTTP, and merge execution remain blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId: row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          successfulSmokeEvidenceSubmitted: true,
          successfulSmokeEvidenceAccepted: false,
          successfulSmokeEvidenceObserved: false,
          fakeSuccessClaimRejected: true,
          runtimeSecretProviderSmokeVerified: false,
          memoryOnlyTokenReleaseAllowed: false,
          tokenReleaseApproved: false,
          tokenReleased: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_successful_smoke_evidence_ingestion'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueRuntimeTokenReleaseDenial = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt) return;
    setFixingId(`eval-merge-queue-runtime-token-release-denial:${row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueRuntimeTokenReleaseDenial(row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        denialPolicy: 'successful_smoke_evidence_required_before_runtime_token_release',
        denialReasons: ['fake_success_claim_rejected', 'runtime_secret_provider_smoke_not_verified', 'successful_smoke_evidence_not_accepted'],
        retryCriteria: ['real_runtime_secret_provider_smoke_execution_receipt', 'accepted_redacted_success_output', 'fresh_memory_only_token_release_preflight'],
        summary: 'Portfolio UI recorded merge queue runtime token release denial after fake smoke evidence was rejected.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueSuccessfulSmokeEvidenceIngestionReceiptId: row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          fakeSuccessClaimRejected: true,
          runtimeTokenReleaseRequested: true,
          runtimeTokenReleaseDenied: true,
          tokenReleaseApproved: false,
          tokenReleased: false,
          tokenMaterialized: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_runtime_token_release_denial'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueFakeLiveReadReplayQuarantine = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt) return;
    setFixingId(`eval-merge-queue-fake-live-read-replay-quarantine:${row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueFakeLiveReadReplayQuarantine(row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        replaySource: 'operator_submitted_fake_live_read_response',
        quarantineReasons: ['runtime_token_release_denied', 'fake_live_read_response_reuse_attempt', 'live_github_http_not_permitted'],
        releaseCriteria: ['fresh_real_runtime_secret_provider_smoke_receipt', 'memory_only_token_release_recheck', 'new_live_read_preflight_with_runtime_token_release'],
        summary: 'Portfolio UI recorded merge queue fake live-read replay quarantine after runtime token release was denied.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueRuntimeTokenReleaseDenialReceiptId: row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          runtimeTokenReleaseDenied: true,
          fakeLiveReadReplaySubmitted: true,
          fakeLiveReadReplayQuarantined: true,
          liveReadResponseAccepted: false,
          liveReadReplayAccepted: false,
          tokenReleaseApproved: false,
          tokenReleased: false,
          tokenMaterialized: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeQueueLiveVerified: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_fake_live_read_replay_quarantine'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueFinalBlockerLedger = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt) return;
    setFixingId(`eval-merge-queue-final-blocker-ledger:${row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueueFinalBlockerLedger(row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        blockerEntries: ['runtime_secret_provider_smoke_missing', 'runtime_token_release_denied', 'fake_live_read_replay_quarantined', 'live_github_http_request_missing', 'merge_execution_blocked'],
        releaseCriteria: ['fresh_runtime_secret_provider_smoke_receipt', 'fresh_runtime_token_release_receipt', 'single_github_ruleset_get_http_receipt', 'operator_merge_release_ack'],
        summary: 'Portfolio UI recorded merge queue final blocker ledger after fake live-read replay quarantine.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueFakeLiveReadReplayQuarantineReceiptId: row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          runtimeTokenReleaseDenied: true,
          fakeLiveReadReplayQuarantined: true,
          finalBlockerLedgerSealed: true,
          requiredBlockersPresent: true,
          tokenReleaseApproved: false,
          tokenReleased: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          liveReadSucceeded: false,
          mergeQueueLiveVerified: false,
          mergeAllowed: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_final_blocker_ledger'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueuePostLedgerOperatorReleaseAttestation = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueueFinalBlockerLedgerReceipt) return;
    setFixingId(`eval-merge-queue-post-ledger-operator-release-attestation:${row.latestEvalMergeQueueFinalBlockerLedgerReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueueFinalBlockerLedgerReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueuePostLedgerOperatorReleaseAttestation(row.latestEvalMergeQueueFinalBlockerLedgerReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        operatorId: 'portfolio_operator_queue',
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        attestationReasons: ['final_blocker_ledger_sealed', 'runtime_token_release_denied', 'fake_live_read_replay_quarantined', 'live_http_receipt_missing'],
        summary: 'Portfolio UI recorded merge queue post-ledger operator release attestation while final blockers remain sealed.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueueFinalBlockerLedgerReceiptId: row.latestEvalMergeQueueFinalBlockerLedgerReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          operatorReleaseRequested: true,
          operatorReleaseAttested: true,
          operatorReleaseBlocked: true,
          operatorOverrideAllowed: false,
          releaseApproved: false,
          liveHttpReleaseAllowed: false,
          tokenReleaseApproved: false,
          tokenReleased: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          mergeAllowed: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueueFinalBlockerLedgerReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_post_ledger_operator_release_attestation'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueuePostAttestationReleaseEscrow = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt) return;
    setFixingId(`eval-merge-queue-post-attestation-release-escrow:${row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const response = row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt.response || {};
      const result = await api.recordPortfolioEvalMergeQueuePostAttestationReleaseEscrow(row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        operatorId: 'portfolio_operator_queue',
        runtimeSecretRef: response.runtimeSecretRef || 'github_merge_queue_read_token',
        requestMethod: response.requestMethod || 'GET',
        releaseScope: response.releaseScope || 'single_github_ruleset_get',
        escrowReasons: ['post_ledger_operator_release_attestation_observed', 'operator_release_blocked', 'final_blocker_ledger_sealed', 'live_http_release_missing'],
        summary: 'Portfolio UI recorded merge queue post-attestation release escrow while operator release remains blocked.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueuePostLedgerOperatorReleaseAttestationReceiptId: row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          postLedgerOperatorReleaseAttestationObserved: true,
          operatorReleaseBlocked: true,
          releaseEscrowRequested: true,
          releaseEscrowHeld: true,
          escrowReleased: false,
          releaseApproved: false,
          liveHttpReleaseAllowed: false,
          tokenReleaseApproved: false,
          tokenReleased: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          mergeAllowed: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_post_attestation_release_escrow'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const recordEvalMergeQueueReleaseDenialCloseout = useCallback(async (row) => {
    const workspaceId = snapshot?.workspace?.id || DEFAULT_WORKSPACE_ID;
    if (!row?.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt) return;
    setFixingId(`eval-merge-queue-release-denial-closeout:${row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt.id}`);
    setError('');
    setFixResult(null);
    try {
      const result = await api.recordPortfolioEvalMergeQueueReleaseDenialCloseout(row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt.id, {
        liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
        operatorId: 'portfolio_operator_queue',
        closeoutKind: 'merge_queue_release_denial_closeout',
        decision: 'merge_queue_release_denied_after_post_attestation_escrow',
        status: 'merge_queue_release_denied_after_post_attestation_escrow',
        denialReasons: ['post_attestation_release_escrow_held', 'final_blocker_ledger_sealed', 'runtime_token_release_denied', 'live_http_release_missing'],
        remediationActions: ['restore_parent_receipt_chain', 'record_real_runtime_secret_provider_smoke', 'rerun_live_merge_authorization_preflight'],
        summary: 'Portfolio UI sealed merge queue release denial closeout after post-attestation release escrow stayed held.',
        evidence: [{
          source: 'portfolio_operator_queue_panel',
          queueId: row.queue.id,
          roleKey: row.queue.role_key,
          mergeQueuePostAttestationReleaseEscrowReceiptId: row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt.id,
          liveMergeAuthorizationReceiptId: row.latestEvalLiveMergeAuthorizationReceipt?.id || null,
          requestedFromPortfolioOperatorQueue: true,
          postAttestationReleaseEscrowObserved: true,
          releaseEscrowHeld: true,
          escrowReleased: false,
          releaseApproved: false,
          releaseDenied: true,
          releaseDenialSealed: true,
          tokenReleaseApproved: false,
          tokenReleased: false,
          authorizationHeaderMaterialized: false,
          httpRequestSent: false,
          liveGithubApiCalled: false,
          mergeAllowed: false,
          mergeExecuted: false,
          liveSideEffects: false
        }]
      });
      setFixResult({
        label: result?.receipt?.eval_key || row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt.eval_key || row.queue.role_key,
        type: 'eval_merge_queue_release_denial_closeout'
      });
      const next = await api.portfolioOperatingModel({ workspaceId, limit: 50 });
      setSnapshot(next);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setFixingId('');
      setLoading(false);
    }
  }, [snapshot?.workspace?.id]);

  const counts = snapshot?.counts || {};
  const coverage = snapshot?.coverage || {};
  const opportunities = useMemo(() => (snapshot?.marketOpportunities || []).slice(0, 8), [snapshot?.marketOpportunities]);
  const serviceBusinesses = useMemo(() => (snapshot?.serviceBusinesses || []).slice(0, 6), [snapshot?.serviceBusinesses]);
  const gateEvaluations = useMemo(() => (snapshot?.gateEvaluations || []).slice(0, 6), [snapshot?.gateEvaluations]);
  const launchSurfaces = useMemo(() => (snapshot?.launchSurfaces || []).slice(0, 6), [snapshot?.launchSurfaces]);
  const monitoringChecks = useMemo(() => (snapshot?.monitoringChecks || []).slice(0, 6), [snapshot?.monitoringChecks]);
  const acquisitionAttempts = useMemo(() => (snapshot?.acquisitionAttempts || []).slice(0, 6), [snapshot?.acquisitionAttempts]);
  const acquisitionRollups = useMemo(() => (snapshot?.acquisitionRollups || []).slice(0, 6), [snapshot?.acquisitionRollups]);
  const acquisitionConversions = useMemo(
    () => (snapshot?.acquisitionRollups || []).reduce((sum, item) => sum + (Number(item.conversions) || 0), 0),
    [snapshot?.acquisitionRollups]
  );
  const strategyRecommendations = useMemo(() => (snapshot?.strategyRecommendations || []).slice(0, 6), [snapshot?.strategyRecommendations]);
  const acquisitionActions = useMemo(() => (snapshot?.acquisitionActions || []).slice(0, 8), [snapshot?.acquisitionActions]);
  const acquisitionActionReceipts = useMemo(() => (snapshot?.acquisitionActionReceipts || []).slice(0, 8), [snapshot?.acquisitionActionReceipts]);
  const blockerActions = useMemo(() => buildBlockerActions(snapshot).slice(0, 8), [snapshot]);
  const operatorQueueRows = useMemo(() => buildOperatorQueueRows(snapshot).slice(0, 8), [snapshot]);
  const workflowReplayRows = useMemo(() => (snapshot?.workflowReplayReceipts || []).slice(0, 4), [snapshot?.workflowReplayReceipts]);
  const evalPublicationRows = useMemo(() => (snapshot?.evalPublicationReceipts || []).slice(0, 4), [snapshot?.evalPublicationReceipts]);
  const evalFixtureWorkRows = useMemo(() => (snapshot?.evalFixtureWorkItems || []).slice(0, 6), [snapshot?.evalFixtureWorkItems]);
  const evalFixtureRunnerRows = useMemo(() => (snapshot?.evalFixtureRunnerReceipts || []).slice(0, 4), [snapshot?.evalFixtureRunnerReceipts]);
  const evalFixtureApprovalRows = useMemo(() => (snapshot?.evalFixtureApprovalReceipts || []).slice(0, 4), [snapshot?.evalFixtureApprovalReceipts]);
  const evalGoldenFixtureReviewRows = useMemo(() => (snapshot?.evalGoldenFixtureReviewReceipts || []).slice(0, 4), [snapshot?.evalGoldenFixtureReviewReceipts]);
  const evalNonLiveRunnerBindingRows = useMemo(() => (snapshot?.evalNonLiveRunnerBindingReceipts || []).slice(0, 4), [snapshot?.evalNonLiveRunnerBindingReceipts]);
  const evalFileDryRunManifestRows = useMemo(() => (snapshot?.evalFileDryRunManifests || []).slice(0, 4), [snapshot?.evalFileDryRunManifests]);
  const evalCiWriteAccessRows = useMemo(() => (snapshot?.evalCiWriteAccessReceipts || []).slice(0, 4), [snapshot?.evalCiWriteAccessReceipts]);
  const evalLiveAdapterReadinessRows = useMemo(() => (snapshot?.evalLiveAdapterReadinessReceipts || []).slice(0, 4), [snapshot?.evalLiveAdapterReadinessReceipts]);
  const evalLiveAdapterContractTestRows = useMemo(() => (snapshot?.evalLiveAdapterContractTestReceipts || []).slice(0, 4), [snapshot?.evalLiveAdapterContractTestReceipts]);
  const evalCiWorkflowPublicationRows = useMemo(() => (snapshot?.evalCiWorkflowPublicationReceipts || []).slice(0, 4), [snapshot?.evalCiWorkflowPublicationReceipts]);
  const evalGeneratedArtifactPromotionRows = useMemo(() => (snapshot?.evalGeneratedArtifactPromotionReceipts || []).slice(0, 4), [snapshot?.evalGeneratedArtifactPromotionReceipts]);
  const evalPrMergeProposalRows = useMemo(() => (snapshot?.evalPrMergeProposalReceipts || []).slice(0, 4), [snapshot?.evalPrMergeProposalReceipts]);
  const evalPrOpenSimulationRows = useMemo(() => (snapshot?.evalPrOpenSimulationReceipts || []).slice(0, 4), [snapshot?.evalPrOpenSimulationReceipts]);
  const evalOperatorMergeApprovalRows = useMemo(() => (snapshot?.evalOperatorMergeApprovalReceipts || []).slice(0, 4), [snapshot?.evalOperatorMergeApprovalReceipts]);
  const evalSubmittedPrEvidenceRows = useMemo(() => (snapshot?.evalSubmittedPrEvidenceReceipts || []).slice(0, 4), [snapshot?.evalSubmittedPrEvidenceReceipts]);
  const evalPrExternalVerificationRows = useMemo(() => (snapshot?.evalPrExternalVerificationReceipts || []).slice(0, 4), [snapshot?.evalPrExternalVerificationReceipts]);
  const evalExternalCiResultRows = useMemo(() => (snapshot?.evalExternalCiResultReceipts || []).slice(0, 4), [snapshot?.evalExternalCiResultReceipts]);
  const evalGithubPrVerificationRows = useMemo(() => (snapshot?.evalGithubPrVerificationReceipts || []).slice(0, 4), [snapshot?.evalGithubPrVerificationReceipts]);
  const evalGithubPrObservationRows = useMemo(() => (snapshot?.evalGithubPrObservationReceipts || []).slice(0, 4), [snapshot?.evalGithubPrObservationReceipts]);
  const evalGithubCheckRunObservationRows = useMemo(() => (snapshot?.evalGithubCheckRunObservationReceipts || []).slice(0, 4), [snapshot?.evalGithubCheckRunObservationReceipts]);
  const evalMergeExecutionAdapterContractRows = useMemo(() => (snapshot?.evalMergeExecutionAdapterContractReceipts || []).slice(0, 4), [snapshot?.evalMergeExecutionAdapterContractReceipts]);
  const evalOperatorMergeCompletionGateRows = useMemo(() => (snapshot?.evalOperatorMergeCompletionGateReceipts || []).slice(0, 4), [snapshot?.evalOperatorMergeCompletionGateReceipts]);
  const evalLiveMergeAuthorizationRows = useMemo(() => (snapshot?.evalLiveMergeAuthorizationReceipts || []).slice(0, 4), [snapshot?.evalLiveMergeAuthorizationReceipts]);
  const evalBranchProtectionReadbackAdapterContractRows = useMemo(() => (snapshot?.evalBranchProtectionReadbackAdapterContractReceipts || []).slice(0, 4), [snapshot?.evalBranchProtectionReadbackAdapterContractReceipts]);
  const evalTokenScopeObservationAdapterContractRows = useMemo(() => (snapshot?.evalTokenScopeObservationAdapterContractReceipts || []).slice(0, 4), [snapshot?.evalTokenScopeObservationAdapterContractReceipts]);
  const evalSecretRedactionProofRows = useMemo(() => (snapshot?.evalSecretRedactionProofReceipts || []).slice(0, 4), [snapshot?.evalSecretRedactionProofReceipts]);
  const evalMergeQueueReadbackAdapterContractRows = useMemo(() => (snapshot?.evalMergeQueueReadbackAdapterContractReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueReadbackAdapterContractReceipts]);
  const evalMergeQueueLiveReadReconciliationRows = useMemo(() => (snapshot?.evalMergeQueueLiveReadReconciliationReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueLiveReadReconciliationReceipts]);
  const evalMergeQueueLiveReadAdapterContractRows = useMemo(() => (snapshot?.evalMergeQueueLiveReadAdapterContractReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueLiveReadAdapterContractReceipts]);
  const evalMergeQueueLiveReadReadinessRows = useMemo(() => (snapshot?.evalMergeQueueLiveReadReadinessReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueLiveReadReadinessReceipts]);
  const evalMergeQueueCredentialHandoffRows = useMemo(() => (snapshot?.evalMergeQueueCredentialHandoffReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueCredentialHandoffReceipts]);
  const evalMergeQueueLiveReadPreflightRows = useMemo(() => (snapshot?.evalMergeQueueLiveReadPreflightReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueLiveReadPreflightReceipts]);
  const evalMergeQueueTokenQuarantineRows = useMemo(() => (snapshot?.evalMergeQueueTokenQuarantineReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueTokenQuarantineReceipts]);
  const evalMergeQueueLiveReadResponseIngestionRows = useMemo(() => (snapshot?.evalMergeQueueLiveReadResponseIngestionReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueLiveReadResponseIngestionReceipts]);
  const evalMergeQueueRuntimeTokenReleaseGateRows = useMemo(() => (snapshot?.evalMergeQueueRuntimeTokenReleaseGateReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueRuntimeTokenReleaseGateReceipts]);
  const evalMergeQueueLiveReadVerificationPromotionRows = useMemo(() => (snapshot?.evalMergeQueueLiveReadVerificationPromotionReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueLiveReadVerificationPromotionReceipts]);
  const evalMergeQueueLiveHttpExecutionPreflightHandoffRows = useMemo(() => (snapshot?.evalMergeQueueLiveHttpExecutionPreflightHandoffReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueLiveHttpExecutionPreflightHandoffReceipts]);
  const evalMergeQueueLiveHttpOperatorReleaseAckRows = useMemo(() => (snapshot?.evalMergeQueueLiveHttpOperatorReleaseAckReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueLiveHttpOperatorReleaseAckReceipts]);
  const evalMergeQueueRuntimeSecretProviderSmokeReadinessRows = useMemo(() => (snapshot?.evalMergeQueueRuntimeSecretProviderSmokeReadinessReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueRuntimeSecretProviderSmokeReadinessReceipts]);
  const evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows = useMemo(() => (snapshot?.evalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipts]);
  const evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows = useMemo(() => (snapshot?.evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipts]);
  const evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows = useMemo(() => (snapshot?.evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipts]);
  const evalMergeQueueSuccessfulSmokeEvidenceIngestionRows = useMemo(() => (snapshot?.evalMergeQueueSuccessfulSmokeEvidenceIngestionReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueSuccessfulSmokeEvidenceIngestionReceipts]);
  const evalMergeQueueRuntimeTokenReleaseDenialRows = useMemo(() => (snapshot?.evalMergeQueueRuntimeTokenReleaseDenialReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueRuntimeTokenReleaseDenialReceipts]);
  const evalMergeQueueFakeLiveReadReplayQuarantineRows = useMemo(() => (snapshot?.evalMergeQueueFakeLiveReadReplayQuarantineReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueFakeLiveReadReplayQuarantineReceipts]);
  const evalMergeQueueFinalBlockerLedgerRows = useMemo(() => (snapshot?.evalMergeQueueFinalBlockerLedgerReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueFinalBlockerLedgerReceipts]);
  const evalMergeQueuePostLedgerOperatorReleaseAttestationRows = useMemo(() => (snapshot?.evalMergeQueuePostLedgerOperatorReleaseAttestationReceipts || []).slice(0, 4), [snapshot?.evalMergeQueuePostLedgerOperatorReleaseAttestationReceipts]);
  const evalMergeQueuePostAttestationReleaseEscrowRows = useMemo(() => (snapshot?.evalMergeQueuePostAttestationReleaseEscrowReceipts || []).slice(0, 4), [snapshot?.evalMergeQueuePostAttestationReleaseEscrowReceipts]);
  const evalMergeQueueReleaseDenialCloseoutRows = useMemo(() => (snapshot?.evalMergeQueueReleaseDenialCloseoutReceipts || []).slice(0, 4), [snapshot?.evalMergeQueueReleaseDenialCloseoutReceipts]);
  const evalMergeQueueConsolidatedBlockerAuditRows = useMemo(() => (snapshot?.evalMergeQueueConsolidatedBlockerAudits || []).slice(0, 4), [snapshot?.evalMergeQueueConsolidatedBlockerAudits]);
  const evalMergeQueueConsolidatedBlockerRemediationActions = useMemo(() => (
    evalMergeQueueConsolidatedBlockerAuditRows
      .flatMap((audit) => audit.remediationActions || [])
      .slice(0, 6)
  ), [evalMergeQueueConsolidatedBlockerAuditRows]);
  const evalMergeQueueConsolidatedBlockerRemediationCount = useMemo(() => (
    evalMergeQueueConsolidatedBlockerAuditRows.reduce((sum, audit) => sum + (Number(audit.remediationActionCount) || (audit.remediationActions || []).length || 0), 0)
  ), [evalMergeQueueConsolidatedBlockerAuditRows]);
  const incidents = useMemo(() => (snapshot?.incidents || []).slice(0, 5), [snapshot?.incidents]);
  const learningRecords = useMemo(() => (snapshot?.learningRecords || []).slice(0, 5), [snapshot?.learningRecords]);
  const recentEvents = useMemo(() => (snapshot?.recentEvents || []).slice(0, 8), [snapshot?.recentEvents]);
  const readinessCommands = useMemo(() => (snapshot?.readinessCommandCenter || []).slice(0, 4), [snapshot?.readinessCommandCenter]);
  const retentionCohortCommands = useMemo(() => (snapshot?.retentionCohortCommandCenter || []).slice(0, 4), [snapshot?.retentionCohortCommandCenter]);
  const capabilityKinds = coverage.capabilityKinds || [];
  const workflowKeys = coverage.workflowKeys || [];

  return (
    <div className="portfolio-view">
      <header className="portfolio-hero">
        <div>
          <div className="portfolio-kicker">holding company</div>
          <h1>{snapshot?.organization?.name || 'Callan Portfolio'}</h1>
          <p>{snapshot?.workspace?.name || 'Portfolio operating model'}</p>
        </div>
        <div className="portfolio-hero-actions">
          <StatusPill tone={coverage.ok ? 'good' : 'warm'}>{coverage.status || (loading ? 'syncing' : 'foundation')}</StatusPill>
          <button className="portfolio-action" type="button" onClick={aggregateLeads} disabled={action === 'aggregate'}>
            {action === 'aggregate' ? 'Aggregating' : 'Aggregate leads'}
          </button>
        </div>
      </header>

      {error ? <div className="portfolio-alert">{error}</div> : null}
      {actionResult ? (
        <div className="portfolio-action-result">
          <span>{actionResult.createdOrUpdated} opportunities</span>
          <span>{actionResult.consideredLeads} leads</span>
          <span>{actionResult.groups} groups</span>
        </div>
      ) : null}
      {planResult ? (
        <div className="portfolio-action-result">
          <span>{planResult.created ? 'created' : 'existing'}</span>
          <span>{planResult.name}</span>
        </div>
      ) : null}
      {gateResult ? (
        <div className="portfolio-action-result">
          <span>{gateResult.allowed} allowed</span>
          <span>{gateResult.blocked} blocked</span>
          <span>{gateResult.name}</span>
        </div>
      ) : null}
      {fixResult ? (
        <div className="portfolio-action-result">
          <span>{formatLabel(fixResult.type)}</span>
          <span>{fixResult.label}</span>
          {fixResult.operatorStatus ? <span>{formatLabel(fixResult.operatorStatus)}</span> : null}
          {fixResult.requiredLiveEvidenceKey ? <span>{formatLabel(fixResult.requiredLiveEvidenceKey)}</span> : null}
          {fixResult.liveGateClearedByThisSubmission === true ? <span>live gate cleared</span> : null}
          {fixResult.liveGateClearedByThisSubmission === false ? <span>live gate not cleared</span> : null}
          {fixResult.localReviewCanClearLiveGate === false ? <span>local review cannot clear live gate</span> : null}
        </div>
      ) : null}

      <section className="portfolio-metrics" aria-label="portfolio metrics">
        <Metric label="markets" value={counts.marketOpportunities || 0} />
        <Metric label="businesses" value={counts.serviceBusinesses || 0} />
        <Metric label="customers" value={counts.customers || 0} />
        <Metric label="jobs" value={counts.portfolioJobs || 0} />
        <Metric label="payments" value={counts.portfolioPayments || 0} />
        <Metric label="vendors" value={counts.vendorPartners || 0} />
        <Metric label="providers" value={counts.providerLinks || 0} />
        <Metric label="approvals" value={counts.approvals || 0} />
        <Metric label="incidents" value={counts.incidents || 0} />
        <Metric label="learning" value={counts.learningRecords || 0} />
        <Metric label="gates" value={counts.gateEvaluations || 0} />
        <Metric label="surfaces" value={counts.launchSurfaces || 0} />
        <Metric label="monitors" value={counts.monitoringChecks || 0} />
        <Metric label="attempts" value={counts.acquisitionAttempts || 0} />
        <Metric label="wins" value={acquisitionConversions} />
        <Metric label="strategy" value={counts.strategyRecommendations || 0} />
        <Metric label="actions" value={counts.acquisitionActions || 0} />
        <Metric label="receipts" value={counts.acquisitionActionReceipts || 0} />
        <Metric label="board cmd" value={counts.serviceDecisionReadinessReconciliations || 0} />
        <Metric label="capabilities" value={counts.serviceCapabilities || 0} />
        <Metric label="workflows" value={counts.workflowDefinitions || 0} />
      </section>

      <div className="portfolio-grid">
        <section className="portfolio-panel portfolio-panel-wide" aria-label="market opportunities">
          <PanelHeader
            eyebrow="market map"
            title="Opportunities"
            detail={opportunities.length ? `${opportunities.length} visible` : loading ? 'loading' : 'empty'}
          />
          <div className="portfolio-opportunity-list">
            {opportunities.length ? opportunities.map((item) => (
              <article className="portfolio-opportunity" key={item.id}>
                <div className="portfolio-opportunity-main">
                  <div>
                    <h2>{item.city}{item.neighborhood ? ` / ${item.neighborhood}` : ''}</h2>
                    <p>{item.vertical_key}</p>
                  </div>
                  <StatusPill tone={decisionTone(item.decision)}>{formatLabel(item.decision)}</StatusPill>
                </div>
                <div className="portfolio-score-row">
                  <Score label="score" value={item.score} />
                  <Score label="confidence" value={item.confidence} />
                  <Score label="evidence" value={item.source_evidence?.length || 0} integer />
                  <Score label="ticket" value={item.unit_economics?.representativePriceCents} money />
                </div>
                <div className="portfolio-evidence-line">
                  {item.source_evidence?.[0]?.summary || 'No evidence summary captured.'}
                </div>
                {item.signals?.cityDemandMap ? (
                  <div className="portfolio-tag-stack" aria-label="city demand map">
                    <span title={(item.signals.cityDemandMap.assumptions || []).join(' · ')}>
                      map · {item.signals.cityDemandMap.neighborhoodCount || 0} areas
                    </span>
                    {item.signals.cityDemandMap.topNeighborhoodLabel ? (
                      <span title="top local demand hotspot from stored lead evidence">
                        top · {item.signals.cityDemandMap.topNeighborhoodLabel}
                      </span>
                    ) : null}
                    {Number.isFinite(item.signals.cityDemandMap.mappedLeadRatio) ? (
                      <span>mapped · {(item.signals.cityDemandMap.mappedLeadRatio * 100).toFixed(0)}%</span>
                    ) : null}
                    {(item.signals.cityDemandMap.hotspots || []).slice(0, 3).map((hotspot) => (
                      <span key={`demand-map:${hotspot.key}`} title={`${hotspot.leadCount}/${item.signals.cityDemandMap.totalLeads || 0} leads`}>
                        {hotspot.label} · {formatLabel(hotspot.demandClass)}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.signals?.neighborhoodLaunchPlan ? (
                  <div className="portfolio-tag-stack" aria-label="neighborhood launch plan">
                    <span title={(item.signals.neighborhoodLaunchPlan.assumptions || []).join(' · ')}>
                      start · {item.signals.neighborhoodLaunchPlan.selectedNeighborhoodLabel || 'citywide'}
                    </span>
                    <span title={item.signals.neighborhoodLaunchPlan.launchRationale || ''}>
                      motion · {formatLabel(item.signals.neighborhoodLaunchPlan.recommendedMotion)}
                    </span>
                    {Number.isFinite(item.signals.neighborhoodLaunchPlan.priorityScore) ? (
                      <span>
                        priority · {(item.signals.neighborhoodLaunchPlan.priorityScore * 100).toFixed(0)}%
                      </span>
                    ) : null}
                    {Number.isFinite(item.signals.neighborhoodLaunchPlan.estimatedFirstWaveRevenueCents) ? (
                      <span>
                        first wave · {formatMoney(item.signals.neighborhoodLaunchPlan.estimatedFirstWaveRevenueCents)}
                      </span>
                    ) : null}
                    {(item.signals.neighborhoodLaunchPlan.proofRequirements || []).slice(0, 2).map((requirement) => (
                      <span key={`launch-proof:${requirement}`}>needs · {formatLabel(requirement)}</span>
                    ))}
                  </div>
                ) : null}
                {item.signals?.marketRecommendationProvenance ? (
                  <div className="portfolio-tag-stack" aria-label="market recommendation provenance">
                    <span title={item.signals.marketRecommendationProvenance.recommendationSummary || ''}>
                      why · {formatLabel(item.signals.marketRecommendationProvenance.decision)}
                    </span>
                    {Number.isFinite(item.signals.marketRecommendationProvenance.explainabilityScore) ? (
                      <span title={(item.signals.marketRecommendationProvenance.assumptions || []).join(' · ')}>
                        explained · {formatRatio(item.signals.marketRecommendationProvenance.explainabilityScore)}
                      </span>
                    ) : null}
                    <span>
                      proof · {item.signals.marketRecommendationProvenance.evidenceSummary?.distinctEvidenceLeadCount || 0} leads
                    </span>
                    {(item.signals.marketRecommendationProvenance.topReasons || []).slice(0, 3).map((reason, index) => {
                      const reasonKey = typeof reason === 'string' ? reason : reason?.key;
                      const reasonSource = typeof reason === 'string' ? '' : reason?.source || '';
                      return (
                        <span key={`market-provenance:${reasonKey || index}`} title={reasonSource}>
                          reason · {formatLabel(reasonKey)}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                {item.signals?.confidenceIntervals ? (
                  <div className="portfolio-tag-stack" aria-label="confidence intervals">
                    <span title={(item.signals.confidenceIntervals.assumptions || []).join(' · ')}>
                      uncertainty · {formatLabel(item.signals.confidenceIntervals.summary?.widthClass)}
                    </span>
                    {item.signals.confidenceIntervals.score ? (
                      <span title="score evidence band">
                        score CI · {formatPercentInterval(item.signals.confidenceIntervals.score)}
                      </span>
                    ) : null}
                    {item.signals.confidenceIntervals.marketSizing?.serviceableAvailableMarketCents ? (
                      <span title="SAM evidence band">
                        SAM CI · {formatMoneyInterval(item.signals.confidenceIntervals.marketSizing.serviceableAvailableMarketCents)}
                      </span>
                    ) : null}
                    {item.signals.confidenceIntervals.summary?.speculative ? (
                      <span title="claim is based on a thin local evidence sample">speculative</span>
                    ) : null}
                  </div>
                ) : null}
                {item.signals?.searchIntentCapture ? (
                  <div className="portfolio-tag-stack" aria-label="search intent capture">
                    <span title={(item.signals.searchIntentCapture.assumptions || []).join(' · ')}>
                      intent · {formatLabel(item.signals.searchIntentCapture.intentClass)}
                    </span>
                    <span title={`recommended capture surface = ${item.signals.searchIntentCapture.recommendedCaptureSurface}`}>
                      surface · {formatLabel(item.signals.searchIntentCapture.recommendedCaptureSurface)}
                    </span>
                    {Number.isFinite(item.signals.searchIntentCapture.capturedIntentScore) ? (
                      <span>fit · {(item.signals.searchIntentCapture.capturedIntentScore * 100).toFixed(0)}%</span>
                    ) : null}
                    {(item.signals.searchIntentCapture.matchedIntentKeys || []).slice(0, 2).map((key) => (
                      <span key={`intent:${key}`}>{formatLabel(key)}</span>
                    ))}
                  </div>
                ) : null}
                {Array.isArray(item.signals?.reviewComplaintClusters) && item.signals.reviewComplaintClusters.length ? (
                  <div className="portfolio-tag-stack" aria-label="review complaint clusters">
                    <span title={(item.signals.reviewComplaintSummary?.assumptions || []).join(' · ')}>
                      complaints · {item.signals.reviewComplaintSummary?.totalClusters || item.signals.reviewComplaintClusters.length}
                    </span>
                    {item.signals.reviewComplaintClusters.slice(0, 4).map((cluster) => (
                      <span key={`complaint:${cluster.key}`} title={cluster.acquisitionAngle || ''}>
                        {formatLabel(cluster.key)} · {cluster.leadCount}/{cluster.totalLeads} · {cluster.severity}
                      </span>
                    ))}
                  </div>
                ) : null}
                {Array.isArray(item.signals?.formationPermitSignals) && item.signals.formationPermitSignals.length ? (
                  <div className="portfolio-tag-stack" aria-label="formation and permit signals">
                    <span title={(item.signals.formationPermitSummary?.assumptions || []).join(' · ')}>
                      formation · {item.signals.formationPermitSummary?.totalSignals || item.signals.formationPermitSignals.length}
                    </span>
                    {Number.isFinite(item.signals.formationPermitSummary?.regulatoryRiskScore) ? (
                      <span title="internal regulatory evidence risk, not a public claim">
                        permit risk · {(item.signals.formationPermitSummary.regulatoryRiskScore * 100).toFixed(0)}%
                      </span>
                    ) : null}
                    {item.signals.formationPermitSignals.slice(0, 4).map((signal) => (
                      <span key={`formation:${signal.key}`} title={signal.action || ''}>
                        {formatLabel(signal.key)} · {signal.leadCount}/{signal.totalLeads} · {signal.severity}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.signals?.localSeasonality ? (
                  <div className="portfolio-tag-stack" aria-label="local seasonality">
                    <span title={(item.signals.localSeasonality.assumptions || []).join(' · ')}>
                      season · {formatLabel(item.signals.localSeasonality.seasonalityClass)}
                    </span>
                    <span title={item.signals.localSeasonality.recommendedCampaign || ''}>
                      window · {formatLabel(item.signals.localSeasonality.seasonalWindowKey)}
                    </span>
                    {Number.isFinite(item.signals.localSeasonality.demandMultiplier) ? (
                      <span title="internal prioritization multiplier from calendar and stored evidence">
                        lift · {Math.round(Math.max(0, item.signals.localSeasonality.demandMultiplier - 1) * 100)}%
                      </span>
                    ) : null}
                    {(item.signals.localSeasonality.matchedTerms || []).slice(0, 3).map((term) => (
                      <span key={`season:${term}`}>{formatLabel(term)}</span>
                    ))}
                  </div>
                ) : null}
                {item.signals?.adSaturationOfferFatigue ? (
                  <div className="portfolio-tag-stack" aria-label="ad saturation and offer fatigue">
                    <span title={(item.signals.adSaturationOfferFatigue.assumptions || []).join(' · ')}>
                      ads · {formatLabel(item.signals.adSaturationOfferFatigue.saturationLevel)}
                    </span>
                    <span title={item.signals.adSaturationOfferFatigue.channelGuidance || ''}>
                      fatigue · {formatLabel(item.signals.adSaturationOfferFatigue.fatigueLevel)}
                    </span>
                    {Number.isFinite(item.signals.adSaturationOfferFatigue.compositeScore) ? (
                      <span title="internal channel/offer pressure score from stored evidence">
                        pressure · {(item.signals.adSaturationOfferFatigue.compositeScore * 100).toFixed(0)}%
                      </span>
                    ) : null}
                    {item.signals.adSaturationOfferFatigue.recommendedPositioning ? (
                      <span>{formatLabel(item.signals.adSaturationOfferFatigue.recommendedPositioning)}</span>
                    ) : null}
                    {(item.signals.adSaturationOfferFatigue.signalKeys || []).slice(0, 3).map((key) => (
                      <span key={`ad-fatigue:${key}`}>{formatLabel(key)}</span>
                    ))}
                  </div>
                ) : null}
                {item.signals?.marketOutcomeLearning ? (
                  <div className="portfolio-tag-stack" aria-label="market outcome learning">
                    <span title={(item.signals.marketOutcomeLearning.assumptions || []).join(' · ')}>
                      learned · {formatLabel(item.signals.marketOutcomeLearning.state)}
                    </span>
                    {Number.isFinite(item.signals.marketOutcomeLearning.scorePenalty) ? (
                      <span title="score penalty applied to repeat aggregation for this city/vertical">
                        penalty · {(item.signals.marketOutcomeLearning.scorePenalty * 100).toFixed(0)}%
                      </span>
                    ) : null}
                    {item.signals.marketOutcomeLearning.recommendedDecision ? (
                      <span>next · {formatLabel(item.signals.marketOutcomeLearning.recommendedDecision)}</span>
                    ) : null}
                    {(item.signals.marketOutcomeLearning.reasonKeys || []).slice(0, 3).map((key) => (
                      <span key={`market-outcome:${key}`}>{formatLabel(key)}</span>
                    ))}
                  </div>
                ) : null}
                {Array.isArray(item.signals?.competitorWeaknesses) && item.signals.competitorWeaknesses.length ? (
                  <div className="portfolio-tag-stack" aria-label="competitor weaknesses">
                    {item.signals.competitorWeaknesses.slice(0, 5).map((weakness) => (
                      <span key={weakness.key} title={weakness.exploit || ''}>
                        {formatLabel(weakness.key)} · {weakness.count}/{weakness.total} · {weakness.severity}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.signals?.marketSizing ? (
                  <div className="portfolio-tag-stack" aria-label="market sizing estimate">
                    <span title={(item.signals.marketSizing.assumptions || []).join(' · ')}>
                      callable · {item.signals.marketSizing.immediatelyCallableLeads || 0}/{item.signals.marketSizing.totalObservedLeads || 0}
                    </span>
                    <span title="weak-presence callable leads × representative ticket">
                      weak · {item.signals.marketSizing.weakPresenceCallableLeads || 0}
                    </span>
                    {Number.isFinite(item.signals.marketSizing.serviceableAvailableMarketCents) ? (
                      <span title="SAM proxy = immediately callable leads × representative ticket">
                        SAM · {formatMoney(item.signals.marketSizing.serviceableAvailableMarketCents)}
                      </span>
                    ) : null}
                    {Number.isFinite(item.signals.marketSizing.obtainableFirstWaveCents) ? (
                      <span title={`SOM proxy = ${item.signals.marketSizing.obtainableFirstWaveLeads} obtainable first-wave leads × ticket (conversion ${(item.signals.marketSizing.firstWaveConversionRate * 100).toFixed(0)}%)`}>
                        SOM · {formatMoney(item.signals.marketSizing.obtainableFirstWaveCents)}
                      </span>
                    ) : null}
                    {Number.isFinite(item.signals.marketSizing.confidence) ? (
                      <span>est confidence · {(item.signals.marketSizing.confidence * 100).toFixed(0)}%</span>
                    ) : null}
                  </div>
                ) : null}
                {item.signals?.pricingMarginInference ? (
                  <div className="portfolio-tag-stack" aria-label="pricing and margin inference">
                    <span title={(item.signals.pricingMarginInference.assumptions || []).join(' · ')}>
                      price · {formatMoney(item.signals.pricingMarginInference.representativePriceCents)}
                    </span>
                    {Number.isFinite(item.signals.pricingMarginInference.estimatedGrossMarginPct) ? (
                      <span>
                        margin · {(item.signals.pricingMarginInference.estimatedGrossMarginPct * 100).toFixed(0)}%
                      </span>
                    ) : null}
                    <span>evidence · {item.signals.pricingMarginInference.evidencePriceCount || 0}</span>
                    {Number.isFinite(item.signals.pricingMarginInference.confidence) ? (
                      <span>pricing confidence · {(item.signals.pricingMarginInference.confidence * 100).toFixed(0)}%</span>
                    ) : null}
                    {(item.signals.pricingMarginInference.observedDiagnosticFeeCents || []).slice(0, 2).map((cents) => (
                      <span key={`diagnostic:${cents}`}>diagnostic · {formatMoney(cents)}</span>
                    ))}
                  </div>
                ) : null}
                {item.signals?.ownerResponsiveness ? (
                  <div className="portfolio-tag-stack" aria-label="owner responsiveness prediction">
                    <span title={item.signals.ownerResponsiveness.exploit || ''}>
                      owners · {formatLabel(item.signals.ownerResponsiveness.responsivenessClass)}
                    </span>
                    <span title={`recommended acquisition motion = ${item.signals.ownerResponsiveness.recommendedAcquisitionMotion}`}>
                      motion · {formatLabel(item.signals.ownerResponsiveness.recommendedAcquisitionMotion)}
                    </span>
                    {Number.isFinite(item.signals.ownerResponsiveness.responseFrictionScore) ? (
                      <span title="0 = fully responsive, 1 = high friction">
                        friction · {(item.signals.ownerResponsiveness.responseFrictionScore * 100).toFixed(0)}%
                      </span>
                    ) : null}
                    {Number.isFinite(item.signals.ownerResponsiveness.callableCoverageRatio) ? (
                      <span title="leads with risk_status callable/qualified ÷ total">
                        callable · {(item.signals.ownerResponsiveness.callableCoverageRatio * 100).toFixed(0)}%
                      </span>
                    ) : null}
                    {(item.signals.ownerResponsiveness.blockers || []).slice(0, 2).map((blocker) => (
                      <span key={`responsiveness-blocker:${blocker}`} title="evidence required before scaling motion">
                        needs · {formatLabel(blocker)}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.signals?.serviceUrgency || item.signals?.demandPressure ? (
                  <div className="portfolio-tag-stack" aria-label="demand pressure and service urgency">
                    {item.signals?.serviceUrgency ? (
                      <span title={item.signals.serviceUrgency.exploit || ''}>
                        urgency · {formatLabel(item.signals.serviceUrgency.urgencyClass)}
                        {Number.isFinite(item.signals.serviceUrgency.responseExpectationMinutes)
                          ? ` · ≤${item.signals.serviceUrgency.responseExpectationMinutes}m`
                          : ''}
                      </span>
                    ) : null}
                    {item.signals?.demandPressure ? (
                      <span title={item.signals.demandPressure.exploitationStrategy || ''}>
                        pressure · {formatLabel(item.signals.demandPressure.pressureLevel)}
                        {Number.isFinite(item.signals.demandPressure.pressureScore)
                          ? ` · ${(item.signals.demandPressure.pressureScore * 100).toFixed(0)}%`
                          : ''}
                      </span>
                    ) : null}
                    {(item.signals?.demandPressure?.driverKeys || []).slice(0, 3).map((key) => (
                      <span key={`pressure:${key}`}>{formatLabel(key)}</span>
                    ))}
                  </div>
                ) : null}
                <div className="portfolio-row-actions">
                  <button
                    className="portfolio-mini-action"
                    type="button"
                    onClick={() => planLaunch(item.id)}
                    disabled={planningId === item.id}
                  >
                    {planningId === item.id ? 'Planning' : 'Plan launch'}
                  </button>
                  <button
                    className="portfolio-mini-action"
                    type="button"
                    onClick={() => recordFalsePositive(item)}
                    disabled={outcomeId === item.id}
                  >
                    {outcomeId === item.id ? 'Learning' : 'Mark false positive'}
                  </button>
                </div>
              </article>
            )) : <EmptyState label={loading ? 'Loading market evidence' : 'No market opportunities'} />}
          </div>
        </section>

        <section className="portfolio-panel" aria-label="coverage">
          <PanelHeader eyebrow="readiness" title="Coverage" detail={coverage.ok ? 'green' : `${coverage.gaps?.length || 0} gaps`} />
          <div className="portfolio-coverage-stack">
            <div className="portfolio-coverage-number">
              <strong>{coverage.launchCandidates || 0}</strong>
              <span>launch candidates</span>
            </div>
            <div className="portfolio-gap-list">
              {(coverage.gaps || []).length ? coverage.gaps.slice(0, 6).map((gap) => (
                <span key={gap}>{formatLabel(gap)}</span>
              )) : <span>foundation present</span>}
            </div>
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-full" aria-label="board decision command center">
          <PanelHeader
            eyebrow="board readiness"
            title="Decision Command Center"
            detail={readinessCommands.length ? `${readinessCommands.length} reports` : loading ? 'loading' : 'empty'}
          />
          <div className="portfolio-command-buttons">
            {LIVE_RELEASE_QUEUE_FILTERS.map((filter) => (
              <button
                className="portfolio-mini-action"
                type="button"
                key={filter.key}
                aria-pressed={liveReleaseQueueFilter === filter.key}
                onClick={() => setLiveReleaseQueueFilter(filter.key)}
              >
                {filter.buttonLabel}
              </button>
            ))}
            <button
              className="portfolio-mini-action"
              type="button"
              onClick={exportLiveReleaseBlockerQueue}
              disabled={fixingId === 'export_live_release_blocker_queue'}
            >
              {fixingId === 'export_live_release_blocker_queue' ? 'Exporting' : `Export ${selectedLiveReleaseQueueFilter.label.toLowerCase()}`}
            </button>
            <button
              className="portfolio-mini-action"
              type="button"
              onClick={acknowledgeLiveReleaseBlockerQueueExportReview}
              disabled={!lastLiveReleaseQueueExport?.integrityManifest?.checksum || !!currentLiveReleaseQueueReviewReceipt || fixingId === 'acknowledge_live_release_blocker_queue_export_review'}
            >
              {currentLiveReleaseQueueReviewReceipt ? 'Checksum acknowledged' : fixingId === 'acknowledge_live_release_blocker_queue_export_review' ? 'Acknowledging' : 'Acknowledge checksum'}
            </button>
          </div>
          <div className="portfolio-command-tags" aria-label="live release blocker queue checksum acknowledgements">
            {lastLiveReleaseQueueExport?.reviewComparison ? (
              <span>{formatLiveReleaseQueueReviewComparison(lastLiveReleaseQueueExport.reviewComparison)}</span>
            ) : null}
            {liveReleaseQueueReviewReceipts.length ? liveReleaseQueueReviewReceipts.slice(0, 5).map((receipt) => (
              <span key={receipt.id || receipt.checksum}>{formatLiveReleaseQueueReviewReceipt(receipt)}</span>
            )) : <span>{selectedLiveReleaseQueueFilter.label}: no acknowledgements</span>}
          </div>
          <div className="portfolio-command-list">
            {readinessCommands.length ? readinessCommands.map((item) => (
              <article className="portfolio-command" key={item.id}>
                <div className="portfolio-command-head">
                  <div>
                    <span>{formatLabel(item.status)}</span>
                    <h2>{item.serviceBusinessName}</h2>
                  </div>
                  <StatusPill tone={commandTone(item.status)}>{item.blockerCount} blockers</StatusPill>
                </div>
                <div className="portfolio-command-grid">
                  <div><span>cleared</span><strong>{item.clearedCount || 0}</strong></div>
                  <div><span>plans</span><strong>{item.compensation?.planCount || 0}</strong></div>
                  <div><span>receipts</span><strong>{item.compensation?.receiptCount || 0}</strong></div>
                  <div><span>evidence</span><strong>{item.evidence?.artifactCount || 0}</strong></div>
                  <div><span>pending</span><strong>{item.evidence?.pendingReviewCount || 0}</strong></div>
                </div>
                <div className="portfolio-command-tags">
                  {(item.remainingProofBlockers || []).map((blocker) => <span key={`proof:${blocker}`}>{formatLabel(blocker)}</span>)}
                  {(item.runtimeBlockers || []).map((blocker) => <span key={`runtime:${blocker}`}>{formatLabel(blocker)}</span>)}
                </div>
                {item.evidence?.pendingReviewCount ? (
                  <div className="portfolio-command-tags" aria-label="pending evidence review">
                    <span>{item.evidence.pendingReviewCount} pending local review</span>
                    {item.evidence.pendingReviewCanClearLiveGate === false ? <span>live proof still required</span> : null}
                    {(item.evidence.pendingReviewProofKeys || []).map((proofKey) => (
                      <span key={`pending:${proofKey}`}>{formatLabel(proofKey)}</span>
                    ))}
                  </div>
                ) : null}
                <div className="portfolio-command-actions">
                  {(item.nextActions || []).slice(0, 5).map((next) => (
                    <div key={next.blocker}>
                      <strong>{next.label}</strong>
                      <p>{next.action}</p>
                    </div>
                  ))}
                </div>
	                {(item.actionCommands || []).some((command) => command.action === 'record_provider_smoke_receipt') ? (
	                  <div className="portfolio-adapter-proof" aria-label="provider smoke proof">
	                    <label>
	                      <input
	                        type="checkbox"
	                        checked={providerSmokeProofs[item.id]?.liveSmokePassed === true}
	                        onChange={(event) => updateReadinessProviderSmokeProof(item.id, { liveSmokePassed: event.target.checked })}
	                      />
	                      <span>provider smoke passed</span>
	                    </label>
	                    <label>
	                      <input
	                        type="checkbox"
	                        checked={providerSmokeProofs[item.id]?.operatorVerified === true}
	                        onChange={(event) => updateReadinessProviderSmokeProof(item.id, { operatorVerified: event.target.checked })}
	                      />
	                      <span>smoke operator verified</span>
	                    </label>
	                    <input
	                      type="text"
	                      value={providerSmokeProofs[item.id]?.provider || 'agentmail'}
	                      onChange={(event) => updateReadinessProviderSmokeProof(item.id, { provider: event.target.value })}
	                      placeholder="provider"
	                      aria-label="provider smoke provider"
	                    />
	                    <input
	                      type="text"
	                      value={providerSmokeProofs[item.id]?.liveFlags || 'LIVE_EMAILS'}
	                      onChange={(event) => updateReadinessProviderSmokeProof(item.id, { liveFlags: event.target.value })}
	                      placeholder="LIVE_EMAILS"
	                      aria-label="provider live flags"
	                    />
	                  </div>
	                ) : null}
	                {(item.actionCommands || []).some((command) => command.action === 'verify_adapter_implementation') ? (
	                  <div className="portfolio-adapter-proof" aria-label="adapter implementation proof">
                    <label>
                      <input
                        type="checkbox"
                        checked={adapterProofs[item.id]?.adapterImplemented === true}
                        onChange={(event) => updateReadinessAdapterProof(item.id, { adapterImplemented: event.target.checked })}
                      />
                      <span>implementation packet reviewed</span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={adapterProofs[item.id]?.operatorVerified === true}
                        onChange={(event) => updateReadinessAdapterProof(item.id, { operatorVerified: event.target.checked })}
                      />
                      <span>operator verified</span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={adapterProofs[item.id]?.rollbackPlanAttached === true}
                        onChange={(event) => updateReadinessAdapterProof(item.id, { rollbackPlanAttached: event.target.checked })}
                      />
                      <span>rollback plan attached</span>
                    </label>
                    <input
                      type="text"
                      value={adapterProofs[item.id]?.rollbackReference || ''}
                      onChange={(event) => updateReadinessAdapterProof(item.id, { rollbackReference: event.target.value })}
                      placeholder="rollback reference"
                      aria-label="rollback reference"
                    />
                  </div>
                ) : null}
                <div className="portfolio-command-buttons">
                  {item.liveReleaseBlockerDigest?.releasePreflightBlocked === true && item.liveReleaseBlockerDigest?.liveExecuteDenials?.exportEndpoint ? (
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => exportReadinessLiveExecuteDenial(item)}
                      disabled={fixingId === `${item.id}:export_live_execute_denial_provenance`}
                    >
                      {fixingId === `${item.id}:export_live_execute_denial_provenance` ? 'Exporting' : 'Export denial audit'}
                    </button>
                  ) : null}
                  {(item.actionCommands || []).map((command) => (
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      key={command.action}
                      onClick={() => runReadinessCommand(item, command)}
                      disabled={command.enabled === false || fixingId === `${item.id}:${command.action}`}
                    >
                      {fixingId === `${item.id}:${command.action}` ? 'Working' : command.label}
                    </button>
                  ))}
                </div>
              </article>
            )) : <EmptyState label={loading ? 'Loading readiness commands' : 'No readiness command reports'} />}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-full" aria-label="retention cohort command center">
          <PanelHeader
            eyebrow="retention automation"
            title="Retention Cohort Command Center"
            detail={retentionCohortCommands.length ? `${retentionCohortCommands.length} cohorts` : loading ? 'loading' : 'empty'}
          />
          <div className="portfolio-command-list">
            {retentionCohortCommands.length ? retentionCohortCommands.map((item) => (
              <article className="portfolio-command" key={item.id}>
                <div className="portfolio-command-head">
                  <div>
                    <span>{formatLabel(item.cohortKey)} · {formatLabel(item.segment)}</span>
                    <h2>{item.serviceBusinessName}</h2>
                  </div>
                  <StatusPill tone={item.blockerCount ? 'warm' : 'good'}>{item.blockerCount} blockers</StatusPill>
                </div>
                <div className="portfolio-command-grid">
                  <div><span>saved</span><strong>{item.savedCustomerCount || 0}</strong></div>
                  <div><span>at risk</span><strong>{item.atRiskCustomerCount || 0}</strong></div>
                  <div><span>receipts</span><strong>{item.playbookReceiptCount || 0}</strong></div>
                  <div><span>work items</span><strong>{item.commandWorkItemCount || 0}</strong></div>
                  <div><span>approved</span><strong>{item.approvedCommandWorkItemCount || 0}</strong></div>
                  <div><span>sweeps</span><strong>{item.commandWorkItemLeaseSweepReceiptCount || 0}</strong></div>
                  <div><span>maint.</span><strong>{item.commandWorkItemLeaseMaintenanceReceiptCount || 0}</strong></div>
                  <div><span>stale leases</span><strong>{item.staleCommandWorkItemLeaseCount || 0}</strong></div>
                  <div><span>net</span><strong>{formatMoney(item.netRetentionValueCents || 0)}</strong></div>
                </div>
                <div className="portfolio-command-tags">
                  {(item.blockers || []).slice(0, 6).map((blocker) => <span key={`retention-blocker:${item.id}:${blocker}`}>{formatLabel(blocker)}</span>)}
                  {(item.cleared || []).slice(0, 4).map((cleared) => <span key={`retention-cleared:${item.id}:${cleared}`}>{formatLabel(cleared)}</span>)}
                  {(item.operatorReviewedProofKeys || []).slice(0, 4).map((proofKey) => <span key={`retention-proof:${item.id}:${proofKey}`}>{formatLabel(proofKey)} reviewed</span>)}
                  {item.commandWorkItemProofPacketStatus ? <span>{formatLabel(item.commandWorkItemProofPacketStatus)}</span> : null}
                  {item.leaseMaintenanceStatus ? <span>{formatLabel(item.leaseMaintenanceStatus)}</span> : null}
                  {item.retentionCommandProofPacket?.liveGateSemantics?.canClearCustomerRetentionLivePreflight === false ? <span>live gate not cleared</span> : null}
                  {item.safety?.customerMessageSent === false ? <span>customer message sent false</span> : null}
                  {item.safety?.financeRollupMutated === false ? <span>finance rollup mutated false</span> : null}
                </div>
                <div className="portfolio-command-actions">
                  {(item.nextActions || []).slice(0, 5).map((next) => (
                    <div key={next.blocker}>
                      <strong>{next.label}</strong>
                      <p>{next.action}</p>
                    </div>
                  ))}
                </div>
                {item.commandWorkItems?.length ? (
                  <div className="portfolio-command-actions">
                    {item.commandWorkItems.slice(0, 3).map((workItem) => (
                      <div key={`retention-command-work-item:${workItem.id}`}>
                        <strong>{formatLabel(workItem.workItemKind)}</strong>
                        <p>{workItem.title}</p>
                        <button
                          className="portfolio-mini-action"
                          type="button"
                          onClick={() => claimRetentionCommandWorkItem(item, workItem)}
                          disabled={fixingId === `${workItem.id}:claim` || workItem.status === 'approved' || workItem.lease?.status === 'active'}
                        >
                          {fixingId === `${workItem.id}:claim` ? 'Working' : workItem.lease?.status === 'active' ? 'Claimed' : 'Claim'}
                        </button>
                        {workItem.lease?.status === 'active' ? (
                          <button
                            className="portfolio-mini-action"
                            type="button"
                            onClick={() => releaseRetentionCommandWorkItem(item, workItem)}
                            disabled={fixingId === `${workItem.id}:release` || workItem.status === 'approved'}
                          >
                            {fixingId === `${workItem.id}:release` ? 'Working' : 'Release'}
                          </button>
                        ) : null}
                        <button
                          className="portfolio-mini-action"
                          type="button"
                          onClick={() => decideRetentionCommandWorkItem(item, workItem, 'approve')}
                          disabled={fixingId === `${workItem.id}:approve` || workItem.status === 'approved'}
                        >
                          {fixingId === `${workItem.id}:approve` ? 'Working' : workItem.status === 'approved' ? 'Approved' : 'Approve'}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="portfolio-command-buttons">
                  {(item.actionCommands || []).filter((command) => command.action === 'queue_retention_command_work_items').map((command) => (
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      key={command.action}
                      onClick={() => queueRetentionCommandWorkItems(item, command)}
                      disabled={command.enabled === false || fixingId === `${item.id}:${command.action}`}
                    >
                      {fixingId === `${item.id}:${command.action}` ? 'Working' : command.label}
                    </button>
                  ))}
                  {(item.actionCommands || []).filter((command) => command.action === 'collect_retention_command_work_item_proof_packet').map((command) => (
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      key={command.action}
                      onClick={() => collectRetentionCommandWorkItemProofPacket(item, command)}
                      disabled={command.enabled === false || fixingId === `${item.id}:${command.action}`}
                    >
                      {fixingId === `${item.id}:${command.action}` ? 'Working' : command.label}
                    </button>
                  ))}
                  {(item.actionCommands || []).filter((command) => command.action === 'record_retention_command_lease_maintenance').map((command) => (
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      key={command.action}
                      onClick={() => recordRetentionCommandLeaseMaintenance(item, command)}
                      disabled={command.enabled === false || fixingId === `${item.id}:${command.action}`}
                    >
                      {fixingId === `${item.id}:${command.action}` ? 'Working' : command.label}
                    </button>
                  ))}
                  {(item.actionCommands || []).filter((command) => command.action === 'expire_retention_command_work_item_leases').map((command) => (
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      key={command.action}
                      onClick={() => expireRetentionCommandWorkItemLeases(item, command)}
                      disabled={command.enabled === false || fixingId === `${item.id}:${command.action}`}
                    >
                      {fixingId === `${item.id}:${command.action}` ? 'Working' : command.label}
                    </button>
                  ))}
                </div>
              </article>
            )) : <EmptyState label={loading ? 'Loading retention cohort commands' : 'No retention cohort commands'} />}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="service businesses">
          <PanelHeader
            eyebrow="business builder"
            title="Launch Candidates"
            detail={serviceBusinesses.length ? `${serviceBusinesses.length} visible` : loading ? 'loading' : 'empty'}
          />
          <div className="portfolio-business-list">
            {serviceBusinesses.length ? serviceBusinesses.map((business) => (
              <article className="portfolio-business" key={business.id}>
                <div className="portfolio-business-head">
                  <div>
                    <h2>{business.brand_name || business.name}</h2>
                    <p>{business.name}</p>
                  </div>
                  <StatusPill tone={business.readiness?.safeToPromote ? 'good' : 'warm'}>
                    {business.readiness?.safeToPromote ? 'promotable' : formatLabel(business.status)}
                  </StatusPill>
                </div>
                <div className="portfolio-business-outcome">{business.customer_outcome}</div>
                <div className="portfolio-business-meta">
                  <span>{business.vertical_key}</span>
                  <span>{business.territory_name || 'territory pending'}</span>
                  <span>{business.offer?.packages?.length || 0} packages</span>
                </div>
                <div className="portfolio-missing">
                  {(business.readiness?.missing || []).slice(0, 4).map((item) => <span key={item}>{formatLabel(item)}</span>)}
                </div>
                {business.readiness?.trustAssetPlan ? (
                  <div className="portfolio-tag-stack" aria-label="service trust asset plan">
                    <span title={(business.readiness.trustAssetPlan.assumptions || []).join(' · ')}>
                      trust assets · {business.readiness.trustAssetPlan.assetCount || 0}
                    </span>
                    {Number.isFinite(business.readiness.trustAssetPlan.provenance?.explainabilityScore) ? (
                      <span>
                        evidence · {formatRatio(business.readiness.trustAssetPlan.provenance.explainabilityScore)}
                      </span>
                    ) : null}
                    {business.readiness.trustAssetPlan.provenance?.selectedNeighborhoodKey ? (
                      <span>area · {formatLabel(business.readiness.trustAssetPlan.provenance.selectedNeighborhoodKey)}</span>
                    ) : null}
                    {(business.readiness.trustAssetPlan.assets || []).slice(0, 3).map((asset) => (
                      <span key={`trust-asset:${business.id}:${asset.key}`}>{formatLabel(asset.key)} · {formatLabel(asset.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.serviceMenuPlan ? (
                  <div className="portfolio-tag-stack" aria-label="service menu plan">
                    <span title={(business.readiness.serviceMenuPlan.assumptions || []).join(' · ')}>
                      menu · {formatLabel(business.readiness.serviceMenuPlan.status)}
                    </span>
                    <span title={business.readiness.serviceMenuPlan.customerPromiseBoundary || ''}>
                      public menu · {business.readiness.serviceMenuPlan.publicMenuAllowed ? 'allowed' : 'blocked'}
                    </span>
                    {Number.isFinite(business.readiness.serviceMenuPlan.representativePriceCents) ? (
                      <span>price · {formatMoney(business.readiness.serviceMenuPlan.representativePriceCents)}</span>
                    ) : null}
                    <span>packages · {business.readiness.serviceMenuPlan.packageCount || 0}</span>
                    {(business.readiness.serviceMenuPlan.packages || []).slice(0, 2).map((item) => (
                      <span key={`menu-package:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.communicationProvisioningPlan ? (
                  <div className="portfolio-tag-stack" aria-label="communication provisioning plan">
                    <span title={(business.readiness.communicationProvisioningPlan.assumptions || []).join(' · ')}>
                      comms · {formatLabel(business.readiness.communicationProvisioningPlan.status)}
                    </span>
                    <span title={business.readiness.communicationProvisioningPlan.customerPromiseBoundary || ''}>
                      live comms · {business.readiness.communicationProvisioningPlan.liveProvisioningAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>phone · {formatLabel(business.readiness.communicationProvisioningPlan.phone?.status)}</span>
                    <span>inbox · {formatLabel(business.readiness.communicationProvisioningPlan.inbox?.status)}</span>
                    {(business.readiness.communicationProvisioningPlan.routingRules || []).slice(0, 2).map((rule) => (
                      <span key={`comms-rule:${business.id}:${rule.key}`}>{formatLabel(rule.key)} · {formatLabel(rule.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.localDomainStrategyPlan ? (
                  <div className="portfolio-tag-stack" aria-label="local domain strategy plan">
                    <span title={(business.readiness.localDomainStrategyPlan.assumptions || []).join(' · ')}>
                      domain · {formatLabel(business.readiness.localDomainStrategyPlan.status)}
                    </span>
                    <span title={business.readiness.localDomainStrategyPlan.customerPromiseBoundary || ''}>
                      registration · {business.readiness.localDomainStrategyPlan.liveRegistrationAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>dns · {business.readiness.localDomainStrategyPlan.publicDnsAllowed ? 'allowed' : 'blocked'}</span>
                    {business.readiness.localDomainStrategyPlan.primaryCandidateDomain ? (
                      <span>primary · {business.readiness.localDomainStrategyPlan.primaryCandidateDomain}</span>
                    ) : null}
                    {business.readiness.localDomainStrategyPlan.routePath ? (
                      <span>path · {business.readiness.localDomainStrategyPlan.routePath}</span>
                    ) : null}
                  </div>
                ) : null}
                {business.readiness?.launchReadinessWorkItemPlan ? (
                  <div className="portfolio-tag-stack" aria-label="launch readiness work item plan">
                    <span title={(business.readiness.launchReadinessWorkItemPlan.assumptions || []).join(' · ')}>
                      work items · {business.readiness.launchReadinessWorkItemPlan.workItemCount || 0}
                    </span>
                    <span title={business.readiness.launchReadinessWorkItemPlan.customerPromiseBoundary || ''}>
                      live work · {business.readiness.launchReadinessWorkItemPlan.liveExecutionAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>blocked · {business.readiness.launchReadinessWorkItemPlan.blockedCount || 0}</span>
                    <span>draft · {business.readiness.launchReadinessWorkItemPlan.draftCount || 0}</span>
                    {(business.readiness.launchReadinessWorkItemPlan.workItems || []).slice(0, 2).map((item) => (
                      <span key={`launch-work-item:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.serviceScriptPlan ? (
                  <div className="portfolio-tag-stack" aria-label="service script plan">
                    <span title={(business.readiness.serviceScriptPlan.assumptions || []).join(' · ')}>
                      scripts · {business.readiness.serviceScriptPlan.scriptCount || 0}
                    </span>
                    <span title={business.readiness.serviceScriptPlan.customerPromiseBoundary || ''}>
                      live scripts · {business.readiness.serviceScriptPlan.liveScriptsAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>messages · {business.readiness.serviceScriptPlan.externalMessageAllowed ? 'allowed' : 'blocked'}</span>
                    <span>vendors · {business.readiness.serviceScriptPlan.vendorDispatchAllowed ? 'allowed' : 'blocked'}</span>
                    {(business.readiness.serviceScriptPlan.scripts || []).slice(0, 2).map((item) => (
                      <span key={`service-script:${business.id}:${item.key}`}>{formatLabel(item.channel)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.serviceCompliancePolicyPlan ? (
                  <div className="portfolio-tag-stack" aria-label="service compliance policy plan">
                    <span title={(business.readiness.serviceCompliancePolicyPlan.assumptions || []).join(' · ')}>
                      policy · {formatLabel(business.readiness.serviceCompliancePolicyPlan.status)}
                    </span>
                    <span title={business.readiness.serviceCompliancePolicyPlan.customerPromiseBoundary || ''}>
                      live claims · {business.readiness.serviceCompliancePolicyPlan.liveClaimsAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>region · {formatLabel(business.readiness.serviceCompliancePolicyPlan.regionPolicyStatus)}</span>
                    <span>restricted · {business.readiness.serviceCompliancePolicyPlan.restrictedClaimCount || 0}</span>
                    {(business.readiness.serviceCompliancePolicyPlan.restrictedAdviceRules || []).slice(0, 2).map((item) => (
                      <span key={`policy-rule:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.providerSandboxOrchestrationPlan ? (
                  <div className="portfolio-tag-stack" aria-label="provider sandbox orchestration plan">
                    <span title={(business.readiness.providerSandboxOrchestrationPlan.assumptions || []).join(' · ')}>
                      sandbox · {formatLabel(business.readiness.providerSandboxOrchestrationPlan.status)}
                    </span>
                    <span title={business.readiness.providerSandboxOrchestrationPlan.customerPromiseBoundary || ''}>
                      live providers · {business.readiness.providerSandboxOrchestrationPlan.liveProviderExecutionAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>providers · {business.readiness.providerSandboxOrchestrationPlan.providerCount || 0}</span>
                    <span>blockers · {business.readiness.providerSandboxOrchestrationPlan.blockerCount || 0}</span>
                    {(business.readiness.providerSandboxOrchestrationPlan.providerMocks || []).slice(0, 2).map((item) => (
                      <span key={`provider-sandbox:${business.id}:${item.provider}`}>{formatLabel(item.provider)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.customerOperatingRoomPlan ? (
                  <div className="portfolio-tag-stack" aria-label="customer operating room plan">
                    <span title={(business.readiness.customerOperatingRoomPlan.assumptions || []).join(' · ')}>
                      room · {formatLabel(business.readiness.customerOperatingRoomPlan.status)}
                    </span>
                    <span title={business.readiness.customerOperatingRoomPlan.customerPromiseBoundary || ''}>
                      portal · {business.readiness.customerOperatingRoomPlan.publicPortalAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>workflows · {business.readiness.customerOperatingRoomPlan.workflowCount || 0}</span>
                    <span>visible · {business.readiness.customerOperatingRoomPlan.customerVisibilityAllowed ? 'allowed' : 'blocked'}</span>
                    <span>privacy controls · {business.customerPrivacyControlReceiptCount || 0}</span>
                    {(business.readiness.customerOperatingRoomPlan.workflows || []).slice(0, 2).map((item) => (
                      <span key={`customer-room:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.operatorSupervisionPlan ? (
                  <div className="portfolio-tag-stack" aria-label="operator supervision plan">
                    <span title={(business.readiness.operatorSupervisionPlan.assumptions || []).join(' · ')}>
                      operator · {formatLabel(business.readiness.operatorSupervisionPlan.status)}
                    </span>
                    <span title={business.readiness.operatorSupervisionPlan.customerPromiseBoundary || ''}>
                      inbox · {business.readiness.operatorSupervisionPlan.operatorInboxLive ? 'live' : 'draft'}
                    </span>
                    <span>lanes · {business.readiness.operatorSupervisionPlan.inboxLaneCount || 0}</span>
                    {Number.isFinite(business.operatorInboxOpenCount) ? (
                      <span>durable inbox · {business.operatorInboxOpenCount}</span>
                    ) : null}
                    {Number.isFinite(business.operatorAssignmentQueueCount) ? (
                      <span>queues · {business.operatorAssignmentQueueCount}</span>
                    ) : null}
                    {Number.isFinite(business.operatorBulkReviewReceiptCount) ? (
                      <span>bulk receipts · {business.operatorBulkReviewReceiptCount}</span>
                    ) : null}
                    {Number.isFinite(business.operatorClaimedItemCount) ? (
                      <span>claimed · {business.operatorClaimedItemCount}</span>
                    ) : null}
                    {Number.isFinite(business.operatorExpiredClaimCount) ? (
                      <span>expired claims · {business.operatorExpiredClaimCount}</span>
                    ) : null}
                    {Number.isFinite(business.operatorStaffingGapCount) ? (
                      <span>staffing gap · {business.operatorStaffingGapCount}</span>
                    ) : null}
                    {Number.isFinite(business.operatorSlaOverdueCount) ? (
                      <span>SLA overdue · {business.operatorSlaOverdueCount}</span>
                    ) : null}
                    <span>escalations · {business.readiness.operatorSupervisionPlan.escalationPlaybookCount || 0}</span>
                    <span>labels · {business.readiness.operatorSupervisionPlan.trainingLabelCount || 0}</span>
                    {(business.readiness.operatorSupervisionPlan.inboxLanes || []).slice(0, 2).map((item) => (
                      <span key={`operator-lane:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.providerQualitySelectionPlan ? (
                  <div className="portfolio-tag-stack" aria-label="provider quality selection plan">
                    <span title={(business.readiness.providerQualitySelectionPlan.assumptions || []).join(' · ')}>
                      provider quality · {formatLabel(business.readiness.providerQualitySelectionPlan.status)}
                    </span>
                    <span title={business.readiness.providerQualitySelectionPlan.customerPromiseBoundary || ''}>
                      live routing · {business.readiness.providerQualitySelectionPlan.liveRoutingAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>providers · {business.readiness.providerQualitySelectionPlan.providerCount || 0}</span>
                    <span>selectable · {business.readiness.providerQualitySelectionPlan.selectableProviderCount || 0}</span>
                    {(business.readiness.providerQualitySelectionPlan.scorecards || []).slice(0, 2).map((item) => (
                      <span key={`provider-quality:${business.id}:${item.provider}`}>{formatLabel(item.provider)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.providerMigrationPlan ? (
                  <div className="portfolio-tag-stack" aria-label="provider migration plan">
                    <span title={(business.readiness.providerMigrationPlan.assumptions || []).join(' · ')}>
                      migration · {formatLabel(business.readiness.providerMigrationPlan.status)}
                    </span>
                    <span title={business.readiness.providerMigrationPlan.customerPromiseBoundary || ''}>
                      live migration · {business.readiness.providerMigrationPlan.liveMigrationAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>steps · {business.readiness.providerMigrationPlan.stepCount || 0}</span>
                    <span>rollback · {business.readiness.providerMigrationPlan.rollbackRequired ? 'required' : 'optional'}</span>
                    {(business.readiness.providerMigrationPlan.migrationSteps || []).slice(0, 2).map((item) => (
                      <span key={`provider-migration:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.productTelemetryPlan ? (
                  <div className="portfolio-tag-stack" aria-label="product telemetry work generation plan">
                    <span title={(business.readiness.productTelemetryPlan.assumptions || []).join(' · ')}>
                      telemetry · {formatLabel(business.readiness.productTelemetryPlan.status)}
                    </span>
                    <span title={business.readiness.productTelemetryPlan.customerPromiseBoundary || ''}>
                      live telemetry · {business.readiness.productTelemetryPlan.liveTelemetryAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>streams · {business.readiness.productTelemetryPlan.streamCount || 0}</span>
                    <span>artifacts · {business.readiness.productTelemetryPlan.artifactCount || 0}</span>
                    {(business.readiness.productTelemetryPlan.telemetryStreams || []).slice(0, 2).map((item) => (
                      <span key={`product-telemetry:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.acquisitionExpansionPlan ? (
                  <div className="portfolio-tag-stack" aria-label="acquisition expansion plan">
                    <span title={(business.readiness.acquisitionExpansionPlan.assumptions || []).join(' · ')}>
                      acquisition · {formatLabel(business.readiness.acquisitionExpansionPlan.status)}
                    </span>
                    <span title={business.readiness.acquisitionExpansionPlan.customerPromiseBoundary || ''}>
                      owner outreach · {business.readiness.acquisitionExpansionPlan.liveOwnerOutreachAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>target score · {business.readiness.acquisitionExpansionPlan.targetScore ?? 0}</span>
                    <span>workflows · {business.readiness.acquisitionExpansionPlan.workflowCount || 0}</span>
                    <span>diagnostics · {business.readiness.acquisitionExpansionPlan.diagnosisCount || 0}</span>
                    {(business.readiness.acquisitionExpansionPlan.workflows || []).slice(0, 2).map((item) => (
                      <span key={`acquisition-expansion:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.operatingHealthPlan ? (
                  <div className="portfolio-tag-stack" aria-label="operating health plan">
                    <span title={(business.readiness.operatingHealthPlan.assumptions || []).join(' · ')}>
                      health · {formatLabel(business.readiness.operatingHealthPlan.status)}
                    </span>
                    <span title={business.readiness.operatingHealthPlan.customerPromiseBoundary || ''}>
                      readiness claim · {business.readiness.operatingHealthPlan.readinessClaimsAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>checks · {business.readiness.operatingHealthPlan.healthCheckCount || 0}</span>
                    <span>evidence · {business.readiness.operatingHealthPlan.readinessEvidenceCount || 0}</span>
                    <span>score · {business.readiness.operatingHealthPlan.overallHealthScore ?? 0}</span>
                    {(business.readiness.operatingHealthPlan.healthChecks || []).slice(0, 2).map((item) => (
                      <span key={`operating-health:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.continualLearningPlan ? (
                  <div className="portfolio-tag-stack" aria-label="continual learning plan">
                    <span title={(business.readiness.continualLearningPlan.assumptions || []).join(' · ')}>
                      learning · {formatLabel(business.readiness.continualLearningPlan.status)}
                    </span>
                    <span title={business.readiness.continualLearningPlan.customerPromiseBoundary || ''}>
                      auto strategy · {business.readiness.continualLearningPlan.automaticStrategyRewriteAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>objections · {business.readiness.continualLearningPlan.taxonomyCount || 0}</span>
                    <span>cohorts · {business.readiness.continualLearningPlan.cohortCount || 0}</span>
                    <span>artifacts · {business.readiness.continualLearningPlan.artifactCount || 0}</span>
                    {(business.readiness.continualLearningPlan.objectionTaxonomy || []).slice(0, 2).map((item) => (
                      <span key={`continual-learning:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.autonomousLaunchLoopPlan ? (
                  <div className="portfolio-tag-stack" aria-label="autonomous launch loop plan">
                    <span title={(business.readiness.autonomousLaunchLoopPlan.assumptions || []).join(' · ')}>
                      launch loop · {formatLabel(business.readiness.autonomousLaunchLoopPlan.status)}
                    </span>
                    <span title={business.readiness.autonomousLaunchLoopPlan.customerPromiseBoundary || ''}>
                      live loop · {business.readiness.autonomousLaunchLoopPlan.liveExecutionAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>stages · {business.readiness.autonomousLaunchLoopPlan.stageCount || 0}</span>
                    <span>blocked · {business.readiness.autonomousLaunchLoopPlan.blockedStageCount || 0}</span>
                    <span>ready · {business.readiness.autonomousLaunchLoopPlan.evidenceReadyStageCount || 0}</span>
                    {(business.readiness.autonomousLaunchLoopPlan.stages || []).slice(0, 2).map((item) => (
                      <span key={`autonomous-launch-loop:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.verticalLifecyclePlan ? (
                  <div className="portfolio-tag-stack" aria-label="vertical lifecycle plan">
                    <span title={(business.readiness.verticalLifecyclePlan.assumptions || []).join(' · ')}>
                      vertical lifecycle · {formatLabel(business.readiness.verticalLifecyclePlan.status)}
                    </span>
                    <span title={business.readiness.verticalLifecyclePlan.customerPromiseBoundary || ''}>
                      install · {business.readiness.verticalLifecyclePlan.liveInstallAllowed ? 'allowed' : 'blocked'}
                    </span>
                    <span>version · {business.readiness.verticalLifecyclePlan.versionKey || 'draft'}</span>
                    <span>workflows · {business.readiness.verticalLifecyclePlan.workflowCount || 0}</span>
                    <span>receipts · {business.readiness.verticalLifecyclePlan.receiptCount || 0}</span>
                    {(business.readiness.verticalLifecyclePlan.workflows || []).slice(0, 2).map((item) => (
                      <span key={`vertical-lifecycle:${business.id}:${item.key}`}>{formatLabel(item.key)} · {formatLabel(item.status)}</span>
                    ))}
                  </div>
                ) : null}
                {business.readiness?.bookingFlowPlan ? (
                  <div className="portfolio-tag-stack" aria-label="service booking flow plan">
                    <span title={(business.readiness.bookingFlowPlan.assumptions || []).join(' · ')}>
                      booking · {formatLabel(business.readiness.bookingFlowPlan.status)}
                    </span>
                    <span title={business.readiness.bookingFlowPlan.customerPromiseBoundary || ''}>
                      live booking · {business.readiness.bookingFlowPlan.externalBookingAllowed ? 'allowed' : 'blocked'}
                    </span>
                    {business.readiness.bookingFlowPlan.areaKey ? (
                      <span>area · {formatLabel(business.readiness.bookingFlowPlan.areaKey)}</span>
                    ) : null}
                    <span>steps · {(business.readiness.bookingFlowPlan.steps || []).length}</span>
                    <span>fields · {(business.readiness.bookingFlowPlan.intakeFields || []).length}</span>
                    {(business.readiness.bookingFlowPlan.steps || []).slice(0, 2).map((step) => (
                      <span key={`booking-step:${business.id}:${step.key}`}>{formatLabel(step.key)} · {formatLabel(step.status)}</span>
                    ))}
                  </div>
                ) : null}
                <div className="portfolio-row-actions">
                  <button
                    className="portfolio-mini-action"
                    type="button"
                    onClick={() => evaluateGates(business.id)}
                    disabled={gateId === business.id}
                  >
                    {gateId === business.id ? 'Evaluating' : 'Evaluate gates'}
                  </button>
                </div>
              </article>
            )) : <EmptyState label={loading ? 'Loading launch candidates' : 'No launch candidates'} />}
          </div>
        </section>

        <section className="portfolio-panel" aria-label="capability fabric">
          <PanelHeader eyebrow="capability fabric" title="Fulfillment" detail={`${capabilityKinds.length} kinds`} />
          <div className="portfolio-tag-stack">
            {capabilityKinds.length ? capabilityKinds.map((kind) => <span key={kind}>{formatLabel(kind)}</span>) : <span>no capabilities</span>}
          </div>
          <div className="portfolio-workflow-mini">
            {workflowKeys.slice(0, 5).map((key) => <div key={key}>{formatLabel(key)}</div>)}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio gates">
          <PanelHeader
            eyebrow="operating gates"
            title="Launch And Fulfillment Gates"
            detail={gateEvaluations.length ? `${gateEvaluations.length} receipts` : loading ? 'loading' : 'empty'}
          />
          <div className="portfolio-event-list">
            {gateEvaluations.length ? gateEvaluations.map((gate) => (
              <div className="portfolio-event" key={gate.id}>
                <span>{formatLabel(gate.decision)}</span>
                <strong>{formatLabel(gate.gate_key)}</strong>
                <p>{gate.blockers?.length ? gate.blockers.map((blocker) => formatLabel(blocker.key)).join(', ') : gate.service_business_name || 'ready'}</p>
              </div>
            )) : <EmptyState label={loading ? 'Loading gate receipts' : 'No gate evaluations'} />}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio launch surfaces">
          <PanelHeader
            eyebrow="launched surfaces"
            title="Acquisition Surfaces And Monitoring"
            detail={`${launchSurfaces.length} surfaces / ${monitoringChecks.length} checks`}
          />
          <div className="portfolio-event-list">
            {launchSurfaces.length ? launchSurfaces.map((surface) => (
              <div className="portfolio-event" key={surface.id}>
                <span>{formatLabel(surface.status)}</span>
                <strong>{formatLabel(surface.kind)}</strong>
                <p><a href={surface.url} target="_blank" rel="noreferrer">{surface.url}</a></p>
              </div>
            )) : <EmptyState label={loading ? 'Loading launch surfaces' : 'No launched surfaces'} />}
            {monitoringChecks.length ? monitoringChecks.map((check) => (
              <div className="portfolio-event" key={check.id}>
                <span>{formatLabel(check.status)}</span>
                <strong>{formatLabel(check.kind)}</strong>
                <p>{check.summary}</p>
              </div>
            )) : null}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio acquisition economics">
          <PanelHeader
            eyebrow="acquisition economics"
            title="Attempts, Conversion, Margin"
            detail={`${acquisitionAttempts.length} attempts / ${acquisitionConversions} wins`}
          />
          <div className="portfolio-event-list">
            {acquisitionRollups.length ? acquisitionRollups.map((rollup) => (
              <div className="portfolio-event" key={rollup.serviceBusinessId}>
                <span>{formatRatio(rollup.conversionRate)}</span>
                <strong>{formatMoney(rollup.marginCents)}</strong>
                <p>{rollup.serviceBusinessName}: {rollup.attempts} attempts, {rollup.conversions} wins, {formatMoney(rollup.costCents)} spend</p>
              </div>
            )) : <EmptyState label={loading ? 'Loading acquisition rollups' : 'No acquisition attempts'} />}
            {acquisitionAttempts.length ? acquisitionAttempts.map((attempt) => (
              <div className="portfolio-event" key={attempt.id}>
                <span>{formatLabel(attempt.outcome)}</span>
                <strong>{formatLabel(attempt.channel)}</strong>
                <p>{attempt.service_business_name}: {formatMoney(attempt.cost_cents)} cost / {formatMoney(attempt.revenue_cents)} revenue</p>
              </div>
            )) : null}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio strategy recommendations">
          <PanelHeader
            eyebrow="capital allocation"
            title="Scale/Pause Recommendations"
            detail={strategyRecommendations.length ? `${strategyRecommendations.length} active` : loading ? 'loading' : 'none'}
          />
          <div className="portfolio-event-list">
            {strategyRecommendations.length ? strategyRecommendations.map((recommendation) => {
              const firstAction = Array.isArray(recommendation.actions) ? recommendation.actions[0] : null;
              return (
                <div className="portfolio-event" key={recommendation.id}>
                  <span>{formatLabel(recommendation.decision)}</span>
                  <strong>{formatLabel(recommendation.priority)}</strong>
                  <p>{recommendation.summary}</p>
                  {firstAction ? <p>{formatLabel(firstAction.type)}: {firstAction.summary}</p> : null}
                </div>
              );
            }) : <EmptyState label={loading ? 'Loading strategy recommendations' : 'No scale/pause recommendations'} />}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio acquisition action queue">
          <PanelHeader
            eyebrow="review queue"
            title="Acquisition Actions"
            detail={acquisitionActions.length ? `${acquisitionActions.length} queued` : loading ? 'loading' : 'none'}
          />
          <div className="portfolio-event-list">
            {acquisitionActions.length ? acquisitionActions.map((item) => (
              <div className="portfolio-event" key={item.id}>
                <span>{formatLabel(item.status)}</span>
                <strong>{formatLabel(item.action_type)}</strong>
                <div className="portfolio-event-action">
                  <p>{item.service_business_name}: {formatLabel(item.channel)} / {formatMoney(item.budget_cents || 0)} budget</p>
                  <p>{item.summary}</p>
                  {item.providerReceipts?.[0] ? (
                    <p>{formatLabel(item.providerReceipts[0].provider)} / {formatLabel(item.providerReceipts[0].mode)} receipt: {item.providerReceipts[0].summary}</p>
                  ) : null}
                  {item.status === 'executed' ? (
                    <>
                      <p>{item.proof?.summary || 'Executed with proof.'}</p>
                      {item.proof?.livePreflight ? (
                        <p>Live preflight {formatLabel(item.proof.livePreflight.status)}: {(item.proof.livePreflight.blockers || []).map(formatLabel).join(', ') || 'ready'}</p>
                      ) : null}
                      <button
                        className="portfolio-mini-action"
                        type="button"
                        onClick={() => preflightAcquisitionAction(item)}
                        disabled={fixingId === `${item.id}:preflight`}
                      >
                        {fixingId === `${item.id}:preflight` ? 'Checking live' : 'Preflight live'}
                      </button>
                      <button
                        className="portfolio-mini-action"
                        type="button"
                        onClick={() => publishAcquisitionAction(item)}
                        disabled={fixingId === `${item.id}:publish` || item.proof?.livePreflight?.status !== 'ready_for_live'}
                      >
                        {fixingId === `${item.id}:publish` ? 'Publishing' : 'Publish first-party'}
                      </button>
                      <button
                        className="portfolio-mini-action"
                        type="button"
                        onClick={() => rollbackAcquisitionAction(item)}
                        disabled={fixingId === `${item.id}:rollback`}
                      >
                        {fixingId === `${item.id}:rollback` ? 'Rolling back' : 'Rollback'}
                      </button>
                    </>
                  ) : item.status === 'rolled_back' ? (
                    <p>Rolled back: {item.proof?.rollbackReceipt?.id || item.rollback?.rollbackReceiptId || 'rollback receipt recorded'}</p>
                  ) : (
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => runAcquisitionAction(item)}
                      disabled={fixingId === item.id}
                    >
                      {fixingId === item.id ? 'Working' : 'Approve + execute'}
                    </button>
                  )}
                </div>
              </div>
            )) : <EmptyState label={loading ? 'Loading acquisition actions' : 'No acquisition actions'} />}
            {!acquisitionActions.length && acquisitionActionReceipts.length ? acquisitionActionReceipts.map((receipt) => (
              <div className="portfolio-event" key={receipt.id}>
                <span>{formatLabel(receipt.status)}</span>
                <strong>{formatLabel(receipt.provider)}</strong>
                <p>{receipt.service_business_name}: {formatLabel(receipt.mode)} receipt</p>
              </div>
            )) : null}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio operator queues">
          <PanelHeader
            eyebrow="operator desk"
            title="Operator Queue"
            detail={operatorQueueRows.length || workflowReplayRows.length || evalPublicationRows.length || evalFixtureWorkRows.length || evalFixtureRunnerRows.length || evalFixtureApprovalRows.length || evalGoldenFixtureReviewRows.length || evalNonLiveRunnerBindingRows.length || evalFileDryRunManifestRows.length || evalCiWriteAccessRows.length || evalLiveAdapterReadinessRows.length || evalLiveAdapterContractTestRows.length || evalCiWorkflowPublicationRows.length || evalGeneratedArtifactPromotionRows.length || evalPrMergeProposalRows.length || evalPrOpenSimulationRows.length || evalOperatorMergeApprovalRows.length || evalSubmittedPrEvidenceRows.length || evalPrExternalVerificationRows.length || evalExternalCiResultRows.length || evalGithubPrVerificationRows.length || evalGithubPrObservationRows.length || evalGithubCheckRunObservationRows.length || evalMergeExecutionAdapterContractRows.length || evalOperatorMergeCompletionGateRows.length || evalLiveMergeAuthorizationRows.length || evalBranchProtectionReadbackAdapterContractRows.length || evalTokenScopeObservationAdapterContractRows.length || evalSecretRedactionProofRows.length || evalMergeQueueReadbackAdapterContractRows.length || evalMergeQueueLiveReadReconciliationRows.length || evalMergeQueueLiveReadAdapterContractRows.length || evalMergeQueueLiveReadReadinessRows.length || evalMergeQueueCredentialHandoffRows.length || evalMergeQueueLiveReadPreflightRows.length || evalMergeQueueTokenQuarantineRows.length || evalMergeQueueLiveReadResponseIngestionRows.length || evalMergeQueueRuntimeTokenReleaseGateRows.length || evalMergeQueueLiveReadVerificationPromotionRows.length || evalMergeQueueLiveHttpExecutionPreflightHandoffRows.length || evalMergeQueueLiveHttpOperatorReleaseAckRows.length || evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.length || evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.length || evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.length || evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.length || evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.length || evalMergeQueueRuntimeTokenReleaseDenialRows.length || evalMergeQueueFakeLiveReadReplayQuarantineRows.length || evalMergeQueueFinalBlockerLedgerRows.length || evalMergeQueuePostLedgerOperatorReleaseAttestationRows.length || evalMergeQueuePostAttestationReleaseEscrowRows.length || evalMergeQueueReleaseDenialCloseoutRows.length || evalMergeQueueConsolidatedBlockerAuditRows.length
              ? `${operatorQueueRows.length} role queues / ${workflowReplayRows.length} replay receipts / ${evalPublicationRows.length} eval gates / ${evalFixtureWorkRows.length} fixture work / ${evalFixtureRunnerRows.length} runner receipts / ${evalFixtureApprovalRows.length} approvals / ${evalGoldenFixtureReviewRows.length} golden reviews / ${evalNonLiveRunnerBindingRows.length} runner bindings / ${evalFileDryRunManifestRows.length} file manifests / ${evalCiWriteAccessRows.length} CI proofs / ${evalLiveAdapterReadinessRows.length} adapter proofs / ${evalLiveAdapterContractTestRows.length} contract tests / ${evalCiWorkflowPublicationRows.length} CI workflow receipts / ${evalGeneratedArtifactPromotionRows.length} eval promotions / ${evalPrMergeProposalRows.length} PR gates / ${evalPrOpenSimulationRows.length} PR open simulations / ${evalOperatorMergeApprovalRows.length} merge approval reviews / ${evalSubmittedPrEvidenceRows.length} submitted PR evidence / ${evalPrExternalVerificationRows.length} PR verification / ${evalExternalCiResultRows.length} external CI results / ${evalGithubPrVerificationRows.length} GitHub PR checks / ${evalGithubPrObservationRows.length} GitHub PR observations / ${evalGithubCheckRunObservationRows.length} check-run observations / ${evalMergeExecutionAdapterContractRows.length} merge adapter contracts / ${evalOperatorMergeCompletionGateRows.length} merge completion gates / ${evalLiveMergeAuthorizationRows.length} live merge authorizations / ${evalBranchProtectionReadbackAdapterContractRows.length} branch protection readback contracts / ${evalTokenScopeObservationAdapterContractRows.length} token scope observation contracts / ${evalSecretRedactionProofRows.length} secret redaction proofs / ${evalMergeQueueReadbackAdapterContractRows.length} merge queue readback contracts / ${evalMergeQueueLiveReadReconciliationRows.length} merge queue live-read reconciliations / ${evalMergeQueueLiveReadAdapterContractRows.length} merge queue live-read adapter contracts / ${evalMergeQueueLiveReadReadinessRows.length} merge queue live-read readiness packets / ${evalMergeQueueCredentialHandoffRows.length} credential handoff packets / ${evalMergeQueueLiveReadPreflightRows.length} live-read preflight envelopes / ${evalMergeQueueTokenQuarantineRows.length} token quarantine receipts / ${evalMergeQueueLiveReadResponseIngestionRows.length} live-read response receipts / ${evalMergeQueueRuntimeTokenReleaseGateRows.length} runtime token gate receipts / ${evalMergeQueueLiveReadVerificationPromotionRows.length} live-read promotion receipts / ${evalMergeQueueLiveHttpExecutionPreflightHandoffRows.length} live HTTP preflight handoffs / ${evalMergeQueueLiveHttpOperatorReleaseAckRows.length} live HTTP release acknowledgements / ${evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.length} runtime secret smoke readiness receipts / ${evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.length} runtime secret smoke execution gates / ${evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.length} runtime secret smoke evidence reviews / ${evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.length} memory-only token preflights / ${evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.length} smoke evidence ingestion rejections / ${evalMergeQueueRuntimeTokenReleaseDenialRows.length} runtime token denials / ${evalMergeQueueFakeLiveReadReplayQuarantineRows.length} fake live-read replay quarantines / ${evalMergeQueueFinalBlockerLedgerRows.length} final blocker ledgers / ${evalMergeQueuePostLedgerOperatorReleaseAttestationRows.length} post-ledger release attestations / ${evalMergeQueuePostAttestationReleaseEscrowRows.length} post-attestation release escrows / ${evalMergeQueueReleaseDenialCloseoutRows.length} release denial closeouts / ${evalMergeQueueConsolidatedBlockerAuditRows.length} consolidated blocker audits`
              : loading ? 'loading' : 'clear'}
          />
          <div className="portfolio-event-list">
            {operatorQueueRows.length ? operatorQueueRows.map((row) => (
              <div className="portfolio-event portfolio-operator-queue-row" key={row.queue.id}>
                <span>{formatLabel(row.queue.status)}</span>
                <strong>{formatLabel(row.queue.role_key)}</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>
                      {row.serviceBusinessName}: open {row.queueItems.length} · claimed {row.activeCount} · expired {row.expiredCount}
                    </p>
                    <div className="portfolio-queue-meta" aria-label={`operator queue ${row.queue.role_key} local status`}>
                      <span>{formatLabel(row.queue.priority)} priority</span>
                      <span>{row.queue.policy?.localReviewOnly ? 'local review only' : 'policy missing'}</span>
                      <span>bulk review {row.latestReceipt ? formatLabel(row.latestReceipt.decision) : 'none'}</span>
                      <span>eval {row.latestCloseout ? formatLabel(row.latestCloseout.status) : row.latestReceipt?.learning_record_id ? 'proposed' : 'none'}</span>
                      <span>{row.latestPublicationReceipt ? 'executable publication blocked' : 'eval publication pending'}</span>
                      <span>{row.evalFixtureWorkItemCount ? `eval fixture work queued ${row.evalFixtureWorkItemCount}` : 'eval fixture work pending'}</span>
                      <span>{row.latestFixtureRunnerReceipt ? 'fixture runner dry-run blocked' : 'fixture runner pending'}</span>
                      <span>{row.latestFixtureApprovalReceipt ? 'fixture approval recorded' : 'fixture approval pending'}</span>
                      <span>{row.latestGoldenFixtureReviewReceipt ? 'golden fixture reviewed' : 'golden fixture pending'}</span>
                      <span>{row.latestNonLiveRunnerBindingReceipt ? 'non-live runner bound' : 'runner binding pending'}</span>
                      <span>{row.latestEvalFileDryRunManifest ? 'eval file manifest reviewed' : 'eval file manifest pending'}</span>
                      <span>{row.latestEvalCiWriteAccessReceipt ? 'CI write access reviewed' : 'CI write access pending'}</span>
                      <span>{row.latestEvalLiveAdapterReadinessReceipt ? 'live adapter readiness reviewed' : 'live adapter readiness pending'}</span>
                      <span>{row.latestEvalLiveAdapterContractTestReceipt ? 'live adapter contract tested' : 'adapter contract test pending'}</span>
                      <span>{row.latestEvalCiWorkflowPublicationReceipt ? 'CI workflow published local' : 'CI workflow publication pending'}</span>
                      <span>{row.latestEvalGeneratedArtifactPromotionReceipt ? 'generated eval promoted' : 'eval promotion pending'}</span>
                      <span>{row.latestEvalPrMergeProposalReceipt ? 'PR merge proposal gated' : 'PR merge proposal pending'}</span>
                      <span>{row.latestEvalPrOpenSimulationReceipt ? 'PR open simulated locally' : 'PR open simulation pending'}</span>
                      <span>{row.latestEvalOperatorMergeApprovalReceipt ? 'operator merge approval reviewed' : 'merge approval review pending'}</span>
                      <span>{row.latestEvalSubmittedPrEvidenceReceipt ? 'submitted PR evidence recorded' : 'submitted PR evidence pending'}</span>
                      <span>{row.latestEvalPrExternalVerificationReceipt ? 'PR external verification reconciled' : 'PR external verification pending'}</span>
                      <span>{row.latestEvalExternalCiResultReceipt ? 'external CI result ingested' : 'external CI result pending'}</span>
                      <span>{row.latestEvalGithubPrVerificationReceipt ? 'GitHub PR verification preflighted' : 'GitHub PR verification pending'}</span>
                      <span>{row.latestEvalGithubCheckRunObservationReceipt ? 'GitHub check-runs observed' : row.latestEvalGithubPrObservationReceipt ? 'GitHub check-runs pending' : 'GitHub PR observation pending'}</span>
                      <span>{row.latestEvalMergeExecutionAdapterContractReceipt ? 'merge adapter contract reviewed' : row.latestEvalGithubCheckRunObservationReceipt ? 'merge adapter contract pending' : 'merge adapter contract blocked'}</span>
                      <span>{row.latestEvalOperatorMergeCompletionGateReceipt ? 'merge completion gated' : row.latestEvalMergeExecutionAdapterContractReceipt ? 'merge completion pending' : 'merge completion blocked'}</span>
                      <span>{row.latestEvalLiveMergeAuthorizationReceipt ? 'live merge authorization reviewed' : row.latestEvalOperatorMergeCompletionGateReceipt ? 'live merge authorization pending' : 'live merge authorization blocked'}</span>
                      <span>{row.latestEvalBranchProtectionReadbackAdapterContractReceipt ? 'branch protection readback contract reviewed' : row.latestEvalLiveMergeAuthorizationReceipt ? 'branch protection readback pending' : 'branch protection readback blocked'}</span>
                      <span>{row.latestEvalTokenScopeObservationAdapterContractReceipt ? 'token scope observation contract reviewed' : row.latestEvalBranchProtectionReadbackAdapterContractReceipt ? 'token scope observation pending' : 'token scope observation blocked'}</span>
                      <span>{row.latestEvalSecretRedactionProofReceipt ? 'secret redaction proof recorded' : row.latestEvalTokenScopeObservationAdapterContractReceipt ? 'secret redaction proof pending' : 'secret redaction proof blocked'}</span>
                      <span>{row.latestEvalMergeQueueReadbackAdapterContractReceipt ? 'merge queue readback contract reviewed' : row.latestEvalSecretRedactionProofReceipt ? 'merge queue readback pending' : 'merge queue readback blocked'}</span>
                      <span>{row.latestEvalMergeQueueLiveReadReconciliationReceipt ? 'merge queue live read reconciled' : row.latestEvalMergeQueueReadbackAdapterContractReceipt ? 'merge queue live read pending' : 'merge queue live read blocked'}</span>
                      <span>{row.latestEvalMergeQueueLiveReadAdapterContractReceipt ? 'merge queue live read adapter contracted' : row.latestEvalMergeQueueLiveReadReconciliationReceipt ? 'merge queue live read adapter pending' : 'merge queue live read adapter blocked'}</span>
                      <span>{row.latestEvalMergeQueueLiveReadReadinessReceipt ? 'merge queue live read readiness guarded' : row.latestEvalMergeQueueLiveReadAdapterContractReceipt ? 'merge queue live read readiness pending' : 'merge queue live read readiness blocked'}</span>
                      <span>{row.latestEvalMergeQueueCredentialHandoffReceipt ? 'merge queue credential handoff guarded' : row.latestEvalMergeQueueLiveReadReadinessReceipt ? 'merge queue credential handoff pending' : 'merge queue credential handoff blocked'}</span>
                      <span>{row.latestEvalMergeQueueLiveReadPreflightReceipt ? 'merge queue live read preflight guarded' : row.latestEvalMergeQueueCredentialHandoffReceipt ? 'merge queue live read preflight pending' : 'merge queue live read preflight blocked'}</span>
                      <span>{row.latestEvalMergeQueueTokenQuarantineReceipt ? 'merge queue token quarantine guarded' : row.latestEvalMergeQueueLiveReadPreflightReceipt ? 'merge queue token quarantine pending' : 'merge queue token quarantine blocked'}</span>
                      <span>{row.latestEvalMergeQueueLiveReadResponseIngestionReceipt ? 'merge queue response evidence ingested' : row.latestEvalMergeQueueTokenQuarantineReceipt ? 'merge queue response evidence pending' : 'merge queue response evidence blocked'}</span>
                      <span>{row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt ? 'runtime token release gate recorded' : row.latestEvalMergeQueueLiveReadResponseIngestionReceipt ? 'runtime token release gate pending' : 'runtime token release gate blocked'}</span>
                      <span>{row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt ? 'live-read verification promotion queued' : row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt ? 'live-read verification promotion pending' : 'live-read verification promotion blocked'}</span>
                      <span>{row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt ? 'live HTTP execution preflight handoff guarded' : row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt ? 'live HTTP execution preflight handoff pending' : 'live HTTP execution preflight handoff blocked'}</span>
                      <span>{row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt ? 'live HTTP operator release ack recorded' : row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt ? 'live HTTP operator release ack pending' : 'live HTTP operator release ack blocked'}</span>
                      <span>{row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt ? 'runtime secret smoke readiness recorded' : row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt ? 'runtime secret smoke readiness pending' : 'runtime secret smoke readiness blocked'}</span>
                      <span>{row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt ? 'runtime secret smoke execution gate recorded' : row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt ? 'runtime secret smoke execution gate pending' : 'runtime secret smoke execution gate blocked'}</span>
                      <span>{row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt ? 'runtime secret smoke evidence review recorded' : row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt ? 'runtime secret smoke evidence review pending' : 'runtime secret smoke evidence review blocked'}</span>
                      <span>{row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt ? 'memory-only token preflight recorded' : row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt ? 'memory-only token preflight pending' : 'memory-only token preflight blocked'}</span>
                      <span>{row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt ? 'smoke evidence fake success rejected' : row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt ? 'smoke evidence ingestion pending' : 'smoke evidence ingestion blocked'}</span>
                      <span>{row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt ? 'runtime token release denied' : row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt ? 'runtime token denial pending' : 'runtime token denial blocked'}</span>
                      <span>{row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt ? 'fake live-read replay quarantined' : row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt ? 'fake live-read replay quarantine pending' : 'fake live-read replay quarantine blocked'}</span>
                      <span>{row.latestEvalMergeQueueFinalBlockerLedgerReceipt ? 'final blocker ledger sealed' : row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt ? 'final blocker ledger pending' : 'final blocker ledger blocked'}</span>
                      <span>{row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt ? 'operator release blocked' : row.latestEvalMergeQueueFinalBlockerLedgerReceipt ? 'operator release attestation pending' : 'operator release attestation blocked'}</span>
                      <span>{row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt ? 'post-attestation release escrow held' : row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt ? 'post-attestation release escrow pending' : 'post-attestation release escrow blocked'}</span>
                      <span>{row.latestEvalMergeQueueReleaseDenialCloseoutReceipt ? 'release denial closeout sealed' : row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt ? 'release denial closeout pending' : 'release denial closeout blocked'}</span>
                      <span>SLA target {row.latestStaffingReceipt?.target_first_response_minutes || row.slaTargetMinutes}m</span>
                      <span>overdue {row.latestStaffingReceipt?.overdue_item_count || 0}</span>
                      <span>staff {row.activeOperatorCount}/{row.latestStaffingReceipt?.recommended_operator_count || 0}</span>
                      <span>gap {row.latestStaffingReceipt?.staffing_gap_count || 0}</span>
                      {row.nextLaneKey ? <span>next lane {formatLabel(row.nextLaneKey)}</span> : null}
                    </div>
                  </div>
                  <div className="portfolio-inline-actions">
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => refreshOperatorQueues(row.queue.service_business_id)}
                      disabled={fixingId === `operator-queues:${row.queue.service_business_id}`}
                    >
                      {fixingId === `operator-queues:${row.queue.service_business_id}` ? 'refreshing' : 'refresh'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => claimOperatorQueueItem(row)}
                      disabled={!row.claimableItem || fixingId === `operator-claim:${row.claimableItem?.id}`}
                    >
                      {fixingId === `operator-claim:${row.claimableItem?.id}` ? 'claiming' : 'claim next'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => releaseOperatorAssignment(row)}
                      disabled={!row.activeAssignment || fixingId === `operator-release:${row.activeAssignment?.id}`}
                    >
                      {fixingId === `operator-release:${row.activeAssignment?.id}` ? 'releasing' : 'release claim'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => expireOperatorLeases(row)}
                      disabled={fixingId === `operator-expire:${row.queue.id}`}
                    >
                      {fixingId === `operator-expire:${row.queue.id}` ? 'expiring' : 'expire leases'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordOperatorBulkReview(row)}
                      disabled={!row.queueItems.length || fixingId === `operator-bulk:${row.queue.id}`}
                    >
                      {fixingId === `operator-bulk:${row.queue.id}` ? 'recording' : 'bulk review'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordOperatorStaffingAnalytics(row)}
                      disabled={!row.queueItems.length || fixingId === `operator-staffing:${row.queue.id}`}
                    >
                      {fixingId === `operator-staffing:${row.queue.id}` ? 'measuring' : 'SLA staffing'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => closeoutOperatorHandoffEval(row)}
                      disabled={!row.latestReceipt || Boolean(row.latestCloseout) || fixingId === `operator-eval-closeout:${row.latestReceipt?.id}`}
                    >
                      {fixingId === `operator-eval-closeout:${row.latestReceipt?.id}` ? 'closing' : 'eval closeout'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalPublicationGate(row)}
                      disabled={!row.latestCloseout || Boolean(row.latestPublicationReceipt) || fixingId === `eval-publication:${row.latestCloseout?.id}`}
                    >
                      {fixingId === `eval-publication:${row.latestCloseout?.id}` ? 'gating' : 'publication gate'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalFixtureWorkItems(row)}
                      disabled={!row.latestPublicationReceipt || Boolean(row.evalFixtureWorkItemCount) || fixingId === `eval-fixtures:${row.latestPublicationReceipt?.id}`}
                    >
                      {fixingId === `eval-fixtures:${row.latestPublicationReceipt?.id}` ? 'queueing' : 'fixture work items'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalFixtureRunnerDryRun(row)}
                      disabled={!row.latestPublicationReceipt || !row.evalFixtureWorkItemCount || Boolean(row.latestFixtureRunnerReceipt) || fixingId === `eval-runner:${row.latestPublicationReceipt?.id}`}
                    >
                      {fixingId === `eval-runner:${row.latestPublicationReceipt?.id}` ? 'dry-running' : 'runner dry-run'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalFixtureApproval(row)}
                      disabled={!row.latestFixtureRunnerReceipt || Boolean(row.latestFixtureApprovalReceipt) || fixingId === `eval-approval:${row.latestFixtureRunnerReceipt?.id}`}
                    >
                      {fixingId === `eval-approval:${row.latestFixtureRunnerReceipt?.id}` ? 'approving' : 'fixture approval'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalGoldenFixtureReview(row)}
                      disabled={!row.latestFixtureApprovalReceipt || Boolean(row.latestGoldenFixtureReviewReceipt) || fixingId === `eval-golden:${row.latestFixtureApprovalReceipt?.id}`}
                    >
                      {fixingId === `eval-golden:${row.latestFixtureApprovalReceipt?.id}` ? 'reviewing' : 'golden fixture review'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalNonLiveRunnerBinding(row)}
                      disabled={!row.latestGoldenFixtureReviewReceipt || Boolean(row.latestNonLiveRunnerBindingReceipt) || fixingId === `eval-binding:${row.latestGoldenFixtureReviewReceipt?.id}`}
                    >
                      {fixingId === `eval-binding:${row.latestGoldenFixtureReviewReceipt?.id}` ? 'binding' : 'non-live runner binding'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalFileDryRunManifest(row)}
                      disabled={!row.latestNonLiveRunnerBindingReceipt || Boolean(row.latestEvalFileDryRunManifest) || fixingId === `eval-file-manifest:${row.latestNonLiveRunnerBindingReceipt?.id}`}
                    >
                      {fixingId === `eval-file-manifest:${row.latestNonLiveRunnerBindingReceipt?.id}` ? 'reviewing' : 'eval file manifest'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalCiWriteAccessProof(row)}
                      disabled={!row.latestEvalFileDryRunManifest || Boolean(row.latestEvalCiWriteAccessReceipt) || fixingId === `eval-ci-write:${row.latestEvalFileDryRunManifest?.id}`}
                    >
                      {fixingId === `eval-ci-write:${row.latestEvalFileDryRunManifest?.id}` ? 'checking' : 'CI write proof'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalLiveAdapterReadiness(row)}
                      disabled={!row.latestEvalCiWriteAccessReceipt || Boolean(row.latestEvalLiveAdapterReadinessReceipt) || fixingId === `eval-live-adapter:${row.latestEvalCiWriteAccessReceipt?.id}`}
                    >
                      {fixingId === `eval-live-adapter:${row.latestEvalCiWriteAccessReceipt?.id}` ? 'reviewing' : 'live adapter proof'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalLiveAdapterContractTest(row)}
                      disabled={!row.latestEvalLiveAdapterReadinessReceipt || Boolean(row.latestEvalLiveAdapterContractTestReceipt) || fixingId === `eval-live-adapter-contract:${row.latestEvalLiveAdapterReadinessReceipt?.id}`}
                    >
                      {fixingId === `eval-live-adapter-contract:${row.latestEvalLiveAdapterReadinessReceipt?.id}` ? 'testing' : 'adapter contract test'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalCiWorkflowPublication(row)}
                      disabled={!row.latestEvalLiveAdapterContractTestReceipt || Boolean(row.latestEvalCiWorkflowPublicationReceipt) || fixingId === `eval-ci-workflow:${row.latestEvalLiveAdapterContractTestReceipt?.id}`}
                    >
                      {fixingId === `eval-ci-workflow:${row.latestEvalLiveAdapterContractTestReceipt?.id}` ? 'publishing' : 'CI workflow publish'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalGeneratedArtifactPromotion(row)}
                      disabled={!row.latestEvalCiWorkflowPublicationReceipt || Boolean(row.latestEvalGeneratedArtifactPromotionReceipt) || fixingId === `eval-promotion:${row.latestEvalCiWorkflowPublicationReceipt?.id}`}
                    >
                      {fixingId === `eval-promotion:${row.latestEvalCiWorkflowPublicationReceipt?.id}` ? 'promoting' : 'promote eval'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalPrMergeProposalGate(row)}
                      disabled={!row.latestEvalGeneratedArtifactPromotionReceipt || Boolean(row.latestEvalPrMergeProposalReceipt) || fixingId === `eval-pr-proposal:${row.latestEvalGeneratedArtifactPromotionReceipt?.id}`}
                    >
                      {fixingId === `eval-pr-proposal:${row.latestEvalGeneratedArtifactPromotionReceipt?.id}` ? 'preparing' : 'PR merge gate'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalPrOpenSimulation(row)}
                      disabled={!row.latestEvalPrMergeProposalReceipt || Boolean(row.latestEvalPrOpenSimulationReceipt) || fixingId === `eval-pr-open:${row.latestEvalPrMergeProposalReceipt?.id}`}
                    >
                      {fixingId === `eval-pr-open:${row.latestEvalPrMergeProposalReceipt?.id}` ? 'simulating' : 'PR open simulation gate'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalOperatorMergeApprovalReview(row)}
                      disabled={!row.latestEvalPrOpenSimulationReceipt || Boolean(row.latestEvalOperatorMergeApprovalReceipt) || fixingId === `eval-merge-approval:${row.latestEvalPrOpenSimulationReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-approval:${row.latestEvalPrOpenSimulationReceipt?.id}` ? 'reviewing' : 'merge approval review'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalSubmittedPrEvidence(row)}
                      disabled={!row.latestEvalOperatorMergeApprovalReceipt || Boolean(row.latestEvalSubmittedPrEvidenceReceipt) || fixingId === `eval-submitted-pr:${row.latestEvalOperatorMergeApprovalReceipt?.id}`}
                    >
                      {fixingId === `eval-submitted-pr:${row.latestEvalOperatorMergeApprovalReceipt?.id}` ? 'recording' : 'submitted PR evidence'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalPrExternalVerification(row)}
                      disabled={!row.latestEvalSubmittedPrEvidenceReceipt || Boolean(row.latestEvalPrExternalVerificationReceipt) || fixingId === `eval-pr-verify:${row.latestEvalSubmittedPrEvidenceReceipt?.id}`}
                    >
                      {fixingId === `eval-pr-verify:${row.latestEvalSubmittedPrEvidenceReceipt?.id}` ? 'reconciling' : 'PR verification reconcile'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalExternalCiResult(row)}
                      disabled={!row.latestEvalPrExternalVerificationReceipt || Boolean(row.latestEvalExternalCiResultReceipt) || fixingId === `eval-external-ci:${row.latestEvalPrExternalVerificationReceipt?.id}`}
                    >
                      {fixingId === `eval-external-ci:${row.latestEvalPrExternalVerificationReceipt?.id}` ? 'ingesting' : 'external CI result'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalGithubPrVerification(row)}
                      disabled={!row.latestEvalExternalCiResultReceipt || Boolean(row.latestEvalGithubPrVerificationReceipt) || fixingId === `eval-github-pr:${row.latestEvalExternalCiResultReceipt?.id}`}
                    >
                      {fixingId === `eval-github-pr:${row.latestEvalExternalCiResultReceipt?.id}` ? 'preflighting' : 'GitHub PR check'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalGithubPrObservation(row)}
                      disabled={!row.latestEvalGithubPrVerificationReceipt || Boolean(row.latestEvalGithubPrObservationReceipt) || fixingId === `eval-github-pr-observe:${row.latestEvalGithubPrVerificationReceipt?.id}`}
                    >
                      {fixingId === `eval-github-pr-observe:${row.latestEvalGithubPrVerificationReceipt?.id}` ? 'contracting' : 'GitHub PR observe'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalGithubCheckRunObservation(row)}
                      disabled={!row.latestEvalGithubPrObservationReceipt || Boolean(row.latestEvalGithubCheckRunObservationReceipt) || fixingId === `eval-github-check-run:${row.latestEvalGithubPrObservationReceipt?.id}`}
                    >
                      {fixingId === `eval-github-check-run:${row.latestEvalGithubPrObservationReceipt?.id}` ? 'observing' : 'GitHub check-runs'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeExecutionAdapterContract(row)}
                      disabled={!row.latestEvalGithubCheckRunObservationReceipt || Boolean(row.latestEvalMergeExecutionAdapterContractReceipt) || fixingId === `eval-merge-adapter-contract:${row.latestEvalGithubCheckRunObservationReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-adapter-contract:${row.latestEvalGithubCheckRunObservationReceipt?.id}` ? 'proving' : 'merge adapter contract'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalOperatorMergeCompletionGate(row)}
                      disabled={!row.latestEvalMergeExecutionAdapterContractReceipt || Boolean(row.latestEvalOperatorMergeCompletionGateReceipt) || (row.latestEvalGithubCheckRunObservationReceipt?.response?.checkRunConclusion || row.latestEvalGithubCheckRunObservationReceipt?.check_run_conclusion) !== 'success' || fixingId === `eval-merge-completion:${row.latestEvalGithubCheckRunObservationReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-completion:${row.latestEvalGithubCheckRunObservationReceipt?.id}` ? 'gating' : 'merge completion gate'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalLiveMergeAuthorization(row)}
                      disabled={!row.latestEvalOperatorMergeCompletionGateReceipt || Boolean(row.latestEvalLiveMergeAuthorizationReceipt) || fixingId === `eval-live-merge-auth:${row.latestEvalOperatorMergeCompletionGateReceipt?.id}`}
                    >
                      {fixingId === `eval-live-merge-auth:${row.latestEvalOperatorMergeCompletionGateReceipt?.id}` ? 'reviewing' : 'live merge auth'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalBranchProtectionReadbackAdapterContract(row)}
                      disabled={!row.latestEvalLiveMergeAuthorizationReceipt || Boolean(row.latestEvalBranchProtectionReadbackAdapterContractReceipt) || fixingId === `eval-branch-protection-readback:${row.latestEvalLiveMergeAuthorizationReceipt?.id}`}
                    >
                      {fixingId === `eval-branch-protection-readback:${row.latestEvalLiveMergeAuthorizationReceipt?.id}` ? 'proving' : 'branch protection readback'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalTokenScopeObservationAdapterContract(row)}
                      disabled={!row.latestEvalBranchProtectionReadbackAdapterContractReceipt || Boolean(row.latestEvalTokenScopeObservationAdapterContractReceipt) || fixingId === `eval-token-scope-observation:${row.latestEvalLiveMergeAuthorizationReceipt?.id}`}
                    >
                      {fixingId === `eval-token-scope-observation:${row.latestEvalLiveMergeAuthorizationReceipt?.id}` ? 'proving' : 'token scope observation'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalSecretRedactionProof(row)}
                      disabled={!row.latestEvalTokenScopeObservationAdapterContractReceipt || Boolean(row.latestEvalSecretRedactionProofReceipt) || fixingId === `eval-secret-redaction:${row.latestEvalTokenScopeObservationAdapterContractReceipt?.id}`}
                    >
                      {fixingId === `eval-secret-redaction:${row.latestEvalTokenScopeObservationAdapterContractReceipt?.id}` ? 'proving' : 'secret redaction proof'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueReadbackAdapterContract(row)}
                      disabled={!row.latestEvalSecretRedactionProofReceipt || Boolean(row.latestEvalMergeQueueReadbackAdapterContractReceipt) || fixingId === `eval-merge-queue-readback:${row.latestEvalSecretRedactionProofReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-readback:${row.latestEvalSecretRedactionProofReceipt?.id}` ? 'reviewing' : 'merge queue readback'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueLiveReadReconciliation(row)}
                      disabled={!row.latestEvalMergeQueueReadbackAdapterContractReceipt || Boolean(row.latestEvalMergeQueueLiveReadReconciliationReceipt) || fixingId === `eval-merge-queue-live-read:${row.latestEvalMergeQueueReadbackAdapterContractReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-live-read:${row.latestEvalMergeQueueReadbackAdapterContractReceipt?.id}` ? 'reconciling' : 'merge queue live read'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueLiveReadAdapterContract(row)}
                      disabled={!row.latestEvalMergeQueueLiveReadReconciliationReceipt || Boolean(row.latestEvalMergeQueueLiveReadAdapterContractReceipt) || fixingId === `eval-merge-queue-live-read-adapter:${row.latestEvalMergeQueueLiveReadReconciliationReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-live-read-adapter:${row.latestEvalMergeQueueLiveReadReconciliationReceipt?.id}` ? 'contracting' : 'live read adapter'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueLiveReadReadiness(row)}
                      disabled={!row.latestEvalMergeQueueLiveReadAdapterContractReceipt || Boolean(row.latestEvalMergeQueueLiveReadReadinessReceipt) || fixingId === `eval-merge-queue-live-read-readiness:${row.latestEvalMergeQueueLiveReadAdapterContractReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-live-read-readiness:${row.latestEvalMergeQueueLiveReadAdapterContractReceipt?.id}` ? 'guarding' : 'live read readiness'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueCredentialHandoff(row)}
                      disabled={!row.latestEvalMergeQueueLiveReadReadinessReceipt || Boolean(row.latestEvalMergeQueueCredentialHandoffReceipt) || fixingId === `eval-merge-queue-credential-handoff:${row.latestEvalMergeQueueLiveReadReadinessReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-credential-handoff:${row.latestEvalMergeQueueLiveReadReadinessReceipt?.id}` ? 'handoff' : 'credential handoff'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueLiveReadPreflight(row)}
                      disabled={!row.latestEvalMergeQueueCredentialHandoffReceipt || Boolean(row.latestEvalMergeQueueLiveReadPreflightReceipt) || fixingId === `eval-merge-queue-live-read-preflight:${row.latestEvalMergeQueueCredentialHandoffReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-live-read-preflight:${row.latestEvalMergeQueueCredentialHandoffReceipt?.id}` ? 'preflighting' : 'live read preflight'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueTokenQuarantine(row)}
                      disabled={!row.latestEvalMergeQueueLiveReadPreflightReceipt || Boolean(row.latestEvalMergeQueueTokenQuarantineReceipt) || fixingId === `eval-merge-queue-token-quarantine:${row.latestEvalMergeQueueLiveReadPreflightReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-token-quarantine:${row.latestEvalMergeQueueLiveReadPreflightReceipt?.id}` ? 'quarantining' : 'token quarantine'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueLiveReadResponseIngestion(row)}
                      disabled={!row.latestEvalMergeQueueTokenQuarantineReceipt || Boolean(row.latestEvalMergeQueueLiveReadResponseIngestionReceipt) || fixingId === `eval-merge-queue-live-read-response:${row.latestEvalMergeQueueTokenQuarantineReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-live-read-response:${row.latestEvalMergeQueueTokenQuarantineReceipt?.id}` ? 'ingesting' : 'response evidence'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueRuntimeTokenReleaseGate(row)}
                      disabled={!row.latestEvalMergeQueueLiveReadResponseIngestionReceipt || Boolean(row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt) || fixingId === `eval-merge-queue-runtime-token-gate:${row.latestEvalMergeQueueLiveReadResponseIngestionReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-runtime-token-gate:${row.latestEvalMergeQueueLiveReadResponseIngestionReceipt?.id}` ? 'gating' : 'token release gate'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueLiveReadVerificationPromotion(row)}
                      disabled={!row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt || Boolean(row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt) || fixingId === `eval-merge-queue-live-read-promotion:${row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-live-read-promotion:${row.latestEvalMergeQueueRuntimeTokenReleaseGateReceipt?.id}` ? 'queueing' : 'live-read promotion'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueLiveHttpExecutionPreflightHandoff(row)}
                      disabled={!row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt || Boolean(row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt) || fixingId === `eval-merge-queue-live-http-preflight-handoff:${row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-live-http-preflight-handoff:${row.latestEvalMergeQueueLiveReadVerificationPromotionReceipt?.id}` ? 'handoff' : 'live HTTP handoff'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueLiveHttpOperatorReleaseAck(row)}
                      disabled={!row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt || Boolean(row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt) || fixingId === `eval-merge-queue-live-http-release-ack:${row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-live-http-release-ack:${row.latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt?.id}` ? 'acknowledging' : 'operator release ack'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueRuntimeSecretProviderSmokeReadiness(row)}
                      disabled={!row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt || Boolean(row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt) || fixingId === `eval-merge-queue-runtime-secret-smoke-readiness:${row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-runtime-secret-smoke-readiness:${row.latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt?.id}` ? 'recording' : 'secret smoke readiness'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueRuntimeSecretProviderSmokeExecutionGate(row)}
                      disabled={!row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt || Boolean(row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt) || fixingId === `eval-merge-queue-runtime-secret-smoke-execution-gate:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-runtime-secret-smoke-execution-gate:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt?.id}` ? 'gating' : 'secret smoke gate'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReview(row)}
                      disabled={!row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt || Boolean(row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt) || fixingId === `eval-merge-queue-runtime-secret-smoke-evidence-review:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-runtime-secret-smoke-evidence-review:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt?.id}` ? 'reviewing' : 'smoke evidence review'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflight(row)}
                      disabled={!row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt || Boolean(row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt) || fixingId === `eval-merge-queue-memory-only-runtime-token-preflight:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-memory-only-runtime-token-preflight:${row.latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt?.id}` ? 'preflighting' : 'memory token preflight'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueSuccessfulSmokeEvidenceIngestion(row)}
                      disabled={!row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt || Boolean(row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt) || fixingId === `eval-merge-queue-successful-smoke-evidence-ingestion:${row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-successful-smoke-evidence-ingestion:${row.latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt?.id}` ? 'rejecting' : 'reject smoke success'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueRuntimeTokenReleaseDenial(row)}
                      disabled={!row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt || Boolean(row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt) || fixingId === `eval-merge-queue-runtime-token-release-denial:${row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-runtime-token-release-denial:${row.latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt?.id}` ? 'denying' : 'deny token release'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueFakeLiveReadReplayQuarantine(row)}
                      disabled={!row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt || Boolean(row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt) || fixingId === `eval-merge-queue-fake-live-read-replay-quarantine:${row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-fake-live-read-replay-quarantine:${row.latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt?.id}` ? 'quarantining' : 'quarantine replay'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueFinalBlockerLedger(row)}
                      disabled={!row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt || Boolean(row.latestEvalMergeQueueFinalBlockerLedgerReceipt) || fixingId === `eval-merge-queue-final-blocker-ledger:${row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-final-blocker-ledger:${row.latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt?.id}` ? 'sealing' : 'seal blockers'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueuePostLedgerOperatorReleaseAttestation(row)}
                      disabled={!row.latestEvalMergeQueueFinalBlockerLedgerReceipt || Boolean(row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt) || fixingId === `eval-merge-queue-post-ledger-operator-release-attestation:${row.latestEvalMergeQueueFinalBlockerLedgerReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-post-ledger-operator-release-attestation:${row.latestEvalMergeQueueFinalBlockerLedgerReceipt?.id}` ? 'attesting' : 'attest release block'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueuePostAttestationReleaseEscrow(row)}
                      disabled={!row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt || Boolean(row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt) || fixingId === `eval-merge-queue-post-attestation-release-escrow:${row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-post-attestation-release-escrow:${row.latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt?.id}` ? 'holding' : 'hold escrow'}
                    </button>
                    <button
                      className="portfolio-mini-action"
                      type="button"
                      onClick={() => recordEvalMergeQueueReleaseDenialCloseout(row)}
                      disabled={!row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt || Boolean(row.latestEvalMergeQueueReleaseDenialCloseoutReceipt) || fixingId === `eval-merge-queue-release-denial-closeout:${row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt?.id}`}
                    >
                      {fixingId === `eval-merge-queue-release-denial-closeout:${row.latestEvalMergeQueuePostAttestationReleaseEscrowReceipt?.id}` ? 'sealing denial' : 'seal denial'}
                    </button>
                  </div>
                </div>
              </div>
            )) : <EmptyState label={loading ? 'Loading operator queues' : 'No operator queue rows'} />}
            {workflowReplayRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="operator workflow replay queue">
                <span>dead-letter replay</span>
                <strong>Workflow Replay</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{workflowReplayRows.length} replay receipt{workflowReplayRows.length === 1 ? '' : 's'} need operator visibility before live replay.</p>
                    <div className="portfolio-queue-meta" aria-label="workflow replay local status">
                      {workflowReplayRows.map((receipt) => (
                        <span key={`workflow-replay:${receipt.id}`}>
                          {formatLabel(receipt.workflow_key)} · {formatLabel(receipt.mode)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {workflowReplayRows.some((receipt) => receipt.response?.jobEnqueued === false)
                        ? <span>job enqueued false</span>
                        : null}
                      {workflowReplayRows.some((receipt) => receipt.response?.providerSafety?.deadLetterCaptured)
                        ? <span>source job dead letter</span>
                        : null}
                      {workflowReplayRows.some((receipt) => (receipt.response?.blockers || []).includes('operator_replay_approval'))
                        ? <span>operator replay approval</span>
                        : null}
                      {workflowReplayRows.some((receipt) => (receipt.response?.blockers || []).includes('live_adapter_implemented'))
                        ? <span>live adapter blocked</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalFixtureWorkRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval fixture work item queue">
                <span>local eval fixtures</span>
                <strong>Eval Fixture Work</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalFixtureWorkRows.length} fixture/harness work item{evalFixtureWorkRows.length === 1 ? '' : 's'} remain blocked before executable eval publication.</p>
                    <div className="portfolio-queue-meta" aria-label="eval fixture work local status">
                      {evalFixtureWorkRows.map((item) => (
                        <span key={`eval-fixture-work:${item.id}`}>
                          {formatLabel(item.work_kind)} · {formatLabel(item.status)}
                        </span>
                      ))}
                      {evalFixtureWorkRows.some((item) => item.response?.testFileWritten === false)
                        ? <span>test file written false</span>
                        : null}
                      {evalFixtureWorkRows.some((item) => item.response?.ciWorkflowMutated === false)
                        ? <span>CI mutation false</span>
                        : null}
                      {evalFixtureWorkRows.some((item) => item.response?.executableEvalPublished === false)
                        ? <span>executable eval blocked</span>
                        : null}
                      {evalFixtureWorkRows.some((item) => (item.response?.blockers || []).includes('eval_harness_binding'))
                        ? <span>eval harness binding</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalFixtureRunnerRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval fixture runner dry run queue">
                <span>runner dry-run</span>
                <strong>Eval Runner Dry Run</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalFixtureRunnerRows.length} runner dry-run receipt{evalFixtureRunnerRows.length === 1 ? '' : 's'} keep executable evals blocked until approval and non-live runner proof exist.</p>
                    <div className="portfolio-queue-meta" aria-label="eval fixture runner local status">
                      {evalFixtureRunnerRows.map((receipt) => (
                        <span key={`eval-fixture-runner:${receipt.id}`}>
                          {formatLabel(receipt.run_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalFixtureRunnerRows.some((receipt) => receipt.response?.harnessExecuted === false)
                        ? <span>harness executed false</span>
                        : null}
                      {evalFixtureRunnerRows.some((receipt) => receipt.response?.testFileWritten === false)
                        ? <span>test file written false</span>
                        : null}
                      {evalFixtureRunnerRows.some((receipt) => receipt.response?.ciWorkflowMutated === false)
                        ? <span>CI mutation false</span>
                        : null}
                      {evalFixtureRunnerRows.some((receipt) => receipt.response?.liveAdapterInvoked === false)
                        ? <span>live adapter invoked false</span>
                        : null}
                      {evalFixtureRunnerRows.some((receipt) => (receipt.response?.blockers || []).includes('operator_fixture_approval'))
                        ? <span>operator fixture approval</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalFixtureApprovalRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval fixture approval queue">
                <span>fixture approval</span>
                <strong>Eval Fixture Approval</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalFixtureApprovalRows.length} fixture approval receipt{evalFixtureApprovalRows.length === 1 ? '' : 's'} approve non-live fixture use while executable publication stays blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval fixture approval local status">
                      {evalFixtureApprovalRows.map((receipt) => (
                        <span key={`eval-fixture-approval:${receipt.id}`}>
                          {formatLabel(receipt.approval_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalFixtureApprovalRows.some((receipt) => receipt.response?.approvedForNonLiveRunner)
                        ? <span>approved non-live fixture</span>
                        : null}
                      {evalFixtureApprovalRows.some((receipt) => receipt.response?.executablePublicationAllowed === false)
                        ? <span>publication still blocked</span>
                        : null}
                      {evalFixtureApprovalRows.some((receipt) => receipt.response?.testFileWritten === false)
                        ? <span>test file written false</span>
                        : null}
                      {evalFixtureApprovalRows.some((receipt) => receipt.response?.ciWorkflowMutated === false)
                        ? <span>CI mutation false</span>
                        : null}
                      {evalFixtureApprovalRows.some((receipt) => receipt.response?.liveAdapterInvoked === false)
                        ? <span>live adapter invoked false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalGoldenFixtureReviewRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval golden fixture review queue">
                <span>golden fixture review</span>
                <strong>Eval Golden Fixture Review</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalGoldenFixtureReviewRows.length} golden fixture review receipt{evalGoldenFixtureReviewRows.length === 1 ? '' : 's'} accept local fixture evidence while executable publication stays blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval golden fixture review local status">
                      {evalGoldenFixtureReviewRows.map((receipt) => (
                        <span key={`eval-golden-fixture-review:${receipt.id}`}>
                          {formatLabel(receipt.review_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalGoldenFixtureReviewRows.some((receipt) => receipt.response?.goldenFixtureAccepted)
                        ? <span>golden fixture accepted</span>
                        : null}
                      {evalGoldenFixtureReviewRows.some((receipt) => receipt.response?.executablePublicationAllowed === false)
                        ? <span>publication still blocked</span>
                        : null}
                      {evalGoldenFixtureReviewRows.some((receipt) => receipt.response?.remainingBlockers?.includes('non_live_runner_binding'))
                        ? <span>non-live runner binding pending</span>
                        : null}
                      {evalGoldenFixtureReviewRows.some((receipt) => receipt.response?.remainingBlockers?.includes('executable_eval_file_review'))
                        ? <span>executable eval file review pending</span>
                        : null}
                      {evalGoldenFixtureReviewRows.some((receipt) => receipt.response?.ciWorkflowMutated === false)
                        ? <span>CI mutation false</span>
                        : null}
                      {evalGoldenFixtureReviewRows.some((receipt) => receipt.response?.liveAdapterInvoked === false)
                        ? <span>live adapter invoked false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalNonLiveRunnerBindingRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval non-live runner binding queue">
                <span>non-live runner binding</span>
                <strong>Eval Runner Binding</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalNonLiveRunnerBindingRows.length} non-live runner binding receipt{evalNonLiveRunnerBindingRows.length === 1 ? '' : 's'} bind accepted golden fixtures without executing commands or publishing evals.</p>
                    <div className="portfolio-queue-meta" aria-label="eval non-live runner binding local status">
                      {evalNonLiveRunnerBindingRows.map((receipt) => (
                        <span key={`eval-non-live-runner-binding:${receipt.id}`}>
                          {formatLabel(receipt.binding_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalNonLiveRunnerBindingRows.some((receipt) => receipt.response?.nonLiveRunnerBound)
                        ? <span>non-live runner bound</span>
                        : null}
                      {evalNonLiveRunnerBindingRows.some((receipt) => receipt.response?.runnerCommandExecuted === false)
                        ? <span>runner command executed false</span>
                        : null}
                      {evalNonLiveRunnerBindingRows.some((receipt) => receipt.response?.executablePublicationAllowed === false)
                        ? <span>publication still blocked</span>
                        : null}
                      {evalNonLiveRunnerBindingRows.some((receipt) => receipt.response?.remainingBlockers?.includes('executable_eval_file_review'))
                        ? <span>executable eval file review pending</span>
                        : null}
                      {evalNonLiveRunnerBindingRows.some((receipt) => receipt.response?.ciWorkflowMutated === false)
                        ? <span>CI mutation false</span>
                        : null}
                      {evalNonLiveRunnerBindingRows.some((receipt) => receipt.response?.liveAdapterInvoked === false)
                        ? <span>live adapter invoked false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalFileDryRunManifestRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval file dry run manifest queue">
                <span>eval file manifest reviewed</span>
                <strong>Eval File Manifest</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalFileDryRunManifestRows.length} eval file dry-run manifest{evalFileDryRunManifestRows.length === 1 ? '' : 's'} review executable file shape without writing files, running commands, or publishing evals.</p>
                    <div className="portfolio-queue-meta" aria-label="eval file dry run manifest local status">
                      {evalFileDryRunManifestRows.map((receipt) => (
                        <span key={`eval-file-dry-run-manifest:${receipt.id}`}>
                          {formatLabel(receipt.manifest_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalFileDryRunManifestRows.some((receipt) => receipt.response?.evalFileManifestReady)
                        ? <span>eval file manifest ready</span>
                        : null}
                      {evalFileDryRunManifestRows.some((receipt) => receipt.response?.evalFileWritten === false)
                        ? <span>eval file written false</span>
                        : null}
                      {evalFileDryRunManifestRows.some((receipt) => receipt.response?.runnerCommandExecuted === false)
                        ? <span>runner command executed false</span>
                        : null}
                      {evalFileDryRunManifestRows.some((receipt) => receipt.response?.executablePublicationAllowed === false)
                        ? <span>publication still blocked</span>
                        : null}
                      {evalFileDryRunManifestRows.some((receipt) => receipt.response?.remainingBlockers?.includes('ci_write_access'))
                        ? <span>CI write access pending</span>
                        : null}
                      {evalFileDryRunManifestRows.some((receipt) => receipt.response?.ciWorkflowMutated === false)
                        ? <span>CI mutation false</span>
                        : null}
                      {evalFileDryRunManifestRows.some((receipt) => receipt.response?.liveAdapterInvoked === false)
                        ? <span>live adapter invoked false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalCiWriteAccessRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval CI write access proof queue">
                <span>CI write access reviewed</span>
                <strong>Eval CI Write Proof</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalCiWriteAccessRows.length} CI write-access proof receipt{evalCiWriteAccessRows.length === 1 ? '' : 's'} review executable eval publication access without mutating workflow files.</p>
                    <div className="portfolio-queue-meta" aria-label="eval CI write access proof local status">
                      {evalCiWriteAccessRows.map((receipt) => (
                        <span key={`eval-ci-write-access:${receipt.id}`}>
                          {formatLabel(receipt.proof_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalCiWriteAccessRows.some((receipt) => receipt.response?.ciWriteAccessReviewed)
                        ? <span>CI write access reviewed</span>
                        : null}
                      {evalCiWriteAccessRows.some((receipt) => receipt.response?.ciWriteAccessGranted === false)
                        ? <span>CI write access blocked</span>
                        : null}
                      {evalCiWriteAccessRows.some((receipt) => receipt.response?.ciWorkflowMutated === false)
                        ? <span>CI workflow mutated false</span>
                        : null}
                      {evalCiWriteAccessRows.some((receipt) => receipt.response?.evalFileWritten === false)
                        ? <span>eval file written false</span>
                        : null}
                      {evalCiWriteAccessRows.some((receipt) => receipt.response?.executablePublicationAllowed === false)
                        ? <span>publication still blocked</span>
                        : null}
                      {evalCiWriteAccessRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_adapter_implemented'))
                        ? <span>live adapter pending</span>
                        : null}
                      {evalCiWriteAccessRows.some((receipt) => receipt.response?.liveAdapterInvoked === false)
                        ? <span>live adapter invoked false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalLiveAdapterReadinessRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval live adapter readiness queue">
                <span>live adapter readiness reviewed</span>
                <strong>Eval Live Adapter Proof</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalLiveAdapterReadinessRows.length} live-adapter readiness receipt{evalLiveAdapterReadinessRows.length === 1 ? '' : 's'} review adapter implementation proof without invoking live adapters.</p>
                    <div className="portfolio-queue-meta" aria-label="eval live adapter readiness local status">
                      {evalLiveAdapterReadinessRows.map((receipt) => (
                        <span key={`eval-live-adapter-readiness:${receipt.id}`}>
                          {formatLabel(receipt.readiness_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalLiveAdapterReadinessRows.some((receipt) => receipt.response?.liveAdapterReviewed)
                        ? <span>live adapter reviewed</span>
                        : null}
                      {evalLiveAdapterReadinessRows.some((receipt) => receipt.response?.liveAdapterImplemented === false)
                        ? <span>live adapter implemented false</span>
                        : null}
                      {evalLiveAdapterReadinessRows.some((receipt) => receipt.response?.liveAdapterInvoked === false)
                        ? <span>live adapter invoked false</span>
                        : null}
                      {evalLiveAdapterReadinessRows.some((receipt) => receipt.response?.runnerCommandExecuted === false)
                        ? <span>runner command executed false</span>
                        : null}
                      {evalLiveAdapterReadinessRows.some((receipt) => receipt.response?.executablePublicationAllowed === false)
                        ? <span>publication still blocked</span>
                        : null}
                      {evalLiveAdapterReadinessRows.some((receipt) => receipt.response?.remainingBlockers?.includes('ci_write_access'))
                        ? <span>CI write access still blocked</span>
                        : null}
                      {evalLiveAdapterReadinessRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_adapter_implemented'))
                        ? <span>live adapter still blocked</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalLiveAdapterContractTestRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval live adapter contract test queue">
                <span>live adapter contract tested</span>
                <strong>Eval Adapter Contract Test</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalLiveAdapterContractTestRows.length} live-adapter contract test receipt{evalLiveAdapterContractTestRows.length === 1 ? '' : 's'} exercise the in-process handoff adapter without provider calls or CI writes.</p>
                    <div className="portfolio-queue-meta" aria-label="eval live adapter contract test local status">
                      {evalLiveAdapterContractTestRows.map((receipt) => (
                        <span key={`eval-live-adapter-contract:${receipt.id}`}>
                          {formatLabel(receipt.contract_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalLiveAdapterContractTestRows.some((receipt) => receipt.response?.liveAdapterContractTested)
                        ? <span>adapter contract tested</span>
                        : null}
                      {evalLiveAdapterContractTestRows.some((receipt) => receipt.response?.liveAdapterImplemented === true)
                        ? <span>live adapter implemented true</span>
                        : null}
                      {evalLiveAdapterContractTestRows.some((receipt) => receipt.response?.contractTest?.passedCount >= 4)
                        ? <span>golden handoff fixtures passed</span>
                        : null}
                      {evalLiveAdapterContractTestRows.some((receipt) => receipt.response?.liveAdapterInvoked === false)
                        ? <span>live adapter invoked false</span>
                        : null}
                      {evalLiveAdapterContractTestRows.some((receipt) => receipt.response?.runnerCommandExecuted === false)
                        ? <span>runner command executed false</span>
                        : null}
                      {evalLiveAdapterContractTestRows.some((receipt) => receipt.response?.harnessExecuted === true)
                        ? <span>in-process harness executed</span>
                        : null}
                      {evalLiveAdapterContractTestRows.some((receipt) => receipt.response?.remainingBlockers?.includes('ci_write_access'))
                        ? <span>CI write access still blocked</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalCiWorkflowPublicationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval CI workflow publication queue">
                <span>CI workflow published local</span>
                <strong>Eval CI Workflow Publication</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalCiWorkflowPublicationRows.length} CI workflow publication receipt{evalCiWorkflowPublicationRows.length === 1 ? '' : 's'} prove local workflow and generated eval publication while external CI remains unobserved.</p>
                    <div className="portfolio-queue-meta" aria-label="eval CI workflow publication local status">
                      {evalCiWorkflowPublicationRows.map((receipt) => (
                        <span key={`eval-ci-workflow-publication:${receipt.id}`}>
                          {formatLabel(receipt.workflow_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalCiWorkflowPublicationRows.some((receipt) => receipt.response?.workflowFilePresent)
                        ? <span>workflow file present</span>
                        : null}
                      {evalCiWorkflowPublicationRows.some((receipt) => receipt.response?.evalArtifactPresent)
                        ? <span>generated eval present</span>
                        : null}
                      {evalCiWorkflowPublicationRows.some((receipt) => receipt.response?.localCiMirrorPresent)
                        ? <span>local CI mirror configured</span>
                        : null}
                      {evalCiWorkflowPublicationRows.some((receipt) => receipt.response?.localCiWriteAccessGranted)
                        ? <span>local CI write access true</span>
                        : null}
                      {evalCiWorkflowPublicationRows.some((receipt) => receipt.response?.externalCiRunObserved === false)
                        ? <span>external CI run false</span>
                        : null}
                      {evalCiWorkflowPublicationRows.some((receipt) => receipt.response?.liveSideEffects === false)
                        ? <span>live side effects false</span>
                        : null}
                      {evalCiWorkflowPublicationRows.some((receipt) => receipt.response?.remainingBlockers?.includes('external_ci_run'))
                        ? <span>external CI still blocked</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalGeneratedArtifactPromotionRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval generated artifact promotion queue">
                <span>generated eval promoted</span>
                <strong>Eval Artifact Promotion</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalGeneratedArtifactPromotionRows.length} promotion receipt{evalGeneratedArtifactPromotionRows.length === 1 ? '' : 's'} prove generated eval artifacts can move toward external CI review while merge remains blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval generated artifact promotion local status">
                      {evalGeneratedArtifactPromotionRows.map((receipt) => (
                        <span key={`eval-generated-artifact-promotion:${receipt.id}`}>
                          {formatLabel(receipt.promotion_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalGeneratedArtifactPromotionRows.some((receipt) => receipt.response?.generatedEvalPromotionReady)
                        ? <span>promotion ready</span>
                        : null}
                      {evalGeneratedArtifactPromotionRows.some((receipt) => (
                        receipt.response?.workflowHashMatches &&
                        receipt.response?.generatedEvalHashMatches &&
                        receipt.response?.packageHashMatches
                      ))
                        ? <span>hashes matched</span>
                        : null}
                      {evalGeneratedArtifactPromotionRows.some((receipt) => receipt.response?.externalCiResultIngested === false)
                        ? <span>external CI result false</span>
                        : null}
                      {evalGeneratedArtifactPromotionRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge blocked</span>
                        : null}
                      {evalGeneratedArtifactPromotionRows.some((receipt) => receipt.response?.liveSideEffects === false)
                        ? <span>live side effects false</span>
                        : null}
                      {evalGeneratedArtifactPromotionRows.some((receipt) => receipt.response?.remainingBlockers?.includes('operator_merge_approval'))
                        ? <span>operator merge approval pending</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalPrMergeProposalRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval PR merge proposal queue">
                <span>PR merge proposal gated</span>
                <strong>Eval PR Merge Proposal</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalPrMergeProposalRows.length} PR merge proposal gate{evalPrMergeProposalRows.length === 1 ? '' : 's'} prepare local review packets while PR opening and merge stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval PR merge proposal local status">
                      {evalPrMergeProposalRows.map((receipt) => (
                        <span key={`eval-pr-merge-proposal:${receipt.id}`}>
                          {formatLabel(receipt.proposal_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalPrMergeProposalRows.some((receipt) => receipt.response?.safePrProposalPrepared)
                        ? <span>PR proposal prepared</span>
                        : null}
                      {evalPrMergeProposalRows.some((receipt) => receipt.response?.pullRequestOpened === false)
                        ? <span>pull request opened false</span>
                        : null}
                      {evalPrMergeProposalRows.some((receipt) => receipt.response?.externalCiResultRequired)
                        ? <span>external CI result required</span>
                        : null}
                      {evalPrMergeProposalRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge blocked</span>
                        : null}
                      {evalPrMergeProposalRows.some((receipt) => receipt.response?.liveSideEffects === false)
                        ? <span>live side effects false</span>
                        : null}
                      {evalPrMergeProposalRows.some((receipt) => receipt.response?.remainingBlockers?.includes('operator_merge_approval'))
                        ? <span>operator merge approval pending</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalPrOpenSimulationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval PR open simulation queue">
                <span>PR open simulated locally</span>
                <strong>Eval PR Open Simulation</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalPrOpenSimulationRows.length} PR open simulation receipt{evalPrOpenSimulationRows.length === 1 ? '' : 's'} prepare pull-request payloads while GitHub submission and merge stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval PR open simulation local status">
                      {evalPrOpenSimulationRows.map((receipt) => (
                        <span key={`eval-pr-open-simulation:${receipt.id}`}>
                          {formatLabel(receipt.simulation_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalPrOpenSimulationRows.some((receipt) => receipt.response?.prOpenSimulationComplete)
                        ? <span>PR open simulation complete</span>
                        : null}
                      {evalPrOpenSimulationRows.some((receipt) => receipt.response?.pullRequestSubmitted === false)
                        ? <span>pull request not submitted</span>
                        : null}
                      {evalPrOpenSimulationRows.some((receipt) => receipt.response?.externalCiResultRequired)
                        ? <span>external CI result required</span>
                        : null}
                      {evalPrOpenSimulationRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge blocked</span>
                        : null}
                      {evalPrOpenSimulationRows.some((receipt) => receipt.response?.liveSideEffects === false)
                        ? <span>live side effects false</span>
                        : null}
                      {evalPrOpenSimulationRows.some((receipt) => receipt.response?.remainingBlockers?.includes('pull_request_submission'))
                        ? <span>pull request submission blocked</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalOperatorMergeApprovalRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval operator merge approval queue">
                <span>operator merge approval reviewed</span>
                <strong>Eval Merge Approval Review</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalOperatorMergeApprovalRows.length} merge approval review receipt{evalOperatorMergeApprovalRows.length === 1 ? '' : 's'} keep merge blocked until a submitted PR and passing external CI result exist.</p>
                    <div className="portfolio-queue-meta" aria-label="eval operator merge approval local status">
                      {evalOperatorMergeApprovalRows.map((receipt) => (
                        <span key={`eval-operator-merge-approval:${receipt.id}`}>
                          {formatLabel(receipt.approval_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalOperatorMergeApprovalRows.some((receipt) => receipt.response?.operatorMergeApprovalReviewed)
                        ? <span>operator merge approval blocked</span>
                        : null}
                      {evalOperatorMergeApprovalRows.some((receipt) => receipt.response?.operatorMergeApproved === false)
                        ? <span>operator merge approved false</span>
                        : null}
                      {evalOperatorMergeApprovalRows.some((receipt) => receipt.response?.pullRequestSubmitted === false)
                        ? <span>pull request submitted false</span>
                        : null}
                      {evalOperatorMergeApprovalRows.some((receipt) => receipt.response?.externalCiResultRequired)
                        ? <span>external CI result required</span>
                        : null}
                      {evalOperatorMergeApprovalRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge allowed false</span>
                        : null}
                      {evalOperatorMergeApprovalRows.some((receipt) => receipt.response?.liveSideEffects === false)
                        ? <span>live side effects false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalSubmittedPrEvidenceRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval submitted PR evidence queue">
                <span>submitted PR evidence recorded</span>
                <strong>Eval Submitted PR Evidence</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalSubmittedPrEvidenceRows.length} submitted PR evidence receipt{evalSubmittedPrEvidenceRows.length === 1 ? '' : 's'} record operator-provided PR proof while external CI, merge approval, and merge remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval submitted PR evidence local status">
                      {evalSubmittedPrEvidenceRows.map((receipt) => (
                        <span key={`eval-submitted-pr-evidence:${receipt.id}`}>
                          {formatLabel(receipt.evidence_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalSubmittedPrEvidenceRows.some((receipt) => receipt.response?.submittedPrEvidenceReviewed)
                        ? <span>submitted PR evidence reviewed</span>
                        : null}
                      {evalSubmittedPrEvidenceRows.some((receipt) => receipt.response?.pullRequestSubmittedEvidencePresent)
                        ? <span>pull request evidence present</span>
                        : null}
                      {evalSubmittedPrEvidenceRows.some((receipt) => receipt.response?.pullRequestExternallyVerified === false)
                        ? <span>pull request verified false</span>
                        : null}
                      {evalSubmittedPrEvidenceRows.some((receipt) => receipt.response?.externalCiResultIngested === false)
                        ? <span>external CI result false</span>
                        : null}
                      {evalSubmittedPrEvidenceRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge allowed false</span>
                        : null}
                      {evalSubmittedPrEvidenceRows.some((receipt) => receipt.response?.liveSideEffects === false)
                        ? <span>live side effects false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalPrExternalVerificationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval PR external verification queue">
                <span>PR external verification reconciled</span>
                <strong>Eval PR External Verification</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalPrExternalVerificationRows.length} PR verification reconciliation receipt{evalPrExternalVerificationRows.length === 1 ? '' : 's'} review submitted PR proof while GitHub API calls, external CI, merge approval, and merge remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval PR external verification local status">
                      {evalPrExternalVerificationRows.map((receipt) => (
                        <span key={`eval-pr-external-verification:${receipt.id}`}>
                          {formatLabel(receipt.verification_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalPrExternalVerificationRows.some((receipt) => receipt.response?.prExternalVerificationReviewed)
                        ? <span>PR external verification reviewed</span>
                        : null}
                      {evalPrExternalVerificationRows.some((receipt) => receipt.response?.pullRequestUrlFormatValid)
                        ? <span>pull request URL valid</span>
                        : null}
                      {evalPrExternalVerificationRows.some((receipt) => receipt.response?.githubApiCalled === false)
                        ? <span>github API called false</span>
                        : null}
                      {evalPrExternalVerificationRows.some((receipt) => receipt.response?.pullRequestExternallyVerified === false)
                        ? <span>pull request externally verified false</span>
                        : null}
                      {evalPrExternalVerificationRows.some((receipt) => receipt.response?.externalCiResultIngested === false)
                        ? <span>external CI result false</span>
                        : null}
                      {evalPrExternalVerificationRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge allowed false</span>
                        : null}
                      {evalPrExternalVerificationRows.some((receipt) => receipt.response?.liveSideEffects === false)
                        ? <span>live side effects false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalExternalCiResultRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval external CI result queue">
                <span>external CI result ingested</span>
                <strong>Eval External CI Result</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalExternalCiResultRows.length} external CI result receipt{evalExternalCiResultRows.length === 1 ? '' : 's'} ingest operator-provided CI evidence while GitHub API calls, PR verification, merge approval, and merge remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval external CI result local status">
                      {evalExternalCiResultRows.map((receipt) => (
                        <span key={`eval-external-ci-result:${receipt.id}`}>
                          {formatLabel(receipt.result_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalExternalCiResultRows.some((receipt) => receipt.response?.externalCiResultReviewed)
                        ? <span>external CI result reviewed</span>
                        : null}
                      {evalExternalCiResultRows.some((receipt) => receipt.response?.externalCiPassed)
                        ? <span>external CI passed</span>
                        : null}
                      {evalExternalCiResultRows.some((receipt) => receipt.response?.githubApiCalled === false)
                        ? <span>github API called false</span>
                        : null}
                      {evalExternalCiResultRows.some((receipt) => receipt.response?.ciRunnerExecuted === false)
                        ? <span>CI runner executed false</span>
                        : null}
                      {evalExternalCiResultRows.some((receipt) => receipt.response?.externalCiResultVerifiedByApp === false)
                        ? <span>external CI verified by app false</span>
                        : null}
                      {evalExternalCiResultRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge allowed false</span>
                        : null}
                      {evalExternalCiResultRows.some((receipt) => receipt.response?.liveSideEffects === false)
                        ? <span>live side effects false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalGithubPrVerificationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval GitHub PR verification queue">
                <span>GitHub PR verification preflighted</span>
                <strong>Eval GitHub PR Verification</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalGithubPrVerificationRows.length} GitHub PR verification preflight receipt{evalGithubPrVerificationRows.length === 1 ? '' : 's'} prepare the GitHub API observation boundary while API calls, PR mutation, operator approval, and merge remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval GitHub PR verification local status">
                      {evalGithubPrVerificationRows.map((receipt) => (
                        <span key={`eval-github-pr-verification:${receipt.id}`}>
                          {formatLabel(receipt.verification_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalGithubPrVerificationRows.some((receipt) => receipt.response?.githubPrVerificationReviewed)
                        ? <span>GitHub PR verification reviewed</span>
                        : null}
                      {evalGithubPrVerificationRows.some((receipt) => receipt.response?.githubPrVerificationPreflightReady)
                        ? <span>GitHub API preflight ready</span>
                        : null}
                      {evalGithubPrVerificationRows.some((receipt) => receipt.response?.githubApiObservationRequired)
                        ? <span>GitHub API observation required</span>
                        : null}
                      {evalGithubPrVerificationRows.some((receipt) => receipt.response?.githubApiObservationPresent === false)
                        ? <span>GitHub API observation false</span>
                        : null}
                      {evalGithubPrVerificationRows.some((receipt) => receipt.response?.githubApiCalled === false)
                        ? <span>github API called false</span>
                        : null}
                      {evalGithubPrVerificationRows.some((receipt) => receipt.response?.pullRequestExternallyVerified === false)
                        ? <span>pull request externally verified false</span>
                        : null}
                      {evalGithubPrVerificationRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge allowed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalGithubPrObservationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval GitHub PR observation queue">
                <span>GitHub PR observation contracted</span>
                <strong>Eval GitHub PR Observation</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalGithubPrObservationRows.length} GitHub PR observation adapter contract receipt{evalGithubPrObservationRows.length === 1 ? '' : 's'} prove fixture parsing while live GitHub API reads, PR mutation, operator approval, and merge remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval GitHub PR observation local status">
                      {evalGithubPrObservationRows.map((receipt) => (
                        <span key={`eval-github-pr-observation:${receipt.id}`}>
                          {formatLabel(receipt.observation_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalGithubPrObservationRows.some((receipt) => receipt.response?.githubPrObservationContractTested)
                        ? <span>GitHub PR observation contract tested</span>
                        : null}
                      {evalGithubPrObservationRows.some((receipt) => receipt.response?.githubPrObservationAdapterReady)
                        ? <span>GitHub PR adapter ready</span>
                        : null}
                      {evalGithubPrObservationRows.some((receipt) => receipt.response?.fixturePullRequestObserved)
                        ? <span>fixture PR observed</span>
                        : null}
                      {evalGithubPrObservationRows.some((receipt) => receipt.response?.githubApiObservationPresent === false)
                        ? <span>GitHub API observation false</span>
                        : null}
                      {evalGithubPrObservationRows.some((receipt) => receipt.response?.githubApiCalled === false)
                        ? <span>github API called false</span>
                        : null}
                      {evalGithubPrObservationRows.some((receipt) => receipt.response?.liveGithubObservation === false)
                        ? <span>live GitHub observation false</span>
                        : null}
                      {evalGithubPrObservationRows.some((receipt) => receipt.response?.pullRequestExternallyVerified === false)
                        ? <span>pull request externally verified false</span>
                        : null}
                      {evalGithubPrObservationRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge allowed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalGithubCheckRunObservationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval GitHub check-run observation queue">
                <span>GitHub check-runs observed</span>
                <strong>Eval GitHub Check Runs</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalGithubCheckRunObservationRows.length} GitHub check-run observation receipt{evalGithubCheckRunObservationRows.length === 1 ? '' : 's'} record read-only CI status while operator approval, PR mutation, and merge remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval GitHub check-run observation local status">
                      {evalGithubCheckRunObservationRows.map((receipt) => (
                        <span key={`eval-github-check-run-observation:${receipt.id}`}>
                          {formatLabel(receipt.observation_mode)} · {formatLabel(receipt.check_run_conclusion)}
                        </span>
                      ))}
                      {evalGithubCheckRunObservationRows.some((receipt) => receipt.response?.githubCheckRunObservationRecorded)
                        ? <span>GitHub check-run observation recorded</span>
                        : null}
                      {evalGithubCheckRunObservationRows.some((receipt) => receipt.response?.sandboxFixtureObserved)
                        ? <span>sandbox fixture observed</span>
                        : null}
                      {evalGithubCheckRunObservationRows.some((receipt) => receipt.response?.checkRunConclusion === 'success')
                        ? <span>check-run conclusion success</span>
                        : null}
                      {evalGithubCheckRunObservationRows.some((receipt) => receipt.response?.githubApiObservationPresent === false)
                        ? <span>GitHub API observation false</span>
                        : null}
                      {evalGithubCheckRunObservationRows.some((receipt) => receipt.response?.githubApiCalled === false)
                        ? <span>github API called false</span>
                        : null}
                      {evalGithubCheckRunObservationRows.some((receipt) => receipt.response?.liveGithubObservation === false)
                        ? <span>live GitHub observation false</span>
                        : null}
                      {evalGithubCheckRunObservationRows.some((receipt) => receipt.response?.pullRequestExternallyVerified === false)
                        ? <span>pull request externally verified false</span>
                        : null}
                      {evalGithubCheckRunObservationRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge allowed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeExecutionAdapterContractRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge execution adapter contract queue">
                <span>merge adapter contract reviewed</span>
                <strong>Eval Merge Execution Adapter Contract</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeExecutionAdapterContractRows.length} merge execution adapter contract receipt{evalMergeExecutionAdapterContractRows.length === 1 ? '' : 's'} prove the merge adapter shape without GitHub mutation, live merge execution, or customer side effects.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge execution adapter contract local status">
                      {evalMergeExecutionAdapterContractRows.map((receipt) => (
                        <span key={`eval-merge-execution-adapter-contract:${receipt.id}`}>
                          {formatLabel(receipt.contract_kind)} · {formatLabel(receipt.contract_mode)}
                        </span>
                      ))}
                      {evalMergeExecutionAdapterContractRows.some((receipt) => receipt.response?.mergeExecutionAdapterContractObserved)
                        ? <span>merge execution adapter contract observed</span>
                        : null}
                      {evalMergeExecutionAdapterContractRows.some((receipt) => receipt.response?.mergeExecutionAdapterReady === false)
                        ? <span>merge execution adapter ready false</span>
                        : null}
                      {evalMergeExecutionAdapterContractRows.some((receipt) => receipt.response?.adapterMutationAttempted === false)
                        ? <span>adapter mutation attempted false</span>
                        : null}
                      {evalMergeExecutionAdapterContractRows.some((receipt) => receipt.response?.githubMutation === false)
                        ? <span>github mutation false</span>
                        : null}
                      {evalMergeExecutionAdapterContractRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>merge executed false</span>
                        : null}
                      {evalMergeExecutionAdapterContractRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_merge_execution_attempt'))
                        ? <span>live merge execution attempt blocked</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalOperatorMergeCompletionGateRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval operator merge completion gate queue">
                <span>merge completion gate reviewed</span>
                <strong>Eval Merge Completion Gate</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalOperatorMergeCompletionGateRows.length} operator merge completion gate receipt{evalOperatorMergeCompletionGateRows.length === 1 ? '' : 's'} block merge completion until live GitHub proof, explicit operator approval, and a merge execution adapter exist.</p>
                    <div className="portfolio-queue-meta" aria-label="eval operator merge completion gate local status">
                      {evalOperatorMergeCompletionGateRows.map((receipt) => (
                        <span key={`eval-operator-merge-completion-gate:${receipt.id}`}>
                          {formatLabel(receipt.gate_kind)} · {formatLabel(receipt.decision)}
                        </span>
                      ))}
                      {evalOperatorMergeCompletionGateRows.some((receipt) => receipt.response?.operatorMergeCompletionGateReviewed)
                        ? <span>merge completion gate reviewed</span>
                        : null}
                      {evalOperatorMergeCompletionGateRows.some((receipt) => receipt.response?.sandboxCheckRunEvidenceRejected)
                        ? <span>sandbox check-run evidence rejected</span>
                        : null}
                      {evalOperatorMergeCompletionGateRows.some((receipt) => receipt.response?.operatorMergeCompletionBlocked)
                        ? <span>operator merge completion blocked</span>
                        : null}
                      {evalOperatorMergeCompletionGateRows.some((receipt) => receipt.response?.operatorMergeApproved === false)
                        ? <span>operator merge approved false</span>
                        : null}
                      {evalOperatorMergeCompletionGateRows.some((receipt) => receipt.response?.mergeExecutionAdapterReady === false)
                        ? <span>merge execution adapter missing</span>
                        : null}
                      {evalOperatorMergeCompletionGateRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>merge allowed false</span>
                        : null}
                      {evalOperatorMergeCompletionGateRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalLiveMergeAuthorizationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval live merge authorization queue">
                <span>live merge authorization reviewed</span>
                <strong>Eval Live Merge Authorization</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalLiveMergeAuthorizationRows.length} live merge authorization receipt{evalLiveMergeAuthorizationRows.length === 1 ? '' : 's'} keep real-token authorization, branch protection proof, GitHub mutation, and live merge execution blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval live merge authorization local status">
                      {evalLiveMergeAuthorizationRows.map((receipt) => (
                        <span key={`eval-live-merge-authorization:${receipt.id}`}>
                          {formatLabel(receipt.authorization_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.liveMergeAuthorizationRecorded)
                        ? <span>live merge authorization recorded</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.realTokenAuthorizationPresent === false)
                        ? <span>real token authorization false</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.realTokenProof?.tokenStored === false)
                        ? <span>real token stored false</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.requiredGithubTokenScopes?.includes('contents:write'))
                        ? <span>GitHub token scope contents write required</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.tokenScopeProofRecorded)
                        ? <span>Token scope proof: declared, 0/N scopes observed</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.tokenScopeProof?.requiredScopes?.length)
                        ? <span>Required token scopes (declared)</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.branchProtectionReview?.policySource === 'local_policy_template')
                        ? <span>branch protection policy template</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.branchProtectionProofRecorded)
                        ? <span>Branch protection proof: declared (not read back)</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.branchProtectionReadbackAdapterContractObserved)
                        ? <span>Branch protection readback contract: passed (read-only)</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.branchProtectionProof?.requiredStatusChecks?.length)
                        ? <span>Required status checks (declared)</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.branchProtectionProof?.requiredApprovingReviewCount)
                        ? <span>Required approving reviews (declared)</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.branchProtectionProof?.observedLocally === false || receipt.response?.tokenScopeProof?.tokenScopeObservationSource === 'local_declaration_only')
                        ? <span>No - local declaration only</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.remainingBlockers?.includes('branch_protection_readback') && receipt.response?.remainingBlockers?.includes('live_token_scope_observation'))
                        ? <span>Live merge blocked - branch protection readback and live token scope observation still required</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.branchProtectionReview?.requiredStatusChecks?.includes('check:maygoals'))
                        ? <span>required status checks unverified</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.branchProtectionVerified === false)
                        ? <span>branch protection verified false</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.mergeExecutionAuthorized === false)
                        ? <span>merge execution authorized false</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.githubMutation === false)
                        ? <span>github mutation false</span>
                        : null}
                      {evalLiveMergeAuthorizationRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalBranchProtectionReadbackAdapterContractRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval branch protection readback adapter contract queue">
                <span>branch protection readback contract reviewed</span>
                <strong>Eval Branch Protection Readback Adapter Contract</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalBranchProtectionReadbackAdapterContractRows.length} branch-protection readback adapter contract receipt{evalBranchProtectionReadbackAdapterContractRows.length === 1 ? '' : 's'} prove the read shape without live GitHub API calls, branch-protection mutation, merge execution, or customer side effects.</p>
                    <div className="portfolio-queue-meta" aria-label="eval branch protection readback adapter contract local status">
                      {evalBranchProtectionReadbackAdapterContractRows.map((receipt) => (
                        <span key={`eval-branch-protection-readback:${receipt.id}`}>
                          {formatLabel(receipt.contract_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.branchProtectionReadbackAdapterContractObserved)
                        ? <span>Adapter contract observed</span>
                        : null}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.adapterMutationAttempted === false)
                        ? <span>Adapter mutation false</span>
                        : null}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.branchProtectionMutated === false)
                        ? <span>Branch protection mutated false</span>
                        : null}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.requiredStatusChecksContractShape?.includes('check:maygoals'))
                        ? <span>Required status checks contract shape</span>
                        : null}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.tokenScopeContractShape?.tokenScopeObservationSource === 'local_contract_shape')
                        ? <span>Token scope observation local contract shape</span>
                        : null}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_token_scope_observation'))
                        ? <span>Live token scope observation still required</span>
                        : null}
                      {evalBranchProtectionReadbackAdapterContractRows.some((receipt) => receipt.response?.branchProtectionReadbackLiveVerified === false)
                        ? <span>Branch protection live read false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalTokenScopeObservationAdapterContractRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval token scope observation adapter contract queue">
                <span>token scope observation contract reviewed</span>
                <strong>Eval Token Scope Observation Adapter Contract</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalTokenScopeObservationAdapterContractRows.length} token-scope observation adapter contract receipt{evalTokenScopeObservationAdapterContractRows.length === 1 ? '' : 's'} prove the token readback shape without reading, storing, or exposing a live token.</p>
                    <div className="portfolio-queue-meta" aria-label="eval token scope observation adapter contract local status">
                      {evalTokenScopeObservationAdapterContractRows.map((receipt) => (
                        <span key={`eval-token-scope-observation:${receipt.id}`}>
                          {formatLabel(receipt.contract_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalTokenScopeObservationAdapterContractRows.some((receipt) => receipt.response?.tokenScopeObservationAdapterContractObserved)
                        ? <span>Token scope adapter contract observed</span>
                        : null}
                      {evalTokenScopeObservationAdapterContractRows.some((receipt) => receipt.response?.tokenPresenceObserved === false)
                        ? <span>Token presence observed false</span>
                        : null}
                      {evalTokenScopeObservationAdapterContractRows.some((receipt) => receipt.response?.tokenValuePersisted === false)
                        ? <span>Token value persisted false</span>
                        : null}
                      {evalTokenScopeObservationAdapterContractRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalTokenScopeObservationAdapterContractRows.some((receipt) => receipt.response?.tokenScopeMutated === false)
                        ? <span>Token scope mutated false</span>
                        : null}
                      {evalTokenScopeObservationAdapterContractRows.some((receipt) => receipt.response?.missingScopes?.includes('contents:write'))
                        ? <span>Required token scopes contract shape</span>
                        : null}
                      {evalTokenScopeObservationAdapterContractRows.some((receipt) => receipt.response?.remainingBlockers?.includes('real_token_merge_authorization'))
                        ? <span>Real token merge authorization still required</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalSecretRedactionProofRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval secret redaction proof queue">
                <span>secret redaction proof recorded</span>
                <strong>Eval Secret Redaction Proof</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalSecretRedactionProofRows.length} secret redaction proof receipt{evalSecretRedactionProofRows.length === 1 ? '' : 's'} prove synthetic GitHub, Stripe, and webhook secrets were replaced before durable receipt, snapshot, export, or UI evidence.</p>
                    <div className="portfolio-queue-meta" aria-label="eval secret redaction proof local status">
                      {evalSecretRedactionProofRows.map((receipt) => (
                        <span key={`eval-secret-redaction:${receipt.id}`}>
                          {formatLabel(receipt.proof_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalSecretRedactionProofRows.some((receipt) => receipt.response?.secretRedactionProofRecorded)
                        ? <span>Secret redaction proof recorded</span>
                        : null}
                      {evalSecretRedactionProofRows.some((receipt) => receipt.response?.redactionVerified)
                        ? <span>Redaction verified</span>
                        : null}
                      {evalSecretRedactionProofRows.some((receipt) => receipt.response?.rawSecretPersisted === false)
                        ? <span>Raw secret persisted false</span>
                        : null}
                      {evalSecretRedactionProofRows.some((receipt) => receipt.response?.tokenValuePersisted === false)
                        ? <span>Token value persisted false</span>
                        : null}
                      {evalSecretRedactionProofRows.some((receipt) => receipt.response?.secretKinds?.includes('github_classic_token') || receipt.response?.secretKinds?.includes('github_fine_grained_token'))
                        ? <span>GitHub tokens redacted</span>
                        : null}
                      {evalSecretRedactionProofRows.some((receipt) => receipt.response?.secretKinds?.includes('stripe_live_secret'))
                        ? <span>Stripe live secret redacted</span>
                        : null}
                      {evalSecretRedactionProofRows.some((receipt) => receipt.response?.snapshotExportSecretScan?.rawTokenPatternFound === false)
                        ? <span>Snapshot export secret scan passed</span>
                        : null}
                      {evalSecretRedactionProofRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueReadbackAdapterContractRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue readback adapter contract queue">
                <span>merge queue readback contract reviewed</span>
                <strong>Eval Merge Queue Readback Adapter Contract</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueReadbackAdapterContractRows.length} merge queue readback contract receipt{evalMergeQueueReadbackAdapterContractRows.length === 1 ? '' : 's'} freeze the local merge queue ruleset shape without reading GitHub live or enabling merge execution.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue readback local status">
                      {evalMergeQueueReadbackAdapterContractRows.map((receipt) => (
                        <span key={`eval-merge-queue-readback:${receipt.id}`}>
                          {formatLabel(receipt.contract_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueReadbackAdapterContractRows.some((receipt) => receipt.response?.mergeQueueReadbackAdapterContractObserved)
                        ? <span>Merge queue adapter contract observed</span>
                        : null}
                      {evalMergeQueueReadbackAdapterContractRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalMergeQueueReadbackAdapterContractRows.some((receipt) => receipt.response?.mergeQueueMutated === false)
                        ? <span>Merge queue mutated false</span>
                        : null}
                      {evalMergeQueueReadbackAdapterContractRows.some((receipt) => receipt.response?.mergeQueueLiveVerified === false)
                        ? <span>Merge queue live verified false</span>
                        : null}
                      {evalMergeQueueReadbackAdapterContractRows.some((receipt) => receipt.response?.requiredStatusChecksContractShape?.includes('check:maygoals'))
                        ? <span>Required status checks merge queue shape</span>
                        : null}
                      {evalMergeQueueReadbackAdapterContractRows.some((receipt) => receipt.response?.mergeQueueContractShape?.source === 'local_ruleset_contract_shape')
                        ? <span>Rulesets API contract shape</span>
                        : null}
                      {evalMergeQueueReadbackAdapterContractRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_merge_queue_readback'))
                        ? <span>Live merge queue readback still required</span>
                        : null}
                      {evalMergeQueueReadbackAdapterContractRows.some((receipt) => receipt.response?.remainingBlockers?.includes('real_token_merge_authorization'))
                        ? <span>Real token merge authorization still required</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueLiveReadReconciliationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue live read reconciliation queue">
                <span>merge queue live read reconciled</span>
                <strong>Eval Merge Queue Live Read Reconciliation</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueLiveReadReconciliationRows.length} merge queue live-read reconciliation receipt{evalMergeQueueLiveReadReconciliationRows.length === 1 ? '' : 's'} keep the local readback useful while real-token live GitHub reads and merge execution stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue live read reconciliation status">
                      {evalMergeQueueLiveReadReconciliationRows.map((receipt) => (
                        <span key={`eval-merge-queue-live-read:${receipt.id}`}>
                          {formatLabel(receipt.reconciliation_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueLiveReadReconciliationRows.some((receipt) => receipt.response?.mergeQueueLiveReadReconciled)
                        ? <span>Merge queue live read reconciled</span>
                        : null}
                      {evalMergeQueueLiveReadReconciliationRows.some((receipt) => receipt.response?.realTokenObserved === false)
                        ? <span>Real token observed false</span>
                        : null}
                      {evalMergeQueueLiveReadReconciliationRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalMergeQueueLiveReadReconciliationRows.some((receipt) => receipt.response?.liveReadSucceeded === false)
                        ? <span>Live read succeeded false</span>
                        : null}
                      {evalMergeQueueLiveReadReconciliationRows.some((receipt) => receipt.response?.mergeQueueLiveVerified === false)
                        ? <span>Merge queue live verified false</span>
                        : null}
                      {evalMergeQueueLiveReadReconciliationRows.some((receipt) => receipt.response?.mergeQueueLiveReadAttempted === false)
                        ? <span>Merge queue live read attempted false</span>
                        : null}
                      {evalMergeQueueLiveReadReconciliationRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_merge_queue_readback'))
                        ? <span>Live merge queue readback still required</span>
                        : null}
                      {evalMergeQueueLiveReadReconciliationRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_merge_execution_attempt'))
                        ? <span>Live merge execution still blocked</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueLiveReadAdapterContractRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue live read adapter contract queue">
                <span>merge queue live read adapter contracted</span>
                <strong>Eval Merge Queue Live Read Adapter Contract</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueLiveReadAdapterContractRows.length} merge queue live-read adapter contract receipt{evalMergeQueueLiveReadAdapterContractRows.length === 1 ? '' : 's'} define the future GitHub readback boundary while token reads, API calls, live verification, and merges stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue live read adapter contract status">
                      {evalMergeQueueLiveReadAdapterContractRows.map((receipt) => (
                        <span key={`eval-merge-queue-live-read-adapter:${receipt.id}`}>
                          {formatLabel(receipt.contract_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueLiveReadAdapterContractRows.some((receipt) => receipt.response?.liveReadAdapterContractObserved)
                        ? <span>Live read adapter contract observed</span>
                        : null}
                      {evalMergeQueueLiveReadAdapterContractRows.some((receipt) => receipt.response?.requiredTokenScopesContractShape?.includes('administration:read'))
                        ? <span>Required token scopes declared</span>
                        : null}
                      {evalMergeQueueLiveReadAdapterContractRows.some((receipt) => receipt.response?.readbackContractShape?.method === 'GET')
                        ? <span>Rulesets readback GET contract</span>
                        : null}
                      {evalMergeQueueLiveReadAdapterContractRows.some((receipt) => receipt.response?.realTokenObserved === false)
                        ? <span>Real token observed false</span>
                        : null}
                      {evalMergeQueueLiveReadAdapterContractRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalMergeQueueLiveReadAdapterContractRows.some((receipt) => receipt.response?.liveReadSucceeded === false)
                        ? <span>Live read succeeded false</span>
                        : null}
                      {evalMergeQueueLiveReadAdapterContractRows.some((receipt) => receipt.response?.mergeQueueLiveVerified === false)
                        ? <span>Merge queue live verified false</span>
                        : null}
                      {evalMergeQueueLiveReadAdapterContractRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_merge_queue_readback'))
                        ? <span>Live merge queue readback still required</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueLiveReadReadinessRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue live read readiness queue">
                <span>merge queue live read readiness guarded</span>
                <strong>Eval Merge Queue Live Read Readiness</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueLiveReadReadinessRows.length} merge queue live-read readiness receipt{evalMergeQueueLiveReadReadinessRows.length === 1 ? '' : 's'} declare credential and approval prerequisites while token values, GitHub reads, live verification, and merges stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue live read readiness status">
                      {evalMergeQueueLiveReadReadinessRows.map((receipt) => (
                        <span key={`eval-merge-queue-live-read-readiness:${receipt.id}`}>
                          {formatLabel(receipt.readiness_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueLiveReadReadinessRows.some((receipt) => receipt.response?.adapterContractObserved)
                        ? <span>Adapter contract observed</span>
                        : null}
                      {evalMergeQueueLiveReadReadinessRows.some((receipt) => receipt.response?.requiredSecretRefs?.includes('github_merge_queue_read_token'))
                        ? <span>Credential secret ref declared</span>
                        : null}
                      {evalMergeQueueLiveReadReadinessRows.some((receipt) => receipt.response?.requiredOperatorApprovals?.includes('live_github_readback_approval'))
                        ? <span>Operator live-read approval required</span>
                        : null}
                      {evalMergeQueueLiveReadReadinessRows.some((receipt) => receipt.response?.tokenValueIncluded === false)
                        ? <span>Token value included false</span>
                        : null}
                      {evalMergeQueueLiveReadReadinessRows.some((receipt) => receipt.response?.tokenValuePersisted === false)
                        ? <span>Token value persisted false</span>
                        : null}
                      {evalMergeQueueLiveReadReadinessRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalMergeQueueLiveReadReadinessRows.some((receipt) => receipt.response?.mergeQueueLiveVerified === false)
                        ? <span>Merge queue live verified false</span>
                        : null}
                      {evalMergeQueueLiveReadReadinessRows.some((receipt) => receipt.response?.remainingBlockers?.includes('real_token_merge_authorization'))
                        ? <span>Real token merge authorization still required</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueCredentialHandoffRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue credential handoff queue">
                <span>merge queue credential handoff guarded</span>
                <strong>Eval Merge Queue Credential Handoff</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueCredentialHandoffRows.length} credential handoff receipt{evalMergeQueueCredentialHandoffRows.length === 1 ? '' : 's'} declare secret custody, rotation, revocation, and approval prerequisites while secret values, GitHub reads, live verification, and merges stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue credential handoff status">
                      {evalMergeQueueCredentialHandoffRows.map((receipt) => (
                        <span key={`eval-merge-queue-credential-handoff:${receipt.id}`}>
                          {formatLabel(receipt.handoff_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.readinessObserved)
                        ? <span>Readiness receipt observed</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.credentialReferenceDeclared)
                        ? <span>Credential reference declared</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.secretStoreReferenceDeclared)
                        ? <span>Secret store reference declared</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.custodyRequirements?.includes('no_database_persistence'))
                        ? <span>No database persistence required</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.rotationPlan?.includes('rotate_after_live_read'))
                        ? <span>Rotation plan required</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.revocationPlan?.includes('revoke_on_failed_scope_check'))
                        ? <span>Revocation plan required</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.secretValueIncluded === false)
                        ? <span>Secret value included false</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.secretValueLogged === false)
                        ? <span>Secret value logged false</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalMergeQueueCredentialHandoffRows.some((receipt) => receipt.response?.remainingBlockers?.includes('real_token_runtime_injection'))
                        ? <span>Runtime token injection still required</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueLiveReadPreflightRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue live read preflight queue">
                <span>merge queue live read preflight guarded</span>
                <strong>Eval Merge Queue Live Read Preflight</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueLiveReadPreflightRows.length} live-read preflight envelope{evalMergeQueueLiveReadPreflightRows.length === 1 ? '' : 's'} declare method, endpoint, header shape, conditional request policy, and runtime secret reference while token materialization, GitHub HTTP, live verification, and merges stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue live read preflight status">
                      {evalMergeQueueLiveReadPreflightRows.map((receipt) => (
                        <span key={`eval-merge-queue-live-read-preflight:${receipt.id}`}>
                          {formatLabel(receipt.preflight_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.credentialHandoffObserved)
                        ? <span>Credential handoff observed</span>
                        : null}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.requestEnvelopeBuilt)
                        ? <span>Request envelope built</span>
                        : null}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.authHeaderPlanned)
                        ? <span>Authorization header planned</span>
                        : null}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.authorizationHeaderMaterialized === false)
                        ? <span>Authorization header materialized false</span>
                        : null}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.conditionalRequestPlanned)
                        ? <span>Conditional request planned</span>
                        : null}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.tokenValueIncluded === false)
                        ? <span>Token value included false</span>
                        : null}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalMergeQueueLiveReadPreflightRows.some((receipt) => receipt.response?.remainingBlockers?.includes('live_github_http_request'))
                        ? <span>Live GitHub HTTP still required</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueTokenQuarantineRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue token quarantine queue">
                <span>merge queue token quarantine guarded</span>
                <strong>Eval Merge Queue Token Quarantine</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueTokenQuarantineRows.length} token quarantine receipt{evalMergeQueueTokenQuarantineRows.length === 1 ? '' : 's'} declare runtime release policy, operator gates, and rollback while token materialization, persistence, logging, HTTP, and merges stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue token quarantine status">
                      {evalMergeQueueTokenQuarantineRows.map((receipt) => (
                        <span key={`eval-merge-queue-token-quarantine:${receipt.id}`}>
                          {formatLabel(receipt.quarantine_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueTokenQuarantineRows.some((receipt) => receipt.response?.liveReadPreflightObserved)
                        ? <span>Live read preflight observed</span>
                        : null}
                      {evalMergeQueueTokenQuarantineRows.some((receipt) => receipt.response?.runtimeSecretRefObserved)
                        ? <span>Runtime secret ref observed</span>
                        : null}
                      {evalMergeQueueTokenQuarantineRows.some((receipt) => receipt.response?.quarantinePolicyRecorded)
                        ? <span>Quarantine policy recorded</span>
                        : null}
                      {evalMergeQueueTokenQuarantineRows.some((receipt) => receipt.response?.tokenMaterialized === false)
                        ? <span>Token materialized false</span>
                        : null}
                      {evalMergeQueueTokenQuarantineRows.some((receipt) => receipt.response?.tokenValuePersisted === false)
                        ? <span>Token value persisted false</span>
                        : null}
                      {evalMergeQueueTokenQuarantineRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueLiveReadResponseIngestionRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue live read response ingestion queue">
                <span>merge queue response evidence ingested</span>
                <strong>Eval Merge Queue Live Read Response Ingestion</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueLiveReadResponseIngestionRows.length} response ingestion receipt{evalMergeQueueLiveReadResponseIngestionRows.length === 1 ? '' : 's'} preserve operator-supplied ruleset evidence while GitHub API calls, live read success claims, verification, and merges stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue live read response ingestion status">
                      {evalMergeQueueLiveReadResponseIngestionRows.map((receipt) => (
                        <span key={`eval-merge-queue-live-read-response:${receipt.id}`}>
                          {formatLabel(receipt.ingestion_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueLiveReadResponseIngestionRows.some((receipt) => receipt.response?.operatorSuppliedResponseObserved)
                        ? <span>Operator response evidence observed</span>
                        : null}
                      {evalMergeQueueLiveReadResponseIngestionRows.some((receipt) => receipt.response?.tokenQuarantineObserved)
                        ? <span>Token quarantine observed</span>
                        : null}
                      {evalMergeQueueLiveReadResponseIngestionRows.some((receipt) => receipt.response?.responsePayloadSchemaObserved)
                        ? <span>Response payload schema observed</span>
                        : null}
                      {evalMergeQueueLiveReadResponseIngestionRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueLiveReadResponseIngestionRows.some((receipt) => receipt.response?.liveGithubApiCalled === false)
                        ? <span>Live GitHub API called false</span>
                        : null}
                      {evalMergeQueueLiveReadResponseIngestionRows.some((receipt) => receipt.response?.mergeQueueLiveVerified === false)
                        ? <span>Live verification false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueRuntimeTokenReleaseGateRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue runtime token release gate queue">
                <span>runtime token release gate recorded</span>
                <strong>Eval Merge Queue Runtime Token Release Gate</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueRuntimeTokenReleaseGateRows.length} runtime token release gate receipt{evalMergeQueueRuntimeTokenReleaseGateRows.length === 1 ? '' : 's'} prove release remains denied until operator acknowledgement and secret-provider smoke exist, while token release, HTTP, and merges stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue runtime token release gate status">
                      {evalMergeQueueRuntimeTokenReleaseGateRows.map((receipt) => (
                        <span key={`eval-merge-queue-runtime-token-gate:${receipt.id}`}>
                          {formatLabel(receipt.gate_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueRuntimeTokenReleaseGateRows.some((receipt) => receipt.response?.responseIngestionObserved)
                        ? <span>Response ingestion observed</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseGateRows.some((receipt) => receipt.response?.operatorReleaseAckRequired)
                        ? <span>Operator release ack required</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseGateRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeRequired)
                        ? <span>Secret provider smoke required</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseGateRows.some((receipt) => receipt.response?.tokenReleaseDenied)
                        ? <span>Token release denied</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseGateRows.some((receipt) => receipt.response?.tokenReleased === false)
                        ? <span>Token released false</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseGateRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueLiveReadVerificationPromotionRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue live read verification promotion queue">
                <span>live-read verification promotion queued</span>
                <strong>Eval Merge Queue Live Read Verification Promotion</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueLiveReadVerificationPromotionRows.length} live-read promotion receipt{evalMergeQueueLiveReadVerificationPromotionRows.length === 1 ? '' : 's'} queue response evidence for future live HTTP verification while token release, GitHub calls, live verification claims, and merges stay blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue live read verification promotion status">
                      {evalMergeQueueLiveReadVerificationPromotionRows.map((receipt) => (
                        <span key={`eval-merge-queue-live-read-promotion:${receipt.id}`}>
                          {formatLabel(receipt.promotion_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueLiveReadVerificationPromotionRows.some((receipt) => receipt.response?.runtimeTokenReleaseGateObserved)
                        ? <span>Runtime token gate observed</span>
                        : null}
                      {evalMergeQueueLiveReadVerificationPromotionRows.some((receipt) => receipt.response?.operatorResponseEvidenceObserved)
                        ? <span>Operator response evidence observed</span>
                        : null}
                      {evalMergeQueueLiveReadVerificationPromotionRows.some((receipt) => receipt.response?.liveVerificationPlanRecorded)
                        ? <span>Live verification plan recorded</span>
                        : null}
                      {evalMergeQueueLiveReadVerificationPromotionRows.some((receipt) => receipt.response?.liveVerificationPromoted === false)
                        ? <span>Live verification promoted false</span>
                        : null}
                      {evalMergeQueueLiveReadVerificationPromotionRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueLiveReadVerificationPromotionRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueLiveHttpExecutionPreflightHandoffRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue live http execution preflight handoff queue">
                <span>live HTTP execution preflight handoff guarded</span>
                <strong>Eval Merge Queue Live HTTP Execution Preflight Handoff</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueLiveHttpExecutionPreflightHandoffRows.length} live HTTP preflight handoff receipt{evalMergeQueueLiveHttpExecutionPreflightHandoffRows.length === 1 ? '' : 's'} carry the operator release plan for a future GitHub GET while token release, HTTP, live verification, and merge execution remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue live http execution preflight handoff status">
                      {evalMergeQueueLiveHttpExecutionPreflightHandoffRows.map((receipt) => (
                        <span key={`eval-merge-queue-live-http-preflight-handoff:${receipt.id}`}>
                          {formatLabel(receipt.handoff_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueLiveHttpExecutionPreflightHandoffRows.some((receipt) => receipt.response?.liveReadVerificationPromotionObserved)
                        ? <span>Live-read promotion observed</span>
                        : null}
                      {evalMergeQueueLiveHttpExecutionPreflightHandoffRows.some((receipt) => receipt.response?.operatorReleaseAckRequired)
                        ? <span>Operator release ack required</span>
                        : null}
                      {evalMergeQueueLiveHttpExecutionPreflightHandoffRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeRequired)
                        ? <span>Runtime secret smoke required</span>
                        : null}
                      {evalMergeQueueLiveHttpExecutionPreflightHandoffRows.some((receipt) => receipt.response?.httpExecutionPlanRecorded)
                        ? <span>HTTP execution plan recorded</span>
                        : null}
                      {evalMergeQueueLiveHttpExecutionPreflightHandoffRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueLiveHttpExecutionPreflightHandoffRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueLiveHttpOperatorReleaseAckRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue live http operator release ack queue">
                <span>live HTTP operator release ack recorded</span>
                <strong>Eval Merge Queue Live HTTP Operator Release Ack</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueLiveHttpOperatorReleaseAckRows.length} live HTTP operator release ack receipt{evalMergeQueueLiveHttpOperatorReleaseAckRows.length === 1 ? '' : 's'} record the human acknowledgement for a future GitHub GET while secret smoke, token release, HTTP, live verification, and merge execution remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue live http operator release ack status">
                      {evalMergeQueueLiveHttpOperatorReleaseAckRows.map((receipt) => (
                        <span key={`eval-merge-queue-live-http-release-ack:${receipt.id}`}>
                          {formatLabel(receipt.release_ack_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueLiveHttpOperatorReleaseAckRows.some((receipt) => receipt.response?.operatorReleaseAckRecorded)
                        ? <span>Operator release ack recorded</span>
                        : null}
                      {evalMergeQueueLiveHttpOperatorReleaseAckRows.some((receipt) => receipt.response?.operatorReleaseAckRequired === false)
                        ? <span>Operator release ack required false</span>
                        : null}
                      {evalMergeQueueLiveHttpOperatorReleaseAckRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeRequired)
                        ? <span>Runtime secret smoke required</span>
                        : null}
                      {evalMergeQueueLiveHttpOperatorReleaseAckRows.some((receipt) => receipt.response?.tokenReleased === false)
                        ? <span>Token released false</span>
                        : null}
                      {evalMergeQueueLiveHttpOperatorReleaseAckRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueLiveHttpOperatorReleaseAckRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue runtime secret provider smoke readiness queue">
                <span>runtime secret smoke readiness recorded</span>
                <strong>Eval Merge Queue Runtime Secret Provider Smoke Readiness</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.length} runtime secret smoke readiness receipt{evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.length === 1 ? '' : 's'} record the smoke command and redaction guardrail while secret access, token release, HTTP, live verification, and merge execution remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue runtime secret provider smoke readiness status">
                      {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.map((receipt) => (
                        <span key={`eval-merge-queue-runtime-secret-smoke-readiness:${receipt.id}`}>
                          {formatLabel(receipt.smoke_readiness_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.some((receipt) => receipt.response?.liveHttpOperatorReleaseAckObserved)
                        ? <span>Operator release ack observed</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeReadinessRecorded)
                        ? <span>Runtime secret smoke readiness recorded</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeExecuted === false)
                        ? <span>Runtime secret smoke executed false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokePassed === false)
                        ? <span>Runtime secret smoke passed false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.some((receipt) => receipt.response?.tokenReleased === false)
                        ? <span>Token released false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeReadinessRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue runtime secret provider smoke execution gate queue">
                <span>runtime secret smoke execution gate recorded</span>
                <strong>Eval Merge Queue Runtime Secret Provider Smoke Execution Gate</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.length} runtime secret smoke execution gate receipt{evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.length === 1 ? '' : 's'} record the blocked live smoke attempt boundary while secret access, token release, HTTP, live verification, and merge execution remain blocked.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue runtime secret provider smoke execution gate status">
                      {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.map((receipt) => (
                        <span key={`eval-merge-queue-runtime-secret-smoke-execution-gate:${receipt.id}`}>
                          {formatLabel(receipt.smoke_gate_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeReadinessObserved)
                        ? <span>Runtime secret smoke readiness observed</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeExecutionBlocked)
                        ? <span>Runtime secret smoke execution blocked</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeAttempted === false)
                        ? <span>Runtime secret smoke attempted false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokePassed === false)
                        ? <span>Runtime secret smoke passed false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.some((receipt) => receipt.response?.tokenReleased === false)
                        ? <span>Token released false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeExecutionGateRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue runtime secret provider smoke evidence review queue">
                <span>runtime secret smoke evidence review recorded</span>
                <strong>Eval Merge Queue Runtime Secret Provider Smoke Evidence Review</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.length} runtime secret smoke evidence review receipt{evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.length === 1 ? '' : 's'} require successful live-smoke evidence before token release, HTTP, live verification, or merge execution can advance.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue runtime secret provider smoke evidence review status">
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.map((receipt) => (
                        <span key={`eval-merge-queue-runtime-secret-smoke-evidence-review:${receipt.id}`}>
                          {formatLabel(receipt.evidence_review_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeExecutionGateObserved)
                        ? <span>Runtime secret smoke execution gate observed</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.some((receipt) => receipt.response?.successfulSmokeEvidenceRequired)
                        ? <span>Successful smoke evidence required</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.some((receipt) => receipt.response?.successfulSmokeEvidenceObserved === false)
                        ? <span>Successful smoke evidence observed false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeVerified === false)
                        ? <span>Runtime secret smoke verified false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokePassed === false)
                        ? <span>Runtime secret smoke passed false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.some((receipt) => receipt.response?.tokenReleased === false)
                        ? <span>Token released false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue memory only runtime token release preflight queue">
                <span>memory-only token preflight recorded</span>
                <strong>Eval Merge Queue Memory Only Runtime Token Release Preflight</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.length} memory-only runtime token preflight receipt{evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.length === 1 ? '' : 's'} keep token release blocked until successful smoke evidence and runtime secret-provider verification exist.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue memory only runtime token release preflight status">
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.map((receipt) => (
                        <span key={`eval-merge-queue-memory-token-preflight:${receipt.id}`}>
                          {formatLabel(receipt.token_preflight_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.some((receipt) => receipt.response?.runtimeSecretProviderSmokeEvidenceReviewObserved)
                        ? <span>Smoke evidence review observed</span>
                        : null}
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.some((receipt) => receipt.response?.successfulSmokeEvidenceObserved === false)
                        ? <span>Successful smoke evidence observed false</span>
                        : null}
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.some((receipt) => receipt.response?.memoryOnlyTokenReleasePreflightRecorded)
                        ? <span>Memory-only token preflight recorded</span>
                        : null}
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.some((receipt) => receipt.response?.memoryOnlyTokenReleaseAllowed === false)
                        ? <span>Memory-only token release allowed false</span>
                        : null}
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.some((receipt) => receipt.response?.tokenReleased === false)
                        ? <span>Token released false</span>
                        : null}
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.some((receipt) => receipt.response?.authorizationHeaderMaterialized === false)
                        ? <span>Authorization header materialized false</span>
                        : null}
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue successful smoke evidence ingestion queue">
                <span>fake smoke success rejected</span>
                <strong>Eval Merge Queue Successful Smoke Evidence Ingestion</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.length} successful-smoke evidence ingestion rejection receipt{evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.length === 1 ? '' : 's'} keep token release blocked when submitted smoke proof is not backed by runtime secret-provider execution.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue successful smoke evidence ingestion status">
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.map((receipt) => (
                        <span key={`eval-merge-queue-smoke-evidence-ingestion:${receipt.id}`}>
                          {formatLabel(receipt.smoke_evidence_ingestion_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.some((receipt) => receipt.response?.memoryOnlyRuntimeTokenReleasePreflightObserved)
                        ? <span>Memory-only token preflight observed</span>
                        : null}
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.some((receipt) => receipt.response?.successfulSmokeEvidenceSubmitted)
                        ? <span>Successful smoke evidence submitted</span>
                        : null}
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.some((receipt) => receipt.response?.successfulSmokeEvidenceAccepted === false)
                        ? <span>Successful smoke evidence accepted false</span>
                        : null}
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.some((receipt) => receipt.response?.fakeSuccessClaimRejected)
                        ? <span>Fake success claim rejected</span>
                        : null}
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.some((receipt) => receipt.response?.memoryOnlyTokenReleaseAllowed === false)
                        ? <span>Memory-only token release allowed false</span>
                        : null}
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.some((receipt) => receipt.response?.tokenReleased === false)
                        ? <span>Token released false</span>
                        : null}
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueSuccessfulSmokeEvidenceIngestionRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueRuntimeTokenReleaseDenialRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue runtime token release denial queue">
                <span>runtime token release denied</span>
                <strong>Eval Merge Queue Runtime Token Release Denial</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueRuntimeTokenReleaseDenialRows.length} runtime token release denial receipt{evalMergeQueueRuntimeTokenReleaseDenialRows.length === 1 ? '' : 's'} keep tokens unavailable after fake smoke evidence rejection.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue runtime token release denial status">
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.map((receipt) => (
                        <span key={`eval-merge-queue-runtime-token-denial:${receipt.id}`}>
                          {formatLabel(receipt.token_release_denial_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.some((receipt) => receipt.response?.successfulSmokeEvidenceIngestionObserved)
                        ? <span>Smoke evidence ingestion observed</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.some((receipt) => receipt.response?.runtimeTokenReleaseRequested)
                        ? <span>Runtime token release requested</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.some((receipt) => receipt.response?.runtimeTokenReleaseDenied)
                        ? <span>Runtime token release denied</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.some((receipt) => receipt.response?.tokenReleaseApproved === false)
                        ? <span>Token release approved false</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.some((receipt) => receipt.response?.tokenReleased === false)
                        ? <span>Token released false</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.some((receipt) => receipt.response?.authorizationHeaderMaterialized === false)
                        ? <span>Authorization header materialized false</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueRuntimeTokenReleaseDenialRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueFakeLiveReadReplayQuarantineRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue fake live-read replay quarantine queue">
                <span>fake live-read replay quarantined</span>
                <strong>Eval Merge Queue Fake Live Read Replay Quarantine</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueFakeLiveReadReplayQuarantineRows.length} fake live-read replay quarantine receipt{evalMergeQueueFakeLiveReadReplayQuarantineRows.length === 1 ? '' : 's'} keep rejected replay evidence from reopening live verification.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue fake live-read replay quarantine status">
                      {evalMergeQueueFakeLiveReadReplayQuarantineRows.map((receipt) => (
                        <span key={`eval-merge-queue-fake-live-read-replay-quarantine:${receipt.id}`}>
                          {formatLabel(receipt.replay_quarantine_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueFakeLiveReadReplayQuarantineRows.some((receipt) => receipt.response?.runtimeTokenReleaseDenied)
                        ? <span>Runtime token release denied</span>
                        : null}
                      {evalMergeQueueFakeLiveReadReplayQuarantineRows.some((receipt) => receipt.response?.fakeLiveReadReplayQuarantined)
                        ? <span>Fake live-read replay quarantined</span>
                        : null}
                      {evalMergeQueueFakeLiveReadReplayQuarantineRows.some((receipt) => receipt.response?.liveReadResponseAccepted === false)
                        ? <span>Live read response accepted false</span>
                        : null}
                      {evalMergeQueueFakeLiveReadReplayQuarantineRows.some((receipt) => receipt.response?.tokenReleaseApproved === false)
                        ? <span>Token release approved false</span>
                        : null}
                      {evalMergeQueueFakeLiveReadReplayQuarantineRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueFakeLiveReadReplayQuarantineRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueFinalBlockerLedgerRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue final blocker ledger queue">
                <span>final blocker ledger sealed</span>
                <strong>Eval Merge Queue Final Blocker Ledger</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueFinalBlockerLedgerRows.length} final blocker ledger receipt{evalMergeQueueFinalBlockerLedgerRows.length === 1 ? '' : 's'} keep merge execution blocked after replay quarantine.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue final blocker ledger status">
                      {evalMergeQueueFinalBlockerLedgerRows.map((receipt) => (
                        <span key={`eval-merge-queue-final-blocker-ledger:${receipt.id}`}>
                          {formatLabel(receipt.final_blocker_ledger_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueFinalBlockerLedgerRows.some((receipt) => receipt.response?.requiredBlockersPresent)
                        ? <span>Required blockers present</span>
                        : null}
                      {evalMergeQueueFinalBlockerLedgerRows.some((receipt) => receipt.response?.finalBlockerLedgerSealed)
                        ? <span>Final blocker ledger sealed</span>
                        : null}
                      {evalMergeQueueFinalBlockerLedgerRows.some((receipt) => receipt.response?.tokenReleaseApproved === false)
                        ? <span>Token release approved false</span>
                        : null}
                      {evalMergeQueueFinalBlockerLedgerRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueFinalBlockerLedgerRows.some((receipt) => receipt.response?.mergeAllowed === false)
                        ? <span>Merge allowed false</span>
                        : null}
                      {evalMergeQueueFinalBlockerLedgerRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueuePostLedgerOperatorReleaseAttestationRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue post-ledger operator release attestation queue">
                <span>operator release blocked</span>
                <strong>Eval Merge Queue Post-Ledger Operator Release Attestation</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueuePostLedgerOperatorReleaseAttestationRows.length} post-ledger release attestation receipt{evalMergeQueuePostLedgerOperatorReleaseAttestationRows.length === 1 ? '' : 's'} prove operator release cannot bypass sealed blockers.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue post-ledger operator release attestation status">
                      {evalMergeQueuePostLedgerOperatorReleaseAttestationRows.map((receipt) => (
                        <span key={`eval-merge-queue-post-ledger-release-attestation:${receipt.id}`}>
                          {formatLabel(receipt.release_attestation_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueuePostLedgerOperatorReleaseAttestationRows.some((receipt) => receipt.response?.operatorReleaseBlocked)
                        ? <span>Operator release blocked</span>
                        : null}
                      {evalMergeQueuePostLedgerOperatorReleaseAttestationRows.some((receipt) => receipt.response?.operatorOverrideAllowed === false)
                        ? <span>Operator override allowed false</span>
                        : null}
                      {evalMergeQueuePostLedgerOperatorReleaseAttestationRows.some((receipt) => receipt.response?.releaseApproved === false)
                        ? <span>Release approved false</span>
                        : null}
                      {evalMergeQueuePostLedgerOperatorReleaseAttestationRows.some((receipt) => receipt.response?.liveHttpReleaseAllowed === false)
                        ? <span>Live HTTP release allowed false</span>
                        : null}
                      {evalMergeQueuePostLedgerOperatorReleaseAttestationRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueuePostLedgerOperatorReleaseAttestationRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueuePostAttestationReleaseEscrowRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue post-attestation release escrow queue">
                <span>release escrow held</span>
                <strong>Eval Merge Queue Post-Attestation Release Escrow</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueuePostAttestationReleaseEscrowRows.length} post-attestation release escrow receipt{evalMergeQueuePostAttestationReleaseEscrowRows.length === 1 ? '' : 's'} prove blocked operator release stays held without token, HTTP, live verification, or merge side effects.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue post-attestation release escrow status">
                      {evalMergeQueuePostAttestationReleaseEscrowRows.map((receipt) => (
                        <span key={`eval-merge-queue-post-attestation-release-escrow:${receipt.id}`}>
                          {formatLabel(receipt.release_escrow_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueuePostAttestationReleaseEscrowRows.some((receipt) => receipt.response?.releaseEscrowHeld)
                        ? <span>Release escrow held</span>
                        : null}
                      {evalMergeQueuePostAttestationReleaseEscrowRows.some((receipt) => receipt.response?.escrowReleased === false)
                        ? <span>Escrow released false</span>
                        : null}
                      {evalMergeQueuePostAttestationReleaseEscrowRows.some((receipt) => receipt.response?.releaseApproved === false)
                        ? <span>Release approved false</span>
                        : null}
                      {evalMergeQueuePostAttestationReleaseEscrowRows.some((receipt) => receipt.response?.authorizationHeaderMaterialized === false)
                        ? <span>Authorization header materialized false</span>
                        : null}
                      {evalMergeQueuePostAttestationReleaseEscrowRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueuePostAttestationReleaseEscrowRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueReleaseDenialCloseoutRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue release denial closeout queue">
                <span>release denial sealed</span>
                <strong>Eval Merge Queue Release Denial Closeout</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueReleaseDenialCloseoutRows.length} release denial closeout receipt{evalMergeQueueReleaseDenialCloseoutRows.length === 1 ? '' : 's'} seal held escrow into a denied release without token, HTTP, live verification, or merge side effects.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue release denial closeout status">
                      {evalMergeQueueReleaseDenialCloseoutRows.map((receipt) => (
                        <span key={`eval-merge-queue-release-denial-closeout:${receipt.id}`}>
                          {formatLabel(receipt.closeout_kind)} · {formatLabel(receipt.status)}
                        </span>
                      ))}
                      {evalMergeQueueReleaseDenialCloseoutRows.some((receipt) => receipt.response?.releaseDenied)
                        ? <span>Release denied</span>
                        : null}
                      {evalMergeQueueReleaseDenialCloseoutRows.some((receipt) => receipt.response?.releaseDenialSealed)
                        ? <span>Release denial sealed</span>
                        : null}
                      {evalMergeQueueReleaseDenialCloseoutRows.some((receipt) => receipt.response?.releaseEscrowHeld)
                        ? <span>Release escrow held</span>
                        : null}
                      {evalMergeQueueReleaseDenialCloseoutRows.some((receipt) => receipt.response?.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueReleaseDenialCloseoutRows.some((receipt) => receipt.response?.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                      {evalMergeQueueReleaseDenialCloseoutRows.some((receipt) => (receipt.response?.denialReasons || []).length)
                        ? <span>Denial reasons {evalMergeQueueReleaseDenialCloseoutRows.reduce((sum, receipt) => sum + ((receipt.response?.denialReasons || []).length), 0)}</span>
                        : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            {evalMergeQueueConsolidatedBlockerAuditRows.length ? (
              <div className="portfolio-event portfolio-operator-queue-row" aria-label="eval merge queue consolidated blocker audit queue">
                <span>read-only blocker audit</span>
                <strong>Eval Merge Queue Consolidated Blocker Audit</strong>
                <div className="portfolio-event-action portfolio-operator-queue-action">
                  <div className="portfolio-operator-queue-main">
                    <p>{evalMergeQueueConsolidatedBlockerAuditRows.length} consolidated blocker audit{evalMergeQueueConsolidatedBlockerAuditRows.length === 1 ? '' : 's'} stitch receipt provenance into a read-only merge-release safety view.</p>
                    <div className="portfolio-queue-meta" aria-label="eval merge queue consolidated blocker audit status">
                      {evalMergeQueueConsolidatedBlockerAuditRows.map((audit) => (
                        <span key={`eval-merge-queue-consolidated-blocker-audit:${audit.key}`}>
                          {formatLabel(audit.status)} · {audit.blockerCount || 0} blocker{audit.blockerCount === 1 ? '' : 's'} · {audit.sourceReceipts?.length || 0} receipts
                        </span>
                      ))}
                      {evalMergeQueueConsolidatedBlockerAuditRows.some((audit) => audit.releaseEscrowHeld)
                        ? <span>Release escrow held</span>
                        : null}
                      {evalMergeQueueConsolidatedBlockerAuditRows.some((audit) => audit.readOnly)
                        ? <span>Read-only audit true</span>
                        : null}
                      {evalMergeQueueConsolidatedBlockerAuditRows.some((audit) => audit.httpRequestSent === false)
                        ? <span>HTTP request sent false</span>
                        : null}
                      {evalMergeQueueConsolidatedBlockerAuditRows.some((audit) => audit.mergeExecuted === false)
                        ? <span>Merge executed false</span>
                        : null}
                      {evalMergeQueueConsolidatedBlockerAuditRows.some((audit) => (audit.warnings || []).length)
                        ? <span>Warnings present</span>
                        : <span>Warnings empty</span>}
                      <span>Remediation actions {evalMergeQueueConsolidatedBlockerRemediationCount}</span>
                      {evalMergeQueueConsolidatedBlockerRemediationActions.some((action) => action.releaseBlockedUntilResolved)
                        ? <span>Release blocked until ancestry repaired</span>
                        : null}
                      {evalMergeQueueConsolidatedBlockerRemediationActions.map((action, index) => (
                        <span key={`eval-merge-queue-consolidated-blocker-remediation:${index}:${action.code}:${action.missingReceiptId || 'missing'}`}>
                          {formatLabel(action.code)}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio blocker actions">
          <PanelHeader
            eyebrow="operator actions"
            title="Blocker Actions"
            detail={blockerActions.length ? `${blockerActions.length} open` : loading ? 'loading' : 'clear'}
          />
          <div className="portfolio-event-list">
            {blockerActions.length ? blockerActions.map((item) => (
              <div className="portfolio-event" key={item.actionId}>
                <span>{formatLabel(item.type)}</span>
                <strong>{item.label}</strong>
                <div className="portfolio-event-action">
                  <p>{item.summary}</p>
                  <button
                    className="portfolio-mini-action"
                    type="button"
                    onClick={() => runBlockerAction(item)}
                    disabled={fixingId === item.actionId}
                  >
                    {fixingId === item.actionId ? 'Working' : item.cta}
                  </button>
                </div>
              </div>
            )) : <EmptyState label={loading ? 'Loading blockers' : 'No open blockers'} />}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio learning">
          <PanelHeader
            eyebrow="learning loop"
            title="Incidents And Experiments"
            detail={`${incidents.length} incidents / ${learningRecords.length} records`}
          />
          <div className="portfolio-event-list">
            {incidents.length ? incidents.map((incident) => (
              <div className="portfolio-event" key={incident.id}>
                <span>{formatLabel(incident.severity)}</span>
                <strong>{formatLabel(incident.category)}</strong>
                <p>{incident.summary}</p>
              </div>
            )) : <EmptyState label={loading ? 'Loading incident ledger' : 'No portfolio incidents'} />}
            {learningRecords.length ? learningRecords.map((record) => (
              <div className="portfolio-event" key={record.id}>
                <span>{formatLabel(record.status)}</span>
                <strong>{formatLabel(record.kind)}</strong>
                <p>{record.proposed_change}</p>
              </div>
            )) : null}
          </div>
        </section>

        <section className="portfolio-panel portfolio-panel-wide" aria-label="portfolio timeline">
          <PanelHeader eyebrow="ledger" title="Recent Events" detail={recentEvents.length ? `${recentEvents.length} events` : 'empty'} />
          <div className="portfolio-event-list">
            {recentEvents.length ? recentEvents.map((event) => (
              <div className="portfolio-event" key={event.id}>
                <span>{formatTime(event.created_at)}</span>
                <strong>{formatLabel(event.type)}</strong>
                <p>{event.summary}</p>
              </div>
            )) : <EmptyState label={loading ? 'Loading event ledger' : 'No portfolio events'} />}
          </div>
        </section>
      </div>
    </div>
  );
}

function PanelHeader({ eyebrow, title, detail }) {
  return (
    <div className="portfolio-panel-head">
      <div>
        <span>{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <em>{detail}</em>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="portfolio-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Score({ label, value, integer = false, money = false }) {
  return (
    <div className="portfolio-score">
      <span>{label}</span>
      <strong>{money ? formatMoney(value) : integer ? value : formatRatio(value)}</strong>
    </div>
  );
}

function StatusPill({ tone = 'warm', children }) {
  return <span className={`portfolio-pill portfolio-pill-${tone}`}>{children}</span>;
}

function EmptyState({ label }) {
  return <div className="portfolio-empty">{label}</div>;
}

function buildOperatorQueueRows(snapshot) {
  if (!snapshot) return [];
  const services = new Map((snapshot.serviceBusinesses || []).map((item) => [item.id, item]));
  const inboxItems = snapshot.operatorInboxItems || [];
  const assignments = snapshot.operatorInboxAssignments || [];
  const receipts = snapshot.operatorBulkReviewReceipts || [];
  const closeouts = snapshot.operatorHandoffEvalCloseouts || [];
  const evalPublicationReceipts = snapshot.evalPublicationReceipts || [];
  const evalFixtureWorkItems = snapshot.evalFixtureWorkItems || [];
  const evalFixtureRunnerReceipts = snapshot.evalFixtureRunnerReceipts || [];
  const evalFixtureApprovalReceipts = snapshot.evalFixtureApprovalReceipts || [];
  const evalGoldenFixtureReviewReceipts = snapshot.evalGoldenFixtureReviewReceipts || [];
  const evalNonLiveRunnerBindingReceipts = snapshot.evalNonLiveRunnerBindingReceipts || [];
  const evalFileDryRunManifests = snapshot.evalFileDryRunManifests || [];
  const evalCiWriteAccessReceipts = snapshot.evalCiWriteAccessReceipts || [];
  const evalLiveAdapterReadinessReceipts = snapshot.evalLiveAdapterReadinessReceipts || [];
  const evalLiveAdapterContractTestReceipts = snapshot.evalLiveAdapterContractTestReceipts || [];
  const evalCiWorkflowPublicationReceipts = snapshot.evalCiWorkflowPublicationReceipts || [];
  const evalGeneratedArtifactPromotionReceipts = snapshot.evalGeneratedArtifactPromotionReceipts || [];
  const evalPrMergeProposalReceipts = snapshot.evalPrMergeProposalReceipts || [];
  const evalPrOpenSimulationReceipts = snapshot.evalPrOpenSimulationReceipts || [];
  const evalOperatorMergeApprovalReceipts = snapshot.evalOperatorMergeApprovalReceipts || [];
  const evalSubmittedPrEvidenceReceipts = snapshot.evalSubmittedPrEvidenceReceipts || [];
  const evalPrExternalVerificationReceipts = snapshot.evalPrExternalVerificationReceipts || [];
  const evalExternalCiResultReceipts = snapshot.evalExternalCiResultReceipts || [];
  const evalGithubPrVerificationReceipts = snapshot.evalGithubPrVerificationReceipts || [];
  const evalGithubPrObservationReceipts = snapshot.evalGithubPrObservationReceipts || [];
  const evalGithubCheckRunObservationReceipts = snapshot.evalGithubCheckRunObservationReceipts || [];
  const evalMergeExecutionAdapterContractReceipts = snapshot.evalMergeExecutionAdapterContractReceipts || [];
  const evalOperatorMergeCompletionGateReceipts = snapshot.evalOperatorMergeCompletionGateReceipts || [];
  const evalLiveMergeAuthorizationReceipts = snapshot.evalLiveMergeAuthorizationReceipts || [];
  const evalBranchProtectionReadbackAdapterContractReceipts = snapshot.evalBranchProtectionReadbackAdapterContractReceipts || [];
  const evalTokenScopeObservationAdapterContractReceipts = snapshot.evalTokenScopeObservationAdapterContractReceipts || [];
  const evalSecretRedactionProofReceipts = snapshot.evalSecretRedactionProofReceipts || [];
  const evalMergeQueueReadbackAdapterContractReceipts = snapshot.evalMergeQueueReadbackAdapterContractReceipts || [];
  const evalMergeQueueLiveReadReconciliationReceipts = snapshot.evalMergeQueueLiveReadReconciliationReceipts || [];
  const evalMergeQueueLiveReadAdapterContractReceipts = snapshot.evalMergeQueueLiveReadAdapterContractReceipts || [];
  const evalMergeQueueLiveReadReadinessReceipts = snapshot.evalMergeQueueLiveReadReadinessReceipts || [];
  const evalMergeQueueCredentialHandoffReceipts = snapshot.evalMergeQueueCredentialHandoffReceipts || [];
  const evalMergeQueueLiveReadPreflightReceipts = snapshot.evalMergeQueueLiveReadPreflightReceipts || [];
  const evalMergeQueueTokenQuarantineReceipts = snapshot.evalMergeQueueTokenQuarantineReceipts || [];
  const evalMergeQueueLiveReadResponseIngestionReceipts = snapshot.evalMergeQueueLiveReadResponseIngestionReceipts || [];
  const evalMergeQueueRuntimeTokenReleaseGateReceipts = snapshot.evalMergeQueueRuntimeTokenReleaseGateReceipts || [];
  const evalMergeQueueLiveReadVerificationPromotionReceipts = snapshot.evalMergeQueueLiveReadVerificationPromotionReceipts || [];
  const evalMergeQueueLiveHttpExecutionPreflightHandoffReceipts = snapshot.evalMergeQueueLiveHttpExecutionPreflightHandoffReceipts || [];
  const evalMergeQueueLiveHttpOperatorReleaseAckReceipts = snapshot.evalMergeQueueLiveHttpOperatorReleaseAckReceipts || [];
  const evalMergeQueueRuntimeSecretProviderSmokeReadinessReceipts = snapshot.evalMergeQueueRuntimeSecretProviderSmokeReadinessReceipts || [];
  const evalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipts = snapshot.evalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipts || [];
  const evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipts = snapshot.evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipts || [];
  const evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipts = snapshot.evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipts || [];
  const evalMergeQueueSuccessfulSmokeEvidenceIngestionReceipts = snapshot.evalMergeQueueSuccessfulSmokeEvidenceIngestionReceipts || [];
  const evalMergeQueueRuntimeTokenReleaseDenialReceipts = snapshot.evalMergeQueueRuntimeTokenReleaseDenialReceipts || [];
  const evalMergeQueueFakeLiveReadReplayQuarantineReceipts = snapshot.evalMergeQueueFakeLiveReadReplayQuarantineReceipts || [];
  const evalMergeQueueFinalBlockerLedgerReceipts = snapshot.evalMergeQueueFinalBlockerLedgerReceipts || [];
  const evalMergeQueuePostLedgerOperatorReleaseAttestationReceipts = snapshot.evalMergeQueuePostLedgerOperatorReleaseAttestationReceipts || [];
  const evalMergeQueuePostAttestationReleaseEscrowReceipts = snapshot.evalMergeQueuePostAttestationReleaseEscrowReceipts || [];
  const evalMergeQueueReleaseDenialCloseoutReceipts = snapshot.evalMergeQueueReleaseDenialCloseoutReceipts || [];
  const staffingReceipts = snapshot.operatorStaffingAnalyticsReceipts || [];
  return (snapshot.operatorAssignmentQueues || []).map((queue) => {
    const roleKey = String(queue.role_key || 'launch_operator');
    const queueItems = inboxItems
      .filter((item) => item.service_business_id === queue.service_business_id)
      .filter((item) => String(item.assigned_role || 'launch_operator') === roleKey)
      .filter((item) => item.status !== 'resolved');
    const activeAssignments = assignments
      .filter((item) => item.service_business_id === queue.service_business_id)
      .filter((item) => String(item.role_key || 'launch_operator') === roleKey)
      .filter((item) => item.status === 'active');
    const expiredAssignments = assignments
      .filter((item) => item.service_business_id === queue.service_business_id)
      .filter((item) => String(item.role_key || 'launch_operator') === roleKey)
      .filter((item) => item.status === 'expired');
    const activeItemIds = new Set(activeAssignments.map((item) => item.inbox_item_id));
    const claimableItem = queueItems.find((item) => item.status === 'open' && !activeItemIds.has(item.id)) || null;
    const latestReceipt = receipts.find((receipt) => (
      receipt.queue_id === queue.id ||
      (receipt.service_business_id === queue.service_business_id && String(receipt.role_key || '') === roleKey)
    )) || null;
    const latestStaffingReceipt = staffingReceipts.find((receipt) => (
      receipt.queue_id === queue.id ||
      (receipt.service_business_id === queue.service_business_id && String(receipt.role_key || '') === roleKey)
    )) || null;
    const latestCloseout = closeouts.find((closeout) => (
      closeout.queue_id === queue.id ||
      closeout.bulk_review_receipt_id === latestReceipt?.id ||
      (closeout.service_business_id === queue.service_business_id && String(closeout.role_key || '') === roleKey)
    )) || null;
    const latestPublicationReceipt = evalPublicationReceipts.find((receipt) => (
      receipt.closeout_id === latestCloseout?.id ||
      receipt.learning_record_id === latestCloseout?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestCloseout?.eval_key)
    )) || null;
    const evalFixtureItemsForPublication = evalFixtureWorkItems.filter((item) => (
      item.publication_receipt_id === latestPublicationReceipt?.id ||
      item.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (item.service_business_id === queue.service_business_id && item.eval_key === latestPublicationReceipt?.eval_key)
    ));
    const latestFixtureRunnerReceipt = evalFixtureRunnerReceipts.find((receipt) => (
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestFixtureApprovalReceipt = evalFixtureApprovalReceipts.find((receipt) => (
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestGoldenFixtureReviewReceipt = evalGoldenFixtureReviewReceipts.find((receipt) => (
      receipt.approval_receipt_id === latestFixtureApprovalReceipt?.id ||
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestNonLiveRunnerBindingReceipt = evalNonLiveRunnerBindingReceipts.find((receipt) => (
      receipt.golden_review_receipt_id === latestGoldenFixtureReviewReceipt?.id ||
      receipt.approval_receipt_id === latestFixtureApprovalReceipt?.id ||
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalFileDryRunManifest = evalFileDryRunManifests.find((receipt) => (
      receipt.runner_binding_receipt_id === latestNonLiveRunnerBindingReceipt?.id ||
      receipt.golden_review_receipt_id === latestGoldenFixtureReviewReceipt?.id ||
      receipt.approval_receipt_id === latestFixtureApprovalReceipt?.id ||
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalCiWriteAccessReceipt = evalCiWriteAccessReceipts.find((receipt) => (
      receipt.file_manifest_id === latestEvalFileDryRunManifest?.id ||
      receipt.runner_binding_receipt_id === latestNonLiveRunnerBindingReceipt?.id ||
      receipt.golden_review_receipt_id === latestGoldenFixtureReviewReceipt?.id ||
      receipt.approval_receipt_id === latestFixtureApprovalReceipt?.id ||
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalLiveAdapterReadinessReceipt = evalLiveAdapterReadinessReceipts.find((receipt) => (
      receipt.ci_write_receipt_id === latestEvalCiWriteAccessReceipt?.id ||
      receipt.file_manifest_id === latestEvalFileDryRunManifest?.id ||
      receipt.runner_binding_receipt_id === latestNonLiveRunnerBindingReceipt?.id ||
      receipt.golden_review_receipt_id === latestGoldenFixtureReviewReceipt?.id ||
      receipt.approval_receipt_id === latestFixtureApprovalReceipt?.id ||
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalLiveAdapterContractTestReceipt = evalLiveAdapterContractTestReceipts.find((receipt) => (
      receipt.live_adapter_readiness_receipt_id === latestEvalLiveAdapterReadinessReceipt?.id ||
      receipt.ci_write_receipt_id === latestEvalCiWriteAccessReceipt?.id ||
      receipt.file_manifest_id === latestEvalFileDryRunManifest?.id ||
      receipt.runner_binding_receipt_id === latestNonLiveRunnerBindingReceipt?.id ||
      receipt.golden_review_receipt_id === latestGoldenFixtureReviewReceipt?.id ||
      receipt.approval_receipt_id === latestFixtureApprovalReceipt?.id ||
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalCiWorkflowPublicationReceipt = evalCiWorkflowPublicationReceipts.find((receipt) => (
      receipt.contract_test_receipt_id === latestEvalLiveAdapterContractTestReceipt?.id ||
      receipt.live_adapter_readiness_receipt_id === latestEvalLiveAdapterReadinessReceipt?.id ||
      receipt.ci_write_receipt_id === latestEvalCiWriteAccessReceipt?.id ||
      receipt.file_manifest_id === latestEvalFileDryRunManifest?.id ||
      receipt.runner_binding_receipt_id === latestNonLiveRunnerBindingReceipt?.id ||
      receipt.golden_review_receipt_id === latestGoldenFixtureReviewReceipt?.id ||
      receipt.approval_receipt_id === latestFixtureApprovalReceipt?.id ||
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalGeneratedArtifactPromotionReceipt = evalGeneratedArtifactPromotionReceipts.find((receipt) => (
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.contract_test_receipt_id === latestEvalLiveAdapterContractTestReceipt?.id ||
      receipt.live_adapter_readiness_receipt_id === latestEvalLiveAdapterReadinessReceipt?.id ||
      receipt.ci_write_receipt_id === latestEvalCiWriteAccessReceipt?.id ||
      receipt.file_manifest_id === latestEvalFileDryRunManifest?.id ||
      receipt.runner_binding_receipt_id === latestNonLiveRunnerBindingReceipt?.id ||
      receipt.golden_review_receipt_id === latestGoldenFixtureReviewReceipt?.id ||
      receipt.approval_receipt_id === latestFixtureApprovalReceipt?.id ||
      receipt.runner_receipt_id === latestFixtureRunnerReceipt?.id ||
      receipt.publication_receipt_id === latestPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalPrMergeProposalReceipt = evalPrMergeProposalReceipts.find((receipt) => (
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.contract_test_receipt_id === latestEvalLiveAdapterContractTestReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalPrOpenSimulationReceipt = evalPrOpenSimulationReceipts.find((receipt) => (
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalOperatorMergeApprovalReceipt = evalOperatorMergeApprovalReceipts.find((receipt) => (
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalSubmittedPrEvidenceReceipt = evalSubmittedPrEvidenceReceipts.find((receipt) => (
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalPrExternalVerificationReceipt = evalPrExternalVerificationReceipts.find((receipt) => (
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalExternalCiResultReceipt = evalExternalCiResultReceipts.find((receipt) => (
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalGithubPrVerificationReceipt = evalGithubPrVerificationReceipts.find((receipt) => (
      receipt.external_ci_result_receipt_id === latestEvalExternalCiResultReceipt?.id ||
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalGithubPrObservationReceipt = evalGithubPrObservationReceipts.find((receipt) => (
      receipt.github_pr_verification_receipt_id === latestEvalGithubPrVerificationReceipt?.id ||
      receipt.external_ci_result_receipt_id === latestEvalExternalCiResultReceipt?.id ||
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalGithubCheckRunObservationReceipt = evalGithubCheckRunObservationReceipts.find((receipt) => (
      receipt.github_pr_observation_receipt_id === latestEvalGithubPrObservationReceipt?.id ||
      receipt.github_pr_verification_receipt_id === latestEvalGithubPrVerificationReceipt?.id ||
      receipt.external_ci_result_receipt_id === latestEvalExternalCiResultReceipt?.id ||
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeExecutionAdapterContractReceipt = evalMergeExecutionAdapterContractReceipts.find((receipt) => (
      receipt.github_check_run_observation_receipt_id === latestEvalGithubCheckRunObservationReceipt?.id ||
      receipt.github_pr_observation_receipt_id === latestEvalGithubPrObservationReceipt?.id ||
      receipt.github_pr_verification_receipt_id === latestEvalGithubPrVerificationReceipt?.id ||
      receipt.external_ci_result_receipt_id === latestEvalExternalCiResultReceipt?.id ||
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalOperatorMergeCompletionGateReceipt = evalOperatorMergeCompletionGateReceipts.find((receipt) => (
      receipt.github_check_run_observation_receipt_id === latestEvalGithubCheckRunObservationReceipt?.id ||
      receipt.response?.mergeExecutionAdapterContractReceiptId === latestEvalMergeExecutionAdapterContractReceipt?.id ||
      receipt.github_pr_observation_receipt_id === latestEvalGithubPrObservationReceipt?.id ||
      receipt.github_pr_verification_receipt_id === latestEvalGithubPrVerificationReceipt?.id ||
      receipt.external_ci_result_receipt_id === latestEvalExternalCiResultReceipt?.id ||
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalLiveMergeAuthorizationReceipt = evalLiveMergeAuthorizationReceipts.find((receipt) => (
      receipt.operator_merge_completion_gate_receipt_id === latestEvalOperatorMergeCompletionGateReceipt?.id ||
      receipt.merge_execution_adapter_contract_receipt_id === latestEvalMergeExecutionAdapterContractReceipt?.id ||
      receipt.github_check_run_observation_receipt_id === latestEvalGithubCheckRunObservationReceipt?.id ||
      receipt.github_pr_observation_receipt_id === latestEvalGithubPrObservationReceipt?.id ||
      receipt.github_pr_verification_receipt_id === latestEvalGithubPrVerificationReceipt?.id ||
      receipt.external_ci_result_receipt_id === latestEvalExternalCiResultReceipt?.id ||
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalBranchProtectionReadbackAdapterContractReceipt = evalBranchProtectionReadbackAdapterContractReceipts.find((receipt) => (
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.operator_merge_completion_gate_receipt_id === latestEvalOperatorMergeCompletionGateReceipt?.id ||
      receipt.merge_execution_adapter_contract_receipt_id === latestEvalMergeExecutionAdapterContractReceipt?.id ||
      receipt.github_check_run_observation_receipt_id === latestEvalGithubCheckRunObservationReceipt?.id ||
      receipt.github_pr_observation_receipt_id === latestEvalGithubPrObservationReceipt?.id ||
      receipt.github_pr_verification_receipt_id === latestEvalGithubPrVerificationReceipt?.id ||
      receipt.external_ci_result_receipt_id === latestEvalExternalCiResultReceipt?.id ||
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalTokenScopeObservationAdapterContractReceipt = evalTokenScopeObservationAdapterContractReceipts.find((receipt) => (
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.branch_protection_readback_adapter_contract_receipt_id === latestEvalBranchProtectionReadbackAdapterContractReceipt?.id ||
      receipt.operator_merge_completion_gate_receipt_id === latestEvalOperatorMergeCompletionGateReceipt?.id ||
      receipt.merge_execution_adapter_contract_receipt_id === latestEvalMergeExecutionAdapterContractReceipt?.id ||
      receipt.github_check_run_observation_receipt_id === latestEvalGithubCheckRunObservationReceipt?.id ||
      receipt.github_pr_observation_receipt_id === latestEvalGithubPrObservationReceipt?.id ||
      receipt.github_pr_verification_receipt_id === latestEvalGithubPrVerificationReceipt?.id ||
      receipt.external_ci_result_receipt_id === latestEvalExternalCiResultReceipt?.id ||
      receipt.pr_external_verification_receipt_id === latestEvalPrExternalVerificationReceipt?.id ||
      receipt.submitted_pr_evidence_receipt_id === latestEvalSubmittedPrEvidenceReceipt?.id ||
      receipt.operator_merge_approval_receipt_id === latestEvalOperatorMergeApprovalReceipt?.id ||
      receipt.pr_open_simulation_receipt_id === latestEvalPrOpenSimulationReceipt?.id ||
      receipt.pr_merge_proposal_receipt_id === latestEvalPrMergeProposalReceipt?.id ||
      receipt.generated_artifact_promotion_receipt_id === latestEvalGeneratedArtifactPromotionReceipt?.id ||
      receipt.ci_workflow_publication_receipt_id === latestEvalCiWorkflowPublicationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalSecretRedactionProofReceipt = evalSecretRedactionProofReceipts.find((receipt) => (
      receipt.token_scope_observation_adapter_contract_receipt_id === latestEvalTokenScopeObservationAdapterContractReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.branch_protection_readback_adapter_contract_receipt_id === latestEvalBranchProtectionReadbackAdapterContractReceipt?.id ||
      receipt.operator_merge_completion_gate_receipt_id === latestEvalOperatorMergeCompletionGateReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueReadbackAdapterContractReceipt = evalMergeQueueReadbackAdapterContractReceipts.find((receipt) => (
      receipt.secret_redaction_proof_receipt_id === latestEvalSecretRedactionProofReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.token_scope_observation_adapter_contract_receipt_id === latestEvalTokenScopeObservationAdapterContractReceipt?.id ||
      receipt.branch_protection_readback_adapter_contract_receipt_id === latestEvalBranchProtectionReadbackAdapterContractReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueLiveReadReconciliationReceipt = evalMergeQueueLiveReadReconciliationReceipts.find((receipt) => (
      receipt.merge_queue_readback_adapter_contract_receipt_id === latestEvalMergeQueueReadbackAdapterContractReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.secret_redaction_proof_receipt_id === latestEvalSecretRedactionProofReceipt?.id ||
      receipt.token_scope_observation_adapter_contract_receipt_id === latestEvalTokenScopeObservationAdapterContractReceipt?.id ||
      receipt.branch_protection_readback_adapter_contract_receipt_id === latestEvalBranchProtectionReadbackAdapterContractReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueLiveReadAdapterContractReceipt = evalMergeQueueLiveReadAdapterContractReceipts.find((receipt) => (
      receipt.merge_queue_live_read_reconciliation_receipt_id === latestEvalMergeQueueLiveReadReconciliationReceipt?.id ||
      receipt.merge_queue_readback_adapter_contract_receipt_id === latestEvalMergeQueueReadbackAdapterContractReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.secret_redaction_proof_receipt_id === latestEvalSecretRedactionProofReceipt?.id ||
      receipt.token_scope_observation_adapter_contract_receipt_id === latestEvalTokenScopeObservationAdapterContractReceipt?.id ||
      receipt.branch_protection_readback_adapter_contract_receipt_id === latestEvalBranchProtectionReadbackAdapterContractReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueLiveReadReadinessReceipt = evalMergeQueueLiveReadReadinessReceipts.find((receipt) => (
      receipt.merge_queue_live_read_adapter_contract_receipt_id === latestEvalMergeQueueLiveReadAdapterContractReceipt?.id ||
      receipt.merge_queue_live_read_reconciliation_receipt_id === latestEvalMergeQueueLiveReadReconciliationReceipt?.id ||
      receipt.merge_queue_readback_adapter_contract_receipt_id === latestEvalMergeQueueReadbackAdapterContractReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.secret_redaction_proof_receipt_id === latestEvalSecretRedactionProofReceipt?.id ||
      receipt.token_scope_observation_adapter_contract_receipt_id === latestEvalTokenScopeObservationAdapterContractReceipt?.id ||
      receipt.branch_protection_readback_adapter_contract_receipt_id === latestEvalBranchProtectionReadbackAdapterContractReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueCredentialHandoffReceipt = evalMergeQueueCredentialHandoffReceipts.find((receipt) => (
      receipt.merge_queue_live_read_readiness_receipt_id === latestEvalMergeQueueLiveReadReadinessReceipt?.id ||
      receipt.merge_queue_live_read_adapter_contract_receipt_id === latestEvalMergeQueueLiveReadAdapterContractReceipt?.id ||
      receipt.merge_queue_live_read_reconciliation_receipt_id === latestEvalMergeQueueLiveReadReconciliationReceipt?.id ||
      receipt.merge_queue_readback_adapter_contract_receipt_id === latestEvalMergeQueueReadbackAdapterContractReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.secret_redaction_proof_receipt_id === latestEvalSecretRedactionProofReceipt?.id ||
      receipt.token_scope_observation_adapter_contract_receipt_id === latestEvalTokenScopeObservationAdapterContractReceipt?.id ||
      receipt.branch_protection_readback_adapter_contract_receipt_id === latestEvalBranchProtectionReadbackAdapterContractReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueLiveReadPreflightReceipt = evalMergeQueueLiveReadPreflightReceipts.find((receipt) => (
      receipt.merge_queue_credential_handoff_receipt_id === latestEvalMergeQueueCredentialHandoffReceipt?.id ||
      receipt.merge_queue_live_read_readiness_receipt_id === latestEvalMergeQueueLiveReadReadinessReceipt?.id ||
      receipt.merge_queue_live_read_adapter_contract_receipt_id === latestEvalMergeQueueLiveReadAdapterContractReceipt?.id ||
      receipt.merge_queue_live_read_reconciliation_receipt_id === latestEvalMergeQueueLiveReadReconciliationReceipt?.id ||
      receipt.merge_queue_readback_adapter_contract_receipt_id === latestEvalMergeQueueReadbackAdapterContractReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.secret_redaction_proof_receipt_id === latestEvalSecretRedactionProofReceipt?.id ||
      receipt.token_scope_observation_adapter_contract_receipt_id === latestEvalTokenScopeObservationAdapterContractReceipt?.id ||
      receipt.branch_protection_readback_adapter_contract_receipt_id === latestEvalBranchProtectionReadbackAdapterContractReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueTokenQuarantineReceipt = evalMergeQueueTokenQuarantineReceipts.find((receipt) => (
      receipt.merge_queue_live_read_preflight_receipt_id === latestEvalMergeQueueLiveReadPreflightReceipt?.id ||
      receipt.merge_queue_credential_handoff_receipt_id === latestEvalMergeQueueCredentialHandoffReceipt?.id ||
      receipt.merge_queue_live_read_readiness_receipt_id === latestEvalMergeQueueLiveReadReadinessReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueLiveReadResponseIngestionReceipt = evalMergeQueueLiveReadResponseIngestionReceipts.find((receipt) => (
      receipt.merge_queue_token_quarantine_receipt_id === latestEvalMergeQueueTokenQuarantineReceipt?.id ||
      receipt.merge_queue_live_read_preflight_receipt_id === latestEvalMergeQueueLiveReadPreflightReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueRuntimeTokenReleaseGateReceipt = evalMergeQueueRuntimeTokenReleaseGateReceipts.find((receipt) => (
      receipt.merge_queue_live_read_response_ingestion_receipt_id === latestEvalMergeQueueLiveReadResponseIngestionReceipt?.id ||
      receipt.merge_queue_token_quarantine_receipt_id === latestEvalMergeQueueTokenQuarantineReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueLiveReadVerificationPromotionReceipt = evalMergeQueueLiveReadVerificationPromotionReceipts.find((receipt) => (
      receipt.merge_queue_runtime_token_release_gate_receipt_id === latestEvalMergeQueueRuntimeTokenReleaseGateReceipt?.id ||
      receipt.merge_queue_live_read_response_ingestion_receipt_id === latestEvalMergeQueueLiveReadResponseIngestionReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt = evalMergeQueueLiveHttpExecutionPreflightHandoffReceipts.find((receipt) => (
      receipt.merge_queue_live_read_verification_promotion_receipt_id === latestEvalMergeQueueLiveReadVerificationPromotionReceipt?.id ||
      receipt.merge_queue_runtime_token_release_gate_receipt_id === latestEvalMergeQueueRuntimeTokenReleaseGateReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt = evalMergeQueueLiveHttpOperatorReleaseAckReceipts.find((receipt) => (
      receipt.merge_queue_live_http_execution_preflight_handoff_receipt_id === latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt?.id ||
      receipt.merge_queue_live_read_verification_promotion_receipt_id === latestEvalMergeQueueLiveReadVerificationPromotionReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt = evalMergeQueueRuntimeSecretProviderSmokeReadinessReceipts.find((receipt) => (
      receipt.merge_queue_live_http_operator_release_ack_receipt_id === latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt?.id ||
      receipt.merge_queue_live_http_execution_preflight_handoff_receipt_id === latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt = evalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipts.find((receipt) => (
      receipt.merge_queue_runtime_secret_provider_smoke_readiness_receipt_id === latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt?.id ||
      receipt.merge_queue_live_http_operator_release_ack_receipt_id === latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt = evalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipts.find((receipt) => (
      receipt.merge_queue_runtime_secret_provider_smoke_execution_gate_receipt_id === latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt?.id ||
      receipt.merge_queue_runtime_secret_provider_smoke_readiness_receipt_id === latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt = evalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipts.find((receipt) => (
      receipt.merge_queue_runtime_secret_provider_smoke_evidence_review_receipt_id === latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt?.id ||
      receipt.merge_queue_runtime_secret_provider_smoke_execution_gate_receipt_id === latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt = evalMergeQueueSuccessfulSmokeEvidenceIngestionReceipts.find((receipt) => (
      receipt.merge_queue_memory_only_runtime_token_release_preflight_receipt_id === latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt?.id ||
      receipt.merge_queue_runtime_secret_provider_smoke_evidence_review_receipt_id === latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt = evalMergeQueueRuntimeTokenReleaseDenialReceipts.find((receipt) => (
      receipt.merge_queue_successful_smoke_evidence_ingestion_receipt_id === latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt?.id ||
      receipt.merge_queue_memory_only_runtime_token_release_preflight_receipt_id === latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt = evalMergeQueueFakeLiveReadReplayQuarantineReceipts.find((receipt) => (
      receipt.merge_queue_runtime_token_release_denial_receipt_id === latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueFinalBlockerLedgerReceipt = evalMergeQueueFinalBlockerLedgerReceipts.find((receipt) => (
      receipt.merge_queue_fake_live_read_replay_quarantine_receipt_id === latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt = evalMergeQueuePostLedgerOperatorReleaseAttestationReceipts.find((receipt) => (
      receipt.merge_queue_final_blocker_ledger_receipt_id === latestEvalMergeQueueFinalBlockerLedgerReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueuePostAttestationReleaseEscrowReceipt = evalMergeQueuePostAttestationReleaseEscrowReceipts.find((receipt) => (
      receipt.merge_queue_post_ledger_operator_release_attestation_receipt_id === latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const latestEvalMergeQueueReleaseDenialCloseoutReceipt = evalMergeQueueReleaseDenialCloseoutReceipts.find((receipt) => (
      receipt.merge_queue_post_attestation_release_escrow_receipt_id === latestEvalMergeQueuePostAttestationReleaseEscrowReceipt?.id ||
      receipt.live_merge_authorization_receipt_id === latestEvalLiveMergeAuthorizationReceipt?.id ||
      receipt.learning_record_id === latestPublicationReceipt?.learning_record_id ||
      (receipt.service_business_id === queue.service_business_id && receipt.eval_key === latestPublicationReceipt?.eval_key)
    )) || null;
    const activeOperatorCount = new Set(activeAssignments.map((item) => item.operator_id).filter(Boolean)).size || activeAssignments.length;
    const service = services.get(queue.service_business_id);
    return {
      queue,
      queueItems,
      claimableItem,
      activeAssignment: activeAssignments[0] || null,
      activeCount: activeAssignments.length,
      activeOperatorCount,
      expiredCount: expiredAssignments.length,
      latestReceipt,
      latestCloseout,
      latestPublicationReceipt,
      evalFixtureWorkItemCount: evalFixtureItemsForPublication.length,
      latestFixtureRunnerReceipt,
      latestFixtureApprovalReceipt,
      latestGoldenFixtureReviewReceipt,
      latestNonLiveRunnerBindingReceipt,
      latestEvalFileDryRunManifest,
      latestEvalCiWriteAccessReceipt,
      latestEvalLiveAdapterReadinessReceipt,
      latestEvalLiveAdapterContractTestReceipt,
      latestEvalCiWorkflowPublicationReceipt,
      latestEvalGeneratedArtifactPromotionReceipt,
      latestEvalPrMergeProposalReceipt,
      latestEvalPrOpenSimulationReceipt,
      latestEvalOperatorMergeApprovalReceipt,
      latestEvalSubmittedPrEvidenceReceipt,
      latestEvalPrExternalVerificationReceipt,
      latestEvalExternalCiResultReceipt,
      latestEvalGithubPrVerificationReceipt,
      latestEvalGithubPrObservationReceipt,
      latestEvalGithubCheckRunObservationReceipt,
      latestEvalMergeExecutionAdapterContractReceipt,
      latestEvalOperatorMergeCompletionGateReceipt,
      latestEvalLiveMergeAuthorizationReceipt,
      latestEvalBranchProtectionReadbackAdapterContractReceipt,
      latestEvalTokenScopeObservationAdapterContractReceipt,
      latestEvalSecretRedactionProofReceipt,
      latestEvalMergeQueueReadbackAdapterContractReceipt,
      latestEvalMergeQueueLiveReadReconciliationReceipt,
      latestEvalMergeQueueLiveReadAdapterContractReceipt,
      latestEvalMergeQueueLiveReadReadinessReceipt,
      latestEvalMergeQueueCredentialHandoffReceipt,
      latestEvalMergeQueueLiveReadPreflightReceipt,
      latestEvalMergeQueueTokenQuarantineReceipt,
      latestEvalMergeQueueLiveReadResponseIngestionReceipt,
      latestEvalMergeQueueRuntimeTokenReleaseGateReceipt,
      latestEvalMergeQueueLiveReadVerificationPromotionReceipt,
      latestEvalMergeQueueLiveHttpExecutionPreflightHandoffReceipt,
      latestEvalMergeQueueLiveHttpOperatorReleaseAckReceipt,
      latestEvalMergeQueueRuntimeSecretProviderSmokeReadinessReceipt,
      latestEvalMergeQueueRuntimeSecretProviderSmokeExecutionGateReceipt,
      latestEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceipt,
      latestEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceipt,
      latestEvalMergeQueueSuccessfulSmokeEvidenceIngestionReceipt,
      latestEvalMergeQueueRuntimeTokenReleaseDenialReceipt,
      latestEvalMergeQueueFakeLiveReadReplayQuarantineReceipt,
      latestEvalMergeQueueFinalBlockerLedgerReceipt,
      latestEvalMergeQueuePostLedgerOperatorReleaseAttestationReceipt,
      latestEvalMergeQueuePostAttestationReleaseEscrowReceipt,
      latestEvalMergeQueueReleaseDenialCloseoutReceipt,
      latestStaffingReceipt,
      slaTargetMinutes: operatorQueueSlaTargetMinutes(roleKey),
      nextLaneKey: claimableItem?.lane_key || queue.evidence?.laneKeys?.[0] || null,
      serviceBusinessName: service?.brand_name || service?.name || queue.service_business_id
    };
  });
}

function operatorQueueSlaTargetMinutes(roleKey) {
  const role = String(roleKey || '').toLowerCase();
  if (role === 'customer_success') return 15;
  if (role === 'provider_ops' || role === 'vendor_coordinator') return 20;
  if (role === 'compliance_reviewer') return 60;
  return 30;
}

function buildBlockerActions(snapshot) {
  if (!snapshot) return [];
  const actions = [];
  for (const approval of snapshot.approvals || []) {
    if (approval.status === 'approved') continue;
    actions.push({
      actionId: `approval:${approval.id}`,
      type: 'approval',
      id: approval.id,
      label: formatLabel(approval.kind),
      summary: `${formatLabel(approval.entity_type)} ${approval.entity_id} is ${formatLabel(approval.status)}.`,
      cta: 'Approve'
    });
  }
  for (const link of snapshot.providerLinks || []) {
    if (isReadyPortfolioStatus(link.status)) continue;
    actions.push({
      actionId: `provider:${link.id}`,
      type: 'provider',
      id: link.id,
      label: link.provider,
      summary: `${link.account_key} is ${formatLabel(link.status)}.`,
      cta: 'Activate'
    });
  }
  for (const vendor of snapshot.vendors || []) {
    if (isReadyPortfolioStatus(vendor.status)) continue;
    actions.push({
      actionId: `vendor:${vendor.id}`,
      type: 'vendor',
      id: vendor.id,
      label: vendor.name,
      summary: `Vendor bench is ${formatLabel(vendor.status)}.`,
      cta: 'Activate'
    });
  }
  for (const payment of snapshot.portfolioPayments || []) {
    if (['authorized', 'paid', 'succeeded', 'completed'].includes(payment.status)) continue;
    actions.push({
      actionId: `payment:${payment.id}`,
      type: 'payment',
      id: payment.id,
      label: payment.provider,
      summary: `${formatMoney(payment.amount_cents)} payment is ${formatLabel(payment.status)}.`,
      cta: 'Authorize'
    });
  }
  for (const incident of snapshot.incidents || []) {
    if (['resolved', 'closed', 'cancelled'].includes(incident.status)) continue;
    actions.push({
      actionId: `incident:${incident.id}`,
      type: 'incident',
      id: incident.id,
      label: formatLabel(incident.severity),
      summary: incident.summary,
      cta: 'Resolve'
    });
  }
  return actions;
}

function isReadyPortfolioStatus(status) {
  return ['active', 'approved', 'verified', 'ready', 'ok', 'connected', 'live', 'contracted'].includes(String(status || '').toLowerCase());
}

function decisionTone(decision) {
  if (['launch_candidate', 'launch_now', 'scale'].includes(decision)) return 'good';
  if (['avoid', 'blocked', 'pause', 'shut_down'].includes(decision)) return 'bad';
  return 'warm';
}

function commandTone(status) {
  if (['ready_for_live_preflight', 'ready', 'cleared'].includes(status)) return 'good';
  if (['blocked', 'failed', 'rolled_back'].includes(status)) return 'bad';
  return 'warm';
}

function formatRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n * 100)}%`;
}

function formatPercentInterval(interval) {
  if (!interval) return '-';
  return `${formatRatio(interval.low)}-${formatRatio(interval.high)}`;
}

function formatMoney(value) {
  const cents = Number(value);
  if (!Number.isFinite(cents)) return '-';
  return `$${Math.round(cents / 100).toLocaleString()}`;
}

function formatMoneyInterval(interval) {
  if (!interval) return '-';
  return `${formatMoney(interval.low)}-${formatMoney(interval.high)}`;
}

function formatTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  return new Date(n).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatLiveReleaseQueueReviewReceipt(receipt = {}) {
  const filterSummary = receipt.filterSummary || receipt.filter_summary || {};
  const checksum = String(receipt.checksum || '').slice(0, 12) || 'no checksum';
  const lane = filterSummary.staleOnly
    ? 'Stale blockers'
    : filterSummary.denialReason
      ? formatLabel(filterSummary.denialReason)
      : filterSummary.urgencyBand
        ? formatLabel(filterSummary.urgencyBand)
        : 'All blockers';
  return `${lane} · sha256 ${checksum} · ${formatTime(receipt.updated_at || receipt.updatedAt || receipt.created_at || receipt.createdAt)}`;
}

function formatLiveReleaseQueueReviewComparison(comparison = {}) {
  const current = String(comparison.currentChecksum || '').slice(0, 12) || 'no checksum';
  const latest = String(comparison.latestAcknowledgedChecksum || '').slice(0, 12);
  if (comparison.status === 'matches_latest_acknowledgement') {
    return `Current export matches latest acknowledgement · sha256 ${current}`;
  }
  if (comparison.status === 'changed_since_latest_acknowledgement') {
    return `Current export changed since acknowledgement · sha256 ${current} vs ${latest || 'none'}`;
  }
  return `Current export has no acknowledgement · sha256 ${current}`;
}

function formatLabel(value) {
  return String(value || '-').replace(/[_-]+/g, ' ');
}
