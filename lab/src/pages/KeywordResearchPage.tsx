import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  keywordResearchStatus,
  startKeywordResearch,
  keywordResearchJobStatus,
  listResearchRuns,
  getResearchRun,
  refreshVolume,
  deleteResearchRun,
  renameResearchRun,
  pinResearchRun,
  type ResearchMode,
  type StartKeywordResearchInput,
  type ResearchJobSnapshot,
  type ResearchRunResult,
  type ResearchRunListItem,
  type KeywordMetrics,
  type InsightsReport,
  type KeywordResearchStatusOutput,
} from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  Search,
  TrendingUp,
  KeyRound,
  Settings,
  AlertTriangle,
  Loader2,
  Download,
  Trash2,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
  Target,
  Users,
  Layers,
  Sparkles,
  Play,
  RefreshCw,
  Lightbulb,
  Ban,
  ListChecks,
  Pin,
  PinOff,
  Pencil,
  Plus,
  History,
  X,
  Check,
} from 'lucide-react';

/**
 * YouTube Keyword Research (LAB tool).
 *
 * Seed / topic / competitor / free-text a niche → the server scores each keyword
 * for demand vs competition, flags market gaps, clusters them and reports who
 * dominates. The headline visualization is an inline-SVG "Opportunity Map": a
 * demand × competition scatter whose top-left quadrant is the gap zone.
 *
 * Long runs are polled (MemePage idiom). Results and the saved-run history come
 * straight from the server; nothing here is charted with a library — the map is
 * hand-rolled SVG so it inherits the app's dark theme via CSS variables.
 */

// ── Small helpers ────────────────────────────────────────────────────────────
function parseList(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function parseLines(raw: string): string[] {
  return raw
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 1000)
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return String(Math.round(n));
}
function fmtScore(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return String(Math.round(n));
}
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}
const MODE_LABEL: Record<ResearchMode, string> = {
  seeds: 'Seeds',
  topic: 'Topic',
  competitors: 'Competitors',
  ai: 'AI',
};

/** History sidebar mode filter (All + each research mode). */
type ModeFilter = 'all' | ResearchMode;
const MODE_FILTERS: { key: ModeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'seeds', label: 'Seeds' },
  { key: 'topic', label: 'Topic' },
  { key: 'competitors', label: 'Competitors' },
  { key: 'ai', label: 'AI' },
];

/** Cluster name used when a keyword has no cluster. */
const NO_CLUSTER = 'Unclustered';
function clusterOf(k: KeywordMetrics): string {
  return k.cluster || NO_CLUSTER;
}

/**
 * Static full-string chart-hue classes. These MUST be written out in full (not
 * built from a template) so Tailwind's content scanner generates them.
 */
const HUE_TINT: Record<number, string> = {
  1: 'bg-[hsl(var(--chart-1))]/10 text-[hsl(var(--chart-1))]',
  2: 'bg-[hsl(var(--chart-2))]/10 text-[hsl(var(--chart-2))]',
  3: 'bg-[hsl(var(--chart-3))]/10 text-[hsl(var(--chart-3))]',
  4: 'bg-[hsl(var(--chart-4))]/10 text-[hsl(var(--chart-4))]',
  5: 'bg-[hsl(var(--chart-5))]/10 text-[hsl(var(--chart-5))]',
};

/** Text color for an opportunity score — green (high) fading to muted (low). */
function oppColorClass(v: number): string {
  if (v >= 70) return 'text-[hsl(var(--chart-3))]';
  if (v >= 50) return 'text-[hsl(var(--chart-1))]';
  if (v >= 30) return 'text-foreground';
  return 'text-muted-foreground';
}

// ── Sort state ───────────────────────────────────────────────────────────────
type SortKey = 'keyword' | 'searchVolume' | 'demandScore' | 'competitionScore' | 'opportunityScore';
interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

// ── The Opportunity Map (inline SVG scatter) ─────────────────────────────────
const VBW = 560;
const VBH = 380;
const PAD = { l: 46, r: 18, t: 18, b: 42 };
const PLOT_W = VBW - PAD.l - PAD.r;
const PLOT_H = VBH - PAD.t - PAD.b;
// The opportunity zone thresholds (mirror server SCORING gap floor/ceiling).
const GAP_DEMAND_FLOOR = 55;
const GAP_COMPETITION_CEILING = 45;

function mapX(competition: number): number {
  return PAD.l + (Math.max(0, Math.min(100, competition)) / 100) * PLOT_W;
}
function mapY(demand: number): number {
  return PAD.t + (1 - Math.max(0, Math.min(100, demand)) / 100) * PLOT_H;
}
function mapR(demand: number): number {
  return 3 + (Math.max(0, Math.min(100, demand)) / 100) * 7;
}

interface HoverPoint {
  keyword: string;
  cx: number;
  cy: number;
  demand: number;
  competition: number;
  opportunity: number;
  cluster: string;
}

