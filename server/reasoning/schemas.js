import { z } from 'zod';
import { BusinessProfile as ExistingBusinessProfile } from '../types.js';

const EvidenceItem = z.object({
  source: z.string().describe('Evidence source label, URL, transcript turn, or provider event.'),
  quote: z.string().describe('Short excerpt from the provided evidence.'),
  weight: z.enum(['low', 'medium', 'high']).describe('How strongly this evidence supports the decision.')
}).strict();

const NextAction = z.object({
  code: z.string().describe('Machine-readable action code.'),
  label: z.string().describe('Short operator-facing label.'),
  reason: z.string().describe('Why this action is next.')
}).strict();

const Objection = z.object({
  objection: z.string(),
  response: z.string()
}).strict();

export const BusinessProfile = ExistingBusinessProfile;

export const PresenceScore = z.object({
  onlinePresenceStrength: z.enum(['none', 'weak', 'mixed', 'strong']),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  hasOwnedWebsite: z.boolean(),
  shouldCall: z.boolean(),
  notWorthCallingReason: z.string().nullable(),
  gaps: z.array(z.string()).max(8),
  positiveSignals: z.array(z.string()).max(8),
  evidence: z.array(EvidenceItem).max(8)
}).strict().describe('PresenceScore');

export const SalesStrategy = z.object({
  qualified: z.boolean(),
  qualification: z.enum(['high_fit', 'medium_fit', 'low_fit', 'do_not_call']),
  confidence: z.number().min(0).max(1),
  offerAngle: z.string(),
  whyNow: z.string(),
  painPoints: z.array(z.string()).min(1).max(6),
  proofPoints: z.array(z.string()).max(6),
  discoveryFocus: z.array(z.string()).min(1).max(5),
  risks: z.array(z.string()).max(5),
  nextBestAction: NextAction,
  sourceEvidence: z.array(EvidenceItem).max(8)
}).strict().describe('SalesStrategy');

export const CallScript = z.object({
  openingLine: z.string(),
  valueProp: z.string(),
  discoveryQuestions: z.array(z.string()).length(3),
  objections: z.array(Objection).min(3).max(6),
  close: z.string(),
  emailAsk: z.string(),
  emailReadbackInstruction: z.string(),
  invoiceClose: z.string(),
  beginMessage: z.string(),
  strategySummary: z.string(),
  confidence: z.number().min(0).max(1),
  sourceEvidence: z.array(EvidenceItem).max(8)
}).strict().describe('CallScript');

export const ObjectionPlan = z.object({
  primaryObjections: z.array(Objection).min(3).max(8),
  escalationRules: z.array(z.object({
    trigger: z.string(),
    response: z.string(),
    stopCondition: z.string()
  }).strict()).max(6),
  confidence: z.number().min(0).max(1),
  sourceEvidence: z.array(EvidenceItem).max(8)
}).strict().describe('ObjectionPlan');

export const CallAnalysis = z.object({
  outcome: z.enum(['won', 'lost', 'callback', 'unreachable']),
  reason: z.string(),
  failureReason: z.string().nullable(),
  whatWorked: z.array(z.string()).max(5),
  whatToTryNext: z.array(z.string()).max(5),
  replayMoments: z.array(z.object({
    ts: z.number(),
    excerpt: z.string(),
    note: z.string()
  }).strict()).max(5),
  invoiceEmail: z.string().nullable(),
  confirmedEmail: z.boolean(),
  customerQuestions: z.array(z.string()).max(5),
  nextBestAction: NextAction,
  followupEmailDraft: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  sourceEvidence: z.array(EvidenceItem).max(8)
}).strict().describe('CallAnalysis');

