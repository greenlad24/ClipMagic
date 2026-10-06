# Screencast annotations, B-roll layouts, camera and sound — kwysV2smgfY (29.97 fps, 1920x1080)

Reference 2 = Jake Dawson's own tutorial (11:39). Machine-readable twin: `kwys-annotations-layouts.json`.
Work dir: `/opt/aieditor-work/reference/work/kwys-annot/`. Proof strips (frame-exact labels): `…/kwys-annot/proof/`.

**Frames**: absolute 0-based frame index of a full decode from frame 0 (30000/1001 fps). Tables are keyed **relative to the element's first visible frame** unless stated otherwise.
**Confidence**: high = directly measured and repeatable. med = measured with a known confound. low = inferred.

> ⚠️ **KIT BUG (affects every agent on this reference).** `kit/strip.sh`, `frames.sh` and `track.sh` decode with ffmpeg's default CFR output. This VP9 file has pts jitter (528/544 ticks of 1/16000), so ffmpeg inserts **one duplicate frame within the first 1–3 output frames**. Every label after that point is **1 frame too HIGH** (label F shows true frame F−1). The fix is `-fps_mode passthrough` on the decode. I verified it at f217–230 and f10830–10843 against a decode from the start. All numbers below come from exact decodes. My frame-exact strip helper is `work/kwys-annot/mystrip.sh` (same arguments as strip.sh, but takes frame numbers). The kit itself was not edited.

## Method (short)
- One full decode → 128x72 RGB proxy plus a 320x180 grey proxy (np.memmap). From these: cut detection, an A-roll classifier (NCC against A-roll prototypes), a whole-video yellow/orange colour scan, and a dissolve detector (frame = α·A + (1−α)·B).
- Annotations: full-res per-frame colour masks (row bands → x-runs). The screen camera was registered per frame (scale + translation against the stable frame, bubble masked), and every highlight edge was mapped into **screen-stabilised coordinates**, so wipe progress is free of zoom. Cubic-bezier fits use random search plus annealing (no scipy), with one shared curve tested jointly.
- Phone panels: per-panel bbox against the empty background frame. Pulldown duplicates were removed, the fit runs in 23.976 source frames, and a joint shared curve was fitted.
- Camera: brute-force zoom/translation NCC against the A-roll reference f720, both dense and per block.
- Sound: ebur128 on the whole mix and on concatenated pause-only and speech-only audio; a band-power ducking test; a side-channel onset scan; spectrograms of the event windows.

---

## A. Screencast annotations

### Inventory (whole-video scan) — high
| what | where | count |
|---|---|---|
| **yellow marker highlight** over prompt text | 06:01.4–06:03.4 (H1–H4, inside the user prompt bubble), 06:23.6 (H5), 06:34.6–06:35.2 (H6, H7) | 7 wipes |
| **orange label box** over "Seedance 2.5," | f7985 (04:26.4) → gone f8059 | 1 |
| arrows / spotlights / blur / dim / circles / click ripples | — | **none in the whole video** |
| "highlight box on MCP options" 04:00.5 (Gemini) | This is the native Artlist "Connect MCP" card, not an annotation. The edit there is an **8-frame cross-dissolve** (f7205–7212) plus a screen zoom. | 0 |

### A1. Marker wipe — MOTION (design-free)
- **Type: left→right wipe.** The box's left edge is fixed and its right edge sweeps across the phrase. The fill is at full strength right behind the edge (hard leading edge, ≤2 px soft). There is no fade-in, no scale and no vertical motion. This is the same motion for yellow and orange.
- **Shared curve** on progress p = (right − left)/width, in stabilised coordinates: **cubic-bezier(0.264, 0.139, 0.361, 0.897)**. Joint rms is 0.009 across all 7 yellow wipes (max residual 0.05). The orange wipe fits the same curve at rms 0.006. — high
- **Start**: the curve's t0 is **1.4–2.5 f before the first visible frame**, so the first visible frame already shows 4–14 % of the width.
- **Duration grows with width, then saturates**: `T = clamp(13.3 + 0.071·w_px, 18, 35)` frames at 1080p, which is ≈ `13.3 + 1.6·w_em` with the highlighted font ≈ 22.5 px. — med

