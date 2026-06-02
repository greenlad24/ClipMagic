import { useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sparkles, TrendingDown, Wand2, Gauge, Info, ArrowDownRight, ArrowUpRight, Minus, Loader2,
} from 'lucide-react';

// ── Report shape (plain JSON persisted on the project by the server) ──────────
interface CostLineItem {
  label: string;
  labUsd: number;
  baselineUsd: number;
  savedUsd: number;
  note: string;
  assumption?: boolean;
  kind: 'saving' | 'quality-investment';
}
interface SpeedLineItem { label: string; detail: string; }
export interface OptimizationReport {
  version: number;
  projectId: string;
  generatedAt: string;
  pricingSourceDate: string;
  wallClockMs: number;
  whatWasOptimized: string[];
  qualityImprovements: string[];
  cost: {
    lineItems: CostLineItem[];
    labTotalUsd: number;
    baselineTotalUsd: number;
    savedUsd: number;
    savedPercent: number;
    netDeltaUsd: number;
    qualityInvestmentUsd: number;
    assumptions: string[];
  };
  speed: SpeedLineItem[];
  calls: Array<{ provider: string; model: string; purpose: string; inputTokens: number; outputTokens: number; costUsd: number }>;
  ffmpegSpawns: number;
}

/** Format a USD figure with adaptive precision (tiny per-call costs need 4dp). */
export function usd(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return '$0';
  const dp = abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `${n < 0 ? '-' : ''}$${abs.toFixed(dp)}`;
}

export function parseReport(json: string | null | undefined): OptimizationReport | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as OptimizationReport;
    if (!r || !r.cost || !Array.isArray(r.cost.lineItems)) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * Have the render-time speed numbers been filled in yet? The AI pipeline seeds
 * placeholder speed lines; the render worker rewrites them with real ffmpeg /
 * caption-memo counts. `ffmpegSpawns > 0` means the worker has populated them.
 */
export function hasRenderStats(report: OptimizationReport): boolean {
  return report.ffmpegSpawns > 0;
}

/**
 * Sum a set of per-item reports into a batch rollup using the SAME accurate
 * split as a single report: "saved" is ONLY the like-for-like cost reductions
 * (each report's `cost.savedUsd`, which already excludes the Opus quality
 * upgrade); the net delta and quality-investment are summed separately and
 * never folded into "saved". Percentages aren't averaged — they're recomputed
 * from the summed saving and its baseline so the figure stays honest.
 */
export interface RollupTotals {
  count: number;
  savedUsd: number;
  savedPercent: number;
  labTotalUsd: number;
  baselineTotalUsd: number;
  netDeltaUsd: number;
  qualityInvestmentUsd: number;
}
export function rollupReports(reports: OptimizationReport[]): RollupTotals {
  let savedUsd = 0, labTotalUsd = 0, baselineTotalUsd = 0, netDeltaUsd = 0, qualityInvestmentUsd = 0;
  let savingBaseline = 0;
  for (const r of reports) {
    savedUsd += r.cost.savedUsd;
    labTotalUsd += r.cost.labTotalUsd;
    baselineTotalUsd += r.cost.baselineTotalUsd;
    netDeltaUsd += r.cost.netDeltaUsd;
    qualityInvestmentUsd += r.cost.qualityInvestmentUsd;
    // Baseline of ONLY the genuine cost-reduction line items, so the % matches
    // the single-report definition (saved / saving-baseline), not the full total.
    savingBaseline += r.cost.lineItems
      .filter((li) => li.kind === 'saving')
      .reduce((s, li) => s + li.baselineUsd, 0);
  }
  return {
    count: reports.length,
    savedUsd,
    savedPercent: savingBaseline > 0 ? (savedUsd / savingBaseline) * 100 : 0,
    labTotalUsd,
    baselineTotalUsd,
    netDeltaUsd,
    qualityInvestmentUsd,
  };
}

interface Props {
  /** The project's persisted optimizationReportJson (from getProject). */
  optimizationReportJson?: string | null;
}

/**
 * Optimization Report — surfaced at the end of a pipeline run on the timeline
 * completion view. A top-bar button (with a savings badge) opens a dialog with
 * three sections: what was optimized, where this version is better, and a
 * quantified, itemized cost comparison vs the unoptimized main-app path.
 */
