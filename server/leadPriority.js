import { db, leads } from './db.js';
import { emit } from './sse.js';
import { log } from './logger.js';
import { presenceScoreFor } from './presenceScorer.js';

// Lead prioritization: order outreach by expected revenue, not arrival time.
//
// priority_score = 0.5 * (1 - presence/100)
//                + 0.3 * nicheWinRate
//                + 0.1 * recencyBoost
//                + 0.1 * phoneClassMultiplier
//
// All component values are clamped to [0, 1] so the resulting score is also [0, 1].

const QUEUEABLE_STATES = ['queued', 'not_queued', 'retry'];
const PHONE_CLASS_PREFERRED = new Set(['business_landline', 'owned']);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const WIN_RATE_CACHE_TTL_MS = 5 * 60 * 1000;

const winRateCache = {
  sinceMs: null,
  expiresAt: 0,
  map: null
};

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeProfile(lead) {
  if (!lead) return {};
  const raw = lead.research_json;
  if (!raw) return {};
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function presenceFor({ lead, profile }) {
  const merged = {
    ...(profile || {}),
    onlinePresenceStrength: profile?.onlinePresenceStrength || lead?.online_presence_strength || null,
    onlinePresenceConfidence: profile?.onlinePresenceConfidence
      ?? profile?.presenceConfidence
      ?? lead?.presence_confidence
      ?? null,
    websiteUrl: profile?.websiteUrl || lead?.website || null,
    sourceUrl: profile?.sourceUrl || lead?.source_url || null,
    yelpUrl: profile?.yelpUrl || null
  };
  try {
    return presenceScoreFor(merged);
  } catch (err) {
    log.warn?.('leadPriority.presence_score_failed', { leadId: lead?.id, error: err?.message });
    return 50;
  }
}

function recencyBoost(createdAt, now = Date.now()) {
  if (!createdAt) return 0.2;
  const age = now - Number(createdAt);
  if (!Number.isFinite(age) || age < 0) return 1.0;
  if (age < ONE_DAY_MS) return 1.0;
  if (age < ONE_WEEK_MS) return 0.6;
  return 0.2;
}

function phoneClassMultiplier(phoneClassification) {
  if (typeof phoneClassification !== 'string') return 0.5;
  return PHONE_CLASS_PREFERRED.has(phoneClassification.toLowerCase()) ? 1 : 0.5;
}

export function scoreLead({ lead, profile, nicheWinRate } = {}) {
  if (!lead) return 0;
  const effectiveProfile = profile || safeProfile(lead);
  const presence = presenceFor({ lead, profile: effectiveProfile });
  // LOWER presence number = worse online presence = more callable, so invert.
  const presenceComponent = 1 - clamp01(presence / 100);
  const winRateComponent = clamp01(typeof nicheWinRate === 'number' ? nicheWinRate : 0);
  const recencyComponent = clamp01(recencyBoost(lead.created_at));
  const phoneComponent = clamp01(phoneClassMultiplier(lead.phone_classification));

  const score = (
    0.5 * presenceComponent +
    0.3 * winRateComponent +
    0.1 * recencyComponent +
    0.1 * phoneComponent
  );
  return Math.round(clamp01(score) * 1000) / 1000;
}

export function nicheWinRateMap({ sinceMs = null } = {}) {
  const now = Date.now();
  const cacheKey = sinceMs ?? 'all';
  if (
    winRateCache.map &&
    winRateCache.sinceMs === cacheKey &&
    winRateCache.expiresAt > now
  ) {
    return winRateCache.map;
  }

  let rows = [];
  try {
    const params = [];
    let paidPredicate = "p.status = 'paid'";
    if (sinceMs) {
      paidPredicate += ' AND COALESCE(p.paid_at, p.created_at) >= ?';
      params.push(Number(sinceMs));
    }
    rows = db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(l.niche), ''), 'unknown') AS niche,
             COUNT(DISTINCT l.id) AS lead_count,
             COUNT(DISTINCT CASE WHEN ${paidPredicate} THEN l.id END) AS paid_count
      FROM leads l
      LEFT JOIN payments p ON p.lead_id = l.id
      GROUP BY COALESCE(NULLIF(TRIM(l.niche), ''), 'unknown')
    `).all(...params);
  } catch (err) {
    log.warn?.('leadPriority.win_rate_query_failed', { error: err?.message });
    rows = [];
  }

  const totalPaid = rows.reduce((sum, row) => sum + (row.paid_count || 0), 0);
  const map = Object.create(null);
  if (totalPaid > 0) {
    for (const row of rows) {
      const niche = row.niche || 'unknown';
      const leadCount = Number(row.lead_count) || 0;
      const paidCount = Number(row.paid_count) || 0;
      if (leadCount <= 0) continue;
      map[niche] = clamp01(paidCount / leadCount);
    }
  }

  winRateCache.map = map;
  winRateCache.sinceMs = cacheKey;
  winRateCache.expiresAt = now + WIN_RATE_CACHE_TTL_MS;
  return map;
}

export function clearNicheWinRateCache() {
  winRateCache.map = null;
  winRateCache.sinceMs = null;
  winRateCache.expiresAt = 0;
}

function winRateForLead(lead, winRates) {
  if (!lead || !winRates) return 0;
  const niche = lead.niche && String(lead.niche).trim() ? String(lead.niche).trim() : 'unknown';
  return clamp01(winRates[niche] ?? 0);
}

export function refreshAllPriorityScores({ sinceMs = null } = {}) {
  const winRates = nicheWinRateMap({ sinceMs });
  const placeholders = QUEUEABLE_STATES.map(() => '?').join(', ');
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT * FROM leads
      WHERE outreach_status IN (${placeholders})
    `).all(...QUEUEABLE_STATES);
  } catch (err) {
    log.warn?.('leadPriority.refresh_query_failed', { error: err?.message });
    rows = [];
  }

  const update = db.prepare('UPDATE leads SET priority_score = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  const updates = [];
  const tx = db.transaction((items) => {
    for (const item of items) update.run(item.score, now, item.id);
  });

  for (const lead of rows) {
    const profile = safeProfile(lead);
    const nicheWinRate = winRateForLead(lead, winRates);
    const score = scoreLead({ lead, profile, nicheWinRate });
    updates.push({ id: lead.id, score });
  }

  if (updates.length) {
    try {
      tx(updates);
    } catch (err) {
      log.warn?.('leadPriority.refresh_tx_failed', { error: err?.message });
    }
  }

  emit('leads.priorities_refreshed', {
    updated: updates.length,
    niches: Object.keys(winRates).length,
    sinceMs: sinceMs ?? null
  });

  return { updated: updates.length, winRates };
}

