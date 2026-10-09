# verb_swap — usage (DRAFT)

A single line of large text on flat white, for example "ChatGPT can now ⟨sketch|erase|cut out⟩ your photos". The line builds word by word. Then one slot word, the "verb", swaps 2–4 times. Each verb has its own colour, and the line re-centres as the verb's width changes.
Motion: `motion/templates/verb_swap.kf.json`. Look: `verb_swap.style.json`. Spec: `motion/reference-specs/verb_swap.md`.

## 1. When to use
Use it when the narration lists **2–4 parallel capabilities, actions or features in one breath**, each of which is one or two words. Real examples from tutorial narration (job 131, ChatGPT Images 2.5):
- "So today I am walking you through **sketching**, uh, **comment pins**, **cutouts**, the whole toolbar…": `Today you'll learn` ⟨sketching | comment pins | cutouts⟩.
- "…that means that you can **change the background**, **change the scene**, **change the copy**…": `You can change the` ⟨background | scene | copy⟩. This sentence is at 820 s, so it is outside the hook zone. It shows the shape of a good fit, not a placement.
- "So you see sketch, markup, comment, erase…": `One toolbar to` ⟨sketch | mark up | erase⟩, using only the 3 strongest items.
- The reference itself: "Grok Bot can now **search**, **read**, **analyze** X".

## 2. When NOT to use
- The items are long phrases (more than 2 words or 14 characters each), or the list has more than 4 items. Use a list or titles template instead.
- The list isn't parallel, i.e. the items can't all slot into the same sentence frame.
- Only one item is named. Use keyword text instead.
- Outside the hook zone (see 6), or within 20 s of another full-frame plate.
- When the screen content is the point, for example a demo is running. With backdrop true this plate hides the screencast.

## 3. Timing anchors
- **start / `in`**: the first spoken word of the prefix idea. The first prefix word pops on it.
- **`word_k`** (optional, k = 1 … prefix words − 1): each prefix word pops on its own spoken word. If missing, the words are staggered 0.1 s apart. The reference used +0.033 / +0.167 / +0.3 s, clamped to land ≥ 0.1 s before verb_0.
- **`verb_0`**: verb 0 and the suffix pop on the spoken word of item 1, then slide 0.29 / 0.46 em left over 0.38 s.
- **`verb_i`** (i ≥ 1): verb i's text and colour switch hard on its spoken word. The re-centring motion starts 0.04–0.07 s before the word and settles 0.1–0.2 s after it. A missing `verb_i` falls back to the previous verb + 0.583 s (the measured mean spacing).
- **hold**: the reference holds 1.07 s after the last verb. Keep ≥ 0.5 s.
- **exit / `out`** (optional): the line hard-cuts off at `out`, or at the overlay end if `out` is absent. The reference has no exit animation.
- **duration**: min 1.8 s (in → last verb ≥ 1.2 s + 0.5 s hold), max 7 s. The reference is 2.83 s.
- Leave verb beats ≥ 0.3 s apart. A swap takes about 0.25 s.

## 4. Content limits
| field | limit |
|---|---|
| prefix | 1–6 words, ≤ 32 chars |
| verbs | 2–4 items, each 1–2 words and ≤ 14 chars |
| suffix | 0–3 words, ≤ 18 chars |
| widest full line (prefix + longest verb + suffix) | ≤ 40 chars to keep the measured 98.8 px size. Up to 60 chars is allowed: the font auto-shrinks to fit 88 % of the frame width |

Keep the case as spoken: sentence case, no trailing punctuation. Verb colours default to the measured blue #1b86f5, orange #f05c03 and green #0fe473, then cycle. A verb may set its own `colour`.

## 5. Placement
- The line sits on the frame's centre: x centred at 966.5 px, baseline at y 574 px @1080 (0.53 H).
- The glyphs occupy y ≈ 499–592. That is below the facecam bubble disc (centre (1701.9, 253.7), r 179.3 px, lowest point y 433), so with the bubble on, the text never sits under its centre.
- The widest allowed line spans x ≈ 115–1805, inside the 1920 × 1080 safe area (5 % margin) at the 0.88 W fit.
- `align: "left"` starts the line at x 160 (0.083 W). Use it only if a layout needs the right half clear.
- With `backdrop: true` (default) this is a full-frame white **plate**. With `backdrop: false` it is a transparent overlay. In that case black text needs a light plate behind it.

