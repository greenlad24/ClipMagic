# Motion graphics (Remotion) — design, status, and plan

A flag-gated service that lets the AI director composite **tasteful, human-grade
motion graphics** onto the finished render. Built to look like a skilled editor
made it — sparing, motivated, professionally eased — not auto-generated.

Everything below is inside `lab/` and runs on `:9090`. The feature is **off by
default** (`MOTION_GRAPHICS=1` to enable) and **falls back to a normal render**
whenever Remotion/Chromium is unavailable, the flag is off, or nothing is
motivated — zero regression to the existing pipeline.

---

## Architecture

```
submitRendiJob (server/src/zite/endpoints.ts)
  └─ if MOTION_GRAPHICS=1: planMotionGraphics(transcript, duration, beats)   ← director
       → manifest.motionGraphics: MotionGraphicClip[]
  └─ createJob(kind:"manifest", manifest)

render worker (server/src/render/worker.ts)
  └─ main ffmpeg render → abs (unchanged path)
  └─ if MOTION_GRAPHICS=1 && manifest.motionGraphics.length:
       applyMotionGraphics(abs, clips, duration)            ← stage.ts
         ├─ renderMotionGraphics(clips)                     ← render.ts (Remotion SSR → alpha clips)
         │     bundle() [cached] → selectComposition() → renderMedia(codec vp8, yuva420p)
         └─ compositeMotionGraphics(base, alphaClips)       ← composite.ts (2nd ffmpeg pass: overlay+enable)
       → atomically replace abs with the composited file
  └─ completeJob + mergeRenderStats(... motionGraphicsSpawns) ← honest compute in Optimization Report
```

### Files

| File | Role |
|---|---|
| `lab/remotion/src/theme.ts` | Brand tokens, 9:16 safe margins, easing/spring/count-up helpers (the craft layer) |
| `lab/remotion/src/compositions/LowerThird.tsx` | Name + title tag |
| `lab/remotion/src/compositions/StatCallout.tsx` | Eased count-up number callout |
| `lab/remotion/src/compositions/SectionCard.tsx` | Section / chapter-turn title card |
| `lab/remotion/src/Root.tsx` / `index.ts` | Registers compositions; duration is data-driven via `calculateMetadata` |
| `lab/remotion/src/loadFonts.ts` | Loads the same Montserrat faces the captions use |
| `lab/server/src/motion/director.ts` | Claude pass that decides which graphics & when, + hard restraint guards |
| `lab/server/src/motion/render.ts` | Remotion SSR → alpha clips; availability probe; bundle cache; concurrency semaphore |
| `lab/server/src/motion/composite.ts` | 2nd ffmpeg pass overlaying alpha clips at director times |
| `lab/server/src/motion/stage.ts` | Orchestrates render+composite+cleanup; always best-effort |
| `lab/server/src/render/manifest.ts` | `MotionGraphicClip` type + `manifest.motionGraphics` |
| `lab/server/src/config.ts` | Flag + concurrency bounds + bundle/entry paths |
| `lab/Dockerfile` | Remotion build stage + Chromium system libs |
| `lab/run-lab.sh` | One-time Remotion install when `MOTION_GRAPHICS=1` |

---

## Compositions built (vertical slice)

Three high-craft compositions, chosen because they are the graphics top short-form
editors actually use and that earn their place:

1. **lower-third** — name + role, anchored to the safe bottom (above the caption
   zone). Accent bar wipes from the left, then text rises+fades in behind it
   (staggered, motivated). Title is tracked-out uppercase; name is ExtraBold.
2. **stat-callout** — one hero number with an **eased count-up** (cubic-out, lands
   and holds), units in prefix/suffix, locale-formatted. Upper-third so it never
   collides with center captions.
3. **section-card** — a chapter turn at a genuine topic shift: kicker → hairline →
   **mask-reveal** title, three staggered steps.

### What makes them read as human (not auto-generated)

- **Same typography as the video** — Montserrat ExtraBold + the exact caption
  palette (yellow/white/green), so a graphic never looks like a foreign template.
- **Real 9:16 safe margins** — sides clear the engagement rail, bottom clears the
  caption/CTA stack. Nothing important leaves SAFE.
- **One easing vocabulary** — spring entrances that *settle* (no wobble), exits
  that are **faster** than entrances (let it leave), **no bounce/elastic** (the
  cheesy tell). Count-ups decelerate and finish before the exit.
- **Staggering** — elements arrive in sequence, not all-at-once. Biggest human tell.
- **Restraint, enforced in code** (see director below).

---

## Director: placement + how it stays sparing

