import { AsyncLocalStorage } from 'node:async_hooks';

const durableJobContext = new AsyncLocalStorage();

export function runWithDurableJobContext(context, fn) {
  return durableJobContext.run(context || {}, fn);
}

export function currentDurableJobContext() {
  return durableJobContext.getStore() || null;
}
