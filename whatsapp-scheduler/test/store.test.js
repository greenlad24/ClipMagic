'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');

// Point the store at an isolated temp DATA_DIR before requiring it.
// The store reads process.env.DATA_DIR lazily, so this applies to every call.
const TMP_DIR = path.join(
  os.tmpdir(),
  'wa-scheduler-store-test-' + process.pid + '-' + Math.random().toString(36).slice(2)
);
process.env.DATA_DIR = TMP_DIR;

const store = require('../server/store');

test.after(async () => {
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

test('makeId produces unique m_ ids', () => {
  const a = store.makeId();
  const b = store.makeId();
  assert.match(a, /^m_/);
  assert.match(b, /^m_/);
  assert.notStrictEqual(a, b);
});

test('all() on a fresh (missing) data dir returns []', async () => {
  const list = await store.all();
  assert.deepStrictEqual(list, []);
});

test('insert / get round-trip', async () => {
  const rec = {
    id: store.makeId(),
    to: '447911123456',
    toDisplay: '+44 7911 123456',
    text: 'hello',
    when: Date.now() + 60000,
    status: 'pending',
    provider: 'personal',
    source: 'web',
    createdAt: Date.now(),
  };
  const inserted = await store.insert(rec);
  assert.deepStrictEqual(inserted, rec);

  const fetched = await store.get(rec.id);
  assert.deepStrictEqual(fetched, rec);

  const all = await store.all();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].id, rec.id);
});

test('get() for a missing id returns undefined', async () => {
  const missing = await store.get('m_does_not_exist');
  assert.strictEqual(missing, undefined);
});

test('update() patches an existing record and returns merged', async () => {
  const rec = {
    id: store.makeId(),
    to: '447900000000',
    toDisplay: '447900000000',
    text: 'to update',
    when: Date.now() + 120000,
    status: 'pending',
    provider: 'personal',
    source: 'web',
    createdAt: Date.now(),
  };
  await store.insert(rec);

  const sentAt = Date.now();
  const updated = await store.update(rec.id, { status: 'sent', sentAt });
  assert.strictEqual(updated.status, 'sent');
  assert.strictEqual(updated.sentAt, sentAt);
  assert.strictEqual(updated.text, 'to update'); // unchanged fields preserved

  const fetched = await store.get(rec.id);
  assert.strictEqual(fetched.status, 'sent');
  assert.strictEqual(fetched.sentAt, sentAt);
});

test('update() for a missing id returns undefined', async () => {
  const res = await store.update('m_missing', { status: 'sent' });
  assert.strictEqual(res, undefined);
});

test('remove() deletes and returns true, then false', async () => {
  const rec = {
    id: store.makeId(),
    to: '447922222222',
    toDisplay: '447922222222',
    text: 'delete me',
    when: Date.now() + 60000,
    status: 'pending',
    provider: 'personal',
    source: 'web',
    createdAt: Date.now(),
  };
  await store.insert(rec);

  const removed = await store.remove(rec.id);
  assert.strictEqual(removed, true);

  const gone = await store.get(rec.id);
  assert.strictEqual(gone, undefined);

  const removedAgain = await store.remove(rec.id);
  assert.strictEqual(removedAgain, false);
});

test('concurrent inserts are all persisted (mutex serialization)', async () => {
  const before = (await store.all()).length;
  const ids = [];
  const ops = [];
  for (let i = 0; i < 10; i++) {
    const rec = {
      id: store.makeId(),
      to: '447933333333',
      toDisplay: '447933333333',
      text: 'concurrent ' + i,
      when: Date.now() + 60000,
      status: 'pending',
      provider: 'personal',
      source: 'web',
      createdAt: Date.now(),
    };
    ids.push(rec.id);
    ops.push(store.insert(rec));
  }
  await Promise.all(ops);

  const all = await store.all();
  assert.strictEqual(all.length, before + 10);
  for (const id of ids) {
    assert.ok(all.some((r) => r.id === id), 'missing id ' + id);
  }
});

test('atomic write persists valid JSON to messages.json', async () => {
  const raw = await fs.readFile(path.join(TMP_DIR, 'messages.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
});
