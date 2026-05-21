// Reputation auto-throttle. Sibling to compliance.js — protects outbound caller-id
// reputation by tracking per-area-code call ceilings, rolling opt-out rate, and
// voicemail-only spike rates. Emits `reputation.alert` SSE events and can pause
// the outreach loop when any metric crosses a red threshold.
//
// Counters live in the `reputation_events` table (see server/db.js). The schema
// is { id, kind, area_code, lead_id, severity, metadata_json, created_at } and
// we use kinds: 'call_attempted', 'voicemail_only', 'opt_out'.
//
// All public helpers are defensive: if `phone` is null/empty we return
// `ok: true` rather than blocking outreach, and rate calculations short-circuit
// to `rate: 0, alert: false` when the denominator is zero.

import { db, reputationEvents, trustLedger } from './db.js';
import { emit } from './sse.js';
import { log } from './logger.js';
// NOTE: outreach.js imports server/workers/caller.js, and caller.js imports
// from this module. ESM live bindings make this safe at evaluation time
// because outreach helpers are only invoked at runtime (loop ticks / pause
// requests), not during module load. We still use a getter-style accessor so
// that any future refactor that imports reputation earlier than outreach does
// not trip on a temporal-dead-zone reference.
let _outreachModule = null;
async function outreachModule() {
  if (!_outreachModule) _outreachModule = await import('./outreach.js');
  return _outreachModule;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_AREA_CODE_DAILY_LIMIT = 40;
const OPT_OUT_RED_THRESHOLD = 0.05;          // > 5% of dialed leads in last 24h
const VOICEMAIL_RED_THRESHOLD = 0.8;         // >= 80% of last 25 calls
const FAILURE_RED_THRESHOLD = 0.35;          // >= 35% failed provider outcomes in last 24h
const FAILURE_MIN_SAMPLE = 5;
const COMPLAINT_RED_THRESHOLD = 0;           // any complaint/provider abuse flag pauses
const VOICEMAIL_WINDOW = 25;
const LOOP_INTERVAL_MS = 30 * 1000;
const WEEK_MS = 7 * DAY_MS;

const VOICEMAIL_ONLY_OUTCOMES = new Set([
  'failed:voicemail',
  'failed:no_answer',
  'no_answer',
  'voicemail',
  'unreachable'
]);

function dailyLimit() {
  const raw = Number(process.env.REPUTATION_AREA_CODE_DAILY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AREA_CODE_DAILY_LIMIT;
}

// E.164-ish area-code extraction. US/CA: +1XXX...; everything else: best-effort
// fall-back to country-code+next two digits. Returns null when not derivable.
export function extractAreaCode(phone) {
  if (!phone) return null;
  const s = String(phone).trim();
  if (!s) return null;
  const normalized = s.startsWith('+') ? s : `+${s.replace(/[^\d]/g, '')}`;
  const digits = normalized.replace(/[^\d]/g, '');
  if (!digits) return null;
  if (normalized.startsWith('+1') && digits.length >= 4) {
    return digits.slice(1, 4); // 3-digit NANP area code
  }
  // International best-effort: take the 3 digits after the country code's
  // first digit. Not perfect, but good enough as a bucketing key for reputation.
  if (digits.length >= 5) return digits.slice(1, 4);
  return null;
}

function isVoicemailOnlyOutcome(outcome) {
  if (!outcome) return false;
  const o = String(outcome).toLowerCase();
  if (VOICEMAIL_ONLY_OUTCOMES.has(o)) return true;
  return o.startsWith('failed:voicemail') || o.startsWith('failed:no_answer');
}

function isFailureOutcome(outcome) {
  if (!outcome) return false;
  const o = String(outcome).toLowerCase();
  return /^failed[:_-]/.test(o) ||
    /\b(busy|no_answer|not_answered|blocked|rejected|invalid|error|unreachable|provider_failed|reputation_block)\b/.test(o);
}

function campaignForLead(leadId) {
  if (!leadId) return 'unknown';
  try {
    const row = db.prepare(`SELECT niche, city FROM leads WHERE id = ?`).get(leadId);
    if (!row) return 'unknown';
    return [row.niche || 'local', row.city || 'unknown'].join(':').toLowerCase();
  } catch {
    return 'unknown';
  }
}

function phoneForLead(leadId) {
  if (!leadId) return null;
  try {
    return db.prepare(`SELECT phone FROM leads WHERE id = ?`).get(leadId)?.phone || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event recorders
// ---------------------------------------------------------------------------

export function recordCallAttempt({ leadId = null, phone, outcome = null } = {}) {
  if (!phone) return;
  const areaCode = extractAreaCode(phone);
  const campaign = campaignForLead(leadId);
  try {
    reputationEvents.record({
      kind: 'call_attempted',
      area_code: areaCode,
      lead_id: leadId,
      severity: 'info',
      metadata: { outcome: outcome || null, phone, campaign }
    });
    if (isVoicemailOnlyOutcome(outcome)) {
      reputationEvents.record({
        kind: 'voicemail_only',
        area_code: areaCode,
        lead_id: leadId,
        severity: 'info',
        metadata: { outcome, phone, campaign }
      });
    }
  } catch (err) {
    log?.warn?.('reputation.record_call_attempt_failed', { error: err?.message || String(err) });
  }
}

export function recordOptOut({ leadId = null, phone } = {}) {
  if (!phone) return;
  const areaCode = extractAreaCode(phone);
  const campaign = campaignForLead(leadId);
  try {
    reputationEvents.record({
      kind: 'opt_out',
      area_code: areaCode,
      lead_id: leadId,
      severity: 'warn',
      metadata: { phone, campaign }
    });
  } catch (err) {
    log?.warn?.('reputation.record_opt_out_failed', { error: err?.message || String(err) });
  }
}

export function recordProviderFlag({
  provider,
  kind = 'provider_flag',
  leadId = null,
  phone = null,
  severity,
  reason = null,
  metadata = {}
} = {}) {
  const normalizedKind = /complaint|abuse|dnc|carrier_block/i.test(String(kind || reason || ''))
    ? 'provider_complaint'
    : 'provider_flag';
  const resolvedSeverity = severity || (normalizedKind === 'provider_complaint' ? 'alert' : 'warn');
  const areaCode = extractAreaCode(phone || phoneForLead(leadId));
  try {
    reputationEvents.record({
      kind: normalizedKind,
      area_code: areaCode,
      lead_id: leadId,
      severity: resolvedSeverity,
      metadata: {
        provider: provider || 'unknown',
        providerKind: kind,
        reason,
        campaign: campaignForLead(leadId),
        ...metadata
      }
    });
    trustLedger.add({
      lead_id: leadId || null,
      event_type: normalizedKind,
      actor: provider || 'provider',
      channel: provider || 'provider',
      direction: 'inbound',
      subject_id: metadata.eventId || metadata.callId || metadata.contactEventId || null,
      decision_code: `reputation.${normalizedKind}`,
      summary: reason || `${provider || 'Provider'} reported ${normalizedKind}.`,
      metadata: {
        provider: provider || 'unknown',
        providerKind: kind,
        severity: resolvedSeverity,
        reason,
        phone: phone || phoneForLead(leadId) || null,
        areaCode,
        campaign: campaignForLead(leadId),
        ...metadata
      },
      dedupe_key: metadata.eventId || metadata.callId || metadata.contactEventId
        ? `trust_provider_flag:${provider || 'provider'}:${metadata.eventId || metadata.callId || metadata.contactEventId}:${normalizedKind}`
        : null
    });
  } catch (err) {
    log?.warn?.('reputation.record_provider_flag_failed', { error: err?.message || String(err) });
  }
  if (normalizedKind === 'provider_complaint' || resolvedSeverity === 'alert') {
    pauseForReputation(`reputation_${normalizedKind}`).catch((err) => {
      log?.warn?.('reputation.provider_flag_pause_failed', { error: err?.message || String(err) });
    });
  }
}

// ---------------------------------------------------------------------------
// Status accessors
// ---------------------------------------------------------------------------

export function areaCodeStatus(areaCode, now = Date.now()) {
  const limit = dailyLimit();
  if (!areaCode) {
    return { areaCode: null, attempts24h: 0, limit, blocked: false, remainingBeforeBlock: limit };
  }
  const since = now - DAY_MS;
  let attempts = 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM reputation_events
      WHERE kind = 'call_attempted' AND area_code = ? AND created_at >= ?
    `).get(areaCode, since);
    attempts = row?.n || 0;
  } catch (err) {
    log?.warn?.('reputation.area_code_status_failed', { error: err?.message || String(err) });
  }
  return {
    areaCode,
    attempts24h: attempts,
    limit,
    blocked: attempts >= limit,
    remainingBeforeBlock: Math.max(0, limit - attempts)
  };
}

export function recentOptOutRate(now = Date.now()) {
  const since = now - DAY_MS;
  let dialed = 0;
  let optouts = 0;
  try {
    dialed = db.prepare(`
      SELECT COUNT(*) AS n FROM reputation_events
      WHERE kind = 'call_attempted' AND created_at >= ?
    `).get(since).n || 0;
    optouts = db.prepare(`
      SELECT COUNT(*) AS n FROM reputation_events
      WHERE kind = 'opt_out' AND created_at >= ?
    `).get(since).n || 0;
  } catch (err) {
    log?.warn?.('reputation.opt_out_rate_failed', { error: err?.message || String(err) });
  }
  const rate = dialed > 0 ? optouts / dialed : 0;
  return {
    window: '24h',
    dialed,
    optouts,
    rate,
    redThreshold: OPT_OUT_RED_THRESHOLD,
    alert: dialed > 0 && rate > OPT_OUT_RED_THRESHOLD
  };
}

export function recentVoicemailRate() {
  // Inspect the last 25 calls regardless of age. We rely on the `calls`
  // table for ground truth on outcomes (calls.finish stores the outcome).
  let voicemailOnly = 0;
  let total = 0;
  try {
    const rows = db.prepare(`
      SELECT outcome FROM calls
      WHERE outcome IS NOT NULL
      ORDER BY started_at DESC
      LIMIT ?
    `).all(VOICEMAIL_WINDOW);
    total = rows.length;
    for (const row of rows) {
      if (isVoicemailOnlyOutcome(row.outcome)) voicemailOnly += 1;
    }
  } catch (err) {
    log?.warn?.('reputation.voicemail_rate_failed', { error: err?.message || String(err) });
  }
  const denominator = total > 0 ? total : VOICEMAIL_WINDOW;
  const rate = total > 0 ? voicemailOnly / total : 0;
  return {
    window: `last ${VOICEMAIL_WINDOW}`,
    voicemailOnly,
    total: denominator,
    sampleSize: total,
    rate,
    redThreshold: VOICEMAIL_RED_THRESHOLD,
    alert: total > 0 && rate >= VOICEMAIL_RED_THRESHOLD
  };
}

function topAreaCodes(limit = 5, now = Date.now()) {
  const since = now - DAY_MS;
  const ceiling = dailyLimit();
  try {
    const rows = db.prepare(`
      SELECT area_code, COUNT(*) AS attempts
      FROM reputation_events
      WHERE kind = 'call_attempted' AND created_at >= ? AND area_code IS NOT NULL
      GROUP BY area_code
      ORDER BY attempts DESC
      LIMIT ?
    `).all(since, limit);
    return rows.map((row) => ({
      areaCode: row.area_code,
      attempts24h: row.attempts,
      limit: ceiling,
      remainingBeforeBlock: Math.max(0, ceiling - row.attempts),
      blocked: row.attempts >= ceiling
    }));
  } catch (err) {
    log?.warn?.('reputation.top_area_codes_failed', { error: err?.message || String(err) });
    return [];
  }
}

function reputationRowsSince(sinceMs) {
  try {
    return db.prepare(`
      SELECT * FROM reputation_events
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `).all(sinceMs);
  } catch (err) {
    log?.warn?.('reputation.rows_since_failed', { error: err?.message || String(err) });
    return [];
  }
}

function summarizeReputationWindow({ sinceMs, label }) {
  const rows = reputationRowsSince(sinceMs);
  const attempts = rows.filter((row) => row.kind === 'call_attempted');
  const optOuts = rows.filter((row) => row.kind === 'opt_out');
  const voicemails = rows.filter((row) => row.kind === 'voicemail_only');
  const complaints = rows.filter((row) => row.kind === 'provider_complaint');
  const providerFlags = rows.filter((row) => row.kind === 'provider_flag' || row.kind === 'provider_complaint');
  const failures = attempts.filter((row) => isFailureOutcome(safeJson(row.metadata_json)?.outcome));
  return {
    window: label,
    attempts: attempts.length,
    optOuts: optOuts.length,
    voicemailOnly: voicemails.length,
    failures: failures.length,
    complaints: complaints.length,
    providerFlags: providerFlags.length,
    optOutRate: rate(optOuts.length, attempts.length),
    voicemailRate: rate(voicemails.length, attempts.length),
    failureRate: rate(failures.length, attempts.length),
    complaintRate: rate(complaints.length, Math.max(attempts.length, 1)),
    areaOptOutRates: rateByKey({ attempts, numerator: optOuts, key: 'area_code' }).slice(0, 8),
    campaignOptOutRates: rateByCampaign({ attempts, numerator: optOuts }).slice(0, 8)
  };
}

function recentFailureRate(now = Date.now()) {
  const summary = summarizeReputationWindow({ sinceMs: now - DAY_MS, label: '24h' });
  return {
    window: '24h',
    failed: summary.failures,
    dialed: summary.attempts,
    rate: summary.failureRate,
    redThreshold: FAILURE_RED_THRESHOLD,
    minSample: FAILURE_MIN_SAMPLE,
    alert: summary.attempts >= FAILURE_MIN_SAMPLE && summary.failureRate >= FAILURE_RED_THRESHOLD
  };
}

function recentComplaintRate(now = Date.now()) {
  const summary = summarizeReputationWindow({ sinceMs: now - WEEK_MS, label: '7d' });
  return {
    window: '7d',
    complaints: summary.complaints,
    attempts: summary.attempts,
    rate: summary.complaintRate,
    redThreshold: COMPLAINT_RED_THRESHOLD,
    alert: summary.complaints > COMPLAINT_RED_THRESHOLD
  };
}

function providerComplaintBlock(now = Date.now()) {
  const since = now - WEEK_MS;
  try {
    const row = db.prepare(`
      SELECT * FROM reputation_events
      WHERE kind = 'provider_complaint' AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(since);
    if (!row) return null;
    return {
      id: row.id,
      leadId: row.lead_id || null,
      areaCode: row.area_code || null,
      createdAt: row.created_at,
      metadata: safeJson(row.metadata_json)
    };
  } catch {
    return null;
  }
}

function rate(num, den) {
  return den > 0 ? num / den : 0;
}

function rateByKey({ attempts, numerator, key }) {
  const totals = new Map();
  for (const row of attempts) {
    const k = row[key] || 'unknown';
    totals.set(k, { key: k, attempts: (totals.get(k)?.attempts || 0) + 1, count: totals.get(k)?.count || 0 });
  }
  for (const row of numerator) {
    const k = row[key] || 'unknown';
    const entry = totals.get(k) || { key: k, attempts: 0, count: 0 };
    entry.count += 1;
    totals.set(k, entry);
  }
  return [...totals.values()]
    .map((entry) => ({ ...entry, rate: rate(entry.count, entry.attempts) }))
    .sort((a, b) => b.rate - a.rate || b.count - a.count);
}

function rateByCampaign({ attempts, numerator }) {
  const withCampaign = (row) => safeJson(row.metadata_json)?.campaign || 'unknown';
  const totals = new Map();
  for (const row of attempts) {
    const k = withCampaign(row);
    totals.set(k, { campaign: k, attempts: (totals.get(k)?.attempts || 0) + 1, count: totals.get(k)?.count || 0 });
  }
  for (const row of numerator) {
    const k = withCampaign(row);
    const entry = totals.get(k) || { campaign: k, attempts: 0, count: 0 };
    entry.count += 1;
    totals.set(k, entry);
  }
  return [...totals.values()]
    .map((entry) => ({ ...entry, rate: rate(entry.count, entry.attempts) }))
    .sort((a, b) => b.rate - a.rate || b.count - a.count);
}

// ---------------------------------------------------------------------------
// Pre-call gate
// ---------------------------------------------------------------------------

export function canDialPhone(phone) {
  const complaint = providerComplaintBlock();
  if (complaint) {
    return {
      ok: false,
      reason: `provider_complaint_pause:${complaint.metadata?.provider || 'provider'} (${complaint.metadata?.reason || 'recent complaint'})`,
      areaCode: complaint.areaCode || null,
      remainingBeforeBlock: 0,
      complaint
    };
  }
  if (!phone) {
    return { ok: true, reason: null, areaCode: null, remainingBeforeBlock: null };
  }
  const areaCode = extractAreaCode(phone);
  if (!areaCode) {
    return { ok: true, reason: null, areaCode: null, remainingBeforeBlock: null };
  }
  const status = areaCodeStatus(areaCode);
  if (status.blocked) {
    return {
      ok: false,
      reason: `area_code_daily_limit_exceeded:${areaCode} (${status.attempts24h}/${status.limit})`,
      areaCode,
      remainingBeforeBlock: 0,
      attempts24h: status.attempts24h,
      limit: status.limit
    };
  }
  return {
    ok: true,
    reason: null,
    areaCode,
    remainingBeforeBlock: status.remainingBeforeBlock,
    attempts24h: status.attempts24h,
    limit: status.limit
  };
}

// ---------------------------------------------------------------------------
// Evaluator + scheduler
// ---------------------------------------------------------------------------

async function isOutreachPaused() {
  try {
    const mod = await outreachModule();
    const status = mod.outreachStatus();
    return !!status?.paused;
  } catch {
    return false;
  }
}

async function pauseForReputation(reason) {
  const paused = await isOutreachPaused();
  if (paused) return { paused: true, changed: false };
  const mod = await outreachModule();
  mod.pauseOutreachLoop({ reason });
  return { paused: true, changed: true };
}

export async function evaluateAndMaybePause(now = Date.now()) {
  const triggers = [];

  // 1. Area-code ceiling — flag any area code that is at/over the limit in the
  //    last 24h. Per-call gate is the primary block; this is a secondary alert.
  const top = topAreaCodes(10, now);
  const blockedAreas = top.filter((row) => row.blocked);
  if (blockedAreas.length) {
    triggers.push({
      kind: 'area_code_ceiling',
      severity: 'warn',
      details: { blocked: blockedAreas, redThreshold: dailyLimit() }
    });
  }

  // 2. Rolling 24h opt-out rate.
  const optOut = recentOptOutRate(now);
  if (optOut.alert) {
    triggers.push({
      kind: 'opt_out_rate',
      severity: 'alert',
      details: optOut
    });
  }

  // 3. Last-25 voicemail-only rate.
  const voicemail = recentVoicemailRate();
  if (voicemail.alert) {
    triggers.push({
      kind: 'voicemail_only_rate',
      severity: 'warn',
      details: voicemail
    });
  }

  // 4. Provider failure rate.
  const failure = recentFailureRate(now);
  if (failure.alert) {
    triggers.push({
      kind: 'failure_rate',
      severity: 'warn',
      details: failure
    });
  }

  // 5. Provider/customer complaints. Any recent complaint fails closed.
  const complaint = recentComplaintRate(now);
  if (complaint.alert) {
    triggers.push({
      kind: 'provider_complaint',
      severity: 'alert',
      details: complaint
    });
  }

  if (!triggers.length) {
    return { ok: true, triggers: [], paused: await isOutreachPaused() };
  }

  // Emit per-trigger SSE alerts so the dashboard can show context.
  for (const trigger of triggers) {
    try {
      reputationEvents.record({
        kind: `alert.${trigger.kind}`,
        severity: trigger.severity,
        metadata: trigger.details
      });
    } catch (err) {
      log?.warn?.('reputation.alert_record_failed', { kind: trigger.kind, error: err?.message || String(err) });
    }
    emit('reputation.alert', {
      worker: 'reputation',
      kind: trigger.kind,
      severity: trigger.severity,
      details: trigger.details
    });
  }

  // Auto-pause only when an opt_out_rate or voicemail-rate trigger is present
  // (per spec). Area-code ceiling is handled by the per-call gate, not the loop.
  const pauseTrigger = triggers.find((t) => (
    t.kind === 'opt_out_rate' ||
    t.kind === 'voicemail_only_rate' ||
    t.kind === 'failure_rate' ||
    t.kind === 'provider_complaint'
  ));
  let paused = await isOutreachPaused();
  if (pauseTrigger && !paused) {
    try {
      await pauseForReputation(`reputation_${pauseTrigger.kind}`);
      paused = true;
    } catch (err) {
      log?.warn?.('reputation.pause_failed', { reason: pauseTrigger.kind, error: err?.message || String(err) });
    }
  }

  return { ok: false, triggers, paused };
}

let loopTimer = null;

export function startReputationLoop() {
  if (loopTimer) return { running: true, intervalMs: LOOP_INTERVAL_MS };
  loopTimer = setInterval(() => {
    Promise.resolve(evaluateAndMaybePause()).catch((err) => {
      log?.warn?.('reputation.loop_tick_failed', { error: err?.message || String(err) });
    });
  }, LOOP_INTERVAL_MS);
  // Kick once so a fresh boot has a baseline (fire-and-forget).
  Promise.resolve(evaluateAndMaybePause()).catch(() => { /* swallow */ });
  emit('reputation.loop_started', { intervalMs: LOOP_INTERVAL_MS });
  return { running: true, intervalMs: LOOP_INTERVAL_MS };
}

export function stopReputationLoop() {
  if (!loopTimer) return { running: false };
  clearInterval(loopTimer);
  loopTimer = null;
  return { running: false };
}

// ---------------------------------------------------------------------------
// Status endpoint payload
// ---------------------------------------------------------------------------

export async function reputationStatus(now = Date.now()) {
  const areaCodes = topAreaCodes(5, now);
  const optOut = recentOptOutRate(now);
  const voicemail = recentVoicemailRate();
  const failure = recentFailureRate(now);
  const complaint = recentComplaintRate(now);
  const daily = summarizeReputationWindow({ sinceMs: now - DAY_MS, label: '24h' });
  const weekly = summarizeReputationWindow({ sinceMs: now - WEEK_MS, label: '7d' });
  const readiness = reputationReadinessReport(now);
  let alerts = [];
  try {
    alerts = reputationEvents.recentAlerts({ sinceMs: now - DAY_MS, limit: 40 })
      .filter((row) => row.severity === 'warn' || row.severity === 'alert');
  } catch (err) {
    log?.warn?.('reputation.recent_alerts_failed', { error: err?.message || String(err) });
  }
  return {
    ok: true,
    ts: now,
    config: {
      areaCodeDailyLimit: dailyLimit(),
      optOutRedThreshold: OPT_OUT_RED_THRESHOLD,
      voicemailRedThreshold: VOICEMAIL_RED_THRESHOLD,
      failureRedThreshold: FAILURE_RED_THRESHOLD,
      failureMinSample: FAILURE_MIN_SAMPLE,
      complaintRedThreshold: COMPLAINT_RED_THRESHOLD,
      voicemailWindow: VOICEMAIL_WINDOW,
      loopIntervalMs: LOOP_INTERVAL_MS
    },
    areaCodes,
    topAreaCodes: areaCodes,
    optOut,
    optOutRate: optOut,
    voicemail,
    voicemailRate: voicemail,
    failure,
    complaint,
    dailySummary: daily,
    weeklySummary: weekly,
    readiness,
    paused: await isOutreachPaused(),
    recentAlerts: alerts.map((row) => ({
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      areaCode: row.area_code || null,
      leadId: row.lead_id || null,
      createdAt: row.created_at,
      metadata: safeJson(row.metadata_json)
    }))
  };
}

export function reputationReadinessReport(now = Date.now()) {
  const areaCodes = topAreaCodes(10, now);
  const optOut = recentOptOutRate(now);
  const voicemail = recentVoicemailRate();
  const failure = recentFailureRate(now);
  const complaint = recentComplaintRate(now);
  const daily = summarizeReputationWindow({ sinceMs: now - DAY_MS, label: '24h' });
  const weekly = summarizeReputationWindow({ sinceMs: now - WEEK_MS, label: '7d' });
  const gates = [
    gate('area_code_ceiling', !areaCodes.some((row) => row.blocked), `${areaCodes.filter((row) => row.blocked).length} area codes over daily ceiling`),
    gate('opt_out_rate', !optOut.alert, `${pct(optOut.rate)} over ${pct(OPT_OUT_RED_THRESHOLD)} threshold`),
    gate('voicemail_rate', !voicemail.alert, `${pct(voicemail.rate)} over ${pct(VOICEMAIL_RED_THRESHOLD)} threshold`),
    gate('failure_rate', !failure.alert, `${failure.failed}/${failure.dialed} failed provider outcomes`),
    gate('provider_complaint', !complaint.alert, `${complaint.complaints} complaint/provider-abuse flags in ${complaint.window}`)
  ];
  const blockers = gates.filter((row) => !row.ok).map((row) => `reputation gate ${row.name} failed: ${row.detail}`);
  return {
    ok: blockers.length === 0,
    gates,
    blockers,
    dailySummary: daily,
    weeklySummary: weekly,
    thresholds: {
      areaCodeDailyLimit: dailyLimit(),
      optOutRedThreshold: OPT_OUT_RED_THRESHOLD,
      voicemailRedThreshold: VOICEMAIL_RED_THRESHOLD,
      failureRedThreshold: FAILURE_RED_THRESHOLD,
      failureMinSample: FAILURE_MIN_SAMPLE,
      complaintRedThreshold: COMPLAINT_RED_THRESHOLD
    }
  };
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function gate(name, ok, detail) {
  return {
    name,
    ok: Boolean(ok),
    detail,
    nextAction: ok ? 'monitor' : `pause_outreach_and_review_${name}`
  };
}

function pct(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}
