import { env } from '../env.js';
import { builds, buildQaResults, buildRevisions, payments } from '../db.js';

const OWNERSHIP_PATHS = new Set([
  'lovable_transfer',
  'github_handoff',
  'managed_hosting'
]);
const PLATFORM_HOSTS = /(^|\.)(lovable\.app|vercel\.app|anything\.app)$/i;

export function normalizeReleaseEvidence(input = {}, existing = null) {
  const previous = parseJson(existing) || {};
  const merged = { ...previous, ...(input && typeof input === 'object' ? input : {}) };
  const publishedUrl = normalizeHttpsUrl(merged.publishedUrl || merged.published_url);
  const sourceRepoUrl = normalizeHttpsUrl(merged.sourceRepoUrl || merged.source_repo_url);
  const customDomain = normalizeDomain(merged.customDomain || merged.custom_domain);
  const ownershipPath = OWNERSHIP_PATHS.has(String(merged.ownershipPath || merged.ownership_path || '').trim())
    ? String(merged.ownershipPath || merged.ownership_path).trim()
    : null;
  const now = Date.now();

  return {
    schemaVersion: 1,
    publishedUrl,
    customDomain,
    sourceRepoUrl,
    ownershipPath,
    customerOwnerEmail: normalizeEmail(merged.customerOwnerEmail || merged.customer_owner_email),
    ownershipEvidence: cleanText(merged.ownershipEvidence || merged.ownership_evidence, 1200),
    securityReviewPassed: merged.securityReviewPassed === true || merged.security_review_passed === true,
    securityReviewedAt: positiveTimestamp(merged.securityReviewedAt || merged.security_reviewed_at),
    publishedUrlVerifiedAt: positiveTimestamp(merged.publishedUrlVerifiedAt || merged.published_url_verified_at),
    codeExportedAt: positiveTimestamp(merged.codeExportedAt || merged.code_exported_at),
    customerManagedHostingConsent: merged.customerManagedHostingConsent === true || merged.customer_managed_hosting_consent === true,
    domainWaiverReason: cleanText(merged.domainWaiverReason || merged.domain_waiver_reason, 500),
    operatorNote: cleanText(merged.operatorNote || merged.operator_note, 1200),
    updatedAt: positiveTimestamp(merged.updatedAt || merged.updated_at) || now
  };
}

export function buildReleaseReadiness({ buildId, build = null, evidence = null } = {}) {
  const row = build || (buildId ? builds.get(buildId) : null);
  if (!row) {
    return { ok: false, status: 'missing_build', items: [], blockers: ['build_not_found'], evidence: null };
  }
  const releaseEvidence = normalizeReleaseEvidence(evidence || {}, row.delivery_evidence_json);
  const latestQa = buildQaResults.listByBuild(row.id)[0] || null;
  const latestPayment = payments.listByLead(row.lead_id)[0] || null;
  const openRevisions = buildRevisions.listByBuild(row.id)
    .filter((revision) => !['completed', 'accepted', 'submitted', 'skipped'].includes(revision.status));
  const platformDomain = releaseEvidence.publishedUrl ? new URL(releaseEvidence.publishedUrl).hostname : null;
  const publishedHost = platformDomain?.replace(/^www\./, '') || null;
  const claimedDomain = releaseEvidence.customDomain?.replace(/^www\./, '') || null;
  const customDomainMatches = Boolean(publishedHost && claimedDomain && publishedHost === claimedDomain);
  const hasCustomDomain = Boolean(customDomainMatches && !PLATFORM_HOSTS.test(releaseEvidence.customDomain));
  const hasDomainDecision = hasCustomDomain || releaseEvidence.domainWaiverReason.length >= 20;
  const hasPortableSource = Boolean(releaseEvidence.sourceRepoUrl || releaseEvidence.codeExportedAt);
  const ownershipReady = ownershipEvidenceReady(releaseEvidence);
  const productionRuntime = env.runMode === 'production_live' && env.nodeEnv === 'production';

  const items = [
    item('production_runtime', 'Production release mode', productionRuntime, productionRuntime
      ? 'Release is being recorded from production_live.'
      : 'Switch to NODE_ENV=production and RUN_MODE=production_live before final release.'),
    item('payment_paid', 'Invoice paid', latestPayment?.status === 'paid' || Boolean(latestPayment?.paid_at), 'The customer invoice must be paid.'),
    item('qa_passed', 'Final QA passed', latestQa?.passed === true, 'The latest persisted build QA result must pass.'),
    item('operator_approved', 'Operator approved', Boolean(row.operator_approved_at), 'Internal QA approval is required.'),
    item('customer_approved', 'Customer approved', Boolean(row.customer_approved_at), 'Customer approval is required before publication handoff.'),
    item('revision_queue_clear', 'Revision queue clear', openRevisions.length === 0, openRevisions.length ? `${openRevisions.length} revision(s) remain open.` : 'No open revisions remain.'),
    item('published_https_url', 'Published HTTPS URL', Boolean(releaseEvidence.publishedUrl), releaseEvidence.publishedUrl || 'Record the final public HTTPS URL.'),
    item('published_url_verified', 'Published URL verified', Boolean(releaseEvidence.publishedUrlVerifiedAt), releaseEvidence.publishedUrlVerifiedAt
      ? `Server-side reachability verified at ${new Date(releaseEvidence.publishedUrlVerifiedAt).toISOString()}.`
      : 'The server must verify the final URL is publicly reachable before release.'),
    item('security_review', 'Lovable security review', releaseEvidence.securityReviewPassed && Boolean(releaseEvidence.securityReviewedAt), releaseEvidence.securityReviewPassed
      ? 'Security review passed and is timestamped.'
      : 'Run Lovable’s security check after the final change and record the result.'),
    item('code_portability', 'Customer-portable source', hasPortableSource, releaseEvidence.sourceRepoUrl || (releaseEvidence.codeExportedAt ? 'Code export recorded.' : 'Sync to a customer-accessible Git repository or record a code export.')),
    item('ownership_handoff', 'Ownership handoff', ownershipReady, ownershipReady
      ? `${releaseEvidence.ownershipPath} evidence recorded for ${releaseEvidence.customerOwnerEmail}.`
      : 'Record a Lovable transfer, customer Git repository handoff, or explicit managed-hosting consent with evidence.'),
    item('domain_decision', 'Customer domain decision', hasDomainDecision, hasCustomDomain
      ? `Custom domain: ${releaseEvidence.customDomain}`
      : (releaseEvidence.customDomain && !customDomainMatches)
        ? `Recorded custom domain ${releaseEvidence.customDomain} does not match published host ${platformDomain || 'unknown'}.`
        : releaseEvidence.domainWaiverReason || `A platform URL (${platformDomain || 'unknown'}) needs a documented customer waiver.`)
  ];
  const blockers = items.filter((entry) => !entry.passed).map((entry) => entry.key);

  return {
    ok: blockers.length === 0,
    status: row.launch_status === 'launched' ? 'launched' : blockers.length ? 'blocked' : 'ready',
    buildId: row.id,
    leadId: row.lead_id,
    items,
    blockers,
    evidence: releaseEvidence,
    finalUrl: row.published_url || releaseEvidence.publishedUrl || null,
    launchedAt: row.launched_at || null
  };
}

