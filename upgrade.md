# UPGRADE PROMPT — Rebuild `callmemaybe` as an Agentic Cold-Calling Web Agency

You are taking over this repository. Read this entire document before you touch a file. Your job is **not** to incrementally patch the existing `Dial-to-Deploy` codebase — that codebase is a bloated mockup with 34 ceremonial "stages," fake artifact types, and dead abstractions. Your job is to **rebuild it from the ground up** into a small, working, end-to-end agentic service that places a real outbound call, sells a website, takes payment, builds the site, and delivers it — and does it in a way YC judges can see live on a screen.

You have explicit authority to **delete anything in this repo that does not serve the mission below**. Do not preserve code "just in case." Do not keep abstractions you have not personally re-derived from the new requirements. If a file is not on the keep-list at the end of this document, it is a deletion candidate and you should justify *keeping* it, not deleting it.

---

## 1. Mission

A single agentic service that:

1. Scrapes the web for small businesses and audits whether their online presence is actually strong (Yelp, Google Maps, BBB, permits, their own site/socials — anything public).
2. Enriches each lead into a research dossier: what the business is, how they operate, who the owner/customer persona appears to be, public phone number, online-presence strength, and concrete website/business needs.
3. Stores everything in a long-lived memory layer, keyed per customer.
4. Cold-calls them with a generated, business-specific sales pitch and a recording-disclosure preamble.
5. On a yes: asks for the customer's email, reads it back for confirmation, sends a Stripe invoice through AgentMail, keeps that AgentMail thread open for customer questions, sets up a meeting invite, and kicks off a Lovable build that the customer can watch happen live.
6. On a no: writes a post-mortem (why we lost, what to try next) back into memory so the next call is better.
7. Surfaces all of this as a node-graph operator UI where every node is clickable — click memory, see memory; click the agent, see what it's doing; click a call, hear the call.

The framing for YC is explicit and must stay intact in the demo copy: **we are not selling an agent; we are selling a service**. The agent is internal. The customer-facing surface is a website agency. The demo vertical (websites) is just the wedge — the same harness should obviously generalize to any mundane services business (tax, legal, paralegal, bookkeeping).

---

## 2. The Verified Stack (May 2026)

These are the **current** API surfaces. Do not trust the existing `.env.example` blindly — some of its base URLs are stale. Re-derive from the docs as you wire each provider.

### 2.1 Agent Phone (outbound voice)
- **Provider:** AgentPhone (YC). Base: `https://api.agentphone.ai/v1` *(note: `.ai`, not `.to` as the old `.env.example` claims — fix this)*.
- Auth: `Authorization: Bearer $AGENTPHONE_API_KEY`.
- Create an agent persona once: `POST /v1/agents` with `{ name, voiceMode: "hosted", systemPrompt, beginMessage, voice }`. Hosted mode is the right choice — no webhook server needed for the LLM turn loop.
- Place a call: `POST /v1/calls` with `{ agentId, toNumber, systemPrompt }`. The per-call `systemPrompt` overrides the agent default — use this to inject the per-business pitch.
- Live transcript: `GET /v1/calls/{id}/transcript/stream` (SSE). Final transcript: `GET /v1/calls/{id}/transcript`.
- Inbound webhook (single endpoint for both voice and SMS). HMAC-SHA256 over `{timestamp}.{rawBody}`, header `X-Webhook-Signature: sha256=<hex>` — verify or reject.
- Voices: `GET /v1/agents/voices`. Polly voices (`Polly.Amy`, `Polly.Joanna`) are listed; do not promise ElevenLabs unless you confirm it on the voices endpoint.
- Compliance: AgentPhone handles 10DLC + carrier-level DNC on registered campaigns, but **you** still must speak the recording-disclosure line at call start and honor opt-out. Bake the disclosure into the `beginMessage`.

### 2.2 Supermemory (RAG / customer memory)
- Base: `https://api.supermemory.ai/v3`. Auth: `Authorization: Bearer sm_...`.
- Ingest: `POST /v3/documents` with `{ content, containerTag, customId, metadata, taskType }`. Use `taskType: "memory"` for full agent memory (versioning, "forget"); `"superrag"` for managed RAG.
- **`containerTag` is the per-customer namespace.** One tag per business (e.g. `biz_<id>`). Max 100 chars, `[A-Za-z0-9._-]`. Every add and every search MUST be scoped by it — there is no other way to keep one customer's data out of another customer's retrieval.
- Per business, store four typed documents (use `metadata.kind` to discriminate):
  1. `kind: "profile"` — phone, address, hours, what they do, owner hypothesis, customer persona, online-presence strength/summary, needs, signals.
  2. `kind: "pitch"` — the generated sales script + opening line + invoice-email confirmation language.
  3. `kind: "call_log"` — one per call: transcript, outcome, summary, objections.
  4. `kind: "post_mortem"` — Gemini's analysis of what went right/wrong; confirmed invoice email if captured; customer questions; how to replicate or improve.
