import { emit } from '../sse.js';
import { runs, leads, builds, payments } from '../db.js';
import { log } from '../logger.js';
import { containerTagFor, getLatest } from '../memory.js';
import { BrowserUseFulfillmentAdapter, MockBrowserUseAdapter } from '../providers/browserUse.js';
import {
  assertBuildTarget,
  canRunLiveBuildTarget,
  classifyFulfillmentFailure,
  createBuildTarget,
  normalizeBuildTarget
} from '../fulfillment/targets.js';
import {
  prepareBuildSubmission,
  recordBuildSubmission,
  renderMockGeneratedSite,
  runBuildQaGate
} from '../fulfillment/hooks/index.js';

export async function runBuilder({ leadId, buildId, target, images = [] } = {}) {
  const claimedBuildId = buildId || `bld_${Date.now().toString(36)}`;
  const claim = builds.claimStart({ id: claimedBuildId, lead_id: leadId });
  if (!claim.claimed) {
    log.info('builder.start_skipped', { leadId, buildId: claimedBuildId, reason: claim.reason });
    emit('builder.skipped', { worker: 'builder', leadId, buildId: claimedBuildId, reason: claim.reason });
    return { skipped: true, reason: claim.reason };
  }

  const runId = `build_${Date.now().toString(36)}`;
  buildId = claim.row.id;
  runs.start({ id: runId, lead_id: leadId, worker: 'builder' });
  emit('builder.start', { worker: 'builder', leadId, runId, buildId, target: normalizeBuildTarget(target) });

  try {
    const lead = leads.get(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);

    const tag = containerTagFor(leadId);
    const [profileDoc, postMortemDoc] = await Promise.all([
      getLatest(tag, 'profile').catch(() => null),
      getLatest(tag, 'post_mortem').catch(() => null)
    ]);

    const prepared = await prepareBuildSubmission({
      lead,
      buildId,
      runId,
      profileDoc,
      postMortemDoc,
      latestPayment: payments.listByLead(lead.id)[0] || null
    });
    if (!prepared.ok) {
      const message = `Build brief blocked: ${prepared.validation.errors.map((e) => e.code).join(', ')}`;
      builds.update(buildId, { status: 'failed', finished_at: Date.now(), error: message, brief: null });
      leads.update(leadId, { next_action: 'builder_brief_blocked' });
      runs.finish(runId, { state: 'failed', error: message, detail: { validation: prepared.validation } });
      emit('builder.error', { worker: 'builder', leadId, runId, buildId, error: message, category: 'brief_validation', validation: prepared.validation });
      return { blockedBrief: true, validation: prepared.validation };
    }

    const brief = prepared.brief;
    const buildTarget = assertBuildTarget(createBuildTarget(target));
    const submission = buildTarget.createSubmission({ brief, images, lead, buildId });
    const gate = canRunLiveBuildTarget(buildTarget.name);
    builds.update(buildId, {
      target: buildTarget.name,
      brief,
      submission_url: submission.submissionUrl || submission.url || null,
      lovable_url: buildTarget.name === 'lovable' ? submission.submissionUrl || submission.url || null : null,
      status: 'running'
    });
    await recordBuildSubmission({
      leadId,
      buildId,
      runId,
      provider: buildTarget.name,
      submissionUrl: submission.submissionUrl || submission.url || null,
      lovableUrl: buildTarget.name === 'lovable' ? submission.submissionUrl || submission.url || null : null,
      mock: !gate.ok
    });

    if (!gate.ok) {
      return await runMock({ lead, leadId, runId, buildId, brief, websiteBrief: prepared.websiteBrief, submission, target: buildTarget.name, reason: gate.reason });
    }

    return await runLive({ lead, leadId, runId, buildId, brief, websiteBrief: prepared.websiteBrief, submission, buildTarget });
  } catch (err) {
    const failure = classifyFulfillmentFailure(err);
    const message = failure.message || String(err);
    builds.update(buildId, { status: 'failed', finished_at: Date.now(), error: message });
    runs.finish(runId, { state: 'failed', error: message, detail: { failure } });
    emit('builder.error', { worker: 'builder', leadId, runId, buildId, error: message, failure });
    throw err;
  }
}

