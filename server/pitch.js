import { z } from 'zod';
import { CallScript, toGeminiJsonSchema } from './reasoning/schemas.js';

export const CallScriptSchema = toGeminiJsonSchema(CallScript);

export const SalesPitchGenerationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    openingLine: { type: 'string' },
    valueProp: { type: 'string' },
    discoveryQuestions: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: { type: 'string' }
    },
    objections: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objection: { type: 'string' },
          response: { type: 'string' }
        },
        required: ['objection', 'response']
      }
    },
    close: { type: 'string' },
    emailAsk: { type: 'string' },
    emailReadbackInstruction: { type: 'string' },
    invoiceClose: { type: 'string' },
    beginMessage: { type: 'string' }
  },
  required: [
    'openingLine',
    'valueProp',
    'discoveryQuestions',
    'objections',
    'close',
    'emailAsk',
    'emailReadbackInstruction',
    'invoiceClose',
    'beginMessage'
  ]
};

const StrictSalesPitch = z.object({
  openingLine: z.string(),
  valueProp: z.string(),
  discoveryQuestions: z.array(z.string()).length(3),
  objections: z.array(z.object({
    objection: z.string(),
    response: z.string()
  }).strict()).min(3).max(6),
  close: z.string(),
  emailAsk: z.string(),
  emailReadbackInstruction: z.string(),
  invoiceClose: z.string(),
  beginMessage: z.string()
}).strict();

export function buildPitchResearchContext({ profile = {}, lead = {} }) {
  const businessName = firstText(profile.businessName, lead.business_name, 'the business');
  const niche = firstText(profile.niche, lead.niche, 'small business');
  const city = firstText(profile.city, lead.city, '');
  const sourceUrl = firstText(profile.sourceUrl, profile.yelpUrl, lead.source_url, lead.website, '');
  const websiteUrl = firstText(profile.websiteUrl, lead.website, '');
  const hasWebsite = typeof profile.hasWebsite === 'boolean' ? profile.hasWebsite : Boolean(websiteUrl);
  const onlinePresenceStrength = firstText(profile.onlinePresenceStrength, hasWebsite ? 'mixed' : 'weak');
  const whatTheyDo = firstText(
    profile.whatTheyDo,
    profile.onlinePresenceSummary,
    `${businessName} is a ${niche}${city ? ` in ${city}` : ''}.`
  );

  return {
    lead: {
      businessName,
      niche,
      city: city || null,
      phonePresent: Boolean(lead.phone || profile.phone),
      address: firstText(profile.address, lead.address, '') || null,
      website: websiteUrl || null,
      sourceUrl: sourceUrl || null
    },
    research: {
      whatTheyDo,
      hasWebsite,
      websiteUrl: websiteUrl || null,
      onlinePresenceStrength,
      onlinePresenceSummary: firstText(profile.onlinePresenceSummary, ''),
      ownerHypothesis: firstText(profile.ownerHypothesis, '') || null,
      customerPersona: firstText(profile.customerPersona, '') || null,
      hours: firstText(profile.hours, '') || null,
      services: textList(profile.services, 8),
      needs: textList(profile.needs, 6),
      signals: textList(profile.signals, 8),
      bestContactEmailKnown: Boolean(profile.bestContactEmail)
    }
  };
}

export function validateGeneratedPitch(raw, { disclosure, profile, lead } = {}) {
  const shaped = parseStrictPitch(raw, 'generated');
  const normalized = normalizePitch(shaped, { disclosure, profile, lead });
  return validatePitch(normalized, { disclosure, source: 'generated.normalized' });
}

