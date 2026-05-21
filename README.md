# callan

Agentic cold-calling web agency demo for YC judges and operators. The customer sees a service business: we find a weak-presence local business, call it, sell a website, invoice it, and start the build. The agent stack is internal; the operator console makes each step visible.

The judge-facing line is simple: we are not selling an agent, we are selling an agency. The website offer is the wedge, and the same harness can later run other services businesses.

## Sponsor Roles

| Sponsor | Role in the product | Difference that matters in the demo | Live env surface |
| --- | --- | --- | --- |
| Gemini / Google DeepMind | Reasoning brain for lead scoring, pitch generation, call analysis, AgentMail replies, and Lovable briefs. | Gemini decides and writes structured JSON. It does not call, email, browse, store memory, or take payment. | `GEMINI_API_KEY`, `GEMINI_MODEL_PRO`, `GEMINI_MODEL_FLASH`; smoke with `SMOKE_GEMINI=true`. |
| Supermemory | Durable per-customer memory, scoped by one `containerTag` per lead. | Supermemory is the long-lived customer file. It is not the low-latency in-call hot path and not lead scraping. | `SUPERMEMORY_API_KEY`; smoke writes/searches with `SMOKE_SUPERMEMORY_WRITE=true`. |
| Moss | Sub-10ms retrieval for the live voice turn. | Moss is the call-time cache for pitch chunks and objection handling. It is not web search, not scraping, and not the durable source of truth. | `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, `MOSS_BASE_URL`; live call use also needs `LIVE_CALLS=true`; smoke with `SMOKE_MOSS_INDEX=true`. |
| Browser Use | Cloud browser operator for lead research and for driving Lovable. | Browser Use is the hands in the browser: Yelp/Maps-style audits, screenshots, costs, recordings, and the Lovable session. It is not memory or the website builder itself. | `BROWSER_USE_API_KEY`, `BROWSER_USE_BASE_URL`; builds need `LIVE_BUILDS=true`; smoke with `SMOKE_BROWSER_USE=true`. |
| Lovable | Customer-visible website build surface. | Lovable is where the site appears. Browser Use opens and drives Lovable; the app surfaces the resulting `liveUrl`. There is no direct app env key for Lovable. | Authenticated Lovable browser session for live builds; no `LOVABLE_*` env in this repo; navigation smoke with `SMOKE_LOVABLE_NAVIGATION=true`. |
| AgentPhone | Outbound voice call and transcript provider. | AgentPhone places the call. The app still owns target allow-listing, recording-disclosure copy, DNC/opt-out handling, and when to call. | `AGENTPHONE_API_KEY`, `AGENTPHONE_BASE_URL`, `AGENTPHONE_AGENT_ID`, `AGENTPHONE_DEFAULT_VOICE`, `AGENTPHONE_WEBHOOK_SECRET`, `AGENTPHONE_FROM_NUMBER`; requires `LIVE_CALLS=true` and allow-listed `ALLOWED_TARGET_PHONES` for `demo_live`; smoke with `SMOKE_LIVE_CALL=true SMOKE_TEST_PHONE=+1...`. |
| AgentMail | Customer email thread for invoice, recap, ICS handoff, and replies. | AgentMail is the persistent customer communication channel after the call. It is not the payment processor. | `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_DISPLAY_NAME`, `AGENTMAIL_WEBHOOK_SECRET`; requires `LIVE_EMAILS=true`; demo-live sends only to `ALLOWED_TARGET_EMAILS`; smoke with `SMOKE_AGENTMAIL_SEND=true SMOKE_TEST_EMAIL=...`. |
| Stripe | Hosted invoice and paid-state webhook. | Stripe turns a verbal yes into payment state. AgentMail carries the invoice URL; Stripe owns invoice/payment status. | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_USD_CENTS`, `STRIPE_PRODUCT_NAME`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`; requires `LIVE_PAYMENTS=true`; smoke with `SMOKE_STRIPE_INVOICE=true SMOKE_TEST_EMAIL=...`. |

## Gemini Structured Reasoning

Gemini is the central reasoning system for the agency, not a helper string generator. The app routes business profiles, online-presence scoring, sales strategy, call scripts, objection plans, call analysis, AgentMail reply policy, website build briefs, growth plans, and compliance decisions through Zod schemas in `server/reasoning/schemas.js`.

The provider path uses Gemini structured output with `responseMimeType: "application/json"` and `responseJsonSchema`, then validates again locally with Zod. Invalid JSON, schema mismatches, and unsupported URLs/emails get one repair pass and are persisted to `reasoning_traces` with raw output, repaired output, final output, validation errors, latency, model, provider, worker, event id, and schema name. Mock mode uses the same `generateStructured` orchestration path with synthetic provider output, so the test harness exercises the production reasoning contract without live side effects.

Source docs used for this implementation:

- Gemini structured output and JavaScript/Zod-style schema guidance: https://ai.google.dev/gemini-api/docs/structured-output

Operator/API surfaces:

```sh
GET  /api/reasoning/traces
GET  /api/leads/:id/reasoning
npm run check:reasoning
```

The operator console shows a per-lead Gemini reasoning panel with schema validity, confidence, repair attempts, validation errors, final decision summaries, and source evidence excerpts.

## One-Command Mock Demo

```sh
npm run demo:e2e
```

By default this command:

- forces `RUN_MODE=mock`
- blanks provider keys inside the demo process
- disables live calls, emails, payments, builds, and autonomous outreach
- seeds a weak-presence lead in SQLite
- records a mock call transcript and analyst post-mortem detail with the confirmed invoice email
- creates mocked AgentMail contact events and a mocked Stripe invoice
- records a synthetic `invoice.paid` event through the same paid-state handler used by the server webhook
- creates a mocked build row with live-preview and project URLs
- runs `npm run build`
- starts the Express server on a temporary local port and verifies `/api/health`, `/api/leads`, `/api/leads/:id`, and `/`

Useful variants:

```sh
npm run demo:e2e -- --data-dir .data/demo --reset-demo-data
npm run demo:e2e -- --no-build
npm run demo:e2e -- --no-verify-ui
npm run demo:e2e -- --allow-live-env --verbose
```

The command prints JSON with the lead id, mocked invoice URL, AgentMail thread id, Stripe event id, build URLs, and verification checks. `--allow-live-env` preserves provider env vars for verification reads, but the seeded lifecycle remains mocked.

## Viewing Seeded Demo Data

To inspect the same demo data in the operator console:

```sh
DATA_DIR=.data npm run dev
```

If you used a custom data directory, reuse it:

```sh
DATA_DIR=.data/demo npm run dev
```

Open the Vite URL printed by the command, select the generated lead, and inspect the Mailer and Builder tabs. The Analyst post-call context is also present in the `analyst` worker run detail returned by `/api/leads/:id`.

## Browser Use Command Center

The dashboard now has a Browser Use command center above the node graph. It reads the same `builds` and `events` rows that live and mock builds use, then hydrates real cloud sessions through Browser Use get-session when `BROWSER_USE_API_KEY` is configured and the row is a real UUID-backed live session. Mock rows stay on the same API and UI path without provider calls.

Source docs used for this surface:

- Browser Use get-session fields: https://docs.browser-use.com/cloud/api-v3/sessions/get-session
- Live preview and recordings: https://docs.browser-use.com/cloud/browser/live-preview
- Token/cost pricing: https://docs.browser-use.com/cloud/pricing

Operator/API surfaces:

```sh
GET  /api/browser-use/sessions
GET  /api/browser-use/events
POST /api/browser-use/sessions/:id/stop
npm run check:browser-console
```

The console groups active, completed, and failed/auth-wall sessions; shows `sessionId`, model, status, source task, `liveUrl`, step count, last step summary, screenshots, total cost fields, evidence counts, AgentMail/integration hints, and extraction events. The stop route is gated: synthetic sessions update local build/event state, while real Browser Use stops require `LIVE_BUILDS=true` plus `BROWSER_USE_API_KEY`.

## Browser Use Research Engine

The research console uses Browser Use Cloud API v3 sessions as the lead-evidence engine. The implementation follows the current Browser Use docs for the API base/auth, session creation with `task`, `model`, `keepAlive`, `maxCostUsd`, `profileId`, `workspaceId`, and `outputSchema`, polling `GET /sessions/{session_id}` for `liveUrl`, `lastStepSummary`, structured `output`, tokens, and cost, stopping sessions with `POST /sessions/{session_id}/stop`, and list/status visibility.

Source docs used for this surface:

- Browser Use API reference: https://docs.browser-use.com/cloud/api-reference
- Create sessions and dispatch tasks: https://docs.browser-use.com/cloud/api-v3/sessions/create-session
- Poll session status and structured output: https://docs.browser-use.com/cloud/api-v3/sessions/get-session
- Stop sessions or running tasks: https://docs.browser-use.com/cloud/api-v3/sessions/stop-session
- List sessions: https://docs.browser-use.com/cloud/api-v3/sessions/list-sessions
- Token/session pricing: https://docs.browser-use.com/cloud/pricing

Live research sessions are gated separately from mock mode:

```sh
BROWSER_USE_LIVE_RESEARCH=true
BROWSER_USE_RESEARCH_MAX_COST_USD=0.35
BROWSER_USE_RESEARCH_MODEL=bu-mini
BROWSER_USE_RESEARCH_STRONG_MODEL=bu-max
```

Without `BROWSER_USE_LIVE_RESEARCH=true`, `/api/research/start` runs the same five-session orchestration path with synthetic Browser Use providers and persists `research_jobs`, `browser_sessions`, and `research_evidence`. Strong online-presence businesses stay visible in evidence with `strong_presence_visible_skip` instead of being accepted as callable leads.

## Growth Console

The website sale is now the first service, not the whole agency. Each lead can produce a persisted `GrowthPlan` that uses existing lead research, call analysis, AgentMail thread evidence, and delivery state to recommend operational small-business growth support:

- local SEO gaps
- Google Business Profile tasks
- review capture
- booking/contact flow
- analytics setup
- content ideas
- monthly maintenance
- simple automations

The offer engine evaluates five packages: starter website, website + local SEO, review system, booking/contact automation, and monthly maintenance. Every recommendation must cite a captured evidence id, and unsupported asks such as legal/tax advice or SEO/revenue guarantees are flagged for handoff instead of answered autonomously.

AgentMail growth recaps are post-delivery only and are blocked by opt-out signals. Mock mode still runs the same plan, persistence, and follow-up path, but uses synthetic providers and mock AgentMail sends. Live email sends remain gated by `RUN_MODE`, `LIVE_EMAILS`, provider credentials, and allow-list policy.

Routes and checks:

```sh
GET  /api/growth/status
GET  /api/leads/:id/growth
POST /api/leads/:id/growth/plan
POST /api/leads/:id/growth/followup
POST /api/leads/:id/growth/replies
npm run check:growth
```

## Account Manager Aftercare

After customer launch approval, Callan seeds a persisted `AccountManagerPlan` and `account_tasks` queue. The loop is enabled by default but dry-run by default: it writes scheduled tasks and preview messages, while live AgentMail sends still require `ACCOUNT_MANAGER_LIVE_SENDS=true`, `LIVE_EMAILS=true`, AgentMail credentials, run-mode allow-list approval, quiet-window/frequency gates, and operator approval.

The account manager tracks promised edits, stale phone/hours facts, 24-hour launch follow-up, review capture, Google Business Profile hygiene, seasonal hours, service/menu changes, analytics/contact-flow checks, and hosting/subscription status. Customer portal state shows pending/recent aftercare, and the operator aftercare tab exposes approve/send/pause/complete/reassign plus "why now" evidence.

Routes and checks:

```sh
GET  /api/account-manager/status
POST /api/account-manager/run
GET  /api/leads/:id/account-manager
POST /api/leads/:id/account-manager/plan
POST /api/leads/:id/account-manager/run
GET  /api/account-tasks/:id/explain
POST /api/account-tasks/:id/approve
POST /api/account-tasks/:id/send
POST /api/account-tasks/:id/pause
POST /api/account-tasks/:id/complete
POST /api/account-tasks/:id/reassign
npm run check:aftercare
```

Source docs used for this implementation:

- AgentMail messages and threads: https://docs.agentmail.to/messages
- AgentMail webhooks/events: https://docs.agentmail.to/webhooks-overview
- Supermemory document ingestion and `containerTag`: https://supermemory.ai/docs/add-memories
- Supermemory filtering and scoped search: https://supermemory.ai/docs/memory-api/features/filtering
- Google Business Profile local ranking basics: https://support.google.com/business/answer/7091
- Google Business Profile customer-facing features: https://business.google.com/us/business-profile/
- Google LocalBusiness structured data: https://developers.google.com/search/docs/appearance/structured-data/local-business

## Exact Npm Scripts

These are the scripts currently declared in `package.json`:

```sh
npm run dev              # run the local Express API plus Vite operator console
npm run server           # run only the Express API
npm run demo:e2e         # seed and verify the full mocked lifecycle
npm run build            # build the Vite frontend
npm run start            # production server entrypoint
npm run check            # node --check over server/ and scripts/
npm run check:revenue    # synthetic call -> invoice -> AgentMail reply -> Stripe paid -> one build
npm run check:supermemory # deterministic Supermemory mirror/isolation/retry check
npm run check:browser-research # deterministic Browser Use research swarm check
npm run check:presence   # deterministic online-presence scoring check
npm run check:dedupe     # deterministic lead dedupe/history check
npm run check:autonomy   # deterministic outreach/compliance/payment recovery check
npm run check:reasoning  # deterministic Gemini structured-output, repair, and evidence-reference check
npm run check:fulfillment # deterministic paid-invoice-to-site target fulfillment check
npm run check:growth     # deterministic GrowthPlan, offer, opt-out, and handoff check
npm run check:aftercare  # deterministic account-manager plan, scheduler, portal-seed, and send-gate check
npm run check:production # read-only production readiness report
npm run check:safety     # local safety, HMAC/replay, and idempotency checks
npm run check:browser-console # seeds Browser Use session rows and verifies status API + UI build
npm run drill:reliability # isolated reliability/backpressure drill plus auto-started route proof
npm run smoke:providers  # provider readiness and optional live smoke checks
```

## Revenue Path

The money path is gated before any invoice is created. The gate requires transcript-backed buying interest, a read-back-confirmed customer email, no call/email opt-out, and a persisted `invoice_consent` contact event. In mock mode the same `runMailer -> paymentFlow -> AgentMail -> Stripe webhook -> builder` orchestration runs with synthetic provider IDs and URLs. In live modes, Stripe invoice creation still requires `LIVE_PAYMENTS=true` and AgentMail sending still requires `LIVE_EMAILS=true` plus the configured provider credentials.

Use `npm run check:revenue` for the deterministic synthetic proof: call analysis with confirmed email, hosted invoice row, AgentMail send, inbound reply, auto reply, idempotent Stripe paid webhook, and exactly one build.

Source docs used for this implementation:

- AgentMail Messages API for send/list/get/reply and `extracted_text`/`extracted_html`: https://docs.agentmail.to/messages
- AgentMail threaded conversations and reply-in-thread behavior: https://docs.agentmail.to/knowledge-base/threaded-conversations
- AgentMail webhook event payloads for `message.received`, `message.received.spam`, `message.received.blocked`, and `message.received.unauthenticated`: https://docs.agentmail.to/api-reference/webhooks/events/message-received
- Stripe invoice workflow transitions, hosted URL/PDF generation, and `invoice.paid`: https://docs.stripe.com/invoicing/integration/workflow-transitions
- Stripe finalize invoice API reference for `hosted_invoice_url` and `invoice_pdf`: https://docs.stripe.com/api/invoices/finalize

## Supermemory Durable Customer Memory

Supermemory is the durable customer file. The app writes every memory through `server/memory.js`, even in mock mode; mock mode swaps the live provider for a synthetic provider but still exercises the same mirror, queue, search, failure, and observability paths.

Current policy:

- `containerTag = lead:<leadId>` for per-lead isolation.
- `customId = <kind>:<leadId>:<sourceId>` for provider-side update/dedup and local idempotency.
- Memory kinds are `research_evidence`, `business_profile`, `presence_score`, `pitch`, `call_transcript`, `call_analysis`, `mail_thread`, `invoice`, `build_brief`, `build_result`, `growth_plan`, and `compliance_decision`.
- Every write mirrors into `memory_documents`, queues/retries through `memory_write_queue`, logs searches in `memory_searches`, and records provider failures in `memory_failures`.
- The operator UI Memory tab shows businesses found, per-lead ledgers, scoped retrieval hits, failed writes, and a retry action.

Routes:

```sh
GET  /api/memory/businesses
GET  /api/leads/:id/memory
POST /api/leads/:id/memory/search
POST /api/memory/retry-failed
GET  /api/memory/observability
```

Verification:

```sh
npm run check:supermemory
```

Source docs used for this implementation:

- Supermemory add/update parameters: `content`, `containerTag`, `customId`, `metadata`, `filterByMetadata`, `entityContext`, and document status tracking: https://supermemory.ai/docs/add-memories
- Supermemory container tags and metadata filters: https://supermemory.ai/docs/concepts/filtering
- Supermemory search parameters and response shape: https://supermemory.ai/docs/memory-api/searching/searching-memories

## Live Toggles

The default posture is safe and local:

```sh
RUN_MODE=mock
LIVE_CALLS=false
LIVE_EMAILS=false
LIVE_PAYMENTS=false
LIVE_BROWSER_SESSIONS=false
LIVE_PUBLIC_OUTREACH=false
LIVE_BUILDS=false
AUTONOMOUS_OUTREACH_ENABLED=false
```

Launch modes are intentionally separate:

| Mode | Calls | Emails | Invoices | Browser sessions | Public outreach | Builds |
| --- | --- | --- | --- | --- | --- | --- |
| `mock` | synthetic | synthetic | synthetic | no | no | synthetic |
| `demo_live` | allow-listed owned/seeded | allow-listed | allow-listed/consented | opt-in | no | opt-in |
| `autonomous_live` | compliance-gated business phones | compliance-gated | confirmed invoice consent | opt-in | compliance-gated | opt-in |
| `production_review` | no | no | no | no | no | no |
| `production_live` | compliance-gated | compliance-gated | confirmed invoice consent | opt-in | compliance-gated | opt-in |

`production_live` additionally requires `PRODUCTION_LIVE_ACK=I_UNDERSTAND_LIVE_OUTREACH`, `NODE_ENV=production`, a strong `ADMIN_API_TOKEN`, public `https://` `APP_PUBLIC_URL`, configured webhooks, passing provider smoke rows, and the relevant `LIVE_*` flags.

