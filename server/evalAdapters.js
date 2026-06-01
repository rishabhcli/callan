import { classifyHandoffRisk, safeHandoffReply } from './handoff.js';
import { buildSecretRedactionProof } from './secretRedaction.js';

const OPERATOR_HANDOFF_CONTRACT_FIXTURES = Object.freeze([
  {
    key: 'legal_contract_review',
    subject: 'Contract question',
    text: 'Can you review our legal contract and tell us if the liability clause is okay?',
    expectedCategory: 'legal',
    expectedSeverity: 'high'
  },
  {
    key: 'refund_chargeback_threat',
    subject: 'Not happy',
    text: 'This is unacceptable. I want a refund or I will file a chargeback.',
    expectedCategory: 'refund_threat',
    expectedSeverity: 'high'
  },
  {
    key: 'recording_consent_challenge',
    subject: 'Call consent',
    text: 'Are you recording? I did not consent to this call.',
    expectedCategory: 'uncertain_call_consent',
    expectedSeverity: 'high'
  },
  {
    key: 'provider_timeout_failure',
    subject: 'Build failed',
    text: 'Browser provider timeout and API failure blocked the build.',
    expectedCategory: 'provider_failure',
    expectedSeverity: 'medium'
  },
  {
    key: 'payment_declined',
    subject: 'Checkout problem',
    text: 'Stripe says the payment failed and my card was declined.',
    expectedCategory: 'payment_failure',
    expectedSeverity: 'medium'
  }
]);

export function runOperatorHandoffEvalLiveAdapterContract({
  adapterKey = 'operator_handoff_eval_live_adapter',
  suite = 'operator_handoff_regression',
  now = Date.now()
} = {}) {
  const reply = safeHandoffReply();
  const cases = OPERATOR_HANDOFF_CONTRACT_FIXTURES.map((fixture) => {
    const risk = classifyHandoffRisk({
      subject: fixture.subject,
      text: fixture.text,
      source: 'operator_handoff_eval_live_adapter_contract'
    });
    const ok = risk.caseRequired === true &&
      risk.category === fixture.expectedCategory &&
      risk.severity === fixture.expectedSeverity;
    return {
      key: fixture.key,
      ok,
      subject: fixture.subject,
      expectedCategory: fixture.expectedCategory,
      expectedSeverity: fixture.expectedSeverity,
      observedCategory: risk.category,
      observedSeverity: risk.severity,
      caseRequired: risk.caseRequired,
      categories: risk.categories,
      reason: risk.reason
    };
  });
  const safeReplyOk = typeof reply === 'string' &&
    reply.includes('flagged the operator') &&
    reply.includes('paused the automated handling');
  return {
    ok: cases.every((item) => item.ok) && safeReplyOk,
    adapterKey,
    suite,
    fixtureSource: 'server/handoff.js',
    executedAt: new Date(now).toISOString(),
    cases,
    safeReply: {
      ok: safeReplyOk,
      includesOperatorFlag: reply.includes('flagged the operator'),
      includesAutomationPause: reply.includes('paused the automated handling')
    },
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    databaseWritesRequired: false,
    liveSideEffects: false
  };
}

const GITHUB_PR_OBSERVATION_FIXTURES = Object.freeze([
  {
    key: 'open_ready_pr_matches_url',
    pullRequestUrl: 'https://github.com/callan-ai/callan/pull/145',
    githubApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/145',
    payload: {
      html_url: 'https://github.com/callan-ai/callan/pull/145',
      url: 'https://api.github.com/repos/callan-ai/callan/pulls/145',
      number: 145,
      state: 'open',
      draft: false,
      mergeable: true,
      merged: false,
      title: 'Operator handoff customer success eval',
      user: { login: 'codex' },
      head: { ref: 'maygoals-operator-handoff', sha: 'abc123', repo: { full_name: 'callan-ai/callan' } },
      base: { ref: 'main', sha: 'def456', repo: { full_name: 'callan-ai/callan' } }
    },
    expected: {
      urlMatches: true,
      stateOpen: true,
      draft: false,
      mergeable: true,
      merged: false,
      readyForOperatorApproval: true
    }
  },
  {
    key: 'draft_pr_blocks_merge',
    pullRequestUrl: 'https://github.com/callan-ai/callan/pull/146',
    githubApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/146',
    payload: {
      html_url: 'https://github.com/callan-ai/callan/pull/146',
      url: 'https://api.github.com/repos/callan-ai/callan/pulls/146',
      number: 146,
      state: 'open',
      draft: true,
      mergeable: true,
      merged: false,
      title: 'Draft eval proof',
      user: { login: 'codex' },
      head: { ref: 'draft-eval-proof', sha: 'draft123', repo: { full_name: 'callan-ai/callan' } },
      base: { ref: 'main', sha: 'base123', repo: { full_name: 'callan-ai/callan' } }
    },
    expected: {
      urlMatches: true,
      stateOpen: true,
      draft: true,
      mergeable: true,
      merged: false,
      readyForOperatorApproval: false
    }
  },
  {
    key: 'closed_pr_fails_external_verification',
    pullRequestUrl: 'https://github.com/callan-ai/callan/pull/147',
    githubApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/147',
    payload: {
      html_url: 'https://github.com/callan-ai/callan/pull/147',
      url: 'https://api.github.com/repos/callan-ai/callan/pulls/147',
      number: 147,
      state: 'closed',
      draft: false,
      mergeable: false,
      merged: false,
      title: 'Closed eval proof',
      user: { login: 'codex' },
      head: { ref: 'closed-eval-proof', sha: 'closed123', repo: { full_name: 'callan-ai/callan' } },
      base: { ref: 'main', sha: 'base123', repo: { full_name: 'callan-ai/callan' } }
    },
    expected: {
      urlMatches: true,
      stateOpen: false,
      draft: false,
      mergeable: false,
      merged: false,
      readyForOperatorApproval: false
    }
  }
]);

export function normalizeGithubPullRequestObservation({
  pullRequestUrl,
  githubApiUrl,
  payload = {}
} = {}) {
  const observedHtmlUrl = String(payload.html_url || '').trim();
  const observedApiUrl = String(payload.url || '').trim();
  const state = String(payload.state || '').trim().toLowerCase();
  const draft = Boolean(payload.draft);
  const merged = Boolean(payload.merged);
  const mergeable = payload.mergeable === true;
  const urlMatches = observedHtmlUrl === String(pullRequestUrl || '').trim() &&
    observedApiUrl === String(githubApiUrl || '').trim();
  const stateOpen = state === 'open';
  return {
    pullRequestNumber: Number(payload.number) || null,
    pullRequestUrl: observedHtmlUrl || null,
    githubApiUrl: observedApiUrl || null,
    title: String(payload.title || '').trim() || null,
    authorLogin: String(payload.user?.login || '').trim() || null,
    headRef: String(payload.head?.ref || '').trim() || null,
    headSha: String(payload.head?.sha || '').trim() || null,
    baseRef: String(payload.base?.ref || '').trim() || null,
    baseSha: String(payload.base?.sha || '').trim() || null,
    state,
    draft,
    merged,
    mergeable,
    urlMatches,
    stateOpen,
    readyForOperatorApproval: urlMatches && stateOpen && !draft && !merged && mergeable,
    mergeAllowed: false,
    productionMutation: false
  };
}

export function runGithubPullRequestObservationAdapterContract({
  adapterKey = 'github_pr_observation_adapter',
  suite = 'github_pr_observation_regression',
  now = Date.now()
} = {}) {
  const cases = GITHUB_PR_OBSERVATION_FIXTURES.map((fixture) => {
    const observation = normalizeGithubPullRequestObservation({
      pullRequestUrl: fixture.pullRequestUrl,
      githubApiUrl: fixture.githubApiUrl,
      payload: fixture.payload
    });
    const ok = observation.urlMatches === fixture.expected.urlMatches &&
      observation.stateOpen === fixture.expected.stateOpen &&
      observation.draft === fixture.expected.draft &&
      observation.mergeable === fixture.expected.mergeable &&
      observation.merged === fixture.expected.merged &&
      observation.readyForOperatorApproval === fixture.expected.readyForOperatorApproval &&
      observation.mergeAllowed === false &&
      observation.productionMutation === false;
    return {
      key: fixture.key,
      ok,
      expected: fixture.expected,
      observation
    };
  });
  return {
    ok: cases.every((item) => item.ok),
    adapterKey,
    suite,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    cases,
    passedCount: cases.filter((item) => item.ok).length,
    failedCount: cases.filter((item) => !item.ok).length,
    fixturePullRequestObserved: cases.some((item) => item.observation.urlMatches && item.observation.stateOpen),
    fixtureReadyForOperatorApproval: cases.some((item) => item.observation.readyForOperatorApproval),
    liveGithubApiCalled: false,
    livePullRequestObserved: false,
    livePullRequestExternallyVerified: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    databaseWritesRequired: false,
    liveSideEffects: false
  };
}

