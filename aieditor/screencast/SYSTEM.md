# Screencast production system (references 2–5)

> **Technique catalogue:** every cut, transition, zoom, pan, hold, overlay and A-roll move in refs 2–5, with trigger / why / how / how often / timestamped examples / frames: [`TECHNIQUES.md`](../.claude/skills/jake-editor/TECHNIQUES.md) (data: `motion/techniques.json`, 2026-10-07).

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

## 0. Jake's review of v11 (2026-10-07) — THESE RULES WIN

Jake reviewed sample v11 (the TEST job, `edit-01-take11.mp4`) point by point. Where an older rule
below disagrees (framing left of the bubble, 13.7 s holds, zoom on the prompt box, hard cuts to the
A-roll), this section wins. Numbers: `motion/screencast_system.json` (`camera`, `transition`,
`text_gradient`, `measured_2026_10_07`); measurement scripts + raw results:
`/opt/aieditor-work/reference/work/sc6/`.

**Approved by Jake (positive examples — keep doing exactly this):** v11 0:23–0:32 (the canvas: click a
headline, toolbar, edit — calm, centred, one beat per idea); 1:04 (screencast → screencast
dissolve); 1:10 (the zoom-in on the brand kit); 1:23 (the action framed centre-middle).

### Rule 1 — the subject ends CENTRE-MIDDLE
- **Rule.** Every zoom / pan / cut-in ENDS with the element the words are about in the centre of the
  frame. Nothing is shifted aside for the facecam.
- **Why.** The eye goes to the middle; an off-centre subject with half the frame empty reads as a
  mistake (v11 0:00–0:07 boards left/bottom with the right half empty; 0:09–0:11 brand page too high;
  2:06 leaning left).
- **How.** `camera.py` centres on the target and clamps only where the capture ends
  (`avoid_bubble: false` — `avoid_bubble()`/`clear_bubble()` are no longer called). On a design canvas
  the recorder first GLIDES the named design to the middle (`agent_rec.mjs centreOnCanvas`, a visible
  0.9 s eased wheel pan, logged as `pan`, for reads AND clicks). The wheel's gain differs per axis
  (v12a: x overshot ~30 %, y barely moved), so the REAL displacement is measured on screen (grey
  thumbnails, best shift searched around the expected one — an unconstrained search locked onto the
  dot grid) and one smaller correction glide fixes the rest; the logged box follows the measured
  move (`moved`). The camera may also run up to 25 % of the view past a FLAT canvas edge
  (`overscan_max`, filled with the canvas colour; never past real UI). Each named thing gets its own
  framing: clustering only within 2 s (`cluster_s`, was 6 s); a target logged at the instant of a
  page change belongs to the NEW page.
  A target only counts as "already framed" when it is centred within 0.12 and zoomed as it asks
  (`framed()`); merely being somewhere in view no longer stops a move.
- **Numbers.** Refs 2–5 after zoom-ins/pans: edge-weighted content centroid **0.06 / 0.10 / 0.16 /
  0.27** from the centre (p25/50/75/90, frame units, 267 moves). QA: `subject_centre_median` ≤ 0.10,
  `subject_centre_p75` ≤ 0.16, `frame_centroid_median` ≤ 0.13. v11: 0.208 / 0.255.
- **Examples.** v11 1:23 (approved, centred action). Ref 3 0:13.6 (push onto the generated video).

### The facecam bubble — fixed, hidden only for actions under it
- **Rule (Jake, verbatim):** "no need to move the bubble anywhere" / "It should stay at that exact
  position" / "If an item is clicked behind it — hide the bubble for that period of time only and
  bring it back when the action behind it finishes."
- **How.** Centre (1701.9, 253.7) @1080p, Ø 358.6, on every screencast frame. `camera.py` reports a
  hide span ONLY while a click (from 0.35 s before the press until it lands) or a type acts on
  something under the disc (`bubble_hide_actions`, `action_targets`); reads, hovers and held
  framings never hide it. Fade out 7 f, back in 11 f (ref 2). QA `bubble_constant_pct` (ring at its
  exact place on ≥ 97 % of 2-fps screencast samples outside action hides).

### Rule 2 — constant motion
- **Rule.** If there is no cut there must be movement. Jake's pattern: move (0:00–0:02) → hold ~3 s →
  pan to another part of the same screen (0:05–0:07) → the next movement (0:08).
- **Numbers (refs 2–5, 854 holds).** Screencast time with no camera move, no cut and no dissolve:
  **p50 1.0 s, p75 3.07 s, p90 6.04 s, p95 8.9 s** (per ref p90 7.4 / 6.1 / 5.2 / 6.5). Motion events
  (moves + cuts + dissolves) **17–25 per minute**. Fully pixel-static runs p50 1.3 s, p90 4.8 s.
- **How.** `fill_holds()`: a hold that would run past `hold_max_s` 6.0 gets a DRIFT `hold_target_s`
  3.0 s after the last motion — a centred push ×1.08 (a pull-back ×1/1.08 when that would pass the
  zoom cap), 54 f, curve (.33,.02,.27,.96); repeated while the gap lasts. Scrolls, canvas pans and
  live typing count as motion. The agent gives a new beat every 3–5 s. QA: `static_hold_p90_s` ≤ 6.5,
  `static_hold_max_s` ≤ 9, `motion_events_per_min` 12–30. v11: p90 7.1 s.

### Rule 3 — reveal the tool when he names it
- **Rule.** "This tool called Linearity" (v11 0:12) → full-screen narration OR the tool's landing
  page (logo, hero, unzoomed). Not an app page.
- **How.** `director.py` JAKE'S SCREENCAST RULES + agent rule 3.