export function applyPriorityToLead(leadId) {
  if (!leadId) return null;
  const lead = leads.get(leadId);
  if (!lead) return null;
  const profile = safeProfile(lead);
  const winRates = nicheWinRateMap({});
  const nicheWinRate = winRateForLead(lead, winRates);
  const score = scoreLead({ lead, profile, nicheWinRate });
  try {
    db.prepare('UPDATE leads SET priority_score = ?, updated_at = ? WHERE id = ?')
      .run(score, Date.now(), leadId);
  } catch (err) {
    log.warn?.('leadPriority.apply_failed', { leadId, error: err?.message });
    return null;
  }
  return score;
}

export function priorityBreakdownForLead(lead, winRates) {
  if (!lead) return null;
  const profile = safeProfile(lead);
  const presence = presenceFor({ lead, profile });
  const winRate = winRateForLead(lead, winRates || nicheWinRateMap({}));
  const recency = recencyBoost(lead.created_at);
  const phoneMul = phoneClassMultiplier(lead.phone_classification);
  const presenceComponent = 1 - clamp01(presence / 100);
  const total = clamp01(
    0.5 * presenceComponent +
    0.3 * clamp01(winRate) +
    0.1 * clamp01(recency) +
    0.1 * clamp01(phoneMul)
  );
  return {
    leadId: lead.id,
    businessName: lead.business_name,
    niche: lead.niche || 'unknown',
    priorityScore: lead.priority_score ?? Math.round(total * 1000) / 1000,
    presence,
    winRate,
    recencyBoost: recency,
    phoneClassMultiplier: phoneMul,
    phoneClassification: lead.phone_classification || null,
    components: {
      presence: 0.5 * presenceComponent,
      winRate: 0.3 * clamp01(winRate),
      recency: 0.1 * clamp01(recency),
      phoneClass: 0.1 * clamp01(phoneMul)
    }
  };
}

export function topPriorityLeads({ limit = 30 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
  const placeholders = QUEUEABLE_STATES.map(() => '?').join(', ');
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT * FROM leads
      WHERE outreach_status IN (${placeholders})
      ORDER BY priority_score DESC NULLS LAST, created_at ASC
      LIMIT ?
    `).all(...QUEUEABLE_STATES, safeLimit);
  } catch (err) {
    log.warn?.('leadPriority.top_query_failed', { error: err?.message });
    rows = [];
  }
  const winRates = nicheWinRateMap({});
  return rows.map((lead) => priorityBreakdownForLead(lead, winRates));
}
