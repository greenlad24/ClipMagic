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
import type { DeepDive, Section } from '../api';
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
  const { flat, instant, cursorHidden, show } = useBeatStage({
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
        template={templateFor(dive.template, 'v2')} bubble={bubble}
        onRunLive={dive.demoAgent ? () => setLive(true) : undefined}
        overlay={live ? <LiveDemo diveId={dive.id} onClose={() => setLive(false)} /> : null} />
    </div>
  );
}