- SDK: `npm install supermemory` — use the official client, do **not** roll your own HTTP wrapper.
- Pricing reality: free tier $5/mo of usage; YC startup program gives $1k for 6 months. Apply.

### 2.3 Moss (real-time semantic retrieval inside the call)
- Base: `https://service.usemoss.dev/v1`. Auth: `MOSS_PROJECT_ID` + `MOSS_PROJECT_KEY` from `portal.usemoss.dev`.
- **What it actually is:** a sub-10ms in-call retrieval runtime (Rust + Wasm). It is *not* a web search agent. Do not confuse with a research layer.
- Use it **only** for: low-latency retrieval of objection-handling snippets, prior-call playbooks, and the per-business pitch chunks during the live voice turn. Supermemory is the durable store; Moss is the hot path under the 400ms voice budget.
- SDK: `npm install @moss-dev/moss`. Index once per call with the per-business profile + winning-objection chunks, query during the call.

### 2.4 Research / scraping (the "find leads" layer)
- The transcript references "MOSS the search layer" — that is wrong. Moss is not a research API. **Pick one** of the following and stick with it:
  - **Browser Use** (`https://api.browser-use.com/api/v3`, SDK `browser_use_sdk.v3`, header `X-Browser-Use-API-Key`). Agent mode for natural-language tasks (`sessions.create()` / `run()`); raw mode for CDP. Webhooks + streaming + polling all supported. Pricing: $10 free credits, then $0.06/browser-hour + per-step LLM cost. Use this for: scraping Yelp/Maps/BBB, auditing whether online presence is none/weak/mixed/strong, capturing screenshots as lead evidence, and later — driving Lovable.
  - Optional second source: a search API (Exa, Brave, Perplexity) for the initial "businesses in <city> with weak online presence" sweep. Confirm what the YC hackathon actually provides credits for *before* picking — paste the hackathon page into the agent.
- The lead-discovery loop is small: query → list of candidate businesses → for each, a Browser Use task that audits online presence and pulls phone/owner/persona/signals/needs → write to Supermemory under a fresh `containerTag`.

### 2.5 AgentMail (invoice delivery + two-way customer thread)
- Base: `https://api.agentmail.to`. Auth: `Authorization: Bearer am_...`. Object model: `Organization > Inbox > Thread > Message`.
- Create one inbox per agent identity (pass `clientId` for idempotency). Send: `inboxes.messages.send(inboxId, { to, subject, text|html })`. List/poll replies: `inboxes.messages.list(inboxId, { limit })`. Use `extractedText` (quoted history stripped) when reading replies.
- Inbound: webhook **or** WebSocket. Use WebSocket in local dev (no public URL needed), webhook in deploy.
- AgentMail is the customer communication channel: after a verbal yes, send the invoice, recap, and meeting invite from the agent-owned inbox; then route customer replies/questions back through the same thread.
- Calendar invite: include an ICS attachment and a Google Meet link in the follow-up email body. Do not build a Google Calendar OAuth integration unless you have time — an ICS + meet.new link is enough for the demo.

### 2.6 Stripe (invoice)
- `npm install @stripe/agent-toolkit` — wraps Stripe APIs as LLM tool-calls; ships first-party integrations for Vercel AI SDK, OpenAI Agents, LangChain.
- Use a **restricted key (`rk_test_...`)** — the toolkit scopes its tool surface to what the key permits.
- For the demo: create a `$500` hosted Stripe invoice after a successful close. Save the hosted invoice URL in the AgentMail follow-up and listen for invoice-paid webhooks.
- Stretch: explore Stripe's 2026 agentic surfaces (Machine Payments Protocol, x402, Stripe Link for agents). Not required for the demo. Do not chase these unless the core loop already works.

### 2.7 Website build (Lovable + Browser Use)
- **Lovable has no general public API for editing projects yet** (May 2026). It has two automation surfaces:
  - **Build-with-URL**: `https://lovable.dev/?prompt=<urlencoded prompt>` opens an authenticated session and starts generating. Trivial to hand the customer a live URL.
  - **MCP server** at `https://mcp.lovable.dev` (Research Preview) — usable from Claude/Cursor for create + manage. Treat as experimental.
