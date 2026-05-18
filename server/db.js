import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';

mkdirSync(env.dataDir, { recursive: true });
const dbPath = join(env.dataDir, 'callmemaybe.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    container_tag TEXT NOT NULL UNIQUE,
    business_name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    niche TEXT,
    city TEXT,
    website TEXT,
    status TEXT NOT NULL DEFAULT 'discovered',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lead_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor TEXT,
    summary TEXT,
    metadata_json TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS worker_runs (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    worker TEXT NOT NULL,
    state TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    detail_json TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    lead_id TEXT,
    worker TEXT,
    payload_json TEXT
  );

  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    provider_call_id TEXT,
    to_phone TEXT,
    disclosure_text TEXT,
    decision_reason TEXT,
    state TEXT NOT NULL,
    outcome TEXT,
    transcript_json TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    stripe_session_id TEXT,
    stripe_invoice_id TEXT,
    stripe_customer_id TEXT,
    customer_email TEXT,
    payment_link_url TEXT,
    hosted_invoice_url TEXT,
    invoice_pdf_url TEXT,
    amount_cents INTEGER,
    status TEXT NOT NULL,
    due_at INTEGER,
    idempotency_key TEXT,
    offer_version TEXT,
    created_at INTEGER NOT NULL,
    paid_at INTEGER,
    build_triggered_at INTEGER,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    browser_session_id TEXT,
    live_url TEXT,
    project_url TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS build_hooks (
    id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    run_id TEXT,
    hook TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    input_json TEXT,
    output_json TEXT,
    error TEXT,
    idempotency_key TEXT,
    FOREIGN KEY(build_id) REFERENCES builds(id) ON DELETE CASCADE,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS build_qa_results (
    id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL,
    url TEXT,
    status TEXT NOT NULL,
    passed INTEGER NOT NULL,
    score INTEGER,
    checklist_json TEXT,
    errors_json TEXT,
    claims_json TEXT,
    created_at INTEGER NOT NULL,
    idempotency_key TEXT,
    FOREIGN KEY(build_id) REFERENCES builds(id) ON DELETE CASCADE,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS build_revisions (
    id TEXT PRIMARY KEY,
    build_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    qa_result_id TEXT,
    status TEXT NOT NULL,
    prompt TEXT NOT NULL,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    idempotency_key TEXT,
    FOREIGN KEY(build_id) REFERENCES builds(id) ON DELETE CASCADE,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY(qa_result_id) REFERENCES build_qa_results(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS do_not_call (
    phone TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS call_attempts (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    phone TEXT NOT NULL,
    allowed INTEGER NOT NULL,
    reason TEXT NOT NULL,
    disclosure_text TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS contact_events (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    type TEXT NOT NULL,
    direction TEXT NOT NULL,
    channel TEXT NOT NULL,
    provider_id TEXT,
    thread_id TEXT,
    subject TEXT,
    body TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS provider_smoke (
    provider TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    detail_json TEXT,
    checked_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhook_events (
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    type TEXT,
    received_at INTEGER NOT NULL,
    payload_json TEXT,
    PRIMARY KEY(provider, event_id)
  );

  CREATE TABLE IF NOT EXISTS moss_hot_indexes (
    lead_id TEXT PRIMARY KEY,
    index_name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    mode TEXT,
    doc_count INTEGER NOT NULL DEFAULT 0,
    active_doc_count INTEGER NOT NULL DEFAULT 0,
    dead_doc_count INTEGER NOT NULL DEFAULT 0,
    last_query_at INTEGER,
    last_latency_ms INTEGER,
    last_error TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS moss_snippets (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    index_name TEXT NOT NULL,
    snippet_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    help_score REAL NOT NULL DEFAULT 0,
    use_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(lead_id, snippet_id),
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS moss_retrievals (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    lead_id TEXT,
    call_id TEXT,
    index_name TEXT,
    intent TEXT NOT NULL,
    query TEXT NOT NULL,
    top_k INTEGER NOT NULL,
    alpha REAL NOT NULL,
    latency_ms INTEGER NOT NULL,
    result_count INTEGER NOT NULL,
    snippet_ids_json TEXT,
    mode TEXT,
    source TEXT,
    outcome TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    lead_id TEXT,
    contact_event_id TEXT,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    action TEXT NOT NULL,
    worker TEXT,
    source_url TEXT,
    decision_code TEXT,
    decision_reason TEXT,
    metadata_json TEXT,
    dedupe_key TEXT
  );

  CREATE TABLE IF NOT EXISTS compliance_decisions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    lead_id TEXT,
    contact_event_id TEXT,
    direction TEXT NOT NULL,
    channel TEXT,
    subject_type TEXT NOT NULL,
    subject_id TEXT,
    allowed INTEGER,
    decision_code TEXT NOT NULL,
    decision_reason TEXT NOT NULL,
    source_url TEXT,
    metadata_json TEXT,
    dedupe_key TEXT
  );

  CREATE TABLE IF NOT EXISTS reasoning_traces (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    lead_id TEXT,
    worker TEXT,
    event_id TEXT,
    provider TEXT NOT NULL,
    schema_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    model TEXT,
    source TEXT,
    prompt_json TEXT,
    evidence_json TEXT,
    raw_output TEXT,
    repaired_output TEXT,
    final_output_json TEXT,
    validation_errors_json TEXT,
    latency_ms INTEGER,
    valid INTEGER NOT NULL,
    repair_attempts INTEGER NOT NULL DEFAULT 0,
    dedupe_key TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS memory_documents (
    custom_id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    container_tag TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_event TEXT,
    provider_document_id TEXT,
    provider_status TEXT NOT NULL DEFAULT 'local',
    write_status TEXT NOT NULL DEFAULT 'queued',
    content_text TEXT NOT NULL,
    metadata_json TEXT,
    filter_by_metadata_json TEXT,
    entity_context TEXT,
    last_error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_provider_checked_at INTEGER,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_write_queue (
    id TEXT PRIMARY KEY,
    custom_id TEXT NOT NULL UNIQUE,
    lead_id TEXT NOT NULL,
    container_tag TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_event TEXT,
    content_text TEXT NOT NULL,
    metadata_json TEXT,
    filter_by_metadata_json TEXT,
    entity_context TEXT,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    provider_document_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_searches (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    container_tag TEXT NOT NULL,
    query TEXT NOT NULL,
    kind TEXT,
    filters_json TEXT,
    result_count INTEGER NOT NULL DEFAULT 0,
    results_json TEXT,
    status TEXT NOT NULL,
    error TEXT,
    bleed_detected INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS memory_failures (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    container_tag TEXT,
    custom_id TEXT,
    kind TEXT,
    action TEXT NOT NULL,
    category TEXT NOT NULL,
    retryable INTEGER NOT NULL DEFAULT 1,
    error TEXT NOT NULL,
    payload_json TEXT,
    source_event TEXT,
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS growth_plans (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    offer_json TEXT NOT NULL,
    next_service_id TEXT,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    unsupported_count INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    generated_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_followup_at INTEGER,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS growth_followups (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    growth_plan_id TEXT,
    direction TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    classification TEXT,
    provider_id TEXT,
    thread_id TEXT,
    subject TEXT,
    body TEXT,
    metadata_json TEXT,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY(growth_plan_id) REFERENCES growth_plans(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
  CREATE INDEX IF NOT EXISTS idx_lead_history_lead ON lead_history(lead_id);
  CREATE INDEX IF NOT EXISTS idx_runs_lead ON worker_runs(lead_id);
  CREATE INDEX IF NOT EXISTS idx_calls_lead_started ON calls(lead_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_payments_lead_created ON payments(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_builds_lead_started ON builds(lead_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_build_hooks_build ON build_hooks(build_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_build_hooks_lead ON build_hooks(lead_id, started_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_build_hooks_idempotency ON build_hooks(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_build_qa_results_build ON build_qa_results(build_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_build_qa_results_lead ON build_qa_results(lead_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_build_qa_results_idempotency ON build_qa_results(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_build_revisions_build ON build_revisions(build_id, attempt);
  CREATE INDEX IF NOT EXISTS idx_build_revisions_lead ON build_revisions(lead_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_build_revisions_idempotency ON build_revisions(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_contact_events_lead ON contact_events(lead_id);
  CREATE INDEX IF NOT EXISTS idx_contact_events_thread ON contact_events(thread_id);
  CREATE INDEX IF NOT EXISTS idx_contact_events_lead_created ON contact_events(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_call_attempts_phone ON call_attempts(phone);
  CREATE INDEX IF NOT EXISTS idx_call_attempts_lead_created ON call_attempts(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_moss_snippets_lead_status ON moss_snippets(lead_id, status, kind);
  CREATE INDEX IF NOT EXISTS idx_moss_retrievals_lead_created ON moss_retrievals(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_moss_retrievals_call_created ON moss_retrievals(call_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reasoning_traces_created ON reasoning_traces(created_at);
  CREATE INDEX IF NOT EXISTS idx_reasoning_traces_lead_created ON reasoning_traces(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reasoning_traces_schema_created ON reasoning_traces(schema_name, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reasoning_traces_dedupe ON reasoning_traces(dedupe_key) WHERE dedupe_key IS NOT NULL;

  CREATE TRIGGER IF NOT EXISTS audit_events_no_update
  BEFORE UPDATE ON audit_events
  BEGIN
    SELECT RAISE(ABORT, 'audit_events are append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
  BEFORE DELETE ON audit_events
  BEGIN
    SELECT RAISE(ABORT, 'audit_events are append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS compliance_decisions_no_update
  BEFORE UPDATE ON compliance_decisions
  BEGIN
    SELECT RAISE(ABORT, 'compliance_decisions are append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS compliance_decisions_no_delete
  BEFORE DELETE ON compliance_decisions
  BEGIN
    SELECT RAISE(ABORT, 'compliance_decisions are append-only');
  END;
`);

ensureColumn('leads', 'research_status', "TEXT NOT NULL DEFAULT 'new'");
ensureColumn('leads', 'outreach_status', "TEXT NOT NULL DEFAULT 'not_queued'");
ensureColumn('leads', 'risk_status', "TEXT NOT NULL DEFAULT 'unknown'");
ensureColumn('leads', 'consent_status', "TEXT NOT NULL DEFAULT 'unknown'");
ensureColumn('leads', 'phone_classification', "TEXT NOT NULL DEFAULT 'unknown'");
ensureColumn('leads', 'last_contacted_at', 'INTEGER');
ensureColumn('leads', 'next_action', 'TEXT');
ensureColumn('leads', 'source_url', 'TEXT');
ensureColumn('leads', 'agentmail_thread_id', 'TEXT');
ensureColumn('leads', 'normalized_phone', 'TEXT');
ensureColumn('leads', 'normalized_name', 'TEXT');
ensureColumn('leads', 'normalized_city', 'TEXT');
ensureColumn('leads', 'normalized_source_url', 'TEXT');
ensureColumn('leads', 'duplicate_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('leads', 'last_duplicate_at', 'INTEGER');
ensureColumn('leads', 'last_duplicate_reason', 'TEXT');
ensureColumn('leads', 'duplicate_of', 'TEXT');
ensureColumn('leads', 'online_presence_strength', 'TEXT');
ensureColumn('leads', 'presence_confidence', 'REAL');
ensureColumn('leads', 'callable_reason', 'TEXT');
ensureColumn('leads', 'blocked_reason', 'TEXT');
ensureColumn('leads', 'research_json', 'TEXT');
ensureColumn('calls', 'disclosure_text', 'TEXT');
ensureColumn('calls', 'decision_reason', 'TEXT');
ensureColumn('payments', 'stripe_invoice_id', 'TEXT');
ensureColumn('payments', 'stripe_customer_id', 'TEXT');
ensureColumn('payments', 'customer_email', 'TEXT');
ensureColumn('payments', 'hosted_invoice_url', 'TEXT');
ensureColumn('payments', 'invoice_pdf_url', 'TEXT');
ensureColumn('payments', 'due_at', 'INTEGER');
ensureColumn('payments', 'idempotency_key', 'TEXT');
ensureColumn('payments', 'offer_version', 'TEXT');
ensureColumn('payments', 'build_triggered_at', 'INTEGER');
ensureColumn('builds', 'lovable_url', 'TEXT');
ensureColumn('builds', 'brief', 'TEXT');
ensureColumn('builds', 'error', 'TEXT');
ensureColumn('builds', 'trigger_key', 'TEXT');
ensureColumn('builds', 'updated_at', 'INTEGER');
ensureColumn('builds', 'target', "TEXT NOT NULL DEFAULT 'lovable'");
ensureColumn('builds', 'submission_url', 'TEXT');
ensureColumn('builds', 'provider_project_id', 'TEXT');
ensureColumn('builds', 'provider_deployment_id', 'TEXT');
ensureColumn('builds', 'attempt', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('audit_events', 'contact_event_id', 'TEXT');
ensureColumn('audit_events', 'source_url', 'TEXT');
ensureColumn('audit_events', 'decision_code', 'TEXT');
ensureColumn('audit_events', 'decision_reason', 'TEXT');
ensureColumn('audit_events', 'dedupe_key', 'TEXT');
ensureColumn('compliance_decisions', 'contact_event_id', 'TEXT');
ensureColumn('compliance_decisions', 'source_url', 'TEXT');
ensureColumn('compliance_decisions', 'metadata_json', 'TEXT');
ensureColumn('compliance_decisions', 'dedupe_key', 'TEXT');

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_leads_research_status ON leads(research_status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_leads_outreach_status ON leads(outreach_status, last_contacted_at);
  CREATE INDEX IF NOT EXISTS idx_leads_normalized_phone ON leads(normalized_phone) WHERE normalized_phone IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_leads_normalized_name_city ON leads(normalized_name, normalized_city) WHERE normalized_name IS NOT NULL AND normalized_city IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_leads_normalized_source_url ON leads(normalized_source_url) WHERE normalized_source_url IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_leads_research_outreach ON leads(research_status, outreach_status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_payments_stripe_invoice ON payments(stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_builds_trigger_key ON builds(trigger_key) WHERE trigger_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_builds_recovery ON builds(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_events_lead_created ON audit_events(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_events_contact_created ON audit_events(contact_event_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_audit_events_type_created ON audit_events(event_type, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_dedupe ON audit_events(dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_compliance_decisions_lead_created ON compliance_decisions(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_compliance_decisions_contact_created ON compliance_decisions(contact_event_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_compliance_decisions_subject ON compliance_decisions(subject_type, subject_id);
  CREATE INDEX IF NOT EXISTS idx_compliance_decisions_code_created ON compliance_decisions(decision_code, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_decisions_dedupe ON compliance_decisions(dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_memory_documents_lead_updated ON memory_documents(lead_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_memory_documents_kind_status ON memory_documents(kind, write_status);
  CREATE INDEX IF NOT EXISTS idx_memory_documents_container ON memory_documents(container_tag);
  CREATE INDEX IF NOT EXISTS idx_memory_write_queue_status_next ON memory_write_queue(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_memory_write_queue_lead ON memory_write_queue(lead_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_memory_searches_lead_created ON memory_searches(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_failures_unresolved ON memory_failures(resolved_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_memory_failures_custom ON memory_failures(custom_id, action);
  CREATE INDEX IF NOT EXISTS idx_growth_plans_lead ON growth_plans(lead_id, generated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_plans_idempotency ON growth_plans(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_growth_followups_lead ON growth_followups(lead_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_growth_followups_idempotency ON growth_followups(idempotency_key) WHERE idempotency_key IS NOT NULL;
`);

backfillLeadDedupeKeys();
backfillAuditEvents();
backfillComplianceDecisions();

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function jsonText(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function sourceUrlForLead(lead_id, fallback = null) {
  if (fallback) return fallback;
  if (!lead_id) return null;
  return db.prepare(`SELECT source_url FROM leads WHERE id = ?`).get(lead_id)?.source_url || null;
}

function insertAuditEvent({
  created_at,
  event_type,
  lead_id,
  contact_event_id,
  entity_type,
  entity_id,
  action,
  worker,
  source_url,
  decision_code,
  decision_reason,
  metadata,
  dedupe_key
}) {
  db.prepare(`
    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, contact_event_id, entity_type, entity_id, action, worker,
      source_url, decision_code, decision_reason, metadata_json, dedupe_key
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    created_at || Date.now(),
    event_type,
    lead_id || null,
    contact_event_id || null,
    entity_type,
    entity_id || null,
    action,
    worker || null,
    sourceUrlForLead(lead_id, source_url || null),
    decision_code || null,
    decision_reason || null,
    jsonText(metadata),
    dedupe_key || null
  );
}

function insertComplianceDecision({
  id,
  created_at,
  lead_id,
  contact_event_id,
  direction,
  channel,
  subject_type,
  subject_id,
  allowed,
  decision_code,
  decision_reason,
  source_url,
  metadata,
  dedupe_key
}) {
  const decisionId = id || `decision_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    INSERT OR IGNORE INTO compliance_decisions (
      id, created_at, lead_id, contact_event_id, direction, channel, subject_type, subject_id,
      allowed, decision_code, decision_reason, source_url, metadata_json, dedupe_key
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decisionId,
    created_at || Date.now(),
    lead_id || null,
    contact_event_id || null,
    direction,
    channel || null,
    subject_type,
    subject_id || null,
    allowed === undefined || allowed === null ? null : allowed ? 1 : 0,
    decision_code,
    decision_reason,
    sourceUrlForLead(lead_id, source_url || null),
    jsonText(metadata),
    dedupe_key || null
  );
  return decisionId;
}

function timelineRows(rows, kind) {
  return rows.map((row) => ({
    kind,
    id: row.id,
    created_at: row.created_at,
    event_type: row.event_type || (kind === 'compliance_decision' ? 'compliance.decision' : null),
    lead_id: row.lead_id || null,
    contact_event_id: row.contact_event_id || null,
    entity_type: row.entity_type || row.subject_type || null,
    entity_id: row.entity_id || row.subject_id || null,
    action: row.action || 'decision',
    worker: row.worker || null,
    direction: row.direction || null,
    channel: row.channel || null,
    allowed: row.allowed === undefined || row.allowed === null ? null : Boolean(row.allowed),
    source_url: row.source_url || null,
    decision_code: row.decision_code || null,
    decision_reason: row.decision_reason || null,
    metadata: safeJson(row.metadata_json)
  }));
}

function sortTimeline(rows, limit) {
  return rows
    .sort((a, b) => (b.created_at - a.created_at) || String(b.id).localeCompare(String(a.id)))
    .slice(0, limit);
}

function outboundDecisionReason({ channel, type, metadata }) {
  return metadata?.decisionReason ||
    metadata?.decision_reason ||
    metadata?.classification?.reason ||
    metadata?.reason ||
    `outbound ${channel || 'contact'} ${type || 'event'} recorded`;
}

function limitFor(value, fallback = 100, max = 500) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

function contactEventIds({ contact_event_id, thread_id, provider_id, lead_id } = {}) {
  const ids = new Set();
  if (contact_event_id) ids.add(contact_event_id);
  if (thread_id || provider_id || (!ids.size && lead_id)) {
    const clauses = [];
    const args = [];
    if (thread_id) {
      clauses.push('thread_id = ?');
      args.push(thread_id);
    }
    if (provider_id) {
      clauses.push('provider_id = ?');
      args.push(provider_id);
    }
    if (!clauses.length && lead_id) {
      clauses.push('lead_id = ?');
      args.push(lead_id);
    }
    if (clauses.length) {
      const leadFilter = lead_id && (thread_id || provider_id) ? 'AND lead_id = ?' : '';
      if (leadFilter) args.push(lead_id);
      for (const row of db.prepare(`
        SELECT id FROM contact_events
        WHERE (${clauses.join(' OR ')}) ${leadFilter}
        ORDER BY created_at DESC
        LIMIT 200
      `).all(...args)) {
        ids.add(row.id);
      }
    }
  }
  return [...ids];
}

const LEAD_MUTABLE_COLUMNS = new Set([
  'container_tag',
  'business_name',
  'phone',
  'address',
  'niche',
  'city',
  'website',
  'status',
  'research_status',
  'outreach_status',
  'risk_status',
  'consent_status',
  'phone_classification',
  'last_contacted_at',
  'next_action',
  'source_url',
  'agentmail_thread_id',
  'normalized_phone',
  'normalized_name',
  'normalized_city',
  'normalized_source_url',
  'duplicate_count',
  'last_duplicate_at',
  'last_duplicate_reason',
  'duplicate_of',
  'online_presence_strength',
  'presence_confidence',
  'callable_reason',
  'blocked_reason',
  'research_json'
]);

const STATUS_RANK = {
  discovered: 0,
  closing: 1,
  callback: 2,
  awaiting_payment: 3,
  paid: 4,
  shipped: 5,
  unreachable: 6,
  rejected: 6
};

const RESEARCH_RANK = {
  new: 0,
  researching: 1,
  researched: 2,
  complete: 3,
  qualified: 4,
  not_qualified: 4,
  duplicate_merged: 4
};

function normalizePhoneForDedupe(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) digits = `1${digits}`;
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

function normalizeTextForDedupe(raw) {
  if (!raw) return null;
  const normalized = String(raw)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized || null;
}

function normalizeUrlForDedupe(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '');
    return `${url.hostname}${url.pathname}`.toLowerCase() || null;
  } catch {
    return value
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '') || null;
  }
}

function leadDedupeKeys(row) {
  return {
    normalized_phone: normalizePhoneForDedupe(row.phone),
    normalized_name: normalizeTextForDedupe(row.business_name),
    normalized_city: normalizeTextForDedupe(row.city),
    normalized_source_url: normalizeUrlForDedupe(row.source_url)
  };
}

function leadDefaults(row, now = Date.now()) {
  const out = {
    created_at: now,
    updated_at: now,
    status: 'discovered',
    research_status: 'new',
    outreach_status: 'not_queued',
    risk_status: 'unknown',
    consent_status: 'unknown',
    phone_classification: 'unknown',
    last_contacted_at: null,
    next_action: null,
    source_url: null,
    agentmail_thread_id: null,
    duplicate_count: 0,
    last_duplicate_at: null,
    last_duplicate_reason: null,
    duplicate_of: null,
    online_presence_strength: null,
    presence_confidence: null,
    callable_reason: null,
    blocked_reason: null,
    research_json: null,
    ...row
  };
  return { ...out, ...leadDedupeKeys(out) };
}

function backfillLeadDedupeKeys() {
  const rows = db.prepare(`
    SELECT id, business_name, phone, city, source_url,
           normalized_phone, normalized_name, normalized_city, normalized_source_url
    FROM leads
  `).all();
  const update = db.prepare(`
    UPDATE leads
    SET normalized_phone = @normalized_phone,
        normalized_name = @normalized_name,
        normalized_city = @normalized_city,
        normalized_source_url = @normalized_source_url
    WHERE id = @id
  `);
  const apply = db.transaction(() => {
    for (const row of rows) {
      const keys = leadDedupeKeys(row);
      if (
        row.normalized_phone !== keys.normalized_phone ||
        row.normalized_name !== keys.normalized_name ||
        row.normalized_city !== keys.normalized_city ||
        row.normalized_source_url !== keys.normalized_source_url
      ) {
        update.run({ id: row.id, ...keys });
      }
    }
  });
  apply();
}

function backfillAuditEvents() {
  db.exec(`
    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, source_url, metadata_json, dedupe_key
    )
    SELECT created_at, 'research.lead.created', id, 'lead', id, 'created', source_url,
      json_object('business_name', business_name, 'status', status, 'research_status', research_status),
      'lead:' || id || ':created'
    FROM leads;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, worker, metadata_json, dedupe_key
    )
    SELECT ts,
      CASE WHEN action = 'created' THEN 'research.lead.created' ELSE 'lead.' || action END,
      lead_id, 'lead', lead_id, action, actor,
      json_object('summary', summary, 'metadata', metadata_json),
      'lead_history:' || id
    FROM lead_history;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, worker, metadata_json, dedupe_key
    )
    SELECT started_at, 'worker.run.started', lead_id, 'worker_run', id, 'started', worker,
      detail_json, 'worker_run:' || id || ':started'
    FROM worker_runs;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, worker, metadata_json, dedupe_key
    )
    SELECT finished_at, 'worker.run.finished', lead_id, 'worker_run', id, state, worker,
      json_object('state', state, 'error', error, 'detail', detail_json),
      'worker_run:' || id || ':finished'
    FROM worker_runs
    WHERE finished_at IS NOT NULL;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, worker, metadata_json, dedupe_key
    )
    SELECT ts, type, lead_id, 'event', CAST(id AS TEXT), 'emitted', worker, payload_json, 'event:' || id
    FROM events;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, decision_reason, metadata_json, dedupe_key
    )
    SELECT started_at, 'call.started', lead_id, 'call', id, 'started', decision_reason,
      json_object('provider_call_id', provider_call_id, 'to_phone', to_phone, 'disclosure_text', disclosure_text),
      'call:' || id || ':started'
    FROM calls;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, metadata_json, dedupe_key
    )
    SELECT ended_at, 'call.finished', lead_id, 'call', id, 'finished',
      json_object('outcome', outcome, 'state', state),
      'call:' || id || ':finished'
    FROM calls
    WHERE ended_at IS NOT NULL;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, metadata_json, dedupe_key
    )
    SELECT created_at, 'payment.created', lead_id, 'payment', id, 'created',
      json_object('status', status, 'amount_cents', amount_cents, 'stripe_invoice_id', stripe_invoice_id),
      'payment:' || id || ':created'
    FROM payments;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, metadata_json, dedupe_key
    )
    SELECT paid_at, 'payment.paid', lead_id, 'payment', id, 'paid',
      json_object('status', status, 'stripe_invoice_id', stripe_invoice_id, 'stripe_session_id', stripe_session_id),
      'payment:' || id || ':paid'
    FROM payments
    WHERE paid_at IS NOT NULL;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, metadata_json, dedupe_key
    )
    SELECT started_at, 'build.started', lead_id, 'build', id, 'started',
      json_object('browser_session_id', browser_session_id, 'live_url', live_url, 'lovable_url', lovable_url, 'status', status),
      'build:' || id || ':started'
    FROM builds;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, entity_type, entity_id, action, metadata_json, dedupe_key
    )
    SELECT finished_at, 'build.finished', lead_id, 'build', id, 'finished',
      json_object('status', status, 'project_url', project_url, 'live_url', live_url, 'error', error),
      'build:' || id || ':finished'
    FROM builds
    WHERE finished_at IS NOT NULL;

    INSERT OR IGNORE INTO audit_events (
      created_at, event_type, lead_id, contact_event_id, entity_type, entity_id, action, metadata_json, dedupe_key
    )
    SELECT created_at, 'contact.' || channel || '.' || type, lead_id, id, 'contact_event', id, direction,
      metadata_json, 'contact_event:' || id
    FROM contact_events;
  `);
}

function backfillComplianceDecisions() {
  db.exec(`
    INSERT OR IGNORE INTO compliance_decisions (
      id, created_at, lead_id, direction, channel, subject_type, subject_id, allowed,
      decision_code, decision_reason, source_url, metadata_json, dedupe_key
    )
    SELECT 'decision_' || id, created_at, lead_id, 'outbound', 'phone', 'call_attempt', id, allowed,
      CASE WHEN allowed = 1 THEN 'call.allowed' ELSE 'call.blocked' END,
      reason,
      (SELECT source_url FROM leads WHERE leads.id = call_attempts.lead_id),
      json_object('phone', phone, 'disclosure_text', disclosure_text),
      'call_attempt:' || id
    FROM call_attempts;

    INSERT OR IGNORE INTO compliance_decisions (
      id, created_at, lead_id, contact_event_id, direction, channel, subject_type, subject_id, allowed,
      decision_code, decision_reason, source_url, metadata_json, dedupe_key
    )
    SELECT 'decision_' || id, created_at, lead_id, id, direction, channel, 'contact_event', id, 1,
      channel || '.outbound.' || type,
      'outbound ' || channel || ' ' || type || ' recorded',
      (SELECT source_url FROM leads WHERE leads.id = contact_events.lead_id),
      metadata_json,
      'contact_event_decision:' || id
    FROM contact_events
    WHERE direction = 'outbound';
  `);
}

function addHistory({ leadId, action, actor = 'system', summary = null, metadata = null, ts = Date.now() }) {
  const info = db.prepare(`
    INSERT INTO lead_history (lead_id, ts, action, actor, summary, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(leadId, ts, action, actor, summary, metadata ? JSON.stringify(metadata) : null);
  insertAuditEvent({
    created_at: ts,
    event_type: action === 'created' ? 'research.lead.created' : `lead.${action}`,
    lead_id: leadId,
    entity_type: 'lead',
    entity_id: leadId,
    action,
    worker: actor,
    source_url: metadata?.lead?.source_url || metadata?.incoming?.source_url || null,
    metadata: { summary, ...metadata },
    dedupe_key: `lead_history:${info.lastInsertRowid}`
  });
}

function diffLead(before, after, columns) {
  const changed = {};
  for (const col of columns) {
    const from = before?.[col] ?? null;
    const to = after?.[col] ?? null;
    if (from !== to) changed[col] = { from, to };
  }
  return changed;
}

function safeHistorySnapshot(row) {
  if (!row) return null;
  const copy = { ...row };
  delete copy.created_at;
  delete copy.updated_at;
  return copy;
}

function compactProfileForHistory(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    businessName: profile.businessName,
    onlinePresenceStrength: profile.onlinePresenceStrength,
    presenceConfidence: profile.presenceConfidence,
    sourceUrl: profile.sourceUrl,
    yelpUrl: profile.yelpUrl,
    phone: profile.phone,
    address: profile.address
  };
}

function applyLeadPatch(id, patch, { action = 'updated', summary = null, metadata = null } = {}) {
  const before = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
  if (!before) return null;

  const cols = Object.keys(patch).filter((c) => LEAD_MUTABLE_COLUMNS.has(c));
  const preview = { ...before, ...Object.fromEntries(cols.map((c) => [c, patch[c] ?? null])) };
  const keys = leadDedupeKeys(preview);
  for (const [key, value] of Object.entries(keys)) {
    if (!cols.includes(key)) cols.push(key);
    patch[key] = value;
  }

  const changedCols = cols.filter((c) => (before[c] ?? null) !== (patch[c] ?? null));
  if (!changedCols.length) {
    if (action.startsWith('duplicate')) {
      addHistory({ leadId: id, action, summary, metadata: { ...metadata, changed: {} } });
    }
    return before;
  }

  const sets = changedCols.map((c) => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE leads SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({
    ...Object.fromEntries(changedCols.map((c) => [c, patch[c] ?? null])),
    id,
    updated_at: Date.now()
  });
  const after = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
  const changed = diffLead(before, after, changedCols);
  addHistory({ leadId: id, action, summary, metadata: { ...metadata, changed } });
  return after;
}

function addCandidate(map, lead, reason) {
  if (!lead) return;
  const entry = map.get(lead.id) || { lead, reasons: [] };
  if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  map.set(lead.id, entry);
}

function findDuplicateCandidate(row) {
  const candidates = new Map();
  if (row.id) {
    const existingById = db.prepare(`SELECT * FROM leads WHERE id = ?`).get(row.id);
    if (existingById) return { lead: existingById, reasons: ['id'] };
  }
  if (row.normalized_phone) {
    for (const lead of db.prepare(`SELECT * FROM leads WHERE normalized_phone = ?`).all(row.normalized_phone)) {
      addCandidate(candidates, lead, 'phone');
    }
  }
  if (row.normalized_source_url) {
    for (const lead of db.prepare(`SELECT * FROM leads WHERE normalized_source_url = ?`).all(row.normalized_source_url)) {
      addCandidate(candidates, lead, 'source_url');
    }
  }
  if (row.normalized_name && row.normalized_city) {
    for (const lead of db.prepare(`
      SELECT * FROM leads
      WHERE normalized_name = ? AND normalized_city = ?
    `).all(row.normalized_name, row.normalized_city)) {
      addCandidate(candidates, lead, 'name_city');
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => {
    if (b.reasons.length !== a.reasons.length) return b.reasons.length - a.reasons.length;
    return (a.lead.created_at || 0) - (b.lead.created_at || 0);
  });
  return ranked[0] || null;
}

function isBlank(value) {
  return value === null || value === undefined || value === '';
}

function shouldReplaceName(current, incoming) {
  if (isBlank(current)) return !isBlank(incoming);
  return /^unknown business$/i.test(String(current)) && !/^unknown business$/i.test(String(incoming || ''));
}

function pickRanked(current, incoming, rank) {
  if (isBlank(incoming)) return current;
  if (isBlank(current)) return incoming;
  return (rank[incoming] ?? 0) > (rank[current] ?? 0) ? incoming : current;
}

function pickIfGeneric(current, incoming, genericValues = ['unknown', 'pending', 'invalid']) {
  if (isBlank(incoming)) return current;
  if (isBlank(current) || genericValues.includes(current)) return incoming;
  return current;
}

function buildDuplicateMergePatch(existing, incoming, reasons, now) {
  const patch = {
    duplicate_count: (existing.duplicate_count || 0) + 1,
    last_duplicate_at: now,
    last_duplicate_reason: reasons.join(','),
    duplicate_of: existing.duplicate_of || existing.id
  };

  if (shouldReplaceName(existing.business_name, incoming.business_name)) patch.business_name = incoming.business_name;
  for (const col of ['phone', 'address', 'niche', 'city', 'source_url', 'agentmail_thread_id']) {
    if (isBlank(existing[col]) && !isBlank(incoming[col])) patch[col] = incoming[col];
  }
  for (const col of ['online_presence_strength', 'presence_confidence', 'callable_reason', 'blocked_reason', 'research_json']) {
    if (!isBlank(incoming[col])) patch[col] = incoming[col];
  }
  if ((isBlank(existing.website) || existing.website === 'null') && !isBlank(incoming.website)) patch.website = incoming.website;
  if (isBlank(existing.last_contacted_at) && !isBlank(incoming.last_contacted_at)) patch.last_contacted_at = incoming.last_contacted_at;
  if (isBlank(existing.next_action) && !isBlank(incoming.next_action)) patch.next_action = incoming.next_action;

  patch.status = pickRanked(existing.status, incoming.status, STATUS_RANK);
  patch.research_status = pickRanked(existing.research_status, incoming.research_status, RESEARCH_RANK);
  patch.risk_status = pickIfGeneric(existing.risk_status, incoming.risk_status);
  patch.consent_status = pickIfGeneric(existing.consent_status, incoming.consent_status, ['unknown']);
  patch.phone_classification = pickIfGeneric(existing.phone_classification, incoming.phone_classification);

  return patch;
}

export const leads = {
  insert(row) {
    const now = Date.now();
    const record = leadDefaults(row, now);
    const runInsert = db.transaction(() => {
      const duplicate = findDuplicateCandidate(record);
      if (duplicate) {
        const idOnly = duplicate.reasons.includes('id') && duplicate.reasons.length === 1;
        const patch = buildDuplicateMergePatch(duplicate.lead, record, duplicate.reasons, now);
        if (idOnly) {
          delete patch.duplicate_count;
          delete patch.last_duplicate_at;
          delete patch.last_duplicate_reason;
          delete patch.duplicate_of;
        }
        const lead = applyLeadPatch(duplicate.lead.id, patch, {
          action: idOnly ? 'upsert_merged' : 'duplicate_merged',
          summary: `Merged incoming lead research by ${duplicate.reasons.join(', ')}`,
          metadata: {
            duplicate: !idOnly,
            duplicateReasons: duplicate.reasons,
            attemptedId: record.id,
            attemptedContainerTag: record.container_tag,
            incoming: safeHistorySnapshot(record)
          }
        });
        return {
          lead,
          inserted: false,
          duplicate: !idOnly,
          duplicateReasons: duplicate.reasons,
          attemptedId: record.id,
          attemptedContainerTag: record.container_tag
        };
      }

      db.prepare(`
      INSERT INTO leads (
        id, container_tag, business_name, phone, address, niche, city, website, status,
        research_status, outreach_status, risk_status, consent_status, phone_classification,
        last_contacted_at, next_action, source_url, agentmail_thread_id,
        normalized_phone, normalized_name, normalized_city, normalized_source_url,
        duplicate_count, last_duplicate_at, last_duplicate_reason, duplicate_of,
        online_presence_strength, presence_confidence, callable_reason, blocked_reason,
        research_json, created_at, updated_at
      )
      VALUES (
        @id, @container_tag, @business_name, @phone, @address, @niche, @city, @website, @status,
        @research_status, @outreach_status, @risk_status, @consent_status, @phone_classification,
        @last_contacted_at, @next_action, @source_url, @agentmail_thread_id,
        @normalized_phone, @normalized_name, @normalized_city, @normalized_source_url,
        @duplicate_count, @last_duplicate_at, @last_duplicate_reason, @duplicate_of,
        @online_presence_strength, @presence_confidence, @callable_reason, @blocked_reason,
        @research_json, @created_at, @updated_at
      )
    `).run(record);
      addHistory({
        leadId: record.id,
        action: 'created',
        summary: 'Lead created',
        metadata: { lead: safeHistorySnapshot(record) },
        ts: now
      });
      return {
        lead: db.prepare(`SELECT * FROM leads WHERE id = ?`).get(record.id),
        inserted: true,
        duplicate: false,
        duplicateReasons: [],
        attemptedId: record.id,
        attemptedContainerTag: record.container_tag
      };
    });
    return runInsert();
  },
  upsertResearch(row, { actor = 'scraper', profile = null, runId = null } = {}) {
    const result = this.insert(row);
    if (!result.inserted && result.lead) {
      addHistory({
        leadId: result.lead.id,
        action: 'research_merged',
        actor,
        summary: 'Research profile merged into existing lead',
        metadata: {
          runId,
          matchReasons: result.duplicateReasons || [],
          profile: compactProfileForHistory(profile)
        }
      });
    }
    return result;
  },
  update(id, patch) {
    if (!Object.keys(patch).length) return this.get(id);
    return applyLeadPatch(id, patch, { action: 'updated', summary: 'Lead updated' });
  },
  get(id) {
    return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(id);
  },
  getByTag(tag) {
    return db.prepare(`SELECT * FROM leads WHERE container_tag = ?`).get(tag);
  },
  list({ limit = 50 } = {}) {
    return db.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT ?`).all(limit);
  },
  history(lead_id, { limit = 50 } = {}) {
    return db.prepare(`SELECT * FROM lead_history WHERE lead_id = ? ORDER BY ts DESC, id DESC LIMIT ?`).all(lead_id, limit);
  },
  findDuplicate(row) {
    return findDuplicateCandidate(leadDefaults(row, Date.now()));
  },
  listOutreachQueue({ limit = 10 } = {}) {
    return db.prepare(`
      SELECT * FROM leads
      WHERE outreach_status IN ('queued', 'retry')
        AND research_status IN ('qualified', 'complete', 'researched')
      ORDER BY COALESCE(last_contacted_at, 0) ASC, created_at ASC
      LIMIT ?
    `).all(limit);
  },
  claimOutreach(id, {
    now = Date.now(),
    riskStatus = 'callable',
    phoneClassification = null,
    nextAction = 'call_in_progress',
    actor = 'caller'
  } = {}) {
    const runClaim = db.transaction(() => {
      const before = this.get(id);
      if (!before) return { claimed: false, reason: 'not_found', row: null };
      const info = db.prepare(`
        UPDATE leads
        SET
          outreach_status = 'running',
          risk_status = ?,
          phone_classification = COALESCE(?, phone_classification),
          last_contacted_at = ?,
          next_action = ?,
          updated_at = ?
        WHERE id = ?
          AND outreach_status IN ('queued', 'retry')
          AND (
            next_action IS NULL
            OR next_action NOT LIKE 'retry_after:%'
            OR CAST(substr(next_action, 13) AS INTEGER) <= ?
          )
      `).run(riskStatus, phoneClassification, now, nextAction, now, id, now);
      const row = this.get(id);
      if (info.changes <= 0) {
        return { claimed: false, reason: row ? `already_${row.outreach_status}` : 'not_found', row };
      }
      addHistory({
        leadId: id,
        action: 'outreach_claimed',
        actor,
        summary: 'Outreach worker claimed queued lead',
        metadata: {
          changed: diffLead(before, row, ['outreach_status', 'risk_status', 'phone_classification', 'last_contacted_at', 'next_action'])
        },
        ts: now
      });
      return { claimed: true, reason: 'claimed', row };
    });
    return runClaim();
  },
  outreachSummary() {
    return {
      queued: db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE outreach_status IN ('queued', 'retry')`).get().n,
      blocked: db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE outreach_status = 'blocked'`).get().n,
      calling: db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE outreach_status = 'calling'`).get().n,
      awaitingPayment: db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status = 'awaiting_payment'`).get().n,
      paid: db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status = 'paid'`).get().n,
      shipped: db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE status = 'shipped'`).get().n
    };
  }
};

export const runs = {
  start({ id, lead_id, worker }) {
    const startedAt = Date.now();
    db.prepare(`
      INSERT INTO worker_runs (id, lead_id, worker, state, started_at) VALUES (?, ?, ?, 'running', ?)
    `).run(id, lead_id || null, worker, startedAt);
    insertAuditEvent({
      created_at: startedAt,
      event_type: 'worker.run.started',
      lead_id,
      entity_type: 'worker_run',
      entity_id: id,
      action: 'started',
      worker,
      dedupe_key: `worker_run:${id}:started`
    });
  },
  finish(id, { state, error, detail }) {
    const finishedAt = Date.now();
    const row = db.prepare(`SELECT * FROM worker_runs WHERE id = ?`).get(id);
    db.prepare(`UPDATE worker_runs SET state = ?, finished_at = ?, error = ?, detail_json = ? WHERE id = ?`).run(
      state,
      finishedAt,
      error || null,
      detail ? JSON.stringify(detail) : null,
      id
    );
    insertAuditEvent({
      created_at: finishedAt,
      event_type: 'worker.run.finished',
      lead_id: row?.lead_id || null,
      entity_type: 'worker_run',
      entity_id: id,
      action: state,
      worker: row?.worker || null,
      metadata: { state, error: error || null, detail },
      dedupe_key: `worker_run:${id}:finished`
    });
  },
  list({ lead_id, limit = 50 } = {}) {
    if (lead_id) {
      return db.prepare(`SELECT * FROM worker_runs WHERE lead_id = ? ORDER BY started_at DESC LIMIT ?`).all(lead_id, limit);
    }
    return db.prepare(`SELECT * FROM worker_runs ORDER BY started_at DESC LIMIT ?`).all(limit);
  }
};

export const events = {
  insert({ type, lead_id, worker, payload }) {
    const ts = Date.now();
    const info = db.prepare(`INSERT INTO events (ts, type, lead_id, worker, payload_json) VALUES (?, ?, ?, ?, ?)`).run(
      ts,
      type,
      lead_id || null,
      worker || null,
      payload ? JSON.stringify(payload) : null
    );
    insertAuditEvent({
      created_at: ts,
      event_type: type,
      lead_id,
      entity_type: 'event',
      entity_id: String(info.lastInsertRowid),
      action: 'emitted',
      worker,
      source_url: payload?.sourceUrl || payload?.source_url || null,
      decision_code: payload?.decisionCode || payload?.decision_code || null,
      decision_reason: payload?.decisionReason || payload?.decision_reason || payload?.reason || null,
      metadata: payload,
      dedupe_key: `event:${info.lastInsertRowid}`
    });
  },
  list({ since = 0, limit = 200 } = {}) {
    return db.prepare(`SELECT * FROM events WHERE ts > ? ORDER BY ts ASC LIMIT ?`).all(since, limit);
  },
  listByLead(lead_id, { worker, limit = 100 } = {}) {
    if (worker) {
      return db.prepare(`
        SELECT * FROM (
          SELECT * FROM events
          WHERE lead_id = ? AND worker = ?
          ORDER BY ts DESC
          LIMIT ?
        ) ORDER BY ts ASC
      `).all(lead_id, worker, limit);
    }
    return db.prepare(`
      SELECT * FROM (
        SELECT * FROM events
        WHERE lead_id = ?
        ORDER BY ts DESC
        LIMIT ?
      ) ORDER BY ts ASC
    `).all(lead_id, limit);
  }
};

export const calls = {
  start({ id, lead_id, to_phone, provider_call_id, disclosure_text, decision_reason }) {
    const startedAt = Date.now();
    db.prepare(`
      INSERT INTO calls (id, lead_id, provider_call_id, to_phone, disclosure_text, decision_reason, state, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?)
    `).run(id, lead_id, provider_call_id || null, to_phone || null, disclosure_text || null, decision_reason || null, startedAt);
    insertAuditEvent({
      created_at: startedAt,
      event_type: 'call.started',
      lead_id,
      entity_type: 'call',
      entity_id: id,
      action: 'started',
      decision_reason,
      metadata: { provider_call_id: provider_call_id || null, to_phone: to_phone || null, disclosure_text: disclosure_text || null },
      dedupe_key: `call:${id}:started`
    });
  },
  finish(id, { outcome, transcript }) {
    const endedAt = Date.now();
    const row = this.get(id);
    db.prepare(`UPDATE calls SET state = 'ended', outcome = ?, transcript_json = ?, ended_at = ? WHERE id = ?`).run(
      outcome || null,
      transcript ? JSON.stringify(transcript) : null,
      endedAt,
      id
    );
    insertAuditEvent({
      created_at: endedAt,
      event_type: 'call.finished',
      lead_id: row?.lead_id || null,
      entity_type: 'call',
      entity_id: id,
      action: 'finished',
      metadata: { outcome: outcome || null, hasTranscript: Boolean(transcript) },
      dedupe_key: `call:${id}:finished`
    });
  },
  get(id) {
    return db.prepare(`SELECT * FROM calls WHERE id = ?`).get(id);
  },
  listByLead(lead_id) {
    return db.prepare(`SELECT * FROM calls WHERE lead_id = ? ORDER BY started_at DESC`).all(lead_id);
  }
};

export const payments = {
  insert(row) {
    const record = {
      created_at: Date.now(),
      status: 'created',
      stripe_session_id: null,
      stripe_invoice_id: null,
      stripe_customer_id: null,
      customer_email: null,
      payment_link_url: null,
      hosted_invoice_url: null,
      invoice_pdf_url: null,
      amount_cents: null,
      due_at: null,
      idempotency_key: null,
      offer_version: null,
      build_triggered_at: null,
      ...row
    };
    db.prepare(`
      INSERT INTO payments (
        id, lead_id, stripe_session_id, stripe_invoice_id, stripe_customer_id, customer_email, payment_link_url,
        hosted_invoice_url, invoice_pdf_url, amount_cents, status, due_at, idempotency_key, offer_version, created_at, build_triggered_at
      )
      VALUES (
        @id, @lead_id, @stripe_session_id, @stripe_invoice_id, @stripe_customer_id, @customer_email, @payment_link_url,
        @hosted_invoice_url, @invoice_pdf_url, @amount_cents, @status, @due_at, @idempotency_key, @offer_version, @created_at, @build_triggered_at
      )
    `).run(record);
    insertAuditEvent({
      created_at: record.created_at,
      event_type: 'payment.created',
      lead_id: record.lead_id,
      entity_type: 'payment',
      entity_id: record.id,
      action: 'created',
      metadata: {
        status: record.status,
        amount_cents: record.amount_cents,
        stripe_invoice_id: record.stripe_invoice_id,
        stripe_session_id: record.stripe_session_id,
        customer_email: record.customer_email,
        payment_link_url: record.payment_link_url,
        hosted_invoice_url: record.hosted_invoice_url,
        invoice_pdf_url: record.invoice_pdf_url,
        offer_version: record.offer_version
      },
      dedupe_key: `payment:${record.id}:created`
    });
  },
  insertOrGetByIdempotency(row) {
    if (!row.idempotency_key) {
      this.insert(row);
      return { inserted: true, row: this.get(row.id) };
    }
    const record = {
      created_at: Date.now(),
      status: 'created',
      stripe_session_id: null,
      stripe_invoice_id: null,
      stripe_customer_id: null,
      customer_email: null,
      payment_link_url: null,
      hosted_invoice_url: null,
      invoice_pdf_url: null,
      amount_cents: null,
      due_at: null,
      offer_version: null,
      build_triggered_at: null,
      ...row
    };
    const info = db.prepare(`
      INSERT OR IGNORE INTO payments (
        id, lead_id, stripe_session_id, stripe_invoice_id, stripe_customer_id, customer_email, payment_link_url,
        hosted_invoice_url, invoice_pdf_url, amount_cents, status, due_at, idempotency_key, offer_version, created_at, build_triggered_at
      )
      VALUES (
        @id, @lead_id, @stripe_session_id, @stripe_invoice_id, @stripe_customer_id, @customer_email, @payment_link_url,
        @hosted_invoice_url, @invoice_pdf_url, @amount_cents, @status, @due_at, @idempotency_key, @offer_version, @created_at, @build_triggered_at
      )
    `).run(record);
    if (info.changes > 0) {
      insertAuditEvent({
        created_at: record.created_at,
        event_type: 'payment.created',
        lead_id: record.lead_id,
        entity_type: 'payment',
        entity_id: record.id,
        action: 'created',
        metadata: {
          status: record.status,
          amount_cents: record.amount_cents,
          stripe_invoice_id: record.stripe_invoice_id,
          stripe_session_id: record.stripe_session_id,
          customer_email: record.customer_email,
          payment_link_url: record.payment_link_url,
          hosted_invoice_url: record.hosted_invoice_url,
          invoice_pdf_url: record.invoice_pdf_url,
          offer_version: record.offer_version
        },
        dedupe_key: `payment:${record.id}:created`
      });
    }
    return { inserted: info.changes > 0, row: this.getByIdempotency(row.idempotency_key) };
  },
  get(id) {
    return db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id);
  },
  getByInvoice(stripe_invoice_id) {
    return db.prepare(`SELECT * FROM payments WHERE stripe_invoice_id = ? OR stripe_session_id = ?`).get(stripe_invoice_id, stripe_invoice_id);
  },
  getByIdempotency(idempotency_key) {
    return db.prepare(`SELECT * FROM payments WHERE idempotency_key = ?`).get(idempotency_key);
  },
  markPaid(stripe_id, details = {}) {
    let existing = this.getByInvoice(stripe_id);
    if (!existing && details.stripe_invoice_id) existing = this.getByInvoice(details.stripe_invoice_id);
    if (!existing && details.stripe_session_id) existing = this.getByInvoice(details.stripe_session_id);
    if (!existing && details.lead_id) {
      const now = Date.now();
      const info = db.prepare(`
        INSERT OR IGNORE INTO payments (
          id, lead_id, stripe_session_id, stripe_invoice_id, stripe_customer_id, customer_email, payment_link_url,
          hosted_invoice_url, invoice_pdf_url, amount_cents, status, due_at, idempotency_key, offer_version, created_at, paid_at, build_triggered_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, NULL)
      `).run(
        details.id || paymentIdForStripe(stripe_id),
        details.lead_id,
        details.stripe_session_id || stripe_id,
        details.stripe_invoice_id || stripe_id,
        details.stripe_customer_id || null,
        details.customer_email || null,
        details.payment_link_url || null,
        details.hosted_invoice_url || null,
        details.invoice_pdf_url || null,
        details.amount_cents || null,
        details.due_at || null,
        details.idempotency_key || null,
        details.offer_version || null,
        now,
        now
      );
      existing = this.getByInvoice(stripe_id);
      if (info.changes > 0 && existing) {
        insertAuditEvent({
          created_at: now,
          event_type: 'payment.created',
          lead_id: existing.lead_id,
          entity_type: 'payment',
          entity_id: existing.id,
          action: 'created',
          metadata: { status: 'paid', stripe_id, ...details },
          dedupe_key: `payment:${existing.id}:created`
        });
        insertAuditEvent({
          created_at: now,
          event_type: 'payment.paid',
          lead_id: existing.lead_id,
          entity_type: 'payment',
          entity_id: existing.id,
          action: 'paid',
          metadata: { stripe_id, ...details },
          dedupe_key: `payment:${existing.id}:paid`
        });
      }
      return { changed: info.changes > 0, row: existing };
    }
    if (!existing) return { changed: false, row: null };
    if (existing.status === 'paid') return { changed: false, row: existing };
    const paidAt = Date.now();
    const info = db.prepare(`
      UPDATE payments
      SET
        status = 'paid',
        paid_at = ?,
        stripe_session_id = COALESCE(stripe_session_id, ?),
        stripe_invoice_id = COALESCE(stripe_invoice_id, ?),
        stripe_customer_id = COALESCE(stripe_customer_id, ?),
        customer_email = COALESCE(customer_email, ?),
        hosted_invoice_url = COALESCE(hosted_invoice_url, ?),
        payment_link_url = COALESCE(payment_link_url, ?),
        invoice_pdf_url = COALESCE(invoice_pdf_url, ?),
        amount_cents = COALESCE(amount_cents, ?)
      WHERE id = ? AND status != 'paid'
    `).run(
      paidAt,
      details.stripe_session_id || null,
      details.stripe_invoice_id || null,
      details.stripe_customer_id || null,
      details.customer_email || null,
      details.hosted_invoice_url || null,
      details.payment_link_url || null,
      details.invoice_pdf_url || null,
      details.amount_cents || null,
      existing.id
    );
    const row = this.getByInvoice(stripe_id) || this.get(existing.id);
    if (info.changes > 0) {
      insertAuditEvent({
        created_at: paidAt,
        event_type: 'payment.paid',
        lead_id: row?.lead_id || existing.lead_id,
        entity_type: 'payment',
        entity_id: existing.id,
        action: 'paid',
        metadata: { stripe_id, ...details },
        dedupe_key: `payment:${existing.id}:paid`
      });
    }
    return { changed: info.changes > 0, row };
  },
  claimBuilderTrigger(payment_id) {
    const existing = this.get(payment_id);
    if (!existing) return { claimed: false, row: null };
    const triggeredAt = Date.now();
    const info = db.prepare(`
      UPDATE payments
      SET build_triggered_at = ?
      WHERE id = ? AND status = 'paid' AND build_triggered_at IS NULL
    `).run(triggeredAt, payment_id);
    const row = this.get(payment_id);
    if (info.changes > 0) {
      insertAuditEvent({
        created_at: triggeredAt,
        event_type: 'payment.build_trigger.claimed',
        lead_id: row?.lead_id || existing.lead_id,
        entity_type: 'payment',
        entity_id: payment_id,
        action: 'build_trigger_claimed',
        metadata: { build_triggered_at: triggeredAt }
      });
    }
    return { claimed: info.changes > 0, row };
  },
  listTriggeredBuildsMissingRows({ limit = 25 } = {}) {
    return db.prepare(`
      SELECT p.*
      FROM payments p
      JOIN leads l ON l.id = p.lead_id
      LEFT JOIN builds b ON b.trigger_key = ('payment:' || p.id)
      WHERE p.status = 'paid'
        AND p.build_triggered_at IS NOT NULL
        AND l.status = 'paid'
        AND b.id IS NULL
      ORDER BY p.build_triggered_at ASC
      LIMIT ?
    `).all(limit);
  },
  listByLead(lead_id) {
    return db.prepare(`SELECT * FROM payments WHERE lead_id = ? ORDER BY created_at DESC`).all(lead_id);
  }
};

export const builds = {
  start({ id, lead_id, browser_session_id, live_url, lovable_url, brief }) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO builds (
        id, lead_id, browser_session_id, live_url, lovable_url, brief, status, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(id, lead_id, browser_session_id || null, live_url || null, lovable_url || null, brief || null, now, now);
    insertAuditEvent({
      created_at: now,
      event_type: 'build.started',
      lead_id,
      entity_type: 'build',
      entity_id: id,
      action: 'started',
      metadata: { browser_session_id: browser_session_id || null, live_url: live_url || null, lovable_url: lovable_url || null },
      dedupe_key: `build:${id}:started`
    });
  },
  get(id) {
    return db.prepare(`SELECT * FROM builds WHERE id = ?`).get(id);
  },
  getByTrigger(trigger_key) {
    return db.prepare(`SELECT * FROM builds WHERE trigger_key = ?`).get(trigger_key);
  },
  reservePaidBuild({ id, lead_id, trigger_key, now = Date.now(), staleAfterMs = 10 * 60 * 1000 }) {
    const buildId = id || buildIdForLead(lead_id);
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO builds (id, lead_id, status, started_at, trigger_key, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `).run(buildId, lead_id, now, trigger_key, now);
    if (inserted.changes) {
      insertAuditEvent({
        created_at: now,
        event_type: 'build.queued',
        lead_id,
        entity_type: 'build',
        entity_id: buildId,
        action: 'queued',
        metadata: { trigger_key },
        dedupe_key: `build:${buildId}:queued`
      });
      return { shouldStart: true, reason: 'created', row: this.get(buildId) };
    }

    const existing = this.getByTrigger(trigger_key);
    if (!existing) return { shouldStart: false, reason: 'missing_after_conflict', row: null };

    const staleCutoff = now - staleAfterMs;
    const recovered = db.prepare(`
      UPDATE builds
      SET status = 'queued', finished_at = NULL, error = NULL, updated_at = ?
      WHERE id = ?
        AND (
          status = 'failed'
          OR (status IN ('running', 'starting') AND COALESCE(updated_at, started_at, 0) < ?)
        )
    `).run(now, existing.id, staleCutoff);
    if (recovered.changes) {
      insertAuditEvent({
        created_at: now,
        event_type: 'build.recovered',
        lead_id: existing.lead_id,
        entity_type: 'build',
        entity_id: existing.id,
        action: 'recovered',
        metadata: { trigger_key, previous_status: existing.status }
      });
      return { shouldStart: true, reason: 'recovered', row: this.get(existing.id) };
    }

    return { shouldStart: false, reason: `already_${existing.status}`, row: existing };
  },
  claimStart({ id, lead_id, now = Date.now(), staleAfterMs = 10 * 60 * 1000 }) {
    const existing = this.get(id);
    if (!existing) {
      db.prepare(`
        INSERT INTO builds (id, lead_id, status, started_at, updated_at)
        VALUES (?, ?, 'running', ?, ?)
      `).run(id, lead_id, now, now);
      insertAuditEvent({
        created_at: now,
        event_type: 'build.started',
        lead_id,
        entity_type: 'build',
        entity_id: id,
        action: 'started',
        metadata: { created_by_claim: true },
        dedupe_key: `build:${id}:started`
      });
      return { claimed: true, reason: 'created', row: this.get(id) };
    }
    if (existing.lead_id !== lead_id) return { claimed: false, reason: 'lead_mismatch', row: existing };

    const staleCutoff = now - staleAfterMs;
    const claimed = db.prepare(`
      UPDATE builds
      SET status = 'running', started_at = ?, finished_at = NULL, error = NULL, updated_at = ?
      WHERE id = ?
        AND lead_id = ?
        AND (
          status IN ('queued', 'starting', 'failed')
          OR (status = 'running' AND COALESCE(updated_at, started_at, 0) < ?)
        )
    `).run(now, now, id, lead_id, staleCutoff);
    if (claimed.changes > 0) {
      insertAuditEvent({
        created_at: now,
        event_type: 'build.started',
        lead_id,
        entity_type: 'build',
        entity_id: id,
        action: 'started',
        metadata: { previous_status: existing.status, claimed: true },
        dedupe_key: `build:${id}:started`
      });
    }
    return {
      claimed: claimed.changes > 0,
      reason: claimed.changes > 0 ? 'claimed' : `already_${existing.status}`,
      row: this.get(id)
    };
  },
  claimRecovery(id, { now = Date.now(), staleAfterMs = 10 * 60 * 1000 } = {}) {
    const staleCutoff = now - staleAfterMs;
    const claimed = db.prepare(`
      UPDATE builds
      SET status = 'starting', finished_at = NULL, error = NULL, updated_at = ?
      WHERE id = ?
        AND (
          status IN ('queued', 'failed')
          OR (status IN ('running', 'starting') AND COALESCE(updated_at, started_at, 0) < ?)
        )
    `).run(now, id, staleCutoff);
    if (claimed.changes > 0) {
      const row = this.get(id);
      insertAuditEvent({
        created_at: now,
        event_type: 'build.recovery_claimed',
        lead_id: row?.lead_id || null,
        entity_type: 'build',
        entity_id: id,
        action: 'recovery_claimed',
        metadata: { staleAfterMs }
      });
    }
    return { claimed: claimed.changes > 0, row: this.get(id) };
  },
  recoverablePaidBuilds({ staleAfterMs = 10 * 60 * 1000, limit = 25 } = {}) {
    const staleCutoff = Date.now() - staleAfterMs;
    return db.prepare(`
      SELECT b.*
      FROM builds b
      JOIN leads l ON l.id = b.lead_id
      WHERE b.trigger_key LIKE 'payment:%'
        AND l.status = 'paid'
        AND (
          b.status IN ('queued', 'failed')
          OR (b.status IN ('running', 'starting') AND COALESCE(b.updated_at, b.started_at, 0) < ?)
        )
      ORDER BY COALESCE(b.updated_at, b.started_at, 0) ASC
      LIMIT ?
    `).all(staleCutoff, limit);
  },
  update(id, patch) {
    const next = { ...patch };
    if (!Object.prototype.hasOwnProperty.call(next, 'updated_at')) next.updated_at = Date.now();
    const before = this.get(id);
    const cols = Object.keys(next);
    if (!cols.length) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE builds SET ${sets} WHERE id = @id`).run({ ...next, id });
    const row = this.get(id);
    const finished = Object.prototype.hasOwnProperty.call(next, 'finished_at') || ['completed', 'failed', 'blocked_auth'].includes(next.status);
    insertAuditEvent({
      created_at: next.updated_at,
      event_type: finished ? 'build.finished' : 'build.updated',
      lead_id: row?.lead_id || before?.lead_id || null,
      entity_type: 'build',
      entity_id: id,
      action: next.status || 'updated',
      metadata: { patch: next, previous_status: before?.status || null },
      dedupe_key: null
    });
  },
  listByLead(lead_id) {
    return db.prepare(`SELECT * FROM builds WHERE lead_id = ? ORDER BY started_at DESC`).all(lead_id);
  }
};

export const buildHooks = {
  start({ build_id, lead_id, run_id, hook, attempt = 0, input, idempotency_key }) {
    const now = Date.now();
    const hookId = hookIdFor({ build_id, hook, attempt });
    db.prepare(`
      INSERT OR IGNORE INTO build_hooks (
        id, build_id, lead_id, run_id, hook, attempt, status, started_at, input_json, idempotency_key
      )
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)
    `).run(
      hookId,
      build_id,
      lead_id,
      run_id || null,
      hook,
      attempt,
      now,
      jsonText(input),
      idempotency_key || null
    );
    return this.getByIdempotency(idempotency_key) || this.get(hookId);
  },
  finish(id, { status, output, error }) {
    db.prepare(`
      UPDATE build_hooks
      SET status = ?, finished_at = ?, output_json = COALESCE(?, output_json), error = ?
      WHERE id = ?
    `).run(status, Date.now(), jsonText(output), error || null, id);
    return this.get(id);
  },
  get(id) {
    return hydrateHook(db.prepare(`SELECT * FROM build_hooks WHERE id = ?`).get(id));
  },
  getByIdempotency(idempotency_key) {
    if (!idempotency_key) return null;
    return hydrateHook(db.prepare(`SELECT * FROM build_hooks WHERE idempotency_key = ?`).get(idempotency_key));
  },
  listByBuild(build_id, { limit = 100 } = {}) {
    return db.prepare(`
      SELECT * FROM build_hooks
      WHERE build_id = ?
      ORDER BY started_at ASC
      LIMIT ?
    `).all(build_id, limitFor(limit)).map(hydrateHook);
  },
  listByLead(lead_id, { limit = 120 } = {}) {
    return db.prepare(`
      SELECT * FROM build_hooks
      WHERE lead_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit)).map(hydrateHook);
  }
};

export const buildQaResults = {
  upsert({ build_id, lead_id, attempt = 0, provider, url, status, passed, score, checklist, errors, claims, idempotency_key }) {
    const now = Date.now();
    const qaId = qaIdFor({ build_id, attempt });
    const key = idempotency_key || `build:${build_id}:qa:${attempt}`;
    db.prepare(`
      INSERT OR IGNORE INTO build_qa_results (
        id, build_id, lead_id, attempt, provider, url, status, passed, score,
        checklist_json, errors_json, claims_json, created_at, idempotency_key
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      qaId,
      build_id,
      lead_id,
      attempt,
      provider || 'fetch',
      url || null,
      status || (passed ? 'passed' : 'failed'),
      passed ? 1 : 0,
      Number.isFinite(Number(score)) ? Number(score) : null,
      jsonText(checklist || []),
      jsonText(errors || []),
      jsonText(claims || {}),
      now,
      key
    );
    db.prepare(`
      UPDATE build_qa_results
      SET provider = ?, url = ?, status = ?, passed = ?, score = ?,
          checklist_json = ?, errors_json = ?, claims_json = ?, created_at = ?
      WHERE idempotency_key = ?
    `).run(
      provider || 'fetch',
      url || null,
      status || (passed ? 'passed' : 'failed'),
      passed ? 1 : 0,
      Number.isFinite(Number(score)) ? Number(score) : null,
      jsonText(checklist || []),
      jsonText(errors || []),
      jsonText(claims || {}),
      now,
      key
    );
    return this.getByIdempotency(key);
  },
  get(id) {
    return hydrateQa(db.prepare(`SELECT * FROM build_qa_results WHERE id = ?`).get(id));
  },
  getByIdempotency(idempotency_key) {
    return hydrateQa(db.prepare(`SELECT * FROM build_qa_results WHERE idempotency_key = ?`).get(idempotency_key));
  },
  listByBuild(build_id, { limit = 50 } = {}) {
    return db.prepare(`
      SELECT * FROM build_qa_results
      WHERE build_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(build_id, limitFor(limit)).map(hydrateQa);
  },
  listByLead(lead_id, { limit = 80 } = {}) {
    return db.prepare(`
      SELECT * FROM build_qa_results
      WHERE lead_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit)).map(hydrateQa);
  }
};

export const buildRevisions = {
  start({ build_id, lead_id, attempt = 1, qa_result_id, prompt, idempotency_key }) {
    const now = Date.now();
    const revisionId = revisionIdFor({ build_id, attempt });
    db.prepare(`
      INSERT OR IGNORE INTO build_revisions (
        id, build_id, lead_id, attempt, qa_result_id, status, prompt, created_at, idempotency_key
      )
      VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?)
    `).run(
      revisionId,
      build_id,
      lead_id,
      attempt,
      qa_result_id || null,
      prompt,
      now,
      idempotency_key || `build:${build_id}:revision:${attempt}`
    );
    return this.getByIdempotency(idempotency_key || `build:${build_id}:revision:${attempt}`);
  },
  finish(id, { status, result }) {
    db.prepare(`
      UPDATE build_revisions
      SET status = ?, result_json = ?, finished_at = ?
      WHERE id = ?
    `).run(status, jsonText(result), Date.now(), id);
    return this.get(id);
  },
  get(id) {
    return hydrateRevision(db.prepare(`SELECT * FROM build_revisions WHERE id = ?`).get(id));
  },
  getByIdempotency(idempotency_key) {
    return hydrateRevision(db.prepare(`SELECT * FROM build_revisions WHERE idempotency_key = ?`).get(idempotency_key));
  },
  listByBuild(build_id, { limit = 50 } = {}) {
    return db.prepare(`
      SELECT * FROM build_revisions
      WHERE build_id = ?
      ORDER BY attempt ASC, created_at ASC
      LIMIT ?
    `).all(build_id, limitFor(limit)).map(hydrateRevision);
  },
  listByLead(lead_id, { limit = 80 } = {}) {
    return db.prepare(`
      SELECT * FROM build_revisions
      WHERE lead_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit)).map(hydrateRevision);
  }
};

export const doNotCall = {
  add({ phone, reason = 'opt-out', source = 'system' }) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO do_not_call (phone, reason, source, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, source = excluded.source
    `).run(phone, reason, source, now);
    insertAuditEvent({
      created_at: now,
      event_type: 'compliance.do_not_call.recorded',
      entity_type: 'do_not_call',
      entity_id: phone,
      action: 'recorded',
      decision_code: 'do_not_call',
      decision_reason: reason,
      metadata: { phone, source }
    });
    insertComplianceDecision({
      created_at: now,
      direction: 'inbound',
      channel: 'phone',
      subject_type: 'do_not_call',
      subject_id: phone,
      allowed: false,
      decision_code: 'do_not_call',
      decision_reason: reason,
      metadata: { phone, source }
    });
  },
  has(phone) {
    return !!db.prepare(`SELECT phone FROM do_not_call WHERE phone = ?`).get(phone);
  },
  count() {
    return db.prepare(`SELECT COUNT(*) AS n FROM do_not_call`).get().n;
  }
};

export const callAttempts = {
  add({ id, lead_id, phone, allowed, reason, disclosure_text, source_url, decision_code, metadata }) {
    const attemptId = id || `attempt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    db.prepare(`
      INSERT INTO call_attempts (id, lead_id, phone, allowed, reason, disclosure_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(attemptId, lead_id || null, phone, allowed ? 1 : 0, reason, disclosure_text || null, now);
    const code = decision_code || (allowed ? 'call.allowed' : 'call.blocked');
    const decisionMetadata = { phone, disclosure_text: disclosure_text || null, ...metadata };
    insertComplianceDecision({
      created_at: now,
      lead_id,
      direction: 'outbound',
      channel: 'phone',
      subject_type: 'call_attempt',
      subject_id: attemptId,
      allowed,
      decision_code: code,
      decision_reason: reason,
      source_url,
      metadata: decisionMetadata,
      dedupe_key: `call_attempt:${attemptId}`
    });
    insertAuditEvent({
      created_at: now,
      event_type: 'call.decision',
      lead_id,
      entity_type: 'call_attempt',
      entity_id: attemptId,
      action: allowed ? 'allowed' : 'blocked',
      source_url,
      decision_code: code,
      decision_reason: reason,
      metadata: decisionMetadata,
      dedupe_key: `call_attempt_audit:${attemptId}`
    });
    return attemptId;
  },
  countSince({ phone, since }) {
    return db.prepare(`SELECT COUNT(*) AS n FROM call_attempts WHERE phone = ? AND created_at >= ?`).get(phone, since).n;
  },
  todayCount() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return db.prepare(`SELECT COUNT(*) AS n FROM call_attempts WHERE allowed = 1 AND created_at >= ?`).get(start.getTime()).n;
  }
};

export const contactEvents = {
  add({ id, lead_id, type, direction, channel, provider_id, thread_id, subject, body, metadata }) {
    const eventId = id || `contact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    db.prepare(`
      INSERT INTO contact_events (id, lead_id, type, direction, channel, provider_id, thread_id, subject, body, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      lead_id || null,
      type,
      direction,
      channel,
      provider_id || null,
      thread_id || null,
      subject || null,
      body || null,
      metadata ? JSON.stringify(metadata) : null,
      createdAt
    );
    const eventType = `contact.${channel}.${type}`;
    insertAuditEvent({
      created_at: createdAt,
      event_type: eventType,
      lead_id,
      contact_event_id: eventId,
      entity_type: 'contact_event',
      entity_id: eventId,
      action: direction,
      worker: channel,
      source_url: metadata?.sourceUrl || metadata?.source_url || null,
      decision_code: metadata?.decisionCode || metadata?.decision_code || null,
      decision_reason: metadata?.decisionReason || metadata?.decision_reason || metadata?.reason || null,
      metadata: { provider_id: provider_id || null, thread_id: thread_id || null, subject: subject || null, ...metadata },
      dedupe_key: `contact_event:${eventId}`
    });
    if (direction === 'outbound') {
      const code = metadata?.decisionCode || metadata?.decision_code || `${channel}.outbound.${type}`;
      const reason = outboundDecisionReason({ channel, type, metadata });
      insertComplianceDecision({
        created_at: createdAt,
        lead_id,
        contact_event_id: eventId,
        direction,
        channel,
        subject_type: 'contact_event',
        subject_id: eventId,
        allowed: metadata?.allowed ?? true,
        decision_code: code,
        decision_reason: reason,
        source_url: metadata?.sourceUrl || metadata?.source_url || null,
        metadata: { provider_id: provider_id || null, thread_id: thread_id || null, subject: subject || null, ...metadata },
        dedupe_key: `contact_event_decision:${eventId}`
      });
    }
    return eventId;
  },
  listByLead(lead_id, { limit = 50 } = {}) {
    return db.prepare(`SELECT * FROM contact_events WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`).all(lead_id, limit);
  },
  findLeadByThread(thread_id) {
    return db.prepare(`
      SELECT l.* FROM leads l
      LEFT JOIN contact_events e ON e.lead_id = l.id
      WHERE l.agentmail_thread_id = ? OR e.thread_id = ?
      ORDER BY e.created_at DESC
      LIMIT 1
    `).get(thread_id, thread_id);
  },
  repliesWaiting() {
    return db.prepare(`
      SELECT COUNT(*) AS n FROM contact_events
      WHERE channel = 'agentmail' AND direction = 'inbound' AND type = 'customer_reply'
    `).get().n;
  }
};

export const complianceDecisions = {
  add(row) {
    return insertComplianceDecision(row);
  },
  listByLead(lead_id, { limit = 100 } = {}) {
    return db.prepare(`
      SELECT * FROM compliance_decisions
      WHERE lead_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit));
  },
  listByContact({ contact_event_id, thread_id, provider_id, lead_id, limit = 100 } = {}) {
    const ids = contactEventIds({ contact_event_id, thread_id, provider_id, lead_id });
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return db.prepare(`
      SELECT * FROM compliance_decisions
      WHERE contact_event_id IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...ids, limitFor(limit));
  }
};

export const auditTrail = {
  add(row) {
    insertAuditEvent(row);
  },
  listByLead(lead_id, { limit = 100 } = {}) {
    return db.prepare(`
      SELECT * FROM audit_events
      WHERE lead_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit));
  },
  listByContact({ contact_event_id, thread_id, provider_id, lead_id, limit = 100 } = {}) {
    const ids = contactEventIds({ contact_event_id, thread_id, provider_id, lead_id });
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return db.prepare(`
      SELECT * FROM audit_events
      WHERE contact_event_id IN (${placeholders})
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...ids, limitFor(limit));
  },
  timelineByLead(lead_id, { limit = 100 } = {}) {
    const n = limitFor(limit);
    const auditRows = this.listByLead(lead_id, { limit: n });
    const decisionRows = complianceDecisions.listByLead(lead_id, { limit: n });
    return sortTimeline([
      ...timelineRows(auditRows, 'audit_event'),
      ...timelineRows(decisionRows, 'compliance_decision')
    ], n);
  },
  timelineByContact({ contact_event_id, thread_id, provider_id, lead_id, limit = 100 } = {}) {
    const n = limitFor(limit);
    const auditRows = this.listByContact({ contact_event_id, thread_id, provider_id, lead_id, limit: n });
    const decisionRows = complianceDecisions.listByContact({ contact_event_id, thread_id, provider_id, lead_id, limit: n });
    return sortTimeline([
      ...timelineRows(auditRows, 'audit_event'),
      ...timelineRows(decisionRows, 'compliance_decision')
    ], n);
  }
};

export const reasoningTraces = {
  add(row) {
    const id = row.id || `trace_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
    const createdAt = row.createdAt || Date.now();
    const record = {
      id,
      created_at: createdAt,
      lead_id: row.leadId || row.lead_id || null,
      worker: row.worker || null,
      event_id: row.eventId || row.event_id || null,
      provider: row.provider || 'gemini',
      schema_name: row.schemaName || row.schema_name,
      kind: row.kind || row.schemaName || row.schema_name,
      model: row.model || null,
      source: row.source || null,
      prompt_json: jsonText(row.prompt || null),
      evidence_json: jsonText(row.evidence || null),
      raw_output: row.rawOutput || row.raw_output || null,
      repaired_output: row.repairedOutput || row.repaired_output || null,
      final_output_json: jsonText(row.finalOutput || row.final_output || null),
      validation_errors_json: jsonText(row.validationErrors || row.validation_errors || []),
      latency_ms: Number.isFinite(row.latencyMs) ? row.latencyMs : row.latency_ms || null,
      valid: row.valid ? 1 : 0,
      repair_attempts: row.repairAttempts || row.repair_attempts || 0,
      dedupe_key: row.traceKey || row.dedupe_key || null
    };
    const info = db.prepare(`
      INSERT OR IGNORE INTO reasoning_traces (
        id, created_at, lead_id, worker, event_id, provider, schema_name, kind, model, source,
        prompt_json, evidence_json, raw_output, repaired_output, final_output_json,
        validation_errors_json, latency_ms, valid, repair_attempts, dedupe_key
      )
      VALUES (
        @id, @created_at, @lead_id, @worker, @event_id, @provider, @schema_name, @kind, @model, @source,
        @prompt_json, @evidence_json, @raw_output, @repaired_output, @final_output_json,
        @validation_errors_json, @latency_ms, @valid, @repair_attempts, @dedupe_key
      )
    `).run(record);
    const trace = record.dedupe_key ? this.getByDedupe(record.dedupe_key) : this.get(id);
    if (info.changes > 0) {
      insertAuditEvent({
        created_at: createdAt,
        event_type: 'reasoning.trace',
        lead_id: record.lead_id,
        entity_type: 'reasoning_trace',
        entity_id: id,
        action: record.valid ? 'valid' : 'invalid',
        worker: record.worker,
        decision_code: record.schema_name,
        decision_reason: record.valid ? 'structured reasoning validated' : 'structured reasoning failed validation',
        metadata: {
          provider: record.provider,
          schemaName: record.schema_name,
          kind: record.kind,
          model: record.model,
          source: record.source,
          valid: !!record.valid,
          repairAttempts: record.repair_attempts,
          validationErrors: safeJson(record.validation_errors_json) || []
        },
        dedupe_key: `reasoning_trace:${id}`
      });
    }
    return trace;
  },
  get(id) {
    const row = db.prepare(`SELECT * FROM reasoning_traces WHERE id = ?`).get(id);
    return row ? parseReasoningTrace(row) : null;
  },
  getByDedupe(dedupe_key) {
    if (!dedupe_key) return null;
    const row = db.prepare(`SELECT * FROM reasoning_traces WHERE dedupe_key = ?`).get(dedupe_key);
    return row ? parseReasoningTrace(row) : null;
  },
  list({ lead_id, worker, schema_name, limit = 100 } = {}) {
    const clauses = [];
    const args = [];
    if (lead_id) {
      clauses.push('lead_id = ?');
      args.push(lead_id);
    }
    if (worker) {
      clauses.push('worker = ?');
      args.push(worker);
    }
    if (schema_name) {
      clauses.push('schema_name = ?');
      args.push(schema_name);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`
      SELECT * FROM reasoning_traces
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...args, limitFor(limit)).map(parseReasoningTrace);
  },
  listByLead(lead_id, { limit = 100 } = {}) {
    return this.list({ lead_id, limit });
  },
  summary() {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN valid = 1 THEN 1 ELSE 0 END) AS valid,
        SUM(CASE WHEN valid = 0 THEN 1 ELSE 0 END) AS invalid,
        SUM(CASE WHEN repair_attempts > 0 THEN 1 ELSE 0 END) AS repaired,
        MAX(created_at) AS latestAt
      FROM reasoning_traces
    `).get();
    const recent = db.prepare(`
      SELECT schema_name, kind, worker, provider, model, valid, repair_attempts, latency_ms, created_at
      FROM reasoning_traces
      ORDER BY created_at DESC
      LIMIT 8
    `).all();
    return {
      total: totals.total || 0,
      valid: totals.valid || 0,
      invalid: totals.invalid || 0,
      repaired: totals.repaired || 0,
      latestAt: totals.latestAt || null,
      recent: recent.map((row) => ({
        schemaName: row.schema_name,
        kind: row.kind,
        worker: row.worker,
        provider: row.provider,
        model: row.model,
        valid: !!row.valid,
        repairAttempts: row.repair_attempts,
        latencyMs: row.latency_ms,
        createdAt: row.created_at
      }))
    };
  }
};

export const mossHotIndexes = {
  upsert({ lead_id, index_name, status = 'ready', mode = 'mock', doc_count = 0, active_doc_count = null, dead_doc_count = null, last_error = null, metadata = null }) {
    const now = Date.now();
    const activeCount = active_doc_count ?? doc_count;
    const deadCount = dead_doc_count ?? 0;
    db.prepare(`
      INSERT INTO moss_hot_indexes (
        lead_id, index_name, status, mode, doc_count, active_doc_count, dead_doc_count,
        last_error, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lead_id) DO UPDATE SET
        index_name = excluded.index_name,
        status = excluded.status,
        mode = excluded.mode,
        doc_count = excluded.doc_count,
        active_doc_count = excluded.active_doc_count,
        dead_doc_count = excluded.dead_doc_count,
        last_error = excluded.last_error,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      lead_id,
      index_name,
      status,
      mode,
      doc_count,
      activeCount,
      deadCount,
      last_error,
      jsonText(metadata),
      now,
      now
    );
    insertAuditEvent({
      created_at: now,
      event_type: 'moss.index.upserted',
      lead_id,
      entity_type: 'moss_hot_index',
      entity_id: index_name,
      action: status,
      worker: 'moss',
      metadata: { index_name, mode, doc_count, active_doc_count: activeCount, dead_doc_count: deadCount, last_error, ...metadata }
    });
    return this.getByLead(lead_id);
  },
  markQueried(lead_id, { latency_ms, error = null } = {}) {
    db.prepare(`
      UPDATE moss_hot_indexes
      SET last_query_at = ?, last_latency_ms = ?, last_error = ?, updated_at = ?
      WHERE lead_id = ?
    `).run(Date.now(), latency_ms ?? null, error, Date.now(), lead_id);
  },
  getByLead(lead_id) {
    const row = db.prepare(`SELECT * FROM moss_hot_indexes WHERE lead_id = ?`).get(lead_id);
    return row ? hydrateMossIndex(row) : null;
  },
  all({ limit = 50 } = {}) {
    return db.prepare(`
      SELECT * FROM moss_hot_indexes
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limitFor(limit)).map(hydrateMossIndex);
  }
};

export const mossSnippets = {
  upsertMany({ lead_id, index_name, snippets }) {
    const now = Date.now();
    const rows = (snippets || []).map((snippet) => ({
      id: `moss_${lead_id}_${snippet.snippet_id}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160),
      lead_id,
      index_name,
      snippet_id: snippet.snippet_id,
      kind: snippet.kind || snippet.metadata?.kind || 'snippet',
      title: snippet.title || snippet.metadata?.title || snippet.snippet_id,
      text: snippet.text,
      status: snippet.status || 'active',
      metadata_json: jsonText(snippet.metadata),
      created_at: now,
      updated_at: now
    })).filter((row) => row.snippet_id && row.text);
    const stmt = db.prepare(`
      INSERT INTO moss_snippets (
        id, lead_id, index_name, snippet_id, kind, title, text, status, metadata_json, created_at, updated_at
      )
      VALUES (
        @id, @lead_id, @index_name, @snippet_id, @kind, @title, @text, @status, @metadata_json, @created_at, @updated_at
      )
      ON CONFLICT(lead_id, snippet_id) DO UPDATE SET
        index_name = excluded.index_name,
        kind = excluded.kind,
        title = excluded.title,
        text = excluded.text,
        status = CASE WHEN moss_snippets.status = 'dead' THEN 'dead' ELSE excluded.status END,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);
    db.transaction(() => {
      for (const row of rows) stmt.run(row);
    })();
    return this.listByLead(lead_id, { limit: Math.max(rows.length, 50) });
  },
  addImproved({ lead_id, index_name, snippet_id, kind, title, text, metadata = {} }) {
    const now = Date.now();
    const id = `moss_${lead_id}_${snippet_id}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
    db.prepare(`
      INSERT INTO moss_snippets (
        id, lead_id, index_name, snippet_id, kind, title, text, status, help_score,
        use_count, failure_count, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, 0, ?, ?, ?)
      ON CONFLICT(lead_id, snippet_id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        text = excluded.text,
        status = 'active',
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(id, lead_id, index_name, snippet_id, kind, title || snippet_id, text, jsonText(metadata), now, now);
    insertAuditEvent({
      created_at: now,
      event_type: 'moss.snippet.improved',
      lead_id,
      entity_type: 'moss_snippet',
      entity_id: snippet_id,
      action: 'improved',
      worker: 'analyst',
      metadata: { index_name, kind, title, text: String(text || '').slice(0, 500), ...metadata },
      dedupe_key: `moss_snippet:${lead_id}:${snippet_id}:improved:${now}`
    });
    return this.getBySnippetId(lead_id, snippet_id);
  },
  markUsed(lead_id, snippetIds, { helped = null, failed = false } = {}) {
    const ids = [...new Set((snippetIds || []).filter(Boolean))];
    if (!ids.length) return [];
    const now = Date.now();
    const stmt = db.prepare(`
      UPDATE moss_snippets
      SET
        use_count = use_count + 1,
        failure_count = failure_count + @failure_delta,
        help_score = help_score + @help_delta,
        last_used_at = @now,
        updated_at = @now
      WHERE lead_id = @lead_id AND snippet_id = @snippet_id
    `);
    db.transaction(() => {
      for (const snippet_id of ids) {
        stmt.run({
          lead_id,
          snippet_id,
          now,
          failure_delta: failed ? 1 : 0,
          help_delta: helped === true ? 1 : helped === false ? -0.5 : 0
        });
      }
    })();
    return ids.map((snippetId) => this.getBySnippetId(lead_id, snippetId)).filter(Boolean);
  },
  markDead(lead_id, snippet_id, { reason = 'analyst_dead_snippet' } = {}) {
    const now = Date.now();
    db.prepare(`
      UPDATE moss_snippets
      SET status = 'dead', failure_count = failure_count + 1, updated_at = ?
      WHERE lead_id = ? AND snippet_id = ?
    `).run(now, lead_id, snippet_id);
    insertAuditEvent({
      created_at: now,
      event_type: 'moss.snippet.dead',
      lead_id,
      entity_type: 'moss_snippet',
      entity_id: snippet_id,
      action: 'dead',
      worker: 'analyst',
      decision_code: 'moss.dead_snippet',
      decision_reason: reason,
      metadata: { reason }
    });
    return this.getBySnippetId(lead_id, snippet_id);
  },
  getBySnippetId(lead_id, snippet_id) {
    const row = db.prepare(`SELECT * FROM moss_snippets WHERE lead_id = ? AND snippet_id = ?`).get(lead_id, snippet_id);
    return row ? hydrateMossSnippet(row) : null;
  },
  listByLead(lead_id, { status, limit = 200 } = {}) {
    if (status) {
      return db.prepare(`
        SELECT * FROM moss_snippets
        WHERE lead_id = ? AND status = ?
        ORDER BY kind ASC, updated_at DESC
        LIMIT ?
      `).all(lead_id, status, limitFor(limit, 200, 1000)).map(hydrateMossSnippet);
    }
    return db.prepare(`
      SELECT * FROM moss_snippets
      WHERE lead_id = ?
      ORDER BY status ASC, kind ASC, updated_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 200, 1000)).map(hydrateMossSnippet);
  }
};

export const mossRetrievals = {
  record({ id, dedupe_key, lead_id, call_id = null, index_name = null, intent, query, top_k, alpha, latency_ms, snippet_ids = [], mode = 'mock', source = null, outcome = null, metadata = null }) {
    const now = Date.now();
    const retrievalId = id || `mret_${now.toString(36)}_${randomBytes(3).toString('hex')}`;
    db.prepare(`
      INSERT OR IGNORE INTO moss_retrievals (
        id, dedupe_key, lead_id, call_id, index_name, intent, query, top_k, alpha,
        latency_ms, result_count, snippet_ids_json, mode, source, outcome, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      retrievalId,
      dedupe_key,
      lead_id || null,
      call_id || null,
      index_name || null,
      intent,
      query,
      top_k,
      alpha,
      latency_ms,
      snippet_ids.length,
      jsonText(snippet_ids),
      mode,
      source,
      outcome,
      jsonText(metadata),
      now
    );
    if (lead_id) mossHotIndexes.markQueried(lead_id, { latency_ms });
    return this.getByDedupeKey(dedupe_key);
  },
  markOutcome(id, { outcome, helped = null, metadata = null } = {}) {
    db.prepare(`
      UPDATE moss_retrievals
      SET outcome = ?, metadata_json = COALESCE(?, metadata_json)
      WHERE id = ?
    `).run(outcome || null, metadata ? jsonText({ helped, ...metadata }) : null, id);
    return this.get(id);
  },
  get(id) {
    const row = db.prepare(`SELECT * FROM moss_retrievals WHERE id = ?`).get(id);
    return row ? hydrateMossRetrieval(row) : null;
  },
  getByDedupeKey(dedupe_key) {
    const row = db.prepare(`SELECT * FROM moss_retrievals WHERE dedupe_key = ?`).get(dedupe_key);
    return row ? hydrateMossRetrieval(row) : null;
  },
  listByLead(lead_id, { call_id, limit = 100 } = {}) {
    if (call_id) {
      return db.prepare(`
        SELECT * FROM moss_retrievals
        WHERE lead_id = ? AND call_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `).all(lead_id, call_id, limitFor(limit, 100, 500)).map(hydrateMossRetrieval);
    }
    return db.prepare(`
      SELECT * FROM moss_retrievals
      WHERE lead_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 100, 500)).map(hydrateMossRetrieval);
  }
};

function queueIdForCustomId(customId) {
  return `memq_${String(customId || 'memory').replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 80)}`;
}

function failureId() {
  return `memfail_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export const memoryDocuments = {
  upsert(row) {
    const now = row.updated_at || Date.now();
    const record = {
      source_event: null,
      provider_document_id: null,
      provider_status: 'local',
      write_status: 'queued',
      metadata: null,
      filter_by_metadata: null,
      entity_context: null,
      last_error: null,
      attempt_count: 0,
      first_seen_at: now,
      last_provider_checked_at: null,
      ...row,
      updated_at: now
    };
    db.prepare(`
      INSERT INTO memory_documents (
        custom_id, lead_id, container_tag, kind, source_id, source_event,
        provider_document_id, provider_status, write_status, content_text,
        metadata_json, filter_by_metadata_json, entity_context, last_error,
        attempt_count, first_seen_at, updated_at, last_provider_checked_at
      )
      VALUES (
        @custom_id, @lead_id, @container_tag, @kind, @source_id, @source_event,
        @provider_document_id, @provider_status, @write_status, @content_text,
        @metadata_json, @filter_by_metadata_json, @entity_context, @last_error,
        @attempt_count, @first_seen_at, @updated_at, @last_provider_checked_at
      )
      ON CONFLICT(custom_id) DO UPDATE SET
        lead_id = excluded.lead_id,
        container_tag = excluded.container_tag,
        kind = excluded.kind,
        source_id = excluded.source_id,
        source_event = excluded.source_event,
        provider_document_id = COALESCE(excluded.provider_document_id, memory_documents.provider_document_id),
        provider_status = excluded.provider_status,
        write_status = excluded.write_status,
        content_text = excluded.content_text,
        metadata_json = excluded.metadata_json,
        filter_by_metadata_json = excluded.filter_by_metadata_json,
        entity_context = excluded.entity_context,
        last_error = excluded.last_error,
        attempt_count = excluded.attempt_count,
        updated_at = excluded.updated_at,
        last_provider_checked_at = COALESCE(excluded.last_provider_checked_at, memory_documents.last_provider_checked_at)
    `).run({
      ...record,
      metadata_json: jsonText(record.metadata),
      filter_by_metadata_json: jsonText(record.filter_by_metadata)
    });
    return this.get(record.custom_id);
  },
  markProviderStatus(custom_id, patch) {
    const existing = this.get(custom_id);
    if (!existing) return null;
    const next = {
      provider_document_id: patch.provider_document_id ?? existing.provider_document_id,
      provider_status: patch.provider_status ?? existing.provider_status,
      write_status: patch.write_status ?? existing.write_status,
      last_error: patch.last_error ?? null,
      attempt_count: patch.attempt_count ?? existing.attempt_count,
      last_provider_checked_at: patch.last_provider_checked_at ?? Date.now(),
      updated_at: patch.updated_at ?? Date.now(),
      custom_id
    };
    db.prepare(`
      UPDATE memory_documents
      SET provider_document_id = @provider_document_id,
          provider_status = @provider_status,
          write_status = @write_status,
          last_error = @last_error,
          attempt_count = @attempt_count,
          last_provider_checked_at = @last_provider_checked_at,
          updated_at = @updated_at
      WHERE custom_id = @custom_id
    `).run(next);
    return this.get(custom_id);
  },
  get(custom_id) {
    return parseMemoryDocument(db.prepare(`SELECT * FROM memory_documents WHERE custom_id = ?`).get(custom_id));
  },
  listByLead(lead_id, { limit = 200 } = {}) {
    return db.prepare(`
      SELECT * FROM memory_documents
      WHERE lead_id = ?
      ORDER BY updated_at DESC, custom_id DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 200, 1000)).map(parseMemoryDocument);
  },
  listByContainer(container_tag, { limit = 200 } = {}) {
    return db.prepare(`
      SELECT * FROM memory_documents
      WHERE container_tag = ?
      ORDER BY updated_at DESC, custom_id DESC
      LIMIT ?
    `).all(container_tag, limitFor(limit, 200, 1000)).map(parseMemoryDocument);
  },
  listRecent({ limit = 200 } = {}) {
    return db.prepare(`
      SELECT * FROM memory_documents
      ORDER BY updated_at DESC, custom_id DESC
      LIMIT ?
    `).all(limitFor(limit, 200, 1000)).map(parseMemoryDocument);
  },
  countByLead() {
    return db.prepare(`
      SELECT lead_id,
        COUNT(*) AS document_count,
        SUM(CASE WHEN write_status IN ('succeeded', 'mocked') THEN 1 ELSE 0 END) AS written_count,
        SUM(CASE WHEN write_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
        SUM(CASE WHEN write_status IN ('queued', 'retrying') THEN 1 ELSE 0 END) AS queued_count,
        MAX(updated_at) AS last_memory_at
      FROM memory_documents
      GROUP BY lead_id
    `).all();
  },
  counts() {
    return db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN write_status IN ('succeeded', 'mocked') THEN 1 ELSE 0 END) AS written,
        SUM(CASE WHEN write_status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN write_status IN ('queued', 'retrying') THEN 1 ELSE 0 END) AS queued
      FROM memory_documents
    `).get();
  }
};

export const memoryWriteQueue = {
  upsert(row) {
    const now = row.updated_at || Date.now();
    const record = {
      id: row.id || queueIdForCustomId(row.custom_id),
      source_event: null,
      metadata: null,
      filter_by_metadata: null,
      entity_context: null,
      status: 'queued',
      attempt_count: 0,
      next_attempt_at: now,
      provider_document_id: null,
      last_error: null,
      created_at: now,
      ...row,
      updated_at: now
    };
    db.prepare(`
      INSERT INTO memory_write_queue (
        id, custom_id, lead_id, container_tag, kind, source_id, source_event,
        content_text, metadata_json, filter_by_metadata_json, entity_context,
        status, attempt_count, next_attempt_at, provider_document_id, last_error,
        created_at, updated_at
      )
      VALUES (
        @id, @custom_id, @lead_id, @container_tag, @kind, @source_id, @source_event,
        @content_text, @metadata_json, @filter_by_metadata_json, @entity_context,
        @status, @attempt_count, @next_attempt_at, @provider_document_id, @last_error,
        @created_at, @updated_at
      )
      ON CONFLICT(custom_id) DO UPDATE SET
        lead_id = excluded.lead_id,
        container_tag = excluded.container_tag,
        kind = excluded.kind,
        source_id = excluded.source_id,
        source_event = excluded.source_event,
        content_text = excluded.content_text,
        metadata_json = excluded.metadata_json,
        filter_by_metadata_json = excluded.filter_by_metadata_json,
        entity_context = excluded.entity_context,
        status = excluded.status,
        next_attempt_at = excluded.next_attempt_at,
        provider_document_id = COALESCE(excluded.provider_document_id, memory_write_queue.provider_document_id),
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run({
      ...record,
      metadata_json: jsonText(record.metadata),
      filter_by_metadata_json: jsonText(record.filter_by_metadata)
    });
    return this.getByCustomId(record.custom_id);
  },
  mark(custom_id, patch) {
    const existing = this.getByCustomId(custom_id);
    if (!existing) return null;
    const next = {
      status: patch.status ?? existing.status,
      attempt_count: patch.attempt_count ?? existing.attempt_count,
      next_attempt_at: patch.next_attempt_at ?? existing.next_attempt_at,
      provider_document_id: patch.provider_document_id ?? existing.provider_document_id,
      last_error: patch.last_error ?? null,
      updated_at: patch.updated_at ?? Date.now(),
      custom_id
    };
    db.prepare(`
      UPDATE memory_write_queue
      SET status = @status,
          attempt_count = @attempt_count,
          next_attempt_at = @next_attempt_at,
          provider_document_id = @provider_document_id,
          last_error = @last_error,
          updated_at = @updated_at
      WHERE custom_id = @custom_id
    `).run(next);
    return this.getByCustomId(custom_id);
  },
  getByCustomId(custom_id) {
    return parseMemoryQueue(db.prepare(`SELECT * FROM memory_write_queue WHERE custom_id = ?`).get(custom_id));
  },
  list({ lead_id, statuses, limit = 100 } = {}) {
    const n = limitFor(limit, 100, 1000);
    if (lead_id) {
      return db.prepare(`
        SELECT * FROM memory_write_queue
        WHERE lead_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(lead_id, n).map(parseMemoryQueue);
    }
    if (statuses?.length) {
      const placeholders = statuses.map(() => '?').join(', ');
      return db.prepare(`
        SELECT * FROM memory_write_queue
        WHERE status IN (${placeholders})
        ORDER BY next_attempt_at ASC, updated_at ASC
        LIMIT ?
      `).all(...statuses, n).map(parseMemoryQueue);
    }
    return db.prepare(`
      SELECT * FROM memory_write_queue
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(n).map(parseMemoryQueue);
  },
  due({ limit = 25, now = Date.now() } = {}) {
    return db.prepare(`
      SELECT * FROM memory_write_queue
      WHERE status IN ('queued', 'failed', 'retrying') AND next_attempt_at <= ?
      ORDER BY next_attempt_at ASC, updated_at ASC
      LIMIT ?
    `).all(now, limitFor(limit, 25, 200)).map(parseMemoryQueue);
  },
  counts() {
    return db.prepare(`
      SELECT status, COUNT(*) AS n
      FROM memory_write_queue
      GROUP BY status
    `).all();
  }
};

export const memorySearches = {
  add(row) {
    const record = {
      id: row.id || `memsearch_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
      kind: null,
      filters: null,
      result_count: 0,
      results: null,
      status: 'succeeded',
      error: null,
      bleed_detected: false,
      duration_ms: 0,
      created_at: Date.now(),
      ...row
    };
    db.prepare(`
      INSERT INTO memory_searches (
        id, lead_id, container_tag, query, kind, filters_json, result_count,
        results_json, status, error, bleed_detected, duration_ms, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.lead_id,
      record.container_tag,
      record.query,
      record.kind || null,
      jsonText(record.filters),
      record.result_count,
      jsonText(record.results),
      record.status,
      record.error || null,
      record.bleed_detected ? 1 : 0,
      record.duration_ms,
      record.created_at
    );
    return this.get(record.id);
  },
  get(id) {
    return parseMemorySearch(db.prepare(`SELECT * FROM memory_searches WHERE id = ?`).get(id));
  },
  listByLead(lead_id, { limit = 50 } = {}) {
    return db.prepare(`
      SELECT * FROM memory_searches
      WHERE lead_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 50, 500)).map(parseMemorySearch);
  },
  recent({ limit = 100 } = {}) {
    return db.prepare(`
      SELECT * FROM memory_searches
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limitFor(limit, 100, 1000)).map(parseMemorySearch);
  },
  countByLead() {
    return db.prepare(`
      SELECT lead_id, COUNT(*) AS search_count, MAX(created_at) AS last_search_at
      FROM memory_searches
      GROUP BY lead_id
    `).all();
  },
  counts() {
    return db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN bleed_detected = 1 THEN 1 ELSE 0 END) AS bleed_detected
      FROM memory_searches
    `).get();
  }
};

export const memoryFailures = {
  add(row) {
    const now = row.created_at || Date.now();
    const record = {
      id: row.id || failureId(),
      lead_id: null,
      container_tag: null,
      custom_id: null,
      kind: null,
      action: 'write',
      category: 'unknown',
      retryable: true,
      error: 'memory failure',
      payload: null,
      source_event: null,
      resolved_at: null,
      attempt_count: 0,
      ...row,
      created_at: now,
      updated_at: row.updated_at || now
    };
    db.prepare(`
      INSERT INTO memory_failures (
        id, lead_id, container_tag, custom_id, kind, action, category, retryable,
        error, payload_json, source_event, resolved_at, created_at, updated_at, attempt_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.lead_id,
      record.container_tag,
      record.custom_id,
      record.kind,
      record.action,
      record.category,
      record.retryable ? 1 : 0,
      record.error,
      jsonText(record.payload),
      record.source_event,
      record.resolved_at,
      record.created_at,
      record.updated_at,
      record.attempt_count
    );
    return this.get(record.id);
  },
  get(id) {
    return parseMemoryFailure(db.prepare(`SELECT * FROM memory_failures WHERE id = ?`).get(id));
  },
  resolveByCustomId(custom_id, action = 'write') {
    const now = Date.now();
    db.prepare(`
      UPDATE memory_failures
      SET resolved_at = ?, updated_at = ?
      WHERE custom_id = ? AND action = ? AND resolved_at IS NULL
    `).run(now, now, custom_id, action);
  },
  list({ lead_id, unresolved = false, limit = 100 } = {}) {
    const n = limitFor(limit, 100, 1000);
    if (lead_id) {
      return db.prepare(`
        SELECT * FROM memory_failures
        WHERE lead_id = ? ${unresolved ? 'AND resolved_at IS NULL' : ''}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(lead_id, n).map(parseMemoryFailure);
    }
    return db.prepare(`
      SELECT * FROM memory_failures
      WHERE (? = 0 OR resolved_at IS NULL)
      ORDER BY created_at DESC
      LIMIT ?
    `).all(unresolved ? 1 : 0, n).map(parseMemoryFailure);
  },
  countByLead() {
    return db.prepare(`
      SELECT lead_id,
        COUNT(*) AS failure_count,
        SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS unresolved_failure_count,
        MAX(created_at) AS last_failure_at
      FROM memory_failures
      GROUP BY lead_id
    `).all();
  },
  counts() {
    return db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS unresolved,
        SUM(CASE WHEN resolved_at IS NULL AND retryable = 1 THEN 1 ELSE 0 END) AS retryable
      FROM memory_failures
    `).get();
  }
};

function parseMemoryDocument(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: safeJson(row.metadata_json) || {},
    filter_by_metadata: safeJson(row.filter_by_metadata_json) || {},
    attempt_count: Number(row.attempt_count || 0)
  };
}

function parseMemoryQueue(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: safeJson(row.metadata_json) || {},
    filter_by_metadata: safeJson(row.filter_by_metadata_json) || {},
    attempt_count: Number(row.attempt_count || 0)
  };
}

function parseMemorySearch(row) {
  if (!row) return null;
  return {
    ...row,
    filters: safeJson(row.filters_json) || {},
    results: safeJson(row.results_json) || [],
    bleed_detected: Boolean(row.bleed_detected)
  };
}

function parseMemoryFailure(row) {
  if (!row) return null;
  return {
    ...row,
    retryable: Boolean(row.retryable),
    payload: safeJson(row.payload_json) || null
  };
}

export const growthPlans = {
  upsert({
    id,
    lead_id,
    status = 'ready',
    plan,
    offers,
    next_service_id,
    evidence_count,
    unsupported_count,
    idempotency_key
  }) {
    const now = Date.now();
    const record = {
      id,
      lead_id,
      status,
      plan_json: jsonText(plan),
      offer_json: jsonText(offers),
      next_service_id: next_service_id || null,
      evidence_count: evidence_count ?? plan?.evidence?.length ?? 0,
      unsupported_count: unsupported_count ?? plan?.unsupportedFlags?.length ?? 0,
      idempotency_key: idempotency_key || null,
      generated_at: now,
      updated_at: now
    };
    const existing = record.idempotency_key ? this.getByIdempotency(record.idempotency_key) : null;
    if (existing) {
      db.prepare(`
        UPDATE growth_plans
        SET status = @status,
            plan_json = @plan_json,
            offer_json = @offer_json,
            next_service_id = @next_service_id,
            evidence_count = @evidence_count,
            unsupported_count = @unsupported_count,
            updated_at = @updated_at
        WHERE id = @existing_id
      `).run({ ...record, existing_id: existing.id });
      insertAuditEvent({
        created_at: now,
        event_type: 'growth.plan.updated',
        lead_id,
        entity_type: 'growth_plan',
        entity_id: existing.id,
        action: 'updated',
        worker: 'growth',
        metadata: {
          next_service_id: record.next_service_id,
          evidence_count: record.evidence_count,
          unsupported_count: record.unsupported_count
        }
      });
      return this.get(existing.id);
    }

    db.prepare(`
      INSERT INTO growth_plans (
        id, lead_id, status, plan_json, offer_json, next_service_id, evidence_count,
        unsupported_count, idempotency_key, generated_at, updated_at
      )
      VALUES (
        @id, @lead_id, @status, @plan_json, @offer_json, @next_service_id, @evidence_count,
        @unsupported_count, @idempotency_key, @generated_at, @updated_at
      )
    `).run(record);
    insertAuditEvent({
      created_at: now,
      event_type: 'growth.plan.created',
      lead_id,
      entity_type: 'growth_plan',
      entity_id: id,
      action: 'created',
      worker: 'growth',
      metadata: {
        next_service_id: record.next_service_id,
        evidence_count: record.evidence_count,
        unsupported_count: record.unsupported_count
      },
      dedupe_key: `growth_plan:${id}:created`
    });
    return this.get(id);
  },
  get(id) {
    return db.prepare(`SELECT * FROM growth_plans WHERE id = ?`).get(id);
  },
  getByIdempotency(idempotency_key) {
    return db.prepare(`SELECT * FROM growth_plans WHERE idempotency_key = ?`).get(idempotency_key);
  },
  getLatest(lead_id) {
    return db.prepare(`SELECT * FROM growth_plans WHERE lead_id = ? ORDER BY generated_at DESC, updated_at DESC LIMIT 1`).get(lead_id);
  },
  listByLead(lead_id, { limit = 20 } = {}) {
    return db.prepare(`SELECT * FROM growth_plans WHERE lead_id = ? ORDER BY generated_at DESC LIMIT ?`).all(lead_id, limitFor(limit, 20, 100));
  },
  markFollowedUp(id, ts = Date.now()) {
    db.prepare(`UPDATE growth_plans SET last_followup_at = ?, updated_at = ? WHERE id = ?`).run(ts, ts, id);
  },
  summary() {
    return {
      total: db.prepare(`SELECT COUNT(*) AS n FROM growth_plans`).get().n,
      ready: db.prepare(`SELECT COUNT(*) AS n FROM growth_plans WHERE status = 'ready'`).get().n,
      unsupported: db.prepare(`SELECT COUNT(*) AS n FROM growth_plans WHERE unsupported_count > 0`).get().n,
      followupReady: db.prepare(`SELECT COUNT(*) AS n FROM growth_plans WHERE last_followup_at IS NULL`).get().n
    };
  }
};

export const growthFollowups = {
  insertOrGetByIdempotency(row) {
    const existing = row.idempotency_key ? this.getByIdempotency(row.idempotency_key) : null;
    if (existing) return { inserted: false, row: existing };
    const now = Date.now();
    const record = {
      created_at: now,
      sent_at: row.status === 'sent' ? now : null,
      metadata_json: jsonText(row.metadata),
      ...row
    };
    db.prepare(`
      INSERT INTO growth_followups (
        id, lead_id, growth_plan_id, direction, channel, status, classification, provider_id,
        thread_id, subject, body, metadata_json, idempotency_key, created_at, sent_at
      )
      VALUES (
        @id, @lead_id, @growth_plan_id, @direction, @channel, @status, @classification, @provider_id,
        @thread_id, @subject, @body, @metadata_json, @idempotency_key, @created_at, @sent_at
      )
    `).run({
      ...record,
      growth_plan_id: record.growth_plan_id || null,
      classification: record.classification || null,
      provider_id: record.provider_id || null,
      thread_id: record.thread_id || null,
      subject: record.subject || null,
      body: record.body || null,
      idempotency_key: record.idempotency_key || null
    });
    if (record.growth_plan_id && record.status === 'sent') growthPlans.markFollowedUp(record.growth_plan_id, now);
    insertAuditEvent({
      created_at: now,
      event_type: `growth.followup.${record.status}`,
      lead_id: record.lead_id,
      entity_type: 'growth_followup',
      entity_id: record.id,
      action: record.status,
      worker: 'growth',
      metadata: {
        growth_plan_id: record.growth_plan_id || null,
        direction: record.direction,
        channel: record.channel,
        classification: record.classification || null
      },
      dedupe_key: `growth_followup:${record.id}:created`
    });
    return { inserted: true, row: this.get(record.id) };
  },
  get(id) {
    return db.prepare(`SELECT * FROM growth_followups WHERE id = ?`).get(id);
  },
  getByIdempotency(idempotency_key) {
    return db.prepare(`SELECT * FROM growth_followups WHERE idempotency_key = ?`).get(idempotency_key);
  },
  listByLead(lead_id, { limit = 50 } = {}) {
    return db.prepare(`SELECT * FROM growth_followups WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`).all(lead_id, limitFor(limit, 50, 200));
  },
  summary() {
    return {
      total: db.prepare(`SELECT COUNT(*) AS n FROM growth_followups`).get().n,
      sent: db.prepare(`SELECT COUNT(*) AS n FROM growth_followups WHERE status = 'sent'`).get().n,
      skipped: db.prepare(`SELECT COUNT(*) AS n FROM growth_followups WHERE status = 'skipped'`).get().n,
      interested: db.prepare(`SELECT COUNT(*) AS n FROM growth_followups WHERE classification = 'interested'`).get().n,
      handoff: db.prepare(`SELECT COUNT(*) AS n FROM growth_followups WHERE classification = 'handoff'`).get().n
    };
  }
};

export const providerSmoke = {
  set(provider, status, detail = {}) {
    db.prepare(`
      INSERT INTO provider_smoke (provider, status, detail_json, checked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET status = excluded.status, detail_json = excluded.detail_json, checked_at = excluded.checked_at
    `).run(provider, status, JSON.stringify(detail), Date.now());
  },
  all() {
    const rows = db.prepare(`SELECT * FROM provider_smoke ORDER BY provider`).all();
    return Object.fromEntries(rows.map((r) => [r.provider, { status: r.status, checkedAt: r.checked_at, detail: safeJson(r.detail_json) }]));
  }
};

export const webhookEvents = {
  seen(provider, event_id) {
    return !!db.prepare(`SELECT 1 FROM webhook_events WHERE provider = ? AND event_id = ?`).get(provider, event_id);
  },
  record({ provider, event_id, type, payload }) {
    const receivedAt = Date.now();
    const info = db.prepare(`
      INSERT OR IGNORE INTO webhook_events (provider, event_id, type, received_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(provider, event_id, type || null, receivedAt, payload ? JSON.stringify(payload) : null);
    if (info.changes > 0) {
      insertAuditEvent({
        created_at: receivedAt,
        event_type: 'webhook.received',
        lead_id: payload?.metadata?.leadId || payload?.metadata?.lead_id || payload?.leadId || payload?.lead_id || null,
        entity_type: 'webhook_event',
        entity_id: `${provider}:${event_id}`,
        action: 'received',
        worker: provider,
        metadata: { provider, event_id, type: type || null, payload },
        dedupe_key: `webhook:${provider}:${event_id}`
      });
    }
  },
  recordOnce({ provider, event_id, type, payload }) {
    const receivedAt = Date.now();
    const info = db.prepare(`
      INSERT OR IGNORE INTO webhook_events (provider, event_id, type, received_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(provider, event_id, type || null, receivedAt, payload ? JSON.stringify(payload) : null);
    if (info.changes > 0) {
      insertAuditEvent({
        created_at: receivedAt,
        event_type: 'webhook.received',
        lead_id: payload?.metadata?.leadId || payload?.metadata?.lead_id || payload?.leadId || payload?.lead_id || null,
        entity_type: 'webhook_event',
        entity_id: `${provider}:${event_id}`,
        action: 'received',
        worker: provider,
        metadata: { provider, event_id, type: type || null, payload },
        dedupe_key: `webhook:${provider}:${event_id}`
      });
    }
    return info.changes > 0;
  }
};

function hydrateMossIndex(row) {
  return {
    ...row,
    metadata: safeJson(row.metadata_json)
  };
}

function hydrateMossSnippet(row) {
  return {
    ...row,
    metadata: safeJson(row.metadata_json)
  };
}

function hydrateMossRetrieval(row) {
  return {
    ...row,
    snippetIds: safeJson(row.snippet_ids_json) || [],
    metadata: safeJson(row.metadata_json)
  };
}

function parseReasoningTrace(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    leadId: row.lead_id,
    worker: row.worker,
    eventId: row.event_id,
    provider: row.provider,
    schemaName: row.schema_name,
    kind: row.kind,
    model: row.model,
    source: row.source,
    prompt: safeJson(row.prompt_json),
    evidence: safeJson(row.evidence_json),
    rawOutput: row.raw_output,
    repairedOutput: row.repaired_output,
    finalOutput: safeJson(row.final_output_json),
    validationErrors: safeJson(row.validation_errors_json) || [],
    latencyMs: row.latency_ms,
    valid: !!row.valid,
    repairAttempts: row.repair_attempts,
    dedupeKey: row.dedupe_key
  };
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function paymentIdForStripe(stripeId) {
  const safe = String(stripeId || 'stripe').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80);
  return `pay_${safe}`;
}

function buildIdForLead(leadId) {
  const safe = String(leadId || 'lead').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
  return `bld_${safe}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function hookIdFor({ build_id, hook, attempt }) {
  const safeBuild = String(build_id || 'build').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
  const safeHook = String(hook || 'hook').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
  return `hook_${safeBuild}_${safeHook}_${attempt}_${randomBytes(3).toString('hex')}`;
}

function qaIdFor({ build_id, attempt }) {
  const safeBuild = String(build_id || 'build').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 56);
  return `qa_${safeBuild}_${attempt}`;
}

function revisionIdFor({ build_id, attempt }) {
  const safeBuild = String(build_id || 'build').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 54);
  return `rev_${safeBuild}_${attempt}`;
}

function hydrateHook(row) {
  if (!row) return null;
  return {
    ...row,
    input: safeJson(row.input_json),
    output: safeJson(row.output_json)
  };
}

function hydrateQa(row) {
  if (!row) return null;
  return {
    ...row,
    passed: Boolean(row.passed),
    checklist: safeJson(row.checklist_json) || [],
    errors: safeJson(row.errors_json) || [],
    claims: safeJson(row.claims_json) || {}
  };
}

function hydrateRevision(row) {
  if (!row) return null;
  return {
    ...row,
    result: safeJson(row.result_json)
  };
}

export { db };
