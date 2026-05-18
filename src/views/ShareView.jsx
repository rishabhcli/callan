import React, { useCallback, useEffect, useMemo, useState } from 'react';

export default function ShareView({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Per-action UI state (lightweight — no library needed for four cards).
  const [actionState, setActionState] = useState({
    acceptBusy: false,
    acceptError: null,
    acceptMessage: null,
    editNote: '',
    editBusy: false,
    editError: null,
    editMessage: null,
    callbackWhen: '',
    callbackAsk: '',
    callbackBusy: false,
    callbackError: null,
    callbackMessage: null,
    optOutBusy: false,
    optOutError: null,
    optOutDone: false
  });

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
  const quoteStatus = data?.quoteStatus || 'not_yet';
  const paymentLinkUrl = data?.paymentLinkUrl || null;
  const pendingCallback = data?.existingPendingCallback || null;
  const verticalPack = data?.vertical_pack || null;
  const accepted = quoteStatus === 'accepted' || quoteStatus === 'paid';
  const paid = quoteStatus === 'paid';

  const postAction = useCallback(async (path, body) => {
    const res = await fetch(`/api/share/build/${encodeURIComponent(token)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(parsed?.error || res.statusText);
    return parsed;
  }, [token]);

  const handleAccept = useCallback(async () => {
    setActionState((s) => ({ ...s, acceptBusy: true, acceptError: null }));
    try {
      const result = await postAction('/accept');
      setActionState((s) => ({
        ...s,
        acceptBusy: false,
        acceptMessage: result.blocked
          ? `Quote noted — we'll prepare your invoice and email it shortly.`
          : `Quote accepted. Your invoice is ready.`
      }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, acceptBusy: false, acceptError: err.message }));
    }
  }, [postAction, load]);

  const handleEdit = useCallback(async (e) => {
    e.preventDefault();
    const note = actionState.editNote.trim();
    if (!note) return;
    setActionState((s) => ({ ...s, editBusy: true, editError: null, editMessage: null }));
    try {
      await postAction('/edit', { note });
      setActionState((s) => ({
        ...s,
        editBusy: false,
        editNote: '',
        editMessage: 'Got it — the build agent will pick up your edits.'
      }));
    } catch (err) {
      setActionState((s) => ({ ...s, editBusy: false, editError: err.message }));
    }
  }, [actionState.editNote, postAction]);

  const handleCallback = useCallback(async (e) => {
    e.preventDefault();
    const when = actionState.callbackWhen;
    if (!when) return;
    const scheduledAtMs = new Date(when).getTime();
    if (!Number.isFinite(scheduledAtMs)) {
      setActionState((s) => ({ ...s, callbackError: 'Invalid time.' }));
      return;
    }
    setActionState((s) => ({ ...s, callbackBusy: true, callbackError: null, callbackMessage: null }));
    try {
      await postAction('/callback', { scheduledAtMs, ask: actionState.callbackAsk });
      const localTime = new Date(scheduledAtMs).toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
      setActionState((s) => ({
        ...s,
        callbackBusy: false,
        callbackAsk: '',
        callbackWhen: '',
        callbackMessage: `we'll call you at ${localTime}`
      }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, callbackBusy: false, callbackError: err.message }));
    }
  }, [actionState.callbackWhen, actionState.callbackAsk, postAction, load]);

  const handleOptOut = useCallback(async () => {
    const ok = window.confirm(
      'Opt out of further contact? We will stop calling and emailing you about this project.'
    );
    if (!ok) return;
    setActionState((s) => ({ ...s, optOutBusy: true, optOutError: null }));
    try {
      await postAction('/opt-out');
      setActionState((s) => ({ ...s, optOutBusy: false, optOutDone: true }));
    } catch (err) {
      setActionState((s) => ({ ...s, optOutBusy: false, optOutError: err.message }));
    }
  }, [postAction]);

  const pendingCallbackText = useMemo(() => {
    if (!pendingCallback?.scheduledAtMs) return null;
    return new Date(pendingCallback.scheduledAtMs).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }, [pendingCallback]);

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

      <section className="nyna-share-actions">
        {/* Accept quote — primary call-to-action. Idempotent. */}
        <div className="nyna-card nyna-share-action-card">
          <div className="nyna-card-title">
            {paid ? 'quote paid' : accepted ? 'quote accepted' : 'accept your quote'}
          </div>
          <div className="nyna-card-body">
            <div className="nyna-share-action-body">
              {paid
                ? 'Thanks — your invoice is paid. The full build kicks off automatically.'
                : accepted
                  ? 'You accepted the quote. Pay below or take other actions any time.'
                  : verticalPack
                    ? `Your ${verticalPack} package is ready. Accept to generate your invoice.`
                    : 'Accept to lock in your scope and get a Stripe invoice for the work.'}
            </div>
            <div className="nyna-share-action-row">
              {!accepted ? (
                <button
                  type="button"
                  className="nyna-action nyna-action-primary"
                  onClick={handleAccept}
                  disabled={actionState.acceptBusy}
                >
                  {actionState.acceptBusy ? 'accepting…' : 'accept quote'}
                </button>
              ) : null}
              {accepted && paymentLinkUrl ? (
                <a
                  className="nyna-action nyna-action-primary"
                  href={paymentLinkUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {paid ? 'view receipt' : 'pay invoice'}
                </a>
              ) : null}
            </div>
            {actionState.acceptMessage ? (
              <div className="nyna-share-action-msg">{actionState.acceptMessage}</div>
            ) : null}
            {actionState.acceptError ? (
              <div className="nyna-share-action-msg nyna-share-action-msg-error">{actionState.acceptError}</div>
            ) : null}
            {accepted && !paymentLinkUrl ? (
              <div className="nyna-share-action-msg">We'll email your invoice link shortly.</div>
            ) : null}
          </div>
        </div>

        {/* Request edit — adds to memory + contact_events. */}
        <div className="nyna-card nyna-share-action-card">
          <div className="nyna-card-title">request an edit</div>
          <div className="nyna-card-body">
            <form onSubmit={handleEdit} className="nyna-share-action-form">
              <textarea
                className="nyna-share-action-textarea"
                rows={3}
                placeholder="e.g. swap the hero image, change copy in the about section…"
                value={actionState.editNote}
                onChange={(e) => setActionState((s) => ({ ...s, editNote: e.target.value }))}
              />
              <div className="nyna-share-action-row">
                <button
                  type="submit"
                  className="nyna-action"
                  disabled={actionState.editBusy || !actionState.editNote.trim()}
                >
                  {actionState.editBusy ? 'sending…' : 'send edit'}
                </button>
              </div>
            </form>
            {actionState.editMessage ? (
              <div className="nyna-share-action-msg">{actionState.editMessage}</div>
            ) : null}
            {actionState.editError ? (
              <div className="nyna-share-action-msg nyna-share-action-msg-error">{actionState.editError}</div>
            ) : null}
          </div>
        </div>

        {/* Book a callback — date/time + ask. */}
        <div className="nyna-card nyna-share-action-card">
          <div className="nyna-card-title">book a callback</div>
          <div className="nyna-card-body">
            {pendingCallback ? (
              <div className="nyna-share-action-msg">
                A callback is already scheduled for {pendingCallbackText}. Submit again to reschedule.
              </div>
            ) : null}
            <form onSubmit={handleCallback} className="nyna-share-action-form">
              <input
                type="datetime-local"
                className="nyna-share-action-input"
                value={actionState.callbackWhen}
                onChange={(e) => setActionState((s) => ({ ...s, callbackWhen: e.target.value }))}
              />
              <textarea
                className="nyna-share-action-textarea"
                rows={2}
                placeholder="what should we talk about?"
                value={actionState.callbackAsk}
                onChange={(e) => setActionState((s) => ({ ...s, callbackAsk: e.target.value }))}
              />
              <div className="nyna-share-action-row">
                <button
                  type="submit"
                  className="nyna-action"
                  disabled={actionState.callbackBusy || !actionState.callbackWhen}
                >
                  {actionState.callbackBusy ? 'booking…' : 'book callback'}
                </button>
              </div>
            </form>
            {actionState.callbackMessage ? (
              <div className="nyna-share-action-msg">{actionState.callbackMessage}</div>
            ) : null}
            {actionState.callbackError ? (
              <div className="nyna-share-action-msg nyna-share-action-msg-error">{actionState.callbackError}</div>
            ) : null}
          </div>
        </div>

        {/* Pay invoice — visible once accepted, even if also on the accept card. */}
        {accepted ? (
          <div className="nyna-card nyna-share-action-card">
            <div className="nyna-card-title">pay invoice</div>
            <div className="nyna-card-body">
              <div className="nyna-share-action-body">
                {paymentLinkUrl
                  ? 'Stripe-hosted, secure. You can pay by card or ACH.'
                  : "Your invoice will appear here in a moment — refresh if it doesn't show."}
              </div>
              {paymentLinkUrl ? (
                <div className="nyna-share-action-row">
                  <a
                    className="nyna-action nyna-action-primary"
                    href={paymentLinkUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {paid ? 'view receipt' : 'open Stripe payment link'}
                  </a>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <footer className="nyna-share-foot">
        <span>
          callmemaybe · private build session · token <span style={{ color: 'var(--apricot)', marginLeft: 6 }}>{token.slice(0, 10)}…</span>
        </span>
        <button
          type="button"
          className="nyna-share-optout"
          onClick={handleOptOut}
          disabled={actionState.optOutBusy || actionState.optOutDone}
        >
          {actionState.optOutDone
            ? "you've opted out"
            : actionState.optOutBusy
              ? 'opting out…'
              : 'opt out of further contact'}
        </button>
      </footer>
    </div>
  );
}

function labelize(t) {
  if (!t) return '—';
  return String(t).replace(/^builder\./, '').replace(/_/g, ' ');
}
