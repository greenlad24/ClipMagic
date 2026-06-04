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
import { pickRandomCaptionTemplate } from "../meme/captionTemplate.js";
import { SUBTITLE_TEMPLATE_POOL, SUBTITLE_TEMPLATES } from "../render/manifest.js";
import { parseGiphyStickers, parseTenorStickers, type StickerCandidate } from "../meme/stickerSearch.js";
import { applyReviewDecision, reviewStickerFit } from "../meme/stickerReview.js";
import { resolveStickerSource, computeSkipReason } from "../meme/pipeline.js";

let passed = 0;
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") {
      pending.push(
        (r as Promise<void>).then(
          () => { passed++; console.log(`  ok  ${name}`); },
          (e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`); process.exitCode = 1; },
        ),
      );
      return;
    }
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

// Build a raw director payload from [start, end, searchQuery] tuples.
function moments(spec: Array<[number, number, string]>): { moments: unknown[] } {
  return { moments: spec.map(([startTime, endTime, searchQuery]) => ({ startTime, endTime, searchQuery })) };
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
check("sanitize drops entries with no/short query or bad time", () => {
  const out = sanitize({ moments: [
    { startTime: 8, endTime: 10 },                        // no query
    { startTime: 8, endTime: 10, searchQuery: "x" },      // query too short (<2)
    { startTime: "nope", endTime: 10, searchQuery: "mind blown" }, // bad start
    { startTime: 8, endTime: 10, searchQuery: "mind blown" },      // good
  ] }, 30);
  assert.equal(out.length, 1);
  assert.equal(out[0].searchQuery, "mind blown");
});

// ── imagePrompt is optional fallback metadata, never gates acceptance ──────────
check("sanitize keeps a moment with only a searchQuery (imagePrompt falls back to it)", () => {
  const out = sanitize({ moments: [
    { startTime: 8, endTime: 10, searchQuery: "money rain" }, // no imagePrompt
  ] }, 30);
  assert.equal(out.length, 1);
  assert.equal(out[0].searchQuery, "money rain");
  // The OpenAI fallback still has a prompt to use — it falls back to the query.
  assert.equal(out[0].imagePrompt, "money rain");
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

// ── Caption chunking matches the short-form editor's "long two" rule ──────────
check("buildCaptionEvents caps long pairs at 2 words (matches short-form rule)", () => {
  // Two long words (>13 letters together) must NOT take a 3rd word, exactly like
  // the short-form chunker (CHARS_2WORD_LIMIT). "incredible powerful" = 18 letters.
  const events = buildCaptionEvents([
    { word: "incredible", start: 0.0, end: 0.4 },
    { word: "powerful", start: 0.4, end: 0.8 },
    { word: "tool", start: 0.8, end: 1.0 },
  ]);
  // First chunk must be the 2 long words only; "tool" spills to the next chunk.
  assert.equal(events[0].words.map((w) => w.text).join(" "), "incredible powerful");
  assert.equal(events[1].words.map((w) => w.text).join(" "), "tool");
});

check("buildCaptionEvents breaks on a clause comma once it has 2+ words", () => {
  const events = buildCaptionEvents([
    { word: "wait", start: 0.0, end: 0.3 },
    { word: "for", start: 0.3, end: 0.5 },  // 2 words + next ends clause...
    { word: "it,", start: 0.5, end: 0.8 },  // clause comma with ≥2 words → break
    { word: "boom", start: 0.9, end: 1.2 },
  ]);
  assert.equal(events[0].words.map((w) => w.text).join(" "), "wait for it,");
  assert.equal(events[1].words.map((w) => w.text).join(" "), "boom");
});

// ── Template selection: random draw from the FULL short-form pool ─────────────
check("pickRandomCaptionTemplate only ever returns a template from the full pool", () => {
  for (let i = 0; i < 200; i++) {
    const t = pickRandomCaptionTemplate();
    assert.ok(SUBTITLE_TEMPLATE_POOL.includes(t), `picked ${t} must be in the pool`);
    assert.ok(SUBTITLE_TEMPLATES[t], `picked ${t} must resolve to a style`);
  }
});

check("pickRandomCaptionTemplate is RANDOM — covers (nearly) the whole pool", () => {
  // Over many draws every (or nearly every) pool entry should appear. This proves
  // it ROTATES across ALL templates, not a single pinned one (the old bug pinned
  // pop-scale). Allow a 1-template slack for RNG variance on small pools.
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(pickRandomCaptionTemplate());
  assert.ok(
    seen.size >= SUBTITLE_TEMPLATE_POOL.length - 1,
    `saw ${seen.size}/${SUBTITLE_TEMPLATE_POOL.length} templates over 1000 draws`,
  );
  // And it is NOT pinned to the old fixed pop-scale.
  assert.ok(seen.size > 1, "must not return a single fixed template");
});

// ── Giphy parsing: result → transparent STATIC still URL ──────────────────────
check("parseGiphyStickers extracts the transparent *_still URL (largest first)", () => {
  // Realistic shape of a /v1/stickers/search hit (trimmed to the relevant keys).
  const json = {
    data: [
      {
        title: "mind blown sticker",
        images: {
          original: { url: "https://media.giphy.com/x/giphy.gif" }, // animated — ignored
          original_still: { url: "https://media.giphy.com/x/giphy_s.gif" }, // transparent still
          fixed_height_still: { url: "https://media.giphy.com/x/200_s.gif" },
        },
      },
      {
        title: "no still here",
        images: { original: { url: "https://media.giphy.com/y/giphy.gif" } }, // no _still → skipped
      },
      {
        title: "shocked",
        images: { preview_still: { url: "https://media.giphy.com/z/preview_s.png" } },
      },
    ],
  };
  const out = parseGiphyStickers(json, 5);
  assert.equal(out.length, 2, "only results with a *_still are kept");
  assert.equal(out[0].provider, "giphy");
  // Prefers original_still over the smaller renditions.
  assert.equal(out[0].url, "https://media.giphy.com/x/giphy_s.gif");
  assert.equal(out[0].title, "mind blown sticker");
  assert.equal(out[1].url, "https://media.giphy.com/z/preview_s.png");
});

check("parseGiphyStickers tolerates a missing/odd payload", () => {
  assert.deepEqual(parseGiphyStickers({}, 3), []);
  assert.deepEqual(parseGiphyStickers({ data: "nope" }, 3), []);
  assert.deepEqual(parseGiphyStickers(null, 3), []);
});

// ── Tenor parsing: result → transparent STATIC format URL ─────────────────────
check("parseTenorStickers extracts a transparent static format (png_transparent first)", () => {
  // Realistic shape of a v2 /search hit restricted to sticker + transparent.
  const json = {
    results: [
      {
        content_description: "money rain",
        media_formats: {
          gif_transparent: { url: "https://media.tenor.com/a/money_t.gif" },
          png_transparent: { url: "https://media.tenor.com/a/money_t.png" },
        },
      },
      {
        title: "celebration",
        media_formats: {
          webp_transparent: { url: "https://media.tenor.com/b/celebrate_t.webp" },
        },
      },
      {
        // No transparent format at all → skipped.
        media_formats: { gif: { url: "https://media.tenor.com/c/opaque.gif" } },
      },
    ],
  };
  const out = parseTenorStickers(json, 5);
  assert.equal(out.length, 2, "only results with a transparent static format are kept");
  assert.equal(out[0].provider, "tenor");
  // png_transparent is preferred over gif_transparent.
  assert.equal(out[0].url, "https://media.tenor.com/a/money_t.png");
  assert.equal(out[0].title, "money rain");
  assert.equal(out[1].url, "https://media.tenor.com/b/celebrate_t.webp");
});

check("parseTenorStickers tolerates a missing/odd payload", () => {
  assert.deepEqual(parseTenorStickers({}, 3), []);
  assert.deepEqual(parseTenorStickers({ results: 5 }, 3), []);
});

check("parse honors the per-provider candidate limit", () => {
  const giphy = { data: Array.from({ length: 6 }, (_, i) => ({ images: { original_still: { url: `g${i}.gif` } } })) };
  const tenor = { results: Array.from({ length: 6 }, (_, i) => ({ media_formats: { png_transparent: { url: `t${i}.png` } } })) };
  assert.equal(parseGiphyStickers(giphy, 3).length, 3);
  assert.equal(parseTenorStickers(tenor, 2).length, 2);
});

// ── AI fit-review: pick / drop / invalid (mocked vision decision) ──────────────
const cands: StickerCandidate[] = [
  { provider: "giphy", url: "g0.png", title: "mind blown" },
  { provider: "tenor", url: "t1.png", title: "confused" },
  { provider: "giphy", url: "g2.png", title: "shocked face" },
];

check("applyReviewDecision PICKS the candidate the reviewer chose", () => {
  const r = applyReviewDecision(JSON.stringify({ chosen: 2, reason: "best matches shock" }), cands);
  assert.equal(r.reviewed, true);
  assert.equal(r.chosenIndex, 2);
  assert.equal(r.chosen?.url, "g2.png");
  assert.equal(r.reason, "best matches shock");
});

check("applyReviewDecision DROPS the sticker when none fit (chosen: null)", () => {
  const r = applyReviewDecision(JSON.stringify({ chosen: null, reason: "all off-topic" }), cands);
  assert.equal(r.reviewed, true);
  assert.equal(r.chosen, null);
  assert.equal(r.chosenIndex, null);
  assert.equal(r.reason, "all off-topic");
});

check("applyReviewDecision DROPS on an out-of-range index (never mis-picks)", () => {
  const r = applyReviewDecision(JSON.stringify({ chosen: 9, reason: "x" }), cands);
  assert.equal(r.chosen, null);
  assert.ok(/invalid index/.test(r.reason));
});

check("applyReviewDecision falls back to top result on unparseable JSON", () => {
  const r = applyReviewDecision("not json at all", cands);
  assert.equal(r.reviewed, false);
  assert.equal(r.chosenIndex, 0);
  assert.equal(r.chosen?.url, "g0.png");
});

check("reviewStickerFit returns nothing for an empty candidate set", async () => {
  const r = await reviewStickerFit("a line", []);
  assert.equal(r.chosen, null);
  assert.equal(r.reviewed, false);
});

// ── Source selection + fallback ordering ──────────────────────────────────────
check("resolveStickerSource defaults to giphy+tenor and honors the override", () => {
  delete process.env.MEME_STICKER_SOURCE;
  assert.equal(resolveStickerSource(), "giphy+tenor");
  process.env.MEME_STICKER_SOURCE = "openai";
  assert.equal(resolveStickerSource(), "openai");
  process.env.MEME_STICKER_SOURCE = "GIPHY+TENOR";
  assert.equal(resolveStickerSource(), "giphy+tenor");
  delete process.env.MEME_STICKER_SOURCE;
});

check("computeSkipReason: applied stickers ⇒ no skip reason", () => {
  assert.equal(
    computeSkipReason({ momentsPlanned: 3, stickersApplied: 2, searchAvailable: true, openaiAvailable: false }),
    null,
  );
});

check("computeSkipReason: no moments ⇒ director reason", () => {
  const r = computeSkipReason({ momentsPlanned: 0, stickersApplied: 0, searchAvailable: true, openaiAvailable: true });
  assert.ok(/no emphasis moments/.test(r!));
});

check("computeSkipReason: no source at all ⇒ asks for keys (giphy+tenor → openai → captions)", () => {
  const r = computeSkipReason({ momentsPlanned: 3, stickersApplied: 0, searchAvailable: false, openaiAvailable: false });
  assert.ok(/GIPHY_API_KEY \/ TENOR_API_KEY/.test(r!), r!);
  assert.ok(/OpenAI/.test(r!), r!);
});

check("computeSkipReason: a source existed but nothing fit ⇒ 'no sticker fit'", () => {
  const r = computeSkipReason({ momentsPlanned: 3, stickersApplied: 0, searchAvailable: true, openaiAvailable: true });
  assert.ok(/no sticker fit/.test(r!), r!);
});

await Promise.all(pending);
console.log(`\n${passed} checks passed.`);
