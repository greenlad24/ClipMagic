# long_prompt_scroll — usage (DRAFT)

What the viewer sees:
- A **long, structured prompt or message** in the app's conversation view, shown whole at first (the full app UI).
- The camera **zooms in hard (×1.9, 0.65 s)** until the serif text fills the frame.
- It then **scrolls down the text** at a readable pace.
- A **yellow marker** sweeps each key phrase on the word where the narration says it. The highlights pile up and stay.

This is prompt_highlight's sibling for prompts too long to show whole: same marker, same dark text under it.

Files:
- Motion: `motion/templates/long_prompt_scroll.kf.json`
- Look: `long_prompt_scroll.style.json`, plus the app's MESSAGE view from its UI kit (`ui-kits/<app>/kit.json` → `message`)
- Spec: `motion/reference-specs/long_prompt_scroll.md`
- Reference: motion6 (Claude.ai, dark)

## 1. When to use
Use it when Jake **walks through a long, sectioned prompt or document and calls out parts of it**. Typical cases: Claude wrote him a detailed image or video prompt, or he shows the system prompt or brief he uses. Real narration shapes:
- Job 131, the sketch prompt: "turn this rough sketch into a **realistic photo**. A glass squat hot sauce bottle on a **weathered wooden picnic table**. **Warm, late afternoon light, shallow depth of field**."
  - Use this template when that sentence is one section of a longer prompt, e.g. the 4-shot product prompt with THE BOTTLE / SHOT 1 … / STYLE sections.
  - Phrases: "realistic photo", "weathered wooden picnic table", "warm late-afternoon light, shallow depth of field".
- "Merge these three … **Keep the face and the bottle label exactly as they are**" → one phrase deep inside a long prompt. The camera scrolls down to it.
- The reference: Claude's scene prompt for an image model. Highlighted as they were explained: "A DENSE row of colorful market stalls…", "terrace opens to a wide hazy VALLEY view", the heading "LIGHT — MIDDAY SUN:" and "Strong high sun: crisp dense shadows".

**The view must be the real app** (Jake 2026-10-09). Give `app`, and the planner loads the app's kit:
- **claude**: the conversation view (`kit.message`, from the reference; verify against live).
- **chatgpt**: no message view yet. The text is shown in ChatGPT's own answer view (`kit.result.text`) on its page colour, with no header and no composer.
- **No kit**: a neutral dark document view (no logo, no chrome). Never another app's UI.

## 2. When NOT to use
- **A short prompt** (fits the composer, ≤ ~440 chars, ≤ 7 lines) → **prompt_highlight**. A one-liner → prompt_card_3d.
- The **result** is the point → prompt → result (MO05).
- He doesn't name or quote the parts. Phrases must be words he actually says; a highlight on unspoken text is decoration.
- He reads the whole prompt line by line. The scroll is a skim (up to 12.6 lines/s), not a teleprompter. Use a screencast or split the prompt.
- Phrases more than ~60 lines apart, or more than 6 phrases. Each long jump costs seconds (see §3) and loses the viewer.
- Private text on screen: e-mails, keys, other people's names, client data (C7). The prompt text must be safe to publish.

## 3. Timing anchors
- **start**: the first spoken word of the walkthrough. The overlay starts 0.2 s before it (lead).
- **`in`**: hard cut in to the whole app view at scale 1. The message is scrolled so the first phrase will land at the reading position.
- **`zoom`** (optional): the zoom starts. Default in + 1.09 s.
  - It is moved earlier when `hl_0` needs it: it never starts later than `hl_0` − 0.41 s, and never before in + 0.1 s.
  - The zoom lasts 0.647 s, eased cubic-bezier(0.714, 0.083, 0.327, 0.704), ending at ×1.8959.
- **`hl_i`** (i = 0 … n−1): the sweep of phrase i **starts on this beat**, on the phrase's first spoken word.
  - Sweep 0 can run while the zoom is still landing (reference: 66 % through).
  - Each line piece takes a fixed 0.358 s. A wrapped phrase's next line starts 0.242 s after the previous line. A phrase never starts before the previous phrase's last line + 0.242 s.
  - Missing `hl_0` = zoom + 0.41 s. Each missing later beat = the previous one + 1.0 s.
