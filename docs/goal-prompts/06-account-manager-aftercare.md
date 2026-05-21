# Goal: Account Manager Memory And Proactive Aftercare

You are working in `/Users/m3-max/Documents/GitHub/callan`. Make Callan feel like a persistent account manager after the first website sale.

Persistence rule: do not complete until aftercare tasks are persisted, scheduled, explainable, visible, and dry-run verified. If live emails are gated, generate preview sends and continue implementing.

Verify first:
- Memory: `server/memory.js`, `memory_documents`, `memory_write_queue`.
- Growth: `server/growth/*`.
- AgentMail replies/follow-up: `server/workers/mailReply.js`, `server/growth/followup.js`.
- Scheduled callbacks: `server/scheduledCalls.js`.
- Hosting upsell: `server/hostingSubscription.js`.

Mission: after delivery, Callan should remember promises, watch for stale business facts, suggest improvements, schedule check-ins, and behave like a careful account manager without spamming.

Implement:
1. `AccountManagerPlan` model:
   - promised edits
   - stale facts to re-check
   - launch follow-up
   - review capture
   - Google Business Profile hygiene
   - seasonal hours
   - service/menu changes
   - analytics/contact-flow check
   - hosting/subscription status
2. Task persistence:
   - `account_tasks` or equivalent
   - due_at, priority, channel, status, evidence_ids, owner, idempotency key
   - history and completion notes
3. Proactive scheduler:
   - dry-run by default
   - emits tasks and preview messages
   - sends AgentMail only with `LIVE_EMAILS` and policy gates
   - respects opt-outs, frequency caps, quiet windows, unsupported handoff
4. Memory retrieval:
   - avoid asking repeated questions
   - cite remembered fact/event that triggered the check-in
5. Customer touchpoints:
   - portal shows pending/recent aftercare
   - email copy feels like an account manager, not a newsletter
6. Operator controls:
   - approve/send/pause/complete/reassign task
   - explain why now
   - show evidence and risk
7. Checks:
   - 24h post-launch check
   - seasonal-hours reminder
   - review request after delivery
   - stale phone/hours correction
   - opt-out blocks proactive sends
   - frequency cap blocks spam

Acceptance:
- `npm run check` passes.
- `npm run build` passes.
- Add `npm run check:aftercare` or equivalent.
- Growth and AgentMail checks still pass.
- Final answer includes generated aftercare examples and dry-run/live-capable split.

North-star finish line: a customer should feel Callan quietly remembers their business better than a normal freelancer would.