For a judge-safe live demo against owned targets only:

```sh
RUN_MODE=demo_live
ALLOWED_TARGET_PHONES=+15555550100
ALLOWED_TARGET_EMAILS=operator@example.com
LIVE_CALLS=true
LIVE_EMAILS=true
LIVE_PAYMENTS=true
LIVE_BROWSER_SESSIONS=true
LIVE_BUILDS=true
```

For autonomous outreach experiments, the repo has explicit controls:

```sh
RUN_MODE=autonomous_live
AUTONOMOUS_OUTREACH_ENABLED=true
LIVE_PUBLIC_OUTREACH=true
OUTREACH_INTERVAL_MS=15000
OUTREACH_BATCH_SIZE=1
MAX_ATTEMPTS_PER_PHONE=1
QUIET_HOURS_START=20
QUIET_HOURS_END=9
OUTREACH_TIMEZONE=America/Los_Angeles
```

Do not use `autonomous_live` for the YC demo unless the targets, disclosure, opt-out flow, and call windows have already been checked.

## Provider Smoke Commands

`npm run smoke:providers` is dry by default: it reports configured/missing providers without causing side effects. Add one `SMOKE_*` toggle and `-- --provider <name>` when you intentionally want a live check; this keeps live proof scoped to one provider at a time.

