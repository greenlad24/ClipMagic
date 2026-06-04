/**
 * Unit checks for the Narration Cutter planner (cutter/plan.ts). Run with:
 *   cd lab/server && npx tsx src/scripts/cutter-plan.test.ts
 *
 * Pure/deterministic — no API keys, no ffmpeg. Asserts the cut plan against
 * known word-timestamp fixtures.
 */
import { planCuts, isFiller, type PlanWord, type SilenceRegion } from "../cutter/plan.js";
import assert from "node:assert/strict";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

// Build evenly-spaced words: each 0.4s long, with a given gap before it.
function words(spec: Array<[string, number, number]>): PlanWord[] {
  return spec.map(([word, start, end]) => ({ word, start, end }));
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const totalKept = (segs: { start: number; end: number }[]) =>
  round(segs.reduce((s, k) => s + (k.end - k.start), 0));

// ── Filler classification ─────────────────────────────────────────────────────
check("fillers match um/uh family but NOT so/like/you-know", () => {
  for (const f of ["um", "Um,", "uhh", "er", "mm", "hmm", "huh"]) assert.ok(isFiller(f), f);
  for (const w of ["so", "like", "you", "know", "really", "actually"]) assert.ok(!isFiller(w), w);
});

// ── Natural mid-sentence pause is PRESERVED (min-silence guard) ────────────────
check("short mid-sentence pause (0.4s) is NOT cut", () => {
  // gap of 0.4s — above the 0.45 threshold? No (0.4<0.45) → no cut anyway, but
  // even a 0.5s gap with default pads leaves too little removable to bother.
  const w = words([
    ["hello", 0.0, 0.4],
    ["there", 0.9, 1.3], // 0.5s gap
  ]);
  const plan = planCuts(w, 1.3);
  // With pads (0.12*2) + stub (0.18) reserved from a 0.5s gap, removable < minSilence(0.3) → keep all.
  assert.equal(plan.silenceCuts, 0, "should not cut a borderline pause");
  assert.equal(plan.keep.length, 1);
});

// ── A real long silence IS trimmed, leaving a natural pause stub ───────────────
check("long silence (2s) is trimmed but leaves a pause stub (not butt-joined)", () => {
  const w = words([
    ["first", 0.0, 0.5],
    ["second", 2.5, 3.0], // 2.0s gap
  ]);
  const plan = planCuts(w, 3.0);
  assert.equal(plan.silenceCuts, 1);
  assert.equal(plan.keep.length, 2);
  // The OUTPUT pause after concat = pad kept after word1 + pad kept before word2.
  // (Source-time gap between keeps would be the cut span; what the listener hears
  //  is the retained padding on each side.) Should be a short, natural pause.
  const outputPause = round((plan.keep[0].end - 0.5) + (2.5 - plan.keep[1].start));
  assert.ok(outputPause > 0.1 && outputPause < 0.6, `natural pause retained, got ${outputPause}s`);
  // The kept word edges should not be clipped: padding kept around each word.
  assert.ok(plan.keep[0].end >= 0.5, "first word tail not clipped");
  assert.ok(plan.keep[1].start <= 2.5, "second word onset not clipped");
});

// ── Leading + trailing dead air removed ───────────────────────────────────────
check("leading and trailing dead air are removed down to a pad", () => {
  // Enough real speech that the 20%-kept safety floor doesn't trip.
  const w = words([
    ["this", 3.0, 3.3],
    ["is", 3.35, 3.5],
    ["the", 3.55, 3.7],
    ["actual", 3.75, 4.1],
    ["narration", 4.15, 4.6],
  ]);
  const plan = planCuts(w, 8.0);
  assert.ok(plan.keep[0].start > 2.5, "leading dead air cut");
  assert.ok(plan.keep[plan.keep.length - 1].end < 5.2, "trailing dead air cut");
});

// ── Filler removal ─────────────────────────────────────────────────────────────
check("um/uh fillers are cut, real words kept", () => {
  const w = words([
    ["I", 0.0, 0.2],
    ["um", 0.25, 0.5],
    ["think", 0.55, 0.9],
    ["so", 0.95, 1.2], // must be KEPT (guarantee)
  ]);
  const plan = planCuts(w, 1.2);
  assert.equal(plan.fillerCuts, 1);
  // "so" survives: kept duration covers the region around 0.95–1.2.
  const coversSo = plan.keep.some((k) => k.start <= 1.0 && k.end >= 1.15);
  assert.ok(coversSo, '"so" must be preserved');
});

// ── Stutter / false-start collapse ────────────────────────────────────────────
check("immediate stutter (the the the) collapses to the last occurrence", () => {
  const w = words([
    ["the", 0.0, 0.2],
    ["the", 0.25, 0.45],
    ["the", 0.5, 0.7],
    ["cat", 0.75, 1.0],
  ]);
  const plan = planCuts(w, 1.0);
  assert.ok(plan.stutterCuts >= 1, "stutter detected");
  // The kept audio should start near the LAST "the" (~0.5) not the first (0.0).
  assert.ok(plan.keep[0].start >= 0.4, `kept the clean final repeat, got start ${plan.keep[0].start}`);
});

check("emphatic repeats (very very) are NOT collapsed", () => {
  const w = words([
    ["it", 0.0, 0.2],
    ["was", 0.25, 0.45],
    ["very", 0.5, 0.8],
    ["very", 0.85, 1.15],
    ["good", 1.2, 1.5],
  ]);
  const plan = planCuts(w, 1.5);
  assert.equal(plan.stutterCuts, 0, "emphatic repetition preserved");
});

check("repeats separated by other words are NOT stutters", () => {
  const w = words([
    ["dog", 0.0, 0.3],
    ["and", 0.4, 0.6],
    ["cat", 0.7, 1.0],
    ["dog", 1.1, 1.4], // same word later — legitimate, not a stutter
  ]);
  const plan = planCuts(w, 1.4);
  assert.equal(plan.stutterCuts, 0);
});

// ── Safety: no usable transcript → whole clip kept ────────────────────────────
check("empty transcript keeps the whole clip", () => {
  const plan = planCuts([], 10);
  assert.equal(plan.keep.length, 1);
  assert.equal(round(plan.keptDuration), 10);
});

check("plan never removes more than ~everything (safety floor)", () => {
  // All words are fillers — would zero out the clip; safety keeps the original.
  const w = words([
    ["um", 0.0, 0.3],
    ["uh", 0.4, 0.7],
  ]);
  const plan = planCuts(w, 0.7);
  assert.ok(plan.keptDuration > 0, "never produces an empty clip");
});

// ── extraCuts (losing duplicate takes) applied ────────────────────────────────
check("extraCuts ranges (duplicate takes) are removed", () => {
  const w = words([
    ["take", 0.0, 0.3],
    ["one", 0.35, 0.6],
    ["take", 1.0, 1.3],
    ["two", 1.35, 1.6],
  ]);
  const plan = planCuts(w, 1.6, { extraCuts: [{ start: 0.0, end: 0.7 }] });
  // The first "take one" region should be gone.
  const keepsStart = plan.keep[0].start;
  assert.ok(keepsStart >= 0.6, `losing take dropped, kept starts at ${keepsStart}`);
});

// ── Audio-energy awareness (measured silences) ────────────────────────────────
// A keep-segment never overlaps a "speech burst" region (no word-clipping), and
// a measured silent region above min-silence IS removed even if Whisper smeared
// words across it. Helper: does any keep overlap [a,b]?
const overlapsKeep = (keep: { start: number; end: number }[], a: number, b: number) =>
  keep.some((k) => k.start < b - 1e-6 && k.end > a + 1e-6);

check("snap: a keep boundary inside speech is pushed out to true silence (no word clipped)", () => {
  // Whisper says word2 ENDS at 2.0, but the real audio shows speech runs to 2.30
  // and silence only starts at 2.30. A transcript-only trim would cut at ~2.0,
  // clipping the word's tail. With the measured silence, the keep must extend to
  // at least the silence start so the spoken tail (2.0–2.30) survives.
  const w = words([
    ["a", 0.0, 0.4],
    ["word", 0.45, 2.0],   // Whisper end is loose/early
    ["next", 4.0, 4.4],    // long gap -> a cut happens between them
  ]);
  const silences: SilenceRegion[] = [{ start: 2.3, end: 3.8, thresholdDb: -34 }];
  const plan = planCuts(w, 4.4, { silences });
  // The real spoken tail (2.0 .. 2.30) must NOT be removed.
  assert.ok(overlapsKeep(plan.keep, 2.05, 2.25), "word tail kept (not clipped)");
  // The kept region's right edge near the gap must sit at/after the silence start.
  const edge = plan.keep.find((k) => k.end >= 2.0 && k.end <= 3.9);
  assert.ok(edge && edge.end >= 2.3 - 0.06, `right edge snapped into silence, got ${edge?.end}`);
  assert.ok(plan.boundariesSnapped >= 1, "a boundary was snapped");
});

check("audio-detected dead air the transcript missed IS removed", () => {
  // Whisper transcribed CONTINUOUS words with NO gap above the threshold (it
  // smeared a word over the pause), but the audio shows a real 1.2s dead-air
  // region in the middle. The transcript-gap pass can't see it; the audio pass
  // must remove it.
  const w = words([
    ["keep", 0.0, 0.4],
    ["this", 0.45, 0.9],
    ["word", 0.95, 2.2],  // Whisper stretched this token across the real pause
    ["and", 2.25, 2.6],
    ["this", 2.65, 3.0],
  ]);
  const silences: SilenceRegion[] = [{ start: 1.0, end: 2.2, thresholdDb: -40 }];
  const plan = planCuts(w, 3.0, { silences });
  // The measured dead-air interior must be removed (nothing kept deep inside it).
  assert.ok(!overlapsKeep(plan.keep, 1.3, 1.9), "audio dead air removed");
  // The audio-detected cut is reflected in diagnostics with a measured dB.
  const audioCut = plan.diagnostics.find((d) => d.reason.includes("audio-detected"));
  assert.ok(audioCut && audioCut.measuredDb === -40, "audio-detected diagnostic carries dBFS");
});

check("diagnostics enumerate every kept + removed region with reasons", () => {
  const w = words([
    ["intro", 0.0, 0.5],
    ["um", 0.55, 0.8],
    ["body", 3.0, 3.5], // big gap -> silence cut
  ]);
  const plan = planCuts(w, 4.0, { silences: [{ start: 0.9, end: 2.9, thresholdDb: -36 }] });
  assert.ok(plan.diagnostics.length >= 2, "has a breakdown");
  assert.ok(plan.diagnostics.some((d) => d.kind === "keep"), "kept regions listed");
  assert.ok(plan.diagnostics.some((d) => d.kind === "filler"), "filler region listed");
  assert.ok(plan.diagnostics.some((d) => d.kind === "silence"), "silence region listed");
  // Sorted by start time, ascending.
  for (let i = 1; i < plan.diagnostics.length; i++) {
    assert.ok(plan.diagnostics[i].start >= plan.diagnostics[i - 1].start, "diagnostics ordered by time");
  }
});

check("aggressiveness is monotonic: aggressive removes >= balanced >= gentle", () => {
  // A read with several medium pauses; more aggressive should remove at least as
  // much as gentler settings (never less).
  const w = words([
    ["one", 0.0, 0.4],
    ["two", 1.0, 1.4],   // 0.6s gap
    ["three", 2.2, 2.6], // 0.8s gap
    ["four", 3.6, 4.0],  // 1.0s gap
    ["five", 5.2, 5.6],  // 1.2s gap
  ]);
  const silences: SilenceRegion[] = [
    { start: 0.45, end: 0.95, thresholdDb: -36 },
    { start: 1.45, end: 2.15, thresholdDb: -36 },
    { start: 2.65, end: 3.55, thresholdDb: -36 },
    { start: 4.05, end: 5.15, thresholdDb: -36 },
  ];
  const gentle = planCuts(w, 5.6, { silences, aggressiveness: "gentle" }).removedDuration;
  const balanced = planCuts(w, 5.6, { silences, aggressiveness: "balanced" }).removedDuration;
  const aggressive = planCuts(w, 5.6, { silences, aggressiveness: "aggressive" }).removedDuration;
  assert.ok(balanced >= gentle - 1e-6, `balanced(${balanced.toFixed(3)}) >= gentle(${gentle.toFixed(3)})`);
  assert.ok(aggressive >= balanced - 1e-6, `aggressive(${aggressive.toFixed(3)}) >= balanced(${balanced.toFixed(3)})`);
});

check("falls back to transcript-only behaviour when no silences are provided", () => {
  const w = words([
    ["first", 0.0, 0.5],
    ["second", 2.5, 3.0],
  ]);
  const without = planCuts(w, 3.0);
  assert.equal(without.boundariesSnapped, 0, "no snapping without audio");
  assert.equal(without.silenceCuts, 1, "transcript silence still trimmed");
});

console.log(`\n${passed} checks passed.`);
if (process.exitCode) console.error("Some checks FAILED.");
