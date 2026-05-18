import { GoogleGenAI } from '@google/genai';
import { env } from '../env.js';
import { log } from '../logger.js';
import { providerConfigured, sideEffectGate, smokeDetail, withProviderRetry, normalizeProviderError } from './core.js';
import { recordGeminiTokens } from '../costs.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 30000);
const PROVIDER = 'gemini';

let _client;

export function geminiConfigured() {
  return providerConfigured({ GEMINI_API_KEY: env.gemini.apiKey });
}

export async function generateJson({
  prompt,
  schema,
  systemInstruction,
  model,
  thinkingLevel = 'low',
  flash = false,
  leadId = null,
  kind = 'reasoning'
}) {
  const chain = modelChain(model || (flash ? env.gemini.modelFlash : env.gemini.modelPro));
  let lastError;

  for (const useModel of chain) {
    try {
      const { text, usage } = await callModel({ model: useModel, prompt, systemInstruction, thinkingLevel, schema });
      const parsed = parseLooseJson(text);
      assertStructuredOutput(parsed, schema);
      maybeRecordTokens({ leadId, model: useModel, kind, prompt, text, usage });
      return parsed;
    } catch (err) {
      lastError = normalizeGeminiError(err);
      if (!shouldTryNextModel(lastError)) throw err;
      log.warn('gemini.fallback', { from: useModel, error: lastError.message });
    }
  }

  throw normalizedGeminiThrow('generateJson', lastError);
}

export async function generateStructuredText({
  prompt,
  jsonSchema,
  schema,
  systemInstruction,
  model,
  thinkingLevel = 'medium',
  flash = false
}) {
  const chain = modelChain(model || (flash ? env.gemini.modelFlash : env.gemini.modelPro));
  let lastError;

  for (const useModel of chain) {
    try {
      const { text, usage } = await callModel({
        model: useModel,
        prompt,
        systemInstruction,
        thinkingLevel,
        schema: jsonSchema || schema
      });
      return { text, model: useModel, usage };
    } catch (err) {
      lastError = normalizeGeminiError(err);
      if (!shouldTryNextModel(lastError)) throw err;
      log.warn('gemini.fallback.structured_text', { from: useModel, error: lastError.message });
    }
  }

  throw normalizedGeminiThrow('generateStructuredText', lastError);
}

export async function generateText({
  prompt,
  systemInstruction,
  model,
  thinkingLevel = 'low',
  flash = false,
  leadId = null,
  kind = 'text'
}) {
  const chain = modelChain(model || (flash ? env.gemini.modelFlash : env.gemini.modelPro));
  let lastError;

  for (const useModel of chain) {
    try {
      const { text, usage } = await callModel({ model: useModel, prompt, systemInstruction, thinkingLevel });
      maybeRecordTokens({ leadId, model: useModel, kind, prompt, text, usage });
      return text;
    } catch (err) {
      lastError = normalizeGeminiError(err);
      if (!shouldTryNextModel(lastError)) throw err;
      log.warn('gemini.fallback.text', { from: useModel, error: lastError.message });
    }
  }

  throw normalizedGeminiThrow('generateText', lastError);
}

export async function smokeGeminiGenerate() {
  const configured = geminiConfigured();
  if (!configured.configured) {
    return { provider: PROVIDER, status: 'missing', detail: smokeDetail({ skipped: configured.missing.join(', ') }) };
  }

  const gate = sideEffectGate({
    provider: PROVIDER,
    action: 'generateContent smoke',
    enabled: env.smoke.gemini,
    details: { toggle: 'SMOKE_GEMINI' }
  });
  if (!gate.ok) {
    return { provider: PROVIDER, status: 'configured', detail: smokeDetail({ skipped: gate.reason, extra: gate.details }) };
  }

  const text = await generateText({ prompt: 'Reply with exactly OK.', thinkingLevel: 'low', flash: true });
  return {
    provider: PROVIDER,
    status: 'ok',
    detail: smokeDetail({
      dryRun: false,
      live: true,
      extra: { model: env.gemini.modelFlash, sample: String(text || '').slice(0, 20) }
    })
  };
}

