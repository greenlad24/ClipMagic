# Screencast camera + transitions — refs 2–5 (measured 2026-10-07)

Same editor, four of Jake's tutorials: **2** kwysV2smgfY, **3** 3Jq-L6uLd28, **4** Geg9TyNoi3w, **5** AZxFgIVgHjg (1080p, 29.97 fps). One pipeline for all four (`/opt/aieditor-work/reference/work/sc5/bin`):

1. `pass1.py` — one container (aieditor-screencast image): cv2 decodes, per-frame ECC affine between consecutive 320×180 grey frames (facecam masked), 160×90 thumbnails; no raw video ever crosses docker stdout.
2. `analyze.py` — screencast spans (facecam ring present), transitions (runs of change not explained by a camera transform; DISSOLVE = ≥ 50 % of cells change, ≥ 3 f, monotonic spatially uniform blend weight), camera moves (runs of zoom/translation, free cubic-bezier + t0 + D fit on the progress).
3. Contact sheets of every class, checked by eye (`*/sheets2`, `sheets_pans`, `sheets_dis`). Scroll flicks (≤ 8 f) and in-app animations (modal fades, video playback) were excluded after this check.

Gemini 2-fps decodes were tried and dropped: it reported 'no zooms' on chunks where the frames show five (ref 3 5:00–7:30).

## Per-reference numbers

| metric | ref 2 kwysV2smgfY | ref 3 3Jq-L6uLd28 | ref 4 Geg9TyNoi3w | ref 5 AZxFgIVgHjg |
|---|---|---|---|---|
| screencast minutes | 8.58 | 9.23 | 9.46 | 11.32 |
| camera moves / min (≥15 f) | 5.48 | 6.61 | 4.65 | 5.74 |
| zoom-ins / min | 2.8 | 2.6 | 3.07 | 2.39 |
| pans / min | 0.82 | 2.49 | 0.63 | 1.33 |
| zoom-outs / min | 1.87 | 1.19 | 0.95 | 1.77 |
| zoom-in ratio p25/50/75 | [1.282, 1.349, 1.423] | [1.238, 1.266, 1.316] | [1.236, 1.275, 1.304] | [1.195, 1.248, 1.301] |
| zoom-in D (f) p25/50/75 | [35.45, 42.6, 50.125] | [33.175, 35.75, 39.0] | [30.9, 36.3, 44.3] | [31.75, 38.5, 44.35] |
| zoom-in curve (median free fit) | [0.319, 0.103, 0.236, 0.996] | [0.326, 0.061, 0.229, 0.998] | [0.327, 0.061, 0.267, 0.92] | [0.313, 0.051, 0.274, 1.0] |
| centred pushes share | 0.12 | 0.12 | 0.24 | 0.41 |
| zoom level before a zoom-out | [1.14, 1.251, 1.45] | [1.222, 1.264, 1.326] | [1.111, 1.163, 1.221] | [1.227, 1.285, 1.357] |
| zoom-out D (f) | [26.625, 34.05, 46.175] | [36.2, 40.3, 42.55] | [23.0, 26.3, 40.1] | [29.825, 38.65, 45.3] |
| zoom-out curve | [0.324, 0.002, 0.326, 0.903] | [0.33, 0.0, 0.298, 0.974] | [0.289, 0.131, 0.402, 0.888] | [0.333, 0.004, 0.325, 0.919] |
| pan distance px@1080p | [173.0, 374.0, 468.0] | [254.5, 350.0, 505.5] | [161.5, 267.5, 437.25] | [123.5, 171.0, 212.5] |
| pan D (f) | [32.1, 36.1, 38.95] | [34.35, 37.8, 41.0] | [26.475, 32.4, 42.525] | [30.85, 33.8, 41.95] |
| pan peak px/s | [381.0, 651.0, 796.0] | [512.5, 624.0, 899.5] | [433.75, 703.5, 840.5] | [252.5, 306.0, 373.0] |
| pan curve | [0.331, 0.031, 0.275, 0.96] | [0.329, 0.007, 0.262, 1.0] | [0.355, -0.053, 0.298, 0.943] | [0.328, 0.032, 0.26, 0.929] |
| pan directions | {'vertical': 2, 'horizontal': 2, 'diagonal': 3} | {'vertical': 8, 'horizontal': 7, 'diagonal': 8} | {'vertical': 1, 'horizontal': 1, 'diagonal': 4} | {'vertical': 13, 'horizontal': 0, 'diagonal': 2} |
| pan D vs distance [slope, intercept] | [0.0234, 29.4072] | [0.0212, 30.6804] | [0.0409, 22.0419] | [0.0771, 22.612] |
| gap between moves (s) | [5.289, 10.811, 17.192] | [3.729, 8.075, 16.75] | [6.874, 14.681, 20.921] | [4.838, 10.527, 18.969] |
| full-frame dissolves (frames p25/50/75) | [3.0, 3.0, 4.5] | [3.5, 4.0, 4.5] | [4.0, 5.0, 6.0] | [3.5, 4.0, 4.0] |
| dissolve weight per frame | [0.198, 0.256, 0.329] | [0.072, 0.116, 0.161] | [0.166, 0.189, 0.242] | [0.247, 0.273, 0.322] |

