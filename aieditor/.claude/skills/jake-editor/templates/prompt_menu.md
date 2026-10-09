# prompt_menu — usage (DRAFT)

A chat composer with its "/" (skills / commands) menu open above it. A mouse cursor glides in from the right and moves down the rows. Each row it reaches highlights, and the composer previews "/<row>" in grey. The cursor clicks the picked row: the composer commits "/<row>" in solid text, the menu shrinks away, and the composer re-centres. Then the cursor travels to the send button.
Motion: `motion/templates/prompt_menu.kf.json`. Look: `prompt_menu.style.json` (neutral) or the app's UI kit. Spec: `motion/reference-specs/prompt_menu.md`.

## 1. When to use
Use it when the narration **picks one named command, skill, tool or mode from an app's menu** and the pick itself is the point: "you just type slash and pick X". Real examples from tutorial narration (job 131, ChatGPT Images 2.5):
- "Try typing a **forward slash** and **pick the background skill**. So you could just type forward slash **new BG**…": rows `add_object`, `newbg`, …, with the pick on "background".
- "Same idea with forward slash **add object**": the same menu with the pick on "add" (a second use, so normally only one of the two gets the overlay).
- "You can click Sketch on the image toolbar, or you skip all that and type **@ Sketch** straight into the message box": trigger "@", pick "Sketch".
- The reference itself: a "Skills" menu, with the pick on "Email Draft Skill".

