# Pills, CTA buttons and floating cards: frame-measured spec

Source: `gVPZU1btFA8/video.mp4`, 1920x1080, 24 fps. Frame = round(t*24). Offset 0 = the element's first visible frame.
The machine-readable version, with every per-frame table, fit and confidence, is `pills-cards.json` in this folder. This file summarises it.

**For an exact match, key every frame from the tables and interpolate linearly between frames.** The beziers are approximations, and their residuals are listed.

## 0. Headline findings
1. **No tracking and no idle float.** Through every hold, the card and pill edges stay on the same integer pixel (0 px drift, 0°). This holds for the 0:08 cards (f206–284, right-card edge x=1828 on every frame), the callout card, the 7:44 cards, the info cards and the Subscribe pill. The camera is locked off in these shots. So the data cannot say whether a card *would* track a moving camera. It does say: **do not add any idle bob.**
2. **Layering.** The 0:08 centre ad card and the 0:35 hologram window sit **behind the presenter**, who is matted over them. Everything else sits in front.
3. **Cards have a static 3D pose.** The edge nearer the frame edge is taller, so the cards form a shallow concave arc facing the presenter (rotateY about ±10–25°).
4. **The "LINK IN THE DESCRIPTION" pill appears 3 times (0:32, 3:58, 9:58) and is not identical each time.** It is the same template with different timings: morph at +12 / +10 / +15 f, text at +40 / pink-from-+2 / +38 f, and three different exits (hard cut / cut with shot / 4-frame blur-fade).
5. **The Subscribe→Subscribed asset is identical at 0:27 and 10:10** (same relative frames).
6. **Corrections to Gemini's shot list.**
   - The 0:20.6 "lower third" is really two elements: a logo tile bottom-left and a handle pill bottom-right.
   - "LAST VIDEO" is a separate warning, top-left.
   - The info cards start at **f12827 (8:54.46)**, not 8:53.1.

## 1. Per instance (key frames; full tables are in the JSON)

### Red brand pill "Marketing | Subscribe" (f605–700)
- **Entrance (shot A, wide side angle)**
  - f605–608: a rounded red square (124x109) fades in (0.15→0.5→0.75→0.9→1) at x 214–338, overlapping the outgoing "LAST VIDEO" text.
  - It holds 2 frames.
  - f610–622: it slides right while stretching into the pill, with horizontal motion blur. The table shows per-frame width and centre_x.
  - Width overshoots +2% at f622 and settles at **579 px by f627**.
  - Content timing:
    - Logo + "Marketing" fade in f616–618.
    - The white Subscribe capsule grows from the left f620–622, then rises 13 px f622–629.
- **Geometry**
  - bbox 266,212–849,321, height 109, radius about 22.
  - Slight 3D tilt: the right end is 6 px shorter and the left edge leans, roughly rotateY −3..−4° plus rotateX about 3°.
  - Soft drop shadow.
  - Fill is a left-to-right gradient, #D2323C → #E7423A.
