#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-commerce-'));

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
  AGENTMAIL_API_KEY: '',
  AGENTMAIL_INBOX_ID: '',
  STRIPE_SECRET_KEY: '',
  BROWSER_USE_API_KEY: '',
  CUSTOMER_COMMERCE_SANDBOX_LINKS: 'false',
  CUSTOMER_COMMERCE_LIVE_STRIPE_LINKS: 'false',
  CUSTOMER_COMMERCE_STRIPE_ACCOUNT_ID: ''
});

const results = [];

const dbApi = await import('../server/db.js');
const memoryApi = await import('../server/memory.js');
const commerceApi = await import('../server/commerce/index.js');
const portalApi = await import('../server/customerPortal.js');
const hooksApi = await import('../server/fulfillment/hooks/index.js');
const mailReplyApi = await import('../server/workers/mailReply.js');

try {
  await check('restaurant menu inquiry builds truthful CommercePlan', async () => {
    const leadId = seedLead({
      id: 'commerce_restaurant_menu',
      businessName: 'Little Mission Taqueria',
      niche: 'restaurant',
      services: ['tacos', 'burritos', 'catering trays']
    });
    const result = await commerceApi.planCommerceForLead({
      leadId,
      source: 'commerce-check',
      intake: {
        rawText: [
          'Menu items: tacos $4, burritos $12, catering tray $85.',
          'Fulfillment notes: pickup and catering inquiries only.',
          'Cancellation policy is catering changes need 24 hours notice.'
        ].join('\n')
      }
    });
    assert.equal(result.plan.type, 'menu_inquiry');
    assert.equal(result.plan.stripeBoundary.requiresStripe, false);
    assert.equal(result.plan.websiteBrief.paymentLinkUrl, null);
    assertBriefCarriesCommerce(leadId, 'menu_inquiry');
    return { type: result.plan.type, cta: result.plan.commerceCta.label };
  });

  await check('barber booking deposit stays operator-gated', async () => {
    const leadId = seedLead({
      id: 'commerce_barber_deposit',
      businessName: 'Chair Seven Barber',
      niche: 'barber shop',
      services: ['classic cut', 'beard trim', 'hot towel shave']
    });
    const result = await commerceApi.planCommerceForLead({
      leadId,
      source: 'commerce-check',
      intake: {
        rawText: [
          'Classic cut $40; beard trim $20.',
          'We want a $15 deposit for new-client appointments.',
          'Booking requirements: preferred barber, date, time, phone number.',
          'Cancellation policy is 24 hours notice; deposits may be moved once.'
        ].join('\n')
      }
    });
    assert.equal(result.plan.type, 'booking_deposit');
    assert.equal(result.plan.intake.depositRequested, true);
    assert.equal(result.plan.stripeBoundary.requiresStripe, true);
    assert.equal(result.plan.stripeBoundary.liveCustomerCommerceEnabled, false);
    assert.equal(result.plan.stripeBoundary.callanInvoice.mayReuseForCustomerCommerce, false);
    assert.ok(result.plan.stripeBoundary.operatorChecklist.some((item) => item.key === 'separate_callan_invoice'));
    assertBriefCarriesCommerce(leadId, 'booking_deposit');
    return { stripeMode: result.plan.stripeBoundary.mode };
  });

  await check('plumber quote request needs no payment link', async () => {
    const leadId = seedLead({
      id: 'commerce_plumber_quote',
      businessName: 'North Pier Plumbing',
      niche: 'plumber',
      services: ['leak repair', 'water heater estimates', 'drain clearing']
    });
    const result = await commerceApi.planCommerceForLead({
      leadId,
      source: 'commerce-check',
      intake: {
        rawText: 'Quote requests for leaks, water heaters, and drain clearing. Ask for address, photos, urgency, and preferred callback time. Price ranges vary by job.'
      }
    });
    assert.equal(result.plan.type, 'quote_request');
    assert.equal(result.plan.stripeBoundary.requiresStripe, false);
    assert.ok(result.plan.siteComponents.some((item) => item.kind === 'quote_request_form'));
    assertBriefCarriesCommerce(leadId, 'quote_request');
    return { cta: result.plan.commerceCta.label };
  });

  await check('HVAC maintenance membership is recurring-interest only', async () => {
    const leadId = seedLead({
      id: 'commerce_hvac_membership',
      businessName: 'Fogline HVAC',
      niche: 'hvac',
      services: ['maintenance visits', 'filter changes', 'seasonal tuneups']
    });
    const result = await commerceApi.planCommerceForLead({
      leadId,
      source: 'commerce-check',
      intake: {
        rawText: [
          'Maintenance membership: $29 monthly for seasonal reminders and priority tuneup requests.',
          'Full recurring charge should not start until we confirm the customer.',
          'Cancellation policy is cancel by email before the next monthly renewal.'
        ].join('\n')
      }
    });
    assert.equal(result.plan.type, 'subscription_membership');
    assert.equal(result.plan.stripeBoundary.requiresStripe, true);
    assert.equal(result.plan.stripeBoundary.liveGenerationPerformed, false);
    assert.ok(result.plan.humanHandoff.operatorSetupRequired);
    assertBriefCarriesCommerce(leadId, 'subscription_membership');
    return { checklist: result.plan.launchChecklist.map((item) => `${item.key}:${item.status}`).join(',') };
  });

  await check('tax/legal/refund-policy request routes to handoff', async () => {
    const leadId = seedLead({
      id: 'commerce_tax_handoff',
      businessName: 'Policy Edge Services',
      niche: 'consulting',
      services: ['consultations']
    });
    const direct = commerceApi.classifyCommerceRequest({
      text: 'Can you write our refund policy and calculate sales tax for online orders?'
    });
    assert.equal(direct.kind, 'handoff');
    const mail = mailReplyApi.classifyMessage({
      subject: 'Need policy help',
      text: 'Can you write our refund policy and calculate sales tax for online orders?'
    });
    assert.equal(mail.kind, 'handoff');
    assert.equal(mail.operatorFlag, true);
    const result = await commerceApi.planCommerceForLead({
      leadId,
      source: 'commerce-check',
      intake: { rawText: 'Can you write our refund policy and calculate sales tax for online orders?' }
    });
    assert.equal(result.plan.type, 'handoff_only');
    assert.equal(result.plan.humanHandoff.required, true);
    return { flags: result.plan.riskFlags.map((flag) => flag.code).join(',') };
  });

  await check('AgentMail commerce reply creates supported plan', async () => {
    const leadId = seedLead({
      id: 'commerce_agentmail_setup',
      businessName: 'Bright Bay Detailing',
      niche: 'auto detailing',
      services: ['basic wash', 'ceramic package']
    });
    dbApi.leads.update(leadId, { agentmail_thread_id: 'thread_commerce_agentmail' });
    const result = await mailReplyApi.handleAgentMailInbound({
      id: 'evt_commerce_agentmail',
      type: 'message.received',
      direction: 'inbound',
      threadId: 'thread_commerce_agentmail',
      messageId: 'msg_commerce_agentmail',
      from: { email: 'owner@brightbay.test' },
      subject: 'Commerce details for the site',
      text: 'Please add our service packages: basic wash $30 and ceramic package $220. Customers can pay in full after we approve the request. Fulfillment notes: customers arrive at the shop.',
      leadId
    }, { forceMockSend: true, forceFallbackReply: true, writeMemory: false });
    assert.equal(result.classification.scope, 'commerce setup');
    assert.equal(result.commerceOutcome?.planned, true);
    const state = commerceApi.readCommerceState(leadId);
    assert.equal(state.plan.type, 'service_checkout');
    assert.ok(dbApi.contactEvents.listByLead(leadId).some((event) => event.type === 'commerce_intake'));
    return { type: state.plan.type, reply: result.replyText.slice(0, 60) };
  });

  await check('customer portal commerce intake is exposed without checkout links', async () => {
    const leadId = seedLead({
      id: 'commerce_portal_membership',
      businessName: 'Harbor Tune HVAC',
      niche: 'hvac',
      services: ['seasonal tuneups', 'filter changes', 'maintenance membership']
    });
    const token = portalApi.ensurePortalTokenForLead({
      leadId,
      metadata: { source: 'commerce-check' }
    });
    const access = portalApi.resolvePortalAccess(token.token);
    assert.equal(access.leadId, leadId);
    assert.equal(portalApi.portalState({ leadId, access }).business.name, 'Harbor Tune HVAC');

    const result = await commerceApi.submitPortalCommerceIntake({
      leadId,
      intake: {
        rawText: 'Maintenance membership: $45 monthly for seasonal tuneup reminders. Customers should request membership details first. Fulfillment notes: in-home service area.'
      }
    });
    assert.equal(result.plan.type, 'subscription_membership');

    const server = await startApiServerForCheck();
    try {
      const res = await fetch(`${server.baseUrl}/api/share/build/${encodeURIComponent(token.token)}`);
      const text = await res.text();
      assert.equal(res.ok, true, text);
      const state = JSON.parse(text);
      assert.equal(state.business.name, 'Harbor Tune HVAC');
      assert.equal(state.commerce.type, 'subscription_membership');
      assert.equal(state.commerce.stripeBoundary.requiresStripe, true);
      assert.equal(state.commerce.stripeBoundary.liveCustomerCommerceEnabled, false);
      assert.deepEqual(state.commerce.stripeBoundary.paymentLinks, []);
      assert.ok(state.commerce.launchChecklist.some((item) => item.key === 'stripe_boundary' && item.status === 'blocked'));
      assert.doesNotMatch(JSON.stringify(state.commerce), /https?:\/\/[^"\\s]*(?:stripe|checkout|payment-link)/i);
      return { type: state.commerce.type, links: state.commerce.stripeBoundary.paymentLinks.length };
    } finally {
      await server.close();
    }
  });

  const ok = results.every((result) => result.ok);
  console.log('\n=== COMMERCE CHECK RESULTS ===\n');
  for (const result of results) {
    console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
  }
  console.log(`[${ok ? 'PASS' : 'FAIL'}] commerce ${ok ? 'passed' : 'failed'}`);
  if (!ok) process.exitCode = 1;
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ? JSON.stringify(detail) : '' });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.stack || err?.message || String(err) });
  }
}

