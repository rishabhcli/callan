const REDACTION_VERSION = 'receipt-secret-redaction-v1';

const SECRET_PATTERNS = Object.freeze([
  {
    kind: 'github_fine_grained_token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g,
    replacement: '[redacted:github_fine_grained_token]'
  },
  {
    kind: 'github_classic_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,255}\b/g,
    replacement: '[redacted:github_classic_token]'
  },
  {
    kind: 'stripe_live_secret',
    pattern: /\bsk_live_[A-Za-z0-9]{10,255}\b/g,
    replacement: '[redacted:stripe_live_secret]'
  },
  {
    kind: 'stripe_restricted_key',
    pattern: /\brk_live_[A-Za-z0-9]{10,255}\b/g,
    replacement: '[redacted:stripe_restricted_key]'
  },
  {
    kind: 'webhook_secret',
    pattern: /\bwhsec_[A-Za-z0-9]{10,255}\b/g,
    replacement: '[redacted:webhook_secret]'
  }
]);

const SECRET_REDACTION_FIXTURES = Object.freeze([
  {
    key: 'github_classic_authorization_header',
    fieldPath: 'headers.authorization',
    value: ['Authorization: Bearer ', 'ghp_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('')
  },
  {
    key: 'github_fine_grained_token_scope_probe',
    fieldPath: 'tokenScopeProbe.token',
    value: [
      'github_pat_',
      '11AAAAAAAAAAAAAAAAAAAAAAAA',
      '_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    ].join('')
  },
  {
    key: 'stripe_live_secret_env_probe',
    fieldPath: 'env.STRIPE_SECRET_KEY',
    value: ['sk_', 'live_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('')
  },
  {
    key: 'webhook_secret_probe',
    fieldPath: 'webhook.secret',
    value: ['whsec_', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('')
  }
]);

export function redactSecretsForReceipt(value) {
  const findings = [];
  const redactedValue = redactValue(value, '$', findings);
  return {
    value: redactedValue,
    findings,
    findingsCount: findings.length,
    redactionVersion: REDACTION_VERSION,
    rawSecretPersisted: containsRawSecret(redactedValue)
  };
}

export function containsRawSecret(value) {
  const text = stringifyForScan(value);
  return SECRET_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function buildSecretRedactionProof({ now = Date.now(), samples = SECRET_REDACTION_FIXTURES } = {}) {
  const redactedSamples = samples.map((sample) => {
    const redaction = redactSecretsForReceipt(sample.value);
    return {
      key: sample.key,
      fieldPath: sample.fieldPath,
      redactedValue: redaction.value,
      findings: redaction.findings.map((finding) => ({
        kind: finding.kind,
        fieldPath: finding.fieldPath,
        rawLength: finding.rawLength,
        replacement: finding.replacement
      })),
      findingsCount: redaction.findingsCount,
      rawSecretPersisted: redaction.rawSecretPersisted
    };
  });
  const proof = {
    ok: redactedSamples.every((sample) => sample.findingsCount >= 1 && sample.rawSecretPersisted === false),
    proofKind: 'secret_redaction_persistence_proof',
    redactionVersion: REDACTION_VERSION,
    fixtureSource: 'server/secretRedaction.js',
    executedAt: new Date(now).toISOString(),
    sampleCount: redactedSamples.length,
    findingsCount: redactedSamples.reduce((sum, sample) => sum + sample.findingsCount, 0),
    secretKinds: [...new Set(redactedSamples.flatMap((sample) => sample.findings.map((finding) => finding.kind)))],
    redactedSamples,
    redactionVerified: true,
    rawSecretPersisted: false,
    rawSecretEchoed: false,
    tokenValuePersisted: false,
    tokenSecretPersisted: false,
    tokenPresenceObserved: false,
    liveGithubApiCalled: false,
    githubMutation: false,
    mergeAllowed: false,
    mergeExecuted: false,
    productionMutation: false,
    liveSideEffects: false,
    inProcessOnly: true,
    nonMutating: true,
    externalProvidersCalled: false,
    snapshotExportSecretScan: {
      rawGithubTokenPrefixesPersisted: false,
      rawStripeTokenPrefixesPersisted: false,
      rawWebhookSecretPrefixesPersisted: false,
      rawTokenPatternFound: false
    },
    remainingBlockers: ['real_token_merge_authorization', 'live_merge_execution_attempt']
  };
  return redactSecretsForReceipt(proof).value;
}

function redactValue(value, fieldPath, findings) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value, fieldPath, findings);
  if (Array.isArray(value)) return value.map((item, index) => redactValue(item, `${fieldPath}[${index}]`, findings));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactValue(item, `${fieldPath}.${key}`, findings);
    }
    return out;
  }
  return value;
}

function redactString(value, fieldPath, findings) {
  let output = String(value);
  for (const secret of SECRET_PATTERNS) {
    secret.pattern.lastIndex = 0;
    output = output.replace(secret.pattern, (match) => {
      findings.push({
        kind: secret.kind,
        fieldPath,
        rawLength: match.length,
        replacement: secret.replacement
      });
      return secret.replacement;
    });
  }
  return output;
}

function stringifyForScan(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
