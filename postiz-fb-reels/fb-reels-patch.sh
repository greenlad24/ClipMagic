#!/bin/sh
# [fb-reels-patch] Make Facebook video posts go through the Reels API (video_reels)
# instead of /videos, with an explicit video_state=PUBLISHED, and resolve the real
# permalink from Graph instead of hardcoding /reel/<id>.
#
# Idempotent and fail-safe: if the compiled file already contains the patch, or the
# anchors no longer match (image pull), it leaves the file untouched and carries on.
TAG="[fb-reels-patch]"
BLOCK=/config/fb-reels-block.js
APPLY=/config/fb-reels-apply.js

TARGETS="/app/apps/orchestrator/dist/libraries/nestjs-libraries/src/integrations/social/facebook.provider.js /app/apps/backend/dist/libraries/nestjs-libraries/src/integrations/social/facebook.provider.js"

if [ ! -f "$BLOCK" ] || [ ! -f "$APPLY" ]; then
  echo "$TAG missing $BLOCK or $APPLY, skipping"
  exit 0
fi

for f in $TARGETS; do
  if [ ! -f "$f" ]; then
    echo "$TAG missing $f, skipping"
    continue
  fi
  if grep -q "video_reels" "$f"; then
    echo "$TAG already patched: $f"
    continue
  fi
  cp "$f" "$f.pre-fbreels.bak"
  if ! node "$APPLY" "$f" "$BLOCK"; then
    echo "$TAG apply failed, restoring $f"
    cp "$f.pre-fbreels.bak" "$f"
    continue
  fi
  if ! node --check "$f"; then
    echo "$TAG syntax check failed, restoring $f"
    cp "$f.pre-fbreels.bak" "$f"
    continue
  fi
  echo "$TAG patched $f"
done

for f in $TARGETS; do
  [ -f "$f" ] && echo "$TAG video_reels occurrences in $f: $(grep -c video_reels "$f")"
done
exit 0
