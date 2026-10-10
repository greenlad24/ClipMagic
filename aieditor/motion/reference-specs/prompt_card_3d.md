# prompt_card_3d — 3D prompt card (MO04) + result stage (MO05)

Reference: `/opt/aieditor-work/reference/motion-2026-10-09/motion4.mp4` (1920×1080, 30 fps, 232 f, 7.72 s).
Template: `aieditor/motion/templates/prompt_card_3d.{js,kf.json,style.json}`. Machine-readable spec: `prompt_card_3d.json`.
Compare sheet: `prompt_card_3d-compare.png` (16 timestamps, reference | ours, send-button error per row).

## How it was measured
- **Card pose per frame.** The composer footer (`+`, tool, Create, Pro, send) never changes, so the card plane was
  tracked with an ECC homography against frame f60, rectified to a 1034×270 rectangle (the "canonical" card).
  f101–f231 were re-tracked with an affine refinement on the right half of the footer, because flying chips hide
  the left half (correlation 0.98–0.996). Each homography was then fitted to a CSS 3D pose (Gauss-Newton):
  `perspective 1000px` (origin 960,540), transform-origin = card centre (957,555), `translate · rotateX · rotateY ·
  rotateZ · scale`. The fit error is flat between 450 and 1700 px of perspective (5.9–7.0 px max), so 1000 was chosen.
  Fitting only the footer leaves rx noisy (±3°); ry and rz are stable.
- **Card height.** Measured from the top-rim edge in the rectified frames.
- **Typing.** The caret x was mapped to Inter glyph advances (Inter 400, 30 px, +0.029 em reproduces the 771 px first line).
- **Easings.** Cubic-bezier grid fits; the max error is in kf.json.

## Elements and layers
1. **Backdrop.** A static grey plate with soft diagonal light streaks. It does not move: the measured shift is 0 px from
   f12 to f222. It is stored as a 96×54 PNG in style.json (mean error 0.76/255 against the reference), plus `#d3d0d4`.
2. **Card.** 1034×270 px at rest, radius 40. Glass fill: left `#cecbcf` (≈ the plate), right `#f2edec` (a light sheen).
   It has a dark 2.6 px top/left rim fading to the right, a white inner highlight at the bottom/right, and a soft
   drop shadow.
3. **Composer.** The prompt is Inter 400, 30 px (0.0278 H), tracking 0.029 em, line height 39, colour `#2e2b2e`, and
   wraps at 860 px. The footer row is 71 px circles (pitch 82), a Create pill 189×67, "Pro ⌄" at 29 px in `#8d898c`,
   and a 68 px brown send button (`#6e5038`→`#4d3524`). The send icon is a mic until text is typed, then an arrow.
4. **Chips.** Pills are 408×75 with radius 18, in 2 columns (gap 21) on a 93 px row pitch, inset 44/25. Each has a
   34×44 doc icon (W/PDF/X) and a 26 px label that wraps to 2 lines.
5. **Working state.** A right-aligned bubble (max 716 px, 26 px type, `rgba(40,30,35,.065)`, radius 16) with a 38 px
   avatar, then a 6-dot spinner + "Working" (31 px, `#7a777a`).
6. **Exit.** A screen-space push-through: zoom about the card centre plus zoom blur.

## Timeline (reference, seconds = (frame−1)/30)
| t | frame | event |
|---|---|---|
| 0.033–0.53 | f2–f17 | **entrance**: whip-in from a close, tilted view (s≈3, rx 30°, ry −10°, rz 12° → rest); send-button displacement decays ×0.74/frame; ease `[0.2,0.8,0.5,1]` (max err 0.015) |
| 0.467–0.80 | f15–f25 | placeholder fades per character, left→right (stagger 1 frame, 0.133 s each), starting 0.283 s before `type` |
| 0.767–2.27 | f24–f69 | **typing**: 110 chars in 1.55 s = **71 chars/s** (2.56/frame), unchunked, last ~8 chars slower; ease `[0.9,0.9,0.7,0.9]` (0.015) |
| 0.77–2.77 | f24–f83 | caret 2×33 px, no blink; gone 0.47 s after the last char |
| 2.10–3.70 | f64–f112 | camera **push-in** s 1.0 → 1.327, ease `[0.5,0.3,0.1,0.6]` (0.037) |
| 2.77 / 3.30 / 3.50 / 3.90 / 4.30 | f84/f100/f106/f118/f130 | **chip tiles fly in** (first visible frame) from beside or below the camera: ×2.6–3.3 size, tilted, 0.3 s each, ease-in-out `[0.55,0,0.25,1]` (hand-fitted; tiles are blurred and occluded) |
| 3.47 / 4.20 / 4.90 | f105 / f127 / f148 | **card grows a row**: +70 / +95 / +97 px, 0.35 s, ease `[0.2,0.1,0,0.8]` (0.032). A row grows when its last chip lands, and rows are ≥ 0.72 s apart |
| 3.90 … 5.50 | f118 … f166 | tile → pill with the name wiping in left→right, 12 frames apart, ~14 frames each |
| 4.17–6.57 | f126–f198 | camera **pull-back** s 1.327 → 0.989, ease `[0.5,0.1,0.1,0.9]` (0.02). The camera keeps the growing card centred (ty += s·ΔH/2) |
| 5.93–6.23 | f179–f188 | **working**: card +98 px; the prompt moves into the bubble (30 → 26 px); avatar; "Working" + spinner fade in |
| 7.167–7.70 | f216–f232 | **exit**: s +2.0 accelerating, ease `[1,0,0.6,0.6]` (0.002), zoom blur; cut at f232 |

