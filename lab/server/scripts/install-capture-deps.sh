#!/usr/bin/env bash
#
# Install the Auto-Screencast capture dependency (puppeteer-core) into a
# LAB-PRIVATE directory — server/.capture-deps — so it NEVER lands in the main
# app's shared node_modules (which the lab symlinks read-only).
#
# puppeteer-core ships NO bundled browser, and we set PUPPETEER_SKIP_DOWNLOAD=1
# anyway: the screencast engine drives the container's EXISTING Chromium (the one
# Remotion uses). So this install is small and offline-friendly after first fetch.
#
# screencast.ts resolves puppeteer-core from here first (createRequire on
# server/.capture-deps/package.json), falling back to normal resolution.
#
# Usage:  cd lab/server && npm run install:capture-deps
#         (or set CAPTURE_INSTALL=1 when launching the lab)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPS_DIR="$SERVER_DIR/.capture-deps"

PUP_VERSION="${PUPPETEER_CORE_VERSION:-23.11.1}"

if [ -d "$DEPS_DIR/node_modules/puppeteer-core" ]; then
  echo "[capture-deps] puppeteer-core already installed at $DEPS_DIR — skipping."
  exit 0
fi

echo "[capture-deps] installing puppeteer-core@$PUP_VERSION into $DEPS_DIR (lab-private)…"
mkdir -p "$DEPS_DIR"
if [ ! -f "$DEPS_DIR/package.json" ]; then
  cat > "$DEPS_DIR/package.json" <<JSON
{ "name": "clipmagic-capture-deps", "private": true, "version": "1.0.0" }
JSON
fi

# Skip every bundled-browser download — we use the system/Remotion Chromium.
export PUPPETEER_SKIP_DOWNLOAD=1
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1

( cd "$DEPS_DIR" && npm install --no-audit --no-fund "puppeteer-core@$PUP_VERSION" ) \
  && echo "[capture-deps] done — Auto-Screencast capture enabled." \
  || { echo "[capture-deps] ⚠ install failed — Auto-Screencast will report a clear error until this succeeds."; exit 1; }
