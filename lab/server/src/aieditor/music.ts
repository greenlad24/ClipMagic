/**
 * Auto Editor — the MUSIC LIBRARY and each job's music (Jake 2026-10-09: "I also want to be able to change
 * the background music"). The worker side is aieditor/music.py; this module only writes files it reads.
 *
 *   <AIEDITOR_WORK>/music/            (host: /opt/aieditor-work/music — the folder the worker mixes from)
 *     <id>                            a track; id = its file name ([A-Za-z0-9_-]+.(wav|mp3|m4a|ogg|flac))
 *     <id>.lufs                       integrated loudness (the worker's own cache format: one number)
 *     <id>.meta.json                  {duration}
 *     library.json                    {default, tracks: {id: {title, added_at, origin, lab_id?}}, removed_lab}
 *
 * The Lab's own music tracks (the Zite "MusicTracks" table, files in DATA_DIR/uploads) are copied in the
 * first time the library is listed — titles kept — unless Jake deleted one here (removed_lab).
 *
 * Per job: request.json "music": {"track": id | null (Auto = the library default) | "none", "gain_lu": n}
 * (−6 … +6 LU relative to the default bed, ~23 LU under the voice). "Change music" on a finished job
 * writes the choice and queues action "remusic": the worker rebuilds ONLY the sound of the finished outputs
 * (a new soundtrack under the same picture) and the hand-off's music stem / preview / zip.
 *
 * HTTP (behind the session gate + `auth`, index.ts): /api/aieditor/music …
 *   GET  /                      the library        POST /upload?name=   one raw body (≤ 300 MB)
 *   GET  /:id/audio             the track (range requests, for the preview player)
 *   POST /:id/default           "Set as default"   DELETE /:id   refused while a running/queued job uses it
 *   GET  /job/:job              the job's choice + what a change would rebuild
 *   POST /job/:job              {track, gain_lu, apply} — apply = queue "remusic"
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type Request, type Response } from "express";

export const TRACK_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.(wav|mp3|m4a|ogg|flac)$/;
export const UPLOAD_EXTS = [".mp3", ".wav", ".m4a"];
export const MAX_MUSIC_BYTES = 300 * 1024 ** 2;
export const GAIN_LU_MIN = -6;
export const GAIN_LU_MAX = 6;
/** reference 2: the default bed sits this far under the voice (compose_long.MUSIC_UNDER_VOICE_DB) */
export const UNDER_VOICE_LU = 23;
const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const TRACK_EXTS = [".wav", ".mp3", ".m4a", ".ogg", ".flac"];

export class MusicError extends Error {
  status: number;
  // (no parameter properties: the tests run under node's strip-only TypeScript)
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** read at call time (tests point AIEDITOR_WORK at a temp dir) */
const work = () => process.env.AIEDITOR_WORK || "/aieditor-work";
export const musicDir = () => path.join(work(), "music");
const jobsDir = () => path.join(work(), "jobs");

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

async function exists(file: string) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

// ── the choice ──

export interface MusicChoice {
  /** null = Auto (the library default), "none" = no music, else a track id */
  track: string | null;
  gain_lu: number;
}

/** request.json "music" as the worker reads it (aieditor/music.py choice): never throws. */
export function choiceOf(req: any): MusicChoice {
  const m = req?.music && typeof req.music === "object" ? req.music : {};
  const t = m.track;
  const track = t === "none" ? "none" : typeof t === "string" && TRACK_RE.test(t) ? t : null;
  let g = Number(m.gain_lu ?? 0);
  if (!Number.isFinite(g)) g = 0;
  return { track, gain_lu: Math.round(Math.min(GAIN_LU_MAX, Math.max(GAIN_LU_MIN, g)) * 100) / 100 };
}

/**
 * What the Lab sends (New edit / Change music) → the request.json value. undefined/null = no field
 * (Auto at the default level). A bad track id or a level outside −6 … +6 is refused, not clamped.
 */
export function parseMusic(v: unknown): MusicChoice | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") throw new MusicError("Music: send {track, gain_lu}.");
  const o = v as Record<string, unknown>;
  const t = o.track;
  let track: string | null;
  if (t === undefined || t === null || t === "" || t === "auto") track = null;
  else if (t === "none") track = "none";
  else if (typeof t === "string" && TRACK_RE.test(t)) track = t;
  else throw new MusicError("Unknown music track.");
  const g = o.gain_lu === undefined || o.gain_lu === null ? 0 : Number(o.gain_lu);
  if (!Number.isFinite(g) || g < GAIN_LU_MIN || g > GAIN_LU_MAX) {
    throw new MusicError(`The music level is ${GAIN_LU_MIN} … +${GAIN_LU_MAX} LU.`);
  }
  return { track, gain_lu: Math.round(g * 10) / 10 };
}

