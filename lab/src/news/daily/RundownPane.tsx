/**
 * Right pane — the rundown (the built deck): build log, the ordered slide
 * list (drag or arrows to reorder, star, preview, edit notes, remove), and the
 * Go-live card with the deck's template (DeckLook) and the show screens.
 */
import { useEffect, useState } from 'react';
import { Layers, Play, ScrollText, MonitorPlay, Tv, ExternalLink, SlidersHorizontal, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { buildSlideStages, getTeleprompterSettings } from '../api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import RunLog from './RunLog';
import RundownItem from './RundownItem';
import DeckLook from './DeckLook';
import type { DailyShow, Slide } from './useDailyShow';

interface Props {
  show: DailyShow;
  onBuild: () => void;
  onPreview: (s: Slide) => void;
}

const SCREENS = [
  { href: '/news-gatherer/present/teleprompter', icon: ScrollText, label: 'Teleprompter', hint: 'Standalone script scroller' },
  { href: '/news-gatherer/present/audience', icon: Tv, label: 'Audience', hint: 'Follows the live session' },
  { href: '/news-gatherer/present/display', icon: MonitorPlay, label: 'Display', hint: 'Driven by the presenter tab' },
];

export default function RundownPane({ show, onBuild, onPreview }: Props) {
  const { slides, slidesLoading, building, buildLog, selectedCount, estMins } = show;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  // Re-read on focus: the settings change in the presenter tab, not here.
  const [tp, setTp] = useState<{ fontSize: number; width: string; speed: number } | null>(null);
  useEffect(() => {
    const load = () => { getTeleprompterSettings({}).then(setTp).catch(() => {}); };
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  const handleDrop = (target: number) => {
    const from = dragIdx;
    setDragIdx(null);
    setDragOverIdx(null);
    if (from === null || from === target) return;
    void show.moveSlideTo(from, target);
  };

  const showLog = building || buildLog.logs.length > 0;

  // The on-screen visuals (cover + beats, daily/stage). A deck built before
  // they existed has none and presents its key points instead; this makes them
  // without a Rebuild, so the scripts Jake already read through stay as they are.
  const [stagesBusy, setStagesBusy] = useState(false);
  const missingStages = slides.filter((s) => !s.stageJson).length;
  const makeStages = async (force: boolean) => {
    setStagesBusy(true);
    try {
      // The deck on screen — never "today's", which is another (empty) deck after Bangkok midnight.
      const deckId = show.deck?.id ?? slides[0]?.deck;
      if (!deckId) { toast.error('No deck loaded'); return; }
      const r = await buildSlideStages({ deckId, force });
      const src = r.sources ? ` · source pages: ${r.sources.captured + r.sources.skipped} of ${slides.length}` : '';
      if (r.failed) toast.warning(`Visuals made for ${r.built} ${r.built === 1 ? 'story' : 'stories'}; ${r.failed} failed (those show their key points)${src}.`);
      else toast.success(`Visuals made for ${r.built} ${r.built === 1 ? 'story' : 'stories'}${src}`);
      await show.loadSlides();
    } catch (e: any) { toast.error(e?.message || 'Could not make the visuals'); }
    finally { setStagesBusy(false); }
  };

  return (
    <section className="flex min-h-0 flex-col" aria-label="Selections">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Layers className="h-4 w-4 text-primary" /> Selections
        </h2>
        {slides.length > 0 && (
          <span className="text-xs text-muted-foreground">{slides.length} slides · est. {estMins} min</span>
        )}
      </div>

      {showLog && (
        <div className="mb-2">
          <RunLog title="Build log" logs={buildLog.logs} running={building} open={buildLog.open}
            onToggle={buildLog.toggle} onClear={buildLog.clear} emptyHint='No logs yet. Press "Build presentation" to start.' />
        </div>
      )}

      <div className="space-y-1.5">
        {slidesLoading || (building && slides.length === 0) ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)
        ) : slides.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
            <Layers className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="mb-1 text-sm font-medium text-foreground">No deck built yet</p>
            <p className="mx-auto mb-5 max-w-xs text-xs text-muted-foreground">
              {selectedCount > 0
                ? `${selectedCount} ${selectedCount === 1 ? 'story is' : 'stories are'} selected. Build writes presenter notes and a teleprompter script for each.`
                : 'Add stories from the list, then build. Each becomes a slide with notes and a teleprompter script.'}
            </p>
            <Button onClick={onBuild} disabled={building || selectedCount === 0} className="gap-1.5">
              <Layers className="h-4 w-4" /> Build presentation
            </Button>
          </div>
        ) : (
          slides.map((slide, idx) => (
            <RundownItem
              key={slide.id}
              slide={slide}
              index={idx}
              count={slides.length}
              editing={editingId === slide.id}
              isDragOver={dragOverIdx === idx && dragIdx !== idx}
              onStar={show.starSlide}
              onDelete={show.deleteSlide}
              onPreview={onPreview}
              onEditToggle={setEditingId}
              onNotesUpdated={show.loadSlides}
              onMove={(a, b) => void show.moveSlideTo(a, b)}
              onDragStart={setDragIdx}
              onDragOver={setDragOverIdx}
              onDrop={handleDrop}
              onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
            />
          ))
        )}
      </div>

      {slides.length > 0 && (
        <div className="mt-4 rounded-lg border border-border bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-foreground">Go live</p>
              <p className="text-xs text-muted-foreground">Presenter view with notes + teleprompter, in a new tab.</p>
            </div>
            <Button onClick={show.startShow} disabled={building} className="gap-1.5">
              <Play className="h-4 w-4" /> Start show
            </Button>
          </div>
          {/* The deck's design: the AI News templates + the camera-bubble setting. */}
          <DeckLook show={show} />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" data-stages={missingStages}>
            <span className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              {missingStages > 0
                ? `${missingStages} of ${slides.length} ${slides.length === 1 ? 'story has' : 'stories have'} no visuals yet (they show key points).`
                : 'Every story has its visuals (source page → info slides; Shift = video).'}
            </span>
            <Button variant={missingStages > 0 ? 'secondary' : 'ghost'} size="sm" className="h-7 gap-1 text-xs"
              disabled={stagesBusy || building} onClick={() => void makeStages(missingStages === 0)}
              title="Makes each story's info slides from its script and captures its source page. Scripts, notes and videos are not touched.">
              {stagesBusy ? 'Making visuals…' : missingStages > 0 ? 'Make visuals' : 'Redo visuals'}
            </Button>
          </div>
          {tp && (
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground" title="Kept from your last show until you change them on the teleprompter">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Teleprompter opens with:
              <span className="font-medium text-foreground">{tp.fontSize}px text</span>·
              <span className="font-medium text-foreground">{tp.width[0].toUpperCase() + tp.width.slice(1)} width</span>·
              <span className="font-medium text-foreground">{tp.speed.toFixed(1)}× speed</span>
            </p>
          )}
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Other screens</p>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
              {SCREENS.map(s => (
                <a key={s.href} href={s.href === '/news-gatherer/present/audience' && show.deck?.id ? `${s.href}?deck=${encodeURIComponent(show.deck.id)}` : s.href} target="_blank" rel="noopener noreferrer"
                  className="group flex items-center gap-2 rounded-md border border-border px-2.5 py-2 transition-colors hover:border-primary/50 hover:bg-muted/50">
                  <s.icon className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-xs font-medium text-foreground">{s.label}<ExternalLink className="h-3 w-3 text-muted-foreground/60" /></span>
                    <span className="block truncate text-[11px] text-muted-foreground">{s.hint}</span>
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
