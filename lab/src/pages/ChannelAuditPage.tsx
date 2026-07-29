/**
 * Channel Audit — the report page.
 *
 * The flow has a deliberate stop in the middle: the tool proposes a market and
 * a competitor set, and nothing expensive runs until that is confirmed. So this
 * page is really three screens — start, approve, report — and the approval one
 * is the only place the operator has to think.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Search,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Trash2,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Plus,
  X,
  MessageSquare,
  Send,
} from 'lucide-react';
import {
  auditStatus,
  startAudit,
  auditJobStatus,
  approveAuditMarket,
  getAuditRun,
  listAuditRuns,
  deleteAuditRun,
  auditChat,
  clearAuditFocus,
} from '../../web/src/shims/endpoints';
import {
  VIZ_STYLE,
  MarketPositionChart,
  TopicPerformanceChart,
  OpportunityChart,
} from './auditCharts';

type Mode = 'own' | 'teardown';

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n.toLocaleString();

const relTime = (ms: number) => {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

/** Stages, in order, so progress reads as a journey rather than a number. */
const STAGE_LABEL: Record<string, string> = {
  ingesting: 'Reading the channel',
  proposing: 'Working out the market',
  'awaiting-approval': 'Waiting for you',
  scanning: 'Scanning competitors',
  analysing: 'Analysing',
  renaming: 'Writing new titles',
  completed: 'Done',
  failed: 'Failed',
};

