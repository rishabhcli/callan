import React, { useEffect, useMemo, useRef } from 'react';

/**
 * Renders next to the 3D scene in the Operations stage so the operator can
 * watch inbound call/email intake, extracted facts, and research evidence.
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

  const demo = inbound.demoMode ? inbound.demoTarget : null;
  const isEmail = inbound.channel === 'email';
  const pulseClass = demo
    ? 'is-demo'
    : inbound.active ? 'is-live' : 'is-done';
  const eyebrowText = demo
    ? 'DEMO MODE — outbound cold-call simulation'
    : isEmail ? 'inbound email session'
      : inbound.active ? 'live inbound call' : 'last inbound call';
  const titleText = demo
    ? `${demo.business} · ${demo.owner}`
    : (inbound.callerName || inbound.subject || maskPhone(inbound.fromNumber) || inbound.email || 'Inbound customer');

  return (
    <div className={`nyna-inbound-panel${demo ? ' is-demo' : ''}`}>
      <header className="nyna-inbound-head">
        <div className="nyna-inbound-head-left">
          <div className={`nyna-inbound-pulse ${pulseClass}`} />
          <div>
            <div className="nyna-inbound-eyebrow">{eyebrowText}</div>
            <div className="nyna-inbound-title">{titleText}</div>
          </div>
        </div>
        <div className="nyna-inbound-meta">
          <div className="nyna-inbound-clock">{minutes}:{seconds}</div>
          <button className="nyna-inbound-close" onClick={onClose}>dismiss</button>
        </div>
      </header>

      {demo ? (
        <div className="nyna-inbound-banner is-demo">
          <span className="nyna-inbound-banner-eyebrow">pitching</span>
          <span className="nyna-inbound-banner-body">
            {[
              demo.business ? demo.business : null,
              demo.neighborhood ? demo.neighborhood : null,
              demo.website ? demo.website : null
            ].filter(Boolean).join(' · ')}
            {Array.isArray(demo.weaknesses) && demo.weaknesses.length ? (
              <span className="nyna-inbound-banner-sub">
                {demo.weaknesses.slice(0, 3).map((w, i) => (
                  <span key={i} className="nyna-inbound-banner-bullet">{w}</span>
                ))}
              </span>
            ) : null}
          </span>
        </div>
      ) : inbound.context?.returning ? (
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
      ) : isEmail && (inbound.threadId || inbound.email) ? (
        <div className="nyna-inbound-banner">
          <span className="nyna-inbound-banner-eyebrow">thread</span>
          <span className="nyna-inbound-banner-body">
            {[inbound.email, inbound.threadId, inbound.subject].filter(Boolean).join(' · ')}
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
            <span className="nyna-inbound-col-eyebrow">intake state</span>
            <span className="nyna-inbound-col-count">{inbound.readyForQuote ? 'quote ready' : `${inbound.requiredMissingFields?.length || 0} needed`}</span>
          </div>
          <div className="nyna-inbound-research">
            {inbound.facts ? (
              <div className="nyna-inbound-facts">
                <div className="nyna-inbound-fact-grid">
                  {factRows(inbound.facts).map((row) => (
                    <div key={row.key} className="nyna-inbound-fact">
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                    </div>
                  ))}
                </div>
                <div className="nyna-inbound-next">
                  <span>next</span>
                  <strong>{inbound.nextQuestion || inbound.nextAction || 'ready'}</strong>
                </div>
                {inbound.requiredMissingFields?.length ? (
                  <div className="nyna-inbound-missing">
                    {inbound.requiredMissingFields.map((field) => (
                      <span key={field}>{fieldLabel(field)}</span>
                    ))}
                  </div>
                ) : null}
                {inbound.portalUrl ? (
                  <a className="nyna-inbound-link" href={inbound.portalUrl} target="_blank" rel="noreferrer">
                    portal
                  </a>
                ) : null}
                {inbound.invoiceUrl ? (
                  <a className="nyna-inbound-link is-invoice" href={inbound.invoiceUrl} target="_blank" rel="noreferrer">
                    quote
                  </a>
                ) : null}
              </div>
            ) : null}
            <div className="nyna-inbound-col-head is-inline">
              <span className="nyna-inbound-col-eyebrow">live research</span>
              <span className="nyna-inbound-col-count">{inbound.evidence?.length || 0} captures</span>
            </div>
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

function factRows(facts) {
  const rows = [
    ['businessName', 'business', facts.businessName],
    ['niche', 'niche', facts.niche],
    ['city', 'city', facts.city],
    ['phone', 'phone', facts.phone],
    ['email', 'email', facts.email],
    ['services', 'services', Array.isArray(facts.services) ? facts.services.slice(0, 3).join(', ') : null],
    ['desiredCta', 'cta', facts.desiredCta],
    ['hours', 'hours', facts.hours]
  ];
  return rows
    .filter(([, , value]) => value)
    .map(([key, label, value]) => ({ key, label, value }));
}

function fieldLabel(field) {
  return String(field || '')
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase();
}