`planMotionGraphics` (a focused, prompt-cached Claude call, research tier) reads the
transcript + duration + coarse beat windows and returns `{ graphics: [...] }`. The
system prompt is explicit: ~2–4 graphics for 60s, 1–2 for 30s, **zero is a valid
answer**, each must be literally motivated by the transcript (a named person → lower
third; a stated number → stat callout; a real topic turn → section card).

Taste is then **guaranteed in code** by `sanitize()`, independent of what the model
returns:
- Density cap `~1 per 18s` (`maxGraphicsFor`), hard max 5.
- Drop any graphic that overlaps a kept one (never two at once; needs a ≥0.4s gap).
- Clamp every hold to **2.0–3.0s**.
- Enforce a **1.0s head** and **1.5s tail** buffer (hook breathes, CTA lands clean).
- `stat-callout` requires a real numeric `value`; lower-third needs a name; section
  card needs a title — else dropped.

---

## Infra, flag, concurrency, fallback

- **Flag:** `MOTION_GRAPHICS=1`. Off → director never runs, manifest has no
  `motionGraphics`, render is byte-identical to before.
- **Concurrency bounds (4 vCPU / 8 GB droplet, shared with ffmpeg + main app):**
  - `MOTION_CONCURRENCY=1` — at most one headless-Chromium render at a time
    (process-wide semaphore in `render.ts`).
  - `MOTION_CHROMIUM_CONCURRENCY=2` — tabs/threads per Remotion render.
- **Graceful fallback at every layer:** `motionAvailable()` probes `ensureBrowser`
  once and caches false on any failure; `renderMotionGraphics` returns `[]` if the
  bundle or browser is missing; `compositeMotionGraphics` returns the untouched base
  video on any ffmpeg error; the worker only replaces the output on success. A
  missing Anthropic key makes the director return `[]`.
- **Alpha format:** VP8 WebM + `yuva420p` (composites cleanly via ffmpeg `overlay`,
  far lighter than ProRes 4444). `MOTION_CODEC=prores` switches to ProRes 4444
  (`yuva444p10le`, `.mov`) for a server that prefers it.
- **Docker:** dedicated `motion` build stage installs `@remotion/*`; runtime adds the
  Chromium system libs (`libnss3`, `libgbm1`, …). Remotion downloads its own Chromium
  on first render into `/data/.remotion-chromium`. Image still builds and runs with
  the flag off (Chromium simply never launches).
- **Optimization Report:** the composite pass reports its extra ffmpeg spawns +
  per-graphic Chromium render honestly in the **speed/compute** section as *added
  compute*, never as a cost saving (`mergeRenderStats({ motionGraphicsSpawns })`).

---

## Verified vs. needs a server run (keys + Chromium)

**Verified in this container:**
- `lab/server` typechecks and builds green; full `run-lab.sh` builds and serves on
  `:9090` with the flag **off** — no regression, no motion activity, `/health` ok.
- Graceful fallback with the flag **on** and Remotion absent: `motionAvailable()`
  → false, `renderMotionGraphics` → `[]`, `planMotionGraphics` (no key) → `[]`.
- The **ffmpeg compositing pass** on a real alpha WebM: alpha transparency
  composites correctly and the `enable=between(t,…)` window gates visibility
  (graphic present at t=2s, absent at t=0.5s) — confirmed by extracted frames.
- Director restraint guards present in the compiled output.

**Needs a server run with keys + Chromium (could not run here — no network/keys):**
- A real Remotion render (`bundle` + `renderMedia`) producing an alpha clip, and a
  Remotion **still** for visual QA of each composition's craft.
- An end-to-end `submitRendiJob` with `MOTION_GRAPHICS=1` + `ANTHROPIC_API_KEY` to
  confirm the director's live placement on a real transcript.
- Docker image build (apt + npm install need network).

---

## Deferred work / next improvements

1. **Visual QA pass** of the three compositions on the server (Remotion still →
   eyeball safe margins, font load, easing) and tune any spacing/sizes.
2. **More compositions** when motivated by content: subtle highlight pop-on /
   emphasis tag (key phrase), a clean L→R wipe transition at hard section cuts,
   a progress/“N of M” chip for listicles. Build only if they earn their place.
3. **Beat-snapping:** align graphic enter/exit to the same musical downbeats the
   subtitle/cut snapper already computes, for tighter “cut to the beat” timing.
4. **Per-project pin/override** in the editor UI (a “motion graphics: auto / off /
   force” toggle) once the auto behavior is validated.
5. **Word-level timing for stat-callouts:** key the count-up start to the exact
   word the number is spoken (using the subtitle word timings already in the
   manifest) instead of the director's coarse start time.
6. **Frontend manifest parity:** mirror `MotionGraphicClip` into
   `lab/src/utils/renderManifest.ts` if/when the in-browser preview should show
   graphics (server render is the source of truth today).
```