export const EmailReplyDecision = z.object({
  schemaVersion: z.number().int(),
  kind: z.enum(['supported', 'handoff', 'opt_out', 'unknown']),
  scope: z.string(),
  scopes: z.array(z.string()).max(8),
  supported: z.boolean(),
  operatorFlag: z.boolean(),
  replyMode: z.enum(['autonomous_reply', 'safe_handoff', 'opt_out_confirmation', 'needs_policy_check']),
  reason: z.string(),
  matches: z.object({
    supported: z.array(z.string()).max(8),
    unsupported: z.array(z.string()).max(8)
  }).strict(),
  replyText: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  supportedScopes: z.array(z.string()).max(12),
  unsupportedScopes: z.array(z.string()).max(12),
  sourceEvidence: z.array(EvidenceItem).max(8)
}).strict().describe('EmailReplyDecision');

export const WebsiteBrief = z.object({
  schemaVersion: z.number().int().min(2).default(2),
  brief: z.string(),
  businessName: z.string(),
  targetCustomer: z.string(),
  pages: z.array(z.object({
    name: z.string(),
    path: z.string(),
    goal: z.string(),
    sections: z.array(z.string()).min(1).max(8)
  }).strict()).min(1).max(6),
  hero: z.object({
    headline: z.string(),
    subheadline: z.string(),
    primaryCta: z.string(),
    secondaryCta: z.string().nullable().optional(),
    proofLine: z.string().nullable().optional()
  }).strict(),
  sections: z.array(z.object({
    name: z.string(),
    goal: z.string(),
    content: z.array(z.string()).min(1).max(6)
  }).strict()).min(3).max(8),
  services: z.array(z.object({
    name: z.string(),
    description: z.string(),
    cta: z.string().nullable().optional()
  }).strict()).min(1).max(8),
  reviewProof: z.object({
    status: z.enum(['evidence_backed', 'limited']),
    items: z.array(z.string()).max(6),
    disclaimer: z.string()
  }).strict(),
  location: z.object({
    city: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    serviceArea: z.string(),
    hours: z.string().nullable().optional()
  }).strict(),
  cta: z.object({
    primaryLabel: z.string(),
    primaryHref: z.string(),
    secondaryLabel: z.string().nullable().optional(),
    secondaryHref: z.string().nullable().optional()
  }).strict(),
  contactMethods: z.array(z.object({
    type: z.enum(['phone', 'email', 'form', 'booking', 'other']),
    label: z.string(),
    value: z.string(),
    href: z.string().nullable().optional()
  }).strict()).min(1).max(6),
  commerceNeeds: z.array(z.object({
    key: z.string(),
    status: z.string(),
    detail: z.string()
  }).strict()).max(8),
  commerceCta: z.object({
    label: z.string(),
    behavior: z.enum(['lead_form', 'operator_handoff', 'none']),
    paymentLinkUrl: z.string().nullable(),
    note: z.string()
  }).strict().nullable().optional(),
  commerceSections: z.array(z.object({
    name: z.string(),
    goal: z.string(),
    content: z.array(z.string()).min(1).max(6),
    noFakeCheckoutLinks: z.boolean()
  }).strict()).max(6).optional(),
  commerceRiskFlags: z.array(z.string()).max(10).optional(),
  assets: z.array(z.object({
    type: z.string(),
    alt: z.string(),
    url: z.string().nullable().optional(),
    caption: z.string().nullable().optional()
  }).strict()).min(1).max(8),
  disclaimers: z.array(z.string()).max(10),
  style: z.object({
    tone: z.string(),
    palette: z.string(),
    layout: z.string()
  }).strict(),
  factualClaims: z.array(z.string()).max(10),
  omittedClaims: z.array(z.string()).max(10),
  customerQuestions: z.array(z.string()).max(6),
  confidence: z.number().min(0).max(1),
  sourceEvidence: z.array(EvidenceItem).max(8)
}).strict().describe('WebsiteBrief');

