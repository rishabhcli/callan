import { useEffect, useRef, useState } from 'react';

const KNOWN_EVENTS = [
  'hello',
  'scraper.start', 'scraper.candidates', 'scraper.candidates.done',
  'scraper.profile', 'scraper.profile.skipped', 'scraper.session',
  'scraper.session.stopped', 'scraper.done', 'scraper.error',
  'lead.created',
  'caller.start', 'caller.placed', 'caller.transcript', 'caller.pitch_ready',
  'caller.done', 'caller.error',
  'pitch.created',
  'agentphone.webhook',
  'analyst.start', 'analyst.done', 'analyst.error',
  'mailer.start', 'mailer.payment_link', 'mailer.email_sent',
  'mailer.done', 'mailer.error',
  'builder.start', 'builder.live_url', 'builder.progress',
  'builder.project_url', 'builder.done', 'builder.error',
  'stripe.webhook', 'agentmail.webhook'
];

export function useSSE(onEvent) {
  const [status, setStatus] = useState('connecting');
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    const es = new EventSource('/api/events/stream');
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
  }, []);

  return status;
}
