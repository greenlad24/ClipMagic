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
  type ThumbnailMode,
  type ThumbnailSearchResult,
  type ThumbnailJobStatus,
  type ThumbnailJobVariant,
  type ThumbnailProviderResult,
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

/**
 * Generation modes offered in the generate UI. The DEFAULT is "compare": every
 * pick is generated through BOTH top providers at their best size and shown side
 * by side so you can pick the better one. The single-provider modes are there for
 * when you don't want the comparison/cost.
 */
const MODE_OPTIONS: { value: ThumbnailMode; label: string; hint: string; needsOpenAi?: boolean }[] = [
  {
    value: 'compare',
    label: 'Compare both (Pro 4K + OpenAI)',
    hint: 'Generates each pick TWICE — Nano Banana Pro at 4K and OpenAI at its highest size — side by side so you pick the better one. Runs the full chain twice per thumbnail, so it costs ~2× a single run.',
    needsOpenAi: true,
  },
  { value: 'gemini-pro', label: 'Nano Banana Pro only (sharpest, best likeness)', hint: 'Highest single-model quality — 2K renders, strongest face match. ~$0.13/image, and the chain runs several edits per thumbnail.' },
  { value: 'gemini-flash', label: 'Nano Banana (Flash, cheap)', hint: 'Fast and inexpensive — good for drafts and high volume.' },
  { value: 'openai', label: 'OpenAI only (gpt-image-1)', hint: 'OpenAI image model with high input-fidelity. Requires an OpenAI API key.', needsOpenAi: true },
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
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ThumbnailSearchResult[] | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [mode, setMode] = useState<ThumbnailMode>('compare');
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
    if ((mode === 'openai' || mode === 'compare') && !status?.openaiConfigured) {
      toast.error(
        mode === 'compare'
          ? 'Compare mode needs an OpenAI API key (Settings → Thumbnail Designer). Pick a single Nano Banana model, or add the key.'
          : 'Add your OpenAI API key in Settings → Thumbnail Designer to use gpt-image-1.',
      );
      return;
    }
    stopPolling();
    setGenerating(true);
    setJob(null);
    try {
      const { jobId } = await startThumbnailGeneration({ keyword: keyword.trim(), videoType, picks, mode });

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
                    {/* Mode selector — compare (default) or a single image model. */}
                    <div className="space-y-1.5 sm:max-w-md">
                      <label className="text-xs font-medium text-muted-foreground block">Generation mode</label>
                      <Select value={mode} onValueChange={(v) => setMode(v as ThumbnailMode)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MODE_OPTIONS.map((m) => {
                            const disabled = !!m.needsOpenAi && !status?.openaiConfigured;
                            return (
                              <SelectItem key={m.value} value={m.value} disabled={disabled}>
                                {m.label}
                                {disabled ? ' — add OpenAI key in Settings' : ''}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">
                        {MODE_OPTIONS.find((m) => m.value === mode)?.hint}
                      </p>
                    </div>
                    {/* Cost estimate — bigger for compare (it runs the chain twice). */}
                    {picks.length > 0 && (
                      <CostHint mode={mode} picks={picks.length} />
                    )}
                    <div className="space-y-1.5">
                      <Button onClick={onGenerate} disabled={generating || picks.length === 0} className="w-full sm:w-auto">
                        {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                        Generate {picks.length > 0 ? `${picks.length} ` : ''}thumbnail{picks.length === 1 ? '' : 's'}
                        {mode === 'compare' ? ' · both models' : ''}
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
          </>
        )}
      </div>
    </Layout>
  );
}

/**
 * Rough cost/time hint. Each thumbnail runs a multi-step chain; compare runs the
 * whole chain TWICE (Pro at 4K + OpenAI), so it's the pricier path — call that out
 * with a bigger, clearer estimate (Pro at 4K ≈ $0.24/image across several steps).
 */
function CostHint({ mode, picks }: { mode: ThumbnailMode; picks: number }) {
  if (mode === 'compare') {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-[11px] text-muted-foreground space-y-1">
        <p className="text-xs font-medium text-foreground">Heads up — compare runs each thumbnail twice</p>
        <p>
          {picks} thumbnail{picks === 1 ? '' : 's'} × 2 models (Nano Banana Pro @ 4K + OpenAI) ={' '}
          <span className="font-medium text-foreground">{picks * 2} full chains</span>. Pro at 4K is ≈ $0.24/image and the
          chain runs several edits each, so expect this to take longer and cost noticeably more than a single model.
          You'll see both results side by side and pick the better one.
        </p>
      </div>
    );
  }
  return (
    <p className="text-[11px] text-muted-foreground">
      Each selected thumbnail is recreated separately on one model — time and cost scale with the number you pick.
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
  const failed = variant.status === 'error';
  const compare = variant.results.length > 1;
  // Original + N generated columns. With one model that's the classic 2-up; with
  // two it's a 3-up (Original · Pro · OpenAI) so they sit side by side to compare.
  const gridCols = compare ? 'md:grid-cols-3' : 'md:grid-cols-2';
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
        {compare && (
          <span className="text-[11px] text-muted-foreground">Pick the better of the two below.</span>
        )}
      </div>

      <div className={`grid ${gridCols} gap-4`}>
        <figure className="space-y-1.5">
          <figcaption className="text-xs text-muted-foreground">Original</figcaption>
          <div className="aspect-video rounded-md overflow-hidden bg-muted">
            <img src={variant.sourceThumbnailUrl} alt="Original thumbnail" className="w-full h-full object-cover" />
          </div>
        </figure>
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

