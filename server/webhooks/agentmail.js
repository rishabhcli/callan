import { Webhook } from 'svix';
import { log } from '../logger.js';

const SECRET = process.env.AGENTMAIL_WEBHOOK_SECRET || '';

export function verifyAgentMail(req, rawBody) {
  if (!SECRET) {
    log.warn('AGENTMAIL_WEBHOOK_SECRET not set; accepting (dev only)');
    return { ok: true, dev: true };
  }
  try {
    const wh = new Webhook(SECRET);
    const headers = {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature']
    };
    wh.verify(rawBody, headers);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