### Rule 4 — no purposeless pages, never the whole canvas
- **Rule.** No page shown only as a way-through (v11 0:15: Home). Never the whole zoomed-out canvas
  (v11 0:19) — go straight to the main section zoomed, or use full-screen narration for the wow.
- **How.** Director + agent rules (goto the page directly from the account's page list); camera
  frames designs centred (rule 1).

### Rule 5 — screencast ↔ full-screen narration: the bubble first
- **Rule.** Copy the references: a short fade of the BUBBLE first, then the screencast, so fast it
  isn't noticed (v11 0:32 and 1:54 were hard and choppy).
- **Numbers (refs 2–5, 262 boundaries).** 88 % (exit) / 94 % (entry) are hard cuts of both together;
  the rest are the dissolve variant Jake asked for: bubble fade **3 f** as read by the ring-blue test
  (2–5; e.g. 1 → .8 → .64 → .39 → .07 → 0 — that test drops out half-way through a fade, so the true
  fade is ~6 f: our true 3 f fade read as 1 f), screen dissolve ≈ 0.06–0.14 per frame (50 % after ~8.5 f), the bubble gone while
  the screen is still < ~40 % (ref 5 0:35.8: bubble f23–26, screen from f28; ref 3 5:19.6; ref 5
  9:19.8). Entry mirrors it: the screen dissolves in, the bubble fades in over 3–5 f in its second half.
- **How.** `longedit.compose` renders each screencast 10 f past its end (`aroll_tail_s`) and flags
  `aroll_in` / `aroll_out`; `compose_long`: exit = bubble out over 6 f from t1 − 4 f, screencast alpha
  out over 10 f from t1; entry = screencast alpha in over 10 f from t0, bubble in over 6 f from
  t0 + 5 f (`bubble_env_expr`). Screencast → screencast stays the 5 f dissolve (approved 1:04).
  QA `aroll_transition_ok_pct` (frame-measured: bubble fade 1–6 f and first, screen 4–20 f, no
  1-frame jump).

### Rule 6 — a gradient behind every text overlay
- **Rule.** The text animations are right (v11 0:33) but ALWAYS sit on a black→transparent gradient.
- **Numbers (ref 2, kwysV2smgfY f1720–1822 "Hey everyone"/"I'm Jake Dawson", f13548–13620 "Link in
  the description").** Full width, bottom → up: alpha(y) = **0.63 · clip((y/H − 0.15)/0.85, 0, 1)^1.23**
  (y .50 → .21, .76 → .42, .98 → .62); fades in over **22 f** ≈ linear from the text's first frame
  (on the cut), stays across back-to-back titles, fades out over **8 f** with the text's exit.
- **How.** `compose_long.TEXT_GRADIENT`, `gradient_png()`, `gradient_spans()` (lower_title, link,
  keyword, list, number; merged when < 1 s apart), drawn under the text. QA `text_gradient_pct`
  (bottom side band ≥ 20 % darker than just outside the overlay). v11: 0 %.

### Rule 7 — pricing
- **Rule.** Screencast the LANDING page unzoomed (logo visible), then CUT straight to the ZOOMED Free
  section of the pricing page. Never all the prices (v11 0:48).
- **How.** Director + agent rule 7: the agent's goto to the pricing page carries `"cut": true` → a
  HARD cut (a plain goto dissolves — Jake APPROVED that dissolve at v11 1:04, dialog → brand kit), and
  the read of the Free card right after lands framed on the cut.

### Rule 8 — clean screens
- **Rule.** Paste the whole domain at once; nothing pops up (v11 1:01: letter-by-letter typing and
  search suggestions).
- **How.** `type` takes `"paste": true`: real key events, each acknowledged by a SILENT clock tick
  (`step(true)`: the page clock moves, no frame is recorded), so the text appears all at once (a JS
  value setter did not render in Linearity's field, v12c 1:02). ⚠️ Key events need a frame to be acknowledged on the
  paused virtual clock — `Input.insertText` or keys typed without a `step()` between them HUNG the
  recorder (v12 seg-02, twice). A suggestion list that APPEARED with the typing is closed with Escape
  (`agent_rec.mjs`); agent rule 8.

### Rule 9 — no unnecessary scroll (v11 1:13)
Director + agent rule 9: scroll only to reach the one thing he names next.

### Rule 10 — prompts: typed zoomed out, then a FADE to all the designs
- **Rule.** Typing the prompt reads better zoomed OUT (v11 1:16–1:19 was zoomed off-centre on the box);
  then a fade to all the designs together — no click on the designs.
- **How.** `type_zoom: false` (a type target never zooms in; a held zoom opens out as typing starts);
  agent rule 10: after typing, goto the finished document (a dissolve), no clicks on designs.

### Rule 11 — on the word, straight to the target
- **Rule.** From no zoom to the login button only when he says it (v11 1:45); zoom straight to the
  target ("brand" in the left sidebar, 2:21) — no wandering.
- **How.** The recorder logs the requested word second `at` on every event; the camera starts a zoom
  at `at` (`word_lead_s` 0; else press − 0.35 s for a click, the end of the cursor travel for a hover).
  The span-opening push-in heads for a target only when it is named in the first 1.0 s
  (`entry_target_s`); a span whose first beat is a CLICK named later opens at 1.0 (no zoom before the
  word), one that opens on a result gets the refs' centred push; after it the word wins over the hold
  minimum. A click that NAVIGATES (Log in, Brand in the sidebar) is now a target too: a quick 24 f
  zoom straight to it that lands on the press, then the page change (`nav_click_zoom`). Typing right
  after a dissolve opens out instead of framing the box.

## 0b. Loop round 1 (2026-10-07) — rules from the independent v12 review (28 findings)

Source: `/tmp/.../rev/REVIEW-v12.md` (finding numbers #N below) + the technique catalogue
`.claude/skills/jake-editor/TECHNIQUES.md` (ids in brackets). These rules were found because the screen did not show
what Jake said; they win over older text in §2–§5 where they disagree.

### R1 — the account must SHOW Jake's own world (#4 #18 #19 #23 #25 #27)
- **Rule.** Before recording, the account is set up so that every "my / your" in the narration is
  Jake's: his brand is the ACTIVE brand (Home prompt chip, Brand page), the result document is a
  campaign generated WITH his brand from the prompt he types on camera, and no other company's
  brand is visible when he says "my colors / my logo / your brand". QA `brand` forbids the test
  brand's name in every beat's title / framed text.
- **Why.** v12 showed Blue Bottle Coffee (the Scout's test brand, the only finished campaign) for "my
  colors", "my logo", "already look like your brand" and "your brand name" — the sentence was false.
- **How (this account, round 1).** Brand chip on Home set to Jake Dawson (and Blue Bottle removed from
  the multi-select); one generation "An Instagram post for my channel about AI for business owners"
  with the Jake Dawson brand (4 square posts, ~3 % credits), then Resize → Email Header 600×200,
  Ad (Landscape) 1200×628, Instagram Story 1080×1920 (~1¾ min) → document "Jake Dawson AI For
  Business Owners Post"; the 3 resized artboards dragged next to the squares so all 7 sit in one
  row without overlap (story/ad overlapped after the resize). Linearity's sidebar "Brands" always
  opens the NEWEST brand (Blue Bottle) — it cannot be switched, so the "Click brand" beat loads
  Jake's brand page inside the click's cut (`click.goto`, CUT02).
- **Numbers.** Credits 97 % → 94 % (generation) → Resize job (no further % change shown).

### R2 — every beat lands ON its word; nothing is dropped (#2 #5 #6 #15 #16 #27)
- **Rule.** A beat is (word time `at`, the clause start `from`, target box, zoom). The camera move starts
  ≈ 0.8 s before the word but never before the clause that names it, and lands by word + 0.3 s.
  Back-to-back named items (a list: "an Instagram ad, an email header, a wide ad, a story") get one
  move each, shortened to fit (≥ 18 f), never dropped by the hold minimum or the move budget.
- **Why.** Refs: moves START ≈ 0.8 s before the named word and land on it (ref 3, 16 moves, −0.8…+1.35 s;
  TECHNIQUES "Timing vs words"). v12: reads HELD their whole 2.5 s before the next action could start,
  so every later beat slid 1–3 s; "wide ad" and "a story" were never framed.
- **How.** `agent_rec.mjs`: a read with `at` returns at once and its hold is DEFERRED (the next action
  with `at` cuts it short); a click's PRESS waits for its word after the cursor arrives (a dblclick on
  the same spot pressed 0.64 s early); canvas glides now END on the word (start at − 1.0 s) and a beat
  that is already > 0.3 s late glides silently inside a jump cut (`late beat` cut, CUT06).
  `camera.py`: events carry `beat`/`from`/`zoom`; a beat's move uses `from`, no `hold_min_s`, no budget.
  `run_loop.py` (sandbox driver) writes the beats from the narration's word times — no LLM picks them.
- **Numbers.** Seg 0 list beats: Instagram 3.39 / email 4.77 / wide 5.88 / story 7.16 → each move 18–33 f.
  QA `on_word`: view at word + 0.3 s holds ≥ 90 % of the box, centred within 0.2 (clamped edges
  excused), `late_s` ≤ 0.4.

### R3 — catalogue levels per target (#1 #3 #9 #14 #17 #20 #24 #25 #26)
Levels stay inside the catalogue bands (zoom-ins ×1.2–1.4, ZM02 ×1.5–1.65 only for ONE small named thing).
A first cut used 1.6 for designs and 2.0 for small artboards (readability, #3) — qa.py zoom_in_median 1.6 vs
band 1.2–1.4 → brought back into the bands.
| target | zoom | technique | example in round 1 |
|---|---|---|---|
| the whole campaign ("a full marketing campaign") | 1.25, centred, lands framed on frame 0 | ZM05 + CUT06 | seg 0 0:00 |
| one design he names | 1.4 | ZM05 (×1.19–1.30; 1.4 = band top) | main post 0:03.4, 0:18.4 |
| a small artboard (email header, wide ad) | 1.65 | ZM02 (×1.5–1.65 one small named thing) | 0:04.8, 0:05.9 |
| a tall artboard (story) | 1.3 | ZM05 | 0:07.2 |
| a brand-kit card (Logo, Colors) | 1.4 | ZM05/ZM08 | 0:09.5, 0:11.1, 1:08.8 |
| a paragraph he reads | 1.3, centred | ZM06 (ref 4 0:26.8 ×1.35) | 1:10.9 |
| an input field he pastes into | 1.35 | ZM03 | 1:00.5 |
| a prompt box he points at ("that big box") | 1.4 | ZM03 | 2:08 |
| a dropdown/panel that opens (Resize formats, brand menu) | 1.4, clamped top/left | ZM04 | 0:23, 2:25 |
| a small CTA (Log in) | 1.6 | ZM02 | 1:44.5 |
| one line he reads on a full-width card (Free plan) | 1.65 | ZM02 | 0:52 |
| sign-up form / sign-in buttons | 1.3 / 1.45 | ZM06 / PN01 | 1:48.8, 1:52.4 |
| the edited design + its toolbar | 1.4 (toolbar 727 px wide must fit) | ZM05 | 0:28, 1:23 |
- A scripted beat's own zoom is honoured: it PANS only when the level is within ×1.03 (was 1.15,
  which kept a 1.4 view for a 1.25 group).
- The CAMERA box may differ from the element acted on (`frame`): the button + the menu it opens, the
  post + the toolbar it shows. The camera target and the clicked element are the SAME place on screen
  (#20: v12 clicked a headline the camera was not framing).
- A design at the capture's left edge (the main post) is clamped, not centred (refs clamp: ZM01 "centre on
  target then clamp to the capture edge"); overscan only past FLAT canvas, not the app's tool rail.

### R4 — reveal / release / A-roll transitions (#6 #7 #13 #22 #28)
- Before a dissolve to the landing page the zoom is RELEASED on the old page (ZM11, 0.8 s), so the
  landing arrives at 1.0 with the logo in view and stays still (ZM07 "hold at 1.0"; Jake #3) — v12
  carried a 1.6 zoom through the dissolve and drifted out on the landing.
- Screencast ↔ A-roll: bubble out over 4 f ENDING on the boundary, then a 4 f screen dissolve; entry
  mirrored (screen 4 f, then bubble 4 f). TR05 order + CUT04/CUT05 (≈ 99 % hard in refs): short
  enough that no 50/50 face ghost or white-page wash shows (v12 used 10 f).
- A screencast that runs to the last frame has no bubble-first exit; the whole composite fades to
  black over 30 f (TR08; v12 ended with the bubble at 60 %).

### R5 — the recorder's canvas fit must not give up (#8 #19)
- `fit_designs` ignores cells within 2 of app UI floating over the canvas (the prompt pill's halo joined
  the designs into one group touching the bottom edge → reveal up/down oscillation → "never fit" →
  the whole canvas at 17 %); a reveal that undoes the previous one zooms out instead; a document
  address retries the fit 4× (3 s) when the canvas has not drawn yet.

### R6 — clean screens and the right page (#10 #18 #21 #23)
- Typing into a prompt box first clears it (`type.clear`: Ctrl+A, Backspace on silent ticks) — Linearity
  keeps drafts. The PREPARE of a Home segment clears the draft off camera.
- "Resize" is two clicks (Resize → "Resize ›") — the formats panel is what "web, mobile, print" shows.
- The sign-up story is recorded in a LOGGED-OUT browser (fresh profile): linearity.io "Log in" →
  auth.linearity.io/register ("Hello there 👋", Google / Apple / SSO / email).
- The bubble hides for a click from the moment the cursor sets off for the target (was 0.35 s before
  the press — "Log in" sat under the opaque bubble while the camera landed on it), and also when the
  clicked box (not only the cursor point) is ≥ 25 % inside the bubble zone (BB01, Jake's action-only rule).

### R7 — content QA (`screencast/qa_content.py`)
Checks per beat from the recorder's own log (title, url, DOM text inside the framed box, typed value) and
the camera plan: `delivered`, `on_word` (+ `late_s`), `nav_on_word`, `brand` (forbidden strings),
`must` (per-beat expected text from the narration, `expect.json`), `typed` (exact text — catches a
garbled draft). It complements qa.py (geometry), which cannot see any of the above.

## 0c. Loop round 2 (2026-10-07) — rules from the round-1 review (D1–D20) + the main-session rulings

Source: `rev1/REVIEW-round1.md` (78-event ledger, 32 ✓ = 41 %). These win over §0b where they differ.

### S1 — the canvas target is centred in the CAPTURE, inside a cut (D1, D4) — CUT06 / CUT03
- **Rule.** Before a canvas beat is framed, the design canvas itself is panned so the named artboard
  sits at the middle of the capture; the pan happens INSIDE a cut (silent frames) and the camera lands
  framed on it. A camera may clamp only at a REAL page edge — a design canvas scrolls, so its capture
  edge is no excuse.
- **Why.** Round 1: Jake's artboards fill the capture width with the main post at its left edge, so every
  ×1.3–1.4 framing clamped and ended at x ≈ 27 % (11 events). Ref 3 0:13.6, 2:07.5: the subject ends
  centred.
- **How.** `agent_rec.mjs` action `"center": "cut"` → `centreOnCanvas(b, late=true, force=true)` (wheel pan
  measured by thumbnail best-shift, one correction) logs a `late beat` big cut; the act result returns
  `moved` (shot px) so the driver shifts every later canvas coordinate. QA `on_word` centre tolerance
  0.08 with no edge excuse on `/file/` pages.

### S2 — never squeeze a move; cut instead (D3, D13, D14) — CUT06 / CUT03
- **Rule.** A word-timed move whose available time (clause start or word − 0.8 s → word + 0.3 s, a click's
  zoom → the press) is shorter than 0.8 × its catalogue duration becomes a CUT that lands framed at
  word − 0.1 s. Items named 0.7–1.5 s apart (a list) are a cut chain. Moves under ×1.05 and < 60 px are
  dropped (no technique matches a twitch).
- **Numbers.** Catalogue durations: ZM02 45–58 f, ZM03/ZM06 32–55 f, ZM05 34–51 f, ZM11 34–40 f, PN D ≈
  24 + 0.035·px (26–56 f); 20 % tolerance. Round 1 had 14–20 f moves and a 3768 px/s whip.
- **Refs.** Cut chains ref 5 1:59.0–2:03.0 (cuts on "Images … videos … feed"), ref 3 1:00.4 / 1:04.3.

### S3 — dissolves arrive framed; landings get ZM07 (D5, D6) — TR02 / TR03 / ZM07
- A goto into a document dissolves straight into the framed view (the render holds the outgoing OUTPUT
  image, so a cut to the new framing at the dissolve's first frame never jumps the old picture).
- A dissolve to a tool's LANDING page cuts the camera to 1.0 at its first frame (Jake #3), holds ~1–1.5 s,
  then pushes ×1.3 onto the hero + prompt with the logo kept in frame (ZM07: ref 3 2:04.9, D 38–48 f).

### S4 — content beats the words name (D2, D8) — Jake: words = screen; rule 8 clean screens
- "fonts" → the font list; "colors" → the Fill colour picker (Linearity docks it at the LEFT screen edge,
  so that beat shows the whole screen); "the logo itself" → the face-logo element selected.
- The pasted domain shows for 0.15 s, then the time-skip dissolve (TR02) — "Reading the site…", the Import
  spinner and "This brand is already set up" never reach the video (`type.after`).

### S5 — containers, not text lines (D7, D10) — ZM06 / ZM09
- The brand-kit page is scrolled 200 px inside the dissolve so title, Jump-to-section row and paragraph
  are all on screen; the paragraph is then centred at ×1.3 with a full-length move.
- Linearity's Free plan is a FULL-WIDTH banner (1218 / 1280 px): no ZM level can hold the whole card,
  so the ×1.25 frame holds its left 80 % (title, credits line, What's included), centred vertically —
  ruling needed if that is not acceptable.

### S6 — keeping the test brand off screen without touching the account (D11)
- Home shots are framed on heading + prompt box at ×1.35 (the Recents row, which lists the Scout's
  "Blue Bottle Coffee Spring Sale" document, stays below the frame).
- The brand menu is filtered by its own search ("Jake Dawson", typed inside the opening — no frames), so
  only "MY PRIVATE BRANDS · Jake Dawson ✓" shows, then Jake Dawson is ticked (menu closes).

### S7 — bubble, presses, holds, opening, end (D12, D15–D18, D20)
- **Bubble (Jake's BB01 exception):** hides only when the clicked/typed element's on-screen BOX intersects
  the disc (r 179 px at 1702, 254 @1080p). Cursor path and the old zone rectangle no longer count.
- **Presses** land on the word; a click's zoom lands ON the press (CUT02/ZM12); the cursor is placed first
  (a hover at the shot's start) when the press comes early in a shot.
- **Holds:** no camera-still stretch over 3.0 s — a ZM10 slow centred push (×1.08, 46 f) starts 1.5 s after
  the last motion (`hold_max_s` 3.0, `hold_target_s` 1.5, `drift_frames` 46).
- **Opening:** no reference has a screencast cold open → the refs' video opening (TR07): frame 0 punched
  in ×1.45 of the landing framing, easing out over 31 f (0.089, 0.443, 0.126, 0.834).
- **A-roll transitions (D17):** Jake's rule 5 OVERRIDES TR05's numbers: bubble out 4 f ending on the
  boundary, then a 4 f screen dissolve ("so fast it isn't noticed", v12 #13). Reference TR05 (bubble ~10 f
  ahead of an ~8 f dissolve, ref 5 0:35.8) is kept as the reference fact, not the house setting.
- **End (D20):** TR08's fade starts when the LAST WORD ends (here 148.75 s → 7 f to the end), never earlier.

### S8 — QA fails the round (root cause 7)
`qa.py` returns verdict FAIL (exit 1) on ANY out-of-band metric; `qa_content.py` returns FAIL on any
failed check (centre 0.08, no canvas-edge excuse).

## 0d. Loop round 3 (2026-10-08) — rules from the round-2 review (N01–N17)

Source: `rev2/REVIEW-round2.md` (57/96 = 59 %). **Process rule (main session):** no fix is claimed until it
is measured ON THE RENDERED FRAMES with the reviewer's tools — `screencast/qa_frames/` (copied from
rev2/tools: per-frame ORB similarity transform + bubble-ring colour → events; `verify_frames.py`: twitches,
zoom-outs, double cuts, flashes, bubble hides vs the acted box's disc distance, holds, end luma, a beat sheet
of the output frame at every word + 0.3 s). Recorder logs alone proved six round-2 claims false.

- **T1 Free card (N01).** Scroll the page inside the cut until the card's own box is mid-capture (two silent
  scrolls: measure, correct), frame its left 2/3 (title, credits line, What's included) at ×1.35 — the card's
  right end stays clear of the bubble, the logo strip falls in the lower part. Clamp only at the page edge.
- **T2 No release on a design canvas (N02, N03a).** A dissolve INTO a `/file/` page never zooms out after it
  (Jake rule 4 overrides TR03); the 14 s idle-out is off on canvases; a canvas re-centring cut within 0.25 s
  of a goto belongs to that goto (it hid the beat from the dissolve → release).
- **T3 The edit chain inside the approved shot (N03).** headline click / double-click / font list in the post +
  toolbar framing (×1.3, centred); "colors": a silent Escape closes the font list (a click on Fill with the
  list open only closed the list), Fill opens the picker, which Linearity docks at the LEFT screen edge →
  a CUT06 onto it (ZM04, clamped at the real edge); "the logo itself": silent Escape×2 + a silent click on
  blank canvas (Escape alone keeps the headline selected) inside the cut, then the logo click → image toolbar
  (Edit with Prompt / Crop / Remove Background / Upscale) replaces "Helvetica 120".
- **T4 Clean prompt box (N04).** The Home draft is cleared in PREPARE (off camera); the on-camera type has no
  `clear`.
- **T5 Pop-ups (N05).** After a paste, any frame holding the pasted text also holds "Reading the site…" +
  Import (they appear in the same frame) → 1 frame of the pasted field, then a HARD cut (CUT01) to the kit.
- **T6 Paragraph (N06).** Zoom increases title (×1.2) → row (×1.3) → paragraph's first 5 lines (×1.4, 36 f),
  each framed by its own box, centred.
- **T7 Bubble (N07, N03b).** Decided ONCE per action at the frame before its press, from the ACTED element's
  box (`abox`, not the camera frame box) in output px vs the disc (1701.9, 253.7) r 179.3. Log in is framed at
  ×1.65 so its box ends 184 px from the disc centre (ZM02 top of band) — no hide.
- **T8 Typing (N08).** Home at 1.0 with no camera move while typing (Jake #10). The Recents grid was made
  Jake's by generating 10 Jake-brand documents (≈6 % credits) — the Scout's test document is now 12th, off
  screen (row 3); nothing deleted or renamed.
- **T9 A-roll (N09, N12).** The A-roll framing holds 0.3 s past its block end (no ×0.89 snap under the entry
  dissolve); push 2.2 %/s capped ×1.14 (AR01); jump cuts inside a block (grey 64×36 diff ≥ 2.5 and ≥ 3× the
  local median, merged within 0.3 s) toggle a ×1.32 punch-in (CUT07).
- **T10 Drifts (N11).** One inward ZM10 push ×1.08 over 42 f with a LINEAR ramp (≥ 0.0018 log-scale per frame,
  so the whole push registers on the frames — eased tails measured as ×1.04 in 20 f), starting 1.3 s after the
  last motion, only when the whole push fits; never outward, never alternating. A planned pan after a drift
  keeps the beat's own zoom.
- **T11 Durations (N13).** A beat may name its catalogue duration (`frames`, e.g. ZM07 46 f); a move starts
  (duration − 0.3 s) before its word, never before its clause.
- **T12 Brand menu (N15).** The arrow is clicked on "arrow"; the menu's search is typed on silent ticks inside
  the opening ("MY PRIVATE BRANDS · Jake Dawson ✓", no test brand); its search also lists PUBLIC look-alike
  brands, so Jake Dawson is ticked on "up" (~0.4 s later) and the menu closes.
- **T13 End (N16).** The picture is extended past the cut (last frame held, audio padded) so TR08's full 30 f
  fade to black + 3 black frames runs after the last word.
- **T14 Pointer.** After a re-centring cut the REAL pointer is parked on blank canvas (a hover ring sat on a
  design, N02); the drawn cursor is unchanged.

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
| page change inside a span | hard cut within one app; a 3–8 f DISSOLVE on a change of world (re-measured 2026-10-07: 7 dissolves vs 7 hard cuts, §3b). The zoom state carries across jump cuts | camera stayed zoomed on the old page's corner (no navigation event) |
| scroll | native wheel flicks, about 200 px each over 9–16 f. Constant-zoom PANS do exist (0.8 / min, §3c) — the 2026-10-05 spec counted them as re-targets | ok |
| cursor | native arrow/hand, no click ring, idle drift. Typing appears at once (paste or cut) | synthetic arrow, Bézier paths (ok) |
| facecam bubble | on every screencast frame, never on A-roll, cuts with the span, top-right, fades out only under a top-right target (§0: now only while an ACTION is under it) | ok |
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
| zoom level for a target | fit the target at 62 % of the view, clamped to **1.2–1.4×** (cap 1.6; was 1.25–1.45 before refs 3–5, §3a). **2.0× only for `deep: true`** (one small detail he reads out) |
| move durations / curves | measured: see §1 |
| min hold between moves from a framed view | **3.0 s** (a move out of a full frame, e.g. after a cut, may come at once) |
| move budget | **≤ 3 eased moves per rolling 30 s** (≈ 6 / min; the reference is 3–4 / min) |
| clustering | one framing covers this target plus the next ones within **6 s** on the same page, while the union still zooms ≥ 1.25× |
| targets that never move the camera | navigation clicks (a click followed by a page change within 2.5 s); whole-page / oversized targets; read/hover framings that show only background (`empty_min` 0.03); targets already inside the view |
| page change (`nav` / big `cut` event) | hard cut; if the next target comes within 1.5 s the cut lands ALREADY FRAMED on it (the reference re-targets by jump cut more than by moves), else full frame and a fresh push-in (free of the budget) |
| placement | centre on the target (§0 rule 1), clamp into the frame only where the page ends; no bubble shift |
| loading / blank source frames | never shown: the last good frame holds (`is_blank`, judged on the frame CENTRE with 15 % margins off so app chrome around a loading canvas does not count: std < 7 or < 2.5 % content) |
| bubble | fixed; fades out (7 f) only while a click/type acts under it, back in over 11 f (§0) |

## 3a–3c. The camera grammar from refs 2–5 (measured 2026-10-07)

Jake (2026-10-07): "more references from the same editor so you have the system detailed to a tee".
Refs **3** `3Jq-L6uLd28` (VEED, 13:34), **4** `Geg9TyNoi3w` (Claude skills, 13:50) and **5**
`AZxFgIVgHjg` (Claude + Higgsfield, 15:44) are the same editor as ref 2. All four went through ONE
frame pipeline (`/opt/aieditor-work/reference/work/sc5/bin`: per-frame ECC affine between consecutive
320×180 frames with the facecam masked, full-frame blend tests for dissolves, a free cubic-bezier fit
per move), then every class of event was checked on contact sheets. Numbers + timestamped examples:
`motion/reference-specs/sc4-refs2-5.{json,md}`. Spread = per-ref medians (ref 2 / 3 / 4 / 5).

### 3a. Zoom targeting — where, how much, and when not

**Rule.** Zoom to the ONE region the sentence is about, at the smallest zoom that makes it the
subject: 1.2–1.4×, ~1.5–1.65× only for a single small control he names (a Subscribe button, one
row). Centre on it, then clamp the view into the frame — side panels end flush with the left edge,
prompt boxes flush with the bottom.

**Why.** The UI is already magnified in the recording; a mild zoom removes the browser chrome and the
unrelated half of the screen while keeping enough context to see where on the page we are. Big zooms
are kept for "click exactly this".

| target | zoom | framing | example |
|---|---|---|---|
| generated result (video/image) | 1.19–1.3, often a centred slow push | centred, result fills ~60 % of the height | ref 3 0:13.6 ×1.27 |
| prompt / input box he types into | 1.35–1.45 | centred horizontally, clamped to the bottom | ref 3 1:40.3 ×1.39 |
| side panel / settings list he walks | 1.25 | clamped left (or right) + top | ref 3 1:30.1 ×1.26 |
| text block / doc section he reads | 1.3–1.35 | the paragraph centred | ref 4 0:26.8 ×1.35 |
| landing hero (headline + prompt) | 1.37 | upper-left of centre | ref 3 2:04.9 |
| dashboard row of items | 1.43 | the row centred | ref 3 3:44.1 |
| one small button / CTA | 1.5–1.65 (2.0 once in ref 2) | button centre-left, clear of the bubble | ref 3 1:11.7 ×1.64 |

- **Zoom-in levels:** median **1.35 / 1.27 / 1.28 / 1.25** (4-ref IQR ≈ 1.23–1.32). Ref 2 alone
  (1.37) was the high end, so the system median is now **1.27** (`zoom_min` 1.2, `zoom_max` 1.4,
  `entry_zoom` 1.28).
- **Curve / length:** zoom-in D median **42.6 / 35.8 / 36.3 / 38.5 f** → 38 f; free-fit curve
  medians (.319,.103,.236,.996) (.326,.061,.229,.998) (.327,.061,.267,.92) (.313,.051,.274,1.0) —
  the ref-2 curve (.31,.10,.22,1) stays. Zoom-out D 34 / 40 / 26 / 39 → **40 f**, curve
  (.33,0,.31,.93) (refs (.324,.002,.326,.903) (.33,0,.298,.974) (.333,.004,.325,.919)).
- **Held zoom before a zoom-out:** 1.25 / 1.26 / 1.16 / 1.29.
- **Centred pushes** (no target, slow, on a result or a chat column): 12 / 12 / 24 / 41 % of zoom-ins.
- **Facecam:** ~~targets are framed left of / below the top-right bubble~~ — superseded by §0 rule 1 (centre-middle); the bubble never moves.
- **Spans may open already framed** (the cut from A-roll lands zoomed, e.g. ref 3 4:11.7, 8:36.6);
  most open at 1.0 and push in from frame 1–2.
- **When NOT to zoom:** a whole page he only names (a gallery, a YouTube channel page — ref 3 0:59.6,
  1:26.5: scrolled at 1.0 with native ~95–190 px wheel flicks over 6–8 f), an overview of the tool
  while he talks about it in general (ref 3 5:00–5:56), during menu click-chains, and anything that
  already fills the frame.

### 3b. Screencast-to-screencast transitions — cut or dissolve

**Rule.** Same world → **hard cut**. Change of world → **dissolve**.

| the next screen is… | join | measured |
|---|---|---|
| the same page, a later state (typing done, a list loaded, a menu item clicked) | hard cut | ref 3 1:44.0 prompt text appears at once |
| the next page of the same app after a click | hard cut (white load skipped) | ref 3 1:40.1, 3:52.0 |
| another app / site / window, another project, another account | dissolve | ref 4 0:10.1 (8 f), ref 2 4:00.4 (3 f), ref 3 0:43.2 (6 f) |
| the same page after a long wait (a generation finishing = a time skip) | dissolve, zoom held | ref 3 1:44.7 (5 f) |
| a click that lands somewhere far (landing → dashboard) | short dissolve | ref 3 2:09.6 (3 f) |

**Why.** A hard cut says "continuing"; a dissolve says "meanwhile / somewhere else / later". The refs
use it exactly where a hard cut would read as a glitch: the layout changes completely or time passed.

**How.**
- Length **3–8 f**: medians 3 / 6 / 5 / 4 → **5 f** (`xfade_frames`).
- Curve: **linear opacity** — the blend weight rises by 0.16–0.27 per frame (ref 3 0:39.7:
  .16 .32 .48 .65 .82), uniform over the whole frame.
- **Zoom state:** the framing is HELD through the dissolve — the incoming screen arrives at the
  outgoing zoom and position. Then, within 0–20 f, the camera zooms out to 1.0 (D ≈ 40 f; ref 3
  0:43.3, 3:36.2; ref 4 7:25.0) or glides to the new subject (ref 3 0:39.9 pan, 1:44.8 pan).
- **Facecam:** untouched (an overlay above both). **Cursor:** part of each recording, it blends.
- **How often:** dissolves / (dissolves + full-screen hard cuts) = 50 / 60 / 76 / 29 %; 0.4–1.4
  dissolves per minute of screencast.
- Ref 2's spec said page changes are "usually hard cuts, sometimes 6–10 f crossfades". With the same
  test as refs 3–5, ref 2 has **7 dissolves and 7 full-screen hard cuts** (3–5 f) — updated here.

**In the pipeline.** `camera.py` `xfade_cues`: a `nav` (goto), a found `wait` (wait_for) and a
`cut` whose `why` is `enter` dissolve (5 f, framing held, then zoom-out unless a target follows within
3 s (`xfade_target_s`) — then the camera moves straight to it, pan or zoom). `cut` events from clicks stay hard.
Two screencast segments back to back in the edit dissolve too (`longedit.compose` renders the
outgoing clip 5 f longer, `compose_long` fades the next one in with alpha).

### 3c. Moves inside a zoom — why, how, how much

**Rule.** When the camera is zoomed and the next thing he talks about wants about the same zoom
(within ×/÷1.15), it **pans** there at constant zoom instead of pulling out and pushing back in.

**Why** (every verified pan):
- input → output: prompt box → the result above it after a generation, and back (ref 3 0:37.3,
  1:48.8, 1:53.4);
- reading down: the next section of a panel/list (ref 3 1:32.2), a chat thread up to his prompt or
  down to the reply (ref 5 6:40.8, 7:59.2);
- the next action: across to the button he clicks next (ref 3 2:07.5, hero → Sign up);
- something that just opened at the side (ref 3 4:25.7, template panel);
- across a row of cards (ref 3 8:36.6, 9:13.3, pricing).

**How.**
- Zoom constant: ratio 0.95–1.01 across the pan.
- Curve: one eased in-out, free-fit medians (.331,.031,.275,.96) (.329,.007,.262,1.0)
  (.355,−.053,.298,.943) (.328,.032,.26,.929) → **cubic-bezier(.33,.02,.27,.96)** (`pan_ease`).
- Duration: D medians **36 / 38 / 32 / 34 f** (≈1.1–1.3 s). D grows with distance:
  D ≈ 22–31 f + 0.02–0.08 f per px → **D = 24 + 0.035·px**, clamped 26–56 f (`pan_frames_*`).
- Peak speed: medians 651 / 624 / 704 / 306 px/s (output px at 1080p); the fastest is 1185 px/s.
- Direction follows the layout: refs 3 and 4 mix vertical/horizontal/diagonal; ref 5 (a chat) is
  all vertical.

**How much.**
- Distance: medians **374 / 350 / 268 / 171 px** (IQR 124–506 px). The longest is ~720 px
  (0.37 of the screen); beyond ~0.55 of the screen the system makes a normal move instead.
- Frequency: **0.82 / 2.49 / 0.63 / 1.33 pans per minute** of screencast. Moves of every kind:
  5.5 / 6.6 / 4.7 / 5.7 per min; median gap between moves 10.8 / 8.1 / 14.7 / 10.5 s.
- Holds: the view is pixel-static between moves (no drift, no cursor follow).
- Native wheel scrolls (≤ 8 f flicks, ~95–270 px) are not pans; they are in the recording.


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

## 6. QA: "close to references 2–5" (`qa.py`)

`python3 screencast/qa.py edit <job>/edit-NN <job>/edit-NN.mp4` measures the edit and scores each
metric against the reference band:

- 100 inside the band;
- `exp(-distance/scale)` outside it;
- the total is the weighted mean.

| metric | ref | band | weight |
|---|---|---|---|
| screencast_share_pct | 74.9 | 65–85 | 1 |
| span_median_s | 19.9 | 14–35 | 0.5 |
| moves_per_min (all moves ≥ 15 f, refs 2–5) | 5.6 | 3.5–7 | 2 |
| zoom_in_median (refs 1.35 / 1.27 / 1.28 / 1.25) | 1.27 | 1.2–1.4 | 2 |
| deep_zoom_pct (> 1.6×) | 5 | 0–10 | 1.5 |
| time_zoomed_pct | 62 | 45–80 | 1 |
| mean_zoom | 1.24 | 1.12–1.33 | 1 |
| hold_median_s | 13.7 | 4–20 | 1.5 |
| short_holds_pct (< 1.5 s) | 7.4 | 0–12 | 1 |
| cuts_per_min (in-span) | 7.2 | 2–12 | 1 |
| blank_pct | 0.29 | 0–1 | 2.5 |
| pans_per_min (refs 0.82 / 2.49 / 0.63 / 1.33) | 1.1 | 0.5–2.6 | 1.5 |
| pan_frames_median (refs 36 / 38 / 32 / 34) | 35 | 28–44 | 1 |
| pan_peak_px_s (refs 651 / 624 / 704 / 306) | 620 | 250–950 | 0.5 |
| dissolve_share_pct (dissolves ÷ (dissolves + full-screen hard cuts): 50 / 60 / 76 / 29) | 50 | 25–80 | 1 |
| dissolve_frames_median (3 / 6 / 5 / 4) | 5 | 3–8 | 0.5 |
| target_fit_pct (rule: framed targets fully in view and clear of the bubble) | 100 | 85–100 | 2 |

Pan / dissolve length metrics are only scored when the edit has a pan / dissolve. A move at constant
zoom counts as a pan even in older plans that labelled it "in".
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

## 9. Recorder traps found in v12 (2026-10-07)

- **Input needs frames.** On the paused virtual clock a key / insertText / wheel event is only
  acknowledged when a frame advances: `Input.insertText` or keys typed without a `step()` between
  them hung the recorder. A paste sets the field value by JS (native setter + input/change events);
  an in-cut scroll ticks the clock with `step(true)` (silent: no frame recorded).
- **Stuck budgets.** After a wheel scroll on Linearity's brand page the virtual-time budget-expired
  event sometimes never came; the old 600 s step timeout "crashed" a healthy page (three 10-minute
  stalls). A step now continues after 30 s (`VT budget did not expire` on stderr; > 20 stalls = crash).
- **realtime()/pause() inside a recording** (to let a scroll settle) stalled the next step for
  10 min — never toggle the clock mid-segment outside `load()`.
- **Agent lateness.** The agent's beats land 0.5–1.5 s after their words when the beat before it
  holds/glides longer than the gap (v12: landing page at 13.2 s for "Linearity" at 12.2 s).
- Debug: `AIEDITOR_DEBUG=1` logs every agent step (`agent step @t: {...}`) into the job log.
