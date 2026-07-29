'use strict';

// Per-user WhatsApp sessions.
//
// One lab account = one WhatsApp session = one linked device. Each user's session
// gets its own DATA_DIR (`data/users/<key>/`), so whatsapp-web.js writes an entirely
// separate `wwebjs_auth` profile per user. Nothing is shared: A cannot see B's
// chats, list B's scheduled messages, or send from B's number.
//
// LAZY BY DESIGN. Every live session is a headless Chromium holding a WhatsApp Web
// page open — roughly 700MB of RSS. We therefore start a user's session only when
// there is a reason to: they opened the page, or they have a pending message that
// has to go out. A user who never visits costs nothing.
//
// Once started a session STAYS up, because the scheduler needs the device online at
// the moment a message is due — a session that idled out would simply fail to send.

const path = require('path');
const { userKey, normalizeEmail } = require('./users');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {object} [opts.env] - process.env, or a compatible object.
 * @param {function} [opts.createProvider] - provider factory (injectable for tests).
 * @param {function} [opts.onStart] - called with each session as it first starts.
 */
function createSessionManager({ env = process.env, createProvider, onStart } = {}) {
  const baseDir = env.DATA_DIR || './data';
  const sessions = new Map(); // key -> session

  // Resolved lazily, and only when no factory was injected: requiring the real
  // provider drags in whatsapp-web.js + puppeteer, and this module must stay
  // importable (and testable) in a bare Node container that has neither.
  const makeProvider = createProvider || ((e) => require('./providers').getProvider(e));

  /**
   * Get (creating if needed) the session for a user key. Creating a session is
   * cheap — it constructs the provider but launches nothing until start().
   *
   * Keyed by the user key rather than the email so the scheduler can reach a
   * user's session from a stored record alone, without knowing who they are.
   */
  function forKey(key) {
    if (!key) return null;
    let session = sessions.get(key);
    if (session) return session;

    const dir = path.join(baseDir, 'users', key);
    session = {
      key,
      email: null, // filled in when we learn it, i.e. on a real request
      dir,
      provider: makeProvider({ ...env, DATA_DIR: dir }),
      started: false,
      startedAt: null,
      initError: null,
      lastSeen: Date.now(),
    };
    sessions.set(key, session);
    return session;
  }

  /** Get the session for a signed-in email, remembering the address for display. */
  function forEmail(email) {
    const key = userKey(email);
    if (!key) return null;
    const session = forKey(key);
    session.email = normalizeEmail(email);
    session.lastSeen = Date.now();
    return session;
  }

  /**
   * Launch this session's WhatsApp client if it isn't already running.
   *
   * Deliberately NOT awaited by request handlers: initialize() can take many
   * seconds (Chromium boot, then WhatsApp Web) and the status endpoint should
   * answer immediately with "not connected yet" so the page can poll.
   */
  function start(session) {
    if (!session || session.started) return session;
    session.started = true;
    session.startedAt = Date.now();
    session.initError = null;
    session.initPromise = Promise.resolve()
      .then(() => session.provider.init())
      .then(() => {
        if (typeof onStart === 'function') onStart(session);
      })
      .catch((err) => {
        session.initError = String((err && err.message) || err);
        // Let a later visit (or the scheduler) try again rather than wedging
        // this user's session for the lifetime of the process.
        session.started = false;
      });
    return session;
  }

  /**
   * Replace a session's browser with a fresh one.
   *
   * The linked device lives in `wwebjs_auth` on disk, not in the browser, so a
   * relaunch reconnects in seconds without a new QR scan.
   */
  async function restart(session) {
    if (!session) return null;
    try {
      if (typeof session.provider.destroy === 'function') await session.provider.destroy();
    } catch (_e) {
      // A wedged browser may refuse to close; we drop the reference regardless.
    }
    session.provider = makeProvider({ ...env, DATA_DIR: session.dir });
    session.started = false;
    session.startedAt = null;
    session.initError = null;
    session.initPromise = null;
    return start(session);
  }

  /**
   * Confirm the session's page is answering, and rebuild it if it is not.
   *
   * Call this before anything that talks to the page. `connected` alone is not
   * evidence: it is latched at the 'ready' event and never re-examined, so a
   * session whose renderer has died still reports itself healthy. That is
   * exactly what happened — two days of connected:true while every send failed
   * on a protocol timeout and the message list 500'd.
   *
   * @returns {Promise<boolean>} true if the session is usable when this returns.
   */
  async function ensureAlive(session, { waitMs = 60000 } = {}) {
    if (!session) return false;
    start(session);
    if (typeof session.provider.ping !== 'function') return true; // provider can't be probed
    const status = session.provider.getStatus();
    // Not connected yet is a different situation — it is still booting, or the
    // device was never linked. Nothing to recover.
    if (!status || !status.connected) return false;
    if (await session.provider.ping()) return true;

    console.warn(`[sessions] ${session.key} stopped answering — restarting its browser`);
    await restart(session);
    return waitConnected(session, waitMs);
  }

  /**
   * Wait for a session's device to be linked and online, starting it if needed.
   *
   * The scheduler uses this: a message may come due while its owner's session is
   * still booting (we just restarted) or has never been started at all. Waiting a
   * bounded time turns "not up YET" into a successful send instead of a permanent
   * failure, while a genuinely unlinked account still fails with a clear reason.
   *
   * @returns {Promise<boolean>} true if connected within the timeout.
   */
  async function waitConnected(session, timeoutMs = 90000, pollMs = 1000) {
    if (!session) return false;
    start(session);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let status;
      try {
        status = session.provider.getStatus();
      } catch (_e) {
        status = null;
      }
      if (status && status.connected) return true;
      if (Date.now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  function statusOf(session) {
    const s = session.provider.getStatus();
    return {
      provider: s.provider,
      connected: !!s.connected,
      qr: s.qr,
      me: s.me,
      user: session.email,
      starting: session.started && !s.connected,
      error: session.initError || undefined,
    };
  }

  return {
    forKey,
    forEmail,
    start,
    restart,
    ensureAlive,
    waitConnected,
    statusOf,
    /** Live sessions, for diagnostics. */
    list: () => [...sessions.values()],
  };
}

module.exports = { createSessionManager };
