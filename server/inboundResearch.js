/**
 * Live "we're researching you while we talk" effect for inbound calls.
 *
 * Two layers:
 * 1. The moment an inbound call lands, emit a synthetic burst of
 *    `research.session.*` / `research.evidence.captured` events so the
 *    dashboard's Scraper box and Memory box pulse like a real swarm is
 *    crawling the caller's phone.
 * 2. When the caller mentions a business name or domain mid-call, enqueue
 *    a durable `research.browser_use` job against that business. In mock mode
 *    the job still runs the same 5-lane Browser Use swarm and streams real
 *    events through the same SSE pipeline.
 *
 * Both layers are de-duped per call so we don't double-fire.
 */

import { env } from './env.js';
import { log } from './logger.js';
import { emit } from './sse.js';
import { enqueueJob } from './jobs.js';
import { createBrowserUseResearchJob } from './research/browserUseSwarm.js';

export const INBOUND_BUSINESS_RESEARCH_JOB_TYPE = 'research.browser_use';

const startedReverseLookupForCall = new Set();
const kickedOffJobForCall = new Map(); // callId -> jobId

const RESEARCH_LANES = [
  { lane: 'reverse-phone',  label: 'Reverse phone lookup',       latency: 600 },
  { lane: 'web-search',     label: 'Public web mentions',        latency: 1200 },
  { lane: 'directories',    label: 'Local directory listings',   latency: 1800 },
  { lane: 'social',         label: 'Social media presence',      latency: 2400 },
  { lane: 'maps',           label: 'Maps + reviews',             latency: 3000 }
];

/**
 * Fires the moment an inbound call.started lands.
 * Emits a synthetic 5-lane research burst keyed off the caller's phone.
 */
export function startInboundCallerResearch({ callRow, fromNumber, lead }) {
  if (!callRow?.id) return;
  if (startedReverseLookupForCall.has(callRow.id)) return;
  startedReverseLookupForCall.add(callRow.id);

  const jobId = `inbound-research-${callRow.id}`;
  const leadId = callRow.lead_id || lead?.id || null;
  const businessName = lead?.business_name && !String(lead.business_name).startsWith('Inbound caller')
    ? lead.business_name : null;

  emit('research.job.started', {
    worker: 'scraper',
    jobId,
    niche: 'inbound caller probe',
    city: fromNumber || 'unknown',
    leadId,
    callId: callRow.id,
    trigger: 'inbound_call',
    mode: 'mock',
    lanes: RESEARCH_LANES.length
  });

  for (const lane of RESEARCH_LANES) {
    const sessionId = `${jobId}:${lane.lane}`;

    setTimeout(() => {
      emit('research.session.started', {
        worker: 'scraper',
        jobId,
        sessionId,
        lane: lane.lane,
        label: lane.label,
        leadId,
        callId: callRow.id,
        mock: true,
        target: fromNumber || 'unknown'
      });
    }, Math.max(50, lane.latency - 500));

    setTimeout(() => {
      emit('research.evidence.captured', {
        worker: 'scraper',
        jobId,
        sessionId,
        lane: lane.lane,
        leadId,
        callId: callRow.id,
        summary: synthesizeEvidence(lane.lane, { fromNumber, businessName }),
        confidence: 0.5 + Math.random() * 0.45,
        mock: true,
        capturedAt: Date.now()
      });
    }, lane.latency);

    setTimeout(() => {
      emit('research.session.completed', {
        worker: 'scraper',
        jobId,
        sessionId,
        lane: lane.lane,
        leadId,
        callId: callRow.id,
        mock: true,
        durationMs: lane.latency
      });
    }, lane.latency + 200);
  }

  setTimeout(() => {
    emit('research.job.completed', {
      worker: 'scraper',
      jobId,
      leadId,
      callId: callRow.id,
      evidenceCount: RESEARCH_LANES.length,
      durationMs: RESEARCH_LANES[RESEARCH_LANES.length - 1].latency + 300,
      mock: true
    });
  }, RESEARCH_LANES[RESEARCH_LANES.length - 1].latency + 300);

  log.info('inbound.research.synthetic_burst', { callId: callRow.id, jobId, fromNumber });
}

function synthesizeEvidence(lane, { fromNumber, businessName }) {
  const tag = businessName || (fromNumber ? `caller ${fromNumber}` : 'inbound caller');
  switch (lane) {
    case 'reverse-phone':
      return `Resolved ${fromNumber || 'inbound number'} → 3 public listings, 1 review profile.`;
    case 'web-search':
      return `Top 5 web hits for ${tag} surfaced. No spam flags. Listings consistent across sources.`;
    case 'directories':
      return `Listed in Yelp, Yellow Pages, Google Business. Hours and address agree across all three.`;
    case 'social':
      return `Instagram ~1.2k followers · last post 6 days ago · ${tag} matches handle.`;
    case 'maps':
      return `Maps rating 4.6 stars over 180 reviews · review velocity steady · open hours match listing.`;
    default:
      return `Captured evidence for ${tag} on lane ${lane}.`;
  }
}

/**
 * Fires when the inbound transcript reveals a business name we haven't researched yet.
 * Creates the existing Browser Use research job and hands execution to the
 * durable job loop.
 */
export function maybeKickOffBusinessResearch({ callRow, businessName, city }) {
  if (!callRow?.id || !businessName) return null;
  if (kickedOffJobForCall.has(callRow.id)) return kickedOffJobForCall.get(callRow.id);

  const niche = String(businessName).trim();
  if (!niche) return null;

  emit('caller.research_triggered', {
    worker: 'caller',
    leadId: callRow.lead_id,
    callId: callRow.id,
    target: niche,
    city: city || null,
    trigger: 'business_mention'
  });

  try {
    const job = createBrowserUseResearchJob({
      niche,
      city: city || 'unknown',
      maxLeads: 1,
      mode: env.runMode === 'mock' ? 'mock' : 'auto',
      idempotencyKey: `inbound-${callRow.id}-${niche.toLowerCase()}`
    });
    const durable = enqueueJob({
      type: INBOUND_BUSINESS_RESEARCH_JOB_TYPE,
      payload: { jobId: job.id, callId: callRow.id, leadId: callRow.lead_id || null, source: 'inbound_business_mention' },
      idempotencyKey: `browser_research:${job.id}`
    });
    const result = {
      jobId: job.id,
      durableJobId: durable.row?.id || null,
      inserted: durable.inserted,
      status: durable.row?.status || null
    };
    kickedOffJobForCall.set(callRow.id, result);
    emit('caller.research_queued', {
      worker: 'caller',
      leadId: callRow.lead_id,
      callId: callRow.id,
      target: niche,
      city: city || null,
      jobId: job.id,
      durableJobId: durable.row?.id || null,
      trigger: 'business_mention'
    });
    log.info('inbound.research.business_queued', {
      callId: callRow.id,
      businessName,
      jobId: job.id,
      durableJobId: durable.row?.id || null,
      inserted: durable.inserted
    });
    return result;
  } catch (err) {
    log.warn('inbound.research.business_enqueue_failed', {
      callId: callRow.id, businessName, error: err?.message || String(err)
    });
    return null;
  }
}
