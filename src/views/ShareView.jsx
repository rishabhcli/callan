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
    scopeBusy: false,
    scopeError: null,
    scopeMessage: null,
    intakeBusy: false,
    intakeError: null,
    intakeMessage: null,
    assetBusy: false,
    assetError: null,
    assetMessage: null,
    launchBusy: false,
    launchError: null,
    launchMessage: null,
    commerceText: '',
    commerceBusy: false,
    commerceError: null,
    commerceMessage: null,
    renewalBusy: null,
    renewalError: null,
    renewalMessage: null,
    renewalChangeBusy: null,
    renewalChangeError: null,
    renewalChangeMessage: null,
    renewalChangeNotes: {},
    renewalConfirmationBusy: null,
    renewalConfirmationError: null,
    renewalConfirmationMessage: null,
    renewalConfirmationAcceptBusy: null,
    renewalConfirmationAcceptError: null,
    renewalConfirmationAcceptMessage: null,
    optOutBusy: false,
    optOutError: null,
    optOutDone: false
  });
  const [intakeDirty, setIntakeDirty] = useState(false);
  const [intakeForm, setIntakeForm] = useState({
    contactName: '',
    contactEmail: '',
    preferredPhone: '',
    serviceArea: '',
    primaryGoal: '',
    brandVoice: '',
    mustHaveSections: '',
    notes: ''
  });
  const [assetForm, setAssetForm] = useState({ url: '', label: '', notes: '' });

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

  useEffect(() => {
    if (!data?.intake || intakeDirty) return;
    setIntakeForm({
      contactName: data.intake.contactName || '',
      contactEmail: data.intake.contactEmail || '',
      preferredPhone: data.intake.preferredPhone || '',
      serviceArea: data.intake.serviceArea || '',
      primaryGoal: data.intake.primaryGoal || '',
      brandVoice: data.intake.brandVoice || '',
      mustHaveSections: Array.isArray(data.intake.mustHaveSections) ? data.intake.mustHaveSections.join(', ') : '',
      notes: data.intake.notes || ''
    });
  }, [data?.intake, intakeDirty]);

  const portal = data?.portal || {};
  const business = data?.business || {};
  const build = data?.build || {};
  const brief = data?.brief || {};
  const invoice = data?.invoice || {};
  const quote = data?.quote || {};
  const nextAction = data?.nextAction || null;
  const portalChecklist = Array.isArray(data?.launchChecklist) ? data.launchChecklist : [];
  const revisions = data?.revisions || data?.builderQa?.revisions || [];
  const accountTimeline = data?.accountManagerTimeline || [];
  const memoryHighlights = brief?.memoryHighlights || [];
  const status = build?.status || (loading ? 'connecting' : 'no build');
  const live = build?.liveUrl || build?.live_url || null;
  const project = build?.projectUrl || build?.project_url || build?.finalSiteUrl || null;
  const quoteStatus = data?.quoteStatus || 'not_yet';
  const paymentLinkUrl = data?.paymentLinkUrl || null;
  const pendingCallback = data?.existingPendingCallback || null;
  const verticalPack = data?.vertical_pack || null;
  const commerce = data?.commerce || null;
  const aftercare = data?.aftercare || { pending: [], recent: [] };
  const subscriptionManagement = data?.subscriptionManagement || { subscriptions: [] };
  const subscriptions = Array.isArray(subscriptionManagement.subscriptions) ? subscriptionManagement.subscriptions : [];
  const trust = data?.trust || null;
  const accepted = quoteStatus === 'accepted' || quoteStatus === 'paid';
  const paid = quoteStatus === 'paid';
  const builderQa = data?.builderQa || {};
  const latestQa = builderQa.latestQa || null;
  const launchChecklist = builderQa.launchChecklist || null;
  const commerceChecklist = commerce?.launchChecklist || [];
  const launchStatusValue = build?.launchStatus || build?.launch_status || launchChecklist?.status;
  const customerApproved = ['customer_approved', 'launched'].includes(launchStatusValue) || build?.customerApprovedAt || build?.customer_approved_at;
  const canApproveLaunch = latestQa?.passed && project && !customerApproved;
  const portalOptedOut = Boolean(actionState.optOutDone || trust?.optOutStatus?.optedOut);
  const scopeApproved = Boolean(data?.approvals?.scope || quote.scopeApproved);
  const launchApproved = Boolean(data?.approvals?.launch || customerApproved);

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

  const handleIntakeChange = useCallback((field, value) => {
    setIntakeDirty(true);
    setIntakeForm((form) => ({ ...form, [field]: value }));
  }, []);

  const handleIntakeSubmit = useCallback(async (e) => {
    e.preventDefault();
    const payload = {
      ...intakeForm,
      mustHaveSections: splitList(intakeForm.mustHaveSections)
    };
    setActionState((s) => ({ ...s, intakeBusy: true, intakeError: null, intakeMessage: null }));
    try {
      await postAction('/intake', payload);
      setIntakeDirty(false);
      setActionState((s) => ({
        ...s,
        intakeBusy: false,
        intakeMessage: 'Brief saved. The build plan now has your latest details.'
      }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, intakeBusy: false, intakeError: err.message }));
    }
  }, [intakeForm, postAction, load]);

  const handleScopeApprove = useCallback(async () => {
    setActionState((s) => ({ ...s, scopeBusy: true, scopeError: null, scopeMessage: null }));
    try {
      await postAction('/scope/approve', {
        notes: `Scope approved from the customer portal for ${business.name || 'this build'}.`
      });
      setActionState((s) => ({
        ...s,
        scopeBusy: false,
        scopeMessage: 'Scope approved. The $500 website package is locked.'
      }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, scopeBusy: false, scopeError: err.message }));
    }
  }, [business.name, postAction, load]);

  const handleAssetChange = useCallback((field, value) => {
    setAssetForm((form) => ({ ...form, [field]: value }));
  }, []);

  const handleAssetSubmit = useCallback(async (e) => {
    e.preventDefault();
    const url = assetForm.url.trim();
    if (!url) return;
    setActionState((s) => ({ ...s, assetBusy: true, assetError: null, assetMessage: null }));
    try {
      await postAction('/asset', {
        url,
        label: assetForm.label.trim() || 'Customer asset',
        notes: assetForm.notes.trim()
      });
      setAssetForm({ url: '', label: '', notes: '' });
      setActionState((s) => ({
        ...s,
        assetBusy: false,
        assetMessage: 'Asset attached to the build brief.'
      }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, assetBusy: false, assetError: err.message }));
    }
  }, [assetForm, postAction, load]);

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

  const handleCommerce = useCallback(async (e) => {
    e.preventDefault();
    const rawText = actionState.commerceText.trim();
    if (!rawText) return;
    setActionState((s) => ({ ...s, commerceBusy: true, commerceError: null, commerceMessage: null }));
    try {
      const result = await postAction('/commerce', { intake: { rawText } });
      setActionState((s) => ({
        ...s,
        commerceBusy: false,
        commerceText: '',
        commerceMessage: `commerce plan captured: ${labelize(result.type || result.plan?.type)}`
      }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, commerceBusy: false, commerceError: err.message }));
    }
  }, [actionState.commerceText, postAction, load]);

  const handleRenewalChangeNoteChange = useCallback((subscriptionId, value) => {
    setActionState((s) => ({
      ...s,
      renewalChangeNotes: { ...(s.renewalChangeNotes || {}), [subscriptionId]: value }
    }));
  }, []);

  const handleRenewalChangeRequest = useCallback(async (subscriptionId) => {
    const note = String(actionState.renewalChangeNotes?.[subscriptionId] || '').trim();
    setActionState((s) => ({ ...s, renewalChangeBusy: subscriptionId, renewalChangeError: null, renewalChangeMessage: null }));
    try {
      await postAction('/renewal/change-request', {
        subscriptionId,
        note: note || `Renewal change requested for ${business.name || 'this account'} from the customer portal.`,
        requestType: 'change'
      });
      setActionState((s) => ({
        ...s,
        renewalChangeBusy: null,
        renewalChangeMessage: 'Renewal change request sent for operator review.',
        renewalChangeNotes: { ...(s.renewalChangeNotes || {}), [subscriptionId]: '' }
      }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, renewalChangeBusy: null, renewalChangeError: err.message }));
    }
  }, [actionState.renewalChangeNotes, business.name, postAction, load]);

  const handleRenewalReview = useCallback(async (subscriptionId) => {
    setActionState((s) => ({ ...s, renewalBusy: subscriptionId, renewalError: null, renewalMessage: null }));
    try {
      await postAction('/renewal/review', {
        subscriptionId,
        note: `Renewal plan reviewed from the customer portal for ${business.name || 'this account'}.`
      });
      setActionState((s) => ({
        ...s,
        renewalBusy: null,
        renewalMessage: 'Renewal plan reviewed.'
      }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, renewalBusy: null, renewalError: err.message }));
    }
  }, [business.name, postAction, load]);

  const handleRenewalConfirmationAcknowledge = useCallback(async (confirmationId) => {
    setActionState((s) => ({
      ...s,
      renewalConfirmationBusy: confirmationId,
      renewalConfirmationError: null,
      renewalConfirmationMessage: null
    }));
    try {
      await postAction(`/renewal/confirmations/${encodeURIComponent(confirmationId)}/acknowledge`, {
        note: `Renewal confirmation acknowledged from the customer portal for ${business.name || 'this account'}.`
      });
      setActionState((s) => ({
        ...s,
        renewalConfirmationBusy: null,
        renewalConfirmationMessage: 'Renewal confirmation acknowledged.'
      }));
      load();
    } catch (err) {
      setActionState((s) => ({
        ...s,
        renewalConfirmationBusy: null,
        renewalConfirmationError: err.message
      }));
    }
  }, [business.name, postAction, load]);

  const handleRenewalConfirmationAccept = useCallback(async (confirmationId) => {
    setActionState((s) => ({
      ...s,
      renewalConfirmationAcceptBusy: confirmationId,
      renewalConfirmationAcceptError: null,
      renewalConfirmationAcceptMessage: null
    }));
    try {
      await postAction(`/renewal/confirmations/${encodeURIComponent(confirmationId)}/accept`, {
        note: `Renewal confirmation accepted from the customer portal for ${business.name || 'this account'}.`
      });
      setActionState((s) => ({
        ...s,
        renewalConfirmationAcceptBusy: null,
        renewalConfirmationAcceptMessage: 'Renewal confirmation accepted.'
      }));
      load();
    } catch (err) {
      setActionState((s) => ({
        ...s,
        renewalConfirmationAcceptBusy: null,
        renewalConfirmationAcceptError: err.message
      }));
    }
  }, [business.name, postAction, load]);

  const handleOptOut = useCallback(async () => {
    const ok = window.confirm(
      'Opt out of further contact? We will stop calling and emailing you about this project.'
    );
    if (!ok) return;
    setActionState((s) => ({ ...s, optOutBusy: true, optOutError: null }));
    try {
      await postAction('/opt-out');
      setActionState((s) => ({ ...s, optOutBusy: false, optOutDone: true }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, optOutBusy: false, optOutError: err.message }));
    }
  }, [postAction, load]);

  const handleApproveLaunch = useCallback(async () => {
    setActionState((s) => ({ ...s, launchBusy: true, launchError: null, launchMessage: null }));
    try {
      await postAction('/launch/approve');
      setActionState((s) => ({ ...s, launchBusy: false, launchMessage: 'Approved — we will move this to launch.' }));
      load();
    } catch (err) {
      setActionState((s) => ({ ...s, launchBusy: false, launchError: err.message }));
    }
  }, [postAction, load]);

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

      <section className="nyna-share-command">
        <div className="nyna-share-command-main">
          <div className="nyna-share-command-kicker">client operating room</div>
          <div className="nyna-share-command-title">{nextAction?.label || 'Build in progress'}</div>
          <div className="nyna-share-command-copy">
            {scopeApproved
              ? 'Scope is approved for the $500 website build.'
              : quote.lineItems?.length
                ? quote.lineItems.join(' / ')
                : 'Your scope, invoice, assets, edits, QA, and launch approval live here.'}
          </div>
        </div>
        <div className="nyna-share-stats" aria-label="build status summary">
          <StatusTile label="quote" value={labelize(quote.status || quoteStatus)} tone={accepted ? 'good' : 'active'} />
          <StatusTile label="invoice" value={labelize(invoice.status)} tone={paid ? 'good' : invoice.paymentLinkUrl ? 'active' : 'idle'} />
          <StatusTile label="scope" value={scopeApproved ? 'approved' : 'pending'} tone={scopeApproved ? 'good' : 'active'} />
          <StatusTile label="launch" value={launchApproved ? 'approved' : labelize(build?.launchStatus || 'pending')} tone={launchApproved ? 'good' : 'idle'} />
        </div>
      </section>

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
          <BriefPortalCard
            business={business}
            brief={brief}
            memoryHighlights={memoryHighlights}
            intake={data?.intake}
          />

          <InvoicePortalCard
            quote={quote}
            invoice={invoice}
            paymentLinkUrl={paymentLinkUrl}
            accepted={accepted}
            paid={paid}
          />

          <div className="nyna-card">
            <div className="nyna-card-title">preview URL</div>
            <div className="nyna-card-body" style={{ wordBreak: 'break-all' }}>
              {project ? (
                <a href={project} target="_blank" rel="noreferrer" style={{ color: 'var(--apricot)' }}>{project}</a>
              ) : (
                <span className="nyna-rail-empty">waiting for generated preview</span>
              )}
            </div>
          </div>

          <div className="nyna-card">
            <div className="nyna-card-title">quality check</div>
            <div className="nyna-card-body" style={{ fontSize: 12.5, lineHeight: 1.55 }}>
              {latestQa ? (
                <>
                  <div>QA {latestQa.passed ? 'passed' : 'needs work'} · score {latestQa.score ?? 0}</div>
                  <div>Launch status: {labelize(launchStatusValue || 'pending')}</div>
                  {latestQa.errors?.length ? <div>Open items: {latestQa.errors.slice(0, 3).join(', ')}</div> : null}
                  {launchChecklist?.items?.length ? (
                    <ul className="nyna-share-timeline" style={{ marginTop: 10 }}>
                      {launchChecklist.items.slice(0, 5).map((item) => (
                        <li key={item.key}>
                          <span className="nyna-share-timeline-dot" />
                          <div>
                            <div className="nyna-share-timeline-type">{item.passed ? 'pass' : 'pending'} · {item.label}</div>
                            <div className="nyna-share-timeline-summary">{item.detail}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : (
                <div>QA will appear here once the generated preview is inspected.</div>
              )}
            </div>
          </div>

          <LaunchChecklistCard checklist={portalChecklist} />

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

          <TrustPortalCard
            trust={trust}
            business={business}
            optedOut={portalOptedOut}
            optOutBusy={actionState.optOutBusy}
            optOutError={actionState.optOutError}
            onOptOut={handleOptOut}
          />
        </aside>
      </section>

      <section className="nyna-share-actions">
        <div className="nyna-card nyna-share-action-card nyna-share-wide-card">
          <div className="nyna-card-title">build intake</div>
          <div className="nyna-card-body">
            <form onSubmit={handleIntakeSubmit} className="nyna-share-action-form">
              <div className="nyna-share-field-grid">
                <input
                  className="nyna-share-action-input"
                  placeholder="contact name"
                  value={intakeForm.contactName}
                  onChange={(e) => handleIntakeChange('contactName', e.target.value)}
                />
                <input
                  className="nyna-share-action-input"
                  type="email"
                  placeholder="contact email"
                  value={intakeForm.contactEmail}
                  onChange={(e) => handleIntakeChange('contactEmail', e.target.value)}
                />
                <input
                  className="nyna-share-action-input"
                  placeholder="preferred phone"
                  value={intakeForm.preferredPhone}
                  onChange={(e) => handleIntakeChange('preferredPhone', e.target.value)}
                />
                <input
                  className="nyna-share-action-input"
                  placeholder="service area"
                  value={intakeForm.serviceArea}
                  onChange={(e) => handleIntakeChange('serviceArea', e.target.value)}
                />
              </div>
              <textarea
                className="nyna-share-action-textarea"
                rows={2}
                placeholder="primary goal"
                value={intakeForm.primaryGoal}
                onChange={(e) => handleIntakeChange('primaryGoal', e.target.value)}
              />
              <div className="nyna-share-field-grid">
                <textarea
                  className="nyna-share-action-textarea"
                  rows={3}
                  placeholder="brand voice"
                  value={intakeForm.brandVoice}
                  onChange={(e) => handleIntakeChange('brandVoice', e.target.value)}
                />
                <textarea
                  className="nyna-share-action-textarea"
                  rows={3}
                  placeholder="must-have sections, separated by commas"
                  value={intakeForm.mustHaveSections}
                  onChange={(e) => handleIntakeChange('mustHaveSections', e.target.value)}
                />
              </div>
              <textarea
                className="nyna-share-action-textarea"
                rows={2}
                placeholder="notes"
                value={intakeForm.notes}
                onChange={(e) => handleIntakeChange('notes', e.target.value)}
              />
              <div className="nyna-share-action-row">
                <button
                  type="submit"
                  className="nyna-action nyna-action-primary"
                  disabled={actionState.intakeBusy}
                >
                  {actionState.intakeBusy ? 'saving...' : 'save intake'}
                </button>
              </div>
            </form>
            {actionState.intakeMessage ? (
              <div className="nyna-share-action-msg">{actionState.intakeMessage}</div>
            ) : null}
            {actionState.intakeError ? (
              <div className="nyna-share-action-msg nyna-share-action-msg-error">{actionState.intakeError}</div>
            ) : null}
          </div>
        </div>

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

        <div className="nyna-card nyna-share-action-card">
          <div className="nyna-card-title">{scopeApproved ? 'scope approved' : 'approve scope'}</div>
          <div className="nyna-card-body">
            <div className="nyna-share-action-body">
              {quote.lineItems?.length
                ? quote.lineItems.join(' / ')
                : 'Approve the proposed $500 website scope.'}
            </div>
            <div className="nyna-share-action-row">
              <button
                type="button"
                className="nyna-action nyna-action-primary"
                onClick={handleScopeApprove}
                disabled={scopeApproved || actionState.scopeBusy}
              >
                {actionState.scopeBusy ? 'approving...' : scopeApproved ? 'approved' : 'approve scope'}
              </button>
            </div>
            {actionState.scopeMessage ? (
              <div className="nyna-share-action-msg">{actionState.scopeMessage}</div>
            ) : null}
            {actionState.scopeError ? (
              <div className="nyna-share-action-msg nyna-share-action-msg-error">{actionState.scopeError}</div>
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

        <div className="nyna-card nyna-share-action-card">
          <div className="nyna-card-title">asset handoff</div>
          <div className="nyna-card-body">
            <form onSubmit={handleAssetSubmit} className="nyna-share-action-form">
              <input
                className="nyna-share-action-input"
                placeholder="https://drive.google.com/... or mock://logo"
                value={assetForm.url}
                onChange={(e) => handleAssetChange('url', e.target.value)}
              />
              <div className="nyna-share-field-grid nyna-share-field-grid-compact">
                <input
                  className="nyna-share-action-input"
                  placeholder="label"
                  value={assetForm.label}
                  onChange={(e) => handleAssetChange('label', e.target.value)}
                />
                <input
                  className="nyna-share-action-input"
                  placeholder="notes"
                  value={assetForm.notes}
                  onChange={(e) => handleAssetChange('notes', e.target.value)}
                />
              </div>
              <div className="nyna-share-action-row">
                <button
                  type="submit"
                  className="nyna-action"
                  disabled={actionState.assetBusy || !assetForm.url.trim()}
                >
                  {actionState.assetBusy ? 'attaching...' : 'attach asset'}
                </button>
              </div>
            </form>
            <AssetList assets={data?.intake?.assets || data?.intake?.assetUrls} />
            {actionState.assetMessage ? (
              <div className="nyna-share-action-msg">{actionState.assetMessage}</div>
            ) : null}
            {actionState.assetError ? (
              <div className="nyna-share-action-msg nyna-share-action-msg-error">{actionState.assetError}</div>
            ) : null}
          </div>
        </div>

        <div className="nyna-card nyna-share-action-card">
          <div className="nyna-card-title">{customerApproved ? 'launch approved' : 'approve launch'}</div>
          <div className="nyna-card-body">
            <div className="nyna-share-action-body">
              {customerApproved
                ? 'Thanks — your approval is recorded. The operator launch step is now queued.'
                : canApproveLaunch
                  ? 'The preview passed automated QA. Approve it when the obvious links, copy, and contact paths look right.'
                  : 'Approval unlocks after the preview has a final URL and passes QA.'}
            </div>
            <div className="nyna-share-action-row">
              <button
                type="button"
                className="nyna-action nyna-action-primary"
                onClick={handleApproveLaunch}
                disabled={!canApproveLaunch || actionState.launchBusy}
              >
                {actionState.launchBusy ? 'approving…' : customerApproved ? 'approved' : 'approve launch'}
              </button>
            </div>
            {actionState.launchMessage ? <div className="nyna-share-action-msg">{actionState.launchMessage}</div> : null}
            {actionState.launchError ? <div className="nyna-share-action-msg nyna-share-action-msg-error">{actionState.launchError}</div> : null}
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

        <div className="nyna-card nyna-share-action-card">
          <div className="nyna-card-title">commerce setup</div>
          <div className="nyna-card-body">
            {commerce ? (
              <div className="nyna-share-action-msg">
                {labelize(commerce.type)} · {labelize(commerce.stripeBoundary?.mode || 'not required')}
              </div>
            ) : null}
            <form onSubmit={handleCommerce} className="nyna-share-action-form">
              <textarea
                className="nyna-share-action-textarea"
                rows={4}
                placeholder="services, packages, prices, deposits, booking rules, menu items, fulfillment notes, customer-supplied policies…"
                value={actionState.commerceText}
                onChange={(e) => setActionState((s) => ({ ...s, commerceText: e.target.value }))}
              />
              <div className="nyna-share-action-row">
                <button
                  type="submit"
                  className="nyna-action"
                  disabled={actionState.commerceBusy || !actionState.commerceText.trim()}
                >
                  {actionState.commerceBusy ? 'saving…' : 'save commerce'}
                </button>
              </div>
            </form>
            {commerceChecklist.length ? (
              <div className="nyna-share-checklist">
                {commerceChecklist.map((item) => (
                  <div key={item.key} className="nyna-share-check-row">
                    <span>{item.label}</span>
                    <span className="mono">{labelize(item.status)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {actionState.commerceMessage ? (
              <div className="nyna-share-action-msg">{actionState.commerceMessage}</div>
            ) : null}
            {actionState.commerceError ? (
              <div className="nyna-share-action-msg nyna-share-action-msg-error">{actionState.commerceError}</div>
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

        <RevisionQueueCard revisions={revisions} />

        <AccountTimelineCard items={accountTimeline} />
      </section>

      {(aftercare.pending?.length || aftercare.recent?.length) ? (
        <section className="nyna-share-aftercare">
          <div className="nyna-card-title">aftercare</div>
          <div className="nyna-share-aftercare-grid">
            {[...(aftercare.pending || []), ...(aftercare.recent || [])].slice(0, 6).map((task) => (
              <div key={task.id} className="nyna-share-aftercare-item">
                <div>
                  <div className="nyna-share-aftercare-title">{labelize(task.title || task.kind)}</div>
                  <div className="nyna-share-aftercare-copy">{task.summary || 'Callan is keeping an eye on this.'}</div>
                </div>
                <span className={`nyna-share-aftercare-status nyna-share-aftercare-status-${task.status}`}>{labelize(task.status)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {subscriptions.length ? (
        <section className="nyna-share-aftercare">
          <div className="nyna-card-title">subscription</div>
          <div className="nyna-share-aftercare-grid">
            {subscriptions.slice(0, 4).map((subscription) => (
              <div key={subscription.id} className="nyna-share-aftercare-item">
                <div>
                  <div className="nyna-share-aftercare-title">
                    {labelize(subscription.plan || 'care plan')} · {formatMoney(subscription.amountCents, subscription.currency)}
                  </div>
                  <div className="nyna-share-aftercare-copy">
                    {subscription.renewal?.recommendedMotion
                      ? labelize(subscription.renewal.recommendedMotion)
                      : 'Your care plan is tracked here.'}
                  </div>
                  {subscription.renewal?.nextSteps?.length ? (
                    <div className="nyna-share-aftercare-copy">
                      {subscription.renewal.nextSteps.slice(0, 2).map(labelize).join(' / ')}
                    </div>
                  ) : null}
                  {subscription.renewal?.customerReviewed ? (
                    <div className="nyna-share-aftercare-copy">reviewed from this portal</div>
                  ) : null}
                  {subscription.renewal?.changeRequestCount ? (
                    <div className="nyna-share-aftercare-copy">
                      {subscription.renewal.changeRequestCount} change request{subscription.renewal.changeRequestCount === 1 ? '' : 's'} pending operator review
                    </div>
                  ) : null}
                  {subscription.renewal?.confirmationCount ? (
                    <div className="nyna-share-aftercare-copy">
                      {subscription.renewal.confirmationCount} renewal confirmation{subscription.renewal.confirmationCount === 1 ? '' : 's'} visible
                    </div>
                  ) : null}
                  {subscription.renewal?.confirmations?.length ? (
                    <div className="nyna-share-confirmation-list">
                      {subscription.renewal.confirmations.slice(0, 3).map((confirmation) => (
                        <div key={confirmation.id} className="nyna-share-confirmation-row">
                          <div>
                            <strong>{confirmation.closeoutPacketVisible ? 'renewal closed' : confirmation.accepted ? 'accepted' : confirmation.acknowledged ? 'acknowledged' : 'confirmation ready'}</strong>
                            <span>{confirmation.summary || 'Renewal update recorded in this portal.'}</span>
                            {confirmation.latestCloseoutPacket ? (
                              <span className="nyna-share-confirmation-closeout">
                                {confirmation.latestCloseoutPacket.summary || 'Closeout packet recorded. No action is needed right now.'}
                              </span>
                            ) : null}
                          </div>
                          <div className="nyna-share-confirmation-actions">
                            {!confirmation.acknowledged ? (
                              <button
                                type="button"
                                className="nyna-action nyna-action-secondary"
                                onClick={() => handleRenewalConfirmationAcknowledge(confirmation.id)}
                                disabled={actionState.renewalConfirmationBusy === confirmation.id}
                              >
                                {actionState.renewalConfirmationBusy === confirmation.id ? 'saving...' : 'mark received'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="nyna-action nyna-action-secondary"
                                onClick={() => handleRenewalConfirmationAccept(confirmation.id)}
                                disabled={confirmation.accepted || actionState.renewalConfirmationAcceptBusy === confirmation.id}
                              >
                                {confirmation.accepted
                                  ? 'accepted'
                                  : actionState.renewalConfirmationAcceptBusy === confirmation.id
                                    ? 'saving...'
                                    : 'looks good'}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="nyna-share-renewal-actions">
                  <span className={`nyna-share-aftercare-status nyna-share-aftercare-status-${subscription.status}`}>
                    {labelize(subscription.status)}
                  </span>
                  {subscription.renewal && !subscription.renewal.customerReviewed ? (
                    <button
                      type="button"
                      className="nyna-action nyna-action-secondary"
                      onClick={() => handleRenewalReview(subscription.id)}
                      disabled={actionState.renewalBusy === subscription.id}
                    >
                      {actionState.renewalBusy === subscription.id ? 'saving…' : 'review'}
                    </button>
                  ) : null}
                  {subscription.renewal ? (
                    <div className="nyna-share-renewal-change-form">
                      <textarea
                        className="nyna-share-renewal-change-input"
                        rows={2}
                        placeholder="what would you like to change about renewal? (operator will review)"
                        value={actionState.renewalChangeNotes?.[subscription.id] || ''}
                        onChange={(event) => handleRenewalChangeNoteChange(subscription.id, event.target.value)}
                        disabled={actionState.renewalChangeBusy === subscription.id}
                      />
                      <button
                        type="button"
                        className="nyna-action nyna-action-secondary"
                        onClick={() => handleRenewalChangeRequest(subscription.id)}
                        disabled={actionState.renewalChangeBusy === subscription.id}
                      >
                        {actionState.renewalChangeBusy === subscription.id ? 'sending…' : 'request change'}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          {subscriptionManagement.changeRequestCount ? (
            <div className="nyna-share-action-note">
              {subscriptionManagement.changeRequestCount} renewal change request{subscriptionManagement.changeRequestCount === 1 ? '' : 's'} on file. We will follow up — no automatic billing changes are made from this portal.
            </div>
          ) : null}
          {actionState.renewalMessage ? <div className="nyna-share-action-note">{actionState.renewalMessage}</div> : null}
          {actionState.renewalError ? <div className="nyna-share-action-error">{actionState.renewalError}</div> : null}
          {actionState.renewalChangeMessage ? <div className="nyna-share-action-note">{actionState.renewalChangeMessage}</div> : null}
          {actionState.renewalChangeError ? <div className="nyna-share-action-error">{actionState.renewalChangeError}</div> : null}
          {actionState.renewalConfirmationMessage ? <div className="nyna-share-action-note">{actionState.renewalConfirmationMessage}</div> : null}
          {actionState.renewalConfirmationError ? <div className="nyna-share-action-error">{actionState.renewalConfirmationError}</div> : null}
          {actionState.renewalConfirmationAcceptMessage ? <div className="nyna-share-action-note">{actionState.renewalConfirmationAcceptMessage}</div> : null}
          {actionState.renewalConfirmationAcceptError ? <div className="nyna-share-action-error">{actionState.renewalConfirmationAcceptError}</div> : null}
        </section>
      ) : null}

      <footer className="nyna-share-foot">
        <span>
          callan · private build session · token <span style={{ color: 'var(--apricot)', marginLeft: 6 }}>{token.slice(0, 10)}…</span>
        </span>
        <button
          type="button"
          className="nyna-share-optout"
          onClick={handleOptOut}
          disabled={actionState.optOutBusy || portalOptedOut}
        >
          {portalOptedOut
            ? "you've opted out"
            : actionState.optOutBusy
              ? 'opting out…'
              : 'opt out of further contact'}
        </button>
      </footer>
    </div>
  );
}

function StatusTile({ label, value, tone = 'idle' }) {
  return (
    <div className={`nyna-share-stat nyna-share-stat-${tone}`}>
      <span className="nyna-share-stat-label">{label}</span>
      <strong>{value || 'pending'}</strong>
    </div>
  );
}

function BriefPortalCard({ business, brief, memoryHighlights, intake }) {
  const highlights = Array.isArray(memoryHighlights) ? memoryHighlights.slice(0, 4) : [];
  const sections = Array.isArray(intake?.mustHaveSections) ? intake.mustHaveSections : [];
  const profileRows = [
    ['category', business?.niche],
    ['city', business?.city],
    ['service area', intake?.serviceArea],
    ['voice', intake?.brandVoice]
  ].filter(([, value]) => value);

  return (
    <div className="nyna-card">
      <div className="nyna-card-title">build brief</div>
      <div className="nyna-card-body">
        <div className="nyna-share-brief-title">{intake?.primaryGoal || brief?.headline || business?.name || 'Website build'}</div>
        {profileRows.length ? (
          <div className="nyna-share-mini-grid">
            {profileRows.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        ) : null}
        {sections.length ? (
          <div className="nyna-share-pill-row">
            {sections.slice(0, 6).map((section) => (
              <span key={section}>{section}</span>
            ))}
          </div>
        ) : null}
        {highlights.length ? (
          <ul className="nyna-share-work-list">
            {highlights.map((item, index) => (
              <li key={item.id || index}>{displayHighlight(item)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function InvoicePortalCard({ quote, invoice, paymentLinkUrl, accepted, paid }) {
  const amount = invoice?.amountCents || quote?.amountCents;
  return (
    <div className="nyna-card">
      <div className="nyna-card-title">invoice</div>
      <div className="nyna-card-body">
        <div className="nyna-share-money-row">
          <strong>{formatMoney(amount) || quote?.priceLabel || '$500'}</strong>
          <span>{paid ? 'paid' : accepted ? labelize(invoice?.status || 'pending') : 'quote open'}</span>
        </div>
        <div className="nyna-share-action-body">
          {paid
            ? `Paid ${formatDate(invoice?.paidAt) || ''}`.trim()
            : accepted
              ? 'Stripe invoice is ready when the payment link appears.'
              : 'Accept the quote to generate the invoice.'}
        </div>
        {paymentLinkUrl ? (
          <a className="nyna-action nyna-action-primary" href={paymentLinkUrl} target="_blank" rel="noreferrer">
            {paid ? 'view receipt' : 'open invoice'}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function LaunchChecklistCard({ checklist }) {
  const items = Array.isArray(checklist) ? checklist : [];
  return (
    <div className="nyna-card">
      <div className="nyna-card-title">launch checklist</div>
      <div className="nyna-card-body">
        {items.length ? (
          <div className="nyna-share-checklist">
            {items.map((item) => (
              <div key={item.id || item.label} className={`nyna-share-check-row ${item.done ? 'is-done' : ''}`}>
                <span>{item.label}</span>
                <span>{item.done ? 'done' : 'open'}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="nyna-rail-empty">waiting for checklist</div>
        )}
      </div>
    </div>
  );
}

function AssetList({ assets }) {
  const rows = Array.isArray(assets) ? assets.slice(-4).reverse() : [];
  if (!rows.length) return null;
  return (
    <div className="nyna-share-asset-list">
      {rows.map((asset, index) => (
        <a
          key={`${asset.url || 'asset'}-${index}`}
          href={asset.url?.startsWith('http') ? asset.url : undefined}
          target="_blank"
          rel="noreferrer"
          className="nyna-share-asset-row"
        >
          <span>{asset.label || 'Customer asset'}</span>
          <strong>{asset.url}</strong>
        </a>
      ))}
    </div>
  );
}

function RevisionQueueCard({ revisions }) {
  const rows = Array.isArray(revisions) ? revisions.slice(0, 6) : [];
  return (
    <div className="nyna-card nyna-share-action-card">
      <div className="nyna-card-title">revision queue</div>
      <div className="nyna-card-body">
        {rows.length ? (
          <div className="nyna-share-revision-list">
            {rows.map((revision) => (
              <div key={revision.id} className="nyna-share-revision-row">
                <div>
                  <strong>{labelize(revision.status)}</strong>
                  <span>{formatDate(revision.created_at || revision.createdAt)}</span>
                </div>
                <p>{revision.prompt}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="nyna-share-action-body">No revision requests are open.</div>
        )}
      </div>
    </div>
  );
}

function AccountTimelineCard({ items }) {
  const rows = Array.isArray(items) ? items.slice(0, 10) : [];
  return (
    <div className="nyna-card nyna-share-action-card nyna-share-wide-card">
      <div className="nyna-card-title">account timeline</div>
      <div className="nyna-card-body">
        {rows.length ? (
          <ul className="nyna-share-timeline nyna-share-account-timeline">
            {rows.map((item, index) => (
              <li key={`${item.type || 'event'}-${item.ts || index}-${index}`}>
                <span className="nyna-share-timeline-dot" />
                <div>
                  <div className="nyna-share-timeline-type">{labelize(item.title || item.type)} · {labelize(item.source)}</div>
                  {item.summary ? <div className="nyna-share-timeline-summary">{item.summary}</div> : null}
                  {item.ts ? <div className="nyna-share-time">{formatDate(item.ts)}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="nyna-share-action-body">No account activity yet.</div>
        )}
      </div>
    </div>
  );
}

function TrustPortalCard({ trust, business, optedOut, optOutBusy, optOutError, onOptOut }) {
  const safe = trust?.privacySafeData || {};
  const sources = trust?.sourceEvidence || [];
  const firstSource = sources.find((item) => item.url) || sources[0] || null;
  const explanation = trust?.whyAmISeeingThis ||
    `Callan contacted ${business?.name || safe.businessName || 'this business'} from public business research and keeps opt-out handling attached to the record.`;
  const chips = [
    ['business', safe.businessName || business?.name],
    ['market', [safe.niche, safe.city].filter(Boolean).join(' / ')],
    ['phone', safe.phone],
    ['phone type', safe.phoneClassification],
    ['consent', trust?.consentStatus || safe.consentStatus],
    ['source', safe.sourceHost],
    ['status', optedOut ? 'opted out' : safe.outreachStatus]
  ].filter(([, value]) => value);

  return (
    <div className="nyna-card nyna-trust-card">
      <div className="nyna-card-title">why am I seeing this?</div>
      <div className="nyna-card-body">
        <p className="nyna-trust-copy">{explanation}</p>
        <div className="nyna-trust-safe">
          {chips.map(([label, value]) => (
            <span key={label}>
              <b>{label}</b>
              {value}
            </span>
          ))}
        </div>
        {firstSource ? (
          <div className="nyna-trust-source">
            <span>source</span>
            {firstSource.url ? (
              <a href={firstSource.url} target="_blank" rel="noreferrer">
                {firstSource.host || firstSource.label || firstSource.url}
              </a>
            ) : (
              <strong>{firstSource.note || firstSource.label}</strong>
            )}
          </div>
        ) : null}
        {trust?.disclosureUsed?.text ? (
          <div className="nyna-trust-disclosure">{trust.disclosureUsed.text}</div>
        ) : null}
        <div className="nyna-trust-stop">
          <span>{optedOut ? 'Opt-out confirmed. No more calls or emails about this project.' : trust?.howToStop || 'Use the button here to stop further calls and emails.'}</span>
          <button
            type="button"
            className="nyna-action"
            onClick={onOptOut}
            disabled={optOutBusy || optedOut}
          >
            {optedOut ? 'opted out' : optOutBusy ? 'opting out…' : 'stop contact'}
          </button>
        </div>
        {optOutError ? (
          <div className="nyna-share-action-msg nyna-share-action-msg-error">{optOutError}</div>
        ) : null}
      </div>
    </div>
  );
}

function labelize(t) {
  if (!t) return '—';
  return String(t).replace(/^builder\./, '').replace(/_/g, ' ');
}

function formatMoney(amountCents) {
  if (!Number.isFinite(Number(amountCents))) return null;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(Number(amountCents) / 100);
}

function formatDate(value) {
  const date = value ? new Date(Number(value)) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function displayHighlight(item) {
  const raw = String(item?.text || item?.summary || item || '').trim();
  const kind = item?.kind ? `${labelize(item.kind)}: ` : '';
  if (!raw) return `${kind}saved context`;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.customerQuestions?.length) return `${kind}${parsed.customerQuestions.slice(0, 2).join('; ')}`;
    if (parsed.needs?.length) return `${kind}${parsed.needs.slice(0, 3).join(', ')}`;
    if (parsed.body) return `${kind}${compact(parsed.body, 180)}`;
    if (parsed.subject) return `${kind}${compact(parsed.subject, 180)}`;
    if (parsed.businessName || parsed.niche || parsed.city) {
      return `${kind}${[parsed.businessName, parsed.niche, parsed.city].filter(Boolean).join(' / ')}`;
    }
  } catch {
    // Plain memory snippets are already customer-readable.
  }
  const jsonish = summarizeJsonish(raw);
  if (jsonish) return `${kind}${jsonish}`;
  return `${kind}${compact(raw, 180)}`;
}

function summarizeJsonish(raw) {
  if (!raw.trim().startsWith('{')) return null;
  const subject = matchJsonString(raw, 'subject');
  const body = matchJsonString(raw, 'body');
  const businessName = matchJsonString(raw, 'businessName');
  const city = matchJsonString(raw, 'city');
  const niche = matchJsonString(raw, 'niche');
  const source = matchJsonString(raw, 'source');
  if (body) return compact(body, 160);
  if (subject) return compact(subject, 160);
  if (businessName || niche || city) {
    return [businessName, niche, city].filter(Boolean).join(' / ');
  }
  if (source) return `saved from ${labelize(source)}`;
  return 'saved project context';
}

function matchJsonString(raw, key) {
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)`));
  return match ? match[1] : null;
}

function compact(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function splitList(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}
