# Sticker Shorts (Meme / commentary editor)

A stripped-down sibling of the short-form creator. It does exactly two things on
top of a narration:

1. **Popping captions** — reuses the existing viral caption system (the
   `pop-scale` template: recolor + per-word size pop) and the burned-in ASS
   render path.
2. **Funny AI sticker stills** — one static, meme-style image per emphasis beat,
   generated on the fly and **slapped on as a STICKER below the captions** via a
   Remotion composition, on average ~every 4s (content-driven, not a timer).

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
   sticker moments + writes one image prompt each. `sanitize()` enforces, IN
   CODE, ~1 sticker / 4s density, ≥3s spacing, 1.5–2.5s holds, and head/tail
   buffers — restraint regardless of the model.
4. **image generation** — `meme/imagegen.ts`: one still per moment via OpenAI
   Images (`gpt-image-1`, transparent PNG), bounded concurrency, **cached by
   prompt** under `data/outputs/stickers/`.
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

`gpt-image-1` is priced in `ai/pricing.ts` (`$0.04`/image, 1024², transparent,
cited). The report shows this editor's **actual** breakdown — transcription +
emphasis director + N images + sticker render compute — as honest added cost
(`kind: "quality-investment"`, `savedUsd: 0`). It does **not** fabricate a
"savings vs main app" comparison (the main app has no sticker feature).

## Graceful fallbacks

- No Groq key → clear error (can't caption without a transcript).
- No Claude → captions only (no stickers).
- No image token / no credit → captions only.
- No Chromium / Remotion → captions only (the meme stage no-ops; reuses the
  motion service's availability probe).
Any of these leaves a valid captions-only vertical render — never a crash.

## Verified here vs. needs a live server run

**Verified in this environment (no keys):**
- Builds: server `tsc`, web `vite build`, lab serves on :9090.
- Hub tile + `/meme` route render; `createMeme` / `getMemeRun` / `getMemeProjects`
  endpoints respond; full create→process→error lifecycle (graceful, no crash).
- `meme.test.ts` (10 checks): director density/spacing/hold/buffer sanitize,
  caption chunking, and sticker placement below captions.
- Remotion `emphasis-sticker` bundles and renders a still **and** a WebM alpha
  clip; the sticker image loads (http URL) and lands below the caption zone.
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
