# Postiz — self-hosted social poster

The hub's **Social poster** tile opens [Postiz](https://github.com/gitroomhq/postiz-app),
an open-source social-media scheduler, in a new browser tab. Postiz is a
**separate app** — its own container on its own port, backed by its own
PostgreSQL + Redis — so it's wired into the project's `docker-compose.yml`
behind an **opt-in `postiz` profile** and is never started automatically.

## What it is (and licensing)

- Image: `ghcr.io/gitroomhq/postiz-app:latest` (a single image bundling the
  Postiz frontend + backend; serves on container port **5000**).
- Datastores: **PostgreSQL 17** and **Redis 7** (added as `postiz-postgres` and
  `postiz-redis`).
- **License: AGPL-3.0.** Fine for self-hosting and internal use. The obligation
  it adds over MIT-style licenses is the network/copyleft clause: if you modify
  Postiz *and* offer the modified version to users over a network, you must make
  that modified source available. Running the **unmodified** official image for
  your own posting — which is all this setup does — carries no extra obligation.

## Run it

It's heavy (app + Postgres + Redis) for a 4-vCPU / 8 GB box, so it is **manual**
and `deploy.sh` never touches it. From the repo root:

```bash
docker compose --profile postiz up -d        # start Postiz + its Postgres + Redis
# open http://<host>:5000  (or your POSTIZ_URL)

docker compose --profile postiz logs -f postiz   # watch it
docker compose stop postiz postiz-postgres postiz-redis   # stop just Postiz
```

> Don't use `docker compose down` to stop Postiz — that tears down the whole
> project (including the main app on :8080). Stop the services by name as above.

The main app keeps running independently. A plain `docker compose up -d` starts
**only** the main `clipmagic` service — Postiz is opt-in via its profile.

## Resource note

Postiz adds three long-running containers (app + Postgres + Redis). On a
4-vCPU / 8 GB droplet that already runs the main app (and optionally the lab and
its FFmpeg renders), watch memory — run Postiz when you need it and stop it when
you don't, rather than leaving everything up at once.

## Required secrets / env (set in the shared root `.env`)

All values come from the project's git-ignored root `.env` (same file the main
app and lab read). The compose file ships safe defaults for the non-secret ones;
you **must** set `POSTIZ_JWT_SECRET`, and you should set a real Postgres password.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `POSTIZ_JWT_SECRET` | **yes** | _(empty)_ | Long random string, unique per install. Signs Postiz sessions. Wired to Postiz's `JWT_SECRET`. |
| `POSTIZ_URL` | recommended | `http://localhost:5000` | Public origin the browser uses. Set to `http://<host-ip>:5000` or `https://social.yourdomain.com`. Drives Postiz's `MAIN_URL`, `FRONTEND_URL`, `NEXT_PUBLIC_BACKEND_URL`. |
| `POSTIZ_PORT` | no | `5000` | Host port published for Postiz (container is fixed at 5000). |
| `POSTIZ_POSTGRES_USER` | no | `postiz` | Postgres user. |
| `POSTIZ_POSTGRES_PASSWORD` | recommended | `postiz-password` | Postgres password — change it for anything internet-facing. |
| `POSTIZ_POSTGRES_DB` | no | `postiz` | Postgres database name. |
| `POSTIZ_DISABLE_REGISTRATION` | no | `false` | Set `true` after creating your account to lock down sign-ups. |

Fixed/internal env (set by compose, not by you): `BACKEND_INTERNAL_URL=http://localhost:3000`,
`DATABASE_URL` (built from the Postgres vars), `REDIS_URL=redis://postiz-redis:6379`,
`STORAGE_PROVIDER=local`, `UPLOAD_DIRECTORY`/`NEXT_PUBLIC_UPLOAD_DIRECTORY=/uploads`,
`IS_GENERAL=true` (required for the self-hosted build).

### Generate a JWT secret

```bash
openssl rand -hex 32   # paste into POSTIZ_JWT_SECRET in .env
```

## Per-platform OAuth credentials (connect each social account)

Postiz connects to each network via that network's own OAuth app. Create an app
on each platform's developer portal, set its **redirect/callback URL** to your
Postiz origin (e.g. `http://<host>:5000` — see Postiz's per-provider docs at
https://docs.postiz.com/providers for the exact callback path each one needs),
then put the credentials in `.env`. They default to empty and are passed through
by compose — only set the ones you actually use:

| Network | Env vars |
|---|---|
| X (Twitter) | `X_API_KEY`, `X_API_SECRET` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| Reddit | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Facebook / Instagram | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| YouTube | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` |
| TikTok | `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET` |
| Pinterest | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` |
| Threads | `THREADS_APP_ID`, `THREADS_APP_SECRET` |
| Discord | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| Slack | `SLACK_ID`, `SLACK_SECRET` |
| Mastodon | `MASTODON_CLIENT_ID`, `MASTODON_CLIENT_SECRET` |
| Telegram | `TELEGRAM_TOKEN` |

> Provider env-var names track Postiz upstream. If a network won't connect,
> check the current name on its provider page at https://docs.postiz.com/providers
> and add it to both `.env` and the `postiz` service's `environment:` block.

## Example `.env` block

```dotenv
# Postiz (social poster) — used only when `docker compose --profile postiz up -d`
POSTIZ_PORT=5000
POSTIZ_URL=http://203.0.113.10:5000        # your host IP or domain
POSTIZ_JWT_SECRET=replace-with-openssl-rand-hex-32
POSTIZ_POSTGRES_USER=postiz
POSTIZ_POSTGRES_PASSWORD=change-me
POSTIZ_POSTGRES_DB=postiz
# OAuth (only what you use):
# X_API_KEY=...
# X_API_SECRET=...
# YOUTUBE_CLIENT_ID=...
# YOUTUBE_CLIENT_SECRET=...
```

## How the suite tile finds Postiz

The suite frontend is built without knowing Postiz's port, so the URL is
resolved at runtime:

1. The server's `getServiceStatus` endpoint reads `POSTIZ_URL` / `POSTIZ_PORT`
   (or `POSTIZ_ENABLED`) and returns `postizConfigured`, `postizUrl`, and
   `postizPort`.
2. The hub (`lab/src/pages/HomePage.tsx` via `resolvePostizUrl` in
   `lab/src/config/tools.ts`) uses `postizUrl` when set, otherwise derives
   `http://<current-host>:<postizPort>` from the browser's location.
3. If Postiz isn't configured (`postizConfigured` false), the **Social poster**
   tile stays **"coming soon"** and is non-clickable — so it never opens a dead
   link. When configured, the tile opens Postiz in a **new tab**
   (`target="_blank"`, `rel="noopener noreferrer"`).

> Important: the suite server reads these env vars from its own process
> environment. When running the suite in Docker (the `clipmagic`/`clipmagic-lab`
> services), add `POSTIZ_URL`/`POSTIZ_PORT` to the shared `.env` — they're
> already loaded via `env_file: .env` — so the running suite container sees them.

## Verified vs. needs-the-server

- **Verified here:** `docker compose --profile postiz config` validates (services,
  env, ports, volumes, healthchecks, `depends_on`); the suite builds green and the
  hub tile goes live + opens the resolved URL (and falls back to "coming soon"
  when unconfigured).
- **Needs your server:** pulling `ghcr.io/gitroomhq/postiz-app`, first boot /
  DB migration, creating your Postiz account, and the actual per-platform OAuth
  connections — those happen on the host with real credentials and network.
