# Postiz — injected UI patches

Two features, one injected script (`retry-button.js`, served at
`/postiz-retry.js`). They are independent IIFEs in that one file so a deploy is
a single `docker cp`.

1. **Retry failed posts** — a floating `⟳ Failed (n)` pill.
2. **Reconnect channel, always available** — a "Reconnect channel" row in every
   channel's ⋯ menu, not just disconnected ones.

---

## 1. "Retry failed posts" button

Adds a floating **⟳ Failed (n)** pill to every Postiz page. Clicking it opens a
panel listing every post in `ERROR` state (channel, scheduled time, the post
text, and the real error message) with a **Retry** button per post and a
**Retry all**.

### How a retry works

No backend change. It calls an endpoint Postiz already has:

```
PUT /api/posts/:id/date   {"date": "<now, UTC>", "action": "schedule"}
```

`PostsService.changeDate` with `action: 'schedule'` sets the post back to
`QUEUE`, clears `releaseId`/`releaseURL`, and calls `startWorkflow`, which
restarts the `postWorkflowV105` Temporal workflow on task queue `main`
(`workflowId: post_<id>`, `workflowIdConflictPolicy: TERMINATE_EXISTING` — so
clicking twice is safe). The workflow sleeps `0ms` when `publishDate` is in the
past, so the post fires immediately.

This is the same code path the calendar's own drag-and-drop uses; the button
just makes it reachable for a post you can't drag into the past.

### Notes

- Scans a window of **-90 days to +14 days**, refreshes every 60s.
- `Post.error` is a serialised Temporal failure blob, not a sentence, so the
  script digs out `cause.failure.message` and shows the failure `type` as a chip
  (e.g. `refresh_token`). For `refresh_token` it adds a hint to reconnect the
  channel if the retry fails again.
- A post that already has a `releaseId` gets a "may already be live — retrying
  could double-post" warning, and **Retry all** asks for confirmation.

---

---

## 2. "Reconnect channel" in the ⋯ menu, at all times

### The catch-22 it fixes

Postiz gates **both** routes into the OAuth reconnect flow on
`integration.refreshNeeded`:

| Where | Condition |
| --- | --- |
| `launches.component.tsx` (~248) | avatar gets `onClick: refreshChannel(...)` only when `refreshNeeded` ("Channel disconnected, click to reconnect.") |
| `launches.component.tsx` (~276) | the red `!` badge needs `inBetweenSteps \|\| refreshNeeded` |
| `menu/menu.tsx` (~413) | the "Reconnect channel" item needs `canDisable && refreshNeeded && !customFields` |

A *successful* reconnect clears `refreshNeeded`, so the only control that could
start a reconnect disappears — and there is no other way back to Google
consent. That bites here because a YouTube refresh token can be revoked or
wiped without Postiz marking the channel as needing a refresh (see
`postiz-reconnect-wipes-refresh-token`).

### How a reconnect works

No backend change — it is the exact endpoint Postiz's own gated button calls:

```
GET /api/integrations/social/<identifier>?refresh=<internalId>   ->  { url }
```

`IntegrationsController.getIntegrationUrl` (`@Get('/social/:integration')`,
`@Query('refresh')`). The `refresh` parameter is the whole difference between a
reconnect and an "add channel": with it the backend writes `refresh:<state>` to
Redis (1h TTL), so the OAuth callback **updates that integration** instead of
creating a second one. For YouTube the returned URL already carries
`access_type=offline&prompt=consent` and
`redirect_uri=${FRONTEND_URL}/integrations/social/youtube`, so completing
consent hands Postiz a fresh refresh token.

The script only navigates to Google. Consent is the user's to give.

### DOM hooking

The menu is client-rendered, so there is nothing to hook in the served HTML.
A `MutationObserver` on `document.documentElement` watches for the dropdown and
recognises it **structurally and by text**, not by a CSS selector:

- a `position: fixed` div (computed style, not a class name),
- 3–20 children, **every** one shaped like a Postiz menu item
  (`<div><div><svg/></div><div>label</div></div>`),
- carrying at least two of Postiz's own labels ("Copy Channel ID",
  "Edit Time Slots", "Move / add to customer", "Delete", …) — several of which
  are rendered unconditionally.

So it survives Tailwind class-name churn. The new row **clones the classes of
an existing sibling** (item class and label class) rather than hardcoding
styles, and is **appended last** — React's reconciler positions its own
children relative to nodes it knows about, so a trailing foreign node is not
reordered by a re-render.

Which channel the open menu belongs to is resolved best-first:

1. the **React fiber** on the surrounding row, which carries the real
   `integration` object (identifier + internalId);
2. the provider icon (`/icons/platforms/<identifier>.png|svg`) or avatar `alt`
   plus the `role="Handle"` channel name, matched against
   `GET /api/integrations/list`;
