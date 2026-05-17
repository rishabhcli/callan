import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.js';
import { emit } from '../sse.js';
import { log } from '../logger.js';
import { scoreOnlinePresence } from '../presenceScorer.js';
import { enrichBusinessProfile } from '../profileEnrichment.js';
import {
  BrowserUseCloudAdapter,
  modelSelectionPolicy,
  normalizeCostAndTokenUsage,
  normalizeSessionStatus
} from '../providers/browserUse.js';
import { BrowserResearchOutputSchema, SOURCE_TYPES, validateSourceType } from './schemas.js';
import { leads as leadsTable } from '../db.js';
import { addDoc, containerTagFor } from '../memory.js';

const DEFAULT_MAX_LEADS = 8;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_SESSION_TIMEOUT_MS = 12 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_SESSION_MAX_COST_USD = '0.35';
const JOB_TERMINAL = new Set(['completed', 'failed', 'stopped']);

mkdirSync(env.dataDir, { recursive: true });
const researchDb = new Database(join(env.dataDir, 'callmemaybe.db'));
researchDb.pragma('journal_mode = WAL');
researchDb.pragma('foreign_keys = ON');

researchDb.exec(`
  CREATE TABLE IF NOT EXISTS research_jobs (
    id TEXT PRIMARY KEY,
    niche TEXT NOT NULL,
    city TEXT NOT NULL,
    max_leads INTEGER NOT NULL,
    concurrency INTEGER NOT NULL,
    max_cost_usd TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    stopped_at INTEGER,
    accepted_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    detail_json TEXT,
    idempotency_key TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_research_jobs_idempotency
    ON research_jobs(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS browser_sessions (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    provider_session_id TEXT,
    source_type TEXT NOT NULL,
    source_label TEXT,
    model TEXT,
    status TEXT NOT NULL,
    normalized_status TEXT NOT NULL,
    live_url TEXT,
    last_step_summary TEXT,
    output_count INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    max_cost_usd TEXT,
    keep_alive INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER,
    stopped_at INTEGER,
    raw_json TEXT,
    error TEXT,
    idempotency_key TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_sessions_idempotency
    ON browser_sessions(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_browser_sessions_job ON browser_sessions(job_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_browser_sessions_status ON browser_sessions(status, updated_at);

  CREATE TABLE IF NOT EXISTS research_evidence (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    session_id TEXT,
    provider_session_id TEXT,
    source_type TEXT NOT NULL,
    business_name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    hours TEXT,
    website_url TEXT,
    social_urls_json TEXT,
    services_json TEXT,
    reviews_json TEXT,
    source_evidence_json TEXT,
    source_url TEXT,
    presence_strength TEXT,
    confidence REAL,
    skipped INTEGER NOT NULL DEFAULT 0,
    skipped_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL,
    raw_json TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_research_evidence_dedupe ON research_evidence(dedupe_key);
  CREATE INDEX IF NOT EXISTS idx_research_evidence_job ON research_evidence(job_id, business_name);
  CREATE INDEX IF NOT EXISTS idx_research_evidence_presence ON research_evidence(presence_strength, skipped);
`);
ensureResearchColumn('research_jobs', 'max_cost_usd', 'TEXT');

const activeJobs = new Map();

export function browserResearchLiveEnabled() {
  return Boolean(env.browserUse.apiKey) &&
    env.runMode !== 'mock' &&
    (bool(process.env.BROWSER_USE_LIVE_RESEARCH) || bool(process.env.LIVE_BROWSER_RESEARCH) || bool(process.env.LIVE_RESEARCH));
}

export function createBrowserUseResearchJob(input = {}) {
  const now = Date.now();
  const job = normalizeJobInput(input, now);
  const existing = job.idempotencyKey ? researchDb.prepare(`
    SELECT * FROM research_jobs WHERE idempotency_key = ?
  `).get(job.idempotencyKey) : null;
  if (existing && !JOB_TERMINAL.has(existing.status)) return rowJob(existing);

  researchDb.prepare(`
    INSERT INTO research_jobs (
      id, niche, city, max_leads, concurrency, max_cost_usd, mode, status, requested_at, detail_json, idempotency_key
    )
    VALUES (@id, @niche, @city, @maxLeads, @concurrency, @maxCostUsd, @mode, 'queued', @requestedAt, @detailJson, @idempotencyKey)
    ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
      niche = excluded.niche,
      city = excluded.city,
      max_leads = excluded.max_leads,
      concurrency = excluded.concurrency,
      max_cost_usd = excluded.max_cost_usd,
      mode = excluded.mode,
      status = 'queued',
      requested_at = excluded.requested_at,
      started_at = NULL,
      finished_at = NULL,
      stopped_at = NULL,
      error = NULL,
      detail_json = excluded.detail_json
  `).run(job);
  const saved = job.idempotencyKey ? researchDb.prepare(`
    SELECT * FROM research_jobs WHERE idempotency_key = ?
  `).get(job.idempotencyKey) : null;
  return saved ? rowJob(saved) : getResearchJob(job.id);
}

export async function startBrowserUseResearchJob(input = {}) {
  const job = createBrowserUseResearchJob(input);
  await runBrowserUseResearchJob({ jobId: job.id });
  return getBrowserResearchStatus({ jobId: job.id });
}

export async function runBrowserUseResearchJob({ jobId }) {
  const job = getResearchJob(jobId);
  if (!job) throw new Error(`research job ${jobId} not found`);
  if (JOB_TERMINAL.has(job.status)) return getBrowserResearchStatus({ jobId });

  const active = {
    controller: new AbortController(),
    providerSessions: new Map(),
    startedAt: Date.now()
  };
  activeJobs.set(jobId, active);

  markJobStarted(job);
  emit('research.job.started', publicJobEvent(job));

  try {
    const sources = sourcePlan(job);
    await runLimited(sources, job.concurrency, (source) => runSourceSession({ job, source, active }));
    if (active.controller.signal.aborted) {
      markJobStopped(job.id);
      emit('research.job.stopped', publicJobEvent(getResearchJob(job.id)));
    } else {
      refreshJobCounts(job.id, { status: 'completed', finished_at: Date.now() });
      emit('research.job.completed', publicJobEvent(getResearchJob(job.id)));
    }
  } catch (err) {
    if (active.controller.signal.aborted) {
      markJobStopped(job.id);
      emit('research.job.stopped', publicJobEvent(getResearchJob(job.id)));
    } else {
      markJobFailed(job.id, err);
      emit('research.job.failed', { ...publicJobEvent(getResearchJob(job.id)), error: err?.message || String(err) });
      throw err;
    }
  } finally {
    activeJobs.delete(jobId);
  }

  return getBrowserResearchStatus({ jobId });
}

