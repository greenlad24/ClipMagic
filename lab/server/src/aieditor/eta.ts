/**
 * Auto Editor — the TIMING MODEL behind every ETA (Jake 2026-10-09: "can the Estimated time
 * (ETA) be accurate every time?").
 *
 * The old estimate was one median "seconds per minute of source" per stage over every job on
 * disk. Most of those ran on the 4-core MAIN BOX, so a 32-core factory preview showed
 * "~36m 58s" and took ~5 min. This model learns from history instead, per stage, keyed on:
 *
 *   machine   "box" (the main box) or "cpuN" (a factory server by vCPU count: c-32 and
 *             c2-32vcpu-64gb are one key, s-8vcpu-32gb-amd another)
 *   kind      cut / creative / chain (a Full edit) / handoff — preferred when ≥ 2 runs match
 *   variant   what changes a stage's cost: the format for renders, a Descript download vs a
 *             local file for "download", screencast recording vs overlays only for graphics/compose
 *   unit      the amount the stage scales with (unitOf):
 *               source minutes  download (Descript), audio, transcribe, align, takes
 *               output minutes  listen, preview, compose, final, handoff, graphics without recording
 *               screencast beats graphics with recording (the plan's beat count; estimated from
 *                               beats per output minute until the plan exists)
 *               fixed           cut, timeline, preprod, a local "download" (a probe)
 *             "takes" is an API call, but its time grows with the transcript it reads (58 s for
 *             15 min, 176 s for 50 min), so it is per source minute, not a fixed time.
 *
 * Robust stats: the median rate and its MAD. With no history for the machine at all, the other
 * machines' rates are scaled by cores, (theirs / ours)^alpha, with alpha fitted per stage from
 * the machines that do have runs (default 0.8 for CPU stages, 0 for network/API ones) — and the
 * estimate says "first run on this server size".
 *
 * History comes from every job on disk: events.jsonl (stage done lines with their durations,
 * the factory's create / up / results-back / destroyed lines), log.txt for jobs from before the
 * structured log, status.json (the worker's per-stage meta: machine, cpus, region, units —
 * recorded since 2026-10-09), runner.json, source.json, edl.json, and factory-history.jsonl.
 *
 * Pure functions + one cached loader; the backtest (src/scripts/aieditor-eta-backtest.ts) and
 * the test on a fake history (src/scripts/aieditor-eta.test.ts) drive the same code.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type Kind = "cut" | "creative" | "chain" | "handoff";

export interface Machine {
  /** "box" or "cpuN" — the history key */
  key: string;
  /** what the UI says: "main box", "c-32", "s-8vcpu-32gb-amd" */
  label: string;
  cpus: number;
  slug: string | null;
  region?: string | null;
}

export interface Sample {
  job: string;
  stage: string;
  secs: number;
  /** when it finished (unix s) */
  t: number;
  /** the run segment within the job (one per "claimed action=") */
  seg: number;
  machine: Machine;
  kind: Kind;
  format: string;
  /** "descript" = a real download; "local" = a Lab edit / upload / earlier narration (a probe) */
  srcKind: "descript" | "local";
  srcMin: number | null;
  outMin: number | null;
  beats: number | null;
  overlays: number | null;
  /** the job records screencasts (graphics + compose cost far more) */
  rec: boolean;
  /** progress reports while it ran: [seconds since the stage started, frac] (for the live backtest) */
  marks?: [number, number][];
}

export type OverheadPart = "startup" | "transfer" | "wrapup";
export interface OverheadSample { job: string; seg: number; part: OverheadPart; secs: number; machine: Machine }

/** One run of a job ("claimed action=…" → its last stage), for the overall backtest. */
export interface Segment {
  job: string;
  seg: number;
  action: string;
  machine: Machine;
  /** every stage ran to done (no failure, cancel or cut-off) */
  clean: boolean;
  stages: { stage: string; secs: number }[];
  /** claim → last stage done (s) */
  wall: number;
  overhead: Partial<Record<OverheadPart, number>>;
}

export interface History { samples: Sample[]; overhead: OverheadSample[]; segments: Segment[] }

export interface Ctx {
  machine: Machine;
  kind: Kind;
  format: string;
  srcKind: "descript" | "local";
  srcMin: number | null;
  outMin: number | null;
  /** screencast beats once the plan exists (null = estimate from history) */
  beats: number | null;
  rec: boolean;
}

export interface Pred {
  /** best estimate, seconds */
  sec: number;
  lo: number;
  hi: number;
  /** runs behind it */
  n: number;
  /** a tight, well-supported number: shown as one value */
  confident: boolean;
  /** no run of this stage on this machine: scaled by cores from other machines */
  scaled: boolean;
  unit: Unit;
  /** progressCurve: reported fraction → share of the stage's time (21 points, frac 0, 0.05 … 1) */
  curve?: number[] | null;
}

