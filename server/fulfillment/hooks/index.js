import { emit } from '../../sse.js';
import { buildHooks, buildQaResults, buildRevisions, builds, payments } from '../../db.js';
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
          previewUrl: inspectedUrl,
          launchStatus: 'internal_complete',
          summary: 'QA passed; build is internally complete and ready for approval.'
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
      try { builds.update(buildId, { preview_html: inspectedHtml }); } catch {}
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
  const latestBuild = buildId ? builds.get(buildId) : (leadId ? builds.listByLead(leadId)[0] : null);
  const effectiveBuildId = buildId || latestBuild?.id || null;
  const hooks = effectiveBuildId ? buildHooks.listByBuild(effectiveBuildId) : buildHooks.listByLead(leadId);
  const qaResults = effectiveBuildId ? buildQaResults.listByBuild(effectiveBuildId) : buildQaResults.listByLead(leadId);
  const revisions = effectiveBuildId ? buildRevisions.listByBuild(effectiveBuildId) : buildRevisions.listByLead(leadId);
  const latestQa = qaResults[0] || null;
  const validation = [...hooks].reverse().find((row) => row.hook === 'briefValidate')?.output || null;
  const websiteBrief = parseJson(latestBuild?.website_brief_json) || [...hooks].reverse().find((row) => row.hook === 'preBrief')?.output || null;
  const latestPayment = leadId ? payments.listByLead(leadId)[0] || null : null;
  const launchChecklist = buildLaunchChecklist({ build: latestBuild, qa: latestQa, websiteBrief, latestPayment });
  return {
    leadId,
    buildId: effectiveBuildId,
    status: latestQa ? (latestQa.passed ? 'passed' : 'failed') : hooks.length ? 'running' : 'not_started',
    build: latestBuild,
    websiteBrief,
    hooks,
    validation,
    qaResults,
    latestQa,
    revisions,
    launchChecklist,
    maxRevisions: maxRevisionCount()
  };
}

export function buildLaunchChecklist({ build, qa, websiteBrief, latestPayment } = {}) {
  const qaItems = new Map((qa?.checklist || []).map((item) => [item.key, item]));
  const paymentPaid = latestPayment?.status === 'paid' || latestPayment?.paid_at;
  const launchStatus = build?.launch_status || 'not_started';
  const operatorApproved = Boolean(build?.operator_approved_at || launchStatus === 'ready_for_customer' || launchStatus === 'customer_approved' || launchStatus === 'launched');
  const customerApproved = Boolean(build?.customer_approved_at || launchStatus === 'customer_approved' || launchStatus === 'launched');
  const launched = Boolean(build?.launched_at || launchStatus === 'launched');
  const items = [
    fromQa(qaItems, 'mobile_sanity', 'Mobile layout'),
    fromQa(qaItems, 'desktop_sanity', 'Desktop layout'),
    fromQa(qaItems, 'primary_cta', 'Primary CTA'),
    fromQa(qaItems, 'contact_paths', 'Phone/email/form'),
    fromQa(qaItems, 'localbusiness_schema', 'LocalBusiness schema'),
    fromQa(qaItems, 'hours_address_area', 'Hours/address/area'),
    fromQa(qaItems, 'image_alt_text', 'Image alt text'),
    fromQa(qaItems, 'no_hallucinated_claims', 'No fake claims'),
    fromQa(qaItems, 'no_broken_links', 'No broken links'),
    {
      key: 'invoice_payment_state',
      label: 'Invoice/payment state',
      passed: Boolean(paymentPaid),
      severity: 'launch_gate',
      detail: paymentPaid ? 'Invoice is paid.' : 'Invoice is not marked paid yet.'
    },
    {
      key: 'operator_approval',
      label: 'Operator approval',
      passed: operatorApproved,
      severity: 'launch_gate',
      detail: operatorApproved ? 'Internal QA approved the build for customer review.' : 'Operator/internal approval is pending.'
    },
    {
      key: 'customer_approval',
      label: 'Customer approval',
      passed: customerApproved,
      severity: 'launch_gate',
      detail: customerApproved ? 'Customer approved launch from the portal.' : 'Customer approval is still pending.'
    }
  ];
  const errors = items.filter((item) => !item.passed).map((item) => item.key);
  const launchBlocking = items.filter((item) => !item.passed && item.severity === 'launch_gate').map((item) => item.key);
  return {
    status: launched ? 'launched' : customerApproved ? 'customer_approved' : operatorApproved ? 'ready_for_customer' : qa?.passed ? 'internal_complete' : 'not_ready',
    readyToLaunch: qa?.passed === true && paymentPaid && operatorApproved && customerApproved,
    launched,
    score: Math.round((items.filter((item) => item.passed).length / items.length) * 100),
    errors,
    launchBlocking,
    finalUrl: build?.project_url || null,
    previewUrl: build?.live_url || null,
    screenshotUrls: qa?.claims?.screenshots || [],
    inspectedUrl: qa?.url || qa?.claims?.inspectedUrl || null,
    businessName: websiteBrief?.businessName || null,
    items
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
      const qaBrief = withLaunchApproval(websiteBrief, builds.get(buildId));
      const deterministic = await inspectGeneratedSite({
        url: inspectedUrl,
        html: inspectedHtml,
        brief: qaBrief,
        lead,
        mock
      });

      if (adapter && sessionId && browserUseSiteInspectionEnabled()) {
        const browserUse = await adapter.inspectPublishedSite({ sessionId, url: inspectedUrl, brief: qaBrief });
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
  try {
    builds.update(buildId, {
      launch_readiness_json: JSON.stringify(qa.launchReadiness || null),
      screenshot_url: qa.screenshots?.[0]?.url || qa.claims?.screenshots?.[0]?.url || null,
      ...(inspectedHtml ? { preview_html: inspectedHtml } : {})
    });
  } catch {}
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

function fromQa(qaItems, key, fallbackLabel) {
  const item = qaItems.get(key);
  if (item) return {
    key,
    label: item.label || fallbackLabel,
    passed: Boolean(item.passed),
    severity: item.severity || 'warn',
    detail: item.detail || ''
  };
  return {
    key,
    label: fallbackLabel,
    passed: false,
    severity: 'warn',
    detail: 'No QA evidence recorded yet.'
  };
}

function withLaunchApproval(websiteBrief, build) {
  if (!websiteBrief || typeof websiteBrief !== 'object') return websiteBrief;
  return {
    ...websiteBrief,
    launchApproval: {
      operatorApproved: Boolean(build?.operator_approved_at || build?.launch_status === 'ready_for_customer' || build?.launch_status === 'customer_approved' || build?.launch_status === 'launched'),
      customerApproved: Boolean(build?.customer_approved_at || build?.launch_status === 'customer_approved' || build?.launch_status === 'launched'),
      operatorApprovedAt: build?.operator_approved_at || null,
      customerApprovedAt: build?.customer_approved_at || null,
      launchedAt: build?.launched_at || null
    }
  };
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
