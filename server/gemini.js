import { GoogleGenAI } from '@google/genai';
import { env } from './env.js';
import { log } from './logger.js';

let _client;
function client() {
  if (!_client) {
    if (!env.gemini.apiKey) throw new Error('GEMINI_API_KEY missing');
    _client = new GoogleGenAI({ apiKey: env.gemini.apiKey });
  }
  return _client;
}

export async function generateJson({
  prompt,
  schema,
  systemInstruction,
  model,
  thinkingLevel = 'low',
  flash = false
}) {
  const useModel = model || (flash ? env.gemini.modelFlash : env.gemini.modelPro);
  try {
    const text = await callModel({ model: useModel, prompt, systemInstruction, thinkingLevel, schema });
    return parseLoose(text);
  } catch (err) {
    if (isQuotaError(err) && useModel !== env.gemini.modelFlash) {
      log.warn('gemini.fallback', { from: useModel, to: env.gemini.modelFlash });
      const text = await callModel({ model: env.gemini.modelFlash, prompt, systemInstruction, thinkingLevel: 'low', schema });
      return parseLoose(text);
    }
    throw err;
  }
}

export async function generateText({ prompt, systemInstruction, model, thinkingLevel = 'low', flash = false }) {
  const useModel = model || (flash ? env.gemini.modelFlash : env.gemini.modelPro);
  try {
    return await callModel({ model: useModel, prompt, systemInstruction, thinkingLevel });
  } catch (err) {
    if (isQuotaError(err) && useModel !== env.gemini.modelFlash) {
      log.warn('gemini.fallback.text', { from: useModel, to: env.gemini.modelFlash });
      return await callModel({ model: env.gemini.modelFlash, prompt, systemInstruction, thinkingLevel: 'low' });
    }
    throw err;
  }
}

async function callModel({ model, prompt, systemInstruction, thinkingLevel, schema }) {
  const ai = client();
  const config = { thinkingConfig: { thinkingLevel } };
  if (schema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = schema;
  }
  if (systemInstruction) config.systemInstruction = systemInstruction;
  const res = await ai.models.generateContent({ model, contents: prompt, config });
  const text = pickText(res);
  if (!text) throw new Error('gemini returned empty text');
  return text;
}

function parseLoose(text) {
  try { return JSON.parse(text); } catch {
    const slice = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    return JSON.parse(slice);
  }
}

function isQuotaError(err) {
  const msg = err?.message || '';
  return /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg);
}

function pickText(res) {
  if (typeof res?.text === 'string') return res.text;
  if (typeof res?.text === 'function') return res.text();
  const parts = res?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map((p) => p?.text || '').join('');
  }
  return '';
}
