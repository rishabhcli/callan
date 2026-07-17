#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const demoDataDir = mkdtempSync(join(tmpdir(), 'callan-deploy-demo-'));
const smokeDataDir = mkdtempSync(join(tmpdir(), 'callan-deploy-smoke-'));

try {
  await run(npmCommand, ['run', 'check:core']);
  await run(npmCommand, ['run', 'check:portfolio-readiness-browser']);
  await run(npmCommand, ['run', 'check:ui-flows']);
  await run(npmCommand, ['run', 'demo:e2e', '--', '--data-dir', demoDataDir, '--reset-demo-data']);
  await run(npmCommand, ['audit', '--omit=dev', '--audit-level=high']);
  const smoke = await productionArtifactSmoke();
  console.log(JSON.stringify({
    ok: true,
    checkedAt: new Date().toISOString(),
    checks: [
      'core deterministic suites',
      'desktop and mobile browser readiness',
      'desktop, mobile, tab, embedded-preview, and customer-portal UI flows',
      'full mock lead-to-launch lifecycle',
      'production dependency audit',
      'production-mode HTTP and graceful-shutdown smoke'
    ],
    smoke
  }, null, 2));
} finally {
  rmSync(demoDataDir, { recursive: true, force: true });
  rmSync(smokeDataDir, { recursive: true, force: true });
}

async function productionArtifactSmoke() {
  const port = await getFreePort();
  const token = 'deploy-check-admin-token-0123456789';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATA_DIR: smokeDataDir,
      RUN_MODE: 'mock',
      ADMIN_API_TOKEN: token,
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
      SAFE_TO_RENEW_SELF_CHECK_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  try {
    const ping = await waitForJson(`http://127.0.0.1:${port}/api/ping`, {}, child, output);
    assert.equal(ping.response.status, 200);
    assert.equal(ping.body.ok, true);
    assert.equal(ping.response.headers.has('x-powered-by'), false);
    assert.match(ping.response.headers.get('content-security-policy') || '', /script-src 'self' 'nonce-/);
    assert.equal(ping.response.headers.get('x-content-type-options'), 'nosniff');

    const health = await fetchJson(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(health.response.status, 200);
    assert.equal(health.body.mode, 'mock');

    const unauthorized = await fetchJson(`http://127.0.0.1:${port}/api/health`);
    assert.equal(unauthorized.response.status, 401);
    assert.equal(unauthorized.body.code, 'ADMIN_AUTH_REQUIRED');

    const referral = await fetchJson(`http://127.0.0.1:${port}/api/referrals/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ niche: 'plumber', city: 'Oakland, CA' })
    });
    assert.equal(referral.response.status, 202);
    assert.equal(referral.body.source, 'referral_landing');

    const missing = await fetchJson(`http://127.0.0.1:${port}/api/not-a-route`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.code, 'API_NOT_FOUND');
  } finally {
    child.kill('SIGTERM');
  }

  const exit = await waitForExit(child, 15_000);
  assert.equal(exit.code, 0, output.join(''));
  return { port, gracefulExit: true, securityHeaders: true, protectedHealth: true, publicReferralIntake: true };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: process.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal || code})`));
    });
  });
}

async function waitForJson(url, options, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited before readiness\n${output.join('')}`);
    try {
      return await fetchJson(url, options);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`timed out waiting for ${url}\n${output.join('')}`);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { response, body };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('server did not exit within graceful shutdown window'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
