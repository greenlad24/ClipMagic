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

  // ── image-provider router: routes to the right endpoint/model + request shape ─
  const providers = await import("../thumbnails/imageProviders.js");

  await check("editImageWith('gemini-pro') hits the Nano Banana Pro model with 4K + 16:9 imageConfig (the DEFAULT)", async () => {
    const secrets = await import("../settings/postizSecrets.js");
    secrets.updateSettings({ values: { GEMINI_API_KEY: "gem-test-key" } });
    let calledUrl = "";
    let sentBody: any = null;
    const data = Buffer.from("PROIMG").toString("base64");
    const geminiFetch = async (url: string, init: any) => {
      calledUrl = url;
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data } }] } }] }) };
    };
    const res = await providers.editImageWith(
      "gemini-pro",
      { instruction: "edit", images: [{ data: Buffer.from("s"), mimeType: "image/jpeg" }] },
      { geminiFetch },
    );
    assert.ok(calledUrl.includes(`models/${providers.NANO_BANANA_PRO_MODEL}:generateContent`), `should hit the pro model: ${calledUrl}`);
    assert.equal(providers.NANO_BANANA_PRO_MODEL, "gemini-3-pro-image-preview");
    // Same generateContent shape as flash, plus the pro resolution hint — 4K by default.
    assert.deepEqual(sentBody.contents[0].parts[0], { text: "edit" });
    assert.equal(sentBody.generationConfig.imageConfig.aspectRatio, "16:9");
    assert.equal(providers.NANO_BANANA_PRO_IMAGE_SIZE, "4K", "the single Pro default is 4K");
    assert.equal(sentBody.generationConfig.imageConfig.imageSize, "4K", "the default request asks for 4K");
    assert.equal(fs.readFileSync(res.file).toString(), "PROIMG");
    secrets.updateSettings({ remove: ["GEMINI_API_KEY"] });
  });

  await check("providersForMode: each mode → exactly ONE provider sub-run at its default size", () => {
    // gemini-pro is the default mode → one Pro sub-run (4K via the provider default).
    const singlePro = providers.providersForMode("gemini-pro");
    assert.equal(singlePro.length, 1, "a mode is always a single provider");
    assert.equal(singlePro[0].provider, "gemini-pro");
    assert.equal(singlePro[0].imageSize, undefined, "single gemini-pro uses the provider default (4K)");
    assert.match(singlePro[0].label, /Nano Banana Pro · 4K/);
    // gemini-flash → one Flash sub-run.
    const singleFlash = providers.providersForMode("gemini-flash");
    assert.equal(singleFlash.length, 1);
    assert.equal(singleFlash[0].provider, "gemini-flash");
    assert.match(singleFlash[0].label, /Nano Banana \(Flash\)/);
  });

  await check("coerceMode defaults to gemini-pro and accepts only the two Gemini providers (no compare/openai)", () => {
    assert.equal(providers.coerceMode(undefined), "gemini-pro", "default is single Nano Banana Pro");
    assert.equal(providers.coerceMode("nonsense"), "gemini-pro");
    assert.equal(providers.coerceMode("compare"), "gemini-pro", "the removed compare mode falls back to the default");
    assert.equal(providers.coerceMode("openai"), "gemini-pro", "the removed openai mode falls back to the default");
    assert.equal(providers.coerceMode("gemini-pro"), "gemini-pro");
    assert.equal(providers.coerceMode("gemini-flash"), "gemini-flash");
  });

  await check("editImageWith('gemini-flash') hits the flash model (no imageSize) — the cheaper option", async () => {
    const secrets = await import("../settings/postizSecrets.js");
    secrets.updateSettings({ values: { GEMINI_API_KEY: "gem-test-key" } });
    let calledUrl = "";
    let sentBody: any = null;
    const data = Buffer.from("FLASHIMG").toString("base64");
    const geminiFetch = async (url: string, init: any) => {
      calledUrl = url;
      sentBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data } }] } }] }) };
    };
    await providers.editImageWith(
      "gemini-flash",
      { instruction: "edit", images: [{ data: Buffer.from("s"), mimeType: "image/jpeg" }] },
      { geminiFetch },
    );
    assert.ok(calledUrl.includes(`models/${nano.NANO_BANANA_MODEL}:generateContent`), `should hit the flash model: ${calledUrl}`);
    assert.equal(sentBody.generationConfig.imageConfig.aspectRatio, "16:9");
    assert.equal(sentBody.generationConfig.imageConfig.imageSize, undefined, "flash request carries no imageSize");
    secrets.updateSettings({ remove: ["GEMINI_API_KEY"] });
  });

  await check("coerceProvider defaults to gemini-pro and accepts the two Gemini providers (no openai)", () => {
    assert.equal(providers.coerceProvider(undefined), "gemini-pro");
    assert.equal(providers.coerceProvider("nonsense"), "gemini-pro");
    assert.equal(providers.coerceProvider("openai"), "gemini-pro", "the removed openai provider falls back to the default");
    assert.equal(providers.coerceProvider("gemini-flash"), "gemini-flash");
    assert.equal(providers.coerceProvider("gemini-pro"), "gemini-pro");
  });

  // ── crop/scale ffmpeg arg-builder (pure) — robust to ANY output size ────────
  const crop = await import("../thumbnails/crop.js");

  // Helper: the final crop must always be a 16:9 rectangle that fits the input.
  // The scale target is now NATIVE-AWARE (or absent for a ≥1920 native crop), so
  // we accept an optional `,scale=W:H:flags=lanczos` tail (or none).
  const assert16x9 = (filter: string, fullW: number, fullH: number) => {
    const m = filter.match(/^crop=(\d+):(\d+):(\d+):(\d+)(?:,scale=(\d+):(\d+):flags=lanczos)?$/);
    assert.ok(m, `filter shape wrong: ${filter}`);
    const [w, h, x, y] = [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])];
    // 16:9 within rounding (even dims), within the frame, never padded.
    assert.ok(Math.abs(w / h - 16 / 9) < 0.02, `not 16:9: ${w}x${h}`);
    assert.ok(x + w <= fullW && y + h <= fullH, `crop exceeds frame: ${filter}`);
    assert.ok(!/pad/.test(filter), "must never pad");
    // When present, the scale target is itself 16:9 (a 16:9 crop scaled to 16:9).
    if (m![5]) assert.ok(Math.abs(Number(m![5]) / Number(m![6]) - 16 / 9) < 0.02, `scale not 16:9: ${filter}`);
  };

  // ── outputDims policy: native-aware, capped at 4K, floored at 1080p ─────────
  await check("outputDims: 4K stays 4K, larger-than-4K is capped to 4K", () => {
    assert.deepEqual(crop.outputDims(3840, 2160), { w: 3840, h: 2160 }, "exactly 4K → 4K");
    assert.deepEqual(crop.outputDims(5760, 3240), { w: 3840, h: 2160 }, "8K-ish → capped at 4K");
  });

  await check("outputDims: a 2560-wide (2K-ish) crop stays NATIVE (no scaling)", () => {
    assert.deepEqual(crop.outputDims(2560, 1440), { w: 2560, h: 1440 }, "≥1920 and <4K → native");
  });

  await check("outputDims: exactly-1920 stays NATIVE (not upscaled past the floor)", () => {
    assert.deepEqual(crop.outputDims(1920, 1080), { w: 1920, h: 1080 }, "exactly the floor → native");
  });

  await check("outputDims: a 1280-wide (small) crop UPSCALES to the 1080p floor", () => {
    assert.deepEqual(crop.outputDims(1280, 720), { w: 1920, h: 1080 }, "<1920 → upscale to floor");
  });

  await check("buildCropScaleFilter center-crops a 4:3 source to 16:9, upscaling small content to the floor", () => {
    // 4:3 1024x768 → 16:9 fit is 1024x576, centred (y = (768-576)/2 = 96). 1024<1920 → upscale to floor.
    const f = crop.buildCropScaleFilter(1024, 768);
    assert.equal(f, "crop=1024:576:0:96,scale=1920:1080:flags=lanczos");
    assert16x9(f, 1024, 768);
  });

  await check("buildCropScaleFilter passes through an already-16:9 1080p source WITHOUT scaling (native)", () => {
    const f = crop.buildCropScaleFilter(1920, 1080);
    // 1920 is exactly the floor and already 16:9 → native crop, NO scale at all.
    assert.equal(f, "crop=1920:1080:0:0");
    assert16x9(f, 1920, 1080);
  });

  await check("buildCropScaleFilter keeps a 4K letterboxed source at ~4K (NOT downscaled to 1080)", () => {
    // A 3840x2400 frame with a true-16:9 4K content box (3840x2160) centred (y=120).
    const content = { w: 3840, h: 2160, x: 0, y: 120 };
    const f = crop.buildCropScaleFilter(3840, 2400, content);
    // The content box is already 4K 16:9 → native crop, NO scale (stays 4K).
    assert.equal(f, "crop=3840:2160:0:120");
    assert16x9(f, 3840, 2400);
    assert.ok(!/scale=1920:1080/.test(f), "a 4K render must NOT be downscaled to 1080p");
  });

  await check("buildCropScaleFilter center-crops a square source to 16:9", () => {
    const f = crop.buildCropScaleFilter(1000, 1000);
    assert16x9(f, 1000, 1000);
  });

  await check("buildCropScaleFilter strips a detected letterbox content rect, then 16:9 (small → floor)", () => {
    // A 1280x900 frame letterboxed: a true-16:9 content box (1280x720) at y=90.
    const content = { w: 1280, h: 720, x: 0, y: 90 };
    const f = crop.buildCropScaleFilter(1280, 900, content);
    // The content box is already 16:9 but 1280<1920 → upscale to the 1080p floor.
    assert.equal(f, "crop=1280:720:0:90,scale=1920:1080:flags=lanczos");
    assert16x9(f, 1280, 900);
  });

  await check("buildCropScaleArgs produces a single-frame high-quality JPG transcode argv (with content rect)", () => {
    const args = crop.buildCropScaleArgs("in.png", "out.jpg", 1280, 900, { w: 1280, h: 720, x: 0, y: 90 });
    assert.deepEqual(args, [
      "-y", "-i", "in.png",
      "-vf", "crop=1280:720:0:90,scale=1920:1080:flags=lanczos",
      "-frames:v", "1",
      "-q:v", "3",
      "out.jpg",
    ]);
  });

  await check("buildCropScaleArgs emits a JPG quality flag (under YouTube's 2 MB cap) and no needless 4K scale", () => {
    // A native 4K 16:9 input → crop only, no scale, still a -q:v JPG.
    const args = crop.buildCropScaleArgs("in.png", "out.jpg", 3840, 2160);
    assert.deepEqual(args, [
      "-y", "-i", "in.png",
      "-vf", "crop=3840:2160:0:0",
      "-frames:v", "1",
      "-q:v", "3",
      "out.jpg",
    ]);
    assert.ok(args.includes("-q:v"), "delivers a quality JPG (PNG 4K can exceed 2 MB)");
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
    // Order is device-screen, font, bold-text, text-rewrite, logo.
    assert.deepEqual(steps.map((s) => s.id), ["device-screen", "font", "bold-text", "text-rewrite", "logo"]);
    // text-rewrite wasn't proposed here → present but not applied; the other four apply.
    assert.ok(steps.filter((s) => s.id !== "text-rewrite").every((s) => s.apply), "the four structured edits apply when slots are present");
    assert.equal(byId["text-rewrite"].apply, false, "no text-rewrite proposed → skipped");
    // No leftover brackets in any emitted (applied) instruction.
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

  await check("parseDirectorResponse: text-rewrite (array) assembles one instruction per text block + keeps the brand word", () => {
    // Rewrite BOTH a headline AND a secondary line; the brand word stays in the main text.
    const steps = artDirector.parseDirectorResponse(
      {
        "text-rewrite": {
          apply: true,
          rewrites: [
            { old: "OpenClaw is here", new: "I tried OpenClaw for 30 days" },
            { old: "AI EMPLOYEE", new: "24/7 AI EMPLOYEE" },
          ],
        },
      },
      "OpenClaw",
    );
    const trs = steps.filter((s) => s.id === "text-rewrite");
    assert.equal(trs.length, 2, "one step emitted per editable text block");
    assert.ok(trs.every((s) => s.apply), "both rewrites apply");
    assert.equal(
      trs[0].instruction,
      'change the text "OpenClaw is here" to "I tried OpenClaw for 30 days", keeping it in the same place, size and style',
    );
    assert.equal(
      trs[1].instruction,
      'change the text "AI EMPLOYEE" to "24/7 AI EMPLOYEE", keeping it in the same place, size and style',
    );
    // No leftover bracket placeholders in any emitted instruction.
    assert.ok(trs.every((s) => !/\[|\]/.test(s.instruction)), "no unfilled bracket placeholders");
  });

  await check("parseDirectorResponse: legacy single {old,new} text-rewrite still works", () => {
    const steps = artDirector.parseDirectorResponse(
      { "text-rewrite": { apply: true, old: "OpenClaw is here", new: "I tried OpenClaw for 30 days" } },
      "OpenClaw",
    );
    const trs = steps.filter((s) => s.id === "text-rewrite");
    assert.equal(trs.length, 1);
    assert.equal(trs[0].apply, true);
    assert.equal(
      trs[0].instruction,
      'change the text "OpenClaw is here" to "I tried OpenClaw for 30 days", keeping it in the same place, size and style',
    );
  });

  await check("parseDirectorResponse: a brand-ERASING rewrite is dropped, but a safe secondary rewrite still applies", () => {
    const steps = artDirector.parseDirectorResponse(
      {
        "text-rewrite": {
          apply: true,
          rewrites: [
            { old: "OpenClaw is here", new: "I tried this for 30 days" }, // ERASES the brand → dropped
            { old: "AI EMPLOYEE", new: "24/7 AI EMPLOYEE" }, // secondary, no brand → kept
          ],
        },
      },
      "OpenClaw",
    );
    const trs = steps.filter((s) => s.id === "text-rewrite");
    // The brand-erasing rewrite is dropped per-rewrite; the secondary one survives.
    assert.equal(trs.length, 1, "only the safe secondary rewrite is emitted");
    assert.ok(trs[0].apply, "the secondary rewrite applies");
    assert.equal(
      trs[0].instruction,
      'change the text "AI EMPLOYEE" to "24/7 AI EMPLOYEE", keeping it in the same place, size and style',
    );
  });

  await check("parseDirectorResponse: the ONLY rewrite is dropped when it erases the brand (nothing survives)", () => {
    const steps = artDirector.parseDirectorResponse(
      { "text-rewrite": { apply: true, rewrites: [{ old: "OpenClaw is here", new: "I tried this for 30 days" }] } },
      "OpenClaw",
    );
    const trs = steps.filter((s) => s.id === "text-rewrite");
    assert.equal(trs.length, 1, "a single disabled placeholder remains");
    assert.equal(trs[0].apply, false, "a lone brand-erasing rewrite leaves nothing to apply");
    assert.equal(trs[0].instruction, "");
  });

  await check("parseDirectorResponse: the source's DIFFERENT product title is rewritten TO the keyword", () => {
    // Source thumbnail title is "CLAWDBOT" (an old/other name); keyword is "OpenClaw".
    const steps = artDirector.parseDirectorResponse(
      {
        "text-rewrite": {
          apply: true,
          rewrites: [
            { old: "CLAWDBOT", new: "OpenClaw" }, // main title → keyword
            { old: "24/7 AI EMPLOYEE", new: "YOUR AI AGENT WORKS NONSTOP" }, // secondary
          ],
        },
      },
      "OpenClaw",
    );
    const trs = steps.filter((s) => s.id === "text-rewrite");
    assert.equal(trs.length, 2, "both the title→keyword and the secondary rewrite are emitted");
    assert.ok(trs.every((s) => s.apply));
    assert.equal(
      trs[0].instruction,
      'change the text "CLAWDBOT" to "OpenClaw", keeping it in the same place, size and style',
    );
  });

  await check("parseDirectorResponse: a SECONDARY-only rewrite applies while the brand text is left untouched", () => {
    // The exact user case: keep "OpenClaw", rewrite only the "Full Guide" tagline.
    const steps = artDirector.parseDirectorResponse(
      { "text-rewrite": { apply: true, rewrites: [{ old: "Full Guide", new: "Complete Breakdown" }] } },
      "OpenClaw",
    );
    const trs = steps.filter((s) => s.id === "text-rewrite");
    assert.equal(trs.length, 1, "the secondary rewrite is emitted even though no rewrite mentions the brand");
    assert.ok(trs[0].apply, "secondary text varies while the brand block stays put");
    assert.equal(
      trs[0].instruction,
      'change the text "Full Guide" to "Complete Breakdown", keeping it in the same place, size and style',
    );
  });

  await check("parseDirectorResponse: a secondary line WITHOUT the brand is allowed as long as the main text keeps it", () => {
    const steps = artDirector.parseDirectorResponse(
      {
        "text-rewrite": {
          apply: true,
          rewrites: [
            { old: "old headline", new: "OpenClaw changed everything" }, // main keeps brand
            { old: "sub line", new: "in just 24 hours" }, // secondary, no brand — fine
          ],
        },
      },
      "OpenClaw",
    );
    const trs = steps.filter((s) => s.id === "text-rewrite");
    assert.equal(trs.length, 2, "both rewrites emitted once the main text anchors the brand");
    assert.ok(trs.every((s) => s.apply));
  });

  await check("parseDirectorResponse: text-rewrite skipped when there is no editable text", () => {
    const steps = artDirector.parseDirectorResponse(
      { "text-rewrite": { apply: true, rewrites: [] } },
      "OpenClaw",
    );
    const trs = steps.filter((s) => s.id === "text-rewrite");
    assert.equal(trs.length, 1, "disabled placeholder");
    assert.equal(trs[0].apply, false, "no editable text → no rewrite");
  });

  await check("parseDirectorResponse: brand logo/mascot is NEVER swapped; generic icon still swappable", () => {
    // The subject brand's own mascot/logo → leave untouched.
    const brandLogo = artDirector.parseDirectorResponse(
      { logo: { apply: true, icon_or_company: "OpenClaw mascot", target_icon_or_company: "robot icon" } },
      "OpenClaw",
    );
    assert.equal(brandLogo.find((s) => s.id === "logo")!.apply, false, "the brand's own logo/mascot is off-limits");
    // A generic, unrelated stock icon → still swappable.
    const genericLogo = artDirector.parseDirectorResponse(
      { logo: { apply: true, icon_or_company: "gear icon", target_icon_or_company: "bell icon" } },
      "OpenClaw",
    );
    const g = genericLogo.find((s) => s.id === "logo")!;
    assert.equal(g.apply, true, "a generic icon is still swappable");
    assert.equal(g.instruction, "change the gear icon logo to another type of a bell icon logo");
    // Reject even when only the TARGET is the brand (can't introduce the brand mark either).
    const intoBrand = artDirector.parseDirectorResponse(
      { logo: { apply: true, icon_or_company: "gear icon", target_icon_or_company: "OpenClaw logo" } },
      "OpenClaw",
    );
    assert.equal(intoBrand.find((s) => s.id === "logo")!.apply, false, "don't swap a generic icon INTO the brand mark");
  });

  // ── swap-director: body assessment parsing + oversized heuristic (pure) ─────
  await check("parseSwapAssessment coerces a model object + tolerates junk", () => {
    assert.deepEqual(
      artDirector.parseSwapAssessment({ currentBuild: "  bulky torso ", bodyVisible: true, framing: "chest-up" }),
      { currentBuild: "bulky torso", bodyVisible: true, framing: "chest-up" },
    );
    // Missing/garbage → safe defaults (empty strings, bodyVisible only on literal true).
    assert.deepEqual(artDirector.parseSwapAssessment(null), { currentBuild: "", bodyVisible: false, framing: "" });
    assert.deepEqual(artDirector.parseSwapAssessment({ bodyVisible: "yes" }), { currentBuild: "", bodyVisible: false, framing: "" });
  });

  await check("buildLooksOversized flags large/costume builds and passes natural ones", () => {
    for (const b of ["oversized/bulky mascot-costume torso", "very muscular bodybuilder frame", "huge broad shoulders", "stocky burly build"]) {
      assert.equal(artDirector.buildLooksOversized(b), true, `should flag: ${b}`);
    }
    for (const b of ["natural average build", "slim medium frame", "", "normal proportions"]) {
      assert.equal(artDirector.buildLooksOversized(b), false, `should NOT flag: ${b}`);
    }
  });

  // ── recreation chain: swap is LAST; middle steps are PLAIN (no FACE_LOCK/ref) ─
  const recreate = await import("../thumbnails/recreate.js");

  await check("buildFinalSwapInstruction: oversized → tailored resize clause; else → static prompt", () => {
    // No assessment / body not visible / average build → the static prompt verbatim.
    assert.equal(recreate.buildFinalSwapInstruction(undefined), recreate.FINAL_SWAP_PROMPT);
    assert.equal(
      recreate.buildFinalSwapInstruction({ currentBuild: "oversized torso", bodyVisible: false, framing: "x" }),
      recreate.FINAL_SWAP_PROMPT,
      "body not visible → don't tailor",
    );
    assert.equal(
      recreate.buildFinalSwapInstruction({ currentBuild: "natural average build", bodyVisible: true, framing: "x" }),
      recreate.FINAL_SWAP_PROMPT,
      "already average → static prompt",
    );
    // Oversized + visible → a tailored instruction that names the build + orders a resize.
    const tailored = recreate.buildFinalSwapInstruction({
      currentBuild: "oversized/bulky mascot-costume torso", bodyVisible: true, framing: "chest-up",
    });
    assert.notEqual(tailored, recreate.FINAL_SWAP_PROMPT);
    assert.match(tailored, /oversized\/bulky mascot-costume torso/);
    assert.match(tailored, /do NOT keep it/i);
    assert.match(tailored, /resize the torso and shoulders/i);
    assert.match(tailored, /the body following\s+the face/i);
  });
  await check("the chain runs plain outfit/optional/background edits, then the STRONG full swap LAST (+ 16:9 preamble)", async () => {
    const sent: Array<{ instruction: string; imageCount: number }> = [];
    const editImage = async (opts: any) => {
      sent.push({ instruction: opts.instruction, imageCount: opts.images.length });
      return { file: "/x", outputUrl: "/x", bytes: Buffer.from(`img${sent.length}`), mimeType: "image/png" };
    };
    // Art-director returns ONE optional edit (font) so we can see it land between outfit and background.
    let directorSawImage: Buffer | undefined;
    const artDirect = async (o: any) => {
      directorSawImage = o.imageBytes as Buffer;
      return artDirector.parseDirectorResponse({ font: { apply: true, text: "title", color: "white" } });
    };
    const finalize = async (_c: any, steps: any) => ({ outputUrl: "/out.png", file: "/x", steps });
    // Pre-swap body assessment: a NATURAL/average build → the static swap prompt is
    // used unchanged (no resize clause). Capture what image the analyzer saw.
    let swapDirectorSawImage: Buffer | undefined;
    const analyzeForSwap = async (o: any) => {
      swapDirectorSawImage = o.imageBytes as Buffer;
      return { currentBuild: "natural average build", bodyVisible: true, framing: "chest-up close-up" };
    };
    const res = await recreate.recreateThumbnail(
      {
        sourceBytes: Buffer.from("SOURCE"),
        sourceMime: "image/jpeg",
        characterBytes: Buffer.from("CHAR"),
        keyword: "ai editing",
        videoType: "Tutorial",
        expression: "smile",
      },
      { editImage, artDirect, analyzeForSwap, finalize },
    );
    const pre = `(${(await import("../thumbnails/nanoBanana.js")).WIDESCREEN_PREAMBLE})`;
    // There is NO early swap: the FIRST edit is the plain outfit change on the
    // ORIGINAL person — ONE image, no character ref, no FACE_LOCK.
    assert.equal(sent[0].instruction, `${recreate.STEP2_PROMPT} ${pre}`);
    assert.ok(sent[0].instruction.includes("change the character outfit to a t-shirt"), "step 1 is the plain outfit edit");
    assert.equal(sent[0].imageCount, 1, "outfit is a plain edit on the original person (no ref)");
    assert.doesNotMatch(sent[0].instruction, /reference headshot|SECOND image/i, "outfit must NOT thread a face-lock/ref");
    // Optional font edit: templated core verbatim, brackets filled, PLAIN (1 image).
    assert.ok(
      sent[1].instruction.includes(
        "I want to change the font of the title but keep it in the same white color the same simple text shape - just the font",
      ),
      "optional font templated verbatim",
    );
    assert.equal(sent[1].imageCount, 1, "optional edits are plain (no ref)");
    assert.doesNotMatch(sent[1].instruction, /reference headshot/i, "optional edit must NOT carry FACE_LOCK");
    // Background (ALWAYS) is SECOND-to-last — a PLAIN edit (1 image), no face-lock.
    const bg = sent[sent.length - 2];
    assert.ok(bg.instruction.includes(recreate.STEP8_PROMPT), "background core verbatim");
    assert.equal(bg.imageCount, 1, "background is a plain edit (no ref)");
    assert.doesNotMatch(bg.instruction, /reference headshot/i, "background must NOT carry FACE_LOCK");
    assert.match(bg.instruction, /position of every element exactly the same/i, "keeps layout");
    // The background pop is MODERATE: clearly noticeable (pop + vibrant/saturated +
    // contrast) but NOT a wild redesign (no dramatic rays / neon / new patterns).
    assert.match(bg.instruction, /pop/i, "mentions a pop");
    assert.match(bg.instruction, /vibrant|saturat/i, "mentions richer/vibrant/saturated color");
    assert.match(bg.instruction, /contrast/i, "mentions stronger contrast/separation");
    assert.match(bg.instruction, /NOT a redesign|not a redesign/i, "stays a mid-level enhancement, not a redesign");
    assert.match(bg.instruction, /do NOT add dramatic|light rays|neon/i, "no wild rays/neon");
    // FINAL step (ALWAYS, genuinely LAST): the STRONG FULL SWAP — the same verbatim
    // strong-swap text, carrying the character ref as the SECOND image (2 inputs).
    const last = sent[sent.length - 1];
    assert.equal(last.instruction, `${recreate.STEP1_PROMPT} ${pre}`, "the LAST edit is the verbatim strong swap");
    assert.equal(recreate.FINAL_SWAP_PROMPT, recreate.STEP1_PROMPT, "final swap reuses the strong swap text");
    assert.match(last.instruction, /SECOND image/i, "final swap anchors identity to the second image");
    assert.equal(last.imageCount, 2, "final swap feeds [current, character ref]");
    // The swap now also specifies the BODY so it fits the swapped-in face: a
    // medium / slightly-fit, average physique with a seamless neck + matching skin,
    // reading as one real man (not a head pasted on a mismatched/oversized body).
    assert.match(last.instruction, /medium build/i, "swap specifies a medium build");
    assert.match(last.instruction, /slightly fit|average physique/i, "swap specifies a slightly-fit / average physique");
    assert.match(last.instruction, /seamless neck/i, "swap specifies a seamless neck join");
    assert.match(last.instruction, /matching skin tone/i, "swap specifies matching skin tone");
    assert.match(last.instruction, /one real man/i, "swap insists the person reads as one real man");
    assert.match(last.instruction, /NOT a head pasted/i, "swap forbids a head pasted on a mismatched/oversized body");
    assert.match(last.instruction, /at least 70% of the thumbnail's height/i, "swap enforces a large face (≥70% height)");
    // NO instruction anywhere is the old weak re-anchor nudge.
    assert.ok(sent.every((s) => !/fix any drift from the previous edits/i.test(s.instruction)), "no weak re-anchor nudge remains");
    // The art-director analysed the OUTFIT RESULT image (current working image),
    // NOT the source thumbnail. The outfit edit produced "img1".
    assert.ok(directorSawImage, "director was called");
    assert.equal(directorSawImage!.toString(), "img1", "director saw the OUTFIT result, not the source");
    assert.notEqual(directorSawImage!.toString(), "SOURCE");
    // The PRE-SWAP body analyzer ran on the POST-BACKGROUND working image (the 3rd
    // edit, "img3"), NOT the source and NOT the freshly-swapped image.
    assert.ok(swapDirectorSawImage, "swap-director was called before the swap");
    assert.equal(swapDirectorSawImage!.toString(), "img3", "swap-director saw the post-background working image");
    void res;
  });

  await check("the chain runs outfit → background → strong swap LAST even when the art-director returns nothing", async () => {
    const sent: Array<{ instruction: string; imageCount: number }> = [];
    const editImage = async (opts: any) => {
      sent.push({ instruction: opts.instruction, imageCount: opts.images.length });
      return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
    };
    const res = await recreate.recreateThumbnail(
      {
        sourceBytes: Buffer.from("S"), sourceMime: "image/jpeg",
        characterBytes: Buffer.from("C"), keyword: "k", videoType: "Viral", expression: "surprise",
      },
      {
        editImage,
        artDirect: async () => [],
        analyzeForSwap: async () => ({ currentBuild: "natural average build", bodyVisible: true, framing: "chest-up" }),
        finalize: async (_c, steps) => ({ outputUrl: "/o", file: "/x", steps }),
      },
    );
    // 3 edits: outfit, background, swap (no optionals — the early swap is GONE).
    assert.equal(sent.length, 3, "no early swap: outfit + background + final swap");
    assert.ok(sent[0].instruction.includes("change the character outfit to a t-shirt"), "outfit is first");
    assert.match(sent[1].instruction, /background.*(pop|contrast|vibrant)/i, "background is second");
    assert.equal(sent[2].instruction, `${recreate.STEP1_PROMPT} (${(await import("../thumbnails/nanoBanana.js")).WIDESCREEN_PREAMBLE})`, "strong swap runs LAST");
    assert.equal(sent[2].imageCount, 2, "the final swap carries the character ref");
    // The chain records the final swap step with the expected id/label.
    const swap = res.steps.find((s) => s.id === "swap-character");
    assert.ok(swap, "the final swap is recorded as a chain step");
    assert.equal(swap!.label, "Swap in character");
    assert.equal(swap!.applied, true);
    // No early replace-character / refine-character steps remain.
    assert.equal(res.steps.find((s) => s.id === "replace-character"), undefined, "no early swap step");
    assert.equal(res.steps.find((s) => s.id === "refine-character"), undefined, "no weak re-anchor step");
  });

  await check("a failed edit keeps the last good image and the chain continues to the end", async () => {
    let calls = 0;
    const editImage = async (opts: any) => {
      calls++;
      if (calls === 1) throw new Error("safety block"); // outfit step (first) fails
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
    // Background edit AND the final swap still ran afterwards.
    assert.ok(res.steps.find((s) => s.id === "background"), "background step still attempted");
    assert.ok(res.steps.find((s) => s.id === "swap-character")?.applied, "the final swap still ran");
  });

  // ── pre-swap body assessment: the body follows the FACE ─────────────────────
  await check("an OVERSIZED current body weaves an EXPLICIT resize clause into the final swap", async () => {
    const sent: Array<{ instruction: string; imageCount: number }> = [];
    const editImage = async (opts: any) => {
      sent.push({ instruction: opts.instruction, imageCount: opts.images.length });
      return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
    };
    const analyzeForSwap = async () => ({
      currentBuild: "oversized/bulky mascot-costume torso",
      bodyVisible: true,
      framing: "chest-up, centred",
    });
    const res = await recreate.recreateThumbnail(
      {
        sourceBytes: Buffer.from("S"), sourceMime: "image/jpeg",
        characterBytes: Buffer.from("C"), keyword: "k", videoType: "Viral", expression: "surprise",
      },
      { editImage, artDirect: async () => [], analyzeForSwap, finalize: async (_c, steps) => ({ outputUrl: "/o", file: "/x", steps }) },
    );
    const last = sent[sent.length - 1];
    assert.equal(last.imageCount, 2, "the final swap still carries the character ref as the SECOND image");
    // It is NOT the static prompt — it names the current build and orders a resize.
    assert.notEqual(last.instruction, `${recreate.STEP1_PROMPT} (${nano.WIDESCREEN_PREAMBLE})`, "the swap was tailored, not static");
    assert.match(last.instruction, /oversized\/bulky mascot-costume torso/, "names the current oversized build verbatim");
    assert.match(last.instruction, /do NOT keep it/i, "explicitly says NOT to keep the current body");
    assert.match(last.instruction, /resize the torso and shoulders/i, "explicitly orders a torso/shoulder resize");
    assert.match(last.instruction, /the body following\s+the face/i, "the body follows the face, not the reverse");
    // Identity + body contract is still intact (same anchor phrases as the static prompt).
    assert.match(last.instruction, /exact face, head, hairstyle, hair colour and beard of the man in the SECOND image/i, "identity text preserved");
    assert.match(last.instruction, /medium build/i, "still asks for a medium build");
    assert.match(last.instruction, /slightly fit, average physique/i, "still asks for a slightly-fit average physique");
    assert.match(last.instruction, /seamless neck/i, "seamless neck");
    assert.match(last.instruction, /matching skin tone/i, "matching skin tone");
    assert.match(last.instruction, /one real man/i, "reads as one real man");
    assert.match(last.instruction, /NOT a head pasted/i, "forbids a head pasted on a mismatched/oversized body");
    assert.match(last.instruction, /all text and logos in their/i, "layout/text/logos preserved");
    // It is recorded as the swap-character step (applied).
    assert.ok(res.steps.find((s) => s.id === "swap-character")?.applied, "final swap applied");
  });

  await check("a NON-oversized (average) current body leaves the swap as the static FINAL_SWAP_PROMPT", async () => {
    const sent: Array<{ instruction: string }> = [];
    const editImage = async (opts: any) => {
      sent.push({ instruction: opts.instruction });
      return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
    };
    const analyzeForSwap = async () => ({ currentBuild: "natural average build", bodyVisible: true, framing: "chest-up" });
    await recreate.recreateThumbnail(
      {
        sourceBytes: Buffer.from("S"), sourceMime: "image/jpeg",
        characterBytes: Buffer.from("C"), keyword: "k", videoType: "Viral", expression: "surprise",
      },
      { editImage, artDirect: async () => [], analyzeForSwap, finalize: async (_c, steps) => ({ outputUrl: "/o", file: "/x", steps }) },
    );
    const last = sent[sent.length - 1];
    assert.equal(last.instruction, `${recreate.STEP1_PROMPT} (${nano.WIDESCREEN_PREAMBLE})`, "an average build → static swap, no resize clause");
    assert.doesNotMatch(last.instruction, /do NOT keep it/i, "no resize clause for an average build");
  });

  await check("a FAILING pre-swap analyzer falls back to the static FINAL_SWAP_PROMPT and the chain still finishes", async () => {
    const sent: Array<{ instruction: string; imageCount: number }> = [];
    const editImage = async (opts: any) => {
      sent.push({ instruction: opts.instruction, imageCount: opts.images.length });
      return { file: "/x", outputUrl: "/x", bytes: Buffer.from("e"), mimeType: "image/png" };
    };
    const analyzeForSwap = async () => { throw new Error("vision exploded"); };
    const res = await recreate.recreateThumbnail(
      {
        sourceBytes: Buffer.from("S"), sourceMime: "image/jpeg",
        characterBytes: Buffer.from("C"), keyword: "k", videoType: "Review", expression: "calm",
      },
      { editImage, artDirect: async () => [], analyzeForSwap, finalize: async (_c, steps) => ({ outputUrl: "/o", file: "/x", steps }) },
    );
    const last = sent[sent.length - 1];
    // Falls back to the STATIC strong-swap prompt (which already carries a body clause).
    assert.equal(last.instruction, `${recreate.STEP1_PROMPT} (${nano.WIDESCREEN_PREAMBLE})`, "analyzer failure → static swap prompt");
    assert.equal(last.imageCount, 2, "the final swap still feeds [current, character ref]");
    // The swap STILL ran (the chain finished) and the failure was recorded.
    assert.ok(res.steps.find((s) => s.id === "swap-character")?.applied, "the swap still ran after analyzer failure");
    const sd = res.steps.find((s) => s.id === "swap-director");
    assert.ok(sd && sd.applied === false, "the swap-director failure is recorded as a skipped step");
    assert.match(sd!.note ?? "", /vision exploded/);
  });

  await check("recreateThumbnail threads the chosen provider into the default edit primitive (no editImage dep)", async () => {
    // With NO editImage injected, the chain defaults to editImageWith(provider,…).
    // Clear the key so each step's edit fails with a Gemini error — the resilient
    // chain records that note, proving the edit was routed through editImageWith.
    const secrets = await import("../settings/postizSecrets.js");
    secrets.updateSettings({ remove: ["GEMINI_API_KEY"] });
    delete process.env.GEMINI_API_KEY;
    const base = {
      sourceBytes: Buffer.from("S"), sourceMime: "image/jpeg",
      characterBytes: Buffer.from("C"), keyword: "k", videoType: "Viral" as const, expression: "surprise" as const,
    };
    const finalize = async (_c: any, steps: any) => ({ outputUrl: "/o", file: "/x", steps });

    const proRun = await recreate.recreateThumbnail({ ...base, provider: "gemini-pro" }, { artDirect: async () => [], finalize });
    assert.match(proRun.steps[0].note ?? "", /Gemini API key not configured/i, "gemini-pro provider routed to the Gemini back-end");

    const flashRun = await recreate.recreateThumbnail({ ...base, provider: "gemini-flash" }, { artDirect: async () => [], finalize });
    assert.match(flashRun.steps[0].note ?? "", /Gemini API key not configured/i, "gemini-flash provider routed to the Gemini back-end");

    // Default (no provider) → gemini-pro (the sharpest option).
    const defaultRun = await recreate.recreateThumbnail({ ...base }, { artDirect: async () => [], finalize });
    assert.match(defaultRun.steps[0].note ?? "", /Gemini API key not configured/i, "default provider is a Gemini path");
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
    // default: plain lanczos (used to downsample a crisp Real-ESRGAN 4x output).
    assert.deepEqual(upscale.buildResampleArgs("in.png", "out.png"), [
      "-y", "-i", "in.png", "-vf", "scale=1920:1080:flags=lanczos", "-frames:v", "1", "out.png",
    ]);
    // sharpen: the default (CPU) path scales UP, so it adds unsharp.
    assert.ok(upscale.buildResampleArgs("in.png", "out.png", { sharpen: true }).join(" ").includes("unsharp"));
  });

  await check("upscaleToThumbnail: default is the fast sharpened ffmpeg path (Real-ESRGAN opt-in/off)", async () => {
    let ffmpegRuns = 0;
    const res = await upscale.upscaleToThumbnail("in.png", "out.png", {
      // no `enabled` → reads the env default (off); Real-ESRGAN must NOT run even if available.
      available: () => true,
      runRealesrgan: async () => { throw new Error("should not be called when disabled"); },
      runFfmpegFn: async () => { ffmpegRuns++; return {}; },
    });
    assert.equal(res.method, "ffmpeg-fallback");
    assert.equal(ffmpegRuns, 1, "single sharpened ffmpeg scale");
    assert.match(res.note ?? "", /disabled/i);
  });

  await check("upscaleToThumbnail uses Real-ESRGAN when enabled + available", async () => {
    let realRan = false;
    let ffmpegRuns = 0;
    const res = await upscale.upscaleToThumbnail("in.png", "out.png", {
      enabled: () => true,
      available: () => true,
      runRealesrgan: async () => { realRan = true; },
      runFfmpegFn: async () => { ffmpegRuns++; return {}; },
    });
    assert.equal(res.method, "realesrgan");
    assert.ok(realRan, "Real-ESRGAN was invoked");
    assert.equal(ffmpegRuns, 1, "then one ffmpeg downsample to exactly 1920x1080");
  });

  await check("upscaleToThumbnail falls back to ffmpeg when enabled but the binary is unavailable", async () => {
    let ffmpegRuns = 0;
    const res = await upscale.upscaleToThumbnail("in.png", "out.png", {
      enabled: () => true,
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
      enabled: () => true,
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

  await check("expressionsForVariants uses the type's primary for every variant (repeats allowed)", () => {
    const all: any[] = ["smile", "surprise", "secret", "calm"];
    const out = vt.expressionsForVariants("Viral", 3, all);
    assert.equal(out.length, 3);
    assert.deepEqual(out, ["surprise", "surprise", "surprise"], "same best-fit expression, no forced variety");
  });

  await check("expressionsForVariants falls back to first available when primary is missing", () => {
    const out = vt.expressionsForVariants("Viral", 3, ["smile", "calm"] as any);
    assert.equal(out.length, 3);
    assert.deepEqual(out, ["smile", "smile", "smile"], "primary 'surprise' unavailable → first available 'smile'");
  });

  await check("expressionsForVariants returns [] when nothing is available", () => {
    assert.deepEqual(vt.expressionsForVariants("Review", 2, []), []);
  });

  // ── expression DIRECTOR (per-source vision pick; pure parts) ─────────────────
  const opt = (id: string, label?: string) => ({ id, label: label ?? id });
  await check("fallbackExpression: type primary when available, else first available", () => {
    assert.equal(artDirector.fallbackExpression("Viral", [opt("smile"), opt("surprise"), opt("calm")] as any), "surprise");
    assert.equal(artDirector.fallbackExpression("Viral", [opt("smile"), opt("calm")] as any), "smile", "primary missing → first available");
  });

  await check("parseExpressionChoice: accepts an available id OR label, else falls back (case-insensitive)", () => {
    const avail: any[] = [opt("smile"), opt("surprise"), opt("calm")];
    assert.equal(artDirector.parseExpressionChoice({ expression: "Surprise" }, avail, "smile" as any), "surprise");
    assert.equal(artDirector.parseExpressionChoice({ expression: "secret" }, avail, "smile" as any), "smile", "unavailable → fallback");
    assert.equal(artDirector.parseExpressionChoice({}, avail, "calm" as any), "calm", "missing → fallback");
    // A custom expression chosen by its human label resolves to its id.
    const customs: any[] = [opt("pointing-up", "Pointing up")];
    assert.equal(artDirector.parseExpressionChoice({ expression: "Pointing up" }, customs, "pointing-up" as any), "pointing-up", "matches by label");
  });

  await check("buildExpressionDirectorUserText lists only the available expressions + asks for busy", () => {
    const txt = artDirector.buildExpressionDirectorUserText({
      keyword: "make money with AI",
      videoType: "Viral",
      available: [opt("surprise"), opt("calm")] as any,
    });
    assert.match(txt, /surprise/);
    assert.match(txt, /calm/);
    assert.doesNotMatch(txt, /\bsecret\b/, "an unavailable expression is not offered");
    assert.match(txt, /one of: surprise, calm/, "the JSON shape constrains to available options");
    assert.match(txt, /busy/i, "also asks for the element-heavy (busy) flag");
  });

  await check("parseBackgroundChoice: matches an available id, else null", () => {
    assert.equal(artDirector.parseBackgroundChoice({ backgroundId: "Red-Grid" }, ["red-grid", "blue"]), "red-grid");
    assert.equal(artDirector.parseBackgroundChoice({ backgroundId: "none" }, ["red-grid"]), null, "unknown → null");
    assert.equal(artDirector.parseBackgroundChoice({ backgroundId: null }, ["red-grid"]), null, "null → null");
    assert.equal(artDirector.parseBackgroundChoice({}, ["red-grid"]), null, "missing → null");
  });

  await check("buildConsolidatedInstruction: one-shot swap + preserve elements + text + pop", () => {
    const inst = recreate.buildConsolidatedInstruction({
      keyword: "OpenClaw",
      textChanges: ['change the text "CLAWDBOT" to "OpenClaw", keeping it in the same place, size and style'],
    });
    assert.match(inst, /SINGLE edit/i, "it's a single pass");
    assert.match(inst, /SECOND image/i, "swaps in the character");
    assert.match(inst, /medium build/i, "carries the body clause");
    assert.match(inst, /do NOT distort, warp, melt/i, "forbids degrading the props");
    assert.match(inst, /t-shirt/i, "changes the outfit");
    assert.match(inst, /POP/, "pops the background");
    assert.match(inst, /change the text "CLAWDBOT" to "OpenClaw"/, "embeds the text changes verbatim");
  });

  await check("buildConsolidatedInstruction: omits the text section when there are no text changes", () => {
    const inst = recreate.buildConsolidatedInstruction({ keyword: "OpenClaw", textChanges: [] });
    assert.doesNotMatch(inst, /Apply these exact text changes/i, "no empty text block");
    assert.match(inst, /SECOND image/i, "still swaps the character");
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
  await check("generateThumbnailVariants assigns one variant per pick (no 3-cap), same expression per variant", async () => {
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
    // Every variant uses the type's best-fit expression — no forced look-change.
    assert.ok(variants.every((v) => v.expression === "surprise"), "all variants use Viral's best-fit 'surprise'");
    for (const e of chars.EXPRESSIONS) chars.deleteCharacter(e);
    void secrets;
  });

  // ── upscale: a LARGE source downscales cleanly (no needless re-sharpen) ──────
  await check("upscaleToThumbnail does a PLAIN lanczos scale (no unsharp) for a large source (2K → 1080p)", async () => {
    let vf = "";
    const res = await upscale.upscaleToThumbnail("in.png", "out.png", {
      available: () => false,
      runRealesrgan: async () => { throw new Error("nope"); },
      runFfmpegFn: async (args: string[]) => { vf = args[args.indexOf("-vf") + 1]; return {}; },
    }, { sourceWidth: 2048 });
    assert.equal(res.method, "ffmpeg-fallback");
    assert.ok(!vf.includes("unsharp"), "a downscale of a large source must NOT add unsharp (clean lanczos only)");
    assert.ok(vf.includes("scale=1920:1080:flags=lanczos"), "still resamples to exactly 1920x1080");
  });

  await check("buildResampleArgs honors native target dims (never forces 1080) and defaults to the floor", () => {
    // Native target dims thread through — e.g. a small source upscaled to a 4K box.
    assert.deepEqual(upscale.buildResampleArgs("in.png", "out.jpg", { width: 3840, height: 2160 }), [
      "-y", "-i", "in.png", "-vf", "scale=3840:2160:flags=lanczos", "-frames:v", "1", "out.jpg",
    ]);
    // No dims given → defaults to the 1920×1080 floor (backward compatible).
    assert.deepEqual(upscale.buildResampleArgs("in.png", "out.jpg"), [
      "-y", "-i", "in.png", "-vf", "scale=1920:1080:flags=lanczos", "-frames:v", "1", "out.jpg",
    ]);
  });

  await check("upscaleToThumbnail resamples to the NATIVE target dims when threaded (no 1080 force)", async () => {
    let vf = "";
    const res = await upscale.upscaleToThumbnail("in.png", "out.jpg", {
      enabled: () => true,
      available: () => true,
      runRealesrgan: async () => {},
      runFfmpegFn: async (args: string[]) => { vf = args[args.indexOf("-vf") + 1]; return {}; },
    }, { sourceWidth: 1280, targetWidth: 1920, targetHeight: 1080 });
    assert.equal(res.method, "realesrgan");
    assert.ok(vf.includes("scale=1920:1080:flags=lanczos"), "downsamples the 4× image to the native target");
  });

  await check("upscaleToThumbnail still soften-guards (unsharp) when scaling a SMALL source UP", async () => {
    let vf = "";
    await upscale.upscaleToThumbnail("in.png", "out.png", {
      available: () => false,
      runRealesrgan: async () => { throw new Error("nope"); },
      runFfmpegFn: async (args: string[]) => { vf = args[args.indexOf("-vf") + 1]; return {}; },
    }, { sourceWidth: 1280 });
    assert.ok(vf.includes("unsharp"), "a small upscaled source keeps the unsharp guard");
  });

  // ── write-only guarantee for the Thumbnail Designer keys ─────────────────────
  const secrets = await import("../settings/postizSecrets.js");
  const GEM = "gemini-secret-AAAA-1111";
  const YT = "youtube-secret-BBBB-2222";
  await check("the Thumbnail Designer keys (Gemini + YouTube) are in the registry under 'Thumbnail Designer'", () => {
    for (const key of ["GEMINI_API_KEY", "YOUTUBE_DATA_API_KEY"]) {
      const def = secrets.POSTIZ_KEY_DEFS.find((d) => d.key === key);
      assert.ok(def, `${key} missing from the registry`);
      assert.equal(def!.group, "Thumbnail Designer");
    }
    // The OpenAI generation provider was removed — no OPENAI_API_KEY in the registry.
    assert.equal(secrets.POSTIZ_KEY_DEFS.find((d) => d.key === "OPENAI_API_KEY"), undefined, "OPENAI_API_KEY is no longer registered");
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
