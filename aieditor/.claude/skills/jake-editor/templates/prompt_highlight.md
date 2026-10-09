# prompt_highlight — usage (DRAFT)

The app's prompt box is typing a long prompt. Over about 0.75 s the camera pushes in on it (×1.55). Then a **yellow marker** sweeps over each key phrase, left → right and line by line, on the word where the narration says that phrase. The phrase's text turns dark under the marker. The highlights stay on, and they never join up: the word between two highlights stays unmarked.
- Motion: `motion/templates/prompt_highlight.kf.json`.
- Look: `prompt_highlight.style.json` plus the app's UI kit (`ui-kits/<app>/kit.json`).
- Spec: `motion/reference-specs/prompt_highlight.md`.
- Reference: motion5 (Claude.ai, dark).

## 1. When to use
Use it when Jake **reads out a prompt, or walks through its parts, and the parts are the point**: "the key part is…", "notice I tell it to…", "and this bit matters…". Each highlighted phrase must be words he actually says. Real narration (job 131, ChatGPT Images 2.5):
- "So I'll type, turn this rough sketch into a **realistic photo**. A **glass squat hot sauce bottle** on a weathered wooden picnic table. **Warm, late afternoon light**, shallow depth of field." → app chatgpt; phrases "realistic photo", "glass squat hot sauce bottle", "warm late-afternoon light".
- "Merge these three: **the person from the first photo**, standing at the market stall from the second photo, **holding the bottle from the third photo**. **Keep the face and the bottle label exactly as they are.**" → three phrases, the last being the instruction he stresses.
- "Use this exact bottle. Put it on a **rustic kitchen counter** beside fresh chillies, **morning light** through a window." → two phrases.
- The reference: a character-sheet prompt in Claude with "Put her face in the portrait panel", "crop the front and back outfit views from the neck down." and "Plain grey background, soft even light, empty hands." marked as he explains them.

**Prompt boxes must look like the real app** (Jake, 2026-10-09). Give `app` so the planner loads `ui-kits/<app>/kit.json`. Kits today: `claude` (greeting "Evening, Jake"; built from the reference, verify against live) and `chatgpt` (live DOM). With no kit, the template draws a neutral dark box, never another app's UI.

## 2. When NOT to use
- A short prompt of one line or ≤ 60 chars with nothing to point at. Use prompt_card_3d.
- The prompt's **result** is the point. Use prompt → result (MO05).
- The narration doesn't name the parts: highlights on words he doesn't say are decoration.
- A click-by-click walkthrough. Use a screencast.
- More than 3 phrases, or phrases he paraphrases instead of quoting. The phrase text must be an exact substring of the prompt.
- Two prompt templates within 8 s of each other.

