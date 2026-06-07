/**
 * Unit checks for the PROVIDER-AWARE Bulk Scheduler glue (postiz/bulkScheduler +
 * postiz/fileSources), all against a MOCKED fetch (no network, no real keys):
 *   - resolvePublicSourceUrl: render/upload use PUBLIC_BASE_URL; cloud is public;
 *     unset PUBLIC_BASE_URL fails LOUDLY (PublicUrlUnavailableError) for renders.
 *   - channel UNION: status/listChannels merge Postiz integrations + PostPeer
 *     TikTok accounts, each tagged with its provider; graceful DEGRADATION when
 *     only one provider's key is configured, and per-provider status booleans.
 *   - schedule() ROUTES each item by its channel's provider: postiz → Postiz API
 *     (internal upload URL), postpeer → PostPeer API (PUBLIC media URL + TikTok
 *     fields). Failures in one provider never lose the other's items.
 *
 * Run:
 *   cd lab/server && npx tsx src/scripts/bulk-providers.test.ts
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

interface Captured { url: string; method: string; body: any }
/**
 * Route mocked fetch by URL host: any postiz upload → {id,path}; any postiz
 * /posts → {}; any postpeer integrations → accounts; any postpeer /posts → {}.
 * Each call is recorded so tests can assert routing + payloads.
 */
function installRoutedFetch(opts: {
  postizIntegrations?: unknown[];
  postpeerAccounts?: unknown[];
  failPostizPosts?: boolean;
}): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: unknown, init?: any) => {
    const u = String(url);
    let body: any = undefined;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    calls.push({ url: u, method: init?.method ?? "GET", body });
    const json = (v: unknown, ok = true, status = 200): Response =>
      ({ ok, status, text: async () => JSON.stringify(v) } as Response);
    // Anthropic Messages API (caption generation in preview): respond with a
    // valid caption JSON for whatever platforms were asked for, in the SDK's
    // content[].text shape. Keyed on the user message listing the platforms.
    const anthropic = (): Response => {
      const platforms: string[] = String(body?.messages?.[0]?.content ?? "").includes("generic")
        ? ["generic"]
        : ["tiktok"];
      const caps: Record<string, unknown> = {};
      for (const p of platforms) {
        caps[p] = {
          firstLineHook: "Budget meal prep saved me $400",
          caption: "Budget meal prep saved me $400 this month — here's the full plan.\nWhich one should I make next?",
          hashtags: ["mealprep", "budgetmealprepideas", "food"],
        };
      }
      const text = JSON.stringify({ platforms: caps });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }], usage: {} }) } as unknown as Response;
    };

    if (u.includes("/v1/messages")) return anthropic();
    if (u.includes("/public/v1/integrations")) return json(opts.postizIntegrations ?? []);
    if (u.includes("/public/v1/upload-from-url")) return json({ id: "up1", path: "http://internal/x.mp4" });
    if (u.includes("/public/v1/upload")) return json({ id: "up1", path: "https://postiz.test/uploads/v.mp4" });
    if (u.includes("/public/v1/posts")) {
      if (opts.failPostizPosts) return json({ message: "boom" }, false, 400);
      return json({ id: "postiz-post" });
    }
    if (u.includes("/v1/connect/integrations")) return json(opts.postpeerAccounts ?? []);
    if (u.includes("/v1/posts")) return json({ success: true });
    throw new Error(`unexpected fetch to ${u}`);
  }) as typeof fetch;
  return { calls };
}

