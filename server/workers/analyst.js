import { emit } from '../sse.js';
import { runs, leads, calls } from '../db.js';
import { containerTagFor, addDoc, getLatest } from '../memory.js';
import { generateStructured } from '../reasoning/geminiReasoner.js';
import { CallAnalysis } from '../reasoning/schemas.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import { enqueueGrowthPlanJob } from '../growthQueue.js';
import { applyMossAnalystFeedback } from '../moss/analysis.js';
import { enqueueJob } from '../jobs.js';
import { assertProviderOperational } from '../providerIncidents.js';

const OUTCOME_TO_STATUS = {
  won: 'closing',
  lost: 'rejected',
  callback: 'callback',
  unreachable: 'unreachable'
};

const OUTCOMES = new Set(['won', 'lost', 'callback', 'unreachable']);

export async function runAnalyst({ leadId, callId }) {
  const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  runs.start({ id: runId, lead_id: leadId, worker: 'analyst' });
  emit('analyst.start', { worker: 'analyst', leadId, callId, runId });

  try {
    const lead = leads.get(leadId);
    if (!lead) throw new Error(`lead not found: ${leadId}`);
    assertProviderOperational('gemini', {
      worker: 'analyst',
      leadId,
      eventId: callId || runId
    });
    const tag = containerTagFor(leadId);

    const [profileDoc, pitchDoc] = await Promise.all([
      safeGetLatest(tag, 'profile'),
      safeGetLatest(tag, 'pitch')
    ]);
    const call = readCall(callId);
    const transcript = call?.transcript || null;

    const prompt = buildPrompt({ lead, profileDoc, pitchDoc, call, transcript });
    const { output: modelAnalysis, trace } = await generateStructured({
      kind: 'callAnalysis',
      schema: CallAnalysis,
      evidence: {
        lead,
        profile: profileDoc?.content || null,
        pitch: pitchDoc?.content || null,
        call: call?.row || null,
        transcript
      },
      prompt,
      leadId,
      worker: 'analyst',
      eventId: callId || runId,
      thinkingLevel: 'medium'
    });

    const postMortem = normalizeAnalysis({ modelAnalysis, lead, call, transcript });
    postMortem.mossSnippetFeedback = await applyMossAnalystFeedback({ leadId, callId, postMortem, transcript }).catch((err) => {
      log.warn('analyst.moss_feedback.failed', { leadId, callId, error: err?.message || String(err) });
      return { error: err?.message || String(err), retrievalCount: 0, helped: [], dead: [], improved: [] };
    });

    await safeAddMemory(tag, 'post_mortem', postMortem, {
      callId,
      outcome: postMortem.outcome,
      confirmedEmail: postMortem.confirmedEmail,
      nextBestAction: postMortem.nextBestAction?.code,
      schemaVersion: postMortem.schemaVersion
    });

    emit('analyst.analysis', {
      worker: 'analyst',
      leadId,
      callId,
      runId,
      analysis: eventAnalysis(postMortem)
    });
    emit('analyst.reasoning', {
      worker: 'analyst',
      leadId,
      callId,
      runId,
      traceId: trace?.id,
      schemaName: trace?.schemaName,
      valid: trace?.valid,
      repairAttempts: trace?.repairAttempts,
      confidence: modelAnalysis.confidence
    });

    const status = OUTCOME_TO_STATUS[postMortem.outcome];
    const leadPatch = {
      ...(status ? { status } : {}),
      next_action: postMortem.nextBestAction?.code || null
    };
    if (postMortem.nextBestAction?.code === 'do_not_call') {
      leadPatch.outreach_status = 'blocked';
      leadPatch.risk_status = 'opt-out';
    }
    if (Object.keys(leadPatch).length) leads.update(leadId, leadPatch);

    let growthPlanJob = null;
    try {
      const queued = enqueueGrowthPlanJob({ leadId, source: 'analyst' });
      growthPlanJob = queued.row || null;
      emit(queued.inserted ? 'analyst.growth_queued' : 'analyst.growth_duplicate', {
        worker: 'analyst',
        leadId,
        callId,
        runId,
        jobId: growthPlanJob?.id || null,
        duplicate: !queued.inserted
      });
    } catch (err) {
      log.warn('analyst.growth_plan_skipped', { leadId, callId, error: err?.message || String(err) });
      emit('analyst.growth_skipped', {
        worker: 'analyst',
        leadId,
        callId,
        runId,
        reason: err?.message || String(err)
      });
    }

    emit('analyst.done', {
      worker: 'analyst',
      leadId,
      runId,
      outcome: postMortem.outcome,
      reason: postMortem.reason,
      failureReason: postMortem.failureReason,
      nextBestAction: postMortem.nextBestAction?.code,
      confirmedEmail: postMortem.confirmedEmail,
      growthPlanJobId: growthPlanJob?.id || null
    });

    if (postMortem.outcome === 'won') {
      const toEmail = resolveMailerEmail(lead, postMortem);
      if (toEmail) {
        enqueueWonFollowupEmail({ leadId, callId, toEmail, runId });
      } else {
        emit('analyst.mailer.skipped', {
          worker: 'analyst',
          leadId,
          callId,
          runId,
          reason: 'missing_confirmed_invoice_email'
        });
      }
    }

    runs.finish(runId, {
      state: 'completed',
      detail: {
        callId,
        outcome: postMortem.outcome,
        failureReason: postMortem.failureReason,
        nextBestAction: postMortem.nextBestAction?.code,
        invoiceEmail: postMortem.invoiceEmail,
        confirmedEmail: postMortem.confirmedEmail,
        customerQuestions: postMortem.customerQuestions,
        mossSnippetFeedback: postMortem.mossSnippetFeedback,
        reasoningTraceId: trace?.id || null,
        growthPlanJobId: growthPlanJob?.id || null
      }
    });
    return { postMortem };
  } catch (err) {
    const blocked = err?.operationalState === 'blocked';
    runs.finish(runId, blocked
      ? {
          state: 'blocked',
          detail: {
            blocker: err?.blocker || err?.message || String(err),
            provider: err?.provider || null,
            code: err?.code || null
          }
        }
      : { state: 'failed', error: err?.message || String(err) });
    emit(blocked ? 'analyst.blocked' : 'analyst.error', {
      worker: 'analyst',
      leadId,
      runId,
      error: err?.message || String(err),
      provider: err?.provider || null,
      code: err?.code || null
    });
    throw err;
  }
}

