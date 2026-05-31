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
  cat > .env <<EOF
PORT=$PORT
RENDER_CONCURRENCY=$CORES
MAX_UPLOAD_BYTES=0
# Uncomment to require an API token on /api and /v1:
# API_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
# Set to your public origin (used for absolute output URLs):
# PUBLIC_BASE_URL=https://your-domain.example.com
EOF
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

IP="$(curl -fsS https://ifconfig.me 2>/dev/null || echo '<droplet-ip>')"
say "Done"
echo "ClipMagic is running."
echo "  Local:  http://127.0.0.1:$PORT"
echo "  Public: http://$IP:$PORT   (open the firewall for TCP $PORT)"
echo
echo "Manage it:"
echo "  docker compose -f $APP_DIR/docker-compose.yml logs -f"
echo "  docker compose -f $APP_DIR/docker-compose.yml restart"
echo "  docker compose -f $APP_DIR/docker-compose.yml down"
