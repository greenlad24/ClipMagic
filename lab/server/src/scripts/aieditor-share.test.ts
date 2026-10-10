/**
 * The hand-off share link (aieditor/share.ts) and the streamed zip (aieditor/handoffZip.ts), over real HTTP
 * against a scratch jobs folder:
 *
 *   - a valid token serves the page, the zip (byte-exact, CRCs right, Range/If-Range/416/HEAD), the preview
 *     and the brief — with NO session cookie
 *   - a tampered, expired or revoked token, any path outside the four whitelisted ones, a traversal attempt
 *     and any non-GET method are a 404 that leaks nothing
 *   - the rest of the app stays behind the sign-in gate (/api → 401, a page → 302, "/sharex" is not "/share")
 *   - ZIP64 records (forced on small files) parse
 *
 * Run: cd lab/server && npx tsx src/scripts/aieditor-share.test.ts
 *      (SHARE_TEST_OUT=<dir> also writes the zips there for an external unzip check)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";

process.env.SESSION_SECRET = "test-secret-please-change-0123456789";
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.ALLOWED_EMAILS = "jakedawsonbusiness@gmail.com";

const express = (await import("express")).default;
const share = await import("../aieditor/share.js");
const hz = await import("../aieditor/handoffZip.js");
const { requireSession } = await import("../auth/middleware.js");

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`);
    process.exitCode = 1;
  }
}

// ── a scratch job with a finished package ──
const jobs = fs.mkdtempSync(path.join(os.tmpdir(), "share-test-"));
const JOB = "test-handoff-01";
const dir = path.join(jobs, JOB);
const put = (rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), data);
};
const media = Buffer.alloc(300_000);
for (let i = 0; i < media.length; i++) media[i] = (i * 7919) % 251;
put("handoff-01/timeline.xml", "<xmeml version='4'/>");
put("handoff-01/graphics/01-facecam-bubble.mov", media);
put("handoff-01/screencasts/BRIEF.html", "<!doctype html><title>Brief</title><h1>Screencast brief</h1>");
put("handoff-01/README.txt", "read me");
put("preview-01.mp4", Buffer.alloc(50_000, 3));
put("source.mp4", "SECRET-SOURCE");
put("edl.json", '{"secret": true}');
put("request.json", JSON.stringify({ title: "Hot sauce toolbar" }));
const files: Record<string, number> = {};
for (const rel of ["README.txt", "graphics/01-facecam-bubble.mov", "screencasts/BRIEF.html", "timeline.xml"]) {
  files[rel] = fs.statSync(path.join(dir, "handoff-01", rel)).size;
}
files["preview.mp4"] = fs.statSync(path.join(dir, "preview-01.mp4")).size;
put("handoff-01.json", JSON.stringify({ files, slots: [{ n: 1 }, { n: 2 }] }));
share.setJobsDir(jobs);

const app = express();
app.use(express.json());
app.use("/share", share.sharePublicRouter());
app.use(requireSession);
app.get("/api/aieditor/files/:a/:b", (_req, res) => res.send("GATED-CONTENT"));
app.use((_req, res) => res.send("SPA"));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const get = (p: string, init: RequestInit = {}) => fetch(base + p, { redirect: "manual", ...init });

/** Parse a stored zip by its central directory (zip64 aware) → [{name, data}]; asserts every CRC. */
function unzip(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "an end-of-central-directory record");
  let n = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || n === 0xffff) {
    const loc = eocd - 20;
    assert.equal(buf.readUInt32LE(loc), 0x07064b50, "zip64 locator");
    const z = Number(buf.readBigUInt64LE(loc + 8));
    assert.equal(buf.readUInt32LE(z), 0x06064b50, "zip64 end record");
    n = Number(buf.readBigUInt64LE(z + 32));
    cdOff = Number(buf.readBigUInt64LE(z + 48));
  }
  const out: { name: string; data: Buffer }[] = [];
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central header");
    const crc = buf.readUInt32LE(p + 16);
    let size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28);
    const xl = buf.readUInt16LE(p + 30);
    let lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString("utf8");
    if (xl) {
      const x = p + 46 + nl;
      assert.equal(buf.readUInt16LE(x), 1, "zip64 extra");
      let k = x + 4;
      if (size === 0xffffffff) {
        size = Number(buf.readBigUInt64LE(k));
        k += 16;
      }
      if (lho === 0xffffffff) lho = Number(buf.readBigUInt64LE(k));
    }
    assert.equal(buf.readUInt32LE(lho), 0x04034b50, `local header of ${name}`);
    const lnl = buf.readUInt16LE(lho + 26);
    const lxl = buf.readUInt16LE(lho + 28);
    const data = buf.subarray(lho + 30 + lnl + lxl, lho + 30 + lnl + lxl + size);
    assert.equal(zlib.crc32(data) >>> 0, crc, `CRC of ${name}`);
    out.push({ name, data });
    p += 46 + nl + xl + buf.readUInt16LE(p + 32);
  }
  return out;
}

