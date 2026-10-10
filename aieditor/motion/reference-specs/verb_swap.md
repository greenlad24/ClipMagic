# verb_swap — spec (reference motion1.mp4)

Reference: `/opt/aieditor-work/reference/motion-2026-10-09/motion1.mp4`. It is 1920×1080, 30 fps, 85 frames (2.833 s). The content is "Grok Bot can now ⟨search|read|analyze⟩ X" on flat white.
Template: `motion/templates/verb_swap.js` + `verb_swap.kf.json` (motion) + `verb_swap.style.json` (look). Machine-readable spec: `verb_swap.json`, which includes the per-frame tables and the error table.
Every measurement was taken frame by frame, using the ink-weighted sub-pixel centroid and extent of each word (`cent.py`). Easings are fitted cubic-beziers (grid fit, max error given).

## Headline findings
- **There is no roll.** The verb does not slide vertically, fade, blur or scale. On each verb beat the verb's **text and colour switch hard**. Meanwhile the whole line re-lays out horizontally: every word's x moves from the line laid out with the old verb to the line laid out with the new verb, so the line **re-centres**. The verb is drawn centred in its interpolated slot. As a result the neighbours close in on the old verb (on the swap frame they touch: "nowsearchX") and then open out around the new one.
- **Words pop.** Each word goes from opacity 0 to 1 in one frame, with no blur and no scale, and stays on the same baseline. Nothing moves in y.
- **The build drifts.** During the build the whole line slides left into place: 81 px at the first frame, settled by +0.70 s. Each new prefix word also lands 4–9 px right of its slot and settles within about 0.2 s.
- **verb_0 enters with the suffix.** verb_0 and the suffix pop in together and slide left into place over 0.38 s (verb 0.29 em, suffix 0.46 em).
- **No exit.** The full line holds to the clip end, 1.07 s after the last verb.

## Elements / layers
| layer | element | notes |
|---|---|---|
| 0 | backdrop | flat #ffffff full frame (params.backdrop; false = transparent) |
| 1 | prefix words | #000000, one span each, pop on `in` / `word_k` |
| 1 | verb slot | one span; text+colour switch on `verb_i` |
| 1 | suffix words | #000000, pop with `verb_0` |

## Key frames (reference, frame 1 = t 0)
| frame | t (s) | event |
|---|---|---|
| 1 | 0.000 | "Grok" visible (beat `in`), line 81 px right of its rest position |
| 2 | 0.033 | "Bot" pops (`word_1`) |
| 6 | 0.167 | "can" pops (`word_2`) |
| 10 | 0.300 | "now" pops (`word_3`) |
| 18 | 0.567 | "search" (blue) + "X" pop (`verb_0`), 26 / 41 px right of their slots |
| 21–22 | 0.70 | build drift settled |
| 33 | 1.067 | verb_0 slide settled |
| 36 | 1.167 | swap 1 motion starts (lead 0.07 s) |
| 37 | 1.200 | mid-swap: old "search" squeezed, neighbours touching |
| 38 | 1.233 | "read" (orange) shown (`verb_1`), progress 0.84 |
| 42 | 1.367 | swap 1 settled (0.16 s) |
| 51 | 1.667 | swap 2 motion starts (lead 0.04 s) |
| 53 | 1.733 | "analyze" (green) shown (`verb_2`), progress 0.68 |
| 60 | 1.967 | swap 2 settled (0.22 s) |
| 85 | 2.800 | end, no exit |

## Motion (kf; times relative to the named beat, travel in em of the font size)
| component | start | duration | travel | easing (cubic-bezier) | max fit error |
|---|---|---|---|---|---|
| drift (whole line, from `in`) | −0.03 s | 0.75 s | +1.202 em → 0 (122.6 px) | (0.0, 0.9, 0.7, 1.0) | 0.20 px |
| word_in (prefix word k≥1, from `word_k`) | 0 | 0.225 s | +0.0575 em → 0 (measured 0.037/0.049/0.087) | (0.2, 0.6, 0.3, 1.0) | 0.47 px |
| verb_in (from `verb_0`) | −0.033 s | 0.38 s | verb +0.290 em, suffix +0.462 em → 0 | (0.5, 0.6, 0.0, 0.8) | 1.35 px |
| swap 1 (measured) | −0.07 s | 0.16 s | layout lerp | (0.5, 0.9, 0.2, 0.9) | 0.021 progress (1.5 px) |
| swap 2 (measured) | −0.04 s | 0.22 s | layout lerp | (0.2, 0.8, 0.0, 0.7) | 0.033 progress (2.6 px) |
| swap default (i ≥ 3) | −0.05 s | 0.22 s | layout lerp | (0.2, 0.6, 0.0, 0.9) shared fit | 0.056 progress |
| text/colour switch | on the beat | 0 | — | step | 0 frames |

