/*
 * Postiz — Retry failed posts.
 *
 * Injected into every Postiz HTML page by an nginx `sub_filter` (see
 * /config/nginx-retry-patch.sh, wired into the `postiz` service entrypoint in
 * /opt/clipmagic/docker-compose.yml) and served from /config/retry-button.js
 * on the `postiz-config` volume.
 *
 * Why an injected script and not a real button in calendar.tsx: the postiz-app
 * image ships a prebuilt .next, so a source edit needs a full in-container
 * frontend rebuild (~10min, 2GB+ on a box that has already hung the
 * orchestrator under memory pressure) and would be erased by the next image
 * pull. This survives restarts, recreations and upgrades.
 *
 * There is NO backend change. Retrying a post is an existing endpoint:
 *   PUT /api/posts/:id/date  {date: <now, UTC>, action: 'schedule'}
 * which flips the post ERROR -> QUEUE, clears releaseId/releaseURL, and
 * restarts the `postWorkflowV105` Temporal workflow (workflowId `post_<id>`,
 * conflict policy TERMINATE_EXISTING, so it is safe to click twice). The
 * workflow sleeps 0ms when publishDate is in the past, so it fires at once.
 */
(function () {
  'use strict';

  if (window.__postizRetry) return;
  window.__postizRetry = true;

  var API = '/api';
  var LOOKBACK_DAYS = 90; // how far back we scan for failed posts
  var LOOKAHEAD_DAYS = 14;
  var POLL_MS = 60000;

  var state = { posts: [], open: false, busy: false };
  var els = {};

  // ── helpers ──────────────────────────────────────────────────────────────

  function api(path, opts) {
    return fetch(API + path, Object.assign(
      { credentials: 'include', headers: { 'Content-Type': 'application/json' } },
      opts || {}
    ));
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  // The backend parses this with dayjs() and the container runs UTC, so a
  // UTC wall-clock string with no zone is what the calendar's own drag/drop
  // sends too (calendar.tsx: getDate.utc().format('YYYY-MM-DDTHH:mm:ss')).
  function utcNowString() {
    var d = new Date();
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  }

  function localTime(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return iso; }
  }

  function stripHtml(html) {
    var d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  // Post.error is a String column holding a serialised Temporal failure, e.g.
  // {"cause":{"failure":{"message":"Token expired…","applicationFailureInfo":
  // {"type":"refresh_token"}}},"failure":{…}} — dig out the human sentence and
  // the failure type instead of dumping 2KB of stack trace at the user.
  function describeError(raw) {
    if (!raw) return { message: 'No error message recorded.', type: null };
    try {
      var j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      var c = j.cause || {};
      var f = c.failure || {};
      var afi = f.applicationFailureInfo || c.applicationFailureInfo || {};
      var message = f.message || c.message ||
        (j.failure && j.failure.cause && j.failure.cause.message) || j.message;
      return { message: message || truncate(String(raw), 220), type: c.type || afi.type || null };
    } catch (e) {
      return { message: truncate(String(raw), 220), type: null };
    }
  }

  // /api/posts is key-minified (libraries/helpers/src/utils/posts.list.minify.ts).
  function expand(p) {
    return {
      id: p.i,
      content: p.c,
      publishDate: p.d,
      releaseURL: p.u,
      releaseId: p.ri,
      state: p.s,
      integration: p.n ? { id: p.n.i, provider: p.n.pi, name: p.n.n, picture: p.n.p } : null
    };
  }

  // ── data ─────────────────────────────────────────────────────────────────

  function loadFailed() {
    var start = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
    var end = new Date(Date.now() + LOOKAHEAD_DAYS * 86400000).toISOString();
    return api('/posts?startDate=' + encodeURIComponent(start) + '&endDate=' + encodeURIComponent(end))
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (j) {
        var seen = {};
        var known = {};
        state.posts.forEach(function (p) { known[p.id] = p; });

        var failed = [];
        (j.p || []).forEach(function (raw) {
          var p = expand(raw);
          // Repeating posts come back expanded into one entry per occurrence.
          if (p.state !== 'ERROR' || seen[p.id]) return;
          seen[p.id] = true;
          // Keep the error text we already fetched for this post.
          if (known[p.id]) p.errorInfo = known[p.id].errorInfo;
          failed.push(p);
        });
        failed.sort(function (a, b) { return new Date(b.publishDate) - new Date(a.publishDate); });
        state.posts = failed;
        return failed;
      });
  }

  // The calendar endpoint doesn't select `error`, so pull the text per post
  // from GET /api/posts/:id, which returns the full row.
  function loadError(post) {
    if (post.errorInfo) return Promise.resolve(post);
    return api('/posts/' + post.id)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        post.errorInfo = describeError(j && j.posts && j.posts[0] && j.posts[0].error);
        return post;
      })
      .catch(function () {
        post.errorInfo = { message: 'Could not load the error message.', type: null };
        return post;
      });
  }

  function retry(post) {
    return api('/posts/' + post.id + '/date', {
      method: 'PUT',
      body: JSON.stringify({ date: utcNowString(), action: 'schedule' })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return true;
    });
  }

  // ── ui ───────────────────────────────────────────────────────────────────

  var CSS = [
    '#pzr-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:none;',
    'align-items:center;gap:8px;padding:10px 14px;border-radius:999px;border:1px solid #612bd3;',
    'background:#1a1a2e;color:#fff;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;',
    'cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.45)}',
    '#pzr-fab:hover{background:#252545}',
    '#pzr-fab .pzr-dot{display:inline-flex;align-items:center;justify-content:center;min-width:18px;',
    'height:18px;padding:0 5px;border-radius:999px;background:#ef4444;color:#fff;font-size:11px}',
    '#pzr-panel{position:fixed;right:18px;bottom:72px;z-index:2147483000;width:390px;max-width:calc(100vw - 36px);',
    'max-height:min(560px,calc(100vh - 120px));display:none;flex-direction:column;border-radius:12px;',
    'border:1px solid #2f2f4a;background:#12121f;color:#e8e8f0;',
    'font:400 13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.55);overflow:hidden}',
    '#pzr-panel.pzr-open{display:flex}',
    '.pzr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;',
    'border-bottom:1px solid #2f2f4a;font-weight:600}',
    '.pzr-head button{background:none;border:none;color:#9a9ab5;cursor:pointer;font-size:12px;padding:2px 4px}',
    '.pzr-head button:hover{color:#fff}',
    '.pzr-body{overflow-y:auto;padding:6px 0;flex:1}',
    '.pzr-row{padding:10px 14px;border-bottom:1px solid #22223a}',
    '.pzr-row:last-child{border-bottom:none}',
    '.pzr-meta{display:flex;align-items:center;gap:7px;color:#b9b9d0;font-size:12px;margin-bottom:4px}',
    '.pzr-meta img{width:16px;height:16px;border-radius:50%;object-fit:cover}',
    '.pzr-meta b{color:#fff;font-weight:600}',
    '.pzr-content{color:#e8e8f0;margin-bottom:5px;word-break:break-word}',
    '.pzr-err{color:#ff8f8f;font-size:12px;word-break:break-word;margin-bottom:6px}',
    '.pzr-type{display:inline-block;margin-right:6px;padding:1px 6px;border-radius:4px;',
    'background:#3a1f1f;color:#ffb4b4;font-size:11px;font-weight:600}',
    '.pzr-hint{color:#fbbf24;font-size:12px;margin-bottom:7px}',
    '.pzr-warn{color:#fbbf24;font-size:12px;margin-bottom:7px}',
    '.pzr-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:26px}',
    '.pzr-btn{border:1px solid #612bd3;background:#612bd3;color:#fff;border-radius:7px;padding:5px 12px;',
    'font:600 12px/1 system-ui,sans-serif;cursor:pointer}',
    '.pzr-btn:hover:not(:disabled){background:#7139f0}',
    '.pzr-btn:disabled{opacity:.5;cursor:default}',
    '.pzr-ok{color:#4ade80;font-size:12px;font-weight:600}',
    '.pzr-foot{padding:10px 14px;border-top:1px solid #2f2f4a;display:flex;justify-content:space-between;',
    'align-items:center;gap:8px}',
    '.pzr-note{color:#8f8fa8;font-size:12px}',
    '.pzr-empty{padding:22px 14px;text-align:center;color:#8f8fa8}'
  ].join('');

  function mount() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var fab = document.createElement('button');
    fab.id = 'pzr-fab';
    fab.type = 'button';
    fab.innerHTML = '<span>&#8635; Failed</span><span class="pzr-dot">0</span>';
    fab.addEventListener('click', function () { toggle(); });

    var panel = document.createElement('div');
    panel.id = 'pzr-panel';
    panel.innerHTML =
      '<div class="pzr-head"><span>Failed posts</span>' +
      '<span><button type="button" data-pzr="refresh" title="Refresh">&#8635; Refresh</button>' +
      '<button type="button" data-pzr="close" title="Close">&#10005;</button></span></div>' +
      '<div class="pzr-body"></div>' +
      '<div class="pzr-foot"><span class="pzr-note"></span>' +
      '<button type="button" class="pzr-btn" data-pzr="retry-all">Retry all</button></div>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    els.fab = fab;
    els.dot = fab.querySelector('.pzr-dot');
    els.panel = panel;
    els.body = panel.querySelector('.pzr-body');
    els.note = panel.querySelector('.pzr-note');
    els.retryAll = panel.querySelector('[data-pzr="retry-all"]');

    panel.querySelector('[data-pzr="close"]').addEventListener('click', function () { toggle(false); });
    panel.querySelector('[data-pzr="refresh"]').addEventListener('click', function () {
      els.note.textContent = 'Refreshing…';
      refresh().then(function () { els.note.textContent = ''; render(); });
    });
    els.retryAll.addEventListener('click', retryAll);
  }

  function toggle(force) {
    state.open = force === undefined ? !state.open : force;
    els.panel.classList.toggle('pzr-open', state.open);
    if (state.open) render();
  }

  function renderRow(post) {
    var row = document.createElement('div');
    row.className = 'pzr-row';

    var name = post.integration ? (post.integration.name || post.integration.provider || 'channel') : 'channel';

    var meta = document.createElement('div');
    meta.className = 'pzr-meta';
    if (post.integration && post.integration.picture) {
      var img = document.createElement('img');
      img.src = post.integration.picture;
      img.alt = '';
      img.addEventListener('error', function () { img.style.display = 'none'; });
      meta.appendChild(img);
    }
    var nameEl = document.createElement('b');
    nameEl.textContent = name;
    meta.appendChild(nameEl);
    var when = document.createElement('span');
    when.textContent = '· ' + localTime(post.publishDate);
    meta.appendChild(when);
    row.appendChild(meta);

    var content = document.createElement('div');
    content.className = 'pzr-content';
    content.textContent = truncate(stripHtml(post.content), 110) || '(no text)';
    row.appendChild(content);

    // A post that already has a release id went out at least once — retrying it
    // would publish a duplicate, so say so rather than failing silently.
    if (post.releaseId && post.releaseId !== 'missing') {
      var warn = document.createElement('div');
      warn.className = 'pzr-warn';
      warn.textContent = '⚠ This post has a release id — it may already be live. Retrying could double-post.';
      row.appendChild(warn);
    }

    var err = document.createElement('div');
    err.className = 'pzr-err';
    row.appendChild(err);

    var hint = document.createElement('div');
    hint.className = 'pzr-hint';
    hint.style.display = 'none';
    row.appendChild(hint);

    function paintError() {
      var info = post.errorInfo || { message: 'Loading error…', type: null };
      err.textContent = '';
      if (info.type) {
        var chip = document.createElement('span');
        chip.className = 'pzr-type';
        chip.textContent = info.type;
        err.appendChild(chip);
      }
      err.appendChild(document.createTextNode(info.message));
      // A refresh_token failure means the channel's OAuth token is dead: the
      // post workflow refreshes lazily on retry, but if the stored refresh
      // token is gone only a reconnect in Settings will fix it.
      if (info.type === 'refresh_token') {
        hint.style.display = '';
        hint.textContent = 'Token problem — if the retry fails again, reconnect this channel first.';
      }
    }
    paintError();

    var actions = document.createElement('div');
    actions.className = 'pzr-actions';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pzr-btn';
    btn.textContent = 'Retry';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Retrying…';
      retry(post).then(function () {
        actions.innerHTML = '';
        var ok = document.createElement('span');
        ok.className = 'pzr-ok';
        ok.textContent = '✓ Queued to post now';
        actions.appendChild(ok);
        setTimeout(function () { refresh().then(render); }, 10000);
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = 'Retry';
        err.textContent = 'Retry failed: ' + e.message;
      });
    });
    actions.appendChild(btn);
    row.appendChild(actions);

    if (!post.errorInfo) loadError(post).then(paintError);

    return row;
  }

  function render() {
    els.dot.textContent = state.posts.length;
    els.fab.style.display = state.posts.length ? 'inline-flex' : 'none';
    if (!state.posts.length && state.open) toggle(false);
    if (!state.open) return;

    els.body.innerHTML = '';
    if (!state.posts.length) {
      var empty = document.createElement('div');
      empty.className = 'pzr-empty';
      empty.textContent = 'No failed posts in the last ' + LOOKBACK_DAYS + ' days.';
      els.body.appendChild(empty);
    } else {
      state.posts.forEach(function (p) { els.body.appendChild(renderRow(p)); });
    }
    els.retryAll.textContent = 'Retry all (' + state.posts.length + ')';
    els.retryAll.disabled = state.busy || !state.posts.length;
  }

  function retryAll() {
    if (!state.posts.length || state.busy) return;
    var list = state.posts.slice();
    if (!window.confirm('Retry ' + list.length + ' failed post' + (list.length === 1 ? '' : 's') +
        ' now?\n\nAny post that already has a release id may be published twice.')) return;

    state.busy = true;
    els.retryAll.disabled = true;
    var total = list.length, done = 0, failed = 0;

    (function next() {
      var post = list.shift();
      if (!post) {
        state.busy = false;
        els.note.textContent = 'Retried ' + done + (failed ? ' · ' + failed + ' failed' : '');
        setTimeout(function () { refresh().then(render); }, 10000);
        return;
      }
      els.note.textContent = 'Retrying ' + (done + failed + 1) + '/' + total + '…';
      retry(post).then(function () { done++; }, function () { failed++; })
        .then(function () { setTimeout(next, 400); });
    })();
  }

  function refresh() {
    return loadFailed().catch(function () { state.posts = []; return []; });
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  function start() {
    // Not logged in (or on /auth): the first call 401s and we mount nothing.
    loadFailed().then(function () {
      mount();
      render();
      setInterval(function () { refresh().then(render); }, POLL_MS);
    }).catch(function () { /* no UI at all */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();


/* ═════════════════════════════════════════════════════════════════════════
 * Postiz — "Reconnect channel", always available.
 *
 * Second, independent feature in the same injected file (one file = one
 * `docker cp` to deploy; see the header above for why this is injected at all).
 * Nothing below touches the "Retry failed posts" feature and vice versa.
 *
 * The problem it fixes
 * --------------------
 * Postiz gates BOTH ways into the OAuth reconnect flow on
 * `integration.refreshNeeded`:
 *   - launches.component.tsx: the channel avatar only becomes clickable
 *     ("Channel disconnected, click to reconnect") when refreshNeeded;
 *   - menu.tsx: the "Reconnect channel" item renders only when
 *     `canDisable && refreshNeeded && !customFields`.
 * A *successful* reconnect clears refreshNeeded, so the control that let you
 * reconnect vanishes — and there is no other route back into Google consent.
 * That matters here because a YouTube refresh token can be revoked or wiped
 * without Postiz noticing, and re-granting offline access is the only fix.
 *
 * What it does
 * ------------
 * Adds a "Reconnect channel" row to the channel's ⋯ menu whenever Postiz
 * itself is not already showing one, and calls the exact endpoint Postiz's own
 * gated button calls — no backend change, no new privilege:
 *
 *   GET /api/integrations/social/<identifier>?refresh=<internalId>   ->  {url}
 *
 * (IntegrationsController.getIntegrationUrl, `@Get('/social/:integration')`
 * + `@Query('refresh')`.) The `refresh` query parameter is what makes it a
 * *reconnect* rather than an "add channel": the backend stores
 * `refresh:<state>` in Redis for an hour, and the callback then updates that
 * existing integration instead of creating a second one. The returned Google
 * URL already carries access_type=offline&prompt=consent and
 * redirect_uri=<FRONTEND_URL>/integrations/social/youtube, so a completed
 * consent hands Postiz a fresh refresh token.
 *
 * We only navigate to Google — the consent itself is the user's to give.
 *
 * How it hooks the DOM without a brittle selector
 * -----------------------------------------------
 * The menu is client-rendered, so there is nothing to hook in the served HTML.
 * A MutationObserver watches for the dropdown appearing and identifies it
 * *structurally and by text* — a position:fixed div whose children are all
 * icon+label rows, carrying at least two of Postiz's own menu labels ("Copy
 * Channel ID", "Edit Time Slots", "Delete", …). It then clones a sibling row's
 * classes for the new item, so it inherits whatever Tailwind classes the build
 * happens to emit rather than hardcoding them.
 *
 * Which channel the open menu belongs to is resolved in three ways, best
 * first: (1) the React fiber on the surrounding row, which carries the real
 * `integration` object; (2) the provider icon + channel name in the row,
 * matched against GET /api/integrations/list; (3) the avatar picture URL.
 * If none of them identify a channel we refuse to act and say so.
 *
 * The new row is appended at the END of the menu on purpose: React's
 * reconciler positions its own children relative to nodes it knows about, so a
 * trailing foreign node survives re-renders without being reordered.
 */
(function () {
  'use strict';

  if (window.__postizReconnect) return;
  window.__postizReconnect = true;

  var API = '/api';
  var LABEL = 'Reconnect channel';

  // The same icon Postiz uses for its own (gated) reconnect item, so the row we
  // add is indistinguishable from the one it hides.
  var ICON_PATH = 'M3.00079 15.9999C3.00343 13.6138 3.95249 11.3262 5.63975 9.63891C7.327 7.95165 9.61465 7.00259 12.0008 6.99995H25.587L24.2933 5.70745C24.1056 5.5198 24.0002 5.26531 24.0002 4.99995C24.0002 4.73458 24.1056 4.48009 24.2933 4.29245C24.4809 4.1048 24.7354 3.99939 25.0008 3.99939C25.2661 3.99939 25.5206 4.10481 25.7083 4.29245L28.7083 7.29245C28.8013 7.38532 28.875 7.49561 28.9253 7.61701C28.9757 7.7384 29.0016 7.86853 29.0016 7.99995C29.0016 8.13136 28.9757 8.26149 28.9253 8.38289C28.875 8.50428 28.8013 8.61457 28.7083 8.70745L25.7083 11.7074C25.5206 11.8951 25.2661 12.0005 25.0008 12.0005C24.7354 12.0005 24.4809 11.8951 24.2933 11.7074C24.1056 11.5198 24.0002 11.2653 24.0002 10.9999C24.0002 10.7346 24.1056 10.4801 24.2933 10.2924L25.587 8.99995H12.0008C10.1449 9.00193 8.36556 9.74007 7.05323 11.0524C5.74091 12.3647 5.00277 14.144 5.00079 15.9999C5.00079 16.2652 4.89543 16.5195 4.70789 16.7071C4.52036 16.8946 4.266 16.9999 4.00079 16.9999C3.73557 16.9999 3.48122 16.8946 3.29368 16.7071C3.10614 16.5195 3.00079 16.2652 3.00079 15.9999ZM28.0008 14.9999C27.7356 14.9999 27.4812 15.1053 27.2937 15.2928C27.1061 15.4804 27.0008 15.7347 27.0008 15.9999C26.9988 17.8559 26.2607 19.6352 24.9483 20.9475C23.636 22.2598 21.8567 22.998 20.0008 22.9999H6.41454L7.70829 21.7074C7.8012 21.6145 7.8749 21.5042 7.92518 21.3828C7.97546 21.2614 8.00134 21.1313 8.00134 20.9999C8.00134 20.8686 7.97546 20.7384 7.92518 20.6171C7.8749 20.4957 7.8012 20.3854 7.70829 20.2924C7.61538 20.1995 7.50508 20.1258 7.38368 20.0756C7.26229 20.0253 7.13218 19.9994 7.00079 19.9994C6.86939 19.9994 6.73928 20.0253 6.61789 20.0756C6.4965 20.1258 6.3862 20.1995 6.29329 20.2924L3.29329 23.2924C3.20031 23.3853 3.12655 23.4956 3.07623 23.617C3.0259 23.7384 3 23.8685 3 23.9999C3 24.1314 3.0259 24.2615 3.07623 24.3829C3.12655 24.5043 3.20031 24.6146 3.29329 24.7074L6.29329 27.7074C6.3862 27.8004 6.4965 27.8741 6.61789 27.9243C6.73928 27.9746 6.86939 28.0005 7.00079 28.0005C7.13218 28.0005 7.26229 27.9746 7.38368 27.9243C7.50508 27.8741 7.61538 27.8004 7.70829 27.7074C7.8012 27.6145 7.8749 27.5042 7.92518 27.3828C7.97546 27.2614 8.00134 27.1313 8.00134 26.9999C8.00134 26.8686 7.97546 26.7384 7.92518 26.6171C7.8749 26.4957 7.8012 26.3854 7.70829 26.2924L6.41454 24.9999H20.0008C22.3869 24.9973 24.6746 24.0482 26.3618 22.361C28.0491 20.6737 28.9981 18.3861 29.0008 15.9999C29.0008 15.7347 28.8954 15.4804 28.7079 15.2928C28.5204 15.1053 28.266 14.9999 28.0008 14.9999Z';

  // Menu labels Postiz renders itself. Used only to recognise the dropdown —
  // several are unconditional ("Copy Channel ID", "Edit Time Slots",
  // "Move / add to customer", "Delete"), so two hits is a confident match.
  var MENU_LABELS = [
    'copy channel id', 'edit time slots', 'move / add to customer', 'delete',
    'disable channel', 'enable channel', 'additional settings',
    'create a new post', 'update credentials'
  ];

  var integrations = null;   // cache of /api/integrations/list
  var inflight = null;

  // ── data ────────────────────────────────────────────────────────────────

  function loadIntegrations() {
    if (inflight) return inflight;
    inflight = fetch(API + '/integrations/list', { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (j) {
        integrations = (j && j.integrations) || [];
        inflight = null;
        return integrations;
      })
      .catch(function (e) { inflight = null; throw e; });
    return inflight;
  }

  // Exactly what launches.component.tsx's refreshChannel() does.
  function reconnect(integration) {
    var url = API + '/integrations/social/' + encodeURIComponent(integration.identifier) +
      '?refresh=' + encodeURIComponent(integration.internalId);
    return fetch(url, { method: 'GET', credentials: 'include' }).then(function (r) {
      return r.text().then(function (text) {
        var j = null;
        try { j = JSON.parse(text); } catch (e) { /* not json */ }
        if (!r.ok) throw new Error('the server returned HTTP ' + r.status);
        // getIntegrationUrl swallows provider errors and answers {err:true}.
        if (!j || !j.url) {
          throw new Error(j && j.err
            ? 'Postiz could not build an OAuth URL for ' + integration.identifier
            : 'no URL in the response');
        }
        window.location.href = j.url;
        return j.url;
      });
    });
  }

  // ── which channel is this menu for? ──────────────────────────────────────

  // 1. The React fiber. The channel row is rendered by MenuComponent, whose
  //    props hold the whole integration (identifier + internalId included).
  function fromFiber(el) {
    for (var node = el; node && node !== document.body; node = node.parentNode) {
      var key = null;
      for (var k in node) {
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
          key = k;
          break;
        }
      }
      if (!key) continue;
      for (var f = node[key], hops = 0; f && hops < 40; f = f.return, hops++) {
        var p = f.memoizedProps;
        var i = p && p.integration;
        if (i && i.identifier && i.internalId) return i;
      }
    }
    return null;
  }

  // The channel row: the nearest ancestor that also contains the drag handle
  // carrying the channel name (role="Handle" in launches.component.tsx).
  function rowOf(el) {
    for (var n = el; n && n !== document.body; n = n.parentNode) {
      if (n.querySelector && n.querySelector('[role="Handle"]')) return n;
    }
    return null;
  }

  function srcOf(img) {
    var s = img.getAttribute('src') || '';
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    return s;
  }

  // 2 + 3. Provider icon / avatar alt gives the identifier, the handle gives
  //        the name, the avatar URL disambiguates same-named channels.
  function fromDom(el) {
    if (!integrations || !integrations.length) return null;
    var row = rowOf(el);
    if (!row) return null;

    var handle = row.querySelector('[role="Handle"]');
    var name = handle ? (handle.textContent || '').trim() : '';

    var identifier = '';
    var imgs = row.querySelectorAll('img');
    for (var i = 0; i < imgs.length && !identifier; i++) {
      var m = /\/icons\/platforms\/([a-z0-9_.-]+)\.(png|svg|jpg)/i.exec(srcOf(imgs[i]));
      if (m) identifier = m[1];
    }
    if (!identifier) {
      for (var a = 0; a < imgs.length && !identifier; a++) {
        var alt = imgs[a].getAttribute('alt') || '';
        if (alt && alt !== 'no-picture') identifier = alt;
      }
    }

    var list = integrations.slice();
    if (identifier) {
      list = list.filter(function (x) { return x.identifier === identifier; });
    }
    if (list.length > 1 && name) {
      var byName = list.filter(function (x) { return (x.name || '').trim() === name; });
      if (byName.length) list = byName;
    }
    if (list.length > 1) {
      var html = row.innerHTML;
      var byPic = list.filter(function (x) {
        return x.picture && (html.indexOf(x.picture) >= 0 ||
          html.indexOf(encodeURIComponent(x.picture)) >= 0);
      });
      if (byPic.length) list = byPic;
    }
    return list.length === 1 ? list[0] : null;
  }

  function resolve(el) {
    var i = null;
    try { i = fromFiber(el); } catch (e) { /* React internals moved — fall through */ }
    if (i) return i;
    try { return fromDom(el); } catch (e) { return null; }
  }

  // ── recognising the dropdown ─────────────────────────────────────────────

  function looksLikeChannelMenu(el) {
    if (!el || el.nodeType !== 1 || el.tagName !== 'DIV') return false;
    var kids = el.children;
    if (kids.length < 3 || kids.length > 20) return false;
    var pos;
    try { pos = window.getComputedStyle(el).position; } catch (e) { return false; }
    if (pos !== 'fixed') return false;

    var labelHits = 0, rowShaped = 0;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.tagName !== 'DIV') return false;
      // Every Postiz menu item is <div><div><svg/></div><div>label</div></div>.
      if (k.children.length === 2 && k.querySelector('svg')) rowShaped++;
      var t = (k.textContent || '').trim().toLowerCase();
      if (t && MENU_LABELS.indexOf(t) >= 0) labelHits++;
    }
    if (rowShaped !== kids.length) return false;
    return { labelHits: labelHits };
  }

  // ── the item ─────────────────────────────────────────────────────────────

  function makeIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('fill', 'yellow');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICON_PATH);
    path.setAttribute('fill', 'yellow');
    svg.appendChild(path);
    return svg;
  }

  var toastEl = null;
  var toastTimer = null;

  function toast(message, kind) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);' +
        'z-index:2147483001;max-width:min(560px,calc(100vw - 32px));padding:10px 16px;' +
        'border-radius:10px;font:600 13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;' +
        'box-shadow:0 8px 30px rgba(0,0,0,.5);display:none';
      document.body.appendChild(toastEl);
    }
    toastEl.style.background = kind === 'ok' ? '#14532d' : '#4c1111';
    toastEl.style.color = kind === 'ok' ? '#bbf7d0' : '#ffd4d4';
    toastEl.style.border = '1px solid ' + (kind === 'ok' ? '#22c55e' : '#ef4444');
    toastEl.textContent = message;
    toastEl.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.display = 'none'; }, 9000);
  }

  function alreadyHasOurLabel(menu) {
    var kids = menu.children;
    for (var i = 0; i < kids.length; i++) {
      if ((kids[i].textContent || '').trim().toLowerCase() === LABEL.toLowerCase()) return true;
    }
    return false;
  }

  function inject(menu, shape) {
    if (menu.querySelector('[data-pzc-item]')) return;      // ours is already there
    if (alreadyHasOurLabel(menu)) return;                    // Postiz is showing its own

    var integration = resolve(menu);
    // Refuse to guess: only mount when we know the channel, or when the menu
    // is unmistakably Postiz's (2+ of its own labels) and we can retry the
    // lookup on click.
    if (!integration && shape.labelHits < 2) return;
    // Custom-field providers (generic/webhook style) don't do OAuth — Postiz
    // offers "Update Credentials" for those instead, so leave them alone.
    if (integration && (integration.isCustomFields || integration.customFields)) return;

    var tpl = menu.children[menu.children.length - 1];
    var item = document.createElement('div');
    item.setAttribute('data-pzc-item', '1');
    item.className = tpl.className || 'flex gap-[12px] items-center py-[8px] px-[10px]';
    item.style.cursor = 'pointer';

    var iconWrap = document.createElement('div');
    iconWrap.appendChild(makeIcon());

    var label = document.createElement('div');
    label.className = (tpl.children[1] && tpl.children[1].className) || 'text-[14px]';
    label.textContent = LABEL;

    item.appendChild(iconWrap);
    item.appendChild(label);

    item.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (item.getAttribute('data-busy')) return;

      var target = integration || resolve(menu);
      if (!target) {
        toast('Reconnect: could not work out which channel this menu belongs to. ' +
          'Reload the page and try again.');
        return;
      }
      item.setAttribute('data-busy', '1');
      label.textContent = 'Opening consent…';
      reconnect(target).catch(function (err) {
        item.removeAttribute('data-busy');
        label.textContent = LABEL;
        toast('Reconnect failed for "' + (target.name || target.identifier) + '": ' +
          (err && err.message ? err.message : err));
      });
    }, true);

    menu.appendChild(item);   // trailing, so React re-renders don't reorder it
  }

  function consider(el) {
    var shape = looksLikeChannelMenu(el);
    if (shape) inject(el, shape);
  }

  function sweep(root) {
    if (!root || !root.querySelectorAll) return;
    consider(root);
    var divs = root.querySelectorAll('div');
    var max = Math.min(divs.length, 600);
    for (var i = 0; i < max; i++) consider(divs[i]);
  }

  // ── boot ─────────────────────────────────────────────────────────────────

  function start() {
    // Warm the cache for the DOM fallback. A 401 just means "not logged in";
    // the observer still costs nothing and the fiber path can still work.
    loadIntegrations().catch(function () { integrations = []; });
    setInterval(function () { loadIntegrations().catch(function () {}); }, 300000);

    new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          if (added[j] && added[j].nodeType === 1) sweep(added[j]);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    // Belt and braces: if a dropdown somehow predates the observer, catch it
    // just after the click that opened it.
    document.addEventListener('click', function () {
      setTimeout(function () {
        var els = document.querySelectorAll('div[class*="fixed"]');
        for (var i = 0; i < els.length && i < 200; i++) consider(els[i]);
      }, 0);
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