function enqueueWonFollowupEmail({ leadId, callId, toEmail, runId }) {
  try {
    const normalizedEmail = String(toEmail || '').trim().toLowerCase();
    const result = enqueueJob({
      type: 'mail.followup',
      payload: {
        leadId,
        toEmail: normalizedEmail,
        source: 'analyst',
        callId: callId || null
      },
      idempotencyKey: `mail.followup:analyst:${callId || leadId}:${normalizedEmail}`,
      maxAttempts: 5
    });
    emit('analyst.mailer.queued', {
      worker: 'analyst',
      leadId,
      callId,
      runId,
      toEmail: normalizedEmail,
      jobId: result.row?.id || null,
      duplicate: !result.inserted
    });
    return result.row || null;
  } catch (err) {
    log.warn('analyst.mailer.queue_failed', { leadId, callId, runId, error: err?.message || String(err) });
    return null;
  }
}

async function safeAddMemory(containerTag, kind, content, metadata) {
  try {
    return await addDoc(containerTag, kind, content, metadata);
  } catch (err) {
    log.warn('analyst.memory.add.skipped', { containerTag, kind, error: err?.message || String(err) });
    return null;
  }
}

async function safeGetLatest(tag, kind) {
  try {
    return await getLatest(tag, kind);
  } catch (err) {
    log.warn('analyst.memory.miss', { tag, kind, err: err?.message });
    return null;
  }
}

function readCall(callId) {
  if (!callId) return null;
  const row = calls.get(callId);
  if (!row) return null;
  if (!row.transcript_json) return { row, transcript: null };
  try {
    return { row, transcript: JSON.parse(row.transcript_json) };
  } catch {
    return { row, transcript: row.transcript_json };
  }
}

