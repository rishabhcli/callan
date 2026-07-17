#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'callan-release-check-'));
Object.assign(process.env, {
  NODE_ENV: 'production',
  RUN_MODE: 'production_live',
  DATA_DIR: dataDir,
  APP_PUBLIC_URL: 'https://ops.callan.example',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BROWSER_SESSIONS: 'false',
  LIVE_PUBLIC_OUTREACH: 'false',
  LIVE_BUILDS: 'false',
  ADMIN_API_TOKEN: 'release-check-admin-token-0123456789'
});

try {
  const { leads, payments, builds, buildQaResults } = await import('../server/db.js');
  const { buildReleaseReadiness, recordReleaseEvidence } = await import('../server/fulfillment/release.js');
  const now = Date.now();
  const leadId = `lead_release_${now.toString(36)}`;
  const buildId = `build_release_${now.toString(36)}`;

  leads.insert({
    id: leadId,
    container_tag: `biz_${leadId}`,
    business_name: 'Release Proof Electric',
    phone: '+14155550177',
    address: '177 Broadway, Oakland, CA',
    niche: 'electrician',
    city: 'Oakland',
    website: null,
    status: 'awaiting_launch_approval',
    research_status: 'complete',
    outreach_status: 'called',
    risk_status: 'callable',
    consent_status: 'operator_approved',
    phone_classification: 'business',
    next_action: 'operator_release_handoff',
    source_url: 'https://example.com/release-proof',
    research_json: JSON.stringify({ businessName: 'Release Proof Electric', city: 'Oakland', niche: 'electrician' })
  });
  payments.insertOrGetByIdempotency({
    id: `payment_${leadId}`,
    lead_id: leadId,
    stripe_invoice_id: `invoice_${leadId}`,
    stripe_session_id: `invoice_${leadId}`,
    customer_email: 'owner@release-proof.example',
    amount_cents: 50000,
    status: 'paid',
    paid_at: now,
    idempotency_key: `release-check:${leadId}`
  });
  builds.start({ id: buildId, lead_id: leadId, browser_session_id: 'operator-only-session', live_url: 'https://browser-use.example/session', brief: 'Release proof site.' });
  builds.update(buildId, {
    status: 'completed',
    project_url: 'https://preview--release-proof.lovable.app',
    launch_status: 'customer_approved',
    operator_approved_at: now,
    customer_approved_at: now,
    finished_at: now
  });
  buildQaResults.upsert({
    build_id: buildId,
    lead_id: leadId,
    attempt: 0,
    provider: 'release-check',
    url: 'https://preview--release-proof.lovable.app',
    status: 'passed',
    passed: true,
    score: 100,
    checklist: [{ key: 'release-proof', label: 'Release proof', passed: true }],
    errors: [],
    claims: {}
  });

  const before = buildReleaseReadiness({ buildId });
  assert.equal(before.ok, false);
  assert.ok(before.blockers.includes('published_https_url'));
  assert.ok(before.blockers.includes('ownership_handoff'));

  const mismatched = recordReleaseEvidence({
    buildId,
    evidence: {
      publishedUrl: 'https://www.release-proof.example',
      publishedUrlVerifiedAt: now,
      customDomain: 'wrong-domain.example',
      sourceRepoUrl: 'https://github.com/release-proof/site',
      ownershipPath: 'github_handoff',
      customerOwnerEmail: 'owner@release-proof.example',
      ownershipEvidence: 'Customer accepted the repository invitation.',
      securityReviewPassed: true,
      securityReviewedAt: now,
      codeExportedAt: now
    }
  });
  assert.equal(mismatched.released, false);
  assert.ok(mismatched.readiness.blockers.includes('domain_decision'));

  const released = recordReleaseEvidence({
    buildId,
    evidence: {
      customDomain: 'www.release-proof.example',
      operatorNote: 'Final release evidence verified by the operator.'
    }
  });
  assert.equal(released.released, true);
  assert.equal(released.build.launch_status, 'launched');
  assert.equal(released.build.published_url, 'https://www.release-proof.example/');
  assert.ok(released.build.handoff_completed_at);
  assert.equal(released.readiness.ok, true);

  console.log(JSON.stringify({
    ok: true,
    buildId,
    finalUrl: released.readiness.finalUrl,
    gates: released.readiness.items.length,
    checks: ['payment', 'QA', 'approvals', 'reachability evidence', 'security', 'source portability', 'ownership', 'domain match']
  }, null, 2));
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
