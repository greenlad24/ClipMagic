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
  placeSticker,
  assertFits,
  defaultStickerSize,
  CANVAS,
  SAFE_LEFT,
  SAFE_RIGHT,
  SAFE_TOP,
  SAFE_BOTTOM,
  CAPTION_ZONE_TOP_FRACTION,
  CAPTION_ZONE_BOTTOM_FRACTION,
  STICKER_TOP_FRACTION,
  type StickerBox,
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

// ── Flexible placement: ANY fitting zone, never over the captions ──────────────
const CAP_TOP = Math.round(CANVAS.height * CAPTION_ZONE_TOP_FRACTION);
const CAP_BOTTOM = Math.round(CANVAS.height * CAPTION_ZONE_BOTTOM_FRACTION);

/** A box overlaps the caption band iff it intersects [CAP_TOP, CAP_BOTTOM]. */
function overlapsCaptions(box: StickerBox): boolean {
  return box.top < CAP_BOTTOM && box.top + box.size > CAP_TOP;
}
/** A box is inside the safe area iff every edge clears the safe margins. */
function insideSafe(box: StickerBox): boolean {
  return (
    box.left >= SAFE_LEFT &&
    box.left + box.size <= CANVAS.width - SAFE_RIGHT &&
    box.top >= SAFE_TOP &&
    box.top + box.size <= CANVAS.height - SAFE_BOTTOM
  );
}

check("placeSticker: every placement fits the safe area AND clears the captions", () => {
  // Across many sticker indices the picker must ALWAYS return a box that fits and
  // never overlaps the caption band (the relaxed product rule). assertFits throws
  // on any violation; we also independently re-check both invariants.
  for (let i = 0; i < 50; i++) {
    const box = placeSticker(i);
    assertFits(box); // throws on off-frame / safe-margin / caption overlap
    assert.ok(insideSafe(box), `box @${i} inside safe area`);
    assert.ok(!overlapsCaptions(box), `box @${i} clears the caption band`);
    assert.ok(box.size > 0, `box @${i} positive size`);
  }
});

check("placeSticker VARIES placement across stickers (uses multiple zones)", () => {
  // Different indices should land in different zones so stickers scatter around
  // the frame rather than stacking in one slot.
  const zones = new Set<string>();
  for (let i = 0; i < 10; i++) zones.add(placeSticker(i).zone ?? "?");
  assert.ok(zones.size >= 3, `expected ≥3 distinct zones, saw ${[...zones].join(", ")}`);
});

check("placeSticker exercises every named zone over the rotation", () => {
  // The full rotation (below-captions, top-center, upper-left, upper-right,
  // center-upper) must all be reachable at the default size.
  const zones = new Set<string>();
  for (let i = 0; i < 25; i++) zones.add(placeSticker(i).zone ?? "?");
  for (const z of ["below-captions", "top-center", "upper-left", "upper-right", "center-upper"]) {
    assert.ok(zones.has(z), `zone "${z}" must be reachable (saw ${[...zones].join(", ")})`);
  }
});

check("assertFits REJECTS a box that overlaps the caption band", () => {
  // A box straddling screen center sits squarely in the reserved caption band.
  const bad: StickerBox = { left: 270, top: CAP_TOP - 10, size: 540, bottom: CAP_TOP - 10 + 540, zone: "bad" };
  assert.throws(() => assertFits(bad), /overlaps the caption zone/);
});

check("assertFits REJECTS a box that runs off the safe area", () => {
  const offRight: StickerBox = { left: CANVAS.width - 100, top: SAFE_TOP, size: 300, bottom: SAFE_TOP + 300, zone: "bad" };
  assert.throws(() => assertFits(offRight), /right safe margin/);
  const offTop: StickerBox = { left: 300, top: 10, size: 300, bottom: 310, zone: "bad" };
  assert.throws(() => assertFits(offTop), /top safe margin/);
});

check("placeSticker shrinks an oversized request until it fits a zone", () => {
  // An absurdly large size can't fit any zone at full size; the picker must shrink
  // it (and still return a valid, caption-clearing box).
  const box = placeSticker(0, CANVAS.height /* way too big */);
  assertFits(box);
  assert.ok(box.size < CANVAS.height, "oversized request was shrunk");
});

