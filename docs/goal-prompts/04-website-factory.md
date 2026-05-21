# Goal: Website Factory With Real Launch Quality

You are working in `/Users/m3-max/Documents/GitHub/callan`. Upgrade the builder into a website factory that can plausibly deliver a polished $500 small-business site.

Persistence rule: do not complete this goal until a paid/mock build produces a meaningful site preview, structured QA, revisions or approval, and a launch-ready read model. If live Lovable/Browser Use is gated, keep mock/live parity strong and prove the dry run.

Verify first:
- Builder: `server/workers/builder.js`.
- Fulfillment: `server/fulfillment/*`, `server/providers/browserUse.js`, `server/providers/lovable.js`, `server/providers/v0.js`.
- QA/revision tables already exist in `server/db.js`.
- UI: `src/components/Inspector.jsx`, `BuildQAConsole.jsx`, `BrowserUseConsole.jsx`.
- Mock preview: `/api/leads/:id/build-preview`.

Mission: build a multi-pass fulfillment pipeline: brief, site creation, objective QA, revision loop, launch approval, analytics/schema/contact readiness, and customer-visible proof.

Implement:
1. Formal `WebsiteBrief` schema: pages, sections, hero, services, review proof, location/area, CTA, contact methods, commerce needs, assets/placeholders, disclaimers.
2. `LaunchChecklist`: mobile, desktop, CTA, phone/email/form, LocalBusiness schema, hours/address/area, image alt text, no fake claims, no broken links, invoice/payment state, customer/operator approval.
3. Real QA:
   - fetch/render generated page where possible
   - static HTML checks in mock mode
   - optional Playwright screenshot checks for local previews
   - persist score, errors, claims, URLs/screenshots
4. Revision loops:
   - QA failure creates structured revision prompt
   - customer edit request creates revision prompt
   - attempt count/final status persisted
   - duplicate revision issues deduped
5. Mock/live parity:
   - mock mode produces realistic generated HTML, not only a status card
   - live mode remains behind `RUN_MODE`, `LIVE_BUILDS`, provider credentials
6. Launch approval:
   - internal complete is separate from customer-approved/launched
7. UI:
   - Builder tab shows brief, checklist, QA score, failures, revisions, screenshots/live preview/final URL, approval state
   - customer portal shows a simpler version

Acceptance:
- `npm run check` passes.
- `npm run build` passes.
- Extend `npm run check:fulfillment` and `npm run check:builder-hooks` or add equivalent QA/revision/approval proof.
- `npm run demo:e2e` shows meaningful mock site preview and QA trail.
- Final answer includes before/after behavior and dry-run checks.

North-star finish line: the generated site should survive a skeptical customer clicking every obvious link on mobile and desktop.
