/**
 * Deep Dive v2 — the audience screen. Same live session and keys as v1
 * (DeepDiveStagePage), but the sync index is a BEAT (types.ts `flatten`):
 *   ← / → , PageUp / PageDown      previous / next beat
 *   mouse wheel / vertical swipe   previous / next CHAPTER (scrolls like a site)
 *   ↑ / ↓                          nudge the presenter's script
 *   Space                          play / pause the script
 *   Home / End, F full screen
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { startSession } from '../../api';
import { connectLiveSync, type LiveSync } from '../../liveSync';
import type { DeepDive, Section } from '../api';
import { sectionsToChapters } from './adapt';
import Show from './Show';
import LiveDemo from './LiveDemo';
import { sendBeat } from './beatSync';
import { flatten, firstBeatOf } from './types';

export default function StageV2({ dive, sections }: { dive: DeepDive; sections: Section[] }) {
  const [params] = useSearchParams();
  const chapters = useMemo(() => sectionsToChapters(sections), [sections]);
  const beats = useMemo(() => flatten(chapters), [chapters]);
  const [flat, setFlat] = useState(0);
  const [instant, setInstant] = useState(true);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [live, setLive] = useState(false);
  const syncRef = useRef<LiveSync | null>(null);
  const st = useRef({ flat: 0, beats, chapters });
  st.current = { flat, beats, chapters };

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

  const chapterStep = useCallback((dir: 1 | -1) => {
    const { flat: f, beats: b, chapters: ch } = st.current;
    const cur = b[f]?.chapter ?? 0;
    const target = Math.max(0, Math.min(ch.length - 1, cur + dir));
    if (target !== cur) show(firstBeatOf(ch, target), true);
  }, [show]);

  const nudgeScript = useCallback((dir: 1 | -1) => {
    const sync = syncRef.current;
    if (!sync) return;
    const c = st.current.chapters[st.current.beats[st.current.flat]?.chapter ?? 0];
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
      if (!sid) { try { sid = (await startSession({ deckId: dive.id })).sessionId; } catch { return; } }
      if (cancelled || !sid) return;
      sync = connectLiveSync(sid);
      syncRef.current = sync;
      sync.onSync((snap) => {
        if (typeof snap.idx === 'number' && snap.idx !== st.current.flat) show(snap.idx, false);
      });
    })();
    return () => { cancelled = true; sync?.close(); syncRef.current = null; };
  }, [dive.id, params, show]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const f = st.current.flat;
      switch (e.key) {
        case 'ArrowRight': case 'PageDown': e.preventDefault(); show(f + 1, true); break;
        case 'ArrowLeft': case 'PageUp': e.preventDefault(); show(f - 1, true); break;
        case 'ArrowDown': e.preventDefault(); nudgeScript(1); break;
        case 'ArrowUp': e.preventDefault(); nudgeScript(-1); break;
        case ' ': { e.preventDefault(); const s = syncRef.current; if (s) s.playPause(!s.state().isPlaying); break; }
        case 'l': case 'L': if (dive.demoAgent) setLive((v) => !v); break;
        case 'Escape': setLive(false); break;
        case 'Home': e.preventDefault(); show(0, true); break;
        case 'End': e.preventDefault(); show(st.current.beats.length - 1, true); break;
        case 'f': case 'F':
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen?.().catch(() => {});
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, nudgeScript, dive.demoAgent]);

  // Wheel = one chapter per gesture (a trackpad fires dozens of events).
  useEffect(() => {
    let acc = 0, lockedUntil = 0, lastAt = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastAt > 250) acc = 0;
      lastAt = now;
      if (now < lockedUntil) return;
      acc += e.deltaY;
      if (Math.abs(acc) > 60) { chapterStep(acc > 0 ? 1 : -1); acc = 0; lockedUntil = now + 950; }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [chapterStep]);

  // Touch: horizontal swipe = beat, vertical = chapter.
  useEffect(() => {
    let p0: { x: number; y: number } | null = null;
    const start = (e: TouchEvent) => { const t = e.touches[0]; p0 = t ? { x: t.clientX, y: t.clientY } : null; };
    const end = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!p0 || !t) return;
      const dx = t.clientX - p0.x, dy = t.clientY - p0.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(st.current.flat + (dx < 0 ? 1 : -1), true);
      else if (Math.abs(dy) > 60) chapterStep(dy < 0 ? 1 : -1);
      p0 = null;
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchend', end, { passive: true });
    return () => { window.removeEventListener('touchstart', start); window.removeEventListener('touchend', end); };
  }, [show, chapterStep]);

  // This screen is on camera: hide a resting cursor.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const move = () => { setCursorHidden(false); clearTimeout(t); t = setTimeout(() => setCursorHidden(true), 2000); };
    move();
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mousemove', move); clearTimeout(t); };
  }, []);

  // A chapter removed mid-show.
  useEffect(() => { if (beats.length && flat > beats.length - 1) show(beats.length - 1, false); }, [beats.length, flat, show]);

  if (!chapters.length) {
    return <div className="fixed inset-0 grid place-items-center bg-black text-lg text-white/60">This deep dive has no chapters yet. Generate it first.</div>;
  }
  return (
    <div className="fixed inset-0 select-none" style={{ cursor: cursorHidden ? 'none' : 'default' }}>
      <Show chapters={chapters} diveId={dive.id} flat={flat} onFlat={(n) => show(n, true)} instant={instant}
        onRunLive={dive.demoAgent ? () => setLive(true) : undefined}
        overlay={live ? <LiveDemo diveId={dive.id} onClose={() => setLive(false)} /> : null} />
    </div>
  );
}
