import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  Images,
  AlertTriangle,
  KeyRound,
  Maximize2,
  PenLine,
  RefreshCw,
  ScanFace,
  Sparkles,
  Trash2,
  UserRound,
  Wand2,
  X,
} from 'lucide-react';

/**
 * PersonaBuilder — the PORTRAIT half of persona creation.
 *
 * The portrait is the single most expensive and most re-used asset in this
 * tool: the video model animates the still, it never improves it, and every
 * future video wears that face. The old sidebar treated it like a form field —
 * a textarea, three dropdowns and a 48px thumbnail. This lays the same actions
 * out as the journey they actually are (look → capture → generate → judge →
 * refine), gives the result enough pixels to be judged, and keeps every paid
 * roll one click away.
 *
 * It owns no data: every value and every action is a prop, so the page keeps
 * the endpoints and this file keeps the flow.
 */

export interface PortraitRoll {
  file: string;
  url: string;
  createdAt: number;
  bytes: number;
  inUse: boolean;
}

export interface LookPreset {
  id: string;
  label: string;
  hint: string;
  mediumId: string;
  voice: string;
  description: string;
}

export interface CaptureMedium {
  id: string;
  label: string;
  hint: string;
}

/** A fixed set the presenter is filmed in. `ready` false = plate not on disk. */
export interface RoomPlate {
  id: string;
  label: string;
  hint: string;
  ready: boolean;
}

export interface PersonaBuilderProps {
  presets: LookPreset[];
  mediums: CaptureMedium[];
  rooms: RoomPlate[];
  roomId: string;
  onRoomChange: (id: string) => void;
  rolls: PortraitRoll[];
  description: string;
  onDescriptionChange: (v: string) => void;
  mediumId: string;
  onMediumChange: (v: string) => void;
  aspect: string;
  onAspectChange: (v: string) => void;
  editInstruction: string;
  onEditInstructionChange: (v: string) => void;
  preview: { file: string; url: string } | null;
  onSelectRoll: (roll: PortraitRoll) => void;
  onDeleteRoll: (file: string) => void;
  onApplyPreset: (preset: LookPreset) => void;
  onGenerate: () => void;
  onImprove: () => void;
  onClearPreview: () => void;
  generating: boolean;
  generatingStartedAt: number;
  editing: boolean;
  editingStartedAt: number;
  disabled: boolean;
  /**
   * Why it is disabled, in the operator's terms. A bare boolean can only say
   * "no", which forces this component to guess at a cause and state it as fact.
   */
  disabledReason?: string;
  /**
   * The last failure, kept until the next attempt. Toasts fade; a generation
   * that failed ninety seconds ago must still be able to say why, or the panel
   * just silently reverts and looks broken.
   */
  lastError?: string | null;
}

/**
 * Measured, not guessed: GPT Image 2 returned the first real portrait in 88s,
 * and an edit re-runs the same model on a smaller job. Being honest about the
 * wait is what makes the wait tolerable.
 */
const EXPECTED_SECONDS = { portrait: 90, edit: 75 } as const;

/** Per-call price of the image model. Shown everywhere a roll can be spent. */
const ROLL_USD = 0.2;

const ASPECTS: { value: string; label: string; hint: string; ratio: number }[] = [
  { value: '9:16', label: '9:16', hint: 'Shorts', ratio: 9 / 16 },
  { value: '16:9', label: '16:9', hint: 'YouTube', ratio: 16 / 9 },
  { value: '1:1', label: '1:1', hint: 'Square', ratio: 1 },
];

/**
 * Below this many characters a description is almost always a vague one, and
 * vague descriptions are what produce the smooth, symmetrical, obviously-AI
 * face. Warning early costs nothing; a bad roll costs $0.20 and 90 seconds.
 */
const THIN_DESCRIPTION_CHARS = 60;

