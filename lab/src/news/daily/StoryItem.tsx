/**
 * One story in the Stories pane: status, score, age, headline, summary, the
 * outlet/blog signals, the Add/In-rundown toggle, and an expandable source list.
 *
 * `actions` is the extension slot for per-story actions from other modes —
 * the Stories pane puts the "Deep dive" link there.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Plus, Check, ExternalLink, Newspaper, Rss } from 'lucide-react';
import type { Story } from './useDailyShow';

export const STATUS_CONFIG: Record<string, { label: string; badge: string }> = {
  Verified:        { label: '✓ Verified',      badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  Likely:          { label: '~ Likely',         badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  Unconfirmed:     { label: '◈ Unverified',     badge: 'bg-amber-500/10 text-amber-300/90 border-amber-500/25' },
  'Single Source': { label: '· Single source',  badge: 'bg-muted text-muted-foreground border-border' },
};

/** Topic chips — what KIND of story it is, independent of how confirmed it is. */
export const TOPICS = [
  'Model release', 'AI tools & features', 'Breakthroughs & research',
  'Robotics', 'Drama & rumors', 'Business & policy',
] as const;
export const TOPIC_BADGE: Record<string, string> = {
  'Model release':            'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'AI tools & features':      'bg-primary/10 text-primary border-primary/30',
  'Breakthroughs & research': 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  'Robotics':                 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  'Drama & rumors':           'bg-rose-500/15 text-rose-300 border-rose-500/30',
  'Business & policy':        'bg-muted text-muted-foreground border-border',
};

function hoursAgo(iso: string): string {
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
  if (h < 1) return 'just now';
  return `${h}h ago`;
}

// Major outlets to highlight in the article sources list
const MAJOR_OUTLETS = new Set([
  'TechCrunch', 'The Verge', 'Ars Technica', 'Wired', 'Reuters', 'VentureBeat',
  'Bloomberg', 'BBC', 'BBC Technology', 'CNET', 'CNBC', 'The Information',
  'The Guardian', 'Financial Times', 'WSJ', 'NYT', 'The New York Times',
  'Associated Press', 'AP', 'The Washington Post', 'Washington Post',
  'Axios', 'Engadget', 'ZDNET', 'Business Insider', 'Fortune',
  'MIT Technology Review', 'IEEE Spectrum', 'Semafor',
]);

interface Props {
  story: Story;
  onToggle: (storyId: string, addedToDeck: boolean) => void;
  toggling: boolean;
  actions?: ReactNode;
}

function SourceLink({ href, icon, name, title, strong }: { href: string; icon: ReactNode; name: string; title: string; strong?: boolean }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="group -mx-1.5 flex items-start gap-2 rounded-md p-1.5 text-xs transition-colors hover:bg-muted/60">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <span className={`font-medium ${strong ? 'text-foreground' : 'text-muted-foreground'}`}>{name}</span>
        <p className="mt-0.5 line-clamp-2 text-muted-foreground">{title}</p>
      </div>
      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />
    </a>
  );
}

function SourceGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

export default function StoryItem({ story, onToggle, toggling, actions }: Props) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_CONFIG[story.status] ?? STATUS_CONFIG['Unconfirmed'];
  const weak = story.status === 'Single Source' || story.status === 'Unconfirmed';

  const majorArticles = story.articleSources.filter(a => MAJOR_OUTLETS.has(a.outlet));
  const otherArticles = story.articleSources.filter(a => !MAJOR_OUTLETS.has(a.outlet));
  const majorOutletCount = story.majorOutletCount || majorArticles.length;
  const outletNames = majorArticles.map(a => a.outlet).slice(0, 4).join(', ');
  const sourceTotal = story.blogSources.length + story.articleSources.length;

  return (
    <div className={`rounded-lg border bg-card transition-colors ${
      story.addedToDeck ? 'border-primary/50 ring-1 ring-primary/20' : 'border-border hover:border-muted-foreground/30'
    }`}>
      <div className="flex items-start gap-3 p-3.5">
        <div className={`min-w-0 flex-1 ${weak && !story.addedToDeck ? 'opacity-85' : ''}`}>
          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {story.category && (
              <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${TOPIC_BADGE[story.category] ?? TOPIC_BADGE['Business & policy']}`}>{story.category}</span>
            )}
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${cfg.badge}`}>{cfg.label}</span>
            <span className="text-[11px] text-muted-foreground">Score {story.compositeScore.toFixed(1)}</span>
            <span className="text-[11px] text-muted-foreground">·</span>
            <span className="text-[11px] text-muted-foreground">{hoursAgo(story.firstSeenAt)}</span>
          </div>
          <h3 className="text-sm font-semibold leading-snug text-foreground">{story.headline}</h3>
          {story.summary && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{story.summary}</p>}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {majorOutletCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Newspaper className="h-3 w-3 shrink-0" />
                <span>
                  <span className="font-medium text-foreground">{majorOutletCount}</span>
                  {' '}major outlet{majorOutletCount !== 1 ? 's' : ''}
                  {outletNames ? `: ${outletNames}${majorArticles.length > 4 ? '…' : ''}` : ''}
                </span>
              </span>
            )}
            {story.hasOfficialBlog && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Rss className="h-3 w-3 shrink-0" />
                <span>Official blog: <span className="font-medium text-foreground">{story.blogSources.map(b => b.company).join(', ')}</span></span>
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center">
          {actions}
          <button
            onClick={() => onToggle(story.id, !story.addedToDeck)}
            disabled={toggling}
            title={story.addedToDeck ? 'Remove from Selections' : 'Add to Selections'}
            className={`flex min-h-8 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              story.addedToDeck
                ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/85'
                : 'border-border text-foreground hover:border-primary/60 hover:text-primary'
            }`}
          >
            {story.addedToDeck ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {story.addedToDeck ? 'Added' : 'Add'}
          </button>
          <button
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            title={expanded ? 'Hide sources' : 'Show sources'}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {sourceTotal > 0 && <span>{sourceTotal}</span>}
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border px-3.5 py-3">
          {story.blogSources.length > 0 && (
            <SourceGroup label="Official Blog Posts">
              {story.blogSources.map((b, i) => (
                <SourceLink key={i} href={b.url} icon={<Rss className="h-3 w-3" />} name={b.company} title={b.title} strong />
              ))}
            </SourceGroup>
          )}
          {majorArticles.length > 0 && (
            <SourceGroup label={`Major Publications (${majorArticles.length})`}>
              {majorArticles.map((a, i) => (
                <SourceLink key={i} href={a.url} icon={<Newspaper className="h-3 w-3" />} name={a.outlet} title={a.title} strong />
              ))}
            </SourceGroup>
          )}
          {otherArticles.length > 0 && (
            <SourceGroup label={`Other Coverage (${otherArticles.length})`}>
              {otherArticles.map((a, i) => (
                <SourceLink key={i} href={a.url} icon={<Newspaper className="h-3 w-3" />} name={a.outlet} title={a.title} />
              ))}
            </SourceGroup>
          )}
          {sourceTotal === 0 && <p className="text-xs text-muted-foreground">No source links on this story.</p>}
        </div>
      )}
    </div>
  );
}
