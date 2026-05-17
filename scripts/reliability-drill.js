#!/usr/bin/env node

// Deterministic reliability/backpressure drill.
// Uses the real readiness, DB, and outreach helpers against an isolated data dir.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const args = parseArgs(process.argv.slice(2));
const SPONSOR_PROVIDERS = [
  { sponsor: 'Google DeepMind', provider: 'gemini' },
  { sponsor: 'AgentPhone', provider: 'agentphone' },
  { sponsor: 'AgentMail', provider: 'agentmail' },
  { sponsor: 'Supermemory', provider: 'supermemory' },
  { sponsor: 'Moss', provider: 'moss' },
  { sponsor: 'Browser Use', provider: 'browserUse' },
  { sponsor: 'Lovable', provider: 'lovable' },
  { sponsor: 'Stripe', provider: 'stripe' }
];
const SMOKE_PROVIDERS = SPONSOR_PROVIDERS.filter((item) => item.provider);

if (args.help) {
  console.log(JSON.stringify(helpPayload(), null, 2));
  process.exit(0);
}

const startedAt = Date.now();
const dataDir = mkdtempSync(join(tmpdir(), 'callan-reliability-'));
let dbHandle = null;
let tempDataRemoved = false;

try {
  configureIsolatedEnv(dataDir);

  const dbModule = await import('../server/db.js');
  dbHandle = dbModule.db;
  const { env } = await import('../server/env.js');
  const { liveReadiness } = await import('../server/readiness.js');
  const {
    explainLeadCallability,
    outreachRouteSmoke,
    outreachStatus,
    pauseOutreachLoop,
    queueLeadForOutreach
  } = await import('../server/outreach.js');

  const context = {
    env,
    db: dbModule.db,
    leads: dbModule.leads,
    callAttempts: dbModule.callAttempts,
    providerSmoke: dbModule.providerSmoke,
    contactEvents: dbModule.contactEvents,
    liveReadiness,
    explainLeadCallability,
    outreachRouteSmoke,
    outreachStatus,
    pauseOutreachLoop,
    queueLeadForOutreach
  };

  seedConfiguredPosture(context);
  seedSponsorSmoke(context, 'ok');
  const leadIds = seedQueueFixtures(context);

  const scenarios = [];
  scenarios.push(await scenarioBaselineReady(context, leadIds));
  scenarios.push(await scenarioSponsorMissingProvider(context));
  scenarios.push(await scenarioSponsorSmokeDegraded(context));
  scenarios.push(await scenarioQueuePaused(context, leadIds.ready));
  scenarios.push(await scenarioQueueRetryBackoff(context, leadIds.backoff));
  scenarios.push(await scenarioQueueDailyQuota(context, leadIds.quota));
  scenarios.push(await scenarioStrongPresenceBlocked(context, leadIds.strong));
  scenarios.push(await scenarioRouteChecks(context, routeBaseUrl(args)));

  const summary = summarize(scenarios);
  const finishedAt = Date.now();
  const sponsorReadout = sponsorMatrix(context);
  const sideEffectPosture = liveSideEffectPosture(context.env);
  safeCloseDb(dbHandle);
  dbHandle = null;
  tempDataRemoved = cleanupTempData(dataDir, args.keepData);

  const payload = {
    ok: summary.failed === 0,
    name: 'reliability-drill',
    generatedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    repoRoot,
    data: {
      dir: dataDir,
      isolated: true,
      removed: tempDataRemoved,
      keepData: args.keepData
    },
    liveSideEffects: sideEffectPosture,
    sponsorMatrix: sponsorReadout,
    summary,
    scenarios
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = payload.ok ? 0 : 1;
} catch (err) {
  safeCloseDb(dbHandle);
  tempDataRemoved = cleanupTempData(dataDir, args.keepData);
  const payload = {
    ok: false,
    name: 'reliability-drill',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    repoRoot,
    data: {
      dir: dataDir,
      isolated: true,
      removed: tempDataRemoved,
      keepData: args.keepData
    },
    error: {
      message: err?.message || String(err),
      stack: err?.stack || null
    }
  };
  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
}

function configureIsolatedEnv(dir) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATA_DIR: dir,
    RUN_MODE: 'autonomous_live',
    AUTONOMOUS_OUTREACH_ENABLED: 'true',
    LIVE_CALLS: 'false',
    LIVE_EMAILS: 'false',
    LIVE_PAYMENTS: 'false',
    LIVE_BUILDS: 'false',
    SMOKE_GEMINI: 'false',
    SMOKE_SUPERMEMORY_WRITE: 'false',
    SMOKE_MOSS_INDEX: 'false',
    SMOKE_LIVE_CALL: 'false',
    SMOKE_AGENTMAIL_SEND: 'false',
    SMOKE_STRIPE_INVOICE: 'false',
    SMOKE_BROWSER_USE: 'false',
    OUTREACH_DAILY_CALL_QUOTA: '1',
    DAILY_CALL_QUOTA: '1',
    OUTREACH_INTERVAL_MS: '50',
    OUTREACH_BATCH_SIZE: '1',
    OUTREACH_RETRY_BASE_MS: '300000',
    OUTREACH_RETRY_MAX_MS: '3600000',
    MAX_ATTEMPTS_PER_PHONE: '3',
    QUIET_HOURS_START: '0',
    QUIET_HOURS_END: '0',
    OUTREACH_TIMEZONE: 'America/Los_Angeles',
    ALLOWED_TARGET_PHONES: '+14155550101',
    ALLOWED_TARGET_EMAILS: 'operator@example.test',
    GEMINI_API_KEY: 'drill_gemini_key',
    SUPERMEMORY_API_KEY: 'drill_supermemory_key',
    AGENTPHONE_API_KEY: 'drill_agentphone_key',
    AGENTPHONE_AGENT_ID: 'drill-agent',
    AGENTPHONE_WEBHOOK_SECRET: 'drill-agentphone-secret',
    AGENTPHONE_FROM_NUMBER: '+14155550100',
    AGENTMAIL_API_KEY: 'drill_agentmail_key',
    AGENTMAIL_INBOX_ID: 'drill-inbox',
    AGENTMAIL_WEBHOOK_SECRET: 'drill-agentmail-secret',
    STRIPE_SECRET_KEY: 'sk_test_drill_reliability',
    STRIPE_WEBHOOK_SECRET: 'whsec_drill',
    BROWSER_USE_API_KEY: 'drill_browser_use_key',
    MOSS_PROJECT_ID: 'drill-moss-project',
    MOSS_PROJECT_KEY: 'drill-moss-key',
    HACKATHON_SPONSORS: 'Google DeepMind,AgentPhone,AgentMail,Supermemory,Moss,Browser Use,Lovable,Stripe'
  });
}

