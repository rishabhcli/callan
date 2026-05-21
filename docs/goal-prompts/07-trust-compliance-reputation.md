# Goal: Customer Trust, Compliance, And Reputation Layer

You are working in `/Users/m3-max/Documents/GitHub/callan`. Make Callan safe and trustworthy enough for real outbound/inbound sales operation.

Persistence rule: do not complete until trust state is persisted, visible, enforced in readiness, and proven by safety checks. If a legal/compliance point is uncertain, implement conservative product guardrails and operator handoff; do not invent legal advice.

Verify first:
- Compliance: `server/compliance.js`.
- Outreach: `server/outreach.js`.
- Reputation: `server/reputation.js`, reputation tables in `server/db.js`.
- Readiness: `server/readiness.js`, `scripts/production-readiness-check.js`.
- Webhooks/security: AgentPhone, AgentMail, Stripe webhook files.

Mission: Callan must explain why it contacted someone, prove consent and opt-out handling, throttle risky behavior, and protect caller/email reputation.

Implement:
1. Trust ledger:
   - why contacted
   - source evidence
   - disclosure used
   - consent status
   - opt-out status
   - invoice consent
   - portal token events
   - complaints/provider flags
2. Stronger gates:
   - timezone/calling windows
   - business vs mobile uncertainty
   - max attempts per business and phone
   - provider flag handling
   - response policy for "where did you get my number?"
3. Reputation scoring:
   - area/campaign opt-out, voicemail, failure, complaint rates
   - automatic pause thresholds
   - daily/weekly risk summary
4. Customer trust surfaces:
   - portal "why am I seeing this?"
   - opt-out confirmation
   - privacy-safe data summary
5. Operator UI:
   - trust panel per lead
   - blockers
   - last disclosure
   - opt-out proof
   - reputation throttle state
   - emergency stop/pause state
6. Readiness gates:
   - `production_live` refuses operation if trust/reputation thresholds fail
   - webhook/secrets/smoke blockers remain truthful
7. Checks:
   - DNC before call
   - quiet hours
   - mobile/unknown risk
   - repeated attempts throttle
   - AgentMail unsubscribe
   - provider complaint pauses outreach
   - readiness blocker appears

Acceptance:
- `npm run check` passes.
- `npm run check:safety` passes.
- `npm run check:production` reports new gates truthfully.
- `npm run build` passes.
- Final answer lists new risk gates and dry-run/live proof.

North-star finish line: Callan should be able to answer "why did you contact me and how do I stop it?" instantly, calmly, and with receipts.
