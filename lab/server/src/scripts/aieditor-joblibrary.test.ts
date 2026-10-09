/**
 * "Previously used narrations" (aieditor/library.ts) over a fake jobs tree shaped like the real
 * one (Jake 2026-10-09: "I want to reuse a narration from another job"):
 *   - Descript jobs (a raw 4K narration cut to a final; the same Descript link downloaded twice
 *     = two files, two entries), a creative job whose source.mp4 is a HARD LINK of another job's
 *     final, another of another job's preview, a kept upload used by a job, a job_source reuse
 *     hard-linked to a Descript job's source, a job still downloading (no source.json)
 *   - one entry per inode ((st_dev, st_ino)), usedBy = every holder (+ queued reusers), origin
 *     label, RAW / EDITED, newest first, poster never the raw source.mp4, not deletable here
 *   - createJob {kind: job_source, job} with no upload id, in the cut AND creative workflows
 * Run:
 *   cd lab/server && npx tsx src/scripts/aieditor-joblibrary.test.ts
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-joblib-"));
  process.env.AIEDITOR_WORK = root;
  const jobs = path.join(root, "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const w = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(jobs, rel)), { recursive: true });
    fs.writeFileSync(path.join(jobs, rel), typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  const ln = (from: string, to: string) => {
    fs.mkdirSync(path.dirname(path.join(jobs, to)), { recursive: true });
    fs.linkSync(path.join(jobs, from), path.join(jobs, to));
  };
  const ino = (rel: string) => fs.statSync(path.join(jobs, rel)).ino;
  const RAW = Buffer.alloc(128 * 1024, 1);
  const RAW2 = Buffer.alloc(64 * 1024, 2);
  const UHD = { width: 3840, height: 2160, fps: 29.97, has_audio: true };

  const lib = await import("../aieditor/library.js");
  const ctl = await import("../aieditor/control.js");
  const sto = await import("../aieditor/storage.js");
  lib.setProbe(async () => ({ duration: 42, width: 1080, height: 1920 }));

  // ── linearity: a raw 4K Descript narration, cut, with a final ──
  const LIN = "linearity-10050728-8866";
  w(`${LIN}/request.json`, { id: LIN, title: "Linearity", created_at: 1791185306.518, source: { kind: "descript", url: "https://share.descript.com/view/r5vpQtmHP2d" } });
  w(`${LIN}/status.json`, { state: "done" });
  w(`${LIN}/source.json`, { share_id: "r5vpQtmHP2d", title: "Linearity", duration: 3028.49, ...UHD });
  w(`${LIN}/source.mp4`, RAW);
  w(`${LIN}/final-01.mp4`, Buffer.alloc(96 * 1024, 3));
  w(`${LIN}/preview-01.mp4`, "P");
  // ── 131: a raw Descript narration (cut, preview only) ──
  const G = "131-chatgpt-images-2-5-2-min-t-10081416-4535";
  w(`${G}/request.json`, { id: G, title: "131 ChatGPT Images 2.5 - 2-min test", created_at: 1791468995.645, source: { kind: "descript", url: "https://share.descript.com/view/AxaYeSbMXY4" } });
  w(`${G}/status.json`, { state: "done" });
  w(`${G}/source.json`, { share_id: "AxaYeSbMXY4", title: "GPT2.5Toolbar", duration: 906.58, ...UHD });
  w(`${G}/source.mp4`, RAW2);
  w(`${G}/listen-01.mp4`, "L");
  // ── factory-e2e-test: the SAME Descript link downloaded again = a separate file (own inode) ──
  const E = "factory-e2e-test";
  w(`${E}/request.json`, { id: E, title: "Factory end-to-end test (delete me)", created_at: 1791486106843.5796, source: { kind: "descript", url: "https://share.descript.com/view/AxaYeSbMXY4" } });
  w(`${E}/status.json`, { state: "done" });
  w(`${E}/source.json`, { share_id: "AxaYeSbMXY4", title: "GPT2.5Toolbar", duration: 906.58, ...UHD });
  w(`${E}/source.mp4`, RAW2);
  w(`${E}/preview-01.mp4`, Buffer.alloc(32 * 1024, 4));
  // ── creative jobs whose source.mp4 is a hard link of another job's final / preview ──
  const CL = "creative-from-linearity-test-10082042-45e5";
  w(`${CL}/request.json`, { id: CL, title: "Creative from Linearity (test)", workflow: "creative", created_at: 1791492121.244, source: { kind: "job", job: LIN, file: "final-01.mp4", title: "Linearity" } });
  w(`${CL}/status.json`, { state: "done" });
  w(`${CL}/source.json`, { kind: "job", from_job: LIN, from_file: "final-01.mp4", title: "Linearity", quality: "final", duration: 964.13, ...UHD });
  ln(`${LIN}/final-01.mp4`, `${CL}/source.mp4`);
  w(`${CL}/edit-01.mp4`, "E");
  const MR = "factory-end-to-end-test-mac-rec-10082332-63de";
  w(`${MR}/request.json`, { id: MR, title: "Factory end-to-end test (Mac recorder rerun, delete me)", workflow: "creative", created_at: 1791502353.0922592, source: { kind: "job", job: E, file: "preview-01.mp4", title: "Factory end-to-end test (delete me)" } });
  w(`${MR}/status.json`, { state: "done" });
  w(`${MR}/source.json`, { kind: "job", from_job: E, from_file: "preview-01.mp4", title: "Factory end-to-end test (delete me)", quality: "preview", duration: 880.21, width: 1920, height: 1080 });
  ln(`${E}/preview-01.mp4`, `${MR}/source.mp4`);
  // ── a job_source reuse of 131's narration (new style, no upload id): same inode as 131 ──
  const RU = "cut-again-10091200-aaaa";
  w(`${RU}/request.json`, { id: RU, title: "Cut again", workflow: "cut", created_at: 1791500000, source: { kind: "job_source", job: G, name: "GPT2.5Toolbar", origin: "Descript: GPT2.5Toolbar" } });
  w(`${RU}/status.json`, { state: "done" });
  w(`${RU}/source.json`, { kind: "job_source", from_job: G, filename: "GPT2.5Toolbar", origin: "Descript: GPT2.5Toolbar", duration: 906.58, ...UHD });
  ln(`${G}/source.mp4`, `${RU}/source.mp4`);
  // ── a kept upload used by a creative job (its data and the job's source are one inode) ──
  const U = "u" + "a".repeat(24);
  w(`_uploads/${U}/data`, Buffer.alloc(16 * 1024, 5));
  w(`_uploads/${U}/upload.json`, { id: U, name: "phone take.mov", size: 16384, received: 16384, complete: true, created_at: 1791510000000, updated_at: 0 });
  const UJ = "phone-take-10091300-bbbb";
  w(`${UJ}/request.json`, { id: UJ, title: "Phone take", workflow: "creative", created_at: 1791510100, source: { kind: "upload", upload: U, name: "phone take.mov" } });
  w(`${UJ}/status.json`, { state: "done" });
  w(`${UJ}/source.json`, { kind: "upload", upload: U, from_upload: U, filename: "phone take.mov", duration: 42, width: 1080, height: 1920 });
  ln(`_uploads/${U}/data`, `${UJ}/source.mp4`);
  // ── still downloading: source.mp4 there, no source.json yet → not offered ──
  const DL = "downloading-10091400-cccc";
  w(`${DL}/request.json`, { id: DL, title: "Downloading", created_at: 1791520000, source: { kind: "descript", url: "https://share.descript.com/view/ZZZZZZZZ" } });
  w(`${DL}/status.json`, { state: "running" });
  w(`${DL}/source.mp4`, "half");

  let list: Awaited<ReturnType<typeof lib.listLibrary>> = [];
  const by = (k: string) => list.find((e) => e.key === k)!;

  await check("one entry per inode, newest first, labelled with where it came from", async () => {
    list = await lib.listLibrary();
    assert.deepEqual(list.map((e) => e.key), [
      U, `job:${MR}`, `job:${CL}`, `job:${E}`, `job:${G}`, `job:${LIN}`,
    ]);
    assert.deepEqual(list.map((e) => e.origin), [
      "Uploaded: phone take.mov",
      "Lab edit of Factory end-to-end test (delete me)",
      "Lab edit of Linearity",
      "Descript: GPT2.5Toolbar",
      "Descript: GPT2.5Toolbar",
      "Descript: Linearity",
    ]);
    assert.ok(!list.some((e) => e.key === `job:${RU}`), "a hard-linked copy is not a second entry");
    assert.ok(!list.some((e) => e.job === DL || e.usedBy.some((u) => u.id === DL)), "a download in progress is not offered");
  });

  await check("usedBy: every job holding the inode; RAW vs EDITED", () => {
    assert.deepEqual(by(`job:${G}`).usedBy.map((u) => u.id), [RU, G], "131 + its job_source reuse (newest first)");
    assert.deepEqual(by(`job:${E}`).usedBy.map((u) => u.id), [E], "the second download of the same link is its own file");
    assert.deepEqual(by(`job:${CL}`).usedBy.map((u) => u.id), [CL], "the creative job, not the job that made the final");
    assert.deepEqual(list.map((e) => e.stage), ["edited", "edited", "edited", "raw", "raw", "raw"]);
    assert.deepEqual(by(U).usedBy.map((u) => u.id), [UJ]);
  });

  await check("duration / resolution from source.json, size of the shared inode once, poster never the raw file", () => {
    const l = by(`job:${LIN}`);
    assert.deepEqual([l.duration, l.width, l.height, l.name, l.job, l.kind], [3028.49, 3840, 2160, "Linearity", LIN, "job_source"]);
    assert.equal(l.bytes, Number(fs.statSync(path.join(jobs, LIN, "source.mp4")).blocks) * 512);
    assert.equal(l.poster, `/api/aieditor/files/${LIN}/final-01.mp4#t=2`, "a video the job made from it");
    assert.equal(by(`job:${G}`).poster, `/api/aieditor/files/${G}/listen-01.mp4#t=2`);
    assert.equal(by(`job:${CL}`).poster, `/api/aieditor/files/${LIN}/final-01.mp4#t=2`, "the very file, served as the final");
    assert.equal(by(`job:${MR}`).poster, `/api/aieditor/files/${E}/preview-01.mp4#t=2`);
    assert.equal(by(`job:${CL}`).bytes, Number(fs.statSync(path.join(jobs, LIN, "final-01.mp4")).blocks) * 512);
    assert.ok(list.every((e) => !String(e.poster).includes("source.mp4")));
  });

  await check("a job's narration is not deletable from the library", async () => {
    for (const e of list.filter((x) => x.key.startsWith("job:"))) {
      assert.equal(e.deletable, false);
      assert.match(String(e.blocked), /through that job/);
      assert.equal(e.frees, 0);
    }
    assert.equal(by(U).deletable, true, "uploads keep the two-choice delete");
    await rejects(lib.removeFromLibrary(`job:${LIN}`, "all", ctl.deleteJob), /through that job in Stored files/);
    assert.ok(fs.existsSync(path.join(jobs, LIN, "source.mp4")));
  });

  const base = { format: "long", sponsored: false } as const;
  await check("createJob {kind: job_source, job} with no upload id — cut and creative", async () => {
    const { id: c1 } = await ctl.createJob({ ...base, workflow: "cut", source: { kind: "job_source", job: LIN } });
    const r1 = JSON.parse(fs.readFileSync(path.join(jobs, c1, "request.json"), "utf8"));
    assert.deepEqual(r1.source, { kind: "job_source", job: LIN, name: "Linearity", origin: "Descript: Linearity" });
    assert.equal(r1.workflow, "cut");
    assert.match(c1, /^linearity-/);
    assert.equal((await ctl.getJob(c1)).stageList[0].title, "Use the earlier narration");
    // Full edit = the cut workflow chained into the creative edit
    const { id: c2 } = await ctl.createJob({ ...base, workflow: "cut", chain: "creative", source: { kind: "job_source", job: G } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(jobs, c2, "request.json"), "utf8")).chain, "creative");
    // creative + graphics only from an edited one
    const { id: c3 } = await ctl.createJob({ ...base, workflow: "creative", source: { kind: "job_source", job: CL } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(jobs, c3, "request.json"), "utf8")).source,
      { kind: "job_source", job: CL, name: "Linearity", origin: "Lab edit of Linearity" });
    const { id: c4 } = await ctl.createJob({ ...base, workflow: "creative", handoff: true, source: { kind: "job_source", job: MR } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(jobs, c4, "request.json"), "utf8")).handoff, true);
    // an upload's job keeps its upload id (the library key)
    const { id: c5 } = await ctl.createJob({ ...base, workflow: "cut", source: { kind: "job_source", job: UJ } });
    assert.equal(JSON.parse(fs.readFileSync(path.join(jobs, c5, "request.json"), "utf8")).source.upload, U);
    // the queued jobs show up as users of the narration and protect it
    list = await lib.listLibrary();
    assert.deepEqual(by(`job:${LIN}`).usedBy.map((u) => u.id).sort(), [c1, LIN].sort());
    assert.deepEqual(by(`job:${CL}`).usedBy.map((u) => u.id).sort(), [c3, CL].sort());
    assert.ok(by(U).usedBy.some((u) => u.id === c5));
    assert.ok(!list.some((e) => e.job === c1), "a queued job (no source.mp4 yet) is not an entry of its own");
    await rejects(sto.deleteJobKind(LIN, "source"), /has not started yet/);
    for (const id of [c1, c2, c3, c4, c5]) fs.rmSync(path.join(jobs, id), { recursive: true });
  });

  await check("createJob job_source: strict checks", async () => {
    const mk = (job: string) => ctl.createJob({ ...base, workflow: "creative", source: { kind: "job_source", job } });
    await rejects(mk(`../${LIN}`), /Choose a narration/);
    await rejects(mk("_uploads"), /Choose a narration/);
    await rejects(mk(`${LIN}/source.mp4`), /Choose a narration/);
    await rejects(mk("Linearity"), /Choose a narration/);
    await rejects(mk(""), /Choose a narration/);
    await rejects(mk("gone-10091500-dddd"), /no longer exists/);
    await rejects(mk(DL), /not finished getting its narration/);
    // a symlinked source.mp4 / a symlinked job folder are refused
    w("sym-10091600-eeee/request.json", { id: "sym-10091600-eeee", source: { kind: "descript", url: "x" } });
    w("sym-10091600-eeee/source.json", {});
    fs.symlinkSync(path.join(jobs, LIN, "source.mp4"), path.join(jobs, "sym-10091600-eeee/source.mp4"));
    await rejects(mk("sym-10091600-eeee"), /no source video/);
    fs.symlinkSync(path.join(jobs, LIN), path.join(jobs, "symdir-10091600-ffff"));
    await rejects(mk("symdir-10091600-ffff"), /not a job folder/);
    fs.unlinkSync(path.join(jobs, "symdir-10091600-ffff"));
    fs.rmSync(path.join(jobs, "sym-10091600-eeee"), { recursive: true });
    // the cut workflow never re-cuts a Lab edit (kind job) — that is not a library pick
    await rejects(ctl.createJob({ ...base, workflow: "cut", source: { kind: "job", job: LIN, file: "final-01.mp4" } }), /Descript share link or a previously used narration/);
    assert.equal(fs.readdirSync(jobs).filter((n) => /^(linearity|gpt|131)-.*-[0-9a-f]{4}$/.test(n) && n !== LIN && n !== G).length, 0, "no stray jobs");
  });

  await check("deleting a job's source through Stored files drops it from the library", async () => {
    await sto.deleteJobKind(E, "source");
    list = await lib.listLibrary();
    assert.ok(!list.some((e) => e.key === `job:${E}`));
    assert.ok(list.some((e) => e.key === `job:${MR}`), "the Lab edit made from it is a separate file");
    assert.ok(fs.existsSync(path.join(jobs, G, "source.mp4")));
    assert.equal(ino(`${G}/source.mp4`), ino(`${RU}/source.mp4`));
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\naieditor-joblibrary: ${passed} checks passed`);
}

main();
