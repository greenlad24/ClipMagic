# ClipMagic Improvement Plan

Scope: the **lab** copy only (`lab/src`, `lab/server`, port 9090). Two goals:
**A. Performance / speed / cost** and **B. Quality of every feature (AI Director,
subtitles, Bulk, Cutter)**. Grounded in 2025-2026 best practices (sources at end).

The lab has **no AI keys** (GROQ / ANTHROPIC / KINOVI = NO), so live model calls
can't be exercised end-to-end. Everything is verified by build, type-check,
targeted logic checks, and code review; items needing a key are flagged.

---

## Pipeline inventory (where the money and the quality live)

**Main app pipeline** (one short video):
1. `runPipeline` (`lab/src/api/runPipeline.ts`) — transcribe (Groq) → subtitle
   grouping → **emphasis call** (`gpt-4o-mini`) → **URL-research call** (`gpt-4o`)
   → **director/beat-planner call** (`gpt-4o`/Opus) → deterministic pacing guards
   → write shots. **3 LLM calls, all sequential.**
2. `captureShots` (`lab/src/api/captureShots.ts`) — per shot, for screencasts:
   `matchPromoForScreencast` (1 call) + `matchBestSegment` (1 call); for b-roll:
   `buildContextualStockQuery` (1 call) + `buildTacticalPrompt` (1 call). A
   10-shot video → **~15-40 sequential LLM calls.** This is the #1 cost hotspot.
3. Render (`lab/server/src/render/*`) — one ffmpeg `filter_complex` per video
   (good), but `ass.ts` `measureText` spawns **2-3 ffmpeg processes per caption**
   (~30-90 extra process spawns per video) — the #1 render-time hotspot.

**Bulk** (`/bulk`) — same per-video pipeline at scale; render queue drains via
the SQLite worker pool (`worker.ts`, `RENDER_CONCURRENCY`).

**Cutter** (`/cutter`) — transcribe (Groq) → `planTakeDecision` (Claude +
vision + `volumedetect`) → `planCuts` (deterministic) → one ffmpeg cut job.
Runs videos strictly **one at a time**.

---

## Goal A — Performance / speed / cost (prioritized)

| # | Change | Where | Expected win | Effort |
|---|--------|-------|--------------|--------|
| A1 | **Cache `measureText` results** within a render (memoize by text+font+size). Captions repeat phrases/measure a fixed line-height reference every event. | `ass.ts` | ~30-90 ffmpeg spawns → ~5-15 per video; meaningfully faster caption builds | S ✅ done |
| A2 | **Fold subtitle emphasis into the director call** (the director already reads the whole transcript). Removes one whole `gpt-4o-mini` round-trip per video; keep the standalone call as a fallback only. | `runPipeline.ts` | N→N-1 LLM calls/video on the happy path; emphasis is also *smarter* (director-chosen) | S ✅ done (emphasis now derived from director output, standalone call only as fallback) |
| A3 | **Combine promo file-match + segment-match into ONE call** per screencast shot. Today it's 2 sequential calls; the pool list + segment list fit in one prompt. | `tacticalBroll.ts` | Halves screencast retrieval calls (e.g. 6 calls → 3 on a 3-screencast video) | M (documented; not landed — needs live-key A/B, see Risks) |
| A4 | **Stream-copy the Cutter render when there's a single keep-segment** (no real cuts) instead of re-encoding. | `cut.ts` | Skips a full libx264 pass on untouched clips | S (deferred — most cuts have many segments; low hit rate) |
| A5 | **Add prompt-caching headers already present** — verify `cache_control` on the big director/system prompts (already done in `claude.ts`). Document the 90% repeat-input discount. | `claude.ts` | Up to ~90% off repeated system-prompt input tokens | ✅ already in place |
| A6 | Document `RENDER_CONCURRENCY` tuning (defaults to vCPU count; correct). | plan | Operator guidance | ✅ doc only |

