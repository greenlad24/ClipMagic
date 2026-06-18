import { useEffect, useRef, useState } from 'react';
import { useAuth } from 'zite-auth-sdk';
import {
  thumbnailStatus,
  analyzeThumbnailScript,
  searchThumbnails,
  startThumbnailGeneration,
  startContrarianGeneration,
  generateThumbnailTitles,
  planThumbnailContrarian,
  planThumbnailRecreations,
  thumbnailJobStatus,
  uploadThumbnailCharacter,
  deleteThumbnailCharacter,
  uploadThumbnailBackground,
  deleteThumbnailBackground,
  uploadThumbnailFont,
  deleteThumbnailFont,
  type ThumbnailStatusOutputType,
  type ThumbnailCharacterState,
  type ThumbnailBackgroundState,
  type ThumbnailVideoType,
  type ThumbnailMode,
  type ThumbnailSearchResult,
  type ThumbnailJobStatus,
  type ThumbnailJobVariant,
  type ThumbnailProviderResult,
  type ThumbnailTitles,
  type PlannedContrarian,
  type RecreationPlan,
} from 'zite-endpoints-sdk';
import { toast } from 'sonner';
import Layout from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Link } from 'react-router-dom';
import {
  Image as ImageIcon,
  Upload,
  Trash2,
  Search,
  Sparkles,
  Loader2,
  Download,
  CheckCircle2,
  KeyRound,
  AlertTriangle,
  Settings,
  Wand2,
  FileText,
  Type,
} from 'lucide-react';

/**
 * Thumbnail Designer (LAB) — recreate top YouTube thumbnails with the user's
 * character via the Nano Banana editing chain.
 *
 * Gated behind: both API keys configured (Gemini + YouTube, set write-only in
 * Settings → Thumbnail Designer) AND ≥1 character expression uploaded. Three
 * sections: (1) Character library, (2) Create (paste script → analyze → search →
 * multi-select → generate), (3) Results (original vs generated thumbnails).
 */

const VIDEO_TYPES: ThumbnailVideoType[] = ['Tutorial', 'Viral', 'Secret', 'Review'];

/**
 * Generation modes offered in the generate UI — a single image model per run.
 * The DEFAULT is Nano Banana Pro at 4K (sharpest, best likeness); the cheaper
 * Flash model is there for drafts and high volume.
 */
const MODE_OPTIONS: { value: ThumbnailMode; label: string; hint: string }[] = [
  { value: 'gemini-pro', label: 'Nano Banana Pro (sharpest, best likeness)', hint: 'Highest quality — 4K renders, strongest face match. ~$0.24/image, and the chain runs several edits per thumbnail.' },
  { value: 'gemini-flash', label: 'Nano Banana (Flash, cheap)', hint: 'Fast and inexpensive — good for drafts and high volume.' },
];

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.replace(/^data:[^,]+,/, ''));
    };
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(file);
  });
}