function buildPrompt({ lead, profileDoc, pitchDoc, call, transcript }) {
  const profile = profileDoc?.content || profileDoc?.metadata?.businessName || 'unknown';
  const pitch = pitchDoc?.content || 'unknown';
  const t = transcript ? JSON.stringify(transcript).slice(0, 18000) : 'unavailable';
  return [
    `Lead: ${lead.business_name} (${lead.niche || 'unknown niche'}, ${lead.city || 'unknown city'}).`,
    `Phone: ${lead.phone || 'n/a'}.`,
    `Call DB state/outcome: ${call?.row?.state || 'unknown'} / ${call?.row?.outcome || 'unknown'}.`,
    '',
    'BUSINESS PROFILE (Supermemory):',
    typeof profile === 'string' ? profile : JSON.stringify(profile),
    '',
    'PITCH WE USED:',
    typeof pitch === 'string' ? pitch : JSON.stringify(pitch),
    '',
    'CALL TRANSCRIPT:',
    t,
    '',
    'Analyze the call. Return strictly the JSON shape requested by the schema.',
    'outcome ∈ {won,lost,callback,unreachable}. reason is one sentence.',
    'failureReason is null only when outcome=="won"; otherwise state the actual failure/blocker in one sentence.',
    'whatWorked and whatToTryNext: short, concrete, no platitudes.',
    'replayMoments: up to 5 entries pointing at exact transcript excerpts that turned the call.',
    'invoiceEmail: the email address the owner gave for the invoice, only if the agent read it back and the owner confirmed it after the read-back. Otherwise null.',
    'confirmedEmail: true only when the transcript shows the owner confirming the read-back.',
    'customerQuestions: concrete questions the owner asked that AgentMail should be ready to answer.',
    'nextBestAction: the single next operational step, with a machine code, human label, and short reason.',
    'followupEmailDraft: only fill if outcome=="won". Otherwise null.'
  ].join('\n');
}

function resolveMailerEmail(lead, postMortem) {
  if (!postMortem?.confirmedEmail) return null;
  const invoiceEmail = sanitizeEmail(postMortem?.invoiceEmail);
  if (invoiceEmail) return invoiceEmail;
  if (env.runMode === 'mock' && env.allowedEmails?.length) return env.allowedEmails[0];
  if (env.runMode === 'mock') {
    const slug = String(lead.business_name || 'business')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'business';
    return `owner@${slug}.com`;
  }
  return null;
}

function normalizeAnalysis({ modelAnalysis, lead, call, transcript }) {
  const turns = normalizeTranscriptTurns(transcript);
  const callOutcome = call?.row?.outcome || null;
  const emailConfirmation = extractConfirmedInvoiceEmail({
    transcript,
    modelEmail: modelAnalysis?.invoiceEmail
  });
  const outcome = classifyOutcome({ modelOutcome: modelAnalysis?.outcome, callOutcome, turns, emailConfirmation });
  const customerQuestions = uniqueStrings([
    ...listStrings(modelAnalysis?.customerQuestions),
    ...extractCustomerQuestions(turns)
  ], 5);
  const replayMoments = normalizeReplayMoments(modelAnalysis?.replayMoments, turns, outcome);
  const reason = oneSentence(modelAnalysis?.reason) || outcomeReason({ outcome, callOutcome, emailConfirmation, turns });
  const failureReason = outcome === 'won'
    ? null
    : (oneSentence(modelAnalysis?.failureReason) || failureReasonFor({ outcome, callOutcome, turns, reason }));
  const nextBestAction = normalizeNextBestAction(modelAnalysis?.nextBestAction, {
    outcome,
    confirmedEmail: emailConfirmation.confirmed,
    failureReason,
    turns
  });

  return {
    schemaVersion: 'call_analysis.v1',
    callId: call?.row?.id || null,
    leadId: lead.id,
    analyzedAt: new Date().toISOString(),
    outcome,
    reason,
    failureReason,
    whatWorked: uniqueStrings(listStrings(modelAnalysis?.whatWorked), 5),
    whatToTryNext: uniqueStrings(listStrings(modelAnalysis?.whatToTryNext), 5),
    replayMoments,
    replayWorthyMoments: replayMoments,
    replayWorthy: replayMoments.map((m) => m.excerpt).join(' | ') || null,
    invoiceEmail: emailConfirmation.confirmed ? emailConfirmation.email : null,
    confirmedEmail: emailConfirmation.confirmed,
    emailConfirmation,
    invoiceEmailConfidence: emailConfirmation.confidence,
    invoiceEmailSourceExcerpt: emailConfirmation.sourceExcerpt,
    customerQuestions,
    nextBestAction,
    followupEmailDraft: outcome === 'won' ? cleanText(modelAnalysis?.followupEmailDraft) : null,
    source: {
      model: 'gemini',
      deterministicChecks: ['confirmed_invoice_email', 'customer_questions', 'outcome_guardrails', 'next_best_action']
    }
  };
}