export async function stopBrowserUseResearchJob({ jobId, strategy = 'session' } = {}) {
  const target = jobId || latestJobId();
  if (!target) return { stopped: false, reason: 'no_job' };
  const active = activeJobs.get(target);
  const job = getResearchJob(target);
  if (!job) return { stopped: false, reason: 'not_found' };

  researchDb.prepare(`
    UPDATE research_jobs SET status = 'stopping', stopped_at = COALESCE(stopped_at, ?) WHERE id = ?
  `).run(Date.now(), target);

  if (active) active.controller.abort();

  const sessions = listBrowserUseResearchSessions({ jobId: target, activeOnly: true });
  if (browserResearchLiveEnabled()) {
    const adapter = new BrowserUseCloudAdapter({ eventWorker: 'browser_research' });
    await Promise.allSettled(sessions
      .filter((session) => session.providerSessionId)
      .map((session) => adapter.stopSession(session.providerSessionId, {
        strategy,
        sourceType: session.sourceType
      })));
  }
  for (const session of sessions) {
    updateSession(session.id, {
      status: 'stopped',
      normalized_status: 'stopped',
      stopped_at: Date.now(),
      finished_at: session.finishedAt || Date.now()
    });
  }
  markJobStopped(target);
  emit('research.job.stopped', publicJobEvent(getResearchJob(target)));
  return { stopped: true, jobId: target };
}

export function getBrowserResearchStatus({ jobId } = {}) {
  const target = jobId || latestJobId();
  const job = target ? getResearchJob(target) : null;
  const sessions = target ? listBrowserUseResearchSessions({ jobId: target }) : [];
  const evidence = target ? listResearchEvidence({ jobId: target }) : [];
  return {
    job,
    sessions,
    evidence,
    businesses: groupEvidenceByBusiness(evidence),
    summary: summarizeStatus({ job, sessions, evidence }),
    liveResearchEnabled: browserResearchLiveEnabled(),
    modePolicy: browserResearchLiveEnabled() ? 'live_browser_use_cloud' : 'mock_same_orchestration_path',
    liveBlockers: browserResearchLiveBlockers()
  };
}

export function listBrowserUseResearchSessions({ jobId, activeOnly = false, limit = 100 } = {}) {
  const target = jobId || latestJobId();
  if (!target) return [];
  const rows = activeOnly
    ? researchDb.prepare(`
      SELECT * FROM browser_sessions
      WHERE job_id = ? AND normalized_status IN ('queued', 'starting', 'running', 'idle')
      ORDER BY started_at ASC
      LIMIT ?
    `).all(target, limit)
    : researchDb.prepare(`
      SELECT * FROM browser_sessions
      WHERE job_id = ?
      ORDER BY started_at ASC
      LIMIT ?
    `).all(target, limit);
  return rows.map(rowSession);
}

export function listResearchEvidence({ jobId, limit = 500 } = {}) {
  const target = jobId || latestJobId();
  if (!target) return [];
  return researchDb.prepare(`
    SELECT * FROM research_evidence
    WHERE job_id = ?
    ORDER BY business_name COLLATE NOCASE ASC, created_at ASC
    LIMIT ?
  `).all(target, limit).map(rowEvidence);
}

export async function discoverBrowserUseResearchProfiles({ niche, city, count = 4, runId = null, mode = 'auto' } = {}) {
  const result = await startBrowserUseResearchJob({
    niche,
    city,
    maxLeads: count,
    concurrency: Math.min(DEFAULT_CONCURRENCY, Math.max(1, count)),
    mode,
    sourceRunId: runId,
    idempotencyKey: null
  });
  const accepted = result.evidence.filter((item) => !item.skipped).slice(0, count);
  return {
    jobId: result.job?.id,
    mode: result.job?.mode || 'unknown',
    profiles: accepted.map((item) => evidenceToBusinessProfile(item, { niche, city })),
    skipped: result.evidence
      .filter((item) => item.skipped)
      .map((item) => ({
        businessName: item.businessName,
        sourceUrl: item.sourceUrl,
        sourceName: item.sourceType,
        phase: 'browser_use_research',
        reason: item.skippedReason
      })),
    failed: [],
    providerFailures: [],
    fallbackEvents: result.job?.mode === 'mock' ? [{ from: 'browser_use_live', to: 'mock', reason: 'Live Browser Use research is not enabled.' }] : []
  };
}

async function runSourceSession({ job, source, active }) {
  const now = Date.now();
  const sessionId = localSessionId(job.id, source.type);
  const selectedModel = modelSelectionPolicy({ sourceType: source.type, ambiguous: source.ambiguous });
  const maxCostUsd = source.maxCostUsd || process.env.BROWSER_USE_RESEARCH_MAX_COST_USD || DEFAULT_SESSION_MAX_COST_USD;
  const keepAlive = shouldKeepAlive(source);

  upsertSession({
    id: sessionId,
    job_id: job.id,
    provider_session_id: null,
    source_type: source.type,
    source_label: source.label,
    model: selectedModel,
    status: 'queued',
    normalized_status: 'queued',
    live_url: null,
    last_step_summary: 'Queued for Browser Use Cloud research.',
    output_count: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    max_cost_usd: String(maxCostUsd),
    keep_alive: keepAlive ? 1 : 0,
    started_at: now,
    updated_at: now,
    raw_json: null,
    error: null,
    idempotency_key: `${job.id}:${source.type}`
  });
  emit('research.session.started', publicSessionEvent(getSessionRow(sessionId), job));

  if (active.controller.signal.aborted) return;
  if (job.mode === 'mock') {
    await runMockSourceSession({ job, source, sessionId, selectedModel, maxCostUsd, keepAlive, active });
  } else {
    await runLiveSourceSession({ job, source, sessionId, selectedModel, maxCostUsd, keepAlive, active });
  }
}

