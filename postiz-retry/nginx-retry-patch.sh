#!/bin/sh
# [retry-button] Postiz nginx patch — idempotent, fails safe.
#
# Serves /postiz-retry.js from the postiz-config volume and injects it into
# every HTML page with sub_filter, so the "Failed posts / Retry" control exists
# without rebuilding Postiz's prebuilt .next frontend.
#
# Run from the postiz service entrypoint BEFORE nginx starts. If anything is
# unexpected it leaves nginx.conf untouched and Postiz boots normally.
set -e

CONF=/etc/nginx/nginx.conf
[ -f "$CONF" ] || { echo "[retry-button] no $CONF — skipped"; exit 0; }

if grep -q 'postiz-retry.js' "$CONF"; then
  echo "[retry-button] nginx.conf already patched"
  exit 0
fi

# Both anchors must be present exactly once, or we don't touch anything.
if [ "$(grep -c '^        location / {' "$CONF")" != "1" ] ||
   [ "$(grep -c 'proxy_pass http://localhost:4200/;' "$CONF")" != "1" ]; then
  echo "[retry-button] nginx.conf anchors not found — skipped (Postiz upgrade?)"
  exit 0
fi

cp "$CONF" "$CONF.pre-retry.bak"

awk '
/^        location \/ \{$/ && !didloc {
  print "        # [retry-button] the injected script, from the postiz-config volume"
  print "        location = /postiz-retry.js {"
  print "            alias /config/retry-button.js;"
  print "            default_type application/javascript;"
  print "            add_header Cache-Control \"no-cache\";"
  print "        }"
  print ""
  didloc = 1
}
{ print }
/proxy_pass http:\/\/localhost:4200\/;/ && !didsub {
  print "            # [retry-button] inject it into every HTML page. Accept-Encoding"
  print "            # must be cleared or sub_filter cannot read a gzipped upstream body;"
  print "            # the server-level `gzip on` re-compresses on the way out."
  print "            proxy_set_header Accept-Encoding \"\";"
  print "            sub_filter \"</body>\" \"<script src=\\\"/postiz-retry.js\\\" defer></script></body>\";"
  print "            sub_filter_once on;"
  didsub = 1
}
' "$CONF.pre-retry.bak" > "$CONF.new"

if nginx -t -c "$CONF.new" >/dev/null 2>&1; then
  mv "$CONF.new" "$CONF"
  echo "[retry-button] nginx.conf patched (script tag + /postiz-retry.js)"
else
  rm -f "$CONF.new"
  echo "[retry-button] patched nginx.conf failed nginx -t — reverted, Postiz unaffected"
fi
