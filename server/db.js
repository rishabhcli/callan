import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';
import { redact } from './logger.js';
import { operationalErrorSummary } from './operationalErrors.js';

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

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at INTEGER NOT NULL,
    locked_by TEXT,
    locked_at INTEGER,
    lease_expires_at INTEGER,
    error TEXT,
    result_json TEXT,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
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
    launch_status TEXT NOT NULL DEFAULT 'not_started',
    launch_readiness_json TEXT,
    operator_approved_at INTEGER,
    customer_approved_at INTEGER,
    launched_at INTEGER,
    preview_html TEXT,
    screenshot_url TEXT,
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

  CREATE TABLE IF NOT EXISTS portal_tokens (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL DEFAULT 'build_share',
    status TEXT NOT NULL DEFAULT 'active',
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    rotated_from TEXT,
    metadata_json TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS customer_intake (
    lead_id TEXT PRIMARY KEY,
    contact_name TEXT,
    contact_email TEXT,
    preferred_phone TEXT,
    service_area TEXT,
    primary_goal TEXT,
    brand_voice TEXT,
    must_have_sections_json TEXT,
    asset_urls_json TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS portal_actions (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    token_id TEXT,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    related_type TEXT,
    related_id TEXT,
    body_json TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY(token_id) REFERENCES portal_tokens(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS provider_smoke (
    provider TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    detail_json TEXT,
    checked_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS provider_health_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    detail_json TEXT,
    dry_run INTEGER NOT NULL DEFAULT 0,
    live INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    error TEXT,
    checked_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_provider_health_events_provider_checked
    ON provider_health_events(provider, checked_at);
  CREATE INDEX IF NOT EXISTS idx_provider_health_events_status_checked
    ON provider_health_events(status, checked_at);

  CREATE TABLE IF NOT EXISTS safe_to_sell_reports (
    id TEXT PRIMARY KEY,
    ok INTEGER NOT NULL,
    mode TEXT,
    command TEXT,
    dry_run_count INTEGER NOT NULL DEFAULT 0,
    live_smoke_count INTEGER NOT NULL DEFAULT 0,
    blocker_count INTEGER NOT NULL DEFAULT 0,
    report_json TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_safe_to_sell_reports_generated
    ON safe_to_sell_reports(generated_at);
  CREATE INDEX IF NOT EXISTS idx_safe_to_sell_reports_ok_mode
    ON safe_to_sell_reports(ok, mode, generated_at);

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

  CREATE TABLE IF NOT EXISTS trust_ledger (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    lead_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT,
    channel TEXT,
    direction TEXT,
    subject_id TEXT,
    decision_code TEXT,
    summary TEXT NOT NULL,
    source_url TEXT,
    disclosure_text TEXT,
    metadata_json TEXT,
    dedupe_key TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
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

  CREATE TABLE IF NOT EXISTS commerce_plans (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    status TEXT NOT NULL,
    type TEXT NOT NULL,
    intake_json TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    risk_count INTEGER NOT NULL DEFAULT 0,
    handoff_required INTEGER NOT NULL DEFAULT 0,
    stripe_mode TEXT,
    idempotency_key TEXT,
    generated_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS handoff_cases (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    source_type TEXT NOT NULL,
    source_id TEXT,
    source_event_id TEXT,
    source_url TEXT,
    severity TEXT NOT NULL,
    category TEXT NOT NULL,
    status TEXT NOT NULL,
    assigned_to TEXT,
    summary TEXT NOT NULL,
    evidence_json TEXT,
    recommended_action TEXT,
    copilot_json TEXT,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    resolved_at INTEGER,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS handoff_case_actions (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    lead_id TEXT,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    note TEXT,
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(case_id) REFERENCES handoff_cases(id) ON DELETE CASCADE,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS account_manager_plans (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    evidence_json TEXT,
    risk_json TEXT,
    idempotency_key TEXT,
    generated_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS account_tasks (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    account_plan_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    due_at INTEGER NOT NULL,
    priority TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence_ids_json TEXT,
    owner TEXT,
    idempotency_key TEXT,
    preview_json TEXT,
    risk_json TEXT,
    policy_json TEXT,
    completion_notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_previewed_at INTEGER,
    sent_at INTEGER,
    completed_at INTEGER,
    paused_until INTEGER,
    provider_id TEXT,
    thread_id TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE,
    FOREIGN KEY(account_plan_id) REFERENCES account_manager_plans(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS account_task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    note TEXT,
    metadata_json TEXT,
    FOREIGN KEY(task_id) REFERENCES account_tasks(id) ON DELETE CASCADE,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs(type, status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_lease ON jobs(status, lease_expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
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
  CREATE INDEX IF NOT EXISTS idx_portal_tokens_lead_status ON portal_tokens(lead_id, status, expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_tokens_active_lead ON portal_tokens(lead_id, purpose) WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_customer_intake_updated ON customer_intake(updated_at);
  CREATE INDEX IF NOT EXISTS idx_portal_actions_lead_created ON portal_actions(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_portal_actions_type_created ON portal_actions(type, created_at);
  CREATE INDEX IF NOT EXISTS idx_call_attempts_phone ON call_attempts(phone);
  CREATE INDEX IF NOT EXISTS idx_call_attempts_lead_created ON call_attempts(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_moss_snippets_lead_status ON moss_snippets(lead_id, status, kind);
  CREATE INDEX IF NOT EXISTS idx_moss_retrievals_lead_created ON moss_retrievals(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_moss_retrievals_call_created ON moss_retrievals(call_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reasoning_traces_created ON reasoning_traces(created_at);
  CREATE INDEX IF NOT EXISTS idx_reasoning_traces_lead_created ON reasoning_traces(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_reasoning_traces_schema_created ON reasoning_traces(schema_name, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_reasoning_traces_dedupe ON reasoning_traces(dedupe_key) WHERE dedupe_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_handoff_cases_status ON handoff_cases(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_handoff_cases_lead ON handoff_cases(lead_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_handoff_cases_category ON handoff_cases(category, severity, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_cases_idempotency ON handoff_cases(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_handoff_case_actions_case ON handoff_case_actions(case_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_trust_ledger_lead_created ON trust_ledger(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_trust_ledger_event_created ON trust_ledger(event_type, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_ledger_dedupe ON trust_ledger(dedupe_key) WHERE dedupe_key IS NOT NULL;

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

  CREATE TRIGGER IF NOT EXISTS trust_ledger_no_update
  BEFORE UPDATE ON trust_ledger
  BEGIN
    SELECT RAISE(ABORT, 'trust_ledger rows are append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS trust_ledger_no_delete
  BEFORE DELETE ON trust_ledger
  BEGIN
    SELECT RAISE(ABORT, 'trust_ledger rows are append-only');
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
ensureColumn('leads', 'next_attempt_at', 'INTEGER');
ensureColumn('leads', 'attempt_channel', "TEXT");
ensureColumn('leads', 'attempt_count', "INTEGER NOT NULL DEFAULT 0");
ensureColumn('leads', 'priority_score', "REAL");
ensureColumn('leads', 'subscription_id', 'TEXT');
ensureColumn('leads', 'preview_build_triggered_at', 'INTEGER');
ensureColumn('leads', 'vertical_pack', 'TEXT');
ensureColumn('leads', 'preview_build_triggered_at', 'INTEGER');
ensureColumn('leads', 'preview_build_email_sent_at', 'INTEGER');
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
ensureColumn('builds', 'website_brief_json', 'TEXT');
ensureColumn('builds', 'error', 'TEXT');
ensureColumn('builds', 'trigger_key', 'TEXT');
ensureColumn('builds', 'updated_at', 'INTEGER');
ensureColumn('builds', 'target', "TEXT NOT NULL DEFAULT 'lovable'");
ensureColumn('builds', 'submission_url', 'TEXT');
ensureColumn('builds', 'provider_project_id', 'TEXT');
ensureColumn('builds', 'provider_deployment_id', 'TEXT');
ensureColumn('builds', 'attempt', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('builds', 'launch_status', "TEXT NOT NULL DEFAULT 'not_started'");
ensureColumn('builds', 'launch_readiness_json', 'TEXT');
ensureColumn('builds', 'operator_approved_at', 'INTEGER');
ensureColumn('builds', 'customer_approved_at', 'INTEGER');
ensureColumn('builds', 'launched_at', 'INTEGER');
ensureColumn('builds', 'preview_html', 'TEXT');
ensureColumn('builds', 'screenshot_url', 'TEXT');
ensureColumn('audit_events', 'contact_event_id', 'TEXT');
ensureColumn('audit_events', 'source_url', 'TEXT');
ensureColumn('audit_events', 'decision_code', 'TEXT');
ensureColumn('audit_events', 'decision_reason', 'TEXT');
ensureColumn('audit_events', 'dedupe_key', 'TEXT');
ensureColumn('compliance_decisions', 'contact_event_id', 'TEXT');
ensureColumn('compliance_decisions', 'source_url', 'TEXT');
ensureColumn('compliance_decisions', 'metadata_json', 'TEXT');
ensureColumn('compliance_decisions', 'dedupe_key', 'TEXT');
ensureColumn('trust_ledger', 'actor', 'TEXT');
ensureColumn('trust_ledger', 'channel', 'TEXT');
ensureColumn('trust_ledger', 'direction', 'TEXT');
ensureColumn('trust_ledger', 'subject_id', 'TEXT');
ensureColumn('trust_ledger', 'decision_code', 'TEXT');
ensureColumn('trust_ledger', 'source_url', 'TEXT');
ensureColumn('trust_ledger', 'disclosure_text', 'TEXT');
ensureColumn('trust_ledger', 'metadata_json', 'TEXT');
ensureColumn('trust_ledger', 'dedupe_key', 'TEXT');

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
  CREATE INDEX IF NOT EXISTS idx_trust_ledger_lead_created ON trust_ledger(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_trust_ledger_event_created ON trust_ledger(event_type, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_ledger_dedupe ON trust_ledger(dedupe_key) WHERE dedupe_key IS NOT NULL;
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
  CREATE INDEX IF NOT EXISTS idx_commerce_plans_lead ON commerce_plans(lead_id, generated_at);
  CREATE INDEX IF NOT EXISTS idx_commerce_plans_type ON commerce_plans(type, generated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_plans_idempotency ON commerce_plans(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_account_manager_plans_lead ON account_manager_plans(lead_id, generated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_account_manager_plans_idempotency ON account_manager_plans(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_account_tasks_lead_due ON account_tasks(lead_id, due_at);
  CREATE INDEX IF NOT EXISTS idx_account_tasks_status_due ON account_tasks(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_account_tasks_owner_status ON account_tasks(owner, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tasks_idempotency ON account_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_account_task_history_task ON account_task_history(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_account_task_history_lead ON account_task_history(lead_id, created_at);
`);

// experiments — A/B (or N-arm) bucketing + outcome capture for pitch/voice/price tests.
db.exec(`
  CREATE TABLE IF NOT EXISTS experiment_assignments (
    id TEXT PRIMARY KEY,
    experiment_key TEXT NOT NULL,
    lead_id TEXT,
    bucket_key TEXT NOT NULL,
    arm TEXT NOT NULL,
    assigned_at INTEGER NOT NULL,
    metadata_json TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_experiment_assignments_key_arm ON experiment_assignments(experiment_key, arm);
  CREATE INDEX IF NOT EXISTS idx_experiment_assignments_lead ON experiment_assignments(lead_id, experiment_key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_assignments_bucket ON experiment_assignments(experiment_key, bucket_key);

  CREATE TABLE IF NOT EXISTS experiment_outcomes (
    id TEXT PRIMARY KEY,
    assignment_id TEXT NOT NULL,
    experiment_key TEXT NOT NULL,
    arm TEXT NOT NULL,
    outcome TEXT NOT NULL,
    value_cents INTEGER,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(assignment_id) REFERENCES experiment_assignments(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_experiment_outcomes_key ON experiment_outcomes(experiment_key, arm, outcome, created_at);
`);

// lead_costs — per-lead per-provider cost accumulator for unit economics.
db.exec(`
  CREATE TABLE IF NOT EXISTS lead_costs (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    usd_micros INTEGER NOT NULL,
    units REAL,
    unit_label TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_lead_costs_lead ON lead_costs(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_lead_costs_provider ON lead_costs(provider, kind, created_at);
`);

// referral_clicks — anonymous click-through log for the "Built by callmemaybe" footer.
db.exec(`
  CREATE TABLE IF NOT EXISTS referral_clicks (
    id TEXT PRIMARY KEY,
    source_lead_id TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    referrer TEXT,
    user_agent TEXT,
    ip_hash TEXT,
    landed_path TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(source_lead_id) REFERENCES leads(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_referral_clicks_source ON referral_clicks(source_lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_referral_clicks_utm ON referral_clicks(utm_source, utm_campaign);
`);

// subscriptions — recurring hosting/edits MRR on top of one-shot $500 build.
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    stripe_subscription_id TEXT,
    stripe_customer_id TEXT,
    stripe_price_id TEXT,
    status TEXT NOT NULL,
    plan TEXT,
    amount_cents INTEGER,
    currency TEXT,
    started_at INTEGER,
    canceled_at INTEGER,
    last_event_at INTEGER,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_lead ON subscriptions(lead_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_stripe ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
`);

// reputation_events — flagged events for the auto-throttle (opt-outs, voicemail-only calls, BBB style complaints).
db.exec(`
  CREATE TABLE IF NOT EXISTS reputation_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    area_code TEXT,
    lead_id TEXT,
    severity TEXT NOT NULL DEFAULT 'info',
    metadata_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reputation_events_kind ON reputation_events(kind, created_at);
  CREATE INDEX IF NOT EXISTS idx_reputation_events_area ON reputation_events(area_code, created_at);
`);

// scheduled_calls — customer-requested outbound calls scheduled by email reply.
db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_calls (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    thread_id TEXT,
    inbound_message_id TEXT,
    scheduled_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    brief_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    fired_at INTEGER,
    lease_expires_at INTEGER,
    placed_call_id TEXT,
    failure_reason TEXT,
    FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_calls_due ON scheduled_calls(scheduled_at_ms) WHERE status='pending';
  CREATE INDEX IF NOT EXISTS idx_scheduled_calls_lead ON scheduled_calls(lead_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_calls_one_pending_per_lead
    ON scheduled_calls(lead_id) WHERE status='pending';
`);

backfillLeadDedupeKeys();
backfillAuditEvents();
backfillComplianceDecisions();
backfillProviderHealthEvents();

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

ensureColumn('scheduled_calls', 'lease_expires_at', 'INTEGER');

function jsonText(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function backfillProviderHealthEvents() {
  const rows = db.prepare(`
    SELECT provider, status, detail_json, checked_at
    FROM provider_smoke AS smoke
    WHERE NOT EXISTS (
      SELECT 1
      FROM provider_health_events AS event
      WHERE event.provider = smoke.provider
        AND event.status = smoke.status
        AND event.checked_at = smoke.checked_at
    )
  `).all();
  if (!rows.length) return;
  const insert = db.prepare(`
    INSERT INTO provider_health_events (
      id, provider, status, detail_json, dry_run, live, duration_ms, error, checked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction((items) => {
    for (const row of items) {
      const detail = safeJson(row.detail_json) || {};
      insert.run(
        `phealth_${Number(row.checked_at || Date.now()).toString(36)}_${randomBytes(4).toString('hex')}`,
        row.provider,
        row.status,
        row.detail_json,
        detail.dryRun === true ? 1 : 0,
        detail.live === true ? 1 : 0,
        optionalMs(detail.durationMs ?? detail.latencyMs ?? detail.elapsedMs),
        providerSmokeError(row.status, detail),
        row.checked_at
      );
    }
  })(rows);
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

function insertTrustLedgerEvent({
  id,
  created_at,
  lead_id,
  event_type,
  actor,
  channel,
  direction,
  subject_id,
  decision_code,
  summary,
  source_url,
  disclosure_text,
  metadata,
  dedupe_key
}) {
  const eventId = id || `trust_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const leadId = lead_id || null;
  db.prepare(`
    INSERT OR IGNORE INTO trust_ledger (
      id, created_at, lead_id, event_type, actor, channel, direction, subject_id,
      decision_code, summary, source_url, disclosure_text, metadata_json, dedupe_key
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    created_at || Date.now(),
    leadId,
    event_type,
    actor || null,
    channel || null,
    direction || null,
    subject_id || null,
    decision_code || null,
    summary || event_type,
    sourceUrlForLead(leadId, source_url || null),
    disclosure_text || null,
    jsonText(metadata),
    dedupe_key || null
  );
  return eventId;
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

function trustRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    lead_id: row.lead_id || null,
    event_type: row.event_type,
    actor: row.actor || null,
    channel: row.channel || null,
    direction: row.direction || null,
    subject_id: row.subject_id || null,
    decision_code: row.decision_code || null,
    summary: row.summary,
    source_url: row.source_url || null,
    disclosure_text: row.disclosure_text || null,
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
  'research_json',
  'preview_build_triggered_at',
  'preview_build_email_sent_at',
  'subscription_id',
  'next_attempt_at',
  'attempt_channel',
  'attempt_count',
  'vertical_pack'
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

const DEFAULT_PORTAL_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const portalTokens = {
  ensureActive({ lead_id, purpose = 'build_share', expiresInMs = DEFAULT_PORTAL_TOKEN_TTL_MS, metadata = null, now = Date.now() } = {}) {
    if (!lead_id) throw new Error('lead_id required');
    const lead = leads.get(lead_id);
    if (!lead) throw new Error(`lead ${lead_id} not found`);
    this.expireStale(now);
    const existing = db.prepare(`
      SELECT * FROM portal_tokens
      WHERE lead_id = ? AND purpose = ? AND status = 'active' AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(lead_id, purpose, now);
    if (existing) return { token: existing.token, row: hydratePortalToken(existing), reused: true };

    const token = portalTokenValue();
    const id = portalTokenId();
    const expiresAt = now + Math.max(60_000, Number(expiresInMs) || DEFAULT_PORTAL_TOKEN_TTL_MS);
    db.prepare(`
      INSERT INTO portal_tokens (
        id, lead_id, token, purpose, status, expires_at, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(id, lead_id, token, purpose, expiresAt, now, jsonText(metadata));
    insertAuditEvent({
      created_at: now,
      event_type: 'portal.token.created',
      lead_id,
      entity_type: 'portal_token',
      entity_id: id,
      action: 'created',
      metadata: { purpose, expires_at: expiresAt, ...metadata },
      dedupe_key: `portal_token:${id}:created`
    });
    insertTrustLedgerEvent({
      created_at: now,
      lead_id,
      event_type: 'portal_token_event',
      actor: 'portal',
      channel: 'portal',
      direction: 'outbound',
      subject_id: id,
      decision_code: 'portal_token.created',
      summary: `Customer portal token created for ${purpose}.`,
      metadata: { purpose, expires_at: expiresAt, ...(metadata || {}) },
      dedupe_key: `trust_portal_token:${id}:created`
    });
    return { token, row: hydratePortalToken(this.get(id)), reused: false };
  },
  rotate({ lead_id, purpose = 'build_share', expiresInMs = DEFAULT_PORTAL_TOKEN_TTL_MS, metadata = null, reason = 'manual_rotation', now = Date.now() } = {}) {
    if (!lead_id) throw new Error('lead_id required');
    const active = db.prepare(`
      SELECT * FROM portal_tokens
      WHERE lead_id = ? AND purpose = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(lead_id, purpose);
    if (active) {
      db.prepare(`UPDATE portal_tokens SET status = 'revoked' WHERE id = ?`).run(active.id);
      insertAuditEvent({
        created_at: now,
        event_type: 'portal.token.revoked',
        lead_id,
        entity_type: 'portal_token',
        entity_id: active.id,
        action: 'revoked',
        decision_reason: reason,
        metadata: { purpose, reason }
      });
      insertTrustLedgerEvent({
        created_at: now,
        lead_id,
        event_type: 'portal_token_event',
        actor: 'portal',
        channel: 'portal',
        direction: 'inbound',
        subject_id: active.id,
        decision_code: 'portal_token.revoked',
        summary: `Customer portal token revoked: ${reason}.`,
        metadata: { purpose, reason },
        dedupe_key: `trust_portal_token:${active.id}:revoked`
      });
    }
    const created = this.ensureActive({
      lead_id,
      purpose,
      expiresInMs,
      metadata: { ...(metadata || {}), rotatedFrom: active?.id || null, rotationReason: reason },
      now
    });
    if (active) db.prepare(`UPDATE portal_tokens SET rotated_from = ? WHERE id = ?`).run(active.id, created.row.id);
    return created;
  },
  resolve(token, { now = Date.now() } = {}) {
    const raw = String(token || '').trim();
    if (!raw) return { ok: false, reason: 'token_required', row: null, lead: null };
    this.expireStale(now);
    const row = db.prepare(`SELECT * FROM portal_tokens WHERE token = ?`).get(raw);
    if (!row) return { ok: false, reason: 'not_found', row: null, lead: null };
    if (row.status !== 'active') return { ok: false, reason: row.status || 'inactive', row: hydratePortalToken(row), lead: null };
    if (row.expires_at <= now) {
      db.prepare(`UPDATE portal_tokens SET status = 'expired' WHERE id = ? AND status = 'active'`).run(row.id);
      insertTrustLedgerEvent({
        created_at: now,
        lead_id: row.lead_id,
        event_type: 'portal_token_event',
        actor: 'portal',
        channel: 'portal',
        direction: 'inbound',
        subject_id: row.id,
        decision_code: 'portal_token.expired',
        summary: 'Customer portal token expired before access.',
        metadata: { purpose: row.purpose, expires_at: row.expires_at },
        dedupe_key: `trust_portal_token:${row.id}:expired`
      });
      return { ok: false, reason: 'expired', row: hydratePortalToken({ ...row, status: 'expired' }), lead: null };
    }
    db.prepare(`UPDATE portal_tokens SET last_used_at = ? WHERE id = ?`).run(now, row.id);
    insertTrustLedgerEvent({
      created_at: now,
      lead_id: row.lead_id,
      event_type: 'portal_token_event',
      actor: 'portal',
      channel: 'portal',
      direction: 'inbound',
      subject_id: row.id,
      decision_code: 'portal_token.used',
      summary: 'Customer portal token was used to view the build portal.',
      metadata: { purpose: row.purpose, last_used_at: now },
      dedupe_key: `trust_portal_token:${row.id}:first_used`
    });
    return { ok: true, reason: 'active', row: hydratePortalToken({ ...row, last_used_at: now }), lead: leads.get(row.lead_id) };
  },
  expireStale(now = Date.now()) {
    return db.prepare(`
      UPDATE portal_tokens
      SET status = 'expired'
      WHERE status = 'active' AND expires_at <= ?
    `).run(now).changes;
  },
  get(id) {
    return hydratePortalToken(db.prepare(`SELECT * FROM portal_tokens WHERE id = ?`).get(id));
  },
  listByLead(lead_id, { limit = 20 } = {}) {
    return db.prepare(`
      SELECT * FROM portal_tokens
      WHERE lead_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 20, 100)).map(hydratePortalToken);
  }
};

export const customerIntake = {
  upsert(lead_id, patch = {}) {
    if (!lead_id) throw new Error('lead_id required');
    const now = Date.now();
    const existing = this.get(lead_id);
    const record = {
      lead_id,
      contact_name: stringOrNull(patch.contactName, existing?.contactName),
      contact_email: stringOrNull(patch.contactEmail, existing?.contactEmail),
      preferred_phone: stringOrNull(patch.preferredPhone, existing?.preferredPhone),
      service_area: stringOrNull(patch.serviceArea, existing?.serviceArea),
      primary_goal: stringOrNull(patch.primaryGoal, existing?.primaryGoal),
      brand_voice: stringOrNull(patch.brandVoice, existing?.brandVoice),
      must_have_sections_json: jsonText(arrayOrExisting(patch.mustHaveSections, existing?.mustHaveSections)),
      asset_urls_json: jsonText(assetArrayOrExisting(patch.assetUrls, existing?.assetUrls)),
      notes: stringOrNull(patch.notes, existing?.notes),
      created_at: existing?.created_at || now,
      updated_at: now
    };
    db.prepare(`
      INSERT INTO customer_intake (
        lead_id, contact_name, contact_email, preferred_phone, service_area,
        primary_goal, brand_voice, must_have_sections_json, asset_urls_json,
        notes, created_at, updated_at
      ) VALUES (
        @lead_id, @contact_name, @contact_email, @preferred_phone, @service_area,
        @primary_goal, @brand_voice, @must_have_sections_json, @asset_urls_json,
        @notes, @created_at, @updated_at
      )
      ON CONFLICT(lead_id) DO UPDATE SET
        contact_name = excluded.contact_name,
        contact_email = excluded.contact_email,
        preferred_phone = excluded.preferred_phone,
        service_area = excluded.service_area,
        primary_goal = excluded.primary_goal,
        brand_voice = excluded.brand_voice,
        must_have_sections_json = excluded.must_have_sections_json,
        asset_urls_json = excluded.asset_urls_json,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `).run(record);
    insertAuditEvent({
      created_at: now,
      event_type: 'portal.intake.updated',
      lead_id,
      entity_type: 'customer_intake',
      entity_id: lead_id,
      action: 'updated',
      metadata: { fields: Object.keys(patch || {}) }
    });
    return this.get(lead_id);
  },
  appendAsset(lead_id, asset) {
    const existing = this.get(lead_id) || {};
    const nextAsset = normalizeAsset(asset);
    const current = Array.isArray(existing.assetUrls) ? existing.assetUrls : [];
    const assetUrls = nextAsset ? dedupeAssets([...current, nextAsset]) : current;
    return this.upsert(lead_id, { assetUrls });
  },
  get(lead_id) {
    return hydrateCustomerIntake(db.prepare(`SELECT * FROM customer_intake WHERE lead_id = ?`).get(lead_id));
  }
};

export const portalActions = {
  add({
    id,
    lead_id,
    token_id = null,
    type,
    status = 'submitted',
    related_type = null,
    related_id = null,
    body = null,
    metadata = null,
    resolved_at = null
  } = {}) {
    if (!lead_id) throw new Error('lead_id required');
    if (!type) throw new Error('portal action type required');
    const createdAt = Date.now();
    const actionId = id || portalActionId(type);
    db.prepare(`
      INSERT INTO portal_actions (
        id, lead_id, token_id, type, status, related_type, related_id,
        body_json, metadata_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actionId,
      lead_id,
      token_id || null,
      type,
      status,
      related_type || null,
      related_id || null,
      jsonText(body),
      jsonText(metadata),
      createdAt,
      resolved_at || null
    );
    insertAuditEvent({
      created_at: createdAt,
      event_type: `portal.action.${type}`,
      lead_id,
      entity_type: 'portal_action',
      entity_id: actionId,
      action: status,
      metadata: { related_type, related_id, body, ...metadata }
    });
    insertTrustLedgerEvent({
      created_at: createdAt,
      lead_id,
      event_type: type === 'opt_out' || /opt.?out/i.test(type) ? 'opt_out' : 'portal_token_event',
      actor: 'customer',
      channel: 'portal',
      direction: 'inbound',
      subject_id: actionId,
      decision_code: `portal.${type}`,
      summary: `Customer portal action ${type} was recorded with status ${status}.`,
      metadata: { token_id, related_type, related_id, body, ...metadata },
      dedupe_key: `trust_portal_action:${actionId}`
    });
    return this.get(actionId);
  },
  get(id) {
    return hydratePortalAction(db.prepare(`SELECT * FROM portal_actions WHERE id = ?`).get(id));
  },
  listByLead(lead_id, { limit = 100, type } = {}) {
    if (type) {
      return db.prepare(`
        SELECT * FROM portal_actions
        WHERE lead_id = ? AND type = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(lead_id, type, limitFor(limit, 100, 500)).map(hydratePortalAction);
    }
    return db.prepare(`
      SELECT * FROM portal_actions
      WHERE lead_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 100, 500)).map(hydratePortalAction);
  },
  latest(lead_id, type) {
    return hydratePortalAction(db.prepare(`
      SELECT * FROM portal_actions
      WHERE lead_id = ? AND type = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(lead_id, type));
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

export const durableJobs = {
  enqueue({
    id,
    type,
    payload = {},
    idempotency_key,
    runAt = Date.now(),
    maxAttempts = 5,
    now = Date.now()
  } = {}) {
    if (!type || typeof type !== 'string') throw new Error('job type is required');
    const jobId = id || jobIdFor(type);
    const record = {
      id: jobId,
      type,
      payload_json: JSON.stringify(payload || {}),
      status: 'queued',
      attempts: 0,
      max_attempts: boundedJobAttempts(maxAttempts),
      next_attempt_at: Number.isFinite(runAt) ? Math.trunc(runAt) : now,
      idempotency_key: idempotency_key || null,
      created_at: now,
      updated_at: now
    };
    const info = db.prepare(`
      INSERT OR IGNORE INTO jobs (
        id, type, payload_json, status, attempts, max_attempts, next_attempt_at,
        idempotency_key, created_at, updated_at
      )
      VALUES (
        @id, @type, @payload_json, @status, @attempts, @max_attempts, @next_attempt_at,
        @idempotency_key, @created_at, @updated_at
      )
    `).run(record);
    const row = idempotency_key ? this.getByIdempotency(idempotency_key) : this.get(jobId);
    return { inserted: info.changes > 0, row: hydrateJob(row) };
  },
  get(id) {
    return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  },
  getByIdempotency(idempotency_key) {
    return db.prepare(`SELECT * FROM jobs WHERE idempotency_key = ?`).get(idempotency_key);
  },
  list({ status, type, limit = 100 } = {}) {
    const capped = limitFor(limit, 100, 500);
    if (status && type) {
      return db.prepare(`
        SELECT * FROM jobs
        WHERE status = ? AND type = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(status, type, capped).map(hydrateJob);
    }
    if (status) {
      return db.prepare(`
        SELECT * FROM jobs
        WHERE status = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(status, capped).map(hydrateJob);
    }
    if (type) {
      return db.prepare(`
        SELECT * FROM jobs
        WHERE type = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(type, capped).map(hydrateJob);
    }
    return db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(capped).map(hydrateJob);
  },
  claimNext({ workerId, leaseMs = 5 * 60 * 1000, now = Date.now(), types = [] } = {}) {
    const typeList = Array.isArray(types) ? types.filter(Boolean) : [];
    const leaseExpiresAt = now + Math.max(1_000, Number(leaseMs) || 5 * 60 * 1000);
    const claimOne = db.transaction(() => {
      const whereTypes = typeList.length ? `AND type IN (${typeList.map(() => '?').join(', ')})` : '';
      const row = db.prepare(`
        SELECT * FROM jobs
        WHERE (
          (status IN ('queued', 'retry') AND next_attempt_at <= ?)
          OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        )
        ${whereTypes}
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT 1
      `).get(now, now, ...typeList);
      if (!row) return null;
      const info = db.prepare(`
        UPDATE jobs
        SET status = 'running',
            attempts = attempts + 1,
            locked_by = ?,
            locked_at = ?,
            lease_expires_at = ?,
            error = NULL,
            updated_at = ?
        WHERE id = ?
          AND (
            (status IN ('queued', 'retry') AND next_attempt_at <= ?)
            OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )
      `).run(workerId || 'job-worker', now, leaseExpiresAt, now, row.id, now, now);
      if (info.changes <= 0) return null;
      return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(row.id);
    });
    return hydrateJob(claimOne());
  },
  complete(id, { result, now = Date.now() } = {}) {
    db.prepare(`
      UPDATE jobs
      SET status = 'completed',
          result_json = ?,
          error = NULL,
          locked_by = NULL,
          locked_at = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          finished_at = ?
      WHERE id = ?
    `).run(result === undefined ? null : JSON.stringify(result), now, now, id);
    return hydrateJob(this.get(id));
  },
  fail(id, {
    error,
    result,
    retryable,
    now = Date.now(),
    baseDelayMs = 30_000,
    maxDelayMs = 15 * 60 * 1000
  } = {}) {
    const row = this.get(id);
    if (!row) return null;
    const terminal = retryable === false || row.attempts >= row.max_attempts;
    const retryDelay = terminal ? 0 : retryDelayFor(row.attempts, { baseDelayMs, maxDelayMs });
    const nextStatus = terminal ? 'failed' : 'retry';
    db.prepare(`
      UPDATE jobs
      SET status = ?,
          error = ?,
          result_json = COALESCE(?, result_json),
          next_attempt_at = ?,
          locked_by = NULL,
          locked_at = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
      WHERE id = ?
    `).run(
      nextStatus,
      normalizeJobError(error),
      result === undefined ? null : JSON.stringify(result),
      now + retryDelay,
      now,
      nextStatus,
      now,
      id
    );
    return hydrateJob(this.get(id));
  },
  cancel(id, { reason = 'canceled', now = Date.now() } = {}) {
    db.prepare(`
      UPDATE jobs
      SET status = 'canceled',
          error = ?,
          locked_by = NULL,
          locked_at = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          finished_at = ?
      WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')
    `).run(reason, now, now, id);
    return hydrateJob(this.get(id));
  },
  recoverExpiredLeases({ now = Date.now(), limit = 100 } = {}) {
    const rows = db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
      ORDER BY lease_expires_at ASC
      LIMIT ?
    `).all(now, limitFor(limit, 100, 500));
    const recover = db.transaction(() => {
      for (const row of rows) {
        const terminal = row.attempts >= row.max_attempts;
        db.prepare(`
          UPDATE jobs
          SET status = ?,
              error = ?,
              next_attempt_at = ?,
              locked_by = NULL,
              locked_at = NULL,
              lease_expires_at = NULL,
              updated_at = ?,
              finished_at = CASE WHEN ? = 'failed' THEN ? ELSE NULL END
          WHERE id = ? AND status = 'running'
        `).run(
          terminal ? 'failed' : 'retry',
          'lease_expired',
          now,
          now,
          terminal ? 'failed' : 'retry',
          now,
          row.id
        );
      }
    });
    recover();
    return rows.length;
  },
  summary({ now = Date.now(), staleAfterMs = 10 * 60 * 1000, recentLimit = 10 } = {}) {
    const countsByStatus = Object.fromEntries(db.prepare(`
      SELECT status, COUNT(*) AS n
      FROM jobs
      GROUP BY status
    `).all().map((row) => [row.status, row.n]));
    const countsByType = Object.fromEntries(db.prepare(`
      SELECT type, status, COUNT(*) AS n
      FROM jobs
      GROUP BY type, status
      ORDER BY type, status
    `).all().map((row) => [`${row.type}:${row.status}`, row.n]));
    const due = db.prepare(`
      SELECT COUNT(*) AS n
      FROM jobs
      WHERE status IN ('queued', 'retry') AND next_attempt_at <= ?
    `).get(now).n;
    const staleRunning = db.prepare(`
      SELECT COUNT(*) AS n
      FROM jobs
      WHERE status = 'running'
        AND COALESCE(lease_expires_at, locked_at + ?) <= ?
    `).get(staleAfterMs, now).n;
    const oldest = db.prepare(`
      SELECT MIN(created_at) AS oldestQueuedAt, MIN(next_attempt_at) AS nextDueAt
      FROM jobs
      WHERE status IN ('queued', 'retry')
    `).get();
    const recentFailures = db.prepare(`
      SELECT id, type, attempts, max_attempts, error, updated_at, finished_at
      FROM jobs
      WHERE status IN ('failed', 'retry')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limitFor(recentLimit, 10, 100)).map((row) => ({
      ...row,
      error: row.error ? operationalErrorSummary(redact(row.error)) : null
    }));
    return {
      countsByStatus,
      countsByType,
      due,
      staleRunning,
      oldestQueuedAt: oldest?.oldestQueuedAt || null,
      nextDueAt: oldest?.nextDueAt || null,
      recentFailures
    };
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
  },
  listStuck({ maxAgeMs = 45 * 60 * 1000, now = Date.now(), limit = 25 } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 25, 500));
    return db.prepare(`
      SELECT *
      FROM calls
      WHERE state IN ('in_progress', 'ringing', 'active')
        AND started_at < ?
      ORDER BY started_at ASC
      LIMIT ?
    `).all(now - maxAgeMs, n);
  },
  recoverStuck({
    maxAgeMs = 45 * 60 * 1000,
    now = Date.now(),
    limit = 25,
    dryRun = false,
    outcome = 'failed:stale_recovered'
  } = {}) {
    const rows = this.listStuck({ maxAgeMs, now, limit });
    if (dryRun) {
      return { dryRun: true, matched: rows.length, recovered: 0, rows };
    }
    const transcript = JSON.stringify([
      {
        role: 'system',
        text: `Recovered stale call after ${maxAgeMs}ms without a terminal provider update.`,
        at: new Date(now).toISOString()
      }
    ]);
    const recover = db.transaction((items) => {
      let recovered = 0;
      for (const row of items) {
        const result = db.prepare(`
          UPDATE calls
          SET state = 'ended',
              outcome = ?,
              transcript_json = COALESCE(transcript_json, ?),
              ended_at = ?
          WHERE id = ?
            AND state IN ('in_progress', 'ringing', 'active')
        `).run(outcome, transcript, now, row.id);
        if (!result.changes) continue;
        recovered += 1;
        insertAuditEvent({
          created_at: now,
          event_type: 'call.recovered',
          lead_id: row.lead_id,
          entity_type: 'call',
          entity_id: row.id,
          action: 'recovered',
          decision_code: 'STALE_CALL_RECOVERED',
          decision_reason: `Call remained ${row.state} longer than ${maxAgeMs}ms.`,
          metadata: {
            previousState: row.state,
            provider_call_id: row.provider_call_id,
            started_at: row.started_at,
            maxAgeMs,
            outcome
          },
          dedupe_key: `call:${row.id}:stale_recovered`
        });
      }
      return recovered;
    });
    return { dryRun: false, matched: rows.length, recovered: recover(rows), rows };
  }
};

export const scheduledCalls = {
  start({ id, lead_id, thread_id, inbound_message_id, scheduled_at_ms, brief }) {
    const now = Date.now();
    const briefJson = jsonText(brief);
    db.prepare(`
      INSERT INTO scheduled_calls (id, lead_id, thread_id, inbound_message_id, scheduled_at_ms, status, brief_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, lead_id, thread_id || null, inbound_message_id || null, scheduled_at_ms, briefJson, now);
    insertAuditEvent({
      created_at: now,
      event_type: 'scheduled_call.created',
      lead_id,
      entity_type: 'scheduled_call',
      entity_id: id,
      action: 'created',
      metadata: { scheduled_at_ms, thread_id: thread_id || null, brief: brief || null },
      dedupe_key: `sched:${id}:created`
    });
    return this.get(id);
  },
  markPlacing(id) {
    const now = Date.now();
    // CAS: only flip a still-pending row. Caller checks info.changes.
    const info = db.prepare(`
      UPDATE scheduled_calls
      SET status='placing',
          fired_at=?,
          lease_expires_at=?,
          attempts = attempts + 1
      WHERE id = ? AND status='pending'
    `).run(now, now + 5 * 60 * 1000, id);
    return info.changes === 1;
  },
  touchPlacing(id, { leaseMs = 5 * 60 * 1000, now = Date.now() } = {}) {
    const info = db.prepare(`
      UPDATE scheduled_calls
      SET fired_at = COALESCE(fired_at, ?),
          lease_expires_at = ?
      WHERE id = ? AND status='placing'
    `).run(now, now + Math.max(1_000, Number(leaseMs) || 5 * 60 * 1000), id);
    return info.changes === 1;
  },
  markPlaced(id, { call_id } = {}) {
    db.prepare(`
      UPDATE scheduled_calls
      SET status='placed', placed_call_id = ?, lease_expires_at = NULL
      WHERE id = ?
    `).run(call_id || null, id);
    const row = this.get(id);
    insertAuditEvent({
      created_at: Date.now(),
      event_type: 'scheduled_call.placed',
      lead_id: row?.lead_id || null,
      entity_type: 'scheduled_call',
      entity_id: id,
      action: 'placed',
      metadata: { call_id: call_id || null },
      dedupe_key: `sched:${id}:placed`
    });
    return row;
  },
  markFailed(id, { reason } = {}) {
    db.prepare(`
      UPDATE scheduled_calls
      SET status='failed', failure_reason=?, lease_expires_at = NULL
      WHERE id = ?
    `).run(reason || null, id);
    const row = this.get(id);
    insertAuditEvent({
      created_at: Date.now(),
      event_type: 'scheduled_call.failed',
      lead_id: row?.lead_id || null,
      entity_type: 'scheduled_call',
      entity_id: id,
      action: 'failed',
      decision_reason: reason || null,
      metadata: { reason: reason || null },
      dedupe_key: `sched:${id}:failed`
    });
    return row;
  },
  cancel(id, { reason } = {}) {
    db.prepare(`
      UPDATE scheduled_calls
      SET status='canceled', failure_reason=?, lease_expires_at = NULL
      WHERE id = ? AND status IN ('pending', 'placing')
    `).run(reason || null, id);
    const row = this.get(id);
    if (row?.status === 'canceled') {
      insertAuditEvent({
        created_at: Date.now(),
        event_type: 'scheduled_call.canceled',
        lead_id: row?.lead_id || null,
        entity_type: 'scheduled_call',
        entity_id: id,
        action: 'canceled',
        decision_reason: reason || null,
        metadata: { reason: reason || null },
        dedupe_key: `sched:${id}:canceled`
      });
    }
    return row;
  },
  get(id) {
    return db.prepare(`SELECT * FROM scheduled_calls WHERE id = ?`).get(id);
  },
  listDue(nowMs = Date.now(), { limit = 5 } = {}) {
    return db.prepare(`
      SELECT * FROM scheduled_calls
      WHERE status='pending' AND scheduled_at_ms <= ?
      ORDER BY scheduled_at_ms ASC
      LIMIT ?
    `).all(nowMs, limit);
  },
  listForLead(lead_id) {
    return db.prepare(`
      SELECT * FROM scheduled_calls WHERE lead_id = ? ORDER BY scheduled_at_ms DESC
    `).all(lead_id);
  },
  listPending({ limit = 50 } = {}) {
    return db.prepare(`
      SELECT * FROM scheduled_calls WHERE status='pending' ORDER BY scheduled_at_ms ASC LIMIT ?
    `).all(limit);
  },
  listRecent({ limit = 50 } = {}) {
    return db.prepare(`
      SELECT * FROM scheduled_calls ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  },
  findPendingForLead(lead_id) {
    return db.prepare(`
      SELECT * FROM scheduled_calls WHERE lead_id = ? AND status='pending' LIMIT 1
    `).get(lead_id);
  },
  /** Move a pending row's scheduled time forward so the next loop tick picks it up. */
  bringForward(id, newScheduledAtMs) {
    db.prepare(`
      UPDATE scheduled_calls SET scheduled_at_ms = ? WHERE id = ? AND status='pending'
    `).run(newScheduledAtMs, id);
    return this.get(id);
  },
  /** Sweep rows stuck in 'placing' for > maxAgeMs back to 'pending' (crash recovery). */
  recoverStuck({ maxAgeMs = 60_000, now = Date.now() } = {}) {
    const cutoff = now - maxAgeMs;
    const info = db.prepare(`
      UPDATE scheduled_calls
      SET status='pending', fired_at=NULL, lease_expires_at=NULL
      WHERE status='placing'
        AND (
          (lease_expires_at IS NOT NULL AND lease_expires_at < ?)
          OR (lease_expires_at IS NULL AND fired_at IS NOT NULL AND fired_at < ?)
        )
    `).run(now, cutoff);
    return info.changes;
  }
};

// -- experiments (A/B harness) -----------------------------------------------
export const experimentAssignments = {
  insert({ id, experiment_key, lead_id, bucket_key, arm, metadata }) {
    db.prepare(`
      INSERT INTO experiment_assignments (id, experiment_key, lead_id, bucket_key, arm, assigned_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(experiment_key, bucket_key) DO NOTHING
    `).run(id, experiment_key, lead_id || null, bucket_key, arm, Date.now(), jsonText(metadata));
    return this.findByBucket(experiment_key, bucket_key);
  },
  findByBucket(experiment_key, bucket_key) {
    return db.prepare(`SELECT * FROM experiment_assignments WHERE experiment_key = ? AND bucket_key = ?`).get(experiment_key, bucket_key);
  },
  findForLead(experiment_key, lead_id) {
    if (!lead_id) return null;
    return db.prepare(`SELECT * FROM experiment_assignments WHERE experiment_key = ? AND lead_id = ? ORDER BY assigned_at DESC LIMIT 1`).get(experiment_key, lead_id);
  }
};

export const experimentOutcomes = {
  insert({ id, assignment_id, experiment_key, arm, outcome, value_cents, metadata }) {
    db.prepare(`
      INSERT INTO experiment_outcomes (id, assignment_id, experiment_key, arm, outcome, value_cents, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, assignment_id, experiment_key, arm, outcome, value_cents ?? null, jsonText(metadata), Date.now());
  },
  rollup(experiment_key) {
    return db.prepare(`
      SELECT a.arm,
             COUNT(DISTINCT a.id)                                AS assignments,
             COUNT(DISTINCT CASE WHEN o.outcome='converted' THEN o.assignment_id END) AS conversions,
             COALESCE(SUM(CASE WHEN o.outcome='converted' THEN o.value_cents END), 0) AS revenue_cents
      FROM experiment_assignments a
      LEFT JOIN experiment_outcomes o
        ON o.assignment_id = a.id AND o.experiment_key = a.experiment_key
      WHERE a.experiment_key = ?
      GROUP BY a.arm
      ORDER BY revenue_cents DESC
    `).all(experiment_key);
  },
  listKeys() {
    return db.prepare(`SELECT DISTINCT experiment_key FROM experiment_assignments ORDER BY experiment_key`).all().map((r) => r.experiment_key);
  }
};

// -- per-lead unit economics --------------------------------------------------
export const leadCosts = {
  record({ id, lead_id, provider, kind, usd, units, unit_label, metadata }) {
    const usdMicros = Math.round(Number(usd || 0) * 1_000_000);
    db.prepare(`
      INSERT INTO lead_costs (id, lead_id, provider, kind, usd_micros, units, unit_label, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      lead_id,
      provider,
      kind,
      usdMicros,
      units ?? null,
      unit_label || null,
      jsonText(metadata),
      Date.now()
    );
  },
  totalsForLead(lead_id) {
    return db.prepare(`
      SELECT provider, kind, SUM(usd_micros) AS micros, SUM(units) AS units, COUNT(*) AS events
      FROM lead_costs
      WHERE lead_id = ?
      GROUP BY provider, kind
    `).all(lead_id).map((r) => ({ ...r, usd: r.micros / 1_000_000 }));
  },
  rollupByNiche({ since } = {}) {
    const cutoff = since ? Number(since) : 0;
    return db.prepare(`
      SELECT COALESCE(l.niche, 'unknown') AS niche,
             COUNT(DISTINCT lc.lead_id)   AS lead_count,
             SUM(lc.usd_micros)           AS cost_micros
      FROM lead_costs lc
      JOIN leads l ON l.id = lc.lead_id
      WHERE lc.created_at >= ?
      GROUP BY COALESCE(l.niche, 'unknown')
    `).all(cutoff).map((r) => ({ ...r, cost_usd: r.cost_micros / 1_000_000 }));
  }
};

// -- referral clicks (Built-by-callmemaybe footer) ----------------------------
export const referralClicks = {
  record({ id, source_lead_id, utm_source, utm_medium, utm_campaign, referrer, user_agent, ip_hash, landed_path }) {
    db.prepare(`
      INSERT INTO referral_clicks (id, source_lead_id, utm_source, utm_medium, utm_campaign, referrer, user_agent, ip_hash, landed_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, source_lead_id || null, utm_source || null, utm_medium || null, utm_campaign || null, referrer || null, user_agent || null, ip_hash || null, landed_path || null, Date.now());
  },
  rollup({ limit = 30 } = {}) {
    return db.prepare(`
      SELECT source_lead_id, COUNT(*) AS clicks, MAX(created_at) AS last_at
      FROM referral_clicks
      GROUP BY source_lead_id
      ORDER BY clicks DESC
      LIMIT ?
    `).all(limit);
  },
  countAll() {
    return db.prepare(`SELECT COUNT(*) AS n FROM referral_clicks`).get().n;
  }
};

// -- recurring subscriptions (hosting/edits MRR) ------------------------------
export const subscriptions = {
  upsert({ id, lead_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, status, plan, amount_cents, currency, started_at, canceled_at, metadata }) {
    const now = Date.now();
    const existing = stripe_subscription_id
      ? db.prepare(`SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`).get(stripe_subscription_id)
      : null;
    if (existing) {
      db.prepare(`
        UPDATE subscriptions SET
          stripe_customer_id = COALESCE(?, stripe_customer_id),
          stripe_price_id    = COALESCE(?, stripe_price_id),
          status             = COALESCE(?, status),
          plan               = COALESCE(?, plan),
          amount_cents       = COALESCE(?, amount_cents),
          currency           = COALESCE(?, currency),
          canceled_at        = COALESCE(?, canceled_at),
          last_event_at      = ?,
          metadata_json      = COALESCE(?, metadata_json),
          updated_at         = ?
        WHERE id = ?
      `).run(stripe_customer_id || null, stripe_price_id || null, status || null, plan || null, amount_cents ?? null, currency || null, canceled_at ?? null, now, jsonText(metadata), now, existing.id);
      return this.get(existing.id);
    }
    db.prepare(`
      INSERT INTO subscriptions (id, lead_id, stripe_subscription_id, stripe_customer_id, stripe_price_id, status, plan, amount_cents, currency, started_at, canceled_at, last_event_at, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, lead_id, stripe_subscription_id || null, stripe_customer_id || null, stripe_price_id || null, status, plan || null, amount_cents ?? null, currency || null, started_at ?? null, canceled_at ?? null, now, jsonText(metadata), now, now);
    return this.get(id);
  },
  get(id) {
    return db.prepare(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
  },
  byStripeId(stripe_subscription_id) {
    return db.prepare(`SELECT * FROM subscriptions WHERE stripe_subscription_id = ?`).get(stripe_subscription_id);
  },
  forLead(lead_id) {
    return db.prepare(`SELECT * FROM subscriptions WHERE lead_id = ? ORDER BY created_at DESC`).all(lead_id);
  },
  activeMrrCents() {
    const row = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS mrr FROM subscriptions WHERE status IN ('active','trialing','past_due')`).get();
    return row.mrr || 0;
  },
  countByStatus() {
    return db.prepare(`SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status`).all();
  }
};

// -- reputation events --------------------------------------------------------
export const reputationEvents = {
  record({ kind, area_code, lead_id, severity = 'info', metadata }) {
    const id = `repev_${Date.now().toString(36)}_${randomTail(6)}`;
    db.prepare(`
      INSERT INTO reputation_events (id, kind, area_code, lead_id, severity, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, kind, area_code || null, lead_id || null, severity, jsonText(metadata), Date.now());
  },
  recentByKind(kind, sinceMs) {
    return db.prepare(`
      SELECT * FROM reputation_events
      WHERE kind = ? AND created_at >= ?
      ORDER BY created_at DESC
    `).all(kind, sinceMs);
  },
  countSince(kind, sinceMs) {
    return db.prepare(`SELECT COUNT(*) AS n FROM reputation_events WHERE kind = ? AND created_at >= ?`).get(kind, sinceMs).n;
  },
  recentAlerts({ sinceMs = Date.now() - 24*3600*1000, limit = 40 } = {}) {
    return db.prepare(`
      SELECT * FROM reputation_events
      WHERE severity IN ('warn','alert') AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?
    `).all(sinceMs, limit);
  }
};

function randomTail(n) {
  let s = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

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
  },
  findActiveForLead(lead_id) {
    return db.prepare(`
      SELECT * FROM builds
      WHERE lead_id = ?
        AND status IN ('queued', 'starting', 'running', 'qa_review', 'completed')
      ORDER BY started_at DESC
      LIMIT 1
    `).get(lead_id);
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
    insertTrustLedgerEvent({
      created_at: now,
      lead_id,
      event_type: 'call_decision',
      actor: 'compliance',
      channel: 'phone',
      direction: 'outbound',
      subject_id: attemptId,
      decision_code: code,
      summary: allowed ? 'Outbound call allowed by compliance gates.' : 'Outbound call blocked by compliance gates.',
      source_url,
      disclosure_text: disclosure_text || null,
      metadata: decisionMetadata,
      dedupe_key: `trust_call_attempt:${attemptId}`
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

function trustEventForContactEvent({
  id,
  lead_id,
  type,
  direction,
  channel,
  provider_id,
  thread_id,
  subject,
  body,
  metadata,
  createdAt
}) {
  const meta = metadata || {};
  const classification = meta.classification || {};
  const deliveryRisk = meta.deliveryRisk || {};
  const lowerType = String(type || '').toLowerCase();
  const lowerChannel = String(channel || '').toLowerCase();
  const base = {
    created_at: createdAt,
    lead_id,
    actor: lowerChannel || null,
    channel,
    direction,
    subject_id: id,
    source_url: meta.sourceUrl || meta.source_url || null,
    metadata: {
      contactEventId: id,
      providerId: provider_id || null,
      threadId: thread_id || null,
      subject: subject || null,
      ...meta
    }
  };

  const event = (event_type, summary, extra = {}) => ({
    ...base,
    event_type,
    decision_code: extra.decision_code || meta.decisionCode || meta.decision_code || null,
    summary,
    dedupe_key: `trust_contact:${id}:${event_type}`,
    ...extra
  });

  if (lowerChannel === 'outreach' && lowerType === 'outreach_queued') {
    return event('why_contacted', body || meta.decisionReason || 'Lead was queued because research found a weak or mixed online-presence gap.');
  }
  if (lowerType === 'invoice_consent') {
    return event('invoice_consent', body || 'Transcript-backed invoice consent was recorded.', {
      decision_code: meta.decisionCode || 'invoice_consent.transcript_backed'
    });
  }
  if (lowerType === 'invoice_email') {
    return event('invoice_email_sent', 'Invoice email was sent after the invoice consent gate passed.', {
      decision_code: meta.decisionCode || 'agentmail.outbound.invoice_email'
    });
  }
  if (lowerChannel === 'portal') {
    if (/opt.?out/.test(lowerType)) {
      return event('opt_out', body || 'Customer opted out through the portal.', {
        decision_code: meta.decisionCode || 'portal.opt_out'
      });
    }
    return event('portal_token_event', body || `Customer portal event: ${type}`, {
      decision_code: meta.decisionCode || `portal.${lowerType || 'event'}`
    });
  }
  if (classification.kind === 'opt_out' || /opt.?out|unsubscribe|do_not_email|do_not_call/.test(`${lowerType} ${body || ''}`)) {
    if (direction === 'outbound') {
      return event('opt_out_confirmation', body || 'Opt-out confirmation was sent.');
    }
    return event('opt_out', body || classification.reason || 'Customer requested opt-out.');
  }
  if (deliveryRisk.flagged || lowerType === 'customer_reply_flagged') {
    return event(deliveryRisk.kind === 'complaint' ? 'provider_complaint' : 'provider_flag', deliveryRisk.reason || body || 'Provider flagged the inbound message.', {
      decision_code: `provider_flag.${deliveryRisk.kind || 'unknown'}`
    });
  }
  if (lowerChannel === 'operator' && (lowerType.includes('opt_out') || lowerType.includes('blocked'))) {
    return event(lowerType.includes('opt_out') ? 'opt_out' : 'operator_block', body || 'Operator changed trust state.', {
      decision_code: meta.reasonCode || `operator.${lowerType}`
    });
  }
  if (lowerChannel === 'outreach' && /^autonomy_/.test(lowerType)) {
    return event('operator_control', body || type, {
      decision_code: `outreach.${lowerType}`
    });
  }
  return null;
}

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
    const trustEvent = trustEventForContactEvent({
      id: eventId,
      lead_id,
      type,
      direction,
      channel,
      provider_id,
      thread_id,
      subject,
      body,
      metadata,
      createdAt
    });
    if (trustEvent) insertTrustLedgerEvent(trustEvent);
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

export const handoffCases = {
  createOrGet(row) {
    const now = row.created_at || Date.now();
    const record = {
      id: row.id || handoffCaseId(row.category),
      lead_id: row.lead_id || row.leadId || null,
      source_type: row.source_type || row.sourceType || 'system',
      source_id: row.source_id || row.sourceId || null,
      source_event_id: row.source_event_id || row.sourceEventId || null,
      source_url: row.source_url || row.sourceUrl || null,
      severity: normalizeSeverity(row.severity),
      category: normalizeCaseCode(row.category || 'operator_review'),
      status: normalizeCaseStatus(row.status || 'open'),
      assigned_to: row.assigned_to || row.assignedTo || null,
      summary: cleanCaseText(row.summary || 'Operator review required.'),
      evidence_json: jsonText(row.evidence || []),
      recommended_action: cleanCaseText(row.recommended_action || row.recommendedAction || 'Review the evidence and choose the safest operator action.'),
      copilot_json: jsonText(row.copilot || null),
      idempotency_key: row.idempotency_key || row.idempotencyKey || null,
      created_at: now,
      updated_at: now,
      resolved_at: row.resolved_at || row.resolvedAt || null
    };
    const info = db.prepare(`
      INSERT OR IGNORE INTO handoff_cases (
        id, lead_id, source_type, source_id, source_event_id, source_url, severity, category,
        status, assigned_to, summary, evidence_json, recommended_action, copilot_json,
        idempotency_key, created_at, updated_at, resolved_at
      )
      VALUES (
        @id, @lead_id, @source_type, @source_id, @source_event_id, @source_url, @severity, @category,
        @status, @assigned_to, @summary, @evidence_json, @recommended_action, @copilot_json,
        @idempotency_key, @created_at, @updated_at, @resolved_at
      )
    `).run(record);
    const found = record.idempotency_key ? this.getByIdempotency(record.idempotency_key) : this.get(record.id);
    if (info.changes > 0) {
      insertAuditEvent({
        created_at: now,
        event_type: 'handoff.case.created',
        lead_id: record.lead_id,
        contact_event_id: record.source_event_id,
        entity_type: 'handoff_case',
        entity_id: record.id,
        action: 'created',
        worker: 'operator',
        source_url: record.source_url,
        decision_code: record.category,
        decision_reason: record.summary,
        metadata: {
          source_type: record.source_type,
          source_id: record.source_id,
          source_event_id: record.source_event_id,
          severity: record.severity,
          category: record.category,
          status: record.status,
          recommended_action: record.recommended_action,
          evidence: row.evidence || [],
          copilot: row.copilot || null
        },
        dedupe_key: `handoff_case:${record.id}:created`
      });
    }
    return { inserted: info.changes > 0, case: found };
  },
  get(id) {
    return parseHandoffCase(db.prepare(`SELECT * FROM handoff_cases WHERE id = ?`).get(id));
  },
  getByIdempotency(idempotency_key) {
    if (!idempotency_key) return null;
    return parseHandoffCase(db.prepare(`SELECT * FROM handoff_cases WHERE idempotency_key = ?`).get(idempotency_key));
  },
  list({ lead_id, status = 'open', category, limit = 80 } = {}) {
    const clauses = [];
    const args = [];
    if (lead_id) {
      clauses.push('h.lead_id = ?');
      args.push(lead_id);
    }
    if (status && status !== 'all') {
      if (status === 'open') clauses.push(`h.status NOT IN ('resolved', 'closed')`);
      else {
        clauses.push('h.status = ?');
        args.push(normalizeCaseStatus(status));
      }
    }
    if (category) {
      clauses.push('h.category = ?');
      args.push(normalizeCaseCode(category));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return db.prepare(`
      SELECT h.*, l.business_name
      FROM handoff_cases h
      LEFT JOIN leads l ON l.id = h.lead_id
      ${where}
      ORDER BY
        CASE h.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        h.updated_at DESC
      LIMIT ?
    `).all(...args, limitFor(limit, 80, 500)).map(parseHandoffCase);
  },
  listByLead(lead_id, { status = 'all', limit = 80 } = {}) {
    return this.list({ lead_id, status, limit });
  },
  actions(case_id, { limit = 80 } = {}) {
    return db.prepare(`
      SELECT * FROM handoff_case_actions
      WHERE case_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(case_id, limitFor(limit, 80, 500)).map(parseHandoffAction);
  },
  update(id, patch = {}) {
    const existing = this.get(id);
    if (!existing) return null;
    const now = Date.now();
    const next = {
      id,
      severity: patch.severity ? normalizeSeverity(patch.severity) : existing.severity,
      category: patch.category ? normalizeCaseCode(patch.category) : existing.category,
      status: patch.status ? normalizeCaseStatus(patch.status) : existing.status,
      assigned_to: patch.assigned_to ?? patch.assignedTo ?? existing.assigned_to ?? null,
      summary: patch.summary ? cleanCaseText(patch.summary) : existing.summary,
      evidence_json: patch.evidence ? jsonText(patch.evidence) : jsonText(existing.evidence || []),
      recommended_action: patch.recommended_action || patch.recommendedAction || existing.recommended_action || null,
      copilot_json: patch.copilot ? jsonText(patch.copilot) : jsonText(existing.copilot || null),
      updated_at: now,
      resolved_at: (patch.status === 'resolved' || patch.resolved_at || patch.resolvedAt)
        ? (patch.resolved_at || patch.resolvedAt || existing.resolved_at || now)
        : (patch.status && patch.status !== 'resolved' ? null : existing.resolved_at || null)
    };
    db.prepare(`
      UPDATE handoff_cases
      SET severity = @severity,
          category = @category,
          status = @status,
          assigned_to = @assigned_to,
          summary = @summary,
          evidence_json = @evidence_json,
          recommended_action = @recommended_action,
          copilot_json = @copilot_json,
          updated_at = @updated_at,
          resolved_at = @resolved_at
      WHERE id = @id
    `).run(next);
    return this.get(id);
  },
  recordAction({ id, case_id, lead_id, action, actor = 'operator', note, payload }) {
    const actionId = id || handoffActionId(action);
    const createdAt = Date.now();
    const normalizedAction = normalizeCaseCode(action || 'note');
    db.prepare(`
      INSERT INTO handoff_case_actions (
        id, case_id, lead_id, action, actor, note, payload_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(actionId, case_id, lead_id || null, normalizedAction, actor || 'operator', note || null, jsonText(payload || null), createdAt);
    db.prepare(`UPDATE handoff_cases SET updated_at = ? WHERE id = ?`).run(createdAt, case_id);
    insertAuditEvent({
      created_at: createdAt,
      event_type: `handoff.action.${normalizedAction}`,
      lead_id,
      entity_type: 'handoff_case',
      entity_id: case_id,
      action: normalizedAction,
      worker: actor || 'operator',
      decision_code: normalizedAction,
      decision_reason: note || null,
      metadata: { actionId, payload: payload || null },
      dedupe_key: `handoff_action:${actionId}`
    });
    return this.actions(case_id).find((row) => row.id === actionId) || null;
  },
  summary() {
    const rows = db.prepare(`
      SELECT status, severity, COUNT(*) AS n
      FROM handoff_cases
      GROUP BY status, severity
    `).all();
    return {
      total: rows.reduce((sum, row) => sum + row.n, 0),
      open: rows.filter((row) => !['resolved', 'closed'].includes(row.status)).reduce((sum, row) => sum + row.n, 0),
      high: rows.filter((row) => ['critical', 'high'].includes(row.severity) && !['resolved', 'closed'].includes(row.status)).reduce((sum, row) => sum + row.n, 0),
      byStatus: Object.fromEntries(rows.map((row) => [`${row.status}:${row.severity}`, row.n]))
    };
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

export const trustLedger = {
  add(row) {
    return insertTrustLedgerEvent(row);
  },
  listByLead(lead_id, { limit = 100 } = {}) {
    const rows = db.prepare(`
      SELECT * FROM trust_ledger
      WHERE lead_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit));
    return trustRows(rows);
  },
  recent({ eventType, sinceMs = Date.now() - 24 * 3600 * 1000, limit = 100 } = {}) {
    const rows = eventType
      ? db.prepare(`
          SELECT * FROM trust_ledger
          WHERE event_type = ? AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(eventType, sinceMs, limitFor(limit))
      : db.prepare(`
          SELECT * FROM trust_ledger
          WHERE created_at >= ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(sinceMs, limitFor(limit));
    return trustRows(rows);
  },
  countSince(eventType, sinceMs) {
    return db.prepare(`
      SELECT COUNT(*) AS n FROM trust_ledger
      WHERE event_type = ? AND created_at >= ?
    `).get(eventType, sinceMs).n;
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

export const commercePlans = {
  upsert({
    id,
    lead_id,
    status = 'ready_for_truthful_site',
    type,
    intake,
    plan,
    risk_count,
    handoff_required,
    stripe_mode,
    idempotency_key
  }) {
    const now = Date.now();
    const record = {
      id,
      lead_id,
      status: status || plan?.status || 'ready_for_truthful_site',
      type: type || plan?.type || 'quote_request',
      intake_json: jsonText(intake || plan?.intake || {}),
      plan_json: jsonText(plan),
      risk_count: risk_count ?? plan?.riskFlags?.length ?? 0,
      handoff_required: handoff_required ?? (plan?.humanHandoff?.required ? 1 : 0),
      stripe_mode: stripe_mode || plan?.stripeBoundary?.mode || null,
      idempotency_key: idempotency_key || null,
      generated_at: now,
      updated_at: now
    };
    const existing = record.idempotency_key ? this.getByIdempotency(record.idempotency_key) : null;
    if (existing) {
      db.prepare(`
        UPDATE commerce_plans
        SET status = @status,
            type = @type,
            intake_json = @intake_json,
            plan_json = @plan_json,
            risk_count = @risk_count,
            handoff_required = @handoff_required,
            stripe_mode = @stripe_mode,
            updated_at = @updated_at
        WHERE id = @existing_id
      `).run({ ...record, existing_id: existing.id });
      insertAuditEvent({
        created_at: now,
        event_type: 'commerce.plan.updated',
        lead_id,
        entity_type: 'commerce_plan',
        entity_id: existing.id,
        action: 'updated',
        worker: 'commerce',
        metadata: {
          type: record.type,
          status: record.status,
          risk_count: record.risk_count,
          handoff_required: !!record.handoff_required,
          stripe_mode: record.stripe_mode
        }
      });
      return this.get(existing.id);
    }

    db.prepare(`
      INSERT INTO commerce_plans (
        id, lead_id, status, type, intake_json, plan_json, risk_count, handoff_required,
        stripe_mode, idempotency_key, generated_at, updated_at
      )
      VALUES (
        @id, @lead_id, @status, @type, @intake_json, @plan_json, @risk_count, @handoff_required,
        @stripe_mode, @idempotency_key, @generated_at, @updated_at
      )
    `).run(record);
    insertAuditEvent({
      created_at: now,
      event_type: 'commerce.plan.created',
      lead_id,
      entity_type: 'commerce_plan',
      entity_id: id,
      action: 'created',
      worker: 'commerce',
      metadata: {
        type: record.type,
        status: record.status,
        risk_count: record.risk_count,
        handoff_required: !!record.handoff_required,
        stripe_mode: record.stripe_mode
      },
      dedupe_key: `commerce_plan:${id}:created`
    });
    return this.get(id);
  },
  get(id) {
    const row = db.prepare(`SELECT * FROM commerce_plans WHERE id = ?`).get(id);
    return hydrateCommercePlan(row);
  },
  getByIdempotency(idempotency_key) {
    const row = db.prepare(`SELECT * FROM commerce_plans WHERE idempotency_key = ?`).get(idempotency_key);
    return hydrateCommercePlan(row);
  },
  getLatest(lead_id) {
    const row = db.prepare(`
      SELECT * FROM commerce_plans
      WHERE lead_id = ?
      ORDER BY generated_at DESC, updated_at DESC
      LIMIT 1
    `).get(lead_id);
    return hydrateCommercePlan(row);
  },
  listByLead(lead_id, { limit = 20 } = {}) {
    return db.prepare(`
      SELECT * FROM commerce_plans
      WHERE lead_id = ?
      ORDER BY generated_at DESC, updated_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 20, 100)).map(hydrateCommercePlan);
  },
  summary() {
    const rows = db.prepare(`SELECT type, COUNT(*) AS n FROM commerce_plans GROUP BY type`).all();
    return {
      total: db.prepare(`SELECT COUNT(*) AS n FROM commerce_plans`).get().n,
      handoff: db.prepare(`SELECT COUNT(*) AS n FROM commerce_plans WHERE handoff_required = 1`).get().n,
      paymentSetup: db.prepare(`SELECT COUNT(*) AS n FROM commerce_plans WHERE stripe_mode IN ('operator_checklist','sandbox_mock','operator_live_gate_ready')`).get().n,
      byType: Object.fromEntries(rows.map((row) => [row.type, row.n]))
    };
  }
};

export const accountManagerPlans = {
  upsert({
    id,
    lead_id,
    status = 'ready',
    plan,
    evidence,
    risk,
    idempotency_key
  }) {
    const now = Date.now();
    const record = {
      id,
      lead_id,
      status,
      plan_json: jsonText(plan),
      evidence_json: jsonText(evidence || plan?.evidence || []),
      risk_json: jsonText(risk || plan?.risk || {}),
      idempotency_key: idempotency_key || null,
      generated_at: now,
      updated_at: now
    };
    const existing = record.idempotency_key ? this.getByIdempotency(record.idempotency_key) : null;
    if (existing) {
      db.prepare(`
        UPDATE account_manager_plans
        SET status = @status,
            plan_json = @plan_json,
            evidence_json = @evidence_json,
            risk_json = @risk_json,
            updated_at = @updated_at
        WHERE id = @existing_id
      `).run({ ...record, existing_id: existing.id });
      insertAuditEvent({
        created_at: now,
        event_type: 'account_manager.plan.updated',
        lead_id,
        entity_type: 'account_manager_plan',
        entity_id: existing.id,
        action: 'updated',
        worker: 'account_manager',
        metadata: {
          task_count: Array.isArray(plan?.tasks) ? plan.tasks.length : 0,
          risk: risk || plan?.risk || {}
        }
      });
      return this.get(existing.id);
    }

    db.prepare(`
      INSERT INTO account_manager_plans (
        id, lead_id, status, plan_json, evidence_json, risk_json,
        idempotency_key, generated_at, updated_at
      )
      VALUES (
        @id, @lead_id, @status, @plan_json, @evidence_json, @risk_json,
        @idempotency_key, @generated_at, @updated_at
      )
    `).run(record);
    insertAuditEvent({
      created_at: now,
      event_type: 'account_manager.plan.created',
      lead_id,
      entity_type: 'account_manager_plan',
      entity_id: id,
      action: 'created',
      worker: 'account_manager',
      metadata: {
        task_count: Array.isArray(plan?.tasks) ? plan.tasks.length : 0,
        risk: risk || plan?.risk || {}
      },
      dedupe_key: `account_manager_plan:${id}:created`
    });
    return this.get(id);
  },
  get(id) {
    const row = db.prepare(`SELECT * FROM account_manager_plans WHERE id = ?`).get(id);
    return hydrateAccountPlan(row);
  },
  getByIdempotency(idempotency_key) {
    const row = db.prepare(`SELECT * FROM account_manager_plans WHERE idempotency_key = ?`).get(idempotency_key);
    return hydrateAccountPlan(row);
  },
  getLatest(lead_id) {
    const row = db.prepare(`
      SELECT * FROM account_manager_plans
      WHERE lead_id = ?
      ORDER BY generated_at DESC, updated_at DESC
      LIMIT 1
    `).get(lead_id);
    return hydrateAccountPlan(row);
  },
  listByLead(lead_id, { limit = 20 } = {}) {
    return db.prepare(`
      SELECT * FROM account_manager_plans
      WHERE lead_id = ?
      ORDER BY generated_at DESC, updated_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 20, 100)).map(hydrateAccountPlan);
  },
  summary() {
    return {
      total: db.prepare(`SELECT COUNT(*) AS n FROM account_manager_plans`).get().n,
      ready: db.prepare(`SELECT COUNT(*) AS n FROM account_manager_plans WHERE status = 'ready'`).get().n
    };
  }
};

export const accountTasks = {
  insertOrUpdate(row) {
    const now = Date.now();
    const record = {
      summary: null,
      status: 'pending',
      owner: 'account_manager',
      evidence_ids: [],
      preview: null,
      risk: null,
      policy: null,
      completion_notes: null,
      last_previewed_at: null,
      sent_at: null,
      completed_at: null,
      paused_until: null,
      provider_id: null,
      thread_id: null,
      created_at: now,
      ...row,
      updated_at: now
    };
    const existing = record.idempotency_key ? this.getByIdempotency(record.idempotency_key) : null;
    if (existing) {
      const terminal = ['completed', 'canceled'].includes(existing.status);
      if (!terminal) {
        db.prepare(`
          UPDATE account_tasks
          SET account_plan_id = COALESCE(@account_plan_id, account_plan_id),
              kind = @kind,
              title = @title,
              summary = @summary,
              due_at = @due_at,
              priority = @priority,
              channel = @channel,
              evidence_ids_json = @evidence_ids_json,
              owner = COALESCE(@owner, owner),
              preview_json = COALESCE(@preview_json, preview_json),
              risk_json = COALESCE(@risk_json, risk_json),
              policy_json = COALESCE(@policy_json, policy_json),
              updated_at = @updated_at
          WHERE id = @existing_id
        `).run({
          ...record,
          existing_id: existing.id,
          account_plan_id: record.account_plan_id || null,
          summary: record.summary || null,
          owner: record.owner || null,
          evidence_ids_json: jsonText(record.evidence_ids || []),
          preview_json: jsonText(record.preview),
          risk_json: jsonText(record.risk),
          policy_json: jsonText(record.policy)
        });
        addAccountTaskHistory({
          task_id: existing.id,
          lead_id: existing.lead_id,
          actor: 'account_manager',
          action: 'refreshed',
          note: 'Task refreshed from latest account-manager plan.',
          metadata: { accountPlanId: record.account_plan_id || null }
        });
      }
      return { inserted: false, row: this.get(existing.id) };
    }

    db.prepare(`
      INSERT INTO account_tasks (
        id, lead_id, account_plan_id, kind, title, summary, due_at, priority, channel, status,
        evidence_ids_json, owner, idempotency_key, preview_json, risk_json, policy_json,
        completion_notes, created_at, updated_at, last_previewed_at, sent_at, completed_at,
        paused_until, provider_id, thread_id
      )
      VALUES (
        @id, @lead_id, @account_plan_id, @kind, @title, @summary, @due_at, @priority, @channel, @status,
        @evidence_ids_json, @owner, @idempotency_key, @preview_json, @risk_json, @policy_json,
        @completion_notes, @created_at, @updated_at, @last_previewed_at, @sent_at, @completed_at,
        @paused_until, @provider_id, @thread_id
      )
    `).run({
      ...record,
      account_plan_id: record.account_plan_id || null,
      summary: record.summary || null,
      evidence_ids_json: jsonText(record.evidence_ids || []),
      owner: record.owner || null,
      idempotency_key: record.idempotency_key || null,
      preview_json: jsonText(record.preview),
      risk_json: jsonText(record.risk),
      policy_json: jsonText(record.policy),
      completion_notes: record.completion_notes || null,
      provider_id: record.provider_id || null,
      thread_id: record.thread_id || null
    });
    addAccountTaskHistory({
      task_id: record.id,
      lead_id: record.lead_id,
      actor: 'account_manager',
      action: 'created',
      note: 'Task created from account-manager plan.',
      metadata: { accountPlanId: record.account_plan_id || null, kind: record.kind }
    });
    insertAuditEvent({
      created_at: now,
      event_type: 'account_manager.task.created',
      lead_id: record.lead_id,
      entity_type: 'account_task',
      entity_id: record.id,
      action: 'created',
      worker: 'account_manager',
      decision_reason: record.summary,
      metadata: {
        kind: record.kind,
        due_at: record.due_at,
        priority: record.priority,
        channel: record.channel,
        owner: record.owner,
        evidence_ids: record.evidence_ids || []
      },
      dedupe_key: `account_task:${record.id}:created`
    });
    return { inserted: true, row: this.get(record.id) };
  },
  get(id) {
    const row = db.prepare(`SELECT * FROM account_tasks WHERE id = ?`).get(id);
    return hydrateAccountTask(row);
  },
  getByIdempotency(idempotency_key) {
    const row = db.prepare(`SELECT * FROM account_tasks WHERE idempotency_key = ?`).get(idempotency_key);
    return hydrateAccountTask(row);
  },
  listByLead(lead_id, { limit = 100, includeHistory = false } = {}) {
    const rows = db.prepare(`
      SELECT * FROM account_tasks
      WHERE lead_id = ?
      ORDER BY due_at ASC, created_at DESC
      LIMIT ?
    `).all(lead_id, limitFor(limit, 100, 500)).map(hydrateAccountTask);
    if (!includeHistory) return rows;
    return rows.map((row) => ({ ...row, history: this.history(row.id, { limit: 20 }) }));
  },
  listDue({ now = Date.now(), limit = 50, lead_id } = {}) {
    const n = limitFor(limit, 50, 200);
    if (lead_id) {
      return db.prepare(`
        SELECT * FROM account_tasks
        WHERE lead_id = ?
          AND due_at <= ?
          AND status IN ('pending', 'approved')
          AND (paused_until IS NULL OR paused_until <= ?)
        ORDER BY due_at ASC, priority ASC
        LIMIT ?
      `).all(lead_id, now, now, n).map(hydrateAccountTask);
    }
    return db.prepare(`
      SELECT * FROM account_tasks
      WHERE due_at <= ?
        AND status IN ('pending', 'approved')
        AND (paused_until IS NULL OR paused_until <= ?)
      ORDER BY due_at ASC, priority ASC
      LIMIT ?
    `).all(now, now, n).map(hydrateAccountTask);
  },
  listRecent({ limit = 50 } = {}) {
    return db.prepare(`
      SELECT * FROM account_tasks
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(limitFor(limit, 50, 200)).map(hydrateAccountTask);
  },
  history(task_id, { limit = 50 } = {}) {
    return db.prepare(`
      SELECT * FROM account_task_history
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(task_id, limitFor(limit, 50, 200)).map(hydrateAccountTaskHistory);
  },
  update(id, patch, { actor = 'operator', action = 'updated', note = null, metadata = null } = {}) {
    const existing = this.get(id);
    if (!existing) return null;
    const allowed = new Set([
      'status',
      'owner',
      'due_at',
      'priority',
      'channel',
      'preview',
      'risk',
      'policy',
      'completion_notes',
      'last_previewed_at',
      'sent_at',
      'completed_at',
      'paused_until',
      'provider_id',
      'thread_id'
    ]);
    const cols = Object.keys(patch || {}).filter((key) => allowed.has(key) && patch[key] !== undefined);
    if (!cols.length) return existing;
    const values = {
      id,
      updated_at: Date.now()
    };
    const sets = [];
    for (const col of cols) {
      if (col === 'preview') {
        sets.push('preview_json = @preview_json');
        values.preview_json = jsonText(patch.preview);
      } else if (col === 'risk') {
        sets.push('risk_json = @risk_json');
        values.risk_json = jsonText(patch.risk);
      } else if (col === 'policy') {
        sets.push('policy_json = @policy_json');
        values.policy_json = jsonText(patch.policy);
      } else {
        sets.push(`${col} = @${col}`);
        values[col] = patch[col] ?? null;
      }
    }
    sets.push('updated_at = @updated_at');
    db.prepare(`UPDATE account_tasks SET ${sets.join(', ')} WHERE id = @id`).run(values);
    const row = this.get(id);
    addAccountTaskHistory({
      task_id: id,
      lead_id: existing.lead_id,
      actor,
      action,
      note,
      metadata: {
        ...metadata,
        patch
      }
    });
    insertAuditEvent({
      created_at: values.updated_at,
      event_type: `account_manager.task.${action}`,
      lead_id: existing.lead_id,
      entity_type: 'account_task',
      entity_id: id,
      action,
      worker: actor,
      decision_reason: note,
      metadata: { patch, ...metadata }
    });
    return row;
  },
  approve(id, { actor = 'operator', note = 'Approved for proactive account-manager send.' } = {}) {
    return this.update(id, { status: 'approved' }, { actor, action: 'approved', note });
  },
  pause(id, { actor = 'operator', note = 'Paused by operator.', pausedUntil = null } = {}) {
    return this.update(id, {
      status: 'paused',
      paused_until: pausedUntil
    }, { actor, action: 'paused', note, metadata: { pausedUntil } });
  },
  complete(id, { actor = 'operator', note = 'Completed by operator.' } = {}) {
    return this.update(id, {
      status: 'completed',
      completion_notes: note,
      completed_at: Date.now()
    }, { actor, action: 'completed', note });
  },
  reassign(id, { actor = 'operator', owner = 'operator', note = null } = {}) {
    return this.update(id, { owner }, { actor, action: 'reassigned', note: note || `Reassigned to ${owner}.`, metadata: { owner } });
  },
  markPreviewed(id, { preview, policy = null, actor = 'account_manager', note = 'Preview generated.' } = {}) {
    return this.update(id, {
      preview,
      policy,
      last_previewed_at: Date.now(),
      status: undefined
    }, { actor, action: preview?.blocked ? 'blocked' : 'previewed', note, metadata: { policy } });
  },
  markSent(id, { provider_id, thread_id, preview, policy = null, actor = 'account_manager' } = {}) {
    return this.update(id, {
      status: 'sent',
      sent_at: Date.now(),
      provider_id: provider_id || null,
      thread_id: thread_id || null,
      preview,
      policy
    }, { actor, action: 'sent', note: 'Proactive account-manager message sent.', metadata: { provider_id, thread_id, policy } });
  },
  summary() {
    const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM account_tasks GROUP BY status`).all();
    return {
      total: db.prepare(`SELECT COUNT(*) AS n FROM account_tasks`).get().n,
      due: db.prepare(`SELECT COUNT(*) AS n FROM account_tasks WHERE status IN ('pending','approved') AND due_at <= ?`).get(Date.now()).n,
      byStatus: Object.fromEntries(rows.map((row) => [row.status, row.n]))
    };
  }
};

export const providerSmoke = {
  set(provider, status, detail = {}, options = {}) {
    const checkedAt = Number.isFinite(Number(options.checkedAt)) ? Number(options.checkedAt) : Date.now();
    const durationMs = optionalMs(options.durationMs ?? detail?.durationMs ?? detail?.latencyMs ?? detail?.elapsedMs);
    const safeDetail = redact(detail);
    const error = redact(providerSmokeError(status, detail, options));
    db.prepare(`
      INSERT INTO provider_smoke (provider, status, detail_json, checked_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET status = excluded.status, detail_json = excluded.detail_json, checked_at = excluded.checked_at
    `).run(provider, status, jsonText(safeDetail), checkedAt);
    insertProviderHealthEvent({ provider, status, detail: safeDetail, checkedAt, durationMs, error });
  },
  recordEvent(provider, status, detail = {}, options = {}) {
    const checkedAt = Number.isFinite(Number(options.checkedAt)) ? Number(options.checkedAt) : Date.now();
    const durationMs = optionalMs(options.durationMs ?? detail?.durationMs ?? detail?.latencyMs ?? detail?.elapsedMs);
    const safeDetail = redact(detail);
    const error = redact(providerSmokeError(status, detail, options));
    insertProviderHealthEvent({ provider, status, detail: safeDetail, checkedAt, durationMs, error });
  },
  all() {
    const rows = db.prepare(`SELECT * FROM provider_smoke ORDER BY provider`).all();
    return Object.fromEntries(rows.map((r) => [r.provider, { status: r.status, checkedAt: r.checked_at, detail: safeJson(r.detail_json) }]));
  },
  latestEvent({ provider, dryRun = null, live = null, statuses = [] } = {}) {
    if (!provider) return null;
    const where = ['provider = ?'];
    const params = [provider];
    if (dryRun !== null) {
      where.push('dry_run = ?');
      params.push(dryRun ? 1 : 0);
    }
    if (live !== null) {
      where.push('live = ?');
      params.push(live ? 1 : 0);
    }
    if (Array.isArray(statuses) && statuses.length) {
      where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      params.push(...statuses);
    }
    const row = db.prepare(`
      SELECT id, provider, status, detail_json, dry_run, live, duration_ms, error, checked_at
      FROM provider_health_events
      WHERE ${where.join(' AND ')}
      ORDER BY checked_at DESC, id DESC
      LIMIT 1
    `).get(...params);
    return row ? providerHealthEventFromRow(row) : null;
  },
  events({ provider = null, since = 0, limit = 100 } = {}) {
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
    const checkedSince = Math.max(0, Number(since) || 0);
    const params = [checkedSince];
    let where = 'checked_at >= ?';
    if (provider) {
      where += ' AND provider = ?';
      params.push(provider);
    }
    return db.prepare(`
      SELECT id, provider, status, detail_json, dry_run, live, duration_ms, error, checked_at
      FROM provider_health_events
      WHERE ${where}
      ORDER BY checked_at DESC
      LIMIT ?
    `).all(...params, cappedLimit).map(providerHealthEventFromRow);
  },
  issues({ since = 0, limit = 100 } = {}) {
    const cappedLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
    const checkedSince = Math.max(0, Number(since) || 0);
    return db.prepare(`
      SELECT id, provider, status, detail_json, dry_run, live, duration_ms, error, checked_at
      FROM provider_health_events
      WHERE checked_at >= ?
        AND (status IN ('failed', 'blocked', 'degraded') OR error IS NOT NULL)
      ORDER BY checked_at DESC
      LIMIT ?
    `).all(checkedSince, cappedLimit).map(providerHealthEventFromRow);
  },
  historySummary({ since = Date.now() - 24 * 3600 * 1000 } = {}) {
    const checkedSince = Math.max(0, Number(since) || 0);
    const rows = db.prepare(`
      SELECT provider,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
             SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
             SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded_count,
             SUM(CASE WHEN live = 1 THEN 1 ELSE 0 END) AS live_count,
             SUM(CASE WHEN dry_run = 1 THEN 1 ELSE 0 END) AS dry_run_count,
             AVG(duration_ms) AS avg_duration_ms,
             MAX(checked_at) AS last_checked_at
      FROM provider_health_events
      WHERE checked_at >= ?
      GROUP BY provider
      ORDER BY provider
    `).all(checkedSince);
    const current = this.all();
    const latestErrors = db.prepare(`
      SELECT provider, error
      FROM provider_health_events
      WHERE checked_at >= ? AND error IS NOT NULL
      ORDER BY checked_at DESC
    `).all(checkedSince);
    const errorByProvider = new Map();
    for (const row of latestErrors) {
      if (!errorByProvider.has(row.provider)) errorByProvider.set(row.provider, row.error);
    }
    return rows.map((row) => ({
      provider: row.provider,
      currentStatus: current[row.provider]?.status || null,
      total: row.total,
      okCount: row.ok_count || 0,
      failedCount: row.failed_count || 0,
      blockedCount: row.blocked_count || 0,
      degradedCount: row.degraded_count || 0,
      liveCount: row.live_count || 0,
      dryRunCount: row.dry_run_count || 0,
      avgDurationMs: row.avg_duration_ms === null || row.avg_duration_ms === undefined ? null : Math.round(row.avg_duration_ms),
      lastCheckedAt: row.last_checked_at || null,
      lastError: errorByProvider.get(row.provider) || null
    }));
  }
};

function insertProviderHealthEvent({ provider, status, detail = {}, checkedAt, durationMs = null, error = null }) {
  db.prepare(`
    INSERT INTO provider_health_events (
      id, provider, status, detail_json, dry_run, live, duration_ms, error, checked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `phealth_${checkedAt.toString(36)}_${randomBytes(4).toString('hex')}`,
    provider,
    status,
    jsonText(detail),
    detail?.dryRun === true ? 1 : 0,
    detail?.live === true ? 1 : 0,
    durationMs,
    error,
    checkedAt
  );
}

function providerHealthEventFromRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    detail: safeJson(row.detail_json) || {},
    dryRun: row.dry_run === 1,
    live: row.live === 1,
    durationMs: row.duration_ms,
    error: row.error || null,
    checkedAt: row.checked_at
  };
}

function optionalMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function providerSmokeError(status, detail = {}, options = {}) {
  const value = options.error ?? detail?.error ?? detail?.lastError;
  if (value) return value instanceof Error ? value.message : String(value);
  if (['failed', 'blocked'].includes(status) && detail?.skipped) return String(detail.skipped);
  return null;
}

export const safeToSellReports = {
  record(report = {}, { id, now = Date.now() } = {}) {
    const generatedAt = Number.isFinite(Date.parse(report.generatedAt)) ? Date.parse(report.generatedAt) : now;
    const rowId = id || `safe_${now.toString(36)}_${randomBytes(4).toString('hex')}`;
    const redactedReport = redact({
      ...report,
      decisionReceipt: {
        ...(report.decisionReceipt || {}),
        snapshotId: rowId,
        durable: true
      }
    });
    const row = {
      id: rowId,
      ok: report.ok ? 1 : 0,
      mode: report.mode || null,
      command: report.command || null,
      dry_run_count: Array.isArray(report.dryRunVerified) ? report.dryRunVerified.length : 0,
      live_smoke_count: Array.isArray(report.liveSmokeVerified) ? report.liveSmokeVerified.length : 0,
      blocker_count: Array.isArray(report.stillBlocked) ? report.stillBlocked.length : 0,
      report_json: jsonText(redactedReport) || '{}',
      generated_at: generatedAt,
      created_at: now
    };
    db.prepare(`
      INSERT INTO safe_to_sell_reports (
        id, ok, mode, command, dry_run_count, live_smoke_count, blocker_count, report_json, generated_at, created_at
      )
      VALUES (
        @id, @ok, @mode, @command, @dry_run_count, @live_smoke_count, @blocker_count, @report_json, @generated_at, @created_at
      )
    `).run(row);
    return hydrateSafeToSellReport(row);
  },
  latest() {
    return hydrateSafeToSellReport(db.prepare(`
      SELECT *
      FROM safe_to_sell_reports
      ORDER BY generated_at DESC, created_at DESC
      LIMIT 1
    `).get());
  },
  list({ since = 0, limit = 25 } = {}) {
    const checkedSince = Math.max(0, Number(since) || 0);
    const capped = limitFor(limit, 25, 200);
    return db.prepare(`
      SELECT *
      FROM safe_to_sell_reports
      WHERE generated_at >= ?
      ORDER BY generated_at DESC, created_at DESC
      LIMIT ?
    `).all(checkedSince, capped).map(hydrateSafeToSellReport);
  },
  summary({ since = Date.now() - 24 * 3600 * 1000, limit = 10 } = {}) {
    const checkedSince = Math.max(0, Number(since) || 0);
    const counts = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_count,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS blocked_count,
             MAX(generated_at) AS last_generated_at
      FROM safe_to_sell_reports
      WHERE generated_at >= ?
    `).get(checkedSince);
    return {
      total: counts?.total || 0,
      okCount: counts?.ok_count || 0,
      blockedCount: counts?.blocked_count || 0,
      lastGeneratedAt: counts?.last_generated_at || null,
      latest: this.latest(),
      recent: this.list({ since: checkedSince, limit })
    };
  }
};

function hydrateSafeToSellReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    ok: row.ok === 1,
    mode: row.mode,
    command: row.command,
    dryRunCount: row.dry_run_count,
    liveSmokeCount: row.live_smoke_count,
    blockerCount: row.blocker_count,
    generatedAt: row.generated_at,
    createdAt: row.created_at,
    report: safeJson(row.report_json) || {}
  };
}

export const webhookEvents = {
  seen(provider, event_id) {
    return !!db.prepare(`SELECT 1 FROM webhook_events WHERE provider = ? AND event_id = ?`).get(provider, event_id);
  },
  lastReceived(provider) {
    return db.prepare(`
      SELECT MAX(received_at) AS received_at
      FROM webhook_events
      WHERE provider = ?
    `).get(provider)?.received_at || null;
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

function parseHandoffCase(row) {
  if (!row) return null;
  const parsed = {
    ...row,
    evidence: safeJson(row.evidence_json) || [],
    copilot: safeJson(row.copilot_json) || null,
    actions: handoffCases.actions(row.id)
  };
  parsed.businessName = row.business_name || null;
  return parsed;
}

function parseHandoffAction(row) {
  if (!row) return null;
  return {
    ...row,
    payload: safeJson(row.payload_json) || null
  };
}

function handoffCaseId(category) {
  const safe = normalizeCaseCode(category || 'case').slice(0, 36);
  return `handoff_${safe}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function handoffActionId(action) {
  const safe = normalizeCaseCode(action || 'action').slice(0, 36);
  return `handoff_action_${safe}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function normalizeCaseCode(value) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'unknown';
}

function normalizeSeverity(value) {
  const text = normalizeCaseCode(value);
  if (['critical', 'high', 'medium', 'low'].includes(text)) return text;
  return 'medium';
}

function normalizeCaseStatus(value) {
  const text = normalizeCaseCode(value);
  if ([
    'open',
    'needs_operator',
    'operator_reply_sent',
    'paused',
    'assigned',
    'in_progress',
    'resolved',
    'closed'
  ].includes(text)) return text;
  return 'open';
}

function cleanCaseText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function hydrateJob(row) {
  if (!row) return null;
  const hydrated = {
    ...row,
    payload: safeJson(row.payload_json) || {},
    result: safeJson(row.result_json)
  };
  delete hydrated.payload_json;
  delete hydrated.result_json;
  return hydrated;
}

function jobIdFor(type) {
  const safe = String(type || 'job').replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 40);
  return `job_${safe}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function boundedJobAttempts(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.max(1, Math.min(25, Math.trunc(n)));
}

function retryDelayFor(attempts, { baseDelayMs, maxDelayMs }) {
  const n = Math.max(1, Number(attempts) || 1);
  const base = Math.max(1_000, Number(baseDelayMs) || 30_000);
  const max = Math.max(base, Number(maxDelayMs) || 15 * 60 * 1000);
  return Math.min(max, base * (2 ** Math.min(8, n - 1)));
}

function normalizeJobError(error) {
  if (!error) return null;
  if (typeof error === 'string') return error.slice(0, 4000);
  if (error instanceof Error) return `${error.name || 'Error'}: ${error.message}`.slice(0, 4000);
  try { return JSON.stringify(error).slice(0, 4000); } catch { return String(error).slice(0, 4000); }
}

function addAccountTaskHistory({ task_id, lead_id, actor = 'system', action, note = null, metadata = null }) {
  db.prepare(`
    INSERT INTO account_task_history (task_id, lead_id, created_at, actor, action, note, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(task_id, lead_id, Date.now(), actor, action, note || null, jsonText(metadata));
}

function hydrateCommercePlan(row) {
  if (!row) return null;
  return {
    ...row,
    handoff_required: Boolean(row.handoff_required),
    intake: safeJson(row.intake_json) || {},
    plan: safeJson(row.plan_json) || null
  };
}

function hydrateAccountPlan(row) {
  if (!row) return null;
  return {
    ...row,
    plan: safeJson(row.plan_json) || null,
    evidence: safeJson(row.evidence_json) || [],
    risk: safeJson(row.risk_json) || {}
  };
}

function hydrateAccountTask(row) {
  if (!row) return null;
  return {
    ...row,
    evidenceIds: safeJson(row.evidence_ids_json) || [],
    preview: safeJson(row.preview_json) || null,
    risk: safeJson(row.risk_json) || null,
    policy: safeJson(row.policy_json) || null
  };
}

function hydrateAccountTaskHistory(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: safeJson(row.metadata_json) || null
  };
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

function portalTokenId() {
  return `ptok_${Date.now().toString(36)}_${randomBytes(5).toString('hex')}`;
}

function portalTokenValue() {
  return `pt_${randomBytes(32).toString('base64url')}`;
}

function portalActionId(type = 'action') {
  const safeType = String(type || 'action').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 36);
  return `pact_${safeType}_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function stringOrNull(value, fallback = null) {
  if (value === undefined) return fallback ?? null;
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function arrayOrExisting(value, fallback = []) {
  if (value === undefined) return Array.isArray(fallback) ? fallback : [];
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return raw.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20);
}

function assetArrayOrExisting(value, fallback = []) {
  if (value === undefined) return Array.isArray(fallback) ? fallback : [];
  const raw = Array.isArray(value) ? value : [value];
  return dedupeAssets(raw);
}

function normalizeAsset(asset) {
  if (!asset) return null;
  const raw = typeof asset === 'string' ? { url: asset } : asset;
  const url = String(raw.url || raw.href || '').trim();
  if (!url) return null;
  return {
    url,
    label: String(raw.label || raw.name || 'Customer asset').trim().slice(0, 120),
    notes: String(raw.notes || raw.note || '').trim().slice(0, 500),
    addedAt: raw.addedAt || Date.now()
  };
}

function dedupeAssets(assets) {
  const seen = new Set();
  const out = [];
  for (const asset of assets.map(normalizeAsset).filter(Boolean)) {
    const key = asset.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(asset);
  }
  return out.slice(-30);
}

function revisionIdFor({ build_id, attempt }) {
  const safeBuild = String(build_id || 'build').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 54);
  return `rev_${safeBuild}_${attempt}`;
}

function hydratePortalToken(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: safeJson(row.metadata_json) || null
  };
}

function hydrateCustomerIntake(row) {
  if (!row) return null;
  return {
    leadId: row.lead_id,
    contactName: row.contact_name || '',
    contactEmail: row.contact_email || '',
    preferredPhone: row.preferred_phone || '',
    serviceArea: row.service_area || '',
    primaryGoal: row.primary_goal || '',
    brandVoice: row.brand_voice || '',
    mustHaveSections: safeJson(row.must_have_sections_json) || [],
    assetUrls: safeJson(row.asset_urls_json) || [],
    notes: row.notes || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function hydratePortalAction(row) {
  if (!row) return null;
  return {
    ...row,
    body: safeJson(row.body_json),
    metadata: safeJson(row.metadata_json)
  };
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
