# Screencast camera + facecam bubble — kwysV2smgfY (29.97 fps, 1920x1080)

Reference 2 = Jake Dawson's own tutorial. Measured frame by frame. Machine-readable twin: `kwys-screencast.json`.
Proof images: `/opt/aieditor-work/reference/specs/kwys-screencast-proof/`. Work dir: `/opt/aieditor-work/reference/work/kwys-screencast/`.

**Frames** = absolute 0-based indices of the reference at 30000/1001 fps, checked against a full decode-from-start (`gray320.npy`). Note: `ffmpeg -ss` on this VP9 file lands ±1 frame unpredictably. `bin/rawx.sh` + `util.exact()` re-align every extract against the full decode.
**Confidence**: high = directly measured and repeatable. med = measured, with a known confound. low = inferred.

## Method

1. One full pass at 640x360 gave a per-frame grey thumbnail plus ring statistics in the bubble annulus. Shot cuts and bubble on/off came from this pass.
2. A pairwise similarity fit between consecutive frames (scale + translation, torch, coarse to fine) ran on every moving screencast frame (6,569 frames). Runs of zoom gave about 40 candidate moves.
3. A precise fit ran per move at 960x540. Each frame was fitted directly against the most-zoomed frame of the move (25k sample points, bubble masked), which gives per-frame zoom and the view rect.
4. A cubic-bezier was fitted (Nelder-Mead) to the log-zoom progress, with t0 and D free, then refitted with ONE shared curve to test the recipe.

## 1. Facecam bubble

| property | value | conf |
|---|---|---|
| shape / layer | circle, **screen-space overlay**. It never zooms or pans with the screencast. | high |
| centre | **(1701.9, 253.7) px** = (0.8864 W, 0.2349 H). Least-squares circle fit, ±0.3 px. | high |
| outer diameter | **358.6 px** (outer half-intensity edge r 179.3), about 18.7 % of frame width | high |
| inner video disc | r **172.3** (diameter 344.6) | high |
| ring | **7.0 px** wide, solid between r 173.5 and 177.5, AA edges about 1.5 px | high |
| ring colour | **linear horizontal gradient** across the ring: left **#000357** → mid #200D90 → right **#4117C9**. Fit is colour = c0 + c1·u with u = (x−cx)/r. c0 = (32.4, 13.2, 143.7) and c1 = (31.8, 10.2, 57.2). The vertical term is 0 and rms is ≤7. The fit is identical on f839, f2200 and f3100. | high |
| shadow | soft dark outer shadow, no offset, no coloured glow. Darkening is 11 % at +1.5 px, 6 % at +7.5 px and about 0 by +14 px (≈ `0 0 14px rgba(0,0,0,.3)`). | low-med |
| presenter feed | **Same camera/set as the A-roll** (brick wall, SM7B), a different moment of the same recording. Scale is about **0.47×** the A-roll wide framing (eye distance 58 px vs 124 px). Crop is ≈ a 715 px square of the A-roll around the face (x 582–1298, y 32–748). Eyes sit about 29 px above the disc centre, and the mic top shows at the bottom. | med |
| consistency | identical in all 25 screencast spans (ring-pixel fraction 0.58 ± 0.02 everywhere) | high |

Proofs: `bubble_geometry_f2200.png` (green = inner 172.3, red = outer 179.3, yellow = shadow extent 194) and `bubble_presenter_crop_vs_aroll.png`.

### Visibility rule
- The bubble is **on every screencast frame and never on A-roll**. It enters and exits by a **hard cut on the same frame** as the A-roll↔screencast cut (21 cut-ins and 21 cut-outs, 0-frame). Example: f815, where f814 is A-roll and f815 has the full bubble (`bubble_cut_in_f812-826.jpg`). There is no pop or scale-in.
- Gemini's claims that the bubble is hidden at 00:36–00:46 and 05:06–05:58 are **wrong**: the ring is present on every frame there.
- It is hidden only twice: **f5577–5770** (6.4 s) and **f7345–7401** (1.9 s). Both times the action target sits in the bubble's top-right zone:
  - the Artlist "Sign in" flow at the top-right header (`bubble_hidden_signin_f5650.png`);
  - the zoom onto "Get More Credits / Upgrade to Max" (`bubble_hidden_target_topright_f7370.png`).
