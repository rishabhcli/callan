#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const dataDir = process.env.BROWSER_CONSOLE_CHECK_DATA_DIR || '.data/browser-console-check';

await resetDataDir(dataDir);
forceMockEnv(dataDir);

const { leads, builds } = await import('../server/db.js');
const { emit } = await import('../server/sse.js');

const seeded = seedBrowserUseRows();
await runCommand('npm', ['run', 'build'], { label: 'vite build' });
const api = await verifyApiShape({ dataDir });

console.log(JSON.stringify({
  ok: true,
  dataDir,
  seeded,
  api,
  commandsRun: [
    'npm run build',
    `DATA_DIR=${dataDir} node server/index.js`,
    'GET /api/browser-use/sessions',
    'GET /api/browser-use/events'
  ]
}, null, 2));

function seedBrowserUseRows() {
  const suffix = `${Date.now().toString(36)}_${randomBytes(2).toString('hex')}`;
  const rows = [
    {
      leadId: `lead_browser_active_${suffix}`,
      buildId: `bld_browser_active_${suffix}`,
      sessionId: '11111111-1111-4111-8111-111111111111',
      businessName: 'Mission Creek Plumbing',
      status: 'running',
      statusSummary: 'Reading Yelp reviews and extracting service-area evidence.',
      stepCount: 7,
      totalCostUsd: '0.041',
      evidenceCount: 5,
      mock: true
    },
    {
      leadId: `lead_browser_done_${suffix}`,
      buildId: `bld_browser_done_${suffix}`,
      sessionId: '22222222-2222-4222-8222-222222222222',
      businessName: 'Twin Peaks Auto Glass',
      status: 'completed',
      statusSummary: 'Extracted phone, address, no-owned-site proof, and final Lovable URL.',
      stepCount: 12,
      totalCostUsd: '0.078',
      evidenceCount: 8,
      projectUrl: `https://twin-peaks-auto-${suffix.slice(-4)}.lovable.app`,
      mock: true
    },
    {
      leadId: `lead_browser_auth_${suffix}`,
      buildId: `bld_browser_auth_${suffix}`,
      sessionId: '33333333-3333-4333-8333-333333333333',
      businessName: 'Sunset Dental Lab',
      status: 'blocked_auth',
      statusSummary: 'Lovable requested sign-in before prompt submission.',
      stepCount: 3,
      totalCostUsd: '0.019',
      evidenceCount: 2,
      error: 'lovable_auth_needed',
      mock: true
    }
  ];

  for (const [index, row] of rows.entries()) {
    const inserted = leads.insert({
      id: row.leadId,
      container_tag: `biz_${row.leadId}`,
      business_name: row.businessName,
      phone: `+1415555010${index}`,
      address: '1 Market St, San Francisco, CA',
      niche: 'local services',
      city: 'San Francisco',
      website: row.projectUrl || null,
      status: row.status === 'completed' ? 'shipped' : 'paid',
      research_status: 'complete',
      outreach_status: row.status === 'completed' ? 'shipped' : 'paid',
      risk_status: 'callable',
      consent_status: 'operator_demo',
      phone_classification: 'business',
      source_url: `https://example.test/${row.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    });
    const leadId = inserted.lead.id;
    builds.start({
      id: row.buildId,
      lead_id: leadId,
      browser_session_id: row.sessionId,
      live_url: `https://live.browser-use.com/mock/${row.sessionId}`,
      lovable_url: `https://lovable.dev/?prompt=${encodeURIComponent(`Build ${row.businessName}`)}`,
      brief: `Research and build a better website path for ${row.businessName}.`
    });
    builds.update(row.buildId, {
      status: row.status,
      project_url: row.projectUrl || null,
      error: row.error || null,
      finished_at: row.status === 'running' ? null : Date.now()
    });
    emit('builder.live_url', {
      worker: 'builder',
      leadId,
      buildId: row.buildId,
      sessionId: row.sessionId,
      liveUrl: `https://live.browser-use.com/mock/${row.sessionId}`,
      lovableUrl: `https://lovable.dev/?prompt=${encodeURIComponent(`Build ${row.businessName}`)}`,
      model: 'bu-mini',
      status: row.status,
      stepCount: row.stepCount,
      lastStepSummary: row.statusSummary,
      totalInputTokens: row.stepCount * 1200,
      totalOutputTokens: row.stepCount * 320,
      proxyUsedMb: '1.2',
      llmCostUsd: (Number(row.totalCostUsd) * 0.62).toFixed(4),
      browserCostUsd: (Number(row.totalCostUsd) * 0.32).toFixed(4),
      proxyCostUsd: (Number(row.totalCostUsd) * 0.06).toFixed(4),
      totalCostUsd: row.totalCostUsd,
      maxCostUsd: '0.10',
      screenshotUrl: `https://example.test/screenshots/${row.sessionId}.png`,
      recordingUrls: [`https://example.test/recordings/${row.sessionId}.mp4`],
      agentmailEmail: `agent-${row.sessionId.slice(0, 4)}@agentmail.test`,
      integrationsUsed: ['agentmail'],
      evidenceCount: row.evidenceCount,
      outputSchema: { type: 'object', properties: { evidence: { type: 'array' } } },
      output: { evidence: [`https://example.test/evidence/${row.leadId}`], summary: row.statusSummary },
      mock: row.mock
    });
    emit(row.status === 'blocked_auth' ? 'builder.blocked_auth' : row.status === 'completed' ? 'builder.done' : 'builder.progress', {
      worker: 'builder',
      leadId,
      buildId: row.buildId,
      sessionId: row.sessionId,
      model: 'bu-mini',
      status: row.status,
      summary: row.statusSummary,
      lastStepSummary: row.statusSummary,
      stepCount: row.stepCount,
      totalCostUsd: row.totalCostUsd,
      screenshotUrl: `https://example.test/screenshots/${row.sessionId}.png`,
      projectUrl: row.projectUrl || null,
      error: row.error || null,
      evidenceCount: row.evidenceCount,
      mock: row.mock
    });
  }

  return {
    sessions: rows.map((row) => row.sessionId),
    buildIds: rows.map((row) => row.buildId)
  };
}