function eventAnalysis(postMortem) {
  return {
    schemaVersion: postMortem.schemaVersion,
    callId: postMortem.callId,
    outcome: postMortem.outcome,
    reason: postMortem.reason,
    failureReason: postMortem.failureReason,
    invoiceEmail: postMortem.invoiceEmail,
    confirmedEmail: postMortem.confirmedEmail,
    invoiceEmailConfidence: postMortem.invoiceEmailConfidence,
    invoiceEmailSourceExcerpt: postMortem.invoiceEmailSourceExcerpt,
    customerQuestions: postMortem.customerQuestions,
    replayMoments: postMortem.replayMoments,
    nextBestAction: postMortem.nextBestAction
  };
}

function classifyOutcome({ modelOutcome, callOutcome, turns, emailConfirmation }) {
  const model = OUTCOMES.has(modelOutcome) ? modelOutcome : null;
  const text = turns.map((t) => t.text).join('\n');
  const userText = turns.filter((t) => t.role === 'user' || t.role === 'unknown').map((t) => t.text).join('\n');

  if (/\b(opt[- ]?out|do not call|stop calling|remove me|take me off|unsubscribe)\b/i.test(`${callOutcome || ''}\n${userText}`)) {
    return 'lost';
  }
  if (emailConfirmation.confirmed || /\b(send|email).{0,40}\b(invoice|bill|payment link)\b/i.test(userText)) {
    return 'won';
  }
  if (/\b(call me back|call back|try me later|another time|tomorrow|next week|after lunch)\b/i.test(userText)) {
    return 'callback';
  }
  if (!hasMeaningfulUserTurn(turns) || /\b(no answer|voicemail|busy|unreachable|did not connect|disconnected)\b/i.test(`${callOutcome || ''}\n${text}`)) {
    return 'unreachable';
  }
  return model || 'lost';
}

function outcomeReason({ outcome, callOutcome, emailConfirmation, turns }) {
  if (outcome === 'won') {
    return emailConfirmation.confirmed
      ? 'The owner agreed to proceed and confirmed the invoice email after read-back.'
      : 'The owner agreed to proceed, but the invoice email still needs confirmation.';
  }
  if (outcome === 'callback') return 'The owner did not decide on the call and asked to continue later.';
  if (outcome === 'unreachable') return 'The call did not reach a meaningful customer conversation.';
  const optOut = turns.some((t) => /\b(do not call|stop calling|remove me|take me off)\b/i.test(t.text));
  if (optOut || /\bopt[- ]?out\b/i.test(callOutcome || '')) return 'The owner asked not to continue outreach.';
  return 'The owner did not agree to buy during the call.';
}

