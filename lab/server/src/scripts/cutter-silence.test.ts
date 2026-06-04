/**
 * Real-ffmpeg verification of the audio-energy (silence) detection + the
 * planner's boundary-snapping, using SYNTHESIZED audio with KNOWN tone bursts
 * (speech stand-ins) separated by KNOWN silent gaps. No API keys / no real
 * narration — everything here is deterministic ffmpeg + pure planning.
 *
 * Run: cd lab/server && npx tsx src/scripts/cutter-silence.test.ts
 *
 * Asserts:
 *   (a) no sample inside a "speech" burst is ever removed (no word-clipping),
 *   (b) silent gaps above the min-silence threshold ARE removed,
 *   (c) keep boundaries snap to within the silent regions,
 *   (d) aggressiveness levels behave monotonically.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { parseSilenceDetect, detectSilences } from "../cutter/silence.js";
import { planCuts, type PlanWord, type SilenceRegion } from "../cutter/plan.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}
async function acheck(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`); process.exitCode = 1; }
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
    c.on("error", () => resolve(-1));
    c.on("close", (code) => resolve(code ?? -1));
  });
}

/** Known layout: bursts of tone (speech) with silent gaps between them. */
const BURSTS = [
  { start: 0.0, end: 1.0 },
  { start: 2.0, end: 3.0 }, // gap 1.0–2.0 (1.0s silence)
  { start: 4.5, end: 5.5 }, // gap 3.0–4.5 (1.5s silence)
];
const TOTAL = 6.0;

/**
 * Build a WAV: a 440Hz tone for each burst window, true digital silence between.
 * We sum per-burst sine sources gated to their window via `between()`.
 */
async function synthAudio(file: string): Promise<number> {
  // One 440Hz sine per burst, each gated to its [start,end) window (volume 1
  // inside the burst, 0 = full digital silence outside), then mixed together.
  const inputs: string[] = [];
  const filters: string[] = [];
  BURSTS.forEach((b, i) => {
    inputs.push("-f", "lavfi", "-t", String(TOTAL), "-i", `sine=frequency=440:sample_rate=44100`);
    filters.push(`[${i}:a]volume='if(between(t,${b.start},${b.end}),1,0)':eval=frame[g${i}]`);
  });
  const mix = `${BURSTS.map((_, i) => `[g${i}]`).join("")}amix=inputs=${BURSTS.length}:normalize=0[a]`;
  const graph = [...filters, mix].join(";");
  return run(FFMPEG, [
    "-y", ...inputs,
    "-filter_complex", graph, "-map", "[a]",
    "-t", String(TOTAL), "-c:a", "pcm_s16le", file,
  ]);
}

