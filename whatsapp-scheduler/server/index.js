'use strict';

// WhatsApp Cloud Scheduler — Express API server.
// Owns: server/index.js and the public/ PWA front-end.
// Contract: see SPEC.md ("server/index.js" + "JSON API").

const fs = require('fs');
const path = require('path');
const express = require('express');

const store = require('./store');
const scheduler = require('./scheduler');
const { createInboundHandler } = require('./inbound');
const { validateSchedule, parseWhen } = require('./schedule-logic');
const { makeRef, isRef } = require('./chatref');
const { createSessionManager } = require('./sessions');
const { normalizeEmail, owns } = require('./users');

// Header carrying the authenticated lab user. The Lab's /wa proxy sets it from
// the verified Google Sign-In session AND strips any inbound copy, so a browser
// cannot name itself; the sidecar has no published port, so nothing else can
// reach this app to try.
const USER_HEADER = 'x-lab-user';

// --- Tiny inline .env loader (no dotenv dependency) --------------------------
// Reads a `.env` file from the current working directory if present and sets
// any keys that are not already defined on process.env. Silently ignores a
// missing file. Supports `KEY=value`, `#` comments, blank lines, and simple
// single/double quoted values.
function loadEnvFile() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key) continue;
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (_err) {
    // No .env file (or unreadable) — rely on the real environment.
  }
}