export type Unit = "src" | "out" | "beat" | "fixed";

// ── machines ────────────────────────────────────────────────────────────────

export const BOX_CPUS = Number(process.env.AIEDITOR_BOX_CPUS) || os.cpus().length || 4;

/** vCPUs of a DigitalOcean size slug: c-32, c2-32vcpu-64gb, s-8vcpu-32gb-amd, g-16vcpu-64gb … */
export function cpusOfSlug(slug: string | null | undefined): number | null {
  const s = String(slug ?? "");
  const m = /(\d+)vcpu/.exec(s) ?? /^(?:c|c2|g|gd|m|m3|so|so1_5)-(\d+)\b/.exec(s);
  return m ? Number(m[1]) : null;
}

export function boxMachine(cpus = BOX_CPUS): Machine {
  return { key: "box", label: "main box", cpus, slug: null };
}

export function factoryMachine(slug: string, region?: string | null, cpus?: number | null): Machine {
  const n = cpus || cpusOfSlug(slug) || 32;
  return { key: `cpu${n}`, label: slug, cpus: n, slug, region: region ?? null };
}

// ── stage classes ───────────────────────────────────────────────────────────

const RENDER = new Set(["listen", "preview", "compose", "final", "handoff"]);
const FIXED = new Set(["cut", "timeline", "preprod"]);
/** stages that use every core: these scale with the machine (alpha) */
const CPU = new Set(["audio", "align", "listen", "preview", "graphics", "compose", "final", "handoff"]);
const DEFAULT_ALPHA = 0.8;

export function unitOf(stage: string, ctx: Pick<Ctx, "srcKind" | "rec">): Unit {
  if (stage === "download") return ctx.srcKind === "descript" ? "src" : "fixed";
  if (FIXED.has(stage)) return "fixed";
  if (stage === "graphics") return ctx.rec ? "beat" : "out";
  if (RENDER.has(stage)) return "out";
  return "src"; // audio, transcribe, align, takes (+ any stage this model does not know yet)
}

/** What makes two runs of a stage comparable at all (besides the machine). */
export function variantOf(stage: string, c: Pick<Ctx, "format" | "srcKind" | "rec">): string {
  if (stage === "download") return c.srcKind;
  if (stage === "graphics" || stage === "compose") return `${c.format}:${c.rec ? "rec" : "norec"}`;
  if (RENDER.has(stage)) return c.format;
  return "";
}

function amountOf(unit: Unit, c: { srcMin: number | null; outMin: number | null; beats: number | null }): number | null {
  if (unit === "fixed") return 1;
  const v = unit === "src" ? c.srcMin : unit === "out" ? c.outMin : c.beats;
  return v !== null && v > 0 ? v : null;
}

// ── robust stats ────────────────────────────────────────────────────────────

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** relative spread: MAD × 1.4826 / median, with a floor that shrinks as runs accumulate */
function relSpread(rates: number[]): number {
  const med = median(rates);
  const n = rates.length;
  const mad = n >= 2 && med > 0 ? (median(rates.map((r) => Math.abs(r - med))) * 1.4826) / med : 0;
  const floor = n >= 5 ? 0.06 : n >= 3 ? 0.08 : n === 2 ? 0.2 : 0.35;
  return Math.min(0.9, Math.max(mad, floor));
}

// ── parsing a job's history ─────────────────────────────────────────────────

export interface JobFiles {
  id: string;
  req: any;
  source: any;
  edl: any;
  status: any;
  runner: any;
  /** events.jsonl text ("" = none) */
  events: string;
  /** log.txt text, used when there is no events.jsonl */
  log: string;
  /** this job's rows of factory-history.jsonl */
  history?: any[];
}

export function kindOf(req: any): Kind {
  if (req?.handoff === true) return "handoff";
  if (req?.chain === "creative" || req?.chained_from) return "chain";
  return req?.workflow === "creative" ? "creative" : "cut";
}

export function srcKindOf(req: any): "descript" | "local" {
  const k = req?.source?.kind;
  return k === "job" || k === "upload" || k === "job_source" ? "local" : "descript";
}

/** "13/13 screencast(s) …, 11 overlay(s)" → beats 13, overlays 11 */
export function beatsOf(note: string | null | undefined): { beats: number | null; overlays: number | null } {
  const s = String(note ?? "");
  const b = /(\d+)(?:\/\d+)? screencast/.exec(s);
  const o = /(\d+) overlay/.exec(s);
  return { beats: b ? Number(b[1]) : null, overlays: o ? Number(o[1]) : null };
}

