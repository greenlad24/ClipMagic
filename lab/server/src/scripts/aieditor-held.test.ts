/**
 * The HELD state in the Lab (architecture recommendation §4: a video that fails the ship rule is
 * "held", never shipped quietly), against a throwaway AIEDITOR_WORK:
 *   listJobs      a held job is labelled "held" (status.state "held", or p1's status.held = true)
 *   getJob        status "held", the failure list (held.json reasons + failures, or status.held_failures),
 *                 the rubric scores per edit, and its edit/final files moved out of `edits`/`finals`
 *   listLabEdits  a held cut job is never a finished edit; parseSource refuses it as a creative source
 *   renderFinal   refused for a held edit
 * Run:
 *   cd lab/server && npx tsx src/scripts/aieditor-held.test.ts
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-held-"));
  process.env.AIEDITOR_WORK = root;
  const jobs = path.join(root, "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const w = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(jobs, rel)), { recursive: true });
    fs.writeFileSync(path.join(jobs, rel), typeof data === "string" ? data : JSON.stringify(data));
  };
  const c = await import("../aieditor/control.js");

  // a creative edit the worker held: two failure lines + a verdict with rubric scores
  w("held-creative/request.json", { id: "held-creative", format: "long", workflow: "creative", title: "Held one",
    source: { kind: "descript", url: "https://share.descript.com/view/abcdef" }, created_at: 2 });
  w("held-creative/status.json", { state: "held", held: true, message: "Held — 2 failure(s), not shipped",
    held_failures: [
      { dim: "D1", beat: "toolbar", t: 132.4, why: "screencast 3: 29.3 s of planned screencast lost (challenge)", remedies_tried: ["rerecord_beat", "rerecord_beat", "salvage"] },
      { dim: "D7", beat: null, t: null, why: "coverage: screencast share 43% outside the reference 72%-76%", remedies_tried: [] },
    ], stages: {} });
  w("held-creative/held.json", { reasons: [], failures: [] });
  w("held-creative/edit-01/verdict.json", { held: true, dims: { D2: 22.5, D7: 20, D9: 0 }, overall: 20,
    ship: { ship: false, fails: ["D1 not measured (no calibrated judge)"] }, failures: [] });
  w("held-creative/edit-01.mp4", "x");
  w("held-creative/preview-01.mp4", "x");
  // p1's representation (state failed + held: true + held.json reasons) is held too
  w("held-p1/request.json", { id: "held-p1", format: "long", workflow: "creative", title: "Held by p1",
    source: { kind: "descript", url: "https://share.descript.com/view/abcdef" }, created_at: 1 });
  w("held-p1/status.json", { state: "failed", held: true, message: "Held — needs_scripted_recorder", stages: {} });
  w("held-p1/held.json", { reasons: [{ reason: "needs_scripted_recorder", detail: "edit 1 screencast 3 (chatgpt)" }] });
  // a held CUT job with a preview: never a finished Lab edit / creative source
  w("held-cut/request.json", { id: "held-cut", format: "long", workflow: "cut", title: "Held cut", created_at: 3,
    source: { kind: "descript", url: "https://share.descript.com/view/abcdef" } });
  w("held-cut/status.json", { state: "held", held: true, stages: {} });
  w("held-cut/review.json", { approved: true });
  w("held-cut/edl.json", { videos: [{ title: "v", duration: 10, joins: [] }] });
  w("held-cut/preview-01.mp4", "x");
  // a normal finished cut job
  w("done-cut/request.json", { id: "done-cut", format: "long", workflow: "cut", title: "Done cut", created_at: 4,
    source: { kind: "descript", url: "https://share.descript.com/view/abcdef" } });
  w("done-cut/status.json", { state: "done", stages: {} });
  w("done-cut/review.json", { approved: true });
  w("done-cut/edl.json", { videos: [{ title: "v", duration: 10, joins: [] }] });
  w("done-cut/preview-01.mp4", "x");

  await check("isHeld: state held or status.held", () => {
    assert.equal(c.isHeld({ state: "held" }), true);
    assert.equal(c.isHeld({ state: "failed", held: true }), true);
    assert.equal(c.isHeld({ state: "done" }), false);
    assert.equal(c.isHeld(null), false);
  });
  await check("heldFailuresOf: reasons first, then failures (pure)", () => {
    const f = c.heldFailuresOf({}, { reasons: [{ reason: "API cap", detail: "$30/24 h" }],
      failures: [{ dim: "D1", t: 3, why: "lost", remedies_tried: ["salvage"] }] }, []);
    assert.deepEqual(f.map((x) => x.dim), ["held", "D1"]);
    assert.equal(f[0].why, "API cap ($30/24 h)");
    assert.deepEqual(f[1].remedies_tried, ["salvage"]);
  });
  await check("listJobs labels held jobs 'held'", async () => {
    const list = await c.listJobs();
    const by = Object.fromEntries(list.map((j: any) => [j.id, j]));
    assert.equal(by["held-creative"].state, "held");
    assert.equal(by["held-creative"].held, true);
    assert.equal(by["held-p1"].state, "held");
    assert.equal(by["done-cut"].state, "done");
    assert.equal(by["done-cut"].held, false);
  });
  await check("getJob: held status, the failure list, scores, edits not finished", async () => {
    const j: any = await c.getJob("held-creative");
    assert.equal(j.status.state, "held");
    assert.equal(j.held.failures.length, 2);
    assert.equal(j.held.failures[0].dim, "D1");
    assert.equal(j.held.failures[0].t, 132.4);
    assert.deepEqual(j.held.scores[0].dims, { D2: 22.5, D7: 20, D9: 0 });
    assert.deepEqual(j.edits, []);
    assert.deepEqual(j.finals, []);
    assert.deepEqual(j.heldEdits.map((x: any) => x.name), ["edit-01.mp4"]);
  });
  await check("getJob: p1's held reasons show as the failure list", async () => {
    const j: any = await c.getJob("held-p1");
    assert.equal(j.status.state, "held");
    assert.match(j.held.failures[0].why, /needs_scripted_recorder/);
  });
  await check("getJob: a finished job is not held", async () => {
    const j: any = await c.getJob("done-cut");
    assert.equal(j.held, null);
    assert.deepEqual(j.heldEdits, []);
  });
  await check("listLabEdits never lists a held edit", async () => {
    const ids = (await c.listLabEdits()).map((e: any) => e.id);
    assert.ok(ids.includes("done-cut"));
    assert.ok(!ids.includes("held-cut"));
  });
  await check("a held edit is refused as a creative source", async () => {
    await assert.rejects(c.parseSource({ source: { kind: "job", job: "held-cut", file: "preview-01.mp4" } } as any, "creative"),
      /held/);
    const ok: any = await c.parseSource({ source: { kind: "job", job: "done-cut", file: "preview-01.mp4" } } as any, "creative");
    assert.equal(ok.kind, "job");
  });
  await check("renderFinal refuses a held edit", async () => {
    w("held-creative/edl.json", { videos: [{ title: "v", duration: 10, joins: [] }] });
    await assert.rejects(c.renderFinal("held-creative"), /held/);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`aieditor-held: ${passed} checks passed`);
}

void main();
