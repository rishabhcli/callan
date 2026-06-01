# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`callmemaybe` (repo name `callan`) is an agentic cold-calling web agency demo. One Express process drives the entire lifecycle: discover a weak-presence local business → research it → call it → analyze the call → email an invoice → take payment → build a site → follow up. Eight sponsor providers each own one visible job (see `README.md` § Sponsor Roles). Treat the README as the operator-facing source of truth for product behavior and sponsor contracts.

## Common commands

```sh
npm run dev          # scripts/dev.js spawns `node server/index.js` + `vite` together
npm run server       # Express API only (port 8787 by default)
npm run build        # Vite build → dist/
npm run start        # NODE_ENV=production server/index.js
npm run check        # `node --check` over server/ and scripts/ — fastest syntax gate
npm run demo:e2e     # one-command mocked lifecycle (seed → call → invoice → paid → build → verify)
npm run safe-to-sell # fail-closed launch gate (exits nonzero when not ready)
npm run safe-to-renew # fail-closed renewal/aftercare gate; records non-live save playbooks for at-risk subscriptions
npm run check:aftercare # account-manager plans/tasks, dry-run previews, renewal closeout health checks, operator-board escalation, lifecycle receipts, and retention-feedback receipts
npm run check:portal # token-scoped customer portal actions, including renewal review/change requests, confirmations, acknowledgements, and acceptances
npm run check:ops    # ops observability/export/queue regressions, including renewal billing/message preflight, execution, confirmation, acknowledgement, acceptance, follow-up, closeout, and closeout-to-aftercare gates
npm run check:maygoals # portfolio operating-model proof, including renewal closeout-driven retention playbooks
npm run drill:reliability  # starts a throwaway mock server, hits public routes
npm run smoke:providers    # provider readiness; live checks need SMOKE_* + `-- --provider <name>`
```

### `check:*` regression scripts (no test framework — each is a standalone Node script)

Run any one directly: `node scripts/<name>-check.js`. The npm aliases mirror the script names: `check:revenue`, `check:supermemory`, `check:moss`, `check:call-state`, `check:presence`, `check:browser-research`, `check:dedupe`, `check:autonomy`, `check:reasoning`, `check:fulfillment`, `check:inbound-anything`, `check:builder-hooks`, `check:growth`, `check:commerce`, `check:handoff`, `check:aftercare`, `check:portal`, `check:browser-console`, `check:evals`, `check:ops`, `check:production`, `check:safety`. There is no Jest/Vitest — these scripts assert directly and exit nonzero on failure.

### Demo data

```sh
npm run demo:e2e -- --data-dir .data/demo --reset-demo-data
DATA_DIR=.data/demo npm run dev   # inspect the same SQLite from the operator console
```

## Architecture

### Single-process backend with a durable job loop

`server/index.js` (~3k lines) is the entire HTTP + worker host. On `app.listen` it also boots: `startDurableJobLoop(durableJobHandlers)`, `startOpsBackupScheduler`, `startProviderPostureScheduler`, `startOpsRecoveryScheduler`, `startSafeToSellSelfCheckScheduler`, `startScheduledCallLoop`, `startAccountManagerLoop`, `startReputationLoop`, and the AgentMail poller. There is no separate worker process.

Durable jobs (`server/jobs.js` + the `durable_jobs` SQLite table) use a claim-with-lease pattern. The `durableJobHandlers` map at the top of `server/index.js` is the canonical list of every job type and its handler — start here when tracing how anything async runs. Per-domain enqueue helpers wrap `enqueueJob` (`builderQueue.js`, `growthQueue.js`, `analysisQueue.js`, `mailReplyQueue.js`, `leadPriorityQueue.js`, `inboundVoiceQueue.js`, `inboundMemoryQueue.js`, `operatorTransferQueue.js`, `hostingUpsellQueue.js`).

### Workers and the lead lifecycle

`server/workers/*.js` are the long-running stages: `scraper` → `caller` → `analyst` → `mailer` (+ `mailReply`) → `builder` → `scheduledCaller` / `scheduleClassifier`. The Stripe `invoice.paid` webhook (`server/webhooks/stripe.js`) is what flips a verbal yes into a builder job; `recoverTriggeredPaymentBuilds` re-enqueues anything that crashed mid-build on boot.

### Mode / side-effect gating

The default posture is mocked and local. Every outbound side effect is gated three ways:

1. `RUN_MODE` (`mock`, `demo_live`, `autonomous_live`, `production_review`, `production_live`) — see `MODE_POLICIES` in `server/env.js`.
2. Boolean `LIVE_CALLS` / `LIVE_EMAILS` / `LIVE_PAYMENTS` / `LIVE_BROWSER_SESSIONS` / `LIVE_PUBLIC_OUTREACH` / `LIVE_BUILDS`.
3. `ALLOWED_TARGET_PHONES` / `ALLOWED_TARGET_EMAILS` allow-lists for `demo_live`.

