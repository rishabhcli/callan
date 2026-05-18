#!/usr/bin/env node
/**
 * Smoke test: confirm the seeded BROWSER_USE_PROFILE_ID still passes
 * anything.com's auth gate without re-prompting Sign in with Apple / MFA.
 *
 * Opens a fresh Browser Use session under the configured profile, navigates
 * to https://www.anything.com/dashboard, and asks the agent to report whether
 * it landed on the dashboard or hit a sign-in wall. Exits non-zero if auth
 * is required (you'd then re-run scripts/seed-anything-profile.js).
 *
 * Usage:
 *   node scripts/test-anything-session.js
 */

import 'dotenv/config';
import { BrowserUse } from 'browser-use-sdk/v3';

const API_KEY = process.env.BROWSER_USE_API_KEY;
const BASE_URL = process.env.BROWSER_USE_BASE_URL || 'https://api.browser-use.com/api/v3';
const PROFILE_ID = process.env.BROWSER_USE_PROFILE_ID;

if (!API_KEY) fatal('Missing BROWSER_USE_API_KEY in .env');
if (!PROFILE_ID) fatal('Missing BROWSER_USE_PROFILE_ID — run scripts/seed-anything-profile.js first');

const client = new BrowserUse({ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 1, timeout: 30_000 });

main().catch((err) => {
  console.error('\ntest-anything-session failed:', err?.message || err);
  process.exit(1);
});

async function main() {
  console.log(`profile: ${PROFILE_ID}`);
  console.log('opening anything.com under the seeded profile…');

  const session = await client.sessions.create({
    profileId: PROFILE_ID,
    keepAlive: false,
    task: [
      'Open https://www.anything.com/dashboard in the browser.',
      'Look at the page. Decide:',
      '  - If you are signed in and see a dashboard with teams/apps/payments → answer exactly: AUTHENTICATED',
      '  - If you see a "Sign in with Apple" button or any sign-in screen → answer exactly: BLOCKED_AUTH',
      'Do not try to sign in. Just report what you see.'
    ].join('\n')
  });
  const sessionId = session?.sessionId || session?.id || session?.session?.id;
  console.log(`session: ${sessionId}`);
  console.log(`live URL: ${session?.liveUrl || session?.live_url || '(none)'}`);

  // Poll until the agent finishes.
  let result = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const s = await client.sessions.get(sessionId).catch(() => null);
    const status = s?.status || s?.agentStatus || s?.session?.status;
    if (status === 'completed' || status === 'finished' || status === 'done' || status === 'stopped') {
      result = s;
      break;
    }
  }
  if (!result) {
    console.log('agent did not complete within 2 minutes — inspect session manually:');
    console.log(`  ${session?.liveUrl}`);
    process.exit(2);
  }

  const output = JSON.stringify(result?.output || result?.result?.output || result?.summary || result, null, 2);
  console.log('---agent output---');
  console.log(output);

  const authed = /\bAUTHENTICATED\b/i.test(output);
  const blocked = /\bBLOCKED_AUTH\b/i.test(output);
  if (authed && !blocked) {
    console.log('\n✓ profile still authenticated. anything.com builds will run without MFA re-prompt.');
    process.exit(0);
  }
  if (blocked) {
    console.error('\n✗ profile session is NOT authenticated — re-seed:');
    console.error('  node scripts/seed-anything-profile.js');
    process.exit(1);
  }
  console.error('\n? agent output did not match either marker. Inspect live URL manually.');
  process.exit(3);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function fatal(msg) { console.error(`test-anything-session: ${msg}`); process.exit(1); }
