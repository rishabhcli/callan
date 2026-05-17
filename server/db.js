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
    payment_link_url TEXT,
    hosted_invoice_url TEXT,
    amount_cents INTEGER,
    status TEXT NOT NULL,
    due_at INTEGER,
    idempotency_key TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
  CREATE INDEX IF NOT EXISTS idx_lead_history_lead ON lead_history(lead_id);
  CREATE INDEX IF NOT EXISTS idx_runs_lead ON worker_runs(lead_id);
  CREATE INDEX IF NOT EXISTS idx_calls_lead_started ON calls(lead_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_payments_lead_created ON payments(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_builds_lead_started ON builds(lead_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_contact_events_lead ON contact_events(lead_id);
  CREATE INDEX IF NOT EXISTS idx_contact_events_thread ON contact_events(thread_id);
  CREATE INDEX IF NOT EXISTS idx_contact_events_lead_created ON contact_events(lead_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_call_attempts_phone ON call_attempts(phone);
  CREATE INDEX IF NOT EXISTS idx_call_attempts_lead_created ON call_attempts(lead_id, created_at);

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
ensureColumn('payments', 'hosted_invoice_url', 'TEXT');
ensureColumn('payments', 'due_at', 'INTEGER');
ensureColumn('payments', 'idempotency_key', 'TEXT');
ensureColumn('payments', 'build_triggered_at', 'INTEGER');
ensureColumn('builds', 'lovable_url', 'TEXT');
ensureColumn('builds', 'brief', 'TEXT');
ensureColumn('builds', 'error', 'TEXT');
ensureColumn('builds', 'trigger_key', 'TEXT');
ensureColumn('builds', 'updated_at', 'INTEGER');
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
      payment_link_url: null,
      hosted_invoice_url: null,
      amount_cents: null,
      due_at: null,
      idempotency_key: null,
      build_triggered_at: null,
      ...row
    };
    db.prepare(`
      INSERT INTO payments (
        id, lead_id, stripe_session_id, stripe_invoice_id, stripe_customer_id, payment_link_url,
        hosted_invoice_url, amount_cents, status, due_at, idempotency_key, created_at, build_triggered_at
      )
      VALUES (
        @id, @lead_id, @stripe_session_id, @stripe_invoice_id, @stripe_customer_id, @payment_link_url,
        @hosted_invoice_url, @amount_cents, @status, @due_at, @idempotency_key, @created_at, @build_triggered_at
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
        payment_link_url: record.payment_link_url,
        hosted_invoice_url: record.hosted_invoice_url
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
      payment_link_url: null,
      hosted_invoice_url: null,
      amount_cents: null,
      due_at: null,
      build_triggered_at: null,
      ...row
    };
    const info = db.prepare(`
      INSERT OR IGNORE INTO payments (
        id, lead_id, stripe_session_id, stripe_invoice_id, stripe_customer_id, payment_link_url,
        hosted_invoice_url, amount_cents, status, due_at, idempotency_key, created_at, build_triggered_at
      )
      VALUES (
        @id, @lead_id, @stripe_session_id, @stripe_invoice_id, @stripe_customer_id, @payment_link_url,
        @hosted_invoice_url, @amount_cents, @status, @due_at, @idempotency_key, @created_at, @build_triggered_at
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
          payment_link_url: record.payment_link_url,
          hosted_invoice_url: record.hosted_invoice_url
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
          id, lead_id, stripe_session_id, stripe_invoice_id, stripe_customer_id, payment_link_url,
          hosted_invoice_url, amount_cents, status, due_at, idempotency_key, created_at, paid_at, build_triggered_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, NULL)
      `).run(
        details.id || paymentIdForStripe(stripe_id),
        details.lead_id,
        details.stripe_session_id || stripe_id,
        details.stripe_invoice_id || stripe_id,
        details.stripe_customer_id || null,
        details.payment_link_url || null,
        details.hosted_invoice_url || null,
        details.amount_cents || null,
        details.due_at || null,
        details.idempotency_key || null,
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
        hosted_invoice_url = COALESCE(hosted_invoice_url, ?),
        payment_link_url = COALESCE(payment_link_url, ?),
        amount_cents = COALESCE(amount_cents, ?)
      WHERE id = ? AND status != 'paid'
    `).run(
      paidAt,
      details.stripe_session_id || null,
      details.stripe_invoice_id || null,
      details.stripe_customer_id || null,
      details.hosted_invoice_url || null,
      details.payment_link_url || null,
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

export { db };