export function geminiReadinessDetails() {
  const configured = geminiConfigured();
  return {
    configured: configured.configured,
    missing: configured.missing,
    models: { pro: env.gemini.modelPro, flash: env.gemini.modelFlash, fallbacks: modelChain(env.gemini.modelPro).slice(1) },
    auth: 'api_key',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    structuredOutput: 'json_schema_parse_and_validate',
    smoke: env.smoke.gemini ? 'enabled_by_SMOKE_GEMINI' : 'disabled_by_default'
  };
}

async function callModel({ model, prompt, systemInstruction, thinkingLevel, schema }) {
  const ai = client();
  const config = {};
  const normalizedThinking = normalizeThinkingLevel(thinkingLevel);
  if (normalizedThinking) config.thinkingConfig = { thinkingLevel: normalizedThinking };
  if (schema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = schema;
  }
  if (systemInstruction) config.systemInstruction = systemInstruction;

  const res = await withProviderRetry('gemini', 'generateContent', () => withTimeout(
    ai.models.generateContent({ model, contents: prompt, config }),
    DEFAULT_TIMEOUT_MS,
    `gemini.generateContent timed out after ${DEFAULT_TIMEOUT_MS}ms`
  ), {
    retries: 1,
    classify: normalizeGeminiError
  });

  const text = pickText(res);
  if (!text) throw geminiError('gemini returned empty text', { retryable: true });
  const usage = pickUsage(res);
  return { text, usage };
}

function pickUsage(res) {
  const meta = res?.usageMetadata || res?.usage_metadata || res?.response?.usageMetadata || null;
  if (!meta || typeof meta !== 'object') return null;
  const inputTokens = Number(meta.promptTokenCount ?? meta.prompt_token_count ?? 0) || 0;
  const outputTokens = Number(meta.candidatesTokenCount ?? meta.candidates_token_count ?? 0) || 0;
  const totalTokens = Number(meta.totalTokenCount ?? meta.total_token_count ?? (inputTokens + outputTokens)) || 0;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function maybeRecordTokens({ leadId, model, kind, prompt, text, usage }) {
  if (!leadId) return;
  try {
    const inputTokens = usage?.inputTokens || Math.ceil(String(prompt || '').length / 4);
    const outputTokens = usage?.outputTokens || Math.ceil(String(text || '').length / 4);
    recordGeminiTokens({ leadId, model, inputTokens, outputTokens, kind });
  } catch (err) {
    log.warn('gemini.cost_record_failed', { leadId, model, kind, error: err?.message || String(err) });
  }
}

function client() {
  if (!_client) {
    if (!env.gemini.apiKey) throw new Error('GEMINI_API_KEY missing');
    _client = new GoogleGenAI({ apiKey: env.gemini.apiKey });
  }
  return _client;
}

function modelChain(primary) {
  return unique([
    primary,
    env.gemini.modelFlash,
    ...fallbackModelsFromEnv(),
    'gemini-2.5-flash',
    'gemini-2.0-flash'
  ].filter(Boolean));
}

function fallbackModelsFromEnv() {
  return (process.env.GEMINI_MODEL_FALLBACKS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

function parseLooseJson(text) {
  const cleaned = stripFence(String(text || '').trim());
  try { return JSON.parse(cleaned); } catch {}

  const objectSlice = balancedSlice(cleaned, '{', '}');
  if (objectSlice) return JSON.parse(objectSlice);
  const arraySlice = balancedSlice(cleaned, '[', ']');
  if (arraySlice) return JSON.parse(arraySlice);
  throw geminiError('gemini returned non-JSON structured output', { code: 'json_parse', retryable: true });
}

function assertStructuredOutput(value, schema) {
  if (!schema) return;
  const errors = [];
  validateValue(value, schema, '$', errors);
  if (errors.length) {
    throw geminiError(`gemini structured output invalid: ${errors.slice(0, 6).join('; ')}`, {
      code: 'schema_validation',
      retryable: true
    });
  }
}

function validateValue(value, schema, path, errors) {
  if (!schema || errors.length > 20) return;
  if (schema.nullable && value === null) return;
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} expected const ${schema.const}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} expected one of ${schema.enum.join(', ')}`);
    return;
  }

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} expected object`);
      return;
    }
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) validateValue(value[key], childSchema, `${path}.${key}`, errors);
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} expected array`);
      return;
    }
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path} expected at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} expected at most ${schema.maxItems} items`);
    value.forEach((item, i) => validateValue(item, schema.items, `${path}[${i}]`, errors));
    return;
  }

  if (schema.type === 'string' && typeof value !== 'string') errors.push(`${path} expected string`);
  if (schema.type === 'number' && typeof value !== 'number') errors.push(`${path} expected number`);
  if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} expected integer`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} expected boolean`);
}