The boot schedulers also enqueue `ops.provider_posture` and `ops.recover_stuck`. Provider posture is a durable no-network refresh controlled by `OPS_PROVIDER_POSTURE_ENABLED` and `OPS_PROVIDER_POSTURE_INTERVAL_MS`; it appends fresh dry-run/config evidence for promotion review, but does not overwrite the latest live smoke row or erase live failure evidence. Stuck recovery is controlled by `OPS_RECOVERY_ENABLED` and `OPS_RECOVERY_INTERVAL_MS`; it releases expired job leases, closes stale calls with audit receipts, returns scheduled calls stuck in `placing` to `pending`, and lets the server recover paid build jobs through the builder path.

```sh
npm run smoke:providers
SMOKE_GEMINI=true npm run smoke:providers -- --provider gemini
SMOKE_SUPERMEMORY_WRITE=true npm run smoke:providers -- --provider supermemory
SMOKE_MOSS_INDEX=true npm run smoke:providers -- --provider moss
SMOKE_BROWSER_USE=true npm run smoke:providers -- --provider browserUse
SMOKE_LOVABLE_NAVIGATION=true npm run smoke:providers -- --provider lovable
SMOKE_AGENTMAIL_SEND=true SMOKE_TEST_EMAIL=operator@example.com npm run smoke:providers -- --provider agentmail
SMOKE_STRIPE_INVOICE=true SMOKE_TEST_EMAIL=operator@example.com SMOKE_STRIPE_PRICE_CENTS=100 npm run smoke:providers -- --provider stripe
SMOKE_LIVE_CALL=true SMOKE_TEST_PHONE=+15555550100 npm run smoke:providers -- --provider agentphone
```

