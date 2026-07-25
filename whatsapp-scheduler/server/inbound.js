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
 * @param {() => number} [deps.now]  - clock, injectable for tests
 * @returns {(msg: {body: string, fromChatNumber: string}) => Promise<string>}
 */
function createInboundHandler({ store, providerName, now = () => Date.now() }) {
  return async function handleInbound({ body, fromChatNumber }) {
    const parsed = parseChatCommand(body, now(), {
      defaultChatNumber: fromChatNumber,
    });
    if (!parsed.ok) {
      return '⚠️ ' + (parsed.error || 'Could not understand that command.');
    }

    const record = {
      id: store.makeId(),
      to: parsed.to,
      toDisplay: parsed.toDisplay || parsed.to,
      text: parsed.text,
      when: parsed.when,
      status: 'pending',
      provider: providerName,
      source: 'chat',
      createdAt: now(),
    };
    await store.insert(record);

    const whenDate = new Date(parsed.when);
    let reply = '✅ Scheduled for ' + whenDate.toLocaleString();

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
