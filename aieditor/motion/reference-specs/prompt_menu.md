# prompt_menu (MO03) — measured spec

Reference: `/opt/aieditor-work/reference/motion-2026-10-09/motion3.mp4`. 1920×1080, 60 fps, 309 frames, 5.15 s.
It is a **30 fps screen recording doubled to 60 fps**, so every motion sample is held for 2 frames, with samples on odd 0-based frames. kf `quantize_fps: 30` reproduces this; set it to null for smooth 60 fps motion.
Data: `prompt_menu.json` (same folder). Motion: `motion/templates/prompt_menu.kf.json`. Look: `prompt_menu.style.json`. Code: `prompt_menu.js`.

## Elements / layers (back → front)
1. Backdrop #F5F5F2, full frame.
2. Group (pans as one):
   - **Composer card**: 1232×385 at (342.5, 568.5), radius 44, white.
     Shadow: `0 0 0 1px rgba(0,0,0,.06), 0 10px 24px rgba(0,0,0,.10), 0 30px 90px rgba(0,0,0,.075)` (fitted to the below/right luminance profiles within about 4 levels).
   - **Menu card**: 933×555 at (374, 125), radius 28, white. It overlaps the composer top by 111.5 px.
     Shadow: `0 0 0 1px rgba(0,0,0,.035), 0 6px 18px rgba(0,0,0,.085), 0 16px 50px rgba(0,0,0,.08)`.