async function runMockSourceSession({ job, source, sessionId, selectedModel, maxCostUsd, keepAlive, active }) {
  const providerSessionId = `mock_bu_${job.id.slice(-6)}_${source.type}`;
  active.providerSessions.set(sessionId, providerSessionId);
  const liveUrl = `/mock/browser-use/${encodeURIComponent(job.id)}/${encodeURIComponent(source.type)}`;
  updateSession(sessionId, {
    provider_session_id: providerSessionId,
    live_url: liveUrl,
    status: 'running',
    normalized_status: 'running',
    last_step_summary: `Opening ${source.label} for ${job.niche} in ${job.city}.`,
    raw_json: jsonText({ providerSessionId, mock: true, liveUrl })
  });
  emit('research.session.live_url', publicSessionEvent(getSessionRow(sessionId), job));
  emit('research.session.progress', publicSessionEvent(getSessionRow(sessionId), job));

  const sessionStepDelay = mockStepDelayMs();
  for (const step of mockSteps(source, { job })) {
    if (active.controller.signal.aborted) break;
    await delay(sessionStepDelay);
    updateSession(sessionId, { last_step_summary: step, updated_at: Date.now() });
    emit('research.session.progress', publicSessionEvent(getSessionRow(sessionId), job));
  }

  if (active.controller.signal.aborted) {
    updateSession(sessionId, {
      status: 'stopped',
      normalized_status: 'stopped',
      stopped_at: Date.now(),
      finished_at: Date.now(),
      last_step_summary: 'Stopped by operator.'
    });
    emit('research.session.stopped', publicSessionEvent(getSessionRow(sessionId), job));
    return;
  }

  // Stream evidence one business at a time so the UI sees discoveries live.
  const evidenceRows = mockEvidenceForSource({ job, source });
  const persisted = [];
  let runningCost = 0;
  for (let i = 0; i < evidenceRows.length; i += 1) {
    if (active.controller.signal.aborted) break;
    const row = evidenceRows[i];
    updateSession(sessionId, {
      last_step_summary: `Extracting ${row.businessName} from ${source.label}.`,
      updated_at: Date.now()
    });
    emit('research.session.progress', publicSessionEvent(getSessionRow(sessionId), job));
    await delay(sessionStepDelay);

    const persistedOne = persistEvidenceBatch({
      job,
      sessionId,
      providerSessionId,
      source,
      output: { leads: [row], skipped: [] }
    });
    persisted.push(...persistedOne);

    runningCost = source.type === 'website' ? 0.012 + i * 0.005 : 0.004 + i * 0.003;
    updateSession(sessionId, {
      output_count: persisted.length,
      cost_usd: runningCost,
      input_tokens: 240 + persisted.length * 150,
      output_tokens: 80 + persisted.length * 80,
      last_step_summary: `Captured ${row.businessName}.`,
      updated_at: Date.now()
    });
    emit('research.session.progress', publicSessionEvent(getSessionRow(sessionId), job));
  }

  updateSession(sessionId, {
    status: 'stopped',
    normalized_status: 'completed',
    output_count: persisted.length,
    cost_usd: source.type === 'website' ? 0.021 : 0.009,
    input_tokens: 1200 + persisted.length * 150,
    output_tokens: 420 + persisted.length * 80,
    finished_at: Date.now(),
    last_step_summary: `Captured ${persisted.length} structured evidence record${persisted.length === 1 ? '' : 's'}.`,
    raw_json: jsonText({ output: { leads: evidenceRows }, model: selectedModel, maxCostUsd, keepAlive, mock: true })
  });
  refreshJobCounts(job.id);
  emit('research.session.completed', publicSessionEvent(getSessionRow(sessionId), job));
}

function mockStepDelayMs() {
  return clampInt(process.env.BROWSER_USE_RESEARCH_MOCK_STEP_DELAY_MS, 10, 5000, 250);
}

