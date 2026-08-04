import { timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

export const ADMIN_TOKEN_MIN_LENGTH = 24;
const PROTECTED_MODES = new Set(['production_review', 'production_live']);
const OPERATOR_MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const OPERATOR_READ_METHODS = new Set(['GET', 'HEAD']);
const PUBLIC_API_PREFIXES = [
  '/api/webhooks/',
  '/api/share/build/',
  '/api/hosting/accept/',
  '/api/preview-build/',
  '/api/unsubscribe/',
  '/api/public/intake/'
];
const PUBLIC_API_EXACT_PATHS = new Set([
  '/api/ping',
  '/api/referrals/leads',
  '/api/referrals/landing-html',
  '/api/public/intake'
]);

export function adminAuthPosture({
  mode = env.runMode,
  nodeEnv = env.nodeEnv,
  token = env.admin?.apiToken || '',
  operators = env.admin?.operatorTokens || []
} = {}) {
  const requiredByMode = PROTECTED_MODES.has(mode);
  const requiredByNodeEnv = nodeEnv === 'production';
  const required = requiredByMode || requiredByNodeEnv;
  const namedOperators = normalizeOperators(operators);
  const configured = Boolean(token) || namedOperators.length > 0;
  const strong = namedOperators.length > 0
    ? namedOperators.every((row) => row.token.length >= ADMIN_TOKEN_MIN_LENGTH)
    : configured && token.length >= ADMIN_TOKEN_MIN_LENGTH;
  const blockers = [];

  if (required && !configured) {
    blockers.push('ADMIN_API_TOKEN or ADMIN_API_TOKENS_JSON is required for production admin and ops controls');
  }
  if (configured && !strong) {
    blockers.push(`Every admin credential must be at least ${ADMIN_TOKEN_MIN_LENGTH} characters`);
  }

  return {
    required,
    configured,
    strong,
    namedOperatorCount: namedOperators.length,
    identityBacked: namedOperators.length > 0,
    ok: blockers.length === 0,
    blockers,
    nextAction: blockers.length ? 'set a strong ADMIN_API_TOKEN before production review/live' : 'monitor'
  };
}

export function adminAuthStatus({
  providedToken = '',
  configuredToken = env.admin?.apiToken || '',
  operators = env.admin?.operatorTokens || [],
  mode = env.runMode,
  nodeEnv = env.nodeEnv
} = {}) {
  const namedOperators = normalizeOperators(operators);
  const posture = adminAuthPosture({ mode, nodeEnv, token: configuredToken, operators: namedOperators });
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
  if (namedOperators.length > 0) {
    let matched = null;
    for (const operator of namedOperators) {
      if (constantTimeEqual(providedToken, operator.token)) matched = operator;
    }
    if (matched) {
      return {
        ok: true,
        enforced: true,
        posture,
        operator: { id: matched.id, role: matched.role, attributable: true }
      };
    }
  } else if (constantTimeEqual(providedToken, configuredToken)) {
    return {
      ok: true,
      enforced: true,
      posture,
      operator: { id: 'legacy-shared-token', role: 'admin', attributable: false }
    };
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
  return header;
}

export function requireAdmin(req, res, next) {
  const status = adminAuthStatus({ providedToken: extractAdminToken(req) });
  if (status.ok) {
    const requiredRole = requiredOperatorRole(req);
    if (!roleAllows(status.operator?.role || 'admin', requiredRole)) {
      return res.status(403).json({ ok: false, code: 'ADMIN_ROLE_FORBIDDEN', error: `${requiredRole} role required` });
    }
    req.operatorAuth = status.operator || { id: 'local-development', role: 'admin', attributable: false };
    return next();
  }
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

function normalizeOperators(value) {
  return (Array.isArray(value) ? value : []).map((row) => ({
    id: String(row?.id || '').trim(),
    role: ['viewer', 'operator', 'admin'].includes(String(row?.role || '').toLowerCase()) ? String(row.role).toLowerCase() : 'viewer',
    token: String(row?.token || '')
  })).filter((row) => row.id && row.token);
}

function requiredOperatorRole(req) {
  const path = apiPath(req);
  if (path.startsWith('/api/admin/') || path === '/api/jobs/recover-stuck') return 'admin';
  if (OPERATOR_MUTATION_METHODS.has(String(req?.method || '').toUpperCase())) return 'operator';
  return 'viewer';
}

function roleAllows(actual, required) {
  const rank = { viewer: 1, operator: 2, admin: 3 };
  return (rank[actual] || 0) >= (rank[required] || 99);
}

function apiPath(req = {}) {
  return String(req.path || req.originalUrl || req.url || '').split('?')[0];
}

function isPublicApiPath(path) {
  if (PUBLIC_API_EXACT_PATHS.has(path)) return true;
  return PUBLIC_API_PREFIXES.some((prefix) => path.startsWith(prefix));
}