function usd(n: number): string {
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function relTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * This component ships in a ~320px sidebar AND in a full-width column, so
 * viewport breakpoints (`lg:`) would be lying about the space it actually got.
 * Measure the box instead and branch on that.
 */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.getBoundingClientRect().width);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

/**
 * A progress bar for a call that cannot report progress.
 *
 * The image endpoints are single blocking HTTP requests — there is no
 * server-side percentage to poll, and a bare spinner for ninety seconds reads
 * as a hang rather than as work. So this estimates from elapsed time and
 * deliberately stops short of 100%: a bar pinned at 100% while still waiting
 * is a lie, one easing towards 96% is an honest estimate, and the elapsed
 * seconds beside it are the ground truth when the estimate is wrong.
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
    <div className="space-y-1.5">
      <Progress value={pct} className="h-1.5" />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums">
          {pct}% · {Math.round(elapsed)}s
          {over ? ' — longer than usual, still going' : ` of ~${expectedSeconds}s`}
        </span>
      </div>
    </div>
  );
}

const STEPS = [
  { n: 1, label: 'Look', icon: PenLine },
  { n: 2, label: 'Capture', icon: Camera },
  { n: 3, label: 'Generate', icon: Sparkles },
  { n: 4, label: 'Judge', icon: ScanFace },
] as const;

/** The whole point of the redesign: you can always see where you are. */
function StepRail({ current, showLabels }: { current: number; showLabels: boolean }) {
  return (
    <ol className="flex items-center gap-1">
      {STEPS.map((s, i) => {
        const done = current > s.n;
        const active = current === s.n;
        const Icon = s.icon;
        return (
          <li key={s.n} className="flex min-w-0 items-center gap-1">
            <span
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
                active && 'border-primary bg-primary/10 text-foreground',
                done && 'border-[hsl(var(--chart-2))]/40 text-[hsl(var(--chart-2))]',
                !active && !done && 'border-border text-muted-foreground',
              )}
            >
              {done ? <Check className="h-3 w-3" /> : <Icon className="h-3 w-3" />}
              {(showLabels || active) && <span className="truncate">{s.label}</span>}
            </span>
            {i < STEPS.length - 1 && (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SectionHeading({
  n,
  title,
  blurb,
  accent,
}: {
  n: number;
  title: string;
  blurb: string;
  accent?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
            accent
              ? 'bg-[hsl(var(--chart-4))]/15 text-[hsl(var(--chart-4))]'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {n}
        </span>
        {title}
      </h3>
      <p className="text-xs leading-relaxed text-muted-foreground">{blurb}</p>
    </div>
  );
}

export default function PersonaBuilder(props: PersonaBuilderProps): JSX.Element {
  const {
    presets,
    mediums,
    rooms,
    roomId,
    onRoomChange,
    rolls,
    description,
    onDescriptionChange,
    mediumId,
    onMediumChange,
    aspect,
    onAspectChange,
    editInstruction,
    onEditInstructionChange,
    preview,
    onSelectRoll,
    onDeleteRoll,
    onApplyPreset,
    onGenerate,
    onImprove,
    onClearPreview,
    generating,
    generatingStartedAt,
    editing,
    editingStartedAt,
    disabled,
    disabledReason,
    lastError,
  } = props;

  const [root, width] = useMeasuredWidth();
  const [zoomed, setZoomed] = useState(false);
  // Deleting a roll destroys $0.20 and 90 seconds of work, so it asks first.
  const [pendingDelete, setPendingDelete] = useState<PortraitRoll | null>(null);

  // Width 0 is the pre-measurement frame; treating it as narrow means the first
  // paint is the safe one and only wide containers ever reflow.
  const twoColumn = width >= 720;
  const roomyGrid = width >= 460;

  const busy = generating || editing;
  const hasDescription = description.trim().length > 0;
  const step = generating ? 3 : preview ? 4 : hasDescription ? 2 : 1;

  const activePresetId = useMemo(
    () => presets.find((p) => p.description === description)?.id ?? null,
    [presets, description],
  );
  const selectedMedium = mediums.find((m) => m.id === mediumId) ?? null;
  const activeAspect = ASPECTS.find((a) => a.value === aspect) ?? ASPECTS[0];
  const spentOnRolls = rolls.length * ROLL_USD;

  const generateBlocker = disabled
    ? disabledReason || 'No image key configured — add one in Settings before generating.'
    : !hasDescription
      ? 'Pick a starting look or describe the presenter first.'
      : !mediumId && mediums.length > 0
        ? 'Choose how the shot was captured — it is what decides whether this reads as real.'
        : null;

  const gridStyle = { gridTemplateColumns: `repeat(auto-fill, minmax(${roomyGrid ? 96 : 76}px, 1fr))` };

  // A failure has to outlive the toast that announced it: the operator may have
  // been elsewhere for the ninety seconds this took.
  const errorBanner = lastError ? (
    <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive">
      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">{lastError}</span>
    </p>
  ) : null;

  // ── Compose: look, capture, generate ──────────────────────────────────────
  const composeColumn = (
    <div className={cn('space-y-5', twoColumn && 'w-[360px] shrink-0')}>
      <section className="space-y-2.5">
        <SectionHeading
          n={1}
          title="Starting look"
          blurb="Start from a person we already wrote, or describe your own. A preset also suggests a matching voice."
        />

        {presets.length > 0 && (
          <div className="grid gap-1.5" style={{ gridTemplateColumns: roomyGrid ? '1fr 1fr' : '1fr' }}>
            {presets.map((p) => {
              const active = activePresetId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onApplyPreset(p)}
                  className={cn(
                    'rounded-lg border p-2 text-left transition-colors',
                    active
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/50 hover:bg-muted/40',
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {p.label}
                    </span>
                    {active && <Check className="h-3 w-3 shrink-0 text-primary" />}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                    {p.hint}
                  </span>
                  {p.voice && (
                    <span className="mt-1 block truncate text-[10px] text-muted-foreground/80">
                      voice · {p.voice}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <Textarea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="A 34-year-old man with short dark hair and light stubble, wearing a charcoal crewneck, in a softly lit home office"
          rows={4}
          className="text-sm leading-relaxed"
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {hasDescription && description.trim().length < THIN_DESCRIPTION_CHARS ? (
            <span className="text-[hsl(var(--chart-4))]">
              That is thin. Add age, build, hair, clothing and the room — vague descriptions come back
              smooth and symmetrical, which is exactly what reads as AI.
            </span>
          ) : (
            <>Framing, even light and a closed mouth are added for you — the video model needs those.</>
          )}
        </p>
      </section>

      {/* A fixed room beats a described one for anything with more than one
          video in it: words give you the right KIND of room every time, and a
          different one each time. */}
      {rooms.length > 0 && (
        <section className="space-y-2.5 rounded-lg border border-border p-3">
          <SectionHeading
            n={2}
            title="Which room?"
            blurb="Pick a set and the presenter is photographed in that exact room every time — same wall, same window, same shelf. Leave it off to have the room described in words instead, which varies roll to roll."
          />
          <div className="grid gap-1.5" style={{ gridTemplateColumns: roomyGrid ? '1fr 1fr' : '1fr' }}>
            <button
              type="button"
              aria-pressed={!roomId}
              onClick={() => onRoomChange('')}
              className={cn(
                'rounded-lg border p-2 text-left transition-colors',
                !roomId ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-muted-foreground/50',
              )}
            >
              <span className="block truncate text-xs font-medium text-foreground">No fixed room</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                Describe the room in words below
              </span>
            </button>
            {rooms.map((r) => {
              const active = r.id === roomId;
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={active}
                  disabled={!r.ready}
                  title={r.ready ? undefined : 'This room has no plate on the server yet'}
                  onClick={() => onRoomChange(r.id)}
                  className={cn(
                    'rounded-lg border p-2 text-left transition-colors',
                    active ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-muted-foreground/50',
                    !r.ready && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <span className="block truncate text-xs font-medium text-foreground">{r.label}</span>
                  <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                    {r.ready ? r.hint : 'Plate missing on the server'}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Promoted out of the bottom dropdown it used to live in: this one field
          moves the result further than the entire description does. */}
      <section className={cn(
        'space-y-2.5 rounded-lg border border-[hsl(var(--chart-4))]/30 bg-[hsl(var(--chart-4))]/5 p-3',
        // A plate carries its own camera, light and grade, so the medium has
        // nothing left to decide. Dimmed rather than hidden: it explains why.
        roomId && 'pointer-events-none opacity-40',
      )}>
        <SectionHeading
          n={3}
          accent
          title="How was it shot?"
          blurb="The biggest realism lever there is. With no stated capture medium the model blends every style it knows into a half-CGI look."
        />

        {roomId ? (
          <p className="text-xs text-muted-foreground">
            Set by the room you picked — its camera, lighting and grade come from the plate.
          </p>
        ) : mediums.length === 0 ? (
          <p className="text-xs text-muted-foreground">No capture mediums available from the server.</p>
        ) : (
          <div className="grid gap-1.5" style={{ gridTemplateColumns: roomyGrid ? '1fr 1fr' : '1fr' }}>
            {mediums.map((m) => {
              const active = m.id === mediumId;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onMediumChange(m.id)}
                  className={cn(
                    'rounded-lg border p-2 text-left transition-colors',
                    active
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-card hover:border-muted-foreground/50',
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <Camera
                      className={cn('h-3 w-3 shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                      {m.label}
                    </span>
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                    {m.hint}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2.5">
        <SectionHeading
          n={3}
          title="Generate"
          blurb="One roll is one new face. Refining an existing portrait keeps the person; re-rolling does not."
        />

        <div className="space-y-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Frame</span>
          <div className="flex gap-1.5">
            {ASPECTS.map((a) => (
              <button
                key={a.value}
                type="button"
                aria-pressed={a.value === aspect}
                onClick={() => onAspectChange(a.value)}
                className={cn(
                  'flex-1 rounded-md border px-2 py-1.5 text-center transition-colors',
                  a.value === aspect
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-muted-foreground/50',
                )}
              >
                <span className="block text-xs font-medium text-foreground">{a.label}</span>
                <span className="block text-[10px] text-muted-foreground">{a.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <Button
          className="h-10 w-full"
          onClick={onGenerate}
          disabled={busy || generateBlocker !== null}
        >
          <Sparkles className={cn('h-4 w-4', generating && 'animate-pulse')} />
          {generating ? 'Generating…' : preview ? 'Roll a new face' : 'Generate portrait'}
        </Button>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1 tabular-nums">
            <Clock className="h-3 w-3" /> ~{EXPECTED_SECONDS.portrait}s
          </span>
          <span className="tabular-nums">{usd(ROLL_USD)} per roll</span>
          {selectedMedium && <span className="truncate">shot as {selectedMedium.label.toLowerCase()}</span>}
        </div>

        {generateBlocker && (
          <p
            className={cn(
              'flex items-start gap-1.5 text-[11px]',
              disabled ? 'text-[hsl(var(--chart-5))]' : 'text-muted-foreground',
            )}
          >
            {disabled && <KeyRound className="mt-0.5 h-3 w-3 shrink-0" />}
            {generateBlocker}
          </p>
        )}

        {generating && (
          <ElapsedProgress
            startedAt={generatingStartedAt}
            expectedSeconds={EXPECTED_SECONDS.portrait}
            label="Painting the portrait"
          />
        )}
      </section>
    </div>
  );

  // ── Stage: the portrait, big enough to actually judge ─────────────────────
  const stageColumn = (
    <div className="min-w-0 flex-1 space-y-3">
      <div
        className="relative overflow-hidden rounded-xl border border-border bg-muted/30"
        style={{
          aspectRatio: String(activeAspect.ratio),
          maxHeight: '68vh',
          maxWidth: `calc(68vh * ${activeAspect.ratio})`,
          margin: '0 auto',
        }}
      >
        {preview ? (
          <>
            <img
              src={preview.url}
              alt="Generated portrait"
              className={cn(
                'h-full w-full object-cover transition-opacity',
                editing && 'opacity-40',
              )}
            />
            <div className="absolute right-2 top-2 flex gap-1">
              <Button
                size="icon"
                variant="secondary"
                className="h-7 w-7 opacity-90"
                title="View full size"
                aria-label="View full size"
                onClick={() => setZoomed(true)}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
              <Button
                asChild
                size="icon"
                variant="secondary"
                className="h-7 w-7 opacity-90"
                title="Download this portrait"
              >
                <a href={preview.url} download aria-label="Download this portrait">
                  <Download className="h-3.5 w-3.5" />
                </a>
              </Button>
              <Button
                size="icon"
                variant="secondary"
                className="h-7 w-7 opacity-90"
                title="Clear this portrait"
                aria-label="Clear this portrait"
                onClick={onClearPreview}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
            {editing && (
              <div className="absolute inset-x-3 bottom-3 rounded-md border border-border bg-card/95 p-2">
                <ElapsedProgress
                  startedAt={editingStartedAt}
                  expectedSeconds={EXPECTED_SECONDS.edit}
                  label="Applying the change, keeping the same person"
                />
              </div>
            )}
          </>
        ) : generating ? (
          <div className="flex h-full w-full animate-pulse flex-col items-center justify-center gap-2 bg-muted/60 p-4 text-center">
            <Sparkles className="h-6 w-6 text-[hsl(var(--chart-4))]" />
            <p className="text-xs text-muted-foreground">
              Building a face that does not exist. About a minute and a half.
            </p>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 border border-dashed border-border/60 p-4 text-center">
            <UserRound className="h-7 w-7 text-muted-foreground/40" />
            <p className="max-w-[24ch] text-xs text-muted-foreground">
              Your portrait lands here at {activeAspect.label} — large enough to judge before you commit
              to it.
            </p>
          </div>
        )}
      </div>

      {preview && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <CheckCircle2 className="h-3 w-3 text-[hsl(var(--chart-2))]" />
              Selected for this persona
            </Badge>
            <span className="text-muted-foreground">
              Check: eyes level and open, mouth closed, light even on both cheeks, ears and hands unwarped.
            </span>
          </div>

          {/* Step 5 — refine beats re-roll: it costs the same but keeps the
              person you already approved, which a fresh roll never does. */}
          <div className="space-y-2 rounded-lg border border-border bg-card p-3">
            <div className="space-y-0.5">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Wand2 className="h-4 w-4 text-muted-foreground" />
                Refine, or roll again
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Change one thing in plain language. The face stays; the result is saved as a new roll, so
                the original survives.
              </p>
            </div>
            <div className={cn('flex gap-1.5', roomyGrid ? 'flex-row' : 'flex-col')}>
              <Input
                value={editInstruction}
                onChange={(e) => onEditInstructionChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy && editInstruction.trim()) onImprove();
                }}
                placeholder="Warmer light, slightly older, no glasses, darker sweater…"
                disabled={disabled}
                className="h-9 flex-1 text-sm"
              />
              <Button
                variant="secondary"
                className="h-9 shrink-0"
                onClick={onImprove}
                disabled={busy || disabled || !editInstruction.trim()}
              >
                <Wand2 className="h-3.5 w-3.5" />
                {editing ? 'Applying…' : 'Apply change'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1 tabular-nums">
                <Clock className="h-3 w-3" /> ~{EXPECTED_SECONDS.edit}s
              </span>
              <span className="tabular-nums">{usd(ROLL_USD)}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={onGenerate}
                disabled={busy || generateBlocker !== null}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', generating && 'animate-spin')} />
                Re-roll a different face
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Rolls are files on disk that already cost money — the gallery is the
          reason a re-roll is never a loss. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Images className="h-4 w-4 text-muted-foreground" />
            Your rolls
            <span className="text-xs font-normal text-muted-foreground">({rolls.length})</span>
          </h3>
          {rolls.length > 0 && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {usd(spentOnRolls)} of portraits kept
            </span>
          )}
        </div>

        {rolls.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing rolled yet. Every roll is kept on the server — at {usd(ROLL_USD)} and{' '}
            {EXPECTED_SECONDS.portrait} seconds each, none of them are thrown away for you.
          </p>
        ) : (
          <div className="grid gap-2" style={gridStyle}>
            {rolls.map((r) => {
              const active = preview?.file === r.file;
              return (
                <div key={r.file} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelectRoll(r)}
                    aria-pressed={active}
                    title={`${relTime(r.createdAt)} · ${fileSize(r.bytes)}${
                      r.inUse ? ' · already used by a persona' : ''
                    }`}
                    className={cn(
                      'block w-full overflow-hidden rounded-lg border transition-colors',
                      active
                        ? 'border-primary ring-2 ring-primary'
                        : 'border-border hover:border-muted-foreground/60',
                    )}
                  >
                    <img
                      src={r.url}
                      alt={`Portrait rolled ${relTime(r.createdAt)}`}
                      loading="lazy"
                      className="aspect-[3/4] w-full object-cover"
                    />
                    <span className="block truncate px-1 py-0.5 text-[10px] text-muted-foreground">
                      {relTime(r.createdAt)}
                    </span>
                  </button>
                  {r.inUse ? (
                    <span
                      title="In use by a persona"
                      className="absolute -right-1 -top-1 rounded-full bg-[hsl(var(--chart-2))] p-0.5 text-background"
                    >
                      <Check className="h-2.5 w-2.5" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(r)}
                      title="Delete this roll from the server"
                      aria-label="Delete this roll from the server"
                      className="absolute -right-1 -top-1 rounded-full border border-border bg-background p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div ref={root} className="rounded-xl border border-border bg-card p-4">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="rounded-md bg-[hsl(var(--chart-4))]/10 p-2 text-[hsl(var(--chart-4))]">
            <UserRound className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">Portrait</h2>
            <p className="text-xs text-muted-foreground">
              The face every video wears. The video model animates this still — it never improves it.
            </p>
          </div>
        </div>
        {rolls.length > 0 && (
          <Badge variant="outline" className="shrink-0 gap-1 tabular-nums">
            <Images className="h-3 w-3" />
            {rolls.length} · {usd(spentOnRolls)}
          </Badge>
        )}
      </header>

      {errorBanner && <div className="mb-3">{errorBanner}</div>}

      <div className="mb-4">
        <StepRail current={step} showLabels={width >= 420} />
      </div>

      <div className={cn('flex flex-col gap-6', twoColumn && 'flex-row')}>
        {/* In a narrow container the portrait outranks the form the moment one
            exists — you came back to look at it, not to re-read the presets. */}
        <div className={cn(!twoColumn && preview && 'order-2')}>{composeColumn}</div>
        <div className={cn('min-w-0 flex-1', !twoColumn && preview && 'order-1')}>{stageColumn}</div>
      </div>

      <Dialog open={zoomed && preview !== null} onOpenChange={setZoomed}>
        <DialogContent className="max-w-[92vw] p-2 sm:max-w-3xl">
          <DialogTitle className="sr-only">Portrait, full size</DialogTitle>
          {preview && (
            <img
              src={preview.url}
              alt="Generated portrait, full size"
              className="max-h-[82vh] w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this roll?</AlertDialogTitle>
            <AlertDialogDescription>
              It cost {usd(ROLL_USD)} and about {EXPECTED_SECONDS.portrait} seconds, and it is deleted
              from the server for good. Re-rolling never reproduces the same face.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) onDeleteRoll(pendingDelete.file);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