## Goal B — Quality (prioritized)

### B-Director (`runPipeline.ts`)
| # | Change | Expected behavior change |
|---|--------|--------------------------|
| D1 | **Smarter emphasis from the director** (ties to A2): emphasis words chosen by the model that understands the whole script, not a generic 15-25% heuristic. | Emphasis lands on the actually-important words. ✅ done |
| D2 | Motivated-zoom polish: keep restraint guidance (already strong). No change — current intensity→keyframe mapping is tasteful. | — (reviewed, left as-is) |

### B-Subtitles (`ass.ts`, `runPipeline.ts`, `manifest.ts`)
| # | Change | Before → After |
|---|--------|----------------|
| S1 | **Profanity masking** (optional, on by default for safe captions): mask f/s-words etc. as `f***` in the burned-in text while keeping audio intact. | Raw swear words on screen → masked, brand-safe captions. ✅ done |
| S2 | **Reading-speed (CPS) floor**: guarantee each caption stays on screen long enough to read (≈ chars/17 CPS, min 0.5s) and never overlaps the next. | Fast captions that flash too briefly → readable minimum dwell. ✅ done |
| S3 | **Casing/punctuation normalization** for caption text (collapse stray spaces, fix lone-letter artifacts, strip trailing commas on a chunk). | Mis-cased / comma-dangling chunks → clean. ✅ done |
| S4 | **More viral presets** — add Hormozi-style **green-pop** and **active-word scale-pop** karaoke (true per-word size bump), plus a clean **white-bold-bottom** preset. Wire into the rotation pool + the template registry. | 4 presets → 7, including a true active-word *scale* pop (current karaoke only recolors). ✅ done |

### B-Cutter (`plan.ts`, `takes.ts`)
| # | Change | Before → After |
|---|--------|----------------|
| C1 | **Expand filler list** (current "um/uh" only) to include common doubled-word stutters and "uh"-class variants already partly covered — add `mmm`, `hmm` guarded so real words aren't cut. | Leaves "mm"/"hmm" hesitations in → trims them too (still conservative; never touches so/like/you-know). ✅ done |
| C2 | Document the one-at-a-time cutter design (intentional, gentle on APIs). | — (doc) |

---

## What I deliberately did NOT do (and why)
- **A3 (merge match calls) — not landed.** It halves cost but changes retrieval
  behavior; with no live keys I can't A/B the merged prompt's match quality
  against the current two-step. Documented as the highest-value next step.
- **No new design system / parallel styles.** New presets reuse the existing
  `SubtitleStyle` contract and ASS renderer.
- **No speculative b-roll/transition engine rewrite.** The director's pacing
  guards are already extensive and tasteful; I improved emphasis + subtitles
  (higher leverage, lower risk) instead of churning the beat planner.

## Verification
- `cd lab/server && npm run build` (tsc + esbuild bundle) green after each slice.
- `bash lab/run-lab.sh` serves on :9090.
- Logic checks: small node scripts exercising the new pure helpers
  (CPS clamp, profanity mask, caption normalize, measureText cache).

## Needs live keys to fully verify
- A2/D1 emphasis-from-director: needs ANTHROPIC to see real director JSON.
- A3 if landed later: needs ANTHROPIC for match-quality A/B.
- Cutter C1: needs GROQ transcription to see real filler tokens.

## Sources (2025-2026 best practices)
- Hormozi/word-by-word karaoke, color, position, highlight-lead timing:
  OpusClip, Karadeo, Ascynd, Blitzcut.
- Reading speed: 17 CPS broadcast standard, ≥0.83s min event (Netflix), 12-17 CPS
  optimal: Amara.org, Happy Scribe, Subtitling.net.
- Anthropic prompt caching (90% off cached input) / batch (50%): Anthropic API
  docs + Finout pricing guide.
- AI-edit realism / pattern-interrupt pacing / "AI slop": OpusClip, Cutback,
  Storimatic.