async function runLiveSourceSession({ job, source, sessionId, selectedModel, maxCostUsd, keepAlive, active }) {
  const adapter = new BrowserUseCloudAdapter({ eventWorker: 'browser_research' });
  let providerSessionId = null;
  const startedAt = Date.now();
  try {
    const created = await adapter.createSessionAndRunTask({
      task: taskForSource({ job, source }),
      sourceType: source.type,
      model: selectedModel,
      outputSchema: BrowserResearchOutputSchema,
      keepAlive,
      maxCostUsd,
      ambiguous: source.ambiguous
    });
    providerSessionId = created.sessionId;
    active.providerSessions.set(sessionId, providerSessionId);
    updateSessionFromProvider(sessionId, created, {
      statusFallback: 'running',
      maxCostUsd,
      keepAlive,
      raw: created.raw
    });
    emit('research.session.live_url', publicSessionEvent(getSessionRow(sessionId), job));

    let latest = created;
    let lastSignature = '';
    while (!active.controller.signal.aborted && Date.now() - startedAt < sessionTimeoutMs()) {
      const status = latest.status || normalizeSessionStatus(latest.raw);
      const signature = `${status.state}:${status.stepCount}:${status.lastStepSummary || ''}:${latest.usage?.totalCostUsd || 0}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        updateSessionFromProvider(sessionId, latest, { maxCostUsd, keepAlive, raw: latest.raw });
        emit('research.session.progress', publicSessionEvent(getSessionRow(sessionId), job));
      }
      if (status.terminal) break;
      await delay(pollIntervalMs());
      latest = await adapter.getSession(providerSessionId, { sourceType: source.type });
    }

    if (active.controller.signal.aborted) {
      await adapter.stopSession(providerSessionId, { strategy: keepAlive ? 'task' : 'session', sourceType: source.type }).catch(() => null);
      updateSession(sessionId, {
        status: 'stopped',
        normalized_status: 'stopped',
        stopped_at: Date.now(),
        finished_at: Date.now(),
        last_step_summary: 'Stopped by operator.'
      });
      emit('research.session.stopped', publicSessionEvent(getSessionRow(sessionId), job));
      return;
    }

    const timedOut = Date.now() - startedAt >= sessionTimeoutMs();
    if (timedOut) {
      await adapter.stopSession(providerSessionId, { strategy: 'session', sourceType: source.type }).catch(() => null);
      throw new Error(`Browser Use ${source.type} session timed out after ${sessionTimeoutMs()}ms`);
    }

    const output = latest.output ?? latest.raw?.output ?? null;
    const persisted = persistEvidenceBatch({ job, sessionId, providerSessionId, source, output });
    updateSessionFromProvider(sessionId, latest, {
      statusOverride: latest.status?.state === 'failed' ? 'failed' : 'completed',
      outputCount: persisted.length,
      finishedAt: Date.now(),
      maxCostUsd,
      keepAlive,
      raw: latest.raw
    });
    refreshJobCounts(job.id);
    emit('research.session.completed', publicSessionEvent(getSessionRow(sessionId), job));
  } catch (err) {
    const message = err?.message || String(err);
    updateSession(sessionId, {
      status: 'error',
      normalized_status: 'failed',
      error: message,
      finished_at: Date.now(),
      last_step_summary: message
    });
    refreshJobCounts(job.id);
    emit('research.session.failed', { ...publicSessionEvent(getSessionRow(sessionId), job), error: message });
    log.warn('browser_research.session_failed', { jobId: job.id, sourceType: source.type, providerSessionId, error: message });
  }
}

function persistEvidenceBatch({ job, sessionId, providerSessionId, source, output }) {
  const rows = normalizeOutputLeads(output, source).map((lead) => normalizeLeadEvidence(lead, { job, source }));
  const persisted = [];
  for (const row of rows) {
    if (!row.businessName) continue;
    const acceptedSoFar = researchDb.prepare(`
      SELECT COUNT(*) AS n FROM research_evidence WHERE job_id = ? AND skipped = 0
    `).get(job.id).n;
    const skip = skipDecision(row, { acceptedSoFar, maxLeads: job.maxLeads });
    const saved = rowEvidence(upsertEvidence({
      ...row,
      id: evidenceId(),
      job_id: job.id,
      session_id: sessionId,
      provider_session_id: providerSessionId || null,
      source_type: source.type,
      skipped: skip.skipped ? 1 : 0,
      skipped_reason: skip.reason,
      created_at: Date.now(),
      updated_at: Date.now(),
      dedupe_key: evidenceDedupeKey(job.id, row),
      raw_json: jsonText(row.raw)
    }));
    persisted.push(saved);
    emit(saved.skipped ? 'research.evidence.skipped' : 'research.evidence.captured', {
      worker: 'browser_research',
      jobId: job.id,
      sessionId,
      providerSessionId,
      sourceType: source.type,
      businessName: saved.businessName,
      sourceUrl: saved.sourceUrl,
      presenceStrength: saved.presenceStrength,
      skipped: saved.skipped,
      skippedReason: saved.skippedReason
    });
    if (!saved.skipped) {
      mirrorBusinessToMemory({ job, evidence: saved, source });
    }
  }
  refreshJobCounts(job.id);
  return persisted;
}

function mirrorBusinessToMemory({ job, evidence, source }) {
  try {
    const profile = evidenceToBusinessProfile(evidence, { niche: job.niche, city: job.city });
    const requestedLeadId = `lead_research_${slugify(evidence.businessName).slice(0, 28)}_${stableHash(evidence.businessName + ':' + (evidence.phone || ''))}`;
    const containerTag = containerTagFor(requestedLeadId);
    const insertResult = leadsTable.upsertResearch({
      id: requestedLeadId,
      container_tag: containerTag,
      business_name: profile.businessName,
      phone: profile.phone || evidence.phone || null,
      address: profile.address || evidence.address || null,
      niche: job.niche,
      city: job.city,
      website: profile.websiteUrl || evidence.websiteUrl || null,
      status: 'discovered',
      research_status: 'complete',
      outreach_status: 'not_queued',
      risk_status: 'pending',
      consent_status: 'public_business',
      phone_classification: (profile.phone || evidence.phone) ? 'business' : 'invalid',
      next_action: 'classify_outreach',
      source_url: evidence.sourceUrl || profile.sourceUrl || null,
      online_presence_strength: profile.onlinePresenceStrength || evidence.presenceStrength || null,
      presence_confidence: profile.onlinePresenceConfidence ?? evidence.confidence ?? null,
      callable_reason: profile.callRecommendation?.whyCall || null,
      blocked_reason: profile.callRecommendation?.whyNotCall || profile.notWorthCallingReason || null,
      research_json: JSON.stringify(profile)
    }, { actor: 'browser_research', profile, runId: job.id });

    const lead = insertResult.lead;
    emit('lead.created', {
      worker: 'browser_research',
      runId: job.id,
      leadId: lead.id,
      businessName: lead.business_name,
      phone: lead.phone,
      niche: lead.niche,
      city: lead.city,
      sourceUrl: lead.source_url,
      duplicate: !!insertResult.duplicate,
      mock: job.mode === 'mock'
    });

    // Mirror business_profile to Supermemory (per-lead containerTag).
    addDoc(lead.container_tag, 'business_profile', profile, {
      businessName: profile.businessName,
      niche: job.niche,
      city: job.city,
      sourceUrl: evidence.sourceUrl || profile.sourceUrl || null,
      profileSource: 'browser_research',
      sourceId: `research:${job.id}:${source.type}:${evidence.id}`,
      sourceEvent: `research.evidence.captured:${evidence.id}`
    }).catch((err) => {
      log.warn('browser_research.memory_write_failed', {
        jobId: job.id,
        leadId: lead.id,
        error: err?.message || String(err)
      });
    });

    // Also mirror the raw research_evidence so the Memory ledger shows source provenance.
    addDoc(lead.container_tag, 'research_evidence', evidence, {
      businessName: profile.businessName,
      sourceType: source.type,
      sourceUrl: evidence.sourceUrl || null,
      sourceId: `evidence:${evidence.id}`,
      sourceEvent: `research.evidence.captured:${evidence.id}`
    }).catch(() => null);
  } catch (err) {
    log.warn('browser_research.mirror_failed', {
      jobId: job.id,
      businessName: evidence?.businessName,
      error: err?.message || String(err)
    });
  }
}

function stableHash(value) {
  let hash = 0;
  const str = String(value || '');
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8);
}

function normalizeOutputLeads(output, source) {
  if (!output) return [];
  if (Array.isArray(output)) return output;
  if (typeof output === 'string') {
    const parsed = parseJson(output);
    if (parsed) return normalizeOutputLeads(parsed, source);
    return [];
  }
  if (Array.isArray(output.leads)) return output.leads;
  if (Array.isArray(output.results)) return output.results;
  if (Array.isArray(output.businesses)) return output.businesses;
  if (output.businessName) return [output];
  return source ? [] : [];
}

function normalizeLeadEvidence(raw, { job, source }) {
  const sourceEvidence = normalizeSourceEvidence(raw.sourceEvidence, { raw, source });
  const socialUrls = list(raw.socialUrls || raw.socials || raw.socialProfiles);
  const services = list(raw.services);
  const reviews = normalizeReviews(raw.reviews);
  const sourceUrl = firstText(raw.sourceUrl, sourceEvidence[0]?.sourceUrl, raw.websiteUrl, mockSourceUrl(job, source, raw.businessName));
  const scored = scoreOnlinePresence({
    businessName: raw.businessName,
    phone: raw.phone,
    address: raw.address,
    websiteUrl: raw.websiteUrl,
    sourceUrl,
    sourceUrls: [sourceUrl, raw.websiteUrl, ...socialUrls].filter(Boolean),
    socialUrls,
    services,
    reviews,
    onlinePresenceStrength: raw.onlinePresenceStrength,
    onlinePresenceSummary: raw.leadRecommendation || raw.onlinePresenceSummary || sourceEvidence.map((e) => e.evidenceText).join(' '),
    signals: list(raw.signals),
    onlinePresenceEvidence: raw.onlinePresenceEvidence
  }, { rawText: jsonText(raw) || '' });

  return {
    businessName: cleanText(raw.businessName || raw.name || raw.title),
    phone: nullableText(raw.phone),
    address: nullableText(raw.address),
    hours: nullableText(raw.hours),
    websiteUrl: nullableUrl(raw.websiteUrl),
    socialUrls,
    services,
    reviews,
    sourceEvidence,
    sourceUrl,
    presenceStrength: raw.onlinePresenceStrength || scored.onlinePresenceStrength,
    confidence: boundedConfidence(raw.presenceConfidence ?? raw.onlinePresenceConfidence ?? scored.presenceConfidence),
    raw: { ...raw, scored }
  };
}

function skipDecision(row, { acceptedSoFar, maxLeads }) {
  if (row.presenceStrength === 'strong') {
    return { skipped: true, reason: 'strong_presence_visible_skip' };
  }
  if (acceptedSoFar >= maxLeads) {
    return { skipped: true, reason: 'max_leads_reached' };
  }
  return { skipped: false, reason: null };
}

function evidenceToBusinessProfile(item, { niche, city }) {
  const sourceText = JSON.stringify({
    sourceEvidence: item.sourceEvidence,
    reviews: item.reviews,
    sourceUrl: item.sourceUrl,
    websiteUrl: item.websiteUrl,
    socialUrls: item.socialUrls
  });
  const presence = scoreOnlinePresence({
    businessName: item.businessName,
    phone: item.phone,
    address: item.address,
    hasWebsite: Boolean(item.websiteUrl),
    websiteUrl: item.websiteUrl,
    sourceUrl: item.sourceUrl,
    sourceUrls: [item.sourceUrl, item.websiteUrl, ...item.socialUrls].filter(Boolean),
    services: item.services,
    onlinePresenceStrength: item.presenceStrength,
    onlinePresenceSummary: item.skippedReason || item.sourceEvidence?.[0]?.evidenceText || '',
    signals: item.services
  }, { rawText: sourceText });
  return enrichBusinessProfile({
    businessName: item.businessName,
    phone: item.phone,
    address: item.address,
    city,
    niche,
    hasWebsite: Boolean(item.websiteUrl),
    websiteUrl: item.websiteUrl,
    onlinePresenceStrength: presence.onlinePresenceStrength,
    onlinePresenceSummary: presence.onlinePresenceSummary,
    onlinePresenceEvidence: presence.onlinePresenceEvidence,
    onlinePresenceReasons: presence.onlinePresenceReasons,
    onlinePresenceConfidence: item.confidence ?? presence.onlinePresenceConfidence,
    presenceConfidence: item.confidence ?? presence.presenceConfidence,
    notWorthCallingReason: presence.notWorthCallingReason,
    callRecommendation: presence.callRecommendation,
    ownerHypothesis: null,
    customerPersona: null,
    hours: item.hours,
    services: item.services,
    whatTheyDo: `${item.businessName} appears to offer ${niche} in ${city}.`,
    needs: [],
    signals: item.services,
    bestContactEmail: null,
    yelpUrl: item.sourceUrl?.includes('yelp.com') ? item.sourceUrl : null,
    sourceUrl: item.sourceUrl,
    sourceUrls: [item.sourceUrl, item.websiteUrl, ...item.socialUrls].filter(Boolean)
  }, {
    niche,
    city,
    sourceText,
    sourceUrl: item.sourceUrl,
    profileSource: 'live_browser',
    allowGeneratedUrls: item.sourceUrl?.includes('demo.callmemaybe.local')
  }).profile;
}

function sourcePlan(job) {
  return [
    {
      type: 'search',
      label: 'Search sweep',
      ambiguous: false,
      maxCostUsd: job.maxCostUsd,
      taskHint: `Search the web for independently owned ${job.niche} businesses in ${job.city}.`
    },
    {
      type: 'directory',
      label: 'Yelp/directory',
      ambiguous: false,
      maxCostUsd: job.maxCostUsd,
      taskHint: `Audit Yelp, Yellow Pages, and directory pages for ${job.niche} businesses in ${job.city}.`
    },
    {
      type: 'website',
      label: 'Owned website audit',
      ambiguous: true,
      maxCostUsd: job.maxCostUsd,
      taskHint: 'Open candidate owned websites and decide whether they are strong, weak, mixed, or missing.'
    },
    {
      type: 'social',
      label: 'Social profiles',
      ambiguous: false,
      maxCostUsd: job.maxCostUsd,
      taskHint: 'Check Instagram, Facebook, TikTok, and other public social profiles for evidence.'
    },
    {
      type: 'maps',
      label: 'Maps-like pages',
      ambiguous: false,
      maxCostUsd: job.maxCostUsd,
      taskHint: 'Use maps-like business profile pages for public phone, address, hours, and reviews.'
    }
  ];
}

function taskForSource({ job, source }) {
  return [
    `Collect lead evidence for ${job.niche} businesses in ${job.city}.`,
    `Source lane: ${source.label}. ${source.taskHint}`,
    `Return up to ${Math.max(2, Math.ceil(job.maxLeads / 2))} businesses from this source lane.`,
    'Use public business pages only. Do not log in. Do not contact any business. Do not submit forms.',
    'Prefer small independent businesses that have no, weak, or mixed online presence. Still include strong-presence businesses if found, because the caller must visibly skip them.',
    'Every lead object must include businessName, phone, address, hours, websiteUrl, socialUrls, services, reviews, sourceEvidence, onlinePresenceStrength, and presenceConfidence.',
    'sourceEvidence must include exact sourceUrl and short evidenceText for phone, address, hours, services, website/social presence, and reviews when visible.',
    'Return only structured output matching the provided JSON Schema.'
  ].join('\n');
}

function mockEvidenceForSource({ job, source }) {
  const cityName = job.city.split(',')[0].trim();
  const seed = SOURCE_TYPES.indexOf(source.type);
  const baseUrl = mockSourceUrl(job, source, cityName);
  const weakName = `${cityName} ${titleCase(job.niche)} ${mockSuffix(seed)}`;
  const mixedName = `${mockNeighborhood(seed)} ${titleCase(job.niche)} Works`;
  const rows = [
    {
      businessName: weakName,
      phone: `+14155550${String(seed + 21).padStart(2, '0')}`,
      address: `${100 + seed * 17} ${mockNeighborhood(seed)} Ave, ${job.city}`,
      hours: 'Mon-Sat 9 AM-6 PM',
      websiteUrl: null,
      socialUrls: source.type === 'social' ? [`https://instagram.com/${slugify(weakName)}`] : [],
      services: [`${job.niche} services`, 'walk-ins', 'local appointments'],
      reviews: [{ source: source.label, rating: 4.3, count: 18 + seed, summary: 'Positive reviews, but sparse public detail.', sourceUrl: baseUrl }],
      sourceEvidence: mockSourceEvidence({ source, sourceUrl: baseUrl, businessName: weakName, websiteUrl: null }),
      onlinePresenceStrength: 'weak',
      presenceConfidence: 0.82,
      leadRecommendation: 'Weak owned presence: public listing exists, but no owned website was found.'
    },
    {
      businessName: mixedName,
      phone: `+14155551${String(seed + 31).padStart(2, '0')}`,
      address: `${220 + seed * 23} Market St, ${job.city}`,
      hours: 'Tue-Sun 10 AM-7 PM',
      websiteUrl: source.type === 'website' ? `https://${slugify(mixedName)}.example.com` : null,
      socialUrls: source.type === 'social' ? [`https://facebook.com/${slugify(mixedName)}`] : [],
      services: [`${job.niche} consultation`, 'quotes', 'repairs'],
      reviews: [{ source: source.label, rating: 4.1, count: 35 + seed, summary: 'Reviews exist, but booking and services are unclear.', sourceUrl: `${baseUrl}/mixed` }],
      sourceEvidence: mockSourceEvidence({ source, sourceUrl: `${baseUrl}/mixed`, businessName: mixedName, websiteUrl: source.type === 'website' ? `https://${slugify(mixedName)}.example.com` : null }),
      onlinePresenceStrength: source.type === 'website' ? 'mixed' : 'weak',
      presenceConfidence: 0.76,
      leadRecommendation: 'Mixed presence: some public proof exists, but conversion path is thin.'
    }
  ];

  if (source.type === 'website') {
    const strongName = `${cityName} Premier ${titleCase(job.niche)} Studio`;
    rows.push({
      businessName: strongName,
      phone: '+14155551999',
      address: `800 Valencia St, ${job.city}`,
      hours: 'Daily 8 AM-8 PM',
      websiteUrl: `https://${slugify(strongName)}.example.com`,
      socialUrls: [`https://instagram.com/${slugify(strongName)}`],
      services: [`${job.niche} packages`, 'online booking', 'portfolio'],
      reviews: [{ source: source.label, rating: 4.9, count: 412, summary: 'Modern website, booking, photos, services, and reviews are all visible.', sourceUrl: `${baseUrl}/strong` }],
      sourceEvidence: mockSourceEvidence({ source, sourceUrl: `${baseUrl}/strong`, businessName: strongName, websiteUrl: `https://${slugify(strongName)}.example.com`, strong: true }),
      onlinePresenceStrength: 'strong',
      presenceConfidence: 0.94,
      leadRecommendation: 'Skip: strong owned website and booking path already visible.'
    });
  }
  return rows;
}

