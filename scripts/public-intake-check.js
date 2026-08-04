#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const dataDir = mkdtempSync(join(tmpdir(), 'callan-public-intake-'));
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  PORT: String(port),
  STATIC_DIR: 'dist',
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BROWSER_SESSIONS: 'false',
  LIVE_PUBLIC_OUTREACH: 'false',
  LIVE_BUILDS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false',
  ACCOUNT_MANAGER_ENABLED: 'false',
  OPS_BACKUP_ENABLED: 'false',
  OPS_PROVIDER_POSTURE_ENABLED: 'false',
  OPS_RECOVERY_ENABLED: 'false',
  SAFE_TO_SELL_SELF_CHECK_ENABLED: 'false',
  SAFE_TO_RENEW_SELF_CHECK_ENABLED: 'false',
  BROWSER_USE_API_KEY: '',
  AGENTMAIL_API_KEY: '',
  AGENTPHONE_API_KEY: '',
  GEMINI_API_KEY: '',
  LOVABLE_API_KEY: '',
  MOSS_API_KEY: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  SUPERMEMORY_API_KEY: ''
};

let child;
try {
  child = spawn(process.execPath, ['server/index.js'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitFor(() => fetchJson(`${baseUrl}/api/ping`), child, output);

  const submission = await fetchJson(`${baseUrl}/api/public/intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      businessName: 'Northwind Heating',
      niche: 'HVAC repair',
      city: 'Oakland, CA',
      website: 'https://northwind.example',
      phone: '5105550142',
      email: 'owner@northwind.example',
      notes: 'Needs an emergency booking path.',
      consent: true
    })
  });
  assert.equal(submission.status, 201);
  assert.match(submission.body.trackingToken, /^trk_[A-Za-z0-9_-]{32,}$/);
  assert.equal(submission.body.request.status, 'received');
  assert(!submission.body.leadId, 'public response does not expose a lead id');

  const token = submission.body.trackingToken;
  const duplicateSubmission = await fetchJson(`${baseUrl}/api/public/intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      businessName: 'Northwind Heating',
      niche: 'HVAC repair',
      city: 'Oakland, CA',
      website: 'https://northwind.example',
      phone: '5105550142',
      email: 'second@northwind.example',
      consent: true
    })
  });
  assert.equal(duplicateSubmission.status, 201);

  const firstStatus = await fetchJson(`${baseUrl}/api/public/intake/${token}`);
  assert.equal(firstStatus.body.request.businessName, 'Northwind Heating');
  assert.equal(firstStatus.body.request.status, 'received');
  assert.equal(firstStatus.body.request.researchJobQueued, false);
  assert.equal(firstStatus.body.events.length, 1);
  const refreshedStatus = await fetchJson(`${baseUrl}/api/public/intake/${token}`);
  assert.deepEqual(refreshedStatus.body.request, firstStatus.body.request, 'tracking survives refresh');

  const invalid = await fetchJson(`${baseUrl}/api/public/intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ businessName: 'x', niche: '', city: '', consent: false })
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'PUBLIC_INTAKE_INVALID');
  const missingToken = await fetchJson(`${baseUrl}/api/public/intake/trk_invalid-token`);
  assert.equal(missingToken.status, 404);

  const list = await fetchJson(`${baseUrl}/api/intake/requests?q=Northwind`);
  assert.equal(list.status, 200);
  assert.equal(list.body.requests.length, 2);
  assert.notEqual(list.body.requests[0].lead_id, list.body.requests[1].lead_id, 'public submissions keep separate non-callable leads');
  assert(!JSON.stringify(list.body).match(/sk_live_|AIza[A-Za-z0-9]/), 'operator request list does not expose secret-like values');
  const requestId = list.body.requests.at(-1).id;
  assert(list.body.requests[0].tracking_token_hash);
  assert(!JSON.stringify(list.body).includes(token), 'operator list does not echo the raw tracking token');

  const claim = await fetchJson(`${baseUrl}/api/intake/requests/${requestId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'claim' })
  });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.request.status, 'claimed');

  const research = await fetchJson(`${baseUrl}/api/intake/requests/${requestId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start_research' })
  });
  assert.equal(research.status, 202);
  assert(research.body.jobId);
  assert.equal(research.body.request.research_job_id, research.body.jobId, 'queued research job id is persisted before the worker can finish');
  const stagedHistory = await fetchJson(`${baseUrl}/api/intake/requests/${requestId}/events`);
  assert(stagedHistory.body.events.some((event) => event.eventType === 'research_job_recorded'));
  const finished = await waitFor(async () => {
    const result = await fetchJson(`${baseUrl}/api/public/intake/${token}`);
    return ['ready_for_review', 'failed'].includes(result.body.request.status) ? result : null;
  }, child, output, 20_000);
  assert(['ready_for_review', 'failed'].includes(finished.body.request.status));
  assert.equal(finished.body.request.researchJobQueued, false, 'completed research is not reported as queued');
  assert(finished.body.events.some((event) => event.eventType === 'research_started'));

  const rerunResearch = await fetchJson(`${baseUrl}/api/intake/requests/${requestId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start_research' })
  });
  assert.equal(rerunResearch.status, 202);
  assert(rerunResearch.body.jobId);
  assert.notEqual(rerunResearch.body.jobId, research.body.jobId, 'completed research can be retried with a fresh durable job');
  const rerunFinished = await waitFor(async () => {
    const result = await fetchJson(`${baseUrl}/api/public/intake/${token}`);
    return ['ready_for_review', 'failed'].includes(result.body.request.status) ? result : null;
  }, child, output, 20_000);
  assert(['ready_for_review', 'failed'].includes(rerunFinished.body.request.status));
  assert.equal(rerunFinished.body.request.researchJobQueued, false, 'retried research is not reported as queued after completion');
  assert(rerunFinished.body.events.filter((event) => event.eventType === 'research_started').length >= 2);

  console.log(JSON.stringify({
    ok: true,
    workflow: {
      publicSubmission: true,
      publicSubmissionIsolation: true,
      scopedTracking: true,
      refreshPersistence: true,
      invalidInput: true,
      operatorClaim: true,
      durableResearchHandoff: true,
      researchStateStaged: true,
      durableResearchRetry: true,
      finalStatus: finished.body.request.status
    }
  }, null, 2));
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

async function waitFor(check, process, output, timeoutMs = 10_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (process.exitCode != null) throw new Error(`server exited: ${process.exitCode}\n${output.join('').slice(-2000)}`);
    try {
      const value = await check();
      if (value?.body?.ok || value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for public intake check: ${lastError?.message || 'no result'}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
    server.on('error', reject);
  });
}
