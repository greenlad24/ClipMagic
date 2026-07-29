#!/usr/bin/env node
'use strict';

/*
 * One-off migration: single shared WhatsApp session → one session per lab user.
 *
 *   node scripts/migrate-per-user.js <email> [--dry-run]
 *
 * Before, the sidecar kept ONE WhatsApp Web profile at `data/wwebjs_auth` and one
 * flat `data/messages.json`, both implicitly shared by everyone who could sign in
 * to The Lab. Per-user sessions live at `data/users/<key>/wwebjs_auth`, and every
 * record carries the `owner` key of the account it belongs to.
 *
 * This hands the existing linked device and the existing records to ONE named
 * account — the person who actually scanned the QR — so they do not have to
 * re-link and their pending messages still fire. Every other account starts empty
 * and gets its own QR.
 *
 * Run with the service STOPPED: moving a WhatsApp profile out from under a live
 * Chromium is asking for a corrupted session.
 *
 * Idempotent — running it twice is a no-op.
 */

const fs = require('fs');
const path = require('path');
const { userKey, normalizeEmail } = require('../server/users');

function main(argv) {
  const args = argv.filter((a) => a !== '--dry-run');
  const dryRun = argv.includes('--dry-run');
  const email = normalizeEmail(args[0]);

  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/migrate-per-user.js <email> [--dry-run]');
    console.error('  <email> — the lab account that owns the CURRENTLY LINKED WhatsApp.');
    process.exit(2);
  }

  const dataDir = process.env.DATA_DIR || './data';
  const key = userKey(email);
  const userDir = path.join(dataDir, 'users', key);

  console.log(`data dir : ${path.resolve(dataDir)}`);
  console.log(`owner    : ${email} → ${key}`);
  if (dryRun) console.log('MODE     : dry run, nothing will be written\n');

  let moved = false;
  let claimed = 0;
  let alreadyOwned = 0;

  // --- 1. The WhatsApp Web profile -----------------------------------------
  const legacyAuth = path.join(dataDir, 'wwebjs_auth');
  const targetAuth = path.join(userDir, 'wwebjs_auth');

  if (fs.existsSync(legacyAuth)) {
    if (fs.existsSync(targetAuth)) {
      console.log(`SKIP  profile: ${targetAuth} already exists — leaving ${legacyAuth} in place.`);
    } else {
      console.log(`MOVE  profile: ${legacyAuth} → ${targetAuth}`);
      if (!dryRun) {
        fs.mkdirSync(userDir, { recursive: true });
        fs.renameSync(legacyAuth, targetAuth);
      }
      moved = true;
    }
  } else {
    console.log(`SKIP  profile: no ${legacyAuth} (nothing to migrate).`);
  }

  // --- 2. Stored records ----------------------------------------------------
  const messagesFile = path.join(dataDir, 'messages.json');
  if (fs.existsSync(messagesFile)) {
    const records = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
    if (!Array.isArray(records)) throw new Error(`${messagesFile} is not an array`);

    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.owner) {
        alreadyOwned++;
        continue;
      }
      rec.owner = key;
      claimed++;
    }

    console.log(
      `RECORDS: ${records.length} total · ${claimed} claimed · ${alreadyOwned} already owned`,
    );
    if (claimed && !dryRun) {
      // Same atomic write the store uses: a torn messages.json would lose
      // everyone's schedule, not just this migration.
      const tmp = `${messagesFile}.tmp.migrate.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
      fs.renameSync(tmp, messagesFile);
    }
  } else {
    console.log(`SKIP  records: no ${messagesFile}.`);
  }

  console.log(
    `\n${dryRun ? 'Would migrate' : 'Migrated'}: ` +
      `${moved ? 'linked device' : 'no device'} + ${claimed} record(s) → ${email}`,
  );
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error('Migration failed:', (err && err.message) || err);
  process.exit(1);
}