const link = await share.createShare(JOB, "handoff-01");
const tok = link.path.replace("/share/", "");

await check("a share link is a signed token, listed in share.json, default 14 days", async () => {
  assert.match(link.path, /^\/share\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.equal(link.expiresAt - link.createdAt, 14 * 86400);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "share.json"), "utf8"));
  assert.equal(saved.links.length, 1);
  assert.ok(!JSON.stringify(saved).includes(tok), "the token itself is never stored");
  assert.deepEqual((await share.listShares(JOB)).map((l) => l.path), [link.path], "listing re-derives the same path");
});

await check("the public page: title, size, slots, preview, download, brief — no session", async () => {
  const r = await get(`/share/${tok}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  for (const s of ["Hot sauce toolbar", "2 screencast slots", `/share/${tok}/download`, `/share/${tok}/preview.mp4`, `/share/${tok}/brief`]) {
    assert.ok(html.includes(s), s);
  }
  assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
});

let whole = Buffer.alloc(0);
await check("the zip downloads with no login: stored entries, byte-exact, CRCs right", async () => {
  const r = await get(`/share/${tok}/download`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.match(r.headers.get("content-disposition") || "", /attachment; filename="Hot-sauce-toolbar-handoff-01\.zip"/);
  whole = Buffer.from(await r.arrayBuffer());
  assert.equal(Number(r.headers.get("content-length")), whole.length);
  const ents = unzip(whole);
  assert.deepEqual(ents.map((e) => e.name), [
    "handoff-01/README.txt", "handoff-01/graphics/01-facecam-bubble.mov", "handoff-01/preview.mp4",
    "handoff-01/screencasts/BRIEF.html", "handoff-01/timeline.xml",
  ]);
  assert.ok(ents[1].data.equals(media), "the media bytes");
  assert.ok(ents[2].data.equals(fs.readFileSync(path.join(dir, "preview-01.mp4"))), "preview.mp4 = the job's preview-01.mp4");
  assert.ok(!whole.includes(Buffer.from("SECRET-SOURCE")), "nothing outside the package");
  assert.ok(fs.existsSync(path.join(dir, "handoff-01.zipindex.json")), "CRC index cached");
  if (process.env.SHARE_TEST_OUT) fs.writeFileSync(path.join(process.env.SHARE_TEST_OUT, "share.zip"), whole);
});

await check("downloads resume: Range 206 slices, suffix range, If-Range, 416, HEAD", async () => {
  const etag = (await get(`/share/${tok}/download`, { method: "HEAD" })).headers.get("etag")!;
  for (const [h, a, b] of [["bytes=0-99", 0, 99], ["bytes=1000-150000", 1000, 150000], [`bytes=${whole.length - 10}-`, whole.length - 10, whole.length - 1]] as const) {
    const r = await get(`/share/${tok}/download`, { headers: { range: h, "if-range": etag } });
    assert.equal(r.status, 206, h);
    assert.equal(r.headers.get("content-range"), `bytes ${a}-${b}/${whole.length}`);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(whole.subarray(a, b + 1)), `slice ${h}`);
  }
  const suf = await get(`/share/${tok}/download`, { headers: { range: "bytes=-500" } });
  assert.equal(suf.status, 206);
  assert.ok(Buffer.from(await suf.arrayBuffer()).equals(whole.subarray(whole.length - 500)));
  const stale = await get(`/share/${tok}/download`, { headers: { range: "bytes=0-9", "if-range": '"other"' } });
  assert.equal(stale.status, 200, "a changed package restarts from 0");
  await stale.arrayBuffer();
  const bad = await get(`/share/${tok}/download`, { headers: { range: `bytes=${whole.length + 5}-` } });
  assert.equal(bad.status, 416);
  const head = await get(`/share/${tok}/download`, { method: "HEAD" });
  assert.equal(Number(head.headers.get("content-length")), whole.length);
});

await check("the preview (Range) and the brief are served by the same token", async () => {
  const r = await get(`/share/${tok}/preview.mp4`, { headers: { range: "bytes=0-9" } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 10);
  const b = await get(`/share/${tok}/brief`);
  assert.equal(b.status, 200);
  assert.match(await b.text(), /Screencast brief/);
  assert.match(b.headers.get("content-security-policy") || "", /sandbox/);
});

const refused = async (p: string, init: RequestInit = {}) => {
  const r = await get(p, init);
  const body = await r.text();
  assert.equal(r.status, 404, `${init.method || "GET"} ${p} → ${r.status}`);
  for (const leak of ["SECRET-SOURCE", "secret", "<xmeml", "SPA", "GATED"]) assert.ok(!body.includes(leak), `${p} leaks ${leak}`);
};

await check("paths outside the whitelist and traversal attempts are 404", async () => {
  for (const p of [
    `/share/${tok}/source.mp4`, `/share/${tok}/edl.json`, `/share/${tok}/handoff-01/timeline.xml`,
    `/share/${tok}/../${JOB}/source.mp4`, `/share/${tok}/%2e%2e/edl.json`, `/share/${tok}/download/../../source.mp4`,
    `/share/${tok}/brief/..%2f..%2fsource.mp4`, `/share/${tok}%2f..%2fedl.json`, "/share/", "/share", "/share/x",
  ]) {
    await refused(p);
  }
  await refused(`/share/${tok}`, { method: "POST" });
  await refused(`/share/${tok}/download`, { method: "DELETE" });
});

await check("a tampered token is refused", async () => {
  const [p1, sig] = tok.split(".");
  const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
  await refused(`/share/${p1}.${flip(sig, 5)}/download`);
  const payload = JSON.parse(Buffer.from(p1, "base64url").toString());
  for (const change of [{ j: "other-job-01" }, { p: "handoff-02" }, { e: payload.e + 86400 * 365 }]) {
    const forged = Buffer.from(JSON.stringify({ ...payload, ...change })).toString("base64url");
    await refused(`/share/${forged}.${sig}/download`);
  }
  assert.equal(share.verifyShare(tok, Date.now(), "another-secret-0123456789"), null, "another key never verifies");
});

await check("an expired token is refused (signed and listed, but past its expiry)", async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const id = "expiredlinkid0123456789";
  const links = JSON.parse(fs.readFileSync(path.join(dir, "share.json"), "utf8")).links;
  fs.writeFileSync(path.join(dir, "share.json"), JSON.stringify({ links: [...links, { id, pkg: "handoff-01", createdAt: past - 100, expiresAt: past }] }));
  const t = share.signShare({ v: 1, j: JOB, p: "handoff-01", e: past, n: id });
  await refused(`/share/${t}`);
  await refused(`/share/${t}/download`);
  assert.equal((await share.listShares(JOB)).find((l) => l.id === id)?.active, false);
});

await check("a signed token that share.json does not list is refused", async () => {
  const t = share.signShare({ v: 1, j: JOB, p: "handoff-01", e: Math.floor(Date.now() / 1000) + 3600, n: "neverlistedid0123456789" });
  await refused(`/share/${t}/download`);
});

await check("a revoked token is refused; other links keep working", async () => {
  const second = await share.createShare(JOB, "handoff-01", 3);
  await share.revokeShare(JOB, link.id);
  await refused(`/share/${tok}`);
  await refused(`/share/${tok}/download`);
  assert.equal((await get(`${second.path}/download`, { method: "HEAD" })).status, 200);
  assert.equal(second.expiresAt - second.createdAt, 3 * 86400);
  await assert.rejects(share.createShare(JOB, "handoff-01", 365), /1 to 90 days/);
  await assert.rejects(share.createShare(JOB, "handoff-07"), /not finished/);
  await assert.rejects(share.createShare("../etc", "handoff-01"), /Unknown job/);
});

await check("an incomplete package (a file still copying back) is not served", async () => {
  const t = (await share.createShare(JOB, "handoff-01")).path;
  fs.appendFileSync(path.join(dir, "handoff-01/README.txt"), "x");
  await refused(`${t}/download`);
  fs.writeFileSync(path.join(dir, "handoff-01/README.txt"), "read me");
});

await check("the rest of the app stays behind the sign-in gate", async () => {
  const api = await get(`/api/aieditor/files/${JOB}/handoff-01.zip`);
  assert.equal(api.status, 401);
  assert.ok(!(await api.text()).includes("GATED-CONTENT"));
  const pageR = await get("/auto-editor");
  assert.equal(pageR.status, 302);
  assert.equal(pageR.headers.get("location"), "/auth/google");
  for (const p of ["/sharex", `/sharex/${tok}`, "/shared"]) assert.equal((await get(p)).status, 302, `${p} is not /share`);
});

await check("ZIP64 records (forced on small files) parse, CRCs right", async () => {
  const entries = (await hz.packageEntries(dir, "handoff-01"))!;
  const withCrc = await hz.withCrcs(entries, path.join(dir, "handoff-01.zipindex.json"));
  const layout = hz.zipLayout(withCrc, { force64: true });
  const chunks: Buffer[] = [];
  for await (const c of hz.zipBytes(layout, 0, layout.size - 1)) chunks.push(c);
  const buf = Buffer.concat(chunks);
  assert.equal(buf.length, layout.size);
  const ents = unzip(buf);
  assert.equal(ents.length, 5);
  assert.ok(ents[1].data.equals(media));
  if (process.env.SHARE_TEST_OUT) fs.writeFileSync(path.join(process.env.SHARE_TEST_OUT, "share64.zip"), buf);
});

await check("parseRange", () => {
  assert.deepEqual(hz.parseRange("bytes=0-0", 10), [0, 0]);
  assert.deepEqual(hz.parseRange("bytes=5-100", 10), [5, 9]);
  assert.deepEqual(hz.parseRange("bytes=-3", 10), [7, 9]);
  assert.equal(hz.parseRange("bytes=10-", 10), "bad");
  assert.equal(hz.parseRange("bytes=0-1,4-5", 10), "none");
  assert.equal(hz.parseRange(undefined, 10), "none");
  assert.equal(hz.safeRel("../x"), false);
  assert.equal(hz.safeRel("a/../b"), false);
  assert.equal(hz.safeRel(".hidden"), false);
  assert.equal(hz.safeRel("graphics/01 a.mov"), true);
});

server.close();
fs.rmSync(jobs, { recursive: true, force: true });
console.log(`\naieditor-share: ${passed} passed${process.exitCode ? " — FAILURES above" : ""}`);
