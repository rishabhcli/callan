import { createHash } from 'node:crypto';
import { leads, payments, mossHotIndexes, mossRetrievals, mossSnippets } from '../db.js';
import { recordingDisclosure } from '../compliance.js';
import { containerTagFor } from '../memory.js';
import { buildPitchHotStrategy } from '../pitch.js';
import { emit } from '../sse.js';
import {
  deleteMossDocs,
  ensureMossIndex,
  mossRuntimeMode,
  normalizeMossError
} from '../providers/moss.js';

const DEFAULT_PRICE_CENTS = 50000;

export function mossIndexNameForLead(leadId) {
  const raw = `cmm_hot_${containerTagFor(leadId)}`.replace(/[^A-Za-z0-9._-]/g, '_');
  if (raw.length <= 100) return raw;
  return `cmm_hot_${shortHash(raw)}_${raw.slice(-56)}`;
}

export async function ensureLeadHotIndex(leadId, { lead, profile = null, pitch = null, callId = null, runId = null, recreate = false } = {}) {
  const row = lead || leads.get(leadId);
  if (!row) throw new Error(`lead not found: ${leadId}`);
  const indexName = mossIndexNameForLead(leadId);
  const docs = buildLeadHotIndexDocs({ lead: row, profile, pitch });
  const deadIds = new Set(mossSnippets.listByLead(leadId, { status: 'dead', limit: 500 }).map((snippet) => snippet.snippet_id));
  const activeDocs = docs.filter((doc) => !deadIds.has(doc.id));
  const mode = mossRuntimeMode();

  try {
    const result = await ensureMossIndex(indexName, activeDocs, { recreate, load: true });
    mossSnippets.upsertMany({
      lead_id: leadId,
      index_name: indexName,
      snippets: docs.map((doc) => ({
        snippet_id: doc.id,
        kind: doc.metadata.kind,
        title: doc.metadata.title,
        text: doc.text,
        status: deadIds.has(doc.id) ? 'dead' : 'active',
        metadata: doc.metadata
      }))
    });
    const status = mossHotIndexes.upsert({
      lead_id: leadId,
      index_name: indexName,
      status: 'ready',
      mode: result.mode || mode,
      doc_count: docs.length,
      active_doc_count: activeDocs.length,
      dead_doc_count: deadIds.size,
      metadata: {
        callId,
        runId,
        resultStatus: result.status,
        role: 'low_latency_in_call_hot_index',
        noWebSearch: true
      }
    });
    emit('moss.index.ready', {
      worker: 'moss',
      leadId,
      callId,
      runId,
      indexName,
      mode: result.mode || mode,
      status: result.status,
      docCount: docs.length,
      activeDocCount: activeDocs.length,
      deadDocCount: deadIds.size,
      noWebSearch: true
    });
    return { indexName, docs, activeDocs, status, providerResult: result };
  } catch (err) {
    const failure = normalizeMossError(err);
    mossHotIndexes.upsert({
      lead_id: leadId,
      index_name: indexName,
      status: 'failed',
      mode,
      doc_count: docs.length,
      active_doc_count: activeDocs.length,
      dead_doc_count: deadIds.size,
      last_error: failure.message,
      metadata: { callId, runId, category: failure.category || failure.code || 'unknown' }
    });
    emit('moss.index.error', {
      worker: 'moss',
      leadId,
      callId,
      runId,
      indexName,
      error: failure.message,
      category: failure.category || failure.code || 'unknown',
      noWebSearch: true
    });
    throw err;
  }
}

