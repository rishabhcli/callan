import { env } from '../env.js';
import { fetchJson, normalizeProviderError, providerConfigured, smokeDetail } from './core.js';

const PROVIDER = 'v0';
const DEFAULT_BASE_URL = 'https://api.v0.dev';
const DEFAULT_TIMEOUT_MS = Number(process.env.V0_TIMEOUT_MS || 60_000);
const DEPLOYMENT_URL_RE = /\bhttps:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:vercel\.app|v0\.build)(?:\/[^\s"'<>]*)?/ig;

export function v0Configured(config = v0Config()) {
  return providerConfigured({ V0_API_KEY: config.apiKey });
}

export function v0ReadinessDetails(config = v0Config()) {
  const configured = v0Configured(config);
  return {
    configured: configured.configured,
    missing: configured.missing,
    baseUrl: config.baseUrl,
    auth: 'V0_API_KEY',
    liveGate: env.live.builds ? 'enabled_by_LIVE_BUILDS' : 'disabled_by_default',
    resources: ['projects', 'chats', 'messages', 'deployments'],
    mockMode: 'synthetic_project_chat_message_deployment'
  };
}

export function v0Config() {
  return {
    apiKey: process.env.V0_API_KEY || '',
    baseUrl: process.env.V0_BASE_URL || DEFAULT_BASE_URL,
    modelId: process.env.V0_MODEL_ID || 'v0-max'
  };
}

export function classifyV0Failure(err) {
  const normalized = normalizeProviderError(err);
  const msg = String(normalized.message || '').toLowerCase();
  const status = Number(normalized.status || 0) || null;

  let category = 'unknown';
  let retryable = normalized.retryable;
  if (status === 401 || status === 403 || /\b(auth|api key|unauthorized|forbidden|permission)\b/.test(msg)) {
    category = 'auth';
    retryable = false;
  } else if (status === 409 || status === 422 || status === 413) {
    category = 'provider-rejected';
    retryable = false;
  } else if (status === 429 || /\b(rate.?limit|quota|too many)\b/.test(msg)) {
    category = 'rate-limited';
    retryable = true;
  } else if (/\b(timeout|timed out|abort)\b/.test(msg)) {
    category = 'timeout';
    retryable = true;
  } else if (status && status >= 500) {
    category = 'provider-error';
    retryable = true;
  } else if (status && status >= 400) {
    category = 'provider-rejected';
    retryable = false;
  }

  return {
    ...normalized,
    category,
    outcome: `failed:${category}`,
    retryable: retryable ?? true
  };
}

export function extractV0FinalUrl(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    const direct = firstString(
      value.webUrl,
      value.demoUrl,
      value.previewUrl,
      value.latestVersion?.demoUrl,
      value.deployment?.webUrl,
      value.deployment?.url
    );
    if (direct) return cleanUrl(direct);
  }
  const text = searchableText(value);
  const matches = [...text.matchAll(DEPLOYMENT_URL_RE)].map((m) => cleanUrl(m[0]));
  return matches.find(Boolean) || null;
}

export class V0Provider {
  constructor({ apiKey, baseUrl, modelId, live = false } = {}) {
    const config = v0Config();
    this.apiKey = apiKey ?? config.apiKey;
    this.baseUrl = (baseUrl || config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.modelId = modelId || config.modelId;
    this.live = live;
  }

  async createProject({ name, description, instructions }) {
    if (!this.live) {
      return mockProject({ name, description, instructions });
    }
    this.requireLive('createProject');
    return this.post('/v1/projects', {
      name,
      description,
      instructions,
      privacy: 'private'
    }, 'createProject');
  }

  async createChat({ projectId, message, metadata }) {
    if (!this.live) {
      return mockChat({ projectId, message, metadata });
    }
    this.requireLive('createChat');
    return this.post('/v1/chats', {
      projectId,
      message,
      modelConfiguration: {
        modelId: this.modelId,
        thinking: true
      },
      metadata
    }, 'createChat');
  }

  async sendMessage({ chatId, message }) {
    if (!this.live) {
      return mockMessage({ chatId, message });
    }
    this.requireLive('sendMessage');
    return this.post(`/v1/chats/${encodeURIComponent(chatId)}/messages`, {
      message,
      modelConfiguration: {
        modelId: this.modelId,
        thinking: true
      }
    }, 'sendMessage');
  }

  async getChat(chatId) {
    if (!this.live) return mockChat({ id: chatId });
    this.requireLive('getChat');
    return this.get(`/v1/chats/${encodeURIComponent(chatId)}`, 'getChat');
  }

  async createDeployment({ chatId, versionId, projectId }) {
    if (!this.live) {
      return mockDeployment({ chatId, versionId, projectId });
    }
    this.requireLive('createDeployment');
    return this.post('/v1/deployments', {
      chatId,
      versionId,
      projectId
    }, 'createDeployment');
  }

  requireLive(action) {
    if (!env.live.builds) throw providerError(`${PROVIDER}.${action} requires LIVE_BUILDS=true`, { retryable: false, code: 'live_gate' });
    if (!this.apiKey) throw providerError(`${PROVIDER}.${action} requires V0_API_KEY`, { retryable: false, code: 'auth' });
  }

  async get(path, action) {
    return fetchJson(PROVIDER, action, `${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers()
    }, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      classify: classifyV0Failure
    });
  }

  async post(path, body, action) {
    return fetchJson(PROVIDER, action, `${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(compact(body))
    }, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      classify: classifyV0Failure
    });
  }

  headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
  }
}

