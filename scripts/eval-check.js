#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-evals-'));
const startedAt = Date.now();
let dbHandle = null;

try {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    RUN_MODE: 'mock',
    LIVE_CALLS: 'false',
    LIVE_EMAILS: 'false',
    LIVE_PAYMENTS: 'false',
    LIVE_BROWSER_SESSIONS: 'false',
    LIVE_PUBLIC_OUTREACH: 'false',
    LIVE_BUILDS: 'false'
  });

  const dbModule = await import('../server/db.js');
  const { runProductionEvals } = await import('../server/evals.js');
  dbHandle = dbModule.db;
  const report = await runProductionEvals({ storage: dbModule });
  const payload = {
    ...report,
    name: 'production-evals',
    data: {
      dir: dataDir,
      isolated: true,
      removed: true
    },
    durationMs: Date.now() - startedAt
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.ok ? 0 : 1;
} catch (err) {
  console.log(JSON.stringify({
    ok: false,
    name: 'production-evals',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    data: {
      dir: dataDir,
      isolated: true,
      removed: true
    },
    error: {
      message: err?.message || String(err),
      stack: err?.stack || null
    }
  }, null, 2));
  process.exitCode = 1;
} finally {
  try { dbHandle?.close?.(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
}