// ── the library ──

export interface LibraryDoc {
  default?: string | null;
  tracks?: Record<string, { title?: string; added_at?: number; origin?: string; lab_id?: string }>;
  removed_lab?: string[];
}

export async function readLibrary(): Promise<LibraryDoc> {
  const doc = await readJson<LibraryDoc>(path.join(musicDir(), "library.json"));
  return doc && typeof doc === "object" ? doc : {};
}

async function writeLibrary(doc: LibraryDoc) {
  await fsp.mkdir(musicDir(), { recursive: true });
  await writeJson(path.join(musicDir(), "library.json"), doc);
}

/** the track files, by name (what the worker sees) */
export async function trackIds(): Promise<string[]> {
  let names: string[] = [];
  try { names = await fsp.readdir(musicDir()); } catch { return []; }
  const out: string[] = [];
  for (const n of names.sort()) {
    if (!TRACK_RE.test(n) || !TRACK_EXTS.includes(path.extname(n).toLowerCase())) continue;
    const st = await fsp.stat(path.join(musicDir(), n)).catch(() => null);
    if (st?.isFile()) out.push(n);
  }
  return out;
}

/** the library default, else the first track (exactly aieditor/music.py default_id) */
export function defaultOf(doc: LibraryDoc, ids: string[]): string | null {
  if (doc.default && ids.includes(doc.default)) return doc.default;
  return ids[0] ?? null;
}

/** the track a job's choice means right now: null = no music */
export function resolveTrack(choice: MusicChoice, doc: LibraryDoc, ids: string[]): string | null {
  if (choice.track === "none") return null;
  if (choice.track && ids.includes(choice.track)) return choice.track;
  return defaultOf(doc, ids);
}

export interface Measure { duration: number | null; lufs: number | null }

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 ** 2 }, (err, stdout, stderr) => {
      if (err && !stderr && !stdout) reject(err);
      else resolve(`${stdout}\n${stderr}`);
    });
  });
}

/** ffprobe + ffmpeg ebur128 (the Lab image has both). Tests replace it (setMeasure). */
let measureImpl = async (file: string): Promise<Measure> => {
  const probe = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries",
    "stream=codec_type:format=duration", "-of", "json", file]).catch(() => "");
  let duration: number | null = null;
  let audio = false;
  try {
    const j = JSON.parse(probe.slice(probe.indexOf("{"), probe.lastIndexOf("}") + 1));
    audio = (j.streams ?? []).some((s: any) => s.codec_type === "audio");
    duration = Number(j.format?.duration) || null;
  } catch { /* not media */ }
  if (!audio) return { duration: null, lufs: null };
  const out = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"], 300_000)
    .catch(() => "");
  const m = [...out.matchAll(/^\s+I:\s+(-?[\d.]+)\s+LUFS/gm)].pop();
  return { duration, lufs: m ? Number(m[1]) : null };
};
export function setMeasure(fn: (file: string) => Promise<Measure>) {
  measureImpl = fn;
}

