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

// 2b ─ RULE 1: complete-silence only. A low-but-nonzero "breath" region (above
//      the -45 floor) is NOT a break, even when it is long.
check("a quiet breath region above the silence floor is NOT cut", () => {
  const hop = 0.02, duration = 3.0;
  const db: number[] = [];
  for (let i = 0; i < 150; i++) {
    const t = i * hop;
    // [1.0,2.0) is a -38 dB "breath": quiet, but louder than the -45 floor.
    db.push(t >= 1.0 && t < 2.0 ? -38 : -12);
  }
  const sil = silencesFromEnvelope({ db, hop, duration }, DEFAULT_SETTINGS);
  assert.equal(sil.length, 0, "breath (-38dB) must not register as silence at the -45 floor");
});

// 2c ─ RULE 2: silences up to and including minSilence (0.35s) are kept; a
//      silence longer than 0.35s is cut. `nFrames` quiet frames at hop 0.02 span
//      exactly nFrames*0.02 seconds (the run is [start, (lastQuiet+1)*hop)).
check("silence ≤0.35s kept, >0.35s cut", () => {
  const mk = (nQuiet: number): Envelope => {
    const hop = 0.02, n = 150, duration = n * hop;
    const db: number[] = [];
    for (let i = 0; i < n; i++) db.push(i >= 50 && i < 50 + nQuiet ? -60 : -12);
    return { db, hop, duration };
  };
  const s = { ...DEFAULT_SETTINGS, keepPad: 0 };
  // 17 frames = 0.34s (≤0.35, kept); 18 frames = 0.36s (>0.35, cut).
  assert.equal(silencesFromEnvelope(mk(17), s).length, 0, "0.34s pause kept");
  assert.equal(silencesFromEnvelope(mk(18), s).length, 1, "0.36s pause cut");
  assert.equal(silencesFromEnvelope(mk(25), s).length, 1, "0.50s pause cut");
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

// 8 ─ RULES 3 + 4 + 6 together on one envelope. Layout (hop 0.02, 6.0s):
//   [0.0,0.6)  lead-in SILENCE  → trimmed fully (no gap at start)
//   [0.6,0.8)  tiny BLIP (0.2s) → dropped (< minTake 0.4)
//   [0.8,1.3)  SILENCE          → cut
//   [1.3,2.3)  take A (1.0s)    → kept
//   [2.3,3.6)  SILENCE (1.3s)   → cut, collapses to exactly one 0.35 gap
//   [3.6,4.6)  take B (1.0s)    → kept (NO transcript words → labelled "—")
//   [4.6,6.0)  trailing SILENCE → trimmed fully (no gap at end)
function complexEnv(): Envelope {
  const hop = 0.02, duration = 6.0, n = Math.round(duration / hop);
  const loud = (t: number) =>
    (t >= 0.6 && t < 0.8) || (t >= 1.3 && t < 2.3) || (t >= 3.6 && t < 4.6);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push(loud(i * hop) ? -12 : -60);
  return { db, hop, duration };
}
// Words only label take A; take B (the "tail") has NO transcript at all.
const complexWords = [{ word: "alpha", start: 1.4, end: 2.2 }];

check("blip dropped; lead/trail trimmed; >0.35 silence collapses to one 0.35 gap", () => {
  const r = computeKeepSegments(complexEnv(), complexWords, DEFAULT_SETTINGS, []);
  // The 0.2s blip is NOT a take; only take A and take B survive.
  assert.equal(r.takes.length, 2, `expected 2 takes, got ${r.takes.length}`);
  // Take A keeps its transcript; take B (untranscribed tail) is empty (UI shows —).
  assert.equal(r.takes[0].text, "alpha");
  assert.equal(r.takes[1].text, "", "untranscribed tail take must still exist, just unlabelled");
  // No keep span starts at 0 or ends at duration → lead/trailing silence fully gone.
  assert.ok(r.keep[0].start > 0.5, `lead-in not trimmed: first keep starts ${r.keep[0].start}`);
  assert.ok(r.keep[r.keep.length - 1].end < 5.9, `trailing not trimmed: last keep ends ${r.keep[r.keep.length - 1].end}`);
  // Exactly two kept takes → exactly one inter-take gap, and it equals 0.35.
  // previewDuration = bodyA + bodyB + 1*gap, with gap = 0.35.
  const body = r.keep.reduce((s, k) => s + (k.end - k.start), 0);
  assert.ok(Math.abs(previewDuration(r.keep, r.gap) - (body + 0.35)) < 1e-6,
    "collapsed interior silence must equal exactly one 0.35 gap");
  assert.equal(r.gap, 0.35);
});

// 9 ─ RULE 5: takes are audio-driven over the FULL duration — the tail take
//     exists even though no word lands in it, and covers real audio.
check("audio-driven take covers the untranscribed tail", () => {
  const r = computeKeepSegments(complexEnv(), complexWords, DEFAULT_SETTINGS, []);
  const tail = r.takes[r.takes.length - 1];
  assert.ok(tail.start >= 3.5 && tail.end <= 4.7, `tail take span ${tail.start}-${tail.end}`);
  assert.ok(tail.end - tail.start >= DEFAULT_SETTINGS.minTake, "tail is a real (big) take");
});

console.log(`\n${passed} parity checks passed.`);
