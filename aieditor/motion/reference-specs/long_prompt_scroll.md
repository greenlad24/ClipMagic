# long_prompt_scroll (MO07) — spec, measured from motion6.mov

Reference: `/opt/aieditor-work/reference/motion-2026-10-09/motion6.mov`: 1920×1200, 60 fps, 331 frames (5.517 s).
It shows Claude.ai's dark chat view with one LONG structured assistant message. The app content is the capture's
y 60-1139, which is 1920×1080 at 1:1, so no scaling is needed. Time is t = (f−1)/60.

The capture repeats about every 5th frame (a ≈48 fps source in a 60 fps recording), so every fit uses only the
unique frames. The camera was tracked per frame with an ORB + RANSAC similarity fit (≈6000 inliers). The motion is a
pure zoom about a fixed point, followed by a pure vertical translation. The marker boxes were measured by yellow
segmentation, mapped back into start-view coordinates.

Template: `motion/templates/long_prompt_scroll.{js,kf.json,style.json}`. Kit part: `ui-kits/claude/message.json`
(the lead merges it in as `kit.message`). Machine-readable spec: `long_prompt_scroll.json`.

## Elements / layers
1. Backdrop `#20201d` (the app background).
2. App view, which is the Claude conversation view (kit.message):
   - a header with the sidebar toggle and the chat title. Its solid band clips the scrolled text at y 101 in the start view.
   - one assistant message in the reply serif (pre-wrapped plain text).
   - the Claude spark `#d38162` under the message.
   - the docked composer: 847×121.5 px at (536.5, 914.5), radius 20 css. It holds "Write a message...", +, "Opus 5.5 High", a chevron, a mic and a voice icon.
   - the disclaimer line, centred at y 1060.5.
3. Marker boxes. They sit inside the text element, above the text, and each one redraws the text in dark (`#041000`).
4. Camera: a zoom about a fixed pivot, then a scroll.

## Timeline (reference)
| phase | t (s) | frames |
|---|---|---|
| static whole-app view | 0 – 1.090 | 1 – 66 |
| zoom ×1.8959 about (949.9, 452.5) | 1.090 – 1.737 (tail settles ≈1.82) | 66.4 – 105.2 |
| hl_0 "A DENSE row … flat plaza" (2 line pieces) | 1.504 / 1.746 → 2.104 | 91.3 / 105.8 |
| hold | 2.104 – 3.192 | |
| scroll 17.58 lines | 3.192 – 4.598 | 192.5 – 276.9 |
| hl_1 "terrace opens to a wide hazy VALLEY view" | 3.246 – 3.604 | 195.8 |
| hl_2 "LIGHT — MIDDAY SUN:" | 4.204 – 4.562 | 253.3 |
| hl_3 "Strong high sun: crisp dense shadows" | 4.454 – 4.812 | 268.3 |
| end hold, then hard cut | 4.812 – 5.517 | 331 |

## Camera keyframes
- **Zoom:** scale 1 → **1.8959** about the pivot **(949.9 ± 0.6, 452.5 ± 1.2) px**, which is (0.4947, 0.4190) of the frame.
  - Start 1.0904 s, duration **0.647 s** (38.8 f).
  - Fitted ease **cubic-bezier(0.714, 0.083, 0.327, 0.704)**, max error 0.034 (rms 0.017) of progress. In time that is a max error of 1.1 frames (mean 0.47).
  - The first sweep starts **0.4136 s after the zoom starts**, while the zoom is about 66 % done.
- **Scroll:** one move of 966.5 screen px. At the zoom that is 509.8 start-view px, or **17.58 lines** of 29.0 px.
  - Start 3.197 s, duration **1.406 s**, ease **cubic-bezier(0.39, 0, 0.59, 1)**, max error 0.010.
  - Mean speed **12.56 lines/s**. Peak 27.1 lines/s (1493 screen px/s).
  - No pause inside the move. There is a 1.09 s dwell after hl_0's sweep and a 0.92 s hold at the end.
  - The move starts **0.054 s before** the sweep of the phrase it brings in. That phrase enters at the bottom edge, with its box bottom at 1070–1077 px.
- **Reading position:** after the zoom, phrase 0's box top sits at **592.9 px** (0.549 fh). At the end of the move, the group's last phrase has its box bottom at **661 px** (0.612 fh) and its first phrase has its box top at 65 px.

## Marker sweep
- An opaque rounded box, measured **#dafd29** (the template uses #d9fd28, prompt_highlight's marker), alpha 1, blend normal. The text under it is redrawn dark.
- It grows left → right over each **line piece**.
- **Fixed duration:** every sweep shows the same progress samples (0.044 / 0.156 / 0.317 / 0.50 / 0.683 / 0.844 / 0.956), whatever its width (90–588 px). Duration **0.358 s** (fits range 0.333–0.375 s). Ease **cubic-bezier(0.4, 0.025, 0.5, 0.975)**, max error 0.027.
- A wrapped phrase's next piece starts **0.242 s** after the previous piece starts, so the pieces overlap. The next phrase is chained 0.25 s after the previous one starts.
- Highlights accumulate and stay until the cut.
- **Geometry at the end view** (em = 35.8 px):
  - The box hugs the ink of its line: a caps-only heading box is 36 px tall, a body line with descenders is 44 px.
  - Left pad 10.6–15.6 px (hand-placed; template 0.36 em). Right pad ≈ 9–10.5 px (0.27 em).
  - Top = ink top − 4.5..5 px. Bottom = ink bottom + 3..6 px. Radius ≈ 4 px (0.12 em).

