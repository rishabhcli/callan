import { timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

export const ADMIN_TOKEN_MIN_LENGTH = 24;
const PROTECTED_MODES = new Set(['production_review', 'production_live']);
const OPERATOR_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const OPERATOR_READ_METHODS = new Set(['GET', 'HEAD']);
const ADMIN_COOKIE_NAME = 'callan_admin_token';
const PUBLIC_API_PREFIXES = [
  '/api/webhooks/',
  '/api/share/build/',
  '/api/hosting/accept/',
  '/api/preview-build/'
];
const PUBLIC_API_EXACT_PATHS = new Set([
  '/api/ping',
  '/api/referrals/landing-html'
]);

export function adminAuthPosture({
  mode = env.runMode,
  nodeEnv = env.nodeEnv,
  token = env.admin?.apiToken || ''
} = {}) {
  const requiredByMode = PROTECTED_MODES.has(mode);
  const requiredByNodeEnv = nodeEnv === 'production';
  const required = requiredByMode || requiredByNodeEnv;
  const configured = Boolean(token);
  const strong = configured && token.length >= ADMIN_TOKEN_MIN_LENGTH;
  const blockers = [];

  if (required && !configured) {
    blockers.push('ADMIN_API_TOKEN is required for production admin and ops controls');
  }
  if (configured && !strong) {
    blockers.push(`ADMIN_API_TOKEN must be at least ${ADMIN_TOKEN_MIN_LENGTH} characters`);
  }

  return {
    required,
    configured,
    strong,
    ok: blockers.length === 0,
    blockers,
    nextAction: blockers.length ? 'set a strong ADMIN_API_TOKEN before production review/live' : 'monitor'
  };
}

export function adminAuthStatus({
  providedToken = '',
  configuredToken = env.admin?.apiToken || '',
  mode = env.runMode,
  nodeEnv = env.nodeEnv
} = {}) {
  const posture = adminAuthPosture({ mode, nodeEnv, token: configuredToken });
  const enforced = posture.required || posture.configured;
  if (!enforced) return { ok: true, enforced: false, posture };
  if (!posture.configured) {
    return {
      ok: false,
      enforced: true,
      code: 'ADMIN_AUTH_NOT_CONFIGURED',
      error: 'admin auth token is not configured',
      posture
    };
  }
  if (posture.required && !posture.strong) {
    return {
      ok: false,
      enforced: true,
      code: 'ADMIN_AUTH_WEAK_TOKEN',
      error: 'admin auth token is too weak for production controls',
      posture
    };
  }
  if (constantTimeEqual(providedToken, configuredToken)) {
    return { ok: true, enforced: true, posture };
  }
  return {
    ok: false,
    enforced: true,
    code: 'ADMIN_AUTH_REQUIRED',
    error: 'admin token required',
    posture
  };
}

export function extractAdminToken(req) {
  const auth = String(req.get?.('authorization') || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer?.[1]) return bearer[1].trim();
  const header = String(req.get?.('x-admin-token') || '').trim();
  if (header) return header;
  return cookieValue(req, ADMIN_COOKIE_NAME);
}

export function requireAdmin(req, res, next) {
  const status = adminAuthStatus({ providedToken: extractAdminToken(req) });
  if (status.ok) return next();
  const httpStatus = ['ADMIN_AUTH_NOT_CONFIGURED', 'ADMIN_AUTH_WEAK_TOKEN'].includes(status.code) ? 503 : 401;
  return res.status(httpStatus).json({
    ok: false,
    error: status.error,
    code: status.code,
    admin: {
      required: status.posture.required,
      configured: status.posture.configured,
      strong: status.posture.strong,
      blockers: status.posture.blockers
    }
  });
}

export function isOperatorControlMutation(req = {}) {
  if (!OPERATOR_MUTATION_METHODS.has(String(req.method || '').toUpperCase())) return false;
  const path = apiPath(req);
  if (!path.startsWith('/api/')) return false;
  if (isPublicApiPath(path)) return false;
  return true;
}

export function isOperatorDataRead(req = {}) {
  if (!OPERATOR_READ_METHODS.has(String(req.method || '').toUpperCase())) return false;
  const path = apiPath(req);
  if (!path.startsWith('/api/')) return false;
  if (isPublicApiPath(path)) return false;
  return true;
}

export function isOperatorProtectedRequest(req = {}) {
  return isOperatorControlMutation(req) || isOperatorDataRead(req);
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function apiPath(req = {}) {
  return String(req.path || req.originalUrl || req.url || '').split('?')[0];
}

function isPublicApiPath(path) {
  if (PUBLIC_API_EXACT_PATHS.has(path)) return true;
  return PUBLIC_API_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function cookieValue(req, name) {
  const header = String(req.get?.('cookie') || req.headers?.cookie || '');
  if (!header || !name) return '';
  for (const part of header.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey !== name) continue;
    try {
      return decodeURIComponent(rawValue.join('=') || '').trim();
    } catch {
      return (rawValue.join('=') || '').trim();
    }
  }
  return '';
}