export default function OptimizationReportPanel({ optimizationReportJson }: Props) {
  const [open, setOpen] = useState(false);
  const report = useMemo(() => parseReport(optimizationReportJson), [optimizationReportJson]);

  // Empty/loading state: no report yet (run hasn't finished or older project).
  if (!report) {
    return (
      <Button
        variant="outline" size="sm" className="h-7 text-xs gap-1.5 opacity-60"
        disabled title="The optimization report appears here once the AI pipeline finishes."
      >
        <Sparkles className="w-3.5 h-3.5" />Optimization Report
      </Button>
    );
  }

  const { cost } = report;
  const savedPositive = cost.savedUsd > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline" size="sm" className="h-7 text-xs gap-1.5"
          title="See exactly what this run optimized and what it saved vs the main app"
        >
          <Sparkles className="w-3.5 h-3.5 text-primary" />
          Optimization Report
          {savedPositive && (
            <Badge variant="default" className="ml-0.5 h-4 px-1.5 text-[10px] leading-none">
              saved {usd(cost.savedUsd)}
            </Badge>
          )}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Optimization Report
          </DialogTitle>
          <DialogDescription>
            What this run actually optimized, why it&apos;s better than the main app, and the
            measured cost difference on the same input. Figures come from real API usage; prices
            sourced {report.pricingSourceDate}.
          </DialogDescription>
        </DialogHeader>

        <OptimizationReportBody report={report} />
      </DialogContent>
    </Dialog>
  );
}

interface BodyProps {
  report: OptimizationReport;
  /**
   * Compact layout for embedding inside a render popup (smaller headline cards,
   * tighter spacing). The full dialog uses the default (false).
   */
  compact?: boolean;
  /**
   * Render is still in progress — the speed section is awaiting the worker's
   * real numbers. Shows a "filling in live" hint instead of stale placeholders.
   */
  live?: boolean;
  /**
   * Note for the render-speed section when the render does not go through the
   * local ffmpeg worker (e.g. a browser export) — so the speed numbers won't
   * populate and we say so honestly rather than spinning forever.
   */
  renderModeNote?: string;
}

/**
 * Presentational body of the report — the three sections + headline stats +
 * itemized cost table + speed wins + audit trail. Shared by the standalone
 * dialog, the Final Render popup, the browser-export overlay, and the bulk
 * per-item expander so the markup is never duplicated.
 */
