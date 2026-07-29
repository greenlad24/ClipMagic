'use strict';

// Per-user session separation: one lab account = one WhatsApp session, one set
// of chat refs, one set of scheduled messages. These are the invariants that
// keep one signed-in user out of another's WhatsApp.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { userKey, normalizeEmail, isUserKey, owns } = require('../server/users');
const { makeRef, isRef } = require('../server/chatref');
const { createSessionManager } = require('../server/sessions');

const A = 'jakedawsonbusiness@gmail.com';
const B = 'keith.graham244@gmail.com';
const ENV = { API_TOKEN: 'test-token-for-refs' };

// --- user keys --------------------------------------------------------------

test('userKey: stable, distinct per user, and case/whitespace insensitive', () => {
  assert.equal(userKey(A), userKey(A), 'must be stable across calls');
  assert.notEqual(userKey(A), userKey(B), 'different users must not collide');
  assert.equal(userKey('  JakeDawsonBusiness@Gmail.com '), userKey(A));
  assert.ok(isUserKey(userKey(A)));
});

test('userKey: no email survives into the key', () => {
  const key = userKey(A);
  assert.ok(!key.includes('jake'), 'key must not carry the address');
  assert.ok(!key.includes('@'));
});

test('userKey: nothing to key on yields null', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.equal(userKey(bad), null);
  }
  assert.equal(normalizeEmail(undefined), '');
});

// --- record ownership -------------------------------------------------------

test('owns: only the owning key matches', () => {
  const rec = { id: 'm_1', owner: userKey(A) };
  assert.equal(owns(rec, userKey(A)), true);
  assert.equal(owns(rec, userKey(B)), false);
});

test('owns: an unowned legacy record belongs to nobody, not everybody', () => {
  // Pre-migration records have no `owner`. The dangerous failure would be
  // treating that as a wildcard and showing them in every account's list.
  const legacy = { id: 'm_legacy' };
  assert.equal(owns(legacy, userKey(A)), false);
  assert.equal(owns(legacy, userKey(B)), false);
  assert.equal(owns(legacy, undefined), false);
});

// --- chat refs --------------------------------------------------------------

test('chat refs are salted per user: same contact, different ref', () => {
  const chatId = '972528397834@c.us';
  const refA = makeRef(chatId, ENV, userKey(A));
  const refB = makeRef(chatId, ENV, userKey(B));
  assert.ok(isRef(refA) && isRef(refB));
  assert.notEqual(refA, refB, 'a ref must not be portable between accounts');
  assert.equal(refA, makeRef(chatId, ENV, userKey(A)), 'must be stable');
});

test('chat refs: unscoped form is unchanged, so legacy records still resolve', () => {
  // Records written before per-user sessions hold an unsalted ref; resolution
  // falls back to this form, so it must keep producing the same value.
  const chatId = '136567125496059@lid';
  assert.equal(makeRef(chatId, ENV), makeRef(chatId, ENV, ''));
  assert.notEqual(makeRef(chatId, ENV), makeRef(chatId, ENV, userKey(A)));
});

test('chat refs: the scope separator prevents boundary collisions', () => {
  // Without a separator, scope "ab" + chat "c" would hash the same bytes as
  // scope "a" + chat "bc" — different users sharing a ref.
  assert.notEqual(makeRef('c', ENV, 'ab'), makeRef('bc', ENV, 'a'));
});

test('chat refs: no phone number survives into the ref', () => {
  const ref = makeRef('972528397834@c.us', ENV, userKey(A));
  assert.ok(!ref.includes('972528397834'));
});

// --- session manager --------------------------------------------------------

/** A provider stand-in, so no Chromium is launched by these tests. */
function fakeProviderFactory(calls) {
  return (env) => {
    calls.push(env.DATA_DIR);
    let connected = false;
    return {
      name: 'fake',
      init: async () => {
        connected = true;
      },
      getStatus: () => ({ provider: 'fake', connected, qr: null, me: null }),
      sendMessage: async () => {},
      onInboundCommand: () => {},
      listChats: async () => [],
    };
  };
}

// A provider that connects, then goes deaf — the real failure mode. `connected`
// stays true (it is latched at 'ready' and never re-examined) while the page
// answers nothing, which is how a session sat "healthy" for two days as every
// send timed out.
function deafProviderFactory(log) {
  let generation = 0;
  return () => {
    const gen = ++generation;
    let connected = false;
    log.push(`created#${gen}`);
    return {
      name: 'deaf',
      generation: gen,
      init: async () => {
        connected = true;
      },
      getStatus: () => ({ provider: 'deaf', connected, qr: null, me: null }),
      // Only the first browser is wedged; a replacement answers normally.
      ping: async () => gen > 1,
      destroy: async () => {
        connected = false;
        log.push(`destroyed#${gen}`);
      },
      sendMessage: async () => {},
      onInboundCommand: () => {},
      listChats: async () => [],
    };
  };
}

