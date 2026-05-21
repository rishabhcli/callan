#!/usr/bin/env node

import { backupSqliteDataDir } from '../server/ops.js';
import { db } from '../server/db.js';

try {
  const result = backupSqliteDataDir();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} catch (err) {
  console.log(JSON.stringify({
    ok: false,
    error: err?.message || String(err)
  }, null, 2));
  process.exitCode = 1;
} finally {
  try { db.close(); } catch {}
}
