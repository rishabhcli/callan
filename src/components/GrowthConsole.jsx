import React, { useMemo, useState } from 'react';
import { api } from '../api.js';

const SECTION_LABELS = {
  localSeoGaps: 'Local SEO',
  googleBusinessProfileTasks: 'Google Business Profile',
  reviewCapturePlan: 'Review capture',
  bookingContactFlowPlan: 'Booking/contact flow',
  analyticsSetup: 'Analytics',
  contentIdeas: 'Content',
  monthlyMaintenancePlan: 'Maintenance',
  automationIdeas: 'Automations'
};

const SECTION_KEYS = Object.keys(SECTION_LABELS);

export default function GrowthConsole({ detail, focusedLeadId, onLeadChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const growth = detail?.growth || {};
  const plan = growth.plan;
  const offers = growth.offers;
  const followups = growth.followups || [];
  const evidence = useMemo(() => new Map((plan?.evidence || []).map((item) => [item.id, item])), [plan]);
  const opportunities = useMemo(() => flattenOpportunities(plan), [plan]);
  const next = offers?.nextRecommendedService || null;
  const lastFollowup = followups[0] || null;
  const unsupported = plan?.unsupportedFlags || [];
  const handoffCases = (detail?.handoff?.cases || []).filter((item) => !['resolved', 'closed'].includes(item.status));

  async function run(action) {
    if (!focusedLeadId) return;
    setBusy(action);
    setError(null);
    try {
      if (action === 'plan') await api.generateGrowthPlan(focusedLeadId, { source: 'ui' });
      if (action === 'refresh') await api.generateGrowthPlan(focusedLeadId, { force: true, source: 'ui_refresh' });
      if (action === 'followup') await api.sendGrowthFollowup(focusedLeadId);
      onLeadChanged?.(focusedLeadId);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!focusedLeadId) {
    return (
      <div className="empty-inspector">
        <div className="hd">growth</div>
        <div className="mono note">// focus a lead to see growth opportunities.</div>
      </div>
    );
  }

  return (
    <div className="growthtab">
      <div className="growth-head">
        <div>
          <div className="hd">growth console</div>
          <div className="growth-headline">
            {plan ? 'Evidence-backed services beyond the website.' : 'No growth plan has been generated yet.'}
          </div>
        </div>
        <div className="growth-actions">
          <button className="btn btn-mini" disabled={!!busy} onClick={() => run(plan ? 'refresh' : 'plan')}>
            {busy === 'plan' || busy === 'refresh' ? 'working...' : plan ? 'refresh plan' : 'generate plan'}
          </button>
          <button className="btn btn-mini btn-primary" disabled={!plan || !!busy} onClick={() => run('followup')}>
            {busy === 'followup' ? 'sending...' : 'send recap'}
          </button>
        </div>
      </div>

      {error ? <div className="growth-error mono">{error}</div> : null}

      {handoffCases.length ? (
        <section className="growth-risk">
          <div className="growth-risk-title mono">operator cases</div>
          <div className="growth-risk-flags">
            {handoffCases.slice(0, 4).map((item) => (
              <span key={item.id} className={`thread-flag thread-flag-${item.severity === 'high' ? 'bad' : 'warn'}`}>
                {labelize(item.category)}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {next ? (
        <section className="growth-next">
          <div>
            <div className="outcome-key mono">next recommended service</div>
            <div className="growth-next-title">{next.name}</div>
            <div className="growth-next-copy">{next.reason || next.summary}</div>
          </div>
          <div className="growth-next-evidence">
            {(next.evidenceIds || []).slice(0, 3).map((id) => (
              <EvidencePill key={id} id={id} evidence={evidence.get(id)} />
            ))}
          </div>
        </section>
      ) : null}

      {unsupported.length ? (
        <section className="growth-risk">
          <div className="growth-risk-title mono">handoff required</div>
          <div className="growth-risk-flags">
            {unsupported.map((flag) => <span key={flag} className="thread-flag thread-flag-bad">{flag}</span>)}
          </div>
        </section>
      ) : null}

      <section className="growth-followup">
        <div className="section-head">
          <span className="hd">follow-up status</span>
          <span className={`reply-count ${lastFollowup?.status === 'sent' ? 'reply-count-hot' : ''} mono`}>
            {lastFollowup ? lastFollowup.status : 'not sent'}
          </span>
        </div>
        {lastFollowup ? (
          <div className="growth-followup-row">
            <span className="mono">{formatWhen(lastFollowup.created_at)}</span>
            <span>{lastFollowup.subject || 'Growth follow-up'}</span>
            {lastFollowup.classification ? <span className="thread-flag thread-flag-info">{lastFollowup.classification}</span> : null}
          </div>
        ) : (
          <div className="thread-empty mono">// post-delivery recap has not been sent.</div>
        )}
      </section>

      {opportunities.length ? (
        <section className="growth-opportunities">
          <div className="section-head">
            <span className="hd">opportunities</span>
            <span className="mono note">{opportunities.length} evidence-backed items</span>
          </div>
          <div className="growth-list">
            {opportunities.map((item) => (
              <div key={`${item.section}:${item.id}`} className={`growth-item growth-priority-${item.priority}`}>
                <div className="growth-item-top">
                  <span className="growth-section mono">{SECTION_LABELS[item.section] || item.section}</span>
                  <span className={`thread-flag thread-flag-${item.unsupported ? 'bad' : priorityTone(item.priority)}`}>{item.priority}</span>
                </div>
                <div className="growth-item-title">{item.title}</div>
                <div className="growth-item-copy">{item.why}</div>
                <div className="growth-item-action">{item.action}</div>
                <div className="growth-evidence-row">
                  {(item.evidenceIds || []).map((id) => <EvidencePill key={id} id={id} evidence={evidence.get(id)} />)}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="growth-empty mono">// generate a plan to see local SEO, reviews, booking, analytics, maintenance, and automation opportunities.</div>
      )}

      {offers?.offers?.length ? (
        <section className="growth-offers">
          <div className="section-head">
            <span className="hd">offer engine</span>
            <span className="mono note">5 packages</span>
          </div>
          <div className="growth-offer-grid">
            {offers.offers.map((offer) => (
              <div key={offer.id} className={`growth-offer ${offer.recommended ? 'growth-offer-on' : ''}`}>
                <div className="growth-offer-name">{offer.name}</div>
                <div className="growth-offer-copy">{offer.summary}</div>
                <div className="growth-offer-meta mono">
                  {money(offer.setupCents)} setup · {offer.monthlyCents ? `${money(offer.monthlyCents)}/mo` : 'no monthly'}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function flattenOpportunities(plan) {
  if (!plan) return [];
  return SECTION_KEYS.flatMap((section) => (
    Array.isArray(plan[section])
      ? plan[section].map((item) => ({ ...item, section }))
      : []
  ));
}

function EvidencePill({ id, evidence }) {
  return (
    <span className="growth-evidence-pill mono" title={evidence?.summary || id}>
      {evidence?.source || id}
    </span>
  );
}

function priorityTone(priority) {
  if (priority === 'high') return 'warn';
  if (priority === 'low') return 'muted';
  return 'info';
}

function labelize(value) {
  return String(value || '').replace(/_/g, ' ');
}

function formatWhen(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function money(cents) {
  return `$${((cents || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
