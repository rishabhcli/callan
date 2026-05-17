import { z } from 'zod';

export const ProfileFieldProvenance = z.object({
  value: z.string().nullable(),
  source: z.enum(['source_text', 'candidate', 'provided', 'model', 'mock', 'repair', 'none']),
  sourceUrl: z.string().nullable(),
  evidence: z.string().nullable()
});

export const ProfileProvenance = z.object({
  profileSource: z.enum(['live_browser', 'gemini_mock', 'provided', 'memory_write', 'memory_repair', 'unknown']),
  sourceUrl: z.string().nullable(),
  yelpUrl: z.string().nullable(),
  capturedAt: z.string().nullable(),
  phone: ProfileFieldProvenance,
  address: ProfileFieldProvenance
});

export const OnlinePresenceEvidence = z.object({
  website: z.object({
    found: z.boolean(),
    url: z.string().nullable(),
    evidence: z.array(z.string()).max(5)
  }),
  social: z.object({
    found: z.boolean(),
    platforms: z.array(z.string()).max(8),
    urls: z.array(z.string()).max(8),
    evidence: z.array(z.string()).max(5)
  }),
  listings: z.object({
    found: z.boolean(),
    platforms: z.array(z.string()).max(8),
    urls: z.array(z.string()).max(8),
    evidence: z.array(z.string()).max(5)
  }),
  gaps: z.array(z.string()).max(8),
  positiveSignals: z.array(z.string()).max(8)
});

export const BusinessProfile = z.object({
  businessName: z.string(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string(),
  niche: z.string(),
  hasWebsite: z.boolean(),
  websiteUrl: z.string().nullable(),
  onlinePresenceStrength: z.enum(['none', 'weak', 'mixed', 'strong']),
  presenceConfidence: z.number().optional(),
  onlinePresenceSummary: z.string(),
  onlinePresenceEvidence: OnlinePresenceEvidence,
  onlinePresenceReasons: z.array(z.string()).max(8),
  onlinePresenceConfidence: z.number(),
  notWorthCallingReason: z.string().nullable(),
  callRecommendation: z.object({
    shouldCall: z.boolean(),
    notWorthCalling: z.boolean(),
    whyCall: z.string().nullable(),
    whyNotCall: z.string().nullable()
  }).optional(),
  ownerHypothesis: z.string().nullable(),
  customerPersona: z.string().nullable(),
  hours: z.string().nullable(),
  services: z.array(z.string()).max(8),
  whatTheyDo: z.string(),
  needs: z.array(z.string()).max(6),
  signals: z.array(z.string()).max(8),
  bestContactEmail: z.string().nullable(),
  yelpUrl: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  sourceUrls: z.array(z.string()).max(10).optional(),
  sourceProvenance: z.object({
    phone: z.string().nullable(),
    address: z.string().nullable(),
    website: z.string().nullable(),
    profile: z.string()
  }).optional(),
  provenance: ProfileProvenance
});
export const BusinessProfileSchema = jsonSchema(BusinessProfile);

export const SalesPitch = z.object({
  openingLine: z.string(),
  valueProp: z.string(),
  discoveryQuestions: z.array(z.string()).length(3),
  objections: z.array(
    z.object({
      objection: z.string(),
      response: z.string()
    })
  ).min(3).max(6),
  close: z.string(),
  emailAsk: z.string().describe('Question used after a yes to collect and confirm the invoice email.'),
  invoiceClose: z.string().describe('One sentence explaining that AgentMail will send the invoice and can handle replies.'),
  beginMessage: z.string().describe('Recording disclosure + greeting. Spoken first.')
});
export const SalesPitchSchema = jsonSchema(SalesPitch);

export const PostMortem = z.object({
  outcome: z.enum(['won', 'lost', 'callback', 'unreachable']),
  reason: z.string(),
  whatWorked: z.array(z.string()).max(5),
  whatToTryNext: z.array(z.string()).max(5),
  replayMoments: z.array(
    z.object({
      ts: z.number(),
      excerpt: z.string(),
      note: z.string()
    })
  ).max(5),
  invoiceEmail: z.string().nullable(),
  confirmedEmail: z.boolean(),
  customerQuestions: z.array(z.string()).max(5),
  followupEmailDraft: z.string().nullable()
});
export const PostMortemSchema = jsonSchema(PostMortem);

export const CandidateList = z.object({
  candidates: z.array(
    z.object({
      businessName: z.string(),
      yelpUrl: z.string().nullable(),
      phoneHint: z.string().nullable(),
      addressHint: z.string().nullable()
    })
  ).max(10)
});
export const CandidateListSchema = jsonSchema(CandidateList);

export const DiscoverRequest = z.object({
  niche: z.string().min(2),
  city: z.string().min(2),
  count: z.number().int().min(1).max(8).default(4)
});

export const CallRequest = z.object({
  leadId: z.string(),
  toPhone: z.string().optional()
});

export const FollowupRequest = z.object({
  leadId: z.string(),
  toEmail: z.string().email()
});

export const BuildRequest = z.object({
  leadId: z.string()
});

function jsonSchema(zodSchema) {
  return zodToSchema(zodSchema);
}

function zodToSchema(s) {
  if (s instanceof z.ZodObject) {
    const shape = s.shape;
    const properties = {};
    const required = [];
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodToSchema(v);
      if (!v.isOptional()) required.push(k);
    }
    return { type: 'object', properties, required };
  }
  if (s instanceof z.ZodArray) {
    const def = s._def;
    const out = { type: 'array', items: zodToSchema(def.type) };
    if (def.exactLength) out.minItems = def.exactLength.value, out.maxItems = def.exactLength.value;
    if (def.minLength) out.minItems = def.minLength.value;
    if (def.maxLength) out.maxItems = def.maxLength.value;
    return out;
  }
  if (s instanceof z.ZodEnum) return { type: 'string', enum: s._def.values };
  if (s instanceof z.ZodString) return { type: 'string' };
  if (s instanceof z.ZodNumber) {
    const def = s._def;
    const out = { type: def.checks?.some((c) => c.kind === 'int') ? 'integer' : 'number' };
    return out;
  }
  if (s instanceof z.ZodBoolean) return { type: 'boolean' };
  if (s instanceof z.ZodNullable) {
    const inner = zodToSchema(s._def.innerType);
    return { ...inner, nullable: true };
  }
  if (s instanceof z.ZodOptional) {
    return zodToSchema(s._def.innerType);
  }
  if (s instanceof z.ZodDefault) {
    return zodToSchema(s._def.innerType);
  }
  if (s instanceof z.ZodLiteral) {
    return { const: s._def.value };
  }
  return {};
}