function mockSourceEvidence({ source, sourceUrl, businessName, websiteUrl, strong = false }) {
  return [
    {
      sourceType: source.type,
      sourceUrl,
      field: 'businessName',
      value: businessName,
      evidenceText: `${source.label} page names ${businessName}.`,
      capturedAt: new Date().toISOString()
    },
    {
      sourceType: source.type,
      sourceUrl,
      field: 'websiteUrl',
      value: websiteUrl,
      evidenceText: strong ? 'Owned site has services, booking, reviews, and contact path.' : 'No strong owned website evidence was visible from this source.',
      capturedAt: new Date().toISOString()
    }
  ];
}

function upsertSession(row) {
  researchDb.prepare(`
    INSERT INTO browser_sessions (
      id, job_id, provider_session_id, source_type, source_label, model, status, normalized_status,
      live_url, last_step_summary, output_count, cost_usd, input_tokens, output_tokens, max_cost_usd,
      keep_alive, started_at, updated_at, finished_at, stopped_at, raw_json, error, idempotency_key
    )
    VALUES (
      @id, @job_id, @provider_session_id, @source_type, @source_label, @model, @status, @normalized_status,
      @live_url, @last_step_summary, @output_count, @cost_usd, @input_tokens, @output_tokens, @max_cost_usd,
      @keep_alive, @started_at, @updated_at, @finished_at, @stopped_at, @raw_json, @error, @idempotency_key
    )
    ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET
      provider_session_id = COALESCE(excluded.provider_session_id, browser_sessions.provider_session_id),
      source_label = excluded.source_label,
      model = excluded.model,
      status = excluded.status,
      normalized_status = excluded.normalized_status,
      live_url = COALESCE(excluded.live_url, browser_sessions.live_url),
      last_step_summary = excluded.last_step_summary,
      output_count = excluded.output_count,
      cost_usd = excluded.cost_usd,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      max_cost_usd = excluded.max_cost_usd,
      keep_alive = excluded.keep_alive,
      updated_at = excluded.updated_at,
      finished_at = excluded.finished_at,
      stopped_at = excluded.stopped_at,
      raw_json = COALESCE(excluded.raw_json, browser_sessions.raw_json),
      error = excluded.error
  `).run({
    finished_at: null,
    stopped_at: null,
    ...row
  });
}

