#!/usr/bin/env node

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-call-state-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  LIVE_CALLS: 'false',
  LIVE_EMAILS: 'false',
  LIVE_PAYMENTS: 'false',
  LIVE_BUILDS: 'false',
  GEMINI_API_KEY: '',
  SUPERMEMORY_API_KEY: '',
  AGENTPHONE_API_KEY: '',
  AGENTMAIL_API_KEY: '',
  STRIPE_SECRET_KEY: '',
  MOSS_PROJECT_ID: '',
  MOSS_PROJECT_KEY: '',
  MOSS_FORCE_MOCK: 'true'
});

const results = [];
let dbModule;
let advanceCallState;
let createInitialCallState;
let emitCallState;
let parseCallbackRequest;
let persistCallbackPromise;
let terminalCallState;
let applyPackToPitch;
let getPackByKey;

try {
  const callStateModule = await import('../server/callState.js');
  const analystModule = await import('../server/workers/analyst.js');
  const verticalPackModule = await import('../server/verticalPacks/index.js');
  dbModule = await import('../server/db.js');

  const { CALL_STATE_STAGES } = callStateModule;
  advanceCallState = callStateModule.advanceCallState;
  createInitialCallState = callStateModule.createInitialCallState;
  emitCallState = callStateModule.emitCallState;
  parseCallbackRequest = callStateModule.parseCallbackRequest;
  persistCallbackPromise = callStateModule.persistCallbackPromise;
  terminalCallState = callStateModule.terminalCallState;
  applyPackToPitch = verticalPackModule.applyPackToPitch;
  getPackByKey = verticalPackModule.getPackByKey;
  const { extractConfirmedInvoiceEmail } = analystModule;

  const now = new Date('2026-05-20T17:00:00.000Z').getTime();
  const context = fixtureContext();

  await check('sales_walkthrough_exercises_core_states', () => {
    const { stages, states } = runStateMachine({
      ...context,
      now,
      turns: [
        { role: 'agent', text: context.pitch.beginMessage },
        { role: 'user', text: 'Wait, what is this and why are you calling me? Is this AI?' },
        { role: 'agent', text: 'Fair question. I am Callan, an AI voice operator for callmemaybe. I noticed the reviews mention emergency repairs and no clear service-area page.' },
        { role: 'user', text: 'I am busy, so make it quick.' },
        { role: 'user', text: 'Most people find us on Google and ask whether we do water heaters.' },
        { role: 'agent', text: context.pitch.valueProp },
        { role: 'user', text: 'How much does it cost?' },
        { role: 'agent', text: context.pitch.close },
        { role: 'user', text: 'Okay, send me the invoice.' },
        { role: 'agent', text: context.pitch.emailAsk },
        { role: 'user', text: 'Use maria at lunaridge dot com.' },
        { role: 'agent', text: 'I have maria@lunaridge.com. Is that right?' },
        { role: 'user', text: 'Yes, that is correct.' }
      ]
    });
    assertIncludes(stages, ['opener', 'permission_check', 'objection', 'discovery', 'value_pitch', 'pricing', 'close', 'email_capture', 'readback_confirm']);
    const firstObjection = states.find((state) => state.currentState === 'objection');
    assert(firstObjection.latestEvent.detectors.some((d) => d.type === 'skeptical'), 'skeptical detector missing');
    assert(firstObjection.latestEvent.detectors.some((d) => d.type === 'ai_disclosure_question'), 'AI detector missing');
    return { stages };
  });

  await check('busy_callback_exact_time_and_vague_time', () => {
    const exact = runStateMachine({
      ...context,
      now,
      turns: [
        { role: 'agent', text: context.pitch.beginMessage },
        { role: 'user', text: 'I am busy with a customer, call me back Friday at 2pm.' }
      ]
    }).last;
    assert(exact.currentState === 'callback', `expected callback, got ${exact.currentState}`);
    assert(exact.callback.exact === true, 'expected exact callback time');
    assert(new Date(exact.callback.scheduledAtMs).getDay() === 5, 'expected Friday callback');
    assert(new Date(exact.callback.scheduledAtMs).getHours() === 14, 'expected 2pm callback');

    const vague = parseCallbackRequest('Can you call me later?', { now });
    assert(vague.requested && !vague.exact && vague.needsClarification, `expected callback clarification, got ${JSON.stringify(vague)}`);
    return { exact: exact.callback.spokenTime, vague: vague.clarificationQuestion };
  });

  await check('opt_out_stops_pitch_and_marks_unsafe', () => {
    const last = runStateMachine({
      ...context,
      now,
      turns: [
        { role: 'agent', text: context.pitch.beginMessage },
        { role: 'user', text: 'Stop calling me and remove me from your list.' }
      ]
    }).last;
    assert(last.currentState === 'opt_out', `expected opt_out, got ${last.currentState}`);
    assert(last.safety.safe === false && last.safety.code === 'opt_out', 'opt-out should be unsafe for continued sales');
    return last.nextLine;
  });

  await check('unsupported_request_routes_to_handoff', () => {
    const last = runStateMachine({
      ...context,
      now,
      turns: [
        { role: 'agent', text: context.pitch.beginMessage },
        { role: 'user', text: 'Can you guarantee first page Google rankings and sign our NDA?' }
      ]
    }).last;
    assert(last.currentState === 'handoff', `expected handoff, got ${last.currentState}`);
    assert(last.safety.safe === false && last.handoff?.required !== false, 'handoff should pause autonomous sales');
    return last.nextLine;
  });

  await check('email_correction_readback_confirmation', () => {
    const transcript = [
      { role: 'agent', text: 'What is the best email for the invoice?', ts: 1 },
      { role: 'user', text: 'Use owner at oldshop dot com.', ts: 2 },
      { role: 'agent', text: 'I have owner@oldshop.com. Is that right?', ts: 3 },
      { role: 'user', text: 'No, actually maria at lunaridge dot com.', ts: 4 },
      { role: 'agent', text: 'I have maria@lunaridge.com. Is that right?', ts: 5 },
      { role: 'user', text: 'Yes, that is right.', ts: 6 }
    ];
    const proof = extractConfirmedInvoiceEmail({ transcript });
    assert(proof.confirmed === true, `expected confirmed corrected email, got ${JSON.stringify(proof)}`);
    assert(proof.email === 'maria@lunaridge.com', `unexpected corrected email ${proof.email}`);
    assert(proof.confidence >= 0.9 && proof.sourceExcerpt, 'expected confidence and source excerpt');
    const last = runStateMachine({ ...context, now, turns: transcript }).last;
    assert(last.currentState === 'readback_confirm', `expected readback_confirm, got ${last.currentState}`);
    return { email: proof.email, confidence: proof.confidence };
  });

  await check('voicemail_and_no_answer_terminal_states', () => {
    const base = createInitialCallState({ ...context, now });
    const voicemail = terminalCallState(base, 'failed:voicemail');
    const noAnswer = terminalCallState(base, 'failed:no_answer');
    assert(voicemail.currentState === 'voicemail', `expected voicemail, got ${voicemail.currentState}`);
    assert(noAnswer.currentState === 'no_answer', `expected no_answer, got ${noAnswer.currentState}`);
    assertIncludes(CALL_STATE_STAGES, ['voicemail', 'no_answer']);
    return { voicemail: voicemail.nextLine, noAnswer: noAnswer.nextLine };
  });

  await check('persisted_state_events_and_callback_promise', () => {
    const { leads, calls, events, scheduledCalls } = dbModule;
    const lead = {
      id: `lead_state_persist_${Date.now().toString(36)}`,
      container_tag: `lead:state-persist-${Date.now().toString(36)}`,
      business_name: 'Persisted State Plumbing',
      phone: '+14155550991',
      address: '100 Market St, San Francisco, CA',
      niche: 'plumber',
      city: 'San Francisco',
      website: null,
      research_status: 'complete',
      outreach_status: 'queued',
      risk_status: 'callable',
      consent_status: 'operator_demo',
      phone_classification: 'business_landline',
      source_url: 'https://maps.example.test/persisted-state'
    };
    const inserted = leads.insert(lead).lead;
    const callId = `call_${inserted.id}`;
    calls.start({
      id: callId,
      lead_id: inserted.id,
      to_phone: inserted.phone,
      provider_call_id: null,
      disclosure_text: context.disclosureText,
      decision_reason: 'call-state deterministic persistence check'
    });
    let state = createInitialCallState({ ...context, lead: inserted, callId, runId: 'run_state_persist', now });
    emitCallState(state, { leadId: inserted.id, callId, runId: 'run_state_persist', mock: true });
    const turn = { role: 'user', text: 'I am busy, call me back Friday at 2pm.', ts: now + 1000 };
    state = advanceCallState(state, turn, {
      ...context,
      now: now + 1000,
      retrievals: [{ snippets: context.hotContext.snippets }]
    });
    emitCallState(state, { leadId: inserted.id, callId, runId: 'run_state_persist', mock: true, turn });
    persistCallbackPromise({ leadId: inserted.id, callId, state, turn });
    const persisted = events.listByLead(inserted.id, { worker: 'caller', limit: 20 }).filter((row) => row.type === 'caller.state');
    const scheduled = scheduledCalls.listForLead(inserted.id);
    assert(persisted.length >= 2, `expected caller.state rows, got ${persisted.length}`);
    assert(scheduled.length === 1, `expected one scheduled callback, got ${scheduled.length}`);
    return { events: persisted.length, scheduledAt: new Date(scheduled[0].scheduled_at_ms).toISOString() };
  });

  await check('vertical_pack_rewrites_inherited_price_mentions', () => {
    const plumber = getPackByKey('plumber');
    const packed = applyPackToPitch({
      beginMessage: 'Hi.',
      openingLine: 'One quick website question.',
      valueProp: 'A focused $500 page helps customers decide fast.',
      discoveryQuestions: ['What should customers know?', 'What do they ask first?', 'Where do they find you?'],
      close: 'If this sounds useful, I can send the $500 invoice.',
      emailAsk: 'What is the best email for the invoice?',
      emailReadbackInstruction: 'Read back and confirm the email.',
      invoiceClose: 'AgentMail will send the invoice.',
      objections: [
        { objection: 'Too expensive.', response: 'It is one flat $500 page, hosted.' },
        { objection: 'Send info.', response: 'I can send details about the five hundred dollar page.' },
        { objection: 'Busy.', response: 'Totally fair, it is still the flat $500 scope.' }
      ]
    }, plumber);
    const text = [
      packed.valueProp,
      packed.close,
      ...(packed.objections || []).map((item) => item.response)
    ].join(' ');
    assert(!/\$500|five hundred/i.test(text), `generic price leaked into packed pitch: ${text}`);
    assert(/\$600/.test(text), `plumber price missing from packed pitch: ${text}`);
    return { price: '$600', valueProp: packed.valueProp };
  });
} finally {
  if (dbModule?.db?.open) dbModule.db.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log('\n=== CALL STATE CHECK RESULTS ===\n');
for (const result of results) {
  console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.name}${result.detail ? ` - ${result.detail}` : ''}`);
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (failed.length) process.exit(1);

function fixtureContext() {
  const lead = {
    id: 'lead_call_state_check',
    business_name: 'Luna Ridge Plumbing',
    niche: 'plumber',
    city: 'San Francisco',
    risk_status: 'callable',
    outreach_status: 'queued',
    phone_classification: 'business_landline'
  };
  const profile = {
    businessName: 'Luna Ridge Plumbing',
    whatTheyDo: 'Emergency plumbing, water heater repair, drains, and leak fixes.',
    onlinePresenceSummary: 'Public listings and reviews mention fast emergency repairs, but there is no owned service-area page.',
    onlinePresenceStrength: 'weak',
    needs: ['service area', 'tap-to-call phone', 'review proof'],
    signals: ['reviews mention fast response', 'listing lacks water heater details']
  };
  const pitch = {
    beginMessage: 'Hi! This is callmemaybe calling about Luna Ridge Plumbing. This call is automated and recorded for quality. If you would like to opt out, just say stop and I will take care of it. I noticed your reviews mention emergency repairs and wanted to ask one quick website question.',
    openingLine: 'I noticed your reviews mention emergency repairs and there is not a clear owned page for service area or water heaters.',
    valueProp: 'A flat $600 single-page plumbing site can show service area, emergency work, reviews, and a giant tap-to-call button.',
    discoveryQuestions: [
      'What do customers usually ask before they call?',
      'Which plumbing service should a new customer notice first?',
      'Where do most people find you today?'
    ],
    close: 'If this sounds useful, I can send the $600 invoice and start from the public details I already found.',
    emailAsk: 'What is the best email for the invoice?',
    emailReadbackInstruction: 'Read the email back exactly and ask the owner to confirm it before promising the invoice.',
    invoiceClose: 'AgentMail will send the invoice, and you can reply to that email with questions.'
  };
  const verticalPack = {
    key: 'plumber',
    name: 'Plumbing and drain',
    priceCents: 60000,
    valuePropHook: 'A single-page plumber site built for urgent homeowner searches.',
    reviewValueProps: ['Use review language about fast response and emergency fixes.']
  };
  const hotContext = {
    snippets: [
      { id: 'pricing.flat_fee', text: 'The offer is a flat $600 same-day website package.', metadata: { kind: 'invoice_pricing', title: 'Flat fee' } },
      { id: 'compliance.email_readback', text: 'Read back the invoice email and confirm before sending.', metadata: { kind: 'compliance', title: 'Email readback' } },
      { id: 'research.review_theme.1', text: 'Reviews mention fast emergency plumbing response.', metadata: { kind: 'customer_need', title: 'Review theme' } }
    ]
  };
  return {
    lead,
    profile,
    pitch,
    verticalPack,
    hotContext,
    disclosureText: pitch.beginMessage
  };
}

function runStateMachine({ turns, now, ...context }) {
  let state = createInitialCallState({ ...context, now });
  const states = [state];
  const stages = [state.currentState];
  for (const [index, turn] of turns.entries()) {
    state = advanceCallState(state, { ...turn, ts: now + index * 1000 }, {
      ...context,
      now: now + index * 1000,
      retrievals: context.hotContext?.snippets?.length ? [{ snippets: context.hotContext.snippets }] : []
    });
    states.push(state);
    stages.push(state.currentState);
  }
  return { stages, states, last: states[states.length - 1] };
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  } catch (err) {
    results.push({ name, ok: false, detail: err?.stack || err?.message || String(err) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(actual, expected) {
  for (const item of expected) {
    assert(actual.includes(item), `expected ${JSON.stringify(actual)} to include ${item}`);
  }
}
