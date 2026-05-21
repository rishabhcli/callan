#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const dataDir = mkdtempSync(join(tmpdir(), 'callan-fulfillment-'));

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
  FULFILLMENT_PROVIDER_ATTEMPTS: '1',
  FULFILLMENT_MOCK_DELAY_MS: '1'
});

const [
  dbApi,
  memoryApi,
  paymentFlow,
  builderWorker,
  lovableProvider,
  v0Provider
] = await Promise.all([
  import('../server/db.js'),
  import('../server/memory.js'),
  import('../server/paymentFlow.js'),
  import('../server/workers/builder.js'),
  import('../server/providers/lovable.js'),
  import('../server/providers/v0.js')
]);

try {
  await check('paid synthetic invoice -> one build', async () => {
    const leadId = seedLead({ id: stamp('paid_lovable'), niche: 'hvac repair' });
    const invoiceId = `in_${leadId}`;
    const starts = [];
    const startBuilder = (args) => starts.push(args);

    const first = paymentFlow.recordPaidPayment(invoiceId, leadId, {
      startBuilder,
      payment: {
        lead_id: leadId,
        stripe_invoice_id: invoiceId,
        stripe_session_id: invoiceId,
        amount_cents: 50000,
        paid_at: Date.now(),
        idempotency_key: `stripe_paid:${invoiceId}`
      }
    });
    const duplicate = paymentFlow.recordPaidPayment(invoiceId, leadId, {
      startBuilder,
      payment: {
        lead_id: leadId,
        stripe_invoice_id: invoiceId,
        stripe_session_id: invoiceId,
        amount_cents: 50000,
        paid_at: Date.now(),
        idempotency_key: `stripe_paid:${invoiceId}`
      }
    });

    assert(first.builderTriggerClaimed === true, `first trigger not claimed: ${JSON.stringify(first)}`);
    assert(duplicate.builderTriggerClaimed === false, `duplicate trigger claimed: ${JSON.stringify(duplicate)}`);
    assert(starts.length === 1, `expected one start, got ${starts.length}`);
    await builderWorker.runBuilder(starts[0]);

    const builds = dbApi.builds.listByLead(leadId);
    assert(builds.length === 1, `expected one build row, got ${builds.length}`);
    assert(builds[0].status === 'completed', `expected completed build, got ${builds[0].status}: ${builds[0].error || 'no error'}`);
    assert(builds[0].launch_status === 'ready_for_customer', `expected ready_for_customer, got ${builds[0].launch_status}`);
    assert(['anything', 'lovable', 'v0'].includes(builds[0].target), `unexpected target ${builds[0].target}`);
    const qa = dbApi.buildQaResults.listByBuild(builds[0].id)[0];
    assert(qa?.passed, 'paid build should persist passing QA');
    return { buildId: builds[0].id, target: builds[0].target, projectUrl: builds[0].project_url, qaScore: qa.score };
  });

  await check('Lovable mock URL extracted', async () => {
    const url = lovableProvider.extractLovableAppUrl({
      output: 'PROJECT_URL: https://luna-ridge-hvac.lovable.app'
    });
    assert(url === 'https://luna-ridge-hvac.lovable.app', `unexpected Lovable URL ${url}`);
    const leadId = seedLead({ id: stamp('paid_lovable_explicit'), businessName: 'Luna Ridge HVAC', niche: 'hvac repair' });
    await builderWorker.runBuilder({ leadId, target: 'lovable' });
    const build = latestBuildByTarget('lovable');
    assert(/\.lovable\.app$/i.test(build.project_url || ''), `stored project URL was not Lovable: ${build.project_url}`);
    assert((build.lovable_url || '').startsWith('https://lovable.dev/?autosubmit=true#prompt='), `bad Lovable submission URL: ${build.lovable_url}`);
    return { extracted: url, stored: build.project_url };
  });

  await check('v0 mock target returns deployment', async () => {
    const leadId = seedLead({ id: stamp('paid_v0'), businessName: 'Cypress Street Dental', niche: 'dental clinic' });
    await builderWorker.runBuilder({ leadId, target: 'v0' });
    const build = dbApi.builds.listByLead(leadId)[0];
    assert(build.target === 'v0', `expected v0 target, got ${build.target}`);
    assert(build.status === 'completed', `expected completed v0 build, got ${build.status}: ${build.error || 'no error'}`);
    assert(/\.vercel\.app$/i.test(build.project_url || ''), `expected v0 deployment URL, got ${build.project_url}`);
    assert(build.provider_deployment_id, 'provider_deployment_id missing');
    assert(v0Provider.extractV0FinalUrl({ webUrl: build.project_url }) === build.project_url, 'v0 final URL extraction failed');
    return { buildId: build.id, deployment: build.provider_deployment_id, projectUrl: build.project_url };
  });

  await check('duplicate paid webhook does not build twice', () => {
    const leadId = seedLead({ id: stamp('webhook_once'), businessName: 'North Pier Plumbing', niche: 'plumbing' });
    const invoiceId = `in_${leadId}`;
    const eventId = `evt_${invoiceId}`;
    const starts = [];
    const startBuilder = (args) => starts.push(args);

    if (dbApi.webhookEvents.recordOnce({ provider: 'stripe', event_id: eventId, type: 'invoice.paid', payload: { id: eventId, metadata: { leadId } } })) {
      paymentFlow.recordPaidPayment(invoiceId, leadId, {
        startBuilder,
        payment: { lead_id: leadId, stripe_invoice_id: invoiceId, stripe_session_id: invoiceId, amount_cents: 50000 }
      });
    }
    if (dbApi.webhookEvents.recordOnce({ provider: 'stripe', event_id: eventId, type: 'invoice.paid', payload: { id: eventId, metadata: { leadId } } })) {
      paymentFlow.recordPaidPayment(invoiceId, leadId, {
        startBuilder,
        payment: { lead_id: leadId, stripe_invoice_id: invoiceId, stripe_session_id: invoiceId, amount_cents: 50000 }
      });
    }

    const builds = dbApi.builds.listByLead(leadId);
    assert(starts.length === 1, `expected one builder start, got ${starts.length}`);
    assert(builds.length === 1, `expected one reserved build row, got ${builds.length}`);
    return { starts: starts.length, buildId: builds[0].id };
  });
} finally {
  const ok = results.every((result) => result.ok);
  console.log('\n=== FULFILLMENT CHECK ===');
  for (const result of results) {
    console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] fulfillment ${ok ? 'passed' : 'failed'}`);
  rmSync(dataDir, { recursive: true, force: true });
  if (!ok) process.exitCode = 1;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: formatDetail(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.stack || err?.message || String(err) });
  }
}

function seedLead({ id, businessName = 'Luna Ridge HVAC', niche = 'hvac repair' } = {}) {
  const leadId = id || stamp('lead');
  const phone = `+1415555${Math.floor(1000 + Math.random() * 9000)}`;
  const profile = {
    businessName,
    phone,
    address: '1844 Clement St, San Francisco, CA',
    city: 'San Francisco',
    niche,
    hasWebsite: false,
    websiteUrl: null,
    onlinePresenceStrength: 'weak',
    onlinePresenceSummary: 'Listings exist, but there is no owned website for services, hours, trust proof, or a contact path.',
    ownerHypothesis: 'owner-operator',
    customerPersona: 'local customers who need clear service details and proof before calling',
    hours: 'Mon-Sat 7am-7pm',
    whatTheyDo: `${niche} for local customers`,
    services: ['diagnostic visits', 'service estimates', 'repairs'],
    needs: ['owned service page', 'tap-to-call CTA', 'simple inquiry form'],
    signals: ['weak owned presence', 'phone-forward business'],
    sourceUrl: `https://example.test/${leadId}`
  };

  const result = dbApi.leads.insert({
    id: leadId,
    container_tag: memoryApi.containerTagFor(leadId),
    business_name: businessName,
    phone: profile.phone,
    address: profile.address,
    niche,
    city: profile.city,
    website: null,
    status: 'awaiting_payment',
    research_status: 'complete',
    outreach_status: 'called',
    risk_status: 'callable',
    consent_status: 'operator_demo',
    phone_classification: 'business',
    next_action: 'send_invoice',
    source_url: profile.sourceUrl,
    research_json: JSON.stringify(profile)
  });
  return result.lead.id;
}

function latestBuildByTarget(target) {
  const rows = dbApi.db.prepare('SELECT * FROM builds WHERE target = ? ORDER BY started_at DESC LIMIT 1').all(target);
  assert(rows[0], `no build found for target ${target}`);
  return rows[0];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stamp(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDetail(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  return JSON.stringify(detail);
}
