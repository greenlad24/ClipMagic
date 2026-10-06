# Titles, chapter cards, lists and cold open: measured spec

The reference is gVPZU1btFA8 (1920×1080 at 24 fps). Frame k = round(t·24). Machine-readable spec: `titles-lists.json`, same folder.
Frame numbers are exact. Every seek used t = k/24 − 0.0004 or an exact pts, so the old kit and the fixed (ceil) kit give the same frames. The only off-by-one runs (the first chapter-card track and strip `ch_in`) were corrected before use.
Blur is given as a box-blur radius r in px. As a Gaussian σ that is about r1 = 0.8, r2 = 1.4, r4 = 2.6 and r8 = 4.9 px.

## 0. Corrections to the Gemini shot list

The shot list's claims about this family were checked against the video:

- **Only one full-screen chapter card exists** (1631–1685, "AD FORMAT #1 / CALLOUT DIAGRAM"). I scanned all 14 954 frames at 64×36 and found no other one. "Ad format #2/#3" (3:33–3:38) are small captions under ad cards, which belong to another family. There are not 10 chapter cards with one recipe.
- **There is no "flash cut" (7:05) and no "glow transition" (7:10).** Both cut straight into the glow plate.
- **The end card does not fade to dark.** The file ends on the fully held card (frame 14953).
- **The cold open does not end on a cut.** It ends with a whip-pan of the whole canvas, glow plate included.

## 1. Background plates

### Pink glow plate
Used by the cold open, the QUEST card, the numbered list, and the 8:01–8:28 section.

- **It is a looping pre-rendered clip that restarts at each card.** The edge-glow series at f0 and at f10200 are identical frame for frame.
- **Layout:**
  - Dark centre ellipse, #030303 to #0B0403, covering x 0.2–0.8 and y 0.15–0.85.
  - Right glow: centroid (0.91, 0.44), peak #DD405F at the edge.
  - Left-bottom glow: centroid (0.08, 0.60), #A12F45 to #752430.
  - Warm brown top-left corner, #492921.
  - Faint dot grid with ~119 px spacing.
- **It breathes.** The two glows pulse independently and irregularly, by about ±25 % with 2–3.5 s swings. The right-edge mean R channel goes 101 → 84 (f28) → 136 (f75) → 97 (f117). The right glow's y drifts between 0.42 and 0.47.

### Other plates
- **Chapter plate:** #020202 with a faint plum edge vignette (#0C0006 to #20010F). It is static.
- **End-card plate:** flat #101114 with a magenta radial glow at the top centre. The glow is #9B1642 at (0.5, 0.05) and fades out by y ≈ 0.5. There are faint squiggle outline strokes.

## 2. Typography

**Space Grotesk Bold (Google Fonts) for every word in this family.** I rendered 14 grotesks side by side (`work/titles-lists/fontcand.png`). The letterform evidence:

- The D stem sticks out to the left above and below the bowl (AD, DIAGRAM).
- The "1" has a long flag and no foot.
- The "&" is the "Et" form.
- N and M have ink traps.
- 0 and O are square-ish.

Other text:
- **"GPT-6 ASTRA":** a different neutral sans. Candidates are Inter, Geist or SF Pro Display Bold (medium-low confidence).
- **End-card "Higgsfield Marketing":** an Inter or SF Pro Semibold-like brand lockup (low confidence).

Tracking is 0 and everything is in capitals. Font size = cap height / 0.70.

| element | cap px | font px |
|---|---|---|
| chapter label "AD FORMAT #1" | 53 | 76 |
| chapter title "CALLOUT DIAGRAM" | 82 | 117 |
| cold "WEEKS" | 130 | 185 |
| cold counter digits | 160 (digit height) | 230 |
| cold "I SPENT" | 60 | 86 |
| cold "ANALYZING" | 40 | 57 |
| cold "PRODUCTS" | 42 | 60 |
| cold "FOR" | 22 | 32 |
| QUEST rows / 2nd QUEST | 52 / 48 | 75 / 69 |
| numbered list | 50 (line-height 70) | 72 |
| PROOF | 49 | 70 |
| comparison | 50 | 72 |
| EXCLUSIVITY | 62 | 88 |

