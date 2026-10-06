# Numbers, stats & data cards: measured spec (reference gVPZU1btFA8)

24 fps, 1920x1080. All frame numbers are **absolute** reference frames (`round(t*24)`), taken with frame-exact seeks.
Machine-readable version with every per-frame table: `data-cards.json` (same folder).
Measurement scripts are in `/opt/aieditor-work/reference/work/data-cards/` (`fit.py` = opacity/shift/blur/scale model fit against a clean plate, `txa.py` = opacity of text without a clean plate, `border.py`, `card.py`, `col.py`, `band.py`).

> Sign convention: **dy > 0 = the element is below its rest position** (so it rises into place). dy < 0 = above (it drops into place).

> Kit warning: `strip.sh` labels are off by +1 frame whenever `START*24` has a fractional part below .5, because ffmpeg seeks to the next frame. Pass `START = (n-0.25)/24`.

---

## 1. Typography and design

### Font
**Space Grotesk Bold (700)** (Google Fonts) is used for every element in this family: numbers, `$`, labels, headings, pills and captions. It is all caps everywhere.
- **Evidence.** I rendered Space Grotesk 700 at the same size next to the reference crop (`work/data-cards/cmp1.png`), and the glyphs match. The distinctive shapes are:
  - the `1` has a long flag and no foot
  - the `3` has a flat, Z-like top (`41,023`, `30 DAYS`, `3 SALES`)
  - the `2` has a straight diagonal into a flat base
  - the `G` has a spur and a horizontal bar
  - the `N` has ink-trap notches
  - the `$` has a full vertical bar
- **Proportional, not monospaced.** The monospace pink "BUDGET" at 0:40 belongs to another family. Its likely partner is Space Mono Bold.
- **Rejected candidates:** Familjen Grotesk, Host Grotesk, Hanken, Schibsted, Archivo, Inter, Geist, Instrument Sans, Bricolage. They have a round-top 3 and/or a footed or short-flag 1.
- **Tracking:** about 0 (within ±2%).
- **Metrics used:** cap height 0.70 em. Glyph heights with overshoot are 0.73 em for letters, 0.93 em for `$` and 0.86 em for digits with a comma.

| element | px @1080p | colour |
|---|---|---|
| A-roll stack label (5 VIDEOS, TOTAL, 1 UGC AD) | 59–68 | #FFFFFF |
| A-roll small label (GENERAL / BUSINESS SPANISH) | 40 | #FFFFFF |
| A-roll value ($250, $100, $1,000, $100–$200) | 87–101 | animated gradient |
| A-roll hero value (~$100 @9:38) | 158 | gradient |
| HOOK RATE / CTR / CPL | 96–100 | gradient |
| $240 (5:01) / $$$ | 226 / 163 | gradient |
| A counter 48,000 / REACH label | 104 / 37 | white / gradient |
| A STILL RUNNING. / day counter / DAYS ACTIVE | 73 / 146 / 23 | white / gradient / white |
| B AD 1, AD 2 / REACH / 200, 20,000 / 1 DOT = 200 PEOPLE | 58 / 41 / 142 / 20 | white or gradient / white / white or gradient / #91909A |
| B header 30 DAYS / SAME BUDGET, pill text | 64, 36 | white, gradient |
| C $10 / SPEND / LEAD / SALES, $240 REVENUE, BAG, $80 | 56, 75, 30, 77 | white or gradient |

### Colour
**Gradient palette** (sampled from text cores):

| name | hex |
|---|---|
| yellow | #FDDF71 |
| coral | #FD8672 |
| peach | #FBAE78 |
| hot red | #FD0A3D |
| red-pink | #FC1E54 |
| magenta | #FE1680 |
| pink | #FD55B6 |
| pale pink | #FECADE |

