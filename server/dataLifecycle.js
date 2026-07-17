import { auditTrail, db } from './db.js';
import { env } from './env.js';
import { log } from './logger.js';

let retentionTimer = null;

export function purgeExpiredSensitiveData({ now = Date.now(), dryRun = false } = {}) {
  const day = 24 * 60 * 60 * 1000;
  const cutoffs = {
    calls: now - env.privacy.callTranscriptRetentionDays * day,
    reasoning: now - env.privacy.reasoningTraceRetentionDays * day,
    contacts: now - env.privacy.contactBodyRetentionDays * day,
    webhooks: now - env.privacy.webhookPayloadRetentionDays * day,
    jobs: now - env.privacy.jobPayloadRetentionDays * day,
    portalTokens: now - env.privacy.expiredPortalTokenRetentionDays * day
  };

  const count = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n || 0);
  const planned = {
    callTranscripts: count(`SELECT COUNT(*) AS n FROM calls WHERE transcript_json IS NOT NULL AND COALESCE(ended_at, started_at) < ?`, cutoffs.calls),
    reasoningTraces: count(`SELECT COUNT(*) AS n FROM reasoning_traces WHERE created_at < ? AND (prompt_json IS NOT NULL OR evidence_json IS NOT NULL OR raw_output IS NOT NULL OR final_output_json IS NOT NULL)`, cutoffs.reasoning),
    contactBodies: count(`SELECT COUNT(*) AS n FROM contact_events WHERE created_at < ? AND body IS NOT NULL AND type NOT LIKE '%opt_out%' AND type NOT LIKE '%do_not_call%'`, cutoffs.contacts),
    webhookPayloads: count(`SELECT COUNT(*) AS n FROM webhook_events WHERE received_at < ? AND payload_json IS NOT NULL`, cutoffs.webhooks),
    jobPayloads: count(`SELECT COUNT(*) AS n FROM jobs WHERE status IN ('completed', 'failed', 'dead_letter') AND COALESCE(finished_at, updated_at) < ? AND (payload_json <> '{}' OR result_json IS NOT NULL OR error IS NOT NULL)`, cutoffs.jobs),
    portalTokens: count(`SELECT COUNT(*) AS n FROM portal_tokens WHERE status IN ('expired', 'revoked') AND expires_at < ?`, cutoffs.portalTokens)
  };
  if (dryRun) return { ok: true, dryRun: true, now, cutoffs, planned, changed: {} };

  const changed = db.transaction(() => ({
    callTranscripts: db.prepare(`UPDATE calls SET transcript_json = NULL WHERE transcript_json IS NOT NULL AND COALESCE(ended_at, started_at) < ?`).run(cutoffs.calls).changes,
    reasoningTraces: db.prepare(`
      UPDATE reasoning_traces
      SET prompt_json = NULL, evidence_json = NULL, raw_output = NULL, repaired_output = NULL, final_output_json = NULL, validation_errors_json = NULL
      WHERE created_at < ?
    `).run(cutoffs.reasoning).changes,
    contactBodies: db.prepare(`
      UPDATE contact_events
      SET body = NULL
      WHERE created_at < ? AND body IS NOT NULL AND type NOT LIKE '%opt_out%' AND type NOT LIKE '%do_not_call%'
    `).run(cutoffs.contacts).changes,
    webhookPayloads: db.prepare(`UPDATE webhook_events SET payload_json = NULL WHERE received_at < ? AND payload_json IS NOT NULL`).run(cutoffs.webhooks).changes,
    jobPayloads: db.prepare(`
      UPDATE jobs
      SET payload_json = '{}', result_json = NULL, error = NULL
      WHERE status IN ('completed', 'failed', 'dead_letter') AND COALESCE(finished_at, updated_at) < ?
    `).run(cutoffs.jobs).changes,
    portalTokens: db.prepare(`DELETE FROM portal_tokens WHERE status IN ('expired', 'revoked') AND expires_at < ?`).run(cutoffs.portalTokens).changes
  }))();

  auditTrail.add({
    created_at: now,
    event_type: 'privacy.retention_applied',
    actor: 'data_lifecycle',
    entity_type: 'system',
    entity_id: 'privacy_retention',
    action: 'purged',
    metadata: { changed, cutoffs }
  });
  return { ok: true, dryRun: false, now, cutoffs, planned, changed };
}

export function startDataRetentionScheduler() {
  if (!env.privacy.retentionEnabled) return { running: false, reason: 'disabled' };
  if (retentionTimer) return { running: true, alreadyRunning: true, intervalMs: env.privacy.retentionIntervalMs };
  const run = () => {
    try {
      log.info('privacy.retention_completed', purgeExpiredSensitiveData());
    } catch (err) {
      log.error('privacy.retention_failed', { error: err?.message || String(err) });
    }
  };
  run();
  retentionTimer = setInterval(run, Math.max(60_000, env.privacy.retentionIntervalMs));
  retentionTimer.unref?.();
  return { running: true, intervalMs: env.privacy.retentionIntervalMs };
}

export function stopDataRetentionScheduler() {
  if (retentionTimer) clearInterval(retentionTimer);
  retentionTimer = null;
  return { running: false };
}