export function buildLeadHotIndexDocs({ lead, profile = null, pitch = null }) {
  const p = normalizeProfile(profile, lead);
  const price = priceForLead(lead.id);
  const disclosure = recordingDisclosure(lead.business_name);
  const docs = [
    doc('lead.fact.business', 'lead_fact', 'Business facts', [
      `${p.businessName} is a ${p.niche || 'local business'}${p.city ? ` in ${p.city}` : ''}.`,
      p.whatTheyDo,
      p.onlinePresenceSummary ? `Online presence: ${p.onlinePresenceSummary}` : null,
      p.phone ? `Phone: ${p.phone}` : null,
      p.address ? `Address: ${p.address}` : null
    ], { section: 'lead_facts' }),
    doc('lead.fact.needs', 'customer_need', 'Customer needs', [
      listSentence('Known customer needs', p.needs),
      listSentence('Research signals', p.signals),
      p.customerPersona ? `Likely customer persona: ${p.customerPersona}` : null
    ], { section: 'customer_facts' }),
    doc('compliance.recording_disclosure', 'compliance', 'Recording disclosure', disclosure, { section: 'disclosure', complianceIntent: 'recording_disclosure' }),
    doc('compliance.opt_out', 'compliance', 'Opt-out line', 'If the owner says stop, remove me, take me off, do not call, or unsubscribe, acknowledge it politely, stop selling, end the call, and mark do-not-call.', { section: 'opt_out', complianceIntent: 'opt_out' }),
    doc('compliance.no_unverified_claims', 'compliance', 'No unverified claims', 'Do not promise SEO rankings, legal guarantees, immediate revenue, domain ownership, or ad performance. Keep the offer to a simple website build, hosted page, invoice, and reply path.', { section: 'claims', complianceIntent: 'unsupported_claims' }),
    doc('pricing.flat_fee', 'invoice_pricing', 'Flat fee', `The offer is a flat ${formatAmount(price)} same-day website package. Nothing starts until the customer chooses to pay the hosted invoice.`, { section: 'pricing', amountCents: price }),
    doc('pricing.invoice_handoff', 'invoice_pricing', 'Invoice handoff', 'If the owner agrees, ask for the best invoice email, read it back exactly, ask them to confirm, then explain that AgentMail sends the invoice and keeps replies attached to the build.', { section: 'invoice', amountCents: price }),
    doc('strategy.call', 'call_strategy', 'Call strategy', [
      ...buildPitchHotStrategy({ pitch, profile: p, lead }),
      'Answer the first objection directly, then close only if the owner shows positive intent.',
      p.onlinePresenceStrength ? `Presence strength: ${p.onlinePresenceStrength}.` : null,
      p.ownerHypothesis ? `Owner hypothesis: ${p.ownerHypothesis}.` : null
    ], { section: 'strategy' })
  ];

  if (pitch) {
    docs.push(
      doc('pitch.opening', 'pitch_snippet', 'Opening line', pitch.openingLine, { section: 'opening' }),
      doc('pitch.value', 'pitch_snippet', 'Value proposition', pitch.valueProp, { section: 'value_prop' }),
      doc('pitch.close', 'pitch_snippet', 'Close', pitch.close, { section: 'close' }),
      doc('pitch.begin', 'pitch_snippet', 'First message', pitch.beginMessage, { section: 'begin_message' }),
      doc('pitch.email_ask', 'invoice_pricing', 'Email ask', pitch.emailAsk, { section: 'email_ask' }),
      doc('pitch.email_readback', 'compliance', 'Email readback', pitch.emailReadbackInstruction, { section: 'email_readback', complianceIntent: 'email_readback' }),
      doc('pitch.invoice_close', 'invoice_pricing', 'Invoice close', pitch.invoiceClose, { section: 'invoice_close' })
    );
    for (const [i, question] of (pitch.discoveryQuestions || []).entries()) {
      docs.push(doc(`pitch.discovery.${i}`, 'customer_need', `Discovery question ${i + 1}`, question, { section: 'discovery' }));
    }
    for (const [i, item] of (pitch.objections || []).entries()) {
      docs.push(doc(`pitch.objection.${i}`, 'objection', item.objection, `${item.objection} :: ${item.response}`, {
        section: 'objection',
        objection: item.objection
      }));
    }
  } else {
    docs.push(
      doc('objection.price.default', 'objection', 'Price objection', `If they ask price or say it is expensive, explain the flat ${formatAmount(price)} scope and that it avoids a drawn-out agency project.`, { section: 'objection', objection: 'price' }),
      doc('objection.website.default', 'objection', 'Already has website', 'If they already have a website, frame this as a focused conversion page for the clearest services, trust proof, and contact step, not a replacement unless they want one.', { section: 'objection', objection: 'already_has_website' }),
      doc('objection.busy.default', 'objection', 'Busy owner', 'If they are busy, keep it short: the agent can draft from public business info, send the invoice, and accept corrections by reply.', { section: 'objection', objection: 'busy' })
    );
  }

  return docs.filter((item) => item.text);
}

