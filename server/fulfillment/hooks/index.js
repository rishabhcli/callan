import { emit } from '../../sse.js';
import { buildHooks, buildQaResults, buildRevisions } from '../../db.js';
import { createLovablePromptUrl, inspectGeneratedSite, browserUseSiteInspectionEnabled } from '../../providers/browserUse.js';
import { buildWebsiteBrief, createLovableBuildPrompt, renderMockGeneratedSite, validateWebsiteBrief } from './brief.js';
import { createRevisionPlan } from './revision.js';

export const BUILD_HOOKS = [
  'preBrief',
  'briefValidate',
  'preSubmit',
  'postSubmit',
  'siteInspect',
  'revisionPlan',
  'finalAccept'
];

const DEFAULT_MAX_REVISIONS = 2;

export { buildWebsiteBrief, createLovableBuildPrompt, renderMockGeneratedSite, validateWebsiteBrief };

export async function prepareBuildSubmission({
  lead,
  buildId,
  runId,
  profileDoc,
  postMortemDoc,
  latestPayment
}) {
  const leadId = lead?.id;
  const websiteBrief = await runBuildHook({
    hook: 'preBrief',
    buildId,
    leadId,
    runId,
    input: { leadId, profileFound: Boolean(profileDoc), postMortemFound: Boolean(postMortemDoc) },
    fn: () => buildWebsiteBrief({ lead, profileDoc, postMortemDoc, latestPayment })
  });

  const validation = await runBuildHook({
    hook: 'briefValidate',
    buildId,
    leadId,
    runId,
    input: { websiteBrief },
    fn: () => validateWebsiteBrief(websiteBrief)
  });

  if (!validation.ok) {
    emit('builder.progress', {
      worker: 'builder',
      leadId,
      runId,
      buildId,
      phase: 'brief_validate',
      summary: `Brief blocked: ${validation.errors.map((e) => e.code).join(', ')}`
    });
    return {
      ok: false,
      websiteBrief,
      validation,
      brief: null,
      lovableUrl: null
    };
  }

  const submission = await runBuildHook({
    hook: 'preSubmit',
    buildId,
    leadId,
    runId,
    input: { websiteBrief },
    fn: () => {
      const brief = createLovableBuildPrompt(websiteBrief);
      return {
        brief,
        lovableUrl: createLovablePromptUrl(brief),
        promptLength: brief.length
      };
    }
  });

  return {
    ok: true,
    websiteBrief,
    validation,
    brief: submission.brief,
    lovableUrl: submission.lovableUrl
  };
}

export async function recordBuildSubmission({
  leadId,
  buildId,
  runId,
  provider,
  liveUrl,
  projectUrl = null,
  sessionId = null,
  submissionUrl = null,
  lovableUrl = null,
  mock = false
}) {
  return runBuildHook({
    hook: 'postSubmit',
    buildId,
    leadId,
    runId,
    input: { provider, liveUrl, projectUrl, sessionId, submissionUrl, lovableUrl, mock },
    fn: () => ({
      provider,
      liveUrl,
      projectUrl,
      sessionId,
      submissionUrl,
      lovableUrl,
      mock,
      submittedAt: Date.now()
    })
  });
}

