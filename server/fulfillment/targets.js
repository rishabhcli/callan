import { env, modeAllowsSideEffect } from '../env.js';
import { LovableBuildTarget } from '../providers/lovable.js';
import { V0BuildTarget, v0ReadinessDetails } from '../providers/v0.js';
import { AnythingBuildTarget } from '../providers/anything.js';
import { browserUseReadinessDetails } from '../providers/browserUse.js';

export const BUILD_TARGETS = Object.freeze(['anything', 'lovable', 'v0']);
const DEFAULT_TARGET = 'anything';

export function normalizeBuildTarget(value) {
  const target = String(value || process.env.BUILD_TARGET || process.env.FULFILLMENT_TARGET || DEFAULT_TARGET)
    .trim()
    .toLowerCase();
  return BUILD_TARGETS.includes(target) ? target : DEFAULT_TARGET;
}

export function createBuildTarget(name) {
  const target = normalizeBuildTarget(name);
  if (target === 'v0') return new V0BuildTarget();
  if (target === 'lovable') return new LovableBuildTarget();
  return new AnythingBuildTarget();
}

export function assertBuildTarget(target) {
  const methods = ['createSubmission', 'runWithBrowserUse', 'detectAuthWall', 'extractFinalUrl', 'normalizeProgress', 'stop', 'cleanup'];
  const missing = methods.filter((method) => typeof target?.[method] !== 'function');
  if (missing.length) throw new Error(`BuildTarget ${target?.name || 'unknown'} missing methods: ${missing.join(', ')}`);
  return target;
}

export function canRunLiveBuildTarget(targetName) {
  const target = normalizeBuildTarget(targetName);
  if (!modeAllowsSideEffect('builds')) {
    return { ok: false, reason: `RUN_MODE=${env.runMode}`, live: false, target };
  }
  if (!env.live.builds) {
    return { ok: false, reason: 'LIVE_BUILDS=false', live: false, target };
  }
  if (target === 'lovable' && !env.browserUse.apiKey) {
    return { ok: false, reason: 'BROWSER_USE_API_KEY missing', live: false, target };
  }
  if (target === 'anything' && !env.browserUse.apiKey) {
    return { ok: false, reason: 'BROWSER_USE_API_KEY missing', live: false, target };
  }
  if (target === 'v0' && !process.env.V0_API_KEY) {
    return { ok: false, reason: 'V0_API_KEY missing', live: false, target };
  }
  return { ok: true, reason: 'live_build_enabled', live: true, target };
}

export function classifyFulfillmentFailure(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const category = err?.category || (
    /\bblocked_auth|login required|sign in|sign-in|signin\b/.test(msg) ? 'blocked-auth' :
    /\b(auth|api key|unauthorized|forbidden|permission)\b/.test(msg) ? 'auth' :
    /\b(rate.?limit|quota|too many)\b/.test(msg) ? 'rate-limited' :
    /\b(timeout|timed out|abort)\b/.test(msg) ? 'timeout' :
    /\b(network|fetch failed|econn|enotfound|etimedout|socket)\b/.test(msg) ? 'network' :
    /\bversion id|deployable|missing_url|missing project url\b/.test(msg) ? 'provider-error' :
    'unknown'
  );
  const retryable = err?.retryable ?? !['blocked-auth', 'auth', 'provider-rejected'].includes(category);
  return {
    message: err?.message || String(err),
    category,
    retryable,
    provider: err?.provider || null,
    code: err?.code || null
  };
}

export function fulfillmentReadiness() {
  const defaultTarget = normalizeBuildTarget();
  return {
    defaultTarget,
    targets: {
      anything: {
        configured: !!env.browserUse.apiKey,
        live: canRunLiveBuildTarget('anything').ok,
        provider: 'browserUse',
        detail: { ...browserUseReadinessDetails().lovable, surface: 'anything.com via persistent Browser Use profile' }
      },
      lovable: {
        configured: !!env.browserUse.apiKey,
        live: canRunLiveBuildTarget('lovable').ok,
        provider: 'browserUse',
        detail: browserUseReadinessDetails().lovable
      },
      v0: {
        configured: !!process.env.V0_API_KEY,
        live: canRunLiveBuildTarget('v0').ok,
        provider: 'v0',
        detail: v0ReadinessDetails()
      }
    },
    liveGate: env.live.builds ? 'enabled_by_LIVE_BUILDS' : 'disabled_by_default',
    runMode: env.runMode
  };
}
