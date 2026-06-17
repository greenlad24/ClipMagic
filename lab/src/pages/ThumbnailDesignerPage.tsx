import { useEffect, useRef, useState } from 'react';
import { useAuth } from 'zite-auth-sdk';
import {
  thumbnailStatus,
  analyzeThumbnailScript,
  searchThumbnails,
  startThumbnailGeneration,
  thumbnailJobStatus,
  uploadThumbnailCharacter,
  deleteThumbnailCharacter,
  type ThumbnailStatusOutputType,
  type ThumbnailCharacterState,
  type ThumbnailExpression,
  type ThumbnailVideoType,
  type ThumbnailSearchResult,
  type ThumbnailJobStatus,
  type ThumbnailJobVariant,
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

const EXPRESSION_LABEL: Record<ThumbnailExpression, string> = {
  smile: 'Smile',
  surprise: 'Surprise',
  secret: 'Secret',
  calm: 'Calm',
};
const EXPRESSION_HINT: Record<ThumbnailExpression, string> = {
  smile: 'Tutorials / How-to',
  surprise: 'Viral / Shock',
  secret: 'Secret / Insider',
  calm: 'Reviews / Calm',
};
const VIDEO_TYPES: ThumbnailVideoType[] = ['Tutorial', 'Viral', 'Secret', 'Review'];

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
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ThumbnailSearchResult[] | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [job, setJob] = useState<ThumbnailJobStatus | null>(null);

  // Poll lifecycle: a single interval that we always clear on done/unmount/restart.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
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
    setPicks((prev) =>
      prev.includes(videoId) ? prev.filter((id) => id !== videoId) : [...prev, videoId],
    );
  };

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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not analyze the script');
    } finally {
      setAnalyzing(false);
    }
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
  const onGenerate = async () => {
    if (picks.length === 0) {
      toast.info('Pick at least one thumbnail to recreate.');
      return;
    }
    stopPolling();
    setGenerating(true);
    setJob(null);
    try {
      const { jobId } = await startThumbnailGeneration({ keyword: keyword.trim(), videoType, picks });

      const tick = async () => {
        try {
          const snap = await thumbnailJobStatus({ jobId });
          setJob(snap);
          if (snap.done) {
            stopPolling();
            setGenerating(false);
            if (snap.error) {
              toast.error(snap.error);
              return;
            }
            const ok = snap.variants.filter((v) => v.outputUrl).length;
            if (ok === 0) toast.error('No thumbnails could be generated — see the per-item errors below.');
            else toast.success(`Generated ${ok} thumbnail${ok === 1 ? '' : 's'}.`);
          }
        } catch (e) {
          // A transient poll failure shouldn't kill the run; surface only if fatal.
          stopPolling();
          setGenerating(false);
          toast.error(e instanceof Error ? e.message : 'Lost track of the generation job.');
        }
      };

      // Poll every ~1.2s; run one immediately so the first frame isn't blank.
      pollRef.current = setInterval(() => void tick(), 1200);
      void tick();
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
              Paste your script and recreate top-performing YouTube thumbnails with your own character.
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
                        Top {results.length} most-viewed (long-form). Select any you want to recreate — one variant each.
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
                    <div className="space-y-1.5">
                      <Button onClick={onGenerate} disabled={generating || picks.length === 0} className="w-full sm:w-auto">
                        {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                        Generate {picks.length > 0 ? `${picks.length} ` : ''}thumbnail{picks.length === 1 ? '' : 's'}
                      </Button>
                      {picks.length > 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          Each selected thumbnail is recreated separately — time and cost scale with the number you pick.
                        </p>
                      )}
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
          </>
        )}
      </div>
    </Layout>
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
  const [busy, setBusy] = useState<ThumbnailExpression | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const upload = async (expr: ThumbnailExpression, file: File) => {
    setBusy(expr);
    try {
      const imageBase64 = await fileToBase64(file);
      await uploadThumbnailCharacter({ expression: expr, imageBase64 });
      toast.success(`Saved your "${EXPRESSION_LABEL[expr]}" expression.`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (expr: ThumbnailExpression) => {
    setBusy(expr);
    try {
      await deleteThumbnailCharacter({ expression: expr });
      toast.success(`Removed your "${EXPRESSION_LABEL[expr]}" expression.`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
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
        subtitle="Upload your face once per expression. The generator reuses these across every run."
      />
      {none && (
        <p className="text-xs text-muted-foreground">
          Upload at least one clear, well-lit portrait of yourself. Each expression maps to a video type — the generator picks the right one automatically.
        </p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {status.characters.map((c) => (
          <CharacterCard
            key={c.expression}
            character={c}
            busy={busy === c.expression}
            onPick={() => inputs.current[c.expression]?.click()}
            onRemove={() => remove(c.expression)}
            inputRef={(el) => (inputs.current[c.expression] = el)}
            onFile={(file) => upload(c.expression, file)}
          />
        ))}
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
  return (
    <div className="rounded-lg border border-border overflow-hidden bg-background">
      <div className="aspect-square bg-muted relative">
        {character.uploaded && character.url ? (
          <img src={character.url} alt={character.expression} className="w-full h-full object-cover" />
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
      </div>
      <div className="p-2.5">
        <div className="flex items-center justify-between gap-1">
          <span className="text-sm font-medium text-foreground">{EXPRESSION_LABEL[character.expression]}</span>
          {character.uploaded && (
            <div className="flex items-center gap-1">
              <button
                onClick={onPick}
                disabled={busy}
                className="text-muted-foreground hover:text-foreground transition-colors p-1"
                aria-label={`Replace ${character.expression} image`}
                title="Replace"
              >
                <Upload className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onRemove}
                disabled={busy}
                className="text-muted-foreground hover:text-destructive transition-colors p-1"
                aria-label={`Remove ${character.expression} image`}
                title="Remove"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">{EXPRESSION_HINT[character.expression]}</p>
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

function Results({
  generating,
  job,
}: {
  generating: boolean;
  job: ThumbnailJobStatus | null;
}) {
  const variants = job?.variants ?? [];
  const doneCount = variants.filter((v) => v.status === 'done' || v.status === 'error').length;
  const overall = job?.percent ?? 0;
  const active = generating || (job ? !job.done : false);

  return (
    <section className="rounded-xl border border-border bg-card p-5 space-y-5">
      <SectionHeader icon={<Sparkles className="w-4 h-4" />} title="Results" subtitle="Your recreated 1920×1080 thumbnails — preview and download." />

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
  const running = variant.status === 'running' || variant.status === 'queued';
  const failed = variant.status === 'error';
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center gap-2">
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

      {/* Per-variant live step + sub-progress (hidden once it's terminal). */}
      {running && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              {variant.stepLabel}
            </span>
            <span className="text-muted-foreground tabular-nums">{variant.percent}%</span>
          </div>
          <Progress value={variant.percent} className="h-1.5" aria-label={`Variant ${variant.index + 1} progress`} />
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <figure className="space-y-1.5">
          <figcaption className="text-xs text-muted-foreground">Original</figcaption>
          <div className="aspect-video rounded-md overflow-hidden bg-muted">
            <img src={variant.sourceThumbnailUrl} alt="Original thumbnail" className="w-full h-full object-cover" />
          </div>
        </figure>
        <figure className="space-y-1.5">
          <figcaption className="text-xs text-muted-foreground">Generated · 1920×1080</figcaption>
          <div className="aspect-video rounded-md overflow-hidden bg-muted flex items-center justify-center">
            {variant.outputUrl ? (
              <img src={variant.outputUrl} alt="Generated thumbnail" className="w-full h-full object-cover" />
            ) : failed ? (
              <div className="text-center px-4">
                <AlertTriangle className="w-5 h-5 text-muted-foreground mx-auto mb-1" />
                <p className="text-xs text-muted-foreground">{variant.error || 'Could not generate this thumbnail.'}</p>
              </div>
            ) : (
              <div className="text-center px-4">
                <Loader2 className="w-5 h-5 text-muted-foreground mx-auto mb-1 animate-spin" />
                <p className="text-xs text-muted-foreground">{variant.stepLabel}</p>
              </div>
            )}
          </div>
          {variant.outputUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={variant.outputUrl} download>
                <Download className="w-4 h-4" />
                Download
              </a>
            </Button>
          )}
        </figure>
      </div>
    </div>
  );
}