function OpportunityMap({
  keywords,
  clusterColor,
}: {
  keywords: KeywordMetrics[];
  clusterColor: (name: string) => string;
}) {
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const ticks = [0, 25, 50, 75, 100];

  return (
    <div className="relative overflow-x-auto">
      <svg
        viewBox={`0 0 ${VBW} ${VBH}`}
        className="w-full h-auto"
        style={{ minWidth: 420, maxWidth: '100%' }}
        role="img"
        aria-label="Opportunity map — keyword demand versus competition"
      >
        {/* Opportunity Zone: high demand, low competition (top-left). */}
        <rect
          x={mapX(0)}
          y={mapY(100)}
          width={mapX(GAP_COMPETITION_CEILING) - mapX(0)}
          height={mapY(GAP_DEMAND_FLOOR) - mapY(100)}
          fill="hsl(var(--chart-3))"
          opacity={0.08}
        />
        <text
          x={mapX(0) + 6}
          y={mapY(100) + 14}
          className="fill-[hsl(var(--chart-3))]"
          fontSize={10}
          fontWeight={600}
        >
          Opportunity zone
        </text>

        {/* Gridlines + tick labels. */}
        {ticks.map((t) => (
          <g key={`gx-${t}`}>
            <line
              x1={mapX(t)}
              y1={PAD.t}
              x2={mapX(t)}
              y2={PAD.t + PLOT_H}
              className="stroke-border"
              strokeWidth={0.5}
              opacity={0.5}
            />
            <text
              x={mapX(t)}
              y={PAD.t + PLOT_H + 14}
              className="fill-muted-foreground"
              fontSize={9}
              textAnchor="middle"
            >
              {t}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <g key={`gy-${t}`}>
            <line
              x1={PAD.l}
              y1={mapY(t)}
              x2={PAD.l + PLOT_W}
              y2={mapY(t)}
              className="stroke-border"
              strokeWidth={0.5}
              opacity={0.5}
            />
            <text
              x={PAD.l - 6}
              y={mapY(t) + 3}
              className="fill-muted-foreground"
              fontSize={9}
              textAnchor="end"
            >
              {t}
            </text>
          </g>
        ))}

        {/* Axis titles. */}
        <text
          x={PAD.l + PLOT_W / 2}
          y={VBH - 4}
          className="fill-muted-foreground"
          fontSize={10}
          textAnchor="middle"
        >
          Competition →
        </text>
        <text
          x={-(PAD.t + PLOT_H / 2)}
          y={12}
          className="fill-muted-foreground"
          fontSize={10}
          textAnchor="middle"
          transform="rotate(-90)"
        >
          Demand →
        </text>

        {/* Bubbles. */}
        {keywords.map((k) => {
          const cx = mapX(k.competitionScore);
          const cy = mapY(k.demandScore);
          const cluster = clusterOf(k);
          const isHover = hover?.keyword === k.keyword;
          return (
            <circle
              key={k.keyword}
              cx={cx}
              cy={cy}
              r={mapR(k.demandScore)}
              fill={clusterColor(cluster)}
              opacity={isHover ? 0.95 : 0.7}
              stroke={isHover ? 'hsl(var(--foreground))' : 'none'}
              strokeWidth={isHover ? 1.5 : 0}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() =>
                setHover({
                  keyword: k.keyword,
                  cx,
                  cy,
                  demand: k.demandScore,
                  competition: k.competitionScore,
                  opportunity: k.opportunityScore,
                  cluster,
                })
              }
              onMouseLeave={() => setHover((h) => (h?.keyword === k.keyword ? null : h))}
            >
              <title>{`${k.keyword} — demand ${fmtScore(k.demandScore)}, competition ${fmtScore(
                k.competitionScore,
              )}, opportunity ${fmtScore(k.opportunityScore)}`}</title>
            </circle>
          );
        })}
      </svg>

      {/* Hover tooltip (positioned in % of the SVG's box so it tracks on resize). */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-card px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${(hover.cx / VBW) * 100}%`,
            top: `${(hover.cy / VBH) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 10px))',
            maxWidth: 220,
          }}
        >
          <p className="text-xs font-semibold text-foreground truncate">{hover.keyword}</p>
          <p className="text-[10px] text-muted-foreground">{hover.cluster}</p>
          <div className="mt-1 flex gap-2 text-[10px]">
            <span className="text-muted-foreground">
              Demand <span className="text-foreground font-medium">{fmtScore(hover.demand)}</span>
            </span>
            <span className="text-muted-foreground">
              Comp <span className="text-foreground font-medium">{fmtScore(hover.competition)}</span>
            </span>
            <span className="text-muted-foreground">
              Opp{' '}
              <span className={cn('font-medium', oppColorClass(hover.opportunity))}>
                {fmtScore(hover.opportunity)}
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Gap badges ───────────────────────────────────────────────────────────────
function GapBadges({ k }: { k: KeywordMetrics }) {
  const g = k.gapFlags;
  const items: { on: boolean; label: string; hue: number; title: string }[] = [
    { on: g.demandVsCompetition, label: 'Gap', hue: 3, title: 'High demand, low competition' },
    { on: g.smallChannelOutlier, label: 'Outlier', hue: 2, title: 'Small channels ranking big' },
    { on: g.underservedSubtopic, label: 'Underserved', hue: 4, title: 'Many queries, few good videos' },
    { on: g.freshnessGap, label: 'Stale', hue: 5, title: 'Top videos are old' },
  ];
  const active = items.filter((i) => i.on);
  if (active.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {active.map((i) => (
        <span
          key={i.label}
          title={i.title}
          className={cn(
            'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
            HUE_TINT[i.hue],
          )}
        >
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ── Summary stat tile ────────────────────────────────────────────────────────
function StatTile({
  icon,
  label,
  value,
  hue,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hue: number;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <div className={cn('rounded-md p-1.5', HUE_TINT[hue])}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <p className="mt-1.5 text-2xl font-bold tracking-tight text-foreground">{value}</p>
    </div>
  );
}

// ── AI insights panel ────────────────────────────────────────────────────────
function InsightsPanel({ insights }: { insights: InsightsReport }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Lightbulb className="h-4 w-4 text-[hsl(var(--chart-1))]" />
        AI insights
      </h3>
      {insights.summary && <p className="text-sm text-foreground">{insights.summary}</p>}

      {insights.topOpportunities.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Target className="h-3.5 w-3.5 text-[hsl(var(--chart-3))]" />
            Top opportunities
          </p>
          <ul className="space-y-1">
            {insights.topOpportunities.map((o, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{o.keyword}</span>
                {o.why ? ` — ${o.why}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {insights.contentIdeas.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <ListChecks className="h-3.5 w-3.5 text-[hsl(var(--chart-2))]" />
            Content ideas
          </p>
          <ul className="space-y-1.5">
            {insights.contentIdeas.map((c, i) => (
              <li key={i}>
                <p className="text-sm text-foreground">{c.title}</p>
                <p className="text-[11px] text-muted-foreground">
                  targets: {c.keyword} · {c.angle}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {insights.avoid.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Ban className="h-3.5 w-3.5 text-destructive" />
            Avoid
          </p>
          <ul className="space-y-1">
            {insights.avoid.map((a, i) => (
              <li key={i} className="text-xs text-muted-foreground">
                <span className="font-medium text-destructive">{a.keyword}</span>
                {a.why ? ` — ${a.why}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {insights.seriesStrategy && (
        <div className="mt-4">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Layers className="h-3.5 w-3.5 text-[hsl(var(--chart-4))]" />
            Series strategy
          </p>
          <p className="text-sm text-foreground">{insights.seriesStrategy}</p>
        </div>
      )}
    </section>
  );
}

export default function KeywordResearchPage() {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [status, setStatus] = useState<KeywordResearchStatusOutput | null>(null);
  const [youtubeConfigured, setYoutubeConfigured] = useState(false);
  const [trendsAvailable, setTrendsAvailable] = useState(false);
  const [promptOptimizerConfigured, setPromptOptimizerConfigured] = useState(false);

  // Input state (per mode).
  const [mode, setMode] = useState<ResearchMode>('seeds');
  const [seedsInput, setSeedsInput] = useState('');
  const [topicInput, setTopicInput] = useState('');
  const [competitorsInput, setCompetitorsInput] = useState('');
  const [freeTextInput, setFreeTextInput] = useState('');
  const [niche, setNiche] = useState('');
  const [maxKeywords, setMaxKeywords] = useState('');

  // Run / job state.
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<ResearchJobSnapshot | null>(null);
  const [run, setRun] = useState<ResearchRunResult | null>(null);
  const [loadingRun, setLoadingRun] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // History.
  const [runs, setRuns] = useState<ResearchRunListItem[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pinningId, setPinningId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [historyMode, setHistoryMode] = useState<ModeFilter>('all');
  const [historyOpen, setHistoryOpen] = useState(false); // mobile drawer

  // Results view state.
  const [sort, setSort] = useState<SortState>({ key: 'opportunityScore', dir: 'desc' });
  const [clusterFilter, setClusterFilter] = useState<string>('all');

  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const savingRenameRef = useRef(false);

  const refreshRuns = useCallback(() => {
    listResearchRuns({})
      .then((r) => setRuns(r.runs ?? []))
      .catch(() => {
        /* history is non-critical */
      });
  }, []);

  useEffect(() => {
    keywordResearchStatus({})
      .then((s) => {
        setStatus(s);
        setYoutubeConfigured(!!s.youtubeConfigured);
        setTrendsAvailable(!!s.trendsAvailable);
        setPromptOptimizerConfigured(!!s.promptOptimizerConfigured);
      })
      .catch(() => {
        setStatus(null);
        setYoutubeConfigured(false);
      })
      .finally(() => setLoadingStatus(false));
    refreshRuns();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [refreshRuns]);

  const startPolling = useCallback(
    (jobId: string) => {
      if (poll.current) {
        clearInterval(poll.current);
        poll.current = null;
      }
      const tick = async () => {
        try {
          const snap = await keywordResearchJobStatus({ jobId });
          setJob(snap);
          if (snap.status !== 'running') {
            if (poll.current) {
              clearInterval(poll.current);
              poll.current = null;
            }
            if (snap.status === 'completed') {
              try {
                const full = await getResearchRun({ runId: snap.runId });
                setRun(full);
                setClusterFilter('all');
                setSort({ key: 'opportunityScore', dir: 'desc' });
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Could not load results');
              }
            } else if (snap.status === 'failed') {
              toast.error(snap.error || 'Keyword research failed');
            }
            refreshRuns();
          }
        } catch {
          /* transient — keep polling */
        }
      };
      poll.current = setInterval(tick, 2000);
      tick();
    },
    [refreshRuns],
  );

  const start = async () => {
    const input: StartKeywordResearchInput = { mode };
    if (niche.trim()) input.niche = niche.trim();
    const max = parseInt(maxKeywords, 10);
    if (!Number.isNaN(max) && max > 0) input.maxKeywords = max;

    if (mode === 'seeds') {
      const seeds = parseList(seedsInput);
      if (seeds.length === 0) {
        toast.error('Add at least one seed keyword');
        return;
      }
      input.seeds = seeds;
    } else if (mode === 'topic') {
      if (!topicInput.trim()) {
        toast.error('Describe the topic to expand');
        return;
      }
      input.topic = topicInput.trim();
    } else if (mode === 'competitors') {
      const comps = parseLines(competitorsInput);
      if (comps.length === 0) {
        toast.error('Add at least one competitor channel');
        return;
      }
      input.competitors = comps;
    } else {
      if (!freeTextInput.trim()) {
        toast.error('Describe your niche or idea');
        return;
      }
      input.freeText = freeTextInput.trim();
    }

    setStarting(true);
    setRun(null);
    setJob(null);
    try {
      const { jobId } = await startKeywordResearch(input);
      startPolling(jobId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start research');
    } finally {
      setStarting(false);
    }
  };

  const loadRun = async (runId: string) => {
    setLoadingRun(true);
    try {
      const full = await getResearchRun({ runId });
      setRun(full);
      setJob(null);
      setClusterFilter('all');
      setSort({ key: 'opportunityScore', dir: 'desc' });
      setHistoryOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load run');
    } finally {
      setLoadingRun(false);
    }
  };

  const removeRun = async (runId: string) => {
    setDeletingId(runId);
    try {
      await deleteResearchRun({ runId });
      if (run?.runId === runId) setRun(null);
      refreshRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete run');
    } finally {
      setDeletingId(null);
    }
  };

  const newSearch = () => {
    setRun(null);
    setJob(null);
    setHistoryOpen(false);
  };

  const togglePin = async (r: ResearchRunListItem) => {
    setPinningId(r.id);
    try {
      await pinResearchRun({ runId: r.id, pinned: !r.pinned });
      toast.success(r.pinned ? 'Unpinned' : 'Pinned');
      refreshRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update pin');
    } finally {
      setPinningId(null);
    }
  };

  const startRename = (r: ResearchRunListItem) => {
    setRenamingId(r.id);
    setRenameValue(r.niche || '');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const saveRename = async (runId: string) => {
    if (savingRenameRef.current) return;
    const name = renameValue.trim();
    if (!name) {
      cancelRename();
      return;
    }
    savingRenameRef.current = true;
    setRenamingId(null);
    setRenameValue('');
    try {
      await renameResearchRun({ runId, niche: name });
      if (run?.runId === runId) setRun((prev) => (prev ? { ...prev, niche: name } : prev));
      toast.success('Renamed');
      refreshRuns();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rename');
      refreshRuns();
    } finally {
      savingRenameRef.current = false;
    }
  };

  const refreshVolumeNow = async () => {
    if (!run) return;
    setRefreshing(true);
    try {
      const updated = await refreshVolume({ runId: run.runId });
      setRun(updated);
      toast.success('Search volume refreshed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not refresh search volume');
    } finally {
      setRefreshing(false);
    }
  };

  // ── Derived: clusters, colors, filtered + sorted keywords ──────────────────
  const keywords = run?.keywords ?? [];

  const clusterNames = useMemo(() => {
    const seen: string[] = [];
    for (const k of keywords) {
      const c = clusterOf(k);
      if (!seen.includes(c)) seen.push(c);
    }
    return seen;
  }, [keywords]);

  const clusterColor = useCallback(
    (name: string) => {
      const idx = clusterNames.indexOf(name);
      const hue = ((idx < 0 ? 0 : idx) % 5) + 1;
      return `hsl(var(--chart-${hue}))`;
    },
    [clusterNames],
  );

  const visibleKeywords = useMemo(() => {
    const filtered =
      clusterFilter === 'all' ? keywords : keywords.filter((k) => clusterOf(k) === clusterFilter);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort.key === 'keyword') return a.keyword.localeCompare(b.keyword) * dir;
      return ((a[sort.key] ?? 0) - (b[sort.key] ?? 0)) * dir;
    });
  }, [keywords, clusterFilter, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'keyword' ? 'asc' : 'desc' },
    );
  }

  function SortHeader({ label, k, className }: { label: string; k: SortKey; className?: string }) {
    const active = sort.key === k;
    return (
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium transition-colors hover:text-foreground',
          active ? 'text-foreground' : 'text-muted-foreground',
          className,
        )}
      >
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-50" />
        )}
      </button>
    );
  }

  // ── CSV export (inline blob download, per TimelineEditorPage idiom) ─────────
  const exportCsv = () => {
    if (!run || keywords.length === 0) return;
    const cols = [
      'keyword',
      'searchVolume',
      'cpc',
      'paidCompetition',
      'demand',
      'competition',
      'opportunity',
      'trends',
      'autocomplete',
      'ytResultCount',
      'topViewMedian',
      'topViewMax',
      'avgChannelSubs',
      'topVideoAgeDays',
      'cluster',
      'gap',
      'outlier',
      'underserved',
      'stale',
      'topCompetitor',
    ];
    const esc = (v: string | number | null): string => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = keywords.map((k) => {
      const top = k.topCompetitors.find((c) => c.rank === 1) ?? k.topCompetitors[0];
      return [
        k.keyword,
        k.searchVolume ?? '',
        k.cpc == null ? '' : k.cpc.toFixed(2),
        k.paidCompetition == null ? '' : Math.round(k.paidCompetition),
        Math.round(k.demandScore),
        Math.round(k.competitionScore),
        Math.round(k.opportunityScore),
        k.trendsScore == null ? '' : Math.round(k.trendsScore),
        Math.round(k.autocompleteScore),
        k.ytResultCount ?? '',
        k.topViewMedian ?? '',
        k.topViewMax ?? '',
        k.avgChannelSubs ?? '',
        k.topVideoAgeDays ?? '',
        clusterOf(k),
        k.gapFlags.demandVsCompetition ? 'yes' : '',
        k.gapFlags.smallChannelOutlier ? 'yes' : '',
        k.gapFlags.underservedSubtopic ? 'yes' : '',
        k.gapFlags.freshnessGap ? 'yes' : '',
        top?.channelTitle ?? '',
      ]
        .map(esc)
        .join(',');
    });
    const csv = [cols.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safe = (run.niche || 'keyword-research').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    a.download = `${safe}-keywords.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  // ── Derived: history search / filter / date grouping ───────────────────────
  const filteredRuns = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return runs.filter((r) => {
      if (historyMode !== 'all' && r.mode !== historyMode) return false;
      if (q && !(r.niche || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [runs, historySearch, historyMode]);

  const historySections = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekFloor = startOfToday - 7 * 86400000;
    const pinned: ResearchRunListItem[] = [];
    const today: ResearchRunListItem[] = [];
    const week: ResearchRunListItem[] = [];
    const earlier: ResearchRunListItem[] = [];
    for (const r of filteredRuns) {
      if (r.pinned) pinned.push(r);
      else if (r.createdAt >= startOfToday) today.push(r);
      else if (r.createdAt >= weekFloor) week.push(r);
      else earlier.push(r);
    }
    return [
      { key: 'pinned', label: 'Pinned', items: pinned },
      { key: 'today', label: 'Today', items: today },
      { key: 'week', label: 'This week', items: week },
      { key: 'earlier', label: 'Earlier', items: earlier },
    ].filter((s) => s.items.length > 0);
  }, [filteredRuns]);

  const running = !!job && job.status === 'running';
  const canStart = youtubeConfigured && !running && !starting;

  // ── A single history row (name, mode badge, stats, date + row actions) ──────
  const renderRunRow = (r: ResearchRunListItem) => {
    const isOpen = run?.runId === r.id;
    const isRenaming = renamingId === r.id;
    return (
      <div
        key={r.id}
        className={cn(
          'group relative flex items-start gap-1.5 px-3 py-2 hover:bg-muted/40',
          isOpen && 'bg-muted/50',
        )}
      >
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <div className="flex items-center gap-1">
              <Input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveRename(r.id);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => void saveRename(r.id)}
                className="h-7 flex-1 text-sm"
              />
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void saveRename(r.id)}
                title="Save"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={cancelRename}
                title="Cancel"
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => loadRun(r.id)}
              className="block w-full min-w-0 text-left"
            >
              <span className="block truncate text-sm font-medium text-foreground">
                {r.niche || 'Untitled'}
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="rounded bg-secondary px-1 text-[10px] font-medium text-secondary-foreground">
                  {MODE_LABEL[r.mode]}
                </span>
                <span>{r.totalKeywords} kw</span>
                {r.gapCount > 0 && (
                  <span className="text-[hsl(var(--chart-3))]">· {r.gapCount} gaps</span>
                )}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                {r.status === 'running' && (
                  <span className="inline-flex items-center gap-1 text-[hsl(var(--chart-1))]">
                    <Loader2 className="h-2.5 w-2.5 animate-spin" /> running
                  </span>
                )}
                {r.status === 'failed' && <AlertTriangle className="h-2.5 w-2.5 text-destructive" />}
                <span>{relTime(r.createdAt)}</span>
              </span>
            </button>
          )}
        </div>

        {!isRenaming && (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={() => void togglePin(r)}
              disabled={pinningId === r.id}
              title={r.pinned ? 'Unpin' : 'Pin'}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {pinningId === r.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : r.pinned ? (
                <PinOff className="h-3.5 w-3.5" />
              ) : (
                <Pin className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => startRename(r)}
              title="Rename"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void removeRun(r.id)}
              disabled={deletingId === r.id}
              title="Delete run"
              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              {deletingId === r.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        )}
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Layout breadcrumb="Keyword Research">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
        <header className="mb-5 flex items-center gap-2">
          <div className="rounded-md bg-[hsl(var(--chart-3))]/10 p-2 text-[hsl(var(--chart-3))]">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">YouTube Keyword Research</h1>
            <p className="text-xs text-muted-foreground">
              Find high-demand, low-competition keywords and the untapped gaps in your niche.
            </p>
          </div>
        </header>

        {loadingStatus ? (
          <div className="space-y-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-2/3" />
          </div>
        ) : !youtubeConfigured ? (
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-[hsl(var(--chart-5))]/10 p-2 text-[hsl(var(--chart-5))]">
                <KeyRound className="h-4 w-4" />
              </div>
              <div className="flex-1">
                <h2 className="font-semibold text-foreground">Connect your YouTube Data API key</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Keyword research reads YouTube search results, view velocity and channel sizes to score demand
                  vs competition. Add your YouTube Data API key — the same one the Thumbnail Designer uses — to
                  begin. It's stored write-only on the server.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    YouTube not set
                  </Badge>
                  <Button asChild variant="outline" size="sm" className="ml-auto">
                    <Link to="/settings/postiz">
                      <Settings className="h-4 w-4" />
                      Configure key
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <>
            {/* Mobile-only History toggle (sidebar is always visible on lg+). */}
            <div className="mb-4 lg:hidden">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setHistoryOpen((o) => !o)}
              >
                <History className="h-4 w-4" />
                History
                <span className="text-muted-foreground">({runs.length})</span>
              </Button>
            </div>

            <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
              {/* ── History sidebar ─────────────────────────────────────────── */}
              <aside
                className={cn('lg:block lg:w-72 lg:shrink-0', historyOpen ? 'block' : 'hidden')}
              >
                <div className="rounded-xl border border-border bg-card lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
                  {/* Header */}
                  <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      <History className="h-4 w-4 text-muted-foreground" />
                      History
                      <span className="text-xs font-normal text-muted-foreground">
                        ({runs.length})
                      </span>
                    </h3>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={newSearch}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New search
                    </Button>
                  </div>

                  {/* Search + mode filter */}
                  <div className="space-y-2 border-b border-border px-3 py-2.5">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={historySearch}
                        onChange={(e) => setHistorySearch(e.target.value)}
                        placeholder="Search history…"
                        className="h-8 pl-7 text-sm"
                      />
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {MODE_FILTERS.map((f) => (
                        <button
                          key={f.key}
                          type="button"
                          onClick={() => setHistoryMode(f.key)}
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
                            historyMode === f.key
                              ? 'border-transparent bg-primary text-primary-foreground'
                              : 'border-border text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* List */}
                  {runs.length === 0 ? (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                      No searches yet — run one to see it here.
                    </p>
                  ) : historySections.length === 0 ? (
                    <p className="px-3 py-8 text-center text-xs text-muted-foreground">No matches.</p>
                  ) : (
                    <div className="py-1">
                      {historySections.map((section) => (
                        <div key={section.key} className="mb-1">
                          <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {section.label}
                          </p>
                          <div>{section.items.map((r) => renderRunRow(r))}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </aside>

              {/* ── Main column ─────────────────────────────────────────────── */}
              <div className="min-w-0 flex-1 space-y-6">
              {/* Input */}
              <section className="rounded-xl border border-border bg-card p-4">
                <Tabs value={mode} onValueChange={(v) => setMode(v as ResearchMode)}>
                  <TabsList className="grid w-full grid-cols-4">
                    <TabsTrigger value="seeds">Seeds</TabsTrigger>
                    <TabsTrigger value="topic">Topic</TabsTrigger>
                    <TabsTrigger value="competitors">Competitors</TabsTrigger>
                    <TabsTrigger value="ai">AI</TabsTrigger>
                  </TabsList>

                  <TabsContent value="seeds" className="space-y-1.5">
                    <Label htmlFor="kr-seeds">Seed keywords</Label>
                    <Textarea
                      id="kr-seeds"
                      value={seedsInput}
                      onChange={(e) => setSeedsInput(e.target.value)}
                      placeholder="e.g. air fryer recipes, meal prep, high protein snacks"
                      rows={3}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Comma- or line-separated. We expand each into related keywords and score them.
                    </p>
                  </TabsContent>

                  <TabsContent value="topic" className="space-y-1.5">
                    <Label htmlFor="kr-topic">Topic</Label>
                    <Textarea
                      id="kr-topic"
                      value={topicInput}
                      onChange={(e) => setTopicInput(e.target.value)}
                      placeholder="e.g. beginner home fitness for busy parents"
                      rows={3}
                    />
                    <p className="text-[11px] text-muted-foreground">AI expands this topic into seed keywords, then scores them.</p>
                  </TabsContent>

                  <TabsContent value="competitors" className="space-y-1.5">
                    <Label htmlFor="kr-competitors">Competitor channels</Label>
                    <Textarea
                      id="kr-competitors"
                      value={competitorsInput}
                      onChange={(e) => setCompetitorsInput(e.target.value)}
                      placeholder={'One per line:\nhttps://youtube.com/@somecreator\n@anothercreator'}
                      rows={3}
                    />
                    <p className="text-[11px] text-muted-foreground">One channel URL or @handle per line — we mine the keywords they rank for.</p>
                  </TabsContent>

                  <TabsContent value="ai" className="space-y-1.5">
                    <Label htmlFor="kr-ai">Describe your niche or idea</Label>
                    <Textarea
                      id="kr-ai"
                      value={freeTextInput}
                      onChange={(e) => setFreeTextInput(e.target.value)}
                      placeholder="e.g. I make short cooking videos and want to grow a channel around quick weeknight dinners"
                      rows={3}
                    />
                    <p className="text-[11px] text-muted-foreground">AI infers the market, competitors and keywords for you.</p>
                  </TabsContent>
                </Tabs>

                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[180px] space-y-1.5">
                    <Label htmlFor="kr-niche">Niche label</Label>
                    <Input
                      id="kr-niche"
                      value={niche}
                      onChange={(e) => setNiche(e.target.value)}
                      placeholder="e.g. Home cooking"
                    />
                  </div>
                  <div className="w-32 space-y-1.5">
                    <Label htmlFor="kr-max">Max keywords</Label>
                    <Input
                      id="kr-max"
                      type="number"
                      min={1}
                      value={maxKeywords}
                      onChange={(e) => setMaxKeywords(e.target.value)}
                      placeholder="120"
                    />
                  </div>
                  <Button onClick={start} disabled={!canStart} className="gap-1.5">
                    {starting || running ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )}
                    {running ? 'Researching…' : 'Start research'}
                  </Button>
                </div>

                {!trendsAvailable && (
                  <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <AlertTriangle className="h-3 w-3" />
                    Google Trends is unavailable — demand scores lean on autocomplete + YouTube volume.
                  </p>
                )}
                {mode !== 'seeds' && !promptOptimizerConfigured && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <AlertTriangle className="h-3 w-3" />
                    An Anthropic key (Settings) improves AI expansion for Topic / Competitors / AI modes.
                  </p>
                )}
              </section>

              {/* Live progress */}
              {job && running && (
                <section className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {job.phase || 'Researching…'}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{Math.round(job.percent)}%</span>
                  </div>
                  <Progress value={Math.max(2, Math.min(100, job.percent))} />
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {job.keywordsFound} found · {job.keywordsScored} scored
                  </p>
                </section>
              )}

              {loadingRun && (
                <div className="space-y-3">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-64 w-full" />
                </div>
              )}

              {/* Results */}
              {run && !loadingRun && run.status !== 'running' && (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="text-lg font-semibold text-foreground">{run.niche || 'Untitled run'}</h2>
                      <p className="text-xs text-muted-foreground">
                        {MODE_LABEL[run.mode]} · {run.summary.totalKeywords} keywords · {relTime(run.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {status?.keywordApiConfigured && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={refreshVolumeNow}
                          disabled={refreshing}
                        >
                          {refreshing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          Refresh volume
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={exportCsv} disabled={keywords.length === 0}>
                        <Download className="h-4 w-4" />
                        Export CSV
                      </Button>
                    </div>
                  </div>

                  {run.status === 'failed' && (
                    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{run.error || 'This run failed.'}</span>
                    </div>
                  )}

                  {/* Summary tiles */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <StatTile icon={<Search className="h-4 w-4" />} label="Keywords" value={String(run.summary.totalKeywords)} hue={2} />
                    <StatTile icon={<Target className="h-4 w-4" />} label="Market gaps" value={String(run.summary.gapCount)} hue={3} />
                    <StatTile icon={<TrendingUp className="h-4 w-4" />} label="Avg demand" value={fmtScore(run.summary.avgDemand)} hue={1} />
                    <StatTile icon={<Users className="h-4 w-4" />} label="Avg competition" value={fmtScore(run.summary.avgCompetition)} hue={5} />
                  </div>

                  {/* Market analysis */}
                  {run.market && (
                    <section className="rounded-xl border border-border bg-card p-4">
                      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Sparkles className="h-4 w-4 text-[hsl(var(--chart-4))]" />
                        Market analysis
                      </h3>
                      <p className="text-sm text-foreground">{run.market.overview}</p>
                      {run.market.audience && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Audience: </span>
                          {run.market.audience}
                        </p>
                      )}
                      {run.market.topCompetitors.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-xs font-medium text-foreground">Top competitors</p>
                          <ul className="space-y-1">
                            {run.market.topCompetitors.map((c, i) => (
                              <li key={i} className="text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">{c.name}</span>
                                {c.note ? ` — ${c.note}` : ''}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {run.market.contentAngles.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-xs font-medium text-foreground">Content angles</p>
                          <div className="flex flex-wrap gap-1.5">
                            {run.market.contentAngles.map((a, i) => (
                              <Badge key={i} variant="secondary" className="text-[11px]">
                                {a}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </section>
                  )}

                  {/* AI insights */}
                  {run.insights && <InsightsPanel insights={run.insights} />}

                  {/* Opportunity Map */}
                  {keywords.length > 0 && (
                    <section className="rounded-xl border border-border bg-card p-4">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <Target className="h-4 w-4 text-[hsl(var(--chart-3))]" />
                          Opportunity map
                        </h3>
                        {clusterNames.length > 1 && (
                          <Select value={clusterFilter} onValueChange={setClusterFilter}>
                            <SelectTrigger className="h-8 w-auto gap-1 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="all" className="text-xs">
                                All clusters
                              </SelectItem>
                              {clusterNames.map((c) => (
                                <SelectItem key={c} value={c} className="text-xs">
                                  {c}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      <OpportunityMap keywords={visibleKeywords} clusterColor={clusterColor} />
                      {clusterNames.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
                          {clusterNames.map((c) => (
                            <span key={c} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: clusterColor(c) }} />
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </section>
                  )}

                  {/* Ranked table */}
                  {keywords.length > 0 && (
                    <section className="rounded-xl border border-border bg-card">
                      <div className="flex items-center justify-between px-4 py-3">
                        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                          <Layers className="h-4 w-4 text-[hsl(var(--chart-2))]" />
                          Ranked keywords
                          <span className="text-xs font-normal text-muted-foreground">({visibleKeywords.length})</span>
                        </h3>
                      </div>
                      <div className="overflow-x-auto">
                        <div className="min-w-[860px]">
                          {/* Header */}
                          <div className="grid grid-cols-[minmax(160px,2.4fr)_92px_72px_88px_84px_minmax(150px,1.6fr)_minmax(140px,1.6fr)] gap-2 border-y border-border px-4 py-2">
                            <SortHeader label="Keyword" k="keyword" className="justify-self-start" />
                            <SortHeader label="Vol/mo" k="searchVolume" />
                            <SortHeader label="Demand" k="demandScore" />
                            <SortHeader label="Competition" k="competitionScore" />
                            <SortHeader label="Opp." k="opportunityScore" />
                            <span className="text-xs font-medium text-muted-foreground">Gaps</span>
                            <span className="text-xs font-medium text-muted-foreground">Top competitor</span>
                          </div>
                          {/* Rows */}
                          <div className="divide-y divide-border">
                            {visibleKeywords.map((k) => {
                              const top = k.topCompetitors.find((c) => c.rank === 1) ?? k.topCompetitors[0];
                              return (
                                <div
                                  key={k.keyword}
                                  className="grid grid-cols-[minmax(160px,2.4fr)_92px_72px_88px_84px_minmax(150px,1.6fr)_minmax(140px,1.6fr)] items-center gap-2 px-4 py-2.5 hover:bg-muted/30"
                                >
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-foreground">{k.keyword}</p>
                                    {k.cluster && (
                                      <p className="truncate text-[10px] text-muted-foreground">{k.cluster}</p>
                                    )}
                                  </div>
                                  <span
                                    className="text-sm text-foreground"
                                    title={k.searchVolume == null ? 'No DataForSEO volume' : 'Monthly Google searches (DataForSEO)'}
                                  >
                                    {k.searchVolume == null ? '—' : fmtNum(k.searchVolume)}
                                  </span>
                                  <span className="text-sm text-foreground">{fmtScore(k.demandScore)}</span>
                                  <span className="text-sm text-foreground">{fmtScore(k.competitionScore)}</span>
                                  <span className={cn('text-sm font-semibold', oppColorClass(k.opportunityScore))}>
                                    {fmtScore(k.opportunityScore)}
                                  </span>
                                  <GapBadges k={k} />
                                  <div className="min-w-0">
                                    {top ? (
                                      <>
                                        <p className="truncate text-xs text-foreground">{top.channelTitle}</p>
                                        <p className="truncate text-[10px] text-muted-foreground">
                                          {fmtNum(top.subscriberCount)} subs · {fmtNum(top.videoViews)} views
                                        </p>
                                      </>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </section>
                  )}
                </>
              )}

              {/* Empty state */}
              {!run && !running && !loadingRun && (
                <div className="rounded-xl border border-dashed border-border py-16 text-center text-muted-foreground">
                  <Search className="mx-auto mb-3 h-8 w-8 opacity-40" />
                  <p className="text-sm">Start a research run to map demand vs competition for your niche.</p>
                  <p className="mt-1 text-xs opacity-70">Pick a mode above, add your input, and hit Start research.</p>
                </div>
              )}
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
