/**
 * The daily path as four numbered steps — Collect → Pick → Build → Go live —
 * each showing where it stands and carrying that step's primary action. The
 * step that should happen next is highlighted, so the page always answers
 * "what do I do now?".
 */
import type { ReactNode } from 'react';
import { Check, RefreshCw, Layers, Play, Trash2, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { DailyShow } from './useDailyShow';

type StepState = 'done' | 'next' | 'todo' | 'running';

function Step({ n, title, state, status, children }: { n: number; title: string; state: StepState; status: ReactNode; children?: ReactNode }) {
  const ring =
    state === 'next' ? 'border-primary/60 bg-primary/[0.06]' :
    state === 'running' ? 'border-primary/40' : 'border-border';
  const badge =
    state === 'done' ? 'bg-emerald-500/15 text-emerald-300' :
    state === 'next' || state === 'running' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground';
  return (
    <li className={`flex min-w-0 items-center gap-2 rounded-lg border p-2.5 lg:flex-col lg:items-stretch lg:gap-1.5 ${ring}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${badge}`}>
            {state === 'done' ? <Check className="h-3 w-3" /> : n}
          </span>
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
        </div>
        <div className="mt-1 truncate text-xs leading-snug text-muted-foreground" title={typeof status === 'string' ? status : undefined}>{status}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 lg:mt-auto lg:flex-wrap">{children}</div>
    </li>
  );
}

interface Props {
  show: DailyShow;
  onBuild: () => void;
  onShowSelected: () => void;
}

export default function WorkflowBar({ show, onBuild, onShowSelected }: Props) {
  const { meta, refreshing, clearingCache, building, slides, selectedCount, estMins } = show;
  const hasStories = (meta?.total ?? 0) > 0;
  const hasSlides = slides.length > 0;
  const collecting = refreshing || clearingCache;

  const collectState: StepState = collecting ? 'running' : hasStories ? 'done' : 'next';
  // Exactly one step is "next": with a deck already built, that is Go live.
  const pickState: StepState = selectedCount > 0 ? 'done' : hasStories && !hasSlides ? 'next' : 'todo';
  const buildState: StepState = building ? 'running' : hasSlides ? 'done' : selectedCount > 0 ? 'next' : 'todo';
  const liveState: StepState = hasSlides && !building ? 'next' : 'todo';

  return (
    <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label="Daily show steps">
      <Step n={1} title="Collect data" state={collectState} status={
        collecting ? 'Collecting…' :
        meta && hasStories ? <>{meta.total} stories · {meta.verified} verified · {meta.likely} likely</> :
        'No stories for today yet'
      }>
        <Button size="sm" variant={collectState === 'next' ? 'default' : 'outline'} onClick={show.collect} disabled={collecting} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Collecting…' : hasStories ? 'Refresh' : 'Collect data'}
        </Button>
        <Button size="sm" variant="ghost" onClick={show.clearAndCollect} disabled={collecting}
          className="gap-1 px-2 text-muted-foreground" title="Clear &amp; Re-collect: delete cached URLs and re-collect from scratch" aria-label="Clear and re-collect">
          <Trash2 className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">Clear &amp; Re-collect</span>
        </Button>
      </Step>

      <Step n={2} title="Pick news" state={pickState} status={
        selectedCount > 0
          ? <><span className="font-semibold text-foreground">{selectedCount} {selectedCount === 1 ? 'story' : 'stories'}</span> in Selections</>
          : hasStories ? 'Press "Add" on the news you want to cover' : 'Collect first'
      }>
        {selectedCount > 0 && (
          <Button size="sm" variant="ghost" onClick={onShowSelected} className="gap-1.5 px-2 text-muted-foreground">
            <ListChecks className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Show selected</span>
          </Button>
        )}
      </Step>

      <Step n={3} title="Build the presentation" state={buildState} status={
        building ? 'Writing notes + teleprompter scripts…' :
        hasSlides ? <>{slides.length} slides · est. {estMins} min show</> :
        selectedCount > 0 ? 'Ready to build' : 'Pick news first'
      }>
        <Button size="sm" variant={buildState === 'next' ? 'default' : 'outline'} onClick={onBuild}
          disabled={building || selectedCount === 0} className="gap-1.5"
          title={hasSlides ? 'Replaces the current slides with a fresh build from the selected stories' : undefined}>
          <Layers className={`h-3.5 w-3.5 ${building ? 'animate-pulse' : ''}`} />
          {building ? 'Building…' : hasSlides ? 'Rebuild deck' : 'Build presentation'}
        </Button>
      </Step>

      <Step n={4} title="Go live" state={liveState} status={hasSlides ? 'Opens the presenter view in a new tab' : 'Build the deck first'}>
        <Button size="sm" variant={liveState === 'next' ? 'default' : 'outline'} onClick={show.startShow} disabled={!hasSlides} className="gap-1.5">
          <Play className="h-3.5 w-3.5" /> Start show
        </Button>
      </Step>
    </ol>
  );
}
