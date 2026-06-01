async function jsonOr(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

const ADMIN_TOKEN_KEY = 'callan.adminToken';
const ADMIN_COOKIE_NAME = 'callan_admin_token';
const ADMIN_TOKEN_EVENT = 'callan-admin-token-changed';

function bundledAdminToken() {
  return import.meta.env?.VITE_ADMIN_API_TOKEN || '';
}

function adminToken() {
  if (typeof window === 'undefined') return bundledAdminToken();
  const token = window.localStorage.getItem(ADMIN_TOKEN_KEY) || bundledAdminToken();
  syncAdminCookie(token);
  return token;
}

async function call(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  const token = adminToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await jsonOr(res);
  if (!res.ok) {
    const msg = data?.error?.formErrors?.[0] || data?.error || res.statusText;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

export const api = {
  getAdminToken: adminToken,
  setAdminToken: (token = '') => {
    if (typeof window === 'undefined') return;
    const value = String(token || '').trim();
    if (value) window.localStorage.setItem(ADMIN_TOKEN_KEY, value);
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    syncAdminCookie(value);
    window.dispatchEvent(new CustomEvent(ADMIN_TOKEN_EVENT, { detail: { configured: Boolean(value) } }));
  },
  health: () => call('GET', '/api/health'),
  listLeads: () => call('GET', '/api/leads'),
  getLead: (id) => call('GET', `/api/leads/${id}`),
  getLeadTrust: (id) => call('GET', `/api/leads/${id}/trust`),
  listHandoffCases: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/handoff/cases${q.toString() ? `?${q}` : ''}`);
  },
  getLeadHandoff: (id) => call('GET', `/api/leads/${id}/handoff`),
  handoffAction: (caseId, body = {}) => call('POST', `/api/handoff/cases/${caseId}/actions`, body),
  listReasoningTraces: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/reasoning/traces${q.toString() ? `?${q}` : ''}`);
  },
  getLeadReasoning: (id) => call('GET', `/api/leads/${id}/reasoning`),
  discover: ({ niche, city, count }) => call('POST', '/api/leads/discover', { niche, city, count }),
  startCall: (id, body = {}) => call('POST', `/api/leads/${id}/call`, body),
  approveLiveCall: (id) => call('POST', `/api/leads/${id}/approve-live-call`, {}),
  blockLead: (id, body = {}) => call('POST', `/api/leads/${id}/block`, body),
  optOutLead: (id, body = {}) => call('POST', `/api/leads/${id}/opt-out`, body),
  forceRetry: (id, body = {}) => call('POST', `/api/leads/${id}/force-retry`, body),
  explainCallability: (id) => call('GET', `/api/leads/${id}/callability`),
  followup: (id, toEmail) => call('POST', `/api/leads/${id}/followup`, { toEmail }),
  build: (id, body = {}) => call('POST', `/api/leads/${id}/build`, body),
  getGrowth: (id) => call('GET', `/api/leads/${id}/growth`),
  generateGrowthPlan: (id, body = {}) => call('POST', `/api/leads/${id}/growth/plan`, body),
  sendGrowthFollowup: (id, body = {}) => call('POST', `/api/leads/${id}/growth/followup`, body),
  getAccountManager: (id) => call('GET', `/api/leads/${id}/account-manager`),
  generateAccountManagerPlan: (id, body = {}) => call('POST', `/api/leads/${id}/account-manager/plan`, body),
  runAccountManager: (id, body = {}) => call('POST', `/api/leads/${id}/account-manager/run`, body),
  explainAccountTask: (id) => call('GET', `/api/account-tasks/${id}/explain`),
  escalateAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/escalate`, body),
  recordAccountOperatorBoardLifecycle: (id, body = {}) => call('POST', `/api/account-operator-board/work-items/${id}/lifecycle`, body),
  claimAccountOperatorBoardWorkItem: (id, body = {}) => call('POST', `/api/account-operator-board/work-items/${id}/claim`, body),
  resolveAccountOperatorBoardWorkItem: (id, body = {}) => call('POST', `/api/account-operator-board/work-items/${id}/resolve`, body),
  recordAccountOperatorBoardRetentionFeedback: (id, body = {}) => call('POST', `/api/account-operator-board/lifecycle-receipts/${id}/retention-feedback`, body),
  approveAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/approve`, body),
  sendAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/send`, body),
  pauseAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/pause`, body),
  completeAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/complete`, body),
  reassignAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/reassign`, body),
  getCommerce: (id) => call('GET', `/api/leads/${id}/commerce`),
  planCommerce: (id, body = {}) => call('POST', `/api/leads/${id}/commerce/plan`, body),
  outreachStatus: () => call('GET', '/api/outreach/status'),
  startOutreach: () => call('POST', '/api/outreach/start', {}),
  stopOutreach: () => call('POST', '/api/outreach/stop', {}),
  pauseOutreach: (reason = 'operator_pause') => call('POST', '/api/outreach/pause', { reason }),
  resumeOutreach: (reason = 'operator_resume') => call('POST', '/api/outreach/resume', { reason }),
  emergencyStop: (reason = 'emergency_stop') => call('POST', '/api/emergency-stop', { reason }),
  scheduledCalls: () => call('GET', '/api/scheduled-calls'),
  cancelScheduledCall: (id, reason = 'operator_cancel') => call('POST', `/api/scheduled-calls/${id}/cancel`, { reason }),
  fireScheduledCallNow: (id, reason = 'operator_fire_now') => call('POST', `/api/scheduled-calls/${id}/fire`, { reason }),
  experiments: () => call('GET', '/api/experiments'),
  economicsByNiche: () => call('GET', '/api/economics/by-niche'),
  opsCommandCenter: () => call('GET', '/api/ops/command-center'),
  opsObservability: () => call('GET', '/api/ops/observability'),
  portfolioOperatingModel: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/portfolio/operating-model${q.toString() ? `?${q}` : ''}`);
  },
  aggregatePortfolioMarketOpportunities: (body = {}) => call('POST', '/api/portfolio/market-opportunities/aggregate', body),
  planPortfolioLaunch: (opportunityId, body = {}) => call('POST', `/api/portfolio/market-opportunities/${encodeURIComponent(opportunityId)}/plan-launch`, body),
  recordPortfolioMarketOutcome: (opportunityId, body = {}) => call('POST', `/api/portfolio/market-opportunities/${encodeURIComponent(opportunityId)}/record-outcome`, body),
  evaluatePortfolioGates: (serviceBusinessId, body = {}) => call('POST', `/api/portfolio/service-businesses/${encodeURIComponent(serviceBusinessId)}/evaluate-gates`, body),
  launchPortfolioServiceBusiness: (serviceBusinessId, body = {}) => call('POST', `/api/portfolio/service-businesses/${encodeURIComponent(serviceBusinessId)}/launch`, body),
  recordPortfolioAcquisitionAttempt: (serviceBusinessId, body = {}) => call('POST', `/api/portfolio/service-businesses/${encodeURIComponent(serviceBusinessId)}/acquisition-attempts`, body),
  refreshPortfolioAcquisitionStrategy: (serviceBusinessId, body = {}) => call('POST', `/api/portfolio/service-businesses/${encodeURIComponent(serviceBusinessId)}/refresh-acquisition-strategy`, body),
  listPortfolioOperatorInbox: (serviceBusinessId, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/portfolio/service-businesses/${encodeURIComponent(serviceBusinessId)}/operator-inbox${q.toString() ? `?${q}` : ''}`);
  },
  recordPortfolioOperatorInboxReceipt: (itemId, body = {}) => call('POST', `/api/portfolio/operator-inbox/${encodeURIComponent(itemId)}/receipt`, body),
  claimPortfolioOperatorInboxItem: (itemId, body = {}) => call('POST', `/api/portfolio/operator-inbox/${encodeURIComponent(itemId)}/claim`, body),
  releasePortfolioOperatorInboxItem: (itemId, body = {}) => call('POST', `/api/portfolio/operator-inbox/${encodeURIComponent(itemId)}/release`, body),
  expirePortfolioOperatorInboxLeases: (body = {}) => call('POST', '/api/portfolio/operator-inbox/expire-leases', body),
  listPortfolioOperatorAssignmentQueues: (serviceBusinessId, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/portfolio/service-businesses/${encodeURIComponent(serviceBusinessId)}/operator-assignment-queues${q.toString() ? `?${q}` : ''}`);
  },
  recordPortfolioOperatorStaffingAnalytics: (serviceBusinessId, body = {}) => call('POST', `/api/portfolio/service-businesses/${encodeURIComponent(serviceBusinessId)}/operator-staffing-analytics`, body),
  recordPortfolioOperatorBulkReview: (serviceBusinessId, body = {}) => call('POST', `/api/portfolio/service-businesses/${encodeURIComponent(serviceBusinessId)}/operator-bulk-review`, body),
  closeoutPortfolioOperatorHandoffEval: (bulkReviewReceiptId, body = {}) => call('POST', `/api/portfolio/operator-bulk-review-receipts/${encodeURIComponent(bulkReviewReceiptId)}/eval-closeout`, body),
  recordPortfolioEvalPublicationGate: (closeoutId, body = {}) => call('POST', `/api/portfolio/operator-handoff-eval-closeouts/${encodeURIComponent(closeoutId)}/publication-gate`, body),
  recordPortfolioEvalFixtureWorkItems: (publicationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-publication-receipts/${encodeURIComponent(publicationReceiptId)}/fixture-work-items`, body),
  recordPortfolioEvalFixtureRunnerDryRun: (publicationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-publication-receipts/${encodeURIComponent(publicationReceiptId)}/fixture-runner-dry-run`, body),
  recordPortfolioEvalFixtureApproval: (runnerReceiptId, body = {}) => call('POST', `/api/portfolio/eval-fixture-runner-receipts/${encodeURIComponent(runnerReceiptId)}/fixture-approval`, body),
  recordPortfolioEvalGoldenFixtureReview: (approvalReceiptId, body = {}) => call('POST', `/api/portfolio/eval-fixture-approval-receipts/${encodeURIComponent(approvalReceiptId)}/golden-fixture-review`, body),
  recordPortfolioEvalNonLiveRunnerBinding: (goldenReviewReceiptId, body = {}) => call('POST', `/api/portfolio/eval-golden-fixture-review-receipts/${encodeURIComponent(goldenReviewReceiptId)}/non-live-runner-binding`, body),
  recordPortfolioEvalFileDryRunManifest: (runnerBindingReceiptId, body = {}) => call('POST', `/api/portfolio/eval-non-live-runner-binding-receipts/${encodeURIComponent(runnerBindingReceiptId)}/file-dry-run-manifest`, body),
  recordPortfolioEvalCiWriteAccessProof: (fileManifestId, body = {}) => call('POST', `/api/portfolio/eval-file-dry-run-manifests/${encodeURIComponent(fileManifestId)}/ci-write-access-proof`, body),
  recordPortfolioEvalLiveAdapterReadiness: (ciWriteReceiptId, body = {}) => call('POST', `/api/portfolio/eval-ci-write-access-receipts/${encodeURIComponent(ciWriteReceiptId)}/live-adapter-readiness`, body),
  recordPortfolioEvalLiveAdapterContractTest: (liveAdapterReadinessReceiptId, body = {}) => call('POST', `/api/portfolio/eval-live-adapter-readiness-receipts/${encodeURIComponent(liveAdapterReadinessReceiptId)}/contract-test`, body),
  recordPortfolioEvalCiWorkflowPublication: (contractTestReceiptId, body = {}) => call('POST', `/api/portfolio/eval-live-adapter-contract-test-receipts/${encodeURIComponent(contractTestReceiptId)}/ci-workflow-publication`, body),
  recordPortfolioEvalGeneratedArtifactPromotion: (ciWorkflowPublicationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-ci-workflow-publication-receipts/${encodeURIComponent(ciWorkflowPublicationReceiptId)}/generated-eval-promotion`, body),
  recordPortfolioEvalPrMergeProposalGate: (generatedArtifactPromotionReceiptId, body = {}) => call('POST', `/api/portfolio/eval-generated-artifact-promotion-receipts/${encodeURIComponent(generatedArtifactPromotionReceiptId)}/pr-merge-proposal`, body),
  recordPortfolioEvalPrOpenSimulation: (prMergeProposalReceiptId, body = {}) => call('POST', `/api/portfolio/eval-pr-merge-proposal-receipts/${encodeURIComponent(prMergeProposalReceiptId)}/pr-open-simulation`, body),
  recordPortfolioEvalOperatorMergeApprovalReview: (prOpenSimulationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-pr-open-simulation-receipts/${encodeURIComponent(prOpenSimulationReceiptId)}/operator-merge-approval`, body),
  recordPortfolioEvalSubmittedPrEvidence: (operatorMergeApprovalReceiptId, body = {}) => call('POST', `/api/portfolio/eval-operator-merge-approval-receipts/${encodeURIComponent(operatorMergeApprovalReceiptId)}/submitted-pr-evidence`, body),
  recordPortfolioEvalPrExternalVerification: (submittedPrEvidenceReceiptId, body = {}) => call('POST', `/api/portfolio/eval-submitted-pr-evidence-receipts/${encodeURIComponent(submittedPrEvidenceReceiptId)}/pr-external-verification`, body),
  recordPortfolioEvalExternalCiResult: (prExternalVerificationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-pr-external-verification-receipts/${encodeURIComponent(prExternalVerificationReceiptId)}/external-ci-result`, body),
  recordPortfolioEvalGithubPrVerification: (externalCiResultReceiptId, body = {}) => call('POST', `/api/portfolio/eval-external-ci-result-receipts/${encodeURIComponent(externalCiResultReceiptId)}/github-pr-verification`, body),
  recordPortfolioEvalGithubPrObservation: (githubPrVerificationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-github-pr-verification-receipts/${encodeURIComponent(githubPrVerificationReceiptId)}/observation-contract`, body),
  recordPortfolioEvalGithubCheckRunObservation: (githubPrObservationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-github-pr-observation-receipts/${encodeURIComponent(githubPrObservationReceiptId)}/check-run-observation`, body),
  recordPortfolioEvalMergeExecutionAdapterContract: (githubCheckRunObservationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-github-check-run-observation-receipts/${encodeURIComponent(githubCheckRunObservationReceiptId)}/merge-execution-adapter-contract`, body),
  recordPortfolioEvalOperatorMergeCompletionGate: (githubCheckRunObservationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-github-check-run-observation-receipts/${encodeURIComponent(githubCheckRunObservationReceiptId)}/operator-merge-completion`, body),
  recordPortfolioEvalLiveMergeAuthorization: (operatorMergeCompletionGateReceiptId, body = {}) => call('POST', `/api/portfolio/eval-operator-merge-completion-gate-receipts/${encodeURIComponent(operatorMergeCompletionGateReceiptId)}/live-merge-authorization`, body),
  recordPortfolioEvalBranchProtectionReadbackAdapterContract: (liveMergeAuthorizationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-live-merge-authorization-receipts/${encodeURIComponent(liveMergeAuthorizationReceiptId)}/branch-protection-readback-adapter-contract`, body),
  recordPortfolioEvalTokenScopeObservationAdapterContract: (liveMergeAuthorizationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-live-merge-authorization-receipts/${encodeURIComponent(liveMergeAuthorizationReceiptId)}/token-scope-observation-adapter-contract`, body),
  recordPortfolioEvalSecretRedactionProof: (tokenScopeObservationAdapterContractReceiptId, body = {}) => call('POST', `/api/portfolio/eval-token-scope-observation-adapter-contract-receipts/${encodeURIComponent(tokenScopeObservationAdapterContractReceiptId)}/secret-redaction-proof`, body),
  recordPortfolioEvalMergeQueueReadbackAdapterContract: (secretRedactionProofReceiptId, body = {}) => call('POST', `/api/portfolio/eval-secret-redaction-proof-receipts/${encodeURIComponent(secretRedactionProofReceiptId)}/merge-queue-readback-adapter-contract`, body),
  recordPortfolioEvalMergeQueueLiveReadReconciliation: (mergeQueueReadbackAdapterContractReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-readback-adapter-contract-receipts/${encodeURIComponent(mergeQueueReadbackAdapterContractReceiptId)}/live-read-reconciliation`, body),
  recordPortfolioEvalMergeQueueLiveReadAdapterContract: (mergeQueueLiveReadReconciliationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-live-read-reconciliation-receipts/${encodeURIComponent(mergeQueueLiveReadReconciliationReceiptId)}/live-read-adapter-contract`, body),
  recordPortfolioEvalMergeQueueLiveReadReadiness: (mergeQueueLiveReadAdapterContractReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-live-read-adapter-contract-receipts/${encodeURIComponent(mergeQueueLiveReadAdapterContractReceiptId)}/live-read-readiness`, body),
  recordPortfolioEvalMergeQueueCredentialHandoff: (mergeQueueLiveReadReadinessReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-live-read-readiness-receipts/${encodeURIComponent(mergeQueueLiveReadReadinessReceiptId)}/credential-handoff`, body),
  recordPortfolioEvalMergeQueueLiveReadPreflight: (mergeQueueCredentialHandoffReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-credential-handoff-receipts/${encodeURIComponent(mergeQueueCredentialHandoffReceiptId)}/live-read-preflight`, body),
  recordPortfolioEvalMergeQueueTokenQuarantine: (mergeQueueLiveReadPreflightReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-live-read-preflight-receipts/${encodeURIComponent(mergeQueueLiveReadPreflightReceiptId)}/token-quarantine`, body),
  recordPortfolioEvalMergeQueueLiveReadResponseIngestion: (mergeQueueTokenQuarantineReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-token-quarantine-receipts/${encodeURIComponent(mergeQueueTokenQuarantineReceiptId)}/live-read-response-ingestion`, body),
  recordPortfolioEvalMergeQueueRuntimeTokenReleaseGate: (mergeQueueLiveReadResponseIngestionReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-live-read-response-ingestion-receipts/${encodeURIComponent(mergeQueueLiveReadResponseIngestionReceiptId)}/runtime-token-release-gate`, body),
  recordPortfolioEvalMergeQueueLiveReadVerificationPromotion: (mergeQueueRuntimeTokenReleaseGateReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-runtime-token-release-gate-receipts/${encodeURIComponent(mergeQueueRuntimeTokenReleaseGateReceiptId)}/live-read-verification-promotion`, body),
  recordPortfolioEvalMergeQueueLiveHttpExecutionPreflightHandoff: (mergeQueueLiveReadVerificationPromotionReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-live-read-verification-promotion-receipts/${encodeURIComponent(mergeQueueLiveReadVerificationPromotionReceiptId)}/live-http-execution-preflight-handoff`, body),
  recordPortfolioEvalMergeQueueLiveHttpOperatorReleaseAck: (mergeQueueLiveHttpExecutionPreflightHandoffReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-live-http-execution-preflight-handoff-receipts/${encodeURIComponent(mergeQueueLiveHttpExecutionPreflightHandoffReceiptId)}/operator-release-ack`, body),
  recordPortfolioEvalMergeQueueRuntimeSecretProviderSmokeReadiness: (mergeQueueLiveHttpOperatorReleaseAckReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-live-http-operator-release-ack-receipts/${encodeURIComponent(mergeQueueLiveHttpOperatorReleaseAckReceiptId)}/runtime-secret-provider-smoke-readiness`, body),
  recordPortfolioEvalMergeQueueRuntimeSecretProviderSmokeExecutionGate: (mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-readiness-receipts/${encodeURIComponent(mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId)}/smoke-execution-gate`, body),
  recordPortfolioEvalMergeQueueRuntimeSecretProviderSmokeEvidenceReview: (mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-execution-gate-receipts/${encodeURIComponent(mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId)}/smoke-evidence-review`, body),
  recordPortfolioEvalMergeQueueMemoryOnlyRuntimeTokenReleasePreflight: (mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-runtime-secret-provider-smoke-evidence-review-receipts/${encodeURIComponent(mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId)}/memory-only-runtime-token-release-preflight`, body),
  recordPortfolioEvalMergeQueueSuccessfulSmokeEvidenceIngestion: (mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-memory-only-runtime-token-release-preflight-receipts/${encodeURIComponent(mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId)}/successful-smoke-evidence-ingestion`, body),
  recordPortfolioEvalMergeQueueRuntimeTokenReleaseDenial: (mergeQueueSuccessfulSmokeEvidenceIngestionReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-successful-smoke-evidence-ingestion-receipts/${encodeURIComponent(mergeQueueSuccessfulSmokeEvidenceIngestionReceiptId)}/runtime-token-release-denial`, body),
  recordPortfolioEvalMergeQueueFakeLiveReadReplayQuarantine: (mergeQueueRuntimeTokenReleaseDenialReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-runtime-token-release-denial-receipts/${encodeURIComponent(mergeQueueRuntimeTokenReleaseDenialReceiptId)}/fake-live-read-replay-quarantine`, body),
  recordPortfolioEvalMergeQueueFinalBlockerLedger: (mergeQueueFakeLiveReadReplayQuarantineReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-fake-live-read-replay-quarantine-receipts/${encodeURIComponent(mergeQueueFakeLiveReadReplayQuarantineReceiptId)}/final-blocker-ledger`, body),
  recordPortfolioEvalMergeQueuePostLedgerOperatorReleaseAttestation: (mergeQueueFinalBlockerLedgerReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-final-blocker-ledger-receipts/${encodeURIComponent(mergeQueueFinalBlockerLedgerReceiptId)}/post-ledger-operator-release-attestation`, body),
  recordPortfolioEvalMergeQueuePostAttestationReleaseEscrow: (mergeQueuePostLedgerOperatorReleaseAttestationReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-post-ledger-operator-release-attestation-receipts/${encodeURIComponent(mergeQueuePostLedgerOperatorReleaseAttestationReceiptId)}/post-attestation-release-escrow`, body),
  recordPortfolioEvalMergeQueueReleaseDenialCloseout: (mergeQueuePostAttestationReleaseEscrowReceiptId, body = {}) => call('POST', `/api/portfolio/eval-merge-queue-post-attestation-release-escrow-receipts/${encodeURIComponent(mergeQueuePostAttestationReleaseEscrowReceiptId)}/release-denial-closeout`, body),
  decidePortfolioAcquisitionAction: (actionId, body = {}) => call('POST', `/api/portfolio/acquisition-actions/${encodeURIComponent(actionId)}/decide`, body),
  executePortfolioAcquisitionAction: (actionId, body = {}) => call('POST', `/api/portfolio/acquisition-actions/${encodeURIComponent(actionId)}/execute`, body),
  rollbackPortfolioAcquisitionAction: (actionId, body = {}) => call('POST', `/api/portfolio/acquisition-actions/${encodeURIComponent(actionId)}/rollback`, body),
  preflightPortfolioAcquisitionAction: (actionId, body = {}) => call('POST', `/api/portfolio/acquisition-actions/${encodeURIComponent(actionId)}/preflight-live`, body),
  recordRetentionCommandWorkItems: (rollupId, body = {}) => call('POST', `/api/portfolio/retention-command-center/${encodeURIComponent(rollupId)}/work-items`, body),
  collectRetentionCommandWorkItemProofPacket: (rollupId, body = {}) => call('POST', `/api/portfolio/retention-command-center/${encodeURIComponent(rollupId)}/proof-packet`, body),
  decideRetentionCommandWorkItem: (workItemId, body = {}) => call('POST', `/api/portfolio/retention-command-work-items/${encodeURIComponent(workItemId)}/decide`, body),
  claimRetentionCommandWorkItem: (workItemId, body = {}) => call('POST', `/api/portfolio/retention-command-work-items/${encodeURIComponent(workItemId)}/claim`, body),
  releaseRetentionCommandWorkItem: (workItemId, body = {}) => call('POST', `/api/portfolio/retention-command-work-items/${encodeURIComponent(workItemId)}/release`, body),
  expireRetentionCommandWorkItemLease: (workItemId, body = {}) => call('POST', `/api/portfolio/retention-command-work-items/${encodeURIComponent(workItemId)}/expire-lease`, body),
  expireRetentionCommandWorkItemLeases: (body = {}) => call('POST', '/api/portfolio/retention-command-work-items/expire-leases', body),
  recordRetentionCommandLeaseMaintenance: (body = {}) => call('POST', '/api/portfolio/retention-command-work-items/lease-maintenance', body),
  planReadinessCommandCompensation: (reconciliationId, body = {}) => call('POST', `/api/portfolio/readiness-command-center/${encodeURIComponent(reconciliationId)}/plan-compensation`, body),
  recordReadinessCommandRetryReceipts: (reconciliationId, body = {}) => call('POST', `/api/portfolio/readiness-command-center/${encodeURIComponent(reconciliationId)}/record-retry-receipts`, body),
  submitReadinessCommandEvidence: (reconciliationId, body = {}) => call('POST', `/api/portfolio/readiness-command-center/${encodeURIComponent(reconciliationId)}/evidence`, body),
  recordReadinessProviderSmokeReceipt: (reconciliationId, body = {}) => call('POST', `/api/portfolio/readiness-command-center/${encodeURIComponent(reconciliationId)}/provider-smoke-receipt`, body),
  recordReadinessAdapterLedger: (reconciliationId, body = {}) => call('POST', `/api/portfolio/readiness-command-center/${encodeURIComponent(reconciliationId)}/adapter-ledger`, body),
  reconcileReadinessCommandCenter: (reconciliationId, body = {}) => call('POST', `/api/portfolio/readiness-command-center/${encodeURIComponent(reconciliationId)}/reconcile`, body),
  getPortfolioLiveReleaseBlockerQueue: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/portfolio/readiness-command-center/live-release-blockers${q.toString() ? `?${q}` : ''}`);
  },
  exportPortfolioLiveReleaseBlockerQueue: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/portfolio/readiness-command-center/live-release-blockers/export${q.toString() ? `?${q}` : ''}`);
  },
  listPortfolioLiveReleaseBlockerQueueExportReviews: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/portfolio/readiness-command-center/live-release-blockers/export-reviews${q.toString() ? `?${q}` : ''}`);
  },
  recordPortfolioLiveReleaseBlockerQueueExportReview: (body = {}) => call('POST', '/api/portfolio/readiness-command-center/live-release-blockers/export-review', body),
  exportPortfolioLiveExecuteDenial: (reconciliationId, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/portfolio/readiness-command-center/${encodeURIComponent(reconciliationId)}/live-execute-denial-export${q.toString() ? `?${q}` : ''}`);
  },
  decidePortfolioApproval: (approvalId, body = {}) => call('POST', `/api/portfolio/approvals/${encodeURIComponent(approvalId)}/decide`, body),
  updatePortfolioProviderLink: (providerLinkId, body = {}) => call('POST', `/api/portfolio/provider-links/${encodeURIComponent(providerLinkId)}/status`, body),
  updatePortfolioVendorPartner: (vendorId, body = {}) => call('POST', `/api/portfolio/vendor-partners/${encodeURIComponent(vendorId)}/status`, body),
  updatePortfolioPaymentStatus: (paymentId, body = {}) => call('POST', `/api/portfolio/payments/${encodeURIComponent(paymentId)}/status`, body),
  resolvePortfolioIncident: (incidentId, body = {}) => call('POST', `/api/portfolio/incidents/${encodeURIComponent(incidentId)}/resolve`, body),
  recoverStuckOps: (body = {}) => call('POST', '/api/ops/recover-stuck', body),
  enqueueOpsSelfCheck: (body = {}) => call('POST', '/api/ops/self-check', body),
  runRetentionCommandLeaseMaintenance: (body = {}) => call('POST', '/api/ops/retention-command-lease-maintenance', body),
  exportOps: ({ includePII = false, limit = 500 } = {}) => {
    const q = new URLSearchParams({
      includePII: includePII ? 'true' : 'false',
      limit: String(limit)
    });
    return call('GET', `/api/admin/export?${q}`);
  },
  backupOps: () => call('POST', '/api/admin/backup', {}),
  listBackups: () => call('GET', '/api/admin/backups'),
  resetMockData: ({ dryRun = true } = {}) => call('POST', '/api/admin/reset-mock-data', {
    confirm: 'RESET_MOCK_DATA',
    dryRun
  }),
  reputationStatus: () => call('GET', '/api/reputation/status'),
  referralsRollup: () => call('GET', '/api/referrals/rollup'),
  leadPriorities: () => call('GET', '/api/leads/priorities')
};

function syncAdminCookie(token = '') {
  if (typeof document === 'undefined') return;
  const secure = window.location?.protocol === 'https:' ? '; Secure' : '';
  if (!token) {
    document.cookie = `${ADMIN_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    return;
  }
  document.cookie = `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; SameSite=Lax${secure}`;
}
