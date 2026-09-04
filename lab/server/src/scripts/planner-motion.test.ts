/**
 * Unit checks for the Video Planner's motion-graphics stage. Run with:
 *   cd lab/server && npx tsx src/scripts/planner-motion.test.ts
 *
 * Pure/deterministic — no API keys, no ffmpeg, no network. Everything checked
 * here decides what gets SENT to a paid generation API twenty times per plan:
 * which lines are eligible, what words end up on the card, which slot the style
 * is judged on, and what the prompts actually say. A silent regression in any
 * of those is a regression Jake pays for one card at a time.
 */
import {
  MOTION_NEGATIVE,
  SAMPLE_COUNT,
  STYLE_BASE,
  cardText,
  graphicSlots,
  motionDir,
  motionDuration,
  motionPrompt,
  pickSampleSlot,
  stillPrompt,
} from "../planner/motion.js";
import type { GraphicSlot, PlanLine } from "../planner/types.js";
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

const line = (kind: string, start: number, end: number, instruction: string): PlanLine =>
  ({ start, end, kind, instruction } as PlanLine);

const slot = (index: number, text: string, durationSec = 3): GraphicSlot =>
  ({ index, start: index * 10, end: index * 10 + durationSec, kind: "text_gradient", text, durationSec });

// ── which lines can be generated ────────────────────────────────────────────

check("only the two text kinds are generatable", () => {
  const lines = [
    line("screencast", 0, 12, "Screencast: the settings page"),
    line("text_gradient", 12, 15, 'Text (gradient): "Where do I look?"'),
    line("talking_head", 15, 20, "Talking head"),
    line("stock_footage", 20, 24, "Stock: a busy street"),
    line("text_whiteboard", 24, 27, 'Text (whiteboard): "Three rules"'),
    line("unknown", 27, 30, "???"),
  ];
  const slots = graphicSlots(lines);
  assert.deepEqual(slots.map((s) => s.kind), ["text_gradient", "text_whiteboard"]);
  // Higgsfield's output is opaque: anything holding real footage must be left alone.
  assert.ok(!slots.some((s) => ["screencast", "talking_head", "stock_footage"].includes(s.kind)));
});

check("a slot keeps the plan's own line index, so a card can be put back in place", () => {
  const slots = graphicSlots([
    line("screencast", 0, 12, "Screencast: the dashboard"),
    line("screencast", 12, 20, "Screencast: the editor"),
    line("text_gradient", 20, 23, 'Text (gradient): "The turn"'),
  ]);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].index, 2, "the index addresses the plan, not the slot list");
});

check("a slot's duration comes from the plan's own timestamps", () => {
  const [s] = graphicSlots([line("text_gradient", 61.5, 64.25, 'Text (gradient): "Hold on"')]);
  assert.equal(s.durationSec, 2.75);
  assert.equal(s.start, 61.5);
  assert.equal(s.end, 64.25);
});

// ── the words that go on the card ───────────────────────────────────────────

check("the card's copy is the quoted part of the instruction", () => {
  assert.equal(cardText('Text (gradient): "Where do I look?"'), "Where do I look?");
  assert.equal(cardText('Text (whiteboard): "Three rules, one page"'), "Three rules, one page");
});

check("curly quotes are read the same as straight ones", () => {
  assert.equal(cardText("Text (gradient): “Teach it once”"), "Teach it once");
});

check("an unquoted instruction still yields words, never an empty card", () => {
  // A card generated with no words on it is worse than a card with the wrong
  // font — it is unusable, and it was still paid for.
  assert.equal(cardText("Text (gradient): Where do I look?"), "Where do I look?");
  assert.ok(cardText("Text (gradient)").length > 0);
  assert.ok(cardText("no colon and no quotes here").length > 0);
});

check("a headline containing a colon survives intact", () => {
  assert.equal(cardText('Text (gradient): "One rule: never cut content"'), "One rule: never cut content");
  // Unquoted, the split must not eat everything after the second colon either.
  assert.equal(cardText("Text (gradient): One rule: never cut content"), "One rule: never cut content");
});

// ── which slot the style is judged on ──────────────────────────────────────

check("the style is sampled on the longest headline in the plan", () => {
  // The reference has to be judged on the roomiest card, or a headline that
  // only just fits gets approved and starts cropping on card nineteen.
  const chosen = pickSampleSlot([slot(0, "Short"), slot(1, "A considerably longer headline"), slot(2, "Middling")]);
  assert.equal(chosen?.index, 1);
});

check("ties pick the earlier slot, so the choice is stable across calls", () => {
  const chosen = pickSampleSlot([slot(3, "Same length!!"), slot(7, "Same length!!")]);
  assert.equal(chosen?.index, 3);
});

check("a plan with no cards samples nothing rather than throwing", () => {
  assert.equal(pickSampleSlot([]), null);
});

check("the sample round is small enough to be a decision, not a run", () => {
  assert.ok(SAMPLE_COUNT >= 2, "one still is not a choice");
  assert.ok(SAMPLE_COUNT <= 4, "the sample round must cost far less than the full set");
});

// ── the prompts ─────────────────────────────────────────────────────────────

check("the still prompt states the exact headline and forbids any other text", () => {
  const p = stillPrompt("Where do I look?");
  assert.ok(p.includes('"Where do I look?"'), "the copy must be quoted verbatim");
  assert.match(p, /exactly/i);
  assert.match(p, /no additional text/i);
  assert.ok(p.includes(STYLE_BASE), "every card carries the same style base");
});

check("style notes are carried into the still prompt when given", () => {
  const p = stillPrompt("The turn", "Acid yellow #D1EF17 accents only on the accent word.");
  assert.ok(p.includes("#D1EF17"));
  const bare = stillPrompt("The turn", "   ");
  assert.ok(!bare.includes("  ,"), "blank notes must not leave a hole in the prompt");
});

check("16:9 is stated in the style base — the explainer presets are all vertical", () => {
  assert.ok(STYLE_BASE.includes("16:9"), "a long-form card is never 9:16");
});

check("the motion prompt protects the lettering, which is why there are two calls", () => {
  const p = motionPrompt();
  assert.match(p, /text stays perfectly still/i);
  assert.match(p, /only the background moves/i);
  assert.match(p, /no cuts/i);
  // The negative prompt has to name the failure the whole pipeline exists to
  // avoid: a video model rewriting the words.
  assert.match(MOTION_NEGATIVE, /text changing/i);
  assert.match(MOTION_NEGATIVE, /misspelled/i);
});

// ── fitting a generation to a slot ──────────────────────────────────────────

check("Kling's two lengths are chosen by which one covers the slot", () => {
  // It renders 5s or 10s and nothing between, and measured slots are mostly 2–4s.
  assert.equal(motionDuration(2.5), 5);
  assert.equal(motionDuration(5), 5);
  assert.equal(motionDuration(5.01), 10);
  assert.equal(motionDuration(14.8), 10);
});

check("every choice is one Kling actually offers", () => {
  for (const s of [0.5, 3, 5, 7, 10, 42]) {
    assert.ok([5, 10].includes(motionDuration(s)), `${s}s asked for an unsupported duration`);
  }
});

check("a run's assets stay inside that run's own directory", () => {
  const dir = motionDir("abc123XYZ");
  assert.ok(dir.endsWith("/abc123XYZ/motion"), dir);
  assert.notEqual(motionDir("a".repeat(8)), motionDir("b".repeat(8)));
});

console.log(`\n${passed} checks passed.`);
if (process.exitCode) console.error("Some checks FAILED.");