3. Menu content:
   - Header "Skills": ink at menu +33/+45, Inter 600 37 px (0.034 H), #7A7A7A.
   - Header icons: a library icon 37×32 at right −141 and a plus 29×30 at right −67 (#888, stroke 3.6/4.2).
   - Rows: highlight band 78 px tall, inset 24/21 px, #F4F4F4, radius 12. The first band top is at menu +123, pitch 85.
   - Row content: a flat inline-SVG icon (drawn at 58 px; reference emoji ink ≈ 52 px; centre at menu +60) and the label (ink left at menu +113), Inter 500 43 px (0.0398 H), tracking −0.007 em, #1A1A1A.
4. Composer content:
   - "@ Add context" chip: (31.5, 34), h 69, radius 34.5, border 2 px #E6E6E6, Inter 35 px (+0.08 em) #7E7E7E. It sits under the menu until the collapse.
   - "/" + label: ink at (43.5, 152.5), 43 px. Slash #4A4A4A. Preview #A3A3A3. Committed #111.
   - Footer: paperclip and globe (#454545), "All sources" Inter 500 43 px #262626, and a send button d 86 #3087D9 with a white arrow, centred 75.5/75 px from the composer's right/bottom.
5. Cursor: macOS arrow, black core 64×104 px (0.096 H), white outline about 5 px, soft drop shadow. The tip is the hotspot. It is screen space and does **not** pan with the group.

## Timeline (reference beats; seconds from clip start)
| t | event |
|---|---|
| 0.000 | `in`: menu + composer fully on screen (hard cut, no entrance). The composer shows "/" |
| 0.317 → 0.583 | cursor fades in (alpha 0 → 1, linear 0.25 s) while moving left from (1436, 318) |
| 0.767 | `hover_0`: row 0 highlights and the composer previews "/ Messaging House Skill" (grey), same frame |
| 0.950 | cursor rests at (1108, 280). The entry path dips 8 px, then rises 46 px. Peak about 880 px/s; it arrives 0.183 s after the hover |
| 1.396 / 2.046 / 2.717 / 3.517 | hops into rows 1–4 start. Linear, 0.199 / 0.178 / 0.195 / 0.241 s. Rests at (1145, 373), (1208, 439), (1208, 535), (1208, 631) |
| 1.506 / 2.156 / 2.827 / 3.627 | `hover_1..4`: highlight + preview switch, always **0.11 s after the hop start** |
| 4.122 | `pick` (click): the label commits grey → #111. No press effect on the cursor or the row |
| 4.122 → 4.389 | the group pans up 191.5 px, **linear** (720 px/s). The composer centre ends at frame centre + 29.5 px (0.0766 × composer h) |
| 4.122 → 4.282 | the menu shrinks 1 → 0.88 about its bottom centre, linear. It is removed without a fade at +0.145 s (opaque at +0.128, gone at +0.161) |
| 4.483 | `out`: the cursor starts toward send. It eases in, then about 560 px/s with a slight downward arc (y overshoots 17 px), ending at the send centre + (10, 11) px after about 0.62 s |
| 5.150 | hard cut (the clip end) |

Dwell per row: 0.467 / 0.467 / 0.5 / 0.633 s, then 0.339 s on the picked row before the click. Hover spacing is 0.739 / 0.65 / 0.671 / 0.8 s (mean 0.717 s). The pick comes 0.472 s after the last hover.
Easing fits (`fit2`/`fit5`, scratch `pm/`): the hops are linear (max 1.2 px; the best cubic in-out was 2.9 px or worse). The pan is linear (≤ 3 px). The menu scale is linear (≤ 2 px on the width). The entry and send paths are measured tables (per-sample), since a single quadratic Bézier path missed the S-shaped entry by more than 4 px.

## Typography
| text | font (closest free) | weight | px @1080 | frac H | colour |
|---|---|---|---|---|---|
| rows, composer text, footer | Inter (≈ SF Pro) | 500 | 43 | 0.0398 | #1A1A1A / #111 / #262626 |
| menu title | Inter | 600 | 37 | 0.0343 | #7A7A7A |
| chip | Inter | 400 (+0.08 em) | 35 | 0.0324 | #7E7E7E |
| icons | flat inline SVG glyphs (no emoji font shipped; the reference uses Apple colour emoji) | — | 58 box / ≈ 50 ink | 0.054 | per glyph |
Ink widths match within 1–2 % and ink tops within ±3 px. Inter at 400 was 26 % lighter in ink mass than the SF in the video, so the template uses 500.

## Verification (render = reference content + reference beats, neutral look)
Compare sheet: `prompt_menu-compare.png` (reference | ours | diff×3 at frames 0, 40, 47, 91, 131, 171, 219, 249, 253, 257, 265, 290, 308).

| element | position error | timing error |
|---|---|---|
| cursor tip (all 309 frames) | max 2.2 px, mean 1.2 px | 0 frames (appears 2 frames "earlier" only because the reference's alpha < 0.9 is under the detector threshold) |
| hover switches ×5 | band 0 / 4 / 8 / 4 / 0 px (uniform 85 px pitch vs the reference's uneven 81/81/89/89) | 0 / 0 / 0 / 0 / 0 frames |
| composer top incl. pan | max 3 px, mean 1.5 px | start 0, end +2 frames (last 1 px of travel) |
| menu top / width incl. shrink | ≤ 1 / ≤ 2 px | removal 0 frames |
| text commit, send-hop start | — | 0 frames |
| row text ink boxes | ≤ 3 px (widths within 1 %) | — |
| row icon ink boxes (SVG glyph vs Apple emoji) | ≤ 6 px per edge; the drawing differs (flat glyph, not an emoji) | — |

General example (`prompt_menu-general.png`): 7 rows, pick 5, title "Commands", a 40-char label, beats in 0.2 / pick 4.6, with the hovers spread automatically (0.632 s apart).

## Kits
- `kit: null` gives the neutral box above.
- With a kit, the kit's composer html is scaled to 1232 px wide. Its menu (`menu.html`/`item_html`, real items' icons and descriptions matched by label, `hover_class`) uses the kit's `anchor`/`gap`/`offset_x`. A `below` menu tucks behind the composer on the collapse. The pick commits as the kit's chip (pill) if it has one, otherwise as `trigger+label` in the prompt.
- A kit with **no** captured menu (Claude, today) gets a plain menu built only from the kit's own tokens. This is flagged as derived, not captured.
- A kit with a `greeting` (Claude: "Evening, Jake") draws it at its captured baseline above the composer. Under an "above" menu it stays covered until the collapse reveals it, the same way the reference's "Add context" chip is revealed. `params.greeting` = a string overrides it, false hides it.
- The motion is identical in every case.
- Preview renders: `motion-preview/prompt_menu/prompt_menu-chatgpt-dark.mp4` and `-claude-dark.mp4`.

## Variations (2026-10-10)
`motion/templates/prompt_menu.presets.json` holds 9 presets: type-prompt, skill, create-image, web-search, deep-research, app-pill, attach-file, slash-command and model-switch. The usage md (section 10) lists them.
New params:
- `menu`: false = composer only.
- `menu_source`: menu, slash_menu or model_picker.
- `items: "kit"`: use the app's real rows.
- `prompt`: typed after the pick.
- `chip`: how the pick shows in the composer (tool / image / file / indicator / none).
- `preview`.
- Beat `type`.

The motion is unchanged. The typing is motion4's MEASURED typing: 71 cps, ease (0.9, 0.9, 0.7, 0.9), solid caret gone 0.47 s after the last char; source prompt_card_3d.kf.json. With `menu: false` the measured entry glide lands on send at `out`.
Regression: the reference render is identical (cursor ≤ 2.2 px, every beat 0 frames).