async function verifyApiShape({ dataDir }) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs = [];
  child.stdout.on('data', (buf) => logs.push(buf.toString()));
  child.stderr.on('data', (buf) => logs.push(buf.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child);
    const [sessions, events, html] = await Promise.all([
      fetchJson(`${baseUrl}/api/browser-use/sessions?hydrate=false`),
      fetchJson(`${baseUrl}/api/browser-use/events?limit=40`),
      fetchText(`${baseUrl}/`)
    ]);
    assert(sessions.ok === true, 'sessions ok');
    assert(Array.isArray(sessions.sessions), 'sessions array');
    assert(sessions.sessions.length >= 3, 'seeded sessions visible');
    assert(sessions.counts.active >= 1, 'active count');
    assert(sessions.counts.completed >= 1, 'completed count');
    assert(sessions.counts.auth_wall >= 1, 'auth wall count');
    assert(Number(sessions.telemetry.stepCount) >= 20, 'step telemetry');
    assert(Number(sessions.telemetry.evidenceCount) >= 10, 'evidence telemetry');

    const active = sessions.sessions.find((session) => session.statusGroup === 'active');
    assert(active.sessionId, 'session id');
    assert(active.model, 'model');
    assert(active.liveUrl, 'liveUrl');
    assert(active.stepCount > 0, 'stepCount');
    assert(active.lastStepSummary, 'lastStepSummary');
    assert(active.screenshotUrl, 'screenshotUrl');
    assert(active.totalCostUsd, 'totalCostUsd');
    assert(active.evidenceCount > 0, 'evidenceCount');
    assert(Array.isArray(active.events), 'session events');

    assert(events.ok === true, 'events ok');
    assert(events.events.some((event) => event.type === 'builder.live_url'), 'live event surfaced');
    assert(events.events.some((event) => event.evidenceCount > 0), 'event evidence surfaced');
    assert(html.includes('id="root"') || html.includes('callmemaybe'), 'html served');

    return {
      baseUrl,
      sessionCount: sessions.sessions.length,
      counts: sessions.counts,
      telemetry: sessions.telemetry,
      eventCount: events.events.length
    };
  } finally {
    await stopChild(child);
  }
}

async function resetDataDir(target) {
  if (existsSync(target)) await rm(target, { recursive: true, force: true });
}

function forceMockEnv(target) {
  process.env.DATA_DIR = target;
  process.env.RUN_MODE = 'mock';
  process.env.LIVE_CALLS = 'false';
  process.env.LIVE_EMAILS = 'false';
  process.env.LIVE_PAYMENTS = 'false';
  process.env.LIVE_BUILDS = 'false';
  process.env.AUTONOMOUS_OUTREACH_ENABLED = 'false';
  process.env.BROWSER_USE_API_KEY = '';
  process.env.SMOKE_BROWSER_USE = 'false';
}

async function runCommand(cmd, args, { label }) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (buf) => { output += buf.toString(); });
    child.stderr.on('data', (buf) => { output += buf.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`${label} failed with exit ${code}\n${output.split('\n').slice(-30).join('\n')}`));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < 10000) {
    if (child.exitCode != null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const health = await fetchJson(`${baseUrl}/api/health`);
      if (health.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`server did not become healthy: ${lastErr?.message || 'timeout'}\n${child.spawnfile}`);
}

async function stopChild(child) {
  if (child.exitCode != null || child.killed) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    sleep(1500).then(() => false)
  ]);
  if (!exited && child.exitCode == null) child.kill('SIGKILL');
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${url} ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function getFreePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePromise(port));
    });
    server.on('error', reject);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`browser console check failed: ${message}`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