## Production Readiness

```sh
npm run check:production
npm run check:safety
npm run drill:reliability
```

`check:production` is read-only. It reports provider configured status, webhook status, smoke status, last error, quota/cost status, blocker reasons, and the next action for every provider. It exits report-only by default unless the app is already in `production_live`; use `npm run check:production -- --strict` to make production blockers fail locally.

The readiness payload also exposes separate promotion gates for `production_review` and `production_live`. Review mode requires production credentials, a strong `ADMIN_API_TOKEN`, webhook secrets, fresh dry-run/config smoke, healthy jobs, and no live side-effect flags. Live mode requires the explicit production ack, production `NODE_ENV`, public HTTPS URL, fresh webhooks, fresh live smoke for every required provider, enabled side-effect flags, and healthy compliance/reputation/job gates.

Operator API reads and mutations accept `Authorization: Bearer $ADMIN_API_TOKEN`, `X-Admin-Token: $ADMIN_API_TOKEN`, or the console-managed same-origin admin cookie. Local mock/dev runs remain usable without a token unless `ADMIN_API_TOKEN` is set; `production_review`, `production_live`, and `NODE_ENV=production` require one before health/readiness internals, leads, jobs, ops dashboards, discovery, calls, builds, outreach controls, aftercare actions, backup, reset, export, self-check, or stuck-job recovery controls can be used. `/api/ping` is the intentionally public liveness probe; provider webhooks keep their provider signatures, customer share-link actions stay scoped to the portal token, and hosting accept/preview image routes remain scoped public links instead of operator-token routes.

