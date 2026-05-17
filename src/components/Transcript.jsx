import React, { useEffect, useRef } from 'react';

function tsToClock(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

export default function Transcript({ turns, live, empty }) {
  const tailRef = useRef(null);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [turns.length]);

  if (!turns || turns.length === 0) {
    return <div className="transcript-empty mono">{empty || '// no transcript yet.'}</div>;
  }

  return (
    <div className="transcript">
      <div className="transcript-head">
        <span className="hd">transcript</span>
        <span className="hd-meta mono">
          {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
          {live ? <span className="live-dot" /> : null}
          {live ? ' live' : ''}
        </span>
      </div>
      <div className="transcript-body">
        {turns.map((turn, i) => {
          const role = turn.role === 'user' ? 'user' : 'agent';
          return (
            <div key={i} className={`bubble bubble-${role}`}>
              <div className="bubble-meta mono">
                <span className="bubble-role">{role === 'agent' ? 'A' : 'U'}</span>
                <span className="bubble-time">{tsToClock(turn.ts)}</span>
              </div>
              <div className="bubble-text">{turn.text}</div>
            </div>
          );
        })}
        <div ref={tailRef} />
      </div>
    </div>
  );
}
