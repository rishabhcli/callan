import React, { useEffect, useMemo, useRef } from 'react';

function tsToClock(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function normalizeRole(role) {
  if (['user', 'customer', 'owner', 'human'].includes(role)) return 'user';
  return 'agent';
}

function roleLabel(role) {
  return normalizeRole(role) === 'agent' ? 'agent' : 'owner';
}

export default function Transcript({ turns, live, empty }) {
  const tailRef = useRef(null);
  const transcriptTurns = Array.isArray(turns) ? turns : [];
  const stats = useMemo(() => {
    let agent = 0;
    let user = 0;
    for (const turn of transcriptTurns) {
      if (normalizeRole(turn.role) === 'agent') agent += 1;
      else user += 1;
    }
    const last = transcriptTurns[transcriptTurns.length - 1];
    return { agent, user, lastRole: last ? roleLabel(last.role) : null };
  }, [transcriptTurns]);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [transcriptTurns.length]);

  if (transcriptTurns.length === 0) {
    return (
      <div className={`transcript-empty mono ${live ? 'transcript-empty-live' : ''}`}>
        <span>{empty || '// no transcript yet.'}</span>
        {live ? <span className="live-dot" /> : null}
      </div>
    );
  }

  return (
    <div className={`transcript ${live ? 'transcript-live' : ''}`}>
      <div className="transcript-head">
        <div className="transcript-title">
          <span className="hd">transcript</span>
          <span className="transcript-state mono">{live ? 'live capture' : 'recorded'}</span>
        </div>
        <span className="hd-meta mono">
          {transcriptTurns.length} {transcriptTurns.length === 1 ? 'turn' : 'turns'}
          <span>· A {stats.agent}</span>
          <span>· O {stats.user}</span>
          {live ? <span className="live-dot" /> : null}
        </span>
      </div>
      {live ? (
        <div className="transcript-livebar mono">
          <span>listening</span>
          <span>last speaker: {stats.lastRole || '—'}</span>
        </div>
      ) : null}
      <div className="transcript-body">
        {transcriptTurns.map((turn, i) => {
          const role = normalizeRole(turn.role);
          return (
            <div key={i} className={`bubble bubble-${role}`}>
              <div className="bubble-meta mono">
                <span className="bubble-role">{role === 'agent' ? 'A' : 'U'}</span>
                <span className="bubble-speaker">{roleLabel(turn.role)}</span>
                <span className="bubble-time">{tsToClock(turn.ts)}</span>
                <span className="bubble-index">#{String(i + 1).padStart(2, '0')}</span>
              </div>
              <div className="bubble-text">{turn.text}</div>
            </div>
          );
        })}
        {live ? <div className="transcript-tail mono">waiting for next turn…</div> : null}
        <div ref={tailRef} />
      </div>
    </div>
  );
}
