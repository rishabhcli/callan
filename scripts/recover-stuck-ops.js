#!/usr/bin/env node

import { recoverStuckOperations } from '../server/ops.js';
import { db } from '../server/db.js';

try {
  const result = recoverStuckOperations({
    dryRun: process.argv.includes('--dry-run'),
    maxCallAgeMs: numericArg('--max-call-age-ms') || undefined
  });
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

function numericArg(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return Number(inline.slice(name.length + 1));
  const index = process.argv.indexOf(name);
  if (index >= 0) return Number(process.argv[index + 1]);
  return null;
}
