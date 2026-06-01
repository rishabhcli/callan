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

## Portfolio Operating Model

Callan now has a first durable operating-company layer underneath the lead-centric agency loop. It can bootstrap a default organization/workspace, persist territories, brands, market opportunities, service-business launch candidates, capability registry rows, vendor candidates, workflow definitions, launch surfaces, acquisition-attempt economics, and portfolio events. This is the first substrate for the May Goals north star: moving from one website-agency loop toward a portfolio of service businesses.

Operator/API surface:

```sh
GET  /api/portfolio/operating-model
POST /api/portfolio/market-opportunities/aggregate
POST /api/portfolio/market-opportunities/:id/plan-launch
POST /api/portfolio/service-businesses/:id/evaluate-gates
POST /api/portfolio/service-businesses/:id/launch
POST /api/portfolio/service-businesses/:id/acquisition-attempts
POST /api/portfolio/service-businesses/:id/refresh-acquisition-strategy
POST /api/portfolio/acquisition-actions/:id/decide
POST /api/portfolio/acquisition-actions/:id/execute
POST /api/portfolio/acquisition-actions/:id/rollback
POST /api/portfolio/acquisition-actions/:id/preflight-live
GET  /portfolio/surfaces/:id
npm run check:maygoals
```

The check runs in an isolated SQLite data directory and proves the portfolio path: existing qualified leads aggregate into a city/vertical market opportunity with deterministic competitor-weakness detection (no-website, weak online presence, missing/risky phone, low research confidence, missing source URL, callability-uncertain) persisted under `signals.competitorWeaknesses`/`competitorWeaknessSummary`, deterministic service-urgency classification (`emergency_first`/`urgent_response`/`planned_service`/`discretionary` with weighted lexicon hits, distinct keyword evidence, response-expectation minutes, pack-signal alignment, and required response evidence) persisted under `signals.serviceUrgency`, and deterministic market demand-pressure scoring (urgent search intent, exploitable competitor weakness share, no-website overlap, callable responder gap, lead density, weak-presence majority, and urgency-aligned vertical growth paths) persisted under `signals.demandPressure` with `risks.serviceUrgencyClass`/`risks.serviceUrgencyResponseRequirements`/`risks.demandPressureLevel`/`risks.demandPressureDriverKeys` and surfaced in the Portfolio opportunity row plus snapshot/export, direct city opportunity evidence can become a service-business launch candidate, safe-to-launch/fulfill/charge gates block risky launches, a green-path service can launch with a truthful acquisition surface, and acquisition attempts roll up first-customer cost, conversion, revenue, margin, channel-plan changes, learning records, scale/pause recommendations, reviewed acquisition action execution, market-level capital allocation dry-run/preflight/rollback, provider fallback workflow dry-run/preflight/rollback, workflow dead-letter replay dry-run/preflight/rollback, live-adapter preflight blocking, first-party owned-surface publication, first-party local SEO page publication, first-party directory listing publication, third-party directory dry-run/preflight/rollback, AgentPhone call-motion dry-run/preflight/rollback, AgentMail email-motion dry-run/preflight/rollback, Google Business Profile workflow dry-run/preflight/rollback, SMS motion dry-run/preflight/rollback, web chat motion dry-run/preflight/rollback, referral link motion dry-run/preflight/rollback, partnership motion dry-run/preflight/rollback, seasonal campaign dry-run/preflight/rollback, winback campaign dry-run/preflight/rollback, retargeting audience dry-run/preflight/rollback, review-request loop dry-run/preflight/rollback, quote follow-up dry-run/preflight/rollback, abandoned-invoice recovery dry-run/preflight/rollback, missed-call rescue dry-run/preflight/rollback, booking/dispatch dry-run/preflight/rollback, customer operating-room job-tracking dry-run/preflight/rollback, customer status-update dry-run/preflight/rollback, completion-proof/SLA dry-run/preflight/rollback, payout-settlement dry-run/preflight/rollback, refund/dispute dry-run/preflight/rollback, vendor-quality/backup-routing dry-run/preflight/rollback, repeat-work scheduling dry-run/preflight/rollback, and rollback with provider-specific receipts, proof, launch-surface URLs, call/email/profile/directory/SMS/chat/referral/partnership/seasonal/winback/retargeting/review-request/quote-follow-up/invoice-recovery/missed-call/dispatch/job-tracking/customer-update/completion/payout/refund-dispute/vendor-quality/repeat-work/capital-allocation/provider-fallback/workflow-replay safety proof, live-smoke blockers, payout/margin-boundary checks, target/ownership/widget/source/partner/directory/seasonal/winback/retargeting/review-request/quote-follow-up/invoice-recovery/missed-call/dispatch/job-tracking/vendor-ETA/photo-permission/status-copy/customer-visibility/portal-access/customer-update/completion/SLA/proof/customer-acceptance/vendor-invoice/refund-dispute/customer-issue/operator-approval/vendor-quality/customer-update/vendor-acceptance/SLA-reassignment/completed-service/repeat-work-offer/customer-opt-in/schedule-window/budget/operator-budget/runway/provider-incident/operator-fallback/customer-handoff/replay-scope evidence blockers, and rollback metadata. Live calls, email sends, SMS sends, web chat widget publication, referral link publication, partnership outreach, seasonal campaign publication, winback campaign sends, retargeting pixels/list uploads/audience creation/ad spend, review-request sends, quote follow-up sends/payment links/price changes, invoice recovery sends/payment-link resends/payment-status mutations/late-fee claims, missed-call rescue callbacks/voicemails/scheduled calls/emergency promises, booking/dispatch calendar reservations/vendor assignments/customer promises/field dispatches, customer tracker publication/ETA promises/photo exposure/vendor GPS sharing, customer status emails/SMS/calls/chat/job-status mutations, completion notices/review requests/payment captures/vendor payout releases, payout settlement captures/transfers/refunds/chargebacks, refund/dispute refunds/chargeback acceptance/customer notices/vendor penalties/payment mutations, live vendor reassignment, backup-vendor routing, customer/vendor status notices, SLA reassignment promises, repeat-work reminders/bookings/invoices/subscriptions/customer promises, external budget moves/ad spend/provider budget mutations, provider route changes/credential mutations/customer fallback messages, workflow replay job enqueue/handler invocation/source-job mutation, Google Business Profile mutation, third-party directory mutation, and external SEO mutations remain gated; the first-party live adapters write only Callan-owned state with zero external spend.

Market recommendation launch planning now starts the first acquisition motion automatically: `planLaunchFromMarketOpportunity` refreshes acquisition strategy for a new launch candidate, approves only the zero-spend local dry-run scope, executes the `launch_first_motion` action on the owned acquisition surface, records an `owned_surface_builder` receipt, and marks the service-business channel `launch_ready` without publishing externally or spending money. Re-running the same plan is idempotent and returns the already-executed action instead of minting duplicate receipts.

City and neighborhood demand maps now sit directly on market opportunities. `signals.cityDemandMap` groups stored lead evidence by `research_json` neighborhood/district/service-area fields or, when absent, deterministic address-derived corridors; each hotspot records demand class, hotspot score, lead share, evidence lead IDs, source URLs, representative niches, example leads, and `source: lead_evidence_city_neighborhood_demand_map`. Key fields mirror onto `risks.cityDemandTopNeighborhood`/`risks.cityDemandHotspotCount`/`risks.cityDemandMappedLeadRatio`, uncertainty bands live under `signals.confidenceIntervals.cityDemandMap`, and Portfolio rows render map/top/mapped/hotspot chips. No live maps, census, mobility, permit, weather, or external demand provider is queried during this local pass.

Neighborhood launch planning turns the demand map into the first local move. `signals.neighborhoodLaunchPlan` selects the top hotspot, recommends a launch motion from search intent, urgency, and owner responsiveness, estimates first-wave lead count and revenue from local pricing and market-sizing evidence, records proof requirements such as neighborhood evidence, service-area copy, and operator review, mirrors key fields onto `risks.neighborhoodLaunchKey`/`risks.neighborhoodLaunchMotion`/`risks.neighborhoodLaunchPriorityScore`, and renders start/motion/priority/first-wave chips in the Portfolio row. Its priority and revenue bands live under `signals.confidenceIntervals.neighborhoodLaunchPlan`; the pass does not publish externally, spend money, or create live customer promises.

Market recommendations now carry an explicit provenance ledger. `signals.marketRecommendationProvenance` links the stored lead rows, source URLs, vertical-pack rules, competitor weaknesses, urgency, demand pressure, pricing/margin inference, city demand map, and neighborhood launch plan into decision inputs, top reasons, source models, evidence chain, evidence coverage, explainability score/class, and `source: lead_evidence_market_recommendation_provenance`. Key fields mirror onto `risks.marketRecommendationExplainabilityScore`/`risks.marketRecommendationTopReasonKeys`/`risks.marketRecommendationEvidenceRequired`; Portfolio rows render why/explained/proof/reason chips; and false-positive learning updates the provenance decision so later `watch` or `avoid` recommendations stay explainable instead of preserving stale launch reasoning.

Service-business launch candidates now inherit a provenance-derived trust asset plan. `readiness.trustAssetPlan` is built from the opportunity provenance, pricing evidence, neighborhood launch plan, formation/permit signals, vertical-pack trust requirements, and offer policy, then lists required trust/proof assets such as trust page, privacy notice, refund policy, pricing disclosure, service-area proof, and license/restricted-claim review. The same plan is attached to the `trust-and-compliance-review` capability, appears in launch readiness missing keys, and renders in Portfolio as trust-assets/evidence/area/asset-status chips. These assets are drafts only: public claims, external publication, live promises, price guarantees, emergency guarantees, and regulated-service claims remain blocked until operator approval and launch gates pass.

Booking flow setup now starts as a first-party draft instead of a live calendar mutation. `readiness.bookingFlowPlan` and `channels.bookingFlow.plan` derive the service-area check, problem intake, urgency triage, contact permission, price-boundary acknowledgement, and operator-review steps from the neighborhood launch plan, search intent, pricing evidence, offer packages, and trust assets. The plan records required setup keys, intake fields, evidence, source URLs, and hard boundaries: no external booking, no calendar reservation, no customer promise, no vendor dispatch, and no emergency-response commitment until provider smoke, phone/inbox setup, calendar adapter proof, and operator approval exist. Portfolio renders booking/live-booking/area/steps/fields/step-status chips for each launch candidate.

Service menu generation is also evidence-derived now. `readiness.serviceMenuPlan`, `offer.serviceMenuPlan`, and `channels.serviceMenu.plan` combine the vertical-pack offer, local pricing/margin inference, selected neighborhood, booking-flow steps, and trust assets into draft menu sections and package drafts. Each package records area fit, price evidence, booking-step alignment, margin context, proof requirements, and public-price/public-menu blocks. A `service-menu-draft` capability carries the same plan, Portfolio renders menu/public-menu/price/package chips, and no payment link, public menu page, discount, quote, or customer-facing price promise is created by the draft.

