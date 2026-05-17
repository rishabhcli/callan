const UNSUBSCRIBE_PATTERNS = Object.freeze([
  /\bunsubscribe\b/i,
  /\bremove\s+me\b/i,
  /\bopt[-\s]?out\b/i,
  /\bstop\s+(?:emailing|contacting|messaging)\b/i,
  /\bno\s+more\s+emails?\b/i,
  /\bdo\s+not\s+(?:email|contact|message)\b/i
]);

const HANDOFF_PATTERNS = Object.freeze([
  /\blegal\b/i,
  /\blawyer\b/i,
  /\battorney\b/i,
  /\bcontract\s+(?:review|redline|clause|terms?)\b/i,
  /\bindemnity\b/i,
  /\bliability\b/i,
  /\btax(?:es|ing|able)?\b/i,
  /\bcpa\b/i,
  /\bguarantee(?:d|s)?\b/i,
  /\bpromise\s+(?:ranking|rankings|revenue|sales|traffic|leads?)\b/i,
  /\bfirst\s+page\s+(?:of\s+)?google\b/i,
  /\bseo\s+guarantee\b/i,
  /\brevenue\s+guarantee\b/i,
  /\brefund\s+if\b/i,
  /\bmedical\s+advice\b/i,
  /\bdiagnos(?:e|is)\b/i
]);

const NOT_NOW_PATTERNS = Object.freeze([
  /\bnot\s+now\b/i,
  /\blater\b/i,
  /\bnext\s+(?:month|quarter|year)\b/i,
  /\bafter\s+(?:the\s+)?(?:season|holidays|summer|winter)\b/i,
  /\btoo\s+busy\b/i,
  /\bhold\s+off\b/i,
  /\bno\s+budget\b/i,
  /\bmaybe\s+later\b/i
]);

const INTERESTED_PATTERNS = Object.freeze([
  /\binterested\b/i,
  /\byes\b/i,
  /\blet'?s\s+(?:do|start|talk|go)\b/i,
  /\btell\s+me\s+more\b/i,
  /\bsend\s+(?:me\s+)?(?:details|pricing|the\s+plan)\b/i,
  /\bbook(?:ing)?\s+(?:link|flow|automation)\b/i,
  /\breview\s+(?:system|capture|request)\b/i,
  /\blocal\s+seo\b/i,
  /\bgoogle\s+business\b/i,
  /\bmaintenance\b/i,
  /\bautomations?\b/i
]);

export function classifyGrowthReply(input = '') {
  const text = normalizeInput(input);
  if (matches(text, UNSUBSCRIBE_PATTERNS)) {
    return result('unsubscribe', 'Customer asked to stop growth follow-up email.', false);
  }
  if (matches(text, HANDOFF_PATTERNS)) {
    return result('handoff', 'Reply asks for unsupported legal, financial, guarantee, medical, or contract advice.', true);
  }
  if (matches(text, NOT_NOW_PATTERNS)) {
    return result('not_now', 'Customer is deferring the growth offer.', false);
  }
  if (matches(text, INTERESTED_PATTERNS)) {
    return result('interested', 'Customer appears interested in an additional growth service.', false);
  }
  return result('handoff', 'Growth reply does not fit an autonomous operational response.', true);
}

function result(kind, reason, operatorFlag) {
  return {
    schemaVersion: 1,
    kind,
    reason,
    operatorFlag,
    allowedAutonomousReply: !operatorFlag && kind !== 'unsubscribe',
    supportedKinds: ['interested', 'not_now', 'unsubscribe', 'handoff']
  };
}

function normalizeInput(input) {
  if (typeof input === 'string') return input.replace(/\s+/g, ' ').trim();
  return [
    input?.subject,
    input?.text,
    input?.body,
    input?.message
  ].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
}

function matches(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}
