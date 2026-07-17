# Fulfillment

Paid website fulfillment is target-based. Stripe paid-state handling reserves one build row through `builds.trigger_key = payment:<payment_id>`, then the builder chooses `BUILD_TARGET` / `FULFILLMENT_TARGET` / request body target. Production should set `BUILD_TARGET=lovable` explicitly.

## Source Notes

- Lovable Build with URL: `https://lovable.dev/?autosubmit=true#prompt=...`, required prompt in the URL hash, max 50,000 characters, and optional public image URLs as repeated `images=` params. Source: https://docs.lovable.dev/integrations/build-with-url
- Lovable shared previews are public, view-only, and temporary (up to seven days); publishing is a separate permanent deployment step. Source: https://docs.lovable.dev/features/share-project
- Final delivery requires a post-change security review, permanent HTTPS publish, source portability, a customer domain decision, and customer ownership/handoff evidence. Sources: https://docs.lovable.dev/features/publish and https://docs.lovable.dev/integrations/github
- Lovable prompting: use real content and specific UI atoms, not placeholder copy. Source: https://docs.lovable.dev/prompting/prompting-one
- Browser Use live view is privileged operator-only session access. It must never be emailed to a customer or returned by the customer portal. Streaming comes from `client.run(...)`. Sources: https://docs.browser-use.com/cloud/tutorials/chat-ui and https://docs.browser-use.com/cloud/browser/live-preview
- v0 Platform API: programmatic projects, chats, messages, and deployments use `https://api.v0.dev` with `V0_API_KEY`. Sources: https://v0.app/docs/api/platform/overview, https://v0.app/docs/api/platform/reference/projects/create, https://v0.app/docs/api/platform/reference/chats/send-message, https://v0.app/docs/api/platform/reference/deployments/create

## Targets

- `lovable`: Browser Use uses a persistent authenticated profile, selects the configured Lovable workspace, opens Build with URL, streams progress, detects auth/workspace walls, and creates a temporary shared preview for QA and customer review. A preview never replaces the lead's canonical website.
- `v0`: the server creates a v0 project, chat, message, and deployment through the Platform API. Mock mode returns synthetic v0 resources through the same target interface.

Live Lovable side effects stay gated by `RUN_MODE`, `LIVE_BUILDS=true`, `BROWSER_USE_API_KEY`, `BROWSER_USE_PROFILE_ID`, and `LOVABLE_WORKSPACE_NAME`. Mock mode uses synthetic provider adapters but still executes target submission, progress normalization, URL extraction, and persistence. The explicit release endpoint is the only path that marks a build launched or writes the final website URL to the lead.