function failureReasonFor({ outcome, callOutcome, turns, reason }) {
  if (outcome === 'callback') return 'Customer requested a later follow-up instead of committing on this call.';
  if (outcome === 'unreachable') return 'No meaningful customer conversation was captured.';
  const userText = turns.filter((t) => t.role === 'user' || t.role === 'unknown').map((t) => t.text).join('\n');
  if (/\b(too expensive|costs too much|no budget|price)\b/i.test(userText)) return 'Customer objected to price or budget.';
  if (/\b(already have|have a website|do not need|don't need)\b/i.test(userText)) return 'Customer said they did not need the service.';
  if (/\b(do not call|stop calling|remove me|take me off)\b/i.test(userText) || /\bopt[- ]?out\b/i.test(callOutcome || '')) {
    return 'Customer opted out of further calling.';
  }
  return reason || 'Customer did not agree to proceed.';
}

function normalizeNextBestAction(value, context) {
  const fallback = nextBestActionFor(context);
  if (!value || typeof value !== 'object') return fallback;
  const code = safeCode(value.code) || fallback.code;
  return {
    code,
    label: cleanText(value.label) || fallback.label,
    reason: oneSentence(value.reason) || fallback.reason
  };
}

function nextBestActionFor({ outcome, confirmedEmail, failureReason, turns }) {
  if (outcome === 'won' && confirmedEmail) {
    return {
      code: 'send_invoice',
      label: 'Send invoice',
      reason: 'The owner agreed and the invoice email was confirmed.'
    };
  }
  if (outcome === 'won') {
    return {
      code: 'confirm_invoice_email',
      label: 'Confirm invoice email',
      reason: 'The sale appears positive, but the transcript does not prove a confirmed invoice email.'
    };
  }
  if (outcome === 'callback') {
    return {
      code: 'schedule_callback',
      label: 'Schedule callback',
      reason: 'The customer asked to continue at another time.'
    };
  }
  if (outcome === 'unreachable') {
    return {
      code: 'retry_call',
      label: 'Retry call',
      reason: 'The call did not capture a useful conversation.'
    };
  }
  const userText = turns.filter((t) => t.role === 'user' || t.role === 'unknown').map((t) => t.text).join('\n');
  if (/\b(do not call|stop calling|remove me|take me off)\b/i.test(userText)) {
    return {
      code: 'do_not_call',
      label: 'Do not call',
      reason: 'The customer opted out.'
    };
  }
  return {
    code: 'stop_outreach',
    label: 'Stop outreach',
    reason: failureReason || 'The call did not produce a buying path.'
  };
}

function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const cleaned = email.trim().replace(/^mailto:/i, '').replace(/^[<>"'(),;]+|[<>"'(),;:.!?]+$/g, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) ? cleaned.toLowerCase() : null;
}

function transcriptText(transcript) {
  if (!transcript) return '';
  if (typeof transcript === 'string') return transcript;
  const turns = normalizeTranscriptTurns(transcript);
  if (turns.length) return turns.map((t) => t.text).join('\n');
  try { return JSON.stringify(transcript); } catch { return ''; }
}

function normalizeTranscriptTurns(transcript) {
  if (!transcript) return [];
  if (typeof transcript === 'string') return splitTranscriptString(transcript);
  const source = Array.isArray(transcript)
    ? transcript
    : firstArray(transcript, ['turns', 'messages', 'transcript', 'segments', 'items']);
  if (!source) return [];
  return source
    .map((turn, i) => normalizeTurn(turn, i))
    .filter((turn) => turn.text);
}

function firstArray(obj, keys) {
  for (const key of keys) {
    if (Array.isArray(obj?.[key])) return obj[key];
  }
  return null;
}

function normalizeTurn(turn, index) {
  if (typeof turn === 'string') return { role: 'unknown', text: cleanText(turn), ts: index };
  const rawRole = String(turn?.role || turn?.speaker || turn?.sender || turn?.author || turn?.type || '').toLowerCase();
  const text = cleanText(turn?.text || turn?.transcript || turn?.content || turn?.message || turn?.utterance || turn?.value);
  const role = /agent|assistant|caller|sales|bot|ai/.test(rawRole)
    ? 'agent'
    : /user|owner|customer|client|callee|human|lead/.test(rawRole)
      ? 'user'
      : 'unknown';
  const ts = numericTs(turn?.ts ?? turn?.timestamp ?? turn?.start ?? turn?.startTime ?? turn?.time) ?? index;
  return { role, text, ts };
}

function splitTranscriptString(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [{ role: 'unknown', text: raw, ts: 0 }];
  const parsed = lines.map((line, i) => {
    const m = line.match(/^([A-Za-z][A-Za-z0-9 _-]{0,30}):\s*(.+)$/);
    if (!m) return { role: 'unknown', text: line, ts: i };
    return normalizeTurn({ role: m[1], text: m[2], ts: i }, i);
  });
  return parsed.filter((turn) => turn.text);
}

function numericTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(value);
    if (Number.isFinite(d)) return d;
  }
  return null;
}

export function extractConfirmedInvoiceEmail({ transcript, modelEmail }) {
  const turns = normalizeTranscriptTurns(transcript);
  const preferred = sanitizeEmail(modelEmail);
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role === 'agent') continue;
    const candidates = emailCandidatesFromText(turn.text);
    for (const candidate of candidates) {
      if (preferred && candidate !== preferred) continue;
      const readBack = findReadBack(turns, i, candidate);
      if (!readBack) continue;
      const confirmation = findOwnerConfirmation(turns, readBack.index);
      if (!confirmation) continue;
      return {
        email: candidate,
        confirmed: true,
        source: 'transcript_readback',
        confidence: 0.98,
        sourceExcerpt: excerpt(`${turn.text} ${readBack.turn.text} ${confirmation.turn.text}`, 320),
        providedTurnIndex: i,
        readBackTurnIndex: readBack.index,
        confirmationTurnIndex: confirmation.index,
        evidence: {
          provided: excerpt(turn.text),
          readBack: excerpt(readBack.turn.text),
          confirmation: excerpt(confirmation.turn.text)
        }
      };
    }
  }

  const unconfirmed = preferred || emailCandidatesFromText(transcriptText(transcript))[0] || null;
  return {
    email: unconfirmed,
    confirmed: false,
    source: unconfirmed ? 'unconfirmed_candidate' : 'none',
    confidence: unconfirmed ? 0.42 : 0,
    sourceExcerpt: unconfirmed ? excerpt(transcriptText(transcript), 320) : null,
    providedTurnIndex: null,
    readBackTurnIndex: null,
    confirmationTurnIndex: null,
    evidence: null
  };
}