## Typography
- **Message:** Claude's reply serif. 21 reference lines wrap exactly where Georgia metrics wrap them. Free match: **Gelasio** (OFL, Georgia-metric-compatible), added as `motion/fonts/Gelasio.ttf` with `OFL-Gelasio.txt` from github.com/google/fonts.
  - Size **18.89 px** at the start view (0.01749 fh) and **35.8 px** at the end view. That is 16.21 css.
  - Line pitch **29.0 px** (0.02685 fh, ratio 1.535). Weight 400, tracking 0, colour #ffffff as the video shows it.
  - Text column x 560 – 1355.6 at the start view (682.9 css). The width was chosen so that every reference line wraps where the reference wraps; the feasible range is 679.95–685.78 css.
- **Headings:** plain ALL-CAPS lines, the same font, size and weight as the body. They look like "SECTION — SUBTITLE:", follow one blank line (29 px), and the body starts on the next line.
- **UI** (Inter as the system-sans substitute):

  | element | size (css px) | colour |
  |---|---|---|
  | title | 13 | #c8c8c5 |
  | placeholder | 16 | #8b8b88 |
  | model label | 11.7 | #bebebb |
  | disclaimer | 10 | #7d7d7a |

## Colours
| element | colour |
|---|---|
| bg | #20201d |
| composer surface | #292926 |
| composer border | #32322f |
| spark | #d38162 |
| marker | #dafd29 |
| marker text | #041000 |

## Generalisation (what the template does with other content)
- **Start scroll:** phrase 0 lands at 592.9 px after the zoom. If the app cannot scroll that far (the phrase is near the top or the end of the message), the zoom pivot moves instead, clamped to the frame.
- **Moves:**
  - A phrase whose box is not inside the reading area (bottom ≤ 972 px = 0.9 fh) gets a move.
  - One move carries as many following phrases as fit between y 60 and y 661.
  - Duration = **max(0.5 s, lines / 12.56)**. This is the **reading-speed limit**: never faster on average than the reference.
  - The move starts max(0.054 s, time to enter the 8–1073.5 px band) before the beat. It never starts before the previous move ends, nor within 0.25 s of the previous sweep's end.
- **Late sweeps:** when the beats would need a faster scroll or overlapping sweeps, the sweep starts late. When it is more than 0.1 s late, the template reports it in `state.warnings`, `window.__lpsWarnings` and `console.warn("long_prompt_scroll: …")`.
- **Scrolling past the app's limit:** the camera pans instead, and the composer may enter at the bottom at the very end. The text never goes higher than the rest line.
- **Zoom fit:** the zoom shrinks if the text column would not fit the frame with a 40 px margin.

## Verification
The render uses the reference content (prompt text, the same 4 phrases, beats = the reference's fitted sweep starts, zoom beat 1.0904 s).
- Compare sheet (14 timestamps covering every beat): `long_prompt_scroll-compare.png`
- Generalised example (neutral kit, a different prompt, 4 phrases, 8.9 s): `long_prompt_scroll-general.png`

### Camera error: ORB similarity between each reference frame and ours

| phase | max \|dx\| px | max \|dy\| px | scale err | timing err |
|---|---|---|---|---|
| static app view (f1-66) | 2.4 | 2.3 | 0.6 % | – |
| zoom (f66-112) | 5.1 | 5.2 | ≤ 5.8 % mid-zoom (a ≤1.1 frame shift) | max 1.1 f, mean 0.47 f |
| hold (f112-192) | 5.1 | 2.1 | 0.9 % | – |
| scroll (f192-280) | 5.5 | 32.5 raw* | 1.0 % | mean 0.50 f, max 2.26 f (first frame of the move) |
| end (f280-331) | 5.2 | 4.6 | 1.0 % | – |

\* The raw per-frame dy during the scroll includes the reference's repeated frames (it shows a stale frame about every 5th frame, while the motion is up to 25 px/frame). The timing error, measured on unique frames, is the real figure.

The remaining ≈1 % scale difference is Gelasio being slightly narrower than the reference serif. That causes up to ±5 px at the column edges after the zoom. The line breaks are identical.

### Highlight boxes [x, y, w, h] in px

| moment | reference | ours |
|---|---|---|
| t 2.15 s | [1557,593,171,35] [195,647,1115,43] | [1539,593,177,35] [198,644,1102,46] |
| t 5.50 s | [697,64,690,44] [200,562,425,36] [200,616,615,44] | [691,68,691,43] [198,565,424,37] [198,618,616,43] |

The 18 px x-offset on "A DENSE" is the line-end word sitting where the narrower font puts it.

### Sweep timing
- Our starts equal the beats, which are the reference's fitted starts (1.504 / 3.246 / 4.204 / 4.454 s). The scroll move is planned to start at 3.192 s, the same as the reference.
- Duration 0.358 s against the reference's 0.333–0.375, so the ends are within ≤1 frame.

## Deviations
- The reference message was still **streaming**: the last words fade in and the spark sits below them. The template shows the finished message, keeps the spark, and has no fade-in.
- The reference chat title and the mouse cursor are not reproduced. The title is a parameter, and the cursor is capture chrome.
