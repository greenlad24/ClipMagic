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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const warn = (...a) => console.warn('[personal]', ...a);

  /**
   * Revoke (delete-for-everyone) one of our own messages, reliably.
   *
   * Two traps in whatsapp-web.js's Message.delete():
   *  1. It re-finds the message inside the page by serialized id. Straight after
   *     send that lookup can miss — the id is still local/unacked — and the page
   *     function throws. So we retry with backoff instead of giving up once.
   *  2. If WhatsApp says the message cannot be revoked, delete(true) SILENTLY
   *     degrades to delete-for-me. That is the worst outcome: it vanishes from
   *     our side while the recipient keeps it, and nothing throws — we would
   *     report success while leaking. So we ask WhatsApp's own capability check
   *     first and refuse to call delete() unless a real revoke is permitted.
   *
   * @returns {Promise<boolean>} true only if a genuine revoke was issued.
   */
  async function revokeForEveryone(msg) {
    const id = msg && msg.id && msg.id._serialized;
    if (!id) return false;

    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt) await sleep(400);
      try {
        // null = not registered in the page's Msg collection yet, so retry.
        const canRevoke = await client.pupPage.evaluate(async (mid) => {
          const Collections = window.require('WAWebCollections');
          const m =
            Collections.Msg.get(mid) ||
            (await Collections.Msg.getMessagesById([mid]))?.messages?.[0];
          if (!m) return null;
          const cap = window.require('WAWebMsgActionCapability');
          return !!(cap.canSenderRevokeMsg(m) || cap.canAdminRevokeMsg(m));
        }, id);

        if (canRevoke === null) continue; // not there yet
        if (canRevoke === false) {
          warn('revoke refused by WhatsApp for', id);
          return false;
        }

        await msg.delete(true);
        return true;
      } catch (e) {
        // Internal module names can shift between WhatsApp Web builds; on the
        // last attempt fall back to a plain revoke rather than never trying.
        if (attempt === 9) {
          try {
            await msg.delete(true);
            return true;
          } catch (e2) {
            warn('revoke failed:', (e2 && e2.message) || e2);
            return false;
          }
        }
      }
    }
    warn('revoke gave up (message never became revocable):', id);
    return false;
  }

  /** Best-effort human name for a chat, for the out-of-band confirmation. */
  async function resolveChatLabel(msg, chatId) {
    try {
      if (typeof msg.getChat === 'function') {
        const chat = await msg.getChat();
        if (chat && (chat.name || chat.formattedTitle)) {
          return String(chat.name || chat.formattedTitle);
        }
      }
    } catch (e) {
      warn('getChat failed:', (e && e.message) || e);
    }
    try {
      if (chatId && typeof client.getChatById === 'function') {
        const chat = await client.getChatById(chatId);
        if (chat && (chat.name || chat.formattedTitle)) {
          return String(chat.name || chat.formattedTitle);
        }
      }
    } catch (e) {
      warn('getChatById failed:', (e && e.message) || e);
    }
    try {
      if (typeof client.getContactById === 'function' && chatId) {
        const c = await client.getContactById(chatId);
        const name = c && (c.name || c.pushname || c.shortName || c.number);
        if (name) return String(name);
      }
    } catch (e) {
      warn('getContactById failed:', (e && e.message) || e);
    }
    return null;
  }

  const puppeteer = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    // Puppeteer's default is 180s. When the WhatsApp Web page stops answering
    // CDP — which it does, silently, after days of uptime — every call blocks
    // for that full three minutes before throwing. One wedged page then hangs
    // the message list, the chat picker and any send that comes due. Failing in
    // 45s lets the caller notice and restart the session instead of timing out
    // a user's page load.
    protocolTimeout: Number(env.WA_PROTOCOL_TIMEOUT_MS) || 45000,
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
  //
  // KEEPING THE COMMAND PRIVATE. WhatsApp has no "type but don't send" hook: to
  // observe the command at all we must let it be sent, so by the time we see it
  // the recipient already has it. Two things keep the conversation clean:
  //   1. we revoke (delete-for-everyone) the command message immediately, and
  //   2. the ✅/⚠️ confirmation goes to YOUR OWN chat, never the recipient's —
  //      replying in their chat would announce the scheduling as loudly as the
  //      command did.
  // The recipient is left with only the scheduled message, delivered at its
  // scheduled time. Caveat: revoke cannot un-ring a push notification, so a
  // recipient watching their phone may glimpse the command. The airtight
  // workflow is to type commands in your own "Message Yourself" chat using
  // `to <number>` — then nothing reaches them early at all.
  client.on('message_create', async (msg) => {
    try {
      if (!msg || !msg.fromMe) return;
      const body = (msg.body || '').trim();
      if (!TRIGGER_RE.test(body)) return;
      if (!inboundHandler) return;

      // The chat this was typed in, kept VERBATIM — it may be "447911…@c.us"
      // or a LID like "136567125496059@lid", and only the former is a number.
      const fromChatId = String(msg.to || '');
      const fromChatNumber = /@c\.us$/i.test(fromChatId)
        ? fromChatId.replace(/@c\.us$/i, '')
        : null;

      // A human name for the confirmation — it now arrives in your own chat,
      // where "to 136567125496059@lid" would tell you nothing.
      const chatLabel = await resolveChatLabel(msg, fromChatId);
      // Our own chat ("Message Yourself"), where confirmations belong.
      const selfChatId = state.me ? `${state.me}@c.us` : msg.from;
      // A command typed in our own chat was never exposed to anyone.
      const isSelfChat = String(msg.to || '') === String(selfChatId);

      const reply = await inboundHandler({
        body,
        fromChatNumber,
        fromChatId,
        chatLabel,
      });

      const unsent = isSelfChat ? true : await revokeForEveryone(msg);

      if (reply != null && reply !== '') {
        let note = reply;
        if (!isSelfChat && !unsent) {
          note += '\n⚠️ Could not unsend the command in that chat — delete it manually.';
        }
        // Deliberately NOT msg.reply(): that posts into the recipient's chat
        // (and would quote a message we just revoked).
        await client.sendMessage(selfChatId, note);
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

    /**
     * Is the page actually answering, right now?
     *
     * `connected` is latched at the 'ready' event and never re-checked, so it
     * stays true long after the page has stopped responding — a session sat at
     * connected:true for two days while every send and every chat lookup timed
     * out against a dead renderer. This asks the page a trivial question with a
     * short deadline; anything other than a prompt answer means wedged.
     */
    async ping(timeoutMs = 10000) {
      if (!state.connected || !client.pupPage) return false;
      try {
        const answer = await Promise.race([
          client.pupPage.evaluate(() => 1),
          new Promise((_r, reject) => setTimeout(() => reject(new Error('ping timeout')), timeoutMs)),
        ]);
        return answer === 1;
      } catch (_e) {
        return false;
      }
    },

    /** Tear the browser down so a fresh session can be launched in its place. */
    async destroy() {
      state.connected = false;
      state.qr = null;
      try {
        await client.destroy();
      } catch (_e) {
        // Already gone, or too wedged to close cleanly — the caller is
        // replacing this provider either way.
      }
    },

    async sendMessage(to, text) {
      if (!state.connected) {
        throw new Error('personal provider not connected (scan the QR first)');
      }
      // `to` is either a full chat id captured from the chat the command was
      // typed in ("…@lid" / "…@c.us"), or bare digits from an explicit
      // `to <number>`. Only the latter needs the @c.us suffix.
      const chatId = String(to).includes('@') ? String(to) : `${to}@c.us`;
      await client.sendMessage(chatId, text);
    },

    onInboundCommand(handler) {
      inboundHandler = handler;
    },

    /**
     * Recent chats, for the web composer's recipient picker. Returning the
     * chat's REAL id (…@c.us / …@lid / …@g.us) is the whole point: picking a
     * recipient here never touches their conversation, and the id sidesteps the
     * LID-vs-phone-number ambiguity entirely.
     *
     * We read the page's Chat collection DIRECTLY rather than using
     * client.getChats(). On WhatsApp Web 2.3000.x that helper maps every chat
     * through WWebJS.getChatModel(), which for at least one chat here queries
     * IndexedDB with an undefined key and throws
     *   "Failed to execute 'get' on 'IDBObjectStore': No key or key range specified"
     * — and because it uses Promise.all, ONE bad chat rejects the whole call and
     * the picker silently shows nothing. Reading the plain model fields we
     * actually need cannot hit that path, and a single unreadable chat is
     * skipped instead of losing all 500.
     */
    async listChats() {
      if (!state.connected) return [];
      const chats = await client.pupPage.evaluate(() => {
        const C = window.require('WAWebCollections');
        if (!C || !C.Chat) return [];
        const out = [];
        for (const c of C.Chat.getModelsArray()) {
          try {
            const id = c.id && (c.id._serialized || String(c.id));
            if (!id) continue;
            const name =
              c.formattedTitle ||
              c.name ||
              (c.contact && (c.contact.pushname || c.contact.name)) ||
              (c.id && c.id.user) ||
              '';
            out.push({
              id: String(id),
              name: String(name),
              // The raw Chat model doesn't carry isGroup on this build; the
              // "@g.us" suffix is the dependable signal.
              isGroup: /@g\.us$/i.test(String(id)),
              timestamp: Number(c.t) || 0,
              archived: !!c.archive,
            });
          } catch (_e) {
            // Skip just this chat.
          }
        }
        return out;
      });

      return chats
        .filter((c) => c.id && !c.archived)
        .sort((a, b) => b.timestamp - a.timestamp);
    },
  };
}

module.exports = createPersonalProvider;