export async function runBuildQaGate({
  lead,
  buildId,
  runId,
  websiteBrief,
  brief,
  candidateUrl,
  candidateHtml = null,
  adapter = null,
  sessionId = null,
  mock = false,
  onProjectUrl = null,
  maxRevisions = maxRevisionCount()
}) {
  const leadId = lead?.id;
  let inspectedUrl = candidateUrl;
  let inspectedHtml = candidateHtml;
  let latestQa = null;
  const revisions = [];

  for (let attempt = 0; attempt <= maxRevisions; attempt += 1) {
    latestQa = await inspectAndPersist({
      lead,
      leadId,
      buildId,
      runId,
      attempt,
      websiteBrief,
      inspectedUrl,
      inspectedHtml,
      adapter,
      sessionId,
      mock
    });

    if (latestQa.passed) {
      const accepted = await runBuildHook({
        hook: 'finalAccept',
        buildId,
        leadId,
        runId,
        attempt,
        input: { qaResultId: latestQa.id, passed: true },
        fn: () => ({
          accepted: true,
          qaResultId: latestQa.id,
          attempt,
          shippedUrl: inspectedUrl,
          summary: 'QA passed; build can be marked shipped.'
        })
      });
      return { accepted: true, qa: latestQa, revisions, finalAccept: accepted, projectUrl: inspectedUrl };
    }

    if (attempt >= maxRevisions) break;

    const plan = await runBuildHook({
      hook: 'revisionPlan',
      buildId,
      leadId,
      runId,
      attempt,
      input: { qaResultId: latestQa.id, errors: latestQa.errors },
      fn: () => createRevisionPlan({ brief: websiteBrief, qaResult: latestQa, attempt })
    });

    const revision = buildRevisions.start({
      build_id: buildId,
      lead_id: leadId,
      attempt: attempt + 1,
      qa_result_id: latestQa.id,
      prompt: plan.prompt,
      idempotency_key: `build:${buildId}:revision:${attempt + 1}`
    });

    emit('builder.revision', {
      worker: 'builder',
      leadId,
      runId,
      buildId,
      attempt: attempt + 1,
      revisionId: revision.id,
      summary: `Revision ${attempt + 1} planned for ${plan.focus.join(', ') || 'QA failures'}.`,
      prompt: plan.prompt,
      mock
    });

    if (mock) {
      inspectedHtml = renderMockGeneratedSite({ brief: websiteBrief, revisionPrompt: plan.prompt });
      buildRevisions.finish(revision.id, {
        status: 'submitted',
        result: { mock: true, projectUrl: inspectedUrl, promptLength: plan.prompt.length }
      });
      revisions.push({ ...revision, prompt: plan.prompt, result: { mock: true } });
      continue;
    }

    if (adapter && sessionId) {
      const result = await submitLiveRevision({ adapter, sessionId, inspectedUrl, plan, leadId, buildId, runId, onProjectUrl });
      inspectedUrl = result.projectUrl || inspectedUrl;
      inspectedHtml = null;
      buildRevisions.finish(revision.id, {
        status: result.projectUrl ? 'submitted' : 'unknown_result',
        result
      });
      revisions.push({ ...revision, prompt: plan.prompt, result });
      continue;
    }

    buildRevisions.finish(revision.id, {
      status: 'skipped',
      result: { reason: 'no_live_revision_adapter' }
    });
    revisions.push({ ...revision, prompt: plan.prompt, result: { skipped: true } });
  }

  const rejected = await runBuildHook({
    hook: 'finalAccept',
    buildId,
    leadId,
    runId,
    attempt: maxRevisions,
    input: { qaResultId: latestQa?.id, passed: false },
    fn: () => ({
      accepted: false,
      qaResultId: latestQa?.id || null,
      attempt: maxRevisions,
      summary: 'QA failed after revision limit; build must not be shipped.',
      errors: latestQa?.errors || []
    })
  });

  return { accepted: false, qa: latestQa, revisions, finalAccept: rejected, projectUrl: inspectedUrl };
}

export function buildQaReadModel({ leadId, buildId }) {
  const hooks = buildId ? buildHooks.listByBuild(buildId) : buildHooks.listByLead(leadId);
  const qaResults = buildId ? buildQaResults.listByBuild(buildId) : buildQaResults.listByLead(leadId);
  const revisions = buildId ? buildRevisions.listByBuild(buildId) : buildRevisions.listByLead(leadId);
  const latestQa = qaResults[0] || null;
  const validation = [...hooks].reverse().find((row) => row.hook === 'briefValidate')?.output || null;
  return {
    leadId,
    buildId: buildId || null,
    status: latestQa ? (latestQa.passed ? 'passed' : 'failed') : hooks.length ? 'running' : 'not_started',
    hooks,
    validation,
    qaResults,
    latestQa,
    revisions,
    maxRevisions: maxRevisionCount()
  };
}

async function inspectAndPersist({
  lead,
  leadId,
  buildId,
  runId,
  attempt,
  websiteBrief,
  inspectedUrl,
  inspectedHtml,
  adapter,
  sessionId,
  mock
}) {
  const qa = await runBuildHook({
    hook: 'siteInspect',
    buildId,
    leadId,
    runId,
    attempt,
    input: {
      url: inspectedUrl,
      hasHtml: Boolean(inspectedHtml),
      browserUse: Boolean(adapter && sessionId && browserUseSiteInspectionEnabled())
    },
    fn: async () => {
      const deterministic = await inspectGeneratedSite({
        url: inspectedUrl,
        html: inspectedHtml,
        brief: websiteBrief,
        lead,
        mock
      });

      if (adapter && sessionId && browserUseSiteInspectionEnabled()) {
        const browserUse = await adapter.inspectPublishedSite({ sessionId, url: inspectedUrl, brief: websiteBrief });
        return mergeQaResults(deterministic, browserUse);
      }

      return deterministic;
    }
  });

  const row = buildQaResults.upsert({
    build_id: buildId,
    lead_id: leadId,
    attempt,
    provider: qa.provider || 'fetch',
    url: inspectedUrl,
    status: qa.passed ? 'passed' : 'failed',
    passed: qa.passed,
    score: qa.score,
    checklist: qa.checklist,
    errors: qa.errors,
    claims: qa.claims,
    idempotency_key: `build:${buildId}:qa:${attempt}`
  });

  const result = { ...qa, id: row.id, attempt };
  emit('builder.qa', {
    worker: 'builder',
    leadId,
    runId,
    buildId,
    qaResultId: row.id,
    attempt,
    passed: result.passed,
    score: result.score,
    summary: result.passed ? 'Generated site passed build QA.' : `Generated site failed QA: ${result.errors.join(', ')}`,
    mock
  });
  return result;
}