Dissolve counts here use the strict uniform-weight test (median weight std < 0.12). The looser verified count (weight std < 0.22, ≥ 50 % of cells) is: ref 2 7 dissolves vs 7 full-screen hard cuts, ref 3 6 vs 4, ref 4 13 vs 4, ref 5 4 vs 10.

## Verified examples (timestamps)

### zoom_targets
- ref3 0:13.6 span-opening push-in x1.27 D34 onto the generated video (centre-right)
- ref3 1:11.7 x1.64 D45 onto the YouTube channel header + Subscribe button (small CTA = the deep case)
- ref3 1:30.1 x1.26 D39 onto the left AI-tools panel, clamped to the left/top edges
- ref3 1:40.3 x1.39 D34 onto the prompt box, clamped to the bottom edge
- ref3 2:04.9 x1.37 D38 onto the landing hero (headline + prompt box)
- ref3 3:44.1 x1.43 D51 onto the dashboard's Recent Videos row
- ref4 0:26.8 x1.35 D35 onto the skill page text block he reads
- ref4 0:10.3 x1.19 D35 onto the new file icon on the desktop (right after a dissolve)
- ref4 1:54.1 / ref5 many: centred slow push x1.2-1.3 (no target) on a dark list / chat column: 12-41 % of zoom-ins are centred

### no_zoom
- ref3 0:59.6 image gallery scrolled at 1.0 (flicks ~95 px / 6 f)
- ref3 1:26.5 YouTube channel page scrolled at 1.0
- ref3 5:00-5:56 editor overview shots held at 1.0 while he talks about the whole tool

### dissolves
- ref3 0:39.7 6 f linear (w .16/.32/.48/.65/.82): zoomed result (coffee video) -> another project's editor; incoming arrives zoomed, then a pan (0:39.9)
- ref3 0:43.2 6 f: editor -> avatar project, then zoom out x0.76 D41 starting 2 f after
- ref3 1:44.7 5 f: prompt -> generated result (generation skipped = time skip), zoom HELD, then pan up-left 262 px D32
- ref3 2:09.6 3 f: landing page -> dashboard after the Sign up click (outgoing 1.37, incoming 1.0)
- ref3 3:35.9 6 f: editor -> dashboard, then zoom out x0.82 D41
- ref4 0:10.1 8 f: Claude app -> Windows desktop (other app)
- ref4 1:10.3 5 f: dark chat -> light skills page
- ref4 7:24.8 6 f: zoomed settings menu (Download) -> desktop zoomed on the file, then zoom out
- ref4 10:30.9 6 f, 10:39.7 7 f: Claude settings <-> chat
- ref2 2:18.6 3 f video player -> folder window; 4:00.4 3 f ChatGPT -> Artlist; 8:17.1 4 f generation -> gallery; 10:23.2 5 f pricing -> MCP gallery
- ref5 1:55.5 4 f, 2:58.8 4 f, 5:53.4 4 f, 13:37.8 6 f

### hard_cuts
- ref3 1:40.1 editor -> Generate panel (menu click, same app)
- ref3 3:52.0 dashboard -> editor (click, white load skipped)
- ref3 1:44.0 prompt text appears at once (typing skipped by a jump cut)

### pans
- ref3 0:37.3 up-left 266 px D37 (prompt -> the result above it)
- ref3 1:32.2 down 278 px D35 (down the AI-tools panel to the Generate section)
- ref3 2:07.5 right 696 px D40, peak 1185 px/s (hero -> the Sign up button he clicks next)
- ref3 1:48.8 down-right 352 px D41 / 1:53.4 back up-left 345 px D50 (result <-> prompt)
- ref3 3:34.1 right-down 624 px D43 (subtitles panel -> video + timeline)
- ref3 4:11.7 down 242 px D40 (span opens zoomed on the preview, glides to the timeline controls)
- ref3 4:25.7 left 596 px D41 (to the template panel that just opened)
- ref3 8:36.6 / 9:13.3 horizontal 319 / 352 px D35 (across the pricing cards)
- ref5 6:40.8 up 219 px D48 (chat: back up to his prompt), 7:59.2 down 218 px D36 (to the reply / composer)
- ref4 1:32.4 431/179 px D34; 4:57.96 591/316 px D56

## What changed for ref 2

- Page changes inside a span: 7 dissolves (3–5 f) and 7 full-screen hard cuts — not 'usually a hard cut'.
- Constant-zoom pans exist (0.82 / min, median 374 px, D 36 f); the 2026-10-05 spec filed them under re-targets.
- Zoom-in median 1.35 with this test (1.37 in the 2026-10-05 per-move fit); ref 2 is the high end of the four, so the system now targets 1.27.

Rules, why/how/how much: `aieditor/screencast/SYSTEM.md` §3a–3c. Numbers in use: `motion/screencast_system.json`.
