/**
 * Unit checks for the Bulk Scheduler's Growth Guardrails:
 *   - scoreCaption: each check passes/fails as designed (PURE, no AI)
 *   - preflightVideo: vertical / duration / resolution from an INJECTED probe,
 *     `unknown` for cloud links, and graceful degradation when ffprobe fails
 *   - schedule() server-side gate: a required-fail blocks; override allows it;
 *     a recommended-only failure never blocks.
 *
 * No network, no ffmpeg: the probe is injected and the Postiz/PostPeer providers
 * are never reached because every gated item is blocked before any upload (and
 * the un-gated path is exercised with override using a stub probe that returns a
 * perfectly-valid video — which still short-circuits at the provider with a
 * clear, network-free error we assert on).
 *
 * Run: cd lab/server && npx tsx src/scripts/bulk-growth.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { scoreCaption } from "../postiz/captions.js";
import { preflightVideo, type ProbeFn } from "../postiz/preflight.js";
import { schedule, combineGrowth, hasBlockingFailure, type GrowthCheckDto } from "../postiz/bulkScheduler.js";
import { config, ensureDirs } from "../config.js";

// A real (empty) file under outputsDir so resolveLocalPath() resolves a `render`
// source and the INJECTED probe is actually reached (lets us test the MEASURED
// vertical/duration/resolution logic without ffmpeg). Cleaned up at the end.
ensureDirs();
const FIXTURE_NAME = `growth-test-${process.pid}.mp4`;
const FIXTURE_PATH = path.join(config.outputsDir, FIXTURE_NAME);
fs.writeFileSync(FIXTURE_PATH, "x");
const FIXTURE_SRC = { kind: "render" as const, ref: FIXTURE_NAME };
function cleanup() { try { fs.rmSync(FIXTURE_PATH, { force: true }); } catch { /* */ } }

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((e) => {
      console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
      process.exitCode = 1;
    });
}

const checkById = <T extends { id: string }>(checks: T[], id: string): T | undefined =>
  checks.find((c) => c.id === id);

// A probe stub factory — returns whatever dimensions/duration we want.
const probeStub = (r: Partial<{ duration: number; width: number; height: number }>): ProbeFn =>
  async () => ({ duration: r.duration ?? null, width: r.width ?? null, height: r.height ?? null, hasAudio: false });

