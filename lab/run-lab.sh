#!/usr/bin/env bash
#
# Launch the PARALLEL "product-improver" app — a fully separate ClipMagic
# instance with its own code (this lab/ folder), its own data (lab/data), and
# its own port (default 9090). It never touches the main app on :8080.
#
# Dependencies are SHARED from the main app via symlinks (same versions, just
# libraries — no install needed and no interference with your work). Only the
# code, data, and port are isolated.
#
# API KEYS: the app reads keys from the process environment (no dotenv in the
# code). If they're already set in your shell / web-environment config, the lab
# inherits them automatically. Otherwise this script loads the first .env it
# finds (search order below) so the lab can share the MAIN app's keys — or a
# duplicated copy if you prefer. Whatever the .env says, the lab's PORT and all
# data paths are FORCED back to isolated values afterward, so a shared .env can
# never make the lab write into the main app's data.
#   1. lab/server/.env   2. lab/.env   3. ../server/.env   4. ../.env (repo root)
#
# Usage:
#   bash lab/run-lab.sh              # build (if needed) + run on :9090
#   PORT=9999 bash lab/run-lab.sh    # different port
#   bash lab/run-lab.sh --no-build   # skip rebuild, just start
#
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$LAB_DIR/.." && pwd)"
PORT_WANT="${PORT:-9090}"   # capture intended port before any .env can change it

BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

# --- Load API keys from a .env (shared with the main app, or a duplicate) ----
ENV_FILE=""
for cand in "$LAB_DIR/server/.env" "$LAB_DIR/.env" "$ROOT_DIR/server/.env" "$ROOT_DIR/.env"; do
  if [ -f "$cand" ]; then ENV_FILE="$cand"; break; fi
done
if [ -n "$ENV_FILE" ]; then
  echo "[lab] loading env from $ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
else
  echo "[lab] no .env found — using inherited environment only"
fi

# --- Re-assert isolation: override anything the shared .env may have set ------
export PORT="$PORT_WANT"
export DATA_DIR="$LAB_DIR/data"
# These derive from DATA_DIR when unset; clear them so a shared .env can't point
# the lab at the main app's uploads/outputs/db/frontend.
unset UPLOADS_DIR OUTPUTS_DIR TMP_DIR DB_PATH FRONTEND_DIR SERVER_ROOT 2>/dev/null || true

echo "[lab] keys: ANTHROPIC=$([ -n "${ANTHROPIC_API_KEY:-}" ] && echo yes || echo NO) GROQ=$([ -n "${GROQ_API_KEY:-}" ] && echo yes || echo NO) KINOVI=$([ -n "${ZITE_KINOVI_API_KEY:-}" ] && echo yes || echo NO)"

echo "[lab] sharing dependencies from the main app (read-only libs)…"
ln -sfn "$ROOT_DIR/server/node_modules" "$LAB_DIR/server/node_modules"
ln -sfn "$ROOT_DIR/web/node_modules"    "$LAB_DIR/web/node_modules"

if [ "$BUILD" = "1" ]; then
  echo "[lab] building server…"
  ( cd "$LAB_DIR/server" && npm run build )

  echo "[lab] building web frontend…"
  ( cd "$LAB_DIR"
    # The frontend (../src) resolves its libs from lab/node_modules, so point
    # that at the web deps for the duration of the build (same trick the main
    # app uses), then remove it so the server resolves its own deps at runtime.
    rm -f node_modules
    ln -sfn web/node_modules node_modules
    ( cd web && npm run build )
    rm -f node_modules
  )
fi

echo "[lab] ──────────────────────────────────────────────"
echo "[lab] starting on http://localhost:$PORT"
echo "[lab] data dir: $DATA_DIR  (isolated from the main app)"
echo "[lab] ──────────────────────────────────────────────"
cd "$LAB_DIR/server"
exec node dist/index.js
