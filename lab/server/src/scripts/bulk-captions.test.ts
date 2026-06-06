/**
 * Unit checks for the Bulk Scheduler caption engine (postiz/captions) and the
 * file-source bridge (postiz/fileSources). The AI call is STUBBED — no network.
 *
 *   - per-platform assembly clamps hashtag counts to the rule
 *   - hashtags are normalized (# stripped, deduped) and YouTube always gets #Shorts
 *   - the firstLineHook becomes the caption's first line
 *   - captions are clamped to the per-platform char cap
 *   - generateCaptions returns DISTINCT entries per platform via a mock AI
 *   - cloud links: Dropbox dl=1 + Google Drive id extraction → direct URLs
 *
 * Run: cd lab/server && npx tsx src/scripts/bulk-captions.test.ts
 */
import assert from "node:assert/strict";
import {
  assemblePlatformCaption,
  generateCaptions,
  normalizeHashtag,
  PLATFORM_RULES,
} from "../postiz/captions.js";
import { normalizeCloudLink, resolveSourceUrl } from "../postiz/fileSources.js";

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

async function main() {
  await check("normalizeHashtag strips '#', spaces and punctuation", () => {
    assert.equal(normalizeHashtag("#FooBar"), "FooBar");
    assert.equal(normalizeHashtag("foo bar!"), "foobar");
    assert.equal(normalizeHashtag("##multi"), "multi");
    assert.equal(normalizeHashtag(""), null);
    assert.equal(normalizeHashtag(42), null);
  });

  await check("assemble clamps hashtags to the platform max", () => {
    const many = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const out = assemblePlatformCaption("tiktok", { firstLineHook: "Hook", caption: "Hook\nbody", hashtags: many });
    assert.ok(out.hashtags.length <= PLATFORM_RULES.tiktok.maxTags);
  });

  await check("YouTube always carries #Shorts at the front", () => {
    const out = assemblePlatformCaption("youtube", { firstLineHook: "Title", caption: "Title\ndesc", hashtags: ["learn", "code"] });
    assert.equal(out.hashtags[0], "Shorts");
  });

  await check("hashtags are deduped case-insensitively", () => {
    const out = assemblePlatformCaption("instagram", {
      firstLineHook: "H",
      caption: "H\nbody",
      hashtags: ["Travel", "travel", "TRAVEL", "food"],
    });
    const lower = out.hashtags.map((t) => t.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
  });

  await check("firstLineHook becomes the caption's first line when missing", () => {
    const out = assemblePlatformCaption("tiktok", { firstLineHook: "The hook", caption: "Some body text", hashtags: [] });
    assert.ok(out.caption.startsWith("The hook"), out.caption);
  });

  await check("caption is clamped to the per-platform char cap", () => {
    const long = "x".repeat(2000);
    const out = assemblePlatformCaption("tiktok", { firstLineHook: "Hook", caption: long, hashtags: [] });
    assert.ok(out.caption.length <= PLATFORM_RULES.tiktok.maxCaptionChars);
  });

  await check("generateCaptions returns distinct entries per platform (mock AI)", async () => {
    const mock = async () =>
      JSON.stringify({
        platforms: {
          tiktok: { firstLineHook: "TT hook", caption: "TT hook\nshort punchy", hashtags: ["fyp", "viral"] },
          instagram: { firstLineHook: "IG hook", caption: "IG hook\nvalue + cta", hashtags: ["reels", "tips"] },
          youtube: { firstLineHook: "YT title", caption: "YT title\nseo desc", hashtags: ["howto"] },
        },
      });
    const res = await generateCaptions("a brief", ["tiktok", "instagram", "youtube"], mock);
    assert.equal(res.tiktok.firstLineHook, "TT hook");
    assert.equal(res.instagram.firstLineHook, "IG hook");
    assert.equal(res.youtube.hashtags[0], "Shorts"); // injected
    assert.notEqual(res.tiktok.caption, res.instagram.caption);
  });

  await check("generateCaptions tolerates malformed AI JSON (no throw)", async () => {
    const mock = async () => "not json at all";
    const res = await generateCaptions("brief", ["tiktok"], mock);
    assert.ok("tiktok" in res);
    assert.equal(typeof res.tiktok.caption, "string");
  });

  // ── file sources ──────────────────────────────────────────────────────────
  await check("Dropbox share link is normalized to dl=1", () => {
    const out = normalizeCloudLink("https://www.dropbox.com/s/abc123/video.mp4?dl=0");
    assert.match(out, /dl=1/);
    assert.doesNotMatch(out, /dl=0/);
  });

  await check("Dropbox link without dl param gets dl=1 appended", () => {
    const out = normalizeCloudLink("https://www.dropbox.com/s/abc123/video.mp4");
    assert.match(out, /dl=1/);
  });

  await check("Google Drive /file/d/<id>/view → uc?export=download", () => {
    const out = normalizeCloudLink("https://drive.google.com/file/d/1AbC_xyz/view?usp=sharing");
    assert.equal(out, "https://drive.google.com/uc?export=download&id=1AbC_xyz");
  });

  await check("Google Drive open?id=<id> → uc?export=download", () => {
    const out = normalizeCloudLink("https://drive.google.com/open?id=ZZZ999");
    assert.equal(out, "https://drive.google.com/uc?export=download&id=ZZZ999");
  });

  await check("non-cloud URL is returned unchanged", () => {
    const url = "https://example.com/raw/video.mp4";
    assert.equal(normalizeCloudLink(url), url);
  });

  await check("resolveSourceUrl builds internal URLs for renders and uploads", () => {
    process.env.CLIPMAGIC_INTERNAL_URL = "http://clipmagic-lab:9090";
    assert.equal(resolveSourceUrl({ kind: "render", ref: "out 1.mp4" }), "http://clipmagic-lab:9090/api/outputs/out%201.mp4");
    assert.equal(resolveSourceUrl({ kind: "upload", ref: "abc123" }), "http://clipmagic-lab:9090/api/uploads/abc123");
    assert.equal(
      resolveSourceUrl({ kind: "cloud", ref: "https://drive.google.com/file/d/XYZ/view" }),
      "https://drive.google.com/uc?export=download&id=XYZ",
    );
  });

  console.log(`\n${passed} checks passed`);
}

void main();
