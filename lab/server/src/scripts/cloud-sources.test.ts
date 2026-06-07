/**
 * Unit checks for the cloud FOLDER browser (postiz/cloudSources) — request
 * SHAPING + parsing only, against a MOCKED fetch (no network, no real keys):
 *   - Drive folder-id extraction (URL + raw id forms)
 *   - Drive list parse → cloud sources with the usercontent confirm=t direct URL
 *   - Dropbox token mint + in-memory cache (one /oauth2/token call across listings)
 *   - Dropbox list parse (video filter) + get_temporary_link resolution → ref
 *   - listCloudFolder provider routing + missing-credential errors
 *
 * Run:
 *   cd lab/server && npx tsx src/scripts/cloud-sources.test.ts
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

/** A captured fetch call. */
interface Captured { url: string; method: string; headers: Record<string, string>; body: unknown }

/**
 * Route mock fetch by URL substring → { status, json }. Records every call so
 * tests can assert on the shaped requests.
 */
function installRouter(routes: Array<{ match: string; status?: number; json: unknown }>): { calls: Captured[] } {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: unknown, init?: any) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url: u, method: init?.method ?? "GET", headers, body });
    const route = routes.find((r) => u.includes(r.match));
    if (!route) throw new Error(`no mock route for ${u}`);
    return {
      ok: (route.status ?? 200) >= 200 && (route.status ?? 200) < 300,
      status: route.status ?? 200,
      text: async () => JSON.stringify(route.json),
    } as Response;
  }) as typeof fetch;
  return { calls };
}

