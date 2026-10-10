# prompt_highlight (MO06) — measured spec

Reference: `/opt/aieditor-work/reference/motion-2026-10-09/motion5.mov`. It is 1920×1200, 60 fps, 8.617 s, 517 frames. It is a screen capture of a YouTube video (tutorial at 1:25 / 17:02) showing Claude.ai's dark new-chat page.
- **Ignored:** the YouTube player chrome (title bar, bottom controls and progress bar), the 60 px letterbox above and below, the mouse pointer, and the page's own hover toolbar.
- **Content area:** rows 60–1139 = 1920×1080, mapped 1:1 to the output, so every number below is in 1080p content px.
- **Source refresh:** the source updated at ≈ 24 fps inside the 60 fps capture, so values change every 2–3 frames. Fits use the first frame of each new value.
- **Privacy:** the reference greeting's first name is never reproduced. It is blurred in every reference image we output, and the replica shows "Evening, Jake".

Files: `motion/templates/prompt_highlight.{js,kf.json,style.json}`, kit `.claude/skills/jake-editor/ui-kits/claude/`, and the machine-readable summary `prompt_highlight.json`.

## Revisions (Jake, 2026-10-10, after the preview review)
- **Marker colour:** now **#FFD21E** (rgb 255, 210, 30) instead of the reference's lime #D9FD28. The text on it is #1A1400 (contrast 12.7:1). The measured motion is unchanged.
- **Suggestion chips:** the chips under the composer (Create / Write / …) are **off by default** (`params.suggestions`, default false). The kit keeps them as optional. The previews and the side-by-side therefore show no chips, while the reference does.
- **ChatGPT preview:** re-rendered after the ChatGPT kit footer fix.

## Elements and layers (back → front)
1. **Backdrop**: flat #20201D, full frame (`params.backdrop`; false = transparent).
2. **Camera** (one transform for everything): a pure scale about a fixed pivot. There is no rotation, no blur and no opacity change.
3. **Greeting**: the spark logo plus "Evening, <name>" in serif, centred above the composer. Its baseline sits 39.3 css px above the composer top. It is top-anchored and does not move when the composer grows.
4. **Composer**: a rounded box holding the prompt text, then a row with "+" on the left, the model label "Opus 5.5 High" with a chevron, and the orange send button on the right.
5. **Suggestion chips** below: Create / Write / Career chat / Claude's choice. They move down as the composer grows. Since 2026-10-10 they are off by default (`suggestions: false`).
6. **Caret**: a grey bar, visible only while typing.
7. **Marker highlights**: yellow rounded boxes over the key phrases. The text under a box is redrawn dark.

## Keyframes (seconds from clip start; 60 fps frame numbers in brackets, 1-based)
| element | keyframes | easing (fitted cubic-bezier) | fit error |
|---|---|---|---|
| camera push-in | scale 1 → **1.5486** about pivot **(931, 617)** = (0.4849 W, 0.5713 H); start **1.217 s** (f74.0), duration **0.742 s**, so it lands on the first sweep | **[0.609, 0.091, 0.417, 0.887]** | rms 0.0125, max 0.033 of travel (≈ ±1 frame) |
| typing | **30.6 chars/s** constant (segments 29.7 / 33.3 / 29.7). 260 chars already typed at t 0; ends at 426 chars at 5.42 s; one char at a time | linear | ±3 chars |
| text layout | laid out in full from the start: a word never jumps lines while being typed | — | — |
| composer growth (per new line) | +1 line pitch (43.5 px at the end view). Starts **0.352 s before** the first char of the new line, lasts **0.368 s** (f179.9–202 for line 5) | [0.489, 0.333, 0.63, 1.0] | max 0.068 |
| caret | ≈ 2 px wide, 32 px tall (end view), centred on the line box, 1.5 px right of the last glyph. Visible while typing; gone **0.13 s** after the last char (f334); no blink seen | — | — |
| sweep 0 "Put her face in the portrait panel" | 466 → 903 px on one line, 437 px wide (15.1 em): **1.959 s** (f118.6), 0.382 s | [0.531, 0.284, 0.425, 1.0] alone; joint ease below | max 0.018 |
| sweep 1 "crop the front … the neck down." | line 4: 956 → 1556 (600 px, 20.8 em) at **3.703 s**, 0.497 s; then line 5: 347 → 516 (169 px, 5.85 em) at 4.211 s, 0.151 s (gap 0.011 s) | [0.458, 0.121, 0.301, 1.0] | max 0.018 |
| sweep 2 "Plain grey background, soft even light, empty hands." | 516 → 1213 (697 px, 24.1 em) at **5.449 s** (f327.9), 0.493 s | [0.466, 0.112, 0.312, 1.0] | max 0.018 |
| all sweeps (template) | piece duration = clamp(width_em × **0.0256 s/em**, 0.10, **0.495** s); the next line piece starts 0.011 s after the previous ends | joint **[0.45, 0.126, 0.347, 1.0]** | rms 0.021, max 0.077 (sweep 0) |
| hold / exit | static from 5.94 s to the clip end 8.617 s (**2.68 s hold**). Hard cut, no exit animation | — | — |

**Highlight vs typing.** Each sweep starts **0.03–0.05 s after its phrase's last character** is typed. Sweep 0 waited 0.26 s for the push to land.