- The demo plan: when a call closes, the agent fires a Browser Use cloud task with the customer's brief. Browser Use opens Lovable's build-with-URL flow, drives the build, and **the `liveUrl` from Browser Use is what the customer watches on the call** — that is the "watch the agent build your website" moment.
- Custom domain on Lovable requires Pro ($25/mo). Either use the default `<project>.lovable.app` URL for the demo or wire Entri auto-DNS post-publish.

### 2.8 Google DeepMind / Gemini 3.1 Pro (the brain)
- Current flagship is **`gemini-3.1-pro-preview`** (Gemini 3 Pro was deprecated March 2026). SDK: `@google/genai` (the older `@google/generative-ai` is dead — do not import it).
- 1,048,576-token input window, 65,536 output. Multimodal in (text/image/video/audio/PDF), text out. Knowledge cutoff Jan 2025.
- Use it for: campaign planning, online-presence analysis, pitch generation, post-call analysis, confirmed-email extraction, post-mortem writeup, lead scoring, proposal body, project brief.
- Use **structured outputs** (`responseMimeType: "application/json"` + `responseJsonSchema`) everywhere you cross a typed boundary — pitches, analyses, post-mortems. Do not parse free-form text.
- Use `thinkingConfig: { thinkingLevel: "medium" }` for the planning/analysis hops; `"minimal"` for high-volume cheap ones.
- For cheap, high-volume work (pre-filtering scraper output) use `gemini-3-flash-preview` or `gemini-3.1-flash-lite`.

---

## 3. What to Delete

Before you write a single new line, delete the following:

- `dial_to_deploy_full_hackathon_plan.md` (443 KB hallucinated plan).
- `dial_to_deploy_app/` (whatever shell project sits there).
- The entire `server/orchestrator.js` (49 KB of ceremonial stages) and `server/index.js` (96 KB monolith). Both will be rebuilt much smaller.
- Every `docs/*.md` except `LIVE_DEPLOY.md` (which you may rewrite). The ARCHITECTURE / API / DEMO_SCRIPT / SPONSOR_INTEGRATIONS / ROADMAP documents describe a system that does not match the new mission.
- `scripts/production-hardening-test.js` and `scripts/smoke-test.js` if they reference the deleted orchestrator's 34-stage taxonomy.
- Any "Agency OS blueprint," "compliance firewall," "TCPAFirewall," "TemporalSaga," "voiceMOS," "DPO/RLAIF," "LoRAFineTuneOnAcceptedTrajectories," "bandit leaderboard," or other invented-sounding ceremony. These were aspirational labels with no implementation behind them. Compliance is real, but it's three things (DNC suppression list, recording disclosure, opt-out propagation) — not a 12-noun phrase.
- The "34 sequential stages" model entirely. Replace with a small set of long-running async workers (Section 5).

**Keep candidates** (verify each is still useful before keeping):
- `package.json` — keep React/Vite/Express. Drop unused deps.
- `migrations/` — keep if Postgres is on the table; otherwise delete.
- `Dockerfile`, `docker-compose.yml` — keep.
- `src/main.jsx`, the Vite + React shell — keep, but rebuild every component.
- `.env.example` — **rewrite** with the corrected base URLs from Section 2.
- `.gitignore` — keep.

Anything not on this list, you should delete unless you can articulate a concrete reason it serves the new mission.

---

## 4. Architecture

Small, boring, working.

```
┌──────────────────────────────────────────────────────────────┐
│  React operator console (Vite)                               │
│  Node-graph view: scraper • memory • caller • mailer •       │
│  builder • payment. Click any node → inspect its state.      │
└───────────────────────┬──────────────────────────────────────┘
                        │  (SSE for live updates, REST for actions)
┌───────────────────────▼──────────────────────────────────────┐
│  Express API (server/index.js, target < 500 LOC)             │
│  • POST  /api/leads/discover        kicks scraper             │
│  • POST  /api/leads/:id/call        kicks call worker         │
│  • POST  /api/leads/:id/followup    kicks mailer worker       │
│  • POST  /api/leads/:id/build       kicks builder worker      │
│  • GET   /api/leads | /api/leads/:id                          │
│  • GET   /api/events/stream         SSE of all worker events  │
│  • POST  /api/webhooks/agentphone   HMAC-verified             │
│  • POST  /api/webhooks/agentmail    inbound replies           │
│  • POST  /api/webhooks/stripe       checkout/invoice paid      │
└───────────────────────┬──────────────────────────────────────┘
                        │
                ┌───────┴────────────────────────────────┐
                │ Workers (in-process, async; no Temporal)│
                ├────────────────────────────────────────┤
                │ scraper.js     Browser Use + Gemini    │
                │ caller.js      AgentPhone + Moss live  │
                │ analyst.js     Gemini post-call        │
                │ mailer.js      AgentMail + Stripe invoice │
                │ builder.js     Browser Use → Lovable   │
                └───────┬────────────────────────────────┘
                        │
                ┌───────▼────────┐
                │  Supermemory   │  one containerTag per lead
                └────────────────┘
```

