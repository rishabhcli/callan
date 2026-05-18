#!/usr/bin/env node
/**
 * One-time Apple-auth seed for the anything.com build target.
 *
 *   1. Create a persistent Browser Use profile.
 *   2. Open a session attached to that profile, navigating to anything.com.
 *   3. Print the live URL — operator opens it, completes Sign in with Apple,
 *      approves the MFA prompt on iPhone, lands on the dashboard.
 *   4. Operator presses Enter in the terminal.
 *   5. Script stops the session — Browser Use auto-saves cookies onto the
 *      profile.
 *   6. Writes BROWSER_USE_PROFILE_ID to .env so every subsequent build attaches
 *      to the same (authenticated) profile, no MFA re-prompt.
 *
 * Re-run if Apple's trust cookie ever invalidates (~90 days or device-fingerprint
 * changes). Profile id stays the same; just refills cookies.
 *
 * Usage:
 *   node scripts/seed-anything-profile.js
 *   node scripts/seed-anything-profile.js --name "anything-yourname"   # override profile name
 *   node scripts/seed-anything-profile.js --new                        # force a brand-new profile, don't reuse existing
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserUse } from 'browser-use-sdk/v3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

const args = parseArgs(process.argv.slice(2));
const PROFILE_NAME = args.name || 'anything-callmemaybe-master';
const FORCE_NEW = !!args.new;
const API_KEY = process.env.BROWSER_USE_API_KEY;
const BASE_URL = process.env.BROWSER_USE_BASE_URL || 'https://api.browser-use.com/api/v3';

if (!API_KEY) fatal('Missing BROWSER_USE_API_KEY in .env');

const client = new BrowserUse({ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 1, timeout: 30_000 });

main().catch((err) => {
  console.error('\nseed-anything-profile failed:', err?.message || err);
  process.exit(1);
});

async function main() {
  banner('STEP 1: profile');
  let profile;
  if (!FORCE_NEW) {
    try {
      const list = await client.profiles.list({ pageSize: 50 });
      profile = (list?.items || []).find((p) => p?.name === PROFILE_NAME) || null;
      if (profile) {
        console.log(`  reusing existing profile "${PROFILE_NAME}"`);
        console.log(`  id: ${profile.id || profile.profileId}`);
      }
    } catch (err) {
      console.warn('  profile list failed (will create):', err?.message || String(err));
    }
  }
  if (!profile) {
    profile = await client.profiles.create({ name: PROFILE_NAME });
    console.log(`  ✓ created profile "${PROFILE_NAME}"`);
    console.log(`  id: ${profile.id || profile.profileId}`);
  }
  const profileId = profile.id || profile.profileId;
  if (!profileId) fatal('Browser Use profile create returned no id');

  banner('STEP 2: session');
  const session = await client.sessions.create({
    profileId,
    keepAlive: true,
    task: 'Open https://www.anything.com and wait for the operator to sign in with Apple. Do not click anything. Just keep the page on screen. Once you see the anything.com dashboard URL (path starts with /dashboard), report exactly: DASHBOARD_REACHED — then stop.'
  });
  const sessionId = session?.sessionId || session?.id || session?.session?.id;
  const liveUrl = session?.liveUrl || session?.live_url || session?.session?.liveUrl;
  if (!sessionId) fatal('Browser Use session create returned no session id');
  console.log(`  session: ${sessionId}`);
  console.log(`  live URL (open this in your browser to log in):`);
  console.log(`     ${liveUrl}`);

  banner('STEP 3: sign in with Apple');
  console.log('  1) Open the live URL above in any browser.');
  console.log('  2) Click "Sign in with Apple" on anything.com.');
  console.log('  3) Approve the MFA prompt on your iPhone / trusted device.');
  console.log('  4) Wait until you see the anything.com dashboard.');
  console.log('');
  console.log('  This script will auto-detect success and finish on its own.');
  console.log('  Polling Browser Use for DASHBOARD_REACHED…');

  const TIMEOUT_MS = 12 * 60 * 1000; // 12 minutes — enough for Apple MFA fumbling
  const POLL_MS = 5000;
  const started = Date.now();
  let dashboardReached = false;
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(POLL_MS);
    let snapshot;
    try {
      snapshot = await client.sessions.get(sessionId);
    } catch (err) {
      console.warn('  poll failed:', err?.message || String(err));
      continue;
    }
    const status = snapshot?.status || snapshot?.agentStatus || snapshot?.session?.status || '';
    const haystack = JSON.stringify(snapshot || '');
    if (/\bDASHBOARD_REACHED\b/.test(haystack)) {
      dashboardReached = true;
      console.log(`  ✓ agent reported DASHBOARD_REACHED — Apple session is live`);
      break;
    }
    if (['completed', 'finished', 'done', 'stopped', 'failed'].includes(String(status).toLowerCase())) {
      console.log(`  session reached terminal status="${status}" without DASHBOARD_REACHED — checking final output…`);
      const finalText = JSON.stringify(snapshot?.output || snapshot?.result || snapshot || '');
      if (/\bDASHBOARD_REACHED\b/.test(finalText)) {
        dashboardReached = true;
      }
      break;
    }
    const elapsedSec = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`  waiting… ${elapsedSec}s\r`);
  }
  console.log('');
  if (!dashboardReached) {
    console.warn('  ⚠ timed out waiting for DASHBOARD_REACHED. Profile cookies may still be saved');
    console.warn('    if you actually signed in — running the smoke test next is the truth check.');
  }

  banner('STEP 4: persist profile (stop session, cookies auto-save)');
  try {
    await client.sessions.stop(sessionId);
    console.log('  ✓ session stopped — Browser Use saved cookies to the profile');
  } catch (err) {
    console.warn('  session stop returned an error (cookies usually still saved):', err?.message || String(err));
  }

  banner('STEP 5: write BROWSER_USE_PROFILE_ID to .env');
  updateEnvKey('BROWSER_USE_PROFILE_ID', profileId);
  console.log(`  ✓ BROWSER_USE_PROFILE_ID=${profileId} written to .env`);

  banner('DONE');
  console.log('Restart the dev server so the new profile id loads:');
  console.log("    pkill -f 'vite|node scripts/dev' ; npm run dev");
  console.log('');
  console.log('Then run a paid build — Browser Use sessions will attach to this profile,');
  console.log('reuse the Apple session cookie, and skip the MFA prompt entirely.');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function updateEnvKey(key, value) {
  const safeValue = String(value);
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const lineRegex = new RegExp(`^${key}=.*$`, 'gm');
  const matches = existing.match(lineRegex) || [];
  let next;
  if (matches.length === 0) {
    next = `${existing.replace(/\n*$/, '')}\n${key}=${safeValue}\n`;
  } else {
    let replaced = false;
    next = existing.replace(lineRegex, () => {
      if (replaced) return '';
      replaced = true;
      return `${key}=${safeValue}`;
    });
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
  console.error(`seed-anything-profile: ${msg}`);
  process.exit(1);
}
