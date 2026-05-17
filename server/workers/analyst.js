import { emit } from '../sse.js';
import { runs, leads, calls } from '../db.js';
import { containerTagFor, addDoc, getLatest } from '../memory.js';
import { generateJson } from '../gemini.js';
import { PostMortemSchema } from '../types.js';
import { env } from '../env.js';
import { log } from '../logger.js';

const OUTCOME_TO_STATUS = {
  won: 'closing',
  lost: 'rejected',
  callback: 'callback',
  unreachable: 'unreachable'
};

export async function runAnalyst({ leadId, callId }) {
  const runId = `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  runs.start({ id: runId, lead_id: leadId, worker: 'analyst' });
  emit('analyst.start', { worker: 'analyst', leadId, callId, runId });

  try {
    const lead = leads.get(leadId);
    if (!lead) throw new Error(`lead not found: ${leadId}`);
    const tag = containerTagFor(leadId);

    const [profileDoc, pitchDoc] = await Promise.all([
      safeGetLatest(tag, 'profile'),
      safeGetLatest(tag, 'pitch')
    ]);
    const transcript = readTranscript(callId);

    const prompt = buildPrompt({ lead, profileDoc, pitchDoc, transcript });
    const postMortem = await generateJson({
      schema: PostMortemSchema,
      prompt,
      systemInstruction: 'You are a brutally honest call coach. No flattery. Be specific.',
      thinkingLevel: 'medium'
    });

    await addDoc(tag, 'post_mortem', postMortem, { callId, outcome: postMortem.outcome });

    const status = OUTCOME_TO_STATUS[postMortem.outcome];
    if (status) leads.update(leadId, { status });

    emit('analyst.done', {
      worker: 'analyst',
      leadId,
      runId,
      outcome: postMortem.outcome,
      reason: postMortem.reason
    });

    if (postMortem.outcome === 'won') {
      const toEmail = resolveMailerEmail(lead);
      if (toEmail) {
        import('./mailer.js')
          .then((m) => m.runMailer({ leadId, toEmail }))
          .catch((err) => log.warn('analyst.mailer.fire_failed', { leadId, err: err?.message }));
      }
    }

    runs.finish(runId, { state: 'completed', detail: { outcome: postMortem.outcome } });
    return { postMortem };
  } catch (err) {
    runs.finish(runId, { state: 'failed', error: err?.message || String(err) });
    emit('analyst.error', { worker: 'analyst', leadId, runId, error: err?.message || String(err) });
    throw err;
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

function readTranscript(callId) {
  if (!callId) return null;
  const row = calls.get(callId);
  if (!row?.transcript_json) return null;
  try {
    return JSON.parse(row.transcript_json);
  } catch {
    return row.transcript_json;
  }
}

function buildPrompt({ lead, profileDoc, pitchDoc, transcript }) {
  const profile = profileDoc?.content || profileDoc?.metadata?.businessName || 'unknown';
  const pitch = pitchDoc?.content || 'unknown';
  const t = transcript ? JSON.stringify(transcript).slice(0, 18000) : 'unavailable';
  return [
    `Lead: ${lead.business_name} (${lead.niche || 'unknown niche'}, ${lead.city || 'unknown city'}).`,
    `Phone: ${lead.phone || 'n/a'}.`,
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
    'whatWorked and whatToTryNext: short, concrete, no platitudes.',
    'replayMoments: up to 5 entries pointing at exact transcript excerpts that turned the call.',
    'followupEmailDraft: only fill if outcome=="won". Otherwise null.'
  ].join('\n');
}

function resolveMailerEmail(lead) {
  if (env.allowedEmails?.length) return env.allowedEmails[0];
  if (env.runMode === 'mock') {
    const slug = String(lead.business_name || 'business')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'business';
    return `owner@${slug}.com`;
  }
  return null;
}