| id | phrase | w px | first visible f | T (shared curve) | t0 rel. first visible |
|---|---|---|---|---|---|
| H1 | phone footage | 158 | 10834 | 26.0 | −2.5 |
| H2 | slight handheld | 163 | 10847 | 24.9 | −1.9 |
| H3 | shake. (line 2 of the same phrase) | 66 | 10863 | 18.8 | −1.9 |
| H4 | small physical imperfections | 295 | 10876 | 34.3 | −2.2 |
| H5 | timestamp on every beat … ten. (full line) | 682 | 11495 | 27.1 *(outlier)* | +0.5 |
| H6 | Put the | 84 | 11829 | 18.5 | −2.6 |
| H7 | spoken line in quotation marks … (full line) | 690 | 11846 | 35.2 | −0.9 |
| orange | Seedance 2.5, | 186 | 7985 | 26.4 | −2.0 |

Per-frame example, H4 (progress per frame from first visible): 0:.047 1:.075 2:.115 3:.156 4:.197 5:.251 6:.305 7:.359 8:.407 9:.461 10:.508 11:.556 12:.603 13:.644 14:.678 15:.712 16:.753 17:.773 18:.800 19:.834 20:.847 21:.875 22:.888 23:.902 24:.915 25:.929 26:.942 27:.956 28:.969 29:.976 30:.983 32:.990 33:.997. Every wipe has a full table in the JSON.

- **Multi-line**: each line segment is its **own wipe**, and a phrase that wraps becomes two highlights (H2 on line 1, then H3 on line 2). The next wipe starts when the previous one is about 60–80 % done. Gaps between curve t0s: H1→H2 +13.6 f, H2→H3 +16.0 f, H3→H4 +12.7 f, H6→H7 +18.7 f. Earlier highlights stay on, so up to 4 can be visible at once. — high
- **Coupling to the screen camera**: every wipe runs while, or just after, a screen-camera move toward the text. Wipe t0 minus move t0: H1 +26 f, H5 +3 f, H6 +5 f, orange +20 f, so **median ≈ +12 f**. — med
- **Exit = opacity fade** of the fill and the text tint together. It **starts on the frame the camera starts its next move**: H5's fade starts at f11821 and the pan's t0 is 11821.2; H1–H4 start at f11497 against a zoom start of 11495; H6/H7 start at f12301 against a zoom-out start of 12302. — high
  - Alpha per frame from the fade start (H5, measured on fill pixels): 0:.99 1:.92 2:.88 3:.80 4:.66 5:.59 6:.46 7:.39 8:.32 9:.24 10:.22 11:.14 12:.12 13:.07 14:.06 15:.03 16:.02 17:.01 18+: 0.
  - Fit: t0 −2.1 f, T 19.5 f, cubic-bezier(0.358, −0.04, 0.287, 0.854). Half point is at 6.5 f, and it is under 5 % after 15 f.
- **Orange exit**: the box holds about 33 f, rides the screen zoom-out that starts at f8043, then **vanishes over 2–3 frames (f8057–8059) in the middle of the zoom**, not on a cut. — high

### A2. Annotation STYLE (keep separate; swap freely)
| | yellow marker | orange label |
|---|---|---|
| result colour | fill reads #99831C over the bubble blue #113166. Glyphs underneath turn **#F7F26C**, so the layer sits OVER the text and tints it. The blend is unresolved (low). The closest model is a hard-light of ≈#C8B323; in practice, a #FFE600 rect at ~55 % with mix-blend hard-light. | **#FA9D00 opaque**, with the white text left untouched on top |
| corners | square (≤2 px) | square |
| box vs text | height = ascender-top −2 px to descender bottom: 26 px for a 35 px line pitch (0.74 × pitch, ≈1.15 em). Horizontal pad 2–4 px (≈0.13 em) past the ink. Trailing space excluded. 8–9 px gap between the boxes of adjacent lines. | 186×33 for "Seedance 2.5,". Pads: left 8 px, right 14 px (to the comma), top 6 px above cap top, bottom 3 px below the descender (≈0.35 em) |
| conf | geometry high, colour low | high |

