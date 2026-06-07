/**
 * Unit checks for the PostPeer client (postiz/postpeerClient) — request SHAPING
 * only, against a MOCKED fetch (no network, no real key):
 *   - base URL + x-access-key auth header
 *   - listAccounts() parses + filters; tolerates field-name aliases / { data }
 *   - createPost() emits content + mediaItems[video] + platforms[tiktok] with the
 *     TikTok platformSpecificData, and routes scheduledAt → scheduledFor (UTC)
 *     vs publishNow vs draft
 *
 * Run:
 *   cd lab/server && npx tsx src/scripts/bulk-postpeer.test.ts
 */
import assert from "node:assert/strict";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

/** Capture the args of the most recent fetch + return a canned JSON response. */
interface Captured { url: string; method: string; headers: Record<string, string>; body: unknown }
function installMockFetch(response: unknown): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: unknown, init?: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url: String(url), method: init?.method ?? "GET", headers, body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(response),
    } as Response;
  }) as typeof fetch;
  return { calls };
}

async function main() {
  // A real key in the env so authHeaders() resolves without the store.
  process.env.POSTPEER_API_KEY = "pp-test-key-123";
  process.env.POSTPEER_BASE_URL = "https://api.postpeer.test";

  const { createPostPeerClient, buildTikTokPlatformData } = await import("../postiz/postpeerClient.js");

  await check("listAccounts() hits /v1/connect/integrations with x-access-key", async () => {
    const mock = installMockFetch([
      { id: "tt1", platform: "tiktok", username: "creator", displayName: "Creator", avatarUrl: "http://a/x.png" },
      { id: "yt1", platform: "youtube" },
    ]);
    const accounts = await createPostPeerClient().listAccounts();
    const call = mock.calls[0];
    assert.equal(call.method, "GET");
    assert.equal(call.url, "https://api.postpeer.test/v1/connect/integrations");
    assert.equal(call.headers["x-access-key"], "pp-test-key-123");
    assert.ok(!("authorization" in call.headers), "must not send a Bearer/Authorization header");
    // Both accounts parse; caller filters to TikTok (bulkScheduler does that).
    assert.equal(accounts.length, 2);
    const tt = accounts.find((a) => a.id === "tt1")!;
    assert.equal(tt.platform, "tiktok");
    assert.equal(tt.name, "Creator");
    assert.equal(tt.username, "creator");
    assert.equal(tt.picture, "http://a/x.png");
  });

  await check("listAccounts() tolerates a { data: [...] } envelope + handle/name aliases", async () => {
    installMockFetch({ data: [{ accountId: "tt2", platform: "TikTok", handle: "h", name: "N", picture: "p" }] });
    const accounts = await createPostPeerClient().listAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, "tt2");
    assert.equal(accounts[0].platform, "tiktok"); // lower-cased
    assert.equal(accounts[0].username, "h");
    assert.equal(accounts[0].name, "N");
  });

  await check("createPost() schedules: content + video mediaItem + tiktok platform data + scheduledFor(UTC)", async () => {
    const mock = installMockFetch({ success: true, postId: "p1" });
    await createPostPeerClient().createPost({
      accountId: "tt1",
      mediaUrl: "https://cdn.example.com/v.mp4",
      caption: "hello #a",
      scheduledAt: "2026-06-09T13:00:00.000Z",
      tiktok: {
        privacyLevel: "PUBLIC_TO_EVERYONE",
        allowComment: true,
        allowDuet: false,
        allowStitch: true,
        commercialContent: false,
      },
    });
    const call = mock.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, "https://api.postpeer.test/v1/posts");
    assert.equal(call.headers["x-access-key"], "pp-test-key-123");
    const b = call.body as any;
    assert.equal(b.content, "hello #a");
    assert.deepEqual(b.mediaItems, [{ type: "video", url: "https://cdn.example.com/v.mp4" }]);
    assert.equal(b.platforms.length, 1);
    assert.equal(b.platforms[0].platform, "tiktok");
    assert.equal(b.platforms[0].accountId, "tt1");
    assert.deepEqual(b.platforms[0].platformSpecificData, {
      privacyLevel: "PUBLIC_TO_EVERYONE",
      allowComment: true,
      allowDuet: false,
      allowStitch: true,
      commercialContent: false,
    });
    // Scheduling fields, no publishNow.
    assert.equal(b.scheduledFor, "2026-06-09T13:00:00.000Z");
    assert.equal(b.timezone, "UTC");
    assert.ok(!("publishNow" in b), "scheduled post must not also set publishNow");
    assert.ok(!("draft" in b));
  });

  await check("createPost() publishes now when no scheduledAt", async () => {
    const mock = installMockFetch({ success: true });
    await createPostPeerClient().createPost({
      accountId: "tt1",
      mediaUrl: "u",
      caption: "c",
      tiktok: buildTikTokDefaults(),
    });
    const b = mock.calls[0].body as any;
    assert.equal(b.publishNow, true);
    assert.ok(!("scheduledFor" in b));
  });

  await check("createPost() draft:true overrides scheduling", async () => {
    const mock = installMockFetch({ success: true });
    await createPostPeerClient().createPost({
      accountId: "tt1",
      mediaUrl: "u",
      caption: "c",
      scheduledAt: "2026-06-09T13:00:00.000Z",
      draft: true,
      tiktok: buildTikTokDefaults(),
    });
    const b = mock.calls[0].body as any;
    assert.equal(b.draft, true);
    assert.ok(!("scheduledFor" in b), "draft must not also schedule");
    assert.ok(!("publishNow" in b));
  });

  await check("buildTikTokPlatformData() maps the documented TikTok option keys", () => {
    const data = buildTikTokPlatformData({
      privacyLevel: "SELF_ONLY",
      allowComment: false,
      allowDuet: true,
      allowStitch: false,
      commercialContent: true,
    });
    assert.deepEqual(data, {
      privacyLevel: "SELF_ONLY",
      allowComment: false,
      allowDuet: true,
      allowStitch: false,
      commercialContent: true,
    });
  });

  console.log(`\n${passed} checks passed`);
}

function buildTikTokDefaults() {
  return {
    privacyLevel: "PUBLIC_TO_EVERYONE",
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    commercialContent: false,
  };
}

void main();
