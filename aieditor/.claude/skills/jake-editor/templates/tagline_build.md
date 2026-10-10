# tagline_build: usage (DRAFT)

**What it is.** A short tagline builds up word by word in big black type on a light-grey grid. The grid then cuts away and the text slowly pushes in for 2.0 s, then there is a hard cut.

- Full-frame plate, 2.5 s with the reference timing.
- **Jake 2026-10-10:** the blue dots / selection handles and the dark right rail are removed (params `dots` / `wipe`, default **false**). The push-in runs 1 s longer at the same pace.
- Spec: `motion/reference-specs/tagline_build.md`.

## 1. When to use
Use it for a punchy two-part claim or tagline (often parallel, "X. Y.") said fast in the hook. The words should *be* the point, with nothing to show on screen. Real lines from Jake's narration (job gpt2, ChatGPT Images 2.5):

- "So it's **the same bottle, the same spot**, but now a real looking photo." → `Same bottle. Same spot.`
- "Everything in this video runs on **this one toolbar**. It shows up on **an image**…" → `One toolbar. Every image.`
- "It is **free on every plan**, but there's a daily cap…" → `Free on every plan.`
- "…you'll be **editing photos without having to describe them**." → `Edit photos. Skip the prompt.`
- Channel promise: "I help business owners **use AI without it turning into another full-time job**." → `Use AI. Not another job.`

## 2. When NOT to use
- The sentence names something we can show: a UI, a result image, or a before/after. Show that instead.
- Long sentences, or more than 8 words. Text that needs two lines. A question.
- A number or stat line. Use a data or keyword template.
- Outside the hook (zone = hook, first 40 s). Not twice in one video.
- When the narrator is mid-demo and the screen is the evidence.

## 3. Timing anchors
- **start** = the first word of the tagline. Its id is beat `word_0`, and the plate cuts in on it.
- **word_i** = each tagline word's own spoken word id. Each word pops (scale 0.94 → 1 in 0.117 s) exactly on its word.
  - Words you leave unanchored fall back to the measured stagger 0.133 / 0.117 / 0.133 s.
  - Anchor every content word. Filler words in the narration ("the", "it's") are skipped, not shown.
- The push-in starts automatically 0.117 s after the last word, and no earlier than 0.5 s after word_0. Keep at least 0.12 s between the last word and `out`.
- **out** = the hard cut. Anchor it on a word 1.5–3 s after the last word; if `out` is missing, out = push + 2.0 s.
  - The push is +6 % in 0.27 s, then a creep of +8.4 %/s (×1.23 at 2.0 s). It is capped at ×1.3.
  - If you give `end`, it wins: out = end when `out` is unset.
- Duration: min 1.6 s, max 4.5 s. The default with the reference staggers is 2.5 s.

## 4. Content limits
- 2 to 8 words, one line, at most about 40 characters.
- Full stops are fine and are the house style ("Every agent. One inbox."). Avoid commas, emoji and quotes.
- Sentence case or title-case nouns. Not ALL CAPS.
- The text is set at cap height 92 px (0.085 H). It shrinks automatically when the ink would exceed 70 % of the frame width (1344 px), so very long lines get smaller. Prefer fewer than 30 characters.

## 5. Placement
- Full-frame plate. The text is centred, with its ink centre at (963, 543). The box and dots span roughly x 170–1760, and the feeders start from y 120 to 960.
- **Facecam bubble.** By default (dots off) the text stays inside y 480–630, clear of the bubble disc (centre (1701.9, 253.7), r 179.3 px).
  - Still, it is a full-frame plate, so turn the bubble off during it.
  - Only if `dots: true`: the top-right handle and feeders R2 and G cross the disc.
- With `backdrop: false` the text, dots and rail are drawn on transparency over another plate. They must sit on a light background, because the text is #141413.

## 6. Frequency and spacing
- Hook only (first 40 s), and at most 1 per video.
- It counts against overlay budget G7: 7–9 overlays in total, 3–5 of them in the first 80 s.
- Full-frame plates must stay ≤ 1.5 % of runtime. At 1.5–2.5 s each, that is fine in a 10 min video, but count it with the other plates.
- Leave at least 4 s from any other text plate.

## 7. Parameters
| name | type | default | limits | effect |
|---|---|---|---|---|
| words | string | — (required) | 2–8 words, ≤ 40 chars | the tagline; split on spaces, one word per beat |
| backdrop | bool | true | — | grey radial plus the 120 px grid; false = transparent |
| dots | bool | false | — | (removed by Jake 2026-10-10) the feeder dots and corner handles |
| wipe | bool | false | — | (removed by Jake 2026-10-10) the dark dock-rail exit; off = hard cut at `out` |

Beats: `word_0` … `word_{n-1}`, `out`.

## 8. Worked example
Narration (job gpt2-10091958-9e9a, words.json):

```
35 same 11.10  36 bottle, 11.32  37 the 11.70  38 same 12.24  39 spot, 12.40  40 but 12.90  41 now 13.36
```

The overlay (plate from "same"@11.10; push from 12.52; hard cut on "now"@13.36):

```json
{"template": "tagline_build", "start": 35, "end": 41,
 "fields": {"words": "Same bottle. Same spot."},
 "beats": {"word_0": 35, "word_1": 36, "word_2": 38, "word_3": 39, "out": 41}}
```

Resulting timeline:
- Words pop at +0.00, +0.22, +1.14 and +1.30 s.
- The push starts at +1.42 s.
- The cut is at +2.26 s, which is 0.84 s of push. Use a later `out` word to show more of the push.

## 9. QA checks
- Every word pops on its spoken word: within 1 frame of the word onset, with no fade.
- The text is one line and is not clipped at the end of the push (ink × scale < 1840 px wide).
- On the frame after the last word + 0.117 s, the grid is gone (hard cut) and the push has begun.
- No dots and no right rail (unless explicitly enabled); hard cut on `out`.
- The bubble is off for the plate.
- Hook zone only, ≤ 1 per video, and inside the G7 budget.

```json
{"id": "tagline_build",
 "params": {"words": {"type": "string", "default": null, "min": 2, "max": 8},
            "backdrop": {"type": "bool", "default": true},
            "dots": {"type": "bool", "default": false},
            "wipe": {"type": "bool", "default": false}},
 "beats": ["word_0", "word_1", "word_2", "word_3", "word_4", "word_5", "word_6", "word_7", "out"],
 "duration_s": [1.6, 4.5],
 "_duration_note": "2026-10-10: push-in extended +1.0 s (hold 2.0 s after push start); default duration with reference staggers = 2.5 s; dots/wipe default false",
 "zone": "hook"}
```