export const GrowthPlan = z.object({
  stage: z.enum(['pre_call', 'sold', 'paid', 'built', 'retention']),
  positioning: z.string(),
  targetSegments: z.array(z.string()).min(1).max(5),
  acquisitionChannels: z.array(z.object({
    channel: z.string(),
    rationale: z.string(),
    firstExperiment: z.string()
  }).strict()).min(1).max(6),
  upsellPath: z.array(z.string()).max(6),
  risks: z.array(z.string()).max(6),
  nextActions: z.array(NextAction).min(1).max(6),
  confidence: z.number().min(0).max(1),
  sourceEvidence: z.array(EvidenceItem).max(8)
}).strict().describe('GrowthPlan');

export const ScheduleCallDecision = z.object({
  wantsCall: z.boolean().describe('True if the reply requests a scheduled callback.'),
  isCancel: z.boolean().describe('True if the reply asks to cancel a previously scheduled call.'),
  scheduledAtIso: z.string().nullable().describe('Customer-requested time as an ISO-8601 timestamp WITH offset, or null if no time given.'),
  scheduledAtRaw: z.string().describe('Verbatim phrase from the reply that named the time, e.g., "today at 5:14pm".'),
  ask: z.string().describe('1-2 sentence summary of what the customer wants to discuss on the call.'),
  reason: z.string().describe('One sentence explaining the classification.'),
  confidence: z.number().min(0).max(1),
  sourceEvidence: z.array(EvidenceItem).max(4)
}).strict().describe('ScheduleCallDecision');

export const PreviewRecap = z.object({
  body: z.string().describe('50-100 word email paragraph telling the customer we just kicked off their build, written like a teammate texting a quick update. NO greeting line, NO signature, NO live URL, NO markdown.'),
  citations: z.array(z.object({
    source: z.enum(['website_brief', 'post_mortem', 'profile', 'lead']).describe('Where this fact came from.'),
    fact: z.string().describe('The specific concrete detail you cited in the body (e.g. "Tuesday-Thursday booking gap", "the hot lather shave", "section about your fade specialists"). Must appear verbatim or near-verbatim in the body.')
  }).strict()).min(2).max(5).describe('At least 2 concrete details cited in the body. No vague adjectives.'),
  confidence: z.number().min(0).max(1)
}).strict().describe('PreviewRecap');

export const PreviewRecapCritique = z.object({
  specificity: z.number().min(0).max(1).describe('0 = pure boilerplate, 1 = handcrafted with specific facts. Penalize generic adjectives ("unique vibe", "translates perfectly", "comes together"), reward concrete proper nouns and verbatim quotes from the data.'),
  fillerPhrases: z.array(z.string()).max(8).describe('Verbatim filler phrases detected in the draft (≤6 words each).'),
  critique: z.string().describe('One-sentence assessment of what makes the draft generic vs. handcrafted.'),
  rewrite: z.string().nullable().describe('A more-specific rewrite that strictly references the supplied data. Null if specificity ≥ 0.7.')
}).strict().describe('PreviewRecapCritique');

export const InvoiceAffirmation = z.object({
  confirmed: z.boolean().describe('True if the customer is approving the invoice/quoted scope and signaling we should kick off the build now.'),
  scope: z.enum(['affirm', 'question', 'revision', 'price_pushback', 'negation', 'other']).describe('Best label for the reply intent.'),
  confidence: z.number().min(0).max(1),
  excerpt: z.string().describe('Verbatim phrase from the reply that drove the decision (≤120 chars).'),
  reason: z.string().describe('One short sentence explaining the classification.'),
  sourceEvidence: z.array(EvidenceItem).max(4)
}).strict().describe('InvoiceAffirmation');

export const ComplianceDecision = z.object({
  allowed: z.boolean(),
  decisionCode: z.string(),
  decisionReason: z.string(),
  channel: z.enum(['phone', 'email', 'payment', 'build', 'webhook', 'internal']),
  policyFlags: z.array(z.string()).max(10),
  requiredGate: z.string().nullable(),
  nextBestAction: NextAction,
  confidence: z.number().min(0).max(1),
  sourceEvidence: z.array(EvidenceItem).max(8)
}).strict().describe('ComplianceDecision');

