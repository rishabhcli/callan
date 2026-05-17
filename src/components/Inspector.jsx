import React, { useMemo, useState } from 'react';
import Transcript from './Transcript.jsx';
import MemoryDoc from './MemoryDoc.jsx';

const TABS = ['Memory', 'Caller', 'Analyst', 'Mailer', 'Builder'];

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

export default function Inspector({
  activeTab,
  setActiveTab,
  focusedLeadId,
  leadDetail,
  liveTranscript,
  liveCallId,
  liveCallActive,
  builderInfo
}) {
  return (
    <div className="inspector">
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
        <div className="inspector-id mono">
          {focusedLeadId || '— no lead focused —'}
        </div>
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
            {activeTab === 'Analyst' && <AnalystTab detail={leadDetail} />}
            {activeTab === 'Mailer'  && <MailerTab detail={leadDetail} />}
            {activeTab === 'Builder' && <BuilderTab detail={leadDetail} builderInfo={builderInfo} />}
          </>
        )}
      </div>
    </div>
  );
}

function MemoryTab({ detail }) {
  const mem = detail?.memory;
  if (!mem) {
    return (
      <div className="memtab-empty">
        <div className="hd">memory</div>
        <div className="mono note">// supermemory offline or no docs yet.</div>
      </div>
    );
  }
  return (
    <div className="memtab">
      <div className="memtab-head">
        <div className="hd">supermemory</div>
        <div className="mono note">containerTag: <span className="accent">{detail.lead.container_tag}</span></div>
      </div>
      <MemoryDoc kind="profile"     doc={mem.profile?.[0]}     defaultOpen />
      <MemoryDoc kind="pitch"       doc={mem.pitch?.[0]}       />
      <MemoryDoc kind="call_log"    doc={mem.call_log?.[0]}    />
      <MemoryDoc kind="post_mortem" doc={mem.post_mortem?.[0]} />
      <MemoryDoc kind="mail_thread" doc={mem.mail_thread?.[0]} />
    </div>
  );
}

function CallerTab({ detail, liveTranscript, liveCallId, liveCallActive }) {
  const calls = detail?.calls || [];
  const latestCall = calls[0];
  const pitchDoc = detail?.memory?.pitch?.[0];
  const pitch = parseDoc(pitchDoc);

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

function AnalystTab({ detail }) {
  const doc = detail?.memory?.post_mortem?.[0];
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
  const mailEvents = useMemo(
    () => (detail?.contactEvents || []).filter((e) => e.channel === 'agentmail').slice().reverse(),
    [detail]
  );

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
        <ThreadView events={mailEvents} />
      </div>
    );
  }

  const created = payment.status === 'created';
  return (
    <div className="mailertab">
      <div className="hd">agentmail invoice</div>
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
          <div className="kv-key mono">due</div>
          <div className="kv-val mono">{payment.due_at ? new Date(payment.due_at).toLocaleDateString() : '—'}</div>
        </div>
        <div className="kv-row">
          <div className="kv-key mono">subject</div>
          <div className="kv-val">Your callmemaybe website invoice + meeting invite</div>
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
          </div>
        </div>
      </div>
      {created && (
        <a className="btn btn-primary" href={invoiceUrl} target="_blank" rel="noreferrer">
          open invoice
        </a>
      )}
      <ThreadView events={mailEvents} />
    </div>
  );
}

function ThreadView({ events }) {
  if (!events.length) {
    return <div className="thread-empty mono">// no AgentMail conversation events yet.</div>;
  }
  return (
    <div className="thread-view">
      <div className="thread-title mono">AgentMail thread</div>
      {events.map((event) => (
        <div key={event.id} className={`thread-msg thread-${event.direction}`}>
          <div className="thread-meta mono">
            <span>{event.direction}</span>
            <span className="dot">·</span>
            <span>{event.type.replace(/_/g, ' ')}</span>
            <span className="dot">·</span>
            <span>{new Date(event.created_at).toLocaleTimeString()}</span>
          </div>
          {event.subject ? <div className="thread-subject">{event.subject}</div> : null}
          <div className="thread-body">{event.body}</div>
        </div>
      ))}
    </div>
  );
}

function BuilderTab({ detail, builderInfo }) {
  const buildRows = detail?.builds || [];
  const latest = buildRows[0];
  const liveUrl = builderInfo?.liveUrl || latest?.live_url;
  const projectUrl = builderInfo?.projectUrl || latest?.project_url;
  const brief = builderInfo?.brief;
  const blockedAuth = latest?.status === 'blocked_auth';

  if (!liveUrl && !projectUrl) {
    return (
      <div className="empty-inspector">
        <div className="hd">builder</div>
        <div className="mono note">// no build yet. Complete payment or click Build on a lead.</div>
      </div>
    );
  }

  return (
    <div className="buildertab">
      <div className="hd-row">
        <div className="hd">live build</div>
        <div className="mono note">
          {blockedAuth ? (
            <span className="chip chip-pay-failed">auth needed</span>
          ) : projectUrl ? (
            <a className="accent" href={projectUrl} target="_blank" rel="noreferrer">open site →</a>
          ) : 'building…'}
        </div>
      </div>
      {liveUrl ? (
        <div className="frame-wrap">
          <iframe className="build-frame" src={liveUrl} title="lovable build preview" />
          <div className="frame-meta mono">{liveUrl}</div>
        </div>
      ) : (
        <div className="empty-inspector mono note">// awaiting browser-use session…</div>
      )}
      {brief && (
        <details className="brief">
          <summary className="mono">brief sent to lovable</summary>
          <pre className="raw mono">{brief}</pre>
        </details>
      )}
    </div>
  );
}