check("stickerBox (back-compat default) still lands below the captions, in safe", () => {
  const box = stickerBox();
  assertFits(box);
  assert.ok(box.top >= CAP_BOTTOM, `top ${box.top} >= captionBottom ${CAP_BOTTOM}`);
  assert.ok(box.size > 0 && defaultStickerSize() > 0, "positive sizes");
});

check("composition STICKER_TOP_FRACTION matches the server geometry", () => {
  // The Remotion composition and the server must agree on the fallback box top.
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

// ── Subtitle PARITY with the short-form editor ────────────────────────────────
// A faithful REPLICA of src/api/runPipeline.ts's caption builder (its inline
// "Hormozi-style" loop + per-word { text, start, end, emphasis } shape). The meme
// builder must produce structurally IDENTICAL SubtitleEvents for the same words
// and the same director-chosen emphasis set, so the two render identically. If
// runPipeline's rules change, this replica documents what parity means.
type RefWord = { word: string; start: number; end: number };
function shortFormReference(words: RefWord[], emphasisIndices = new Set<number>()) {
  const phraseGroups: RefWord[][] = [];
  let currentGroup: RefWord[] = [];
  const CHARS_2WORD_LIMIT = 13;
  const wlen = (g: Array<{ word: string }>) =>
    g.reduce((n, w) => n + w.word.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
  for (let i = 0; i < words.length; i++) {
    currentGroup.push(words[i]);
    const nextW = words[i + 1];
    const gap = nextW ? nextW.start - words[i].end : Infinity;
    const endsSentence = /[.!?…]$/.test(words[i].word.trim());
    const endsClause = /[,;:]$/.test(words[i].word.trim());
    const curChars = wlen(currentGroup);
    const nextChars = nextW ? nextW.word.replace(/[^\p{L}\p{N}]/gu, "").length : 0;
    const longTwo = currentGroup.length >= 2 && (curChars > CHARS_2WORD_LIMIT || curChars + nextChars > 16);
    if (
      currentGroup.length >= 3 ||
      longTwo ||
      gap > 0.35 ||
      endsSentence ||
      (endsClause && currentGroup.length >= 2)
    ) {
      phraseGroups.push([...currentGroup]);
      currentGroup = [];
    }
  }
  if (currentGroup.length > 0) phraseGroups.push(currentGroup);

  const events: any[] = [];
  let gi = 0;
  for (const group of phraseGroups) {
    const swArr = group.map((w) => ({
      text: w.word, start: w.start, end: w.end, emphasis: emphasisIndices.has(gi++),
    }));
    events.push({ start: swArr[0].start, end: swArr[swArr.length - 1].end, words: swArr });
  }
  return events;
}

check("meme captions are STRUCTURALLY identical to the short-form builder (same words → same word-level karaoke events)", () => {
  const words: RefWord[] = [
    { word: "This", start: 0.0, end: 0.30 },
    { word: "tool", start: 0.30, end: 0.55 },
    { word: "is", start: 0.55, end: 0.70 },
    { word: "absolutely", start: 0.70, end: 1.20 },
    { word: "incredible,", start: 1.20, end: 1.90 },
    { word: "watch", start: 2.40, end: 2.70 }, // pause → new chunk
    { word: "what", start: 2.70, end: 2.90 },
    { word: "happens", start: 2.90, end: 3.40 },
    { word: "next.", start: 3.40, end: 3.90 },
  ];
  const meme = buildCaptionEvents(words);
  const ref = shortFormReference(words);
  // The per-word karaoke structure (text + timings + emphasis) and the event
  // boundaries must match the short-form editor exactly.
  assert.deepEqual(meme, ref, "meme events must equal the short-form builder's events");
  // Spot-check the word-level structure the karaoke highlight reads (per-word
  // start/end present and ordered within each event).
  for (const ev of meme) {
    assert.ok(ev.words.length >= 1 && ev.words.length <= 3);
    for (const w of ev.words) {
      assert.equal(typeof w.start, "number");
      assert.equal(typeof w.end, "number");
      assert.equal(typeof w.emphasis, "boolean");
    }
  }
});

check("meme captions honor a director emphasis set the SAME way as the short-form editor", () => {
  const words: RefWord[] = [
    { word: "Ten", start: 0.0, end: 0.2 },
    { word: "times", start: 0.2, end: 0.5 },
    { word: "faster.", start: 0.5, end: 1.0 },
    { word: "No", start: 1.4, end: 1.6 },
    { word: "joke.", start: 1.6, end: 2.0 },
  ];
  const emphasis = new Set([0, 2]); // "Ten" and "faster."
  const meme = buildCaptionEvents(words, emphasis);
  const ref = shortFormReference(words, emphasis);
  assert.deepEqual(meme, ref, "emphasis marking must match the short-form builder");
  // The exact words flagged emphasis are the director's chosen indices.
  const flat = meme.flatMap((e) => e.words);
  assert.equal(flat[0].emphasis, true, "index 0 emphasized");
  assert.equal(flat[1].emphasis, false);
  assert.equal(flat[2].emphasis, true, "index 2 emphasized");
});

check("meme captions do NOT force uppercase — casing follows template.allCaps at render time", () => {
  // The builder must preserve the transcript's original casing; ALL-CAPS is a
  // render-time decision per the chosen template's `allCaps` (applied in ass.ts),
  // NOT baked into the event text — so a mixed-case template stays mixed-case and
  // an all-caps template uppercases the SAME events.
  const words: RefWord[] = [
    { word: "iPhone", start: 0.0, end: 0.4 },
    { word: "Pro", start: 0.4, end: 0.7 },
    { word: "Max.", start: 0.7, end: 1.0 },
  ];
  const meme = buildCaptionEvents(words);
  const rendered = meme.flatMap((e) => e.words).map((w) => w.text);
  assert.deepEqual(rendered, ["iPhone", "Pro", "Max."], "original casing preserved (not forced caps)");
  // Sanity: the all-caps templates exist in the pool, and applying their allCaps
  // rule (as ass.ts does) uppercases the SAME preserved text.
  for (const t of ["black-on-yellow", "pop-scale"] as const) {
    assert.equal(SUBTITLE_TEMPLATES[t].allCaps, true, `${t} is an all-caps template`);
  }
  const mixed = SUBTITLE_TEMPLATES["yellow-mont"];
  assert.equal(mixed.allCaps, false, "yellow-mont keeps original casing");
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

// ── Sticker SOURCING ORCHESTRATION: free-first, capped OpenAI fallback ─────────
// These exercise the injectable orchestrator with MOCK providers (no network):
// Giphy/Tenor + review is tried FIRST for every moment; OpenAI fills ONLY the
// unmatched moments, hard-capped at MEME_OPENAI_MAX/video, prioritized
// deterministically; the no-OpenAI-key path skips gen with a clear reason.
import { orchestrateStickers, resolveOpenAiMax, type StickerProviders } from "../meme/orchestrate.js";
import type { FitReviewResult } from "../meme/stickerReview.js";

function moment(startTime: number, query: string, phrase?: string): EmphasisMoment {
  return { startTime, endTime: startTime + 2, searchQuery: query, imagePrompt: `gen:${query}`, phrase };
}
function cand(provider: "giphy" | "tenor", url: string): StickerCandidate {
  return { provider, url, title: url };
}
/** A spy-able provider set with sensible defaults; override per test. */
function makeProviders(over: Partial<StickerProviders> & {
  searchResults?: Record<string, StickerCandidate[]>;
  reviewPicks?: (line: string, c: StickerCandidate[]) => FitReviewResult;
  genUrls?: string[];
}): StickerProviders & { calls: { search: string[]; review: string[]; download: string[]; generate: string[] } } {
  const calls = { search: [] as string[], review: [] as string[], download: [] as string[], generate: [] as string[] };
  const searchResults = over.searchResults ?? {};
  const genUrls = over.genUrls ?? [];
  let genIdx = 0;
  return {
    searchAvailable: over.searchAvailable ?? true,
    openaiAvailable: over.openaiAvailable ?? true,
    source: over.source ?? "giphy+tenor",
    async search(q) { calls.search.push(q); return searchResults[q] ?? []; },
    async review(line, c) {
      calls.review.push(line);
      if (over.reviewPicks) return over.reviewPicks(line, c);
      return { chosen: c[0] ?? null, chosenIndex: c.length ? 0 : null, reason: "top", reviewed: true };
    },
    async download(c) { calls.download.push(c.url); return { url: `/dl/${c.url}` }; },
    async generate() { calls.generate.push("gen"); const u = genUrls[genIdx++]; return u ? { url: u } : null; },
    onMomentProgress: over.onMomentProgress,
    calls,
  };
}

check("resolveOpenAiMax defaults to a hard cap of 6 and honors the env override", () => {
  delete process.env.MEME_OPENAI_MAX;
  // Default: a fixed ceiling of 6 OpenAI generations per video, regardless of
  // how many moments the director picked.
  assert.equal(resolveOpenAiMax(0), 6, "default cap is 6 even with no moments");
  assert.equal(resolveOpenAiMax(3), 6, "default cap is 6, not per-moment");
  assert.equal(resolveOpenAiMax(99), 6, "default cap stays 6 for many moments");
  // Explicit env override wins regardless of moment count.
  process.env.MEME_OPENAI_MAX = "0";
  assert.equal(resolveOpenAiMax(5), 0);
  process.env.MEME_OPENAI_MAX = "3";
  assert.equal(resolveOpenAiMax(2), 3);
  process.env.MEME_OPENAI_MAX = "nonsense";
  assert.equal(resolveOpenAiMax(4), 6, "invalid env → default cap of 6");
  delete process.env.MEME_OPENAI_MAX;
});

check("orchestrate tries Giphy/Tenor + review FIRST for every moment (no gen when all matched)", async () => {
  delete process.env.MEME_OPENAI_MAX;
  const moments = [moment(6, "shocked"), moment(12, "money rain")];
  const p = makeProviders({
    searchResults: {
      shocked: [cand("giphy", "g_shock.png")],
      "money rain": [cand("tenor", "t_money.png")],
    },
  });
  const res = await orchestrateStickers(moments, p);
  // The free path ran for BOTH moments before any generation.
  assert.deepEqual(p.calls.search, ["shocked", "money rain"], "searched both, in order");
  assert.equal(p.calls.review.length, 2, "reviewed both");
  assert.equal(p.calls.generate.length, 0, "no OpenAI gen when the free path matched all");
  assert.equal(res.openaiUsed, 0);
  assert.equal(res.stickers.length, 2);
  assert.equal(res.diagnostics[0].appliedSource, "giphy+tenor");
  assert.equal(res.diagnostics[1].appliedSource, "giphy+tenor");
  // Per-moment diagnostics carry candidate counts + verdict.
  assert.equal(res.diagnostics[0].candidates.giphy, 1);
  assert.equal(res.diagnostics[1].candidates.tenor, 1);
});

check("orchestrate uses OpenAI ONLY for moments the free path left unmatched", async () => {
  delete process.env.MEME_OPENAI_MAX; // cap = 2
  const moments = [moment(6, "matched"), moment(12, "unmatched")];
  const p = makeProviders({
    searchResults: { matched: [cand("giphy", "g.png")] /* "unmatched" → [] */ },
    genUrls: ["/gen/u.png"],
  });
  const res = await orchestrateStickers(moments, p);
  assert.equal(p.calls.generate.length, 1, "generated once — only for the unmatched moment");
  assert.equal(res.diagnostics[0].appliedSource, "giphy+tenor");
  assert.equal(res.diagnostics[1].appliedSource, "openai");
  assert.equal(res.openaiUsed, 1);
  assert.equal(res.stickers.length, 2);
});

check("orchestrate NEVER exceeds an explicit OpenAI cap (prioritizing earliest moments)", async () => {
  process.env.MEME_OPENAI_MAX = "2"; // pin the cap at 2 to exercise cap enforcement
  // Four unmatched moments; the cap is 2, so only the two EARLIEST get generated.
  const moments = [moment(6, "a"), moment(10, "b"), moment(14, "c"), moment(18, "d")];
  const p = makeProviders({ searchResults: {}, genUrls: ["/g/a.png", "/g/b.png", "/g/c.png", "/g/d.png"] });
  const res = await orchestrateStickers(moments, p);
  assert.equal(res.openaiCap, 2);
  assert.equal(res.openaiUsed, 2, "never exceeds the cap");
  assert.equal(p.calls.generate.length, 2, "exactly two gen calls");
  // Deterministic prioritization: the two EARLIEST moments (6s, 10s) are generated.
  assert.equal(res.diagnostics[0].appliedSource, "openai", "@6s generated");
  assert.equal(res.diagnostics[1].appliedSource, "openai", "@10s generated");
  assert.equal(res.diagnostics[2].appliedSource, "none", "@14s past the cap → captions-only");
  assert.equal(res.diagnostics[3].appliedSource, "none", "@18s past the cap → captions-only");
  // The capped-out moments record WHY (so the UI can surface it).
  assert.ok(/cap \(2\/video\) reached/.test(res.diagnostics[2].review.reason), res.diagnostics[2].review.reason);
  // Stickers are emitted in MOMENT order (the two earliest only).
  assert.deepEqual(res.stickers.map((s) => s.startTime), [6, 10]);
  delete process.env.MEME_OPENAI_MAX;
});

check("orchestrate default cap is a fixed 6 (generates up to 6, caps the rest)", async () => {
  delete process.env.MEME_OPENAI_MAX; // no override → default hard cap of 6
  // Eight unmatched moments; the default cap is 6, so only the six EARLIEST get
  // generated and the remaining two stay captions-only.
  const moments = Array.from({ length: 8 }, (_, i) => moment(6 + i * 4, `q${i}`));
  const p = makeProviders({
    searchResults: {},
    genUrls: Array.from({ length: 8 }, (_, i) => `/g/${i}.png`),
  });
  const res = await orchestrateStickers(moments, p);
  assert.equal(res.openaiCap, 6, "default cap = 6 (a fixed ceiling, not per-moment)");
  assert.equal(res.openaiUsed, 6, "never exceeds the default cap of 6");
  assert.equal(p.calls.generate.length, 6, "exactly six gen calls");
  assert.equal(res.stickers.length, 6);
  // Earliest-first prioritization: the six earliest moments generated, last two capped.
  assert.deepEqual(res.stickers.map((s) => s.startTime), [6, 10, 14, 18, 22, 26]);
  assert.equal(res.diagnostics[6].appliedSource, "none", "7th moment past the cap");
  assert.equal(res.diagnostics[7].appliedSource, "none", "8th moment past the cap");
  assert.ok(/cap \(6\/video\) reached/.test(res.diagnostics[6].review.reason), res.diagnostics[6].review.reason);
});

check("orchestrate skips OpenAI gen with a clear reason when no OpenAI key is present", async () => {
  delete process.env.MEME_OPENAI_MAX;
  const moments = [moment(6, "nope")];
  const p = makeProviders({ openaiAvailable: false, searchResults: {} });
  const res = await orchestrateStickers(moments, p);
  assert.equal(p.calls.generate.length, 0, "no gen attempted without a key");
  assert.equal(res.openaiUsed, 0);
  assert.equal(res.stickers.length, 0, "captions-only for that moment");
  assert.ok(/no OpenAI key/.test(res.diagnostics[0].review.reason), res.diagnostics[0].review.reason);
});

check("orchestrate: review DROP leaves the moment for the capped OpenAI fallback", async () => {
  delete process.env.MEME_OPENAI_MAX;
  const moments = [moment(6, "weird")];
  const p = makeProviders({
    searchResults: { weird: [cand("giphy", "g_weird.png")] },
    reviewPicks: () => ({ chosen: null, chosenIndex: null, reason: "all off-topic — dropped", reviewed: true }),
    genUrls: ["/gen/weird.png"],
  });
  const res = await orchestrateStickers(moments, p);
  assert.equal(p.calls.review.length, 1, "review ran");
  assert.equal(p.calls.generate.length, 1, "drop → OpenAI fallback filled it");
  assert.equal(res.diagnostics[0].appliedSource, "openai");
  assert.equal(res.openaiUsed, 1);
});

check("orchestrate legacy 'openai' source skips the free path entirely", async () => {
  delete process.env.MEME_OPENAI_MAX;
  const moments = [moment(6, "x"), moment(12, "y")];
  const p = makeProviders({ source: "openai", genUrls: ["/g/x.png", "/g/y.png"] });
  const res = await orchestrateStickers(moments, p);
  assert.equal(p.calls.search.length, 0, "no library search in legacy openai mode");
  assert.equal(p.calls.review.length, 0, "no review in legacy openai mode");
  assert.equal(p.calls.generate.length, 2, "both generated (within the cap)");
  assert.equal(res.openaiUsed, 2);
});

check("orchestrate with MEME_OPENAI_MAX=0 disables gen and records the reason", async () => {
  process.env.MEME_OPENAI_MAX = "0";
  const moments = [moment(6, "z")];
  const p = makeProviders({ searchResults: {} });
  const res = await orchestrateStickers(moments, p);
  assert.equal(p.calls.generate.length, 0, "cap 0 ⇒ no gen");
  assert.equal(res.openaiCap, 0);
  assert.ok(/gen disabled \(cap 0\)/.test(res.diagnostics[0].review.reason), res.diagnostics[0].review.reason);
  delete process.env.MEME_OPENAI_MAX;
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

// ── Bigger subtitles: meme font-size bump (meme-only) ─────────────────────────
import { memeSubtitleStyle, MEME_SUBTITLE_FONT_SCALE, MEME_MUSIC_VOLUME, MEME_SFX_VOLUME } from "../meme/config.js";

check("memeSubtitleStyle bumps the font size by the meme scale (rounded), nothing else", () => {
  for (const t of SUBTITLE_TEMPLATE_POOL) {
    const base = SUBTITLE_TEMPLATES[t];
    const bumped = memeSubtitleStyle(base);
    assert.equal(bumped.fontSize, Math.round(base.fontSize * MEME_SUBTITLE_FONT_SCALE), `${t} bumped`);
    assert.ok(bumped.fontSize > base.fontSize, `${t} is bigger`);
    // Every OTHER field is preserved (template look unchanged).
    assert.equal(bumped.fontFamily, base.fontFamily);
    assert.equal(bumped.template, base.template);
    assert.equal(bumped.allCaps, base.allCaps);
  }
});

check("meme font scale is a real, sane bump (1.25–1.4×) and never mutates the shared map", () => {
  assert.ok(MEME_SUBTITLE_FONT_SCALE >= 1.25 && MEME_SUBTITLE_FONT_SCALE <= 1.4, "scale in range");
  const before = SUBTITLE_TEMPLATES["yellow-box"].fontSize;
  memeSubtitleStyle(SUBTITLE_TEMPLATES["yellow-box"]);
  assert.equal(SUBTITLE_TEMPLATES["yellow-box"].fontSize, before, "shared template not mutated");
});

check("a typical bumped caption line fits the 9:16 safe width (longer lines auto-fit in ass.ts)", () => {
  // A typical viral caption line is one short word at a time (the chunker splits
  // 2–3 words, often onto separate lines). Using the same glyph-width estimate
  // ass/build use (~0.64×fontSize), a ~9-char line at the LARGEST bumped template
  // must still fit within the frame. ANY longer line is shrunk by ass.ts's
  // auto-fit (maxTextWidth = width*0.88), so the bump can never clip a caption.
  const bumped = memeSubtitleStyle(SUBTITLE_TEMPLATES["yellow-box"]).fontSize; // 108 → 140
  const estWidth = 9 * bumped * 0.64;
  assert.ok(estWidth < CANVAS.width, `est ${estWidth}px under frame ${CANVAS.width}px`);
  // And the bumped size is still a sane caption size (not absurdly large).
  assert.ok(bumped <= 160, `bumped ${bumped}px stays a reasonable caption size`);
});

// ── Random background music pick (reuses the short-form library + selection) ───
import { pickMusicTrack, type PickableTrack } from "../meme/music.js";

check("pickMusicTrack returns a track at the meme volume (0.03) from the library", () => {
  const tracks: PickableTrack[] = [
    { id: "a", audioUrl: "/m/a.mp3", trackName: "A", bpm: 120 },
    { id: "b", audioUrl: "/m/b.mp3", trackName: "B" },
  ];
  const m = pickMusicTrack(tracks, () => 0); // rng=0 → first ready track
  assert.ok(m);
  assert.equal(m!.audioUrl, "/m/a.mp3");
  assert.equal(m!.volume, MEME_MUSIC_VOLUME);
  assert.equal(MEME_MUSIC_VOLUME, 0.03, "music bed is exactly 0.03");
});

check("pickMusicTrack ignores tracks with no audioUrl and is random across ready ones", () => {
  const tracks: PickableTrack[] = [
    { id: "x" }, // no audioUrl → never picked
    { id: "y", audioUrl: "/m/y.mp3" },
    { id: "z", audioUrl: "/m/z.mp3" },
  ];
  // rng→ last ready track (index 1 of [y,z]) when rng ~0.99.
  const m = pickMusicTrack(tracks, () => 0.99);
  assert.equal(m!.audioUrl, "/m/z.mp3");
  // The no-url track is never returned across many draws.
  for (let i = 0; i < 50; i++) {
    const r = pickMusicTrack(tracks, () => i / 50);
    assert.ok(r && r.audioUrl !== undefined, "always a usable url");
  }
});

check("pickMusicTrack returns null for an empty / url-less library (captions+stickers still apply)", () => {
  assert.equal(pickMusicTrack([], () => 0), null);
  assert.equal(pickMusicTrack([{ id: "a" }, { id: "b" }], () => 0), null);
});

// ── SFX audio-mix filtergraph: pop at each sticker start, narration full ───────
import { buildSfxAudioFilters, buildPopArgs, SFX_DURATION_SEC } from "../meme/sfx.js";

check("buildSfxAudioFilters delays a pop to EACH sticker start and amix's with the base audio", () => {
  const { filters, audioLabel } = buildSfxAudioFilters({
    baseAudioLabel: "0:a",
    startTimes: [6.2, 12.5],
    sfxInputStart: 3, // base + 2 sticker clips
    volume: MEME_SFX_VOLUME,
  });
  const graph = filters.join(";");
  // One delayed, volume-scaled pop per sticker, at the right input index + ms.
  assert.ok(graph.includes("[3:a]adelay=6200|6200"), "pop 0 delayed to 6.2s on input 3");
  assert.ok(graph.includes("[4:a]adelay=12500|12500"), "pop 1 delayed to 12.5s on input 4");
  assert.ok(graph.includes(`volume=${MEME_SFX_VOLUME}`), "pops gained to the SFX volume");
  // The base audio is mixed at FULL level (no volume filter on [0:a]) + the pops.
  assert.ok(graph.includes("[0:a][sfx0][sfx1]amix=inputs=3"), "base + 2 pops mixed");
  // normalize=0 keeps narration dominant (amix doesn't halve the base).
  assert.ok(graph.includes("normalize=0"), "amix normalize=0 (narration stays full)");
  assert.equal(audioLabel, "aout_sfx");
});

check("buildSfxAudioFilters is a no-op when there are no stickers (carry base audio)", () => {
  const r = buildSfxAudioFilters({ baseAudioLabel: "0:a", startTimes: [], sfxInputStart: 1, volume: 0.3 });
  assert.deepEqual(r.filters, []);
  assert.equal(r.audioLabel, "0:a");
});

check("the SFX is synthesized (no sampled/copyrighted audio, no network) — lavfi oscillator only", () => {
  const args = buildPopArgs("/tmp/pop.wav");
  // Built purely from ffmpeg's lavfi aevalsrc oscillator — no input file, no URL.
  assert.ok(args.includes("lavfi"), "lavfi source");
  assert.ok(args.some((a) => a.startsWith("aevalsrc=")), "synthesized waveform");
  assert.ok(!args.some((a) => /^https?:\/\//.test(a)), "no network input");
  assert.ok(SFX_DURATION_SEC > 0 && SFX_DURATION_SEC < 1, "short pop");
  assert.equal(args[args.length - 1], "/tmp/pop.wav", "writes to the given out path");
});

check("SFX volume is audible but well under the narration (not overpowering)", () => {
  assert.ok(MEME_SFX_VOLUME > 0.1 && MEME_SFX_VOLUME < 0.6, `sfx vol ${MEME_SFX_VOLUME} tasteful`);
});

// ── Live progress reporting (so the UI narrates the pipeline) ─────────────────
check("orchestrate reports per-moment progress for the free review pass", async () => {
  const moments = [moment(6, "shocked"), moment(12, "money rain"), moment(18, "fire")];
  const ticks: Array<{ done: number; total: number; phase: string }> = [];
  const p = makeProviders({
    searchResults: { shocked: [cand("giphy", "g.png")], "money rain": [cand("tenor", "t.png")], fire: [cand("giphy", "f.png")] },
    onMomentProgress: (done, total, phase) => ticks.push({ done, total, phase }),
  });
  await orchestrateStickers(moments, p);
  // One tick per moment, monotonically increasing toward the total.
  assert.deepEqual(ticks.map((t) => t.done), [1, 2, 3]);
  assert.ok(ticks.every((t) => t.total === 3), "total is the moment count");
  assert.ok(ticks.every((t) => t.phase === "reviewing"), "free pass labelled 'reviewing'");
});

check("orchestrate reports per-moment progress for the paid generation pass", async () => {
  delete process.env.MEME_OPENAI_MAX;
  // No search results ⇒ both moments fall through to OpenAI generation.
  const moments = [moment(6, "a"), moment(12, "b")];
  const ticks: Array<{ done: number; phase: string }> = [];
  const p = makeProviders({
    searchAvailable: false,
    genUrls: ["/gen/a.png", "/gen/b.png"],
    onMomentProgress: (done, _total, phase) => ticks.push({ done, phase }),
  });
  await orchestrateStickers(moments, p);
  assert.deepEqual(ticks.map((t) => t.done), [1, 2]);
  assert.ok(ticks.every((t) => t.phase === "generating"), "paid pass labelled 'generating'");
});

check("orchestrate works fine with no progress callback (it's optional)", async () => {
  const moments = [moment(6, "shocked")];
  const p = makeProviders({ searchResults: { shocked: [cand("giphy", "g.png")] } });
  delete (p as { onMomentProgress?: unknown }).onMomentProgress;
  const res = await orchestrateStickers(moments, p);
  assert.equal(res.stickers.length, 1);
});

// ── Director surfaces WHY there are no moments (no silent fallback) ────────────
// `aiConfig` reads the key once at import, so we branch on the actual gate state
// rather than mutating env (which wouldn't take effect). Either way the director
// must now return a SPECIFIC reason instead of a bare empty list.
import { planEmphasisMoments } from "../meme/director.js";
import { anthropicConfigured } from "../ai/claude.js";

check("planEmphasisMoments always reports a SPECIFIC reason when it yields no moments", async () => {
  if (!anthropicConfigured()) {
    // Unconfigured: the gate trips before any network call → 'unconfigured'.
    const plan = await planEmphasisMoments({ transcript: "x".repeat(200), durationSeconds: 30 });
    assert.deepEqual(plan.moments, []);
    assert.ok(/unconfigured/.test(plan.unavailableReason ?? ""), plan.unavailableReason ?? "no reason");
  } else {
    // Configured: a tiny narration trips the length gate (still no network).
    const plan = await planEmphasisMoments({ transcript: "hi", durationSeconds: 3 });
    assert.deepEqual(plan.moments, []);
    assert.ok(/too short/.test(plan.unavailableReason ?? ""), plan.unavailableReason ?? "no reason");
  }
});

await Promise.all(pending);
console.log(`\n${passed} checks passed.`);
