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
 * BEAT MARKERS + THE LAST BEAT (Jake, 2026-10-07), AI News mode only: each
 * slide arrives with 'cues' — made on the server by the presenter's own
 * cueMarks.ts — and the script is laid out exactly as NotesPage lays it out:
 * cut at each cue's first word into parts, each later part opened by its
 * "▶ BEAT n · TITLE" marker line (the Deep Dive's marker style + one line
 * always, '.beat-mark.news'), parts already spoken dimmed; the cue words
 * coloured (next yellow, later dotted, the story's LAST beat a calm violet).
 * ⚠️ Same blocks, same sizes, same paragraph split as the presenter — the
 * lines MUST break where the presenter's do (the scroll sync is a fraction of
 * the script's height). The beat comes from the room's own "beat" event; it
 * re-lays the script and never moves the scroll.
 *
 * ONLY GESTURES ARE PUBLISHED (2026-10-07, "sometimes when I go to the next
 * slide I am still brought to the bottom of the script of the next slide").
 * This page re-renders the new script on a slide change, the browser clamps
 * the old offset into it and fires a scroll event — and that event used to go
 * out as a seek to the BOTTOM, tagged with the new slide, so the server took
 * it and moved every screen. Now a scroll is published only when a gesture
 * (a fresh wheel burst, a touch, the scrollbar) STARTED after the last slide
 * change, exactly as web presenter/scrollGuard.ts does for the presenters;
 * every seek names the script (epoch) it was made on; the new script is put
 * at the room's position synchronously, before any scroll event can fire.
 *
 * DEEP DIVE CONTROLS = THE PRESENTER'S: on a section's last beat → goes on
 * only when pressed twice within 1 s (a small toast here says so); marker
 * lines "▶ BEAT n · TITLE" with the next press lit and the last beat violet,
 * text made by the presenter's own code on the server.
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
  /* AI News cue words — MUST match web daily/stage/cues.tsx SPAN: colour and underline only. */
  .cue { text-decoration-line: underline; text-underline-offset: .18em; }
  .cue.next { color: #ffd21e; text-decoration-color: #ffd21e; }
  .cue.later { text-decoration-style: dotted; text-decoration-color: rgba(255,255,255,.35); }
  .cue.next.last { color: #b69cff; text-decoration-color: #b69cff; }
  .cue.later.last { text-decoration-color: rgba(182,156,255,.6); }
  /* AI News beat markers — the Deep Dive .beat-mark + one line always (web cues.tsx newsMarkStyle). */
  .beat-mark.news { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .beat-mark.news.last { color: rgba(182,156,255,.6); }
  .beat-mark.news.last.on { color: #b69cff; }
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
  #toast { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 30; max-width: 92vw;
           background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 8px; padding: 8px 14px; color: #f0f0f0;
           font-size: 13px; font-weight: 600; opacity: 0; transition: opacity .15s; pointer-events: none; }
  #toast.on { opacity: 1; }
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
  // THE STABLE LINK (?live=<token>, server followChannel.ts): the server says
  // which show is live; this page follows it AI News ⇄ Deep Dive without a
  // reload. liveKey = opaque id of the session being shown (never the id itself).
  var liveToken = params.get('live') || '';
  var liveKeyNow = null;
  var chanSock = null;
  var gen = 0;          // bumps on every switch: late answers for an old show are dropped
  var revoked = false;

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

  // ── Which scrolls are the user's (web presenter/scrollGuard.ts, the same rules).
  var WHEEL_GAP_MS = 200, SETTLE_MS = 1500;
  var gSeq = 0, gestureSeq = 0, navSeq = 0, navAt = -Infinity, lastWheelAt = -Infinity, lastTouchAt = -Infinity;
  function nowMs() { return performance.now(); }
  function gesture() { gestureSeq = ++gSeq; }
  function userScrolling() { return gestureSeq > navSeq; }
  /** A new script is on screen: whatever is still moving belongs to the old one. */
  function markNav() {
    navSeq = ++gSeq; navAt = nowMs();
    if (scrollEl && nowMs() - lastTouchAt < 3000) {
      // A touch fling coasts without events; cutting the overflow for a frame stops it.
      var el = scrollEl; el.style.overflowY = 'hidden';
      requestAnimationFrame(function () { el.style.overflowY = ''; });
    }
  }
  function guardScroller(el) {
    el.addEventListener('wheel', function (e) {
      var t = nowMs();
      if (t - lastWheelAt > WHEEL_GAP_MS) gesture();
      lastWheelAt = t;
      if (gestureSeq < navSeq) e.preventDefault(); // a flick from the previous script
    }, { passive: false });
    el.addEventListener('touchstart', function () { lastTouchAt = nowMs(); gesture(); }, { passive: true });
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.clientX >= el.getBoundingClientRect().left + el.clientWidth) gesture();
    });
  }
  /** Where the room's script is, in this screen's pixels. */
  function roomTop() {
    if (!scrollEl) return 0;
    var max = scrollEl.scrollHeight - scrollEl.clientHeight;
    return max > 0 ? Math.max(0, Math.min(max, positionNow() * max)) : 0;
  }
  /** Put this screen exactly where the room is, marked as our own write. */
  function landOnRoom() {
    if (!scrollEl) return;
    var top = roomTop();
    scrollEl.scrollTop = top;
    renderPos = scrollEl.scrollTop;
    lastProgScroll = renderPos;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = 'on';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 2500);
  }

  var root = document.getElementById('root');
  var scrollEl, pillEl, scriptEl;

  function clampIndex(i, total) { return total <= 0 ? 0 : Math.max(0, Math.min(total - 1, i)); }

  function fetchState(withSlides) {
    var q = liveToken ? 'live=' + encodeURIComponent(liveToken) : 'session=' + encodeURIComponent(sessionId);
    return fetch('/news-follow/state?' + q + (withSlides ? '&slides=1' : ''), { cache: 'no-store' })
      .then(function (r) {
        if (liveToken && r.status === 404) return r.json().then(function (j) { if (j && j.revoked) return j; throw new Error('status 404'); });
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      });
  }

  function message(title, sub) {
    scrollEl = pillEl = scriptEl = null;
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
    // A new show builds a new scroller, so its listeners are attached here, every build.
    scrollEl.addEventListener('click', toggleFromFollower);
    scrollEl.addEventListener('scroll', publishScroll, { passive: true });
    guardScroller(scrollEl);
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
    var cues = slide && Array.isArray(slide.cues) ? slide.cues : [];
    var parts = scriptParts(raw, cues);
    var any = parts.some(function (pt) { return pt.paras.length > 0; });
    var beat = curBeat();
    scriptEl.style.maxWidth = (WIDTH_PX[state.width] || 660) + 'px';
    scriptEl.style.transform = mirror ? 'scaleX(-1)' : '';
    scriptEl.innerHTML = '';
    var label = document.createElement('p');
    label.id = 'label';
    label.textContent = (idx + 1) + ' / ' + slides.length + (slide && slide.bestSourceName ? ' · ' + slide.bestSourceName : '');
    scriptEl.appendChild(label);
    if (any) {
      // NotesPage's blocks, node for node: a part per beat, its marker line, its paragraphs.
      parts.forEach(function (pt) {
        var wrap = document.createElement('div');
        wrap.className = 'beat-part';
        wrap.style.opacity = pt.beat < beat ? '0.35' : '1';
        if (pt.mark) {
          var mk = document.createElement('p');
          mk.className = 'beat-mark news' + (pt.mark.last ? ' last' : '') + (pt.mark.beat === beat + 1 ? ' on' : '');
          mk.style.margin = '0 0 ' + Math.round(state.fontSize * 0.5) + 'px';
          mk.textContent = String(pt.mark.mark || '');
          wrap.appendChild(mk);
        }
        pt.paras.forEach(function (p) {
          var el = document.createElement('p');
          el.className = 'para';
          el.style.fontSize = state.fontSize + 'px';
          el.style.lineHeight = String(state.lineHeight);
          el.style.margin = '0 0 ' + Math.round(state.fontSize * 0.8) + 'px';
          markPara(el, p.text, p.start, cues, beat);
          wrap.appendChild(el);
        });
        scriptEl.appendChild(wrap);
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

  /** web cueMarks.ts scriptParas — the paragraphs of text and where each starts in the whole script. */
  function scriptParas(text, base) {
    var out = [], off = 0;
    text.split(PARA_SPLIT).forEach(function (r) {
      var at = text.indexOf(r, off); off = at + r.length;
      var t = r.trim();
      if (t) out.push({ text: t, start: base + at + (r.length - r.replace(/^\s+/, '').length) });
    });
    return out;
  }

  /** web cueMarks.ts scriptParts — the script cut at each cue's first word; part 0 = the source beat. */
  function scriptParts(script, cues) {
    var cuts = cues.filter(function (m) { return m && m.start > 0 && m.start < script.length; });
    var out = [], from = 0, mark = null;
    cuts.concat([null]).forEach(function (m) {
      var to = m ? m.start : script.length;
      out.push({ beat: mark ? mark.beat : 0, mark: mark, paras: scriptParas(script.slice(from, to), from) });
      if (m) { from = m.start; mark = m; }
    });
    return out;
  }

  /**
   * One paragraph with the cues still ahead of the show marked — node for node
   * what the presenter's markCues renders: text, a span per cue, text.
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
      sp.appendChild(document.createTextNode(text.slice(a, b)));
      el.appendChild(sp);
      at = b;
    });
    if (at < text.length) el.appendChild(document.createTextNode(text.slice(at)));
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
          // The AI News marker line (web presenter/beatMarks.ts made the text): next press lit, last beat violet.
          var mark = document.createElement('p');
          var lastB = b === parts.length - 1;
          mark.className = 'beat-mark news' + (lastB ? ' last' : '') + (b === at.beat + 1 ? ' on' : '');
          mark.style.margin = '0 0 ' + Math.round(state.fontSize * 0.5) + 'px';
          mark.textContent = (sec.marks && sec.marks[b]) || ('▶ BEAT ' + b);
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
  var sync = { position: 0, anchorTime: 0, isPlaying: false, rate: 0, epoch: null };

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
    // On the stable link the SERVER puts this socket in the live show's room (query: the token only).
    var me = sock = io('/news-tp', { path: '/news-tp/socket.io', query: liveToken ? { live: liveToken } : { session: sessionId }, transports: ['websocket', 'polling'], forceNew: true });
    // A socket of a show we already left must not touch this screen.
    function on(ev, fn) { me.on(ev, function (a) { if (me === sock) fn(a); }); }

    on('connect', function () {
      connected = true; renderPill();
      burstSyncClock();                 // agree on the clock before trusting an anchor
      sock.emit('request-current-state');
    });
    on('disconnect', function () { connected = false; renderPill(); });

    on('time-pong', function (m) {
      var rtt = Date.now() - m.clientSendTime;
      if (rtt <= bestRtt) { bestRtt = rtt; serverOffset = (m.serverTime + rtt / 2) - Date.now(); }
    });

    function applySync(sn) {
      // The anchor first, so a new script below is placed at the room's (new) position.
      sync.position = typeof sn.position === 'number' ? sn.position : sync.position;
      sync.anchorTime = typeof sn.anchorTime === 'number' ? sn.anchorTime : sync.anchorTime;
      sync.isPlaying = !!sn.isPlaying;
      sync.rate = typeof sn.rate === 'number' ? sn.rate : sync.rate;
      if (typeof sn.epoch === 'number') sync.epoch = sn.epoch;
      if (typeof sn.scrollSpeed === 'number') state.speed = sn.scrollSpeed;
      state.playing = sync.isPlaying;
      var slideChanged = typeof sn.idx === 'number' && sn.idx !== state.idx;
      if (slideChanged) {
        var nextIdx = clampIndex(sn.idx, total());
        // Deep Dive: another beat of the SAME section keeps the script where
        // it is (the server kept the anchor) — re-light it, do not snap.
        if (dd && sectionOf(nextIdx) === sectionOf(state.idx)) slideChanged = false;
        state.idx = nextIdx;
        if (slideChanged && seekTimer) { clearTimeout(seekTimer); seekTimer = null; pendingSeek = null; }
        var keep = scrollEl ? scrollEl.scrollTop : 0;
        renderScript();
        if (slideChanged) {
          // ⚠️ SYNCHRONOUSLY, before the frame's scroll event: the old offset clamped into
          // the new script must never be seen (it used to go out as a seek to the bottom).
          markNav();
          landOnRoom();
        } else if (scrollEl && scrollEl.scrollTop !== keep) {
          scrollEl.scrollTop = keep; lastProgScroll = scrollEl.scrollTop;
        }
      }
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
    on('scroll-sync', applySync);
    on('beat', setBeat);
    on('current-state', function (sn) {
      applySync(sn);
      if (typeof sn.beat === 'number') setBeat({ idx: sn.idx, beat: sn.beat });
      var changed = false;
      if (typeof sn.textSize === 'number' && state.fontSize !== sn.textSize) { state.fontSize = sn.textSize; changed = true; }
      if (typeof sn.lineHeight === 'number' && state.lineHeight !== sn.lineHeight) { state.lineHeight = sn.lineHeight; changed = true; }
      if (sn.textWidth && WIDTH_PX[sn.textWidth] && state.width !== sn.textWidth) { state.width = sn.textWidth; changed = true; }
      if (changed) relayout();
    });
    // A new size / width re-wraps the script: land back on the room's place in it.
    function relayout() { renderScript(); if (!sync.isPlaying) landOnRoom(); }
    on('text-size', function (v) { state.fontSize = v; relayout(); });
    on('line-height', function (v) { state.lineHeight = v; relayout(); });
    on('text-width', function (v) { if (WIDTH_PX[v]) { state.width = v; relayout(); } });

  }
  setInterval(burstSyncClock, 15000);

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
  var seekTimer = null, pendingSeek = null, pendingSeekIdx = 0, pendingSeekEpoch = null;
  function seekMsg(pos, idx, epoch) {
    var m = { pos: pos, idx: idx };
    if (typeof epoch === 'number') m.epoch = epoch;
    return m;
  }
  function publishScroll() {
    if (!sock || !scrollEl) return;
    if (Math.abs(scrollEl.scrollTop - lastProgScroll) <= 2) return; // that was us
    var max = scrollEl.scrollHeight - scrollEl.clientHeight;
    if (max <= 0) return;
    // Not a gesture that began on THIS script (a layout clamp, an old flick, a re-layout):
    // never published; just after a slide change, back to where the room is.
    if (!userScrolling()) {
      if (nowMs() - navAt < SETTLE_MS) landOnRoom();
      return;
    }
    pendingSeek = Math.max(0, Math.min(1, scrollEl.scrollTop / max));
    pendingSeekIdx = state.idx;
    pendingSeekEpoch = sync.epoch;
    if (seekTimer) return;
    seekTimer = setTimeout(function () {
      seekTimer = null;
      if (pendingSeek !== null && sock) sock.emit('scroll-position', seekMsg(pendingSeek, pendingSeekIdx, pendingSeekEpoch));
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
    sock.emit('scroll-position', seekMsg(Math.max(0, Math.min(1, here + direction * (stepPx / max))), state.idx, sync.epoch));
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
  var NEXT_WINDOW_MS = 1000, armed = null;   // web presenter/controls.ts — two presses within 1 s
  function stepBeat(dir) {
    if (!sock || !dd) return;
    var from = clampIndex(state.idx, flat.length);
    var to = clampIndex(from + dir, flat.length);
    if (to === from) return;
    if (dir > 0 && sectionOf(to) !== sectionOf(from)) {
      var now = Date.now();
      if (!armed || armed.section !== sectionOf(from) || now - armed.at > NEXT_WINDOW_MS) {
        armed = { section: sectionOf(from), at: now };
        toast('Last beat of this section — press → twice quickly for the next section');
        return;
      }
      var t = document.getElementById('toast'); if (t) t.className = '';
    }
    armed = null;
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
    var my = gen;
    fetchState(false).then(function (data) {
      if (my !== gen) return;
      // The stable link: another show went live (or none) while this screen slept — follow it.
      if (liveToken && (data.revoked || data.waiting || data.liveKey !== liveKeyNow)) { onLive(data); return; }
      if (!data.session || !scriptEl) return;
      // Same show: the ROOM says where it is (the row's old scroll field is not live state —
      // applying it here used to publish a seek of it to every screen as the phone woke).
      if (sock) sock.emit('request-current-state');
      connected = true; renderPill();
    }).catch(function () {});
  });

  // Keys and the render loop: once for the page, whatever show it follows.
  document.addEventListener('keydown', function (e) {
    if (!scriptEl) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); nudge(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(-1); }
    else if (e.key === ' ') { e.preventDefault(); toggleFromFollower(); }
    else if (dd && (e.key === 'ArrowRight' || e.key === 'PageDown')) { e.preventDefault(); stepBeat(1); }
    else if (dd && (e.key === 'ArrowLeft' || e.key === 'PageUp')) { e.preventDefault(); stepBeat(-1); }
  });
  requestAnimationFrame(tick);

  /** Leave the show on screen: its socket, its timers, its scroller. */
  function dropShow() {
    gen++;
    var old = sock; sock = null;
    if (old) { try { old.disconnect(); } catch (e) {} }
    if (seekTimer) { clearTimeout(seekTimer); seekTimer = null; }
    pendingSeek = null;
    slides = []; dd = null; flat = [];
    state.idx = 0; state.playing = false;
    beatAt = { idx: 0, beat: 0 };
    sync = { position: 0, anchorTime: 0, isPlaying: false, rate: 0, epoch: null };
    lastSeq = 0; renderPos = 0; lastProgScroll = -1; armed = null;
    document.title = 'Teleprompter';
  }

  function waiting() {
    message('Waiting for the presenter…', 'This screen follows whichever show is live — AI News or Deep Dive.');
  }
  function replaced() {
    revoked = true;
    dropShow();
    if (chanSock) { try { chanSock.disconnect(); } catch (e) {} chanSock = null; }
    message('This follower link was replaced.', 'Ask for the new link.');
  }

  /** Open the show the server says is live (or the ?session= one) and land where the presenter is. */
  function startShow() {
    dropShow();
    var my = gen;
    return fetchState(true).then(function (data) {
      if (my !== gen) return;
      if (liveToken) {
        if (data.revoked) { replaced(); return; }
        liveKeyNow = data.liveKey || null;
        if (data.waiting || !data.session) { waiting(); return; }
      }
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
        if (liveToken) waiting();
        else message('No deck found.', 'Build a deck first from the Dashboard, then start the show.');
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
      markNav();
      if (typeof s.tpScrollPct === 'number') {
        sync.position = s.tpScrollPct;
        requestAnimationFrame(function () { if (my !== gen || !scrollEl) return; landOnRoom(); });
      }
      connectSocket();
    }).catch(function () {
      if (my !== gen) return;
      if (liveToken) waiting();
      else message('No deck found.', 'Build a deck first from the Dashboard, then start the show.');
    });
  }

  /** The stable link heard which show is live: same one → nothing; another → switch; none → wait. */
  function onLive(info) {
    if (revoked) return;
    if (info && info.revoked) { replaced(); return; }
    var key = info && (info.key || info.liveKey) || null;
    if (!key) { if (liveKeyNow === null && !scriptEl && !sock) return; liveKeyNow = null; dropShow(); waiting(); return; }
    if (key === liveKeyNow && (scriptEl || sock)) return;
    liveKeyNow = key;
    startShow();
  }

  if (liveToken) {
    // Push: the channel socket says when the live show changes. Poll: every 5 s, in case a push is missed.
    if (typeof io !== 'undefined') {
      chanSock = io('/news-tp', { path: '/news-tp/socket.io', query: { live: liveToken, channel: '1' }, transports: ['websocket', 'polling'], forceNew: true });
      chanSock.on('live-session', function (info) { onLive(info || null); });
      chanSock.on('live-revoked', replaced);
    }
    setInterval(function () {
      if (revoked) return;
      fetchState(false).then(function (data) {
        if (data.revoked) { replaced(); return; }
        onLive(data.waiting || !data.session ? null : { key: data.liveKey });
      }).catch(function () {});
    }, 5000);
    startShow();
    return;
  }

  if (!sessionId) { message('No deck found.', 'Build a deck first from the Dashboard, then start the show.'); return; }
  startShow();
})();
</script>
</body>
</html>`;