export default function ChannelAuditPage() {
  const [config, setConfig] = useState<{
    youtubeConfigured: boolean;
    anthropicConfigured: boolean;
    analyticsConfigured?: boolean;
    analyticsConnected?: boolean;
  } | null>(null);
  const [channel, setChannel] = useState('');
  const [mode, setMode] = useState<Mode>('own');
  const [angle, setAngle] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [run, setRun] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Onboarding hides itself once you have run an audit, and stays hidden after
  // that. Reopenable from the header, because the "what does 3.2x mean" part is
  // worth re-reading long after the flow is familiar.
  const [showHelp, setShowHelp] = useState(() => localStorage.getItem('audit.onboarded') !== '1');
  const poll = useRef<number | null>(null);

  useEffect(() => {
    auditStatus().then(setConfig).catch(() => setConfig(null));
    refreshList();
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, []);

  const refreshList = useCallback(() => {
    listAuditRuns({ limit: 50 })
      .then((r: any) => setRuns(r.runs || []))
      .catch(() => {});
  }, []);

  const loadRun = useCallback(
    async (id: string) => {
      try {
        const r = await getAuditRun({ runId: id });
        setRun(r);
        setRunId(id);
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    },
    [],
  );

  // One poller for the whole page. It follows the job, and reloads the full run
  // whenever the stage changes — the run row is large, so it is not fetched on
  // every tick.
  useEffect(() => {
    if (!runId) return;
    if (poll.current) window.clearInterval(poll.current);
    let lastStatus = '';
    const tick = async () => {
      try {
        const j = await auditJobStatus({ runId });
        setJob(j);
        if (j.status !== lastStatus) {
          lastStatus = j.status;
          await loadRun(runId);
          refreshList();
        }
        if (j.status === 'completed' || j.status === 'failed' || j.status === 'awaiting-approval') {
          if (poll.current) window.clearInterval(poll.current);
          poll.current = null;
        }
      } catch {
        /* transient */
      }
    };
    void tick();
    poll.current = window.setInterval(tick, 2500);
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, [runId, loadRun, refreshList]);

  async function onStart(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!channel.trim()) return setError('Paste a channel URL or @handle.');
    setBusy(true);
    try {
      const { runId: id } = await startAudit({ channel: channel.trim(), mode, angle: angle.trim() || undefined });
      localStorage.setItem('audit.onboarded', '1');
      setShowHelp(false);
      setRun(null);
      setRunId(id);
      refreshList();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const status = job?.status ?? run?.status;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex items-start gap-3">
        <Search className="mt-1 h-6 w-6 text-[hsl(var(--chart-4))]" />
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">Channel Audit</h1>
          <p className="text-sm text-muted-foreground">
            The market, the competitors, what the titles and thumbnails have in common, where it stands — and a
            better title for every video.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          className="mt-1 shrink-0 rounded-md border px-2.5 py-1 text-xs text-muted-foreground"
        >
          {showHelp ? 'Hide' : 'How this works'}
        </button>
      </header>

      {showHelp && <Onboarding onDismiss={() => { localStorage.setItem('audit.onboarded', '1'); setShowHelp(false); }} />}

      {config && !config.youtubeConfigured && (
        <Notice tone="warn">
          The YouTube Data API key is not configured, so nothing can be read. Add it in Settings → Postiz.
        </Notice>
      )}

      <PaidOrganicPanel config={config} />

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="space-y-6">
          {/* ── start ─────────────────────────────────────────────────── */}
          <form onSubmit={onStart} className="rounded-lg border p-5">
            <label className="mb-2 block text-sm font-medium">Channel</label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                placeholder="https://www.youtube.com/@handle"
                className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={busy || !config?.youtubeConfigured}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Audit
              </button>
            </div>

            <label className="mt-4 mb-1 block text-sm font-medium">
              What is this channel about now? <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <textarea
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
              rows={2}
              placeholder="e.g. I used to make scraping tutorials; now it's AI tool reviews for solo operators."
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              A catalogue is a history. If the channel has changed direction, say so here and the whole audit is
              angled to what you make now — the market it looks for, how it groups topics, the report and the plan.
              Without it, an old catalogue gets analysed as the channel it used to be.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              {(
                [
                  ['own', 'My channel', 'Actionable — includes a proposed title for every video'],
                  ['teardown', 'Someone else', 'Diagnostic — why they win, no renaming'],
                ] as [Mode, string, string][]
              ).map(([m, label, hint]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  title={hint}
                  className={`rounded-md border px-3 py-1.5 text-xs ${
                    mode === m ? 'border-primary bg-primary/10 font-medium' : 'text-muted-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          </form>

          {/* ── progress ──────────────────────────────────────────────── */}
          {status && status !== 'completed' && status !== 'awaiting-approval' && (
            <div className="rounded-lg border p-5">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                {status === 'failed' ? (
                  <AlertCircle className="h-4 w-4 text-destructive" />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {job?.stage || STAGE_LABEL[status] || status}
              </div>
              {status !== 'failed' && (
                <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }}
                  />
                </div>
              )}
              {job?.error && <p className="mt-3 text-sm text-destructive">{job.error}</p>}
            </div>
          )}

          {/* ── the approval gate ─────────────────────────────────────── */}
          {status === 'awaiting-approval' && run?.proposal && (
            <MarketApproval
              run={run}
              onApproved={() => {
                setJob({ status: 'scanning', stage: 'Scanning competitors', progress: 0.25 });
                setRunId(run.runId); // restart polling
                const id = run.runId;
                setRunId(null);
                setTimeout(() => setRunId(id), 0);
              }}
            />
          )}

          {/* ── the report ────────────────────────────────────────────── */}
          {run?.status === 'completed' && run.findings && (
            <Report run={run} onChanged={() => loadRun(run.runId)} />
          )}
        </div>

        {/* ── history ───────────────────────────────────────────────── */}
        <aside className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">History</h2>
            <button onClick={refreshList} className="text-muted-foreground hover:text-foreground" title="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
          {!runs.length && <p className="text-xs text-muted-foreground">No audits yet.</p>}
          {runs.map((r) => (
            <div
              key={r.runId}
              className={`group flex items-start gap-2 rounded-md border p-2 text-xs ${
                r.runId === runId ? 'border-primary bg-primary/5' : ''
              }`}
            >
              <button onClick={() => loadRun(r.runId)} className="flex-1 text-left">
                <div className="font-medium">{r.title}</div>
                <div className="text-muted-foreground">
                  {STAGE_LABEL[r.status] ?? r.status} · {r.videoCount} videos · {relTime(r.createdAt)}
                </div>
              </button>
              <button
                onClick={async () => {
                  await deleteAuditRun({ runId: r.runId });
                  if (r.runId === runId) {
                    setRunId(null);
                    setRun(null);
                  }
                  refreshList();
                }}
                className="opacity-0 transition group-hover:opacity-100"
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

/**
 * The stop in the middle.
 *
 * Everything after this costs quota and tokens, and all of it is worthless if
 * the market is wrong — so the subject summary is shown first and prominently.
 * If the tool has misunderstood what the channel is about, that sentence is
 * where it shows, and it is far cheaper to catch here than in the report.
 */
function MarketApproval({ run, onApproved }: { run: any; onApproved: () => void }) {
  const [market, setMarket] = useState<any>(run.proposal);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (i: number) =>
    setMarket((m: any) => ({
      ...m,
      competitors: m.competitors.map((c: any, j: number) => (j === i ? { ...c, include: !c.include } : c)),
    }));

  const add = () => {
    const handle = adding.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?youtube\.com\/@?/, '');
    if (!handle) return;
    setMarket((m: any) => ({
      ...m,
      competitors: [
        ...m.competitors,
        { channelId: null, handle, title: handle, reason: 'Added by you', include: true, addedByUser: true },
      ],
    }));
    setAdding('');
  };

  const kept = market.competitors.filter((c: any) => c.include).length;

  return (
    <div className="rounded-lg border-2 border-primary/40 p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <CheckCircle2 className="h-4 w-4 text-primary" />
        Confirm the market before the expensive part runs
      </div>

      <div className="mb-4 rounded-md bg-muted/50 p-3 text-sm">
        <p className="mb-1">
          <span className="font-medium">This channel is:</span> {market.subjectSummary}
        </p>
        <p className="mb-1">
          <span className="font-medium">Market:</span> {market.niche} — {market.nicheDescription}
        </p>
        <p>
          <span className="font-medium">Audience:</span> {market.audience}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          If that description is wrong, everything below is comparing against the wrong people. Fix the list or
          start again with a different channel.
        </p>
      </div>

      <p className="mb-2 text-sm font-medium">Competitors ({kept} selected)</p>
      <div className="space-y-2">
        {market.competitors.map((c: any, i: number) => (
          <label
            key={`${c.handle}-${i}`}
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
              c.include ? '' : 'opacity-50'
            }`}
          >
            <input type="checkbox" checked={c.include} onChange={() => toggle(i)} className="mt-1" />
            <span className="flex-1">
              <span className="font-medium">{c.title}</span>
              {c.handle && <span className="ml-1 text-muted-foreground">@{c.handle}</span>}
              <span className="block text-xs text-muted-foreground">{c.reason}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder="Add a channel we missed (@handle)"
          className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
        />
        <button onClick={add} type="button" className="rounded-md border px-3 py-1.5 text-sm">
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <button
        disabled={busy || kept === 0}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await approveAuditMarket({ runId: run.runId, market });
            onApproved();
          } catch (e: any) {
            setError(String(e?.message || e));
            setBusy(false);
          }
        }}
        className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
        Looks right — run the audit
      </button>
      {kept === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Keep at least one competitor to compare against.</p>
      )}
    </div>
  );
}

function Report({ run, onChanged }: { run: any; onChanged: () => void }) {
  const f = run.findings;
  const renames = (run.videos || [])
    .filter((v: any) => v.rename)
    .sort((a: any, b: any) => (b.rename?.priority ?? 0) - (a.rename?.priority ?? 0));

  return (
    <div className="space-y-6">
      {run.focus && <FocusBanner run={run} onChanged={onChanged} />}

      <ReportChat run={run} onChanged={onChanged} />

      <Card title="Summary">
        <p className="text-sm">{f.summary}</p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Videos" value={fmt(run.videos?.length)} />
          <Stat label="Competitors" value={fmt(run.competitors?.length)} />
          <Stat label="Rank by subs" value={`${f.position.subscriberRank} of ${f.position.competitorCount + 1}`} />
          <Stat
            label="Rank by median views"
            value={`${f.position.medianViewsRank} of ${f.position.competitorCount + 1}`}
          />
        </div>
      </Card>

      <Card title="Where it stands">
        <p className="mb-3 text-sm">{f.position.verdict}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <List title="Strengths" items={f.position.strengths} tone="up" />
          <List title="Weaknesses" items={f.position.weaknesses} tone="down" />
        </div>
      </Card>

      <style>{VIZ_STYLE}</style>

      <Card title="The market, in pictures">
        <div className="space-y-8">
          <MarketPositionChart
            subject={run.subject}
            competitors={run.competitors || []}
            videos={run.videos || []}
            marketVideos={run.marketVideos || []}
          />
          <TopicPerformanceChart topics={f.content.topics} />
          <OpportunityChart topics={f.content.topics} />
        </div>
      </Card>

      <ReachCard videos={run.videos} />

      <EngagementSignalCard videos={run.videos} />

      <Card title="Titles">
        <p className="mb-3 text-sm">{f.titles.verdict}</p>
        <PatternTable rows={f.titles.winning} tone="up" />
        <PatternTable rows={f.titles.losing} tone="down" />
      </Card>

      <Card title="Thumbnails">
        <p className="mb-3 text-sm">{f.thumbnails.verdict}</p>
        {!f.thumbnails.correlations.length && (
          <p className="text-sm text-muted-foreground">
            Not enough of a contrast to compare — this channel does much the same thing on every thumbnail.
          </p>
        )}
        <div className="space-y-1">
          {f.thumbnails.correlations.map((c: any, i: number) => {
            const better = c.medianMultipleWith > c.medianMultipleWithout;
            return (
              <div key={i} className="flex items-center gap-3 rounded border px-3 py-2 text-sm">
                <span className="flex-1">
                  {c.attribute} <span className="text-muted-foreground">({c.value})</span>
                </span>
                <span className={better ? 'text-[hsl(var(--chart-3))]' : 'text-muted-foreground'}>
                  {c.medianMultipleWith.toFixed(2)}x with
                </span>
                <span className="text-muted-foreground">vs {c.medianMultipleWithout.toFixed(2)}x without</span>
                <span className="text-xs text-muted-foreground">n={c.sampleSize}</span>
              </div>
            );
          })}
        </div>
      </Card>

      <Card title="Content">
        <p className="mb-3 text-sm">{f.content.verdict}</p>
        <div className="mb-4 space-y-1">
          {f.content.topics.map((t: any, i: number) => (
            <div key={i} className="flex items-center gap-3 rounded border px-3 py-2 text-sm">
              <span className="flex-1">{t.topic}</span>
              <span className={t.medianMultiple >= 1 ? 'text-[hsl(var(--chart-3))]' : 'text-muted-foreground'}>
                {t.medianMultiple.toFixed(2)}x
              </span>
              <span className="text-xs text-muted-foreground">{t.count} videos</span>
            </div>
          ))}
        </div>
        {!!f.content.gaps.length && (
          <>
            <p className="mb-2 text-sm font-medium">Room to grow into</p>
            <div className="space-y-2">
              {f.content.gaps.map((g: any, i: number) => (
                <div key={i} className="rounded border p-3 text-sm">
                  <div className="font-medium">{g.topic}</div>
                  <div className="text-muted-foreground">{g.evidence}</div>
                  {!!g.marketExamples?.length && (
                    <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                      {g.marketExamples.slice(0, 3).map((m: string, j: number) => (
                        <li key={j}>{m}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {!!f.growth?.length && (
        <Card title="What to do next">
          <div className="space-y-2">
            {f.growth.map((g: any, i: number) => (
              <div key={i} className="rounded border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{g.title}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {g.effort} effort · {g.confidence} confidence
                  </span>
                </div>
                <p className="mt-1">{g.action}</p>
                <p className="mt-1 text-xs text-muted-foreground">{g.evidence}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      {f.actionPlan?.categories?.length ? <ActionPlan plan={f.actionPlan} /> : null}

      {!!renames.length && (
        <Card title={`Proposed titles (${renames.length})`}>
          <p className="mb-3 text-xs text-muted-foreground">
            Worst-performing first. "Nx" is how the video did against others published around the same time, so
            1.0x is par for its moment.
          </p>
          <div className="space-y-2">
            {renames.map((v: any) => (
              <div key={v.videoId} className="rounded border p-3 text-sm">
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={v.eraMultiple < 1 ? 'text-destructive' : ''}>{v.eraMultiple.toFixed(2)}x</span>
                  <span>{fmt(v.views)} views</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">{v.rename.changeLevel}</span>
                </div>
                <div className="text-muted-foreground line-through">{v.title}</div>
                <div className="font-medium">{v.rename.proposed}</div>
                <p className="mt-1 text-xs text-muted-foreground">{v.rename.rationale}</p>
                {v.rename.modelledOn && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Modelled on: “{v.rename.modelledOn.title}” ({v.rename.modelledOn.channelTitle},{' '}
                    {v.rename.modelledOn.eraMultiple.toFixed(1)}x)
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * The second outlier axis: which videos escaped the existing audience.
 *
 * Shown next to the era multiple rather than instead of it, because the two
 * answer different questions and it is when they DISAGREE that there is
 * something to learn — a video with a high era multiple and low reach played
 * well to subscribers and never travelled.
 */
function ReachCard({ videos }: { videos: any[] }) {
  const scored = (videos || []).filter((v: any) => v.judged && v.format === 'long' && v.viewsPerSub != null);
  if (scored.length < 5) return null;

  const top = [...scored].sort((a, b) => b.viewsPerSub - a.viewsPerSub).slice(0, 8);
  const sorted = [...scored].map((v) => v.viewsPerSub).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];

  return (
    <Card title="Reach — views per subscriber">
      <p className="mb-3 text-xs text-muted-foreground">
        How far each video travelled beyond the audience that already existed. The median video reaches{' '}
        <span className="font-medium">{med.toFixed(2)}</span> viewers per subscriber. This is a different question
        from the era multiple: a video can beat the channel's own norm and still never leave its subscriber base.
      </p>
      <div className="space-y-1">
        {top.map((v: any) => {
          const travelled = v.viewsPerSub > med * 2 && v.eraMultiple < 2;
          return (
            <div key={v.videoId} className="flex items-center gap-3 rounded border px-3 py-2 text-sm">
              <span className="flex-1 truncate" title={v.title}>
                {v.title}
              </span>
              <span className="font-medium text-[hsl(var(--chart-3))]">{v.viewsPerSub.toFixed(2)}/sub</span>
              <span className="text-xs text-muted-foreground">{v.eraMultiple.toFixed(1)}x era</span>
              {travelled && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs" title="Reached well beyond the subscriber base without being an unusual performer for its time">
                  travelled
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * First-run onboarding.
 *
 * Two things nobody can guess from the form: the run STOPS halfway to ask you
 * something, and every table is in multiples of "what this channel normally
 * does at that time" rather than raw views. Both are explained here because
 * both are confusing exactly once.
 */
function Onboarding({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="mb-6 rounded-lg border bg-muted/30 p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-sm font-medium">How this works</h2>
        <button onClick={onDismiss} className="text-muted-foreground hover:text-foreground" title="Dismiss">
          <X className="h-4 w-4" />
        </button>
      </div>

      <ol className="mb-4 space-y-3 text-sm">
        <li className="flex gap-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium">1</span>
          <span>
            <span className="font-medium">Paste a channel and pick a mode.</span> “My channel” is written to act on
            and proposes a new title for every video. “Someone else” is a teardown — the same analysis, no renaming,
            because you cannot retitle a channel you do not own.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium">2</span>
          <span>
            <span className="font-medium">It stops and asks you to confirm the market.</span> This is deliberate.
            It reads the catalogue, searches YouTube for who else ranks for the same things, and shows you the
            competitors it found. Everything after that point costs real money and a chunk of the day&apos;s API
            quota — and all of it is wasted if it is comparing you to the wrong people. Two minutes here is the
            cheapest checkpoint in the whole run.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium">3</span>
          <span>
            <span className="font-medium">Then it runs for ten to fifteen minutes</span> — scanning competitors,
            looking at every thumbnail, grouping topics, and writing the report. Roughly $4–5 an audit. You can
            leave the page; the run continues and appears in History.
          </span>
        </li>
      </ol>

      <div className="rounded-md border bg-background p-3 text-sm">
        <p className="mb-1 font-medium">Reading the numbers: “3.2x”</p>
        <p className="text-muted-foreground">
          Every score is against what that channel was <span className="font-medium">normally doing at the time</span>,
          not against its all-time average. 1.0x is exactly par for its moment; 3.2x means it did three times what
          its neighbours did. This matters because a growing channel makes its own past look like failure — on a
          flat average, more than half of a healthy catalogue reads as “underperforming”, which is just growth, not
          a finding.
        </p>
        <p className="mt-2 text-muted-foreground">
          <span className="font-medium">Videos newer than two weeks are shown but never judged</span>, and never
          offered for renaming. A video published this morning has not underperformed, it is just new.
        </p>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        The proposed titles are suggestions on this page. Nothing is ever changed on any channel — see the
        read-only note below.
      </p>
    </div>
  );
}

/**
 * Connecting a channel for the paid/organic split.
 *
 * States the limit plainly rather than burying it: this works for one channel —
 * whoever grants consent — and no tool can do it for anyone else's, because no
 * public API exposes another channel's paid views. Saying so here stops the
 * absence of the split on a teardown reading as a bug.
 */
function PaidOrganicPanel({ config }: { config: any }) {
  const params = new URLSearchParams(window.location.search);
  const flash = params.get('ytauth');
  if (!config) return null;

  return (
    <div className="mb-6 rounded-lg border p-4 text-sm">
      <div className="mb-1 flex items-center gap-2 font-medium">
        {config.analyticsConnected ? (
          <CheckCircle2 className="h-4 w-4 text-[hsl(var(--chart-3))]" />
        ) : (
          <AlertCircle className="h-4 w-4 text-muted-foreground" />
        )}
        Paid vs organic views
      </div>

      {flash === 'connected' && <p className="mb-2 text-[hsl(var(--chart-3))]">Channel connected.</p>}
      {flash === 'denied' && <p className="mb-2 text-muted-foreground">Consent was declined.</p>}
      {(flash === 'failed' || flash === 'norefresh') && (
        <p className="mb-2 text-destructive">That did not complete. Try connecting again.</p>
      )}
      {flash === 'scope' && (
        <p className="mb-2 text-destructive">
          That grant carried more than read-only analytics, so nothing was saved. This tool only ever reads.
        </p>
      )}

      {config.analyticsConnected ? (
        <>
          <p className="text-muted-foreground">
            Your channel is connected, so <span className="font-medium">your own</span> audits score on ORGANIC
            views — advertised views are separated out and never counted as evidence that a title worked.
          </p>
          <a href="/api/yt-oauth/disconnect" className="mt-2 inline-block text-xs text-muted-foreground underline">
            Disconnect
          </a>
        </>
      ) : config.analyticsConfigured ? (
        <>
          <p className="mb-2 text-muted-foreground">
            Connect your channel to separate advertised views from organic ones. Without it, a promoted video looks
            like a packaging win and the renamer will learn from a title that never earned its audience.
          </p>
          <a
            href="/api/yt-oauth/start"
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium"
          >
            Connect my channel (read-only)
          </a>
          <CallbackUrlHint />
        </>
      ) : (
        <p className="text-muted-foreground">
          Add a YouTube Analytics OAuth client ID and secret in Settings → Postiz to enable this.
        </p>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-medium">Read-only, enforced.</span> The connection asks for one scope —
        <code className="mx-1">yt-analytics.readonly</code>— and a grant carrying anything more is refused before
        it is saved. The token is only ever sent to the analytics reports endpoint, by GET. This tool cannot
        change a title, a description, a thumbnail or anything else on your channel; the renames it writes are
        text on this page for you to apply yourself.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        This only ever works for the channel that grants consent. No public API exposes another channel&apos;s
        paid/organic split, so a teardown of someone else&apos;s channel uses the engagement signal below instead.
      </p>
    </div>
  );
}

/**
 * The exact redirect URI Google must have registered.
 *
 * `redirect_uri_mismatch` is the first thing that goes wrong when setting this
 * up, and the error tells you nothing about what was expected. Google compares
 * the string exactly — a trailing slash or the wrong field on the credentials
 * page is enough — so the fix is to show the string and let it be copied rather
 * than retyped.
 */
function CallbackUrlHint() {
  const url = `${window.location.origin}/api/yt-oauth/callback`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 rounded-md border bg-background p-3">
      <p className="mb-1 text-xs text-muted-foreground">
        In the Google Cloud console this exact URL must be listed under{' '}
        <span className="font-medium">Authorised redirect URIs</span> (not JavaScript origins), on a{' '}
        <span className="font-medium">Web application</span> client:
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1 text-xs">{url}</code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="shrink-0 rounded-md border px-2 py-1 text-xs"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        No trailing slash. Changes can take a few minutes to take effect at Google&apos;s end.
      </p>
    </div>
  );
}

/**
 * The heuristic, for channels we cannot get real analytics for.
 *
 * Named for what it measures, not what it might imply. Calling this "paid
 * views" would be a guess about someone's spending dressed up as data.
 */
function EngagementSignalCard({ videos }: { videos: any[] }) {
  const pool = (videos || []).filter(
    (v: any) => v.judged && v.format === 'long' && v.views > 0 && (v.likes != null || v.comments != null),
  );
  if (pool.length < 5) return null;

  const rates = pool.map((v: any) => ((v.likes ?? 0) + (v.comments ?? 0)) / v.views).sort((a, b) => a - b);
  const med = rates[Math.floor(rates.length / 2)];
  if (!med) return null;

  const odd = pool
    .map((v: any) => ({ v, rate: ((v.likes ?? 0) + (v.comments ?? 0)) / v.views }))
    .filter((r) => r.v.eraMultiple >= 1.5 && r.rate <= med * 0.4)
    .sort((a, b) => a.rate - b.rate)
    .slice(0, 6);

  if (!odd.length) return null;

  return (
    <Card title="Unusual engagement ratio">
      <p className="mb-3 text-xs text-muted-foreground">
        These got far more views than this channel normally does, while likes and comments stayed flat. That is
        consistent with paid promotion — and equally consistent with a broad, casual audience.{' '}
        <span className="font-medium">It is a signal, not a verdict</span>: nobody outside a channel can see its
        paid/organic split.
      </p>
      <div className="space-y-1">
        {odd.map(({ v, rate }) => (
          <div key={v.videoId} className="flex items-center gap-3 rounded border px-3 py-2 text-sm">
            <span className="flex-1 truncate" title={v.title}>
              {v.title}
            </span>
            {v.paidViews != null ? (
              <span className="text-xs text-[hsl(var(--chart-3))]">
                {v.paidViews.toLocaleString()} paid / {(v.organicViews ?? 0).toLocaleString()} organic
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {(rate * 100).toFixed(2)}% engaged vs {(med * 100).toFixed(2)}% usual
              </span>
            )}
            <span className="text-xs text-muted-foreground">{v.eraMultiple.toFixed(1)}x</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * The banner saying the report is narrowed, and the way back out.
 *
 * A focus is a judgement, and judgements need to be reversible — the first real
 * one cut the report to twelve videos and there was no undo, which is why the
 * pre-focus findings are now kept.
 */
function FocusBanner({ run, onChanged }: { run: any; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const thin = run.focus.videoCount < 20;

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1">
          <span className="font-medium">This report is focused:</span> {run.focus.note} — computed over{' '}
          <span className="font-medium">
            {run.focus.videoCount} of {run.videos?.length}
          </span>{' '}
          videos. Nothing was deleted.
          {thin && (
            <div className="mt-1 text-xs text-muted-foreground">
              That is a small sample. Patterns need at least five videos each to be reported at all, so some
              sections may be empty — which means &ldquo;not enough evidence here&rdquo;, not &ldquo;nothing
              works&rdquo;.
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setReason(null);
            try {
              const r: any = await clearAuditFocus({ runId: run.runId });
              if (r.cleared) onChanged();
              else setReason(r.reason || 'Could not clear the focus.');
            } finally {
              setBusy(false);
            }
          }}
          className="shrink-0 rounded-md border bg-background px-2.5 py-1 text-xs"
        >
          {busy ? 'Restoring…' : 'Show the whole catalogue'}
        </button>
      </div>
      {reason && <p className="mt-2 text-xs text-muted-foreground">{reason}</p>}
    </div>
  );
}

/**
 * Talking to the report.
 *
 * The thing this exists for: a catalogue is a history, and a channel that has
 * changed direction gets a report about work its owner has moved on from. Only
 * they know that — so they say it here, and the findings are recomputed over
 * the part of the catalogue that still represents them. That recomputation is
 * arithmetic over data already stored, so it is one model call and no quota.
 */
function ReportChat({ run, onChanged }: { run: any; onChanged: () => void }) {
  const [messages, setMessages] = useState<any[]>(run.chat || []);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setMessages(run.chat || []), [run.runId, run.chat]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setErr(null);
    setBusy(true);
    // Show the question immediately; the answer can take a few seconds.
    setMessages((m) => [...m, { role: 'user', content: message, at: Date.now() }]);
    setDraft('');
    try {
      const res: any = await auditChat({ runId: run.runId, message });
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: res.reply, at: Date.now(), refocused: res.refocused ?? undefined },
      ]);
      // A refocus rewrote the findings, so the report above is now stale.
      if (res.refocused) onChanged();
    } catch (e: any) {
      setErr(String(e?.message || e));
      setMessages((m) => m.slice(0, -1));
      setDraft(message);
    } finally {
      setBusy(false);
    }
  }

  const suggestions = [
    'My focus changed — I now make AI tool reviews, not scraping tutorials',
    'Which of these findings is weakest evidence?',
    'What should I make next, and why?',
  ];

  return (
    <section className="rounded-lg border p-5">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <MessageSquare className="h-4 w-4" />
        Ask about this report
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Runs on Claude Opus 5 over this audit&apos;s saved data. If your channel has changed direction, say so — it
        can recompute the report over just the videos that still represent you, in seconds and at no quota cost.
      </p>

      {!!messages.length && (
        <div className="mb-3 space-y-3">
          {messages.map((m: any, i: number) => (
            <div key={i} className={m.role === 'user' ? 'text-sm' : 'text-sm'}>
              <div className="mb-0.5 text-xs font-medium text-muted-foreground">
                {m.role === 'user' ? 'You' : 'Claude'}
              </div>
              <div className={`whitespace-pre-wrap rounded-md p-2.5 ${m.role === 'user' ? 'bg-muted' : 'border'}`}>
                {m.content}
              </div>
              {m.refocused && (
                <div className="mt-1 text-xs text-[hsl(var(--chart-3))]">
                  Report re-aimed: {m.refocused.note} ({m.refocused.videoCount} videos)
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!messages.length && (
        <div className="mb-3 flex flex-wrap gap-2">
          {suggestions.map((sug) => (
            <button
              key={sug}
              type="button"
              onClick={() => send(sug)}
              disabled={busy}
              className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {sug}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
        className="flex gap-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What changed, or what do you want to know?"
          disabled={busy}
          className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !draft.trim()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </form>
      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
    </section>
  );
}

/**
 * How to become the best channel in each category.
 *
 * The last thing in the report and the only part that is instructions rather
 * than findings — so it sits after the evidence it cites, not before it.
 */
function ActionPlan({ plan }: { plan: any }) {
  return (
    <Card title="How to become the best in each category">
      <div className="space-y-4">
        {plan.categories.map((c: any, i: number) => (
          <div key={i} className="rounded-lg border p-4">
            <div className="mb-1 text-sm font-medium">{c.name}</div>
            {c.standing && <p className="text-sm text-muted-foreground">Where you are: {c.standing}</p>}
            {c.target && <p className="mt-1 text-sm">Best in category looks like: {c.target}</p>}

            {!!c.titleFormulas?.length && (
              <PlanList title="Title formulas" items={c.titleFormulas} mono />
            )}
            {!!c.thumbnails?.length && <PlanList title="Thumbnails" items={c.thumbnails} />}
            {!!c.topics?.length && <PlanList title="Videos to make" items={c.topics} />}
            {!!c.firstThree?.length && <PlanList title="The next three, in order" items={c.firstThree} ordered />}
          </div>
        ))}
      </div>

      {!!plan.ninetyDays?.length && (
        <div className="mt-4 rounded-lg border p-4">
          <div className="mb-2 text-sm font-medium">The next 90 days</div>
          <ol className="list-inside list-decimal space-y-1 text-sm">
            {plan.ninetyDays.map((sIt: string, i: number) => (
              <li key={i}>{sIt}</li>
            ))}
          </ol>
        </div>
      )}

      {!!plan.stopDoing?.length && (
        <div className="mt-4 rounded-lg border p-4">
          <div className="mb-2 text-sm font-medium">Stop doing</div>
          <ul className="list-inside list-disc space-y-1 text-sm">
            {plan.stopDoing.map((sIt: string, i: number) => (
              <li key={i}>{sIt}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function PlanList({
  title,
  items,
  mono,
  ordered,
}: {
  title: string;
  items: string[];
  mono?: boolean;
  ordered?: boolean;
}) {
  const List: any = ordered ? 'ol' : 'ul';
  return (
    <div className="mt-3">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <List className={`list-inside space-y-1 text-sm ${ordered ? 'list-decimal' : 'list-disc'}`}>
        {items.map((it, i) => (
          <li key={i} className={mono ? 'font-mono text-xs' : ''}>
            {it}
          </li>
        ))}
      </List>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-5">
      <h2 className="mb-3 text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function List({ title, items, tone }: { title: string; items: string[]; tone: 'up' | 'down' }) {
  const Icon = tone === 'up' ? TrendingUp : TrendingDown;
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <ul className="list-inside list-disc space-y-1 text-sm">
        {items?.map((s, i) => <li key={i}>{s}</li>)}
      </ul>
    </div>
  );
}

function PatternTable({ rows, tone }: { rows: any[]; tone: 'up' | 'down' }) {
  if (!rows?.length) return null;
  return (
    <div className="mb-3 space-y-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3 rounded border px-3 py-2 text-sm">
          <span className="flex-1">{r.pattern}</span>
          <span className={tone === 'up' ? 'text-[hsl(var(--chart-3))]' : 'text-destructive'}>
            {r.medianMultiple.toFixed(2)}x
          </span>
          <span className="text-xs text-muted-foreground">n={r.sampleSize}</span>
        </div>
      ))}
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warn'; children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div>{children}</div>
    </div>
  );
}
