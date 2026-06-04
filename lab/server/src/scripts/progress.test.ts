/**
 * Unit checks for the render progress-banding math (render/progress.ts). Run:
 *   cd lab/server && npx tsx src/scripts/progress.test.ts
 *
 * No ffmpeg, no Chromium — pure math. These guarantee the property the whole fix
 * relies on: the main render maps into [0, 0.55], the post-render stage maps into
 * [0.55, 1.0], both are monotonic, and the bar never escapes [0, 1] (so it only
 * reaches 100% when the final output is truly done).
 */
import assert from "node:assert/strict";
import {
  MAIN_BAND_END,
  bandFraction,
  mainRenderProgress,
  stageProgress,
  stageFraction,
} from "../render/progress.js";

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

const samples = [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1];

// ── Main render maps into [0, 0.55] when a post-render stage follows ───────────
check("main-render fraction maps into [0, 0.55] with post-render work", () => {
  assert.equal(mainRenderProgress(0, true), 0);
  assert.equal(mainRenderProgress(1, true), MAIN_BAND_END);
  for (const f of samples) {
    const p = mainRenderProgress(f, true);
    assert.ok(p >= 0 && p <= MAIN_BAND_END, `frac ${f} → ${p} escaped [0, ${MAIN_BAND_END}]`);
  }
});

// ── With NO post-render work the main render owns the whole bar [0, 1] ─────────
check("main-render fraction maps into [0, 1] without post-render work", () => {
  assert.equal(mainRenderProgress(0, false), 0);
  assert.equal(mainRenderProgress(1, false), 1);
  assert.equal(mainRenderProgress(0.5, false), 0.5);
});

// ── Stage maps into [0.55, 1.0]; only frac=1 reaches the top ───────────────────
check("stage fraction maps into [0.55, 1.0]", () => {
  assert.equal(stageProgress(0), MAIN_BAND_END);
  assert.equal(stageProgress(1), 1);
  for (const f of samples) {
    const p = stageProgress(f);
    assert.ok(p >= MAIN_BAND_END && p <= 1, `frac ${f} → ${p} escaped [${MAIN_BAND_END}, 1]`);
  }
});

// ── Monotonic: more input never decreases output ───────────────────────────────
check("banding is monotonic and never exceeds 1", () => {
  let prevMain = -1;
  let prevStage = -1;
  for (const f of samples) {
    const m = mainRenderProgress(f, true);
    const s = stageProgress(f);
    assert.ok(m >= prevMain, `main not monotonic at ${f}`);
    assert.ok(s >= prevStage, `stage not monotonic at ${f}`);
    assert.ok(m <= 1 && s <= 1, `exceeded 1 at ${f}`);
    prevMain = m;
    prevStage = s;
  }
});

// ── The two bands meet exactly at MAIN_BAND_END (no gap, no overlap jump) ───────
check("main band end == stage band start (continuous handoff)", () => {
  assert.equal(mainRenderProgress(1, true), stageProgress(0));
});

// ── Out-of-range inputs are clamped, not propagated ────────────────────────────
check("inputs are clamped to [0, 1]", () => {
  assert.equal(mainRenderProgress(-5, true), 0);
  assert.equal(mainRenderProgress(5, true), MAIN_BAND_END);
  assert.equal(stageProgress(-1), MAIN_BAND_END);
  assert.equal(stageProgress(2), 1);
  assert.equal(bandFraction(0.5, 0.2, 0.8), 0.5);
  assert.equal(bandFraction(2, 0.55, 1), 1);
});

// ── stageFraction: render phase fills the front, composite the back ────────────
check("stageFraction advances per clip, then through the composite", () => {
  // 4 clips, default 0.6 render share.
  const f0 = stageFraction({ rendered: 0, total: 4, composite: 0 });
  const f2 = stageFraction({ rendered: 2, total: 4, composite: 0 });
  const f4 = stageFraction({ rendered: 4, total: 4, composite: 0 });
  const fc = stageFraction({ rendered: 4, total: 4, composite: 1 });
  assert.equal(f0, 0);
  assert.ok(f2 > f0 && f2 < f4, "mid-render should advance");
  assert.ok(Math.abs(f4 - 0.6) < 1e-9, "all clips rendered → render share (0.6)");
  assert.equal(fc, 1, "composite done → 1.0");
  // total=0 (defensive) → fully rendered, only composite remains.
  assert.equal(stageFraction({ rendered: 0, total: 0, composite: 0 }), 0.6);
});

console.log(`\n${passed} checks passed.`);
