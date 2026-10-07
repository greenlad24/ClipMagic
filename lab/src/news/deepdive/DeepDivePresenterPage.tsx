/**
 * Deep Dive — the presenter's screen (/news-gatherer/deep-dive/:id/presenter),
 * for BOTH formats (classic slides and v2 demo chapters).
 *
 * ⚠️ IT IS THE DAILY SHOW'S /present/notes PRESENTER (Jake, 2026-10-01, and
 * again 2026-10-06: "the deep dive presentation should have a button
 * 'follower link' and the functionality with the web sockets — the same as
 * the ai news presentation"). The chrome is not copied any more: the header
 * (‹ n/N › · topic · Notes | Teleprompter · 📱 Follower link · ↗ Source ·
 * E End) and the bottom bar (Play · Speed · Size · Narrow/Medium/Wide · beat
 * pills "next …") are the SAME components NotesPage renders
 * (../presenter/chrome.tsx). No monitor panel — the stage is the monitor.
 *
 * Keys — THE AI NEWS PRESENTER'S MAP (Jake, 2026-10-07: "these 2 presentation types
 * will be delivered in sequence … the UX should be basically the same"):
 *   ← / → (and a clicker's PageUp / PageDown)  previous / next beat (then section);
 *                                              on a section's LAST beat → goes on only
 *                                              when pressed twice within 1 s
 *   ‹ / › (header)                             previous / next section
 *   ↑ / ↓                                      nudge the script (teleprompter view)
 *   Space                                      play / pause the scroll (both views)
 *   T                                          Notes ↔ Teleprompter
 *   1–9, G + number                            jump to a section
 *   E                                          end
 * Opening (or reloading) this page starts the show from the top for every screen.
 *
 * ⚠️ THE SCROLL IS THE SAME ANCHOR PROTOCOL AS THE DAILY SHOW (../liveSync):
 * the server holds `position at time T + rate`, every screen solves it. The
 * rate is a fraction of THIS section's script per ms, so it is re-sent after
 * every section change and every layout change — a stale rate would scroll a
 * short script at a long script's pace.
 *
 * ⚠️ THE FOLLOWER LINK IS THE DAILY SHOW'S PUBLIC FOLLOWER PAGE, unchanged in
 * trust model: /news-follow/state sees that this session's deck id is a deep
 * dive and serves that dive's scripts split per beat (server routes.ts
 * `deepDiveFollowerSlides`). The phone plays/pauses/scrolls every screen and
 * steps beats with ←/→ like this page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useNewsTheme } from '../useNewsTheme';
import { useAuth } from '../auth';
import { startSession, getSession, endSession } from '../api';
import { connectLiveSync, type LiveSync } from '../liveSync';
import {
  D, SCRIPT_FONT, WIDTH_PX, type TpWidth, type ViewMode, NoteCard, NavStepper, TopicLabel, ViewToggle, Divider,
  FollowerLinkButton, useFollowActive, SourceButton, EndButton, ScreenButton, ScrollPill, ControlsBar, PlayButton, SpeedControl, SizeControl,
  WidthToggle, BeatDots,
} from '../presenter/chrome';
import { getDeepDive, editorPath, stagePath, KIND_LABEL, type DeepDive, type Section } from './api';
import { flatten, firstBeatOf, scriptParts, beatCount, type BeatUnit, type Chapter } from './v2/types';
import { sectionsToUnits } from './beats';
import { sectionsToChapters, CHAPTER_LABEL } from './v2/adapt';
import { sendBeat } from './v2/beatSync';
import { beatItems, sectionSourceUrl } from './presenterNotes';
import { useScrollGuard, SETTLE_MS } from '../presenter/scrollGuard';
import { leaveGuard, armMessage, ARM_TOAST_ID } from '../presenter/controls';
import { ddBeatMarks } from '../presenter/beatMarks';
import { newsMarkStyle } from '../daily/stage/cues';

const DEVICE_KEY = 'tp2-device-id';
const deviceId = (() => {
  try {
    let v = localStorage.getItem(DEVICE_KEY);
    if (!v) { v = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, v); }
    return v;
  } catch { return undefined; }
})();

const SOURCE_KEY = 'dd-source-enabled';
const readSourceLatch = () => { try { return localStorage.getItem(SOURCE_KEY) === 'true'; } catch { return false; } };

const smallBtn: CSSProperties = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 4, padding: '2px 9px', fontSize: 11, cursor: 'pointer', color: D.muted, whiteSpace: 'nowrap' };

/**
 * ⚠️ THE "▶ BEAT n · TITLE" MARKER IS PART OF THE SCRIPT'S LAYOUT — the AI News
 * marker exactly (daily/stage/cues.tsx `newsMarkStyle`: one line, fixed height,
 * the script face; the NEXT press yellow, the section's LAST beat violet), and
 * the follower page draws the same `.beat-mark.news` line with the same text
 * (presenter/beatMarks.ts, run by the server too). Otherwise the two screens'
 * paragraphs start at different heights.
 */

