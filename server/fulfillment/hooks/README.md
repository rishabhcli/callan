# Builder Hook QA Gate

This folder owns the shipment gate between "builder returned a URL" and "lead is shipped." Mock mode and live mode both run the same hooks:

1. `preBrief`
2. `briefValidate`
3. `preSubmit`
4. `postSubmit`
5. `siteInspect`
6. `revisionPlan`
7. `finalAccept`

The key product rule: a provider URL is not a shipped website. The generated site must pass QA first, and revision attempts are persisted before final acceptance.

## Source Notes

- Lovable Build with URL accepts `https://lovable.dev/?autosubmit=true#prompt=...` and optional repeated `images=` URL params; prompts should stay concise/focused and image URLs must be public. Source: https://docs.lovable.dev/integrations/build-with-url
- Lovable prompting guidance emphasizes real content, clear user journeys, specific visual direction, and structured/scoped prompts. Source: https://docs.lovable.dev/prompting
- Browser Use sessions return a `liveUrl` that can be embedded, and follow-up tasks can reuse a session for inspection after generation. Sources: https://docs.browser-use.com/cloud/tips/live-view/iframe-embed and https://docs.browser-use.com/cloud/agent/follow-up-tasks
- Browser Use tasks are suitable for natural-language testing and data extraction, but this implementation keeps live Browser Use QA behind `BUILDER_QA_BROWSER_USE=true`; deterministic HTML/fetch QA runs by default. Source: https://docs.browser-use.com/guides/tasks
- v0 can create projects/chats/deployments programmatically, but generated code or deployments are still treated as candidate output until this QA gate passes. Sources: https://v0.dev/docs/api/platform/overview, https://v0.dev/docs/api/platform/reference/projects/create, and https://v0.dev/docs/api/platform/reference/deployments/create

## Data Model

- `build_hooks`: one persisted row for each hook execution, keyed by build/hook/attempt idempotency.
- `build_qa_results`: the generated-site checklist, pass/fail score, detected claim issues, and inspected URL.
- `build_revisions`: targeted revision prompts and provider/mock submission results.

The related status endpoint is `GET /api/leads/:id/build-qa`, and lead detail also includes `builderQa` for the operator console.

## Live Side Effects

Default QA uses static HTML or fetch inspection. Live Browser Use site inspection and revision submission only happen when the builder is already running live and `BUILDER_QA_BROWSER_USE=true` is set. No phone calls, emails, invoices, or paid browser sessions are started by this hook layer on its own.
