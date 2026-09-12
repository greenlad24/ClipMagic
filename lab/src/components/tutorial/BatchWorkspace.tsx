import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  tutorialAvatars,
  tutorialBatchList,
  tutorialBatchCreate,
  tutorialBatchGet,
  tutorialBatchDelete,
  tutorialBatchIdeas,
  tutorialBatchPick,
  tutorialBatchScripts,
  tutorialBatchItemUpdate,
  tutorialBatchItemRescript,
  tutorialBatchRender,
  tutorialStudioJobs,
  type TutorialAvatar,
  type TutorialBatch,
  type TutorialBatchItem,
  type TutorialJob,
  type TutorialVideoModel,
} from 'zite-endpoints-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, Lightbulb, PenLine, Clapperboard, RefreshCw, Trash2, Check } from 'lucide-react';
import { avatarImageUrl } from './AvatarLibrary';
import StudioPoster from './StudioPoster';

/**
 * A batch: one theme in, ~30 finished reels out.
 *
 * The order is deliberate — ideas, then scripts, then a human approval on each
 * one, and only then paid renders. Everything before the render button is text
 * and costs cents; the render button spends roughly $2.45 per approved script,
 * so it says so and counts what it is about to queue.
 */

/** Wan 3.0's reel: ~$2 of clip plus ~$0.45 of everything around it. */
const COST_PER_VIDEO = 2.45;
/** What a reel costs BEFORE the talking clip — the only stage that varies. */
const COST_WITHOUT_CLIP = 0.45;
const POLL_MS = 4000;

function itemTone(status: TutorialBatchItem['status']): string {
  switch (status) {
    case 'done':
      return 'bg-green-500/15 text-green-400 border-green-500/30';
    case 'rendering':
    case 'queued':
      return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'approved':
      return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'failed':
      return 'bg-red-500/15 text-red-400 border-red-500/30';
    default:
      return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
  }
}

