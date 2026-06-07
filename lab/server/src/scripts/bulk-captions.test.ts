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
  scoreCaption,
  stripTrailingHashtags,
  PLATFORM_RULES,
  MAX_TRANSCRIPT_PROMPT_CHARS,
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

  await check("stripTrailingHashtags peels only the trailing tag block", () => {
    const r = stripTrailingHashtags("Real hook. What do you think?\n\n#AI #FutureOfWork #MIT");
    assert.equal(r.caption, "Real hook. What do you think?");
    assert.deepEqual(r.tags, ["AI", "FutureOfWork", "MIT"]);
    // mid-text '#1' is NOT stripped (only a contiguous trailing run).
    assert.equal(stripTrailingHashtags("My #1 tip is huge").caption, "My #1 tip is huge");
  });

  await check("assemble strips inline trailing hashtags into the tags array (no dup, ends on ?)", () => {
    const out = assemblePlatformCaption("tiktok", {
      firstLineHook: "AI and jobs explained",
      caption: "AI and jobs explained\n\nThe data is nuanced. What part of your job is safe?\n\n#AI #Jobs #MIT",
      hashtags: ["AI"],
    });
    assert.ok(!out.caption.includes("#"), "caption body must not retain hashtags");
    assert.ok(/\?\s*$/.test(out.caption), "caption must end on the question");
    for (const t of ["AI", "Jobs", "MIT"]) assert.ok(out.hashtags.includes(t), `tag ${t} preserved`);
    // The required comment-CTA passes with no manual fix.
    const cta = scoreCaption(out.caption, out.hashtags, "tiktok").checks.find((c) => c.id === "comment-cta")!;
    assert.equal(cta.pass, true);
  });

  await check("assemble appends a closing question when the model ends on a statement", () => {
    const out = assemblePlatformCaption("youtube", {
      firstLineHook: "MIT study: tasks vs jobs",
      caption: "MIT study: tasks vs jobs\n\nIt's about tasks, not jobs. Remember that.\n\n#Shorts #AI",
      hashtags: [],
    });
    assert.ok(/\?\s*$/.test(out.caption), "a question is guaranteed at the end");
    const cta = scoreCaption(out.caption, out.hashtags, "youtube").checks.find((c) => c.id === "comment-cta")!;
    assert.equal(cta.pass, true);
  });

  await check("scoreCaption: a question followed by a hashtag block still passes comment-cta", () => {
    const { checks } = scoreCaption(
      "Keyword hook here. What's the first task AI takes from you?\n\n#AI #FutureOfWork #MIT",
      ["AI", "FutureOfWork", "MIT"],
      "tiktok",
    );
    assert.equal(checks.find((c) => c.id === "comment-cta")!.pass, true);
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

  await check("generic caption assembles + scores via the generic rule", async () => {
    // assemble: a Facebook-style long caption + light hashtags, clamped to the
    // generous generic cap (2000) — never given #Shorts (that's youtube-only).
    const out = assemblePlatformCaption("generic", {
      firstLineHook: "Budget meal prep saved me $400",
      caption: "Budget meal prep saved me $400 this month — here's the full plan you can copy.\nWhich one should I make next?",
      hashtags: ["mealprep", "budgetmealprepideas", "food"],
    });
    assert.equal(out.platform, "generic");
    assert.ok(out.caption.startsWith("Budget meal prep saved me $400"));
    assert.ok(!out.hashtags.includes("Shorts"), "generic must NOT get #Shorts");
    assert.ok(out.caption.length <= PLATFORM_RULES.generic.maxCaptionChars);

    // score: a strong generic caption passes the required checks via the generic rule.
    const { score, checks } = scoreCaption(out.caption, out.hashtags, "generic");
    const byId = (id: string) => checks.find((c) => c.id === id)!;
    assert.equal(byId("keyword-front").pass, true);
    assert.equal(byId("comment-cta").pass, true);
    assert.equal(byId("hashtag-count").pass, true); // 3 tags ∈ [2,5]
    assert.equal(byId("length-cap").pass, true);
    assert.ok(score >= 80, `expected high generic score, got ${score}`);
  });

  await check("generateCaptions accepts 'generic' (not filtered out)", async () => {
    const mock = async () =>
      JSON.stringify({
        platforms: {
          generic: { firstLineHook: "Gen hook", caption: "Gen hook\nbody — thoughts?", hashtags: ["foo", "bar"] },
        },
      });
    const res = await generateCaptions("a brief", ["generic"], mock);
    assert.ok("generic" in res, "generic must be generated, not filtered");
    assert.equal(res.generic.firstLineHook, "Gen hook");
  });

  await check("transcript flows into the caption prompt + supersedes the brief", async () => {
    let seenSystem = "";
    let seenUser = "";
    const mock = async (system: string, user: string) => {
      seenSystem = system;
      seenUser = user;
      return JSON.stringify({ platforms: { tiktok: { firstLineHook: "h", caption: "h\nb?", hashtags: ["fyp"] } } });
    };
    const transcript = "I tested three budget espresso machines and one shocked me.";
    await generateCaptions("a generic brief", ["tiktok"], { transcript, generate: mock });
    assert.match(seenUser, /Video transcript/);
    assert.ok(seenUser.includes(transcript), "transcript text must be in the user prompt");
    assert.match(seenUser, /supplementary context only/);
    assert.match(seenSystem, /TRANSCRIPT of what is ACTUALLY SAID/);
  });

  await check("no transcript → prompt behaves as before (brief only)", async () => {
    let seenUser = "";
    let seenSystem = "";
    const mock = async (system: string, user: string) => {
      seenSystem = system;
      seenUser = user;
      return JSON.stringify({ platforms: { tiktok: { firstLineHook: "h", caption: "h\nb?", hashtags: ["fyp"] } } });
    };
    await generateCaptions("just a brief", ["tiktok"], { generate: mock });
    assert.doesNotMatch(seenUser, /Video transcript/);
    assert.doesNotMatch(seenSystem, /TRANSCRIPT of what is ACTUALLY SAID/);
    assert.match(seenUser, /Video brief \/ topic: just a brief/);
  });

  await check("a very long transcript is clipped before going to the model", async () => {
    let seenUser = "";
    const mock = async (_s: string, user: string) => {
      seenUser = user;
      return JSON.stringify({ platforms: { tiktok: { firstLineHook: "h", caption: "h\nb?", hashtags: ["fyp"] } } });
    };
    const huge = "word ".repeat(5000); // ~25k chars
    await generateCaptions("", ["tiktok"], { transcript: huge, generate: mock });
    // The user prompt also contains some scaffolding, so allow a small margin.
    assert.ok(
      seenUser.length <= MAX_TRANSCRIPT_PROMPT_CHARS + 500,
      `expected clipped prompt, got ${seenUser.length} chars`,
    );
  });

  await check("legacy positional generate fn still works (backward-compat)", async () => {
    const mock = async () =>
      JSON.stringify({ platforms: { tiktok: { firstLineHook: "TT", caption: "TT\nbody?", hashtags: ["fyp"] } } });
    const res = await generateCaptions("brief", ["tiktok"], mock);
    assert.equal(res.tiktok.firstLineHook, "TT");
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
