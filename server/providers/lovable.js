const LOVABLE_BASE_URL = 'https://lovable.dev/?autosubmit=true';
export const LOVABLE_PROMPT_MAX_CHARS = 50_000;
export const LOVABLE_IMAGE_MAX = 10;

const LOVABLE_PROJECT_RE = /\bhttps:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lovable\.app(?:\/[^\s"'<>]*)?/ig;
const AUTH_WALL_RE = /\b(BLOCKED_AUTH|auth(?:entication)? (?:needed|required)|login required|log in|login|sign in|sign-in|signin|continue with (?:google|github|email)|create an account|session expired)\b/i;

export function createLovablePromptUrl(prompt, { images = [] } = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new Error('Lovable prompt is required');
  if (cleanPrompt.length > LOVABLE_PROMPT_MAX_CHARS) {
    throw new Error(`Lovable prompt exceeds ${LOVABLE_PROMPT_MAX_CHARS} characters`);
  }

  const cleanImages = normalizeImages(images);
  const hashParts = [`prompt=${encodeURIComponent(cleanPrompt)}`];
  for (const image of cleanImages) hashParts.push(`images=${encodeURIComponent(image)}`);
  return `${LOVABLE_BASE_URL}#${hashParts.join('&')}`;
}

export function extractLovableAppUrl(value) {
  const text = searchableText(value);
  const matches = [...text.matchAll(LOVABLE_PROJECT_RE)].map((m) => cleanUrl(m[0]));
  return matches.find(Boolean) || null;
}

export function detectLovableAuthWall(value) {
  if (isUserMessage(value)) return null;

  const text = searchableText(value);
  if (!text) return null;
  if (/\bBLOCKED_AUTH\b/i.test(text)) return { reason: 'agent_reported_blocked_auth' };
  if (!AUTH_WALL_RE.test(text)) return null;
  return { reason: 'lovable_login_required' };
}

export function normalizeLovableProgress(message, { phase = 'lovable_build' } = {}) {
  const dataSummary = summarizeData(message?.data);
  const summary = firstString(message?.summary, dataSummary, message?.text, message?.message, message?.type);
  if (!summary) return null;

  return {
    kind: 'progress',
    phase,
    target: 'lovable',
    provider: 'browserUse',
    messageId: message?.id || null,
    providerType: message?.type || null,
    role: message?.role || null,
    summary: truncate(summary, 360),
    screenshotUrl: message?.screenshotUrl || null,
    providerTs: message?.createdAt || null
  };
}

export function buildLovableSubmissionTask({ submissionUrl, brief }) {
  return [
    'You are submitting a paid customer website build to Lovable.',
    `Open this exact URL: ${submissionUrl}`,
    'If the build-with-URL flow does not start, paste the full brief below into Lovable and submit it.',
    'If Lovable shows any login, sign-in, account, Google/GitHub OAuth, or authentication wall, stop immediately and answer exactly BLOCKED_AUTH.',
    'While Lovable works, keep the session on the build page and report concise progress.',
    'When a final published .lovable.app URL is visible, copy it exactly.',
    'Your final answer must include either "PROJECT_URL: https://...lovable.app" or "BLOCKED_AUTH".',
    '',
    'Brief:',
    brief
  ].join('\n');
}

export class LovableBuildTarget {
  constructor() {
    this.name = 'lovable';
    this.provider = 'browserUse';
    this.browserUse = null;
    this.sessionId = null;
  }

  createSubmission({ brief, images = [] } = {}) {
    const prompt = String(brief || '').trim();
    const url = createLovablePromptUrl(prompt, { images });
    return {
      target: this.name,
      provider: this.provider,
      prompt,
      images: normalizeImages(images),
      url,
      submissionUrl: url
    };
  }

  async *runWithBrowserUse({ browserUse, submission, brief } = {}) {
    if (!browserUse) throw new Error('Lovable target requires a Browser Use adapter');
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
      submissionUrl: submission?.submissionUrl || submission?.url || null,
      summary: 'Browser Use session opened for Lovable.'
    };

    const task = browserUse.runTask({
      sessionId: this.sessionId,
      task: buildLovableSubmissionTask({
        submissionUrl: submission?.submissionUrl || submission?.url,
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
        yield { kind: 'blocked_auth', target: this.name, phase: 'lovable_build', ...auth };
        return;
      }

      const foundUrl = this.extractFinalUrl(message);
      if (foundUrl && foundUrl !== projectUrl) {
        projectUrl = foundUrl;
        yield { kind: 'project_url', target: this.name, phase: 'lovable_build', projectUrl };
      }
    }

    const result = await Promise.resolve(task.result);
    const auth = this.detectAuthWall(result);
    if (auth) {
      yield { kind: 'blocked_auth', target: this.name, phase: 'lovable_build', ...auth };
      return;
    }

    const finalUrl = projectUrl || this.extractFinalUrl(result);
    if (finalUrl && finalUrl !== projectUrl) {
      projectUrl = finalUrl;
      yield { kind: 'project_url', target: this.name, phase: 'lovable_build', projectUrl };
    }

    yield {
      kind: 'done',
      target: this.name,
      phase: 'lovable_build',
      projectUrl,
      successful: result?.isTaskSuccessful ?? null,
      summary: result?.lastStepSummary || (projectUrl ? 'Lovable build completed.' : 'Lovable task completed without a project URL.'),
      output: truncate(searchableText(result?.output), 1_000)
    };
  }

  detectAuthWall(value) {
    return detectLovableAuthWall(value);
  }

  extractFinalUrl(value) {
    return extractLovableAppUrl(value);
  }

  normalizeProgress(message) {
    return normalizeLovableProgress(message, { phase: 'lovable_build' });
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
  if (clean.length > LOVABLE_IMAGE_MAX) throw new Error(`Lovable supports at most ${LOVABLE_IMAGE_MAX} images`);
  for (const image of clean) {
    let url;
    try {
      url = new URL(image);
    } catch {
      throw new Error(`Lovable image URL is invalid: ${image}`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Lovable image URL must be public http(s): ${image}`);
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
  } catch {
    return data;
  }
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
  } catch {
    return String(value);
  }
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}