function seedConfiguredPosture({ env }) {
  env.runMode = 'autonomous_live';
  env.outreach.enabled = true;
  env.outreach.batchSize = 1;
  env.outreach.maxAttemptsPerPhone = 3;
  env.outreach.quietHoursStart = 0;
  env.outreach.quietHoursEnd = 0;
  env.allowedPhones.splice(0, env.allowedPhones.length, '+14155550101');
  env.allowedEmails.splice(0, env.allowedEmails.length, 'operator@example.test');
  env.live.calls = false;
  env.live.emails = false;
  env.live.payments = false;
  env.live.builds = false;
  Object.assign(env.smoke, {
    gemini: false,
    supermemoryWrite: false,
    mossIndex: false,
    liveCall: false,
    agentmailSend: false,
    stripeInvoice: false,
    browserUse: false
  });
  env.gemini.apiKey = 'drill_gemini_key';
  env.supermemory.apiKey = 'drill_supermemory_key';
  env.agentphone.apiKey = 'drill_agentphone_key';
  env.agentphone.agentId = 'drill-agent';
  env.agentphone.webhookSecret = 'drill-agentphone-secret';
  env.agentphone.fromNumber = '+14155550100';
  env.agentmail.apiKey = 'drill_agentmail_key';
  env.agentmail.inboxId = 'drill-inbox';
  env.agentmail.webhookSecret = 'drill-agentmail-secret';
  env.stripe.secretKey = 'sk_test_drill_reliability';
  env.stripe.webhookSecret = 'whsec_drill';
  env.browserUse.apiKey = 'drill_browser_use_key';
  env.moss.projectId = 'drill-moss-project';
  env.moss.projectKey = 'drill-moss-key';
}

