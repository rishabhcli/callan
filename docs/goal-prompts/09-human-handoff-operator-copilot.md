# Goal: Human Handoff And Operator Copilot

You are working in `/Users/m3-max/Documents/GitHub/callan`. Add a real human handoff and operator copilot layer so Callan can be autonomous without pretending it can handle everything.

Persistence rule: do not complete until handoff cases are persisted, visible, actionable, and tested through resolution. If a case cannot be automated safely, create the operator workflow and keep the agent conservative.

Verify first:
- Mail reply policy: `server/workers/mailReply.js`.
- Operator transfer: `server/operatorTransfer.js`.
- UI: `OperationsView`, `RightRail`, `Inspector`, `GrowthConsole`, `BuildQAConsole`, `BrowserUseConsole`.
- Existing `audit_events`, `compliance_decisions`, and `contact_events`.

Mission: build the internal agency desk. A human can take over calls/emails/builds, approve replies, edit drafts, resolve blocked tasks, and resume safe automation.

Implement:
1. Handoff case persistence:
   - `handoff_cases` or equivalent
   - lead_id, source event, severity, category, status, assigned_to, summary, evidence, recommended_action
   - idempotency to avoid duplicates
2. Classifiers for:
   - legal/tax/security/refund/contract/guarantee/weird requests
   - angry customer
   - payment failure
   - build auth wall
   - QA failure after max revisions
   - provider failure
   - uncertain call consent
3. Operator actions:
   - approve auto-reply
   - rewrite/send reply
   - pause automation for lead
   - resume automation
   - assign callback
   - mark resolved
   - trigger/retry build or QA
4. Copilot suggestions:
   - concise summary
   - evidence citations
   - safest next action
   - draft reply with policy notes
   - "why not autonomous"
5. UI:
   - handoff queue
   - per-lead handoff card
   - action buttons
   - linked transcript/email/build evidence
   - timeline
6. Checks:
   - legal request creates case and safe reply
   - refund threat creates high severity case
   - auth wall creates builder case
   - operator approves/rejects reply
   - resolved case resumes safe automation

Acceptance:
- `npm run check` passes.
- `npm run build` passes.
- Add `npm run check:handoff` or equivalent.
- Existing growth/mail reply checks still pass.
- Final answer includes example cases and verified operator actions.

North-star finish line: Callan should feel more human because it knows exactly when not to act alone.
