import { EventEmitter } from 'node:events';
import { events as eventStore } from './db.js';

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(type, data = {}) {
  const event = { ts: Date.now(), ...data, type };
  eventStore.insert({
    type,
    lead_id: data.leadId || data.lead_id || null,
    worker: data.worker || null,
    payload: data
  });
  bus.emit('event', event);
  return event;
}

export function subscribe(handler) {
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

export function attachStream(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

  const send = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const off = subscribe(send);
  const heartbeat = setInterval(() => res.write(`: keep-alive\n\n`), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    off();
  });
}