**Highlights accumulate and never merge.** Jake asked "at the end even the 'and' between two highlights gets joined — check". **Checked: it does not.** The "and" between highlight 0 and highlight 1 stays white on the dark composer in every frame from 300 to 517 (sheet `andz` in the scratch run). Highlights 1 and 2 touch on line 5 only because "down." and "Plain" are adjacent. There, a 1 px seam stays visible at x 516.

## Typography (closest free fonts)
| element | real | substitute (motion/fonts) | size | weight / tracking | colour |
|---|---|---|---|---|---|
| prompt | system sans (SF Pro on the reference Mac) | **Inter** (variable) | 16 css px = **28.9 px at the end view (0.0268 fh)**, 18.7 px at the start (0.0173 fh); line pitch 24 css = 43.5 px end view (0.0403 fh) | 440 / −0.27 css px (matches SF line widths: every line wraps where the reference wraps) | #F2F2EF |
| text under highlight | same | Inter | same | same | #041000 |
| greeting | Anthropic serif | **Source Serif 4** (added, OFL) | 30.6 css px (cap height 37 px end view, 0.034 fh) | 400, opsz 32 | #FAFAF7 |
| model label "Opus 5.5 High" | system sans | Inter | 11.7 css px | 400 | #BBBBB7 |
| chips | system sans | Inter | 11.6 css px | 400 | #C1C0BB |

## Geometry (css px; ×1.1656 at the start, ×1.805 at the end view)
- **Composer:** 727 wide, 1 px border #32322F, fill #292926, radius 20, shadow 0 4 18 rgba(0,0,0,0.035). Text padding: 12.75 top, 18 left, 24 right (text width 683). The bottom row is 32 tall, 4.8 below the last line, with 11 + 1 below.
- **On screen at the start:** composer 847.4 px wide, centred x 960, top y 443.2. At the end view: x 319–1631, y 348–677 (5 lines).
- **Send:** 32 × 32, radius 6.5, #D26C4D, white arrow 15 px.
- **Plus:** 17.7 px icon, centre 34.9 from the composer's left edge. The model label's right edge is 151.2 from the outer right; the chevron is 9 × 4.6, centred 106.4 from the outer right.
- **Chips:** 26 tall, radius 6.5, fill #292926, label padding-left 12. Widths are 81.4 / 79.8 / 115.2 / 140.2, with a 6.4 gap and a 14.4 gap below the composer. The row is centred 3.6 px left of the composer centre.
- **Spark logo:** 31 × 32, #D77F60, 12 rounded rays. It sits 13.3 px left of the text, 4.1 px above the text's centre line.
- **Highlight box:** colour **#D9FD28** in the reference (**#FFD21E** since 2026-10-10), opaque (normal blend, alpha 1; the text under it is recoloured, not multiplied).
  - Vertical: top = line-box top + 0.2 em; height **1.4 em**. End view: 509–550 on line 4, 553–591 on line 5, about 40.5 px per 43.5 px line.
  - Horizontal pad: 0.27 em before the first glyph and 0.35 em after the last (6–8 px / ≈ 10 px at the end view).
  - Radius 0.175 em (≈ 5 px end view).
  - Growth: a rounded box whose right edge grows left → right; the text under it turns dark exactly at the edge.

## Colours
Backdrop #20201D, composer #292926, border #32322F, text #F2F2EF, muted #BBBBB7, chip text #C1C0BB, icons #BFBEBA, send #D26C4D, spark #D77F60, caret #898986, marker #D9FD28 (reference) → #FFD21E (Jake), marker text #041000 → #1A1400.

These are as the YouTube encode shows them; the live claude.ai dark theme is a little lighter (bg ≈ #262624).

## Verification: our render vs the reference (same content, beats 1.959 / 3.703 / 5.449 s, greeting "Evening, Jake")
Sheet: `prompt_highlight-compare.png`, 12 timestamps: 0, 1.0, 1.5, 1.75, 1.967, 2.167, 3.167, 3.933, 4.3, 5.0, 5.667 and 8.6 s.

| key element | position error | timing error (60 fps frames) |
|---|---|---|
| send button centre (camera) | static ≤ 0.5 px; during the push ≤ 10 px at f90 (the fastest part, ≈ 1 frame) | push scale: mean +0.22 f, max 1.06 f |
| logo centroid | ≤ 0.5 px static (end view 804.4,252.4 vs 804.5,252.0) | — |
| composer height (button y) | ≤ 1.5 px static | growth: median 3 f, max 7.5 f (the growth ease is the weakest fit) |
| highlight left/right edges | ≤ 3 px (466/466, 903/903, 1559/1556, 347/347, 515/516, 1210/1213) | sweep 0: max 0.8 f; sweep 1: max 1.2 f / 1.0 f; sweep 2: max 1.8 f |
| line wraps | identical: all 5 lines break at the same words | — |
| typing | ±3 chars (ours is ≤ 0.1 s ahead around f110–130) | — |
| opacity | none animated (opacity error 0) | — |

Generalised example: `prompt_highlight-general.png`. It uses a 156-char hot-sauce prompt with 3 phrases, shown in the Claude kit, the ChatGPT kit and the neutral box.