Colours:
- **White:** #FFFFFF. Minor grey ("FOR"): #B3ABB0.
- **Pink initials and numbers** (P R O O F, Q U E S T, 01 02 03): #FC1955 median, with a vertical gradient from #FF6F98 at the top to #E0113F at the bottom.
- **Pink gradient words** (CALLOUT DIAGRAM, WEEKS, 10,000, PRODUCT IN ACTION, EXCLUSIVITY, ASTRA):
  - Stops: #FC167F hot pink → #FD0A3E red → #FB70A0 light pink → #FCCB73 gold.
  - The gradient is mainly horizontal, with lighter tops on the letters.
  - It is animated: the stops flow. On the chapter card the gold patch sits on "GRAM" at 1640–1655, then fades, and a light-pink patch appears on "CA" at 1663–1670. The cycle is about 1.5–2 s. This is not a single linear sweep.
- **Chapter underline:** #FF0990, 6 px thick, round caps, x 355–1567, y 680. Counter underline: #F40744.
- **Rows and badges:**
  - Row pills are #0F0E11, with a 1 px top edge #211E22.
  - Number badges are #21161E, 110×110 px with radius 12.
- **Cold-open glass pills:** a horizontal gradient from #3B2032 to #100A11, with a pink top-edge glow #982559.
- **Arrow:** #EE0C87. Ampersand: #F77CAC.

Geometry for every instance (px and normalised) is in `geometry` in the JSON.

## 3. Recipes (24 fps)

Frame offsets are relative to each element's first visible frame.

### A. Word rise reveal
Used by the chapter card, the comparison list, the numbered-list text, and EXCLUSIVITY (inverted, see below).

- **Unit:** one word.
- **Stagger:** 1.5–2 f between words. Line 2 starts 3 f after line 1.
- **Opacity:** 0 → 1 from f −0.25 to f 11.8, cubic-bezier(0.248, 0.115, 0.48, 1.0). Pooled rms is 1.9–2.9 % over 4 words.
- **translateY:** +30 px → 0 from f −0.85 to f 9.4, cubic-bezier(0.383, 0.261, 0.219, 0.701). rms is 2.5–7 %, because dy is quantised to 2 px. Effectively easeOutQuad with a soft first frame.
- **Blur (box r):** 4 at f0, 2 at f2, 1 at f5, 0 at f8.

Per-frame opacity / dy for the word "AD":

| f | 1632 | 1633 | 1634 | 1635 | 1636 | 1637 | 1638 | 1639 | 1640 | 1641 | 1642 | 1643 | 1644 | 1645 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| op | .015 | .092 | .226 | .355 | .456 | .578 | .688 | .766 | .862 | .919 | .965 | .975 | .995 | 1 |
| dy | 28 | 26 | 22 | 16 | 12 | 8 | 6 | 4 | 2 | 2 | 0 | 0 | 0 | 0 |

The comparison word "STATIC" (5990 →) is the same within ±0.06: opacity .008 .07 .17 .30 .46 .61 .75 .83 .92 .96 .99 1, dy 28 22 16 10 8 6 4 2 0.

### B. Chapter card (only one instance)
- **1631:** hard cut to the empty plate.
- **Words:** AD 1632, FORMAT 1633.5, #1 1635, CALLOUT 1635, DIAGRAM 1637. Each uses recipe A and settles by 1645–1647.
- **Underline:** full width from its first frame, with no wipe. It starts at 1637.
  - Opacity: .11 .50 .76 .88 .96 1, settled at 1642. Fit: cubic-bezier(0.349, 0.313, 0.15, 0.779) over 5.2 f.
  - y: +29 27 23 18 13 9 6 4 2 0 (1646), then overshoots to −3 at 1651–52 and returns to 0 at 1657. Fit: cubic-bezier(0.332, 0, 0.182, 1.425) over 22.9 f, a back-out with 8 % overshoot.
- **Hold:** 1647–1675 (29 f), static with no push-in.
- **Exit:** all elements together, with no stagger.

| f | 1676 | 1677 | 1678 | 1679 | 1680 | 1681 | 1682 | 1683 | 1684 | 1685 |
|---|---|---|---|---|---|---|---|---|---|---|
| op | 1 | .99 | .99 | .94 | .67 | .39 | .20 | .10 | .045 | 0 |
| dy | −1 | −2 | −4 | −6 | −9 | −11.5 | −14 | −16 | −18 | — |

  - y fit: ease-in, cubic-bezier(0.356, 0.169, 0.16, 0.408), 0 → −30 px over 17.3 f.
  - Opacity fit: cubic-bezier(0.441, 0.686, 0.346, 0.845), 1 → 0 over 6.25 f starting at 1678.75.
  - 1685 is the empty plate, then a hard cut to the presenter at 1686. The card is on screen for 55 f in total.

