/**
 * Deep Dive — the full-screen presentation the audience sees
 * (/news-gatherer/deep-dive/:id/present). Outside the NewsShell.
 *
 * Keys (Jake, 2026-10-01): ←/→ step SECTIONS; ↑/↓ belong to the TELEPROMPTER
 * only — here they nudge the shared script, exactly like on the presenter.
 * The mouse wheel scrolls the SITE like any website: down = next section,
 * up = previous (Jake, 2026-10-01). PageUp/PageDown
 * (what presentation clickers send) step sections; Space plays/pauses the
 * script; Home/End; a horizontal swipe on a touch screen; F for full screen.
 *
 * It joins the deep dive's live session (the same socket sync as the Daily
 * Show, keyed by session id), so the presenter's screen and this one always
 * show the same section, whichever one moved. On its own it works as a
 * rehearsal view.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { startSession } from '../api';
import { connectLiveSync, type LiveSync } from '../liveSync';
import VideoEmbed from '../components/VideoEmbed';
import { getDeepDive, sectionMedia, type DeepDive, type Section } from './api';
import { Scene, StageFrame, useDeepDiveFont } from './Scene';
import StageV2 from './v2/StageV2';

/**
 * v1 dives keep their slide stage untouched; v2 dives (format 'v2', Jake
 * 2026-10-02) get the chapter show. Picked once the dive has loaded.
 */
