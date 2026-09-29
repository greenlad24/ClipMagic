/**
 * Left pane — today's collected stories: the collection log, the status
 * filters, and the story list with its empty/loading states.
 */
import { useState } from 'react';
import { Clock, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import RunLog from './RunLog';
import StoryItem, { TOPICS, TOPIC_BADGE } from './StoryItem';
import { matchesFilter, type DailyShow, type StoryFilter } from './useDailyShow';

const FILTERS: { id: StoryFilter; label: string }[] = [
  { id: 'All', label: 'All' },
  { id: 'Verified', label: 'Verified' },
  { id: 'Likely', label: 'Likely' },
  { id: 'Unconfirmed', label: 'Unverified' },
  { id: 'Selected', label: 'Selected' },
];

interface Props {
  show: DailyShow;
  filter: StoryFilter;
  onFilter: (f: StoryFilter) => void;
}

export default function StoriesPane({ show, filter, onFilter }: Props) {
  const { meta, stories, storiesLoading, collectLog, refreshing, togglingId } = show;
  // Topic narrows whatever the confirmation filter shows; 'All' = every topic.
  const [topic, setTopic] = useState<string>('All');
  const topicCounts = TOPICS.map(t => [t, stories.filter(s => s.category === t).length] as const).filter(([, n]) => n > 0);
  const filtered = stories.filter(s => matchesFilter(s, filter) && (topic === 'All' || s.category === topic));
  const count = (f: StoryFilter) =>
    !meta ? 0 :
    f === 'All' ? meta.total : f === 'Verified' ? meta.verified : f === 'Likely' ? meta.likely :
    f === 'Unconfirmed' ? meta.unconfirmed : meta.addedToDeck;
  const showLog = refreshing || collectLog.logs.length > 0;

  return (
    <section className="flex min-h-0 flex-col" aria-label="News">
      <div className="space-y-2 pb-3">
        {showLog && (
          <RunLog title="Collection log" logs={collectLog.logs} running={refreshing} open={collectLog.open}
            onToggle={collectLog.toggle} onClear={collectLog.clear} emptyHint='No logs yet. Press "Refresh" to start collection.' />
        )}
        {meta && meta.total > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTERS.map(f => (
              <button key={f.id} onClick={() => onFilter(f.id)} aria-pressed={filter === f.id}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  filter === f.id ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}>
                {f.label} ({count(f.id)})
              </button>
            ))}
            <span className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground xl:flex">
              <ShieldCheck className="h-3.5 w-3.5" /> Verified = 3+ major outlets
            </span>
          </div>
        )}
        {meta && meta.total > 0 && topicCounts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Topics">
            <button onClick={() => setTopic('All')} aria-pressed={topic === 'All'}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                topic === 'All' ? 'border-foreground/40 bg-foreground/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground'
              }`}>
              All topics
            </button>
            {topicCounts.map(([t, n]) => (
              <button key={t} onClick={() => setTopic(topic === t ? 'All' : t)} aria-pressed={topic === t}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-opacity ${TOPIC_BADGE[t]} ${
                  topic === t ? 'ring-1 ring-current' : topic === 'All' ? 'opacity-80 hover:opacity-100' : 'opacity-50 hover:opacity-100'
                }`}>
                {t} ({n})
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        {storiesLoading ? (
          Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)
        ) : filtered.length === 0 && (meta?.total ?? 0) === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-16 text-center">
            <Clock className="mx-auto mb-4 h-10 w-10 text-muted-foreground/40" />
            <p className="mb-1 text-base font-medium text-foreground">No stories for today yet</p>
            <p className="mx-auto mb-6 max-w-sm text-sm text-muted-foreground">Collect today's AI news from company blogs and major publications.</p>
            <Button onClick={show.collect} disabled={refreshing} className="gap-1.5">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              Collect data
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {filter === 'Selected' ? 'No stories selected yet.' : `No ${filter === 'Unconfirmed' ? 'unverified' : filter.toLowerCase()} stories yet.`}
          </div>
        ) : (
          filtered.map(story => (
            <StoryItem key={story.id} story={story} onToggle={show.toggleStory} toggling={togglingId === story.id} />
          ))
        )}
      </div>
    </section>
  );
}