- **Inferred rule:** fade the bubble out while the current zoom/click target overlaps the bubble zone (x > ~1480, y < ~470 in output px), and bring it back when the target leaves. Confidence medium (2 events).
- **Fade = opacity only.** Centre and radius stay constant while fading.

| fade | offset 0 | per-frame opacity |
|---|---|---|
| out A | f5572 | .84 .65 .50 .28 .15 0 (**6 f**, ~linear) |
| out B | f7337 | .94 .72 .69 .55 .40 .30 .21 .15 ~0 (**8 f**, noisy: background moving) |
| in A | f5770 | .05 .13 .22 .31 .46 .52 .61 .69 .75 .84 .91 .98 (**11 f**, ~linear) |
| in B | f7401 | .07 .17 .26 .34 .39 .48 .61 .67 .72 .84 .92 .99 (**11 f**) |

These fades coincide with a screen crossfade or zoom (`bubble_fadeout_f5567-5582.jpg`, `bubble_fadein_f5772-5787.jpg`, `..._f7333-7344.jpg`, `..._f7403-7418.jpg`). Opacity was solved per frame from ring colour vs the local background (±0.05).

## 2. Screencast camera (zoom / pan)

**Frame:** the screencast is **full-bleed 1920x1080**: no inset, margin, rounded corners or background. The recording is already UI-magnified (large browser scale, no taskbar).

**Gemini's "zoom cuts" are animated zooms.** Every measured move is a smooth animated virtual-camera move.

### Motion model (high confidence)
- `zoom(t) = z0 · (z1/z0)^B((t − t0)/D)`. The **bezier is applied to log-zoom**, which fits better than linear width on 13 of 17 clean events.
- The **view rect corners progress linearly with view width**, i.e. a rect lerp with a constant fixed point. The deviation is 0.000–0.006 on clean events.
- **Zoom-in curve: `cubic-bezier(0.31, 0.10, 0.22, 1.0)`.** The per-event free fits cluster tightly, e.g. (.306,.108,.205,1.02), (.313,.078,.231,1), (.31,.103,.233,1), (.313,.101,.235,1), (.309,.135,.221,1), (.314,.098,.214,.999). With this one shared curve the rms progress error is **0.001–0.004** on 15/17 events.
- Zoom-in duration: **D median 43 f** (IQR 38–49, range 34–67). The 10–90 % rise takes about 20 f, and 50 % is reached at 0.31·D.
- **Zoom-out curve: `cubic-bezier(0.345, 0.0, 0.33, 0.91)`**, a near-symmetric ease-in-out. D median **50 f** (37–62). It **always lands exactly on 1.000** (5/5 clean outs).
- Per-frame canonical curves are in the JSON (`per_frame_curve_D43`, `per_frame_curve_D50`). Every instance's per-frame zoom table is under `zoom.instances`.

### Instances (clean, quality high)

