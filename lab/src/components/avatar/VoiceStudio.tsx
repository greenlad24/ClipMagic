import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  AudioLines,
  Check,
  ChevronDown,
  Copy,
  Download,
  Fingerprint,
  AlertTriangle,
  KeyRound,
  Library,
  ListMusic,
  Play,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';

/**
 * VoiceStudio — the voice half of a persona.
 *
 * The old panel was a flat stack of controls that hid the actual model of the
 * feature, so this is organised around the three questions in order:
 *
 *   1. WHERE DOES THE VOICE COME FROM? Design one from a description (a voice
 *      that has never existed, saved with an id), pick a vendor preset, or paste
 *      an id already on the account. These are alternatives, not a checklist —
 *      hence tabs, not three stacked boxes fighting for the same decision.
 *   2. DOES IT SOUND RIGHT? One audition control, always in the same place, for
 *      whichever voice is currently selected. The audition is a ~52-second
 *      paragraph, not a one-liner, because that is the only way pacing, a
 *      question, an aside and a gear change actually show up.
 *   3. WHICH CANDIDATE WINS? Every past voice is a row with its own player, and
 *      auditioning any of them re-speaks the SAME script — comparison is only
 *      meaningful when the words are held constant. Only one clip plays at a
 *      time, so A/B-ing is click-then-click rather than click-then-hunt-for-pause.
 *
 * The component is presentational: it owns no fetching and no toasts. Every
 * mutation is a callback, so the page keeps one source of truth for samples.
 */

export interface VoiceSample {
  file: string;
  url: string;
  createdAt: number;
  bytes: number;
  /** Clip length. What you actually compare voices on — bytes is noise. */
  seconds: number;
  inUse: boolean;
  voiceId: string | null;
  label: string;
  kind: 'designed' | 'sample';
}

export interface VoiceSettings {
  model: string;
  speed: number;
  stability: number;
  similarityBoost: number;
  style: number;
  speakerBoost: boolean;
}

/**
 * What each dial actually does to a READ, not what the vendor calls it.
 *
 * The counter-intuitive one is Style: it is not "more life", it is "more
 * performance", and pushed high it produces a read that sounds acted rather
 * than spoken. Life comes from LOW stability. That is worth saying next to the
 * control, because the names alone lead people the wrong way.
 */
const DIALS: {
  key: 'stability' | 'similarityBoost' | 'style' | 'speed';
  label: string;
  min: number;
  max: number;
  step: number;
  percent: boolean;
  low: string;
  high: string;
  hint: string;
}[] = [
  {
    key: 'stability', label: 'Stability', min: 0, max: 1, step: 0.01, percent: true,
    low: 'alive, varies per take', high: 'flat, identical每 take'.replace('每', ' every '),
    hint: 'The main dial for life. Lower it if the read sounds robotic — it lets pitch and pace move. Too low and takes stop matching each other. 30–45% suits narration.',
  },
  {
    key: 'similarityBoost', label: 'Similarity', min: 0, max: 1, step: 0.01, percent: true,
    low: 'looser, cleaner', high: 'clings to the source',
    hint: 'How hard it holds onto the original voice. Above ~85% it starts importing artefacts from the sample and can sound stiff. 70–80% is the sweet spot.',
  },
  {
    key: 'style', label: 'Style', min: 0, max: 1, step: 0.01, percent: true,
    low: 'plain, natural', high: 'performed, theatrical',
    hint: 'Exaggerates delivery. NOT the same as liveliness — high style sounds acted, adds latency and destabilises the read. Keep it under ~40% for narration.',
  },
  {
    key: 'speed', label: 'Speed', min: 0.7, max: 1.2, step: 0.01, percent: false,
    low: 'slower', high: 'faster',
    hint: '1.0 is the voice\'s natural pace. Short-form tolerates 1.05–1.1; past that it starts clipping its own consonants.',
  },
];

