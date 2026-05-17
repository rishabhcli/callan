import Database from 'better-sqlite3';
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

  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
  CREATE INDEX IF NOT EXISTS idx_runs_lead ON worker_runs(lead_id);
  CREATE INDEX IF NOT EXISTS idx_contact_events_lead ON contact_events(lead_id);
  CREATE INDEX IF NOT EXISTS idx_contact_events_thread ON contact_events(thread_id);
  CREATE INDEX IF NOT EXISTS idx_call_attempts_phone ON call_attempts(phone);
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
ensureColumn('calls', 'disclosure_text', 'TEXT');
ensureColumn('calls', 'decision_reason', 'TEXT');
ensureColumn('payments', 'stripe_invoice_id', 'TEXT');
ensureColumn('payments', 'stripe_customer_id', 'TEXT');
ensureColumn('payments', 'hosted_invoice_url', 'TEXT');
ensureColumn('payments', 'due_at', 'INTEGER');
ensureColumn('payments', 'idempotency_key', 'TEXT');

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export const leads = {
  insert(row) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO leads (
        id, container_tag, business_name, phone, address, niche, city, website, status,
        research_status, outreach_status, risk_status, consent_status, phone_classification,
        last_contacted_at, next_action, source_url, agentmail_thread_id, created_at, updated_at
      )
      VALUES (
        @id, @container_tag, @business_name, @phone, @address, @niche, @city, @website, @status,
        @research_status, @outreach_status, @risk_status, @consent_status, @phone_classification,
        @last_contacted_at, @next_action, @source_url, @agentmail_thread_id, @created_at, @updated_at
      )
    `).run({
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
      ...row
    });
  },
  update(id, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE leads SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({ ...patch, id, updated_at: Date.now() });
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
  listOutreachQueue({ limit = 10 } = {}) {
    return db.prepare(`
      SELECT * FROM leads
      WHERE outreach_status IN ('queued', 'retry')
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
    db.prepare(`
      INSERT INTO worker_runs (id, lead_id, worker, state, started_at) VALUES (?, ?, ?, 'running', ?)
    `).run(id, lead_id || null, worker, Date.now());
  },
  finish(id, { state, error, detail }) {
    db.prepare(`UPDATE worker_runs SET state = ?, finished_at = ?, error = ?, detail_json = ? WHERE id = ?`).run(
      state,
      Date.now(),
      error || null,
      detail ? JSON.stringify(detail) : null,
      id
    );
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
    db.prepare(`INSERT INTO events (ts, type, lead_id, worker, payload_json) VALUES (?, ?, ?, ?, ?)`).run(
      Date.now(),
      type,
      lead_id || null,
      worker || null,
      payload ? JSON.stringify(payload) : null
    );
  },
  list({ since = 0, limit = 200 } = {}) {
    return db.prepare(`SELECT * FROM events WHERE ts > ? ORDER BY ts ASC LIMIT ?`).all(since, limit);
  }
};

export const calls = {
  start({ id, lead_id, to_phone, provider_call_id, disclosure_text, decision_reason }) {
    db.prepare(`
      INSERT INTO calls (id, lead_id, provider_call_id, to_phone, disclosure_text, decision_reason, state, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?)
    `).run(id, lead_id, provider_call_id || null, to_phone || null, disclosure_text || null, decision_reason || null, Date.now());
  },
  finish(id, { outcome, transcript }) {
    db.prepare(`UPDATE calls SET state = 'ended', outcome = ?, transcript_json = ?, ended_at = ? WHERE id = ?`).run(
      outcome || null,
      transcript ? JSON.stringify(transcript) : null,
      Date.now(),
      id
    );
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
    db.prepare(`
      INSERT INTO payments (
        id, lead_id, stripe_session_id, stripe_invoice_id, stripe_customer_id, payment_link_url,
        hosted_invoice_url, amount_cents, status, due_at, idempotency_key, created_at
      )
      VALUES (
        @id, @lead_id, @stripe_session_id, @stripe_invoice_id, @stripe_customer_id, @payment_link_url,
        @hosted_invoice_url, @amount_cents, @status, @due_at, @idempotency_key, @created_at
      )
    `).run({
      created_at: Date.now(),
      status: 'created',
      stripe_session_id: null,
      stripe_invoice_id: null,
      stripe_customer_id: null,
      hosted_invoice_url: null,
      due_at: null,
      idempotency_key: null,
      ...row
    });
  },
  getByInvoice(stripe_invoice_id) {
    return db.prepare(`SELECT * FROM payments WHERE stripe_invoice_id = ? OR stripe_session_id = ?`).get(stripe_invoice_id, stripe_invoice_id);
  },
  getByIdempotency(idempotency_key) {
    return db.prepare(`SELECT * FROM payments WHERE idempotency_key = ?`).get(idempotency_key);
  },
  markPaid(stripe_id) {
    const existing = this.getByInvoice(stripe_id);
    if (!existing) return { changed: false, row: null };
    if (existing.status === 'paid') return { changed: false, row: existing };
    db.prepare(`
      UPDATE payments
      SET status = 'paid', paid_at = ?
      WHERE id = ? AND status != 'paid'
    `).run(Date.now(), existing.id);
    return { changed: true, row: this.getByInvoice(stripe_id) };
  },
  listByLead(lead_id) {
    return db.prepare(`SELECT * FROM payments WHERE lead_id = ? ORDER BY created_at DESC`).all(lead_id);
  }
};

export const builds = {
  start({ id, lead_id, browser_session_id, live_url }) {
    db.prepare(`
      INSERT INTO builds (id, lead_id, browser_session_id, live_url, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)
    `).run(id, lead_id, browser_session_id || null, live_url || null, Date.now());
  },
  update(id, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const sets = cols.map((c) => `${c} = @${c}`).join(', ');
    db.prepare(`UPDATE builds SET ${sets} WHERE id = @id`).run({ ...patch, id });
  },
  listByLead(lead_id) {
    return db.prepare(`SELECT * FROM builds WHERE lead_id = ? ORDER BY started_at DESC`).all(lead_id);
  }
};

export const doNotCall = {
  add({ phone, reason = 'opt-out', source = 'system' }) {
    db.prepare(`
      INSERT INTO do_not_call (phone, reason, source, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, source = excluded.source
    `).run(phone, reason, source, Date.now());
  },
  has(phone) {
    return !!db.prepare(`SELECT phone FROM do_not_call WHERE phone = ?`).get(phone);
  },
  count() {
    return db.prepare(`SELECT COUNT(*) AS n FROM do_not_call`).get().n;
  }
};

export const callAttempts = {
  add({ id, lead_id, phone, allowed, reason, disclosure_text }) {
    const attemptId = id || `attempt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO call_attempts (id, lead_id, phone, allowed, reason, disclosure_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(attemptId, lead_id || null, phone, allowed ? 1 : 0, reason, disclosure_text || null, Date.now());
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
      Date.now()
    );
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
    db.prepare(`
      INSERT OR IGNORE INTO webhook_events (provider, event_id, type, received_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(provider, event_id, type || null, Date.now(), payload ? JSON.stringify(payload) : null);
  }
};

function safeJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export { db };
