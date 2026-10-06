# Screencast production system (reference 2)

What the Auto Editor's screencasts must look like, and how the pipeline gets there. The source is
**reference 2**: Jake's own tutorial `kwysV2smgfY` (11:39, 1080p, 29.97 fps). Every number below was
measured from that video unless it is marked as a rule of ours.

- **Numbers:** `motion/screencast_system.json`. They are design-free, so swapping colours, cursor or
  bubble ring never touches them. Its `camera` keys override `camera.py` DEFAULTS, `recorder` is read by
  `agent_rec.mjs`, and `qa` is read by `qa.py`. `build_keyframes.py` also copies it into
  `keyframes.json["screencast"]`.
- **Design (style):** `camera.py` STYLE (marker colour, cursor sprite) plus `compose_long.py` (bubble ring
  gradient #000357→#4117C9, Ø 358.6).
- **Measurements:** `motion/reference-specs/kwys-screencast.{md,json}` and `kwys-annotations-layouts.*`.
  The shot segmentation (`seg.txt`, 158 cuts) and the zoom events are in
  `/opt/aieditor-work/reference/work/kwys-screencast/`.

## 1. What the reference does: the measured facts

| | reference 2 | v5 (2026-10-06, before this system) |
|---|---|---|
| screencast share of the video | **74.9 %** (17 spans, median **19.9 s**; A-roll blocks median 6.5 s) | 71.7 %, median 23.9 s |
| camera moves per minute of screencast | **3.1** clean moves (≈4.1 counting partial ones) | **15.7** |
| zoom-in level | median **1.37×** (IQR 1.31–1.46). Above 1.6× once in 22 moves (2.03×, a model-table row) | median **2.0×**; 69 % of zoom-ins at 2.0× |
| time zoomed (>1.05×) / mean zoom | **62 %** / **1.24×** | 93 % / 1.64× |
| hold after a move | median **13.7 s** (IQR 6.6–19.9). 2 of 27 holds are under 1.5 s | median 1.2 s; 71 % under 1.5 s |
| in-span jump cuts | **7.2 per min**. Median shot 4.1 s, so a screen is held about 4 s, then a cut to the next state | 0.6 per min |
| loading / blank frames | **0.3 %** of screencast samples | 1.9 % (spinners, grey canvas, black page) |
| sparse frames (<8 % content) | 6.3 % | 7.0 % |
| zoom curve | in: cubic-bezier(.31,.10,.22,1) on log-zoom, 43 f (56 f above 1.45×); out: (.345,0,.33,.91), 50 f, lands on exactly 1.0 | same (already built) |
| span opening | push-in to ~1.36× from the 1st–2nd frame, 40 f, on the first action | yes, but the first action was usually a 2× corner zoom |
| page change inside a span | hard cut (sometimes a 6–10 f crossfade). The zoom state carries across jump cuts | camera stayed zoomed on the old page's corner (no navigation event) |
| scroll | native wheel flicks only, about 200 px each over 9–16 f. No synthetic pans | ok |
| cursor | native arrow/hand, no click ring, idle drift. Typing appears at once (paste or cut) | synthetic arrow, Bézier paths (ok) |
| facecam bubble | on every screencast frame, never on A-roll, cuts with the span, top-right, fades out only under a top-right target | ok |
| marker | yellow L→R wipe on phrases he reads, out when the camera next moves | ok |

## 2. Shot grammar: one beat = one calm screen

Each idea in the narration is one beat:

1. **Establish.** The screen the words are about is already up at the beat's first word. On a span's
   first frame there is a push-in to 1.36× toward it.
2. **Act.** The cursor travels (0.28–1.1 s Bézier) and clicks or types on the spoken word. A click lands
   on "click", and the item appears as he names it.
3. **Result.** A click that opens something is a **jump cut** straight to the loaded result. Waiting
   never shows.
4. **Hold.** The result sits still for at least 2.5 s. Moving the camera again needs ≥ 3 s more.
5. **Release.** No pull-back is needed. The zoomed state ends at the next page cut or at the cut to
   A-roll. An explicit zoom-out (50 f) happens only after 14 s with no target, or before a scroll
   (v10: not when a target follows the scroll within 3 s: one move goes straight to it).

A tutorial runs about **one beat per 4–6 s** of narration. The director writes its intents as
`on '<word>': <what fills the screen>`, and the recording agent gets "about N beats" with
N = segment duration ÷ 5.

**Result first.** When he describes a result ("look at this", "here are the designs"), the result
fills the screen from the first word. That means opening the existing document and fitting the canvas
so the designs are large. Small thumbnails on a sea of empty canvas are a defect.

## 3. Camera rules (`camera.py`)

| rule | value |
|---|---|
| zoom level for a target | fit the target at 62 % of the view, clamped to **1.25–1.45×** (cap 1.6). **2.0× only for `deep: true`** (one small detail he reads out) |
| move durations / curves | measured: see §1 |
| min hold between moves from a framed view | **3.0 s** (a move out of a full frame, e.g. after a cut, may come at once) |
| move budget | **≤ 3 eased moves per rolling 30 s** (≈ 6 / min; the reference is 3–4 / min) |
| clustering | one framing covers this target plus the next ones within **6 s** on the same page, while the union still zooms ≥ 1.25× |
| targets that never move the camera | navigation clicks (a click followed by a page change within 2.5 s); whole-page / oversized targets; read/hover framings that show only background (`empty_min` 0.03); targets already inside the view |
| page change (`nav` / big `cut` event) | hard cut; if the next target comes within 1.5 s the cut lands ALREADY FRAMED on it (the reference re-targets by jump cut more than by moves), else full frame and a fresh push-in (free of the budget) |
| placement | centre on the target, clamp into the frame (10 of 17 reference moves end clamped), shift away from the bubble zone when the frame allows |
| loading / blank source frames | never shown: the last good frame holds (`is_blank`, judged on the frame CENTRE with 15 % margins off so app chrome around a loading canvas does not count: std < 7 or < 2.5 % content) |
| bubble | fades out (6 f) while the held target is under x > 1480, y < 470 (≥ 8 % overlap), and back in over 11 f |

## 4. Recorder rules (`agent_rec.mjs`, `agentrec.py`)

- **Settle cuts.** After a click, Enter or goto, the page runs in real time, unrecorded, until it is
  stable (two 500 ms polls with < 0.5 % change) and not blank, for up to 25 s. If the screen changed
  more than 3 % meanwhile, a `cut` event is logged. The edit then jump-cuts from the click to the
  result, like the reference's 7 cuts / min. When nothing comes within 1.5 s there is no cut.
- **goto** waits for a stable, drawn screen before recording resumes.
- **Agent prompt (SYSTEM, "shot grammar"):**
  - one beat per idea, read/hover ≥ 2.5 s;
  - only meaningful blocks as read targets (cards, panels, designs, forms; never a lone word, icon,
    corner item or bare canvas);
  - `deep: true` only for a small detail he reads out;
  - navigation = just click (it cuts);
  - result first and big (fit the canvas, e.g. `key: "Shift+1"`; key combos are supported);
  - typing live at 16–20 cps;
  - no scrolling into empty or dark sections;
  - when something cannot be shown honestly, hover what he names instead of wandering.
- **PREPARE (off camera):** land on the opening screen, fit the result to the screen, and clear any
  dropdown or typed text the previous segment left behind.
- **Director:** intents are written as beats, only for content that exists in the account (the
  profile's history page list is appended to the walkthrough) or that the segment itself makes. Inside
  the app, use the app's address. Use the marketing site only when he says "go to the website".

## 5. Pacing per narration intent

| he says… | the screen does |
|---|---|
| "look at this / here's what it made" | the finished result already open, fitted big, push-in 1.36× at the span start; one more move at most (to the piece he names) |
| "click X" | cursor to X, click on the word, cut to the result, hold ≥ 2.5 s |
| "type / ask / describe" | click the field, type live at 16–20 cps, then submit (Enter) and cut to the result (`wait_for` hides long generations) |
| "it holds your logo, colours…" (a list) | ONE framing of the block that contains the list (clustered), no move per item; the marker only if he reads a phrase |
| "go to site.com" | goto (cut) to the page, hero visible, push-in |
| a small detail he reads (a price, a row) | `deep: true` → up to 2×, hold ≥ 1 s, then zoom out (50 f) |
| talking about something not on screen | stay on the current calm screen; never wander or scroll aimlessly |

## 6. QA: "close to reference 2" (`qa.py`)

`python3 screencast/qa.py edit <job>/edit-NN <job>/edit-NN.mp4` measures the edit and scores each
metric against the reference band:

- 100 inside the band;
- `exp(-distance/scale)` outside it;
- the total is the weighted mean.

| metric | ref | band | weight |
|---|---|---|---|
| screencast_share_pct | 74.9 | 65–85 | 1 |
| span_median_s | 19.9 | 14–35 | 0.5 |
| moves_per_min | 3.1 | 2.5–6 | 2 |
| zoom_in_median | 1.37 | 1.28–1.48 | 2 |
| deep_zoom_pct (> 1.6×) | 5 | 0–10 | 1.5 |
| time_zoomed_pct | 62 | 45–80 | 1 |
| mean_zoom | 1.24 | 1.15–1.33 | 1 |
| hold_median_s | 13.7 | 4–20 | 1.5 |
| short_holds_pct (< 1.5 s) | 7.4 | 0–12 | 1 |
| cuts_per_min (in-span) | 7.2 | 2–12 | 1 |
| blank_pct | 0.29 | 0–1 | 2.5 |
| sparse_pct | 6.3 | 0–12 | 1 |

The blank and sparse percentages come from the same frame code on both videos (2 fps samples, bubble
masked). `python3 qa.py ref` re-measures the reference side.

## 7. What QA cannot see: the frame review

Before an edit counts as "close to reference 2", sample its screencasts at 2 fps (contact sheets) and
check every beat:

1. The screen shows what the words say, at the words.
2. The result is big.
3. No spinner, grey canvas or black page.
4. The zoom lands on content, not on a corner or bare canvas.
5. Nothing he names is hidden behind the bubble or cut off by the frame edge.
6. No leftover state from an earlier segment (an open dropdown, typed text).

## 8. Known gaps (2026-10-06)

- ~~Canvas results open "fit all" and stay small~~ — FIXED v10 (2026-10-06): `fit_designs` in
  `agent_rec.mjs` is deterministic. It maps which screen cells are the design canvas
  (`elementFromPoint` = the `<canvas>` or a shadow-root host like Linearity's `<curve-canvas>`;
  the document must not scroll), finds the designs (cells off the canvas colour), clusters them
  (gaps ≤ 3 cells), keeps the biggest cluster plus any that keeps the framing ≥ 30 % dense (a far-off
  artboard is left out), zooms out until that group is fully on screen, then fixes it and follows
  it ANALYTICALLY: one ctrl-wheel zoom about the point that maps its centre to the canvas centre
  (≈ 86 wheel units per 2×), then wheel pans (≈ 1/SCALE units per css px, gain re-measured on an
  unchanged cluster). Re-measuring the group after a zoom made it oscillate: clusters split as gaps
  grow with the scale. Target fill 0.78 of the canvas area. It runs after every load, after every
  BIG settle cut (inside the cut) and at the end of PREPARE. The agent's own canvas-zoom keys
  (Shift+0/1/2, Ctrl±/0, zoom-scroll) are ignored on a fitted page.
- **Screenshots were BLACK on scrolled pages** — FIXED v10. `Page.captureScreenshot`'s `clip` is in
  DOCUMENT coordinates. A clip at (0,0) on a scrolled page captured the unpainted top of the
  document. That was the "dark pricing page" and every earlier "scrolled into a black section" on
  linearity.io. `vclip()` adds the visual viewport's pageX/pageY (agent_rec.mjs and vrecord.mjs).
- **Bubble over the subject** — v10: `clear_bubble` (camera.py) searches framings near the target
  (pan ±30 %, zoom ±8 %). It keeps the target fully in view and out of the bubble zone, and picks the
  framing whose facecam disc covers the least content, plus half the content cut by the left or
  right frame edge. At 1:10 of v9, the "Jake Dawson" title ran under the bubble; it now sits fully
  in view below it.
- **Scrolls and off-screen targets (v10).** A page scroll ENDS on its word: the recorder starts it
  0.4 s per 200 px early. A read/click whose target is off screen is scrolled to visibly first,
  and that scroll also ends by the word. Previously a silent `scrollIntoView` jumped the page
  and left the target on the bottom edge. A read of text frames the words (Range rect), not the
  block: a full-width `<p>` was 2100 px wide, so it got no zoom. The camera lands the target that
  follows a scroll (within 3 s) by a JUMP CUT at the scroll's end. That costs no zoom-out and no
  move. moves/min went 7.85 → 6.65.
- **Camera moves per minute run at ~8 / min against the reference's 3–4.** Our narration-timed beats
  come every 3–5 s. The reference compresses with jump cuts and long holds that our virtual-time
  recording cannot invent.
- **Screencast spans are shorter (median 12 s against 20 s).** That comes from the director's plan,
  not the camera.
