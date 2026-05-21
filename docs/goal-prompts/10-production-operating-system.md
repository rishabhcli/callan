# Goal: Production Operating System

You are working in `/Users/m3-max/Documents/GitHub/callan`. Turn Callan from a local hackathon service into a production operating system for running a small autonomous web agency.

Persistence rule: do not complete until there is a truthful "safe to sell today" command/surface backed by durable jobs, observability, evals, and readiness gates. If this exceeds one pass, keep implementing the next missing production primitive and proof.

Verify first:
- Readiness: `server/readiness.js`, `scripts/production-readiness-check.js`.
- Provider smokes: `scripts/provider-smoke.js`.
- Reliability: `scripts/reliability-drill.js`.
- Costs/margins: `server/costs.js`, `/api/economics/by-niche`.
- Current persistence is SQLite.
- Package scripts already expose many checks.

Mission: build the production backbone: durable jobs, retries, observability, evals, provider health, cost/margin dashboards, promotion gates, backups/export, and one command that tells whether Callan can safely sell today.

Implement:
1. Durable job system:
   - jobs table with type, payload, status, attempts, next_attempt_at, lock/lease, error, result
   - migrate practical fire-and-forget work: research, call follow-up, mail reply, builder, growth, aftercare
   - crash recovery and idempotency
2. Observability:
   - provider latency/error/cost
   - recent failures by worker/provider
   - stuck jobs/builds/calls
   - daily revenue/cost/margin
   - outreach state
3. Eval suite:
   - sales transcript eval
   - email reply policy eval
   - website QA eval
   - lead research evidence eval
   - invoice/build exactly-once eval
   - compliance eval
4. Launch gates:
   - production_review and production_live dashboards
   - smoke freshness
   - webhook freshness
   - dry-run vs live-side-effect verification separation
   - "safe to sell today" summary
5. Admin tools:
   - export lead/customer data
   - backup SQLite data dir
   - redact PII in reports/logs
   - reset mock/demo data safely
6. UI:
   - production command center
   - provider health
   - queue health
   - economics
   - blockers and next actions
7. Checks:
   - stuck job recovery
   - stale smoke blocker
   - margin rollup
   - backup/export smoke
   - PII redaction
   - readiness strict mode

Acceptance:
- `npm run check` passes.
- `npm run build` passes.
- `npm run check:production` and `npm run drill:reliability` pass or report truthful blockers.
- Add `npm run check:ops` or equivalent.
- Final answer includes safe-to-sell categories: dry-run verified, live-smoke verified, still blocked.

North-star finish line: Callan should be able to wake up tomorrow, inspect itself, and truthfully decide whether it is allowed to make money without you babysitting it.