export function outMinOf(edl: any): number | null {
  const vids = Array.isArray(edl?.videos) ? edl.videos : [];
  const s = vids.reduce((a: number, v: any) => a + (Number(v?.duration) || 0), 0);
  return s > 0 ? s / 60 : null;
}

interface RawEvent { t: number; stage: string; kind: string; state?: string; msg: string; frac?: number }

function eventsOf(text: string): RawEvent[] {
  const out: RawEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.t === "number") out.push({
        t: e.t, stage: String(e.stage ?? "job"), kind: String(e.kind ?? "log"), state: e.state, msg: String(e.msg ?? ""),
        frac: typeof e.frac === "number" ? e.frac : undefined,
      });
    } catch { /* a torn line */ }
  }
  return out;
}

/** log.txt (pre-events jobs) → the same event shape: claims, stage start/done, FAILED. */
function legacyEventsOf(text: string): RawEvent[] {
  const out: RawEvent[] = [];
  const open = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (.*)$/.exec(line);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}Z`) / 1000;
    const msg = m[3];
    const st = /^stage (\w+) (start|done)\b ?(.*)$/.exec(msg);
    if (st) {
      if (st[2] === "start") {
        open.set(st[1], t);
        out.push({ t, stage: st[1], kind: "stage", state: "running", msg: `▶ ${st[1]} started` });
      } else {
        const t0 = open.get(st[1]);
        open.delete(st[1]);
        const took = t0 !== undefined && st[3] !== "reused" ? ` in ${(t - t0).toFixed(1)}s` : "";
        out.push({ t, stage: st[1], kind: "stage", state: "done", msg: `✓ ${st[1]} done${took}${st[3] ? ` — ${st[3]}` : ""}` });
      }
      continue;
    }
    if (msg.startsWith("factory: ")) {
      out.push({ t, stage: "factory", kind: "log", msg: msg.slice(9) });
      continue;
    }
    if (msg.startsWith("FAILED") || msg === "cancelled") {
      for (const [name] of open) out.push({ t, stage: name, kind: "stage", state: "failed", msg: `■ ${name} failed` });
      open.clear();
    }
    out.push({ t, stage: "job", kind: "log", msg });
  }
  return out;
}

/**
 * One job's samples, overhead samples and run segments. The machine of a segment is the factory
 * server announced before its claim ("factory server N (size) creating in region…"), else the
 * main box; the worker's own per-stage meta (status.json, since 2026-10-09) wins when present.
 */
export function parseJob(f: JobFiles, boxCpus = BOX_CPUS): History {
  const samples: Sample[] = [];
  const overhead: OverheadSample[] = [];
  const segments: Segment[] = [];
  const req = f.req ?? {};
  const kind = kindOf(req);
  const format = String(req.format ?? "long");
  const srcKind = srcKindOf(req);
  const srcDur = Number(f.source?.duration);
  const srcMin = srcDur > 0 ? srcDur / 60 : null;
  const outMin = outMinOf(f.edl) ?? (kind === "creative" || kind === "handoff" ? srcMin : null);
  const evs = f.events.trim() ? eventsOf(f.events) : legacyEventsOf(f.log ?? "");
  const box = boxMachine(boxCpus);
  // the job records screencasts when any graphics run says so
  let rec = false;
  for (const e of evs) if (e.kind === "stage" && e.stage === "graphics" && e.state === "done" && (beatsOf(e.msg).beats ?? 0) > 0) rec = true;

  type Pending = { machine: Machine; tCreate: number; startup: number | null; tUp: number | null };
  let pendingFactory = null as Pending | null;
  let seg = null as Segment | null;
  let segFactory = null as Pending | null;
  let segIdx = -1;
  let tClaim = 0;
  let lastStageEnd = 0;
  const started: Record<string, number> = {};
  const marks: Record<string, [number, number][]> = {};
  const closeSeg = () => {
    if (seg) {
      seg.wall = Math.max(0, lastStageEnd - tClaim);
      segments.push(seg);
    }
    seg = null;
  };
  for (const e of evs) {
    if (e.stage === "factory") {
      const cr = /factory server (\d+) \(([^)]+)\) creating in ([\w-]+)/.exec(e.msg);
      if (cr) {
        pendingFactory = { machine: factoryMachine(cr[2], cr[3]), tCreate: e.t, startup: null, tUp: null };
        continue;
      }
      // away from home the copy of the server image counts from the request too: "(Ns after create)"
      // is the server's own start-up — the copy is a WAIT (runner.json "copying-image"), not start-up
      const up = /factory server up at \S+ after (\d+)s(?: \((\d+)s after create\))?/.exec(e.msg);
      if (up && pendingFactory) {
        const startup = Number(up[2] ?? up[1]);
        pendingFactory.startup = startup;
        pendingFactory.tUp = e.t;
        overhead.push({ job: f.id, seg: segIdx + 1, part: "startup", secs: startup, machine: pendingFactory.machine });
        continue;
      }
      if (/factory server \d+ (destroyed|DELETE NOT CONFIRMED)/.test(e.msg)) {
        const s = seg as Segment | null;
        if (s && segFactory && lastStageEnd > 0 && s.clean) {
          const w = Math.max(0, e.t - lastStageEnd);
          s.overhead.wrapup = w;
          overhead.push({ job: f.id, seg: segIdx, part: "wrapup", secs: w, machine: segFactory.machine });
        }
        closeSeg();
        pendingFactory = null;
        segFactory = null;
      }
      continue;
    }
    const cl = /^claimed action=(\w+)/.exec(e.msg);
    if (cl && e.kind === "log") {
      closeSeg();
      segIdx++;
      tClaim = e.t;
      lastStageEnd = e.t;
      segFactory = pendingFactory;
      const machine = segFactory ? segFactory.machine : box;
      seg = { job: f.id, seg: segIdx, action: cl[1], machine, clean: true, stages: [], wall: 0, overhead: {} };
      if (segFactory) {
        if (segFactory.startup !== null) seg.overhead.startup = segFactory.startup;
        if (segFactory.tUp !== null) {
          const tr = Math.max(0, e.t - segFactory.tUp);
          seg.overhead.transfer = tr;
          overhead.push({ job: f.id, seg: segIdx, part: "transfer", secs: tr, machine });
        }
      }
      pendingFactory = null;
      continue;
    }
    if (e.kind === "progress" && typeof e.frac === "number" && e.stage in started) {
      (marks[e.stage] ??= []).push([Math.max(0, e.t - started[e.stage]), e.frac]);
      continue;
    }
    if (e.kind !== "stage" || !seg || e.stage === "job") continue;
    const s = seg as Segment;
    if (e.state === "running") {
      started[e.stage] = e.t;
      marks[e.stage] = [];
      continue;
    }
    if (e.state === "failed" || e.state === "interrupted") {
      s.clean = false;
      continue;
    }
    if (e.state !== "done") continue;
    const m = /done in ([\d.]+)s(?: — ([\s\S]*))?$/.exec(e.msg);
    lastStageEnd = e.t;
    if (!m) continue; // reused / nothing ran
    const secs = Number(m[1]);
    if (!(secs >= 0) || secs > 12 * 3600) continue;
    s.stages.push({ stage: e.stage, secs });
    const meta = f.status?.stages?.[e.stage]?.meta;
    const fin = Number(f.status?.stages?.[e.stage]?.finished_at);
    const own = meta && Number.isFinite(fin) && Math.abs(fin - e.t) < 3 ? meta : null;
    const bo = beatsOf(m[2]);
    samples.push({
      job: f.id,
      stage: e.stage,
      secs,
      t: e.t,
      seg: segIdx,
      machine: own?.machine ? (own.machine === "box" ? boxMachine(Number(own.cpus) || boxCpus) : factoryMachine(own.machine, own.region, Number(own.cpus) || null)) : s.machine,
      kind,
      format,
      srcKind,
      srcMin: Number(own?.src_min) > 0 ? Number(own.src_min) : srcMin,
      outMin: Number(own?.out_min) > 0 ? Number(own.out_min) : outMin,
      beats: Number.isFinite(Number(own?.beats)) && own?.beats !== null && own?.beats !== undefined ? Number(own.beats) : bo.beats,
      overlays: bo.overlays,
      rec,
      marks: marks[e.stage]?.length ? marks[e.stage] : undefined,
    });
    delete started[e.stage];
    delete marks[e.stage];
  }
  closeSeg();
  return { samples, overhead, segments };
}

export function mergeHistories(hs: History[]): History {
  return { samples: hs.flatMap((h) => h.samples), overhead: hs.flatMap((h) => h.overhead), segments: hs.flatMap((h) => h.segments) };
}

// ── prediction ──────────────────────────────────────────────────────────────

/** alpha per stage: fitted from the machines that ran it (≥ 2 core counts), else the class default */
export function alphaOf(stage: string, pool: { rate: number; cpus: number }[]): number {
  if (!CPU.has(stage)) return 0;
  const byCpu = new Map<number, number[]>();
  for (const p of pool) (byCpu.get(p.cpus) ?? byCpu.set(p.cpus, []).get(p.cpus)!).push(p.rate);
  if (byCpu.size < 2) return DEFAULT_ALPHA;
  const pts = [...byCpu].map(([c, rs]) => [Math.log(c), Math.log(median(rs))]);
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  const sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const slope = sxx > 0 ? sxy / sxx : -DEFAULT_ALPHA;
  return Math.max(0, Math.min(1.3, -slope));
}

export interface PredictOpts {
  /** leave this job out (the backtest: leave-one-job-out) */
  excludeJob?: string;
  /** leave this one run out, "job#seg" (the backtest's leave-one-run-out view) */
  excludeRun?: string;
}

const kept = (opts: PredictOpts) => (s: { job: string; seg: number }) =>
  s.job !== opts.excludeJob && `${s.job}#${s.seg}` !== opts.excludeRun;

