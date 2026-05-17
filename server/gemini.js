import {
  generateJson,
  generateStructuredText,
  generateText,
  smokeGeminiGenerate,
  geminiConfigured,
  geminiReadinessDetails
} from './providers/gemini.js';

export {
  generateJson,
  generateStructuredText,
  generateText,
  smokeGeminiGenerate,
  geminiConfigured,
  geminiReadinessDetails
};
export { generateStructured } from './reasoning/geminiReasoner.js';

const BuildRevisionPlanSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    focus: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    expectedFixes: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
    source: { type: 'string' }
  },
  required: ['prompt', 'focus', 'expectedFixes', 'riskLevel']
};

export async function generateBuildRevisionPlan({ brief, qaResult, failed = [], attempt = 0, fallbackPrompt }) {
  if (!geminiConfigured().configured) {
    return {
      prompt: fallbackPrompt,
      focus: failed.map((item) => item.key),
      expectedFixes: failed.map((item) => item.label || item.key),
      riskLevel: failed.some((item) => item.severity === 'blocker') ? 'high' : 'medium',
      source: 'fallback_no_gemini'
    };
  }

  const prompt = [
    'Create a concise Lovable revision prompt for a generated small-business website.',
    'The revision must be targeted: fix failed QA items only, preserve the existing design, and do not invent facts.',
    '',
    `Business: ${brief.businessName}`,
    `Phone: ${brief.phone}`,
    `Location/service area: ${brief.locationOrServiceArea}`,
    `Services: ${(brief.services || []).join(', ')}`,
    `CTA: ${brief.cta}`,
    `Guardrails: ${(brief.prohibitedClaims || []).join(' ')}`,
    '',
    `Failed QA JSON: ${safeStringify(failed)}`,
    `QA summary: ${safeStringify({ errors: qaResult?.errors || [], checklist: qaResult?.checklist || [] })}`,
    '',
    'Return JSON only. The prompt must be ready to paste into Lovable.'
  ].join('\n');

  return generateJson({
    prompt,
    schema: BuildRevisionPlanSchema,
    systemInstruction: 'You write tight, factual website revision prompts. You never add unsupported business claims.',
    thinkingLevel: 'low',
    flash: true
  });
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