Phone number and inbox provisioning are planned without faking live resources. `readiness.communicationProvisioningPlan` and `channels.communicationProvisioning.plan` define the AgentPhone local-number requirements, AgentMail inbox requirements, recording-disclosure/DNC/quiet-hours/opt-out/privacy policies, routing rules for booking intake, missed-call follow-up, and quote/policy recap, plus provider-link and operator-approval blockers. The inbound call and owner inbox channels carry their provisioning subplans, Portfolio renders comms/live-comms/phone/inbox/routing chips, and the plan explicitly avoids reserving numbers, creating inboxes, sending emails, placing calls, recording calls, or promising response times before live provider proof exists.

Local domain strategy is now evidence-derived too. `readiness.localDomainStrategyPlan` and `channels.localDomain.plan` generate owned-domain candidates, a Callan-local draft URL, a route path, DNS/TLS/email-authentication work, and proof blockers from the launch brand, city, vertical, neighborhood, trust assets, booking flow, service menu, and phone/inbox plan. A `local-domain-strategy-plan` capability carries the same plan, Portfolio renders domain/registration/DNS/primary/path chips, and registration, DNS mutation, certificate issuance, external publication, local ownership claims, and customer-facing domain promises stay blocked until availability, ownership, brand-conflict, NAP, SSL, provider-link, and operator approvals exist.

Launch readiness plans now roll up into operator work items. `readiness.launchReadinessWorkItemPlan` and `channels.launchReadiness.plan` turn trust assets, booking flow, service menu, phone/inbox, local domain strategy, and the vertical-manifest checklist into a six-item runbook for trust proof, intake copy, offer approval, communications provider proof, domain proof, and the final operator launch gate. A `launch-readiness-work-items` capability carries the same runbook, Portfolio renders work-items/live-work/blocked/draft/item-status chips, and the plan records only local tasks: it does not enqueue external jobs, mutate providers, publish surfaces, reserve domains, call customers, send messages, dispatch vendors, or spend money before launch gates pass.

Service-script drafts now cover the first human and customer touchpoints. `readiness.serviceScriptPlan` and `channels.serviceScripts.plan` generate blocked drafts for AgentPhone phone intake, AgentMail quote recap, SMS status updates, web-chat intake, and human subcontractor dispatch handoff from the booking flow, service menu, phone/inbox plan, local domain strategy, and launch work items. A `service-script-drafts` capability carries the same draft set, Portfolio renders scripts/live-scripts/messages/vendors/channel-status chips, and the plan stores only internal copy: it does not send messages, place calls, start chats, expose customer data, assign vendors, publish widgets, or promise response times before provider proof and operator approval.

Region and restricted-advice policy planning is now part of each launch candidate. `readiness.serviceCompliancePolicyPlan` and `channels.compliancePolicy.plan` combine the city/source evidence, vertical-pack restricted claims, required disclosures, trust assets, communication plan, and script plan into operator-review policy drafts for jurisdiction verification, license/permit claims, communications disclosures, and vertical-specific claim boundaries. A `service-compliance-policy-plan` capability carries the same plan, Portfolio renders policy/live-claims/region/restricted/rule-status chips, and legal, license, emergency, rebate, financing, warranty, scope, or disclosure claims stay blocked until proof and operator approval exist.

Provider-unavailable launches now get an explicit sandbox path instead of fake success. `readiness.providerSandboxOrchestrationPlan` and `channels.providerSandbox.plan` list AgentPhone, AgentMail, SMS, web-chat, DNS, and vendor-pool providers, record each missing live-provider blocker, and map each one to a local dry-run workflow such as phone script rehearsal, email template rendering, SMS copy validation, chat handoff simulation, DNS-record plan validation, or subcontractor packet simulation. A `provider-sandbox-orchestration` capability carries the same plan, Portfolio renders sandbox/live-providers/providers/blockers/provider-status chips, and mock receipts are never treated as live smoke, provider mutation, customer contact, DNS publication, vendor assignment, or spend.

Customer operating rooms now start as a cross-service launch plan. `readiness.customerOperatingRoomPlan` and `channels.customerOperatingRoom.plan` define blocked workflows for booking management, job tracking, vendor ETA, photos/completion proof, and review requests from the booking flow, service menu, scripts, policy, and provider sandbox plans. A `customer-operating-room-plan` capability carries the same workflow set, Portfolio renders room/portal/workflows/visible/workflow-status chips, and no portal, booking, job-status mutation, ETA promise, proof/photo exposure, review request, or customer-visible timeline appears before privacy, dispatch, vendor, review-policy, live-smoke, and operator approvals exist.

Customer-room privacy controls now get their own local receipt before any portal can become visible. `portfolio_customer_privacy_control_receipts` records the job/customer/contact scope, opt-out copy requirement, privacy notice, token-scoped access, data minimization, photo-redaction boundary, vendor-GPS boundary, and operator approval blockers while proving no portal publication, customer message, customer-data exposure, photo exposure, vendor-GPS sharing, or job-status mutation occurred. Portfolio renders privacy-control receipt counts next to the customer operating-room plan.

Operator supervision now has a launch-candidate plan instead of scattered blocker lists. `readiness.operatorSupervisionPlan` and `channels.operatorSupervision.plan` derive universal inbox lanes, escalation playbooks, training labels, unassigned team roles, bulk-review batches, and performance metrics from launch work items, scripts, policy, provider sandbox, and customer-room blockers. A `operator-supervision-plan` capability carries the same plan, Portfolio renders operator/inbox/lanes/escalations/labels/lane-status chips, and the plan does not assign staff, bulk-approve cases, assist live calls, message customers, or clear blockers without explicit operator action.

Operator inbox work is now durable local state rather than only plan JSON. New launch candidates create `portfolio_operator_inbox_items` for launch readiness, customer communications, compliance policy, provider sandbox, customer room, and vertical lifecycle blockers; `portfolio_operator_action_receipts` records reviewed and resolved operator actions with proof that live side effects, provider mutations, customer messages, and external publication stayed blocked. The Portfolio row shows the open durable inbox count alongside the operator plan, while actual staffing, live call assist, customer contact, provider changes, and blocker clearance still require explicit reviewed actions.

Operator handoff now groups durable inbox rows into local role queues. `portfolio_operator_assignment_queues` materializes open inbox work by launch operator, customer success, compliance reviewer, and provider ops, while `portfolio_operator_bulk_review_receipts` records bulk-review decisions and proposed handoff evals without resolving items, assigning staff, contacting customers, mutating providers, publishing externally, or performing live side effects.

Operator handoff eval closeout turns reviewed handoffs into durable learning artifacts without pretending the blockers are solved. `portfolio_operator_handoff_eval_closeouts` accepts a bulk-review receipt's proposed `operator_handoff_eval`, marks the linked learning record as `accepted_eval_artifact`, records the eval key, lane evidence, and local-only proof, and keeps inbox resolution, customer messaging, provider mutation, staffing mutation, external publication, and live side effects blocked. The Portfolio operator desk renders each queue's eval state and exposes an `eval closeout` action after bulk review.

Accepted handoff evals now have an explicit executable-publication gate. `portfolio_eval_publication_receipts` turns an accepted local eval artifact into a proposed eval manifest, but records `blocked_publication` until operator publication approval, eval-harness binding, regression fixture review, CI write access, and a live adapter exist. The Portfolio operator desk exposes a `publication gate` action and renders the resulting executable-publication blocker without writing test files, mutating CI, publishing externally, resolving inbox rows, or performing live side effects.

Executable-eval fixture work now queues locally behind that publication gate. `portfolio_eval_fixture_work_items` creates fixture-spec, harness-binding, regression-review, and CI-publication-gate work items from a blocked publication receipt, while proving no test file was written, no harness executed, no CI workflow mutated, no live adapter was invoked, and no executable eval was published. The Portfolio operator desk exposes a `fixture work items` action and renders the queued fixture/harness blockers before any eval can become executable.

Fixture runner dry-runs are receipt-backed too. `portfolio_eval_fixture_runner_receipts` consumes the queued fixture/harness work items, records the proposed non-live runner command and required work-kind coverage, and keeps executable publication blocked until operator fixture approval, golden fixture review, non-live runner binding, executable eval file review, CI write access, and live-adapter proof exist. It proves no harness executed, no test file was written, no CI workflow mutated, no live adapter was invoked, no provider/customer side effect happened, and no executable eval was published.

Operator fixture approval is now durable and local-only. `portfolio_eval_fixture_approval_receipts` records that a runner dry-run has been reviewed and approved for non-live fixture use, but still blocks executable eval publication behind golden fixture review, non-live runner binding, executable eval file review, CI write access, and live-adapter proof. The receipt proves no harness execution, test write, CI mutation, live adapter invocation, provider mutation, customer message, external publication, or live side effect happened.

Golden fixture review is now a receipt instead of an implied checklist item. `portfolio_eval_golden_fixture_review_receipts` records operator acceptance of local golden fixture evidence after fixture approval, then keeps executable publication blocked behind non-live runner binding, executable eval file review, CI write access, and live-adapter proof. The receipt proves no executable eval publication, harness execution, test-file write, CI workflow mutation, live adapter invocation, provider mutation, customer message, external publication, or live side effect happened.

Non-live runner binding now has its own receipt. `portfolio_eval_non_live_runner_binding_receipts` binds an accepted golden fixture to the proposed non-live runner manifest from the fixture dry-run while keeping executable publication blocked behind executable eval file review, CI write access, and live-adapter proof. The receipt proves no runner command executed, no harness ran, no test file was written, no CI workflow changed, no live adapter was invoked, and no provider/customer side effect happened.

Executable eval file review is now manifest-backed without touching the filesystem. `portfolio_eval_file_dry_run_manifests` records the proposed eval file path, non-live runner command, expected coverage, assertions, and remaining CI/live-adapter blockers from a non-live runner binding, but explicitly keeps file writes, test writes, runner execution, harness execution, CI workflow mutation, live adapter invocation, external publication, provider mutation, customer messaging, and live side effects blocked.

CI write-access proof is now durable instead of implied. `portfolio_eval_ci_write_access_receipts` consumes the eval file dry-run manifest, records the proposed GitHub Actions workflow path, command, required repo-write/operator/branch-protection proof, and current blocked CI state, while proving no workflow file was mutated, no CI write was attempted, no eval/test file was written, no runner command executed, no executable eval published, no live adapter invoked, and no provider/customer side effect occurred.

