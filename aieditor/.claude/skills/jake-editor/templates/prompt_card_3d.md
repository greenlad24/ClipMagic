# prompt_card_3d — usage (DRAFT)

> Note (lead, 2026-10-10): the word ids in the worked example are ILLUSTRATIVE (not from a real transcript); the narration lines are paraphrased from the job-131 script.

A frosted prompt card on a soft grey plate, seen by a moving 3D camera:
- The card whips in from a close, tilted view.
- The prompt types in, and the attached files fly in from beside the camera as icon tiles.
- The card grows a row at a time, and the tiles open into named pills.
- The prompt is sent: it becomes a right-aligned bubble with "Working" and a spinner.
- The camera pushes through the card at the cut.

Motion: `motion/templates/prompt_card_3d.kf.json`. Look: `prompt_card_3d.style.json` (neutral) or the app's UI kit.
Spec: `motion/reference-specs/prompt_card_3d.md`. The PROMPT → RESULT hook variant (MO05) is `templates/prompt_result.md`.

## 1. When to use
Use it when the narration **says what is typed into an AI app** (often with the files/images attached) and the
typing + "it's working" is the beat. The result itself either comes later or is not the point.
Real examples (job 131, ChatGPT Images 2.5):
- "I'll upload my rough sketch and type: **turn this rough sketch into a realistic photo — a glass squat hot sauce
  bottle on a weathered wooden picnic table**…": prompt + chip `sketch_bottle_scene.png`.
- "**Merge these three**: the person from the first photo, standing at the market stall from the second photo,
  holding the bottle from the third…": prompt + 3 image chips.
- The reference itself: "Run a Full Contract Negotiation Review on the attached counterparty paper…" + 5 documents.

