import { providerSmoke } from './db.js';
import { PROVIDER_ORDER, providerConfigured } from './readiness.js';
import { smokeDetail } from './providers/core.js';

export function recordProviderPosture({
  providers = PROVIDER_ORDER,
  now = Date.now(),
  source = 'posture_refresh',
  updateLatest = false
} = {}) {
  const rows = [];
  for (const provider of providers) {
    const configured = providerConfigured(provider);
    const status = configured.ok ? 'configured' : 'missing';
    const detail = smokeDetail({
      dryRun: true,
      live: false,
      skipped: configured.ok
        ? 'posture check only; no provider request made'
        : configured.missing.join(', '),
      extra: {
        source,
        postureOnly: true,
        network: 'none',
        liveSideEffects: false,
        missing: configured.missing
      }
    });
    const options = { checkedAt: now, durationMs: 0 };
    if (updateLatest) providerSmoke.set(provider, status, detail, options);
    else providerSmoke.recordEvent(provider, status, detail, options);
    rows.push({
      provider,
      status,
      configured: configured.ok,
      missing: configured.missing,
      checkedAt: now
    });
  }
  return {
    ok: true,
    checkedAt: now,
    source,
    updateLatest,
    liveSideEffects: false,
    total: rows.length,
    configured: rows.filter((row) => row.configured).length,
    missing: rows.filter((row) => !row.configured).length,
    providers: rows
  };
}