async function submitLiveRevision({ adapter, sessionId, inspectedUrl, plan, leadId, buildId, runId, onProjectUrl }) {
  let projectUrl = null;
  let summary = null;
  for await (const event of adapter.submitLovableRevision({ sessionId, projectUrl: inspectedUrl, revisionPrompt: plan.prompt })) {
    if (event.kind === 'progress') {
      emit('builder.progress', {
        worker: 'builder',
        leadId,
        runId,
        buildId,
        phase: event.phase,
        summary: event.summary,
        providerType: event.providerType,
        screenshotUrl: event.screenshotUrl,
        messageId: event.messageId,
        providerTs: event.providerTs
      });
    }
    if (event.kind === 'project_url') {
      projectUrl = event.projectUrl;
      onProjectUrl?.(projectUrl);
    }
    if (event.kind === 'done') {
      projectUrl = event.projectUrl || projectUrl;
      summary = event.summary || null;
      if (projectUrl) onProjectUrl?.(projectUrl);
    }
  }
  return { projectUrl, summary, submittedAt: Date.now() };
}

async function runBuildHook({ hook, buildId, leadId, runId, attempt = 0, input, fn }) {
  if (!BUILD_HOOKS.includes(hook)) throw new Error(`unknown build hook ${hook}`);
  const row = buildHooks.start({
    build_id: buildId,
    lead_id: leadId,
    run_id: runId,
    hook,
    attempt,
    input,
    idempotency_key: `build:${buildId}:hook:${hook}:${attempt}`
  });
  emit('builder.hook', {
    worker: 'builder',
    leadId,
    runId,
    buildId,
    hook,
    hookId: row.id,
    attempt,
    status: 'running',
    summary: `${hook} started`
  });

  try {
    const output = await fn();
    buildHooks.finish(row.id, { status: output?.ok === false ? 'blocked' : 'completed', output });
    emit('builder.hook', {
      worker: 'builder',
      leadId,
      runId,
      buildId,
      hook,
      hookId: row.id,
      attempt,
      status: output?.ok === false ? 'blocked' : 'completed',
      summary: summarizeHook(hook, output)
    });
    return output;
  } catch (err) {
    const message = err?.message || String(err);
    buildHooks.finish(row.id, { status: 'failed', error: message });
    emit('builder.hook', {
      worker: 'builder',
      leadId,
      runId,
      buildId,
      hook,
      hookId: row.id,
      attempt,
      status: 'failed',
      error: message,
      summary: `${hook} failed: ${message}`
    });
    throw err;
  }
}

function mergeQaResults(base, browserUse) {
  if (!browserUse) return base;
  const checklistByKey = new Map((base.checklist || []).map((item) => [item.key, item]));
  for (const item of browserUse.checklist || []) {
    const existing = checklistByKey.get(item.key);
    if (!existing) checklistByKey.set(item.key, item);
    else checklistByKey.set(item.key, { ...existing, browserUse: item });
  }
  const checklist = [...checklistByKey.values()];
  const errors = unique([...(base.errors || []), ...(browserUse.errors || [])]);
  const passed = base.passed && (browserUse.passed !== false) && errors.length === 0;
  return {
    ...base,
    provider: 'fetch+browserUse',
    browserUse,
    checklist,
    errors,
    passed,
    score: passed ? Math.max(base.score || 0, browserUse.score || 0) : Math.min(base.score || 0, browserUse.score || 0)
  };
}

function summarizeHook(hook, output) {
  if (hook === 'briefValidate') {
    if (output?.ok) return 'Brief validation passed.';
    return `Brief validation blocked ${output?.errors?.length || 0} issue(s).`;
  }
  if (hook === 'preSubmit') return `Lovable prompt ready (${output?.promptLength || 0} chars).`;
  if (hook === 'siteInspect') return output?.passed ? 'Site inspection passed.' : `Site inspection failed ${output?.errors?.length || 0} issue(s).`;
  if (hook === 'revisionPlan') return `Revision prompt ready for ${(output?.focus || []).join(', ') || 'QA failures'}.`;
  if (hook === 'finalAccept') return output?.accepted ? 'Final acceptance passed.' : 'Final acceptance rejected the build.';
  return `${hook} completed.`;
}

function maxRevisionCount() {
  const n = Number(process.env.BUILDER_MAX_REVISIONS);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_MAX_REVISIONS;
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}
