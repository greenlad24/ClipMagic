/**
 * Unit checks for the NARRATION LIBRARY (aieditor/library.ts) and "Stored files"
 * (aieditor/storage.ts), against a throwaway AIEDITOR_WORK:
 *   library   a kept upload used by 2 jobs (hard links): listed once, newest first, metadata
 *             from a job's source.json cached in upload.json, usedBy; an upload made before the
 *             library (folder gone) → a job_source entry; createJob from it (strict checks);
 *             "Remove from library": narration only (jobs keep their link, frees 0 while they
 *             hold it, never comes back as job_source) / and everything made from it (deletes
 *             the jobs, frees the bytes); refused while a queued job still needs it
 *   storage   classify (kinds), hard-link accounting (an inode counted once, freed only when
 *             every link is deleted), deleteJobKind (deleted.json → getJob "deleted"), busy jobs
 *             and pending sources are protected, deleteJob refuses a queued / needed job
 * Run:
 *   cd lab/server && npx tsx src/scripts/aieditor-library.test.ts
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

async function rejects(p: Promise<unknown>, re: RegExp) {
  try {
    await p;
  } catch (e: any) {
    assert.match(String(e?.message), re);
    return e;
  }
  assert.fail(`expected a rejection matching ${re}`);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-library-"));
  process.env.AIEDITOR_WORK = root;
  const jobs = path.join(root, "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const w = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(jobs, rel)), { recursive: true });
    fs.writeFileSync(path.join(jobs, rel), typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  const alloc = (rel: string) => Number(fs.statSync(path.join(jobs, rel)).blocks) * 512;
  const BIG = Buffer.alloc(256 * 1024, 7);                   // 256 KB: allocated = 256 KB

  const lib = await import("../aieditor/library.js");
  const sto = await import("../aieditor/storage.js");
  const ctl = await import("../aieditor/control.js");
  let probes = 0;
  lib.setProbe(async () => { probes++; return { duration: 61, width: 1920, height: 1080 }; });

  // ── a library upload U, used by two finished jobs (hard links) ──
  const U = "u" + "1".repeat(24);
  w(`_uploads/${U}/data`, BIG);
  w(`_uploads/${U}/upload.json`, { id: U, name: "narration.mov", size: BIG.length, received: BIG.length, complete: true, created_at: 2_000_000_000_000, updated_at: 0 });
  for (const [jid, at] of [["narr-a-1009-aaaa", 100], ["narr-b-1009-bbbb", 200]] as const) {
    w(`${jid}/request.json`, { id: jid, title: jid, workflow: "creative", format: "long", created_at: at, source: { kind: "upload", upload: U, name: "narration.mov" } });
    w(`${jid}/status.json`, { state: "done" });
    w(`${jid}/source.json`, { kind: "upload", upload: U, filename: "narration.mov", width: 3840, height: 2160, duration: 966 });
    fs.linkSync(path.join(jobs, `_uploads/${U}/data`), path.join(jobs, jid, "source.mp4"));
    w(`${jid}/final-01.mp4`, BIG);
    w(`${jid}/audio16k.wav`, BIG);
    w(`${jid}/edit-01/gfx/ev-01/f0001.png`, "png");
    w(`${jid}/edit-01/sc-01-1920.mp4`, "sc");
    w(`${jid}/plan.json`, "{}");
  }
  // ── an upload made BEFORE the library: its folder is gone, only the job's source.mp4 is left ──
  const OLD = "u" + "2".repeat(24);
  w("old-upload-1001-cccc/request.json", { id: "old-upload-1001-cccc", title: "Old", workflow: "creative", format: "long", created_at: 50, source: { kind: "upload", upload: OLD, name: "old take.mp4" } });
  w("old-upload-1001-cccc/status.json", { state: "done" });
  w("old-upload-1001-cccc/source.json", { kind: "upload", upload: OLD, filename: "old take.mp4", width: 1920, height: 1080, duration: 300 });
  w("old-upload-1001-cccc/source.mp4", BIG);
  w("old-upload-1001-cccc/preview-01.mp4", "P");
  // a Descript job: not a narration
  w("descript-1001-dddd/request.json", { id: "descript-1001-dddd", workflow: "cut", format: "long", created_at: 10, source: { kind: "descript", url: "x" } });
  w("descript-1001-dddd/source.json", { width: 1920, height: 1080 });
  w("descript-1001-dddd/source.mp4", BIG);

  await check("listLibrary: kept upload (2 jobs) + the pre-library upload as job_source, newest first", async () => {
    const list = await lib.listLibrary();
    assert.deepEqual(list.map((e) => [e.key, e.kind]), [[U, "upload"], [OLD, "job_source"]]);
    const e = list[0];
    assert.equal(e.name, "narration.mov");
    assert.equal(e.uploadedAt, 2_000_000_000);
    assert.deepEqual([e.duration, e.width, e.height], [966, 3840, 2160], "metadata reused from a job's source.json");
    assert.equal(probes, 0, "no ffprobe when a job's source.json has it");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(jobs, `_uploads/${U}/upload.json`), "utf8")).probe, { duration: 966, width: 3840, height: 2160 }, "cached");
    assert.deepEqual(e.usedBy.map((u) => u.id), ["narr-b-1009-bbbb", "narr-a-1009-aaaa"]);
    assert.equal(e.bytes, alloc(`_uploads/${U}/data`));
    assert.equal(e.frees, alloc(`_uploads/${U}/upload.json`), "two jobs still hold the video: deleting the narration alone frees only its upload.json");
    assert.ok(e.freesAll >= e.bytes + 2 * alloc("narr-a-1009-aaaa/final-01.mp4"), "with the jobs: the shared inode once + each job's files");
    assert.equal(e.poster, `/api/aieditor/uploads/${U}/video#t=2`);
    assert.equal(e.blocked, null);
    const o = list[1];
    assert.equal(o.job, "old-upload-1001-cccc");
    assert.equal(o.name, "old take.mp4");
    assert.equal(o.poster, "/api/aieditor/files/old-upload-1001-cccc/preview-01.mp4#t=2");
  });
  await check("listLibrary: an unused upload is ffprobed once, the result cached", async () => {
    const V = "u" + "3".repeat(24);
    w(`_uploads/${V}/data`, "v");
    w(`_uploads/${V}/upload.json`, { id: V, name: "fresh.mp4", size: 1, received: 1, complete: true, created_at: 1_000_000_000_000, updated_at: 0 });
    w(`_uploads/u${"4".repeat(24)}/upload.json`, { id: "u" + "4".repeat(24), name: "half.mp4", size: 9, received: 1, complete: false, created_at: 0, updated_at: 0 });
    await lib.listLibrary();
    const list = await lib.listLibrary();
    assert.equal(probes, 1);
    const v = list.find((x) => x.key === V)!;
    assert.deepEqual([v.duration, v.width, v.height, v.usedBy.length], [61, 1920, 1080, 0]);
    assert.ok(!list.some((x) => x.name === "half.mp4"), "an unfinished upload is not in the library");
    assert.equal(v.frees, v.bytes + alloc(`_uploads/${V}/upload.json`), "nobody else holds it: deleting frees all of it");
    fs.rmSync(path.join(jobs, "_uploads", V), { recursive: true });
    fs.rmSync(path.join(jobs, "_uploads", "u" + "4".repeat(24)), { recursive: true });
  });

  const base = { workflow: "creative", format: "long", sponsored: false } as const;
  await check("createJob from a job_source library entry (strict checks)", async () => {
    const { id: jid } = await ctl.createJob({ ...base, source: { kind: "job_source", job: "old-upload-1001-cccc" } });
    const req = JSON.parse(fs.readFileSync(path.join(jobs, jid, "request.json"), "utf8"));
    assert.deepEqual(req.source, { kind: "job_source", job: "old-upload-1001-cccc", upload: OLD, name: "old take.mp4" });
    assert.match(jid, /^old-take-/);
    assert.equal((await ctl.getJob(jid)).stageList[0].title, "Use the uploaded file");
    await rejects(ctl.createJob({ ...base, source: { kind: "job_source", job: "../old-upload-1001-cccc" } }), /Choose a narration/);
    await rejects(ctl.createJob({ ...base, source: { kind: "job_source", job: "_uploads" } }), /Choose a narration/);
    await rejects(ctl.createJob({ ...base, source: { kind: "job_source", job: "gone-1001-eeee" } }), /no longer exists/);
    await rejects(ctl.createJob({ ...base, source: { kind: "job_source", job: "descript-1001-dddd" } }), /not an uploaded narration/);
    await rejects(ctl.createJob({ ...base, workflow: "cut", source: { kind: "job_source", job: "old-upload-1001-cccc" } }), /Descript share link/);
    // the new job is queued and has no source.mp4 yet: it now NEEDS old-upload's source.mp4
    const list = await lib.listLibrary();
    const o = list.find((e) => e.key === OLD)!;
    assert.deepEqual(o.usedBy.map((u) => u.id).sort(), [jid, "old-upload-1001-cccc"].sort());
    assert.match(String(o.blockedAll), /queued/);
    await rejects(lib.removeFromLibrary(OLD, "all", ctl.deleteJob), /Not deleted: .*queued/);
    await rejects(ctl.deleteJob("old-upload-1001-cccc"), /source of the .* job, which has not started yet/);
    const st = (await sto.listStoredJobs()).find((j) => j.id === "old-upload-1001-cccc")!;
    assert.match(String(st.kinds.find((k) => k.kind === "source")!.blocked), /has not started yet/);
    assert.equal(st.kinds.find((k) => k.kind === "preview")!.blocked, null, "other kinds of that job stay deletable");
    await rejects(sto.deleteJobKind("old-upload-1001-cccc", "source"), /has not started yet/);
    assert.ok(fs.existsSync(path.join(jobs, "old-upload-1001-cccc/source.mp4")));
    // the queued job itself is busy: nothing of it is deleted
    await rejects(ctl.deleteJob(jid), /queued/);
    fs.rmSync(path.join(jobs, jid), { recursive: true });
  });

  await check("classify: every kind", () => {
    const k = (rel: string) => sto.classify(rel);
    assert.deepEqual(k("source.mp4"), { kind: "source", root: "source.mp4" });
    assert.equal(k("preview-01.mp4").kind, "preview");
    assert.equal(k("listen-02.mp4").kind, "preview");
    assert.equal(k("final-01.mp4").kind, "final");
    assert.equal(k("final-01.part.mp4").kind, "temp");
    assert.equal(k("edit-01.mp4").kind, "edit");
    assert.equal(k("edit-01.factory-v1.mp4").kind, "edit");
    assert.deepEqual(k("handoff-01/a-roll.mov"), { kind: "handoff", root: "handoff-01" });
    assert.equal(k("handoff-01.zip").kind, "handoff");
    assert.deepEqual(k("edit-01/seg-03/rec/x.mp4"), { kind: "screencast", root: "edit-01/seg-03" });
    assert.equal(k("edit-01/sc-01-1920.mp4").kind, "screencast");
    assert.equal(k("edit-01/profile/Default/Cookies").kind, "screencast");
    assert.deepEqual(k("edit-01/gfx/ev-01/f.png"), { kind: "graphics", root: "edit-01/gfx" });
    assert.equal(k("edit-01/textgrad-1920.png").kind, "graphics");
    assert.equal(k("gfx4k-01.mp4").kind, "graphics");
    assert.equal(k("graphics-01.json").kind, "data");
    assert.equal(k("edit-01/blocks.json").kind, "data");
    assert.equal(k("edit-01/facecam/x.mp4").kind, "temp");
    assert.equal(k("audio16k.wav").kind, "temp");
    assert.equal(k("full48k.wav").kind, "temp");
    assert.equal(k("tmp-final-01/x.ts").kind, "temp");
    assert.equal(k("chunks-edit-01/0001.mp4").kind, "temp");
    assert.equal(k("request.json").kind, "data");
    assert.equal(k("log.txt").kind, "data");
  });

  await check("hard-link accounting: an inode once; freed only when every link goes", () => {
    const r = (rel: string, key: string, nlink: number, bytes: number) => ({ rel, key, nlink, bytes, size: bytes });
    assert.deepEqual(sto.spaceOf([r("a/source.mp4", "1:9", 3, 100)]), { bytes: 100, frees: 0, shared: 100 });
    assert.deepEqual(sto.spaceOf([r("a/source.mp4", "1:9", 2, 100), r("b/source.mp4", "1:9", 2, 100)]), { bytes: 100, frees: 100, shared: 0 });
    assert.deepEqual(sto.spaceOf([r("a/x", "1:1", 1, 10), r("a/y", "1:2", 1, 20)]), { bytes: 30, frees: 30, shared: 0 });
  });

  await check("listStoredJobs: per-kind bytes / frees, shared source counted, sharedWith", async () => {
    const list = await sto.listStoredJobs();
    const a = list.find((j) => j.id === "narr-a-1009-aaaa")!;
    const kinds = Object.fromEntries(a.kinds.map((k) => [k.kind, k]));
    assert.deepEqual(Object.keys(kinds).sort(), ["data", "final", "graphics", "screencast", "source", "temp"]);
    assert.equal(kinds.source.bytes, alloc(`_uploads/${U}/data`));
    assert.equal(kinds.source.frees, 0, "the source is a hard link the library and the other job share");
    assert.deepEqual(kinds.source.sharedWith, [`_uploads/${U}`, "narr-b-1009-bbbb"]);
    assert.equal(kinds.final.frees, alloc("narr-a-1009-aaaa/final-01.mp4"));
    assert.equal(kinds.data.deletable, false);
    assert.equal(a.frees, a.bytes - kinds.source.bytes);
    const all = await sto.walkAll();
    const total = sto.spaceOf(all).bytes;
    const sumOfFiles = all.reduce((s, x) => s + x.bytes, 0);
    assert.ok(total < sumOfFiles, "the volume total counts the shared narration inode once");
  });

  await check("deleteJobKind: final → gone, deleted.json, getJob says deleted; data kind refused", async () => {
    const before = alloc("narr-a-1009-aaaa/final-01.mp4");
    const r = await sto.deleteJobKind("narr-a-1009-aaaa", "final");
    assert.deepEqual(r.removed, ["final-01.mp4"]);
    assert.equal(r.freed, before);
    assert.ok(!fs.existsSync(path.join(jobs, "narr-a-1009-aaaa/final-01.mp4")));
    const job = await ctl.getJob("narr-a-1009-aaaa");
    assert.deepEqual(job.finals, []);
    assert.equal(job.deleted[0].kind, "final");
    assert.deepEqual(job.deleted[0].files, ["final-01.mp4"]);
    const t = await sto.deleteJobKind("narr-a-1009-aaaa", "temp");
    assert.deepEqual(t.removed, ["audio16k.wav"]);
    const sc = await sto.deleteJobKind("narr-a-1009-aaaa", "screencast");
    assert.deepEqual(sc.removed, ["edit-01/sc-01-1920.mp4"]);
    assert.ok(fs.existsSync(path.join(jobs, "narr-a-1009-aaaa/edit-01/gfx")), "graphics untouched");
    await rejects(sto.deleteJobKind("narr-a-1009-aaaa", "data"), /cannot be deleted on its own/);
    await rejects(sto.deleteJobKind("../x", "final"), /Unknown job/);
    // the source of a job that shares it: deleting frees 0, the library and job b keep the bytes
    const s = await sto.deleteJobKind("narr-a-1009-aaaa", "source");
    assert.equal(s.freed, 0);
    assert.equal(fs.readFileSync(path.join(jobs, `_uploads/${U}/data`)).length, BIG.length);
    assert.equal(fs.statSync(path.join(jobs, `_uploads/${U}/data`)).nlink, 2);
  });

  await check("a running job is never touched", async () => {
    w("narr-b-1009-bbbb/status.json", { state: "running" });
    await rejects(sto.deleteJobKind("narr-b-1009-bbbb", "final"), /running/);
    await rejects(sto.deleteJobKind("narr-b-1009-bbbb", "temp"), /running/);
    await rejects(ctl.deleteJob("narr-b-1009-bbbb"), /Cancel it first/);
    await rejects(lib.removeFromLibrary(U, "all", ctl.deleteJob), /running/);
    assert.ok(fs.existsSync(path.join(jobs, "narr-b-1009-bbbb/final-01.mp4")));
    w("narr-b-1009-bbbb/status.json", { state: "done" });
  });

  await check("remove from library: refused while a queued job still has to materialise it", async () => {
    const jid = "narr-q-1009-ffff";
    w(`${jid}/request.json`, { id: jid, workflow: "creative", format: "long", created_at: 300, source: { kind: "upload", upload: U, name: "narration.mov" } });
    w(`${jid}/status.json`, { state: "queued" });
    w(`${jid}/queue.json`, { action: "run" });
    const e = (await lib.listLibrary()).find((x) => x.key === U)!;
    assert.match(String(e.blocked), /has not started yet/);
    await rejects(lib.removeFromLibrary(U, "narration", ctl.deleteJob), /Not deleted/);
    assert.ok(fs.existsSync(path.join(jobs, `_uploads/${U}/data`)));
    fs.rmSync(path.join(jobs, jid), { recursive: true });
  });

  await check("remove narration only: the jobs keep their copy; it never comes back as job_source", async () => {
    const r = await lib.removeFromLibrary(U, "narration", ctl.deleteJob);
    assert.equal(r.freed, alloc("narr-b-1009-bbbb/request.json"), "job b still holds the video inode: only upload.json (one block) is freed");
    assert.ok(!fs.existsSync(path.join(jobs, "_uploads", U)));
    assert.equal(fs.readFileSync(path.join(jobs, "narr-b-1009-bbbb/source.mp4")).length, BIG.length);
    const list = await lib.listLibrary();
    assert.ok(!list.some((x) => x.key === U), "hidden: not re-offered as a job_source entry");
  });

  await check("remove narration AND everything made from it: deletes the jobs, frees the bytes", async () => {
    const e = (await lib.listLibrary()).find((x) => x.key === OLD)!;
    assert.equal(e.frees, 0, "a job_source entry is the job's own file: narration-only frees nothing");
    const expect = e.freesAll;
    assert.ok(expect >= alloc("old-upload-1001-cccc/source.mp4"));
    const r = await lib.removeFromLibrary(OLD, "all", ctl.deleteJob);
    assert.deepEqual(r.removedJobs, ["old-upload-1001-cccc"]);
    assert.equal(r.freed, expect);
    assert.ok(!fs.existsSync(path.join(jobs, "old-upload-1001-cccc")));
    assert.ok(fs.existsSync(path.join(jobs, "descript-1001-dddd/source.mp4")), "unrelated jobs untouched");
    await rejects(lib.removeFromLibrary(OLD, "all", ctl.deleteJob), /not in the library/);
    await rejects(lib.removeFromLibrary("../x", "all", ctl.deleteJob), /Unknown narration/);
  });

  await check("deleteJob reports the freed bytes (hard links shared elsewhere stay)", async () => {
    const r = await ctl.deleteJob("narr-b-1009-bbbb");
    assert.equal(r.ok, true);
    assert.ok((r.freed ?? 0) > 0);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\naieditor-library: ${passed} checks passed`);
}

main();
