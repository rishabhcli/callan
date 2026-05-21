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
const { opsObservability } = await import('../server/ops.js');
const { buildProviderProofMatrix } = await import('../server/safeToSell.js');
const { redact } = await import('../server/logger.js');

const readiness = liveReadiness();
const observability = opsObservability();
const strict = args.strict || process.env.CHECK_PRODUCTION_STRICT === 'true' || env.runMode === 'production_live';
const report = redact(buildReport(readiness, { strict, observability }));

console.log(JSON.stringify(report, null, 2));
printHuman(report);
if (!report.ok) process.exitCode = 1;

function buildReport(readiness, { strict, observability }) {
  const providers = Object.fromEntries(Object.entries(readiness.providers).map(([name, row]) => [name, {
    providerConfigured: row.configured,
    webhookConfigured: row.webhookConfigured,
    smokeStatus: row.smokeStatus,
    smokeFresh: row.smokeFresh,
    smokeCheckedAt: row.smoke?.checkedAt || null,
    dryRunSmoke: row.dryRunSmoke || null,
    liveSmoke: row.liveSmoke || null,
    lastError: row.lastError,
    quotaCostStatus: row.quotaCostStatus,
    blockerReasons: row.blockerReasons,
    nextAction: row.nextAction
  }]));
  return {
    ok: strict
      ? readiness.canGoLive
        && observability.schedulerHealth?.ok !== false
        && observability.economicsHealth?.ok !== false
        && observability.providerHealthSlo?.ok !== false
        && observability.workerHealthSlo?.ok !== false
      : true,
    strict,
    generatedAt: new Date().toISOString(),
    mode: readiness.mode,
    currentModeReady: readiness.ready,
    productionLiveReady: readiness.canGoLive,
    currentModeBlockers: readiness.blockers,
    productionBlockers: readiness.productionBlockers,
    promotionGates: readiness.promotionGates,
    nextActions: readiness.nextActions,
    sideEffects: readiness.sideEffects,
    providers,
    providerProof: buildProviderProofMatrix({ readiness, observability }),
    webhooks: readiness.webhooks,
    admin: readiness.admin,
    jobs: readiness.jobs,
    compliance: readiness.compliance,
    reputation: readiness.reputation,
    observability: {
      schedulerHealth: observability.schedulerHealth,
      economicsHealth: observability.economicsHealth,
      providerHealthSlo: observability.providerHealthSlo,
      workerHealthSlo: observability.workerHealthSlo,
      workerHistory: observability.workerHistory,
      durableJobIssueHistory: observability.durableJobIssueHistory,
      recentFailures: observability.recentFailures
    },
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
      `dry ${formatSmoke(row.dryRunSmoke)}`,
      `live ${formatSmoke(row.liveSmoke)}`,
      row.lastError ? `lastError=${row.lastError}` : null,
      row.nextAction ? `next=${row.nextAction}` : null
    ].filter(Boolean);
    console.log(`- ${name}: ${bits.join('; ')}`);
  }
  console.log('\nReputation gates:');
  for (const gate of report.reputation?.gates || []) {
    console.log(`- ${gate.name}: ${gate.ok ? 'ok' : 'blocked'} (${gate.detail})`);
  }
  console.log('\nPromotion gates:');
  for (const [key, stage] of Object.entries(report.promotionGates || {})) {
    console.log(`- ${key}: ${stage.ok ? 'ready' : `blocked (${stage.blockerCount || 0})`}`);
  }
  if (report.observability) {
    console.log('\nOps SLOs:');
    console.log(`- providers: ${report.observability.providerHealthSlo?.ok === false ? 'blocked' : 'healthy'}`);
    console.log(`- workers: ${report.observability.workerHealthSlo?.ok === false ? 'blocked' : 'healthy'}`);
    console.log(`- economics: ${report.observability.economicsHealth?.ok === false ? 'blocked' : 'healthy'}`);
    console.log(`- schedulers: ${report.observability.schedulerHealth?.ok === false ? 'blocked' : 'healthy'}`);
  }
  console.log(`\nexit policy: ${report.strict ? 'strict' : 'report-only'}`);
}

function formatSmoke(smoke) {
  if (!smoke) return 'not_run';
  const status = smoke.status || 'not_run';
  const proof = smoke.live ? 'live' : smoke.dryRun ? 'dry' : null;
  const freshness = smoke.fresh ? 'fresh' : smoke.checkedAt ? 'stale' : null;
  return [status, proof, freshness].filter(Boolean).join('/');
}

function parseArgs(argv) {
  return {
    strict: argv.includes('--strict'),
    help: argv.includes('--help') || argv.includes('-h')
  };
}
