import { useEffect, useRef, useState } from 'react';

const KNOWN_EVENTS = [
  'hello',
  'scraper.start', 'scraper.candidates', 'scraper.candidates.done',
  'scraper.profile', 'scraper.profile.skipped', 'scraper.session',
  'scraper.session.stopped', 'scraper.done', 'scraper.error',
  'lead.created', 'lead.priority_queued', 'lead.priority_duplicate', 'lead.priority_scored',
  'caller.start', 'caller.placed', 'caller.transcript', 'caller.state', 'caller.pitch_ready',
  'caller.callback_promised', 'caller.callback_promise_skipped', 'caller.callback_persist_failed',
  'caller.done', 'caller.error', 'caller.demo_mode.entered',
  'email_callback.queued', 'email_callback.duplicate', 'email_callback.placed',
  'email_callback.no_phone', 'email_callback.blocked', 'email_callback.failed',
  'pitch.created',
  'agentphone.webhook',
  'outreach.started', 'outreach.stopped', 'outreach.blocked',
  'outreach.calling', 'outreach.lead_blocked', 'outreach.lead_approved',
  'outreach.lead_opted_out', 'outreach.lead_retry_forced', 'outreach.error',
  'analyst.start', 'analyst.done', 'analyst.error',
  'analyst.growth_queued', 'analyst.growth_duplicate',
  'growth.start', 'growth.provider', 'growth.plan_generated', 'growth.plan_reused',
  'growth.plan_queued', 'growth.plan_duplicate',
  'growth.memory_stored', 'growth.memory_skipped', 'growth.followup_queued', 'growth.followup_duplicate',
  'growth.followup_sent', 'growth.followup_skipped', 'growth.followup_reused', 'growth.reply_classified', 'growth.error',
  'mailer.start', 'mailer.payment_link', 'mailer.invoice_link', 'mailer.invoice_blocked', 'mailer.email_sent',
  'mailer.inbound_message', 'mailer.auto_reply',
  'mailer.preview_kickoff', 'mailer.preview_builder_queued', 'mailer.preview_builder_duplicate', 'mailer.preview_build_sent',
  'mailer.done', 'mailer.error',
  'inbound.intake.updated',
  'builder.queued', 'builder.duplicate', 'builder.preview_queued', 'builder.preview_duplicate',
  'builder.hosting_upsell_queued', 'builder.hosting_upsell_duplicate',
  'builder.hosting_upsell_sent', 'builder.hosting_upsell_skipped',
  'builder.start', 'builder.submission_created', 'builder.live_url', 'builder.provider_action', 'builder.progress',
  'builder.project_url', 'builder.blocked_auth', 'builder.done', 'builder.error',
  'hosting_upsell.sent',
  'stripe.webhook', 'stripe.paid', 'agentmail.webhook',
  'scheduledCall.created', 'scheduledCall.replaced', 'scheduledCall.canceled',
  'scheduledCall.fired', 'scheduledCall.placed', 'scheduledCall.failed',
  'scheduledCall.brought_forward', 'scheduledCall.warming'
];

export function useSSE(onEvent) {
  const [status, setStatus] = useState('connecting');
  const [authVersion, setAuthVersion] = useState(0);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const es = new EventSource('/api/events/stream', { withCredentials: true });
    setStatus('connecting');

    const dispatch = (e) => {
      try {
        const payload = e.data ? JSON.parse(e.data) : {};
        handlerRef.current?.({ type: e.type, ...payload });
      } catch (err) {
        handlerRef.current?.({ type: e.type, _parseError: err.message });
      }
    };

    es.onopen = () => setStatus('connected');
    es.onerror = () => setStatus('closed');
    KNOWN_EVENTS.forEach((t) => es.addEventListener(t, dispatch));

    return () => {
      KNOWN_EVENTS.forEach((t) => es.removeEventListener(t, dispatch));
      es.close();
      setStatus('closed');
    };
  }, [authVersion]);

  useEffect(() => {
    const reconnect = () => setAuthVersion((version) => version + 1);
    window.addEventListener('callan-admin-token-changed', reconnect);
    return () => window.removeEventListener('callan-admin-token-changed', reconnect);
  }, []);

  return status;
}
