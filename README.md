# callmemaybe

Agentic cold-calling web agency demo for YC judges and operators. The customer sees a service business: we find a weak-presence local business, call it, sell a website, invoice it, and start the build. The agent stack is internal; the operator console makes each step visible.

The judge-facing line is simple: we are not selling an agent, we are selling an agency. The website offer is the wedge, and the same harness can later run other services businesses.

## Sponsor Roles

| Sponsor | Role in the product | Difference that matters in the demo | Live env surface |
| --- | --- | --- | --- |
| Gemini / Google DeepMind | Reasoning brain for lead scoring, pitch generation, call analysis, AgentMail replies, and Lovable briefs. | Gemini decides and writes structured JSON. It does not call, email, browse, store memory, or take payment. | `GEMINI_API_KEY`, `GEMINI_MODEL_PRO`, `GEMINI_MODEL_FLASH`; smoke with `SMOKE_GEMINI=true`. |
| Supermemory | Durable per-customer memory, scoped by one `containerTag` per lead. | Supermemory is the long-lived customer file. It is not the low-latency in-call hot path and not lead scraping. | `SUPERMEMORY_API_KEY`; smoke writes/searches with `SMOKE_SUPERMEMORY_WRITE=true`. |
| Moss | Sub-10ms retrieval for the live voice turn. | Moss is the call-time cache for pitch chunks and objection handling. It is not web search, not scraping, and not the durable source of truth. | `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, `MOSS_BASE_URL`; live call use also needs `LIVE_CALLS=true`; smoke with `SMOKE_MOSS_INDEX=true`. |
| Browser Use | Cloud browser operator for lead research and for driving Lovable. | Browser Use is the hands in the browser: Yelp/Maps-style audits, screenshots, and the Lovable session. It is not memory or the website builder itself. | `BROWSER_USE_API_KEY`, `BROWSER_USE_BASE_URL`; builds need `LIVE_BUILDS=true`; smoke with `SMOKE_BROWSER_USE=true`. |
| Lovable | Customer-visible website build surface. | Lovable is where the site appears. Browser Use opens and drives Lovable; the app surfaces the resulting `liveUrl`. There is no direct app env key for Lovable. | Authenticated Lovable browser session for live builds; no `LOVABLE_*` env in this repo. |
| AgentPhone | Outbound voice call and transcript provider. | AgentPhone places the call. The app still owns target allow-listing, recording-disclosure copy, DNC/opt-out handling, and when to call. | `AGENTPHONE_API_KEY`, `AGENTPHONE_BASE_URL`, `AGENTPHONE_AGENT_ID`, `AGENTPHONE_DEFAULT_VOICE`, `AGENTPHONE_WEBHOOK_SECRET`, `AGENTPHONE_FROM_NUMBER`; requires `LIVE_CALLS=true` and allow-listed `ALLOWED_TARGET_PHONES` for `demo_live`; smoke with `SMOKE_LIVE_CALL=true SMOKE_TEST_PHONE=+1...`. |
| AgentMail | Customer email thread for invoice, recap, ICS handoff, and replies. | AgentMail is the persistent customer communication channel after the call. It is not the payment processor. | `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_DISPLAY_NAME`, `AGENTMAIL_WEBHOOK_SECRET`; requires `LIVE_EMAILS=true`; demo-live sends only to `ALLOWED_TARGET_EMAILS`; smoke with `SMOKE_AGENTMAIL_SEND=true SMOKE_TEST_EMAIL=...`. |
| Stripe | Hosted invoice and paid-state webhook. | Stripe turns a verbal yes into payment state. AgentMail carries the invoice URL; Stripe owns invoice/payment status. | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_USD_CENTS`, `STRIPE_PRODUCT_NAME`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`; requires `LIVE_PAYMENTS=true`; smoke with `SMOKE_STRIPE_INVOICE=true SMOKE_TEST_EMAIL=...`. |

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

## Exact Npm Scripts

These are the scripts currently declared in `package.json`:

```sh
npm run dev              # run the local Express API plus Vite operator console
npm run server           # run only the Express API
npm run demo:e2e         # seed and verify the full mocked lifecycle
npm run build            # build the Vite frontend
npm run start            # production server entrypoint
npm run check            # node --check over server/ and scripts/
npm run check:presence   # deterministic online-presence scoring check
npm run check:dedupe     # deterministic lead dedupe/history check
npm run check:autonomy   # deterministic outreach/compliance/payment recovery check
npm run smoke:providers  # provider readiness and optional live smoke checks
```

## Live Toggles

The default posture is safe and local:

```sh
RUN_MODE=mock
LIVE_CALLS=false
LIVE_EMAILS=false
LIVE_PAYMENTS=false
LIVE_BUILDS=false
AUTONOMOUS_OUTREACH_ENABLED=false
```

For a judge-safe live demo against owned targets only:

```sh
RUN_MODE=demo_live
ALLOWED_TARGET_PHONES=+15555550100
ALLOWED_TARGET_EMAILS=operator@example.com
LIVE_CALLS=true
LIVE_EMAILS=true
LIVE_PAYMENTS=true
LIVE_BUILDS=true
```

For autonomous outreach experiments, the repo has explicit controls:

```sh
RUN_MODE=autonomous_live
AUTONOMOUS_OUTREACH_ENABLED=true
OUTREACH_INTERVAL_MS=15000
OUTREACH_BATCH_SIZE=1
MAX_ATTEMPTS_PER_PHONE=1
QUIET_HOURS_START=20
QUIET_HOURS_END=9
OUTREACH_TIMEZONE=America/Los_Angeles
```

Do not use `autonomous_live` for the YC demo unless the targets, disclosure, opt-out flow, and call windows have already been checked.

## Provider Smoke Commands

`npm run smoke:providers` is dry by default: it reports configured/missing providers without causing side effects. Add one `SMOKE_*` toggle when you intentionally want a live check.

```sh
npm run smoke:providers
SMOKE_GEMINI=true npm run smoke:providers
SMOKE_SUPERMEMORY_WRITE=true npm run smoke:providers
SMOKE_MOSS_INDEX=true npm run smoke:providers
SMOKE_BROWSER_USE=true npm run smoke:providers
SMOKE_AGENTMAIL_SEND=true SMOKE_TEST_EMAIL=operator@example.com npm run smoke:providers
SMOKE_STRIPE_INVOICE=true SMOKE_TEST_EMAIL=operator@example.com SMOKE_STRIPE_PRICE_CENTS=100 npm run smoke:providers
SMOKE_LIVE_CALL=true SMOKE_TEST_PHONE=+15555550100 npm run smoke:providers
```

## Operator Demo Script

1. Start with `npm run demo:e2e -- --data-dir .data/demo --reset-demo-data`.
2. Open the console with `DATA_DIR=.data/demo npm run dev`.
3. Show the lead, memory record, mock transcript, AgentMail thread, Stripe paid event, and Browser Use/Lovable build URLs.
4. Say the sponsor distinction plainly: Gemini thinks, Supermemory remembers, Moss retrieves during the call, Browser Use browses, Lovable builds, AgentPhone calls, AgentMail follows up, and Stripe invoices.
5. For a live smoke, run exactly one provider smoke command at a time with the owned phone/email values.
