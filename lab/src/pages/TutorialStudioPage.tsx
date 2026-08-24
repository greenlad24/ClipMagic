import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  tutorialStudioStatus,
  tutorialStudioJobs,
  tutorialStudioJob,
  tutorialStudioStart,
  tutorialStudioCancel,
  tutorialAvatars,
  type TutorialAvatar,
  type TutorialJob,
  type TutorialHealth,
} from 'zite-endpoints-sdk';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import AvatarLibrary, { avatarImageUrl } from '@/components/tutorial/AvatarLibrary';
import BatchWorkspace from '@/components/tutorial/BatchWorkspace';
import { Clapperboard, Loader2, RefreshCw, X } from 'lucide-react';

/**
 * Tutorial Studio — topic in, finished 9:16 talking-head tutorial reel out.
 *
 * The eight-stage pipeline lives in a Python sidecar (script → start frame →
 * Wan talking clip → whisper timings → carousel → slides/prompt screenshots →
 * overlays + memes + SFX → ffmpeg composite). This page only starts jobs and
 * follows them: one runs at a time, and a fresh one costs ~$2.45, so the cost
 * is stated up front rather than discovered on the invoice.
 */

const POLL_MS = 3000;

/** The paid stage is Wan; reusing a previous clip is the ~$2 saving. */
const COST_FRESH = '~$2.45';
const COST_REUSE = '~$0.40';

function statusTone(status: TutorialJob['status']): string {
  switch (status) {
    case 'done':
      return 'bg-green-500/15 text-green-400 border-green-500/30';
    case 'running':
      return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'queued':
      return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    case 'cancelled':
    case 'interrupted':
      return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
    default:
      return 'bg-red-500/15 text-red-400 border-red-500/30';
  }
}

function when(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString();
}