Live-adapter readiness is now durable instead of guessed. `portfolio_eval_live_adapter_readiness_receipts` consumes the CI write-access proof receipt, records the required live-adapter interfaces and implementation proof, and keeps executable publication blocked while proving no live adapter was invoked, no adapter mutation was allowed, no runner command or harness ran, no eval/test file was written, no workflow changed, and no provider/customer side effect occurred.

Live-adapter contract tests now convert that readiness review into local implementation proof without touching CI or providers. `portfolio_eval_live_adapter_contract_test_receipts` consumes a readiness receipt and a passing in-process `operator_handoff_eval_live_adapter` contract result from `server/handoff.js` fixtures, records legal/refund/consent/provider/payment handoff assertions, marks the adapter as locally implemented/test-backed, and still blocks executable publication on real CI write access while proving no live adapter invocation, provider mutation, customer message, eval/test file write, runner command, workflow mutation, or external side effect occurred.

The same contract now has a repo-native executable path. `npm run check:eval-adapter-contract` runs `scripts/generated-evals/operator_handoff_customer_success.check.js`, which executes the in-process contract runner and fails if any golden handoff fixture, non-mutating proof, or no-external-provider assertion regresses. `npm run check:ci` mirrors the CI gate locally, and `.github/workflows/callan-evals.yml` wires that contract into GitHub Actions alongside syntax checks, production evals, handoff checks, and the May Goals ledger.

CI workflow publication now has its own receipt instead of living only in repo files. `portfolio_eval_ci_workflow_publication_receipts` consumes a passing live-adapter contract-test receipt, verifies the local GitHub Actions workflow, generated eval artifact, package script, and local CI mirror command, records file hashes/evidence, and keeps external CI execution unobserved and blocked while proving no runner command, live adapter invocation, provider mutation, customer message, workflow mutation, or live side effect occurred.

Generated eval promotion now has durable approval state after local CI workflow publication. `portfolio_eval_generated_artifact_promotion_receipts` rechecks the workflow, generated eval artifact, package scripts, and recorded hashes, then promotes the generated eval for external CI review while keeping external CI results uningested, pull requests unopened, merges blocked, providers untouched, customers unmessaged, and live side effects false.

PR merge proposal gating is local and receipt-backed too. `portfolio_eval_pr_merge_proposal_receipts` consumes a generated eval promotion receipt, prepares the local diff review packet for the workflow, generated eval, and package scripts, and keeps pull request opening, external CI result ingestion, merge approval, runner execution, provider mutation, customer messaging, and live side effects blocked.

PR open simulation is the next local-only handoff. `portfolio_eval_pr_open_simulation_receipts` consumes a PR merge proposal receipt, prepares the `gh pr create --draft --fill` payload that an operator could submit later, and records `pullRequestSubmitted: false` so GitHub mutation, external CI results, merge approval, runner execution, provider mutation, customer messaging, and live side effects remain blocked.

Operator merge approval review is also receipt-backed and deliberately non-approving until real prerequisites exist. `portfolio_eval_operator_merge_approval_receipts` consumes a PR open simulation receipt, records that the operator merge decision was reviewed, and keeps `operatorMergeApproved: false` and `mergeAllowed: false` until there is a submitted pull request, a passing external CI result, and explicit operator approval evidence.

Submitted PR evidence is tracked as a separate local receipt rather than pretending the app opened GitHub itself. `portfolio_eval_submitted_pr_evidence_receipts` consumes the blocked operator merge approval review, records an operator-provided GitHub pull request URL, and keeps GitHub mutation, external PR verification, external CI result ingestion, operator merge approval, merge execution, provider mutation, customer messaging, and live side effects blocked.

PR external verification reconciliation has its own local gate after submitted PR evidence. `portfolio_eval_pr_external_verification_receipts` consumes the submitted PR evidence receipt, validates and reconciles the stored GitHub PR URL/evidence shape, and explicitly records that no GitHub API call, PR mutation, external PR verification, external CI result ingestion, merge approval, merge execution, provider mutation, customer message, or live side effect happened.

External CI result ingestion is a local/operator-provided receipt instead of a runner trigger. `portfolio_eval_external_ci_result_receipts` consumes a PR external verification receipt, records a passing CI provider/run URL/status supplied by an operator, marks `externalCiResultIngested: true`, and still keeps GitHub API verification, PR mutation, runner execution, operator merge approval, merge execution, provider mutation, customer messaging, and live side effects blocked.

GitHub PR verification now has a preflight receipt instead of being implied by PR and CI evidence. `portfolio_eval_github_pr_verification_receipts` consumes the external CI result receipt, derives the exact GitHub Pulls API URL for the submitted PR, records that a live GitHub API observation is still required, and keeps GitHub API calls, PR mutation, external PR verification, operator merge approval, merge execution, provider mutation, customer messaging, and live side effects blocked until a later verified integration exists.

GitHub PR observation now has a non-mutating adapter-contract receipt before any live GitHub read is trusted. `portfolio_eval_github_pr_observation_receipts` consumes the GitHub PR verification preflight, runs the in-process GitHub Pulls API fixture contract, records parser readiness and fixture observation proof, and still keeps live GitHub API observation, PR mutation, external PR verification, operator merge approval, merge execution, provider mutation, customer messaging, and live side effects blocked.

GitHub check-run observation now has a read-only receipt after the PR observation contract. `portfolio_eval_github_check_run_observation_receipts` records check-run shape and status; without `GITHUB_TOKEN` it falls back to `sandbox_fixture` evidence and keeps `githubApiCalled`, live observation, external PR verification, operator merge approval, merge execution, provider mutation, customer messaging, and live side effects false. With `GITHUB_TOKEN`, the route performs read-only GitHub Pulls/check-runs reads and still blocks merges until operator approval.

Merge execution adapter contracts now have their own proof packet before any completion gate can pretend a merge is possible. `portfolio_eval_merge_execution_adapter_contract_receipts` consumes the check-run observation chain, records the sandbox merge-adapter contract shape and merge API URL, and keeps adapter mutation, GitHub mutation, `mergeAllowed`, `mergeExecuted`, and live side effects false until a real-token live merge attempt is explicitly authorized.

Operator merge completion gating now has its own local receipt after check-run observation. `portfolio_eval_operator_merge_completion_gate_receipts` consumes the check-run observation chain, records that the completion gate was reviewed, rejects sandbox check-run evidence as operator approval, and keeps `operatorMergeApproved`, `mergeAllowed`, `mergeExecuted`, GitHub mutation, provider mutation, customer messaging, and live side effects false until live GitHub proof, explicit operator approval, and a merge execution adapter exist.

Live merge authorization now has a final local preflight receipt after the completion gate. `portfolio_eval_live_merge_authorization_receipts` records the merge-adapter contract receipt, merge API URL, missing real-token authorization, required GitHub token scopes, a symbolic token-scope proof with zero observed scopes, a local branch-protection policy template, required status-check names, branch-protection readback blockers, missing live token-scope observation, and missing live GitHub proof while keeping merge authorization, `mergeAllowed`, `mergeExecuted`, GitHub mutation, and live side effects false.

Branch-protection readback now has its own read-only adapter contract. `portfolio_eval_branch_protection_readback_adapter_contract_receipts` hangs off the live merge authorization receipt, records the branch-protection API URL, token-scope readback shape, required checks/reviews/admin enforcement/restrictions contract, and proves the adapter shape without calling GitHub, reading a real token, mutating protection rules, allowing a merge, executing a merge, or creating live side effects. The parent live-merge authorization receipt drops the local `branch_protection_readback` blocker only after that contract receipt exists, while `branch_protection_review`, live token-scope observation, real-token authorization, and live merge execution remain blocked.

Token-scope observation has the matching local contract. `portfolio_eval_token_scope_observation_adapter_contract_receipts` is recorded only after the branch-protection readback contract, captures the symbolic live-merge token identifier, required scopes, zero present scopes, missing scopes, and token-scope observation endpoint, and proves no token was read, stored, logged, mutated, or used for GitHub I/O. The parent live-merge authorization receipt drops the local `live_token_scope_observation` blocker only after this tokenless contract exists, while real-token authorization and live merge execution remain blocked.

Secret redaction proof now closes the tokenless path with durable persistence evidence. `portfolio_eval_secret_redaction_proof_receipts` hangs off the token-scope observation contract, runs synthetic GitHub classic, GitHub fine-grained, Stripe live-secret, and webhook-secret fixtures through the receipt redactor, and stores only `[redacted:*]` samples plus counts, kinds, and scan results. It proves raw token persistence, token echoing, token value storage, live GitHub calls, GitHub mutation, merge allowance, merge execution, and live side effects all stayed false across the receipt, snapshot, export, and Portfolio UI surfaces.

Merge-queue readback now has its own local adapter contract after secret redaction. `portfolio_eval_merge_queue_readback_adapter_contract_receipts` records the expected GitHub rulesets/merge-queue shape, required status checks, target branch, and API URLs without calling GitHub, mutating branch protection, enabling the queue, allowing a merge, executing a merge, or creating live side effects. The parent live-merge authorization and learning record can show the contract was reviewed while `live_merge_queue_readback`, real-token authorization, and live merge execution remain blocked.

Merge-queue live-read reconciliation now makes that boundary explicit. `portfolio_eval_merge_queue_live_read_reconciliation_receipts` hangs off the local readback contract, accepts the local ruleset shape for preflight context, and records that no real token was observed, no live GitHub API read was attempted, no live read succeeded, the merge queue was not live-verified, and merge execution remains blocked until real-token authorization and live readback exist.

Merge-queue live-read adapter contracts define the future live boundary without crossing it. `portfolio_eval_merge_queue_live_read_adapter_contract_receipts` hang off the reconciliation receipt, declare required token scopes, the GitHub rulesets GET contract, expected readback fields, target branch, and status-check shape while proving no token was read, no GitHub API call happened, no live read succeeded, no queue was live-verified, and no merge or branch-protection mutation occurred.

Guarded merge-queue live-read readiness packets now sit one step closer to production without crossing the credential boundary. `portfolio_eval_merge_queue_live_read_readiness_receipts` declare the required secret reference, token scopes, operator approvals, rulesets URL, target branch, and status-check shape while proving no token value was included or persisted, no live GitHub read was attempted, no queue was live-verified, and merge execution remains blocked.

Merge-queue credential handoff is now reference-only and auditable. `portfolio_eval_merge_queue_credential_handoff_receipts` hang off the readiness packet, declare the secret-store reference, custody requirements, operator approvals, rotation plan, and revocation plan, and prove no secret value was included, persisted, logged, echoed, used for GitHub I/O, or allowed to advance merge execution.

Merge-queue live-read preflight envelopes now define the exact future GitHub request without sending it. `portfolio_eval_merge_queue_live_read_preflight_receipts` hang off credential handoff, capture the GET method, rulesets endpoint, runtime secret reference, authorization-header shape, GitHub API version, conditional request header, and required token scopes while proving no authorization header was materialized, no token value was included or logged, no HTTP request was sent, no live read succeeded, and no merge was allowed.