export function mossStatusForLead(leadId) {
  const index = mossHotIndexes.getByLead(leadId);
  const snippets = mossSnippets.listByLead(leadId, { limit: 250 });
  const retrievals = mossRetrievals.listByLead(leadId, { limit: 100 });
  const byKind = snippets.reduce((acc, snippet) => {
    const kind = snippet.kind || 'snippet';
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  return {
    index,
    snippets,
    retrievals,
    byKind,
    activeCount: snippets.filter((snippet) => snippet.status === 'active').length,
    deadCount: snippets.filter((snippet) => snippet.status === 'dead').length
  };
}

export async function markDeadMossSnippets(leadId, snippetIds, { reason = 'analyst_dead_snippet' } = {}) {
  const index = mossHotIndexes.getByLead(leadId);
  const ids = [...new Set((snippetIds || []).filter(Boolean))];
  const changed = [];
  for (const snippetId of ids) {
    const row = mossSnippets.markDead(leadId, snippetId, { reason });
    if (row) changed.push(row);
  }
  if (index && ids.length) {
    try {
      await deleteMossDocs(index.index_name, ids);
    } catch (err) {
      emit('moss.snippet.delete_error', {
        worker: 'moss',
        leadId,
        indexName: index.index_name,
        snippetIds: ids,
        error: err?.message || String(err),
        noWebSearch: true
      });
    }
  }
  refreshIndexCounts(leadId);
  return changed;
}

export async function addImprovedMossSnippet(leadId, { kind = 'call_strategy', title = 'Improved call snippet', text, metadata = {} }) {
  const index = mossHotIndexes.getByLead(leadId);
  const indexName = index?.index_name || mossIndexNameForLead(leadId);
  const snippetId = `improved.${kind}.${shortHash(`${title}:${text}`)}`;
  const row = mossSnippets.addImproved({
    lead_id: leadId,
    index_name: indexName,
    snippet_id: snippetId,
    kind,
    title,
    text,
    metadata: { ...metadata, source: 'analyst' }
  });
  await ensureMossIndex(indexName, [{
    id: snippetId,
    text,
    metadata: { kind, title, source: 'analyst', ...metadata }
  }], { load: true });
  refreshIndexCounts(leadId);
  emit('moss.snippet.improved', {
    worker: 'analyst',
    leadId,
    indexName,
    snippetId,
    kind,
    title,
    noWebSearch: true
  });
  return row;
}

function refreshIndexCounts(leadId) {
  const index = mossHotIndexes.getByLead(leadId);
  if (!index) return null;
  const snippets = mossSnippets.listByLead(leadId, { limit: 1000 });
  return mossHotIndexes.upsert({
    lead_id: leadId,
    index_name: index.index_name,
    status: index.status || 'ready',
    mode: index.mode || mossRuntimeMode(),
    doc_count: snippets.length,
    active_doc_count: snippets.filter((snippet) => snippet.status === 'active').length,
    dead_doc_count: snippets.filter((snippet) => snippet.status === 'dead').length,
    metadata: index.metadata
  });
}

function normalizeProfile(profile, lead) {
  const parsed = typeof profile === 'string' ? parseJson(profile) : profile;
  return {
    businessName: firstText(parsed?.businessName, lead.business_name, 'the business'),
    niche: firstText(parsed?.niche, lead.niche, 'small business'),
    city: firstText(parsed?.city, lead.city, ''),
    phone: firstText(parsed?.phone, lead.phone, ''),
    address: firstText(parsed?.address, lead.address, ''),
    whatTheyDo: firstText(parsed?.whatTheyDo, parsed?.onlinePresenceSummary, `${lead.business_name} is a ${lead.niche || 'small business'}.`),
    onlinePresenceStrength: firstText(parsed?.onlinePresenceStrength, lead.online_presence_strength, ''),
    onlinePresenceSummary: firstText(parsed?.onlinePresenceSummary, ''),
    ownerHypothesis: firstText(parsed?.ownerHypothesis, ''),
    customerPersona: firstText(parsed?.customerPersona, ''),
    needs: stringList(parsed?.needs),
    signals: stringList(parsed?.signals)
  };
}

function priceForLead(leadId) {
  const payment = payments.listByLead(leadId)[0];
  return payment?.amount_cents || DEFAULT_PRICE_CENTS;
}

function doc(id, kind, title, parts, metadata = {}) {
  const text = Array.isArray(parts)
    ? parts.map((part) => cleanText(part)).filter(Boolean).join(' ')
    : cleanText(parts);
  return {
    id,
    text,
    metadata: {
      kind,
      title,
      ...metadata
    }
  };
}

function listSentence(label, items) {
  const list = stringList(items);
  return list.length ? `${label}: ${list.join('; ')}.` : null;
}

function stringList(value) {
  return Array.isArray(value) ? value.map((item) => cleanText(item)).filter(Boolean).slice(0, 10) : [];
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return '';
}

function cleanText(value) {
  if (value == null) return '';
  if (typeof value !== 'string') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return value.replace(/\s+/g, ' ').trim();
}

function parseJson(value) {
  try { return value ? JSON.parse(value) : null; } catch { return null; }
}

function formatAmount(cents) {
  return `$${(Number(cents || DEFAULT_PRICE_CENTS) / 100).toLocaleString('en-US', { minimumFractionDigits: 0 })}`;
}

function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 10);
}
