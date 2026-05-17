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
  brief: z.string(),
  businessName: z.string(),
  targetCustomer: z.string(),
  sections: z.array(z.object({
    name: z.string(),
    goal: z.string(),
    content: z.array(z.string()).min(1).max(6)
  }).strict()).min(3).max(8),
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
  complianceDecision: { schema: ComplianceDecision, schemaName: 'ComplianceDecision' }
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