| id | t0 frame | time | zoom | D (f) | end view [x0,y0,x1,y1] | note |
|---|---|---|---|---|---|---|
| in815 | 816.5 | 0:27.2 | 1.00→1.41 | 47.8 | [499,189,1859,954] | span start; target = model dropdown, lands at 0.56/0.50 |
| in2149 | 2150.2 | 1:11.7 | 1.00→1.29 | 33.9 | [20,77,1507,914] | span start, left-clamped |
| in4535 | 4536.3 | 2:31.3 | 1.00→1.35 | 40.4 | [12,278,1431,1076] | span start, left+bottom clamp |
| in5116 | 5119.3 | 2:50.8 | 1.00→1.40 | 39.8 | [1,307,1372,1078] | left+bottom clamp |
| in7535 | 7536.3 | 4:11.5 | 1.00→1.43 | 36.4 | [304,139,1646,893] | span start; prompt bar centred |
| in7947 | 7951.3 | 4:25.3 | 1.00→**2.03** | 58.5 | [353,269,1298,801] | max zoom (model table row) |
| out8039 | 8042.3 | 4:28.3 | 2.03→1.00 | 61.6 | full | after a 32 f hold |
| in8298 | 8300.9 | 4:37.0 | 1.00→1.59 | 66.5 | [358,397,1562,1074] | bottom clamp |
| in9305 | 9310.6 | 5:10.7 | 1.00→1.44 | 55.0 | [294,325,1626,1074] | bottom clamp (prompt) |
| out10100 | 10101.5 | 5:37.0 | 1.44→1.00 | 51.5 | full | |
| in10807 | 10810.6 | 6:00.7 | 1.00→1.47 | 48.4 | [419,114,1727,849] | prompt text |
| in12617 | 12618.1 | 7:01.0 | 1.00→1.28 | 37.0 | [210,118,1709,961] | span start, dead centre |
| out12298 | 12297.6 | 6:50.3 | 1.66→1.00 | 61.5 | full | |
| in13761 | 13762.3 | 7:39.2 | 1.00→1.35 | 39.7 | [249,279,1670,1078] | span start, bottom clamp |
| out14071 | 14069.9 | 7:49.5 | 1.35→1.00 | 38.0 | full | hold was 266 f |
| in14467 | 14472.3 | 8:02.9 | 1.00→1.36 | 42.9 | [255,282,1665,1076] | bottom clamp |
| in15005 | 15009.4 | 8:20.8 | 1.00→1.38 | 43.9 | [8,147,1404,933] | left clamp |
| in15671 | 15674.4 | 8:43.0 | 1.00→1.32 | 38.4 | [424,131,1879,949] | |
| in16782 | 16783.2 | 9:20.0 | 1.00→1.31 | 35.6 | [-2,248,1469,1075] | span start, left+bottom |
| in17261 | 17263.0 | 9:36.0 | 1.00→1.21 | 57.5 | — | |
| out17507 | 17508.4 | 9:44.2 | 1.58→1.00 | 48.9 | full | |
| in18258 | 18264.6 | 10:09.4 | 1.00→1.48 | 50.2 | [313,50,1607,778] | |
| out3939 | 3939.4 | 2:11.4 | 1.13→1.00 | 37.2 | full | medium |

Medium-quality and partial moves:
- re-targets while already zoomed: in4162 (1.13×) and in4610 (1.35→1.53 with pan; the 1.13× is relative to the already-zoomed frame);
- out7680 (2.12→1.54, then a cut).

Discarded as page changes or jump cuts, not zooms: chain "events" at 6743, 12810, 15126 and 1294.

### Proofs: model vs actual
- **What each proof image shows:**
  - Top row: the actual frame.
  - Middle row: the start frame warped by the recipe curve and rect lerp, with the bubble pasted back as a screen-space overlay.
  - Bottom row: |diff|×3. Blue marks the masked bubble area.
  - Remaining diff = UI content changes only (dropdown opening, cursor). Edges of static text cancel.
- **Model zoom vs measured zoom:** within ±0.002 on every sampled frame.
  - `zoom_in815_actual-model-diff.png` + `_curve.png` (dots = measured, red = bezier)
  - `zoom_in7947_*` (2.03×)
  - `zoom_out8039_*`
  - `zoom_in5116_*` (clamped corner zoom, mean abs diff 0.2–1.4 grey levels)

