# Keyword text over footage — measured spec (gVPZU1btFA8)

Measured frame by frame from the 1080p/24fps reference. Every number below comes from a per-line layer fit (`frame = ref + a · blur(σx,σy)(warp(s,dx,dy)(final − ref))`) unless marked otherwise. k = 0 is the first frame on which a line is visible.

## 1. Recipe (what to build)

* **Font**: Space Grotesk 700, ALL CAPS, tracking ≈ −0.017 em, line gap 0.38–0.42 em (line-height ≈ 1.10).
* **Two-tone**: one white line (#FFFFFF, sampled #FDFDFD) + one keyword line filled with an animated pink→red→peach→yellow gradient.
* **Entrance (standard RISE, A B C D G)**: fade + slide up + vertical motion blur, 8 frames. Line 2 = same tween, delayed (median 2 f).
* **Hold**: completely static except the gradient fill drifting.
* **Exit**: hard cut (one frame). Variant D: slide up 0.24 em over 9 f, then a 2-frame fade.
* **Shadow**: none, except the early cards A/B (soft −4/+6 px, blur ≈32 px, black 65 %).
* **Perspective**: on 3/4 side-angle shots the lines are keystoned onto the wall plane (right edge 0.93–0.96× height).

### Keyframes — RISE (standard)

| k (frames) | −0.5 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|---|
| opacity | 0 | 0.025 | 0.145 | 0.335 | 0.550 | 0.755 | 0.883 | 0.969 | 0.999 | 1 |
| translateY (em, +down) | 0.337* | 0.280 | 0.185 | 0.115 | 0.066 | 0.037 | 0.016 | 0.005 | 0 | 0 |
| motion-blur σy (em) | – | 0.031 | 0.017 | 0.012 | 0.007 | 0.004 | 0 | 0 | 0 | 0 |
| blur σx (em) | – | 0.010 | 0.010 | 0.008 | 0.004 | 0 | 0 | 0 | 0 | 0 |

\* extrapolated (invisible). Averages of A, B (129–131 px), C (64 px), D (88–93 px): em-normalised curves agree within ±0.02 em.

**Easing fits (start k = −0.5):**

| property | duration | cubic-bezier | rms | residuals k0…k8 |
|---|---|---|---|---|
| opacity 0→1 | 7.40 f | (0.368, 0.101, 0.493, 0.937) | 0.0032 | −.003 .001 .001 −.005 .005 −.004 .001 −.001 0 |
| translateY 0.337 em→0 | 7.53 f | (0.236, 0.620, 0.455, 0.970) | 0.00056 em | −.0003 .0003 .0002 −.0011 .0011 −.0003 −.0001 −.0001 0 |

Opacity is a soft S (≈ ease-in-out); position is a strong ease-out (≈ expo/power3-out): the two are different curves on the same start/duration. Blur is directional and proportional to speed — σy ≈ (px moved this frame)/√12 — i.e. 360°-shutter motion blur, not a filter ramp.

### Other entrance variants

| variant | instances | opacity (k0…) | translateY | ease fit (opacity) |
|---|---|---|---|---|
| RISE fast | H | .036 .136 .312 .591 .874 1.0 | +0.153 → 0 em in 5 f | 5.26 f, (0.640,0.201,0.633,0.765), rms .001 |
| DROP (from above) | F, I | .014 .126 .319 .540 .741 .884 .956 .995 1 | F: −0.167 −0.106 −0.061 −0.030 −0.015 0 em (k1…k6); I ≈ 60 % of that | 7.89 f, (0.339,0.027,0.457,0.997), rms .0034 |
| SLOW DROP | E (CPL card) | E1: .016 .106 .208 .326 .433 .528 .614 .673 .755 .811 .866 .900 … 1.0 @k19 | E1 −16 px → 0 over ~12 f | E1 17.8 f (0.135,0.031,0.337,1.007); E2 14.8 f (0.386,0.058,0.442,1.002) |

**Line stagger**: line 2 uses the same tween, delayed N frames: A 1, B 2, D 0, E 7, F 5, G 2, H 14, I 2 (median 2). No per-word or per-letter stagger inside a line. Top line always first.

### Exit

* Default: hard cut in one frame (C, E, F, G, H, I: together with the camera cut).
* A, B: hard cut mid-shot after exactly 35 visible frames (A 5 f before the camera cut, B 56 f before). The text is pixel-static right up to its last frame.
* D: slide up 0 → −22.5 px (−0.24 em) over 9 f (ease ≈ cubic-bezier(0.241, −0.063, 0.733, 1.116), rms 0.005), then opacity 1.0 → 0.20 → 0.02 in the last 2 frames before the camera cut.

| D exit frame | 5875 | 5876 | 5877 | 5878 | 5879 | 5880 | 5881 | 5882 | 5883 | 5884 | 5885 | 5886 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| opacity | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 0.20 | 0.02 | cut |
| translateY px | 0 | −1.5 | −4 | −6.5 | −10 | −13 | −16 | −19 | −21 | −22.5 | – | – |

### Relation to cuts and speech

* The graphic lives on the edit timeline, not the shot: G starts 2 frames **before** a camera cut and keeps animating across it; B starts 2 f after a cut; A, C, D, E, F start 30–80 f into their shot.
* The first visible frame leads the spoken keyword by ~140–300 ms (auto-caption word times, ±100 ms).

## 2. Typography

* **Font: Space Grotesk 700** (Google Fonts). Evidence: I rendered the candidates with ffmpeg drawtext and scored them against the reference glyph masks. Space Grotesk 700 ranks #1 on every flat line (KEEP IT SIMPLE IoU 0.924, COST PER LEAD 0.921, HOW TO 0.921, FIND CLIENTS 0.838, A/B 0.826) and per-word on SAVE THE / BUDGET / TEST THE. The telltale letters: W with near-vertical outer strokes; B and D with a flat spur at the stem–bowl join (this is what made BUDGET look slab/"monospace" — it is not monospaced); G with a spur and bar; S with flat terminals. Alternates: Space Grotesk 600 (slightly too light), Familjen Grotesk 700 (W matches, B/D don't). Rejected: Anton/condensed, IBM Plex Mono, Space Mono, Inter, Host Grotesk, Geist, Bricolage.
* **Sizes @1080p** (cap height = 0.70 × size): A/B 129–131 px (cap 88–94), D/G 86–97 px, frontal wide shots 64–79 px (cap 44–54), emphasised acronym line 104–119 px (CPL, A/B), with its white subline 55–67 px.
* **Tracking** −0.017 em (≈ −1 px at 65 px); **line gap** 0.38–0.42 em; centre-aligned on A B D E, left-aligned on C F G H I.
* **White** #FFFFFF (sampled #FDFDFD, flat).
* **Pink gradient** (animated): red #FA0030 / #FD0239 · hot pink #FF1270 (BUDGET median #FD1267) · pink-magenta #F84187 / #FF50B2 · peach #FF8A70 / #FBA285 · yellow #FFE972 on the right end of CPL, A/B and FIND CLIENTS. Nearly flat top→bottom; it varies left→right and drifts over time (BUDGET's right end goes #FB606C → #FE7E79 → #FB1577 between k8 and k34). Suggested build: `linear-gradient(90deg,#FF1470 0%,#FF0035 35%,#FF1A75 70%,#FF7A78 90%,#FFE872 100%)` with background-position sliding about ±30 % over ~1.5 s (shape and speed low confidence).
* **Shadow**: A, B only — gaussian σ 16 px (CSS blur ≈ 32 px), offset (−4, +6) px, black ≈ 0.65 (fit rmse 0.022 against a background std of 0.073). C–I: none. **No glow** on any card, CPL included; the "glow" is the bright gradient itself.
* **Perspective** (3/4 shots A, B, D, H): each line is keystoned onto the wall plane — the right edge is 0.93–0.96 × the left-edge height, line 1 tilts +0.6…0.9° and line 2 tilts −0.5…−1.3°, with the vanishing point to the right and the horizon around y ≈ 330. Use the per-line quads in the JSON (`line_quads_px`). Frontal shots are flat.
* **Position**: on the empty wall left of the presenter; the block centre sits at x 0.11–0.34, y 0.23–0.36 of the frame and never overlaps the head.

| card | block bbox (norm x0,y0,x1,y1) | centre | align | sizes px |
|---|---|---|---|---|
| A SAVE THE / BUDGET | [0.154, 0.187, 0.444, 0.414] | [0.299, 0.3] | centre | [129, 129] |
| B WHAT TO / OFFER? | [0.159, 0.189, 0.435, 0.414] | [0.297, 0.301] | centre | [131, 131] |
| C KEEP IT SIMPLE | [0.127, 0.212, 0.352, 0.255] | [0.239, 0.233] | left (single line) | [64.4] |
| D WHAT ABOUT / VIDEO? | [0.153, 0.184, 0.442, 0.342] | [0.297, 0.263] | centre | [93, 88] |
| E CPL / COST PER LEAD | [0.136, 0.169, 0.374, 0.345] | [0.255, 0.257] | centre | [119, 67] |
| F HOW TO / FIND CLIENTS | [0.057, 0.278, 0.261, 0.388] | [0.159, 0.333] | left | [65.8, 65.8] |
| G WHAT AD DO WE / RUN NEXT? | [0.081, 0.31, 0.396, 0.477] | [0.239, 0.394] | left | [86, None] |
| H TEST THE / ORGANIC FIRST | [0.208, 0.251, 0.472, 0.414] | [0.34, 0.332] | left | [75, 79] |
| I A/B / TEST | [0.071, 0.285, 0.156, 0.425] | [0.113, 0.355] | left | [104, 55] |

## 3. Per-instance measurements

### A — SAVE THE / BUDGET  (first frame 970, 40.417 s)

* Shot: 3/4 side-angle MCU (wall recedes; text in perspective); shot frames 927–1009. Direction: rise (from below).
* Line first-visible frames [970, 971], settled [977, 978], line-2 delay 1 f.
* Last visible frame 1004; visible 35 f; hold after line-1 settle 27 f.
* Exit: hard cut-out (1 frame, no fade/move) mid-shot (first frame without text: 1005).

A1 entrance (k = frame − 970; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 970 | 0 | 0.030 | +36.0 | +2.5 | 0.992 | 1.0 | 4.0 | 0.5755 |
| 971 | 1 | 0.156 | +23.5 | +1.5 | 0.996 | 1.5 | 2.0 | 0.1192 |
| 972 | 2 | 0.350 | +14.5 | +1.0 | 0.996 | 1.0 | 1.5 | 0.0385 |
| 973 | 3 | 0.560 | +8.0 | +0.5 | 1.000 | 0.5 | 1.0 | 0.0190 |
| 974 | 4 | 0.756 | +4.5 | +0.5 | 1.000 | 0.0 | 0.5 | 0.0117 |
| 975 | 5 | 0.887 | +1.5 | +0.0 | 1.000 | 0.5 | 0.0 | 0.0062 |
| 976 | 6 | 0.969 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0019 |
| 977 | 7 | 0.999 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0002 |

A2 entrance (k = frame − 971; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 971 | 0 | 0.032 | +32.5 | +2.0 | 0.992 | 1.5 | 3.5 | 0.9021 |
| 972 | 1 | 0.220 | +22.0 | +1.5 | 0.996 | 2.0 | 2.5 | 0.3176 |
| 973 | 2 | 0.448 | +14.0 | +1.0 | 0.996 | 1.0 | 1.5 | 0.1457 |
| 974 | 3 | 0.648 | +8.0 | +0.5 | 1.000 | 0.5 | 0.5 | 0.0873 |
| 975 | 4 | 0.809 | +4.0 | +0.0 | 1.000 | 0.5 | 0.5 | 0.0520 |
| 976 | 5 | 0.900 | +2.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.0343 |
| 977 | 6 | 0.962 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0207 |
| 978 | 7 | 0.984 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0069 |
| 979 | 8 | 0.993 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0023 |
| 980 | 9 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0000 |

### B — WHAT TO / OFFER?  (first frame 1261, 52.542 s)

* Shot: 3/4 side-angle MCU; shot frames 1259–1351. Direction: rise.
* Line first-visible frames [1261, 1263], settled [1268, 1269], line-2 delay 2 f.
* Last visible frame 1295; visible 35 f; hold after line-1 settle 27 f.
* Exit: hard cut-out mid-shot (first frame without text: 1296).

B1 entrance (k = frame − 1261; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 1261 | 0 | 0.029 | +36.0 | +2.5 | 0.992 | 1.5 | 4.5 | 0.5802 |
| 1262 | 1 | 0.155 | +23.0 | +1.5 | 0.996 | 1.5 | 2.0 | 0.1075 |
| 1263 | 2 | 0.348 | +14.5 | +1.0 | 0.996 | 1.0 | 1.5 | 0.0356 |
| 1264 | 3 | 0.554 | +8.0 | +0.5 | 1.000 | 0.5 | 1.0 | 0.0175 |
| 1265 | 4 | 0.756 | +4.5 | +0.5 | 1.000 | 0.0 | 0.5 | 0.0113 |
| 1266 | 5 | 0.888 | +1.5 | +0.0 | 1.000 | 0.5 | 0.0 | 0.0056 |
| 1267 | 6 | 0.969 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0016 |
| 1268 | 7 | 0.999 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0002 |

B2 entrance (k = frame − 1263; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 1263 | 0 | 0.032 | +33.0 | +1.0 | 0.982 | 2.0 | 2.0 | 0.8873 |
| 1264 | 1 | 0.211 | +22.0 | +1.5 | 0.996 | 2.0 | 2.5 | 0.3256 |
| 1265 | 2 | 0.444 | +14.0 | +1.0 | 0.996 | 1.0 | 1.5 | 0.1372 |
| 1266 | 3 | 0.637 | +8.0 | +0.5 | 1.000 | 0.5 | 0.5 | 0.0820 |
| 1267 | 4 | 0.790 | +4.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.0524 |
| 1268 | 5 | 0.888 | +2.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.0390 |
| 1269 | 6 | 0.953 | +0.5 | +0.0 | 1.000 | 0.0 | 0.5 | 0.0340 |
| 1270 | 7 | 0.969 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0266 |
| 1271 | 8 | 0.975 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0258 |
| 1272 | 9 | 0.978 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0245 |
| 1273 | 10 | 0.983 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0223 |
| 1274 | 11 | 0.984 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0213 |
| 1275 | 12 | 0.986 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0201 |
| 1276 | 13 | 0.987 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0192 |
| 1277 | 14 | 0.988 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0173 |
| 1278 | 15 | 0.989 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0143 |
| 1279 | 16 | 0.993 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0113 |
| 1280 | 17 | 0.995 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0081 |
| 1281 | 18 | 0.998 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0061 |
| 1282 | 19 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0036 |
| 1283 | 20 | 0.998 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0023 |
| 1284 | 21 | 0.997 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0020 |

### C — KEEP IT SIMPLE  (first frame 4860, 202.5 s)

* Shot: frontal wide (desk + laptop); shot frames 4815–4915. Direction: rise.
* Line first-visible frames [4860], settled [4867], line-2 delay None f.
* Last visible frame 4915; visible 56 f; hold after line-1 settle 48 f.
* Exit: hard cut together with camera cut (first frame without text: 4916).

C1 entrance (k = frame − 4860; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 4860 | 0 | 0.019 | +19.5 | +0.0 | 1.000 | 1.0 | 2.0 | 0.5715 |
| 4861 | 1 | 0.134 | +13.0 | +0.0 | 1.000 | 1.0 | 1.0 | 0.1156 |
| 4862 | 2 | 0.320 | +8.0 | +0.0 | 1.000 | 0.5 | 1.0 | 0.0527 |
| 4863 | 3 | 0.538 | +4.5 | +0.0 | 1.000 | 0.5 | 0.0 | 0.0266 |
| 4864 | 4 | 0.753 | +2.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0161 |
| 4865 | 5 | 0.884 | +1.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0052 |
| 4866 | 6 | 0.975 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.0127 |
| 4867 | 7 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0008 |

### D — WHAT ABOUT / VIDEO?  (first frame 5861, 244.208 s)

* Shot: 3/4 side-angle MCU; shot frames 5823–5885. Direction: rise.
* Line first-visible frames [5861, 5861], settled [5868, 5868], line-2 delay 0 f.
* Last visible frame 5885; visible 25 f; hold after line-1 settle 17 f.
* Exit: slide UP 22.5 px over 9 f (eased), then 2-frame fade (1.0 -> 0.20 -> 0.02), ends 1 f before camera cut (first frame without text: 5886).

D1 entrance (k = frame − 5861; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 5861 | 0 | 0.019 | +25.0 | +1.5 | 0.996 | 1.5 | 2.5 | 0.6320 |
| 5862 | 1 | 0.134 | +16.5 | +1.0 | 0.996 | 1.0 | 1.5 | 0.1142 |
| 5863 | 2 | 0.319 | +10.5 | +0.5 | 0.996 | 0.5 | 1.0 | 0.0456 |
| 5864 | 3 | 0.533 | +6.5 | +0.5 | 1.000 | 0.0 | 0.0 | 0.0222 |
| 5865 | 4 | 0.749 | +3.5 | +0.0 | 1.000 | 0.5 | 0.0 | 0.0163 |
| 5866 | 5 | 0.879 | +2.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0070 |
| 5867 | 6 | 0.964 | +1.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0021 |
| 5868 | 7 | 1.007 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0053 |
| 5869 | 8 | 1.007 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0051 |
| 5870 | 9 | 1.007 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0051 |
| 5871 | 10 | 1.008 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0052 |
| 5872 | 11 | 1.007 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0051 |
| 5873 | 12 | 1.007 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0051 |
| 5874 | 13 | 1.007 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0051 |
| 5875 | 14 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0000 |

D2 entrance (k = frame − 5861; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 5861 | 0 | 0.029 | +24.0 | +1.5 | 0.996 | 2.0 | 2.5 | 0.3842 |
| 5862 | 1 | 0.149 | +16.0 | +1.0 | 0.996 | 1.0 | 1.5 | 0.0824 |
| 5863 | 2 | 0.336 | +10.0 | +0.5 | 0.996 | 0.5 | 1.0 | 0.0340 |
| 5864 | 3 | 0.546 | +6.0 | +0.5 | 1.000 | 0.0 | 0.5 | 0.0168 |
| 5865 | 4 | 0.761 | +3.5 | +0.0 | 1.000 | 0.5 | 0.0 | 0.0128 |
| 5866 | 5 | 0.883 | +2.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0076 |
| 5867 | 6 | 0.971 | +1.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0021 |
| 5868 | 7 | 1.010 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0067 |
| 5869 | 8 | 1.012 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0065 |
| 5870 | 9 | 1.012 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0065 |
| 5871 | 10 | 1.012 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0065 |
| 5872 | 11 | 1.012 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0065 |
| 5873 | 12 | 1.012 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0065 |
| 5874 | 13 | 1.011 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0065 |
| 5875 | 14 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0000 |

### E — CPL / COST PER LEAD  (first frame 6909, 287.875 s)

* Shot: frontal wide; shot frames 6879–6935. Direction: DROP (from above), SLOW (~2.2x duration).
* Line first-visible frames [6909, 6916], settled [6928, 6929], line-2 delay 7 f.
* Last visible frame 6935; visible 27 f; hold after line-1 settle 7 f.
* Exit: hard cut with camera cut (first frame without text: 6936).

E1 entrance (k = frame − 6909; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 6909 | 0 | 0.016 | -7.0 | +1.5 | 1.014 | 1.5 | 22.5 | 0.9698 |
| 6910 | 1 | 0.106 | -16.0 | +0.5 | 1.000 | 2.0 | 5.0 | 0.5582 |
| 6911 | 2 | 0.208 | -12.0 | +0.0 | 1.000 | 2.0 | 3.5 | 0.4473 |
| 6912 | 3 | 0.326 | -9.0 | +0.0 | 0.996 | 1.5 | 2.0 | 0.3830 |
| 6913 | 4 | 0.433 | -7.0 | +0.0 | 0.996 | 1.0 | 2.0 | 0.3375 |
| 6914 | 5 | 0.528 | -5.5 | +0.0 | 0.996 | 1.0 | 1.5 | 0.3021 |
| 6915 | 6 | 0.614 | -4.0 | +0.0 | 0.996 | 0.5 | 1.5 | 0.2846 |
| 6916 | 7 | 0.673 | -3.0 | +0.0 | 0.996 | 0.5 | 1.5 | 0.2643 |
| 6917 | 8 | 0.755 | -2.0 | +0.0 | 1.000 | 0.5 | 1.0 | 0.2291 |
| 6918 | 9 | 0.811 | -1.5 | +0.0 | 1.000 | 0.5 | 1.0 | 0.2020 |
| 6919 | 10 | 0.866 | -1.0 | +0.0 | 1.000 | 0.0 | 1.0 | 0.1721 |
| 6920 | 11 | 0.900 | -0.5 | +0.0 | 1.000 | 0.0 | 0.5 | 0.1444 |
| 6921 | 12 | 0.933 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.1143 |
| 6922 | 13 | 0.956 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.0881 |
| 6923 | 14 | 0.971 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0643 |
| 6924 | 15 | 0.981 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0464 |
| 6925 | 16 | 0.989 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0291 |
| 6926 | 17 | 0.997 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0182 |
| 6927 | 18 | 0.998 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0105 |
| 6928 | 19 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0059 |

E2 entrance (k = frame − 6916; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 6906 | -10 | 0.015 | -14.0 | +74.5 | 0.986 | 7.5 | 109.5 | 0.9532 |
| 6907 | -9 | 0.015 | -14.0 | +74.5 | 0.986 | 7.5 | 109.5 | 0.9528 |
| 6908 | -8 | 0.020 | -14.0 | +73.5 | 0.986 | 7.5 | 111.5 | 0.9860 |
| 6910 | -6 | 0.000 | -15.5 | +0.0 | 1.000 | 0.5 | 1.5 | 1.0000 |
| 6911 | -5 | 0.000 | -15.5 | +0.0 | 1.000 | 0.5 | 1.5 | 1.0000 |
| 6912 | -4 | 0.000 | -15.5 | +0.0 | 1.000 | 0.5 | 1.5 | 1.0000 |
| 6913 | -3 | 0.000 | -15.5 | +0.0 | 1.000 | 0.5 | 1.5 | 1.0000 |
| 6914 | -2 | 0.000 | -15.5 | +0.0 | 1.000 | 0.5 | 1.5 | 1.0000 |
| 6915 | -1 | 0.000 | -15.5 | +0.0 | 1.000 | 0.5 | 1.5 | 1.0000 |
| 6916 | 0 | 0.006 | -15.5 | +0.0 | 1.000 | 0.5 | 1.5 | 0.9701 |
| 6917 | 1 | 0.034 | -12.0 | +0.0 | 1.000 | 1.0 | 1.0 | 0.8215 |
| 6918 | 2 | 0.095 | -10.0 | +0.0 | 1.000 | 1.0 | 1.5 | 0.5735 |
| 6919 | 3 | 0.177 | -8.0 | +0.0 | 1.000 | 1.0 | 1.5 | 0.4218 |
| 6920 | 4 | 0.280 | -6.0 | +0.0 | 1.000 | 1.0 | 1.5 | 0.3069 |
| 6921 | 5 | 0.404 | -5.0 | +0.0 | 1.000 | 1.0 | 1.5 | 0.2234 |
| 6922 | 6 | 0.521 | -3.5 | +0.0 | 1.000 | 1.0 | 1.0 | 0.1598 |
| 6923 | 7 | 0.649 | -2.5 | +0.0 | 1.000 | 1.0 | 1.0 | 0.1242 |
| 6924 | 8 | 0.747 | -2.0 | +0.0 | 1.000 | 0.5 | 1.0 | 0.0904 |
| 6925 | 9 | 0.837 | -1.5 | +0.0 | 1.000 | 0.5 | 0.5 | 0.0602 |
| 6926 | 10 | 0.888 | -0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0397 |
| 6927 | 11 | 0.947 | -0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0216 |
| 6928 | 12 | 0.967 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0123 |
| 6929 | 13 | 0.991 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0020 |
| 6930 | 14 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0000 |

### F — HOW TO / FIND CLIENTS  (first frame 7833, 326.375 s)

* Shot: frontal wide; shot frames 7753–7883. Direction: DROP (from above).
* Line first-visible frames [7833, 7838], settled [7840, 7843], line-2 delay 5 f.
* Last visible frame 7883; visible 51 f; hold after line-1 settle 43 f.
* Exit: hard cut with camera cut (to screen recording) (first frame without text: 7884).

F1 entrance (k = frame − 7833; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 7833 | 0 | 0.010 | -20.0 | -3.0 | 0.958 | 4.0 | 3.0 | 0.8877 |
| 7834 | 1 | 0.103 | -11.0 | +0.0 | 0.996 | 1.5 | 2.0 | 0.1824 |
| 7835 | 2 | 0.265 | -7.0 | +0.0 | 0.996 | 1.5 | 1.5 | 0.0779 |
| 7836 | 3 | 0.489 | -4.0 | +0.0 | 0.996 | 1.0 | 1.0 | 0.0573 |
| 7837 | 4 | 0.709 | -2.0 | +0.0 | 0.996 | 0.5 | 0.5 | 0.0421 |
| 7838 | 5 | 0.876 | -1.0 | +0.0 | 1.000 | 0.5 | 0.5 | 0.0154 |
| 7839 | 6 | 0.959 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.0096 |
| 7840 | 7 | 0.999 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0002 |

F2 entrance (k = frame − 7838; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 7837 | -1 | 0.000 | -11.0 | +0.0 | 0.996 | 1.5 | 3.0 | 1.0000 |
| 7838 | 0 | 0.093 | -11.0 | +0.0 | 0.996 | 1.5 | 3.0 | 0.6283 |
| 7839 | 1 | 0.285 | -6.5 | +0.0 | 1.000 | 1.0 | 1.5 | 0.3345 |
| 7840 | 2 | 0.525 | -4.0 | +0.0 | 1.000 | 1.0 | 1.0 | 0.2382 |
| 7841 | 3 | 0.701 | -2.0 | +0.0 | 1.000 | 0.5 | 0.5 | 0.2028 |
| 7842 | 4 | 0.829 | -1.0 | +0.0 | 1.000 | 0.0 | 1.0 | 0.1980 |
| 7843 | 5 | 0.883 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.1872 |
| 7844 | 6 | 0.918 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.1794 |
| 7845 | 7 | 0.929 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.1656 |
| 7846 | 8 | 0.935 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.1517 |
| 7847 | 9 | 0.938 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.1378 |
| 7848 | 10 | 0.939 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.1216 |
| 7849 | 11 | 0.949 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0937 |
| 7850 | 12 | 0.960 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0669 |
| 7851 | 13 | 0.969 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0445 |
| 7852 | 14 | 0.979 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0265 |
| 7853 | 15 | 0.991 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0114 |
| 7854 | 16 | 0.999 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0033 |

### G — WHAT AD DO WE / RUN NEXT?  (first frame 8510, 354.583 s)

* Shot: frontal (2 f) then 3/4 side-angle MCU; shot frames 8512–8549. Direction: rise.
* Line first-visible frames [8510, 8514], settled [None, None], line-2 delay 2 f.
* Last visible frame 8549; visible 40 f; hold after line-1 settle None f.
* Exit: hard cut with camera cut (first frame without text: 8550).
* Note: Entrance STARTS 2 frames BEFORE the camera cut at 8512 and continues across it unchanged (graphic lives on the edit timeline, not on the shot). No clean background plate after the cut, so no per-frame fit; line-2 delay from threshold crossing (white 8514, pink 8516).

### H — TEST THE / ORGANIC FIRST  (first frame 9225, 384.375 s)

* Shot: 3/4 side-angle MCU; shot frames 9215–9265. Direction: rise, FAST (~5 f).
* Line first-visible frames [9225, 9239], settled [9230, 9244], line-2 delay 14 f.
* Last visible frame 9265; visible 41 f; hold after line-1 settle 35 f.
* Exit: hard cut with camera cut (first frame without text: 9266).

H1 entrance (k = frame − 9225; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 9224 | -1 | 0.000 | +11.5 | +0.5 | 1.000 | 1.5 | 3.0 | 1.0000 |
| 9225 | 0 | 0.036 | +11.5 | +0.5 | 1.000 | 1.5 | 3.0 | 0.3944 |
| 9226 | 1 | 0.136 | +8.0 | +0.5 | 1.000 | 0.0 | 1.0 | 0.0921 |
| 9227 | 2 | 0.312 | +5.0 | +0.5 | 1.000 | 0.0 | 0.5 | 0.0325 |
| 9228 | 3 | 0.591 | +2.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0184 |
| 9229 | 4 | 0.874 | +0.5 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0082 |
| 9230 | 5 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0000 |

H2 entrance (k = frame − 9239; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 9238 | -1 | 0.002 | +11.5 | -2.5 | 0.972 | 0.0 | 2.0 | 0.9981 |
| 9239 | 0 | 0.020 | +10.0 | +0.0 | 0.990 | 0.5 | 5.0 | 0.9397 |
| 9240 | 1 | 0.143 | +7.5 | +0.5 | 0.996 | 1.5 | 2.5 | 0.4511 |
| 9241 | 2 | 0.357 | +4.5 | +0.0 | 1.000 | 0.5 | 1.0 | 0.2330 |
| 9242 | 3 | 0.599 | +2.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.1773 |
| 9243 | 4 | 0.800 | +0.5 | +0.0 | 1.000 | 0.0 | 0.5 | 0.1579 |
| 9244 | 5 | 0.894 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.1348 |
| 9245 | 6 | 0.907 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.1168 |
| 9246 | 7 | 0.908 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.1003 |
| 9247 | 8 | 0.917 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0849 |
| 9248 | 9 | 0.928 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0682 |
| 9249 | 10 | 0.936 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0568 |
| 9250 | 11 | 0.950 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0424 |
| 9251 | 12 | 0.959 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0319 |
| 9252 | 13 | 0.967 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0235 |
| 9253 | 14 | 0.979 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0121 |
| 9254 | 15 | 0.990 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0038 |
| 9255 | 16 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0000 |

### I — A/B / TEST  (first frame 13123, 546.792 s)

* Shot: frontal wide; shot frames 13112–13148. Direction: DROP (from above).
* Line first-visible frames [13123, 13125], settled [13131, 13131], line-2 delay 2 f.
* Last visible frame 13148; visible 26 f; hold after line-1 settle 17 f.
* Exit: hard cut with camera cut (first frame without text: 13149).

I1 entrance (k = frame − 13123; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 13123 | 0 | 0.017 | -8.5 | +0.5 | 1.056 | 0.0 | 6.5 | 0.9191 |
| 13124 | 1 | 0.148 | -10.5 | +0.0 | 1.006 | 2.0 | 2.5 | 0.5427 |
| 13125 | 2 | 0.372 | -7.0 | +0.0 | 0.996 | 1.5 | 2.5 | 0.4026 |
| 13126 | 3 | 0.590 | -4.0 | +0.0 | 0.996 | 0.5 | 1.5 | 0.3366 |
| 13127 | 4 | 0.772 | -2.0 | +0.0 | 1.000 | 0.5 | 1.0 | 0.2948 |
| 13128 | 5 | 0.892 | -1.0 | +0.0 | 1.000 | 0.0 | 1.0 | 0.2681 |
| 13129 | 6 | 0.952 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.2378 |
| 13130 | 7 | 0.991 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.2041 |
| 13131 | 8 | 0.999 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.1731 |

I2 entrance (k = frame − 13125; ty + = down, px):

| frame | k | opacity | ty px | tx px | scale | σx | σy | fit resid |
|---|---|---|---|---|---|---|---|---|
| 13124 | -1 | 0.000 | -11.5 | -0.5 | 0.988 | 1.0 | 3.0 | 1.0000 |
| 13125 | 0 | 0.057 | -11.5 | -0.5 | 0.988 | 1.0 | 3.0 | 0.3351 |
| 13126 | 1 | 0.204 | -7.0 | +0.0 | 0.992 | 1.0 | 1.5 | 0.1032 |
| 13127 | 2 | 0.444 | -4.0 | +0.0 | 0.996 | 1.0 | 1.0 | 0.0809 |
| 13128 | 3 | 0.678 | -2.0 | +0.0 | 0.996 | 0.5 | 0.5 | 0.0521 |
| 13129 | 4 | 0.868 | -1.0 | +0.0 | 1.000 | 0.5 | 0.5 | 0.0214 |
| 13130 | 5 | 0.958 | +0.0 | +0.0 | 1.000 | 0.0 | 0.5 | 0.0200 |
| 13131 | 6 | 0.997 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0006 |
| 13132 | 7 | 1.000 | +0.0 | +0.0 | 1.000 | 0.0 | 0.0 | 0.0000 |

## 4. SFX

* **measured**: No consistent transient at the first visible frame. Across 11 entrances the mid-channel 6-16 kHz band shows a soft broadband swell (bell envelope ~120-200 ms) peaking BEFORE the first visible frame in 6/11 cases: A -75 ms, D -110 ms, G -80 ms, H -55 ms, E2 -100 ms, H2 -125 ms (median about -90 ms, i.e. the sound leads by ~2 frames). B -230, I -235, C +85, F +10, E +195 do not fit.
* **interpretation**: consistent with a quiet whoosh that leads the text by ~2 frames, but it overlaps speech sibilants, so it cannot be separated from voice; the side channel is dominated by AAC joint-stereo artefacts; template cross-correlation found no reused identical sample (best repeat NCC 0.29).
* **recommendation**: if an SFX is used: soft whoosh, onset ~ -170 ms, peak ~ -90 ms relative to the first visible frame, low level (~ -20 dB under voice). Confidence low.

## 5. Confidence and what would change it

* **opacity per frame**: high (+/-0.01) where opacity > 0.1; pink lines less (fill colour animation leaks into the opacity estimate: pink alpha creeps 0.92 -> 1.0 over the hold; use the white line of the same card as truth).
* **translateY per frame**: high (+/-0.5 px) for opacity > 0.15; unreliable on the first visible frame (opacity < 0.05): those values are marked by low opacity.
* **blur sigma**: medium (+/-0.5 px); separation from opacity weak at low opacity.
* **start offset before first visible frame**: NOT measurable (invisible); -0.5 f assumed for the bezier fits; the from-offset (0.337 em) is the extrapolation, not a measurement.
* **font**: high for Space Grotesk 700; weight 700 vs 600 is close (IoU gap 0.01-0.04).
* **gradient geometry/animation**: low: stop colours are measured, the gradient shape and speed are an approximation.
* **SFX**: low - see sfx section.
* **G instance**: timing only (no fit, no clean plate after the cut).
* **what would change it**: a clean render of the template (After Effects/CapCut preset) or isolated SFX stems; a frame without text on the same shot for G and for the post-exit of A/B would tighten them.

**Frame indexing:** All absolute frame numbers come from my own raw dumps (bin/dump.sh seeks to (F-0.25)/24, so ffmpeg lands on frame F exactly; cross-checked against a full-video 192x108 decode: the minimum difference falls on the same index). Strips were started at (F-0.25)/24 or at exact multiples of 1/24, so the old kit off-by-one (round vs ceil) does not affect them. The only exception was an early overview strip a1.jpg (start 39.8 s, labels one frame low), which was used for orientation only. Audio offsets are computed from sample index = frame/24 directly. No run used the fixed kit; none needed it. The D exit fit job (D1x) was killed externally after frame 5885; frames 5886+ are after the camera cut and are not needed.

## 6. Related cards (not this family)

* **SKILL (01:58, f2832)**: icon card + small white label; the label uses the same RISE recipe (opacity 0.059,0.24,0.477,0.713,0.863,0.977 / dy 21.5,12,7,3.5,1.5,0.5 px at ~39 px font).
* **ATTENTION - LOST stack (02:49, f4066)**: different family: red X icon + white line revealed left->right (type-on/wipe) over ~20 f, lines added one by one.
* **STATIC DIAGRAM / PRODUCT IN ACTION (04:09, f5991)**: list family: white header fades up like this family, pink line wipes in; arrows/extra rows follow.
* **HOOK RATE / CTR / CPL (09:31) and TOTAL ~$100 (09:39)**: stacked metric lists in the same pink gradient; not measured here.

Scripts: `/opt/aieditor-work/reference/work/keyword-text/bin` (dump.sh, fit.py, ease.py, match*.py, quad.py, shadow/shfit.py, avg*.py). Raw fit tables: `/opt/aieditor-work/reference/work/keyword-text/fits`.