## 3. Timing anchors
- **start**: the first spoken word of the prompt (or "So I'll type"). The overlay starts 0.2 s before it (lead).
- **`in`** (default = lead): hard cut in. The composer is already showing, with the text typed so far.
- **`type`** (optional; found automatically on the prompt's first three words):
  - Given (later than `in`): the box is empty, with a placeholder, until `type`, and typing starts there.
  - Not given: typing runs from `in`. The box already holds as much text as needed for the first phrase to finish typing at the natural rate just before `hl_0`, snapped back to a word start (`pretyped`, auto). The reference had 260 of 426 chars typed at the cut.
- **Typing rate**: 30.6 chars/s, one char at a time, full text layout, so words never jump lines. The caret disappears 0.13 s after the last char.
- **`hl_i`** (i = 0 … n−1; found automatically on each phrase's first spoken word): the sweep of phrase i **starts on this beat**. Its duration is 0.10–0.50 s per line (0.0256 s × width in em). A wrapped phrase sweeps line by line, with 0.011 s between lines.
  - **Tolerance**: the sweep starts within ±1 frame of its beat when the rule below holds. Measured replica error: ≤ 1.8 frames @60 fps.
  - **A phrase that isn't typed by its beat**: the typing before it speeds up (up to 120 chars/s) so the phrase is complete 0.03 s before the beat. If even 120 chars/s can't make it, the sweep starts 0.03 s after the phrase's last char (late), and QA flags it.
  - Sweeps never overlap: sweep i starts no earlier than the end of sweep i−1. Sweep 0 never starts before the push lands.
  - Missing `hl_i`: hl_0 = in + 1.959 s, then +1.745 s each (the reference spacing).
- **Push-in**: ends exactly at `hl_0` and lasts 0.742 s, so it starts 0.742 s before `hl_0`. It is shortened to ≥ 0.4 s, starting ≥ 0.1 s after `in`, when `hl_0` comes early.
- **Composer growth**: +1 line height, starting 0.352 s before the first char of a new line, over 0.368 s.
- **`out`** (optional): hard cut (the reference has no exit). Default end = last sweep end + 2.68 s hold (min 0.8 s).
- **duration**: 3–10 s. The reference is 8.6 s; a typical 3-phrase use is 6–9 s.

## 4. Content limits
| field | limit |
|---|---|
| prompt | 8–440 chars. The reference is 426 chars = 5 lines at the end view. Up to about 7 lines fit: the push-in shrinks automatically so the composer, greeting and chips stay 40 px inside the frame. Longer than ~280 chars needs `pretyped` (auto does it), or the typing alone outlasts the clip |
| phrases | 1–3, each an exact substring of the prompt, in prompt order, ≤ 70 chars (one or two lines) |
| greeting | ≤ 32 chars, kits with a greeting only (Claude). Default "Evening, Jake". Never another person's name |

The current rules.json says prompt max 320. The reference's own prompt is 426, so this draft proposes 440 (see the JSON).

## 5. Placement
- **Full-frame plate**: backdrop = the kit's page colour (Claude #20201D, ChatGPT #000); neutral #20201D.
- **Composer at the start**: 847 px wide, centred at x 960, top ≈ y 443. The push scales ×1.5486 about the pivot (931, 617). At the end the composer is ≈ 1313 px wide (x 319–1631), with its centre at y 512.5 (frame centre −28 px, inside the F1 tolerance).
- **Facecam bubble disc** (centre (1701.9, 253.7), r 179.3): the end view's composer right edge is x 1631 and the greeting/chips stay left of x 1400. The composer's top-right corner (1631, 348) is 118 px from the disc centre (inside the disc). It never reaches the centre, but **the rounded top-right corner of the composer passes under the bubble rim** for a 5-line prompt. With the bubble on, prefer prompts of ≤ 4 lines or `push_in` ≤ 1.45.

## 6. Frequency / spacing
- **Default: hook only** (first 40 s; Jake's prompt-box ruling), at most once per video, inside overlay budget G7: 7–9 overlays total, 3–5 in the first 80 s. As a plate it counts toward plates ≤ 1.5 % of runtime.
- **Flag for the lead:** the reference itself is NOT a hook shot. It sits at 1:25 of a 17-minute tutorial, where the creator explains the prompt he is typing. That suggests this is a body technique for the one moment a video reads out its key prompt. I recommend allowing it **once in the body** for that moment, in addition to the hook budget. **Unchanged until the lead/Jake decides; the JSON says "hook".**

## 7. Parameters
| param | type | default | limits |
|---|---|---|---|
| prompt | string | — (required) | 8–440 chars |
| phrases | [string] | — (required) | 1–3, exact substrings, ≤ 70 chars each |
| app | string | null | a kit id under ui-kits/ (null = neutral box) |
| push_in | number | null = 1.5486 (measured) | 1.0–2.0; reduced automatically to fit |
| greeting | string | null = kit default ("Evening, Jake") | ≤ 32 chars |
| backdrop | bool | true | false = composer only, on transparency |
| pretyped | int | null = auto | 0 … len(prompt) |

Beats: `in`, `type`, `hl_0`, `hl_1`, `hl_2`, `out` (optional).

## 8. Worked example
Job 131 words.json, the sketch-to-photo prompt (a body moment at 213 s; the shape of a good fit):

```
651 type, 212.10 | 652 turn 212.94 | 653 this 213.08 | 654 rough 213.30 | 655 sketch 213.70 | 656 into 214.02
657 a 214.42 | 658 realistic 214.66 | 659 photo. 215.14 | 660 A 215.90 | 661 glass 216.26 | 662 squat 216.62
663 hot 217.14 | 664 sauce 217.62 | 665 bottle 217.90 | 666 on 218.26 | 667 a 218.80 | 668 weathered 218.92
669 wooden 219.46 | 670 picnic 219.72 | 671 table. 220.04–220.42 | 672 Warm, 221.02
```

```json
{"template": "prompt_highlight", "start": 652, "end": 671,
 "fields": {"app": "chatgpt",
            "prompt": "Turn this rough sketch into a realistic photo — a glass squat hot sauce bottle on a weathered wooden picnic table, warm late-afternoon light, shallow depth of field.",
            "phrases": ["realistic photo", "glass squat hot sauce bottle"]},
 "beats": {"type": 652, "hl_0": 658, "hl_1": 661}}
```

**Timeline** (clip seconds, t0 = 212.74):
- in 0.20, type 0.20 (box empty before that: placeholder).
- Typing runs 30.6 chars/s from 0.20. "realistic photo" (ends char 45) is typed at 1.67 s; the push-in runs 1.18 → 1.92.
- hl_0 = 1.92: the "realistic photo" sweep, 0.17 s.
- "…bottle" (char 78) typed at 2.75; hl_1 = 3.52: the "glass squat hot sauce bottle" sweep, 0.31 s.
- Typing ends at 5.59 (165 chars); the caret is gone at 5.72. End at word 671's end, 220.42 → duration 7.68 s (hold ≈ 3.8 s after the last sweep).
- "Warm, late afternoon light" would need hl_2 at 221.02 = 8.28 s and a ~10 s clip. Leave it out, or start the overlay later with `pretyped`.

## 9. QA checks
- Every phrase is an exact substring and in prompt order. Each sweep starts on its `hl_i` beat, ±1 frame; a late sweep is flagged.
- No phrase is highlighted before it is fully typed. Highlights never cover the words between phrases.
- Line breaks never change while typing (no word jumps lines). The composer grows before the new line's first char.
- The push-in has landed by `hl_0`. The final composer, greeting and chips are inside the frame with a 40 px margin.
- The kit is the app the narration is in. With no kit the box is neutral. The greeting shows Jake's name, never anyone else's. No e-mail, avatar or chat history is visible (C7).
- Nothing is drawn before `in` or after `out`/the duration. It sits in the hook zone and the plate budget, and the composer centre is never under the bubble centre.

```json
{"id": "prompt_highlight",
 "params": {
   "prompt": {"type": "string", "default": null, "min": 8, "max": 440, "unit": "chars"},
   "phrases": {"type": "list", "default": null, "min": 1, "max": 3, "item_max_chars": 70, "rule": "exact substrings of prompt, in prompt order"},
   "app": {"type": "string", "default": null, "min": null, "max": null},
   "push_in": {"type": "number", "default": null, "min": 1.0, "max": 2.0, "measured": 1.5486},
   "greeting": {"type": "string", "default": null, "min": 0, "max": 32, "unit": "chars"},
   "backdrop": {"type": "bool", "default": true, "min": null, "max": null},
   "pretyped": {"type": "int", "default": null, "min": 0, "max": 440}
 },
 "beats": ["in", "type", "hl_0", "hl_1", "hl_2", "out"],
 "required_beats": ["hl_0"],
 "beat_tolerance_frames": 1,
 "duration_s": [3.0, 10.0],
 "zone": "hook",
 "zone_note": "reference is a body shot (1:25 of a 17-min tutorial); proposal: also once in the body when the key prompt is read out — lead decides"}
```