export class V0BuildTarget {
  constructor({ provider } = {}) {
    this.name = 'v0';
    this.provider = provider || null;
  }

  createSubmission({ brief, lead } = {}) {
    const prompt = String(brief || '').trim();
    if (!prompt) throw new Error('v0 prompt is required');
    return {
      target: this.name,
      provider: PROVIDER,
      prompt,
      url: null,
      submissionUrl: null,
      projectName: projectNameForLead(lead)
    };
  }

  async *runWithBrowserUse({ submission, live = false, lead, buildId } = {}) {
    const provider = this.provider || new V0Provider({ live });
    this.provider = provider;
    const projectName = submission?.projectName || projectNameForLead(lead);
    const prompt = submission?.prompt || '';

    yield action('create_project', 'Creating v0 project container.');
    const project = await provider.createProject({
      name: projectName,
      description: `Paid website fulfillment for ${lead?.business_name || projectName}.`,
      instructions: 'Build only from the supplied brief. Do not invent services, hours, staff, pricing, reviews, guarantees, or unsupported integrations.'
    });

    yield action('create_chat', 'Starting v0 chat with the paid build brief.', {
      providerProjectId: project?.id || null,
      projectUrl: project?.webUrl || null
    });
    const chat = await provider.createChat({
      projectId: project?.id,
      message: prompt,
      metadata: compact({ buildId, leadId: lead?.id, source: 'callmemaybe_fulfillment' })
    });

    yield action('send_message', 'Sending final acceptance checklist to v0.', {
      providerProjectId: project?.id || chat?.projectId || null,
      providerChatId: chat?.id || null,
      projectUrl: chat?.webUrl || project?.webUrl || null
    });
    const message = await provider.sendMessage({
      chatId: chat?.id,
      message: [
        'Before deployment, ensure the result follows the brief exactly:',
        '- real business facts only',
        '- visible phone/contact path',
        '- no invented booking, pricing, staff names, reviews, or guarantees',
        '- polished mobile-first local services layout'
      ].join('\n')
    });

    let versionId = versionIdFrom(message) || versionIdFrom(chat);
    let chatDetails = chat;
    if (!versionId && chat?.id) {
      yield action('get_chat', 'Refreshing v0 chat for the latest generated version.', {
        providerChatId: chat.id
      });
      chatDetails = await provider.getChat(chat.id);
      versionId = versionIdFrom(chatDetails);
    }
    if (!versionId) throw providerError('v0 did not return a deployable version id', { retryable: true, code: 'missing_version' });

    yield action('create_deployment', 'Creating v0 deployment.', {
      providerProjectId: project?.id || chatDetails?.projectId || null,
      providerChatId: chat?.id || chatDetails?.id || null,
      providerVersionId: versionId
    });
    const deployment = await provider.createDeployment({
      chatId: chat?.id || chatDetails?.id,
      versionId,
      projectId: project?.id || chatDetails?.projectId
    });
    const projectUrl = this.extractFinalUrl(deployment) || this.extractFinalUrl(chatDetails) || this.extractFinalUrl(project);
    if (projectUrl) {
      yield {
        kind: 'project_url',
        target: this.name,
        phase: 'v0_deployment',
        projectUrl,
        providerProjectId: project?.id || chatDetails?.projectId || null,
        providerDeploymentId: deployment?.id || null
      };
    }
    yield {
      kind: 'done',
      target: this.name,
      phase: 'v0_deployment',
      projectUrl,
      providerProjectId: project?.id || chatDetails?.projectId || null,
      providerDeploymentId: deployment?.id || null,
      summary: projectUrl ? 'v0 deployment completed.' : 'v0 completed without a deployment URL.',
      raw: { project, chat: chatDetails, message, deployment }
    };
  }

