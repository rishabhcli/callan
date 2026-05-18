import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { reasoningTraces } from '../db.js';
import { emit } from '../sse.js';
import { log } from '../logger.js';
import { generateStructuredText } from '../providers/gemini.js';
import { recordGeminiTokens } from '../costs.js';
import { schemaForKind, toGeminiJsonSchema } from './schemas.js';

const URL_RE = /https?:\/\/[^\s)"'<>]+/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export async function generateStructured({
  kind,
  schema,
  evidence,
  prompt,
  model,
  leadId = null,
  worker = null,
  eventId = null,
  provider = 'gemini',
  schemaName,
  thinkingLevel = 'medium',
  flash = false,
  forceMock = false,
  mockRawOutput,
  validateEvidenceReferences = true
}) {
  const registryEntry = kind ? schemaForKind(kind) : null;
  const zodSchema = schema || registryEntry?.schema;
  const finalSchemaName = schemaName || registryEntry?.schemaName || zodSchema?.description || kind || 'StructuredDecision';
  if (!zodSchema?.safeParse) throw new Error(`reasoning schema for ${kind || finalSchemaName} must be a Zod schema`);

  const started = Date.now();
  const traceBase = {
    leadId,
    worker,
    eventId,
    provider,
    schemaName: finalSchemaName,
    kind: kind || finalSchemaName,
    model: model || (flash ? env.gemini.modelFlash : env.gemini.modelPro),
    prompt,
    evidence,
    source: 'gemini',
    traceKey: traceKey({ leadId, worker, eventId, provider, schemaName: finalSchemaName, kind })
  };

  let rawOutput = null;
  let repairedOutput = null;
  let finalOutput = null;
  let validationErrors = [];
  let firstValidationErrors = [];
  let repairAttempts = 0;
  let usedModel = traceBase.model;
  let source = 'gemini';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    const jsonSchema = toGeminiJsonSchema(zodSchema);
    const fullPrompt = reasoningPrompt({ kind, schemaName: finalSchemaName, prompt, evidence });

    if (mockRawOutput !== undefined) {
      rawOutput = String(mockRawOutput);
      source = 'mock_raw';
      usedModel = model || 'mock-raw';
    } else if (forceMock || !env.gemini.apiKey) {
      rawOutput = JSON.stringify(mockOutputForKind(kind, evidence), null, 2);
      source = 'mock_fallback';
      usedModel = model || 'mock-gemini-structured';
    } else {
      const generated = await generateStructuredText({
        prompt: fullPrompt,
        jsonSchema,
        systemInstruction: systemInstructionFor(finalSchemaName),
        model,
        thinkingLevel,
        flash
      });
      rawOutput = generated.text;
      usedModel = generated.model || usedModel;
      const inputTokens = generated.usage?.inputTokens ?? Math.ceil(String(fullPrompt || '').length / 4);
      const outputTokens = generated.usage?.outputTokens ?? Math.ceil(String(generated.text || '').length / 4);
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
    }

    let validated = parseAndValidateStructuredOutput(zodSchema, rawOutput, evidence, validateEvidenceReferences);
    validationErrors = validated.errors;

    if (!validated.ok) {
      firstValidationErrors = validated.errors;
      repairAttempts = 1;
      const repaired = await repairStructuredOutput({
        kind,
        schemaName: finalSchemaName,
        zodSchema,
        jsonSchema,
        prompt: fullPrompt,
        evidence,
        rawOutput,
        validationErrors,
        model,
        thinkingLevel,
        flash,
        forceMock: forceMock || mockRawOutput !== undefined || !env.gemini.apiKey
      });
      repairedOutput = repaired.text;
      if (repaired.usage) {
        totalInputTokens += repaired.usage.inputTokens || 0;
        totalOutputTokens += repaired.usage.outputTokens || 0;
      }
      validated = parseAndValidateStructuredOutput(zodSchema, repairedOutput, evidence, validateEvidenceReferences);
      validationErrors = [...firstValidationErrors, ...validated.errors];
    }

    if (!validated.ok) {
      throw new Error(`Gemini ${finalSchemaName} validation failed: ${validationErrors.join('; ')}`);
    }

    finalOutput = validated.data;
    const trace = storeTrace({
      ...traceBase,
      model: usedModel,
      source,
      rawOutput,
      repairedOutput,
      finalOutput,
      validationErrors,
      repairAttempts,
      valid: true,
      latencyMs: Date.now() - started,
      totalInputTokens,
      totalOutputTokens
    });
    safeRecordReasoningCost({
      leadId: traceBase.leadId,
      model: usedModel,
      source,
      kind: traceBase.kind || finalSchemaName,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens
    });
    return { output: finalOutput, trace };
  } catch (err) {
    const errors = validationErrors.length ? validationErrors : [err?.message || String(err)];
    const trace = storeTrace({
      ...traceBase,
      model: usedModel,
      source,
      rawOutput,
      repairedOutput,
      finalOutput,
      validationErrors: errors,
      repairAttempts,
      valid: false,
      latencyMs: Date.now() - started,
      totalInputTokens,
      totalOutputTokens
    });
    err.reasoningTrace = trace;
    throw err;
  }
}

