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
  computeKeepSegments, silencesFromEnvelope, segmentTakes, sentencesFromWords,
  markDuplicateTakes, previewDuration, sourceToEdited, DEFAULT_SETTINGS, takeId,
  type Envelope, type Take,
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

// ── REFINEMENT 1: sentence-whole takes ───────────────────────────────────────

// 10 ─ A sentence stays WHOLE across an in-sentence sub-0.35s pause AND a brief
//      quiet dip — it is never split. Layout (hop 0.02, 6.0s), all words in ONE
//      sentence "the quick brown fox jumps." with:
//        - a 0.2s sub-minSilence pause between "quick" and "brown" (kept),
//        - a brief quiet DIP (a single quiet frame, well under minSilence).
//      The dip/pause do not register as cuttable silence, so one continuous take.
function sentenceEnv(): Envelope {
  const hop = 0.02, duration = 6.0, n = Math.round(duration / hop);
  // Loud everywhere the sentence is spoken: [0.5,3.5], with a 0.2s pause at
  // [1.5,1.7] (quiet but only 0.2s) — still all one breath of speech.
  const loud = (t: number) => (t >= 0.5 && t < 1.5) || (t >= 1.7 && t < 3.5);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push(loud(i * hop) ? -12 : -60);
  return { db, hop, duration };
}
const sentenceWords = [
  { word: "the", start: 0.55, end: 0.75 },
  { word: "quick", start: 0.8, end: 1.45 },
  // 0.2s pause here (1.45 → 1.75) — below minSilence, must NOT split.
  { word: "brown", start: 1.75, end: 2.1 },
  { word: "fox", start: 2.15, end: 2.6 },
  { word: "jumps.", start: 2.7, end: 3.4 },
];

check("a whole sentence is ONE take across a sub-0.35s pause + quiet dip", () => {
  const sils = silencesFromEnvelope(sentenceEnv(), DEFAULT_SETTINGS);
  // The 0.2s pause [1.5,1.7) is shorter than minSilence → it is NOT a cut.
  assert.ok(!sils.some((s) => s.start >= 1.4 && s.end <= 1.8), "the 0.2s in-sentence pause is not cut");
  const sentences = sentencesFromWords(sentenceWords, sils, DEFAULT_SETTINGS);
  assert.equal(sentences.length, 1, "all words are ONE sentence (no split mid-sentence)");
  const r = computeKeepSegments(sentenceEnv(), sentenceWords, DEFAULT_SETTINGS, []);
  assert.equal(r.takes.length, 1, "one continuous take for the whole sentence");
  assert.ok(/the quick brown fox jumps/.test(r.takes[0].text), `take text: "${r.takes[0].text}"`);
  // The take spans first word → last word (± keepPad), continuous (no gap inside).
  assert.ok(r.takes[0].start <= 0.55 && r.takes[0].end >= 3.4, `span ${r.takes[0].start}-${r.takes[0].end}`);
});

// 11 ─ A true-silence > 0.35s BETWEEN two sentences IS the only cut and collapses
//      to exactly one 0.35 gap. Two sentences with a real 1.0s silent gap.
function twoSentenceEnv(): Envelope {
  const hop = 0.02, duration = 6.0, n = Math.round(duration / hop);
  // Sentence 1 speech [0.5,2.0], TRUE SILENCE [2.0,3.0] (1.0s), sentence 2 [3.0,4.5].
  const loud = (t: number) => (t >= 0.5 && t < 2.0) || (t >= 3.0 && t < 4.5);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push(loud(i * hop) ? -12 : -60);
  return { db, hop, duration };
}
const twoSentenceWords = [
  { word: "hello", start: 0.6, end: 1.0 },
  { word: "there.", start: 1.1, end: 1.9 },
  // 1.1s word-gap that DOES contain a real 1.0s silence → sentence break.
  { word: "goodbye", start: 3.05, end: 3.5 },
  { word: "now.", start: 3.6, end: 4.4 },
];

