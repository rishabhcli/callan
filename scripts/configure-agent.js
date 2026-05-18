#!/usr/bin/env node
/**
 * Configure the live AgentPhone agent so calling +1 (662) 602-1352 actually does something useful.
 *
 *   1. Update the agent's base system prompt + begin message so inbound callers hit a real persona.
 *   2. Point the agent's webhook at our public URL so every event (call.started, transcript,
 *      call.ended) reaches /api/webhooks/agentphone.
 *   3. Persist the returned webhook secret to .env so signature verification passes.
 *
 * Usage:
 *   node scripts/configure-agent.js --url https://your-public-tunnel.example.com
 *
 * If --url is omitted we use APP_PUBLIC_URL from .env. That MUST be publicly reachable
 * (ngrok / cloudflared / deployed server). Localhost won't work — AgentPhone delivers
 * webhooks from their own infrastructure.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

const args = parseArgs(process.argv.slice(2));
const PUBLIC_URL = (args.url || process.env.APP_PUBLIC_URL || '').replace(/\/+$/, '');
const API_KEY = process.env.AGENTPHONE_API_KEY;
const AGENT_ID = process.env.AGENTPHONE_AGENT_ID;
const BASE_URL = (process.env.AGENTPHONE_BASE_URL || 'https://api.agentphone.ai/v1').replace(/\/+$/, '');
const VOICE = process.env.AGENTPHONE_DEFAULT_VOICE || 'Polly.Joanna';

if (!API_KEY) fatal('Missing AGENTPHONE_API_KEY in .env');
if (!AGENT_ID) fatal('Missing AGENTPHONE_AGENT_ID in .env');
if (!PUBLIC_URL) fatal('No public URL. Pass --url <https://...> or set APP_PUBLIC_URL in .env.');
if (PUBLIC_URL.startsWith('http://localhost') || PUBLIC_URL.startsWith('http://127.')) {
  fatal(`Public URL "${PUBLIC_URL}" is localhost — AgentPhone cannot reach it.
Run ngrok (or cloudflared) first:
    ngrok http 8787
Then re-run with the https forwarding URL:
    node scripts/configure-agent.js --url https://YOURID.ngrok-free.app`);
}

const WEBHOOK_URL = `${PUBLIC_URL}/api/webhooks/agentphone`;

const SYSTEM_PROMPT = `You are Callan, the live voice operator for callmemaybe, an agentic web agency that researches small businesses, calls them, and builds $500 same-day websites for them.

The person on this line is talking to you right now. LISTEN to what they say, then answer in one or two short sentences. Never go past three.

WHO THEY PROBABLY ARE:
- If they say their name is Rishabh or call themselves the founder, treat them as the boss. They may ask you to summarize what the system is doing, kick off research in a niche, place a call to a specific lead, or look up a lead by name. Always read back phone numbers, lead names, and niches before agreeing to act.
- If they say they got a sales call from us, act like a warm receptionist. Confirm the business name first. Help with: questions about the pitch, paying the invoice, scheduling the build, or opting out.
- If they sound like a curious prospect, pitch plainly: focused $500 same-day website, designed around one clear next-action a visitor should take. Ask for their business name and what they sell. DO NOT ask for a callback number — assume the number they're calling from IS the callback number.

PHONE NUMBER (CALLBACK):
- Default assumption: the number the caller is dialing from IS their callback number. Don't ask "what's the best number to reach you at?" — they're already on it.
- The right way to handle it: "Cool, I'll use the number you're calling from for any callback unless you want a different one — sound good?" Then move on.
- ONLY collect a different number if they volunteer one or explicitly ask you to use a different number. In that case read it back digit by digit.

EMAIL FOLLOWUPS:
- When the caller offers an email address, READ IT BACK character by character to confirm it. Spell out each letter and say "dot" for periods and "at" for the @ symbol. Wait for them to confirm before moving on.
- After they confirm, say exactly: "Great, sending the followup to that email now." A real followup email with our overview is sent automatically — you do not need to do anything else.
- Never promise to send anything by SMS or any channel other than email.

RULES:
- You are an AI. If asked directly, say: "I am Callan, callmemaybe's AI voice operator." No apology.
- Do not make commitments you cannot verify (price changes, custom scope, refund timing).
- If someone says "do not call", "remove me", or "opt out", respond: "Got it, you are now on our do-not-call list. You will not hear from us again."
- Always read back phone numbers, emails, and dollar amounts before confirming.
- After your greeting, WAIT for the caller to speak. Do not narrate or fill silence.`;

const BEGIN_MESSAGE = `Hi, this is Callan, callmemaybe's voice operator. Who am I speaking with?`;

main().catch((err) => {
  console.error('\nconfigure-agent failed:', err?.message || err);
  process.exit(1);
});

async function main() {
  banner('STEP 1: update agent persona');
  console.log(`  agentId       ${AGENT_ID}`);
  console.log(`  voice         ${VOICE}`);
  console.log(`  prompt        ${SYSTEM_PROMPT.length} chars`);
  console.log(`  beginMessage  ${BEGIN_MESSAGE.length} chars`);

  const updated = await api('PATCH', `/agents/${encodeURIComponent(AGENT_ID)}`, {
    name: 'callmemaybe-voice-operator',
    description: 'Callan — live voice operator for callmemaybe agency',
    voiceMode: 'hosted',          // hosted = AgentPhone runs the LLM and speaks; webhook = expects us to speak
    enableMessaging: false,
    modelTier: 'turbo',           // lowest latency turn-by-turn
    systemPrompt: SYSTEM_PROMPT,
    beginMessage: BEGIN_MESSAGE,
    voice: VOICE,
    sttMode: 'fast',              // ~200ms faster than 'accurate', fine for casual ops
    ambientSound: 'none',
    denoisingMode: 'noise-and-background-speech-cancellation',
    maxSilenceMs: 30000,
    interruptionSensitivity: 0.7  // a bit less trigger-happy than default
  });
  console.log(`  ✓ agent updated (id=${updated?.id || AGENT_ID})`);

  banner('STEP 2: register webhook URL');
  console.log(`  url           ${WEBHOOK_URL}`);
  const hook = await api('POST', `/agents/${encodeURIComponent(AGENT_ID)}/webhook`, {
    url: WEBHOOK_URL,
    contextLimit: 50,
    timeout: 30
  });
  console.log(`  ✓ webhook registered (id=${hook?.id || 'n/a'}, status=${hook?.status || 'unknown'})`);

  if (hook?.secret) {
    banner('STEP 3: save webhook secret to .env');
    updateEnvKey('AGENTPHONE_WEBHOOK_SECRET', hook.secret);
    console.log(`  ✓ AGENTPHONE_WEBHOOK_SECRET written to .env (${hook.secret.length} chars)`);
  } else {
    console.warn('  ⚠ no secret returned from AgentPhone — inbound signature verification will reject deliveries until you set AGENTPHONE_WEBHOOK_SECRET manually.');
  }

  banner('READY');
  console.log(`Restart the dev server so the new webhook secret is loaded:
    pkill -f 'vite|node scripts/dev' ; npm run dev

Then call ${process.env.AGENTPHONE_FROM_NUMBER || '+1 (662) 602-1352'}.

The agent answers with: "${BEGIN_MESSAGE}"

You'll see the call appear in the dashboard's Operations tab Caller box, with
the live transcript streaming as you speak.`);
}

async function api(method, pathPart, body) {
  const url = `${BASE_URL}${pathPart}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const msg = parsed?.detail || parsed?.error || parsed?.message || text || res.statusText;
    throw new Error(`AgentPhone ${method} ${pathPart} → ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return parsed;
}

function updateEnvKey(key, value) {
  const safeValue = String(value);
  const existing = fs.readFileSync(ENV_PATH, 'utf8');
  const lineRegex = new RegExp(`^${key}=.*$`, 'gm');
  const matches = existing.match(lineRegex) || [];
  let next;
  if (matches.length === 0) {
    next = `${existing.replace(/\n*$/, '')}\n${key}=${safeValue}\n`;
  } else {
    // Replace the FIRST occurrence with the new value; strip any duplicates that
    // crept in from previous runs or hand edits.
    let replaced = false;
    next = existing.replace(lineRegex, () => {
      if (replaced) return ''; // drop dupes
      replaced = true;
      return `${key}=${safeValue}`;
    });
    // Collapse the blank lines left behind by removed duplicates.
    next = next.replace(/\n{3,}/g, '\n\n');
  }
  fs.writeFileSync(ENV_PATH, next);
  process.env[key] = safeValue;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

function banner(title) {
  console.log(`\n── ${title} ──────────────────────────────────────────`);
}

function fatal(msg) {
  console.error(`configure-agent: ${msg}`);
  process.exit(1);
}