/** beats per output minute, from runs that recorded (for a recording job before its plan exists) */
function beatsPerOutMin(h: History, opts: PredictOpts): number | null {
  const xs = h.samples
    .filter((s) => s.stage === "graphics" && kept(opts)(s) && (s.beats ?? 0) > 0 && (s.outMin ?? 0) > 0)
    .map((s) => s.beats! / s.outMin!);
  return xs.length ? median(xs) : null;
}

/** output minutes per source minute of a cut (before the cut exists) */
function cutRatio(h: History, opts: PredictOpts): number | null {
  const seen = new Set<string>();
  const xs: number[] = [];
  for (const s of h.samples) {
    if (!kept(opts)(s) || seen.has(s.job) || s.kind === "creative" || s.kind === "handoff") continue;
    if ((s.srcMin ?? 0) > 0 && (s.outMin ?? 0) > 0) {
      seen.add(s.job);
      xs.push(s.outMin! / s.srcMin!);
    }
  }
  return xs.length ? median(xs) : null;
}

export function predictStage(h: History, stage: string, ctx: Ctx, opts: PredictOpts = {}): Pred | null {
  const unit = unitOf(stage, ctx);
  let est = 0; // extra relative uncertainty from estimated units
  let c = ctx;
  if (unit === "out" && c.outMin === null && c.srcMin !== null) {
    const r = c.kind === "creative" || c.kind === "handoff" ? 1 : cutRatio(h, opts);
    if (r !== null) {
      c = { ...c, outMin: c.srcMin * r };
      est = r === 1 ? 0 : 0.25;
    }
  }
  if (unit === "beat" && c.beats === null) {
    const out = c.outMin ?? (c.srcMin !== null ? c.srcMin * (cutRatio(h, opts) ?? 1) : null);
    const bpm = beatsPerOutMin(h, opts);
    if (out !== null && bpm !== null) {
      c = { ...c, beats: Math.max(1, Math.round(out * bpm)) };
      est = 0.4;
    }
  }
  const amount = amountOf(unit, c);
  if (amount === null) return null;
  const stageRuns = h.samples.filter((s) => s.stage === stage && kept(opts)(s));
  if (!stageRuns.length && FIXED.has(stage)) {
    // a bookkeeping stage the model has never timed: about a second
    return { sec: 1, lo: 0, hi: 5, n: 0, confident: false, scaled: false, unit };
  }

  const variant = variantOf(stage, c);
  const all = stageRuns;
  // a run's rate in THIS prediction's unit (a fallback run of another variant is measured the same way)
  const rateOf = (s: Sample): number | null => {
    const a = amountOf(unit, s);
    return a === null ? null : s.secs / a;
  };
  const sameVar = all.filter((s) => variantOf(stage, s) === variant && unitOf(stage, s) === unit);
  // a stage the model has never seen in this variant falls back to the other variants (less sure)
  let pool = sameVar;
  if (!pool.length) {
    // …but never across recording / no recording for graphics: 636 s vs 9736 s for the same
    // length — no number is more honest than that one
    pool = stage === "graphics" ? all.filter((s) => s.rec === c.rec) : all;
    est = Math.max(est, stage === "compose" ? 0.6 : 0.5);
  }
  const rated = pool.map((s) => ({ s, rate: rateOf(s) })).filter((x): x is { s: Sample; rate: number } => x.rate !== null && x.rate >= 0);
  if (!rated.length) return null;

  // network / API stages do not care which machine runs them: every run counts
  const mine = CPU.has(stage) ? rated.filter((x) => x.s.machine.key === ctx.machine.key) : rated;
  let rates: number[];
  let scaled = false;
  if (mine.length) {
    // the exact size slug (c-32 vs c2-32vcpu-64gb: same cores, other CPUs) and then the same
    // workflow kind, each when ≥ 2 runs back it
    const slug = mine.filter((x) => x.s.machine.slug === ctx.machine.slug);
    const base = slug.length >= 2 ? slug : mine;
    const kindMatch = base.filter((x) => x.s.kind === ctx.kind);
    rates = (kindMatch.length >= 2 ? kindMatch : base).map((x) => x.rate);
  } else {
    scaled = true;
    // the main box is shared and slow for its cores: a server size is scaled from other SERVERS
    // when there are any (the box only says something about the box)
    const servers = rated.filter((x) => x.s.machine.key !== "box");
    const peers = ctx.machine.key !== "box" && servers.length ? servers : rated;
    const alpha = alphaOf(stage, peers.map((x) => ({ rate: x.rate, cpus: x.s.machine.cpus })));
    // scale from the nearest core counts (in log space) — the closest machine says the most
    const dist = (x: { s: Sample }) => Math.abs(Math.log(x.s.machine.cpus / ctx.machine.cpus));
    const best = Math.min(...peers.map(dist));
    const near = peers.filter((x) => dist(x) <= best + 1e-9);
    rates = near.map((x) => x.rate * (x.s.machine.cpus / ctx.machine.cpus) ** alpha);
  }
  const rate = median(rates);
  const sec = rate * amount;
  let rel = relSpread(rates);
  if (scaled) rel = Math.max(rel, 0.4);
  rel = Math.min(0.9, Math.sqrt(rel ** 2 + est ** 2));
  const n = rates.length;
  return {
    sec: round1(sec),
    lo: round1(sec * (1 - rel)),
    hi: round1(sec * (1 + rel)),
    n,
    confident: !scaled && est === 0 && n >= 3 && rel <= 0.15,
    scaled,
    unit,
    curve: progressCurve(h, stage, opts, variant),
  };
}

