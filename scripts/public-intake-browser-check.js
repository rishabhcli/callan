#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const dataDir = mkdtempSync(join(tmpdir(), 'callan-public-browser-'));
const screenshotDir = join(repoRoot, 'output', 'playwright');
mkdirSync(screenshotDir, { recursive: true });
const adminToken = 'browser-check-admin-token-2026-callan';
const apiPort = await getFreePort();
const vitePort = await getFreePort();
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
const appBaseUrl = `http://localhost:${vitePort}`;
const env = {
  ...process.env,
  NODE_ENV: 'test', DATA_DIR: dataDir, PORT: String(apiPort), VITE_PORT: String(vitePort), STATIC_DIR: 'dist', RUN_MODE: 'mock',
  ADMIN_API_TOKEN: adminToken,
  LIVE_CALLS: 'false', LIVE_EMAILS: 'false', LIVE_PAYMENTS: 'false', LIVE_BROWSER_SESSIONS: 'false', LIVE_PUBLIC_OUTREACH: 'false', LIVE_BUILDS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false', ACCOUNT_MANAGER_ENABLED: 'false', OPS_BACKUP_ENABLED: 'false', OPS_PROVIDER_POSTURE_ENABLED: 'false', OPS_RECOVERY_ENABLED: 'false',
  SAFE_TO_SELL_SELF_CHECK_ENABLED: 'false', SAFE_TO_RENEW_SELF_CHECK_ENABLED: 'false', GEMINI_API_KEY: '', SUPERMEMORY_API_KEY: '', MOSS_API_KEY: '',
  AGENTPHONE_API_KEY: '', BROWSER_USE_API_KEY: '', LOVABLE_API_KEY: '', AGENTMAIL_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: ''
};

let child;
let browser;
try {
  child = spawn('npm', ['run', 'dev'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForHttp(`${apiBaseUrl}/api/ping`, child, output);
  await waitForHttp(`${appBaseUrl}/`, child, output, false);

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const issues = captureIssues(page);

  await page.goto(`${appBaseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Turn a missed website into a booked customer.' }).waitFor({ state: 'visible' });
  const publicDesktopScreenshot = join(screenshotDir, 'callan-public-landing-desktop.png');
  await page.screenshot({ path: publicDesktopScreenshot, fullPage: false });
  await page.getByRole('link', { name: /Request a website review/ }).click();
  await page.getByRole('heading', { name: 'Put the real business in the queue.' }).waitFor({ state: 'visible' });
  await page.getByRole('textbox', { name: /Business name/ }).fill('Browser Proof Plumbing');
  await page.getByRole('textbox', { name: /What do you do/ }).fill('Plumbing');
  await page.getByRole('textbox', { name: /City or service area/ }).fill('Berkeley, CA');
  await page.getByRole('textbox', { name: /Reply email/ }).fill('owner@browserproof.example');
  await page.getByRole('checkbox', { name: /I confirm this is my business/ }).check();
  await page.getByRole('button', { name: /Create my tracking link/ }).click();
  await page.locator('.public-track-heading').waitFor({ state: 'visible', timeout: 15_000 });
  assert.match(await page.locator('.public-track-heading').innerText(), /Browser Proof Plumbing/);
  const trackingPath = new URL(page.url()).pathname;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.public-track-heading').waitFor({ state: 'visible' });
  assert.equal(new URL(page.url()).pathname, trackingPath, 'tracking URL survives refresh');
  assert.match(await page.locator('.public-track-state').innerText(), /Request received|Operator review/);

  await page.goto(`${appBaseUrl}/app`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Requests' }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: 'Requests' }).click();
  await page.locator('.request-alert').waitFor({ state: 'visible' });
  assert.match(await page.locator('.request-alert').innerText(), /token required|admin/i, 'operator API denies an unauthenticated workspace');
  const authDenialIssues = issues().slice();
  assert(authDenialIssues.length > 0 && authDenialIssues.every((issue) => issue.includes('401 (Unauthorized)')), 'only expected 401s occur before operator authentication');
  await page.evaluate((token) => sessionStorage.setItem('callan.adminToken', token), adminToken);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Requests' }).click();
  await page.locator('.request-workspace').waitFor({ state: 'visible' });
  await page.getByRole('searchbox', { name: 'Search requests' }).fill('Browser Proof');
  const requestRow = page.locator('.request-row').filter({ hasText: 'Browser Proof Plumbing' });
  await requestRow.waitFor({ state: 'visible' });
  await requestRow.click();
  await page.getByRole('button', { name: 'Claim request' }).click();
  await page.getByRole('button', { name: 'Start research' }).click();
  await page.getByText(/researching|ready for review|needs attention/i).last().waitFor({ state: 'visible', timeout: 15_000 });

  await page.locator('.nyna-tools > summary').click();
  await page.getByRole('tab', { name: 'Integrations' }).click();
  await page.locator('.integration-workspace').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Run local verification' }).click();
  await page.getByText(/Local adapter verified|Configuration remains blocked/).waitFor({ state: 'visible' });
  assert.match(await page.locator('.integration-result').innerText(), /external call\s*false/i);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mobileIssues = captureIssues(mobile);
  await mobile.addInitScript((token) => sessionStorage.setItem('callan.adminToken', token), adminToken);
  await mobile.goto(`${appBaseUrl}/`, { waitUntil: 'domcontentloaded' });
  await mobile.getByRole('heading', { name: 'Turn a missed website into a booked customer.' }).waitFor({ state: 'visible' });
  const mobileLayout = await mobile.evaluate(() => ({ bodyWidth: document.body.scrollWidth, viewportWidth: window.innerWidth }));
  assert(mobileLayout.bodyWidth <= mobileLayout.viewportWidth, 'public landing has no horizontal overflow');
  await page.screenshot({ path: join(screenshotDir, 'callan-public-integrations.png'), fullPage: false });
  await mobile.screenshot({ path: join(screenshotDir, 'callan-public-landing-mobile.png'), fullPage: false });
  assert.deepEqual(issues().filter((issue) => !issue.includes('401 (Unauthorized)')), [], 'public/operator browser journey stays clean after authentication');
  assert.deepEqual(mobileIssues().filter((issue) => !issue.includes('401 (Unauthorized)')), [], 'public mobile landing stays clean');

  console.log(JSON.stringify({
    ok: true,
    browserPath: 'playwright_fallback',
    fallbackReason: 'Browser plugin iab backend unavailable',
    journeys: { publicEntry: true, intakeSubmission: true, trackingRefresh: true, authDenial: true, authenticatedQueue: true, queueSearch: true, durableResearchAction: true, integrationVerification: true, mobileLanding: true },
    screenshots: [publicDesktopScreenshot, join(screenshotDir, 'callan-public-integrations.png'), join(screenshotDir, 'callan-public-landing-mobile.png')]
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  rmSync(dataDir, { recursive: true, force: true });
}

function captureIssues(page) {
  const issues = [];
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) issues.push(`${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => issues.push(`pageerror: ${error.message}`));
  return () => issues;
}

async function waitForHttp(url, process, output, expectHtml = false) {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (process.exitCode != null) throw new Error(`dev server exited: ${process.exitCode}\n${output.join('').slice(-2000)}`);
    try {
      const response = await fetch(url);
      if (response.ok && (!expectHtml || String(response.headers.get('content-type')).includes('text/html'))) return;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    server.on('error', reject);
  });
}