Use the helpers (`canEmail`, `canStartBrowserSession`, `modeAllowsSideEffect`) from `server/env.js` — don't read flags directly when adding new side effects. `production_live` additionally requires `PRODUCTION_LIVE_ACK=I_UNDERSTAND_LIVE_OUTREACH`, `NODE_ENV=production`, public HTTPS `APP_PUBLIC_URL`, fresh live smoke rows, and the readiness gates in `server/readiness.js`.

### Reasoning contract (Gemini)

All Gemini calls go through `generateStructured` in `server/reasoning/geminiReasoner.js` with Zod schemas from `server/reasoning/schemas.js` and `server/research/schemas.js`. The path is: Gemini structured output (`responseJsonSchema`) → local Zod validate → one repair pass → persist to the `reasoning_traces` table (raw, repaired, final, validation errors, latency, schema name, lead/worker context). Mock mode swaps the provider for a synthetic one but takes the same path. When adding new reasoning, define a Zod schema and call `generateStructured` rather than calling Gemini directly.

### Memory (Supermemory)

`server/memory.js` is the only call site. Policy: `containerTag = lead:<leadId>`, `customId = <kind>:<leadId>:<sourceId>`. Every write mirrors into the `memory_documents` table, retries failures through `memory_write_queue`, and logs searches in `memory_searches`. Mock mode uses a synthetic provider but exercises the same mirror/queue/observability path. The list of allowed kinds is `MEMORY_KINDS` in `server/memory.js`.

### SQLite persistence

`server/db.js` (~6.5k lines, single file) owns all schema + access. It opens `${DATA_DIR}/callmemaybe.db` (default `.data/`), enables WAL + foreign keys, and exports per-table modules (`leads`, `runs`, `calls`, `payments`, `builds`, `contactEvents`, `webhookEvents`, `doNotCall`, `events`, `auditTrail`, `reasoningTraces`, `scheduledCalls`, `subscriptions`, `leadCosts`, `durableJobs`, `accountManagerPlans`, `accountTasks`, `handoffCases`, …). When you need new persistence, add it here and export a module rather than reaching into raw `db.prepare` from feature code.

### Webhooks

`/api/webhooks/*` uses a raw-body verifier (`rawBodySaver`) so HMAC signature checks pass. Three providers: AgentPhone (5-minute replay window + `X-Webhook-ID` idempotency), AgentMail (Svix), Stripe. `webhookEvents` records every delivered event for idempotency.

### Admin auth

Non-public operator routes go through `requireAdmin` (`server/adminAuth.js`) via the `isOperatorProtectedRequest` middleware in `server/index.js`. Accepts `Authorization: Bearer $ADMIN_API_TOKEN`, `X-Admin-Token`, or the same-origin admin cookie. Mock/dev runs work without a token unless `ADMIN_API_TOKEN` is set; `production_*` modes require one. `/api/ping` is the intentionally public liveness probe; provider webhooks keep their own signature checks; customer portal links use scoped tokens, not the admin token.

### Frontend (operator console)

`src/App.jsx` is the shell; views live in `src/views/` (Operations, Scraper, Memory, Agents, Settings, Share). State streams from `/api/events/stream` via `src/useSSE.js`; REST calls go through `src/api.js`. The Express server serves `dist/` for `/` after `npm run build`. There is no separate frontend build/test step beyond `vite build`.

### Vertical packs

`server/verticalPacks/*.json` (default, barber, hvac, plumber, restaurant) carry per-niche pitch chunks, objection handling, and Moss index seeds. `server/verticalPacks/index.js` picks the pack by `lead.niche`.

## Conventions worth knowing before editing

- **No test framework.** Add a deterministic `scripts/<name>-check.js` and wire it as `check:<name>` in `package.json` — that's how the rest of the repo proves behavior.
- **Side effects must be gated.** When in doubt, route through `server/env.js` helpers and `server/compliance.js` rather than checking env vars yourself.
- **Reasoning means a Zod schema.** Don't add freeform Gemini prompts without a schema in `server/reasoning/schemas.js` and persistence via `generateStructured`.
- **Memory writes go through `addDoc`.** Don't call the Supermemory SDK directly from workers.
- **Durable work goes through `enqueueJob`.** Don't `setTimeout`/`setImmediate` for retryable work — register a handler in the `durableJobHandlers` map in `server/index.js`.
- **`README.md` and `upgrade.md` are load-bearing.** They describe the product contract operators and judges see; align behavior with them.
