'use strict';

// server/scheduler.js — the tick loop that fires due pending messages.
// CommonJS, Node >= 18, no external dependencies.

// start({ store, send, intervalMs }) -> { stop() }
// `send(record)` is injected by index.js and must throw on failure.
function start({ store, send, intervalMs = 15000 } = {}) {
  if (!store || typeof send !== 'function') {
    throw new Error('scheduler.start requires { store, send }');
  }

  const inFlight = new Set();
  let timer = null;
  let stopped = false;

  async function handle(rec) {
    try {
      await send(rec);
      await store.update(rec.id, { status: 'sent', sentAt: Date.now() });
    } catch (e) {
      await store.update(rec.id, {
        status: 'failed',
        error: String((e && e.message) || e),
        failedAt: Date.now(),
      });
    } finally {
      inFlight.delete(rec.id);
    }
  }

  async function tick() {
    if (stopped) return;
    let records;
    try {
      records = await store.all();
    } catch (e) {
      return; // transient read error; try again next tick
    }
    const nowMs = Date.now();
    for (const rec of records) {
      if (
        rec &&
        rec.status === 'pending' &&
        typeof rec.when === 'number' &&
        rec.when <= nowMs &&
        !inFlight.has(rec.id)
      ) {
        inFlight.add(rec.id);
        handle(rec);
      }
    }
  }

  timer = setInterval(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { start };