function normalizeThinkingLevel(value) {
  if (value === 'minimal') return 'low';
  if (['low', 'medium', 'high'].includes(value)) return value;
  return 'low';
}

function shouldTryNextModel(err) {
  const msg = err?.message || '';
  if (err?.code === 'json_parse' || err?.code === 'schema_validation') return true;
  if (err?.retryable) return true;
  return /\b(400|404|429|500|502|503|504)\b|RESOURCE_EXHAUSTED|quota|not found|not supported|unavailable|overloaded|deadline/i.test(msg);
}

export function normalizeGeminiError(err) {
  const normalized = normalizeProviderError(err);
  const msg = normalized.message || '';
  normalized.retryable = normalized.retryable ?? /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|quota|unavailable|overloaded|timeout|deadline/i.test(msg);
  if (err?.code) normalized.code = err.code;
  return normalized;
}

export function classifyGeminiFailure(err) {
  const normalized = normalizeGeminiError(err);
  const msg = String(normalized.message || '').toLowerCase();
  const status = Number(normalized.status || 0) || null;
  const code = String(normalized.code || '').toLowerCase();

  let category = 'unknown';
  if (status === 401 || status === 403 || /\b(auth|api key|permission|forbidden|unauthorized)\b/.test(msg)) {
    category = 'auth';
    normalized.retryable = false;
  } else if (status === 429 || /\b(rate.?limit|quota|resource_exhausted|too many requests)\b/.test(msg)) {
    category = 'rate-limited';
    normalized.retryable = true;
  } else if (status === 404 || /\b(model|not found|not supported|deprecated)\b/.test(msg)) {
    category = 'model-unavailable';
    normalized.retryable = true;
  } else if (code === 'json_parse' || code === 'schema_validation' || /\b(non-json|structured output invalid|schema)\b/.test(msg)) {
    category = 'structured-output';
    normalized.retryable = true;
  } else if (/\b(safety|blocked|prohibited)\b/.test(msg)) {
    category = 'safety-blocked';
    normalized.retryable = false;
  } else if (/\b(timeout|timed out|deadline|abort)\b/.test(msg) || code === 'timeout') {
    category = 'timeout';
    normalized.retryable = true;
  } else if (/\b(fetch failed|network|econn|enotfound|etimedout|socket)\b/.test(msg)) {
    category = 'network';
    normalized.retryable = true;
  } else if (status && status >= 500) {
    category = 'provider-error';
    normalized.retryable = true;
  } else if (status && status >= 400) {
    category = 'provider-rejected';
    normalized.retryable = false;
  }

  return {
    ...normalized,
    category,
    outcome: `failed:${category}`,
    retryable: normalized.retryable ?? true
  };
}

function normalizedGeminiThrow(action, lastError) {
  return geminiError(`gemini.${action} failed: ${lastError?.message || 'all models failed'}`, {
    status: lastError?.status,
    code: lastError?.code,
    retryable: lastError?.retryable,
    cause: lastError?.cause
  });
}

function geminiError(message, props = {}) {
  const err = new Error(message);
  Object.assign(err, props);
  return err;
}

function pickText(res) {
  if (typeof res?.text === 'string') return res.text;
  if (typeof res?.text === 'function') return res.text();
  const parts = res?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p) => p?.text || '').join('');
  return '';
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

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(geminiError(message, { code: 'timeout', retryable: true })), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function unique(values) {
  return [...new Set(values)];
}
