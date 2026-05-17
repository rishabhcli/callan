import { generateBuildRevisionPlan } from '../../gemini.js';

export async function createRevisionPlan({ brief, qaResult, attempt = 0 }) {
  const failed = failedChecklistItems(qaResult);
  const fallback = fallbackRevisionPrompt({ brief, qaResult, failed, attempt });

  try {
    const plan = await generateBuildRevisionPlan({ brief, qaResult, failed, attempt, fallbackPrompt: fallback });
    if (plan?.prompt && String(plan.prompt).trim().length > 20) {
      return normalizePlan(plan, fallback, failed, attempt);
    }
  } catch {
    // The deterministic fallback keeps mock/test mode on the same path without requiring Gemini.
  }

  return normalizePlan({ prompt: fallback, focus: failed.map((item) => item.key), riskLevel: 'low' }, fallback, failed, attempt);
}

function fallbackRevisionPrompt({ brief, qaResult, failed, attempt }) {
  const missing = failed.length
    ? failed.map((item) => `- ${item.label}: ${item.detail || 'not satisfied'}`).join('\n')
    : '- QA failed without a specific checklist item; re-check business facts and contact visibility.';
  const services = (brief.services || []).slice(0, 6).join(', ');
  return [
    `Revision ${attempt + 1}: fix only the failed website QA items for ${brief.businessName}.`,
    '',
    'Do not redesign the whole site. Make targeted changes and preserve the existing style.',
    '',
    'Failed QA:',
    missing,
    '',
    'Required facts:',
    `- Business name: ${brief.businessName}`,
    `- Phone/contact: ${brief.phone}`,
    `- Location/service area: ${brief.locationOrServiceArea}`,
    `- Services: ${services}`,
    `- Primary CTA: ${brief.cta}`,
    '',
    `Guardrails: ${brief.prohibitedClaims.join(' ')}`
  ].join('\n');
}

function normalizePlan(plan, fallback, failed, attempt) {
  return {
    prompt: String(plan.prompt || fallback).trim(),
    focus: Array.isArray(plan.focus) && plan.focus.length ? plan.focus : failed.map((item) => item.key),
    expectedFixes: Array.isArray(plan.expectedFixes) ? plan.expectedFixes : failed.map((item) => item.label),
    riskLevel: plan.riskLevel || (failed.some((item) => item.severity === 'blocker') ? 'high' : 'medium'),
    attempt,
    generatedAt: Date.now(),
    source: plan.source || 'deterministic'
  };
}

function failedChecklistItems(qaResult) {
  return (qaResult?.checklist || [])
    .filter((item) => !item.passed)
    .map((item) => ({
      key: item.key,
      label: item.label || item.key,
      detail: item.detail || '',
      severity: item.severity || 'warn'
    }));
}
