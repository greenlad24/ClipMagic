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
  heuristicTakeDefaults, applyDefaults, previewDuration, sourceToEdited,
  DEFAULT_SETTINGS, takeId,
  type Envelope, type Take, type TakeDefault,
} from "../cutter/segments.js";
import { defaultsFromParts, selectBestTakeDefaults } from "../cutter/bestTake.js";
import { buildCutArgs, type CutSpec } from "../render/cut.js";

let passed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") {
      pending.push(
        (r as Promise<void>).then(
          () => { passed++; console.log(`  ok  ${name}`); },
          (e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; },
        ),
      );
      return;
    }
    passed++; console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1;
  }
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

// GEO: a low-minTake settings for the silence/gap GEOMETRY tests, so the short
// synthetic takes aren't disabled by the new 3.0s min-take default (which is
// exercised separately below). The dB floor + min-silence + gap math is unchanged.
const GEO = { ...DEFAULT_SETTINGS, minTake: 0.4 };

// 3 ─ Take segmentation labels each kept span with its transcript words, and
//     returns EVERY take with an explicit enabled flag (none dropped).
check("segmentTakes yields two takes with the right transcript snippets", () => {
  const takes = segmentTakes(synthEnv(), words, GEO);
  assert.equal(takes.length, 2);
  assert.equal(takes[0].text, "hello world");
  assert.equal(takes[1].text, "second take");
  assert.ok(takes[0].enabled && takes[1].enabled, "both takes enabled at minTake 0.4");
  // Stable ids keyed to start.
  assert.equal(takes[0].id, takeId(takes[0].start));
});

// 4 ─ Disabling a take drops it from keep; gap + preview duration are exact.
check("manual toggle + 0.35s gap → exact keep list and preview duration", () => {
  const all = computeKeepSegments(synthEnv(), words, GEO, [], []);
  assert.equal(all.keep.length, 2);
  assert.equal(all.gap, 0.35);
  const body = all.keep.reduce((s, k) => s + (k.end - k.start), 0);
  // two takes → one 0.35s gap between them
  assert.ok(Math.abs(previewDuration(all.keep, all.gap) - (body + 0.35)) < 1e-6);

  const delId = all.takes[0].id;
  const oneLeft = computeKeepSegments(synthEnv(), words, GEO, [], [delId]);
  assert.equal(oneLeft.keep.length, 1, "toggling a take off removes it");
  // one take → no gap
  assert.ok(Math.abs(previewDuration(oneLeft.keep, oneLeft.gap) - (oneLeft.keep[0].end - oneLeft.keep[0].start)) < 1e-6);
});

// 5 ─ Determinism: same inputs → identical output (the client gets the same).
check("computeKeepSegments is deterministic", () => {
  const a = computeKeepSegments(synthEnv(), words, GEO, [], []);
  const b = computeKeepSegments(synthEnv(), words, GEO, [], []);
  assert.deepEqual(a, b);
});