/** cached facts of a track: <id>.lufs (the worker's format) + <id>.meta.json {duration} */
async function factsOf(id: string): Promise<Measure> {
  const f = path.join(musicDir(), id);
  const lufsTxt = await fsp.readFile(`${f}.lufs`, "utf8").catch(() => null);
  const meta = await readJson<{ duration?: number }>(`${f}.meta.json`);
  let lufs = lufsTxt !== null && Number.isFinite(Number(lufsTxt)) ? Number(lufsTxt) : null;
  let duration = typeof meta?.duration === "number" ? meta.duration : null;
  if (lufs === null || duration === null) {
    const m = await measureImpl(f);
    if (lufs === null && m.lufs !== null) {
      lufs = m.lufs;
      await fsp.writeFile(`${f}.lufs`, String(lufs)).catch(() => undefined);
    }
    if (duration === null && m.duration !== null) {
      duration = m.duration;
      await writeJson(`${f}.meta.json`, { duration }).catch(() => undefined);
    }
  }
  return { duration, lufs };
}

/** one of the Lab's own music tracks (Zite MusicTracks + its stored upload) */
export interface LabTrack { labId: string; title: string; file: string }

/** the Lab's music tracks from the database (lazy imports: tests never open the DB) */
export async function labTracksFromDb(): Promise<LabTrack[]> {
  try {
    const { db } = await import("../db/index.js");
    const { config } = await import("../config.js");
    const rows = db.prepare("SELECT id, doc FROM z_music_tracks").all() as { id: string; doc: string }[];
    const out: LabTrack[] = [];
    for (const r of rows) {
      let doc: any = {};
      try { doc = JSON.parse(r.doc); } catch { continue; }
      const fileId = String(doc.audioUrl ?? "").split("/").filter(Boolean).pop() ?? "";
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(fileId)) continue;
      const f = db.prepare("SELECT stored FROM files WHERE id = ?").get(fileId) as { stored?: string } | undefined;
      if (!f?.stored) continue;
      out.push({ labId: r.id, title: String(doc.trackName || f.stored).slice(0, 120), file: path.join(config.uploadsDir, f.stored) });
    }
    return out;
  } catch {
    return [];
  }
}

/** Copy the Lab's tracks into the library once (never one Jake deleted here). → ids added */
export async function syncLabTracks(lab: LabTrack[]): Promise<string[]> {
  if (!lab.length) return [];
  const doc = await readLibrary();
  const ids = await trackIds();
  // Auto keeps meaning the track it meant before the import (with no default set, Auto = the first by name,
  // and an imported id like "96mK…" sorts before the "FLUE…" every edit used so far)
  const pinned = defaultOf(doc, ids);
  const removed = new Set(doc.removed_lab ?? []);
  const tracks = { ...(doc.tracks ?? {}) };
  const known = new Set(Object.values(tracks).map((t) => t.lab_id).filter(Boolean));
  const added: string[] = [];
  let changed = false;
  for (const t of lab) {
    if (removed.has(t.labId) || known.has(t.labId)) continue;
    const id = path.basename(t.file);
    if (!TRACK_RE.test(id) || !TRACK_EXTS.includes(path.extname(id).toLowerCase())) continue;
    if (!ids.includes(id)) {
      if (!(await exists(t.file))) continue;
      await fsp.mkdir(musicDir(), { recursive: true });
      const part = path.join(musicDir(), `${id}.part-${randomBytes(3).toString("hex")}`);
      await fsp.copyFile(t.file, part);
      await fsp.rename(part, path.join(musicDir(), id));
      ids.push(id);
      added.push(id);
    }
    // (a track already in the folder — the first one was copied by hand — gets its Lab title)
    tracks[id] = { ...(tracks[id] ?? {}), title: tracks[id]?.title || t.title, origin: tracks[id]?.origin ?? "lab",
      lab_id: t.labId, added_at: tracks[id]?.added_at ?? Date.now() / 1000 };
    known.add(t.labId);
    changed = true;
  }
  if (changed) await writeLibrary({ ...doc, tracks, default: doc.default ?? pinned });
  return added;
}