export function OptimizationReportBody({ report, compact, live, renderModeNote }: BodyProps) {
  const { cost } = report;
  const savedPositive = cost.savedUsd > 0;
  const renderStatsIn = hasRenderStats(report);

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      {/* ── Headline numbers ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <Stat
          label="Like-for-like saved"
          value={usd(cost.savedUsd)}
          sub={`${cost.savedPercent.toFixed(0)}% vs main app`}
          tone={savedPositive ? 'good' : 'neutral'}
          compact={compact}
        />
        <Stat
          label="This run cost"
          value={usd(cost.labTotalUsd)}
          sub={`main app: ${usd(cost.baselineTotalUsd)}`}
          tone="neutral"
          compact={compact}
        />
        <Stat
          label="Net delta"
          value={usd(cost.netDeltaUsd)}
          sub={cost.qualityInvestmentUsd > 0 ? `incl. ${usd(cost.qualityInvestmentUsd)} Opus upgrade` : 'all-in vs main app'}
          tone={cost.netDeltaUsd >= 0 ? 'good' : 'neutral'}
          compact={compact}
        />
      </div>

      {/* ── Section 1: What was optimized ────────────────────────────────── */}
      <Section icon={<Wand2 className="w-4 h-4 text-primary" />} title="What was optimized this run">
        <ul className="space-y-1.5">
          {report.whatWasOptimized.map((t, i) => (
            <li key={i} className="flex gap-2 text-sm text-foreground">
              <span className="text-primary mt-0.5 shrink-0">•</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* ── Section 2: Where this version is better ──────────────────────── */}
      <Section icon={<TrendingDown className="w-4 h-4 text-primary rotate-180" />} title="Where this version is better">
        <ul className="space-y-1.5">
          {report.qualityImprovements.map((t, i) => (
            <li key={i} className="flex gap-2 text-sm text-foreground">
              <span className="text-primary mt-0.5 shrink-0">•</span>
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </Section>

      {/* ── Section 3: Cost saved vs the main app ────────────────────────── */}
      <Section icon={<TrendingDown className="w-4 h-4 text-primary" />} title="Cost vs the main app (same task)">
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/60 text-muted-foreground">
                <th className="text-left font-medium px-3 py-2">Line item</th>
                <th className="text-right font-medium px-3 py-2">This run</th>
                <th className="text-right font-medium px-3 py-2">Main app</th>
                <th className="text-right font-medium px-3 py-2">Saved</th>
              </tr>
            </thead>
            <tbody>
              {cost.lineItems.map((li, i) => (
                <tr key={i} className="border-t border-border align-top">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-foreground font-medium">{li.label}</span>
                      {li.kind === 'quality-investment' && (
                        <Badge variant="secondary" className="h-4 px-1.5 text-[10px] leading-none">quality upgrade</Badge>
                      )}
                      {li.assumption && (
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px] leading-none gap-0.5">
                          <Info className="w-2.5 h-2.5" />est.
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-0.5 leading-snug">{li.note}</p>
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-foreground whitespace-nowrap">{usd(li.labUsd)}</td>
                  <td className="px-3 py-2 text-right font-mono text-muted-foreground whitespace-nowrap">{usd(li.baselineUsd)}</td>
                  <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                    <DeltaCell saved={li.savedUsd} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/40 font-semibold">
                <td className="px-3 py-2 text-foreground">Like-for-like savings</td>
                <td className="px-3 py-2 text-right font-mono text-foreground">{usd(cost.labTotalUsd)}</td>
                <td className="px-3 py-2 text-right font-mono text-muted-foreground">{usd(cost.baselineTotalUsd)}</td>
                <td className="px-3 py-2 text-right font-mono">
                  <DeltaCell saved={cost.savedUsd} strong />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {cost.assumptions.length > 0 && (
          <div className="mt-3 rounded-lg bg-muted/40 border border-border p-3">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-1.5">
              <Info className="w-3 h-3" />Math &amp; assumptions
            </p>
            <ul className="space-y-1">
              {cost.assumptions.map((a, i) => (
                <li key={i} className="text-[11px] text-muted-foreground leading-snug">{a}</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {/* ── Speed / compute wins (separate from $) ───────────────────────── */}
      {report.speed.length > 0 && (
        <Section
          icon={<Gauge className="w-4 h-4 text-primary" />}
          title="Speed / compute wins (not API cost)"
          aside={
            renderModeNote ? (
              <span className="text-[11px] text-muted-foreground font-normal">{renderModeNote}</span>
            ) : live && !renderStatsIn ? (
              <span className="text-[11px] text-muted-foreground font-normal inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />filling in live as the render runs
              </span>
            ) : undefined
          }
        >
          <ul className="space-y-1.5">
            {report.speed.map((s, i) => (
              <li key={i} className="text-sm">
                <span className="text-foreground font-medium">{s.label}</span>
                <span className="text-muted-foreground"> — {s.detail}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ── Measured calls (audit trail) ─────────────────────────────────── */}
      <details className="rounded-lg border border-border p-3">
        <summary className="text-xs font-semibold text-muted-foreground cursor-pointer select-none">
          Measured AI calls this run ({report.calls.length})
        </summary>
        <div className="mt-2 space-y-1">
          {report.calls.map((c, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-[11px] font-mono text-muted-foreground">
              <span className="truncate">
                {c.provider}/{c.model} · {c.purpose}
                {c.inputTokens + c.outputTokens > 0 ? ` · ${c.inputTokens}in/${c.outputTokens}out` : ''}
              </span>
              <span className="text-foreground whitespace-nowrap">{usd(c.costUsd)}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function Stat({ label, value, sub, tone, compact }: { label: string; value: string; sub: string; tone: 'good' | 'neutral'; compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-border bg-card ${compact ? 'p-2.5' : 'p-3'}`}>
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`font-bold mt-0.5 ${compact ? 'text-base' : 'text-xl'} ${tone === 'good' ? 'text-primary' : 'text-foreground'}`}>{value}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
    </div>
  );
}

function Section({ icon, title, aside, children }: { icon: React.ReactNode; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-1">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground mb-2">
        {icon}<span>{title}</span>
        {aside && <span className="ml-auto">{aside}</span>}
      </h3>
      {children}
    </div>
  );
}

function DeltaCell({ saved, strong }: { saved: number; strong?: boolean }) {
  if (Math.abs(saved) < 1e-9) {
    return <span className="text-muted-foreground inline-flex items-center gap-0.5"><Minus className="w-3 h-3" />$0</span>;
  }
  const positive = saved > 0;
  const cls = positive ? 'text-primary' : 'text-muted-foreground';
  return (
    <span className={`inline-flex items-center gap-0.5 ${cls} ${strong ? 'font-bold' : ''}`}>
      {positive ? <ArrowDownRight className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
      {usd(Math.abs(saved))}
    </span>
  );
}