Safe-to-sell also enforces economics, provider-health, and worker-health guards over the last 24h of SQLite history. Tune `OPS_MAX_DAILY_COST_USD`, `OPS_MAX_DAILY_LOSS_USD`, and `OPS_MIN_MARGIN_PCT` to set the spend ceiling, loss ceiling, and paid-work margin floor; tune `OPS_PROVIDER_MAX_ISSUE_RATE_PCT`, `OPS_PROVIDER_MIN_EVENTS_FOR_ISSUE_RATE`, and `OPS_PROVIDER_MAX_AVG_LATENCY_MS` to block launch on flaky or slow providers even when the latest row looks superficially okay. Worker/job failure budgets are controlled by `OPS_WORKER_MAX_FAILURES_24H`, `OPS_WORKER_MAX_FAILURE_RATE_PCT`, `OPS_WORKER_MIN_RUNS_FOR_FAILURE_RATE`, and `OPS_JOB_MAX_ISSUES_24H`.

Safe-to-sell reports include scheduler freshness for recurring ops jobs, so a quiet queue is not enough: backup, provider posture, stuck recovery, the daily safe-to-sell self-check, and enabled aftercare jobs need recent successful durable completions.

`npm run safe-to-sell` is the fail-closed launch check: it prints the same summary, blocker list, and next actions, then exits nonzero when Callan is not safe to sell. Use `npm run safe-to-sell -- --report-only` only when you need a red/green report without failing the surrounding shell job.

