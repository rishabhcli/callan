export const ACCOUNT_MANAGER_SECTION_KEYS = Object.freeze([
  'promisedEdits',
  'staleFactsToRecheck',
  'launchFollowup',
  'reviewCapture',
  'googleBusinessProfileHygiene',
  'seasonalHours',
  'serviceMenuChanges',
  'analyticsContactFlowCheck',
  'hostingSubscriptionStatus'
]);

export const ACCOUNT_TASK_KINDS = Object.freeze([
  'promised_edit',
  'stale_business_fact',
  'launch_followup',
  'review_capture',
  'google_business_profile_hygiene',
  'seasonal_hours',
  'service_menu_changes',
  'analytics_contact_flow_check',
  'hosting_subscription_status'
]);

const planItemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    title: { type: 'string' },
    why: { type: 'string' },
    action: { type: 'string' },
    dueAt: { type: 'string' },
    priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
    channel: { type: 'string', enum: ['agentmail', 'portal', 'operator', 'phone'] },
    owner: { type: 'string' },
    evidenceIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
    idempotencyKey: { type: 'string' },
    messageIntent: { type: 'string' },
    risk: { type: 'object' }
  },
  required: ['id', 'kind', 'title', 'why', 'action', 'dueAt', 'priority', 'channel', 'owner', 'evidenceIds', 'idempotencyKey']
};

export const AccountManagerPlanJsonSchema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string' },
    leadId: { type: 'string' },
    generatedAt: { type: 'string' },
    promisedEdits: { type: 'array', items: planItemSchema },
    staleFactsToRecheck: { type: 'array', items: planItemSchema },
    launchFollowup: { type: 'array', items: planItemSchema },
    reviewCapture: { type: 'array', items: planItemSchema },
    googleBusinessProfileHygiene: { type: 'array', items: planItemSchema },
    seasonalHours: { type: 'array', items: planItemSchema },
    serviceMenuChanges: { type: 'array', items: planItemSchema },
    analyticsContactFlowCheck: { type: 'array', items: planItemSchema },
    hostingSubscriptionStatus: { type: 'array', items: planItemSchema },
    tasks: { type: 'array', items: planItemSchema },
    evidence: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          summary: { type: 'string' },
          url: { type: 'string', nullable: true },
          confidence: { type: 'number' },
          createdAt: { type: 'string', nullable: true }
        },
        required: ['id', 'source', 'summary', 'url', 'confidence']
      }
    },
    risk: {
      type: 'object',
      properties: {
        optOut: { type: 'boolean' },
        unsupportedHandoff: { type: 'boolean' },
        frequencyCapHours: { type: 'number' },
        notes: { type: 'array', items: { type: 'string' } }
      },
      required: ['optOut', 'unsupportedHandoff', 'frequencyCapHours', 'notes']
    },
    unsupportedFlags: { type: 'array', items: { type: 'string' } }
  },
  required: [
    'schemaVersion',
    'leadId',
    'generatedAt',
    ...ACCOUNT_MANAGER_SECTION_KEYS,
    'tasks',
    'evidence',
    'risk',
    'unsupportedFlags'
  ]
};

export function emptyAccountManagerPlan({ leadId, generatedAt = new Date().toISOString(), frequencyCapHours = 120 } = {}) {
  return {
    schemaVersion: 'account_manager_plan.v1',
    leadId: leadId || null,
    generatedAt,
    ...Object.fromEntries(ACCOUNT_MANAGER_SECTION_KEYS.map((key) => [key, []])),
    tasks: [],
    evidence: [],
    risk: {
      optOut: false,
      unsupportedHandoff: false,
      frequencyCapHours,
      notes: []
    },
    unsupportedFlags: []
  };
}

export function collectAccountTasks(plan) {
  if (!plan) return [];
  const fromSections = ACCOUNT_MANAGER_SECTION_KEYS.flatMap((section) => (
    Array.isArray(plan[section])
      ? plan[section].map((item) => ({ ...item, section }))
      : []
  ));
  const explicit = Array.isArray(plan.tasks) ? plan.tasks : [];
  const byKey = new Map();
  for (const task of [...fromSections, ...explicit]) {
    const key = task.idempotencyKey || task.id;
    if (key && !byKey.has(key)) byKey.set(key, task);
  }
  return [...byKey.values()];
}
