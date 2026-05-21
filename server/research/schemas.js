export const SOURCE_TYPES = Object.freeze(['search', 'directory', 'website', 'social', 'maps']);

export const LEAD_EVIDENCE_REQUIRED_FIELDS = Object.freeze([
  'businessName',
  'phone',
  'address',
  'hours',
  'websiteUrl',
  'socialUrls',
  'services',
  'reviews',
  'sourceEvidence',
  'onlinePresenceStrength',
  'presenceConfidence',
  'leadIntelligence'
]);

export const LeadEvidenceSchema = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: LEAD_EVIDENCE_REQUIRED_FIELDS,
  properties: {
    businessName: { type: 'string', description: 'Exact public business name from the source.' },
    phone: { type: 'string', nullable: true, description: 'Public phone number, or null if not visible.' },
    address: { type: 'string', nullable: true, description: 'Public address, or null if not visible.' },
    hours: { type: 'string', nullable: true, description: 'Visible hours as compact text, or null.' },
    websiteUrl: { type: 'string', nullable: true, description: 'Owned business website URL, or null if none is visible.' },
    socialUrls: {
      type: 'array',
      items: { type: 'string' },
      description: 'Public social profile URLs found for this business.'
    },
    services: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete services/products visible from the source.'
    },
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['source', 'summary'],
        properties: {
          source: { type: 'string' },
          rating: { type: 'number', nullable: true },
          count: { type: 'integer', nullable: true },
          summary: { type: 'string' },
          sourceUrl: { type: 'string', nullable: true }
        }
      }
    },
    sourceEvidence: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'sourceType', 'sourceUrl', 'field', 'evidenceText'],
        properties: {
          id: { type: 'string', description: 'Stable evidence id used by every downstream claim.' },
          sourceId: { type: 'string', nullable: true, description: 'Stable source id when different from evidence id.' },
          sourceType: { type: 'string', enum: SOURCE_TYPES },
          sourceUrl: { type: 'string' },
          field: { type: 'string' },
          value: { type: 'string', nullable: true },
          evidenceText: { type: 'string' },
          capturedAt: { type: 'string', nullable: true }
        }
      }
    },
    onlinePresenceStrength: {
      type: 'string',
      enum: ['none', 'weak', 'mixed', 'strong'],
      description: 'Whether the business already has a strong customer-facing online presence.'
    },
    presenceConfidence: {
      type: 'number',
      minimum: 0,
      maximum: 1
    },
    leadRecommendation: {
      type: 'string',
      nullable: true,
      description: 'Short reason to call or skip.'
    },
    leadIntelligence: {
      type: 'object',
      additionalProperties: true,
      required: [
        'evidence',
        'reviewThemes',
        'positiveProof',
        'complaintsPainPoints',
        'missingCustomerInfo',
        'competitorComparison',
        'currentWebsiteIssues',
        'socialListingConsistency',
        'contactConfidence',
        'bestCtaRecommendation',
        'whyThisLeadIsWorthCalling',
        'doNotCallBecauseAlreadyStrong',
        'scores',
        'callOpener'
      ],
      properties: {
        evidence: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['id', 'sourceId', 'sourceType', 'sourceUrl', 'claim', 'quote', 'confidence'],
            properties: {
              id: { type: 'string' },
              sourceId: { type: 'string' },
              sourceType: { type: 'string' },
              sourceUrl: { type: 'string' },
              claim: { type: 'string' },
              quote: { type: 'string' },
              confidence: { type: 'number' }
            }
          }
        },
        reviewThemes: { type: 'array', items: citedClaimSchema('Review themes mined from reviews/listings.') },
        positiveProof: { type: 'array', items: citedClaimSchema('Public proof that makes the lead real.') },
        complaintsPainPoints: { type: 'array', items: citedClaimSchema('Complaints, pain points, or hesitation triggers.') },
        missingCustomerInfo: { type: 'array', items: citedClaimSchema('Missing customer info customers would ask for.') },
        competitorComparison: { type: 'array', items: citedClaimSchema('Competitor gap or market comparison.') },
        currentWebsiteIssues: { type: 'array', items: citedClaimSchema('Current website or owned-presence issue.') },
        socialListingConsistency: { type: 'array', items: citedClaimSchema('NAP/social/listing consistency finding.') },
        contactConfidence: {
          type: 'object',
          additionalProperties: true,
          properties: {
            hours: contactConfidenceSchema(),
            address: contactConfidenceSchema(),
            phone: contactConfidenceSchema()
          }
        },
        bestCtaRecommendation: citedClaimSchema('Best CTA recommendation.'),
        whyThisLeadIsWorthCalling: citedClaimSchema('Reason the cold call is earned.'),
        doNotCallBecauseAlreadyStrong: {
          type: 'object',
          additionalProperties: true,
          required: ['skip', 'reason', 'evidenceIds'],
          properties: {
            skip: { type: 'boolean' },
            reason: { type: 'string', nullable: true },
            evidenceIds: { type: 'array', items: { type: 'string' } }
          }
        },
        scores: {
          type: 'object',
          additionalProperties: true,
          required: ['presenceWeakness', 'urgency', 'websiteValue', 'contactability', 'verticalFit', 'totalScore'],
          properties: {
            presenceWeakness: scoreSchema(),
            urgency: scoreSchema(),
            websiteValue: scoreSchema(),
            contactability: scoreSchema(),
            verticalFit: scoreSchema(),
            totalScore: { type: 'integer' }
          }
        },
        callOpener: {
          type: 'object',
          additionalProperties: true,
          required: ['text', 'evidenceIds'],
          properties: {
            text: { type: 'string' },
            evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
            sourceIds: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    }
  }
});

export const BrowserResearchOutputSchema = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: ['leads'],
  properties: {
    leads: {
      type: 'array',
      items: LeadEvidenceSchema
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          businessName: { type: 'string', nullable: true },
          sourceUrl: { type: 'string', nullable: true },
          reason: { type: 'string' }
        }
      }
    }
  }
});

export function validateSourceType(value) {
  return SOURCE_TYPES.includes(value) ? value : 'search';
}

export function requiredLeadEvidenceFields() {
  return [...LEAD_EVIDENCE_REQUIRED_FIELDS];
}

function citedClaimSchema(description) {
  return {
    type: 'object',
    description,
    additionalProperties: true,
    required: ['id', 'summary', 'evidenceIds'],
    properties: {
      id: { type: 'string' },
      title: { type: 'string', nullable: true },
      claim: { type: 'string', nullable: true },
      summary: { type: 'string' },
      evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } },
      sourceIds: { type: 'array', items: { type: 'string' } },
      sourceUrls: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'number' }
    }
  };
}

function contactConfidenceSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['value', 'confidence', 'evidenceIds'],
    properties: {
      value: { type: 'string', nullable: true },
      confidence: { type: 'number' },
      evidenceIds: { type: 'array', items: { type: 'string' } },
      note: { type: 'string' }
    }
  };
}

function scoreSchema() {
  return {
    type: 'object',
    additionalProperties: true,
    required: ['score', 'reason', 'evidenceIds'],
    properties: {
      score: { type: 'integer' },
      reason: { type: 'string' },
      evidenceIds: { type: 'array', items: { type: 'string' } }
    }
  };
}
