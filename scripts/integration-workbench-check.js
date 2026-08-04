#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-integration-workbench-'));
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  NODE_ENV: 'test', DATA_DIR: dataDir, PORT: String(port), STATIC_DIR: 'dist', RUN_MODE: 'mock',
  LIVE_CALLS: 'false', LIVE_EMAILS: 'false', LIVE_PAYMENTS: 'false', LIVE_BROWSER_SESSIONS: 'false',
  LIVE_PUBLIC_OUTREACH: 'false', LIVE_BUILDS: 'false', AUTONOMOUS_OUTREACH_ENABLED: 'false',
  ACCOUNT_MANAGER_ENABLED: 'false', OPS_BACKUP_ENABLED: 'false', OPS_PROVIDER_POSTURE_ENABLED: 'false',
  OPS_RECOVERY_ENABLED: 'false', SAFE_TO_SELL_SELF_CHECK_ENABLED: 'false', SAFE_TO_RENEW_SELF_CHECK_ENABLED: 'false',
  GEMINI_API_KEY: '', SUPERMEMORY_API_KEY: '', MOSS_API_KEY: '', AGENTPHONE_API_KEY: '',
  BROWSER_USE_API_KEY: '', LOVABLE_API_KEY: '', AGENTMAIL_API_KEY: '', STRIPE_SECRET_KEY: ''
};

let child;
try {
  child = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitFor(() => fetchJson(`${baseUrl}/api/ping`), child, output);

  const registry = await fetchJson(`${baseUrl}/api/integrations`);
  assert.equal(registry.status, 200);
  assert.deepEqual(Object.keys(registry.body.providers), ['gemini', 'supermemory', 'moss', 'agentphone', 'browserUse', 'lovable', 'v0', 'agentmail', 'stripe']);

  const first = await fetchJson(`${baseUrl}/api/integrations/gemini/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'workbench-gemini-1' })
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.receipt.status, 'blocked_configuration');
  assert.equal(first.body.receipt.response.externalCall, false);
  assert.equal(first.body.receipt.response.sideEffects, false);
  assert(first.body.receipt.response.missing.includes('GEMINI_API_KEY'));
  assert(!JSON.stringify(first.body).match(/AIza|sk-[A-Za-z0-9]/), 'provider secrets never appear in a receipt');

  const replay = await fetchJson(`${baseUrl}/api/integrations/gemini/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'workbench-gemini-1' })
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.reused, true);
  assert.equal(replay.body.receipt.id, first.body.receipt.id);

  const history = await fetchJson(`${baseUrl}/api/integrations/gemini/history`);
  assert.equal(history.status, 200);
  assert.equal(history.body.receipts.length, 1);
  const unsupported = await fetchJson(`${baseUrl}/api/integrations/not-a-provider/verify`, { method: 'POST', body: '{}' });
  assert.equal(unsupported.status, 404);

  console.log(JSON.stringify({ ok: true, checks: { registry: true, localBlockedReceipt: true, secretRedaction: true, idempotencyReplay: true, history: true, unsupportedProvider: true } }, null, 2));
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
  while (Date.now() - started < timeoutMs) {
    if (process.exitCode != null) throw new Error(`server exited: ${process.exitCode}\n${output.join('').slice(-2000)}`);
    try {
      const value = await check();
      if (value?.body?.ok) return value;
    } catch { /* server is still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for integration workbench server');
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