function updateSession(id, patch) {
  const next = { updated_at: Date.now(), ...patch };
  const cols = Object.keys(next);
  const sets = cols.map((col) => `${col} = @${col}`).join(', ');
  researchDb.prepare(`UPDATE browser_sessions SET ${sets} WHERE id = @id`).run({ id, ...next });
}

function updateSessionFromProvider(id, normalized, { statusFallback, statusOverride, outputCount, finishedAt, maxCostUsd, keepAlive, raw }) {
  const session = normalized.raw || raw || {};
  const status = normalized.status || normalizeSessionStatus(session);
  const usage = normalized.usage || normalizeCostAndTokenUsage(session);
  updateSession(id, {
    provider_session_id: normalized.sessionId || session.id || null,
    model: normalized.model || session.model || null,
    status: session.status || statusFallback || status.state || 'running',
    normalized_status: statusOverride || status.state || 'running',
    live_url: status.liveUrl || normalized.liveUrl || null,
    last_step_summary: status.lastStepSummary || null,
    output_count: outputCount ?? (Array.isArray(normalized.output?.leads) ? normalized.output.leads.length : 0),
    cost_usd: usage.totalCostUsd || 0,
    input_tokens: usage.totalInputTokens || 0,
    output_tokens: usage.totalOutputTokens || 0,
    max_cost_usd: String(maxCostUsd || usage.maxCostUsd || ''),
    keep_alive: keepAlive ? 1 : 0,
    finished_at: finishedAt || (status.terminal ? Date.now() : null),
    raw_json: jsonText(session)
  });
}

function upsertEvidence(row) {
  researchDb.prepare(`
    INSERT INTO research_evidence (
      id, job_id, session_id, provider_session_id, source_type, business_name, phone, address, hours,
      website_url, social_urls_json, services_json, reviews_json, source_evidence_json, source_url,
      presence_strength, confidence, skipped, skipped_reason, created_at, updated_at, dedupe_key, raw_json
    )
    VALUES (
      @id, @job_id, @session_id, @provider_session_id, @source_type, @businessName, @phone, @address, @hours,
      @websiteUrl, @socialUrlsJson, @servicesJson, @reviewsJson, @sourceEvidenceJson, @sourceUrl,
      @presenceStrength, @confidence, @skipped, @skipped_reason, @created_at, @updated_at, @dedupe_key, @raw_json
    )
    ON CONFLICT(dedupe_key) DO UPDATE SET
      session_id = excluded.session_id,
      provider_session_id = COALESCE(excluded.provider_session_id, research_evidence.provider_session_id),
      phone = COALESCE(excluded.phone, research_evidence.phone),
      address = COALESCE(excluded.address, research_evidence.address),
      hours = COALESCE(excluded.hours, research_evidence.hours),
      website_url = COALESCE(excluded.website_url, research_evidence.website_url),
      social_urls_json = excluded.social_urls_json,
      services_json = excluded.services_json,
      reviews_json = excluded.reviews_json,
      source_evidence_json = excluded.source_evidence_json,
      source_url = COALESCE(excluded.source_url, research_evidence.source_url),
      presence_strength = excluded.presence_strength,
      confidence = excluded.confidence,
      skipped = excluded.skipped,
      skipped_reason = excluded.skipped_reason,
      updated_at = excluded.updated_at,
      raw_json = excluded.raw_json
  `).run({
    ...row,
    socialUrlsJson: jsonText(row.socialUrls),
    servicesJson: jsonText(row.services),
    reviewsJson: jsonText(row.reviews),
    sourceEvidenceJson: jsonText(row.sourceEvidence)
  });
  return researchDb.prepare(`SELECT * FROM research_evidence WHERE dedupe_key = ?`).get(row.dedupe_key);
}