function findReadBack(turns, providedIndex, email) {
  for (let i = providedIndex + 1; i < Math.min(turns.length, providedIndex + 5); i += 1) {
    const turn = turns[i];
    if (turn.role === 'user') continue;
    if (turnMentionsEmail(turn.text, email) && asksForConfirmation(turn.text)) {
      return { index: i, turn };
    }
  }
  return null;
}

function findOwnerConfirmation(turns, readBackIndex) {
  for (let i = readBackIndex + 1; i < Math.min(turns.length, readBackIndex + 4); i += 1) {
    const turn = turns[i];
    if (turn.role === 'agent') continue;
    if (rejects(turn.text)) return null;
    if (confirms(turn.text)) return { index: i, turn };
  }
  return null;
}

function asksForConfirmation(text) {
  return /\b(is that right|is that correct|did i get that right|can you confirm|confirm that|correct\?|right\?)\b/i.test(text || '');
}

function confirms(text) {
  return /\b(yes|yeah|yep|correct|right|that's right|that is right|confirmed|exactly|you got it|sounds good)\b/i.test(text || '');
}

function rejects(text) {
  return /\b(no|nope|wrong|incorrect|not right|not correct|that's not|that is not)\b/i.test(text || '');
}

function turnMentionsEmail(text, email) {
  const wanted = sanitizeEmail(email);
  if (!wanted) return false;
  if (emailCandidatesFromText(text).includes(wanted)) return true;
  const [local, domain] = wanted.split('@');
  const compact = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return compact.includes(local.replace(/[^a-z0-9]+/g, '')) && compact.includes(domain.replace(/[^a-z0-9]+/g, ''));
}

function emailCandidatesFromText(text) {
  const out = [];
  const raw = String(text || '');
  for (const match of raw.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    const email = sanitizeEmail(match[0]);
    if (email) out.push(email);
  }
  out.push(...spokenEmailCandidates(raw));
  return uniqueStrings(out, 10);
}

function spokenEmailCandidates(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/\b(at sign|at symbol)\b/g, ' at ')
    .replace(/\b(dot|period|point)\b/g, ' dot ')
    .replace(/[^a-z0-9@._%+\-\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const candidates = [];
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] !== 'at' && words[i] !== '@') continue;
    const local = collectEmailSide(words, i - 1, -1).reverse();
    const domain = collectEmailSide(words, i + 1, 1);
    const email = sanitizeEmail(`${joinEmailTokens(local)}@${joinEmailTokens(domain)}`);
    if (email) candidates.push(email);
  }
  return candidates;
}

