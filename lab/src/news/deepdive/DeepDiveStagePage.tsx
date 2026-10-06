/**
 * Deep Dive — the full-screen presentation the audience sees
 * (/news-gatherer/deep-dive/:id/present). Outside the NewsShell.
 *
 * Keys (Jake, 2026-10-01; beats 2026-10-06): ←/→ step BEATS (a slide's items
 * build in one press at a time, then the next slide); ↑/↓ belong to the TELEPROMPTER
 * only — here they nudge the shared script, exactly like on the presenter.
 * The mouse wheel scrolls the SITE like any website: down = next section,
 * up = previous (Jake, 2026-10-01). PageUp/PageDown
 * (what presentation clickers send) step beats too; Space plays/pauses the
 * script; Home/End; a horizontal swipe on a touch screen; F for full screen;
 * B / C / G the camera bubble (corner / camera / guide — bubble.tsx).
 *
 * It joins the deep dive's live session (the same socket sync as the Daily
 * Show, keyed by session id), so the presenter's screen and this one always
 * show the same section, whichever one moved. On its own it works as a
 * rehearsal view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../auth';
import VideoEmbed from '../components/VideoEmbed';
import { getDeepDive, sectionMedia, type DeepDive, type Section } from './api';
import { Scene, StageFrame, useDeepDiveFont } from './Scene';
import StageV2 from './v2/StageV2';
import { useBeatStage } from './v2/useBeatStage';
import { sectionsToUnits } from './beats';
import { templateFor } from './templates';
import { BubbleLayer, bubbleKey, useBubbleSettings } from './bubble';

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
  return <StageV1 dive={loaded.dive} sections={loaded.sections} />;
}


interface Shown { idx: number; key: number; back: boolean; leaving?: 'up' | 'down'; /** The beat it left on. */ beat?: number }

/**
 * Classic slides. Since 2026-10-06 they step in BEATS exactly like the demo
 * show (Jake): the stepping, keys, wheel, swipe and live sync are the same
 * hook (v2/useBeatStage.ts) fed the slides' beat counts (./beats.ts), and
 * each slide builds its items in one → at a time (Scene `beat`).
 */
function StageV1({ dive, sections }: { dive: DeepDive; sections: Section[] }) {
  useDeepDiveFont();
  const units = useMemo(() => sectionsToUnits(sections), [sections]);
  const [bubble, setBubble] = useBubbleSettings();
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  const { flat, beats, cursorHidden } = useBeatStage({
    diveId: dive.id,
    units,
    onKey: (e) => bubbleKey(e, bubbleRef.current, setBubble),
  });
  const at = beats[Math.max(0, Math.min(beats.length - 1, flat))] ?? { chapter: 0, beat: 0 };
  const current = at.chapter;

  const [shown, setShown] = useState<Shown[]>([{ idx: current, key: 0, back: false }]);
  const keySeq = useRef(1);
  const prevAt = useRef(at);
  // A new slide: the old one plays its exit (frozen on the beat it was on), the new one builds in.
  useEffect(() => {
    const prev = prevAt.current;
    if (current === prev.chapter) return;
    const back = current < prev.chapter;
    setShown((list) => [
      ...list.filter((x) => !x.leaving).map((x) => ({ ...x, leaving: back ? 'down' as const : 'up' as const, beat: prev.beat })),
      { idx: current, key: keySeq.current++, back },
    ]);
  }, [current]);
  useEffect(() => { prevAt.current = at; });

  // Drop finished exit animations.
  useEffect(() => {
    if (!shown.some((x) => x.leaving)) return;
    const t = setTimeout(() => setShown((list) => list.filter((x) => !x.leaving)), 600);
    return () => clearTimeout(t);
  }, [shown]);

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
      <StageFrame index={current} total={total} template={dive.template ? templateFor(dive.template, 'v1') : null} bubble={bubble}
        overlay={<BubbleLayer settings={bubble} scope=".dd-scene:not(.out-up):not(.out-down)" trigger={flat} />}>
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
              beat={x.leaving ? x.beat : x.idx === current ? at.beat : 0}
            />
          );
        })}
      </StageFrame>
    </div>
  );
}
