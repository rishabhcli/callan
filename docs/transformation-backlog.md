# Callan Transformation Backlog

This is the internal implementation ledger for the August 4 product transformation. The backlog is intentionally concrete: every completed item has a route, persisted state, validation, and a verification command.

## Completed Phases

### Phase 1: Product reconstruction

- Mapped the existing Express, SQLite, durable-job, provider-readiness, SSE, React, and customer-portal contracts.
- Kept the existing self-correcting paid-build loop intact and moved the operator console behind `/app`.
- Made `/` a product-specific public acquisition surface instead of an internal dashboard entry point.

### Phase 2: Primary customer workflow

- Public brief form at `POST /api/public/intake`.
- Hashed random tracking tokens at `GET /api/public/intake/:token`.
- Refresh-safe status timeline with no public lead id, email, phone, provider id, or internal job payload.
- Operator research handoff through the durable `public_intake.research` job.
- Explicit isolated, non-callable lead boundary at submission; lead and request rows commit atomically and no outbound side effect is implicit.
- Failure events redact provider-like secrets before they are persisted for operator review.
- Transient research failures keep the request in `researching` while the durable job retries; `failed` is reserved for non-retryable or final attempts.
- Boot-time reconciliation relinks queued/running research jobs whose ID write was interrupted and restores stale staging when no durable job exists.

### Phase 3: Operator request queue

- Search and status filters at `/app` > **Requests**.
- Persisted claim, research, review, contact, and reject actions.
- Completed research can be retried with a fresh durable job and attempt-scoped idempotency.
- Request event history, linked lead focus, loading, empty, error, disabled, and responsive states.
- Operator route protection uses the existing role middleware and session-scoped admin token.

### Phase 4: Integration verification workbench

- Provider registry for Gemini, Supermemory, Moss, AgentPhone, Browser Use, Lovable, v0, AgentMail, and Stripe.
- Local adapter/configuration verification receipts at `/api/integrations/:provider/verify`.
- Idempotent receipt replay, redacted response storage, blocker display, and per-provider history.
- Local verification never writes a provider smoke row and never claims live readiness.

### Phase 5: Verification and release evidence

- API contracts: `npm run check:public-intake`, `npm run check:integrations`.
- Retry contract: `npm run check:public-intake-retry`.
- Crash-recovery contract: `npm run check:public-intake-recovery`.
- Browser journey: `npm run check:public-browser`.
- Existing console and portfolio browser checks now enter through `/app`; customer portal routes remain direct and scoped.
- Production build, syntax, full regression, dependency audit, graceful shutdown, security-header, and strict readiness gates remain required.

## Deferred Production Gates

These are external/operator configuration tasks, not hidden product work:

- Configure identity-backed admin credentials and MFA at the production proxy.
- Configure each provider and signed webhook, then run owned-target live smokes with fresh receipts.
- Provision HTTPS, encrypted storage, encrypted off-host backups, restore evidence, legal/privacy review, and provider certification.
- Run the strict release commands in `README.md` only after the above evidence is fresh.

## Mock And Fake Surface Classification

- `RUN_MODE=mock`, deterministic demo lifecycle, and fixture/eval scripts are development-only paths. They share schemas and persistence but are labeled mock and do not represent live provider proof.
- The new integration workbench uses `verified_local` and `blocked_configuration`, never `live` or `provider smoke`.
- The existing Lovable preview remains a temporary review artifact; release still requires the established source, ownership, security, domain, payment, QA, and customer approval gates.
- No public request path uses `TODO`, `coming soon`, a fake success response, or an unscoped lead id as its tracking credential.
