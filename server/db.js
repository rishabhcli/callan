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
    payment_link_url TEXT,
    amount_cents INTEGER,
    status TEXT NOT NULL,
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

  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id);
  CREATE INDEX IF NOT EXISTS idx_runs_lead ON worker_runs(lead_id);
`);

export const leads = {
  insert(row) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO leads (id, container_tag, business_name, phone, address, niche, city, website, status, created_at, updated_at)
      VALUES (@id, @container_tag, @business_name, @phone, @address, @niche, @city, @website, @status, @created_at, @updated_at)
    `).run({ created_at: now, updated_at: now, status: 'discovered', ...row });
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
  start({ id, lead_id, to_phone, provider_call_id }) {
    db.prepare(`
      INSERT INTO calls (id, lead_id, provider_call_id, to_phone, state, started_at) VALUES (?, ?, ?, ?, 'in_progress', ?)
    `).run(id, lead_id, provider_call_id || null, to_phone || null, Date.now());
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
      INSERT INTO payments (id, lead_id, stripe_session_id, payment_link_url, amount_cents, status, created_at)
      VALUES (@id, @lead_id, @stripe_session_id, @payment_link_url, @amount_cents, @status, @created_at)
    `).run({ created_at: Date.now(), status: 'created', stripe_session_id: null, ...row });
  },
  markPaid(stripe_session_id) {
    db.prepare(`UPDATE payments SET status = 'paid', paid_at = ? WHERE stripe_session_id = ?`).run(Date.now(), stripe_session_id);
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

export { db };
