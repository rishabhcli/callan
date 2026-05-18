// Referral loop: every Lovable-built site embeds a "Built by callmemaybe"
// footer link that redirects new visitors back into our funnel. This module
// owns the URL/footer text construction, the click-recording helper, and the
// roll-up query that powers the operator dashboard.
import { createHash, randomBytes } from 'node:crypto';
import { env } from './env.js';
import { leads, referralClicks, db } from './db.js';

/**
 * Compose the verbatim footer line that Lovable should render at the bottom
 * of every shipped site. The link routes through our own `/r/:leadId` route so
 * we can log the click before redirecting the visitor to the landing page.
 *
 * @param {string} leadId  The source lead the new visitor came from.
 * @param {string} [publicUrl] Override of `env.publicUrl` (used in tests).
 */
export function buildReferralFooterText(leadId, publicUrl = env.publicUrl) {
  const safeLeadId = sanitizeLeadId(leadId);
  const base = (publicUrl || 'http://localhost:8787').replace(/\/+$/, '');
  return `Built by callmemaybe — get yours: ${base}/r/${safeLeadId}?utm_source=referral&utm_medium=footer&utm_campaign=site_built`;
}

/**
 * Record a single referral click. Defensive: tolerates a missing/blank lead
 * id (so /r/ with no segment doesn't 500) and a missing IP/user-agent. The IP
 * is SHA-256 hashed and truncated to 16 hex chars so we keep cardinality for
 * fraud/uniqueness checks without retaining raw IPs.
 */
export function recordReferralClick(req, leadId) {
  const id = `ref_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const sanitizedLeadId = sanitizeLeadId(leadId) || null;
  const query = req?.query || {};
  const headers = req?.headers || {};
  const ip = req?.ip || '';
  const ipHash = createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);

  // Foreign key into leads(id) is ON DELETE SET NULL — but the constraint
  // still rejects an INSERT that names a non-existent lead. Verify the lead
  // exists; if not, persist the click anonymously so we don't lose the signal
  // (and so a referral link that points at a deleted lead can't 500 the route).
  let sourceLeadId = sanitizedLeadId;
  if (sourceLeadId) {
    try {
      if (!leads.get(sourceLeadId)) sourceLeadId = null;
    } catch {
      sourceLeadId = null;
    }
  }

  const row = {
    id,
    source_lead_id: sourceLeadId,
    utm_source: cleanText(query.utm_source) || null,
    utm_medium: cleanText(query.utm_medium) || null,
    utm_campaign: cleanText(query.utm_campaign) || null,
    referrer: cleanText(headers.referer || headers.referrer) || null,
    user_agent: cleanText(headers['user-agent']) || null,
    ip_hash: ipHash,
    landed_path: sanitizedLeadId ? `/r/${sanitizedLeadId}` : '/r/'
  };

  referralClicks.record(row);
  return row;
}

/**
 * Top-N referring leads with lead joins so the operator UI can show
 * `business_name` and `niche` next to each row instead of bare IDs. Defensive:
 * returns `[]` if the table is empty or anything throws.
 */
export function referralRollup({ limit = 30 } = {}) {
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.min(Math.trunc(Number(limit)), 200)
    : 30;
  try {
    const rows = db.prepare(`
      SELECT
        rc.source_lead_id AS source_lead_id,
        COUNT(*)          AS clicks,
        MAX(rc.created_at) AS last_at,
        l.business_name   AS business_name,
        l.niche           AS niche,
        l.city            AS city
      FROM referral_clicks rc
      LEFT JOIN leads l ON l.id = rc.source_lead_id
      GROUP BY rc.source_lead_id
      ORDER BY clicks DESC, last_at DESC
      LIMIT ?
    `).all(safeLimit);
    return rows.map((row) => ({
      source_lead_id: row.source_lead_id,
      business_name: row.business_name || null,
      niche: row.niche || null,
      city: row.city || null,
      clicks: Number(row.clicks) || 0,
      last_at: row.last_at || null
    }));
  } catch {
    return [];
  }
}

/**
 * Total click count for the /api/health blob. Defensive: any failure returns 0
 * so health remains useful even if the referral table is missing.
 */
export function totalReferralClicks() {
  try { return referralClicks.countAll() || 0; } catch { return 0; }
}

function sanitizeLeadId(leadId) {
  if (leadId === null || leadId === undefined) return '';
  const text = String(leadId).trim();
  // Allow URL-safe lead ids only. Block anything that would let an attacker
  // smuggle path traversal or query-string injection into the footer link.
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : encodeURIComponent(text);
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return text.length > 1024 ? text.slice(0, 1024) : text;
}
