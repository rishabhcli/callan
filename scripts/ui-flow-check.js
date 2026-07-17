#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const dataDir = mkdtempSync(join(tmpdir(), 'callan-ui-flow-'));
const frontendDir = mkdtempSync(join(tmpdir(), 'callan-ui-flow-dist-'));
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const screenshotDir = process.env.UI_FLOW_SCREENSHOT_DIR || '';
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

let devChild = null;
let browser = null;

try {
  const demo = await seedDemoLifecycle();
  const apiPort = await getFreePort();
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const appUrl = `${apiBaseUrl}/`;
  const env = mockEnv({ apiPort });

  await runCapture(npxCommand, ['vite', 'build', '--outDir', frontendDir, '--emptyOutDir'], { env });

  devChild = spawn(process.execPath, ['server/index.js'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const devOutput = [];
  devChild.stdout.on('data', (chunk) => devOutput.push(chunk.toString()));
  devChild.stderr.on('data', (chunk) => devOutput.push(chunk.toString()));

  await waitForHttp(`${apiBaseUrl}/api/ping`, devChild, devOutput);
  await waitForHttp(appUrl, devChild, devOutput, { expectJson: false });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const desktopIssues = captureBrowserIssues(desktop);
  await desktop.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await desktop.locator('.loop-view').waitFor({ state: 'visible' });
  await desktop.getByText('An agency that corrects its own work.').waitFor({ state: 'visible' });
  await openTab(desktop, 'Operations', '.nyna-stage');
  await desktop.locator('.prod-command-center').waitFor({ state: 'visible' });
  await desktop.waitForTimeout(1_500);

  const compactBox = await desktop.locator('.prod-command-center').boundingBox();
  assert(compactBox && compactBox.height < 260, 'production command center starts compact');
  await desktop.getByRole('button', { name: 'details' }).click();
  const expandedBox = await desktop.locator('.prod-command-center').boundingBox();
  assert(expandedBox && expandedBox.height > compactBox.height, 'production details expand on demand');
  await desktop.getByRole('button', { name: 'collapse' }).click();
  if (screenshotDir) await desktop.screenshot({ path: join(screenshotDir, 'operations-desktop.png'), fullPage: false });

  await desktop.getByRole('button', { name: /supermemory/i }).dispatchEvent('click');
  await desktop.locator('.nyna-detail-overlay').waitFor({ state: 'visible' });
  await desktop.locator('.nyna-detail-close').click();

  const leadSearch = desktop.getByRole('searchbox', { name: 'Search leads' });
  await leadSearch.fill('Luna Ridge');
  await desktop.getByText('Luna Ridge HVAC').last().waitFor({ state: 'visible' });
  await leadSearch.fill('no-match-ui-flow');
  await desktop.getByText('No leads match this search.').waitFor({ state: 'visible' });
  await leadSearch.fill('');

  await openTab(desktop, 'Portfolio', '.portfolio-view');
  await openTab(desktop, 'Agents', '.nyna-agents-shell');
  await openTab(desktop, 'Scraper', '.nyna-scraper-shell');
  const previewFrame = desktop.locator('.nyna-scraper-card-frame iframe').first();
  await previewFrame.waitFor({ state: 'visible' });
  const previewText = await previewFrame.contentFrame().locator('body').innerText();
  assert.match(previewText, /Luna Ridge HVAC/i, 'mock build preview renders inside Scraper');
  await openTab(desktop, 'Memory', '.nyna-memory-shell');
  await openTab(desktop, 'Settings', '.nyna-settings-shell');
  await openTab(desktop, 'Operations', '.nyna-stage');

  await desktop.getByRole('tab', { name: 'Operations' }).focus();
  await desktop.keyboard.press('ArrowRight');
  await desktop.locator('.portfolio-view').waitFor({ state: 'visible' });
  assert.equal(
    await desktop.getByRole('tab', { name: 'Portfolio' }).getAttribute('aria-selected'),
    'true',
    'tab list supports arrow-key navigation'
  );

  const portal = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const portalIssues = captureBrowserIssues(portal);
  await portal.goto(`${appUrl.replace(/\/$/, '')}${demo.portalPath}`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000
  });
  await portal.getByText('Luna Ridge HVAC').first().waitFor({ state: 'visible' });
  const portalFrame = portal.locator('.nyna-share-frame iframe');
  await portalFrame.waitFor({ state: 'visible' });
  const portalPreviewText = await portalFrame.contentFrame().locator('body').innerText();
  assert.match(portalPreviewText, /Luna Ridge HVAC/i, 'customer portal embeds the generated preview');
  if (screenshotDir) await portal.screenshot({ path: join(screenshotDir, 'customer-portal.png'), fullPage: false });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mobileIssues = captureBrowserIssues(mobile);
  await mobile.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await mobile.locator('.loop-view').waitFor({ state: 'visible' });
  await openTab(mobile, 'Operations', '.nyna-stage');
  await mobile.locator('.prod-command-center').waitFor({ state: 'visible' });
  await mobile.waitForTimeout(1_000);
  const mobileLayout = await mobile.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: window.innerWidth,
    sideHeight: document.querySelector('.nyna-side')?.getBoundingClientRect().height || 0,
    commandHeight: document.querySelector('.prod-command-center')?.getBoundingClientRect().height || 0
  }));
  assert(mobileLayout.bodyWidth <= mobileLayout.viewportWidth, 'mobile shell has no horizontal overflow');
  assert(mobileLayout.sideHeight < 180, 'mobile operator controls stay compact');
  assert(mobileLayout.commandHeight < 230, 'mobile readiness summary stays compact');
  if (screenshotDir) await mobile.screenshot({ path: join(screenshotDir, 'operations-mobile.png'), fullPage: false });
  await openTab(mobile, 'Settings', '.nyna-settings-shell');

  assert.deepEqual(desktopIssues(), [], 'desktop console stays clean');
  assert.deepEqual(portalIssues(), [], 'customer portal console stays clean');
  assert.deepEqual(mobileIssues(), [], 'mobile console stays clean');

  console.log(JSON.stringify({
    ok: true,
    browserPath: 'playwright-production-artifact',
    demoLeadId: demo.leadId,
    flows: {
      loopFirstProductNarrative: true,
      compactReadinessSummary: true,
      expandableProductionDetails: true,
      agentDetailNavigation: true,
      leadSearch: true,
      keyboardTabNavigation: true,
      portfolio: true,
      agents: true,
      scraperEmbeddedPreview: true,
      memory: true,
      settings: true,
      customerPortalPreview: true,
      responsiveMobileShell: true
    },
    consoleIssues: [],
    screenshots: screenshotDir || null
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (devChild) await stopChild(devChild);
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(frontendDir, { recursive: true, force: true });
}

async function seedDemoLifecycle() {
  const output = await runCapture(process.execPath, [
    'scripts/demo-e2e.js',
    '--data-dir',
    dataDir,
    '--reset-demo-data',
    '--no-build',
    '--no-verify-ui'
  ], { env: mockEnv({}) });
  const marker = '\n{\n  "ok": true,';
  const markerIndex = output.lastIndexOf(marker);
  const jsonStart = markerIndex >= 0 ? markerIndex + 1 : output.startsWith('{\n  "ok": true,') ? 0 : -1;
  assert(jsonStart >= 0, `demo summary not found\n${output.slice(-2_000)}`);
  const summary = JSON.parse(output.slice(jsonStart).trim());
  assert.equal(summary.ok, true);
  assert(summary.portalPath);
  return summary;
}

function mockEnv({ apiPort } = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    RUN_MODE: 'mock',
    ...(apiPort ? { PORT: String(apiPort) } : {}),
    STATIC_DIR: frontendDir,
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
}

async function openTab(page, name, selector) {
  let tab = page.getByRole('tab', { name });
  if (await tab.count() === 0) {
    await page.locator('.nyna-tools > summary').click();
    tab = page.getByRole('tab', { name });
  }
  await tab.click();
  await page.locator(selector).waitFor({ state: 'visible', timeout: 30_000 });
  assert.equal(await page.locator(`#tab-${name.toLowerCase()}`).getAttribute('aria-selected'), 'true');
}

function captureBrowserIssues(page) {
  const issues = [];
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return;
    const text = message.text();
    if (text.includes('GL Driver Message')) return;
    issues.push(`${message.type()}: ${text}`);
  });
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`));
  return () => issues;
}

function runCapture(command, args, { env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal || code})\n${output}`));
    });
  });
}

async function waitForHttp(url, child, output, { expectJson = true } = {}) {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev server exited before readiness\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) {
        if (!expectJson) return;
        const body = await response.json();
        if (body.ok) return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message || 'unavailable'}\n${output.join('')}`);
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

async function stopChild(child) {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 3_000))
  ]);
  if (!exited && child.exitCode === null) child.kill('SIGKILL');
}