Merge-queue token materialization now has a quarantine receipt before any runtime release can occur. `portfolio_eval_merge_queue_token_quarantine_receipts` hang off the live-read preflight envelope, record the memory-only quarantine policy, release gates, rollback plan, and runtime secret reference while proving no token was materialized, persisted, logged, placed into an authorization header, used for HTTP, or allowed to advance merge execution.

Merge-queue live-read response ingestion now has a guarded operator-evidence receipt. `portfolio_eval_merge_queue_live_read_response_ingestion_receipts` hang off token quarantine, preserve operator-supplied ruleset response details, observed status, ETag, ruleset IDs, and required checks while proving the receipt did not send GitHub HTTP, materialize tokens, claim live-read success, verify merge queue live state, or execute a merge.

Merge-queue runtime token release now has a fail-closed gate receipt before any secret can be materialized. `portfolio_eval_merge_queue_runtime_token_release_gate_receipts` hang off response ingestion, record the release checklist, required operator acknowledgement, required secret-provider smoke, denied reasons, and runtime secret reference while proving no token was released, persisted, logged, placed in an authorization header, used for HTTP, or allowed to advance merge execution.

Merge-queue live-read verification promotion now has a guarded queue receipt. `portfolio_eval_merge_queue_live_read_verification_promotion_receipts` hang off the runtime token release gate, record the promotion checklist and future live-verification plan while proving the app did not promote live verification, call GitHub, send HTTP, verify merge queue live state, or execute a merge.

Merge-queue live HTTP execution preflight now has a handoff receipt. `portfolio_eval_merge_queue_live_http_execution_preflight_handoff_receipts` hang off live-read verification promotion, record the operator release acknowledgement requirement, runtime secret-provider smoke requirement, request method, runtime secret reference, and future single GitHub ruleset GET plan while proving no token was released, materialized, persisted, logged, placed into an authorization header, used for HTTP, or allowed to execute a merge.

Merge-queue live HTTP operator release acknowledgement now has a fail-closed receipt. `portfolio_eval_merge_queue_live_http_operator_release_ack_receipts` hang off the live HTTP execution preflight handoff, record the operator risk acknowledgement and release scope for the future single GitHub ruleset GET while proving runtime secret smoke is still required and no token was approved for release, released, materialized, persisted, logged, placed into an authorization header, used for HTTP, or allowed to execute a merge.

Merge-queue runtime secret-provider smoke readiness now has a fail-closed receipt. `portfolio_eval_merge_queue_runtime_secret_provider_smoke_readiness_receipts` hang off the live HTTP operator release acknowledgement, record the runtime secret reference, dry-run smoke command, redaction guardrail, and future release plan while proving no secret value was observed, no smoke was executed or passed, no token was approved for release, and no GitHub HTTP or merge execution occurred.

Merge-queue runtime secret-provider smoke execution now has a fail-closed gate receipt. `portfolio_eval_merge_queue_runtime_secret_provider_smoke_execution_gate_receipts` hang off the runtime secret-provider smoke readiness receipt, record the blocked live-smoke boundary and denial reasons while proving no smoke was attempted, no secret value was observed, no token was released, and no GitHub HTTP or merge execution occurred.

Merge-queue runtime secret-provider smoke evidence review now has a fail-closed receipt. `portfolio_eval_merge_queue_runtime_secret_provider_smoke_evidence_review_receipts` hang off the smoke execution gate, record the successful-smoke evidence requirements and missing-proof findings while proving no smoke success was verified, no secret value was observed, no token was released, and no GitHub HTTP or merge execution occurred.

Merge-queue memory-only runtime token release preflight now has a fail-closed receipt. `portfolio_eval_merge_queue_memory_only_runtime_token_release_preflight_receipts` hang off the smoke evidence review, record the memory-only token requirements and denial reasons while proving successful smoke evidence is still absent, token release is not allowed, no token was materialized, no authorization header was built, and no GitHub HTTP or merge execution occurred.

Merge-queue successful smoke evidence ingestion now has a fail-closed rejection receipt. `portfolio_eval_merge_queue_successful_smoke_evidence_ingestion_receipts` hang off the memory-only runtime token release preflight, record submitted smoke-evidence payloads, reject fake success claims that are not backed by a runtime secret-provider execution receipt, and keep token release, authorization headers, GitHub HTTP, and merge execution blocked.

Merge-queue runtime token release denial now has a fail-closed receipt. `portfolio_eval_merge_queue_runtime_token_release_denial_receipts` hang off rejected smoke-evidence ingestion, record denied runtime token release requests, and prove no token was approved, materialized, persisted, logged, transformed into an authorization header, used for GitHub HTTP, or allowed to execute a merge.

Merge-queue fake live-read replay quarantine now has a fail-closed receipt. `portfolio_eval_merge_queue_fake_live_read_replay_quarantine_receipts` hang off runtime token release denials, record replayed fake live-read payload attempts, quarantine them from promotion, and prove no replayed response was accepted, no token release reopened, no GitHub HTTP was sent, no live verification was promoted, and no merge execution occurred.

Merge-queue final blocker ledgers now have a fail-closed receipt. `portfolio_eval_merge_queue_final_blocker_ledger_receipts` hang off fake live-read replay quarantines, seal the required blocker list after replay quarantine, and prove token release, authorization headers, GitHub HTTP, live verification, merge allowance, and merge execution all remain closed.

Merge-queue post-ledger operator release attestations now have a fail-closed receipt. `portfolio_eval_merge_queue_post_ledger_operator_release_attestation_receipts` hang off final blocker ledgers, record the operator's release request and blocked attestation, and prove human release cannot override sealed blockers into token release, GitHub HTTP, live verification, or merge execution.

Post-attestation release escrow receipts now preserve that block after the operator request is recorded. `portfolio_eval_merge_queue_post_attestation_release_escrow_receipts` hang off post-ledger release attestations, hold the release in local review, and prove the escrow cannot materialize tokens, authorization headers, GitHub HTTP, live verification promotion, merge approval, or merge execution.

Release denial closeout receipts now seal the held escrow into a final local denial. `portfolio_eval_merge_queue_release_denial_closeout_receipts` hang off post-attestation release escrows, record the release denial reasons and remediation actions, and prove the denial still cannot materialize tokens, authorization headers, GitHub HTTP, live verification promotion, merge approval, or merge execution.

The operator snapshot now also derives a read-only merge-queue consolidated blocker audit from the existing receipt chain. `evalMergeQueueConsolidatedBlockerAudits` groups the escrow, attestation, final blocker ledger, authorization, and learning receipt provenance into one safety view with deduped blocker codes, explicit missing-receipt warnings, and release-blocking restore-or-replay remediation actions, without adding a new mutation path.

Ops exports include the same consolidated blocker audits as redacted derived evidence. `portfolioEvalMergeQueueConsolidatedBlockerAudits` appears in the export payload and redaction manifest so downstream operators can inspect receipt-backed blockers without exposing raw tokens or adding live side effects.

The export audit builder is also covered by a missing-ancestry fixture: when an escrow receipt is present but its parent attestation, final ledger, or authorization rows are absent from the export context, the derived audit returns a deterministic warning view with restore-or-replay remediation actions instead of silently treating the blocker chain as complete.

Individual inbox claims are also receipt-backed and local-only. `portfolio_operator_inbox_assignments` records claim/release/lease-expiry state for an inbox item, rejects duplicate active claims and live-mode claims, writes `claim_item`/`release_item`/`expire_claim` action receipts, and keeps blocker resolution, staffing mutation, customer contact, provider mutation, and external publication blocked until a later explicit workflow exists.

The Portfolio tab now includes an Operator Queue panel that groups those role queues into an operator desk with refresh, claim-next, release-claim, lease-expiry, bulk-review, eval-closeout, publication-gate, fixture-work-item, runner-dry-run, fixture-approval, golden-fixture-review, non-live-runner-binding, eval-file-manifest, CI-write-proof, live-adapter-proof, adapter-contract-test, CI-workflow-publish, promote-eval, PR-merge-gate, PR-open-simulation, merge-approval-review, submitted-PR-evidence, PR-verification-reconcile, external-CI-result, GitHub-PR-check, GitHub-PR-observe, GitHub-check-runs, and merge-completion-gate controls. Each control calls the same local-only receipt APIs and keeps staffing changes, customer contact, provider mutation, blocker resolution, executable eval publication, external live-adapter invocation, test-file writes, eval-file writes, CI mutation, CI workflow writes, runner command execution, external CI execution, app-side external CI verification, pull request submission/mutation, GitHub API PR verification, live GitHub PR observation, operator merge approval, merges, and external publication blocked. The same desk also renders workflow dead-letter replay receipts from `workflow_replay_receipts`, including dry-run/live-preflight/rollback status, source-job dead-letter proof, job-enqueued blockers, operator replay approval, and live-adapter blockers before any replay can touch workflow state.

Operator queue staffing analytics are now receipt-backed too. `portfolio_operator_staffing_analytics_receipts` measures each role queue against local SLA targets, open items, active claims, expired claims, overdue item age, recommended operator count, and staffing gap count, while proving it did not assign staff, message customers, mutate providers, publish externally, or perform live side effects. The Portfolio operator desk renders SLA target, overdue, staff coverage, and gap chips for the latest local receipt.

Provider quality and selection now has a local scorecard plan. `readiness.providerQualitySelectionPlan` and `channels.providerQuality.plan` score AgentPhone, AgentMail, SMS, web-chat, DNS, and vendor-pool provider candidates across availability, latency, cost, freshness, failure history, tenant scope, region fit, and service fit, then require tenant/region/service/cost/freshness/failure-history rules before live routing. A `provider-quality-selection-plan` capability carries the same scorecards, Portfolio renders provider-quality/live-routing/providers/selectable/provider-status chips, and no credential migration, live routing, automatic provider choice, or provider API call happens before live history and operator approval.

Provider migration now has a safe local runbook. `readiness.providerMigrationPlan` and `channels.providerMigration.plan` stage provider-link inventory, quality-scorecard comparison, sandbox fallback, credential cutover preparation, parallel smoke, operator migration gate, and rollback closeout for every provider candidate. A `provider-migration-plan` capability carries the same runbook, Portfolio renders migration/live-migration/steps/rollback/step-status chips, and credentials, routes, secrets, provider APIs, customer handoffs, and automatic cutover remain untouched until backup, smoke, rollback, customer-impact review, and operator approval exist.

