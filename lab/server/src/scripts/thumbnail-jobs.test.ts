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
    assert.match(job.variants[0].results[0].label, /Nano Banana Pro/);
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

  await check("headline font: upload (replaces), status, delete; rejects bad type", async () => {
    const fonts = await import("../thumbnails/fonts.js");
    assert.equal(fonts.fontStatus().uploaded, false, "none uploaded initially");
    const st = fonts.saveFont("Helvetica.ttf", onePx); // bytes don't need to be a real font for the store test
    assert.equal(st.uploaded, true);
    assert.equal(st.name, "Helvetica.ttf");
    assert.ok(fonts.uploadedFontPath(), "an uploaded font path is resolved");
    assert.throws(() => fonts.saveFont("notafont.png", onePx), /\.ttf|\.otf|\.woff/i, "bad extension rejected");
    fonts.deleteFont();
    assert.equal(fonts.fontStatus().uploaded, false, "removed on delete");
    assert.equal(fonts.uploadedFontPath(), null);
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

  await check("planRecreations returns an editable plan per pick (cast + bg + text)", async () => {
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    bgs.saveBackground("Neon City", onePx);
    const plans = await orchestrate.planRecreations(
      { picks: ["A", "B"], keyword: "OpenClaw", videoType: "Tutorial", titles: ["OpenClaw Tutorial"] },
      fakeDownload,
      async () => ({ expression: "surprise" as const, busy: true }),
      async () => "neon-city",
      async () => [{ old: "CLAWDBOT", new: "OpenClaw" }],
    );
    assert.equal(plans.length, 2);
    assert.equal(plans[0].expression, "surprise");
    assert.equal(plans[0].busy, true);
    assert.equal(plans[0].backgroundId, "neon-city");
    assert.deepEqual(plans[0].rewrites, [{ old: "CLAWDBOT", new: "OpenClaw" }]);
    assert.ok(plans[0].expressionLabel, "carries a human label for the cast");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
    bgs.deleteBackground("neon-city");
  });

  await check("a reviewed PLAN drives generation: uses its cast + text, SKIPS analysis", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    const instructions: string[] = [];
    let analyzeCalled = false;
    const deps = {
      ...makeDeps({ edits: 1 }),
      analyzeSource: async () => {
        analyzeCalled = true;
        return { expression: "smile" as const, busy: false };
      },
      editImage: async (opts: any) => {
        instructions.push(opts.instruction);
        return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
      },
      finalize: async (_c: any, steps: any) => ({ outputUrl: "/api/outputs/thumbnails/o.png", file: "/x", steps }),
    };
    const job = orchestrate.startThumbnailJob(
      {
        keyword: "OpenClaw",
        videoType: "Tutorial",
        picks: ["A"],
        mode: "gemini-pro",
        plans: [
          {
            videoId: "A",
            sourceThumbnailUrl: "",
            expression: "surprise",
            expressionLabel: "Surprise",
            busy: false,
            backgroundId: null,
            rewrites: [{ old: "CLAWDBOT", new: "OpenClaw" }],
            elements: [{ id: "logo", label: "Swap logo", apply: true, instruction: "change the [icon] logo to another type" }],
          },
        ],
      },
      fakeDownload,
      deps as any,
    );
    await waitUntil(() => job.done);
    assert.equal(analyzeCalled, false, "the plan replaces the per-source vision analysis");
    assert.equal(job.variants[0].expression, "surprise", "uses the plan's chosen character");
    // The approved rewrite is applied verbatim (template-filled) and REPLACES any
    // art-director text-rewrites.
    assert.ok(
      instructions.some((s) => /change the text "CLAWDBOT" to "OpenClaw"/.test(s)),
      "the approved text rewrite was applied",
    );
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  await check("restyleContrarianText re-renders the headline onto the saved base → new output", async () => {
    const recreate = await import("../thumbnails/recreate.js");
    const nb = await import("../thumbnails/nanoBanana.js");
    const dir = nb.thumbnailsDir();
    fs.mkdirSync(dir, { recursive: true });
    const baseName = "unit-base.base.jpg";
    fs.writeFileSync(path.join(dir, baseName), Buffer.from("pretend-jpeg-bytes"));
    const { outputUrl } = await recreate.restyleContrarianText({
      baseUrl: `/api/outputs/thumbnails/${baseName}`,
      templateId: "bottom-bar",
      text: "TOPVIEW BEATS HOLLYWOOD",
      emphasis: "BEATS",
      textScale: 1.3,
    });
    assert.match(outputUrl, /^\/api\/outputs\/thumbnails\/[a-f0-9]+\.jpg$/, "returns a fresh served URL");
    const outName = outputUrl.split("/").pop()!;
    assert.ok(fs.existsSync(path.join(dir, outName)), "wrote a new output file (canvas absent → base bytes)");
    // Path traversal in the base name is stripped (basename only).
    await assert.rejects(
      recreate.restyleContrarianText({ baseUrl: "/etc/passwd", templateId: "bottom-bar", text: "x", emphasis: "x", textScale: 1 }),
      /invalid base image|ENOENT/,
    );
  });

  await check("a 'None' character plan skips the swap (one pass, no person, edits applied)", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    const instructions: string[] = [];
    const deps = {
      ...makeDeps(),
      editImage: async (opts: any) => {
        instructions.push(opts.instruction);
        return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
      },
      finalize: async (_c: any, steps: any) => ({ outputUrl: "/api/outputs/thumbnails/o.png", file: "/x", steps }),
    };
    const job = orchestrate.startThumbnailJob(
      {
        keyword: "OpenClaw",
        videoType: "Tutorial",
        picks: ["A"],
        mode: "gemini-pro",
        plans: [
          {
            videoId: "A",
            sourceThumbnailUrl: "",
            expression: orchestrate.NO_CHARACTER,
            expressionLabel: "None",
            busy: false,
            backgroundId: null,
            rewrites: [{ old: "Use this", new: "The new way" }],
            elements: [{ id: "custom", label: "Right text", apply: true, instruction: "replace 'Instead' with 'of editing'" }],
          },
        ],
      },
      fakeDownload,
      deps as any,
    );
    await waitUntil(() => job.done);
    assert.equal(job.variants[0].status, "done");
    // ONE consolidated render, no person swap, both edits present.
    const oneShot = instructions.find((s) => /SINGLE edit/.test(s));
    assert.ok(oneShot, "ran a single consolidated pass");
    assert.doesNotMatch(oneShot!, /Replace the on-camera person/, "no character swap");
    assert.match(oneShot!, /change the text "Use this" to "The new way"/);
    assert.match(oneShot!, /replace 'Instead' with 'of editing'/);
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
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

  // ── contrarian originals (the parallel workflow) ─────────────────────────────
  await check("startContrarianJob makes 3 originals from background + character + statement", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    bgs.saveBackground("Studio", onePx);
    let aiCalled = false;
    let composites = 0;
    const recreateDeps = {
      // No image model is ever used for the contrarian workflow.
      editImage: async () => {
        aiCalled = true;
        return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
      },
      // The PROGRAMMATIC composite (canvas is absent in tests, so inject it).
      composite: async () => {
        composites++;
        return Buffer.from("composited-png");
      },
      finalize: async (_c: any, steps: any) => ({ outputUrl: "/api/outputs/thumbnails/c.png", file: "/x", steps }),
    };
    const writeVariations = async (_k: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        text: `STOP DOING THIS ${i}`,
        emphasis: "STOP",
        expressionId: "smile",
        placement: "right" as const,
      }));
    const job = orchestrate.startContrarianJob(
      { keyword: "video ads", mode: "gemini-pro" },
      recreateDeps as any,
      writeVariations,
    );
    await waitUntil(() => job.done);
    assert.equal(job.variants.length, 3, "always 3 originals");
    assert.ok(job.variants.every((v) => v.status === "done" && v.outputUrl), "each original lands");
    assert.equal(composites, 3, "one PROGRAMMATIC composite per original");
    assert.equal(aiCalled, false, "Nano Banana is never used for the contrarian workflow");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
    bgs.deleteBackground("studio");
  });

  await check("planContrarianVariations returns 3 editable proposals (one per template)", async () => {
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    const write = async (_k: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ text: `PROPOSAL ${i}`, emphasis: `${i}`, expressionId: "smile" }));
    const planned = await orchestrate.planContrarianVariations({ keyword: "k", titles: ["T1"] }, write as any);
    assert.equal(planned.length, 3);
    assert.deepEqual(planned.map((p) => p.templateId), ["bottom-bar", "left-stack", "top-strike"]);
    assert.equal(planned[0].text, "PROPOSAL 0");
    assert.ok(planned.every((p) => p.expressionId && p.expressionLabel), "each carries the cast expression + label");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
  });

  await check("startContrarianJob uses APPROVED/edited copy (skips the writer)", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    bgs.saveBackground("Studio", onePx);
    const overlays: any[] = [];
    let writerCalled = false;
    const deps = {
      composite: async () => Buffer.from("composited-png"),
      finalize: async (_c: any, steps: any) => ({ outputUrl: "/api/outputs/thumbnails/o.png", file: "/x", steps }),
    };
    const job = orchestrate.startContrarianJob(
      {
        keyword: "k",
        mode: "gemini-pro",
        variations: [
          { text: "MY EDIT ONE", emphasis: "ONE", expressionId: "smile" },
          { text: "MY EDIT TWO", emphasis: "TWO", expressionId: "smile" },
          { text: "MY EDIT THREE", emphasis: "THREE", expressionId: "smile" },
        ],
      },
      deps as any,
      async () => {
        writerCalled = true;
        return [];
      },
    );
    await waitUntil(() => job.done);
    assert.equal(writerCalled, false, "the writer is skipped when approved copy is supplied");
    assert.ok(job.variants.every((v) => v.status === "done"));
    void overlays;
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
    bgs.deleteBackground("studio");
  });

  await check("a centered contrarian template won't cast a left/right-directed character", async () => {
    jobs._resetJobsForTest();
    chars.saveCharacter("smile", onePx); // neutral built-in (no placement directive)
    chars.saveCustomCharacter("Pointing - place on the right", onePx); // directed → id pointing-place-on-the-right
    bgs.saveBackground("Studio", onePx);
    // The writer casts the DIRECTED character for every variation.
    const writeVariations = async (_k: string, n: number) =>
      Array.from({ length: n }, () => ({ text: "STOP NOW", emphasis: "STOP", expressionId: "pointing-place-on-the-right" }));
    const job = orchestrate.startContrarianJob(
      { keyword: "k", mode: "gemini-pro" },
      {
        composite: async () => Buffer.from("composited-png"),
        finalize: async (_c: any, steps: any) => ({ outputUrl: "/api/outputs/thumbnails/o.png", file: "/x", steps }),
      } as any,
      writeVariations,
    );
    await waitUntil(() => job.done);
    // Templates 0 (bottom) + 2 (top) are CENTERED → must recast to the neutral built-in.
    assert.equal(job.variants[0].expression, "smile", "center template recasts to a neutral character");
    assert.equal(job.variants[2].expression, "smile", "center template recasts to a neutral character");
    // Template 1 (left-stack, character on the right) may keep the directed cast.
    assert.equal(job.variants[1].expression, "pointing-place-on-the-right", "side template keeps the directed character");
    chars.deleteCharacter("smile");
    chars.deleteCharacter("pointing-place-on-the-right");
    bgs.deleteBackground("studio");
  });

  await check("contrarian job errors cleanly when no background is uploaded", async () => {
    jobs._resetJobsForTest();
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    for (const b of bgs.listBackgrounds()) bgs.deleteBackground(b.id);
    const job = orchestrate.startContrarianJob(
      { keyword: "k", mode: "gemini-pro" },
      { editImage: async () => ({ file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" }) } as any,
      async (_k, n) =>
        Array.from({ length: n }, () => ({ text: "STOP NOW", emphasis: "STOP", expressionId: "smile", placement: "right" as const })),
    );
    await waitUntil(() => job.done);
    assert.ok(job.variants.every((v) => v.status === "error"), "all variants error without a background");
    assert.match(job.variants[0].error ?? "", /background/i);
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
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

  // ── cancellation ──────────────────────────────────────────────────────────────
  await check("cancelJob marks a running job cancelled + terminates its variants", () => {
    jobs._resetJobsForTest();
    const job = jobs.createJob([
      { videoId: "A", sourceThumbnailUrl: "u", expression: "smile" },
      { videoId: "B", sourceThumbnailUrl: "u", expression: "smile" },
    ]);
    // Simulate one variant already mid-run.
    jobs.updateVariant(job, 0, { status: "running", percent: 40 });
    assert.ok(!job.done, "job is live before cancel");
    const ok = jobs.cancelJob(job.id);
    assert.ok(ok, "cancelJob returns true for a live job");
    assert.ok(jobs.jobCancelled(job), "jobCancelled() is true after cancel");
    const snap = jobs.snapshot(job);
    assert.equal(snap.cancelled, true, "snapshot reports cancelled");
    // Every unfinished sub-run flips to a terminal 'Cancelled' error.
    for (const v of job.variants) {
      for (const r of v.results) {
        assert.equal(r.status, "error");
        assert.equal(r.stepLabel, "Cancelled");
      }
    }
  });

  await check("cancelJob returns false for unknown/finished jobs", () => {
    jobs._resetJobsForTest();
    assert.equal(jobs.cancelJob("nope"), false, "unknown id → false");
    const done = jobs.createJob([]); // empty → done immediately
    assert.ok(done.done);
    assert.equal(jobs.cancelJob(done.id), false, "finished job → false");
  });

  await check("cancelAllJobs cancels every live job and returns the count", () => {
    jobs._resetJobsForTest();
    const a = jobs.createJob([{ videoId: "A", sourceThumbnailUrl: "u", expression: "smile" }]);
    const b = jobs.createJob([{ videoId: "B", sourceThumbnailUrl: "u", expression: "smile" }]);
    const n = jobs.cancelAllJobs();
    assert.equal(n, 2, "both live jobs cancelled");
    assert.ok(jobs.jobCancelled(a) && jobs.jobCancelled(b));
    // Idempotent: a second sweep finds nothing new to cancel.
    assert.equal(jobs.cancelAllJobs(), 0, "already-cancelled jobs aren't re-counted");
  });

  // cleanup
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

void main();