function markJobStarted(job) {
  researchDb.prepare(`
    UPDATE research_jobs
    SET status = 'running', started_at = COALESCE(started_at, ?), error = NULL
    WHERE id = ?
  `).run(Date.now(), job.id);
}

function markJobStopped(jobId) {
  refreshJobCounts(jobId, { status: 'stopped', finished_at: Date.now(), stopped_at: Date.now() });
}

function markJobFailed(jobId, err) {
  refreshJobCounts(jobId, { status: 'failed', finished_at: Date.now(), error: err?.message || String(err) });
}

function refreshJobCounts(jobId, patch = {}) {
  const counts = researchDb.prepare(`
    SELECT
      COUNT(*) AS evidence_count,
      SUM(CASE WHEN skipped = 0 THEN 1 ELSE 0 END) AS accepted_count,
      SUM(CASE WHEN skipped = 1 THEN 1 ELSE 0 END) AS skipped_count
    FROM research_evidence
    WHERE job_id = ?
  `).get(jobId);
  const next = {
    accepted_count: counts.accepted_count || 0,
    skipped_count: counts.skipped_count || 0,
    evidence_count: counts.evidence_count || 0,
    ...patch
  };
  const cols = Object.keys(next);
  const sets = cols.map((col) => `${col} = @${col}`).join(', ');
  researchDb.prepare(`UPDATE research_jobs SET ${sets} WHERE id = @id`).run({ id: jobId, ...next });
}

function getResearchJob(jobId) {
  const row = researchDb.prepare(`SELECT * FROM research_jobs WHERE id = ?`).get(jobId);
  return row ? rowJob(row) : null;
}

function latestJobId() {
  return researchDb.prepare(`
    SELECT id FROM research_jobs ORDER BY requested_at DESC LIMIT 1
  `).get()?.id || null;
}

function getSessionRow(id) {
  return researchDb.prepare(`SELECT * FROM browser_sessions WHERE id = ?`).get(id);
}

function rowJob(row) {
  return {
    id: row.id,
    niche: row.niche,
    city: row.city,
    maxLeads: row.max_leads,
    concurrency: row.concurrency,
    maxCostUsd: row.max_cost_usd,
    mode: row.mode,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stoppedAt: row.stopped_at,
    acceptedCount: row.accepted_count,
    skippedCount: row.skipped_count,
    evidenceCount: row.evidence_count,
    error: row.error,
    detail: parseJson(row.detail_json) || {},
    idempotencyKey: row.idempotency_key
  };
}

function rowSession(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    providerSessionId: row.provider_session_id,
    sourceType: row.source_type,
    sourceLabel: row.source_label,
    model: row.model,
    status: row.status,
    normalizedStatus: row.normalized_status,
    liveUrl: row.live_url,
    lastStepSummary: row.last_step_summary,
    outputCount: row.output_count,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    maxCostUsd: row.max_cost_usd,
    keepAlive: Boolean(row.keep_alive),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    stoppedAt: row.stopped_at,
    raw: parseJson(row.raw_json),
    error: row.error
  };
}

function rowEvidence(row) {
  return {
    id: row.id,
    jobId: row.job_id,
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    sourceType: row.source_type,
    businessName: row.business_name,
    phone: row.phone,
    address: row.address,
    hours: row.hours,
    websiteUrl: row.website_url,
    socialUrls: parseJson(row.social_urls_json) || [],
    services: parseJson(row.services_json) || [],
    reviews: parseJson(row.reviews_json) || [],
    sourceEvidence: parseJson(row.source_evidence_json) || [],
    sourceUrl: row.source_url,
    presenceStrength: row.presence_strength,
    confidence: row.confidence,
    skipped: Boolean(row.skipped),
    skippedReason: row.skipped_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    raw: parseJson(row.raw_json)
  };
}

function publicJobEvent(job) {
  return {
    worker: 'browser_research',
    jobId: job?.id,
    city: job?.city,
    niche: job?.niche,
    mode: job?.mode,
    status: job?.status,
    acceptedCount: job?.acceptedCount || 0,
    skippedCount: job?.skippedCount || 0,
    evidenceCount: job?.evidenceCount || 0
  };
}

function publicSessionEvent(row, job) {
  const session = rowSession(row);
  return {
    worker: 'browser_research',
    jobId: job?.id || session.jobId,
    sessionId: session.id,
    providerSessionId: session.providerSessionId,
    sourceType: session.sourceType,
    sourceLabel: session.sourceLabel,
    model: session.model,
    status: session.status,
    normalizedStatus: session.normalizedStatus,
    liveUrl: session.liveUrl,
    lastStepSummary: session.lastStepSummary,
    outputCount: session.outputCount,
    costUsd: session.costUsd,
    maxCostUsd: session.maxCostUsd,
    keepAlive: session.keepAlive,
    mock: job?.mode === 'mock'
  };
}

function groupEvidenceByBusiness(evidence) {
  const map = new Map();
  for (const item of evidence) {
    const key = item.businessName.toLowerCase();
    const current = map.get(key) || {
      businessName: item.businessName,
      phone: item.phone,
      address: item.address,
      hours: item.hours,
      websiteUrl: item.websiteUrl,
      presenceStrength: item.presenceStrength,
      confidence: item.confidence,
      skipped: item.skipped,
      skippedReason: item.skippedReason,
      sources: [],
      services: new Set(),
      socialUrls: new Set()
    };
    current.phone ||= item.phone;
    current.address ||= item.address;
    current.hours ||= item.hours;
    current.websiteUrl ||= item.websiteUrl;
    current.skipped = current.skipped && item.skipped;
    if (!current.skippedReason && item.skippedReason) current.skippedReason = item.skippedReason;
    current.sources.push({ sourceType: item.sourceType, sourceUrl: item.sourceUrl, evidenceCount: item.sourceEvidence.length });
    for (const service of item.services) current.services.add(service);
    for (const url of item.socialUrls) current.socialUrls.add(url);
    map.set(key, current);
  }
  return [...map.values()].map((item) => ({
    ...item,
    services: [...item.services],
    socialUrls: [...item.socialUrls]
  }));
}

function summarizeStatus({ job, sessions, evidence }) {
  return {
    activeSessions: sessions.filter((session) => ['queued', 'starting', 'running', 'idle'].includes(session.normalizedStatus)).length,
    totalSessions: sessions.length,
    evidenceCount: evidence.length,
    acceptedCount: evidence.filter((item) => !item.skipped).length,
    skippedCount: evidence.filter((item) => item.skipped).length,
    strongSkippedCount: evidence.filter((item) => item.skippedReason === 'strong_presence_visible_skip').length,
    costUsd: sessions.reduce((sum, session) => sum + Number(session.costUsd || 0), 0),
    mode: job?.mode || null,
    status: job?.status || 'empty'
  };
}