- **Scroll moves** (automatic, no beat):
  - A phrase that is not in the reading area (its bottom below 90 % of the frame) gets a move. The move ends with the last phrase of its group at 61 % of the frame height. One move carries every following phrase that fits.
  - The move starts so that the phrase is fully on screen on its beat, at least 0.054 s before the beat.
  - It never starts before the previous move ends, nor within 0.25 s of the previous sweep's end.
- **Reading-speed limit (enforced):**
  - A move lasts **max(0.5 s, lines ÷ 12.56)**: 12.56 message lines per second on average, the reference's own speed (17.6 lines in 1.40 s; peak 27 lines/s).
  - If the beats ask for more, the template does **not** speed up. That sweep starts late, and when it is > 0.1 s late the template reports it (`console.warn("long_prompt_scroll: hl_i starts … s after its beat …")`, `window.__lpsWarnings`).
  - Plan so that the gap between two beats ≥ (lines between the phrases ÷ 12.56) + 0.6 s.
- **Tolerance**: a sweep starts exactly on its beat (±1 frame) unless reported late. The replica's sweeps start on the reference's starts, and the scroll is within 0.5 frames on average.
- **`out`** (optional): hard cut (the reference has no exit). Default end = last sweep end + 0.73 s hold (min 0.5 s).
- **duration**: 3–12 s. The reference is 5.5 s; a typical 3–4 phrase walkthrough is 6–11 s.

## 4. Content limits
| field | limit |
|---|---|
| prompt | 300–4000 chars (the reference is ≈ 3,000 chars, 50+ lines). Under ~300 chars / 8 lines → prompt_highlight. Section headings are plain lines ("SHOT 1 — PICNIC TABLE:") after a blank line. No markdown: it is shown as typed, pre-wrapped |
| phrases | 1–6, exact substrings of the prompt, in prompt order, 3–120 chars each (≤ 3 lines at the end view). A phrase that is not found is dropped and reported |
| title | ≤ 40 chars, the chat title in the header (Claude). Default empty. Never a client or private name |
| span | the first to the last phrase ≤ ~60 lines (≈ 5 s of scrolling) |

## 5. Placement
- **Full-frame plate**: backdrop = the kit's page colour (Claude #20201D, ChatGPT #000); neutral #20201D.
- **Start view**: the whole app at its natural size (Claude: text column 796 px at x 560, composer 847 px at the bottom).
- **End view** (×1.8959 about (949.9, 452.5)):
  - The text column spans **x 210–1727**, font 35.8 px, line pitch 55 px.
  - Phrases sit between y 60 and 661 after a move. The first phrase's top is at y 593.
- **Facecam bubble** (disc centre (1701.9, 253.7), r 179.3): at the default zoom the text runs **under the disc and past its centre**.
  - With the bubble on, set `zoom_target.scale` ≤ **1.6**, which puts the column's right edge at x 1599, short of the centre.
  - ≤ 1.41 clears the disc entirely.
  - Otherwise hide the bubble for this plate.

