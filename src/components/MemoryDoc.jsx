import React, { useState } from 'react';

function parseDoc(doc) {
  if (!doc) return null;
  const raw = doc.content ?? doc.summary ?? doc.body ?? '';
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

function maskPhone(p) {
  if (!p) return '—';
  const d = String(p).replace(/\D/g, '');
  if (d.length < 6) return p;
  return `${d.slice(0, 3)} ××× ${d.slice(-2)}`;
}

function Profile({ data }) {
  return (
    <div className="kv">
      <Row label="business">{data.businessName}</Row>
      <Row label="address">{data.address || '—'}</Row>
      <Row label="phone" mono>{maskPhone(data.phone)}</Row>
      <Row label="hours">{data.hours || '—'}</Row>
      <Row label="owner">{data.ownerHypothesis || '—'}</Row>
      <Row label="summary">{data.whatTheyDo}</Row>
      <Row label="signals">
        <div className="chips">
          {(data.signals || []).map((s, i) => (
            <span key={i} className="chip mono">{s}</span>
          ))}
        </div>
      </Row>
    </div>
  );
}

function Pitch({ data }) {
  return (
    <div className="pitch">
      <Row label="opening"><em>{data.openingLine}</em></Row>
      <Row label="value">{data.valueProp}</Row>
      <Row label="close">{data.close}</Row>
      <div className="hd hd-sub">objections</div>
      <table className="obj-table">
        <tbody>
          {(data.objections || []).map((o, i) => (
            <tr key={i}>
              <td className="obj-q">"{o.objection}"</td>
              <td className="obj-arrow mono">→</td>
              <td className="obj-r">{o.response}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="hd hd-sub">discovery</div>
      <ol className="ordlist">
        {(data.discoveryQuestions || []).map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ol>
    </div>
  );
}

function CallLog({ data }) {
  const turns = Array.isArray(data?.turns) ? data.turns : Array.isArray(data) ? data : null;
  if (!turns) return <pre className="raw mono">{JSON.stringify(data, null, 2)}</pre>;
  return (
    <div className="memlog">
      {turns.map((t, i) => (
        <div key={i} className={`bubble bubble-${t.role === 'user' ? 'user' : 'agent'}`}>
          <div className="bubble-meta mono"><span className="bubble-role">{t.role === 'user' ? 'U' : 'A'}</span></div>
          <div className="bubble-text">{t.text}</div>
        </div>
      ))}
    </div>
  );
}

function PostMortem({ data }) {
  const outcome = data.outcome || 'unknown';
  return (
    <div className="postmortem">
      <div className="pm-head">
        <span className={`chip chip-outcome chip-${outcome}`}>{outcome}</span>
        <span className="pm-reason"><em>{data.reason}</em></span>
      </div>
      <div className="pm-grid">
        <div>
          <div className="hd hd-sub">what worked</div>
          <ul className="bulletlist">
            {(data.whatWorked || []).map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        </div>
        <div>
          <div className="hd hd-sub">what to try next</div>
          <ul className="bulletlist">
            {(data.whatToTryNext || []).map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        </div>
      </div>
      {(data.replayMoments || []).length > 0 && (
        <>
          <div className="hd hd-sub">replay moments</div>
          <div className="timeline">
            {data.replayMoments.map((m, i) => (
              <div key={i} className="tl-row">
                <span className="tl-dot" />
                <div className="tl-body">
                  <div className="tl-excerpt">"{m.excerpt}"</div>
                  <div className="tl-note mono">{m.note}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, children, mono }) {
  return (
    <div className="kv-row">
      <div className="kv-key mono">{label}</div>
      <div className={`kv-val ${mono ? 'mono' : ''}`}>{children}</div>
    </div>
  );
}

export default function MemoryDoc({ kind, doc, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const data = parseDoc(doc);
  const ts = doc?.createdAt || doc?.created_at || doc?.metadata?.ts;
  const label = kind.replace('_', ' ');

  if (!data) {
    return (
      <div className="memcard memcard-empty">
        <div className="memcard-head">
          <span className="mono memcard-key">{label}</span>
          <span className="memcard-tag mono">—</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`memcard ${open ? 'open' : ''}`}>
      <button className="memcard-head" onClick={() => setOpen((v) => !v)}>
        <span className="mono memcard-key">{label}</span>
        <span className="memcard-tag mono">
          {ts ? new Date(ts).toLocaleTimeString() : 'cached'}
        </span>
        <span className="memcard-toggle mono">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="memcard-body">
          {kind === 'profile'     && <Profile data={data} />}
          {kind === 'pitch'       && <Pitch data={data} />}
          {kind === 'call_log'    && <CallLog data={data} />}
          {kind === 'post_mortem' && <PostMortem data={data} />}
        </div>
      )}
    </div>
  );
}
