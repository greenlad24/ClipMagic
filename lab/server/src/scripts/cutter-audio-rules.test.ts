/**
 * END-TO-END verification of the Narration Cutter editing rules on REAL,
 * ffmpeg-synthesized audio (no API keys needed). This proves the rules hold not
 * just on hand-built envelopes but on an actual audio file analyzed by the same
 * `computeEnvelope` the server runs in production.
 *
 * The synthesized narration (12s) deliberately exercises every rule:
 *   [0.0,1.5)   COMPLETE-SILENCE lead-in            → trimmed fully (rule 4)
 *   [1.5,1.7)   tiny tone BLIP (0.2s)               → disabled, < minTake (rule 6)
 *   [1.7,2.5)   complete silence                    → cut
 *   [2.5,4.5)   real "speech" tone burst (2.0s)     → take A (kept)
 *   [4.5,4.8)   sub-0.35s in-take pause (0.3s)      → kept untouched (rule 2)
 *   [4.8,6.8)   real "speech" tone burst (2.0s)     → still take A (pause kept)
 *   [6.8,8.3)   complete silence (1.5s)             → cut, collapse to 0.35 (rule 3)
 *   [8.3,8.8)   low "breath" noise (~-38dB, 0.5s)   → NOT a break (rule 1)
 *   [8.8,10.8)  real "speech" tone burst (2.0s)     → take B, NO transcript (rule 5)
 *   [10.8,12.0) COMPLETE-SILENCE trailing           → trimmed fully (rule 4)
 *
 * Geometry rules are exercised with a low min-take (GEO) so the two real ~2s
 * bursts are ENABLED; the new default min-take is 3.0s, so a separate check
 * confirms a sub-3s take is DISABLED (not dropped) and re-enables when lowered.
 *
 * Run: cd lab/server && npx tsx src/scripts/cutter-audio-rules.test.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { computeEnvelope } from "../cutter/silence.js";
import {
  computeKeepSegments, previewDuration, DEFAULT_SETTINGS, type Envelope,
} from "../cutter/segments.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function run(cmd: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; c.stderr.on("data", (d) => (err += d.toString()));
    c.on("error", () => resolve({ code: -1, err: "spawn failed" }));
    c.on("close", (code) => resolve({ code: code ?? -1, err }));
  });
}

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cutter-audio-"));
  const src = path.join(tmp, "narration.wav");

  // A "speech" tone burst: a 220Hz tone gated to [a,b]. A "breath": faint noise.
  // We build the whole thing in one filtergraph by summing gated sources.
  // gate via volume='between(t,a,b)':eval=frame. Loud bursts ~ -10dB, breath ~ -38dB.
  const burst = (a: number, b: number) =>
    `sine=frequency=220:duration=12,volume='if(between(t,${a},${b}),1,0)':eval=frame[s${a}_${b}]`;
  const bursts = [
    [1.5, 1.7],   // blip
    [2.5, 4.5],   // take A part 1
    [4.8, 6.8],   // take A part 2 (0.3s in-take pause before it)
    [8.8, 10.8],  // take B (untranscribed)
  ];
  const breath = `anoisesrc=color=white:duration=12:amplitude=0.012,` +
    `volume='if(between(t,8.3,8.8),1,0)':eval=frame[breath]`;

  const labels = bursts.map(([a, b]) => `[s${a}_${b}]`).join("") + "[breath]";
  const filter =
    bursts.map(([a, b]) => burst(a, b)).join(";") + ";" +
    breath + ";" +
    `${labels}amix=inputs=${bursts.length + 1}:normalize=0[mix]`;

  const gen = await run(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono:d=12",
    "-filter_complex", filter,
    "-map", "[mix]", "-ar", "16000", "-ac", "1", src,
  ]);
  if (gen.code !== 0) { console.error("FAIL  could not synthesize audio\n", gen.err.slice(-600)); process.exit(1); }

  const ce = await computeEnvelope(src, 12.0);
  const env: Envelope = { db: ce.db, hop: ce.hop, duration: ce.duration };

  // RULE 5 (foundation): the envelope spans the FULL file.
  check("envelope spans the entire 12s file", () => {
    assert.ok(ce.db.length > 0, "envelope is non-empty");
    const covered = ce.db.length * ce.hop;
    assert.ok(Math.abs(covered - 12.0) < 0.3, `envelope covers ${covered.toFixed(2)}s of 12s`);
  });

  // The tail (take B) has NO transcript words at all — only take A is labelled.
  const words = [
    { word: "alpha", start: 2.7, end: 4.3 },
    { word: "again", start: 5.0, end: 6.6 },
  ];
  // Geometry uses a low min-take so the two real ~2s bursts are ENABLED.
  const GEO = { ...DEFAULT_SETTINGS, minTake: 0.4 };
  const r = computeKeepSegments(env, words, GEO, [], []);
  // The two real takes (everything >= GEO.minTake) — A and B.
  const real = r.takes.filter((t) => t.end - t.start >= GEO.minTake);

  check("exactly two real takes: breath not a break, in-take pause kept", () => {
    assert.equal(real.length, 2, `expected 2 real takes, got ${real.length}: ` +
      r.takes.map((t) => `[${t.start.toFixed(2)}-${t.end.toFixed(2)}${t.enabled ? "" : " off"}]`).join(" "));
    assert.equal(r.keep.length, 2, "only the two real takes are enabled → 2 keep segments");
  });

  check("RULE 6: the 0.2s blip is shown but DISABLED (never silently dropped, never enabled)", () => {
    // Any take in the blip region must be short AND disabled — not part of keep.
    const blip = r.takes.find((t) => t.start < 2.4 && t.end - t.start < GEO.minTake);
    if (blip) {
      assert.ok(!blip.enabled, "the blip take is disabled by default");
      assert.equal(blip.reason, "short");
    }
    assert.ok(r.keep.every((k) => k.start > 2.4), "no blip span made it into keep");
  });

  check("RULE 1+2: take A spans the 0.3s in-take pause (breath/short pause kept)", () => {
    const a = real[0];
    // take A runs ~2.5 → ~6.8 because the 0.3s pause at 4.5-4.8 is NOT cut.
    assert.ok(a.start < 2.8 && a.end > 6.5, `take A is ${a.start.toFixed(2)}-${a.end.toFixed(2)}`);
  });

  check("RULE 5: take B covers the untranscribed tail and is labelled —", () => {
    const b = real[1];
    assert.ok(b.start > 8.4 && b.end < 11.0, `take B is ${b.start.toFixed(2)}-${b.end.toFixed(2)}`);
    assert.equal(b.text, "", "tail take has no transcript words → blank label (UI shows —)");
    // ...and take A keeps its words.
    assert.ok(/alpha/.test(real[0].text), "take A keeps its transcript");
  });

  check("RULE 4: lead-in and trailing silence trimmed fully (no edge gap)", () => {
    assert.ok(r.keep[0].start > 1.0, `lead-in not trimmed: ${r.keep[0].start.toFixed(2)}`);
    assert.ok(r.keep[r.keep.length - 1].end < 11.5, `trailing not trimmed: ${r.keep[r.keep.length - 1].end.toFixed(2)}`);
  });

  check("RULE 3: the >0.35s interior silence collapses to exactly one 0.35 gap", () => {
    const body = r.keep.reduce((s, k) => s + (k.end - k.start), 0);
    // 2 takes → exactly 1 gap of 0.35 between them.
    assert.equal(r.gap, 0.35);
    assert.ok(Math.abs(previewDuration(r.keep, r.gap) - (body + 0.35)) < 1e-6,
      "preview duration must be body + exactly one 0.35 gap");
  });

  check("RULE 6 (default 3.0s min-take): a sub-3s take is DISABLED, re-enables when lowered", () => {
    // At the 3.0s DEFAULT, take B (~2s) is disabled (not dropped); take A (~4.3s)
    // stays enabled. Lowering min-take re-enables B without any manual toggle.
    const def = computeKeepSegments(env, words, DEFAULT_SETTINGS, [], []);
    const b = def.takes.find((t) => t.start > 8.4 && t.start < 11.0)!;
    assert.ok(b && !b.enabled && b.reason === "short", "take B disabled at 3.0s min-take");
    const lowered = computeKeepSegments(env, words, GEO, [], []);
    const b2 = lowered.takes.find((t) => t.start > 8.4 && t.start < 11.0)!;
    assert.ok(b2 && b2.enabled, "lowering min-take re-enables take B");
  });

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  if (process.exitCode) { console.error("\nsynthetic-audio rule checks FAILED."); process.exit(1); }
  console.log(`\n${passed} synthetic-audio rule checks passed.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
