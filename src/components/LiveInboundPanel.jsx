import React, { useEffect, useMemo, useRef } from 'react';

/**
 * Shown only when an inbound call is active.
 * Renders next to the 3D scene in the Operations stage so the operator can
 * watch transcripts stream in AND see research evidence land in parallel.
 */
export default function LiveInboundPanel({ inbound, onClose }) {
  const transcriptEndRef = useRef(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [inbound?.transcript?.length]);

  if (!inbound) return null;

  const ringingMs = inbound.startedAt ? Date.now() - inbound.startedAt : 0;
  const minutes = Math.floor(ringingMs / 60000);
  const seconds = Math.floor((ringingMs % 60000) / 1000).toString().padStart(2, '0');

  return (
    <div className="nyna-inbound-panel">
      <header className="nyna-inbound-head">
        <div className="nyna-inbound-head-left">
          <div className={`nyna-inbound-pulse ${inbound.active ? 'is-live' : 'is-done'}`} />
          <div>
            <div className="nyna-inbound-eyebrow">{inbound.active ? 'live inbound call' : 'last inbound call'}</div>
            <div className="nyna-inbound-title">{inbound.callerName || maskPhone(inbound.fromNumber) || 'Inbound caller'}</div>
          </div>
        </div>
        <div className="nyna-inbound-meta">
          <div className="nyna-inbound-clock">{minutes}:{seconds}</div>
          <button className="nyna-inbound-close" onClick={onClose}>dismiss</button>
        </div>
      </header>

      {inbound.context?.returning ? (
        <div className="nyna-inbound-banner">
          <span className="nyna-inbound-banner-eyebrow">returning caller</span>
          <span className="nyna-inbound-banner-body">
            {[
              inbound.context.context?.name ? `name: ${inbound.context.context.name}` : null,
              inbound.context.context?.email ? `email: ${inbound.context.context.email}` : null,
              inbound.context.context?.business ? `business: ${inbound.context.context.business}` : null,
              inbound.context.context?.hitCount ? `${inbound.context.context.hitCount} prior memories` : null
            ].filter(Boolean).join(' · ') || 'context loaded from supermemory'}
          </span>
        </div>
      ) : null}

      <div className="nyna-inbound-cols">
        <section className="nyna-inbound-col">
          <div className="nyna-inbound-col-head">
            <span className="nyna-inbound-col-eyebrow">transcript</span>
            <span className="nyna-inbound-col-count">{inbound.transcript?.length || 0} turns</span>
          </div>
          <div className="nyna-inbound-transcript">
            {(inbound.transcript || []).map((t, i) => (
              <div key={`${t.ts || i}:${i}`} className={`nyna-turn nyna-turn-${t.role || 'user'}`}>
                <span className="nyna-turn-role">{t.role === 'agent' ? 'callan' : 'caller'}</span>
                <span className="nyna-turn-text">{t.text}</span>
              </div>
            ))}
            {inbound.active && (!inbound.transcript || inbound.transcript.length === 0) ? (
              <div className="nyna-turn-placeholder">listening for the first words…</div>
            ) : null}
            <div ref={transcriptEndRef} />
          </div>
        </section>

        <section className="nyna-inbound-col">
          <div className="nyna-inbound-col-head">
            <span className="nyna-inbound-col-eyebrow">live research</span>
            <span className="nyna-inbound-col-count">{inbound.evidence?.length || 0} captures</span>
          </div>
          <div className="nyna-inbound-research">
            {(inbound.lanes || []).map((lane) => (
              <div key={lane.lane} className={`nyna-research-lane nyna-research-lane-${lane.status}`}>
                <span className="nyna-research-lane-dot" />
                <span className="nyna-research-lane-label">{lane.label}</span>
                <span className="nyna-research-lane-status">{lane.status}</span>
              </div>
            ))}
            {(inbound.evidence || []).slice().reverse().slice(0, 10).map((ev, i) => (
              <div key={`${ev.lane}:${ev.capturedAt || i}`} className="nyna-research-evidence">
                <span className="nyna-research-evidence-lane">{ev.lane}</span>
                <span className="nyna-research-evidence-summary">{ev.summary}</span>
              </div>
            ))}
            {inbound.email ? (
              <div className="nyna-research-evidence is-mail">
                <span className="nyna-research-evidence-lane">mailer</span>
                <span className="nyna-research-evidence-summary">
                  sent followup to <strong>{inbound.email}</strong>
                </span>
              </div>
            ) : null}
            {(!inbound.lanes || inbound.lanes.length === 0) ? (
              <div className="nyna-turn-placeholder">waiting on call.started…</div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function maskPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 7) return p;
  return `(${digits.slice(-10, -7) || '—'}) ${digits.slice(-7, -4)} ${digits.slice(-4)}`;
}