function seedSponsorSmoke({ providerSmoke }, status) {
  for (const item of SMOKE_PROVIDERS) {
    providerSmoke.set(item.provider, status, {
      dryRun: true,
      live: false,
      simulated: true,
      sponsor: item.sponsor,
      drill: 'reliability',
      note: 'local drill marker; no provider request was made'
    });
  }
}

function seedQueueFixtures({ leads, queueLeadForOutreach }) {
  const ready = insertLead(leads, 'ready', {
    phone: '+14155550111',
    phone_classification: 'business_landline',
    source_url: 'https://example.test/ready'
  });
  queueLeadForOutreach({
    leadId: ready,
    profile: weakPresenceProfile('Ready Queue Fixture', '+14155550111', 'https://example.test/ready')
  });

  const backoff = insertLead(leads, 'backoff', {
    phone: '+14155550112',
    phone_classification: 'business_landline',
    outreach_status: 'retry',
    next_action: `retry_after:${Date.now() + 600000}`,
    source_url: 'https://example.test/backoff'
  });

  const quota = insertLead(leads, 'quota', {
    phone: '+14155550113',
    phone_classification: 'business_landline',
    outreach_status: 'queued',
    next_action: 'call',
    source_url: 'https://example.test/quota'
  });

  const strong = insertLead(leads, 'strong', {
    phone: '+14155550114',
    phone_classification: 'business_landline',
    outreach_status: 'not_queued',
    next_action: null,
    source_url: 'https://example.test/strong'
  });

  return { ready, backoff, quota, strong };
}

async function scenarioBaselineReady(ctx, leadIds) {
  seedConfiguredPosture(ctx);
  seedSponsorSmoke(ctx, 'ok');
  markAutonomyResumed(ctx, 'drill_baseline_unpaused');
  const readiness = ctx.liveReadiness();
  const status = ctx.outreachStatus();
  const callability = ctx.explainLeadCallability(leadIds.ready);
  const assertions = [
    assertion('readiness is ready', readiness.ready === true, readiness.blockers),
    assertion('live side effects are disabled', allLiveSideEffectsDisabled(ctx.env), ctx.env.live),
    assertion('smoke toggles are disabled', allSmokeTogglesDisabled(readiness.smokeToggles), readiness.smokeToggles),
    assertion('outreach queue exists', status.queue.queued >= 1, status.queue),
    assertion('fixture is callable before injected blocks', callability.callable === true, callability.blockers)
  ];
  return scenario('baseline_ready', 'readiness', assertions, {
    expected: 'configured autonomous_live posture with no live provider calls and at least one callable queued fixture',
    observed: {
      ready: readiness.ready,
      blockers: readiness.blockers,
      queue: status.queue,
      callability: compactCallability(callability)
    },
    sideEffects: isolatedSideEffects()
  });
}

async function scenarioSponsorMissingProvider(ctx) {
  seedConfiguredPosture(ctx);
  seedSponsorSmoke(ctx, 'ok');
  ctx.env.agentphone.apiKey = '';
  ctx.providerSmoke.set('agentphone', 'failed', {
    dryRun: true,
    live: false,
    simulated: true,
    sponsor: 'AgentPhone',
    error: 'simulated sponsor outage: auth endpoint unavailable'
  });
  const readiness = ctx.liveReadiness();
  const assertions = [
    assertion('readiness fails closed', readiness.ready === false, readiness.blockers),
    assertion('agentphone blocker is surfaced', readiness.blockers.includes('agentphone not configured'), readiness.blockers),
    assertion('provider lastError is surfaced', readiness.providers.agentphone.lastError === 'simulated sponsor outage: auth endpoint unavailable', readiness.providers.agentphone)
  ];
  seedConfiguredPosture(ctx);
  return scenario('sponsor_outage_required_provider', 'sponsor_outage', assertions, {
    expected: 'required provider outage is represented as an unready system with a machine-readable blocker',
    observed: {
      ready: readiness.ready,
      blockers: readiness.blockers,
      provider: readiness.providers.agentphone
    },
    sideEffects: isolatedSideEffects()
  });
}

