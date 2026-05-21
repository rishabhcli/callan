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

export function createCustomerRevisionPlan({ brief, note, attempt = 0, source = 'customer' }) {
  const trimmed = String(note || '').trim();
  const services = (brief?.services || []).slice(0, 6).join(', ');
  const prompt = [
    `Customer revision ${attempt + 1}: apply this requested edit for ${brief?.businessName || 'the customer site'}.`,
    '',
    'Treat this as a targeted revision to the existing generated site, not a full rebuild.',
    'Preserve passed QA items: business name, contact methods, services, LocalBusiness schema, mobile layout, alt text, and no fake claims.',
    '',
    'Customer request:',
    trimmed,
    '',
    'Required facts to preserve:',
    `- Business name: ${brief?.businessName || 'unknown'}`,
    `- Phone/contact: ${brief?.phone || 'unknown'}`,
    `- Location/service area: ${brief?.locationOrServiceArea || 'unknown'}`,
    services ? `- Services: ${services}` : null,
    brief?.cta ? `- Primary CTA: ${brief.cta}` : null,
    '',
    `Guardrails: ${(brief?.prohibitedClaims || []).join(' ')}`
  ].filter(Boolean).join('\n');

  return {
    prompt,
    focus: ['customer_request'],
    expectedFixes: [trimmed],
    riskLevel: /\b(price|guarantee|license|insured|booking|payment|checkout|legal)\b/i.test(trimmed) ? 'high' : 'medium',
    attempt,
    generatedAt: Date.now(),
    source
  };
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
  const seen = new Set();
  return (qaResult?.checklist || [])
    .filter((item) => !item.passed && item.blocksBuild !== false)
    .map((item) => ({
      key: item.key,
      label: item.label || item.key,
      detail: item.detail || '',
      severity: item.severity || 'warn'
    }))
    .filter((item) => {
      const key = item.key || item.label;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
