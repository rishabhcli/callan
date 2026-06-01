import { db, portfolioOperatingModel } from './db.js';
import { getDefaultPack, getPackByKey, pickPack, priceCentsForLead } from './verticalPacks/index.js';

const DEFAULT_WORKSPACE_ID = 'ws_callan';

export function aggregateLeadMarketOpportunities({
  workspaceId = DEFAULT_WORKSPACE_ID,
  minLeads = 1,
  limit = 25,
  now = Date.now()
} = {}) {
  portfolioOperatingModel.bootstrapDefault({ workspaceId, now });
  const leads = db.prepare(`
    SELECT *
    FROM leads
    WHERE city IS NOT NULL
      AND TRIM(city) != ''
      AND status NOT IN ('reset_archived')
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 25, 500)));

  const groups = new Map();
  for (const lead of leads) {
    const city = cleanText(lead.city);
    if (!city) continue;
    const pack = pickPack(lead);
    const verticalKey = cleanKey(lead.vertical_pack || pack?.key || lead.niche || 'default');
    const key = `${city.toLowerCase()}::${verticalKey}`;
    const group = groups.get(key) || {
      city,
      region: null,
      verticalKey,
      pack,
      leads: []
    };
    group.leads.push(lead);
    groups.set(key, group);
  }

  const opportunities = [];
  for (const group of groups.values()) {
    if (group.leads.length < Math.max(1, Number(minLeads) || 1)) continue;
    const opportunityId = deterministicOpportunityId(workspaceId, group.city, group.verticalKey);
    const existingOpportunity = portfolioOperatingModel.getMarketOpportunity(opportunityId);
    const assessment = applyMarketOutcomeLearningToAssessment({
      assessment: assessLeadMarketGroup(group, { now }),
      existingOpportunity,
      now
    });
    const opportunity = portfolioOperatingModel.recordMarketOpportunity({
      id: opportunityId,
      workspaceId,
      territory: {
        city: group.city,
        region: group.region,
        metadata: {
          source: 'lead_aggregation',
          leadCount: group.leads.length
        }
      },
      verticalKey: group.verticalKey,
      city: group.city,
      score: assessment.score,
      confidence: assessment.confidence,
      decision: assessment.decision,
      sourceEvidence: assessment.evidence,
      signals: assessment.signals,
      risks: assessment.risks,
      unitEconomics: assessment.unitEconomics,
      now
    });
    opportunities.push({
      opportunity,
      leadIds: group.leads.map((lead) => lead.id),
      decision: assessment.decision,
      score: assessment.score,
      confidence: assessment.confidence
    });
  }

  const snapshot = portfolioOperatingModel.snapshot({ workspaceId });
  return {
    ok: true,
    workspaceId,
    consideredLeads: leads.length,
    groups: groups.size,
    createdOrUpdated: opportunities.length,
    opportunities,
    snapshot
  };
}

export function planLaunchFromMarketOpportunity({
  opportunityId,
  brandName = null,
  serviceName = null,
  autoLaunchFirstAcquisitionMotion = true,
  firstAcquisitionMotionActor = 'market-recommendation-autopilot',
  force = false,
  now = Date.now()
} = {}) {
  const opportunity = portfolioOperatingModel.getMarketOpportunity(opportunityId);
  if (!opportunity) throw new Error(`market opportunity not found: ${opportunityId}`);

  const existing = db.prepare(`
    SELECT id
    FROM service_businesses
    WHERE opportunity_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(opportunity.id);
  const blueprint = launchBlueprintForOpportunity({ opportunity, brandName, serviceName });
  if (existing && !force) {
    const serviceBusiness = portfolioOperatingModel.getServiceBusiness(existing.id);
    const firstAcquisitionMotion = autoLaunchFirstAcquisitionMotion
      ? launchFirstAcquisitionMotionFromMarketRecommendation({
        opportunity,
        serviceBusiness,
        actor: firstAcquisitionMotionActor,
        now
      })
      : null;
    return {
      ok: true,
      created: false,
      opportunity,
      blueprint,
      firstAcquisitionMotion,
      launch: {
        opportunity,
        serviceBusiness: firstAcquisitionMotion?.serviceBusiness || serviceBusiness,
        capabilities: [],
        workflows: [],
        vendors: []
      }
    };
  }

  const launch = portfolioOperatingModel.createServiceBusinessFromOpportunity({
    opportunityId: opportunity.id,
    brandName: blueprint.brandName,
    serviceName: blueprint.serviceName,
    customerOutcome: blueprint.customerOutcome,
    offer: blueprint.offer,
    channels: blueprint.channels,
    readiness: blueprint.readiness,
    capabilities: blueprint.capabilities,
    workflows: blueprint.workflows,
    vendorPartners: blueprint.vendorPartners,
    now
  });
  const firstAcquisitionMotion = autoLaunchFirstAcquisitionMotion
    ? launchFirstAcquisitionMotionFromMarketRecommendation({
      opportunity: launch.opportunity,
      serviceBusiness: launch.serviceBusiness,
      actor: firstAcquisitionMotionActor,
      now
    })
    : null;
  const hydratedLaunch = {
    ...launch,
    serviceBusiness: firstAcquisitionMotion?.serviceBusiness || launch.serviceBusiness
  };

  return {
    ok: true,
    created: true,
    opportunity: hydratedLaunch.opportunity,
    blueprint,
    firstAcquisitionMotion,
    launch: hydratedLaunch
  };
}

export function recordMarketRecommendationOutcome({
  opportunityId,
  outcome = 'false_positive',
  reasonKey = null,
  summary = null,
  evidence = [],
  observedAt = Date.now(),
  now = Date.now()
} = {}) {
  const opportunity = portfolioOperatingModel.getMarketOpportunity(opportunityId);
  if (!opportunity) throw new Error(`market opportunity not found: ${opportunityId}`);
  const normalizedOutcome = normalizeMarketRecommendationOutcome({
    opportunity,
    outcome,
    reasonKey,
    summary,
    evidence,
    observedAt
  });
  const prior = opportunity.signals?.marketOutcomeLearning || null;
  const outcomes = [
    ...(Array.isArray(prior?.outcomes) ? prior.outcomes : []),
    normalizedOutcome
  ].slice(-12);
  const learning = summarizeMarketOutcomeLearning({
    opportunity,
    outcomes,
    now
  });
  const revisedScore = Number(clamp((Number(opportunity.score) || 0) - learning.scorePenalty).toFixed(4));
  const revisedDecision = learning.recommendedDecision || learnedDecisionFor({ opportunity, revisedScore, learning });
  const updatedSignals = {
    ...(opportunity.signals || {}),
    marketRecommendationProvenance: applyLearningToMarketRecommendationProvenance({
      provenance: opportunity.signals?.marketRecommendationProvenance,
      revisedDecision,
      revisedScore,
      learning,
      now
    }),
    marketOutcomeLearning: learning
  };
  const updatedRisks = {
    ...(opportunity.risks || {}),
    marketOutcomeLearningState: learning.state,
    marketOutcomeLearningApplied: true,
    marketFalsePositiveCount: learning.falsePositiveCount,
    marketFailureCount: learning.marketFailureCount,
    marketFailureReasonKeys: learning.reasonKeys,
    marketRecommendationPenalty: learning.scorePenalty,
    learnedDecisionOverride: revisedDecision,
    marketOutcomeEvidenceRequired: learning.evidenceRequired
  };
  const updatedOpportunity = portfolioOperatingModel.recordMarketOpportunity({
    id: opportunity.id,
    workspaceId: opportunity.workspace_id,
    territoryId: opportunity.territory_id,
    verticalKey: opportunity.vertical_key,
    city: opportunity.city,
    neighborhood: opportunity.neighborhood,
    score: revisedScore,
    confidence: opportunity.confidence,
    status: 'learning_review',
    decision: revisedDecision,
    sourceEvidence: opportunity.source_evidence || [],
    signals: updatedSignals,
    risks: updatedRisks,
    unitEconomics: opportunity.unit_economics,
    now
  });
  const learningRecord = upsertMarketOutcomeLearningRecord({
    opportunity: updatedOpportunity,
    learning,
    outcome: normalizedOutcome,
    now
  });
  return {
    ok: true,
    opportunity: updatedOpportunity,
    learning: updatedOpportunity.signals.marketOutcomeLearning,
    learningRecord
  };
}

function launchFirstAcquisitionMotionFromMarketRecommendation({
  opportunity,
  serviceBusiness,
  actor = 'market-recommendation-autopilot',
  now = Date.now()
} = {}) {
  if (!serviceBusiness?.id) {
    return {
      ok: false,
      launched: false,
      reason: 'service_business_required'
    };
  }

  const strategy = portfolioOperatingModel.refreshAcquisitionStrategy({
    serviceBusinessId: serviceBusiness.id,
    now
  });
  const action = strategy.acquisitionActions.find((item) => (
    item.action_type === 'launch_first_motion'
    && item.channel === 'owned_acquisition_surface'
  ));
  if (!action) {
    return {
      ok: false,
      launched: false,
      reason: 'launch_first_motion_not_recommended',
      strategy,
      serviceBusiness: portfolioOperatingModel.getServiceBusiness(serviceBusiness.id)
    };
  }

  if (action.status === 'executed') {
    return {
      ok: true,
      launched: false,
      reason: 'already_executed',
      strategy,
      action,
      receipt: null,
      serviceBusiness: portfolioOperatingModel.getServiceBusiness(serviceBusiness.id)
    };
  }

  if (['rejected', 'blocked', 'rolled_back'].includes(action.status)) {
    return {
      ok: false,
      launched: false,
      reason: `action_${action.status}`,
      strategy,
      action,
      serviceBusiness: portfolioOperatingModel.getServiceBusiness(serviceBusiness.id)
    };
  }

  const evidence = [
    {
      id: opportunity?.id || serviceBusiness.opportunity_id || null,
      source: 'market_opportunity',
      decision: opportunity?.decision || null,
      score: opportunity?.score ?? null,
      confidence: opportunity?.confidence ?? null
    },
    {
      source: 'portfolio_acquisition_strategy',
      id: strategy.recommendation.id,
      decision: strategy.recommendation.decision
    }
  ];
  const approved = action.status === 'approved'
    ? action
    : portfolioOperatingModel.decideAcquisitionAction({
      actionId: action.id,
      status: 'approved',
      reviewedBy: actor,
      evidence,
      now
    });
  const executed = portfolioOperatingModel.executeAcquisitionAction({
    actionId: approved.id,
    actor,
    mode: 'dry_run',
    proof: {
      source: 'market_recommendation_first_motion',
      summary: 'Automatically launched the first measurable acquisition motion from the market recommendation without external spend.',
      externalSideEffects: false,
      firstPartySideEffects: false,
      opportunityId: opportunity?.id || serviceBusiness.opportunity_id || null,
      serviceBusinessId: serviceBusiness.id,
      evidence
    },
    now
  });

  return {
    ok: true,
    launched: true,
    reason: 'executed_local_dry_run',
    strategy,
    action: executed.action,
    receipt: executed.receipt,
    serviceBusiness: executed.serviceBusiness
  };
}

function assessLeadMarketGroup(group, { now = Date.now() } = {}) {
  const total = group.leads.length;
  const weak = group.leads.filter((lead) => ['weak', 'missing', 'thin'].includes(String(lead.online_presence_strength || '').toLowerCase())).length;
  const noWebsite = group.leads.filter((lead) => !cleanText(lead.website) || cleanText(lead.website).toLowerCase() === 'null').length;
  const callable = group.leads.filter((lead) => ['callable', 'qualified'].includes(String(lead.risk_status || '').toLowerCase()) || cleanText(lead.phone)).length;
  const avgConfidence = average(group.leads.map((lead) => Number(lead.presence_confidence)).filter(Number.isFinite));
  const evidence = group.leads.slice(0, 8).map((lead) => ({
    id: `lead:${lead.id}`,
    source: 'lead_research',
    sourceUrl: cleanText(lead.source_url) || null,
    summary: `${lead.business_name} in ${lead.city} shows ${lead.online_presence_strength || 'unknown'} online presence for ${lead.niche || group.verticalKey}.`,
    confidence: Number.isFinite(Number(lead.presence_confidence)) ? Number(lead.presence_confidence) : 0.5,
    capturedAt: new Date(lead.updated_at || lead.created_at || Date.now()).toISOString()
  }));
  const competitorWeaknesses = detectCompetitorWeaknesses(group);
  const highSeverityWeaknessCount = competitorWeaknesses.filter((item) => item.severity === 'high').length;
  const exploitableWeaknessRatio = competitorWeaknesses.length
    ? competitorWeaknesses.reduce((sum, item) => sum + item.ratio, 0) / competitorWeaknesses.length
    : 0;
  const weakRatio = total ? weak / total : 0;
  const noWebsiteRatio = total ? noWebsite / total : 0;
  const callableRatio = total ? callable / total : 0;
  const density = Math.min(1, total / 5);
  const weaknessBoost = Math.min(0.10, highSeverityWeaknessCount * 0.025);
  const serviceUrgency = detectServiceUrgency(group);
  const demandPressure = detectMarketDemandPressure({
    group,
    competitorWeaknesses,
    serviceUrgency,
    weakRatio,
    noWebsiteRatio,
    callableRatio,
    density,
    exploitableWeaknessRatio
  });
  const pressureBoost = Math.min(0.06, (demandPressure.pressureScore || 0) * 0.06);
  const ownerResponsiveness = predictOwnerResponsiveness({
    leads: group.leads,
    pack: group.pack,
    verticalKey: group.verticalKey,
    serviceUrgency,
    demandPressure,
    avgConfidence
  });
  const score = clamp(
    (weakRatio * 0.32) +
    (noWebsiteRatio * 0.18) +
    (callableRatio * 0.15) +
    (density * 0.15) +
    ((avgConfidence || 0.5) * 0.15) +
    weaknessBoost +
    pressureBoost
  );
  const confidence = clamp(((avgConfidence || 0.5) * 0.70) + (density * 0.30));
  const decision = score >= 0.72 && evidence.length >= 2 ? 'launch_candidate' : score >= 0.45 ? 'watch' : 'avoid';
  const packPriceCents = median(group.leads.map((lead) => priceCentsForLead(lead)).filter(Number.isFinite)) || 50000;
  const marginModelPct = group.pack?.marginModel?.targetGrossMarginPct || 35;
  const fulfillmentCostCents = Number.isFinite(group.pack?.marginModel?.estimatedFulfillmentCostCents)
    ? group.pack.marginModel.estimatedFulfillmentCostCents
    : null;
  const pricingMarginInference = inferPricingMarginFromLeadEvidence({
    group,
    packPriceCents,
    fulfillmentCostCents,
    targetGrossMarginPct: marginModelPct
  });
  const priceCents = pricingMarginInference.representativePriceCents || packPriceCents;
  const maxAcquisitionCostCents = Math.round(priceCents * ((group.pack?.marginModel?.maxAcquisitionCostPct || 18) / 100));
  const marketSizing = estimateMarketSizing({
    group,
    evidence,
    representativePriceCents: priceCents,
    fulfillmentCostCents,
    targetGrossMarginPct: marginModelPct,
    maxAcquisitionCostCents,
    callable,
    weak,
    noWebsite,
    avgConfidence,
    density,
    serviceUrgency,
    demandPressure,
    competitorWeaknesses,
    exploitableWeaknessRatio,
    decision
  });
  const searchIntentCapture = detectSearchIntentCapture({
    group,
    serviceUrgency,
    demandPressure,
    competitorWeaknesses,
    noWebsiteRatio,
    weakRatio
  });
  const reviewComplaintClusters = detectReviewComplaintClusters({
    group,
    serviceUrgency,
    demandPressure
  });
  const reviewComplaintSummary = summarizeReviewComplaintClusters(reviewComplaintClusters, total);
  const formationPermitSignals = detectFormationPermitSignals({ group });
  const formationPermitSummary = summarizeFormationPermitSignals({
    signals: formationPermitSignals,
    totalLeads: total,
    pack: group.pack
  });
  const localSeasonality = detectLocalSeasonality({
    group,
    serviceUrgency,
    demandPressure,
    now
  });
  const adSaturationOfferFatigue = detectAdSaturationOfferFatigue({
    group,
    demandPressure,
    searchIntentCapture,
    localSeasonality
  });
  const cityDemandMap = buildCityDemandMap({
    group,
    serviceUrgency,
    demandPressure,
    localSeasonality,
    adSaturationOfferFatigue
  });
  const neighborhoodLaunchPlan = buildNeighborhoodLaunchPlan({
    group,
    cityDemandMap,
    searchIntentCapture,
    ownerResponsiveness,
    pricingMarginInference,
    marketSizing,
    serviceUrgency,
    demandPressure
  });
  const marketRecommendationProvenance = buildMarketRecommendationProvenance({
    group,
    evidence,
    score,
    confidence,
    decision,
    weakRatio,
    noWebsiteRatio,
    callableRatio,
    density,
    avgConfidence,
    exploitableWeaknessRatio,
    competitorWeaknesses,
    serviceUrgency,
    demandPressure,
    marketSizing,
    ownerResponsiveness,
    searchIntentCapture,
    reviewComplaintSummary,
    formationPermitSummary,
    localSeasonality,
    adSaturationOfferFatigue,
    cityDemandMap,
    pricingMarginInference,
    neighborhoodLaunchPlan
  });
  const confidenceIntervals = buildMarketConfidenceIntervals({
    score,
    confidence,
    leadCount: total,
    evidenceCount: evidence.length,
    avgConfidence,
    density,
    exploitableWeaknessRatio,
    demandPressure,
    marketSizing,
    ownerResponsiveness,
    searchIntentCapture,
    reviewComplaintSummary,
    formationPermitSummary,
    localSeasonality,
    adSaturationOfferFatigue,
    cityDemandMap,
    pricingMarginInference,
    neighborhoodLaunchPlan,
    marketRecommendationProvenance
  });
  marketRecommendationProvenance.confidenceIntervalWidthClass = confidenceIntervals.summary.widthClass;
  return {
    score,
    confidence,
    decision,
    evidence,
    signals: {
      leadCount: total,
      weakPresenceCount: weak,
      noWebsiteCount: noWebsite,
      callableCount: callable,
      verticalPack: group.pack?.key || group.verticalKey,
      representativeNiches: [...new Set(group.leads.map((lead) => cleanText(lead.niche)).filter(Boolean))].slice(0, 8),
      competitorWeaknesses,
      competitorWeaknessSummary: {
        total: competitorWeaknesses.length,
        highSeverity: highSeverityWeaknessCount,
        exploitableWeaknessRatio: Number(exploitableWeaknessRatio.toFixed(4)),
        topWeaknessKeys: competitorWeaknesses.slice(0, 5).map((item) => item.key),
        source: 'lead_evidence_competitor_weakness_detection'
      },
      serviceUrgency,
      demandPressure,
      marketSizing,
      ownerResponsiveness,
      searchIntentCapture,
      reviewComplaintClusters,
      reviewComplaintSummary,
      formationPermitSignals,
      formationPermitSummary,
      localSeasonality,
      adSaturationOfferFatigue,
      cityDemandMap,
      pricingMarginInference,
      neighborhoodLaunchPlan,
      marketRecommendationProvenance,
      confidenceIntervals,
      verticalManifest: group.pack ? {
        key: group.pack.key,
        name: group.pack.name,
        marketSignals: group.pack.marketSignals || [],
        leadSources: group.pack.leadSources || [],
        launchChecklist: group.pack.launchChecklist || [],
        serviceOffer: group.pack.serviceOffer || {},
        fulfillmentRequirements: group.pack.fulfillmentRequirements || [],
        trustRequirements: group.pack.trustRequirements || [],
        growthPaths: group.pack.growthPaths || []
      } : null
    },
    risks: {
      lowEvidence: evidence.length < 3,
      complianceReviewRequired: true,
      publicClaimsRequireReview: true,
      restrictedClaims: group.pack?.compliance?.restrictedClaims || [],
      approvalRequiredFor: group.pack?.compliance?.approvalRequiredFor || [],
      mobileOrUnknownPhoneRisk: group.leads.filter((lead) => ['mobile_risk', 'unknown'].includes(String(lead.phone_classification || '').toLowerCase())).length,
      competitorWeaknessKeys: competitorWeaknesses.map((item) => item.key),
      serviceUrgencyClass: serviceUrgency.urgencyClass,
      serviceUrgencyResponseRequirements: serviceUrgency.responseRequirements,
      demandPressureLevel: demandPressure.pressureLevel,
      demandPressureDriverKeys: demandPressure.drivers.map((item) => item.key),
      marketSizingConfidence: marketSizing.confidence,
      obtainableFirstWaveCents: marketSizing.obtainableFirstWaveCents,
      serviceableAvailableMarketCents: marketSizing.serviceableAvailableMarketCents,
      ownerResponsivenessClass: ownerResponsiveness.responsivenessClass,
      recommendedAcquisitionMotion: ownerResponsiveness.recommendedAcquisitionMotion,
      responseFrictionScore: ownerResponsiveness.responseFrictionScore,
      ownerResponsivenessBlockers: ownerResponsiveness.blockers,
      searchIntentClass: searchIntentCapture.intentClass,
      recommendedCaptureSurface: searchIntentCapture.recommendedCaptureSurface,
      searchIntentScore: searchIntentCapture.capturedIntentScore,
      searchIntentEvidenceRequired: searchIntentCapture.evidenceRequired,
      reviewComplaintClusterKeys: reviewComplaintClusters.map((item) => item.key),
      reviewComplaintCoverage: reviewComplaintSummary.coveredLeadRatio,
      topCustomerComplaint: reviewComplaintSummary.topClusterKey,
      reviewComplaintEvidenceRequired: reviewComplaintSummary.evidenceRequired,
      formationPermitSignalKeys: formationPermitSignals.map((item) => item.key),
      formationPermitCoverage: formationPermitSummary.coveredLeadRatio,
      formationPermitRiskScore: formationPermitSummary.regulatoryRiskScore,
      formationPermitEvidenceRequired: formationPermitSummary.evidenceRequired,
      localSeasonalityClass: localSeasonality.seasonalityClass,
      localSeasonalityWindowKey: localSeasonality.seasonalWindowKey,
      localSeasonalityDemandMultiplier: localSeasonality.demandMultiplier,
      localSeasonalityEvidenceRequired: localSeasonality.evidenceRequired,
      adSaturationLevel: adSaturationOfferFatigue.saturationLevel,
      offerFatigueLevel: adSaturationOfferFatigue.fatigueLevel,
      adSaturationCompositeScore: adSaturationOfferFatigue.compositeScore,
      adSaturationEvidenceRequired: adSaturationOfferFatigue.evidenceRequired,
      cityDemandTopNeighborhood: cityDemandMap.topNeighborhoodKey,
      cityDemandHotspotCount: cityDemandMap.hotspotCount,
      cityDemandMappedLeadRatio: cityDemandMap.mappedLeadRatio,
      cityDemandEvidenceRequired: cityDemandMap.evidenceRequired,
      pricingEvidenceCount: pricingMarginInference.evidencePriceCount,
      pricingInferenceConfidence: pricingMarginInference.confidence,
      representativePriceCents: pricingMarginInference.representativePriceCents,
      inferredGrossMarginPct: pricingMarginInference.estimatedGrossMarginPct,
      pricingEvidenceRequired: pricingMarginInference.evidenceRequired,
      neighborhoodLaunchKey: neighborhoodLaunchPlan.selectedNeighborhoodKey,
      neighborhoodLaunchMotion: neighborhoodLaunchPlan.recommendedMotion,
      neighborhoodLaunchPriorityScore: neighborhoodLaunchPlan.priorityScore,
      neighborhoodLaunchEvidenceRequired: neighborhoodLaunchPlan.evidenceRequired,
      marketRecommendationExplainabilityScore: marketRecommendationProvenance.explainabilityScore,
      marketRecommendationTopReasonKeys: marketRecommendationProvenance.topReasons.map((item) => item.key),
      marketRecommendationEvidenceRequired: marketRecommendationProvenance.evidenceRequired,
      confidenceIntervalWidthClass: confidenceIntervals.summary.widthClass,
      confidenceIntervalSpeculative: confidenceIntervals.summary.speculative,
      claimConfidenceFloor: confidenceIntervals.summary.minRatioLow
    },
    unitEconomics: {
      representativePriceCents: priceCents,
      maxAcquisitionCostCents,
      estimatedFulfillmentCostCents: fulfillmentCostCents,
      targetGrossMarginPct: marginModelPct,
      marginModel: group.pack?.marginModel || null,
      marketSizing,
      pricingMarginInference,
      source: group.pack?.marginModel ? 'vertical_pack_margin_model' : 'vertical_pack_price'
    }
  };
}

function applyMarketOutcomeLearningToAssessment({ assessment, existingOpportunity = null, now = Date.now() } = {}) {
  const learning = existingOpportunity?.signals?.marketOutcomeLearning;
  if (!learning || !Number.isFinite(Number(learning.scorePenalty)) || Number(learning.scorePenalty) <= 0) {
    return assessment;
  }
  const scorePenalty = Math.min(0.25, Number(learning.scorePenalty) || 0);
  const revisedScore = Number(clamp((Number(assessment.score) || 0) - scorePenalty).toFixed(4));
  const revisedDecision = learnedDecisionFor({
    opportunity: existingOpportunity,
    revisedScore,
    learning
  });
  return {
    ...assessment,
    score: revisedScore,
    decision: revisedDecision,
    signals: {
      ...(assessment.signals || {}),
      marketRecommendationProvenance: applyLearningToMarketRecommendationProvenance({
        provenance: assessment.signals?.marketRecommendationProvenance,
        revisedDecision,
        revisedScore,
        learning,
        now
      }),
      marketOutcomeLearning: {
        ...learning,
        appliedAt: now,
        appliedScorePenalty: scorePenalty,
        appliedToFreshEvidence: true,
        preLearningScore: Number((Number(assessment.score) || 0).toFixed(4)),
        postLearningScore: revisedScore,
        source: 'market_recommendation_outcome_learning'
      }
    },
    risks: {
      ...(assessment.risks || {}),
      marketOutcomeLearningState: learning.state,
      marketOutcomeLearningApplied: true,
      marketFalsePositiveCount: learning.falsePositiveCount || 0,
      marketFailureCount: learning.marketFailureCount || 0,
      marketFailureReasonKeys: learning.reasonKeys || [],
      marketRecommendationPenalty: scorePenalty,
      learnedDecisionOverride: revisedDecision,
      marketOutcomeEvidenceRequired: learning.evidenceRequired || []
    }
  };
}

function applyLearningToMarketRecommendationProvenance({
  provenance = null,
  revisedDecision,
  revisedScore,
  learning = null,
  now = Date.now()
} = {}) {
  if (!provenance) return provenance;
  const reasonKeys = Array.isArray(learning?.reasonKeys) ? learning.reasonKeys : [];
  return {
    ...provenance,
    decision: revisedDecision || provenance.decision,
    score: Number((Number(revisedScore) || 0).toFixed(4)),
    learningApplied: Boolean(learning),
    learningAppliedAt: learning ? now : null,
    learningReasonKeys: reasonKeys,
    recommendationSummary: learning
      ? `${formatDecisionLabel(revisedDecision)} recommendation includes market outcome learning from ${reasonKeys.join(', ') || learning.state || 'prior outcome'}.`
      : provenance.recommendationSummary
  };
}

function launchBlueprintForOpportunity({ opportunity, brandName, serviceName }) {
  const manifest = opportunity.signals?.verticalManifest || {};
  const pack = getPackByKey(opportunity.vertical_key) || getDefaultPack() || {};
  const source = {
    ...pack,
    ...manifest,
    serviceOffer: manifest.serviceOffer?.packages?.length ? manifest.serviceOffer : pack.serviceOffer,
    marginModel: opportunity.unit_economics?.marginModel || pack.marginModel
  };
  const city = cleanText(opportunity.city);
  const verticalName = cleanText(source.name || opportunity.vertical_key);
  const fallbackBrand = `${city} ${verticalName}`.replace(/\bAnd\b/g, 'and');
  const cleanBrand = cleanText(brandName) || fallbackBrand;
  const cleanService = cleanText(serviceName) || `${city} ${verticalName} Launch`;
  const offer = normalizeBlueprintOffer(source.serviceOffer, source.marginModel);
  const checklist = Array.isArray(source.launchChecklist) ? source.launchChecklist : [];
  const fulfillmentRequirements = Array.isArray(source.fulfillmentRequirements) ? source.fulfillmentRequirements : [];
  const qaRules = Array.isArray(source.qaRules) ? source.qaRules : [];
  const trustRequirements = Array.isArray(source.trustRequirements) ? source.trustRequirements : [];
  const vendorRequirements = Array.isArray(source.vendorRequirements) ? source.vendorRequirements : [];
  const growthPaths = Array.isArray(source.growthPaths) ? source.growthPaths : [];
  const leadSources = Array.isArray(source.leadSources) ? source.leadSources : [];
  const trustAssetPlan = buildServiceTrustAssetPlan({
    opportunity,
    source,
    offer,
    city,
    verticalName,
    trustRequirements
  });
  const bookingFlowPlan = buildServiceBookingFlowPlan({
    opportunity,
    offer,
    city,
    verticalName,
    trustAssetPlan
  });
  const serviceMenuPlan = buildServiceMenuPlan({
    opportunity,
    offer,
    city,
    verticalName,
    trustAssetPlan,
    bookingFlowPlan
  });
  const communicationProvisioningPlan = buildCommunicationProvisioningPlan({
    opportunity,
    city,
    verticalName,
    trustAssetPlan,
    bookingFlowPlan,
    serviceMenuPlan
  });
  const localDomainStrategyPlan = buildLocalDomainStrategyPlan({
    opportunity,
    brandName: cleanBrand,
    serviceName: cleanService,
    city,
    verticalName,
    trustAssetPlan,
    bookingFlowPlan,
    serviceMenuPlan,
    communicationProvisioningPlan
  });
  const launchReadinessWorkItemPlan = buildLaunchReadinessWorkItemPlan({
    opportunity,
    city,
    verticalName,
    checklist,
    trustAssetPlan,
    bookingFlowPlan,
    serviceMenuPlan,
    communicationProvisioningPlan,
    localDomainStrategyPlan
  });
  const serviceScriptPlan = buildServiceScriptPlan({
    opportunity,
    city,
    verticalName,
    bookingFlowPlan,
    serviceMenuPlan,
    communicationProvisioningPlan,
    localDomainStrategyPlan,
    launchReadinessWorkItemPlan
  });
  const serviceCompliancePolicyPlan = buildServiceCompliancePolicyPlan({
    opportunity,
    city,
    verticalName,
    compliance: source.compliance || {},
    trustRequirements,
    trustAssetPlan,
    communicationProvisioningPlan,
    serviceScriptPlan
  });
  const providerSandboxOrchestrationPlan = buildProviderSandboxOrchestrationPlan({
    opportunity,
    city,
    verticalName,
    communicationProvisioningPlan,
    localDomainStrategyPlan,
    launchReadinessWorkItemPlan,
    serviceScriptPlan,
    serviceCompliancePolicyPlan
  });
  const customerOperatingRoomPlan = buildCustomerOperatingRoomPlan({
    opportunity,
    city,
    verticalName,
    bookingFlowPlan,
    serviceMenuPlan,
    serviceScriptPlan,
    serviceCompliancePolicyPlan,
    providerSandboxOrchestrationPlan
  });
  const operatorSupervisionPlan = buildOperatorSupervisionPlan({
    opportunity,
    city,
    verticalName,
    launchReadinessWorkItemPlan,
    serviceScriptPlan,
    serviceCompliancePolicyPlan,
    providerSandboxOrchestrationPlan,
    customerOperatingRoomPlan
  });
  const providerQualitySelectionPlan = buildProviderQualitySelectionPlan({
    opportunity,
    city,
    verticalName,
    providerSandboxOrchestrationPlan,
    serviceCompliancePolicyPlan,
    operatorSupervisionPlan
  });
  const providerMigrationPlan = buildProviderMigrationPlan({
    opportunity,
    city,
    verticalName,
    providerSandboxOrchestrationPlan,
    providerQualitySelectionPlan,
    operatorSupervisionPlan
  });
  const productTelemetryPlan = buildProductTelemetryPlan({
    opportunity,
    city,
    verticalName,
    operatorSupervisionPlan,
    providerQualitySelectionPlan,
    providerMigrationPlan,
    customerOperatingRoomPlan
  });
  const acquisitionExpansionPlan = buildAcquisitionExpansionPlan({
    opportunity,
    city,
    verticalName,
    serviceMenuPlan,
    operatorSupervisionPlan,
    providerQualitySelectionPlan,
    productTelemetryPlan,
    customerOperatingRoomPlan
  });
  const operatingHealthPlan = buildOperatingHealthPlan({
    opportunity,
    city,
    verticalName,
    customerOperatingRoomPlan,
    providerQualitySelectionPlan,
    productTelemetryPlan,
    acquisitionExpansionPlan
  });
  const continualLearningPlan = buildContinualLearningPlan({
    opportunity,
    city,
    verticalName,
    productTelemetryPlan,
    acquisitionExpansionPlan,
    operatingHealthPlan
  });
  const autonomousLaunchLoopPlan = buildAutonomousLaunchLoopPlan({
    opportunity,
    city,
    verticalName,
    brandName: cleanBrand,
    serviceName: cleanService,
    trustAssetPlan,
    bookingFlowPlan,
    serviceMenuPlan,
    communicationProvisioningPlan,
    localDomainStrategyPlan,
    serviceScriptPlan,
    customerOperatingRoomPlan,
    providerQualitySelectionPlan,
    productTelemetryPlan,
    acquisitionExpansionPlan,
    operatingHealthPlan,
    continualLearningPlan
  });
  const verticalLifecyclePlan = buildVerticalLifecyclePlan({
    opportunity,
    source,
    city,
    verticalName,
    serviceName: cleanService,
    operatingHealthPlan,
    continualLearningPlan,
    autonomousLaunchLoopPlan
  });

  return {
    brandName: cleanBrand,
    serviceName: cleanService,
    customerOutcome: offer.customerOutcome || `Customers in ${city} get a clear, trustworthy way to request ${verticalName}.`,
    offer: {
      ...offer,
      serviceMenuPlan
    },
    channels: {
      inboundCall: {
        status: 'planned',
        phoneRequired: true,
        provisioningPlan: communicationProvisioningPlan.phone
      },
      ownerInbox: {
        status: 'planned',
        inboxRequired: true,
        provisioningPlan: communicationProvisioningPlan.inbox
      },
      communicationProvisioning: {
        status: communicationProvisioningPlan.status,
        liveProvisioningAllowed: false,
        plan: communicationProvisioningPlan
      },
      localDomain: {
        status: localDomainStrategyPlan.status,
        liveRegistrationAllowed: false,
        publicDnsAllowed: false,
        plan: localDomainStrategyPlan
      },
      launchReadiness: {
        status: launchReadinessWorkItemPlan.status,
        liveExecutionAllowed: false,
        plan: launchReadinessWorkItemPlan
      },
      serviceScripts: {
        status: serviceScriptPlan.status,
        liveScriptsAllowed: false,
        plan: serviceScriptPlan
      },
      compliancePolicy: {
        status: serviceCompliancePolicyPlan.status,
        liveClaimsAllowed: false,
        plan: serviceCompliancePolicyPlan
      },
      providerSandbox: {
        status: providerSandboxOrchestrationPlan.status,
        liveProviderExecutionAllowed: false,
        plan: providerSandboxOrchestrationPlan
      },
      customerOperatingRoom: {
        status: customerOperatingRoomPlan.status,
        publicPortalAllowed: false,
        plan: customerOperatingRoomPlan
      },
      operatorSupervision: {
        status: operatorSupervisionPlan.status,
        operatorInboxLive: false,
        plan: operatorSupervisionPlan
      },
      providerQuality: {
        status: providerQualitySelectionPlan.status,
        liveRoutingAllowed: false,
        plan: providerQualitySelectionPlan
      },
      providerMigration: {
        status: providerMigrationPlan.status,
        liveMigrationAllowed: false,
        plan: providerMigrationPlan
      },
      productTelemetry: {
        status: productTelemetryPlan.status,
        liveTelemetryAllowed: false,
        plan: productTelemetryPlan
      },
      acquisitionExpansion: {
        status: acquisitionExpansionPlan.status,
        liveOwnerOutreachAllowed: false,
        loiAllowed: false,
        dataRoomAccessAllowed: false,
        acquisitionDecisionAllowed: false,
        plan: acquisitionExpansionPlan
      },
      operatingHealth: {
        status: operatingHealthPlan.status,
        readinessClaimsAllowed: false,
        accelerationAllowed: false,
        plan: operatingHealthPlan
      },
      continualLearning: {
        status: continualLearningPlan.status,
        automaticStrategyRewriteAllowed: false,
        cohortDecisionAllowed: false,
        plan: continualLearningPlan
      },
      autonomousLaunchLoop: {
        status: autonomousLaunchLoopPlan.status,
        liveExecutionAllowed: false,
        externalSideEffectsAllowed: false,
        plan: autonomousLaunchLoopPlan
      },
      verticalLifecycle: {
        status: verticalLifecyclePlan.status,
        liveInstallAllowed: false,
        versionPromotionAllowed: false,
        retirementAllowed: false,
        rollbackAllowed: false,
        plan: verticalLifecyclePlan
      },
      serviceMenu: {
        status: 'draft_required',
        publicMenuAllowed: false,
        plan: serviceMenuPlan
      },
      bookingFlow: {
        status: 'draft_required',
        externalBookingAllowed: false,
        plan: bookingFlowPlan
      },
      localSeo: { status: 'planned', leadSources, growthPaths },
      reviewLoop: { status: growthPaths.length ? 'planned' : 'candidate', reviewStrategy: source.reviewStrategy || [] },
      ownerEmail: { status: 'operator_review_required' }
    },
    readiness: {
      safeToPromote: false,
      source: 'vertical_manifest_launch_blueprint',
      missing: [...new Set([
        ...checklist.slice(0, 8).map((item) => blueprintKey(item)),
        ...trustAssetPlan.requiredAssetKeys,
        ...bookingFlowPlan.requiredSetupKeys,
        ...serviceMenuPlan.requiredSetupKeys,
        ...communicationProvisioningPlan.requiredSetupKeys,
        ...localDomainStrategyPlan.requiredSetupKeys,
        ...launchReadinessWorkItemPlan.requiredSetupKeys,
        ...serviceScriptPlan.requiredSetupKeys,
        ...serviceCompliancePolicyPlan.requiredSetupKeys,
        ...providerSandboxOrchestrationPlan.requiredSetupKeys,
        ...customerOperatingRoomPlan.requiredSetupKeys,
        ...operatorSupervisionPlan.requiredSetupKeys,
        ...providerQualitySelectionPlan.requiredSetupKeys,
        ...providerMigrationPlan.requiredSetupKeys,
        ...productTelemetryPlan.requiredSetupKeys,
        ...acquisitionExpansionPlan.requiredSetupKeys,
        ...operatingHealthPlan.requiredSetupKeys,
        ...continualLearningPlan.requiredSetupKeys,
        ...autonomousLaunchLoopPlan.requiredSetupKeys,
        ...verticalLifecyclePlan.requiredSetupKeys,
        'operator_launch_approval'
      ])],
      trustAssetPlan,
      bookingFlowPlan,
      serviceMenuPlan,
      communicationProvisioningPlan,
      localDomainStrategyPlan,
      launchReadinessWorkItemPlan,
      serviceScriptPlan,
      serviceCompliancePolicyPlan,
      providerSandboxOrchestrationPlan,
      customerOperatingRoomPlan,
      operatorSupervisionPlan,
      providerQualitySelectionPlan,
      providerMigrationPlan,
      productTelemetryPlan,
      acquisitionExpansionPlan,
      operatingHealthPlan,
      continualLearningPlan,
      autonomousLaunchLoopPlan,
      verticalLifecyclePlan,
      gates: {
        trust: trustRequirements.length ? 'required' : 'review',
        compliance: source.compliance?.restrictedClaims?.length ? 'required' : 'review',
        fulfillment: fulfillmentRequirements.length ? 'required' : 'review',
        margin: source.marginModel ? 'required' : 'review'
      },
      manifest: {
        launchChecklist: checklist,
        qaRules,
        trustRequirements
      }
    },
    capabilities: [
      {
        key: 'owned-acquisition-surface',
        name: 'Owned acquisition surface',
        kind: 'digital_delivery',
        status: 'planned',
        provider: 'builder',
        requirements: {
          serviceOffer: offer.headline,
          proofAssets: offer.proofAssets || [],
          qaRules
        },
        cost: {
          estimatedFulfillmentCostCents: source.marginModel?.estimatedFulfillmentCostCents ?? null,
          targetGrossMarginPct: source.marginModel?.targetGrossMarginPct ?? null
        }
      },
      {
        key: 'trust-and-compliance-review',
        name: 'Trust and compliance review',
        kind: 'approval',
        status: 'required',
        requirements: {
          restrictedClaims: source.compliance?.restrictedClaims || [],
          trustRequirements,
          trustAssetPlan,
          serviceCompliancePolicyPlan
        }
      },
      {
        key: 'booking-flow-draft',
        name: 'Booking flow draft',
        kind: 'customer_intake',
        status: 'draft_required',
        provider: null,
        requirements: bookingFlowPlan
      },
      {
        key: 'service-menu-draft',
        name: 'Service menu draft',
        kind: 'offer_design',
        status: 'draft_required',
        provider: null,
        requirements: serviceMenuPlan
      },
      {
        key: 'communication-provisioning-plan',
        name: 'Phone and inbox provisioning plan',
        kind: 'communications',
        status: 'blocked_pending_provider',
        provider: null,
        requirements: communicationProvisioningPlan
      },
      {
        key: 'local-domain-strategy-plan',
        name: 'Local domain strategy plan',
        kind: 'digital_identity',
        status: 'blocked_pending_domain_proof',
        provider: null,
        requirements: localDomainStrategyPlan
      },
      {
        key: 'launch-readiness-work-items',
        name: 'Launch readiness work items',
        kind: 'operator_workflow',
        status: 'work_items_required',
        provider: null,
        requirements: launchReadinessWorkItemPlan
      },
      {
        key: 'service-script-drafts',
        name: 'Phone, email, SMS, chat, and subcontractor scripts',
        kind: 'communications_and_fulfillment',
        status: 'drafts_required',
        provider: null,
        requirements: serviceScriptPlan
      },
      {
        key: 'service-compliance-policy-plan',
        name: 'Region and restricted-advice policy plan',
        kind: 'compliance',
        status: 'operator_review_required',
        provider: null,
        requirements: serviceCompliancePolicyPlan
      },
      {
        key: 'provider-sandbox-orchestration',
        name: 'Provider sandbox orchestration',
        kind: 'resilience',
        status: 'mock_orchestration_ready',
        provider: null,
        requirements: providerSandboxOrchestrationPlan
      },
      {
        key: 'customer-operating-room-plan',
        name: 'Customer operating room plan',
        kind: 'customer_portal',
        status: 'draft_required',
        provider: null,
        requirements: customerOperatingRoomPlan
      },
      {
        key: 'operator-supervision-plan',
        name: 'Operator supervision plan',
        kind: 'operator_workflow',
        status: 'draft_required',
        provider: null,
        requirements: operatorSupervisionPlan
      },
      {
        key: 'provider-quality-selection-plan',
        name: 'Provider quality and selection plan',
        kind: 'provider_management',
        status: 'draft_required',
        provider: null,
        requirements: providerQualitySelectionPlan
      },
      {
        key: 'provider-migration-plan',
        name: 'Provider migration plan',
        kind: 'provider_management',
        status: 'draft_required',
        provider: null,
        requirements: providerMigrationPlan
      },
      {
        key: 'product-telemetry-work-generation-plan',
        name: 'Product telemetry and work generation plan',
        kind: 'product_intelligence',
        status: 'draft_required',
        provider: null,
        requirements: productTelemetryPlan
      },
      {
        key: 'acquisition-expansion-plan',
        name: 'Acquisition expansion plan',
        kind: 'acquisition',
        status: 'draft_required',
        provider: null,
        requirements: acquisitionExpansionPlan
      },
      {
        key: 'operating-health-plan',
        name: 'Operating health and SLA plan',
        kind: 'operating_health',
        status: 'draft_required',
        provider: null,
        requirements: operatingHealthPlan
      },
      {
        key: 'continual-learning-plan',
        name: 'Objection taxonomy and cohort learning plan',
        kind: 'learning',
        status: 'draft_required',
        provider: null,
        requirements: continualLearningPlan
      },
      {
        key: 'autonomous-launch-loop-plan',
        name: 'Autonomous launch loop plan',
        kind: 'operating_loop',
        status: 'draft_required',
        provider: null,
        requirements: autonomousLaunchLoopPlan
      },
      {
        key: 'vertical-lifecycle-plan',
        name: 'Vertical pack lifecycle plan',
        kind: 'vertical_management',
        status: 'draft_required',
        provider: null,
        requirements: verticalLifecyclePlan
      },
      {
        key: 'fulfillment-readiness',
        name: 'Fulfillment readiness',
        kind: 'fulfillment',
        status: fulfillmentRequirements.length ? 'planned' : 'candidate',
        requirements: { fulfillmentRequirements, vendorRequirements }
      }
    ],
    workflows: [
      {
        key: `${opportunity.vertical_key}-manifest-launch`,
        name: `${verticalName} manifest launch`,
        version: 1,
        status: 'draft',
        entityType: 'service_business',
        states: ['draft', 'evidence_review', 'offer_approved', 'ready_for_public_launch'],
        steps: [
          { key: 'verify-evidence', label: 'Verify source evidence', requirements: trustRequirements },
          { key: 'approve-offer', label: 'Approve offer and margin', marginModel: source.marginModel || null },
          { key: 'qa-launch-surface', label: 'QA acquisition surface', qaRules },
          { key: 'operator-gate', label: 'Operator launch approval', required: true }
        ],
        policies: {
          noFakeClaims: true,
          agentsAreInternalLabor: true,
          restrictedClaims: source.compliance?.restrictedClaims || []
        }
      }
    ],
    vendorPartners: vendorRequirements.length ? [{
      name: `${city} ${verticalName} Vendor Bench`,
      status: 'candidate',
      capabilities: vendorRequirements.map((item) => blueprintKey(item)).slice(0, 8),
      compliance: source.compliance || {},
      payout: {
        model: 'operator_review_required',
        marginModel: source.marginModel || null
      }
    }] : []
  };
}

function buildServiceTrustAssetPlan({
  opportunity,
  source = {},
  offer = {},
  city = '',
  verticalName = '',
  trustRequirements = []
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const formation = signals.formationPermitSummary || {};
  const pricing = signals.pricingMarginInference || {};
  const neighborhood = signals.neighborhoodLaunchPlan || {};
  const sourceUrls = [...new Set([
    ...(provenance.sourceUrls || []),
    ...(pricing.sourceUrls || []),
    ...(neighborhood.sourceUrls || [])
  ].map(cleanText).filter(Boolean))].slice(0, 12);
  const evidenceLeadIds = [...new Set([
    ...(provenance.evidenceLeadIds || []),
    ...(pricing.evidenceLeadIds || []),
    ...(neighborhood.evidenceLeadIds || [])
  ].map(cleanText).filter(Boolean))].slice(0, 16);
  const restrictedClaims = Array.isArray(source.compliance?.restrictedClaims) ? source.compliance.restrictedClaims : [];
  const requiredAssetKeys = [
    'trust_page_required',
    'privacy_notice_required',
    'refund_policy_required',
    'pricing_disclosure_required',
    'service_area_proof_required',
    ...(formation.licenseSensitive || restrictedClaims.length ? ['license_and_claim_review_required'] : []),
    ...(neighborhood.selectedNeighborhoodKey ? ['neighborhood_launch_proof_required'] : []),
    ...(provenance.evidenceRequired || []),
    ...(trustRequirements || []).map((item) => `${blueprintKey(item)}_trust_proof_required`)
  ];
  const assets = [
    {
      key: 'trust_page',
      label: `${city} ${verticalName} trust page`.trim(),
      status: 'draft_required',
      purpose: 'Explain who operates the service, what claims are supported, and where proof came from.',
      evidenceLeadIds,
      sourceUrls: sourceUrls.slice(0, 6)
    },
    {
      key: 'pricing_disclosure',
      label: 'Pricing and diagnostic fee disclosure',
      status: pricing.representativePriceCents ? 'evidence_ready' : 'draft_required',
      purpose: 'Show customer-facing price boundaries without implying live quotes or unapproved discounts.',
      evidenceLeadIds: pricing.evidenceLeadIds || [],
      sourceUrls: pricing.sourceUrls || []
    },
    {
      key: 'service_area_proof',
      label: 'Service-area proof',
      status: neighborhood.selectedNeighborhoodKey ? 'evidence_ready' : 'draft_required',
      purpose: 'Tie the first public launch surface to the selected neighborhood and source evidence.',
      evidenceLeadIds: neighborhood.evidenceLeadIds || [],
      sourceUrls: neighborhood.sourceUrls || []
    },
    {
      key: 'privacy_notice',
      label: 'Privacy and contact policy',
      status: 'draft_required',
      purpose: 'Tell customers how calls, forms, messages, and internal agent labor are handled.'
    },
    {
      key: 'refund_policy',
      label: 'Refund and remediation policy',
      status: cleanText(offer.refundPolicy) ? 'draft_required' : 'missing_policy',
      purpose: 'Publish only operator-approved refund and remediation boundaries.'
    },
    {
      key: 'license_claim_review',
      label: 'License and restricted-claim review',
      status: formation.licenseSensitive || restrictedClaims.length ? 'operator_review_required' : 'not_required',
      purpose: 'Keep license, insured, bonded, emergency, ranking, and regulated-service claims blocked until proof is attached.',
      restrictedClaims
    }
  ];
  return {
    status: 'draft_required',
    assetCount: assets.length,
    requiredAssetKeys: [...new Set(requiredAssetKeys)].slice(0, 20),
    assets,
    customerPromiseBoundary: 'no live promises, price guarantees, emergency response guarantees, or regulated claims before operator approval',
    publicClaimsAllowed: false,
    externalPublicationAllowed: false,
    provenance: {
      opportunityId: opportunity?.id || null,
      provenanceSource: provenance.source || null,
      explainabilityScore: provenance.explainabilityScore ?? null,
      topReasonKeys: (provenance.topReasons || []).map((item) => item.key).slice(0, 6),
      selectedNeighborhoodKey: neighborhood.selectedNeighborhoodKey || null,
      representativePriceCents: pricing.representativePriceCents || null
    },
    evidenceLeadIds,
    sourceUrls,
    assumptions: [
      'trust assets are generated from stored market provenance, vertical-pack rules, pricing evidence, and launch-plan evidence only',
      'draft assets are not public pages until safe-to-launch gates and operator approval pass',
      'restricted claims remain blocked even when supporting local evidence exists'
    ],
    source: 'market_provenance_trust_asset_plan'
  };
}

function buildServiceBookingFlowPlan({
  opportunity,
  offer = {},
  city = '',
  verticalName = '',
  trustAssetPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const neighborhood = signals.neighborhoodLaunchPlan || {};
  const pricing = signals.pricingMarginInference || {};
  const urgency = signals.serviceUrgency || {};
  const searchIntent = signals.searchIntentCapture || {};
  const packageKeys = (offer.packages || []).map((item) => cleanKey(item.key || item.name)).filter(Boolean).slice(0, 6);
  const representativePriceCents = pricing.representativePriceCents || offer.packages?.[0]?.priceCents || null;
  const emergencyFirst = urgency.urgencyClass === 'emergency_first' || searchIntent.intentClass === 'urgent_local_search';
  const requiredSetupKeys = [
    'booking_flow_copy_required',
    'service_area_validation_required',
    'customer_contact_consent_required',
    'operator_booking_approval_required',
    'calendar_provider_live_smoke_required',
    'phone_number_and_inbox_required',
    ...(trustAssetPlan?.requiredAssetKeys?.length ? ['trust_assets_required'] : []),
    ...(representativePriceCents ? ['price_boundary_acknowledgement_required'] : ['pricing_review_required']),
    ...(emergencyFirst ? ['emergency_response_boundary_required'] : [])
  ];
  const steps = [
    {
      key: 'service_area_check',
      label: 'Service area check',
      status: neighborhood.selectedNeighborhoodKey ? 'draft_ready' : 'needs_area_evidence',
      requiredFields: ['service_address', 'service_zip'],
      evidence: neighborhood.selectedNeighborhoodKey ? [neighborhood.selectedNeighborhoodKey] : []
    },
    {
      key: 'problem_intake',
      label: 'Problem intake',
      status: 'draft_ready',
      requiredFields: ['issue_type', 'symptoms', 'preferred_window'],
      packageKeys
    },
    {
      key: 'urgency_triage',
      label: 'Urgency triage',
      status: emergencyFirst ? 'operator_boundary_required' : 'draft_ready',
      requiredFields: ['urgency_level', 'after_hours_request'],
      boundary: emergencyFirst ? 'must not promise emergency response until operator-approved coverage exists' : 'standard response window can be reviewed by operator'
    },
    {
      key: 'contact_permission',
      label: 'Contact permission',
      status: 'draft_ready',
      requiredFields: ['customer_name', 'phone', 'email', 'consent_to_contact']
    },
    {
      key: 'price_boundary_acknowledgement',
      label: 'Price boundary acknowledgement',
      status: representativePriceCents ? 'draft_ready' : 'pricing_review_required',
      requiredFields: ['diagnostic_acknowledgement', 'quote_before_work_acknowledgement'],
      representativePriceCents
    },
    {
      key: 'operator_review',
      label: 'Operator review before confirmation',
      status: 'required',
      requiredFields: ['operator_approval']
    }
  ];
  return {
    status: 'draft_required',
    externalBookingAllowed: false,
    calendarReservationAllowed: false,
    customerPromiseAllowed: false,
    areaKey: neighborhood.selectedNeighborhoodKey || null,
    areaLabel: neighborhood.selectedNeighborhoodLabel || city || null,
    recommendedMotion: neighborhood.recommendedMotion || searchIntent.recommendedCaptureSurface || null,
    representativePriceCents,
    urgencyClass: urgency.urgencyClass || null,
    packageKeys,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 16),
    intakeFields: [...new Set(steps.flatMap((step) => step.requiredFields || []))],
    steps,
    evidenceLeadIds: [...new Set([
      ...(neighborhood.evidenceLeadIds || []),
      ...(pricing.evidenceLeadIds || []),
      ...(trustAssetPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(neighborhood.sourceUrls || []),
      ...(pricing.sourceUrls || []),
      ...(trustAssetPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'collect an intake request only; do not reserve calendars, dispatch vendors, promise emergency response, or confirm price before operator approval',
    assumptions: [
      'booking flow is generated from local market provenance, service offer, pricing evidence, trust assets, and neighborhood launch plan',
      'the first-party booking draft captures intent but does not mutate calendars, assign vendors, send confirmations, or create customer promises',
      'live booking requires provider smoke, phone/inbox setup, calendar adapter proof, and operator approval'
    ],
    source: 'market_provenance_booking_flow_plan'
  };
}

function buildServiceMenuPlan({
  opportunity,
  offer = {},
  city = '',
  verticalName = '',
  trustAssetPlan = null,
  bookingFlowPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const pricing = signals.pricingMarginInference || {};
  const neighborhood = signals.neighborhoodLaunchPlan || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const representativePriceCents = pricing.representativePriceCents || offer.packages?.[0]?.priceCents || null;
  const grossMarginPct = Number.isFinite(Number(pricing.estimatedGrossMarginPct))
    ? pricing.estimatedGrossMarginPct
    : null;
  const basePackages = Array.isArray(offer.packages) && offer.packages.length ? offer.packages : [{
    key: 'launch',
    name: `${verticalName} request`,
    priceCents: representativePriceCents
  }];
  const packageDrafts = basePackages.map((item, index) => {
    const key = cleanKey(item.key || item.name || `package_${index + 1}`);
    const observedPrice = index === 0 && representativePriceCents ? representativePriceCents : item.priceCents || representativePriceCents;
    return {
      key,
      name: cleanText(item.name || item.label || item.headline) || `${verticalName} package ${index + 1}`.trim(),
      status: 'draft_required',
      priceCents: observedPrice || null,
      evidencePriceCents: index === 0 ? pricing.observedServicePriceCents || [] : [],
      estimatedGrossMarginPct: grossMarginPct,
      recommendedForAreaKey: neighborhood.selectedNeighborhoodKey || null,
      bookingStepKeys: (bookingFlowPlan?.steps || []).map((step) => step.key).slice(0, 6),
      proofRequired: ['operator_offer_approval', 'pricing_disclosure', 'service_area_boundary'],
      publicPriceAllowed: false
    };
  });
  const requiredSetupKeys = [
    'service_menu_copy_required',
    'operator_offer_approval_required',
    'package_margin_review_required',
    'pricing_disclosure_required',
    'service_area_boundary_required',
    'booking_flow_alignment_required',
    ...(trustAssetPlan?.requiredAssetKeys?.includes('license_and_claim_review_required') ? ['regulated_claim_review_required'] : []),
    ...(representativePriceCents ? [] : ['representative_price_evidence_required'])
  ];
  return {
    status: 'draft_required',
    publicMenuAllowed: false,
    publicPriceAllowed: false,
    packageCount: packageDrafts.length,
    areaKey: neighborhood.selectedNeighborhoodKey || null,
    areaLabel: neighborhood.selectedNeighborhoodLabel || city || null,
    representativePriceCents,
    estimatedGrossMarginPct: grossMarginPct,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 16),
    menuSections: [
      {
        key: 'primary_service_request',
        label: `${verticalName} request`.trim(),
        packageKeys: packageDrafts.map((item) => item.key),
        status: 'draft_required'
      },
      {
        key: 'trust_and_boundaries',
        label: 'Trust, price, and response boundaries',
        packageKeys: [],
        status: 'operator_review_required'
      }
    ],
    packages: packageDrafts,
    evidenceLeadIds: [...new Set([
      ...(pricing.evidenceLeadIds || []),
      ...(neighborhood.evidenceLeadIds || []),
      ...(trustAssetPlan?.evidenceLeadIds || []),
      ...(bookingFlowPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(pricing.sourceUrls || []),
      ...(neighborhood.sourceUrls || []),
      ...(trustAssetPlan?.sourceUrls || []),
      ...(bookingFlowPlan?.sourceUrls || [])
    ])].slice(0, 12),
    provenance: {
      opportunityId: opportunity?.id || null,
      explainabilityScore: provenance.explainabilityScore ?? null,
      topReasonKeys: (provenance.topReasons || []).map((item) => item.key).slice(0, 6),
      bookingFlowSource: bookingFlowPlan?.source || null,
      trustAssetSource: trustAssetPlan?.source || null
    },
    customerPromiseBoundary: 'menu is an internal draft; do not publish prices, discounts, emergency response claims, or availability promises before operator approval',
    assumptions: [
      'service menu is generated from vertical-pack offer packages, local pricing evidence, trust assets, booking-flow fields, and neighborhood launch plan',
      'public prices and package claims stay blocked until operator review and safe-to-launch gates pass',
      'no payment link, calendar reservation, customer quote, discount, or public menu page is created by this draft'
    ],
    source: 'market_provenance_service_menu_plan'
  };
}

function buildCommunicationProvisioningPlan({
  opportunity,
  city = '',
  verticalName = '',
  trustAssetPlan = null,
  bookingFlowPlan = null,
  serviceMenuPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const neighborhood = signals.neighborhoodLaunchPlan || {};
  const urgency = signals.serviceUrgency || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const emergencyBoundaryRequired = urgency.urgencyClass === 'emergency_first';
  const phoneBlockers = [
    'agentphone_provider_link_required',
    'local_phone_number_inventory_required',
    'recording_disclosure_copy_required',
    'dnc_and_quiet_hours_policy_required',
    ...(emergencyBoundaryRequired ? ['emergency_escalation_boundary_required'] : [])
  ];
  const inboxBlockers = [
    'agentmail_provider_link_required',
    'local_inbox_alias_required',
    'reply_policy_required',
    'opt_out_and_privacy_copy_required'
  ];
  const requiredSetupKeys = [
    ...phoneBlockers,
    ...inboxBlockers,
    'operator_communications_approval_required',
    'booking_flow_routing_required',
    'trust_asset_copy_alignment_required'
  ];
  const routingRules = [
    {
      key: 'booking_intake',
      channel: 'phone_and_email',
      status: 'draft_required',
      target: bookingFlowPlan?.source || 'booking_flow_plan_required'
    },
    {
      key: 'missed_call_followup',
      channel: 'phone',
      status: 'blocked_pending_agentphone',
      target: 'missed_call_rescue_workflow'
    },
    {
      key: 'quote_and_policy_recap',
      channel: 'email',
      status: 'blocked_pending_agentmail',
      target: serviceMenuPlan?.source || 'service_menu_plan_required'
    }
  ];
  return {
    status: 'blocked_pending_provider',
    liveProvisioningAllowed: false,
    phone: {
      status: 'provider_required',
      provider: 'agentphone',
      localNumberRequired: true,
      liveProvisioningAllowed: false,
      blockers: phoneBlockers
    },
    inbox: {
      status: 'provider_required',
      provider: 'agentmail',
      localInboxRequired: true,
      liveProvisioningAllowed: false,
      blockers: inboxBlockers
    },
    areaKey: neighborhood.selectedNeighborhoodKey || null,
    areaLabel: neighborhood.selectedNeighborhoodLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    urgencyClass: urgency.urgencyClass || null,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 16),
    routingRules,
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(trustAssetPlan?.evidenceLeadIds || []),
      ...(bookingFlowPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(trustAssetPlan?.sourceUrls || []),
      ...(bookingFlowPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'do not provision phone numbers, send emails, place calls, record calls, promise response times, or route live customers before provider links and operator approval exist',
    assumptions: [
      'phone and inbox provisioning is a local readiness plan derived from market provenance, booking flow, trust assets, and service menu only',
      'AgentPhone and AgentMail are required live providers, but this plan does not call either provider or reserve any number or inbox',
      'recording disclosure, DNC/quiet-hours, opt-out, privacy, and emergency-response boundaries must be approved before live communication'
    ],
    source: 'market_provenance_communication_provisioning_plan'
  };
}

function buildLocalDomainStrategyPlan({
  opportunity,
  brandName = '',
  serviceName = '',
  city = '',
  verticalName = '',
  trustAssetPlan = null,
  bookingFlowPlan = null,
  serviceMenuPlan = null,
  communicationProvisioningPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const neighborhood = signals.neighborhoodLaunchPlan || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const brandSlug = cleanKey(brandName || serviceName || `${city} ${verticalName}`).replace(/_/g, '-');
  const serviceSlug = cleanKey(`${city} ${verticalName}`).replace(/_/g, '-');
  const routePath = `/${cleanKey(city).replace(/_/g, '-') || 'local'}/${cleanKey(verticalName || opportunity?.vertical_key).replace(/_/g, '-') || 'service'}`;
  const requiredSetupKeys = [
    'domain_search_required',
    'domain_ownership_proof_required',
    'dns_provider_link_required',
    'ssl_certificate_plan_required',
    'brand_conflict_review_required',
    'nap_consistency_review_required',
    'local_seo_slug_review_required',
    'operator_domain_approval_required',
    ...(communicationProvisioningPlan?.requiredSetupKeys?.includes('agentphone_provider_link_required')
      ? ['phone_inbox_alignment_required']
      : []),
    ...(trustAssetPlan?.requiredAssetKeys?.includes('service_area_proof_required')
      ? ['service_area_domain_claim_review_required']
      : [])
  ];
  const candidateDomains = [
    {
      domain: `${brandSlug}.com`,
      strategy: 'owned_domain',
      status: 'search_required',
      proofRequired: ['availability_check', 'trademark_review', 'operator_approval']
    },
    {
      domain: `${serviceSlug}.com`,
      strategy: 'city_vertical_domain',
      status: 'search_required',
      proofRequired: ['availability_check', 'local_claim_review', 'operator_approval']
    },
    {
      domain: `${brandSlug}.callan.local`,
      strategy: 'callan_controlled_subdomain',
      status: 'internal_draft_only',
      proofRequired: ['owned_surface_mapping', 'local_seo_slug_review']
    }
  ];
  const dnsPlan = [
    {
      key: 'apex_and_www',
      status: 'blocked_pending_dns_provider',
      records: ['A_or_CNAME_apex', 'CNAME_www'],
      providerRequired: true
    },
    {
      key: 'mail_authentication',
      status: 'blocked_pending_agentmail',
      records: ['SPF', 'DKIM', 'DMARC'],
      providerRequired: true
    },
    {
      key: 'ssl_certificate',
      status: 'blocked_pending_dns_validation',
      records: ['ACME_http_or_dns_challenge'],
      providerRequired: true
    }
  ];
  return {
    status: 'blocked_pending_domain_proof',
    preferredStrategy: 'callan_subdomain_then_owned_domain',
    liveRegistrationAllowed: false,
    publicDnsAllowed: false,
    externalPublicationAllowed: false,
    routePath,
    canonicalDraftUrl: `https://app.callan.local${routePath}`,
    areaKey: neighborhood.selectedNeighborhoodKey || null,
    areaLabel: neighborhood.selectedNeighborhoodLabel || city || null,
    brandSlug,
    serviceSlug,
    primaryCandidateDomain: candidateDomains[0].domain,
    candidateDomains,
    dnsPlan,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 16),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(trustAssetPlan?.evidenceLeadIds || []),
      ...(bookingFlowPlan?.evidenceLeadIds || []),
      ...(serviceMenuPlan?.evidenceLeadIds || []),
      ...(communicationProvisioningPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(trustAssetPlan?.sourceUrls || []),
      ...(bookingFlowPlan?.sourceUrls || []),
      ...(serviceMenuPlan?.sourceUrls || []),
      ...(communicationProvisioningPlan?.sourceUrls || [])
    ])].slice(0, 12),
    provenance: {
      opportunityId: opportunity?.id || null,
      explainabilityScore: provenance.explainabilityScore ?? null,
      topReasonKeys: (provenance.topReasons || []).map((item) => item.key).slice(0, 6),
      selectedNeighborhoodKey: neighborhood.selectedNeighborhoodKey || null,
      trustAssetSource: trustAssetPlan?.source || null,
      bookingFlowSource: bookingFlowPlan?.source || null,
      serviceMenuSource: serviceMenuPlan?.source || null,
      communicationSource: communicationProvisioningPlan?.source || null
    },
    customerPromiseBoundary: 'domain strategy is an internal plan; do not register domains, mutate DNS, issue certificates, publish pages, or imply local ownership before proof and operator approval',
    assumptions: [
      'domain strategy is derived from brand, city, vertical, selected neighborhood, trust assets, booking flow, service menu, and communication provisioning plan',
      'owned domains and DNS remain blocked until availability, ownership, brand-conflict, NAP, SSL, and operator approvals are complete',
      'the Callan-local draft URL is a planning placeholder and does not publish a customer-facing website or reserve a public domain'
    ],
    source: 'market_provenance_local_domain_strategy_plan'
  };
}

function buildLaunchReadinessWorkItemPlan({
  opportunity,
  city = '',
  verticalName = '',
  checklist = [],
  trustAssetPlan = null,
  bookingFlowPlan = null,
  serviceMenuPlan = null,
  communicationProvisioningPlan = null,
  localDomainStrategyPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const neighborhood = signals.neighborhoodLaunchPlan || {};
  const workItems = [
    {
      key: 'assemble_trust_assets',
      lane: 'trust',
      status: 'blocked_pending_assets',
      source: trustAssetPlan?.source || 'trust_asset_plan_required',
      requiredProofKeys: (trustAssetPlan?.requiredAssetKeys || []).slice(0, 8),
      output: 'operator-approved trust and claim proof packet'
    },
    {
      key: 'draft_booking_flow',
      lane: 'customer_intake',
      status: 'draft_required',
      source: bookingFlowPlan?.source || 'booking_flow_plan_required',
      requiredProofKeys: (bookingFlowPlan?.requiredSetupKeys || []).slice(0, 8),
      output: 'reviewed service-area, urgency, contact, price-boundary, and operator-approval intake steps'
    },
    {
      key: 'approve_service_menu',
      lane: 'offer_design',
      status: 'operator_review_required',
      source: serviceMenuPlan?.source || 'service_menu_plan_required',
      requiredProofKeys: (serviceMenuPlan?.requiredSetupKeys || []).slice(0, 8),
      output: 'operator-approved menu copy, package boundaries, proof requirements, and pricing disclosure'
    },
    {
      key: 'link_phone_and_inbox',
      lane: 'communications',
      status: 'blocked_pending_provider',
      source: communicationProvisioningPlan?.source || 'communication_provisioning_plan_required',
      requiredProofKeys: (communicationProvisioningPlan?.requiredSetupKeys || []).slice(0, 8),
      output: 'AgentPhone and AgentMail proof packet with routing, opt-out, DNC, privacy, and emergency boundaries'
    },
    {
      key: 'approve_local_domain_strategy',
      lane: 'digital_identity',
      status: 'blocked_pending_domain_proof',
      source: localDomainStrategyPlan?.source || 'local_domain_strategy_plan_required',
      requiredProofKeys: (localDomainStrategyPlan?.requiredSetupKeys || []).slice(0, 8),
      output: 'domain candidate, draft URL, DNS/TLS/email-authentication, NAP, and brand-conflict proof packet'
    },
    {
      key: 'operator_launch_gate',
      lane: 'launch_control',
      status: 'blocked_pending_dependencies',
      source: 'vertical_manifest_launch_blueprint',
      requiredProofKeys: [
        'safe_to_launch_gate_pass_required',
        'operator_launch_approval_required',
        'rollback_plan_required',
        'live_smoke_evidence_required'
      ],
      output: 'final launch decision packet with dry-run proof and rollback metadata'
    }
  ];
  const blockedCount = workItems.filter((item) => item.status.includes('blocked')).length;
  const draftCount = workItems.filter((item) => item.status.includes('draft') || item.status.includes('review')).length;
  const requiredSetupKeys = [
    'launch_work_item_owner_required',
    'launch_runbook_required',
    'provider_proof_packet_required',
    'operator_launch_gate_required',
    'rollback_plan_required',
    ...workItems.flatMap((item) => item.requiredProofKeys || []).slice(0, 24)
  ];
  return {
    status: 'work_items_required',
    liveExecutionAllowed: false,
    externalSideEffectsAllowed: false,
    workItemCount: workItems.length,
    blockedCount,
    draftCount,
    readyCount: workItems.length - blockedCount - draftCount,
    areaKey: neighborhood.selectedNeighborhoodKey || null,
    areaLabel: neighborhood.selectedNeighborhoodLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 28),
    prerequisitePlanSources: [
      trustAssetPlan?.source,
      bookingFlowPlan?.source,
      serviceMenuPlan?.source,
      communicationProvisioningPlan?.source,
      localDomainStrategyPlan?.source
    ].filter(Boolean),
    workItems,
    manifestChecklistKeys: (checklist || []).map((item) => blueprintKey(item)).slice(0, 12),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(trustAssetPlan?.evidenceLeadIds || []),
      ...(bookingFlowPlan?.evidenceLeadIds || []),
      ...(serviceMenuPlan?.evidenceLeadIds || []),
      ...(communicationProvisioningPlan?.evidenceLeadIds || []),
      ...(localDomainStrategyPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(trustAssetPlan?.sourceUrls || []),
      ...(bookingFlowPlan?.sourceUrls || []),
      ...(serviceMenuPlan?.sourceUrls || []),
      ...(communicationProvisioningPlan?.sourceUrls || []),
      ...(localDomainStrategyPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'launch work items are local operator tasks only; do not execute provider mutations, publish external surfaces, promise customers, dispatch vendors, or spend money before launch gates pass',
    assumptions: [
      'launch work items are generated from existing readiness plans and vertical-manifest checklist items',
      'each item requires operator-owned proof before any provider mutation or customer-facing launch step',
      'this plan records the runbook shape only and does not enqueue external jobs, spend money, publish pages, reserve domains, call customers, or send messages'
    ],
    source: 'market_provenance_launch_readiness_work_item_plan'
  };
}

function buildServiceScriptPlan({
  opportunity,
  city = '',
  verticalName = '',
  bookingFlowPlan = null,
  serviceMenuPlan = null,
  communicationProvisioningPlan = null,
  localDomainStrategyPlan = null,
  launchReadinessWorkItemPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const urgency = signals.serviceUrgency || {};
  const areaLabel = bookingFlowPlan?.areaLabel
    || communicationProvisioningPlan?.areaLabel
    || localDomainStrategyPlan?.areaLabel
    || city
    || null;
  const serviceLabel = verticalName || cleanText(opportunity?.vertical_key) || 'service';
  const priceText = Number.isFinite(serviceMenuPlan?.representativePriceCents)
    ? `$${Math.round(serviceMenuPlan.representativePriceCents / 100)} representative ticket`
    : 'operator-approved price boundary';
  const scriptDrafts = [
    {
      key: 'phone_booking_intake_script',
      channel: 'phone',
      provider: 'agentphone',
      status: 'draft_required',
      liveUseAllowed: false,
      audience: 'inbound caller',
      sections: [
        `Introduce ${serviceLabel} help for ${areaLabel || city || 'the local service area'}.`,
        'Give recording disclosure before collecting problem details.',
        'Confirm service address, callback number, urgency, and consent to contact.',
        `State that ${priceText} is not a final quote until operator review.`,
        'Escalate emergencies only through approved boundaries; never promise immediate dispatch.'
      ],
      requiredProofKeys: [
        'recording_disclosure_copy_required',
        'dnc_and_quiet_hours_policy_required',
        'operator_phone_script_approval_required'
      ]
    },
    {
      key: 'email_quote_recap_template',
      channel: 'email',
      provider: 'agentmail',
      status: 'draft_required',
      liveUseAllowed: false,
      audience: 'customer lead',
      sections: [
        'Recap requested service, service area, contact permission, and next review step.',
        'Link only to approved owned surfaces after launch approval.',
        'Include privacy, opt-out, price-boundary, and no-emergency-guarantee language.'
      ],
      requiredProofKeys: [
        'agentmail_provider_link_required',
        'opt_out_and_privacy_copy_required',
        'operator_email_template_approval_required'
      ]
    },
    {
      key: 'sms_status_update_template',
      channel: 'sms',
      provider: 'sms_provider_required',
      status: 'blocked_pending_sms_provider',
      liveUseAllowed: false,
      audience: 'opted-in customer',
      sections: [
        'Ask for or confirm SMS consent before any status update.',
        'Use short status copy with opt-out language and no dispatch promise.',
        'Route replies back to the operator review queue until live SMS proof exists.'
      ],
      requiredProofKeys: [
        'sms_provider_link_required',
        'sms_consent_copy_required',
        'quiet_hours_policy_required',
        'operator_sms_template_approval_required'
      ]
    },
    {
      key: 'web_chat_intake_script',
      channel: 'web_chat',
      provider: 'chat_widget_provider_required',
      status: 'blocked_pending_chat_widget',
      liveUseAllowed: false,
      audience: 'website visitor',
      sections: [
        'Collect service area, problem, contact permission, and urgency class.',
        'Show privacy and transcript-retention notice before handoff.',
        'Create only an internal operator-review handoff before live widget proof exists.'
      ],
      requiredProofKeys: [
        'chat_widget_provider_link_required',
        'chat_privacy_copy_required',
        'operator_chat_script_approval_required'
      ]
    },
    {
      key: 'subcontractor_dispatch_handoff_script',
      channel: 'human_subcontractor',
      provider: 'vendor_pool_required',
      status: 'blocked_pending_vendor_pool',
      liveUseAllowed: false,
      audience: 'human subcontractor',
      sections: [
        'Summarize verified scope, customer-approved contact path, service address, and urgency boundary.',
        'Require license, insurance, availability, cost cap, ETA, and acceptance proof before assignment.',
        'Do not expose customer details or promise dispatch until vendor and operator approvals pass.'
      ],
      requiredProofKeys: [
        'vendor_pool_required',
        'license_and_insurance_check_required',
        'subcontractor_handoff_sop_required',
        'operator_dispatch_script_approval_required'
      ]
    }
  ];
  const requiredSetupKeys = [
    'script_owner_required',
    'operator_script_approval_required',
    'script_versioning_required',
    'script_rollback_copy_required',
    ...scriptDrafts.flatMap((item) => item.requiredProofKeys || [])
  ];
  return {
    status: 'drafts_required',
    liveScriptsAllowed: false,
    externalMessageAllowed: false,
    vendorDispatchAllowed: false,
    scriptCount: scriptDrafts.length,
    channelsCovered: scriptDrafts.map((item) => item.channel),
    areaLabel,
    serviceLabel,
    urgencyClass: urgency.urgencyClass || null,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 28),
    prerequisitePlanSources: [
      bookingFlowPlan?.source,
      serviceMenuPlan?.source,
      communicationProvisioningPlan?.source,
      localDomainStrategyPlan?.source,
      launchReadinessWorkItemPlan?.source
    ].filter(Boolean),
    scripts: scriptDrafts,
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(bookingFlowPlan?.evidenceLeadIds || []),
      ...(serviceMenuPlan?.evidenceLeadIds || []),
      ...(communicationProvisioningPlan?.evidenceLeadIds || []),
      ...(localDomainStrategyPlan?.evidenceLeadIds || []),
      ...(launchReadinessWorkItemPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(bookingFlowPlan?.sourceUrls || []),
      ...(serviceMenuPlan?.sourceUrls || []),
      ...(communicationProvisioningPlan?.sourceUrls || []),
      ...(localDomainStrategyPlan?.sourceUrls || []),
      ...(launchReadinessWorkItemPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'script drafts are internal only; do not send messages, place calls, start chats, expose customer data, assign vendors, or promise response times before provider proof and operator approval',
    assumptions: [
      'script drafts are generated from booking flow, service menu, communication provisioning, domain strategy, and launch work-item plans',
      'phone, email, SMS, chat, and subcontractor scripts require operator approval and provider proof before live use',
      'this plan stores draft copy only and does not call providers, send messages, publish widgets, dispatch vendors, or expose customer data'
    ],
    source: 'market_provenance_service_script_plan'
  };
}

function buildServiceCompliancePolicyPlan({
  opportunity,
  city = '',
  verticalName = '',
  compliance = {},
  trustRequirements = [],
  trustAssetPlan = null,
  communicationProvisioningPlan = null,
  serviceScriptPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const urgency = signals.serviceUrgency || {};
  const restrictedClaims = Array.isArray(compliance.restrictedClaims) ? compliance.restrictedClaims : [];
  const requiredDisclosures = Array.isArray(compliance.requiredDisclosures) ? compliance.requiredDisclosures : [];
  const jurisdictionCandidates = [...new Set([
    city || null,
    /tempe/i.test(city) || (provenance.sourceUrls || []).some((url) => /az|tempe/i.test(String(url)))
      ? 'Arizona'
      : null
  ].filter(Boolean))];
  const restrictedAdviceRules = (restrictedClaims.length ? restrictedClaims : [
    'license, insurance, emergency availability, price, rebate, financing, warranty, and scope claims require proof before publication'
  ]).map((claim) => {
    const key = cleanKey(claim);
    return {
      key,
      claim,
      status: 'operator_review_required',
      publicClaimAllowed: false,
      requiredProofKeys: [
        `${key}_evidence_required`,
        'operator_claim_approval_required'
      ]
    };
  });
  const regionPolicyDrafts = [
    {
      key: 'jurisdiction_identification',
      status: 'operator_verification_required',
      jurisdictionCandidates,
      requiredProofKeys: ['jurisdiction_verification_required', 'region_policy_review_required']
    },
    {
      key: 'license_and_permit_claims',
      status: 'operator_review_required',
      jurisdictionCandidates,
      requiredProofKeys: ['license_claim_evidence_required', 'permit_claim_evidence_required']
    },
    {
      key: 'communications_disclosures',
      status: 'operator_review_required',
      jurisdictionCandidates,
      requiredProofKeys: ['recording_disclosure_review_required', 'opt_out_privacy_review_required']
    }
  ];
  const requiredSetupKeys = [
    'region_policy_review_required',
    'jurisdiction_verification_required',
    'restricted_advice_boundary_required',
    'operator_compliance_approval_required',
    ...(restrictedClaims.some((claim) => /license/i.test(claim)) || compliance.licenseVerification ? ['license_claim_evidence_required'] : []),
    ...(restrictedClaims.some((claim) => /24\/7|emergency/i.test(claim)) || urgency.urgencyClass === 'emergency_first' ? ['emergency_availability_evidence_required'] : []),
    ...(requiredDisclosures.some((item) => /recording|call/i.test(item)) ? ['recording_disclosure_review_required'] : []),
    ...restrictedAdviceRules.flatMap((rule) => rule.requiredProofKeys || []).slice(0, 12)
  ];
  return {
    status: 'operator_review_required',
    liveClaimsAllowed: false,
    publicAdviceAllowed: false,
    regionPolicyStatus: 'operator_verification_required',
    region: {
      city: city || null,
      jurisdictionCandidates,
      verificationStatus: 'operator_verification_required'
    },
    verticalLabel: verticalName || cleanText(opportunity?.vertical_key),
    restrictedClaimCount: restrictedAdviceRules.length,
    disclosureCount: requiredDisclosures.length,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 28),
    restrictedAdviceRules,
    regionPolicyDrafts,
    requiredDisclosures: requiredDisclosures.map((item) => ({
      key: cleanKey(item),
      label: item,
      status: 'operator_review_required',
      publicDisclosureAllowed: false
    })),
    licenseVerificationInstruction: cleanText(compliance.licenseVerification) || null,
    prerequisitePlanSources: [
      trustAssetPlan?.source,
      communicationProvisioningPlan?.source,
      serviceScriptPlan?.source
    ].filter(Boolean),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(trustAssetPlan?.evidenceLeadIds || []),
      ...(communicationProvisioningPlan?.evidenceLeadIds || []),
      ...(serviceScriptPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(trustAssetPlan?.sourceUrls || []),
      ...(communicationProvisioningPlan?.sourceUrls || []),
      ...(serviceScriptPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'policy plan is internal review guidance only; do not publish legal, license, emergency, rebate, financing, warranty, or service-scope claims before proof and operator approval',
    assumptions: [
      'region policy candidates are inferred from stored city and source evidence, then held for operator verification',
      'vertical restricted advice comes from the vertical pack compliance rules and trust requirements',
      'this plan does not provide legal advice, publish claims, contact regulators, or approve customer-facing copy'
    ],
    source: 'market_provenance_region_restricted_advice_policy_plan'
  };
}

function buildProviderSandboxOrchestrationPlan({
  opportunity,
  city = '',
  verticalName = '',
  communicationProvisioningPlan = null,
  localDomainStrategyPlan = null,
  launchReadinessWorkItemPlan = null,
  serviceScriptPlan = null,
  serviceCompliancePolicyPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const providerMocks = [
    {
      provider: 'agentphone',
      capability: 'phone_booking_intake',
      status: 'mock_ready',
      liveStatus: 'blocked_missing_provider_link',
      blocker: 'agentphone_provider_link_required',
      fallbackWorkflow: 'phone_script_rehearsal_receipt'
    },
    {
      provider: 'agentmail',
      capability: 'email_quote_recap',
      status: 'mock_ready',
      liveStatus: 'blocked_missing_provider_link',
      blocker: 'agentmail_provider_link_required',
      fallbackWorkflow: 'email_template_render_receipt'
    },
    {
      provider: 'sms_provider',
      capability: 'sms_status_update',
      status: 'mock_ready',
      liveStatus: 'blocked_missing_provider_link',
      blocker: 'sms_provider_link_required',
      fallbackWorkflow: 'sms_copy_validation_receipt'
    },
    {
      provider: 'chat_widget_provider',
      capability: 'web_chat_intake',
      status: 'mock_ready',
      liveStatus: 'blocked_missing_widget',
      blocker: 'chat_widget_provider_link_required',
      fallbackWorkflow: 'chat_handoff_simulation_receipt'
    },
    {
      provider: 'dns_provider',
      capability: 'domain_dns_publication',
      status: 'mock_ready',
      liveStatus: 'blocked_missing_dns_provider',
      blocker: 'dns_provider_link_required',
      fallbackWorkflow: 'dns_record_plan_validation_receipt'
    },
    {
      provider: 'vendor_pool',
      capability: 'human_subcontractor_dispatch',
      status: 'mock_ready',
      liveStatus: 'blocked_missing_vendor_pool',
      blocker: 'vendor_pool_required',
      fallbackWorkflow: 'subcontractor_packet_simulation_receipt'
    }
  ];
  const mockWorkflows = providerMocks.map((item) => ({
    key: item.fallbackWorkflow,
    provider: item.provider,
    capability: item.capability,
    status: 'dry_run_available',
    externalSideEffects: false,
    recordsBlocker: item.blocker
  }));
  const requiredSetupKeys = [
    'provider_sandbox_orchestration_required',
    'provider_unavailable_blocker_record_required',
    'mock_receipt_capture_required',
    'provider_live_smoke_required',
    ...providerMocks.map((item) => item.blocker)
  ];
  return {
    status: 'mock_orchestration_ready',
    liveProviderExecutionAllowed: false,
    providerMutationAllowed: false,
    externalSideEffectsAllowed: false,
    providerCount: providerMocks.length,
    blockerCount: providerMocks.length,
    areaLabel: communicationProvisioningPlan?.areaLabel || localDomainStrategyPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 24),
    providerMocks,
    mockWorkflows,
    prerequisitePlanSources: [
      communicationProvisioningPlan?.source,
      localDomainStrategyPlan?.source,
      launchReadinessWorkItemPlan?.source,
      serviceScriptPlan?.source,
      serviceCompliancePolicyPlan?.source
    ].filter(Boolean),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(communicationProvisioningPlan?.evidenceLeadIds || []),
      ...(localDomainStrategyPlan?.evidenceLeadIds || []),
      ...(launchReadinessWorkItemPlan?.evidenceLeadIds || []),
      ...(serviceScriptPlan?.evidenceLeadIds || []),
      ...(serviceCompliancePolicyPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(communicationProvisioningPlan?.sourceUrls || []),
      ...(localDomainStrategyPlan?.sourceUrls || []),
      ...(launchReadinessWorkItemPlan?.sourceUrls || []),
      ...(serviceScriptPlan?.sourceUrls || []),
      ...(serviceCompliancePolicyPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'provider sandbox orchestration is local only; do not call providers, mutate DNS, send messages, publish widgets, assign vendors, spend money, or represent mock receipts as live proof',
    assumptions: [
      'each unavailable provider gets a local dry-run workflow that records the live blocker instead of faking success',
      'mock workflows may validate copy, routing, and proof packets but cannot replace live provider smoke evidence',
      'this plan does not invoke provider APIs, mutate external systems, or create customer-facing side effects'
    ],
    source: 'market_provenance_provider_sandbox_orchestration_plan'
  };
}

function buildCustomerOperatingRoomPlan({
  opportunity,
  city = '',
  verticalName = '',
  bookingFlowPlan = null,
  serviceMenuPlan = null,
  serviceScriptPlan = null,
  serviceCompliancePolicyPlan = null,
  providerSandboxOrchestrationPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const areaLabel = bookingFlowPlan?.areaLabel || providerSandboxOrchestrationPlan?.areaLabel || city || null;
  const workflowItems = [
    {
      key: 'booking_management',
      status: 'blocked_pending_booking_flow',
      customerVisible: false,
      requiredProofKeys: ['booking_flow_copy_required', 'calendar_provider_live_smoke_required', 'operator_booking_approval_required']
    },
    {
      key: 'job_tracking',
      status: 'blocked_pending_dispatch_receipt',
      customerVisible: false,
      requiredProofKeys: ['dispatch_receipt_required', 'job_status_model_required', 'customer_visibility_review_required']
    },
    {
      key: 'vendor_eta',
      status: 'blocked_pending_vendor_acceptance',
      customerVisible: false,
      requiredProofKeys: ['vendor_acceptance_required', 'vendor_eta_evidence_required', 'sla_boundary_required']
    },
    {
      key: 'photos_and_completion_proof',
      status: 'blocked_pending_photo_permission',
      customerVisible: false,
      requiredProofKeys: ['photo_permission_required', 'completion_proof_required', 'privacy_review_required']
    },
    {
      key: 'review_request',
      status: 'blocked_pending_completed_service',
      customerVisible: false,
      requiredProofKeys: ['completed_service_required', 'no_incentive_review_policy_required', 'customer_opt_in_required']
    }
  ];
  const requiredSetupKeys = [
    'customer_portal_draft_required',
    'customer_visibility_policy_required',
    'customer_portal_live_smoke_required',
    'operator_customer_room_approval_required',
    ...workflowItems.flatMap((item) => item.requiredProofKeys || [])
  ];
  return {
    status: 'draft_required',
    publicPortalAllowed: false,
    customerVisibilityAllowed: false,
    bookingManagementAllowed: false,
    jobTrackingAllowed: false,
    vendorEtaAllowed: false,
    proofUploadAllowed: false,
    reviewRequestAllowed: false,
    workflowCount: workflowItems.length,
    blockedCount: workflowItems.length,
    areaLabel,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 28),
    workflows: workflowItems,
    prerequisitePlanSources: [
      bookingFlowPlan?.source,
      serviceMenuPlan?.source,
      serviceScriptPlan?.source,
      serviceCompliancePolicyPlan?.source,
      providerSandboxOrchestrationPlan?.source
    ].filter(Boolean),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(bookingFlowPlan?.evidenceLeadIds || []),
      ...(serviceMenuPlan?.evidenceLeadIds || []),
      ...(serviceScriptPlan?.evidenceLeadIds || []),
      ...(serviceCompliancePolicyPlan?.evidenceLeadIds || []),
      ...(providerSandboxOrchestrationPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(bookingFlowPlan?.sourceUrls || []),
      ...(serviceMenuPlan?.sourceUrls || []),
      ...(serviceScriptPlan?.sourceUrls || []),
      ...(serviceCompliancePolicyPlan?.sourceUrls || []),
      ...(providerSandboxOrchestrationPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'customer operating room is a draft plan only; do not expose booking, job status, ETA, photos, proof, review requests, or support timeline to customers before approval and live smoke',
    assumptions: [
      'customer operating-room workflows are generated from booking flow, service menu, scripts, policy, and provider sandbox plans',
      'customer visibility stays blocked until dispatch, proof, privacy, vendor, review-policy, and portal live-smoke evidence exist',
      'this plan does not publish a portal, create bookings, mutate job status, expose photos, send review requests, or promise vendor ETAs'
    ],
    source: 'market_provenance_customer_operating_room_plan'
  };
}

function buildOperatorSupervisionPlan({
  opportunity,
  city = '',
  verticalName = '',
  launchReadinessWorkItemPlan = null,
  serviceScriptPlan = null,
  serviceCompliancePolicyPlan = null,
  providerSandboxOrchestrationPlan = null,
  customerOperatingRoomPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const inboxLanes = [
    {
      key: 'launch_readiness',
      status: 'review_required',
      source: launchReadinessWorkItemPlan?.source || 'launch_work_items_required',
      blockerCount: launchReadinessWorkItemPlan?.blockedCount || 0
    },
    {
      key: 'customer_communications',
      status: 'review_required',
      source: serviceScriptPlan?.source || 'service_scripts_required',
      blockerCount: serviceScriptPlan?.scriptCount || 0
    },
    {
      key: 'compliance_policy',
      status: 'review_required',
      source: serviceCompliancePolicyPlan?.source || 'compliance_policy_required',
      blockerCount: serviceCompliancePolicyPlan?.restrictedClaimCount || 0
    },
    {
      key: 'provider_sandbox',
      status: 'review_required',
      source: providerSandboxOrchestrationPlan?.source || 'provider_sandbox_required',
      blockerCount: providerSandboxOrchestrationPlan?.blockerCount || 0
    },
    {
      key: 'customer_room',
      status: 'review_required',
      source: customerOperatingRoomPlan?.source || 'customer_room_required',
      blockerCount: customerOperatingRoomPlan?.blockedCount || 0
    }
  ];
  const escalationPlaybooks = [
    {
      key: 'emergency_claim_boundary',
      status: 'draft_required',
      trigger: 'urgent request or emergency wording appears before approved emergency-response proof'
    },
    {
      key: 'provider_unavailable',
      status: 'draft_required',
      trigger: 'live provider link, live smoke, or adapter proof is missing'
    },
    {
      key: 'vendor_eta_or_dispatch_risk',
      status: 'draft_required',
      trigger: 'vendor acceptance, ETA evidence, or SLA boundary is missing'
    },
    {
      key: 'customer_visibility_privacy_risk',
      status: 'draft_required',
      trigger: 'customer portal, photo proof, transcript, or review request could expose customer data'
    }
  ];
  const trainingLabels = [
    'provider_link_missing',
    'restricted_claim_review',
    'customer_visibility_blocked',
    'vendor_acceptance_missing',
    'operator_launch_gate'
  ];
  const teamAssignments = [
    { role: 'launch_operator', status: 'unassigned', owns: ['operator_launch_gate', 'bulk_review'] },
    { role: 'compliance_reviewer', status: 'unassigned', owns: ['restricted_claim_review', 'region_policy_review'] },
    { role: 'provider_ops', status: 'unassigned', owns: ['provider_sandbox', 'live_smoke'] },
    { role: 'customer_success', status: 'unassigned', owns: ['customer_room', 'review_request'] },
    { role: 'vendor_coordinator', status: 'unassigned', owns: ['vendor_eta', 'dispatch_handoff'] }
  ];
  const bulkReviewBatches = [
    {
      key: 'launch_blocker_batch',
      status: 'ready_for_operator_review',
      itemCount: inboxLanes.reduce((sum, item) => sum + (item.blockerCount || 0), 0)
    },
    {
      key: 'copy_policy_batch',
      status: 'ready_for_operator_review',
      itemCount: (serviceScriptPlan?.scriptCount || 0) + (serviceCompliancePolicyPlan?.restrictedClaimCount || 0)
    }
  ];
  const performanceMetrics = [
    'blockers_reviewed_per_hour',
    'first_response_minutes',
    'provider_blocker_resolution_rate',
    'customer_visibility_defect_rate',
    'escalation_reopen_rate'
  ];
  const requiredSetupKeys = [
    'universal_operator_inbox_required',
    'operator_escalation_playbooks_required',
    'operator_training_labels_required',
    'operator_team_assignment_required',
    'operator_performance_metrics_required',
    'operator_bulk_review_required'
  ];
  return {
    status: 'draft_required',
    operatorInboxLive: false,
    bulkReviewAllowed: false,
    teamAssignmentAllowed: false,
    liveCallAssistAllowed: false,
    inboxLaneCount: inboxLanes.length,
    escalationPlaybookCount: escalationPlaybooks.length,
    trainingLabelCount: trainingLabels.length,
    teamAssignmentCount: teamAssignments.length,
    requiredSetupKeys,
    inboxLanes,
    escalationPlaybooks,
    trainingLabels,
    teamAssignments,
    bulkReviewBatches,
    performanceMetrics,
    areaLabel: customerOperatingRoomPlan?.areaLabel || providerSandboxOrchestrationPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    prerequisitePlanSources: [
      launchReadinessWorkItemPlan?.source,
      serviceScriptPlan?.source,
      serviceCompliancePolicyPlan?.source,
      providerSandboxOrchestrationPlan?.source,
      customerOperatingRoomPlan?.source
    ].filter(Boolean),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(launchReadinessWorkItemPlan?.evidenceLeadIds || []),
      ...(serviceScriptPlan?.evidenceLeadIds || []),
      ...(serviceCompliancePolicyPlan?.evidenceLeadIds || []),
      ...(providerSandboxOrchestrationPlan?.evidenceLeadIds || []),
      ...(customerOperatingRoomPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(launchReadinessWorkItemPlan?.sourceUrls || []),
      ...(serviceScriptPlan?.sourceUrls || []),
      ...(serviceCompliancePolicyPlan?.sourceUrls || []),
      ...(providerSandboxOrchestrationPlan?.sourceUrls || []),
      ...(customerOperatingRoomPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'operator supervision plan is internal only; do not assign staff, bulk-approve cases, assist live calls, message customers, or clear blockers without explicit operator action',
    assumptions: [
      'operator supervision is generated from launch work items, scripts, policy, provider sandbox, and customer-room blockers',
      'inbox lanes, escalation playbooks, labels, team assignments, bulk review, and metrics remain draft until operator approval',
      'this plan does not assign humans, approve blockers, perform live call assist, message customers, or mutate provider state'
    ],
    source: 'market_provenance_operator_supervision_plan'
  };
}

function buildProviderQualitySelectionPlan({
  opportunity,
  city = '',
  verticalName = '',
  providerSandboxOrchestrationPlan = null,
  serviceCompliancePolicyPlan = null,
  operatorSupervisionPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const providers = providerSandboxOrchestrationPlan?.providerMocks?.length
    ? providerSandboxOrchestrationPlan.providerMocks
    : [];
  const scorecards = providers.map((item) => ({
    provider: item.provider,
    capability: item.capability,
    status: 'blocked_pending_live_history',
    selectableForLiveRouting: false,
    qualityScore: 0,
    metrics: {
      availability: 'live_history_required',
      latency: 'live_history_required',
      cost: 'operator_budget_required',
      freshness: 'provider_smoke_required',
      failureHistory: 'provider_incident_history_required',
      tenantScope: 'workspace_provider_link_required',
      regionFit: city ? 'operator_region_review_required' : 'region_required',
      serviceFit: verticalName ? 'operator_service_review_required' : 'service_required'
    },
    blockers: [
      item.blocker,
      'provider_quality_history_required',
      'provider_cost_guardrail_required',
      'provider_live_smoke_required'
    ]
  }));
  const selectionRules = [
    { key: 'tenant_scope', status: 'required', input: 'workspace provider link ownership and scopes' },
    { key: 'region_fit', status: 'required', input: 'jurisdiction candidates and region policy review' },
    { key: 'service_capability', status: 'required', input: 'provider capability matches service workflow' },
    { key: 'cost_guardrail', status: 'required', input: 'operator budget, unit economics, and expected provider cost' },
    { key: 'freshness', status: 'required', input: 'recent live smoke or sandbox rehearsal timestamp' },
    { key: 'failure_history', status: 'required', input: 'provider incidents, fallback receipts, and replay history' }
  ];
  const requiredSetupKeys = [
    'provider_quality_metrics_required',
    'provider_selection_rules_required',
    'provider_live_history_required',
    'provider_cost_guardrail_required',
    'provider_failure_history_required',
    'provider_selection_operator_approval_required',
    ...scorecards.flatMap((item) => item.blockers || []).slice(0, 18)
  ];
  return {
    status: 'draft_required',
    liveRoutingAllowed: false,
    providerMigrationAllowed: false,
    automaticProviderSelectionAllowed: false,
    providerCount: scorecards.length,
    selectableProviderCount: 0,
    metricDimensions: ['availability', 'latency', 'cost', 'freshness', 'failureHistory', 'tenantScope', 'regionFit', 'serviceFit'],
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 28),
    scorecards,
    selectionRules,
    fallbackSource: providerSandboxOrchestrationPlan?.source || null,
    regionSource: serviceCompliancePolicyPlan?.source || null,
    operatorSource: operatorSupervisionPlan?.source || null,
    areaLabel: providerSandboxOrchestrationPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    prerequisitePlanSources: [
      providerSandboxOrchestrationPlan?.source,
      serviceCompliancePolicyPlan?.source,
      operatorSupervisionPlan?.source
    ].filter(Boolean),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(providerSandboxOrchestrationPlan?.evidenceLeadIds || []),
      ...(serviceCompliancePolicyPlan?.evidenceLeadIds || []),
      ...(operatorSupervisionPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(providerSandboxOrchestrationPlan?.sourceUrls || []),
      ...(serviceCompliancePolicyPlan?.sourceUrls || []),
      ...(operatorSupervisionPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'provider quality and selection is a local scorecard only; do not route live traffic, migrate providers, mutate credentials, or choose providers automatically before live history and operator approval',
    assumptions: [
      'provider quality scorecards start at zero until live smoke, cost, region, service, tenant, freshness, and failure-history evidence exists',
      'provider selection uses sandbox blockers and operator supervision plans as inputs but does not replace live provider verification',
      'this plan does not migrate credentials, change routing, invoke provider APIs, or select a live provider automatically'
    ],
    source: 'market_provenance_provider_quality_selection_plan'
  };
}

function buildProviderMigrationPlan({
  opportunity,
  city = '',
  verticalName = '',
  providerSandboxOrchestrationPlan = null,
  providerQualitySelectionPlan = null,
  operatorSupervisionPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const scorecards = providerQualitySelectionPlan?.scorecards || [];
  const providerTargets = scorecards.map((item) => ({
    provider: item.provider,
    capability: item.capability,
    status: 'blocked_pending_quality_and_live_smoke',
    canMigrateLive: false,
    blockers: [
      ...(item.blockers || []),
      'credential_backup_required',
      'parallel_smoke_required',
      'operator_migration_approval_required'
    ].filter(Boolean).slice(0, 8)
  }));
  const migrationSteps = [
    {
      key: 'inventory_current_provider_links',
      status: 'draft_required',
      proofRequired: ['workspace_provider_link_inventory_required', 'credential_scope_inventory_required']
    },
    {
      key: 'compare_provider_quality_scorecards',
      status: 'blocked_pending_live_history',
      proofRequired: ['provider_quality_metrics_required', 'provider_failure_history_required']
    },
    {
      key: 'stage_sandbox_fallback',
      status: 'dry_run_required',
      proofRequired: ['provider_sandbox_orchestration_required', 'mock_receipt_capture_required']
    },
    {
      key: 'prepare_credential_cutover',
      status: 'blocked_pending_credential_backup',
      proofRequired: ['credential_backup_required', 'secret_rotation_plan_required']
    },
    {
      key: 'run_parallel_smoke',
      status: 'blocked_pending_live_smoke',
      proofRequired: ['parallel_smoke_required', 'provider_live_smoke_required']
    },
    {
      key: 'operator_migration_gate',
      status: 'operator_review_required',
      proofRequired: ['operator_migration_approval_required', 'customer_impact_review_required']
    },
    {
      key: 'rollback_closeout',
      status: 'rollback_plan_required',
      proofRequired: ['provider_route_rollback_required', 'credential_rollback_required', 'customer_handoff_rollback_required']
    }
  ];
  const requiredSetupKeys = [
    'provider_migration_runbook_required',
    'workspace_provider_link_inventory_required',
    'credential_backup_required',
    'secret_rotation_plan_required',
    'parallel_smoke_required',
    'provider_route_rollback_required',
    'operator_migration_approval_required',
    ...providerTargets.flatMap((item) => item.blockers || []).slice(0, 20)
  ];
  return {
    status: 'draft_required',
    liveMigrationAllowed: false,
    credentialMutationAllowed: false,
    routingChangeAllowed: false,
    automaticCutoverAllowed: false,
    rollbackRequired: true,
    providerCount: providerTargets.length,
    stepCount: migrationSteps.length,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 28),
    providerTargets,
    migrationSteps,
    qualitySource: providerQualitySelectionPlan?.source || null,
    sandboxSource: providerSandboxOrchestrationPlan?.source || null,
    operatorSource: operatorSupervisionPlan?.source || null,
    areaLabel: providerQualitySelectionPlan?.areaLabel || providerSandboxOrchestrationPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    prerequisitePlanSources: [
      providerSandboxOrchestrationPlan?.source,
      providerQualitySelectionPlan?.source,
      operatorSupervisionPlan?.source
    ].filter(Boolean),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(providerSandboxOrchestrationPlan?.evidenceLeadIds || []),
      ...(providerQualitySelectionPlan?.evidenceLeadIds || []),
      ...(operatorSupervisionPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(providerSandboxOrchestrationPlan?.sourceUrls || []),
      ...(providerQualitySelectionPlan?.sourceUrls || []),
      ...(operatorSupervisionPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'provider migration plan is local only; do not rotate secrets, mutate credentials, change routing, cut over providers, or message customers before parallel smoke and operator approval',
    assumptions: [
      'provider migrations require quality scorecards, sandbox fallback proof, credential backup, parallel smoke, operator approval, and rollback closeout',
      'mock and draft migration steps cannot substitute for live provider smoke or customer-impact review',
      'this plan does not mutate credentials, change provider routing, invoke provider APIs, or perform automatic cutover'
    ],
    source: 'market_provenance_provider_migration_plan'
  };
}

function buildProductTelemetryPlan({
  opportunity,
  city = '',
  verticalName = '',
  operatorSupervisionPlan = null,
  providerQualitySelectionPlan = null,
  providerMigrationPlan = null,
  customerOperatingRoomPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const telemetryStreams = [
    {
      key: 'product_telemetry',
      status: 'draft_required',
      captures: ['plan_created', 'blocker_added', 'operator_review_needed']
    },
    {
      key: 'feature_bottleneck_detection',
      status: 'draft_required',
      captures: ['blocked_work_item_count', 'provider_blocker_count', 'customer_visibility_blocker_count']
    },
    {
      key: 'operator_frustration_capture',
      status: 'draft_required',
      captures: ['reopened_escalation', 'bulk_review_rejection', 'manual_override_reason']
    },
    {
      key: 'customer_confusion_capture',
      status: 'draft_required',
      captures: ['unclear_price_boundary', 'unclear_booking_state', 'unclear_eta_state']
    },
    {
      key: 'broken_workflow_detection',
      status: 'draft_required',
      captures: ['missing_prerequisite_plan', 'stale_blocker', 'failed_dry_run_receipt']
    },
    {
      key: 'missing_integration_detection',
      status: 'draft_required',
      captures: ['provider_link_required', 'live_smoke_required', 'adapter_not_implemented']
    }
  ];
  const generatedArtifacts = [
    {
      key: 'bug_report',
      status: 'draft_only',
      sourceStreams: ['broken_workflow_detection', 'operator_frustration_capture']
    },
    {
      key: 'eval_case',
      status: 'draft_only',
      sourceStreams: ['customer_confusion_capture', 'missing_integration_detection']
    },
    {
      key: 'product_spec',
      status: 'draft_only',
      sourceStreams: ['feature_bottleneck_detection', 'product_telemetry']
    },
    {
      key: 'migration_plan',
      status: 'draft_only',
      sourceStreams: ['missing_integration_detection'],
      sourcePlan: providerMigrationPlan?.source || null
    },
    {
      key: 'regression_proofing_check',
      status: 'draft_only',
      sourceStreams: ['broken_workflow_detection', 'feature_bottleneck_detection']
    }
  ];
  const patternDetectors = [
    {
      key: 'repeated_provider_blocker',
      status: 'draft_required',
      createsWork: 'provider_quality_or_migration_work_item'
    },
    {
      key: 'repeated_customer_visibility_blocker',
      status: 'draft_required',
      createsWork: 'customer_room_or_privacy_work_item'
    },
    {
      key: 'repeated_operator_escalation',
      status: 'draft_required',
      createsWork: 'operator_supervision_training_item'
    },
    {
      key: 'repeated_integration_gap',
      status: 'draft_required',
      createsWork: 'integration_adapter_spec'
    }
  ];
  const requiredSetupKeys = [
    'product_telemetry_schema_required',
    'operator_feedback_capture_required',
    'customer_confusion_taxonomy_required',
    'broken_workflow_detector_required',
    'missing_integration_detector_required',
    'generated_artifact_review_required',
    'safe_pr_proposal_gate_required',
    'regression_proofing_gate_required',
    'pattern_to_work_conversion_required'
  ];
  return {
    status: 'draft_required',
    liveTelemetryAllowed: false,
    customerTelemetryAllowed: false,
    automaticBugReportAllowed: false,
    automaticPrProposalAllowed: false,
    artifactPublicationAllowed: false,
    streamCount: telemetryStreams.length,
    artifactCount: generatedArtifacts.length,
    patternDetectorCount: patternDetectors.length,
    requiredSetupKeys,
    telemetryStreams,
    generatedArtifacts,
    patternDetectors,
    prerequisitePlanSources: [
      operatorSupervisionPlan?.source,
      providerQualitySelectionPlan?.source,
      providerMigrationPlan?.source,
      customerOperatingRoomPlan?.source
    ].filter(Boolean),
    areaLabel: customerOperatingRoomPlan?.areaLabel || providerMigrationPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(operatorSupervisionPlan?.evidenceLeadIds || []),
      ...(providerQualitySelectionPlan?.evidenceLeadIds || []),
      ...(providerMigrationPlan?.evidenceLeadIds || []),
      ...(customerOperatingRoomPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(operatorSupervisionPlan?.sourceUrls || []),
      ...(providerQualitySelectionPlan?.sourceUrls || []),
      ...(providerMigrationPlan?.sourceUrls || []),
      ...(customerOperatingRoomPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'product telemetry plan is internal only; do not capture customer telemetry, publish artifacts, open PRs, or auto-create work without review and privacy approval',
    assumptions: [
      'telemetry streams are derived from launch blockers, operator supervision, provider quality, provider migration, and customer-room plans',
      'generated bug reports, evals, product specs, migration plans, and regression checks stay draft until reviewed',
      'this plan does not capture live customer telemetry, publish artifacts, open PRs, or mutate workflow state automatically'
    ],
    source: 'market_provenance_product_telemetry_work_generation_plan'
  };
}

function buildAcquisitionExpansionPlan({
  opportunity,
  city = '',
  verticalName = '',
  serviceMenuPlan = null,
  operatorSupervisionPlan = null,
  providerQualitySelectionPlan = null,
  productTelemetryPlan = null,
  customerOperatingRoomPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const pricing = signals.pricingMarginInference || {};
  const sizing = signals.marketSizing || {};
  const pressure = signals.demandPressure || {};
  const ownerResponse = signals.ownerResponsiveness || {};
  const toScore = (value, fallback = 0) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(100, numeric <= 1 ? Math.round(numeric * 100) : Math.round(numeric)));
  };
  const representativePriceCents = serviceMenuPlan?.representativePriceCents
    ?? pricing.representativePriceCents
    ?? opportunity?.unit_economics?.representativePriceCents
    ?? null;
  const contributionMarginCents = sizing.contributionMarginCents
    ?? opportunity?.unit_economics?.contributionMarginCents
    ?? null;
  const explainabilityScore = toScore(provenance.explainabilityScore, 35);
  const demandScore = toScore(pressure.score ?? pressure.demandPressureScore, 45);
  const marginScore = representativePriceCents && contributionMarginCents
    ? toScore(contributionMarginCents / representativePriceCents, 35)
    : toScore(opportunity?.unit_economics?.grossMarginPct, 35);
  const responsivenessScore = Math.max(0, 100 - toScore(ownerResponse.responseFrictionScore, 55));
  const targetScore = Math.max(0, Math.min(100, Math.round(
    (explainabilityScore * 0.35)
    + (demandScore * 0.2)
    + (marginScore * 0.25)
    + (responsivenessScore * 0.2)
  )));
  const targetScoreBand = targetScore >= 75 ? 'high_review_priority'
    : targetScore >= 55 ? 'operator_review_candidate'
      : 'watchlist_only';
  const estimatedMonthlyLiftCents = Math.max(
    representativePriceCents || 0,
    sizing.obtainableFirstWaveMarginCents || sizing.estimatedCallableRevenueCents || 0
  );
  const diagnostics = [
    {
      key: 'business_performance_diagnosis',
      status: 'draft_required',
      inputs: ['market_recommendation_provenance', 'pricing_margin_inference', 'owner_responsiveness', 'customer_complaints'],
      requiredProofKeys: ['current_revenue_baseline_required', 'owner_interview_required', 'service_delivery_baseline_required']
    },
    {
      key: 'revenue_uplift_estimate',
      status: 'draft_required',
      estimatedMonthlyLiftCents,
      inputs: ['representative_price', 'obtainable_first_wave', 'margin_model'],
      requiredProofKeys: ['actual_revenue_statement_required', 'conversion_baseline_required', 'pricing_assumption_review_required']
    },
    {
      key: 'operational_gap_report',
      status: 'draft_required',
      gapKeys: ['missed_callback_gap', 'booking_clarity_gap', 'proof_asset_gap', 'provider_reliability_gap'],
      requiredProofKeys: ['owner_process_map_required', 'customer_issue_sample_required', 'fulfillment_sla_baseline_required']
    },
    {
      key: 'acquisition_target_scoring',
      status: 'operator_review_required',
      targetScore,
      targetScoreBand,
      requiredProofKeys: ['score_review_required', 'valuation_assumption_review_required', 'operator_acquisition_gate_required']
    }
  ];
  const workflows = [
    {
      key: 'owner_outreach',
      status: 'blocked_pending_consent',
      liveAllowed: false,
      requiredProofKeys: ['owner_identity_verification_required', 'owner_outreach_consent_required', 'operator_approval_required']
    },
    {
      key: 'loi_workflow',
      status: 'blocked_pending_legal_review',
      liveAllowed: false,
      requiredProofKeys: ['loi_legal_review_required', 'valuation_assumption_review_required', 'operator_signature_gate_required']
    },
    {
      key: 'due_diligence_checklist',
      status: 'draft_required',
      liveAllowed: false,
      requiredProofKeys: ['financial_statement_request_required', 'vendor_contract_review_required', 'liability_review_required']
    },
    {
      key: 'data_room_intake',
      status: 'blocked_pending_privacy_review',
      liveAllowed: false,
      requiredProofKeys: ['data_room_privacy_review_required', 'access_policy_required', 'redaction_policy_required']
    },
    {
      key: 'integration_plan',
      status: 'draft_required',
      liveAllowed: false,
      requiredProofKeys: ['systems_inventory_required', 'customer_migration_review_required', 'vendor_migration_review_required']
    },
    {
      key: 'transition_playbook',
      status: 'draft_required',
      liveAllowed: false,
      requiredProofKeys: ['owner_transition_sop_required', 'customer_communication_review_required', 'handoff_timeline_required']
    },
    {
      key: 'brand_preservation_plan',
      status: 'draft_required',
      liveAllowed: false,
      requiredProofKeys: ['brand_history_review_required', 'review_profile_ownership_required', 'public_claim_review_required']
    },
    {
      key: 'post_acquisition_automation_rollout',
      status: 'blocked_pending_integration_review',
      liveAllowed: false,
      requiredProofKeys: ['automation_scope_review_required', 'customer_disruption_review_required', 'rollback_plan_required']
    }
  ];
  const requiredSetupKeys = [
    'acquisition_operator_approval_required',
    'owner_identity_verification_required',
    'owner_outreach_consent_required',
    'loi_legal_review_required',
    'due_diligence_checklist_required',
    'data_room_privacy_review_required',
    'integration_plan_review_required',
    'transition_playbook_review_required',
    'brand_preservation_review_required',
    'post_acquisition_rollout_review_required',
    'valuation_assumption_review_required',
    'customer_migration_review_required',
    'vendor_migration_review_required',
    ...diagnostics.flatMap((item) => item.requiredProofKeys || []),
    ...workflows.flatMap((item) => item.requiredProofKeys || [])
  ];
  return {
    status: 'draft_required',
    liveOwnerOutreachAllowed: false,
    loiAllowed: false,
    dataRoomAccessAllowed: false,
    acquisitionDecisionAllowed: false,
    customerMigrationAllowed: false,
    vendorMigrationAllowed: false,
    postAcquisitionAutomationAllowed: false,
    diagnosisCount: diagnostics.length,
    workflowCount: workflows.length,
    targetScore,
    targetScoreBand,
    estimatedMonthlyLiftCents,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 36),
    diagnostics,
    workflows,
    prerequisitePlanSources: [
      serviceMenuPlan?.source,
      operatorSupervisionPlan?.source,
      providerQualitySelectionPlan?.source,
      productTelemetryPlan?.source,
      customerOperatingRoomPlan?.source
    ].filter(Boolean),
    areaLabel: serviceMenuPlan?.areaLabel || customerOperatingRoomPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(serviceMenuPlan?.evidenceLeadIds || []),
      ...(operatorSupervisionPlan?.evidenceLeadIds || []),
      ...(providerQualitySelectionPlan?.evidenceLeadIds || []),
      ...(productTelemetryPlan?.evidenceLeadIds || []),
      ...(customerOperatingRoomPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(serviceMenuPlan?.sourceUrls || []),
      ...(operatorSupervisionPlan?.sourceUrls || []),
      ...(providerQualitySelectionPlan?.sourceUrls || []),
      ...(productTelemetryPlan?.sourceUrls || []),
      ...(customerOperatingRoomPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'acquisition expansion is an internal M&A plan only; do not contact owners, send LOIs, open data rooms, buy businesses, migrate customers/vendors, or roll out automation without legal, privacy, and operator approval',
    assumptions: [
      'business diagnosis, uplift estimates, gap reports, and target scoring are draft models until actual owner financials and process evidence are reviewed',
      'owner outreach, LOIs, data-room access, integration, transition, brand preservation, and post-acquisition automation remain blocked behind consent, legal, privacy, and operator gates',
      'this plan does not contact owners, make offers, sign LOIs, access confidential data, decide acquisitions, migrate customers or vendors, or automate an acquired business'
    ],
    source: 'market_provenance_acquisition_expansion_plan'
  };
}

function buildOperatingHealthPlan({
  opportunity,
  city = '',
  verticalName = '',
  customerOperatingRoomPlan = null,
  providerQualitySelectionPlan = null,
  productTelemetryPlan = null,
  acquisitionExpansionPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const sizing = signals.marketSizing || {};
  const pressure = signals.demandPressure || {};
  const clampScore = (value, fallback = 0) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(100, numeric <= 1 ? Math.round(numeric * 100) : Math.round(numeric)));
  };
  const verticalHealthScore = Math.round((
    clampScore(provenance.explainabilityScore, 45)
    + clampScore(pressure.score ?? pressure.demandPressureScore, 45)
    + clampScore(sizing.confidence, 45)
  ) / 3);
  const providerFabricScore = providerQualitySelectionPlan?.selectableProviderCount
    ? 80
    : 0;
  const healthChecks = [
    {
      key: 'customer_sla_health',
      status: 'blocked_pending_completion_proof',
      score: 0,
      measures: ['first_response_minutes', 'booking_confirmation_minutes', 'status_update_freshness', 'completion_proof_age'],
      requiredProofKeys: ['customer_sla_receipts_required', 'customer_status_update_receipts_required', 'completion_proof_receipts_required']
    },
    {
      key: 'vendor_sla_health',
      status: 'blocked_pending_vendor_history',
      score: 0,
      measures: ['vendor_acceptance_minutes', 'arrival_window_variance', 'completion_quality_score', 'backup_route_freshness'],
      requiredProofKeys: ['vendor_sla_receipts_required', 'vendor_acceptance_history_required', 'backup_vendor_route_required']
    },
    {
      key: 'vertical_health',
      status: 'draft_required',
      score: verticalHealthScore,
      measures: ['market_demand_pressure', 'pricing_margin_confidence', 'complaint_cluster_pressure', 'launch_readiness_blockers'],
      requiredProofKeys: ['vertical_health_rollup_required', 'margin_health_evidence_required', 'market_learning_evidence_required']
    },
    {
      key: 'provider_fabric',
      status: 'blocked_pending_live_provider_history',
      score: providerFabricScore,
      measures: ['provider_availability', 'latency', 'failure_history', 'tenant_scope', 'region_fit', 'fallback_route'],
      requiredProofKeys: ['provider_fabric_rollup_required', 'provider_live_history_required', 'provider_fallback_receipts_required']
    }
  ];
  const readinessEvidence = [
    {
      key: 'deterministic_check_receipt',
      status: 'required',
      proves: ['health_plan_shape', 'snapshot_export_coverage']
    },
    {
      key: 'durable_state_receipt',
      status: 'required',
      proves: ['readiness_json_persisted', 'channel_plan_persisted', 'capability_plan_persisted']
    },
    {
      key: 'operator_visible_evidence',
      status: 'required',
      proves: ['portfolio_health_chips_rendered', 'blocked_claims_visible']
    },
    {
      key: 'customer_visible_evidence_gate',
      status: 'blocked_pending_customer_room_review',
      proves: ['customer_sla_claims_hidden_until_approved']
    }
  ];
  const requiredSetupKeys = [
    'readiness_evidence_surface_required',
    'operator_health_review_required',
    'customer_sla_health_receipts_required',
    'vendor_sla_health_receipts_required',
    'vertical_health_rollup_required',
    'provider_fabric_rollup_required',
    'provider_live_history_required',
    'customer_visible_sla_claim_review_required',
    ...healthChecks.flatMap((item) => item.requiredProofKeys || [])
  ];
  return {
    status: 'draft_required',
    readinessClaimsAllowed: false,
    accelerationAllowed: false,
    customerSlaClaimsAllowed: false,
    vendorSlaClaimsAllowed: false,
    providerRoutingAccelerationAllowed: false,
    verticalScalingAllowed: false,
    healthCheckCount: healthChecks.length,
    readinessEvidenceCount: readinessEvidence.length,
    overallHealthScore: Math.round((
      healthChecks.reduce((sum, item) => sum + clampScore(item.score, 0), 0)
    ) / Math.max(1, healthChecks.length)),
    healthChecks,
    readinessEvidence,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 28),
    prerequisitePlanSources: [
      customerOperatingRoomPlan?.source,
      providerQualitySelectionPlan?.source,
      productTelemetryPlan?.source,
      acquisitionExpansionPlan?.source
    ].filter(Boolean),
    areaLabel: customerOperatingRoomPlan?.areaLabel || acquisitionExpansionPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(customerOperatingRoomPlan?.evidenceLeadIds || []),
      ...(providerQualitySelectionPlan?.evidenceLeadIds || []),
      ...(productTelemetryPlan?.evidenceLeadIds || []),
      ...(acquisitionExpansionPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(customerOperatingRoomPlan?.sourceUrls || []),
      ...(providerQualitySelectionPlan?.sourceUrls || []),
      ...(productTelemetryPlan?.sourceUrls || []),
      ...(acquisitionExpansionPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'operating health is internal proof only; do not make readiness, SLA, vendor, vertical-scale, or provider-fabric claims until receipts, customer-visible review, and operator approval exist',
    assumptions: [
      'customer SLA and vendor SLA health start blocked until real completion, status-update, acceptance, and backup-route receipts exist',
      'vertical health and provider fabric are local rollups until live margin, customer, vendor, and provider history is durable',
      'this plan does not publish readiness claims, accelerate routing, scale a vertical, expose SLA promises, or treat mock checks as live operating health'
    ],
    source: 'market_provenance_operating_health_plan'
  };
}

function buildContinualLearningPlan({
  opportunity,
  city = '',
  verticalName = '',
  productTelemetryPlan = null,
  acquisitionExpansionPlan = null,
  operatingHealthPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const objectionTaxonomy = [
    {
      key: 'price_objection',
      status: 'draft_required',
      sourceSignals: ['pricing_margin_inference', 'quote_conversion_outcome'],
      updates: ['pricing_copy', 'offer_bundle', 'followup_script']
    },
    {
      key: 'trust_objection',
      status: 'draft_required',
      sourceSignals: ['trust_asset_gap', 'review_complaint_cluster'],
      updates: ['trust_assets', 'proof_requirements', 'customer_room_copy']
    },
    {
      key: 'timing_availability_objection',
      status: 'draft_required',
      sourceSignals: ['booking_flow_state', 'customer_sla_health'],
      updates: ['booking_windows', 'dispatch_script', 'sla_boundary']
    },
    {
      key: 'urgency_mismatch',
      status: 'draft_required',
      sourceSignals: ['service_urgency', 'owner_responsiveness', 'demand_pressure'],
      updates: ['lead_scoring', 'triage_copy', 'channel_choice']
    },
    {
      key: 'proof_gap',
      status: 'draft_required',
      sourceSignals: ['completion_proof_gap', 'license_claim_review', 'provider_fabric'],
      updates: ['proof_collection', 'restricted_claims', 'provider_selection']
    },
    {
      key: 'scope_confusion',
      status: 'draft_required',
      sourceSignals: ['customer_confusion_capture', 'service_menu_plan'],
      updates: ['scope_copy', 'intake_fields', 'handoff_thresholds']
    },
    {
      key: 'competitor_preference',
      status: 'draft_required',
      sourceSignals: ['competitor_weakness', 'ad_saturation_offer_fatigue'],
      updates: ['positioning', 'search_intent_surface', 'offer_angle']
    },
    {
      key: 'no_response',
      status: 'draft_required',
      sourceSignals: ['owner_responsiveness', 'missed_call_rescue', 'email_reply_classification'],
      updates: ['followup_timing', 'channel_sequence', 'stop_rules']
    }
  ];
  const cohortModels = [
    {
      key: 'market_launch_cohort',
      status: 'draft_required',
      segmentBy: ['city', 'vertical_key', 'launch_month'],
      learns: ['market_false_positive_rate', 'first_wave_conversion', 'payback_period']
    },
    {
      key: 'acquisition_channel_cohort',
      status: 'draft_required',
      segmentBy: ['channel', 'offer', 'consent_state'],
      learns: ['reply_rate', 'cost_per_conversion', 'objection_mix']
    },
    {
      key: 'customer_segment_cohort',
      status: 'blocked_pending_customer_history',
      segmentBy: ['service_need', 'urgency_class', 'price_band'],
      learns: ['ltv', 'repeat_work_rate', 'refund_rate']
    },
    {
      key: 'provider_quality_cohort',
      status: 'blocked_pending_provider_history',
      segmentBy: ['provider', 'service_area', 'fallback_route'],
      learns: ['sla_hit_rate', 'failure_rate', 'customer_satisfaction']
    },
    {
      key: 'pricing_offer_cohort',
      status: 'draft_required',
      segmentBy: ['package_key', 'representative_price', 'discount_policy'],
      learns: ['conversion_rate', 'gross_margin', 'objection_rate']
    }
  ];
  const learningArtifacts = [
    {
      key: 'objection_eval_case',
      status: 'draft_only',
      generatedFrom: ['price_objection', 'trust_objection', 'scope_confusion']
    },
    {
      key: 'cohort_postmortem',
      status: 'draft_only',
      generatedFrom: ['market_launch_cohort', 'acquisition_channel_cohort']
    },
    {
      key: 'strategy_update_proposal',
      status: 'operator_review_required',
      generatedFrom: ['objection_taxonomy', 'cohort_models']
    }
  ];
  const requiredSetupKeys = [
    'objection_taxonomy_schema_required',
    'objection_label_review_required',
    'cohort_learning_model_required',
    'cohort_sample_size_gate_required',
    'learning_artifact_review_required',
    'strategy_update_operator_approval_required',
    'learning_to_eval_conversion_required',
    'historical_receipt_link_required'
  ];
  return {
    status: 'draft_required',
    objectionLearningAllowed: false,
    cohortDecisionAllowed: false,
    automaticStrategyRewriteAllowed: false,
    automaticEvalPublicationAllowed: false,
    taxonomyCount: objectionTaxonomy.length,
    cohortCount: cohortModels.length,
    artifactCount: learningArtifacts.length,
    objectionTaxonomy,
    cohortModels,
    learningArtifacts,
    requiredSetupKeys,
    prerequisitePlanSources: [
      productTelemetryPlan?.source,
      acquisitionExpansionPlan?.source,
      operatingHealthPlan?.source
    ].filter(Boolean),
    areaLabel: operatingHealthPlan?.areaLabel || acquisitionExpansionPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(productTelemetryPlan?.evidenceLeadIds || []),
      ...(acquisitionExpansionPlan?.evidenceLeadIds || []),
      ...(operatingHealthPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(productTelemetryPlan?.sourceUrls || []),
      ...(acquisitionExpansionPlan?.sourceUrls || []),
      ...(operatingHealthPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'continual learning is an internal model only; do not rewrite strategy, publish evals, change pricing, alter follow-up timing, or route cohorts automatically before reviewed outcome evidence exists',
    assumptions: [
      'objection labels require reviewed call, email, quote, customer, and operator evidence before they can change scripts or offers',
      'cohort models require minimum sample sizes and durable receipts before they can influence market, channel, customer, provider, or pricing decisions',
      'this plan does not rewrite live strategy, publish evals, change prices, change follow-up timing, or auto-route cohorts'
    ],
    source: 'market_provenance_continual_learning_plan'
  };
}

function buildAutonomousLaunchLoopPlan({
  opportunity,
  city = '',
  verticalName = '',
  brandName = '',
  serviceName = '',
  trustAssetPlan = null,
  bookingFlowPlan = null,
  serviceMenuPlan = null,
  communicationProvisioningPlan = null,
  localDomainStrategyPlan = null,
  serviceScriptPlan = null,
  customerOperatingRoomPlan = null,
  providerQualitySelectionPlan = null,
  productTelemetryPlan = null,
  acquisitionExpansionPlan = null,
  operatingHealthPlan = null,
  continualLearningPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const marketSizing = signals.marketSizing || {};
  const stages = [
    {
      key: 'pick_city',
      status: city ? 'evidence_ready' : 'blocked_pending_market_city',
      evidence: ['market_opportunity_city'],
      liveAllowed: false
    },
    {
      key: 'pick_no_vertical_manually',
      status: opportunity?.vertical_key ? 'evidence_ready' : 'blocked_pending_vertical_inference',
      evidence: ['lead_evidence_vertical_key', 'vertical_pack_match'],
      liveAllowed: false
    },
    {
      key: 'inspect_market',
      status: provenance.source ? 'evidence_ready' : 'blocked_pending_market_provenance',
      evidence: ['market_recommendation_provenance', 'confidence_intervals', 'market_sizing'],
      liveAllowed: false
    },
    {
      key: 'propose_best_business',
      status: 'draft_ready',
      evidence: ['launchability_score', 'recommendation_decision', 'brand_candidate'],
      liveAllowed: false
    },
    {
      key: 'approve_launch',
      status: 'operator_review_required',
      evidence: ['operator_launch_approval_required', 'safe_to_launch_gate_required'],
      liveAllowed: false
    },
    {
      key: 'create_brand_site_phone_inbox_scripts_pricing_portal_payment_path',
      status: 'draft_required',
      evidence: [
        'brand_name',
        'owned_surface_plan',
        'communication_provisioning_plan',
        'service_script_plan',
        'service_menu_plan',
        'customer_operating_room_plan'
      ],
      liveAllowed: false
    },
    {
      key: 'acquire_first_customer',
      status: 'local_dry_run_ready',
      evidence: ['launch_first_motion_receipt_required', 'owned_acquisition_surface_required'],
      liveAllowed: false
    },
    {
      key: 'collect_payment',
      status: 'blocked_pending_payment_provider',
      evidence: ['safe_to_charge_gate_required', 'stripe_live_smoke_required', 'invoice_approval_required'],
      liveAllowed: false
    },
    {
      key: 'fulfill_or_route_to_qualified_provider',
      status: 'blocked_pending_provider_and_vendor_history',
      evidence: ['safe_to_fulfill_gate_required', 'provider_quality_selection_plan', 'vendor_qualification_required'],
      liveAllowed: false
    },
    {
      key: 'prove_completion',
      status: 'blocked_pending_completion_receipts',
      evidence: ['completion_proof_receipts_required', 'customer_acceptance_required', 'sla_receipts_required'],
      liveAllowed: false
    },
    {
      key: 'request_review',
      status: 'blocked_pending_completed_service',
      evidence: ['review_policy_required', 'completed_service_required', 'no_incentive_required'],
      liveAllowed: false
    },
    {
      key: 'retain_or_upsell',
      status: 'blocked_pending_cohort_history',
      evidence: ['retention_loop_required', 'customer_segment_cohort_required', 'operator_offer_approval_required'],
      liveAllowed: false
    },
    {
      key: 'measure_margin',
      status: Number.isFinite(Number(marketSizing.contributionMarginCents)) ? 'draft_ready' : 'blocked_pending_finance_rollup',
      evidence: ['market_sizing', 'finance_rollup_required', 'cost_attribution_required'],
      liveAllowed: false
    },
    {
      key: 'decide_scale_pause_shutdown',
      status: 'operator_review_required',
      evidence: ['operating_health_plan', 'acquisition_strategy_recommendation', 'operator_budget_approval_required'],
      liveAllowed: false
    },
    {
      key: 'write_postmortem',
      status: 'draft_required',
      evidence: ['cohort_postmortem', 'learning_record_required', 'incident_or_outcome_summary_required'],
      liveAllowed: false
    },
    {
      key: 'improve_itself',
      status: 'blocked_pending_reviewed_learning_artifact',
      evidence: ['continual_learning_plan', 'safe_pr_proposal_gate_required', 'regression_proofing_gate_required'],
      liveAllowed: false
    }
  ];
  const requiredSetupKeys = [
    'autonomous_launch_loop_replay_required',
    'city_selection_evidence_required',
    'vertical_inference_evidence_required',
    'market_inspection_receipt_required',
    'best_business_proposal_required',
    'operator_launch_approval_required',
    'operating_stack_creation_review_required',
    'first_customer_acquisition_receipt_required',
    'payment_provider_live_smoke_required',
    'qualified_provider_route_required',
    'completion_proof_receipts_required',
    'review_request_policy_required',
    'retention_or_upsell_review_required',
    'margin_measurement_rollup_required',
    'scale_pause_shutdown_decision_required',
    'postmortem_required',
    'self_improvement_review_required',
    ...stages.flatMap((item) => item.evidence || [])
  ];
  return {
    status: 'draft_required',
    liveExecutionAllowed: false,
    externalSideEffectsAllowed: false,
    automaticCitySelectionAllowed: false,
    automaticVerticalSelectionAllowed: false,
    paymentCollectionAllowed: false,
    reviewRequestAllowed: false,
    retentionOfferAllowed: false,
    selfImprovementAllowed: false,
    stageCount: stages.length,
    blockedStageCount: stages.filter((item) => item.status.startsWith('blocked')).length,
    draftStageCount: stages.filter((item) => item.status.includes('draft')).length,
    reviewStageCount: stages.filter((item) => item.status.includes('review')).length,
    evidenceReadyStageCount: stages.filter((item) => item.status === 'evidence_ready').length,
    selectedCity: city || null,
    selectedVerticalKey: opportunity?.vertical_key || null,
    selectedVerticalName: verticalName || cleanText(opportunity?.vertical_key),
    selectedBrandName: brandName || null,
    selectedServiceName: serviceName || null,
    revenueProxyCents: marketSizing.obtainableFirstWaveCents || marketSizing.estimatedCallableRevenueCents || null,
    marginProxyCents: marketSizing.obtainableFirstWaveMarginCents || marketSizing.contributionMarginCents || null,
    stages,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 48),
    prerequisitePlanSources: [
      trustAssetPlan?.source,
      bookingFlowPlan?.source,
      serviceMenuPlan?.source,
      communicationProvisioningPlan?.source,
      localDomainStrategyPlan?.source,
      serviceScriptPlan?.source,
      customerOperatingRoomPlan?.source,
      providerQualitySelectionPlan?.source,
      productTelemetryPlan?.source,
      acquisitionExpansionPlan?.source,
      operatingHealthPlan?.source,
      continualLearningPlan?.source
    ].filter(Boolean),
    areaLabel: serviceMenuPlan?.areaLabel || customerOperatingRoomPlan?.areaLabel || operatingHealthPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(trustAssetPlan?.evidenceLeadIds || []),
      ...(serviceMenuPlan?.evidenceLeadIds || []),
      ...(customerOperatingRoomPlan?.evidenceLeadIds || []),
      ...(operatingHealthPlan?.evidenceLeadIds || []),
      ...(continualLearningPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(trustAssetPlan?.sourceUrls || []),
      ...(serviceMenuPlan?.sourceUrls || []),
      ...(customerOperatingRoomPlan?.sourceUrls || []),
      ...(operatingHealthPlan?.sourceUrls || []),
      ...(continualLearningPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'autonomous launch loop is local proof only; do not select a city for live launch, contact customers, collect payment, route providers, request reviews, publish retention offers, or self-modify without receipts and operator approval',
    assumptions: [
      'the loop can prove local planning from market evidence, but live city launch and customer/provider/payment actions remain gated',
      'payment, fulfillment, review request, retention, scale/pause/shutdown, postmortem, and self-improvement stages require durable receipts before execution',
      'this plan does not collect money, message customers, route providers, request reviews, publish offers, or modify code automatically'
    ],
    source: 'market_provenance_autonomous_launch_loop_plan'
  };
}

function buildVerticalLifecyclePlan({
  opportunity,
  source = {},
  city = '',
  verticalName = '',
  serviceName = '',
  operatingHealthPlan = null,
  continualLearningPlan = null,
  autonomousLaunchLoopPlan = null
} = {}) {
  const signals = opportunity?.signals || {};
  const provenance = signals.marketRecommendationProvenance || {};
  const packKey = cleanKey(source.key || signals.verticalManifest?.key || opportunity?.vertical_key || verticalName);
  const packVersion = cleanText(source.version) || '1.0.0';
  const versionKey = `${packKey}@draft`;
  const workflows = [
    {
      key: 'install_vertical_pack',
      status: 'blocked_pending_install_review',
      stage: 'install',
      liveAllowed: false,
      requiredProofKeys: [
        'vertical_pack_install_review_required',
        'manifest_validation_receipt_required',
        'starter_vertical_replay_required'
      ]
    },
    {
      key: 'validate_pack_manifest',
      status: 'draft_required',
      stage: 'validate',
      liveAllowed: false,
      requiredProofKeys: [
        'manifest_schema_validation_required',
        'restricted_claim_policy_review_required',
        'margin_model_review_required'
      ]
    },
    {
      key: 'promote_pack_version',
      status: 'blocked_pending_version_approval',
      stage: 'version',
      liveAllowed: false,
      requiredProofKeys: [
        'version_promotion_approval_required',
        'regression_pack_replay_required',
        'backwards_compatibility_review_required'
      ]
    },
    {
      key: 'retire_vertical_pack',
      status: 'blocked_pending_retirement_review',
      stage: 'retire',
      liveAllowed: false,
      requiredProofKeys: [
        'retirement_impact_review_required',
        'replacement_pack_evidence_required',
        'active_launch_migration_review_required'
      ]
    },
    {
      key: 'rollback_pack_version',
      status: 'blocked_pending_rollback_plan',
      stage: 'rollback',
      liveAllowed: false,
      requiredProofKeys: [
        'pack_rollback_plan_required',
        'lifecycle_event_receipt_required',
        'operator_rollback_approval_required'
      ]
    }
  ];
  const lifecycleReceipts = [
    {
      key: 'install_event_receipt',
      status: 'required',
      proves: ['local_ledger_event', 'operator_review', 'no_external_publication']
    },
    {
      key: 'version_event_receipt',
      status: 'required',
      proves: ['version_diff', 'starter_vertical_replay', 'rollback_pointer']
    },
    {
      key: 'retirement_event_receipt',
      status: 'required',
      proves: ['impact_review', 'replacement_or_restore_path', 'no_json_deletion']
    }
  ];
  const requiredSetupKeys = [
    'vertical_pack_lifecycle_ledger_required',
    'vertical_pack_install_review_required',
    'manifest_validation_receipt_required',
    'manifest_schema_validation_required',
    'restricted_claim_policy_review_required',
    'margin_model_review_required',
    'version_promotion_approval_required',
    'regression_pack_replay_required',
    'backwards_compatibility_review_required',
    'retirement_impact_review_required',
    'replacement_pack_evidence_required',
    'active_launch_migration_review_required',
    'pack_rollback_plan_required',
    'lifecycle_event_receipt_required',
    'operator_rollback_approval_required',
    'starter_vertical_replay_required'
  ];
  return {
    status: 'draft_required',
    packKey,
    packName: cleanText(source.name) || verticalName || packKey,
    packVersion,
    versionKey,
    selectedCity: city || null,
    selectedServiceName: serviceName || null,
    liveInstallAllowed: false,
    installAllowed: false,
    versionPromotionAllowed: false,
    retirementAllowed: false,
    rollbackAllowed: false,
    externalSideEffectsAllowed: false,
    jsonMutationAllowed: false,
    customerMigrationAllowed: false,
    workflowCount: workflows.length,
    blockedWorkflowCount: workflows.filter((item) => item.status.startsWith('blocked')).length,
    receiptCount: lifecycleReceipts.length,
    manifestFieldCount: [
      source.serviceOffer,
      source.marginModel,
      source.compliance,
      source.launchChecklist,
      source.evals,
      source.growthPaths,
      source.retentionLoops
    ].filter(Boolean).length,
    workflows,
    lifecycleReceipts,
    requiredSetupKeys: [...new Set(requiredSetupKeys)].slice(0, 40),
    prerequisitePlanSources: [
      operatingHealthPlan?.source,
      continualLearningPlan?.source,
      autonomousLaunchLoopPlan?.source
    ].filter(Boolean),
    areaLabel: operatingHealthPlan?.areaLabel || autonomousLaunchLoopPlan?.areaLabel || city || null,
    serviceLabel: verticalName || cleanText(opportunity?.vertical_key),
    evidenceLeadIds: [...new Set([
      ...(provenance.evidenceLeadIds || []),
      ...(operatingHealthPlan?.evidenceLeadIds || []),
      ...(continualLearningPlan?.evidenceLeadIds || []),
      ...(autonomousLaunchLoopPlan?.evidenceLeadIds || [])
    ])].slice(0, 16),
    sourceUrls: [...new Set([
      ...(provenance.sourceUrls || []),
      ...(operatingHealthPlan?.sourceUrls || []),
      ...(continualLearningPlan?.sourceUrls || []),
      ...(autonomousLaunchLoopPlan?.sourceUrls || [])
    ])].slice(0, 12),
    customerPromiseBoundary: 'vertical lifecycle is a local management plan only; do not install, promote, retire, roll back, delete pack JSON, migrate customers, or publish a new vertical without reviewed lifecycle receipts and operator approval',
    assumptions: [
      'pack install, version promotion, retirement, and rollback require local ledger receipts before they can affect live launches',
      'retirement must prove replacement coverage or restore path before any future matching behavior changes',
      'this plan does not delete JSON packs, migrate customers, publish services, mutate providers, or change live acquisition behavior automatically'
    ],
    source: 'market_provenance_vertical_lifecycle_plan'
  };
}

function normalizeBlueprintOffer(offer = {}, marginModel = null) {
  const packages = Array.isArray(offer.packages) && offer.packages.length
    ? offer.packages
    : [{
      key: 'launch',
      name: offer.headline || 'Launch package',
      priceCents: marginModel?.basePriceCents || 50000
    }];
  return {
    headline: cleanText(offer.headline) || 'Launch-ready local service offer',
    customerOutcome: cleanText(offer.customerOutcome) || '',
    packages,
    refundPolicy: cleanText(offer.refundPolicy) || 'Operator review required before public launch.',
    proofAssets: Array.isArray(offer.proofAssets) ? offer.proofAssets : []
  };
}

function blueprintKey(value) {
  if (typeof value === 'string') return cleanKey(value);
  return cleanKey(value?.key || value?.label || value?.name || JSON.stringify(value || {}));
}

function detectCompetitorWeaknesses(group) {
  const total = group.leads.length;
  if (!total) return [];
  const items = [];
  const noWebsite = group.leads.filter((lead) => {
    const value = cleanText(lead.website);
    return !value || value.toLowerCase() === 'null';
  });
  if (noWebsite.length) {
    items.push(makeCompetitorWeakness({
      key: 'no_website',
      label: 'No public website',
      count: noWebsite.length,
      total,
      leads: noWebsite,
      exploit: 'Capture intent these competitors miss with a Callan-owned acquisition surface.'
    }));
  }
  const weakPresence = group.leads.filter((lead) => ['weak', 'missing', 'thin'].includes(String(lead.online_presence_strength || '').toLowerCase()));
  if (weakPresence.length) {
    items.push(makeCompetitorWeakness({
      key: 'weak_online_presence',
      label: 'Weak online presence',
      count: weakPresence.length,
      total,
      leads: weakPresence,
      exploit: 'Differentiate with a trustworthy SEO page and review-loop motion.'
    }));
  }
  const noPhone = group.leads.filter((lead) => !cleanText(lead.phone));
  if (noPhone.length) {
    items.push(makeCompetitorWeakness({
      key: 'missing_callable_phone',
      label: 'No callable phone listed',
      count: noPhone.length,
      total,
      leads: noPhone,
      exploit: 'Publish a verified inbound phone to win urgent-response demand.'
    }));
  }
  const phoneRisk = group.leads.filter((lead) => ['mobile_risk', 'unknown'].includes(String(lead.phone_classification || '').toLowerCase()));
  if (phoneRisk.length) {
    items.push(makeCompetitorWeakness({
      key: 'mobile_or_unknown_phone_risk',
      label: 'Mobile/unknown phone risk',
      count: phoneRisk.length,
      total,
      leads: phoneRisk,
      exploit: 'Position a verified business desk so customers know who is on the other end.'
    }));
  }
  const lowConfidence = group.leads.filter((lead) => {
    const value = Number(lead.presence_confidence);
    return Number.isFinite(value) && value < 0.5;
  });
  if (lowConfidence.length) {
    items.push(makeCompetitorWeakness({
      key: 'low_research_confidence',
      label: 'Low research confidence',
      count: lowConfidence.length,
      total,
      leads: lowConfidence,
      exploit: 'Hold public comparison claims until evidence improves and operator review approves.'
    }));
  }
  const missingSource = group.leads.filter((lead) => !cleanText(lead.source_url));
  if (missingSource.length) {
    items.push(makeCompetitorWeakness({
      key: 'missing_source_url',
      label: 'No cited source URL',
      count: missingSource.length,
      total,
      leads: missingSource,
      exploit: 'Require cited source URLs before any public claim about competitor weakness.'
    }));
  }
  const callabilityUncertain = group.leads.filter((lead) => !['callable', 'qualified'].includes(String(lead.risk_status || '').toLowerCase()));
  if (callabilityUncertain.length) {
    items.push(makeCompetitorWeakness({
      key: 'callability_uncertain',
      label: 'Callability uncertain',
      count: callabilityUncertain.length,
      total,
      leads: callabilityUncertain,
      exploit: 'Default to inbound/local-SEO motions until outbound callability is verified.'
    }));
  }
  return items.sort((a, b) => b.ratio - a.ratio || b.count - a.count);
}

function makeCompetitorWeakness({ key, label, count, total, leads, exploit }) {
  const denom = Math.max(1, Number(total) || 1);
  const ratio = Math.max(0, Math.min(1, count / denom));
  const severity = ratio >= 0.7 ? 'high' : ratio >= 0.4 ? 'medium' : 'low';
  return {
    key,
    label,
    count,
    total,
    ratio: Number(ratio.toFixed(4)),
    severity,
    evidenceLeadIds: leads.slice(0, 12).map((lead) => `lead:${lead.id}`),
    exploit,
    source: 'lead_evidence_competitor_weakness_detection'
  };
}

const REVIEW_COMPLAINT_PATTERNS = [
  {
    key: 'slow_response',
    label: 'Slow or missed response',
    terms: ['slow response', 'response time', 'waited', 'waiting', 'no callback', 'missed call', 'unanswered', 'voicemail', 'could not reach', 'never called'],
    acquisitionAngle: 'Lead with fast callback proof, missed-call rescue, and visible response-time boundaries.'
  },
  {
    key: 'scheduling_availability',
    label: 'Scheduling and availability friction',
    terms: ['schedule', 'scheduling', 'appointment', 'availability', 'available', 'same day', 'same-day', 'window', 'book', 'booking', 'reschedule'],
    acquisitionAngle: 'Capture frustrated demand with clear booking windows, service-area coverage, and same-day path proof.'
  },
  {
    key: 'pricing_surprise',
    label: 'Pricing or estimate surprise',
    terms: ['price', 'pricing', 'estimate', 'quote', 'surprise fee', 'hidden fee', 'expensive', 'overcharged', 'cost', 'invoice', 'upsell'],
    acquisitionAngle: 'Differentiate with transparent diagnostic fees, package ranges, and operator-reviewed offer copy.'
  },
  {
    key: 'quality_rework',
    label: 'Quality or rework complaints',
    terms: ['poor quality', 'bad job', 'broke', 'broken', 'fix again', 'rework', 'unfinished', 'not fixed', 'came back', 'warranty'],
    acquisitionAngle: 'Require completion-proof, photo evidence, warranty boundaries, and backup vendor routing before scaling.'
  },
  {
    key: 'messy_cleanup',
    label: 'Cleanup and professionalism issues',
    terms: ['mess', 'messy', 'dirty', 'cleanup', 'clean up', 'rude', 'unprofessional', 'late technician', 'late tech', 'no show', 'no-show'],
    acquisitionAngle: 'Make arrival, cleanup, and technician conduct promises auditable through job-tracking and completion proof.'
  },
  {
    key: 'trust_license',
    label: 'Trust, license, or proof uncertainty',
    terms: ['license', 'licensed', 'insured', 'trust', 'scam', 'fake', 'credential', 'proof', 'guarantee', 'review gate'],
    acquisitionAngle: 'Keep trust claims conservative and require license/insurance proof before public promotion.'
  },
  {
    key: 'emergency_after_hours',
    label: 'After-hours emergency gap',
    terms: ['emergency', 'after hours', 'after-hours', '24/7', '24 7', 'midnight', 'night', 'weekend', 'no ac', 'no heat', 'leak', 'flood'],
    acquisitionAngle: 'Only promote emergency capture when after-hours coverage and escalation evidence exist.'
  }
];

function detectReviewComplaintClusters({ group, serviceUrgency = null, demandPressure = null } = {}) {
  const total = Math.max(1, group?.leads?.length || 0);
  const clusters = new Map();
  for (const lead of group?.leads || []) {
    const claims = reviewComplaintClaimsForLead(lead);
    for (const claim of claims) {
      const text = cleanText(claim.text).toLowerCase();
      if (!text) continue;
      for (const pattern of REVIEW_COMPLAINT_PATTERNS) {
        const matchedTerms = pattern.terms.filter((term) => text.includes(term));
        if (!matchedTerms.length) continue;
        const current = clusters.get(pattern.key) || {
          key: pattern.key,
          label: pattern.label,
          acquisitionAngle: pattern.acquisitionAngle,
          leadIds: new Set(),
          evidenceIds: new Set(),
          sourceUrls: new Set(),
          claims: [],
          confidences: [],
          matchedTerms: new Set()
        };
        current.leadIds.add(`lead:${lead.id}`);
        for (const id of claim.evidenceIds || []) current.evidenceIds.add(id);
        if (claim.sourceUrl) current.sourceUrls.add(claim.sourceUrl);
        for (const term of matchedTerms) current.matchedTerms.add(term);
        current.claims.push({
          leadId: `lead:${lead.id}`,
          businessName: cleanText(lead.business_name),
          source: claim.source,
          sourceUrl: claim.sourceUrl || cleanText(lead.source_url) || null,
          summary: cleanText(claim.text).slice(0, 280),
          evidenceIds: claim.evidenceIds || []
        });
        if (Number.isFinite(Number(claim.confidence))) current.confidences.push(Number(claim.confidence));
        clusters.set(pattern.key, current);
      }
    }
  }

  return [...clusters.values()].map((cluster) => {
    const leadCount = cluster.leadIds.size;
    const mentionCount = cluster.claims.length;
    const ratio = leadCount / total;
    const avgConfidence = average(cluster.confidences) ?? 0.55;
    const urgencyBoost = cluster.key === 'emergency_after_hours' && serviceUrgency?.urgencyClass === 'emergency_first'
      ? 0.12
      : cluster.key === 'slow_response' && ['emergency_first', 'urgent_response'].includes(serviceUrgency?.urgencyClass)
        ? 0.08
        : 0;
    const pressureBoost = ['elevated', 'high'].includes(demandPressure?.pressureLevel) ? 0.05 : 0;
    const score = clamp((ratio * 0.55) + (Math.min(1, mentionCount / Math.max(1, total * 2)) * 0.20) + (avgConfidence * 0.15) + urgencyBoost + pressureBoost);
    const severity = score >= 0.72 ? 'high' : score >= 0.45 ? 'medium' : 'low';
    return {
      key: cluster.key,
      label: cluster.label,
      severity,
      score,
      leadCount,
      mentionCount,
      totalLeads: total,
      ratio: Number(ratio.toFixed(4)),
      matchedTerms: [...cluster.matchedTerms].slice(0, 12),
      evidenceLeadIds: [...cluster.leadIds].slice(0, 12),
      evidenceIds: [...cluster.evidenceIds].slice(0, 12),
      sourceUrls: [...cluster.sourceUrls].slice(0, 8),
      exampleClaims: cluster.claims.slice(0, 4),
      acquisitionAngle: cluster.acquisitionAngle,
      source: 'lead_evidence_review_complaint_clustering'
    };
  }).sort((a, b) => b.score - a.score || b.leadCount - a.leadCount || b.mentionCount - a.mentionCount || a.key.localeCompare(b.key));
}

function summarizeReviewComplaintClusters(clusters = [], totalLeads = 0) {
  const covered = new Set();
  for (const cluster of clusters) {
    for (const id of cluster.evidenceLeadIds || []) covered.add(id);
  }
  const denom = Math.max(1, Number(totalLeads) || 0);
  return {
    totalClusters: clusters.length,
    highSeverity: clusters.filter((item) => item.severity === 'high').length,
    topClusterKey: clusters[0]?.key || null,
    topClusterScore: clusters[0]?.score || 0,
    topClusterKeys: clusters.slice(0, 5).map((item) => item.key),
    coveredLeadCount: covered.size,
    coveredLeadRatio: Number((covered.size / denom).toFixed(4)),
    evidenceClaimCount: clusters.reduce((sum, item) => sum + (item.mentionCount || 0), 0),
    evidenceRequired: clusters.length ? [] : ['review_complaint_evidence_required'],
    assumptions: [
      'clusters are derived from stored lead research_json, review themes, complaint claims, website issues, and callable notes',
      'no live review scraping or external review mutation is performed during clustering',
      'complaint clusters describe market pain patterns, not verified accusations for public copy'
    ],
    source: 'lead_evidence_review_complaint_clustering'
  };
}

function reviewComplaintClaimsForLead(lead = {}) {
  const profile = parsePortfolioJson(lead.research_json) || {};
  const intelligence = profile.leadIntelligence || profile.lead_intelligence || {};
  const candidates = [];
  const add = (items, source) => {
    for (const item of Array.isArray(items) ? items : []) {
      const text = claimText(item);
      if (!text) continue;
      candidates.push({
        text,
        source,
        sourceUrl: cleanText(item?.sourceUrl || item?.source_url || item?.url || lead.source_url) || null,
        evidenceIds: evidenceIdsFromClaim(item),
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null
      });
    }
  };
  add(intelligence.complaintsPainPoints, 'lead_intelligence.complaints_pain_points');
  add(intelligence.complaints, 'lead_intelligence.complaints');
  add(profile.complaintsPainPoints, 'research_profile.complaints_pain_points');
  add(profile.complaints, 'research_profile.complaints');
  add(intelligence.reviewThemes, 'lead_intelligence.review_themes');
  add(profile.reviewThemes, 'research_profile.review_themes');
  add(intelligence.currentWebsiteIssues, 'lead_intelligence.current_website_issues');
  add(profile.currentWebsiteIssues, 'research_profile.current_website_issues');
  add(intelligence.missingCustomerInfo, 'lead_intelligence.missing_customer_info');
  add(profile.missingCustomerInfo, 'research_profile.missing_customer_info');
  add(profile.reviews, 'research_profile.reviews');
  for (const field of ['callable_reason', 'blocked_reason']) {
    const text = cleanText(lead[field]);
    if (text) {
      candidates.push({
        text,
        source: `lead.${field}`,
        sourceUrl: cleanText(lead.source_url) || null,
        evidenceIds: [`lead:${lead.id}:${field}`],
        confidence: Number.isFinite(Number(lead.presence_confidence)) ? Number(lead.presence_confidence) : null
      });
    }
  }
  if (cleanText(profile.onlinePresenceSummary)) {
    candidates.push({
      text: profile.onlinePresenceSummary,
      source: 'research_profile.online_presence_summary',
      sourceUrl: cleanText(profile.sourceUrl || lead.source_url) || null,
      evidenceIds: [`lead:${lead.id}:onlinePresenceSummary`],
      confidence: Number.isFinite(Number(profile.presenceConfidence)) ? Number(profile.presenceConfidence) : null
    });
  }
  return candidates;
}

function claimText(item) {
  if (typeof item === 'string') return cleanText(item);
  if (!item || typeof item !== 'object') return '';
  return [
    item.summary,
    item.claim,
    item.quote,
    item.evidenceText,
    item.value,
    item.text,
    item.reason,
    item.label
  ].map(cleanText).filter(Boolean).join(' ');
}

function evidenceIdsFromClaim(item = {}) {
  const ids = [];
  for (const value of [
    item.id,
    item.sourceId,
    item.source_id,
    ...(Array.isArray(item.evidenceIds) ? item.evidenceIds : []),
    ...(Array.isArray(item.evidence_ids) ? item.evidence_ids : [])
  ]) {
    const text = cleanText(value);
    if (text) ids.push(text);
  }
  return [...new Set(ids)];
}

const FORMATION_PERMIT_PATTERNS = [
  {
    key: 'license_verified',
    label: 'License evidence found',
    signalClass: 'positive_evidence',
    terms: ['license #', 'license number', 'licensed contractor', 'state license', 'contractor license active', 'license active', 'roc #', 'roc number'],
    action: 'License-sensitive public copy can cite this only after operator review preserves the exact source.'
  },
  {
    key: 'permit_requirement',
    label: 'Permit or inspection requirement',
    signalClass: 'regulatory_requirement',
    terms: ['permit required', 'building permit', 'mechanical permit', 'plumbing permit', 'inspection required', 'requires inspection', 'city permit'],
    action: 'Require permit-scope review before selling or subcontracting work that could imply field execution.'
  },
  {
    key: 'recent_permit_activity',
    label: 'Recent permit activity',
    signalClass: 'market_activity',
    terms: ['permit issued', 'permit pulled', 'active permit', 'inspection passed', 'permit application', 'permit record'],
    action: 'Treat permit activity as demand evidence, not proof of Callan fulfillment readiness.'
  },
  {
    key: 'business_formation_active',
    label: 'Business formation evidence',
    signalClass: 'formation_evidence',
    terms: ['secretary of state', 'entity active', 'registration active', 'formed', 'incorporated', 'business registry', 'entity search', 'new business filing'],
    action: 'Use formation evidence to prioritize fresh or real entities, but keep ownership claims out of public copy.'
  },
  {
    key: 'insurance_or_bond_evidence',
    label: 'Insurance or bond evidence',
    signalClass: 'positive_evidence',
    terms: ['insured', 'bonded', 'insurance certificate', 'certificate of insurance', 'bond number'],
    action: 'Insurance/bond copy stays omitted unless the exact source and scope are operator-reviewed.'
  },
  {
    key: 'license_claim_unverified',
    label: 'Unverified license-sensitive claim',
    signalClass: 'missing_evidence',
    terms: ['license missing', 'license not found', 'unverified license', 'license lookup unavailable', 'claims licensed without license number', 'license claim unverified'],
    action: 'Block license, bonded, insured, and regulated-service claims until source evidence is attached.'
  }
];

function detectFormationPermitSignals({ group } = {}) {
  const total = Math.max(1, group?.leads?.length || 0);
  const signals = new Map();
  for (const lead of group?.leads || []) {
    const claims = formationPermitClaimsForLead(lead);
    for (const claim of claims) {
      const text = cleanText(claim.text).toLowerCase();
      if (!text) continue;
      for (const pattern of FORMATION_PERMIT_PATTERNS) {
        const matchedTerms = pattern.terms.filter((term) => text.includes(term));
        if (!matchedTerms.length) continue;
        const current = signals.get(pattern.key) || {
          key: pattern.key,
          label: pattern.label,
          signalClass: pattern.signalClass,
          action: pattern.action,
          leadIds: new Set(),
          evidenceIds: new Set(),
          sourceUrls: new Set(),
          claims: [],
          confidences: [],
          matchedTerms: new Set()
        };
        current.leadIds.add(`lead:${lead.id}`);
        for (const id of claim.evidenceIds || []) current.evidenceIds.add(id);
        if (claim.sourceUrl) current.sourceUrls.add(claim.sourceUrl);
        for (const term of matchedTerms) current.matchedTerms.add(term);
        current.claims.push({
          leadId: `lead:${lead.id}`,
          businessName: cleanText(lead.business_name),
          source: claim.source,
          sourceUrl: claim.sourceUrl || cleanText(lead.source_url) || null,
          summary: cleanText(claim.text).slice(0, 280),
          evidenceIds: claim.evidenceIds || []
        });
        if (Number.isFinite(Number(claim.confidence))) current.confidences.push(Number(claim.confidence));
        signals.set(pattern.key, current);
      }
    }
  }

  return [...signals.values()].map((signal) => {
    const leadCount = signal.leadIds.size;
    const mentionCount = signal.claims.length;
    const coverageRatio = leadCount / total;
    const avgConfidence = average(signal.confidences) ?? 0.55;
    const confidence = clamp((coverageRatio * 0.50) + (Math.min(1, mentionCount / Math.max(1, total * 2)) * 0.20) + (avgConfidence * 0.30));
    const severity = signal.signalClass === 'missing_evidence'
      ? (coverageRatio >= 0.5 ? 'high' : 'medium')
      : signal.signalClass === 'regulatory_requirement'
        ? 'high'
        : confidence >= 0.72 ? 'high' : confidence >= 0.45 ? 'medium' : 'low';
    return {
      key: signal.key,
      label: signal.label,
      signalClass: signal.signalClass,
      severity,
      confidence,
      leadCount,
      mentionCount,
      totalLeads: total,
      coverageRatio: Number(coverageRatio.toFixed(4)),
      matchedTerms: [...signal.matchedTerms].slice(0, 12),
      evidenceLeadIds: [...signal.leadIds].slice(0, 12),
      evidenceIds: [...signal.evidenceIds].slice(0, 12),
      sourceUrls: [...signal.sourceUrls].slice(0, 8),
      exampleClaims: signal.claims.slice(0, 4),
      action: signal.action,
      source: 'lead_evidence_formation_permit_signal_ingestion'
    };
  }).sort((a, b) => {
    const classRank = { regulatory_requirement: 4, missing_evidence: 3, market_activity: 2, formation_evidence: 1, positive_evidence: 0 };
    return (classRank[b.signalClass] || 0) - (classRank[a.signalClass] || 0)
      || b.confidence - a.confidence
      || b.leadCount - a.leadCount
      || a.key.localeCompare(b.key);
  });
}

function summarizeFormationPermitSignals({ signals = [], totalLeads = 0, pack = null } = {}) {
  const covered = new Set();
  for (const signal of signals) {
    for (const id of signal.evidenceLeadIds || []) covered.add(id);
  }
  const denom = Math.max(1, Number(totalLeads) || 0);
  const signalKeys = new Set(signals.map((item) => item.key));
  const licenseSensitive = Boolean(pack?.compliance?.licenseVerification)
    || (Array.isArray(pack?.compliance?.restrictedClaims) && pack.compliance.restrictedClaims.some((claim) => /licen|insured|bond/i.test(claim)));
  const hasPositiveLicense = signalKeys.has('license_verified');
  const hasPermitRequirement = signalKeys.has('permit_requirement') || signalKeys.has('recent_permit_activity');
  const hasMissingLicense = signalKeys.has('license_claim_unverified') || (licenseSensitive && !hasPositiveLicense);
  const regulatoryRiskScore = clamp(
    (hasPermitRequirement ? 0.35 : 0) +
    (hasMissingLicense ? 0.35 : 0) +
    (licenseSensitive ? 0.20 : 0) -
    (hasPositiveLicense ? 0.15 : 0)
  );
  const evidenceRequired = [
    ...(hasMissingLicense ? ['license_lookup_evidence_required'] : []),
    ...(hasPermitRequirement ? ['permit_scope_review_required'] : []),
    ...(licenseSensitive ? ['regulated_claim_operator_review_required'] : []),
    ...(!signals.length ? ['formation_or_permit_source_evidence_required'] : [])
  ];
  return {
    totalSignals: signals.length,
    coveredLeadCount: covered.size,
    coveredLeadRatio: Number((covered.size / denom).toFixed(4)),
    topSignalKey: signals[0]?.key || null,
    positiveEvidenceKeys: signals.filter((item) => item.signalClass === 'positive_evidence').map((item) => item.key),
    missingEvidenceKeys: signals.filter((item) => item.signalClass === 'missing_evidence').map((item) => item.key),
    regulatoryRequirementKeys: signals.filter((item) => item.signalClass === 'regulatory_requirement').map((item) => item.key),
    marketActivityKeys: signals.filter((item) => item.signalClass === 'market_activity').map((item) => item.key),
    formationKeys: signals.filter((item) => item.signalClass === 'formation_evidence').map((item) => item.key),
    licenseSensitive,
    hasPositiveLicenseEvidence: hasPositiveLicense,
    regulatoryRiskScore,
    evidenceRequired: [...new Set(evidenceRequired)],
    assumptions: [
      'formation and permit signals are derived from stored lead source evidence and research_json only',
      'no live government registry, permit database, or contractor board lookup is performed in this local pass',
      'signals are internal risk and market-activity evidence, not public claims or fulfillment authorization'
    ],
    source: 'lead_evidence_formation_permit_signal_ingestion'
  };
}

function formationPermitClaimsForLead(lead = {}) {
  const profile = parsePortfolioJson(lead.research_json) || {};
  const intelligence = profile.leadIntelligence || profile.lead_intelligence || {};
  const candidates = [];
  const add = (items, source) => {
    for (const item of Array.isArray(items) ? items : []) {
      const text = claimText(item);
      if (!text) continue;
      candidates.push({
        text,
        source,
        sourceUrl: cleanText(item?.sourceUrl || item?.source_url || item?.url || lead.source_url) || null,
        evidenceIds: evidenceIdsFromClaim(item),
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null
      });
    }
  };
  add(profile.sourceEvidence, 'research_profile.source_evidence');
  add(intelligence.evidence, 'lead_intelligence.evidence');
  add(intelligence.positiveProof, 'lead_intelligence.positive_proof');
  add(profile.positiveProof, 'research_profile.positive_proof');
  add(intelligence.missingCustomerInfo, 'lead_intelligence.missing_customer_info');
  add(profile.missingCustomerInfo, 'research_profile.missing_customer_info');
  add(intelligence.currentWebsiteIssues, 'lead_intelligence.current_website_issues');
  add(profile.currentWebsiteIssues, 'research_profile.current_website_issues');
  add(profile.complianceFindings, 'research_profile.compliance_findings');
  add(profile.permitEvidence, 'research_profile.permit_evidence');
  add(profile.formationEvidence, 'research_profile.formation_evidence');
  for (const field of ['onlinePresenceSummary', 'leadRecommendation', 'summary']) {
    const text = cleanText(profile[field]);
    if (text) {
      candidates.push({
        text,
        source: `research_profile.${field}`,
        sourceUrl: cleanText(profile.sourceUrl || lead.source_url) || null,
        evidenceIds: [`lead:${lead.id}:${field}`],
        confidence: Number.isFinite(Number(profile.presenceConfidence)) ? Number(profile.presenceConfidence) : null
      });
    }
  }
  return candidates;
}

const LOCAL_SEASONALITY_MODELS = [
  {
    key: 'summer_cooling_ramp',
    label: 'Summer cooling ramp',
    verticalTerms: ['hvac', 'cooling', 'air conditioning', 'ac repair', 'ac'],
    activeMonths: [4, 5, 6, 7, 8],
    peakMonths: [5, 6, 7, 8],
    prePeakMonths: [3, 4],
    terms: ['summer', 'hot', 'heat', 'cooling', 'no ac', 'no-ac', 'air conditioning', 'ac repair', 'seasonal'],
    recommendedCampaign: 'Prepare AC emergency and same-day cooling pages before peak heat.'
  },
  {
    key: 'winter_heating_freeze',
    label: 'Winter heating and freeze',
    verticalTerms: ['hvac', 'heating', 'furnace', 'plumbing', 'plumber', 'drain'],
    activeMonths: [10, 11, 0, 1, 2],
    peakMonths: [11, 0, 1],
    prePeakMonths: [9, 10],
    terms: ['winter', 'freeze', 'frozen', 'no heat', 'furnace', 'heater', 'burst pipe', 'storm'],
    recommendedCampaign: 'Prepare no-heat, freeze, and burst-pipe response paths before cold spikes.'
  },
  {
    key: 'spring_maintenance',
    label: 'Spring maintenance',
    verticalTerms: ['hvac', 'plumbing', 'landscaping', 'cleaning'],
    activeMonths: [2, 3, 4],
    peakMonths: [3, 4],
    prePeakMonths: [1, 2],
    terms: ['maintenance', 'tune-up', 'tune up', 'spring', 'seasonal maintenance', 'inspection'],
    recommendedCampaign: 'Test maintenance and tune-up capture before urgent demand crowds channels.'
  },
  {
    key: 'holiday_local_services',
    label: 'Holiday local service demand',
    verticalTerms: ['restaurant', 'barber', 'salon', 'cleaning', 'photographer'],
    activeMonths: [10, 11, 0],
    peakMonths: [10, 11],
    prePeakMonths: [9],
    terms: ['holiday', 'party', 'event', 'gift', 'catering', 'reservation', 'wedding'],
    recommendedCampaign: 'Prepare holiday/event booking, hours, and review-proof surfaces.'
  }
];

function detectLocalSeasonality({ group, serviceUrgency = null, demandPressure = null, now = Date.now() } = {}) {
  const month = new Date(now).getUTCMonth();
  const monthName = new Date(Date.UTC(2026, month, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const pack = group?.pack || {};
  const verticalText = [
    group?.verticalKey,
    pack.key,
    pack.name,
    ...(Array.isArray(pack.matchNiches) ? pack.matchNiches : [])
  ].map(cleanText).join(' ').toLowerCase();
  const evidenceTexts = (group?.leads || []).map((lead) => ({
    id: `lead:${lead.id}`,
    text: [
      lead.business_name,
      lead.niche,
      lead.callable_reason,
      lead.source_url,
      lead.online_presence_strength,
      parsePortfolioJson(lead.research_json)?.onlinePresenceSummary
    ].map(cleanText).join(' ').toLowerCase()
  }));
  const packSeasonText = [
    ...(Array.isArray(pack.marketSignals) ? pack.marketSignals.map((signal) => `${signal.key || ''} ${signal.label || ''} ${signal.evidenceHint || ''}`) : []),
    ...(Array.isArray(pack.growthPaths) ? pack.growthPaths : []),
    ...(Array.isArray(pack.retentionLoops) ? pack.retentionLoops : []),
    ...(Array.isArray(pack.reviewStrategy) ? pack.reviewStrategy : []),
    pack.valuePropHook,
    pack.customerPersonaHint
  ].map(cleanText).join(' ').toLowerCase();

  const candidates = LOCAL_SEASONALITY_MODELS.map((model) => {
    const verticalMatch = model.verticalTerms.some((term) => verticalText.includes(term));
    const inPeak = model.peakMonths.includes(month);
    const inActive = model.activeMonths.includes(month);
    const prePeak = model.prePeakMonths.includes(month);
    const packTermHits = model.terms.filter((term) => packSeasonText.includes(term));
    const evidenceLeadIds = new Set();
    const leadTermHits = new Set();
    for (const leadEvidence of evidenceTexts) {
      for (const term of model.terms) {
        if (leadEvidence.text.includes(term)) {
          evidenceLeadIds.add(leadEvidence.id);
          leadTermHits.add(term);
        }
      }
    }
    const calendarScore = inPeak ? 0.48 : inActive ? 0.36 : prePeak ? 0.24 : 0;
    const evidenceScore = Math.min(0.28, ((packTermHits.length + leadTermHits.size) / 8) * 0.28);
    const verticalScore = verticalMatch ? 0.18 : 0;
    const pressureScore = Math.min(0.06, (Number(demandPressure?.pressureScore) || 0) * 0.06);
    const score = clamp(calendarScore + evidenceScore + verticalScore + pressureScore);
    return {
      ...model,
      score,
      verticalMatch,
      inPeak,
      inActive,
      prePeak,
      packTermHits,
      leadTermHits: [...leadTermHits],
      evidenceLeadIds: [...evidenceLeadIds]
    };
  }).sort((a, b) => b.score - a.score || Number(b.verticalMatch) - Number(a.verticalMatch));

  const top = candidates[0] || null;
  const seasonalityClass = top?.score >= 0.70
    ? (top.inPeak ? 'peak_season' : top.inActive ? 'in_season' : 'evidence_driven')
    : top?.score >= 0.45
      ? (top.prePeak ? 'pre_peak' : 'watch_season')
      : 'off_season';
  const demandMultiplier = Number((1 + Math.min(0.85, (top?.score || 0) * 0.85)).toFixed(2));
  const evidenceRequired = [
    ...((top?.score || 0) < 0.45 ? ['seasonal_demand_evidence_required'] : []),
    ...(top?.inPeak || top?.inActive || top?.prePeak ? [] : ['calendar_window_review_required']),
    ...(serviceUrgency?.urgencyClass === 'emergency_first' && !top?.evidenceLeadIds?.length ? ['urgent_seasonal_claim_evidence_required'] : [])
  ];
  return {
    seasonalityClass,
    seasonalWindowKey: top?.key || 'unknown',
    label: top?.label || 'Unknown seasonal window',
    month,
    monthName,
    activeMonths: top?.activeMonths || [],
    peakMonths: top?.peakMonths || [],
    prePeakMonths: top?.prePeakMonths || [],
    demandMultiplier,
    seasonalPressureScore: top?.score || 0,
    calendarAlignment: top ? {
      inPeak: top.inPeak,
      inActive: top.inActive,
      prePeak: top.prePeak,
      verticalMatch: top.verticalMatch
    } : null,
    matchedTerms: [...new Set([...(top?.packTermHits || []), ...(top?.leadTermHits || [])])].slice(0, 12),
    evidenceLeadIds: (top?.evidenceLeadIds || []).slice(0, 12),
    recommendedCampaign: top?.recommendedCampaign || 'Hold seasonal claims until evidence improves.',
    evidenceRequired: [...new Set(evidenceRequired)],
    assumptions: [
      'seasonality is inferred from current month, vertical pack signals, growth paths, retention loops, and stored lead evidence',
      'no live weather, ad auction, SERP, or external demand feed is queried in this local pass',
      'seasonal multipliers guide internal prioritization and must not become public urgency claims without proof'
    ],
    source: 'lead_evidence_local_seasonality_model'
  };
}

const AD_SATURATION_FATIGUE_PATTERNS = [
  {
    key: 'paid_ad_density',
    label: 'Paid ad density',
    signalClass: 'ad_saturation',
    terms: ['sponsored', 'paid ad', 'paid ads', 'google ads', 'ppc', 'local services ad', 'lsa', 'ad pack', 'multiple ads', 'crowded ads', 'search ads'],
    guidance: 'Avoid matching spend-for-spend until ad ownership and live smoke evidence exist; bias toward owned SEO, missed-call rescue, and proof surfaces.'
  },
  {
    key: 'aggregator_crowding',
    label: 'Aggregator and directory crowding',
    signalClass: 'ad_saturation',
    terms: ['angi', 'homeadvisor', 'thumbtack', 'yelp ads', 'lead aggregator', 'directory ads', 'marketplace listing', 'comparison site'],
    guidance: 'Differentiate away from commodity marketplace comparisons with local proof, transparent scope, and first-party capture.'
  },
  {
    key: 'discount_offer_fatigue',
    label: 'Discount and coupon fatigue',
    signalClass: 'offer_fatigue',
    terms: ['coupon', 'discount', 'promo', 'promotion', 'deal', 'special offer', '$ off', 'percent off', '% off', 'groupon', 'cheap'],
    guidance: 'Do not lead with deeper discounts; test trust, speed, availability, and transparent diagnostic framing first.'
  },
  {
    key: 'generic_claim_fatigue',
    label: 'Generic emergency or best-in-market claims',
    signalClass: 'offer_fatigue',
    terms: ['best in town', 'number one', '#1', 'guaranteed', 'guarantee', '24/7', '24 7', 'same day', 'same-day', 'fast response', 'emergency service'],
    guidance: 'Replace generic urgency claims with operator-reviewed proof, response boundaries, and conservative service-area copy.'
  },
  {
    key: 'trust_claim_fatigue',
    label: 'Trust proof fatigue',
    signalClass: 'trust_fatigue',
    terms: ['fake review', 'review gate', 'too many claims', 'unverified reviews', 'scam', 'not licensed', 'unverified guarantee', 'stock photos'],
    guidance: 'Lead with source-backed trust proof, license/insurance boundaries, and review-safe claims before any promotional offer.'
  }
];

function detectAdSaturationOfferFatigue({
  group,
  demandPressure = null,
  searchIntentCapture = null,
  localSeasonality = null
} = {}) {
  const total = Math.max(1, group?.leads?.length || 0);
  const signals = new Map();
  for (const lead of group?.leads || []) {
    const claims = adSaturationFatigueClaimsForLead(lead);
    for (const claim of claims) {
      const text = cleanText(claim.text).toLowerCase();
      if (!text) continue;
      for (const pattern of AD_SATURATION_FATIGUE_PATTERNS) {
        const matchedTerms = pattern.terms.filter((term) => text.includes(term));
        if (!matchedTerms.length) continue;
        const current = signals.get(pattern.key) || {
          key: pattern.key,
          label: pattern.label,
          signalClass: pattern.signalClass,
          guidance: pattern.guidance,
          leadIds: new Set(),
          evidenceIds: new Set(),
          sourceUrls: new Set(),
          claims: [],
          confidences: [],
          matchedTerms: new Set()
        };
        current.leadIds.add(`lead:${lead.id}`);
        for (const id of claim.evidenceIds || []) current.evidenceIds.add(id);
        if (claim.sourceUrl) current.sourceUrls.add(claim.sourceUrl);
        for (const term of matchedTerms) current.matchedTerms.add(term);
        current.claims.push({
          leadId: `lead:${lead.id}`,
          businessName: cleanText(lead.business_name),
          source: claim.source,
          sourceUrl: claim.sourceUrl || cleanText(lead.source_url) || null,
          summary: cleanText(claim.text).slice(0, 280),
          evidenceIds: claim.evidenceIds || []
        });
        if (Number.isFinite(Number(claim.confidence))) current.confidences.push(Number(claim.confidence));
        signals.set(pattern.key, current);
      }
    }
  }

  const pressureBoost = ['elevated', 'high'].includes(demandPressure?.pressureLevel) ? 0.06 : 0;
  const intentBoost = Math.min(0.08, (Number(searchIntentCapture?.capturedIntentScore) || 0) * 0.08);
  const seasonalBoost = Math.min(0.05, (Number(localSeasonality?.seasonalPressureScore) || 0) * 0.05);
  const signalList = [...signals.values()].map((signal) => {
    const leadCount = signal.leadIds.size;
    const mentionCount = signal.claims.length;
    const coverageRatio = leadCount / total;
    const avgConfidence = average(signal.confidences) ?? 0.55;
    const classBoost = signal.signalClass === 'ad_saturation'
      ? intentBoost + pressureBoost
      : signal.signalClass === 'offer_fatigue'
        ? pressureBoost + seasonalBoost
        : Math.max(intentBoost, seasonalBoost);
    const score = clamp(
      (coverageRatio * 0.45) +
      (Math.min(1, mentionCount / Math.max(1, total * 2)) * 0.20) +
      (avgConfidence * 0.20) +
      classBoost
    );
    const severity = score >= 0.72 ? 'high' : score >= 0.45 ? 'medium' : 'low';
    return {
      key: signal.key,
      label: signal.label,
      signalClass: signal.signalClass,
      severity,
      score,
      leadCount,
      mentionCount,
      totalLeads: total,
      coverageRatio: Number(coverageRatio.toFixed(4)),
      matchedTerms: [...signal.matchedTerms].slice(0, 12),
      evidenceLeadIds: [...signal.leadIds].slice(0, 12),
      evidenceIds: [...signal.evidenceIds].slice(0, 12),
      sourceUrls: [...signal.sourceUrls].slice(0, 8),
      exampleClaims: signal.claims.slice(0, 4),
      guidance: signal.guidance,
      source: 'lead_evidence_ad_saturation_offer_fatigue_detection'
    };
  }).sort((a, b) => b.score - a.score || b.leadCount - a.leadCount || a.key.localeCompare(b.key));

  const saturationSignals = signalList.filter((item) => item.signalClass === 'ad_saturation');
  const fatigueSignals = signalList.filter((item) => item.signalClass === 'offer_fatigue' || item.signalClass === 'trust_fatigue');
  const saturationScore = clamp(
    (Math.max(0, ...saturationSignals.map((item) => item.score)) * 0.70) +
    (Math.min(1, saturationSignals.reduce((sum, item) => sum + item.coverageRatio, 0)) * 0.20) +
    intentBoost
  );
  const fatigueScore = clamp(
    (Math.max(0, ...fatigueSignals.map((item) => item.score)) * 0.70) +
    (Math.min(1, fatigueSignals.reduce((sum, item) => sum + item.coverageRatio, 0)) * 0.20) +
    seasonalBoost
  );
  const compositeScore = clamp((saturationScore * 0.50) + (fatigueScore * 0.45) + pressureBoost);
  const saturationLevel = scoreLevel(saturationScore);
  const fatigueLevel = scoreLevel(fatigueScore);
  const evidenceLeadIds = [...new Set(signalList.flatMap((item) => item.evidenceLeadIds || []))].slice(0, 12);
  const evidenceRequired = [
    ...(!signalList.length ? ['ad_saturation_source_evidence_required'] : []),
    ...(saturationLevel === 'high' && !saturationSignals.length ? ['paid_channel_competitor_evidence_required'] : []),
    ...(['elevated', 'high'].includes(fatigueLevel) ? ['offer_positioning_operator_review_required'] : []),
    ...(searchIntentCapture?.intentClass === 'urgent_local_search' ? ['urgent_offer_claim_review_required'] : [])
  ];
  const recommendedPositioning = fatigueLevel === 'high' || saturationLevel === 'high'
    ? 'proof_first_trust_and_response_boundaries'
    : saturationLevel === 'elevated'
      ? 'owned_capture_before_paid_channel_spend'
      : 'measured_local_offer_test';
  return {
    saturationLevel,
    fatigueLevel,
    saturationScore,
    fatigueScore,
    compositeScore,
    signals: signalList,
    signalKeys: signalList.map((item) => item.key),
    saturationSignalKeys: saturationSignals.map((item) => item.key),
    fatigueSignalKeys: fatigueSignals.map((item) => item.key),
    topSignalKey: signalList[0]?.key || null,
    coveredLeadCount: evidenceLeadIds.length,
    coveredLeadRatio: Number((evidenceLeadIds.length / total).toFixed(4)),
    evidenceClaimCount: signalList.reduce((sum, item) => sum + (item.mentionCount || 0), 0),
    evidenceLeadIds,
    recommendedPositioning,
    channelGuidance: signalList[0]?.guidance || 'Collect paid-channel and offer evidence before treating ad saturation as a market fact.',
    evidenceRequired: [...new Set(evidenceRequired)],
    assumptions: [
      'ad saturation and offer fatigue are inferred from stored lead research_json, lead notes, and local market evidence only',
      'no live ad-library, SERP, auction, social-ad, or keyword-volume provider is queried in this local pass',
      'fatigue signals guide internal positioning and must not become public competitor claims without operator-reviewed evidence'
    ],
    inputs: {
      pressureLevel: demandPressure?.pressureLevel || null,
      searchIntentClass: searchIntentCapture?.intentClass || null,
      capturedIntentScore: searchIntentCapture?.capturedIntentScore || 0,
      seasonalWindowKey: localSeasonality?.seasonalWindowKey || null,
      seasonalPressureScore: localSeasonality?.seasonalPressureScore || 0
    },
    source: 'lead_evidence_ad_saturation_offer_fatigue_detection'
  };
}

function adSaturationFatigueClaimsForLead(lead = {}) {
  const profile = parsePortfolioJson(lead.research_json) || {};
  const intelligence = profile.leadIntelligence || profile.lead_intelligence || {};
  const candidates = [];
  const add = (items, source) => {
    for (const item of Array.isArray(items) ? items : []) {
      const text = claimText(item);
      if (!text) continue;
      candidates.push({
        text,
        source,
        sourceUrl: cleanText(item?.sourceUrl || item?.source_url || item?.url || lead.source_url) || null,
        evidenceIds: evidenceIdsFromClaim(item),
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null
      });
    }
  };
  add(profile.adEvidence, 'research_profile.ad_evidence');
  add(profile.paidSearchEvidence, 'research_profile.paid_search_evidence');
  add(profile.searchResultsEvidence, 'research_profile.search_results_evidence');
  add(profile.offerEvidence, 'research_profile.offer_evidence');
  add(profile.competitorAds, 'research_profile.competitor_ads');
  add(profile.promotions, 'research_profile.promotions');
  add(profile.pricingEvidence, 'research_profile.pricing_evidence');
  add(intelligence.adObservations, 'lead_intelligence.ad_observations');
  add(intelligence.competitorAds, 'lead_intelligence.competitor_ads');
  add(intelligence.offerEvidence, 'lead_intelligence.offer_evidence');
  add(intelligence.promotions, 'lead_intelligence.promotions');
  add(intelligence.complaintsPainPoints, 'lead_intelligence.complaints_pain_points');
  add(intelligence.currentWebsiteIssues, 'lead_intelligence.current_website_issues');
  add(profile.complaintsPainPoints, 'research_profile.complaints_pain_points');
  add(profile.currentWebsiteIssues, 'research_profile.current_website_issues');
  for (const field of ['onlinePresenceSummary', 'leadRecommendation', 'summary']) {
    const text = cleanText(profile[field]);
    if (text) {
      candidates.push({
        text,
        source: `research_profile.${field}`,
        sourceUrl: cleanText(profile.sourceUrl || lead.source_url) || null,
        evidenceIds: [`lead:${lead.id}:${field}`],
        confidence: Number.isFinite(Number(profile.presenceConfidence)) ? Number(profile.presenceConfidence) : null
      });
    }
  }
  for (const field of ['callable_reason', 'blocked_reason']) {
    const text = cleanText(lead[field]);
    if (text) {
      candidates.push({
        text,
        source: `lead.${field}`,
        sourceUrl: cleanText(lead.source_url) || null,
        evidenceIds: [`lead:${lead.id}:${field}`],
        confidence: Number.isFinite(Number(lead.presence_confidence)) ? Number(lead.presence_confidence) : null
      });
    }
  }
  return candidates;
}

function scoreLevel(score) {
  const value = Number(score) || 0;
  if (value >= 0.68) return 'high';
  if (value >= 0.45) return 'elevated';
  if (value >= 0.24) return 'moderate';
  return 'low';
}

function buildCityDemandMap({
  group,
  serviceUrgency = null,
  demandPressure = null,
  localSeasonality = null,
  adSaturationOfferFatigue = null
} = {}) {
  const leads = Array.isArray(group?.leads) ? group.leads : [];
  const total = Math.max(1, leads.length);
  const buckets = new Map();
  for (const lead of leads) {
    const neighborhood = inferLeadNeighborhood(lead, group?.city);
    const key = cleanKey(neighborhood.label || neighborhood.key || 'citywide');
    const current = buckets.get(key) || {
      key,
      label: neighborhood.label || formatNeighborhoodLabel(key),
      basis: neighborhood.basis,
      leads: [],
      evidenceLeadIds: new Set(),
      sourceUrls: new Set(),
      niches: new Set(),
      confidences: [],
      leadScores: []
    };
    const confidence = Number.isFinite(Number(lead.presence_confidence)) ? Number(lead.presence_confidence) : 0.5;
    const weakPresence = ['weak', 'missing', 'thin'].includes(String(lead.online_presence_strength || '').toLowerCase()) ? 0.16 : 0.04;
    const callable = ['callable', 'qualified'].includes(String(lead.risk_status || '').toLowerCase()) || cleanText(lead.phone) ? 0.14 : 0.02;
    const noWebsite = !cleanText(lead.website) || cleanText(lead.website).toLowerCase() === 'null' ? 0.10 : 0.02;
    const urgency = Math.min(0.16, (Number(serviceUrgency?.urgencyScore) || 0) * 0.16);
    const pressure = Math.min(0.14, (Number(demandPressure?.pressureScore) || 0) * 0.14);
    const season = Math.min(0.08, (Number(localSeasonality?.seasonalPressureScore) || 0) * 0.08);
    const adFatigue = Math.min(0.06, (Number(adSaturationOfferFatigue?.compositeScore) || 0) * 0.06);
    const leadScore = clamp(weakPresence + callable + noWebsite + (confidence * 0.20) + urgency + pressure + season + adFatigue);
    current.leads.push({
      id: `lead:${lead.id}`,
      businessName: cleanText(lead.business_name),
      address: cleanText(lead.address),
      sourceUrl: cleanText(lead.source_url) || null,
      score: Number(leadScore.toFixed(4)),
      confidence
    });
    current.evidenceLeadIds.add(`lead:${lead.id}`);
    if (cleanText(lead.source_url)) current.sourceUrls.add(cleanText(lead.source_url));
    if (cleanText(lead.niche)) current.niches.add(cleanText(lead.niche));
    current.confidences.push(confidence);
    current.leadScores.push(leadScore);
    buckets.set(key, current);
  }

  const hotspots = [...buckets.values()].map((bucket) => {
    const leadCount = bucket.leads.length;
    const leadShare = leadCount / total;
    const averageLeadScore = average(bucket.leadScores) ?? 0;
    const avgConfidence = average(bucket.confidences) ?? 0.5;
    const hotspotScore = clamp((averageLeadScore * 0.65) + (leadShare * 0.25) + (avgConfidence * 0.10));
    return {
      key: bucket.key,
      label: bucket.label,
      basis: bucket.basis,
      demandClass: scoreLevel(hotspotScore),
      hotspotScore: Number(hotspotScore.toFixed(4)),
      leadCount,
      leadShare: Number(leadShare.toFixed(4)),
      averageLeadScore: Number(averageLeadScore.toFixed(4)),
      averageConfidence: Number(avgConfidence.toFixed(4)),
      representativeNiches: [...bucket.niches].slice(0, 6),
      evidenceLeadIds: [...bucket.evidenceLeadIds].slice(0, 12),
      sourceUrls: [...bucket.sourceUrls].slice(0, 8),
      exampleLeads: bucket.leads.slice(0, 4),
      source: 'lead_evidence_city_neighborhood_demand_map'
    };
  }).sort((a, b) => b.hotspotScore - a.hotspotScore || b.leadCount - a.leadCount || a.key.localeCompare(b.key));

  const mappedLeadCount = hotspots.reduce((sum, item) => sum + item.leadCount, 0);
  const mappedLeadRatio = Number((mappedLeadCount / total).toFixed(4));
  return {
    city: cleanText(group?.city),
    verticalKey: cleanKey(group?.verticalKey || group?.pack?.key || 'default'),
    totalLeads: leads.length,
    mappedLeadCount,
    mappedLeadRatio,
    neighborhoodCount: hotspots.length,
    hotspotCount: hotspots.filter((item) => ['high', 'elevated'].includes(item.demandClass)).length,
    topNeighborhoodKey: hotspots[0]?.key || null,
    topNeighborhoodLabel: hotspots[0]?.label || null,
    topHotspotScore: hotspots[0]?.hotspotScore || 0,
    hotspots,
    evidenceRequired: [
      ...(hotspots.length ? [] : ['neighborhood_or_address_evidence_required']),
      ...(mappedLeadRatio < 0.8 ? ['more_neighborhood_coverage_required'] : [])
    ],
    assumptions: [
      'neighborhood demand is inferred from stored lead address, research_json location fields, and city-level evidence only',
      'hotspot scores combine lead weakness, callability, evidence confidence, urgency, demand pressure, seasonality, and ad-fatigue context',
      'no live maps, census, mobility, permit, weather, or external demand-feed provider is queried during this local pass'
    ],
    source: 'lead_evidence_city_neighborhood_demand_map'
  };
}

function inferLeadNeighborhood(lead = {}, city = '') {
  const profile = parsePortfolioJson(lead.research_json) || {};
  const intelligence = profile.leadIntelligence || profile.lead_intelligence || {};
  for (const [basis, value] of [
    ['research_profile.neighborhood', profile.neighborhood],
    ['research_profile.district', profile.district],
    ['research_profile.area', profile.area],
    ['research_profile.localArea', profile.localArea || profile.local_area],
    ['research_profile.serviceArea', profile.serviceArea || profile.service_area],
    ['lead_intelligence.neighborhood', intelligence.neighborhood],
    ['lead_intelligence.serviceArea', intelligence.serviceArea || intelligence.service_area]
  ]) {
    const text = cleanText(value);
    if (text) return { key: cleanKey(text), label: text, basis };
  }
  const address = cleanText(lead.address);
  const inferred = inferNeighborhoodFromAddress(address);
  if (inferred) return inferred;
  const cityLabel = cleanText(city || lead.city);
  return {
    key: cityLabel ? `${cleanKey(cityLabel)}_citywide` : 'citywide',
    label: cityLabel ? `${cityLabel} citywide` : 'Citywide',
    basis: 'city_fallback'
  };
}

function inferNeighborhoodFromAddress(address) {
  if (!address) return null;
  const lower = address.toLowerCase();
  const patterns = [
    { regex: /apache\s+(?:blvd|boulevard)/i, label: 'Apache Boulevard corridor' },
    { regex: /mill\s+(?:ave|avenue)/i, label: 'Mill Avenue corridor' },
    { regex: /university\s+(?:dr|drive|ave|avenue)/i, label: 'University corridor' },
    { regex: /downtown/i, label: 'Downtown corridor' },
    { regex: /desert/i, label: 'Desert residential pocket' },
    { regex: /mesa|tempe|phoenix|scottsdale/i, label: address.replace(/^\d+\s+/, '').slice(0, 80) }
  ];
  const match = patterns.find((item) => item.regex.test(lower));
  if (match) return { key: cleanKey(match.label), label: match.label, basis: 'lead.address' };
  const street = address.replace(/^\d+\s+/, '').replace(/\b(?:st|street|rd|road|ave|avenue|blvd|boulevard|dr|drive|way|lane|ln)\b\.?/gi, '').trim();
  if (street) {
    const label = `${street.slice(0, 60)} area`;
    return { key: cleanKey(label), label, basis: 'lead.address' };
  }
  return null;
}

function formatNeighborhoodLabel(key) {
  return cleanText(String(key || '').replace(/_/g, ' ')) || 'Citywide';
}

function inferPricingMarginFromLeadEvidence({
  group,
  packPriceCents = 50000,
  fulfillmentCostCents = null,
  targetGrossMarginPct = 35
} = {}) {
  const leads = Array.isArray(group?.leads) ? group.leads : [];
  const claims = leads.flatMap((lead) => pricingClaimsForLead(lead).map((claim) => ({ ...claim, lead })));
  const observedPrices = [];
  const diagnosticFees = [];
  const evidenceLeadIds = new Set();
  const evidenceIds = new Set();
  const sourceUrls = new Set();
  const confidences = [];
  for (const claim of claims) {
    const text = cleanText(claim.text);
    if (!text) continue;
    const prices = extractPriceCents(text);
    if (!prices.length) continue;
    for (const id of claim.evidenceIds || []) evidenceIds.add(id);
    if (claim.sourceUrl) sourceUrls.add(claim.sourceUrl);
    evidenceLeadIds.add(`lead:${claim.lead.id}`);
    if (Number.isFinite(Number(claim.confidence))) confidences.push(Number(claim.confidence));
    for (const cents of prices) {
      const kind = classifyObservedPrice(text, cents);
      const row = {
        cents,
        kind,
        leadId: `lead:${claim.lead.id}`,
        businessName: cleanText(claim.lead.business_name),
        source: claim.source,
        sourceUrl: claim.sourceUrl || cleanText(claim.lead.source_url) || null,
        evidenceIds: claim.evidenceIds || [],
        summary: text.slice(0, 220)
      };
      if (kind === 'diagnostic_fee') diagnosticFees.push(row);
      else observedPrices.push(row);
    }
  }
  const servicePrices = observedPrices.map((item) => item.cents).filter((value) => Number.isFinite(value) && value > 0);
  const fallbackPrice = Math.max(0, Number(packPriceCents) || 50000);
  const representativePriceCents = servicePrices.length ? median(servicePrices) : fallbackPrice;
  const minObservedPriceCents = servicePrices.length ? Math.min(...servicePrices) : fallbackPrice;
  const maxObservedPriceCents = servicePrices.length ? Math.max(...servicePrices) : fallbackPrice;
  const spreadRatio = representativePriceCents
    ? Number(((maxObservedPriceCents - minObservedPriceCents) / representativePriceCents).toFixed(4))
    : 0;
  const fulfillment = Number.isFinite(Number(fulfillmentCostCents)) ? Number(fulfillmentCostCents) : null;
  const estimatedGrossMarginCents = fulfillment !== null ? Math.max(0, representativePriceCents - fulfillment) : null;
  const estimatedGrossMarginPct = representativePriceCents && estimatedGrossMarginCents !== null
    ? Number((estimatedGrossMarginCents / representativePriceCents).toFixed(4))
    : Number(((Number(targetGrossMarginPct) || 35) / 100).toFixed(4));
  const coverageRatio = leads.length ? evidenceLeadIds.size / leads.length : 0;
  const avgConfidence = average(confidences) ?? 0.55;
  const confidence = Number(clamp(
    0.28 +
    (coverageRatio * 0.28) +
    (Math.min(1, servicePrices.length / Math.max(1, leads.length)) * 0.22) +
    (avgConfidence * 0.18) -
    Math.min(0.12, spreadRatio * 0.20)
  ).toFixed(4));
  return {
    representativePriceCents,
    packPriceCents: fallbackPrice,
    priceSource: servicePrices.length ? 'observed_lead_pricing_evidence' : 'vertical_pack_fallback',
    observedServicePriceCents: [...new Set(servicePrices)].sort((a, b) => a - b),
    observedDiagnosticFeeCents: [...new Set(diagnosticFees.map((item) => item.cents))].sort((a, b) => a - b),
    minObservedPriceCents,
    maxObservedPriceCents,
    observedPriceSpreadRatio: spreadRatio,
    estimatedFulfillmentCostCents: fulfillment,
    estimatedGrossMarginCents,
    estimatedGrossMarginPct,
    targetGrossMarginPct: Number(((Number(targetGrossMarginPct) || 35) / 100).toFixed(4)),
    evidencePriceCount: servicePrices.length,
    diagnosticFeeCount: diagnosticFees.length,
    evidenceLeadIds: [...evidenceLeadIds].slice(0, 12),
    evidenceIds: [...evidenceIds].slice(0, 12),
    sourceUrls: [...sourceUrls].slice(0, 8),
    examplePrices: [...observedPrices, ...diagnosticFees].slice(0, 6),
    confidence,
    evidenceRequired: [
      ...(servicePrices.length ? [] : ['pricing_evidence_required']),
      ...(coverageRatio < 0.5 ? ['more_pricing_source_coverage_required'] : []),
      ...(spreadRatio > 0.5 ? ['wide_price_spread_operator_review_required'] : [])
    ],
    assumptions: [
      'pricing and margin inference uses stored lead research_json, pricing/offer evidence, and vertical-pack margin models only',
      'diagnostic fees, coupons, and tune-up promos are separated from representative service-ticket prices when possible',
      'no live quote calls, payment provider, ad platform, or external pricing feed is queried during this local pass'
    ],
    source: 'lead_evidence_pricing_margin_inference'
  };
}

function pricingClaimsForLead(lead = {}) {
  const profile = parsePortfolioJson(lead.research_json) || {};
  const intelligence = profile.leadIntelligence || profile.lead_intelligence || {};
  const candidates = [];
  const add = (items, source) => {
    for (const item of Array.isArray(items) ? items : []) {
      const text = claimText(item);
      if (!text) continue;
      candidates.push({
        text,
        source,
        sourceUrl: cleanText(item?.sourceUrl || item?.source_url || item?.url || lead.source_url) || null,
        evidenceIds: evidenceIdsFromClaim(item),
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null
      });
    }
  };
  add(profile.pricingEvidence, 'research_profile.pricing_evidence');
  add(profile.offerEvidence, 'research_profile.offer_evidence');
  add(profile.promotions, 'research_profile.promotions');
  add(profile.servicePricing, 'research_profile.service_pricing');
  add(intelligence.pricingEvidence, 'lead_intelligence.pricing_evidence');
  add(intelligence.offerEvidence, 'lead_intelligence.offer_evidence');
  add(intelligence.promotions, 'lead_intelligence.promotions');
  add(intelligence.complaintsPainPoints, 'lead_intelligence.complaints_pain_points');
  for (const field of ['onlinePresenceSummary', 'leadRecommendation', 'summary']) {
    const text = cleanText(profile[field]);
    if (text) {
      candidates.push({
        text,
        source: `research_profile.${field}`,
        sourceUrl: cleanText(profile.sourceUrl || lead.source_url) || null,
        evidenceIds: [`lead:${lead.id}:${field}`],
        confidence: Number.isFinite(Number(profile.presenceConfidence)) ? Number(profile.presenceConfidence) : null
      });
    }
  }
  return candidates;
}

function extractPriceCents(text) {
  const prices = [];
  const regex = /(?:\$|usd\s*)(\d{2,5}(?:,\d{3})?(?:\.\d{2})?)/gi;
  let match;
  while ((match = regex.exec(text))) {
    const raw = Number(String(match[1]).replace(/,/g, ''));
    if (Number.isFinite(raw) && raw > 0) prices.push(Math.round(raw * 100));
  }
  return prices;
}

function classifyObservedPrice(text, cents) {
  const lower = cleanText(text).toLowerCase();
  if (cents < 15000) return 'diagnostic_fee';
  if (/(diagnostic|service call|dispatch|tune.?up|coupon|promo|promotion|deal|discount|cheap)/i.test(lower) && cents < 25000) {
    return 'diagnostic_fee';
  }
  return 'service_ticket';
}

function buildNeighborhoodLaunchPlan({
  group,
  cityDemandMap = null,
  searchIntentCapture = null,
  ownerResponsiveness = null,
  pricingMarginInference = null,
  marketSizing = null,
  serviceUrgency = null,
  demandPressure = null
} = {}) {
  const hotspots = Array.isArray(cityDemandMap?.hotspots) ? cityDemandMap.hotspots : [];
  const selected = hotspots[0] || null;
  const priceCents = Math.max(0, Number(
    pricingMarginInference?.representativePriceCents
    || marketSizing?.representativeTicketCents
    || group?.pack?.marginModel?.basePriceCents
  ) || 0);
  const conversionRate = Number.isFinite(Number(marketSizing?.firstWaveConversionRate))
    ? Number(marketSizing.firstWaveConversionRate)
    : selected?.demandClass === 'high'
      ? 0.32
      : selected?.demandClass === 'elevated'
        ? 0.24
        : 0.14;
  const firstWaveLeadCount = selected
    ? Math.max(1, Math.round((Number(selected.leadCount) || 1) * Math.max(0.1, Math.min(1, conversionRate))))
    : 0;
  const estimatedFirstWaveRevenueCents = firstWaveLeadCount * priceCents;
  const motion = recommendedNeighborhoodMotion({
    searchIntentCapture,
    ownerResponsiveness,
    serviceUrgency
  });
  const proofRequirements = [
    'neighborhood_source_evidence',
    'service_area_copy_required',
    'operator_review_before_public_launch',
    ...(searchIntentCapture?.evidenceRequired || []),
    ...(ownerResponsiveness?.blockers || []),
    ...(pricingMarginInference?.evidenceRequired || []),
    ...(selected ? [] : ['neighborhood_hotspot_required'])
  ];
  const priorityScore = selected
    ? Number(clamp(
      (Number(selected.hotspotScore) * 0.48) +
      ((Number(searchIntentCapture?.capturedIntentScore) || 0) * 0.18) +
      ((Number(demandPressure?.pressureScore) || 0) * 0.14) +
      ((Number(pricingMarginInference?.confidence) || 0) * 0.10) +
      ((Number(ownerResponsiveness?.callableCoverageRatio) || 0) * 0.10)
    ).toFixed(4))
    : 0;
  return {
    selectedNeighborhoodKey: selected?.key || null,
    selectedNeighborhoodLabel: selected?.label || null,
    selectedDemandClass: selected?.demandClass || null,
    priorityScore,
    priorityClass: scoreLevel(priorityScore),
    recommendedMotion: motion,
    estimatedFirstWaveLeadCount: firstWaveLeadCount,
    estimatedFirstWaveRevenueCents,
    representativePriceCents: priceCents,
    sourceHotspotScore: selected?.hotspotScore || 0,
    selectedHotspot: selected ? {
      key: selected.key,
      label: selected.label,
      demandClass: selected.demandClass,
      hotspotScore: selected.hotspotScore,
      leadCount: selected.leadCount,
      leadShare: selected.leadShare
    } : null,
    evidenceLeadIds: selected?.evidenceLeadIds || [],
    sourceUrls: selected?.sourceUrls || [],
    proofRequirements: [...new Set(proofRequirements)].slice(0, 12),
    evidenceRequired: [...new Set(proofRequirements)].filter((item) => /required|review|evidence|blocker|proof/i.test(item)).slice(0, 12),
    launchRationale: selected
      ? `${selected.label} is the first neighborhood to test because it has ${selected.demandClass} local demand evidence and ${selected.leadCount} mapped lead${selected.leadCount === 1 ? '' : 's'}.`
      : 'No neighborhood launch plan is available until local demand-map evidence exists.',
    assumptions: [
      'neighborhood launch planning uses stored demand-map, pricing, intent, urgency, owner-responsiveness, and market-sizing evidence only',
      'estimated first-wave revenue is a local planning proxy, not a live forecast or committed budget',
      'the plan selects a first test neighborhood and motion without publishing externally or spending money'
    ],
    inputs: {
      city: cleanText(group?.city),
      verticalKey: cleanKey(group?.verticalKey || group?.pack?.key || 'default'),
      searchIntentClass: searchIntentCapture?.intentClass || null,
      urgencyClass: serviceUrgency?.urgencyClass || null,
      demandPressureLevel: demandPressure?.pressureLevel || null,
      responsivenessClass: ownerResponsiveness?.responsivenessClass || null
    },
    source: 'lead_evidence_neighborhood_launch_plan'
  };
}

function buildMarketRecommendationProvenance({
  group,
  evidence = [],
  score = 0,
  confidence = 0,
  decision = 'watch',
  weakRatio = 0,
  noWebsiteRatio = 0,
  callableRatio = 0,
  density = 0,
  avgConfidence = 0.5,
  exploitableWeaknessRatio = 0,
  competitorWeaknesses = [],
  serviceUrgency = null,
  demandPressure = null,
  marketSizing = null,
  ownerResponsiveness = null,
  searchIntentCapture = null,
  reviewComplaintSummary = null,
  formationPermitSummary = null,
  localSeasonality = null,
  adSaturationOfferFatigue = null,
  cityDemandMap = null,
  pricingMarginInference = null,
  neighborhoodLaunchPlan = null,
  marketRecommendationProvenance = null
} = {}) {
  const leads = Array.isArray(group?.leads) ? group.leads : [];
  const totalLeads = Math.max(1, leads.length);
  const leadIds = leads.map((lead) => `lead:${lead.id}`);
  const sourceUrls = new Set([
    ...leads.map((lead) => cleanText(lead.source_url)).filter(Boolean),
    ...evidence.map((item) => cleanText(item.sourceUrl)).filter(Boolean)
  ]);
  const refs = {
    evidenceLeadIds: new Set(evidence.map((item) => cleanText(item.id)).filter(Boolean)),
    evidenceIds: new Set(),
    sourceUrls
  };
  const sourceSignals = {
    competitorWeaknesses,
    serviceUrgency,
    demandPressure,
    marketSizing,
    ownerResponsiveness,
    searchIntentCapture,
    reviewComplaintSummary,
    formationPermitSummary,
    localSeasonality,
    adSaturationOfferFatigue,
    cityDemandMap,
    pricingMarginInference,
    neighborhoodLaunchPlan
  };
  for (const signal of Object.values(sourceSignals)) collectEvidenceRefs(signal, refs);

  const evidenceLeadCount = leadIds.filter((id) => refs.evidenceLeadIds.has(id)).length || evidence.length;
  const evidenceLeadRatio = Number(Math.min(1, evidenceLeadCount / totalLeads).toFixed(4));
  const sourceUrlCoverageRatio = Number((leads.filter((lead) => cleanText(lead.source_url)).length / totalLeads).toFixed(4));
  const pricingCoverageRatio = Number(((pricingMarginInference?.evidenceLeadIds?.length || 0) / totalLeads).toFixed(4));
  const modelCatalog = [
    ['lead_research', evidence.length > 0, evidence.length, 'stored lead research rows'],
    ['vertical_manifest', Boolean(group?.pack), group?.pack ? 1 : 0, 'vertical pack launch and margin rules'],
    ['competitor_weaknesses', competitorWeaknesses.length > 0, competitorWeaknesses.length, 'competitor weakness signals'],
    ['service_urgency', Boolean(serviceUrgency), serviceUrgency?.urgencyKeywords?.length || 0, 'urgency classifier'],
    ['demand_pressure', Boolean(demandPressure), demandPressure?.drivers?.length || 0, 'demand pressure drivers'],
    ['market_sizing', Boolean(marketSizing), marketSizing?.evidenceLeadIds?.length || 0, 'TAM/SAM/SOM estimate'],
    ['owner_responsiveness', Boolean(ownerResponsiveness), ownerResponsiveness?.evidenceLeadIds?.length || 0, 'owner response prediction'],
    ['search_intent', Boolean(searchIntentCapture), searchIntentCapture?.matchedIntentKeys?.length || 0, 'search intent capture'],
    ['review_complaints', Boolean(reviewComplaintSummary), reviewComplaintSummary?.totalClusters || 0, 'review complaint summary'],
    ['formation_permit', Boolean(formationPermitSummary), formationPermitSummary?.totalSignals || 0, 'formation and permit summary'],
    ['local_seasonality', Boolean(localSeasonality), localSeasonality?.matchedTerms?.length || 0, 'local seasonality model'],
    ['ad_saturation_offer_fatigue', Boolean(adSaturationOfferFatigue), adSaturationOfferFatigue?.signalKeys?.length || 0, 'ad saturation and offer fatigue'],
    ['city_demand_map', Boolean(cityDemandMap), cityDemandMap?.hotspots?.length || 0, 'city and neighborhood demand map'],
    ['pricing_margin', Boolean(pricingMarginInference), pricingMarginInference?.evidencePriceCount || 0, 'pricing and margin inference'],
    ['neighborhood_launch_plan', Boolean(neighborhoodLaunchPlan), neighborhoodLaunchPlan?.evidenceLeadIds?.length || 0, 'neighborhood launch plan']
  ];
  const sourceModels = modelCatalog
    .filter(([, present]) => present)
    .map(([key, , evidenceCount, label]) => ({
      key,
      label,
      evidenceCount: Number(evidenceCount) || 0
    }));
  const input = (key, label, value, weight, source, evidenceLeadIds = [], extra = {}) => {
    const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0;
    const contribution = Number((numericValue * weight).toFixed(4));
    return {
      key,
      label,
      value: Number(numericValue.toFixed(4)),
      weight,
      contribution,
      direction: contribution >= 0 ? 'supports_launch' : 'reduces_launch',
      source,
      evidenceLeadIds: [...new Set(evidenceLeadIds)].slice(0, 8),
      ...extra
    };
  };
  const weaknessEvidenceIds = [...new Set((competitorWeaknesses || []).flatMap((item) => item.evidenceLeadIds || []))];
  const decisionInputs = [
    input('weak_presence_ratio', 'weak online presence', weakRatio, 0.32, 'lead_research', weaknessEvidenceIds),
    input('no_website_ratio', 'missing websites', noWebsiteRatio, 0.18, 'lead_research', weaknessEvidenceIds),
    input('callable_ratio', 'callable owners', callableRatio, 0.15, 'lead_research', leadIds),
    input('lead_density', 'lead density', density, 0.15, 'lead_research', leadIds),
    input('presence_confidence', 'presence confidence', avgConfidence || 0.5, 0.15, 'lead_research', leadIds),
    input('competitor_weakness_ratio', 'competitor weakness overlap', exploitableWeaknessRatio, 0.10, 'lead_evidence_competitor_weakness_detection', weaknessEvidenceIds),
    input('demand_pressure_score', 'demand pressure', demandPressure?.pressureScore || 0, 0.06, 'lead_evidence_demand_pressure_detection', demandPressure?.evidenceLeadIds || []),
    input('search_intent_fit', 'search intent fit', searchIntentCapture?.capturedIntentScore || 0, 0.05, 'lead_evidence_search_intent_capture', searchIntentCapture?.evidenceLeadIds || []),
    input('pricing_confidence', 'pricing confidence', pricingMarginInference?.confidence || 0, 0.04, 'lead_evidence_pricing_margin_inference', pricingMarginInference?.evidenceLeadIds || []),
    input('neighborhood_launch_priority', 'neighborhood launch priority', neighborhoodLaunchPlan?.priorityScore || 0, 0.04, 'lead_evidence_neighborhood_launch_plan', neighborhoodLaunchPlan?.evidenceLeadIds || [])
  ].sort((a, b) => b.contribution - a.contribution);
  const evidenceRequired = [...new Set([
    ...(searchIntentCapture?.evidenceRequired || []),
    ...(reviewComplaintSummary?.evidenceRequired || []),
    ...(formationPermitSummary?.evidenceRequired || []),
    ...(localSeasonality?.evidenceRequired || []),
    ...(adSaturationOfferFatigue?.evidenceRequired || []),
    ...(cityDemandMap?.evidenceRequired || []),
    ...(pricingMarginInference?.evidenceRequired || []),
    ...(neighborhoodLaunchPlan?.evidenceRequired || []),
    ...(sourceUrlCoverageRatio < 0.75 ? ['source_url_coverage_required'] : [])
  ])].slice(0, 16);
  const explainabilityScore = Number(clamp(
    (evidenceLeadRatio * 0.20) +
    (sourceUrlCoverageRatio * 0.16) +
    ((Number(confidence) || 0) * 0.16) +
    (Math.min(1, sourceModels.length / 12) * 0.14) +
    ((Number(pricingMarginInference?.confidence) || 0) * 0.10) +
    ((Number(cityDemandMap?.mappedLeadRatio) || 0) * 0.08) +
    ((Number(searchIntentCapture?.capturedIntentScore) || 0) * 0.06) +
    ((Number(reviewComplaintSummary?.coveredLeadRatio) || 0) * 0.04) +
    ((Number(formationPermitSummary?.coveredLeadRatio) || 0) * 0.03) +
    ((Number(neighborhoodLaunchPlan?.priorityScore) || 0) * 0.03)
  ).toFixed(4));
  const topReasons = decisionInputs.slice(0, 6).map((item) => ({
    key: item.key,
    label: item.label,
    contribution: item.contribution,
    source: item.source,
    evidenceLeadIds: item.evidenceLeadIds
  }));
  return {
    city: cleanText(group?.city),
    verticalKey: cleanKey(group?.verticalKey || group?.pack?.key || 'default'),
    decision,
    score: Number((Number(score) || 0).toFixed(4)),
    confidence: Number((Number(confidence) || 0).toFixed(4)),
    explainabilityScore,
    explainabilityClass: scoreLevel(explainabilityScore),
    evidenceSummary: {
      totalLeads: leads.length,
      sourceEvidenceCount: evidence.length,
      distinctEvidenceLeadCount: [...refs.evidenceLeadIds].filter((id) => id.startsWith('lead:')).length,
      distinctEvidenceIdCount: refs.evidenceIds.size,
      distinctSourceUrlCount: refs.sourceUrls.size,
      sourceModelCount: sourceModels.length
    },
    coverage: {
      evidenceLeadRatio,
      sourceUrlCoverageRatio,
      pricingCoverageRatio,
      cityDemandMappedLeadRatio: cityDemandMap?.mappedLeadRatio ?? 0,
      searchIntentScore: searchIntentCapture?.capturedIntentScore ?? 0,
      complaintCoverageRatio: reviewComplaintSummary?.coveredLeadRatio ?? 0,
      formationPermitCoverageRatio: formationPermitSummary?.coveredLeadRatio ?? 0,
      neighborhoodLaunchPriorityScore: neighborhoodLaunchPlan?.priorityScore ?? 0
    },
    sourceModels,
    decisionInputs,
    topReasons,
    evidenceLeadIds: [...refs.evidenceLeadIds].filter((id) => id.startsWith('lead:')).slice(0, 16),
    evidenceIds: [...refs.evidenceIds].slice(0, 16),
    sourceUrls: [...refs.sourceUrls].slice(0, 12),
    evidenceRequired,
    evidenceChain: sourceModels.slice(0, 12).map((model) => ({
      step: model.key,
      label: model.label,
      evidenceCount: model.evidenceCount
    })),
    recommendationSummary: `${formatDecisionLabel(decision)} recommendation is explained by ${topReasons.slice(0, 3).map((item) => item.label).join(', ') || 'stored market evidence'}.`,
    assumptions: [
      'recommendation provenance links stored lead evidence, vertical-pack rules, derived market signals, pricing, and launch-plan signals',
      'contributions are deterministic audit metadata for explanation; they do not replace the launchability score',
      'no live scraping, provider lookup, ad platform, or external data feed is invoked while building this provenance ledger'
    ],
    source: 'lead_evidence_market_recommendation_provenance'
  };
}

function collectEvidenceRefs(value, refs, depth = 0) {
  if (!value || depth > 4) return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceRefs(item, refs, depth + 1);
    return refs;
  }
  if (typeof value !== 'object') return refs;
  if (Array.isArray(value.evidenceLeadIds)) {
    for (const id of value.evidenceLeadIds) if (cleanText(id)) refs.evidenceLeadIds.add(cleanText(id));
  }
  if (Array.isArray(value.evidenceIds)) {
    for (const id of value.evidenceIds) if (cleanText(id)) refs.evidenceIds.add(cleanText(id));
  }
  if (Array.isArray(value.sourceUrls)) {
    for (const url of value.sourceUrls) if (cleanText(url)) refs.sourceUrls.add(cleanText(url));
  }
  if (cleanText(value.sourceUrl)) refs.sourceUrls.add(cleanText(value.sourceUrl));
  if (cleanText(value.evidenceId)) refs.evidenceIds.add(cleanText(value.evidenceId));
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectEvidenceRefs(child, refs, depth + 1);
  }
  return refs;
}

function formatDecisionLabel(decision) {
  return cleanText(decision).replace(/_/g, ' ') || 'market';
}

function recommendedNeighborhoodMotion({ searchIntentCapture = null, ownerResponsiveness = null, serviceUrgency = null } = {}) {
  if (searchIntentCapture?.recommendedCaptureSurface) return searchIntentCapture.recommendedCaptureSurface;
  if (ownerResponsiveness?.recommendedAcquisitionMotion === 'call_ready') return 'call_ready_neighborhood_test';
  if (serviceUrgency?.urgencyClass === 'emergency_first') return 'emergency_service_area_landing_page';
  return 'owned_neighborhood_landing_page';
}

const URGENCY_LEXICON = {
  emergency_first: [
    'emergency', 'no heat', 'no-heat', 'no ac', 'no-ac', 'no cooling',
    'leak', 'leaking', 'flood', 'sewer backup', 'after hours', 'after-hours',
    '24/7', '24 7', 'midnight', 'late night', 'overnight', 'rescue',
    'dispatch', 'storm', 'freeze', 'gas leak', 'burst pipe'
  ],
  urgent_response: [
    'urgent', 'urgent_problem', 'repair', 'same day', 'same-day',
    'missed call', 'missed-call', 'callback', 'no callback', 'slow response',
    'fast response', 'response time', 'seasonal', 'water heater', 'drain',
    'furnace', 'ac repair', 'ac not cooling', 'unanswered phone',
    'urgent repair', 'emergency repair'
  ],
  planned_service: [
    'maintenance', 'tune-up', 'tune up', 'install', 'installation',
    'booking', 'appointment', 'schedule', 'photo', 'menu',
    'monthly', 'seasonal refresh', 'plan', 'retainer'
  ],
  discretionary: [
    'walk-in', 'walk in', 'dine-in', 'casual', 'browse', 'stroll', 'window-shop'
  ]
};

const URGENCY_PRIORITY = ['emergency_first', 'urgent_response', 'planned_service', 'discretionary'];

const URGENCY_CLASS_WEIGHTS = {
  emergency_first: 1.6,
  urgent_response: 1.0,
  planned_service: 0.8,
  discretionary: 0.6
};

const URGENCY_DEFAULT_REQUIREMENTS = {
  emergency_first: {
    responseExpectationMinutes: 60,
    requirements: [
      'after_hours_coverage_evidence',
      'tap_to_call_above_fold',
      'service_area_emergency_copy_approved'
    ]
  },
  urgent_response: {
    responseExpectationMinutes: 240,
    requirements: [
      'same_day_callback_path',
      'tap_to_call_above_fold',
      'response_time_claim_safety'
    ]
  },
  planned_service: {
    responseExpectationMinutes: 1440,
    requirements: [
      'booking_or_dm_path',
      'hours_and_location_visible'
    ]
  },
  discretionary: {
    responseExpectationMinutes: 2880,
    requirements: [
      'discovery_proof',
      'visit_intent_path'
    ]
  }
};

function detectServiceUrgency(group) {
  const total = Math.max(1, group.leads.length);
  const pack = group.pack || {};
  const packText = collectPackUrgencyText(pack);
  const leadTexts = group.leads.map((lead) => ({
    id: `lead:${lead.id}`,
    text: collectLeadUrgencyText(lead)
  }));
  const classHits = { emergency_first: 0, urgent_response: 0, planned_service: 0, discretionary: 0 };
  const keywordsByClass = { emergency_first: new Set(), urgent_response: new Set(), planned_service: new Set(), discretionary: new Set() };
  const evidenceByClass = { emergency_first: new Set(), urgent_response: new Set(), planned_service: new Set(), discretionary: new Set() };
  for (const className of URGENCY_PRIORITY) {
    const lexicon = URGENCY_LEXICON[className];
    for (const keyword of lexicon) {
      if (packText.includes(keyword)) {
        classHits[className] += 1;
        keywordsByClass[className].add(keyword);
      }
    }
    for (const { id, text } of leadTexts) {
      for (const keyword of lexicon) {
        if (text.includes(keyword)) {
          classHits[className] += 1;
          keywordsByClass[className].add(keyword);
          evidenceByClass[className].add(id);
        }
      }
    }
  }
  const classWeightedScores = {};
  for (const className of URGENCY_PRIORITY) {
    classWeightedScores[className] = Number((keywordsByClass[className].size * URGENCY_CLASS_WEIGHTS[className]).toFixed(4));
  }
  let urgencyClass = 'planned_service';
  let topScore = 0;
  for (const className of URGENCY_PRIORITY) {
    const score = classWeightedScores[className];
    if (score > topScore) {
      topScore = score;
      urgencyClass = className;
    } else if (score > 0 && score === topScore) {
      const currentIndex = URGENCY_PRIORITY.indexOf(urgencyClass);
      const candidateIndex = URGENCY_PRIORITY.indexOf(className);
      if (candidateIndex < currentIndex) urgencyClass = className;
    }
  }
  const distinctTop = keywordsByClass[urgencyClass].size;
  const urgencyScore = Number(Math.min(1, distinctTop / Math.max(4, total + 2)).toFixed(4));
  const requirements = URGENCY_DEFAULT_REQUIREMENTS[urgencyClass] || URGENCY_DEFAULT_REQUIREMENTS.planned_service;
  const packAlignment = (Array.isArray(pack.marketSignals) ? pack.marketSignals : []).filter((signal) => {
    const blob = `${cleanText(signal.key || '')} ${cleanText(signal.label || '')} ${cleanText(signal.evidenceHint || '')}`.toLowerCase();
    return URGENCY_LEXICON[urgencyClass].some((keyword) => blob.includes(keyword));
  }).map((signal) => ({
    key: cleanKey(signal.key || signal.label || 'pack_market_signal'),
    label: cleanText(signal.label || signal.key || ''),
    source: `vertical_pack:${pack.key || group.verticalKey}`
  }));
  const exploit = exploitForUrgencyClass(urgencyClass, pack, group);
  return {
    urgencyClass,
    urgencyScore,
    classScores: classWeightedScores,
    rawHits: {
      emergency_first: classHits.emergency_first,
      urgent_response: classHits.urgent_response,
      planned_service: classHits.planned_service,
      discretionary: classHits.discretionary
    },
    urgencyKeywords: Array.from(keywordsByClass[urgencyClass]).slice(0, 12),
    responseExpectationMinutes: requirements.responseExpectationMinutes,
    responseRequirements: requirements.requirements,
    evidenceLeadIds: Array.from(evidenceByClass[urgencyClass]).slice(0, 12),
    packAlignment,
    exploit,
    source: 'lead_evidence_service_urgency_detection'
  };
}

function detectMarketDemandPressure({
  group,
  competitorWeaknesses,
  serviceUrgency,
  weakRatio,
  noWebsiteRatio,
  callableRatio,
  density,
  exploitableWeaknessRatio
}) {
  const drivers = [];
  if (serviceUrgency.urgencyClass === 'emergency_first' || serviceUrgency.urgencyClass === 'urgent_response') {
    drivers.push({
      key: 'urgent_search_intent',
      label: 'Urgent search intent dominates evidence',
      weight: serviceUrgency.urgencyClass === 'emergency_first' ? 0.35 : 0.22,
      evidence: {
        urgencyClass: serviceUrgency.urgencyClass,
        urgencyScore: serviceUrgency.urgencyScore,
        keywordCount: serviceUrgency.urgencyKeywords.length
      },
      source: 'lead_evidence_service_urgency_detection'
    });
  }
  if (exploitableWeaknessRatio >= 0.5 && competitorWeaknesses.length >= 2) {
    drivers.push({
      key: 'exploitable_competitor_weakness_share',
      label: 'Most local competitors share an exploitable weakness',
      weight: Math.min(0.25, exploitableWeaknessRatio * 0.30),
      evidence: {
        weaknessCount: competitorWeaknesses.length,
        exploitableWeaknessRatio: Number(exploitableWeaknessRatio.toFixed(4))
      },
      source: 'lead_evidence_competitor_weakness_detection'
    });
  }
  if (noWebsiteRatio >= 0.4) {
    drivers.push({
      key: 'no_website_overlap',
      label: 'Multiple competitors have no public website',
      weight: Math.min(0.18, noWebsiteRatio * 0.20),
      evidence: { noWebsiteRatio: Number(noWebsiteRatio.toFixed(4)) },
      source: 'lead_evidence_competitor_weakness_detection'
    });
  }
  if (callableRatio <= 0.5) {
    drivers.push({
      key: 'callable_responder_gap',
      label: 'Few competitors are reliably callable',
      weight: Math.min(0.18, (1 - callableRatio) * 0.20),
      evidence: { callableRatio: Number(callableRatio.toFixed(4)) },
      source: 'lead_evidence_callable_signal'
    });
  } else if (callableRatio >= 0.9 && serviceUrgency.urgencyClass === 'emergency_first') {
    drivers.push({
      key: 'callable_responder_saturation',
      label: 'Callable supply meets emergency demand, sharpening differentiation pressure',
      weight: 0.08,
      evidence: { callableRatio: Number(callableRatio.toFixed(4)) },
      source: 'lead_evidence_callable_signal'
    });
  }
  if (density >= 0.6) {
    drivers.push({
      key: 'local_density',
      label: 'Lead density meets minimum local-market threshold',
      weight: Math.min(0.12, density * 0.15),
      evidence: { density: Number(density.toFixed(4)) },
      source: 'lead_evidence_density'
    });
  }
  if (weakRatio >= 0.6) {
    drivers.push({
      key: 'weak_presence_majority',
      label: 'Majority of leads have a weak online presence',
      weight: Math.min(0.16, weakRatio * 0.18),
      evidence: { weakRatio: Number(weakRatio.toFixed(4)) },
      source: 'lead_evidence_competitor_weakness_detection'
    });
  }
  const pack = group.pack || {};
  const growthPaths = Array.isArray(pack.growthPaths) ? pack.growthPaths : [];
  const urgentGrowthMatches = growthPaths.filter((path) => /missed.?call|emergency|rescue|response|after.?hours|seasonal/i.test(String(path || ''))).map((path) => cleanText(path));
  if (urgentGrowthMatches.length) {
    drivers.push({
      key: 'vertical_pack_urgent_growth_paths',
      label: 'Vertical pack lists urgency-aligned growth paths',
      weight: Math.min(0.10, urgentGrowthMatches.length * 0.04),
      evidence: { matchedGrowthPaths: urgentGrowthMatches.slice(0, 4) },
      source: `vertical_pack:${pack.key || group.verticalKey}`
    });
  }
  const pressureScore = clamp(drivers.reduce((sum, driver) => sum + (Number(driver.weight) || 0), 0));
  const pressureLevel = pressureScore >= 0.6 ? 'high' : pressureScore >= 0.4 ? 'elevated' : pressureScore >= 0.2 ? 'moderate' : 'low';
  const exploitationStrategy = exploitationStrategyFor({ pressureLevel, serviceUrgency, pack, group });
  return {
    pressureScore,
    pressureLevel,
    drivers,
    driverKeys: drivers.map((driver) => driver.key),
    exploitationStrategy,
    inputs: {
      weakRatio: Number(weakRatio.toFixed(4)),
      noWebsiteRatio: Number(noWebsiteRatio.toFixed(4)),
      callableRatio: Number(callableRatio.toFixed(4)),
      density: Number(density.toFixed(4)),
      exploitableWeaknessRatio: Number(exploitableWeaknessRatio.toFixed(4)),
      urgencyClass: serviceUrgency.urgencyClass
    },
    source: 'lead_evidence_demand_pressure_detection'
  };
}

const SEARCH_INTENT_PATTERNS = [
  { key: 'emergency_search', intentClass: 'urgent_local_search', weight: 0.26, regex: /(emergency|urgent|same.?day|after.?hours|24\/7|24 7|no ac|no heat|leak|burst|repair)/i },
  { key: 'tap_to_call_intent', intentClass: 'urgent_local_search', weight: 0.16, regex: /(tap.?to.?call|phone|call|callback|missed.?call|response time|giant.*number)/i },
  { key: 'service_area_intent', intentClass: 'category_comparison', weight: 0.14, regex: /(service area|near me|covers?|town|city|zip|category|contractor|directory|maps)/i },
  { key: 'brand_validation_intent', intentClass: 'brand_validation', weight: 0.12, regex: /(google your name|legitimacy|owned page|business listing|public listing|trust proof|review proof)/i },
  { key: 'booking_or_menu_intent', intentClass: 'booking_or_menu_intent', weight: 0.12, regex: /(booking|appointment|menu|order|hours|reservation|schedule)/i },
  { key: 'proof_discovery_intent', intentClass: 'proof_discovery', weight: 0.10, regex: /(photo|portfolio|reviews?|before.?after|proof|instagram|gallery)/i }
];

function detectSearchIntentCapture({
  group,
  serviceUrgency,
  demandPressure,
  competitorWeaknesses,
  noWebsiteRatio,
  weakRatio
}) {
  const total = group.leads.length;
  const pack = group.pack || {};
  const sourceCoverageRatio = total
    ? group.leads.filter((lead) => cleanText(lead.source_url)).length / total
    : 0;
  const matchedIntentKeys = new Set();
  const classWeights = new Map();
  const evidenceByKey = new Map();
  const leadTexts = group.leads.map((lead) => ({
    id: `lead:${lead.id}`,
    text: [
      lead.niche,
      lead.business_name,
      lead.callable_reason,
      lead.source_url,
      lead.online_presence_strength
    ].map((value) => cleanText(value)).join(' ')
  }));
  const packText = [
    collectPackUrgencyText(pack),
    Array.isArray(pack.leadSources) ? pack.leadSources.map(cleanText).join(' ') : '',
    Array.isArray(pack.reviewValueProps) ? pack.reviewValueProps.map(cleanText).join(' ') : ''
  ].join(' ');
  for (const pattern of SEARCH_INTENT_PATTERNS) {
    let matched = pattern.regex.test(packText);
    for (const { id, text } of leadTexts) {
      if (pattern.regex.test(text)) {
        matched = true;
        if (!evidenceByKey.has(pattern.key)) evidenceByKey.set(pattern.key, new Set());
        evidenceByKey.get(pattern.key).add(id);
      }
    }
    if (matched) {
      matchedIntentKeys.add(pattern.key);
      classWeights.set(pattern.intentClass, (classWeights.get(pattern.intentClass) || 0) + pattern.weight);
    }
  }
  const urgencyBoost = ['emergency_first', 'urgent_response'].includes(serviceUrgency?.urgencyClass) ? 0.18 : 0.06;
  const pressureBoost = Math.min(0.20, (Number(demandPressure?.pressureScore) || 0) * 0.20);
  const weaknessBoost = Math.min(0.16, (((Number(noWebsiteRatio) || 0) + (Number(weakRatio) || 0)) / 2) * 0.18);
  const sourceBoost = Math.min(0.14, sourceCoverageRatio * 0.14);
  const patternBoost = Math.min(0.32, Array.from(matchedIntentKeys).reduce((sum, key) => {
    const pattern = SEARCH_INTENT_PATTERNS.find((item) => item.key === key);
    return sum + (pattern?.weight || 0);
  }, 0));
  const capturedIntentScore = Number(clamp(urgencyBoost + pressureBoost + weaknessBoost + sourceBoost + patternBoost).toFixed(4));
  let intentClass = 'proof_discovery';
  let topClassWeight = -1;
  for (const [className, weight] of classWeights.entries()) {
    if (weight > topClassWeight) {
      intentClass = className;
      topClassWeight = weight;
    }
  }
  if (!matchedIntentKeys.size && sourceCoverageRatio < 0.5) intentClass = 'evidence_insufficient';
  const recommendedCaptureSurface = captureSurfaceForIntent(intentClass, serviceUrgency?.urgencyClass);
  const evidenceRequired = [];
  if (sourceCoverageRatio < 0.75) evidenceRequired.push('source_url_coverage_required');
  if (intentClass === 'urgent_local_search') {
    evidenceRequired.push('tap_to_call_copy_required', 'service_area_evidence_required');
  }
  if ((competitorWeaknesses || []).some((item) => item.key === 'missing_source_url')) {
    evidenceRequired.push('source_claim_review_required');
  }
  const evidenceLeadIdsByKey = {};
  for (const [key, set] of evidenceByKey.entries()) {
    evidenceLeadIdsByKey[key] = Array.from(set).slice(0, 8);
  }
  const sourceAlignment = (Array.isArray(pack.leadSources) ? pack.leadSources : []).slice(0, 6).map((source) => ({
    source: cleanText(source),
    intentKey: inferIntentKeyFromSource(source)
  }));
  return {
    intentClass,
    capturedIntentScore,
    recommendedCaptureSurface,
    sourceCoverageRatio: Number(sourceCoverageRatio.toFixed(4)),
    matchedIntentKeys: Array.from(matchedIntentKeys),
    queryThemes: Array.from(classWeights.entries()).map(([className, weight]) => ({
      className,
      weight: Number(weight.toFixed(4))
    })).sort((a, b) => b.weight - a.weight),
    sourceAlignment,
    evidenceLeadIdsByKey,
    evidenceLeadIds: Array.from(new Set(Object.values(evidenceLeadIdsByKey).flat())).slice(0, 12),
    evidenceRequired,
    assumptions: [
      'search intent is inferred from existing lead text, source URLs, vertical-pack lead sources, and market signals only',
      `sourceCoverageRatio=${sourceCoverageRatio.toFixed(4)} from leads with source_url / total`,
      `capturedIntentScore=${capturedIntentScore} combines urgency, demand pressure, weakness overlap, source coverage, and matched intent patterns`,
      'no live SERP scraping, ad-library lookup, or keyword-volume provider invoked'
    ],
    inputs: {
      urgencyClass: serviceUrgency?.urgencyClass || null,
      demandPressureLevel: demandPressure?.pressureLevel || null,
      noWebsiteRatio: Number((Number(noWebsiteRatio) || 0).toFixed(4)),
      weakRatio: Number((Number(weakRatio) || 0).toFixed(4))
    },
    source: 'lead_evidence_search_intent_capture'
  };
}

function captureSurfaceForIntent(intentClass, urgencyClass) {
  if (intentClass === 'urgent_local_search' || urgencyClass === 'emergency_first') {
    return 'emergency_service_area_landing_page';
  }
  if (intentClass === 'booking_or_menu_intent') return 'booking_or_menu_capture_page';
  if (intentClass === 'brand_validation') return 'owned_brand_validation_page';
  if (intentClass === 'category_comparison') return 'category_local_seo_page';
  if (intentClass === 'evidence_insufficient') return 'evidence_review';
  return 'proof_discovery_surface';
}

function inferIntentKeyFromSource(source) {
  const text = cleanText(source).toLowerCase();
  if (/map|google|category|directory|locator/.test(text)) return 'category_search_source';
  if (/review/.test(text)) return 'review_search_source';
  if (/menu|booking|order/.test(text)) return 'transactional_search_source';
  if (/social|instagram|facebook|photo/.test(text)) return 'proof_discovery_source';
  return 'general_search_source';
}

const URGENCY_FIRST_WAVE_CONVERSION = {
  emergency_first: 0.40,
  urgent_response: 0.28,
  planned_service: 0.18,
  discretionary: 0.10
};

export function buildMarketConfidenceIntervals({
  score = 0,
  confidence = 0,
  leadCount = 0,
  evidenceCount = 0,
  avgConfidence = null,
  density = 0,
  exploitableWeaknessRatio = 0,
  demandPressure = null,
  marketSizing = null,
  ownerResponsiveness = null,
  searchIntentCapture = null,
  reviewComplaintSummary = null,
  formationPermitSummary = null,
  localSeasonality = null,
  adSaturationOfferFatigue = null,
  cityDemandMap = null,
  pricingMarginInference = null,
  neighborhoodLaunchPlan = null,
  marketRecommendationProvenance = null
} = {}) {
  const sampleSize = Math.max(1, Number(leadCount) || 0, Number(evidenceCount) || 0);
  const evidenceShare = Math.min(1, (Number(evidenceCount) || 0) / 8);
  const reliability = clamp(
    ((Number(avgConfidence) || 0.5) * 0.50) +
    (evidenceShare * 0.25) +
    ((Number(density) || 0) * 0.25)
  );
  const inputsAgreementScore = Number(reliability.toFixed(4));
  const scoreInterval = ratioConfidenceInterval({
    point: score,
    sampleSize,
    reliability,
    method: 'heuristic_score_evidence_band'
  });
  const confidenceInterval = ratioConfidenceInterval({
    point: confidence,
    sampleSize,
    reliability,
    method: 'heuristic_confidence_evidence_band'
  });
  const exploitableWeaknessInterval = ratioConfidenceInterval({
    point: exploitableWeaknessRatio,
    sampleSize,
    reliability,
    method: 'heuristic_competitor_weakness_band'
  });
  const demandPressureInterval = ratioConfidenceInterval({
    point: demandPressure?.pressureScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_demand_pressure_band'
  });
  const ownerFrictionInterval = ratioConfidenceInterval({
    point: ownerResponsiveness?.responseFrictionScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_owner_responsiveness_band'
  });
  const searchIntentInterval = ratioConfidenceInterval({
    point: searchIntentCapture?.capturedIntentScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_search_intent_band'
  });
  const reviewComplaintCoverageInterval = ratioConfidenceInterval({
    point: reviewComplaintSummary?.coveredLeadRatio ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_review_complaint_coverage_band'
  });
  const reviewComplaintTopScoreInterval = ratioConfidenceInterval({
    point: reviewComplaintSummary?.topClusterScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_review_complaint_cluster_band'
  });
  const formationPermitCoverageInterval = ratioConfidenceInterval({
    point: formationPermitSummary?.coveredLeadRatio ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_formation_permit_coverage_band'
  });
  const formationPermitRiskInterval = ratioConfidenceInterval({
    point: formationPermitSummary?.regulatoryRiskScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_formation_permit_risk_band'
  });
  const localSeasonalityInterval = ratioConfidenceInterval({
    point: localSeasonality?.seasonalPressureScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_local_seasonality_band'
  });
  const adSaturationCompositeInterval = ratioConfidenceInterval({
    point: adSaturationOfferFatigue?.compositeScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_ad_saturation_offer_fatigue_band'
  });
  const adSaturationScoreInterval = ratioConfidenceInterval({
    point: adSaturationOfferFatigue?.saturationScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_ad_saturation_band'
  });
  const offerFatigueScoreInterval = ratioConfidenceInterval({
    point: adSaturationOfferFatigue?.fatigueScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_offer_fatigue_band'
  });
  const cityDemandCoverageInterval = ratioConfidenceInterval({
    point: cityDemandMap?.mappedLeadRatio ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_city_demand_coverage_band'
  });
  const cityDemandTopHotspotInterval = ratioConfidenceInterval({
    point: cityDemandMap?.topHotspotScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_city_demand_hotspot_band'
  });
  const pricingConfidenceInterval = ratioConfidenceInterval({
    point: pricingMarginInference?.confidence ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_pricing_margin_confidence_band'
  });
  const pricingSpreadInterval = ratioConfidenceInterval({
    point: pricingMarginInference?.observedPriceSpreadRatio ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_pricing_spread_band'
  });
  const neighborhoodLaunchPriorityInterval = ratioConfidenceInterval({
    point: neighborhoodLaunchPlan?.priorityScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_neighborhood_launch_priority_band'
  });
  const recommendationProvenanceInterval = ratioConfidenceInterval({
    point: marketRecommendationProvenance?.explainabilityScore ?? 0,
    sampleSize,
    reliability,
    method: 'heuristic_market_recommendation_provenance_band'
  });
  const sizingBand = ratioConfidenceInterval({
    point: marketSizing?.confidence ?? reliability,
    sampleSize,
    reliability,
    method: 'heuristic_market_sizing_relative_band'
  });
  const pricingBand = ratioConfidenceInterval({
    point: pricingMarginInference?.confidence ?? reliability,
    sampleSize,
    reliability,
    method: 'heuristic_pricing_money_band'
  });
  const moneySizing = {
    estimatedCallableRevenueCents: moneyConfidenceInterval(marketSizing?.estimatedCallableRevenueCents, sizingBand),
    serviceableAvailableMarketCents: moneyConfidenceInterval(marketSizing?.serviceableAvailableMarketCents, sizingBand),
    obtainableFirstWaveCents: moneyConfidenceInterval(marketSizing?.obtainableFirstWaveCents, sizingBand),
    obtainableFirstWaveMarginCents: moneyConfidenceInterval(marketSizing?.obtainableFirstWaveMarginCents, sizingBand)
  };
  const pricingMoney = {
    representativePriceCents: moneyConfidenceInterval(pricingMarginInference?.representativePriceCents, pricingBand),
    estimatedGrossMarginCents: moneyConfidenceInterval(pricingMarginInference?.estimatedGrossMarginCents, pricingBand)
  };
  const neighborhoodLaunchMoney = {
    estimatedFirstWaveRevenueCents: moneyConfidenceInterval(neighborhoodLaunchPlan?.estimatedFirstWaveRevenueCents, sizingBand)
  };
  const ratioIntervals = [
    scoreInterval,
    confidenceInterval,
    exploitableWeaknessInterval,
    demandPressureInterval,
    ownerFrictionInterval,
    searchIntentInterval,
    reviewComplaintCoverageInterval,
    reviewComplaintTopScoreInterval,
    formationPermitCoverageInterval,
    formationPermitRiskInterval,
    localSeasonalityInterval,
    adSaturationCompositeInterval,
    adSaturationScoreInterval,
    offerFatigueScoreInterval,
    cityDemandCoverageInterval,
    cityDemandTopHotspotInterval,
    pricingConfidenceInterval,
    pricingSpreadInterval,
    neighborhoodLaunchPriorityInterval,
    recommendationProvenanceInterval
  ];
  const moneyIntervals = [
    ...Object.values(moneySizing),
    ...Object.values(pricingMoney),
    ...Object.values(neighborhoodLaunchMoney)
  ].filter(Boolean);
  const widthClass = worstWidthClass([...ratioIntervals, ...moneyIntervals].map((item) => item.widthClass));
  const minRatioLow = Number(Math.min(...ratioIntervals.map((item) => item.low)).toFixed(4));
  return {
    score: enrichInterval(scoreInterval, sampleSize, evidenceCount, inputsAgreementScore),
    confidence: enrichInterval(confidenceInterval, sampleSize, evidenceCount, inputsAgreementScore),
    exploitableWeaknessRatio: enrichInterval(exploitableWeaknessInterval, sampleSize, evidenceCount, inputsAgreementScore),
    demandPressure: {
      pressureScore: enrichInterval(demandPressureInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    ownerResponsiveness: {
      responseFrictionScore: enrichInterval(ownerFrictionInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    searchIntentCapture: {
      capturedIntentScore: enrichInterval(searchIntentInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    reviewComplaintClusters: {
      coveredLeadRatio: enrichInterval(reviewComplaintCoverageInterval, sampleSize, evidenceCount, inputsAgreementScore),
      topClusterScore: enrichInterval(reviewComplaintTopScoreInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    formationPermitSignals: {
      coveredLeadRatio: enrichInterval(formationPermitCoverageInterval, sampleSize, evidenceCount, inputsAgreementScore),
      regulatoryRiskScore: enrichInterval(formationPermitRiskInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    localSeasonality: {
      seasonalPressureScore: enrichInterval(localSeasonalityInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    adSaturationOfferFatigue: {
      compositeScore: enrichInterval(adSaturationCompositeInterval, sampleSize, evidenceCount, inputsAgreementScore),
      saturationScore: enrichInterval(adSaturationScoreInterval, sampleSize, evidenceCount, inputsAgreementScore),
      fatigueScore: enrichInterval(offerFatigueScoreInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    cityDemandMap: {
      mappedLeadRatio: enrichInterval(cityDemandCoverageInterval, sampleSize, evidenceCount, inputsAgreementScore),
      topHotspotScore: enrichInterval(cityDemandTopHotspotInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    pricingMarginInference: {
      confidence: enrichInterval(pricingConfidenceInterval, sampleSize, evidenceCount, inputsAgreementScore),
      observedPriceSpreadRatio: enrichInterval(pricingSpreadInterval, sampleSize, evidenceCount, inputsAgreementScore),
      representativePriceCents: pricingMoney.representativePriceCents
        ? enrichInterval(pricingMoney.representativePriceCents, sampleSize, evidenceCount, inputsAgreementScore)
        : null,
      estimatedGrossMarginCents: pricingMoney.estimatedGrossMarginCents
        ? enrichInterval(pricingMoney.estimatedGrossMarginCents, sampleSize, evidenceCount, inputsAgreementScore)
        : null
    },
    neighborhoodLaunchPlan: {
      priorityScore: enrichInterval(neighborhoodLaunchPriorityInterval, sampleSize, evidenceCount, inputsAgreementScore),
      estimatedFirstWaveRevenueCents: neighborhoodLaunchMoney.estimatedFirstWaveRevenueCents
        ? enrichInterval(neighborhoodLaunchMoney.estimatedFirstWaveRevenueCents, sampleSize, evidenceCount, inputsAgreementScore)
        : null
    },
    marketRecommendationProvenance: {
      explainabilityScore: enrichInterval(recommendationProvenanceInterval, sampleSize, evidenceCount, inputsAgreementScore)
    },
    marketSizing: Object.fromEntries(Object.entries(moneySizing)
      .filter(([, interval]) => interval)
      .map(([key, interval]) => [key, enrichInterval(interval, sampleSize, evidenceCount, inputsAgreementScore)])),
    summary: {
      widthClass,
      speculative: widthClass === 'speculative',
      minRatioLow,
      maxRatioHigh: Number(Math.max(...ratioIntervals.map((item) => item.high)).toFixed(4)),
      evidenceCount,
      sampleSize,
      inputsAgreementScore,
      source: 'lead_evidence_confidence_interval_propagation'
    },
    assumptions: [
      `sampleSize=${sampleSize} from observed lead/evidence count`,
      `inputsAgreementScore=${inputsAgreementScore} combines avg presence confidence, evidence count, and lead density`,
      'intervals are heuristic evidence bands, not live market surveys or external statistical samples',
      'money intervals reuse the market-sizing confidence band so SAM/SOM chips do not imply false precision'
    ],
    source: 'lead_evidence_confidence_interval_propagation'
  };
}

function estimateMarketSizing({
  group,
  evidence,
  representativePriceCents,
  fulfillmentCostCents,
  targetGrossMarginPct,
  maxAcquisitionCostCents,
  callable,
  weak,
  noWebsite,
  avgConfidence,
  density,
  serviceUrgency,
  demandPressure,
  competitorWeaknesses,
  exploitableWeaknessRatio,
  decision
}) {
  const totalObservedLeads = group.leads.length;
  const ticket = Math.max(0, Number(representativePriceCents) || 0);
  const fulfillment = Number.isFinite(Number(fulfillmentCostCents)) ? Number(fulfillmentCostCents) : null;
  const contributionMarginCents = ticket && fulfillment !== null ? Math.max(0, ticket - fulfillment) : null;
  const weakPresenceCallableLeads = group.leads.filter((lead) => {
    const presence = String(lead.online_presence_strength || '').toLowerCase();
    const noSite = !cleanText(lead.website) || cleanText(lead.website).toLowerCase() === 'null';
    const isWeak = ['weak', 'missing', 'thin'].includes(presence) || noSite;
    const risk = String(lead.risk_status || '').toLowerCase();
    const callableLead = ['callable', 'qualified'].includes(risk) || !!cleanText(lead.phone);
    return isWeak && callableLead;
  }).length;
  const estimatedCallableRevenueCents = callable * ticket;
  const weakPresenceCallableRevenueCents = weakPresenceCallableLeads * ticket;
  const urgencyClass = serviceUrgency?.urgencyClass || 'planned_service';
  const baseConversion = URGENCY_FIRST_WAVE_CONVERSION[urgencyClass] ?? 0.15;
  const pressureScore = Number(demandPressure?.pressureScore) || 0;
  const evidenceBoost = Math.min(0.20, (Number(avgConfidence) || 0.5) * 0.25);
  const weaknessBoost = Math.min(0.20, (Number(exploitableWeaknessRatio) || 0) * 0.20);
  const firstWaveConversionRate = clamp(baseConversion + (pressureScore * 0.30) + evidenceBoost + weaknessBoost);
  const obtainableFirstWaveLeads = Math.max(0, Math.round(weakPresenceCallableLeads * firstWaveConversionRate));
  const obtainableFirstWaveCents = obtainableFirstWaveLeads * ticket;
  const serviceableAvailableMarketCents = estimatedCallableRevenueCents;
  const evidenceConfidence = clamp(((Number(avgConfidence) || 0.5) * 0.6) + ((Number(density) || 0) * 0.25) + (pressureScore * 0.15));
  const obtainableFirstWaveMarginCents = contributionMarginCents !== null
    ? obtainableFirstWaveLeads * contributionMarginCents
    : null;
  const assumptions = [
    `representativeTicketCents derived from vertical pack ${group.pack?.key || group.verticalKey} median lead price`,
    `firstWaveConversionRate ${(firstWaveConversionRate * 100).toFixed(1)}% from urgencyClass=${urgencyClass} (base ${(baseConversion * 100).toFixed(0)}%), demand pressureScore=${pressureScore.toFixed(2)}, exploitableWeaknessRatio=${(Number(exploitableWeaknessRatio) || 0).toFixed(2)}, evidence confidence=${(Number(avgConfidence) || 0.5).toFixed(2)}`,
    contributionMarginCents !== null
      ? `contributionMarginCents=${contributionMarginCents} derived from ticket ${ticket} minus fulfillment ${fulfillment}`
      : `contributionMarginCents unknown until vertical pack publishes estimatedFulfillmentCostCents`,
    `maxAcquisitionCostCents=${maxAcquisitionCostCents} caps spend per acquired first-wave customer`,
    'no live scraping; estimates use existing lead evidence, vertical pack margin model, urgency, and demand pressure signals only'
  ];
  return {
    totalObservedLeads,
    immediatelyCallableLeads: callable,
    weakPresenceCallableLeads,
    weakPresenceLeads: weak,
    noWebsiteLeads: noWebsite,
    representativeTicketCents: ticket,
    estimatedFulfillmentCostCents: fulfillment,
    contributionMarginCents,
    maxAcquisitionCostCents,
    targetGrossMarginPct,
    estimatedCallableRevenueCents,
    weakPresenceCallableRevenueCents,
    serviceableAvailableMarketCents,
    obtainableFirstWaveLeads,
    obtainableFirstWaveCents,
    obtainableFirstWaveMarginCents,
    firstWaveConversionRate: Number(firstWaveConversionRate.toFixed(4)),
    confidence: Number(evidenceConfidence.toFixed(4)),
    decision,
    assumptions,
    evidenceLeadIds: evidence.map((entry) => entry.id).slice(0, 12),
    inputs: {
      urgencyClass,
      pressureScore: Number(pressureScore.toFixed(4)),
      exploitableWeaknessRatio: Number((Number(exploitableWeaknessRatio) || 0).toFixed(4)),
      avgConfidence: Number(((Number(avgConfidence) || 0.5)).toFixed(4)),
      density: Number(((Number(density) || 0)).toFixed(4))
    },
    source: 'lead_evidence_market_sizing_estimate'
  };
}

const RESPONSIVENESS_NEGATIVE_PATTERNS = [
  { key: 'no_callback', weight: 0.18, regex: /(no callback|never called back|did not call back|didn'?t call back|doesn'?t call back|unreturned call)/i },
  { key: 'missed_call', weight: 0.14, regex: /(missed call|missed calls|missed-call|missed phone call)/i },
  { key: 'unanswered', weight: 0.14, regex: /(unanswered|did not answer|didn'?t answer|no answer|never answered|unreachable|voicemail full|goes to voicemail|voicemail only)/i },
  { key: 'no_response', weight: 0.12, regex: /(no response|never responded|did not respond|didn'?t respond|no reply|never replied)/i },
  { key: 'slow_response', weight: 0.10, regex: /(slow response|slow to respond|delayed response|response time issue|takes (?:days|weeks) to respond)/i }
];

const RESPONSIVENESS_POSITIVE_PATTERNS = [
  { key: 'fast_response', weight: 0.12, regex: /(fast response|same.?day(?: response)?|quick (?:response|reply|callback)|prompt response|responsive)/i },
  { key: 'callback_path', weight: 0.10, regex: /(callback(?:s)?|called back|will call back|returns? calls?|callback received)/i },
  { key: 'response_time_promise', weight: 0.06, regex: /(response time|reply time|SLA|24\/7|24 7|after.?hours response)/i },
  { key: 'business_landline_evidence', weight: 0.05, regex: /(business landline|business line|business phone)/i }
];

export function predictOwnerResponsiveness({
  leads,
  pack = null,
  verticalKey = null,
  serviceUrgency = null,
  demandPressure = null,
  avgConfidence = null
} = {}) {
  const safeLeads = Array.isArray(leads) ? leads : [];
  const total = safeLeads.length;
  const evidenceLeadIds = safeLeads.slice(0, 12).map((lead) => `lead:${lead.id}`);
  if (!total) {
    return buildInsufficientResponsiveness({
      evidenceLeadIds,
      reason: 'no_leads_in_group',
      verticalKey,
      pack
    });
  }
  let callableCount = 0;
  let businessPhoneCount = 0;
  let phonePresentCount = 0;
  let noWebsiteCount = 0;
  let weakPresenceCount = 0;
  let lowConfidenceCount = 0;
  let missingSourceCount = 0;
  let callableReasonProvidedCount = 0;
  const negativeKeys = new Set();
  const positiveKeys = new Set();
  const evidenceByKey = new Map();
  let totalNegativeWeight = 0;
  let totalPositiveWeight = 0;
  for (const lead of safeLeads) {
    const risk = String(lead.risk_status || '').toLowerCase();
    const phoneClass = String(lead.phone_classification || '').toLowerCase();
    const presence = String(lead.online_presence_strength || '').toLowerCase();
    const website = cleanText(lead.website);
    const phone = cleanText(lead.phone);
    const sourceUrl = cleanText(lead.source_url);
    const confidence = Number(lead.presence_confidence);
    if (['callable', 'qualified'].includes(risk)) callableCount += 1;
    if (phone) phonePresentCount += 1;
    if (phoneClass === 'business_landline' || phoneClass === 'business' || phoneClass === 'business_phone') businessPhoneCount += 1;
    if (!website || website.toLowerCase() === 'null') noWebsiteCount += 1;
    if (['weak', 'missing', 'thin'].includes(presence)) weakPresenceCount += 1;
    if (Number.isFinite(confidence) && confidence < 0.5) lowConfidenceCount += 1;
    if (!sourceUrl) missingSourceCount += 1;
    const reasonText = cleanText(lead.callable_reason);
    if (reasonText) callableReasonProvidedCount += 1;
    const scanText = `${reasonText} ${cleanText(lead.niche)} ${cleanText(lead.business_name)} ${cleanText(lead.online_presence_strength)}`.trim();
    if (!scanText) continue;
    for (const pattern of RESPONSIVENESS_NEGATIVE_PATTERNS) {
      if (pattern.regex.test(scanText)) {
        if (!negativeKeys.has(pattern.key)) totalNegativeWeight += pattern.weight;
        negativeKeys.add(pattern.key);
        if (!evidenceByKey.has(pattern.key)) evidenceByKey.set(pattern.key, new Set());
        evidenceByKey.get(pattern.key).add(`lead:${lead.id}`);
      }
    }
    for (const pattern of RESPONSIVENESS_POSITIVE_PATTERNS) {
      if (pattern.regex.test(scanText)) {
        if (!positiveKeys.has(pattern.key)) totalPositiveWeight += pattern.weight;
        positiveKeys.add(pattern.key);
        if (!evidenceByKey.has(pattern.key)) evidenceByKey.set(pattern.key, new Set());
        evidenceByKey.get(pattern.key).add(`lead:${lead.id}`);
      }
    }
  }
  const callableCoverageRatio = Number((callableCount / total).toFixed(4));
  const businessPhoneCoverageRatio = Number((businessPhoneCount / total).toFixed(4));
  const phonePresentRatio = Number((phonePresentCount / total).toFixed(4));
  const noWebsiteRatio = Number((noWebsiteCount / total).toFixed(4));
  const weakPresenceRatio = Number((weakPresenceCount / total).toFixed(4));
  const lowConfidenceRatio = Number((lowConfidenceCount / total).toFixed(4));
  const callableReasonRatio = Number((callableReasonProvidedCount / total).toFixed(4));
  const evidenceTooThin = callableReasonProvidedCount === 0 && total < 2;
  const coveragePenalty = Math.min(0.30,
    (1 - callableCoverageRatio) * 0.18 +
    (1 - businessPhoneCoverageRatio) * 0.12 +
    weakPresenceRatio * 0.06 +
    lowConfidenceRatio * 0.06
  );
  const coverageBonus = Math.min(0.20,
    callableCoverageRatio * 0.12 +
    businessPhoneCoverageRatio * 0.08
  );
  const urgencyClass = serviceUrgency?.urgencyClass || 'planned_service';
  const urgencyPenalty = (urgencyClass === 'emergency_first' || urgencyClass === 'urgent_response')
    ? Math.min(0.08, (1 - callableCoverageRatio) * 0.10)
    : 0;
  const baseFriction = 0.4;
  const rawFriction = baseFriction + totalNegativeWeight - totalPositiveWeight + coveragePenalty - coverageBonus + urgencyPenalty;
  const responseFrictionScore = Number(clamp(rawFriction).toFixed(4));
  let responsivenessClass = 'mixed';
  if (evidenceTooThin) {
    responsivenessClass = 'evidence_insufficient';
  } else if (callableCoverageRatio >= 0.66 && businessPhoneCoverageRatio >= 0.5 && responseFrictionScore <= 0.38 && negativeKeys.size === 0) {
    responsivenessClass = 'responsive_likely';
  } else if (callableCoverageRatio <= 0.33 || responseFrictionScore >= 0.65 || (negativeKeys.size >= 2 && responseFrictionScore >= 0.5)) {
    responsivenessClass = 'unresponsive_risk';
  } else {
    responsivenessClass = 'mixed';
  }
  const blockers = [];
  if (callableReasonRatio < 0.5) blockers.push('callable_reason_text_required');
  if (lowConfidenceRatio >= 0.4) blockers.push('research_confidence_required');
  if (missingSourceCount === total) blockers.push('source_url_required');
  if (phonePresentRatio < 0.5) blockers.push('phone_number_evidence_required');
  if (responsivenessClass === 'evidence_insufficient' && !blockers.includes('callable_reason_text_required')) {
    blockers.push('callable_reason_text_required');
  }
  let recommendedAcquisitionMotion;
  switch (responsivenessClass) {
    case 'responsive_likely':
      recommendedAcquisitionMotion = phonePresentRatio >= 0.66 ? 'call_ready' : 'inbound_first';
      break;
    case 'unresponsive_risk':
      recommendedAcquisitionMotion = 'proof_first';
      break;
    case 'evidence_insufficient':
      recommendedAcquisitionMotion = 'evidence_review';
      break;
    case 'mixed':
    default:
      recommendedAcquisitionMotion = 'inbound_first';
      break;
  }
  const negativeSignals = Array.from(negativeKeys);
  const positiveSignals = Array.from(positiveKeys);
  const evidenceLeadIdsByKey = {};
  for (const [key, set] of evidenceByKey.entries()) {
    evidenceLeadIdsByKey[key] = Array.from(set).slice(0, 8);
  }
  const exploit = exploitForResponsiveness({
    responsivenessClass,
    recommendedAcquisitionMotion,
    urgencyClass,
    pack,
    verticalKey
  });
  const assumptions = [
    `callableCoverageRatio=${callableCoverageRatio} = leads with risk_status in {callable,qualified} / total ${callableCount}/${total}`,
    `businessPhoneCoverageRatio=${businessPhoneCoverageRatio} = leads with business_landline phone_classification / total ${businessPhoneCount}/${total}`,
    `responseFrictionScore=${responseFrictionScore} = clamp(${baseFriction} + negativeWeight ${totalNegativeWeight.toFixed(2)} - positiveWeight ${totalPositiveWeight.toFixed(2)} + coveragePenalty ${coveragePenalty.toFixed(2)} - coverageBonus ${coverageBonus.toFixed(2)} + urgencyPenalty ${urgencyPenalty.toFixed(2)})`,
    `negative signals matched in callable_reason/niche/business_name text: ${negativeSignals.length ? negativeSignals.join(', ') : 'none'}`,
    `positive signals matched in callable_reason text: ${positiveSignals.length ? positiveSignals.join(', ') : 'none'}`,
    `recommendedAcquisitionMotion=${recommendedAcquisitionMotion} derived from responsivenessClass=${responsivenessClass}, phonePresentRatio=${phonePresentRatio}, urgencyClass=${urgencyClass}`,
    'no live calls, scraping, or external responsiveness probes invoked — derivation uses existing lead evidence only'
  ];
  return {
    responsivenessClass,
    recommendedAcquisitionMotion,
    responseFrictionScore,
    callableCoverageRatio,
    businessPhoneCoverageRatio,
    phonePresentRatio,
    noWebsiteRatio,
    weakPresenceRatio,
    lowConfidenceRatio,
    callableReasonRatio,
    negativeSignals,
    positiveSignals,
    evidenceLeadIdsByKey,
    evidenceLeadIds,
    blockers,
    evidenceRequired: blockers,
    inputs: {
      totalLeads: total,
      callableCount,
      businessPhoneCount,
      phonePresentCount,
      noWebsiteCount,
      weakPresenceCount,
      lowConfidenceCount,
      missingSourceCount,
      callableReasonProvidedCount,
      urgencyClass,
      demandPressureLevel: demandPressure?.pressureLevel || null,
      avgConfidence: Number.isFinite(Number(avgConfidence)) ? Number(Number(avgConfidence).toFixed(4)) : null
    },
    weights: {
      negative: Number(totalNegativeWeight.toFixed(4)),
      positive: Number(totalPositiveWeight.toFixed(4)),
      coveragePenalty: Number(coveragePenalty.toFixed(4)),
      coverageBonus: Number(coverageBonus.toFixed(4)),
      urgencyPenalty: Number(urgencyPenalty.toFixed(4))
    },
    exploit,
    assumptions,
    source: 'lead_evidence_owner_responsiveness_prediction'
  };
}

function buildInsufficientResponsiveness({ evidenceLeadIds, reason, verticalKey, pack }) {
  return {
    responsivenessClass: 'evidence_insufficient',
    recommendedAcquisitionMotion: 'evidence_review',
    responseFrictionScore: 0,
    callableCoverageRatio: 0,
    businessPhoneCoverageRatio: 0,
    phonePresentRatio: 0,
    noWebsiteRatio: 0,
    weakPresenceRatio: 0,
    lowConfidenceRatio: 0,
    callableReasonRatio: 0,
    negativeSignals: [],
    positiveSignals: [],
    evidenceLeadIdsByKey: {},
    evidenceLeadIds,
    blockers: ['callable_reason_text_required', 'phone_number_evidence_required'],
    evidenceRequired: ['callable_reason_text_required', 'phone_number_evidence_required'],
    inputs: { reason },
    weights: { negative: 0, positive: 0, coveragePenalty: 0, coverageBonus: 0, urgencyPenalty: 0 },
    exploit: exploitForResponsiveness({
      responsivenessClass: 'evidence_insufficient',
      recommendedAcquisitionMotion: 'evidence_review',
      urgencyClass: 'planned_service',
      pack,
      verticalKey
    }),
    assumptions: [
      `responsivenessClass=evidence_insufficient because ${reason}`,
      'no live calls, scraping, or external responsiveness probes invoked'
    ],
    source: 'lead_evidence_owner_responsiveness_prediction'
  };
}

function exploitForResponsiveness({ responsivenessClass, recommendedAcquisitionMotion, urgencyClass, pack, verticalKey }) {
  const label = cleanText(pack?.name || verticalKey || 'service');
  switch (responsivenessClass) {
    case 'responsive_likely':
      return recommendedAcquisitionMotion === 'call_ready'
        ? `Owners look responsive for local ${label}: queue outbound calls with verified business landlines and capture callbacks fast.`
        : `Owners look responsive for local ${label} but phone coverage is thin: lead with an inbound-ready owned surface before outbound.`;
    case 'unresponsive_risk':
      return `Owners look unresponsive for local ${label}: do not lead with outbound calls — publish a proof-first owned surface and gather callback evidence before scaling.`;
    case 'evidence_insufficient':
      return `Responsiveness evidence is too thin for ${label}: enrich callable_reason text and phone-classification evidence before any outbound motion.`;
    case 'mixed':
    default:
      return `Local ${label} owners are a mixed responsiveness pool: own the inbound surface first and reserve outbound for the highest-evidence leads.`;
  }
}

function ratioConfidenceInterval({ point, sampleSize, reliability, method }) {
  const safePoint = clamp(Number(point) || 0);
  const safeSample = Math.max(1, Number(sampleSize) || 1);
  const safeReliability = clamp(Number(reliability) || 0.5);
  const sampleHalfWidth = 0.22 / Math.sqrt(safeSample);
  const reliabilityHalfWidth = (1 - safeReliability) * 0.20;
  const halfWidth = Number(Math.min(0.49, Math.max(0.05, sampleHalfWidth + reliabilityHalfWidth)).toFixed(4));
  return {
    low: Number(Math.max(0, safePoint - halfWidth).toFixed(4)),
    point: Number(safePoint.toFixed(4)),
    high: Number(Math.min(1, safePoint + halfWidth).toFixed(4)),
    halfWidth,
    widthClass: intervalWidthClass(halfWidth, safeSample),
    method
  };
}

function moneyConfidenceInterval(point, ratioBand) {
  const value = Number(point);
  if (!Number.isFinite(value)) return null;
  const halfWidth = Number(ratioBand?.halfWidth) || 0.25;
  return {
    low: Math.max(0, Math.round(value * (1 - halfWidth))),
    point: Math.round(value),
    high: Math.max(0, Math.round(value * (1 + halfWidth))),
    halfWidth: Number(halfWidth.toFixed(4)),
    widthClass: ratioBand.widthClass,
    method: 'heuristic_money_relative_band'
  };
}

function enrichInterval(interval, sampleSize, evidenceCount, inputsAgreementScore) {
  return {
    ...interval,
    sampleSize,
    evidenceCount,
    inputsAgreementScore
  };
}

function intervalWidthClass(halfWidth, sampleSize) {
  if (sampleSize <= 1 || halfWidth >= 0.32) return 'speculative';
  if (halfWidth >= 0.18) return 'wide';
  if (halfWidth >= 0.10) return 'measured';
  return 'tight';
}

function worstWidthClass(classes) {
  const order = ['tight', 'measured', 'wide', 'speculative'];
  return classes.reduce((worst, item) => (
    order.indexOf(item) > order.indexOf(worst) ? item : worst
  ), 'tight');
}

function collectLeadUrgencyText(lead) {
  return [
    lead.niche,
    lead.business_name,
    lead.callable_reason,
    lead.source_url,
    lead.online_presence_strength
  ].map((value) => cleanText(value).toLowerCase()).join(' ');
}

function collectPackUrgencyText(pack) {
  if (!pack) return '';
  const parts = [];
  parts.push(cleanText(pack.valuePropHook));
  parts.push(cleanText(pack.customerPersonaHint));
  parts.push(cleanText(pack.pitchTone));
  if (Array.isArray(pack.marketSignals)) {
    for (const signal of pack.marketSignals) {
      parts.push(cleanText(signal.key));
      parts.push(cleanText(signal.label));
      parts.push(cleanText(signal.evidenceHint));
    }
  }
  if (Array.isArray(pack.growthPaths)) parts.push(pack.growthPaths.map(cleanText).join(' '));
  if (Array.isArray(pack.retentionLoops)) parts.push(pack.retentionLoops.map(cleanText).join(' '));
  if (pack.serviceOffer) {
    parts.push(cleanText(pack.serviceOffer.headline));
    parts.push(cleanText(pack.serviceOffer.customerOutcome));
  }
  if (pack.compliance && Array.isArray(pack.compliance.restrictedClaims)) {
    parts.push(pack.compliance.restrictedClaims.map(cleanText).join(' '));
  }
  return parts.join(' ').toLowerCase();
}

function exploitForUrgencyClass(urgencyClass, pack, group) {
  const verticalLabel = cleanText(pack?.name || group?.verticalKey || 'service');
  switch (urgencyClass) {
    case 'emergency_first':
      return `Position a verified emergency-ready ${verticalLabel} response with after-hours coverage and a tap-to-call CTA above the fold.`;
    case 'urgent_response':
      return `Promise a same-day ${verticalLabel} response path with safe response-time claims and missed-call rescue follow-up.`;
    case 'planned_service':
      return `Lead with a clear ${verticalLabel} booking or appointment path, hours, location, and proof.`;
    case 'discretionary':
      return `Compete on discovery proof and walk-in or browse intent rather than urgency promises.`;
    default:
      return `Default to safe ${verticalLabel} response framing until urgency signals strengthen.`;
  }
}

function exploitationStrategyFor({ pressureLevel, serviceUrgency, pack, group }) {
  const verticalLabel = cleanText(pack?.name || group?.verticalKey || 'service');
  const urgencyExploit = exploitForUrgencyClass(serviceUrgency.urgencyClass, pack, group);
  if (pressureLevel === 'high') {
    return `Demand pressure is high in the local ${verticalLabel} market: ${urgencyExploit}`;
  }
  if (pressureLevel === 'elevated') {
    return `Demand pressure is elevated: ${urgencyExploit}`;
  }
  if (pressureLevel === 'moderate') {
    return `Demand pressure is moderate. Test a single owned acquisition surface before scaling: ${urgencyExploit}`;
  }
  return `Demand pressure is low. Hold paid promotion and prove evidence before scaling: ${urgencyExploit}`;
}

const MARKET_NEGATIVE_OUTCOMES = new Set(['false_positive', 'market_failure', 'launch_rejected', 'unprofitable_test']);

function normalizeMarketRecommendationOutcome({
  opportunity,
  outcome,
  reasonKey,
  summary,
  evidence,
  observedAt
}) {
  const normalizedOutcome = cleanKey(outcome || 'false_positive');
  const safeOutcome = MARKET_NEGATIVE_OUTCOMES.has(normalizedOutcome) ? normalizedOutcome : 'false_positive';
  const safeReason = cleanKey(reasonKey || summary || safeOutcome);
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  return {
    id: `market_outcome:${opportunity.id}:${safeOutcome}:${safeReason}:${Number(observedAt) || Date.now()}`,
    outcome: safeOutcome,
    reasonKey: safeReason,
    summary: cleanText(summary) || `Market recommendation outcome recorded as ${safeOutcome}.`,
    predictedDecision: opportunity.decision,
    predictedScore: Number((Number(opportunity.score) || 0).toFixed(4)),
    predictedConfidence: Number((Number(opportunity.confidence) || 0).toFixed(4)),
    evidence: evidenceList.slice(0, 12),
    observedAt: Number(observedAt) || Date.now(),
    source: 'market_recommendation_outcome_learning'
  };
}

function summarizeMarketOutcomeLearning({ opportunity, outcomes = [], now = Date.now() } = {}) {
  const negativeOutcomes = outcomes.filter((item) => MARKET_NEGATIVE_OUTCOMES.has(item.outcome));
  const falsePositiveCount = outcomes.filter((item) => item.outcome === 'false_positive').length;
  const marketFailureCount = outcomes.filter((item) => item.outcome === 'market_failure' || item.outcome === 'launch_rejected' || item.outcome === 'unprofitable_test').length;
  const reasonKeys = [...new Set(negativeOutcomes.map((item) => item.reasonKey).filter(Boolean))].slice(0, 12);
  const scorePenalty = Number(Math.min(0.25, (falsePositiveCount * 0.10) + (marketFailureCount * 0.08) + (reasonKeys.length ? 0.02 : 0)).toFixed(4));
  const state = falsePositiveCount ? 'false_positive_observed' : marketFailureCount ? 'market_failure_observed' : 'observed';
  const recommendedDecision = learnedDecisionFor({
    opportunity,
    revisedScore: (Number(opportunity.score) || 0) - scorePenalty,
    learning: {
      state,
      falsePositiveCount,
      marketFailureCount
    }
  });
  return {
    state,
    outcomeCount: outcomes.length,
    falsePositiveCount,
    marketFailureCount,
    reasonKeys,
    outcomes,
    lastOutcome: outcomes[outcomes.length - 1] || null,
    scorePenalty,
    recommendedDecision,
    evidenceRequired: [
      ...(falsePositiveCount ? ['false_positive_root_cause_review_required'] : []),
      ...(marketFailureCount ? ['market_failure_retest_required'] : []),
      'fresh_market_evidence_required_before_relaunch'
    ],
    learningSummary: reasonKeys.length
      ? `Market recommendation penalized after ${reasonKeys.join(', ')}.`
      : 'Market recommendation outcome recorded for future scoring.',
    assumptions: [
      'market outcome learning is based on operator-recorded local outcomes and attached evidence only',
      'future aggregations apply the penalty to the same city and vertical opportunity before launch decisions',
      'learning changes internal prioritization and does not erase source evidence or historical receipts'
    ],
    createdAt: opportunity.signals?.marketOutcomeLearning?.createdAt || now,
    updatedAt: now,
    source: 'market_recommendation_outcome_learning'
  };
}

function learnedDecisionFor({ opportunity = null, revisedScore = 0, learning = null } = {}) {
  if ((learning?.falsePositiveCount || 0) >= 2 || (learning?.marketFailureCount || 0) >= 2) return 'avoid';
  if (revisedScore < 0.45) return 'avoid';
  if (MARKET_NEGATIVE_OUTCOMES.has(learning?.lastOutcome?.outcome) || learning?.state === 'false_positive_observed' || learning?.state === 'market_failure_observed') {
    return 'watch';
  }
  if (revisedScore >= 0.72 && opportunity?.decision === 'launch_candidate') return 'launch_candidate';
  return revisedScore >= 0.72 ? 'watch' : revisedScore >= 0.45 ? 'watch' : 'avoid';
}

function upsertMarketOutcomeLearningRecord({ opportunity, learning, outcome, now = Date.now() }) {
  const serviceBusiness = db.prepare(`
    SELECT id
    FROM service_businesses
    WHERE opportunity_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(opportunity.id);
  const row = {
    id: `plearn_${cleanKey(opportunity.id)}_${cleanKey(outcome.outcome)}_${cleanKey(outcome.reasonKey)}`.slice(0, 120),
    workspace_id: opportunity.workspace_id,
    incident_id: null,
    service_business_id: serviceBusiness?.id || null,
    source_type: 'market_opportunity_outcome',
    source_id: opportunity.id,
    kind: outcome.outcome === 'false_positive' ? 'market_false_positive' : 'market_failure',
    status: 'proposed',
    hypothesis: `${opportunity.city} ${opportunity.vertical_key} launch scoring should be penalized after ${outcome.reasonKey}.`,
    proposed_change: learning.learningSummary,
    eval_json: JSON.stringify({
      command: 'npm run check:maygoals',
      status: 'required_before_relaunch',
      acceptance: 'future aggregation preserves source evidence but applies market outcome penalty before launch decisions'
    }),
    experiment_json: JSON.stringify({
      key: `${cleanKey(opportunity.city)}_${cleanKey(opportunity.vertical_key)}_market_outcome_retest`,
      metric: 'false_positive_repeat_rate',
      guardrail: 'do not auto-launch live or paid acquisition until fresh evidence clears the learning penalty'
    }),
    impact_json: JSON.stringify({
      predictedDecision: outcome.predictedDecision,
      predictedScore: outcome.predictedScore,
      revisedDecision: learning.recommendedDecision,
      scorePenalty: learning.scorePenalty,
      reasonKeys: learning.reasonKeys,
      evidenceCount: Array.isArray(outcome.evidence) ? outcome.evidence.length : 0
    }),
    created_at: now,
    updated_at: now
  };
  db.prepare(`
    INSERT INTO portfolio_learning_records (
      id, workspace_id, incident_id, service_business_id, source_type, source_id, kind, status,
      hypothesis, proposed_change, eval_json, experiment_json, impact_json, created_at, updated_at
    )
    VALUES (
      @id, @workspace_id, @incident_id, @service_business_id, @source_type, @source_id, @kind, @status,
      @hypothesis, @proposed_change, @eval_json, @experiment_json, @impact_json, @created_at, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      service_business_id = excluded.service_business_id,
      source_type = excluded.source_type,
      source_id = excluded.source_id,
      kind = excluded.kind,
      status = excluded.status,
      hypothesis = excluded.hypothesis,
      proposed_change = excluded.proposed_change,
      eval_json = excluded.eval_json,
      experiment_json = excluded.experiment_json,
      impact_json = excluded.impact_json,
      updated_at = excluded.updated_at
  `).run(row);
  return {
    ...row,
    eval: parsePortfolioJson(row.eval_json),
    experiment: parsePortfolioJson(row.experiment_json),
    impact: parsePortfolioJson(row.impact_json)
  };
}

function deterministicOpportunityId(workspaceId, city, verticalKey) {
  return `opp_${cleanKey(workspaceId)}_${cleanKey(city)}_${cleanKey(verticalKey)}`.slice(0, 120);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown';
}

function parsePortfolioJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function clamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, Number(n.toFixed(4))));
}