async function scenarioSponsorSmokeDegraded(ctx) {
  seedConfiguredPosture(ctx);
  seedSponsorSmoke(ctx, 'ok');
  ctx.providerSmoke.set('stripe', 'failed', {
    dryRun: true,
    live: false,
    simulated: true,
    sponsor: 'Stripe',
    error: 'simulated 503 from hosted invoice API'
  });
  ctx.providerSmoke.set('browserUse', 'degraded', {
    dryRun: true,
    live: false,
    simulated: true,
    sponsor: 'Browser Use',
    lastError: 'simulated session queue delay'
  });
  const readiness = ctx.liveReadiness();
  const degraded = degradedProviders(readiness);
  const assertions = [
    assertion('configured providers can remain ready while smoke is degraded', readiness.ready === true, readiness.blockers),
    assertion('degraded smoke rows are machine-readable', degraded.length === 2, degraded),
    assertion('stripe failure is visible', degraded.some((p) => p.provider === 'stripe' && p.lastError), degraded),
    assertion('browserUse degradation is visible', degraded.some((p) => p.provider === 'browserUse' && p.lastError), degraded)
  ];
  seedSponsorSmoke(ctx, 'ok');
  return scenario('degraded_sponsor_smoke', 'degraded_readiness', assertions, {
    expected: 'non-side-effect smoke failures stay in JSON so operators can see degraded sponsors without placing calls, sending mail, or creating invoices',
    observed: {
      ready: readiness.ready,
      blockers: readiness.blockers,
      degraded
    },
    sideEffects: isolatedSideEffects()
  });
}

async function scenarioQueuePaused(ctx, leadId) {
  seedConfiguredPosture(ctx);
  seedSponsorSmoke(ctx, 'ok');
  ctx.pauseOutreachLoop({ reason: 'drill_pause_backpressure' });
  const status = ctx.outreachStatus();
  const callability = ctx.explainLeadCallability(leadId);
  const blocker = findBlocker(callability, 'autonomy_paused');
  const assertions = [
    assertion('outreach reports paused', status.paused === true, {
      paused: status.paused,
      pauseReason: status.pauseReason,
      running: status.running
    }),
    assertion('callability blocks on pause', Boolean(blocker), callability.blockers),
    assertion('pause block suggests resume action', callability.nextAction === 'resume_autonomy', compactCallability(callability))
  ];
  markAutonomyResumed(ctx, 'drill_pause_restored');
  return scenario('queue_block_autonomy_paused', 'queue_block', assertions, {
    expected: 'operator pause prevents queue dispatch and produces a resume action',
    observed: {
      outreach: {
        paused: status.paused,
        pauseReason: status.pauseReason,
        running: status.running
      },
      callability: compactCallability(callability)
    },
    sideEffects: isolatedSideEffects()
  });
}

async function scenarioQueueRetryBackoff(ctx, leadId) {
  seedConfiguredPosture(ctx);
  seedSponsorSmoke(ctx, 'ok');
  markAutonomyResumed(ctx, 'drill_retry_unpaused');
  const callability = ctx.explainLeadCallability(leadId);
  const blocker = findBlocker(callability, 'retry_backoff');
  const assertions = [
    assertion('retry_backoff blocker is present', Boolean(blocker), callability.blockers),
    assertion('retry blocker is temporary', blocker?.temporary === true, blocker),
    assertion('retry action waits instead of calling', callability.nextAction === 'wait_for_retry_backoff', compactCallability(callability))
  ];
  return scenario('queue_block_retry_backoff', 'queue_block', assertions, {
    expected: 'recent retry is held until its dueAt instead of being called immediately',
    observed: {
      callability: compactCallability(callability),
      retry: callability.retry
    },
    sideEffects: isolatedSideEffects()
  });
}