## 6. Frequency / spacing
- **Hook only.** Use it within the first 40 s, at most **once per video**.
- It counts toward overlay budget G7: 7–9 overlays in total, 3–5 of them in the first 80 s.
- As a plate it counts toward plates ≤ 1.5 % of runtime. For a 10-min video that is ≤ 9 s of plates in total, so keep this to 2–4 s.
- Keep ≥ 8 s from any other full-frame plate or text overlay.

## 7. Parameters
| param | type | default | limits |
|---|---|---|---|
| prefix | string | — (required) | 1–6 words, ≤ 32 chars |
| verbs | [{text, colour?}] | — (required) | 2–4 items, text ≤ 14 chars; colour = hex, default blue/orange/green then cycle |
| suffix | string | "" | 0–3 words, ≤ 18 chars |
| backdrop | bool | true | — |
| align | "centre" \| "left" | "centre" | — |

Beats: `in`, `word_1`…`word_5` (optional), `verb_0`…`verb_3`, `out` (optional).

## 8. Worked example
Narration (job 131, words.json, hook):

```
119 So 37.32 | 120 today 37.94 | 121 I 38.58 | 122 am 38.88 | 123 walking 39.16 | 124 you 39.62 | 125 through 39.90
126 sketching, 40.26 | 127 uh, 41.16 | 128 comment 41.52 | 129 pins, 42.02 | 130 cutouts, 42.58 | 131 the 43.30
132 whole 43.42 | 133 toolbar 43.66–44.18 | 134 with 44.20
```

On-screen line: "Today you'll learn ⟨sketching | comment pins | cutouts⟩". The prefix words are hung on "today", "walking" and "through". The overlay ends on "toolbar", which holds about 1.6 s after "cutouts".

```json
{"template": "verb_swap", "start": 120, "end": 133,
 "fields": {"prefix": "Today you'll learn",
            "verbs": [{"text": "sketching"}, {"text": "comment pins"}, {"text": "cutouts"}],
            "suffix": "", "backdrop": true, "align": "centre"},
 "beats": {"in": 120, "word_1": 123, "word_2": 125, "verb_0": 126, "verb_1": 128, "verb_2": 130}}
```

## 9. QA checks
- Each verb's text change lands on its spoken word, within ±1 frame. The prefix words pop on their words.
- At rest, consecutive verb states differ in line ink centre by ≤ 20 px, and no frame shows overlapping words. Touching is expected only on the 1–2 swap frames, as in the reference.
- No word is clipped: line width ≤ 0.88 W, and the font shrinks only if the content exceeds 40 chars.
- The verb colours are distinct from each other and from black text. A custom colour needs ≥ 3:1 contrast on white.
- The line is fully off at `out` / the overlay end, with no half-faded frame.
- The plate's total screen time stays within the plate budget, and the plate is in the first 40 s.

```json
{"id": "verb_swap",
 "params": {
   "prefix": {"type": "string", "default": null, "min": 1, "max": 6, "max_chars": 32, "unit": "words"},
   "verbs": {"type": "array", "default": null, "min": 2, "max": 4, "item_max_chars": 14, "item": {"text": "string", "colour": "hex?"}},
   "suffix": {"type": "string", "default": "", "min": 0, "max": 3, "max_chars": 18, "unit": "words"},
   "backdrop": {"type": "bool", "default": true, "min": null, "max": null},
   "align": {"type": "enum", "default": "centre", "values": ["centre", "left"], "min": null, "max": null}
 },
 "beats": ["in", "word_1", "word_2", "word_3", "word_4", "word_5", "verb_0", "verb_1", "verb_2", "verb_3", "out"],
 "required_beats": ["in", "verb_0"],
 "duration_s": [1.8, 7.0],
 "zone": "hook"}
```