async function main() {
  // Pin both providers' base URLs + keys + the public/internal origins.
  process.env.POSTIZ_API_KEY = "postiz-key";
  process.env.POSTIZ_INTERNAL_URL = "http://postiz:5000";
  process.env.POSTPEER_API_KEY = "postpeer-key";
  process.env.POSTPEER_BASE_URL = "https://api.postpeer.test";
  process.env.CLIPMAGIC_INTERNAL_URL = "http://clipmagic-lab:9090";
  process.env.PUBLIC_BASE_URL = "https://clips.example.com";
  // Caption generation needs an Anthropic credential; the routed mock answers it.
  process.env.ANTHROPIC_API_KEY = "anthropic-key";

  const fileSources = await import("../postiz/fileSources.js");
  const bulk = await import("../postiz/bulkScheduler.js");

  // ── public-vs-internal URL selection ──────────────────────────────────────
  await check("resolvePublicSourceUrl uses PUBLIC_BASE_URL for renders (not the internal name)", () => {
    const url = fileSources.resolvePublicSourceUrl({ kind: "render", ref: "my clip.mp4" });
    assert.equal(url, "https://clips.example.com/api/outputs/my%20clip.mp4");
    assert.ok(!url.includes("clipmagic-lab"), "external URL must not be the Docker-internal host");
  });

  await check("resolvePublicSourceUrl uses PUBLIC_BASE_URL for uploads", () => {
    const url = fileSources.resolvePublicSourceUrl({ kind: "upload", ref: "abc123" });
    assert.equal(url, "https://clips.example.com/api/uploads/abc123");
  });

  await check("resolvePublicSourceUrl leaves a cloud share link public/normalized", () => {
    const url = fileSources.resolvePublicSourceUrl({ kind: "cloud", ref: "https://www.dropbox.com/s/x/v.mp4?dl=0" });
    assert.ok(url.includes("dl=1"), "dropbox link should be forced to dl=1");
  });

  await check("internal resolveSourceUrl still uses the Docker-internal host (Postiz path unchanged)", () => {
    const url = fileSources.resolveSourceUrl({ kind: "render", ref: "v.mp4" });
    assert.ok(url.startsWith("http://clipmagic-lab:9090/api/outputs/"), `got ${url}`);
  });

  await check("resolvePublicSourceUrl FAILS LOUDLY for a render when PUBLIC_BASE_URL is unset", () => {
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    try {
      assert.throws(
        () => fileSources.resolvePublicSourceUrl({ kind: "render", ref: "v.mp4" }),
        (e: unknown) => e instanceof fileSources.PublicUrlUnavailableError && /PUBLIC_BASE_URL/.test((e as Error).message),
      );
    } finally {
      process.env.PUBLIC_BASE_URL = saved;
    }
  });

  // ── channel union ──────────────────────────────────────────────────────────
  await check("listChannels UNIONs Postiz integrations + PostPeer TikTok accounts, tagged by provider", async () => {
    installRoutedFetch({
      postizIntegrations: [{ id: "pz-tt", name: "PZ TikTok", identifier: "tiktok" }, { id: "pz-yt", name: "PZ YT", identifier: "youtube" }],
      postpeerAccounts: [{ id: "pp-tt", platform: "tiktok", name: "PP TikTok" }, { id: "pp-yt", platform: "youtube" }],
    });
    const channels = await bulk.listChannels();
    const byId = new Map(channels.map((c) => [c.id, c]));
    assert.equal(byId.get("pz-tt")?.provider, "postiz");
    assert.equal(byId.get("pz-yt")?.provider, "postiz");
    assert.equal(byId.get("pp-tt")?.provider, "postpeer");
    // PostPeer accounts are filtered to TikTok only.
    assert.ok(!byId.has("pp-yt"), "non-TikTok PostPeer accounts must be dropped");
    assert.equal(byId.get("pp-tt")?.platform, "tiktok");
  });

  await check("status reports per-provider configured booleans + channel counts", async () => {
    installRoutedFetch({ postizIntegrations: [{ id: "pz-tt", name: "x", identifier: "tiktok" }], postpeerAccounts: [{ id: "pp-tt", platform: "tiktok" }] });
    const s = await bulk.getStatus();
    assert.equal(s.providers.postiz.configured, true);
    assert.equal(s.providers.postpeer.configured, true);
    assert.equal(s.providers.postiz.channelCount, 1);
    assert.equal(s.providers.postpeer.channelCount, 1);
    assert.equal(s.channelCount, 2);
    assert.equal(s.apiKeyConfigured, true);
  });

  await check("graceful DEGRADATION: only PostPeer configured → only PostPeer channels", async () => {
    const savedPostiz = process.env.POSTIZ_API_KEY;
    delete process.env.POSTIZ_API_KEY;
    try {
      installRoutedFetch({ postpeerAccounts: [{ id: "pp-tt", platform: "tiktok" }] });
      const s = await bulk.getStatus();
      assert.equal(s.providers.postiz.configured, false);
      assert.equal(s.providers.postiz.channelCount, 0);
      assert.equal(s.providers.postpeer.configured, true);
      assert.equal(s.channels.length, 1);
      assert.equal(s.channels[0].provider, "postpeer");
    } finally {
      process.env.POSTIZ_API_KEY = savedPostiz;
    }
  });

  // ── routing in schedule() ──────────────────────────────────────────────────
  // These exercise PROVIDER ROUTING, not the Growth gate, so the (deliberately
  // minimal) captions carry override:true to skip the gate and reach the provider.
  // Media bytes are injected (stubMedia) so the schedule path needs no real file.
  const stubMedia = async () => ({ data: Buffer.from("vid"), filename: "v.mp4", contentType: "video/mp4" });
  await check("schedule() ROUTES per provider: postiz→Postiz(bytes upload), postpeer→PostPeer(public URL)", async () => {
    const mock = installRoutedFetch({});
    const out = await bulk.schedule({
      posts: [
        {
          fileId: "f1", source: { kind: "render", ref: "v.mp4" }, channelId: "pz-tt",
          provider: "postiz", identifier: "tiktok", caption: "c1", hashtags: ["a"], scheduledAt: "2026-06-09T13:00:00.000Z", override: true,
        },
        {
          fileId: "f1", source: { kind: "render", ref: "v.mp4" }, channelId: "pp-tt",
          provider: "postpeer", identifier: "tiktok", caption: "c2", hashtags: ["b"], scheduledAt: "2026-06-09T13:05:00.000Z", override: true,
          tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContent: false },
        },
      ],
    }, { loadMedia: stubMedia });
    assert.equal(out.scheduled, 2);
    assert.equal(out.failed, 0);

    // Postiz: a multipart byte /upload (NOT upload-from-url) + a /public/v1/posts.
    assert.ok(mock.calls.some((c) => c.url === "http://postiz:5000/public/v1/upload"), "postiz byte upload missing");
    assert.ok(!mock.calls.some((c) => c.url.includes("/upload-from-url")), "must NOT use upload-from-url (Postiz rejects internal URLs)");
    const postizPost = mock.calls.find((c) => c.url === "http://postiz:5000/public/v1/posts")!;
    assert.ok(postizPost, "postiz createPost missing");
    // Postiz requires the image to carry BOTH id and path.
    const img = postizPost.body.posts[0].value[0].image[0];
    assert.equal(img.id, "up1");
    assert.equal(img.path, "https://postiz.test/uploads/v.mp4");

    // PostPeer: a /v1/posts reusing the PUBLIC Postiz upload URL (no public lab needed).
    const ppPost = mock.calls.find((c) => c.url === "https://api.postpeer.test/v1/posts")!;
    assert.equal(ppPost.body.mediaItems[0].url, "https://postiz.test/uploads/v.mp4");
    assert.equal(ppPost.body.platforms[0].platform, "tiktok");
    assert.equal(ppPost.body.platforms[0].accountId, "pp-tt");
    assert.equal(ppPost.body.platforms[0].platformSpecificData.privacyLevel, "PUBLIC_TO_EVERYONE");
  });

  await check("schedule() never loses an item: a Postiz failure leaves PostPeer success intact", async () => {
    installRoutedFetch({ failPostizPosts: true });
    const out = await bulk.schedule({
      posts: [
        { fileId: "f1", source: { kind: "render", ref: "v.mp4" }, channelId: "pz-tt", provider: "postiz", identifier: "tiktok", caption: "c", hashtags: [], scheduledAt: "2026-06-09T13:00:00.000Z", override: true },
        { fileId: "f1", source: { kind: "render", ref: "v.mp4" }, channelId: "pp-tt", provider: "postpeer", identifier: "tiktok", caption: "c", hashtags: [], scheduledAt: "2026-06-09T13:05:00.000Z", override: true, tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContent: false } },
      ],
    }, { loadMedia: stubMedia });
    assert.equal(out.results.length, 2, "both items must be reported");
    const pz = out.results.find((r) => r.channelId === "pz-tt")!;
    const pp = out.results.find((r) => r.channelId === "pp-tt")!;
    assert.equal(pz.ok, false);
    assert.equal(pp.ok, true);
  });

  await check("schedule() PostPeer reuses Postiz's public upload URL (works with PUBLIC_BASE_URL unset)", async () => {
    const saved = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL; // render no longer depends on a public lab
    try {
      const mock = installRoutedFetch({});
      const out = await bulk.schedule({
        posts: [
          { fileId: "f1", source: { kind: "render", ref: "v.mp4" }, channelId: "pp-tt", provider: "postpeer", identifier: "tiktok", caption: "c", hashtags: [], scheduledAt: "2026-06-09T13:05:00.000Z", override: true, tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContent: false } },
        ],
      }, { loadMedia: stubMedia });
      assert.equal(out.scheduled, 1, "PostPeer render must succeed via the Postiz public URL");
      const ppPost = mock.calls.find((c) => c.url === "https://api.postpeer.test/v1/posts")!;
      assert.equal(ppPost.body.mediaItems[0].url, "https://postiz.test/uploads/v.mp4");
    } finally {
      process.env.PUBLIC_BASE_URL = saved;
    }
  });

  await check("schedule() PostPeer uses a cloud source's own direct link (no upload)", async () => {
    const mock = installRoutedFetch({});
    const out = await bulk.schedule({
      posts: [
        { fileId: "fc", source: { kind: "cloud", ref: "https://www.dropbox.com/s/x/v.mp4?dl=0" }, channelId: "pp-tt", provider: "postpeer", identifier: "tiktok", caption: "c", hashtags: [], scheduledAt: "2026-06-09T13:05:00.000Z", override: true, tiktok: { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, commercialContent: false } },
      ],
    }, { loadMedia: stubMedia });
    assert.equal(out.scheduled, 1);
    const ppPost = mock.calls.find((c) => c.url === "https://api.postpeer.test/v1/posts")!;
    assert.match(ppPost.body.mediaItems[0].url, /dl=1/, "cloud link normalized to a direct download");
  });

  // ── generic ("facebook") platform support ───────────────────────────────────
  await check("preview() includes a null-platform channel as a GENERIC target (not skipped)", async () => {
    installRoutedFetch({
      // A Facebook Page → identifier "facebook" → canonical platform null.
      postizIntegrations: [{ id: "pz-fb", name: "My FB Page", identifier: "facebook" }],
    });
    const out = await bulk.preview({
      files: [{ source: { kind: "cloud", ref: "https://www.dropbox.com/s/x/clip.mp4?dl=0" }, fileId: "f1", brief: "budget meal prep" }],
      channelIds: ["pz-fb"],
      now: "2026-06-08T12:00:00.000Z",
    });
    // NOT skipped, and produces exactly one preview row for the generic channel.
    assert.equal(out.skippedChannels.length, 0, "facebook channel must not be skipped");
    assert.equal(out.posts.length, 1);
    const row = out.posts[0];
    assert.equal(row.channelId, "pz-fb");
    assert.equal(row.provider, "postiz");
    assert.equal(row.platform, "generic");
    assert.ok(row.caption.length > 0, "generic row must carry a caption");
    assert.ok(row.scheduledAt && new Date(row.scheduledAt).getTime() > Date.now() - 1, "generic row must have a future schedule time");
    // It still shows a computed Growth Score (advisory) but is never blocked.
    assert.equal(typeof row.growth.score, "number");
  });

  await check("schedule() posts a GENERIC Postiz channel and does NOT gate it", async () => {
    const mock = installRoutedFetch({});
    const out = await bulk.schedule({
      posts: [
        {
          fileId: "f1", source: { kind: "render", ref: "v.mp4" }, channelId: "pz-fb",
          provider: "postiz", identifier: "facebook",
          // A deliberately weak caption (no CTA, 1 tag): for tiktok this would be
          // GATED, but generic is advisory-only → it must NOT be blocked.
          caption: "Just a plain caption.", hashtags: ["one"],
          scheduledAt: "2026-06-09T13:00:00.000Z",
        },
      ],
    }, { loadMedia: stubMedia });
    assert.equal(out.scheduled, 1, "generic post must succeed");
    assert.equal(out.failed, 0);
    assert.doesNotMatch(out.results[0].error ?? "", /Growth Guardrails/);
    // The Postiz create-post must carry the caption + settings.__type = "facebook".
    const post = mock.calls.find((c) => c.url === "http://postiz:5000/public/v1/posts")!;
    const channel = post.body.posts[0];
    assert.equal(channel.settings.__type, "facebook");
    assert.ok(String(channel.value[0].content).includes("Just a plain caption"));
    assert.equal(channel.settings.title, undefined, "generic must NOT get a YouTube title");
  });

  console.log(`\n${passed} checks passed`);
}

void main();
