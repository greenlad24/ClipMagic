/**
 * Auto Editor — the Lab's view of a job (raw narration → clean edit).
 *
 * ⚠️ THIS MODULE IS A CONTROL PLANE, NOT A RUNNER — the same split as the Render
 * queue and the Video Editor. It writes request.json / queue.json / cancel /
 * plan.edit.json into a job directory and reads files back. The
 * `aieditor-worker` systemd service on the HOST (/opt/clipmagic/aieditor) does all
 * media work: it shells out to Docker for ffmpeg and the aligner, and a 46-minute
 * job must outlive this container, a Lab rebuild and the browser tab.
 *
 *   /aieditor-work/jobs/<id>/   (host: /opt/aieditor-work/jobs/<id>/)
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = process.env.AIEDITOR_WORK || "/aieditor-work";
const JOBS = path.join(ROOT, "jobs");
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SHARE_RE = /^https:\/\/share\.descript\.com\/view\/[A-Za-z0-9_-]{6,64}\/?$/;
const MAX_SCRIPT = 200_000;

export const STAGES: { id: string; title: string }[] = [
  { id: "download", title: "Download from Descript" },
  { id: "audio", title: "Extract audio" },
  { id: "transcribe", title: "Transcribe (word level)" },
  { id: "align", title: "Re-time every word" },
  { id: "takes", title: "Pick the best takes" },
  { id: "cut", title: "Build the cut" },
  { id: "listen", title: "Sound check" },
  { id: "graphics", title: "Plan graphics + camera, render graphics" },
  { id: "preview", title: "Render video preview" },
  { id: "compose", title: "Composite graphics + captions + SFX" },
  { id: "final", title: "Final render (full resolution)" },
];

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(file: string, obj: unknown) {
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 1));
  await fsp.rename(tmp, file);
}

function jobDir(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Unknown job.");
  return path.join(JOBS, id);
}

async function exists(file: string) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function serviceStatus() {
  const hb = await readJson<{ at: number }>(path.join(ROOT, "worker-heartbeat.json"));
  const seen = hb?.at ?? null;
  return {
    workerAlive: !!seen && Date.now() / 1000 - seen < 30,
    workerSeenAt: seen,
    stages: STAGES,
  };
}

export interface CreateInput {
  url?: string;
  format?: string;
  sponsored?: boolean | null;
  script?: string;
  title?: string;
  /** long-form: websites the screencasts may show, one per line */
  sites?: string;
}

/** "one URL per line (optional: url — note)" → [{url, note}], public http(s) only, ≤ 6 */
function parseSites(raw: unknown): { url: string; note: string }[] {
  const out: { url: string; note: string }[] = [];
  for (const line of String(raw ?? "").split(/\n+/)) {
    const [u, ...rest] = line.trim().split(/\s+[—-]\s+/);
    if (!u) continue;
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); } catch { throw new Error(`Not a website address: ${u}`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(`Not a website address: ${u}`);
    out.push({ url: url.toString(), note: rest.join(" — ").slice(0, 200) });
  }
  if (out.length > 6) throw new Error("Up to 6 websites.");
  return out;
}

export async function createJob(input: CreateInput) {
  const url = String(input.url ?? "").trim();
  if (!SHARE_RE.test(url)) {
    throw new Error("Paste a Descript share link like https://share.descript.com/view/AbC123xyz");
  }
  if (input.format !== "short" && input.format !== "long") throw new Error("Choose Shorts or Long-form.");
  // Jake: "important you know if it's sponsored or not" — never defaulted.
  if (input.sponsored !== true && input.sponsored !== false) throw new Error("Say whether the video is sponsored.");
  const script = String(input.script ?? "");
  if (script.length > MAX_SCRIPT) throw new Error("The script is too long.");
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
  const slug = String(input.title || url.split("/").filter(Boolean).pop() || "job")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "job";
  const id = `${slug}-${stamp}-${randomBytes(2).toString("hex")}`;
  const dir = path.join(JOBS, id);
  await fsp.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "request.json"), {
    id,
    source: { kind: "descript", url },
    format: input.format,
    sponsored: input.sponsored,
    script: script.trim() || null,
    title: input.title ? String(input.title).slice(0, 120) : null,
    sites: input.format === "long" ? parseSites(input.sites) : [],
    created_at: Date.now() / 1000,
  });
  await writeJson(path.join(dir, "status.json"), {
    state: "queued",
    message: "Waiting for the worker…",
    stages: Object.fromEntries(STAGES.map((s) => [s.id, { state: "pending" }])),
    cost_usd: 0,
    updated_at: Date.now() / 1000,
  });
  await writeJson(path.join(dir, "queue.json"), { action: "run" });
  return { id };
}

