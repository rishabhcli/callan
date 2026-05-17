export const PLAN_SECTION_KEYS = Object.freeze([
  'localSeoGaps',
  'googleBusinessProfileTasks',
  'reviewCapturePlan',
  'bookingContactFlowPlan',
  'analyticsSetup',
  'contentIdeas',
  'monthlyMaintenancePlan',
  'automationIdeas'
]);

export const GROWTH_OFFER_IDS = Object.freeze([
  'starter_website',
  'website_local_seo',
  'review_system',
  'booking_contact_automation',
  'monthly_maintenance'
]);

const recommendationSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    why: { type: 'string' },
    action: { type: 'string' },
    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidenceIds: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
    unsupported: { type: 'boolean' }
  },
  required: ['id', 'title', 'why', 'action', 'priority', 'evidenceIds', 'unsupported']
};

export const GrowthPlanJsonSchema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string' },
    leadId: { type: 'string' },
    generatedAt: { type: 'string' },
    localSeoGaps: { type: 'array', maxItems: 8, items: recommendationSchema },
    googleBusinessProfileTasks: { type: 'array', maxItems: 8, items: recommendationSchema },
    reviewCapturePlan: { type: 'array', maxItems: 8, items: recommendationSchema },
    bookingContactFlowPlan: { type: 'array', maxItems: 8, items: recommendationSchema },
    analyticsSetup: { type: 'array', maxItems: 8, items: recommendationSchema },
    contentIdeas: { type: 'array', maxItems: 8, items: recommendationSchema },
    monthlyMaintenancePlan: { type: 'array', maxItems: 8, items: recommendationSchema },
    automationIdeas: { type: 'array', maxItems: 8, items: recommendationSchema },
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: 24,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          summary: { type: 'string' },
          url: { type: 'string', nullable: true },
          confidence: { type: 'number' }
        },
        required: ['id', 'source', 'summary', 'url', 'confidence']
      }
    },
    risk: {
      type: 'object',
      properties: {
        legalFinancialAdviceRequested: { type: 'boolean' },
        seoGuaranteeRequested: { type: 'boolean' },
        handoffRequired: { type: 'boolean' },
        notes: { type: 'array', maxItems: 8, items: { type: 'string' } }
      },
      required: ['legalFinancialAdviceRequested', 'seoGuaranteeRequested', 'handoffRequired', 'notes']
    },
    unsupportedFlags: { type: 'array', maxItems: 8, items: { type: 'string' } }
  },
  required: [
    'schemaVersion',
    'leadId',
    'generatedAt',
    ...PLAN_SECTION_KEYS,
    'evidence',
    'risk',
    'unsupportedFlags'
  ]
};

export function emptyGrowthPlan({ leadId, generatedAt = new Date().toISOString() } = {}) {
  return {
    schemaVersion: 'growth_plan.v1',
    leadId: leadId || null,
    generatedAt,
    ...Object.fromEntries(PLAN_SECTION_KEYS.map((key) => [key, []])),
    evidence: [],
    risk: {
      legalFinancialAdviceRequested: false,
      seoGuaranteeRequested: false,
      handoffRequired: false,
      notes: []
    },
    unsupportedFlags: []
  };
}

export function collectRecommendations(plan) {
  return PLAN_SECTION_KEYS.flatMap((key) => (
    Array.isArray(plan?.[key])
      ? plan[key].map((item) => ({ ...item, section: key }))
      : []
  ));
}
