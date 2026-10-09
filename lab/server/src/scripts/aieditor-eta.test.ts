/**
 * The Auto Editor's ETA model (aieditor/eta.ts) + its backtest (aieditor/etaBacktest.ts), on a
 * FAKE history (synthetic events.jsonl / log.txt — no real job is read):
 *   parseJob      claims split runs; a factory "creating" line makes the run a server run
 *                 (size → cpus key); start-up / transfer / wrap-up overhead; the box otherwise;
 *                 legacy log.txt stage lines; failed runs are not clean; the worker's own meta wins
 *   units         align per SOURCE minute, preview per OUTPUT minute, cut fixed, a local download
 *                 fixed, graphics with screencasts per BEAT
 *   machines      a 32-core prediction uses 32-core runs only (the box's 4-core rates are not
 *                 mixed in); a size with no runs is scaled by cores from other SERVERS and flagged
 *                 (firstRun); API stages ignore the machine
 *   ranges        3+ consistent runs → confident; one run → a range
 *   live          blendLive converges on the observed rate; a learned progress curve reads a
 *                 stage that says 75 % a quarter of the way in correctly
 *   backtest      leave-one-job-out on a box + factory history: the new model beats the old
 *                 per-source-minute median overall, within ±15 % once keys are warm
 * Run:
 *   cd lab/server && npx tsx src/scripts/aieditor-eta.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

type Ev = Record<string, unknown>;
/** a fake run: optional factory server, then stages with durations (s) and optional progress */
function run(t0: number, stages: [string, number, string?][], server?: { size: string; region?: string; up?: number }, opts: { fail?: string; marks?: Record<string, [number, number][]> } = {}) {
  const ev: Ev[] = [];
  let t = t0;
  if (server) {
    ev.push({ t, stage: "factory", kind: "log", msg: `factory server 1 (${server.size}) creating in ${server.region ?? "sgp1"}…` });
    t += server.up ?? 80;
    ev.push({ t, stage: "factory", kind: "log", msg: `factory server up at 10.0.0.1 after ${server.up ?? 80}s — sending the job` });
    t += 10;
  }
  ev.push({ t, stage: "job", kind: "log", msg: "claimed action=run (workflow: cut)" });
  for (const [name, secs, note] of stages) {
    ev.push({ t, stage: name, kind: "stage", state: "running", msg: `▶ ${name} started` });
    for (const [at, frac] of opts.marks?.[name] ?? []) ev.push({ t: t + at, stage: name, kind: "progress", msg: "…", frac });
    if (opts.fail === name) {
      ev.push({ t: t + secs, stage: name, kind: "stage", state: "failed", msg: `■ ${name} failed in ${secs}s — boom` });
      return { ev, end: t + secs };
    }
    t += secs;
    ev.push({ t, stage: name, kind: "stage", state: "done", msg: `✓ ${name} done in ${secs.toFixed(1)}s${note ? ` — ${note}` : ""}` });
  }
  ev.push({ t, stage: "job", kind: "stage", msg: "job finished — ready to review" });
  if (server) {
    t += 20;
    ev.push({ t, stage: "factory", kind: "log", msg: "results back after 999s total" });
    t += 10;
    ev.push({ t, stage: "factory", kind: "log", msg: "factory server 1 destroyed — 10 min ≈ $0.20" });
  }
  return { ev, end: t };
}
const jsonl = (ev: Ev[]) => ev.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** stage times that follow a known law: secs = rate × units / speed(machine) */
function law(srcMin: number, outMin: number, speed: number, jitter = 1): [string, number, string?][] {
  return [
    ["download", 17 * srcMin * jitter, "3840x2160"],
    ["audio", (2 * srcMin * jitter) / speed],
    ["transcribe", 0.2 * srcMin * jitter],
    ["align", (48 * srcMin * jitter) / speed],
    ["takes", 4 * srcMin * jitter],
    ["cut", 0.2],
    ["listen", (32 * outMin * jitter) / speed],
    ["preview", (160 * outMin * jitter) / speed],
  ];
}