/** 21 points, frac 0, 0.05 … 1 (fine enough that a stage parked at 75 % lands on a point) */
const GRID = Array.from({ length: 21 }, (_, i) => i / 20);

/**
 * How a stage's reported fraction maps to the share of its TIME gone by, learned from its past
 * runs: curve[i] = median share of the stage's duration elapsed when it first reported
 * frac ≥ i/20. Compose, e.g., says 75 % a quarter of the way in and then sits there — reading
 * its fraction as linear time would predict a quarter of the real duration.
 * null = no run with progress reports (the fraction is then read as linear).
 */
export function progressCurve(h: History, stage: string, opts: PredictOpts = {}, variant?: string): number[] | null {
  const all = h.samples.filter((s) => s.stage === stage && kept(opts)(s) && s.secs >= 20 && (s.marks?.length ?? 0) >= 2);
  // the same variant's runs when there are any (compose with screencasts has other phases than without)
  const same = variant === undefined ? [] : all.filter((s) => variantOf(stage, s) === variant);
  const runs = same.length ? same : all;
  if (!runs.length) return null;
  const curve = GRID.map((g) => {
    if (g === 0) return 0;
    if (g === 1) return 1;
    return median(runs.map((s) => {
      const m = s.marks!.find(([, f]) => f >= g);
      return m ? Math.min(1, m[0] / s.secs) : 1;
    }));
  });
  for (let i = 1; i < curve.length; i++) curve[i] = Math.max(curve[i], curve[i - 1]);
  return curve.map((x) => Math.round(x * 1000) / 1000);
}

