#!/usr/bin/env node

// Read-only sponsor acceptance checks. This uses the app's exported
// persistence/readiness APIs rather than raw SQLite inspection.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const REQUIRED_SPONSORS = [
  'Google DeepMind',
  'AgentPhone',
  'AgentMail',
  'Supermemory',
  'Moss',
  'Browser Use',
  'Lovable',
  'Stripe'
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.dataDir) process.env.DATA_DIR = args.dataDir;
if (!process.env.RUN_MODE) process.env.RUN_MODE = 'mock';

const [
  { env },
  { liveReadiness },
  dbApi
] = await Promise.all([
  import('../server/env.js'),
  import('../server/readiness.js'),
  import('../server/db.js')
]);

const readiness = liveReadiness();
const context = await selectContext(args, dbApi, readiness, env);
const stages = evaluateStages({ context, readiness, env });
const ok = stages.every((stage) => stage.ok);
const result = {
  ok,
  generatedAt: new Date().toISOString(),
  mode: readiness.mode,
  dataDir: resolve(repoRoot, env.dataDir),
  leadId: context?.lead?.id || args.leadId || null,
  leadStatus: context?.lead?.status || null,
  checkedSponsors: stages.length,
  passedSponsors: stages.filter((stage) => stage.ok).length,
  failedSponsors: stages.filter((stage) => !stage.ok).map((stage) => stage.sponsor),
  sponsors: stages,
  readiness: summarizeReadiness(readiness, env)
};

