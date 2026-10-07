/**
 * The audience screen's stepping, shared by BOTH formats (Jake, 2026-10-06:
 * classic slides step "exactly the way" demo slides do — one code path, not
 * a copy). The sync index is a BEAT across the whole show (types.ts
 * `flatten`); a v2 chapter or a classic slide is one "unit" of beats.
 *
 *   ← / → , PageUp / PageDown      previous / next beat — on a unit's LAST beat
 *                                  → goes on only when pressed twice within 1 s,
 *                                  the presenter's rule (presenter/controls.ts);
 *                                  silent here: this screen is on camera
 *   mouse wheel / vertical swipe   previous / next UNIT (scrolls like a site)
 *   horizontal swipe               previous / next beat
 *   ↑ / ↓                          nudge the presenter's script
 *   Space                          play / pause the script
 *   Home / End, F full screen
 *
 * Inside one unit the teleprompter keeps still (beatSync.ts). The page adds
 * its own keys through `onKey` (return true when it handled the key).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { startSession } from '../../api';
import { connectLiveSync, type LiveSync } from '../../liveSync';
import { sendBeat } from './beatSync';
import { leaveGuard } from '../../presenter/controls';
import { flatten, firstBeatOf, type BeatUnit, type Chapter, type FlatBeat } from './types';

export interface BeatStage {
  /** The flat beat index on screen. */
  flat: number;
  beats: FlatBeat[];
  /** True for the first paint (no slide transition). */
  instant: boolean;
  /** The mouse has rested: hide the cursor (this screen is on camera). */
  cursorHidden: boolean;
  /** Go to beat `n`; `broadcast` = this screen moved it, so tell the room. */
  show: (n: number, broadcast: boolean) => void;
}

export function useBeatStage({ diveId, units, onKey }: {
  diveId: string;
  units: (Chapter | BeatUnit)[];
  onKey?: (e: KeyboardEvent) => boolean;
}): BeatStage {
  const [params] = useSearchParams();
  const beats = useMemo(() => flatten(units), [units]);
  const [flat, setFlat] = useState(0);
  const [instant, setInstant] = useState(true);
  const [cursorHidden, setCursorHidden] = useState(false);
  const syncRef = useRef<LiveSync | null>(null);
  const st = useRef({ flat: 0, beats, units });
  st.current = { flat: st.current.flat, beats, units };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;

  useEffect(() => { const t = setTimeout(() => setInstant(false), 50); return () => clearTimeout(t); }, []);

  const show = useCallback((n: number, broadcast: boolean) => {
    const total = st.current.beats.length;
    if (!total) return;
    const next = Math.max(0, Math.min(total - 1, n));
    const from = st.current.flat;
    if (next === from) return;
    st.current.flat = next;
    setFlat(next);
    if (broadcast) sendBeat(syncRef.current, st.current.beats, from, next);
  }, []);

  // → / PageDown / a left swipe: beats, and past a unit's last beat only on a double press.
  const leave = useRef(leaveGuard());
  const beatStep = useCallback((dir: 1 | -1) => {
    const { flat: f, beats: b } = st.current;
    if (dir > 0 && f < b.length - 1 && b[f] && b[f + 1] && b[f].chapter !== b[f + 1].chapter) {
      if (!leave.current.press(b[f].chapter)) return;
    }
    leave.current.disarm();
    show(f + dir, true);
  }, [show]);

  const unitStep = useCallback((dir: 1 | -1) => {
    const { flat: f, beats: b, units: u } = st.current;
    const cur = b[f]?.chapter ?? 0;
    const target = Math.max(0, Math.min(u.length - 1, cur + dir));
    if (target !== cur) show(firstBeatOf(u, target), true);
  }, [show]);

  const nudgeScript = useCallback((dir: 1 | -1) => {
    const sync = syncRef.current;
    if (!sync) return;
    const c = st.current.units[st.current.beats[st.current.flat]?.chapter ?? 0];
    const words = (c?.script || '').split(/\s+/).filter(Boolean).length;
    const step = words > 0 ? Math.min(0.25, 30 / words) : 0.1;
    sync.seek(Math.max(0, Math.min(1, sync.positionNow() + dir * step)));
  }, []);

  // Live session (the presenter opens this page with ?session=…).
  useEffect(() => {
    let sync: LiveSync | null = null;
    let cancelled = false;
    (async () => {
      let sid = params.get('session') || '';
      // Opened on its own (not from the presenter's Screen button): a show nobody is on
      // starts from the top, like the presenter (Jake 2026-10-07); a running one is joined as is.
      if (!sid) { try { sid = (await startSession({ deckId: diveId, resetIfIdle: true })).sessionId; } catch { return; } }
      if (cancelled || !sid) return;
      sync = connectLiveSync(sid);
      syncRef.current = sync;
      sync.onSync((snap) => {
        if (typeof snap.idx === 'number' && snap.idx !== st.current.flat) show(snap.idx, false);
      });
    })();
    return () => { cancelled = true; sync?.close(); syncRef.current = null; };
  }, [diveId, params, show]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowRight': case 'PageDown': e.preventDefault(); beatStep(1); return;
        case 'ArrowLeft': case 'PageUp': e.preventDefault(); beatStep(-1); return;
        case 'ArrowDown': e.preventDefault(); nudgeScript(1); return;
        case 'ArrowUp': e.preventDefault(); nudgeScript(-1); return;
        case ' ': { e.preventDefault(); const s = syncRef.current; if (s) s.playPause(!s.state().isPlaying); return; }
        case 'Home': e.preventDefault(); show(0, true); return;
        case 'End': e.preventDefault(); show(st.current.beats.length - 1, true); return;
        case 'f': case 'F':
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen?.().catch(() => {});
          return;
      }
      keyRef.current?.(e);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [show, beatStep, nudgeScript]);

  // Wheel = one unit per gesture (a trackpad fires dozens of events).
  useEffect(() => {
    let acc = 0, lockedUntil = 0, lastAt = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastAt > 250) acc = 0;
      lastAt = now;
      if (now < lockedUntil) return;
      acc += e.deltaY;
      if (Math.abs(acc) > 60) { unitStep(acc > 0 ? 1 : -1); acc = 0; lockedUntil = now + 950; }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [unitStep]);

  // Touch: horizontal swipe = beat, vertical = unit.
  useEffect(() => {
    let p0: { x: number; y: number } | null = null;
    const start = (e: TouchEvent) => { const t = e.touches[0]; p0 = t ? { x: t.clientX, y: t.clientY } : null; };
    const end = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!p0 || !t) return;
      const dx = t.clientX - p0.x, dy = t.clientY - p0.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) beatStep(dx < 0 ? 1 : -1);
      else if (Math.abs(dy) > 60) unitStep(dy < 0 ? 1 : -1);
      p0 = null;
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchend', end, { passive: true });
    return () => { window.removeEventListener('touchstart', start); window.removeEventListener('touchend', end); };
  }, [beatStep, unitStep]);

  // This screen is on camera: hide a resting cursor.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const move = () => { setCursorHidden(false); clearTimeout(t); t = setTimeout(() => setCursorHidden(true), 2000); };
    move();
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mousemove', move); clearTimeout(t); };
  }, []);

  // A unit removed mid-show.
  useEffect(() => { if (beats.length && flat > beats.length - 1) show(beats.length - 1, false); }, [beats.length, flat, show]);

  return { flat, beats, instant, cursorHidden, show };
}