async function main() {
  loadEnvFile();

  const env = process.env;
  const PORT = Number(env.PORT) || 3000;
  const HOST = env.HOST || '0.0.0.0';
  const API_TOKEN = env.API_TOKEN || '';

  // --- Per-user sessions ----------------------------------------------------
  //
  // Each signed-in lab account has its own WhatsApp session (own linked device,
  // own chats, own messages). Sessions are created lazily — a headless Chromium
  // per user is expensive, so nobody pays for an account that never visits.

  // In-chat `/schedule` commands are OFF by default. WhatsApp only lets us read
  // a command by first SENDING it, so the recipient's phone can buzz with it
  // before we can unsend — which defeats the point of scheduling. The web
  // composer has no such hole. Set WA_ENABLE_CHAT_COMMANDS=true to re-enable.
  const chatCommandsEnabled =
    String(env.WA_ENABLE_CHAT_COMMANDS || '').toLowerCase() === 'true';

  const sessions = createSessionManager({
    env,
    onStart(session) {
      if (!chatCommandsEnabled) return;
      // Bound to THIS session: a command typed on one user's phone schedules a
      // message owned by that user and sent from that user's device.
      session.provider.onInboundCommand(
        createInboundHandler({
          store,
          providerName: session.provider.name,
          owner: session.key,
          toRef: (chatId) => makeRef(chatId, env, session.key),
        }),
      );
    },
  });

  /** The signed-in user's session for this request, or null if unidentified. */
  function sessionFor(req) {
    // Set by The Lab's /wa proxy from the verified Google Sign-In session, which
    // also strips any client-supplied copy of this header. WA_DEFAULT_USER is a
    // standalone/dev fallback and is unset in the gated deployment.
    const header = req.headers[USER_HEADER];
    const email =
      normalizeEmail(Array.isArray(header) ? header[0] : header) ||
      normalizeEmail(env.WA_DEFAULT_USER);
    return email ? sessions.forEmail(email) : null;
  }

  // Live chat list, plus ref→chat-id resolution — both scoped to ONE user's
  // session. Chat ids exist only in memory here; nothing that reaches the store
  // or the browser carries one.
  async function liveChats(session) {
    // Every path that needs chats goes through here — the message list, the
    // recipient picker and the scheduler's ref resolution — so this is the one
    // place worth proving the page is alive. When it is healthy the probe costs
    // a millisecond; when it is not, this is what repairs it instead of leaving
    // a dead browser to fail every request until someone redeploys.
    await sessions.ensureAlive(session);
    const p = session.provider;
    return typeof p.listChats === 'function' ? await p.listChats() : [];
  }

  async function resolveRef(session, ref) {
    if (!isRef(ref)) return null;
    for (const c of await liveChats(session)) {
      if (makeRef(c.id, env, session.key) === ref) return c;
      // Written before refs were salted per user; still this user's to resolve
      // because it can only be reached via a record they own.
      if (makeRef(c.id, env) === ref) return c;
    }
    return null;
  }

  scheduler.start({
    store,
    send: async (rec) => {
      const session = sessions.forKey(rec.owner);
      if (!session) {
        throw new Error('This message is not linked to a lab account');
      }
      // The owner's device may still be booting (we restarted recently) or not
      // started at all. Wait a bounded time rather than failing something that
      // is merely not ready yet.
      if (!(await sessions.waitConnected(session))) {
        throw new Error('WhatsApp is not linked for this account');
      }
      // Connected is not the same as working. A session that has been up for
      // days can report itself healthy while its page answers nothing, and the
      // send then dies on a protocol timeout — which is precisely how a message
      // was lost. Prove the page responds, rebuilding it if not, BEFORE we
      // decide this message cannot be delivered.
      if (!(await sessions.ensureAlive(session))) {
        throw new Error('WhatsApp session is not responding for this account');
      }
      // Records store an opaque ref; turn it back into a real chat id at the
      // last possible moment, from WhatsApp's own session.
      if (isRef(rec.to)) {
        const chat = await resolveRef(session, rec.to);
        if (!chat) {
          throw new Error('Recipient chat is no longer available on this device');
        }
        return session.provider.sendMessage(chat.id, rec.text);
      }
      // Legacy record written before refs existed.
      return session.provider.sendMessage(rec.to, rec.text);
    },
  });

  // Bring up the sessions that have work waiting. Everyone else's starts when
  // they open the page — otherwise a restart would silently drop pending sends
  // for any user who happens not to be looking at the tab.
  try {
    const waiting = new Set(
      (await store.all())
        .filter((r) => r && r.status === 'pending' && r.owner)
        .map((r) => r.owner),
    );
    for (const key of waiting) sessions.start(sessions.forKey(key));
    if (waiting.size) {
      // eslint-disable-next-line no-console
      console.log(`[sessions] starting ${waiting.size} session(s) with pending messages`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[sessions] could not pre-start pending owners:', err.message);
  }

  // --- Express app ----------------------------------------------------------
  const app = express();
  app.use(express.json());

  // Optional bearer auth on /api/*. GET /api/status stays reachable without a
  // token but reveals only enough for the UI to prompt for one.
  function isAuthed(req) {
    if (!API_TOKEN) return true;
    const header = req.headers['authorization'] || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return !!match && match[1] === API_TOKEN;
  }

  app.use('/api', (req, res, next) => {
    if (isAuthed(req)) return next();
    if (req.method === 'GET' && req.path === '/status') {
      return res.json({ authRequired: true, connected: false });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  });

  // Identify the signed-in lab user. Everything below this line is scoped to
  // one account: its own WhatsApp session, chats, and scheduled messages.
  app.use('/api', (req, res, next) => {
    const session = sessionFor(req);
    if (!session) {
      return res.status(401).json({
        error: 'Sign in to The Lab to use the WhatsApp Scheduler.',
        signInRequired: true,
      });
    }
    req.waSession = session;
    next();
  });

  // GET /api/status — also the trigger that starts this user's session, so a
  // Chromium is launched only for accounts that actually open the page.
  app.get('/api/status', (req, res) => {
    const session = req.waSession;
    sessions.start(session);
    res.json({ ...sessions.statusOf(session), authRequired: !!API_TOKEN });
  });

  // GET /api/messages
  //
  // Recipient names are resolved LIVE from the WhatsApp session and attached
  // here; they are deliberately not persisted, so the stored record carries
  // neither a number nor a name.
  app.get('/api/messages', async (req, res, next) => {
    try {
      const session = req.waSession;
      // Only this account's messages — another user's are not ours to show.
      const stored = (await store.all()).filter((r) => owns(r, session.key));
      let byRef = null;
      if (stored.some((r) => isRef(r.to))) {
        // Names are a nicety; the list is the point. Resolving them talks to the
        // WhatsApp page, and when that page was wedged this threw and took the
        // ENTIRE list down with it — every scheduled message vanished from the
        // UI, including the failed one the user was trying to understand. A
        // name we cannot look up is "Chat unavailable", never an empty screen.
        try {
          byRef = new Map();
          for (const c of await liveChats(session)) {
            byRef.set(makeRef(c.id, env, session.key), c);
            byRef.set(makeRef(c.id, env), c); // pre-per-user refs
          }
        } catch (err) {
          console.warn('[api] could not resolve chat names:', (err && err.message) || err);
          byRef = null;
        }
      }
      const messages = stored.map((r) => {
        if (!isRef(r.to)) return r;
        const chat = byRef && byRef.get(r.to);
        return {
          ...r,
          toDisplay: chat ? chat.name || 'Unnamed chat' : 'Chat unavailable',
          isGroup: chat ? !!chat.isGroup : false,
        };
      });
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/chats — recipient picker for the web composer.
  //
  // Returns opaque refs, never chat ids: the browser has no reason to see a
  // phone number, and what it never receives it cannot send back to be stored.
  app.get('/api/chats', async (req, res, next) => {
    try {
      const session = req.waSession;
      const chats = (await liveChats(session)).map((c) => ({
        ref: makeRef(c.id, env, session.key),
        name: c.name || 'Unnamed chat',
        isGroup: !!c.isGroup,
      }));
      res.json({ chats });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/parse-when?q=monday+morning — resolve natural language to a time,
  // so the composer can preview exactly when a message will go out.
  app.get('/api/parse-when', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: false, error: 'Type when to send it.' });
    const when = parseWhen(q, new Date());
    if (!when || isNaN(when.getTime())) {
      return res.json({ ok: false, error: `Couldn't understand "${q}".` });
    }
    const ms = when.getTime();
    if (ms <= Date.now()) {
      return res.json({ ok: false, error: 'That time has already passed.' });
    }
    res.json({
      ok: true,
      when: ms,
      pretty: when.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  });

  // POST /api/messages — schedule from the web UI.
  //
  // This is the leak-free path: unlike an in-chat `/schedule` command (which
  // WhatsApp must actually SEND before we can read it), nothing here touches
  // the recipient's conversation until the scheduled moment.
  app.post('/api/messages', async (req, res, next) => {
    try {
      const session = req.waSession;
      const body = req.body || {};
      const ref = String(body.to || '').trim();
      const text = String(body.text || '').trim();
      const when = Number(body.when);

      // Only an opaque ref for a chat that still exists IN THIS USER'S OWN
      // session is acceptable. That is both the server-side enforcement of
      // "existing conversations only" (the UI having no free-text number field
      // is not, by itself, a control) and of account separation — a ref lifted
      // from another account resolves against nothing here.
      const chat = await resolveRef(session, ref);
      if (!chat) {
        return res
          .status(400)
          .json({ error: 'Pick a recipient from your existing chats.' });
      }

      const v = validateSchedule({ to: chat.id, text, when }, Date.now());
      if (!v.ok) {
        return res.status(400).json({ error: v.errors.join('; ') });
      }

      // Persist the REF, never the chat id, and no display name — the recipient
      // is re-resolved live whenever it needs to be shown or sent to.
      const record = {
        id: store.makeId(),
        owner: session.key,
        // Canonical (per-user salted) ref for the chat we just resolved — which
        // also upgrades a legacy ref in place.
        to: makeRef(chat.id, env, session.key),
        text,
        when,
        status: 'pending',
        provider: session.provider.name,
        source: 'web',
        createdAt: Date.now(),
      };
      await store.insert(record);
      res.status(201).json({ message: record });
    } catch (err) {
      next(err);
    }
  });

  /**
   * A record is only actionable by the account that owns it. Answering 404 (not
   * 403) for someone else's id is deliberate: a distinguishable response would
   * confirm that the id exists.
   */
  async function ownedRecord(req) {
    const rec = await store.get(req.params.id);
    return owns(rec, req.waSession.key) ? rec : null;
  }

  // POST /api/messages/:id/cancel
  app.post('/api/messages/:id/cancel', async (req, res, next) => {
    try {
      if (!(await ownedRecord(req))) return res.status(404).json({ error: 'Not found' });
      const updated = await store.update(req.params.id, { status: 'canceled' });
      if (!updated) return res.status(404).json({ error: 'Not found' });
      res.json({ message: updated });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/messages/:id
  app.delete('/api/messages/:id', async (req, res, next) => {
    try {
      if (!(await ownedRecord(req))) return res.status(404).json({ error: 'Not found' });
      const ok = await store.remove(req.params.id);
      res.json({ ok: !!ok });
    } catch (err) {
      next(err);
    }
  });

  // Serve the PWA front-end.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // JSON error fallback.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: String((err && err.message) || err) });
  });

  app.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(
      `WhatsApp Cloud Scheduler listening on http://${HOST}:${PORT} ` +
        `(provider: ${(env.WA_PROVIDER || 'personal').toLowerCase()}, ` +
        'one session per signed-in lab user)',
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
