# Callan deployment runbook

Callan is deployable as one Node 22 container with a persistent SQLite volume. The repository defaults to fail-closed mock behavior; production side effects remain disabled until the production review and live gates are explicitly satisfied. The supported production shape is a controlled single-node pilot, not an unrestricted horizontally scaled or multi-tenant service.

## Release gate

Use Node 22.12 or newer within the Node 22 line:

```sh
nvm use
npm ci
npx playwright install chromium
npm run check:deploy
```

`check:deploy` is the code/artifact gate. It does not prove third-party credentials or perform live provider actions. Those are verified separately with the production readiness and provider smoke commands.

## Required runtime configuration

Start from `.env.example`. At minimum, every production container needs:

```sh
NODE_ENV=production
RUN_MODE=production_review
APP_PUBLIC_URL=https://your-public-origin.example
DATA_DIR=/app/.data
# Named, role-scoped credentials delivered through an MFA-protected access layer.
ADMIN_API_TOKEN=
ADMIN_API_TOKENS_JSON='[{"id":"founder@example.com","role":"admin","token":"replace-with-secret-manager-value-32+-chars"}]'
ADMIN_MFA_ENFORCED=true
PORTAL_TOKEN_SECRET=replace-with-an-independent-32+-char-secret
SAFETY_INTERLOCK_SECRET=replace-with-an-independent-32+-char-secret
TRUST_PROXY_HOPS=1

DATA_RETENTION_ENABLED=true
DATA_AT_REST_ENCRYPTED=true
BACKUPS_ENCRYPTED=true
APP_REPLICA_COUNT=1
SINGLE_NODE_PILOT_ACK=I_ACCEPT_SINGLE_NODE_PILOT_LIMITS
PROVIDER_CERTIFICATION_FILE=/app/config/provider-certification.json

LIVE_CALLS=false
LIVE_EMAILS=false
LIVE_PAYMENTS=false
LIVE_BROWSER_SESSIONS=false
LIVE_PUBLIC_OUTREACH=false
LIVE_BUILDS=false
```

Set `TRUST_PROXY_HOPS=1` only when exactly one trusted platform proxy overwrites forwarded headers before requests reach Express. Keep it at `0` for direct access or local Docker.

Add provider keys and webhook secrets from `.env.example`. Do not use `VITE_*` variables for secrets: frontend build variables are public. Put the app behind an identity-aware proxy that enforces MFA, source `ADMIN_API_TOKENS_JSON` and both signing secrets from a secret manager, and give each person a separate role-scoped credential. The app records the named actor but does not implement OIDC or MFA itself. The operator credential remains in browser memory only.

Copy `config/provider-certification.example.json` to a deployment-owned location. Complete every required provider entry with owned-target staging receipts and add a fresh load test: at least 60 minutes, at least three times forecast concurrent workflows, zero SQLite busy errors, plus webhook-burst, SSE-fanout, and slow-provider verification. Do not manufacture this file from local mocks; production readiness treats it as the external qualification record and expires it after 90 days.

## Build and start

```sh
docker compose build
docker compose up -d
curl --fail https://your-public-origin.example/api/ping
```

The image is multi-stage, installs from `package-lock.json`, rebuilds native SQLite dependencies on Linux, drops development packages, runs as the unprivileged `node` user, and exposes a container health check on `/api/ping`.

The `.data` mount is mandatory. It contains the SQLite database, WAL files, backups, durable jobs, smoke receipts, and operational evidence. Back it up independently of the container image.

## Register provider webhooks

Point providers at the deployed HTTPS origin:

```text
AgentPhone  https://your-public-origin.example/api/webhooks/agentphone
AgentMail   https://your-public-origin.example/api/webhooks/agentmail
Stripe      https://your-public-origin.example/api/webhooks/stripe
```

Use the matching webhook secrets in the runtime environment. Callan verifies provider signatures and records webhook IDs for idempotency.

## Promote safely

1. Deploy with `RUN_MODE=production_review` and every `LIVE_*` flag false.
2. Confirm authenticated `/api/health` and the Operations production checklist.
3. Run the dry/config report:

   ```sh
   npm run check:production
   npm run smoke:providers
   ```

4. Run one intentionally scoped live smoke at a time against owned test targets. The exact commands are in `README.md`.
5. Confirm webhook delivery, fresh smoke receipts, the signed safe-to-sell snapshot, and a completed provider/capacity certification manifest.
6. Run `npm run check:production -- --strict` and `npm run safe-to-sell`; both must pass without report-only overrides.
7. Only then set:

   ```sh
   RUN_MODE=production_live
   PRODUCTION_LIVE_ACK=I_UNDERSTAND_LIVE_OUTREACH
   ```

8. Enable only the `LIVE_*` capabilities you are ready to operate. Every provider call rechecks the pause, live flag, lead budget, job lease, production acknowledgement, and signed readiness snapshot immediately before the side effect.

## Operational constraints

- Run exactly one application replica. SQLite, in-process schedulers, and the durable-job claimant are designed for a single process. `APP_REPLICA_COUNT=1` and the explicit pilot acknowledgement are production gates. Horizontal scaling requires moving persistence/leases to a shared database and coordinating schedulers first.
- Terminate TLS at the platform proxy and preserve the public HTTPS origin in `APP_PUBLIC_URL`.
- Keep `/api/ping` public for liveness. Operator data and controls require a named role-scoped bearer credential behind the identity-aware proxy.
- Customer portal links are bearer links for reads, expire after seven days by default, are stored only as hashes, and rotate after sensitive changes. Production-sensitive actions also require the emailed OTP.
- Keep `PREVIEW_FRAME_SOURCES` and `PREVIEW_IMAGE_SOURCES` restricted to the exact preview and asset hosts in use; the production CSP does not allow arbitrary HTTPS frames or images.
- The retention scheduler redacts expired transcript, reasoning, contact, webhook, job, and portal-token data. Monitor its audit receipts and verify encrypted database and backup storage outside the application.
- Monitor the Operations command center, backup freshness, provider smoke freshness, worker failure budgets, economics limits, reputation gates, and the emergency-stop control.
- Graceful shutdown waits for the HTTP server to stop accepting work, stops schedulers/pollers, and closes SQLite. Give the container at least 15 seconds before force termination.

## Rollback

1. Set all `LIVE_*` flags to `false` or switch to `RUN_MODE=production_review`.
2. Redeploy the previous image while retaining the same `.data` volume.
3. Verify `/api/ping`, authenticated `/api/health`, and backup freshness.
4. If data recovery is needed, use the application backup manifests and `npm run ops:backup`; do not replace a live SQLite file without stopping the process first.
