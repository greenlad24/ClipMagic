'use strict';

// Lab users → opaque, stable session keys.
//
// The scheduler is served inside The Lab behind Google Sign-In, and each signed-in
// email gets its OWN WhatsApp session: its own linked device, its own chats, its
// own scheduled messages. This module is the one place that turns an email into
// the key everything else is partitioned by (data directory, record owner, chat-ref
// salt).
//
// The key is a HASH, not the address itself: it ends up in directory names on disk
// and in the `owner` field of every stored record, and there is no reason for an
// email to sit in either. It is deliberately an UNKEYED sha256 — unlike chat refs
// (see chatref.js), which are HMACs because phone numbers are low-entropy enough to
// enumerate. Here stability beats obscurity: keying it to API_TOKEN would mean
// rotating that token orphans every user's linked device and pending messages.

const crypto = require('crypto');

const PREFIX = 'u_';

/** Canonical form of an email — addresses are case-insensitive in practice. */
function normalizeEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

/**
 * @param {string} email
 * @returns {string|null} stable opaque key for this user, or null if no email.
 */
function userKey(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return PREFIX + crypto.createHash('sha256').update(e).digest('hex').slice(0, 16);
}

/** True only if `key` looks like something userKey() produced. */
function isUserKey(value) {
  return typeof value === 'string' && new RegExp(`^${PREFIX}[0-9a-f]{16}$`).test(value);
}

/**
 * Does this stored record belong to this user?
 *
 * Records written before per-user sessions existed carry no `owner`; they are
 * nobody's until the migration assigns them, and deliberately NOT everybody's —
 * an unowned record must never surface in another user's list.
 */
function owns(record, key) {
  return !!record && !!key && record.owner === key;
}

module.exports = { normalizeEmail, userKey, isUserKey, owns, PREFIX };
