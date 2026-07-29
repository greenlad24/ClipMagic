/**
 * The audit's charts.
 *
 * Three questions, three forms — chosen for the job rather than for variety:
 *
 *   Where do I stand?      → ranked bars, one measure, channels on the axis.
 *   What works for me?     → diverging bars around par (1.0), which is a real
 *                            midpoint rather than a decorative one.
 *   Where do I own / grow? → a scatter of my share of a topic against what the
 *                            market gets for it. Ownership and opportunity are
 *                            two coordinates of one point, so one chart.
 *
 * Colour comes last and is computed, not chosen: the two hues used here (blue
 * #2a78d6 / red #e34948, and their dark steps #3987e5 / #e66767) were run
 * through the palette validator and pass every gate in both modes — lightness
 * band, chroma floor, CVD separation (worst adjacent ΔE 21.6 light, 19.2 dark),
 * normal-vision floor and 3:1 contrast against both surfaces.
 *
 * No dual axes anywhere. Where two measures matter they get two charts.
 *
 * ONE MEANING PER COLOUR ACROSS THE WHOLE SET. Blue is always "yours", grey is
 * always "the market", and red is only ever "below par". The first draft used
 * the diverging pair in the ownership scatter too, so a topic that was below
 * par came out red in one chart and blue in the next — same topic, same screen,
 * two meanings. Colour follows the entity, not the local axis.
 */
import { useId, useState } from 'react';

/* ── palette ──────────────────────────────────────────────────────────────
   Roles as custom properties so light/dark swap in one place, and the marks
   are written against roles rather than hex. Dark is declared under BOTH the
   media query and the app's `.dark` class, so the app's theme toggle wins in
   either direction rather than only following the OS.                     */
export const VIZ_STYLE = `
.viz {
  --viz-surface: #fcfcfb;
  --viz-ink: #0b0b0b;
  --viz-ink-2: #52514e;
  --viz-grid: #e4e3df;
  --viz-mine: #2a78d6;
  --viz-under: #e34948;
  --viz-market: #a8a69f;
  --viz-band: #f0efec;
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) .viz {
    --viz-surface: #1a1a19; --viz-ink: #ffffff; --viz-ink-2: #c3c2b7;
    --viz-grid: #3a3a37; --viz-mine: #3987e5; --viz-under: #e66767;
    --viz-market: #6e6d67; --viz-band: #383835;
  }
}
:root.dark .viz {
  --viz-surface: #1a1a19; --viz-ink: #ffffff; --viz-ink-2: #c3c2b7;
  --viz-grid: #3a3a37; --viz-mine: #3987e5; --viz-under: #e66767;
  --viz-market: #6e6d67; --viz-band: #383835;
}
.viz text { fill: var(--viz-ink-2); font-size: 11px; }
.viz .viz-label { fill: var(--viz-ink); }
`;

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));