export interface VoiceStudioProps {
  samples: VoiceSample[];
  voiceDescription: string;
  onVoiceDescriptionChange: (v: string) => void;
  auditionText: string;
  onAuditionTextChange: (v: string) => void;
  /** Either a vendor preset name ("Rachel") or a voice id already on the account. */
  voice: string;
  onVoiceChange: (v: string) => void;
  currentSample: { file: string; url: string; seconds: number } | null;
  designedVoiceId: string | null;
  onDesign: () => void;
  onAudition: (voiceId?: string) => void;
  onUseSample: (sample: VoiceSample) => void;
  onDeleteSample: (file: string) => void;
  designing: boolean;
  designStartedAt: number;
  auditioning: boolean;
  auditionStartedAt: number;
  /** No TTS key configured — every billable action is off, but the library still reads. */
  settings: VoiceSettings;
  onSettingsChange: (next: VoiceSettings) => void;
  models: { id: string; label: string; hint: string }[];
  disabled: boolean;
  /** Why it is disabled, in the operator's terms — not a guess made here. */
  disabledReason?: string;
  /**
   * The last failure, kept until the next attempt. A design that fails after
   * twenty seconds must leave an explanation behind; the progress bar simply
   * disappearing reads as a bug rather than as a refusal.
   */
  lastError?: string | null;
}

type VoiceSource = 'design' | 'preset' | 'id';
type LibraryFilter = 'all' | 'designed' | 'sample';

/** Measured, not guessed: design is a two-stage vendor call, an audition is one. */
const EXPECTED_SECONDS = { design: 25, audition: 20 };

/**
 * The design endpoint rejects thin descriptions, and a rejection costs a round
 * trip. Gating the button on the same floor turns a server error into a hint.
 */
const MIN_DESCRIPTION_CHARS = 20;

/**
 * Audition cost/length are extrapolated from the shipped script: ~130 words,
 * ~700 characters, ~52 seconds, ~$0.12. The script is editable, so the numbers
 * have to move with it — a fixed "~$0.12" label would quietly lie the moment
 * someone pastes a longer paragraph.
 */
const BASELINE_CHARS = 700;
const BASELINE_USD = 0.12;
const WORDS_PER_SECOND = 2.5;

/**
 * Vendor presets worth offering. Hardcoded because the prop contract passes no
 * catalogue — see the note at the end of this file. Names are stable vendor
 * voices; the hint is what you are actually choosing between.
 */
/**
 * Presets have to carry IDs, not names.
 *
 * The vendor resolves this field as an id and answers a display name with
 * "An invalid ID has been received: 'Voice not found.'" — so a list of pretty
 * names is a list of guaranteed failures. Only ids that are actually verified
 * belong here; the rest of the library is reachable through the Voice ID tab,
 * where the operator pastes the id from their own account.
 */
const PRESETS: { id: string; name: string; hint: string }[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', hint: 'calm, even narration' },
];

/** Vendor ids are long opaque alphanumerics; preset names never are. */
function looksLikeVoiceId(value: string): boolean {
  return /^[A-Za-z0-9]{16,}$/.test(value.trim());
}

function relTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Length beats size for a voice row: nobody chooses between "487 KB" and
 * "512 KB", but "52s" against "9s" tells you which clip is a real audition.
 * Size is the fallback for older clips recorded before duration was stored.
 */
