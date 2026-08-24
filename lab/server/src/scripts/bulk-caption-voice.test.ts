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
} from "../postiz/captionVoice.js";

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

console.log(`\n${passed} checks passed.`);
