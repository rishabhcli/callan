/**
 * AgentMail inbox poller — safety net for inbound emails when the AgentMail
 * webhook isn't (or can't be) pointed at our local tunnel.
 *
 * Every POLL_INTERVAL_MS we list the inbox's recent messages, diff against a
 * bounded in-memory Set of seen IDs, and enqueue any genuinely new inbound
 * message as a durable mail.reply job. The first tick after startup is
 * bootstrap-only — it records everything currently in the inbox as "already
 * seen" so we never re-process historical messages as fresh.
 *
 * Idempotency: the enqueue handoff uses the same agentmail:<eventId> key as
 * the webhook route, handleAgentMailInbound de-dupes via addContactEventOnce
 * (DB-backed), and emailCallback.maybePlaceEmailCallback de-dupes via its own
 * per-event TTL Map.
 */

import { env } from './env.js';
import { log } from './logger.js';
import { fetchAgentMailIncomingMessages } from './providers/agentmail.js';
import { enqueueMailReplyJob } from './mailReplyQueue.js';

const POLL_INTERVAL_MS = 5_000;
const MAX_SEEN = 200;
const seen = new Set();
let bootstrapped = false;
let timer = null;
let inFlight = false;

async function tick() {
  if (inFlight) return; // skip if previous tick is still running
  if (!env.agentmail?.apiKey || !env.agentmail?.inboxId) return;
  inFlight = true;
  try {
    const { messages = [] } = await fetchAgentMailIncomingMessages({ limit: 20 });
    await processAgentMailPollerMessages(messages);
  } catch (err) {
    log.warn('agentmail.poll.tick_failed', { error: err?.message || String(err) });
  } finally {
    inFlight = false;
  }
}

export async function processAgentMailPollerMessages(messages = [], {
  enqueue = enqueueMailReplyJob
} = {}) {
  if (!bootstrapped) {
    for (const m of messages) {
      if (m.messageId) seen.add(m.messageId);
    }
    bootstrapped = true;
    log.info('agentmail.poll.bootstrapped', { count: messages.length });
    return { bootstrapped: true, count: messages.length, queued: 0, failed: 0 };
  }

  // Newest-first -> reverse to process in chronological order.
  const fresh = messages
    .filter((m) => m.messageId && !seen.has(m.messageId))
    .reverse();

  const jobs = [];
  const failures = [];
  for (const m of fresh) {
    const eventId = `poll:${m.messageId}`;
    try {
      const queued = enqueue({
        normalized: m,
        body: m,
        eventId,
        source: 'agentmail.poller'
      });
      seen.add(m.messageId);
      log.info('agentmail.poll.new_message', {
        messageId: m.messageId,
        fromEmail: m.fromEmail,
        subject: m.subject,
        jobId: queued?.row?.id,
        inserted: queued?.inserted
      });
      jobs.push({ messageId: m.messageId, eventId, jobId: queued?.row?.id, inserted: queued?.inserted });
    } catch (err) {
      failures.push({ messageId: m.messageId, error: err?.message || String(err) });
      log.error('agentmail.poll.enqueue_failed', {
        messageId: m.messageId,
        error: err?.message || String(err)
      });
    }
  }

  if (seen.size > MAX_SEEN) {
    const arr = [...seen];
    seen.clear();
    for (const id of arr.slice(-MAX_SEEN)) seen.add(id);
  }
  return { bootstrapped: false, count: messages.length, fresh: fresh.length, queued: jobs.length, failed: failures.length, jobs, failures };
}

export function startAgentMailPoller() {
  if (timer) return;
  if (!env.agentmail?.apiKey || !env.agentmail?.inboxId) {
    log.info('agentmail.poll.skipped', { reason: 'not_configured' });
    return;
  }
  tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  log.info('agentmail.poll.started', { intervalMs: POLL_INTERVAL_MS });
}

export function stopAgentMailPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function _resetAgentMailPollerState() {
  seen.clear();
  bootstrapped = false;
}
