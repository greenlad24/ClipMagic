/**
 * Leave-one-out backtest of the ETA model (./eta.ts) against the OLD estimate (control.ts before
 * 2026-10-09: one median "seconds per source minute" per stage over every other job, renders
 * keyed by format, no machine, no factory overhead).
 *
 * For every job J, both models learn from every job EXCEPT J and predict J's runs:
 *   per stage  each finished run of a stage, |predicted − actual| / actual
 *   overall    each clean run segment (claim → last stage, + the factory's start-up, transfer and
 *              wrap-up for a server run): the sum of its stages' predictions (+ predicted overhead)
 *   live       the new model's total for a stage once it reported 25 / 50 / 75 % (blendLive)
 * The new model predicts a stage as it would BEFORE it runs: a graphics stage's screencast beat
 * count is not known yet (estimated from beats per output minute).
 */
import { blendLive, median, predictOverhead, predictStage, sumPreds, type Ctx, type History, type Sample } from "./eta.js";

/** The pre-2026-10-09 estimate (control.ts stageRates/expectedSeconds), leave-one-out. */
export function oldPredict(h: History, s: Pick<Sample, "stage" | "format" | "srcMin">, excludeJob: string, onlySeg?: number): number | null {
  // onlySeg: leave out just that run of excludeJob (leave-one-run-out) instead of the whole job
  const out = (x: Sample) => x.job === excludeJob && (onlySeg === undefined || x.seg === onlySeg);
  const key = (stage: string, format: string) => (["preview", "graphics", "compose", "final"].includes(stage) ? `${stage}:${format}` : stage);
  const want = key(s.stage, s.format);
  const rates = h.samples
    .filter((x) => !out(x) && (x.srcMin ?? 0) > 0.1 && key(x.stage, x.format) === want)
    .map((x) => x.secs / x.srcMin!);
  // the old code fell back from "stage:format" to the bare stage name
  const alt = rates.length ? rates : h.samples.filter((x) => !out(x) && (x.srcMin ?? 0) > 0.1 && x.stage === s.stage).map((x) => x.secs / x.srcMin!);
  if (!alt.length || !(s.srcMin && s.srcMin > 0)) return null;
  const sorted = [...alt].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] * s.srcMin; // (the old code took the upper median)
}

export function ctxOfSample(s: Sample): Ctx {
  return {
    machine: s.machine, kind: s.kind, format: s.format, srcKind: s.srcKind, srcMin: s.srcMin, outMin: s.outMin,
    beats: null, rec: s.rec,
  };
}

export interface ErrStats { n: number; medianPct: number | null; within15: number }
export interface BacktestResult {
  stages: Record<string, { before: ErrStats; after: ErrStats }>;
  /** leave-one-job-out */
  overall: { before: ErrStats; after: ErrStats; afterWarm: ErrStats; segments: number };
  /** leave-one-run-out (the job's other runs stay in) */
  overallRun: { before: ErrStats; after: ErrStats; afterWarm: ErrStats };
  live: Record<string, ErrStats>;
  rows: Row[];
  rowsRun: Row[];
}
interface Row { job: string; seg: number; machine: string; actual: number; before: number | null; after: number | null; warm: boolean }

const pct = (pred: number, actual: number) => (Math.abs(pred - actual) / Math.max(actual, 1)) * 100;

function stats(errs: number[]): ErrStats {
  return {
    n: errs.length,
    medianPct: errs.length ? Math.round(median(errs) * 10) / 10 : null,
    within15: errs.filter((e) => e <= 15).length,
  };
}

/** Stages that take a second or less are noise for a % error (cut, timeline, preprod). */
const MIN_ACTUAL_S = 5;

export function backtest(h: History): BacktestResult {
  const per: Record<string, { before: number[]; after: number[] }> = {};
  const live: Record<string, number[]> = { "25%": [], "50%": [], "75%": [] };
  for (const s of h.samples) {
    if (s.secs < MIN_ACTUAL_S) continue;
    const b = oldPredict(h, s, s.job);
    const a = predictStage(h, s.stage, ctxOfSample(s), { excludeJob: s.job });
    const e = (per[s.stage] ??= { before: [], after: [] });
    if (b !== null) e.before.push(pct(b, s.secs));
    if (a) e.after.push(pct(a.sec, s.secs));
    for (const [label, at] of [["25%", 0.25], ["50%", 0.5], ["75%", 0.75]] as const) {
      const m = s.marks?.find(([, f]) => f >= at);
      if (!m) continue;
      const rem = blendLive(a, m[0], m[1], m[0]);
      if (rem) live[label].push(pct(m[0] + rem.sec, s.secs));
      // the prior alone at that moment, for comparison (what the live correction adds)
      if (a) (live[`${label} prior`] ??= []).push(pct(Math.max(a.sec, m[0]), s.secs));
    }
  }
  const stages: BacktestResult["stages"] = {};
  for (const [k, v] of Object.entries(per)) stages[k] = { before: stats(v.before), after: stats(v.after) };

  const job = overallOf(h, "job");
  const run = overallOf(h, "run");
  const liveOut: Record<string, ErrStats> = {};
  for (const [k, v] of Object.entries(live)) liveOut[k] = stats(v);
  return {
    stages,
    overall: { ...job.stats, segments: job.rows.length },
    overallRun: run.stats,
    live: liveOut,
    rows: job.rows,
    rowsRun: run.rows,
  };
}