/** jobs running or queued right now, with the track each will mix (null = none) */
export async function busyJobs(doc?: LibraryDoc, ids?: string[]): Promise<{ id: string; title: string; track: string | null }[]> {
  const d = doc ?? (await readLibrary());
  const all = ids ?? (await trackIds());
  let names: string[] = [];
  try { names = await fsp.readdir(jobsDir()); } catch { return []; }
  const out: { id: string; title: string; track: string | null }[] = [];
  for (const n of names) {
    if (!JOB_ID_RE.test(n)) continue;
    const dir = path.join(jobsDir(), n);
    const st = await readJson<any>(path.join(dir, "status.json"));
    if (st?.state !== "running" && !(await exists(path.join(dir, "queue.json")))) continue;
    const req = await readJson<any>(path.join(dir, "request.json"));
    if (!req) continue;
    out.push({ id: n, title: req.title || n, track: resolveTrack(choiceOf(req), d, all) });
  }
  return out;
}

export interface MusicTrack {
  id: string;
  title: string;
  duration: number | null;
  lufs: number | null;
  bytes: number;
  origin: string;
  isDefault: boolean;
  /** running / queued jobs that will mix it (it cannot be deleted while there are any) */
  usedBy: { id: string; title: string }[];
}

export async function listMusic(opts: { lab?: () => Promise<LabTrack[]> } = {}) {
  await syncLabTracks(await (opts.lab ?? labTracksFromDb)()).catch(() => []);
  const doc = await readLibrary();
  const ids = await trackIds();
  const def = defaultOf(doc, ids);
  const busy = await busyJobs(doc, ids);
  const tracks: MusicTrack[] = [];
  for (const id of ids) {
    const st = await fsp.stat(path.join(musicDir(), id)).catch(() => null);
    const f = await factsOf(id);
    const meta = doc.tracks?.[id] ?? {};
    tracks.push({
      id,
      title: meta.title || id.replace(/\.[^.]+$/, ""),
      duration: f.duration,
      lufs: f.lufs,
      bytes: st?.size ?? 0,
      origin: meta.origin ?? "library",
      isDefault: id === def,
      usedBy: busy.filter((b) => b.track === id).map(({ id: j, title }) => ({ id: j, title })),
    });
  }
  return { tracks, default: def, gainRange: [GAIN_LU_MIN, GAIN_LU_MAX], underVoiceLu: UNDER_VOICE_LU };
}

function trackPath(id: unknown): string {
  if (typeof id !== "string" || !TRACK_RE.test(id)) throw new MusicError("Unknown track.", 404);
  return path.join(musicDir(), id);
}

export async function setDefault(id: string) {
  const f = trackPath(id);
  if (!(await exists(f))) throw new MusicError("Unknown track.", 404);
  const doc = await readLibrary();
  await writeLibrary({ ...doc, default: id });
  return { ok: true, default: id };
}

/** Delete a track — refused while a running or queued job will mix it. */
export async function deleteTrack(id: string) {
  const f = trackPath(id);
  if (!(await exists(f))) throw new MusicError("Unknown track.", 404);
  const doc = await readLibrary();
  const users = (await busyJobs(doc)).filter((b) => b.track === id);
  if (users.length) {
    throw new MusicError(`“${users[0].title}” is using this track right now${users.length > 1 ? ` (+${users.length - 1} more)` : ""} — delete it when the job is done.`, 409);
  }
  const meta = doc.tracks?.[id];
  const tracks = { ...(doc.tracks ?? {}) };
  delete tracks[id];
  const removed = new Set(doc.removed_lab ?? []);
  if (meta?.lab_id) removed.add(meta.lab_id);
  await writeLibrary({ ...doc, tracks, removed_lab: [...removed], default: doc.default === id ? null : doc.default ?? null });
  for (const x of [f, `${f}.lufs`, `${f}.meta.json`]) await fsp.rm(x, { force: true });
  return { ok: true };
}

