# Callan security best-practices audit

Audit date: 2026-07-17
Scope: React/Vite client, Express API, SQLite persistence, provider adapters, customer portal, build/release workflow, container and CI configuration.

## Executive verdict

The code is suitable for a controlled single-node production pilot after the external launch gates pass. No critical or high-severity code finding remains open in the audited paths. The current environment is **not authorized for production traffic**: credentials, live provider smokes, webhook receipts, encrypted-storage attestations, legal review, backup/restore proof, and the required staging certification are absent. The application correctly reports that state as blocked.

`npm audit --omit=dev --audit-level=high` reports **0 known vulnerabilities**. Static review found no `dangerouslySetInnerHTML`, browser `innerHTML` assignment, `eval`, `new Function`, or committed private key/API-secret pattern in application source. Only `.env.example` is tracked from the environment-file family.

## Remediated findings

### P0 — privileged Browser Use session exposed to customers

Status: fixed.

The portal and outbound preview mail previously treated a Browser Use live-session URL like a customer preview. A session URL is privileged operational access and must never cross the customer trust boundary.

Remediation:

- customer state exposes only a safe Lovable shared preview, the local generated-site route in mock mode, and the final public URL after release;
- session IDs, recordings, raw provider output, and Browser Use live URLs remain operator-only;
- preview screenshots use a purpose-scoped customer token and never disclose the upstream session URL.

### P0 — preview/approval conflated with final publication

Status: fixed.

A completed build or customer approval could previously look shipped, update the canonical website, and trigger a hosting offer before a final publication/handoff existed.

Remediation:

- QA completion, customer approval, publication, and release are separate persisted states;
- the lead's canonical `website` changes only after the explicit release gate passes;
- release requires production runtime, paid invoice, final QA, operator approval, customer approval, a clear revision queue, reachable HTTPS URL, final Lovable security review, portable source, ownership evidence, and a domain decision;
- hosting upsell is queued only after release.

### P1 — reusable/unscoped customer capability links

Status: fixed.

Remediation:

- separate token purposes exist for portal access, preview assets, hosting acceptance, and unsubscribe;
- purpose mismatch returns not found;
- tokens are random, hashed at rest, expiring, revocable, and rotated when their protected artifact changes;
- application logs and persisted outbound-message bodies redact capability URLs.

### P1 — email scanners could create a Stripe Checkout session

Status: fixed.

The hosting acceptance link used a state-changing GET. Automated security scanners commonly follow email links.

Remediation:

- GET renders a confirmation page only;
- same-origin POST creates Checkout;
- Stripe creation uses an idempotency key;
- cancel returns to a scoped customer portal rather than a raw lead identifier.

### P1 — SSRF and DNS-rebinding risk in generated-site/screenshot fetches

Status: fixed.

Remediation:

- only public HTTP(S) destinations are accepted;
- DNS is resolved and every address is rejected if private, loopback, link-local, multicast, or reserved;
- the verified public address is pinned for the request;
- redirects are bounded and revalidated;
- response size and image content type are bounded;
- the production-safety suite proves loopback, metadata, and rebinding answers are rejected.

### P1 — customer portal returned internal operational data

Status: fixed.

Remediation:

- the portal uses explicit customer read models rather than returning database/provider rows;
- raw build hooks, provider sessions, research internals, contact metadata, internal events, operator notes, and raw release evidence are omitted;
- internal contact events are filtered;
- production portal errors are generic while detailed errors remain in protected logs.

### P1 — production could launch without legal/customer policy evidence

Status: fixed as a fail-closed gate; external review still required.

Production now requires public HTTPS privacy and terms URLs plus the exact `LEGAL_REVIEW_ACK`. Policy links are exposed in the customer portal when configured. The acknowledgement is an attestation, not legal advice; it must only be set after qualified review.

### P2 — container ran with unnecessary writable surface

Status: fixed.

The runtime image now receives only production dependencies, server/scripts, and the built frontend. Compose runs read-only, drops Linux capabilities, enables `no-new-privileges`, uses a bounded `/tmp`, and mounts only the SQLite data volume writable. The image runs as the unprivileged `node` user and includes a health check and graceful `SIGTERM` path.