async function main() {
  // Fresh temp data/config dirs so the store getters can read env-injected keys
  // without touching real lab data. We drive credentials via env (the getters
  // prefer env over the store).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-cloud-test-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-cloud-cfg-"));
  process.env.DATA_DIR = root;
  process.env.POSTIZ_CONFIG_DIR = configDir;
  process.env.DOCKER_SOCKET = path.join(configDir, "nonexistent.sock");

  const mod = await import("../postiz/cloudSources.js");
  const {
    listCloudFolder,
    extractDriveFolderId,
    driveDirectUrl,
    cloudProvidersConfigured,
    _resetDropboxTokenCache,
  } = mod;

  // ── Drive folder-id extraction ───────────────────────────────────────────────
  await check("extractDriveFolderId pulls the id from a /folders/<id> URL", () => {
    assert.equal(
      extractDriveFolderId("https://drive.google.com/drive/folders/1AbC_def-123?usp=sharing"),
      "1AbC_def-123",
    );
  });
  await check("extractDriveFolderId accepts open?id=<id> and a bare id", () => {
    assert.equal(extractDriveFolderId("https://drive.google.com/open?id=ZZZ9999xxxx"), "ZZZ9999xxxx");
    assert.equal(extractDriveFolderId("1234567890abcdef"), "1234567890abcdef");
  });
  await check("extractDriveFolderId rejects junk", () => {
    assert.equal(extractDriveFolderId(""), null);
    assert.equal(extractDriveFolderId("not a folder"), null);
  });

  await check("driveDirectUrl uses the usercontent.google.com download host with confirm=t", () => {
    const u = driveDirectUrl("FILEID1");
    assert.ok(u.startsWith("https://drive.usercontent.google.com/download?"), u);
    assert.ok(u.includes("id=FILEID1"));
    assert.ok(u.includes("export=download"));
    assert.ok(u.includes("confirm=t"));
  });

  // ── Drive listing ────────────────────────────────────────────────────────────
  await check("cloudProvidersConfigured: gdrive false without a key", () => {
    delete process.env.GOOGLE_DRIVE_API_KEY;
    assert.equal(cloudProvidersConfigured().gdrive, false);
  });

  await check("listCloudFolder(gdrive) errors clearly when the key is missing", async () => {
    delete process.env.GOOGLE_DRIVE_API_KEY;
    await assert.rejects(
      () => listCloudFolder("gdrive", "https://drive.google.com/drive/folders/abc1234567"),
      /API key not configured/i,
    );
  });

  await check("listCloudFolder(gdrive) lists videos → cloud sources w/ direct URLs", async () => {
    process.env.GOOGLE_DRIVE_API_KEY = "drive-key-xyz";
    const mock = installRouter([
      {
        match: "googleapis.com/drive/v3/files",
        json: {
          files: [
            { id: "v1", name: "clip-one.mp4", mimeType: "video/mp4", thumbnailLink: "http://t/1.jpg", size: "12345" },
            { id: "v2", name: "clip-two.mov", mimeType: "video/quicktime", thumbnailLink: "http://t/2.jpg" },
          ],
        },
      },
    ]);
    const items = await listCloudFolder("gdrive", "https://drive.google.com/drive/folders/FОLDER123456");
    // request shape: key used only for listing, folder id + video filter in q.
    const call = mock.calls[0];
    assert.equal(call.method, "GET");
    assert.ok(call.url.includes("key=drive-key-xyz"));
    // Parse the q param robustly (URLSearchParams encodes spaces as +).
    const q = new URL(call.url).searchParams.get("q") ?? "";
    assert.ok(q.includes("in parents"), `q missing 'in parents': ${q}`);
    assert.ok(q.includes("mimeType contains 'video/'"), `q missing video filter: ${q}`);
    assert.ok(q.includes("trashed=false"), `q missing trashed filter: ${q}`);
    // parsed items → cloud sources with the confirm=t direct URL as the ref.
    assert.equal(items.length, 2);
    assert.equal(items[0].id, "v1");
    assert.equal(items[0].name, "clip-one.mp4");
    assert.equal(items[0].thumbnailUrl, "http://t/1.jpg");
    assert.equal(items[0].sizeBytes, 12345);
    assert.equal(items[0].source.kind, "cloud");
    assert.equal(items[0].source.ref, driveDirectUrl("v1"));
    assert.ok(items[0].source.ref.includes("confirm=t"));
  });

  await check("listCloudFolder(gdrive) maps a private folder to a 'not shared' error", async () => {
    process.env.GOOGLE_DRIVE_API_KEY = "drive-key-xyz";
    installRouter([{ match: "googleapis.com/drive/v3/files", status: 404, json: { error: { message: "File not found" } } }]);
    await assert.rejects(
      () => listCloudFolder("gdrive", "abc1234567"),
      /not shared 'anyone with the link'/i,
    );
  });

  // ── Dropbox ──────────────────────────────────────────────────────────────────
  await check("cloudProvidersConfigured: dropbox needs all three creds", () => {
    delete process.env.DROPBOX_APP_KEY;
    delete process.env.DROPBOX_APP_SECRET;
    delete process.env.DROPBOX_REFRESH_TOKEN;
    assert.equal(cloudProvidersConfigured().dropbox, false);
    process.env.DROPBOX_APP_KEY = "ak";
    assert.equal(cloudProvidersConfigured().dropbox, false, "partial creds must not count");
  });

  await check("listCloudFolder(dropbox) errors clearly when creds are missing", async () => {
    delete process.env.DROPBOX_APP_KEY;
    delete process.env.DROPBOX_APP_SECRET;
    delete process.env.DROPBOX_REFRESH_TOKEN;
    await assert.rejects(() => listCloudFolder("dropbox", "/Videos"), /Dropbox isn't configured/i);
  });

  await check("listCloudFolder(dropbox): token mint (Basic) + list + temp links → refs", async () => {
    process.env.DROPBOX_APP_KEY = "app-key";
    process.env.DROPBOX_APP_SECRET = "app-secret";
    process.env.DROPBOX_REFRESH_TOKEN = "refresh-123";
    _resetDropboxTokenCache();
    const mock = installRouter([
      { match: "api.dropbox.com/oauth2/token", json: { access_token: "acc-tok-1", expires_in: 14400 } },
      {
        match: "files/list_folder",
        json: {
          entries: [
            { ".tag": "file", name: "a.mp4", path_lower: "/videos/a.mp4", size: 100 },
            { ".tag": "file", name: "notes.txt", path_lower: "/videos/notes.txt", size: 5 },
            { ".tag": "folder", name: "sub", path_lower: "/videos/sub" },
          ],
          has_more: false,
        },
      },
      { match: "files/get_temporary_link", json: { link: "https://dl.dropboxusercontent.test/a.mp4?t=tok" } },
    ]);
    const items = await listCloudFolder("dropbox", "Videos");
    // token mint: Basic auth header, refresh_token grant.
    const tokenCall = mock.calls.find((c) => c.url.includes("oauth2/token"))!;
    assert.ok(tokenCall.headers["authorization"].startsWith("Basic "));
    assert.equal(
      tokenCall.headers["authorization"],
      `Basic ${Buffer.from("app-key:app-secret").toString("base64")}`,
    );
    assert.ok(String(tokenCall.body).includes("grant_type=refresh_token") || (tokenCall.body as any) === undefined);
    // list_folder uses the normalized path with Bearer token.
    const listCall = mock.calls.find((c) => c.url.includes("files/list_folder"))!;
    assert.equal(listCall.headers["authorization"], "Bearer acc-tok-1");
    assert.equal((listCall.body as any).path, "/Videos");
    // only the video file survives the filter → 1 item, ref = temporary link.
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "/videos/a.mp4");
    assert.equal(items[0].name, "a.mp4");
    assert.equal(items[0].sizeBytes, 100);
    assert.equal(items[0].source.kind, "cloud");
    assert.equal(items[0].source.ref, "https://dl.dropboxusercontent.test/a.mp4?t=tok");
  });

  await check("Dropbox access token is CACHED in-memory (no second token mint)", async () => {
    process.env.DROPBOX_APP_KEY = "app-key";
    process.env.DROPBOX_APP_SECRET = "app-secret";
    process.env.DROPBOX_REFRESH_TOKEN = "refresh-123";
    _resetDropboxTokenCache();
    // First listing mints a token.
    let mock = installRouter([
      { match: "api.dropbox.com/oauth2/token", json: { access_token: "acc-tok-A", expires_in: 14400 } },
      { match: "files/list_folder", json: { entries: [], has_more: false } },
    ]);
    await listCloudFolder("dropbox", "/Empty");
    assert.equal(mock.calls.filter((c) => c.url.includes("oauth2/token")).length, 1);
    // Second listing reuses the cached token → NO new /oauth2/token call.
    mock = installRouter([
      { match: "files/list_folder", json: { entries: [], has_more: false } },
    ]);
    await listCloudFolder("dropbox", "/Empty2");
    assert.equal(mock.calls.filter((c) => c.url.includes("oauth2/token")).length, 0);
    const listCall = mock.calls.find((c) => c.url.includes("files/list_folder"))!;
    assert.equal(listCall.headers["authorization"], "Bearer acc-tok-A");
  });

  // ── routing ──────────────────────────────────────────────────────────────────
  await check("listCloudFolder rejects an unknown provider", async () => {
    await assert.rejects(() => listCloudFolder("onedrive", "/x"), /Unknown cloud provider/i);
  });

  // cleanup
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });

  console.log(`\n${passed} checks passed`);
}

void main();
