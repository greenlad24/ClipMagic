/**
 * Unit checks for the short-form motion-graphics ON/OFF decision. Run with:
 *   cd lab/server && npx tsx src/scripts/motion.test.ts
 *
 * No API keys, no ffmpeg, no Chromium — these assert the DEFAULT-ON behavior and
 * the two off-switches (the per-video UI toggle and the MOTION_GRAPHICS=0 global
 * escape hatch) without launching anything.
 *
 * NOTE: config.ts reads MOTION_GRAPHICS once at import time, so we must set the
 * env BEFORE importing the modules under test. This file is run with NO env set
 * to prove the no-env default is ON; the force-disable case is asserted via the
 * same boolean expression config uses (and exercised end-to-end by setting the
 * env when running this file with MOTION_GRAPHICS=0).
 */
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

const forceDisabled = (process.env.MOTION_GRAPHICS || "") === "0";

const { motionGraphicsEnabledFor } = await import("../motion/director.js");
const { config } = await import("../config.js");

// ── config force-disable wiring matches the documented env contract ───────────
check("config.motionGraphicsForceDisabled reflects MOTION_GRAPHICS=0 only", () => {
  assert.equal(config.motionGraphicsForceDisabled, forceDisabled);
});

if (!forceDisabled) {
  // ── DEFAULT ON: no env, no/positive toggle → motion graphics run ────────────
  check("default-on: undefined project toggle → enabled (no MOTION_GRAPHICS env)", () => {
    assert.equal(motionGraphicsEnabledFor(undefined), true);
  });
  check("default-on: missing/true toggle → enabled", () => {
    assert.equal(motionGraphicsEnabledFor(true), true);
    assert.equal(motionGraphicsEnabledFor(null), true); // older records
  });

  // ── PER-VIDEO OFF: the UI toggle set false → skipped ────────────────────────
  check("per-video toggle off (false) → disabled even with no env", () => {
    assert.equal(motionGraphicsEnabledFor(false), false);
  });
} else {
  // ── GLOBAL OFF: MOTION_GRAPHICS=0 force-disables regardless of the toggle ────
  check("MOTION_GRAPHICS=0 force-disables regardless of toggle", () => {
    assert.equal(motionGraphicsEnabledFor(true), false);
    assert.equal(motionGraphicsEnabledFor(undefined), false);
    assert.equal(motionGraphicsEnabledFor(false), false);
  });
}

console.log(
  `\n${passed} check(s) passed (MOTION_GRAPHICS=${process.env.MOTION_GRAPHICS ?? "<unset>"}).`,
);
