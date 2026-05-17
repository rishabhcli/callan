import crypto from 'node:crypto';
import { env } from '../env.js';
import { log } from '../logger.js';

// AgentPhone webhook signature: the provider emits the signature either as
// X-Webhook-Signature: sha256=<hex>  (upgrade.md / older spec)
// or as
// X-Signature-256: <hex>             (current API reference)
// We accept both, HMAC-SHA256 of either `${ts}.${raw}` (with timestamp header)
// or just `raw` (no timestamp). Constant-time compare on every candidate.
export function verifyAgentPhone(req, rawBody) {
  if (!env.agentphone.webhookSecret) {
    log.warn('AGENTPHONE_WEBHOOK_SECRET not set; rejecting webhook');
    return { ok: false, reason: 'no secret configured' };
  }

  const sig256 = String(req.headers['x-signature-256'] || '').trim();
  const sigGeneric = String(req.headers['x-webhook-signature'] || '').trim();
  const ts = String(req.headers['x-webhook-timestamp'] || req.headers['x-timestamp'] || req.headers['x-signature-timestamp'] || '').trim();

  const provided = pickHex(sigGeneric) || pickHex(sig256);
  if (!provided) return { ok: false, reason: 'no signature header' };

  const secret = env.agentphone.webhookSecret;
  const raw = rawBody.toString('utf8');
  const candidates = [
    ts ? `${ts}.${raw}` : null,
    ts ? `${ts}${raw}` : null,
    raw
  ].filter(Boolean);

  for (const payload of candidates) {
    const expected = crypto.createHmac('sha256', secret).update(payload).digest();
    if (provided.length === expected.length && crypto.timingSafeEqual(provided, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'bad signature' };
}

function pickHex(value) {
  if (!value) return null;
  const match = String(value).match(/(?:sha256=)?([a-f0-9]{32,128})/i);
  if (!match) return null;
  try {
    return Buffer.from(match[1], 'hex');
  } catch {
    return null;
  }
}