export async function listJobs() {
  let names: string[] = [];
  try {
    names = await fsp.readdir(JOBS);
  } catch {
    return [];
  }
  const out = [];
  for (const id of names) {
    if (!ID_RE.test(id)) continue;
    const dir = path.join(JOBS, id);
    const req = await readJson<any>(path.join(dir, "request.json"));
    if (!req) continue;
    const st = (await readJson<any>(path.join(dir, "status.json"))) ?? {};
    const src = await readJson<any>(path.join(dir, "source.json"));
    out.push({
      id,
      title: req.title || src?.title || id,
      format: req.format,
      sponsored: req.sponsored,
      state: (await exists(path.join(dir, "queue.json"))) && st.state !== "running" ? "queued" : st.state,
      message: st.message ?? null,
      createdAt: req.created_at ?? null,
      updatedAt: st.updated_at ?? null,
    });
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export async function getJob(id: string) {
  const dir = jobDir(id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (!req) throw new Error("Unknown job.");
  const status = (await readJson<any>(path.join(dir, "status.json"))) ?? {};
  const queued = await exists(path.join(dir, "queue.json"));
  const source = await readJson<any>(path.join(dir, "source.json"));
  const review = await readJson<any>(path.join(dir, "review.json"));
  const edl = await readJson<any>(path.join(dir, "edl.json"));
  let previews: { name: string; bytes: number; modifiedAt: number }[] = [];
  let listens: { name: string; bytes: number; modifiedAt: number }[] = [];
  let edits: { name: string; bytes: number; modifiedAt: number }[] = [];
  let finals: { name: string; bytes: number; modifiedAt: number }[] = [];
  // phase 2 (shorts): Claude's graphics plan per video — what goes on screen, on which words
  const graphics: { t0: number; t1: number; template: string; fields: unknown; why?: string }[][] = [];
  try {
    for (const f of (await fsp.readdir(dir)).sort()) {
      const m = /^(preview|listen|edit|final)-\d{2}\.mp4$/.exec(f);
      if (m) {
        const s = await fsp.stat(path.join(dir, f));
        const list = { preview: previews, edit: edits, final: finals, listen: listens }[m[1] as "preview"];
        list.push({ name: f, bytes: s.size, modifiedAt: s.mtimeMs / 1000 });
      }
      const g = /^graphics-(\d{2})\.json$/.exec(f);
      if (g) {
        const doc = await readJson<any>(path.join(dir, f));
        graphics[Number(g[1]) - 1] = (doc?.plan?.events ?? []).map((e: any) => ({
          t0: e.t0, t1: e.t1, template: e.template, fields: e.fields, why: e.why,
        }));
      }
    }
  } catch {
    previews = [];
    listens = [];
    edits = [];
    finals = [];
  }
  const nudgeDoc = await readJson<any>(path.join(dir, "joins.edit.json"));
  const nudges = nudgeDoc?.nudges ?? {};
  const edlMtime = (await fsp.stat(path.join(dir, "edl.json")).catch(() => null))?.mtimeMs ?? null;
  // saved corrections the current cut / sound check does not contain yet
  const nudgesPending = !!nudgeDoc?.saved_at && edlMtime !== null && nudgeDoc.saved_at * 1000 > edlMtime + 500;
  let log = "";
  try {
    const buf = await fsp.readFile(path.join(dir, "log.txt"), "utf8");
    log = buf.slice(-8000);
  } catch {
    log = "";
  }
  // what the (one-at-a-time) worker is busy with, so a queued save never looks lost
  let busyWith: { id: string; title: string | null; message: string | null } | null = null;
  if (queued && status.state !== "running") {
    try {
      for (const other of await fsp.readdir(path.dirname(dir))) {
        if (other === id) continue;
        const st = await readJson<any>(path.join(path.dirname(dir), other, "status.json"));
        if (st?.state === "running") {
          const r = await readJson<any>(path.join(path.dirname(dir), other, "request.json"));
          busyWith = { id: other, title: r?.title ?? null, message: st.message ?? null };
          break;
        }
      }
    } catch {
      busyWith = null;
    }
  }
  return {
    id,
    busyWith,
    request: { ...req, script: req.script ? String(req.script).slice(0, 2000) : null },
    status: { ...status, state: queued && status.state !== "running" ? "queued" : status.state },
    source,
    review,
    videos: (edl?.videos ?? []).map((v: any) => ({
      title: v.title, duration: v.duration, cuts: v.cuts, warnings: v.warnings ?? [],
      words: (v.words ?? []).length,
      joins: v.joins ?? [],
    })),
    previews,
    listens,
    edits,
    finals,
    graphics,
    nudges,
    nudgesPending,
    edlAt: (await fsp.stat(path.join(dir, "edl.json")).catch(() => null))?.mtimeMs ?? null,
    log,
  };
}

/** Jake's edits on the review screen: the kept sentences (and dropped words) per video. */
export async function saveEdits(id: string, videos: unknown) {
  const dir = jobDir(id);
  if (!Array.isArray(videos) || videos.length === 0) throw new Error("Nothing to save.");
  const clean = videos.slice(0, 50).map((v: any, k: number) => ({
    title: String(v?.title ?? `Video ${k + 1}`).slice(0, 120),
    segments: (Array.isArray(v?.segments) ? v.segments : []).slice(0, 5000).map((s: any) => ({
      s: Number(s?.s),
      drop: (Array.isArray(s?.drop) ? s.drop : []).map(Number).filter(Number.isInteger).slice(0, 500),
    })).filter((s: any) => Number.isInteger(s.s) && s.s >= 0),
  }));
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Wait for the current step to finish.");
  await writeJson(path.join(dir, "plan.edit.json"), { videos: clean, saved_at: Date.now() / 1000 });
  await writeJson(path.join(dir, "queue.json"), { action: "rebuild" });
  return { ok: true };
}

/**
 * Jake's hand nudges of single cuts (Descript-style): ms per edge, keyed
 * "a:<first word id>" (where a piece starts) / "b:<last word id>" (where it ends).
 * Rebuilds the cut + the sound check only — the video is not re-rendered.
 */
export async function saveNudges(id: string, nudges: unknown, apply = false) {
  const dir = jobDir(id);
  if (!nudges || typeof nudges !== "object" || Array.isArray(nudges)) throw new Error("Nothing to save.");
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(nudges as Record<string, unknown>).slice(0, 5000)) {
    const ms = Math.round(Number(v));
    if (/^[ab]:\d{1,7}$/.test(k) && Number.isFinite(ms) && ms !== 0 && Math.abs(ms) <= 1000) clean[k] = ms;
  }
  // Always accepted, even while the worker is busy (Jake's nudges autosave as he works:
  // refusing them made the editor drop his cuts). An autosave only STORES them — Jake:
  // "each save shouldn't rebuild the whole soundcheck - the rebuild should happen only
  // when I finish all of the corrections" — `apply` (his Rebuild button) queues the one
  // recut, which runs as soon as the current step is done; the latest nudges win.
  await writeJson(path.join(dir, "joins.edit.json"), { nudges: clean, saved_at: Date.now() / 1000 });
  if (!apply) return { ok: true, count: Object.keys(clean).length };
  const st = await readJson<any>(path.join(dir, "status.json"));
  const queued = await readJson<any>(path.join(dir, "queue.json"));
  // never downgrade a queued full run / render to a recut
  if (!queued || queued.action === "recut" || queued.action === "rebuild") {
    await writeJson(path.join(dir, "queue.json"), { action: st?.state === "running" && queued?.action === "rebuild" ? "rebuild" : "recut" });
  }
  return { ok: true, count: Object.keys(clean).length };
}

/**
 * Long-form: the FULL EDIT (screencasts of the job's websites, facecam bubble, overlays,
 * A-roll camera, music) → edit-NN.mp4. `sites` (optional) replaces the job's websites.
 */
export async function buildEdit(id: string, sites?: string) {
  const dir = jobDir(id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (req?.format !== "long") throw new Error("The full edit is for long-form videos.");
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Wait for the current step to finish.");
  if (!(await readJson<any>(path.join(dir, "edl.json")))) throw new Error("There is no cut yet.");
  if (sites !== undefined) {
    const next = parseSites(sites);
    if (JSON.stringify(next) !== JSON.stringify(req.sites ?? [])) {
      await writeJson(path.join(dir, "request.json"), { ...req, sites: next });
      // new websites = a new plan: drop the old one so the worker re-plans
      for (const d of await fsp.readdir(dir)) if (/^edit-\d{2}$/.test(d)) await fsp.rm(path.join(dir, d, "direct.json"), { force: true });
    }
  }
  await writeJson(path.join(dir, "queue.json"), { action: "edit" });
  return { ok: true };
}

/** Render the video preview of the current cut (edits never do this on their own). */
export async function renderVideo(id: string) {
  const dir = jobDir(id);
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Wait for the current step to finish.");
  await writeJson(path.join(dir, "queue.json"), { action: "render" });
  return { ok: true };
}

/**
 * The deliverable, final-NN.mp4 at the source resolution. Shorts: cut + 2× graphics +
 * captions + SFX. Long-form: the full edit (screencasts, bubble, overlays, music) at source
 * resolution when one has been built, else the current cut alone.
 */
export async function renderFinal(id: string) {
  const dir = jobDir(id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (req?.format !== "short" && req?.format !== "long") throw new Error("Unknown video format.");
  if (req.format === "long" && !(await readJson<any>(path.join(dir, "edl.json")))) {
    throw new Error("There is no cut yet — let the job reach the sound check first.");
  }
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Wait for the current step to finish.");
  await writeJson(path.join(dir, "queue.json"), { action: "final" });
  return { ok: true };
}

/**
 * A slice of the job's original 48 kHz recording as a small WAV, for the cut editor's
 * in-browser audition. full48k.wav is plain PCM, so this is a byte-range copy.
 */
export async function audioSlice(id: string, from: number, to: number): Promise<Buffer> {
  const dir = jobDir(id);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 12) {
    throw new Error("Bad range.");
  }
  const fh = await fsp.open(path.join(dir, "full48k.wav"), "r");
  try {
    const head = Buffer.alloc(4096);
    await fh.read(head, 0, 4096, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV.");
    let off = 12;
    let fmt: { ch: number; sr: number; bits: number } | null = null;
    let dataAt = -1;
    let dataLen = 0;
    while (off + 8 <= head.length) {
      const idc = head.toString("ascii", off, off + 4);
      const len = head.readUInt32LE(off + 4);
      if (idc === "fmt ") fmt = { ch: head.readUInt16LE(off + 10), sr: head.readUInt32LE(off + 12), bits: head.readUInt16LE(off + 22) };
      if (idc === "data") {
        dataAt = off + 8;
        dataLen = len;
        break;
      }
      off += 8 + len + (len % 2);
    }
    if (!fmt || dataAt < 0 || fmt.bits !== 16) throw new Error("Unsupported WAV.");
    const block = fmt.ch * 2;
    const total = Math.floor(((await fh.stat()).size - dataAt) / block);
    const frames = Math.min(total, dataLen ? Math.floor(dataLen / block) : total);
    const f0 = Math.max(0, Math.min(frames, Math.round(Math.max(0, from) * fmt.sr)));
    const f1 = Math.max(f0, Math.min(frames, Math.round(to * fmt.sr)));
    const body = Buffer.alloc((f1 - f0) * block);
    await fh.read(body, 0, body.length, dataAt + f0 * block);
    const h = Buffer.alloc(44);
    h.write("RIFF", 0, "ascii");
    h.writeUInt32LE(36 + body.length, 4);
    h.write("WAVEfmt ", 8, "ascii");
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(fmt.ch, 22);
    h.writeUInt32LE(fmt.sr, 24);
    h.writeUInt32LE(fmt.sr * block, 28);
    h.writeUInt16LE(block, 32);
    h.writeUInt16LE(16, 34);
    h.write("data", 36, "ascii");
    h.writeUInt32LE(body.length, 40);
    return Buffer.concat([h, body]);
  } finally {
    await fh.close();
  }
}

export async function resetEdits(id: string) {
  const dir = jobDir(id);
  await fsp.rm(path.join(dir, "plan.edit.json"), { force: true });
  await writeJson(path.join(dir, "queue.json"), { action: "rebuild" });
  return { ok: true };
}

export async function continueJob(id: string) {
  const dir = jobDir(id);
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("It is already running.");
  await writeJson(path.join(dir, "queue.json"), { action: "run" });
  return { ok: true };
}

export async function cancelJob(id: string) {
  const dir = jobDir(id);
  await fsp.rm(path.join(dir, "queue.json"), { force: true });
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st && st.state !== "running") {
    // nothing is executing: settle the status here, the worker never claims it
    await writeJson(path.join(dir, "status.json"), {
      ...st, state: "cancelled", message: "Cancelled", updated_at: Date.now() / 1000,
    });
    return { ok: true };
  }
  await fsp.writeFile(path.join(dir, "cancel"), String(Date.now()));
  return { ok: true };
}

export async function deleteJob(id: string) {
  const dir = jobDir(id);
  const st = await readJson<any>(path.join(dir, "status.json"));
  if (st?.state === "running") throw new Error("Cancel it first.");
  await fsp.rm(dir, { recursive: true, force: true });
  return { ok: true };
}

export const filesRoot = JOBS;