  detectAuthWall() {
    return null;
  }

  extractFinalUrl(value) {
    return extractV0FinalUrl(value);
  }

  normalizeProgress(message) {
    return {
      kind: 'progress',
      target: this.name,
      phase: 'v0',
      provider: PROVIDER,
      summary: String(message?.summary || message?.message || message?.type || 'v0 action').slice(0, 360)
    };
  }

  async stop() {}

  async cleanup() {}
}

export async function smokeV0({ config = v0Config() } = {}) {
  const configured = v0Configured(config);
  if (!configured.configured) {
    return { provider: PROVIDER, status: 'missing', detail: smokeDetail({ skipped: configured.missing.join(', ') }) };
  }
  return {
    provider: PROVIDER,
    status: 'configured',
    detail: smokeDetail({
      skipped: env.live.builds ? 'set a specific fulfillment target to run live v0 builds' : 'LIVE_BUILDS=false',
      extra: { baseUrl: config.baseUrl, resources: ['projects', 'chats', 'messages', 'deployments'] }
    })
  };
}

function action(providerAction, summary, extra = {}) {
  return {
    kind: 'provider_action',
    target: 'v0',
    provider: PROVIDER,
    phase: providerAction,
    providerAction,
    summary,
    ...extra
  };
}

function mockProject({ name, description, instructions }) {
  const id = mockId('prj', name);
  return {
    id,
    object: 'project',
    name,
    description,
    instructions,
    privacy: 'private',
    apiUrl: `https://api.v0.dev/v1/projects/${id}`,
    webUrl: `https://v0.dev/chat/projects/${id}`,
    createdAt: new Date().toISOString()
  };
}

function mockChat({ id, projectId, message, metadata } = {}) {
  const chatId = id || mockId('chat', projectId || message);
  const versionId = mockId('ver', chatId);
  return {
    id: chatId,
    object: 'chat',
    projectId,
    webUrl: `https://v0.dev/chat/${chatId}`,
    apiUrl: `https://api.v0.dev/v1/chats/${chatId}`,
    latestVersion: {
      id: versionId,
      object: 'version',
      status: 'completed',
      demoUrl: `https://${chatId}.v0.build`
    },
    metadata,
    messages: message ? [{ id: mockId('msg', message), role: 'user', content: message }] : []
  };
}

function mockMessage({ chatId, message }) {
  const versionId = mockId('ver', `${chatId}:${message}:message`);
  return {
    id: mockId('msg', `${chatId}:${message}`),
    object: 'message',
    chatId,
    role: 'assistant',
    content: 'Mock v0 generated the requested website.',
    latestVersion: {
      id: versionId,
      object: 'version',
      status: 'completed',
      demoUrl: `https://${chatId}.v0.build`
    }
  };
}

function mockDeployment({ chatId, versionId, projectId }) {
  const id = mockId('dep', `${chatId}:${versionId}`);
  return {
    id,
    object: 'deployment',
    chatId,
    projectId,
    versionId,
    inspectorUrl: `https://v0.dev/deployments/${id}`,
    apiUrl: `https://api.v0.dev/v1/deployments/${id}`,
    webUrl: `https://${slugify(chatId || projectId || id)}.vercel.app`
  };
}

function versionIdFrom(value) {
  return firstString(value?.latestVersion?.id, value?.versionId, value?.version?.id, value?.deployment?.versionId);
}

function projectNameForLead(lead) {
  const name = String(lead?.business_name || 'customer website').trim();
  return `${name.slice(0, 48)} website`;
}

function providerError(message, extra = {}) {
  const err = new Error(message);
  Object.assign(err, extra, { provider: PROVIDER });
  return err;
}

function mockId(prefix, seed = '') {
  const safe = slugify(seed).replace(/-/g, '_').slice(0, 32) || Date.now().toString(36);
  return `${prefix}_${safe}`;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'site';
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

function searchableText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}
