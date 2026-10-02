/**
 * Deal Organizer — a small SVG stand-in for the part of `recharts` the
 * Analytics page used (recharts is not installed in the Lab and cannot be
 * added). Same component names and props, so the chart files are unchanged:
 *
 *   ResponsiveContainer · BarChart · ComposedChart · LineChart
 *   Bar (dataKey, stackId, fill, name, unit, radius, yAxisId, <Cell fill>)
 *   Line (dataKey, stroke, strokeWidth, dot, name, unit, yAxisId)
 *   XAxis / YAxis (dataKey, type, width, orientation, yAxisId, domain, unit, tick)
 *   CartesianGrid (stroke, strokeDasharray, vertical, horizontal)
 *   Tooltip (content = custom element, receives {active, payload, label})
 *   Legend (circle icons)
 *
 * Supports vertical columns (default) and horizontal bars (layout="vertical").
 * No animation. Lines are straight segments (recharts' "monotone" curve is not
 * reproduced).
 */
import {
  Children, cloneElement, isValidElement, useEffect, useRef, useState,
  type CSSProperties, type ReactElement, type ReactNode,
} from 'react';

type Datum = Record<string, any>;
type Margin = { top?: number; right?: number; bottom?: number; left?: number };
type Tick = { fontSize?: number; fill?: string };

// ── Marker components (read by the chart; render nothing on their own) ──────
export function Cell(_: { fill?: string }) { return null; }
export function Bar(_: {
  dataKey: string; stackId?: string; fill?: string; name?: string; unit?: string;
  radius?: number | [number, number, number, number]; yAxisId?: string; children?: ReactNode;
}) { return null; }
export function Line(_: {
  dataKey: string; stroke?: string; strokeWidth?: number; dot?: boolean | { r?: number; fill?: string };
  name?: string; unit?: string; yAxisId?: string; type?: string;
}) { return null; }
export function XAxis(_: AxisProps) { return null; }
export function YAxis(_: AxisProps) { return null; }
export function CartesianGrid(_: { stroke?: string; strokeDasharray?: string; vertical?: boolean; horizontal?: boolean }) { return null; }
export function Tooltip(_: { content?: ReactElement; formatter?: (...a: any[]) => any; cursor?: any }) { return null; }
export function Legend(_: { iconType?: string; iconSize?: number; wrapperStyle?: CSSProperties }) { return null; }
/** A horizontal target/goal line at value `y` on the left value axis (vertical-column charts). */
export function ReferenceLine(_: { y: number; stroke?: string; strokeDasharray?: string; label?: string }) { return null; }

type AxisProps = {
  dataKey?: string; type?: 'number' | 'category'; width?: number; orientation?: 'left' | 'right';
  yAxisId?: string; domain?: [number, number]; unit?: string; tick?: Tick | boolean;
  axisLine?: boolean; tickLine?: boolean; hide?: boolean;
  /** Format a value-axis tick (e.g. v => `$${v / 1000}k`). */
  tickFormatter?: (v: number) => string;
};

// ── ResponsiveContainer ─────────────────────────────────────────────────────
export function ResponsiveContainer({ width = '100%', height = 200, children }: {
  width?: number | string; height?: number | string; children: ReactElement;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ width, height, position: 'relative' }}>
      {size.w > 0 && size.h > 0 && isValidElement(children)
        ? cloneElement(children as ReactElement<any>, { width: size.w, height: size.h })
        : null}
    </div>
  );
}

// ── Chart core ──────────────────────────────────────────────────────────────
type ChartProps = {
  data?: Datum[]; width?: number; height?: number; layout?: 'horizontal' | 'vertical';
  margin?: Margin; barGap?: number; children?: ReactNode;
  /** Cap a bar's thickness in px (bars otherwise fill 80% of their band). */
  maxBarSize?: number;
  /** Click on a category (bar group / point column) → its index + datum. Adds a pointer cursor. */
  onClickIndex?: (index: number, datum: Datum) => void;
  /** Accessible name for the chart's SVG. */
  ariaLabel?: string;
};

