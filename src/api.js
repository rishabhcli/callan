async function jsonOr(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

const ADMIN_TOKEN_KEY = 'callan.adminToken';
const ADMIN_COOKIE_NAME = 'callan_admin_token';
const ADMIN_TOKEN_EVENT = 'callan-admin-token-changed';

function bundledAdminToken() {
  return import.meta.env?.VITE_ADMIN_API_TOKEN || '';
}

function adminToken() {
  if (typeof window === 'undefined') return bundledAdminToken();
  const token = window.localStorage.getItem(ADMIN_TOKEN_KEY) || bundledAdminToken();
  syncAdminCookie(token);
  return token;
}

async function call(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  const token = adminToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await jsonOr(res);
  if (!res.ok) {
    const msg = data?.error?.formErrors?.[0] || data?.error || res.statusText;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

export const api = {
  getAdminToken: adminToken,
  setAdminToken: (token = '') => {
    if (typeof window === 'undefined') return;
    const value = String(token || '').trim();
    if (value) window.localStorage.setItem(ADMIN_TOKEN_KEY, value);
    else window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    syncAdminCookie(value);
    window.dispatchEvent(new CustomEvent(ADMIN_TOKEN_EVENT, { detail: { configured: Boolean(value) } }));
  },
  health: () => call('GET', '/api/health'),
  listLeads: () => call('GET', '/api/leads'),
  getLead: (id) => call('GET', `/api/leads/${id}`),
  getLeadTrust: (id) => call('GET', `/api/leads/${id}/trust`),
  listHandoffCases: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/handoff/cases${q.toString() ? `?${q}` : ''}`);
  },
  getLeadHandoff: (id) => call('GET', `/api/leads/${id}/handoff`),
  handoffAction: (caseId, body = {}) => call('POST', `/api/handoff/cases/${caseId}/actions`, body),
  listReasoningTraces: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    return call('GET', `/api/reasoning/traces${q.toString() ? `?${q}` : ''}`);
  },
  getLeadReasoning: (id) => call('GET', `/api/leads/${id}/reasoning`),
  discover: ({ niche, city, count }) => call('POST', '/api/leads/discover', { niche, city, count }),
  startCall: (id, body = {}) => call('POST', `/api/leads/${id}/call`, body),
  approveLiveCall: (id) => call('POST', `/api/leads/${id}/approve-live-call`, {}),
  blockLead: (id, body = {}) => call('POST', `/api/leads/${id}/block`, body),
  optOutLead: (id, body = {}) => call('POST', `/api/leads/${id}/opt-out`, body),
  forceRetry: (id, body = {}) => call('POST', `/api/leads/${id}/force-retry`, body),
  explainCallability: (id) => call('GET', `/api/leads/${id}/callability`),
  followup: (id, toEmail) => call('POST', `/api/leads/${id}/followup`, { toEmail }),
  build: (id, body = {}) => call('POST', `/api/leads/${id}/build`, body),
  getGrowth: (id) => call('GET', `/api/leads/${id}/growth`),
  generateGrowthPlan: (id, body = {}) => call('POST', `/api/leads/${id}/growth/plan`, body),
  sendGrowthFollowup: (id, body = {}) => call('POST', `/api/leads/${id}/growth/followup`, body),
  getAccountManager: (id) => call('GET', `/api/leads/${id}/account-manager`),
  generateAccountManagerPlan: (id, body = {}) => call('POST', `/api/leads/${id}/account-manager/plan`, body),
  runAccountManager: (id, body = {}) => call('POST', `/api/leads/${id}/account-manager/run`, body),
  explainAccountTask: (id) => call('GET', `/api/account-tasks/${id}/explain`),
  approveAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/approve`, body),
  sendAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/send`, body),
  pauseAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/pause`, body),
  completeAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/complete`, body),
  reassignAccountTask: (id, body = {}) => call('POST', `/api/account-tasks/${id}/reassign`, body),
  getCommerce: (id) => call('GET', `/api/leads/${id}/commerce`),
  planCommerce: (id, body = {}) => call('POST', `/api/leads/${id}/commerce/plan`, body),
  outreachStatus: () => call('GET', '/api/outreach/status'),
  startOutreach: () => call('POST', '/api/outreach/start', {}),
  stopOutreach: () => call('POST', '/api/outreach/stop', {}),
  pauseOutreach: (reason = 'operator_pause') => call('POST', '/api/outreach/pause', { reason }),
  resumeOutreach: (reason = 'operator_resume') => call('POST', '/api/outreach/resume', { reason }),
  emergencyStop: (reason = 'emergency_stop') => call('POST', '/api/emergency-stop', { reason }),
  scheduledCalls: () => call('GET', '/api/scheduled-calls'),
  cancelScheduledCall: (id, reason = 'operator_cancel') => call('POST', `/api/scheduled-calls/${id}/cancel`, { reason }),
  fireScheduledCallNow: (id, reason = 'operator_fire_now') => call('POST', `/api/scheduled-calls/${id}/fire`, { reason }),
  experiments: () => call('GET', '/api/experiments'),
  economicsByNiche: () => call('GET', '/api/economics/by-niche'),
  opsCommandCenter: () => call('GET', '/api/ops/command-center'),
  opsObservability: () => call('GET', '/api/ops/observability'),
  recoverStuckOps: (body = {}) => call('POST', '/api/ops/recover-stuck', body),
  enqueueOpsSelfCheck: (body = {}) => call('POST', '/api/ops/self-check', body),
  exportOps: ({ includePII = false, limit = 500 } = {}) => {
    const q = new URLSearchParams({
      includePII: includePII ? 'true' : 'false',
      limit: String(limit)
    });
    return call('GET', `/api/admin/export?${q}`);
  },
  backupOps: () => call('POST', '/api/admin/backup', {}),
  listBackups: () => call('GET', '/api/admin/backups'),
  resetMockData: ({ dryRun = true } = {}) => call('POST', '/api/admin/reset-mock-data', {
    confirm: 'RESET_MOCK_DATA',
    dryRun
  }),
  reputationStatus: () => call('GET', '/api/reputation/status'),
  referralsRollup: () => call('GET', '/api/referrals/rollup'),
  leadPriorities: () => call('GET', '/api/leads/priorities')
};

function syncAdminCookie(token = '') {
  if (typeof document === 'undefined') return;
  const secure = window.location?.protocol === 'https:' ? '; Secure' : '';
  if (!token) {
    document.cookie = `${ADMIN_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    return;
  }
  document.cookie = `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; SameSite=Lax${secure}`;
}