export function recordReleaseEvidence({ buildId, evidence, now = Date.now() } = {}) {
  const build = builds.get(buildId);
  if (!build) {
    const error = new Error('build not found');
    error.code = 'build_not_found';
    throw error;
  }
  const normalized = { ...normalizeReleaseEvidence(evidence, build.delivery_evidence_json), updatedAt: Date.now() };
  builds.update(buildId, {
    delivery_evidence_json: JSON.stringify(normalized),
    published_url: normalized.publishedUrl,
    custom_domain: normalized.customDomain,
    source_repo_url: normalized.sourceRepoUrl,
    ownership_status: normalized.ownershipPath,
    security_reviewed_at: normalized.securityReviewPassed ? normalized.securityReviewedAt : null
  });
  const readiness = buildReleaseReadiness({ buildId, evidence: normalized });
  if (!readiness.ok) return { released: false, readiness };

  builds.update(buildId, {
    launch_status: 'launched',
    launched_at: now,
    handoff_completed_at: now,
    published_url: normalized.publishedUrl
  });
  return {
    released: true,
    readiness: buildReleaseReadiness({ buildId }),
    build: builds.get(buildId)
  };
}

function ownershipEvidenceReady(evidence) {
  if (!evidence.ownershipPath || !evidence.customerOwnerEmail || evidence.ownershipEvidence.length < 12) return false;
  if (evidence.ownershipPath === 'lovable_transfer') return true;
  if (evidence.ownershipPath === 'github_handoff') return Boolean(evidence.sourceRepoUrl);
  if (evidence.ownershipPath === 'managed_hosting') {
    return evidence.customerManagedHostingConsent && Boolean(evidence.sourceRepoUrl || evidence.codeExportedAt);
  }
  return false;
}

function item(key, label, passed, detail) {
  return { key, label, passed: Boolean(passed), severity: 'release_gate', detail };
}

function normalizeHttpsUrl(value) {
  const text = cleanText(value, 1200);
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  return url.href;
}

function normalizeDomain(value) {
  const text = cleanText(value, 253).toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '');
  if (!text || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(text)) return null;
  return text;
}

function normalizeEmail(value) {
  const text = cleanText(value, 320).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : null;
}

function positiveTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 5 * 60 * 1000 ? Math.trunc(timestamp) : null;
}

function cleanText(value, max = 500) {
  return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}
