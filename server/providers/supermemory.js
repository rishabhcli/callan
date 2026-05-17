import { env } from '../env.js';
import { addDoc, containerTagFor, listKinds, MEMORY_KINDS, search } from '../memory.js';
import { normalizeProviderError, providerConfigured, sideEffectGate, smokeDetail } from './core.js';

const PROVIDER = 'supermemory';

export function supermemoryConfigured() {
  return providerConfigured({ SUPERMEMORY_API_KEY: env.supermemory.apiKey });
}

export function classifySupermemoryFailure(err) {
  const normalized = normalizeProviderError(err);
  const msg = String(normalized.message || '').toLowerCase();
  const status = Number(normalized.status || 0) || null;
  const code = String(normalized.code || '').toLowerCase();

  let category = 'unknown';
  let retryable = normalized.retryable;
  if (status === 401 || status === 403 || /\b(auth|unauthorized|forbidden|api key|token)\b/.test(msg)) {
    category = 'auth';
    retryable = false;
  } else if (status === 429 || /\b(rate.?limit|too many requests|quota|usage|credits)\b/.test(msg)) {
    category = 'rate-limited';
    retryable = true;
  } else if (status === 404 || /\b(not.?found|missing document)\b/.test(msg)) {
    category = 'not-found';
    retryable = false;
  } else if (/\b(container.?tag|custom.?id|metadata|invalid|validation|bad request)\b/.test(msg)) {
    category = 'validation';
    retryable = false;
  } else if (/\b(timeout|timed out|abort)\b/.test(msg) || code === 'timeout') {
    category = 'timeout';
    retryable = true;
  } else if (/\b(fetch failed|network|econn|enotfound|etimedout|socket)\b/.test(msg)) {
    category = 'network';
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

export async function smokeSupermemoryAddListSearch() {
  const configured = supermemoryConfigured();
  if (!configured.configured) {
    return { provider: PROVIDER, status: 'missing', detail: smokeDetail({ skipped: configured.missing.join(', ') }) };
  }

  const gate = sideEffectGate({
    provider: PROVIDER,
    action: 'add/list/search smoke',
    enabled: env.smoke.supermemoryWrite,
    details: { toggle: 'SMOKE_SUPERMEMORY_WRITE' }
  });
  if (!gate.ok) {
    return { provider: PROVIDER, status: 'configured', detail: smokeDetail({ skipped: gate.reason, extra: gate.details }) };
  }

  const stamp = Date.now().toString(36);
  const tagA = containerTagFor(`smoke_${stamp}_a`);
  const tagB = containerTagFor(`smoke_${stamp}_b`);
  const profileMarker = `sm_profile_${stamp}`;
  const mailMarker = `sm_mail_${stamp}`;
  const otherMarker = `sm_other_${stamp}`;

  const addedProfile = await addDoc(tagA, 'profile', {
    businessName: 'Smoke Check A',
    city: 'Smoke City',
    niche: 'local services',
    whatTheyDo: `Supermemory smoke profile marker ${profileMarker}`
  }, {
    profileSource: 'provided',
    allowGeneratedUrls: true
  });
  const addedMail = await addDoc(tagA, 'mail_thread', { subject: 'Smoke thread', body: mailMarker });
  await addDoc(tagB, 'profile', {
    businessName: 'Smoke Check B',
    city: 'Smoke City',
    niche: 'local services',
    whatTheyDo: `Supermemory smoke isolation marker ${otherMarker}`
  }, {
    profileSource: 'provided',
    allowGeneratedUrls: true
  });

  const listed = await listKinds(tagA);
  const profileHits = await searchUntilHit(tagA, profileMarker, { kind: 'profile' });
  const mailHits = await searchUntilHit(tagA, mailMarker, { kind: 'mail_thread' });
  const bleedHits = explicitMarkerHits(await search(tagA, otherMarker, { limit: 3 }), otherMarker);

  if (!listed.profile.length) throw new Error('supermemory smoke list did not return profile');
  if (!listed.mail_thread.length) throw new Error('supermemory smoke list did not return mail_thread');
  if (!profileHits.length) throw new Error('supermemory smoke search did not return profile marker');
  if (!mailHits.length) throw new Error('supermemory smoke search did not return mail_thread marker');
  if (bleedHits.length) throw new Error('supermemory smoke isolation failed: other lead marker was visible');

  return {
    provider: PROVIDER,
    status: 'ok',
    detail: smokeDetail({
      dryRun: false,
      live: true,
      extra: {
        tag: tagA,
        added: [addedProfile?.id, addedMail?.id].filter(Boolean),
        listedProfiles: listed.profile.length,
        listedMailThreads: listed.mail_thread.length,
        profileHits: profileHits.length,
        mailThreadHits: mailHits.length,
        isolationBleedHits: bleedHits.length
      }
    })
  };
}

export function supermemoryReadinessDetails() {
  const configured = supermemoryConfigured();
  return {
    configured: configured.configured,
    missing: configured.missing,
    auth: 'bearer_token',
    baseUrl: 'https://api.supermemory.ai/v3',
    isolation: 'containerTag_per_lead',
    supportedKinds: MEMORY_KINDS,
    smoke: env.smoke.supermemoryWrite ? 'enabled_by_SMOKE_SUPERMEMORY_WRITE' : 'disabled_by_default'
  };
}

async function searchUntilHit(containerTag, query, options) {
  let hits = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    hits = explicitMarkerHits(await search(containerTag, query, options), query);
    if (hits.length) return hits;
    await delay(750 * (attempt + 1));
  }
  return hits;
}

function explicitMarkerHits(results, marker) {
  return (results || []).filter((result) => resultContains(result, marker));
}

function resultContains(result, marker) {
  const needle = String(marker || '');
  if (!needle) return false;
  const haystack = [
    result?.content,
    result?.summary,
    result?.title,
    JSON.stringify(result?.metadata || {}),
    ...(Array.isArray(result?.chunks) ? result.chunks.map((chunk) => chunk?.content || '') : [])
  ].join('\n');
  return haystack.includes(needle);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