async function scenarioQueueDailyQuota(ctx, leadId) {
  seedConfiguredPosture(ctx);
  seedSponsorSmoke(ctx, 'ok');
  markAutonomyResumed(ctx, 'drill_quota_unpaused');
  ctx.callAttempts.add({
    id: `drill_quota_${Date.now().toString(36)}`,
    phone: '+14155550999',
    allowed: true,
    reason: 'drill quota fill'
  });
  const callability = ctx.explainLeadCallability(leadId);
  const blocker = findBlocker(callability, 'daily_quota');
  const assertions = [
    assertion('daily quota blocker is present', Boolean(blocker), callability.blockers),
    assertion('quota is enforced outside mock mode', callability.quota.enforced === true, callability.quota),
    assertion('quota action waits for reset', callability.nextAction === 'wait_for_quota_reset', compactCallability(callability))
  ];
  return scenario('queue_block_daily_quota', 'queue_block', assertions, {
    expected: 'filled daily quota prevents another call from being routed',
    observed: {
      callability: compactCallability(callability),
      quota: callability.quota
    },
    sideEffects: isolatedSideEffects()
  });
}

async function scenarioStrongPresenceBlocked(ctx, leadId) {
  seedConfiguredPosture(ctx);
  seedSponsorSmoke(ctx, 'ok');
  const result = ctx.queueLeadForOutreach({
    leadId,
    profile: {
      businessName: 'Strong Presence Fixture',
      phone: '+14155550114',
      hasWebsite: true,
      websiteUrl: 'https://strong-presence.example.test',
      onlinePresenceStrength: 'strong',
      onlinePresenceSummary: 'Modern site with reviews, service pages, location information, and booking.',
      signals: ['owned website', 'booking flow', 'service pages', 'reviews'],
      sourceUrl: 'https://example.test/strong'
    }
  });
  const lead = ctx.leads.get(leadId);
  const assertions = [
    assertion('strong presence is not queued', result?.queued === false, {
      queued: result?.queued,
      reason: result?.reason
    }),
    assertion('lead is visibly blocked', ['blocked_visible', 'blocked'].includes(lead.outreach_status), compactLead(lead)),
    assertion('next action explains no-call reason', lead.next_action === 'do_not_call_strong_presence', compactLead(lead))
  ];
  return scenario('queue_block_strong_presence', 'queue_block', assertions, {
    expected: 'lead with strong online presence is blocked before outreach queue dispatch',
    observed: {
      result: {
        queued: result?.queued,
        reason: result?.reason
      },
      lead: compactLead(lead)
    },
    sideEffects: isolatedSideEffects()
  });
}

async function scenarioRouteChecks(ctx, baseUrl) {
  if (!baseUrl) {
    return {
      name: 'route_checks',
      category: 'api_routes',
      ok: true,
      skipped: true,
      skipReason: 'no --base-url or RELIABILITY_DRILL_BASE_URL was provided; this drill does not require or start a server',
      expected: 'route checks are optional and self-report skipped state when no server is supplied',
      observed: {
        staticRoutes: ctx.outreachRouteSmoke()
      },
      assertions: [],
      sideEffects: {
        kind: 'none',
        network: 'none'
      }
    };
  }

  const checks = [];
  for (const route of [
    { name: 'health', method: 'GET', path: '/api/health' },
    { name: 'outreach_status', method: 'GET', path: '/api/outreach/status' },
    { name: 'outreach_routes', method: 'GET', path: '/api/outreach/routes' }
  ]) {
    checks.push(await fetchRoute(baseUrl, route));
  }
  const assertions = [
    assertion('all route checks returned JSON 2xx', checks.every((c) => c.ok), checks),
    assertion('route checks are GET-only', checks.every((c) => c.method === 'GET'), checks)
  ];
  return scenario('route_checks', 'api_routes', assertions, {
    expected: 'optional server route checks use GET-only requests and report JSON health/backpressure surfaces',
    observed: {
      baseUrl,
      checks
    },
    sideEffects: {
      kind: 'read_only_http',
      network: 'loopback_or_supplied_base_url',
      mutations: []
    }
  });
}

