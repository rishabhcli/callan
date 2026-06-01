#!/usr/bin/env node

import assert from 'node:assert/strict';
import { runOperatorHandoffEvalLiveAdapterContract } from '../../server/evalAdapters.js';

const startedAt = Date.now();

try {
  const result = runOperatorHandoffEvalLiveAdapterContract({
    now: Date.UTC(2026, 4, 28, 20, 8, 0)
  });
  const failed = result.cases.filter((item) => !item.ok);

  assert.equal(result.ok, true, 'operator handoff live-adapter contract must pass');
  assert.equal(failed.length, 0, 'all golden handoff fixtures must pass');
  assert(result.cases.length >= 5, 'expected at least five golden handoff fixtures');
  assert.equal(result.inProcessOnly, true, 'contract must stay in-process');
  assert.equal(result.nonMutating, true, 'contract must stay non-mutating');
  assert.equal(result.externalProvidersCalled, false, 'contract must not call external providers');
  assert.equal(result.databaseWritesRequired, false, 'contract must not require database writes');
  assert.equal(result.liveSideEffects, false, 'contract must not perform live side effects');
  assert(result.cases.some((item) => item.expectedCategory === 'legal' && item.observedCategory === 'legal'));
  assert(result.cases.some((item) => item.expectedCategory === 'refund_threat' && item.observedCategory === 'refund_threat'));

  console.log(JSON.stringify({
    ok: true,
    name: 'operator-handoff-live-adapter-contract',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    adapterKey: result.adapterKey,
    suite: result.suite,
    fixtureSource: result.fixtureSource,
    summary: {
      total: result.cases.length,
      passed: result.cases.length - failed.length,
      failed: failed.length,
      inProcessOnly: result.inProcessOnly,
      nonMutating: result.nonMutating,
      externalProvidersCalled: result.externalProvidersCalled,
      databaseWritesRequired: result.databaseWritesRequired,
      liveSideEffects: result.liveSideEffects
    },
    cases: result.cases.map((item) => ({
      key: item.key,
      ok: item.ok,
      expectedCategory: item.expectedCategory,
      observedCategory: item.observedCategory,
      expectedSeverity: item.expectedSeverity,
      observedSeverity: item.observedSeverity,
      caseRequired: item.caseRequired
    }))
  }, null, 2));
} catch (err) {
  console.log(JSON.stringify({
    ok: false,
    name: 'operator-handoff-live-adapter-contract',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    error: {
      message: err?.message || String(err),
      stack: err?.stack || null
    }
  }, null, 2));
  process.exitCode = 1;
}
