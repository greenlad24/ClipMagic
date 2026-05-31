# ClipMagic — Self-Hosted Deployment (DigitalOcean)

This replaces the old multi-service setup (Rendi for FFmpeg, R2 for storage,
Zite's hosted DB + the 25MB upload cap) with **one server that does
everything**: unlimited uploads, local FFmpeg rendering, a built-in SQLite
database, and bulk rendering of 300+ videos — all on a single droplet.

```
┌──────────────────────── DigitalOcean Droplet ────────────────────────┐
│  clipmagic (Node + FFmpeg, port 8080)                                 │
│   • POST /api/uploads          stream to disk (no 25MB cap)           │
│   • POST /api/render/manifest  one render                             │
│   • POST /api/batches          300+ renders in one batch             │
│   • POST /v1/run-ffmpeg-command  Rendi-compatible drop-in           │
│   • SQLite job queue → worker pool runs N FFmpeg jobs in parallel    │
│   • serves the bulk dashboard UI at /                                 │
│  volume: /data  (uploads, outputs, db)                               │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 1. Create the droplet

- **Image:** Ubuntu 24.04 (or DigitalOcean's Docker Marketplace image).
- **Size:** rendering is CPU-bound. Start with a **CPU-Optimized** droplet:
  - 4 vCPU / 8 GB for steady throughput on 300-video batches,
  - 8 vCPU / 16 GB if you want batches to finish roughly twice as fast.
- **Volume:** attach a Block Storage volume (e.g. 100–500 GB) and mount it at
  `/mnt/clipmagic-data` — video in/out adds up fast.

## 2. Install Docker (skip if you used the Docker image)

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. Get the code and configure

```bash
git clone <your-repo-url> clipmagic && cd clipmagic
cp server/.env.example .env        # then edit .env
```

Key settings in `.env` (consumed by `docker-compose.yml`):

| Variable             | Recommended            | Purpose                                   |
|----------------------|------------------------|-------------------------------------------|
| `RENDER_CONCURRENCY` | = your vCPU count      | Parallel FFmpeg jobs                      |
| `MAX_UPLOAD_BYTES`   | `0`                    | `0` = unlimited (removes the 25MB cap)    |
| `API_TOKEN`          | a long random string   | Require auth on `/api` and `/v1`          |
| `PUBLIC_BASE_URL`    | `https://clips.you.com`| Absolute URLs in API responses           |

To put the data volume on your mounted Block Storage, change the volume in
`docker-compose.yml` to a bind mount:

```yaml
    volumes:
      - /mnt/clipmagic-data:/data
```

## 4. Run

```bash
docker compose up -d --build
docker compose logs -f          # watch it boot
curl http://localhost:8080/health
```

Open `http://<droplet-ip>:8080` — the **bulk dashboard** is ready:
drop in your videos → set the template → **Render all** → watch progress →
**Download all (zip)**.

## 5. (Recommended) HTTPS + domain

Put Caddy or Nginx in front for TLS. Caddy example (`/etc/caddy/Caddyfile`):

```
clips.example.com {
    reverse_proxy localhost:8080
    request_body { max_size 0 }   # don't let the proxy cap uploads
}
```

> If you proxy, **disable the proxy's upload size limit** (shown above for
> Caddy; for Nginx set `client_max_body_size 0;`) or you reintroduce a cap.

---

## Running without Docker (bare Node)

```bash
sudo apt-get update && sudo apt-get install -y ffmpeg fonts-dejavu-core
cd server
npm install
npm run build
DATA_DIR=/mnt/clipmagic-data RENDER_CONCURRENCY=4 MAX_UPLOAD_BYTES=0 npm start
```

Use a systemd unit (or `pm2`) to keep it running. A sample unit:

```ini
[Unit]
Description=ClipMagic
After=network.target

[Service]
WorkingDirectory=/opt/clipmagic/server
Environment=DATA_DIR=/mnt/clipmagic-data
Environment=RENDER_CONCURRENCY=4
Environment=MAX_UPLOAD_BYTES=0
ExecStart=/usr/bin/node dist/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

---

## Using the existing ClipMagic app against this server

The server implements Rendi's protocol, so the existing render code works by
changing one variable. In the app's backend environment set:

```
CLIPMAGIC_RENDER_URL=https://clips.example.com
CLIPMAGIC_API_TOKEN=<same as API_TOKEN, if you set one>
```

`src/utils/rendiConfig.ts` picks this up automatically and routes
`/v1/run-ffmpeg-command` + `/v1/commands/:id` to your droplet instead of Rendi.

For uploads, swap the old Zite upload SDK for `src/lib/clipmagicClient.ts`
(`uploadFiles`, `renderManifest`, `createBatch`, …) — see that file's header.

---

## API quick reference

| Method & path                  | Purpose                                  |
|--------------------------------|------------------------------------------|
| `GET  /health`                 | Liveness + queue depth                   |
| `POST /api/uploads`            | Multipart upload (field `files`), no cap |
| `GET  /api/uploads/:id`        | Fetch an uploaded file                   |
| `POST /api/render/manifest`    | Queue one manifest render → `{jobId}`    |
| `GET  /api/render/:id`         | Job status + progress + output URL       |
| `POST /api/batches`            | Queue a bulk batch (300+ items)          |
| `GET  /api/batches/:id`        | Per-item batch status                    |
| `GET  /api/batches/:id/download` | Zip of all completed outputs           |
| `POST /v1/run-ffmpeg-command`  | Rendi-compatible render                  |
| `GET  /v1/commands/:id`        | Rendi-compatible status                  |
| `/api/projects`, `/api/projects/:id/shots`, `/api/projects/music` | Project/Shot/Music store (Zite DB replacement) |

## Verify your install

With the server running:

```bash
cd server && npm run build && BASE=http://localhost:8080 npm run smoke
```

The smoke test generates media, uploads it, and exercises the manifest render,
the Rendi-compatible path, and a bulk batch — printing
`✓ ALL RENDER PATHS PASSED` on success.

## Notes

- **Disk hygiene:** outputs and uploads accumulate under `/data`. Add a cron job
  to prune old renders, or store them off-box if you need long retention.
- **Crash safety:** jobs live in SQLite; a restart re-queues anything that was
  mid-render, so a reboot during a 300-video batch resumes cleanly.