function safeRecordReasoningCost({ leadId, model, source, kind, inputTokens, outputTokens }) {
  if (!leadId) return;
  if (source !== 'gemini') return; // skip mocks
  if (!inputTokens && !outputTokens) return;
  try {
    recordGeminiTokens({ leadId, model, inputTokens, outputTokens, kind: kind || 'reasoning' });
  } catch (err) {
    log.warn('reasoning.cost_record_failed', { leadId, model, kind, error: err?.message || String(err) });
  }
}

async function repairStructuredOutput({
  kind,
  schemaName,
  zodSchema,
  jsonSchema,
  prompt,
  evidence,
  rawOutput,
  validationErrors,
  model,
  thinkingLevel,
  flash,
  forceMock
}) {
  if (forceMock) {
    return { text: JSON.stringify(mockOutputForKind(kind, evidence), null, 2), usage: null };
  }

  try {
    const repairPrompt = [
      `Repair the previous ${schemaName} JSON so it validates exactly against the schema.`,
      `Do not add URLs, emails, names, services, claims, or commitments that are not present in the evidence.`,
      `Validation errors: ${validationErrors.join('; ')}`,
      '',
      'ORIGINAL PROMPT:',
      prompt,
      '',
      'INVALID OUTPUT:',
      rawOutput
    ].join('\n');
    const repaired = await generateStructuredText({
      prompt: repairPrompt,
      jsonSchema,
      systemInstruction: systemInstructionFor(schemaName),
      model,
      thinkingLevel,
      flash
    });
    return { text: repaired.text, usage: repaired.usage || null };
  } catch {
    return { text: JSON.stringify(mockOutputForKind(kind, evidence), null, 2), usage: null };
  }
}

function validateStructuredOutput(schema, value, evidence, validateEvidenceReferences) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
    };
  }

  const semanticErrors = validateEvidenceReferences
    ? unsupportedReferences(parsed.data, evidence)
    : [];
  if (semanticErrors.length) return { ok: false, errors: semanticErrors };
  return { ok: true, data: parsed.data, errors: [] };
}

function parseAndValidateStructuredOutput(schema, text, evidence, validateEvidenceReferences) {
  try {
    const parsed = parseLooseJson(text);
    return validateStructuredOutput(schema, parsed, evidence, validateEvidenceReferences);
  } catch (err) {
    return { ok: false, errors: [err?.message || String(err)] };
  }
}

function unsupportedReferences(output, evidence) {
  const evidenceText = evidenceToText(evidence);
  const urlsInEvidence = new Set(extractUrls(evidenceText).map(normalizeUrl));
  const emailsInEvidence = new Set(extractEmails(evidenceText).map(normalizeEmail));
  const outputText = evidenceToText(output);
  const errors = [];

  for (const url of extractUrls(outputText).map(normalizeUrl)) {
    if (!url) continue;
    if (!urlsInEvidence.has(url)) errors.push(`URL not present in evidence: ${url}`);
  }
  for (const email of extractEmails(outputText).map(normalizeEmail)) {
    if (!email) continue;
    if (!emailsInEvidence.has(email)) errors.push(`email not present in evidence: ${email}`);
  }
  return [...new Set(errors)];
}

