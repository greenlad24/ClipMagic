# Avatar Narrator

Narration videos of a synthetic presenter. One locked portrait plus TTS, driven
through a video model, to produce a talking head that says your script verbatim
in the same voice and the same face every time.

Extracted from a larger internal tool (“the lab”) so it can be worked on alone.
The avatar code itself is unchanged; everything around it — auth, the shared
database, fourteen other tools — was left behind.

---

## Why it is built this way

The obvious approach is a text-to-video model. It is the wrong model class for
this job, and expensively so.

| Approach | Cost per finished minute | Notes |
|---|---|---|
| Self-hosted InfiniteTalk (rented GPU) | **~$0.30** | Break-even vs hosted at ~150 min/month |
| kie.ai InfiniteTalk 480p | ~$0.90 | |
| kie.ai / WaveSpeed InfiniteTalk 720p | **~$3.60** | The sweet spot |
| Segmind Seedance 2.5 720p | ~$14.30 | 480p is ~$6.40 |
| kie.ai Seedance 2.5 720p | ~$18.90 | |
| OmniHuman 1.5 (native 1080p) | $8.40–9.60 | |
| Kling Avatar | ~$12 | |
| Raw Seedance-class text-to-video | **~$28** | 720p max, ≤30s clips, no control of exact wording, no voice continuity |

Audio-driven **lipsync** is a fundamentally cheaper problem than generating
video from a text prompt, and it is the only one of the two that guarantees the
presenter says exactly what you wrote. That is the whole thesis of this tool.

Two engine classes are wired, and the UI lets you pick per render:

- **lipsync** — `kie` / `wavespeed` / `selfhost`, all running InfiniteTalk.
  Animates your actual portrait from the narration audio.
- **generative** — `segmind` / `seedance`, both Seedance 2.5. Takes the portrait
  as a reference and generates a presenter.

`segmind` is the default because it was the first key available, **not** because
it is the cheapest — it is roughly 4× the cost of InfiniteTalk at the same
resolution. If cost matters, add a `KIE_API_KEY` and select an InfiniteTalk
provider.

Two levers noted in the code and deliberately **not** pulled yet:

1. `generate_audio: false` is already set — the API defaults it to `true` and
   bills for audio this tool never uses.
2. Supplying a reference **video** instead of a portrait drops Segmind ~40%
   ($0.1065 → $0.0637/s at 480p) *and* should tighten face consistency across
   the 30s-capped chunks.

---

## Running it

Requires Node 22+ and `ffmpeg`/`ffprobe` on PATH (used to convert the PCM that
Gemini TTS returns into mp3, measure narration length, and concatenate the
rendered segments).

```bash
cp .env.example .env      # then fill in GEMINI_API_KEY at minimum
cd server && npm install && npm run dev     # API on :8080
cd web    && npm install && npm run dev     # UI on :5173, proxies /api to :8080
```

Or the whole thing in one container:

```bash
docker build -t avatar-narrator .
docker run -p 8080:8080 -v $PWD/data:/data --env-file .env avatar-narrator
```

### PUBLIC_BASE_URL is not optional for rendering

The render providers fetch the portrait and the narration audio **themselves**,
by URL, using their own HTTP client. They cannot reach `localhost`. So
`PUBLIC_BASE_URL` must be a publicly reachable origin for this server before any
video can render — a `cloudflared` or `ngrok` tunnel is fine for local work.

Portraits, character sheets and voices all work without it. Only video breaks,
and the server warns about this at boot.

---

## How it works

A **persona** is the reusable half: one locked-in synthetic face, the voice, and
the prompt that keeps every video looking like the same person. A **video** is
one narration run against a persona. **Segments** exist because a run splits
into several provider jobs — they carry per-job cost and clips, so a partial
failure is resumable and spend is auditable per clip.

```
script ──► TTS (Gemini / ElevenLabs / Segmind)  ──► narration mp3
                                                       │
persona portrait ──┐                                   │
room plate ────────┼──► publish as capability URLs ◄────┘
                   │              │
                   │              ▼
                   └──►  provider (InfiniteTalk / Seedance), one job per segment
                                  │
                                  ▼
                          download clips ──► ffmpeg concat ──► finished mp4
```

### Two things that are load-bearing and non-obvious

