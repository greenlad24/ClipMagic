/**
 * Unit checks for the Auto Editor MUSIC LIBRARY + per-job music (aieditor/music.ts), against a throwaway
 * AIEDITOR_WORK (no ffmpeg: the loudness/length measure is stubbed):
 *   choice     parseMusic (Auto / a track / none, the ±6 LU level refused outside) and choiceOf (the
 *              worker's reading, never throws)
 *   library    the Lab's tracks imported once with their titles (never one deleted here), listed with
 *              length + loudness + default, "Set as default", upload (mp3/wav/m4a only, needs audio),
 *              delete refused while a running / queued job will mix it (directly or as Auto's default)
 *   jobs       createJob stores request.json "music" (long-form only); Change music writes the choice and
 *              queues "remusic" only when a finished output carries a bed; refused while busy;
 *              getJob shows the "music" stage
 * Run:
 *   cd lab/server && npx tsx src/scripts/aieditor-music.test.ts
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

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipmagic-music-"));
  process.env.AIEDITOR_WORK = root;
  const jobs = path.join(root, "jobs");
  const lib = path.join(root, "music");
  const labUploads = path.join(root, "lab-uploads");
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(labUploads, { recursive: true });
  const wj = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(jobs, rel)), { recursive: true });
    fs.writeFileSync(path.join(jobs, rel), typeof data === "string" ? data : JSON.stringify(data));
  };
  const rj = (rel: string) => JSON.parse(fs.readFileSync(path.join(jobs, rel), "utf8"));

  const mu = await import("../aieditor/music.js");
  const ctl = await import("../aieditor/control.js");
  let measures = 0;
  mu.setMeasure(async (f) => {
    measures++;
    const txt = fs.readFileSync(f).toString();
    return txt.startsWith("AUDIO") ? { duration: 42.5, lufs: -18.25 } : { duration: null, lufs: null };
  });

  await check("parseMusic: Auto / a track / none, the level refused outside ±6", () => {
    assert.equal(mu.parseMusic(undefined), null);
    assert.deepEqual(mu.parseMusic({}), { track: null, gain_lu: 0 });
    assert.deepEqual(mu.parseMusic({ track: "auto", gain_lu: -2.26 }), { track: null, gain_lu: -2.3 });
    assert.deepEqual(mu.parseMusic({ track: "none" }), { track: "none", gain_lu: 0 });
    assert.deepEqual(mu.parseMusic({ track: "FLUEJOMVaK6Z3SrFJmclQ.wav", gain_lu: 6 }), { track: "FLUEJOMVaK6Z3SrFJmclQ.wav", gain_lu: 6 });
    assert.throws(() => mu.parseMusic({ track: "../etc/passwd" }), /Unknown music track/);
    assert.throws(() => mu.parseMusic({ gain_lu: 7 }), /−6|-6/);
    assert.throws(() => mu.parseMusic({ gain_lu: "loud" }), /level/);
  });
  await check("choiceOf reads what the worker reads (clamped, never throws)", () => {
    assert.deepEqual(mu.choiceOf({}), { track: null, gain_lu: 0 });
    assert.deepEqual(mu.choiceOf({ music: { track: "x/y.wav", gain_lu: 99 } }), { track: null, gain_lu: 6 });
    assert.deepEqual(mu.choiceOf({ music: { track: "none" } }), { track: "none", gain_lu: 0 });
  });

  // the library: one track copied by hand (as on the box), two Lab tracks
  fs.writeFileSync(path.join(lib, "FLUEJOMVaK6Z3SrFJmclQ.wav"), "AUDIO sherlock");
  fs.writeFileSync(path.join(lib, "FLUEJOMVaK6Z3SrFJmclQ.wav.lufs"), "-21.5");
  fs.writeFileSync(path.join(labUploads, "FLUEJOMVaK6Z3SrFJmclQ.wav"), "AUDIO sherlock");
  fs.writeFileSync(path.join(labUploads, "X5RLEsdHYxFeH7rMrCrFh.wav"), "AUDIO pizzicato");
  fs.writeFileSync(path.join(labUploads, "96mKiTUqNJuUXDuAhb7RZ.wav"), "AUDIO curiouser");
  const lab = async () => [
    { labId: "L1", title: "Cello Sherlok", file: path.join(labUploads, "FLUEJOMVaK6Z3SrFJmclQ.wav") },
    { labId: "L2", title: "Cello Pizzicato", file: path.join(labUploads, "X5RLEsdHYxFeH7rMrCrFh.wav") },
    { labId: "L3", title: "Gone", file: path.join(labUploads, "missing.wav") },
    { labId: "L4", title: "Curiouser Celloloop", file: path.join(labUploads, "96mKiTUqNJuUXDuAhb7RZ.wav") },
  ];

  await check("the Lab's tracks are imported once, with their titles; facts measured once and cached", async () => {
    const a = await mu.listMusic({ lab });
    assert.deepEqual(a.tracks.map((t) => [t.id, t.title]), [["96mKiTUqNJuUXDuAhb7RZ.wav", "Curiouser Celloloop"],
      ["FLUEJOMVaK6Z3SrFJmclQ.wav", "Cello Sherlok"], ["X5RLEsdHYxFeH7rMrCrFh.wav", "Cello Pizzicato"]]);
    assert.equal(a.tracks[1].lufs, -21.5);                     // the worker's cached value is kept
    assert.equal(a.tracks[2].lufs, -18.25);
    assert.equal(a.tracks[2].duration, 42.5);
    // Auto still means the track every edit used so far, though an import sorts before it
    assert.equal(a.default, "FLUEJOMVaK6Z3SrFJmclQ.wav");
    assert.equal(fs.readFileSync(path.join(lib, "X5RLEsdHYxFeH7rMrCrFh.wav.lufs"), "utf8"), "-18.25");
    const n = measures;
    await mu.listMusic({ lab });
    assert.equal(measures, n, "cached facts are not measured again");
  });

  await check("Set as default", async () => {
    await mu.setDefault("X5RLEsdHYxFeH7rMrCrFh.wav");
    const a = await mu.listMusic({ lab });
    assert.equal(a.default, "X5RLEsdHYxFeH7rMrCrFh.wav");
    assert.equal(a.tracks.find((t) => t.isDefault)?.id, "X5RLEsdHYxFeH7rMrCrFh.wav");
    await assert.rejects(mu.setDefault("nope.wav"), /Unknown track/);
  });

  await check("upload: mp3/wav/m4a with audio, measured and listed; anything else refused", async () => {
    const t = await mu.uploadTrack("My_Bed Track.mp3", Readable.from([Buffer.from("AUDIO bed")]), 9);
    assert.match(t.id, /^m[0-9a-f]{16}\.mp3$/);
    assert.equal(t.title, "My Bed Track");
    const a = await mu.listMusic({ lab });
    assert.ok(a.tracks.some((x) => x.id === t.id && x.origin === "upload" && x.duration === 42.5));
    await assert.rejects(mu.uploadTrack("x.exe", Readable.from([Buffer.from("AUDIO")]), 5), /Music files/);
    await assert.rejects(mu.uploadTrack("x.wav", Readable.from([Buffer.from("not audio")]), 9), /no playable audio/);
    await assert.rejects(mu.uploadTrack("x.wav", Readable.from([Buffer.from("AUDIO")]), 999), /cut off/);
    assert.ok(!fs.readdirSync(lib).some((f) => f.endsWith(".part")), "no partial file left");
  });

  await check("delete: refused while a running or queued job will mix it (also as Auto's default)", async () => {
    wj("busy-job-1/request.json", { format: "long", title: "Busy", music: { track: "FLUEJOMVaK6Z3SrFJmclQ.wav" } });
    wj("busy-job-1/status.json", { state: "running" });
    wj("queued-auto-1/request.json", { format: "long", title: "Queued auto" });
    wj("queued-auto-1/status.json", { state: "done" });
    wj("queued-auto-1/queue.json", { action: "run" });
    wj("idle-job-1/request.json", { format: "long", music: { track: "FLUEJOMVaK6Z3SrFJmclQ.wav" } });
    wj("idle-job-1/status.json", { state: "done" });
    const a = await mu.listMusic({ lab });
    assert.deepEqual(a.tracks.find((t) => t.id === "FLUEJOMVaK6Z3SrFJmclQ.wav")?.usedBy.map((u) => u.id), ["busy-job-1"]);
    assert.deepEqual(a.tracks.find((t) => t.id === "X5RLEsdHYxFeH7rMrCrFh.wav")?.usedBy.map((u) => u.id), ["queued-auto-1"]);
    await assert.rejects(mu.deleteTrack("FLUEJOMVaK6Z3SrFJmclQ.wav"), /Busy” is using this track/);
    await assert.rejects(mu.deleteTrack("X5RLEsdHYxFeH7rMrCrFh.wav"), /Queued auto/);
    assert.ok(fs.existsSync(path.join(lib, "FLUEJOMVaK6Z3SrFJmclQ.wav")));
  });

  await check("delete when free: the file + its facts go, a Lab track is not imported again", async () => {
    fs.rmSync(path.join(jobs, "queued-auto-1", "queue.json"));
    await mu.deleteTrack("X5RLEsdHYxFeH7rMrCrFh.wav");
    assert.ok(!fs.existsSync(path.join(lib, "X5RLEsdHYxFeH7rMrCrFh.wav")));
    assert.ok(!fs.existsSync(path.join(lib, "X5RLEsdHYxFeH7rMrCrFh.wav.lufs")));
    const a = await mu.listMusic({ lab });
    assert.ok(!a.tracks.some((t) => t.id === "X5RLEsdHYxFeH7rMrCrFh.wav"), "a deleted Lab track stays deleted");
    assert.equal(a.default, "96mKiTUqNJuUXDuAhb7RZ.wav", "a deleted default falls back to the first track");
  });

  await check("createJob stores the music (long-form only) and refuses a bad level", async () => {
    const base = { url: "https://share.descript.com/view/AbC123xyz", workflow: "cut", sponsored: false, title: "M" };
    const a = await ctl.createJob({ ...base, format: "long", music: { track: "none", gain_lu: 0 } });
    assert.deepEqual(rj(`${a.id}/request.json`).music, { track: "none", gain_lu: 0 });
    const b = await ctl.createJob({ ...base, format: "long" });
    assert.equal(rj(`${b.id}/request.json`).music, undefined, "no choice = no field = Auto");
    const c = await ctl.createJob({ ...base, format: "short", music: { track: "none" } });
    assert.equal(rj(`${c.id}/request.json`).music, undefined, "shorts have no bed");
    await assert.rejects(ctl.createJob({ ...base, format: "long", music: { gain_lu: 12 } }), /level/);
    for (const id of [a.id, b.id, c.id]) fs.rmSync(path.join(jobs, id), { recursive: true });
  });

  await check("Change music: saved + 'remusic' queued only with a finished edit carrying a bed", async () => {
    const J = "done-edit-1";
    wj(`${J}/request.json`, { format: "long", title: "Done" });
    wj(`${J}/status.json`, { state: "done", stages: {} });
    wj(`${J}/edl.json`, { videos: [{ words: [] }] });
    let m = await mu.jobMusic(J);
    assert.equal(m.canChange, false);
    assert.match(String(m.why), /build the edit first/);
    await assert.rejects(mu.changeJobMusic(J, { track: "none" }, true), /build the edit first/);
    // a full edit: edit-01.mp4 composed (the filter script) + final-01.mp4 of the plain cut (no bed)
    wj(`${J}/edit-01/direct.json`, { plan: {} });
    wj(`${J}/edit-01.mp4`, "v");
    wj(`${J}/edit-01/edit-01.filter.txt`, "x");
    wj(`${J}/final-01.mp4`, "v");
    m = await mu.jobMusic(J);
    assert.deepEqual(m.outputs, ["edit-01.mp4"]);
    assert.equal(m.canChange, true);
    await assert.rejects(mu.changeJobMusic(J, { track: "gone.wav" }, true), /not in the library/);
    const r = await mu.changeJobMusic(J, { track: "FLUEJOMVaK6Z3SrFJmclQ.wav", gain_lu: -3 }, true);
    assert.equal(r.queued, true);
    assert.deepEqual(rj(`${J}/request.json`).music, { track: "FLUEJOMVaK6Z3SrFJmclQ.wav", gain_lu: -3 });
    assert.deepEqual(rj(`${J}/queue.json`), { action: "remusic" });
    await assert.rejects(mu.changeJobMusic(J, { track: "none" }, true), /Wait for the current step/);
    const g = await ctl.getJob(J);
    assert.ok(g.stageList.some((s) => s.id === "music"), "the queued change shows its stage");
    assert.deepEqual(g.request.music, { track: "FLUEJOMVaK6Z3SrFJmclQ.wav", gain_lu: -3 });
    // a hand-off package counts too; a short never
    fs.rmSync(path.join(jobs, J, "queue.json"));
    wj(`${J}/handoff-01/audio/voice.wav`, "a");
    wj(`${J}/handoff-01.json`, {});
    assert.deepEqual((await mu.jobMusic(J)).outputs, ["edit-01.mp4", "handoff-01.zip"]);
    wj(`${J}/status.json`, { state: "held", held: true, stages: {} });
    assert.match(String((await mu.jobMusic(J)).why), /held/);
    wj("a-short-1/request.json", { format: "short" });
    await assert.rejects(mu.changeJobMusic("a-short-1", { track: "none" }, true), /Shorts/);
    await assert.rejects(mu.jobMusic("../etc"), /Unknown job/);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`aieditor-music: ${passed} checks passed${process.exitCode ? " — FAILURES above" : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
