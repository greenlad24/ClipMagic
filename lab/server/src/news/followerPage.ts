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
 *
 * DEEP DIVES TOO (Jake, 2026-10-06). The same link from the Deep Dive
 * presenter opens this same page; /news-follow/state then answers
 * `kind: "deep-dive"` with the dive's sections (label, beat count, script per
 * beat — deepDiveFollow.ts). There the sync index is a BEAT across the whole
 * show, so `flat` maps it back to section + beat: a new SECTION re-renders and
 * snaps (the server reset its scroll), a new BEAT in the same section only
 * re-lights the script (the server kept the scroll — keepScroll). The script
 * is laid out exactly like DeepDivePresenterPage's (one-line label, the
 * "▶ NEXT · BEAT n" marks, done beats dimmed) so both break lines alike.
 * ←/→ (and a clicker's PageUp/PageDown) step beats from here as well.
 *
 * BEAT TITLES + THE LAST CUE (Jake, 2026-10-07), AI News mode only: each
 * slide arrives with `cues` — made on the server by the presenter's own
 * cueMarks.ts — and the script marks the cues still ahead of the show's beat
 * exactly as NotesPage does (markCues in web daily/stage/cues.tsx): next cue
 * yellow + underlined, later ones dotted, the story's LAST cue in coral, and
 * over each one its beat's title as an out-of-flow tag. ⚠️ Same element
 * structure and the same paragraph split as the presenter, colour/underline
 * only on the words, the tag position:absolute — the lines MUST break where
 * the presenter's do (the scroll sync is a fraction of the script's height).
 * The beat comes from the room's own "beat" event; it re-marks the script
 * and never moves the scroll.
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
  /* AI News cue marks + beat titles — MUST match web daily/stage/cues.tsx (SPAN / TAG). Colour and
     underline only on the words; the tag is OUT OF FLOW (absolute, inside the relative cue span), so
     neither can move a line break. */
  .cue { position: relative; text-decoration-line: underline; text-underline-offset: .18em; }
  .cue.next { color: #ffd21e; text-decoration-color: #ffd21e; }
  .cue.later { text-decoration-style: dotted; text-decoration-color: rgba(255,255,255,.35); }
  .cue.next.last { color: #ff5a4e; text-decoration-color: #ff5a4e; }
  .cue.later.last { text-decoration-color: rgba(255,90,78,.75); }
  .cue-tag { position: absolute; left: 0; top: 0;
             font-family: 'NewsScript', Arial, Helvetica, sans-serif; line-height: 1.25;
             font-weight: 700; letter-spacing: .02em; overflow: hidden; text-overflow: ellipsis;
             padding: 2px 7px; border-radius: 4px; pointer-events: none; background: rgba(8,8,8,.85);
             border: 1px solid transparent; color: rgba(255,255,255,.5); }
  .cue.next .cue-tag { color: #ffd21e; border-color: rgba(255,210,30,.45); }
  .cue.next.last .cue-tag { color: #1a0605; background: #ff5a4e; border-color: #ff5a4e; }
  /* The LAST beat's title is ALWAYS a solid coral block (Jake: "the last beat title should be in a different color"). */
  .cue.later.last .cue-tag { color: #1a0605; background: rgba(255,90,78,.78); border-color: #ff5a4e; }
  /* Deep Dive: the beat marks — MUST match DeepDivePresenterPage's markStyle. */
  .beat-mark { font-family: 'NewsScript', Arial, Helvetica, sans-serif; font-size: 11px; line-height: 16px; font-weight: 800;
               letter-spacing: .12em; color: #3a3a3a; }
  .beat-mark.on { color: #ffd21e; }
  .beat-part { transition: opacity .3s; }
  #label.one-line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #next-up { font-size: 11px; font-weight: 700; color: #3a3a3a; letter-spacing: .08em; text-transform: uppercase; margin: 12px 0 0; }
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
  // Deep Dive mode: its sections, and every beat of the show in order
  // ({ section, beat }) — the index into flat is the sync index.
  var dd = null;
  var flat = [];
  function total() { return dd ? flat.length : slides.length; }
  function sectionOf(i) { var f = flat[i]; return f ? f.section : 0; }
  var state = { idx: 0, fontSize: 32, lineHeight: 1.9, width: 'medium', playing: false, autoscroll: false, speed: 12 };
  // AI News: the beat the show is on ({idx, beat} from the room) — which cues are still ahead.
  var beatAt = { idx: 0, beat: 0 };
  function curBeat() { return beatAt.idx === state.idx ? beatAt.beat : 0; }
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
    if (dd) { renderDeepDive(); return; }
    var idx = clampIndex(state.idx, total());
    var slide = slides[idx] || null;
    var raw = slide && typeof slide.teleprompterScript === 'string' ? slide.teleprompterScript : '';
    // Paragraphs + where each starts in the script (web cueMarks.ts scriptParas — same split).
    var paragraphs = [];
    var off = 0;
    raw.split(PARA_SPLIT).forEach(function (r) {
      var at = raw.indexOf(r, off); off = at + r.length;
      var t = r.trim();
      if (t) paragraphs.push({ text: t, start: at + (r.length - r.replace(/^\s+/, '').length) });
    });
    var cues = slide && Array.isArray(slide.cues) ? slide.cues : [];
    var beat = curBeat();
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
        markPara(el, p.text, p.start, cues, beat);
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
    fitTags();
  }

  /**
   * One paragraph with the cues still ahead of the show marked — node for node
   * what the presenter's markCues renders: text, then a span per cue (title
   * tag first, on the paragraph where the cue starts), then text.
   */
  function markPara(el, text, offset, cues, beat) {
    var at = 0;
    cues.forEach(function (c) {
      if (!(c && c.end > offset && c.start < offset + text.length && c.beat > beat)) return;
      var a = Math.max(0, c.start - offset), b = Math.min(text.length, c.end - offset);
      if (a < at) return;
      if (a > at) el.appendChild(document.createTextNode(text.slice(at, a)));
      var sp = document.createElement('span');
      sp.className = 'cue ' + (c.beat === beat + 1 ? 'next' : 'later') + (c.last ? ' last' : '');
      sp.setAttribute('data-cue', String(c.beat));
      if (c.start >= offset) {
        var tag = document.createElement('span');
        tag.className = 'cue-tag';
        tag.setAttribute('data-cue-tag', '');
        tag.textContent = String(c.tag || '');
        sp.appendChild(tag);
      }
      sp.appendChild(document.createTextNode(text.slice(a, b)));
      el.appendChild(sp);
      at = b;
    });
    if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
  }

  /**
   * Place the title tags — the presenter's fitCueTags (web cues.tsx), step for
   * step: in the margin left of the text (level with the cue's line) when
   * there are >= 170px there, else a one-line tag just above the cue's first
   * word, kept inside the column. Moves tags only, never text.
   */
  function fitTags() {
    if (!scriptEl || dd) return;
    var col = scriptEl;
    var cs = getComputedStyle(col);
    var padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    var colW = col.offsetWidth;
    var mirrored = /^matrix\(-1/.test(cs.transform);
    var cr = col.getBoundingClientRect();
    var pr = (col.parentElement || col).getBoundingClientRect();
    var room = (mirrored ? pr.right - cr.right : cr.left - pr.left) + padL;
    var gutter = room >= 170;
    var lastBottom = -Infinity;
    var tags = col.querySelectorAll('[data-cue-tag]');
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      var fr = tag.parentElement ? tag.parentElement.getClientRects()[0] : null;
      if (!fr) continue;
      var cueLeft = mirrored ? cr.right - fr.right : fr.left - cr.left;
      var st = tag.style, tw, th;
      if (gutter) {
        st.whiteSpace = 'normal'; st.textAlign = 'right'; st.fontSize = 'max(13px, 0.42em)'; st.padding = '2px 7px'; st.lineHeight = '1.25';
        st.maxWidth = Math.min(300, room - 28) + 'px'; st.width = 'max-content';
        tw = tag.offsetWidth; th = tag.offsetHeight;
        var top = (fr.height - th) / 2;
        var y = fr.top - cr.top + top;
        if (y < lastBottom + 4) { top += lastBottom + 4 - y; y = lastBottom + 4; }
        lastBottom = y + th;
        st.left = (-(cueLeft - padL) - tw - 14) + 'px';
        st.top = top + 'px';
      } else {
        st.whiteSpace = 'nowrap'; st.textAlign = 'left'; st.fontSize = 'max(11px, 0.36em)'; st.padding = '0 6px'; st.lineHeight = '1.15';
        st.maxWidth = Math.max(40, colW - padL - padR) + 'px'; st.width = '';
        tw = tag.offsetWidth; th = tag.offsetHeight;
        var over = cueLeft + tw - (colW - padR);
        st.left = (over > 0 ? -over : 0) + 'px';
        st.top = (-th - 2) + 'px';
      }
    }
  }

  /** The show moved to another beat: re-mark the script where it stands — never scroll it. */
  function setBeat(b) {
    if (!b || typeof b.idx !== 'number' || typeof b.beat !== 'number') return;
    var before = curBeat();
    beatAt = { idx: b.idx, beat: b.beat };
    if (dd || !scriptEl || curBeat() === before) return;
    var keep = scrollEl ? scrollEl.scrollTop : 0;
    renderScript();
    if (scrollEl && scrollEl.scrollTop !== keep) { scrollEl.scrollTop = keep; }
  }

  function renderDeepDive() {
    var at = flat[clampIndex(state.idx, flat.length)] || { section: 0, beat: 0 };
    var secs = dd.sections;
    var sec = secs[at.section] || { label: '', parts: [], beats: 1 };
    var nextSec = secs[at.section + 1];
    scriptEl.style.maxWidth = (WIDTH_PX[state.width] || 660) + 'px';
    scriptEl.style.transform = mirror ? 'scaleX(-1)' : '';
    scriptEl.innerHTML = '';
    var label = document.createElement('p');
    label.id = 'label';
    label.className = 'one-line';
    label.textContent = (at.section + 1) + ' / ' + secs.length + ' · ' + sec.label + (sec.beats > 1 ? ' · beat ' + (at.beat + 1) + ' of ' + sec.beats : '');
    scriptEl.appendChild(label);
    var parts = sec.parts || [];
    var any = parts.some(function (p) { return p && p.trim(); });
    if (any) {
      parts.forEach(function (part, b) {
        var wrap = document.createElement('div');
        wrap.className = 'beat-part';
        wrap.style.opacity = b < at.beat ? '0.35' : '1';
        if (b > 0) {
          var mark = document.createElement('p');
          mark.className = 'beat-mark' + (b === at.beat ? ' on' : '');
          mark.style.margin = '0 0 ' + Math.round(state.fontSize * 0.5) + 'px';
          mark.textContent = '▶ NEXT · BEAT ' + (b + 1);
          wrap.appendChild(mark);
        }
        (part || '').split(/\n+/).map(function (t) { return t.trim(); }).filter(Boolean).forEach(function (t) {
          var el = document.createElement('p');
          el.className = 'para';
          el.style.fontSize = state.fontSize + 'px';
          el.style.lineHeight = String(state.lineHeight);
          el.style.margin = '0 0 ' + Math.round(state.fontSize * 0.8) + 'px';
          el.textContent = t;
          wrap.appendChild(el);
        });
        scriptEl.appendChild(wrap);
      });
    } else {
      var empty = document.createElement('div');
      empty.id = 'empty';
      empty.innerHTML = '<p>No script for this section.</p><p>Write one in the deep dive editor.</p>';
      scriptEl.appendChild(empty);
    }
    var nx = document.createElement('p');
    nx.id = 'next-up';
    nx.textContent = nextSec ? 'Next → ' + nextSec.heading : 'End of the deep dive';
    scriptEl.appendChild(nx);
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
      if (slideChanged) {
        var nextIdx = clampIndex(sn.idx, total());
        // Deep Dive: another beat of the SAME section keeps the script where
        // it is (the server kept the anchor) — re-light it, do not snap.
        if (dd && sectionOf(nextIdx) === sectionOf(state.idx)) slideChanged = false;
        state.idx = nextIdx;
        renderScript();
      }
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
    sock.on('beat', setBeat);
    sock.on('current-state', function (sn) {
      applySync(sn);
      if (typeof sn.beat === 'number') setBeat({ idx: sn.idx, beat: sn.beat });
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
  var seekTimer = null, pendingSeek = null, pendingSeekIdx = 0;
  function publishScroll() {
    if (!sock || !scrollEl) return;
    if (Math.abs(scrollEl.scrollTop - lastProgScroll) <= 2) return; // that was us
    var max = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (max <= 0) return;
    pendingSeek = Math.max(0, Math.min(1, scrollEl.scrollTop / max));
    pendingSeekIdx = state.idx;
    if (seekTimer) return;
    seekTimer = setTimeout(function () {
      seekTimer = null;
      if (pendingSeek !== null && sock) sock.emit('scroll-position', { pos: pendingSeek, idx: pendingSeekIdx });
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
    sock.emit('scroll-position', { pos: Math.max(0, Math.min(1, here + direction * (stepPx / max))), idx: state.idx });
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

  /**
   * Deep Dive: step a beat FROM THE PHONE (a clicker paired to a tablet).
   * Exactly the presenter's message (web deepdive/v2/beatSync.ts): inside one
   * section keepScroll, so no teleprompter moves; across sections a bare index,
   * so every screen's script restarts at the top. Nothing changes here until
   * the room's broadcast comes back, so this screen cannot disagree with it.
   */
  function stepBeat(dir) {
    if (!sock || !dd) return;
    var from = clampIndex(state.idx, flat.length);
    var to = clampIndex(from + dir, flat.length);
    if (to === from) return;
    if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; }
    pendingSeek = null;
    sock.emit('slide-index', sectionOf(to) === sectionOf(from) ? { idx: to, keepScroll: true } : to);
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
      state.idx = typeof s.currentSlideIndex === 'number' ? clampIndex(s.currentSlideIndex, total()) : 0;
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
    if (data.kind === 'deep-dive' && Array.isArray(data.sections)) {
      dd = { title: data.title || '', sections: data.sections };
      flat = [];
      dd.sections.forEach(function (sec, i) {
        var n = Math.max(1, Math.floor(sec.beats) || 1);
        for (var b = 0; b < n; b++) flat.push({ section: i, beat: b });
      });
      if (dd.title) document.title = dd.title + ' · Teleprompter';
    }
    if (!data.session || !slides.length) {
      message('No deck found.', 'Build a deck first from the Dashboard, then start the show.');
      return;
    }
    var s = data.session;
    state.idx = typeof s.currentSlideIndex === 'number' ? clampIndex(s.currentSlideIndex, total()) : 0;
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
      else if (dd && (e.key === 'ArrowRight' || e.key === 'PageDown')) { e.preventDefault(); stepBeat(1); }
      else if (dd && (e.key === 'ArrowLeft' || e.key === 'PageUp')) { e.preventDefault(); stepBeat(-1); }
    });
    window.addEventListener('resize', fitTags);
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', fitTags);
    requestAnimationFrame(tick);
  }).catch(function () {
    message('No deck found.', 'Build a deck first from the Dashboard, then start the show.');
  });
})();
</script>
</body>
</html>`;
