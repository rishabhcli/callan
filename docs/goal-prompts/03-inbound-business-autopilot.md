# Goal: Inbound "Describe My Business" Autopilot

You are working in `/Users/m3-max/Documents/GitHub/callan`. Make the claim true: someone can call or email Callan, describe their business, and Callan handles the rest.

Persistence rule: do not mark complete until both inbound voice and inbound email can create or update a lead, gather missing info, produce a portal/quote path, and prove it in deterministic checks. If live providers are gated, implement dry-run/mock proof and keep going.

Verify first:
- Inbound intent: `server/inboundIntent.js`.
- AgentPhone webhook/caller paths: `server/webhooks/agentphone.js`, `server/workers/caller.js`.
- AgentMail inbound: `server/webhooks/agentmail.js`, `server/workers/mailReply.js`.
- Lead upsert/research/memory/invoice/scheduled-call/builder flows already exist.

Mission: a new owner should be able to say "I run a barber shop in Oakland; build me a site" by call or email. Callan should identify the business, ask only missing questions, scrape/enrich public facts, create the lead, generate a quote/portal, schedule follow-up, and prepare the website brief.

Implement:
1. Shared inbound intake state machine for phone and email:
   - extract business name, niche, city, phone, email, services, area, hours, current site/socials, desired CTA, urgency, price acknowledgement
   - track missing fields and ask one concise follow-up at a time
   - classify intent: info, quote, invoice, callback, build start, edits, opt-out
2. Inbound lead upsert/dedupe:
   - unknown callers/senders create leads
   - dedupe by phone/email/name/city/source URL
   - source marked `inbound_voice` or `inbound_email`
   - intake facts written to local memory/Supermemory path
3. Trigger research/enrichment after intake and merge public evidence with supplied facts.
4. Generate website brief and portal/quote path.
5. Email-first flow: inbound email can request a site, receive missing-info request or portal/quote, then approve by reply.
6. Voice-first flow: inbound call captures info and sends summary/portal/invoice or schedules callback.
7. UI: inbound sessions panel showing extracted facts, missing fields, next action, transcript/thread, portal link.

Acceptance:
- `npm run check` passes.
- `npm run build` passes.
- Add `npm run check:inbound-anything` or equivalent.
- `npm run demo:e2e` still passes.
- Final answer includes a LinkedIn-claim coverage table: claim, path, dry-run proof, live caveats.

North-star finish line: Callan should be able to onboard a business from a messy voicemail or casual email and still produce a credible paid website workflow.