/** share of the stage's time gone by at fraction f (linear without a curve) */
export function timeShare(curve: number[] | null | undefined, f: number): number {
  if (!curve || curve.length !== GRID.length) return f;
  const x = Math.max(0, Math.min(1, f)) * 20;
  const i = Math.min(19, Math.floor(x + 1e-9));
  return curve[i] + (curve[i + 1] - curve[i]) * (x - i);
}

/** Factory start-up, job transfer and wrap-up (pull + delete) for a machine; null on the box. */
export function predictOverhead(h: History, machine: Machine, opts: PredictOpts = {}): Record<OverheadPart, Pred> | null {
  if (machine.key === "box") return null;
  const out = {} as Record<OverheadPart, Pred>;
  for (const part of ["startup", "transfer", "wrapup"] as OverheadPart[]) {
    const all = h.overhead.filter((o) => o.part === part && kept(opts)(o));
    // size AND region: a server away from SGP1 starts over the public internet
    const here = all.filter((o) => o.machine.key === machine.key && (o.machine.region ?? null) === (machine.region ?? null));
    const mine = here.length ? here : all.filter((o) => o.machine.key === machine.key);
    const xs = (mine.length ? mine : all).map((o) => o.secs);
    const fallback = { startup: 90, transfer: 20, wrapup: 25 }[part];
    const sec = xs.length ? median(xs) : fallback;
    const rel = xs.length ? Math.max(relSpread(xs), mine.length ? 0 : 0.4) : 0.6;
    out[part] = {
      sec: round1(sec), lo: round1(sec * (1 - rel)), hi: round1(sec * (1 + rel)),
      n: xs.length, confident: mine.length >= 3 && rel <= 0.15, scaled: !mine.length, unit: "fixed",
    };
  }
  return out;
}

