import React, { useEffect, useMemo, useState } from 'react';
import Transcript from './Transcript.jsx';
import MemoryDoc from './MemoryDoc.jsx';
import MemoryConsole from './MemoryConsole.jsx';
import GrowthConsole from './GrowthConsole.jsx';
import BuildQAConsole from './BuildQAConsole.jsx';
import { api } from '../api.js';

const TABS = ['Memory', 'Caller', 'Moss', 'Analyst', 'Mailer', 'Builder', 'Growth'];

function parseDoc(doc) {
  if (!doc) return null;
  const raw = doc.content ?? doc.summary ?? doc.body ?? '';
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

function fmtPaymentAmount(cents) {
  if (cents == null) return '$500.00';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
}

const PRESENCE_STRENGTHS = new Set(['none', 'weak', 'mixed', 'strong']);

function labelize(value) {
  return String(value || '').replace(/_/g, ' ');
}

function normalizePresence(value) {
  const normalized = String(value || '').toLowerCase();
  return PRESENCE_STRENGTHS.has(normalized) ? normalized : null;
}

function detailLead(detail) {
  return detail?.lead || {};
}

function profileFromDetail(detail) {
  if (detail?.researchProfile) return detail.researchProfile;
  const leadJson = detail?.lead?.research_json;
  if (leadJson) {
    try { return JSON.parse(leadJson); } catch {}
  }
  return parseDoc(detail?.memory?.business_profile?.[0] || detail?.memory?.profile?.[0]);
}

function presenceFromEvidence(lead, profile) {
  const explicit = (
    normalizePresence(profile?.onlinePresenceStrength) ||
    normalizePresence(lead.onlinePresenceStrength || lead.online_presence_strength || lead.presence_strength) ||
    (lead.risk_status === 'strong_presence' || lead.risk_status === 'strong_online_presence' ? 'strong' : null)
  );
  if (explicit) return explicit;
  if (profile?.hasWebsite === false) return 'weak';
  if (profile?.hasWebsite === true && profile?.websiteUrl) return 'mixed';
  return null;
}

function sourceCandidates(lead, profile) {
  const sourceUrl = profile?.sourceUrl || lead.source_url || lead.normalized_source_url || null;
  const rows = [
    ['source', sourceUrl],
    ['yelp', profile?.yelpUrl],
    ['website', profile?.websiteUrl || lead.website]
  ];
  const seen = new Set();
  return rows
    .map(([label, url]) => [label, typeof url === 'string' ? url.trim() : null])
    .filter(([label, url]) => label === 'source' || url)
    .filter(([, url]) => {
      if (!url) return true;
      const key = url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(([label, url]) => ({ label, url }));
}

function isExternalUrl(value) {
  return /^https?:\/\//i.test(value || '');
}

function explainCallability(lead, profile) {
  const outreach = lead.outreach_status || 'not_queued';
  const risk = lead.risk_status || 'unknown';
  const phoneClass = lead.phone_classification || 'unknown';
  const presence = presenceFromEvidence(lead, profile);
  const hasPhone = Boolean(lead.phone || profile?.phone);

  if (presence === 'strong' || risk === 'strong_presence' || risk === 'strong_online_presence') {
    return {
      state: 'blocked',
      label: 'not worth calling',
      tone: 'stop',
      explanation: 'Strong online presence is already documented, so the sales call is intentionally blocked instead of forcing a low-value pitch.'
    };
  }
  if (!hasPhone || phoneClass === 'invalid') {
    return {
      state: 'blocked',
      label: 'blocked',
      tone: 'bad',
      explanation: 'No callable business phone evidence is available yet.'
    };
  }
  if (outreach === 'blocked') {
    return {
      state: 'blocked',
      label: 'blocked',
      tone: 'bad',
      explanation: `${labelize(risk) || 'Outreach gate'} stopped this lead before dialing.`
    };
  }
  if (risk === 'callable' || outreach === 'calling' || outreach === 'called') {
    return {
      state: 'callable',
      label: 'callable',
      tone: 'good',
      explanation: `${labelize(phoneClass)} phone evidence passed compliance and callability checks.`
    };
  }
  if (outreach === 'queued' || outreach === 'retry') {
    return {
      state: 'queued',
      label: 'queued',
      tone: 'info',
      explanation: 'This lead is in the outreach queue and still needs the final callability gate before dialing.'
    };
  }
  if (risk === 'needs_callability_check') {
    return {
      state: 'pending',
      label: 'needs check',
      tone: 'info',
      explanation: 'Research is complete, but the phone and compliance checks have not cleared yet.'
    };
  }
  return {
    state: 'pending',
    label: 'research pending',
    tone: 'muted',
    explanation: 'The lead has not produced enough callability evidence yet.'
  };
}

function formatWhen(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function getPostMortem(detail) {
  return parseDoc(detail?.memory?.call_analysis?.[0] || detail?.memory?.post_mortem?.[0]);
}

function getMailEvents(detail) {
  return (detail?.contactEvents || [])
    .filter((event) => event.channel === 'agentmail')
    .slice()
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

function invoiceEmailSignal(postMortem, events) {
  const invoiceEvent = events.find((event) => event.type === 'invoice_email');
  const meta = safeJson(invoiceEvent?.metadata_json);
  if (postMortem?.invoiceEmail && postMortem?.confirmedEmail) {
    return {
      level: 'high',
      label: 'confirmed',
      email: postMortem.invoiceEmail,
      source: 'owner confirmed it on the call'
    };
  }
  if (postMortem?.invoiceEmail) {
    return {
      level: 'medium',
      label: 'captured',
      email: postMortem.invoiceEmail,
      source: 'heard on the call, not read-back confirmed'
    };
  }
  if (meta?.toMasked) {
    return {
      level: 'medium',
      label: 'sent',
      email: meta.toMasked,
      source: 'AgentMail send target is masked'
    };
  }
  return {
    level: 'low',
    label: 'missing',
    email: '—',
    source: 'no confirmed invoice email in memory'
  };
}

function questionsFromMail(events) {
  return events
    .filter((event) => event.direction === 'inbound' && event.body && event.body.includes('?'))
    .map((event) => event.body.trim())
    .slice(-3);
}

function uniqueQuestions(postMortem, events) {
  const seen = new Set();
  return [...(postMortem?.customerQuestions || []), ...questionsFromMail(events)]
    .map((q) => String(q || '').trim())
    .filter((q) => {
      const key = q.toLowerCase();
      if (!q || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function mailFlags(events, lead) {
  const flags = [];
  const risk = lead?.risk_status || '';
  if (risk.includes('handoff')) flags.push({ text: 'operator handoff', tone: 'warn' });
  if (risk.includes('agentmail-spam') || risk.includes('agentmail-blocked') || risk.includes('agentmail-unauthenticated')) flags.push({ text: 'mail flagged', tone: 'bad' });
  if (risk.includes('opt-out')) flags.push({ text: 'opt out', tone: 'bad' });
  if (events.some((event) => event.type === 'handoff_reply')) {
    flags.push({ text: 'handoff reply sent', tone: 'warn' });
  }
  if (events.some((event) => {
    const meta = safeJson(event.metadata_json);
    const reason = meta?.classification?.reason || event.body || '';
    return /unsupported|legal|contract|guarantee|seo/i.test(reason);
  })) {
    flags.push({ text: 'unsupported ask', tone: 'bad' });
  }
  return flags;
}

function eventFlags(event) {
  const meta = safeJson(event.metadata_json);
  const kind = meta?.classification?.kind;
  const reason = meta?.classification?.reason || '';
  const flags = [];
  if (event.type === 'customer_reply') flags.push({ text: 'waiting', tone: 'info' });
  if (event.type === 'customer_reply_flagged') flags.push({ text: 'provider flagged', tone: 'bad' });
  if (event.type === 'invoice_email') flags.push({ text: 'invoice', tone: 'good' });
  if (event.type === 'agent_reply') flags.push({ text: 'auto reply', tone: 'good' });
  if (event.type === 'handoff_reply' || kind === 'handoff') flags.push({ text: 'handoff', tone: 'warn' });
  if (/unsupported|legal|contract|guarantee|seo/i.test(reason)) flags.push({ text: 'unsupported', tone: 'bad' });
  if (meta?.mockEmail || meta?.mock) flags.push({ text: 'mock', tone: 'muted' });
  else if (event.provider_id || meta?.provider_id) flags.push({ text: 'live', tone: 'good' });
  return flags;
}

function replyWaitingCount(events) {
  return events.filter((event) => event.direction === 'inbound' && event.type === 'customer_reply').length;
}

function invoiceProofFromEvents(events) {
  const event = events.find((row) => row.type === 'invoice_email');
  const meta = safeJson(event?.metadata_json) || {};
  const proof = meta.confirmedEmailProof || {};
  return {
    paymentId: meta.paymentId || null,
    invoiceStatus: meta.invoiceStatus || null,
    invoicePdfUrl: meta.invoicePdfUrl || null,
    consentEventId: meta.invoiceConsentEventId || null,
    emailProofSource: proof.source || null,
    emailProof: proof.evidence || null
  };
}

export default function Inspector({
  activeTab,
  setActiveTab,
  focusedLeadId,
  leadDetail,
  liveTranscript,
  liveCallId,
  liveCallActive,
  builderInfo,
  builderAction,
  health,
  onRetryBuild,
  outreach,
  onStartAutonomy,
  onStopAutonomy,
  onLeadChanged
}) {
  return (
    <div className="inspector inspector-overhaul">
      {focusedLeadId ? (
        <LeadHero
          leadId={focusedLeadId}
          detail={leadDetail}
          builderInfo={builderInfo}
          builderAction={builderAction}
          outreach={outreach}
          onStartAutonomy={onStartAutonomy}
          onStopAutonomy={onStopAutonomy}
          onLeadChanged={onLeadChanged}
        />
      ) : (
        <div className="lead-hero-empty">// select a lead on the left to inspect</div>
      )}
      <div className="inspector-tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? 'tab-active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <span className="tab-key mono">{TABS.indexOf(tab) + 1}</span>
            <span className="tab-label">{tab}</span>
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {!focusedLeadId ? (
          <div className="empty-inspector">
            <div className="empty-title">no lead in focus</div>
            <div className="empty-sub mono">// click a lead on the left, then a node above to inspect.</div>
          </div>
        ) : (
          <>
            {activeTab === 'Memory'  && <MemoryTab detail={leadDetail} />}
            {activeTab === 'Caller'  && (
              <CallerTab
                detail={leadDetail}
                liveTranscript={liveTranscript}
                liveCallId={liveCallId}
                liveCallActive={liveCallActive}
              />
            )}
            {activeTab === 'Moss' && <MossTab detail={leadDetail} />}
            {activeTab === 'Analyst' && <AnalystTab detail={leadDetail} />}
            {activeTab === 'Mailer'  && <MailerTab detail={leadDetail} />}
            {activeTab === 'Builder' && (
              <BuilderTab
                detail={leadDetail}
                focusedLeadId={focusedLeadId}
                builderInfo={builderInfo}
                builderAction={builderAction}
                onRetryBuild={onRetryBuild}
              />
            )}
            {activeTab === 'Growth' && (
              <GrowthConsole
                detail={leadDetail}
                focusedLeadId={focusedLeadId}
                onLeadChanged={onLeadChanged}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LeadHero({ leadId, detail, builderInfo, builderAction, outreach, onStartAutonomy, onStopAutonomy, onLeadChanged }) {
  const lead = detailLead(detail);
  const profile = profileFromDetail(detail);
  const presence = presenceFromEvidence(lead, profile);
  const callability = explainCallability(lead, profile);
  const builderState = useMemo(
    () => mergeBuilderState(detail, builderInfo, leadId),
    [detail, builderInfo, leadId]
  );
  const stages = useMemo(() => proofStages(detail, builderState), [detail, builderState]);
  const containerTag = lead.container_tag || '—';
  const phone = lead.phone || profile?.phone || '—';
  const busyBuild = builderAction?.running && builderAction?.leadId === leadId;

  return (
    <section className="lead-hero">
      <div className="lead-hero-top">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="lead-hero-title">{lead.business_name || leadId || '—'}</div>
          <div className="lead-hero-meta">
            <span><span className="lead-hero-meta-key">id</span> {leadId}</span>
            <span><span className="lead-hero-meta-key">phone</span> {phone}</span>
            <span><span className="lead-hero-meta-key">tag</span> {containerTag}</span>
          </div>
        </div>
        <div className="lead-hero-chips">
          {presence ? (
            <span className={`lead-hero-chip lead-hero-chip-${presence === 'strong' ? 'stop' : presence === 'mixed' ? 'warn' : 'good'}`}>
              {presence}
            </span>
          ) : null}
          <span className={`lead-hero-chip lead-hero-chip-${callability.tone}`}>{callability.label}</span>
          {busyBuild ? <span className="lead-hero-chip lead-hero-chip-warn">build starting</span> : null}
          {builderState.authNeeded ? <span className="lead-hero-chip lead-hero-chip-bad">auth needed</span> : null}
          <ActionMenu
            leadId={leadId}
            detail={detail}
            outreach={outreach}
            onStartAutonomy={onStartAutonomy}
            onStopAutonomy={onStopAutonomy}
            onLeadChanged={onLeadChanged}
            explanation={callability.explanation}
          />
        </div>
      </div>
      <div className="lead-hero-pipe">
        {stages.map((stage) => (
          <span key={stage.label} className={`lead-hero-stage lead-hero-stage-${stage.state}`}>
            <span className="lead-hero-stage-dot" />
            {stage.label}
          </span>
        ))}
      </div>
    </section>
  );
}

function ActionMenu({ leadId, detail, outreach, onStartAutonomy, onStopAutonomy, onLeadChanged, explanation }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [explain, setExplain] = useState(null);
  const [error, setError] = useState(null);
  const menuRef = React.useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function run(action) {
    setBusy(action);
    setError(null);
    try {
      if (action === 'approve') await api.approveLiveCall(leadId);
      if (action === 'retry') await api.forceRetry(leadId);
      if (action === 'optout') await api.optOutLead(leadId);
      if (action === 'block') {
        await api.blockLead(leadId, {
          reasonCode: 'operator_blocked',
          reason: 'Operator blocked lead before outreach'
        });
      }
      if (action === 'autonomy') {
        if (outreach?.running) await onStopAutonomy?.();
        else await onStartAutonomy?.();
      }
      if (action === 'why') {
        const data = await api.explainCallability(leadId);
        setExplain(data);
        return;
      }
      if (action !== 'autonomy') onLeadChanged?.(leadId);
      setOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="action-menu" ref={menuRef}>
      <button
        type="button"
        className="action-menu-btn"
        onClick={() => setOpen((prev) => !prev)}
        disabled={!leadId}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        actions ▾
      </button>
      {open ? (
        <div className="action-menu-list" role="menu">
          <button className="action-menu-item" onClick={() => run('approve')} disabled={busy === 'approve'}>
            {busy === 'approve' ? 'approving…' : 'approve live-call'}
          </button>
          <button className="action-menu-item" onClick={() => run('retry')} disabled={busy === 'retry'}>
            {busy === 'retry' ? 'retrying…' : 'force retry'}
          </button>
          <button className="action-menu-item action-menu-item-danger" onClick={() => run('optout')} disabled={busy === 'optout'}>
            {busy === 'optout' ? 'opting out…' : 'opt-out (do-not-call)'}
          </button>
          <button className="action-menu-item action-menu-item-danger" onClick={() => run('block')} disabled={busy === 'block'}>
            {busy === 'block' ? 'blocking…' : 'block lead'}
          </button>
          <button className="action-menu-item" onClick={() => run('autonomy')} disabled={busy === 'autonomy'}>
            {outreach?.running ? 'pause autonomy' : 'start autonomy'}
          </button>
          <button className="action-menu-item action-menu-item-info" onClick={() => run('why')} disabled={busy === 'why'}>
            {busy === 'why' ? 'checking…' : 'why is this state?'}
          </button>
          {explain ? (
            <div className="action-menu-explain">
              <div><strong>{explain.decision || 'callability'}:</strong> {explain.callability?.reason || explanation}</div>
              {(explain.blockers || []).slice(0, 3).map((b) => (
                <div key={`${b.source}:${b.code}`}>· {b.code}: {b.reason}</div>
              ))}
            </div>
          ) : null}
          {error ? <div className="action-menu-explain" style={{ color: 'var(--error)' }}>{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function OperatorControls({
  leadId,
  detail,
  outreach,
  onStartAutonomy,
  onStopAutonomy,
  onLeadChanged
}) {
  const [explain, setExplain] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [blockCode, setBlockCode] = useState('operator_blocked');
  const [blockReason, setBlockReason] = useState('Operator blocked lead before outreach');

  useEffect(() => {
    let cancelled = false;
    setExplain(null);
    setError(null);
    if (!leadId) return () => { cancelled = true; };
    api.explainCallability(leadId)
      .then((data) => { if (!cancelled) setExplain(data); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [leadId, detail?.lead?.updated_at]);

  useEffect(() => {
    setBlockCode('operator_blocked');
    setBlockReason('Operator blocked lead before outreach');
  }, [leadId]);

  async function reloadExplain() {
    if (!leadId) return;
    const data = await api.explainCallability(leadId);
    setExplain(data);
  }

  async function run(action) {
    setBusy(action);
    setError(null);
    try {
      if (action === 'approve') await api.approveLiveCall(leadId);
      if (action === 'retry') await api.forceRetry(leadId);
      if (action === 'optout') await api.optOutLead(leadId);
      if (action === 'block') await api.blockLead(leadId, {
        reasonCode: blockCode,
        reason: blockReason
      });
      if (action === 'autonomy') {
        if (outreach?.running) await onStopAutonomy?.();
        else await onStartAutonomy?.();
      }
      if (action !== 'autonomy') onLeadChanged?.(leadId);
      await reloadExplain();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const blockers = explain?.blockers || [];
  const status = explain?.status || statusFromLead(detail?.lead);
  const callability = explain?.callability;
  const decision = explain?.decision || 'checking';

  return (
    <div className="operator-controls">
      <div className="operator-head">
        <div className="operator-title">
          <span className="hd">operator controls</span>
          <span className={`decision decision-${decision}`}>{decision}</span>
        </div>
        <div className="operator-actions">
          <button className="btn btn-mini" disabled={!!busy} onClick={() => run('approve')}>approve live-call</button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => run('retry')}>force retry</button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => run('optout')}>opt-out</button>
          <button className="btn btn-mini" disabled={!!busy} onClick={() => run('autonomy')}>
            {outreach?.running ? 'pause autonomy' : 'start autonomy'}
          </button>
          <button
            className="btn btn-mini"
            disabled={!!busy}
            onClick={() => reloadExplain().catch((e) => setError(e.message))}
          >
            why
          </button>
        </div>
      </div>

      <div className="operator-grid">
        <div className="operator-reasons">
          {(blockers.length ? blockers : callability ? [{
            code: callability.reasonCode,
            reason: callability.reason,
            source: 'callability'
          }] : []).map((blocker) => (
            <div key={`${blocker.source}:${blocker.code}:${blocker.reason}`} className="reason-row">
              <span className="reason-code mono">{blocker.code}</span>
              <span className="reason-text">{blocker.reason}</span>
              <span className="reason-source mono">{blocker.source}</span>
            </div>
          ))}
          {!blockers.length && !callability ? (
            <div className="reason-row reason-muted">
              <span className="reason-code mono">loading</span>
              <span className="reason-text">checking callability</span>
              <span className="reason-source mono">ui</span>
            </div>
          ) : null}
        </div>

        <div className="operator-status mono">
          <StatusCell label="outreach_status" value={status.outreachStatus} />
          <StatusCell label="risk_status" value={status.riskStatus} />
          <StatusCell label="phone_classification" value={status.phoneClassification} />
          <StatusCell label="next_action" value={status.nextAction || '—'} />
        </div>
      </div>

      <div className="operator-blockline">
        <label className="operator-field mono">
          <span>block code</span>
          <input value={blockCode} onChange={(e) => setBlockCode(e.target.value)} />
        </label>
        <label className="operator-field mono operator-field-wide">
          <span>block reason</span>
          <input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} />
        </label>
        <button className="btn btn-mini btn-danger" disabled={!!busy} onClick={() => run('block')}>block lead</button>
      </div>
      {error ? <div className="operator-error mono">{error}</div> : null}
    </div>
  );
}

function StatusCell({ label, value }) {
  return (
    <div className="status-cell">
      <span>{label}</span>
      <strong>{value || 'unknown'}</strong>
    </div>
  );
}

function statusFromLead(lead) {
  return {
    outreachStatus: lead?.outreach_status || 'unknown',
    riskStatus: lead?.risk_status || 'unknown',
    consentStatus: lead?.consent_status || 'unknown',
    phoneClassification: lead?.phone_classification || 'unknown',
    nextAction: lead?.next_action || null
  };
}

function LeadProofRail({ detail, focusedLeadId, builderInfo, builderAction, health }) {
  const builderState = useMemo(
    () => mergeBuilderState(detail, builderInfo, focusedLeadId),
    [detail, builderInfo, focusedLeadId]
  );
  const events = useMemo(() => proofEvents(detail, builderState), [detail, builderState]);
  const stages = useMemo(() => proofStages(detail, builderState), [detail, builderState]);
  const lead = detailLead(detail);
  const payment = detail?.payments?.[0];
  const paymentMode = paymentProofMode(payment);
  const buildMode = buildProofMode(builderState);
  const appMode = health?.mode || health?.readiness?.mode || 'mock';
  const busyBuild = builderAction?.running && builderAction?.leadId === focusedLeadId;

  return (
    <section className="lead-proof-rail">
      <div className="proof-head">
        <div>
          <span className="hd">operation proof</span>
          <span className="proof-business">{lead.business_name || focusedLeadId}</span>
        </div>
        <div className="proof-head-chips">
          <span className={`proof-chip proof-chip-${appMode === 'mock' ? 'mock' : 'live'}`}>{appMode}</span>
          <span className={`proof-chip proof-chip-${paymentMode.tone}`}>{paymentMode.label}</span>
          <span className={`proof-chip proof-chip-${buildMode.tone}`}>{buildMode.label}</span>
          {builderState.authNeeded ? <span className="proof-chip proof-chip-bad">auth needed</span> : null}
          {busyBuild ? <span className="proof-chip proof-chip-warn">build starting</span> : null}
        </div>
      </div>

      <div className="proof-stage-row">
        {stages.map((stage) => (
          <span key={stage.label} className={`proof-stage proof-stage-${stage.state}`}>
            <span className="proof-stage-dot" />
            {stage.label}
          </span>
        ))}
      </div>

      <div className="proof-events">
        {events.length ? events.map((event) => (
          <div key={event.id} className="proof-event">
            <span className="proof-event-time mono">{formatWhen(event.ts)}</span>
            <span className={`proof-event-source proof-event-${event.tone}`}>{event.source}</span>
            <span className="proof-event-label">{event.label}</span>
            {event.mode ? <span className={`proof-event-mode proof-event-mode-${event.mode}`}>{event.mode}</span> : null}
          </div>
        )) : (
          <div className="proof-event proof-event-empty mono">
            contact, payment, and build timeline events will appear here.
          </div>
        )}
      </div>
    </section>
  );
}

function proofStages(detail, builderState) {
  const lead = detailLead(detail);
  const payment = detail?.payments?.[0];
  const leadStatus = lead.status || 'discovered';
  const paid = payment?.status === 'paid' || leadStatus === 'paid' || leadStatus === 'shipped';
  const awaitingPayment = leadStatus === 'awaiting_payment' || payment?.status === 'created';
  const shipped = leadStatus === 'shipped' || builderState.status === 'completed';
  const building = builderState.status === 'running';
  const blocked = builderState.authNeeded || builderState.status === 'blocked_auth';
  const failed = builderState.status === 'failed';

  return [
    { label: 'awaiting pay', state: awaitingPayment ? 'active' : paid || shipped ? 'done' : 'idle' },
    { label: 'paid', state: paid || shipped ? 'done' : 'idle' },
    { label: 'building', state: blocked ? 'blocked' : failed ? 'bad' : building ? 'active' : shipped ? 'done' : paid ? 'active' : 'idle' },
    { label: 'shipped', state: shipped ? 'done' : 'idle' }
  ];
}

function proofEvents(detail, builderState) {
  if (!detail) return [];
  const rows = [];
  for (const event of (detail.contactEvents || []).slice(0, 4)) {
    const meta = safeJson(event.metadata_json);
    const mode = contactEventMode(event, meta);
    rows.push({
      id: `contact:${event.id}`,
      ts: event.created_at,
      source: event.channel || 'contact',
      label: `${labelize(event.direction)} ${labelize(event.type)}`,
      tone: event.direction === 'inbound' ? 'warn' : 'good',
      mode
    });
  }
  for (const payment of (detail.payments || []).slice(0, 2)) {
    rows.push({
      id: `payment:${payment.id}`,
      ts: payment.paid_at || payment.created_at,
      source: 'stripe',
      label: `${labelize(payment.status)} ${fmtPaymentAmount(payment.amount_cents)}`,
      tone: payment.status === 'paid' ? 'good' : 'warn',
      mode: paymentProofMode(payment).mode
    });
  }
  for (const item of [...(builderState.timeline || [])].slice(-4)) {
    rows.push({
      id: `builder:${item.id}`,
      ts: item.ts,
      source: 'browser use',
      label: item.summary || item.label,
      tone: item.status === 'completed' ? 'good' : item.status === 'failed' || item.status === 'blocked_auth' ? 'bad' : 'warn',
      mode: typeof item.mock === 'boolean' ? (item.mock ? 'mock' : 'live') : buildProofMode(builderState).mode
    });
  }
  for (const row of (detail.auditTimeline || []).slice(0, 6)) {
    const type = row.event_type || row.type || row.action || '';
    if (!/(payment|build|contact|call)/i.test(type)) continue;
    rows.push({
      id: `audit:${row.id || type}:${row.created_at || row.ts}`,
      ts: row.created_at || row.ts,
      source: row.worker || row.entity_type || 'timeline',
      label: labelize(type),
      tone: /blocked|failed|error/i.test(type) ? 'bad' : /paid|finished|created|started/i.test(type) ? 'good' : 'muted',
      mode: null
    });
  }
  return rows
    .filter((row) => row.ts)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 6);
}

function contactEventMode(event, meta = safeJson(event.metadata_json)) {
  if (meta?.mock || meta?.mockEmail) return 'mock';
  if (event.provider_id || meta?.provider_id) return 'live';
  return null;
}

function paymentProofMode(payment) {
  if (!payment) return { label: 'no invoice', tone: 'muted', mode: null };
  const raw = `${payment.stripe_invoice_id || ''} ${payment.stripe_session_id || ''} ${payment.payment_link_url || ''} ${payment.hosted_invoice_url || ''}`;
  const mode = /mock|demo/i.test(raw) ? 'mock' : 'live';
  if (payment.status === 'paid') return { label: 'paid', tone: 'good', mode };
  if (payment.status === 'created' || payment.status === 'open') return { label: 'invoice sent', tone: 'warn', mode };
  return { label: labelize(payment.status || 'invoice'), tone: 'muted', mode };
}

function buildProofMode(builderState) {
  const mock = (builderState.timeline || []).some((item) => item.mock === true) || String(builderState.liveUrl || '').startsWith('/api/');
  const mode = mock ? 'mock' : builderState.liveUrl || builderState.projectUrl ? 'live' : null;
  if (builderState.authNeeded) return { label: 'auth needed', tone: 'bad', mode };
  if (builderState.status === 'running') return { label: 'building', tone: 'warn', mode };
  if (builderState.status === 'completed') return { label: 'shipped', tone: 'good', mode };
  if (builderState.status === 'failed') return { label: 'build failed', tone: 'bad', mode };
  return { label: 'not built', tone: 'muted', mode };
}

function MemoryTab({ detail }) {
  const mem = detail?.memory;
  const lead = detailLead(detail);
  return (
    <div className="memtab memtab-overhaul">
      <div className="memtab-head">
        <div className="hd">supermemory</div>
        <div className="mono note">
          {lead.container_tag ? <>containerTag: <span className="accent">{lead.container_tag}</span></> : '// per-lead container will appear once research completes.'}
        </div>
      </div>
      <MemoryConsole leadId={lead.id} />
      <details className="memory-more">
        <summary>
          <span>research evidence + reasoning + supermemory docs</span>
          <span className="memory-more-toggle" />
        </summary>
        <div className="memory-more-body">
          <ResearchEvidencePanel detail={detail} />
          <ReasoningPanel detail={detail} />
          {mem ? (
            <>
              <MemoryDoc kind="profile"     doc={mem.business_profile?.[0] || mem.profile?.[0]}     defaultOpen />
              <MemoryDoc kind="pitch"       doc={mem.pitch?.[0]}       />
              <MemoryDoc kind="call_log"    doc={mem.call_transcript?.[0] || mem.call_log?.[0]}    />
              <MemoryDoc kind="post_mortem" doc={mem.call_analysis?.[0] || mem.post_mortem?.[0]} />
              <MemoryDoc kind="mail_thread" doc={mem.mail_thread?.[0]} />
            </>
          ) : <div className="mono note">// supermemory offline or no docs yet.</div>}
        </div>
      </details>
    </div>
  );
}

function ReasoningPanel({ detail }) {
  const traces = (detail?.reasoningTraces || []).slice(0, 8);
  return (
    <section className="reasoning-panel">
      <div className="reasoning-head">
        <div>
          <div className="hd">Gemini reasoning</div>
          <div className="reasoning-sub mono">{traces.length ? `${traces.length} recent structured decisions` : 'no structured decisions yet'}</div>
        </div>
        <span className={`reasoning-status reasoning-status-${traces.some((trace) => !trace.valid) ? 'bad' : traces.length ? 'good' : 'muted'}`}>
          {traces.some((trace) => !trace.valid) ? 'needs review' : traces.length ? 'valid schemas' : 'waiting'}
        </span>
      </div>
      {traces.length ? (
        <div className="reasoning-list">
          {traces.map((trace) => (
            <ReasoningTraceRow key={trace.id} trace={trace} />
          ))}
        </div>
      ) : (
        <div className="reasoning-empty mono">// pitch, analysis, mail policy, and build brief decisions will appear here.</div>
      )}
    </section>
  );
}

function ReasoningTraceRow({ trace }) {
  const output = trace.finalOutput || {};
  const confidence = output.confidence ?? output.onlinePresenceConfidence ?? output.presenceConfidence ?? null;
  const evidence = sourceEvidenceFor(output, trace.evidence).slice(0, 3);
  const summary = reasoningSummary(output);
  return (
    <details className={`reasoning-row reasoning-row-${trace.valid ? 'valid' : 'invalid'}`}>
      <summary>
        <span className="reasoning-schema mono">{trace.schemaName || trace.kind}</span>
        <span className={`reasoning-valid reasoning-valid-${trace.valid ? 'yes' : 'no'}`}>{trace.valid ? 'valid' : 'invalid'}</span>
        <span className="reasoning-meta mono">{confidence == null ? 'conf --' : `conf ${Math.round(confidence * 100)}%`} · repair {trace.repairAttempts || 0}</span>
      </summary>
      <div className="reasoning-body">
        <div className="reasoning-decision">{summary}</div>
        {trace.validationErrors?.length ? (
          <div className="reasoning-errors mono">{trace.validationErrors.join(' · ')}</div>
        ) : null}
        {evidence.length ? (
          <div className="reasoning-evidence">
            {evidence.map((item, index) => (
              <div key={`${trace.id}:evidence:${index}`} className="reasoning-evidence-item">
                <span className="mono">{item.source || 'evidence'}</span>
                <span>{item.quote || item}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function reasoningSummary(output = {}) {
  return output.reason ||
    output.offerAngle ||
    output.strategySummary ||
    output.brief ||
    output.onlinePresenceSummary ||
    output.decisionReason ||
    output.replyText ||
    output.nextBestAction?.reason ||
    'Structured decision recorded.';
}

function sourceEvidenceFor(output = {}, evidence = {}) {
  if (Array.isArray(output.sourceEvidence)) return output.sourceEvidence;
  if (Array.isArray(output.evidence)) return output.evidence;
  if (evidence?.lead?.source_url || evidence?.lead?.website) {
    return [{ source: evidence.lead.source_url || evidence.lead.website, quote: evidence.lead.business_name || 'lead evidence' }];
  }
  return [];
}

function ResearchEvidencePanel({ detail }) {
  if (!detail) {
    return (
      <section className="research-panel research-panel-muted">
        <div className="research-head">
          <div>
            <div className="hd">research evidence</div>
            <div className="research-title">loading lead evidence</div>
          </div>
          <span className="chip chip-callability chip-callability-muted">loading</span>
        </div>
      </section>
    );
  }
  if (detail.error) {
    return (
      <section className="research-panel research-panel-bad">
        <div className="research-head">
          <div>
            <div className="hd">research evidence</div>
            <div className="research-title">lead detail unavailable</div>
          </div>
          <span className="chip chip-callability chip-callability-bad">error</span>
        </div>
        <div className="research-item">
          <div className="research-key mono">detail error</div>
          <div className="research-value mono">{detail.error}</div>
        </div>
      </section>
    );
  }
  const lead = detailLead(detail);
  const profile = profileFromDetail(detail);
  const presence = presenceFromEvidence(lead, profile);
  const callability = explainCallability(lead, profile);
  const sources = sourceCandidates(lead, profile);
  const businessName = profile?.businessName || lead.business_name || 'focused lead';
  const summary = profile?.onlinePresenceSummary || (
    profile?.hasWebsite === false
      ? 'No owned website was found in the research evidence.'
      : presence ? `${labelize(presence)} online presence evidence recorded.` : 'No online presence summary recorded yet.'
  );
  const sourceRows = sources.length ? sources : [{ label: 'source', url: null }];
  const signals = (profile?.signals || []).slice(0, 5);
  const needs = (profile?.needs || []).slice(0, 4);

  return (
    <section className={`research-panel research-panel-${callability.tone}`}>
      <div className="research-head">
        <div>
          <div className="hd">research evidence</div>
          <div className="research-title">{businessName}</div>
        </div>
        <div className="research-badges">
          <span className={`chip chip-presence-${presence || 'unknown'}`}>{presence || 'unknown'} presence</span>
          <span className={`chip chip-callability chip-callability-${callability.tone}`}>{callability.label}</span>
        </div>
      </div>

      {callability.tone === 'stop' ? (
        <div className="research-stop">
          <div className="research-stop-title">strong presence · not worth calling</div>
          <div className="research-stop-copy">{callability.explanation}</div>
        </div>
      ) : null}

      <div className="research-grid">
        <div className="research-item">
          <div className="research-key mono">presence evidence</div>
          <div className="research-value">{summary}</div>
        </div>
        <div className="research-item">
          <div className="research-key mono">callability</div>
          <div className="research-value">{callability.explanation}</div>
        </div>
        <div className="research-item">
          <div className="research-key mono">source URL</div>
          <div className="research-sources">
            {sourceRows.map(({ label, url }) => (
              <div className="research-source-row" key={`${label}:${url || 'missing'}`}>
                <span className="research-source-label mono">{label}</span>
                {url ? (
                  isExternalUrl(url) ? (
                    <a className="research-source-url mono" href={url} target="_blank" rel="noreferrer">{url}</a>
                  ) : (
                    <span className="research-source-url mono">{url}</span>
                  )
                ) : (
                  <span className="research-source-url research-source-missing mono">not recorded</span>
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="research-item">
          <div className="research-key mono">queue state</div>
          <div className="research-value mono">
            {labelize(lead.research_status || 'new')} · {labelize(lead.outreach_status || detail?.outreachStatus || 'not queued')} · {labelize(lead.next_action || 'no next action')}
          </div>
        </div>
      </div>

      {signals.length || needs.length ? (
        <div className="research-evidence-list">
          {signals.map((signal) => (
            <span key={`signal:${signal}`} className="lead-badge lead-badge-info">{signal}</span>
          ))}
          {needs.map((need) => (
            <span key={`need:${need}`} className="lead-badge lead-badge-muted">{need}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CallerTab({ detail, liveTranscript, liveCallId, liveCallActive }) {
  const calls = detail?.calls || [];
  const latestCall = calls[0];
  const pitchDoc = detail?.memory?.pitch?.[0];
  const pitch = parseDoc(pitchDoc);
  const mailEvents = useMemo(() => getMailEvents(detail), [detail]);
  const postMortem = useMemo(() => getPostMortem(detail), [detail]);
  const invoiceSignal = useMemo(() => invoiceEmailSignal(postMortem, mailEvents), [postMortem, mailEvents]);
  const questions = useMemo(() => uniqueQuestions(postMortem, mailEvents), [postMortem, mailEvents]);

  const [showPitch, setShowPitch] = useState(false);

  const liveMatch = latestCall && liveCallId && (latestCall.id === liveCallId || latestCall.provider_call_id === liveCallId);
  const showLive = liveTranscript.length > 0 && (liveCallActive || liveMatch);

  let turns = [];
  if (showLive) turns = liveTranscript;
  else if (latestCall?.transcript_json) {
    try {
      const parsed = JSON.parse(latestCall.transcript_json);
      turns = Array.isArray(parsed?.turns) ? parsed.turns : Array.isArray(parsed) ? parsed : [];
    } catch {}
  }

  return (
    <div className="callertab">
      <div className="callertab-head">
        <div className="hd">caller</div>
        <div className="callertab-meta mono">
          {latestCall ? (
            <>
              <span>{latestCall.id}</span>
              <span className="dot">·</span>
              <span>{latestCall.state}</span>
              {latestCall.outcome ? <><span className="dot">·</span><span>{latestCall.outcome}</span></> : null}
            </>
          ) : 'no calls yet'}
        </div>
      </div>
      <Transcript turns={turns} live={showLive} empty="// awaiting first turn." />
      <CallOutcomePanel
        latestCall={latestCall}
        postMortem={postMortem}
        invoiceSignal={invoiceSignal}
        questions={questions}
        liveCallActive={liveCallActive}
        showLive={showLive}
      />
      {pitch && (
        <div className={`pitch-aside ${showPitch ? 'open' : ''}`}>
          <button className="pitch-toggle mono" onClick={() => setShowPitch((v) => !v)}>
            {showPitch ? '− hide pitch' : '+ show pitch'}
          </button>
          {showPitch && (
            <div className="pitch-aside-body">
              <div className="pitch-line"><em>{pitch.openingLine}</em></div>
              <div className="pitch-line mono note">{pitch.valueProp}</div>
              <div className="pitch-line mono note">close: {pitch.close}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CallOutcomePanel({
  latestCall,
  postMortem,
  invoiceSignal,
  questions,
  liveCallActive,
  showLive
}) {
  const outcome = postMortem?.outcome || latestCall?.outcome || (liveCallActive ? 'in_progress' : 'unknown');
  const reason = postMortem?.reason || (showLive ? 'Live call is still capturing turns.' : 'No analyst post-mortem has been written yet.');
  const nextSteps = postMortem?.whatToTryNext || [];

  return (
    <section className="call-outcome-panel">
      <div className="call-outcome-head">
        <div>
          <div className="hd">call outcome</div>
          <div className="call-outcome-reason">{reason}</div>
        </div>
        <span className={`chip chip-outcome chip-${outcome}`}>{labelize(outcome)}</span>
      </div>
      <div className="call-outcome-grid">
        <div className="outcome-cell">
          <div className="outcome-key mono">invoice email confidence</div>
          <div className="outcome-value">
            <span className={`confidence confidence-${invoiceSignal.level}`}>{invoiceSignal.label}</span>
            <span className="mono outcome-email">{invoiceSignal.email}</span>
          </div>
          <div className="outcome-note">{invoiceSignal.source}</div>
        </div>
        <div className="outcome-cell">
          <div className="outcome-key mono">customer questions</div>
          {questions.length ? (
            <ul className="question-list">
              {questions.map((question) => <li key={question}>{question}</li>)}
            </ul>
          ) : (
            <div className="outcome-note">No customer questions captured yet.</div>
          )}
        </div>
      </div>
      {nextSteps.length ? (
        <div className="call-next">
          <div className="outcome-key mono">try next</div>
          <div className="call-next-list">
            {nextSteps.slice(0, 3).map((step) => <span key={step} className="lead-badge lead-badge-muted">{step}</span>)}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MossTab({ detail }) {
  const moss = detail?.moss;
  const index = moss?.index;
  const snippets = moss?.snippets || [];
  const retrievals = moss?.retrievals || [];
  const active = snippets.filter((snippet) => snippet.status !== 'dead');
  const dead = snippets.filter((snippet) => snippet.status === 'dead');
  const byKind = useMemo(() => {
    const groups = {};
    for (const snippet of active) {
      const kind = snippet.kind || 'snippet';
      groups[kind] = groups[kind] || [];
      groups[kind].push(snippet);
    }
    for (const rows of Object.values(groups)) {
      rows.sort((a, b) => (b.help_score - a.help_score) || (b.use_count - a.use_count) || (b.updated_at - a.updated_at));
    }
    return groups;
  }, [active]);

  if (!moss || !index) {
    return (
      <div className="empty-inspector">
        <div className="hd">moss hot context</div>
        <div className="mono note">// no Moss index yet. Run a call to build the hot path.</div>
      </div>
    );
  }

  return (
    <div className="callertab">
      <div className="callertab-head">
        <div>
          <div className="hd">moss hot context</div>
          <div className="callertab-meta mono">
            <span>{index.index_name}</span>
            <span className="dot">·</span>
            <span>{index.status}</span>
            <span className="dot">·</span>
            <span>{index.mode || 'mock'}</span>
          </div>
        </div>
        <span className={`chip chip-${index.status === 'ready' ? 'won' : 'unknown'}`}>
          {moss.activeCount || 0} active · {moss.deadCount || 0} dead
        </span>
      </div>

      <section className="call-outcome-panel">
        <div className="call-outcome-head">
          <div>
            <div className="hd">hot bundle</div>
            <div className="call-outcome-reason">Lead facts, pitch snippets, objections, compliance, pricing, and customer needs are indexed for the live turn.</div>
          </div>
          <span className="confidence confidence-high">no web search</span>
        </div>
        <div className="call-outcome-grid">
          {Object.entries(byKind).slice(0, 6).map(([kind, rows]) => (
            <div className="outcome-cell" key={kind}>
              <div className="outcome-key mono">{labelize(kind)}</div>
              <div className="call-next-list">
                {rows.slice(0, 3).map((snippet) => (
                  <span key={snippet.snippet_id} className="lead-badge lead-badge-muted">
                    {snippet.title || snippet.snippet_id}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="builder-log">
        <div className="section-head">
          <span className="hd">query timeline</span>
          <span className="mono note">{retrievals.length ? `${retrievals.length} retrievals` : 'empty'}</span>
        </div>
        <div className="builder-log-body mono">
          {retrievals.length ? retrievals.slice(0, 12).map((row) => (
            <div key={row.id} className={`builder-log-row builder-log-${row.outcome === 'error' ? 'failed' : row.result_count ? 'completed' : 'neutral'}`}>
              <span className="builder-log-time">{formatWhen(row.created_at)}</span>
              <span className="builder-log-text">
                {row.intent} · k={row.top_k} · a={Number(row.alpha).toFixed(2)} · {row.latency_ms}ms · {(row.snippetIds || []).join(', ') || 'no hit'}
              </span>
            </div>
          )) : (
            <div className="builder-log-empty">// live transcript retrievals will appear here.</div>
          )}
        </div>
      </section>

      <section className="build-timeline-panel">
        <div className="section-head">
          <span className="hd">snippet use / failure</span>
          <span className="mono note">{active.length + dead.length} snippets</span>
        </div>
        <div className="build-timeline">
          {[...active, ...dead].slice(0, 18).map((snippet) => (
            <div key={snippet.id} className="build-timeline-row">
              <span className={`build-timeline-dot build-timeline-${snippet.status === 'dead' ? 'failed' : snippet.use_count ? 'completed' : 'neutral'}`} />
              <div className="build-timeline-copy">
                <div className="build-timeline-main">
                  <span>{snippet.title || snippet.snippet_id}</span>
                  <span className="build-timeline-main-meta">
                    <span className={`timeline-mode timeline-mode-${snippet.status === 'dead' ? 'mock' : 'live'}`}>{snippet.status}</span>
                    <span className="mono note">used {snippet.use_count} · fail {snippet.failure_count} · score {Number(snippet.help_score || 0).toFixed(1)}</span>
                  </span>
                </div>
                <div className="build-timeline-summary">{snippet.text}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AnalystTab({ detail }) {
  const doc = detail?.memory?.call_analysis?.[0] || detail?.memory?.post_mortem?.[0];
  if (!doc) {
    return (
      <div className="empty-inspector">
        <div className="hd">analyst</div>
        <div className="mono note">// no post-mortem yet. Run a call.</div>
      </div>
    );
  }
  return (
    <div className="analysttab">
      <div className="hd">post-mortem</div>
      <MemoryDoc kind="post_mortem" doc={doc} defaultOpen />
    </div>
  );
}

function MailerTab({ detail }) {
  const payment = detail?.payments?.[0];
  const mailerRun = useMemo(() => (detail?.runs || []).find((r) => r.worker === 'mailer'), [detail]);
  const detailJson = useMemo(() => {
    if (!mailerRun?.detail_json) return null;
    try { return JSON.parse(mailerRun.detail_json); } catch { return null; }
  }, [mailerRun]);
  const threadId = detail?.latestThread?.threadId || detailJson?.threadId || detail?.lead?.agentmail_thread_id || '—';
  const invoiceUrl = payment?.hosted_invoice_url || payment?.payment_link_url;
  const mailEvents = useMemo(() => getMailEvents(detail), [detail]);
  const postMortem = useMemo(() => getPostMortem(detail), [detail]);
  const invoiceSignal = useMemo(() => invoiceEmailSignal(postMortem, mailEvents), [postMortem, mailEvents]);
  const questions = useMemo(() => uniqueQuestions(postMortem, mailEvents), [postMortem, mailEvents]);
  const flags = useMemo(() => mailFlags(mailEvents, detail?.lead), [mailEvents, detail]);
  const waitingCount = useMemo(() => replyWaitingCount(mailEvents), [mailEvents]);
  const invoiceProof = useMemo(() => invoiceProofFromEvents(mailEvents), [mailEvents]);

  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!invoiceUrl) return;
    navigator.clipboard?.writeText(invoiceUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  if (!payment) {
    return (
      <div className="empty-inspector">
        <div className="hd">mailer</div>
        <div className="mono note">// no invoice yet. Trigger AgentMail invoice.</div>
        <MailStatusPanel
          threadId={threadId}
          invoiceSignal={invoiceSignal}
          questions={questions}
          flags={flags}
          waitingCount={waitingCount}
          invoiceProof={invoiceProof}
        />
        <ThreadView events={mailEvents} waitingCount={waitingCount} />
      </div>
    );
  }

  const created = payment.status === 'created';
  return (
    <div className="mailertab">
      <div className="hd">agentmail invoice</div>
      <MailStatusPanel
        threadId={threadId}
        invoiceSignal={invoiceSignal}
        questions={questions}
        flags={flags}
        waitingCount={waitingCount}
        invoiceProof={invoiceProof}
      />
      <div className="paylink">
        <span className="chip chip-amount">{fmtPaymentAmount(payment.amount_cents)}</span>
        <a className="paylink-url mono" href={invoiceUrl} target="_blank" rel="noreferrer">
          {invoiceUrl}
        </a>
        <button className="btn btn-mini" onClick={copy}>{copied ? 'copied' : 'copy'}</button>
      </div>
      <div className="kv">
        <div className="kv-row">
          <div className="kv-key mono">thread</div>
          <div className="kv-val mono">{threadId}</div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">invoice</div>
          <div className="kv-val mono">{payment.stripe_invoice_id || payment.stripe_session_id || payment.id}</div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">payment row</div>
          <div className="kv-val mono">{invoiceProof.paymentId || payment.id}</div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">due</div>
          <div className="kv-val mono">{payment.due_at ? new Date(payment.due_at).toLocaleDateString() : '—'}</div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">pdf</div>
          <div className="kv-val mono">
            {payment.invoice_pdf_url || invoiceProof.invoicePdfUrl ? (
              <a href={payment.invoice_pdf_url || invoiceProof.invoicePdfUrl} target="_blank" rel="noreferrer">invoice pdf</a>
            ) : '—'}
          </div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">subject</div>
          <div className="kv-val">Your callan website invoice + meeting invite</div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">replies</div>
          <div className="kv-val">Customer replies stay in AgentMail so the agent can answer questions and keep the sale moving.</div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">ICS</div>
          <div className="kv-val mono">meeting.ics · meet.new · 30m · attached</div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">status</div>
          <div className="kv-val mono">
            <span className={`chip chip-pay-${payment.status}`}>{payment.status}</span>
            {invoiceProof.invoiceStatus && invoiceProof.invoiceStatus !== payment.status ? <span className="mono note"> stripe {invoiceProof.invoiceStatus}</span> : null}
          </div>
        </div>
      </div>
      {created && (
        <a className="btn btn-primary" href={invoiceUrl} target="_blank" rel="noreferrer">
          open invoice
        </a>
      )}
      <ThreadView events={mailEvents} waitingCount={waitingCount} />
    </div>
  );
}

function MailStatusPanel({
  threadId,
  invoiceSignal,
  questions,
  flags,
  waitingCount,
  invoiceProof
}) {
  return (
    <section className="mail-status-panel">
      <div className="mail-status-top">
        <div>
          <div className="hd">agentmail state</div>
          <div className="mail-thread-id mono">{threadId}</div>
        </div>
        <div className="mail-status-chips">
          <span className={`confidence confidence-${invoiceSignal.level}`}>{invoiceSignal.label}</span>
          <span className={`reply-count ${waitingCount ? 'reply-count-hot' : ''} mono`}>
            {waitingCount} waiting
          </span>
          {flags.map((flag) => (
            <span key={`${flag.text}:${flag.tone}`} className={`thread-flag thread-flag-${flag.tone}`}>{flag.text}</span>
          ))}
        </div>
      </div>
      <div className="mail-status-grid">
        <div className="mail-status-cell">
          <div className="outcome-key mono">invoice email</div>
          <div className="outcome-value">
            <span className="mono outcome-email">{invoiceSignal.email}</span>
          </div>
          <div className="outcome-note">{invoiceSignal.source}</div>
          {invoiceProof?.emailProofSource ? (
            <div className="outcome-note mono">
              proof: {invoiceProof.emailProofSource}{invoiceProof.consentEventId ? ` · consent ${invoiceProof.consentEventId}` : ''}
            </div>
          ) : null}
        </div>
        <div className="mail-status-cell">
          <div className="outcome-key mono">customer questions</div>
          {questions.length ? (
            <ul className="question-list">
              {questions.map((question) => <li key={question}>{question}</li>)}
            </ul>
          ) : (
            <div className="outcome-note">No open question captured in the call or thread.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function ThreadView({ events, waitingCount = 0 }) {
  if (!events.length) {
    return <div className="thread-empty mono">// no AgentMail conversation events yet.</div>;
  }
  return (
    <div className="thread-view">
      <div className="thread-title-row">
        <div className="thread-title mono">AgentMail thread</div>
        <span className={`reply-count ${waitingCount ? 'reply-count-hot' : ''} mono`}>{waitingCount} waiting</span>
      </div>
      {events.map((event) => {
        const meta = safeJson(event.metadata_json);
        const flags = eventFlags(event);
        const contact = event.direction === 'inbound' ? meta?.fromMasked : meta?.toMasked;
        const reason = meta?.classification?.reason;
        return (
          <div key={event.id} className={`thread-msg thread-${event.direction}`}>
            <div className="thread-meta mono">
              <span>{event.direction}</span>
              <span className="dot">·</span>
              <span>{labelize(event.type)}</span>
              <span className="dot">·</span>
              <span>{formatWhen(event.created_at)}</span>
              {contact ? <><span className="dot">·</span><span>{contact}</span></> : null}
            </div>
            {flags.length ? (
              <div className="thread-flags">
                {flags.map((flag) => (
                  <span key={`${event.id}:${flag.text}`} className={`thread-flag thread-flag-${flag.tone}`}>{flag.text}</span>
                ))}
              </div>
            ) : null}
            {event.subject ? <div className="thread-subject">{event.subject}</div> : null}
            {reason ? <div className="thread-reason mono">{reason}</div> : null}
            <div className="thread-body">{event.body || '—'}</div>
          </div>
        );
      })}
    </div>
  );
}

function BuilderTab({ detail, focusedLeadId, builderInfo, builderAction, onRetryBuild }) {
  const state = useMemo(
    () => mergeBuilderState(detail, builderInfo, focusedLeadId),
    [detail, builderInfo, focusedLeadId]
  );
  const [selectedTarget, setSelectedTarget] = useState(state.target || 'lovable');
  useEffect(() => {
    setSelectedTarget(state.target || 'lovable');
  }, [focusedLeadId, state.target]);
  const retrying = builderAction?.running && builderAction?.leadId === focusedLeadId;
  const actionError = builderAction?.leadId === focusedLeadId ? builderAction?.error : null;
  const previewUrl = state.liveUrl || state.finalSiteUrl || state.projectUrl;
  const finalUrl = state.finalSiteUrl || state.projectUrl;
  const isRunning = state.status === 'running';
  const buttonLabel = state.status === 'not_started' ? 'start build' : 'retry build';
  const mode = buildProofMode(state);
  const browserUse = browserUseStateFromBuild(state);

  return (
    <div className="buildertab">
      <div className="builder-console-head">
        <div>
          <div className="hd">builder</div>
          <div className="builder-headline">{builderStatusCopy(state.status)}</div>
        </div>
        <div className="builder-head-actions">
          <span className={`build-status build-status-${state.status}`}>{labelize(state.status)}</span>
          {state.authNeeded ? <span className="auth-badge mono">auth needed</span> : null}
          <select
            className="build-status"
            value={selectedTarget}
            disabled={retrying || isRunning}
            onChange={(e) => setSelectedTarget(e.target.value)}
            aria-label="Build target"
          >
            <option value="lovable">Lovable</option>
            <option value="v0">v0</option>
          </select>
          <button
            className="btn btn-mini"
            disabled={!focusedLeadId || retrying || isRunning}
            onClick={() => onRetryBuild?.({ target: selectedTarget })}
          >
            {retrying ? 'starting...' : buttonLabel}
          </button>
        </div>
      </div>

      <div className="builder-state-grid">
        <BuildStateCell label="target" value={state.target || selectedTarget} tone={state.target === 'v0' ? 'warn' : 'good'} />
        <BuildStateCell label="build id" value={state.latestBuildId || 'none'} />
        <BuildStateCell label="session id" value={browserUse.sessionId || 'none'} />
        <BuildStateCell label="model" value={browserUse.model || 'default'} />
        <BuildStateCell label="steps" value={browserUse.stepCount ?? 0} />
        <BuildStateCell label="cost" value={`$${browserUse.totalCostUsd || '0'}`} tone={browserUse.costCapped ? 'bad' : 'good'} />
        <BuildStateCell label="evidence" value={browserUse.evidenceCount ?? 0} />
        <BuildStateCell label="started" value={state.startedAt ? formatWhen(state.startedAt) : '—'} />
        <BuildStateCell label="finished" value={state.finishedAt ? formatWhen(state.finishedAt) : '—'} />
        <BuildStateCell label="Browser Use liveUrl" value={state.target === 'v0' ? 'not used' : state.liveUrl ? 'ready' : 'waiting'} tone={state.liveUrl ? 'good' : 'muted'} />
        <BuildStateCell label="operation" value={mode.mode || 'pending'} tone={mode.tone === 'bad' ? 'bad' : mode.tone === 'good' ? 'good' : mode.tone === 'warn' ? 'warn' : 'muted'} />
      </div>

      {actionError ? <div className="builder-error mono">{actionError}</div> : null}
      {state.error ? <div className="builder-error mono">{state.error}</div> : null}

      <BrowserUseBuildPanel state={browserUse} />
      <BuildQAConsole qa={detail?.builderQa} />

      <div className="final-site-row">
        <div className="final-site-label mono">final site URL</div>
        {finalUrl ? (
          <a className="final-site-url mono" href={finalUrl} target="_blank" rel="noreferrer">{finalUrl}</a>
        ) : (
          <span className="final-site-empty mono">not published yet</span>
        )}
      </div>

      <div className="final-site-row">
        <div className="final-site-label mono">submission</div>
        {state.submissionUrl ? (
          <a className="final-site-url mono" href={state.submissionUrl} target="_blank" rel="noreferrer">{state.submissionUrl}</a>
        ) : (
          <span className="final-site-empty mono">{state.target === 'v0' ? 'v0 API submission' : 'not created yet'}</span>
        )}
      </div>

      {previewUrl ? (
        <div className="frame-wrap">
          <iframe className="build-frame" src={previewUrl} title="Builder live preview" />
          <div className="frame-meta mono">{previewUrl}</div>
        </div>
      ) : (
        <div className="builder-preview-empty mono">
          // waiting for Browser Use live preview URL
        </div>
      )}

      <BuilderProgressLog items={state.progressLog} />
      <BuilderTimeline items={state.timeline} />

      {state.brief ? (
        <details className="brief">
          <summary className="mono">prompt preview sent to {state.target || selectedTarget}</summary>
          <pre className="raw mono">{state.brief}</pre>
        </details>
      ) : null}
    </div>
  );
}

function BrowserUseBuildPanel({ state }) {
  return (
    <section className="browser-build-panel">
      <div className="browser-build-head">
        <div>
          <div className="hd">Browser Use session</div>
          <div className="browser-build-summary">{state.lastStepSummary || 'No Browser Use step summary recorded yet.'}</div>
        </div>
        <div className="browser-build-badges">
          <span className={`browser-build-badge ${state.mock ? 'browser-build-badge-mock' : 'browser-build-badge-live'}`}>
            {state.mock ? 'mock' : 'live'}
          </span>
          {state.authNeeded ? <span className="browser-build-badge browser-build-badge-bad">auth-needed</span> : null}
          {state.costCapped ? <span className="browser-build-badge browser-build-badge-bad">cost-capped</span> : null}
        </div>
      </div>

      <div className="browser-build-grid">
        <BuildStateCell label="input tokens" value={state.totalInputTokens ?? 0} />
        <BuildStateCell label="output tokens" value={state.totalOutputTokens ?? 0} />
        <BuildStateCell label="llm cost" value={`$${state.llmCostUsd || '0'}`} />
        <BuildStateCell label="browser cost" value={`$${state.browserCostUsd || '0'}`} />
        <BuildStateCell label="proxy cost" value={`$${state.proxyCostUsd || '0'}`} />
        <BuildStateCell label="proxy MB" value={state.proxyUsedMb || '0'} />
      </div>

      <div className="browser-build-links mono">
        {state.liveUrl ? <a href={state.liveUrl} target="_blank" rel="noreferrer">liveUrl</a> : <span>liveUrl pending</span>}
        {state.screenshotUrl ? <a href={state.screenshotUrl} target="_blank" rel="noreferrer">screenshotUrl</a> : <span>screenshot pending</span>}
        {state.recordingUrls?.length ? <a href={state.recordingUrls[0]} target="_blank" rel="noreferrer">recording</a> : <span>recording pending</span>}
        {state.agentmailEmail ? <span>{state.agentmailEmail}</span> : null}
        {state.integrationsUsed?.length ? <span>{state.integrationsUsed.join(', ')}</span> : null}
      </div>
    </section>
  );
}

function BuildStateCell({ label, value, tone = 'default' }) {
  return (
    <div className="build-state-cell">
      <div className="build-state-label mono">{label}</div>
      <div className={`build-state-value build-state-${tone} mono`}>{value}</div>
    </div>
  );
}

function BuilderProgressLog({ items }) {
  return (
    <section className="builder-log">
      <div className="section-head">
        <span className="hd">progress log</span>
        <span className="mono note">{items.length ? `${items.length} updates` : 'empty'}</span>
      </div>
      <div className="builder-log-body mono">
        {items.length ? items.map((item) => (
          <div key={item.id} className={`builder-log-row builder-log-${item.status || 'neutral'}`}>
            <span className="builder-log-time">{formatWhen(item.ts)}</span>
            <span className="builder-log-text">{item.summary || item.label}</span>
          </div>
        )) : (
          <div className="builder-log-empty">// progress events will stream here when the build starts.</div>
        )}
      </div>
    </section>
  );
}

function BuilderTimeline({ items }) {
  return (
    <section className="build-timeline-panel">
      <div className="section-head">
        <span className="hd">build timeline</span>
        <span className="mono note">{items.length ? `${items.length} events` : 'empty'}</span>
      </div>
      <div className="build-timeline">
        {items.length ? items.map((item) => (
          <div key={item.id} className="build-timeline-row">
            <span className={`build-timeline-dot build-timeline-${item.status || 'neutral'}`} />
            <div className="build-timeline-copy">
              <div className="build-timeline-main">
                <span>{item.label}</span>
                <span className="build-timeline-main-meta">
                  {typeof item.mock === 'boolean' ? <span className={`timeline-mode timeline-mode-${item.mock ? 'mock' : 'live'}`}>{item.mock ? 'mock' : 'live'}</span> : null}
                  <span className="mono note">{formatWhen(item.ts)}</span>
                </span>
              </div>
              {item.summary ? <div className="build-timeline-summary">{item.summary}</div> : null}
              {item.projectUrl ? <a className="mono accent" href={item.projectUrl} target="_blank" rel="noreferrer">{item.projectUrl}</a> : null}
              {item.submissionUrl ? <a className="mono note" href={item.submissionUrl} target="_blank" rel="noreferrer">{item.submissionUrl}</a> : null}
              {item.liveUrl ? <span className="mono note">{item.liveUrl}</span> : null}
              {item.providerAction ? <span className="mono note">{item.target || 'target'} · {item.providerAction}</span> : null}
            </div>
          </div>
        )) : (
          <div className="build-timeline-empty mono">// no builder events recorded for this lead yet.</div>
        )}
      </div>
    </section>
  );
}

function mergeBuilderState(detail, builderInfo, focusedLeadId) {
  const read = detail?.builderState || {};
  const latest = detail?.builds?.[0] || {};
  const local = builderInfo?.leadId === focusedLeadId ? builderInfo : null;
  const timeline = mergeBuilderRows([
    ...(read.timeline || []),
    ...timelineFromLatest(latest),
    ...(local?.timeline || [])
  ]);
  const progressLog = mergeBuilderRows([
    ...(read.progressLog || []).map(normalizeProgressItem),
    ...(local?.progressLog || []),
    ...timeline.filter((item) => ['builder.submission_created', 'builder.provider_action', 'builder.progress', 'builder.live_url', 'builder.project_url', 'builder.blocked_auth', 'builder.done', 'builder.error'].includes(item.type))
  ]).slice(-12);
  const rawStatus = local?.status && local.status !== 'not_started'
    ? local.status
    : read.status || latest.status || statusFromTimeline(timeline) || 'not_started';
  const status = normalizeBuilderStatus(rawStatus);
  const projectUrl = local?.projectUrl || read.projectUrl || latest.project_url || null;

  return {
    status,
    authNeeded: status === 'blocked_auth' || read.authNeeded,
    latestBuildId: local?.buildId || read.latestBuildId || latest.id || null,
    sessionId: local?.sessionId || read.sessionId || latest.browser_session_id || lastValue(timeline, 'sessionId'),
    model: local?.model || read.model || lastValue(timeline, 'model'),
    stepCount: local?.stepCount ?? read.stepCount ?? lastNumber(timeline, 'stepCount'),
    lastStepSummary: local?.lastStepSummary || read.lastStepSummary || lastValue(timeline, 'lastStepSummary') || lastValue(timeline, 'summary'),
    screenshotUrl: local?.screenshotUrl || read.screenshotUrl || lastValue(timeline, 'screenshotUrl'),
    recordingUrls: local?.recordingUrls?.length ? local.recordingUrls : read.recordingUrls?.length ? read.recordingUrls : lastArray(timeline, 'recordingUrls'),
    maxCostUsd: local?.maxCostUsd || read.maxCostUsd || lastValue(timeline, 'maxCostUsd'),
    totalInputTokens: local?.totalInputTokens ?? read.totalInputTokens ?? lastNumber(timeline, 'totalInputTokens'),
    totalOutputTokens: local?.totalOutputTokens ?? read.totalOutputTokens ?? lastNumber(timeline, 'totalOutputTokens'),
    proxyUsedMb: local?.proxyUsedMb || read.proxyUsedMb || lastValue(timeline, 'proxyUsedMb'),
    llmCostUsd: local?.llmCostUsd || read.llmCostUsd || lastValue(timeline, 'llmCostUsd'),
    proxyCostUsd: local?.proxyCostUsd || read.proxyCostUsd || lastValue(timeline, 'proxyCostUsd'),
    browserCostUsd: local?.browserCostUsd || read.browserCostUsd || lastValue(timeline, 'browserCostUsd'),
    totalCostUsd: local?.totalCostUsd || read.totalCostUsd || lastValue(timeline, 'totalCostUsd'),
    agentmailEmail: local?.agentmailEmail || read.agentmailEmail || lastValue(timeline, 'agentmailEmail'),
    integrationsUsed: local?.integrationsUsed?.length ? local.integrationsUsed : read.integrationsUsed?.length ? read.integrationsUsed : lastArray(timeline, 'integrationsUsed'),
    evidenceCount: local?.evidenceCount ?? read.evidenceCount ?? lastNumber(timeline, 'evidenceCount'),
    outputSchema: local?.outputSchema || read.outputSchema || lastValue(timeline, 'outputSchema'),
    target: local?.target || read.target || latest.target || lastValue(timeline, 'target') || 'lovable',
    submissionUrl: local?.submissionUrl || read.submissionUrl || latest.submission_url || latest.lovable_url || lastValue(timeline, 'submissionUrl'),
    providerProjectId: local?.providerProjectId || read.providerProjectId || latest.provider_project_id || lastValue(timeline, 'providerProjectId'),
    providerDeploymentId: local?.providerDeploymentId || read.providerDeploymentId || latest.provider_deployment_id || lastValue(timeline, 'providerDeploymentId'),
    startedAt: read.startedAt || latest.started_at || firstTimelineTs(timeline),
    finishedAt: read.finishedAt || latest.finished_at || terminalTimelineTs(timeline),
    liveUrl: local?.liveUrl || read.liveUrl || latest.live_url || null,
    projectUrl,
    finalSiteUrl: local?.finalSiteUrl || read.finalSiteUrl || projectUrl || (detail?.lead?.status === 'shipped' ? detail?.lead?.website : null),
    error: local?.error || read.error || latest.error || null,
    brief: local?.brief || read.brief || latest.brief || null,
    progressLog,
    timeline
  };
}

function normalizeProgressItem(item) {
  return {
    id: item.id || `${item.type || 'progress'}:${item.ts}:${item.text || item.summary}`,
    ts: item.ts,
    type: item.type || 'builder.progress',
    label: item.label || 'Progress update',
    status: item.status || (item.type === 'builder.error' ? 'failed' : 'running'),
    summary: item.summary || item.text || '',
    sessionId: item.sessionId || null,
    model: item.model || null,
    stepCount: item.stepCount ?? null,
    lastStepSummary: item.lastStepSummary || null,
    screenshotUrl: item.screenshotUrl || null,
    recordingUrls: item.recordingUrls || [],
    totalCostUsd: item.totalCostUsd || null,
    evidenceCount: item.evidenceCount ?? null,
    target: item.target || null,
    submissionUrl: item.submissionUrl || null,
    providerProjectId: item.providerProjectId || null,
    providerDeploymentId: item.providerDeploymentId || null
  };
}

function timelineFromLatest(latest) {
  if (!latest?.id) return [];
  const rows = [{
    id: `${latest.id}:started`,
    ts: latest.started_at,
    type: 'builder.start',
    label: 'Build requested',
    status: 'running',
    summary: latest.live_url ? 'Build record opened with a live preview.' : 'Build record opened.',
    buildId: latest.id,
    target: latest.target || null,
    submissionUrl: latest.submission_url || latest.lovable_url || null,
    providerProjectId: latest.provider_project_id || null,
    providerDeploymentId: latest.provider_deployment_id || null,
    sessionId: latest.browser_session_id || null,
    liveUrl: latest.live_url || null
  }];
  if (latest.finished_at && latest.status !== 'running') {
    const status = normalizeBuilderStatus(latest.status);
    rows.push({
      id: `${latest.id}:finished:${status}`,
      ts: latest.finished_at,
      type: status === 'blocked_auth' ? 'builder.blocked_auth' : status === 'failed' ? 'builder.error' : 'builder.done',
      label: status === 'blocked_auth' ? 'Lovable auth needed' : status === 'failed' ? 'Build failed' : 'Build completed',
      status,
      summary: latest.error || latest.project_url || '',
      projectUrl: latest.project_url || null,
      target: latest.target || null,
      providerProjectId: latest.provider_project_id || null,
      providerDeploymentId: latest.provider_deployment_id || null,
      buildId: latest.id
    });
  }
  return rows.filter((row) => row.ts);
}

function mergeBuilderRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!row) continue;
    const id = row.id || `${row.type || 'builder.event'}:${row.ts}:${row.summary || row.text || ''}`;
    if (!byId.has(id)) byId.set(id, { ...row, id });
  }
  return [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

function statusFromTimeline(timeline) {
  for (const item of [...timeline].reverse()) {
    if (item.status) return normalizeBuilderStatus(item.status);
  }
  return null;
}

function normalizeBuilderStatus(status) {
  if (status === 'queued' || status === 'starting') return 'running';
  if (status?.startsWith?.('failed')) return 'failed';
  return status || 'not_started';
}

function browserUseStateFromBuild(state) {
  const maxCost = Number(state.maxCostUsd || 0);
  const totalCost = Number(state.totalCostUsd || 0);
  const mock = (state.timeline || []).some((item) => item.mock === true) || String(state.liveUrl || '').startsWith('/api/');
  return {
    sessionId: state.sessionId || state.latestBuildId,
    model: state.model,
    status: state.status,
    authNeeded: state.authNeeded || state.status === 'blocked_auth',
    mock,
    liveUrl: state.liveUrl,
    screenshotUrl: state.screenshotUrl,
    recordingUrls: state.recordingUrls || [],
    stepCount: state.stepCount ?? 0,
    lastStepSummary: state.lastStepSummary,
    maxCostUsd: state.maxCostUsd,
    costCapped: Boolean(maxCost && totalCost >= maxCost),
    totalInputTokens: state.totalInputTokens ?? 0,
    totalOutputTokens: state.totalOutputTokens ?? 0,
    proxyUsedMb: state.proxyUsedMb || '0',
    llmCostUsd: state.llmCostUsd || '0',
    proxyCostUsd: state.proxyCostUsd || '0',
    browserCostUsd: state.browserCostUsd || '0',
    totalCostUsd: state.totalCostUsd || '0',
    agentmailEmail: state.agentmailEmail,
    integrationsUsed: state.integrationsUsed || [],
    evidenceCount: state.evidenceCount ?? 0,
    outputSchema: state.outputSchema
  };
}

function firstTimelineTs(timeline) {
  return timeline.length ? timeline[0].ts : null;
}

function terminalTimelineTs(timeline) {
  const terminal = [...timeline].reverse().find((item) => ['completed', 'failed', 'blocked_auth', 'stopped'].includes(item.status));
  return terminal?.ts || null;
}

function lastValue(timeline, key) {
  for (const item of [...timeline].reverse()) {
    if (item[key]) return item[key];
  }
  return null;
}

function lastNumber(timeline, key) {
  for (const item of [...timeline].reverse()) {
    const n = Number(item[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function lastArray(timeline, key) {
  for (const item of [...timeline].reverse()) {
    if (Array.isArray(item[key]) && item[key].length) return item[key];
  }
  return [];
}

function builderStatusCopy(status) {
  switch (status) {
    case 'running': return 'Build is running and the live preview should stay visible.';
    case 'completed': return 'Build completed; final site URL is ready.';
    case 'failed': return 'Build failed; retry keeps the operator in the same flow.';
    case 'blocked_auth': return 'Lovable authentication is blocking the browser task.';
    case 'stopped': return 'Browser Use session was stopped by the operator.';
    default: return 'No build has started for this lead yet.';
  }
}
