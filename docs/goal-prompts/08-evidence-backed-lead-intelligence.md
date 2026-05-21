# Goal: Evidence-Backed Lead Intelligence System

You are working in `/Users/m3-max/Documents/GitHub/callan`. Make lead research so specific and evidence-backed that the cold call feels earned.

Persistence rule: do not complete until evidence flows from discovery into pitch, Moss, WebsiteBrief, GrowthPlan, and UI with citations. If live Browser Use is gated, build deterministic mock evidence with realistic source trails and keep going.

Verify first:
- Discovery: `server/workers/scraper.js`.
- Browser Use research: `server/research/browserUseSwarm.js`.
- Presence scoring/enrichment: `server/presenceScorer.js`, `server/profileEnrichment.js`.
- UI: `ScraperView`, `BrowserResearchConsole`, `Inspector`, `LeadList`, memory views.

Mission: mine reviews, competitor gaps, listings, bad website evidence, missing customer info, and public proof into a precise pitch and website brief.

Implement:
1. Expanded research schema:
   - review themes
   - positive proof
   - complaints/pain points
   - missing info customers ask for
   - competitor comparison
   - current website issues
   - social/listing consistency
   - hours/address/phone confidence
   - best CTA recommendation
   - why this lead is worth calling
2. Multi-source evidence:
   - Browser Use sessions for maps/reviews/directories/site/social where feasible
   - deterministic mock evidence with realistic source URLs
   - every claim cites evidence/source id
3. Scoring:
   - presence weakness
   - urgency
   - website value
   - contactability
   - vertical fit
   - explicit "do not call because already strong"
4. Feed downstream:
   - sales pitch
   - Moss snippets
   - WebsiteBrief
   - GrowthPlan
   - customer portal brief
5. UI:
   - evidence explorer
   - confidence badges
   - review-theme cards
   - competitor-gap cards
   - exact evidence-based call opener
6. Checks:
   - weak no-site business accepted
   - strong business visibly skipped
   - duplicate merged
   - review themes become pitch/brief evidence
   - source URL preserved
   - provider failure/fallback visible

Acceptance:
- `npm run check` passes.
- `npm run check:presence` and `npm run check:dedupe` pass or are updated truthfully.
- Add/extend `npm run check:browser-research`.
- `npm run build` passes.
- Final answer includes a sample evidence -> pitch -> brief trace.

North-star finish line: the owner should hear the first sentence and think, "annoying, but they clearly looked at my actual business."
