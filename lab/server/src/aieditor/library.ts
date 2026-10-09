/**
 * Auto Editor — the NARRATION LIBRARY (Jake 2026-10-09: "show previously uploaded narration in
 * the graphics-only and the creative editing paths - so I can reuse uploaded narration videos",
 * then "I want to be able to delete narrations and files that were stored on the volume also").
 *
 * An entry is keyed by its upload id:
 *   upload       a finished upload (jobs/_uploads/<id>) — source {kind: "upload", upload}
 *   job_source   an upload made BEFORE the library existed: the worker removed its _uploads
 *                folder after linking it, so the bytes live only as the source.mp4 of the jobs
 *                that used it — source {kind: "job_source", job, upload} (that job's source.mp4,
 *                validated + hard-linked by aieditor/sources.py)
 * Which jobs used it = every job whose request.json source is that upload (or a job_source
 * reuse of it). "Remove from library" writes the id into _uploads/library.json "hidden", so the
 * jobs of a removed upload do not come back as a job_source entry.
 *
 * Removing frees space only when the LAST hard link goes (./storage.ts): "narration only"
 * keeps every job's own copy (frees 0 while jobs hold it); "and everything made from it" also
 * deletes those jobs. Anything a running or queued job needs is refused.
 */
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { readMeta, uploadsRoot, writeMeta, UPLOAD_ID_RE, type UploadMeta } from "./uploads.js";
import {
  freedByJobs, jobsRoot, pendingNeeds, readJobs, spaceOf, StorageError, walk, walkAll,
  type FileRec, type JobInfo,
} from "./storage.js";

export interface LibraryEntry {
  key: string;
  kind: "upload" | "job_source";
  /** for kind job_source: the job whose source.mp4 is used */
  job: string | null;
  name: string;
  /** unix seconds */
  uploadedAt: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  bytes: number;
  usedBy: { id: string; title: string; state: string | null; busy: string | null }[];
  /** a URL for a small poster (<video preload="metadata">), or null */
  poster: string | null;
  /** space freed by "Delete narration only" / "… and everything made from it" */
  frees: number;
  freesAll: number;
  /** why removing it is refused right now (a busy job needs it), else null */
  blocked: string | null;
  blockedAll: string | null;
}

const LIB_FILE = "library.json";

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

async function hidden(): Promise<Set<string>> {
  const d = await readJson<{ hidden?: string[] }>(path.join(uploadsRoot(), LIB_FILE));
  return new Set((d?.hidden ?? []).filter((x) => UPLOAD_ID_RE.test(x)));
}

async function hide(id: string) {
  const h = await hidden();
  h.add(id);
  await fsp.mkdir(uploadsRoot(), { recursive: true });
  const tmp = path.join(uploadsRoot(), `${LIB_FILE}.tmp-${process.pid}`);
  await fsp.writeFile(tmp, JSON.stringify({ hidden: [...h].sort() }));
  await fsp.rename(tmp, path.join(uploadsRoot(), LIB_FILE));
}

/** the upload id a job's narration came from (request.json source), or null */
export function uploadOf(req: any): string | null {
  const s = req?.source ?? {};
  if ((s.kind === "upload" || s.kind === "job_source") && UPLOAD_ID_RE.test(String(s.upload ?? ""))) return String(s.upload);
  return null;
}

const num = (x: unknown) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
const secs = (t: unknown) => (num(t) === null ? null : Number(t) > 1e11 ? Number(t) / 1000 : Number(t));

/** ffprobe in the Lab container (it ships ffmpeg); null when it cannot read the file */
export function ffprobe(file: string): Promise<UploadMeta["probe"]> {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(out);
          const v = (j.streams ?? []).find((s: any) => s.codec_type === "video") ?? {};
          const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0)) % 180 === 90;
          const w = num(v.width), h = num(v.height);
          resolve({ duration: num(j.format?.duration ?? v.duration), width: rot ? h : w, height: rot ? w : h });
        } catch {
          resolve(null);
        }
      });
  });
}

let probe: typeof ffprobe = ffprobe;
/** (tests) */
export function setProbe(fn: typeof ffprobe) { probe = fn; }

