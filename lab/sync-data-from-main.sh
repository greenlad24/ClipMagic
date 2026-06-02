#!/usr/bin/env bash
#
# Snapshot the MAIN app's data into the LAB's data volume, so the lab can test
# against the real, already-indexed promo videos + background music (and the
# rest of the library) without re-uploading or re-indexing anything.
#
# This is a ONE-WAY COPY into the lab's SEPARATE volume. The main app's volume
# is mounted read-only, so this can never modify or corrupt the main app's data.
# Nothing the lab subsequently does touches the main app either. Re-run this
# anytime to refresh the lab with newer promos/music from the main app.
#
# Run on the server, from the repo dir:
#   bash lab/sync-data-from-main.sh
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # repo root (where docker-compose.yml lives)

# Resolve the real Docker volume names (compose prefixes them with the project).
vol() { docker volume ls --format '{{.Name}}' | grep -E "/?${1}\$" | head -n1; }
SRC="$(vol clipmagic-data)"
DST="$(vol clipmagic-lab-data)"

[ -n "$SRC" ] || { echo "ERROR: main data volume (…clipmagic-data) not found — is the main app deployed?" >&2; exit 1; }
[ -n "$DST" ] || { echo "ERROR: lab data volume (…clipmagic-lab-data) not found — run ./deploy.sh once so it's created." >&2; exit 1; }

echo "Main data volume (source, read-only): $SRC"
echo "Lab  data volume (target, OVERWRITTEN): $DST"
echo
echo "This OVERWRITES the lab's current data with a copy of the main app's data."
echo "Tip: run it when you're not actively uploading/indexing in the main app so"
echo "the database copy is consistent (already-indexed promos/music are static)."
read -r -p "Proceed? [y/N] " ans
case "$ans" in y|Y) ;; *) echo "aborted"; exit 0;; esac

echo "[sync] stopping the lab so its data isn't written during the copy…"
docker compose stop clipmagic-lab >/dev/null 2>&1 || true

echo "[sync] copying main -> lab (large media can take a while)…"
# Reuse the already-built lab image (has sh/cp) so this needs no image pull.
docker run --rm \
  -v "$SRC":/from:ro \
  -v "$DST":/to \
  clipmagic-lab:latest \
  sh -c "rm -rf /to/* 2>/dev/null; cp -a /from/. /to/ && echo '[sync] copy complete'"

echo "[sync] restarting the lab…"
docker compose --profile lab up -d clipmagic-lab >/dev/null

echo "[sync] done — the lab on :9090 now has the main app's promos, music, indexes, and db."
