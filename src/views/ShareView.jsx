import React, { useCallback, useEffect, useState } from 'react';

export default function ShareView({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/share/build/${encodeURIComponent(token)}`);
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(body?.error || res.statusText);
      setData(body);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  const business = data?.business || {};
  const build = data?.build || {};
  const status = build?.status || (loading ? 'connecting' : 'no build');
  const live = build?.liveUrl || null;
  const project = build?.projectUrl || null;

  return (
    <div className="nyna-share">
      <header className="nyna-share-bar">
        <div>
          <div className="nyna-share-title">{business.name || 'your build'}</div>
          <div className="nyna-share-sub">your site is being built — live</div>
        </div>
        <div className="nyna-share-status">
          <span className={`nyna-action-dot ${live ? 'nyna-action-dot-live' : 'nyna-action-dot-off'}`} />
          <span>{status}</span>
        </div>
      </header>

      <section className="nyna-share-stage">
        <div className="nyna-share-frame">
          {live ? (
            <iframe
              title="your build in progress"
              src={live}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="nyna-share-frame-placeholder">
              <div className="nyna-share-frame-placeholder-eyebrow">browser-use cloud</div>
              <div className="nyna-share-frame-placeholder-title">
                {loading ? 'finding your build agent…' : error ? `couldn't load: ${error}` : 'queued — your build will start shortly'}
              </div>
              <div className="nyna-share-frame-placeholder-sub">
                You can leave this tab open. It updates automatically when your build agent starts.
              </div>
            </div>
          )}
        </div>

        <aside className="nyna-share-side">
          <div className="nyna-card">
            <div className="nyna-card-title">what's happening</div>
            <div className="nyna-card-body" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
              An AI build agent is opening Lovable in a cloud browser, drafting your site
              live, and refining it section by section. Watch above as it works.
            </div>
          </div>

          {project ? (
            <div className="nyna-card">
              <div className="nyna-card-title">final URL (preview)</div>
              <div className="nyna-card-body" style={{ wordBreak: 'break-all' }}>
                <a href={project} target="_blank" rel="noreferrer" style={{ color: 'var(--apricot)' }}>{project}</a>
              </div>
            </div>
          ) : null}

          <div className="nyna-card">
            <div className="nyna-card-title">build timeline</div>
            <div className="nyna-card-body">
              {data?.timeline?.length ? (
                <ul className="nyna-share-timeline">
                  {data.timeline.slice(-8).reverse().map((event, i) => (
                    <li key={i}>
                      <span className="nyna-share-timeline-dot" />
                      <div>
                        <div className="nyna-share-timeline-type">{labelize(event.type)}</div>
                        {event.summary ? <div className="nyna-share-timeline-summary">{event.summary}</div> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="nyna-rail-empty">// waiting for the agent to start logging steps</div>
              )}
            </div>
          </div>
        </aside>
      </section>

      <footer className="nyna-share-foot">
        callmemaybe · private build session · token <span style={{ color: 'var(--apricot)', marginLeft: 6 }}>{token.slice(0, 10)}…</span>
      </footer>
    </div>
  );
}

function labelize(t) {
  if (!t) return '—';
  return String(t).replace(/^builder\./, '').replace(/_/g, ' ');
}
