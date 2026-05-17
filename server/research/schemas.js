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
  'presenceConfidence'
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
        required: ['sourceType', 'sourceUrl', 'field', 'evidenceText'],
        properties: {
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