export default function DeepDiveStagePage() {
  const { id = '' } = useParams();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();
  const [loaded, setLoaded] = useState<{ dive: DeepDive; sections: Section[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);
  useEffect(() => {
    if (!user || !id) return;
    let alive = true;
    const load = () => getDeepDive(id)
      .then((r) => { if (alive) setLoaded({ dive: r.deepDive, sections: r.sections }); })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    load();
    // Fresh content mid-show (an edit in the editor reaches the screen).
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [user, id]);
  if (error) return <div className="fixed inset-0 grid place-items-center bg-black text-sm text-white/60">{error}</div>;
  if (!loaded) return <div className="fixed inset-0 bg-black" />;
  if (loaded.dive.format === 'v2') return <StageV2 dive={loaded.dive} sections={loaded.sections} />;
  return <StageV1 />;
}


interface Shown { idx: number; key: number; back: boolean; leaving?: 'up' | 'down' }

function StageV1() {
  useDeepDiveFont();
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { user, isLoading: authLoading, loginWithRedirect } = useAuth();

  const [dive, setDive] = useState<DeepDive | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(0);
  const [shown, setShown] = useState<Shown[]>([{ idx: 0, key: 0, back: false }]);
  const [cursorHidden, setCursorHidden] = useState(false);

  const syncRef = useRef<LiveSync | null>(null);
  const currentRef = useRef(0);
  const countRef = useRef(0);
  const keySeq = useRef(1);

  useEffect(() => {
    if (!authLoading && !user) loginWithRedirect({ redirectUrl: window.location.href });
  }, [authLoading, user, loginWithRedirect]);

  // Load, and keep the content fresh: an edit made in the editor mid-show
  // reaches the screen within a few seconds.
  useEffect(() => {
    if (!user || !id) return;
    let alive = true;
    const load = () => getDeepDive(id)
      .then((r) => { if (!alive) return; setDive(r.deepDive); setSections(r.sections); countRef.current = r.sections.length; })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [user, id]);

  /** Show section `n`. `broadcast` = this screen moved it, so tell the room. */
  const show = useCallback((n: number, broadcast: boolean) => {
    const total = countRef.current;
    if (total === 0) return;
    const next = Math.max(0, Math.min(total - 1, n));
    const prev = currentRef.current;
    if (next === prev) return;
    const back = next < prev;
    currentRef.current = next;
    setCurrent(next);
    setShown((list) => {
      const leaving = list.filter((x) => !x.leaving).map((x) => ({ ...x, leaving: back ? 'down' as const : 'up' as const }));
      return [...leaving, { idx: next, key: keySeq.current++, back }];
    });
    if (broadcast) syncRef.current?.setSlide(next);
  }, []);

  /**
   * ↑/↓ on this screen: move the presenter's script by about three lines.
   * This page has no script on it to measure, so the step is a fraction of
   * the section's word count (~10 words a line) — close to the presenter's
   * own three-line nudge, and the presenter re-renders from the same anchor.
   */
  const sectionsRef = useRef<Section[]>([]);
  sectionsRef.current = sections;
  const nudgeScript = useCallback((dir: 1 | -1) => {
    const sync = syncRef.current;
    if (!sync) return;
    const words = (sectionsRef.current[currentRef.current]?.script || '').split(/\s+/).filter(Boolean).length;
    const step = words > 0 ? Math.min(0.25, 30 / words) : 0.1;
    sync.seek(Math.max(0, Math.min(1, sync.positionNow() + dir * step)));
  }, []);

  // Drop finished exit animations.
  useEffect(() => {
    if (!shown.some((x) => x.leaving)) return;
    const t = setTimeout(() => setShown((list) => list.filter((x) => !x.leaving)), 600);
    return () => clearTimeout(t);
  }, [shown]);

  // Live session: the one in the URL (the presenter opens this page with it),
  // else this dive's open session, else a new one.
  useEffect(() => {
    if (!user || !id) return;
    let sync: LiveSync | null = null;
    let cancelled = false;
    (async () => {
      let sid = params.get('session') || '';
      if (!sid) {
        try { sid = (await startSession({ deckId: id })).sessionId; } catch { return; }
      }
      if (cancelled || !sid) return;
      sync = connectLiveSync(sid);
      syncRef.current = sync;
      sync.onSync((snap) => {
        if (typeof snap.idx === 'number' && snap.idx !== currentRef.current) show(snap.idx, false);
      });
    })();
    return () => { cancelled = true; sync?.close(); syncRef.current = null; };
  }, [user, id, params, show]);

  // Keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const c = currentRef.current;
      switch (e.key) {
        case 'ArrowRight': case 'PageDown':
          e.preventDefault(); show(c + 1, true); break;
        case 'ArrowLeft': case 'PageUp':
          e.preventDefault(); show(c - 1, true); break;
        case 'ArrowDown': e.preventDefault(); nudgeScript(1); break;
        case 'ArrowUp': e.preventDefault(); nudgeScript(-1); break;
        case ' ': {
          e.preventDefault();
          const sync = syncRef.current;
          if (sync) sync.playPause(!sync.state().isPlaying);
          break;
        }
        case 'Home': e.preventDefault(); show(0, true); break;
        case 'End': e.preventDefault(); show(countRef.current - 1, true); break;
        case 'f': case 'F':
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen?.().catch(() => {});
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, nudgeScript]);

  // Mouse wheel / trackpad: one SECTION per gesture, like scrolling a page.
  // A trackpad fires dozens of wheel events per swipe, so accumulate, step
  // once, then ignore the rest of that gesture.
  useEffect(() => {
    let acc = 0;
    let lockedUntil = 0;
    let lastAt = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastAt > 250) acc = 0;
      lastAt = now;
      if (now < lockedUntil) return;
      acc += e.deltaY;
      if (Math.abs(acc) > 60) {
        show(currentRef.current + (acc > 0 ? 1 : -1), true);
        acc = 0;
        lockedUntil = now + 850;
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [show]);

  // Horizontal swipe = sections (left/right, like the arrow keys).
  useEffect(() => {
    let x0: number | null = null;
    const start = (e: TouchEvent) => { x0 = e.touches[0]?.clientX ?? null; };
    const end = (e: TouchEvent) => {
      if (x0 === null) return;
      const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
      if (Math.abs(dx) > 50) show(currentRef.current + (dx < 0 ? 1 : -1), true);
      x0 = null;
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchend', end, { passive: true });
    return () => { window.removeEventListener('touchstart', start); window.removeEventListener('touchend', end); };
  }, [show]);

  // Hide the cursor when the mouse rests — this screen is on camera.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const move = () => { setCursorHidden(false); clearTimeout(t); t = setTimeout(() => setCursorHidden(true), 2000); };
    move();
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mousemove', move); clearTimeout(t); };
  }, []);

  // A section removed in the editor while we were past it.
  useEffect(() => {
    if (sections.length && current > sections.length - 1) show(sections.length - 1, false);
  }, [sections.length, current, show]);

  const black = <div className="fixed inset-0 bg-[#06070b]" />;
  if (authLoading || !user) return black;
  if (error) return <div className="fixed inset-0 grid place-items-center bg-[#06070b] text-sm text-white/60">{error}</div>;
  if (!dive) return black;
  if (!sections.length) {
    return <div className="fixed inset-0 grid place-items-center bg-[#06070b] text-lg text-white/60">This deep dive has no sections yet. Generate it first.</div>;
  }

  const total = sections.length;
  const title = dive.title || dive.topic;
  // Players for this section and its neighbours, so stepping onto a video
  // never shows a black frame while YouTube loads.
  const nearby = [current - 1, current, current + 1].filter((i) => i >= 0 && i < total);

  return (
    <div className="fixed inset-0 select-none" style={{ cursor: cursorHidden ? 'none' : 'default' }}>
      {/* No footer (Jake, 2026-10-01: "AI Deep Dive" at the bottom isn't needed). */}
      <StageFrame index={current} total={total}>
        <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
          {nearby.map((i) => {
            const m = sectionMedia(sections[i]);
            return m && sections[i].kind === 'media' ? <VideoEmbed key={`${sections[i].id}:${m.key}`} media={m} active={i === current} /> : null;
          })}
        </div>
        {shown.map((x) => {
          const sec = sections[x.idx];
          if (!sec) return null;
          return (
            <Scene
              key={x.key}
              section={sec}
              index={x.idx}
              total={total}
              title={title}
              back={x.back}
              leaving={x.leaving}
              active={!x.leaving}
            />
          );
        })}
      </StageFrame>
    </div>
  );
}
