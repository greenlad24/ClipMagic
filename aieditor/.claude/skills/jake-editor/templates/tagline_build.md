# tagline_build: usage (DRAFT)

**What it is.** A short tagline builds up word by word in big black type on a light-grey grid. Blue dots fly in from around the frame and merge into the 4 corner handles of a selection box around the text. The grid then cuts away and the text slowly pushes in. On the exit, a dark "dock" rail fades in at the right edge, and the 4 handles accelerate into it, where each lands as a spinner ring. Then there is a hard cut.

- Full-frame plate, 1.5 s in the reference.
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
- The "inbox / dock" exit implies "everything goes into one place". If the line is negative ("Stop doing X"), set `wipe: false`.

## 3. Timing anchors
- **start** = the first word of the tagline. Its id is beat `word_0`, and the plate cuts in on it.
- **word_i** = each tagline word's own spoken word id. Each word pops (scale 0.94 → 1 in 0.117 s) exactly on its word.
  - Words you leave unanchored fall back to the measured stagger 0.133 / 0.117 / 0.133 s.
  - Anchor every content word. Filler words in the narration ("the", "it's") are skipped, not shown.
- The push-in starts automatically 0.117 s after the last word, and no earlier than 0.5 s after word_0. Keep at least 0.12 s between the last word and `out`.
- **out** = the word right after the tagline ends (the next breath or "but/so"). The rail fades in on it (0.133 s), and the 4 handles land in the dock between out+0.43 s and out+0.53 s.
  - If `out` is missing: out = push + 0.372 s.
- **end / duration** = out + 0.628 s, then a hard cut (the measured exit).
  - If you give `end`, it wins: out = end − 0.628 s when `out` is unset.
- Duration: min 1.4 s, max 4.0 s. Between the last word and `out`, hold at most about 2 s. The push creeps on, but a longer hold looks static.

## 4. Content limits
- 2 to 8 words, one line, at most about 40 characters.
- Full stops are fine and are the house style ("Every agent. One inbox."). Avoid commas, emoji and quotes.
- Sentence case or title-case nouns. Not ALL CAPS.
- The text is set at cap height 92 px (0.085 H). It shrinks automatically when the ink would exceed 70 % of the frame width (1344 px), so very long lines get smaller. Prefer fewer than 30 characters.

## 5. Placement
- Full-frame plate. The text is centred, with its ink centre at (963, 543). The box and dots span roughly x 170–1760, and the feeders start from y 120 to 960.
- **Facecam bubble.** Several things pass under or touch the bubble disc (centre (1701.9, 253.7), r 179.3 px):
  - the TR handle (≈ (1610–1730, 420)) touches its lower edge;
  - feeders R2 and G run along y 120 and y 240 at x 1380–1740, right through it.
  - So **turn the bubble off for the plate's duration**. If the bubble must stay on, use `dots: false`.
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
| dots | bool | true | — | the feeder dots and corner handles |
| wipe | bool | true | — | the dock-rail exit; false = handles stay, hard cut at end |

Beats: `word_0` … `word_{n-1}`, `out`.

## 8. Worked example
Narration (job gpt2-10091958-9e9a, words.json):

```
35 same 11.10  36 bottle, 11.32  37 the 11.70  38 same 12.24  39 spot, 12.40  40 but 12.90  41 now 13.36
```

The overlay (plate from "same"@11.10; rail on "but"@12.90; cut at 12.90 + 0.628 = 13.53, about word 41):

```json
{"template": "tagline_build", "start": 35, "end": 41,
 "fields": {"words": "Same bottle. Same spot.", "backdrop": true, "dots": true, "wipe": true},
 "beats": {"word_0": 35, "word_1": 36, "word_2": 38, "word_3": 39, "out": 40}}
```

Resulting timeline:
- Words pop at +0.00, +0.22, +1.14 and +1.30 s.
- The push starts at +1.42 s.
- `out` is at +1.80 s; the plate runs 2.43 s in total (within 1.4–4.0).

## 9. QA checks
- Every word pops on its spoken word: within 1 frame of the word onset, with no fade.
- The text is one line and is not clipped. With the push (up to ×1.3), the right handle stays left of the rail (x < 1860).
- On the frame after the last word + 0.117 s, the grid is gone (hard cut) and the push has begun.
- On `out`, the rail fades in. All 4 handles land as rings before the cut, and the cut is at out + 0.628 s.
- The bubble is off for the plate, or dots are false.
- Hook zone only, ≤ 1 per video, and inside the G7 budget.

```json
{"id": "tagline_build",
 "params": {"words": {"type": "string", "default": null, "min": 2, "max": 8},
            "backdrop": {"type": "bool", "default": true},
            "dots": {"type": "bool", "default": true},
            "wipe": {"type": "bool", "default": true}},
 "beats": ["word_0", "word_1", "word_2", "word_3", "word_4", "word_5", "word_6", "word_7", "out"],
 "duration_s": [1.4, 4.0],
 "zone": "hook"}
```