Product telemetry and work generation now start as reviewed internal plans. `readiness.productTelemetryPlan` and `channels.productTelemetry.plan` define draft streams for product telemetry, feature bottlenecks, operator frustration, customer confusion, broken workflows, and missing integrations, then map repeated patterns into draft bug reports, eval cases, product specs, migration plans, and regression-proofing checks. A `product-telemetry-work-generation-plan` capability carries the same plan, Portfolio renders telemetry/live-telemetry/streams/artifacts/stream-status chips, and customer telemetry capture, artifact publication, PR proposal, and automatic work creation remain blocked until privacy and operator review gates exist.

Acquisition expansion now has a local M&A workflow plan. `readiness.acquisitionExpansionPlan` and `channels.acquisitionExpansion.plan` derive business performance diagnosis, revenue uplift estimate, operational gap report, target scoring, owner outreach, LOI workflow, due diligence checklist, data-room intake, integration planning, transition playbooks, brand preservation, and post-acquisition automation rollout from market provenance and launch plans. A `acquisition-expansion-plan` capability carries the same plan, Portfolio renders acquisition/owner-outreach/target-score/workflow/diagnostic chips, and owner contact, LOIs, data-room access, acquisition decisions, customer/vendor migration, and post-acquisition automation remain blocked until consent, legal, privacy, and operator approvals exist.

Operating health now starts as a proof-first launch plan instead of a readiness slogan. `readiness.operatingHealthPlan` and `channels.operatingHealth.plan` define customer SLA health, vendor SLA health, vertical health, provider fabric, deterministic-check evidence, durable-state evidence, operator-visible evidence, and customer-visible evidence gates. A `operating-health-plan` capability carries the same health checks, Portfolio renders health/readiness-claim/check/evidence/score chips, and readiness claims, SLA promises, provider routing acceleration, vertical scaling, and customer-visible health claims stay blocked until durable receipts and operator review exist.

Continual learning now has a launch-candidate model for objections and cohorts. `readiness.continualLearningPlan` and `channels.continualLearning.plan` define a durable objection taxonomy for price, trust, timing, urgency mismatch, proof gaps, scope confusion, competitor preference, and no response, plus cohort models for market launches, acquisition channels, customer segments, provider quality, and pricing offers. A `continual-learning-plan` capability carries draft eval/postmortem/strategy artifacts, Portfolio renders learning/auto-strategy/objection/cohort/artifact chips, and strategy rewrites, eval publication, price changes, follow-up timing changes, and cohort routing remain blocked until reviewed outcome evidence exists.

The starter vertical catalog now spans more than the original local trades. The pack loader validates business-manifest JSON for website agency, local SEO, review capture, booking/contact automation, restaurant menu/order setup, home services lead capture, beauty/wellness booking, mobile detailing, tutoring, cleaning, bookkeeping support, med-spa digital operations, and contractor quote intake. Each pack carries market signals, lead sources, customer outcome, offer package, fulfillment/QA/trust requirements, growth and retention loops, margin model, restricted-claim policy, launch checklist, and evals so new service-business launches inherit the same safety and proof boundaries.

The grand acceptance loop is now represented as a local operating plan. `readiness.autonomousLaunchLoopPlan` and `channels.autonomousLaunchLoop.plan` enumerate the 16-stage MayGoals flow from city selection and no-manual-vertical inference through market inspection, launch approval, operating-stack creation, first-customer acquisition, payment, fulfillment, completion proof, review request, retention, margin measurement, scale/pause/shutdown decisioning, postmortem, and self-improvement. A `autonomous-launch-loop-plan` capability carries the same stages, Portfolio renders launch-loop/live-loop/stage/blocked/ready chips, and live execution, payment collection, review requests, retention offers, provider routing, and self-improvement remain blocked until durable receipts and operator approval exist.

The same launch loop is now replayed across starter verticals in the MayGoals verifier. The check seeds cleaning in Austin, tutoring in Denver, and local SEO in Raleigh, lets `aggregateLeadMarketOpportunities()` infer the city/vertical opportunities from lead evidence and pack matching, then plans each launch and verifies the 16-stage autonomous loop without manual vertical selection or live side effects.

Vertical pack lifecycle management is now represented in both local persistence and launch planning. `vertical_pack_states`, `vertical_pack_lifecycle_events`, and `verticalPackLifecycle` can record install, version-bump, retire, and restore events with proof metadata that blocks live side effects; `readiness.verticalLifecyclePlan` and `channels.verticalLifecycle.plan` add install, manifest validation, promotion, retirement, and rollback workflows to each service-business launch candidate. A `vertical-lifecycle-plan` capability carries the same gates, Portfolio renders vertical-lifecycle/install/version/workflow/receipt chips, and JSON deletion, customer migration, provider mutation, live publication, automatic pack promotion, and pack retirement remain blocked until lifecycle receipts and operator approval exist.

Pricing and margin inference now uses stored local evidence before falling back to the vertical pack. `signals.pricingMarginInference` scans `research_json` pricing/offer/promotion/service-pricing evidence plus lead-intelligence pricing/offer notes, separates diagnostic fees/coupons/tune-ups from representative service-ticket prices, and records observed service prices, diagnostic fees, representative price, spread, estimated fulfillment cost, gross margin, confidence, evidence IDs, source URLs, assumptions, and `source: lead_evidence_pricing_margin_inference`. The inferred representative price feeds `unit_economics.representativePriceCents` and market sizing, mirrors onto `risks.pricingEvidenceCount`/`risks.pricingInferenceConfidence`/`risks.representativePriceCents`/`risks.inferredGrossMarginPct`, renders as pricing/margin chips, and carries uncertainty under `signals.confidenceIntervals.pricingMarginInference`. No live quote calls, payment-provider pricing, ad platform, or external pricing feed is queried.

Market opportunities also carry a deterministic owner-responsiveness prediction: `signals.ownerResponsiveness` records `responsivenessClass` (`responsive_likely` / `mixed` / `unresponsive_risk` / `evidence_insufficient`), `recommendedAcquisitionMotion` (`call_ready` / `inbound_first` / `proof_first` / `evidence_review`), `responseFrictionScore` (0 = fully responsive, 1 = high friction), `callableCoverageRatio`, `businessPhoneCoverageRatio`, `phonePresentRatio`, matched `negativeSignals` (`no_callback`, `missed_call`, `unanswered`, `no_response`, `slow_response`), matched `positiveSignals` (`fast_response`, `callback_path`, `response_time_promise`, `business_landline_evidence`), `evidenceLeadIdsByKey`, `evidenceLeadIds`, deterministic `blockers`/`evidenceRequired` (callable-reason text, research confidence, source URL, phone number), `assumptions`, `inputs`, and `source: lead_evidence_owner_responsiveness_prediction` — derived purely from existing lead `risk_status`, `phone_classification`, `callable_reason`, `presence_confidence`, `source_url`, `website`, `online_presence_strength`, and the urgency/demand-pressure context. Key fields mirror onto `risks.ownerResponsivenessClass`/`risks.recommendedAcquisitionMotion`/`risks.responseFrictionScore`/`risks.ownerResponsivenessBlockers`, surface as compact owners/motion/friction/callable/needs chips in the Portfolio opportunity row, propagate through the portfolio snapshot, and serialize through the ops export. No live calls, scraping, or external responsiveness probes are invoked.

Market opportunities now carry a deterministic TAM/SAM/immediately-callable estimate too: `signals.marketSizing` (mirrored on `unit_economics.marketSizing`) records `totalObservedLeads`, `immediatelyCallableLeads`, `weakPresenceCallableLeads`, `representativeTicketCents`, `estimatedFulfillmentCostCents`, `contributionMarginCents`, `maxAcquisitionCostCents`, `estimatedCallableRevenueCents`, `serviceableAvailableMarketCents` (SAM proxy = immediately callable × ticket), `obtainableFirstWaveLeads`/`obtainableFirstWaveCents`/`obtainableFirstWaveMarginCents` (SOM proxy from urgency, demand pressure, exploitable weakness, and evidence confidence), `firstWaveConversionRate`, `confidence`, `assumptions`, `evidenceLeadIds`, and `source: lead_evidence_market_sizing_estimate` — all derived from existing lead evidence and vertical-pack margin model, no live scraping or external surveys. Key fields also mirror onto `risks.marketSizingConfidence`/`risks.obtainableFirstWaveCents`/`risks.serviceableAvailableMarketCents`, surface as compact callable/SAM/SOM/confidence chips in the Portfolio opportunity row, propagate through the portfolio snapshot, and serialize through the ops export.

Every point-estimate market claim now carries a confidence band under `signals.confidenceIntervals`: score, aggregate confidence, exploitable weakness ratio, demand-pressure score, owner-response friction, search-intent score, city-demand coverage/top-hotspot score, pricing confidence/spread/representative price/gross margin, neighborhood launch priority/first-wave revenue, market recommendation explainability, SAM proxy, callable-revenue proxy, SOM proxy, and first-wave-margin proxy each include low/point/high, half-width, width class, sample size, evidence count, input-agreement score, method, and `source: lead_evidence_confidence_interval_propagation`. The summary mirrors onto `risks.confidenceIntervalWidthClass`/`risks.confidenceIntervalSpeculative`/`risks.claimConfidenceFloor`, renders as compact uncertainty/score-CI/SAM-CI chips, and is explicitly labeled as a heuristic evidence band rather than a live market survey.

Search intent capture is derived locally as well: `signals.searchIntentCapture` classifies observed demand as `urgent_local_search`, `category_comparison`, `brand_validation`, `booking_or_menu_intent`, `proof_discovery`, or `evidence_insufficient`, records matched intent keys, source coverage, vertical-pack lead-source alignment, recommended capture surface, required evidence, assumptions, and `source: lead_evidence_search_intent_capture`. Key fields mirror onto `risks.searchIntentClass`/`risks.recommendedCaptureSurface`/`risks.searchIntentScore`/`risks.searchIntentEvidenceRequired`, render as compact intent/surface/fit chips, and the intent score is included in `signals.confidenceIntervals` so search claims carry uncertainty too.

Review complaint clustering is also deterministic and local: `signals.reviewComplaintClusters` mines stored `research_json` lead intelligence (`complaintsPainPoints`, review themes, website issues, missing customer info, review summaries) plus lead notes into market-level pain clusters such as `slow_response`, `scheduling_availability`, `pricing_surprise`, and `emergency_after_hours`. Each cluster carries lead coverage, mention count, matched terms, cited evidence IDs, source URLs, example claims, severity, score, acquisition angle, and `source: lead_evidence_review_complaint_clustering`; the summary mirrors onto `risks.reviewComplaintClusterKeys`/`risks.reviewComplaintCoverage`/`risks.topCustomerComplaint` and is included in `signals.confidenceIntervals.reviewComplaintClusters`.

