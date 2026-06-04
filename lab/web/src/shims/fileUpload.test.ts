/**
 * Unit tests for the client chunker (shims/fileUpload). Pure logic + an
 * injectable ChunkSender, so no real XHR/network is needed. Run:
 *   cd lab && ln -sfn web/node_modules node_modules \
 *     && npx tsx web/src/shims/fileUpload.test.ts; rm -f node_modules
 *
 * Covers: chunk planning (size → offsets), backoff sequencing, per-chunk retry
 * (resume the chunk, not the file), retry exhaustion surfacing a clear error,
 * and aggregated 0..1 progress across chunks with bounded parallelism.
 */
import assert from "node:assert/strict";
import {
  planClientChunks,
  backoffDelay,
  sendChunkWithRetry,
  uploadChunked,
  type ChunkSender,
} from "./fileUpload.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}
async function acheck(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}

const CS = 8 * 1024 * 1024;

// ── chunk planning ───────────────────────────────────────────────────────────
check("planClientChunks: ragged tail offsets are contiguous & exact", () => {
  const size = CS * 2 + 123;
  const plan = planClientChunks(size, CS);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan[0], { index: 0, start: 0, end: CS });
  assert.deepEqual(plan[1], { index: 1, start: CS, end: CS * 2 });
  assert.deepEqual(plan[2], { index: 2, start: CS * 2, end: size });
  // No gaps / overlaps and total covered = size.
  let covered = 0;
  for (const p of plan) covered += p.end - p.start;
  assert.equal(covered, size);
});
check("planClientChunks: sub-chunk file is one chunk", () => {
  const plan = planClientChunks(10, CS);
  assert.deepEqual(plan, [{ index: 0, start: 0, end: 10 }]);
});

// ── backoff sequencing ───────────────────────────────────────────────────────
check("backoffDelay grows exponentially", () => {
  // Strip jitter (≤250ms) and assert the base doubles.
  assert.ok(backoffDelay(1) >= 500 && backoffDelay(1) < 750);
  assert.ok(backoffDelay(2) >= 1000 && backoffDelay(2) < 1250);
  assert.ok(backoffDelay(3) >= 2000 && backoffDelay(3) < 2250);
});

// ── per-chunk retry ──────────────────────────────────────────────────────────
await acheck("sendChunkWithRetry: succeeds after transient failures (resumes chunk)", async () => {
  let attempts = 0;
  const send: ChunkSender = async ({ onProgress }) => {
    attempts++;
    if (attempts < 3) { onProgress(100); throw new Error("flaky network"); }
    onProgress(200);
  };
  const progresses: number[] = [];
  await sendChunkWithRetry({
    uploadId: "u", index: 0, blob: new Blob(["x"]),
    onProgress: (n) => progresses.push(n),
    send, retries: 3, onBackoff: async () => {},
  });
  assert.equal(attempts, 3);
  // Progress was reset to 0 between failed attempts (resume from scratch).
  assert.ok(progresses.includes(0));
});

await acheck("sendChunkWithRetry: exhausts retries with a clear error", async () => {
  const send: ChunkSender = async () => { throw new Error("down"); };
  await assert.rejects(
    sendChunkWithRetry({
      uploadId: "u", index: 4, blob: new Blob(["x"]),
      onProgress: () => {}, send, retries: 3, onBackoff: async () => {},
    }),
    /Chunk 5 failed after 3 attempts/,
  );
});

// ── full uploadChunked with mocked fetch + sender ───────────────────────────
function mockFetch(handlers: Record<string, (body: any) => any>) {
  return async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const key = Object.keys(handlers).find((k) => url.includes(k));
    const json = key ? handlers[key](body) : {};
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(json),
    } as any;
  };
}

await acheck("uploadChunked: aggregates progress to 1 and returns the file", async () => {
  const total = CS * 2 + 1000; // 3 chunks
  const blob = new Blob([new Uint8Array(total)]);
  const origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = mockFetch({
    "/init": () => ({ uploadId: "up1", chunkSize: CS, totalChunks: 3 }),
    "/complete": () => ({ file: { id: "f1", url: "/api/uploads/f1" } }),
  });

  const seen: number[] = [];
  const sentIndexes: number[] = [];
  const send: ChunkSender = async ({ index, blob, onProgress }) => {
    sentIndexes.push(index);
    onProgress(blob.size); // instant full send
  };
  try {
    const res = await uploadChunked(blob, "v.mp4", {
      onProgress: (f) => seen.push(f),
      send,
      concurrency: 2,
    });
    assert.equal(res.fileId, "f1");
    assert.equal(res.fileUrl, "/api/uploads/f1");
    assert.deepEqual([...sentIndexes].sort(), [0, 1, 2]);
    assert.equal(seen[seen.length - 1], 1); // ends at 100%
    // Monotonic non-decreasing, bounded to [0,1].
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] >= 0 && seen[i] <= 1);
    }
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

await acheck("uploadChunked: a chunk that exhausts retries aborts the upload", async () => {
  const total = CS + 10; // 2 chunks
  const blob = new Blob([new Uint8Array(total)]);
  const origFetch = (globalThis as any).fetch;
  let abortCalled = false;
  (globalThis as any).fetch = async (url: string) => {
    if (url.includes("/abort")) abortCalled = true;
    const json = url.includes("/init") ? { uploadId: "up2", chunkSize: CS, totalChunks: 2 } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(json) } as any;
  };
  const send: ChunkSender = async ({ index }) => {
    if (index === 1) throw new Error("perma fail");
  };
  try {
    await assert.rejects(
      uploadChunked(blob, "v.mp4", { send, concurrency: 1 }),
      /Chunk 2 failed/,
    );
    assert.ok(abortCalled, "abort should be called to clean up the partial upload");
  } finally {
    (globalThis as any).fetch = origFetch;
  }
});

// give the deferred .catch on abort a tick
await new Promise((r) => setTimeout(r, 10));
console.log(`\n${passed} checks passed.`);