function normalizeJobInput(input, now) {
  const city = cleanText(input.city) || 'San Francisco, CA';
  const niche = cleanText(input.niche) || 'barber';
  const requestedMode = input.mode === 'live' || input.mode === 'mock' ? input.mode : (browserResearchLiveEnabled() ? 'live' : 'mock');
  const maxLeads = clampInt(input.maxLeads ?? input.max_leads ?? input.count, 1, 25, DEFAULT_MAX_LEADS);
  const concurrency = clampInt(input.concurrency, 1, 5, DEFAULT_CONCURRENCY);
  const maxCostUsd = costText(input.maxCostUsd ?? input.max_cost_usd, DEFAULT_SESSION_MAX_COST_USD);
  const detail = {
    sourceRunId: input.sourceRunId || null,
    liveBlockers: requestedMode === 'live' ? [] : browserResearchLiveBlockers(),
    sourceLinks: browserUseDocLinks()
  };
  return {
    id: input.id || `research_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
    city,
    niche,
    maxLeads,
    concurrency,
    maxCostUsd,
    mode: requestedMode === 'live' && browserResearchLiveEnabled() ? 'live' : 'mock',
    requestedAt: now,
    detailJson: jsonText(detail),
    idempotencyKey: input.idempotencyKey || input.idempotency_key || null
  };
}

function browserResearchLiveBlockers() {
  const blockers = [];
  if (!env.browserUse.apiKey) blockers.push('BROWSER_USE_API_KEY missing');
  if (env.runMode === 'mock') blockers.push('RUN_MODE=mock');
  if (!bool(process.env.BROWSER_USE_LIVE_RESEARCH) && !bool(process.env.LIVE_BROWSER_RESEARCH) && !bool(process.env.LIVE_RESEARCH)) {
    blockers.push('set BROWSER_USE_LIVE_RESEARCH=true to create live research sessions');
  }
  return blockers;
}

function browserUseDocLinks() {
  return [
    'https://docs.browser-use.com/cloud/api-reference',
    'https://docs.browser-use.com/cloud/api-v3/sessions/create-session',
    'https://docs.browser-use.com/cloud/api-v3/sessions/get-session',
    'https://docs.browser-use.com/cloud/api-v3/sessions/stop-session',
    'https://docs.browser-use.com/cloud/api-v3/sessions/list-sessions',
    'https://docs.browser-use.com/cloud/pricing'
  ];
}

async function runLimited(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function mockSteps(source, { job } = {}) {
  const target = job ? `${job.niche} in ${job.city}` : 'targets';
  return [
    `Opening ${source.label} to scan ${target}.`,
    `Loaded ${source.label} results page.`,
    'Scrolling listings and collecting public business cards.',
    'Following each business profile for phone, address, hours.',
    'Checking website, social, reviews, and hours evidence.',
    'Scoring online presence strength for each candidate.',
    'Returning Browser Use structured output.'
  ];
}

function normalizeSourceEvidence(value, { raw, source }) {
  const rows = Array.isArray(value) ? value : [];
  const sourceUrl = firstText(raw.sourceUrl, raw.websiteUrl, rows[0]?.sourceUrl, mockSourceUrl({ city: 'demo', niche: 'business' }, source, raw.businessName));
  const normalized = rows.map((item) => ({
    sourceType: validateSourceType(item.sourceType || source.type),
    sourceUrl: firstText(item.sourceUrl, sourceUrl),
    field: cleanText(item.field || 'profile'),
    value: nullableText(item.value),
    evidenceText: cleanText(item.evidenceText || item.evidence || item.summary || 'Evidence captured by Browser Use.'),
    capturedAt: item.capturedAt || new Date().toISOString()
  })).filter((item) => item.sourceUrl && item.field && item.evidenceText);
  if (normalized.length) return normalized;
  return [{
    sourceType: source.type,
    sourceUrl,
    field: 'profile',
    value: raw.businessName || null,
    evidenceText: `Browser Use captured ${raw.businessName || 'this business'} from ${source.label}.`,
    capturedAt: new Date().toISOString()
  }];
}

function normalizeReviews(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((review) => ({
    source: cleanText(review.source || review.platform || 'source'),
    rating: numericOrNull(review.rating),
    count: integerOrNull(review.count || review.reviewCount),
    summary: cleanText(review.summary || review.text || ''),
    sourceUrl: nullableUrl(review.sourceUrl || review.url)
  })).filter((review) => review.source && review.summary);
}

function localSessionId(jobId, sourceType) {
  return `bu_${jobId}_${sourceType}`;
}

function evidenceId() {
  return `ev_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function evidenceDedupeKey(jobId, row) {
  return `${jobId}:${slugify(row.businessName)}:${slugify(row.sourceUrl || row.websiteUrl || row.sourceEvidence?.[0]?.sourceUrl || 'source')}`;
}

function shouldKeepAlive(source) {
  return bool(process.env.BROWSER_USE_RESEARCH_KEEP_ALIVE) && source.ambiguous;
}

function sessionTimeoutMs() {
  return clampInt(process.env.BROWSER_USE_RESEARCH_SESSION_TIMEOUT_MS, 10_000, 60 * 60 * 1000, DEFAULT_SESSION_TIMEOUT_MS);
}

function pollIntervalMs() {
  return clampInt(process.env.BROWSER_USE_RESEARCH_POLL_INTERVAL_MS, 500, 30_000, DEFAULT_POLL_INTERVAL_MS);
}

function cleanText(value) {
  if (value == null) return null;
  const out = String(value).trim().replace(/\s+/g, ' ');
  if (!out || /^(none|null|n\/a|not found|unknown)$/i.test(out)) return null;
  return out.slice(0, 500);
}

function nullableText(value) {
  return cleanText(value);
}

function nullableUrl(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text.replace(/[.,;:)\]}]+$/g, '');
  if (/^www\./i.test(text)) return `https://${text.replace(/[.,;:)\]}]+$/g, '')}`;
  return null;
}

function list(value) {
  const input = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,;\n|]/) : []);
  return [...new Set(input.map((item) => cleanText(item)).filter(Boolean))].slice(0, 12);
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return null;
}

function boundedConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.72;
  return Math.max(0, Math.min(1, n));
}

function numericOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integerOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function costText(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(fallback);
  return n.toFixed(2).replace(/\.?0+$/g, '');
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function jsonText(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function bool(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function ensureResearchColumn(table, column, definition) {
  const cols = researchDb.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name);
  if (!cols.includes(column)) researchDb.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .map((word) => word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : '')
    .join(' ');
}

function slugify(value) {
  return String(value || 'item')
    .toLowerCase()
    .replace(/https?:\/\//g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function mockSuffix(index) {
  return ['House', 'Collective', 'Studio', 'Shop', 'Clinic'][index % 5];
}

function mockNeighborhood(index) {
  return ['Mission', 'Hayes Valley', 'North Beach', 'Richmond', 'SOMA'][index % 5];
}

function mockSourceUrl(job, source, value) {
  return `https://demo.callmemaybe.local/browser-research/${slugify(job.city)}/${slugify(job.niche)}/${source.type}/${slugify(value)}`;
}