async function main() {
  // ── Pure parser checks (no ffmpeg) ──────────────────────────────────────────
  check("parseSilenceDetect: paired start/end regions", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 1.000",
      "[silencedetect @ 0x1] silence_end: 2.000 | silence_duration: 1.000",
      "[silencedetect @ 0x1] silence_start: 3.000",
      "[silencedetect @ 0x1] silence_end: 4.500 | silence_duration: 1.500",
    ].join("\n");
    const regions = parseSilenceDetect(stderr, -32);
    assert.equal(regions.length, 2);
    assert.deepEqual(regions[0], { start: 1.0, end: 2.0, thresholdDb: -32 });
    assert.deepEqual(regions[1], { start: 3.0, end: 4.5, thresholdDb: -32 });
  });

  check("parseSilenceDetect: trailing start with no end closes at duration", () => {
    const stderr = "[silencedetect @ 0x1] silence_start: 5.000";
    const regions = parseSilenceDetect(stderr, -30, 6.0);
    assert.equal(regions.length, 1);
    assert.deepEqual(regions[0], { start: 5.0, end: 6.0, thresholdDb: -30 });
  });

  // ── Real ffmpeg: synthesized tone bursts + known silent gaps ─────────────────
  const ffOk = (await run(FFMPEG, ["-version"])) === 0;
  if (!ffOk) {
    console.log("  --  ffmpeg unavailable; skipping real-audio checks");
    console.log(`\n${passed} checks passed.`);
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cutter-silence-"));
  const wav = path.join(tmp, "narration.wav");
  const code = await synthAudio(wav);
  assert.equal(code, 0, "synthesized test WAV");

  const silences = await detectSilences(wav, TOTAL, { noiseFloorDb: -35, minSilence: 0.3 });

  await acheck("detectSilences finds the two known silent gaps", async () => {
    // Expect a silent region inside 1.0–2.0 and inside 3.0–4.5.
    const inGap = (a: number, b: number) =>
      silences.some((s) => s.start <= b - 0.2 && s.end >= a + 0.2 && s.start >= a - 0.25 && s.end <= b + 0.25);
    assert.ok(inGap(1.0, 2.0), `gap 1.0–2.0 detected, got ${JSON.stringify(silences)}`);
    assert.ok(inGap(3.0, 4.5), `gap 3.0–4.5 detected, got ${JSON.stringify(silences)}`);
  });

  await acheck("no burst region is reported as silence (speech never mistaken for dead air)", async () => {
    for (const b of BURSTS) {
      const mid = (b.start + b.end) / 2;
      const insideSilence = silences.some((s) => mid > s.start + 0.05 && mid < s.end - 0.05);
      assert.ok(!insideSilence, `burst ${b.start}-${b.end} mid (${mid}) must not be silent`);
    }
  });

  // Whisper-style word timings that DELIBERATELY drift into the gaps (loose
  // ends) — exactly the failure the user reported. We assert the planner, given
  // the measured silences, never removes a real burst sample and removes gaps.
  const words: PlanWord[] = [
    { word: "alpha", start: 0.0, end: 1.2 },   // Whisper end (1.2) overruns burst end (1.0)
    { word: "bravo", start: 1.8, end: 3.1 },   // start (1.8) precedes burst start (2.0); end overruns
    { word: "charlie", start: 4.3, end: 5.5 }, // start precedes burst start (4.5)
  ];

  const plan = planCuts(words, TOTAL, { silences });

  // Sample every burst at 50ms; assert each sample is inside some kept segment.
  const keptAt = (t: number) => plan.keep.some((k) => t >= k.start - 1e-6 && t <= k.end + 1e-6);
  await acheck("(a) no sample inside a speech burst is ever removed (no word-clipping)", async () => {
    for (const b of BURSTS) {
      for (let t = b.start + 0.02; t < b.end; t += 0.05) {
        assert.ok(keptAt(round(t)), `burst sample t=${round(t)} (in ${b.start}-${b.end}) was clipped; keep=${JSON.stringify(plan.keep)}`);
      }
    }
  });

  await acheck("(b) silent gaps above min-silence ARE removed", async () => {
    // The deep interior of each gap must NOT be kept.
    const gapInteriorKept = (a: number, b: number) => {
      const mid = (a + b) / 2;
      return plan.keep.some((k) => mid > k.start + 0.05 && mid < k.end - 0.05);
    };
    assert.ok(!gapInteriorKept(1.0, 2.0), "gap 1.0–2.0 interior removed");
    assert.ok(!gapInteriorKept(3.0, 4.5), "gap 3.0–4.5 interior removed");
  });

  await acheck("(c) every interior keep boundary sits inside measured silence, never mid-burst", async () => {
    const inSilence = (t: number) => silences.some((s) => t >= s.start - 0.06 && t <= s.end + 0.06);
    for (const k of plan.keep) {
      for (const edge of [k.start, k.end]) {
        // An interior edge (not the clip's own start/end) must land in real
        // low-energy audio, never strictly inside a speech burst.
        if (edge <= 0.001 || edge >= TOTAL - 0.001) continue;
        const insideBurst = BURSTS.some((b) => edge > b.start + 0.1 && edge < b.end - 0.1);
        assert.ok(!insideBurst, `keep edge ${edge} landed inside a speech burst`);
        assert.ok(inSilence(edge), `keep edge ${edge} should sit in a measured silent region`);
      }
    }
  });

  await acheck("(c2) when a transcript gap edge lands in speech, the planner snaps it OUTWARD to silence", async () => {
    // Loose Whisper ends that overrun the burst into the FOLLOWING silence would
    // normally trim mid-word. Construct a case where, absent the audio-detected
    // cut, the transcript-derived keep edge would clip a burst; assert snapping
    // pulls it to the silence. We give words whose gap is just over threshold so
    // the transcript pass owns the cut, with loose ends reaching into the burst.
    const loose: PlanWord[] = [
      { word: "one", start: 0.0, end: 0.7 },
      { word: "two", start: 0.75, end: 1.4 }, // end 1.4 overruns burst end 1.0 into silence
      { word: "three", start: 2.1, end: 2.9 },
    ];
    const p = planCuts(loose, TOTAL, { silences });
    const inSilence = (t: number) => silences.some((s) => t >= s.start - 0.06 && t <= s.end + 0.06);
    for (const k of p.keep) {
      for (const edge of [k.start, k.end]) {
        if (edge <= 0.001 || edge >= TOTAL - 0.001) continue;
        assert.ok(!BURSTS.some((b) => edge > b.start + 0.1 && edge < b.end - 0.1), `edge ${edge} inside burst`);
        assert.ok(inSilence(edge), `edge ${edge} not in silence`);
      }
    }
  });

  await acheck("(d) aggressiveness is monotonic on real measured silences", async () => {
    const g = planCuts(words, TOTAL, { silences, aggressiveness: "gentle" }).removedDuration;
    const b = planCuts(words, TOTAL, { silences, aggressiveness: "balanced" }).removedDuration;
    const a = planCuts(words, TOTAL, { silences, aggressiveness: "aggressive" }).removedDuration;
    assert.ok(b >= g - 1e-6, `balanced(${b.toFixed(3)}) >= gentle(${g.toFixed(3)})`);
    assert.ok(a >= b - 1e-6, `aggressive(${a.toFixed(3)}) >= balanced(${b.toFixed(3)})`);
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n${passed} checks passed.`);
  if (process.exitCode) console.error("Some checks FAILED.");
}

const round = (n: number) => Math.round(n * 1000) / 1000;

main().catch((e) => { console.error(e); process.exit(1); });
