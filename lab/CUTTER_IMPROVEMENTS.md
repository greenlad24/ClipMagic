# Narration Cutter — Improvement Plan (4 axes: accuracy · speed · cost · edit quality)

Scope: everything under `lab/` only. Ports/data isolated (`:9090`, `lab/data`).

## Current pipeline (mapped, with file:line)

`runOneCut` in `lab/server/src/zite/endpoints.ts:865` drives one clip:
1. `extractAudioForTranscription` (`render/cut.ts:76`) → mono 16k MP3.
2. `transcribeWithGroq` (`ai/transcribe.ts:27`) → word timestamps. (1 call/clip.)
3. `planTakeDecision` (`cutter/takes.ts:187`) → duplicate-take detection
   (Claude grouping + per-take ffmpeg `volumedetect` + per-take vision frame).
4. `planCuts` (`cutter/plan.ts:98`) → silence + filler cut plan, `extraCuts`
   = the losing takes.
5. `createJob({kind:"cut"})` → `buildCutArgs` (`render/cut.ts:28`) ffmpeg
   trim+`concat` → one MP4. Worker at `render/worker.ts:55`.

### Gaps found

**Accuracy**
- `plan.ts:103` uses ONE threshold (word-gap > 0.35s) with NO minimum silence
  duration → trims natural mid-sentence micro-pauses. Research consensus is a
  *minimum silence length* ~0.5–0.75s, separate from the trigger.
- `keepPad` default **0.08s** (`plan.ts:104`) is below the 0.15–0.25s/side pros
  use → clips word onsets/tails and swallows breaths abruptly.
- No detection of **false starts / stutters / immediate word repeats**
  ("I-I-I", "the the", "we we went") — only um/uh-family fillers.
- Silence decided purely from Whisper word gaps; Whisper word `end` is often
  loose, so cut boundaries drift.

**Speed**
- `takes.ts:204` measures each take's volume **serially**; `scoreGroupVision`
  (`takes.ts:145`) extracts each frame **serially**. Embarrassingly parallel.
- Take-detection runs even when there's clearly no repetition to find.

**Cost**
- `takes.ts:75` sends `model:"gpt-4o"` with a "meticulous video editor" prompt.
  `resolveTier` (`claude.ts:52`) does NOT match it as director → it silently
  runs on **Sonnet** and is mis-attributed as **`url-research`** in the report
  (`claude.ts:85`). Take grouping is structured extraction → **Haiku** is the
  right tier (1/3 the input, 1/3 the output price of Sonnet).
- No cutter line items in the Optimization Report at all — cutter cost/speed is
  invisible.

**Edit quality**
- `buildCutArgs` (`render/cut.ts:47`) hard-`concat`s segments → an audible
  **click/pop at every junction** (cuts almost never land on a zero crossing).
  Pros apply ≥1ms micro-fades / short crossfades at every splice.
- Fillers cut with a fixed 0.06s tail (`plan.ts:153`) regardless of context.

## Prioritized changes (impact ÷ effort)

| # | Change | Axis | Impact | Effort |
|---|--------|------|--------|--------|
| 1 | Micro-fade every audio splice in `buildCutArgs` (afade in/out ~8ms) | quality | High | Low |
| 2 | Min-silence-duration + larger, asymmetric keep pad; keep a natural pause stub instead of butt-joining | accuracy+quality | High | Low |
| 3 | Detect immediate word-repeat false starts / stutters (deterministic, conservative) | accuracy | High | Med |
| 4 | Route take-grouping to **Haiku** + correct purpose; skip the call when no near-duplicate spans exist (cheap pre-filter) | cost+speed | High | Low |
| 5 | Parallelize per-take `volumedetect` + frame extraction | speed | Med | Low |
| 6 | Cutter line items in the Optimization Report (real measured calls) | honesty | Med | Low |
| 7 | Expose conservative, tunable options (keep the so/like/you-know guarantee; stutter removal default ON but bounded) | accuracy | Med | Low |

Deferred (documented below): dBFS-based boundary refinement via a second ffmpeg
`silencedetect` pass (adds a pass — net speed cost), and overlap crossfades
across kept segments (risky on video sync; micro-fade gets ~95% of the win).

## Verification plan
- Unit fixtures for `planCuts` (silence min-duration, pad, stutter repeats,
  the so/like/you-know guarantee) and for the new stutter detector — run with
  `tsx`, asserting exact keep segments.
- Real ffmpeg trim on a synthesized clip to prove `buildCutArgs` + micro-fade
  produce a valid, click-free MP4 (ffprobe duration check).
- AI-dependent paths (transcription, take grouping, vision) need a live-key
  server run — flagged, not faked (no keys in this container).
</content>
</invoke>