**Prompt boxes must look like the real app** (Jake, 2026-10-09). Give `app` so the planner loads `ui-kits/<app>/kit.json`. With no kit, the template draws the NEUTRAL box (the reference's generic composer), never another app's UI.

## 2. When NOT to use
- The pick needs a real result next to it. Use prompt_card_3d / prompt → result (MO05) instead.
- The narration is a click-by-click walkthrough of the app. Use a screencast; this graphic is a hook-zone stylisation.
- No row is named as spoken. A menu with nothing picked is just decoration.
- More than 8 options are named, or the options are full sentences.
- Outside the hook zone (see 6).

## 3. Timing anchors
- **start**: the word that introduces the menu (e.g. "forward"). The overlay starts at that word's start − 0.2 s lead.
- **`in`** (default = the lead, 0.2 s): the composer and the open menu cut in, fully drawn (the reference has no entrance).
- The cursor fades in over 0.25 s while moving in from the right. It starts 0.45 s before the first hover.
- **`hover_i`** (optional, i = 0…pick): the row highlight and the composer preview switch exactly on this word. The cursor's hop into the row starts 0.11 s earlier and takes 0.18–0.24 s (linear). Missing hovers are spread evenly between `in` + 0.767 s and `pick` − 0.472 s (measured mean spacing 0.717 s, min 0.3 s).
- **`pick`** (required, normally found automatically on the picked row's first spoken word): the click. On this frame the text commits. The group then pans 191.5 px (×scale) up in 0.267 s, linear. The menu shrinks 1 → 0.88 about its bottom centre and is gone at +0.145 s. There is no press effect.
- **`out`** (optional, default pick + 0.361 s, ≥ pick + 0.267 s): the cursor starts toward the send button. It arrives about 0.62 s later.
- **exit**: a hard cut at the overlay end. The reference ends 0.667 s after `out`, with the cursor just landing on send.
- **duration**: min 2.3 s, max 8 s (reference 5.15 s). With pick = row 4 and the measured spacing, in → pick ≈ 4.1 s.

## 4. Content limits
| field | limit |
|---|---|
| items | 3–8 rows. Labels ≤ 40 chars; longer ones are ellipsised. The menu widens to the longest label, up to composer width − 63 px |
| pick | index into items (0-based). The cursor visits rows 0…pick in order, so a pick deep in a long list needs ≥ 0.3 s per row before it |
| trigger | 1–2 chars, "/" (or "@") |
| menu_title | ≤ 20 chars |
| after_label / footer_label | ≤ 20 chars each (neutral box only; a kit draws its own) |

Icons are generic glyph names drawn as small flat inline SVGs: mic, cabinet, search, rocket, mail, doc, chart, calendar, bolt, star, code, chat, image, video, gear, user, folder, check, pen, globe, idea, book, megaphone, target, sparkles, money, link, lock, robot, home, trophy, clipboard, tag, database, music, phone, cart, brain. Common aliases and the matching emoji characters map to the same glyphs. An item can also give inline `<svg>`, or "none". No emoji font is shipped. With a kit, a row whose label matches a kit menu item uses that item's real icon (and description).

## 5. Placement
- Neutral layout, 5 rows: the composer is 1232 × 385 px centred at x 958.5. The menu (933 px wide) sits above it, overlapping the composer's top by 111.5 px. The whole group (y 125–953) is centred vertically. After the collapse, the composer centre sits at y 569.5 (frame centre + 0.0766 × composer h).
- 6+ rows: the group scales down to fit 90 % of the frame height (7 rows → 0.97, 8 rows → 0.90).
- Facecam bubble disc (centre (1701.9, 253.7), r 179.3 px): the menu's right edge (x 1307) and the composer's right edge (x 1575) are left of the disc centre. After the pan, the composer's rounded top-right corner (x ≤ 1575, y ≥ 376) can touch the disc's lower-left rim by a few px, but never its centre.
- With `backdrop: true` (default) the clip is a full-frame **plate** (#F5F5F2, or the kit's page colour). With `backdrop: false` it is a floating card with its own shadows.
- Kits: the kit's composer is scaled to the reference composer width (1232 px; ChatGPT 768 → ×1.604, Claude 727 → ×1.695). The kit's own menu anchor applies: ChatGPT's "+" menu opens below and tucks behind the composer on collapse. A kit with no captured menu gets a plain menu drawn only from the kit's tokens (flagged in the job log).

## 6. Frequency / spacing
- **Hook only** (first 40 s, Jake's prompt-box ruling), at most once per video.
- It counts toward overlay budget G7: 7–9 overlays total, 3–5 in the first 80 s.
- As a plate it counts toward plates ≤ 1.5 % of runtime (a 10-min video has ≤ 9 s of plates), so keep it at 2.5–5 s.
- Keep ≥ 8 s from any other full-frame plate or prompt template.

## 7. Parameters
| param | type | default | limits |
|---|---|---|---|
| items | [{label, icon?, desc?}] or [string] | — (required) | 3–8 rows, label ≤ 40 chars |
| pick | int | 0 | 0 … len(items) − 1 |
| app | string | null | a kit id under ui-kits/ (null = neutral box) |
| trigger | string | "/" | 1–2 chars |
| menu_title | string | "Skills" | ≤ 20 chars |
| placeholder_prefix | string | "/" | 0–2 chars |
| after_label | string | "Add context" | ≤ 20 chars ("" hides the chip) |
| footer_label | string | "All sources" | ≤ 20 chars |
| backdrop | bool | true | — |
| cursor | bool | true | false = rows still highlight on their beats, but no cursor |
| greeting | string \| false | kit default | kits with a greeting only (Claude: "Evening, Jake"); revealed by the collapse |

Beats: `in`, `hover_0` … `hover_7` (optional), `pick` (required), `out` (optional).

## 8. Worked example
Narration (job 131 words.json; the "/" skills aside at 712 s, so this is the shape of a good fit, not a hook placement):

```
2130 forward 712.66 | 2131 slash 713.00 | 2132 and 713.34 | 2133 pick 713.78 | 2134 the 714.08
2135 background 714.24 | 2136 skill. 714.64 | 2137 So, 715.12 | 2138 you 715.56
```

ChatGPT's "/" skills menu: the cursor lands on `add_object` then `newbg`, and clicks `newbg` on "background". The overlay ends on "So,", 0.9 s after the click.

```json
{"template": "prompt_menu", "start": 2130, "end": 2137,
 "fields": {"app": "chatgpt",
            "items": [{"label": "add_object", "icon": "image"}, {"label": "newbg", "icon": "image"},
                      {"label": "Template Creator", "icon": "doc"}],
            "pick": 1, "trigger": "/", "menu_title": "Skills"},
 "beats": {"in": 2131, "hover_0": 2133, "pick": 2135, "out": 2136}}
```

Timeline (clip seconds, t0 = 712.46): in 0.54 → cursor fades in from 0.87 → hover_0 1.32 → hover_1 (auto) 1.47 → pick 1.78 → out 2.18 → end 2.96. `hover_1` falls back to pick − 0.472 = 1.31 and is pushed to ≥ 0.15 s after hover_0. A hop always starts from wherever the cursor is, so tightly packed beats never make it jump. Tight, but legal; give hover_1 its own word if the narration names it.

## 9. QA checks
- Each row highlight and the composer preview switch on its hover beat, within ±1 frame. The commit and the collapse start on `pick`, within ±1 frame.
- The cursor never jumps: it is continuous from the entry to the send button, and its tip rests inside the hovered row band.
- The picked label in the committed composer is identical to the spoken command (`newbg`, not "New BG").
- The kit is the app the narration is in. With no kit the box is neutral, never another app's UI.
- The menu is fully gone by pick + 0.16 s. Nothing is drawn before `in` or after the overlay end.
- The plate is within the hook zone and the plate budget, and is never placed under the facecam bubble centre.

```json
{"id": "prompt_menu",
 "params": {
   "items": {"type": "array", "default": null, "min": 3, "max": 8, "item_max_chars": 40, "item": {"label": "string", "icon": "string?", "desc": "string?"}},
   "pick": {"type": "int", "default": 0, "min": 0, "max": 7},
   "app": {"type": "string", "default": null, "min": null, "max": null},
   "trigger": {"type": "string", "default": "/", "min": 1, "max": 2, "unit": "chars"},
   "menu_title": {"type": "string", "default": "Skills", "min": 0, "max": 20, "unit": "chars"},
   "placeholder_prefix": {"type": "string", "default": "/", "min": 0, "max": 2, "unit": "chars"},
   "after_label": {"type": "string", "default": "Add context", "min": 0, "max": 20, "unit": "chars"},
   "footer_label": {"type": "string", "default": "All sources", "min": 0, "max": 20, "unit": "chars"},
   "backdrop": {"type": "bool", "default": true, "min": null, "max": null},
   "cursor": {"type": "bool", "default": true, "min": null, "max": null},
   "greeting": {"type": "string", "default": null, "min": 0, "max": 32, "unit": "chars"}
 },
 "beats": ["in", "hover_0", "hover_1", "hover_2", "hover_3", "hover_4", "hover_5", "hover_6", "hover_7", "pick", "out"],
 "required_beats": ["pick"],
 "duration_s": [2.3, 8.0],
 "zone": "hook"}
```