export default function ThumbnailDesignerPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<ThumbnailStatusOutputType | null>(null);

  // Create flow
  const [script, setScript] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzed, setAnalyzed] = useState(false);
  const [rationale, setRationale] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [videoType, setVideoType] = useState<ThumbnailVideoType>('Tutorial');
  // Titles + contrarian copy review (the intermediate step before generation).
  const [titles, setTitles] = useState<ThumbnailTitles | null>(null);
  const [contrarianDraft, setContrarianDraft] = useState<PlannedContrarian[] | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  // Workflow-1 per-thumbnail review: the AI's choices (cast + background + text),
  // editable before generation. Invalidated whenever the picks change.
  const [recreationPlans, setRecreationPlans] = useState<RecreationPlan[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ThumbnailSearchResult[] | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [mode, setMode] = useState<ThumbnailMode>('gemini-pro');
  const [generating, setGenerating] = useState(false);
  const [job, setJob] = useState<ThumbnailJobStatus | null>(null);
  // Contrarian originals run IN PARALLEL with the recreation job, polled separately.
  const [contrarianJob, setContrarianJob] = useState<ThumbnailJobStatus | null>(null);

  // Poll lifecycle: one interval per job, always cleared on done/unmount/restart.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const contrarianPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (contrarianPollRef.current) {
      clearInterval(contrarianPollRef.current);
      contrarianPollRef.current = null;
    }
  };

  /** Poll a job id until done, pushing snapshots into setSnap. */
  const pollJob = (
    jobId: string,
    ref: React.MutableRefObject<ReturnType<typeof setInterval> | null>,
    setSnap: (s: ThumbnailJobStatus | null) => void,
    onDone?: (s: ThumbnailJobStatus) => void,
  ) => {
    const tick = async () => {
      try {
        const snap = await thumbnailJobStatus({ jobId });
        setSnap(snap);
        if (snap.done) {
          if (ref.current) {
            clearInterval(ref.current);
            ref.current = null;
          }
          onDone?.(snap);
        }
      } catch {
        if (ref.current) {
          clearInterval(ref.current);
          ref.current = null;
        }
      }
    };
    ref.current = setInterval(() => void tick(), 1200);
    void tick();
  };

  const loadStatus = () =>
    thumbnailStatus({})
      .then(setStatus)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load Thumbnail Designer status'));

  useEffect(() => {
    if (!user) return;
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Always stop polling when the page unmounts.
  useEffect(() => () => stopPolling(), []);

  const keysReady = !!status?.geminiConfigured && !!status?.youtubeConfigured;
  const hasCharacter = (status?.uploadedExpressions?.length ?? 0) > 0;
  const ready = keysReady && hasCharacter;

  const togglePick = (videoId: string) => {
    // Changing the selection invalidates any reviewed plan (it's per-pick).
    setRecreationPlans(null);
    setPicks((prev) =>
      prev.includes(videoId) ? prev.filter((id) => id !== videoId) : [...prev, videoId],
    );
  };

  /** Load the AI's per-thumbnail choices (cast + background + text) for review. */
  const reviewChoices = async () => {
    if (picks.length === 0) {
      toast.info('Pick at least one thumbnail first.');
      return;
    }
    setPlanning(true);
    try {
      const titleList = [...(titles?.viral ?? []), ...(titles?.seo ?? [])];
      const { plans } = await planThumbnailRecreations({ keyword: keyword.trim(), videoType, picks, titles: titleList });
      setRecreationPlans(plans);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load the thumbnail choices');
    } finally {
      setPlanning(false);
    }
  };

  const editPlan = (videoId: string, patch: Partial<RecreationPlan>) =>
    setRecreationPlans((prev) => (prev ? prev.map((p) => (p.videoId === videoId ? { ...p, ...patch } : p)) : prev));
  const setPlanRewrites = (videoId: string, rewrites: RecreationPlan['rewrites']) => editPlan(videoId, { rewrites });

  const onAnalyze = async () => {
    if (!script.trim()) {
      toast.info('Paste your video script to analyze.');
      return;
    }
    setAnalyzing(true);
    setResults(null);
    setPicks([]);
    stopPolling();
    setJob(null);
    try {
      const analysis = await analyzeThumbnailScript({ script: script.trim() });
      setKeyword(analysis.keyword);
      setVideoType(analysis.videoType);
      setRationale(analysis.rationale ?? null);
      setAnalyzed(true);
      toast.success('Script analyzed — review the keyword and video type, then search.');
      // Kick off the titles + contrarian-copy planning step (non-blocking).
      void prepareCopy(analysis.keyword);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not analyze the script');
    } finally {
      setAnalyzing(false);
    }
  };

  /** Generate the viral/SEO titles + the proposed contrarian copy for review. */
  const prepareCopy = async (kw: string) => {
    const scriptText = script.trim();
    if (!scriptText || !kw.trim()) return;
    setDraftLoading(true);
    setTitles(null);
    setContrarianDraft(null);
    try {
      const { titles: t } = await generateThumbnailTitles({ script: scriptText });
      setTitles(t);
      // The contrarian review only applies when a character + background exist.
      const hasBg = (status?.uploadedBackgrounds?.length ?? 0) > 0;
      const hasChar = (status?.uploadedExpressions?.length ?? 0) > 0;
      if (hasBg && hasChar) {
        const titleList = [...(t?.viral ?? []), ...(t?.seo ?? [])];
        const { variations } = await planThumbnailContrarian({ keyword: kw.trim(), titles: titleList, script: scriptText });
        setContrarianDraft(variations);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not prepare titles/copy');
    } finally {
      setDraftLoading(false);
    }
  };

  const editDraft = (i: number, patch: Partial<PlannedContrarian>) => {
    setContrarianDraft((prev) => (prev ? prev.map((v, idx) => (idx === i ? { ...v, ...patch } : v)) : prev));
  };

  const onSearch = async () => {
    if (!keyword.trim()) {
      toast.info('Enter a keyword to search.');
      return;
    }
    setSearching(true);
    setResults(null);
    setPicks([]);
    stopPolling();
    setJob(null);
    try {
      const { results } = await searchThumbnails({ keyword: keyword.trim() });
      setResults(results);
      if (results.length === 0) toast.info('No long-form videos found for that keyword.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  // Start generation, then POLL the job for live progress until it's done.
  // Each thumbnail's finished image lands the moment that variant completes, so
  // the results fill in one by one instead of all at the end.
  const hasBackground = (status?.uploadedBackgrounds?.length ?? 0) > 0;

  const onGenerate = async () => {
    if (picks.length === 0) {
      toast.info('Pick at least one thumbnail to recreate.');
      return;
    }
    stopPolling();
    setGenerating(true);
    setJob(null);
    setContrarianJob(null);

    // Kick off the CONTRARIAN ORIGINALS workflow IN PARALLEL (needs a background +
    // character). Uses the reviewed/edited copy + the titles for grounding.
    if (hasBackground && hasCharacter && keyword.trim()) {
      const titleList = [...(titles?.viral ?? []), ...(titles?.seo ?? [])];
      startContrarianGeneration({
        keyword: keyword.trim(),
        mode,
        titles: titleList,
        script: script.trim() || undefined,
        variations: contrarianDraft ?? undefined,
      })
        .then(({ jobId }) => pollJob(jobId, contrarianPollRef, setContrarianJob))
        .catch((e) => toast.error(e instanceof Error ? e.message : 'Contrarian originals failed to start'));
    }

    try {
      const { jobId } = await startThumbnailGeneration({
        keyword: keyword.trim(),
        videoType,
        picks,
        mode,
        // Send the reviewed/edited choices when they match the current picks.
        plans:
          recreationPlans && recreationPlans.length === picks.length && recreationPlans.every((p) => picks.includes(p.videoId))
            ? recreationPlans
            : undefined,
      });
      pollJob(jobId, pollRef, setJob, (snap) => {
        setGenerating(false);
        if (snap.error) {
          toast.error(snap.error);
          return;
        }
        const ok = snap.variants.filter((v) => v.outputUrl).length;
        if (ok === 0) toast.error('No thumbnails could be generated — see the per-item errors below.');
        else toast.success(`Generated ${ok} thumbnail${ok === 1 ? '' : 's'}.`);
      });
    } catch (e) {
      setGenerating(false);
      toast.error(e instanceof Error ? e.message : 'Thumbnail generation failed');
    }
  };

  return (
    <Layout breadcrumb="Thumbnail Designer">
      <div className="px-6 py-8 max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-[hsl(var(--chart-4))]/10 p-2.5">
            <ImageIcon className="w-6 h-6 text-[hsl(var(--chart-4))]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Thumbnail Designer</h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Paste your script and recreate top-performing YouTube thumbnails with your own character — and, when you've uploaded backgrounds, also get 3 original "contrarian statement" thumbnails in parallel.
            </p>
          </div>
        </div>

        {!status ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <>
            {/* Keys gate */}
            {!keysReady && <KeysGate status={status} />}

            {/* Character library */}
            <CharacterLibrary status={status} onChanged={loadStatus} />

            {/* Background library (optional) */}
            <BackgroundLibrary status={status} onChanged={loadStatus} />

            {/* Headline font for the contrarian originals */}
            <FontUploader status={status} onChanged={loadStatus} />

            {/* Create */}
            {ready ? (
              <section className="rounded-xl border border-border bg-card p-5 space-y-5">
                <SectionHeader icon={<Wand2 className="w-4 h-4" />} title="Create" subtitle="Paste your script, confirm the keyword and type, then pick thumbnails to recreate." />

                {/* Step 1 — paste the script, analyze it */}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" /> Your video script
                  </label>
                  <Textarea
                    value={script}
                    onChange={(e) => setScript(e.target.value)}
                    placeholder="Paste your full video script here. We'll pull out the best search keyword and figure out the video type for you."
                    rows={6}
                    className="resize-y"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-muted-foreground">
                      We read the script to extract the keyword and infer the video type — you can edit both before searching.
                    </p>
                    <Button onClick={onAnalyze} disabled={analyzing || !script.trim()} variant={analyzed ? 'outline' : 'default'} size="sm" className="shrink-0">
                      {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      {analyzed ? 'Re-analyze' : 'Analyze'}
                    </Button>
                  </div>
                </div>

                {/* Step 2 — confirm keyword + type (pre-filled, editable), then search */}
                {analyzed && (
                  <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                    {rationale && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Why:</span> {rationale}
                      </p>
                    )}
                    <div className="flex flex-col sm:flex-row gap-3">
                      <div className="flex-1">
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Keyword / topic</label>
                        <Input
                          value={keyword}
                          onChange={(e) => setKeyword(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && onSearch()}
                          placeholder="e.g. how to edit videos with AI"
                        />
                      </div>
                      <div className="sm:w-48">
                        <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Video type</label>
                        <Select value={videoType} onValueChange={(v) => setVideoType(v as ThumbnailVideoType)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {VIDEO_TYPES.map((t) => (
                              <SelectItem key={t} value={t}>
                                {t}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-end">
                        <Button onClick={onSearch} disabled={searching || !keyword.trim()} className="w-full sm:w-auto">
                          {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                          Search
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Titles + contrarian copy review (the intermediate step) */}
                {analyzed && (draftLoading || titles || contrarianDraft) && (
                  <CopyReview
                    titles={titles}
                    draft={contrarianDraft}
                    loading={draftLoading}
                    onEdit={editDraft}
                    onRegenerate={() => void prepareCopy(keyword)}
                  />
                )}

                {/* Search results grid */}
                {searching && (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="aspect-video w-full rounded-lg" />
                    ))}
                  </div>
                )}
                {results && results.length > 0 && !searching && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        Top {results.length} most-viewed (long-form). Select any you want to recreate.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {picks.length} selected
                      </p>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                      {results.map((r) => {
                        const selected = picks.includes(r.videoId);
                        return (
                          <button
                            key={r.videoId}
                            onClick={() => togglePick(r.videoId)}
                            className={`group relative text-left rounded-lg overflow-hidden border-2 transition-colors ${
                              selected ? 'border-primary' : 'border-border hover:border-muted-foreground/40'
                            }`}
                          >
                            <div className="aspect-video bg-muted">
                              <img
                                src={r.thumbnailUrl}
                                alt={r.title}
                                loading="lazy"
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  (e.currentTarget as HTMLImageElement).src = `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`;
                                }}
                              />
                            </div>
                            {selected && (
                              <div className="absolute top-2 right-2 rounded-full bg-primary text-primary-foreground p-1">
                                <CheckCircle2 className="w-4 h-4" />
                              </div>
                            )}
                            <p className="text-xs text-foreground/90 line-clamp-2 p-2">{r.title}</p>
                          </button>
                        );
                      })}
                    </div>
                    {/* Mode selector — which single image model to generate with. */}
                    <div className="space-y-1.5 sm:max-w-md">
                      <label className="text-xs font-medium text-muted-foreground block">Image model</label>
                      <Select value={mode} onValueChange={(v) => setMode(v as ThumbnailMode)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MODE_OPTIONS.map((m) => (
                            <SelectItem key={m.value} value={m.value}>
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        {MODE_OPTIONS.find((m) => m.value === mode)?.hint}
                      </p>
                    </div>
                    {/* Cost estimate — scales with how many thumbnails you pick. */}
                    {picks.length > 0 && (
                      <CostHint mode={mode} picks={picks.length} />
                    )}
                    {/* Per-thumbnail review: edit the AI's choices before generating. */}
                    {picks.length > 0 && status && (
                      <RecreationReview
                        plans={recreationPlans}
                        planning={planning}
                        status={status}
                        onReview={reviewChoices}
                        onEditPlan={editPlan}
                        onSetRewrites={setPlanRewrites}
                      />
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={onGenerate} disabled={generating || picks.length === 0} className="w-full sm:w-auto">
                        {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                        Generate {picks.length > 0 ? `${picks.length} ` : ''}thumbnail{picks.length === 1 ? '' : 's'}
                      </Button>
                    </div>
                  </div>
                )}
                {results && results.length === 0 && !searching && (
                  <p className="text-sm text-muted-foreground py-4 text-center">No long-form videos found. Try a different keyword.</p>
                )}
              </section>
            ) : (
              keysReady &&
              !hasCharacter && (
                <p className="text-sm text-muted-foreground">
                  Upload at least one character expression above to start creating thumbnails.
                </p>
              )
            )}

            {/* Results — live progress while generating, then the finished grid */}
            {(generating || job) && <Results generating={generating} job={job} />}

            {/* Contrarian originals — the parallel workflow's 3 from-scratch thumbnails */}
            {contrarianJob && (
              <Results
                generating={!contrarianJob.done}
                job={contrarianJob}
                title="Contrarian originals"
                subtitle="3 original thumbnails built from your background + character + a bold contrarian statement (no money claims)."
              />
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

/**
 * Rough cost/time hint. Each thumbnail runs a multi-step chain on the chosen
 * model — Nano Banana Pro at 4K is ≈ $0.24/image across several edits; Flash is
 * cheaper. Cost and time scale with how many thumbnails you pick.
 */
function CostHint({ mode, picks }: { mode: ThumbnailMode; picks: number }) {
  const model = mode === 'gemini-pro' ? 'Nano Banana Pro at 4K (≈ $0.24/image)' : 'Nano Banana Flash (cheaper)';
  return (
    <p className="text-[11px] text-muted-foreground">
      Each of your {picks} selected thumbnail{picks === 1 ? '' : 's'} is recreated on {model} — the chain runs several
      edits each, so time and cost scale with the number you pick.
    </p>
  );
}

function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="rounded-md bg-muted p-1.5 text-muted-foreground mt-0.5">{icon}</div>
      <div>
        <h2 className="font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

function KeysGate({ status }: { status: ThumbnailStatusOutputType }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-[hsl(var(--chart-5))]/10 p-2 text-[hsl(var(--chart-5))]">
          <KeyRound className="w-4 h-4" />
        </div>
        <div className="flex-1">
          <h2 className="font-semibold text-foreground">Connect your API keys</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            The Thumbnail Designer needs a Gemini key (Nano Banana image editing) and a YouTube Data API key (thumbnail search). They're stored write-only on the server.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Badge variant={status.geminiConfigured ? 'default' : 'secondary'} className="gap-1">
              {status.geminiConfigured ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              Gemini {status.geminiConfigured ? 'connected' : 'not set'}
            </Badge>
            <Badge variant={status.youtubeConfigured ? 'default' : 'secondary'} className="gap-1">
              {status.youtubeConfigured ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
              YouTube {status.youtubeConfigured ? 'connected' : 'not set'}
            </Badge>
            <Button asChild variant="outline" size="sm" className="ml-auto">
              <Link to="/settings/postiz">
                <Settings className="w-4 h-4" />
                Configure keys
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function CharacterLibrary({
  status,
  onChanged,
}: {
  status: ThumbnailStatusOutputType;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const customInput = useRef<HTMLInputElement | null>(null);

  const upload = async (c: ThumbnailCharacterState, file: File) => {
    setBusy(c.id);
    try {
      const imageBase64 = await fileToBase64(file);
      await uploadThumbnailCharacter({ id: c.id, imageBase64 });
      toast.success(`Saved your "${c.label}" expression.`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: ThumbnailCharacterState) => {
    setBusy(c.id);
    try {
      await deleteThumbnailCharacter({ id: c.id });
      toast.success(`Removed your "${c.label}" expression.`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const addCustom = async (file: File) => {
    const name = newName.trim();
    if (!name) {
      toast.error('Give the expression a name first (e.g. "Pointing").');
      return;
    }
    setBusy('__new__');
    try {
      const imageBase64 = await fileToBase64(file);
      await uploadThumbnailCharacter({ name, imageBase64 });
      toast.success(`Added your "${name}" expression.`);
      setNewName('');
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(null);
    }
  };

  const none = status.characters.every((c) => !c.uploaded);

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <SectionHeader
        icon={<ImageIcon className="w-4 h-4" />}
        title="Character library"
        subtitle="Upload your face once per expression — four built-in slots plus any custom expressions you add. The AI picks the best fit per thumbnail."
      />
      {none && (
        <p className="text-xs text-muted-foreground">
          Upload at least one clear, well-lit portrait of yourself. The four built-in expressions map to video types; you can also add your own named expressions below.
        </p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {status.characters.map((c) => (
          <CharacterCard
            key={c.id}
            character={c}
            busy={busy === c.id}
            onPick={() => inputs.current[c.id]?.click()}
            onRemove={() => remove(c)}
            inputRef={(el) => (inputs.current[c.id] = el)}
            onFile={(file) => upload(c, file)}
          />
        ))}
      </div>

      {/* Add a custom expression: name it, then pick an image. */}
      <div className="rounded-lg border border-dashed border-border p-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder='New expression name (e.g. "Pointing", "Thinking")'
          className="flex-1"
          maxLength={40}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={busy === '__new__' || !newName.trim()}
          onClick={() => customInput.current?.click()}
        >
          {busy === '__new__' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Add expression
        </Button>
        <input
          ref={customInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void addCustom(file);
            e.target.value = '';
          }}
        />
      </div>
    </section>
  );
}

function CharacterCard({
  character,
  busy,
  onPick,
  onRemove,
  inputRef,
  onFile,
}: {
  character: ThumbnailCharacterState;
  busy: boolean;
  onPick: () => void;
  onRemove: () => void;
  inputRef: (el: HTMLInputElement | null) => void;
  onFile: (file: File) => void;
}) {
  // Built-in slots persist (Remove just clears the image); custom ones are deleted.
  const canRemove = character.uploaded;
  return (
    <div className="rounded-lg border border-border overflow-hidden bg-background">
      <div className="aspect-square bg-muted relative">
        {character.uploaded && character.url ? (
          <img src={character.url} alt={character.label} className="w-full h-full object-cover" />
        ) : (
          <button
            onClick={onPick}
            disabled={busy}
            className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
            <span className="text-xs">Upload</span>
          </button>
        )}
        {busy && character.uploaded && (
          <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-foreground" />
          </div>
        )}
        {!character.builtin && (
          <Badge variant="secondary" className="absolute top-1.5 left-1.5 text-[10px] px-1.5 py-0">Custom</Badge>
        )}
      </div>
      <div className="p-2.5">
        <div className="flex items-center justify-between gap-1">
          <span className="text-sm font-medium text-foreground truncate" title={character.label}>{character.label}</span>
          {canRemove && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={onPick}
                disabled={busy}
                className="text-muted-foreground hover:text-foreground transition-colors p-1"
                aria-label={`Replace ${character.label} image`}
                title="Replace"
              >
                <Upload className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onRemove}
                disabled={busy}
                className="text-muted-foreground hover:text-destructive transition-colors p-1"
                aria-label={`Remove ${character.label} image`}
                title={character.builtin ? 'Clear image' : 'Delete expression'}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">{character.hint || (character.builtin ? '' : 'Custom expression')}</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function BackgroundLibrary({
  status,
  onChanged,
}: {
  status: ThumbnailStatusOutputType;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const addInput = useRef<HTMLInputElement | null>(null);

  const add = async (file: File) => {
    const name = newName.trim();
    if (!name) {
      toast.error('Give the background a name first.');
      return;
    }
    setBusy('__new__');
    try {
      const imageBase64 = await fileToBase64(file);
      await uploadThumbnailBackground({ name, imageBase64 });
      toast.success(`Added background "${name}".`);
      setNewName('');
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (bg: ThumbnailBackgroundState) => {
    setBusy(bg.id);
    try {
      await deleteThumbnailBackground({ id: bg.id });
      toast.success(`Removed background "${bg.label}".`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  };

  const backgrounds = status.backgrounds ?? [];

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <SectionHeader
        icon={<ImageIcon className="w-4 h-4" />}
        title="Background library (optional)"
        subtitle="Used two ways: (1) the AI may swap one into a recreation when it clearly fits; (2) the contrarian originals pin one per template — name them “Open Space Office With Green”, “Black”, and “Office” to control templates 1, 2 and 3 (any unmatched name is reused as a fallback)."
      />
      {backgrounds.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {backgrounds.map((bg) => (
            <div key={bg.id} className="rounded-lg border border-border overflow-hidden bg-background">
              <div className="aspect-video bg-muted relative">
                <img src={bg.url} alt={bg.label} className="w-full h-full object-cover" />
                {busy === bg.id && (
                  <div className="absolute inset-0 bg-background/60 flex items-center justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-foreground" />
                  </div>
                )}
              </div>
              <div className="p-2.5 flex items-center justify-between gap-1">
                <span className="text-sm font-medium text-foreground truncate" title={bg.label}>{bg.label}</span>
                <button
                  onClick={() => remove(bg)}
                  disabled={busy === bg.id}
                  className="text-muted-foreground hover:text-destructive transition-colors p-1 shrink-0"
                  aria-label={`Remove background ${bg.label}`}
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-lg border border-dashed border-border p-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder='New background name (e.g. "Red Grid", "Studio")'
          className="flex-1"
          maxLength={40}
        />
        <Button
          type="button"
          variant="secondary"
          disabled={busy === '__new__' || !newName.trim()}
          onClick={() => addInput.current?.click()}
        >
          {busy === '__new__' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Add background
        </Button>
        <input
          ref={addInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void add(file);
            e.target.value = '';
          }}
        />
      </div>
    </section>
  );
}

function FontUploader({
  status,
  onChanged,
}: {
  status: ThumbnailStatusOutputType;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const font = status.font;

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fontBase64 = await fileToBase64(file);
      await uploadThumbnailFont({ filename: file.name, fontBase64 });
      toast.success(`Headline font set to "${file.name}".`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteThumbnailFont({});
      toast.success('Reverted to the default Helvetica-compatible font.');
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-4">
      <SectionHeader
        icon={<Type className="w-4 h-4" />}
        title="Headline font (contrarian originals)"
        subtitle="Upload your Helvetica (or any .ttf / .otf / .woff) for the contrarian headline text. Defaults to a Helvetica-compatible font."
      />
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground truncate">
            {font?.uploaded ? font.name : 'Default — Liberation Sans Bold (Helvetica-compatible)'}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {font?.uploaded ? 'Your custom font is used for the contrarian headline text.' : 'No custom font uploaded yet.'}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {font?.uploaded ? 'Replace' : 'Upload font'}
          </Button>
          {font?.uploaded && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="text-muted-foreground hover:text-destructive transition-colors p-2"
              aria-label="Remove custom font"
              title="Remove"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".ttf,.otf,.ttc,.woff,.woff2,font/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />
    </section>
  );
}

function CopyReview({
  titles,
  draft,
  loading,
  onEdit,
  onRegenerate,
}: {
  titles: ThumbnailTitles | null;
  draft: PlannedContrarian[] | null;
  loading: boolean;
  onEdit: (i: number, patch: Partial<PlannedContrarian>) => void;
  onRegenerate: () => void;
}) {
  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-primary" /> Titles &amp; thumbnail copy
        </span>
        <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onRegenerate}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
          Regenerate
        </Button>
      </div>

      {/* Titles */}
      {titles && (titles.viral.length > 0 || titles.seo.length > 0) && (
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">Viral titles</p>
            <ul className="space-y-1">
              {titles.viral.map((t, i) => (
                <li key={i} className="text-xs text-foreground bg-background rounded px-2 py-1 border border-border">{t}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[11px] font-medium text-muted-foreground mb-1">SEO titles</p>
            <ul className="space-y-1">
              {titles.seo.map((t, i) => (
                <li key={i} className="text-xs text-foreground bg-background rounded px-2 py-1 border border-border">{t}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Contrarian copy — editable per template */}
      {loading && !draft && <Skeleton className="h-24 w-full rounded" />}
      {draft && draft.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Review the text for each contrarian thumbnail — edit it however you like. The highlighted word goes in the red box.
          </p>
          {draft.map((v, i) => (
            <div key={i} className="rounded-md border border-border bg-background p-2.5 space-y-2">
              <span className="text-[11px] font-medium text-muted-foreground">Thumbnail {i + 1} · {v.templateLabel}</span>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="flex-1">
                  <label className="text-[10px] text-muted-foreground">Headline (≤4 words)</label>
                  <Input value={v.text} maxLength={40} onChange={(e) => onEdit(i, { text: e.target.value })} />
                </div>
                <div className="sm:w-40">
                  <label className="text-[10px] text-muted-foreground">Highlighted word(s)</label>
                  <Input value={v.emphasis} maxLength={24} onChange={(e) => onEdit(i, { emphasis: e.target.value })} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecreationReview({
  plans,
  planning,
  status,
  onReview,
  onEditPlan,
  onSetRewrites,
}: {
  plans: RecreationPlan[] | null;
  planning: boolean;
  status: ThumbnailStatusOutputType;
  onReview: () => void;
  onEditPlan: (videoId: string, patch: Partial<RecreationPlan>) => void;
  onSetRewrites: (videoId: string, rewrites: RecreationPlan['rewrites']) => void;
}) {
  const charOptions = status.characters.filter((c) => c.uploaded);
  const bgOptions = status.backgrounds;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <Wand2 className="w-4 h-4 text-primary" /> Review the AI's choices
        </span>
        <Button type="button" variant="outline" size="sm" disabled={planning} onClick={onReview}>
          {planning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {plans ? 'Re-plan' : 'Review choices'}
        </Button>
      </div>
      {!plans && !planning && (
        <p className="text-[11px] text-muted-foreground">
          Optional: see + edit the character, background and text the AI will use for each thumbnail before generating.
          Skip it to let the AI decide automatically.
        </p>
      )}
      {planning && !plans && <Skeleton className="h-28 w-full rounded" />}
      {plans &&
        plans.map((p) => (
          <div key={p.videoId} className="rounded-md border border-border bg-background p-3 space-y-3">
            <div className="flex gap-3">
              <img
                src={p.sourceThumbnailUrl || `https://i.ytimg.com/vi/${p.videoId}/hqdefault.jpg`}
                alt="source"
                className="w-28 aspect-video object-cover rounded border border-border shrink-0"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).src = `https://i.ytimg.com/vi/${p.videoId}/hqdefault.jpg`;
                }}
              />
              <div className="flex-1 grid sm:grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-muted-foreground">Character</label>
                  <Select value={p.expression} onValueChange={(v) => onEditPlan(p.videoId, { expression: v })}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {charOptions.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground">Background</label>
                  <Select
                    value={p.backgroundId ?? '__auto__'}
                    onValueChange={(v) => onEditPlan(p.videoId, { backgroundId: v === '__auto__' ? null : v })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__auto__">Keep / enhance original</SelectItem>
                      {bgOptions.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            {/* Text changes — editable old→new pairs. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-[10px] text-muted-foreground">Text changes (original → new)</label>
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => onSetRewrites(p.videoId, [...p.rewrites, { old: '', new: '' }])}
                >
                  + Add
                </button>
              </div>
              {p.rewrites.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No text changes — the original copy is kept (titles aside).</p>
              )}
              {p.rewrites.map((r, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={r.old}
                    placeholder="original text"
                    className="h-8 text-xs"
                    onChange={(e) => onSetRewrites(p.videoId, p.rewrites.map((x, i) => (i === idx ? { ...x, old: e.target.value } : x)))}
                  />
                  <span className="text-muted-foreground text-xs">→</span>
                  <Input
                    value={r.new}
                    placeholder="new text"
                    className="h-8 text-xs"
                    onChange={(e) => onSetRewrites(p.videoId, p.rewrites.map((x, i) => (i === idx ? { ...x, new: e.target.value } : x)))}
                  />
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-destructive text-xs px-1"
                    onClick={() => onSetRewrites(p.videoId, p.rewrites.filter((_, i) => i !== idx))}
                    aria-label="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function Results({
  generating,
  job,
  title = 'Results',
  subtitle = 'Your recreated 1920×1080 thumbnails — preview and download.',
}: {
  generating: boolean;
  job: ThumbnailJobStatus | null;
  title?: string;
  subtitle?: string;
}) {
  const variants = job?.variants ?? [];
  const doneCount = variants.filter((v) => v.status === 'done' || v.status === 'error').length;
  const overall = job?.percent ?? 0;
  const active = generating || (job ? !job.done : false);

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-5">
      <SectionHeader icon={<Sparkles className="w-4 h-4" />} title={title} subtitle={subtitle} />

      {/* Overall progress bar — always shown once a job exists, with the % number. */}
      {(active || job) && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground flex items-center gap-1.5">
              {active ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> : <CheckCircle2 className="w-3.5 h-3.5 text-primary" />}
              {active ? 'Generating thumbnails…' : 'Generation complete'}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {variants.length > 0 && <span className="mr-2">{doneCount}/{variants.length} done</span>}
              <span className="font-medium text-foreground">{Math.round(overall)}%</span>
            </span>
          </div>
          <Progress
            value={overall}
            aria-label="Overall thumbnail generation progress"
          />
        </div>
      )}

      {/* Before the first poll lands, show placeholders so the section isn't empty. */}
      {generating && variants.length === 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="aspect-video w-full rounded-lg" />
        </div>
      )}

      {variants.length > 0 && (
        <div className="space-y-4">
          {variants.map((v) => (
            <VariantRow key={`${v.videoId}-${v.index}`} variant={v} />
          ))}
        </div>
      )}
    </section>
  );
}

function VariantRow({ variant }: { variant: ThumbnailJobVariant }) {
  const failed = variant.status === 'error';
  // Recreations show Original + generated (2-up); contrarian originals have no
  // source thumbnail, so the generated image stands alone.
  const hasOriginal = !!variant.sourceThumbnailUrl;
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-foreground">Variant {variant.index + 1}</span>
        <Badge variant="secondary" className="capitalize">{variant.expression}</Badge>
        {variant.status === 'done' && (
          <Badge variant="secondary" className="gap-1 text-primary">
            <CheckCircle2 className="w-3 h-3" /> Done
          </Badge>
        )}
        {failed && (
          <Badge variant="secondary" className="gap-1 text-destructive">
            <AlertTriangle className="w-3 h-3" /> Failed
          </Badge>
        )}
      </div>

      <div className={`grid gap-4 ${hasOriginal ? 'md:grid-cols-2' : 'md:grid-cols-1'}`}>
        {hasOriginal && (
          <figure className="space-y-1.5">
            <figcaption className="text-xs text-muted-foreground">Original</figcaption>
            <div className="aspect-video rounded-md overflow-hidden bg-muted">
              <img src={variant.sourceThumbnailUrl} alt="Original thumbnail" className="w-full h-full object-cover" />
            </div>
          </figure>
        )}
        {variant.results.map((r, i) => (
          <ResultColumn key={`${r.provider}-${i}`} variantIndex={variant.index} result={r} />
        ))}
      </div>
    </div>
  );
}

/** One provider sub-run's column: label, live progress, image / error, download. */
function ResultColumn({ variantIndex, result }: { variantIndex: number; result: ThumbnailProviderResult }) {
  const running = result.status === 'running' || result.status === 'queued';
  const failed = result.status === 'error';
  // Fall back to a generic caption when there's only a single (label-less) run.
  const caption = result.label || 'Generated';
  return (
    <figure className="space-y-1.5">
      <figcaption className="text-xs text-muted-foreground flex items-center justify-between gap-2">
        <span className="truncate font-medium text-foreground/80">{caption}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">1920×1080</span>
      </figcaption>

      {/* Per-column live step + sub-progress (hidden once terminal). */}
      {running && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground flex items-center gap-1.5 truncate">
              <Loader2 className="w-3 h-3 animate-spin shrink-0" />
              <span className="truncate">{result.stepLabel}</span>
            </span>
            <span className="text-muted-foreground tabular-nums shrink-0">{result.percent}%</span>
          </div>
          <Progress value={result.percent} className="h-1.5" aria-label={`${caption} progress`} />
        </div>
      )}

      <div className="aspect-video rounded-md overflow-hidden bg-muted flex items-center justify-center">
        {result.outputUrl ? (
          <img src={result.outputUrl} alt={`${caption} thumbnail`} className="w-full h-full object-cover" />
        ) : failed ? (
          <div className="text-center px-4">
            <AlertTriangle className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
            <p className="text-xs text-muted-foreground">{result.error || 'Could not generate this thumbnail.'}</p>
          </div>
        ) : (
          <div className="text-center px-4">
            <Loader2 className="w-5 h-5 text-muted-foreground mx-auto mb-1 animate-spin" />
            <p className="text-xs text-muted-foreground">{result.stepLabel}</p>
          </div>
        )}
      </div>
      {result.outputUrl && (
        <Button asChild variant="outline" size="sm" className="w-full">
          <a href={result.outputUrl} download>
            <Download className="w-4 h-4" />
            Download
          </a>
        </Button>
      )}
      <span className="sr-only">Variant {variantIndex + 1} {caption}</span>
    </figure>
  );
}