function seedLead({ id, businessName, niche, services }) {
  const suffix = Math.abs(hashCode(id)).toString().padStart(4, '0').slice(0, 4);
  const phone = `+1415555${suffix}`;
  const research = {
    businessName,
    niche,
    city: 'San Francisco',
    hasWebsite: false,
    onlinePresenceStrength: 'weak',
    onlinePresenceSummary: 'Synthetic weak-presence lead for commerce verification.',
    hours: 'Mon-Fri 9am-5pm',
    services,
    needs: ['owned website', 'clear service details', 'contact path'],
    sourceUrl: `https://example.test/${id}`
  };
  const result = dbApi.leads.insert({
    id,
    container_tag: memoryApi.containerTagFor(id),
    business_name: businessName,
    phone,
    address: '1 Market St, San Francisco, CA',
    niche,
    city: 'San Francisco',
    website: null,
    status: 'awaiting_payment',
    research_status: 'complete',
    outreach_status: 'called',
    risk_status: 'callable',
    consent_status: 'operator_demo',
    phone_classification: 'business',
    next_action: 'build',
    source_url: research.sourceUrl,
    research_json: JSON.stringify(research)
  });
  return result.lead.id;
}

function assertBriefCarriesCommerce(leadId, expectedType) {
  const lead = dbApi.leads.get(leadId);
  const brief = hooksApi.buildWebsiteBrief({ lead });
  assert.equal(brief.commercePlan?.type, expectedType);
  assert.equal(brief.commercePlan?.paymentLinkUrl, null);
  assert.equal(brief.commercePlan?.noFakeCheckoutLinks, true);
  const validation = hooksApi.validateWebsiteBrief(brief);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  const prompt = hooksApi.createLovableBuildPrompt(brief);
  assert.match(prompt, /Customer-business commerce plan/);
  assert.doesNotMatch(prompt, /https:\/\/commerce\.stripe\.test/i);
  assert.doesNotMatch(prompt, /https:\/\/buy\.callmemaybe\.dev/i);
  return brief;
}

async function startApiServerForCheck() {
  const port = 19000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      AUTONOMOUS_OUTREACH_ENABLED: 'false',
      LIVE_CALLS: 'false',
      LIVE_EMAILS: 'false',
      LIVE_PAYMENTS: 'false',
      LIVE_BUILDS: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode != null) {
      throw new Error(`server exited before ready (${child.exitCode}): ${output.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/ping`);
      if (res.ok) {
        return {
          baseUrl,
          child,
          close: () => stopChild(child)
        };
      }
    } catch {
      // Keep polling until the server binds.
    }
    await sleep(100);
  }
  await stopChild(child);
  throw new Error(`server did not become ready: ${output.slice(-2000)}`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  const timeout = sleep(1500).then(() => {
    if (child.exitCode == null) child.kill('SIGKILL');
  });
  await Promise.race([once(child, 'exit'), timeout]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashCode(value) {
  let hash = 0;
  for (const ch of String(value || '')) {
    hash = ((hash << 5) - hash) + ch.charCodeAt(0);
    hash |= 0;
  }
  return hash;
}