export default function BatchWorkspace({ models = [] }: { models?: TutorialVideoModel[] }) {
  const [batches, setBatches] = useState<TutorialBatch[]>([]);
  const [avatars, setAvatars] = useState<TutorialAvatar[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [batch, setBatch] = useState<TutorialBatch | null>(null);
  const [items, setItems] = useState<TutorialBatchItem[]>([]);
  const [scripting, setScripting] = useState(false);
  const [jobs, setJobs] = useState<TutorialJob[]>([]);
  const [busy, setBusy] = useState<string>('');

  // new-batch form
  const [name, setName] = useState('');
  const [theme, setTheme] = useState('');
  const [avatarId, setAvatarId] = useState('');
  const [targetCount, setTargetCount] = useState(30);
  const [videoModel, setVideoModel] = useState('');
  const [videoResolution, setVideoResolution] = useState('');

  useEffect(() => {
    // Once, when the catalogue lands — never over a choice already made.
    setVideoModel((cur) => cur || models[0]?.id || '');
  }, [models]);

  // per-item script edits, kept local until saved
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const loadLists = useCallback(async () => {
    try {
      const [b, a] = await Promise.all([tutorialBatchList({}), tutorialAvatars({})]);
      setBatches(b.batches);
      setAvatars(a.avatars);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load batches.');
    }
  }, []);

  const loadBatch = useCallback(async (id: string) => {
    try {
      const res = await tutorialBatchGet({ id });
      setBatch(res.batch);
      setItems(res.items);
      setScripting(res.scripting);
      return res;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load that batch.');
      return null;
    }
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (!openId) return;
    void loadBatch(openId);
  }, [openId, loadBatch]);

  // Poll only while something is genuinely moving: scripts being written, or
  // renders in flight. An idle batch makes no requests.
  useEffect(() => {
    if (!openId) return;
    const live = scripting || items.some((i) => i.status === 'queued' || i.status === 'rendering');
    if (!live) return;
    const id = window.setInterval(async () => {
      await loadBatch(openId);
      try {
        const { jobs: list } = await tutorialStudioJobs({});
        setJobs(list);
      } catch {
        /* the reel list is a nicety here; the batch rows are the source of truth */
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [openId, scripting, items, loadBatch]);

  const avatar = avatars.find((a) => a.id === batch?.avatarId) || null;
  // Two different models are in play: the one the OPEN batch was created with
  // (fixed — its scripts were written for that clip length) and the one the NEW
  // batch form is offering.
  const batchModel = models.find((m) => m.id === batch?.videoModel) || models[0] || null;
  const newModel = models.find((m) => m.id === videoModel) || models[0] || null;
  const resolution = newModel
    ? newModel.resolutions.includes(videoResolution)
      ? videoResolution
      : newModel.defaultResolution
    : '';
  const picked = items.filter((i) => i.picked);
  const approved = items.filter((i) => i.approved);
  const scripted = picked.filter((i) => i.script);
  const renderable = approved.filter((i) => !i.jobId);
  const finished = items.filter((i) => i.jobId && jobStatus(i) === 'done');

  function jobStatus(item: TutorialBatchItem): string {
    return jobs.find((j) => j.id === item.jobId)?.status || item.status;
  }

  async function create() {
    if (!theme.trim()) {
      toast.error('Give the batch a theme.');
      return;
    }
    setBusy('create');
    try {
      const chosen = avatars.find((a) => a.id === avatarId);
      const { batch: b } = await tutorialBatchCreate({
        name: name.trim() || undefined,
        theme: theme.trim(),
        avatarId: avatarId || undefined,
        environment: chosen?.environment || undefined,
        targetCount,
        videoModel: videoModel || undefined,
        videoResolution: resolution || undefined,
      });
      setName('');
      setTheme('');
      await loadLists();
      setOpenId(b.id);
      toast.success('Batch created — propose some ideas next.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the batch.');
    } finally {
      setBusy('');
    }
  }

  async function ideas() {
    if (!batch) return;
    setBusy('ideas');
    try {
      const res = await tutorialBatchIdeas({ id: batch.id });
      setItems(res.items);
      if (res.batch) setBatch(res.batch);
      toast.success(`${res.items.length} ideas — pick the ones you want.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not propose ideas.');
    } finally {
      setBusy('');
    }
  }

  async function togglePick(item: TutorialBatchItem) {
    if (!batch) return;
    const next = items.map((i) => (i.id === item.id ? { ...i, picked: !i.picked } : i));
    setItems(next);
    try {
      const res = await tutorialBatchPick({
        id: batch.id,
        itemIds: next.filter((i) => i.picked).map((i) => i.id),
      });
      setItems(res.items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save your picks.');
      void loadBatch(batch.id);
    }
  }

  async function writeScripts() {
    if (!batch) return;
    setBusy('scripts');
    try {
      const res = await tutorialBatchScripts({ id: batch.id });
      setScripting(true);
      toast.success(
        res.pending
          ? `Writing ${res.pending} script${res.pending === 1 ? '' : 's'} — this takes a few minutes.`
          : 'Every picked idea already has a script.',
      );
      void loadBatch(batch.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start scripting.');
    } finally {
      setBusy('');
    }
  }

  async function saveScript(item: TutorialBatchItem, approve: boolean) {
    const text = drafts[item.id];
    try {
      const res = await tutorialBatchItemUpdate({
        itemId: item.id,
        script: text !== undefined ? { ...(item.script || {}), script: text } : undefined,
        approved: approve,
      });
      if (res.item) {
        setItems((cur) => cur.map((i) => (i.id === res.item!.id ? res.item! : i)));
        setDrafts((d) => {
          const { [item.id]: _drop, ...rest } = d;
          return rest;
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    }
  }

  async function rescript(item: TutorialBatchItem) {
    setBusy(item.id);
    try {
      const res = await tutorialBatchItemRescript({ itemId: item.id });
      if (res.item) setItems((cur) => cur.map((i) => (i.id === res.item!.id ? res.item! : i)));
      toast.success('Rewritten.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rewrite it.');
    } finally {
      setBusy('');
    }
  }

  async function render() {
    if (!batch || !renderable.length) return;
    // Only Wan has a published rate. For anything else, promising a number
    // would be inventing one — say what is known instead.
    const spend =
      batchModel && batchModel.id !== 'wan3.0-video'
        ? `at least $${(renderable.length * COST_WITHOUT_CLIP).toFixed(2)} plus ` +
          `${renderable.length} ${batchModel.label} clip${renderable.length === 1 ? '' : 's'} ` +
          '(apimart publishes no rate for it — the finished job reports what it charged)'
        : `roughly $${(renderable.length * COST_PER_VIDEO).toFixed(2)}`;
    if (
      !window.confirm(
        `Render ${renderable.length} reel${renderable.length === 1 ? '' : 's'}?\n\n` +
          `This spends ${spend} and renders one at a time, so it will take a while.`,
      )
    ) {
      return;
    }
    setBusy('render');
    try {
      const res = await tutorialBatchRender({ id: batch.id });
      toast.success(`Queued ${res.queued} reel${res.queued === 1 ? '' : 's'}.`);
      if (res.failures.length) {
        toast.error(`${res.failures.length} could not be queued — see the rows.`);
      }
      await loadBatch(batch.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue the renders.');
    } finally {
      setBusy('');
    }
  }

  async function removeBatch(b: TutorialBatch) {
    if (!window.confirm(`Delete "${b.name}"? Reels already rendered are kept.`)) return;
    try {
      await tutorialBatchDelete({ id: b.id });
      if (openId === b.id) {
        setOpenId(null);
        setBatch(null);
        setItems([]);
      }
      await loadLists();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    }
  }

  // ── batch list + new batch ────────────────────────────────────────────────
  if (!openId || !batch) {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-1 font-medium">New batch</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            A theme becomes a list of video ideas. You pick the ones worth making, the scripts
            get written for you, and nothing renders until you approve them.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="b-name">Name (optional)</Label>
              <Input id="b-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="March drop" />
            </div>
            <div>
              <Label htmlFor="b-count">How many videos</Label>
              <Input
                id="b-count"
                type="number"
                min={1}
                max={60}
                value={targetCount}
                onChange={(e) => setTargetCount(Number(e.target.value) || 30)}
              />
            </div>
          </div>
          <div className="mt-3">
            <Label htmlFor="b-theme">Theme</Label>
            <Textarea
              id="b-theme"
              rows={2}
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              placeholder="e.g. practical ChatGPT workflows for small e-commerce shops"
            />
          </div>
          <div className="mt-3">
            <Label>Talking-head model</Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setVideoModel(m.id)}
                  className={`rounded-md border px-3 py-2 text-left text-xs ${
                    newModel?.id === m.id ? 'border-primary bg-primary/10' : 'border-border'
                  }`}
                >
                  <div className="font-medium">{m.label}</div>
                  <div className="text-muted-foreground">{m.seconds}s reels</div>
                </button>
              ))}
              {newModel?.resolutions.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setVideoResolution(r)}
                  className={`self-center rounded-md border px-2 py-1 text-xs ${
                    resolution === r ? 'border-primary bg-primary/10' : 'border-border'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Fixed for the whole batch: it sets every clip's length, and the ideas and
              scripts are written for that length. {newModel?.note}
            </p>
          </div>

          <div className="mt-3">
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
                  <span className="max-w-[10rem] truncate">{a.name}</span>
                </button>
              ))}
            </div>
            {avatars.length === 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                No avatars uploaded yet — the batch will use the packaged creator look.
              </p>
            )}
          </div>
          <Button className="mt-4" onClick={create} disabled={busy === 'create'}>
            {busy === 'create' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create batch
          </Button>
        </div>

        <div className="space-y-2">
          {batches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No batches yet.</p>
          ) : (
            batches.map((b) => (
              <div
                key={b.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
              >
                <button className="min-w-0 flex-1 text-left" onClick={() => setOpenId(b.id)}>
                  <div className="truncate font-medium">{b.name || b.theme}</div>
                  <div className="truncate text-xs text-muted-foreground">{b.theme}</div>
                </button>
                <Badge variant="outline">{b.status}</Badge>
                <Button variant="ghost" size="sm" onClick={() => removeBatch(b)}>
                  <Trash2 className="h-4 w-4 text-red-400" />
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // ── one batch ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button className="text-xs text-muted-foreground underline" onClick={() => setOpenId(null)}>
            ← All batches
          </button>
          <h3 className="truncate text-lg font-semibold">{batch.name || batch.theme}</h3>
          <p className="text-sm text-muted-foreground">{batch.theme}</p>
        </div>
        {avatar && (
          <div className="flex items-center gap-2">
            <img src={avatarImageUrl(avatar.id)} alt="" className="h-10 w-10 rounded object-cover" />
            <div className="text-xs">
              <div className="font-medium">{avatar.name}</div>
              <div className="text-muted-foreground">same room every video</div>
            </div>
          </div>
        )}
      </div>

      {batch.error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          {batch.error}
        </div>
      )}

      {/* Step 1 — ideas */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-amber-400" />
            <span className="font-medium">1. Ideas</span>
            {items.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {picked.length} of {items.length} picked
              </span>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={ideas} disabled={busy === 'ideas'}>
            {busy === 'ideas' ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {items.length ? 'Propose again' : 'Propose ideas'}
          </Button>
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No ideas yet. Proposing replaces the list, so pick before you re-run.
          </p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {items.map((i) => (
              <label
                key={i.id}
                className="flex cursor-pointer items-start gap-2 rounded-md p-2 text-sm hover:bg-background/40"
              >
                <input
                  type="checkbox"
                  checked={i.picked}
                  onChange={() => togglePick(i)}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{i.topic}</span>
                  {i.hook && <span className="block text-xs text-muted-foreground">{i.hook}</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Step 2 — scripts */}
      {picked.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <PenLine className="h-4 w-4 text-blue-400" />
              <span className="font-medium">2. Scripts</span>
              <span className="text-xs text-muted-foreground">
                {scripted.length} of {picked.length} written · {approved.length} approved
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={writeScripts} disabled={scripting || busy === 'scripts'}>
              {scripting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Writing…
                </>
              ) : (
                'Write the missing scripts'
              )}
            </Button>
          </div>

          <div className="space-y-3">
            {picked.map((i) => (
              <div key={i.id} className="rounded-md border border-border/60 p-3">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{i.topic}</div>
                    {i.error && <div className="text-xs text-red-400">{i.error}</div>}
                  </div>
                  <Badge variant="outline" className={itemTone(i.status)}>
                    {jobStatus(i)}
                  </Badge>
                </div>
                {i.script ? (
                  <>
                    <Textarea
                      rows={4}
                      className="text-xs"
                      value={drafts[i.id] ?? String(i.script.script || '')}
                      onChange={(e) => setDrafts((d) => ({ ...d, [i.id]: e.target.value }))}
                      disabled={Boolean(i.jobId)}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {!i.jobId && (
                        <>
                          <Button size="sm" onClick={() => saveScript(i, true)}>
                            <Check className="mr-2 h-3.5 w-3.5" />
                            {i.approved ? 'Approved' : 'Approve'}
                          </Button>
                          {i.approved && (
                            <Button size="sm" variant="ghost" onClick={() => saveScript(i, false)}>
                              Un-approve
                            </Button>
                          )}
                          {drafts[i.id] !== undefined && (
                            <Button size="sm" variant="outline" onClick={() => saveScript(i, i.approved)}>
                              Save edit
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => rescript(i)}
                            disabled={busy === i.id}
                          >
                            {busy === i.id ? (
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="mr-2 h-3.5 w-3.5" />
                            )}
                            Rewrite
                          </Button>
                        </>
                      )}
                      {i.outfit && (
                        <span className="text-xs text-muted-foreground">· {i.outfit}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {scripting ? 'Waiting for its turn…' : 'No script yet.'}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Step 3 — render */}
      {approved.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Clapperboard className="h-4 w-4 text-chart-2" />
              <span className="font-medium">3. Render</span>
              <span className="text-xs text-muted-foreground">
                {renderable.length} approved and not yet queued
              </span>
            </div>
            <Button onClick={render} disabled={!renderable.length || busy === 'render'}>
              {busy === 'render' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Render {renderable.length}
              {batchModel && batchModel.id !== 'wan3.0-video'
                ? ` · ${batchModel.label}`
                : ` · ~$${(renderable.length * COST_PER_VIDEO).toFixed(2)}`}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Reels render one at a time, so a full batch takes hours. Each one gets its own
            outfit and its own corner of {avatar ? 'the avatar’s room' : 'the packaged room'}.
          </p>
        </div>
      )}

      {/* Step 4 — post */}
      {finished.length > 0 && (
        <StudioPoster items={finished} onPosted={() => void loadBatch(batch.id)} />
      )}
    </div>
  );
}
