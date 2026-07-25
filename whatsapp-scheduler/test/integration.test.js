'use strict';

// End-to-end test of the core feature, exercising the REAL modules the way
// index.js wires them: an inbound `/schedule` command is parsed and persisted
// by the store, then the scheduler fires it via an injected send(). No Express
// server or WhatsApp session involved.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the store at an isolated data dir BEFORE requiring it (lazy read).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sched-int-'));
process.env.DATA_DIR = TMP;

const store = require('../server/store');
const scheduler = require('../server/scheduler');
const { createInboundHandler } = require('../server/inbound');

// Fixed clocks (day-of-week verified): a Wednesday and a Saturday.
const WED = new Date('2026-07-22T12:00:00'); // Wednesday
const SAT = new Date('2026-07-25T10:00:00'); // Saturday

after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_e) {
    /* ignore */
  }
});

test('inbound: schedules a weekday message and persists it', async () => {
  const handle = createInboundHandler({
    store,
    providerName: 'personal',
    now: () => WED.getTime(),
  });

  const reply = await handle({
    body: '/s in 2h to +44 7911 123456: Hello there',
    fromChatNumber: '',
  });

  assert.match(reply, /^✅ Scheduled for /);
  assert.doesNotMatch(reply, /weekend|Saturday|Sunday|Monday instead/i);

  const all = await store.all();
  const rec = all.find((r) => r.text === 'Hello there');
  assert.ok(rec, 'record persisted');
  assert.strictEqual(rec.to, '447911123456', 'phone normalized to digits');
  assert.strictEqual(rec.status, 'pending');
  assert.strictEqual(rec.source, 'chat');
  assert.strictEqual(rec.when, WED.getTime() + 2 * 60 * 60 * 1000);
});

test('inbound: uses the current chat when no "to" is given', async () => {
  const handle = createInboundHandler({
    store,
    providerName: 'personal',
    now: () => WED.getTime(),
  });

  await handle({ body: '/s tomorrow 18:00: milk', fromChatNumber: '447000000001' });

  const rec = (await store.all()).find((r) => r.text === 'milk');
  assert.ok(rec, 'record persisted');
  assert.strictEqual(rec.to, '447000000001', 'falls back to chat number');
});

test('inbound: weekend target gets a Monday nudge (still scheduled)', async () => {
  const handle = createInboundHandler({
    store,
    providerName: 'personal',
    now: () => WED.getTime(),
  });

  // 2026-07-25 is a Saturday.
  const reply = await handle({
    body: '/schedule 2026-07-25 10:00 to +447911123456: Weekend ping',
    fromChatNumber: '',
  });

  assert.match(reply, /^✅ Scheduled for /);
  assert.match(reply, /Saturday/);
  assert.match(reply, /Monday instead/);

  const rec = (await store.all()).find((r) => r.text === 'Weekend ping');
  assert.ok(rec, 'still scheduled despite the nudge');
  assert.strictEqual(rec.when, SAT.getTime());
});

test('inbound: unparseable command returns a warning, persists nothing', async () => {
  const before = (await store.all()).length;
  const handle = createInboundHandler({
    store,
    providerName: 'personal',
    now: () => WED.getTime(),
  });

  const reply = await handle({ body: '/s not-a-real-time: hi', fromChatNumber: '447000000002' });
  assert.match(reply, /^⚠️/);
  assert.strictEqual((await store.all()).length, before, 'no record added');
});

test('scheduler: fires a due pending message and marks it sent', async () => {
  const due = {
    id: store.makeId(),
    to: '447911123456',
    toDisplay: '+447911123456',
    text: 'fire me',
    when: Date.now() - 1000, // already due
    status: 'pending',
    provider: 'personal',
    source: 'chat',
    createdAt: Date.now(),
  };
  await store.insert(due);

  const sent = [];
  const engine = scheduler.start({
    store,
    send: async (rec) => {
      sent.push(rec.id);
    },
    intervalMs: 30,
  });

  // Wait a few ticks.
  await new Promise((r) => setTimeout(r, 200));
  engine.stop();

  assert.ok(sent.includes(due.id), 'send() was called for the due record');
  const rec = await store.get(due.id);
  assert.strictEqual(rec.status, 'sent');
  assert.ok(typeof rec.sentAt === 'number');
});

test('scheduler: leaves future-dated messages pending', async () => {
  const future = {
    id: store.makeId(),
    to: '447911123456',
    toDisplay: '+447911123456',
    text: 'later',
    when: Date.now() + 60 * 60 * 1000,
    status: 'pending',
    provider: 'personal',
    source: 'chat',
    createdAt: Date.now(),
  };
  await store.insert(future);

  const engine = scheduler.start({ store, send: async () => {}, intervalMs: 30 });
  await new Promise((r) => setTimeout(r, 120));
  engine.stop();

  const rec = await store.get(future.id);
  assert.strictEqual(rec.status, 'pending');
});