function clipLength(seconds: number, bytes: number): string {
  if (seconds > 0) {
    const s = Math.round(seconds);
    return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  }
  if (bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function usd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

function seconds(n: number): string {
  if (!n) return '—';
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

/**
 * A bar for a blocking request that cannot report progress.
 *
 * Estimated from elapsed time, and deliberately capped short of 100%: a bar
 * pinned at full while the request is still open reads as a hang. Past ~20%
 * over the estimate it stops pretending and says so, because a frozen bar is
 * the moment people reload the page and pay for the call twice.
 */
function ElapsedProgress({
  startedAt,
  expectedSeconds,
  label,
}: {
  startedAt: number;
  expectedSeconds: number;
  label: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [startedAt]);

  const elapsed = Math.max(0, (now - startedAt) / 1000);
  const pct = Math.min(96, Math.round((elapsed / expectedSeconds) * 100));
  const over = elapsed > expectedSeconds * 1.2;

  return (
    <div className="space-y-1.5 pt-1">
      <Progress value={pct} className="h-1.5" />
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {pct}% · {Math.round(elapsed)}s
          {over ? ' — longer than usual, still going' : ` of ~${expectedSeconds}s`}
        </span>
      </div>
    </div>
  );
}

export default function VoiceStudio(props: VoiceStudioProps): JSX.Element {
  const {
    samples,
    voiceDescription,
    onVoiceDescriptionChange,
    auditionText,
    onAuditionTextChange,
    voice,
    onVoiceChange,
    currentSample,
    designedVoiceId,
    onDesign,
    onAudition,
    onUseSample,
    onDeleteSample,
    designing,
    designStartedAt,
    auditioning,
    auditionStartedAt,
    settings,
    onSettingsChange,
    models,
    disabled,
    disabledReason,
    lastError,
  } = props;

  const descriptionId = useId();
  const scriptId = useId();
  const voiceIdFieldId = useId();

  // Opened from whatever the persona already has, then left alone: re-deriving
  // it on every `voice` change would yank the tab out from under someone who is
  // mid-sentence in the design box after clicking a library row.
  const [source, setSource] = useState<VoiceSource>(() => {
    if (!voice.trim()) return 'design';
    if (PRESETS.some((p) => p.id === voice)) return 'preset';
    return looksLikeVoiceId(voice) ? 'id' : 'design';
  });
  const [scriptOpen, setScriptOpen] = useState(false);
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [copied, setCopied] = useState(false);
  // Deleting costs nothing to click and cannot be undone, so it arms first.
  // Cheaper than a modal at 320px, and it disarms itself so it never sticks.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!armedDelete) return;
    const t = window.setTimeout(() => setArmedDelete(null), 4000);
    return () => window.clearTimeout(t);
  }, [armedDelete]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  // Comparing voices means starting one clip and stopping another. Browsers
  // happily play every <audio> at once, which turns an A/B into a mess, so the
  // studio keeps a registry and solos whichever clip was just started.
  const players = useRef(new Map<string, HTMLAudioElement>());
  const registerPlayer = useCallback((key: string, el: HTMLAudioElement | null) => {
    if (el) players.current.set(key, el);
    else players.current.delete(key);
  }, []);
  const soloPlayer = useCallback((key: string) => {
    players.current.forEach((el, k) => {
      if (k !== key && !el.paused) el.pause();
    });
  }, []);

  const busy = designing || auditioning;
  const trimmedDescription = voiceDescription.trim();
  const canDesign = !disabled && !busy && trimmedDescription.length >= MIN_DESCRIPTION_CHARS;
  const canAudition = !disabled && !busy && voice.trim().length > 0;

  const auditionStats = useMemo(() => {
    const text = auditionText.trim();
    const words = text ? text.split(/\s+/).length : 0;
    return {
      words,
      secs: Math.round(words / WORDS_PER_SECOND),
      cost: (text.length / BASELINE_CHARS) * BASELINE_USD,
    };
  }, [auditionText]);

  const designedCount = samples.filter((s) => s.kind === 'designed').length;
  const visible = samples.filter((s) => (filter === 'all' ? true : s.kind === filter));
  // The filter only earns its row when both kinds are actually present.
  const showFilter = designedCount > 0 && designedCount < samples.length;

  const selectedIsDesigned = !!designedVoiceId && designedVoiceId === voice;
  const selectedLabel = voice.trim() || 'No voice selected';
  const selectedKind: string = selectedIsDesigned
    ? 'designed voice'
    : looksLikeVoiceId(voice)
      ? 'custom voice id'
      : voice.trim()
        ? 'preset'
        : 'nothing selected yet';

  const copyVoiceId = () => {
    if (!designedVoiceId || !navigator.clipboard) return;
    void navigator.clipboard.writeText(designedVoiceId).then(() => setCopied(true));
  };

  return (
    <section className="rounded-xl border border-border bg-card">
      {/* Header doubles as the answer to "what will this persona sound like?",
          which used to be buried in a text input three controls down. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2.5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <AudioLines className="h-4 w-4 text-[hsl(var(--chart-4))]" />
          Voice
        </h3>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          {selectedIsDesigned && (
            <Badge variant="secondary" className="h-5 gap-1 px-1.5 text-[10px]">
              <Sparkles className="h-3 w-3" />
              designed
            </Badge>
          )}
          <span
            className={cn(
              'min-w-0 truncate font-mono text-[11px]',
              voice.trim() ? 'text-foreground' : 'text-muted-foreground',
            )}
            title={`${selectedLabel} — ${selectedKind}`}
          >
            {selectedLabel}
          </span>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {lastError && (
          <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words">{lastError}</span>
          </p>
        )}

        {disabled && (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[11px] text-muted-foreground">
            <KeyRound className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
            {disabledReason || 'No text-to-speech key configured — designing and auditioning are off.'} Past voices
            below still play.
          </p>
        )}

        {/* ── Voice settings ───────────────────────────────────────────────
            Exposed rather than buried: "it sounds robotic" is fixed here, and
            the fix is not the dial most people reach for first. */}
        <details className="rounded-md border border-border/60">
          <summary className="cursor-pointer select-none px-2.5 py-2 text-[11px] text-muted-foreground hover:text-foreground">
            Voice settings — {models.find((m) => m.id === settings.model)?.label ?? settings.model} ·{' '}
            {Math.round(settings.stability * 100)}% stability · {Math.round(settings.style * 100)}% style
          </summary>
          <div className="space-y-3 border-t border-border/60 p-2.5">
            <div className="space-y-1">
              <Label className="text-[11px]">Model</Label>
              <Select value={settings.model} onValueChange={(v) => onSettingsChange({ ...settings, model: v })}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                {models.find((m) => m.id === settings.model)?.hint ?? ''}
              </p>
            </div>

            {DIALS.map((d) => {
              const value = settings[d.key];
              return (
                <div key={d.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label className="text-[11px]">{d.label}</Label>
                    <span className="tabular-nums text-[11px] text-foreground">
                      {d.percent ? `${Math.round(value * 100)}%` : value.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={d.min}
                    max={d.max}
                    step={d.step}
                    value={value}
                    onChange={(e) => onSettingsChange({ ...settings, [d.key]: Number(e.target.value) })}
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-[hsl(var(--primary))]"
                  />
                  <div className="flex justify-between text-[9px] text-muted-foreground">
                    <span>{d.low}</span>
                    <span>{d.high}</span>
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground">{d.hint}</p>
                </div>
              );
            })}

            <label className="flex items-center gap-2 text-[11px] text-foreground">
              <input
                type="checkbox"
                checked={settings.speakerBoost}
                onChange={(e) => onSettingsChange({ ...settings, speakerBoost: e.target.checked })}
                className="accent-[hsl(var(--primary))]"
              />
              Speaker boost
              <span className="text-[10px] text-muted-foreground">— sharpens identity, slightly less natural</span>
            </label>

            <p className="text-[10px] text-muted-foreground">
              Auditions and finished videos use the same settings, so what you hear is what ships. Re-audition after a
              change.
            </p>
          </div>
        </details>

        {/* ── 1. Where the voice comes from ───────────────────────────────── */}
        <Tabs value={source} onValueChange={(v) => setSource(v as VoiceSource)}>
          <TabsList className="grid h-8 w-full grid-cols-3">
            <TabsTrigger value="design" className="px-1 text-[11px]">
              Design
            </TabsTrigger>
            <TabsTrigger value="preset" className="px-1 text-[11px]">
              Preset
            </TabsTrigger>
            <TabsTrigger value="id" className="px-1 text-[11px]">
              Voice ID
            </TabsTrigger>
          </TabsList>

          <TabsContent value="design" className="mt-2.5 space-y-2">
            <Label htmlFor={descriptionId} className="text-[11px] text-muted-foreground">
              Describe a voice that does not exist — age, gender, accent, pace, texture.
            </Label>
            <Textarea
              id={descriptionId}
              value={voiceDescription}
              onChange={(e) => onVoiceDescriptionChange(e.target.value)}
              placeholder="A warm, unhurried woman in her early thirties, light American accent, slight vocal fry, speaks like she is explaining something to a friend"
              rows={3}
              className="text-xs"
              disabled={disabled}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="h-8 text-xs" onClick={onDesign} disabled={!canDesign}>
                <Wand2 className="h-3.5 w-3.5" />
                {designing ? 'Designing…' : 'Design this voice'}
              </Button>
              <span className="text-[10px] text-muted-foreground">
                {trimmedDescription.length < MIN_DESCRIPTION_CHARS
                  ? `${MIN_DESCRIPTION_CHARS - trimmedDescription.length} more characters — vague descriptions come back generic`
                  : 'Creates a new voice and saves it with an id you can reuse'}
              </span>
            </div>
            {designing && (
              <ElapsedProgress
                startedAt={designStartedAt}
                expectedSeconds={EXPECTED_SECONDS.design}
                label="Designing a voice that has never existed"
              />
            )}
          </TabsContent>

          <TabsContent value="preset" className="mt-2.5 space-y-2">
            {/* auto-fill rather than a fixed column count: the same grid has to
                survive a 320px sidebar and a full-width column. */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onVoiceChange(p.id)}
                  className={cn(
                    'rounded-md border px-2 py-1.5 text-left transition-colors',
                    voice === p.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/40',
                  )}
                >
                  <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                    {p.name}
                    {voice === p.id && <Check className="h-3 w-3 text-primary" />}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">{p.hint}</span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              Shared with every other creator on the vendor. Fine for a draft — design one when the persona matters.
            </p>
          </TabsContent>

          <TabsContent value="id" className="mt-2.5 space-y-2">
            <Label htmlFor={voiceIdFieldId} className="text-[11px] text-muted-foreground">
              A voice id already on the account
            </Label>
            <Input
              id={voiceIdFieldId}
              value={voice}
              onChange={(e) => onVoiceChange(e.target.value)}
              placeholder="21m00Tcm4TlvDq8ikWAM"
              className="h-8 font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Anything cloned or designed elsewhere on the account works here — audition it before you commit.
            </p>
          </TabsContent>
        </Tabs>

        {/* ── 2. Audition ─────────────────────────────────────────────────── */}
        <div className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="h-8 text-xs"
              onClick={() => onAudition()}
              disabled={!canAudition}
            >
              <Play className="h-3.5 w-3.5" />
              {auditioning ? 'Auditioning…' : 'Audition'}
            </Button>
            <span className="text-[10px] text-muted-foreground">
              {auditionStats.words} words · ~{seconds(auditionStats.secs)} · ~{usd(auditionStats.cost)}
            </span>
            <button
              type="button"
              onClick={() => setScriptOpen((o) => !o)}
              className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
              aria-expanded={scriptOpen}
              aria-controls={scriptId}
            >
              {scriptOpen ? 'Hide script' : 'Script'}
              <ChevronDown className={cn('h-3 w-3 transition-transform', scriptOpen && 'rotate-180')} />
            </button>
          </div>

          {/* Collapsed by default because the script is a constant you rarely
              touch — but it is one click away, since anyone judging a voice for
              a specific video wants to hear their own opening line in it. */}
          {scriptOpen && (
            <div className="space-y-1">
              <Textarea
                id={scriptId}
                value={auditionText}
                onChange={(e) => onAuditionTextChange(e.target.value)}
                rows={6}
                className="text-[11px] leading-relaxed"
              />
              <p className="text-[10px] text-muted-foreground">
                Built to expose pacing — a question, a long clause, numbers, an aside and a gear change. The same
                script for every voice is what makes two auditions comparable.
              </p>
            </div>
          )}

          {auditioning && (
            <ElapsedProgress
              startedAt={auditionStartedAt}
              expectedSeconds={EXPECTED_SECONDS.audition}
              label={`Speaking the audition as ${voice.trim() || 'the selected voice'}`}
            />
          )}

          {currentSample && !auditioning && (
            <div className="space-y-1.5 border-t border-border/60 pt-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[11px] font-medium text-foreground">Latest audition</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {seconds(currentSample.seconds)}
                </span>
                {designedVoiceId && (
                  <button
                    type="button"
                    onClick={copyVoiceId}
                    title="Copy the voice id"
                    className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    <Fingerprint className="h-3 w-3 shrink-0" />
                    <span className="truncate">{copied ? 'copied' : designedVoiceId}</span>
                    {!copied && <Copy className="h-2.5 w-2.5 shrink-0" />}
                  </button>
                )}
                <a
                  href={currentSample.url}
                  download
                  className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <Download className="h-3 w-3" />
                  Save clip
                </a>
              </div>
              <audio
                src={currentSample.url}
                controls
                className="h-8 w-full"
                ref={(el) => registerPlayer('current', el)}
                onPlay={() => soloPlayer('current')}
              />
              {/* Stated once, plainly: the vendor keeps the model, you keep the clip. */}
              <p className="text-[10px] text-muted-foreground">
                The voice model stays at the vendor and cannot be exported — this clip travels with the persona, and
                it is what a future re-clone would be built from.
              </p>
            </div>
          )}
        </div>

        {/* ── 3. The library of candidates ────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
              <Library className="h-3.5 w-3.5 text-muted-foreground" />
              Past voices
              <span className="font-normal text-muted-foreground">({samples.length})</span>
            </h4>
            {showFilter && (
              <div className="ml-auto flex items-center gap-1">
                {(['all', 'designed', 'sample'] as LibraryFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                      filter === f
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {f === 'all' ? 'All' : f === 'designed' ? 'Designed' : 'Clips'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {samples.length === 0 ? (
            <p className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-4 text-[11px] text-muted-foreground">
              <ListMusic className="h-3.5 w-3.5 shrink-0" />
              Nothing auditioned yet. Design a voice or pick a preset, then audition it — every take is kept here to
              compare against.
            </p>
          ) : (
            /* Capped height with its own scroll: the library grows without bound
               and must never push the audition controls off a sidebar. */
            <ul className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {visible.map((s) => {
                const selected = !!s.voiceId && s.voiceId === voice;
                const reusable = !!s.voiceId;
                return (
                  <li
                    key={s.file}
                    className={cn(
                      'space-y-1.5 rounded-md border p-2 transition-colors',
                      selected ? 'border-primary bg-primary/5' : 'border-border/60',
                    )}
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1">
                          {selected && <Check className="h-3 w-3 shrink-0 text-primary" />}
                          <span className="truncate text-[11px] text-foreground" title={s.label}>
                            {s.label}
                          </span>
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-muted-foreground">
                          {relTime(s.createdAt)}
                          <span aria-hidden>·</span>
                          {clipLength(s.seconds, s.bytes)}
                          {reusable ? (
                            <Badge variant="secondary" className="h-4 gap-0.5 px-1 text-[9px]">
                              <Sparkles className="h-2.5 w-2.5" />
                              reusable
                            </Badge>
                          ) : (
                            <span title="No voice id — this clip can be archived with a persona, but it cannot speak new lines.">
                              clip only
                            </span>
                          )}
                          {s.inUse && <Badge variant="outline" className="h-4 px-1 text-[9px]">in use</Badge>}
                        </span>
                      </span>

                      {/* Delete last and visually quietest — every neighbour here
                          is something you want to click freely while comparing. */}
                      {!s.inUse &&
                        (armedDelete === s.file ? (
                          <button
                            type="button"
                            onClick={() => {
                              onDeleteSample(s.file);
                              setArmedDelete(null);
                            }}
                            className="shrink-0 rounded px-1 text-[10px] text-destructive hover:underline"
                          >
                            Sure?
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setArmedDelete(s.file)}
                            aria-label={`Delete ${s.label}`}
                            title="Delete this clip from the server"
                            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        ))}
                    </div>

                    <audio
                      src={s.url}
                      controls
                      preload="none"
                      className="h-7 w-full"
                      ref={(el) => registerPlayer(s.file, el)}
                      onPlay={() => soloPlayer(s.file)}
                    />

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant={selected ? 'secondary' : 'outline'}
                        className="h-6 px-2 text-[10px]"
                        onClick={() => onUseSample(s)}
                        title={
                          reusable
                            ? 'Speak this persona in this voice'
                            : 'Keep this clip with the persona — it has no voice id, so it cannot speak new lines'
                        }
                      >
                        {selected ? 'In use' : reusable ? 'Use this voice' : 'Keep this clip'}
                      </Button>
                      {reusable && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => onAudition(s.voiceId ?? undefined)}
                          disabled={disabled || busy}
                          title="Re-speak the current audition script in this voice"
                        >
                          <Play className="h-2.5 w-2.5" />
                          Re-audition
                        </Button>
                      )}
                      <a
                        href={s.url}
                        download
                        className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                        title="Download this clip"
                      >
                        <Download className="h-3 w-3" />
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
