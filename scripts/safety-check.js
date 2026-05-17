// Phase 8: dry-run + safety verification per upgrade.md §5.
// Verifies HMAC webhook signature, Supermemory containerTag isolation,
// the recording-disclosure preamble plumbing, and the Stripe key
// posture. Mock end-to-end is verified by the running stack already.

import crypto from 'node:crypto';
import { env } from '../server/env.js';
import { addDoc, search, containerTagFor } from '../server/memory.js';
import { recordingDisclosure } from '../server/compliance.js';
import { verifyAgentPhone } from '../server/webhooks/agentphone.js';

const results = [];
const pass = (name, detail) => results.push({ name, ok: true, detail });
const fail = (name, detail) => results.push({ name, ok: false, detail });

async function checkHmac() {
  if (!env.agentphone.webhookSecret) {
    pass('hmac.agentphone (skipped — webhook secret not set; live mode would still require it)', 'no secret');
    return;
  }
  const ts = String(Date.now());
  const body = Buffer.from(JSON.stringify({ event: 'call.ended', callId: 'demo' }));
  const sig = crypto.createHmac('sha256', env.agentphone.webhookSecret).update(`${ts}.${body.toString('utf8')}`).digest('hex');
  const okReq = {
    headers: { 'x-webhook-signature': `sha256=${sig}`, 'x-webhook-timestamp': ts },
    rawBody: body
  };
  const okRes = verifyAgentPhone(okReq, body);
  if (okRes.ok) pass('hmac.agentphone.valid_signature_accepted', '');
  else fail('hmac.agentphone.valid_signature_accepted', okRes.reason);

  const badReq = {
    headers: { 'x-webhook-signature': `sha256=${'0'.repeat(64)}`, 'x-webhook-timestamp': ts },
    rawBody: body
  };
  const badRes = verifyAgentPhone(badReq, body);
  if (!badRes.ok) pass('hmac.agentphone.bad_signature_rejected', `reason: ${badRes.reason}`);
  else fail('hmac.agentphone.bad_signature_rejected', 'bad signature accepted!');
}

async function checkIsolation() {
  if (!env.supermemory.apiKey) { fail('isolation.containertag', 'SUPERMEMORY_API_KEY missing'); return; }
  const stamp = Date.now().toString(36);
  const tagA = containerTagFor(`iso${stamp}a`);
  const tagB = containerTagFor(`iso${stamp}b`);
  const aDoc = await addDoc(tagA, 'profile', { businessName: 'TagA Cleaners', niche: 'dry-cleaning', city: 'A-town', whatTheyDo: 'special_isoA_phrase_zebra' });
  const bDoc = await addDoc(tagB, 'profile', { businessName: 'TagB Repairs', niche: 'shoe-repair', city: 'B-town', whatTheyDo: 'special_isoB_phrase_pelican' });
  await new Promise((r) => setTimeout(r, 5000));
  const aHits = await search(tagA, 'pelican');
  const bHits = await search(tagB, 'zebra');
  const aLeakedIds = aHits.map((h) => h?.documentId || h?.id).filter((id) => id === bDoc?.id);
  const bLeakedIds = bHits.map((h) => h?.documentId || h?.id).filter((id) => id === aDoc?.id);
  if (aLeakedIds.length === 0 && bLeakedIds.length === 0) {
    pass('isolation.containertag', `tagA cross-query returned ${aHits.length} hits but none were tagB's doc; tagB cross-query returned ${bHits.length} hits but none were tagA's doc.`);
  } else {
    fail('isolation.containertag', `bleed detected: ${aLeakedIds.length + bLeakedIds.length} cross-tag IDs`);
  }
}

function checkDisclosure() {
  const line = recordingDisclosure('Tony Barbershop');
  const requirements = [
    /recorded/i,
    /opt out|stop|remove/i,
    /Tony Barbershop/i
  ];
  const missing = requirements.filter((rx) => !rx.test(line));
  if (missing.length === 0) pass('compliance.recording_disclosure', `line: "${line}"`);
  else fail('compliance.recording_disclosure', `missing pattern(s): ${missing.map(String).join(', ')}`);
}

function checkStripeKey() {
  const k = env.stripe.secretKey;
  if (!k) { fail('stripe.key_posture', 'STRIPE_SECRET_KEY not set'); return; }
  if (k.startsWith('rk_test_')) pass('stripe.key_posture', 'restricted test key (rk_test_) — ideal');
  else if (k.startsWith('sk_test_')) pass('stripe.key_posture.test_unrestricted', 'sk_test_ — test mode is safe but upgrade.md asks for rk_test_ (restricted) ideally');
  else if (k.startsWith('rk_live_')) fail('stripe.key_posture', 'restricted LIVE key — NOT recommended for hackathon demo');
  else if (k.startsWith('sk_live_')) fail('stripe.key_posture', 'SECRET LIVE KEY — refuse to run live payments with this');
  else fail('stripe.key_posture', 'unknown key format');
}

function checkRunMode() {
  pass('run_mode.posture', `runMode=${env.runMode}; live.calls=${env.live.calls} emails=${env.live.emails} payments=${env.live.payments} builds=${env.live.builds}; allowedPhones=${env.allowedPhones.length}`);
}

async function main() {
  checkRunMode();
  checkDisclosure();
  checkStripeKey();
  await checkHmac();
  await checkIsolation();

  console.log('\n=== SAFETY CHECK RESULTS ===\n');
  for (const r of results) {
    const sigil = r.ok ? 'PASS' : 'FAIL';
    console.log(`[${sigil}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} passed.`);
  if (fails.length > 0) process.exit(1);
}

main().catch((err) => { console.error('safety-check crashed:', err); process.exit(2); });
