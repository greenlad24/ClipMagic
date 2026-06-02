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
# Usage:
#   bash lab/run-lab.sh              # build (if needed) + run on :9090
#   PORT=9999 bash lab/run-lab.sh    # different port
#   bash lab/run-lab.sh --no-build   # skip rebuild, just start
#
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$LAB_DIR/.." && pwd)"
PORT="${PORT:-9090}"
export DATA_DIR="$LAB_DIR/data"

BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

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
exec env PORT="$PORT" DATA_DIR="$DATA_DIR" node dist/index.js