Proofs: `proof/hl_H1H2_wipe.jpg`, `hl_H3H4_wipe.jpg`, `hl_H7_wipe.jpg`, `hl_fadeout_H5_and_H6_wipe.jpg`, `orange_zoom_and_wipe.jpg`, `orange_exit_zoomout.jpg`, `../hlzoom.png` (4× crop of the box edges).

---

## B. B-roll layouts

### B1. Three phone panels on mint (cut in f217 = 00:07.24, cut out f367) — high
- **Source rate**: the sequence is **23.976 fps content** in the 29.97 timeline, so every 5th frame repeats (228, 233, 238, …). Curves are given in source frames (src) and converted.
- The background is static for 5 frames, then the panels **rise from fully below the frame**, staggered **left → middle → right**.
- **Joint recipe** (one curve for all three; rms **1.9 px** on the top edge; per-panel fits 1.2–1.7 px):
  - translateY on the top edge: **cubic-bezier(0.35, 0.252, 0.29, 0.905)**
  - duration **26.3 src f = 1.097 s = 32.9 output frames**
  - travel **1102 px = 1.18 × the panel height** (935). At start the panel top sits at y≈1190, about 110 px below the frame.
  - stagger **6.0 src f = 0.25 s = 7.5 output frames** between panels
  - starts (output frames): **220.8, 228.3, 235.9**. The first panel starts **0.126 s after the cut**.
  - opaque from its first visible pixel, no rotation, no fade. The width grows ~5 % during the rise, which may be a small 0.95→1 scale or the start of the group push-in (low).
- **After landing**: the whole group slowly **scales about the frame centre at +0.067 %/frame (~2 %/s, linear)**, the same rate as the A-roll push-in (C2).
- **Exit**: hard cut back to A-roll. No exit animation.
- Top-edge tables per panel (y per output frame, duplicates dropped) are in the JSON. Panel 1 example: 226:1007 227:868 229:702 230:621 231:547 232:482 234:423 235:372 236:328 237:289 239:254 240:224 241:199 242:177 244:158 245:141 246:127 247:116 249:106 250:98 251:92 252:88 254:85 255:83 257:82.
- Layout STYLE (med): 3 equal cards ≈498×935 (aspect 0.53), tops at y≈82–88 (8 % H), gaps ≈114–118 px, side margins ≈95–100 px, corner radius ≈30 px, soft drop shadow down-right (falls to background level ~60 px out).
- Proof: `proof/broll_3panel_rise.jpg`.

### B2. "Split-screen dual frame" 00:15 — NOT a layout (high)
This is a single full-bleed AI clip of two people side by side. It enters with an **8-frame linear cross-dissolve** from A-roll; mix per frame from f451: .05 .18 .30 .42 .56 .68 .81 .94 1.0. It leaves by hard cut at f608. Proof: `proof/dissolve_aroll_to_coffee.jpg`.

### B3. "5-panel layouts" 01:12, 08:32, 10:23 — NOT editor layouts (high)
These are the Artlist web UI's own 5-thumbnail grid inside the screencast. The panels have no animation of their own. At 01:12 the movement is a **screen-camera zoom-in on the cut**: ×1.29 over f2150–2182, cubic-bezier(0.386, −0.10, 0.195, 1.063), T 40 f. Proof: `proof/screen_zoom_5panel.jpg`. Full screen-camera recipes belong to the sibling spec `kwys-screencast.md`; my own fits of 7 moves are in the JSON under `C_camera.screen_moves_seen_here`.

---

## C. Camera

### C1. Opening zoom-out (f0–34) — high
The video **opens punched in ×1.548 and eases out to the normal A-roll framing** about the frame centre (translation 0).
- Scale per frame, relative to the settled framing: 0:1.548 1:1.548 2:1.537 3:1.501 4:1.411 5:1.330 6:1.276 7:1.240 8:1.214 9:1.193 10:1.171 11:1.154 12:1.137 13:1.122 14:1.111 15:1.101 16:1.090 17:1.079 18:1.075 19:1.064 20:1.058 21:1.051 22:1.047 23:1.041 24:1.034 25:1.028 26–28:1.024 29:1.013 31:1.009 32:1.004 34+:1.000
- Fit on log-scale progress: t0 2.6 f, **T 31.3 f (1.04 s), cubic-bezier(0.089, 0.443, 0.126, 0.834)** (strong ease-out), rms 0.005.
- A slight vignette/brightness change rides along: f0–7 are brighter.
- The title "UGC AI videos" rises in over f3–10 at the same time; that animation belongs to the text family.