Storage: Supermemory is the source of truth for per-customer data. A small local SQLite (or JSON if you must — but SQLite is cheap) tracks operator-side state: lead list, worker status, event log. Do not put PII in the local DB if you can fetch it from Supermemory on demand.

---

## 5. Build Order (from the ground up)

Do these in order. Do not start step N+1 until step N is demonstrably working on a real lead end-to-end.

**Phase 0 — Clear the runway (~30 min)**
- Delete everything in Section 3.
- Rewrite `.env.example` with the verified base URLs from Section 2.
- Rewrite `package.json` to the actual dependency set: `express`, `@google/genai`, `supermemory`, `@moss-dev/moss`, `browser-use-sdk` (or pin the latest), `agentmail`, `agentphone`, `@stripe/agent-toolkit`, `stripe`, `better-sqlite3`, `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `zod`. Run `npm install` and confirm it resolves.
- A minimal Express server with `/api/health` and SSE plumbing only.

**Phase 1 — Memory (~1 hr)**
- Wire Supermemory. Implement a thin `memory.js` with: `createBusiness(profile) → containerTag`, `addDoc(containerTag, kind, content, metadata)`, `search(containerTag, query, kind?)`, `listKinds(containerTag)`.
- Manually create one fake business, write all four doc kinds, search them back. Commit.

**Phase 2 — Scraper (~2 hr)**
- One Browser Use task that, given a city + niche, returns N candidate businesses (Yelp is the easiest start). For each, a follow-up task that audits online-presence strength and pulls phone, what they do, needs, persona clues, and signals.
- Gemini structured-output pass to normalize into a typed `BusinessProfile`. Write to Supermemory under a new `containerTag`.
- Operator UI: a "Discover leads" form and a live list of incoming leads from SSE.

**Phase 3 — Pitch + Call (~3 hr)**
- For a selected lead, Gemini generates a `SalesPitch` (structured: opening line, three discovery questions, objection→response map, close, invoice-email ask, AgentMail handoff). Store as `kind: "pitch"` in Supermemory.
- Create the AgentPhone agent once at server boot if `AGENTPHONE_AGENT_ID` is unset; cache the ID.
- Place a call: per-call `systemPrompt` is the pitch, `toNumber` is the lead's phone, `beginMessage` includes the recording disclosure.
- Subscribe to the transcript SSE stream; mirror it into the operator UI in real time.
- On call end (webhook), store the transcript as `kind: "call_log"`.
- **For the demo, the `toNumber` is your own phone.** Do not point this at a real business until a human has reviewed consent, jurisdictional disclosure, and DNC scrub.

**Phase 4 — Analysis loop (~1 hr)**
- After every call, Gemini takes the transcript + the lead profile and produces a structured `PostMortem` (outcome enum: `won|lost|callback|unreachable`; reason; confirmed invoice email; customer questions; what to try next; replay-worthy moments). Store as `kind: "post_mortem"`. This is the "learning" loop — kept honest by being one Gemini call writing one document, not a 12-noun ceremony.

**Phase 5 — On a win: follow-up + payment (~2 hr)**
- Mailer worker:
  1. Stripe creates a `$500` hosted invoice.
  2. AgentMail sends a recap email with the invoice URL and an ICS attachment for a follow-up call (use `meet.new` as the meeting URL — fine for demo).
  3. AgentMail webhook/polling surfaces customer replies/questions in the operator console.
  4. Webhook `invoice.paid` / `invoice.payment_succeeded` flips the lead status to `paid` and fires the builder.

**Phase 6 — Builder (~2 hr)**
- Browser Use cloud task that opens `https://lovable.dev/?prompt=<encoded brief>`, watches the build, and surfaces the `liveUrl` so the customer (and operator) can watch the build live. Project URL is stored back to the lead.
- "Watch your site being built" — this is the killer demo moment. Make sure the `liveUrl` is visible in the operator console as soon as the build worker kicks off.