/**
 * Whole runs: "job" = leave-one-JOB-out (the honest test: a new job), "run" = leave-one-RUN-out
 * (the job's other runs stay in: what a key with ≥ 3 runs looks like while the history is small).
 */
function overallOf(h: History, mode: "job" | "run") {
  const rows: Row[] = [];
  const ob: number[] = [];
  const oa: number[] = [];
  const ow: number[] = [];
  for (const seg of h.segments) {
    if (!seg.clean || !seg.stages.length) continue;
    const factory = seg.machine.key !== "box";
    const ov = seg.overhead;
    if (factory && (ov.startup === undefined || ov.wrapup === undefined)) continue; // a run whose server lines are missing
    const actual = seg.wall + (factory ? (ov.startup ?? 0) + (ov.transfer ?? 0) + (ov.wrapup ?? 0) : 0);
    if (actual < 30) continue;
    const samples = h.samples.filter((s) => s.job === seg.job && s.seg === seg.seg);
    if (!samples.length) continue;
    const opts = mode === "job" ? { excludeJob: seg.job } : { excludeRun: `${seg.job}#${seg.seg}` };
    const olds = samples.map((s) => oldPredict(h, s, s.job, mode === "run" ? seg.seg : undefined));
    const news = samples.map((s) => predictStage(h, s.stage, ctxOfSample(s), opts));
    const before = olds.every((x) => x !== null) ? olds.reduce((a, x) => a + x!, 0) : null;
    const overhead = factory ? predictOverhead(h, seg.machine, opts) : null;
    const tot = news.every((x) => x) ? sumPreds([...news, ...(overhead ? Object.values(overhead) : [])]) : null;
    const after = tot ? tot.sec : null;
    // "warm": every stage of the run that matters (≥ 5 s) has ≥ 3 other runs of its key on this machine
    const warm = news.every((x, i) => samples[i].secs < MIN_ACTUAL_S || (x && !x.scaled && x.n >= 3));
    rows.push({
      job: seg.job, seg: seg.seg, machine: seg.machine.label, actual: Math.round(actual),
      before: before === null ? null : Math.round(before), after: after === null ? null : Math.round(after), warm,
    });
    if (before !== null) ob.push(pct(before, actual));
    if (after !== null) {
      oa.push(pct(after, actual));
      if (warm) ow.push(pct(after, actual));
    }
  }
  return { rows, stats: { before: stats(ob), after: stats(oa), afterWarm: stats(ow) } };
}

export function formatBacktest(r: BacktestResult): string {
  const f = (s: ErrStats) => (s.medianPct === null ? "     —" : `${s.medianPct.toFixed(1).padStart(5)}%`) + ` (n=${s.n})`;
  const lines = ["stage        before (old)        after (new)"];
  for (const [k, v] of Object.entries(r.stages).sort()) lines.push(`${k.padEnd(12)} ${f(v.before).padEnd(19)} ${f(v.after)}`);
  lines.push("");
  lines.push(`overall      ${f(r.overall.before).padEnd(19)} ${f(r.overall.after)}   (${r.overall.segments} clean runs)`);
  lines.push(`overall, keys with ≥ 3 runs:     ${f(r.overall.afterWarm)}  — ${r.overall.afterWarm.within15}/${r.overall.afterWarm.n} within ±15%`);
  lines.push(`leave-one-RUN-out (the job's other runs stay in):`);
  lines.push(`overall      ${f(r.overallRun.before).padEnd(19)} ${f(r.overallRun.after)}`);
  lines.push(`overall, keys with ≥ 3 runs:     ${f(r.overallRun.afterWarm)}  — ${r.overallRun.afterWarm.within15}/${r.overallRun.afterWarm.n} within ±15%`);
  lines.push(`live (new, once a stage reports): 25% ${f(r.live["25%"])} · 50% ${f(r.live["50%"])} · 75% ${f(r.live["75%"])}`);
  if (r.live["50% prior"]) lines.push(`  the prior alone at those moments: 25% ${f(r.live["25% prior"])} · 50% ${f(r.live["50% prior"])} · 75% ${f(r.live["75% prior"])}`);
  lines.push("");
  lines.push("run                                         machine            actual   old     new");
  for (const x of r.rows) {
    lines.push(`${`${x.job}#${x.seg}`.slice(0, 43).padEnd(44)}${x.machine.padEnd(19)}${String(x.actual).padStart(6)}s ${String(x.before ?? "—").padStart(6)}s ${String(x.after ?? "—").padStart(6)}s${x.warm ? "" : "  (cold)"}`);
  }
  return lines.join("\n");
}
