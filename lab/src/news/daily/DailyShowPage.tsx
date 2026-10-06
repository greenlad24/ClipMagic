/**
 * Daily Show — the /news-gatherer/dashboard workspace.
 *
 *   ┌ NewsShell top bar: The Lab / AI News Stream · [mode tabs] · Settings ┐
 *   │ Show header (date) + WorkflowBar: 1 Collect → 2 Pick → 3 Build → 4 Go live
 *   │ ┌ StoriesPane (wire) ────────────┐ ┌ RundownPane (deck) ──────────┐
 *   │ │ collection log, filters, list  │ │ build log, slides, go-live   │
 *   └─┴────────────────────────────────┴─┴──────────────────────────────┴─┘
 *
 * Wide screens show both panes side by side, each scrolling on its own.
 * Below lg (iPad portrait, narrow laptops) the panes become two tabs, kept in
 * ?pane=stories|rundown, with a sticky bottom action bar.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Layers, Newspaper, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import NewsShell from '../shell/NewsShell';
import { useAuth } from '../auth';
import WorkflowBar from './WorkflowBar';
import StoriesPane from './StoriesPane';
import RundownPane from './RundownPane';
import SlidePreviewDialog from './SlidePreviewDialog';
import { useDailyShow, type StoryFilter } from './useDailyShow';

type Pane = 'stories' | 'rundown';

export default function DailyShowPage() {
  return (
    <NewsShell title="Daily Show">
      <DailyShowWorkspace />
    </NewsShell>
  );
}

function DailyShowWorkspace() {
  const { user } = useAuth();
  const show = useDailyShow(!!user);
  const [params, setParams] = useSearchParams();
  const pane: Pane = params.get('pane') === 'rundown' ? 'rundown' : 'stories';
  const setPane = (p: Pane) => {
    const next = new URLSearchParams(params);
    if (p === 'stories') next.delete('pane'); else next.set('pane', p);
    setParams(next, { replace: true });
  };
  const [filter, setFilter] = useState<StoryFilter>('All');
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Look the slide up live so the dialog shows notes saved a moment ago.
  const previewSlide = show.slides.find(s => s.id === previewId) ?? null;

  const handleBuild = async () => {
    if (show.selectedCount > 0) setPane('rundown');
    const ok = await show.buildDeck();
    if (ok) document.getElementById('rundown-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const showSelected = () => { setFilter('Selected'); setPane('stories'); };

  const { selectedCount, slides, building } = show;
  const paneTab = (p: Pane, label: string, badge: number, Icon: typeof Newspaper) => (
    <button
      role="tab"
      aria-selected={pane === p}
      onClick={() => setPane(p)}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        pane === p ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="h-4 w-4" /> {label}
      <span className="rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{badge}</span>
    </button>
  );

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3rem)]">
      {/* Show header + the four steps */}
      <div className="shrink-0 border-b border-border px-3 pb-3 pt-4 sm:px-5">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-lg font-semibold text-foreground">Daily Show — {show.deckDateLabel}</h1>
          <span className="hidden text-xs text-muted-foreground sm:inline">Collect → pick → build → go live</span>
        </div>
        <WorkflowBar show={show} onBuild={handleBuild} onShowSelected={showSelected} />
      </div>

      {/* Narrow: pane tabs */}
      <div className="sticky top-12 z-30 border-b border-border bg-background/95 px-3 py-2 backdrop-blur sm:px-5 lg:hidden">
        <div role="tablist" className="flex gap-1 rounded-lg bg-muted/60 p-1">
          {paneTab('stories', 'News', show.meta?.total ?? 0, Newspaper)}
          {paneTab('rundown', 'Selections', slides.length, Layers)}
        </div>
      </div>

      {/* Panes */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(380px,1fr)]">
        <div className={`${pane === 'stories' ? 'block' : 'hidden'} min-h-0 px-3 pb-24 pt-3 sm:px-5 lg:block lg:overflow-y-auto lg:pb-6`}>
          <StoriesPane show={show} filter={filter} onFilter={setFilter} />
        </div>
        <div id="rundown-scroll"
          className={`${pane === 'rundown' ? 'block' : 'hidden'} min-h-0 border-border px-3 pb-24 pt-3 sm:px-5 lg:block lg:overflow-y-auto lg:border-l lg:bg-card/30 lg:pb-6`}>
          <RundownPane show={show} onBuild={handleBuild} onPreview={s => setPreviewId(s.id)} />
        </div>
      </div>

      {/* Narrow: sticky action bar (the wide layout has these in the step bar) */}
      {!show.storiesLoading && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur lg:hidden"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}>
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-5">
            <p className="min-w-0 truncate text-sm text-muted-foreground">
              {selectedCount > 0
                ? <><span className="font-semibold text-foreground">{selectedCount} {selectedCount === 1 ? 'story' : 'stories'}</span> selected</>
                : 'Pick stories to add them to your deck'}
              {slides.length > 0 && <span className="hidden text-muted-foreground/70 sm:inline"> · {slides.length} slides · est. {show.estMins} min</span>}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              {slides.length > 0 && (
                <Button variant="outline" size="sm" onClick={show.startShow} className="gap-1.5">
                  <Play className="h-3.5 w-3.5" /> Start show
                </Button>
              )}
              <Button size="sm" onClick={handleBuild} disabled={building || selectedCount === 0} className="gap-1.5">
                <Layers className={`h-3.5 w-3.5 ${building ? 'animate-pulse' : ''}`} />
                {building ? 'Building…' : slides.length > 0 ? 'Rebuild' : 'Build'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <SlidePreviewDialog slide={previewSlide} number={previewSlide ? show.slides.indexOf(previewSlide) + 1 : 1} onClose={() => setPreviewId(null)} onNotesUpdated={show.loadSlides} />
    </div>
  );
}
