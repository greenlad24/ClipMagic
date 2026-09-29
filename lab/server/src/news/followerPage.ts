/**
 * AI News Stream — the follower teleprompter (phone / tablet), as one
 * self-contained page.
 *
 * The follower link is public by design (the link is the key), but the Lab's
 * app bundle sits behind sign-in. Rather than open the whole bundle, the
 * follower view is served on its own: this page plus the narrow read in
 * `followerRouter`. It is the app's follower mode, behaviour for behaviour:
 *   · polls the session every 200 ms and applies only NEWER revisions
 *   · slide change → back to the top
 *   · between position updates it keeps gliding at the presenter's estimated
 *     speed; big jumps snap, small ones ease; never backwards while playing
 *   · resyncs when the device wakes / the tab becomes visible
 *   · read-only; "Mirror" is local to THIS TAB (sessionStorage, not local)
 */
export const FOLLOWER_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<title>Teleprompter</title>
<style>
  html, body { margin: 0; height: 100%; background: #080808; }
  body { font-family: system-ui, sans-serif; user-select: none; -webkit-user-select: none; }
  #root { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  #scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; position: relative; }
  #scroll::-webkit-scrollbar { display: none; }
  #pill-wrap { position: sticky; top: 14px; z-index: 10; display: flex; justify-content: center; pointer-events: none; }
  #pill { background: rgba(8,8,8,0.92); border: 1px solid #252525; border-radius: 99px; padding: 4px 18px; font-size: 12px;
          font-family: monospace; font-weight: 600; letter-spacing: 0.04em; color: #555; transition: all .2s; }
  /* ⚠️ THE PRESENTER'S VIEW HAS A TOPBAR AND THIS PAGE DOES NOT, so with the
     same padding the follower's script started 45px higher and the two screens
     opened on different lines — which looks exactly like a sync fault and is
     not one. The offset below reserves the presenter topbar's height so both
     screens begin at the same place. If that bar's height changes, change this
     with it; they are one measurement expressed in two files. */
  /* MEASURED, not assumed: with this at 45px the follower sat 16px LOW,
     because its own label block is shorter than the presenter's. 29px is
     what puts the first line of script at the same y on both screens. */
  :root { --presenter-topbar: 29px; }
  /* ⚠️ BORDER-BOX, TO MATCH THE APP. The Lab's CSS sets border-box globally, so
     a max-width of 420 there is a 420px BOX (340px of text inside 40px padding
     each side). This page defaulted to content-box, making the same setting a
     420px TEXT column — 80px wider, wrapping at different words. The fonts
     matched and the lines still did not. */
  *, *::before, *::after { box-sizing: border-box; }
  #script { margin: 0 auto; padding: calc(56px + var(--presenter-topbar)) 40px 0; }
  /* ⚠️ MUST MATCH TeleprompterPage's SCRIPT_FONT EXACTLY — see the note there.
     system-ui is a different font per platform, so the monitor and the phone
     wrapped the same script at different words. The letter-spacing matters for
     the same reason: it was set on the app's paragraphs and not on these, so
     the two screens broke lines differently even on identical fonts. */
/*
   * ⚠️ THE SCRIPT FONT IS SELF-HOSTED, AND THAT IS THE WHOLE POINT. Any
   * platform-resolved stack — system-ui, or even Arial, which Android maps to
   * Roboto — is a different set of glyph widths on a different device, so the
   * same script wraps at different words and two screens show different lines
   * while their scroll positions agree perfectly. One font file, served from
   * this origin, is the only way every screen breaks the text identically.
   *
   * Inter, variable weight, latin subset, OFL. Served from /news-fonts, which is
   * public because the follower page is.
   */
  @font-face {
    font-family: 'NewsScript';
    src: url('/news-fonts/inter-var.woff2') format('woff2');
    font-weight: 100 900;
    font-style: normal;
    /* swap: the show must start even if the font is slow — it reflows once. */
    font-display: swap;
  }
  
  .para { font-family: 'NewsScript', Arial, Helvetica, sans-serif;
          letter-spacing: 0.012em; font-weight: 400;
          -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  #label { font-size: 11px; color: #555; letter-spacing: .08em; text-transform: uppercase; margin: 0 0 36px; font-weight: 700; }
  .para { color: #fff; letter-spacing: .012em; font-weight: 400; margin: 0; }
  #empty { text-align: center; margin-top: 80px; }
  #empty p:first-child { font-size: 20px; color: #555; margin: 0; }
  #empty p:last-child { font-size: 14px; color: #1e1e1e; margin: 8px 0 0; }
  #spacer { height: 75vh; }
  #mirror { position: fixed; bottom: 16px; right: 16px; z-index: 20; display: flex; align-items: center; gap: 6px;
            background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
            padding: 8px 14px; cursor: pointer; color: rgba(255,255,255,0.3); font-size: 12px; font-weight: 600;
            transition: all .15s; -webkit-tap-highlight-color: transparent; }
  #mirror.on { background: rgba(96,165,250,0.15); border-color: rgba(96,165,250,0.4); color: #60a5fa; }
  .center { height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; }
  .center p { margin: 0; }
</style>
</head>
<body>
<div id="root"><div class="center"><p style="color:#555">Loading…</p></div></div>
<script src="/news-tp/socket.io/socket.io.js"></script>
<script>
(function () {
  var WIDTH_PX = { wide: 960, medium: 660, narrow: 420 };
  var PARA_SPLIT = /\n\s*\n/;
  var params = new URLSearchParams(location.search);
  var sessionId = params.get('session') || '';

  var slides = [];
  var state = { idx: 0, fontSize: 32, lineHeight: 1.9, width: 'medium', playing: false, autoscroll: false, speed: 12 };
  var lastSeq = 0;
  var connected = true;
  // ⚠️ sessionStorage, NOT localStorage. localStorage is shared by every tab on
  // the origin, so mirroring one follower flipped the next follower link opened
  // on the same device — and on a show being watched off two screens, the
  // second screen came up back-to-front for no reason the operator could see.
  // sessionStorage is scoped to this tab, so each screen decides for itself and
  // still survives a reload.
  var mirror = false;
  try { mirror = sessionStorage.getItem('tp2-mirror') === 'true'; } catch (e) {}

  // Follower position state: latest position from the controller, the
  // estimated velocity, when it arrived, and whether the controller is playing.
  var renderPos = 0;
  var lastFrameTs = null;

  var root = document.getElementById('root');
  var scrollEl, pillEl, scriptEl;

  function clampIndex(i, total) { return total <= 0 ? 0 : Math.max(0, Math.min(total - 1, i)); }

  function fetchState(withSlides) {
    return fetch('/news-follow/state?session=' + encodeURIComponent(sessionId) + (withSlides ? '&slides=1' : ''), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); });
  }

  function message(title, sub) {
    root.innerHTML = '<div class="center"><p style="color:#555;font-size:16px"></p><p style="color:#1e1e1e;font-size:13px"></p></div>';
    root.querySelectorAll('p')[0].textContent = title;
    root.querySelectorAll('p')[1].textContent = sub || '';
  }

  function build() {
    root.innerHTML =
      '<div id="scroll"><div id="pill-wrap"><div id="pill"></div></div><div id="script"></div></div>' +
      '<button id="mirror"><span style="font-size:14px">⇄</span><span id="mirror-label"></span></button>';
    scrollEl = document.getElementById('scroll');
    pillEl = document.getElementById('pill');
    scriptEl = document.getElementById('script');
    document.getElementById('mirror').addEventListener('click', function () {
      mirror = !mirror;
      try { sessionStorage.setItem('tp2-mirror', String(mirror)); } catch (e) {}
      renderScript(); renderMirror();
    });
    renderScript(); renderPill(); renderMirror();
  }

  function renderPill() {
    if (!pillEl) return;
    pillEl.textContent = connected ? '📡 Following the monitor' : '⚠ Reconnecting…';
    var blue = state.playing;
    pillEl.style.color = blue ? '#60a5fa' : '#555';
    pillEl.style.borderColor = blue ? 'rgba(96,165,250,0.35)' : '#252525';
  }

  function renderMirror() {
    var b = document.getElementById('mirror');
    if (!b) return;
    b.className = mirror ? 'on' : '';
    document.getElementById('mirror-label').textContent = mirror ? 'Mirrored' : 'Mirror';
  }

  function renderScript() {
    if (!scriptEl) return;
    var idx = clampIndex(state.idx, slides.length);
    var slide = slides[idx] || null;
    var raw = slide && typeof slide.teleprompterScript === 'string' ? slide.teleprompterScript : '';
    var paragraphs = raw.split(PARA_SPLIT).map(function (p) { return p.trim(); }).filter(Boolean);
    scriptEl.style.maxWidth = (WIDTH_PX[state.width] || 660) + 'px';
    scriptEl.style.transform = mirror ? 'scaleX(-1)' : '';
    scriptEl.innerHTML = '';
    var label = document.createElement('p');
    label.id = 'label';
    label.textContent = (idx + 1) + ' / ' + slides.length + (slide && slide.bestSourceName ? ' · ' + slide.bestSourceName : '');
    scriptEl.appendChild(label);
    if (paragraphs.length) {
      paragraphs.forEach(function (p) {
        var el = document.createElement('p');
        el.className = 'para';
        el.style.fontSize = state.fontSize + 'px';
        el.style.lineHeight = String(state.lineHeight);
        el.style.margin = '0 0 ' + Math.round(state.fontSize * 0.8) + 'px';
        el.textContent = p;
        scriptEl.appendChild(el);
      });
    } else {
      var empty = document.createElement('div');
      empty.id = 'empty';
      empty.innerHTML = '<p>No script for this slide.</p><p>Rebuild the deck to generate teleprompter scripts.</p>';
      scriptEl.appendChild(empty);
    }
    var spacer = document.createElement('div');
    spacer.id = 'spacer';
    scriptEl.appendChild(spacer);
  }

  function applyScrollPct(pct) {
    if (!scrollEl) return;
    var max = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (max <= 0) return;
    scrollEl.scrollTop = Math.max(0, Math.min(max, pct * max));
  }

  // Apply a session snapshot. Returns true if the layout changed.
  function applySettings(s) {
    var changed = false;
    function set(k, v) { if (state[k] !== v) { state[k] = v; changed = true; } }
    if (typeof s.tpPaused === 'boolean') set('playing', !s.tpPaused);
    if (typeof s.tpAutoscroll === 'boolean') set('autoscroll', s.tpAutoscroll);
    if (typeof s.tpFontSize === 'number') set('fontSize', s.tpFontSize);
    if (typeof s.tpLineHeight === 'number') set('lineHeight', s.tpLineHeight);
    if (s.tpWidth && WIDTH_PX[s.tpWidth]) set('width', s.tpWidth);
    // The presenter's speed number, so a play started FROM THIS SCREEN runs at
    // the pace the show is set to rather than the default.
    if (typeof s.tpSpeed === 'number') state.speed = s.tpSpeed;
    return changed;
  }

  /**
   * ⚠️ NO POLLING. This used to ask the server for the session 5×/sec and
   * estimate the presenter's velocity from successive samples — so the phone
   * was always a poll behind, and guessed the speed from noisy measurements.
   * Now the server broadcasts an ANCHOR and this solves the same equation the
   * presenter's screen solves, against a clock both have agreed on.
   */
  var sock = null;
  var serverOffset = 0;
  var bestRtt = Infinity;
  var sync = { position: 0, anchorTime: 0, isPlaying: false, rate: 0 };

  function syncClock() { if (sock) sock.emit('time-ping', Date.now()); }
  function burstSyncClock() {
    // A reconnect invalidates the old best sample — let a fresh burst win.
    bestRtt = Infinity;
    for (var i = 0; i < 5; i++) setTimeout(syncClock, i * 200);
  }

  function positionNow() {
    if (!sync.isPlaying) return sync.position;
    var serverNow = Date.now() + serverOffset;
    return Math.min(1, sync.position + sync.rate * (serverNow - sync.anchorTime));
  }

  function connectSocket() {
    if (typeof io === 'undefined') return; // script blocked: the page still reads
    sock = io('/news-tp', { path: '/news-tp/socket.io', query: { session: sessionId }, transports: ['websocket', 'polling'] });

    sock.on('connect', function () {
      connected = true; renderPill();
      burstSyncClock();                 // agree on the clock before trusting an anchor
      sock.emit('request-current-state');
    });
    sock.on('disconnect', function () { connected = false; renderPill(); });

    sock.on('time-pong', function (m) {
      var rtt = Date.now() - m.clientSendTime;
      if (rtt <= bestRtt) { bestRtt = rtt; serverOffset = (m.serverTime + rtt / 2) - Date.now(); }
    });

    function applySync(sn) {
      var slideChanged = typeof sn.idx === 'number' && sn.idx !== state.idx;
      if (slideChanged) { state.idx = clampIndex(sn.idx, slides.length); renderScript(); }
      sync.position = typeof sn.position === 'number' ? sn.position : sync.position;
      sync.anchorTime = typeof sn.anchorTime === 'number' ? sn.anchorTime : sync.anchorTime;
      sync.isPlaying = !!sn.isPlaying;
      sync.rate = typeof sn.rate === 'number' ? sn.rate : sync.rate;
      if (typeof sn.scrollSpeed === 'number') state.speed = sn.scrollSpeed;
      state.playing = sync.isPlaying;
      renderPill();
      if (slideChanged || !sync.isPlaying) {
        // Snap on a seek, a pause or a new slide — easing there looks like lag.
        requestAnimationFrame(function () {
          applyScrollPct(positionNow());
          renderPos = scrollEl ? scrollEl.scrollTop : 0;
          lastProgScroll = renderPos;
        });
      }
    }
    sock.on('scroll-sync', applySync);
    sock.on('current-state', function (sn) {
      applySync(sn);
      var changed = false;
      if (typeof sn.textSize === 'number' && state.fontSize !== sn.textSize) { state.fontSize = sn.textSize; changed = true; }
      if (typeof sn.lineHeight === 'number' && state.lineHeight !== sn.lineHeight) { state.lineHeight = sn.lineHeight; changed = true; }
      if (sn.textWidth && WIDTH_PX[sn.textWidth] && state.width !== sn.textWidth) { state.width = sn.textWidth; changed = true; }
      if (changed) renderScript();
    });
    sock.on('text-size', function (v) { state.fontSize = v; renderScript(); });
    sock.on('line-height', function (v) { state.lineHeight = v; renderScript(); });
    sock.on('text-width', function (v) { if (WIDTH_PX[v]) { state.width = v; renderScript(); } });

    setInterval(burstSyncClock, 15000);
  }

  /**
   * ⚠️ THE FOLLOWER CAN DRIVE. Tapping the script plays or pauses EVERY screen,
   * because a presenter holding the phone should not have to walk back to the
   * monitor to stop the scroll. The button on the other screen is confirmed by
   * the same broadcast that moves this one.
   */
  /**
   * ⚠️ THE FOLLOWER PUBLISHES ITS SCRUBS TOO, playing or paused. Without this
   * the sync is one-way: dragging the phone moved the phone and nothing else,
   * so the two screens sat on different lines until the next play.
   *
   * Our own animated writes are excluded by comparing against the last value we
   * wrote — a time window cannot work, because while playing we write every
   * frame and every real drag would land inside it.
   */
  var lastProgScroll = -1;
  var seekTimer = null, pendingSeek = null;
  function publishScroll() {
    if (!sock || !scrollEl) return;
    if (Math.abs(scrollEl.scrollTop - lastProgScroll) <= 2) return; // that was us
    var max = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (max <= 0) return;
    pendingSeek = Math.max(0, Math.min(1, scrollEl.scrollTop / max));
    if (seekTimer) return;
    seekTimer = setTimeout(function () {
      seekTimer = null;
      if (pendingSeek !== null && sock) sock.emit('scroll-position', pendingSeek);
      pendingSeek = null;
    }, 120);
  }

  /**
   * ⚠️ ARROW KEYS JUMP THE SCRIPT, AND THE JUMP IS PUBLISHED. Moving only this
   * screen would be worse than not moving at all — the presenter would be
   * reading one place while the phone showed another.
   *
   * The step is three lines of the CURRENT type size, converted to a fraction,
   * so it feels the same at 18px and at 56px and lands identically on a phone
   * and a monitor.
   */
  function nudge(direction) {
    if (!sock || !scrollEl) return;
    var max = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (max <= 0) return;
    var stepPx = state.fontSize * state.lineHeight * 3;
    var here = positionNow();
    sock.emit('scroll-position', Math.max(0, Math.min(1, here + direction * (stepPx / max))));
  }

  function toggleFromFollower() {
    if (!sock) return;
    var starting = !sync.isPlaying;
    // ⚠️ WHOEVER PRESSES PLAY MUST PUBLISH THE SLOPE. The anchor is a position
    // AND a rate; starting playback without sending one leaves the rate at
    // whatever it was — zero, on a show nobody has started yet — so every
    // screen dutifully renders a scroll that never moves. Computed from THIS
    // screen's own scroll height, because a fraction per millisecond is the
    // only speed that means the same thing on a phone and a monitor.
    if (starting && scrollEl) {
      var max = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (max > 0) {
        var speed = typeof state.speed === 'number' ? state.speed : 12;
        sock.emit('scroll-speed', { scrollSpeed: speed, rate: (speed * 8) / max / 1000 });
      }
    }
    sock.emit('play-pause', starting);
  }

  var errors = 0;

  // Glide: keep moving at the presenter's estimated speed between updates,
  // correcting gently on each arrival; snap on big jumps; forward-only while playing.
  function tick(ts) {
    if (scrollEl) {
      var max = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (max > 0 && sync.isPlaying) {
        var target = positionNow() * max;
        var diff = target - renderPos;
        var dt = lastFrameTs == null ? 16 : Math.min(100, ts - lastFrameTs);
        // Big correction (join, seek, slide) snaps; small correction eases, so
        // the heartbeat pulls this screen onto the shared spot invisibly.
        if (Math.abs(diff) > 150) renderPos = target;
        else renderPos += diff * (1 - Math.exp(-dt / 120));
        lastProgScroll = renderPos;
        scrollEl.scrollTop = renderPos;
      } else if (max > 0) {
        renderPos = scrollEl.scrollTop;
      }
    }
    lastFrameTs = ts;
    requestAnimationFrame(tick);
  }

  // Resync when the device wakes / the tab becomes visible again.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    fetchState(false).then(function (data) {
      if (!data.session) return;
      var s = data.session;
      state.idx = typeof s.currentSlideIndex === 'number' ? clampIndex(s.currentSlideIndex, slides.length) : 0;
      applySettings(s);
      renderScript();
      requestAnimationFrame(function () { applyScrollPct(typeof s.tpScrollPct === 'number' ? s.tpScrollPct : 0); });
      anchor = {
        position: typeof s.tpScrollPct === 'number' ? s.tpScrollPct : 0,
        velocity: 0,
        receivedAt: Date.now(),
        playing: typeof s.tpPaused === 'boolean' ? !s.tpPaused : false,
      };
      renderPos = (typeof s.tpScrollPct === 'number' ? s.tpScrollPct : 0) * (scrollEl ? scrollEl.scrollHeight - scrollEl.clientHeight : 0);
      lastSeq = 0; // force the next poll to apply
      connected = true; renderPill();
    }).catch(function () {});
  });

  if (!sessionId) { message('No deck found.', 'Build a deck first from the Dashboard, then start the show.'); return; }

  fetchState(true).then(function (data) {
    slides = data.slides || [];
    if (!data.session || !slides.length) {
      message('No deck found.', 'Build a deck first from the Dashboard, then start the show.');
      return;
    }
    var s = data.session;
    state.idx = typeof s.currentSlideIndex === 'number' ? clampIndex(s.currentSlideIndex, slides.length) : 0;
    applySettings(s);
    if (typeof s.tpRevision === 'number') lastSeq = s.tpRevision;
    build();
    // The one-off HTTP read above supplies the SLIDES; the socket supplies the
    // live position from here on, and request-current-state on connect lands
    // this screen on whatever the show is already doing.
    if (typeof s.tpScrollPct === 'number') {
      sync.position = s.tpScrollPct;
      requestAnimationFrame(function () { applyScrollPct(s.tpScrollPct); renderPos = scrollEl.scrollTop; });
    }
    connectSocket();
    if (scrollEl) {
      scrollEl.addEventListener('click', toggleFromFollower);
      scrollEl.addEventListener('scroll', publishScroll, { passive: true });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); nudge(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(-1); }
      else if (e.key === ' ') { e.preventDefault(); toggleFromFollower(); }
    });
    requestAnimationFrame(tick);
  }).catch(function () {
    message('No deck found.', 'Build a deck first from the Dashboard, then start the show.');
  });
})();
</script>
</body>
</html>`;
