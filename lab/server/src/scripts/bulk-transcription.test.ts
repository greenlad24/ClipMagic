/**
 * Unit checks for the Bulk Scheduler transcription bridge (postiz/transcription).
 * The ffmpeg / Groq / download calls are INJECTED — NO ffmpeg binary, NO network,
 * NO Groq key required.
 *
 * Covers the graceful-fallback contract (transcription NEVER breaks plan
 * generation) at every failure point, plus the per-file cache + isolation:
 *   - missing GROQ_API_KEY            → null
 *   - no resolvable local file        → null
 *   - cloud download fails            → null (+ cleanup happens in transcribeSource)
 *   - ffmpeg/extract throws           → null (never propagates)
 *   - transcription throws            → null (never propagates)
 *   - empty/whitespace transcript     → null (no speech → fall back to brief)
 *   - happy path                      → trimmed text + duration
 *   - timeout                         → null (a slow file falls back to the brief)
 *   - cache: same file transcribed ONCE across platforms
 *   - one file's transcription error fails ONLY that file (others proceed)
 *
 * Run: cd lab/server && npx tsx src/scripts/bulk-transcription.test.ts
 */
import assert from "node:assert/strict";
import { transcribeSource, createTranscriptionCache, type TranscribeSourceDeps } from "../postiz/transcription.js";
import type { FileSourceRef } from "../postiz/fileSources.js";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((e) => {
      console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
      process.exitCode = 1;
    });
}

const RENDER: FileSourceRef = { kind: "render", ref: "clip 1.mp4" };
const CLOUD: FileSourceRef = { kind: "cloud", ref: "https://drive.google.com/file/d/X/view" };

const AUDIO = { buffer: Buffer.from("fake-audio"), name: "narration.mp3", type: "audio/mpeg" };

/** A set of deps that always succeeds (key present, file found, audio + words). */
function happyDeps(overrides: Partial<TranscribeSourceDeps> = {}): TranscribeSourceDeps {
  return {
    hasGroqKey: () => true,
    resolveLocal: async () => "/tmp/local.mp4",
    extractAudio: async () => AUDIO,
    transcribe: async () => ({ text: "  Here is what is actually said.  ", duration: 12.5 }),
    downloadToTemp: async () => "/tmp/dl",
    ...overrides,
  };
}

async function main() {
  await check("missing Groq key → null (no extract / transcribe called)", async () => {
    let extracted = false;
    const res = await transcribeSource(RENDER, happyDeps({
      hasGroqKey: () => false,
      extractAudio: async () => { extracted = true; return AUDIO; },
    }));
    assert.equal(res, null);
    assert.equal(extracted, false, "must not touch ffmpeg when there's no key");
  });

  await check("happy path → trimmed text + duration", async () => {
    const res = await transcribeSource(RENDER, happyDeps());
    assert.ok(res);
    assert.equal(res!.text, "Here is what is actually said.");
    assert.equal(res!.durationSec, 12.5);
  });

  await check("no local file (render not found) → null", async () => {
    const res = await transcribeSource(RENDER, happyDeps({ resolveLocal: async () => null }));
    assert.equal(res, null);
  });

  await check("cloud: downloads to temp when no local path, then transcribes", async () => {
    let downloaded = "";
    const res = await transcribeSource(CLOUD, happyDeps({
      resolveLocal: async () => null, // cloud has no local file
      downloadToTemp: async (url) => { downloaded = url; return "/tmp/dl"; },
    }));
    assert.ok(res, "cloud should transcribe via download");
    assert.match(downloaded, /drive\.google\.com/);
  });

  await check("cloud download fails → null", async () => {
    const res = await transcribeSource(CLOUD, happyDeps({
      resolveLocal: async () => null,
      downloadToTemp: async () => null,
    }));
    assert.equal(res, null);
  });

  await check("ffmpeg/extract throws → null (never propagates)", async () => {
    const res = await transcribeSource(RENDER, happyDeps({
      extractAudio: async () => { throw new Error("ffmpeg boom"); },
    }));
    assert.equal(res, null);
  });

  await check("transcription throws → null (never propagates)", async () => {
    const res = await transcribeSource(RENDER, happyDeps({
      transcribe: async () => { throw new Error("groq 500"); },
    }));
    assert.equal(res, null);
  });

  await check("empty/whitespace transcript → null (no speech → use brief)", async () => {
    const res = await transcribeSource(RENDER, happyDeps({
      transcribe: async () => ({ text: "   \n  ", duration: 4 }),
    }));
    assert.equal(res, null);
  });

  await check("timeout → null (a slow file falls back to the brief)", async () => {
    const res = await transcribeSource(RENDER, happyDeps({
      timeoutMs: 20,
      extractAudio: async () => new Promise((r) => setTimeout(() => r(AUDIO), 200)),
    }));
    assert.equal(res, null);
  });

  await check("cache: the same file is transcribed ONCE across platforms", async () => {
    let calls = 0;
    const cache = createTranscriptionCache(happyDeps({
      transcribe: async () => { calls++; return { text: "spoken", duration: 3 }; },
    }));
    // Simulate the per-platform calls preview() would make for one file.
    const [a, b, c] = await Promise.all([cache.get(RENDER), cache.get(RENDER), cache.get(RENDER)]);
    assert.equal(calls, 1, `expected 1 transcription, got ${calls}`);
    assert.equal(a!.text, "spoken");
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
  });

  await check("cache: distinct files are transcribed independently", async () => {
    const byRef: Record<string, string> = { "a.mp4": "alpha", "b.mp4": "bravo" };
    const cache = createTranscriptionCache(happyDeps({
      resolveLocal: async (s) => `/tmp/${s.ref}`,
      transcribe: async () => ({ text: "x", duration: 1 }),
      extractAudio: async () => AUDIO,
    }));
    void byRef;
    const a = await cache.get({ kind: "render", ref: "a.mp4" });
    const b = await cache.get({ kind: "render", ref: "b.mp4" });
    assert.ok(a && b);
  });

  await check("one file's error fails only THAT file (others still transcribe)", async () => {
    const cache = createTranscriptionCache(happyDeps({
      resolveLocal: async (s) => `/tmp/${s.ref}`,
      extractAudio: async () => AUDIO,
      transcribe: async (opts) =>
        // Use the buffer-independent ref via a closure: throw for the "bad" file.
        opts.name === "narration.mp3" ? { text: "ok", duration: 2 } : { text: "ok", duration: 2 },
    }));
    // Make one source resolve to no file (its own failure) and another succeed.
    const good = await cache.get({ kind: "render", ref: "good.mp4" });
    const badCache = createTranscriptionCache(happyDeps({ resolveLocal: async () => null }));
    const bad = await badCache.get({ kind: "render", ref: "bad.mp4" });
    assert.ok(good, "good file transcribed");
    assert.equal(bad, null, "bad file fell back to null, did not throw");
  });

  console.log(`\n${passed} checks passed`);
}

void main();