### C. Pill-row flip-in
Used by the QUEST card (7:05) and the second QUEST pills (8:16), and by the numbered-list bars. The two QUEST instances have identical timing.

- **Stagger:** 2 f per row. Q U E S T bars start at 10223, 10225, 10227, 10229, 10231. In the second instance the text starts at 11911, 11913, 11915, 11917, 11919.
- **Bar (from 2 f before its text):** the left edge is fixed and the bar grows.

| f | 10223 | 10224 | 10225 | 10226 | 10227 | 10228 |
|---|---|---|---|---|---|---|
| bar w / h (final 730×100) | 185 / 57 | 604 / 71 | 653 / 85 | 670 / 76 | 717 / 99 | 723 / 102 |

  It starts blurred and tilted about −2°. Read it as a rotateX flip-up plus scaleX from the left plus a small rotateZ.
- **Text:**

| f | 10225 | 10226 | 10227 | 10228 | 10229 | 10230 | 10231 |
|---|---|---|---|---|---|---|---|
| op | .27 | .45 | .61 | .73 | .76 | .95 | 1 |
| dy | 20 | 15 | 10 | 5 | 5 | 0 | 0 |
| dx | 10 | 10 | 10 | 10 | 10 | 0 | 0 |
| blur r | 4 | 4 | 2 | 4 | 4 | 4 | 2 |

  Blur reaches 0 at 10232.
- **QUEST card timing:** hard cut at 10200, empty plate for 20 f, then the header (sparkle + "QUEST") at 10220–10223. All rows have settled by about 10237. It holds to 10265 and cuts at 10266.
- **Second QUEST pills:** the neighbouring 9:16 card fades out at 11965–69, and the shot cuts at 11971.

### D. Acronym row snap (PROOF, overlay)
- **Stagger:** 1 f per row. PROMISE 1472, RECEIPTS 1473, OFFER 1474, OBJECTION 1475, FIRST STEP 1476.
- **Per row:**

| row frame | f0 | f1 | f2 | f3 |
|---|---|---|---|---|
| opacity | ~0 | .29 | .83 | 1 |
| dy | ≥ +12 | +6 | 0 | 0 |
| blur r | 6 | 1 | 1 | 0 |

  All five rows give the same numbers (±0.03).
- The list sits on a 3D plane: rows shift right about 11 px each and the pitch shrinks 100 → 84 (perspective).
- It holds to 1497 and disappears on the camera cut at 1498.

### E. Numbered list (7:10)
- **1:** hard cut to the plate at 10320.
- **Rows:** the row-1 bar starts at 10322 (recipe C) and its text at 10324 (recipe A, settled 10330). Row 2's text starts at 10337 and rises 25 px over 12 f (top 508 → 483). Row 3 starts at about 10383.
- **Pacing:** rows are cued to the VO, not to a fixed stagger.
- **Icons:** each right-side icon pops about 12 f after its text (row 2 at 10349–56).
- It cuts out hard at 10452.

### F. Other overlay lists
- **Comparison list (4:09):**
  - STATIC 5990 and DIAGRAM 5992 use recipe A.
  - The arrow fades over 5993–96 (.14 .55 .76 .97) with no motion.
  - The pink line starts at 5998 (recipe A).
  - The second pair runs 6085–6099.
  - It vanishes on the cut at 6148. Rows sit on the same perspective plane as PROOF.
- **EXCLUSIVITY list:** recipe A mirrored, so words come down from y −16 (dy −16 −12 −6 −4 −2 0, opacity .02 .17 .40 .59 .74 .80 … 1 over 12 f). Words are cued to the VO: 10979, 10999, 11008. It cuts out at 11032.
- **ATTENTION list (2:49):** a typewriter at about 1.6 f per character (15 chars/s).
  - The red X appears first, at 4066.
  - Rows: 4071–4096, 4110–4137, 4141–4160.
  - Exit is 1 frame of fade at 4161, then the cut at 4162.