**"Punch-in at 00:02.5" (Gemini): not found.** There is no cut and no zoom step anywhere in f34–216, and the scale stays exactly 1.000 over f34–86. The slow push-in (C2) starts at about f86 (2.9 s).

### C2. A-roll slow push-in ("Ken Burns") — med-high
- **Every A-roll block** (after a screencast or B-roll) **starts at scale 1.000** of the base framing and **pushes in linearly at ≈0.06 %/frame (1.8 %/s)**. Across 15 blocks the rate is 1.5–2.1 %/s, about the frame centre (dx, dy ≈ 0).
- The push is **continuous across jump cuts** inside a block: the zoom ratio across 9 of 11 A→A jump cuts is 1.000 ± 0.004.
- It **caps at ≈1.124 and holds** in the long blocks (57.4 s, 637–699 s).
- Exceptions: the opening block runs at 2.5 %/s from f86. The block at 57.4 s hit the cap in 2.8 s, then pushed again 1.124→1.181 during the Subscribe CTA (f1968–2049).
- **No digital punch-ins at jump cuts**: framing is identical and only the head moves. Two cuts read ×1.07–1.08, but at a low match score (low).
- Per-block start and end scales: `work/kwys-annot/azoom.txt`. Dense tracks: `zt_*.txt`, `z_open.txt`.

### C3. Transitions — high
- **Hard cut by default.**
- **Two editorial cross-dissolves**, both **8 frames (0.27 s), linear**: A-roll → B-roll at f450.6–458.5, and screencast → screencast at f7204.8–7212.2 (04:00.4). Gemini's "100 % hard cuts" is wrong.
- The other dissolve-detector hits (f3908, f5690) are native UI animations (a Windows window opening, a browser popup).

### C4. End fade to black — high
- Last full frame **f20921 (11:38.06)**, black from **f20951**: **30 frames = 1.0 s**, near-linear.
- Opacity per frame from 20921: 1:.97 2:.93 3:.90 4:.86 5:.82 6:.80 7:.76 8:.72 9:.69 10:.66 11:.62 12:.59 13:.55 14:.52 15:.49 16:.45 17:.42 18:.39 19:.35 20:.32 21:.28 22:.22 23:.17 24:.13 25:.09 26:.06 27:.03 28:.02 29:.01 30:0. The last ~8 f fall slightly faster.
- 3 black frames end the file.
- **The audio is NOT faded**: the bed runs at about −40 dBFS to the last sample.
- It starts at 11:38.1, not 11:32 (Gemini).
- Proof: `proof/end_fade_black.jpg`.

### C5. Shot-length statistics (whole video)
| class | blocks | share of runtime | median | mean | p25–p75 | min–max |
|---|---|---|---|---|---|---|
| A-roll (presenter) | 20 | 23.7 % (165.6 s) | 6.71 s | 8.28 s | 3.35–7.65 | 1.8–40.9 |
| Screencast + bubble | 17 | 74.9 % (523.5 s) | 18.6 s | 30.8 s | 17.8–46.9 | 3.2–77.2 |
| Full-screen AI B-roll | 2 | 1.4 % | 5.06 s | — | — | 5.0–5.1 |

- A-roll shots including jump cuts: 31, median **4.4 s**, mean 5.3 s. Some jump cuts may be missed.
- Screencast shots split at hard cuts: 76, median 3.6 s. This count is noisy because page changes inside the recording count as cuts (p25 0.63 s).
- The sequence alternates A/S strictly after 0:27 (the block list is in the JSON).
- Proofs: `sec_0.jpg`, `sec_1.jpg`, `sec_2.jpg` (1-fps contact sheets).

---

## D. Sound

