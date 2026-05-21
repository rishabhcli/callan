# callan (Agentic cold-calling web agency demo)

## Project Overview
Callan is an agentic cold-calling web agency demo. It simulates a service business that finds a weak-presence local business, calls it, sells a website, invoices the lead, and autonomously builds the website. The operator console allows for visibility into each step of the pipeline.

The agent stack coordinates several external providers:
- **Gemini / Google DeepMind:** The core reasoning brain (lead scoring, pitch generation, call analysis, etc.) using structured output (`gemini-3.1-pro-preview`).
- **Supermemory:** Durable, long-lived per-customer memory (`containerTag` isolation).
- **Moss:** Sub-10ms latency retrieval cache for the live voice turn.
- **Browser Use:** Cloud browser operation to handle lead research and drive Lovable.
- **Lovable (or v0):** Customer-visible website build surface driven via Browser Use.
- **AgentPhone:** Outbound voice calls and call transcript delivery.
- **AgentMail:** Persistent customer email thread for invoicing, ICS handoff, and replies.
- **Stripe:** Payment links and hosted invoices.

## Technologies
- **Backend:** Node.js (Express), SQLite (`better-sqlite3`), Zod (validation schemas).
- **Frontend:** React 19, Vite, Three.js (`@react-three/fiber`, `@react-three/drei`).
- **Data & Configuration:** Local `.env` management, file-based data (`.data/` directory).

## Getting Started

### Local Setup
1. Duplicate the environment template:
   ```sh
   cp .env.example .env
   ```
2. Configure keys in `.env` (Gemini API key, Supermemory, etc.). The project defaults to `RUN_MODE=mock`, which is safe and avoids live side-effects.
3. Install dependencies:
   ```sh
   npm install
   ```

### Running the Application

- **Full Development Mode (API + Vite UI):**
  ```sh
  npm run dev
  ```
  *(To use the mock seeded data directory instead: `DATA_DIR=.data npm run dev`)*

- **One-Command Mock E2E Demo:**
  Seeds mock data (leads, fake transcripts, invoices, mock builds), runs the build, and starts the server locally to verify routes.
  ```sh
  npm run demo:e2e
  ```

- **Run Server Only:**
  ```sh
  npm run server
  ```

- **Production Build:**
  ```sh
  npm run build
  npm run start
  ```

## Testing & Verifying
The project relies on deterministic check scripts for various sub-systems:
- **Reasoning:** `npm run check:reasoning`
- **Revenue Path:** `npm run check:revenue`
- **Browser Console:** `npm run check:browser-console`
- **Fulfillment / Autonomy / Ops:** e.g., `npm run check:fulfillment`, `npm run check:autonomy`, `npm run check:ops`
- **Safety / Production Readiness:** `npm run check:safety`, `npm run safe-to-sell`
- **Provider Smoke:** `npm run smoke:providers`

## Development Conventions
- **Structured LLM Outputs:** The backend uses Gemini's `responseMimeType: "application/json"` and `responseJsonSchema` strictly synced with local Zod schemas in `server/reasoning/schemas.js`. Do not use Gemini for unstructured string generation unless explicitly needed.
- **Live Gating:** Changes that interact with money (Stripe), real-world communications (AgentPhone, AgentMail), or spend (Browser Use) **must** respect the `RUN_MODE` gates and explicit `LIVE_*` toggles (`LIVE_CALLS`, `LIVE_EMAILS`, etc.) configured in `.env`.
- **Durable Memory & History:** Events, webhook events, and memories are written permanently to SQLite or Supermemory. Treat these sources as append-only ledgers.
- **Idempotency:** When adding webhook logic or async jobs (like mail processing or scheduling), ensure they use idempotency keys.