Swap progress (prefix centroid): swap 1 is f36 .04, f37 .46, f38 .84, f39 .93, f40 .97, f41 .99. Swap 2 is f51 .02, f52 .16, f53 .68, f54 .80, f55 .87, f56 .92, f57 .96, f58 .99. The suffix follows the same progress to within 0.06.
The two reference swaps differ in duration by about 2× (0.16 s vs 0.22–0.30 s), which looks like hand-keyed variance. The template therefore uses the measured timing for swaps 1 and 2 and the shared fit for any later swap.
An overlap guard (`swap.min_gap_em` −0.02) pushes the neighbours apart when a long verb would otherwise run into them mid-swap. It never triggers on the reference content: the replica is byte-identical in measurement with and without it.

Staggers: the prefix words appear at +0, +1, +5, +9 frames, which is a mean stagger of 0.1 s. In the reference these are spoken-word beats. The gap from `in` to `verb_0` is 0.567 s. The verb spacing is 0.667 s then 0.5 s (mean 0.583 s), and the hold after the last verb is 1.067 s.

## Typography / look
**Revision 2026-10-10 (Jake): font changed to the Roboto family**, the house motion font. The template was previously Inter 400.
- Reference font: SF Pro Regular (not free). Ours: **Roboto 500 (Medium)** from `motion/fonts/Roboto.ttf`, a variable font with wght 100–900 and wdth 75–100. It was already present, so no font was added.
- Tracking 0, matching the house Roboto use in recipes2.py (Roboto 700, tracking 0, white over footage).
- **Weight test.** I rendered 400, 500, 600 and 700 (`verb_swap-roboto-<w>.mp4`; sheet `verb_swap-roboto-weights.png`). Each weight's size was re-fitted at tracking 0 so the cap height (74 px) and the line box match the reference.

| weight | size (H / px@1080) | ink mass vs ref | line-width error search / read / analyze |
|---|---|---|---|
| 400 | 0.0951 / 102.7 | 1.00× | −6 / 0 / +6 px |
| **500** | **0.0948 / 102.4** | 1.23× | −3 / +2 / +10 px |
| 600 | 0.0944 / 102.0 | 1.32× | −5 / 0 / +9 px |
| 700 | 0.0941 / 101.6 | 1.41× | −7 / 0 / +8 px |

- **Why 500.**
  - **400** is stroke-identical to the reference. But the light verb colours lose body at that weight: green #0fe473 is about 1.6:1 on white and orange about 3:1.
  - **500** gives the coloured verbs enough mass to read at a glance and keeps the reference's open, airy look.
  - **600 and 700** close the counters of a, e and o, and make the black prefix outweigh the coloured verb. That inverts the hierarchy, since the verb is the point.
  - The house 700 is meant for white text over busy footage. On a flat white plate it reads heavy.
- **Layout.** Word space 0.235 em (ink gaps 30–37 px against the reference's 31–37). Baseline y 574 px (0.5315 H). Centre x 966.5 px (0.5034 W).
- **Colours.** Background #ffffff, text #000000. Verbs: blue **#1b86f5**, orange **#f05c03**, green **#0fe473**, then they cycle. The raw measurements were solid-ink medians #1b87f7 / #f15d04 / #10e474 and core (80th pct) #1c85f2 / #ef5b02 / #0ee471.
- No shadows, radii or cursor.

## Verification (reference content + reference beats)
The compare sheet is at `/opt/aieditor-work/reference/specs/verb_swap-compare.png`. It covers 14 timestamps: every beat, mid-swap and settle frames, and the end.
The side-by-side MP4 is in `scratchpad/motion-preview/verb_swap/`.

These results are for Roboto 500.

| check | result |
|---|---|
| pop timing | 0 frames (word count matches on all frames; f56 is a segmentation artefact only) |
| text switch timing | 0 frames (f18, f38, f53) |
| motion error (per-state static offset removed) | ≤ 2 px left edge, ≤ 4 px right edge |
| raw position error | ≤ 12 px |

The raw position error is a static offset per state: search +11 / +8, read −10 / −8, analyze −4 / +6 px. It comes from the reference itself, whose line centre wanders by state (958.5 / 976.5 / 966.5 px), while ours is centred mathematically. Roboto fits the reference box better than Inter did (Inter: raw ≤ 17 px).

Per-frame error table: `verb_swap.json → verification.per_frame`. It gives ref/ours left and right ink edges, the raw error, the motion error and the word-count match for frames 1–85.

General example: `verb_swap-general.png`. It uses "Claude Code can ⟨write|refactor|test|ship⟩ your whole app": 3-word prefix, 4 verbs, 3-word suffix, a custom colour on verb 4, and verb_2's beat missing so it falls back to the measured spacing.