check("a real >0.35s silence BETWEEN sentences is cut → two takes, one 0.35 gap", () => {
  const sils = silencesFromEnvelope(twoSentenceEnv(), DEFAULT_SETTINGS);
  // The real inter-sentence silence [2.0,3.0) is detected (among lead/trail too).
  assert.ok(sils.some((s) => s.start >= 1.9 && s.end <= 3.1), "the inter-sentence silence is detected");
  const sentences = sentencesFromWords(twoSentenceWords, sils, DEFAULT_SETTINGS);
  assert.equal(sentences.length, 2, "two sentences (split at the real silence)");
  const r = computeKeepSegments(twoSentenceEnv(), twoSentenceWords, DEFAULT_SETTINGS, []);
  assert.equal(r.takes.length, 2, "two takes");
  const body = r.keep.reduce((acc, k) => acc + (k.end - k.start), 0);
  assert.ok(Math.abs(previewDuration(r.keep, r.gap) - (body + 0.35)) < 1e-6,
    "interior silence collapses to exactly one 0.35 gap");
});

// 11b ─ A LONG word-gap with NO real silence (loose Whisper timings) does NOT
//       split: same words as #11's first sentence but the audio is continuous.
check("a long word-gap with no real silence does NOT split a sentence", () => {
  const hop = 0.02, duration = 5.0, n = Math.round(duration / hop);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push((i * hop >= 0.5 && i * hop < 4.0) ? -12 : -60);
  const env: Envelope = { db, hop, duration };
  // 0.8s word-gap between "there" and "friend" but the AUDIO is unbroken.
  const words = [
    { word: "hello", start: 0.6, end: 1.0 },
    { word: "there", start: 1.1, end: 1.9 },
    { word: "friend", start: 2.7, end: 3.6 }, // loose timing, no real silence
  ];
  const sils = silencesFromEnvelope(env, DEFAULT_SETTINGS);
  const sentences = sentencesFromWords(words, sils, DEFAULT_SETTINGS);
  assert.equal(sentences.length, 1, "no real silence in the gap → still one sentence");
  const r = computeKeepSegments(env, words, DEFAULT_SETTINGS, []);
  assert.equal(r.takes.length, 1, "one continuous take");
});

// ── REFINEMENT 2: transcript-based duplicate removal ─────────────────────────

// A pure helper to make sentence-shaped takes directly for dedup unit tests.
function takeFrom(start: number, end: number, text: string): Take {
  return { id: takeId(start), start, end, text };
}

// 12 ─ Exact-duplicate sentences: only the LATEST take is kept; earlier ones are
//      marked removed with a reason. Order is by start time.
check("duplicate sentences → keep latest, earlier marked removed with reason", () => {
  const takes = [
    takeFrom(0.0, 2.0, "Welcome to the show everyone."),
    takeFrom(3.0, 5.0, "Welcome to the show everyone."),  // re-take
    takeFrom(6.0, 8.0, "Today we are talking about coffee."),
  ];
  const marked = markDuplicateTakes(takes);
  assert.ok(marked[0].duplicateOf, "the EARLIER welcome is removed");
  assert.match(marked[0].duplicateOf!, /duplicate — earlier take of:/);
  assert.ok(!marked[1].duplicateOf, "the LATEST welcome is kept");
  assert.ok(!marked[2].duplicateOf, "the unique line is untouched");
});

// 13 ─ NEAR-duplicates (a minor word difference between takes) still match.
check("near-duplicate takes (minor word diff) are still matched", () => {
  const takes = [
    takeFrom(0.0, 2.5, "So today I want to show you my new setup."),
    takeFrom(3.0, 5.5, "Today I want to show you guys my new setup here."),  // near-dup
  ];
  const marked = markDuplicateTakes(takes);
  assert.ok(marked[0].duplicateOf, "earlier near-duplicate is removed");
  assert.ok(!marked[1].duplicateOf, "latest near-duplicate is kept");
});

