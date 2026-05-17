# Fulfillment

Paid website fulfillment is target-based. Stripe paid-state handling reserves one build row through `builds.trigger_key = payment:<payment_id>`, then the builder chooses `BUILD_TARGET` / `FULFILLMENT_TARGET` / request body target, defaulting to Lovable.

## Source Notes

- Lovable Build with URL: `https://lovable.dev/?autosubmit=true#prompt=...`, required prompt in the URL hash, max 50,000 characters, and optional public image URLs as repeated `images=` params. Source: https://lovable-f9060f1e.mintlify.app/integrations/build-with-url
- Lovable prompting: use real content and specific UI atoms, not placeholder copy. Source: https://docs.lovable.dev/prompting/prompting-one
- Browser Use live view: `liveUrl` is returned when creating a session and can be embedded in an iframe; streaming comes from `client.run(...)`. Sources: https://docs.browser-use.com/cloud/tutorials/chat-ui and https://docs.browser-use.com/cloud/browser/live-preview
- v0 Platform API: programmatic projects, chats, messages, and deployments use `https://api.v0.dev` with `V0_API_KEY`. Sources: https://v0.app/docs/api/platform/overview, https://v0.app/docs/api/platform/reference/projects/create, https://v0.app/docs/api/platform/reference/chats/send-message, https://v0.app/docs/api/platform/reference/deployments/create

## Targets

- `lovable`: Browser Use opens the Lovable build-with-URL link, streams progress, detects auth walls, extracts the final `.lovable.app` URL, and stores it on the build and lead.
- `v0`: the server creates a v0 project, chat, message, and deployment through the Platform API. Mock mode returns synthetic v0 resources through the same target interface.

Live side effects stay gated by `RUN_MODE`, `LIVE_BUILDS=true`, and the target credential (`BROWSER_USE_API_KEY` for Lovable, `V0_API_KEY` for v0). Mock mode uses synthetic provider adapters but still executes target submission, progress normalization, URL extraction, and persistence.
