/**
 * Unit checks for the Meme/Sticker editor's pure logic. Run with:
 *   cd lab/server && npx tsx src/scripts/meme.test.ts
 *
 * No API keys, no ffmpeg, no Chromium — these assert the parts that MUST be
 * correct regardless of whether the live providers are present:
 *   • the emphasis director's sanitize() enforces ~4s density, spacing, hold
 *     length, and head/tail buffers (restraint is guaranteed in code);
 *   • the sticker box lands BELOW the caption zone within safe margins;
 *   • the caption chunker produces viral 2–3 word events from word timings.
 */
import assert from "node:assert/strict";
import { sanitize, maxMomentsFor, type EmphasisMoment } from "../meme/director.js";
import {
  stickerBox,
  assertBelowCaptions,
  CANVAS,
  SAFE_BOTTOM,
  CAPTION_ZONE_BOTTOM_FRACTION,
  STICKER_TOP_FRACTION,
} from "../meme/sticker.js";
import { buildCaptionEvents } from "../meme/captions.js";

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

// Build a raw director payload from [start, end, prompt] tuples.
function moments(spec: Array<[number, number, string]>): { moments: unknown[] } {
  return { moments: spec.map(([startTime, endTime, imagePrompt]) => ({ startTime, endTime, imagePrompt })) };
}

// ── Density target: ~1 sticker per 4s ─────────────────────────────────────────
check("maxMomentsFor targets ~one sticker every 4s", () => {
  assert.equal(maxMomentsFor(40), 10);
  assert.equal(maxMomentsFor(60), 15);
  assert.equal(maxMomentsFor(4), 1); // floor of 1
});

// ── Spacing: drop anything tighter than ~3s between starts ─────────────────────
check("sanitize spaces stickers ~4s apart (drops a too-close one)", () => {
  // Three candidates at 6, 7.5, 11s on a 30s video. 7.5 is <3s after 6 → dropped.
  const out = sanitize(moments([
    [6.0, 8.0, "a cartoon brain"],
    [7.5, 9.5, "a cat"],   // too close to the first start → dropped
    [11.0, 13.0, "a rocket"],
  ]), 30);
  const starts = out.map((m) => m.startTime);
  assert.deepEqual(starts, [6.0, 11.0]);
});

// ── Average density over a long script stays ≲ 1 / 4s ──────────────────────────
check("sanitize keeps average density at or below ~1 per 4s", () => {
  // Twelve evenly-spaced 2s candidates every 2.5s on a 60s video. Spacing rule
  // (≥3s between starts) + the per-duration cap must thin them out.
  const spec: Array<[number, number, string]> = [];
  for (let i = 0; i < 12; i++) spec.push([4 + i * 2.5, 6 + i * 2.5, `img ${i}`]);
  const out = sanitize(moments(spec), 60);
  // No two stickers within 3s of each other.
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].startTime - out[i - 1].startTime >= 3.0, `gap @${i}`);
  }
  // Density: at most one per 4s on average (cap = maxMomentsFor).
  assert.ok(out.length <= maxMomentsFor(60), `count ${out.length} <= ${maxMomentsFor(60)}`);
});

// ── Head/tail buffers: nothing in the hook or the CTA tail ─────────────────────
check("sanitize keeps the hook (<1.5s) and CTA tail clear", () => {
  const out = sanitize(moments([
    [0.2, 2.2, "too early — hook"],    // start < HEAD(1.5) → clamped to 1.5
    [28.6, 30.6, "too late — CTA"],    // end would cross duration-TAIL → dropped
  ]), 30);
  // The early one is clamped into the safe window (start >= 1.5), the late one dropped.
  assert.equal(out.length, 1);
  assert.ok(out[0].startTime >= 1.5);
  assert.ok(out[0].endTime <= 30 - 1.5);
});

// ── Hold length clamp: 1.5–2.5s ────────────────────────────────────────────────
check("sanitize clamps each hold to 1.5–2.5s", () => {
  const out = sanitize(moments([
    [5, 5.3, "too short"],   // 0.3s → bumped to 1.5s
    [12, 20, "too long"],    // 8s → clamped to 2.5s
  ]), 40);
  for (const m of out) {
    const hold = m.endTime - m.startTime;
    assert.ok(hold >= 1.5 - 1e-6 && hold <= 2.5 + 1e-6, `hold ${hold}`);
  }
});

// ── Bad input is dropped, not crashed ──────────────────────────────────────────
check("sanitize drops entries with no/short prompt or bad time", () => {
  const out = sanitize({ moments: [
    { startTime: 8, endTime: 10 },                       // no prompt
    { startTime: 8, endTime: 10, imagePrompt: "x" },     // prompt too short
    { startTime: "nope", endTime: 10, imagePrompt: "a happy dog" }, // bad start
    { startTime: 8, endTime: 10, imagePrompt: "a happy dog" },      // good
  ] }, 30);
  assert.equal(out.length, 1);
  assert.equal(out[0].imagePrompt, "a happy dog");
});

// ── Placement: the sticker sits BELOW the captions, inside safe margins ────────
check("sticker box is strictly below the caption zone", () => {
  const box = stickerBox();
  assertBelowCaptions(box); // throws if it overlaps captions or the safe margin
  const captionBottom = Math.round(CANVAS.height * CAPTION_ZONE_BOTTOM_FRACTION);
  assert.ok(box.top >= captionBottom, `top ${box.top} >= captionBottom ${captionBottom}`);
});

check("sticker box stays above the bottom platform safe margin", () => {
  const box = stickerBox();
  assert.ok(box.bottom <= CANVAS.height - SAFE_BOTTOM, "bottom within safe area");
  assert.ok(box.size > 0, "positive size");
});

check("composition STICKER_TOP_FRACTION matches the server geometry", () => {
  // The Remotion composition and the server must agree on the box top, else the
  // computed Y assertion here would not reflect what actually renders.
  assert.equal(STICKER_TOP_FRACTION, 0.6);
});

// ── Caption chunker: viral 2–3 word events with pause/punctuation breaks ───────
check("buildCaptionEvents makes ≤3-word chunks and breaks on pauses/punctuation", () => {
  const events = buildCaptionEvents([
    { word: "this", start: 0.0, end: 0.3 },
    { word: "is", start: 0.3, end: 0.5 },
    { word: "wild.", start: 0.5, end: 0.9 },  // punctuation → ends a chunk
    { word: "watch", start: 2.0, end: 2.3 },  // 1.1s pause → new chunk before this
    { word: "this", start: 2.3, end: 2.6 },
  ]);
  // First chunk: this / is / wild. (3 words, ended by punctuation)
  assert.equal(events[0].words.map((w) => w.text).join(" "), "this is wild.");
  // The pause forces a new event for "watch …".
  assert.ok(events.length >= 2, "pause split");
  for (const e of events) assert.ok(e.words.length <= 3, "max 3 words/chunk");
  // Event start/end track the contained words.
  assert.equal(events[0].start, 0.0);
  assert.equal(events[0].end, 0.9);
});

console.log(`\n${passed} checks passed.`);