// 14 ─ NON-duplicates are left alone (no false positives on different lines).
check("non-duplicate takes are untouched", () => {
  const takes = [
    takeFrom(0.0, 2.0, "First we measure the beans carefully."),
    takeFrom(3.0, 5.0, "Then we heat the water to ninety degrees."),
    takeFrom(6.0, 8.0, "Finally we pour in slow circles."),
  ];
  const marked = markDuplicateTakes(takes);
  assert.ok(marked.every((t) => !t.duplicateOf), "no take is wrongly flagged a duplicate");
});

// 15 ─ Dedup is parity-safe: computeKeepSegments auto-removes duplicates BY
//      DEFAULT (keep list excludes them), and toggling a duplicate id RESTORES
//      it (and toggling a kept take DELETES it). previewDuration tracks exactly.
check("dedup is default-removed in keep list, restorable, and deterministic", () => {
  // Build an envelope with three loud islands separated by real silences, where
  // islands 1 and 2 carry the SAME sentence (a re-take) and island 3 is unique.
  const hop = 0.02, duration = 12.0, n = Math.round(duration / hop);
  const loud = (t: number) =>
    (t >= 0.5 && t < 2.5) || (t >= 4.0 && t < 6.0) || (t >= 7.5 && t < 9.5);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push(loud(i * hop) ? -12 : -60);
  const env: Envelope = { db, hop, duration };
  const words = [
    { word: "this", start: 0.6, end: 0.9 }, { word: "is", start: 1.0, end: 1.2 },
    { word: "the", start: 1.3, end: 1.5 }, { word: "intro.", start: 1.6, end: 2.3 },
    // re-take of the same line:
    { word: "this", start: 4.1, end: 4.4 }, { word: "is", start: 4.5, end: 4.7 },
    { word: "the", start: 4.8, end: 5.0 }, { word: "intro.", start: 5.1, end: 5.8 },
    // unique line:
    { word: "now", start: 7.6, end: 7.9 }, { word: "lets", start: 8.0, end: 8.4 },
    { word: "begin.", start: 8.5, end: 9.3 },
  ];
  const all = computeKeepSegments(env, words, DEFAULT_SETTINGS, []);
  assert.equal(all.takes.length, 3, "three sentence takes detected");
  // The earlier "this is the intro" is auto-removed; keep list has 2 segments.
  assert.equal(all.keep.length, 2, "duplicate auto-removed by default → 2 kept");
  assert.ok(all.takes[0].duplicateOf, "the earliest take is the removed duplicate");
  assert.ok(!all.takes[1].duplicateOf && !all.takes[2].duplicateOf, "latest dup + unique kept");

  // Restore the duplicate by toggling its id → 3 kept.
  const dupId = all.takes[0].id;
  const restored = computeKeepSegments(env, words, DEFAULT_SETTINGS, [dupId]);
  assert.equal(restored.keep.length, 3, "toggling the duplicate id restores it");

  // Delete a kept take by toggling its (kept) id → fewer kept.
  const keptId = all.takes[2].id;
  const deleted = computeKeepSegments(env, words, DEFAULT_SETTINGS, [keptId]);
  assert.equal(deleted.keep.length, 1, "toggling a kept take deletes it");

  // Determinism + preview duration tracks the kept body + gaps.
  const again = computeKeepSegments(env, words, DEFAULT_SETTINGS, []);
  assert.deepEqual(all, again, "deterministic");
  const body = all.keep.reduce((acc, k) => acc + (k.end - k.start), 0);
  assert.ok(Math.abs(previewDuration(all.keep, all.gap) - (body + 0.35)) < 1e-6,
    "2 kept takes → one 0.35 gap");
});

// 16 ─ The new default silence floor is -39 dB (the user's tested sweet spot).
check("DEFAULT_SETTINGS.silenceDb is -39", () => {
  assert.equal(DEFAULT_SETTINGS.silenceDb, -39);
});

console.log(`\n${passed} parity checks passed.`);
