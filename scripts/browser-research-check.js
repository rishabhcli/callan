// Deterministic Browser Use research swarm verification.
// Runs mock mode through the same job/session/evidence persistence path as live mode.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-browser-research-'));

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  RUN_MODE: 'mock',
  BROWSER_USE_API_KEY: '',
  BROWSER_USE_LIVE_RESEARCH: 'false',
  LIVE_BROWSER_RESEARCH: 'false',
  LIVE_RESEARCH: 'false',
  SUPERMEMORY_API_KEY: ''
});

try {
  const {
    createBrowserUseResearchJob,
    getBrowserResearchStatus,
    runBrowserUseResearchJob
  } = await import('../server/research/browserUseSwarm.js');
  const { events, leads } = await import('../server/db.js');
  const { recordingDisclosure } = await import('../server/compliance.js');
  const { createFallbackPitch } = await import('../server/pitch.js');
  const { buildLeadHotIndexDocs } = await import('../server/moss/hotIndex.js');
  const { buildWebsiteBrief, createLovableBuildPrompt, validateWebsiteBrief } = await import('../server/fulfillment/hooks/brief.js');
  const { generateGrowthPlanForLead } = await import('../server/growth/planner.js');
  const { portalBriefForLead } = await import('../server/customerPortal.js');

  const job = createBrowserUseResearchJob({
    city: 'San Francisco, CA',
    niche: 'barber',
    maxLeads: 4,
    concurrency: 5,
    maxCostUsd: 0.07,
    mode: 'mock'
  });

  await runBrowserUseResearchJob({ jobId: job.id });
  const status = getBrowserResearchStatus({ jobId: job.id });
  const eventRows = events.list({ since: 0, limit: 500 });
  const eventTypes = eventRows.map((row) => row.type);

  assert.equal(status.job.status, 'completed');
  assert.equal(status.sessions.length, 5, 'expected one mock session per source type');
  assert.ok(status.sessions.every((session) => session.normalizedStatus === 'completed'), 'all sessions should complete');
  assert.ok(status.sessions.every((session) => session.model), 'model policy should choose a model for every session');
  assert.ok(status.sessions.some((session) => session.model === 'bu-max'), 'ambiguous website lane should use a stronger Browser Use model');
  assert.ok(status.sessions.some((session) => session.model === 'bu-mini'), 'cheap extraction lanes should use bu-mini');

  const starts = status.sessions.map((session) => session.startedAt);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 1000, 'mock sessions should be launched in parallel');
  assert.ok(status.evidence.length >= 10, 'mock research should persist evidence from all source lanes');
  assert.equal(status.summary.acceptedCount, 4, 'maxLeads should cap accepted leads');
  assert.ok(status.summary.skippedCount > 0, 'overflow and strong leads should be visible as skipped evidence');
  assert.ok(status.summary.strongSkippedCount >= 1, 'strong presence should be skipped but visible');

  const strong = status.evidence.find((row) => row.presenceStrength === 'strong');
  assert.ok(strong, 'strong lead evidence row missing');
  assert.equal(strong.skipped, true);
  assert.equal(strong.skippedReason, 'strong_presence_visible_skip');
  assert.equal(strong.leadIntelligence?.doNotCallBecauseAlreadyStrong?.skip, true, 'strong lead should carry explicit do-not-call intelligence');

  const weakNoSite = status.evidence.find((row) => !row.skipped && !row.websiteUrl && ['none', 'weak', 'mixed'].includes(row.presenceStrength));
  assert.ok(weakNoSite, 'weak no-site lead should be accepted');
  assert.ok(weakNoSite.leadIntelligence?.callOpener?.text, 'accepted lead should have an exact call opener');
  assert.ok(weakNoSite.leadIntelligence?.reviewThemes?.length, 'accepted lead should include review themes');
  assert.ok(weakNoSite.leadIntelligence?.competitorComparison?.length, 'accepted lead should include competitor gap cards');
  assert.ok(weakNoSite.leadIntelligence?.currentWebsiteIssues?.length, 'accepted lead should include website issues');
  assert.ok(Number.isFinite(Number(weakNoSite.leadIntelligence?.scores?.totalScore)), 'accepted lead should include total research score');

  assert.equal(status.liveResearchEnabled, false, 'mock check should show live Browser Use fallback disabled');
  assert.equal(status.modePolicy, 'mock_same_orchestration_path');
  assert.ok(status.liveBlockers.length > 0, 'provider fallback blockers should be visible');
  assert.ok(status.businesses.some((business) => business.businessName === weakNoSite.businessName && business.callOpener), 'status business rollup should expose opener');

  assert.ok(eventTypes.includes('research.session.started'), 'session start event missing');
  assert.ok(eventTypes.includes('research.session.completed'), 'session completion event missing');
  assert.ok(eventTypes.includes('research.evidence.captured'), 'evidence captured event missing');
  assert.ok(eventTypes.includes('research.evidence.skipped'), 'evidence skipped event missing');

  const profileLead = leads.list({ limit: 50 }).find((lead) => lead.business_name === weakNoSite.businessName);
  assert.ok(profileLead, 'accepted evidence should be mirrored to leads table');
  const profile = JSON.parse(profileLead.research_json);
  const intelligence = profile.leadIntelligence;
  assert.ok(intelligence, 'mirrored profile should preserve leadIntelligence');
  assertEvidenceIntegrity(intelligence);

  const sourceRows = [
    ...(weakNoSite.sourceEvidence || []),
    ...(intelligence.evidence || [])
  ];
  assert.ok(sourceRows.every((row) => row.id && row.sourceUrl), 'every source/evidence row should preserve id and sourceUrl');

  const pitch = createFallbackPitch({
    disclosure: recordingDisclosure(profileLead.business_name),
    profile,
    lead: profileLead
  });
  assert.ok(pitch.exactEvidenceBasedOpener?.includes(profile.businessName), 'pitch should carry exact evidence-based opener');
  assert.ok(pitch.callOpenerEvidenceIds?.length, 'pitch opener should cite evidence ids');
  assert.ok(pitch.sourceEvidence.some((item) => item.evidenceId && item.source), 'pitch should expose source evidence ids and URLs');

  const mossDocs = buildLeadHotIndexDocs({ lead: profileLead, profile, pitch });
  assert.ok(mossDocs.some((doc) => doc.id === 'research.call_opener' && doc.metadata?.evidenceIds?.length), 'Moss docs should include cited opener snippet');
  assert.ok(mossDocs.some((doc) => doc.id.startsWith('research.review_theme.')), 'Moss docs should include review theme snippets');
  assert.ok(mossDocs.some((doc) => doc.id.startsWith('research.competitor_gap.')), 'Moss docs should include competitor gap snippets');

  const websiteBrief = buildWebsiteBrief({ lead: profileLead, profileDoc: { content: profile } });
  const briefValidation = validateWebsiteBrief(websiteBrief);
  assert.equal(briefValidation.ok, true, `website brief should validate: ${briefValidation.errors.map((e) => e.code).join(', ')}`);
  assert.ok(websiteBrief.sourceFacts?.leadIntelligence, 'WebsiteBrief should carry lead intelligence facts');
  assert.ok(websiteBrief.evidenceTrace?.reviewThemes?.length, 'WebsiteBrief should carry cited review themes');
  const buildPrompt = createLovableBuildPrompt(websiteBrief);
  assert.match(buildPrompt, /Evidence\/source trail/i, 'builder prompt should include source trail');
  assert.match(buildPrompt, /Review\/customer themes/i, 'builder prompt should include review themes');

  const growth = await generateGrowthPlanForLead({ leadId: profileLead.id, force: true, source: 'browser-research-check' });
  const growthEvidenceIds = new Set((growth.plan.evidence || []).map((item) => item.id));
  assert.ok([...growthEvidenceIds].some((id) => /review|website|missing|competitor/.test(id)), 'growth plan should ingest lead-intelligence evidence');
  const citedRecommendations = [
    ...(growth.plan.localSeoGaps || []),
    ...(growth.plan.reviewCapturePlan || []),
    ...(growth.plan.bookingContactFlowPlan || [])
  ];
  assert.ok(citedRecommendations.some((item) => item.evidenceIds?.some((id) => growthEvidenceIds.has(id))), 'growth recommendations should cite ingested evidence');

  const portalBrief = portalBriefForLead(profileLead);
  assert.equal(portalBrief.exactCallOpener, intelligence.callOpener.text, 'customer portal brief should expose the same opener');
  assert.ok(portalBrief.sourceTrail.length, 'customer portal brief should expose source trail');

  console.log('[PASS] Browser Use research swarm mock check completed.');
  console.log(JSON.stringify({
    jobId: status.job.id,
    sessions: status.sessions.length,
    evidence: status.evidence.length,
    accepted: status.summary.acceptedCount,
    skipped: status.summary.skippedCount,
    strongSkipped: status.summary.strongSkippedCount,
    models: [...new Set(status.sessions.map((session) => session.model))],
    trace: {
      evidenceId: intelligence.callOpener.evidenceIds[0],
      opener: pitch.exactEvidenceBasedOpener,
      briefHero: websiteBrief.hero.subheadline,
      portalOpener: portalBrief.exactCallOpener
    }
  }, null, 2));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

