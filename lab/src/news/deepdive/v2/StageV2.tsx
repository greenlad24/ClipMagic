/**
 * Deep Dive v2 — the audience screen. Same live session and keys as v1
 * (DeepDiveStagePage), but the sync index is a BEAT (types.ts `flatten`):
 *   ← / → , PageUp / PageDown      previous / next beat
 *   mouse wheel / vertical swipe   previous / next CHAPTER (scrolls like a site)
 *   ↑ / ↓                          nudge the presenter's script
 *   Space                          play / pause the script
 *   Home / End, F full screen
 *   B / C / G                      camera bubble: corner / camera / guide (../bubble.tsx)
 */
import { useMemo, useRef, useState } from 'react';
import { heroMedia, type DeepDive, type Section } from '../api';
import VideoEmbed from '../../components/VideoEmbed';
import { sectionsToChapters } from './adapt';
import Show from './Show';
import LiveDemo from './LiveDemo';
import { useBeatStage } from './useBeatStage';
import { templateFor } from '../templates';
import { bubbleKey, useBubbleSettings } from '../bubble';

export default function StageV2({ dive, sections }: { dive: DeepDive; sections: Section[] }) {
  const chapters = useMemo(() => sectionsToChapters(sections), [sections]);
  const [live, setLive] = useState(false);
  const [bubble, setBubble] = useBubbleSettings();
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  // The stepping is shared with classic slides (useBeatStage.ts); only L / Esc
  // (the live demo) and the bubble keys B / C / G are this page's own.
  const hero = useMemo(() => heroMedia(dive.heroVideo), [dive.heroVideo]);
  // ?template=<id>: look at this dive in another template's design + motion without changing it (preview only)
  const previewTemplate = new URLSearchParams(window.location.search).get('template') || '';
  const { flat, instant, cursorHidden, show, videoOn } = useBeatStage({
    diveId: dive.id,
    units: chapters,
    onKey: (e) => {
      switch (e.key) {
        case 'l': case 'L': if (dive.demoAgent) setLive((v) => !v); return true;
        case 'Escape': setLive(false); return true;
      }
      return bubbleKey(e, bubbleRef.current, setBubble);
    },
  });

  if (!chapters.length) {
    return <div className="fixed inset-0 grid place-items-center bg-black text-lg text-white/60">This deep dive has no chapters yet. Generate it first.</div>;
  }
  return (
    <div className="fixed inset-0 select-none" style={{ cursor: cursorHidden ? 'none' : 'default' }}>
      <Show chapters={chapters} diveId={dive.id} flat={flat} onFlat={(n) => show(n, true)} instant={instant}
        template={templateFor(previewTemplate || dive.template, 'v2')} bubble={bubble}
        onRunLive={dive.demoAgent ? () => setLive(true) : undefined}
        overlay={live ? <LiveDemo diveId={dive.id} onClose={() => setLive(false)} /> : null} />
      {/* Shift: the dive's most relevant video, full screen over any beat; only a slide change (or Shift / Esc) closes it */}
      {hero && <VideoEmbed key={hero.key} media={hero} active={videoOn} />}
      {videoOn && !hero && (
        <div style={{ position: 'fixed', left: '50%', bottom: 32, transform: 'translateX(-50%)', zIndex: 60, padding: '10px 16px',
          borderRadius: 10, background: 'rgba(0,0,0,.75)', color: '#fff', font: '600 15px/1.3 system-ui' }}>
          No video for this deep dive — Shift or Esc to close
        </div>
      )}
    </div>
  );
}
