#!/usr/bin/env node

import { printSafeToSellReport, runSafeToSellSelfCheck } from '../server/safeToSell.js';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log([
    'Usage: npm run safe-to-sell -- [--report-only] [--no-record] [--no-maintenance]',
    '',
    'Runs bounded stale ops maintenance, then the production sell gate without live provider side effects.',
    'Records an operational self-check snapshot unless --no-record is provided.',
    'Exits 1 when Callan is not safe to sell unless --report-only is provided.'
  ].join('\n'));
  process.exit(0);
}

const report = await runSafeToSellSelfCheck({
  record: !args.noRecord,
  source: 'cli',
  refreshOps: !args.noMaintenance
});

console.log(JSON.stringify(report, null, 2));
printSafeToSellReport(report);

if (!args.reportOnly && !report.ok) process.exitCode = 1;

function parseArgs(argv) {
  return {
    reportOnly: argv.includes('--report-only'),
    noRecord: argv.includes('--no-record'),
    noMaintenance: argv.includes('--no-maintenance'),
    help: argv.includes('--help') || argv.includes('-h')
  };
}
