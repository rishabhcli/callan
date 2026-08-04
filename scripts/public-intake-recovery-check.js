#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-public-intake-recovery-'));
process.env.DATA_DIR = dataDir;
process.env.RUN_MODE = 'mock';

const { db, durableJobs, publicIntakeRequests } = await import('../server/db.js');

function createRequest(now, businessName) {
  return publicIntakeRequests.create({
    businessName,
    niche: 'HVAC repair',
    city: 'Oakland, CA',
    website: `https://${businessName.toLowerCase().replaceAll(' ', '-')}.example`,
    now
  });
}

try {
  const linked = createRequest(1_000, 'Linked Research');
  const linkedStage = publicIntakeRequests.action(linked.request.id, 'start_research', {
    actor: 'operator',
    now: 1_000,
    metadata: {
      action: 'start_research',
      researchAttemptKey: `public_intake_research:${linked.request.id}:initial`,
      previousStatus: 'received',
      previousResearchJobId: null
    }
  });
  assert.equal(linkedStage.request.status, 'researching');
  assert.equal(linkedStage.request.research_job_id, null);

  const durable = durableJobs.enqueue({
    type: 'public_intake.research',
    payload: { intakeId: linked.request.id },
    idempotency_key: `public_intake_research:${linked.request.id}:initial`,
    runAt: 1_000,
    now: 1_000
  });
  const linkedRecovery = publicIntakeRequests.reconcileResearchQueue({ now: 1_000, staleAfterMs: 0 });
  const linkedAfter = publicIntakeRequests.get(linked.request.id);
  assert.equal(linkedAfter.research_job_id, durable.row.id, 'existing durable job is linked during reconciliation');
  assert.equal(linkedRecovery[0]?.action, 'linked');
  assert(publicIntakeRequests.events(linked.request.id).some((event) => event.eventType === 'research_job_reconciled'));

  const orphan = createRequest(2_000, 'Orphan Research');
  const orphanStage = publicIntakeRequests.action(orphan.request.id, 'start_research', {
    actor: 'operator',
    now: 2_000,
    metadata: {
      action: 'start_research',
      researchAttemptKey: `public_intake_research:${orphan.request.id}:initial`,
      previousStatus: 'received',
      previousResearchJobId: null
    }
  });
  assert.equal(orphanStage.request.status, 'researching');
  const orphanRecovery = publicIntakeRequests.reconcileResearchQueue({ now: 62_000, staleAfterMs: 60_000 });
  const orphanAfter = publicIntakeRequests.get(orphan.request.id);
  assert.equal(orphanAfter.status, 'received', 'orphaned staging returns to the prior request state');
  assert.equal(orphanAfter.research_job_id, null);
  assert.equal(orphanRecovery.find((item) => item.intakeId === orphan.request.id)?.action, 'reset');
  assert(publicIntakeRequests.events(orphan.request.id).some((event) => event.eventType === 'research_queue_recovered'));

  const bootLinked = createRequest(3_000, 'Boot Linked Research');
  publicIntakeRequests.action(bootLinked.request.id, 'start_research', {
    actor: 'operator',
    now: 3_000,
    metadata: {
      action: 'start_research',
      researchAttemptKey: `public_intake_research:${bootLinked.request.id}:initial`,
      previousStatus: 'received',
      previousResearchJobId: null
    }
  });
  const bootJob = durableJobs.enqueue({
    type: 'public_intake.research',
    payload: { intakeId: bootLinked.request.id },
    idempotency_key: `public_intake_research:${bootLinked.request.id}:initial`,
    runAt: 3_000,
    now: 3_000
  });
  const bootOrphan = createRequest(4_000, 'Boot Orphan Research');
  publicIntakeRequests.action(bootOrphan.request.id, 'start_research', {
    actor: 'operator',
    now: 4_000,
    metadata: {
      action: 'start_research',
      researchAttemptKey: `public_intake_research:${bootOrphan.request.id}:initial`,
      previousStatus: 'received',
      previousResearchJobId: null
    }
  });
  db.close();

  const port = await getFreePort();
  const childEnv = {
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
    AGENTMAIL_POLL_ENABLED: 'false',
    GEMINI_API_KEY: '',
    SUPERMEMORY_API_KEY: '',
    MOSS_API_KEY: '',
    AGENTPHONE_API_KEY: '',
    AGENTMAIL_API_KEY: '',
    BROWSER_USE_API_KEY: '',
    LOVABLE_API_KEY: '',
    STRIPE_SECRET_KEY: ''
  };
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/ping`);
      return response.ok;
    }, child, output);
    const bootList = await fetch(`http://127.0.0.1:${port}/api/intake/requests?q=Boot`).then((response) => response.json());
    const linkedRow = bootList.requests.find((row) => row.id === bootLinked.request.id);
    const orphanRow = bootList.requests.find((row) => row.id === bootOrphan.request.id);
    assert.equal(linkedRow.research_job_id, bootJob.row.id, 'server boot relinks the durable research job');
    assert.equal(orphanRow.status, 'received', 'server boot restores an orphaned staged request');
    assert.equal(orphanRow.research_job_id, null);
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }

  console.log(JSON.stringify({
    ok: true,
    checks: {
      durableJobRelinked: true,
      orphanedStagingRecovered: true,
      recoveryEventsPersisted: true,
      bootReconciliation: true
    }
  }, null, 2));
} finally {
  try { db.close(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(check, child, output, timeoutMs = 10_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode != null) throw new Error(`server exited: ${child.exitCode}\n${output.join('').slice(-2000)}`);
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for recovery server: ${lastError?.message || 'no response'}`);
}