// 6 ─ THE PARITY LINK: the keep-segments the editor renders == what the render
//     path trims, and buildCutArgs' totalDuration == previewDuration().
check("render path duration (incl. gaps) == client previewDuration()", () => {
  const plan = computeKeepSegments(synthEnv(), words, GEO, [], []);
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
  const plan = computeKeepSegments(synthEnv(), words, GEO, [], []);
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

check("blip disabled; lead/trail trimmed; >0.35 silence collapses to one 0.35 gap", () => {
  // minTake 0.4 keeps the two ~1s takes; the 0.2s blip is below it and is
  // DISABLED (not dropped) — it appears as a third take, just off by default.
  const r = computeKeepSegments(complexEnv(), complexWords, GEO, [], []);
  // The 0.2s blip take is detected but disabled; A + B are enabled.
  assert.equal(r.takes.length, 3, `expected 3 takes (incl. disabled blip), got ${r.takes.length}`);
  const enabledTakes = r.takes.filter((t) => t.enabled);
  assert.equal(enabledTakes.length, 2, "only the two real takes are enabled");
  const blip = r.takes.find((t) => !t.enabled)!;
  assert.ok(blip && blip.end - blip.start < 0.5 && blip.reason === "short", "blip disabled as a short take");
  // Take A keeps its transcript; take B (untranscribed tail) is empty (UI shows —).
  assert.equal(enabledTakes[0].text, "alpha");
  assert.equal(enabledTakes[1].text, "", "untranscribed tail take must still exist, just unlabelled");
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
  const r = computeKeepSegments(complexEnv(), complexWords, GEO, [], []);
  const tail = r.takes[r.takes.length - 1];
  assert.ok(tail.start >= 3.5 && tail.end <= 4.7, `tail take span ${tail.start}-${tail.end}`);
  assert.ok(tail.end - tail.start >= GEO.minTake, "tail is a real (big) take");
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
  const r = computeKeepSegments(sentenceEnv(), sentenceWords, GEO, [], []);
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
  const r = computeKeepSegments(twoSentenceEnv(), twoSentenceWords, GEO, [], []);
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
  const r = computeKeepSegments(env, words, GEO, [], []);
  // The sentence is ONE continuous take that holds all the words (it is not split
  // mid-sentence). Any sub-minTake audio sliver after the last word is shown as a
  // disabled take, never dropped — so we assert the sentence take by coverage.
  const sentenceTake = r.takes.find((t) => t.start <= 0.6 && t.end >= 3.6);
  assert.ok(sentenceTake && sentenceTake.enabled, "the whole sentence is one enabled take, unsplit");
  assert.ok(/hello there friend/.test(sentenceTake!.text), `take text: "${sentenceTake!.text}"`);
});

// ── DEFAULTS: min-take 3.0, dB→0, disabled-not-dropped, toggle ───────────────

// A pure helper to make sentence-shaped takes directly for selection unit tests.
function takeFrom(start: number, end: number, text: string): Take {
  return { id: takeId(start), start, end, text, enabled: true };
}

// 12 ─ The min-take default is 3.0s and the dB floor reaches 0.
check("DEFAULT_SETTINGS: minTake 3.0, silenceDb -39, floor reaches 0", () => {
  assert.equal(DEFAULT_SETTINGS.minTake, 3.0, "min-take default is 3.0s");
  assert.equal(DEFAULT_SETTINGS.silenceDb, -39, "silence floor default -39");
  // The dB slider's range is a UI concern, but the math must behave at 0 dB:
  // every frame is ≤ 0, so the whole clip is "silence" — degenerate but valid.
  const env = synthEnv();
  const sil = silencesFromEnvelope(env, { ...DEFAULT_SETTINGS, silenceDb: 0, minSilence: 0.1, keepPad: 0 });
  assert.ok(sil.length >= 1, "at a 0 dB floor everything counts as a break");
});

// 13 ─ Takes under min-take are DISABLED (not removed) and re-enable when the
//      slider lowers (without any manual override).
check("under-minTake takes are disabled-not-dropped, re-enable as the slider lowers", () => {
  const env = synthEnv(); // two ~0.85s takes
  // At minTake 3.0 both takes are present but DISABLED (none dropped).
  const hi = computeKeepSegments(env, words, { ...DEFAULT_SETTINGS, minTake: 3.0 }, [], []);
  assert.equal(hi.takes.length, 2, "every detected take is still shown");
  assert.ok(hi.takes.every((t) => !t.enabled), "both are disabled at minTake 3.0");
  assert.ok(hi.takes.every((t) => t.reason === "short"), "reason names the short-take gate");
  assert.equal(hi.keep.length, 0, "disabled takes contribute nothing to keep");
  // Lowering the slider below the take length re-enables them automatically.
  const lo = computeKeepSegments(env, words, { ...DEFAULT_SETTINGS, minTake: 0.4 }, [], []);
  assert.ok(lo.takes.every((t) => t.enabled), "lowering minTake re-enables the short takes");
  assert.equal(lo.keep.length, 2, "now both contribute to keep");
});

// 14 ─ Toggling a take on/off updates the enabled keep-set (both directions).
check("toggle on/off updates the enabled keep-set", () => {
  const env = synthEnv();
  const s = { ...DEFAULT_SETTINGS, minTake: 0.4 }; // both enabled by default
  const base = computeKeepSegments(env, words, s, [], []);
  assert.equal(base.keep.length, 2);
  // Toggle the first (enabled) take OFF → 1 kept.
  const off = computeKeepSegments(env, words, s, [], [base.takes[0].id]);
  assert.equal(off.keep.length, 1, "toggling an enabled take disables it");
  assert.ok(!off.takes[0].enabled, "the toggled take is now disabled");
  // A disabled-by-default (under-minTake) take toggles back ON.
  const sHi = { ...DEFAULT_SETTINGS, minTake: 3.0 }; // both disabled by default
  const on = computeKeepSegments(env, words, sHi, [], [base.takes[0].id]);
  assert.equal(on.keep.length, 1, "toggling a disabled take enables it");
  assert.ok(on.takes[0].enabled, "the toggled-on take is enabled");
});

// ── STAGE 1: big-chunk detection (merge + volume gate + scattered exclusion) ──

// 15 ─ A take is ONE big block: above-floor runs separated by a SHORT pause
//      (≤ minSilence) MERGE into one contiguous take and never split inside.
check("Stage 1: short internal pauses merge into one big block (no mid-block split)", () => {
  // Loud [0.5,1.4), 0.2s pause, loud [1.6,3.5). The 0.2s pause ≤ minSilence(0.35)
  // → the two runs are the SAME block. A 1.0s silence then starts the next block.
  const hop = 0.02, duration = 6.0, n = Math.round(duration / hop);
  const loud = (t: number) => (t >= 0.5 && t < 1.4) || (t >= 1.6 && t < 3.5) || (t >= 4.5 && t < 5.8);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push(loud(i * hop) ? -12 : -60);
  const env: Envelope = { db, hop, duration };
  const takes = segmentTakes(env, [], GEO);
  // First block spans the whole [0.5,3.5] across the short pause; second is [4.5,5.8].
  assert.equal(takes.length, 2, "two big blocks (the 0.2s pause did not split the first)");
  assert.ok(takes[0].start <= 0.55 && takes[0].end >= 3.45, `block 1 span ${takes[0].start}-${takes[0].end}`);
  assert.ok(takes[1].start >= 4.4, `block 2 starts at ${takes[1].start}`);
});

// 16 ─ Scattered, FAINT words between the big blocks are NOT takes: a long but
//      low-level block is disabled "low/scattered", never enabled by default.
check("Stage 1: faint scattered audio is disabled low/scattered (not a take)", () => {
  // A real loud block [0.5,4.0] at -12, then a long FAINT block [5.0,9.0] at -33
  // (above the -39 floor but below the -27 speaking gate = floor + margin 12).
  const hop = 0.02, duration = 10.0, n = Math.round(duration / hop);
  const db: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i * hop;
    db.push((t >= 0.5 && t < 4.0) ? -12 : (t >= 5.0 && t < 9.0) ? -33 : -60);
  }
  const env: Envelope = { db, hop, duration };
  const takes = segmentTakes(env, [], DEFAULT_SETTINGS);
  assert.equal(takes.length, 2, "both blocks are detected (none dropped)");
  const real = takes[0], faint = takes[1];
  assert.ok(real.enabled, "the loud block is a real enabled take");
  assert.ok(!faint.enabled && faint.reason === "low/scattered",
    `the faint block is disabled low/scattered (got enabled=${faint.enabled}, reason=${faint.reason})`);
  // It is long (>minTake) yet still excluded — volume, not length, gates it.
  assert.ok(faint.end - faint.start > DEFAULT_SETTINGS.minTake, "the faint block is long, yet still not a take");
});

// 16b ─ STAGE 2: each big block carries the transcript spoken INSIDE it (words
//       mapped by midpoint), independent of sentence punctuation.
check("Stage 2: per-chunk transcript = the words inside that block's span", () => {
  const hop = 0.02, duration = 8.0, n = Math.round(duration / hop);
  const loud = (t: number) => (t >= 0.5 && t < 3.5) || (t >= 5.0 && t < 7.5);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push(loud(i * hop) ? -12 : -60);
  const env: Envelope = { db, hop, duration };
  const words = [
    { word: "first", start: 0.7, end: 1.2 }, { word: "block.", start: 1.3, end: 3.2 },
    { word: "second", start: 5.2, end: 5.9 }, { word: "block.", start: 6.0, end: 7.2 },
  ];
  const takes = segmentTakes(env, words, GEO);
  assert.equal(takes.length, 2);
  assert.equal(takes[0].text, "first block.", "block 1 gets only its own words");
  assert.equal(takes[1].text, "second block.", "block 2 gets only its own words");
});

// ── STAGE 3: keep-LAST dedup + in-code guarantees ────────────────────────────

// 17 ─ The heuristic fallback (no AI): re-takes are grouped and the LAST
//      occurrence is kept; the EARLIER ones are disabled "earlier take".
check("Stage 3 heuristic: keep the LAST re-take, disable the earlier ones", () => {
  const takes = [
    takeFrom(0.0, 3.5, "Welcome to the show everyone."),       // earlier → disabled
    takeFrom(5.0, 8.6, "Welcome to the show everyone."),       // LAST → kept
    takeFrom(10.0, 13.5, "Today we are talking about coffee."),// said once → kept
  ];
  const defs = heuristicTakeDefaults(takes);
  assert.equal(defs.length, 1, "exactly one earlier repeat disabled");
  assert.equal(defs[0].id, takes[0].id, "the EARLIER welcome is the disabled one");
  assert.match(defs[0].reason, /earlier take — final kept/);
  // The keep-LAST rule is UNCONDITIONAL — even a SHORT final re-take wins.
  const shortLast = [
    takeFrom(0.0, 6.0, "This is the line said in full."),  // long, earlier
    takeFrom(8.0, 8.4, "This is the line said in full."),  // 0.4s LAST re-take
  ];
  const d2 = heuristicTakeDefaults(shortLast);
  assert.equal(d2.length, 1, "one disabled");
  assert.equal(d2[0].id, shortLast[0].id, "the LAST take is kept even though it is shorter");
});

// 18 ─ A line said ONCE is ALWAYS kept; conservative grouping never merges two
//      genuinely different lines (no unique part is dropped).
check("Stage 3: single-occurrence kept; distinct lines never merged", () => {
  const takes = [
    takeFrom(0.0, 4.0, "The mitochondria is the powerhouse of the cell."),
    takeFrom(6.0, 10.0, "Photosynthesis happens inside the chloroplast."),
    takeFrom(12.0, 16.0, "Today we learn about plant biology basics."),
  ];
  const defs = heuristicTakeDefaults(takes);
  assert.equal(defs.length, 0, "three distinct lines → nothing grouped, nothing dropped");
  // A pair that shares only a couple of common words is NOT grouped (conservative).
  const nearMiss = [
    takeFrom(0.0, 4.0, "We are going to the market today."),
    takeFrom(6.0, 10.0, "We are leaving the office tomorrow."),
  ];
  assert.equal(heuristicTakeDefaults(nearMiss).length, 0,
    "shared function words must not merge two different lines");
});

// 19 ─ The AI pass with a MOCKED Claude grouping: full coverage (no part dropped),
//      exactly one keeper per group = the LAST, regardless of the model.
check("Stage 3 AI (mocked Claude): keep-LAST + full coverage enforced in code", async () => {
  const takes = [
    takeFrom(0.0, 4.0, "Intro line, take one."),      // earlier re-take
    takeFrom(6.0, 10.0, "Intro line, take two."),     // LAST re-take → keeper
    takeFrom(12.0, 16.0, "Second line of the script."), // part 2 (once)
  ];
  const ids = takes.map((t) => t.id);
  // The model only GROUPS (no "best" field) — keep-LAST is enforced in code.
  const claudeFn = async () => JSON.stringify({
    parts: [
      { part: "Intro line", takeIds: [ids[0], ids[1]] },
      { part: "Second line", takeIds: [ids[2]] },
    ],
  });
  const { defaults, usedAI } = await selectBestTakeDefaults(takes, { hasKey: true, claudeFn });
  assert.ok(usedAI, "the AI path was taken");
  const resolved = applyDefaults(takes, defaults, []);
  const enabled = resolved.filter((t) => t.enabled).map((t) => t.id);
  assert.deepEqual(enabled.sort(), [ids[1], ids[2]].sort(), "LAST of group 1 + the unique part 2 kept");
  const disabled = resolved.filter((t) => !t.enabled);
  assert.equal(disabled.length, 1, "exactly the earlier re-take is disabled");
  assert.equal(disabled[0].id, ids[0], "the EARLIER intro is the one disabled");
  assert.match(disabled[0].reason ?? "", /earlier take/);
});

// 20 ─ Guarantees ENFORCED despite a MISBEHAVING model: a forgotten take is not
//      dropped (own part), and the code keeps the LAST even if the model tried
//      to (via a bogus 'best' field) pick an earlier one.
check("Stage 3: guarantees hold under a misbehaving model (no drop, keep-LAST, order)", () => {
  const takes = [
    takeFrom(0.0, 4.0, "Part A, first delivery."),   // earlier A
    takeFrom(6.0, 10.0, "Part A, final delivery."),  // LAST A → must be keeper
    takeFrom(12.0, 16.0, "Part B, never mentioned by the model."),
  ];
  const ids = takes.map((t) => t.id);
  // Bad model: groups A's two but injects a bogus "best" naming the EARLIER take,
  // and FORGETS part B entirely. The code ignores 'best' and never drops B.
  const parts = [{ part: "Part A", best: ids[0], takeIds: [ids[0], ids[1]] }];
  const defs = defaultsFromParts(takes, parts as any);
  const resolved = applyDefaults(takes, defs, []);
  const enabled = resolved.filter((t) => t.enabled).map((t) => t.id);
  assert.ok(enabled.includes(ids[1]), "the LAST take A is the keeper, ignoring the model's 'best'");
  assert.ok(!enabled.includes(ids[0]), "the earlier take A is disabled");
  assert.ok(enabled.includes(ids[2]), "the un-assigned part B is kept as its own part (not dropped)");
  // Order preserved: the enabled set in time order is the full transcript once.
  assert.deepEqual(enabled, [ids[1], ids[2]], "enabled set is in time order, each part once");
});

// 21 ─ With no key, selection falls back to the heuristic (timeline still works).
check("no Anthropic key → heuristic fallback (usedAI false)", async () => {
  const takes = [
    takeFrom(0.0, 3.5, "Same line take one."),
    takeFrom(5.0, 8.6, "Same line take one."),
  ];
  const { usedAI, defaults } = await selectBestTakeDefaults(takes, { hasKey: false });
  assert.ok(!usedAI, "without a key the AI path is skipped");
  assert.equal(defaults.length, 1, "the heuristic still disables the earlier repeat");
});

// 22 ─ Full parity through the keep-LAST defaults: computeKeepSegments(env,…,defaults)
//      keep == what renderManualCut trims, and previewDuration == render duration.
check("parity holds with keep-LAST defaults: keep == render segments, durations match", () => {
  // Three loud blocks; blocks 1+2 are a re-take of the same long line.
  const hop = 0.02, duration = 18.0, n = Math.round(duration / hop);
  const loud = (t: number) =>
    (t >= 0.5 && t < 4.5) || (t >= 6.0 && t < 10.0) || (t >= 12.0 && t < 16.0);
  const db: number[] = [];
  for (let i = 0; i < n; i++) db.push(loud(i * hop) ? -12 : -60);
  const env: Envelope = { db, hop, duration };
  const words = [
    { word: "this", start: 0.6, end: 1.0 }, { word: "is", start: 1.1, end: 1.4 },
    { word: "the", start: 1.5, end: 1.8 }, { word: "intro.", start: 1.9, end: 4.3 },
    { word: "this", start: 6.1, end: 6.5 }, { word: "is", start: 6.6, end: 6.9 },
    { word: "the", start: 7.0, end: 7.3 }, { word: "intro.", start: 7.4, end: 9.8 },
    { word: "now", start: 12.1, end: 12.5 }, { word: "we", start: 12.6, end: 12.9 },
    { word: "begin.", start: 13.0, end: 15.8 },
  ];
  const detected = segmentTakes(env, words, DEFAULT_SETTINGS);
  assert.equal(detected.filter((t) => t.enabled).length, 3, "three real big blocks");
  const defs: TakeDefault[] = heuristicTakeDefaults(detected);
  assert.equal(defs.length, 1, "the EARLIER intro re-take is disabled by default");
  const plan = computeKeepSegments(env, words, DEFAULT_SETTINGS, defs, []);
  assert.equal(plan.keep.length, 2, "two enabled takes → 2 keep segments");
  // The kept intro is the LATER one (block 2), confirming keep-LAST in the keep set.
  assert.ok(plan.keep[0].start >= 5.9, `kept intro is the LATER block, starts ${plan.keep[0].start}`);
  // The render trims exactly plan.keep + gap; its duration equals previewDuration.
  const spec: CutSpec = { source: "/dev/null", segments: plan.keep, hasAudio: true, gap: plan.gap };
  const tmp = path.join(process.env.TMPDIR || "/tmp", `parity_ai_${Date.now()}.mp4`);
  const { totalDuration } = buildCutArgs(spec, tmp);
  try { fs.rmSync(`${tmp}.filter.txt`, { force: true }); } catch { /* */ }
  assert.ok(Math.abs(totalDuration - previewDuration(plan.keep, plan.gap)) < 1e-6,
    `render ${totalDuration} != preview ${previewDuration(plan.keep, plan.gap)}`);
});

await Promise.all(pending);
console.log(`\n${passed} parity checks passed.`);
