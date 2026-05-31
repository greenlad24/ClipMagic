# ClipMagic

AI-assisted short-form video editor (narration → screencasts / B-roll /
captions → finished vertical video).

This repository contains two parts:

| Path        | What it is                                                                 |
|-------------|---------------------------------------------------------------------------|
| `src/`      | The ClipMagic frontend app (originally built on Zite).                     |
| `server/`   | **Self-hosted backend** — uploads, storage, local FFmpeg rendering, bulk.  |

## Why the `server/`

The original app depended on three paid/limited external services:

- **Rendi** for FFmpeg rendering,
- **R2** for file storage (with a **25 MB upload cap** on the Zite side),
- **Zite's hosted database** for projects/shots/music.

`server/` collapses all of that into **one process you run on a single
DigitalOcean droplet**:

- ✅ **Unlimited uploads** — files stream straight to disk (no 25 MB cap).
- ✅ **Local FFmpeg rendering** — no Rendi; same composition (narration base,
  timed overlays, music mix, burned-in word-by-word captions).
- ✅ **Built-in database** (SQLite) — no external DB service.
- ✅ **Bulk: 300+ videos** — a persistent job queue drains the backlog across a
  worker pool sized to your CPU count, with retries and crash-safe resume.
- ✅ **Rendi-compatible API** (`/v1/run-ffmpeg-command`) so the existing render
  code works by changing one environment variable.
- ✅ **Bundled bulk dashboard UI** served at `/` — usable with no frontend build.

## Quick start

```bash
docker compose up -d --build
# open http://<droplet-ip>:8080
```

Full instructions, sizing, HTTPS, and how to point the existing app at the
server: **[DEPLOY.md](./DEPLOY.md)**.

## Verify

```bash
cd server
npm install && npm run build
npm start &                          # starts on :8080
BASE=http://localhost:8080 npm run smoke
```

`npm run smoke` generates test media, uploads it, and runs all three render
paths (manifest, Rendi-compatible, and a bulk batch), printing
`✓ ALL RENDER PATHS PASSED`.

## Architecture

```
Browser / existing app
        │  multipart upload (no cap)         JSON manifest / Rendi command
        ▼                                    ▼
  POST /api/uploads ──► disk          POST /api/render/manifest
                                      POST /api/batches  (300+)
                                      POST /v1/run-ffmpeg-command
                                              │
                                      SQLite render queue
                                              │
                                      worker pool (RENDER_CONCURRENCY)
                                              │  spawn ffmpeg
                                              ▼
                                      /data/outputs ──► GET /api/outputs/:f
                                                        GET /api/batches/:id/download (zip)
```
