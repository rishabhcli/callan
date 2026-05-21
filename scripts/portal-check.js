#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'callan-portal-check-'));
Object.assign(process.env, {
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BROWSER_SESSIONS: 'false',
  LIVE_BUILDS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false',
  GEMINI_API_KEY: '',
  SUPERMEMORY_API_KEY: '',
  AGENTPHONE_API_KEY: '',
  AGENTMAIL_API_KEY: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: ''
});

try {
  const dbApi = await import('../server/db.js');
  const portal = await import('../server/customerPortal.js');

  const {
    leads,
    payments,
    builds,
    buildQaResults,
    buildRevisions,
    contactEvents,
    customerIntake,
    portalActions,
    portalTokens
  } = dbApi;

  const leadId = `lead_portal_${Date.now().toString(36)}`;
  const now = Date.now();
  leads.insert({
    id: leadId,
    container_tag: `biz_${leadId}`,
    business_name: 'Portal Proof Plumbing',
    phone: '+14155550199',
    address: '99 Market St, San Francisco, CA',
    niche: 'plumber',
    city: 'San Francisco',
    website: null,
    status: 'awaiting_payment',
    research_status: 'complete',
    outreach_status: 'queued',
    risk_status: 'callable',
    consent_status: 'operator_demo',
    phone_classification: 'business',
    next_action: 'send_invoice',
    source_url: 'https://example.test/portal-proof',
    research_json: JSON.stringify({
      businessName: 'Portal Proof Plumbing',
      bestContactEmail: 'owner@portalproof.test',
      onlinePresenceSummary: 'No owned website; customers need emergency plumbing and quote requests.',
      needs: ['emergency repair copy', 'tap-to-call CTA', 'service area proof'],
      signals: ['weak owned presence', 'phone-forward business']
    })
  });

  payments.insertOrGetByIdempotency({
    id: `pay_${leadId}`,
    lead_id: leadId,
    stripe_invoice_id: `in_${leadId}`,
    stripe_session_id: `in_${leadId}`,
    stripe_customer_id: `cus_${leadId}`,
    customer_email: 'owner@portalproof.test',
    payment_link_url: `https://invoice.stripe.com/i/${leadId}`,
    hosted_invoice_url: `https://invoice.stripe.com/i/${leadId}`,
    amount_cents: 50000,
    status: 'paid',
    due_at: now + 7 * 86400000,
    idempotency_key: `portal_check_invoice_${leadId}`
  });

  const buildId = `bld_${leadId}`;
  builds.start({
    id: buildId,
    lead_id: leadId,
    browser_session_id: 'mock-session',
    live_url: `/api/leads/${encodeURIComponent(leadId)}/build-preview`,
    brief: 'Build a mobile-first emergency plumbing website.'
  });
  builds.update(buildId, {
    status: 'completed',
    project_url: 'https://portal-proof-plumbing.lovable.app',
    launch_status: 'ready_for_customer',
    operator_approved_at: now,
    finished_at: now
  });
  buildQaResults.upsert({
    build_id: buildId,
    lead_id: leadId,
    attempt: 0,
    provider: 'portal-check',
    url: 'https://portal-proof-plumbing.lovable.app',
    status: 'passed',
    passed: true,
    score: 96,
    checklist: [{ key: 'contact', label: 'Contact visible', passed: true }],
    errors: [],
    claims: { businessName: 'Portal Proof Plumbing' }
  });

  const token = portal.ensurePortalTokenForLead({ leadId, metadata: { source: 'portal_check' } });
  assert.match(token.token, /^pt_/, 'portal token should be opaque/random');
  assert.notEqual(token.token, leadId, 'portal token must not be the lead id');
  assert.equal(portal.resolvePortalAccess(token.token).leadId, leadId, 'active token should resolve');
  assert.equal(portal.resolvePortalAccess(leadId).leadId, leadId, 'mock legacy lead-id link should still resolve');

  const rotated = portalTokens.rotate({ lead_id: leadId, reason: 'portal_check_rotation' });
  assert.match(rotated.token, /^pt_/, 'rotated token should be opaque');
  assert.notEqual(rotated.token, token.token, 'rotation should issue a new token');
  assert.equal(portal.resolvePortalAccess(token.token).ok, false, 'old token should stop resolving after rotation');

  await portal.updateIntake({
    leadId,
    tokenId: rotated.row.id,
    intake: {
      contactName: 'Priya Owner',
      contactEmail: 'owner@portalproof.test',
      preferredPhone: '+14155550199',
      serviceArea: 'San Francisco and Daly City',
      primaryGoal: 'Turn emergency plumbing searches into phone calls.',
      brandVoice: 'clear, trustworthy, fast',
      mustHaveSections: ['hero', 'services', 'reviews', 'contact'],
      notes: 'Mention 24/7 emergency repairs.'
    }
  });
  assert.equal(customerIntake.get(leadId).primaryGoal.includes('emergency'), true, 'intake should persist');

  const scope = portal.approveScope({ leadId, tokenId: rotated.row.id, notes: 'Scope looks right.' });
  assert.equal(scope.action.status, 'approved', 'scope approval should persist as approved');

  const accepted = await portal.acceptQuote({ leadId, tokenId: rotated.row.id });
  assert.equal(accepted.ok, true, 'accept quote should succeed with existing paid invoice');

  const asset = await portal.recordAssetUrl({
    leadId,
    tokenId: rotated.row.id,
    url: 'mock://asset/logo.png',
    label: 'Logo',
    notes: 'Use this on the header.'
  });
  assert.equal(asset.asset.url, 'mock://asset/logo.png', 'mock asset should persist');

  const revision = await portal.requestRevision({
    leadId,
    tokenId: rotated.row.id,
    note: 'Make the emergency repair CTA stronger above the fold.'
  });
  assert.equal(revision.ok, true, 'revision request should succeed');
  assert.ok(buildRevisions.listByLead(leadId).length >= 1, 'revision should link into build_revisions');

  const callback = portal.bookCallback({
    leadId,
    tokenId: rotated.row.id,
    scheduledAtMs: now + 2 * 3600000,
    ask: 'Walk through the launch checklist.'
  });
  assert.equal(callback.ok, true, 'callback should be scheduled');

  const launch = await portal.approveLaunch({ leadId, tokenId: rotated.row.id, notes: 'Ready to launch.' });
  assert.equal(launch.ok, true, 'launch approval should succeed');

  const optOut = portal.optOut({ leadId, tokenId: rotated.row.id, reason: 'portal proof opt-out' });
  assert.equal(optOut.ok, true, 'opt-out should succeed');

  const state = portal.portalState({ leadId, access: portal.resolvePortalAccess(rotated.token) });
  assert.equal(state.business.id, leadId, 'portal state should include business profile');
  assert.equal(state.invoice.status, 'paid', 'portal state should include invoice/payment');
  assert.ok(state.intake.primaryGoal, 'portal state should include intake');
  assert.ok(state.revisions.length >= 1, 'portal state should include revisions');
  assert.ok(state.callbacks.length >= 1, 'portal state should include callbacks');
  assert.ok(state.contactEvents.length >= 1, 'portal state should include contact events');
  assert.ok(state.brief.memoryHighlights, 'portal state should include memory-derived brief surface');
  assert.ok(state.launchChecklist.some((item) => item.id === 'launch' && item.done), 'launch approval should appear in checklist');
  assert.equal(state.nextAction.id, 'opted_out', 'opt-out should control next action');
  assert.ok(state.intake.assetUrls.some((row) => row.url === 'mock://asset/logo.png'), 'portal state should expose saved assets');
  assert.equal(Object.prototype.hasOwnProperty.call(state.actions[0] || {}, 'body_json'), false, 'portal state actions should not leak raw body_json');
  assert.equal(Object.prototype.hasOwnProperty.call(state.approvals.launch || {}, 'metadata_json'), false, 'portal approvals should be customer-shaped');
  assert.equal(Object.prototype.hasOwnProperty.call(state.build || {}, 'browser_session_id'), false, 'portal build should not leak provider session internals');
  assert.ok(portalActions.listByLead(leadId).some((row) => row.type === 'opt_out'), 'portal action log should include opt-out');

  console.log(JSON.stringify({
    ok: true,
    dataDir,
    leadId,
    tokenPrefix: rotated.token.slice(0, 10),
    portalPath: `/share/build/${rotated.token}`,
    checks: {
      token: true,
      rotation: true,
      legacyFallback: true,
      intake: true,
      accept: true,
      revision: true,
      asset: true,
      callback: true,
      optOut: true,
      approval: true,
      richState: true,
      customerShapedState: true
    },
    counts: {
      portalActions: portalActions.listByLead(leadId).length,
      contactEvents: contactEvents.listByLead(leadId).length,
      revisions: buildRevisions.listByLead(leadId).length
    }
  }, null, 2));
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
