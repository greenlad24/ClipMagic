# Sticker Shorts (Meme / commentary editor)

A stripped-down sibling of the short-form creator. It does exactly two things on
top of a narration:

1. **Popping captions** — reuses the existing viral caption system: the SAME
   2–3-word chunking guidelines as the short-form editor (`meme/captions.ts`
   mirrors `src/api/runPipeline.ts`'s "Hormozi" rules) and a caption template
   picked at RANDOM from the FULL short-form rotation pool
   (`SUBTITLE_TEMPLATE_POOL`) per render — the same rotation the short-form
   editor uses — then burned in via the ASS render path.
2. **Funny reaction stickers** — one static, transparent reaction sticker per
   emphasis beat, **fetched from the Giphy + Tenor sticker libraries**, passed
   through an **AI vision fit-review**, and **slapped on below the captions** via
   a Remotion composition, on average ~every 4s (content-driven, not a timer).
   OpenAI image-gen remains as an optional fallback source.

No b-roll, screencasts, stock, kinovi, or AI-generated video. `runPipeline` is
never touched.

- **Route:** `/meme` · **Hub tile:** "Sticker Shorts" (`lab/src/config/tools.ts`)
- **Page:** `lab/src/pages/MemePage.tsx` (upload → process → download, modeled on
  `CutterPage`).

## Pipeline (`lab/server/src/meme/`)

`createMeme` (endpoint) → `runMemePipeline` per item, processed one at a time:

1. **transcribe** — `ai/transcribe.ts` (Groq Whisper, word timestamps).
2. **captions** — `meme/captions.ts` chunks words into viral 2–3 word
   `SubtitleEvent`s (the existing render path burns them in).
3. **emphasis director** — `meme/director.ts` (Claude, Opus tier): picks the
   sticker moments + writes one short **reaction-sticker search query** each
   (e.g. "mind blown", "money rain"), plus a one-line `imagePrompt` kept only for
   the OpenAI fallback. `sanitize()` enforces, IN CODE, ~1 sticker / 4s density,
   ≥3s spacing, 1.5–2.5s holds, and head/tail buffers — restraint regardless of
   the model.
4. **sticker source: find → review → apply** (default = Giphy + Tenor):
   - `meme/stickerSearch.ts` queries BOTH Giphy stickers
     (`/v1/stickers/search`, the `*_still` transparent rendition) and Tenor
     (`/v2/search`, `searchfilter=sticker` + transparent static formats), merges
     the candidates, and downloads the chosen still under `data/outputs/stickers/`.
   - `meme/stickerReview.ts` is the **AI fit-review** quality gate: a vision call
     (reusing `ai/claude.ts` `claudeVisionLabeledJSON` → Claude vision with a Groq
     fallback) looks at the candidate stickers for the line and picks the best
     fit, or **drops** the sticker if none fit. Graceful: no vision key → take the
     top search result (review skipped), never block.
   - **OpenAI fallback** (`meme/imagegen.ts`): only when Giphy/Tenor return
     nothing (or have no keys) and an OpenAI key is present — one `gpt-image-1`
     still, cached by prompt. Source is configurable via `MEME_STICKER_SOURCE`
     (`giphy+tenor` default, or `openai`).
5. **render** — a normal `manifest` job carrying `emphasisStickers`. The render
   worker runs the **meme stage** (`meme/stage.ts`) after the captions render:
   it renders the Remotion `emphasis-sticker` composition to alpha and
   composites each sticker below the captions.

## Placement (the hard rule) — BELOW the captions

Captions burn in at screen **center**. The sticker box top is at
`STICKER_TOP_FRACTION = 0.60` of a 1080×1920 frame (lower third), sized to stay
clear of the bottom platform-UI safe margin. `meme/sticker.ts` is the single
source of truth for the geometry and exports `assertBelowCaptions()`, which is
asserted in `scripts/meme.test.ts`. The Remotion composition uses the same
fraction, verified end-to-end (a rendered sticker's content lands at y≈1200–1520,
below the caption zone bottom ≈1113).

## Sticker animation (Remotion `emphasis-sticker`)

`lab/remotion/src/compositions/EmphasisSticker.tsx`:
- **Enter:** overshooting spring (the "slap") — scales past 1.0 and settles.
- **Wiggle:** a damped sinusoid that decays to a small resting tilt (alternated
  −4°/+4° per sticker) so it reads as a physically slapped-on cut-out.
- **Hold** ~1.5–2.5s, then a quick scale-down + fade **exit**.
- **Sticker look:** white die-cut outline + soft drop shadow via stacked
  `drop-shadow` filters.

## Cost (Optimization Report)

Giphy + Tenor are **FREE** ($0/image — cited in `ai/pricing.ts`
`STICKER_LIBRARY_PER_IMAGE`), so the default source has **no per-image cost**.
The only per-sticker AI cost is the **vision fit-review**, priced from its real
Anthropic `usage` via `ANTHROPIC_RATES` (`sticker-review` purpose) and shown as
its own honest line. The OpenAI fallback's `gpt-image-1` is still priced
(`$0.04`/image, cited) and only appears on runs that used it. The report shows
this editor's **actual** breakdown — transcription + emphasis director + sticker
fit-review (+ any fallback images) + sticker render compute — as honest added
cost (`kind: "quality-investment"`, `savedUsd: 0`). It does **not** fabricate a
"savings vs main app" comparison (the main app has no sticker feature).

## Graceful fallbacks

- No Groq key → clear error (can't caption without a transcript).
- No Claude → captions only (no stickers — the director is unconfigured).
- No Giphy/Tenor keys AND no OpenAI key → captions only with a reason asking for
  keys. With Giphy/Tenor but no vision key → stickers still apply (fit-review is
  skipped, top search result used). With no library result for a moment but an
  OpenAI key present → OpenAI fallback fills that moment.
- No Chromium / Remotion → captions only (the meme stage no-ops; uses the motion
  service's FLAG-FREE runtime probe `remotionRuntimeAvailable()`).
Any of these leaves a valid captions-only vertical render — never a crash. Every
fallback is OBSERVABLE: the reason (e.g. "no image key", "Chromium unavailable",
"sticker composite failed") is logged, persisted on the meme record
(`stickerSkipReason`), and shown on the page under a captions-only result.

## NOT gated by MOTION_GRAPHICS (the bug fix)

Stickers are the entire point of this tool, so the sticker stage runs whenever
Chromium + an image are available — it does NOT consult `config.motionGraphicsEnabled`
(`MOTION_GRAPHICS=1`). That flag only gates the SHORT-FORM director's motion
graphics. `motion/render.ts` splits the two: `remotionRuntimeAvailable()` is the
flag-free runtime probe (used by the meme stage); `motionAvailable()` is the
probe AND the flag (used only by the short-form motion stage).

## Sticker alpha codec — ProRes 4444 (not VP8 WebM)

The rendered sticker clip is composited over the finished video, so its
background MUST be transparent. Remotion 4.0's VP8/VP9 WebM-alpha path silently
emits an OPAQUE `yuv420p` clip (no alpha) on this stack, which blacks out the
whole base frame when overlaid. The meme stage therefore defaults to ProRes 4444
(`yuva444p10le` .mov), which reliably carries alpha (verified by frame inspection
here). Override with `MEME_CODEC` / `MOTION_CODEC` on a server with a fixed WebM
path. The clip is short and deleted right after compositing, so the larger ProRes
bytes are negligible.

## Verified here vs. needs a live server run

**Verified in this environment (no keys):**
- Builds: server `tsc`, web `vite build`, lab serves on :9090.
- Hub tile + `/meme` route render; `createMeme` / `getMemeRun` / `getMemeProjects`
  endpoints respond; full create→process→error lifecycle (graceful, no crash).
- `meme.test.ts` (10 checks): director density/spacing/hold/buffer sanitize,
  caption chunking, and sticker placement below captions.
- Remotion `emphasis-sticker` bundles and renders a still **and** a ProRes-alpha
  clip; the sticker image loads (http URL) and lands below the caption zone.
- **Full end-to-end sticker proof** (`scripts/meme-e2e.ts`, no keys needed): a
  synthesized base video + placeholder PNG → the REAL meme stage composites an
  animated sticker BELOW the caption zone WITHOUT `MOTION_GRAPHICS`. Asserts via
  frame diffs that the sticker is visible, the base video is preserved (no
  black-out), and the sticker ANIMATES (region color changes across the window).
- Report math (`verify-report-math.ts`) and the image-gen cost line stay honest.

**Needs a live-key + Chromium server run:**
- Real Groq transcription, real Claude emphasis-moment selection on a real
  transcript, real `gpt-image-1` generation, and the real headless-Chromium
  sticker composite onto a finished video.

## Deferred polish (intentionally out of scope here)

- A `MEME_IMAGE_MODEL` toggle in the UI (currently env-driven; `gpt-image-1` →
  `dall-e-3` fallback both priced).
- Per-project Optimization Report panel on the meme page (the report is built +
  persisted on the meme record; the page currently shows sticker/moment counts).
- A "sticker density" control (gentle/punchy) like the cutter's strength toggle.
- Re-roll / hide individual stickers before final render.
