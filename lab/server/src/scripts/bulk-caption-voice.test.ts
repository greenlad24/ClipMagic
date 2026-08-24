/**
 * Unit checks for the bar-Jake caption voice (postiz/captionVoice):
 *   - em-dashes become sentences (or commas for short tails), never survive
 *   - copywriter openers and banned words are removed
 *   - the growth CTA is stripped SENTENCE-wise, keeping the closing question
 *   - the CTA match is CASE-SENSITIVE, so the ordinary word survives
 *   - the voice block is assembled from the Script Generator's own reference
 *
 * No network / no AI. Run:
 *   cd lab/server && npx tsx src/scripts/bulk-caption-voice.test.ts
 */
import assert from "node:assert/strict";
import {
  splitEmDashes,
  stripAiTells,
  stripGrowthCta,
  markdownSection,
  ctaSuppressedFileIds,
  type CtaDrop,
} from "../postiz/captionVoice.js";
import { rampRampUpDays, WARM_UP_RAMP } from "../postiz/dropSequencing.js";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

// ── em-dashes ─────────────────────────────────────────────────────────────────
check("an em-dash before a real clause becomes a sentence break", () => {
  const out = stripAiTells("Stop sending 7 options—you're converting at 9% when 38% is possible.");
  assert.ok(!out.includes("—"), out);
  assert.ok(out.includes("options. You're converting"), out);
});

check("an em-dash before a short tail becomes a comma, not a fragment", () => {
  const out = splitEmDashes("It runs on a schedule — handy.");
  assert.ok(!out.includes("—"));
  assert.ok(/,\s*handy\./.test(out), out);
});

check("every em-dash goes, however many there are", () => {
  const out = stripAiTells("One thing—then another thing entirely—and finally a third point here.");
  assert.equal((out.match(/—/g) ?? []).length, 0, out);
});

// ── openers and banned words ──────────────────────────────────────────────────
check("copywriter openers are cut, the sentence survives", () => {
  assert.equal(stripAiTells("Here's why: buyers freeze."), "Buyers freeze.");
  assert.equal(stripAiTells("The reason: too many choices."), "Too many choices.");
  assert.ok(!/let that sink in/i.test(stripAiTells("Big claim. Let that sink in.")));
});

check("banned words from the voice rules are swapped out", () => {
  assert.ok(!/caveat/i.test(stripAiTells("One caveat before you start.")));
  assert.ok(!/genuinely/i.test(stripAiTells("This is genuinely useful.")));
  assert.equal(stripAiTells("I tested whether it works."), "I tested if it works.");
});

check("stripping never leaves doubled spaces or stray punctuation", () => {
  const out = stripAiTells("Here's why:  the thing is genuinely  good — really good.");
  assert.ok(!/\s{2,}/.test(out), out);
  assert.ok(!/\s+[.,!?]/.test(out), out);
});

// ── the growth CTA ────────────────────────────────────────────────────────────
const CTA = "Comment PROMPTS and I'll send you the templates.";

check("the CTA sentence goes, the closing question stays", () => {
  const caption = `A real hook here.\n\nSome value in the middle.\n\n${CTA}\n\nWhat would you try first?`;
  const out = stripGrowthCta(caption, "PROMPTS");
  assert.ok(!out.includes("PROMPTS"), out);
  assert.ok(out.endsWith("What would you try first?"), out);
  assert.ok(out.includes("Some value in the middle."), out);
});

check("a CTA sharing a paragraph with the question loses only itself", () => {
  // This is the shape that emptied whole paragraphs before the fix.
  const caption = `The hook.\n\n${CTA} What would you try first?`;
  const out = stripGrowthCta(caption, "PROMPTS");
  assert.ok(!out.includes("PROMPTS"), out);
  assert.ok(out.endsWith("What would you try first?"), out);
});

check("the CTA match is CASE-SENSITIVE — the ordinary word survives", () => {
  // "prompts" the English word must not be mistaken for the CTA keyword; doing
  // so stripped the closing question from 9 of 908 real captions.
  const caption = `The hook.\n\n${CTA}\n\nAre you staying focused on prompts or moving to systems?`;
  const out = stripGrowthCta(caption, "PROMPTS");
  assert.ok(!out.includes("PROMPTS"), out);
  assert.ok(out.endsWith("focused on prompts or moving to systems?"), out);
});

check("a paragraph that was ONLY the CTA is dropped, not left blank", () => {
  const out = stripGrowthCta(`Hook.\n\n${CTA}\n\nQuestion?`, "PROMPTS");
  assert.ok(!/\n{3,}/.test(out), "blank paragraph left behind");
  assert.equal(out, "Hook.\n\nQuestion?");
});