**Phase 7 — Operator console polish (~3 hr)**
- Node-graph view, not a table. Use a small dependency-free SVG/canvas — do not pull in React Flow unless you have budget for it.
- Six nodes: Scraper, Memory, Caller, Analyst, Mailer, Builder. Edges show data flow. Click → inspector panel on the side.
- Memory inspector: list the four doc kinds for the focused lead. Caller: live transcript + audio if available. Analyst: the post-mortem. Mailer: AgentMail thread + invoice state. Builder: Lovable `liveUrl` embedded.
- Use the existing `frontend-design` skill conventions if a polished aesthetic is needed quickly.

**Phase 8 — Demo dry-run + safety (~1 hr)**
- One mock end-to-end run, one live run pointed at your own phone.
- Verify HMAC webhook signature verification works.
- Verify the recording-disclosure preamble actually plays.
- Verify Supermemory `containerTag` isolation: a second test lead does not bleed into the first lead's search results.
- Verify the Stripe key is a **restricted** key, not a live secret.

---

## 6. Non-Goals (do not let yourself drift into these)

- A 34-stage orchestrator. We have six workers; that is enough.
- A "compliance firewall" abstraction. Compliance is three concrete checks (DNC, disclosure, opt-out) — implement them as three functions, not a noun.
- A "memory graph with edges and objection trees and consent ledger and erasure plan." It is four document kinds per `containerTag`. That is the graph.
- Temporal, Kafka, Saga patterns, RLAIF, DPO, LoRA, bandit leaderboards. None of these exist in the new system. If you find yourself typing one of these words, stop.
- Multiple persistence drivers. SQLite for operator state, Supermemory for customer data. That is it.
- A second sponsor for every job. Pick one provider per role; the fallback is "show an error in the UI," not a second adapter.
- Generalizing to other verticals **in code**. We generalize **in the pitch**. The code does websites.
- Building the Voice Agents hackathon version inside this repo. That's two weeks out; fork later.

---

## 7. Demo Script (what the judges see)

1. Operator opens the console. Six nodes, all green-idle.
2. Operator enters: `niche = barbershops`, `city = San Francisco`. Hits Discover.
3. Scraper node pulses; leads stream into Memory node. Click Memory → see a real `BusinessProfile` doc with phone, address, signals.
4. Operator picks one lead (their own phone), clicks Call. Caller node pulses; live transcript streams in the inspector. Recording-disclosure plays first.
5. Operator (acting as the business owner) says yes. Call ends. Analyst node writes a `PostMortem` doc — visible in the Memory inspector under the same `containerTag`.
6. Mailer node fires: AgentMail thread shows up in inspector, Stripe link visible, ICS attached.
7. Operator clicks the Stripe link, completes the test checkout. Webhook flips lead to paid. Builder node lights up.
8. Builder inspector shows the embedded Lovable `liveUrl` — the judges literally watch a website being built.
9. Pitch line: *"We are not selling you an agent. We are selling you an agency. The agent works for us. The customer gets a website. The same harness runs taxes, legal, paralegal, whatever you need. We are the whole service."*

---

## 8. Operating Rules for the Rebuild

- Keep individual files under 400 LOC. If you blow past that, you are abstracting wrong.
- No invented type names. If a noun is not in this document, do not introduce it.
- Use Gemini structured outputs at every typed boundary; do not regex parse model output.
- Verify every webhook signature; trust no inbound HTTP.
- Never log raw API keys, phone numbers, or transcripts to stdout in a way that survives the demo.
- Default the run mode to **mock**. The only switch from mock → live is: env flags set, target phone is in an allow-list, and a recording-disclosure preamble is configured. No other knobs.
- Do not retry failing providers in a loop. Surface the error in the operator UI and stop the worker.
- Commit at the end of each Phase. The hackathon "we built it on-site" story requires a credible commit history — small, dated, intelligible commits during the event, not one giant pre-built squash.
- Pre-build *each Phase as its own branch* off `main` and merge in order at the event, so context windows stay clean (the user has flagged that long single contexts cause hallucination — respect it).

---

## 9. Open Questions to Resolve Before Building

Confirm these before Phase 0:

1. Which YC hackathon (the one in two weeks vs. the imminent one)? Paste the hackathon page URL into the working session so credits and sponsor list are explicit.
2. Calling credits — AgentPhone provided, or out-of-pocket? Browser Use credits — confirmed?
3. Naming. Repo is `callmemaybe`; product name TBD. Pick one before the demo deck.
4. Target phone for the live demo — must be a number the operator owns and consents to receive recorded calls on.

---

You now have the full mission, the verified stack, the delete-list, the architecture, the build order, the non-goals, and the demo script. **Start at Phase 0.** Do not patch the existing code. Delete first, then build.
