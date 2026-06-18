/**
 * Unit checks for the Thumbnail Designer's ASYNC generation flow (LIVE PROGRESS).
 * NO network, NO ffmpeg, NO AI, NO real keys — every external boundary (source
 * download, the Nano Banana edit, the art-director, the crop/upscale finalize)
 * is injected as a pure fake.
 *
 *   - progress model: phase weights sum to 100, phasePercent is monotonic across
 *     phases and reaches 100 at finalize; per-variant percent never decreases.
 *   - job lifecycle: start seeds queued variants; a run transitions
 *     queued→running→done; overall % is the monotonic mean and hits 100 on done.
 *   - per-variant isolation: one variant erroring doesn't fail the job and the
 *     others still finish; each variant's outputUrl appears the moment it lands.
 *   - GC/TTL + cap: finished jobs are reaped after the TTL; the map is bounded.
 *
 * Run: cd lab/server && npx tsx src/scripts/thumbnail-jobs.test.ts
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until a predicate holds or a deadline passes (no real work blocks). */
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for condition");
    await sleep(5);
  }
}

async function main() {
  // Isolate the data dir BEFORE importing modules that read config.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-thumbjob-test-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-thumbjob-cfg-"));
  process.env.DATA_DIR = root;
  process.env.POSTIZ_CONFIG_DIR = configDir;
  process.env.DOCKER_SOCKET = path.join(configDir, "nonexistent.sock");
  delete process.env.GEMINI_API_KEY;
  delete process.env.YOUTUBE_DATA_API_KEY;
  // Keep the expression-director (a vision call) fully offline: with no vision
  // creds the best-effort default falls straight back to the video-type pick.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.GROQ_API_KEY;

  const jobs = await import("../thumbnails/jobs.js");
  const orchestrate = await import("../thumbnails/orchestrate.js");
  const chars = await import("../thumbnails/characters.js");
  const bgs = await import("../thumbnails/backgrounds.js");

  // A 1x1 PNG so readCharacterImage returns real bytes for every expression.
  const onePx =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  // ── progress model (pure) ───────────────────────────────────────────────────
  await check("PHASE_WEIGHTS sum to 100 and PHASE_START is cumulative", () => {
    const w = jobs.PHASE_WEIGHTS;
    const sum = w.fetch + w.outfit + w.edits + w.swap + w.finalize;
    assert.equal(sum, 100);
    assert.equal(jobs.PHASE_START.fetch, 0);
    assert.equal(jobs.PHASE_START.outfit, w.fetch);
    assert.equal(jobs.PHASE_START.swap, w.fetch + w.outfit + w.edits, "swap is the heavy band before finalize");
    assert.equal(jobs.PHASE_START.finalize, 100 - w.finalize, "finalize starts at 85");
  });

  await check("phasePercent is monotonic across phases and reaches 100 at finalize=1", () => {
    const seq = [
      jobs.phasePercent("fetch", 0),
      jobs.phasePercent("fetch", 1),
      jobs.phasePercent("outfit", 0),
      jobs.phasePercent("outfit", 1),
      jobs.phasePercent("edits", 0),
      jobs.phasePercent("edits", 0.5),
      jobs.phasePercent("edits", 1),
      jobs.phasePercent("swap", 0),
      jobs.phasePercent("swap", 1),
      jobs.phasePercent("finalize", 0),
      jobs.phasePercent("finalize", 1),
    ];
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] >= seq[i - 1], `phase percent decreased at step ${i}: ${seq[i - 1]} → ${seq[i]}`);
    }
    assert.equal(seq[seq.length - 1], 100, "finalize=1 reaches 100");
    // edits band is genuinely spread (0..4 optional edits all land inside the band).
    assert.ok(jobs.phasePercent("edits", 0.25) > jobs.phasePercent("edits", 0));
    assert.ok(jobs.phasePercent("edits", 1) <= jobs.PHASE_START.finalize);
  });

  await check("updateVariant clamps + never decreases a variant's percent (monotonic)", () => {
    jobs._resetJobsForTest();
    const job = jobs.createJob([{ videoId: "A", sourceThumbnailUrl: "u", expression: "smile" }]);
    jobs.updateVariant(job, 0, { percent: 40 });
    assert.equal(job.variants[0].percent, 40);
    jobs.updateVariant(job, 0, { percent: 10 }); // backwards → ignored
    assert.equal(job.variants[0].percent, 40, "must not go backwards");
    jobs.updateVariant(job, 0, { percent: 250 }); // clamped to 100
    assert.equal(job.variants[0].percent, 100);
  });

  await check("overall percent is the monotonic mean of the per-variant percents", () => {
    jobs._resetJobsForTest();
    const job = jobs.createJob([
      { videoId: "A", sourceThumbnailUrl: "u", expression: "smile" },
      { videoId: "B", sourceThumbnailUrl: "u", expression: "calm" },
    ]);
    jobs.updateVariant(job, 0, { percent: 50 });
    assert.equal(job.percent, 25, "mean of 50 + 0");
    jobs.updateVariant(job, 1, { percent: 100 });
    assert.equal(job.percent, 75, "mean of 50 + 100");
    // A variant can't drag the overall bar backwards.
    const before = job.percent;
    jobs.updateVariant(job, 0, { percent: 10 });
    assert.ok(job.percent >= before, "overall never decreases");
  });

  // ── job lifecycle + per-variant isolation (injected fakes, no I/O) ───────────
  // Fakes: source download succeeds (or throws for a chosen pick), the edit is a
  // no-op that returns bytes, the art-director returns N optional edits, and the
  // finalize returns a deterministic outputUrl WITHOUT touching ffmpeg/disk.
  const fakeDownload = async (url: string) => {
    if (url.includes("BOOM")) throw new Error("download stubbed-fail");
    return { bytes: Buffer.from("src"), mime: "image/jpeg" };
  };
  const makeDeps = (opts: { edits?: number } = {}) => ({
    editImage: async () => ({ file: "/x", outputUrl: "/x", bytes: Buffer.from("edited"), mimeType: "image/png" }),
    artDirect: async () =>
      Array.from({ length: opts.edits ?? 0 }, (_, i) => ({
        id: "font" as const,
        label: `edit ${i}`,
        apply: true,
        instruction: `do ${i}`,
      })),
    finalize: async (_cur: any, _steps: any) => ({ outputUrl: "/api/outputs/thumbnails/out.png", file: "/x", steps: _steps }),
  });

  await check("startThumbnailJob seeds queued variants and returns a jobId immediately", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    const t0 = Date.now();
    const job = orchestrate.startThumbnailJob(
      { keyword: "k", videoType: "Tutorial", picks: ["A", "B"], mode: "gemini-pro" }, // single-provider
      fakeDownload,
      makeDeps(),
    );
    const elapsed = Date.now() - t0;
    assert.ok(job.id, "returns a job with an id");
    assert.equal(job.variants.length, 2);
    assert.ok(job.variants.every((v) => v.results.length === 1), "single mode → exactly one sub-run per variant");
    assert.ok(elapsed < 100, `start should return fast (was ${elapsed}ms)`);
    // The seeded variants START queued — the work runs in the background.
    assert.ok(job.variants.every((v) => v.status === "queued" || v.status === "running"));
    // It must complete on its own (background runner) and hit 100% + done.
    await waitUntil(() => job.done);
    assert.equal(job.percent, 100, "overall reaches 100 on done");
    assert.ok(job.variants.every((v) => v.status === "done"));
    assert.ok(job.variants.every((v) => v.outputUrl), "every successful variant carries an outputUrl");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  await check("a variant error doesn't fail the job; others still finish; job completes", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    const job = orchestrate.startThumbnailJob(
      { keyword: "k", videoType: "Viral", picks: ["A", "BOOM", "C"], mode: "gemini-pro" }, // middle pick's download throws
      fakeDownload,
      makeDeps({ edits: 2 }),
    );
    await waitUntil(() => job.done);
    assert.equal(job.error, undefined, "job-level error stays clear");
    assert.equal(job.percent, 100, "job still reaches 100 with one variant errored");
    assert.equal(job.variants[0].status, "done");
    assert.equal(job.variants[1].status, "error");
    assert.match(job.variants[1].error ?? "", /stubbed-fail/);
    assert.equal(job.variants[2].status, "done", "later variant still finishes after an earlier failure");
    assert.ok(job.variants[0].outputUrl && job.variants[2].outputUrl);
    assert.equal(job.variants[1].outputUrl, undefined, "errored variant has no output");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  await check("each variant's outputUrl appears the MOMENT it finishes (not all at the end)", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    // Gate the SECOND variant's finalize so we can observe the first land alone.
    let releaseSecond: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseSecond = r));
    let finalizeCalls = 0;
    const deps = {
      ...makeDeps(),
      finalize: async (_c: any, steps: any) => {
        finalizeCalls++;
        if (finalizeCalls === 2) await gate; // hold the 2nd variant open
        return { outputUrl: `/api/outputs/thumbnails/v${finalizeCalls}.png`, file: "/x", steps };
      },
    };
    const job = orchestrate.startThumbnailJob(
      { keyword: "k", videoType: "Tutorial", picks: ["A", "B"], mode: "gemini-pro" }, // single sub-run per pick
      fakeDownload,
      deps,
    );
    // First variant should be DONE (with its URL) while the second is still running.
    await waitUntil(() => job.variants[0].status === "done");
    assert.ok(job.variants[0].outputUrl, "first variant's URL is present before the run finishes");
    assert.notEqual(job.variants[1].status, "done", "second variant is still in flight");
    assert.ok(!job.done, "job is not done yet");
    releaseSecond();
    await waitUntil(() => job.done);
    assert.ok(job.variants[1].outputUrl);
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  // ── default (single Nano Banana Pro @ 4K): ONE sub-run per pick ──────────────
  await check("the DEFAULT mode seeds a single Nano Banana Pro · 4K result and runs the chain ONCE per pick", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    // Count how many times the chain's finalize runs — single ⇒ 1 per pick.
    let chainRuns = 0;
    const deps = {
      ...makeDeps(),
      finalize: async (_c: any, steps: any) => {
        chainRuns++;
        return { outputUrl: `/api/outputs/thumbnails/run${chainRuns}.png`, file: "/x", steps };
      },
    };
    // No mode passed → the DEFAULT (single gemini-pro @ 4K).
    const job = orchestrate.startThumbnailJob(
      { keyword: "k", videoType: "Tutorial", picks: ["A"] },
      fakeDownload,
      deps,
    );
    // Seeded with exactly ONE provider result — Nano Banana Pro at 4K.
    assert.equal(job.variants[0].results.length, 1, "default seeds a single provider result");
    assert.equal(job.variants[0].results[0].provider, "gemini-pro");
    assert.match(job.variants[0].results[0].label, /Nano Banana Pro · 4K/);
    await waitUntil(() => job.done);
    assert.equal(chainRuns, 1, "the full chain ran once (single sub-run for 1 pick)");
    const rs = job.variants[0].results;
    assert.ok(rs[0].status === "done" && rs[0].outputUrl, "the single provider produced a result");
    assert.equal(job.variants[0].outputUrl, rs[0].outputUrl, "the variant summary surfaces that result");
    assert.equal(job.percent, 100, "the job completes");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  await check("single-run: the provider failing marks the variant errored but the job still completes", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    const deps = {
      ...makeDeps(),
      finalize: async () => {
        throw new Error("provider blew up");
      },
    };
    const job = orchestrate.startThumbnailJob(
      { keyword: "k", videoType: "Tutorial", picks: ["A"] }, // default single mode
      fakeDownload,
      deps,
    );
    await waitUntil(() => job.done);
    const rs = job.variants[0].results;
    assert.equal(rs.length, 1, "a single provider result");
    assert.equal(rs[0].status, "error", "the failed provider's result is an error");
    assert.match(rs[0].error ?? "", /provider blew up/);
    assert.equal(rs[0].outputUrl, undefined, "the failed result has no image");
    assert.equal(job.variants[0].status, "error", "the variant reads as error when its sub-run failed");
    assert.match(job.variants[0].error ?? "", /provider blew up/);
    assert.equal(job.percent, 100, "an errored job still completes at 100");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  await check("the per-source analysis drives each variant's expression", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    // A fake source analysis (injected via deps) overrides the video-type default.
    const analyzeSource = async () => ({ expression: "secret" as const, busy: false });
    const job = orchestrate.startThumbnailJob(
      { keyword: "k", videoType: "Tutorial", picks: ["A", "B"], mode: "gemini-pro" },
      fakeDownload,
      { ...makeDeps(), analyzeSource } as any,
    );
    await waitUntil(() => job.done);
    // Tutorial's video-type default is "smile"; the analysis overrode it to "secret".
    assert.ok(job.variants.every((v) => v.expression === "secret"), "analysis choice overrides the video-type default");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  // ── custom expressions + backgrounds storage ────────────────────────────────
  await check("custom expressions coexist with the four built-in slots", () => {
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
    const custom = chars.saveCustomCharacter("Pointing Up!", onePx);
    assert.equal(custom.id, "pointing-up", "name is slugified to an id");
    assert.equal(custom.label, "Pointing Up!", "label preserved");
    assert.equal(custom.builtin, false);
    const list = chars.listCharacters();
    // Four built-in slots always present + the custom one.
    assert.equal(list.filter((c) => c.builtin).length, 4, "four built-in slots remain");
    assert.ok(list.some((c) => c.id === "pointing-up" && c.uploaded), "custom appears uploaded");
    assert.ok(chars.uploadedExpressions().includes("pointing-up"));
    chars.deleteCharacter("pointing-up");
    assert.ok(!chars.uploadedExpressions().includes("pointing-up"), "custom fully removed on delete");
  });

  await check("saveCustomCharacter rejects a name that collides with a built-in", () => {
    assert.throws(() => chars.saveCustomCharacter("smile", onePx), /built-in/i);
  });

  await check("backgrounds: save by name, list, delete", () => {
    for (const b of bgs.listBackgrounds()) bgs.deleteBackground(b.id);
    const bg = bgs.saveBackground("Red Grid", onePx);
    assert.equal(bg.id, "red-grid");
    assert.equal(bg.label, "Red Grid");
    assert.deepEqual(bgs.uploadedBackgrounds(), ["red-grid"]);
    bgs.deleteBackground("red-grid");
    assert.deepEqual(bgs.uploadedBackgrounds(), [], "removed on delete");
  });

  await check("a chosen background is SWAPPED into the recreation", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    bgs.saveBackground("Neon City", onePx);
    const instructions: string[] = [];
    const imageCounts: number[] = [];
    const deps = {
      ...makeDeps(),
      // The background-director picks our uploaded background.
      chooseBackground: async () => "neon-city",
      analyzeSource: async () => ({ expression: "smile" as const, busy: false }),
      editImage: async (opts: any) => {
        instructions.push(opts.instruction);
        imageCounts.push(opts.images.length);
        return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
      },
      finalize: async (_c: any, steps: any) => ({ outputUrl: "/api/outputs/thumbnails/o.png", file: "/x", steps }),
    };
    const job = orchestrate.startThumbnailJob(
      { keyword: "k", videoType: "Tutorial", picks: ["A"], mode: "gemini-pro" },
      fakeDownload,
      deps as any,
    );
    await waitUntil(() => job.done);
    assert.equal(job.variants[0].status, "done");
    // There is a "Replace the entire BACKGROUND" edit fed TWO images (current + bg).
    const idx = instructions.findIndex((s) => /Replace the entire BACKGROUND/i.test(s));
    assert.ok(idx >= 0, "background-replace step ran");
    assert.equal(imageCounts[idx], 2, "background-replace is fed [current, chosen background]");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
    bgs.deleteBackground("neon-city");
  });

  await check("a BUSY source is recreated in ONE pass (no multi-step chain)", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    const instructions: string[] = [];
    const analyzeSource = async () => ({ expression: "surprise" as const, busy: true });
    const deps = {
      ...makeDeps({ edits: 3 }), // even with optional edits proposed, busy path ignores them
      editImage: async (opts: any) => {
        instructions.push(opts.instruction);
        return { file: "/x", outputUrl: "/x", bytes: Buffer.from("edited"), mimeType: "image/png" };
      },
      analyzeSource,
      finalize: async (_c: any, steps: any) => ({ outputUrl: "/api/outputs/thumbnails/o.png", file: "/x", steps }),
    };
    const job = orchestrate.startThumbnailJob(
      { keyword: "OpenClaw", videoType: "Viral", picks: ["A"], mode: "gemini-pro" },
      fakeDownload,
      deps as any,
    );
    await waitUntil(() => job.done);
    assert.equal(job.variants[0].status, "done");
    // Busy → exactly ONE image edit (the consolidated one-shot), not 1+3+1+1.
    assert.equal(instructions.length, 1, "busy thumbnails render in a single pass");
    assert.match(instructions[0], /SINGLE edit/i, "the one edit is the consolidated recreation");
    assert.match(instructions[0], /SECOND image/i, "it swaps in the character");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  await check("missing character expression → that variant errors with a clear message", async () => {
    jobs._resetJobsForTest();
    // No characters uploaded at all → expressionsForVariants returns [] → error.
    const job = orchestrate.startThumbnailJob(
      { keyword: "k", videoType: "Review", picks: ["A"] },
      fakeDownload,
      makeDeps(),
    );
    await waitUntil(() => job.done);
    assert.equal(job.variants[0].status, "error");
    assert.match(job.variants[0].error ?? "", /expression/i);
    assert.equal(job.percent, 100, "an all-errored job still completes at 100");
  });

  // ── snapshot isolation ───────────────────────────────────────────────────────
  await check("snapshot returns an isolated copy (later ticks don't mutate it)", () => {
    jobs._resetJobsForTest();
    const job = jobs.createJob([{ videoId: "A", sourceThumbnailUrl: "u", expression: "smile" }]);
    jobs.updateVariant(job, 0, { percent: 20 });
    const snap = jobs.snapshot(job);
    jobs.updateVariant(job, 0, { percent: 90 });
    assert.equal(snap.variants[0].percent, 20, "snapshot is frozen at capture time");
    assert.equal(snap.error, null);
  });

  // ── GC / TTL + cap ────────────────────────────────────────────────────────────
  await check("finished jobs are reaped after the TTL; live jobs are kept", async () => {
    jobs._resetJobsForTest();
    const done = jobs.createJob([]); // empty → done:true immediately
    assert.ok(done.done);
    // Force it past the TTL by back-dating updatedAt.
    done.updatedAt = Date.now() - 11 * 60_000;
    // Creating a NEW job triggers reap(); the stale finished job should vanish.
    jobs.createJob([{ videoId: "Z", sourceThumbnailUrl: "u", expression: "smile" }]);
    assert.equal(jobs.getJob(done.id), undefined, "stale finished job was reaped");
  });

  await check("the registry is hard-capped so it never grows unbounded", () => {
    jobs._resetJobsForTest();
    // Create well past the cap (50). Each createJob runs reap() which enforces it.
    const ids: string[] = [];
    for (let i = 0; i < 80; i++) {
      ids.push(jobs.createJob([{ videoId: `V${i}`, sourceThumbnailUrl: "u", expression: "smile" }]).id);
    }
    let alive = 0;
    for (const id of ids) if (jobs.getJob(id)) alive++;
    assert.ok(alive <= 50, `registry exceeded the cap: ${alive} alive`);
    // The most-recently created job must survive.
    assert.ok(jobs.getJob(ids[ids.length - 1]), "newest job should still be present");
  });

  // cleanup
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

void main();
