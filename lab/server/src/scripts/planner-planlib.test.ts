/**
 * Unit checks for the Video Planner's grader (planner/planlib.ts). Run with:
 *   cd lab/server && npx tsx src/scripts/planner-planlib.test.ts
 *
 * Pure/deterministic — no API keys, no ffmpeg. planlib is what decides whether
 * a generated plan ships or gets sent back for repair, so a silent regression
 * here is a silent regression in every plan the tool produces.
 */
import {
  parsePlan,
  measurePlan,
  planDeviations,
  planPenalty,
  PLAN_CHAR_BUDGET,
  SLACK_MESSAGE_LIMIT,
} from "../planner/planlib.js";
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

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * A plan shaped like the corpus: screencast ~70% of runtime, screencast holds
 * around 13s, face returns around 8s, one screencast→screencast run per cycle
 * so alternation isn't a metronome, and an opening cut ~2x faster than the body.
 *
 * Lengths are whole seconds because the plan format is [M:SS] — a fractional
 * fixture measures as something other than what it looks like.
 */
const OPENING_CYCLE: [string, number][] = [
  ["sc", 7],
  ["th", 4],
  ["sc", 7],
  ["sc", 7],
  ["th", 4],
];
const BODY_CYCLE: [string, number][] = [
  ["sc", 14],
  ["th", 8],
  ["sc", 13],
  ["sc", 13],
  ["th", 8],
];

function corpusPlan(durationSec: number, instruction = "GoodTaco — open the dashboard."): string {
  const lines: string[] = [];
  let t = 0;
  let i = 0;
  while (t < durationSec) {
    const cycle = t < 90 ? OPENING_CYCLE : BODY_CYCLE;
    const [kind, len] = cycle[i++ % cycle.length];
    const end = Math.min(t + len, durationSec);
    // Only screencasts are written; the "th" slots are left uncovered on
    // purpose — that gap IS the talking-head shot.
    if (kind === "sc") lines.push(`[${mmss(t)} to ${mmss(end)}] - Screencast: ${instruction}`);
    t = end;
  }
  // ~1.3 titles per minute, overlaying the base visuals.
  const titles = Math.round((durationSec / 60) * 1.3);
  for (let n = 0; n < titles; n++) {
    const at = Math.floor((n + 0.5) * (durationSec / titles));
    lines.push(`[${mmss(at)} to ${mmss(at + 2)}] - Text (gradient): "Key idea ${n}"`);
  }
  return lines.join("\n");
}

const measured = (raw: string, dur: number) => measurePlan(parsePlan(raw), dur, raw);

// ── parsing ────────────────────────────────────────────────────────────────

check("classifies every element type by its leading word", () => {
  const p = parsePlan(
    [
      `[0:05 to 0:15] - Screencast: Sheets — edit a cell.`,
      `[0:15 to 0:19] - Stock footage: developer at night`,
      `[0:06 to 0:08] - Text (gradient): "One line"`,
      `[0:10 to 0:16] - Text (whiteboard): "A sentence. And another."`,
    ].join("\n")
  );
  assert.equal(p.base.length, 2, "only written visuals are base shots");
  assert.equal(p.titles.length, 2, "titles are held out of the tiling");
  assert.equal(p.unknown.length, 0, "nothing unrecognised");
  assert.equal(p.base[0].kind, "screencast");
});

check("a bare 'Talking head' line with no colon still parses", () => {
  // The prompt's own example omits the colon now that zoom direction is gone,
  // so a colon-only matcher would silently drop every face return.
  const p = parsePlan(`[0:00 to 0:05] - Talking head`);
  assert.equal(p.base.length, 1);
  assert.equal(p.base[0].kind, "talking_head");
});

check("an unrecognised element is counted, not silently dropped", () => {
  const m = measured(`[0:00 to 0:05] - B-roll: something`, 5);
  assert.equal(m.unknown, 1);
  assert.match(planDeviations(m).join(" "), /do not start with a recognised element/);
});

// ── coverage ───────────────────────────────────────────────────────────────

check("an uncovered stretch becomes a talking-head shot, not an error", () => {
  const m = measured([`[0:00 to 0:05] - Screencast: x`, `[0:12 to 0:20] - Screencast: y`].join("\n"), 20);
  assert.equal(m.gaps.length, 0, "a hole in the written plan is not a gap");
  assert.equal(m.shots, 3, "the 7s hole is reconstructed as a talking-head shot");
  assert.ok(m.talkingHeadPct > 30, `the hole counts as talking-head runtime, got ${m.talkingHeadPct}%`);
  assert.deepEqual(
    planDeviations(m).filter((d) => d.includes("GAP")),
    [],
    "an uncovered stretch is never reported as a gap"
  );
});

