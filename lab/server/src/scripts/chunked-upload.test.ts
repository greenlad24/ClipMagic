/**
 * Unit checks for the resumable chunked-upload bookkeeping (lib/chunkedUpload).
 * Pure logic — no fs, no HTTP. Run:
 *   cd lab/server && npx tsx src/scripts/chunked-upload.test.ts
 *
 * Guarantees the invariant the whole feature rests on: a file is only ever
 * finalizable once EVERY chunk is present AND the assembled byte total equals
 * the size declared at init — so a truncated upload can never pass `assertComplete`.
 */
import assert from "node:assert/strict";
import {
  planChunks,
  chunkOffset,
  expectedChunkLength,
  createSession,
  validateChunk,
  recordChunk,
  allChunksPresent,
  receivedBytes,
  assertComplete,
  missingChunks,
  isStale,
} from "../lib/chunkedUpload.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}

const CS = 8 * 1024 * 1024; // 8 MB

// ── planning: size → chunk count / offsets ──────────────────────────────────
check("planChunks: exact multiple", () => {
  const { totalChunks } = planChunks(CS * 3, CS);
  assert.equal(totalChunks, 3);
});
check("planChunks: ragged last chunk", () => {
  const { totalChunks } = planChunks(CS * 2 + 123, CS);
  assert.equal(totalChunks, 3);
});
check("planChunks: smaller-than-one-chunk", () => {
  const { totalChunks } = planChunks(10, CS);
  assert.equal(totalChunks, 1);
});
check("planChunks: zero bytes → zero chunks", () => {
  assert.equal(planChunks(0, CS).totalChunks, 0);
});
check("planChunks: rejects bad inputs", () => {
  assert.throws(() => planChunks(-1, CS));
  assert.throws(() => planChunks(100, 0));
});
check("chunkOffset / expectedChunkLength match the plan", () => {
  const size = CS * 2 + 123;
  assert.equal(chunkOffset(0, CS), 0);
  assert.equal(chunkOffset(2, CS), CS * 2);
  assert.equal(expectedChunkLength(0, size, CS), CS);
  assert.equal(expectedChunkLength(1, size, CS), CS);
  assert.equal(expectedChunkLength(2, size, CS), 123); // ragged tail
  assert.equal(expectedChunkLength(3, size, CS), 0); // past the end
});

// ── append validation ───────────────────────────────────────────────────────
function freshSession(size: number) {
  const { totalChunks, chunkSize } = planChunks(size, CS);
  return createSession({ uploadId: "u1", filename: "v.mp4", totalSize: size, totalChunks, chunkSize });
}

check("validateChunk: accepts correct sizes", () => {
  const size = CS * 2 + 50;
  const s = freshSession(size);
  assert.equal(validateChunk(s, 0, CS), CS);
  assert.equal(validateChunk(s, 2, 50), 50);
});
check("validateChunk: rejects out-of-range index", () => {
  const s = freshSession(CS);
  assert.throws(() => validateChunk(s, 5, CS), /out of range/);
  assert.throws(() => validateChunk(s, -1, CS), /out of range/);
});
check("validateChunk: rejects wrong byte length (would truncate)", () => {
  const s = freshSession(CS * 2);
  assert.throws(() => validateChunk(s, 0, CS - 1), /size mismatch/);
});

// ── idempotent re-append ─────────────────────────────────────────────────────
check("recordChunk is idempotent: re-append same index doesn't double-count", () => {
  const size = CS * 2 + 10;
  const s = freshSession(size);
  recordChunk(s, 0, CS);
  recordChunk(s, 0, CS); // retry of the SAME chunk
  recordChunk(s, 1, CS);
  recordChunk(s, 2, 10);
  assert.equal(s.received.size, 3);
  assert.equal(receivedBytes(s), size); // not size + CS
  assert.ok(allChunksPresent(s));
});

// ── complete-size validation (truncation guard) ─────────────────────────────
check("assertComplete: passes only with all chunks + exact bytes", () => {
  const size = CS * 2 + 10;
  const s = freshSession(size);
  recordChunk(s, 0, CS);
  recordChunk(s, 1, CS);
  recordChunk(s, 2, 10);
  assert.doesNotThrow(() => assertComplete(s));
});
check("assertComplete: rejects a missing chunk (no truncated finalize)", () => {
  const size = CS * 3;
  const s = freshSession(size);
  recordChunk(s, 0, CS);
  recordChunk(s, 2, CS); // chunk 1 missing
  assert.throws(() => assertComplete(s), /incomplete|missing/);
  assert.deepEqual(missingChunks(s), [1]);
});
check("assertComplete: rejects a byte-total mismatch even if count matches", () => {
  // Simulate a corrupt session where a chunk was recorded with the wrong length.
  const size = CS * 2;
  const s = freshSession(size);
  s.received.set(0, CS);
  s.received.set(1, CS - 5); // short
  assert.throws(() => assertComplete(s), /size mismatch/);
});

// ── ordering independence ────────────────────────────────────────────────────
check("chunks may arrive out of order and still complete", () => {
  const size = CS * 3;
  const s = freshSession(size);
  recordChunk(s, 2, CS);
  recordChunk(s, 0, CS);
  recordChunk(s, 1, CS);
  assert.doesNotThrow(() => assertComplete(s));
});

// ── TTL reaper logic ─────────────────────────────────────────────────────────
check("isStale: idle past TTL is stale, fresh is not", () => {
  const s = freshSession(CS);
  const now = 1_000_000_000_000;
  s.updatedAt = now - 10 * 60 * 60 * 1000; // 10h ago
  assert.ok(isStale(s, 6 * 60 * 60 * 1000, now));
  s.updatedAt = now - 60 * 1000; // 1 min ago
  assert.ok(!isStale(s, 6 * 60 * 60 * 1000, now));
});

console.log(`\n${passed} checks passed.`);