export default function DeepDivePresenterPage() {
  useNewsTheme(); // loads the NewsScript face, exactly as /notes does
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();

  const [dive, setDive] = useState<DeepDive | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [loadError, setLoadError] = useState('');
  const [sessionId, setSessionId] = useState('');
  // The ONE stable follower link follows whichever presenter acted last (chrome.tsx).
  useFollowActive(sessionId);
  const [connected, setConnected] = useState(false);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2.5);
  const [fontSize, setFontSize] = useState(32);
  const [lineHeight, setLineHeight] = useState(1.9);
  const [width, setWidth] = useState<TpWidth>('medium');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [startedAt] = useState(() => Date.now());
  // Opens on the TELEPROMPTER, like /notes (what Jake reads from on air).
  const [viewMode, setViewMode] = useState<ViewMode>('teleprompter');
  // "⟳ Synced" on the follower-link button when another screen moved the show.
  const [remoteSynced, setRemoteSynced] = useState(false);
  const syncedTimer = useRef<ReturnType<typeof setTimeout>>();
  // Source tab — latched on/off like /notes, survives reloads.
  const [sourceEnabled, setSourceEnabled] = useState(readSourceLatch);
  const [sourceBlocked, setSourceBlocked] = useState(false);
  const sourceWindowRef = useRef<Window | null>(null);

  const syncRef = useRef<LiveSync | null>(null);
  const tpRef = useRef<HTMLDivElement>(null);
  const lastProgRef = useRef(-1);
  // Which scrolls of the script are Jake's (presenter/scrollGuard.ts) — re-made when the view mounts.
  const tpGuard = useScrollGuard(tpRef, [viewMode, !!dive, sections.length > 0, !!loadError]);
  const ref = useRef({ current: 0, count: 0, playing: false, speed: 2.5, fontSize: 32, lineHeight: 1.9, viewMode: 'teleprompter' as ViewMode });
  // The sync index is a BEAT across the whole show (v2 since 2026-10-02,
  // classic slides since 2026-10-06 — same code, ./beats.ts gives a classic
  // slide its beat count); the script belongs to the beat's chapter/slide and
  // only resets on a new one.
  const isV2 = dive?.format === 'v2';
  const chapters = useMemo(() => (isV2 ? sectionsToChapters(sections) : []), [isV2, sections]);
  const units: (Chapter | BeatUnit)[] = useMemo(() => (isV2 ? chapters : sectionsToUnits(sections)), [isV2, chapters, sections]);
  const beats = useMemo(() => flatten(units), [units]);
  const count = beats.length;
  const chapterIdx = beats[Math.min(current, beats.length - 1)]?.chapter ?? 0;
  const scrollKey = chapterIdx;
  ref.current = { current, count, playing, speed, fontSize, lineHeight, viewMode };

  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);

  useEffect(() => { try { localStorage.setItem(SOURCE_KEY, String(sourceEnabled)); } catch { /* private mode */ } }, [sourceEnabled]);

  // Content — refreshed so a script fixed in the editor mid-show shows up here.
  useEffect(() => {
    if (!user || !id) return;
    let alive = true;
    const load = () => getDeepDive(id)
      .then((r) => { if (alive) { setDive(r.deepDive); setSections(r.sections); } })
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [user, id]);

  // Join (or open) this dive's live session; it carries the last show's look.
  useEffect(() => {
    if (!user || !id) return;
    let cancelled = false;
    (async () => {
      try {
        // ⚠️ OPENING (OR RELOADING) THIS PAGE STARTS THE SHOW FROM THE TOP (Jake, 2026-10-07:
        // "Deep dive presentations should always reset to the beginning (first slide first
        // beat) when opening it again … I could load it during a live stream and land on the
        // wrong slide and script notes"). `reset` does it in the row and the live room, so the
        // show screen and every follower start at section 1, beat 1, script top, paused.
        const s = await startSession({ deckId: id, controllerId: deviceId, reset: true });
        if (cancelled) return;
        setCurrent(0);
        const st = await getSession({ sessionId: s.sessionId }).catch(() => null);
        const row = st?.session;
        if (!cancelled && row) {
          if (typeof row.tpFontSize === 'number') setFontSize(row.tpFontSize);
          if (typeof row.tpLineHeight === 'number') setLineHeight(row.tpLineHeight);
          if (typeof row.tpSpeed === 'number') setSpeed(row.tpSpeed);
          if (row.tpWidth === 'narrow' || row.tpWidth === 'medium' || row.tpWidth === 'wide') setWidth(row.tpWidth);
        }
        if (!cancelled) setSessionId(s.sessionId);
      } catch (e) {
        toast.error(`Couldn't start the live session: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => { cancelled = true; };
  }, [user, id]);

  const rateFor = useCallback((spd: number): number => {
    const el = tpRef.current;
    const max = el ? el.scrollHeight - el.clientHeight : 0;
    return max > 0 ? (spd * 8) / max / 1000 : 0;
  }, []);

  const flashSynced = useCallback(() => {
    setRemoteSynced(true);
    clearTimeout(syncedTimer.current);
    syncedTimer.current = setTimeout(() => setRemoteSynced(false), 2000);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const sync = connectLiveSync(sessionId);
    syncRef.current = sync;
    sync.socket.on('connect', () => setConnected(true));
    sync.socket.on('disconnect', () => setConnected(false));
    sync.onSync((snap) => {
      setPlaying(snap.isPlaying);
      if (typeof snap.scrollSpeed === 'number') setSpeed(snap.scrollSpeed);
      // Our own steps come back with the index we already show; anything else
      // was moved on another screen (the stage, a phone on the follower link).
      if (typeof snap.idx === 'number' && snap.idx !== ref.current.current) {
        setCurrent(Math.max(0, Math.min(Math.max(0, ref.current.count - 1), snap.idx)));
        flashSynced();
      }
      // A paused screen still follows a seek from elsewhere.
      if (!snap.isPlaying) {
        const el = tpRef.current;
        if (el) {
          const max = el.scrollHeight - el.clientHeight;
          if (max > 0) { lastProgRef.current = snap.position * max; el.scrollTop = snap.position * max; }
        }
      }
    });
    sync.onAppearance((a) => {
      if (typeof a.textSize === 'number') setFontSize(a.textSize);
      if (typeof a.lineHeight === 'number') setLineHeight(a.lineHeight);
      if (a.textWidth === 'narrow' || a.textWidth === 'medium' || a.textWidth === 'wide') setWidth(a.textWidth);
    });
    return () => { sync.close(); syncRef.current = null; setConnected(false); };
  }, [sessionId, flashSynced]);

  // The render loop: while playing, every frame solves the anchor. (In the
  // Notes view there is no script element, so it idles.)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = tpRef.current;
      const sync = syncRef.current;
      if (el && sync && ref.current.playing) {
        const max = el.scrollHeight - el.clientHeight;
        if (max > 0) {
          const top = sync.positionNow() * max;
          lastProgRef.current = top;
          el.scrollTop = top;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Back on the Teleprompter tab: the script element is new, so land it on the
  // shared position (a paused show would otherwise sit at the top).
  useEffect(() => {
    if (viewMode !== 'teleprompter') return;
    const raf = requestAnimationFrame(() => {
      const el = tpRef.current;
      const sync = syncRef.current;
      if (!el || !sync) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0) { const top = sync.positionNow() * max; lastProgRef.current = top; el.scrollTop = top; }
    });
    return () => cancelAnimationFrame(raf);
  }, [viewMode]);

  // Jake scrolling the script himself (wheel / drag) re-anchors every screen.
  const onTpScroll = () => {
    const el = tpRef.current;
    const sync = syncRef.current;
    if (!el || !sync) return;
    if (Math.abs(el.scrollTop - lastProgRef.current) < 3) return; // our own write
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    // Not a gesture that began on THIS script (a layout clamp, a flick from the previous
    // section, a re-layout): never published; right after a section change, put back.
    if (!tpGuard.userScrolling()) {
      if (tpGuard.sinceNav() < SETTLE_MS) {
        const top = (sync.state().idx === ref.current.current ? sync.positionNow() : 0) * max;
        lastProgRef.current = top;
        el.scrollTop = top;
      }
      return;
    }
    lastProgRef.current = el.scrollTop;
    sync.seek(el.scrollTop / max);
  };

  // New section: top of its script — before the browser can fire a scroll event for the
  // old offset clamped into the new script (a layout effect; see NotesPage).
  useLayoutEffect(() => {
    tpGuard.markNav();
    const el = tpRef.current;
    if (el) { lastProgRef.current = 0; el.scrollTop = 0; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);
  // New section or new layout: a rate for THIS script's length.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (ref.current.playing) syncRef.current?.setSpeed(ref.current.speed, rateFor(ref.current.speed));
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollKey, fontSize, lineHeight, width, viewMode, rateFor]);

  const unitsRef = useRef(units);
  unitsRef.current = units;
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  const go = useCallback((n: number) => {
    const total = ref.current.count;
    if (!total) return;
    const next = Math.max(0, Math.min(total - 1, n));
    const from = ref.current.current;
    if (next === from) return;
    setCurrent(next);
    // A beat inside the same chapter/slide keeps the script where it is.
    sendBeat(syncRef.current, beatsRef.current, from, next);
  }, []);

  // → on a section's LAST beat goes on only when pressed twice within 1 s — the AI News
  // rule and wording (presenter/controls.ts). Beats inside a section stay single-press.
  const leaveRef = useRef(leaveGuard());
  const step = useCallback((dir: 1 | -1) => {
    const c = ref.current.current;
    const b = beatsRef.current;
    if (dir > 0 && c < b.length - 1 && b[c] && b[c + 1] && b[c].chapter !== b[c + 1].chapter) {
      if (!leaveRef.current.press(b[c].chapter)) {
        toast.info(armMessage('section'), { id: ARM_TOAST_ID, duration: 2500 });
        return;
      }
      toast.dismiss(ARM_TOAST_ID);
    }
    leaveRef.current.disarm();
    go(c + dir);
  }, [go]);
  /** ‹ / › in the header: the previous / next SECTION (AI News: story), from its first beat. */
  const goSection = useCallback((chapter: number) => {
    const u = unitsRef.current;
    if (chapter < 0 || chapter >= u.length) return;
    leaveRef.current.disarm();
    go(firstBeatOf(u, chapter));
  }, [go]);

  const togglePlay = useCallback(() => {
    const sync = syncRef.current;
    if (!sync) return;
    const next = !ref.current.playing;
    // In the Notes view the script isn't laid out here (rate 0): keep the room's last slope.
    if (next) { const r = rateFor(ref.current.speed); if (r > 0) sync.setSpeed(ref.current.speed, r); }
    sync.playPause(next);
  }, [rateFor]);

  const nudge = useCallback((dir: 1 | -1) => {
    const el = tpRef.current;
    const sync = syncRef.current;
    if (!el || !sync) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    const step = ref.current.fontSize * ref.current.lineHeight * 3;
    sync.seek(Math.max(0, Math.min(1, sync.positionNow() + (dir * step) / max)));
  }, []);

  // G + number = that section (as G + number = that story on /notes).
  const [gBuffer, setGBuffer] = useState<string | null>(null);
  const gRef = useRef<{ buf: string | null; timer?: ReturnType<typeof setTimeout> }>({ buf: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement)?.closest('input, textarea')) return;
      const tp = ref.current.viewMode === 'teleprompter';
      const g = gRef.current;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowDown' && tp) { e.preventDefault(); nudge(1); }
      else if (e.key === 'ArrowUp' && tp) { e.preventDefault(); nudge(-1); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }   // always play/pause, in both views (Jake 2026-10-07)
      else if (e.key === 'e' || e.key === 'E') setConfirmEnd(true);
      else if (e.key === 't' || e.key === 'T') setViewMode((v) => (v === 'notes' ? 'teleprompter' : 'notes'));
      else if (e.key === 'g' || e.key === 'G') { g.buf = ''; setGBuffer(''); }
      else if (g.buf !== null && /^\d$/.test(e.key)) {
        const buf = g.buf + e.key;
        g.buf = buf; setGBuffer(buf);
        clearTimeout(g.timer);
        g.timer = setTimeout(() => { goSection(parseInt(buf, 10) - 1); g.buf = null; setGBuffer(null); }, 600);
      }
      else if (/^[1-9]$/.test(e.key)) goSection(parseInt(e.key, 10) - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, goSection, nudge, togglePlay]);

  // The latched source tab follows the show (navigated in place, never reopened).
  const sec = sections[Math.min(chapterIdx, Math.max(0, sections.length - 1))];
  const sourceUrl = sectionSourceUrl(sec, isV2, dive);
  useEffect(() => {
    if (!sourceEnabled || !sourceUrl) return;
    const win = sourceWindowRef.current;
    if (!win || win.closed) { sourceWindowRef.current = null; setSourceEnabled(false); return; }
    try { if (win.location.href !== sourceUrl) win.location.href = sourceUrl; } catch {
      try { win.location.href = sourceUrl; } catch { /* cross-origin nav refused */ }
    }
    window.focus();
  }, [sourceUrl, sourceEnabled]);

  const toggleSource = () => {
    if (sourceEnabled) { setSourceEnabled(false); return; }
    if (!sourceUrl) return;
    const win = window.open(sourceUrl, 'dd-source-tab');
    if (win) {
      sourceWindowRef.current = win;
      setSourceEnabled(true);
      setSourceBlocked(false);
      setTimeout(() => window.focus(), 100);
    } else {
      setSourceBlocked(true);
    }
  };

  const openScreen = () => {
    const w = window.open(stagePath(id, sessionId || undefined), 'dd-stage');
    if (!w) toast.error('The browser blocked the new window. Allow pop-ups for this site, or open the screen from the editor.');
  };

  const doEnd = async () => {
    if (!sessionId) return;
    try {
      await endSession({ sessionId, totalDurationSeconds: Math.round((Date.now() - startedAt) / 1000) });
      navigate(editorPath(id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const center = (msg: string) => (
    <div style={{ height: '100vh', background: D.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <p style={{ color: D.muted }}>{msg}</p>
    </div>
  );
  if (authLoading || !user) return center('Loading…');
  if (loadError) return center(loadError);
  if (!dive) return center('Loading…');
  if (!sections.length || !sec) return center('This deep dive has no sections yet. Generate it in the editor first.');

  const next = sections[chapterIdx + 1];
  const unit = units[Math.min(chapterIdx, units.length - 1)];
  const beatNow = beats[Math.min(current, beats.length - 1)]?.beat ?? 0;
  const parts = unit ? scriptParts(unit) : [];
  const nBeats = unit ? beatCount(unit) : 1;
  // "▶ BEAT n · TITLE[ · LAST]" — the same text the follower page gets from the server.
  const marks = ddBeatMarks(sec, isV2, nBeats);
  const kindLabel = (k: string) => (isV2 ? CHAPTER_LABEL[k as keyof typeof CHAPTER_LABEL] : KIND_LABEL[k as keyof typeof KIND_LABEL]) || k;
  const headingOf = (s: Section) => (s.heading || kindLabel(s.kind)).replace(/\*/g, '');
  const title = dive.title || dive.topic;
  const items = beatItems(sec, isV2);
  const nextLabel = beatNow < nBeats - 1
    ? (items[beatNow + 1] || `beat ${beatNow + 2}`)
    : next ? `section ${chapterIdx + 2} · ${headingOf(next)}` : null;
  const isTeleprompter = viewMode === 'teleprompter';
  const island = isV2 ? ((sec.data ?? {}) as { island?: { q?: string; a?: string } }).island : null;
  const angle = island?.q ? `${island.q} → ${island.a ?? ''}` : (sec.eyebrow || sec.data?.subtitle || sec.data?.text || sec.data?.kicker || '');
  const sources = dive.sources ?? [];

  const setLook = (patch: { size?: number; width?: TpWidth }) => {
    if (patch.size !== undefined) { setFontSize(patch.size); syncRef.current?.setTextSize(patch.size); }
    if (patch.width) { setWidth(patch.width); syncRef.current?.setTextWidth(patch.width); }
  };

  return (
    <div style={{ height: '100vh', background: D.bg, color: D.text, display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', overflow: 'hidden' }}>

      {/* ── Header bar (the /notes header) ──────────────────────────────── */}
      <header style={{ background: D.panel, borderBottom: `1px solid ${D.border}`, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <NavStepper
          label={<>
            {nBeats > 1 ? `${chapterIdx + 1}.${beatNow + 1}` : chapterIdx + 1} / {sections.length}
            {gBuffer && <span style={{ marginLeft: 6, fontSize: 11, color: D.blue }}>→ {gBuffer}</span>}
          </>}
          onPrev={() => goSection(chapterIdx - 1)} prevDisabled={chapterIdx === 0} prevTitle="Previous section (← steps beats)"
          onNext={() => goSection(chapterIdx + 1)} nextDisabled={chapterIdx >= units.length - 1} nextTitle="Next section (→ steps beats)"
        />

        <TopicLabel>{headingOf(sec)} <span style={{ color: D.faint }}>· {title}</span></TopicLabel>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <ViewToggle mode={viewMode} onChange={setViewMode} />

          <Divider />

          <span data-live={connected ? 'on' : 'off'} title={connected ? 'Live sync connected' : 'Connecting…'}
            style={{ width: 7, height: 7, borderRadius: 99, background: connected ? D.green : D.orange }} />
          <FollowerLinkButton getSessionId={() => sessionId} synced={remoteSynced} />

          <Divider />

          <ScreenButton onClick={openScreen} disabled={!sessionId} />
          {sourceUrl && <SourceButton enabled={sourceEnabled} blocked={sourceBlocked} onClick={toggleSource} />}
          <button onClick={() => navigate(editorPath(id))} style={smallBtn}>Editor</button>
          <EndButton onClick={() => setConfirmEnd(true)} />
        </div>
      </header>

      {isTeleprompter ? (
        // ── TELEPROMPTER VIEW (as /notes) ────────────────────────────────
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            ref={tpRef}
            onScroll={onTpScroll}
            style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative', scrollbarWidth: 'thin', scrollbarColor: `${D.faint} transparent` }}
          >
            <ScrollPill paused={!playing} />

            <div style={{ maxWidth: WIDTH_PX[width], margin: '0 auto', padding: '44px 40px 0', position: 'relative' }}>
              {/* One line, always — a wrapped label would push this screen's
                  script below the follower's (followerPage.ts `#label`). */}
              <p style={{ fontSize: 11, fontWeight: 700, color: D.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 28, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {chapterIdx + 1} / {sections.length} · {kindLabel(sec.kind)}{sec.heading ? ` · ${sec.heading.replace(/\*/g, '')}` : ''}
                {nBeats > 1 ? ` · beat ${beatNow + 1} of ${nBeats}` : ''}
              </p>

              {parts.some((p) => p.trim()) ? parts.map((part, b) => (
                <div key={`${sec.id}:b${b}`} style={{ opacity: b < beatNow ? 0.35 : 1, transition: 'opacity .3s' }}>
                  {b > 0 && <p style={newsMarkStyle(fontSize, b === beatNow + 1, b === nBeats - 1)}>{marks[b] || `▶ BEAT ${b}`}</p>}
                  {part.split(/\n+/).map((t) => t.trim()).filter(Boolean).map((para, i) => (
                    <p key={i} style={{
                      fontSize, lineHeight, color: '#ffffff', fontWeight: 400,
                      margin: `0 0 ${Math.round(fontSize * 0.8)}px`,
                      letterSpacing: '0.012em', fontFamily: SCRIPT_FONT, WebkitTextSizeAdjust: '100%',
                    } as CSSProperties}>{para}</p>
                  ))}
                </div>
              )) : (
                <div style={{ textAlign: 'center', marginTop: 60 }}>
                  <p style={{ fontSize: 18, color: D.muted, marginBottom: 8 }}>No script for this section.</p>
                  <p style={{ fontSize: 13, color: D.faint }}>Write one in the editor.</p>
                </div>
              )}

              <p style={{ fontSize: 11, fontWeight: 700, color: D.faint, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 12 }}>
                {next ? `Next → ${headingOf(next)}` : 'End of the deep dive'}
              </p>

              {/* Bottom spacer so the last line can scroll to the top */}
              <div style={{ height: '70vh' }} />
            </div>
          </div>

          {/* ── Controls bar (the /notes bar) ─────────────────────────────── */}
          <ControlsBar>
            <PlayButton paused={!playing} onClick={togglePlay} />

            <SpeedControl value={speed} onChange={(v) => { setSpeed(v); syncRef.current?.setSpeed(v, rateFor(v)); }} />

            <Divider spaced />

            <SizeControl value={fontSize} onChange={(v) => setLook({ size: v })} />

            <Divider spaced />

            <WidthToggle value={width} onChange={(w) => setLook({ width: w })} />

            <Divider spaced />
            <BeatDots cur={beatNow} total={nBeats} next={nextLabel} title="→ / ← step the beats, then the sections" />

            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: D.faint, whiteSpace: 'nowrap' }}>Followers see this tab</span>
          </ControlsBar>
        </div>
      ) : (
        // ── NOTES VIEW (as /notes) ───────────────────────────────────────
        <>
          <div style={{ padding: '14px 18px 6px', flexShrink: 0 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#fff', margin: 0, lineHeight: 1.3 }}>{headingOf(sec)}</h1>
            <p style={{ fontSize: 12, color: D.muted, margin: '4px 0 0' }}>
              {kindLabel(sec.kind)} · section {chapterIdx + 1} of {sections.length}{nBeats > 1 ? ` · beat ${beatNow + 1} of ${nBeats}` : ''}
            </p>
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: '10px 16px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, alignContent: 'start' }}>
            <NoteCard title="🎯 The point" text={angle.replace(/\*/g, '')} />
            <NoteCard title="🔑 On screen, beat by beat" keyPoints={items} current={beatNow} />
            <NoteCard title="📚 Sources" keyPoints={sources.slice(0, 6).map((s) => `${s.outlet || 'Source'}${s.official && !/official/i.test(s.outlet || '') ? ' (official)' : ''} — ${s.title}`)} />
          </div>

          {next && (
            <div style={{ padding: '6px 16px 12px', flexShrink: 0 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: D.muted, letterSpacing: '0.06em', textTransform: 'uppercase', margin: '0 0 6px' }}>Up Next</p>
              <div style={{ display: 'flex', gap: 8 }}>
                {sections.slice(chapterIdx + 1, chapterIdx + 3).map((s, i) => (
                  <button
                    key={s.id}
                    onClick={() => go(firstBeatOf(units, chapterIdx + 1 + i))}
                    style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 6, padding: '7px 11px', flex: 1, textAlign: 'left', cursor: 'pointer', transition: 'border-color 0.15s' }}
                    onMouseEnter={(e) => (e.currentTarget.style.borderColor = D.blue)}
                    onMouseLeave={(e) => (e.currentTarget.style.borderColor = D.border)}
                  >
                    <p style={{ fontSize: 12, color: D.text, margin: 0, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {chapterIdx + 2 + i}. {headingOf(s)}
                    </p>
                    <p style={{ fontSize: 11, color: D.muted, margin: '2px 0 0' }}>{kindLabel(s.kind)}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <AlertDialog open={confirmEnd} onOpenChange={setConfirmEnd}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End the deep dive?</AlertDialogTitle>
            <AlertDialogDescription>The next time it opens, it starts again from the first section.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doEnd}>End</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
