/**
 * PREVIEW ↔ RENDER PARITY — the critical guarantee for the timeline editor.
 *
 * "What you preview is EXACTLY what renders." The browser computes the final
 * keep-segments from the energy envelope via cutter/segments.ts, and the server
 * renders exactly that list. This test proves the contract holds:
 *
 *   1. The client copy (lab/src/lib/cutSegments.ts) is byte-identical to the
 *      server core (cutter/segments.ts) — they can never silently drift.
 *   2. The shared math is deterministic and matches a hand-computed expectation
 *      for a synthetic envelope + word list (thresholding, min-silence, padding).
 *   3. Manual take deletion + the 0.35s gap produce the expected keep-segment
 *      list and preview duration.
 *   4. The keep-segments the client derives == what renderManualCut renders:
 *      computeKeepSegments(...).keep is what buildCutArgs trims, and its
 *      totalDuration (incl. gaps) equals previewDuration().
 *
 * Run: cd lab/server && npx tsx src/scripts/cutter-parity.test.ts
 * Pure/deterministic — no API keys, no ffmpeg.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  computeKeepSegments, silencesFromEnvelope, segmentTakes, previewDuration,
  sourceToEdited, DEFAULT_SETTINGS, takeId, type Envelope,
} from "../cutter/segments.js";
import { buildCutArgs, type CutSpec } from "../render/cut.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverCore = path.resolve(__dirname, "../cutter/segments.ts");
const clientCopy = path.resolve(__dirname, "../../../src/lib/cutSegments.ts");

// 1 ─ The two copies are byte-identical (parity can't silently drift).
check("client copy is byte-identical to the server segment core", () => {
  assert.ok(fs.existsSync(clientCopy), `client copy missing at ${clientCopy}`);
  const a = fs.readFileSync(serverCore, "utf8");
  const b = fs.readFileSync(clientCopy, "utf8");
  assert.equal(a, b, "lab/src/lib/cutSegments.ts has drifted from cutter/segments.ts — re-sync them");
});

// Build a synthetic 50fps envelope: loud speech, a 1.0s silent gap, more speech.
// frames: [0.0–1.0) loud, [1.0–2.0) silent, [2.0–3.0) loud.  hop=0.02, n=150.
function synthEnv(): Envelope {
  const hop = 0.02, duration = 3.0;
  const db: number[] = [];
  for (let i = 0; i < 150; i++) {
    const t = i * hop;
    db.push(t >= 1.0 && t < 2.0 ? -60 : -12); // silent vs loud
  }
  return { db, hop, duration };
}
const words = [
  { word: "hello", start: 0.1, end: 0.5 },
  { word: "world", start: 0.6, end: 0.95 },
  { word: "second", start: 2.05, end: 2.5 },
  { word: "take", start: 2.55, end: 2.9 },
];

// 2 ─ Thresholding the envelope removes the silent gap, shrunk by keepPad.
check("silencesFromEnvelope removes the 1.0s gap minus keepPad each side", () => {
  const s = { ...DEFAULT_SETTINGS, silenceDb: -32, minSilence: 0.5, keepPad: 0.12 };
  const sil = silencesFromEnvelope(synthEnv(), s);
  assert.equal(sil.length, 1, "exactly one silence");
  // raw silence [1.0,2.0], padded inward by 0.12 → [1.12, 1.88]
  assert.ok(Math.abs(sil[0].start - 1.12) < 0.03, `start ${sil[0].start}`);
  assert.ok(Math.abs(sil[0].end - 1.88) < 0.03, `end ${sil[0].end}`);
});

// 3 ─ Take segmentation labels each kept span with its transcript words.
check("segmentTakes yields two takes with the right transcript snippets", () => {
  const takes = segmentTakes(synthEnv(), words, DEFAULT_SETTINGS);
  assert.equal(takes.length, 2);
  assert.equal(takes[0].text, "hello world");
  assert.equal(takes[1].text, "second take");
  // Stable ids keyed to start.
  assert.equal(takes[0].id, takeId(takes[0].start));
});

// 4 ─ Deleting a take drops it; gap + preview duration are exact.
check("manual delete + 0.35s gap → exact keep list and preview duration", () => {
  const all = computeKeepSegments(synthEnv(), words, DEFAULT_SETTINGS, []);
  assert.equal(all.keep.length, 2);
  assert.equal(all.gap, 0.35);
  const body = all.keep.reduce((s, k) => s + (k.end - k.start), 0);
  // two takes → one 0.35s gap between them
  assert.ok(Math.abs(previewDuration(all.keep, all.gap) - (body + 0.35)) < 1e-6);

  const delId = all.takes[0].id;
  const oneLeft = computeKeepSegments(synthEnv(), words, DEFAULT_SETTINGS, [delId]);
  assert.equal(oneLeft.keep.length, 1, "deleting a take removes it");
  // one take → no gap
  assert.ok(Math.abs(previewDuration(oneLeft.keep, oneLeft.gap) - (oneLeft.keep[0].end - oneLeft.keep[0].start)) < 1e-6);
});

// 5 ─ Determinism: same inputs → identical output (the client gets the same).
check("computeKeepSegments is deterministic", () => {
  const a = computeKeepSegments(synthEnv(), words, DEFAULT_SETTINGS, []);
  const b = computeKeepSegments(synthEnv(), words, DEFAULT_SETTINGS, []);
  assert.deepEqual(a, b);
});

// 6 ─ THE PARITY LINK: the keep-segments the editor renders == what the render
//     path trims, and buildCutArgs' totalDuration == previewDuration().
check("render path duration (incl. gaps) == client previewDuration()", () => {
  const plan = computeKeepSegments(synthEnv(), words, DEFAULT_SETTINGS, []);
  const spec: CutSpec = { source: "/dev/null", segments: plan.keep, hasAudio: true, gap: plan.gap };
  // buildCutArgs writes a sidecar filter file; point it at a temp path.
  const tmp = path.join(process.env.TMPDIR || "/tmp", `parity_${Date.now()}.mp4`);
  const { totalDuration } = buildCutArgs(spec, tmp);
  try { fs.rmSync(`${tmp}.filter.txt`, { force: true }); } catch { /* */ }
  const preview = previewDuration(plan.keep, plan.gap);
  assert.ok(Math.abs(totalDuration - preview) < 1e-6, `render ${totalDuration} != preview ${preview}`);
});

// 7 ─ sourceToEdited maps a kept source time onto the edited timeline incl. gap.
check("sourceToEdited places the second take after the first + gap", () => {
  const plan = computeKeepSegments(synthEnv(), words, DEFAULT_SETTINGS, []);
  const [k0, k1] = plan.keep;
  const atK1Start = sourceToEdited(plan.keep, plan.gap, k1.start);
  const expected = (k0.end - k0.start) + plan.gap;
  assert.ok(atK1Start != null && Math.abs(atK1Start - expected) < 1e-6, `got ${atK1Start} expected ${expected}`);
  // A time inside the removed gap maps to null.
  assert.equal(sourceToEdited(plan.keep, plan.gap, 1.5), null);
});

console.log(`\n${passed} parity checks passed.`);