function reasoningPrompt({ kind, schemaName, prompt, evidence }) {
  return [
    `Decision kind: ${kind || schemaName}`,
    `Return only JSON matching ${schemaName}.`,
    `Use the evidence as the source of truth. If a URL or email is not in evidence, do not include it.`,
    '',
    'EVIDENCE:',
    evidenceToText(evidence).slice(0, 24000),
    '',
    'TASK:',
    String(prompt || '').trim()
  ].join('\n');
}

function systemInstructionFor(schemaName) {
  return [
    'You are Google DeepMind Gemini acting as the central reasoning system for an autonomous website agency.',
    `Your output must validate as ${schemaName}.`,
    'Reason from evidence, make a decision, and return only JSON. No markdown, no prose wrapper.',
    'Never invent URLs, emails, legal commitments, guarantees, business facts, or customer promises.'
  ].join(' ');
}

function storeTrace(row) {
  const trace = reasoningTraces.add(row);
  emit('reasoning.trace', {
    worker: row.worker || 'reasoning',
    leadId: row.leadId || null,
    eventId: row.eventId || null,
    provider: row.provider,
    schemaName: row.schemaName,
    kind: row.kind,
    model: row.model,
    valid: !!row.valid,
    repairAttempts: row.repairAttempts || 0,
    confidence: row.finalOutput?.confidence ?? null,
    source: row.source,
    traceId: trace?.id || row.id || null
  });
  return trace;
}

function parseLooseJson(text) {
  const cleaned = stripFence(String(text || '').trim());
  try { return JSON.parse(cleaned); } catch {}

  const objectSlice = balancedSlice(cleaned, '{', '}');
  if (objectSlice) return JSON.parse(objectSlice);
  const arraySlice = balancedSlice(cleaned, '[', ']');
  if (arraySlice) return JSON.parse(arraySlice);
  throw new Error('structured reasoning returned non-JSON output');
}

function stripFence(text) {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : text;
}

function balancedSlice(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function evidenceToText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function extractUrls(text) {
  return [...String(text || '').matchAll(URL_RE)].map((m) => m[0].replace(/[),.;]+$/, ''));
}

function extractEmails(text) {
  return [...String(text || '').matchAll(EMAIL_RE)].map((m) => m[0].replace(/[),.;]+$/, ''));
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url || '').toLowerCase().replace(/\/+$/, '');
  }
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function traceKey({ leadId, worker, eventId, provider, schemaName, kind }) {
  if (!eventId) return null;
  return createHash('sha256')
    .update([leadId || 'none', worker || 'none', eventId, provider, schemaName, kind || 'none'].join('|'))
    .digest('hex');
}

