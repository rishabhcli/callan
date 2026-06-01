#!/usr/bin/env node

import { printSafeToRenewReport, runSafeToRenewSelfCheck } from '../server/safeToRenew.js';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log([
    'Usage: npm run safe-to-renew -- [--report-only] [--no-record]',
    '',
    'Runs the subscription renewal/aftercare self-check without live provider side effects.',
    'Records an operational safe-to-renew snapshot unless --no-record is provided.',
    'Exits 1 when Callan is not safe to renew unless --report-only is provided.'
  ].join('\n'));
  process.exit(0);
}

const report = await runSafeToRenewSelfCheck({
  record: !args.noRecord,
  source: 'cli'
});

console.log(JSON.stringify(report, null, 2));
printSafeToRenewReport(report);

if (!args.reportOnly && !report.ok) process.exitCode = 1;

function parseArgs(argv) {
  return {
    reportOnly: argv.includes('--report-only'),
    noRecord: argv.includes('--no-record'),
    help: argv.includes('--help') || argv.includes('-h')
  };
}