function assertEvidenceIntegrity(intelligence) {
  const evidenceIds = new Set((intelligence.evidence || []).map((item) => item.id));
  assert.ok(evidenceIds.size > 0, 'lead intelligence evidence rows missing');
  const citedObjects = [
    ...(intelligence.reviewThemes || []),
    ...(intelligence.positiveProof || []),
    ...(intelligence.complaintsPainPoints || []),
    ...(intelligence.missingCustomerInfo || []),
    ...(intelligence.competitorComparison || []),
    ...(intelligence.currentWebsiteIssues || []),
    ...(intelligence.socialListingConsistency || []),
    intelligence.bestCtaRecommendation,
    intelligence.whyThisLeadIsWorthCalling,
    intelligence.callOpener,
    intelligence.scores?.presenceWeakness,
    intelligence.scores?.urgency,
    intelligence.scores?.websiteValue,
    intelligence.scores?.contactability,
    intelligence.scores?.verticalFit,
    intelligence.contactConfidence?.hours,
    intelligence.contactConfidence?.address,
    intelligence.contactConfidence?.phone
  ].filter(Boolean);
  for (const claim of citedObjects) {
    assert.ok(claim.evidenceIds?.length, `${claim.id || claim.text || claim.reason || 'claim'} missing evidenceIds`);
    for (const evidenceId of claim.evidenceIds) {
      assert.ok(evidenceIds.has(evidenceId), `claim cites missing evidence id ${evidenceId}`);
    }
  }
  assert.equal(intelligence.audit?.everyClaimCitesEvidence, true);
  assert.equal(intelligence.audit?.sourceUrlPreserved, true);
}
