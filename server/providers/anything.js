/**
 * anything.com build target — sibling of LovableBuildTarget.
 *
 * Unlike Lovable, anything.com doesn't expose a URL-encoded prompt parameter
 * (i.e. there's no `?prompt=...&autosubmit=true` shortcut we can hit). Instead
 * the agent navigates to the dashboard, clicks "New app", pastes the brief
 * into the prompt input, and waits for the published URL.
 *
 * Authentication is handled out-of-band via a persistent Browser Use profile
 * (BROWSER_USE_PROFILE_ID). One Apple Sign-In + MFA seed is enough — the
 * profile's cookie carries forward, so every subsequent session lands inside
 * the authenticated dashboard.
 */

const ANYTHING_DASHBOARD_URL = 'https://www.anything.com/dashboard';
export const ANYTHING_PROMPT_MAX_CHARS = 50_000;
export const ANYTHING_IMAGE_MAX = 10;

// anything.com published apps could land on a few possible hostnames depending
// on which deploy pipeline they pick. Match all of them; first hit wins.
const ANYTHING_PROJECT_RE = /\bhttps:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:anything\.app|anything\.dev|anything\.run|anythingapp\.com)(?:\/[^\s"'<>]*)?/ig;

const AUTH_WALL_RE = /\b(BLOCKED_AUTH|sign\s*in\s*with\s*apple|auth(?:entication)? (?:needed|required)|login required|please log in|please sign in|continue with (?:apple|google|github|email))\b/i;

export function createAnythingPromptUrl(_prompt, _opts = {}) {
  // anything.com has no public URL-encoded prompt entry point. The Browser Use
  // task uses the dashboard URL as the start point and types the prompt into
  // the in-app composer. We still return a stable URL string for logging and
  // for the `builder.submissionUrl` field downstream.
  return ANYTHING_DASHBOARD_URL;
}

export function extractAnythingAppUrl(value) {
  const text = searchableText(value);
  const matches = [...text.matchAll(ANYTHING_PROJECT_RE)].map((m) => cleanUrl(m[0]));
  return matches.find(Boolean) || null;
}

export function detectAnythingAuthWall(value) {
  if (isUserMessage(value)) return null;
  const text = searchableText(value);
  if (!text) return null;
  if (/\bBLOCKED_AUTH\b/i.test(text)) return { reason: 'agent_reported_blocked_auth' };
  if (!AUTH_WALL_RE.test(text)) return null;
  return { reason: 'anything_login_required' };
}

export function normalizeAnythingProgress(message, { phase = 'anything_build' } = {}) {
  const dataSummary = summarizeData(message?.data);
  const summary = firstString(message?.summary, dataSummary, message?.text, message?.message, message?.type);
  if (!summary) return null;
  return {
    kind: 'progress',
    phase,
    target: 'anything',
    provider: 'browserUse',
    messageId: message?.id || null,
    providerType: message?.type || null,
    role: message?.role || null,
    summary: truncate(summary, 360),
    screenshotUrl: message?.screenshotUrl || null,
    providerTs: message?.createdAt || null
  };
}

export function buildAnythingSubmissionTask({ dashboardUrl, brief }) {
  return [
    'You are submitting a paid customer website build to anything.com (an AI app builder).',
    'You are already signed in via a persistent Browser Use profile — do NOT attempt to re-authenticate.',
    `Open this exact URL: ${dashboardUrl}`,
    'On the dashboard, find and click the "New app" / "Create" / "Start a new build" button (it may be labeled differently — look for the primary CTA that starts a new project).',
    'In the prompt / composer / chat input that opens, paste the FULL brief below verbatim, then submit it (Enter key or the submit button).',
    'While anything.com works, stay on the build page and report short progress notes (what step the build is on, any preview URL it shows).',
    'When a final deployed app URL appears (something like https://<name>.anything.app or .anything.dev or .anything.run), copy it exactly.',
    'If at any point you hit a Sign in with Apple, login required, or any authentication wall — STOP and answer exactly: BLOCKED_AUTH',
    'Your final answer must include either "PROJECT_URL: https://...anything.app" (or .dev/.run) or "BLOCKED_AUTH".',
    '',
    'Brief:',
    brief
  ].join('\n');
}

export class AnythingBuildTarget {
  constructor() {
    this.name = 'anything';
    this.provider = 'browserUse';
    this.browserUse = null;
    this.sessionId = null;
  }

  createSubmission({ brief, images = [] } = {}) {
    const prompt = String(brief || '').trim();
    if (!prompt) throw new Error('anything.com prompt is required');
    if (prompt.length > ANYTHING_PROMPT_MAX_CHARS) {
      throw new Error(`anything.com prompt exceeds ${ANYTHING_PROMPT_MAX_CHARS} characters`);
    }
    return {
      target: this.name,
      provider: this.provider,
      prompt,
      images: normalizeImages(images),
      url: ANYTHING_DASHBOARD_URL,
      submissionUrl: ANYTHING_DASHBOARD_URL
    };
  }

  async *runWithBrowserUse({ browserUse, submission, brief } = {}) {
    if (!browserUse) throw new Error('anything target requires a Browser Use adapter');
    this.browserUse = browserUse;

    const session = await browserUse.createSession({ keepAlive: true });
    this.sessionId = session.sessionId;
    if (!this.sessionId) throw new Error('browser-use session create returned no session id');

    yield {
      kind: 'live_url',
      target: this.name,
      provider: this.provider,
      liveUrl: session.liveUrl || null,
      sessionId: this.sessionId,
      submissionUrl: submission?.submissionUrl || submission?.url || ANYTHING_DASHBOARD_URL,
      summary: 'Browser Use session opened for anything.com.'
    };

    const task = browserUse.runTask({
      sessionId: this.sessionId,
      task: buildAnythingSubmissionTask({
        dashboardUrl: submission?.submissionUrl || submission?.url || ANYTHING_DASHBOARD_URL,
        brief: brief || submission?.prompt || ''
      })
    });

    let projectUrl = null;

    for await (const message of task) {
      const progress = this.normalizeProgress(message);
      if (progress) yield progress;

      const auth = this.detectAuthWall(message);
      if (auth) {
        await browserUse.stopTask?.(this.sessionId);
        yield { kind: 'blocked_auth', target: this.name, phase: 'anything_build', ...auth };
        return;
      }

      const foundUrl = this.extractFinalUrl(message);
      if (foundUrl && foundUrl !== projectUrl) {
        projectUrl = foundUrl;
        yield { kind: 'project_url', target: this.name, phase: 'anything_build', projectUrl };
      }
    }

    const result = await Promise.resolve(task.result);
    const auth = this.detectAuthWall(result);
    if (auth) {
      yield { kind: 'blocked_auth', target: this.name, phase: 'anything_build', ...auth };
      return;
    }

    const finalUrl = projectUrl || this.extractFinalUrl(result);
    if (finalUrl && finalUrl !== projectUrl) {
      projectUrl = finalUrl;
      yield { kind: 'project_url', target: this.name, phase: 'anything_build', projectUrl };
    }

    yield {
      kind: 'done',
      target: this.name,
      phase: 'anything_build',
      projectUrl,
      successful: result?.isTaskSuccessful ?? null,
      summary: result?.lastStepSummary || (projectUrl ? 'anything.com build completed.' : 'anything.com task completed without a project URL.'),
      output: truncate(searchableText(result?.output), 1_000)
    };
  }

  detectAuthWall(value) {
    return detectAnythingAuthWall(value);
  }

  extractFinalUrl(value) {
    return extractAnythingAppUrl(value);
  }

  normalizeProgress(message) {
    return normalizeAnythingProgress(message, { phase: 'anything_build' });
  }

  async stop() {
    if (this.browserUse && this.sessionId) await this.browserUse.stopTask?.(this.sessionId);
  }

  async cleanup() {
    if (this.browserUse && this.sessionId) await this.browserUse.stopSession?.(this.sessionId);
    this.sessionId = null;
  }
}

function normalizeImages(images) {
  const clean = Array.isArray(images) ? images.map((image) => String(image || '').trim()).filter(Boolean) : [];
  if (clean.length > ANYTHING_IMAGE_MAX) throw new Error(`anything.com supports at most ${ANYTHING_IMAGE_MAX} images`);
  for (const image of clean) {
    let url;
    try { url = new URL(image); } catch { throw new Error(`anything.com image URL is invalid: ${image}`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`anything.com image URL must be public http(s): ${image}`);
  }
  return clean;
}

function searchableText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeStringify(value);
}

function summarizeData(data) {
  if (!data) return null;
  if (typeof data !== 'string') return searchableText(data);
  try {
    const parsed = JSON.parse(data);
    return firstString(parsed?.summary, parsed?.text, parsed?.message, parsed?.url, parsed?.title, data);
  } catch { return data; }
}

function isUserMessage(value) {
  if (!value || typeof value !== 'object') return false;
  return value.role === 'human' || value.type === 'user_message';
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function cleanUrl(url) {
  return String(url || '').replace(/[.,;:!?'"`)\]}>\s]+$/g, '');
}

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== 'object' || nested === null) return nested;
      if (seen.has(nested)) return '[Circular]';
      seen.add(nested);
      return nested;
    });
  } catch { return String(value); }
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}
