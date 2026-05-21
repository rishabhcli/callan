export function operationalErrorMessage(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  try { return JSON.stringify(err); } catch {}
  return String(err);
}

export function operationalErrorSummary(err, { maxLength = 160 } = {}) {
  const text = operationalErrorMessage(err).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (/api key not valid|api_key_invalid|invalid api key/i.test(text)) return 'API key not valid';
  if (/\b401\b|unauthorized/i.test(text)) return 'unauthorized';
  if (/\b403\b|forbidden|permission denied/i.test(text)) return 'permission denied';
  if (/quota|rate.?limit|too many requests/i.test(text)) return 'quota or rate limit';
  if (/timeout|timed out/i.test(text)) return 'timeout';
  const limit = Math.max(40, Number(maxLength) || 160);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

export function isRetryableOperationalError(err) {
  if (err?.retryable === false) return false;
  if (err?.retryable === true) return true;
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0) || null;
  if (status === 401 || status === 403) return false;
  if (status === 400 || status === 404 || status === 422) return false;
  if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;
  const message = operationalErrorMessage(err).toLowerCase();
  if (/\b(api key|apikey|unauthorized|forbidden|permission denied|invalid credentials|invalid api key|token expired|not configured)\b/.test(message)) {
    return false;
  }
  if (/\b(invalid_argument|invalid argument|validation failed|schema validation|bad request)\b/.test(message)) {
    return false;
  }
  if (/\b(rate.?limit|too many requests|quota|resource_exhausted|timeout|timed out|temporar|network|econn|enotfound|etimedout|socket|unavailable|overloaded|deadlock|locked)\b/.test(message)) {
    return true;
  }
  return undefined;
}
