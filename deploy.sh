#!/usr/bin/env bash
#
# ClipMagic one-command deploy for a fresh Ubuntu droplet.
#
# Usage (on the droplet, as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/greenlad24/clipmagic/main/deploy.sh | bash
# or, from a clone:
#   ./deploy.sh
#
# Installs Docker if missing, builds the ClipMagic image, and starts it on
# port 8080 with a persistent data volume. Re-runnable: pulls latest + rebuilds.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/greenlad24/clipmagic.git}"
APP_DIR="${APP_DIR:-/opt/clipmagic}"
PORT="${PORT:-8080}"
# The product-improver's parallel "lab" app (separate image/port/data volume).
# It is started ALONGSIDE the main app and never modifies it. Set SKIP_LAB=1 to
# deploy only the main app.
LAB_PORT="${LAB_PORT:-9090}"

say() { printf '\n\033[1;35m== %s\033[0m\n' "$*"; }

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
# docker compose v2 ships with modern Docker; verify.
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' plugin not found. Install Docker Compose v2." >&2
  exit 1
fi

# 2. Code
if [ -d "$APP_DIR/.git" ]; then
  say "Updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  say "Cloning into $APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# 3. Config (.env) — create once with sensible defaults.
if [ ! -f .env ]; then
  say "Writing default .env"
  CORES="$(nproc 2>/dev/null || echo 2)"
  TOKEN_HINT="$(head -c 24 /dev/urandom 2>/dev/null | base64 | tr -dc 'a-zA-Z0-9' | head -c 32 || echo change-me)"
  # Quoted heredoc delimiter so nothing inside is expanded; we substitute the
  # few values we need with sed afterwards.
  cat > .env <<'EOF'
PORT=__PORT__
RENDER_CONCURRENCY=__CORES__
MAX_UPLOAD_BYTES=0
# Uncomment to require an API token on /api and /v1 (suggested value below):
# API_TOKEN=__TOKEN__
# Set to your public origin (used for absolute output URLs):
# PUBLIC_BASE_URL=https://your-domain.example.com
# Free Pexels stock footage for situational b-roll (https://www.pexels.com/api/):
# PEXELS_API_KEY=
# Anthropic (AI director). Use EITHER an API key:
# ANTHROPIC_API_KEY=sk-ant-api...
# ...OR an account access token (e.g. from `claude setup-token`). If both are
# set, the token wins:
# ANTHROPIC_AUTH_TOKEN=sk-ant-oat...
EOF
  sed -i "s|__PORT__|$PORT|; s|__CORES__|$CORES|; s|__TOKEN__|$TOKEN_HINT|" .env
  echo "  -> edit $APP_DIR/.env to set API_TOKEN / PUBLIC_BASE_URL if desired"
fi

# 4. Build + run
say "Building and starting ClipMagic"
docker compose up -d --build

# 5. Wait for health
say "Waiting for health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "  healthy."
    break
  fi
  sleep 2
done

# 5b. Lab app (:9090) — ADDITIVE. This starts the separate 'lab' profile service
# only. It does not rebuild, recreate, or otherwise touch the main app above
# (different image, port, and data volume). Skip with SKIP_LAB=1.
if [ "${SKIP_LAB:-0}" != "1" ]; then
  say "Building and starting the lab app (:$LAB_PORT) — separate from the main app"
  docker compose --profile lab up -d --build clipmagic-lab
  say "Waiting for lab health"
  for i in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1; then
      echo "  lab healthy."
      break
    fi
    sleep 2
  done
fi

IP="$(curl -fsS https://ifconfig.me 2>/dev/null || echo '<droplet-ip>')"
say "Done"
echo "ClipMagic is running."
echo "  Main app:  http://127.0.0.1:$PORT   (public http://$IP:$PORT — open TCP $PORT)"
if [ "${SKIP_LAB:-0}" != "1" ]; then
  echo "  Lab app:   http://127.0.0.1:$LAB_PORT   (public http://$IP:$LAB_PORT — open TCP $LAB_PORT)"
fi
echo
echo "Manage it:"
echo "  docker compose -f $APP_DIR/docker-compose.yml logs -f                       # main app"
echo "  docker compose -f $APP_DIR/docker-compose.yml restart                       # main app"
echo "  docker compose -f $APP_DIR/docker-compose.yml down                          # STOPS BOTH apps"
echo "  docker compose -f $APP_DIR/docker-compose.yml --profile lab logs -f clipmagic-lab   # lab only"
echo "  docker compose -f $APP_DIR/docker-compose.yml stop clipmagic-lab && \\"
echo "    docker compose -f $APP_DIR/docker-compose.yml rm -f clipmagic-lab         # stop ONLY the lab"
