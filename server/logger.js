const PHONE_RE = /\+?\d[\d -]{6,}\d/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEY_RE = /\b(sk_(?:test_|live_)?|rk_(?:test_|live_)?|am_(?:us_|eu_)?|sm_|bu_|moss_|AIza|cmp_?|cmp2)[A-Za-z0-9_.\-]{6,}/g;

export function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(KEY_RE, (m) => `${m.slice(0, 6)}…`)
      .replace(PHONE_RE, (m) => `${m.slice(0, 3)}…${m.slice(-2)}`)
      .replace(EMAIL_RE, (m) => `${m[0]}…@${m.split('@')[1]?.split('.').pop() ?? '…'}`);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/key|secret|token|password/i.test(k)) out[k] = typeof v === 'string' && v ? `${v.slice(0, 4)}…` : v;
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function fmt(level, msg, meta) {
  const line = { t: new Date().toISOString(), level, msg };
  if (meta !== undefined) line.meta = redact(meta);
  return JSON.stringify(line);
}

export const log = {
  info: (msg, meta) => console.log(fmt('info', msg, meta)),
  warn: (msg, meta) => console.warn(fmt('warn', msg, meta)),
  error: (msg, meta) => console.error(fmt('error', msg, meta)),
  debug: (msg, meta) => {
    if (process.env.DEBUG) console.log(fmt('debug', msg, meta));
  }
};