type Series =
  | { kind: 'bar'; p: any; cells: (string | undefined)[] }
  | { kind: 'line'; p: any };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * exp;
}
function ticks(max: number, count = 4): number[] {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => +(i * step).toFixed(2));
}
function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function roundedRect(x: number, y: number, w: number, h: number, r: [number, number, number, number]) {
  // r = [topLeft, topRight, bottomRight, bottomLeft]
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, Math.min(v, w / 2, h / 2)));
  return `M${x + tl},${y} H${x + w - tr} Q${x + w},${y} ${x + w},${y + tr} V${y + h - br} Q${x + w},${y + h} ${x + w - br},${y + h} H${x + bl} Q${x},${y + h} ${x},${y + h - bl} V${y + tl} Q${x},${y} ${x + tl},${y} Z`;
}

function Chart({ data = [], width = 0, height = 0, layout = 'horizontal', margin, barGap = 4, children, onClickIndex, ariaLabel, maxBarSize }: ChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const [mouse, setMouse] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const series: Series[] = [];
  const xAxes: AxisProps[] = [];
  const yAxes: AxisProps[] = [];
  let grid: any = null;
  let tooltip: any = null;
  let legend: any = null;
  const refLines: any[] = [];
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const p: any = c.props;
    if (c.type === Bar) {
      const cells: (string | undefined)[] = [];
      Children.forEach(p.children, (cc) => { if (isValidElement(cc)) cells.push((cc.props as any).fill); });
      series.push({ kind: 'bar', p, cells });
    } else if (c.type === Line) series.push({ kind: 'line', p });
    else if (c.type === XAxis) xAxes.push(p);
    else if (c.type === YAxis) yAxes.push(p);
    else if (c.type === CartesianGrid) grid = p;
    else if (c.type === Tooltip) tooltip = p;
    else if (c.type === Legend) legend = p;
    else if (c.type === ReferenceLine) refLines.push(p);
  });

  const vertical = layout === 'vertical'; // horizontal bars, categories down the Y axis
  const catAxis = vertical ? yAxes.find((a) => a.type === 'category') ?? yAxes[0] : xAxes[0];
  const catKey = catAxis?.dataKey;
  const valueAxes = vertical ? xAxes : yAxes;
  const leftAxis = vertical ? undefined : valueAxes.find((a) => a.orientation !== 'right') ?? valueAxes[0];
  const rightAxis = vertical ? undefined : valueAxes.find((a) => a.orientation === 'right');

  const legendH = legend ? 28 : 0;
  const m = { top: 8, right: 8, bottom: 4, left: 4, ...(margin ?? {}) };
  const catLabelW = vertical ? (catAxis?.width ?? 60) : 0;
  const leftW = vertical ? catLabelW : (leftAxis && !leftAxis.hide ? (leftAxis.width ?? 32) : 0);
  const rightW = rightAxis && !rightAxis.hide ? 36 : 0;
  const bottomAxis = vertical ? valueAxes[0] : catAxis;
  const bottomH = bottomAxis && !bottomAxis.hide && bottomAxis.tick !== false ? 20 : 0;
  const plot = {
    x: m.left + leftW,
    y: m.top,
    w: Math.max(10, width - m.left - m.right - leftW - rightW),
    h: Math.max(10, height - m.top - m.bottom - bottomH - legendH),
  };

  // Value scales (per axis id).
  const axisIdOf = (s: Series) => s.p.yAxisId ?? (leftAxis?.yAxisId ?? undefined);
  const maxFor = (axis: AxisProps | undefined, ids: (string | undefined)[]) => {
    if (axis?.domain) return axis.domain[1];
    let max = 0;
    const stacks: Record<string, number[]> = {};
    for (const s of series) {
      if (!ids.includes(axisIdOf(s))) continue;
      data.forEach((d, i) => {
        const v = Number(d[s.p.dataKey]) || 0;
        if (s.kind === 'bar' && s.p.stackId) {
          (stacks[s.p.stackId] ??= [])[i] = ((stacks[s.p.stackId] ?? [])[i] ?? 0) + v;
          max = Math.max(max, stacks[s.p.stackId][i]);
        } else max = Math.max(max, v);
      });
    }
    if (!vertical && (!axis || axis === leftAxis)) for (const r of refLines) max = Math.max(max, Number(r.y) || 0);
    return niceMax(max);
  };
  const leftIds = vertical ? series.map(axisIdOf) : [leftAxis?.yAxisId, undefined];
  const leftMax = maxFor(vertical ? valueAxes[0] : leftAxis, leftIds);
  const rightMax = rightAxis ? maxFor(rightAxis, [rightAxis.yAxisId]) : 0;
  const scaleFor = (s: Series) => (rightAxis && s.p.yAxisId && s.p.yAxisId === rightAxis.yAxisId ? rightMax : leftMax);

  const n = Math.max(1, data.length);
  const band = (vertical ? plot.h : plot.w) / n;
  const barGroups: string[] = [];
  for (const s of series) {
    if (s.kind !== 'bar') continue;
    const g = s.p.stackId ?? `__${s.p.dataKey}`;
    if (!barGroups.includes(g)) barGroups.push(g);
  }
  const groupCount = Math.max(1, barGroups.length);
  const barThick = Math.max(2, Math.min(maxBarSize ?? Infinity, (band * 0.8 - barGap * (groupCount - 1)) / groupCount));
  const inner = barThick * groupCount + barGap * (groupCount - 1);

  const tickStyle = (a?: AxisProps): Tick => (a && typeof a.tick === 'object' ? a.tick : { fontSize: 11, fill: 'hsl(var(--muted-foreground))' });
  const catTick = tickStyle(catAxis);
  const valTick = tickStyle(vertical ? valueAxes[0] : leftAxis);

  // Geometry
  const rects: ReactNode[] = [];
  const lines: ReactNode[] = [];
  const stackAcc: Record<string, number[]> = {};
  series.forEach((s, si) => {
    const max = scaleFor(s);
    if (s.kind === 'bar') {
      const g = s.p.stackId ?? `__${s.p.dataKey}`;
      const gi = barGroups.indexOf(g);
      const radius: [number, number, number, number] = Array.isArray(s.p.radius)
        ? s.p.radius : [s.p.radius ?? 0, s.p.radius ?? 0, s.p.radius ?? 0, s.p.radius ?? 0];
      data.forEach((d, i) => {
        const v = Number(d[s.p.dataKey]) || 0;
        const start = (stackAcc[g] ??= [])[i] ?? 0;
        stackAcc[g][i] = start + v;
        if (v <= 0) return;
        const fill = s.cells[i] ?? s.p.fill ?? 'hsl(var(--primary))';
        const offset = i * band + (band - inner) / 2 + gi * (barThick + barGap);
        if (vertical) {
          const x0 = plot.x + (start / max) * plot.w;
          const len = (v / max) * plot.w;
          rects.push(<path key={`b${si}-${i}`} d={roundedRect(x0, plot.y + offset, len, barThick, radius)} fill={fill} opacity={hover === null || hover === i ? 1 : 0.75} />);
        } else {
          const len = (v / max) * plot.h;
          const y0 = plot.y + plot.h - ((start + v) / max) * plot.h;
          rects.push(<path key={`b${si}-${i}`} d={roundedRect(plot.x + offset, y0, barThick, len, radius)} fill={fill} opacity={hover === null || hover === i ? 1 : 0.75} />);
        }
      });
    } else {
      const pts = data.map((d, i) => {
        const v = Number(d[s.p.dataKey]) || 0;
        return [plot.x + i * band + band / 2, plot.y + plot.h - (v / max) * plot.h] as const;
      });
      const stroke = s.p.stroke ?? 'hsl(var(--primary))';
      lines.push(<polyline key={`l${si}`} points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={stroke} strokeWidth={s.p.strokeWidth ?? 1.5} strokeLinejoin="round" />);
      if (s.p.dot !== false && s.p.dot !== undefined) {
        const r = typeof s.p.dot === 'object' ? s.p.dot.r ?? 3 : 3;
        const fill = typeof s.p.dot === 'object' ? s.p.dot.fill ?? stroke : stroke;
        pts.forEach((p, i) => lines.push(<circle key={`d${si}-${i}`} cx={p[0]} cy={p[1]} r={r} fill={fill} />));
      }
    }
  });

  const valueTicks = ticks(leftMax);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    setMouse({ x, y });
    const pos = vertical ? y - plot.y : x - plot.x;
    const inside = x >= plot.x && x <= plot.x + plot.w && y >= plot.y && y <= plot.y + plot.h;
    setHover(inside ? Math.min(n - 1, Math.max(0, Math.floor(pos / band))) : null);
  };

  const payload = hover === null ? [] : series.map((s) => ({
    name: s.p.name ?? s.p.dataKey,
    dataKey: s.p.dataKey,
    value: data[hover]?.[s.p.dataKey],
    unit: s.p.unit,
    color: s.kind === 'bar' ? (s.cells[hover] ?? s.p.fill) : s.p.stroke,
    fill: s.kind === 'bar' ? (s.cells[hover] ?? s.p.fill) : s.p.stroke,
    stroke: s.kind === 'line' ? s.p.stroke : undefined,
    payload: data[hover],
  }));
  const label = hover === null ? undefined : catKey ? data[hover]?.[catKey] : hover;

  return (
    <div style={{ position: 'relative', width, height }}>
      <svg
        width={width} height={height - legendH} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        onClick={onClickIndex ? () => { if (hover !== null && data[hover]) onClickIndex(hover, data[hover]); } : undefined}
        role="img" aria-label={ariaLabel}
        style={{ display: 'block', overflow: 'visible', cursor: onClickIndex && hover !== null ? 'pointer' : undefined }}
      >
        {/* grid */}
        {grid && (
          <g stroke={grid.stroke ?? 'hsl(var(--border))'} strokeDasharray={grid.strokeDasharray}>
            {grid.horizontal !== false && !vertical && valueTicks.map((t) => {
              const y = plot.y + plot.h - (t / leftMax) * plot.h;
              return <line key={`gh${t}`} x1={plot.x} x2={plot.x + plot.w} y1={y} y2={y} />;
            })}
            {grid.vertical !== false && vertical && valueTicks.map((t) => {
              const x = plot.x + (t / leftMax) * plot.w;
              return <line key={`gv${t}`} y1={plot.y} y2={plot.y + plot.h} x1={x} x2={x} />;
            })}
            {grid.horizontal !== false && vertical && data.map((_, i) => (
              <line key={`gc${i}`} x1={plot.x} x2={plot.x + plot.w} y1={plot.y + (i + 1) * band} y2={plot.y + (i + 1) * band} />
            ))}
            {grid.vertical !== false && !vertical && data.map((_, i) => (
              <line key={`gc${i}`} y1={plot.y} y2={plot.y + plot.h} x1={plot.x + (i + 1) * band} x2={plot.x + (i + 1) * band} />
            ))}
          </g>
        )}
        {/* hover band */}
        {hover !== null && tooltip && (
          vertical
            ? <rect x={plot.x} y={plot.y + hover * band} width={plot.w} height={band} fill="hsl(var(--muted))" opacity={0.5} />
            : <rect x={plot.x + hover * band} y={plot.y} width={band} height={plot.h} fill="hsl(var(--muted))" opacity={0.5} />
        )}
        {rects}
        {lines}
        {/* reference (goal) lines */}
        {!vertical && refLines.map((r, i) => {
          const y = plot.y + plot.h - ((Number(r.y) || 0) / leftMax) * plot.h;
          return (
            <g key={`ref${i}`} pointerEvents="none">
              <line x1={plot.x} x2={plot.x + plot.w} y1={y} y2={y} stroke={r.stroke ?? 'hsl(var(--muted-foreground))'} strokeWidth={1.5} strokeDasharray={r.strokeDasharray ?? '5 4'} />
              {r.label && <text x={plot.x + plot.w} y={y - 5} textAnchor="end" fontSize={11} fill="hsl(var(--muted-foreground))">{r.label}</text>}
            </g>
          );
        })}
        {/* category labels */}
        {catAxis && catAxis.tick !== false && !catAxis.hide && data.map((d, i) => {
          const text = String(catKey ? d[catKey] ?? '' : i);
          return vertical
            ? <text key={`c${i}`} x={plot.x - 6} y={plot.y + i * band + band / 2} textAnchor="end" dominantBaseline="middle" fontSize={catTick.fontSize ?? 11} fill={catTick.fill}>{text.length > 22 ? `${text.slice(0, 21)}…` : text}</text>
            : <text key={`c${i}`} x={plot.x + i * band + band / 2} y={plot.y + plot.h + 14} textAnchor="middle" fontSize={catTick.fontSize ?? 11} fill={catTick.fill}>{text}</text>;
        })}
        {/* value labels */}
        {(vertical ? valueAxes[0] : leftAxis) && !(vertical ? valueAxes[0] : leftAxis)!.hide && (vertical ? valueAxes[0] : leftAxis)!.tick !== false && valueTicks.map((t) => {
          const unit = (vertical ? valueAxes[0] : leftAxis)?.unit ?? '';
          const tf = (vertical ? valueAxes[0] : leftAxis)?.tickFormatter;
          return vertical
            ? <text key={`v${t}`} x={plot.x + (t / leftMax) * plot.w} y={plot.y + plot.h + 14} textAnchor="middle" fontSize={valTick.fontSize ?? 11} fill={valTick.fill}>{tf ? tf(t) : `${fmt(t)}${unit}`}</text>
            : <text key={`v${t}`} x={plot.x - 6} y={plot.y + plot.h - (t / leftMax) * plot.h} textAnchor="end" dominantBaseline="middle" fontSize={valTick.fontSize ?? 11} fill={valTick.fill}>{tf ? tf(t) : `${fmt(t)}${unit}`}</text>;
        })}
        {rightAxis && !rightAxis.hide && ticks(rightMax).map((t) => {
          const rt = tickStyle(rightAxis);
          return <text key={`r${t}`} x={plot.x + plot.w + 6} y={plot.y + plot.h - (t / rightMax) * plot.h} dominantBaseline="middle" fontSize={rt.fontSize ?? 11} fill={rt.fill}>{fmt(t)}{rightAxis.unit ?? ''}</text>;
        })}
      </svg>
      {legend && (
        <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 12, ...(legend.wrapperStyle ?? {}), paddingTop: 6 }}>
          {series.map((s, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: s.kind === 'bar' ? s.p.fill : s.p.stroke }}>
              <span style={{ width: legend.iconSize ?? 8, height: legend.iconSize ?? 8, borderRadius: 999, background: s.kind === 'bar' ? s.p.fill : s.p.stroke, display: 'inline-block' }} />
              {s.p.name ?? s.p.dataKey}
            </span>
          ))}
        </div>
      )}
      {tooltip && hover !== null && (
        <div style={{ position: 'absolute', left: Math.min(mouse.x + 12, Math.max(0, width - 180)), top: Math.max(0, mouse.y - 10), pointerEvents: 'none', zIndex: 10 }}>
          {isValidElement(tooltip.content)
            ? cloneElement(tooltip.content as ReactElement<any>, { active: true, payload, label })
            : (
              <div className="bg-popover border border-border rounded-lg p-2 text-xs shadow-lg">
                <p className="font-semibold text-foreground">{label}</p>
                {payload.map((p, i) => <p key={i} className="text-muted-foreground">{p.name}: <span className="text-foreground">{p.value}{p.unit ?? ''}</span></p>)}
              </div>
            )}
        </div>
      )}
    </div>
  );
}

export const BarChart = (p: ChartProps) => <Chart {...p} />;
export const ComposedChart = (p: ChartProps) => <Chart {...p} />;
export const LineChart = (p: ChartProps) => <Chart {...p} margin={p.margin ?? { top: 2, right: 2, bottom: 0, left: 2 }} />;
