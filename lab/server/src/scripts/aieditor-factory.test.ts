/**
 * Unit checks for the Auto Editor's VIDEO FACTORY panel (aieditor/factory.ts) and the
 * run_on plumbing in aieditor/control.ts, against a throwaway AIEDITOR_WORK:
 *   - getFactory()            hides the snapshot manifest + VPC internals, prices live
 *                             servers, sums only this UTC month, newest history first
 *   - leftover detection      a tagged droplet with no lease (past the grace) is flagged;
 *                             a droplet WITHOUT our tag is never shown even if the API
 *                             returned it; the token never appears in the payload
 *   - saveFactorySettings()   validates, keeps every key it does not own, refuses "on"
 *                             without a snapshot
 *   - requestImageRebuild()   drops the request file, refuses while a build runs
 *   - createJob/continueJob   write request.json run_on; getJob returns runner.json
 * Run:
 *   cd lab/server && npx tsx src/scripts/aieditor-factory.test.ts
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

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);          // 2026-10-08 12:00 UTC
const S = NOW / 1000;
const TOKEN = "dop_v1_test_secret_value_123456";

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-factory-"));
  process.env.AIEDITOR_WORK = root;
  const w = (rel: string, obj: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof obj === "string" ? obj : JSON.stringify(obj));
  };
  w("factory.json", {
    enabled: false, region: "sgp1", size: "c-32", snapshot_id: 111, snapshot_name: "factory-image-x",
    snapshot_at: S - 3600, snapshot_manifest: { a: "sha256:1" }, vpc_uuid: "secret-vpc", vpc_range: "10.0.0.0/20",
    actions: ["run"], max_parallel: 2, max_hours: 10, fallback_local: true, lease_stale_s: 600,
  });
  w("jobs/my-job-1/request.json", { id: "my-job-1", title: "Linearity tutorial", format: "long" });
  w("jobs/my-job-1/runner.json", { kind: "factory", state: "running", size: "c-32" });
  w("factory-leases/500.json", { droplet: 500, job: "my-job-1", action: "final", size: "c-32", created: S - 1800, heartbeat: S - 3 });
  w("factory-history.jsonl", [
    { job: "old", action: "run", droplet: 1, size: "c-32", started: Date.UTC(2026, 8, 30) / 1000, ended: 0, minutes: 60, usd: 1, ok: true, destroyed: true },
    { job: "my-job-1", action: "run", droplet: 2, size: "c-32", started: S - 7200, ended: S - 6600, minutes: 10, usd: 0.17, ok: true, destroyed: true },
    { job: "my-job-1", action: "final", droplet: 3, size: "c-16", started: S - 5000, ended: S - 4000, minutes: 16.7, usd: 0.14, ok: false, destroyed: true },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n{torn");
  w("worker-heartbeat.json", { at: S - 5, pid: 1, factory_jobs: 1 });

  const factory = await import("../aieditor/factory.js");
  const control = await import("../aieditor/control.js");

  const seen: string[] = [];
  const fakeFetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(String(url));
    assert.equal(init?.headers?.Authorization, `Bearer ${TOKEN}`);
    const tag = new URL(String(url)).searchParams.get("tag_name");
    const droplets = tag === factory.TAG_JOB
      ? [
        { id: 500, name: "factory-my-job-1", size_slug: "c-32", status: "active", created_at: new Date(NOW - 1800e3).toISOString(), tags: [factory.TAG_JOB] },
        { id: 501, name: "factory-lost", size_slug: "c-32", status: "active", created_at: new Date(NOW - 3600e3).toISOString(), tags: [factory.TAG_JOB] },
        { id: 502, name: "factory-new", size_slug: "c-32", status: "new", created_at: new Date(NOW - 30e3).toISOString(), tags: [factory.TAG_JOB] },
        { id: 999, name: "someone-elses-db", size_slug: "s-1vcpu", status: "active", created_at: "2025-01-01T00:00:00Z", tags: ["prod"] },
      ]
      : [];
    return { ok: true, status: 200, json: async () => ({ droplets }) };
  }) as unknown as typeof fetch;
  const deps = { token: () => TOKEN, fetchImpl: fakeFetch, now: () => NOW };

  await check("GET hides manifest + VPC, maps settings", async () => {
    const g = await factory.getFactory(deps);
    const json = JSON.stringify(g);
    assert.ok(!json.includes("snapshot_manifest"));
    assert.ok(!json.includes("secret-vpc"));
    assert.ok(!json.includes(TOKEN), "token leaked into the payload");
    assert.equal(g.tokenSet, true);
    assert.equal(g.settings.enabled, false);
    assert.equal(g.settings.maxParallel, 2);
    assert.deepEqual(g.snapshot, { id: 111, name: "factory-image-x", builtAt: S - 3600 });
    assert.equal(g.worker.alive, true);
    assert.equal(g.worker.factoryJobs, 1);
  });

  await check("live server: title, state, elapsed, est $", async () => {
    const g = await factory.getFactory(deps);
    assert.equal(g.live.length, 1);
    const l = g.live[0];
    assert.equal(l.title, "Linearity tutorial");
    assert.equal(l.state, "running");
    assert.equal(l.elapsedMin, 30);
    assert.equal(l.estUsd, 0.5);
    assert.equal(l.stale, false);
  });

  await check("month = this UTC month only; history newest first; torn line skipped", async () => {
    const g = await factory.getFactory(deps);
    assert.equal(g.month.runs, 2);
    assert.equal(g.month.serverUsd, 0.31);
    assert.equal(g.month.liveUsd, 0.5);
    assert.equal(g.month.volumeUsd, 50);
    assert.equal(g.month.budgetUsd, 100);
    assert.equal(g.history.length, 3);
    assert.equal(g.history[0].droplet, 3);
    assert.equal(g.history[0].title, "Linearity tutorial");
  });

  await check("tagged droplets: leftover flagged, fresh one in grace, untagged never shown", async () => {
    factory.resetDoCache();
    const g = await factory.getFactory(deps);
    assert.ok(g.doTagged);
    const ids = g.doTagged!.map((d) => d.id).sort();
    assert.deepEqual(ids, [500, 501, 502]);
    const by = Object.fromEntries(g.doTagged!.map((d) => [d.id, d.leftover]));
    assert.deepEqual(by, { 500: false, 501: true, 502: false });
    assert.ok(seen.every((u) => /tag_name=clipmagic-factory-(job|image)/.test(u)), "asked for untagged droplets");
  });

  await check("no token → doTagged null, no API call", async () => {
    factory.resetDoCache();
    const before = seen.length;
    const g = await factory.getFactory({ token: () => null, fetchImpl: fakeFetch, now: () => NOW });
    assert.equal(g.doTagged, null);
    assert.equal(g.tokenSet, false);
    assert.equal(seen.length, before);
  });

  await check("POST settings validates and preserves unknown keys", async () => {
    await assert.rejects(factory.saveFactorySettings({ size: "c-64" }), /c-16 or c-32/);
    await assert.rejects(factory.saveFactorySettings({ maxParallel: 5 }), /1–4/);
    await assert.rejects(factory.saveFactorySettings({ enabled: "yes" }), /true or false/);
    const g = await factory.saveFactorySettings({ enabled: true, size: "c-16", maxParallel: 3, fallbackLocal: false }, deps);
    assert.equal(g.settings.size, "c-16");
    const disk = JSON.parse(fs.readFileSync(path.join(root, "factory.json"), "utf8"));
    assert.equal(disk.enabled, true);
    assert.equal(disk.max_parallel, 3);
    assert.equal(disk.fallback_local, false);
    assert.deepEqual(disk.snapshot_manifest, { a: "sha256:1" });
    assert.equal(disk.vpc_uuid, "secret-vpc");
    assert.equal(disk.lease_stale_s, 600);
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes(".tmp")), []);
  });

  await check("cannot switch on without a snapshot", async () => {
    const disk = JSON.parse(fs.readFileSync(path.join(root, "factory.json"), "utf8"));
    w("factory.json", { ...disk, snapshot_id: null, enabled: false });
    await assert.rejects(factory.saveFactorySettings({ enabled: true }), /server image first/);
    w("factory.json", disk);
  });

  await check("image rebuild: request file, refused while building", async () => {
    const r = await factory.requestImageRebuild();
    assert.equal(r.requested, true);
    assert.ok(fs.existsSync(path.join(root, "factory-image.request")));
    assert.equal((await factory.getFactory(deps)).image.requested, true);
    fs.unlinkSync(path.join(root, "factory-image.request"));
    w("factory-image.json", { state: "building", started: S, log: ["a"] });
    const r2 = await factory.requestImageRebuild();
    assert.equal(r2.requested, false);
    assert.ok(!fs.existsSync(path.join(root, "factory-image.request")));
  });

  await check("createJob writes run_on; continueJob changes it; getJob returns runner", async () => {
    const base = { url: "https://share.descript.com/view/AbC123xyz", workflow: "cut", format: "short", sponsored: false, title: "T" };
    await assert.rejects(control.createJob({ ...base, runOn: "moon" }), /auto, factory or box/);
    const a = await control.createJob(base);
    const b = await control.createJob({ ...base, runOn: "box" });
    const rq = (id: string) => JSON.parse(fs.readFileSync(path.join(root, "jobs", id, "request.json"), "utf8"));
    assert.equal(rq(a.id).run_on, "auto");
    assert.equal(rq(b.id).run_on, "box");
    await control.continueJob(b.id, "factory");
    assert.equal(rq(b.id).run_on, "factory");
    await control.continueJob(b.id);
    assert.equal(rq(b.id).run_on, "factory");
    assert.equal((await control.getJob(b.id)).runner, null);
    w(`jobs/${b.id}/runner.json`, { kind: "box", state: "running" });
    assert.equal((await control.getJob(b.id)).runner?.kind, "box");
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
}

void main();