/** One upload (a raw body, ≤ 300 MB): mp3 / wav / m4a with an audio stream, measured, then listed. */
export async function uploadTrack(name: unknown, body: NodeJS.ReadableStream, contentLength: number | null) {
  const n = path.basename(String(name ?? "")).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200);
  const ext = path.extname(n).toLowerCase();
  if (!n || !UPLOAD_EXTS.includes(ext)) throw new MusicError(`Music files: ${UPLOAD_EXTS.join(", ")}.`);
  if (contentLength !== null && (contentLength <= 0 || contentLength > MAX_MUSIC_BYTES)) {
    throw new MusicError(`Up to ${MAX_MUSIC_BYTES / 1024 ** 2} MB per track.`, 413);
  }
  await fsp.mkdir(musicDir(), { recursive: true });
  const id = `m${randomBytes(8).toString("hex")}${ext}`;
  const f = path.join(musicDir(), id);
  const part = `${f}.part`;
  let written = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > MAX_MUSIC_BYTES) cb(new MusicError(`Up to ${MAX_MUSIC_BYTES / 1024 ** 2} MB per track.`, 413));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, fs.createWriteStream(part));
    if (!written) throw new MusicError("The file is empty.");
    if (contentLength !== null && written !== contentLength) throw new MusicError("The upload was cut off — try again.");
    const m = await measureImpl(part);
    if (!m.duration || m.duration < 1) throw new MusicError("That file has no playable audio.");
    await fsp.rename(part, f);
    if (m.lufs !== null) await fsp.writeFile(`${f}.lufs`, String(m.lufs));
    await writeJson(`${f}.meta.json`, { duration: m.duration });
    const doc = await readLibrary();
    const pinned = defaultOf(doc, (await trackIds()).filter((x) => x !== id));     // Auto does not move to the upload
    const title = n.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim().slice(0, 120) || id;
    await writeLibrary({ ...doc, default: doc.default ?? pinned,
      tracks: { ...(doc.tracks ?? {}), [id]: { title, added_at: Date.now() / 1000, origin: "upload" } } });
    return { id, title, duration: m.duration, lufs: m.lufs };
  } catch (e) {
    await fsp.rm(part, { force: true });
    if (e instanceof MusicError) throw e;
    throw new MusicError(e instanceof Error ? e.message : String(e));
  }
}

// ── a job's music ──

function jobDir(id: unknown): string {
  if (typeof id !== "string" || !JOB_ID_RE.test(id)) throw new MusicError("Unknown job.", 404);
  return path.join(jobsDir(), id);
}

/** What a music change rebuilds (aieditor/music.py plan): the finished outputs that carry a bed. */
export async function outputsOf(dir: string): Promise<string[]> {
  const edl = await readJson<any>(path.join(dir, "edl.json"));
  const n = (edl?.videos ?? []).length;
  const out: string[] = [];
  for (let k = 1; k <= n; k++) {
    const kk = String(k).padStart(2, "0");
    const w = path.join(dir, `edit-${kk}`);
    if (await exists(path.join(w, "direct.json"))) {
      for (const name of [`edit-${kk}`, `draft-${kk}`, `final-${kk}`]) {
        if ((await exists(path.join(dir, `${name}.mp4`)))
          && ((await exists(path.join(w, `${name}.filter.txt`))) || (await exists(path.join(w, `${name}.audio.filter.txt`))))) {
          out.push(`${name}.mp4`);
        }
      }
    }
    if ((await exists(path.join(dir, `handoff-${kk}`, "audio", "voice.wav"))) && (await exists(path.join(dir, `handoff-${kk}.json`)))) {
      out.push(`handoff-${kk}.zip`);
    }
  }
  return out;
}