### P2 — decorative frontend dependency surface

Status: fixed.

The Three.js scene and its React renderers were removed. This deleted 119 packages and the roughly 890 KB scene chunk while retaining an accessible operational flow visualization.

## Security controls verified

| Control | Implementation/evidence |
| --- | --- |
| Admin authorization | Bearer-token roles; production requires named operators, no legacy shared token, and upstream MFA attestation. |
| Customer authorization | Hashed, expiring, purpose-scoped capability tokens with OTP bounds for sensitive actions. |
| CSRF/cross-origin mutation | Same-origin checks on sensitive public POSTs; admin APIs require Authorization headers. |
| Webhooks | Provider-specific signature verification, replay windows where supported, and persisted idempotency IDs. |
| HTTP headers | Helmet, per-response CSP nonce, no `X-Powered-By`, MIME sniffing protection, frame restrictions. |
| Preview isolation | Sandboxed iframe, allowlisted Lovable hosts, restricted CSP for local generated previews. |
| Input validation | Zod request schemas plus bounded string/list helpers at public API boundaries. |
| Secrets | `.env` ignored; output redaction; capability links excluded from durable mail bodies; production secret-length gates. |
| Data lifecycle | Configurable retention, transcript/body/payload redaction, expired-token cleanup, encrypted-storage attestations. |
| Job safety | Durable idempotency keys, leases, lease generations/fencing, retries, dead-letter recovery, stale-job repair. |
| Side-effect safety | Mock provenance rejected in every live mode; calls, mail, billing, browser sessions, outreach, and builds are independently gated. |
| Customer billing | Transcript-backed interest and customer-controlled email confirmation precede invoice creation. |
| Auditability | Trust ledger, contact receipts, build hooks, QA results, revision rows, release evidence, and signed safe-to-sell reports. |

## Open operational risks

These are launch blockers or accepted pilot constraints, not silently waived findings.

1. **No live environment proof (P1):** all required provider credentials, live smokes, webhook freshness, and the staging certification manifest are missing locally. Keep `RUN_MODE=mock`.
2. **Identity boundary (P1):** the supported pilot topology depends on an MFA-enforcing identity-aware reverse proxy in front of the operator console. Static named tokens alone are not an internet-facing login product.
3. **Legal jurisdiction review (P1):** automated calling, recording, email outreach, retention, privacy notice, and customer terms require qualified review for every launch jurisdiction.
4. **Single-node availability (P2):** SQLite is intentionally limited to one replica. The production gate requires explicit acceptance. It is not a horizontally scalable or multi-region architecture.
5. **Restore proof (P2):** backup code and freshness gates exist, but a real encrypted-volume backup and restore drill must be completed on the chosen host.
6. **Container runtime proof (P2):** Docker is not installed in this audit environment, so the image/Compose configuration was reviewed statically but not built here.
7. **Maintainability concentration (P2):** `server/db.js`, `server/index.js`, and `server/customerPortal.js` remain large modules. New release and customer-link boundaries were extracted, but further decomposition should happen after the pilot under characterization tests.
8. **CI supply-chain hardening (P3):** GitHub-owned actions use version tags rather than commit SHAs. Pin immutable SHAs before a regulated/high-assurance rollout.

## Required production security sequence

1. Put the operator console behind an MFA-enforced identity-aware proxy; define named least-privilege operators.
2. Store credentials in the deployment secret manager, never a committed `.env`.
3. Publish counsel-reviewed privacy and terms pages and record the legal acknowledgement.
4. Deploy one replica on encrypted persistent storage with encrypted backups.
5. Enter `production_review` with every live side-effect flag false.
6. Run dry configuration smokes, then one owned-target live smoke per provider.
7. Deliver signed webhooks and verify fresh receipts.
8. Complete the one-hour, 3× forecast-concurrency certification with zero SQLite busy errors.
9. Run a backup/restore drill and emergency-stop drill.
10. Run `npm run check:production -- --strict` and `npm run safe-to-sell`; launch only when both are green.
