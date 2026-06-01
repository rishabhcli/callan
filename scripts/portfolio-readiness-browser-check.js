#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const dataDir = mkdtempSync(join(tmpdir(), 'callan-portfolio-readiness-browser-'));
const screenshotBase = join(tmpdir(), 'callan-portfolio-readiness-command');
const desktopScreenshot = `${screenshotBase}-desktop.png`;
const receiptScreenshot = `${screenshotBase}-receipt.png`;
const adapterBlockedScreenshot = `${screenshotBase}-adapter-blocked.png`;
const adapterVerifiedScreenshot = `${screenshotBase}-adapter-verified.png`;
const adapterEvidenceScreenshot = `${screenshotBase}-adapter-evidence.png`;
const mobileScreenshot = `${screenshotBase}-mobile.png`;

forceMockEnv(dataDir);

const { db, portfolioOperatingModel } = await import('../server/db.js');

let devChild = null;
let browser = null;

try {
  const seeded = seedReadinessCommandCenter();
  const port = await getFreePort();
  const vitePort = await getFreePort();
  const apiBaseUrl = `http://127.0.0.1:${port}`;
  const appUrl = `http://localhost:${vitePort}/`;

  devChild = spawn('npm', ['run', 'dev'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      VITE_PORT: String(vitePort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const devOutput = [];
  devChild.stdout.on('data', (buf) => devOutput.push(buf.toString()));
  devChild.stderr.on('data', (buf) => devOutput.push(buf.toString()));

  await waitForHealth(apiBaseUrl, devChild, devOutput);
  await waitForVite(appUrl, devChild, devOutput);

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const consoleIssues = captureConsoleIssues(desktop);

  await desktop.goto(appUrl, { waitUntil: 'domcontentloaded' });
  const desktopTitle = await desktop.title();
  assert(desktopTitle.includes('Callan'));
  assert(desktopTitle.includes('agency console'));
  await desktop.getByRole('tab', { name: 'Portfolio' }).click();
  const commandCenter = desktop.locator('section[aria-label="board decision command center"]');
  await commandCenter.getByRole('heading', { name: 'Decision Command Center' }).waitFor({ state: 'visible', timeout: 10000 });
  await commandCenter.getByText('Mesa Readiness Browser Proof').waitFor({ state: 'visible', timeout: 10000 });
  await commandCenter.getByText('2 pending local review').waitFor({ state: 'visible', timeout: 10000 });
  await commandCenter.getByText('live proof still required').waitFor({ state: 'visible', timeout: 10000 });
  const commandText = await commandCenter.textContent();
  assert(commandText.includes('provider live smoke'));
  assert(commandText.includes('live adapter implemented'));
  const actionResult = desktop.locator('.portfolio-action-result');
  const staleQueueLane = commandCenter.getByRole('button', { name: 'Stale' });
  assert.equal(await staleQueueLane.count(), 1);
  await staleQueueLane.click();
  const exportBlockerQueue = commandCenter.getByRole('button', { name: 'Export stale blockers' });
  assert.equal(await exportBlockerQueue.count(), 1);
  await exportBlockerQueue.click();
  await actionResult.getByText('export live release blocker queue').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText(/Stale blockers:/).waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText(/sha256 [a-f0-9]{12}/).waitFor({ state: 'visible', timeout: 10000 });
  await commandCenter.getByText(/Current export has no acknowledgement · sha256 [a-f0-9]{12}/).waitFor({ state: 'visible', timeout: 10000 });
  const acknowledgeChecksum = commandCenter.getByRole('button', { name: 'Acknowledge checksum' });
  assert.equal(await acknowledgeChecksum.count(), 1);
  await acknowledgeChecksum.click();
  await actionResult.getByText('acknowledge live release blocker queue export review').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('reviewed redacted queue export').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('live execution still blocked').waitFor({ state: 'visible', timeout: 10000 });
  await commandCenter.getByText(/Current export matches latest acknowledgement · sha256 [a-f0-9]{12}/).waitFor({ state: 'visible', timeout: 10000 });
  await commandCenter.getByText(/Stale blockers · sha256 [a-f0-9]{12}/).waitFor({ state: 'visible', timeout: 10000 });
  const acknowledgedChecksum = commandCenter.getByRole('button', { name: 'Checksum acknowledged' });
  await acknowledgedChecksum.waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await acknowledgedChecksum.isDisabled(), true);
  await commandCenter.scrollIntoViewIfNeeded();
  await desktop.screenshot({ path: desktopScreenshot, fullPage: false });

  await commandCenter.getByLabel('provider smoke passed').check();
  await commandCenter.getByLabel('smoke operator verified').check();
  await commandCenter.getByLabel('provider smoke provider').fill('agentmail');
  await commandCenter.getByLabel('provider live flags').fill('LIVE_EMAILS');
  const recordSmokeReceipt = commandCenter.getByRole('button', { name: 'Record smoke receipt' });
  assert.equal(await recordSmokeReceipt.count(), 1);
  await recordSmokeReceipt.click();
  await actionResult.getByText('Record Provider Smoke Receipt').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('Recorded local provider-smoke proof packet').waitFor({ state: 'visible', timeout: 10000 });

  const attachSmoke = commandCenter.getByRole('button', { name: 'Attach smoke packet' });
  assert.equal(await attachSmoke.count(), 1);
  await attachSmoke.click();
  await actionResult.getByText('Verified Live Evidence').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('Provider Live Smoke Receipt').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('live gate cleared').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('local review cannot clear live gate').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.scrollIntoViewIfNeeded();
  await desktop.screenshot({ path: receiptScreenshot, fullPage: false });

  const runContractTests = commandCenter.getByRole('button', { name: 'Run contract tests' });
  assert.equal(await runContractTests.count(), 1);
  await runContractTests.click();
  await actionResult.getByText('Run Adapter Contract Tests').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('Recorded local adapter contract tests').waitFor({ state: 'visible', timeout: 10000 });

  const verifyAdapterPacket = commandCenter.getByRole('button', { name: 'Verify adapter packet' });
  assert.equal(await verifyAdapterPacket.count(), 1);
  await verifyAdapterPacket.click();
  await actionResult.getByText('Verify Adapter Implementation').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('Blocked local adapter implementation verification').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.scrollIntoViewIfNeeded();
  await desktop.screenshot({ path: adapterBlockedScreenshot, fullPage: false });
  const blockedApiSnapshot = await fetchJson(`${apiBaseUrl}/api/portfolio/operating-model?workspaceId=${encodeURIComponent(seeded.workspaceId)}&limit=20`);
  const blockedCommand = blockedApiSnapshot.readinessCommandCenter.find((item) => item.id === seeded.reconciliationId);
  assert(blockedCommand, 'blocked adapter command center row is visible over HTTP');
  assert.equal(blockedCommand.adapterLedger.latestStatus, 'implementation_verification_blocked');
  assert.equal(blockedCommand.adapterLedger.verifiedImplemented, false);

  await commandCenter.getByLabel('implementation packet reviewed').check();
  await commandCenter.getByLabel('operator verified').check();
  await commandCenter.getByLabel('rollback plan attached').check();
  await commandCenter.getByLabel('rollback reference').fill('browser-check rollback plan keeps external state untouched');
  await verifyAdapterPacket.click();
  await actionResult.getByText('Verify Adapter Implementation').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('Verified local adapter implementation packet').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.scrollIntoViewIfNeeded();
  await desktop.screenshot({ path: adapterVerifiedScreenshot, fullPage: false });

  const attachAdapter = commandCenter.getByRole('button', { name: 'Attach adapter packet' });
  assert.equal(await attachAdapter.count(), 1);
  await attachAdapter.click();
  await actionResult.getByText('Verified Live Evidence').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('Live Adapter Implementation Receipt').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.getByText('live gate cleared').waitFor({ state: 'visible', timeout: 10000 });
  await actionResult.scrollIntoViewIfNeeded();
  await desktop.screenshot({ path: adapterEvidenceScreenshot, fullPage: false });

  const overlayCount = await desktop.locator('.vite-error-overlay, .webpack-dev-server-client-overlay').count();
  assert.equal(overlayCount, 0);
  assert.deepEqual(consoleIssues(), []);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mobileConsoleIssues = captureConsoleIssues(mobile);
  await mobile.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await mobile.getByRole('tab', { name: 'Portfolio' }).click();
  const mobileCommandCenter = mobile.locator('section[aria-label="board decision command center"]');
  await mobileCommandCenter.getByRole('heading', { name: 'Decision Command Center' }).waitFor({ state: 'visible', timeout: 10000 });
  await mobileCommandCenter.getByText('Mesa Readiness Browser Proof').waitFor({ state: 'visible', timeout: 10000 });
  await mobileCommandCenter.getByText('pending local review').waitFor({ state: 'visible', timeout: 10000 });
  await mobileCommandCenter.scrollIntoViewIfNeeded();
  await mobile.screenshot({ path: mobileScreenshot, fullPage: false });
  assert.deepEqual(mobileConsoleIssues(), []);

  const apiSnapshot = await fetchJson(`${apiBaseUrl}/api/portfolio/operating-model?workspaceId=${encodeURIComponent(seeded.workspaceId)}&limit=20`);
  const command = apiSnapshot.readinessCommandCenter.find((item) => item.id === seeded.reconciliationId);
  assert(command, 'seeded command center row is visible over HTTP');
  assert.equal(command.evidence.pendingReviewCanClearLiveGate, false);
  assert(command.evidence.pendingReviewCount >= 2);
  assert.equal(command.adapterLedger.contractTestsPassed, true);
  assert.equal(command.adapterLedger.verifiedImplemented, true);
  assert.equal(command.providerSmoke.verified, true);
  assert.equal(command.adapterLedger.latestMode, 'implementation_verified');
  assert.equal(command.adapterLedger.latestStatus, 'verified_implemented');
  assert(command.evidence.verifiedProofKeys.includes('provider_live_smoke'));
  assert(command.evidence.verifiedProofKeys.includes('live_adapter_implemented'));

  console.log(JSON.stringify({
    ok: true,
    browserPath: 'playwright_fallback',
    fallbackReason: 'Browser plugin iab backend unavailable',
    appUrl,
    apiBaseUrl,
    seeded,
    rendered: {
      title: desktopTitle,
      hasDecisionCommandCenter: true,
      liveReleaseBlockerQueueFilterVisible: true,
      liveReleaseBlockerQueueExportVisible: true,
      liveReleaseBlockerQueueChecksumVisible: true,
      liveReleaseBlockerQueueReviewReceiptVisible: true,
      pendingReviewVisible: true,
      providerEvidenceVerifiedReceiptVisible: true,
      adapterImplementationBlockedReceiptVisible: true,
      adapterProofCaptureVisible: true,
      adapterImplementationVerifiedReceiptVisible: true,
      adapterEvidenceVerifiedReceiptVisible: true,
      mobilePendingReviewVisible: true,
      consoleIssues: [],
      screenshots: {
        desktop: desktopScreenshot,
        receipt: receiptScreenshot,
        adapterBlocked: adapterBlockedScreenshot,
        adapterVerified: adapterVerifiedScreenshot,
        adapterEvidence: adapterEvidenceScreenshot,
        mobile: mobileScreenshot
      }
    },
    api: {
      pendingReviewCount: command.evidence.pendingReviewCount,
      pendingReviewCanClearLiveGate: command.evidence.pendingReviewCanClearLiveGate,
      pendingReviewProofKeys: command.evidence.pendingReviewProofKeys,
      adapterLedgerBlockedStatus: blockedCommand.adapterLedger.latestStatus,
      adapterLedgerLatestMode: command.adapterLedger.latestMode,
      adapterLedgerLatestStatus: command.adapterLedger.latestStatus,
      adapterLedgerImplementationBlockedBeforeProof: true,
      adapterLedgerVerifiedImplemented: command.adapterLedger.verifiedImplemented,
      providerSmokeVerified: command.providerSmoke.verified,
      verifiedProofKeys: command.evidence.verifiedProofKeys
    }
  }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (devChild) await stopChild(devChild);
  db.close?.();
  rmSync(dataDir, { recursive: true, force: true });
}

function seedReadinessCommandCenter() {
  const now = Date.now();
  const suffix = randomBytes(4).toString('hex');
  const workspaceId = 'ws_callan';
  const boot = portfolioOperatingModel.bootstrapDefault({
    workspaceId,
    organizationName: 'Callan Readiness Browser Proof Co',
    workspaceName: 'Callan Readiness Browser Proof'
  });
  const serviceBusinessId = `svc_readiness_browser_${suffix}`;
  const fusionId = `sdfusion_readiness_browser_${suffix}`;
  const executionId = `sdexec_readiness_browser_${suffix}`;
  const reconciliationId = `sdrecon_readiness_browser_${suffix}`;
  const serviceName = 'Mesa Readiness Browser Proof';
  const cleared = [
    'operator_board_approval',
    'finance_runway_evidence',
    'retention_playbook_live_preflight_ready',
    'vendor_quality_live_preflight_ready',
    'side_effect_flag_attested'
  ];
  const remainingProofBlockers = ['provider_live_smoke', 'live_adapter_implemented'];
  const runtimeBlockers = ['run_mode', 'side_effect_flag_runtime', 'live_board_execution_guardrail'];
  const blockers = [...remainingProofBlockers, ...runtimeBlockers];

  db.prepare(`
    INSERT INTO service_businesses (
      id, workspace_id, vertical_key, name, status, customer_outcome, offer_json, channels_json, readiness_json,
      created_at, updated_at
    )
    VALUES (
      @id, @workspace_id, @vertical_key, @name, @status, @customer_outcome, @offer_json, @channels_json, @readiness_json,
      @created_at, @updated_at
    )
  `).run({
    id: serviceBusinessId,
    workspace_id: workspaceId,
    vertical_key: 'emergency_plumbing',
    name: serviceName,
    status: 'launch_candidate',
    customer_outcome: 'Book urgent local plumbing help with evidence-backed dispatch guardrails.',
    offer_json: JSON.stringify({ packages: [{ key: 'urgent_dispatch', priceCents: 14900 }] }),
    channels_json: JSON.stringify({ owned_acquisition_surface: { status: 'local_only' } }),
    readiness_json: JSON.stringify({ source: 'portfolio_readiness_browser_check', liveExecutionBlocked: true }),
    created_at: now,
    updated_at: now
  });

  db.prepare(`
    INSERT INTO portfolio_service_decision_fusion_receipts (
      id, workspace_id, service_business_id, provider, decision_kind, status, decision, priority, risk_score,
      recommended_budget_cents, acquisition_signal, finance_signal, retention_signal, fulfillment_signal, remediation_signal,
      summary, decision_payload_json, safety_json, evidence_json, created_at, updated_at
    )
    VALUES (
      @id, @workspace_id, @service_business_id, 'service_decision_fusion_engine', 'board_level_service_decision',
      'proposed', 'scale_with_retention_quality_guardrails', 'high', 0.22, 1700,
      'scale', 'scale_market', 'fund_retention_followup_after_board_feedback', 'backup_route_ready', 'saved_watch',
      @summary, @decision_payload_json, @safety_json, @evidence_json, @created_at, @updated_at
    )
  `).run({
    id: fusionId,
    workspace_id: workspaceId,
    service_business_id: serviceBusinessId,
    summary: 'Seeded board decision for browser-visible readiness command proof.',
    decision_payload_json: JSON.stringify({ source: 'portfolio_readiness_browser_check' }),
    safety_json: JSON.stringify({ kind: 'service_decision_fusion_safety', externalSideEffects: false }),
    evidence_json: JSON.stringify([{ source: 'portfolio_readiness_browser_check', id: 'fusion-seed' }]),
    created_at: now,
    updated_at: now
  });

  db.prepare(`
    INSERT INTO portfolio_service_decision_execution_receipts (
      id, workspace_id, service_business_id, service_decision_fusion_receipt_id, provider, execution_kind,
      execution_scope, mode, status, decision, summary, request_json, response_json, rollback_json, safety_json,
      evidence_json, created_at, updated_at
    )
    VALUES (
      @id, @workspace_id, @service_business_id, @service_decision_fusion_receipt_id, 'service_decision_execution_controller',
      'board_decision_execution', 'service_scale_guardrails', 'dry_run', 'validated',
      'scale_with_retention_quality_guardrails', @summary, @request_json, @response_json, @rollback_json, @safety_json,
      @evidence_json, @created_at, @updated_at
    )
  `).run({
    id: executionId,
    workspace_id: workspaceId,
    service_business_id: serviceBusinessId,
    service_decision_fusion_receipt_id: fusionId,
    summary: 'Seeded dry-run execution receipt for browser-visible readiness command proof.',
    request_json: JSON.stringify({ source: 'portfolio_readiness_browser_check' }),
    response_json: JSON.stringify({
      providerSafety: { kind: 'service_decision_execution_safety', externalSideEffects: false },
      proofPacket: {
        kind: 'service_decision_execution_proof_packet',
        requiredProofKeys: ['operator_board_approval', 'provider_live_smoke', 'live_adapter_implemented']
      }
    }),
    rollback_json: JSON.stringify(null),
    safety_json: JSON.stringify({ kind: 'service_decision_execution_safety', externalSideEffects: false }),
    evidence_json: JSON.stringify([{ source: 'portfolio_readiness_browser_check', id: 'execution-seed' }]),
    created_at: now,
    updated_at: now
  });

  db.prepare(`
    INSERT INTO portfolio_service_decision_readiness_reconciliations (
      id, workspace_id, service_business_id, service_decision_execution_receipt_id, workflow_instance_id,
      provider, status, cleared_count, blocker_count, cleared_json, blockers_json, report_json, safety_json,
      evidence_json, created_at, updated_at
    )
    VALUES (
      @id, @workspace_id, @service_business_id, @service_decision_execution_receipt_id, NULL,
      'service_decision_readiness_reconciler', 'blocked', @cleared_count, @blocker_count, @cleared_json,
      @blockers_json, @report_json, @safety_json, @evidence_json, @created_at, @updated_at
    )
	  `).run({
	    id: reconciliationId,
	    workspace_id: workspaceId,
	    service_business_id: serviceBusinessId,
    service_decision_execution_receipt_id: executionId,
    cleared_count: cleared.length,
    blocker_count: blockers.length,
    cleared_json: JSON.stringify(cleared),
    blockers_json: JSON.stringify(blockers),
    report_json: JSON.stringify({
      serviceBusinessId,
      serviceDecisionExecutionReceiptId: executionId,
      localGates: [],
      runtimeGates: [],
      cleared,
      remainingProofBlockers,
      runtimeBlockers,
      blockers,
      externalSideEffects: false
    }),
    safety_json: JSON.stringify({
      kind: 'service_decision_readiness_reconciliation_safety',
      externalSideEffects: false,
      providerCalled: false,
      adapterInvoked: false,
      jobEnqueued: false
    }),
    evidence_json: JSON.stringify([{ source: 'portfolio_readiness_browser_check', id: 'reconciliation-seed' }]),
	    created_at: now,
	    updated_at: now
	  });

	  const providerEvidence = portfolioOperatingModel.submitReadinessCommandEvidence({
    readinessReconciliationId: reconciliationId,
    proofKey: 'provider_live_smoke',
    actor: 'portfolio_readiness_browser_check',
    attestation: {
      source: 'portfolio_readiness_browser_check',
      operatorSubmitted: true,
      operatorVerified: false,
      externalReceiptReviewed: false
    },
    evidence: [{ source: 'portfolio_readiness_browser_check', id: 'provider-pending-seed' }]
  });
  const adapterEvidence = portfolioOperatingModel.submitReadinessCommandEvidence({
    readinessReconciliationId: reconciliationId,
    proofKey: 'live_adapter_implemented',
    actor: 'portfolio_readiness_browser_check',
    attestation: {
      source: 'portfolio_readiness_browser_check',
      adapterReceiptId: 'local-browser-proof-only',
      adapterImplemented: true,
      adapterSmokePassed: true,
      operatorVerified: true
    },
    evidence: [{ source: 'portfolio_readiness_browser_check', id: 'adapter-pending-seed' }]
  });

  const snapshot = portfolioOperatingModel.snapshot({ workspaceId, limit: 20 });
  const command = snapshot.readinessCommandCenter.find((item) => item.id === reconciliationId);
  assert(command, 'seeded readiness command center row exists');
  assert.equal(command.serviceBusinessName, serviceName);
	  assert.equal(command.evidence.pendingReviewCount, 2);
	  assert.deepEqual(command.evidence.pendingReviewProofKeys, ['live_adapter_implemented', 'provider_live_smoke']);
	  assert.equal(command.evidence.pendingReviewCanClearLiveGate, false);
	  assert.equal(command.providerSmoke.verified, false);
	  assert(command.actionCommands.some((action) => action.action === 'record_provider_smoke_receipt' && action.provider === 'agentmail' && action.externalSideEffects === false));
	  assert.equal(providerEvidence.operatorStatus.status, 'pending_local_review');
	  assert.equal(adapterEvidence.operatorStatus.status, 'pending_local_review');

  return {
    workspaceId: boot.workspace.id,
    serviceBusinessId,
	    serviceBusinessName: serviceName,
	    reconciliationId,
	    serviceDecisionExecutionReceiptId: executionId,
	    providerOperatorStatus: providerEvidence.operatorStatus.status,
    adapterOperatorStatus: adapterEvidence.operatorStatus.status,
    pendingReviewCount: command.evidence.pendingReviewCount
  };
}

function forceMockEnv(target) {
  process.env.DATA_DIR = target;
  process.env.RUN_MODE = 'mock';
  process.env.LIVE_CALLS = 'false';
  process.env.LIVE_EMAILS = 'false';
  process.env.LIVE_PAYMENTS = 'false';
  process.env.LIVE_BUILDS = 'false';
  process.env.AUTONOMOUS_OUTREACH_ENABLED = 'false';
  process.env.SMOKE_BROWSER_USE = 'false';
}

function captureConsoleIssues(page) {
  const issues = [];
  page.on('console', (msg) => {
    if (['warning', 'warn', 'error'].includes(msg.type())) {
      issues.push({ type: msg.type(), text: msg.text() });
    }
  });
  page.on('pageerror', (err) => {
    issues.push({ type: 'pageerror', text: err?.message || String(err) });
  });
  return () => issues.filter((issue) => !issue.text.includes('Download the React DevTools'));
}

async function waitForHealth(baseUrl, child, output) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < 30000) {
    if (child.exitCode != null) throw new Error(`dev server exited before API health; output:\n${output.join('').slice(-2000)}`);
    try {
      const health = await fetchJson(`${baseUrl}/api/health`);
      if (health.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`API health did not become ready: ${lastErr?.message || 'timeout'}\n${output.join('').slice(-2000)}`);
}

async function waitForVite(url, child, output) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started < 15000) {
    if (child.exitCode != null) throw new Error(`dev server exited before Vite; output:\n${output.join('').slice(-2000)}`);
    try {
      const html = await fetchText(url);
      if (html.includes('id="root"')) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`Vite did not become ready: ${lastErr?.message || 'timeout'}\n${output.join('').slice(-2000)}`);
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

async function stopChild(child) {
  if (child.exitCode != null || child.killed) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    sleep(1500).then(() => false)
  ]);
  if (!exited && child.exitCode == null) child.kill('SIGKILL');
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