export function createFallbackPitch({ disclosure, profile = {}, lead = {} } = {}) {
  const context = buildPitchResearchContext({ profile, lead });
  const businessName = context.lead.businessName;
  const niche = context.lead.niche;
  const cityPhrase = context.lead.city ? ` in ${context.lead.city}` : '';
  const signal = context.research.signals[0] || context.research.needs[0] || context.research.onlinePresenceSummary;
  const websiteGap = context.research.hasWebsite
    ? `I saw you already have some web presence, but a clear focused page can make ${plainList(context.research.needs, 'services, proof, and contact details')} easier for customers to act on.`
    : `I could not find a clear owned website that explains ${plainList(context.research.needs, 'services, proof, and contact details')} for customers.`;
  const concreteSignal = signal
    ? `I noticed ${businessName} ${lowerFirst(signal)}.`
    : `I noticed ${businessName} looks like a real ${niche}${cityPhrase}.`;

  return validatePitch(normalizePitch({
    openingLine: `${concreteSignal} Quick question: would a simple same-day page that shows what you do and how to book help?`,
    valueProp: `${websiteGap} callmemaybe builds a concise single-page site for a flat $500, hosts it, and keeps the copy focused on what customers need before they call or visit.`,
    discoveryQuestions: [
      'What do customers usually ask before they decide to book or visit?',
      'Which service or offer would you most want a new customer to notice first?',
      'Where do most people find you today: Google, Yelp, Instagram, or referrals?'
    ],
    objections: [
      {
        objection: 'I already have a website.',
        response: 'That helps. This is more of a fast conversion page: one clean place for the most important services, proof, and contact step, without replacing anything you already rely on.'
      },
      {
        objection: 'I am too busy.',
        response: 'Totally fair. I only need the best email if you want the invoice; the page can be drafted from the public business info and you can reply with corrections.'
      },
      {
        objection: 'Just send me information.',
        response: 'I can do that through AgentMail. Before I send it, the useful thing to know is whether the $500 flat same-day page is worth considering at all.'
      },
      {
        objection: 'That is too expensive.',
        response: 'I get it. The point is to avoid a drawn-out agency project: one flat $500 page, hosted, with the essentials customers need to choose you.'
      },
      {
        objection: 'I am not interested.',
        response: 'No problem. I do not want to push. If it is not useful, I can let you go.'
      },
      {
        objection: 'Is this a scam?',
        response: 'Reasonable question. The invoice comes from AgentMail, you can reply there with questions, and nothing starts unless you choose to pay it.'
      }
    ],
    close: 'If this sounds useful, I can send the $500 invoice and the project can start from the business details I already found.',
    emailAsk: 'What is the best email for the invoice?',
    emailReadbackInstruction: 'Once the owner says an email address, capture it, tell them the invoice is sending right now, and end the call.',
    invoiceClose: 'AgentMail will send the invoice, and you can reply to that email with questions or corrections.',
    beginMessage: `${disclosure} ${concreteSignal} I wanted to ask one quick website question.`
  }, { disclosure, profile, lead }), { disclosure, source: 'fallback' });
}

export function buildPitchHotStrategy({ pitch = {}, profile = {}, lead = {} } = {}) {
  const context = buildPitchResearchContext({ profile, lead });
  const needs = context.research.needs.length
    ? context.research.needs.join(', ')
    : 'services, proof, and a clear contact step';
  return [
    `Open with this concrete business signal: ${pitch.openingLine || context.research.whatTheyDo}`,
    `Tie the offer to these customer needs: ${needs}.`,
    `Use this value prop when the owner gives you a few seconds: ${pitch.valueProp || 'A focused $500 same-day website can make the next customer action obvious.'}`,
    `Close only after positive intent: ${pitch.close || 'If this sounds useful, ask for the best invoice email and send the invoice.'}`,
    `If the owner agrees, follow this rule exactly: ${pitch.emailReadbackInstruction || 'Once the owner says an email address, capture it, tell them the invoice is sending right now, and end the call.'}. Do NOT ask them to confirm or repeat the email.`
  ].filter(Boolean);
}

