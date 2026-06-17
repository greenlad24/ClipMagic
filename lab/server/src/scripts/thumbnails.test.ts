/**
 * Unit checks for the Thumbnail Designer (LAB tool). NO network, NO ffmpeg, NO
 * real keys — every external boundary is mocked / pure:
 *   - YouTube search response parsing (maxres preference + hq fallback)
 *   - ISO-8601 duration parsing + Shorts (≤180s) exclusion + most-viewed top-6
 *   - Nano Banana request shaping + image extraction from a mocked response
 *   - crop/scale ffmpeg arg-builder (pure): letterbox + generic cases
 *   - expression-by-video-type selection + distinct-per-variant
 *   - script analysis assembly with a mocked AI (keyword + inferred video type)
 *   - write-only guarantee for GEMINI_API_KEY + YOUTUBE_DATA_API_KEY
 *
 * Run: cd lab/server && npx tsx src/scripts/thumbnails.test.ts
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

async function main() {
  // Isolate data dir BEFORE importing modules that read config.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-thumb-test-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-thumb-cfg-"));
  process.env.DATA_DIR = root;
  process.env.POSTIZ_CONFIG_DIR = configDir;
  process.env.DOCKER_SOCKET = path.join(configDir, "nonexistent.sock");
  // Ensure env-var precedence doesn't mask the STORE path under test.
  delete process.env.GEMINI_API_KEY;
  delete process.env.YOUTUBE_DATA_API_KEY;

  // ── YouTube search parsing ──────────────────────────────────────────────────
  const youtube = await import("../thumbnails/youtube.js");
  await check("parseSearchResponse maps id/title and prefers maxres thumbnail", () => {
    const json = {
      items: [
        { id: { videoId: "AAA" }, snippet: { title: "First", thumbnails: { maxres: { url: "https://x/maxres.jpg" } } } },
        { id: { videoId: "BBB" }, snippet: { title: "Second" } }, // no maxres → hq fallback
        { id: { kind: "channel" }, snippet: { title: "skip (no videoId)" } },
      ],
    };
    const out = youtube.parseSearchResponse(json);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { videoId: "AAA", title: "First", thumbnailUrl: "https://x/maxres.jpg" });
    assert.equal(out[1].thumbnailUrl, youtube.hqThumbnailUrl("BBB"));
  });

  await check("parseIsoDurationSeconds handles mins/secs/hours edge cases", () => {
    assert.equal(youtube.parseIsoDurationSeconds("PT45S"), 45);
    assert.equal(youtube.parseIsoDurationSeconds("PT3M"), 180);
    assert.equal(youtube.parseIsoDurationSeconds("PT4M13S"), 253);
    assert.equal(youtube.parseIsoDurationSeconds("PT1H2M3S"), 3723);
    assert.equal(youtube.parseIsoDurationSeconds("PT1H"), 3600);
    assert.equal(youtube.parseIsoDurationSeconds("P1DT1S"), 86401);
    assert.equal(youtube.parseIsoDurationSeconds("garbage"), 0, "unparseable → 0");
    assert.equal(youtube.parseIsoDurationSeconds(undefined), 0, "missing → 0");
  });

  await check("selectLongForm drops Shorts (≤180s) and keeps the top-N in input order", () => {
    const ordered = [
      { videoId: "A", title: "a", thumbnailUrl: "" }, // 300s long-form (most-viewed)
      { videoId: "B", title: "b", thumbnailUrl: "" }, // 60s Short → dropped
      { videoId: "C", title: "c", thumbnailUrl: "" }, // exactly 180s → dropped (≤180)
      { videoId: "D", title: "d", thumbnailUrl: "" }, // 181s → kept
      { videoId: "E", title: "e", thumbnailUrl: "" }, // unknown duration → dropped
    ];
    const durations = new Map<string, number>([["A", 300], ["B", 60], ["C", 180], ["D", 181]]);
    const out = youtube.selectLongForm(ordered, durations, 6);
    assert.deepEqual(out.map((r) => r.videoId), ["A", "D"], "only long-form, view-count order preserved");
    // top-N cap: with many long-form candidates we keep exactly N.
    const many = Array.from({ length: 10 }, (_, i) => ({ videoId: `V${i}`, title: "", thumbnailUrl: "" }));
    const longAll = new Map(many.map((m) => [m.videoId, 600] as const));
    assert.equal(youtube.selectLongForm(many, longAll, 6).length, 6, "capped at 6");
  });

  await check("parseVideoDurations maps id → seconds from a videos.list response", () => {
    const json = { items: [{ id: "A", contentDetails: { duration: "PT5M" } }, { id: "B", contentDetails: { duration: "PT30S" } }] };
    const d = youtube.parseVideoDurations(json);
    assert.equal(d.get("A"), 300);
    assert.equal(d.get("B"), 30);
  });

  await check("searchTopThumbnails oversamples, drops Shorts via videos.list, returns most-viewed top-6", async () => {
    // Configure the key via the store (write-only path), then search with a mock
    // that answers BOTH the search call and the videos.list (duration) call.
    const secrets = await import("../settings/postizSecrets.js");
    secrets.updateSettings({ values: { YOUTUBE_DATA_API_KEY: "yt-test-key" } });
    // 8 candidates in view-count order; ids S* are Shorts (≤180s), L* are long-form.
    const ids = ["L1", "S1", "L2", "L3", "S2", "L4", "L5", "L6"];
    const durById: Record<string, string> = {
      L1: "PT8M", S1: "PT0M50S", L2: "PT12M", L3: "PT4M1S", S2: "PT3M", L4: "PT20M", L5: "PT6M", L6: "PT9M",
    };
    let searchUrl = "";
    let videosUrl = "";
    const mockFetch = async (url: string) => {
      if (url.includes("/youtube/v3/search")) {
        searchUrl = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ items: ids.map((id) => ({ id: { videoId: id }, snippet: { title: id } })) }),
        };
      }
      // videos.list (contentDetails) — return durations for the requested ids.
      videosUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ items: ids.map((id) => ({ id, contentDetails: { duration: durById[id] } })) }),
      };
    };
    const out = await youtube.searchTopThumbnails("ai editing", 6, mockFetch);
    // Search params: most-viewed, oversampled, recency-capped.
    assert.ok(searchUrl.includes("order=viewCount"), "should order by viewCount");
    assert.ok(searchUrl.includes("maxResults=50"), "should oversample to the max page size");
    assert.ok(searchUrl.includes("regionCode=US"), "should target the US region");
    assert.ok(searchUrl.includes("relevanceLanguage=en"), "should bias to English");
    assert.ok(searchUrl.includes("type=video"));
    assert.ok(searchUrl.includes("publishedAfter="), "should cap recency by default");
    assert.ok(/q=ai\+editing|q=ai%20editing/.test(searchUrl), `query missing: ${searchUrl}`);
    // Durations were fetched via videos.list for the candidate ids.
    assert.ok(videosUrl.includes("/youtube/v3/videos"), "should fetch durations");
    assert.ok(videosUrl.includes("part=contentDetails"));
    // Result: the 6 most-viewed LONG-FORM videos, Shorts excluded, order preserved.
    assert.deepEqual(out.map((r) => r.videoId), ["L1", "L2", "L3", "L4", "L5", "L6"]);
    secrets.updateSettings({ remove: ["YOUTUBE_DATA_API_KEY"] });
  });

  await check("recencyPublishedAfter honors THUMBNAIL_SEARCH_YEARS (0 = all-time)", () => {
    const prev = process.env.THUMBNAIL_SEARCH_YEARS;
    const now = new Date("2026-06-17T00:00:00Z");
    process.env.THUMBNAIL_SEARCH_YEARS = "2";
    assert.equal(youtube.recencyPublishedAfter(now), "2024-06-17T00:00:00.000Z");
    process.env.THUMBNAIL_SEARCH_YEARS = "0";
    assert.equal(youtube.recencyPublishedAfter(now), null, "0 = no recency cap");
    if (prev === undefined) delete process.env.THUMBNAIL_SEARCH_YEARS;
    else process.env.THUMBNAIL_SEARCH_YEARS = prev;
  });

  await check("searchTopThumbnails surfaces a clear quota error on 403", async () => {
    const secrets = await import("../settings/postizSecrets.js");
    secrets.updateSettings({ values: { YOUTUBE_DATA_API_KEY: "yt-test-key" } });
    const mockFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } }),
    });
    await assert.rejects(() => youtube.searchTopThumbnails("x", 6, mockFetch), /quota/i);
    secrets.updateSettings({ remove: ["YOUTUBE_DATA_API_KEY"] });
  });

  // ── Nano Banana request shaping + image extraction ──────────────────────────
  const nano = await import("../thumbnails/nanoBanana.js");
  await check("buildEditRequestBody puts the instruction first then inline_data parts", () => {
    const body = nano.buildEditRequestBody("do the thing", [
      { data: Buffer.from("img1"), mimeType: "image/jpeg" },
      { data: Buffer.from("img2"), mimeType: "image/png" },
    ]);
    const parts = body.contents[0].parts;
    assert.equal(parts.length, 3);
    assert.deepEqual(parts[0], { text: "do the thing" });
    assert.deepEqual(parts[1], { inline_data: { mime_type: "image/jpeg", data: Buffer.from("img1").toString("base64") } });
    assert.deepEqual(parts[2], { inline_data: { mime_type: "image/png", data: Buffer.from("img2").toString("base64") } });
  });

  await check("extractInlineImage finds inline_data (snake_case) and decodes base64", () => {
    const data = Buffer.from("PNGDATA").toString("base64");
    const json = { candidates: [{ content: { parts: [{ text: "ok" }, { inline_data: { mime_type: "image/png", data } }] } }] };
    const img = nano.extractInlineImage(json);
    assert.ok(img);
    assert.equal(img!.mimeType, "image/png");
    assert.equal(img!.data.toString(), "PNGDATA");
  });

  await check("extractInlineImage also handles camelCase inlineData", () => {
    const data = Buffer.from("JPG").toString("base64");
    const json = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/jpeg", data } }] } }] };
    const img = nano.extractInlineImage(json);
    assert.equal(img!.data.toString(), "JPG");
    assert.equal(img!.mimeType, "image/jpeg");
  });

  await check("extractInlineImage returns null when no image part (safety block)", () => {
    assert.equal(nano.extractInlineImage({ candidates: [{ content: { parts: [{ text: "blocked" }] } }] }), null);
    assert.equal(nano.extractInlineImage({}), null);
  });

  await check("editImage saves the returned image and returns an outputUrl (mocked fetch)", async () => {
    const secrets = await import("../settings/postizSecrets.js");
    secrets.updateSettings({ values: { GEMINI_API_KEY: "gem-test-key" } });
    const data = Buffer.from("EDITEDIMAGE").toString("base64");
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data } }] } }] }),
    });
    const res = await nano.editImage(
      { instruction: "edit", images: [{ data: Buffer.from("src"), mimeType: "image/jpeg" }] },
      mockFetch,
    );
    assert.ok(res.outputUrl.startsWith("/api/outputs/thumbnails/"));
    assert.ok(fs.existsSync(res.file));
    assert.equal(fs.readFileSync(res.file).toString(), "EDITEDIMAGE");
    secrets.updateSettings({ remove: ["GEMINI_API_KEY"] });
  });

  await check("editImage throws a clear error on a no-image (blocked) response", async () => {
    const secrets = await import("../settings/postizSecrets.js");
    secrets.updateSettings({ values: { GEMINI_API_KEY: "gem-test-key" } });
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ promptFeedback: { blockReason: "SAFETY" }, candidates: [{ content: { parts: [{ text: "no" }] } }] }),
    });
    await assert.rejects(
      () => nano.editImage({ instruction: "x", images: [{ data: Buffer.from("a"), mimeType: "image/png" }] }, mockFetch),
      /no image|SAFETY/i,
    );
    secrets.updateSettings({ remove: ["GEMINI_API_KEY"] });
  });

  // ── crop/scale ffmpeg arg-builder (pure) ────────────────────────────────────
  const crop = await import("../thumbnails/crop.js");
  await check("buildCropScaleFilter uses the fixed letterbox crop for ~1195x896", () => {
    assert.equal(crop.buildCropScaleFilter(1195, 896), "crop=1195:670:0:113,scale=1920:1080");
    // within tolerance
    assert.equal(crop.buildCropScaleFilter(1192, 898), "crop=1195:670:0:113,scale=1920:1080");
  });

  await check("buildCropScaleFilter center-crops to 16:9 for the generic case", () => {
    // A 4:3 1024x768 source: 16:9 fit is 1024x576, centred (y = (768-576)/2 = 96).
    assert.equal(crop.buildCropScaleFilter(1024, 768), "crop=1024:576:0:96,scale=1920:1080");
    // An already-16:9 source: full frame, no offset.
    assert.equal(crop.buildCropScaleFilter(1920, 1080), "crop=1920:1080:0:0,scale=1920:1080");
  });

  await check("buildCropScaleFilter never pads (no black bars) — taller-than-16:9 source", () => {
    // A 1000x1000 (1:1) source: 16:9 fit is 1000x562 (rounded even), centred.
    const f = crop.buildCropScaleFilter(1000, 1000);
    assert.match(f, /^crop=1000:\d+:0:\d+,scale=1920:1080$/);
    assert.ok(!/pad/.test(f), "must never pad");
  });

  await check("buildCropScaleArgs produces a single-frame transcode argv", () => {
    const args = crop.buildCropScaleArgs("in.png", "out.png", 1195, 896);
    assert.deepEqual(args, ["-y", "-i", "in.png", "-vf", "crop=1195:670:0:113,scale=1920:1080", "-frames:v", "1", "out.png"]);
  });

  // ── expression selection ────────────────────────────────────────────────────
  const vt = await import("../thumbnails/videoType.js");
  await check("expressionForVideoType maps each type per spec", () => {
    assert.equal(vt.expressionForVideoType("Tutorial"), "smile");
    assert.equal(vt.expressionForVideoType("Viral"), "surprise");
    assert.equal(vt.expressionForVideoType("Secret"), "secret");
    assert.equal(vt.expressionForVideoType("Review"), "calm");
  });

  await check("expressionsForVariants leads with the type's primary, distinct per variant", () => {
    const all: any[] = ["smile", "surprise", "secret", "calm"];
    const out = vt.expressionsForVariants("Viral", 3, all);
    assert.equal(out[0], "surprise", "primary leads");
    assert.equal(new Set(out).size, 3, "all distinct when enough available");
  });

  await check("expressionsForVariants cycles (reuses) when fewer expressions than variants", () => {
    const out = vt.expressionsForVariants("Tutorial", 3, ["smile", "calm"] as any);
    assert.equal(out.length, 3);
    assert.equal(out[0], "smile");
    assert.equal(out[2], "smile", "cycles back to the front");
  });

  await check("expressionsForVariants returns [] when nothing is available", () => {
    assert.deepEqual(vt.expressionsForVariants("Review", 2, []), []);
  });

  // ── script analysis (mocked AI) ─────────────────────────────────────────────
  const scriptAnalysis = await import("../thumbnails/scriptAnalysis.js");
  await check("analyzeScript extracts keyword + infers video type from a mocked model", async () => {
    const fakeAi = async () =>
      JSON.stringify({ keyword: '"AI video editing"', videoType: "tutorial", rationale: "It teaches a workflow step by step." });
    const out = await scriptAnalysis.analyzeScript("Today I'll show you how to edit videos with AI...", fakeAi);
    assert.equal(out.keyword, "AI video editing", "keyword trimmed + surrounding quotes stripped");
    assert.equal(out.videoType, "Tutorial", "lowercase model type coerced to the canonical VideoType");
    assert.equal(out.rationale, "It teaches a workflow step by step.");
  });

  await check("analyzeScript coerces every type case-insensitively (aligned with videoType.ts)", async () => {
    for (const [modelType, expected] of [["VIRAL", "Viral"], ["secret", "Secret"], ["Review", "Review"]] as const) {
      const out = await scriptAnalysis.analyzeScript("x", async () => JSON.stringify({ keyword: "k", videoType: modelType }));
      assert.equal(out.videoType, expected);
    }
  });

  await check("analyzeScript throws on non-JSON, missing keyword, and unknown type", async () => {
    await assert.rejects(() => scriptAnalysis.analyzeScript("x", async () => "not json"), /non-JSON/i);
    await assert.rejects(
      () => scriptAnalysis.analyzeScript("x", async () => JSON.stringify({ videoType: "Tutorial" })),
      /no keyword/i,
    );
    await assert.rejects(
      () => scriptAnalysis.analyzeScript("x", async () => JSON.stringify({ keyword: "k", videoType: "podcast" })),
      /unknown video type/i,
    );
    await assert.rejects(() => scriptAnalysis.analyzeScript("   ", async () => "{}"), /paste your video script/i);
  });

  // ── picks are no longer capped at 3 (multi-select, any subset) ───────────────
  await check("generateThumbnailVariants assigns one variant per pick (no 3-cap), expressions cycle", async () => {
    const secrets = await import("../settings/postizSecrets.js");
    const chars = await import("../thumbnails/characters.js");
    // Upload all four expressions so the generator has a full palette.
    const onePx =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    for (const e of chars.EXPRESSIONS) chars.saveCharacter(e, onePx);
    // Mock the source-thumbnail download; make the recreation chain a no-op by
    // pointing each pick at a download that throws AFTER selection, so we still
    // get one (error) variant PER pick — proving the per-pick fan-out, uncapped.
    const orchestrate = await import("../thumbnails/orchestrate.js");
    const picks = ["P1", "P2", "P3", "P4", "P5"]; // five > the old cap of three
    const failingDownload = async () => {
      throw new Error("download stubbed");
    };
    const variants = await orchestrate.generateThumbnailVariants(
      { keyword: "k", videoType: "Viral", picks },
      failingDownload,
    );
    assert.equal(variants.length, 5, "one variant per pick — NOT capped at 3");
    assert.deepEqual(variants.map((v) => v.videoId), picks, "order preserved");
    // Distinct-expression-per-variant cycles the four available expressions.
    assert.equal(variants[0].expression, "surprise", "Viral's primary leads");
    assert.equal(variants[4].expression, variants[0].expression, "cycles back after 4 expressions");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
    void secrets;
  });

  // ── write-only guarantee for the two new keys ───────────────────────────────
  const secrets = await import("../settings/postizSecrets.js");
  const GEM = "gemini-secret-AAAA-1111";
  const YT = "youtube-secret-BBBB-2222";
  await check("the two keys are in the registry under 'Thumbnail Designer'", () => {
    for (const key of ["GEMINI_API_KEY", "YOUTUBE_DATA_API_KEY"]) {
      const def = secrets.POSTIZ_KEY_DEFS.find((d) => d.key === key);
      assert.ok(def, `${key} missing from the registry`);
      assert.equal(def!.group, "Thumbnail Designer");
    }
  });

  await check("GEMINI/YOUTUBE values NEVER leak via getSettings/updateSettings (write-only)", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.YOUTUBE_DATA_API_KEY;
    const responses = [
      JSON.stringify(secrets.updateSettings({ values: { GEMINI_API_KEY: GEM, YOUTUBE_DATA_API_KEY: YT } })),
      JSON.stringify(secrets.getSettings()),
    ];
    for (const r of responses) {
      assert.ok(!r.includes(GEM), "a response leaked the Gemini key");
      assert.ok(!r.includes(YT), "a response leaked the YouTube key");
    }
  });

  await check("both keys are reported configured after save", () => {
    const s = secrets.getSettings();
    assert.equal(s.keys.find((k) => k.key === "GEMINI_API_KEY")?.configured, true);
    assert.equal(s.keys.find((k) => k.key === "YOUTUBE_DATA_API_KEY")?.configured, true);
  });

  await check("server-only getters return the raw value for internal use", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.YOUTUBE_DATA_API_KEY;
    assert.equal(secrets.getGeminiApiKey(), GEM);
    assert.equal(secrets.getYoutubeDataApiKey(), YT);
  });

  await check("neither key is emitted into the Postiz container env file", () => {
    const text = secrets.buildEnvFileContents({ GEMINI_API_KEY: GEM, YOUTUBE_DATA_API_KEY: YT, POSTIZ_JWT_SECRET: "jwt" });
    assert.ok(!text.includes("GEMINI_API_KEY"), "GEMINI_API_KEY leaked into the Postiz env file");
    assert.ok(!text.includes("YOUTUBE_DATA_API_KEY"), "YOUTUBE_DATA_API_KEY leaked into the Postiz env file");
    assert.ok(!text.includes(GEM) && !text.includes(YT), "a key value leaked into the env file");
    assert.ok(text.includes("POSTIZ_JWT_SECRET="), "other keys should still be emitted");
  });

  await check("env var takes precedence over the store for the new getters", () => {
    process.env.GEMINI_API_KEY = "gem-env-override";
    assert.equal(secrets.getGeminiApiKey(), "gem-env-override");
    delete process.env.GEMINI_API_KEY;
  });

  // cleanup
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
}

void main();
