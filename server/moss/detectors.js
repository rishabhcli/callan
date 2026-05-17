const OBJECTION_PATTERNS = [
  { type: 'pricing', re: /\b(how much|price|cost|charge|expensive|budget|afford|five hundred|\$ ?500|500)\b/i },
  { type: 'already_has_website', re: /\b(already have|have a website|got a website|our site|my website)\b/i },
  { type: 'busy', re: /\b(busy|middle of|no time|call back|later|not now)\b/i },
  { type: 'send_info', re: /\b(send|email).{0,30}\b(info|information|details|something)\b/i },
  { type: 'trust', re: /\b(scam|real|legit|trust|who are you|why are you calling)\b/i },
  { type: 'not_interested', re: /\b(not interested|do not need|don't need|no thanks|stop|remove me|take me off)\b/i }
];

const QUESTION_RE = /\?|^(what|when|where|why|how|who|can|could|do|does|did|will|would|is|are)\b/i;

export function detectMossRetrievalNeeds(turn) {
  const text = cleanText(typeof turn === 'string' ? turn : turn?.text);
  if (!text) return [];
  const needs = [];
  for (const pattern of OBJECTION_PATTERNS) {
    if (pattern.re.test(text)) {
      needs.push({
        kind: pattern.type === 'pricing' ? 'pricing' : 'objection',
        reason: pattern.type,
        query: text
      });
    }
  }
  if (QUESTION_RE.test(text)) {
    needs.push({
      kind: /price|cost|charge|\$|invoice|pay/i.test(text) ? 'pricing' : 'customer_need',
      reason: 'customer_question',
      query: text
    });
  }
  return dedupeNeeds(needs);
}

function dedupeNeeds(needs) {
  const seen = new Set();
  return needs.filter((need) => {
    const key = `${need.kind}:${need.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