async function runMock({ lead, leadId, runId, buildId, brief, websiteBrief, submission, target, reason }) {
  const liveUrl = `/api/leads/${encodeURIComponent(leadId)}/build-preview`;
  const fallbackProjectUrl = target === 'v0'
    ? `https://${slugify(lead.business_name)}.vercel.app`
    : `https://${slugify(lead.business_name)}.lovable.app`;
  let projectUrl = null;
  let providerProjectId = null;
  let providerDeploymentId = null;
  let sessionId = `mock-${target}-${buildId}`;
  const buildTarget = assertBuildTarget(createBuildTarget(target));
  const adapter = target === 'lovable'
    ? new MockBrowserUseAdapter({ liveUrl, projectUrl: fallbackProjectUrl, sessionId })
    : null;

  builds.update(buildId, {
    browser_session_id: sessionId,
    live_url: liveUrl,
    lovable_url: submission.submissionUrl || submission.url || null,
    brief,
    status: 'running'
  });

  for await (const event of buildTarget.runWithBrowserUse({ browserUse: adapter, submission, brief, live: false, lead, buildId })) {
    if (event.kind === 'live_url') {
      sessionId = event.sessionId || sessionId;
      builds.update(buildId, { browser_session_id: sessionId, live_url: event.liveUrl || liveUrl, status: 'running' });
      emit('builder.live_url', {
        worker: 'builder',
        leadId,
        runId,
        buildId,
        target,
        liveUrl: event.liveUrl || liveUrl,
        sessionId,
        lovableUrl: submission.submissionUrl || submission.url || null,
        brief,
        mock: true,
        reason
      });
    } else if (event.kind === 'provider_action') {
      providerProjectId = event.providerProjectId || providerProjectId;
      providerDeploymentId = event.providerDeploymentId || providerDeploymentId;
      emit('builder.provider_action', { worker: 'builder', leadId, runId, buildId, target, mock: true, ...event });
    } else if (event.kind === 'progress') {
      emit('builder.progress', { worker: 'builder', leadId, runId, buildId, target, mock: true, ...event });
    } else if (event.kind === 'project_url') {
      projectUrl = event.projectUrl || projectUrl;
      providerProjectId = event.providerProjectId || providerProjectId;
      providerDeploymentId = event.providerDeploymentId || providerDeploymentId;
      builds.update(buildId, {
        project_url: projectUrl,
        provider_project_id: providerProjectId,
        provider_deployment_id: providerDeploymentId
      });
      emit('builder.project_url', { worker: 'builder', leadId, runId, buildId, target, projectUrl, providerProjectId, providerDeploymentId, mock: true });
    } else if (event.kind === 'done') {
      projectUrl = event.projectUrl || projectUrl;
      providerProjectId = event.providerProjectId || providerProjectId;
      providerDeploymentId = event.providerDeploymentId || providerDeploymentId;
    }
  }

  projectUrl = projectUrl || fallbackProjectUrl;
  builds.update(buildId, {
    project_url: projectUrl,
    provider_project_id: providerProjectId,
    provider_deployment_id: providerDeploymentId,
    status: 'qa_review'
  });
  const qaGate = await runBuildQaGate({
    lead,
    buildId,
    runId,
    websiteBrief,
    brief,
    candidateUrl: projectUrl,
    candidateHtml: renderMockGeneratedSite({ brief: websiteBrief }),
    mock: true
  });
  if (!qaGate.accepted) {
    const errors = qaGate.qa?.errors || [];
    const qaError = `Build QA failed${errors.length ? `: ${errors.join(', ')}` : ''}`;
    builds.update(buildId, { status: 'failed', finished_at: Date.now(), error: qaError });
    leads.update(leadId, { next_action: 'builder_qa_failed' });
    runs.finish(runId, { state: 'failed', error: qaError, detail: { mock: true, target, liveUrl, projectUrl, qa: qaGate.qa } });
    emit('builder.error', { worker: 'builder', leadId, runId, buildId, target, liveUrl, projectUrl, error: qaError, category: 'build_qa', qaResultId: qaGate.qa?.id || null, mock: true });
    return { liveUrl, projectUrl, brief, target, qa: qaGate.qa, qaFailed: true, mock: true };
  }

  builds.update(buildId, {
    project_url: projectUrl,
    provider_project_id: providerProjectId,
    provider_deployment_id: providerDeploymentId,
    status: 'completed',
    finished_at: Date.now()
  });
  leads.update(leadId, { website: projectUrl, status: 'shipped' });
  runs.finish(runId, { state: 'completed', detail: { mock: true, target, liveUrl, projectUrl, providerProjectId, providerDeploymentId, qa: qaGate.qa } });
  emit('builder.done', { worker: 'builder', leadId, runId, buildId, target, liveUrl, projectUrl, providerProjectId, providerDeploymentId, qaResultId: qaGate.qa?.id || null, qaScore: qaGate.qa?.score || null, mock: true });
  return { liveUrl, projectUrl, brief, target, qa: qaGate.qa, mock: true };
}