**Prompt boxes must look like the real app** (Jake, 2026-10-09). Give `app` so the planner loads
`ui-kits/<app>/kit.json`. With no kit, the template draws the NEUTRAL card (the reference's generic composer), never
another app's UI.

## 2. When NOT to use
- The narration shows the result ("…and it gives you this"). Use **prompt_result** (MO05) with a REAL result.
- Click-by-click walkthroughs. Use a screencast.
- The prompt is not actually spoken or shown. Never invent a prompt: the text must be what the narration says is typed
  (or the exact prompt from the production notes).
- The prompt is longer than ~220 characters. Use long_prompt_scroll.
- Outside the hook zone (see 6).

## 3. Timing anchors (beats = word ids)
| beat | spoken word | what happens on it | default |
|---|---|---|---|
| `in` | the word that introduces the prompt ("type", "ask") | the card whips in (0.53 s, settled by +0.6 s) | overlay start |
| `type` | the **first spoken word of what is typed** | first character appears; placeholder fades 0.28 s before | in + 0.77 s |
| `chip_i` (optional) | the file's spoken name ("sketch", "first photo") | that file's tile appears (first frame) and lands 0.3 s later | typing end + 0.45 s, then +0.53/+0.2/+0.4/+0.4 s |
| `working` (alias `send`) | "and it…" / "hit enter" | the prompt becomes the sent bubble; "Working" | after the last pill opens |
| `out` (optional) | — | push-through exit (0.53 s) | duration − 0.53 s |

- Typing runs at the measured **71 chars/s** and must finish ≥ 0.25 s before `working`. If the spoken time is
  shorter, the rate is compressed up to **142 chars/s**. Never place `working` earlier than `type` + chars/142 + 0.25 s.
- Card growth is automatic: a row grows when its last chip lands, rows ≥ 0.72 s apart. Pills open ≥ 0.4 s apart.
- **Duration:** 3.5–10 s (reference 7.7 s). Hold ≥ 0.8 s after `working` before `out`.

## 4. Content limits
| field | limit |
|---|---|
| prompt | 8–220 chars. It wraps at 860 px (2–3 lines on the neutral card); a kit wraps per its own layout |
| chips | 0–6 files, name ≤ 40 chars (2-line wrap; "\n" forces the break), kind doc / pdf / xlsx / image / other (guessed from the extension) |
| state_label | ≤ 16 chars. The neutral default is "Working"; a kit uses its own working text unless given |
| greeting | ≤ 40 chars, kits with a greeting only (Claude: "Evening, Jake") |

## 5. Placement
- Full-frame plate. The card is centred (x 440–1474, y 420–690 at rest; it grows upward to ~620 px tall with 5
  chips), and the camera keeps it centred.
- The right end of the card (x 1474) stays left of the facecam bubble disc centre (1701.9, 253.7). With ≥ 3 chip rows
  and the push-in (s 1.33) the card's top-right corner can approach the disc's rim (it never reaches the centre). With
  the bubble on, prefer ≤ 4 chips.
- `backdrop: false` gives just the card on transparency (it then has no plate; kits use their page colour as the plate
  when `backdrop` is true).

## 6. Frequency / spacing
- **Hook only** (first 40 s), at most 1 per video (2 prompt templates per video in total). Keep ≥ 4 s from another
  motion template.
- It counts toward G7: 7–9 overlays, 3–5 in the first 80 s.
- As a plate it counts toward plates ≤ 1.5 % of runtime, so keep it 3.5–7 s in a 10-min video.

## 7. Parameters
| param | type | default | limits |
|---|---|---|---|
| prompt | string | — | 8–220 chars |
| chips | [{name, kind}] | [] | 0–6 |
| app | string (kit id) | null → neutral card | ui-kits/<app> |
| state_label | string | "Working" / kit's | ≤ 16 |
| placeholder | string | "Ask anything…" / kit's | ≤ 40 |
| greeting | string | null | ≤ 40 (kit greeting only) |
| tilt | {rx, ry, rz} deg | measured rest {0, 0.6, 0.55} | ±10 each |
| backdrop | bool | true | — |

## 8. Worked example
Narration (job 131, word ids from the transcript):
`w812 "so" w813 "I" w814 "just" w815 "upload" w816 "my" w817 "sketch" w818 "and" w819 "type" w820 "turn" w821 "this"
w822 "rough" w823 "sketch" … w845 "field" w846 "and" w847 "hit" w848 "enter"`

```json
{"template": "prompt_card_3d", "start": "w818", "end": "w852",
 "fields": {"prompt": "Turn this rough sketch into a realistic photo — a glass squat hot sauce bottle on a weathered wooden picnic table, warm late-afternoon light, shallow depth of field.",
            "chips": [{"name": "sketch_bottle_scene.png", "kind": "image"}], "app": "chatgpt"},
 "beats": {"in": "w818", "type": "w820", "chip_0": "w817", "working": "w847"}}
```
(A chip beat may fall during the typing; the tile then flies in while the text is still being typed.)

## 9. QA checks
- The prompt text is exactly what is spoken or typed (no paraphrase), and typing ends before `working`. The template
  compresses up to 2×; flag it if more is needed.
- The kit matches the app named in the narration. No kit → neutral card (never another app's UI).
- Chips are real file names from the production (no invented files).
- First char on the first spoken word (±1 frame); the sent bubble on `working` (±1 frame).
- The facecam disc centre is never covered. The card is inside the 5 % safe area at peak push (s 1.33).
- Total plate time stays within the budget, and it sits in the hook only.

```json
{"id": "prompt_card_3d",
 "params": {"prompt": {"type": "string", "default": null, "min": 8, "max": 220},
            "chips": {"type": "list", "default": [], "min": 0, "max": 6},
            "app": {"type": "string", "default": null},
            "state_label": {"type": "string", "default": "Working", "min": 1, "max": 16},
            "placeholder": {"type": "string", "default": null, "max": 40},
            "greeting": {"type": "string", "default": null, "max": 40},
            "tilt": {"type": "object", "default": null},
            "backdrop": {"type": "bool", "default": true}},
 "beats": ["in", "type", "chip_*?", "working", "out?"],
 "duration_s": [3.5, 10.0],
 "typing_cps": {"measured": 71, "min": 50, "max": 142},
 "zone": "hook"}
```