check("a caption with no CTA is returned untouched", () => {
  const caption = "Hook.\n\nValue.\n\nWhat do you think?";
  assert.equal(stripGrowthCta(caption, "PROMPTS"), caption);
});

// ── the voice block ───────────────────────────────────────────────────────────
check("markdownSection pulls one ## section and stops at the next", () => {
  const doc = "# Title\n\n## One\nalpha\n\n## Two\nbeta\n";
  assert.ok(markdownSection(doc, /One/).includes("alpha"));
  assert.ok(!markdownSection(doc, /One/).includes("beta"));
  assert.equal(markdownSection(doc, /Nope/), "", "a missing section degrades to empty");
});

// ── how often the campaign asks ───────────────────────────────────────────────
/** N drops, one per day from `from`. */
function drops(n: number, from = 0): CtaDrop[] {
  return Array.from({ length: n }, (_, i) => ({ fileId: `f${i}`, dayOffset: from + i, slot: 0 }));
}

check("the warm-up ramp-up is 8 weeks, and the quiet period tracks it", () => {
  assert.equal(rampRampUpDays(WARM_UP_RAMP), 56, "4 weeks at 3/week + 4 weeks at 1/day");
  // Retuning the ramp moves the quiet period rather than desyncing from it.
  assert.equal(rampRampUpDays([{ weeks: 2, perWeek: 3 }, { perDay: 1 }]), 14);
  assert.equal(rampRampUpDays([{ perDay: 2 }]), 0, "a single-phase ramp never ramps up");
});

check("nothing asks during the quiet period", () => {
  const d = drops(56);
  const off = ctaSuppressedFileIds(d, { quietUntilDayOffset: 56 });
  assert.equal(off.size, 56, "every drop inside the quiet window is stripped");
});

check("after the quiet period, exactly one drop in three asks", () => {
  const d = drops(9, 56);
  const off = ctaSuppressedFileIds(d, { quietUntilDayOffset: 56, everyNth: 3 });
  const asks = d.filter((x) => !off.has(x.fileId)).map((x) => x.fileId);
  assert.deepEqual(asks, ["f2", "f5", "f8"], "the 3rd, 6th and 9th ask");
});

check("counting restarts after the quiet period, not at day 0", () => {
  // 5 quiet drops then 3 live ones: the FIRST ask must be the 3rd live drop,
  // not whatever the global index happens to land on.
  const d = [...drops(5, 0), ...drops(3, 56).map((x, i) => ({ ...x, fileId: `live${i}` }))];
  const off = ctaSuppressedFileIds(d, { quietUntilDayOffset: 56, everyNth: 3 });
  assert.ok(off.has("live0") && off.has("live1"), "the first two live drops stay quiet");
  assert.ok(!off.has("live2"), "the third live drop asks");
});

check("the choice follows schedule order, not input order", () => {
  const shuffled: CtaDrop[] = [
    { fileId: "c", dayOffset: 58, slot: 0 },
    { fileId: "a", dayOffset: 56, slot: 0 },
    { fileId: "b", dayOffset: 57, slot: 0 },
  ];
  const off = ctaSuppressedFileIds(shuffled, { quietUntilDayOffset: 56, everyNth: 3 });
  assert.deepEqual([...off].sort(), ["a", "b"], "the chronologically third one asks");
});

check("two drops on one day are ordered by slot", () => {
  const d: CtaDrop[] = [
    { fileId: "second", dayOffset: 56, slot: 1 },
    { fileId: "first", dayOffset: 56, slot: 0 },
    { fileId: "third", dayOffset: 57, slot: 0 },
  ];
  const off = ctaSuppressedFileIds(d, { quietUntilDayOffset: 56, everyNth: 3 });
  assert.ok(!off.has("third"), "slot ordering puts 'third' in the 3rd position");
});

check("everyNth of 1 means every drop asks (after the quiet period)", () => {
  const d = drops(4, 56);
  assert.equal(ctaSuppressedFileIds(d, { quietUntilDayOffset: 56, everyNth: 1 }).size, 0);
});

check("a zero-length quiet period still applies the 1-in-3 rule", () => {
  const d = drops(6, 0);
  const off = ctaSuppressedFileIds(d, { quietUntilDayOffset: 0, everyNth: 3 });
  assert.equal(off.size, 4, "4 of 6 stay quiet");
});

console.log(`\n${passed} checks passed.`);
