# Goal: True Customer Operating Room

You are working in `/Users/m3-max/Documents/GitHub/callan`. Turn Callan's customer-facing share link into a real client operating room for a $500 website service.

Persistence rule: do not mark this goal complete until the portal feels like a production client workspace and every acceptance check below passes. If the work is too large for one turn, keep implementing the next highest-leverage slice instead of returning a plan. Only stop early for a hard blocker proven with exact command output or file evidence.

Verify first:
- Customer portal: `src/views/ShareView.jsx`, `server/customerPortal.js`, `/api/share/build/:token` in `server/index.js`.
- Current token is effectively `lead.id`; production should use signed/random expiring tokens.
- Existing actions: view build, accept quote, request edit, book callback, opt out.
- Existing systems: Stripe, AgentMail, scheduled calls, Supermemory, builds, build QA/revisions, growth plans.

Mission: make the share link the customer's agency workspace. They should understand the offer, finish intake, approve scope, pay, watch the build, request edits, approve launch, schedule calls, and see what Callan has done.

Implement:
1. Add durable portal tokens: opaque or signed token, active token per lead, expiry/rotation, local/demo fallback for old lead-id links only.
2. Add richer portal state API: business profile, quote, invoice/payment, build, QA, revisions, callbacks, contact events, memory-derived brief, launch checklist, and next action.
3. Add portal actions: intake update, approve scope, approve launch, revision request, asset URL/mock asset record, callback, opt-out.
4. Add persistence as needed: `portal_tokens`, `customer_intake`, `portal_actions`/approvals, revision linkage to existing `build_revisions`, `contact_events`, and memory.
5. Redesign `ShareView`: status header, live frame, business brief, invoice panel, intake form, revision queue, approvals, callback scheduler, privacy/opt-out, account-manager timeline.
6. Keep live side effects behind existing `RUN_MODE` and `LIVE_*` gates.

Acceptance:
- `npm run check` passes.
- `npm run build` passes.
- Add `npm run check:portal` or equivalent deterministic proof for token, intake, accept, revision, callback, opt-out, approval.
- `npm run demo:e2e` still works and exposes a usable portal link.
- Final answer lists changed files, URL pattern, and dry-run proof.

North-star finish line: a stranger who paid $500 can use this page without calling you, and it still feels like a careful human agency is managing their website.
