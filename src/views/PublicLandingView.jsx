import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const INITIAL_FORM = {
  businessName: '',
  niche: '',
  city: '',
  website: '',
  phone: '',
  email: '',
  notes: '',
  consent: false
};

export default function PublicLandingView() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [state, setState] = useState({ status: 'idle', error: '' });
  const [system, setSystem] = useState({ online: null, referrals: null });

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch('/api/ping').then((res) => (res.ok ? res.json() : null)).catch(() => null),
      fetch('/api/referrals/rollup').then((res) => (res.ok ? res.json() : null)).catch(() => null)
    ]).then(([ping, referrals]) => {
      if (active) setSystem({ online: !!ping?.ok, referrals });
    });
    return () => { active = false; };
  }, []);

  const referralCount = system.referrals?.totalClicks;
  const update = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const statusCopy = useMemo(() => {
    if (state.status === 'submitting') return 'Saving your brief...';
    if (state.status === 'error') return state.error;
    return '';
  }, [state]);

  async function submit(event) {
    event.preventDefault();
    setState({ status: 'submitting', error: '' });
    try {
      const result = await api.publicIntake(form);
      if (!result?.trackingPath) throw new Error('The request was saved without a tracking link.');
      window.location.assign(result.trackingPath);
    } catch (error) {
      setState({ status: 'error', error: error?.message || 'We could not save the request.' });
    }
  }

  return (
    <div className="public-site">
      <header className="public-nav">
        <a className="public-brand" href="/" aria-label="Callan home">
          <span className="public-brand-mark">*</span>
          <span>Callan</span>
        </a>
        <nav aria-label="Public site">
          <a href="#how-it-works">How it works</a>
          <a href="#use-cases">For local teams</a>
          <a className="public-nav-console" href="/app">Open console</a>
        </nav>
      </header>

      <main>
        <section className="public-hero" aria-labelledby="public-hero-title">
          <div className="public-hero-copy">
            <p className="public-eyebrow">A working website, not a brochure about one</p>
            <h1 id="public-hero-title">Turn a missed website into a booked customer.</h1>
            <p className="public-hero-lede">
              Callan researches a local business, finds the clearest conversion gap, and gives an operator a grounded path to a site that earns the next call.
            </p>
            <div className="public-hero-actions">
              <a className="public-button public-button-primary" href="#request">Request a website review <span aria-hidden="true">-&gt;</span></a>
              <a className="public-text-link" href="#how-it-works">See the workflow <span aria-hidden="true">v</span></a>
            </div>
            <div className="public-hero-status" aria-live="polite">
              <span className={`public-status-dot ${system.online === false ? 'is-down' : ''}`} />
              {system.online === false ? 'Request endpoint needs attention' : 'Request endpoint online'}
              {Number.isFinite(referralCount) ? <span className="public-status-divider">{referralCount} referral visits recorded</span> : null}
            </div>
          </div>

          <div className="public-workflow" aria-label="Live Callan workflow">
            <div className="public-workflow-head">
              <div>
                <span className="public-kicker">the handoff</span>
                <h2>From brief to build decision</h2>
              </div>
              <span className="public-live-pill"><span /> durable</span>
            </div>
            <div className="public-flow-line" aria-hidden="true" />
            <ol className="public-flow-list">
              <li className="is-complete"><span className="public-flow-index">01</span><div><strong>Request</strong><small>Your business context is saved with a private tracking link.</small></div><b>saved</b></li>
              <li className="is-active"><span className="public-flow-index">02</span><div><strong>Research</strong><small>Evidence is gathered before any outreach or promise.</small></div><b>grounded</b></li>
              <li><span className="public-flow-index">03</span><div><strong>Review</strong><small>An operator sees the brief, evidence, and next safe action.</small></div><b>human</b></li>
              <li><span className="public-flow-index">04</span><div><strong>Ship</strong><small>Build and payment actions stay explicit and auditable.</small></div><b>gated</b></li>
            </ol>
            <div className="public-workflow-footer"><span>no invisible handoffs</span><span>refresh-safe status</span></div>
          </div>
        </section>

        <section className="public-band public-band-intro" id="how-it-works" aria-labelledby="how-title">
          <div className="public-section-label">01 / how it works</div>
          <div>
            <h2 id="how-title">A small-business agency with a visible trail.</h2>
            <p>Every handoff has a state, a durable record, and a next action. You can follow the request without guessing whether a message was sent, a job disappeared, or a build was only a mock.</p>
          </div>
          <div className="public-trail-grid">
            <article><span>01</span><h3>Describe the gap</h3><p>Tell us what the business does and where it serves customers. Add context when it matters.</p></article>
            <article><span>02</span><h3>Get a private link</h3><p>Your tracking page is scoped to a random token and shows only your request state.</p></article>
            <article><span>03</span><h3>Choose the next move</h3><p>An operator reviews research before any call, invoice, or build action can run.</p></article>
          </div>
        </section>

        <section className="public-band public-band-contrast" id="use-cases" aria-labelledby="use-title">
          <div className="public-section-label">02 / who it is for</div>
          <div className="public-use-copy">
            <h2 id="use-title">For teams that win work on the phone, in the neighborhood, and between jobs.</h2>
            <p>Callan is tuned for local service businesses where a clear offer and a reliable next step matter more than a giant marketing site.</p>
          </div>
          <div className="public-use-list">
            <div><strong>HVAC + plumbing</strong><span>Make the urgent path obvious before a customer calls three competitors.</span></div>
            <div><strong>Salons + barbers</strong><span>Turn availability, services, and local proof into a usable first visit.</span></div>
            <div><strong>Restaurants + studios</strong><span>Give a visitor the hours, offer, and reservation action they came for.</span></div>
          </div>
        </section>

        <section className="public-request" id="request" aria-labelledby="request-title">
          <div className="public-request-heading">
            <div className="public-section-label">03 / start a request</div>
            <h2 id="request-title">Put the real business in the queue.</h2>
            <p>We save this brief first. You get a tracking link immediately. The operator console keeps research, outreach, payment, and build decisions separate.</p>
          </div>
          <form className="public-intake-form" onSubmit={submit} noValidate>
            <div className="public-form-grid">
              <label><span>Business name <b>*</b></span><input name="businessName" value={form.businessName} onChange={update('businessName')} required minLength="2" maxLength="160" placeholder="Luna Ridge HVAC" /></label>
              <label><span>What do you do? <b>*</b></span><input name="niche" value={form.niche} onChange={update('niche')} required minLength="2" maxLength="80" placeholder="Heating and cooling" /></label>
              <label><span>City or service area <b>*</b></span><input name="city" value={form.city} onChange={update('city')} required minLength="2" maxLength="120" placeholder="Oakland, CA" /></label>
              <label><span>Current website</span><input name="website" value={form.website} onChange={update('website')} maxLength="320" placeholder="https://example.com" inputMode="url" /></label>
              <label><span>Best phone</span><input name="phone" value={form.phone} onChange={update('phone')} maxLength="40" placeholder="(510) 555-0142" inputMode="tel" /></label>
              <label><span>Reply email</span><input name="email" value={form.email} onChange={update('email')} maxLength="320" placeholder="you@business.com" inputMode="email" /></label>
            </div>
            <label className="public-form-notes"><span>What should improve?</span><textarea name="notes" value={form.notes} onChange={update('notes')} maxLength="2000" rows="4" placeholder="More calls, clearer services, better mobile booking..." /></label>
            <label className="public-consent"><input type="checkbox" name="consent" checked={form.consent} onChange={update('consent')} required /><span>I confirm this is my business or I am authorized to request a review. No outbound message starts from this form.</span></label>
            <div className="public-form-submit"><button className="public-button public-button-primary" type="submit" disabled={state.status === 'submitting'}>{state.status === 'submitting' ? 'Saving...' : 'Create my tracking link'} <span aria-hidden="true">-&gt;</span></button><span className="public-form-status" role="status" aria-live="polite">{statusCopy}</span></div>
          </form>
        </section>

        <section className="public-faq" aria-labelledby="faq-title">
          <div className="public-section-label">04 / clear boundaries</div>
          <h2 id="faq-title">Questions we answer before you start.</h2>
          <details><summary>Does submitting this start a cold call?</summary><p>No. It creates a request and a non-callable lead record. An operator must review and explicitly start any later action.</p></details>
          <details><summary>What does the tracking page show?</summary><p>Only your business name, city, request state, and safe progress messages. Contact details stay in the operator workspace.</p></details>
          <details><summary>Is the site build live?</summary><p>The console labels mock, sandbox, and live states separately. Provider credentials and release gates are required before production side effects.</p></details>
        </section>

        <section className="public-legal" id="terms" aria-labelledby="terms-title">
          <div><h2 id="terms-title">Terms</h2><p>Callan records the brief you submit so an operator can evaluate it. A request is not a promise of a build, a price, or a marketing result.</p></div>
          <div id="privacy"><h2>Privacy</h2><p>Contact details are used for the requested review workflow. Tracking links use random tokens; the token hash is stored server-side and outbound actions require separate authorization.</p></div>
        </section>
      </main>

      <footer className="public-footer">
        <a className="public-brand" href="/"><span className="public-brand-mark">*</span><span>Callan</span></a>
        <span>Visible work for local businesses.</span>
        <div><a href="#terms">Terms</a><a href="#privacy">Privacy</a><a href="/app">Operator console</a></div>
      </footer>
    </div>
  );
}