Safe-to-sell output, production-readiness reports, provider smoke CLI output, provider health events, and durable snapshots are redacted by default before they leave the process or land in SQLite. Emails, phone numbers, API keys, secrets, tokens, passwords, and host-local filesystem paths are masked while timestamps, backup filenames, and operational counters stay readable for audit/debugging.

Admin export includes a redacted SQLite operations manifest, table counts, and capped row samples by default. Mock/demo reset refuses production mode, creates a SQLite backup, deletes transient test jobs, and archives matched demo leads without deleting append-only trust-ledger receipts.

`drill:reliability` uses isolated SQLite data and no live side effects. By default it also starts a throwaway mock server on a loopback port, waits on the public `/api/ping` liveness probe, waits for the boot `ops.backup`, `ops.provider_posture`, `ops.recover_stuck`, `ops.safe_to_sell`, and `account_manager.run` jobs to complete, then verifies `/api/ping`, `/api/health`, `/api/jobs/health`, `/api/ops/command-center`, `/api/admin/export`, `/api/admin/backups`, and outreach route surfaces with GET-only requests. Use `--base-url` to check an already-running server, or `--no-server` when a port cannot be bound.

The operator console shows the same readiness in the production checklist, the "cannot go live because" panel, and emergency pause/stop controls. The pause path is `POST /api/outreach/pause`; the hard stop path is `POST /api/emergency-stop`.