## Per-frame pose samples (CSS: px, deg)
See `pose_samples` in the JSON. Key values:
- f9: s 1.30, rx 27.6.
- f30: s 1.03.
- f60: s 1.00, ry 0.77, rz 0.51.
- f105: s 1.30.
- f125: s 1.327 (peak), ty +43.
- f160: s 1.07, ty +129.
- f200: s 0.99, ty +177.
- f224: s 1.16.

## Verification (send-button centre, reference vs ours, px at 1080p)
| f | 10 | 24 | 45 | 70 | 85 | 100 | 108 | 122 | 128 | 150 | 170 | 182 | 190 | 205 | 224 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| err | 49 | 19 | 3 | 1 | 10 | 12 | 9 | 7 | 13 | 4 | 4 | 14 | 8 | 11 | 13 |

How to read this:
- Settled and typing: 1–3 px.
- Chips, push and pull: 4–13 px.
- Working and hold: 8–14 px. The residual is a ~5 px x-offset and ~1 frame of card-growth phase.
- Entrance: 49 px at f10. The start pose is extrapolated from motion-blurred frames.

Timing matches within 1 frame for every beat:
- typing start f24 and end f69;
- chip first-visible frames;
- row growth f105/f127/f148;
- working f179;
- exit f216.

Opacity: chips are opaque from their first frame, as in the reference. The placeholder fade and caret visibility match by eye.

## Generalisation (what changes with the content)
- **Prompt.** Up to ~220 chars. It wraps at 860 px, with a minimum of 2 lines; a third line grows the card.
- **Typing speed.** The rate is the measured 71 chars/s. When `working` comes too early, the rate is compressed up to
  **142 chars/s (2×)**. Typing always ends ≥ 0.25 s before `working`. The allowed range is 50–142 chars/s.
- **Chips.** 0–6 of them. The rows (2 per row) and their growth events come from the real layout. With no chips there
  is no growth, and the push still plays.
- **Kits.**
  - The composer is the app's own HTML at natural size, scaled to the 1034 px card width. The box fill and radius are
    read from the kit.
  - The app reflows live as you type and attach. Each attachment's room eases open on the measured growth curve.
  - After send, a kit shows the app's own thread above the emptied composer (the kit's user bubble + working text).
    The neutral box keeps the reference's in-card bubble.
  - A kit without a chip spec (Claude) gets the reference's chip grid above its text, re-coloured for dark.
  - An optional `greeting` above the composer is supported (Claude's "Evening, Jake").
- **MO05 result (new, not in the reference).**
  - On `result`, the app's REAL result view is placed as a panel above the card. That is the kit's `result.image` or
    `result.text`, preceded by the kit's user bubble; with no kit it is the neutral glass card.
  - The camera pans up / pulls back to fit it within 84 % of the frame height. This reuses the measured entrance ease
    `[0.2,0.8,0.5,1]` over 0.6 s, with a 9° rx tilt bump. The thread's "Working" fades out.
  - There is no result stage when `params.result` is absent, or when the kit has no result view (Claude's kit).

## Fonts
Inter (already in motion/fonts). No font was added.

## Revisions 2026-10-10 (Jake's preview review)
- **File upload, re-measured.** Measured on rectified motion4 frames f84–f166.
  - A tile flies in, then lands where its slot WILL be, but lower by the rooms that have not opened yet (its own row
    and every row below). So it first lies over the text or footer, at ~0.8 of the pill height (a ~60 px glass square).
  - It rises into its slot as its row opens (+70 / +95 / +97 px, 0.35 s).
  - Then the pill (fill, border and name together) wipes open to the right behind a ~40 px soft edge, in 0.47 s,
    12 frames apart.
  - Kits with their own attachment UI (ChatGPT) reflow live instead: each attachment's room eases open on the same
    curve.
- **`end_on_click`** (default on for the Claude kit; available for every look):
  - There is no "working" state and no messages above the card.
  - prompt_menu's cursor sprite and its measured entry glide land on the send button on the `click` beat. The glide
    is 0.63 s with an alpha fade-in; the landing point is the send centre + (0.116, 0.128) × the button diameter; there
    is no press feedback, as measured in prompt_menu.
  - The clip holds 0.5 s after the click and cuts.
- **ChatGPT.** Re-rendered on the kit's fixed footer (8 px padded grid). The card height is the kit's rendered content
  box (a `display:flow-root` root, so the margins no longer collapse). The file tile is restored above the text.
- **MO05 in Claude's conversation view** (`kit.message`).
  - The card sinks (×0.82, +140 px) and fades in 0.3 s.
  - The view comes in over 0.6 s (ease [0.2,0.8,0.5,1], tilt 9°→0, scale 0.94→1).
  - The REAL reply's markdown blocks fade in top-down (0.06 s stagger), then the column scrolls at 70 css px/s
    after 1.8 s.
  - Artifacts: an artifact card in the chat column, plus the artifact panel (Preview/Code tabs) sliding in from the
    right with the generated HTML rendered in a sandboxed iframe. The markdown and artifact styling are built from
    Claude's tokens, so verify them against the live app.
- **Font added:** Noto Color Emoji (OFL, google/fonts), so emoji in real replies render (e.g. 🌶️ in the writing reply).
