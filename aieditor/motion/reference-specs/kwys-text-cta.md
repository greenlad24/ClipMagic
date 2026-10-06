# Reference 2 (kwysV2smgfY): text and CTA graphics, a frame-measured spec

**Source:** `kwysV2smgfY/video.mp4`, 1920x1080, 30000/1001 fps.

**Frame numbering:** frame = round(pts × 29.97). This is the same as the decode index; it was checked against an exact `select=n` decode and showed 0 frames of error.

**Offsets:** k = frames from the element's first visible frame.

**Data file:** every per-frame table is in `kwys-text-cta.json`. The tables are the keyframes; interpolate linearly between them. The beziers are approximations, and their rms is listed in the JSON.

**Kit warning:** at 29.97 fps, `kit/strip.sh` and `frames.sh` (which use `-ss t`) can label frames 1 frame off. The ffmpeg seek lands on the floor frame or the ceiling frame depending on the timestamp. All grabs here used pts-select instead: see `work/kwys-text-cta/grab.sh` and `proof.sh`.

## 0. Headline
1. **There are two text templates, not one.**
   - **(A) Lower-centre title** (Roboto Bold). Each character fades in while dropping 36 px. The characters are staggered left to right, and the stagger is normalised to the line. On exit, each character fades while rising about 60 px, with the same stagger.
   - **(B) "Link in the description"** (Open Sans Bold with a white glow). The whole line slides up rigidly from below the frame edge and later slides back down. It is the same 69-frame clip all 3 times, identical to the frame.
2. **No blur and no scale on either template.** A per-glyph sharpness ratio of 0.97–1.09 during motion confirms this. There is also no measurable shadow on (A).
3. **Titles and social icons live inside the camera layer.**
   - The opening title shrinks with a whole-frame zoom-out from 1.576 to 1.0 over f0–41.
   - The icons ride a punch-in, then a pan, then a zoom-out.
   - In comp space the icons are pixel-static (±3 px).
   - So the renderer should parent these overlays to the camera transform, and the measured motion here is the overlay's own motion in comp space.
4. **The Subscribe button is a different asset from reference 1's.**
   - It is a plain red rectangle, not the red brand pill with logo, sparkles and dark #1E1E1E state.
   - Sequence: the box scales in along X → a cursor fades in and rises → click → a red→white crossfade to "SUBSCRIBED" while the box slides left and a separate bell square slides out to the right → the cursor moves to the bell → the bell greys → the cursor leaves.
   - It has no exit of its own; it hard-cuts with the shot.
   - What it shares with reference 1 is only the idea: a cursor press, then a state change, then a bell.
5. **No other overlays.** A 2 fps scan of the whole video found none beyond these elements: titles ×3, Link ×3, Subscribe, TikTok/Instagram. Screencast UI and the 0:06.6 three-phone AI asset are not overlays.

## 1. Template A: lower-centre title (per-character)
**Font**
- Roboto Bold 700, white, tracking 0, centred on x = 960.
- Evidence from a chromium render against the reference mask: "Hey everyone" width ratio 1.004, IoU 0.86. The next-best candidates scored IoU ≤ 0.46.
- Sizes: 94 px for "UGC AI videos / Made easy" and 75.5 px for "Hey everyone…" and "I'm Jake Dawson".
- Line pitch: 1.08 em for UGC (baselines 903/1004) and 92 px for Hey (baselines 873/965).
- "I'm Jake Dawson" baseline: 904.

