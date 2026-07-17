import { EventEmitter } from 'node:events';
import { events as eventStore } from './db.js';
import { env } from './env.js';

const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(type, data = {}) {
  assertMockProvenanceAllowed(type, data);
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

export function assertMockProvenanceAllowed(type, data = {}, runMode = env.runMode) {
  const mockMarked = data?.mock === true || data?.mode === 'mock';
  if (mockMarked && runMode !== 'mock') {
    const err = new Error(`mock event ${type} is forbidden in RUN_MODE=${runMode}`);
    err.code = 'MOCK_PROVENANCE_VIOLATION';
    err.retryable = false;
    throw err;
  }
  return true;
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