### Recipe (design-free, apply to any recording given event targets)
1. **Span entry:** at the first frame of every screencast span, start a push-in at t0 = +1…2 f to **≈1.36×** (range 1.28–1.48) over **40 f** with `cubic-bezier(.31,.10,.22,1)` on log-zoom. Target = the first action region (click, typing box or read region).
2. **View placement:** take the rect of size W/z × H/z centred on the target, then **clamp it inside the source frame**. 10 of 17 measured moves end clamped to an edge: bottom for prompt bars, left for left-side UI. Unclamped targets land within about 6 % of frame centre.
3. **Interpolation:** lerp the view rect corners with width progress (constant fixed point) while the zoom follows the bezier on log scale.
4. **Hold:** the view is pixel-static: zoom constant ±0.001, **no drift and no cursor follow** (e.g. f866–988 is static while the cursor works).
5. **Re-target:** for a new target, either jump-cut (most common) or do a zoom/pan move from the current view with the same curve and D ≈ 36–44 f.
6. **Deep punch:** for a small detail (a table row), zoom up to about **2.0×** with D ≈ 58 f. Hold ≥ 1 s, then zoom out.
7. **Zoom out:** return to exactly 1.0 with `cubic-bezier(.345,0,.33,.91)` and D ≈ 50 f (37–62). Often there is no zoom-out at all: the zoomed state simply ends at the hard cut to A-roll.
8. **D vs magnitude:** use ~40 f up to 1.4×, 50–58 f at 1.45–2.0×, and ~65 f for large moves with travel (low confidence, r ≈ 0.6).
9. **Cadence:** about one camera move per 13–17 s of screencast (≈36 measured moves in ~514 s). Holds last 1–30 s, and in-span jump cuts carry the zoom state. Gemini's "framing changes every 5–8 s" counts jump cuts, not camera moves.
10. **Page changes inside a span:** usually a hard cut. Occasionally a **6–10 f crossfade** while the outgoing view zooms out (f999–1009, f7205–7211; `screen_transition_*`).
11. **Facecam:** at (1702, 254) with outer Ø 359 and a 7 px ring gradient #000357→#4117C9 (horizontal), on top of everything.
    - It cuts in and out with the screencast.
    - If the target rect intersects x > 1480 ∧ y < 470, fade it out over 6 f (linear), and fade it back in over 11 f (linear) after the target leaves.

## 3. Scroll
- **No edited (synthetic) scroll or pan exists.**
- Native mouse-wheel scrolls are in the recording: about **200 px per flick over 9–16 f**, with peaks of 34–82 px/frame (f1041–1049, f1065–1080, f1334–1343).
- Pans at constant zoom only happen as part of a re-target (f2928–2950 (−160,−56), f3960–3982 (+167,+15), f4190–4208, f4644–4659).
- Gemini's "slow scroll down" at 09:04 and 09:19–10:00 is not confirmed: those spans are static between jump cuts.

## 4. Cursor
- **Native cursor** captured in the recording: a white arrow, which becomes the Windows hand over links. It scales with the zoom because it is part of the frame. Size at 1.0× is about 12–14 × 18–19 px.
- No smoothing or synthetic cursor is detectable: natural hand motion with small idle drift (`cursor_native_f7632-7685.jpg`).
- **No click indication**: no ring, ripple or highlight, only the native pointer→hand change.
- **Typing:** in the measured instance (4:12) the prompt text appears at once between f7602 and f7608. That means a paste or a jump cut; there is no visible character-by-character typing.
- Confidence: medium.

## Not measured / caveats
- Zoom targets were inferred from end views plus vision, not from logged click coordinates.
- The relation between D and zoom magnitude is weak.
- The bubble shadow is only visible on bright backgrounds (2 frames).
- The presenter crop inside the bubble is an eye-distance estimate (±10 %), not a fitted warp.
- Opacity of fade-out B is noisy (the background moves).
- SFX are not analysed.
- The A-roll also shows a very slow digital push (~1.3 % over 25 f before f815). That belongs to the camera family, not here.