**Entrance per character** (k from that character's own start):

| k | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| opacity | 0 | .125 | .322 | .518 | .665 | .771 | .852 | .903 | .946 | .969 | .987 | .996 | 1 |
| translateY px | −36 | −31.6 | −24 | −17.7 | −12.2 | −8.9 | −6 | −4 | −2.2 | −1.1 | −1 | 0 | 0 |

- Opacity and position follow one progress curve: p = cubic-bezier(0.22, 0.34, 0.23, 1.0) over 12 f. Opacity = p and translateY = −36·(1−p). The opacity fit has rms 0.003.
- The characters come **from above, moving down**.
- The travel is 36 px at both font sizes, so it is **fixed px** (3.3 % of frame height), not em.
- This comes from 5 lines and 1133 samples.

**Stagger**
- Character i starts at k0 + 4.15·i/(N−1). Here i is the character index **including spaces**, and N is the number of characters in the line.
- First-to-last spread measured per line: 4.16, 4.07, 3.83, 4.26 and 4.14 f, independent of length.
- The character-index model gives rms 0.06–0.13 f, which beats both the x-position model and the letter-index model.

**Exit per character:**

| k | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| opacity | 1 | .996 | .947 | .843 | .697 | .533 | .382 | .253 | .156 | .069 | 0 |
| translateY px | 0 | 0 | −4 | −11 | −21 | −32 | −41 | −48 | −53 | −57 | ≈−60 |

- The curve is ease-in-out; the opacity bezier is (0.346, 0.123, 0.404, 0.684) over 9 f.
- The stagger rule is the same as the entrance.
- **All lines of a block start their exit on the same frame**, each with its own L→R stagger.

**Instances and timing against speech**
- Word onsets come from Groq Whisper words force-aligned with wav2vec2.
- The text leads the first spoken word of its phrase by **5–8 f** (median 5.8 f, about 190 ms). "I'm Jake Dawson" is the exception at 12.5 f, because it starts as soon as the Hey block is gone.
- The exit starts near the last word: between 2 and 12 f before that word ends.

| element | line k0 | speech | exit k0 | gone |
|---|---|---|---|---|
| UGC AI videos | f1.7 | "Making" f6.6 | f94.7 (both lines) | f104 |
| Made easy | f50.8 | "has (become so easy)" f56.0 | — | — |
| Hey everyone | f1720.7 (shot cut f1719/20) | "Hey" f1726.5 | f1768.8 | f1778 |
| welcome back to the channel | f1742.4 | "welcome" f1750.6 | same | — |
| I'm Jake Dawson | f1781.7 | "I'm" f1794.2 | f1813.7 ("Dawson" ends f1815.9) | f1822 |

- The on-screen title words paraphrase the speech ("UGC AI videos / Made easy" over "Making UGC AI videos has become so easy").
- **The UGC title rides the camera layer.**
  - The whole frame, text included, zooms out from 1.5755 to 1.0 over f2–41, bezier(0.086, 0.366, 0, 0.956) over 37.8 f.
  - From f56 the frame slowly pushes in, reaching 1.0095 at f89.
  - The text's own motion above was measured after removing this zoom. The text and background scales agree to within 0.003.

## 2. Template B: "Link in the description" (rigid slide)
**Look**
- Open Sans Bold 700 at 90 px, white. Evidence: width ratio 0.997, IoU 0.97 width-matched.
- Ink box 464–1455 × 893–970, centred on x = 959.5.
- White outer glow: about +67 grey levels at 2–3 px, falling to 0 by 15 px. That is roughly a Gaussian with σ 7–8 px at ~70 % opacity. Confidence is medium.

**Motion** (translateY in px from the rest position; positive = down; the clip is identical to the frame across all 3 instances):

| phase | k: translateY px |
|---|---|
| in | 0: 184 · 1: 159 · 2: 135 · 3: 114 · 4: 96 · 5: 80 · 6: 66 · 7: 55 · 8: 45 · 9: 36 · 10: 29 · 11: 23 · 12: 18 · 13: 14 · 14: 10 · 15: 7 · 16: 5 · 17: 3 · 18: 2 · 19: 1 · 20: 0 |
| hold | k20–56 |
| out | 57: 1 · 58: 3 · 59: 7 · 60: 13 · 61: 23 · 62: 37 · 63: 55 · 64: 79 · 65: 106 · 66: 132 · 67: 156 · 68: 176 · 69: gone |

- k0 is the frame where the ascenders cross the frame bottom.
- In-curve fit: bezier(0.283, 0.501, 0.304, 1) from about 315 px below, starting k−5.3, over 26.5 f; rms 0.2 px on the visible frames.
- Out-curve: ease-in bezier(0.593, 0, 0.519, 0.601), 0→215 px over 14.7 f.
- Opacity is 1 throughout. There is no scale and no per-character stagger.

**Instances**

| k0 | spoken word | exit k0 |
|---|---|---|
| f13551 | "link" f13553.9 | f13608 |
| f19242 | "link" f19240.3 | f19299 |
| f20105 | "links" f20100.5 | f20162 |

- The clip appears within −3 to +5 f of the word "link(s)".
- It has a fixed 69 f lifetime, not tied to the end of the sentence.

## 3. Subscribe → Subscribed (k0 = f1971, 1:05.77)
**Box entrance**
- A red #FD1728 box, 552×124, radius about 7 px, centred at (960, 938).
- It scales along X only, from the centre, at full height from k0. A faint 1–2 px line is already visible at k−1.
- Width per frame: k0: 4 · 1: 7 · 2: 12 · 3: 16 · 4: 24 · 5: 33 · 6: 48 · 7: 64 · 8: 84 · 9: 112 · 10: 150 · 11: 204 · 12: 276 · 13: 348 · 14: 401 · 15: 440 · 16: 468 · 17: 488 · 18: 505 · 19: 517 · 20: 528 · 21: 536 · 22: 540 · 23: 545 · 24: 548 · 25: 550 · 26: 552.
- Fit: bezier(0.675, 0.092, 0.194, 1) over 26.9 f, which is exponential-like.

**Label**
- "SUBSCRIBE", white, uniform scale-in about the box centre. It is tiny from about k11. Measured scale: k21 .18 · k22 .23 · k23 .29 · k24 .40 · k25 .59 · k26 .70 · k28 .81 · k30 .87 · k33 .92 · k36 .96 · k40 .99 · k43 1.0.
- Face: a heavy italic. Roboto Black Italic was the closest of those tried (width 1.003, IoU 0.80). Confidence is low.

**Cursor approach and click**
- The cursor fades in while rising about 35 px from below, over k59–67. Tip positions: k64 (987, 989) → k70 (986, 968), then it holds.
- Click at k73 (f2044), inside the spoken word "subscribe" (f2032.8–2050.3). The cursor shrinks about 10 % for 1 frame. **The box has no press-scale.**

**State change** (k74–87)
- The red→white fill progress per frame is: 74: 0 · 75: .01 · 76: .04 · 77: .11 · 78: .25 · 79: .49 · 80: .75 · 81: .88 · 82: .96 · 83: .99 · 84: 1. The fit is bezier(0.638, 0.069, 0.348, 0.956) over 9.2 f.
- The label crossfades to grey #B2B2B2 "SUBSCRIBED" with a horizontal smear.
- The main box keeps its width (548–552) and slides left 98.5 px. Remaining offset per frame: k72 98.5 · 74 95 · 76 90.5 · 78 82 · 80 30.5 · 81 17.5 · 82 12.5 · 83 8.5 · 84 6.5 · 85 4 · 86 2 · 87 0. The motion is a slow start, a whip (about 25 px per frame), then a settle.
- The **bell box** (118×121 white, 16 px gap, final 1152–1270) emerges from behind the main box's right side and slides right. Remaining offset: k80 −59 · 81 −35 · 82 −22 · 83 −14 · 84 −8 · 85 −4 · 86 −1 · 87 0.
- Final layout: main box 587–1135 plus bell box 1152–1270, both spanning y 878–999.

**Cursor to the bell, bell click, exit**
- The cursor travels to the bell, ease-out: k87 (1067, 959) → k93 (1136, 953) → k99 (1179, 948) → k105 (1202, 946) → k110 (1208, 945).
- The bell is clicked at about k119 (f2090), during "button so". The bell glyph goes from dark to light grey in 2–3 f.
- The cursor leaves fast, down and left: k130 (1210, 946) → k131 (1178, 1009) → k132 (1144, 1072) → gone.
- **No exit animation:** hard cut at k178 (f2149).
- The button starts on "So if that sounds like you", 2 s before the word "subscribe".
- No subscribe SFX could be confirmed: speech masks the audio there. The Gemini notes mention a click and a chime; treat those as unverified.

## 4. Social icons (comp space; the camera is solved)
**Geometry**
- TikTok: black disc, 296 comp px, centre (379, 793). Its glyph is 194 px tall.
- Instagram: gradient squircle, 280 comp px, corner radius about 52, centre (1522, 795).
- Both sit on the same y, roughly mirrored about the frame centre.

**Rise** (translateY, comp px from the rest position; pure translate with no scale or fade; k0 = first frame the top crosses the frame bottom):

| icon | k: translateY comp px |
|---|---|
| TikTok | 0: 288 · 1: 223 · 2: 168 · 3: 125 · 4: 90 · 5: 61 · 6: 39 · 7: 23 · 8: 11 · 9: 2 · 10: −2.5 · **11: −3.6** · 12: −3 · 14: −2.5 · 16: −1.1 · 18: 0 |
| Instagram | 0: 253 · 1: 191 · 2: 140 · 3: 99 · 4: 68 · 5: 44 · 6: 26 · 7: 13 · 8: 4 · 9: −0.5 · 10: −2.1 · 11: −2.1 · 12: −0.5 · 14: 0 |

- Fit: back-out, bezier(0.30, 1.19–1.29, 0.62–0.66, ~1) over 17–17.5 f, starting about 330–376 px below at k−1.
- Overshoot is about 1 %.

**Timing**
- TikTok k0 = f19796: 3 f after "follow"; it settles at f19807, on "TikTok" (f19808.6).
- Instagram k0 = f19825: 2.6 f after "Instagram" (f19822.4).
- The **stagger is 29 f**, set by the spoken words.

**Exit**
- Both icons fade together from f19867, with no motion of their own.
- Opacity per frame: 1 · .966 · .932 · .885 · .837 · .785 · .736 · .693 · .649 · .600 · .554 · .505 · .460 · .416 · .374 · .329 · .284 · .236 · .194 · .143 · .096 · .048 · 0 at k22.
- That is near-linear with a 2-frame ease-in. Opacity was solved by regressing against the hold template and a later background.

**Camera context** (this belongs to the camera family; the transform is p_comp = c + S(p_screen − c) + T):
- **Punch-in:** f19781–19813, screen zoom 1 → 1.2235, anchored left (Tx −140). bezier(0.317, 0.093, 0.238, 1) over 32 f.
- **Pan:** f19815–19840, Tx −140 → +138, which moves the screen 340 px left. bezier(0.329, 0.025, 0.291, 0.985) over 24 f. The pan starts about 7 f before "Instagram".
- **Zoom back out:** f19851–19894.
- On screen, the icons appear to "drift". That drift is all camera.

## 5. Confidence and gaps
**High confidence**
- Per-character title curves and the stagger rule.
- The Link clip (3 identical copies).
- Subscribe box, label, colour and slide tables.
- Icon rise and fade in comp space.
- Roboto and Open Sans faces.

**Medium confidence**
- Link glow model.
- Cursor path between k74 and k87 (it is occluded by the state change, so ±20 px).
- Label scale before k21, which is only visible as tiny text.
- Exit translate beyond invisibility (−60 is extrapolated).

**Low confidence**
- The Subscribe face.
- SFX. Correlating the three identical Link windows found no shared waveform, so there is probably no SFX baked into the clip. Subscribe and icon SFX could not be separated from speech.

**Not measured**
- Exact bell icon artwork.
- TikTok disc rim shading.
- Instagram gradient stops (design, not motion).

## Proof strips
All strips are in `/opt/aieditor-work/reference/work/kwys-text-cta/proof/`, labelled `f<abs> k<offset>`:
- Titles: `title_L1_in_k2`, `title_L2_in_k51`, `title_exit_k95`, `hey_L1_in_k1721`, `hey_L2_in_k1742`, `hey_exit_k1769`, `jake_in_k1782`, `jake_exit_k1814`.
- Link: `link1_in_k13551`, `link1_out_k13608`, `link2_in_k19242`, `link3_in_k20105`.
- Subscribe: `sub_in_k1971`, `sub_click_k1971`, `sub_bell_k1971`, `sub_cut_k1971`.
- Icons: `icons_tt_in_k19796`, `icons_ig_in_k19825`, `icons_exit_k19867`.

Other work files are in `work/kwys-text-cta/`:
- Per-glyph tables: `col_*.json`.
- Camera solves: `zoom_title.txt` and `cam_icons.txt`.
- Speech timings: `aud/*_aligned.json`.
