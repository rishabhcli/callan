#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const dataDir = mkdtempSync(join(tmpdir(), 'callan-public-intake-retry-'));
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const adminToken = 'public-intake-retry-check-admin-token-0123456789';
const env = {
  ...process.env,
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  PORT: String(port),
  STATIC_DIR: 'dist',
  RUN_MODE: 'production_review',
  ADMIN_API_TOKEN: adminToken,
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
      businessName: 'Retry Review Plumbing',
      niche: 'plumber',
      city: 'Oakland, CA',
      consent: true
    })
  });
  assert.equal(submission.status, 201);

  const token = submission.body.trackingToken;
  const requests = await fetchJson(`${baseUrl}/api/intake/requests`, { headers: authHeaders() });
  assert.equal(requests.status, 200);
  const request = requests.body.requests.find((row) => row.business_name === 'Retry Review Plumbing');
  assert(request?.id);

  const action = await fetchJson(`${baseUrl}/api/intake/requests/${request.id}/actions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start_research' })
  });
  assert.equal(action.status, 202);

  const retrying = await waitFor(async () => {
    const status = await fetchJson(`${baseUrl}/api/public/intake/${token}`);
    return status.body?.request?.status === 'researching'
      && status.body.events?.some((event) => event.eventType === 'research_retry_scheduled')
      ? status
      : null;
  }, child, output, 10_000);
  assert.equal(retrying.body.request.researchJobQueued, true);
  assert.equal(retrying.body.request.finalMessage, 'Research is retrying after a temporary issue. An operator can monitor this request.');
  assert(!retrying.body.events.some((event) => event.eventType === 'research_failed'), 'transient retry must not be exposed as terminal failure');

  console.log(JSON.stringify({
    ok: true,
    checks: {
      reviewModeProviderFailure: true,
      transientFailureKeepsResearching: true,
      retryEventVisible: true,
      terminalFailureNotReportedEarly: true
    },
    status: retrying.body.request.status
  }, null, 2));
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
}

function authHeaders() {
  return { authorization: `Bearer ${adminToken}` };
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
  throw new Error(`timed out waiting for retry state: ${lastError?.message || 'no result'}`);
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
