const MAX_ITEMS = 5;

export function priorCallLearningFromMemory(doc) {
  const analysis = readMemoryContent(doc);
  if (!analysis || typeof analysis !== 'object') return null;

  const learning = {
    sourceCallId: cleanText(analysis.callId) || cleanText(doc?.metadata?.callId) || null,
    analyzedAt: cleanText(analysis.analyzedAt) || null,
    outcome: allowedOutcome(analysis.outcome),
    failureReason: cleanText(analysis.failureReason) || null,
    whatWorked: stringList(analysis.whatWorked),
    whatToTryNext: stringList(analysis.whatToTryNext),
    customerQuestions: stringList(analysis.customerQuestions),
    nextBestAction: normalizeNextAction(analysis.nextBestAction)
  };

  const hasLearning = learning.outcome || learning.failureReason || learning.whatWorked.length ||
    learning.whatToTryNext.length || learning.customerQuestions.length || learning.nextBestAction;
  return hasLearning ? learning : null;
}

export function priorCallLearningPrompt(learning) {
  if (!learning) return 'No prior analyzed call exists for this lead.';
  return [
    `Prior outcome: ${learning.outcome || 'unknown'}.`,
    learning.failureReason ? `Prior blocker: ${learning.failureReason}` : null,
    learning.whatWorked.length ? `Keep what worked: ${learning.whatWorked.join('; ')}` : null,
    learning.whatToTryNext.length ? `Apply next-call changes: ${learning.whatToTryNext.join('; ')}` : null,
    learning.customerQuestions.length ? `Be ready for prior customer questions: ${learning.customerQuestions.join('; ')}` : null,
    learning.nextBestAction?.reason ? `Operational context: ${learning.nextBestAction.reason}` : null,
    'Use these lessons only when they remain consistent with the current evidence, recording disclosure, opt-out rules, price, and invoice-consent policy.'
  ].filter(Boolean).join(' ');
}

function readMemoryContent(doc) {
  if (!doc) return null;
  const value = doc.content ?? doc.content_text ?? doc.summary ?? null;
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function allowedOutcome(value) {
  const normalized = cleanText(value).toLowerCase();
  return ['won', 'lost', 'callback', 'unreachable'].includes(normalized) ? normalized : null;
}

function normalizeNextAction(value) {
  if (!value || typeof value !== 'object') return null;
  const code = cleanText(value.code) || null;
  const label = cleanText(value.label) || null;
  const reason = cleanText(value.reason) || null;
  return code || label || reason ? { code, label, reason } : null;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanText).filter(Boolean))].slice(0, MAX_ITEMS);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 600);
}
