/**
 * Unit checks for the pure parts of Storage management (zite/storage):
 *   - dirStats()      recursive size + count (nested dirs, symlink-safe)
 *   - resolveSafe()   accepts the new cache areas, still rejects traversal/escape/db
 *   - deleteStorageFiles() / deleteStorageArea() freed-byte accounting
 *   - readDiskUsage() statfs free-space shape
 *
 * Runs against a throwaway DATA_DIR so importing storage.ts (which opens the
 * sqlite db via db/index) never touches real lab data. Run:
 *   cd lab/server && npx tsx src/scripts/storage.test.ts
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
  // Point every data path at a fresh temp dir BEFORE importing config/storage.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-storage-test-"));
  process.env.DATA_DIR = root;
  const dataDir = path.resolve(root);
  const uploadsDir = path.join(dataDir, "uploads");
  const outputsDir = path.join(dataDir, "outputs");
  const tmpDir = path.join(dataDir, "tmp");
  const stickersDir = path.join(outputsDir, "stickers");
  const chunkedDir = path.join(tmpDir, "chunked-uploads");
  const chromiumDir = path.join(dataDir, ".remotion-chromium");

  const storage = await import("../zite/storage.js");
  const { dirStats, resolveSafe, deleteStorageFiles, deleteStorageArea, readDiskUsage } = storage as any;

  const write = (p: string, bytes: number) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(bytes, 0x61));
  };

  // ── dirStats ───────────────────────────────────────────────────────────────
  await check("dirStats: recurses nested dirs, sums bytes + counts files", () => {
    const base = path.join(stickersDir, "_ds");
    write(path.join(base, "a.png"), 100);
    write(path.join(base, "sub/b.png"), 50);
    write(path.join(base, "sub/deep/c.png"), 25);
    const s = dirStats(base);
    assert.equal(s.count, 3);
    assert.equal(s.size, 175);
  });

  await check("dirStats: missing dir → zero", () => {
    const s = dirStats(path.join(dataDir, "does-not-exist"));
    assert.deepEqual(s, { size: 0, count: 0 });
  });

  await check("dirStats: does not follow symlinks (no escape / double-count)", () => {
    const base = path.join(tmpDir, "_sym");
    write(path.join(base, "real.bin"), 200);
    const linkTarget = path.join(dataDir, "outside.bin");
    write(linkTarget, 999);
    try {
      fs.symlinkSync(linkTarget, path.join(base, "link.bin"));
    } catch {
      return; // platform without symlink perms — skip
    }
    const s = dirStats(base);
    assert.equal(s.count, 1, "only the real file counts");
    assert.equal(s.size, 200, "symlinked bytes not counted");
  });

  // ── resolveSafe: accepts every area (original + newly-surfaced) ──────────────
  for (const cat of [
    "uploads", "outputs", "tmp", "stickers", "chunked", "remotionChromium",
    "thumbnails", "thumbnailFonts",
    "thumbnailCharacters", "thumbnailBackgrounds", "thumbnailCutouts", "motionBundle",
    "planner", "imageHistory", "engageBrowser", "skoolBrowser",
  ]) {
    await check(`resolveSafe: accepts a direct child in "${cat}"`, () => {
      const r = resolveSafe(cat, "file.bin");
      assert.ok(typeof r === "string" && r, `expected a path for ${cat}`);
      assert.ok(r!.startsWith(dataDir), "must stay inside the data dir");
    });
  }

  // ── resolveSafe: rejects traversal / escape / db ────────────────────────────
  await check("resolveSafe: rejects '..' traversal", () => {
    assert.equal(resolveSafe("uploads", "../db/clipmagic.db"), null);
    assert.equal(resolveSafe("stickers", "../../db/clipmagic.db"), null);
    assert.equal(resolveSafe("tmp", "../../.."), null);
  });

  await check("resolveSafe: rejects nested subpath (not a direct child)", () => {
    assert.equal(resolveSafe("outputs", "stickers/x.png"), null);
    assert.equal(resolveSafe("tmp", "chunked-uploads/abc/0.part"), null);
  });

  await check("resolveSafe: rejects absolute escape + the db path", () => {
    assert.equal(resolveSafe("uploads", "/etc/passwd"), null);
    assert.equal(resolveSafe("uploads", path.join(dataDir, "db", "clipmagic.db")), null);
    assert.equal(resolveSafe("uploads", ""), null);
    assert.equal(resolveSafe("nope" as any, "x"), null);
  });

  // ── deleteStorageFiles: freed-byte accounting ───────────────────────────────
  await check("deleteStorageFiles: frees exact bytes, skips invalid, reports errors", async () => {
    write(path.join(stickersDir, "del1.png"), 300);
    write(path.join(tmpDir, "del2.bin"), 120);
    const res = await deleteStorageFiles({
      items: [
        { category: "stickers", name: "del1.png" },
        { category: "tmp", name: "del2.bin" },
        { category: "tmp", name: "../escape" }, // rejected by resolveSafe
      ],
    });
    assert.equal(res.deleted, 2);
    assert.equal(res.freed, 420);
    assert.equal(res.errors.length, 1);
    assert.ok(!fs.existsSync(path.join(stickersDir, "del1.png")));
    assert.ok(!fs.existsSync(path.join(tmpDir, "del2.bin")));
  });

  // ── deleteStorageArea: clears cache wholesale, recreates empty dir ───────────
  await check("deleteStorageArea: wipes a cache area + recreates it empty", async () => {
    write(path.join(chunkedDir, "u1/0.part"), 64);
    write(path.join(chunkedDir, "u1/1.part"), 64);
    write(path.join(chunkedDir, "u2/0.part"), 32);
    const before = dirStats(chunkedDir);
    assert.equal(before.size, 160);
    assert.equal(before.count, 3);
    const res = await deleteStorageArea({ category: "chunked" });
    assert.equal(res.freed, 160);
    assert.equal(res.deleted, 3);
    assert.equal(res.errors.length, 0);
    assert.ok(fs.existsSync(chunkedDir), "dir recreated so the app keeps working");
    assert.deepEqual(dirStats(chunkedDir), { size: 0, count: 0 });
  });

  await check("deleteStorageArea: clears the Chromium cache area", async () => {
    write(path.join(chromiumDir, "chrome-headless/chrome.bin"), 500);
    const res = await deleteStorageArea({ category: "remotionChromium" });
    assert.equal(res.freed, 500);
    assert.ok(fs.existsSync(chromiumDir));
  });

  await check("deleteStorageArea: clears a newly-surfaced thumbnail cache area", async () => {
    const charDir = path.join(dataDir, "thumbnail-characters");
    write(path.join(charDir, "c1.png"), 42);
    write(path.join(charDir, "c2.png"), 58);
    const res = await deleteStorageArea({ category: "thumbnailCharacters" });
    assert.equal(res.freed, 100);
    assert.equal(res.deleted, 2);
    assert.ok(fs.existsSync(charDir), "dir recreated so the app keeps working");
    assert.deepEqual(dirStats(charDir), { size: 0, count: 0 });
  });

  await check("deleteStorageArea: clears the motion-graphics bundle (nested)", async () => {
    const bundleDir = path.join(dataDir, "motion-bundle");
    write(path.join(bundleDir, "bundle/index.js"), 300);
    write(path.join(bundleDir, "bundle/assets/x.png"), 200);
    const res = await deleteStorageArea({ category: "motionBundle" });
    assert.equal(res.freed, 500);
    assert.ok(fs.existsSync(bundleDir));
  });

  await check("deleteStorageArea: REFUSES thumbnail RENDERS (content, not cache)", async () => {
    const thumbsDir = path.join(outputsDir, "thumbnails");
    write(path.join(thumbsDir, "keep.png"), 88);
    const r = await deleteStorageArea({ category: "thumbnails" });
    assert.equal(r.freed, 0);
    assert.equal(r.errors.length, 1);
    assert.ok(fs.existsSync(path.join(thumbsDir, "keep.png")), "content untouched");
  });

  await check("deleteStorageArea: REFUSES non-cache areas (uploads/outputs)", async () => {
    write(path.join(uploadsDir, "keep.bin"), 77);
    const r1 = await deleteStorageArea({ category: "uploads" });
    assert.equal(r1.freed, 0);
    assert.equal(r1.errors.length, 1);
    const r2 = await deleteStorageArea({ category: "outputs" });
    assert.equal(r2.errors.length, 1);
    assert.ok(fs.existsSync(path.join(uploadsDir, "keep.bin")), "user content untouched");
  });

  // ── readDiskUsage: statfs free-space shape ──────────────────────────────────
  await check("readDiskUsage: real statfs returns total/free/used with used=total-free", () => {
    const d = readDiskUsage(dataDir);
    if (d === null) return; // platform without statfsSync — acceptable
    assert.ok(d.total > 0 && d.free >= 0);
    assert.ok(d.used >= 0 && d.used <= d.total);
    assert.equal(d.used, d.total - d.free);
  });

  await check("readDiskUsage: mocked statfs computes bytes from blocks*bsize", () => {
    const realStatfs = (fs as any).statfsSync;
    (fs as any).statfsSync = () => ({ bsize: 4096, blocks: 1000, bavail: 250 });
    try {
      const d = readDiskUsage(dataDir);
      assert.deepEqual(d, { total: 4096 * 1000, free: 4096 * 250, used: 4096 * 750 });
    } finally {
      (fs as any).statfsSync = realStatfs;
    }
  });

  await check("readDiskUsage: returns null when statfs throws", () => {
    const realStatfs = (fs as any).statfsSync;
    (fs as any).statfsSync = () => { throw new Error("boom"); };
    try {
      assert.equal(readDiskUsage(dataDir), null);
    } finally {
      (fs as any).statfsSync = realStatfs;
    }
  });

  // ── The invariant that failed before: the cards must equal the volume ───────
  // 21 GB of planner ingests were invisible because no card claimed them and the
  // total was defined as the sum of the cards. Now the total is measured from
  // DATA_DIR and the shortfall lands in `unaccounted`, so an unregistered
  // directory shows up on its own instead of vanishing.
  const { listStorage } = storage as any;

  await check("listStorage: totals.all equals the whole data volume, not the card sum", async () => {
    write(path.join(uploadsDir, "acct.bin"), 1000);
    write(path.join(dataDir, "a-tool-nobody-registered/blob.bin"), 4321);
    const res = await listStorage();
    const volume = dirStats(dataDir);
    assert.equal(res.totals.all, volume.size, "total is measured, not summed");
    const cards = res.areas.reduce((s: number, a: any) => s + a.size, 0);
    assert.equal(cards, volume.size, "cards, including the remainder, add up exactly");
  });

  await check("listStorage: an unregistered directory surfaces as `unaccounted`", async () => {
    const res = await listStorage();
    const other = res.areas.find((a: any) => a.category === "unaccounted");
    assert.ok(other, "the remainder card always exists");
    assert.ok(other.size >= 4321, `unregistered bytes are reported (got ${other.size})`);
    assert.equal(other.group, "system");
    assert.equal(other.cache, false, "never offered as clearable");
  });

  await check("listStorage: planner sessions list as one deletable item each", async () => {
    write(path.join(dataDir, "planner/sessA/video.mp4"), 700);
    write(path.join(dataDir, "planner/sessA/audio.m4a"), 300);
    write(path.join(dataDir, "planner/sessB/video.mp4"), 500);
    const res = await listStorage();
    const area = res.areas.find((a: any) => a.key === "plannerIngests");
    assert.ok(area, "planner is registered");
    assert.equal(area.size, 1500, "sized recursively");
    assert.equal(area.items.length, 2, "one item per session, not one opaque folder");
    const a = area.items.find((i: any) => i.name === "sessA");
    assert.equal(a.size, 1000, "session size is the recursive total");
  });

  await check("deleteStorageFiles: deleting a planner session frees its whole folder", async () => {
    const res = await deleteStorageFiles({ items: [{ category: "planner", name: "sessA" }] });
    assert.equal(res.deleted, 1);
    assert.equal(res.freed, 1000, "recursive bytes, not 0");
    assert.ok(!fs.existsSync(path.join(dataDir, "planner/sessA")));
    assert.ok(fs.existsSync(path.join(dataDir, "planner/sessB")), "other sessions untouched");
  });

  // ── The db is counted but unreachable by every delete path ─────────────────
  await check("db: counted as an area but never deletable", async () => {
    write(path.join(dataDir, "db", "extra.bin"), 64);
    const res = await listStorage();
    const dbArea = res.areas.find((a: any) => a.category === "db");
    assert.ok(dbArea && dbArea.size > 0, "the sqlite dir is counted");
    assert.equal(dbArea.items.length, 0, "never listed file-by-file");
    assert.equal(resolveSafe("db", "clipmagic.db"), null, "no per-file delete");
    assert.equal(resolveSafe("db", "extra.bin"), null);
    const r = await deleteStorageArea({ category: "db" });
    assert.equal(r.freed, 0);
    assert.equal(r.errors.length, 1);
    assert.ok(fs.existsSync(path.join(dataDir, "db", "extra.bin")), "db untouched");
  });

  await check("unaccounted: synthetic area is unreachable by any delete path", async () => {
    assert.equal(resolveSafe("unaccounted", "anything"), null);
    const r = await deleteStorageArea({ category: "unaccounted" });
    assert.equal(r.freed, 0);
    assert.equal(r.errors.length, 1);
  });

  // ── The browser profiles are cache, but clearing one signs you out ──────────
  for (const [cat, dir] of [["engageBrowser", "engage-browser"], ["skoolBrowser", "skool-browser"]] as const) {
    await check(`deleteStorageArea: clears the ${dir} profile`, async () => {
      write(path.join(dataDir, dir, "Default/Cookies"), 250);
      const r = await deleteStorageArea({ category: cat });
      assert.equal(r.freed, 250);
      assert.ok(fs.existsSync(path.join(dataDir, dir)), "dir recreated so the app keeps working");
    });
  }

  await check("browser profiles are flagged danger (clearing signs you out)", async () => {
    const res = await listStorage();
    for (const key of ["engageBrowser", "skoolBrowser"]) {
      const a = res.areas.find((x: any) => x.key === key);
      assert.ok(a, `${key} registered`);
      assert.equal(a.cache, true, "clearable");
      assert.equal(a.danger, true, "warns that the login is lost");
    }
  });

  // ── The disk gap is reported, not left unexplained ──────────────────────────
  await check("listStorage: reports what's outside the data volume", async () => {
    const res = await listStorage();
    if (!res.disk) return; // platform without statfs
    assert.equal(res.totals.outside, Math.max(0, res.disk.used - res.totals.all));
    assert.ok(res.totals.outside > 0, "a real disk always holds more than our volume");
    assert.ok(res.system, "a system breakdown is always present");
    // No Docker socket in the test env — it must degrade with a reason, not throw.
    if (!res.system.available) assert.ok(res.system.reason, "explains why it's missing");
  });

  // Cleanup.
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log(`\n${passed} checks passed`);
}

main();