test('sessions: a session that stops answering is rebuilt, not trusted', async () => {
  const log = [];
  const mgr = createSessionManager({ env: { DATA_DIR: '/data' }, createProvider: deafProviderFactory(log) });
  const s = mgr.forEmail(A);
  mgr.start(s);
  await s.initPromise;

  // The symptom that fooled us: it claims to be fine.
  assert.equal(mgr.statusOf(s).connected, true, 'the wedged session still reports connected');
  const firstProvider = s.provider;

  assert.equal(await mgr.ensureAlive(s), true, 'must recover rather than give up');
  assert.notEqual(s.provider, firstProvider, 'the dead browser must be replaced');
  assert.deepEqual(log, ['created#1', 'destroyed#1', 'created#2']);

  // A healthy session must NOT be torn down on every check.
  const healthy = s.provider;
  assert.equal(await mgr.ensureAlive(s), true);
  assert.equal(s.provider, healthy, 'a responding session must be left alone');
  assert.equal(log.length, 3, 'no further restarts');
});

test('sessions: a never-linked account is not mistaken for a wedged one', async () => {
  // Nothing to recover here — no device has ever been linked, so restarting the
  // browser would just burn RAM and hide the real state from the user.
  const log = [];
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: () => ({
      name: 'unlinked',
      init: async () => {},
      getStatus: () => ({ provider: 'unlinked', connected: false, qr: 'data:...', me: null }),
      ping: async () => false,
      destroy: async () => log.push('destroyed'),
      listChats: async () => [],
      onInboundCommand: () => {},
    }),
  });
  const s = mgr.forEmail(A);
  assert.equal(await mgr.ensureAlive(s), false);
  assert.deepEqual(log, [], 'must not restart a session that was never connected');
});

test('sessions: each user gets a separate data directory', () => {
  const dirs = [];
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: fakeProviderFactory(dirs),
  });

  const a = mgr.forEmail(A);
  const b = mgr.forEmail(B);

  assert.notEqual(a.key, b.key);
  assert.equal(a.dir, path.join('/data', 'users', userKey(A)));
  assert.notEqual(a.dir, b.dir, 'profiles must not share a directory');
  assert.deepEqual(dirs, [a.dir, b.dir]);
});

test('sessions: the same user is one session, not one per request', () => {
  const dirs = [];
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: fakeProviderFactory(dirs),
  });

  const first = mgr.forEmail(A);
  const again = mgr.forEmail('  JAKEDAWSONBUSINESS@gmail.com ');
  assert.equal(first, again, 'must reuse the session, not launch a second client');
  assert.equal(dirs.length, 1, 'provider must be constructed once per user');
});

test('sessions: creating a session launches nothing until start()', async () => {
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: fakeProviderFactory([]),
  });

  // Lazy on purpose: a live session is a headless Chromium (~700MB), so an
  // account that never opens the page must never pay for one.
  const s = mgr.forEmail(A);
  assert.equal(s.started, false);
  assert.equal(s.provider.getStatus().connected, false);

  mgr.start(s);
  await s.initPromise;
  assert.equal(s.started, true);
  assert.equal(s.provider.getStatus().connected, true);
});

test('sessions: forKey reaches a session from a stored record alone', async () => {
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: fakeProviderFactory([]),
  });

  // The scheduler only has `rec.owner`, never the address — it must still be
  // able to find (and start) the right user's device.
  const record = { owner: userKey(B) };
  const s = mgr.forKey(record.owner);
  assert.equal(s.key, userKey(B));
  assert.equal(s.email, null, 'the key must not have to reveal who it is');
  assert.equal(await mgr.waitConnected(s, 2000, 5), true);
});

test('sessions: waitConnected gives up on a device that never links', async () => {
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: () => ({
      name: 'fake',
      init: async () => {},
      getStatus: () => ({ provider: 'fake', connected: false, qr: 'data:…', me: null }),
      sendMessage: async () => {},
      onInboundCommand: () => {},
      listChats: async () => [],
    }),
  });

  const s = mgr.forEmail(A);
  assert.equal(await mgr.waitConnected(s, 60, 10), false);
});

test('sessions: a failed launch is retryable, not a wedged account', async () => {
  let attempts = 0;
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: () => ({
      name: 'fake',
      init: async () => {
        attempts++;
        throw new Error('Chromium exploded');
      },
      getStatus: () => ({ provider: 'fake', connected: false, qr: null, me: null }),
      sendMessage: async () => {},
      onInboundCommand: () => {},
      listChats: async () => [],
    }),
  });

  const s = mgr.forEmail(A);
  mgr.start(s);
  await s.initPromise;
  assert.equal(s.started, false, 'must not stay "started" after a failed init');
  assert.match(s.initError, /Chromium exploded/);

  mgr.start(s);
  await s.initPromise;
  assert.equal(attempts, 2, 'a later visit must try again');
});

test('sessions: status reports the account, so the page can name it', () => {
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: fakeProviderFactory([]),
  });
  const status = mgr.statusOf(mgr.forEmail(B));
  assert.equal(status.user, B);
  assert.equal(status.connected, false);
});

test('sessions: an unidentified request gets no session at all', () => {
  const mgr = createSessionManager({
    env: { DATA_DIR: '/data' },
    createProvider: fakeProviderFactory([]),
  });
  assert.equal(mgr.forEmail(''), null);
  assert.equal(mgr.forEmail(undefined), null);
  assert.equal(mgr.forKey(null), null);
});
