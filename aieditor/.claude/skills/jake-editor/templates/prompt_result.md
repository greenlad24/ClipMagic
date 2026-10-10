# prompt_result — PROMPT → RESULT in the hook (MO05) — usage (DRAFT)

> Note (lead, 2026-10-10): the word ids in the worked example are ILLUSTRATIVE (not from a real transcript); the narration lines are paraphrased from the job-131 script.

The prompt_card_3d motion (template `prompt_card_3d`) plus a result stage:
- The prompt types into the app's real composer (UI kit), files fly in, and it is sent.
- Then, on the beat **result**, the camera pans up / pulls back (the measured entrance ease `[0.2,0.8,0.5,1]`, 0.6 s,
  with a 9° tilt bump) to the app's **REAL result** in the app's own result view (kit `result.image` / `result.text`,
  under the kit's user bubble).
- The push-through exit follows.

Jake, 2026-10-09: "when the narration says 'you just type one sentence in plain English and it…' it can use the same
motion design language to show the result instead of plain boring screencast". This applies **in the hook only**.

Scene: `template: "prompt_card_3d"`, `variant: "prompt_result"`, `params.result = {kind: "image", src: <data URI>,
alt}` or `{kind: "text", text}` (built by `motiontemplates.result_view` from a produced `app_generation` asset).
Preview: `motion-preview/prompt_card_3d/prompt_card_3d-prompt-to-result-chatgpt.mp4` (ChatGPT kit +
`video131/preprod/assets/gen_sketch_photo.png`).

## 1. When to use
- The line matches `PROMPT_RESULT_RE`: "you just type one sentence in plain English and it…", "just describe it and it
  builds…", "type one line and it gives you…".
- There is a **REAL result** made off camera in that app, from that prompt: a produced `app_generation` asset with its
  file on disk.
- The app has a UI kit **with a result view**. Today that is ChatGPT (`result.image`, `result.text`, `result.user`).

Examples (job 131):
- "You just type one sentence in plain English, **and it** turns your sketch into a real photo": prompt = the exact
  prompt used for `gen_sketch_photo.png`, chip `sketch_bottle_scene.png`, result = that PNG.
- "Describe the background you want **and it** swaps it": only if the background-swap result was generated.

## 2. When NOT to use (refuse → screencast)
- **There is no real result asset.** Never invent, mock or "illustrate" a result. The template only shows
  `params.result`, and Python refuses the template without a produced asset.
- **The kit has no result view for that kind.** Claude: image results are not possible (no image result view); TEXT and
  ARTIFACT results are shown in Claude's conversation view (see "Claude variations" below).
- The result needs a walkthrough (multi-step edits, settings). Use a screencast.
- After 40 s (body). Screencasts stay the default there.
- The prompt shown would differ from the prompt that produced the asset.

## 3. Timing anchors (beats = word ids)
| beat | spoken word | on it | default |
|---|---|---|---|
| `in` | "just" / "type" | card whips in | overlay start |
| `type` | first word of the typed prompt | first character | in + 0.77 s |
| `chip_i` (opt.) | the file's spoken name | tile appears, lands in 0.3 s | typing end + 0.45 s |
| `working` | "and" / "it" | prompt sent: app's bubble + working text (ChatGPT: "Creating image") | — (required) |
| `result` | the verb that names the result ("turns", "gives", "builds") | pan / pull to the result panel (0.6 s) | working + 1.2 s |
| `out` (opt.) | — | push-through exit (0.53 s) | duration − 0.53 s |

- Typing: 71 chars/s (compressed up to 142 chars/s) and it must end ≥ 0.25 s before `working`.
- Keep ≥ 0.8 s between `working` and `result` so "working" reads. Hold the result ≥ 1.5 s before `out`.
- Duration: 4.5–12 s.

## 4. Content limits
- **prompt**: 8–220 chars, exactly the prompt that made the asset.
- **chips**: 0–6 real input files.
- **result**:
  - image: any aspect. The panel is scaled to ≤ 84 % of the frame height. The ChatGPT kit shows it 480 px wide in its
    768 column (646 px on screen).
  - text: ≤ 1200 chars, of which only what fits the panel is legible. Prefer ≤ 400 chars.

## 5. Placement
- The full-frame plate is the kit's page colour (ChatGPT `#000`) with the reference's grey-streak plate mixed in
  softly (soft-light, 10 %).
- The result panel sits above the composer, centred by the camera.
- A square image ends at ~760×890 px on screen and stays left of the facecam disc centre (1701.9, 253.7).
- `backdrop: false` is possible but not recommended for MO05.

## 6. Frequency / spacing
- At most **1 per video**, hook only (first 40 s). It replaces the screencast of that moment and does not add to it.
- Counts as a plate and toward G7 (7–9 overlays, 3–5 in the first 80 s). Plates ≤ 1.5 % of runtime.

## 7. Parameters
| param | type | default | limits |
|---|---|---|---|
| prompt | string | — | 8–220, the real prompt |
| app | string | — (required; kit with result view) | chatgpt today |
| result_asset | asset id | the produced app_generation asset | must exist on disk |
| chips | [{name, kind}] | [] | 0–6, real inputs |
| state_label | string | kit working text | ≤ 16 |
| backdrop | bool | true | — |

## 8. Worked example
`w901 "you" w902 "just" w903 "type" w904 "one" w905 "sentence" w906 "in" w907 "plain" w908 "English" w909 "and" w910 "it"
w911 "turns" w912 "your" w913 "sketch" w914 "into" w915 "a" w916 "real" w917 "photo"`

```json
{"template": "prompt_result", "start": "w901", "end": "w930",
 "fields": {"prompt": "Turn this rough sketch into a realistic photo — a glass squat hot sauce bottle on a weathered wooden picnic table, warm late-afternoon light, shallow depth of field.",
            "chips": [{"name": "sketch_bottle_scene.png", "kind": "image"}], "app": "chatgpt", "result_asset": "gen_sketch_photo"},
 "beats": {"in": "w902", "type": "w903", "working": "w909", "result": "w911"}}
```
Note: the spoken words here are not the typed prompt, so `type` hangs off "type". The typed text is the real prompt
and runs at up to 142 chars/s to finish before "and". If 170 chars cannot fit (it needs ≥ 1.45 s), move `working`
later or shorten nothing (never paraphrase the real prompt); fall back to a screencast.

## Claude variations (Jake 2026-10-10: "make different variations of what you can do in Claude")
Claude's kit has no image result view, but it has the **conversation view** (`kit.message`): after the cursor clicks
send (end_on_click, Claude default), the card sinks toward the docked composer and the conversation view comes in (0.6 s,
measured result ease + tilt). The REAL reply then fades in block by block (0.06 s stagger) in Claude's serif, with
markdown rendered (headings, lists, bold, tables, code blocks), and scrolls at 70 css px/s after 1.8 s.
`params.result`:
- `{kind: "text", text: <the reply markdown, verbatim>}` → writing, code, file analysis, image understanding, report;
- `{kind: "artifact", html: <the generated single-file HTML>, text: <the reply markdown>, title?}` → the reply with an
  artifact card in the chat column + Claude's artifact panel (Preview) rendering the REAL html (sandboxed iframe).
The markdown styling and the artifact panel are built from Claude's kit tokens — **verify against live**.
Inputs: attached files are chips (e.g. `orders.csv` for file analysis when the CSV is in the prompt; the photo for image
understanding); the typed text is the prompt's sentence(s) only — never type a pasted data block.
Source rule: the reply must be REAL Claude output (Anthropic API or the app), stored with its prompt (meta.json); never
written by hand, never paraphrased. Show only what fits, then scroll. Previews:
`motion-preview/prompt_card_3d/prompt_card_3d-claude-result-{artifact_app,writing,code,file_analysis,image_understanding,report}.mp4`.
Timing: `click` on "and" / "hit enter"; `result` = click + 0.35 s (or its own word); hold ≥ 3 s for text, ≥ 4 s for
artifacts/reports (the scroll needs time); duration 6–12 s.

## 9. QA checks
- `params.result.src` is the produced asset's file (byte-identical), and the prompt equals the asset's recorded prompt.
- The kit is the app that made the asset and has a `result` view.
- The result is fully on screen and sharp at the hold (no exit blur before `out`). It never overlaps the facecam disc
  centre.
- Working → result ≥ 0.8 s; result hold ≥ 1.5 s.
- Hook zone only, ≤ 1 per video.

```json
{"id": "prompt_result",
 "base": "prompt_card_3d",
 "params": {"prompt": {"type": "string", "default": null, "min": 8, "max": 220},
            "app": {"type": "string", "default": null},
            "result_asset": {"type": "string", "default": null},
            "chips": {"type": "list", "default": [], "min": 0, "max": 6},
            "state_label": {"type": "string", "default": null, "max": 16},
            "backdrop": {"type": "bool", "default": true}},
 "beats": ["in", "type", "chip_*?", "working|click", "result", "out?"],
 "duration_s": [4.5, 12.0],
 "kit": "required (with result view: ChatGPT image/text; Claude text/artifact via kit.message)",
 "zone": "hook"}
```