function collectEmailSide(words, start, step) {
  const parts = [];
  for (let i = start; i >= 0 && i < words.length && parts.length < 8; i += step) {
    const token = words[i];
    if (EMAIL_STOP_WORDS.has(token)) break;
    if (token === 'dot' || token === '.') {
      parts.push('.');
      continue;
    }
    if (token === 'dash' || token === 'hyphen' || token === '-') {
      parts.push('-');
      continue;
    }
    if (!/^[a-z0-9._%+-]+$/.test(token)) break;
    parts.push(token);
  }
  return parts;
}

function joinEmailTokens(tokens) {
  return tokens.join('').replace(/\.+/g, '.').replace(/^\.+|\.+$/g, '');
}

const EMAIL_STOP_WORDS = new Set([
  'email', 'mail', 'address', 'invoice', 'send', 'sent', 'is', 'it', 'to', 'for', 'me', 'my', 'the',
  'a', 'an', 'best', 'would', 'be', 'please', 'thanks', 'thank', 'you', 'yes', 'yeah', 'yep',
  'right', 'correct', 'confirm', 'confirmed', 'use', 'using', 'with', 'on', 'at', 'its', 's',
  'no', 'nope', 'wrong', 'incorrect', 'actually', 'correction', 'not', 'that'
]);

function extractCustomerQuestions(turns) {
  const questions = [];
  for (const turn of turns) {
    if (turn.role === 'agent') continue;
    const text = turn.text || '';
    const chunks = text.split(/(?<=[?!.])\s+/).map((s) => cleanText(s)).filter(Boolean);
    for (const chunk of chunks) {
      if (chunk.includes('?') || /^(what|when|where|why|how|who|can|could|do|does|did|will|would|is|are)\b/i.test(chunk)) {
        questions.push(chunk.replace(/\?*$/, '?'));
      }
    }
  }
  return uniqueStrings(questions, 5);
}

function normalizeReplayMoments(value, turns, outcome) {
  const modelMoments = Array.isArray(value) ? value : [];
  const normalized = modelMoments
    .map((m, i) => ({
      ts: numericTs(m?.ts) ?? i,
      excerpt: excerpt(m?.excerpt || ''),
      note: oneSentence(m?.note) || 'Moment affected the call outcome.'
    }))
    .filter((m) => m.excerpt)
    .slice(0, 5);
  if (normalized.length) return normalized;
  return deriveReplayMoments(turns, outcome);
}

function deriveReplayMoments(turns, outcome) {
  const patterns = [
    { re: /\b(send|email).{0,40}\b(invoice|bill|payment link)\b/i, note: 'Customer moved toward purchase.' },
    { re: /\b(how much|price|cost|charge)\b/i, note: 'Customer raised pricing.' },
    { re: /\b(call me back|call back|later|tomorrow|next week)\b/i, note: 'Customer deferred the decision.' },
    { re: /\b(not interested|do not need|don't need|already have)\b/i, note: 'Customer pushed back on need.' },
    { re: /\b(do not call|stop calling|remove me|take me off)\b/i, note: 'Customer opted out.' }
  ];
  const moments = [];
  for (const turn of turns) {
    for (const pattern of patterns) {
      if (pattern.re.test(turn.text)) {
        moments.push({ ts: turn.ts, excerpt: excerpt(turn.text), note: pattern.note });
        break;
      }
    }
    if (moments.length >= 5) break;
  }
  if (moments.length) return moments;
  const firstUser = turns.find((t) => t.role === 'user');
  if (firstUser) {
    return [{ ts: firstUser.ts, excerpt: excerpt(firstUser.text), note: `Representative customer turn for ${outcome} outcome.` }];
  }
  return [];
}

function hasMeaningfulUserTurn(turns) {
  return turns.some((t) => (t.role === 'user' || t.role === 'unknown') && cleanText(t.text).length > 8);
}

function listStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => cleanText(v)).filter(Boolean);
}

function uniqueStrings(value, limit = 5) {
  const seen = new Set();
  const out = [];
  for (const item of value || []) {
    const cleaned = cleanText(item);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function oneSentence(value) {
  const text = cleanText(value);
  if (!text) return null;
  const sentence = text.match(/^[^.!?]+[.!?]?/)?.[0] || text;
  return sentence.trim();
}

function cleanText(value) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return value.replace(/\s+/g, ' ').trim();
}

function excerpt(value, max = 220) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function safeCode(value) {
  const code = cleanText(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '');
  return code || null;
}
