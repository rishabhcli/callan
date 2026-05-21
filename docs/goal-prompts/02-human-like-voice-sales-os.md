# Goal: Human-Like Voice Sales OS

You are working in `/Users/m3-max/Documents/GitHub/callan`. Rebuild Callan's voice sales behavior into a human-like sales operating system for small-business website calls.

Persistence rule: do not mark this goal complete until mock calls demonstrate human-feeling behavior across the hard edge cases below. If the goal is too big, continue implementing the next missing behavior and its check. Only stop for a concrete blocker with evidence.

Verify first:
- Caller: `server/workers/caller.js`.
- Analyst: `server/workers/analyst.js`.
- Moss retrieval: `server/moss/*`.
- Compliance/outreach: `server/compliance.js`, `server/outreach.js`.
- Vertical packs: `server/verticalPacks/*.json`.

Mission: Callan should sound like a respectful, experienced web-agency salesperson. It must handle interruptions, skepticism, timing issues, objections, callbacks, pricing, AI disclosure, email readback, and opt-outs through a real state machine, not a thin script.

Implement:
1. Conversation state engine with persisted events: `opener`, `permission_check`, `discovery`, `value_pitch`, `objection`, `pricing`, `close`, `email_capture`, `readback_confirm`, `callback`, `opt_out`, `handoff`, `voicemail`, `no_answer`.
2. Transcript-driven transitions and next-turn guidance using profile, Moss snippets, vertical pack, prior transcript, and compliance copy.
3. Detectors for: interrupted/busy, skeptical, "how much", "is this AI", "where did you get my number", "send info", "call later", email correction, opt-out, weird/unsupported request.
4. Callback promise tracking: persist exact callback times; ask a clarifying question when no real time is given.
5. Strong email flow: spoken email parsing, readback confirmation, correction loop, confidence/source excerpt in analyst output.
6. UI/operator visibility: call state, next line, objection, Moss snippet, compliance state, and why the lead is safe/unsafe.
7. Better vertical-pack objection maps and concrete review-scraped value props.

Acceptance:
- `npm run check` passes.
- Add/extend a deterministic call-state check covering skeptical owner, busy callback, opt-out, pricing objection, email correction/readback, unsupported request, voicemail/no-answer.
- `npm run check:autonomy` and `npm run check:revenue` pass or are truthfully updated.
- Mock demo calls visibly exercise the state machine.
- Final answer separates dry-run proof from any live call proof.

North-star finish line: if a real owner says "wait, what is this and why are you calling me?", Callan should answer like a calm human who remembers the evidence, respects consent, and still knows how to close.