function parseStrictPitch(raw, source) {
  const parsed = StrictSalesPitch.safeParse(pickPitchFields(raw));
  if (!parsed.success) {
    throw new Error(`sales pitch ${source} schema failed: ${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

function pickPitchFields(raw = {}) {
  return {
    openingLine: raw.openingLine,
    valueProp: raw.valueProp,
    discoveryQuestions: raw.discoveryQuestions,
    objections: raw.objections,
    close: raw.close,
    emailAsk: raw.emailAsk,
    emailReadbackInstruction: raw.emailReadbackInstruction,
    invoiceClose: raw.invoiceClose,
    beginMessage: raw.beginMessage
  };
}

function validatePitch(pitch, { disclosure, source }) {
  const parsed = StrictSalesPitch.safeParse(pitch);
  if (!parsed.success) {
    throw new Error(`sales pitch ${source} schema failed: ${formatIssues(parsed.error.issues)}`);
  }

  const issues = semanticIssues(parsed.data, disclosure);
  if (issues.length) {
    throw new Error(`sales pitch ${source} validation failed: ${issues.join('; ')}`);
  }
  return parsed.data;
}

function normalizePitch(pitch, { disclosure, profile = {}, lead = {} }) {
  const fallback = createFallbackSkeleton({ disclosure, profile, lead });
  const normalized = {
    openingLine: cleanText(pitch.openingLine, fallback.openingLine),
    valueProp: cleanText(pitch.valueProp, fallback.valueProp),
    discoveryQuestions: pitch.discoveryQuestions.map((q, i) => ensureQuestion(cleanText(q, fallback.discoveryQuestions[i]), fallback.discoveryQuestions[i])),
    objections: pitch.objections.map((item, i) => ({
      objection: cleanText(item.objection, fallback.objections[i % fallback.objections.length].objection),
      response: cleanText(item.response, fallback.objections[i % fallback.objections.length].response)
    })),
    close: cleanText(pitch.close, fallback.close),
    emailAsk: ensureEmailAsk(cleanText(pitch.emailAsk, fallback.emailAsk)),
    emailReadbackInstruction: ensureReadbackInstruction(cleanText(pitch.emailReadbackInstruction, fallback.emailReadbackInstruction)),
    invoiceClose: ensureInvoiceClose(cleanText(pitch.invoiceClose, fallback.invoiceClose)),
    beginMessage: disclosureFirst(cleanText(pitch.beginMessage, fallback.beginMessage), disclosure, fallback.beginMessage)
  };
  return normalized;
}

function createFallbackSkeleton({ disclosure, profile = {}, lead = {} }) {
  const context = buildPitchResearchContext({ profile, lead });
  const businessName = context.lead.businessName;
  const whatTheyDo = context.research.whatTheyDo;
  return {
    openingLine: `I noticed ${businessName} and wanted to ask a quick website question tied to what customers need to know before they choose you.`,
    valueProp: `${businessName} could use a clear single-page website that explains ${whatTheyDo} and gives customers one easy next step. It is a flat $500 and can be ready same day.`,
    discoveryQuestions: [
      'What do customers usually ask before they decide to book or visit?',
      'Which service or offer would you most want a new customer to notice first?',
      'Where do most people find you today: Google, Yelp, Instagram, or referrals?'
    ],
    objections: [
      {
        objection: 'I already have a website.',
        response: 'That helps. This would be a focused conversion page for the clearest services, proof, and contact step, not a long rebuild.'
      },
      {
        objection: 'I am too busy.',
        response: 'Totally fair. If you want it, I can send the invoice and draft from the public business details, then you can reply with corrections.'
      },
      {
        objection: 'Just send me information.',
        response: 'I can send it through AgentMail. The main decision is whether a flat $500 same-day page is worth considering.'
      }
    ],
    close: 'If this sounds useful, I can send the $500 invoice and keep the next step simple.',
    emailAsk: 'What is the best email for the invoice?',
    emailReadbackInstruction: 'Once the owner says an email address, capture it, tell them the invoice is sending right now, and end the call.',
    invoiceClose: 'AgentMail will send the invoice, and you can reply to that email with questions.',
    beginMessage: `${disclosure} I noticed ${businessName} and wanted to ask one quick website question.`
  };
}

function semanticIssues(pitch, disclosure) {
  const issues = [];
  for (const field of ['openingLine', 'valueProp', 'close', 'emailAsk', 'emailReadbackInstruction', 'invoiceClose', 'beginMessage']) {
    if (!pitch[field] || pitch[field].trim().length < 8) issues.push(`${field} is too short`);
  }
  pitch.discoveryQuestions.forEach((q, i) => {
    if (!q.includes('?')) issues.push(`discoveryQuestions[${i}] must be a question`);
  });
  pitch.objections.forEach((item, i) => {
    if (!item.objection || item.objection.trim().length < 4) issues.push(`objections[${i}].objection is too short`);
    if (!item.response || item.response.trim().length < 12) issues.push(`objections[${i}].response is too short`);
  });
  if (disclosure && !pitch.beginMessage.startsWith(`${disclosure} `)) {
    issues.push('beginMessage must start with the exact recording disclosure');
  }
  if (!/record/i.test(pitch.beginMessage)) issues.push('beginMessage must include recording disclosure language');
  if (!/email/i.test(pitch.emailAsk) || !/invoice/i.test(pitch.emailAsk)) {
    issues.push('emailAsk must ask for the invoice email');
  }
  if (/\b(read.{0,20}back|repeat.{0,20}back|confirm|are you sure|is that (?:right|correct))\b/i.test(pitch.emailReadbackInstruction || '')) {
    issues.push('emailReadbackInstruction must NOT ask the customer to confirm — capture the email and send the invoice immediately');
  }
  if (!/AgentMail/i.test(pitch.invoiceClose) || !/reply|question/i.test(pitch.invoiceClose)) {
    issues.push('invoiceClose must mention AgentMail and the reply path');
  }
  return issues;
}

function disclosureFirst(message, disclosure, fallback) {
  if (!disclosure) return cleanText(message, fallback);
  let tail = cleanText(message, fallback);
  if (tail.startsWith(disclosure)) tail = tail.slice(disclosure.length).trim();
  tail = tail.replace(/^[-:,. ]+/, '').trim();
  if (!tail) tail = cleanText(fallback, 'I wanted to ask one quick website question.');
  if (tail.startsWith(disclosure)) tail = tail.slice(disclosure.length).trim();
  return `${disclosure} ${firstSentence(tail)}`;
}

function ensureQuestion(value, fallback) {
  const text = cleanText(value, fallback);
  return text.includes('?') ? text : `${text.replace(/[.!,;:]+$/, '')}?`;
}

function ensureEmailAsk(value) {
  if (/email/i.test(value) && /invoice/i.test(value)) return value;
  return 'What is the best email for the invoice?';
}

function ensureReadbackInstruction(value) {
  const text = String(value || '');
  // Reject any model output that smuggles readback/confirmation language back in;
  // we want the agent to capture the email and send the invoice immediately.
  if (/\b(read.{0,20}back|repeat.{0,20}back|confirm|are you sure|is that (?:right|correct))\b/i.test(text)) {
    return 'Once the owner says an email address, capture it, tell them the invoice is sending right now, and end the call.';
  }
  if (text.length > 12) return text;
  return 'Once the owner says an email address, capture it, tell them the invoice is sending right now, and end the call.';
}

function ensureInvoiceClose(value) {
  if (/AgentMail/i.test(value) && /reply|question/i.test(value)) return value;
  return 'AgentMail will send the invoice, and you can reply to that email with questions.';
}

function firstSentence(text) {
  const cleaned = cleanText(text, 'I wanted to ask one quick website question.');
  const match = cleaned.match(/^(.+?[.!?])(\s|$)/);
  return match ? match[1].trim() : cleaned;
}

function cleanText(value, fallback, max = 900) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const chosen = text || fallback || '';
  return chosen.length > max ? chosen.slice(0, max - 1).trimEnd() : chosen;
}

function textList(value, max) {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item, '')).filter(Boolean).slice(0, max)
    : [];
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value, '');
    if (text) return text;
  }
  return '';
}

function plainList(items, fallback) {
  const clean = textList(items, 3);
  if (clean.length === 0) return fallback;
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(', ')} and ${clean.at(-1)}`;
}

function lowerFirst(text) {
  const clean = cleanText(text, '');
  if (!clean) return clean;
  return clean.charAt(0).toLowerCase() + clean.slice(1);
}

function formatIssues(issues) {
  return issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ');
}
