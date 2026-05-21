#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-builder-hooks-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BUILDS: 'false',
  AUTONOMOUS_OUTREACH_ENABLED: 'false',
  GEMINI_API_KEY: '',
  SUPERMEMORY_API_KEY: '',
  BROWSER_USE_API_KEY: '',
  V0_API_KEY: '',
  FULFILLMENT_MOCK_DELAY_MS: '0',
  BUILDER_MAX_REVISIONS: '1'
});

const results = [];

try {
  const [
    dbApi,
    memoryApi,
    hooksApi,
    revisionApi,
    browserUseApi,
    portalApi,
    builderApi
  ] = await Promise.all([
    import('../server/db.js'),
    import('../server/memory.js'),
    import('../server/fulfillment/hooks/index.js'),
    import('../server/fulfillment/hooks/revision.js'),
    import('../server/providers/browserUse.js'),
    import('../server/customerPortal.js'),
    import('../server/workers/builder.js')
  ]);

  await check('bad brief blocked', () => {
    const bad = hooksApi.validateWebsiteBrief({
      businessName: '',
      phone: '',
      locationOrServiceArea: 'San Francisco',
      services: [],
      cta: 'Book and pay online',
      customerNeed: 'Customers need a service page.',
      styleDirection: 'clean and direct',
      prohibitedClaims: ['Do not invent claims.'],
      confirmedCapabilities: { booking: false, payments: false }
    });
    assert(!bad.ok, 'bad brief should not validate');
    assert(hasCode(bad, 'missing_business_name'), 'missing business name should be reported');
    assert(hasCode(bad, 'missing_phone'), 'missing phone should be reported');
    assert(hasCode(bad, 'missing_services'), 'missing services should be reported');
    assert(hasCode(bad, 'unsupported_booking_claim'), 'unsupported booking should be blocked');
    assert(hasCode(bad, 'unsupported_payment_claim'), 'unsupported payment should be blocked');
    return bad.errors.map((e) => e.code);
  });

  const goodLead = {
    id: 'lead_hooks_good',
    business_name: 'QA Ridge HVAC',
    phone: '+14155550123',
    address: '10 Market St, San Francisco, CA',
    niche: 'hvac repair',
    city: 'San Francisco',
    website: null
  };
  const goodBrief = hooksApi.buildWebsiteBrief({ lead: goodLead });

  await check('good brief accepted', () => {
    const good = hooksApi.validateWebsiteBrief(goodBrief);
    assert(good.ok, `good brief should validate: ${JSON.stringify(good.errors)}`);
    return { services: goodBrief.services, cta: goodBrief.cta };
  });

  await check('flawed site triggers revision', async () => {
    const flawed = await browserUseApi.inspectGeneratedSite({
      url: 'https://example.test/flawed',
      html: '<!doctype html><html><head><title>Wrong</title></head><body><h1>Generic Site</h1><p>Learn more about us.</p></body></html>',
      brief: goodBrief,
      lead: goodLead,
      mock: true
    });
    assert(!flawed.passed, 'flawed site should fail QA');
    assert(flawed.errors.includes('visible_business_name'), 'missing business name should fail');
    assert(flawed.errors.includes('visible_phone_contact'), 'missing phone should fail');
    assert(flawed.errors.includes('service_sections'), 'missing services should fail');
    const plan = await revisionApi.createRevisionPlan({ brief: goodBrief, qaResult: flawed, attempt: 0 });
    assert(plan.prompt.includes(goodBrief.businessName), 'revision prompt should include business name');
    assert(plan.prompt.includes(goodBrief.phone), 'revision prompt should include phone');
    return { errors: flawed.errors, revisionPromptChars: plan.prompt.length };
  });

  await check('passing site becomes launch-ready, then customer approval is separate', async () => {
    const leadId = insertLead(dbApi, memoryApi.containerTagFor, {
      id: `lead_hooks_ship_${Date.now().toString(36)}`
    });
    const result = await builderApi.runBuilder({ leadId, buildId: `bld_hooks_${Date.now().toString(36)}` });
    const lead = dbApi.leads.get(leadId);
    const build = dbApi.builds.listByLead(leadId)[0];
    const qa = dbApi.buildQaResults.listByBuild(build.id)[0];
    const hooks = dbApi.buildHooks.listByBuild(build.id);
    const readModel = hooksApi.buildQaReadModel({ leadId, buildId: build.id });
    assert(result.projectUrl, 'builder result should include projectUrl');
    assert(lead.status === 'awaiting_launch_approval', `lead should wait for launch approval, got ${lead.status}`);
    assert(build.status === 'completed', `build should be completed, got ${build.status}`);
    assert(build.launch_status === 'ready_for_customer', `launch status should be ready_for_customer, got ${build.launch_status}`);
    assert(qa?.passed, 'latest QA result should pass');
    assert(readModel.launchChecklist?.status === 'ready_for_customer', `read model launch status wrong: ${readModel.launchChecklist?.status}`);
    assert(readModel.launchChecklist?.launchBlocking?.includes('customer_approval'), 'customer approval should remain a separate launch gate');
    assert(hooks.some((hook) => hook.hook === 'finalAccept' && hook.output?.accepted === true), 'finalAccept hook should accept');
    const approval = await portalApi.approveLaunch({ leadId });
    const approvedBuild = dbApi.builds.get(build.id);
    assert(approval.ok, 'customer approval should be recorded');
    assert(approvedBuild.launch_status === 'customer_approved', `expected customer_approved, got ${approvedBuild.launch_status}`);
    return { leadStatus: lead.status, buildStatus: build.status, launchStatus: approvedBuild.launch_status, qaScore: qa.score, hookCount: hooks.length };
  });

  await check('customer edit request creates deduped revision prompt', async () => {
    const leadId = insertLead(dbApi, memoryApi.containerTagFor, {
      id: `lead_hooks_revision_${Date.now().toString(36)}`
    });
    await builderApi.runBuilder({ leadId, buildId: `bld_hooks_revision_${Date.now().toString(36)}` });
    const first = await portalApi.requestEdit({ leadId, note: 'Please make the contact form ask for the neighborhood.' });
    const duplicate = await portalApi.requestEdit({ leadId, note: 'Please make the contact form ask for the neighborhood.' });
    const revisions = dbApi.buildRevisions.listByLead(leadId);
    assert(first.revision?.ok, 'first customer edit should create a revision prompt');
    assert(duplicate.revision?.deduped, 'duplicate customer edit should reuse revision prompt');
    assert(revisions.some((row) => row.status === 'requested' && row.prompt.includes('Customer note')), 'requested revision prompt should be persisted');
    return { firstRevisionId: first.revision.revisionId, duplicateRevisionId: duplicate.revision.revisionId, revisionCount: revisions.length };
  });

  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({ ok, dataDir: resolve(dataDir), results }, null, 2));
  for (const result of results) {
    console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
  }
  if (!ok) process.exitCode = 1;
} finally {
  if (!process.env.KEEP_BUILDER_HOOKS_CHECK_DATA) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: formatDetail(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.stack || err?.message || String(err) });
  }
}

function insertLead(api, containerTagFor, patch = {}) {
  const id = patch.id || `lead_hooks_${Date.now().toString(36)}`;
  const result = api.leads.insert({
    id,
    container_tag: containerTagFor(id),
    business_name: patch.business_name || 'Ship Shape HVAC',
    phone: patch.phone || '+14155550199',
    address: patch.address || '22 Mission St, San Francisco, CA',
    niche: patch.niche || 'hvac repair',
    city: patch.city || 'San Francisco',
    website: null,
    status: 'paid',
    research_status: 'complete',
    outreach_status: 'called',
    risk_status: 'callable',
    consent_status: 'operator_demo',
    phone_classification: 'business'
  });
  return result.lead.id;
}

function hasCode(result, code) {
  return (result.errors || []).some((error) => error.code === code);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formatDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  return JSON.stringify(detail);
}
