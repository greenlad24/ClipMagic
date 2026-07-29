'use strict';

// Opaque chat references.
//
// A WhatsApp chat id is often a phone number ("447911123456@c.us"), so writing
// one into messages.json would put real numbers on disk. Instead we persist an
// HMAC of the id and resolve it back to a live chat only at send time, from
// WhatsApp's own session — so the scheduler's database holds no numbers at all.
//
// The HMAC is keyed, not a bare hash: phone numbers are low-entropy enough to
// enumerate, so an unkeyed digest would be trivially reversible.
//
// Scope of the guarantee: this covers data THIS app writes. WhatsApp Web's own
// profile (wwebjs_auth/) inevitably contains the account's contacts and chats —
// that is what being a linked device means, and no change here alters it.

const crypto = require('crypto');

const PREFIX = 'ref_';

function secret(env = process.env) {
  // A dedicated key if provided, else the API token (stable across restarts,
  // which matters: a rotating key would orphan every pending message).
  return env.WA_REF_SECRET || env.API_TOKEN || 'whatsapp-scheduler-local-dev';
}

/**
 * @param {string} chatId
 * @param {object} [env]
 * @param {string} [scope] - the owning user's key. Refs are salted per user so
 *   the same contact yields a different ref for each lab account, and a ref
 *   minted for one account is meaningless in another. Omit it to reproduce the
 *   pre-per-user (unsalted) ref, which is how legacy records stay resolvable.
 * @returns {string} stable opaque reference for a chat id.
 */
function makeRef(chatId, env = process.env, scope = '') {
  const mac = crypto.createHmac('sha256', secret(env));
  // The NUL separator keeps ("ab", "c") from colliding with ("a", "bc").
  if (scope) mac.update(String(scope)).update('\0');
  return PREFIX + mac.update(String(chatId)).digest('hex').slice(0, 32);
}

function isRef(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { makeRef, isRef, PREFIX };