/** Legend — always present for two or more series, so identity is never colour alone. */
function Legend({ items }: { items: { label: string; color: string }[] }) {
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

/** A table view of the same numbers — the accessibility fallback for every chart. */
function TableView({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
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
                  <th key={h} className="border-b px-2 py-1 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="border-b px-2 py-1">
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

/* ── 1. Where do I stand ─────────────────────────────────────────────────
   Ranked horizontal bars of ONE measure. Subscribers and views-per-video are
   different scales and would tempt a dual axis, so they get separate charts;
   the subscriber count rides along as a text label, not a second axis.     */
export function MarketPositionChart({
  subject,
  competitors,
  videos,
  marketVideos,
}: {
  subject: any;
  competitors: any[];
  videos: any[];
  marketVideos: any[];
}) {
  const med = (xs: number[]) => {
    const a = [...xs].sort((p, q) => p - q);
    return a.length ? a[Math.floor(a.length / 2)] : 0;
  };

  const mine = videos.filter((v: any) => v.judged && v.format === 'long');
  const rows = [
    {
      name: subject?.title ?? 'You',
      subs: subject?.subscriberCount ?? 0,
      medianViews: med(mine.map((v: any) => v.views)),
      isMine: true,
      n: mine.length,
    },
    ...competitors.map((c: any) => {
      const vs = marketVideos.filter((v: any) => v.channelId === c.channelId);
      return {
        name: c.title,
        subs: c.subscriberCount ?? 0,
        // Only their over-performers were kept as market evidence, so this is
        // "what their good videos do", not their channel average. Labelled as
        // such on the axis rather than quietly compared against your median.
        medianViews: med(vs.map((v: any) => v.views)),
        isMine: false,
        n: vs.length,
      };
    }),
  ]
    .filter((r) => r.medianViews > 0)
    .sort((a, b) => b.medianViews - a.medianViews);

  if (rows.length < 2) return null;
  const max = Math.max(...rows.map((r) => r.medianViews));
  const barH = 26;
  const gap = 8;
  const labelW = 168;
  const h = rows.length * (barH + gap);

  return (
    <figure className="viz m-0">
      <figcaption className="mb-1 text-sm font-medium" style={{ color: 'var(--viz-ink)' }}>
        Median views per video
      </figcaption>
      <p className="mb-2 text-xs" style={{ color: 'var(--viz-ink-2)' }}>
        Yours is the median of your judged long-form videos. Theirs is the median of their over-performers only —
        the audit keeps a competitor&apos;s best work as market evidence, not their whole catalogue, so read these
        as &ldquo;what good looks like there&rdquo;.
      </p>
      <Legend
        items={[
          { label: subject?.title ?? 'You', color: 'var(--viz-mine)' },
          { label: 'Competitors', color: 'var(--viz-market)' },
        ]}
      />
      <svg viewBox={`0 0 640 ${h}`} width="100%" height={h} role="img" aria-label="Median views per video by channel">
        {rows.map((r, i) => {
          const y = i * (barH + gap);
          const w = Math.max(2, ((640 - labelW - 56) * r.medianViews) / max);
          return (
            <g key={r.name}>
              <title>{`${r.name} — ${r.medianViews.toLocaleString()} median views, ${r.subs.toLocaleString()} subscribers`}</title>
              <text x={0} y={y + barH / 2 + 4} className={r.isMine ? 'viz-label' : ''}>
                {r.name.length > 24 ? r.name.slice(0, 23) + '…' : r.name}
              </text>
              <rect
                x={labelW}
                y={y}
                width={w}
                height={barH - 6}
                rx={4}
                fill={r.isMine ? 'var(--viz-mine)' : 'var(--viz-market)'}
              />
              <text x={labelW + w + 8} y={y + barH / 2 + 1} className="viz-label">
                {fmt(r.medianViews)}
              </text>
              <text x={labelW + w + 8} y={y + barH / 2 + 12} style={{ fontSize: 9 }}>
                {fmt(r.subs)} subs
              </text>
            </g>
          );
        })}
      </svg>
      <TableView
        head={['Channel', 'Median views', 'Subscribers', 'Videos counted']}
        rows={rows.map((r) => [r.name, r.medianViews, r.subs, r.n])}
      />
    </figure>
  );
}

/* ── 2. What works for me ────────────────────────────────────────────────
   Diverging around 1.0, which is a genuine midpoint: par for that channel at
   that time. Above and below are opposite states, so the diverging pair is
   the honest encoding rather than one hue by magnitude.                    */
export function TopicPerformanceChart({ topics }: { topics: any[] }) {
  const rows = (topics || []).filter((t) => t.count > 0).sort((a, b) => b.medianMultiple - a.medianMultiple);
  if (rows.length < 2) return null;

  const max = Math.max(2, ...rows.map((t) => t.medianMultiple));
  const barH = 24;
  const gap = 8;
  const labelW = 190;
  const plotW = 640 - labelW - 60;
  const zeroX = labelW;
  const h = rows.length * (barH + gap) + 18;
  const scale = (v: number) => (plotW * Math.min(v, max)) / max;
  const parX = zeroX + scale(1);

  return (
    <figure className="viz m-0">
      <figcaption className="mb-1 text-sm font-medium" style={{ color: 'var(--viz-ink)' }}>
        How each topic performs for you
      </figcaption>
      <p className="mb-2 text-xs" style={{ color: 'var(--viz-ink-2)' }}>
        Against par for its moment — 1.0x is what your channel was normally doing when those videos went out.
      </p>
      <Legend
        items={[
          { label: 'Above par', color: 'var(--viz-mine)' },
          { label: 'Below par', color: 'var(--viz-under)' },
        ]}
      />
      <svg viewBox={`0 0 640 ${h}`} width="100%" height={h} role="img" aria-label="Median performance multiple by topic">
        <line x1={parX} x2={parX} y1={0} y2={h - 18} stroke="var(--viz-grid)" strokeWidth={2} />
        <text x={parX + 4} y={h - 6} style={{ fontSize: 10 }}>
          par (1.0x)
        </text>
        {rows.map((t, i) => {
          const y = i * (barH + gap);
          const w = Math.max(2, scale(t.medianMultiple));
          const above = t.medianMultiple >= 1;
          return (
            <g key={t.topic}>
              <title>{`${t.topic} — ${t.medianMultiple}x across ${t.count} videos`}</title>
              <text x={0} y={y + barH / 2 + 4}>
                {t.topic.length > 27 ? t.topic.slice(0, 26) + '…' : t.topic}
              </text>
              <rect
                x={zeroX}
                y={y}
                width={w}
                height={barH - 6}
                rx={4}
                fill={above ? 'var(--viz-mine)' : 'var(--viz-under)'}
              />
              <text x={zeroX + w + 8} y={y + barH / 2 + 4} className="viz-label">
                {t.medianMultiple}x
                <tspan style={{ fontSize: 9 }}> · {t.count}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
      <TableView
        head={['Topic', 'Median multiple', 'Your videos']}
        rows={rows.map((t) => [t.topic, `${t.medianMultiple}x`, t.count])}
      />
    </figure>
  );
}

/* ── 3. Where do I own, where can I grow ─────────────────────────────────
   Ownership and opportunity are two coordinates of the same topic, so they
   belong on one chart rather than two rankings the reader has to join.
   x: your share of the videos on that topic. y: what the market's videos on
   it actually get. Quadrants are named, because an unnamed quadrant chart is
   a puzzle rather than an answer.                                          */
export function OpportunityChart({ topics }: { topics: any[] }) {
  const uid = useId().replace(/:/g, '');
  const rows = (topics || []).filter((t) => (t.marketCount ?? 0) > 0 || t.count > 0);
  const usable = rows.filter((t) => (t.marketMedianViews ?? 0) > 0);
  if (usable.length < 3) return null;

  const W = 640;
  const H = 320;
  const pad = { l: 48, r: 16, t: 12, b: 46 };
  const maxY = Math.max(...usable.map((t) => t.marketMedianViews));
  // Log scale: market medians span orders of magnitude, and a linear axis would
  // stack every modest topic on the floor.
  const y = (v: number) => {
    const lo = Math.log10(Math.max(100, Math.min(...usable.map((t) => t.marketMedianViews))) * 0.8);
    const hi = Math.log10(maxY * 1.2);
    return H - pad.b - ((Math.log10(Math.max(100, v)) - lo) / (hi - lo)) * (H - pad.t - pad.b);
  };
  const x = (share: number) => pad.l + share * (W - pad.l - pad.r);
  const minY = Math.min(...usable.map((t) => t.marketMedianViews));
  const midX = x(0.5);
  const midYVal = [...usable.map((t) => t.marketMedianViews)].sort((a, b) => a - b)[Math.floor(usable.length / 2)];
  const midY = y(midYVal);

  return (
    <figure className="viz m-0">
      <figcaption className="mb-1 text-sm font-medium" style={{ color: 'var(--viz-ink)' }}>
        Where you own a topic, and where you could grow
      </figcaption>
      <p className="mb-2 text-xs" style={{ color: 'var(--viz-ink-2)' }}>
        Across: how much of the work on that topic is yours rather than the market&apos;s. Up: what the market&apos;s
        videos on it actually get. Top-left is the interesting corner — the market is rewarded there and you have
        barely shown up.
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Topic ownership against market reward">
        <rect x={pad.l} y={pad.t} width={midX - pad.l} height={midY - pad.t} fill="var(--viz-band)" opacity={0.55} />
        <text x={pad.l + 8} y={pad.t + 16} style={{ fontSize: 10 }}>
          room to grow
        </text>
        <text x={midX + 8} y={pad.t + 16} style={{ fontSize: 10 }}>
          you own this
        </text>
        <text x={pad.l + 8} y={H - pad.b - 8} style={{ fontSize: 10 }}>
          quiet corner
        </text>
        <text x={midX + 8} y={H - pad.b - 8} style={{ fontSize: 10 }}>
          yours, but small
        </text>

        <line x1={midX} x2={midX} y1={pad.t} y2={H - pad.b} stroke="var(--viz-grid)" strokeWidth={1} />
        <line x1={pad.l} x2={W - pad.r} y1={midY} y2={midY} stroke="var(--viz-grid)" strokeWidth={1} />
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--viz-grid)" strokeWidth={2} />
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} stroke="var(--viz-grid)" strokeWidth={2} />

        {/* End ticks only. A log axis with a full ladder of labels reads as
            precision the eye cannot use here; the extremes and the midline give
            the scale, and the table gives the exact numbers. */}
        {[
          { v: maxY, y: y(maxY) },
          { v: midYVal, y: midY },
          { v: minY, y: y(minY) },
        ].map((t, i) => (
          <text key={i} x={pad.l - 6} y={t.y + 3} textAnchor="end" style={{ fontSize: 9 }}>
            {fmt(t.v)}
          </text>
        ))}

        {usable.map((t) => {
          const cx = x(t.share ?? 0);
          const cy = y(t.marketMedianViews);
          const owned = (t.share ?? 0) >= 0.5;
          return (
            <g key={t.topic}>
              <title>{`${t.topic} — you ${t.count}, market ${t.marketCount}; market median ${t.marketMedianViews.toLocaleString()} views`}</title>
              {/* A 2px surface ring keeps overlapping points readable. */}
              <circle cx={cx} cy={cy} r={7} fill={owned ? 'var(--viz-mine)' : 'var(--viz-market)'} stroke="var(--viz-surface)" strokeWidth={2} />
              <text x={cx + 11} y={cy + 4} style={{ fontSize: 10 }}>
                {t.topic.length > 22 ? t.topic.slice(0, 21) + '…' : t.topic}
              </text>
            </g>
          );
        })}

        <text x={pad.l} y={H - 10} style={{ fontSize: 10 }}>
          none of it is yours
        </text>
        <text x={W - pad.r} y={H - 10} textAnchor="end" style={{ fontSize: 10 }}>
          all of it is yours
        </text>
        <text
          x={-(H / 2)}
          y={12}
          transform="rotate(-90)"
          textAnchor="middle"
          style={{ fontSize: 10 }}
          id={`ylab-${uid}`}
        >
          market median views
        </text>
      </svg>
      <Legend
        items={[
          { label: 'You lead the topic', color: 'var(--viz-mine)' },
          { label: 'The market leads it', color: 'var(--viz-market)' },
        ]}
      />
      <TableView
        head={['Topic', 'Your videos', 'Market videos', 'Your share', 'Market median views']}
        rows={usable.map((t) => [
          t.topic,
          t.count,
          t.marketCount ?? 0,
          `${Math.round((t.share ?? 0) * 100)}%`,
          t.marketMedianViews ?? 0,
        ])}
      />
    </figure>
  );
}