Formation and permit signals are ingested from stored evidence when available: `signals.formationPermitSignals` extracts local-only license, permit/inspection, insurance/bond, entity-formation, and missing-license-proof clues from `research_json.sourceEvidence`, `leadIntelligence.evidence`, positive proof, compliance findings, permit evidence, and formation evidence. The summary records coverage, license sensitivity, positive/missing evidence, regulatory requirement keys, `regulatoryRiskScore`, evidence requirements, and `source: lead_evidence_formation_permit_signal_ingestion`; mirrors appear on `risks.formationPermitSignalKeys`/`risks.formationPermitCoverage`/`risks.formationPermitRiskScore`; and uncertainty bands live under `signals.confidenceIntervals.formationPermitSignals`. No government registry, permit database, or contractor board is queried during this local pass.

Local seasonality modeling now runs during market aggregation as a deterministic local pass: `signals.localSeasonality` infers seasonal windows such as `summer_cooling_ramp` from the current aggregation month, vertical-pack market/growth/retention text, and stored lead evidence, then records `seasonalityClass`, matched seasonal terms, evidence lead IDs, `demandMultiplier`, `seasonalPressureScore`, assumptions, and `source: lead_evidence_local_seasonality_model`. The Portfolio view renders season/window/lift chips, key mirrors appear on `risks.localSeasonalityClass`/`risks.localSeasonalityWindowKey`/`risks.localSeasonalityDemandMultiplier`, and uncertainty bands live under `signals.confidenceIntervals.localSeasonality`; no weather feed, ad auction, SERP, or external demand provider is queried.

Ad saturation and offer fatigue are detected from stored market evidence too: `signals.adSaturationOfferFatigue` mines lead `research_json` ad/search/offer evidence, lead-intelligence ad observations, promotions, complaints, website issues, and lead notes for `paid_ad_density`, `aggregator_crowding`, `discount_offer_fatigue`, `generic_claim_fatigue`, and `trust_claim_fatigue`. It records saturation and fatigue levels/scores, signal coverage, matched terms, cited evidence, recommended positioning, channel guidance, evidence requirements, assumptions, and `source: lead_evidence_ad_saturation_offer_fatigue_detection`; mirrors appear on `risks.adSaturationLevel`/`risks.offerFatigueLevel`/`risks.adSaturationCompositeScore`; uncertainty bands live under `signals.confidenceIntervals.adSaturationOfferFatigue`; and Portfolio rows render ads/fatigue/pressure/positioning chips. No live ad library, SERP, auction, social-ad, or keyword-volume provider is queried during this local pass.

False-positive market recommendation learning closes the loop when a city/vertical looked launchable but failed operator or proof review. `recordMarketRecommendationOutcome()` and `POST /api/portfolio/market-opportunities/:id/record-outcome` append `signals.marketOutcomeLearning`, create a `portfolio_learning_records` row with `source_type: market_opportunity_outcome`, mirror penalty/false-positive/reason/override fields onto `risks`, move the opportunity to `learning_review`, and downgrade the next decision to `watch` or `avoid`. Future `aggregateLeadMarketOpportunities()` runs preserve fresh lead evidence while reapplying the learned score penalty before choosing a launch decision, and the Portfolio view renders learned/penalty/next/reason chips.

Provider links are also tenant-scoped now: `provider_credential_guardian` receipts prove workspace/service/account ownership, least-privilege scopes, secret-storage policy blockers, live-smoke blockers, and rollback without reading, persisting, mutating, or sharing credential material. Safe-to-launch, safe-to-fulfill, and safe-to-charge gates require this ownership proof before an active provider link counts as ready.

Tenant boundaries now have their own receipt trail: `tenant_isolation_auditor` checks workspace-scoped customer, contact, job, payment, provider-link, credential, vendor, launch-surface, and receipt relationships, proves the portfolio snapshot excludes a second workspace probe, blocks live enforcement on approval/export/retention/run-mode/adapter gates, and rolls audit metadata back without moving, deleting, exposing, or cross-linking tenant data.

Tenant operating controls are receipt-gated as well: `tenant_control_governor` plans per-workspace billing mode, monthly budget, usage limits, feature flags, run-mode policy, and geography/compliance policy; live enforcement blocks on billing approval, billing-provider evidence, usage alerting, export/retention policy, live run mode, guardrail, and adapter gates; rollback restores local workspace metadata without charging, changing live flags, changing run mode, or deleting tenant data.
Tenant lifecycle policy now has the same receipt spine: `tenant_lifecycle_manager` creates workspace-scoped redacted export manifests, backup intent, retention policy, and deletion-hold plans; live export/delete/backup enforcement blocks on export and deletion approvals, backup-storage policy, legal-hold review, live run mode, guardrail, and adapter gates; rollback restores metadata without writing backups, exporting PII, or deleting tenant rows.

Tenant role and customer access governance is local and auditable through `tenant_access_governor`: bootstrap workspaces seed an owner operator, role assignments record principal/scope/permission policy, customer portal roles stay private and token-scoped, live access preflight blocks on operator approval, run mode, guardrail, and missing auth-provider adapter, and rollback marks local assignments compensated without issuing sessions, exposing customer data, or touching provider credentials.

Portfolio finance intelligence now persists human labor attribution plus `portfolio_finance_rollups` for market finance, service unit economics, and segment LTV/payback. The analyzer combines payments, acquisition spend, labor cost, payout/refund exposure, repeat-work expansion signals, churn risk, and margin-aware recommendations while proving it did not charge customers, mutate provider budgets, change live prices, or shut services down.

Workflow explainability is no longer limited to the primary workflow subject: `workflow_entity_links` can attach customers, jobs, payments, finance rollups, and other domain records to a workflow instance, and `workflowInstances.explainEntity()` reconstructs the linked timeline, decisions, evidence, cost, latency, migrations, and mock-mode boundary for any attached entity.

Customer feedback and reputation signals now persist as local `portfolio_customer_feedback_records`: completion acceptance, rating, sentiment, public-review intent, linked completion/review-request receipts, praise/issues, evidence, and safety proof are recorded without posting public reviews, offering incentives, gating reviews, messaging customers, suppressing negative feedback, charging payments, or penalizing vendors.

Warranty remediation is local and auditable too: `portfolio_customer_remediation_plans` links low-rating or issue feedback to refund/dispute and vendor-quality receipts, then records due dates, priority/severity, action steps, estimated remediation cost, and `customer_remediation_warranty_safety` proof without issuing refunds, sending customer messages, scheduling rework, posting public responses, changing payment state, reassigning vendors, or penalizing vendors.

Vendor corrective action now has a non-punitive planning ledger: `portfolio_vendor_corrective_actions` links remediation plans to vendor-quality receipts and vendor partners, records coaching/review steps and due dates, and proves no vendor message, payout clawback, contract change, calendar block, customer reassignment, backup dispatch, or penalty happens without a later explicit live path.

Remediation finance is now reserved instead of hand-waved: `portfolio_remediation_budget_reserves` attaches warranty recovery plans and vendor corrective actions to the latest service unit-economics rollup, records amount, probability, expected liability, cohort/runway context, and `remediation_budget_reserve_safety` proof without moving money, issuing refunds, charging customers, paying vendors, mutating provider budgets, changing prices, shutting services down, or finalizing accounting.

Remediation closeout now compares the plan to reality: `portfolio_remediation_closeout_receipts` closes a local reserve with actual cost, expected-liability variance, retained revenue, churn-risk delta, retention status, and `remediation_closeout_receipt_safety` proof without moving money, finalizing accounting, mutating finance rollups, posting public-review updates, messaging customers/vendors, or changing live prices.

Customer retention recovery now has its own playbook ledger: `portfolio_customer_retention_playbooks` links remediation closeouts to customers, unit economics, and offer bundles, records churn risk, expected retained revenue, recommended follow-up offers, steps, and `customer_retention_playbook_safety` proof without sending messages, changing prices, creating payment links, scheduling bookings, applying discounts, requesting reviews, or mutating finance rollups. Customer-visible renewal closeout packets can also seed `renewal_closeout_retention` playbooks from subscription, lead, customer, job, service-business, offer, and finance evidence while keeping billing, booking, payment-link, price-change, offer-send, and customer-message side effects blocked.

Retention playbooks now get execution receipts too: `portfolio_customer_retention_playbook_receipts` records dry-run validation, live-preflight blockers, and rollback for the follow-up motion with `customer_retention_playbook_execution_safety`, keeping email/SMS/portal messages, offers, discounts, payment links, subscriptions, bookings, live price changes, and customer segmentation blocked until explicit proof and an implemented live adapter exist.

Retention cohorts now roll up into an operator-readable ledger: `portfolio_retention_cohort_rollups` aggregates saved customers, at-risk customers, playbooks, playbook receipts, retained revenue, remediation cost, expected liability, net retention value, average churn risk, recommendation, and `retention_cohort_rollup_safety` proof without messaging customers, changing offers/prices, creating payment links, booking work, or mutating finance rollups.

The portfolio snapshot now turns those retention cohorts into a `retentionCohortCommandCenter` read model. It joins cohort rollups, retention playbooks, dry-run/live-preflight receipts, capital feedback, and board work items into operator next actions for smoke proof, live-adapter proof, run-mode review, draft review, and capital feedback while keeping customer messages, offers, prices, payment links, bookings, finance rollups, and external side effects blocked.

Retention command blockers can now be queued as durable internal work: `portfolio_retention_command_work_item_receipts` and `portfolio_retention_command_work_items` turn smoke-proof, adapter, run-mode, dry-run, live-preflight, capital-feedback, and draft-review blockers into local operator work items. The command center exposes a no-side-effect `queue_retention_command_work_items` action and records `retention_command_work_item_receipt_safety` / `retention_command_work_item_safety` proof that it did not send customer messages, create offers or payment links, book jobs, mutate finance rollups, call providers, invoke adapters, or enqueue jobs.

Retention command work items now have lifecycle receipts too: `portfolio_retention_command_work_item_lifecycle_receipts` records approve/reject/escalate decisions with tenant role permission checks, operator attribution, proof keys, downstream proof hints, and `retention_command_work_item_lifecycle_safety`. These receipts update only local work-item status and prove no customer messages, offers, prices, payment links, bookings, finance rollups, provider calls, adapter invokes, job enqueueing, command receipts, or cohort rollups were mutated.

Retention command work items can also be claimed, released, expired, and inspected as local leases through the same lifecycle table. `claimRetentionCommandWorkItem()`, `releaseRetentionCommandWorkItem()`, `expireRetentionCommandWorkItemLeases()`, `recordRetentionCommandWorkItemLeaseMaintenance()`, and the opt-in `ops.retention_command_lease_maintenance` durable job record lease metadata, active/released/expired state, operator attribution, durable lease-sweep receipts, read-only maintenance receipts, command-center active/stale lease telemetry, and `localLeaseUpdated` / `retention_command_work_item_lease_expiry_safety` / `retention_command_work_item_lease_sweep_safety` / `retention_command_work_item_lease_maintenance_safety` / `retention_command_work_item_lease_maintenance_job_safety` proof while leaving blocker resolution, customer contact, providers, adapters, jobs, finance, command receipts, and cohort rollups untouched.

