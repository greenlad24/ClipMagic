/**
 * Unit checks for the render queue's bulk delete (hyperframes/jobs → deleteJobs).
 *
 * ⚠️ WHAT THIS IS GUARDING. Jake's ask was "multi select and delete (and it
 * would actually delete each selected item)" — the parenthesis is the real
 * requirement. The ways a bulk delete quietly does less than it says are all
 * cheap to write and invisible from the UI: one bad id aborting the loop, a
 * `Promise.all` rejecting on the first failure, `fsp.rm(force: true)` resolving
 * after removing nothing, a running job silently skipped, a duplicated id
 * reported as an error. Each of those leaves gigabytes on disk under a toast
 * that says "Deleted 12".
 *
 * Runs against a throwaway HYPERFRAMES_WORK, so the real /hyperframes-work is
 * never touched — every assertion below is a real mkdir and a real rm. Run:
 *   cd lab/server && npx tsx src/scripts/hyperframesDeleteJobs.test.ts
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-hf-delete-"));
  process.env.HYPERFRAMES_WORK = root;
  process.env.DATA_DIR = root;
  process.env.DB_PATH = path.join(root, "db", "test.db");
  fs.mkdirSync(path.join(root, "db"), { recursive: true });

  const jobsDir = path.join(root, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  /** A job on disk: spec, status, and something with weight in it. */
  const makeJob = (id: string, state: string, payloadBytes = 4096) => {
    const dir = path.join(jobsDir, id);
    fs.mkdirSync(path.join(dir, "output"), { recursive: true });
    fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ name: `Job ${id}` }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state, output: "out.mp4" }));
    fs.writeFileSync(path.join(dir, "output", "out.mp4"), Buffer.alloc(payloadBytes, 1));
    fs.writeFileSync(path.join(dir, "cache", "frames.bin"), Buffer.alloc(payloadBytes, 2));
    return dir;
  };

  const { deleteJobs } = await import("../hyperframes/jobs.js");
  const gone = (id: string) => !fs.existsSync(path.join(jobsDir, id));

  await check("every selected job is actually gone from disk", async () => {
    for (const id of ["a1", "a2", "a3"]) makeJob(id, "done");
    const r = await deleteJobs(["a1", "a2", "a3"]);
    assert.deepEqual(r.deleted.sort(), ["a1", "a2", "a3"]);
    assert.equal(r.failed.length, 0);
    // The claim and the disk, checked separately — the whole point.
    assert.ok(gone("a1") && gone("a2") && gone("a3"), "directories still on disk");
    assert.ok(r.freedBytes >= 8192 * 3, `freedBytes looks wrong: ${r.freedBytes}`);
  });

  await check("one bad id does not stop the others", async () => {
    // ⚠️ THE REGRESSION THAT MATTERS. Put the unknown id FIRST: a loop that
    // throws, or a Promise.all, loses b1 and b2 here and says so about nothing.
    makeJob("b1", "done");
    makeJob("b2", "failed");
    const r = await deleteJobs(["nope-not-a-job", "b1", "b2"]);
    assert.deepEqual(r.deleted.sort(), ["b1", "b2"]);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].id, "nope-not-a-job");
    assert.ok(gone("b1") && gone("b2"));
  });

  await check("a running job is cancelled, not deleted, and says so", async () => {
    // Deleting the directory under a live container leaves the render writing
    // into a deleted mount, so it gets a cancel file and a second go instead.
    makeJob("c1", "running");
    makeJob("c2", "done");
    const r = await deleteJobs(["c1", "c2"]);
    assert.deepEqual(r.deleted, ["c2"]);
    assert.deepEqual(r.cancelling, ["c1"]);
    assert.equal(r.failed.length, 0, "a running job is not a failure");
    assert.ok(!gone("c1"), "a running job must survive the call");
    assert.ok(fs.existsSync(path.join(jobsDir, "c1", "cancel")), "no cancel file was written");
    // …and the second go, once it has stopped, finishes it off.
    fs.writeFileSync(path.join(jobsDir, "c1", "status.json"), JSON.stringify({ state: "cancelled" }));
    const again = await deleteJobs(["c1"]);
    assert.deepEqual(again.deleted, ["c1"]);
    assert.ok(gone("c1"));
  });

  await check("the same id twice is one delete, not one delete and one error", async () => {
    makeJob("d1", "done");
    const r = await deleteJobs(["d1", "d1", " d1 ", ""]);
    assert.deepEqual(r.deleted, ["d1"]);
    assert.equal(r.failed.length, 0);
    assert.ok(gone("d1"));
  });

  await check("keepOutput strips the footage and keeps the MP4", async () => {
    makeJob("e1", "done");
    const r = await deleteJobs(["e1"], true);
    assert.deepEqual(r.deleted, ["e1"]);
    assert.ok(!gone("e1"), "the job itself should still be listed");
    assert.ok(fs.existsSync(path.join(jobsDir, "e1", "output", "out.mp4")), "the MP4 was deleted");
    assert.ok(!fs.existsSync(path.join(jobsDir, "e1", "cache")), "the frame cache survived");
    assert.ok(r.freedBytes >= 4096, `freedBytes looks wrong: ${r.freedBytes}`);
  });

  await check("an empty selection is a no-op, not a crash", async () => {
    const r = await deleteJobs([]);
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.failed, []);
    assert.equal(r.freedBytes, 0);
  });

  await check("an id cannot climb out of the jobs directory", async () => {
    // `jobDir` goes through safeJoin; this asserts bulk delete inherits it
    // rather than joining paths of its own.
    const outside = path.join(root, "precious.txt");
    fs.writeFileSync(outside, "do not delete me");
    const r = await deleteJobs(["../precious.txt", "../../etc"]);
    assert.equal(r.deleted.length, 0);
    assert.equal(r.failed.length, 2);
    assert.ok(fs.existsSync(outside), "traversal deleted a file outside jobs/");
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

void main();