**1. `/public-assets/<32-hex-token>/` is a deliberate hole.** It exists because
the providers fetch inputs with their own client, which has no session. The
protection is unguessability (128 bits) plus a 24h TTL sweep, not
authentication. **Only ever put provider inputs there** — a portrait and a TTS
clip that are about to become a public video anyway.

**2. Wall time is ~20s per 1s of 720p video.** A 3-minute continuous render is
about an hour, so run state lives in SQLite and `resumeInterrupted()` re-attaches
to provider jobs after a restart rather than abandoning renders that have
already been paid for. Fast mode (parallel chunks) is ~4× quicker but pays a 5s
billing minimum per job and shows seams.

---

## Where output quality actually lives

Not in the render call — in the prompts. `avatar/look.ts`, `avatar/rooms.ts` and
`avatar/characterSheet.ts` are the interesting files, and most of what is in
them was learned by generating images and looking at the results.

**What makes a person read as *in* a room** — name all four or the model drops
them: **foreground** occlusion between lens and subject, **layers** (subject off
the wall), **motivation** (a practical visible in shot that explains the key),
and a **contact** shadow.

**A rim light asked for gently does not arrive.** A dark subject then merges
into a dark room, which is the cutout failure by the opposite route. It has to
be demanded as a bright distinct edge plus an explicit exposure relationship.
Equally, "an unlit shot" and "a shot with no edge light" are different
instructions — models add a rim unprompted, so the no-rim rule is written as an
explicit negative.

**Naming real gear is self-consistent prompting.** A Super 35 sensor behind an
f/2.8 zoom *cannot* dissolve the background the way a fast full-frame prime
does, so the room survives being described.

**A wide framing in 9:16 walks the face out of resolution** — fatal, because the
video model has to animate that face. The framing carries a floor of roughly
head ≈ 1/5 frame height.

### The character sheet, in one line

A persona is ONE photograph, so a new room forces the model to invent every
angle it cannot see — and inventing is where the face drifts into someone else.
`generateCharacterSheet()` makes a 5×4 grid of 20 head/shoulders views (mouth
closed in every cell — a sheet of open mouths teaches the placement step to make
one), and `placeInRoom()` passes **two images where the order is the contract**:
image 1 is identity, image 2 is the room.

The specific trap: the sheet's white background is the most dominant thing in
image 1, so the prompt must say *"take NOTHING else from it — not its white
background, not its grid, not its flat studio lighting"*, or the room gets
thrown away.

### Room plates

`ROOM_PLATES` in `avatar/rooms.ts` declares four fixed sets. **This repo ships
the code but not the plate images**, so all four report `ready: false` and the
UI greys them out — a missing plate degrades to a text-described room rather
than failing.

To enable one, put its PNG at `data/avatar/reference/<file>.png` using the
filename declared in `ROOM_PLATES`. The originals were empty-room plates built
with Nano Banana Pro from reference video frames, with the person removed. Two
lessons from making them, each of which cost a generation:

- *"Remove and reconstruct"* lets the model rebuild the whole room and push the
  seat into the distance. **Naming what REPLACES the person, at the same size
  and position, holds the geometry.**
- A second pass **editing the plate** with a one-change instruction drifts far
  less than re-rolling from the source.

---

## Layout

```
server/src/
  avatar/          the tool. types · providers · tts · portrait · look
                   · rooms · characterSheet · publicAssets · pipeline
  zite/handlers.ts the 22 endpoints the UI calls
  db/              SQLite: avatar_personas / avatar_videos / avatar_segments
  imagechat/       Gemini image generation (Nano Banana / Pro)
  settings/        API keys, read from the environment. Server-only, never
                   returned in a response — the UI gets booleans.
web/src/
  pages/AvatarNarratorPage.tsx     the whole UI
  components/avatar/               PersonaBuilder · VoiceStudio · RoomStudio
  shims/endpoints.ts               typed client for the 22 endpoints
```

`npm test` in `server/` runs 67 unit tests, most of them asserting properties of
the generated prompts — that the negative prompt is always present, that a
capture medium reaches the portrait prompt, that the room is pinned before the
person. They are fast and need no API keys.

---

## Status

Verified: both halves typecheck, 67/67 tests pass, the server boots, migrates
and answers, and portrait generation is live-verified against Segmind and Nano
Banana Pro.

**A full end-to-end video render has never been verified.** It needs a funded
provider key and a public origin, and it is the obvious first thing to try.