function mockOutputForKind(kind, evidence) {
  const source = mockSource(evidence);
  const businessName = source.businessName || source.business_name || 'Synthetic Local Business';
  const niche = source.niche || 'local services';
  const city = source.city || 'the local area';
  const sourceUrl = source.sourceUrl || source.source_url || null;
  const websiteUrl = source.websiteUrl || source.website || null;
  const email = source.invoiceEmail || source.email || null;
  const disclosure = source.disclosure || 'This call may be recorded for quality and follow-up.';
  const evidenceItem = [{
    source: sourceUrl || 'synthetic evidence',
    quote: `${businessName} evidence was supplied to the reasoning harness.`,
    weight: 'medium'
  }];

  if (kind === 'businessProfile') {
    return {
      businessName,
      phone: source.phone || null,
      address: source.address || null,
      city,
      niche,
      hasWebsite: Boolean(websiteUrl),
      websiteUrl,
      onlinePresenceStrength: websiteUrl ? 'mixed' : 'weak',
      presenceConfidence: 0.66,
      onlinePresenceSummary: websiteUrl
        ? 'An owned website is present, but the conversion path still needs review.'
        : 'No owned website was confirmed in the supplied evidence.',
      onlinePresenceEvidence: {
        website: { found: Boolean(websiteUrl), url: websiteUrl, evidence: websiteUrl ? [`Evidence includes ${websiteUrl}`] : ['No owned website in evidence.'] },
        social: { found: false, platforms: [], urls: [], evidence: [] },
        listings: { found: Boolean(sourceUrl), platforms: sourceUrl ? ['source'] : [], urls: sourceUrl ? [sourceUrl] : [], evidence: sourceUrl ? [`Evidence includes ${sourceUrl}`] : [] },
        gaps: ['clear offer', 'customer proof', 'contact path'],
        positiveSignals: ['public business evidence exists']
      },
      onlinePresenceReasons: ['Synthetic fallback classified this as a callable weak or mixed presence lead.'],
      onlinePresenceConfidence: 0.66,
      notWorthCallingReason: null,
      callRecommendation: { shouldCall: true, notWorthCalling: false, whyCall: 'Presence evidence leaves a clear website conversion gap.', whyNotCall: null },
      ownerHypothesis: null,
      customerPersona: `Local customers looking for ${niche} in ${city}.`,
      hours: null,
      services: [niche],
      whatTheyDo: `${businessName} provides ${niche} in ${city}.`,
      needs: ['clear service menu', 'trust proof', 'tap-to-call contact path'],
      signals: ['synthetic structured fallback'],
      bestContactEmail: null,
      yelpUrl: null,
      sourceUrl,
      sourceUrls: sourceUrl ? [sourceUrl] : [],
      sourceProvenance: {
        phone: source.phone ? 'Phone came from supplied evidence.' : null,
        address: source.address ? 'Address came from supplied evidence.' : null,
        website: websiteUrl ? 'Website came from supplied evidence.' : null,
        profile: 'Generated by mock Gemini structured fallback.'
      },
      provenance: {
        profileSource: 'gemini_mock',
        sourceUrl,
        yelpUrl: null,
        capturedAt: new Date().toISOString(),
        phone: { value: source.phone || null, source: source.phone ? 'provided' : 'none', sourceUrl, evidence: source.phone ? 'Provided in evidence.' : null },
        address: { value: source.address || null, source: source.address ? 'provided' : 'none', sourceUrl, evidence: source.address ? 'Provided in evidence.' : null }
      }
    };
  }

  if (kind === 'presenceScore') {
    return {
      onlinePresenceStrength: websiteUrl ? 'mixed' : 'weak',
      score: websiteUrl ? 58 : 32,
      confidence: 0.7,
      hasOwnedWebsite: Boolean(websiteUrl),
      shouldCall: true,
      notWorthCallingReason: null,
      gaps: ['clear service menu', 'trust proof', 'contact path'],
      positiveSignals: ['public listing evidence'],
      evidence: evidenceItem
    };
  }

  if (kind === 'salesStrategy') {
    return {
      qualified: true,
      qualification: 'medium_fit',
      confidence: 0.7,
      offerAngle: 'A simple same-day page that makes services, proof, and contact details easier to act on.',
      whyNow: 'The supplied evidence shows a reachable local business with a visible online-presence gap.',
      painPoints: ['customers need quick trust', 'contact path needs to be obvious'],
      proofPoints: ['flat $500 website offer', 'same-day build path'],
      discoveryFocus: ['current customer acquisition', 'top service to feature', 'what customers ask first'],
      risks: ['owner may already rely on referrals'],
      nextBestAction: { code: 'prepare_call_script', label: 'Prepare call script', reason: 'The lead is callable with a concrete website gap.' },
      sourceEvidence: evidenceItem
    };
  }

  if (kind === 'callScript') {
    return {
      openingLine: `I noticed ${businessName} and wanted to ask one quick website question tied to how customers choose you.`,
      valueProp: `A clear one-page site can show ${niche}, trust proof, and the best way to contact ${businessName} for a flat $500.`,
      discoveryQuestions: [
        'What do customers usually ask before they decide to book or visit?',
        'Which service would you most want a new customer to notice first?',
        'Where do most people find you today: Google, Yelp, Instagram, or referrals?'
      ],
      objections: [
        { objection: 'I already have a website.', response: 'That helps. This is a fast conversion page focused on the clearest services, proof, and contact step.' },
        { objection: 'I am too busy.', response: 'Totally fair. I only need the best invoice email if it sounds useful, and the draft can start from public business details.' },
        { objection: 'Just send me information.', response: 'I can send it through AgentMail. The real question is whether a flat $500 same-day page is worth considering.' }
      ],
      close: 'If this sounds useful, I can send the $500 invoice and keep the next step simple.',
      emailAsk: 'What is the best email for the invoice?',
      emailReadbackInstruction: 'Read the email back exactly and ask the owner to confirm it before ending the call.',
      invoiceClose: 'AgentMail will send the invoice, and replies to that email come back to the agent for questions.',
      beginMessage: `${disclosure} I noticed ${businessName} and wanted to ask one quick website question.`,
      strategySummary: 'Respectful, evidence-led pitch for a weak or mixed online presence lead.',
      confidence: 0.72,
      sourceEvidence: evidenceItem
    };
  }

  if (kind === 'objectionPlan') {
    return {
      primaryObjections: [
        { objection: 'I already have a website.', response: 'Position this as a focused conversion page rather than a rebuild.' },
        { objection: 'That costs too much.', response: 'Anchor on flat $500, same-day scope, and avoiding a long agency project.' },
        { objection: 'Send me information.', response: 'Offer the AgentMail thread and clarify whether the invoice is worth considering.' }
      ],
      escalationRules: [
        { trigger: 'stop or remove me', response: 'Acknowledge and end outreach.', stopCondition: 'customer opts out' }
      ],
      confidence: 0.7,
      sourceEvidence: evidenceItem
    };
  }

  if (kind === 'callAnalysis') {
    return {
      outcome: email ? 'won' : 'lost',
      reason: email ? 'The transcript evidence includes a confirmed invoice email.' : 'No confirmed buying path was present in the supplied evidence.',
      failureReason: email ? null : 'Invoice email and customer confirmation were not proven.',
      whatWorked: email ? ['Email confirmation was captured.'] : [],
      whatToTryNext: email ? ['Send invoice.'] : ['Stop or retry only if a callback was requested.'],
      replayMoments: [],
      invoiceEmail: email,
      confirmedEmail: Boolean(email),
      customerQuestions: [],
      nextBestAction: email
        ? { code: 'send_invoice', label: 'Send invoice', reason: 'The invoice email is confirmed in evidence.' }
        : { code: 'stop_outreach', label: 'Stop outreach', reason: 'No buying path is proven.' },
      followupEmailDraft: email ? `Thanks for the call. We can start the ${businessName} website from the details discussed.` : null,
      confidence: 0.68,
      sourceEvidence: evidenceItem
    };
  }

  if (kind === 'emailReplyDecision') {
    const policy = evidence?.deterministicPolicy || source.deterministicPolicy || {};
    const policyKind = ['supported', 'handoff', 'opt_out', 'unknown'].includes(policy.kind) ? policy.kind : 'supported';
    const policyScope = policy.scope || (policyKind === 'opt_out' ? 'opt-out' : 'brief');
    const policySupported = policy.supported ?? (policyKind === 'supported' || policyKind === 'opt_out');
    const policyOperatorFlag = policy.operatorFlag ?? (policyKind === 'handoff' || policyKind === 'unknown');
    const replyMode = policyKind === 'opt_out'
      ? 'opt_out_confirmation'
      : policyOperatorFlag
        ? 'safe_handoff'
        : 'autonomous_reply';
    const replyText = policyKind === 'opt_out'
      ? 'Understood. We will stop emailing this thread. Thanks for letting us know.'
      : policyOperatorFlag
        ? 'Thanks for asking. I can only handle invoice questions, scheduling, website briefs, revisions, pricing, build progress, and opt-outs in this automated thread. I have flagged the operator so a human can review this safely.'
        : fallbackEmailReplyText(policyScope);
    return {
      schemaVersion: 1,
      kind: policyKind,
      scope: policyScope,
      scopes: Array.isArray(policy.scopes) && policy.scopes.length ? policy.scopes : [policyScope],
      supported: Boolean(policySupported),
      operatorFlag: Boolean(policyOperatorFlag),
      replyMode,
      reason: policy.reason || 'Synthetic evidence follows the deterministic AgentMail policy decision.',
      matches: {
        supported: Array.isArray(policy.matches?.supported) ? policy.matches.supported : (policyOperatorFlag ? [] : [policyScope]),
        unsupported: Array.isArray(policy.matches?.unsupported) ? policy.matches.unsupported : []
      },
      replyText,
      confidence: 0.65,
      supportedScopes: ['invoice', 'scheduling', 'brief', 'revisions', 'pricing', 'build progress', 'opt-out'],
      unsupportedScopes: ['legal', 'custom contract', 'tax', 'guarantees', 'weird request'],
      sourceEvidence: evidenceItem
    };
  }

  if (kind === 'websiteBrief') {
    return {
      brief: `Build a concise, polished one-page website for ${businessName}, a ${niche} business in ${city}. Use only confirmed facts from the brief. Feature services, trust proof, and a clear contact path. Avoid unsupported guarantees, invented staff names, or fake reviews.`,
      businessName,
      targetCustomer: `Local customers looking for ${niche}.`,
      sections: [
        { name: 'Hero', goal: 'State what the business does and how to contact it.', content: [businessName, niche, city] },
        { name: 'Services', goal: 'Explain the core offer clearly.', content: [niche] },
        { name: 'Contact', goal: 'Make the next step obvious.', content: ['tap-to-call', 'simple inquiry form'] }
      ],
      style: { tone: 'clean and professional', palette: 'neutral with one accent', layout: 'clear hero, service sections, sticky mobile CTA' },
      factualClaims: [businessName, niche, city],
      omittedClaims: ['reviews', 'guarantees', 'unconfirmed staff names'],
      customerQuestions: [],
      confidence: 0.7,
      sourceEvidence: evidenceItem
    };
  }

  if (kind === 'growthPlan') {
    return {
      stage: 'pre_call',
      positioning: 'Flat-fee same-day website for weak-presence local businesses.',
      targetSegments: [niche],
      acquisitionChannels: [
        { channel: 'phone', rationale: 'Reach owners directly after evidence-led qualification.', firstExperiment: 'Call weak-presence leads with confirmed business phones.' }
      ],
      upsellPath: ['revisions', 'monthly maintenance', 'local SEO cleanup'],
      risks: ['owner skepticism', 'unconfirmed contact data'],
      nextActions: [{ code: 'qualify_more_leads', label: 'Qualify more leads', reason: 'More evidence improves outreach selectivity.' }],
      confidence: 0.64,
      sourceEvidence: evidenceItem
    };
  }

  return {
    allowed: false,
    decisionCode: 'mock_reasoning_fallback',
    decisionReason: 'No live Gemini output was available; synthetic fallback held side effects closed.',
    channel: 'internal',
    policyFlags: ['mock_fallback'],
    requiredGate: 'live_provider_output',
    nextBestAction: { code: 'operator_review', label: 'Operator review', reason: 'Fallback compliance decisions should not unlock live side effects.' },
    confidence: 0.6,
    sourceEvidence: evidenceItem
  };
}

