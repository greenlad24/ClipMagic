'use strict';

// Personal provider — backed by whatsapp-web.js (a QR-linked WhatsApp Web
// session driven by puppeteer). Lets you message any contact with free text.
//
// NOTE ON ToS: linking a personal number via whatsapp-web.js is unofficial and
// can risk a ban. The business provider is the official path. See README.
//
// These packages (whatsapp-web.js, qrcode, qrcode-terminal) are expected to be
// installed by the integrator; this file is validated with `node --check` only.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode'); // for data-URL PNG rendering
const qrcodeTerminal = require('qrcode-terminal'); // for terminal print

const TRIGGER_RE = /^\/(schedule|sched|s)\b/i;

/**
 * @param {object} env - process.env
 * @returns {object} provider instance implementing the shared contract.
 */
function createPersonalProvider(env = process.env) {
  const dataDir = env.DATA_DIR || './data';

  const state = {
    connected: false,
    qr: null, // data-URL PNG while awaiting scan, else null
    me: null, // our own number (digits) once ready
  };

  let inboundHandler = null;

  const puppeteer = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  if (env.WA_CHROME_PATH) {
    puppeteer.executablePath = env.WA_CHROME_PATH;
  }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: `${dataDir}/wwebjs_auth` }),
    puppeteer,
  });

  // ---- events ----------------------------------------------------------

  client.on('qr', (qr) => {
    state.connected = false;
    // Print an ASCII QR to the terminal for convenience.
    try {
      qrcodeTerminal.generate(qr, { small: true });
    } catch (_e) {
      // non-fatal: terminal may not support it
    }
    // Render a scannable PNG data-URL for the web UI.
    qrcode
      .toDataURL(qr)
      .then((url) => {
        state.qr = url;
      })
      .catch(() => {
        state.qr = null;
      });
  });

  const markReady = () => {
    state.connected = true;
    state.qr = null; // no longer awaiting a scan
    try {
      if (client.info && client.info.wid) {
        state.me = client.info.wid.user;
      }
    } catch (_e) {
      // client.info may not be populated yet on 'authenticated'
    }
  };

  client.on('authenticated', markReady);
  client.on('ready', markReady);

  client.on('disconnected', () => {
    state.connected = false;
    state.me = null;
  });

  // Fires for every message including our own (fromMe). We only act on our own
  // outbound messages that begin with a scheduling trigger, so typing a command
  // in any chat schedules a send. Our confirmation replies don't start with a
  // trigger, so we won't react to those.
  client.on('message_create', async (msg) => {
    try {
      if (!msg || !msg.fromMe) return;
      const body = (msg.body || '').trim();
      if (!TRIGGER_RE.test(body)) return;
      if (!inboundHandler) return;

      // The recipient chat's number digits: msg.to like "447911123456@c.us".
      const fromChatNumber = String(msg.to || '').replace(/@c\.us$/i, '');

      const reply = await inboundHandler({ body, fromChatNumber });
      if (reply != null && reply !== '') {
        if (typeof msg.reply === 'function') {
          await msg.reply(reply);
        } else {
          const chatId = msg.to || `${fromChatNumber}@c.us`;
          await client.sendMessage(chatId, reply);
        }
      }
    } catch (_e) {
      // Never let an inbound-handler error crash the client.
    }
  });

  // ---- contract --------------------------------------------------------

  return {
    name: 'personal',

    async init() {
      await client.initialize();
    },

    getStatus() {
      return {
        provider: 'personal',
        connected: state.connected,
        qr: state.qr,
        me: state.me,
      };
    },

    async sendMessage(to, text) {
      if (!state.connected) {
        throw new Error('personal provider not connected (scan the QR first)');
      }
      await client.sendMessage(`${to}@c.us`, text);
    },

    onInboundCommand(handler) {
      inboundHandler = handler;
    },
  };
}

module.exports = createPersonalProvider;
