# Prompt bars, camera/edit moves, SFX & mix — gVPZU1btFA8 (24 fps, 1920x1080)

Measured frame by frame. round(t*24); all absolute frame numbers below come from my own seek helpers (-ss F/24, verified against scene-cut frames 1045, 2298, 9761, 13240) or kit strips started on integer frames; the one kit run that started on a fractional frame (track.sh 43.6 → labels 1 low) was discarded and re-measured on exact raw frames. Strip p1b (start 45.3 s) labels were 1 low; its findings were re-measured with exact raw data.

Confidence tags: **high** = directly measured, repeatable; **med** = measured with a known confound; **low** = inferred / masked.

## A. Prompt bars

### Shared design (all five are the same component)

| property | value | conf |
|---|---|---|
| family | ChatGPT-style composer (dark) | high |
| fill | #202020 opaque (sampled 32,32,32 at all 5 instances) | high |
| border | 1px; at 2x zoom (0:43) reads #3D3D3D-#414141 lighter stroke; at 1x it blends (row values 24→33) — confidence low | low |
| radius | 1x layout (instances 4/5, box 1200x~160-350): ~40 px; instance 2 (905x153): ~26 px; 0:43 zoomed (height 280-287): ~100 px | med |
| shadow | soft drop shadow below only: -5/-3/-1 luma at +5/+9/+13 px under the bottom edge (≈ 0 4px 16px rgba(0,0,0,0.12)); none at sides — confidence med | med |
| backdrop_blur | none (fill opaque) | high |
| typed_text | #FFFFFF (max 255), Inter Regular candidate, 1x size ≈ 26-27 px (cap height ≈ 20 px), line pitch 41 px; instance 2 ≈ 17 px / 31 px pitch | med |
| chip_text | "GPT-6 Astra" + chevron, #C1C1C1-#DADADA grey, ≈ 0.9x body size | med |
| icons | "+" left (white, thin), mic outline icon, submit = solid blue circle #2D66C2 (sampled 44-45,101,194-195), white up-arrow; diameter 52 px at 1x (42 px in instance 2, 105 px at 0:43 zoom) | high |
| attachment | instance 4 only: 220x150 dark thumbnail (#1a1218) with bottom label chip "Campaign results" + green spreadsheet glyph; fades in 9784-9786 (≈3 f) after the box finishes morphing | high |
| placeholder | none seen (bar shows only + / chip / mic / button until first char) | high |
| caret | NONE visible in any instance (checked pause frames 1060, 5416, 9795, 13279); instead each new character fades in over ≈1-2 frames (faint leading glyph visible, e.g. 9864 "varia" + faint "t") | high |
| cursor | macOS black arrow with white 1-2 px outline + soft shadow, ~28 px tall at 1x; enters from lower-right (~+60,+55 px from button) and eases out onto the submit button over ~8-10 f (motion-blurred while moving) | med |
| font | Inter (Google Fonts) — best match / SF Pro Text (not Google) / Söhne / OpenAI Sans (not Google). Evidence: double-storey a with straight stem and no tail spur, t with slanted-cut top, G with horizontal bar + spur, flat-terminal r, 6 with open bowl; regular weight; wide default tracking; crop c1078.png | med |

### Typing speed summary

| bar | chars | frames | chars/frame |
|---|---|---|---|
| P1 | 35 | 28 | 1.25 |
| P3 | 118 | 28 | 4.3 |
| P4 | 100 | 103 | 0.97 |
| P5 | 110 | 63 | 1.74 |

no single constant rate: full-screen showcase bars (P1, P3) type in a fixed ~28 f (1.17 s) regardless of length; overlay bars over the presenter (P4, P5) type at 1-1.75 char/frame, i.e. paced to speech. Linear in time (no ease) in all four. Caret: none — new glyphs fade in over ~1-2 f instead.

**Typing SFX:** HF (>6 kHz) transient rate during typing windows 17-23 /s with median inter-onset 36-42 ms (≈ one click per video frame) vs 5.5-19.5 /s (median ~10/s) in 7 non-typing control windows → consistent with a keyboard-clatter SFX bed at ~24 clicks/s that is NOT locked 1:1 to characters (P3 types 4.3 chars/f but clicks stay ~17/s) — confidence low-medium: voice sibilants also make HF onsets; controls at 60 s and 541.7 s are as busy. A clean stem or listening test would settle it.

### P1 — 0:43.6 — frames 1045-1108 (cut-in 1045 from B close-up; bag image fades in from 1109)

Context: full-screen, black + dark-red vignette + faint 178-px dot grid (static); bar shown at ≈2x UI zoom (button 105 px, text ≈60 px). Text: “Generate a product photo of the bag”

**Entrance** 1047-1055. rise ≈ +45 px→0 and scale ≈0.94→1.0 together with the fade; centre-y 598→578
- opacity_per_frame: 1047:0.03, 1048:0.17, 1049:0.41, 1050:0.72, 1051:0.93, 1052:0.97, 1053:1.0
- top_edge_y: 1049:478, 1050:465, 1051:452, 1052:444, 1053:440, 1054:438, 1055:437
- height_px: 1050:267, 1051:272, 1052:277, 1055:282
- fit fit_opacity: cubic-bezier(0.647, 0.522, 0.35, 0.981) from f1046.8 (0) to f1053 (1), RMS residual 0.008; residuals (frame:px) 1047:+0 1048:-0.01 1049:+0.01 1050:-0 1051:+0.01 1052:-0.01 1053:+0
- fit fit_top: cubic-bezier(0.497, -0.328, 0.2, 0.925) from f1047 (478) to f1055 (437), RMS residual 0.193; residuals (frame:px) 1049:+0.12 1050:-0.2 1051:+0.37 1052:-0.22 1053:-0.14 1054:+0.04 1055:-0

**Typing** — ≈1 char/frame; a space+next letter usually land on the SAME frame (+2), and the frame after a completed word often holds (1059→1060, 1070→1071, 1076→1077). Mean 1.25 chars/frame.

| frame | chars visible | text |
|---|---|---|
| 1051 | 0 |  |
| 1052 | 1 | G |
| 1053 | 2 | Ge |
| 1054 | 3 | Gen |
| 1055 | 5 | Gener |
| 1056 | 6 | Genera |
| 1057 | 7 | Generat |
| 1058 | 8 | Generate |
| 1059 | 10 | Generate a |
| 1060 | 10 | Generate a |
| 1061 | 12 | …a p |
| 1062 | 13 | …pr |
| 1063 | 15 | …prod |
| 1064 | 16 | …produ |
| 1065 | 17 | …produc |
| 1066 | 18 | …product |
| 1067 | 20 | …product p |
| 1068 | 21 | …ph |
| 1069 | 22 | …pho |
| 1070 | 24 | …photo |
| 1071 | 24 | …photo |
| 1072 | 26 | …photo o |
| 1073 | 27 | …of |
| 1074 | 29 | …of t |
| 1075 | 30 | …th |
| 1076 | 31 | …the |
| 1077 | 31 | …the |
| 1078 | 34 | …the ba |
| 1079 | 35 | …the bag (complete) |

(≈chars = from the measured right edge of the white ink ÷ mean glyph advance; ±1 char.)

**Follow Pan** — what: bar translates left to keep the typed end in view (background dots do NOT move → it is the bar, not a camera); left_edge_x: {'1056': 221, '1057': 221, '1058': 221, '1059': 219, '1060': 217, '1061': 214, '1062': 209, '1063': 203, '1064': 194, '1065': 181, '1066': 161, '1067': 143, '1068': 121, '1069': 103, '1070': 88, '1071': 78, '1072': 71, '1073': 66, '1074': 61, '1075': 59, '1076': 57, '1077': 56, '1078': 55}
- fit: cubic-bezier(0.566, 0.038, 0.341, 1.003) from f1058 (221) to f1078 (55), RMS residual 0.842; residuals 1058:+0 1059:-1 1060:-0.96 1061:-0.64 1062:-0.69 1063:+0.36 1064:+1.14 1065:+1.44 1066:-1.24 1067:+1.25 1068:-0.12 1069:-0.39 1070:-1.48 1071:-0.94 1072:-0.07 1073:+0.74 1074:-0.07 1075:+0.84 1076:+0.71 1077:+0.72 1078:+0

**Whip To Submit** — frames: 1079-1090; note: fast leftward translate with heavy horizontal motion blur (1080-1086) to reveal the right end; total travel ≈ 1330 px (estimate, bar width inferred), button enters at x=1900 on 1083 and settles x=1073.5 on 1090; button_x: {'1083': 1900.1, '1084': 1632.4, '1085': 1388.2, '1086': 1238.4, '1087': 1151.8, '1088': 1104.0, '1089': 1079.5, '1090': 1073.5}
- fit_tail: cubic-bezier(0.244, 0.497, 0.3, 0.997) from f1083 (1900.1) to f1090 (1073.5), RMS residual 0.746; residuals 1083:+0 1084:+0.04 1085:-0.62 1086:+1.48 1087:+0.92 1088:+0.42 1089:-0.92 1090:-0

**Click** — button_diameter: {'1090': 105, '1091': 105, '1092': 99, '1093': 93, '1094': 95, '1095': 99, '1096': 103, '1097': 105}; press: scale 1→0.886 in 2 f, back to 1 in 4 f (1091→1097); cursor already resting on button from 1087

**Exit** — frames: 1098-1107; note: flies up-and-right, accelerating (ease-in), shrinking 1→0.79, motion blur; gone 1108; button_cx_cy: {'1097': [1073.8, 508.6], '1098': [1075.7, 504.9], '1099': [1081.4, 495.7], '1100': [1092.4, 480.9], '1101': [1111.3, 461.1], '1102': [1132.0, 427.5], '1103': [1159.6, 382.9], '1104': [1196.2, 324.0], '1105': [1244.1, 246.8], '1106': [1306.0, 146.4], '1107': [1383.3, 28.1]}
- fit_y: cubic-bezier(0.85, -0.006, 1, 1.213) from f1097 (508.6) to f1107 (28.1), RMS residual 1.238; residuals 1097:-0 1098:-1.25 1099:-1.92 1100:-1.3 1101:+2.25 1102:+1.32 1103:+0.61 1104:-0.4 1105:-1.29 1106:+0.95 1107:+0

### P2 — 1:35.9 — frames 2301-2332 over camera A (cut-in at 2298)

Context: pre-filled prompt (no typing) pinned bottom-centre over presenter; box x≈508-1415, y≈795-948 (905x153). Text: “Follow the attached ad workflow for my product. Research customer reviews, competitors, buyer needs and objections, then make 5 static ads for this $80 leather bag. Designed for work, the gym, and travel.”

**Entrance** 2301-2310. blur-in: edge sharpness 0.25→0.64→0.87→0.95 over 2302-2305 (≈ blur 8px→0 in 4 f); alpha values ±0.1 (presenter moving behind)

| frame | dy px | scale | alpha | sharpness (1=final) |
|---|---|---|---|---|
| 2302 | 18 | 0.97 | 0.34 | 0.25 |
| 2303 | 16 | 0.98 | 0.66 | 0.64 |
| 2304 | 12 | 0.98 | 0.77 | 0.87 |
| 2305 | 10 | 0.99 | 0.96 | 0.95 |
| 2306 | 6 | 0.99 | 0.9 | 0.99 |
| 2307 | 4 | 1.0 | 0.91 | 0.99 |
| 2308 | 2 | 1.0 | 0.96 | 0.98 |
| 2309 | 2 | 1.0 | 0.87 | 1.01 |
| 2310 | 0 | 1.0 | 0.98 | 0.98 |
- fit fit_dy: cubic-bezier(0.834, 0.838, 0.259, 0.6) from f2301 (20) to f2310 (0), RMS residual 0.47; residuals (frame:px) 2302:+0.28 2303:+0.67 2304:-0.75 2305:+0.21 2306:-0.04 2307:+0.12 2308:-0.48 2309:+0.79 2310:-0
- fit fit_opacity: cubic-bezier(0.591, 1.191, 0.734, 0.903) from f2300.8 (0) to f2307 (1), RMS residual 0.021; residuals (frame:px) 2301:+0.03 2302:-0.03 2303:+0.03 2304:-0.02 2305:+0.01 2306:-0 2307:+0

**Cursor** — path_full_res: {'2316': [1443, 972], '2317': [1437, 968], '2318': [1430, 962], '2319': [1423, 953], '2320': [1414, 945], '2321': [1403, 938], '2322': [1393, 928], '2323': [1389, 919], '2324': [1383, 917]}; note: tip positions ±4 px read off zoomed strip p2d; enters 2316 (motion-blurred), settles 2324

**Click** — button_diameter: {'2325': 42, '2326': 38, '2327': 37, '2328': 37}; darken: 2328 blue 194→176; note: press 2326-2328, no release seen before exit

**Exit** — frames: 2328-2333; opacity: {'2328': 0.92, '2329': 0.53, '2330': 0.33, '2331': 0.2, '2332': 0.09, '2333': 0.03}; dy: {'2328': -4, '2329': -8, '2330': -10, '2331': -12, '2332': -18}
- fit_opacity: cubic-bezier(0.172, 0.078, 0.05, 0.697) from f2327.6 (1) to f2333.5 (0), RMS residual 0.005; residuals 2328:+0 2329:-0 2330:+0 2331:+0.01 2332:-0.01 2333:+0

Cut after: 2338 (to W) — box gone 5 f before the cut

### P3 — 3:45.0 — frames 5400-5646 (hard cut-in 5400 to black/red vignette; cut out 5653)

Context: full-screen; bar centred (button at 1538,546 → bar ≈ x 340-1580). Text: “Resize these creatives for the feed, Stories, and Reels.\nAdjust the layout so the text and product stay fully visible.”

**Entrance** 5403-5413. 5403 faint, 5404 ≈half, 5405 full alpha; rise: button cy 561→546 (-15 px) over 5405-5413 + slight scale-up (cx 1525→1538)
- button_cy: 5405:561.0, 5406:557.8, 5407:555.2, 5408:552.7, 5409:550.9, 5410:549.3, 5411:548.0, 5412:546.9, 5413:546.2
- fit fit: cubic-bezier(0.094, -0.331, 0.25, 0.7) from f5404 (561.0) to f5413 (546.2), RMS residual 0.074; residuals (frame:px) 5405:+0.09 5406:-0.14 5407:+0.06 5408:-0.08 5409:+0.07 5410:+0.05 5411:+0.03 5412:-0.07 5413:-0

**Typing** — steady 4-6 chars/frame (≈104 cps), no pauses; wraps to line 2 at 5417; bar grows by one line height (button cy 546→557 over 5414-5421, i.e. bar centred and grows ±11 px). Mean 4.33 chars/frame.

| frame | chars visible | text |
|---|---|---|
| 5404 | 1 | R |
| 5405 | 6 | Resize |
| 5406 | 10 | Resize the |
| 5407 | 15 | …these cr |
| 5408 | 19 | …creati |
| 5409 | 24 | …creatives f |
| 5410 | 28 | …for t |
| 5411 | 33 | …the fe |
| 5412 | 36 | …feed, |
| 5413 | 42 | …Stori |
| 5414 | 45 | …Stories, |
| 5415 | 49 | …and |
| 5416 | 55 | …Reels |
| 5417 | 59 | …Reels.⏎Ad (wrap) |
| 5418 | 63 | Adjust |
| 5419 | 67 | Adjust the |
| 5420 | 73 | …layou |
| 5421 | 77 | …layout so |
| 5422 | 81 | …so the |
| 5423 | 86 | …text |
| 5424 | 90 | …text and |
| 5425 | 95 | …prod |
| 5426 | 100 | …product s |
| 5427 | 103 | …stay |
| 5428 | 109 | …fully |
| 5429 | 113 | …vis |
| 5430 | 117 | …visible |
| 5431 | 118 | …visible. (complete) |

(≈chars = from the measured right edge of the white ink ÷ mean glyph advance; ±1 char.)

**Cursor** — note: appears lower-right 5419 while still typing, reaches button 5424

**Click** — button_w: {'5427': 54, '5428': 50, '5429': 48, '5430': 49, '5431': 52, '5432': 54}; press: scale 1→0.89 over 2 f, back over 3 f (5428-5432)

**Slide Down** — frames: 5452-5470; note: after a 20-f hold the bar slides to the bottom (cy 557→961, +404 px), motion-blurred mid-move, slight leftward shift (cx 1538→1518 5465-5471) — bar narrows ~40 px; button_cy: {'5452': 557.4, '5453': 565.5, '5454': 587.6, '5455': 626.3, '5456': 678.3, '5457': 732.6, '5458': 782.0, '5459': 822.2, '5460': 855.1, '5461': 881.7, '5462': 902.7, '5463': 919.6, '5464': 932.9, '5465': 943.1, '5466': 950.4, '5467': 955.7, '5468': 959.0, '5469': 960.5, '5470': 960.9}
- fit: cubic-bezier(0.312, 0.091, 0.219, 1.006) from f5452 (557.1) to f5470 (960.9), RMS residual 1.112; residuals 5452:+0.3 5453:-2.6 5454:-2.64 5455:-0.28 5456:+1.95 5457:+1.39 5458:+0.67 5459:-0.61 5460:-0.9 5461:-0.63 5462:-0.47 5463:-0.02 5464:+0.42 5465:+0.72 5466:+0.6 5467:+0.61 5468:+0.44 5469:+0.07 5470:-0

**Result Cards** — layout: 5 squares 304x304 px, pitch 350 px (x0 = 108, 458, 807, 1157, 1508), top y=358 settled; stagger_frames: 2; first_visible: [5456, 5458, 5460, 5462, 5464]; per_card: fade from dark to pink (#F62397 family; mid-transition samples #471630→#86265b→#b7357d→#d34995) in 4 f, rise 47 px (top 405→358) over ~14 f, then cross-fade pink→ad image over 6 f starting ≈4 f after first visible
- fit_rise: cubic-bezier(0.212, -0.097, 0.266, 0.972) from f5455 (405) to f5470 (358), RMS residual 0.342; residuals 5456:+0.39 5457:-0.56 5458:+0.84 5459:-0.31 5460:-0.11 5461:+0.16 5462:-0.48 5463:+0.07 5464:-0.07 5465:+0.19 5466:-0.05 5467:+0.25 5468:+0.17 5469:-0.26 5470:-0

**Expand 9X16** — frames: 5520-5550; note: each card flashes to solid pink #F62397 in 2 f (staggered 2 f: 5521,5523,5525,5527,5529), then grows from 304x304 to ~287x~510 (top 357→257, ≈symmetric about centre y≈510), width shrinking 307→287, then cross-fades pink→9:16 image over ~6 f (card1 5537-5543)
- fit_top: cubic-bezier(0.628, 0.169, 0.344, 0.894) from f5524 (357) to f5542 (257), RMS residual 0.454; residuals 5525:-0.28 5526:-0.05 5527:+0.83 5528:+0.56 5529:+0.41 5530:-0.18 5531:-0.6 5532:-0.32 5533:-0.13 5534:+0.12 5535:+0.59 5536:+0.52 5537:-0.38 5538:+0.41 5539:-0.76 5540:-0.64 5541:-0.1 5542:-0

**Exit** — frames: 5642-5646; note: bar drops +18 px and fades in 4 f (cy 961→979); cards stay until cut 5653

### P4 — 6:47.1 — frames 9770-9942 over camera A (cut-in 9761) — survives the cut to B at 9939 for 2 f

Context: box 1200x353 (x 360-1559, y 672-1025) with attachment thumbnail. Text: “Analyze which of my creatives perform best and why, then create more variations around the winners.”

**Entrance** 9770-9783. LAPTOP MORPH: the laptop lid darkens to #202020 (9770-9772) and that rectangle grows into the box (left 515→360, right 1403→1559, top 721→672, bottom 995→1025); controls fade in 9778, attachment 9784-9786

| frame | x0 | y0 | x1 | y1 |
|---|---|---|---|---|
| 9773 | 515 | 721 | 1403 | 995 |
| 9774 | 496 | 714 | 1419 | 997 |
| 9775 | 448 | 700 | 1461 | 1005 |
| 9776 | 413 | 688 | 1501 | 1015 |
| 9777 | 391 | 680 | 1523 | 1019 |
| 9778 | 376 | 675 | 1540 | 1021 |
| 9779 | 368 | 672 | 1549 | 1021 |
| 9780 | 363 | 672 | 1555 | 1023 |
| 9781 | 361 | 670 | 1555 | 1023 |
| 9782 | 360 | 672 | 1559 | 1023 |
- fit fit_width: cubic-bezier(0.35, -0.013, 0.1, 0.975) from f9772.5 (888) to f9782 (1199), RMS residual 1.781; residuals (frame:px) 9773:-2.08 9774:+1.63 9775:+0.96 9776:-1.79 9777:-2.69 9778:+1.74 9779:+1.27 9780:+1.47 9781:-2.57 9782:+0

**Typing** — exactly ~1 char per frame INCLUDING spaces (space frames show no new ink: 9795, 9801-9802, 9805, 9808…); new glyph fades in over ~2 f; line 2 starts 9859; done 9890 (103 f for 100 chars). Mean 0.97 chars/frame.

| frame | ≈chars | line1 right x | line2 right x |
|---|---|---|---|
| 9787 | 0 | 0 |  |
| 9788 | 1 | 400 |  |
| 9789 | 2 | 414 |  |
| 9790 | 3 | 428 |  |
| 9791 | 4 | 434 |  |
| 9792 | 5 | 448 |  |
| 9793 | 6 | 462 |  |
| 9794 | 7 | 476 |  |
| 9795 | 7 | 476 |  |
| 9796 | 10 | 503 |  |
| 9797 | 11 | 517 |  |
| 9798 | 11 | 523 |  |
| 9799 | 12 | 537 |  |
| 9800 | 14 | 552 |  |
| 9801 | 14 | 552 |  |
| 9802 | 14 | 552 |  |
| 9803 | 16 | 575 |  |
| 9804 | 16 | 584 |  |
| 9805 | 16 | 584 |  |
| 9806 | 19 | 612 |  |
| 9807 | 20 | 626 |  |
| 9808 | 20 | 626 |  |
| 9809 | 21 | 647 |  |
| 9810 | 22 | 657 |  |
| 9811 | 23 | 670 |  |
| 9812 | 25 | 684 |  |
| 9813 | 25 | 694 |  |
| 9814 | 26 | 699 |  |
| 9815 | 27 | 713 |  |
| 9816 | 28 | 727 |  |
| 9817 | 29 | 740 |  |
| 9818 | 29 | 740 |  |
| 9819 | 31 | 762 |  |
| 9820 | 32 | 777 |  |
| 9821 | 33 | 783 |  |
| 9822 | 34 | 793 |  |
| 9823 | 34 | 797 |  |
| 9824 | 35 | 811 |  |
| 9825 | 36 | 821 |  |
| 9826 | 37 | 841 |  |
| 9827 | 37 | 841 |  |
| 9828 | 39 | 864 |  |
| 9829 | 41 | 879 |  |
| 9830 | 42 | 892 |  |
| 9831 | 42 | 901 |  |
| 9832 | 42 | 901 |  |
| 9833 | 44 | 922 |  |
| 9834 | 45 | 936 |  |
| 9835 | 47 | 951 |  |
| 9836 | 47 | 951 |  |
| 9837 | 49 | 980 |  |
| 9838 | 50 | 994 |  |
| 9839 | 51 | 1007 |  |
| 9840 | 52 | 1012 |  |
| 9841 | 52 | 1013 |  |
| 9842 | 53 | 1027 |  |
| 9843 | 53 | 1030 |  |
| 9844 | 54 | 1045 |  |
| 9845 | 55 | 1060 |  |
| 9846 | 57 | 1074 |  |
| 9847 | 57 | 1074 |  |
| 9848 | 58 | 1095 |  |
| 9849 | 59 | 1105 |  |
| 9850 | 60 | 1119 |  |
| 9851 | 61 | 1132 |  |
| 9852 | 62 | 1142 |  |
| 9853 | 63 | 1156 |  |
| 9854 | 63 | 1156 |  |
| 9855 | 66 | 1185 |  |
| 9856 | 67 | 1200 |  |
| 9857 | 68 | 1210 |  |
| 9858 | 69 | 1223 |  |
| 9859 | 71 | 1224 | 396 |
| 9860 | 72 | 1224 | 409 |
| 9861 | 73 | 1224 | 416 |
| 9862 | 73 | 1224 | 420 |
| 9863 | 73 | 1224 | 425 |
| 9864 | 75 | 1224 | 439 |
| 9865 | 75 | 1224 | 449 |
| 9866 | 76 | 1224 | 454 |
| 9867 | 77 | 1224 | 470 |
| 9868 | 78 | 1224 | 484 |
| 9869 | 79 | 1224 | 497 |
| 9870 | 79 | 1224 | 497 |
| 9871 | 81 | 1224 | 518 |
| 9872 | 82 | 1224 | 528 |
| 9873 | 83 | 1224 | 542 |
| 9874 | 84 | 1224 | 556 |
| 9875 | 86 | 1224 | 571 |
| 9876 | 87 | 1224 | 586 |
| 9877 | 87 | 1224 | 586 |
| 9878 | 88 | 1224 | 603 |
| 9879 | 90 | 1224 | 617 |
| 9880 | 91 | 1224 | 632 |
| 9881 | 91 | 1224 | 633 |
| 9882 | 91 | 1224 | 633 |
| 9883 | 93 | 1224 | 660 |
| 9884 | 94 | 1224 | 666 |
| 9885 | 95 | 1224 | 680 |
| 9886 | 96 | 1224 | 694 |
| 9887 | 98 | 1224 | 710 |
| 9888 | 98 | 1224 | 720 |
| 9889 | 99 | 1224 | 732 |
| 9890 | 100 | 1224 | 738 |

(≈chars = from the measured right edge of the white ink ÷ mean glyph advance; ±1 char.)

**Cursor** — note: visible lower-right by 9905, arrives on button 9913; no press animation seen

**Resize** — frames: 9886-9893; note: button cy 987→971 (-16 px), box shrinks to y 690-1009 — layout settle after typing ends; confidence low on cause

**Exit** — frames: 9939-9942; note: box holds through the cut to B (9939, 9940), fades ≈0.5 (9941), ≈0.2 (9942), gone 9943 — no motion

### P5 — 9:13.0 — frames 13270-13399 over camera A (cut-in 13240, cut-out 13400)

Context: box 1200 wide, x 360-1559, y ≈795-955 after wrap. Text: “Make three new versions for this audience. Change the hook.\nKeep the offer and the rest of the ad consistent.”

**Entrance** 13270-13273. pure 4-f fade, ≤1.5 px motion
- opacity: 13270:0.27, 13271:0.49, 13272:0.75, 13273:1.0
- fit fit: cubic-bezier(0.312, 0.4, 0.041, 0.0) from f13269 (0) to f13273 (1), RMS residual 0.004; residuals (frame:px) 13270:+0 13271:-0 13272:+0.01 13273:+0

**Typing** — ≈1.7 chars/frame steady, short holds at word ends (13278-79, 13316-17); line 2 starts 13306 with the box growing 1 line (button cy 903.6→915.7 over 13305-13311); done 13334. Mean 1.74 chars/frame.

| frame | ≈chars | line1 right x | line2 right x |
|---|---|---|---|
| 13272 | 1 | 404 |  |
| 13273 | 3 | 426 |  |
| 13274 | 5 | 447 |  |
| 13275 | 9 | 492 |  |
| 13276 | 11 | 516 |  |
| 13277 | 12 | 537 |  |
| 13278 | 15 | 572 |  |
| 13279 | 15 | 572 |  |
| 13280 | 18 | 607 |  |
| 13281 | 20 | 630 |  |
| 13282 | 20 | 635 |  |
| 13283 | 23 | 665 |  |
| 13284 | 24 | 678 |  |
| 13285 | 25 | 695 |  |
| 13286 | 27 | 719 |  |
| 13287 | 29 | 734 |  |
| 13288 | 30 | 748 |  |
| 13289 | 31 | 768 |  |
| 13290 | 33 | 789 |  |
| 13291 | 34 | 803 |  |
| 13292 | 36 | 825 |  |
| 13293 | 38 | 854 |  |
| 13294 | 41 | 883 |  |
| 13295 | 41 | 889 |  |
| 13296 | 43 | 915 |  |
| 13297 | 46 | 943 |  |
| 13298 | 47 | 958 |  |
| 13299 | 49 | 988 |  |
| 13300 | 51 | 1005 |  |
| 13301 | 52 | 1019 |  |
| 13302 | 53 | 1034 |  |
| 13303 | 56 | 1071 |  |
| 13304 | 57 | 1086 |  |
| 13305 | 59 | 1106 |  |
| 13306 | 61 | 1106 | 399 |
| 13307 | 62 | 1106 | 413 |
| 13308 | 65 | 1106 | 442 |
| 13309 | 66 | 1106 | 459 |
| 13310 | 68 | 1106 | 473 |
| 13311 | 69 | 1106 | 488 |
| 13312 | 72 | 1106 | 520 |
| 13313 | 74 | 1106 | 542 |
| 13314 | 75 | 1106 | 552 |
| 13315 | 76 | 1106 | 572 |
| 13316 | 79 | 1106 | 602 |
| 13317 | 79 | 1106 | 602 |
| 13318 | 82 | 1106 | 633 |
| 13319 | 83 | 1106 | 648 |
| 13320 | 85 | 1106 | 665 |
| 13321 | 87 | 1106 | 692 |
| 13322 | 88 | 1106 | 701 |
| 13323 | 90 | 1106 | 723 |
| 13324 | 91 | 1106 | 733 |
| 13325 | 93 | 1106 | 762 |
| 13326 | 95 | 1106 | 778 |
| 13327 | 97 | 1106 | 798 |
| 13328 | 98 | 1106 | 813 |
| 13329 | 100 | 1106 | 835 |
| 13330 | 102 | 1106 | 864 |
| 13331 | 104 | 1106 | 884 |
| 13332 | 105 | 1106 | 897 |
| 13333 | 107 | 1106 | 920 |
| 13334 | 109 | 1106 | 944 |

(≈chars = from the measured right edge of the white ink ÷ mean glyph advance; ±1 char.)

**Cursor** — note: enters lower-right 13346, settles on button 13356; no press seen

**Exit** — frames: 13396-13399; opacity: {'13396': 0.93, '13397': 0.72, '13398': 0.48, '13399': 0.3}; note: fade starts 4 f before the cut at 13400 and is cut off at 0.30
- fit: cubic-bezier(0.409, 0.109, 0.15, 0.312) from f13395 (1) to f13401 (0), RMS residual 0.002; residuals 13396:+0 13397:+0 13398:-0 13399:+0

### Prompt-bar keyframe recipes (24 fps, relative frames)

| move | keyframes | easing (fit) | conf |
|---|---|---|---|
| Overlay entrance (P2 style) | f0: opacity 0, y +20 px, scale 0.97, blur 8 px → f4: opacity 0.95, blur 0 → f9: y 0, scale 1 | opacity cubic-bezier(0.59,1.19,0.73,0.90) ≈ ease-out; y ≈ linear-to-ease-out | med |
| Overlay entrance (P5 style) | f0 opacity 0 → f3 opacity 1, no motion | linear (4 points, any curve fits) | med |
| Showcase entrance (P1) | f0: opacity 0, y +45, scale 0.94 → f6: opacity 1 → f8: settled | opacity cubic-bezier(0.65,0.52,0.35,0.98) | med |
| Laptop morph (P4) | f0-2 laptop lid tints to #202020; f3 rect = lid (888 px wide) → f12 rect = 1200x353 box; f8 controls fade; f14-16 attachment fades | width cubic-bezier(0.35,-0.01,0.10,0.98) (strong ease-out) | med |
| Typing | linear chars over N frames; glyph fade-in 1-2 f; no caret | linear | high |
| Line wrap | bar grows 1 line, centred, over 6-8 f | ease-out | med |
| Cursor in | from (+60,+55) px to button centre over 8-10 f, motion blur | ease-out | med |
| Click | button scale 1→0.89 (2 f) →1 (3-4 f), blue darkens ~10% at bottom of press | ease-in-out | high (P1,P3) |
| Showcase whip (P1) | bar translates ≈-1330 px over ~11 f with horizontal motion blur | tail cubic-bezier(0.24,0.50,0.30,1.0) | med |
| Slide-to-bottom (P3) | y +404 px over 18 f after 20-f hold | cubic-bezier(0.31,0.09,0.22,1.0) | high |
| Showcase exit (P1) | up-right fly-out, y -481 px, x +309 px, scale →0.79 over 10 f | ease-in cubic-bezier(0.85,0,1,1.2) | med |
| Overlay exit | opacity 1→0 over 4-5 f, y -10..-18 px (P2) or none (P4,P5); may straddle/cut at the next camera cut | P2 cubic-bezier(0.17,0.08,0.05,0.70) | high |
| Result squares (P3) | 5 cards, 2-f stagger; each fades dark→pink in 4 f, rises 47 px over 14 f, cross-fades to image in 6 f | rise cubic-bezier(0.21,-0.10,0.27,0.97) | high |
| 1:1 → 9:16 (P3) | pink flash 2 f (2-f stagger) then grow 304²→287x510 over ~17 f, image cross-fade 6 f | top-edge cubic-bezier(0.63,0.17,0.34,0.89) | high |

Bezier fits with ≤5 samples (P5 entrance/exit, P1 entrance top) are under-determined: use the per-frame values, not the curve.

## B. Camera / edit moves

**Framings** — A: frontal MCU behind silver laptop, S-mural left (ref frame 322); W: wide 3/4 from presenter's right showing room, sofa left, window right (ref 4390); B: 45° side close-up, presenter facing frame-right, window/city behind (ref 4458).

Three locked framings, not two cameras + punch-ins: none of A/W/B is a crop of another (best NCC of gradient images across framings ≈0.2 = noise level vs 0.55-0.75 within a framing; visual check cmpB.jpg). Every camera shot of a framing registers to its reference at scale exactly 1.00 ±0.004 with zero shift (fine search 0.96-1.06 step 0.004 on 11 long shots) → tripod-locked, no handheld drift, no slow push.

**Digital punch-ins: exactly one in the whole video.** an ANIMATED zoom 1.0→1.5 over 10 f with motion blur on 332-333, then holds 1.5 until the cut at 377. Crop centre x 0.50, y 0.50→0.374 (moves up toward the face as it zooms).

| frame | 330 | 331 | 332 | 333 | 334 | 335 | 336 | 337 | 338 | 339 | 340 | 341 | 342 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| scale | 1.0 | 1.01 | 1.14 | 1.25 | 1.32 | 1.37 | 1.41 | 1.44 | 1.46 | 1.48 | 1.49 | 1.5 | 1.5 |

Fit: cubic-bezier(0.194, -0.013, 0.003, 0.813) from f330.5 (1.0) to f341 (1.5), RMS residual 0.002. Scan: 2409 frames sampled every 4 f in every A/W/B shot against their reference at scale 1.0-1.6: all 1.00 except 3 frames at the head of segment 6576 that belong to the preceding vertical-video graphic (not a zoom), and the outro logo frames after 14717 → no other punch-ins in the video. Gemini's "punch-in" shots are the B (side close-up) camera.

**Cut detection:** ffmpeg scene score per frame (320x180), local-peak picking (score ≥0.06 and >4x local median), every peak checked on contact sheets; 202 raw peaks → 143 shots after merging peaks caused by graphics (e.g. 733 "e-com", 252 floating cards) and internal cuts inside screencasts/vertical videos. Weak-peak search (≥0.015) inside camera shots found no same-framing jump cuts — every cut changes framing.

### Shot-length distribution (seconds)

| class | n | total | median | mean | min | p25 | p75 | max |
|---|---|---|---|---|---|---|---|---|
| A | 46 | 177.3 | 3.73 | 3.86 | 0.75 | 2.25 | 5.62 | 8.17 |
| B | 40 | 115.7 | 2.73 | 2.89 | 1.12 | 2.25 | 3.71 | 5.88 |
| W | 29 | 107.5 | 3.08 | 3.71 | 1.21 | 1.88 | 4.79 | 10.33 |
| MG | 15 | 102.3 | 7.0 | 6.82 | 2.29 | 3.17 | 9.46 | 15.0 |
| SC | 8 | 60.0 | 8.1 | 7.5 | 3.46 | 7.46 | 8.83 | 9.0 |
| VID | 3 | 47.9 | 13.33 | 15.96 | 9.04 | 9.04 | 25.5 | 25.5 |
| BROLL | 2 | 10.5 | 5.23 | 5.23 | 4.96 | 4.96 | 5.5 | 5.5 |
| A* | 1 | 1.9 | 1.88 | 1.88 | 1.88 | 1.88 | 1.88 | 1.88 |

Classes: A,W,B = cameras; A* = A shot after the animated punch (331-377); MG = full-screen motion graphic; SC = screencast; VID = full-screen vertical (9:16) video ad; BROLL = generated/VFX b-roll (377-496 hand-from-laptop; 7523-7655 soundstage)

### Transitions (what follows what)

| from → to | n |
|---|---|
| A → B | 23 |
| B → A | 22 |
| W → A | 14 |
| A → W | 13 |
| W → B | 10 |
| B → MG | 6 |
| B → W | 6 |
| MG → A | 5 |
| MG → W | 5 |
| A → MG | 5 |
| MG → B | 4 |
| W → MG | 3 |
| B → SC | 3 |
| SC → A | 3 |
| SC → B | 3 |
| VID → W | 3 |
| A → SC | 3 |
| BROLL → A | 2 |
| W → SC | 2 |
| SC → W | 2 |
| B → VID | 2 |
| A → A* | 1 |
| A* → BROLL | 1 |
| B → BROLL | 1 |
| A → VID | 1 |

Sequence (· = non-camera, a = A after punch-in):

`·AWAa·AWABAWB·WAW·B·A·BAB·AWBA·BW·B·B·ABW·W·WBAB·AB·W·WA·AWBWB·WABAB·WAWB·ABA·WBABWABAWA·ABABAWBA·BABWAB·A·BABABAWAWA·WAB·WABABABABABAWBWBAWABA·`

**Pattern:** Camera shots alternate A↔B most (A→B 23, B→A 22), with W inserted as the third angle (A↔W 27, W→B 10, B→W 6). Never the same framing twice in a row. Graphics/screencasts are entered from any camera and exit to any camera. Camera shot medians: A 3.7 s, W 3.1 s, B 2.7 s (B close-ups are the shortest); full-screen MG median 7.0 s, SC 8.1 s.

**Cuts vs speech:** 85 camera→camera cuts vs YouTube ASR word onsets and 10-ms mid-band energy: cut-frame speech energy is a median 11.8 dB below the local speech level and 61% of cuts sit in a pause (<-10 dB); the next word starts a median 123 ms after the cut (p25 68, p75 197 ms) and the previous word is sentence/clause-final in most cases (e.g. "today.", "framework.", "screen.", "visuals."). → cuts land in the inter-sentence gap, ~0.1-0.2 s BEFORE the next sentence starts. Confidence medium (ASR onsets ±~100 ms).

**Outro:** 14717-14733: the A frame shrinks into a rounded card that morphs into the app logo on a black/pink-glow background (not a cut)

### Full shot list

| # | start f | tc | dur s | class |
|---|---|---|---|---|
| 1 | 0 | 0:00.00 | 8.71 | MG |
| 2 | 209 | 0:08.71 | 3.17 | A |
| 3 | 285 | 0:11.88 | 1.21 | W |
| 4 | 314 | 0:13.08 | 0.75 | A |
| 5 | 332 | 0:13.83 | 1.88 | A* |
| 6 | 377 | 0:15.71 | 4.96 | BROLL |
| 7 | 496 | 0:20.67 | 4.5 | A |
| 8 | 604 | 0:25.17 | 2.38 | W |
| 9 | 661 | 0:27.54 | 1.67 | A |
| 10 | 701 | 0:29.21 | 3.17 | B |
| 11 | 777 | 0:32.38 | 6.25 | A |
| 12 | 927 | 0:38.62 | 3.46 | W |
| 13 | 1010 | 0:42.08 | 1.46 | B |
| 14 | 1045 | 0:43.54 | 8.92 | MG |
| 15 | 1259 | 0:52.46 | 3.88 | W |
| 16 | 1352 | 0:56.33 | 4.92 | A |
| 17 | 1470 | 1:01.25 | 1.29 | W |
| 18 | 1501 | 1:02.54 | 3.17 | MG |
| 19 | 1577 | 1:05.71 | 2.25 | B |
| 20 | 1631 | 1:07.96 | 2.29 | MG |
| 21 | 1686 | 1:10.25 | 1.38 | A |
| 22 | 1719 | 1:11.62 | 3.42 | MG |
| 23 | 1801 | 1:15.04 | 4.38 | B |
| 24 | 1906 | 1:19.42 | 4.96 | A |
| 25 | 2025 | 1:24.38 | 3.71 | B |
| 26 | 2114 | 1:28.08 | 7.67 | SC |
| 27 | 2298 | 1:35.75 | 1.67 | A |
| 28 | 2338 | 1:37.42 | 4.88 | W |
| 29 | 2455 | 1:42.29 | 2.54 | B |
| 30 | 2516 | 1:44.83 | 3.92 | A |
| 31 | 2610 | 1:48.75 | 5.33 | MG |
| 32 | 2738 | 1:54.08 | 3.62 | B |
| 33 | 2825 | 1:57.71 | 1.75 | W |
| 34 | 2867 | 1:59.46 | 9.0 | SC |
| 35 | 3083 | 2:08.46 | 1.88 | B |
| 36 | 3128 | 2:10.33 | 3.46 | SC |
| 37 | 3211 | 2:13.79 | 1.21 | B |
| 38 | 3240 | 2:15.00 | 15.0 | MG |
| 39 | 3600 | 2:30.00 | 3.29 | A |
| 40 | 3679 | 2:33.29 | 3.12 | B |
| 41 | 3754 | 2:36.42 | 5.0 | W |
| 42 | 3874 | 2:41.42 | 7.83 | MG |
| 43 | 4062 | 2:49.25 | 4.67 | W |
| 44 | 4174 | 2:53.92 | 7.46 | SC |
| 45 | 4353 | 3:01.38 | 3.08 | W |
| 46 | 4427 | 3:04.46 | 2.58 | B |
| 47 | 4489 | 3:07.04 | 2.17 | A |
| 48 | 4541 | 3:09.21 | 2.58 | B |
| 49 | 4603 | 3:11.79 | 8.83 | SC |
| 50 | 4815 | 3:20.62 | 4.21 | A |
| 51 | 4916 | 3:24.83 | 2.29 | B |
| 52 | 4971 | 3:27.12 | 2.54 | MG |
| 53 | 5032 | 3:29.67 | 2.54 | W |
| 54 | 5093 | 3:32.21 | 7.0 | MG |
| 55 | 5261 | 3:39.21 | 1.88 | W |
| 56 | 5306 | 3:41.08 | 3.92 | A |
| 57 | 5400 | 3:45.00 | 10.54 | MG |
| 58 | 5653 | 3:55.54 | 7.08 | A |
| 59 | 5823 | 4:02.62 | 2.62 | W |
| 60 | 5886 | 4:05.25 | 4.21 | B |
| 61 | 5987 | 4:09.46 | 6.71 | W |
| 62 | 6148 | 4:16.17 | 4.5 | B |
| 63 | 6256 | 4:20.67 | 13.33 | VID |
| 64 | 6576 | 4:34.00 | 7.12 | W |
| 65 | 6747 | 4:41.12 | 3.04 | A |
| 66 | 6820 | 4:44.17 | 2.46 | B |
| 67 | 6879 | 4:46.62 | 2.38 | A |
| 68 | 6936 | 4:49.00 | 2.88 | B |
| 69 | 7005 | 4:51.88 | 9.46 | MG |
| 70 | 7232 | 5:01.33 | 1.75 | W |
| 71 | 7274 | 5:03.08 | 3.71 | A |
| 72 | 7363 | 5:06.79 | 2.54 | W |
| 73 | 7424 | 5:09.33 | 4.12 | B |
| 74 | 7523 | 5:13.46 | 5.5 | BROLL |
| 75 | 7655 | 5:18.96 | 1.96 | A |
| 76 | 7702 | 5:20.92 | 2.12 | B |
| 77 | 7753 | 5:23.04 | 5.46 | A |
| 78 | 7884 | 5:28.50 | 8.54 | SC |
| 79 | 8089 | 5:37.04 | 1.62 | W |
| 80 | 8128 | 5:38.67 | 1.58 | B |
| 81 | 8166 | 5:40.25 | 3.75 | A |
| 82 | 8256 | 5:44.00 | 3.12 | B |
| 83 | 8331 | 5:47.12 | 1.46 | W |
| 84 | 8366 | 5:48.58 | 2.17 | A |
| 85 | 8418 | 5:50.75 | 2.96 | B |
| 86 | 8489 | 5:53.71 | 0.96 | A |
| 87 | 8512 | 5:54.67 | 1.58 | W |
| 88 | 8550 | 5:56.25 | 0.88 | A |
| 89 | 8571 | 5:57.12 | 6.42 | SC |
| 90 | 8725 | 6:03.54 | 8.17 | A |
| 91 | 8921 | 6:11.71 | 5.12 | B |
| 92 | 9044 | 6:16.83 | 2.83 | A |
| 93 | 9112 | 6:19.67 | 1.88 | B |
| 94 | 9157 | 6:21.54 | 2.42 | A |
| 95 | 9215 | 6:23.96 | 2.12 | W |
| 96 | 9266 | 6:26.08 | 1.88 | B |
| 97 | 9311 | 6:27.96 | 6.25 | A |
| 98 | 9461 | 6:34.21 | 8.62 | SC |
| 99 | 9668 | 6:42.83 | 3.88 | B |
| 100 | 9761 | 6:46.71 | 7.42 | A |
| 101 | 9939 | 6:54.12 | 2.42 | B |
| 102 | 9997 | 6:56.54 | 3.25 | W |
| 103 | 10075 | 6:59.79 | 2.83 | A |
| 104 | 10143 | 7:02.62 | 2.38 | B |
| 105 | 10200 | 7:05.00 | 2.75 | MG |
| 106 | 10266 | 7:07.75 | 2.25 | A |
| 107 | 10320 | 7:10.00 | 5.5 | MG |
| 108 | 10452 | 7:15.50 | 2.88 | B |
| 109 | 10521 | 7:18.38 | 3.75 | A |
| 110 | 10611 | 7:22.12 | 1.5 | B |
| 111 | 10647 | 7:23.62 | 6.67 | A |
| 112 | 10807 | 7:30.29 | 3.33 | B |
| 113 | 10887 | 7:33.62 | 2.42 | A |
| 114 | 10945 | 7:36.04 | 3.62 | W |
| 115 | 11032 | 7:39.67 | 4.67 | A |
| 116 | 11144 | 7:44.33 | 6.46 | W |
| 117 | 11299 | 7:50.79 | 2.5 | A |
| 118 | 11359 | 7:53.29 | 25.5 | VID |
| 119 | 11971 | 8:18.79 | 2.83 | W |
| 120 | 12039 | 8:21.62 | 3.29 | A |
| 121 | 12118 | 8:24.92 | 3.12 | B |
| 122 | 12193 | 8:28.04 | 9.04 | VID |
| 123 | 12410 | 8:37.08 | 10.33 | W |
| 124 | 12658 | 8:47.42 | 5.88 | A |
| 125 | 12799 | 8:53.29 | 1.12 | B |
| 126 | 12826 | 8:54.42 | 5.92 | A |
| 127 | 12968 | 9:00.33 | 2.38 | B |
| 128 | 13025 | 9:02.71 | 2.0 | A |
| 129 | 13073 | 9:04.71 | 1.62 | B |
| 130 | 13112 | 9:06.33 | 1.54 | A |
| 131 | 13149 | 9:07.88 | 3.79 | B |
| 132 | 13240 | 9:11.67 | 6.67 | A |
| 133 | 13400 | 9:18.33 | 5.88 | B |
| 134 | 13541 | 9:24.21 | 4.04 | A |
| 135 | 13638 | 9:28.25 | 4.79 | W |
| 136 | 13753 | 9:33.04 | 3.08 | B |
| 137 | 13827 | 9:36.12 | 3.46 | W |
| 138 | 13910 | 9:39.58 | 4.12 | B |
| 139 | 14009 | 9:43.71 | 5.67 | A |
| 140 | 14145 | 9:49.38 | 9.25 | W |
| 141 | 14367 | 9:58.62 | 6.42 | A |
| 142 | 14521 | 10:05.04 | 2.54 | B |
| 143 | 14582 | 10:07.58 | 5.62 | A |
| 144 | 14717 | 10:13.21 | 9.88 | MG |

## C. SFX and music mix

**Loudness** (high): integrated -16.3 LUFS, LRA 2.7 LU, true peak -0.7 dBTP.

**Music bed** (medium (pause level includes room tone/SFX tails)): speech windows median -16.9 dBFS RMS, pauses median -32.3 dBFS (IQR [-35.1, -29.8]), music-only outro -26.2 dBFS. music bed ≈ 15 dB under voice (−32 vs −17 dBFS RMS); outro music alone ≈ −26 dBFS, i.e. the bed is raised ~6 dB once speech ends. Ducking: no evidence of sidechain ducking: in 13 pauses ≥500 ms the bed is −31.1 dB in the first 100 ms and −34.8 dB in the last 100 ms (would rise if ducked). Treat as a constant low bed (~−32 dBFS RMS) under VO, raised only for the outro.

### Entrance SFX timing (10-ms envelopes, HF band >5 kHz vs voice band 0.3-3 kHz)

| event | first visible f | HF peak offset ms | −6 dB burst ms | HF−mid dB | conf | note |
|---|---|---|---|---|---|---|
| e-com big word (pink/white) | 732 | +60 | 130 | -9.8 | low | voice-masked; broadband HF swell starting ~-330 ms before (whoosh-like riser into the word?) |
| prompt bar 0:43 fade-in | 1047 | +15 | 20 | 0.6 | low | very short HF tick at +15..+25 ms |
| prompt bar 0:43 submit click (press 1092-1093) | 1092 | -14 (rel. press) | 10 | -18.1 | low | single 10 ms HF tick 1098.7 = during exit, not at press |
| prompt box 1:35 entrance | 2302 | +123 | 40 | 11.3 | med | non-voice HF transient (hb-mb +11 dB), 40 ms: pop/click |
| prompt box 1:35 submit press (2326) | 2326 | +73 | 50 | 11.6 | med | HF transient 50 ms: click |
| RESEARCH & COPY glyph | 2358 | +90 | 80 | 12.6 | med | HF burst 80 ms (pop/sparkle) |
| KEEP IT SIMPLE text | 4862 | +17 | 70 | 6.6 | med | HF burst ~70 ms starting at onset (pop) |
| prompt bar 3:44 fade-in | 5403 | +145 | 30 | 9.0 | low-med | HF tick 30 ms |
| prompt bar 3:44 submit press (5428) | 5428 | +163 | 10 | 4.5 | low |  |
| 3:44 pink placeholders turn pink (5520) | 5520 | +50 | 70 | 14.2 | med | HF burst 70 ms |
| WHAT ABOUT VIDEO? | 5862 | -120 | 40 | 1.7 | low | speech-masked |
| CPL text | 6912 | +100 | 90 | 9.6 | med | HF burst 90 ms (pop/chime attack) |
| WHAT AD DO WE RUN NEXT? (on a cut) | 8512 | -147 | 120 | 8.1 | low-med | HF swell 120 ms ending before the cut: whoosh lead-in |
| TEST THE ORGANIC | 9227 | -108 | 50 | 14.1 | low-med | HF 50 ms ending ~100 ms before visual |
| prompt box 6:46 laptop morph | 9770 | -43 | 70 | 12.7 | med | strong HF 70 ms (+52 dB above floor) starting ~130 ms before morph start |
| EXCLUSIVITY | 10980 | +120 | 60 | 0.7 | low |  |
| A/B TEST | 13124 | -153 | 350 | -11.5 | low | speech-masked |
| prompt bar 9:12 fade-in | 13270 | -87 | 70 | -15.9 | low | voice |
| HOOK RATE | 13694 | -23 | 30 | -9.9 | low | voice |
| TOTAL ~$100 | 13881 | -145 | 80 | -9.9 | low | voice |

Of 20 graphic/UI events, 9 show a clearly non-voice HF transient (HF−mid ≥ +6 dB, global p90 is −3.4 dB) within −150…+165 ms of the first visible frame; median of those ≈ +60 ms after the visual (bar2 +123, click2 +73, research +90, keep +17, bar3 +145, pinks +50, cpl +100, organic −108, morph −43, runnext −147). Envelopes are short (30-90 ms at −6 dB) → pops/clicks; the two longer ones (runnext 120 ms, e-com 130 ms + 300 ms rise) are whoosh-like and LEAD the visual. Recipe: pop/click SFX with transient at +2 f (≈ +60-120 ms) after the element's first frame; whooshes start ≈ 4-8 f before a word that enters on a cut.

**LOW overall: measured on the full mix where voice sibilants dominate the same band; no stem, no listening. What would change it: a music/SFX stem, or a listening pass on these 20 timestamps.**

## What would change these numbers

- Prompt-bar geometry/timing: high confidence (exact raw frames). Font: a glyph-level overlay against Inter vs SF Pro at the measured size would confirm.
- Border colour at 1x and shadow: measured on one frame each; a frame over a flat bright background would pin them.
- Shot classes: verified on contact sheets; segment boundaries are scene-score peaks ±0 f for hard cuts. Shot counts depend on how graphics with internal cuts are merged (I merged them).
- SFX: no stem → low confidence on every SFX number; music-bed level medium. A stem or listening pass would replace the HF-proxy table.
- Cuts vs words: YouTube ASR word onsets (±~100 ms).