**The gradient is animated** on every pink element, including the AD 2 border and the pill.
- The middle of a word stays hot red (#FD0A3D) for the whole 4.5 s measured.
- Both ends cycle yellow → coral → red → magenta → pink → pale pink, with no period visible within 4.5 s.
- **Most likely mechanism:** a multi-stop linear gradient whose angle rotates about the text centre. This is inferred, not measured.
- Samples across `= $250` over time are in the JSON (`gradient_samples_E250`).
- The "=" starts yellow, and the `$` is often pale pink.

**Full-screen background**
- The centre is #040404.
- Corners have maroon glows, strongest at bottom-left (#381216) and top-right (#2A0F12–#3E141B).
- The glow drifts or pulses between scenes.
- There are faint 1-px dots on a grid of about 180 px.

**Fills, strokes and grids**
- Card fill is #0B0A0D (B cards, pill) and #0E1010 (C product card).
- Divider is #2A2C2C, 2 px.
- Arrow stroke is 3 px with round caps: grey (~#8A9092) on row 1 and gradient pink on row 2.
- Dot grid: off #292830, on #FCFCFE or gradient.

### Geometry
**A: ad card**
- Size 463×671, corner radius about 28, white.
- Rest poses (cx, cy, rotation):
  - centre: (1046, 546), −5.1°
  - right: (1314, 568), −2.4°
  - left, scaled 0.70: (300, 578), 0°

**B: ad comparison cards**
- AD1 at [155,252,905,907] and AD2 at [1015,252,1765,908]. Each is 750×655, corner radius about 28, with a 110 px gap between them.
- The border is 3 px. It is always on for AD2; AD1 has it only from 3431 to 3497.
- The pill is [730,938,1190,1012] with a fully rounded end and a 2 px pink border.

**C: funnel**
- Product card [128,280,622,800], containing an image at [150,302,600,600].
- Row centres y = 380 and 660; column centres x = 830, 1220, 1610.
- Arrows are 85 px long with 13 px heads.
- Divider [724..1730, y = 519].
- `$240 REVENUE` is centred at x = 1220, y = 885.

**A-roll stacks**
- Left-aligned at x = 110 (0.057) on the front camera and 130–320 (0.068–0.166) on the side camera.
- They stay inside the left 0.43 of the frame.
- Normalised boxes per element are in the JSON (`geometry.normalised_layout`).

---

## 2. The recipes (keyframes at 24 fps, fitted)

### R1: floating drop-in (A-roll numbers beside the presenter: E, F, G, H)
This recipe covers 15 lines in 5 instances. They all match to within ±1 px and ±0.05 opacity. Keyframes are relative to k0, the first visibly drawn frame.

| property | keyframes | easing (fitted cubic-bezier) | residual |
|---|---|---|---|
| opacity | k−2: 0 → k+7: 1 | (0.50, 0, 0.40, 1) | rms 0.016 |
| translateY | k−2: −15.4 px → k+7: 0 (drops down) | (0.40, 0.40, 0.30, 1) | rms 0.06 px |
| blur σ | k−2: ~4 px → k+4: 0 | same as y | σ grid ±1 px |
| scale, x | none | | |

| k | 0 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|---|
| measured opacity (mean of the white lines) | .075 | .209 | .444 | .718 | .840 | .945 | 1 |
| model | .072 | .212 | .449 | .698 | .862 | .951 | .992 |
| measured dy (px) | −10.5 | −7 | −4 | −2 | −1 | −0.5 | 0 |
| measured blur σ | 2–3 | 1 | 1 | 1 | 0 | 0 | 0 |

**Stagger:** each line, or each word group on a line, is triggered by speech. Measured gaps are 13–59 frames, so there is no fixed stagger. `5 VIDEOS` and `× $50` enter separately on one line.

**Exit:**
- G, H, D: a hard cut with the shot.
- E, F: all lines fade together over 3 frames (1 → .77 → .32 → .03 → 0, ease-in).
  - In E the fade starts on the cut frame and plays over the new shot.
  - In F it ends on the cut.

### R2–R5: rise-ups (full-screen cards and A-roll hero values)

| variant | used for | duration | opacity bezier | y | blur / scale |
|---|---|---|---|---|---|
| R2 fast rise | STILL / RUNNING., AD labels | 4 f (start k−0.5) | (0.2,0,0.6,1), rms .008 | +11 → 0, (0.3,0,0.6,1), rms .07 px | none |
| R3 slow rise | funnel cells, $80, $240 REVENUE | 10 f (start k−1) | (0.4,0,0.8,1), rms .006 | +14 → 0, ~linear (0.6,0.6,0.9,1), rms .23 px | σ 4 → 2 → 1 → 0 |
| R4 number pop | 200 / 20,000 card counters | 6 f (start k−1) | (0.1,0,0.6,1), rms .014 | +23 at k0 (~+30 at start) → 0 | scale .875–.925 → 1 by k+1; σ 6–8 at k0 → 0 |
| R5 A-roll hero rise | $240, $ $ $ | 7–9 f | .03 .23 .49 .74 .93 1 | +12…+16 → 0 | σ 8 → 2 → 1 → 0; $$$ stagger 3–4 f |

### Count-up
- **Easing:** cubic-bezier(0.65, 0, 0.35, 1), which is easeInOutCubic.
- **Rounding and format:** Math.round with en-US grouping. `$` is glued to the digits, ranges use an en dash (`$100–$200`), approximate values use `~`, and multiplication uses `×` (U+00D7).
- **REACH:** counts 1,200 → 48,000 over 33 frames (3320 → 3353), shown on 3321–3353. The fit reproduces all 33 displayed values exactly (residual 0). The number fades in during the first 3 frames: about .25 (blurred), then .6, then 1.
- **Days:** counts 1 → 14 over 26 frames (start 3283.75), zero-padded `01`. The fit matches 22 of 23 frames. The reference skips `08`.
- **B cards:** the count is already 99% done on the first visible frame (198 → 200; 19,776 → 20,000). The R4 reveal carries the motion.

### Other shared motions
- **Big card moves:** easeInOutCubic over 19.5 frames with directional motion blur at mid-move (slide right rms 1.4 px, slide left + scale to 0.70 rms 3.7 px).
- **Border trace:** clockwise from the top-right corner, 13.5 frames, cubic-bezier(0.60, 0, 0.50, 1), rms .013. The leading end is a bright hot-spot.
- **Arrow draw:** 6 frames. The shaft draws over 3 frames (.22, .53, 1.0), then the head arms draw for 1 frame and then 2 frames.
- **Full-screen content fade-out:** 6 frames (1, .95, .81, .61, .40, .20, .05, 0). The background glow stays.
- **Card "materialise":**
  - A grey flat placeholder rectangle brightens over about 4 frames (A card luma 54 → 137 → 210 → 236; notifications grey → white → content in 3 frames).
  - Then the inner content fades in, staggered 1–2 frames per text row.

---

## 3. Per instance (first visible frame → settle, hold, exit)

| instance | entrances (first visible f) | recipe | hold | exit |
|---|---|---|---|---|
| **A** 2:14.8 active ad card | see section 3A below | own | 3240–3411 | content fade 3406–3412 |
| **B** 2:22 AD1 vs AD2 | AD1 body 3416–3419; border 3418–3431; label 3421; header 30 DAYS / 3445–3447; dot grid + REACH 3456–3462; 200 at 3471; AD1 border off 3497–3499; AD2 body 3494–3497; border 3495–3508; label 3500; dot gradient fill 3517–3527; REACH 3518; 20,000 at 3523; pill `100×` 3528, `MORE REACH` 3533; SAME 3545, BUDGET ~3549 (word fade with blur) | R2, R4, border trace | to 3599 | hard cut 3600 |
| **C** 4:51.9 funnel | image 7006 (fades in 63 px low, then slides up 7010–7021); BAG 7012; $80 7030; row 1: $10 SPEND 7054 → arrow 7070 → 1 LEAD 7080 → arrow 7094 → 0 SALES 7103; divider fade 7119–7122 (.19 .50 .75 .97); row 2: $10 SPEND 7126 → pink arrow 7142 → 10 LEADS 7151 → arrow 7166 → 3 SALES 7175; $240 REVENUE 7192 | R3, arrows | to 7231 | 1-frame 50% dissolve at 7232 |
| **D** 5:01 $240 / $$$ | $240 at 7233 (R5, rises +16); $ $ $ at 7308 / 7311 / 7315 | R5 | 7233–7273; 7308–7362 | hard cuts at 7274 and 7363 |
| **E** 6:03.9 | 5 VIDEOS 8769; × $50 8787; = $250 8808 (second line) | R1 | 8769–8920 | 3-frame fade 8921–8923 over the new shot |
| **F** 7:24 | GENERAL SPANISH 10669; $100 10709; BUSINESS SPANISH 10732; $1,000 10778 | R1 | to 10804 | fade 10805–10806, cut 10807 |
| **G** 9:28 | HOOK RATE 13694; CTR 13711; CPL 13725 (stagger 17 / 14 f) | R1 | to 13752 | hard cut 13753 |
| **H1** 9:38 | TOTAL 13879; ~$100 13886 | R1 | to 13909 | hard cut 13910 |
| **H2** 9:51.9 | TOTAL ~$100 14215; 1 UGC AD 14274; $100–$200 14301 | R1 | to 14366 | hard cut 14367 |

Per-frame tables for every line (opacity, dy, blur) are in the JSON under `entrance_tables_floating_dropin` and `entrance_tables_rise`.

Example, E "5 VIDEOS":

| frame | 8769 | 8770 | 8771 | 8772 | 8773 | 8774 | 8775 |
|---|---|---|---|---|---|---|---|
| opacity | .081 | .228 | .472 | .729 | .849 | .945 | 1 |
| dy | −11 | −7 | −4 | −2 | −1 | 0 | 0 |
| blur σ | 2 | 1 | 1 | 1 | 0 | 0 | 0 |

### 3A. Active ad card scene (the "count-up" scene)
1. **3240:** cut to the black card background.
2. **Card materialises:** 3241–3247 (luma ramp; rotation +4.6° → −5.1°; rises about 44 px and moves about 60 px right). Inner texts stagger in over 3246–3256.
3. **Clock icon:** draws in from 3254.
4. **Card slides right:** 3250–3270. Then a small nudge of +28 px over 3271–3276.
5. **Headline:** STILL at 3276 and RUNNING. at 3283, both R2. The clock shrinks out over 3278–3281.
6. **Day counter:** 01 → 14 over 3283–3305.
7. **Card slides left and shrinks to 0.70:** 3300–3320. The left column fades out with motion blur over 3307–3311.
8. **REACH count:** 3321–3353. A 10×5 grid of person icons fills in step with the count.
9. **Heading words** (MORE CHANCES TO CONVERT): 3352, 3357, 3370, 3373.
10. **Notifications:** 3357, 3363, 3370, 3374 (stagger about 6–7 frames).
11. **Exit:** content fade 3406–3412, then empty background until 3417.

REACH per frame:

| frame | value | frame | value | frame | value |
|---|---|---|---|---|---|
| 3321 | 1,235 | 3332 | 10,108 | 3343 | 42,600 |
| 3322 | 1,346 | 3333 | 12,469 | 3344 | 43,884 |
| 3323 | 1,542 | 3334 | 15,332 | 3345 | 44,927 |
| 3324 | 1,833 | 3335 | 18,731 | 3346 | 45,769 |
| 3325 | 2,234 | 3336 | 22,582 | 3347 | 46,440 |
| 3326 | 2,760 | 3337 | 26,618 | 3348 | 46,966 |
| 3327 | 3,431 | 3338 | 30,469 | 3349 | 47,367 |
| 3328 | 4,273 | 3339 | 33,868 | 3350 | 47,658 |
| 3329 | 5,316 | 3340 | 36,731 | 3351 | 47,854 |
| 3330 | 6,600 | 3341 | 39,092 | 3352 | 47,965 |
| 3331 | 8,177 | 3342 | 41,023 | 3353 | 48,000 |

Days per frame (3284–3305): 1 1 1 1 1 2 2 2 3 3 4 5 6 7 9 10 11 12 13 13 13 14.

---

## 4. SFX
Voice runs continuously under these graphics, so only sounds with a clear spectral signature are reported.

| event | onset | offset vs visual | confidence |
|---|---|---|---|
| REACH counter tick roll | 138.57 s → 139.74 s | +240 ms after the first visible frame (3321). Last tick lands on the final value (3353.6). Spacing 20–30 ms mid-count, slowing to 70–75 ms. Tonal partials at ~2.9, 8.9 and 15 kHz. | medium-high |
| Day counter ticks | 137.08–137.70 s | sparse, during 01 → 14 | low-medium |
| B border trace riser (rising chirp) | 142.40 s (frame 3417.6); 145.68 s (frame 3496.3) | 0 ms (AD1) and +60 ms (AD2) vs trace start; lasts ~0.4 s | medium |
| B dot / number ticks | 144.02–145.30 s | over 3456–3487, spacing 55–70 ms | medium |
| B AD2 shimmer chime | 146.57 s (frame 3517.7) | starts with the AD2 dot fill, −230 ms before 20,000 appears | medium |
| Floating overlays E/F/G/H/D, funnel C | none found | the shot-list "pop" / "cash ding" could not be isolated from voice and music | medium (absence) / low (C) |

---

## 5. Confidence and what would change it
- **Font:** high. A glyph overlay matches.
- **R1 timing, travel and opacity:** high (15 lines agree). The invisible start (k−2, 15.4 px) is inferred from the fit. Any start/travel pair on the same curve gives identical visible frames. Blur σ is medium: σ was fitted on a 1 px grid and is confounded with opacity at low values.
- **Count-up easing:** very high for REACH (exact) and high for days (22 of 23 frames).
- **R2–R5:** medium. Fewer samples, and the animated gradient biases the opacity estimate low after k+3 (R² 0.8–0.95). Timing is unaffected.
- **Card slides:** high for x. Rotation is ±0.3° (moment-based).
- **A card entrance:** medium-low. 2D moments of a half-faded card give the +4.6° → −5.1° rotation, but a 3D flip would look similar. Check frames 3243–3246 visually before building.
- **Sizes:** ±3% (derived from ink height and font metrics).
- **Colours:** medium (anti-aliasing and compression). Gradient frames are single samples of an animation.
- **Gradient mechanism** (rotating linear vs drifting mesh): low-medium. A longer colour time-series fitted to a rotating-gradient model would settle it.
- **SFX:** see the table. Isolating the music/voice stems (e.g. a source-separation pass) would confirm or refute pops under the speech.
- **Not curve-fitted, only frame-timed:** B notifications, the person/dot grids and the word-by-word headings. Fitting them with `fit.py` on tight ROIs would firm these up.