async function runLive({ lead, leadId, runId, buildId, brief, websiteBrief, submission, buildTarget }) {
  const adapter = new BrowserUseFulfillmentAdapter();
  let liveUrl = null;
  let sessionId = null;
  let projectUrl = null;
  let providerProjectId = null;
  let providerDeploymentId = null;

  const persistProjectUrl = (eventOrUrl) => {
    const url = typeof eventOrUrl === 'string' ? eventOrUrl : eventOrUrl?.projectUrl;
    const nextProjectId = (typeof eventOrUrl === 'object' && eventOrUrl?.providerProjectId) || providerProjectId;
    const nextDeploymentId = (typeof eventOrUrl === 'object' && eventOrUrl?.providerDeploymentId) || providerDeploymentId;
    if (!url) {
      providerProjectId = nextProjectId;
      providerDeploymentId = nextDeploymentId;
      return;
    }
    if (url === projectUrl && nextProjectId === providerProjectId && nextDeploymentId === providerDeploymentId) return;
    projectUrl = url;
    providerProjectId = nextProjectId;
    providerDeploymentId = nextDeploymentId;
    builds.update(buildId, {
      project_url: projectUrl,
      provider_project_id: providerProjectId,
      provider_deployment_id: providerDeploymentId
    });
    emit('builder.project_url', { worker: 'builder', leadId, runId, buildId, target: buildTarget.name, projectUrl, providerProjectId, providerDeploymentId, sessionId });
  };

  try {
    for await (const event of buildTarget.runWithBrowserUse({ browserUse: adapter, submission, brief, live: true, lead, buildId })) {
      if (event.kind === 'live_url') {
        liveUrl = event.liveUrl || liveUrl;
        sessionId = event.sessionId || sessionId;
        builds.update(buildId, {
          browser_session_id: sessionId,
          live_url: liveUrl,
          lovable_url: submission.submissionUrl || submission.url || null,
          brief,
          status: 'running'
        });
        emit('builder.live_url', {
          worker: 'builder',
          leadId,
          runId,
          buildId,
          target: buildTarget.name,
          liveUrl,
          sessionId,
          lovableUrl: submission.submissionUrl || submission.url || null,
          brief
        });
      } else if (event.kind === 'project_url') {
        persistProjectUrl(event);
      } else if (event.kind === 'provider_action') {
        providerProjectId = event.providerProjectId || providerProjectId;
        providerDeploymentId = event.providerDeploymentId || providerDeploymentId;
        emit('builder.provider_action', { worker: 'builder', leadId, runId, buildId, target: buildTarget.name, ...event });
      } else if (event.kind === 'progress' || event.kind === 'action') {
        emit('builder.progress', {
          worker: 'builder',
          leadId,
          runId,
          buildId,
          target: buildTarget.name,
          phase: event.phase,
          summary: event.summary,
          providerType: event.providerType,
          screenshotUrl: event.screenshotUrl,
          messageId: event.messageId,
          providerTs: event.providerTs
        });
      } else if (event.kind === 'blocked_auth') {
        builds.update(buildId, { status: 'blocked_auth', finished_at: Date.now() });
        leads.update(leadId, { next_action: `${buildTarget.name}_auth_needed` });
        runs.finish(runId, { state: 'blocked', detail: { liveUrl, projectUrl, sessionId, reason: event.reason, target: buildTarget.name } });
        emit('builder.blocked_auth', { worker: 'builder', leadId, runId, buildId, target: buildTarget.name, liveUrl, sessionId, reason: event.reason, phase: event.phase });
        return { liveUrl, projectUrl: null, brief, sessionId, blockedAuth: true, reason: event.reason };
      } else if (event.kind === 'done') {
        persistProjectUrl(event);
      }
    }

    if (!projectUrl) throw new Error(`${buildTarget.name} build finished without a project URL`);
    builds.update(buildId, { status: 'qa_review' });
    const qaGate = await runBuildQaGate({
      lead,
      buildId,
      runId,
      websiteBrief,
      brief,
      candidateUrl: projectUrl,
      adapter,
      sessionId,
      mock: false,
      onProjectUrl: (url) => persistProjectUrl(url)
    });
    if (!qaGate.accepted) {
      const errors = qaGate.qa?.errors || [];
      const qaError = `Build QA failed${errors.length ? `: ${errors.join(', ')}` : ''}`;
      builds.update(buildId, { status: 'failed', finished_at: Date.now(), error: qaError });
      leads.update(leadId, { next_action: 'builder_qa_failed' });
      runs.finish(runId, { state: 'failed', error: qaError, detail: { liveUrl, projectUrl, sessionId, target: buildTarget.name, qa: qaGate.qa, revisions: qaGate.revisions } });
      emit('builder.error', { worker: 'builder', leadId, runId, buildId, target: buildTarget.name, liveUrl, projectUrl, sessionId, error: qaError, category: 'build_qa', qaResultId: qaGate.qa?.id || null });
      return { liveUrl, projectUrl, brief, sessionId, target: buildTarget.name, qa: qaGate.qa, qaFailed: true };
    }

    builds.update(buildId, {
      project_url: projectUrl,
      provider_project_id: providerProjectId,
      provider_deployment_id: providerDeploymentId,
      status: 'completed',
      finished_at: Date.now()
    });
    leads.update(leadId, { website: projectUrl, status: 'shipped', next_action: null });
    runs.finish(runId, { state: 'completed', detail: { liveUrl, projectUrl, providerProjectId, providerDeploymentId, sessionId, target: buildTarget.name, qa: qaGate.qa } });
    emit('builder.done', { worker: 'builder', leadId, runId, buildId, target: buildTarget.name, liveUrl, projectUrl, providerProjectId, providerDeploymentId, sessionId, qaResultId: qaGate.qa?.id || null, qaScore: qaGate.qa?.score || null });
    return { liveUrl, projectUrl, brief, sessionId, target: buildTarget.name, qa: qaGate.qa };
  } finally {
    try { await buildTarget.cleanup(); } catch (err) {
      log.warn('build target cleanup failed', { target: buildTarget.name, error: err?.message || String(err) });
    }
  }
}

function slugify(value) {
  return String(value || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