export default function TutorialStudioPage() {
  const [health, setHealth] = useState<TutorialHealth | null>(null);
  const [configured, setConfigured] = useState(true);
  const [reachable, setReachable] = useState(true);

  const [topic, setTopic] = useState('');
  const [outfit, setOutfit] = useState('');
  const [scene, setScene] = useState('');
  const [reuseBase, setReuseBase] = useState(false);
  const [starting, setStarting] = useState(false);
  const [avatars, setAvatars] = useState<TutorialAvatar[]>([]);
  const [avatarId, setAvatarId] = useState('');

  const [jobs, setJobs] = useState<TutorialJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [log, setLog] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await tutorialStudioStatus({});
      setConfigured(s.configured);
      setReachable(s.reachable);
      setHealth(s.health);
    } catch {
      setReachable(false);
    }
  }, []);

  const refreshJobs = useCallback(async () => {
    if (!configured) return;
    try {
      const { jobs: list } = await tutorialStudioJobs({});
      setJobs(list);
      setSelectedId((cur) => cur ?? list[0]?.id ?? null);
    } catch {
      /* unreachable is already surfaced by the status banner */
    }
  }, [configured]);

  const refreshAvatars = useCallback(async () => {
    try {
      const { avatars: list } = await tutorialAvatars({});
      setAvatars(list);
      // An avatar deleted elsewhere must not stay selected here.
      setAvatarId((cur) => (list.some((a) => a.id === cur) ? cur : ''));
    } catch {
      /* the library tab reports its own failures */
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshJobs();
    void refreshAvatars();
  }, [refreshStatus, refreshJobs, refreshAvatars]);

  // Follow the selected job. Polls only while something is actually moving, so
  // an idle page is quiet.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await tutorialStudioJob({ id: selectedId });
        if (cancelled) return;
        setLog(res.log);
        setJobs((cur) => cur.map((j) => (j.id === res.job.id ? res.job : j)));
        return res.job.status;
      } catch {
        return undefined;
      }
    };

    void tick();
    const id = window.setInterval(async () => {
      const status = await tick();
      if (status && status !== 'queued' && status !== 'running') {
        window.clearInterval(id);
        void refreshJobs();
        void refreshStatus();
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedId, refreshJobs, refreshStatus]);

  // Keep the log pinned to the newest line while a job is live.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const selected = jobs.find((j) => j.id === selectedId) || null;
  const busy = jobs.some((j) => j.status === 'running' || j.status === 'queued');

  async function start() {
    if (!topic.trim()) {
      toast.error('Give it a topic first.');
      return;
    }
    setStarting(true);
    try {
      const chosen = avatars.find((a) => a.id === avatarId);
      const { job } = await tutorialStudioStart({
        topic: topic.trim(),
        outfit: outfit.trim() || undefined,
        scene: scene.trim() || undefined,
        avatarId: avatarId || undefined,
        environment: chosen?.environment || undefined,
        reuseBase,
      });
      setJobs((cur) => [job, ...cur]);
      setSelectedId(job.id);
      setLog('');
      toast.success(busy ? 'Queued — one reel renders at a time.' : 'Rendering started.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the render.');
    } finally {
      setStarting(false);
    }
  }

  async function cancel(id: string) {
    try {
      await tutorialStudioCancel({ id });
      toast.success('Cancelled.');
      void refreshJobs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel.');
    }
  }

  return (
    <Layout>
      <div className="mx-auto w-full max-w-6xl px-4 py-8">
        <div className="mb-6 flex items-center gap-3">
          <Clapperboard className="h-7 w-7 text-chart-2" />
          <div>
            <h1 className="text-2xl font-bold">Tutorial Studio</h1>
            <p className="text-sm text-muted-foreground">
              A topic in, a finished 9:16 talking-head tutorial reel out — script, voice,
              carousel, screenshots, overlays, memes and SFX.
            </p>
          </div>
        </div>

        {!configured && (
          <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            Tutorial Studio isn't configured. Set <code>TUTORIAL_STUDIO_URL</code> and start the
            sidecar with <code>docker compose --profile lab up -d tutorial-studio</code>.
          </div>
        )}
        {configured && !reachable && (
          <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            The Tutorial Studio sidecar isn't answering. It may still be starting up, or it
            may have stopped — check <code>docker compose logs tutorial-studio</code>.
          </div>
        )}
        {health && !health.has_apimart && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm">
            <strong>No apimart API key yet.</strong> It drives the script, start-frame and
            talking-head stages, so no reel can render without it.{' '}
            <Link to="/settings/postiz" className="font-medium underline underline-offset-2">
              Add it in Settings
            </Link>{' '}
            — it takes effect on the next reel, with nothing to restart.
          </div>
        )}

        <Tabs defaultValue="single">
          <TabsList className="mb-6">
            <TabsTrigger value="single">Single reel</TabsTrigger>
            <TabsTrigger value="batches">Batches</TabsTrigger>
            <TabsTrigger value="avatars">Avatars</TabsTrigger>
          </TabsList>

          <TabsContent value="batches">
            <BatchWorkspace />
          </TabsContent>

          <TabsContent value="avatars">
            <AvatarLibrary onChange={() => void refreshAvatars()} />
          </TabsContent>

          <TabsContent value="single">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {/* ── Start a reel ── */}
          <div className="space-y-4 rounded-lg border border-border bg-card p-5">
            <div>
              <Label htmlFor="topic">What should she teach?</Label>
              <Textarea
                id="topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="how to make carousels with Claude"
                rows={2}
                className="mt-1.5"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                Phrased as the reel's promise — "how to &lt;thing&gt; with &lt;tool&gt;" is the
                shape the script generator expects.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="outfit">Outfit (optional)</Label>
                <Input
                  id="outfit"
                  value={outfit}
                  onChange={(e) => setOutfit(e.target.value)}
                  placeholder="a comfy cream knit sweater"
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="scene">Scene (optional)</Label>
                <Input
                  id="scene"
                  value={scene}
                  onChange={(e) => setScene(e.target.value)}
                  placeholder="a cozy living-room corner with a leafy plant"
                  className="mt-1.5"
                />
              </div>
            </div>

            <div>
              <Label>Avatar</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setAvatarId('')}
                  className={`rounded-md border px-3 py-2 text-xs ${
                    avatarId === '' ? 'border-primary bg-primary/10' : 'border-border'
                  }`}
                >
                  Packaged look
                </button>
                {avatars.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setAvatarId(a.id)}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs ${
                      avatarId === a.id ? 'border-primary bg-primary/10' : 'border-border'
                    }`}
                  >
                    <img src={avatarImageUrl(a.id)} alt="" className="h-8 w-8 rounded object-cover" />
                    <span className="max-w-[8rem] truncate">{a.name}</span>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Her face is held exactly as uploaded; the outfit and the corner of her room
                change every video. Upload one on the Avatars tab.
              </p>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 bg-background/40 p-3">
              <div>
                <div className="text-sm font-medium">Reuse the last talking-head</div>
                <p className="text-xs text-muted-foreground">
                  Skips the paid Wan stage and only swaps the teaching content.{' '}
                  {health?.has_base_clip
                    ? `${COST_REUSE} instead of ${COST_FRESH}.`
                    : 'No previous clip yet — the first reel has to be a fresh one.'}
                </p>
              </div>
              <Switch
                checked={reuseBase && Boolean(health?.has_base_clip)}
                disabled={!health?.has_base_clip}
                onCheckedChange={setReuseBase}
              />
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Cost:{' '}
                <strong className="text-foreground">
                  {reuseBase && health?.has_base_clip ? COST_REUSE : COST_FRESH}
                </strong>
              </span>
              <Button onClick={start} disabled={starting || !configured || !reachable}>
                {starting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting…
                  </>
                ) : (
                  'Render the reel'
                )}
              </Button>
            </div>
            {busy && (
              <p className="text-xs text-muted-foreground">
                One reel renders at a time — a new one waits its turn.
              </p>
            )}
          </div>

          {/* ── The selected job ── */}
          <div className="space-y-4 rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">
                {selected ? selected.topic : 'Nothing rendered yet'}
              </h2>
              <Button variant="ghost" size="sm" onClick={() => void refreshJobs()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>

            {selected && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={statusTone(selected.status)}>
                    {selected.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {when(selected.created_at)}
                  </span>
                  {(selected.status === 'running' || selected.status === 'queued') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => void cancel(selected.id)}
                    >
                      <X className="mr-1 h-3.5 w-3.5" /> Cancel
                    </Button>
                  )}
                </div>

                {selected.status === 'failed' && selected.error && (
                  <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs">
                    {selected.error}
                  </div>
                )}

                {selected.has_reel && (
                  <video
                    key={selected.id}
                    controls
                    className="mx-auto max-h-[520px] rounded-md border border-border bg-black"
                    src={`/api/tutorial/reel/${selected.id}.mp4`}
                  />
                )}

                <div>
                  <Label className="text-xs text-muted-foreground">Pipeline log</Label>
                  <pre
                    ref={logRef}
                    className="mt-1.5 max-h-72 overflow-auto rounded-md border border-border bg-background/60 p-3 text-[11px] leading-relaxed"
                  >
                    {log || 'Waiting for the first stage…'}
                  </pre>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── History ── */}
        {jobs.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-3 font-semibold">Previous reels</h2>
            <div className="space-y-2">
              {jobs.map((job) => (
                <button
                  key={job.id}
                  onClick={() => {
                    setSelectedId(job.id);
                    setLog('');
                  }}
                  className={`flex w-full items-center gap-3 rounded-md border p-3 text-left transition ${
                    job.id === selectedId
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <Badge variant="outline" className={statusTone(job.status)}>
                    {job.status}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm">{job.topic}</span>
                  {job.reuse_base && (
                    <span className="text-xs text-muted-foreground">reused base</span>
                  )}
                  <span className="text-xs text-muted-foreground">{when(job.created_at)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  );
}