export async function jobMusic(id: string) {
  const dir = jobDir(id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (!req) throw new MusicError("Unknown job.", 404);
  const st = (await readJson<any>(path.join(dir, "status.json"))) ?? {};
  const queued = await exists(path.join(dir, "queue.json"));
  const outputs = req.format === "long" ? await outputsOf(dir) : [];
  const why = req.format !== "long" ? "Shorts have no music bed."
    : st.state === "running" || queued ? "Wait for the current step to finish."
      : st.held || st.state === "held" ? "This edit is held — there is no finished edit to change."
        : !outputs.length ? "Nothing finished carries music yet — build the edit first."
          : null;
  return {
    choice: choiceOf(req),
    hasField: !!req.music,
    applied: await readJson<any>(path.join(dir, "music-applied.json")),
    outputs,
    canChange: why === null,
    why,
    running: st.state === "running" && st.action === "remusic",
  };
}

/**
 * Save the job's music choice; apply = queue "remusic" (only the sound of the finished outputs is rebuilt).
 * Without apply the choice is kept for the next render of the edit.
 */
export async function changeJobMusic(id: string, music: unknown, apply: boolean) {
  const dir = jobDir(id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (!req) throw new MusicError("Unknown job.", 404);
  if (req.format !== "long") throw new MusicError("Shorts have no music bed.");
  const choice = parseMusic(music) ?? { track: null, gain_lu: 0 };
  if (choice.track && choice.track !== "none" && !(await exists(path.join(musicDir(), choice.track)))) {
    throw new MusicError("That track is not in the library any more.", 404);
  }
  const st = (await readJson<any>(path.join(dir, "status.json"))) ?? {};
  const busy = st.state === "running" || (await exists(path.join(dir, "queue.json")));
  if (busy) throw new MusicError("Wait for the current step to finish.", 409);
  if (apply) {
    if (st.held || st.state === "held") throw new MusicError("This edit is held — there is no finished edit to change.");
    if (!(await outputsOf(dir)).length) throw new MusicError("Nothing finished carries music yet — build the edit first.");
  }
  await writeJson(path.join(dir, "request.json"), { ...req, music: choice });
  if (apply) await writeJson(path.join(dir, "queue.json"), { action: "remusic" });
  return { ok: true, music: choice, queued: apply };
}

// ── HTTP ──

function send(res: Response, fn: () => Promise<unknown>) {
  fn().then(
    (out) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(out);
    },
    (err) => {
      res.status(err instanceof MusicError ? err.status : 500).json({ error: err instanceof Error ? err.message : String(err) });
    },
  );
}

const AUDIO_TYPE: Record<string, string> = {
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".flac": "audio/flac",
};

/** Mounted at /api/aieditor/music behind the session gate (index.ts). */
export function aieditorMusicRouter() {
  const r = express.Router();
  r.get("/", (_req, res) => send(res, () => listMusic()));
  r.post("/upload", (req: Request, res) => {
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    if (type !== "application/octet-stream") {
      res.status(415).json({ error: "Send the file as application/octet-stream." });
      return;
    }
    const len = req.headers["content-length"] !== undefined ? Number(req.headers["content-length"]) : null;
    send(res, () => uploadTrack(req.query.name, req, len));
  });
  r.get("/job/:job", (req, res) => send(res, () => jobMusic(req.params.job)));
  r.post("/job/:job", (req, res) => send(res, () => {
    const b = req.body ?? {};
    return changeJobMusic(req.params.job, { track: b.track, gain_lu: b.gain_lu }, b.apply === true);
  }));
  r.get("/:id/audio", (req, res) => {
    let f: string;
    try { f = trackPath(req.params.id); } catch { res.status(404).end(); return; }
    res.type(AUDIO_TYPE[path.extname(f).toLowerCase()] ?? "application/octet-stream");
    res.sendFile(f, { dotfiles: "deny", maxAge: 0, headers: { "Cache-Control": "private, no-cache" } },
      (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });
  r.post("/:id/default", (req, res) => send(res, () => setDefault(req.params.id)));
  r.delete("/:id", (req, res) => send(res, () => deleteTrack(req.params.id)));
  return r;
}