Approved retention command work items can now be collected into an evidence-only proof packet through `collectRetentionCommandWorkItemProofPacket()` and `POST /api/portfolio/retention-command-center/:id/proof-packet`. The packet exposes operator-reviewed proof keys, source receipt ancestry, counts, local proof blockers, and `retention_command_work_item_proof_packet_safety` while explicitly refusing to satisfy live provider-smoke or live-adapter gates from local operator review alone.

Ops exports now carry that same retention command center as a derived `portfolioRetentionCohortCommandCenter` table with redaction-manifest proof counts. Exported rows preserve blockers, cleared proof, queued/approved work-item counts, lifecycle receipt counts, next actions, source receipt ancestry, and `retention_cohort_command_center_safety` evidence without customer sends, finance mutation, provider calls, adapter invokes, job enqueueing, or external side effects.

Retention value now feeds capital planning without moving money: `portfolio_retention_capital_feedback_receipts` links cohort rollups to capital-allocation receipts, strategy recommendations, and resolved account-board retention feedback when present. It records retained revenue, net retention value, suggested budget, priority, recommendation, board-review signal counts, and `retention_capital_feedback_safety` proof without ad spend, provider-budget mutation, payment transfers, offer/price changes, service shutdowns, account-board feedback mutation, or mutating capital plans.

Service decisions now have a board-level fusion receipt: `portfolio_service_decision_fusion_receipts` combines acquisition strategy, service unit economics, board-reviewed retention capital feedback, capital allocation, vendor-quality routing, and remediation closeout into one proposed decision with risk score, budget recommendation, signal labels, board-feedback receipt counts, and `service_decision_fusion_safety` proof without moving budgets, changing prices, shutting services down, messaging customers, reassigning vendors, issuing refunds, releasing payouts, mutating account-board retention feedback, or mutating the source ledgers.

Board decisions now have execution controls too: `portfolio_service_decision_execution_receipts` records dry-run, live-preflight, and rollback receipts for board-level service decisions. Each execution receipt carries a local proof packet that gathers approved decision-work receipts, live-readiness evidence artifacts, and readiness reconciliation IDs before preflight, while still blocking budget changes, channel scale, vendor routing, retention follow-up, pause/shutdown changes, customer messages, refunds, and payouts until operator board approval, runway evidence, retention/vendor-quality preflights, provider smoke, live side-effect flags, and a real execution adapter exist.

Board decisions now distribute into review work instead of disappearing into prose: `portfolio_decision_distribution_receipts` and `portfolio_decision_work_items` turn a service-decision execution plan into local operator, accounting, vendor-ops, and customer-success work items with required proof, due dates, and `board_decision_work_item_*_safety` proof while keeping sends, spend, vendor assignment, refunds, payouts, price changes, and shutdowns blocked.

Decision work now has lifecycle receipts: `portfolio_decision_work_item_receipts` records approve/reject/escalate decisions against local work items, checks tenant role permissions such as `approval:decide`, and can collect approved proof back into service-decision live preflight while still blocking provider smoke, missing adapters, and every external side effect.

Live-readiness blockers now become tenant-scoped evidence too: `portfolio_live_readiness_evidence_artifacts` stores provider-smoke, adapter-implementation, and side-effect-flag attestations for board decision execution without storing secrets, reading credentials, invoking providers/adapters, changing flags, or mutating the source execution receipt.

Board decisions can now bind into a single explainable workflow spine: `service-decision-board-execution` links the fused decision, execution receipt, distributed work, approval receipts, and live-readiness artifacts into one mock-mode `workflow_instances` timeline that ends blocked on external execution until provider smoke, adapter proof, and side-effect-flag evidence exist.

Blocked board-decision workflows now route compensation work as durable plans: `portfolio_workflow_compensation_plans` ties each failed live-readiness artifact to a provider-smoke retry, live-adapter implementation ticket, or side-effect-flag attestation plan, links those plans back into the workflow graph, and records that no provider calls, jobs, customer messages, budget moves, or flags changed.

Compensation plans now have lifecycle receipts: `portfolio_workflow_compensation_receipts` records retry scheduling, rollback, and local evidence closeout against each plan, appends the workflow timeline, and can feed verified local side-effect-flag evidence back into `portfolio_live_readiness_evidence_artifacts` without falsely marking provider smoke or live-adapter blockers complete.

Service-decision readiness now reconciles into one durable report: `portfolio_service_decision_readiness_reconciliations` combines board work-item approvals, live-readiness artifacts, compensation plans, compensation receipts, and runtime gates to show cleared local proof, remaining provider/adapter proof blockers, runtime blockers, and safety evidence without invoking providers or changing live execution state.

The portfolio operating-model API now exposes a `readinessCommandCenter` read model, and the Portfolio tab renders it as a board decision command center with cleared proof counts, compensation plan/receipt counts, evidence counts, remaining proof/runtime blockers, and the next operator actions for each blocker.

Ops exports now also include a derived `portfolioServiceDecisionReadinessCommandCenter` table. It reconstructs the board-decision command rows from readiness reconciliations, compensation plans/receipts, live-readiness evidence, adapter ledger receipts, workflow instances, and workflow links, then records redaction-manifest proof that the command surface, runtime blockers, action commands, adapter status, and no-side-effect safety evidence survived export without invoking providers or changing execution state.

The command center can now act on those reports through guarded API/UI commands: operators can plan compensation routes, record local retry receipts, and rerun readiness reconciliation from the Portfolio tab while the receipts continue to prove no provider calls, adapter invocations, job enqueueing, customer messages, budget moves, or side-effect flag changes happened.

It also has a safe evidence-intake path for the remaining live blockers: provider-smoke and adapter packets can be submitted from the command center as pending review artifacts, but provider smoke only verifies when it references a fresh matching live `provider_health_events` receipt that is bound to the same readiness reconciliation, service-decision execution receipt, live run-mode attestation, required `LIVE_*` flags, and command-center provenance. Local smoke receipts record proof packets without calling providers, and mock-mode or missing-flag smoke packets stay pending instead of clearing live readiness. Adapter packets remain pending until a real adapter-implementation ledger exists. Local clicks cannot fake live-provider or live-adapter readiness.

Verified smoke or adapter evidence now refreshes the durable readiness reconciliation automatically. The same local reconciliation path appends evidence, updates workflow timeline metadata, removes cleared proof blockers from the command center, and leaves only runtime blockers such as run mode, side-effect flags, or board guardrails. Pending, forged, mock-mode, and missing-flag packets do not refresh the row.

Verified readiness evidence also closes matching compensation plans locally. Provider-smoke retry plans or adapter-implementation tickets stop appearing as retryable command-center work once a verified readiness artifact for the same execution/proof key exists; the closeout writes idempotency-keyed workflow compensation receipts and links the proof artifact without calling providers, invoking adapters, enqueueing jobs, sending customer messages, moving budget, or changing live flags. If multiple blocked readiness artifacts exist for the same proof key, each receives its own compensation plan and the verified proof closes every matching open plan in one transactional fan-out rather than leaving stale retries behind.

Adapter work now has that first ledger: `portfolio_live_adapter_receipts` records dry-run, contract-test, local implementation-verification, live-preflight, and rollback adapter implementation receipts from the command center, including required proof, blockers, and safety metadata. Contract-test receipts can clear the local adapter-contract blocker, and verified implementation receipts can back `live_adapter_implemented` evidence, but live execution still remains gated by provider smoke, runtime side-effect flags, operator guardrails, and the actual live adapter path.

Offer bundling is also finance-backed now: `portfolio_offer_bundles` stores bundle components, price, expected margin, source finance rollup, experiment guardrails, and `portfolio_offer_bundle_safety` proof so a bundle can be planned without creating payment links, changing live prices, mutating provider budgets, or making customer promises.

Workflow replay is receipt-gated too: `workflow_replay_controller` records dead-letter replay plans for terminal failed jobs, blocks live replay on operator approval, run mode, replay smoke, guardrail, and missing adapter gates, and rolls replay plans back without enqueueing a replacement job, invoking handlers, or mutating the source job.
Workflow instances now provide the longer-running state-machine spine: `workflow_instances` pins an entity to a workflow definition/version/mode/state, `workflow_instance_events` records ordered state transitions with commands, decisions, evidence, cost, and latency, and `workflowInstances.migrateVersion` moves an instance to a newer definition without losing timeline history or executing live side effects.

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

After customer launch approval, Callan seeds a persisted `AccountManagerPlan` and `account_tasks` queue. The loop is enabled by default but dry-run by default: it writes scheduled tasks and preview messages, while live AgentMail sends still require `ACCOUNT_MANAGER_LIVE_SENDS=true`, `LIVE_EMAILS=true`, AgentMail credentials, run-mode allow-list approval, quiet-window/frequency gates, and operator approval. Account-manager tasks can now escalate into local `account_task_operator_board_escalations` and `account_operator_board_work_items`, move through local `account_operator_board_work_item_receipts` for claim/resolve proof, and record `account_operator_board_retention_feedback_receipts` when resolved board reviews should feed retention planning. That gives aftercare and renewal work a durable operator-board lane without sending customer messages, calling providers, mutating retention playbooks, completing source account tasks, changing subscriptions/billing, creating payment links, or booking work.

The account manager tracks promised edits, stale phone/hours facts, 24-hour launch follow-up, review capture, Google Business Profile hygiene, seasonal hours, service/menu changes, analytics/contact-flow checks, hosting/subscription status, and renewal closeout health checks from customer-visible closeout packets. Customer portal state shows pending/recent aftercare, and the operator aftercare tab exposes approve/send/pause/complete/reassign plus "why now" evidence.

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
POST /api/account-tasks/:id/escalate
POST /api/account-operator-board/work-items/:id/claim
POST /api/account-operator-board/work-items/:id/resolve
POST /api/account-operator-board/work-items/:id/lifecycle
POST /api/account-operator-board/lifecycle-receipts/:id/retention-feedback
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
npm run check:maygoals  # portfolio operating-model proof for the impossible May Goals substrate
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