check("two visuals on the same second is still an error", () => {
  const m = measured([`[0:00 to 0:10] - Screencast: x`, `[0:08 to 0:12] - Stock footage: y`].join("\n"), 12);
  assert.equal(m.overlaps.length, 1, "the 2s overlap is found");
  assert.match(planDeviations(m).join(" "), /OVERLAP/);
});

check("a plan that stops minutes short of the runtime is flagged as truncated", () => {
  const m = measured(corpusPlan(300), 600);
  assert.match(planDeviations(m).join(" "), /with nothing planned/);
});

check("a short talking-head tail at the end is NOT flagged", () => {
  // The plan legitimately stops before the video does — the last stretch is
  // Jake on camera and needs no line. Only a multi-minute hole is truncation.
  const m = measured(corpusPlan(560), 600);
  assert.deepEqual(
    planDeviations(m).filter((d) => d.includes("nothing planned")),
    []
  );
});

// ── the corpus bands ───────────────────────────────────────────────────────

check("a corpus-shaped plan passes clean", () => {
  const m = measured(corpusPlan(600), 600);
  assert.deepEqual(planDeviations(m), [], `expected no deviations, got: ${planDeviations(m).join(" | ")}`);
  assert.equal(planPenalty(m), 0);
});

check("over-cutting is caught even when the element mix is right", () => {
  // A near-corpus 67/33 split with every shot chopped to a third. Mix alone
  // cannot see this — it is the failure Jake spotted in the first head-to-head.
  const lines: string[] = [];
  let t = 0;
  let sc = true;
  while (t < 600) {
    const end = Math.min(t + (sc ? 4 : 2), 600);
    if (sc) lines.push(`[${mmss(t)} to ${mmss(end)}] - Screencast: x`);
    t = end;
    sc = !sc;
  }
  const m = measured(lines.join("\n"), 600);
  assert.ok(m.screencastPct >= 65 && m.screencastPct <= 76, `mix should look fine, got ${m.screencastPct}%`);
  const devs = planDeviations(m).join(" ");
  assert.match(devs, /Cuts per minute is .* too HIGH/);
  assert.match(devs, /Median screencast hold/);
});

check("gradient titles are held to one line with no full stop", () => {
  const m = measured(
    [
      `[0:01 to 0:03] - Text (gradient): "This one runs well past the forty character ceiling for a single line"`,
      `[0:05 to 0:07] - Text (gradient): "Ends in a stop."`,
    ].join("\n"),
    10
  );
  assert.equal(m.longGradient.length, 1);
  assert.equal(m.gradientFullStop, 1);
});

check("whiteboard titles may end in a full stop", () => {
  // A gradient-only rule. The checker got this wrong once and flagged correct
  // whiteboard titles — verify which side is wrong before "fixing" it again.
  const m = measured(
    [`[0:01 to 0:06] - Text (whiteboard): "Step one. Step two."`].join("\n"),
    10
  );
  assert.equal(m.gradientFullStop, 0);
});

// ── hook vs body pace ──────────────────────────────────────────────────────

/**
 * Barely any change of pace: hook ~7.1 cuts/min, body ~5.0. Both rates sit
 * inside their own bands; only the 1.4x ratio is wrong. This mirrors the real
 * failure — a generated plan came in at 1.45x with both rates individually fine.
 */
function flatPlan(durationSec: number): string {
  const hook: [string, number][] = [
    ["sc", 12],
    ["th", 5],
  ];
  const body: [string, number][] = [
    ["sc", 17],
    ["th", 7],
  ];
  const lines: string[] = [];
  let t = 0;
  let i = 0;
  while (t < durationSec) {
    const cycle = t < 90 ? hook : body;
    const [kind, len] = cycle[i++ % cycle.length];
    const end = Math.min(t + len, durationSec);
    if (kind === "sc") lines.push(`[${mmss(t)} to ${mmss(end)}] - Screencast: x`);
    t = end;
  }
  return lines.join("\n");
}

check("a corpus-shaped plan lands near Jake's 1.9x hook-to-body ratio", () => {
  const m = measured(corpusPlan(600), 600);
  assert.ok(m.hookBodyRatio !== null, "the ratio is measured");
  assert.ok(m.hookBodyRatio! >= 1.5 && m.hookBodyRatio! <= 2.4, `got ${m.hookBodyRatio}x`);
});

