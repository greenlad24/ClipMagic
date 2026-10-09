# tagline_build (MO02): spec, measured from motion2.mp4

Reference: `/opt/aieditor-work/reference/motion-2026-10-09/motion2.mp4`. It is 1920×1080 at 60 fps (true 60: every frame moves), with 92 frames.
Frames 90 and 91 already belong to the next shot, so the graphic is **f0 to f89 = 1.500 s**.
Implementation: `motion/templates/tagline_build.js`, `.kf.json` (motion) and `.style.json` (look).
Machine-readable data: `tagline_build.json` holds the full kf, style and per-frame error table.
Compare sheet: `tagline_build-compare.png`. General example: `tagline_build-general.png`.

## What actually happens (corrects the brief)
- The clip opens mid-animation. "Every" is already on screen at f0, and 14 blue dots are already in flight.
- The dots do **not** settle as 4 separate dots. **4 corner handles** sit on the selection rectangle from f0.
  - **11 feeder dots** (24 px) travel to them along Manhattan legs: an axis-aligned run, then a ~45° diagonal.
  - Each feeder vanishes on contact (no fade). Each contact fattens the handle: **24 → 40 px**.
  - None of the dots fade out. Every feeder merges.
- A **push-in** starts 7 frames after the last word (f30). The grid hard-cuts off on that frame (1 frame, no fade).
  - The text and box then scale uniformly about the text's ink centre (963, 543).
  - The scale curve is a fast ease-out to +6 % in 0.27 s, then a linear creep of +8.4 %/s. It reaches 1.149 at f89.
  - The handles drift outward slightly faster than the scale.
- **The "black bar" is not a wipe.** It is a dock rail: a dark strip, 26 px wide, at the right frame edge (x 1894–1920), with a rounded tab.
  - The tab is 19 × 101 px, centred at y 539.5, with a 12 px radius and 10 px concave fillets.
  - It **fades in** from f52.3 over 8 f (ease [0.1,0.4,0.2,1], max err 0.011 α) to #040404. The tab scales 0.82 → 1 at the same time.
  - The 4 handles then accelerate (ease-in, ~exponential) into the tab. Each lands as a **spinner ring** (≈12.5 px, 2.6 px stroke, ~280° arc, #0887FF) at y = 539.5 + (i−1.5)·19.
  - Landing order: TL f78, TR f80, BL f82, BR f84. Each ring grows 0.45 → 1 and rotates −90° → 0° in 3 f.
  - Text and rail stay up; **hard cut at f90**. Nothing is cleared or revealed.

## Elements & layers (bottom → top)
1. Backdrop. A radial light, #F8F8F5 at (50 %, 39 %) to #ECECE9 at the edges. A grid of 2 px lines every 120 px (1/9 H), at x,y = 120k−1, rgba(0,0,0,0.066). The grid is visible until the push.
2. Text group. Single line, Inter 650, cap height 92 px (0.0852 H, ≈126.6 px font), tracking −0.0245 em, #141413. The ink is centred at (963, 543).
3. Dots. 11 feeders plus 4 handles, #0887FF.
4. Rail, tab and rings.

## Per-word entrance
- Hard pop: fully opaque on its beat. No blur, no offset.
- Scale **0.94 → 1** about the word's own ink centre over **0.117 s (7 f)**, ease [0.2,0.9,0.5,0.8] (max err 0.003 scale ≈ 0.5 px).
- Beats in the reference: f0, f8, f15, f23. Stagger is **0.133 / 0.117 / 0.133 s** (mean 0.128 s).

## Selection rectangle (handle home positions at f0)
- The rectangle is the text ink box plus padding: left 0.533 U, right 0.457 U, top 0.717 U (above the cap top), bottom 0.652 U (below the baseline). U = cap height = 92 px.
- Reference rectangle: (275, 431) to (1644, 649). This is exactly the 4 handles' f0 positions.
- After the merges the handles wander about 0.2 U ("absorbed momentum"). Tables are in kf `handles.<c>.gather`.

## Feeder paths (kf `dots.feeders`, offsets in U from the target corner, t from word_0)
| feeder | corner | path | merges at |
|---|---|---|---|
| A, B | TL | already arriving at f0 | f2, f3 |
| C | TL | diagonal from (407,239) | f9 |
| D, E | BL | diagonals from below / right | f5 |
| F | TR | right, then diagonal down | f9 |
| R2 | TR | right along y 120, then down | f15 |
| G | TR | still, then left along y 240, then diagonal down | f19 |
| R3 | BR | right along y 719, then diagonal up | f11 |
| R1 | BR | right along y 960, then up | f17 |
| H | BR | still, then left along y 840, then up | f21 |

Flight speeds peak at about 50 px/frame at the start of each leg and ease out into the handle.

## Push (kf `push`)
- Starts at max(last word + 0.117 s, word_0 + 0.5 s).
- Scale: s(t) = measured per-frame table (60 samples), then the linear creep (k = 0.084/s), capped at 1.3.
- Fitted summary: 1 + 0.06·ease[0,−0.2,0,1](t/0.267 s) + 0.084·t, max err 0.006.

## Exit flights (kf `handles.<c>.exit`, launch relative to `out`)
| corner | launch after out | flight | ring slot | x-ease fit (summary) |
|---|---|---|---|---|
| TL | 0.178 s | 0.250 s | 0 | [0.9,0.1,0.6,0.3] |
| TR | 0.245 s | 0.217 s | 1 | [0.8,0.2,0.8,0.9] |
| BL | 0.262 s | 0.233 s | 2 | [0.9,0.1,0.7,0.6] |
| BR | 0.195 s | 0.333 s | 3 | [1.0,0.1,0.7,0.4] |

- The JS drives each flight from the measured per-frame progress table (`progress_table`).
- y progress is a late ease-in: about 90 % of the vertical travel happens in the last 25 % of the flight.
- Dot size along the flight, by x-progress: 40 → 34 (0.37) → 31 (0.53) → 27 (0.72) → 20 (0.9) → 18 px.

## Verification (reference content and beats, frames 0–89; sheet at ≥ 14 timestamps)
- Timing error is 0 frames for every event: word pops, merges, grid cut, rail fade, ring landings, cut.
- Dot centres: median error 1.0 px. Maximum error is 5.8 px outside the 2 merge frames. On merge frames f4 and f8 a handle and feeder are drawn touching one frame early, which makes a 17.8 px blob-centroid error.
- Text ink-box edges: ≤ 3 px from f15 on. On f0–f14 the error is 7–9 px because Inter's "agent." / "Every" set about 7 px wider than the reference font while the right edge is the newest word.
- Rail opacity: max error 0.016.
- Per-frame table: `tagline_build.json` → `error_table`.

## Known residuals
- Font: Inter 650 is a substitute for the SF-Pro-like original. Ink area and width match within 0.3 %, but glyph shapes differ.
- The f0 vertical motion-blur streaks on dots G and H (24×54 px) are not reproduced; they are drawn as plain circles.
- The radial-light gradient is approximate (within about 2 levels of 255).