async function main() {
  // ── scoreCaption ────────────────────────────────────────────────────────────
  await check("scoreCaption: a strong caption passes every required check", () => {
    const caption = "Budget meal prep that saved me $400 this month — here's the exact plan.\nWhich meal should I post next?";
    const { score, checks } = scoreCaption(caption, ["mealprep", "fyp", "budgetmealprepideas"], "tiktok");
    assert.equal(checkById(checks, "keyword-front")!.pass, true);
    assert.equal(checkById(checks, "comment-cta")!.pass, true);
    assert.equal(checkById(checks, "hashtag-count")!.pass, true);
    assert.equal(checkById(checks, "length-cap")!.pass, true);
    assert.ok(score >= 90, `expected high score, got ${score}`);
  });

  await check("scoreCaption: missing CTA fails the required comment-cta check", () => {
    const { checks } = scoreCaption("Budget meal prep tips for a busy week ahead.", ["mealprep", "fyp", "budgetmealprepideas"], "tiktok");
    assert.equal(checkById(checks, "comment-cta")!.pass, false);
  });

  await check("scoreCaption: a question ending satisfies comment-cta", () => {
    const { checks } = scoreCaption("Budget meal prep tips — which one do you want first?", ["mealprep", "fyp", "budgetmealprepideas"], "tiktok");
    assert.equal(checkById(checks, "comment-cta")!.pass, true);
  });

  await check("scoreCaption: too few hashtags fails hashtag-count (required)", () => {
    const { checks } = scoreCaption("Great keyword hook — comment below?", ["one"], "tiktok");
    assert.equal(checkById(checks, "hashtag-count")!.pass, false);
  });

  await check("scoreCaption: too many hashtags fails hashtag-count (required)", () => {
    const many = Array.from({ length: 12 }, (_, i) => `tag${i}`);
    const { checks } = scoreCaption("Great keyword hook — comment below?", many, "tiktok");
    assert.equal(checkById(checks, "hashtag-count")!.pass, false);
  });

  await check("scoreCaption: a weak opener fails the (recommended) hook-strength check", () => {
    const { checks } = scoreCaption("Hey guys, today I want to show you something cool. Thoughts?", ["mealprep", "fyp", "budgetmealprepideas"], "tiktok");
    const hook = checkById(checks, "hook-strength")!;
    assert.equal(hook.pass, false);
    assert.equal((hook as GrowthCheckDto).severity, "recommended");
  });

  await check("scoreCaption: an emoji-only opener fails keyword-front (required)", () => {
    const { checks } = scoreCaption("🔥🔥🔥\nMore text here that comes later? comment", ["mealprep", "fyp", "budgetmealprepideas"], "tiktok");
    assert.equal(checkById(checks, "keyword-front")!.pass, false);
  });

  await check("scoreCaption: over-cap caption fails length-cap (required)", () => {
    const long = "Keyword opener here. " + "x".repeat(400) + " comment?";
    const { checks } = scoreCaption(long, ["mealprep", "fyp", "budgetmealprepideas"], "tiktok");
    assert.equal(checkById(checks, "length-cap")!.pass, false); // tiktok cap = 300
  });

  await check("scoreCaption: niche+broad mix is recommended only", () => {
    const { checks } = scoreCaption("Keyword hook — comment?", ["aa", "bb", "cc"], "tiktok");
    const mix = checkById(checks, "hashtag-mix")!;
    assert.equal(mix.pass, false); // all short → no niche tag
    assert.equal((mix as GrowthCheckDto).severity, "recommended");
  });

  // ── preflightVideo (MEASURED via the fixture file + injected probe) ───────────
  await check("preflight: vertical 9:16 1080x1920 passes vertical + resolution + duration", async () => {
    const pf = await preflightVideo(FIXTURE_SRC, { probeFn: probeStub({ width: 1080, height: 1920, duration: 30 }) });
    assert.equal(checkById(pf.checks, "vertical")!.pass, true);
    assert.equal(checkById(pf.checks, "resolution")!.pass, true);
    assert.equal(checkById(pf.checks, "duration")!.pass, true);
    assert.equal(pf.score, 100);
  });

  await check("preflight: a horizontal 1920x1080 video FAILS the (recommended) vertical check", async () => {
    const pf = await preflightVideo(FIXTURE_SRC, { probeFn: probeStub({ width: 1920, height: 1080, duration: 30 }) });
    const v = checkById(pf.checks, "vertical")!;
    assert.equal(v.pass, false);
    assert.equal(v.severity, "recommended");
  });

  await check("preflight: a 480x854 video FAILS the (recommended) resolution check", async () => {
    const pf = await preflightVideo(FIXTURE_SRC, { probeFn: probeStub({ width: 480, height: 854, duration: 20 }) });
    assert.equal(checkById(pf.checks, "resolution")!.pass, false);
  });

  await check("preflight: a 3-minute video FAILS the (required) duration check", async () => {
    const pf = await preflightVideo(FIXTURE_SRC, { probeFn: probeStub({ width: 1080, height: 1920, duration: 180 }) });
    const d = checkById(pf.checks, "duration")!;
    assert.equal(d.pass, false);
    assert.equal(d.severity, "required");
  });

  await check("preflight: graceful when ffprobe throws → unknown, no crash", async () => {
    const throwing: ProbeFn = async () => { throw new Error("ffprobe missing"); };
    const pf = await preflightVideo(FIXTURE_SRC, { probeFn: throwing });
    for (const id of ["vertical", "resolution", "duration"]) {
      assert.equal(checkById(pf.checks, id)!.severity, "unknown", id);
    }
  });

  await check("preflight: ffprobe returning nulls → unknown (not a false failure)", async () => {
    const pf = await preflightVideo(FIXTURE_SRC, { probeFn: probeStub({}) });
    assert.equal(checkById(pf.checks, "duration")!.pass, null);
    assert.equal(checkById(pf.checks, "duration")!.severity, "unknown");
  });

  await check("preflight: cloud link → all measurable checks are `unknown`, never failing", async () => {
    const pf = await preflightVideo({ kind: "cloud", ref: "https://www.dropbox.com/s/x/clip.mp4" }, { nameHint: "clip.mp4" });
    for (const id of ["vertical", "resolution", "duration"]) {
      assert.equal(checkById(pf.checks, id)!.pass, null, `${id} should be unknown`);
      assert.equal(checkById(pf.checks, id)!.severity, "unknown");
    }
    // unknowns don't penalize → score is 100 (only the advisory watermark check
    // is measured here, and a clean name passes it).
    assert.equal(pf.score, 100);
  });

  await check("preflight: a missing render file → unknown (no crash)", async () => {
    const pf = await preflightVideo({ kind: "render", ref: "nope.mp4" }, { probeFn: probeStub({ width: 1080, height: 1920, duration: 30 }), nameHint: "nope.mp4" });
    // resolveLocalPath → null (file absent) so the probe is never reached and
    // every measurable check degrades to unknown — never a thrown error.
    assert.equal(checkById(pf.checks, "duration")!.severity, "unknown");
  });

  await check("preflight: watermark name hint is recommended/advisory (never required)", async () => {
    const pf = await preflightVideo({ kind: "cloud", ref: "https://x/snaptik_download.mp4" }, { nameHint: "snaptik_download.mp4" });
    const wm = checkById(pf.checks, "watermark")!;
    assert.equal(wm.pass, false);
    assert.equal(wm.severity, "recommended");
  });

  // ── combineGrowth / hasBlockingFailure ───────────────────────────────────────
  await check("combineGrowth: excludes unknown checks from the score", () => {
    const caption: GrowthCheckDto[] = [
      { id: "a", label: "A", pass: true, severity: "required", hint: "" },
    ];
    const preflight: GrowthCheckDto[] = [
      { id: "b", label: "B", pass: null, severity: "unknown", hint: "" },
    ];
    const g = combineGrowth(caption, preflight);
    assert.equal(g.score, 100); // only the passing required is measured
    assert.equal(g.checks.length, 2);
  });

  await check("hasBlockingFailure: only a measured failing required blocks", () => {
    assert.equal(hasBlockingFailure({ score: 0, checks: [{ id: "x", label: "X", pass: false, severity: "required", hint: "" }] }), true);
    assert.equal(hasBlockingFailure({ score: 0, checks: [{ id: "x", label: "X", pass: false, severity: "recommended", hint: "" }] }), false);
    assert.equal(hasBlockingFailure({ score: 0, checks: [{ id: "x", label: "X", pass: null, severity: "unknown", hint: "" }] }), false);
  });

  // ── schedule() server-side gate ──────────────────────────────────────────────
  // A caption missing the required CTA + hashtags blocks; with override it passes
  // the gate (and then fails at the provider with a NETWORK-FREE error we tolerate
  // — what matters is it was NOT blocked by the gate).
  const badPost = {
    fileId: "f1",
    source: { kind: "cloud" as const, ref: "https://example.com/clip.mp4" }, // cloud → preflight all-unknown
    channelId: "c1",
    provider: "postiz" as const,
    identifier: "tiktok",
    caption: "A boring intro with no call to action at all.",
    hashtags: ["one"], // too few → required hashtag-count fails
    scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const noProbe: ProbeFn = async () => ({ duration: null, width: null, height: null, hasAudio: false });

  await check("schedule: a required-fail item is BLOCKED (no override) and never posts", async () => {
    const out = await schedule({ posts: [badPost] }, { probeFn: noProbe });
    assert.equal(out.scheduled, 0);
    assert.equal(out.failed, 1);
    const r = out.results[0];
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /Growth Guardrails/);
    assert.ok((r.blockedChecks ?? []).some((c) => c.id === "comment-cta" || c.id === "hashtag-count"));
  });

  await check("schedule: override:true lets the SAME item past the gate", async () => {
    const out = await schedule({ posts: [{ ...badPost, override: true }] }, { probeFn: noProbe });
    const r = out.results[0];
    assert.equal(r.ok, false); // still fails — but at the PROVIDER, not the gate
    assert.doesNotMatch(r.error ?? "", /Growth Guardrails/);
    assert.equal(r.blockedChecks, undefined);
  });

  await check("schedule: a recommended-only failure never blocks the gate", async () => {
    // Valid required signals (CTA + 3 tags + keyword + within cap), but a weak
    // opener (recommended hook-strength fails) and a watermark name hint. Cloud
    // source → all video required checks are unknown → nothing required fails.
    const recOnly = {
      ...badPost,
      caption: "Hey, here's a quick tip you'll like — which one do you want next?",
      hashtags: ["fyp", "tips", "budgetmealprepideas"],
    };
    const out = await schedule({ posts: [recOnly] }, { probeFn: noProbe });
    const r = out.results[0];
    assert.doesNotMatch(r.error ?? "", /Growth Guardrails/); // passed the gate
    assert.equal(r.blockedChecks, undefined);
  });

  console.log(`\n${passed} checks passed`);
}

void main().finally(cleanup);
