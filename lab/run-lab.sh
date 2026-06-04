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

# This Claude Code container injects ANTHROPIC_BASE_URL / auth tokens for the
# harness itself. The app would otherwise send its real ANTHROPIC_API_KEY to
# that proxy and fail, so clear them first; a real .env below can still set its
# own ANTHROPIC_BASE_URL if you actually want a custom endpoint.
unset ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN 2>/dev/null || true

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

# --- Motion graphics (default ON; Remotion + Chromium) -----------------------
# Motion graphics now default ON (per-video UI toggle; MOTION_GRAPHICS=0 to
# force-disable globally). Remotion lives in lab/remotion with its OWN heavy deps
# (the @remotion/* SSR packages). To keep a normal local run fast we DON'T force
# that install on every run — the server's motion stage falls back to a no-op if
# the deps aren't present (it can't import @remotion/* and renders normally).
#
# Chromium: if a system browser (or REMOTION_BROWSER_EXECUTABLE) is present, use
# it so Remotion never has to download its own. Otherwise leave it unset and fall
# back to Remotion's managed Chromium (its existing behavior on first render).
if [ -z "${REMOTION_BROWSER_EXECUTABLE:-}" ]; then
  for chrome_bin in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$chrome_bin" >/dev/null 2>&1; then
      export REMOTION_BROWSER_EXECUTABLE="$(command -v "$chrome_bin")"
      break
    fi
  done
fi
if [ -n "${REMOTION_BROWSER_EXECUTABLE:-}" ]; then
  echo "[lab] Remotion Chromium: $REMOTION_BROWSER_EXECUTABLE (pre-set; no download)"
else
  echo "[lab] Remotion Chromium: none found — Remotion will manage its own on first render"
fi
# Install Remotion's SSR deps only when explicitly requested (REMOTION_INSTALL=1)
# and not already present — this is the one heavy step, so it stays opt-in.
if [ "${REMOTION_INSTALL:-}" = "1" ] && [ ! -d "$LAB_DIR/remotion/node_modules" ]; then
  echo "[lab] REMOTION_INSTALL=1 — installing Remotion deps (one-time)…"
  ( cd "$LAB_DIR/remotion" && npm install --no-audit --no-fund ) \
    || echo "[lab] ⚠ Remotion install failed — motion graphics fall back to off (normal render still works)."
fi
if [ "${MOTION_GRAPHICS:-}" = "0" ]; then
  echo "[lab] MOTION_GRAPHICS=0 — short-form motion graphics force-disabled (stickers unaffected)."
fi

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