async function fetchRoute(baseUrl, route) {
  const url = new URL(route.path, baseUrl).toString();
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: route.method,
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(1500)
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      return {
        ...route,
        ok: false,
        url,
        status: res.status,
        durationMs: Date.now() - started,
        error: `non-JSON response: ${text.slice(0, 160)}`
      };
    }
    return {
      ...route,
      ok: res.ok,
      url,
      status: res.status,
      durationMs: Date.now() - started,
      keys: json && typeof json === 'object' ? Object.keys(json).slice(0, 12) : [],
      sample: compactRouteSample(route.name, json)
    };
  } catch (err) {
    return {
      ...route,
      ok: false,
      url,
      durationMs: Date.now() - started,
      error: err?.message || String(err)
    };
  }
}

function insertLead(leads, name, patch = {}) {
  const id = `drill_${name}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id,
    container_tag: `drill_${name}_${id}`,
    business_name: `${titleize(name)} Reliability Fixture`,
    phone: '+14155550199',
    address: '1 Market St, San Francisco, CA',
    niche: 'local services',
    city: 'San Francisco',
    website: null,
    status: 'discovered',
    research_status: 'qualified',
    outreach_status: 'queued',
    risk_status: 'needs_callability_check',
    consent_status: 'public_business',
    phone_classification: 'business_landline',
    next_action: 'call',
    source_url: 'https://example.test/reliability',
    ...patch
  };
  return leads.insert(row).lead.id;
}

function markAutonomyResumed({ contactEvents, env }, reason) {
  contactEvents.add({
    lead_id: null,
    type: 'autonomy_resumed',
    direction: 'internal',
    channel: 'outreach',
    body: reason,
    metadata: { mode: env.runMode, drill: 'reliability' }
  });
}

function weakPresenceProfile(name, phone, sourceUrl) {
  return {
    businessName: name,
    phone,
    address: '1 Market St, San Francisco, CA',
    onlinePresenceStrength: 'weak',
    hasWebsite: false,
    websiteUrl: null,
    onlinePresenceSummary: 'No owned website found; directory listing has sparse service details.',
    signals: ['no owned site', 'thin listing'],
    sourceUrl
  };
}

function routeBaseUrl(parsedArgs) {
  const raw = parsedArgs.baseUrl || process.env.RELIABILITY_DRILL_BASE_URL || '';
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withProtocol).toString();
  } catch {
    return withProtocol;
  }
}

function parseArgs(argv) {
  const out = {
    baseUrl: '',
    keepData: false,
    help: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--keep-data') out.keepData = true;
    else if (arg === '--base-url') out.baseUrl = argv[++i] || '';
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
  }
  return out;
}

function helpPayload() {
  return {
    ok: true,
    usage: 'npm run drill:reliability -- [--base-url http://127.0.0.1:8787] [--keep-data]',
    description: 'Runs an isolated reliability/backpressure drill and emits JSON only.',
    flags: {
      '--base-url': 'Optional running server base URL for GET-only route checks. Omit to self-report route checks as skipped.',
      '--keep-data': 'Keep the temporary SQLite data dir for manual inspection.'
    }
  };
}

function assertion(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}

function scenario(name, category, assertions, extra = {}) {
  return {
    name,
    category,
    ok: assertions.every((item) => item.ok),
    skipped: false,
    expected: extra.expected,
    observed: extra.observed,
    assertions,
    sideEffects: extra.sideEffects || isolatedSideEffects()
  };
}

function summarize(scenarios) {
  const skipped = scenarios.filter((s) => s.skipped).length;
  const failed = scenarios.filter((s) => !s.skipped && !s.ok).length;
  const passed = scenarios.filter((s) => !s.skipped && s.ok).length;
  return {
    total: scenarios.length,
    passed,
    failed,
    skipped,
    categories: scenarios.reduce((acc, scenarioItem) => {
      acc[scenarioItem.category] = (acc[scenarioItem.category] || 0) + 1;
      return acc;
    }, {})
  };
}

function liveSideEffectPosture(env) {
  return {
    runMode: env.runMode,
    live: env.live,
    smokeToggles: env.smoke,
    disabled: allLiveSideEffectsDisabled(env) && allSmokeTogglesDisabled(env.smoke),
    note: 'The drill imports helpers but does not call provider adapters, place calls, send email, create invoices, or start Browser Use sessions.'
  };
}

function isolatedSideEffects() {
  return {
    kind: 'isolated_sqlite_only',
    liveProviderRequests: 0,
    outboundCalls: 0,
    outboundEmails: 0,
    invoicesCreated: 0,
    browserSessionsCreated: 0
  };
}

function allLiveSideEffectsDisabled(env) {
  return Object.values(env.live || {}).every((value) => value === false);
}

function allSmokeTogglesDisabled(toggles) {
  return Object.values(toggles || {}).every((value) => value === false || value === '');
}

function sponsorMatrix(ctx) {
  const readiness = ctx.liveReadiness();
  return SPONSOR_PROVIDERS.map((item) => {
    if (!item.provider) {
      return {
        sponsor: item.sponsor,
        provider: null,
        covered: false,
        note: 'listed sponsor has no local provider adapter in this repo'
      };
    }
    const provider = readiness.providers[item.provider] || null;
    return {
      sponsor: item.sponsor,
      provider: item.provider,
      covered: Boolean(provider),
      configured: provider?.configured ?? null,
      required: provider?.required ?? null,
      smokeStatus: provider?.smoke?.status || null,
      lastError: provider?.lastError || null
    };
  });
}

function degradedProviders(readiness) {
  return Object.entries(readiness.providers || {})
    .filter(([, value]) => {
      const status = value?.smoke?.status;
      return status && !['ok', 'configured'].includes(status);
    })
    .map(([provider, value]) => ({
      provider,
      status: value.smoke.status,
      configured: value.configured,
      required: value.required,
      checkedAt: value.smoke.checkedAt,
      lastError: value.lastError || value.smoke?.status || null
    }));
}

function findBlocker(callability, name) {
  return (callability.blockers || []).find((blocker) => blocker.name === name) || null;
}

function compactCallability(callability) {
  return {
    callable: callability.callable,
    decision: callability.decision,
    leadId: callability.leadId,
    state: callability.state,
    nextAction: callability.nextAction,
    blockers: (callability.blockers || []).map((blocker) => ({
      name: blocker.name,
      reason: blocker.reason,
      temporary: Boolean(blocker.temporary),
      terminal: Boolean(blocker.terminal),
      dueAt: blocker.dueAt || null
    })),
    gates: (callability.gates || []).map((gate) => ({
      name: gate.name,
      ok: gate.ok,
      reason: gate.reason || null
    }))
  };
}

function compactLead(lead) {
  return {
    id: lead.id,
    businessName: lead.business_name,
    status: lead.status,
    researchStatus: lead.research_status,
    outreachStatus: lead.outreach_status,
    riskStatus: lead.risk_status,
    nextAction: lead.next_action,
    blockedReason: lead.blocked_reason
  };
}

function compactRouteSample(name, json) {
  if (!json || typeof json !== 'object') return json;
  if (name === 'health') {
    return {
      ok: json.ok,
      mode: json.mode,
      liveBlockers: json.liveBlockers || [],
      readinessReady: json.readiness?.ready
    };
  }
  if (name === 'outreach_status') {
    return {
      running: json.running,
      paused: json.paused,
      queue: json.queue,
      quota: json.quota
    };
  }
  if (name === 'outreach_routes') {
    return {
      ok: json.ok,
      routeCount: Array.isArray(json.routes) ? json.routes.length : 0,
      controls: json.controls || []
    };
  }
  return json;
}

function cleanupTempData(dir, keepData) {
  if (keepData) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function safeCloseDb(db) {
  try {
    db?.close?.();
  } catch {
    // Best-effort cleanup only.
  }
}

function titleize(value) {
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