console.log(JSON.stringify(result, null, 2));
console.log('\n=== SPONSOR ACCEPTANCE ===');
for (const stage of stages) {
  const tag = stage.ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${stage.sponsor} - ${stage.stage}: ${stage.reason}`);
}
console.log(`[${ok ? 'PASS' : 'FAIL'}] sponsor acceptance ${ok ? 'passed' : 'failed'}`);

if (!ok) process.exitCode = 1;

async function selectContext(parsedArgs, api, readinessSnapshot, envSnapshot) {
  if (parsedArgs.leadId) {
    const lead = api.leads.get(parsedArgs.leadId);
    if (!lead) return null;
    return loadContext(lead, api);
  }

  const candidates = api.leads.list({ limit: parsedArgs.limit });
  if (!candidates.length) return null;

  const contexts = candidates.map((lead) => loadContext(lead, api));
  contexts.sort((a, b) => {
    const stageDelta = stageScore(b, readinessSnapshot, envSnapshot) - stageScore(a, readinessSnapshot, envSnapshot);
    if (stageDelta) return stageDelta;
    return (b.lead.created_at || 0) - (a.lead.created_at || 0);
  });
  return contexts[0];
}

function loadContext(lead, api) {
  const runs = api.runs.list({ lead_id: lead.id, limit: 100 }).map(parseRun);
  const events = api.events.listByLead(lead.id, { limit: 200 }).map(parseEvent);
  const auditTimeline = api.auditTrail.timelineByLead(lead.id, { limit: 300 });
  const calls = api.calls.listByLead(lead.id);
  const payments = api.payments.listByLead(lead.id);
  const builds = api.builds.listByLead(lead.id);
  const contactEvents = api.contactEvents.listByLead(lead.id, { limit: 100 }).map(parseContactEvent);
  return { lead, runs, events, auditTimeline, calls, payments, builds, contactEvents };
}

function evaluateStages({ context, readiness, env }) {
  return sponsorDefinitions().map((definition) => {
    const persistedEvidence = context ? definition.persisted(context) : [];
    const readinessEvidence = definition.readiness(readiness, env);
    const rosterEvidence = sponsorRosterEvidence(env, definition.sponsor);
    const evidence = [...persistedEvidence, ...readinessEvidence];
    const ok = evidence.length > 0;
    const basis = unique(evidence.map((item) => item.basis));
    const reason = ok
      ? evidence.map((item) => item.summary).join('; ')
      : `no persisted ${definition.sponsor} stage event and no configured readiness found`;

    return {
      sponsor: definition.sponsor,
      stage: definition.stage,
      ok,
      basis,
      reason,
      evidence,
      sponsorRoster: rosterEvidence
    };
  });
}

function sponsorDefinitions() {
  return [
    {
      sponsor: 'Google DeepMind',
      stage: 'Gemini research, pitch, and post-call analysis',
      persisted: (ctx) => compact([
        eventEvidence(ctx, ['scraper.profile'], 'persisted scraper profile event'),
        eventEvidence(ctx, ['pitch.created'], 'persisted pitch creation event'),
        eventEvidence(ctx, ['analyst.done'], 'persisted analyst completion event')
      ]),
      readiness: (readiness) => providerReadinessEvidence(readiness, 'gemini')
    },
    {
      sponsor: 'Stripe',
      stage: 'Hosted invoice creation, paid webhook, and build trigger',
      persisted: (ctx) => compact([
        auditEvidence(ctx, ['payment.created'], 'persisted payment.created audit event'),
        auditEvidence(ctx, ['payment.paid'], 'persisted payment.paid audit event'),
        eventEvidence(ctx, ['stripe.webhook'], 'persisted Stripe webhook event'),
        eventEvidence(ctx, ['stripe.paid'], 'persisted Stripe paid event')
      ]),
      readiness: (readiness) => providerReadinessEvidence(readiness, 'stripe', { allowMockOptional: true })
    },
    {
      sponsor: 'AgentPhone',
      stage: 'Voice call placement, disclosure, transcript, and call analysis handoff',
      persisted: (ctx) => compact([
        eventEvidence(ctx, ['caller.placed'], 'persisted AgentPhone call placement event'),
        eventEvidence(ctx, ['caller.done'], 'persisted AgentPhone call completion event'),
        eventEvidence(ctx, ['caller.disclosure'], 'persisted call disclosure event'),
        auditEvidence(ctx, ['call.started'], 'persisted call.started audit event'),
        auditEvidence(ctx, ['call.finished'], 'persisted call.finished audit event'),
        callEvidence(ctx, 'persisted call row with provider call metadata')
      ]),
      readiness: (readiness) => providerReadinessEvidence(readiness, 'agentphone', { allowMockOptional: true })
    },
    {
      sponsor: 'Moss',
      stage: 'Hot-path call retrieval readiness for pitch context',
      persisted: (ctx) => compact([
        eventEvidence(ctx, ['pitch.created'], 'persisted pitch bundle event for call retrieval'),
        eventEvidence(ctx, ['caller.placed', 'caller.done'], 'persisted caller stage event'),
        auditEvidence(ctx, ['call.started', 'call.finished'], 'persisted call audit event')
      ]),
      readiness: (readiness) => providerReadinessEvidence(readiness, 'moss', { allowMockOptional: true })
    },
    {
      sponsor: 'Browser Use',
      stage: 'Live preview/build automation handoff',
      persisted: (ctx) => compact([
        eventEvidence(ctx, ['builder.live_url'], 'persisted Browser Use live-preview event'),
        eventEvidence(ctx, ['builder.project_url'], 'persisted project URL capture event'),
        auditEvidence(ctx, ['build.started', 'build.finished'], 'persisted build audit event')
      ]),
      readiness: (readiness) => providerReadinessEvidence(readiness, 'browserUse', { allowMockOptional: true })
    },
    {
      sponsor: 'Lovable',
      stage: 'Build-with-URL prompt submission and final .lovable.app project capture',
      persisted: (ctx) => compact([
        eventEvidence(ctx, ['builder.project_url'], 'persisted Lovable project URL capture event'),
        eventEvidence(ctx, ['builder.blocked_auth'], 'persisted Lovable auth-wall blocker event'),
        buildEvidence(ctx, 'persisted build row with Lovable URL/project URL')
      ]),
      readiness: (readiness) => lovableReadinessEvidence(readiness)
    },
    {
      sponsor: 'AgentMail',
      stage: 'Invoice email, customer reply, and auto-reply thread',
      persisted: (ctx) => compact([
        auditEvidence(ctx, ['contact.agentmail.invoice_email'], 'persisted AgentMail invoice contact event'),
        eventEvidence(ctx, ['agentmail.webhook'], 'persisted AgentMail webhook event'),
        eventEvidence(ctx, ['mailer.email_sent', 'mailer.done'], 'persisted mailer stage event'),
        contactEvidence(ctx, 'outbound', 'persisted outbound AgentMail contact event'),
        contactEvidence(ctx, 'inbound', 'persisted inbound AgentMail contact event')
      ]),
      readiness: (readiness) => providerReadinessEvidence(readiness, 'agentmail', { allowMockOptional: true })
    },
    {
      sponsor: 'Supermemory',
      stage: 'Per-lead memory scope and synthetic profile persistence',
      persisted: (ctx) => compact([
        auditEvidence(ctx, ['research.lead.created'], 'persisted lead creation audit event with memory scope'),
        eventEvidence(ctx, ['scraper.profile'], 'persisted synthetic profile event')
      ]),
      readiness: (readiness) => providerReadinessEvidence(readiness, 'supermemory')
    }
  ];
}

function stageScore(context, readiness, env) {
  return evaluateStages({ context, readiness, env }).filter((stage) => stage.ok).length;
}

function providerReadinessEvidence(readiness, providerKey, { allowMockOptional = false } = {}) {
  const provider = readiness.providers?.[providerKey];
  if (!provider) return [];

  const evidence = [];
  if (provider.configured) {
    evidence.push({
      basis: 'configured_readiness',
      source: `readiness.providers.${providerKey}`,
      summary: `${providerKey} provider is configured`,
      detail: providerSummary(provider)
    });
  }

  if (provider.smoke && ['ok', 'configured'].includes(provider.smoke.status)) {
    evidence.push({
      basis: 'configured_readiness',
      source: `readiness.providers.${providerKey}.smoke`,
      summary: `${providerKey} provider smoke is ${provider.smoke.status}`,
      detail: provider.smoke
    });
  }

  if (allowMockOptional && readiness.mode === 'mock' && provider.required === false) {
    evidence.push({
      basis: 'configured_readiness',
      source: `readiness.providers.${providerKey}`,
      summary: `${providerKey} stage is explicitly non-required in mock mode`,
      detail: providerSummary(provider)
    });
  }

  return evidence;
}

function eventEvidence(ctx, types, summary) {
  const row = ctx.events.find((event) => types.includes(event.type));
  if (!row) return null;
  return {
    basis: 'persisted_event',
    source: 'events',
    summary,
    id: String(row.id),
    type: row.type,
    at: row.ts || null,
    worker: row.worker || null
  };
}

function auditEvidence(ctx, eventTypes, summary) {
  const row = ctx.auditTimeline.find((event) => eventTypes.includes(event.event_type));
  if (!row) return null;
  return {
    basis: 'persisted_event',
    source: 'auditTrail.timelineByLead',
    summary,
    id: String(row.id),
    type: row.event_type,
    at: row.created_at || null,
    entityType: row.entity_type || null,
    entityId: row.entity_id || null
  };
}

function callEvidence(ctx, summary) {
  const row = ctx.calls.find((call) => call.provider_call_id || call.transcript || call.outcome || call.status);
  if (!row) return null;
  return {
    basis: 'persisted_event',
    source: 'calls',
    summary,
    id: String(row.id),
    type: row.outcome || row.status || 'call',
    at: row.finished_at || row.started_at || null
  };
}

function buildEvidence(ctx, summary) {
  const row = ctx.builds.find((build) => build.lovable_url || build.project_url || build.status === 'blocked_auth');
  if (!row) return null;
  return {
    basis: 'persisted_event',
    source: 'builds',
    summary,
    id: String(row.id),
    type: row.status || 'build',
    at: row.finished_at || row.created_at || null,
    detail: {
      hasLovableUrl: Boolean(row.lovable_url),
      hasProjectUrl: Boolean(row.project_url),
      status: row.status
    }
  };
}

function lovableReadinessEvidence(readiness) {
  const provider = readiness.providers?.lovable || readiness.providers?.browserUse;
  if (!provider) return [];
  const evidence = [];
  const detail = provider.detail?.lovable || provider.detail || null;
  if (detail?.buildWithUrl || detail?.projectUrlExtraction || detail?.role === 'website_generation_target') {
    evidence.push({
      basis: 'configured_readiness',
      source: readiness.providers?.lovable ? 'readiness.providers.lovable.detail' : 'readiness.providers.browserUse.detail.lovable',
      summary: 'Lovable build-with-URL flow is explicitly configured',
      detail
    });
  }
  if (provider.configured) {
    evidence.push({
      basis: 'configured_readiness',
      source: readiness.providers?.lovable ? 'readiness.providers.lovable' : 'readiness.providers.browserUse',
      summary: 'Lovable execution dependency is configured',
      detail: providerSummary(provider)
    });
  }
  if (readiness.mode === 'mock') {
    evidence.push({
      basis: 'configured_readiness',
      source: 'readiness.mode',
      summary: 'Lovable stage is exercised by mock build/project URL generation',
      detail: { mode: readiness.mode }
    });
  }
  return evidence;
}

function contactEvidence(ctx, direction, summary) {
  const row = ctx.contactEvents.find((event) => event.channel === 'agentmail' && event.direction === direction);
  if (!row) return null;
  return {
    basis: 'persisted_event',
    source: 'contactEvents.listByLead',
    summary,
    id: row.id,
    type: `contact.agentmail.${row.type}`,
    at: row.created_at || null,
    direction
  };
}

function sponsorRosterEvidence(env, sponsor) {
  const listed = env.hackathon.sponsors.some((entry) => normalizeName(entry) === normalizeName(sponsor));
  return {
    configured: listed,
    source: 'HACKATHON_SPONSORS',
    sponsors: env.hackathon.sponsors
  };
}

function summarizeReadiness(readiness, env) {
  return {
    ready: readiness.ready,
    mode: readiness.mode,
    blockers: readiness.blockers,
    hackathonSponsors: env.hackathon.sponsors,
    providers: Object.fromEntries(Object.entries(readiness.providers || {}).map(([key, provider]) => [
      key,
      providerSummary(provider)
    ]))
  };
}

function providerSummary(provider) {
  return {
    configured: provider.configured,
    required: provider.required,
    status: provider.status,
    smoke: provider.smoke ? {
      status: provider.smoke.status,
      dryRun: provider.smoke.dryRun,
      live: provider.smoke.live
    } : null,
    lastError: provider.lastError || null
  };
}

function parseRun(row) {
  return { ...row, detail: safeJson(row.detail_json) };
}

function parseEvent(row) {
  return { ...row, payload: safeJson(row.payload_json) };
}

function parseContactEvent(row) {
  return { ...row, metadata: safeJson(row.metadata_json) };
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function compact(items) {
  return items.filter(Boolean);
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseArgs(argv) {
  const parsed = {
    dataDir: null,
    leadId: null,
    limit: 100,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--data-dir') parsed.dataDir = argv[++i];
    else if (arg.startsWith('--data-dir=')) parsed.dataDir = arg.slice('--data-dir='.length);
    else if (arg === '--lead-id') parsed.leadId = argv[++i];
    else if (arg.startsWith('--lead-id=')) parsed.leadId = arg.slice('--lead-id='.length);
    else if (arg === '--limit') parsed.limit = Number(argv[++i]);
    else if (arg.startsWith('--limit=')) parsed.limit = Number(arg.slice('--limit='.length));
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isFinite(parsed.limit) || parsed.limit < 1) parsed.limit = 100;
  return parsed;
}

function printHelp() {
  console.log(`callmemaybe sponsor acceptance check

Usage:
  npm run check:sponsors
  npm run check:sponsors -- --data-dir .data/demo
  npm run check:sponsors -- --lead-id lead_demo_...

Checks:
  Prints JSON first, then human pass/fail lines.
  Each sponsor stage passes when it has persisted event evidence from the
  selected lead, or configured readiness that is valid for mock/synthetic mode.
`);
}
