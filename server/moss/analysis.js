import { mossRetrievals, mossSnippets } from '../db.js';
import { emit } from '../sse.js';
import { addImprovedMossSnippet, markDeadMossSnippets } from './hotIndex.js';

export async function applyMossAnalystFeedback({ leadId, callId, postMortem, transcript }) {
  const retrievals = mossRetrievals.listByLead(leadId, { call_id: callId, limit: 200 });
  if (!retrievals.length) {
    emit('analyst.moss_feedback', {
      worker: 'analyst',
      leadId,
      callId,
      retrievalCount: 0,
      helped: [],
      dead: [],
      improved: [],
      noWebSearch: true
    });
    return { retrievalCount: 0, helped: [], dead: [], improved: [] };
  }

  const helped = scoreHelpfulSnippets({ leadId, retrievals, postMortem, transcript });
  const dead = scoreDeadSnippets({ leadId, retrievals, postMortem });
  const improved = await addNextCallSnippets({ leadId, postMortem });

  if (helped.length) mossSnippets.markUsed(leadId, helped, { helped: true });
  if (dead.length) await markDeadMossSnippets(leadId, dead, { reason: postMortem?.failureReason || 'snippet did not help the call' });

  emit('analyst.moss_feedback', {
    worker: 'analyst',
    leadId,
    callId,
    retrievalCount: retrievals.length,
    helped,
    dead,
    improved: improved.map((row) => row?.snippet_id).filter(Boolean),
    noWebSearch: true
  });

  return {
    retrievalCount: retrievals.length,
    helped,
    dead,
    improved: improved.map((row) => row?.snippet_id).filter(Boolean)
  };
}

function scoreHelpfulSnippets({ leadId, retrievals, postMortem, transcript }) {
  const outcome = postMortem?.outcome;
  const agentText = transcriptText(transcript, 'agent');
  const worked = (postMortem?.whatWorked || []).join(' ');
  const positive = outcome === 'won' || postMortem?.confirmedEmail;
  const out = new Set();

  for (const retrieval of retrievals) {
    const ids = retrieval.snippetIds || [];
    if (!ids.length) continue;
    if (positive && /(pricing|objection|pre_call_context|customer_need|compliance)/.test(retrieval.intent || '')) {
      ids.slice(0, 2).forEach((id) => out.add(id));
      continue;
    }
    for (const id of ids) {
      const snippet = mossSnippets.getBySnippetId(leadId, id);
      if (!snippet) continue;
      if (mentionsSnippet(agentText, snippet.text) || mentionsSnippet(worked, snippet.text)) out.add(id);
    }
  }
  return [...out].slice(0, 12);
}

function scoreDeadSnippets({ leadId, retrievals, postMortem }) {
  if (postMortem?.outcome === 'won') return [];
  const failure = `${postMortem?.failureReason || ''} ${postMortem?.reason || ''}`;
  const out = new Set();
  for (const retrieval of retrievals) {
    if (!retrieval.snippetIds?.length) continue;
    if (retrieval.outcome === 'miss') continue;
    if (/price|expensive|budget/i.test(failure) && /pricing|objection/.test(retrieval.intent || '')) {
      retrieval.snippetIds.slice(0, 1).forEach((id) => out.add(id));
    }
    if (/already|do not need|not interested/i.test(failure) && /objection/.test(retrieval.intent || '')) {
      retrieval.snippetIds.slice(0, 1).forEach((id) => out.add(id));
    }
  }
  return [...out]
    .filter((id) => {
      const snippet = mossSnippets.getBySnippetId(leadId, id);
      return snippet && snippet.status !== 'dead';
    })
    .slice(0, 6);
}

async function addNextCallSnippets({ leadId, postMortem }) {
  const rows = [];
  for (const question of (postMortem?.customerQuestions || []).slice(0, 3)) {
    rows.push(await addImprovedMossSnippet(leadId, {
      kind: 'customer_need',
      title: 'Customer question answer',
      text: `If the owner asks "${question}", answer from the business facts, then tie it back to the $500 site scope and AgentMail reply path.`,
      metadata: { from: 'customer_question', question }
    }));
  }
  for (const step of (postMortem?.whatToTryNext || []).slice(0, 3)) {
    rows.push(await addImprovedMossSnippet(leadId, {
      kind: 'call_strategy',
      title: 'Next-call strategy',
      text: step,
      metadata: { from: 'post_mortem' }
    }));
  }
  return rows.filter(Boolean);
}

function mentionsSnippet(haystack, snippetText) {
  const terms = cleanText(snippetText)
    .toLowerCase()
    .split(/[^a-z0-9$]+/)
    .filter((token) => token.length > 4)
    .slice(0, 20);
  if (!terms.length) return false;
  const h = cleanText(haystack).toLowerCase();
  return terms.filter((term) => h.includes(term)).length >= Math.min(3, terms.length);
}

function transcriptText(transcript, role = null) {
  const turns = normalizeTurns(transcript);
  return turns
    .filter((turn) => !role || turn.role === role)
    .map((turn) => turn.text)
    .join('\n');
}

function normalizeTurns(transcript) {
  const source = Array.isArray(transcript)
    ? transcript
    : Array.isArray(transcript?.turns)
      ? transcript.turns
      : [];
  return source.map((turn) => ({
    role: /agent|assistant|caller/i.test(turn?.role || '') ? 'agent' : /user|owner|customer|lead/i.test(turn?.role || '') ? 'user' : 'unknown',
    text: cleanText(turn?.text || turn?.content || turn?.message)
  })).filter((turn) => turn.text);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
