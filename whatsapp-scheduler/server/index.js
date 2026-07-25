'use strict';

// WhatsApp Cloud Scheduler — Express API server.
// Owns: server/index.js and the public/ PWA front-end.
// Contract: see SPEC.md ("server/index.js" + "JSON API").

const fs = require('fs');
const path = require('path');
const express = require('express');

const { getProvider } = require('./providers');
const store = require('./store');
const scheduler = require('./scheduler');
const { createInboundHandler } = require('./inbound');

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

  // --- Provider + scheduler wiring ------------------------------------------
  const provider = getProvider(env);
  await provider.init();

  scheduler.start({
    store,
    send: (rec) => provider.sendMessage(rec.to, rec.text),
  });

  // Inbound chat commands: parse, persist, and reply with a confirmation.
  // The handler itself lives in ./inbound so it can be unit-tested.
  provider.onInboundCommand(
    createInboundHandler({ store, providerName: provider.name }),
  );

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

  // GET /api/status
  app.get('/api/status', (req, res) => {
    const s = provider.getStatus();
    res.json({
      provider: s.provider,
      connected: s.connected,
      qr: s.qr,
      me: s.me,
      authRequired: !!API_TOKEN,
    });
  });

  // GET /api/messages
  app.get('/api/messages', async (req, res, next) => {
    try {
      const messages = await store.all();
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/messages/:id/cancel
  app.post('/api/messages/:id/cancel', async (req, res, next) => {
    try {
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
        `(provider: ${provider.name})`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal startup error:', err);
  process.exit(1);
});