/** Add estimates: half-widths combine between independent (RSS) and fully correlated (sum). */
export function sumPreds(ps: (Pred | null | undefined)[]): Pred | null {
  const xs = ps.filter((p): p is Pred => !!p);
  if (!xs.length) return null;
  const sec = xs.reduce((a, p) => a + p.sec, 0);
  const lin = xs.reduce((a, p) => a + Math.max(0, p.hi - p.sec), 0);
  const rss = Math.sqrt(xs.reduce((a, p) => a + Math.max(0, p.hi - p.sec) ** 2, 0));
  const linLo = xs.reduce((a, p) => a + Math.max(0, p.sec - p.lo), 0);
  const rssLo = Math.sqrt(xs.reduce((a, p) => a + Math.max(0, p.sec - p.lo) ** 2, 0));
  const hw = (lin + rss) / 2;
  const hwLo = (linLo + rssLo) / 2;
  return {
    sec: round1(sec), lo: round1(Math.max(0, sec - hwLo)), hi: round1(sec + hw),
    n: Math.min(...xs.map((p) => p.n)),
    confident: sec > 0 && hw / sec <= 0.15 && xs.every((p) => !p.scaled),
    scaled: xs.some((p) => p.scaled),
    unit: "fixed",
  };
}

export interface JobEstimate {
  machine: Machine;
  /** no run at all on this machine key: every number is scaled by cores */
  firstRun: boolean;
  /** runs on this machine key (any stage) */
  runsOnMachine: number;
  stages: Record<string, Pred | null>;
  overhead: Record<OverheadPart, Pred> | null;
  /** every stage + overhead (null when a stage has no estimate yet, e.g. the source length is unknown) */
  total: Pred | null;
  /** stages without an estimate */
  unknown: string[];
}

export function estimateJob(h: History, stageIds: string[], ctx: Ctx, opts: PredictOpts = {}): JobEstimate {
  const stages: Record<string, Pred | null> = {};
  const unknown: string[] = [];
  for (const id of stageIds) {
    stages[id] = predictStage(h, id, ctx, opts);
    if (!stages[id]) unknown.push(id);
  }
  const overhead = predictOverhead(h, ctx.machine, opts);
  const segs = new Set(h.samples.filter((s) => s.machine.key === ctx.machine.key && kept(opts)(s)).map((s) => `${s.job}#${s.seg}`));
  const total = unknown.length ? null : sumPreds([...Object.values(stages), ...(overhead ? Object.values(overhead) : [])]);
  return { machine: ctx.machine, firstRun: segs.size === 0, runsOnMachine: segs.size, stages, overhead, total, unknown };
}

/**
 * Live correction of one RUNNING stage: once it reports a fraction, blend the prior with the
 * observed rate, so the ETA converges on the truth as the stage runs. The fraction is first
 * mapped to the share of TIME it stands for (progressCurve); the observation is the elapsed time
 * when the stage REACHED its current fraction (a stage that sits at 75 % does not get slower on
 * paper every second it sits there), and it weighs as much as that time share.
 * Returns the predicted REMAINING seconds (+ range).
 *   elapsed    seconds since the stage started
 *   reachedAt  seconds since the start when the current fraction was first reported (≤ elapsed)
 * Mirrored in lab/src/components/autoeditor/etaLive.ts (the web cannot import server code).
 */
