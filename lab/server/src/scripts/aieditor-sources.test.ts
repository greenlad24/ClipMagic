/**
 * Unit checks for the creative edit's two new SOURCES, against a throwaway AIEDITOR_WORK:
 *   uploads.ts   the offset-based chunked upload: create (video only, size cap), a chunk only
 *                at offset == received (409 + received otherwise → a retried chunk is never
 *                appended twice), a cut-off chunk does not move `received` and its bytes are
 *                overwritten by the retry, complete = exact size (truncates leftovers),
 *                the 2-day sweep (keeps an upload a job still waits for), cancel
 *   control.ts   createJob source validation: a Lab edit (cut workflow only, strict names, the
 *                file must exist), an upload (complete, claimed by one job only), the cut
 *                workflow keeps Descript only; listLabEdits (final > preview, per video, cut
 *                jobs only, _uploads ignored); stage title of the "download" stage; the
 *                REVIEW GATE (an unreviewed automatic cut is never offered and always refused —
 *                no override tick — factory-e2e-test fixture); the Full edit's chain request
 *                (chain: creative → factory takes policy, no_edit) and getJob's chain links
 * Run:
 *   cd lab/server && npx tsx src/scripts/aieditor-sources.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ok  ${name}`); })
    .catch((e) => { console.error(`FAIL  ${name}\n      ${e instanceof Error ? e.stack : e}`); process.exitCode = 1; });
}

async function rejects(p: Promise<unknown>, re: RegExp, status?: number) {
  try {
    await p;
  } catch (e: any) {
    assert.match(String(e?.message), re);
    if (status !== undefined) assert.equal(e.status, status, `status of "${e?.message}"`);
    return e;
  }
  assert.fail(`expected a rejection matching ${re}`);
}

/** a request body that delivers `parts` and then fails (a dropped connection) */
function broken(parts: Buffer[]) {
  let i = 0;
  return new Readable({
    read() {
      if (i < parts.length) this.push(parts[i++]);
      else this.destroy(new Error("aborted"));
    },
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-sources-"));
  process.env.AIEDITOR_WORK = root;
  const jobs = path.join(root, "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const w = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(jobs, rel)), { recursive: true });
    fs.writeFileSync(path.join(jobs, rel), typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };

  const up = await import("../aieditor/uploads.js");
  const ctl = await import("../aieditor/control.js");

  // ── uploads: pure checks ──
  await check("checkNewUpload: video extensions only, size 1 B … 20 GB", () => {
    assert.deepEqual(up.checkNewUpload("My Video.MOV", 10), { name: "My Video.MOV", size: 10 });
    assert.equal(up.checkNewUpload("../../etc/clip.mp4", 1).name, "clip.mp4");      // basename only
    assert.throws(() => up.checkNewUpload("notes.txt", 10), /Only video files/);
    assert.throws(() => up.checkNewUpload("clip", 10), /Only video files/);
    assert.throws(() => up.checkNewUpload("clip.mp4", 0), /empty/);
    assert.throws(() => up.checkNewUpload("clip.mp4", -5), /empty/);
    assert.throws(() => up.checkNewUpload("clip.mp4", 21 * 1024 ** 3), /Up to 20 GB/);
    assert.throws(() => up.checkNewUpload("", 10), /needs a name/);
  });
  await check("checkChunk: only at offset == received; 409 carries received", () => {
    const m = { id: "u" + "a".repeat(24), name: "a.mp4", size: 100, received: 40, complete: false, created_at: 0, updated_at: 0 };
    up.checkChunk(m, 40, 60);
    up.checkChunk(m, 40, null);
    let e: any;
    try { up.checkChunk(m, 0, 40); } catch (x) { e = x; }
    assert.equal(e.status, 409);
    assert.equal(e.extra.received, 40);
    assert.throws(() => up.checkChunk(m, 40, 61), /past the end/);
    assert.throws(() => up.checkChunk(m, -1, 1), /Bad offset/);
    assert.throws(() => up.checkChunk(m, 40, up.MAX_CHUNK_BYTES + 1), /too large|past the end/);
    assert.throws(() => up.checkChunk({ ...m, complete: true }, 40, 1), /already complete/);
  });

  // ── uploads: the real disk path ──
  const body = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");        // 36 bytes
  let id = "";
  await check("create → empty data file + meta; ids are path-safe", async () => {
    const m = await up.createUpload({ name: "take one.mov", size: body.length });
    id = m.id;
    assert.match(id, up.UPLOAD_ID_RE);
    assert.equal(m.received, 0);
    assert.equal(fs.statSync(path.join(jobs, "_uploads", id, "data")).size, 0);
    await rejects(up.getUpload("../x"), /Unknown upload/, 404);
    await rejects(up.getUpload("u" + "0".repeat(24)), /Unknown upload/, 404);
  });
  await check("append: chunk 1 at 0, then a retry of chunk 1 is refused with 409 (never doubled)", async () => {
    const m = await up.appendChunk(id, 0, Readable.from([body.subarray(0, 16)]), 16);
    assert.equal(m.received, 16);
    const e = await rejects(up.appendChunk(id, 0, Readable.from([body.subarray(0, 16)]), 16), /Expected offset 16/, 409);
    assert.equal(e.extra.received, 16);
    assert.equal((await up.getUpload(id)).received, 16);
  });
  await check("a chunk cut off mid-way does not move received; the retry overwrites its bytes", async () => {
    await rejects(up.appendChunk(id, 16, broken([Buffer.from("XXXXX")]), 10), /cut off/, 400);
    assert.equal((await up.getUpload(id)).received, 16);
    // declared 10, only 5 arrived but the stream ended cleanly → also not counted
    await rejects(up.appendChunk(id, 16, Readable.from([Buffer.from("YYYYY")]), 10), /cut off/, 400);
    assert.equal((await up.getUpload(id)).received, 16);
    const m = await up.appendChunk(id, 16, Readable.from([body.subarray(16, 26)]), 10);
    assert.equal(m.received, 26);
  });
  await check("a chunk past the declared size is refused", async () => {
    await rejects(up.appendChunk(id, 26, Readable.from([Buffer.alloc(11)]), null), /past the end/, 400);
    assert.equal((await up.getUpload(id)).received, 26);
  });
  await check("complete refuses a short upload, then succeeds with the exact bytes", async () => {
    await rejects(up.completeUpload(id), /Only 26 of 36/, 409);
    // leave junk past the end (a cut-off attempt of the last chunk), then the real chunk
    await rejects(up.appendChunk(id, 26, broken([Buffer.from("ZZZZZZZZ")]), 10), /cut off/);
    await up.appendChunk(id, 26, Readable.from([body.subarray(26)]), 10);
    const m = await up.completeUpload(id);
    assert.equal(m.complete, true);
    assert.deepEqual(fs.readFileSync(path.join(jobs, "_uploads", id, "data")), body);
    await rejects(up.appendChunk(id, 36, Readable.from([Buffer.from("x")]), 1), /already complete/, 409);
    assert.equal((await up.completeUpload(id)).complete, true);                // idempotent
  });
  await check("cancel removes an unused upload", async () => {
    const m = await up.createUpload({ name: "x.mp4", size: 5 });
    await up.cancelUpload(m.id);
    assert.equal(fs.existsSync(path.join(jobs, "_uploads", m.id)), false);
  });

  // ── jobs: a finished Lab edit (cut), a creative job, a cut job with only a preview ──
  w("linearity-10050728-8866/request.json", { id: "linearity-10050728-8866", title: "Linearity", format: "long", created_at: 100 });
  w("linearity-10050728-8866/source.json", { width: 3840, height: 2160, duration: 1500 });
  w("linearity-10050728-8866/edl.json", { videos: [{ title: "Linearity: on-brand", duration: 964.13 }] });
  w("linearity-10050728-8866/final-01.mp4", "FINAL");
  w("linearity-10050728-8866/preview-01.mp4", "PREVIEW");
  w("shorts-t7-1005-aaaa/request.json", { title: "T7 shorts", format: "short", workflow: "cut", created_at: 200 });
  w("shorts-t7-1005-aaaa/source.json", { width: 2160, height: 3840, duration: 798 });
  w("shorts-t7-1005-aaaa/edl.json", { videos: [{ title: "A", duration: 30 }, { title: "B", duration: 25 }] });
  w("shorts-t7-1005-aaaa/final-01.mp4", "F1");
  w("shorts-t7-1005-aaaa/preview-02.mp4", "P2");
  w("onlypreview-1005-bbbb/request.json", { title: "131 test", format: "long", created_at: 50 });
  w("onlypreview-1005-bbbb/source.json", { width: 3840, height: 2160 });
  w("onlypreview-1005-bbbb/preview-01.mp4", "P");
  w("onlypreview-1005-bbbb/review.json", { edited: true });          // Jake reviewed this cut
  w("creative-1005-cccc/request.json", { title: "A creative one", format: "long", workflow: "creative", created_at: 300 });
  w("creative-1005-cccc/final-01.mp4", "F");
  w("nothing-yet-1005-dddd/request.json", { title: "Running", format: "long", created_at: 400 });

  await check("listLabEdits: cut jobs with a video only; final wins; per-video; newest first", async () => {
    const edits = await ctl.listLabEdits();
    assert.deepEqual(edits.map((e) => e.id), ["shorts-t7-1005-aaaa", "linearity-10050728-8866", "onlypreview-1005-bbbb"]);
    const lin = edits[1];
    assert.equal(lin.videos.length, 1);
    assert.equal(lin.videos[0].file, "final-01.mp4");
    assert.equal(lin.videos[0].quality, "final");
    assert.deepEqual([lin.videos[0].width, lin.videos[0].height], [3840, 2160]);
    assert.equal(lin.videos[0].duration, 964.13);
    const sh = edits[0];
    // preview-02 has no final and nobody reviewed it: an unreviewed automatic cut is not offered
    assert.deepEqual(sh.videos.map((v) => [v.file, v.quality, v.title]), [["final-01.mp4", "final", "A"]]);
    assert.deepEqual([edits[2].videos[0].width, edits[2].videos[0].height], [1920, 1080]);
    const all = await ctl.listJobs();
    assert.ok(!all.some((j) => j.id.startsWith("_")), "_uploads is not a job");
  });

  const base = { workflow: "creative", format: "long", sponsored: false } as const;
  await check("createJob from a Lab edit writes source {kind: job} + the download stage title", async () => {
    const { id: jid } = await ctl.createJob({ ...base, source: { kind: "job", job: "linearity-10050728-8866", file: "final-01.mp4" } });
    const req = JSON.parse(fs.readFileSync(path.join(jobs, jid, "request.json"), "utf8"));
    assert.deepEqual(req.source, { kind: "job", job: "linearity-10050728-8866", file: "final-01.mp4", title: "Linearity" });
    assert.match(jid, /^linearity-/);
    const job = await ctl.getJob(jid);
    assert.equal(job.stageList[0].title, "Use the Lab edit");
    assert.ok(fs.readFileSync(path.join(jobs, "linearity-10050728-8866", "final-01.mp4"), "utf8") === "FINAL", "source job untouched");
  });
  await check("createJob refuses a bad / missing / non-cut Lab edit", async () => {
    const mk = (job: string, file: string) => ctl.createJob({ ...base, source: { kind: "job", job, file } });
    await rejects(mk("../linearity-10050728-8866", "final-01.mp4"), /Choose a finished Lab edit/);
    await rejects(mk("linearity-10050728-8866", "../request.json"), /Choose a finished Lab edit/);
    await rejects(mk("linearity-10050728-8866", "source.mp4"), /Choose a finished Lab edit/);
    await rejects(mk("linearity-10050728-8866", "final-02.mp4"), /has no final-02.mp4/);
    await rejects(mk("gone-1005-eeee", "final-01.mp4"), /no longer exists/);
    await rejects(mk("creative-1005-cccc", "final-01.mp4"), /Cut an unedited narration/);
    await rejects(mk("_uploads", "final-01.mp4"), /Choose a finished Lab edit/);
  });
  await check("the cut workflow keeps Descript only; Descript jobs unchanged", async () => {
    await rejects(ctl.createJob({ ...base, workflow: "cut", source: { kind: "job", job: "linearity-10050728-8866", file: "final-01.mp4" } }),
      /Descript share link/);
    await rejects(ctl.createJob({ ...base, workflow: "cut", url: "https://example.com/x" }), /Descript share link/);
    const { id: jid } = await ctl.createJob({ ...base, workflow: "cut", url: "https://share.descript.com/view/AbC123xyz" });
    const req = JSON.parse(fs.readFileSync(path.join(jobs, jid, "request.json"), "utf8"));
    assert.deepEqual(req.source, { kind: "descript", url: "https://share.descript.com/view/AbC123xyz" });
    assert.equal((await ctl.getJob(jid)).stageList[0].title, "Download from Descript");
  });
  await check("createJob from an upload: complete only, claimed by ONE job", async () => {
    const half = await up.createUpload({ name: "half.mp4", size: 10 });
    await rejects(ctl.createJob({ ...base, source: { kind: "upload", upload: half.id } }), /not finished/);
    await rejects(ctl.createJob({ ...base, source: { kind: "upload", upload: "../../x" } }), /Upload the video first/);
    const { id: jid } = await ctl.createJob({ ...base, source: { kind: "upload", upload: id } });
    const req = JSON.parse(fs.readFileSync(path.join(jobs, jid, "request.json"), "utf8"));
    assert.deepEqual(req.source, { kind: "upload", upload: id, name: "take one.mov" });
    assert.match(jid, /^take-one-/);
    assert.equal((await up.getUpload(id)).job, jid);
    assert.equal((await ctl.getJob(jid)).stageList[0].title, "Use the uploaded file");
    await rejects(ctl.createJob({ ...base, source: { kind: "upload", upload: id } }), /already used by another job/);
    await rejects(up.cancelUpload(id), /already uses/, 409);
  });
  // ── REVIEW GATE: the factory-e2e-test fixture = the cut Jake's factory edit started from
  // (no_edit, review.json edited:false, no final; 53 joins: So 32, uh 6, um 1, pause-only 8,
  // 3 whole sentences, 3 asides = 45 removals, 49 words) ──
  const e2eJoins = [
    ...Array.from({ length: 32 }, () => ({ removed: "So" })),
    ...Array.from({ length: 6 }, () => ({ removed: "uh," })),
    { removed: "um," },
    ...Array.from({ length: 8 }, () => ({ removed: "" })),
    { removed: "Cool." }, { removed: "Try for yourself." }, { removed: "Okay." },
    { removed: "I'm talking about" }, { removed: "Hold," }, { removed: "It's," },
  ];
  w("factory-e2e-test/request.json", { id: "factory-e2e-test", title: "Factory end-to-end test (delete me)", format: "long", no_edit: true, created_at: 500 });
  w("factory-e2e-test/source.json", { width: 3840, height: 2160 });
  w("factory-e2e-test/edl.json", { videos: [{ title: "ChatGPT Images 2.5", duration: 880.2, joins: e2eJoins }] });
  w("factory-e2e-test/review.json", { edited: false, videos: [] });
  w("factory-e2e-test/preview-01.mp4", "P");
  await check("reviewStatusOf: final / reviewed / verified / unreviewed (pure)", () => {
    const edl = { videos: [{ joins: [{ removed: "So" }, { removed: "" }, { removed: "Try for yourself." }] }] };
    assert.deepEqual(ctl.reviewStatusOf("preview-01.mp4", false, { edited: false }, edl, null),
      { review: "unreviewed", removedWords: 4, removals: 2 });
    assert.equal(ctl.reviewStatusOf("preview-01.mp4", true, null, edl, null).review, "final");
    assert.equal(ctl.reviewStatusOf("final-01.mp4", false, null, edl, null).review, "final");
    assert.equal(ctl.reviewStatusOf("preview-01.mp4", false, { edited: true }, edl, null).review, "reviewed");
    assert.equal(ctl.reviewStatusOf("preview-01.mp4", false, { approved: true }, edl, null).review, "reviewed");
    assert.equal(ctl.reviewStatusOf("preview-01.mp4", false, null, edl, { policy: "factory", unapproved: 0, approved_by: null }).review, "verified");
    assert.equal(ctl.reviewStatusOf("preview-01.mp4", false, null, edl, { policy: "factory", unapproved: 3, approved_by: null }).review, "unreviewed");
    assert.equal(ctl.reviewStatusOf("preview-01.mp4", false, null, null, null).removedWords, null);
  });
  await check("listLabEdits never offers an unreviewed automatic cut (factory-e2e-test, 45 removals)", async () => {
    const edits = await ctl.listLabEdits();
    assert.ok(!edits.some((e) => e.id === "factory-e2e-test"), "factory-e2e-test is not in the picker");
    const lin = edits.find((e) => e.id === "linearity-10050728-8866")!;
    assert.equal(lin.videos[0].review, "final");
    const sh = edits.find((e) => e.id === "shorts-t7-1005-aaaa")!;
    assert.deepEqual(sh.videos.map((v) => v.review), ["final"]);              // preview-02 (no final-02) left out
    assert.equal(edits.find((e) => e.id === "onlypreview-1005-bbbb")!.videos[0].review, "reviewed");
    assert.deepEqual(ctl.ACCEPTED, ["final", "reviewed", "verified"]);
  });
  await check("createJob refuses an unreviewed automatic cut with a clear message — no override", async () => {
    const src = { kind: "job", job: "factory-e2e-test", file: "preview-01.mp4" };
    const e = await rejects(ctl.createJob({ ...base, source: src }), /unreviewed automatic cut \(49 spoken words removed\) that did not pass the word check/);
    assert.doesNotMatch(String(e.message), /tick|anyway/i);
    // a stale allowUnreviewed from an old client changes nothing
    await rejects(ctl.createJob({ ...base, source: src, allowUnreviewed: true } as any), /did not pass the word check/);
    // the automatic gate: a factory cut whose word check found 0 unapproved removals is accepted
    w("factory-e2e-test/wordiff.json", { policy: "factory", unapproved: 0, approved_by: null });
    const { id: j1 } = await ctl.createJob({ ...base, source: src });
    const r1 = JSON.parse(fs.readFileSync(path.join(jobs, j1, "request.json"), "utf8"));
    assert.deepEqual(r1.source, { ...src, title: "Factory end-to-end test (delete me)" });
    assert.equal((await ctl.listLabEdits()).find((x) => x.id === "factory-e2e-test")!.videos[0].review, "verified");
    fs.rmSync(path.join(jobs, "factory-e2e-test", "wordiff.json"));
    // Jake approved the cut as it is (optional review screen): accepted too
    w("factory-e2e-test/review.json", { edited: false, approved: true, videos: [] });
    const { id: j2 } = await ctl.createJob({ ...base, source: src });
    const r2 = JSON.parse(fs.readFileSync(path.join(jobs, j2, "request.json"), "utf8"));
    assert.equal(r2.source.allow_unreviewed, undefined);
    assert.equal((await ctl.listLabEdits()).find((x) => x.id === "factory-e2e-test")!.videos[0].review, "reviewed");
  });
  await check("Full edit: chain creative → a cut job with the factory policy + the creative inputs", async () => {
    const url = "https://share.descript.com/view/AbC123xyz";
    const full = { workflow: "cut", chain: "creative", url, format: "long", sponsored: true, script: "Hi.",
      sites: "linearity.io — the tool", runOn: "factory", title: "Linearity tour" } as const;
    const { id: jid } = await ctl.createJob(full);
    const req = JSON.parse(fs.readFileSync(path.join(jobs, jid, "request.json"), "utf8"));
    assert.equal(req.workflow, "cut");
    assert.equal(req.chain, "creative");
    assert.equal(req.takes_policy, "factory");
    assert.equal(req.no_edit, true);
    assert.deepEqual([req.format, req.sponsored, req.script, req.run_on], ["long", true, "Hi.", "factory"]);
    assert.deepEqual(req.sites, [{ url: "https://linearity.io/", note: "the tool" }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(jobs, jid, "queue.json"), "utf8")), { action: "run" });
    await rejects(ctl.createJob({ ...full, workflow: "creative" }), /starts from the raw recording/);
    await rejects(ctl.createJob({ ...full, chain: "other" as any }), /Unknown chain/);
    const { id: plain } = await ctl.createJob({ ...full, chain: undefined });
    const rp = JSON.parse(fs.readFileSync(path.join(jobs, plain, "request.json"), "utf8"));
    assert.equal(rp.chain, undefined);
    assert.equal(rp.takes_policy, undefined);
    assert.equal((await ctl.getJob(plain)).chain, null);
    // the job view's links: "Next: creative edit (queued)" and "Started from: <cut job>"
    let j = await ctl.getJob(jid);
    assert.deepEqual(j.chain, { isChain: true, step: null, next: null, from: null });
    w(`${jid}/chain.json`, { step: "creative", next: "linearity-tour-edit-10091200-abcd" });
    w("linearity-tour-edit-10091200-abcd/request.json", { title: "Linearity tour — edit", workflow: "creative", chained_from: jid,
      format: "long", sponsored: true, source: { kind: "job", job: jid, file: "final-01.mp4" } });
    w("linearity-tour-edit-10091200-abcd/status.json", { state: "queued" });
    w("linearity-tour-edit-10091200-abcd/queue.json", { action: "run" });
    j = await ctl.getJob(jid);
    assert.deepEqual(j.chain?.next, { id: "linearity-tour-edit-10091200-abcd", title: "Linearity tour — edit", state: "queued" });
    const c = await ctl.getJob("linearity-tour-edit-10091200-abcd");
    assert.deepEqual(c.chain?.from, { id: jid, title: "Linearity tour", state: "queued" });
    assert.equal(c.chain?.isChain, false);
  });
  await check("sweep: removes uploads idle > 2 days, keeps one a job still waits for", async () => {
    const old = await up.createUpload({ name: "old.mp4", size: 3 });
    const now = Date.now() + up.UPLOAD_TTL_MS + 1000;
    const removed = await up.sweepUploads(now);
    assert.ok(removed.includes(old.id), "abandoned upload removed");
    assert.ok(!removed.includes(id), "the claimed upload of a job without source.mp4 is kept");
    assert.ok(fs.existsSync(path.join(jobs, "_uploads", id)));
    // once the job holds source.mp4 it is fair game
    const jid = (await up.getUpload(id)).job!;
    fs.writeFileSync(path.join(jobs, jid, "source.mp4"), "x");
    assert.ok((await up.sweepUploads(now)).includes(id));
    assert.deepEqual(await up.sweepUploads(Date.now()), []);                   // fresh ones stay
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\naieditor-sources: ${passed} checks passed`);
}

main();
