/**
 * Unit checks for the Thumbnail Designer (LAB tool). NO network, NO ffmpeg, NO
 * real keys — every external boundary is mocked / pure:
 *   - YouTube search response parsing (maxres preference + hq fallback)
 *   - Nano Banana request shaping + image extraction from a mocked response
 *   - crop/scale ffmpeg arg-builder (pure): letterbox + generic cases
 *   - expression-by-video-type selection + distinct-per-variant
 *   - metadata assembly with a mocked AI (titles SEO-first)
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

  await check("searchTopThumbnails uses the injected fetch + the right query params", async () => {
    // Configure the key via the store (write-only path), then search with a mock.
    const secrets = await import("../settings/postizSecrets.js");
    secrets.updateSettings({ values: { YOUTUBE_DATA_API_KEY: "yt-test-key" } });
    let calledUrl = "";
    const mockFetch = async (url: string) => {
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({ items: [{ id: { videoId: "Z1" }, snippet: { title: "T" } }] }) };
    };
    const out = await youtube.searchTopThumbnails("ai editing", 6, mockFetch);
    assert.equal(out.length, 1);
    assert.ok(calledUrl.includes("order=viewCount"), "should order by viewCount");
    assert.ok(calledUrl.includes("maxResults=6"));
    assert.ok(calledUrl.includes("type=video"));
    assert.ok(/q=ai\+editing|q=ai%20editing/.test(calledUrl), `query missing: ${calledUrl}`);
    secrets.updateSettings({ remove: ["YOUTUBE_DATA_API_KEY"] });
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

  // ── metadata assembly (mocked AI) ───────────────────────────────────────────
  const metadata = await import("../thumbnails/metadata.js");
  await check("generateMetadata normalizes, keeps 3 titles, fixes #/tags (titles SEO-first)", async () => {
    const fakeAi = async () =>
      JSON.stringify({
        titles: [
          "AI Video Editing: The Trick Nobody Shows You",
          "AI Video Editing — I Tried It For 30 Days",
          "AI Video Editing in 2026 (Full Walkthrough)",
          "EXTRA TITLE SHOULD BE DROPPED",
        ],
        description: "  A guide to AI video editing.  ",
        hashtags: ["ai", "#editing", "videoediting"],
        tags: ["#aiediting", "video editing", ""],
      });
    const meta = await metadata.generateMetadata("AI video editing", "Tutorial", fakeAi);
    assert.equal(meta.titles.length, 3, "capped at 3");
    assert.ok(meta.titles[0].toLowerCase().startsWith("ai video editing"), "SEO keyword leads the title");
    assert.equal(meta.description, "A guide to AI video editing.");
    assert.deepEqual(meta.hashtags, ["#ai", "#editing", "#videoediting"], "every hashtag forced to start with #");
    assert.deepEqual(meta.tags, ["aiediting", "video editing"], "tags strip # and drop empties");
  });

  await check("generateMetadata throws on non-JSON and on empty titles", async () => {
    await assert.rejects(() => metadata.generateMetadata("k", "Viral", async () => "not json"), /non-JSON/i);
    await assert.rejects(
      () => metadata.generateMetadata("k", "Viral", async () => JSON.stringify({ titles: [] })),
      /no titles/i,
    );
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