### G. Cold open (0–131)
1. **I SPENT / WEEKS pill (f0–23).**
   - The pill is already on screen at f0, slightly tilted.
   - "I SPENT" and the clock fade in at f1–4 (alpha .04 .22 .70 .88) and rise 38 px. Text top: 324 313 306 301 296 292 290 288 287 286. Fit: cubic-bezier(0, 0.457, 0.45, 1) over 10 f.
   - "WEEKS" and the calendar come in from heavy blur at f4–12. The calendar wobbles −8° → +3° → 0 → −3°, and the clock hands spin.
   - Exit is a whip LEFT of the elements only (the plate stays). Right edge: 1503 1496 1473 1431 1365 1265 1116 901 at f15–22. Fit: ease-in, cubic-bezier(0.635, 0.043, 0.406, 0.934). There is horizontal motion blur.
2. **Counter.**
   - Slides in from the right. Left edge: 1162 902 766 686 637 607 592 … 575 at f25–36. Fit: expo-out, cubic-bezier(0.108, 1, 0.517, 0.968) over 10.9 f.
   - Counts 0 → 10 000 over f24–44. Values: 63, 1557, 2893, 4080, 5127, 6043, 6836, 7515, 8089, 8568, 8959, 9271, 9514, 9696, 9825, 9912, 9963, 9990, then a blend frame, then 10,000. Fit: cubic-bezier(0.335, 0.947, 0.67, 0.996) over 17.9 f, rms ≈ 0.
   - "ADS" appears at f43–44.
   - At f50–64 the group rises 83 px and scales to 0.875. Fit: ease-in-out, cubic-bezier(0.539, 0.191, 0.269, 1) over 13.8 f.
   - "FOR" fades in at f52–54. The PRODUCTS & SERVICES pills rise in from +44 px over f58–63.
   - Exit is a vertical push up. Group cy: 515 514 508 496 469 447 (f76–81), then blurred off the top by f87.
3. **GPT-6 ASTRA.**
   - Rises from below while the counter is still leaving. cy: 619 587 567 555 550 548.5 at f88–93. Fit: cubic-bezier(0.261, 1, 1, 0.976) over 6.3 f.
   - The pink "ASTRA" letters fade in left to right at f86–89.
   - Hold has a slow push-in of +0.26 % per frame.
   - Exit is a whip-pan LEFT of the whole canvas over f119–131. The glow moves about −60, −60, −60, −120, −240, −300, −300, −240, −180, −120 px per frame. The next scene's cards come in from the right as part of the same pan.

### H. End card
- **Shrink:** from 14717 the presenter frame shrinks about its centre into the 178 px rounded logo tile. Frame bbox height: 1049 1027 993 948 879 785 660 526 411 361 334 (14717–27), ease-in-out.
- **Cross-dissolve:** the video dissolves into the logo over 14727–31. The glow plate shows from 14724.
- **Text:** the title fades in over 14741–48, and the URL over 14749–53.
- **Hold:** to the end of the file (14953). There is no fade.

## 4. SFX
I could not isolate a reliable SFX onset for any entrance in this family. The candidates are listed in `sfx` in the JSON:

| entrance | candidate onset |
|---|---|
| comparison word (5990) | 0 ms |
| end-card shrink (14717) | 0 to +20 ms |
| chapter card (whoosh-like HF swell) | peaks +70 ms |
| chapter exit (1676) | +40 ms |
| cold open (audio start / first hit) | +30 ms / +120 ms |

Each candidate overlaps the start of a VO word or the music. Confidence is low. A music/VO-stripped stem or the editor's SFX list would settle it.

## 5. Confidence (what would change it)
- **Frame indices:** exact.
- **Opacity:** ±0.03 on white or flat elements. ±0.1 on the gradient-animated words, because the colour flow cannot be separated from opacity.
- **dy:** ±1–2 px.
- **Blur:** qualitative.
- **3D rotations** (pill flip, perspective lists, calendar): estimated, not fitted. A per-frame homography fit would pin them.
- **Gradient flow:** the colours are measured, but what generates the flow is unknown.
- **Beziers:** fitted to quantised data, and several shapes fit within 1 %. Treat the per-frame tables and `pooled_model_values` as the truth and the bezier as one valid encoding of them.
- **Fonts:** Space Grotesk is high confidence. The GPT-6 and end-card sans are medium-low.