- **Cut at f661 to the frontal shot.** The pill is already present, flat, and centred over the laptop (672–1255 × 860–967). It does not re-enter.
- **State change**
  - f663: the cursor pops in over the button.
  - f665–666: the button is pressed and turns grey (#D1D1D1).
  - f667: the button becomes a blank, blurred hot-pink capsule (#FE0C44).
  - f668–673: a bell icon and chevron appear while "Subscribed" types out at about 2 characters per frame, on pink/magenta. Pink sparkles burst out (f668–682).
  - f673–675: the fill turns wine (#671933).
  - From f677: the fill is #1E1E1E.
  - The container widens symmetrically by 86 px over f667–672, bezier (0.53, 0.11, 0.32, 1.07), residual ≤0.9 px.
- **Exit**
  - f690–692: the content fades.
  - f694–698: the right edge collapses leftward until only a 119 px square remains.
  - f699: the square is at about 25% opacity; it is gone by f700.
- **SFX**
  - Pop at −12 ms relative to f607 (medium-high).
  - Click at +20..60 ms after the press (medium).

### Logo tile and handle pill (f498–545)
- **Logo tile** (centre 241.5,909; 123 px; app-icon squircle)
  - Entrance:
    - f499: a white sparkle burst.
    - f500–504: a red dot scales up to 1.057 with rotation −10→−15→0°.
    - f505–506: overshoot to 1.065.
    - f509–510: undershoot to 0.976.
    - f513: settles at 1.0.
    - At f505 the fill switches to glossy pink.
    - The white squiggle stroke draws on f506–511.
  - Hold: the gloss decays to flat red #DE3A3D over f512–527.
  - Exit: it hops up 45 px over f526–529 (ease-out), smears at f530, and pops into falling sparkles at f531–535.
- **Handle pill** (settles at 1389,873–1740,955)
  - Entrance:
    - f498: a pink dot appears.
    - f498–504: the dot races right while stretching. Width runs 3→15→37→84→232→339→349; height runs 5→…→96, a +17% overshoot.
    - After that comes a damped wobble: width dips to 335 at f508 and re-peaks at 355 at f512–513. Height undershoots to 78 at f508.
    - Per-character blur/typing of "@ADILINTHEWILD" runs f503–513.
  - Exit: it hops up about 58 px over f539–542, then dissolves into glitch stripes at f543.
- **Stagger:** the handle starts 2 frames before the logo. The two exits are 13 frames apart.

### "LAST VIDEO" warning (f550–608)
- f550–557: the triangle stroke draws on, from the apex down the right side, then the bottom, then the left. The stroke is red with a scanline texture.
- f558–562: the text fades in with blur (0.2→0.45→0.7→0.85→1).
- f597–599: the icon fades out.
- The text holds through the cut at f604 and hard-cuts off at f609.
- SFX at 0 ms (high).
- Geometry: icon 115,284–268,417; text 296,324–664,375; cap height 51 px.

### Glass "✨ LINK IN THE DESCRIPTION" pill (0:32, 3:58, 9:58)
- **Template**
  - Offset 0: a tiny sparkle appears.
  - +2/3: a glass tile (66x100, r16, red rim) appears centred on the laptop, 50 px above the final pill.
  - The tile grows slowly to about 100x124.
  - Over 4–5 frames it morphs: it stretches horizontally into the 630x119 pill (r28) at 645,853–1275,972 and drops 50 px.
  - The sparkle pair rides the left end and shrinks to an icon.
  - Text comes in with blur and rise: opacity 0→1, y +12→0, blur 8→0, over 6 frames.
  - During the hold, red light beams ride the top edge (rightward) and the bottom edge (leftward), about 7 px per frame.
  - Glass ≈ rgba(207,186,182,0.40) with a backdrop blur of about 12–16 px.
- **Instances**
  - 0:32: tile f783, morph f793–797, text f821–826, hard cut-out at f844.
  - 3:58: tile f5718, morph f5726–5730; the text is visible in pink from the tile stage and whitens around f5735–5739; it ends on a cut at f5823.
  - 9:58: tile f14384, morph f14396–14400, text f14419–14423; the glass is dimmer; exit is a 4-frame blur-fade over f14515–14518.
- **SFX:** the sparkle shimmer lands at 0..+30 ms; the morph whoosh at +10 ms (medium).

### Hologram prompt window (f845–925)
- 1234x558 frosted panel at 343,100–1577,658, behind the presenter, with a pink-glow right edge and document text scrolling upward.
- **Entrance:** opacity 0.085→0.5→0.73→0.85→0.89→0.91→0.94 (f845–851), rising about 35 px.
- **Exit:** opacity 0.93→0.63→0.37→0.21→0.11→0.04→0 (f919–925), rising about 13 px.
- **Bezier fits:** in (0.27, 0.03, 0, 0.97), out (0.34, −0.02, 0.14, 0.79), residual ≤0.04.
- **SFX:** +10 ms.

### Outro Like thumb and Subscribe (f14645–14725)
- **Thumb outline** (white): scales 68→95 (+7%) then 89 over f14645–14651.
- **Fill** at f14652 (#FD0D60):
  - It squashes to 0.88, with a ring burst.
  - It pops to 1.11 with a tilt of about −12° (f14654–14656).
  - It settles at f14659.
- **Button:**
  - f14665–14666: it rises 15 px while fading in.
  - f14668: −2 px overshoot.
  - From f14679: the same state change as at 0:27.
- **Exit:** none of its own; the end-card wipe at f14721–14725 covers it.
- **SFX:** fill at +20 ms; click at +10 ms (high).

### Floating 9:16 ad cards (f205–284)
- Five cards in an arc: outer cards 345x678, inner cards 323x585, radius about 30, about 85–90% opaque. The centre card sits behind the presenter's head.
- The right cards arrive inside the carousel whip transition.
- The left cards slide in from off-screen left, ghosted at about 55% while moving:
  - L-inner: f216–229, with a tail to f241.
  - L-outer: f230–241.
  - Ease-out bezier (0.3, 0.67, 0.06, 1.12), residual rms 6 px (visual estimate).
- Hold drift is 0 px. Card content swaps by hard cut. The cards leave on the shot cut at f285.

### Callout-diagram card (f5034–5092)
- Card at 361,216–749,832.
- **Entrance:** a solid hot-pink silhouette fades in; the pink then dissolves into the content over f5036–5043. At the same time the card rises: the top moves 268→216 over 13 frames (bezier 0.46, 1.03, 0.84, 0.93, residual ≤1.2 px) and the bottom moves 853→832.
- The "CALLOUT DIAGRAM" label fades in over f5071–5073.
- **Exit:** hard cut at f5093.

### 7:44 "pop portal" cards (f11145–11294)
- Card B starts at f11145; card A at f11148 (+3 f).
- **Entrance:** each card begins edge-on as a thin hot-pink slab, swings open over about 6 frames, and the pink dissolves into the content over about 5 frames. Card A's left edge runs 284→275→256→231→211→199→192→186→184.
- **Exit:** a 3-frame fade, f11291–11294.

### 8:37 PAIN / RESULT / FREE LESSON (f12412–12654)
- The same portal swing-open as 7:44, without the pink, staggered 2 frames (f12412 / 12414 / 12416); everything is settled by f12422.
- **Label pattern:**
  - A magenta outline appears on the card 1 frame before its label.
  - The label fades in over 3 frames while settling down 3–5 px.
  - It holds for 17–24 frames.
  - It fades out in 1–2 frames.
  - The outline lingers about 6 frames longer.
- **Label timings:**
  - PAIN: f12500–12517.
  - RESULT: f12535–12559.
  - FREE LESSON: in from f12574 with a left-to-right reveal; it stays until the end.
- **Exit:** a 3-frame fade at f12651–12654.

### 8:54 info cards "01 DOCTOR / 02 EDUCATION / 03 DESIGNER" (f12827–12963)
- **Geometry:** three 515x220 cards with radius about 15, gaps of 36 px, at y 775–995, centred.
- **Style:** fill is a gradient from #240B26 (top-left) to #0A020B (bottom-right). A 1 px divider sits at y 850. The title is white monospace bold at about 47 px with a 56 px line pitch.
- **Card 2 recipe:**
  - f12855: a header strip slides in and holds 4 frames.
  - f12860–12871: the card unrolls downward with a +5 px overshoot (bezier 0.27, 0.14, 0.03, 1.25; residual ≤3 px).
  - f12865–12868: the header fades in.
  - f12877–12883: the divider draws left to right.
  - f12889–12894: the title blurs in, cued by the narration.
- **Card 1:** it fades in (0.24→1 over f12827–12833), and its title blurs in over f12832–12836.
- **Card 3:** strip f12910, unroll f12914–12925, title f12944–12948.
- **Exit:** a 6-frame fade with an upward collapse, titles first (f12957–12963).

## 2. Recipes (24 fps keyframes)
All of these are in `recipes_24fps` in the JSON, as `[offset, value]` lists:
- red_brand_pill_enter / exit
- subscribe_state_change
- logo_tile_pop
- pill_stretch_pop (handle)
- hop_and_pop_exit
- glass_cta_pill (LINK)
- glass_panel_rise_fade (hologram)
- portal_card_open
- pink_tint_reveal_rise (callout)
- info_card_unroll
- slide_in_from_offscreen (0:08 cards)
- fade_out_3f
- label_pop

**Bezier fits** (normalised progress; residual in measured units):

| curve | cubic-bezier | rms | max |
|---|---|---|---|
| red pill width (f610–628) | 0.49, 0.14, 0.05, 1.25 | 5.0 px | 7.8 px |
| red pill centre x | 0.29, 0.11, 0.13, 1.18 | 1.7 px | 3.9 px |
| Subscribed container widen | 0.53, 0.11, 0.32, 1.07 | 0.4 px | 0.9 px |
| logo tile size | 0.5, 1.58, 0, 0.92 | 2.2 px | 4.4 px |
| handle width | 0.4, 0.6, 0, 1.2 | **24 px (bad: two-bump spring, key per frame)** | 55 px |
| handle height | 0.68, 1.83, 0, 0.96 | 4.6 px | 10.9 px |
| thumb outline | 0.5, 1.87, 0.51, 1.29 | 0.4 px | 0.5 px |
| thumb fill pop | 0.45, 2.09, 0, 2.57 | 1.9 px | 3.4 px |
| hologram opacity in / out | 0.27, 0.03, 0, 0.97 / 0.34, −0.02, 0.14, 0.79 | 0.03 / 0.01 | 0.04 / 0.03 |
| info card unroll (2 / 3) | 0.27, 0.14, 0.03, 1.25 / 0.22, 0.17, 0.09, 1.26 | 1.4 / 2.2 px | 3.0 / 3.7 px |
| info card 1 opacity | 0, 0.13, 1, 1.06 | 0.02 | 0.04 |
| 0:08 card slide | 0.3, 0.67, 0.06, 1.12 | 6.0 px | 14.8 px |
| callout card rise | 0.46, 1.03, 0.84, 0.93 | 0.5 px | 1.2 px |

Damped-spring fits for the overshooting curves are in the JSON as `spring_fit`. Example: logo tile ω=0.825 rad/frame, ζ=0.63, which is roughly stiffness 392 and damping 24.8 at mass 1. Most of these fit no better than the beziers.

**Stagger rules:**
- Handle → logo: +2 f.
- Portal cards: +3 f at 7:44, +2 f at 8:37.
- Like outro: outline 0 → fill +7 → button +20 → cursor +34 → click +36.
- Info cards: driven by the narration (+28, +55 f).
- Labels: outline −1 f, then label, then outline-out at label-out +6 f.

## 3. Design

**Fonts**

| use | evidence | candidates | confidence |
|---|---|---|---|
| "LAST VIDEO", @handle, info-card titles and headers | Monospace: equal ~40 px advance at 51 px cap, including a serifed "I"; rectangular O/D; spur G; slab "1" | JetBrains Mono ExtraBold (best ratio match), Geist Mono Bold, Martian Mono SemiCondensed Bold | Medium |
| "Marketing" | Geometric heavy sans: double-storey a, single-storey g, angled t | Plus Jakarta Sans 800, Figtree 800, Manrope 800 | Medium-low |
| "LINK IN THE DESCRIPTION" | — | Inter 500 / Geist 500 | Medium |
| PAIN / RESULT labels | Proportional heavy caps | Inter or Montserrat 800 | Low |

**Sizes at 1080p:**
- Marketing about 52 px.
- Subscribe text about 32 px.
- LINK text about 33 px.
- LAST VIDEO about 70 px.
- Handle about 34 px.
- Info title about 47 px; info header about 19 px.

**Colours, geometry and positions:** these are under `colors` and per-instance `geometry` in the JSON, with bboxes in px and normalised to 0..1. Position rules:
- CTA pills: centred on the laptop, at y 0.79–0.90.
- Red pill in the wide shot: top-left (0.14–0.44 × 0.20–0.30).
- Lower-third elements: bottom corners at y ≈ 0.84.
- Ad cards: an arc filling 0.05–0.95 × 0.19–0.81.
- Info cards: 3 columns at y 0.72–0.92.

## 4. Confidence and what would change it
- **High:**
  - All event frame indices.
  - Per-frame bboxes from colour masks (±2 px).
  - Info-card bottoms (±1 px).
  - Hologram opacity (±0.03).
  - 0 px idle drift.
  - The identical Subscribe state-change timing.
- **Medium:**
  - Colours (±6 per channel on opaque fills; glass tint ±15).
  - Radii (±4 px).
  - Link morph boxes (visual reading, ±6 px).
  - Font class.
  - SFX values marked medium.
- **Low:**
  - 3D angles and the portal rotation curve (inferred from projected widths).
  - Most SFX offsets (voice-over masks the onsets).
  - Label font.
  - Hologram scale.
  - Edge-beam speed.
- **What would improve them:**
  - An SFX stem would fix the SFX offsets.
  - Per-frame corner-pin tracking would give exact perspective.
  - A higher-bitrate source would improve the glass colour solve.
  - Rendering the candidate fonts over the crops would settle the font families.