### D1. Mix — med-high
| | value |
|---|---|
| integrated | **−18.6 LUFS**, LRA 3.4 LU, true peak −0.1 dBTP |
| speech-only (concatenated) | −16.0 LUFS |
| pauses-only (≥0.4 s gaps, 61 s total) | **−38.9 LUFS** → **bed ≈ 23 LU under the voice** |
| 50 ms RMS | speech median −21.2 dBFS, pause median −40.3 (IQR −44.7…−38.4) |
| bed character | energy mostly below 250 Hz (kick/bass striations in the spectrogram), with a stereo side component in pauses (−18 dB side/mid vs −33 dB overall) |
| ducking | **none**: sub-60 Hz band power is the same under speech and in pauses (22.3 vs 21.4 dB) |

### D2. SFX at visual events — no SFX layer found
| event | t (s) | finding | conf |
|---|---|---|---|
| B-roll cut f217 and panel rises | 7.24–7.87 | The cut sits in a 0.42 s speech pause containing only the LF bed. **No whoosh** or other noise burst. | med-high |
| highlight H2 start | 361.86 | It starts in a pause, which is silent apart from the bed. | med |
| other highlights, orange box, screen zooms, dissolves | — | Nothing locked to them; side-channel onsets fall within ±150 ms of 0/20 events (chance rate). | med |
| Subscribe appear 65.97 / click 68.37, Instagram icon 661.49 | — | Overlapped by speech. The HF bursts there look like sibilants. **Unresolved**. | low |

- Gemini's "bass whoosh 00:02.5" and "whoosh 00:06.6" are not present.
- Unlike reference 1 (pop ≈ +60 ms on entrances), **this video's graphics are silent** wherever that can be checked.

Proofs: `spec_broll.png`, `spec_highlights.png`, `spec_subscribe.png`, `spec_insta.png`.

---

## Recipes (design-free, ready for keyframes.json)

1. **marker_wipe(box, k)**: right edge = box.left + box.w·bezier(0.264, 0.139, 0.361, 0.897)((f − k + 2)/T), with T = clamp(13.3 + 1.6·w_em, 18, 35) frames @29.97. k = first visible frame.
   - Wrapped phrases become one wipe per line; start the next segment at ~70 % of the previous one (≈ +13–19 f).
   - Start the first wipe ≈12 f after the camera begins moving toward the phrase.
   - Exit with an alpha fade of T = 19.5 f, bezier(0.358, −0.04, 0.287, 0.854). It starts when the camera starts its next move (or the section ends).
   - Style: yellow tint over the text, or an opaque orange label.
2. **broll_rise_stagger(panels, k)**: each panel's translateY goes from +1.18·H (fully off-screen) to 0 over 1.097 s with bezier(0.35, 0.252, 0.29, 0.905).
   - Panel i starts at k + 0.126 s + i·0.25 s, left → right.
   - After landing, the group scales +2 %/s linearly. Hard-cut exit.
3. **open_zoom_out**: the first A-roll shot of the video starts at scale 1.548 and reaches 1.0 over 31 f with bezier(0.089, 0.443, 0.126, 0.834) on log-scale, about the centre.
4. **aroll_push_in**: per A-roll block, scale = 1 + 0.0006·(f − block_start), capped at 1.124 and then held. It does not reset at jump cuts and does reset after any screencast or B-roll.
5. **dissolve8**: an 8-frame linear cross-fade, used sparingly (2 in 11:39: A-roll → B-roll, and screencast → screencast).
6. **end_fade**: a 30-frame near-linear fade to black on the video only, with 3 black frames held after it. The music is not faded.
7. **sound**: bed ≈ −23 LU under the voice, no ducking, mix ≈ −18.6 LUFS. Graphics carry no SFX.

## Gaps / open items
- Yellow blend mode/colour is unresolved: the text tint means it is not plain normal-alpha. Motion is unaffected.
- The duration rule has one outlier (H5).
- Wipe timing vs the spoken words was not checked (no word timings for this reference). The orange and H1–H4 wipes appear to follow speech; a transcript would settle it.
- The panel scale-in during the rise (~5 % width growth) is not separated from the shadow in the mask (low).
- SFX under speech (Subscribe click/bell, social icons) is unresolved without a stem.
- Five-panel and split-screen sections contain no edited layout, so there is nothing to replicate beyond the screen zoom (sibling spec) and the dissolve.
