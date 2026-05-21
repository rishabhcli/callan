import React, { useMemo, useState } from 'react';
import { api } from '../api.js';

export default function CommerceConsole({ detail, focusedLeadId, onLeadChanged }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const commerce = detail?.commerce || {};
  const plan = commerce.plan;
  const checklist = plan?.launchChecklist || [];
  const riskFlags = plan?.riskFlags || [];
  const components = plan?.siteComponents || [];
  const stripe = plan?.stripeBoundary || {};
  const history = commerce.history || [];
  const readyCounts = useMemo(() => {
    const ready = checklist.filter((item) => ['ready', 'not_required', 'operator'].includes(item.status)).length;
    return { ready, total: checklist.length };
  }, [checklist]);

  async function submit(e) {
    e.preventDefault();
    if (!focusedLeadId || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.planCommerce(focusedLeadId, {
        source: 'operator_ui',
        intake: { rawText: text.trim() }
      });
      setText('');
      onLeadChanged?.(focusedLeadId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!focusedLeadId) {
    return (
      <div className="empty-inspector">
        <div className="hd">commerce</div>
        <div className="mono note">// focus a lead to capture customer-business commerce.</div>
      </div>
    );
  }

  return (
    <div className="commerce-tab">
      <div className="commerce-head">
        <div>
          <div className="hd">commerce console</div>
          <div className="commerce-headline">
            {plan ? `${labelize(plan.type)} · ${labelize(plan.status)}` : 'No customer commerce plan yet.'}
          </div>
        </div>
        <div className="commerce-status mono">
          {readyCounts.total ? `${readyCounts.ready}/${readyCounts.total} ready` : 'empty'}
        </div>
      </div>

      <form onSubmit={submit} className="commerce-intake">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="products, services, packages, prices, deposits, booking requirements, fulfillment notes, customer-supplied refund/cancellation copy, regulated/tax flags..."
        />
        <div className="commerce-actions">
          <button className="btn btn-mini btn-primary" disabled={busy || !text.trim()}>
            {busy ? 'planning...' : 'create CommercePlan'}
          </button>
          {error ? <span className="commerce-error mono">{error}</span> : null}
        </div>
      </form>

      {plan ? (
        <>
          <section className="commerce-next">
            <div>
              <div className="outcome-key mono">website commerce CTA</div>
              <div className="commerce-next-title">{plan.commerceCta?.label || 'Contact us'}</div>
              <div className="commerce-next-copy">{plan.customerCopy?.body || plan.websiteBrief?.summary}</div>
            </div>
            <div className="commerce-badges">
              <span className="thread-flag thread-flag-info">{labelize(stripe.mode || 'not_required')}</span>
              {stripe.callanRevenueSeparated ? <span className="thread-flag thread-flag-good">separate from Callan invoice</span> : null}
              {plan.humanHandoff?.required ? <span className="thread-flag thread-flag-bad">handoff</span> : null}
            </div>
          </section>

          <section className="commerce-grid">
            <CommercePanel title="site components" items={components.map((item) => `${item.title}: ${item.copy}`)} />
            <CommercePanel title="launch checklist" items={checklist.map((item) => `${labelize(item.status)} - ${item.label}`)} />
            <CommercePanel title="stripe boundary" items={[
              `owner: ${stripe.owner || 'customer_business'}`,
              `requiresStripe: ${stripe.requiresStripe ? 'yes' : 'no'}`,
              `liveGenerationPerformed: ${stripe.liveGenerationPerformed ? 'yes' : 'no'}`,
              ...(stripe.operatorChecklist || []).map((item) => `${labelize(item.status)} - ${item.label}`)
            ]} />
            <CommercePanel title="risk flags" items={riskFlags.length ? riskFlags.map((flag) => `${flag.severity} - ${flag.code}: ${flag.reason}`) : ['no hard risk flags']} />
          </section>

          {history.length > 1 ? (
            <section className="commerce-history">
              <div className="section-head">
                <span className="hd">history</span>
                <span className="mono note">{history.length} plans</span>
              </div>
              {history.slice(0, 5).map((row) => (
                <div key={row.id} className="commerce-history-row">
                  <span>{labelize(row.type)}</span>
                  <span className="mono">{labelize(row.status)}</span>
                </div>
              ))}
            </section>
          ) : null}
        </>
      ) : (
        <div className="commerce-empty mono">// intake commerce details to produce a safe CommercePlan.</div>
      )}
    </div>
  );
}

function CommercePanel({ title, items }) {
  return (
    <section className="commerce-panel">
      <div className="section-head">
        <span className="hd">{title}</span>
        <span className="mono note">{items.length}</span>
      </div>
      <div className="commerce-list">
        {items.map((item, index) => (
          <div key={`${title}:${index}`} className="commerce-list-item">{item}</div>
        ))}
      </div>
    </section>
  );
}

function labelize(value) {
  return String(value || '').replace(/_/g, ' ');
}
