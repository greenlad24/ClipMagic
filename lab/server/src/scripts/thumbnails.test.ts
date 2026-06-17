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

  // ── crop/scale ffmpeg arg-builder (pure) — robust to ANY output size ────────
  const crop = await import("../thumbnails/crop.js");

  // Helper: the final crop must always be a 16:9 rectangle that fits the input.
  const assert16x9 = (filter: string, fullW: number, fullH: number) => {
    const m = filter.match(/^crop=(\d+):(\d+):(\d+):(\d+),scale=1920:1080:flags=lanczos$/);
    assert.ok(m, `filter shape wrong: ${filter}`);
    const [w, h, x, y] = [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])];
    // 16:9 within rounding (even dims), within the frame, never padded.
    assert.ok(Math.abs(w / h - 16 / 9) < 0.02, `not 16:9: ${w}x${h}`);
    assert.ok(x + w <= fullW && y + h <= fullH, `crop exceeds frame: ${filter}`);
    assert.ok(!/pad/.test(filter), "must never pad");
  };

  await check("buildCropScaleFilter center-crops a 4:3 source to 16:9 (no bars)", () => {
    // 4:3 1024x768 → 16:9 fit is 1024x576, centred (y = (768-576)/2 = 96).
    const f = crop.buildCropScaleFilter(1024, 768);
    assert.equal(f, "crop=1024:576:0:96,scale=1920:1080:flags=lanczos");
    assert16x9(f, 1024, 768);
  });

  await check("buildCropScaleFilter passes through an already-16:9 source", () => {
    const f = crop.buildCropScaleFilter(1920, 1080);
    assert.equal(f, "crop=1920:1080:0:0,scale=1920:1080:flags=lanczos");
    assert16x9(f, 1920, 1080);
  });

  await check("buildCropScaleFilter center-crops a square source to 16:9", () => {
    const f = crop.buildCropScaleFilter(1000, 1000);
    assert16x9(f, 1000, 1000);
  });

  await check("buildCropScaleFilter strips a detected letterbox content rect, then 16:9", () => {
    // A 1280x900 frame letterboxed: a true-16:9 content box (1280x720) at y=90.
    const content = { w: 1280, h: 720, x: 0, y: 90 };
    const f = crop.buildCropScaleFilter(1280, 900, content);
    // The content box is already 16:9, so the crop is exactly the content box.
    assert.equal(f, "crop=1280:720:0:90,scale=1920:1080:flags=lanczos");
    assert16x9(f, 1280, 900);
  });

  await check("buildCropScaleArgs produces a single-frame transcode argv (with content rect)", () => {
    const args = crop.buildCropScaleArgs("in.png", "out.png", 1280, 900, { w: 1280, h: 720, x: 0, y: 90 });
    assert.deepEqual(args, [
      "-y", "-i", "in.png",
      "-vf", "crop=1280:720:0:90,scale=1920:1080:flags=lanczos",
      "-frames:v", "1", "out.png",
    ]);
  });

  await check("parseCropdetect returns the content box, ignores a full-frame box", () => {
    const stderr = "[Parsed_cropdetect] x1:0 ... crop=1195:670:0:113\n[Parsed_cropdetect] crop=1195:670:0:113\n";
    assert.deepEqual(crop.parseCropdetect(stderr, 1195, 896), { w: 1195, h: 670, x: 0, y: 113 });
    // A box equal to the full frame = no bars → null (use whole frame).
    assert.equal(crop.parseCropdetect("crop=1920:1080:0:0", 1920, 1080), null);
    assert.equal(crop.parseCropdetect("no boxes here", 100, 100), null);
  });

  // ── art-director: EXACT template filling (only brackets substituted) ────────
  const artDirector = await import("../thumbnails/artDirector.js");
  await check("parseDirectorResponse fills steps 4–7 templates verbatim (only brackets)", () => {
    const steps = artDirector.parseDirectorResponse({
      "device-screen": { apply: true, character_or_screen: "screen", device: "phone", content: "bright app dashboard" },
      font: { apply: true, text: "headline", color: "yellow" },
      "bold-text": { apply: true, text: "FREE" },
      logo: { apply: true, icon_or_company: "YouTube", target_icon_or_company: "TikTok" },
    });
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    assert.equal(
      byId["device-screen"].instruction,
      "change the screen inside of the phone - it needs to be a bright app dashboard",
    );
    assert.equal(
      byId.font.instruction,
      "I want to change the font of the headline but keep it in the same yellow color the same simple text shape - just the font",
    );
    assert.equal(byId["bold-text"].instruction, 'I want to make the "FREE" in bold font');
    assert.equal(byId.logo.instruction, "change the YouTube logo to another type of a TikTok logo");
    // Order is device-screen, font, bold-text, logo (steps 4→7).
    assert.deepEqual(steps.map((s) => s.id), ["device-screen", "font", "bold-text", "logo"]);
    assert.ok(steps.every((s) => s.apply), "all four apply when slots are present");
    // No leftover brackets in any emitted instruction.
    assert.ok(steps.every((s) => !/\[|\]/.test(s.instruction)), "no unfilled bracket placeholders");
  });

  await check("parseDirectorResponse skips a step when apply is false or a slot is empty", () => {
    const steps = artDirector.parseDirectorResponse({
      "device-screen": { apply: false, character_or_screen: "screen", device: "phone", content: "x" },
      font: { apply: true, text: "headline" }, // missing color → skipped
      "bold-text": { apply: true, text: "" }, // empty text → skipped
      logo: { apply: true, icon_or_company: "A" }, // missing target → skipped
    });
    assert.ok(steps.every((s) => s.apply === false), "none apply");
    assert.ok(steps.every((s) => s.instruction === ""), "no instruction when not applied");
  });

  // ── recreation chain: EXACT verbatim prompts + STEP-2 art-director image ────
  const recreate = await import("../thumbnails/recreate.js");
  await check("the chain emits verbatim prompts for steps 1/2/8 and templated 4–7 (+ 16:9 preamble)", async () => {
    const sent: Array<{ instruction: string; imageCount: number }> = [];
    const editImage = async (opts: any) => {
      sent.push({ instruction: opts.instruction, imageCount: opts.images.length });
      return { file: "/x", outputUrl: "/x", bytes: Buffer.from(`img${sent.length}`), mimeType: "image/png" };
    };
    // Art-director returns ONE optional edit (font) so we can see it land between 2 and 8.
    let directorSawImage: Buffer | undefined;
    const artDirect = async (o: any) => {
      directorSawImage = o.imageBytes as Buffer;
      return artDirector.parseDirectorResponse({ font: { apply: true, text: "title", color: "white" } });
    };
    const finalize = async (_c: any, steps: any) => ({ outputUrl: "/out.png", file: "/x", steps });
    const res = await recreate.recreateThumbnail(
      {
        sourceBytes: Buffer.from("SOURCE"),
        sourceMime: "image/jpeg",
        characterBytes: Buffer.from("CHAR"),
        keyword: "ai editing",
        videoType: "Tutorial",
        expression: "smile",
      },
      { editImage, artDirect, finalize },
    );
    const pre = `(${(await import("../thumbnails/nanoBanana.js")).WIDESCREEN_PREAMBLE})`;
    // Step 1: identity-locked swap (must reference the SECOND image as the
    // identity source) + TWO inputs (source + character ref).
    assert.equal(sent[0].instruction, `${recreate.STEP1_PROMPT} ${pre}`);
    assert.match(sent[0].instruction, /SECOND image/i, "must anchor identity to the second image");
    assert.equal(sent[0].imageCount, 2, "step 1 feeds source + character");
    // Step 2: exact literal "a t-shirt".
    assert.equal(sent[1].instruction, `change the character outfit to a t-shirt ${pre}`);
    // Step (optional font): templated, brackets filled.
    assert.equal(
      sent[2].instruction,
      `I want to change the font of the title but keep it in the same white color the same simple text shape - just the font ${pre}`,
    );
    // Step 8 (ALWAYS, last): background color + pattern, verbatim.
    assert.equal(
      sent[sent.length - 1].instruction,
      `change the background color and the background pattern to something different, but keep the character, all text, logos, and the exact position of every element the same ${pre}`,
    );
    // The art-director analysed the STEP-2 RESULT image (current working image),
    // NOT the source thumbnail. Step 1 produced "img1", step 2 produced "img2".
    assert.ok(directorSawImage, "director was called");
    assert.equal(directorSawImage!.toString(), "img2", "director saw the STEP-2 result, not the source");
    assert.notEqual(directorSawImage!.toString(), "SOURCE");
    void res;
  });

  await check("the chain always runs the background edit even when the art-director returns nothing", async () => {
    const sent: string[] = [];
    const editImage = async (opts: any) => {
      sent.push(opts.instruction);
      return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
    };
    await recreate.recreateThumbnail(
      {
        sourceBytes: Buffer.from("S"), sourceMime: "image/jpeg",
        characterBytes: Buffer.from("C"), keyword: "k", videoType: "Viral", expression: "surprise",
      },
      { editImage, artDirect: async () => [], finalize: async (_c, steps) => ({ outputUrl: "/o", file: "/x", steps }) },
    );
    // 3 edits: replace character, t-shirt, background (no optional steps).
    assert.equal(sent.length, 3);
    assert.match(sent[2], /change the background color and the background pattern/);
  });

  await check("a failed edit keeps the last good image and the chain continues to the end", async () => {
    let calls = 0;
    const editImage = async (opts: any) => {
      calls++;
      if (calls === 2) throw new Error("safety block"); // outfit step fails
      return { file: "/x", outputUrl: "/x", bytes: Buffer.from(`ok${calls}`), mimeType: "image/png" };
    };
    const res = await recreate.recreateThumbnail(
      {
        sourceBytes: Buffer.from("S"), sourceMime: "image/jpeg",
        characterBytes: Buffer.from("C"), keyword: "k", videoType: "Review", expression: "calm",
      },
      { editImage, artDirect: async () => [], finalize: async (_c, steps) => ({ outputUrl: "/o", file: "/x", steps }) },
    );
    const outfit = res.steps.find((s) => s.id === "outfit");
    assert.equal(outfit?.applied, false, "outfit step recorded as not applied");
    assert.match(outfit?.note ?? "", /safety block/);
    // Background edit (always-on) still ran afterwards.
    assert.ok(res.steps.find((s) => s.id === "background"), "background step still attempted");
  });

  // ── 16:9 source selection: maxres → mqdefault, NEVER hqdefault ──────────────
  await check("downloadSourceThumbnail uses maxres when available (true 16:9)", async () => {
    const orchestrate = await import("../thumbnails/orchestrate.js");
    const seen: string[] = [];
    const download = async (url: string) => {
      seen.push(url);
      return { bytes: Buffer.from("img"), mime: "image/jpeg" };
    };
    const r = await orchestrate.downloadSourceThumbnail("VID", download);
    assert.ok(r.url.includes("maxresdefault.jpg"), "prefers maxres (16:9)");
    assert.ok(!seen.some((u) => u.includes("hqdefault")), "never fetches hqdefault (4:3)");
  });

  await check("downloadSourceThumbnail falls back to mqdefault (16:9), never hqdefault", async () => {
    const orchestrate = await import("../thumbnails/orchestrate.js");
    const seen: string[] = [];
    const download = async (url: string) => {
      seen.push(url);
      if (url.includes("maxresdefault")) throw new Error("404 no maxres");
      return { bytes: Buffer.from("img"), mime: "image/jpeg" };
    };
    const r = await orchestrate.downloadSourceThumbnail("VID", download);
    assert.ok(r.url.includes("mqdefault.jpg"), "falls back to mqdefault (16:9), not hqdefault");
    assert.ok(!seen.some((u) => u.includes("hqdefault")), "never fetches hqdefault (4:3)");
  });

  // ── upscaler: runs when available, FALLS BACK to ffmpeg otherwise / on error ─
  const upscale = await import("../thumbnails/upscale.js");
  await check("buildRealesrganArgs / buildResampleArgs produce the expected argv", () => {
    const r = upscale.buildRealesrganArgs("in.png", "out.png");
    assert.deepEqual(r.slice(0, 6), ["-i", "in.png", "-o", "out.png", "-s", "4"]);
    assert.equal(r[7], upscale.REALESRGAN_MODEL);
    assert.deepEqual(upscale.buildResampleArgs("in.png", "out.png"), [
      "-y", "-i", "in.png", "-vf", "scale=1920:1080:flags=lanczos", "-frames:v", "1", "out.png",
    ]);
  });

  await check("upscaleToThumbnail uses Real-ESRGAN when available", async () => {
    let realRan = false;
    let ffmpegRuns = 0;
    const res = await upscale.upscaleToThumbnail("in.png", "out.png", {
      available: () => true,
      runRealesrgan: async () => { realRan = true; },
      runFfmpegFn: async () => { ffmpegRuns++; return {}; },
    });
    assert.equal(res.method, "realesrgan");
    assert.ok(realRan, "Real-ESRGAN was invoked");
    assert.equal(ffmpegRuns, 1, "then one ffmpeg downsample to exactly 1920x1080");
  });

  await check("upscaleToThumbnail falls back to ffmpeg when the binary is unavailable", async () => {
    let ffmpegRuns = 0;
    const res = await upscale.upscaleToThumbnail("in.png", "out.png", {
      available: () => false,
      runRealesrgan: async () => { throw new Error("should not be called"); },
      runFfmpegFn: async () => { ffmpegRuns++; return {}; },
    });
    assert.equal(res.method, "ffmpeg-fallback");
    assert.equal(ffmpegRuns, 1, "single ffmpeg lanczos scale");
    assert.match(res.note ?? "", /unavailable/i);
  });

  await check("upscaleToThumbnail falls back to ffmpeg when Real-ESRGAN ERRORS", async () => {
    let ffmpegRuns = 0;
    const res = await upscale.upscaleToThumbnail("in.png", "out.png", {
      available: () => true,
      runRealesrgan: async () => { throw new Error("vulkan exploded"); },
      runFfmpegFn: async () => { ffmpegRuns++; return {}; },
    });
    assert.equal(res.method, "ffmpeg-fallback");
    assert.equal(ffmpegRuns, 1, "fell back to a single ffmpeg scale");
    assert.match(res.note ?? "", /vulkan exploded/);
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
