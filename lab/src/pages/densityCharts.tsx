/**
 * The density scorecard's charts.
 *
 * ⚠️ NOTHING IN THIS FILE KNOWS A THRESHOLD. Every band edge, every par line,
 * every rule and every label number arrives inside the scorecard document that
 * `hfp density` produced from hfp/density.py. There is no constant here to
 * drift out of step with the code that actually rejects a cue sheet — the only
 * numbers written below are pixel geometry.
 *
 * Three forms, chosen for what each defect actually is:
 *
 *   BandChart  → counts against a measured band. Diverging around 1.0, which is
 *                a real midpoint (target), not a decorative one.
 *   FilmStrip  → the structural defects. R002 = 76 is a number; one bar spanning
 *                708 seconds of an 881-second film is the defect. Same for the
 *                265.9s hole and the 126.8s block drawn against its own ceiling.
 *   PushStrip  → a distribution against one rule. Amber, because it is a note.
 *
 * COLOUR CONTRACT, one meaning per hue across all three:
 *   --viz-mine    this edit, inside the band / a reset
 *   --viz-under   out of band, either direction (direction carries which)
 *   --viz-market  the bulk population (pushes, reference)
 *   --viz-warn    a warning, never a blocker
 * Direction and position carry under-vs-over as well as colour, so nothing here
 * depends on telling red from blue.
 *
 * ⚠️ Meaning-gated codes get NO bar. Rendering R016/R017/R018/R020 as a failing
 * row invites manufacturing a montage or a subscribe request, which is the exact
 * failure density.py's own comment was written to prevent. They render as plain
 * grey text in their own group.
 *
 * ⚠️ No "more is better" affordance anywhere. Over the ceiling is a defect.
 */
import { useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { VIZ_STYLE } from './auditCharts';
import type {
  DensityElement,
  DensityFinding,
  DensityScorecard,
} from 'zite-endpoints-sdk';

/* ── palette ──────────────────────────────────────────────────────────────
   auditCharts' roles verbatim, plus one: --viz-warn. A warn must not be able
   to read as a blocker, so it cannot borrow --viz-under.                   */
export const DENSITY_VIZ_STYLE = `${VIZ_STYLE}
.viz { --viz-warn: #b46b00; }
@media (prefers-color-scheme: dark) {
  :root:not(.light) .viz { --viz-warn: #e0a13a; }
}
:root.dark .viz { --viz-warn: #e0a13a; }
.viz .viz-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.viz .viz-hit { cursor: pointer; }
.viz .viz-hit:hover rect, .viz .viz-hit:hover circle { opacity: 0.75; }
`;

/* ── shared formatting ─────────────────────────────────────────────────── */

/** m:ss — the only timecode form on the page, so two marks are comparable. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "4m 26s" — for durations, where a timecode would read as a position. */
export function human(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

// ⚠️ ACCEPTS null. hfp emits null for a measurement that does not exist (no
// push span, no screencast block) rather than 0, and an em dash is the only
// honest rendering of "there was nothing to measure".
const num = (n: number | null | undefined, dp = 1): string =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(dp).replace(/\.0$/, '') : '—';

/* ── Legend and TableView ──────────────────────────────────────────────────
   Copied from auditCharts.tsx:65-118 rather than exported from it. That file
   belongs to the channel audit and ChannelAuditPage depends on its exact
   surface; widening it to serve a second page is not this tool's business. */

/** Identity is never colour alone. */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mb-2 flex flex-wrap gap-3 text-xs" style={{ color: 'var(--viz-ink-2)' }}>
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** The same numbers as a table — the accessibility fallback for every chart. */
export function TableView({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs underline"
        style={{ color: 'var(--viz-ink-2)' }}
      >
        {open ? 'Hide the numbers' : 'Show the numbers'}
      </button>
      {open && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                {head.map((h) => (
                  <th key={h} className="border-b border-border px-2 py-1 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="border-b border-border px-2 py-1 whitespace-nowrap">
                      {typeof c === 'number' ? c.toLocaleString() : c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── 1. BandChart — counts against the measured band ──────────────────────
   One shared x-axis for every row: actual ÷ target, so 1.0 is target for all
   of them and rows with wildly different scales (R002 wants 39, R009 wants 1)
   are comparable at a glance. The band rect is floor÷target … ceiling÷target,
   which is what actually judges; the par line is where the measurement says
   the eight reference videos sat.                                          */

const BAND_W = 1000;
/**
 * The props that make an SVG mark operable, not merely clickable.
 *
 * ⚠️ A <g> WITH onClick IS UNREACHABLE BY KEYBOARD. It is not a button and gets
 * no focus, so without these props a keyboard-only operator can open the detail
 * panel for the dead stretch and for a screencast block — both of which have
 * real <button>s elsewhere on the page — and for no other mark on any strip.
 * Spread this onto every mark that takes an onPick; never hand-roll onClick.
 */
function hit(label: string, activate: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': label,
    onClick: activate,
    onKeyDown: (ev: ReactKeyboardEvent<SVGGElement>) => {
      // Enter and Space are what a native button answers to; matching it is the
      // whole point of claiming role="button".
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        activate();
      }
    },
  };
}

const BAND_LABEL_W = 190;
const BAND_RIGHT_W = 130;
const BAND_PLOT_W = BAND_W - BAND_LABEL_W - BAND_RIGHT_W;

/** A row can only be drawn if it has a par to divide by. */
function scorable(e: DensityElement): boolean {
  return !e.meaningGated && typeof e.target === 'number' && e.target > 0;
}

function bandRow(e: DensityElement) {
  const target = e.target as number;
  return {
    e,
    ratio: e.actual / target,
    floorRatio: typeof e.floor === 'number' ? e.floor / target : 0,
    ceilRatio: typeof e.ceiling === 'number' ? e.ceiling / target : null,
    // How far out of the band it is — the sort key, so the worst row is first.
    dev:
      e.verdict === 'ok'
        ? 0
        : Math.abs(e.actual / target - 1),
  };
}

export function BandChart({
  elements,
  findings,
  onPick,
}: {
  elements: DensityElement[];
  findings: DensityFinding[];
  onPick?: (start: number, end: number, label: string) => void;
}) {
  const [showInBand, setShowInBand] = useState(false);

  // ⚠️ TWO DIFFERENT REASONS A ROW CANNOT BE SCORED, AND THEY MUST NOT SHARE A
  // CAPTION. R016/R017/R018/R020 are deliberately untargeted — a count would be
  // an instruction to manufacture the moment. A code with no measured rate yet
  // is simply unmeasured, and calling that a deliberate design decision states
  // something nobody decided.
  const gated = elements.filter((e) => e.meaningGated);
  const unmeasured = elements.filter((e) => !e.meaningGated && !scorable(e));
  const scored = elements.filter(scorable).map(bandRow);
  const out = scored.filter((r) => r.e.verdict !== 'ok').sort((a, b) => b.dev - a.dev);
  const inBand = scored.filter((r) => r.e.verdict === 'ok');

  const rows = showInBand ? [...out, ...inBand] : out;
  if (!rows.length && !gated.length) return null;

  const max = Math.max(
    2,
    ...rows.map((r) => r.ratio),
    ...rows.map((r) => r.ceilRatio ?? 0),
  );
  const x = (v: number) => BAND_LABEL_W + (BAND_PLOT_W * Math.min(v, max)) / max;

  const rowH = 32;
  const barH = 20;
  const h = Math.max(1, rows.length) * rowH + 26;
  const par = x(1);

  const ticks: number[] = [0, 1, 2];
  if (max > 2.4) ticks.push(Math.round(max * 10) / 10);

  const findingFor = (code: string) => findings.find((f) => f.element === code);

  const bandLabel = (e: DensityElement) =>
    typeof e.ceiling === 'number'
      ? `${e.actual} of ${e.floor}–${e.ceiling}`
      : `${e.actual} of ${e.floor}+`;

  return (
    <div className="viz">
      <Legend
        items={[
          { label: 'inside the band', color: 'var(--viz-mine)' },
          { label: 'out of band', color: 'var(--viz-under)' },
          { label: 'the measured band (floor…ceiling)', color: 'var(--viz-band)' },
        ]}
      />
      <div className="overflow-x-auto">
        <div className="min-w-[680px]">
          <svg
            viewBox={`0 0 ${BAND_W} ${h}`}
            width="100%"
            height={h}
            role="img"
            aria-label="Each element's count against the band measured from the reference videos"
          >
            {/* axis */}
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={x(t)}
                  y1={0}
                  x2={x(t)}
                  y2={h - 20}
                  stroke="var(--viz-grid)"
                  strokeWidth={t === 1 ? 1.5 : 1}
                  strokeDasharray={t === 1 ? undefined : '2 3'}
                />
                <text x={x(t)} y={h - 6} textAnchor="middle" style={{ fontSize: 10 }}>
                  {t === 1 ? '1.0 = target' : `${num(t)}×`}
                </text>
              </g>
            ))}

            {rows.map((r, i) => {
              const y = i * rowH;
              const e = r.e;
              const finding = findingFor(e.code);
              const barX = x(r.ratio);
              const under = r.ratio < 1;
              const bandX0 = x(r.floorRatio);
              const bandX1 = x(r.ceilRatio ?? max);
              const tip =
                finding?.message ??
                `${e.code} ${e.name} — ${e.actual} fired, band ${e.floor}–${
                  e.ceiling ?? '∞'
                }, target ${num(e.target as number, 2)}`;
              return (
                <g
                  key={e.code}
                  className={onPick && e.at.length ? 'viz-hit' : undefined}
                  {...(onPick && e.at.length
                    ? hit(`${e.code} ${e.name} — first of ${e.at.length}`, () =>
                        onPick(e.at[0], e.at[0] + 6, `${e.code} ${e.name} — first of ${e.at.length}`),
                      )
                    : {})}
                >
                  <title>{tip}</title>

                  <text x={0} y={y + barH / 2 + 4} className="viz-mono viz-label" style={{ fontSize: 11 }}>
                    {e.code}
                  </text>
                  <text x={46} y={y + barH / 2 + 4} style={{ fontSize: 11 }}>
                    {e.name.length > 24 ? `${e.name.slice(0, 23)}…` : e.name}
                  </text>

                  {/* the band itself */}
                  <rect
                    x={bandX0}
                    y={y}
                    width={Math.max(2, bandX1 - bandX0)}
                    height={barH}
                    rx={3}
                    fill="var(--viz-band)"
                  />
                  {/* ceiling edge, drawn as heavily as the floor edge — over is a
                      defect, and a row that only shows a floor reads as a target
                      to beat. */}
                  {r.ceilRatio !== null && (
                    <line
                      x1={bandX1}
                      y1={y - 2}
                      x2={bandX1}
                      y2={y + barH + 2}
                      stroke="var(--viz-ink-2)"
                      strokeWidth={1}
                    />
                  )}
                  <line
                    x1={bandX0}
                    y1={y - 2}
                    x2={bandX0}
                    y2={y + barH + 2}
                    stroke="var(--viz-ink-2)"
                    strokeWidth={1}
                  />

                  {/* the count */}
                  <rect
                    x={under ? barX : par}
                    y={y + 4}
                    width={Math.max(2, Math.abs(barX - par))}
                    height={barH - 8}
                    rx={2}
                    fill={e.verdict === 'ok' ? 'var(--viz-mine)' : 'var(--viz-under)'}
                  />

                  <text
                    x={BAND_W - BAND_RIGHT_W + 10}
                    y={y + barH / 2 + 4}
                    className="viz-label"
                    style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {bandLabel(e)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {inBand.length > 0 && (
        <button
          type="button"
          onClick={() => setShowInBand((v) => !v)}
          className="mt-1 rounded-md bg-green-500/15 px-2.5 py-1 text-xs text-green-400"
        >
          {showInBand
            ? `Hide the ${inBand.length} element${inBand.length === 1 ? '' : 's'} already in range`
            : `${inBand.length} element${inBand.length === 1 ? '' : 's'} in range — show`}
        </button>
      )}

      {gated.length > 0 && (
        <div className="mt-3 rounded-md border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Fires when the narration does — no target
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            These are not scored and never will be. A count here would be an instruction to
            manufacture the moment.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {gated.map((e) => (
              <span key={e.code}>
                <span className="font-mono">{e.code}</span> {e.name} — fired {e.actual}
              </span>
            ))}
          </div>
        </div>
      )}

      {unmeasured.length > 0 && (
        <div className="mt-3 rounded-md border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">
            No measured rate — not scored here
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            These fired but carry no target, because the eight reference videos have not been
            measured for them. That is a gap in the evidence, not a decision to leave them
            unscored.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {unmeasured.map((e) => (
              <span key={e.code}>
                <span className="font-mono">{e.code}</span> {e.name} — fired {e.actual}
              </span>
            ))}
          </div>
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">
        A count above the ceiling is a defect, not a bonus — the ceiling edge is drawn as heavily
        as the floor for exactly that reason.
      </p>

      <TableView
        head={['Code', 'Name', 'Fired', 'Target', 'Floor', 'Ceiling', 'Ref/min', 'This edit/min', 'Verdict']}
        rows={elements.map((e) => [
          e.code,
          e.name,
          e.actual,
          e.target === null ? 'no target' : num(e.target, 2),
          e.floor === null ? '—' : e.floor,
          e.ceiling === null ? '—' : e.ceiling,
          num(e.referenceRate, 2),
          num(e.actualRate, 2),
          e.verdict,
        ])}
      />
    </div>
  );
}

/* ── 2. FilmStrip — where the structural defects actually are ─────────────
   Four lanes on one shared time axis. Everything is clickable; clicking asks
   the server what is being said over that span, which is the difference
   between "a red bar" and "he is explaining GPTs vs Gems with a dead frame". */

const STRIP_W = 1000;

export function FilmStrip({
  scorecard,
  onPick,
}: {
  scorecard: DensityScorecard;
  onPick: (start: number, end: number, label: string) => void;
}) {
  const dur = scorecard.edit.durationSeconds;
  if (!(dur > 0)) return null;
  const x = (t: number) => (Math.max(0, Math.min(t, dur)) / dur) * STRIP_W;
  const w = (a: number, b: number) => Math.max(1.5, x(b) - x(a));

  const step = dur <= 1200 ? 60 : dur <= 3600 ? 300 : 600;
  const ticks: number[] = [];
  for (let t = 0; t <= dur; t += step) ticks.push(t);

  // Lane geometry. Labels sit ABOVE each lane so the strip stays readable at
  // phone width without a second layout.
  const RULER_Y = 14;
  const SC_LABEL = 36;
  const SC_Y = 42;
  const SC_H = 26;
  const G_LABEL = 90;
  const G_Y = 96;
  const G_H = 16;
  const M_LABEL = 134;
  const CHAIN_Y = 140;
  const CHAIN_H = 12;
  const SPAN_Y = 158;
  const SPAN_H = 12;
  const H = 182;

  const blockMax = scorecard.thresholds.screencastBlockMaxSeconds;
  const gap = scorecard.graphics.longestGap;

  // Which motion is the bulk of the edit? Data decides, not a hardcoded code —
  // the modal motion is the population, everything else is a change of state.
  const tally: Record<string, number> = {};
  for (const s of scorecard.movement.spans) tally[s.motion] = (tally[s.motion] ?? 0) + 1;
  let bulk = '';
  for (const [code, n] of Object.entries(tally)) if (!bulk || n > tally[bulk]) bulk = code;
  const nameOf = (code: string) =>
    scorecard.elements.find((e) => e.code === code)?.name ?? code;

  // Graphics marks: every occurrence of every code that counts as a graphic.
  // Chains of more than one span of the bulk motion — the runs that never reset.
  const unbrokenRuns = scorecard.movement.chains.filter(
    (c) => c.spans > 1 && c.motion === bulk,
  ).length;

  const graphicCodes = new Set(scorecard.thresholds.graphics);
  const graphicMarks: { at: number; code: string; name: string }[] = [];
  for (const e of scorecard.elements) {
    if (!graphicCodes.has(e.code)) continue;
    for (const at of e.at) graphicMarks.push({ at, code: e.code, name: e.name });
  }
  graphicMarks.sort((a, b) => a.at - b.at);

  return (
    <div className="viz">
      <Legend
        items={[
          { label: `${nameOf(bulk)} (the bulk)`, color: 'var(--viz-market)' },
          { label: 'a change of state', color: 'var(--viz-mine)' },
          { label: 'over the measured limit', color: 'var(--viz-under)' },
        ]}
      />
      <div className="overflow-x-auto">
        <div className="min-w-[720px]">
          <svg
            viewBox={`0 0 ${STRIP_W} ${H}`}
            width="100%"
            height={H}
            role="img"
            aria-label={`The whole ${human(dur)} edit: screencast blocks, graphics, and camera movement on one time axis`}
          >
            {/* ── ruler ── */}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={x(t)} y1={RULER_Y - 4} x2={x(t)} y2={RULER_Y + 2} stroke="var(--viz-grid)" />
                <text x={x(t)} y={RULER_Y - 7} textAnchor="middle" style={{ fontSize: 9 }}>
                  {mmss(t)}
                </text>
              </g>
            ))}
            <line x1={0} y1={RULER_Y + 2} x2={STRIP_W} y2={RULER_Y + 2} stroke="var(--viz-grid)" />

            {/* ── screencast ── */}
            <text x={0} y={SC_LABEL} className="viz-label" style={{ fontSize: 10 }}>
              SCREENCAST — {scorecard.screencast.blocks} blocks, want {scorecard.screencast.wantBlocks}
            </text>
            <rect x={0} y={SC_Y} width={STRIP_W} height={SC_H} fill="var(--viz-band)" opacity={0.4} />
            {scorecard.screencast.blockList.map((b) => (
              <g
                key={`${b.index}-${b.id}`}
                className="viz-hit"
                {...hit(`${b.id} ${b.title}, ${human(b.seconds)}`, () =>
                  onPick(b.start, b.end, `${b.id} ${b.title}`),
                )}
              >
                <title>
                  {`${b.id} ${b.title} — ${human(b.seconds)}${
                    b.overMax ? ` · over the ${blockMax}s limit` : ''
                  }`}
                </title>
                <rect
                  x={x(b.start)}
                  y={SC_Y}
                  width={w(b.start, b.end)}
                  height={SC_H}
                  fill={b.overMax ? 'var(--viz-under)' : 'var(--viz-market)'}
                  opacity={b.overMax ? 0.55 : 0.8}
                  stroke={b.overMax ? 'var(--viz-under)' : 'none'}
                  strokeWidth={b.overMax ? 1.5 : 0}
                />
                {b.overMax && (
                  <>
                    {/* where the block should have ended */}
                    <line
                      x1={x(b.start + blockMax)}
                      y1={SC_Y - 3}
                      x2={x(b.start + blockMax)}
                      y2={SC_Y + SC_H + 3}
                      stroke="var(--viz-ink)"
                      strokeWidth={1}
                      strokeDasharray="3 2"
                    />
                    <text
                      x={x(b.start) + 4}
                      y={SC_Y + SC_H / 2 + 3}
                      className="viz-label"
                      style={{ fontSize: 9 }}
                    >
                      {human(b.seconds)}
                    </text>
                  </>
                )}
              </g>
            ))}

            {/* ── graphics ── */}
            <text x={0} y={G_LABEL} className="viz-label" style={{ fontSize: 10 }}>
              GRAPHICS — {scorecard.graphics.actual} on screen, floor {scorecard.graphics.floor}
            </text>
            <line x1={0} y1={G_Y + G_H / 2} x2={STRIP_W} y2={G_Y + G_H / 2} stroke="var(--viz-grid)" />
            {gap && (
              <g
                className="viz-hit"
                {...hit(`${human(gap.seconds)} with nothing on screen`, () =>
                  onPick(gap.start, gap.end, 'Nothing on screen'),
                )}
              >
                <title>{`${human(gap.seconds)} with nothing on screen — ${mmss(gap.start)} to ${mmss(gap.end)}`}</title>
                <rect
                  x={x(gap.start)}
                  y={G_Y - 5}
                  width={w(gap.start, gap.end)}
                  height={G_H + 10}
                  fill="var(--viz-under)"
                  opacity={0.16}
                />
                <text
                  x={(x(gap.start) + x(gap.end)) / 2}
                  y={G_Y - 8}
                  textAnchor="middle"
                  className="viz-label"
                  style={{ fontSize: 10 }}
                >
                  {human(gap.seconds)} with nothing on screen
                </text>
              </g>
            )}
            {graphicMarks.map((m, i) => (
              <g
                key={`${m.code}-${i}`}
                className="viz-hit"
                {...hit(`${m.code} ${m.name} at ${mmss(m.at)}`, () =>
                  onPick(m.at, m.at + 6, `${m.code} ${m.name}`),
                )}
              >
                <title>{`${m.code} ${m.name} at ${mmss(m.at)}`}</title>
                <rect x={x(m.at)} y={G_Y} width={2.5} height={G_H} fill="var(--viz-mine)" />
              </g>
            ))}

            {/* ── movement ── */}
            {/* ⚠️ "unbroken run" is a chain of MORE THAN ONE span of the bulk
                motion — the same predicate the bars below are painted with. hfp
                folds every motion into chains, so a lone R023 close-up arrives
                as a one-span "chain"; counting those as unbroken runs reported
                7 on the shipped film where the defect is 2. */}
            <text x={0} y={M_LABEL} className="viz-label" style={{ fontSize: 10 }}>
              MOVEMENT — {scorecard.movement.spanCount} spans, {unbrokenRuns} unbroken run
              {unbrokenRuns === 1 ? '' : 's'}
            </text>
            {scorecard.movement.chains.map((c, i) => {
              // ⚠️ A CHAIN IS ONLY A DEFECT WHEN IT IS THE BULK MOTION RUNNING
              // UNBROKEN. hfp folds every motion into chains, so a lone R023
              // close-up arrives here as a one-span "chain" — and it is a
              // reset, the very thing the edit is short of. Painting it in the
              // failure colour and captioning it "never reset" says the
              // opposite of what the data says, so both are conditional.
              const unbroken = c.spans > 1 && c.motion === bulk;
              const label = unbroken
                ? `${c.spans} × ${nameOf(c.motion)} back to back — ${human(c.seconds)}, ${mmss(
                    c.start,
                  )} to ${mmss(c.end)}, never reset`
                : `${c.spans} × ${nameOf(c.motion)} — ${human(c.seconds)}, ${mmss(
                    c.start,
                  )} to ${mmss(c.end)}`;
              return (
              <g
                key={`${c.start}-${i}`}
                className="viz-hit"
                {...hit(label, () =>
                  onPick(
                    c.start,
                    c.end,
                    unbroken
                      ? `${c.spans} × ${nameOf(c.motion)}, no reset`
                      : `${c.spans} × ${nameOf(c.motion)}`,
                  ),
                )}
              >
                <title>{label}</title>
                <rect
                  x={x(c.start)}
                  y={CHAIN_Y}
                  width={w(c.start, c.end)}
                  height={CHAIN_H}
                  rx={2}
                  fill={unbroken ? 'var(--viz-under)' : 'var(--viz-mine)'}
                  opacity={0.7}
                />
                {w(c.start, c.end) > 190 && (
                  <text
                    x={x(c.start) + 6}
                    y={CHAIN_Y + CHAIN_H - 3}
                    className="viz-label"
                    style={{ fontSize: 9 }}
                  >
                    {c.spans} × {nameOf(c.motion)} · {human(c.seconds)}
                    {unbroken ? ' · never reset' : ''}
                  </text>
                )}
              </g>
              );
            })}
            {scorecard.movement.spans.map((s, i) => (
              <g
                key={`${s.start}-${i}`}
                className="viz-hit"
                {...hit(`${s.motion} ${nameOf(s.motion)} at ${mmss(s.start)}`, () =>
                  onPick(s.start, s.end, `${s.motion} ${nameOf(s.motion)}`),
                )}
              >
                <title>{`${s.motion} ${nameOf(s.motion)} — ${mmss(s.start)} to ${mmss(s.end)}, ${human(
                  s.end - s.start,
                )}`}</title>
                <rect
                  x={x(s.start)}
                  y={SPAN_Y}
                  width={w(s.start, s.end)}
                  height={SPAN_H}
                  fill={s.motion === bulk ? 'var(--viz-market)' : 'var(--viz-mine)'}
                />
              </g>
            ))}
          </svg>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Click any mark to read what is being said over it.
      </p>

      <TableView
        head={['Lane', 'From', 'To', 'Length', 'What']}
        rows={[
          ...scorecard.screencast.blockList.map((b) => [
            'Screencast',
            mmss(b.start),
            mmss(b.end),
            human(b.seconds),
            `${b.id} ${b.title}${b.overMax ? ` — over the ${blockMax}s limit` : ''}`,
          ]),
          ...scorecard.graphics.gaps.map((g) => [
            'Graphics gap',
            mmss(g.start),
            mmss(g.end),
            human(g.seconds),
            'nothing on screen',
          ]),
          ...scorecard.movement.chains.map((c) => [
            'Movement run',
            mmss(c.start),
            mmss(c.end),
            human(c.seconds),
            `${c.spans} × ${nameOf(c.motion)}, never reset`,
          ]),
        ]}
      />
    </div>
  );
}

/* ── 3. PushStrip — one distribution against one rule ─────────────────────
   Amber throughout. This is a warn; a red dot cloud would make a note look
   like a blocker and the page's whole credibility is that it does not
   overstate. Every dot is one span, jittered only to stop them stacking.   */

export function PushStrip({
  scorecard,
  onPick,
}: {
  scorecard: DensityScorecard;
  onPick?: (start: number, end: number, label: string) => void;
}) {
  const { movement, thresholds, elements } = scorecard;

  // ⚠️ THE PUSHES ARE THE MOTIONS THE RULE COVERS, NOT THE COMMONEST MOTION.
  // This used to take the modal motion, which is the same thing on the shipped
  // film (R002, 76 spans) and a different thing on any edit whose bulk motion
  // is not a push — there it drew non-push spans against a push-median rule and
  // its own caption disagreed with movement.pushCount. hfp emits the list.
  const pushCodes = new Set(thresholds.pushMotions);
  const pushes = movement.spans.filter((s) => pushCodes.has(s.motion));
  if (!pushes.length) return null;
  const primary =
    pushes.reduce<Record<string, number>>((acc, s) => {
      acc[s.motion] = (acc[s.motion] ?? 0) + 1;
      return acc;
    }, {});
  const bulk = Object.keys(primary).reduce((a, b) => (primary[b] > primary[a] ? b : a));
  const pushName = elements.find((e) => e.code === bulk)?.name ?? bulk;

  const limit = thresholds.pushSpanMedianMaxSeconds;
  // null = no push span exists. The rule line still draws; the "where this edit
  // sits" marker does not, because there is no measurement to put anywhere.
  const median = movement.pushMedianSeconds;
  const max = Math.max(limit * 2, (movement.pushMaxSeconds ?? 0) * 1.1, 10);

  const W = 1000;
  const PAD_L = 8;
  const PAD_R = 140;
  const PLOT = W - PAD_L - PAD_R;
  const H = 96;
  const AXIS_Y = 70;
  const x = (v: number) => PAD_L + (PLOT * Math.min(v, max)) / max;

  // Deterministic jitter — the same render every time, so a screenshot of this
  // page and the page itself are the same picture.
  const jitter = (i: number) => {
    const v = Math.sin((i + 1) * 12.9898) * 43758.5453;
    return v - Math.floor(v);
  };

  const tickStep = max <= 12 ? 2 : max <= 30 ? 5 : 10;
  const axisTicks: number[] = [];
  for (let t = 0; t <= max; t += tickStep) axisTicks.push(t);

  return (
    <div className="viz">
      <Legend
        items={[
          { label: `one ${pushName} span`, color: 'var(--viz-market)' },
          { label: 'the rule, and where this edit sits', color: 'var(--viz-warn)' },
        ]}
      />
      <div className="overflow-x-auto">
        <div className="min-w-[560px]">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            height={H}
            role="img"
            aria-label={`${pushes.length} ${pushName} spans by length, against a median rule of ${limit} seconds`}
          >
            <line x1={PAD_L} y1={AXIS_Y} x2={PAD_L + PLOT} y2={AXIS_Y} stroke="var(--viz-grid)" />
            {axisTicks.map((t) => (
              <g key={t}>
                <line x1={x(t)} y1={AXIS_Y} x2={x(t)} y2={AXIS_Y + 4} stroke="var(--viz-grid)" />
                <text x={x(t)} y={AXIS_Y + 15} textAnchor="middle" style={{ fontSize: 10 }}>
                  {t}s
                </text>
              </g>
            ))}

            {/* the rule */}
            <line
              x1={x(limit)}
              y1={8}
              x2={x(limit)}
              y2={AXIS_Y}
              stroke="var(--viz-warn)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <text x={x(limit) + 4} y={14} style={{ fontSize: 10, fill: 'var(--viz-warn)' }}>
              want median ≤{limit}s
            </text>

            {/* where this edit actually sits */}
            {median !== null && (
              <>
                <line
                  x1={x(median)}
                  y1={16}
                  x2={x(median)}
                  y2={AXIS_Y}
                  stroke="var(--viz-warn)"
                  strokeWidth={3}
                />
                <text
                  x={Math.min(x(median) + 6, PAD_L + PLOT + 4)}
                  y={AXIS_Y - 4}
                  className="viz-label"
                  style={{ fontSize: 10 }}
                >
                  median {num(median)}s
                </text>
              </>
            )}

            {pushes.map((s, i) => {
              const secs = s.end - s.start;
              return (
                <g
                  key={`${s.start}-${i}`}
                  className={onPick ? 'viz-hit' : undefined}
                  {...(onPick
                    ? hit(`${pushName} at ${mmss(s.start)}, ${human(secs)}`, () =>
                        onPick(s.start, s.end, `${pushName} ${mmss(s.start)}`),
                      )
                    : {})}
                >
                  <title>{`${human(secs)} at ${mmss(s.start)}`}</title>
                  <circle
                    cx={x(secs)}
                    cy={26 + jitter(i) * 34}
                    r={3.5}
                    fill="var(--viz-market)"
                    opacity={0.7}
                  />
                </g>
              );
            })}

            <text x={PAD_L + PLOT + 14} y={34} className="viz-label" style={{ fontSize: 11 }}>
              {pushes.length} spans
            </text>
            <text x={PAD_L + PLOT + 14} y={50} style={{ fontSize: 11 }}>
              longest {num(movement.pushMaxSeconds)}s
            </text>
          </svg>
        </div>
      </div>

      <TableView
        head={['#', 'At', 'Length (s)']}
        rows={pushes.map((s, i) => [i + 1, mmss(s.start), num(s.end - s.start, 2)])}
      />
    </div>
  );
}