function firstVideo(dir: string, files: string[]): string | null {
  for (const re of [/^final-\d{2}\.mp4$/, /^edit-\d{2}\.mp4$/, /^preview-\d{2}\.mp4$/]) {
    const f = files.filter((x) => re.test(x)).sort()[0];
    if (f) return `/api/aieditor/files/${dir}/${f}#t=2`;
  }
  return null;
}

interface Group { id: string; jobs: JobInfo[] }

export async function listLibrary(ctx?: { all?: FileRec[]; jobs?: JobInfo[] }): Promise<LibraryEntry[]> {
  const jobs = ctx?.jobs ?? await readJobs();
  const all = ctx?.all ?? await walkAll();
  const hid = await hidden();
  const needs = pendingNeeds(jobs);
  const groups = new Map<string, Group>();
  for (const j of jobs) {
    const u = uploadOf(j.req);
    if (!u) continue;
    let g = groups.get(u);
    if (!g) groups.set(u, (g = { id: u, jobs: [] }));
    g.jobs.push(j);
  }
  const root = uploadsRoot();
  let names: string[] = [];
  try { names = await fsp.readdir(root); } catch { /* none yet */ }
  const out: LibraryEntry[] = [];
  const seen = new Set<string>();

  const used = (g: Group | undefined) => (g?.jobs ?? [])
    .map((j) => ({ id: j.id, title: String(j.req?.title || j.id), state: j.status?.state ?? null, busy: j.busy, at: secs(j.req?.created_at) ?? 0 }))
    .sort((a, b) => b.at - a.at)
    .map(({ at: _at, ...x }) => x);
  const blockAll = (g: Group | undefined, own: string | null) => {
    if (own) return own;
    const b = (g?.jobs ?? []).find((j) => j.busy);
    if (b) return `the job ${b.id} that uses it is ${b.busy}`;
    for (const [rel, by] of needs) {
      const top = rel.split("/")[0];
      if ((g?.jobs ?? []).some((j) => j.id === top) && !(g?.jobs ?? []).some((j) => j.id === by)) {
        return `the ${by} job (not started yet) needs a file of ${top}`;
      }
    }
    return null;
  };

  // 1. finished uploads still in _uploads
  for (const id of names) {
    if (!UPLOAD_ID_RE.test(id)) continue;
    const dir = path.join(root, id);
    const m = await readMeta(dir);
    if (!m?.complete) continue;
    const st = await fsp.lstat(path.join(dir, "data")).catch(() => null);
    if (!st?.isFile()) continue;
    seen.add(id);
    const g = groups.get(id);
    // probe once: reuse a job's source.json, else ffprobe — and cache it in upload.json
    let pr = m.probe ?? null;
    if (!pr && !m.probe_failed) {
      for (const j of g?.jobs ?? []) {
        const sj = await readJson<any>(path.join(j.dir, "source.json"));
        if (sj?.width && sj?.height) { pr = { duration: num(sj.duration), width: num(sj.width), height: num(sj.height) }; break; }
      }
      if (!pr) pr = (await probe(path.join(dir, "data"))) ?? null;
      const fresh = await readMeta(dir);
      if (fresh) await writeMeta(dir, { ...fresh, ...(pr ? { probe: pr } : { probe_failed: true }) }).catch(() => undefined);
    }
    const mine = all.filter((r) => r.rel.startsWith(`_uploads/${id}/`));
    const need = needs.get(`_uploads/${id}`);
    const own = need ? `the ${need} job has not started yet and still needs it` : null;
    out.push({
      key: id, kind: "upload", job: null, name: m.name, uploadedAt: secs(m.created_at),
      duration: pr?.duration ?? null, width: pr?.width ?? null, height: pr?.height ?? null,
      bytes: spaceOf(mine.filter((r) => r.rel.endsWith("/data"))).bytes, usedBy: used(g),
      poster: `/api/aieditor/uploads/${id}/video#t=2`,
      frees: spaceOf(mine).frees,
      freesAll: freedByJobs(all, (g?.jobs ?? []).map((j) => j.id), mine),
      blocked: own, blockedAll: blockAll(g, own),
    });
  }

  // 2. uploads made before the library: only the jobs' source.mp4 is left
  for (const g of groups.values()) {
    if (seen.has(g.id) || hid.has(g.id)) continue;
    let rep: { j: JobInfo; sj: any } | null = null;
    for (const j of [...g.jobs].sort((a, b) => (secs(a.req?.created_at) ?? 0) - (secs(b.req?.created_at) ?? 0))) {
      if (!j.hasSource) continue;
      const sj = await readJson<any>(path.join(j.dir, "source.json"));
      if (sj?.kind !== "upload" && sj?.kind !== "job_source") continue;
      rep = { j, sj };
      break;
    }
    if (!rep) continue;
    const files = await fsp.readdir(rep.j.dir).catch(() => [] as string[]);
    out.push({
      key: g.id, kind: "job_source", job: rep.j.id,
      name: String(rep.sj.filename || rep.j.req?.source?.name || "upload"),
      uploadedAt: secs(rep.j.req?.created_at),
      duration: num(rep.sj.duration), width: num(rep.sj.width), height: num(rep.sj.height),
      bytes: spaceOf(all.filter((r) => r.rel === `${rep!.j.id}/source.mp4`)).bytes,
      usedBy: used(g), poster: firstVideo(rep.j.id, files),
      frees: 0,
      freesAll: freedByJobs(all, g.jobs.map((j) => j.id)),
      blocked: null, blockedAll: blockAll(g, null),
    });
  }
  return out.sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0));
}

