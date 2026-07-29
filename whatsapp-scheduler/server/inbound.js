'use strict';

// The inbound `/schedule` command handler — the core of the product.
// Extracted from index.js as an injectable factory so it can be unit-tested
// without a live WhatsApp session or Express server.

const { isWeekend, parseChatCommand } = require('./schedule-logic');

/**
 * Build the handler a provider calls when the user types a `/schedule` command
 * in a chat. Parses the command, persists a pending record, and returns the
 * reply text (with a weekend → Monday nudge when the target lands on Sat/Sun).
 *
 * @param {object} deps
 * @param {object} deps.store        - store module (needs makeId + insert)
 * @param {string} deps.providerName - "personal" | "business"
 * @param {string} [deps.owner]      - key of the lab account this session belongs
 *   to; stamped on the record so the scheduler sends it from that user's device.
 * @param {() => number} [deps.now]  - clock, injectable for tests
 * @returns {(msg: {body: string, fromChatNumber: string}) => Promise<string>}
 */
function createInboundHandler({
  store,
  providerName,
  owner,
  now = () => Date.now(),
  // Maps a chat id to an opaque reference before it is persisted, so no phone
  // number reaches disk. Identity by default to keep the unit tests provider-
  // and crypto-free.
  toRef = (chatId) => chatId,
}) {
  return async function handleInbound({ body, fromChatNumber, fromChatId, chatLabel }) {
    const parsed = parseChatCommand(body, now(), {
      defaultChatNumber: fromChatNumber,
      // Preferred over defaultChatNumber when present: addresses the chat by its
      // real id, which may be a LID rather than a phone number.
      defaultChatId: fromChatId,
      defaultChatLabel: chatLabel,
    });
    if (!parsed.ok) {
      return '⚠️ ' + (parsed.error || 'Could not understand that command.');
    }

    const record = {
      id: store.makeId(),
      owner,
      to: toRef(parsed.to),
      text: parsed.text,
      when: parsed.when,
      status: 'pending',
      provider: providerName,
      source: 'chat',
      createdAt: now(),
    };
    await store.insert(record);

    const whenDate = new Date(parsed.when);
    // The recipient is named explicitly because the personal provider delivers
    // this confirmation to your OWN chat, out of the target conversation — so
    // "scheduled for 9am" alone would leave you guessing who it goes to.
    let reply =
      '✅ Scheduled for ' +
      whenDate.toLocaleString() +
      '\n→ to ' + (parsed.toDisplay || parsed.to) +
      '\n💬 ' + parsed.text;

    // Weekend nudge — still schedule what they asked, but suggest Monday.
    if (isWeekend(whenDate)) {
      const dayName = whenDate.toLocaleDateString(undefined, { weekday: 'long' });
      reply +=
        "\n📅 That's a " +
        dayName +
        ' — reply with `/schedule monday 9am: ' +
        parsed.text +
        '` to send Monday instead.';
    }
    return reply;
  };
}

module.exports = { createInboundHandler };