const GITHUB_CHECK_RUN_FIXTURE = Object.freeze({
  pullRequestUrl: 'https://github.com/callan-ai/callan/pull/145',
  githubApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/145',
  checkRunsApiUrl: 'https://api.github.com/repos/callan-ai/callan/commits/abc123/check-runs',
  payload: {
    total_count: 4,
    check_runs: [
      { id: 1001, name: 'check', status: 'completed', conclusion: 'success', html_url: 'https://github.com/callan-ai/callan/actions/runs/145' },
      { id: 1002, name: 'check:eval-adapter-contract', status: 'completed', conclusion: 'success', html_url: 'https://github.com/callan-ai/callan/actions/runs/145' },
      { id: 1003, name: 'check:maygoals', status: 'completed', conclusion: 'success', html_url: 'https://github.com/callan-ai/callan/actions/runs/145' },
      { id: 1004, name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/callan-ai/callan/actions/runs/145' }
    ]
  }
});

export function normalizeGithubCheckRunObservation({
  observationMode = 'sandbox_fixture',
  pullRequestUrl,
  githubApiUrl,
  checkRunsApiUrl,
  payload = {},
  githubApiCalled = false,
  liveGithubObservation = false,
  now = Date.now()
} = {}) {
  const checkRuns = (Array.isArray(payload.check_runs) ? payload.check_runs : [])
    .map((run) => ({
      id: run?.id || null,
      name: String(run?.name || '').trim(),
      status: String(run?.status || '').trim().toLowerCase(),
      conclusion: String(run?.conclusion || '').trim().toLowerCase(),
      url: String(run?.html_url || run?.url || '').trim() || null
    }))
    .filter((run) => run.name);
  const completedCount = checkRuns.filter((run) => run.status === 'completed').length;
  const successCount = checkRuns.filter((run) => run.conclusion === 'success').length;
  const failedRuns = checkRuns.filter((run) => !['success', 'neutral', 'skipped'].includes(run.conclusion));
  const allObservedChecksPassed = checkRuns.length > 0 &&
    completedCount === checkRuns.length &&
    failedRuns.length === 0 &&
    successCount > 0;
  return {
    observationMode,
    observedAt: new Date(now).toISOString(),
    pullRequestUrl,
    githubApiUrl,
    checkRunsApiUrl,
    checkRunObserved: checkRuns.length > 0,
    checkRunCount: checkRuns.length,
    checkRunCompletedCount: completedCount,
    checkRunSuccessCount: successCount,
    checkRunFailureCount: failedRuns.length,
    checkRunConclusion: allObservedChecksPassed ? 'success' : checkRuns.length ? 'not_success' : 'missing',
    checkRuns,
    failedRunNames: failedRuns.map((run) => run.name),
    allObservedChecksPassed,
    githubApiCalled: Boolean(githubApiCalled),
    liveGithubObservation: Boolean(liveGithubObservation),
    githubApiObservationPresent: Boolean(githubApiCalled && liveGithubObservation),
    liveCheckRunObserved: Boolean(githubApiCalled && liveGithubObservation && checkRuns.length > 0),
    sandboxFixtureObserved: observationMode === 'sandbox_fixture' && checkRuns.length > 0,
    pullRequestExternallyVerified: Boolean(githubApiCalled && liveGithubObservation && allObservedChecksPassed),
    pullRequestMutatedByReceipt: false,
    githubMutation: false,
    mergeAllowed: false,
    productionMutation: false,
    liveSideEffects: false
  };
}

export async function observeGithubCheckRuns({
  pullRequestUrl,
  githubApiUrl,
  githubToken = '',
  now = Date.now(),
  fetchImpl = globalThis.fetch
} = {}) {
  const token = String(githubToken || '').trim();
  if (!token || !githubApiUrl || typeof fetchImpl !== 'function') {
    return normalizeGithubCheckRunObservation({
      observationMode: 'sandbox_fixture',
      pullRequestUrl: pullRequestUrl || GITHUB_CHECK_RUN_FIXTURE.pullRequestUrl,
      githubApiUrl: githubApiUrl || GITHUB_CHECK_RUN_FIXTURE.githubApiUrl,
      checkRunsApiUrl: GITHUB_CHECK_RUN_FIXTURE.checkRunsApiUrl,
      payload: GITHUB_CHECK_RUN_FIXTURE.payload,
      githubApiCalled: false,
      liveGithubObservation: false,
      now
    });
  }

  const pullResponse = await fetchImpl(githubApiUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const pullPayload = await pullResponse.json();
  const headSha = String(pullPayload?.head?.sha || '').trim();
  const url = new URL(githubApiUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  const checkRunsApiUrl = headSha && parts.length >= 4
    ? `https://api.github.com/repos/${parts[1]}/${parts[2]}/commits/${headSha}/check-runs`
    : '';
  if (!pullResponse.ok || !checkRunsApiUrl) {
    return normalizeGithubCheckRunObservation({
      observationMode: 'live',
      pullRequestUrl,
      githubApiUrl,
      checkRunsApiUrl,
      payload: { check_runs: [] },
      githubApiCalled: true,
      liveGithubObservation: false,
      now
    });
  }
  const checksResponse = await fetchImpl(checkRunsApiUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  const checksPayload = await checksResponse.json();
  return normalizeGithubCheckRunObservation({
    observationMode: 'live',
    pullRequestUrl: pullPayload?.html_url || pullRequestUrl,
    githubApiUrl,
    checkRunsApiUrl,
    payload: checksResponse.ok ? checksPayload : { check_runs: [] },
    githubApiCalled: true,
    liveGithubObservation: checksResponse.ok,
    now
  });
}

const MERGE_EXECUTION_ADAPTER_FIXTURE = Object.freeze({
  adapterKey: 'github_merge_execution_adapter',
  contractKind: 'merge_execution_adapter_contract',
  contractMode: 'sandbox_fixture',
  pullRequestUrl: 'https://github.com/callan-ai/callan/pull/145',
  githubApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/145',
  mergeApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/145/merge'
});

export function normalizeMergeExecutionAdapterContract({
  adapterKey = MERGE_EXECUTION_ADAPTER_FIXTURE.adapterKey,
  contractKind = MERGE_EXECUTION_ADAPTER_FIXTURE.contractKind,
  contractMode = MERGE_EXECUTION_ADAPTER_FIXTURE.contractMode,
  pullRequestUrl = MERGE_EXECUTION_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl = MERGE_EXECUTION_ADAPTER_FIXTURE.githubApiUrl,
  mergeApiUrl = MERGE_EXECUTION_ADAPTER_FIXTURE.mergeApiUrl,
  now = Date.now()
} = {}) {
  const cleanAdapterKey = String(adapterKey || MERGE_EXECUTION_ADAPTER_FIXTURE.adapterKey).trim() || MERGE_EXECUTION_ADAPTER_FIXTURE.adapterKey;
  const cleanContractKind = String(contractKind || MERGE_EXECUTION_ADAPTER_FIXTURE.contractKind).trim() || MERGE_EXECUTION_ADAPTER_FIXTURE.contractKind;
  const cleanContractMode = String(contractMode || MERGE_EXECUTION_ADAPTER_FIXTURE.contractMode).trim() || MERGE_EXECUTION_ADAPTER_FIXTURE.contractMode;
  return {
    ok: true,
    adapterKey: cleanAdapterKey,
    contractKind: cleanContractKind,
    contractMode: cleanContractMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    pullRequestUrl: String(pullRequestUrl || MERGE_EXECUTION_ADAPTER_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || MERGE_EXECUTION_ADAPTER_FIXTURE.githubApiUrl).trim(),
    mergeApiUrl: String(mergeApiUrl || MERGE_EXECUTION_ADAPTER_FIXTURE.mergeApiUrl).trim(),
    mergeExecutionAdapterContractObserved: true,
    mergeExecutionAdapterReady: false,
    mergeExecutionAdapterRequired: true,
    adapterMutationAttempted: false,
    githubMutation: false,
    mergeExecuted: false,
    mergeAllowed: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    liveGithubApiCalled: false,
    remainingBlockers: ['live_merge_execution_attempt', 'real_token_merge_authorization']
  };
}

export function runMergeExecutionAdapterContract(args = {}) {
  return normalizeMergeExecutionAdapterContract(args);
}

const BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE = Object.freeze({
  adapterKey: 'github_branch_protection_readback_adapter',
  contractKind: 'branch_protection_readback_adapter_contract',
  contractMode: 'sandbox_fixture',
  pullRequestUrl: 'https://github.com/callan-ai/callan/pull/145',
  githubApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/145',
  branchProtectionApiUrl: 'https://api.github.com/repos/callan-ai/callan/branches/main/protection',
  tokenScopesApiUrl: 'https://api.github.com/user',
  targetBranch: 'main',
  requiredStatusChecks: ['check', 'check:maygoals', 'build'],
  requiredApprovingReviewCount: 1,
  requiredTokenScopes: ['contents:read', 'administration:read', 'checks:read']
});

export function normalizeBranchProtectionReadbackAdapterContract({
  adapterKey = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.adapterKey,
  contractKind = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.contractKind,
  contractMode = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.contractMode,
  pullRequestUrl = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.githubApiUrl,
  branchProtectionApiUrl = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.branchProtectionApiUrl,
  tokenScopesApiUrl = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.tokenScopesApiUrl,
  targetBranch = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.targetBranch,
  requiredStatusChecks = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.requiredStatusChecks,
  requiredApprovingReviewCount = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.requiredApprovingReviewCount,
  requiredTokenScopes = BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.requiredTokenScopes,
  now = Date.now()
} = {}) {
  const cleanAdapterKey = String(adapterKey || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.adapterKey).trim() || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.adapterKey;
  const cleanContractKind = String(contractKind || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.contractKind).trim() || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.contractKind;
  const cleanContractMode = String(contractMode || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.contractMode).trim() || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.contractMode;
  const cleanStatusChecks = (Array.isArray(requiredStatusChecks) && requiredStatusChecks.length
    ? requiredStatusChecks
    : BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.requiredStatusChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanTokenScopes = (Array.isArray(requiredTokenScopes) && requiredTokenScopes.length
    ? requiredTokenScopes
    : BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.requiredTokenScopes
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    adapterKey: cleanAdapterKey,
    contractKind: cleanContractKind,
    contractMode: cleanContractMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    pullRequestUrl: String(pullRequestUrl || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.githubApiUrl).trim(),
    branchProtectionApiUrl: String(branchProtectionApiUrl || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.branchProtectionApiUrl).trim(),
    tokenScopesApiUrl: String(tokenScopesApiUrl || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.tokenScopesApiUrl).trim(),
    targetBranch: String(targetBranch || BRANCH_PROTECTION_READBACK_ADAPTER_FIXTURE.targetBranch).trim() || 'main',
    branchProtectionReadbackAdapterContractObserved: true,
    branchProtectionReadbackContractReady: false,
    branchProtectionReadbackObserved: true,
    branchProtectionReadbackLiveVerified: false,
    requiredStatusChecksContractShape: cleanStatusChecks,
    requiredPullRequestReviewsContractShape: {
      requiredApprovingReviewCount: Number(requiredApprovingReviewCount) || 1,
      dismissStaleReviews: true,
      requireCodeOwnerReviews: false
    },
    enforceAdminsContractShape: true,
    restrictionsContractShape: {
      users: [],
      teams: [],
      apps: []
    },
    tokenScopeContractShape: {
      tokenIdentifier: 'GITHUB_BRANCH_PROTECTION_READ_TOKEN',
      requiredScopes: cleanTokenScopes,
      presentScopes: [],
      missingScopes: cleanTokenScopes,
      tokenPresenceObserved: false,
      tokenScopeObservationSource: 'local_contract_shape'
    },
    adapterMutationAttempted: false,
    liveGithubApiCalled: false,
    branchProtectionMutated: false,
    mergeAllowed: false,
    mergeExecuted: false,
    githubMutation: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['live_branch_protection_readback', 'live_token_scope_observation']
  };
}

export function runBranchProtectionReadbackAdapterContract(args = {}) {
  return normalizeBranchProtectionReadbackAdapterContract(args);
}

const TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE = Object.freeze({
  adapterKey: 'github_token_scope_observation_adapter',
  contractKind: 'token_scope_observation_adapter_contract',
  contractMode: 'sandbox_fixture',
  pullRequestUrl: 'https://github.com/callan-ai/callan/pull/145',
  githubApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/145',
  tokenScopesApiUrl: 'https://api.github.com/user',
  tokenIdentifier: 'GITHUB_LIVE_MERGE_TOKEN',
  requiredScopes: ['contents:write', 'pull_requests:write', 'checks:read']
});

export function normalizeTokenScopeObservationAdapterContract({
  adapterKey = TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.adapterKey,
  contractKind = TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.contractKind,
  contractMode = TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.contractMode,
  pullRequestUrl = TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl = TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.githubApiUrl,
  tokenScopesApiUrl = TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.tokenScopesApiUrl,
  tokenIdentifier = TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.tokenIdentifier,
  requiredScopes = TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.requiredScopes,
  now = Date.now()
} = {}) {
  const cleanAdapterKey = String(adapterKey || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.adapterKey).trim() || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.adapterKey;
  const cleanContractKind = String(contractKind || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.contractKind).trim() || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.contractKind;
  const cleanContractMode = String(contractMode || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.contractMode).trim() || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.contractMode;
  const cleanRequiredScopes = (Array.isArray(requiredScopes) && requiredScopes.length
    ? requiredScopes
    : TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.requiredScopes
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    adapterKey: cleanAdapterKey,
    contractKind: cleanContractKind,
    contractMode: cleanContractMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    pullRequestUrl: String(pullRequestUrl || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.githubApiUrl).trim(),
    tokenScopesApiUrl: String(tokenScopesApiUrl || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.tokenScopesApiUrl).trim(),
    tokenScopeObservationAdapterContractObserved: true,
    tokenScopeObservationContractReady: false,
    tokenIdentifier: String(tokenIdentifier || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.tokenIdentifier).trim() || TOKEN_SCOPE_OBSERVATION_ADAPTER_FIXTURE.tokenIdentifier,
    requiredScopes: cleanRequiredScopes,
    presentScopes: [],
    missingScopes: cleanRequiredScopes,
    tokenPresenceObserved: false,
    tokenValuePersisted: false,
    tokenSecretPersisted: false,
    tokenScopeObservationSource: 'local_contract_shape',
    adapterMutationAttempted: false,
    liveGithubApiCalled: false,
    tokenScopeMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['real_token_merge_authorization', 'live_token_scope_observation']
  };
}

export function runTokenScopeObservationAdapterContract(args = {}) {
  return normalizeTokenScopeObservationAdapterContract(args);
}

export function runSecretRedactionProof(args = {}) {
  return buildSecretRedactionProof(args);
}

const MERGE_QUEUE_READBACK_ADAPTER_FIXTURE = Object.freeze({
  adapterKey: 'github_merge_queue_readback_adapter',
  contractKind: 'merge_queue_readback_adapter_contract',
  contractMode: 'sandbox_fixture',
  pullRequestUrl: 'https://github.com/callan-ai/callan/pull/145',
  githubApiUrl: 'https://api.github.com/repos/callan-ai/callan/pulls/145',
  repoFullName: 'callan-ai/callan',
  targetBranch: 'main',
  requiredStatusChecks: ['check', 'check:maygoals', 'build'],
  requiredApprovingReviewCount: 1
});

export function normalizeMergeQueueReadbackAdapterContract({
  adapterKey = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.adapterKey,
  contractKind = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.contractKind,
  contractMode = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.contractMode,
  pullRequestUrl = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.githubApiUrl,
  repoFullName = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.repoFullName,
  targetBranch = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.targetBranch,
  requiredStatusChecks = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredStatusChecks,
  requiredApprovingReviewCount = MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredApprovingReviewCount,
  now = Date.now()
} = {}) {
  const cleanRepo = String(repoFullName || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.repoFullName).trim() || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.repoFullName;
  const cleanBranch = String(targetBranch || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.targetBranch).trim() || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.targetBranch;
  const cleanChecks = (Array.isArray(requiredStatusChecks) && requiredStatusChecks.length
    ? requiredStatusChecks
    : MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredStatusChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const rulesetsApiUrl = `https://api.github.com/repos/${cleanRepo}/rulesets`;
  const mergeQueueApiUrl = `${rulesetsApiUrl}?targets=branch&branch=${encodeURIComponent(cleanBranch)}`;
  return {
    ok: true,
    adapterKey: String(adapterKey || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.adapterKey).trim() || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.adapterKey,
    contractKind: String(contractKind || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.contractKind).trim() || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.contractKind,
    contractMode: String(contractMode || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.contractMode).trim() || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.contractMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    pullRequestUrl: String(pullRequestUrl || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.githubApiUrl).trim(),
    repoFullName: cleanRepo,
    targetBranch: cleanBranch,
    rulesetsApiUrl,
    mergeQueueApiUrl,
    mergeQueueReadbackAdapterContractObserved: true,
    mergeQueueReadbackContractReady: false,
    mergeQueueLiveVerified: false,
    mergeQueueEnabledObserved: false,
    mergeQueueRequiredByPolicy: true,
    requiredStatusChecksContractShape: cleanChecks,
    requiredPullRequestReviewsContractShape: {
      requiredApprovingReviewCount: Number(requiredApprovingReviewCount) || 1,
      dismissStaleReviews: true,
      requireCodeOwnerReviews: false
    },
    mergeQueueContractShape: {
      source: 'local_ruleset_contract_shape',
      target: 'branch',
      targetBranch: cleanBranch,
      mergeMethod: 'squash',
      requiredStatusChecks: cleanChecks,
      requiredApprovingReviewCount: Number(requiredApprovingReviewCount) || 1,
      requireConversationResolution: true,
      requireBranchUpToDate: true,
      liveReadbackVerified: false
    },
    branchProtectionContractShape: {
      requiredStatusChecks: cleanChecks,
      requiredApprovingReviewCount: Number(requiredApprovingReviewCount) || 1,
      enforceAdmins: true,
      mergeQueueVerified: false
    },
    adapterMutationAttempted: false,
    liveGithubApiCalled: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['live_merge_queue_readback', 'real_token_merge_authorization', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueReadbackAdapterContract(args = {}) {
  return normalizeMergeQueueReadbackAdapterContract(args);
}

const MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE = Object.freeze({
  adapterKey: 'github_merge_queue_live_read_reconciler',
  reconciliationKind: 'merge_queue_live_read_reconciliation',
  reconciliationMode: 'blocked_preflight',
  pullRequestUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.githubApiUrl,
  repoFullName: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.repoFullName,
  targetBranch: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.targetBranch,
  requiredStatusChecks: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredStatusChecks
});

export function normalizeMergeQueueLiveReadReconciliation({
  adapterKey = MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.adapterKey,
  reconciliationKind = MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.reconciliationKind,
  reconciliationMode = MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.reconciliationMode,
  pullRequestUrl = MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.pullRequestUrl,
  githubApiUrl = MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.githubApiUrl,
  repoFullName = MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.repoFullName,
  targetBranch = MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.targetBranch,
  requiredStatusChecks = MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.requiredStatusChecks,
  localContractReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRepo = String(repoFullName || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.repoFullName).trim() || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.repoFullName;
  const cleanBranch = String(targetBranch || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.targetBranch).trim() || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.targetBranch;
  const cleanChecks = (Array.isArray(requiredStatusChecks) && requiredStatusChecks.length
    ? requiredStatusChecks
    : MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.requiredStatusChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const rulesetsApiUrl = `https://api.github.com/repos/${cleanRepo}/rulesets`;
  const mergeQueueApiUrl = `${rulesetsApiUrl}?targets=branch&branch=${encodeURIComponent(cleanBranch)}`;
  return {
    ok: true,
    adapterKey: String(adapterKey || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.adapterKey).trim() || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.adapterKey,
    reconciliationKind: String(reconciliationKind || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.reconciliationKind).trim() || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.reconciliationKind,
    reconciliationMode: String(reconciliationMode || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.reconciliationMode).trim() || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.reconciliationMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    localContractReceiptId,
    pullRequestUrl: String(pullRequestUrl || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || MERGE_QUEUE_LIVE_READ_RECONCILIATION_FIXTURE.githubApiUrl).trim(),
    repoFullName: cleanRepo,
    targetBranch: cleanBranch,
    rulesetsApiUrl,
    mergeQueueApiUrl,
    requiredStatusChecksContractShape: cleanChecks,
    mergeQueueLiveReadReconciled: true,
    localContractObserved: true,
    localContractAcceptedForPreflight: true,
    realTokenObserved: false,
    mergeQueueLiveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    mergeQueueEnabledLiveObserved: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['real_token_merge_authorization', 'live_merge_queue_readback', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueLiveReadReconciliation(args = {}) {
  return normalizeMergeQueueLiveReadReconciliation(args);
}

const MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE = Object.freeze({
  adapterKey: 'github_merge_queue_live_read_adapter_contract',
  contractKind: 'merge_queue_live_read_adapter_contract',
  contractMode: 'blocked_preflight',
  pullRequestUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.githubApiUrl,
  repoFullName: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.repoFullName,
  targetBranch: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.targetBranch,
  requiredStatusChecks: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredStatusChecks,
  requiredTokenScopes: ['contents:read', 'metadata:read', 'pull_requests:read', 'administration:read']
});

export function normalizeMergeQueueLiveReadAdapterContract({
  adapterKey = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.adapterKey,
  contractKind = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.contractKind,
  contractMode = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.contractMode,
  pullRequestUrl = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.pullRequestUrl,
  githubApiUrl = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.githubApiUrl,
  repoFullName = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.repoFullName,
  targetBranch = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.targetBranch,
  requiredStatusChecks = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.requiredStatusChecks,
  requiredTokenScopes = MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.requiredTokenScopes,
  localReconciliationReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRepo = String(repoFullName || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.repoFullName).trim() || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.repoFullName;
  const cleanBranch = String(targetBranch || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.targetBranch).trim() || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.targetBranch;
  const cleanChecks = (Array.isArray(requiredStatusChecks) && requiredStatusChecks.length
    ? requiredStatusChecks
    : MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.requiredStatusChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanScopes = (Array.isArray(requiredTokenScopes) && requiredTokenScopes.length
    ? requiredTokenScopes
    : MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.requiredTokenScopes
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const rulesetsApiUrl = `https://api.github.com/repos/${cleanRepo}/rulesets`;
  const mergeQueueApiUrl = `${rulesetsApiUrl}?targets=branch&branch=${encodeURIComponent(cleanBranch)}`;
  return {
    ok: true,
    adapterKey: String(adapterKey || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.adapterKey).trim() || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.adapterKey,
    contractKind: String(contractKind || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.contractKind).trim() || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.contractKind,
    contractMode: String(contractMode || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.contractMode).trim() || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.contractMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    localReconciliationReceiptId,
    pullRequestUrl: String(pullRequestUrl || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.githubApiUrl).trim(),
    repoFullName: cleanRepo,
    targetBranch: cleanBranch,
    rulesetsApiUrl,
    mergeQueueApiUrl,
    requiredStatusChecksContractShape: cleanChecks,
    requiredTokenScopesContractShape: cleanScopes,
    liveReadAdapterContractObserved: true,
    localReconciliationObserved: true,
    liveReadAdapterReady: false,
    readbackContractShape: {
      method: 'GET',
      endpoint: mergeQueueApiUrl,
      tokenSource: 'operator_supplied_runtime_secret',
      requiredTokenScopes: cleanScopes,
      expectedFields: ['ruleset.id', 'ruleset.name', 'ruleset.target', 'ruleset.conditions.ref_name', 'ruleset.rules.merge_queue'],
      pagination: 'rulesets_list',
      conditionalRequest: true,
      liveReadbackVerified: false
    },
    branchProtectionContractShape: {
      requiredStatusChecks: cleanChecks,
      targetBranch: cleanBranch,
      mergeQueueVerified: false
    },
    realTokenObserved: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    mergeQueueEnabledLiveObserved: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['real_token_merge_authorization', 'live_merge_queue_readback', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueLiveReadAdapterContract(args = {}) {
  return normalizeMergeQueueLiveReadAdapterContract(args);
}

const MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE = Object.freeze({
  readinessKey: 'github_merge_queue_live_read_readiness',
  readinessKind: 'merge_queue_live_read_readiness_packet',
  readinessMode: 'blocked_credentials_preflight',
  pullRequestUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.githubApiUrl,
  repoFullName: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.repoFullName,
  targetBranch: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.targetBranch,
  requiredStatusChecks: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredStatusChecks,
  requiredTokenScopes: MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.requiredTokenScopes,
  requiredSecretRefs: ['GITHUB_MERGE_QUEUE_READ_TOKEN'],
  requiredOperatorApprovals: ['live_github_readback_approval', 'merge_queue_readback_operator_ack']
});

export function normalizeMergeQueueLiveReadReadinessPacket({
  readinessKey = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessKey,
  readinessKind = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessKind,
  readinessMode = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessMode,
  pullRequestUrl = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.pullRequestUrl,
  githubApiUrl = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.githubApiUrl,
  repoFullName = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.repoFullName,
  targetBranch = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.targetBranch,
  requiredStatusChecks = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredStatusChecks,
  requiredTokenScopes = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredTokenScopes,
  requiredSecretRefs = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredSecretRefs,
  requiredOperatorApprovals = MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredOperatorApprovals,
  adapterContractReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRepo = String(repoFullName || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.repoFullName).trim() || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.repoFullName;
  const cleanBranch = String(targetBranch || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.targetBranch).trim() || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.targetBranch;
  const cleanChecks = (Array.isArray(requiredStatusChecks) && requiredStatusChecks.length
    ? requiredStatusChecks
    : MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredStatusChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanScopes = (Array.isArray(requiredTokenScopes) && requiredTokenScopes.length
    ? requiredTokenScopes
    : MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredTokenScopes
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanSecretRefs = (Array.isArray(requiredSecretRefs) && requiredSecretRefs.length
    ? requiredSecretRefs
    : MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredSecretRefs
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanApprovals = (Array.isArray(requiredOperatorApprovals) && requiredOperatorApprovals.length
    ? requiredOperatorApprovals
    : MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredOperatorApprovals
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const rulesetsApiUrl = `https://api.github.com/repos/${cleanRepo}/rulesets`;
  const mergeQueueApiUrl = `${rulesetsApiUrl}?targets=branch&branch=${encodeURIComponent(cleanBranch)}`;
  return {
    ok: true,
    readinessKey: String(readinessKey || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessKey).trim() || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessKey,
    readinessKind: String(readinessKind || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessKind).trim() || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessKind,
    readinessMode: String(readinessMode || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessMode).trim() || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.readinessMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    adapterContractReceiptId,
    pullRequestUrl: String(pullRequestUrl || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.githubApiUrl).trim(),
    repoFullName: cleanRepo,
    targetBranch: cleanBranch,
    rulesetsApiUrl,
    mergeQueueApiUrl,
    liveReadReadinessPacketRecorded: true,
    adapterContractObserved: true,
    requiredStatusChecksReadinessShape: cleanChecks,
    requiredTokenScopesReadinessShape: cleanScopes,
    requiredSecretRefs: cleanSecretRefs,
    requiredOperatorApprovals: cleanApprovals,
    readinessChecklist: {
      adapterContractReceiptId,
      requiredSecretRefs: cleanSecretRefs,
      requiredTokenScopes: cleanScopes,
      requiredOperatorApprovals: cleanApprovals,
      requiredStatusChecks: cleanChecks,
      targetBranch: cleanBranch,
      rulesetsApiUrl,
      mergeQueueApiUrl,
      tokenValuesIncluded: false,
      liveReadbackAllowed: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    mergeQueueEnabledLiveObserved: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['real_token_merge_authorization', 'live_merge_queue_readback', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueLiveReadReadinessPacket(args = {}) {
  return normalizeMergeQueueLiveReadReadinessPacket(args);
}

const MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE = Object.freeze({
  handoffKey: 'github_merge_queue_credential_handoff',
  handoffKind: 'merge_queue_credential_handoff_packet',
  handoffMode: 'secret_reference_only_preflight',
  pullRequestUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.githubApiUrl,
  repoFullName: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.repoFullName,
  targetBranch: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.targetBranch,
  requiredStatusChecks: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredStatusChecks,
  requiredTokenScopes: MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.requiredTokenScopes,
  requiredSecretRefs: MERGE_QUEUE_LIVE_READ_READINESS_FIXTURE.requiredSecretRefs,
  requiredOperatorApprovals: ['credential_handoff_operator_ack', 'live_github_readback_approval'],
  secretStoreReference: 'github_actions_secret:GITHUB_MERGE_QUEUE_READ_TOKEN',
  custodyRequirements: [
    'secret_reference_only',
    'operator_runtime_injection',
    'no_database_persistence',
    'redacted_logs_only',
    'rotation_plan_required',
    'revocation_plan_required'
  ],
  rotationPlan: ['rotate_after_live_read', 'rotate_after_failed_live_read', 'rotate_before_operator_reassignment'],
  revocationPlan: ['revoke_on_failed_scope_check', 'revoke_on_operator_cancel', 'revoke_after_merge_closeout']
});

export function normalizeMergeQueueCredentialHandoffPacket({
  handoffKey = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffKey,
  handoffKind = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffKind,
  handoffMode = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffMode,
  pullRequestUrl = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.pullRequestUrl,
  githubApiUrl = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.githubApiUrl,
  repoFullName = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.repoFullName,
  targetBranch = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.targetBranch,
  requiredStatusChecks = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.requiredStatusChecks,
  requiredTokenScopes = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.requiredTokenScopes,
  requiredSecretRefs = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.requiredSecretRefs,
  requiredOperatorApprovals = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.requiredOperatorApprovals,
  secretStoreReference = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.secretStoreReference,
  custodyRequirements = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.custodyRequirements,
  rotationPlan = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.rotationPlan,
  revocationPlan = MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.revocationPlan,
  readinessReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRepo = String(repoFullName || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.repoFullName).trim() || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.repoFullName;
  const cleanBranch = String(targetBranch || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.targetBranch).trim() || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.targetBranch;
  const cleanChecks = (Array.isArray(requiredStatusChecks) && requiredStatusChecks.length
    ? requiredStatusChecks
    : MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.requiredStatusChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanScopes = (Array.isArray(requiredTokenScopes) && requiredTokenScopes.length
    ? requiredTokenScopes
    : MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.requiredTokenScopes
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanSecretRefs = (Array.isArray(requiredSecretRefs) && requiredSecretRefs.length
    ? requiredSecretRefs
    : MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.requiredSecretRefs
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanApprovals = (Array.isArray(requiredOperatorApprovals) && requiredOperatorApprovals.length
    ? requiredOperatorApprovals
    : MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.requiredOperatorApprovals
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanCustody = (Array.isArray(custodyRequirements) && custodyRequirements.length
    ? custodyRequirements
    : MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.custodyRequirements
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanRotation = (Array.isArray(rotationPlan) && rotationPlan.length
    ? rotationPlan
    : MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.rotationPlan
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanRevocation = (Array.isArray(revocationPlan) && revocationPlan.length
    ? revocationPlan
    : MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.revocationPlan
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const rulesetsApiUrl = `https://api.github.com/repos/${cleanRepo}/rulesets`;
  const mergeQueueApiUrl = `${rulesetsApiUrl}?targets=branch&branch=${encodeURIComponent(cleanBranch)}`;
  const cleanSecretStoreReference = String(secretStoreReference || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.secretStoreReference).trim() || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.secretStoreReference;
  return {
    ok: true,
    handoffKey: String(handoffKey || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffKey).trim() || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffKey,
    handoffKind: String(handoffKind || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffKind).trim() || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffKind,
    handoffMode: String(handoffMode || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffMode).trim() || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.handoffMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    readinessReceiptId,
    pullRequestUrl: String(pullRequestUrl || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || MERGE_QUEUE_CREDENTIAL_HANDOFF_FIXTURE.githubApiUrl).trim(),
    repoFullName: cleanRepo,
    targetBranch: cleanBranch,
    rulesetsApiUrl,
    mergeQueueApiUrl,
    mergeQueueCredentialHandoffRecorded: true,
    credentialHandoffPacketRecorded: true,
    readinessObserved: true,
    credentialReferenceDeclared: true,
    secretStoreReferenceDeclared: true,
    operatorApprovalRequired: true,
    requiredStatusChecksHandoffShape: cleanChecks,
    requiredTokenScopesHandoffShape: cleanScopes,
    requiredSecretRefs: cleanSecretRefs,
    requiredOperatorApprovals: cleanApprovals,
    secretStoreReference: cleanSecretStoreReference,
    custodyRequirements: cleanCustody,
    rotationPlan: cleanRotation,
    revocationPlan: cleanRevocation,
    credentialHandoffChecklist: {
      readinessReceiptId,
      requiredSecretRefs: cleanSecretRefs,
      requiredTokenScopes: cleanScopes,
      requiredOperatorApprovals: cleanApprovals,
      secretStoreReference: cleanSecretStoreReference,
      custodyRequirements: cleanCustody,
      rotationPlan: cleanRotation,
      revocationPlan: cleanRevocation,
      secretReferenceOnly: true,
      secretValueIncluded: false,
      secretValuePersisted: false,
      secretValueLogged: false,
      liveReadbackAllowed: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    secretValueIncluded: false,
    tokenValueIncluded: false,
    secretValuePersisted: false,
    tokenValuePersisted: false,
    secretValueLogged: false,
    secretValueEchoed: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    mergeQueueEnabledLiveObserved: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['real_token_runtime_injection', 'operator_credential_handoff_approval', 'live_merge_queue_readback', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueCredentialHandoffPacket(args = {}) {
  return normalizeMergeQueueCredentialHandoffPacket(args);
}

const MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE = Object.freeze({
  preflightKey: 'github_merge_queue_live_read_preflight',
  preflightKind: 'merge_queue_live_read_preflight_envelope',
  preflightMode: 'no_http_request_envelope',
  pullRequestUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.pullRequestUrl,
  githubApiUrl: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.githubApiUrl,
  repoFullName: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.repoFullName,
  targetBranch: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.targetBranch,
  requiredStatusChecks: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredStatusChecks,
  requiredTokenScopes: MERGE_QUEUE_LIVE_READ_ADAPTER_CONTRACT_FIXTURE.requiredTokenScopes,
  runtimeSecretRef: 'github_merge_queue_read_token',
  requestMethod: 'GET',
  apiVersion: '2022-11-28',
  acceptedMediaType: 'application/vnd.github+json',
  conditionalRequestHeader: 'If-None-Match'
});

export function normalizeMergeQueueLiveReadPreflightEnvelope({
  preflightKey = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightKey,
  preflightKind = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightKind,
  preflightMode = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightMode,
  pullRequestUrl = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.pullRequestUrl,
  githubApiUrl = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.githubApiUrl,
  repoFullName = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.repoFullName,
  targetBranch = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.targetBranch,
  requiredStatusChecks = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.requiredStatusChecks,
  requiredTokenScopes = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.requiredTokenScopes,
  runtimeSecretRef = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.requestMethod,
  apiVersion = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.apiVersion,
  acceptedMediaType = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.acceptedMediaType,
  conditionalRequestHeader = MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.conditionalRequestHeader,
  credentialHandoffReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRepo = String(repoFullName || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.repoFullName).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.repoFullName;
  const cleanBranch = String(targetBranch || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.targetBranch).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.targetBranch;
  const cleanChecks = (Array.isArray(requiredStatusChecks) && requiredStatusChecks.length
    ? requiredStatusChecks
    : MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.requiredStatusChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanScopes = (Array.isArray(requiredTokenScopes) && requiredTokenScopes.length
    ? requiredTokenScopes
    : MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.requiredTokenScopes
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const rulesetsApiUrl = `https://api.github.com/repos/${cleanRepo}/rulesets`;
  const mergeQueueApiUrl = `${rulesetsApiUrl}?targets=branch&branch=${encodeURIComponent(cleanBranch)}`;
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef;
  const cleanMethod = String(requestMethod || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.requestMethod;
  const cleanApiVersion = String(apiVersion || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.apiVersion).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.apiVersion;
  const cleanMediaType = String(acceptedMediaType || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.acceptedMediaType).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.acceptedMediaType;
  const cleanConditionalHeader = String(conditionalRequestHeader || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.conditionalRequestHeader).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.conditionalRequestHeader;
  return {
    ok: true,
    preflightKey: String(preflightKey || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightKey).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightKey,
    preflightKind: String(preflightKind || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightKind).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightKind,
    preflightMode: String(preflightMode || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightMode).trim() || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.preflightMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    credentialHandoffReceiptId,
    pullRequestUrl: String(pullRequestUrl || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.pullRequestUrl).trim(),
    githubApiUrl: String(githubApiUrl || MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.githubApiUrl).trim(),
    repoFullName: cleanRepo,
    targetBranch: cleanBranch,
    rulesetsApiUrl,
    mergeQueueApiUrl,
    mergeQueueLiveReadPreflightRecorded: true,
    liveReadPreflightEnvelopeRecorded: true,
    credentialHandoffObserved: true,
    requestEnvelopeBuilt: true,
    authHeaderPlanned: true,
    authorizationHeaderMaterialized: false,
    conditionalRequestPlanned: true,
    requestMethod: cleanMethod,
    apiVersion: cleanApiVersion,
    acceptedMediaType: cleanMediaType,
    conditionalRequestHeader: cleanConditionalHeader,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requiredStatusChecksPreflightShape: cleanChecks,
    requiredTokenScopesPreflightShape: cleanScopes,
    requestHeadersShape: {
      accept: cleanMediaType,
      authorization: `Bearer <runtime:${cleanRuntimeSecretRef}>`,
      xGitHubApiVersion: cleanApiVersion,
      [cleanConditionalHeader]: '<operator-supplied-etag-optional>'
    },
    liveReadPreflightChecklist: {
      credentialHandoffReceiptId,
      method: cleanMethod,
      endpoint: mergeQueueApiUrl,
      runtimeSecretRef: cleanRuntimeSecretRef,
      requiredTokenScopes: cleanScopes,
      requiredStatusChecks: cleanChecks,
      authorizationHeaderMaterialized: false,
      tokenValueIncluded: false,
      httpRequestSent: false,
      requestBodyAllowed: false,
      liveReadbackAllowed: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    mergeQueueEnabledLiveObserved: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['runtime_token_materialization', 'live_github_http_request', 'live_merge_queue_readback', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueLiveReadPreflightEnvelope(args = {}) {
  return normalizeMergeQueueLiveReadPreflightEnvelope(args);
}

const MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE = Object.freeze({
  quarantineKey: 'github_merge_queue_token_materialization_quarantine',
  quarantineKind: 'merge_queue_token_materialization_quarantine',
  quarantineMode: 'blocked_runtime_token_release',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  quarantinePolicy: ['memory_only', 'single_request_scope', 'redacted_observability', 'no_database_persistence', 'operator_release_required'],
  releaseGates: ['operator_release_ack', 'fresh_preflight_envelope', 'runtime_secret_provider_smoke', 'secret_redaction_guardrail'],
  rollbackPlan: ['discard_runtime_reference', 'clear_in_memory_header_builder', 'record_no_token_persisted']
});

export function normalizeMergeQueueTokenQuarantinePacket({
  quarantineKey = MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineKey,
  quarantineKind = MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineKind,
  quarantineMode = MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineMode,
  runtimeSecretRef = MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.runtimeSecretRef,
  quarantinePolicy = MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantinePolicy,
  releaseGates = MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.releaseGates,
  rollbackPlan = MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.rollbackPlan,
  liveReadPreflightReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.runtimeSecretRef;
  const cleanPolicy = (Array.isArray(quarantinePolicy) && quarantinePolicy.length
    ? quarantinePolicy
    : MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantinePolicy
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanGates = (Array.isArray(releaseGates) && releaseGates.length
    ? releaseGates
    : MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.releaseGates
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanRollback = (Array.isArray(rollbackPlan) && rollbackPlan.length
    ? rollbackPlan
    : MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.rollbackPlan
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    quarantineKey: String(quarantineKey || MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineKey).trim() || MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineKey,
    quarantineKind: String(quarantineKind || MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineKind).trim() || MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineKind,
    quarantineMode: String(quarantineMode || MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineMode).trim() || MERGE_QUEUE_TOKEN_QUARANTINE_FIXTURE.quarantineMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    liveReadPreflightReceiptId,
    mergeQueueTokenQuarantineRecorded: true,
    tokenMaterializationQuarantineRecorded: true,
    liveReadPreflightObserved: true,
    runtimeSecretRefObserved: true,
    quarantinePolicyRecorded: true,
    operatorReleaseRequired: true,
    runtimeSecretRef: cleanRuntimeSecretRef,
    quarantinePolicy: cleanPolicy,
    releaseGates: cleanGates,
    rollbackPlan: cleanRollback,
    tokenQuarantineChecklist: {
      liveReadPreflightReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      quarantinePolicy: cleanPolicy,
      releaseGates: cleanGates,
      rollbackPlan: cleanRollback,
      tokenMaterialized: false,
      authorizationHeaderMaterialized: false,
      tokenValuePersisted: false,
      tokenValueLogged: false,
      httpRequestSent: false,
      liveReadbackAllowed: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['operator_token_release_ack', 'runtime_secret_provider_smoke', 'runtime_token_materialization', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueTokenQuarantinePacket(args = {}) {
  return normalizeMergeQueueTokenQuarantinePacket(args);
}

const MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE = Object.freeze({
  ingestionKey: 'github_merge_queue_live_read_response_ingestion',
  ingestionKind: 'merge_queue_live_read_response_ingestion',
  ingestionMode: 'operator_supplied_response_payload',
  responseSource: 'operator_supplied_github_rulesets_readback',
  observedHttpStatus: 200,
  observedEtag: 'W/"operator-supplied-merge-queue-rulesets"',
  observedRulesetIds: ['ruleset-merge-queue-main'],
  observedRequiredStatusChecks: MERGE_QUEUE_READBACK_ADAPTER_FIXTURE.requiredStatusChecks,
  observedMergeQueueRequired: true
});

export function normalizeMergeQueueLiveReadResponseIngestionPacket({
  ingestionKey = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionKey,
  ingestionKind = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionKind,
  ingestionMode = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionMode,
  responseSource = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.responseSource,
  observedHttpStatus = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedHttpStatus,
  observedEtag = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedEtag,
  observedRulesetIds = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedRulesetIds,
  observedRequiredStatusChecks = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedRequiredStatusChecks,
  observedMergeQueueRequired = MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedMergeQueueRequired,
  mergeQueueTokenQuarantineReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRulesetIds = (Array.isArray(observedRulesetIds) && observedRulesetIds.length
    ? observedRulesetIds
    : MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedRulesetIds
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanChecks = (Array.isArray(observedRequiredStatusChecks) && observedRequiredStatusChecks.length
    ? observedRequiredStatusChecks
    : MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedRequiredStatusChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const statusCode = Number.isFinite(Number(observedHttpStatus)) ? Number(observedHttpStatus) : MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedHttpStatus;
  return {
    ok: true,
    ingestionKey: String(ingestionKey || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionKey).trim() || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionKey,
    ingestionKind: String(ingestionKind || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionKind).trim() || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionKind,
    ingestionMode: String(ingestionMode || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionMode).trim() || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.ingestionMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueTokenQuarantineReceiptId,
    mergeQueueLiveReadResponseIngestionRecorded: true,
    operatorSuppliedResponseObserved: true,
    tokenQuarantineObserved: true,
    responsePayloadSchemaObserved: true,
    responseSource: String(responseSource || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.responseSource).trim() || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.responseSource,
    observedHttpStatus: statusCode,
    observedEtag: String(observedEtag || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedEtag).trim() || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.observedEtag,
    observedRulesetIds: cleanRulesetIds,
    observedRequiredStatusChecks: cleanChecks,
    observedMergeQueueRequired: Boolean(observedMergeQueueRequired),
    liveReadResponseChecklist: {
      mergeQueueTokenQuarantineReceiptId,
      responseSource: String(responseSource || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.responseSource).trim() || MERGE_QUEUE_LIVE_READ_RESPONSE_FIXTURE.responseSource,
      operatorSuppliedResponseObserved: true,
      responsePayloadSchemaObserved: true,
      observedHttpStatus: statusCode,
      observedRulesetIds: cleanRulesetIds,
      observedRequiredStatusChecks: cleanChecks,
      observedMergeQueueRequired: Boolean(observedMergeQueueRequired),
      httpRequestSent: false,
      liveGithubApiCalled: false,
      liveReadSucceeded: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['live_github_http_request_not_performed_by_receipt', 'operator_response_evidence_verification', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueLiveReadResponseIngestionPacket(args = {}) {
  return normalizeMergeQueueLiveReadResponseIngestionPacket(args);
}

const MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE = Object.freeze({
  gateKey: 'github_merge_queue_runtime_token_release_gate',
  gateKind: 'merge_queue_runtime_token_release_gate',
  gateMode: 'fail_closed_no_token_release',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  releaseGateChecks: ['operator_release_ack', 'runtime_secret_provider_smoke', 'secret_redaction_guardrail', 'fresh_response_ingestion_receipt'],
  deniedReasons: ['operator_release_ack_missing', 'runtime_secret_provider_smoke_missing', 'live_github_http_not_allowed_by_receipt']
});

export function normalizeMergeQueueRuntimeTokenReleaseGatePacket({
  gateKey = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateKey,
  gateKind = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateKind,
  gateMode = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateMode,
  runtimeSecretRef = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.runtimeSecretRef,
  releaseGateChecks = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.releaseGateChecks,
  deniedReasons = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.deniedReasons,
  mergeQueueLiveReadResponseIngestionReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.runtimeSecretRef;
  const cleanChecks = (Array.isArray(releaseGateChecks) && releaseGateChecks.length
    ? releaseGateChecks
    : MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.releaseGateChecks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanDeniedReasons = (Array.isArray(deniedReasons) && deniedReasons.length
    ? deniedReasons
    : MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.deniedReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    gateKey: String(gateKey || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateKey).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateKey,
    gateKind: String(gateKind || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateKind).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateKind,
    gateMode: String(gateMode || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateMode).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_GATE_FIXTURE.gateMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueLiveReadResponseIngestionReceiptId,
    mergeQueueRuntimeTokenReleaseGateRecorded: true,
    runtimeTokenReleaseGateProofRecorded: true,
    responseIngestionObserved: true,
    operatorReleaseAckRequired: true,
    runtimeSecretProviderSmokeRequired: true,
    secretRedactionGuardrailObserved: true,
    runtimeSecretRef: cleanRuntimeSecretRef,
    releaseGateChecks: cleanChecks,
    deniedReasons: cleanDeniedReasons,
    tokenReleaseDenied: true,
    releaseGateChecklist: {
      mergeQueueLiveReadResponseIngestionReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      releaseGateChecks: cleanChecks,
      deniedReasons: cleanDeniedReasons,
      operatorReleaseAckRequired: true,
      operatorReleaseAckObserved: false,
      runtimeSecretProviderSmokeRequired: true,
      runtimeSecretProviderSmokeObserved: false,
      tokenReleased: false,
      tokenMaterialized: false,
      authorizationHeaderMaterialized: false,
      httpRequestSent: false,
      liveReadbackAllowed: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['operator_release_ack', 'runtime_secret_provider_smoke', 'runtime_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueRuntimeTokenReleaseGatePacket(args = {}) {
  return normalizeMergeQueueRuntimeTokenReleaseGatePacket(args);
}

const MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE = Object.freeze({
  promotionKey: 'github_merge_queue_live_read_verification_promotion',
  promotionKind: 'merge_queue_live_read_verification_promotion',
  promotionMode: 'queued_for_live_http_preflight',
  promotionChecklist: ['runtime_token_gate_recorded', 'operator_response_evidence_present', 'live_http_execution_blocked', 'operator_live_verification_required'],
  liveVerificationPlan: ['obtain_operator_release_ack', 'run_secret_provider_smoke', 'materialize_header_in_memory_only', 'perform_single_github_ruleset_get']
});

export function normalizeMergeQueueLiveReadVerificationPromotionPacket({
  promotionKey = MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionKey,
  promotionKind = MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionKind,
  promotionMode = MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionMode,
  promotionChecklist = MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionChecklist,
  liveVerificationPlan = MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.liveVerificationPlan,
  mergeQueueRuntimeTokenReleaseGateReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanChecklist = (Array.isArray(promotionChecklist) && promotionChecklist.length
    ? promotionChecklist
    : MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionChecklist
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanPlan = (Array.isArray(liveVerificationPlan) && liveVerificationPlan.length
    ? liveVerificationPlan
    : MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.liveVerificationPlan
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    promotionKey: String(promotionKey || MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionKey).trim() || MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionKey,
    promotionKind: String(promotionKind || MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionKind).trim() || MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionKind,
    promotionMode: String(promotionMode || MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionMode).trim() || MERGE_QUEUE_LIVE_READ_VERIFICATION_PROMOTION_FIXTURE.promotionMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueRuntimeTokenReleaseGateReceiptId,
    mergeQueueLiveReadVerificationPromotionRecorded: true,
    runtimeTokenReleaseGateObserved: true,
    operatorResponseEvidenceObserved: true,
    liveVerificationPlanRecorded: true,
    promotionChecklist: cleanChecklist,
    liveVerificationPlan: cleanPlan,
    liveVerificationPromotionChecklist: {
      mergeQueueRuntimeTokenReleaseGateReceiptId,
      promotionChecklist: cleanChecklist,
      liveVerificationPlan: cleanPlan,
      runtimeTokenReleaseGateObserved: true,
      operatorResponseEvidenceObserved: true,
      liveVerificationPlanRecorded: true,
      liveVerificationPromoted: false,
      tokenReleased: false,
      httpRequestSent: false,
      liveGithubApiCalled: false,
      liveReadSucceeded: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['operator_live_verification_required', 'runtime_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueLiveReadVerificationPromotionPacket(args = {}) {
  return normalizeMergeQueueLiveReadVerificationPromotionPacket(args);
}

const MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE = Object.freeze({
  handoffKey: 'github_merge_queue_live_http_execution_preflight_handoff',
  handoffKind: 'merge_queue_live_http_execution_preflight_handoff',
  handoffMode: 'operator_release_preflight_without_http',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  executionPreflightChecklist: ['live_read_verification_promotion_recorded', 'runtime_token_gate_recorded', 'operator_release_ack_required', 'runtime_secret_provider_smoke_required', 'single_github_ruleset_get_planned'],
  liveHttpExecutionPlan: ['verify_operator_live_http_release', 'run_secret_provider_smoke', 'materialize_authorization_header_in_memory_only', 'perform_single_github_ruleset_get', 'record_response_without_merge']
});

export function normalizeMergeQueueLiveHttpExecutionPreflightHandoffPacket({
  handoffKey = MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffKey,
  handoffKind = MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffKind,
  handoffMode = MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffMode,
  runtimeSecretRef = MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.requestMethod,
  executionPreflightChecklist = MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.executionPreflightChecklist,
  liveHttpExecutionPlan = MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.liveHttpExecutionPlan,
  mergeQueueLiveReadVerificationPromotionReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.requestMethod;
  const cleanChecklist = (Array.isArray(executionPreflightChecklist) && executionPreflightChecklist.length
    ? executionPreflightChecklist
    : MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.executionPreflightChecklist
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanPlan = (Array.isArray(liveHttpExecutionPlan) && liveHttpExecutionPlan.length
    ? liveHttpExecutionPlan
    : MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.liveHttpExecutionPlan
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    handoffKey: String(handoffKey || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffKey).trim() || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffKey,
    handoffKind: String(handoffKind || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffKind).trim() || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffKind,
    handoffMode: String(handoffMode || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffMode).trim() || MERGE_QUEUE_LIVE_HTTP_EXECUTION_PREFLIGHT_HANDOFF_FIXTURE.handoffMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueLiveReadVerificationPromotionReceiptId,
    mergeQueueLiveHttpExecutionPreflightHandoffRecorded: true,
    liveReadVerificationPromotionObserved: true,
    runtimeTokenReleaseGateObserved: true,
    operatorReleaseAckRequired: true,
    runtimeSecretProviderSmokeRequired: true,
    httpExecutionPlanRecorded: true,
    authorizationHeaderPlanRecorded: true,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    executionPreflightChecklist: cleanChecklist,
    liveHttpExecutionPlan: cleanPlan,
    liveHttpExecutionPreflightChecklist: {
      mergeQueueLiveReadVerificationPromotionReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      requestMethod: cleanRequestMethod,
      executionPreflightChecklist: cleanChecklist,
      liveHttpExecutionPlan: cleanPlan,
      liveReadVerificationPromotionObserved: true,
      operatorReleaseAckRequired: true,
      runtimeSecretProviderSmokeRequired: true,
      httpExecutionPlanRecorded: true,
      authorizationHeaderMaterialized: false,
      tokenReleased: false,
      tokenMaterialized: false,
      httpRequestSent: false,
      liveGithubApiCalled: false,
      liveReadSucceeded: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['operator_release_ack', 'runtime_secret_provider_smoke', 'runtime_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueLiveHttpExecutionPreflightHandoffPacket(args = {}) {
  return normalizeMergeQueueLiveHttpExecutionPreflightHandoffPacket(args);
}

const MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE = Object.freeze({
  releaseAckKey: 'github_merge_queue_live_http_operator_release_ack',
  releaseAckKind: 'merge_queue_live_http_operator_release_ack',
  releaseAckMode: 'operator_ack_recorded_no_token_release',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  acknowledgedRisks: ['runtime_token_materialization', 'github_http_request', 'redacted_observability_required', 'no_merge_execution'],
  releaseAckChecklist: ['live_http_preflight_handoff_recorded', 'operator_release_ack_recorded', 'runtime_secret_provider_smoke_required', 'secret_redaction_guardrail_required'],
  liveHttpReleasePlan: ['run_runtime_secret_provider_smoke', 'verify_redaction_guardrail', 'release_runtime_token_memory_only', 'perform_single_github_ruleset_get', 'record_response_without_merge']
});

export function normalizeMergeQueueLiveHttpOperatorReleaseAckPacket({
  releaseAckKey = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckKey,
  releaseAckKind = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckKind,
  releaseAckMode = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckMode,
  runtimeSecretRef = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseScope,
  acknowledgedRisks = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.acknowledgedRisks,
  releaseAckChecklist = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckChecklist,
  liveHttpReleasePlan = MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.liveHttpReleasePlan,
  mergeQueueLiveHttpExecutionPreflightHandoffReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseScope).trim() || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseScope;
  const cleanRisks = (Array.isArray(acknowledgedRisks) && acknowledgedRisks.length
    ? acknowledgedRisks
    : MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.acknowledgedRisks
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanChecklist = (Array.isArray(releaseAckChecklist) && releaseAckChecklist.length
    ? releaseAckChecklist
    : MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckChecklist
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanPlan = (Array.isArray(liveHttpReleasePlan) && liveHttpReleasePlan.length
    ? liveHttpReleasePlan
    : MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.liveHttpReleasePlan
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    releaseAckKey: String(releaseAckKey || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckKey).trim() || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckKey,
    releaseAckKind: String(releaseAckKind || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckKind).trim() || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckKind,
    releaseAckMode: String(releaseAckMode || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckMode).trim() || MERGE_QUEUE_LIVE_HTTP_OPERATOR_RELEASE_ACK_FIXTURE.releaseAckMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueLiveHttpExecutionPreflightHandoffReceiptId,
    mergeQueueLiveHttpOperatorReleaseAckRecorded: true,
    liveHttpExecutionPreflightHandoffObserved: true,
    operatorReleaseAckRecorded: true,
    operatorReleaseAckRequired: false,
    operatorLiveHttpRiskAcknowledged: true,
    runtimeSecretProviderSmokeRequired: true,
    secretRedactionGuardrailRequired: true,
    tokenReleaseApproved: false,
    httpExecutionPlanRecorded: true,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    acknowledgedRisks: cleanRisks,
    releaseAckChecklist: cleanChecklist,
    liveHttpReleasePlan: cleanPlan,
    operatorReleaseAckProof: {
      mergeQueueLiveHttpExecutionPreflightHandoffReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      requestMethod: cleanRequestMethod,
      releaseScope: cleanReleaseScope,
      acknowledgedRisks: cleanRisks,
      releaseAckChecklist: cleanChecklist,
      liveHttpReleasePlan: cleanPlan,
      operatorReleaseAckRecorded: true,
      operatorReleaseAckRequired: false,
      runtimeSecretProviderSmokeRequired: true,
      tokenReleaseApproved: false,
      tokenReleased: false,
      tokenMaterialized: false,
      authorizationHeaderMaterialized: false,
      httpRequestSent: false,
      liveGithubApiCalled: false,
      liveReadSucceeded: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['runtime_secret_provider_smoke', 'runtime_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueLiveHttpOperatorReleaseAckPacket(args = {}) {
  return normalizeMergeQueueLiveHttpOperatorReleaseAckPacket(args);
}

const MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE = Object.freeze({
  smokeReadinessKey: 'github_merge_queue_runtime_secret_provider_smoke_readiness',
  smokeReadinessKind: 'merge_queue_runtime_secret_provider_smoke_readiness',
  smokeReadinessMode: 'readiness_recorded_no_secret_access',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  smokeProvider: 'runtime_secret_provider',
  smokeCommand: 'npm run smoke:provider -- --provider=github --secret-ref=github_merge_queue_read_token --dry-run',
  smokeReadinessChecklist: ['operator_release_ack_recorded', 'runtime_secret_ref_present', 'secret_redaction_guardrail_observed', 'dry_run_smoke_command_recorded'],
  liveHttpReleasePlan: ['execute_runtime_secret_provider_smoke', 'release_runtime_token_memory_only', 'perform_single_github_ruleset_get', 'record_response_without_merge']
});

export function normalizeMergeQueueRuntimeSecretProviderSmokeReadinessPacket({
  smokeReadinessKey = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessKey,
  smokeReadinessKind = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessKind,
  smokeReadinessMode = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessMode,
  runtimeSecretRef = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.releaseScope,
  smokeProvider = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeProvider,
  smokeCommand = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeCommand,
  smokeReadinessChecklist = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessChecklist,
  liveHttpReleasePlan = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.liveHttpReleasePlan,
  mergeQueueLiveHttpOperatorReleaseAckReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.releaseScope).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.releaseScope;
  const cleanSmokeProvider = String(smokeProvider || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeProvider).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeProvider;
  const cleanSmokeCommand = String(smokeCommand || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeCommand).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeCommand;
  const cleanChecklist = (Array.isArray(smokeReadinessChecklist) && smokeReadinessChecklist.length
    ? smokeReadinessChecklist
    : MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessChecklist
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanPlan = (Array.isArray(liveHttpReleasePlan) && liveHttpReleasePlan.length
    ? liveHttpReleasePlan
    : MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.liveHttpReleasePlan
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    smokeReadinessKey: String(smokeReadinessKey || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessKey).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessKey,
    smokeReadinessKind: String(smokeReadinessKind || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessKind).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessKind,
    smokeReadinessMode: String(smokeReadinessMode || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessMode).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_READINESS_FIXTURE.smokeReadinessMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueLiveHttpOperatorReleaseAckReceiptId,
    mergeQueueRuntimeSecretProviderSmokeReadinessRecorded: true,
    liveHttpOperatorReleaseAckObserved: true,
    operatorReleaseAckRecorded: true,
    runtimeSecretProviderSmokeRequired: true,
    runtimeSecretProviderSmokeReadinessRecorded: true,
    runtimeSecretProviderSmokeExecuted: false,
    runtimeSecretProviderSmokePassed: false,
    runtimeSecretValueObserved: false,
    secretRedactionGuardrailRequired: true,
    secretRedactionGuardrailObserved: true,
    tokenReleaseApproved: false,
    httpExecutionPlanRecorded: true,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    smokeProvider: cleanSmokeProvider,
    smokeCommand: cleanSmokeCommand,
    smokeReadinessChecklist: cleanChecklist,
    liveHttpReleasePlan: cleanPlan,
    smokeReadinessProof: {
      mergeQueueLiveHttpOperatorReleaseAckReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      requestMethod: cleanRequestMethod,
      releaseScope: cleanReleaseScope,
      smokeProvider: cleanSmokeProvider,
      smokeCommand: cleanSmokeCommand,
      smokeReadinessChecklist: cleanChecklist,
      liveHttpReleasePlan: cleanPlan,
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
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['runtime_secret_provider_smoke', 'runtime_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueRuntimeSecretProviderSmokeReadinessPacket(args = {}) {
  return normalizeMergeQueueRuntimeSecretProviderSmokeReadinessPacket(args);
}

const MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE = Object.freeze({
  smokeGateKey: 'github_merge_queue_runtime_secret_provider_smoke_execution_gate',
  smokeGateKind: 'merge_queue_runtime_secret_provider_smoke_execution_gate',
  smokeGateMode: 'execution_blocked_no_secret_access',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  smokeProvider: 'runtime_secret_provider',
  smokeCommand: 'npm run smoke:provider -- --provider=github --secret-ref=github_merge_queue_read_token --live',
  blockedReasons: ['live_runtime_secret_provider_not_enabled', 'runtime_secret_value_access_disallowed', 'token_release_requires_passed_smoke'],
  smokeExecutionChecklist: ['smoke_readiness_recorded', 'operator_release_ack_recorded', 'secret_access_blocked', 'token_release_denied'],
  liveHttpReleasePlan: ['run_successful_runtime_secret_provider_smoke', 'release_runtime_token_memory_only', 'perform_single_github_ruleset_get', 'record_response_without_merge']
});

export function normalizeMergeQueueRuntimeSecretProviderSmokeExecutionGatePacket({
  smokeGateKey = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateKey,
  smokeGateKind = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateKind,
  smokeGateMode = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateMode,
  runtimeSecretRef = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.releaseScope,
  smokeProvider = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeProvider,
  smokeCommand = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeCommand,
  blockedReasons = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.blockedReasons,
  smokeExecutionChecklist = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeExecutionChecklist,
  liveHttpReleasePlan = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.liveHttpReleasePlan,
  mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.releaseScope).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.releaseScope;
  const cleanSmokeProvider = String(smokeProvider || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeProvider).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeProvider;
  const cleanSmokeCommand = String(smokeCommand || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeCommand).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeCommand;
  const cleanBlockedReasons = (Array.isArray(blockedReasons) && blockedReasons.length
    ? blockedReasons
    : MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.blockedReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanChecklist = (Array.isArray(smokeExecutionChecklist) && smokeExecutionChecklist.length
    ? smokeExecutionChecklist
    : MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeExecutionChecklist
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanPlan = (Array.isArray(liveHttpReleasePlan) && liveHttpReleasePlan.length
    ? liveHttpReleasePlan
    : MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.liveHttpReleasePlan
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    smokeGateKey: String(smokeGateKey || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateKey).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateKey,
    smokeGateKind: String(smokeGateKind || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateKind).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateKind,
    smokeGateMode: String(smokeGateMode || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateMode).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EXECUTION_GATE_FIXTURE.smokeGateMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId,
    mergeQueueRuntimeSecretProviderSmokeExecutionGateRecorded: true,
    runtimeSecretProviderSmokeReadinessObserved: true,
    liveHttpOperatorReleaseAckObserved: true,
    runtimeSecretProviderSmokeRequired: true,
    runtimeSecretProviderSmokeExecutionBlocked: true,
    runtimeSecretProviderSmokeAttempted: false,
    runtimeSecretProviderSmokeExecuted: false,
    runtimeSecretProviderSmokePassed: false,
    runtimeSecretValueObserved: false,
    secretRedactionGuardrailObserved: true,
    tokenReleaseApproved: false,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    smokeProvider: cleanSmokeProvider,
    smokeCommand: cleanSmokeCommand,
    blockedReasons: cleanBlockedReasons,
    smokeExecutionChecklist: cleanChecklist,
    liveHttpReleasePlan: cleanPlan,
    smokeExecutionGateProof: {
      mergeQueueRuntimeSecretProviderSmokeReadinessReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      smokeProvider: cleanSmokeProvider,
      smokeCommand: cleanSmokeCommand,
      blockedReasons: cleanBlockedReasons,
      smokeExecutionChecklist: cleanChecklist,
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
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['runtime_secret_provider_smoke', 'runtime_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueRuntimeSecretProviderSmokeExecutionGatePacket(args = {}) {
  return normalizeMergeQueueRuntimeSecretProviderSmokeExecutionGatePacket(args);
}

const MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE = Object.freeze({
  evidenceReviewKey: 'github_merge_queue_runtime_secret_provider_smoke_evidence_review',
  evidenceReviewKind: 'merge_queue_runtime_secret_provider_smoke_evidence_review',
  evidenceReviewMode: 'missing_successful_smoke_evidence',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  smokeProvider: 'runtime_secret_provider',
  smokeCommand: 'npm run smoke:provider -- --provider=github --secret-ref=github_merge_queue_read_token --live',
  evidenceRequirements: ['timestamped_smoke_command', 'provider_status_snapshot', 'redacted_success_output', 'operator_attestation', 'no_secret_value_logged'],
  evidenceFindings: ['successful_smoke_evidence_missing', 'runtime_secret_value_not_observed', 'token_release_still_denied'],
  releaseCriteria: ['successful_runtime_secret_provider_smoke_verified', 'memory_only_token_release_preflight', 'single_github_ruleset_get_response_capture', 'operator_merge_blocker_review']
});

export function normalizeMergeQueueRuntimeSecretProviderSmokeEvidenceReviewPacket({
  evidenceReviewKey = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewKey,
  evidenceReviewKind = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewKind,
  evidenceReviewMode = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewMode,
  runtimeSecretRef = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.releaseScope,
  smokeProvider = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.smokeProvider,
  smokeCommand = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.smokeCommand,
  evidenceRequirements = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceRequirements,
  evidenceFindings = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceFindings,
  releaseCriteria = MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.releaseCriteria,
  mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.releaseScope).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.releaseScope;
  const cleanSmokeProvider = String(smokeProvider || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.smokeProvider).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.smokeProvider;
  const cleanSmokeCommand = String(smokeCommand || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.smokeCommand).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.smokeCommand;
  const cleanRequirements = (Array.isArray(evidenceRequirements) && evidenceRequirements.length
    ? evidenceRequirements
    : MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceRequirements
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanFindings = (Array.isArray(evidenceFindings) && evidenceFindings.length
    ? evidenceFindings
    : MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceFindings
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanCriteria = (Array.isArray(releaseCriteria) && releaseCriteria.length
    ? releaseCriteria
    : MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.releaseCriteria
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    evidenceReviewKey: String(evidenceReviewKey || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewKey).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewKey,
    evidenceReviewKind: String(evidenceReviewKind || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewKind).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewKind,
    evidenceReviewMode: String(evidenceReviewMode || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewMode).trim() || MERGE_QUEUE_RUNTIME_SECRET_PROVIDER_SMOKE_EVIDENCE_REVIEW_FIXTURE.evidenceReviewMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId,
    mergeQueueRuntimeSecretProviderSmokeEvidenceReviewRecorded: true,
    runtimeSecretProviderSmokeExecutionGateObserved: true,
    runtimeSecretProviderSmokeReadinessObserved: true,
    liveHttpOperatorReleaseAckObserved: true,
    runtimeSecretProviderSmokeRequired: true,
    successfulSmokeEvidenceRequired: true,
    successfulSmokeEvidenceObserved: false,
    runtimeSecretProviderSmokeVerified: false,
    runtimeSecretProviderSmokeAttempted: false,
    runtimeSecretProviderSmokeExecuted: false,
    runtimeSecretProviderSmokePassed: false,
    runtimeSecretValueObserved: false,
    secretRedactionGuardrailObserved: true,
    tokenReleaseApproved: false,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    smokeProvider: cleanSmokeProvider,
    smokeCommand: cleanSmokeCommand,
    evidenceRequirements: cleanRequirements,
    evidenceFindings: cleanFindings,
    releaseCriteria: cleanCriteria,
    smokeEvidenceReviewProof: {
      mergeQueueRuntimeSecretProviderSmokeExecutionGateReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      smokeProvider: cleanSmokeProvider,
      smokeCommand: cleanSmokeCommand,
      evidenceRequirements: cleanRequirements,
      evidenceFindings: cleanFindings,
      releaseCriteria: cleanCriteria,
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
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['successful_smoke_evidence', 'runtime_secret_provider_smoke', 'runtime_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueRuntimeSecretProviderSmokeEvidenceReviewPacket(args = {}) {
  return normalizeMergeQueueRuntimeSecretProviderSmokeEvidenceReviewPacket(args);
}

const MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE = Object.freeze({
  tokenPreflightKey: 'github_merge_queue_memory_only_runtime_token_release_preflight',
  tokenPreflightKind: 'merge_queue_memory_only_runtime_token_release_preflight',
  tokenPreflightMode: 'release_blocked_no_successful_smoke',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  releasePreflightRequirements: ['successful_smoke_evidence_observed', 'runtime_secret_provider_smoke_verified', 'memory_only_token_scope', 'redacted_authorization_header_plan'],
  releaseDeniedReasons: ['successful_smoke_evidence_missing', 'runtime_secret_provider_smoke_not_verified', 'token_materialization_disallowed'],
  nextLiveReadCriteria: ['memory_only_token_release_allowed', 'single_github_ruleset_get_only', 'record_response_without_merge']
});

export function normalizeMergeQueueMemoryOnlyRuntimeTokenReleasePreflightPacket({
  tokenPreflightKey = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightKey,
  tokenPreflightKind = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightKind,
  tokenPreflightMode = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightMode,
  runtimeSecretRef = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.releaseScope,
  releasePreflightRequirements = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.releasePreflightRequirements,
  releaseDeniedReasons = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.releaseDeniedReasons,
  nextLiveReadCriteria = MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.nextLiveReadCriteria,
  mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.releaseScope).trim() || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.releaseScope;
  const cleanRequirements = (Array.isArray(releasePreflightRequirements) && releasePreflightRequirements.length
    ? releasePreflightRequirements
    : MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.releasePreflightRequirements
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanDeniedReasons = (Array.isArray(releaseDeniedReasons) && releaseDeniedReasons.length
    ? releaseDeniedReasons
    : MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.releaseDeniedReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanNextLiveReadCriteria = (Array.isArray(nextLiveReadCriteria) && nextLiveReadCriteria.length
    ? nextLiveReadCriteria
    : MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.nextLiveReadCriteria
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    tokenPreflightKey: String(tokenPreflightKey || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightKey).trim() || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightKey,
    tokenPreflightKind: String(tokenPreflightKind || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightKind).trim() || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightKind,
    tokenPreflightMode: String(tokenPreflightMode || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightMode).trim() || MERGE_QUEUE_MEMORY_ONLY_RUNTIME_TOKEN_RELEASE_PREFLIGHT_FIXTURE.tokenPreflightMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId,
    mergeQueueMemoryOnlyRuntimeTokenReleasePreflightRecorded: true,
    runtimeSecretProviderSmokeEvidenceReviewObserved: true,
    successfulSmokeEvidenceRequired: true,
    successfulSmokeEvidenceObserved: false,
    runtimeSecretProviderSmokeVerified: false,
    memoryOnlyTokenReleasePreflightRecorded: true,
    memoryOnlyTokenReleaseAllowed: false,
    tokenReleaseApproved: false,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    releasePreflightRequirements: cleanRequirements,
    releaseDeniedReasons: cleanDeniedReasons,
    nextLiveReadCriteria: cleanNextLiveReadCriteria,
    memoryOnlyTokenReleasePreflightProof: {
      mergeQueueRuntimeSecretProviderSmokeEvidenceReviewReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      requestMethod: cleanRequestMethod,
      releaseScope: cleanReleaseScope,
      releasePreflightRequirements: cleanRequirements,
      releaseDeniedReasons: cleanDeniedReasons,
      nextLiveReadCriteria: cleanNextLiveReadCriteria,
      successfulSmokeEvidenceObserved: false,
      runtimeSecretProviderSmokeVerified: false,
      memoryOnlyTokenReleaseAllowed: false,
      tokenReleaseApproved: false,
      tokenReleased: false,
      tokenMaterialized: false,
      authorizationHeaderMaterialized: false,
      httpRequestSent: false,
      liveGithubApiCalled: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['successful_smoke_evidence', 'runtime_secret_provider_smoke', 'memory_only_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueMemoryOnlyRuntimeTokenReleasePreflightPacket(args = {}) {
  return normalizeMergeQueueMemoryOnlyRuntimeTokenReleasePreflightPacket(args);
}

const MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE = Object.freeze({
  smokeEvidenceIngestionKey: 'github_merge_queue_successful_smoke_evidence_ingestion',
  smokeEvidenceIngestionKind: 'merge_queue_successful_smoke_evidence_ingestion',
  smokeEvidenceIngestionMode: 'fake_success_rejected',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  smokeProvider: 'runtime_secret_provider',
  claimedSmokeCommand: 'npm run smoke:provider -- --provider=github --secret-ref=github_merge_queue_read_token --live',
  evidenceSource: 'operator_submitted_smoke_evidence_payload',
  evidenceRequirements: ['timestamped_smoke_command', 'provider_status_snapshot', 'redacted_success_output', 'operator_attestation', 'no_secret_value_logged'],
  rejectionReasons: ['successful_smoke_claim_not_backed_by_execution_gate', 'runtime_secret_provider_smoke_not_verified', 'token_release_preflight_denied'],
  nextCriteria: ['real_runtime_secret_provider_smoke_execution_receipt', 'redacted_success_output_review', 'memory_only_token_release_recheck']
});

export function normalizeMergeQueueSuccessfulSmokeEvidenceIngestionPacket({
  smokeEvidenceIngestionKey = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionKey,
  smokeEvidenceIngestionKind = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionKind,
  smokeEvidenceIngestionMode = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionMode,
  runtimeSecretRef = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.releaseScope,
  smokeProvider = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeProvider,
  claimedSmokeCommand = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.claimedSmokeCommand,
  evidenceSource = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.evidenceSource,
  evidenceRequirements = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.evidenceRequirements,
  rejectionReasons = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.rejectionReasons,
  nextCriteria = MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.nextCriteria,
  mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.releaseScope).trim() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.releaseScope;
  const cleanSmokeProvider = String(smokeProvider || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeProvider).trim() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeProvider;
  const cleanClaimedSmokeCommand = String(claimedSmokeCommand || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.claimedSmokeCommand).trim() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.claimedSmokeCommand;
  const cleanEvidenceSource = String(evidenceSource || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.evidenceSource).trim() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.evidenceSource;
  const cleanRequirements = (Array.isArray(evidenceRequirements) && evidenceRequirements.length
    ? evidenceRequirements
    : MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.evidenceRequirements
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanRejectionReasons = (Array.isArray(rejectionReasons) && rejectionReasons.length
    ? rejectionReasons
    : MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.rejectionReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanNextCriteria = (Array.isArray(nextCriteria) && nextCriteria.length
    ? nextCriteria
    : MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.nextCriteria
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    smokeEvidenceIngestionKey: String(smokeEvidenceIngestionKey || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionKey).trim() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionKey,
    smokeEvidenceIngestionKind: String(smokeEvidenceIngestionKind || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionKind).trim() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionKind,
    smokeEvidenceIngestionMode: String(smokeEvidenceIngestionMode || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionMode).trim() || MERGE_QUEUE_SUCCESSFUL_SMOKE_EVIDENCE_INGESTION_FIXTURE.smokeEvidenceIngestionMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId,
    mergeQueueSuccessfulSmokeEvidenceIngestionRecorded: true,
    memoryOnlyRuntimeTokenReleasePreflightObserved: true,
    successfulSmokeEvidenceSubmitted: true,
    successfulSmokeEvidenceRequired: true,
    successfulSmokeEvidenceAccepted: false,
    successfulSmokeEvidenceObserved: false,
    fakeSuccessClaimRejected: true,
    runtimeSecretProviderSmokeVerified: false,
    memoryOnlyTokenReleaseAllowed: false,
    tokenReleaseApproved: false,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    smokeProvider: cleanSmokeProvider,
    claimedSmokeCommand: cleanClaimedSmokeCommand,
    evidenceSource: cleanEvidenceSource,
    evidenceRequirements: cleanRequirements,
    rejectionReasons: cleanRejectionReasons,
    nextCriteria: cleanNextCriteria,
    successfulSmokeEvidenceIngestionProof: {
      mergeQueueMemoryOnlyRuntimeTokenReleasePreflightReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      requestMethod: cleanRequestMethod,
      releaseScope: cleanReleaseScope,
      smokeProvider: cleanSmokeProvider,
      claimedSmokeCommand: cleanClaimedSmokeCommand,
      evidenceSource: cleanEvidenceSource,
      evidenceRequirements: cleanRequirements,
      rejectionReasons: cleanRejectionReasons,
      nextCriteria: cleanNextCriteria,
      successfulSmokeEvidenceSubmitted: true,
      successfulSmokeEvidenceAccepted: false,
      successfulSmokeEvidenceObserved: false,
      fakeSuccessClaimRejected: true,
      runtimeSecretProviderSmokeVerified: false,
      memoryOnlyTokenReleaseAllowed: false,
      tokenReleaseApproved: false,
      tokenReleased: false,
      tokenMaterialized: false,
      authorizationHeaderMaterialized: false,
      httpRequestSent: false,
      liveGithubApiCalled: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['successful_smoke_evidence', 'runtime_secret_provider_smoke', 'memory_only_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueSuccessfulSmokeEvidenceIngestionPacket(args = {}) {
  return normalizeMergeQueueSuccessfulSmokeEvidenceIngestionPacket(args);
}

const MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE = Object.freeze({
  tokenReleaseDenialKey: 'github_merge_queue_runtime_token_release_denial',
  tokenReleaseDenialKind: 'merge_queue_runtime_token_release_denial',
  tokenReleaseDenialMode: 'denied_after_fake_smoke_evidence',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  denialPolicy: 'successful_smoke_evidence_required_before_runtime_token_release',
  denialReasons: ['fake_success_claim_rejected', 'runtime_secret_provider_smoke_not_verified', 'successful_smoke_evidence_not_accepted'],
  retryCriteria: ['real_runtime_secret_provider_smoke_execution_receipt', 'accepted_redacted_success_output', 'fresh_memory_only_token_release_preflight']
});

export function normalizeMergeQueueRuntimeTokenReleaseDenialPacket({
  tokenReleaseDenialKey = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialKey,
  tokenReleaseDenialKind = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialKind,
  tokenReleaseDenialMode = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialMode,
  runtimeSecretRef = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.releaseScope,
  denialPolicy = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.denialPolicy,
  denialReasons = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.denialReasons,
  retryCriteria = MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.retryCriteria,
  mergeQueueSuccessfulSmokeEvidenceIngestionReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.releaseScope).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.releaseScope;
  const cleanDenialPolicy = String(denialPolicy || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.denialPolicy).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.denialPolicy;
  const cleanDenialReasons = (Array.isArray(denialReasons) && denialReasons.length
    ? denialReasons
    : MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.denialReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanRetryCriteria = (Array.isArray(retryCriteria) && retryCriteria.length
    ? retryCriteria
    : MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.retryCriteria
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    tokenReleaseDenialKey: String(tokenReleaseDenialKey || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialKey).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialKey,
    tokenReleaseDenialKind: String(tokenReleaseDenialKind || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialKind).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialKind,
    tokenReleaseDenialMode: String(tokenReleaseDenialMode || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialMode).trim() || MERGE_QUEUE_RUNTIME_TOKEN_RELEASE_DENIAL_FIXTURE.tokenReleaseDenialMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueSuccessfulSmokeEvidenceIngestionReceiptId,
    mergeQueueRuntimeTokenReleaseDenialRecorded: true,
    successfulSmokeEvidenceIngestionObserved: true,
    fakeSuccessClaimRejected: true,
    successfulSmokeEvidenceAccepted: false,
    successfulSmokeEvidenceObserved: false,
    runtimeSecretProviderSmokeVerified: false,
    runtimeTokenReleaseRequested: true,
    runtimeTokenReleaseDenied: true,
    memoryOnlyTokenReleaseAllowed: false,
    tokenReleaseApproved: false,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    denialPolicy: cleanDenialPolicy,
    denialReasons: cleanDenialReasons,
    retryCriteria: cleanRetryCriteria,
    runtimeTokenReleaseDenialProof: {
      mergeQueueSuccessfulSmokeEvidenceIngestionReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      requestMethod: cleanRequestMethod,
      releaseScope: cleanReleaseScope,
      denialPolicy: cleanDenialPolicy,
      denialReasons: cleanDenialReasons,
      retryCriteria: cleanRetryCriteria,
      fakeSuccessClaimRejected: true,
      successfulSmokeEvidenceAccepted: false,
      successfulSmokeEvidenceObserved: false,
      runtimeSecretProviderSmokeVerified: false,
      runtimeTokenReleaseRequested: true,
      runtimeTokenReleaseDenied: true,
      memoryOnlyTokenReleaseAllowed: false,
      tokenReleaseApproved: false,
      tokenReleased: false,
      tokenMaterialized: false,
      authorizationHeaderMaterialized: false,
      httpRequestSent: false,
      liveGithubApiCalled: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['runtime_token_release_denied', 'successful_smoke_evidence', 'runtime_secret_provider_smoke', 'memory_only_token_release', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueRuntimeTokenReleaseDenialPacket(args = {}) {
  return normalizeMergeQueueRuntimeTokenReleaseDenialPacket(args);
}

const MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE = Object.freeze({
  replayQuarantineKey: 'github_merge_queue_fake_live_read_replay_quarantine',
  replayQuarantineKind: 'merge_queue_fake_live_read_replay_quarantine',
  replayQuarantineMode: 'quarantined_after_token_denial',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  replaySource: 'operator_submitted_live_read_response_payload',
  quarantineReasons: ['runtime_token_release_denied', 'no_live_github_http_request', 'response_not_bound_to_fresh_runtime_secret'],
  releaseCriteria: ['fresh_runtime_token_release_allowed', 'single_github_ruleset_get_http_receipt', 'redacted_response_capture']
});

export function normalizeMergeQueueFakeLiveReadReplayQuarantinePacket({
  replayQuarantineKey = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineKey,
  replayQuarantineKind = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineKind,
  replayQuarantineMode = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineMode,
  runtimeSecretRef = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.releaseScope,
  replaySource = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replaySource,
  quarantineReasons = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.quarantineReasons,
  releaseCriteria = MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.releaseCriteria,
  mergeQueueRuntimeTokenReleaseDenialReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.releaseScope).trim() || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.releaseScope;
  const cleanReplaySource = String(replaySource || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replaySource).trim() || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replaySource;
  const cleanQuarantineReasons = (Array.isArray(quarantineReasons) && quarantineReasons.length
    ? quarantineReasons
    : MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.quarantineReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanReleaseCriteria = (Array.isArray(releaseCriteria) && releaseCriteria.length
    ? releaseCriteria
    : MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.releaseCriteria
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    replayQuarantineKey: String(replayQuarantineKey || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineKey).trim() || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineKey,
    replayQuarantineKind: String(replayQuarantineKind || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineKind).trim() || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineKind,
    replayQuarantineMode: String(replayQuarantineMode || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineMode).trim() || MERGE_QUEUE_FAKE_LIVE_READ_REPLAY_QUARANTINE_FIXTURE.replayQuarantineMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueRuntimeTokenReleaseDenialReceiptId,
    mergeQueueFakeLiveReadReplayQuarantineRecorded: true,
    runtimeTokenReleaseDenialObserved: true,
    runtimeTokenReleaseDenied: true,
    fakeLiveReadReplaySubmitted: true,
    fakeLiveReadReplayQuarantined: true,
    liveReadResponseAccepted: false,
    liveReadReplayAccepted: false,
    runtimeSecretProviderSmokeVerified: false,
    memoryOnlyTokenReleaseAllowed: false,
    tokenReleaseApproved: false,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    replaySource: cleanReplaySource,
    quarantineReasons: cleanQuarantineReasons,
    releaseCriteria: cleanReleaseCriteria,
    fakeLiveReadReplayQuarantineProof: {
      mergeQueueRuntimeTokenReleaseDenialReceiptId,
      runtimeSecretRef: cleanRuntimeSecretRef,
      requestMethod: cleanRequestMethod,
      releaseScope: cleanReleaseScope,
      replaySource: cleanReplaySource,
      quarantineReasons: cleanQuarantineReasons,
      releaseCriteria: cleanReleaseCriteria,
      runtimeTokenReleaseDenied: true,
      fakeLiveReadReplaySubmitted: true,
      fakeLiveReadReplayQuarantined: true,
      liveReadResponseAccepted: false,
      liveReadReplayAccepted: false,
      runtimeSecretProviderSmokeVerified: false,
      tokenReleaseApproved: false,
      tokenReleased: false,
      tokenMaterialized: false,
      authorizationHeaderMaterialized: false,
      httpRequestSent: false,
      liveGithubApiCalled: false,
      mergeExecutionAllowed: false
    },
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['fake_live_read_replay_quarantined', 'runtime_token_release_denied', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueFakeLiveReadReplayQuarantinePacket(args = {}) {
  return normalizeMergeQueueFakeLiveReadReplayQuarantinePacket(args);
}

const MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE = Object.freeze({
  finalBlockerLedgerKey: 'github_merge_queue_final_blocker_ledger',
  finalBlockerLedgerKind: 'merge_queue_final_blocker_ledger',
  finalBlockerLedgerMode: 'sealed_after_replay_quarantine',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  blockerEntries: [
    'runtime_secret_provider_smoke_missing',
    'runtime_token_release_denied',
    'fake_live_read_replay_quarantined',
    'live_github_http_request_missing',
    'merge_execution_blocked'
  ],
  releaseCriteria: ['fresh_runtime_secret_provider_smoke_receipt', 'fresh_runtime_token_release_receipt', 'single_github_ruleset_get_http_receipt', 'operator_merge_release_ack']
});

export function normalizeMergeQueueFinalBlockerLedgerPacket({
  finalBlockerLedgerKey = MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerKey,
  finalBlockerLedgerKind = MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerKind,
  finalBlockerLedgerMode = MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerMode,
  runtimeSecretRef = MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.releaseScope,
  blockerEntries = MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.blockerEntries,
  releaseCriteria = MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.releaseCriteria,
  mergeQueueFakeLiveReadReplayQuarantineReceiptId = null,
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.releaseScope).trim() || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.releaseScope;
  const cleanBlockerEntries = (Array.isArray(blockerEntries) && blockerEntries.length
    ? blockerEntries
    : MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.blockerEntries
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanReleaseCriteria = (Array.isArray(releaseCriteria) && releaseCriteria.length
    ? releaseCriteria
    : MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.releaseCriteria
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    finalBlockerLedgerKey: String(finalBlockerLedgerKey || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerKey).trim() || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerKey,
    finalBlockerLedgerKind: String(finalBlockerLedgerKind || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerKind).trim() || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerKind,
    finalBlockerLedgerMode: String(finalBlockerLedgerMode || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerMode).trim() || MERGE_QUEUE_FINAL_BLOCKER_LEDGER_FIXTURE.finalBlockerLedgerMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueFakeLiveReadReplayQuarantineReceiptId,
    mergeQueueFinalBlockerLedgerRecorded: true,
    replayQuarantineObserved: true,
    runtimeTokenReleaseDenied: true,
    fakeLiveReadReplayQuarantined: true,
    finalBlockerLedgerSealed: true,
    requiredBlockersPresent: true,
    blockerCount: cleanBlockerEntries.length,
    blockerEntries: cleanBlockerEntries,
    releaseCriteria: cleanReleaseCriteria,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    runtimeSecretProviderSmokeVerified: false,
    memoryOnlyTokenReleaseAllowed: false,
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: cleanBlockerEntries
  };
}

export function runMergeQueueFinalBlockerLedgerPacket(args = {}) {
  return normalizeMergeQueueFinalBlockerLedgerPacket(args);
}

const MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE = Object.freeze({
  releaseAttestationKey: 'github_merge_queue_post_ledger_operator_release_attestation',
  releaseAttestationKind: 'merge_queue_post_ledger_operator_release_attestation',
  releaseAttestationMode: 'blocked_by_final_blocker_ledger',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  attestationReasons: ['final_blocker_ledger_sealed', 'runtime_token_release_denied', 'fake_live_read_replay_quarantined', 'live_http_receipt_missing']
});

export function normalizeMergeQueuePostLedgerOperatorReleaseAttestationPacket({
  releaseAttestationKey = MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationKey,
  releaseAttestationKind = MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationKind,
  releaseAttestationMode = MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationMode,
  runtimeSecretRef = MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseScope,
  attestationReasons = MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.attestationReasons,
  mergeQueueFinalBlockerLedgerReceiptId = null,
  operatorId = 'local_operator',
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseScope).trim() || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseScope;
  const cleanAttestationReasons = (Array.isArray(attestationReasons) && attestationReasons.length
    ? attestationReasons
    : MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.attestationReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    releaseAttestationKey: String(releaseAttestationKey || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationKey).trim() || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationKey,
    releaseAttestationKind: String(releaseAttestationKind || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationKind).trim() || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationKind,
    releaseAttestationMode: String(releaseAttestationMode || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationMode).trim() || MERGE_QUEUE_POST_LEDGER_OPERATOR_RELEASE_ATTESTATION_FIXTURE.releaseAttestationMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueueFinalBlockerLedgerReceiptId,
    operatorId: String(operatorId || 'local_operator').trim() || 'local_operator',
    mergeQueuePostLedgerOperatorReleaseAttestationRecorded: true,
    finalBlockerLedgerObserved: true,
    requiredBlockersPresent: true,
    operatorReleaseRequested: true,
    operatorReleaseAttested: true,
    operatorReleaseBlocked: true,
    operatorOverrideAllowed: false,
    releaseApproved: false,
    liveHttpReleaseAllowed: false,
    runtimeTokenReleaseDenied: true,
    fakeLiveReadReplayQuarantined: true,
    finalBlockerLedgerSealed: true,
    attestationReasons: cleanAttestationReasons,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    runtimeSecretProviderSmokeVerified: false,
    memoryOnlyTokenReleaseAllowed: false,
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['operator_release_blocked_by_final_blocker_ledger', 'final_blocker_ledger_sealed', 'runtime_token_release_denied', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueuePostLedgerOperatorReleaseAttestationPacket(args = {}) {
  return normalizeMergeQueuePostLedgerOperatorReleaseAttestationPacket(args);
}

const MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE = Object.freeze({
  releaseEscrowKey: 'github_merge_queue_post_attestation_release_escrow',
  releaseEscrowKind: 'merge_queue_post_attestation_release_escrow',
  releaseEscrowMode: 'held_by_final_blocker_ledger',
  runtimeSecretRef: MERGE_QUEUE_LIVE_READ_PREFLIGHT_FIXTURE.runtimeSecretRef,
  requestMethod: 'GET',
  releaseScope: 'single_github_ruleset_get',
  escrowReasons: ['post_ledger_operator_release_attestation_observed', 'operator_release_blocked', 'final_blocker_ledger_sealed', 'live_http_release_missing']
});

export function normalizeMergeQueuePostAttestationReleaseEscrowPacket({
  releaseEscrowKey = MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowKey,
  releaseEscrowKind = MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowKind,
  releaseEscrowMode = MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowMode,
  runtimeSecretRef = MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.runtimeSecretRef,
  requestMethod = MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.requestMethod,
  releaseScope = MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseScope,
  escrowReasons = MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.escrowReasons,
  mergeQueuePostLedgerOperatorReleaseAttestationReceiptId = null,
  operatorId = 'local_operator',
  now = Date.now()
} = {}) {
  const cleanRuntimeSecretRef = String(runtimeSecretRef || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.runtimeSecretRef).trim() || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.runtimeSecretRef;
  const cleanRequestMethod = String(requestMethod || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.requestMethod).trim().toUpperCase() || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.requestMethod;
  const cleanReleaseScope = String(releaseScope || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseScope).trim() || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseScope;
  const cleanEscrowReasons = (Array.isArray(escrowReasons) && escrowReasons.length
    ? escrowReasons
    : MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.escrowReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    releaseEscrowKey: String(releaseEscrowKey || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowKey).trim() || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowKey,
    releaseEscrowKind: String(releaseEscrowKind || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowKind).trim() || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowKind,
    releaseEscrowMode: String(releaseEscrowMode || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowMode).trim() || MERGE_QUEUE_POST_ATTESTATION_RELEASE_ESCROW_FIXTURE.releaseEscrowMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueuePostLedgerOperatorReleaseAttestationReceiptId,
    operatorId: String(operatorId || 'local_operator').trim() || 'local_operator',
    mergeQueuePostAttestationReleaseEscrowRecorded: true,
    postLedgerOperatorReleaseAttestationObserved: true,
    operatorReleaseBlocked: true,
    operatorOverrideAllowed: false,
    releaseEscrowRequested: true,
    releaseEscrowHeld: true,
    escrowReleased: false,
    releaseApproved: false,
    liveHttpReleaseAllowed: false,
    finalBlockerLedgerSealed: true,
    runtimeTokenReleaseDenied: true,
    fakeLiveReadReplayQuarantined: true,
    escrowReasons: cleanEscrowReasons,
    runtimeSecretRef: cleanRuntimeSecretRef,
    requestMethod: cleanRequestMethod,
    releaseScope: cleanReleaseScope,
    runtimeSecretProviderSmokeVerified: false,
    memoryOnlyTokenReleaseAllowed: false,
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['post_attestation_release_escrow_held_by_final_blocker_ledger', 'operator_release_blocked_by_final_blocker_ledger', 'final_blocker_ledger_sealed', 'runtime_token_release_denied', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueuePostAttestationReleaseEscrowPacket(args = {}) {
  return normalizeMergeQueuePostAttestationReleaseEscrowPacket(args);
}

const MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE = Object.freeze({
  closeoutKey: 'github_merge_queue_release_denial_closeout',
  closeoutKind: 'merge_queue_release_denial_closeout',
  closeoutMode: 'release_denied_after_escrow',
  denialReasons: ['post_attestation_release_escrow_held', 'final_blocker_ledger_sealed', 'runtime_token_release_denied', 'live_http_release_missing'],
  remediationActions: ['restore_parent_receipt_chain', 'record_real_runtime_secret_provider_smoke', 'rerun_live_merge_authorization_preflight']
});

export function normalizeMergeQueueReleaseDenialCloseoutPacket({
  closeoutKey = MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutKey,
  closeoutKind = MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutKind,
  closeoutMode = MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutMode,
  denialReasons = MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.denialReasons,
  remediationActions = MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.remediationActions,
  mergeQueuePostAttestationReleaseEscrowReceiptId = null,
  operatorId = 'local_operator',
  now = Date.now()
} = {}) {
  const cleanDenialReasons = (Array.isArray(denialReasons) && denialReasons.length
    ? denialReasons
    : MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.denialReasons
  ).map((item) => String(item || '').trim()).filter(Boolean);
  const cleanRemediationActions = (Array.isArray(remediationActions) && remediationActions.length
    ? remediationActions
    : MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.remediationActions
  ).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    ok: true,
    closeoutKey: String(closeoutKey || MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutKey).trim() || MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutKey,
    closeoutKind: String(closeoutKind || MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutKind).trim() || MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutKind,
    closeoutMode: String(closeoutMode || MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutMode).trim() || MERGE_QUEUE_RELEASE_DENIAL_CLOSEOUT_FIXTURE.closeoutMode,
    fixtureSource: 'server/evalAdapters.js',
    executedAt: new Date(now).toISOString(),
    mergeQueuePostAttestationReleaseEscrowReceiptId,
    operatorId: String(operatorId || 'local_operator').trim() || 'local_operator',
    mergeQueueReleaseDenialCloseoutRecorded: true,
    postAttestationReleaseEscrowObserved: true,
    releaseEscrowHeld: true,
    escrowReleased: false,
    releaseApproved: false,
    releaseDenied: true,
    releaseDenialSealed: true,
    closeoutRecorded: true,
    denialReasons: cleanDenialReasons,
    remediationActions: cleanRemediationActions,
    finalBlockerLedgerSealed: true,
    runtimeTokenReleaseDenied: true,
    runtimeSecretProviderSmokeVerified: false,
    memoryOnlyTokenReleaseAllowed: false,
    realTokenObserved: false,
    tokenReleaseApproved: false,
    tokenReleased: false,
    tokenMaterialized: false,
    tokenValueIncluded: false,
    tokenValuePersisted: false,
    tokenValueLogged: false,
    authorizationHeaderMaterialized: false,
    httpRequestSent: false,
    liveReadAttempted: false,
    liveGithubApiCalled: false,
    liveReadSucceeded: false,
    mergeQueueLiveVerified: false,
    liveVerificationPromoted: false,
    adapterMutationAttempted: false,
    mergeQueueMutated: false,
    branchProtectionMutated: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    remainingBlockers: ['release_denied_after_post_attestation_escrow', 'post_attestation_release_escrow_held_by_final_blocker_ledger', 'runtime_token_release_denied', 'live_github_http_request', 'live_merge_execution_attempt']
  };
}

export function runMergeQueueReleaseDenialCloseoutPacket(args = {}) {
  return normalizeMergeQueueReleaseDenialCloseoutPacket(args);
}