export const reasoningSchemas = {
  businessProfile: { schema: BusinessProfile, schemaName: 'BusinessProfile' },
  presenceScore: { schema: PresenceScore, schemaName: 'PresenceScore' },
  salesStrategy: { schema: SalesStrategy, schemaName: 'SalesStrategy' },
  callScript: { schema: CallScript, schemaName: 'CallScript' },
  objectionPlan: { schema: ObjectionPlan, schemaName: 'ObjectionPlan' },
  callAnalysis: { schema: CallAnalysis, schemaName: 'CallAnalysis' },
  emailReplyDecision: { schema: EmailReplyDecision, schemaName: 'EmailReplyDecision' },
  websiteBrief: { schema: WebsiteBrief, schemaName: 'WebsiteBrief' },
  growthPlan: { schema: GrowthPlan, schemaName: 'GrowthPlan' },
  complianceDecision: { schema: ComplianceDecision, schemaName: 'ComplianceDecision' },
  scheduleCallDecision: { schema: ScheduleCallDecision, schemaName: 'ScheduleCallDecision' },
  invoiceAffirmation: { schema: InvoiceAffirmation, schemaName: 'InvoiceAffirmation' },
  previewRecap: { schema: PreviewRecap, schemaName: 'PreviewRecap' },
  previewRecapCritique: { schema: PreviewRecapCritique, schemaName: 'PreviewRecapCritique' }
};

export function schemaForKind(kind) {
  const found = reasoningSchemas[kind];
  if (!found) throw new Error(`unknown reasoning schema kind: ${kind}`);
  return found;
}

export function toGeminiJsonSchema(schema) {
  const json = zodToGeminiSchema(schema);
  return stripEmpty({
    ...json,
    additionalProperties: false
  });
}

function zodToGeminiSchema(schema) {
  const description = schema.description || schema._def?.description;
  const withDescription = (value) => description ? { ...value, description } : value;

  if (schema instanceof z.ZodObject) {
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(schema.shape)) {
      properties[key] = zodToGeminiSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return withDescription({
      type: 'object',
      properties,
      required,
      additionalProperties: false
    });
  }

  if (schema instanceof z.ZodArray) {
    const def = schema._def;
    const out = { type: 'array', items: zodToGeminiSchema(def.type) };
    if (def.exactLength) {
      out.minItems = def.exactLength.value;
      out.maxItems = def.exactLength.value;
    }
    if (def.minLength) out.minItems = def.minLength.value;
    if (def.maxLength) out.maxItems = def.maxLength.value;
    return withDescription(out);
  }

  if (schema instanceof z.ZodEnum) return withDescription({ type: 'string', enum: schema._def.values });
  if (schema instanceof z.ZodString) return withDescription({ type: 'string' });
  if (schema instanceof z.ZodBoolean) return withDescription({ type: 'boolean' });
  if (schema instanceof z.ZodNumber) {
    const out = { type: schema._def.checks?.some((c) => c.kind === 'int') ? 'integer' : 'number' };
    for (const check of schema._def.checks || []) {
      if (check.kind === 'min') out.minimum = check.value;
      if (check.kind === 'max') out.maximum = check.value;
    }
    return withDescription(out);
  }
  if (schema instanceof z.ZodNullable) {
    return withDescription({ ...zodToGeminiSchema(schema._def.innerType), nullable: true });
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return withDescription(zodToGeminiSchema(schema._def.innerType));
  }
  if (schema instanceof z.ZodLiteral) {
    return withDescription({ const: schema._def.value });
  }

  return withDescription({});
}

function stripEmpty(value) {
  if (Array.isArray(value)) return value.map(stripEmpty);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, stripEmpty(v)])
  );
}
