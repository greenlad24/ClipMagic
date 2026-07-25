'use strict';

// server/store.js — atomic JSON persistence for scheduled message records.
// CommonJS, Node >= 18, no external dependencies.

const fs = require('fs/promises');
const path = require('path');

function dataDir() {
  return process.env.DATA_DIR || './data';
}

function filePath() {
  return path.join(dataDir(), 'messages.json');
}

// Promise-based mutex: serialize every read/modify/write so concurrent
// operations can't interleave or corrupt the file.
let chain = Promise.resolve();
function withLock(fn) {
  const result = chain.then(fn, fn);
  // Keep the chain alive even if an operation rejects.
  chain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function readRaw() {
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeAtomic(records) {
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true });
  const target = filePath();
  const tmp =
    target + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2);
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

function all() {
  return withLock(() => readRaw());
}

function get(id) {
  return withLock(async () => {
    const records = await readRaw();
    return records.find((r) => r.id === id);
  });
}

function insert(record) {
  return withLock(async () => {
    const records = await readRaw();
    records.push(record);
    await writeAtomic(records);
    return record;
  });
}

function update(id, patch) {
  return withLock(async () => {
    const records = await readRaw();
    const i = records.findIndex((r) => r.id === id);
    if (i === -1) return undefined;
    const merged = Object.assign({}, records[i], patch);
    records[i] = merged;
    await writeAtomic(records);
    return merged;
  });
}

function remove(id) {
  return withLock(async () => {
    const records = await readRaw();
    const next = records.filter((r) => r.id !== id);
    if (next.length === records.length) return false;
    await writeAtomic(next);
    return true;
  });
}

function makeId() {
  return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = {
  all,
  get,
  insert,
  update,
  remove,
  makeId,
};