async function main() {
  const eta = await import("../aieditor/eta.js");
  const bt = await import("../aieditor/etaBacktest.js");

  // a fake work dir: 4 box jobs, 4 c-32 jobs, 1 failed c-32 run, 1 legacy log.txt job
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-eta-"));
  const jobs = path.join(root, "jobs");
  const mk = (id: string, req: any, srcMin: number, outMin: number, events: string, log = "") => {
    const d = path.join(jobs, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "request.json"), JSON.stringify({ format: "long", source: { kind: "descript" }, ...req }));
    fs.writeFileSync(path.join(d, "source.json"), JSON.stringify({ duration: srcMin * 60 }));
    fs.writeFileSync(path.join(d, "edl.json"), JSON.stringify({ videos: [{ duration: outMin * 60 }] }));
    if (events) fs.writeFileSync(path.join(d, "events.jsonl"), events);
    if (log) fs.writeFileSync(path.join(d, "log.txt"), log);
  };
  const jit = [1, 1.04, 0.97, 1.02];
  [10, 15, 20, 30].forEach((m, k) => mk(`box-${k}`, {}, m, m * 0.9, jsonl(run(1e9 + k * 1e5, law(m, m * 0.9, 1, jit[k])).ev)));
  [12, 15, 25, 40].forEach((m, k) => mk(`fac-${k}`, { run_on: "factory" }, m, m * 0.9,
    jsonl(run(2e9 + k * 1e5, law(m, m * 0.9, 8, jit[k]), { size: "c-32", up: 75 + k },
      { marks: { preview: [[0.1 * (160 * m * 0.9 * jit[k]) / 8, 0.5], [0.3 * (160 * m * 0.9 * jit[k]) / 8, 0.75]] } }).ev)));
  mk("fac-failed", {}, 15, 14, jsonl(run(3e9, law(15, 14, 8), { size: "c-32" }, { fail: "align" }).ev));
  mk("legacy", {}, 20, 18, "", [
    "2026-10-05 07:00:00 claimed action=run",
    "2026-10-05 07:00:00 stage audio start",
    "2026-10-05 07:00:40 stage audio done 16 kHz + 48 kHz PCM",
    "2026-10-05 07:00:40 stage align start",
    "2026-10-05 07:16:40 stage align done 222 windows",
  ].join("\n"));
  const files = await eta.readJobFiles(root);
  const h = eta.mergeHistories(files.map((f) => eta.parseJob(f, 4)));

  await check("parseJob: runs, machines, overhead, failures, legacy log", () => {
    const fac = h.samples.filter((s) => s.job === "fac-0");
    assert.ok(fac.length === 8 && fac.every((s) => s.machine.key === "cpu32" && s.machine.label === "c-32"));
    assert.ok(h.samples.filter((s) => s.job === "box-0").every((s) => s.machine.key === "box" && s.machine.cpus === 4));
    assert.deepEqual(h.overhead.filter((o) => o.job === "fac-0").map((o) => [o.part, o.secs]), [["startup", 75], ["transfer", 10], ["wrapup", 30]]);
    const failed = h.segments.find((s) => s.job === "fac-failed")!;
    assert.equal(failed.clean, false);
    const leg = h.samples.filter((s) => s.job === "legacy");
    assert.deepEqual(leg.map((s) => [s.stage, s.secs]), [["audio", 40], ["align", 960]]);
    assert.ok(leg.every((s) => s.machine.key === "box"));
    const pv = h.samples.find((s) => s.job === "fac-1" && s.stage === "preview")!;
    assert.equal(pv.marks?.length, 2);
  });

  await check("parseJob: the worker's per-stage meta wins (machine, units)", () => {
    const one = eta.parseJob({
      id: "m", req: { format: "long" }, source: { duration: 600 }, edl: null, runner: null, log: "",
      events: jsonl(run(5e9, [["align", 100]]).ev),
      status: { stages: { align: { finished_at: 5e9 + 100, meta: { machine: "s-8vcpu-32gb-amd", cpus: 8, region: "blr1", src_min: 12 } } } },
    }, 4);
    assert.equal(one.samples[0].machine.key, "cpu8");
    assert.equal(one.samples[0].machine.region, "blr1");
    assert.equal(one.samples[0].srcMin, 12);
  });

  await check("units: source / output minutes, fixed, beats", () => {
    const c = { srcKind: "descript" as const, rec: false };
    assert.equal(eta.unitOf("align", c), "src");
    assert.equal(eta.unitOf("takes", c), "src");
    assert.equal(eta.unitOf("preview", c), "out");
    assert.equal(eta.unitOf("cut", c), "fixed");
    assert.equal(eta.unitOf("download", { ...c, srcKind: "local" }), "fixed");
    assert.equal(eta.unitOf("graphics", { ...c, rec: true }), "beat");
    assert.equal(eta.cpusOfSlug("c2-32vcpu-64gb"), 32);
    assert.equal(eta.cpusOfSlug("s-8vcpu-32gb-amd"), 8);
    assert.equal(eta.cpusOfSlug("c-16"), 16);
    assert.deepEqual(eta.beatsOf("13/13 screencast(s) (13 in the logged-in app), 11 overlay(s), $9.84"), { beats: 13, overlays: 11 });
  });

  const ctx = (machine: any, srcMin: number, outMin: number | null = null) =>
    ({ machine, kind: "cut" as const, format: "long", srcKind: "descript" as const, srcMin, outMin, beats: null, rec: false });
  const c32 = eta.factoryMachine("c-32", "sgp1");

  await check("machines: a 32-core preview learns from 32-core runs only, confident with 4 runs", () => {
    const p = eta.predictStage(h, "preview", ctx(c32, 20, 18))!;
    // law: 160 s per output minute / 8 → 20 s/min × 18 min = 360 s
    assert.ok(Math.abs(p.sec - 360) / 360 < 0.05, `got ${p.sec}`);
    assert.equal(p.scaled, false);
    assert.equal(p.n, 4);
    assert.equal(p.confident, true);
    // the OLD estimate mixes the box in (the "~36m 58s for a 5-min preview" defect)
    const old = bt.oldPredict(h, { stage: "preview", format: "long", srcMin: 20 }, "none")!;
    assert.ok(old > 2 * p.sec, `old ${old} vs new ${p.sec}`);
  });

  await check("machines: an unseen size is scaled by cores from servers, and flagged", () => {
    const s8 = eta.factoryMachine("s-8vcpu-32gb-amd", "sgp1");
    const p = eta.predictStage(h, "align", ctx(s8, 15))!;
    assert.equal(p.scaled, true);
    assert.equal(p.confident, false);
    // from c-32's 6 s/min, (32/8)^0.8 ≈ 3.03 → ≈ 273 s; never from the 4-core box's 48 s/min
    assert.ok(p.sec > 200 && p.sec < 350, `got ${p.sec}`);
    assert.ok(p.hi > p.sec * 1.3, "a wide range");
    const job = eta.estimateJob(h, ["download", "audio", "align"], ctx(s8, 15));
    assert.equal(job.firstRun, true);
    assert.equal(eta.estimateJob(h, ["audio"], ctx(c32, 15)).firstRun, false);
  });

  await check("machines: API / network stages ignore the machine", () => {
    const onBox = eta.predictStage(h, "takes", ctx(eta.boxMachine(4), 20))!;
    const onSrv = eta.predictStage(h, "takes", ctx(c32, 20))!;
    assert.equal(onBox.sec, onSrv.sec);
    assert.equal(onSrv.scaled, false);
    assert.ok(Math.abs(onSrv.sec - 80) / 80 < 0.06, `takes ${onSrv.sec}`);
  });

  await check("units: before the cut, output minutes come from the cut ratio (less sure)", () => {
    const p = eta.predictStage(h, "preview", ctx(c32, 20, null))!;
    assert.ok(Math.abs(p.sec - 360) / 360 < 0.06, `got ${p.sec}`);
    assert.equal(p.confident, false);
    assert.equal(eta.predictStage(h, "align", ctx(c32, null as any)), null, "no source length → no estimate");
  });

  await check("overhead: start-up, transfer, wrap-up for a server; none on the box", () => {
    const ov = eta.predictOverhead(h, c32)!;
    assert.ok(ov.startup.sec >= 75 && ov.startup.sec <= 78);
    assert.equal(ov.transfer.sec, 10);
    assert.equal(ov.wrapup.sec, 30);
    assert.equal(eta.predictOverhead(h, eta.boxMachine(4)), null);
  });

  await check("live: converges on the observed rate; a learned curve reads a non-linear stage", () => {
    const prior = { sec: 100, lo: 80, hi: 120, n: 3, confident: true, scaled: false, unit: "out" as const };
    // the stage is really twice as slow: at 50 % after 100 s, the total should move toward 200 s
    const half = eta.blendLive(prior, 100, 0.5)!;
    assert.ok(100 + half.sec > 140 && 100 + half.sec < 200, `total ${100 + half.sec}`);
    const late = eta.blendLive(prior, 180, 0.9)!;
    assert.ok(Math.abs(180 + late.sec - 200) < 15, `total ${180 + late.sec}`);
    // no fraction: the prior less the elapsed time, and an overrun keeps a small tail
    assert.equal(eta.blendLive(prior, 30, null)!.sec, 70);
    assert.ok(eta.blendLive(prior, 150, null)!.sec > 0);
    // a stage that reports 75 % at 30 % of its time: the curve from history says so
    const curve = eta.progressCurve(h, "preview")!;
    assert.ok(Math.abs(eta.timeShare(curve, 0.75) - 0.3) < 0.02, `share ${eta.timeShare(curve, 0.75)}`);
    const withCurve = eta.blendLive({ ...prior, curve }, 30, 0.75, 30)!;
    assert.ok(Math.abs(30 + withCurve.sec - 100) < 10, `with the curve: total ${30 + withCurve.sec}`);
    const linear = eta.blendLive(prior, 30, 0.75, 30)!;
    assert.ok(30 + linear.sec < 60, "read as linear time it would have said ~40 s");
  });

  await check("sumPreds: totals and a range that narrows as estimates firm up", () => {
    const a = { sec: 100, lo: 90, hi: 110, n: 3, confident: true, scaled: false, unit: "src" as const };
    const t = eta.sumPreds([a, a, a])!;
    assert.equal(t.sec, 300);
    assert.ok(t.hi > 300 && t.hi <= 330 && t.lo >= 270);
    assert.equal(t.confident, true);
    assert.equal(eta.sumPreds([]), null);
  });

  await check("backtest: leave-one-job-out, new beats old, within ±15 % when warm", () => {
    const r = bt.backtest(h);
    assert.ok(r.overall.after.n >= 8, `runs ${r.overall.after.n}`);
    assert.ok(r.overall.after.medianPct! < 10, `new ${r.overall.after.medianPct}`);
    assert.ok(r.overall.before.medianPct! > 50, `old ${r.overall.before.medianPct}`);
    assert.ok(r.overall.afterWarm.n >= 4 && r.overall.afterWarm.within15 === r.overall.afterWarm.n, JSON.stringify(r.overall.afterWarm));
    assert.ok(r.stages.preview.after.medianPct! < r.stages.preview.before.medianPct!);
    assert.ok(bt.formatBacktest(r).includes("overall"));
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? " — FAILURES above" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