The boot schedulers also enqueue `ops.provider_posture` and `ops.recover_stuck`. Provider posture is a durable no-network refresh controlled by `OPS_PROVIDER_POSTURE_ENABLED` and `OPS_PROVIDER_POSTURE_INTERVAL_MS`; it appends fresh dry-run/config evidence for promotion review, but does not overwrite the latest live smoke row or erase live failure evidence. Stuck recovery is controlled by `OPS_RECOVERY_ENABLED` and `OPS_RECOVERY_INTERVAL_MS`; it releases expired job leases, closes stale calls with audit receipts, returns scheduled calls stuck in `placing` to `pending`, and lets the server recover paid build jobs through the builder path. Retention command lease maintenance has an opt-in recurring job, `ops.retention_command_lease_maintenance`, controlled by `RETENTION_COMMAND_LEASE_MAINTENANCE_ENABLED` and `RETENTION_COMMAND_LEASE_MAINTENANCE_INTERVAL_MS`; it records read-only maintenance receipts for command work-item leases and is disabled by default so it does not create a new production blocker before an operator enables it. Operators can also queue or run that job from `POST /api/ops/retention-command-lease-maintenance` and the Operations command center `lease maint` control, which keeps the work durable and side-effect-free.

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

Safe-to-sell now carries a read-only safe-to-renew lane for recurring hosting/edit-care customers. Active or trialing subscriptions must have a `hosting_subscription_status` account-manager task, due renewal checks must have fresh dry-run proof or a recent resolution, and past-due subscriptions become operator renewal blockers. The inspection never sends email, changes Stripe state, creates subscriptions, or mutates customer promises; it exposes renewal blockers, active MRR, hosting-task proof counts, churn-risk save-plan counts, expected retained revenue, and next actions in the CLI report and operations command center. `npm run safe-to-renew` runs the same renewal check as a standalone durable self-check, records `safe_to_renew_reports`, persists non-live `safe_to_renew_playbooks` for at-risk subscriptions, and can be queued from the command center with the `renew` operator control. Renewal save playbooks are local-only: they draft operator steps and proof requirements while keeping customer messages, discounts, payment links, live price changes, booking, Stripe mutations, and subscription mutations blocked.

Customer portals now expose subscription management state for leads with recurring hosting/edit-care rows. `/api/share/build/:token` includes `subscriptionManagement` with active counts, at-risk renewal playbooks, proof requirements, customer review state, and customer-requested renewal change rows. `POST /api/share/build/:token/renewal/review` records a token-scoped `renewal_plan_reviewed` portal action plus inbound contact event, while `POST /api/share/build/:token/renewal/change-request` records a token-scoped `renewal_change_requested` portal action plus inbound contact event for operator review. These portal actions are only acknowledgement/intake: they do not send email/SMS/portal broadcasts, create checkout or payment links, apply discounts, change live prices, mutate Stripe, or mutate subscription rows.

Operations observability now carries the matching renewal change-request queue. `/api/ops/command-center` and `exportOperationsData()` expose `renewalChangeRequestQueue`/`renewalChangeRequests` with totals, pending counts, latest request metadata, per-subscription rows, and safety flags that keep the queue as operator-visible intake only. The Operations command center renders the count beside safe-to-renew/save-plan status; it does not resolve, discount, rebill, message, or mutate subscriptions.

Operators can close the loop locally with `POST /api/ops/renewal-change-requests/:id/resolve` using an admin token and an `outcome` of `reviewed`, `resolved`, or `rejected`. The endpoint updates only the `portal_actions` row, appends operator-review metadata, records an internal contact event, and refreshes the queue counts; it still sends no customer message and performs no Stripe, subscription, payment-link, discount, checkout, or live-price mutation.

Operators can also draft a blocked billing-change packet with `POST /api/ops/renewal-change-requests/:id/billing-preflight` after a request is reviewed or resolved. The packet is stored as an internal `renewal_billing_change_preflight` action, exposed through `renewalBillingChangePreflightQueue` and `exportOperationsData().tables.renewalBillingChangePreflights`, and records the proposed change, proof requirements, pricing/live-smoke/operator blockers, and current subscription state. It is evidence only: identical packets dedupe, the trust ledger marks the actor as internal ops, and the route sends no customer message, changes no subscription, mutates no Stripe state, creates no payment/checkout link, applies no discount, changes no price, and invokes no provider adapter.

The matching billing execution gate is `POST /api/ops/renewal-billing-change-preflights/:id/execute`. It records a `renewal_billing_change_execution_receipt` and refuses to call Stripe unless live execution is explicit, operator approval is present, the billing change is approved, customer consent is documented, price-sensitive changes have pricing-policy review, the subscription has a Stripe subscription ID, the `LIVE_PAYMENTS`/`RUN_MODE` side-effect gate is open, Stripe is configured, and a fresh live Stripe smoke receipt exists. Blocked receipts are internal-only and appear in `renewalBillingExecutionReceiptQueue`, `exportOperationsData().tables.renewalBillingExecutionReceipts`, and the Operations `bill gate` metric. If every live prerequisite is present, the same path applies the approved subscription change through Stripe and records the local subscription/update receipt; local checks prove the default path fails closed.

Renewal customer-message sends now have their own blocked proof packet: `POST /api/ops/renewal-change-requests/:id/customer-message-preflight` records an internal `renewal_customer_message_preflight` action after operator review, optionally links the billing preflight, and exposes `renewalCustomerMessagePreflightQueue` plus `exportOperationsData().tables.renewalCustomerMessagePreflights`. The packet stores the proposed email/SMS/portal/phone-script copy, AgentMail/live-smoke/compliance/operator proof requirements, and the current subscription snapshot while proving no email, SMS, portal broadcast, phone call, provider adapter call, payment link, discount, Stripe mutation, subscription mutation, or price change happened. The Operations command center renders these as `msg proof` so blocked customer-message work is visible without pretending it was sent.

The matching execution gate is `POST /api/ops/renewal-customer-message-preflights/:id/execute`. It records a `renewal_customer_message_send_receipt` and refuses to call AgentMail unless the request explicitly asks for live execution, operator approval, message-copy approval, customer-consent proof, a deliverable target email, an open `LIVE_EMAILS`/`RUN_MODE` side-effect gate, AgentMail configuration, and a fresh live AgentMail smoke receipt. Blocked receipts are internal-only and appear in `renewalCustomerMessageSendReceiptQueue`, `exportOperationsData().tables.renewalCustomerMessageSendReceipts`, and the Operations `send gate` metric. If every live prerequisite is present, the same path sends through the real AgentMail provider and records the outbound contact event/provider receipt; local checks prove the default path fails closed.

Operators can record customer-visible renewal confirmation receipts with `POST /api/ops/renewal-confirmations` after a billing execution receipt is `applied` and/or a customer-message receipt is `sent`. The route refuses blocked/failed sources, dedupes identical source receipts, stores a `renewal_customer_confirmation_receipt`, exposes it through `renewalCustomerConfirmationQueue`, `exportOperationsData().tables.renewalCustomerConfirmationReceipts`, the Operations `confirm` metric, and the portal subscription `confirmations` list. Confirmation receipts make completed source effects visible to the customer while sending no new message, broadcasting no portal event, calling no provider adapter, mutating no Stripe state, and changing no subscription row.

Customers can acknowledge those receipts from the share portal with `POST /api/share/build/:token/renewal/confirmations/:confirmationId/acknowledge`. Acknowledgements are token-scoped `renewal_customer_confirmation_acknowledged` portal actions plus inbound contact events, exposed through `renewalCustomerConfirmationAcknowledgementQueue`, `exportOperationsData().tables.renewalCustomerConfirmationAcknowledgements`, the Operations `ack` metric, and portal subscription acknowledgement counts. They prove the customer received the confirmation while sending no follow-up message, broadcasting no portal event, calling no provider adapter, mutating no Stripe state, creating no payment/checkout link, and changing no subscription row.

After acknowledgement, customers can accept the renewal outcome with `POST /api/share/build/:token/renewal/confirmations/:confirmationId/accept`. Acceptance requires the confirmation to be visible and already acknowledged, records a token-scoped `renewal_customer_confirmation_accepted` receipt plus inbound contact event, and appears in `renewalCustomerConfirmationAcceptanceQueue`, `exportOperationsData().tables.renewalCustomerConfirmationAcceptances`, the Operations `accept` metric, and portal subscription acceptance counts. This is a customer handoff receipt only: it sends no message, broadcasts no portal event, calls no provider adapter, mutates no Stripe state, creates no payment/checkout link, and changes no subscription row.

Operators can turn accepted renewal confirmations into local follow-up work with `POST /api/ops/renewal-confirmation-acceptances/:id/followup`, then close that work with `POST /api/ops/renewal-confirmation-followups/:id/resolve`. Follow-up work items and receipts appear in `renewalCustomerConfirmationFollowupQueue`, `exportOperationsData().tables.renewalCustomerConfirmationFollowupWorkItems`, `exportOperationsData().tables.renewalCustomerConfirmationFollowupReceipts`, and the Operations `followup` metric. This keeps accepted renewal state visible to operators without sending customer messages, broadcasting portal events, calling providers, mutating Stripe, creating payment/checkout links, or changing subscription rows.

Completed follow-up receipts can now become customer-visible renewal closeout packets with `POST /api/ops/renewal-confirmation-followup-receipts/:id/closeout`. Packets require a completed follow-up receipt, customer acceptance, acknowledgement, and original visible confirmation, then appear in `renewalCustomerConfirmationCloseoutPacketQueue`, `exportOperationsData().tables.renewalCustomerConfirmationCloseoutPackets`, the Operations `closeout` metric, and each portal subscription confirmation row. The packet is portal proof only: it sends no customer message, broadcasts no portal event, calls no provider, mutates no Stripe state, creates no payment/checkout link, and changes no subscription row. The account-manager planner now also reads those visible closeout packets and creates operator-channel `renewal_closeout_health_check` tasks at `nextReviewAt`, so renewal care continues through the existing dry-run-first aftercare scheduler instead of relying on a human to remember the next review.

`npm run safe-to-sell` is the fail-closed launch check: it prints the same summary, blocker list, and next actions, then exits nonzero when Callan is not safe to sell. Use `npm run safe-to-sell -- --report-only` only when you need a red/green report without failing the surrounding shell job.

Safe-to-sell output, production-readiness reports, provider smoke CLI output, provider health events, and durable snapshots are redacted by default before they leave the process or land in SQLite. Emails, phone numbers, API keys, secrets, tokens, passwords, and host-local filesystem paths are masked while timestamps, backup filenames, and operational counters stay readable for audit/debugging.

Admin export includes a redacted SQLite operations manifest, table counts, and capped row samples by default. Mock/demo reset refuses production mode, creates a SQLite backup, deletes transient test jobs, and archives matched demo leads without deleting append-only trust-ledger receipts.

Every redacted operations export now carries an `ops_export_redaction_manifest` under `redaction.manifest`. The manifest records table and receipt coverage, the MayGoals merge/secret proof receipt counts, redacted placeholder kinds, and a raw secret-pattern scan so operators can verify the exported payload stayed redacted without opening the underlying SQLite rows.

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