/** The request.json source of a library pick: {kind: job_source, job, upload, name}, validated. */
export async function jobSourceOf(job: unknown): Promise<{ kind: "job_source"; job: string; upload: string; name: string }> {
  const id = String(job ?? "");
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) throw new Error("Choose a narration from the library.");
  const dir = path.join(jobsRoot(), id);
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (!req) throw new Error("That narration's job no longer exists.");
  const st = await fsp.lstat(path.join(dir, "source.mp4")).catch(() => null);
  if (!st?.isFile()) throw new Error("That job has no source video any more.");
  const sj = await readJson<any>(path.join(dir, "source.json"));
  const upload = uploadOf(req);
  if (!upload || (sj?.kind !== "upload" && sj?.kind !== "job_source")) throw new Error("That job's source is not an uploaded narration.");
  return { kind: "job_source", job: id, upload, name: String(sj.filename || req.source?.name || "upload").slice(0, 200) };
}

/**
 * Remove a narration from the library. mode "narration": the entry only (jobs keep their
 * hard-linked copy); "all": the entry AND every job made from it. Returns the bytes freed.
 */
export async function removeFromLibrary(key: unknown, mode: unknown, deleteJob: (id: string) => Promise<unknown>) {
  const id = String(key ?? "");
  if (!UPLOAD_ID_RE.test(id)) throw new StorageError("Unknown narration.", 404);
  if (mode !== "narration" && mode !== "all") throw new StorageError("Say what to delete.");
  const jobs = await readJobs();
  const all = await walkAll();
  const entry = (await listLibrary({ all, jobs })).find((e) => e.key === id);
  if (!entry) throw new StorageError("That narration is not in the library any more.", 404);
  const why = mode === "all" ? entry.blockedAll : entry.blocked;
  if (why) throw new StorageError(`Not deleted: ${why}.`, 409);
  const expected = mode === "all" ? entry.freesAll : entry.frees;
  const dir = path.join(uploadsRoot(), id);
  // hidden first: a job of a removed upload must never come back as a job_source entry
  await hide(id);
  if (entry.kind === "upload") {
    // re-check right before deleting: a job may have been queued since the listing
    const now = pendingNeeds(await readJobs());
    if (now.has(`_uploads/${id}`)) throw new StorageError(`Not deleted: the ${now.get(`_uploads/${id}`)} job still needs it.`, 409);
    await fsp.rm(dir, { recursive: true, force: true });
  }
  const removedJobs: string[] = [];
  if (mode === "all") {
    for (const u of entry.usedBy) {
      await deleteJob(u.id);
      removedJobs.push(u.id);
    }
  }
  return { ok: true, freed: expected, removedJobs };
}

/** (tests) the records of one upload folder */
export async function uploadRecs(id: string): Promise<FileRec[]> {
  return walk(path.join(uploadsRoot(), id), `_uploads/${id}`);
}