## 6. Frequency / spacing
- **Default: hook only** (first 40 s; Jake's prompt-box ruling), at most once per video, inside overlay budget G7: 7–9 overlays total, 3–5 in the first 80 s. As a plate it counts toward plates ≤ 1.5 % of runtime.
- Never within 8 s of another prompt template.
- **Flag for the lead (the same argument as prompt_highlight):** a long-prompt walkthrough is mostly a BODY moment, where the tutorial explains the prompt it uses. I recommend allowing it **once in the body** for that moment, in addition to the hook budget. **Unchanged until the lead/Jake decides; the JSON says "hook".**

## 7. Parameters
| param | type | default | limits |
|---|---|---|---|
| prompt | string | — (required) | 300–4000 chars |
| phrases | [string] | — (required) | 1–6, exact substrings, in order, 3–120 chars |
| app | string | null | a kit id under ui-kits/ (null = neutral view) |
| title | string | "" | ≤ 40 chars (Claude header) |
| zoom_target | object | null = measured {scale 1.8959, x 0.4947, y 0.4190} | scale 1.0–2.2 (reduced automatically to fit a 40 px margin); x/y = pivot as frame fractions |
| backdrop | bool | true | false = the app view only, on transparency |

Beats: `in`, `zoom`, `hl_0` … `hl_5`, `out` (optional).

## 8. Worked example
This is job 131 (ChatGPT Images 2.5). Jake reads SHOT 1 of the product-series prompt (the same prompt as the preview `long_prompt_scroll-claude-dark.mp4`). The words.json excerpt:

```
652 turn 212.94 | 653 this 213.08 | 654 rough 213.30 | 655 sketch 213.70 | 656 into 214.02 | 657 a 214.42
658 realistic 214.66 | 659 photo. 215.14 | 660 A 215.90 | 661 glass 216.26 | 662 squat 216.62 | 663 hot 217.14
664 sauce 217.62 | 665 bottle 217.90 | 666 on 218.26 | 667 a 218.80 | 668 weathered 218.92 | 669 wooden 219.46
670 picnic 219.72 | 671 table. 220.04 | 672 Warm, 221.02 | 673 late 221.40 | 674 afternoon 222.00
675 light, 222.44 | 676 shallow 223.22 | 677 depth 223.60 | 678 of 223.80 | 679 field. 223.98
```

```json
{"template": "long_prompt_scroll", "start": 652, "end": 679,
 "fields": {"app": "claude", "title": "Hot sauce product shots",
            "prompt": "Create a product photo series for my hot sauce brand — four shots, …\n\nSHOT 1 — PICNIC TABLE:\nTurn the rough sketch into a realistic photo: the bottle on a weathered wooden picnic table outside, warm late-afternoon light, shallow depth of field, …\n\nSHOT 2 — KITCHEN COUNTER:\n…",
            "phrases": ["realistic photo", "weathered wooden picnic table", "warm late-afternoon light, shallow depth of field"]},
 "beats": {"hl_0": 658, "hl_1": 668, "hl_2": 672}}
```

**Timeline** (clip seconds, t0 = 212.74):
- in 0.20, zoom 1.29 → 1.94.
- hl_0 = 1.92 ("realistic photo").
- hl_1 = 6.18. The phrase is on the next line, already on screen, so there is no move.
- hl_2 = 8.28. It is on the line after, also on screen.
- End = word 679 + 0.3 s → 11.5 s.

If the phrases were 30 lines apart, the move would need 30 ÷ 12.56 = 2.4 s. With hl_1 − hl_0 = 4.26 s it fits; with a gap under ≈ 2.9 s the sweep would be reported late.

## 9. QA checks
- **Phrases:** every phrase is an exact substring, in prompt order, and spoken. Each sweep starts on its `hl_i` (±1 frame), and **no late warnings** (`window.__lpsWarnings` empty). A warning means: space the beats or drop a phrase.
- **Scroll:** never faster than 12.56 lines/s on average. Every phrase is fully on screen (y 8–1073) when its sweep starts. Highlights stay to the end.
- **Kit:** the kit is the app the narration is in. With no kit the view is neutral. The chat title is safe, and no e-mail, avatar, history or private text is visible (C7).
- **Bubble:** with the bubble on, the zoom keeps the text column short of the bubble centre (`zoom_target.scale` ≤ 1.6).
- **Timing and budget:** nothing is drawn before `in` or after `out`/the duration. It sits in the hook zone and the plate budget.

```json
{"id": "long_prompt_scroll",
 "params": {
   "prompt": {"type": "string", "default": null, "min": 300, "max": 4000, "unit": "chars"},
   "phrases": {"type": "list", "default": null, "min": 1, "max": 6, "item_min_chars": 3, "item_max_chars": 120, "rule": "exact substrings of prompt, in prompt order"},
   "app": {"type": "string", "default": null, "min": null, "max": null},
   "title": {"type": "string", "default": "", "min": 0, "max": 40, "unit": "chars"},
   "zoom_target": {"type": "object", "default": null, "min": null, "max": null, "fields": {"scale": [1.0, 2.2], "x": [0, 1], "y": [0, 1]}, "measured": {"scale": 1.8959, "x": 0.4947, "y": 0.419}},
   "backdrop": {"type": "bool", "default": true, "min": null, "max": null}
 },
 "beats": ["in", "zoom", "hl_0", "hl_1", "hl_2", "hl_3", "hl_4", "hl_5", "out"],
 "required_beats": ["hl_0"],
 "beat_tolerance_s": 0.1,
 "reading_speed_max_lines_per_s": 12.56,
 "duration_s": [3.0, 12.0],
 "zone": "hook",
 "zone_note": "a long-prompt walkthrough is mostly a body moment; proposal: also once in the body — lead decides"}
```