Source docs used for this readiness layer:

- AgentPhone webhook HMAC, 5-minute replay window, and `X-Webhook-ID`: https://docs.agentphone.ai/documentation/guides/webhooks
- AgentPhone call-ended transcript and transcript SSE: https://docs.agentphone.ai/documentation/reference/faq
- AgentMail `event_id` events and partial payload hydration: https://docs.agentmail.to/events and https://docs.agentmail.to/overview
- Stripe invoice paid lifecycle: https://docs.stripe.com/invoicing/integration
- Browser Use session `liveUrl`, status, and cost surfaces: https://docs.browser-use.com/guides/sessions and https://docs.browser-use.com/cloud/api-v2/tasks/get-task-status
- Supermemory `containerTags` isolation: https://docs.supermemory.ai/memory-api/features/filtering
- Moss index readiness: https://docs.usemoss.dev/docs/api-reference/v1/index-management/getIndex
- Gemini structured JSON Schema output: https://ai.google.dev/gemini-api/docs/structured-output

## Operator Demo Script

1. Start with `npm run demo:e2e -- --data-dir .data/demo --reset-demo-data`.
2. Open the console with `DATA_DIR=.data/demo npm run dev`.
3. Show the lead, memory record, mock transcript, AgentMail thread, Stripe paid event, and Browser Use/Lovable build URLs.
4. Say the sponsor distinction plainly: Gemini thinks, Supermemory remembers, Moss retrieves during the call, Browser Use browses, Lovable builds, AgentPhone calls, AgentMail follows up, and Stripe invoices.
5. For a live smoke, run exactly one provider smoke command at a time with the owned phone/email values.