check("a FLAT plan is flagged even when both cut rates sit inside their bands", () => {
  // This is the whole point of the ratio: the hook and body rates can each be
  // individually acceptable while the plan has no change of pace at all.
  const m = measured(flatPlan(600), 600);
  const devs = planDeviations(m);
  assert.equal(
    devs.filter((d) => d.includes("in the OPENING") || d.includes("AFTER the first")).length,
    0,
    `both rate bands should pass on their own, got: ${devs.join(" | ")}`
  );
  const flat = devs.find((d) => d.includes("Hook pace"));
  assert.ok(flat, `expected the ratio to be flagged, got: ${devs.join(" | ")}`);
  assert.match(flat!, /too FLAT/);
  // The fix must be to slow the body, not to chop the hook finer.
  assert.match(flat!, /SLOWING THE BODY/);
});

check("the ratio is not reported for a video too short to have a body", () => {
  const m = measured(corpusPlan(120), 120);
  assert.equal(m.hookBodyRatio, null);
  assert.equal(planDeviations(m).filter((d) => d.includes("Hook pace")).length, 0);
});

// ── the Slack character budget ─────────────────────────────────────────────

check("chars measures the raw text when it is supplied", () => {
  const raw = corpusPlan(600);
  assert.equal(measured(raw, 600).chars, raw.trim().length);
});

check("chars falls back to re-rendering the parsed lines", () => {
  const raw = corpusPlan(600);
  const withoutRaw = measurePlan(parsePlan(raw), 600).chars;
  assert.ok(withoutRaw > 0, "a plan always has a length");
  assert.ok(Math.abs(withoutRaw - raw.trim().length) < raw.length * 0.05, "within 5% of the real text");
});

check("a plan inside the budget is not flagged", () => {
  const m = measured(corpusPlan(600), 600);
  assert.ok(m.chars < PLAN_CHAR_BUDGET, `expected under budget, got ${m.chars}`);
  assert.equal(
    planDeviations(m).filter((d) => d.includes("Slack")).length,
    0
  );
});

check("a plan over the budget is flagged with the shortfall and told what to cut", () => {
  // Long instructions, correct shape — length is the only thing wrong.
  const fat = corpusPlan(600, "x".repeat(1500));
  const m = measured(fat, 600);
  assert.ok(m.chars > PLAN_CHAR_BUDGET, `fixture should exceed the budget, got ${m.chars}`);
  const dev = planDeviations(m).find((d) => d.includes("Slack"));
  assert.ok(dev, "the over-length plan is flagged");
  assert.match(dev!, new RegExp(`cuts off at ${SLACK_MESSAGE_LIMIT}`));
  assert.match(dev!, /cut about \d+ characters/);
  // The repair must not be allowed to buy room by dropping coverage.
  assert.match(dev!, /never the coverage/i);
  assert.match(dev!, /Do not delete lines/);
});

check("length penalty dominates, so a long plan never wins on style", () => {
  const clean = measured(corpusPlan(600), 600);
  const fat = measured(corpusPlan(600, "x".repeat(1500)), 600);
  assert.equal(planPenalty(clean), 0);
  assert.ok(planPenalty(fat) > 50, `expected a heavy penalty, got ${planPenalty(fat)}`);
});

check("no deviation ever renders a placeholder instead of guidance", () => {
  // A deviation whose advice comes out as "undefined" still fails the plan but
  // tells the model nothing about how to fix it, so the repair round guesses —
  // and it guesses wrong. This happened for real: a band() call built with the
  // wrong argument shape silently dropped its guidance, and the repair
  // satisfied the hook/body ratio by chopping the hook finer instead of
  // slowing the body, which is the opposite of the intended fix.
  const broken = [
    flatPlan(600), // ratio too flat
    corpusPlan(600, "x".repeat(1500)), // over the character budget
    corpusPlan(300), // stops short of the runtime
    [`[0:00 to 0:05] - B-roll: something`].join("\n"), // unknown element
    [
      `[0:01 to 0:03] - Text (gradient): "Well past the forty character ceiling for a single line of text"`,
      `[0:04 to 0:06] - Text (gradient): "Ends in a stop."`,
    ].join("\n"),
  ];
  for (const raw of broken) {
    for (const d of planDeviations(measured(raw, 600))) {
      assert.doesNotMatch(d, /undefined|\[object Object\]|NaN/, `unrendered value in: ${d}`);
      assert.ok(d.length > 60, `deviation carries no guidance: ${d}`);
    }
  }
});

check("the budget leaves headroom under Slack's real limit", () => {
  assert.ok(PLAN_CHAR_BUDGET < SLACK_MESSAGE_LIMIT, "grade below the hard limit");
  assert.ok(SLACK_MESSAGE_LIMIT - PLAN_CHAR_BUDGET >= 1000, "keep room for the operator's own text");
});

console.log(`\n${passed} checks passed.`);
if (process.exitCode) console.error("Some checks FAILED.");