3. the avatar picture URL, to separate same-named channels.

If none of them identify a channel, the item refuses to act and shows a red
toast rather than guessing.

### When it does *not* add the item

- Postiz is already showing its own "Reconnect channel" (i.e. `refreshNeeded`)
  — no duplicate.
- The provider uses custom fields (`isCustomFields`) — those do not do OAuth;
  Postiz offers "Update Credentials" for them.
- The dropdown could not be identified as a channel menu.

Errors (non-2xx, or the backend's swallowed-error `{err:true}`) are surfaced in
a red toast at the top of the page; the row resets to "Reconnect channel".

### Verified

`node --check`, a jsdom harness driving a mock Postiz sidebar (injection,
sibling-class cloning, trailing placement, idempotency across re-scans, the
"Postiz already shows its own" skip, a non-menu `fixed` decoy being ignored,
picture disambiguation of two same-named YouTube channels, the custom-fields
skip, the error toast), `GET /postiz-retry.js` → 200 through nginx, and
`GET /integrations/social/youtube?refresh=<internalId>` returning a Google
consent URL with `access_type=offline`, `prompt=consent` and the right
`redirect_uri`. The click-through itself needs a browser.

---

## Why an injected script

`ghcr.io/gitroomhq/postiz-app:latest` ships a **prebuilt `.next`**. A real
change in `apps/frontend/src/components/launches/calendar.tsx` or
`launches/menu/menu.tsx` would need a full
in-container frontend rebuild (~10 min, 2GB+ — this box has hung the
orchestrator under memory pressure before) and would be wiped by the next image
pull. This approach survives restarts, recreations and upgrades.

## Files

| Path | What it is |
| --- | --- |
| `retry-button.js` | Both features. Source of truth; installed to `/config/retry-button.js` on the `postiz-config` volume. (Historical name — it also carries the reconnect patch; renaming it would mean editing `nginx-retry-patch.sh` and the compose entrypoint too.) |
| `nginx-retry-patch.sh` | Idempotent, fail-safe patch of `/etc/nginx/nginx.conf` inside the container: serves `/postiz-retry.js` from `/config`, and `sub_filter`s a `<script>` tag into every HTML page. Installed to `/config/nginx-retry-patch.sh`. |

Both live on the `postiz-config` volume (the same one that holds `postiz.env`),
so they persist across `docker compose up -d` and image pulls. The `postiz`
service `entrypoint` in `../docker-compose.yml` runs the patch before nginx
starts:

```
sh /config/nginx-retry-patch.sh || echo "[retry-button] nginx patch skipped"; exec sh -c "nginx && pnpm run pm2"
```

Watch for `[retry-button] nginx.conf patched` (or `already patched`) in the
container logs on boot.

## Install / reinstall

Needed only if the `postiz-config` volume is ever wiped, or after editing
`retry-button.js`:

```sh
docker cp /opt/clipmagic/postiz-retry/retry-button.js      clipmagic-postiz-1:/config/retry-button.js
docker cp /opt/clipmagic/postiz-retry/nginx-retry-patch.sh clipmagic-postiz-1:/config/nginx-retry-patch.sh
docker exec clipmagic-postiz-1 sh -lc 'chmod +x /config/nginx-retry-patch.sh; sh /config/nginx-retry-patch.sh; nginx -t && nginx -s reload'
```

Editing only `retry-button.js` needs just the first `docker cp` (nginx serves it
with `Cache-Control: no-cache`; hard-reload the browser).

**Do not** `docker compose restart postiz` for this — that also bounces the
orchestrator and risks the silent Temporal-poller hang. `nginx -s reload` is
enough, and never touches the backend or orchestrator processes.

## Fail-safe behaviour

- Anchors missing in `nginx.conf` (i.e. a Postiz upgrade moved things): the
  patch prints `anchors not found — skipped` and changes nothing.
- Patched config fails `nginx -t`: reverted, Postiz boots unaffected.
  A backup is left at `/etc/nginx/nginx.conf.pre-retry.bak`.
- `/config/retry-button.js` missing: the injected tag 404s and the page is
  otherwise untouched.
- Not logged in: the retry pill's first API call 401s and it mounts nothing;
  the reconnect observer never sees a channel menu, so it adds nothing.
- The ⋯ menu markup changes shape in a Postiz upgrade: the recogniser stops
  matching and simply adds no item — Postiz's own menu is untouched.

## Uninstall

```sh
docker exec clipmagic-postiz-1 sh -lc 'cp /etc/nginx/nginx.conf.pre-retry.bak /etc/nginx/nginx.conf && nginx -t && nginx -s reload'
```

and remove the `sh /config/nginx-retry-patch.sh || ...` fragment from the
`postiz` entrypoint in `../docker-compose.yml`
(backup: `../docker-compose.yml.pre-retrybutton.bak`).
