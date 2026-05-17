// Deterministic Browser Use research swarm verification.
// Runs mock mode through the same job/session/evidence persistence path as live mode.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-browser-research-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  BROWSER_USE_API_KEY: '',
  BROWSER_USE_LIVE_RESEARCH: 'false',
  LIVE_BROWSER_RESEARCH: 'false',
  LIVE_RESEARCH: 'false'
});

try {
  const {
    createBrowserUseResearchJob,
    getBrowserResearchStatus,
    runBrowserUseResearchJob
  } = await import('../server/research/browserUseSwarm.js');
  const { events } = await import('../server/db.js');

  const job = createBrowserUseResearchJob({
    city: 'San Francisco, CA',
    niche: 'barber',
    maxLeads: 4,
    concurrency: 5,
    maxCostUsd: 0.07,
    mode: 'mock'
  });

  await runBrowserUseResearchJob({ jobId: job.id });
  const status = getBrowserResearchStatus({ jobId: job.id });
  const eventRows = events.list({ since: 0, limit: 500 });
  const eventTypes = eventRows.map((row) => row.type);

  assert.equal(status.job.status, 'completed');
  assert.equal(status.sessions.length, 5, 'expected one mock session per source type');
  assert.ok(status.sessions.every((session) => session.normalizedStatus === 'completed'), 'all sessions should complete');
  assert.ok(status.sessions.every((session) => session.model), 'model policy should choose a model for every session');
  assert.ok(status.sessions.some((session) => session.model === 'bu-max'), 'ambiguous website lane should use a stronger Browser Use model');
  assert.ok(status.sessions.some((session) => session.model === 'bu-mini'), 'cheap extraction lanes should use bu-mini');

  const starts = status.sessions.map((session) => session.startedAt);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 1000, 'mock sessions should be launched in parallel');
  assert.ok(status.evidence.length >= 10, 'mock research should persist evidence from all source lanes');
  assert.equal(status.summary.acceptedCount, 4, 'maxLeads should cap accepted leads');
  assert.ok(status.summary.skippedCount > 0, 'overflow and strong leads should be visible as skipped evidence');
  assert.ok(status.summary.strongSkippedCount >= 1, 'strong presence should be skipped but visible');

  const strong = status.evidence.find((row) => row.presenceStrength === 'strong');
  assert.ok(strong, 'strong lead evidence row missing');
  assert.equal(strong.skipped, true);
  assert.equal(strong.skippedReason, 'strong_presence_visible_skip');

  assert.ok(eventTypes.includes('research.session.started'), 'session start event missing');
  assert.ok(eventTypes.includes('research.session.completed'), 'session completion event missing');
  assert.ok(eventTypes.includes('research.evidence.captured'), 'evidence captured event missing');
  assert.ok(eventTypes.includes('research.evidence.skipped'), 'evidence skipped event missing');

  console.log('[PASS] Browser Use research swarm mock check completed.');
  console.log(JSON.stringify({
    jobId: status.job.id,
    sessions: status.sessions.length,
    evidence: status.evidence.length,
    accepted: status.summary.acceptedCount,
    skipped: status.summary.skippedCount,
    strongSkipped: status.summary.strongSkippedCount,
    models: [...new Set(status.sessions.map((session) => session.model))]
  }, null, 2));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
