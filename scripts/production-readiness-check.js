#!/usr/bin/env node

// One-command production readiness report. Read-only: no provider calls.

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log([
    'Usage: npm run check:production -- [--strict]',
    '',
    'Without --strict this prints blockers and exits 0 unless the app is already in production_live.',
    'With --strict it exits 1 when production_live blockers remain.'
  ].join('\n'));
  process.exit(0);
}

const [{ env }, { liveReadiness }] = await Promise.all([
  import('../server/env.js'),
  import('../server/readiness.js')
]);

const readiness = liveReadiness();
const strict = args.strict || process.env.CHECK_PRODUCTION_STRICT === 'true' || env.runMode === 'production_live';
const report = buildReport(readiness, { strict });

console.log(JSON.stringify(report, null, 2));
printHuman(report);
if (!report.ok) process.exitCode = 1;

function buildReport(readiness, { strict }) {
  const providers = Object.fromEntries(Object.entries(readiness.providers).map(([name, row]) => [name, {
    providerConfigured: row.configured,
    webhookConfigured: row.webhookConfigured,
    smokeStatus: row.smokeStatus,
    lastError: row.lastError,
    quotaCostStatus: row.quotaCostStatus,
    blockerReasons: row.blockerReasons,
    nextAction: row.nextAction
  }]));
  return {
    ok: strict ? readiness.canGoLive : true,
    strict,
    generatedAt: new Date().toISOString(),
    mode: readiness.mode,
    currentModeReady: readiness.ready,
    productionLiveReady: readiness.canGoLive,
    currentModeBlockers: readiness.blockers,
    productionBlockers: readiness.productionBlockers,
    nextActions: readiness.nextActions,
    sideEffects: readiness.sideEffects,
    providers,
    webhooks: readiness.webhooks,
    compliance: readiness.compliance,
    quotas: readiness.quotas,
    docs: readiness.docs
  };
}

function printHuman(report) {
  console.log('\n=== PRODUCTION READINESS ===');
  console.log(`mode: ${report.mode}`);
  console.log(`current mode ready: ${report.currentModeReady ? 'yes' : 'no'}`);
  console.log(`production live ready: ${report.productionLiveReady ? 'yes' : 'no'}`);
  if (report.productionBlockers.length) {
    console.log('\nCannot go live because:');
    for (const blocker of report.productionBlockers.slice(0, 20)) console.log(`- ${blocker}`);
  }
  console.log('\nProvider report:');
  for (const [name, row] of Object.entries(report.providers)) {
    const bits = [
      row.providerConfigured ? 'configured' : 'missing',
      row.webhookConfigured === null ? null : row.webhookConfigured ? 'webhook ok' : 'webhook blocked',
      `smoke ${row.smokeStatus}`,
      row.lastError ? `lastError=${row.lastError}` : null,
      row.nextAction ? `next=${row.nextAction}` : null
    ].filter(Boolean);
    console.log(`- ${name}: ${bits.join('; ')}`);
  }
  console.log(`\nexit policy: ${report.strict ? 'strict' : 'report-only'}`);
}

function parseArgs(argv) {
  return {
    strict: argv.includes('--strict'),
    help: argv.includes('--help') || argv.includes('-h')
  };
}
