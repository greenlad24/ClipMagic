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
  assertBelowCaptions,
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

// ── Up to 6 MAIN emphasis points (fewer for short scripts) ─────────────────────
check("maxMomentsFor caps at 6 main emphasis points", () => {
  assert.equal(maxMomentsFor(40), 6);  // min(6, 10)
  assert.equal(maxMomentsFor(60), 6);  // min(6, 15) — never more than 6
  assert.equal(maxMomentsFor(16), 4);  // short script gets fewer
  assert.equal(maxMomentsFor(4), 1);   // floor of 1
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

// ── Placement: EVERY sticker sits BELOW the captions (the hard rule) ───────────
const CAP_TOP = Math.round(CANVAS.height * CAPTION_ZONE_TOP_FRACTION);
const CAP_BOTTOM = Math.round(CANVAS.height * CAPTION_ZONE_BOTTOM_FRACTION);

/** A box is inside the safe area iff every edge clears the safe margins. */
function insideSafe(box: StickerBox): boolean {
  return (
    box.left >= SAFE_LEFT &&
    box.left + box.size <= CANVAS.width - SAFE_RIGHT &&
    box.top >= SAFE_TOP &&
    box.top + box.size <= CANVAS.height - SAFE_BOTTOM
  );
}

check("placeSticker: EVERY placement is below the caption band AND fits the safe area", () => {
  // The hard product rule: a sticker NEVER goes above or into the caption band.
  // For every index the box top must be at/under the caption-zone bottom and the
  // whole box must fit the safe area. assertBelowCaptions throws on any violation;
  // we also independently re-check the invariants.
  for (let i = 0; i < 50; i++) {
    const box = placeSticker(i);
    assertBelowCaptions(box); // throws if not below the captions / off-frame / unsafe
    assert.ok(box.top >= CAP_BOTTOM, `box @${i} top ${box.top} >= captionBottom ${CAP_BOTTOM}`);
    assert.ok(insideSafe(box), `box @${i} inside safe area`);
    assert.equal(box.zone, "below-captions", `box @${i} is the below-captions slot`);
    assert.ok(box.size > 0, `box @${i} positive size`);
  }
});

check("placeSticker does NOT vary placement — always the below-captions slot", () => {
  // Reverted flexible placement: every index lands in the SAME below-captions box
  // (same top + zone), so stickers consistently live in the lower third.
  const first = placeSticker(0);
  for (let i = 1; i < 10; i++) {
    const box = placeSticker(i);
    assert.equal(box.zone, "below-captions", `box @${i} zone`);
    assert.equal(box.top, first.top, `box @${i} same top as @0`);
  }
});

check("assertBelowCaptions REJECTS a box that sits above the captions", () => {
  // A box that fits the safe area but is ABOVE the caption band must be rejected
  // by the stricter below-captions assertion (assertFits alone would allow it).
  const above: StickerBox = { left: 300, top: SAFE_TOP, size: 300, bottom: SAFE_TOP + 300, zone: "above" };
  assertFits(above); // legal as a general fit (above the captions, in safe area)
  assert.throws(() => assertBelowCaptions(above), /BELOW the captions/);
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

// ── Content safety: clean-only search ratings + a safe-constrained gen prompt ──
import { searchStickerCandidates } from "../meme/stickerSearch.js";
import { withSafetyConstraint, SAFETY_PROMPT } from "../meme/imagegen.js";

check("sticker search requests a SAFE content rating on BOTH providers (clean only)", async () => {
  // Stub fetch to capture the request URLs without any network. Both provider
  // keys are set so both branches build a URL; we assert the safe-rating params.
  const realFetch = globalThis.fetch;
  const realGiphy = process.env.GIPHY_API_KEY;
  const realTenor = process.env.TENOR_API_KEY;
  const urls: string[] = [];
  process.env.GIPHY_API_KEY = "test-giphy";
  process.env.TENOR_API_KEY = "test-tenor";
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return { ok: true, json: async () => ({ data: [], results: [] }) } as Response;
  }) as typeof fetch;
  try {
    await searchStickerCandidates("anything", 3);
  } finally {
    globalThis.fetch = realFetch;
    if (realGiphy === undefined) delete process.env.GIPHY_API_KEY; else process.env.GIPHY_API_KEY = realGiphy;
    if (realTenor === undefined) delete process.env.TENOR_API_KEY; else process.env.TENOR_API_KEY = realTenor;
  }
  const giphyUrl = urls.find((u) => u.includes("/v1/stickers/search"));
  const tenorUrl = urls.find((u) => u.includes("/v2/search"));
  assert.ok(giphyUrl, "giphy was queried");
  assert.ok(tenorUrl, "tenor was queried");
  // Giphy: rating=pg (clean), and never the laxer pg-13/r/etc.
  assert.ok(/[?&]rating=pg(&|$)/.test(giphyUrl!), `giphy rating=pg (got ${giphyUrl})`);
  assert.ok(!/rating=pg-13|rating=r\b|rating=nsfw/.test(giphyUrl!), "giphy never requests an unsafe rating");
  // Tenor: contentfilter=high (strictest), never medium/low/off.
  assert.ok(/[?&]contentfilter=high(&|$)/.test(tenorUrl!), `tenor contentfilter=high (got ${tenorUrl})`);
  assert.ok(!/contentfilter=(medium|low|off)/.test(tenorUrl!), "tenor never requests a lax filter");
});

check("the OpenAI gen prompt always carries the brand-safety constraint", () => {
  // The safety text forbids the categories that would make a sticker offensive.
  for (const banned of [/nudity|sexual/i, /gore|violen/i, /slur|hate/i, /drug/i, /shocking|disturbing|offensive/i]) {
    assert.ok(banned.test(SAFETY_PROMPT), `safety prompt forbids ${banned}`);
  }
  // withSafetyConstraint appends the constraint to ANY raw prompt, so every
  // generation is hard-constrained regardless of what the director wrote.
  const wrapped = withSafetyConstraint("a cartoon brain exploding");
  assert.ok(wrapped.includes("a cartoon brain exploding"), "keeps the original subject");
  assert.ok(wrapped.includes(SAFETY_PROMPT), "always appends the safety constraint");
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
  /** Which generator the mock claims produced the image (real one reports this). */
  genProvider?: string;
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
    async generate() {
      calls.generate.push("gen");
      const u = genUrls[genIdx++];
      return u ? { url: u, provider: over.genProvider ?? "segmind" } : null;
    },
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

check("orchestrate generates ONLY for moments the free path left unmatched", async () => {
  delete process.env.MEME_OPENAI_MAX; // cap = 2
  const moments = [moment(6, "matched"), moment(12, "unmatched")];
  const p = makeProviders({
    searchResults: { matched: [cand("giphy", "g.png")] /* "unmatched" → [] */ },
    genUrls: ["/gen/u.png"],
  });
  const res = await orchestrateStickers(moments, p);
  assert.equal(p.calls.generate.length, 1, "generated once — only for the unmatched moment");
  assert.equal(res.diagnostics[0].appliedSource, "giphy+tenor");
  assert.equal(res.diagnostics[1].appliedSource, "segmind", "the cheap generator is the default");
  assert.equal(res.openaiUsed, 1);
  assert.equal(res.stickers.length, 2);
});

check("orchestrate NEVER exceeds an explicit generation cap (prioritizing earliest moments)", async () => {
  process.env.MEME_OPENAI_MAX = "2"; // pin the cap at 2 to exercise cap enforcement
  // Four unmatched moments; the cap is 2, so only the two EARLIEST get generated.
  const moments = [moment(6, "a"), moment(10, "b"), moment(14, "c"), moment(18, "d")];
  const p = makeProviders({ searchResults: {}, genUrls: ["/g/a.png", "/g/b.png", "/g/c.png", "/g/d.png"] });
  const res = await orchestrateStickers(moments, p);
  assert.equal(res.openaiCap, 2);
  assert.equal(res.openaiUsed, 2, "never exceeds the cap");
  assert.equal(p.calls.generate.length, 2, "exactly two gen calls");
  // Deterministic prioritization: the two EARLIEST moments (6s, 10s) are generated.
  assert.equal(res.diagnostics[0].appliedSource, "segmind", "@6s generated");
  assert.equal(res.diagnostics[1].appliedSource, "segmind", "@10s generated");
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

check("orchestrate skips paid gen with a clear reason when no image-gen key is present", async () => {
  delete process.env.MEME_OPENAI_MAX;
  const moments = [moment(6, "nope")];
  const p = makeProviders({ openaiAvailable: false, searchResults: {} });
  const res = await orchestrateStickers(moments, p);
  assert.equal(p.calls.generate.length, 0, "no gen attempted without a key");
  assert.equal(res.openaiUsed, 0);
  assert.equal(res.stickers.length, 0, "captions-only for that moment");
  assert.ok(/no image-gen key/.test(res.diagnostics[0].review.reason), res.diagnostics[0].review.reason);
});

check("orchestrate: review DROP leaves the moment for the capped paid fallback", async () => {
  delete process.env.MEME_OPENAI_MAX;
  const moments = [moment(6, "weird")];
  const p = makeProviders({
    searchResults: { weird: [cand("giphy", "g_weird.png")] },
    reviewPicks: () => ({ chosen: null, chosenIndex: null, reason: "all off-topic — dropped", reviewed: true }),
    genUrls: ["/gen/weird.png"],
  });
  const res = await orchestrateStickers(moments, p);
  assert.equal(p.calls.review.length, 1, "review ran");
  assert.equal(p.calls.generate.length, 1, "drop → the paid generator filled it");
  assert.equal(res.diagnostics[0].appliedSource, "segmind");
  assert.equal(res.openaiUsed, 1);
});

check("orchestrate names the OpenAI RESCUE honestly when Segmind couldn't serve it", async () => {
  delete process.env.MEME_OPENAI_MAX;
  // imagegen falls back to OpenAI when the cheap generator fails; the diagnostic
  // must say which one actually produced the sticker, not assume the default.
  const p = makeProviders({ searchResults: {}, genUrls: ["/gen/r.png"], genProvider: "openai" });
  const res = await orchestrateStickers([moment(6, "nope")], p);
  assert.equal(res.diagnostics[0].appliedSource, "openai");
  assert.ok(/openai/.test(res.diagnostics[0].review.reason), res.diagnostics[0].review.reason);
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
import { memeSubtitleStyle, MEME_SUBTITLE_FONT_SCALE, MEME_MUSIC_VOLUME } from "../meme/config.js";

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

// ── Timeline alignment: stickers must land ON the words being said ───────────
// The director used to receive an UNTIMED transcript and estimate startTime from
// reading speed, which drifted. These assert the two halves of the fix: the
// timestamped prompt body, and the in-code re-derivation of every start.
import {
  findPhraseWindow,
  snapToWordStart,
  formatTimedTranscript,
  alignTiming,
  alignMoments,
  normalizeToken,
  tokensMatch,
  LEAD_SECONDS,
  HOLD_AFTER_SECONDS,
  MAX_SNAP_DRIFT_SECONDS,
} from "../meme/align.js";
import type { TranscriptWord } from "../ai/transcribe.js";

/** Build word timings from "word@start" specs, each word 0.3s long. */
function words(spec: string): TranscriptWord[] {
  return spec.split(" ").map((s) => {
    const [word, at] = s.split("@");
    const start = Number.parseFloat(at);
    return { word, start, end: start + 0.3 };
  });
}

const SCRIPT = words(
  "this@1.0 tool@1.4 is@1.8 ten@2.2 times@2.6 faster@3.0 than@3.5 the@3.9 old@4.3 way@4.7 " +
    "and@6.0 it@6.3 costs@6.7 almost@7.1 nothing@7.6 to@8.1 run@8.4",
);

check("findPhraseWindow pins a quoted phrase to the words that were spoken", () => {
  const w = findPhraseWindow(SCRIPT, "ten times faster");
  assert.ok(w, "expected a match");
  assert.equal(w!.start, 2.2);
  assert.equal(w!.score, 1);
  // End is the last matched word's end, not a guess.
  assert.ok(Math.abs(w!.end - 3.3) < 1e-9, `end ${w!.end}`);
});

check("findPhraseWindow tolerates ASR drift (a dropped/altered word)", () => {
  // "ten times slower" — 2 of 3 tokens match = 0.67, above the 0.6 threshold.
  const w = findPhraseWindow(SCRIPT, "ten times slower");
  assert.ok(w, "expected a tolerant match");
  assert.equal(w!.start, 2.2);
});

check("findPhraseWindow REFUSES a phrase that isn't really in the script", () => {
  assert.equal(findPhraseWindow(SCRIPT, "completely unrelated wording here"), null);
  assert.equal(findPhraseWindow(SCRIPT, ""), null);
  assert.equal(findPhraseWindow([], "ten times faster"), null);
});

check("findPhraseWindow uses the director's guess to pick between REPEATS", () => {
  const repeated = words("run@1.0 it@1.4 fast@1.8 and@5.0 run@5.4 it@5.8 fast@6.2");
  const early = findPhraseWindow(repeated, "run it fast", 1.2);
  const late = findPhraseWindow(repeated, "run it fast", 5.5);
  assert.equal(early!.start, 1.0);
  assert.equal(late!.start, 5.4, "the hint must select the later occurrence");
});

check("tokensMatch: exact, prefix-tolerant for long words, strict for short ones", () => {
  assert.ok(tokensMatch("faster", "faster"));
  assert.ok(tokensMatch("number", "numbers"), "plural drift should still match");
  assert.ok(!tokensMatch("ten", "the"), "short words must not match loosely");
  assert.ok(!tokensMatch("", "faster"));
});

check("normalizeToken strips punctuation and case so quotes still match", () => {
  assert.equal(normalizeToken("Faster,"), "faster");
  assert.equal(normalizeToken("it's"), "its");
  assert.equal(normalizeToken("—"), "");
});

check("alignTiming pins the sticker to the phrase, with a lead for the pop", () => {
  // The director guessed 5.0s for a line actually spoken at 2.2s — a 2.8s drift.
  const t = alignTiming(SCRIPT, { startTime: 5.0, endTime: 7.0, phrase: "ten times faster" });
  assert.equal(t.kind, "phrase");
  assert.ok(Math.abs(t.startTime - (2.2 - LEAD_SECONDS)) < 1e-9, `start ${t.startTime}`);
  assert.ok(Math.abs(t.endTime - (3.3 + HOLD_AFTER_SECONDS)) < 1e-9, `end ${t.endTime}`);
  assert.ok(t.shift > 2.5, "the correction must be reported");
});

check("alignTiming falls back to the nearest word ONSET when the phrase is unfindable", () => {
  const t = alignTiming(SCRIPT, { startTime: 6.45, endTime: 8.45, phrase: "nowhere in this script" });
  assert.equal(t.kind, "snapped");
  // 6.45 is nearest the word starting at 6.3.
  assert.ok(Math.abs(t.startTime - (6.3 - LEAD_SECONDS)) < 1e-9, `start ${t.startTime}`);
  // A snap preserves the planned LENGTH (only the start moves).
  assert.ok(Math.abs(t.endTime - t.startTime - 2.0) < 1e-9, "length must be preserved");
});

check("alignTiming leaves a hopeless time exactly as the director planned it", () => {
  const far = 60; // nowhere near any word in SCRIPT
  const t = alignTiming(SCRIPT, { startTime: far, endTime: far + 2, phrase: "unfindable" });
  assert.equal(t.kind, "kept");
  assert.equal(t.startTime, far);
  assert.equal(t.shift, 0);
  assert.ok(MAX_SNAP_DRIFT_SECONDS < far, "sanity: the drift cap is what refused the snap");
});

check("alignMoments re-derives every start and reports how each was pinned", () => {
  const { moments: out, summary } = alignMoments(
    {
      moments: [
        { startTime: 5.0, endTime: 7.0, searchQuery: "mind blown", phrase: "ten times faster" },
        { startTime: 6.45, endTime: 8.0, searchQuery: "money", phrase: "not in the script" },
      ],
    },
    SCRIPT,
  );
  assert.equal(summary.phrase, 1);
  assert.equal(summary.snapped, 1);
  assert.equal(summary.kept, 0);
  assert.ok(summary.maxShift > 2.5);
  // Fields other than the timing survive untouched.
  assert.equal((out[0] as { searchQuery: string }).searchQuery, "mind blown");
  assert.equal((out[0] as { alignedTo: string }).alignedTo, "phrase");
});

check("alignMoments is a NO-OP when there are no word timings (never invents sync)", () => {
  const raw = { moments: [{ startTime: 5, endTime: 7, searchQuery: "q", phrase: "p" }] };
  const { moments: out, summary } = alignMoments(raw, []);
  assert.deepEqual(out, raw.moments);
  assert.equal(summary.kept, 1);
});

check("aligned times still pass through sanitize's spacing/hold rules", () => {
  // Two moments aligned onto phrases 0.4s apart must not both survive — the
  // alignment feeds sanitize, it does not bypass it.
  const { moments: aligned } = alignMoments(
    {
      moments: [
        { startTime: 2.0, searchQuery: "one", phrase: "ten times faster" },
        { startTime: 2.4, searchQuery: "two", phrase: "times faster than" },
      ],
    },
    SCRIPT,
  );
  const kept = sanitize({ moments: aligned }, 30);
  assert.equal(kept.length, 1, "the second is too close and must be dropped");
  assert.equal(kept[0].alignedTo, "phrase", "the alignment kind survives sanitize");
});

check("formatTimedTranscript stamps each line with the second it is spoken", () => {
  const text = formatTimedTranscript(SCRIPT, { wordsPerLine: 4 });
  const lines = text.split("\n");
  assert.ok(lines[0].startsWith("[1.0s] "), lines[0]);
  assert.ok(lines[0].includes("this tool is ten"), lines[0]);
  // The 1.3s gap between "way" and "and" forces a break of its own.
  assert.ok(text.includes("[6.0s]"), text);
  for (const l of lines) assert.match(l, /^\[\d+\.\ds\] \S/);
});

check("snapToWordStart refuses a time that is nowhere near a word", () => {
  assert.equal(snapToWordStart(SCRIPT, 2.3), 2.2);
  assert.equal(snapToWordStart(SCRIPT, 40), null);
});

// ── Sticker sound effect ─────────────────────────────────────────────────────
import {
  buildSfxMix, sfxVolume, DEFAULT_SFX_VOLUME, sfxEnabled,
  clampSpeed, atempoChain, DEFAULT_SFX_SPEED, MIN_SFX_SPEED, MAX_SFX_SPEED,
} from "../meme/sfx.js";

check("buildSfxMix drops one pop at each sticker start, delayed in ms", () => {
  const plan = buildSfxMix({
    starts: [2, 7.5],
    sfxInputIndex: 3,
    baseAudioLabel: "0:a",
    volume: 0.18,
  });
  assert.ok(plan, "expected a mix plan");
  const f = plan!.filters.join(";");
  assert.ok(f.includes("[3:a]asplit=2[sfx0][sfx1]"), f);
  assert.ok(f.includes("adelay=2000:all=1,volume=0.18"), f);
  assert.ok(f.includes("adelay=7500:all=1,volume=0.18"), f);
  assert.ok(f.includes("[0:a][sfxd0][sfxd1]amix=inputs=3"), f);
});

check("buildSfxMix keeps the narration at its own level (the amix flags)", () => {
  const f = buildSfxMix({ starts: [1], sfxInputIndex: 2, baseAudioLabel: "0:a", volume: 0.2 })!
    .filters.join(";");
  // normalize=0 — otherwise amix divides every input by the input count and the
  // narration audibly ducks under each pop.
  assert.ok(f.includes("normalize=0"), f);
  // dropout_transition=0 — otherwise amix ramps its gain for 2s after each short
  // pop ENDS, swelling the narration after every sticker.
  assert.ok(f.includes("dropout_transition=0"), f);
  // duration=first — the mix ends with the narration, not with a trailing pop.
  assert.ok(f.includes("duration=first"), f);
  // A limiter after the mix — the base is already at a −1dBTP ceiling, so a pop
  // landing on a narration peak would otherwise cross 0dBFS and clip.
  assert.ok(/amix=[^;]*,alimiter=limit=0\.97\[/.test(f), f);
});

check("buildSfxMix returns nothing to mix when there are no stickers (or no gain)", () => {
  assert.equal(buildSfxMix({ starts: [], sfxInputIndex: 1, baseAudioLabel: "0:a", volume: 0.2 }), null);
  assert.equal(buildSfxMix({ starts: [1], sfxInputIndex: 1, baseAudioLabel: "0:a", volume: 0 }), null);
});

check("the sticker sound is QUIET by default and can never be turned up loud", () => {
  assert.equal(sfxVolume(undefined), DEFAULT_SFX_VOLUME);
  assert.equal(sfxVolume("not-a-number"), DEFAULT_SFX_VOLUME);
  assert.equal(sfxVolume("-1"), DEFAULT_SFX_VOLUME);
  assert.ok(DEFAULT_SFX_VOLUME <= 0.2, "default must stay well under the narration");
  assert.equal(sfxVolume("0.05"), 0.05);
  assert.equal(sfxVolume("5"), 0.6, "a runaway value is clamped, never blasted");
});

check("MEME_SFX=off disables the sticker sound entirely", () => {
  const prev = process.env.MEME_SFX;
  try {
    delete process.env.MEME_SFX;
    assert.equal(sfxEnabled(), true, "the sound is on by default");
    process.env.MEME_SFX = "off";
    assert.equal(sfxEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.MEME_SFX;
    else process.env.MEME_SFX = prev;
  }
});

check("an uploaded sound's speed is clamped to rates worth playing", () => {
  assert.equal(clampSpeed(1.5), 1.5);
  assert.equal(clampSpeed("1.5"), 1.5, "the client sends JSON — a numeric string still works");
  assert.equal(clampSpeed(undefined), DEFAULT_SFX_SPEED);
  assert.equal(clampSpeed("fast"), DEFAULT_SFX_SPEED);
  assert.equal(clampSpeed(0), DEFAULT_SFX_SPEED, "zero would be a silent file, not a slow one");
  assert.equal(clampSpeed(-2), DEFAULT_SFX_SPEED);
  assert.equal(clampSpeed(99), MAX_SFX_SPEED);
  assert.equal(clampSpeed(0.01), MIN_SFX_SPEED);
});

check("atempo changes tempo without pitch, and splits when one instance can't", () => {
  // 1× must add NO filter at all — an identity atempo would still resample.
  assert.equal(atempoChain(1), "");
  assert.equal(atempoChain(1.5), "atempo=1.500");
  assert.equal(atempoChain(2), "atempo=2.000");
  // Above 2 a single instance is unreliable across ffmpeg builds, so it splits
  // into two equal factors that multiply back to the requested rate.
  const chain = atempoChain(3);
  const factors = [...chain.matchAll(/atempo=([\d.]+)/g)].map((m) => Number(m[1]));
  assert.equal(factors.length, 2, chain);
  assert.ok(Math.abs(factors[0] * factors[1] - 3) < 0.01, chain);
  factors.forEach((f) => assert.ok(f >= 0.5 && f <= 2, `${f} is outside atempo's safe range`));
  // asetrate would be the pitch-shifting alternative; assert we never reach for it.
  assert.ok(!chain.includes("asetrate"));
});

// ── Segmind generation: cheaper images, and a SAFE local cut-out ─────────────
import { looksLikeGreenScreen, averageRgb, toFfmpegHex, GREEN_SCREEN_PROMPT } from "../meme/cutout.js";
import { providerChain, promptFor, cacheKey } from "../meme/imagegen.js";
import { SEGMIND_IMAGE_PER_IMAGE, OPENAI_IMAGE_PER_IMAGE, imagePricePerImage } from "../ai/pricing.js";

const GREEN: [number, number, number] = [1, 246, 3];

check("looksLikeGreenScreen accepts a real flat green field", () => {
  assert.ok(looksLikeGreenScreen([GREEN, [2, 247, 4], [1, 246, 3], [3, 245, 5]]));
});

check("looksLikeGreenScreen REFUSES to key a background that isn't green", () => {
  // A white studio background — keying it would punch holes in the sticker.
  assert.ok(!looksLikeGreenScreen([[250, 250, 250], [250, 250, 250], [249, 250, 251], [250, 249, 250]]));
  // Black, and a mid grey.
  assert.ok(!looksLikeGreenScreen([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]));
  assert.ok(!looksLikeGreenScreen([[128, 128, 128], [128, 128, 128], [128, 128, 128], [128, 128, 128]]));
});

check("looksLikeGreenScreen REFUSES a non-uniform background (gradient / subject at the edge)", () => {
  // Three green corners and one covered by the subject → do not key.
  assert.ok(!looksLikeGreenScreen([GREEN, GREEN, GREEN, [180, 120, 90]]));
  // A green gradient light→dark also fails the uniformity test.
  assert.ok(!looksLikeGreenScreen([[1, 130, 3], [1, 246, 3], [1, 190, 3], [1, 246, 3]]));
});

check("looksLikeGreenScreen needs all four corners to judge", () => {
  assert.ok(!looksLikeGreenScreen([GREEN, GREEN, GREEN]));
  assert.ok(!looksLikeGreenScreen([]));
});

check("the key colour is averaged from the corners and formatted for ffmpeg", () => {
  assert.deepEqual(averageRgb([[0, 240, 0], [2, 250, 4], [1, 245, 2], [1, 247, 2]]), [1, 246, 2]);
  assert.equal(toFfmpegHex([1, 246, 3]), "0x01f603");
  assert.equal(toFfmpegHex([255, 255, 255]), "0xffffff");
  assert.equal(toFfmpegHex([-5, 300, 0]), "0x00ff00", "out-of-range channels are clamped");
});

check("providerChain prefers the CHEAP generator and keeps OpenAI as a rescue", () => {
  assert.deepEqual(providerChain({ segmind: true, openai: true }, "segmind"), ["segmind", "openai"]);
  assert.deepEqual(providerChain({ segmind: true, openai: false }, "segmind"), ["segmind"]);
  // An unconfigured provider is dropped rather than attempted and failed.
  assert.deepEqual(providerChain({ segmind: false, openai: true }, "segmind"), ["openai"]);
  assert.deepEqual(providerChain({ segmind: false, openai: false }, "segmind"), []);
  // The preference can be pinned the other way.
  assert.deepEqual(providerChain({ segmind: true, openai: true }, "openai"), ["openai", "segmind"]);
});

check("only the Segmind prompt asks for a green screen (OpenAI gets real alpha)", () => {
  const seg = promptFor("a shocked cartoon cat", "segmind");
  const oai = promptFor("a shocked cartoon cat", "openai");
  assert.ok(seg.includes(GREEN_SCREEN_PROMPT), "segmind must ask for a keyable field");
  assert.ok(!oai.includes(GREEN_SCREEN_PROMPT), "openai would keep the green, not key it");
  // The brand-safety constraint is on BOTH, unconditionally.
  assert.ok(seg.includes(SAFETY_PROMPT) && oai.includes(SAFETY_PROMPT));
});

check("the image cache key separates providers so a switch can't serve a stale PNG", () => {
  const p = "a shocked cartoon cat";
  assert.notEqual(
    cacheKey(promptFor(p, "segmind"), "segmind"),
    cacheKey(promptFor(p, "openai"), "openai"),
  );
  assert.equal(cacheKey(promptFor(p, "segmind"), "segmind"), cacheKey(promptFor(p, "segmind"), "segmind"));
});

check("Segmind GPT Image 2 at the default quality really is cheaper than the OpenAI path", () => {
  const segmind = imagePricePerImage("gpt-image-2", "segmind", "low");
  const openai = imagePricePerImage("gpt-image-1", "openai");
  assert.equal(segmind, SEGMIND_IMAGE_PER_IMAGE["gpt-image-2:low"]);
  assert.equal(openai, OPENAI_IMAGE_PER_IMAGE["gpt-image-1"]);
  assert.ok(segmind < openai, `${segmind} should undercut ${openai}`);
  // "medium" would cost MORE than the path it replaced — the reason low is the
  // default, asserted so a future bump is a deliberate choice.
  assert.ok(imagePricePerImage("gpt-image-2", "segmind", "medium") > openai);
  // An unknown model is reported as $0, never guessed at.
  assert.equal(imagePricePerImage("no-such-model", "segmind", "low"), 0);
  assert.equal(imagePricePerImage("no-such-model"), 0);
});


await Promise.all(pending);
console.log(`\n${passed} checks passed.`);
