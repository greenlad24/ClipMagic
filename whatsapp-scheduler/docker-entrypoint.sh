#!/bin/sh
# ---------------------------------------------------------------------------
# Clear stale Chromium profile locks before starting.
#
# WhatsApp Web sessions live on a persistent volume, one profile per lab user at
# DATA_DIR/users/<key>/wwebjs_auth, and Chromium writes SingletonLock/Cookie/Socket
# into each naming the host it ran on (e.g. "b4e2e0e5a06c-14"). Recreating the
# container gives it a NEW hostname, so Chromium sees a lock owned by "another
# computer", refuses to open the profile, and the service crash-loops on "Failed
# to launch the browser process: Code: 21". Nothing else holds these locks — one
# container owns the volume — so any lock present at boot is by definition stale
# and safe to drop. The linked WhatsApp sessions themselves live elsewhere in the
# profiles and are untouched.
#
# Every profile is swept, not just one: a lock left behind by a user whose session
# happened to be running at the last shutdown would otherwise break only THAT
# account, quietly, the next time they opened the page.
# ---------------------------------------------------------------------------
DATA_ROOT="${DATA_DIR:-/app/data}"
# Covers data/users/<key>/wwebjs_auth/session (per-user) and, for a volume not yet
# migrated, the old shared data/wwebjs_auth/session.
find "$DATA_ROOT" -maxdepth 4 -type d -name session -path '*wwebjs_auth*' 2>/dev/null |
  while IFS= read -r session_dir; do
    rm -f "$session_dir/SingletonLock" \
          "$session_dir/SingletonCookie" \
          "$session_dir/SingletonSocket"
  done

exec "$@"