export function blendLive(prior: Pred | null, elapsed: number, frac: number | null, reachedAt: number = elapsed): Pred | null {
  const f = frac !== null && Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  const share = timeShare(prior?.curve, f);
  const at = Math.max(0, Math.min(elapsed, reachedAt));
  const observed = share >= 0.02 && f > 0 && at >= 3 ? at / share : null;
  if (!prior && observed === null) return null;
  // never less than what has gone by: a run past its estimate keeps a small, honest tail
  const tail = (total: number) => Math.max(total - elapsed, 0.05 * Math.max(total, elapsed));
  if (!prior) {
    const rem = tail(observed!);
    const rel = Math.max(0.1, 0.6 * (1 - share));
    return { sec: round1(rem), lo: round1(rem * (1 - rel)), hi: round1(rem * (1 + rel)), n: 0, confident: share >= 0.5, scaled: false, unit: "fixed" };
  }
  const relP = prior.sec > 0 ? (prior.hi - prior.sec) / prior.sec : 0.3;
  if (observed === null) {
    const rem = tail(prior.sec);
    const rel = Math.max(relP, elapsed > prior.sec ? 0.5 : 0);
    return { ...prior, sec: round1(rem), lo: round1(rem * (1 - Math.min(0.9, rel))), hi: round1(rem * (1 + rel)) };
  }
  const w = share;
  const total = (1 - w) * prior.sec + w * observed;
  const rem = tail(total);
  const rel = Math.max(0.05, (relP + 0.1) * (1 - share));
  return { ...prior, sec: round1(rem), lo: round1(rem * (1 - rel)), hi: round1(rem * (1 + rel)), confident: prior.confident || share >= 0.6 };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

// ── the job → context ───────────────────────────────────────────────────────

export interface FactoryCfg { enabled?: boolean; size?: string; region?: string; actions?: string[] }

/**
 * Where a job runs: a live factory run's own server; "box" when asked or when the factory is
 * off; else the configured factory size (Jake: always a 32-core).
 */
export function machineFor(req: any, runner: any, cfg: FactoryCfg | null, action = "run", running = false): Machine {
  if (running && runner?.kind === "factory" && runner.size && runner.state !== "done" && runner.state !== "failed") {
    return factoryMachine(String(runner.size), runner.region);
  }
  if (running && runner?.kind === "box" && runner.state === "running") return boxMachine();
  const runOn = req?.run_on ?? "auto";
  if (runOn === "box") return boxMachine();
  const acts = cfg?.actions ?? ["run", "render", "final", "edit"];
  if (cfg?.enabled && acts.includes(action)) return factoryMachine(String(cfg.size ?? "c-32"), cfg.region ?? null);
  return boxMachine();
}

export function ctxFor(req: any, source: any, edl: any, status: any, machine: Machine): Ctx {
  const kind = kindOf(req);
  const srcDur = Number(source?.duration);
  const srcMin = srcDur > 0 ? srcDur / 60 : null;
  const outMin = outMinOf(edl) ?? (kind === "creative" || kind === "handoff" ? srcMin : null);
  const gNote = status?.stages?.graphics?.state === "done" ? status.stages.graphics.note : null;
  const pre = status?.stages?.preprod;
  const preSites = pre?.state === "done" ? /(\d+) screencast site/.exec(String(pre.note ?? "")) : null;
  const format = String(req?.format ?? "long");
  let rec = format === "long" && kind !== "handoff" && ((Array.isArray(req?.sites) && req.sites.length > 0) || kind === "creative" || kind === "chain");
  if (preSites) rec = format === "long" && kind !== "handoff" && Number(preSites[1]) > 0;
  return { machine, kind, format, srcKind: srcKindOf(req), srcMin, outMin, beats: beatsOf(gNote).beats, rec };
}

// ── loading the history from disk (cached a minute) ─────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}

export async function readJobFiles(root: string): Promise<JobFiles[]> {
  const jobsDir = path.join(root, "jobs");
  let names: string[] = [];
  try {
    names = await fsp.readdir(jobsDir);
  } catch {
    names = [];
  }
  const hist: any[] = [];
  for (const line of (await readText(path.join(root, "factory-history.jsonl"))).split("\n")) {
    try {
      if (line.trim()) hist.push(JSON.parse(line));
    } catch { /* skip */ }
  }
  const out: JobFiles[] = [];
  for (const id of names) {
    if (!ID_RE.test(id)) continue;
    const d = path.join(jobsDir, id);
    const req = await readJson<any>(path.join(d, "request.json"));
    if (!req) continue;
    const events = await readText(path.join(d, "events.jsonl"));
    out.push({
      id, req, events,
      log: events.trim() ? "" : await readText(path.join(d, "log.txt")),
      source: await readJson<any>(path.join(d, "source.json")),
      edl: await readJson<any>(path.join(d, "edl.json")),
      status: await readJson<any>(path.join(d, "status.json")),
      runner: await readJson<any>(path.join(d, "runner.json")),
      history: hist.filter((r) => r?.job === id),
    });
  }
  return out;
}

let cache: { at: number; root: string; h: History } | null = null;

export async function loadHistory(root: string, maxAgeMs = 60_000): Promise<History> {
  if (cache && cache.root === root && Date.now() - cache.at < maxAgeMs) return cache.h;
  const h = mergeHistories((await readJobFiles(root)).map((f) => parseJob(f)));
  cache = { at: Date.now(), root, h };
  return h;
}
