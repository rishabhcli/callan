async function jsonOr(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

async function call(method, path, body) {
  const opts = { method, headers: {} };
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
  health: () => call('GET', '/api/health'),
  listLeads: () => call('GET', '/api/leads'),
  getLead: (id) => call('GET', `/api/leads/${id}`),
  discover: ({ niche, city, count }) => call('POST', '/api/leads/discover', { niche, city, count }),
  startCall: (id, body = {}) => call('POST', `/api/leads/${id}/call`, body),
  approveLiveCall: (id) => call('POST', `/api/leads/${id}/approve-live-call`, {}),
  blockLead: (id, body = {}) => call('POST', `/api/leads/${id}/block`, body),
  optOutLead: (id, body = {}) => call('POST', `/api/leads/${id}/opt-out`, body),
  forceRetry: (id, body = {}) => call('POST', `/api/leads/${id}/force-retry`, body),
  explainCallability: (id) => call('GET', `/api/leads/${id}/callability`),
  followup: (id, toEmail) => call('POST', `/api/leads/${id}/followup`, { toEmail }),
  build: (id) => call('POST', `/api/leads/${id}/build`, {}),
  outreachStatus: () => call('GET', '/api/outreach/status'),
  startOutreach: () => call('POST', '/api/outreach/start', {}),
  stopOutreach: () => call('POST', '/api/outreach/stop', {})
};