function mockSource(evidence) {
  if (!evidence || typeof evidence !== 'object') return {};
  if (evidence.lead) return { ...evidence, ...evidence.lead };
  if (evidence.profile) return { ...evidence, ...evidence.profile };
  return evidence;
}

function fallbackEmailReplyText(scope) {
  if (scope === 'invoice') return 'Thanks for the note. I can help with invoice and payment questions right here. Send over what you are seeing on the invoice or checkout page and I will keep it moving.';
  if (scope === 'scheduling') return 'Thanks for the note. Send a couple of times that work for you and I will keep scheduling simple from this thread.';
  if (scope === 'revisions') return 'Thanks for the revision note. Send the exact change you want made, plus the page or section it belongs on, and I will use that to keep the build moving.';
  if (scope === 'pricing') return 'Thanks for asking. I can help with pricing and package questions right here in this thread. Tell me what scope you have in mind and I will keep the answer concrete.';
  if (scope === 'build progress') return 'Thanks for checking in. I can help with build progress, preview links, and launch status here. I will keep the next update focused on where the site stands.';
  return 'Thanks for the details. Send the services, photos, colors, or copy you want reflected on the site and I will fold them into the brief.';
}

function safeId() {
  return `trace_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export function createReasoningTraceId() {
  return safeId();
}
