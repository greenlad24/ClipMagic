/**
 * Auto Editor — the NARRATION LIBRARY (Jake 2026-10-09: "show previously uploaded narration in
 * the graphics-only and the creative editing paths - so I can reuse uploaded narration videos",
 * then "I want to be able to delete narrations and files that were stored on the volume also").
 *
 * Jake 2026-10-09 (later): "I want to reuse a narration from another job" — the library lists
 * EVERY distinct narration video that exists as a job's source.mp4, not only uploads:
 *   upload       a finished upload (jobs/_uploads/<id>) — source {kind: "upload", upload}; key = upload id
 *   job_source   the source.mp4 of one or more jobs — source {kind: "job_source", job} (that job's
 *                source.mp4, validated + hard-linked by aieditor/sources.py, no download):
 *                  key = the upload id when the jobs' narration was an upload made before the
 *                        library (its _uploads folder is gone) — deletable here as before;
 *                  key = "job:<id>" otherwise (a Descript download, a Lab edit) — NOT deletable
 *                        here: it is deleted through its job (Stored files).
 * One entry per INODE ((st_dev, st_ino)): the hard-linked source.mp4 of several jobs — and a
 * kept upload's data — is one narration; usedBy lists every job that has it as source.mp4 (+
 * the queued ones that will). origin says where it came from ("Descript: <title or share id>",
 * "Uploaded: <file>", "Lab edit of <job title>" — the same words as sources.py origin_of());
 * stage says RAW (the source of a cut job) or EDITED (a Lab edit, a creative job's source, a
 * final) — the New edit flow recommends raw for Cut / Full edit and edited for Creative /
 * Graphics only, but any may be picked. "Remove from library" writes an upload id into
 * _uploads/library.json "hidden", so the jobs of a removed upload do not come back.
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
  freedByJobs, JOB_ID_RE, jobsRoot, pendingNeeds, readJobs, spaceOf, StorageError, walk, walkAll,
  type FileRec, type JobInfo,
} from "./storage.js";

export type NarrationStage = "raw" | "edited";

export interface LibraryEntry {
  key: string;
  kind: "upload" | "job_source";
  /** for kind job_source: the job whose source.mp4 is used */
  job: string | null;
  name: string;
  /** where it came from: "Descript: <title or share id>" | "Uploaded: <file>" | "Lab edit of <job title>" */
  origin: string;
  /** raw = the source of a cut job; edited = a Lab edit / a creative job's source / a final; null = unused upload */
  stage: NarrationStage | null;
  /** false = a job's narration: deleted through that job (Stored files), never from the library */
  deletable: boolean;
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
  for (const re of [/^final-\d{2}\.mp4$/, /^edit-\d{2}\.mp4$/, /^preview-\d{2}\.mp4$/, /^listen-\d{2}\.mp4$/]) {
    const f = files.filter((x) => re.test(x)).sort()[0];
    if (f) return `/api/aieditor/files/${dir}/${f}#t=2`;
  }
  return null;
}

interface Group { id: string; jobs: JobInfo[] }

/** a video /api/aieditor/files serves (index.ts) — a raw source.mp4 never is */
const SERVED_RE = /^([a-z0-9][a-z0-9-]{2,63})\/((preview|listen|edit|final)-\d{2}\.mp4)$/;

/**
 * Where job <id>'s narration came from, for a person — mirrors aieditor/sources.py origin_of():
 * "Descript: <title or share id>", "Uploaded: <file name>", "Lab edit of <job title>".
 */
export async function originOf(id: string, depth = 0): Promise<string> {
  const dir = path.join(jobsRoot(), id);
  const sj = (await readJson<any>(path.join(dir, "source.json"))) ?? {};
  const req = (await readJson<any>(path.join(dir, "request.json"))) ?? {};
  const rs = req.source ?? {};
  const k = sj.kind || rs.kind || "descript";
  if (k === "job") {
    const fj = String(sj.from_job || rs.job || "");
    let t = sj.title || rs.title;
    if (!t && JOB_ID_RE.test(fj)) t = (await readJson<any>(path.join(jobsRoot(), fj, "request.json")))?.title;
    return `Lab edit of ${t || fj || "an earlier job"}`;
  }
  if (k === "upload") return `Uploaded: ${sj.filename || rs.name || "a file"}`;
  if (k === "job_source") {
    if (sj.origin || rs.origin) return String(sj.origin || rs.origin);
    if (sj.from_upload || rs.upload) return `Uploaded: ${sj.filename || rs.name || "a file"}`;
    const fj = String(sj.from_job || rs.job || "");
    if (depth < 8 && JOB_ID_RE.test(fj) && fj !== id) return originOf(fj, depth + 1);
    return `Reused narration of ${fj || id}`;
  }
  const sid = sj.share_id || String(rs.url ?? "").replace(/\/+$/, "").split("/").pop();
  return `Descript: ${sj.title || sid || "share link"}`;
}

/** the short name of a job's narration (source.json): the uploaded file, the Lab edit's / Descript title */
function labelName(sj: any, rs: any): string {
  return String(sj?.filename || sj?.title || sj?.share_id || rs?.name || rs?.title || "");
}

/**
 * RAW or EDITED. A Lab edit (source.json kind job) or a video that is also some job's final /
 * edit is edited; otherwise raw when a CUT job (or a Full edit = a chained cut) used it, edited
 * when only creative / graphics-only jobs did; null when nothing used it yet.
 */
function stageOf(users: JobInfo[], kinds: string[], linkedAs: string[]): NarrationStage | null {
  if (kinds.includes("job") || linkedAs.some((rel) => /\/(final|edit)-\d{2}(\.[^/]*)?\.mp4$/.test(rel))) return "edited";
  if (users.some((j) => (j.req?.workflow ?? "cut") !== "creative")) return "raw";
  return users.length ? "edited" : null;
}

export async function listLibrary(ctx?: { all?: FileRec[]; jobs?: JobInfo[] }): Promise<LibraryEntry[]> {
  const jobs = ctx?.jobs ?? await readJobs();
  const all = ctx?.all ?? await walkAll();
  const hid = await hidden();
  const needs = pendingNeeds(jobs);
  // upload id → the jobs whose request names it (pending ones included)
  const groups = new Map<string, Group>();
  for (const j of jobs) {
    const u = uploadOf(j.req);
    if (!u) continue;
    let g = groups.get(u);
    if (!g) groups.set(u, (g = { id: u, jobs: [] }));
    g.jobs.push(j);
  }
  // every link of every inode: "dev:ino" → the rel paths of its links
  const links = new Map<string, string[]>();
  for (const r of all) {
    if (r.dir) continue;
    let l = links.get(r.key);
    if (!l) links.set(r.key, (l = []));
    l.push(r.rel);
  }
  const keyOfRel = new Map(all.filter((r) => !r.dir).map((r) => [r.rel, r.key]));
  const root = uploadsRoot();
  let names: string[] = [];
  try { names = await fsp.readdir(root); } catch { /* none yet */ }
  const out: LibraryEntry[] = [];
  const seen = new Set<string>();
  /** inode → the entry that already lists it (a kept upload's data) */
  const byInode = new Map<string, { entry: LibraryEntry; jobs: JobInfo[] }>();

  const used = (js: JobInfo[]) => [...new Map(js.map((j) => [j.id, j])).values()]
    .map((j) => ({ id: j.id, title: String(j.req?.title || j.id), state: j.status?.state ?? null, busy: j.busy, at: secs(j.req?.created_at) ?? 0 }))
    .sort((a, b) => b.at - a.at)
    .map(({ at: _at, ...x }) => x);
  const blockAll = (js: JobInfo[], own: string | null) => {
    if (own) return own;
    const b = js.find((j) => j.busy);
    if (b) return `the job ${b.id} that uses it is ${b.busy}`;
    for (const [rel, by] of needs) {
      const top = rel.split("/")[0];
      if (js.some((j) => j.id === top) && !js.some((j) => j.id === by)) {
        return `the ${by} job (not started yet) needs a file of ${top}`;
      }
    }
    return null;
  };
  const kindsOf = async (js: JobInfo[]) => {
    const out: string[] = [];
    for (const j of js) out.push(String((await readJson<any>(path.join(j.dir, "source.json")))?.kind ?? j.req?.source?.kind ?? "descript"));
    return out;
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
    const mine = all.filter((r) => r.rel === `_uploads/${id}` || r.rel.startsWith(`_uploads/${id}/`));
    const need = needs.get(`_uploads/${id}`);
    const own = need ? `the ${need} job has not started yet and still needs it` : null;
    const ino = `${st.dev}:${st.ino}`;
    // + every job whose source.mp4 is this very file (e.g. a job_source reuse of one of them)
    const js = [...(g?.jobs ?? []), ...jobs.filter((j) => keyOfRel.get(`${j.id}/source.mp4`) === ino)];
    const entry: LibraryEntry = {
      key: id, kind: "upload", job: null, name: m.name, origin: `Uploaded: ${m.name}`,
      stage: stageOf(js, [], []), deletable: true,
      uploadedAt: secs(m.created_at),
      duration: pr?.duration ?? null, width: pr?.width ?? null, height: pr?.height ?? null,
      bytes: spaceOf(mine.filter((r) => r.rel.endsWith("/data"))).bytes, usedBy: used(js),
      poster: `/api/aieditor/uploads/${id}/video#t=2`,
      frees: spaceOf(mine).frees,
      freesAll: freedByJobs(all, used(js).map((j) => j.id), mine),
      blocked: own, blockedAll: blockAll(js, own),
    };
    out.push(entry);
    byInode.set(ino, { entry, jobs: js });
  }

  // 2. every other narration that exists as a job's source.mp4 — one entry per inode
  const inodes = new Map<string, JobInfo[]>();
  for (const j of jobs) {
    if (!j.hasSource) continue;
    let ino = keyOfRel.get(`${j.id}/source.mp4`);
    if (!ino) {
      const st = await fsp.lstat(path.join(j.dir, "source.mp4")).catch(() => null);
      if (!st?.isFile()) continue;
      ino = `${st.dev}:${st.ino}`;
    }
    let l = inodes.get(ino);
    if (!l) inodes.set(ino, (l = []));
    l.push(j);
  }
  const at = (j: JobInfo) => secs(j.req?.created_at) ?? 0;
  for (const [ino, holders] of inodes) {
    if (byInode.has(ino)) continue;                      // a kept upload's data: listed above
    holders.sort((a, b) => at(a) - at(b));
    // a holder whose download has finished (source.json) — the oldest one represents it
    let rep: { j: JobInfo; sj: any } | null = null;
    for (const j of holders) {
      const sj = await readJson<any>(path.join(j.dir, "source.json"));
      if (sj && typeof sj === "object") { rep = { j, sj }; break; }
    }
    if (!rep) continue;
    // queued jobs that will hard-link it (source job_source → one of its holders)
    const ids = new Set(holders.map((j) => j.id));
    const pending = jobs.filter((j) => !j.hasSource && j.req?.source?.kind === "job_source" && ids.has(String(j.req.source.job)));
    // an upload made before the library: keyed by its upload id, deletable here as before
    const upload = holders.map((j) => uploadOf(j.req)).find((u): u is string => !!u) ?? null;
    if (upload && (hid.has(upload) || seen.has(upload))) continue;
    const js = [...holders, ...pending, ...(upload ? groups.get(upload)?.jobs ?? [] : [])];
    const files = await fsp.readdir(rep.j.dir).catch(() => [] as string[]);
    const linkedAs = links.get(ino) ?? [];
    const served = linkedAs.map((rel) => SERVED_RE.exec(rel)).find(Boolean);
    const rs = rep.j.req?.source ?? {};
    const name = String(labelName(rep.sj, rs) || rep.j.req?.title || rep.j.id).slice(0, 200);
    if (upload) seen.add(upload);
    out.push({
      key: upload ?? `job:${rep.j.id}`, kind: "job_source", job: rep.j.id,
      name, origin: await originOf(rep.j.id),
      stage: stageOf(holders, await kindsOf(holders), linkedAs),
      deletable: !!upload,
      uploadedAt: secs(rep.j.req?.created_at),
      duration: num(rep.sj.duration), width: num(rep.sj.width), height: num(rep.sj.height),
      bytes: spaceOf(all.filter((r) => r.key === ino).slice(0, 1)).bytes,
      usedBy: used(js),
      // the raw source.mp4 is never served: the same file as a served final / preview, else
      // a video the job made from it (same speaker, same look)
      poster: served ? `/api/aieditor/files/${served[1]}/${served[2]}#t=2` : firstVideo(rep.j.id, files),
      frees: 0,
      freesAll: upload ? freedByJobs(all, used(js).map((j) => j.id)) : 0,
      blocked: upload ? null : "it is the narration of a job — delete it through that job (Stored files)",
      blockedAll: upload ? blockAll(js, null) : "it is the narration of a job — delete it through that job (Stored files)",
    });
  }
  return out.sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0));
}

/**
 * The request.json source of a library pick: {kind: job_source, job, name, origin, upload?},
 * validated. ANY job whose narration (source.mp4) exists may be reused — the worker hard-links
 * it (aieditor/sources.py, the same strict rules). `upload` only when that narration was an
 * upload (the key of an old upload's library entry).
 */
export async function jobSourceOf(job: unknown): Promise<{ kind: "job_source"; job: string; name: string; origin: string; upload?: string }> {
  const id = String(job ?? "");
  if (!JOB_ID_RE.test(id)) throw new Error("Choose a narration from the library.");
  const dir = path.join(jobsRoot(), id);
  const dst = await fsp.lstat(dir).catch(() => null);
  if (dst && !dst.isDirectory()) throw new Error("That narration's job is not a job folder.");
  const req = await readJson<any>(path.join(dir, "request.json"));
  if (!req) throw new Error("That narration's job no longer exists.");
  const st = await fsp.lstat(path.join(dir, "source.mp4")).catch(() => null);
  if (!st?.isFile()) throw new Error("That job has no source video any more.");
  const sj = await readJson<any>(path.join(dir, "source.json"));
  if (!sj || typeof sj !== "object") throw new Error("That job has not finished getting its narration yet.");
  const upload = uploadOf(req) ?? (UPLOAD_ID_RE.test(String(sj.from_upload ?? "")) ? String(sj.from_upload) : null);
  const name = String(labelName(sj, req.source) || req.title || id).slice(0, 200);
  return { kind: "job_source", job: id, name, origin: (await originOf(id)).slice(0, 240), ...(upload ? { upload } : {}) };
}

/**
 * Remove a narration from the library. mode "narration": the entry only (jobs keep their
 * hard-linked copy); "all": the entry AND every job made from it. Returns the bytes freed.
 */
export async function removeFromLibrary(key: unknown, mode: unknown, deleteJob: (id: string) => Promise<unknown>) {
  const id = String(key ?? "");
  if (id.startsWith("job:")) {
    throw new StorageError("That narration belongs to a job — delete it through that job in Stored files.", 400);
  }
  if (!UPLOAD_ID_RE.test(id)) throw new StorageError("Unknown narration.", 404);
  if (mode !== "narration" && mode !== "all") throw new StorageError("Say what to delete.");
  const jobs = await readJobs();
  const all = await walkAll();
  const entry = (await listLibrary({ all, jobs })).find((e) => e.key === id);
  if (!entry) throw new StorageError("That narration is not in the library any more.", 404);
  if (!entry.deletable) throw new StorageError("That narration belongs to a job — delete it through that job in Stored files.", 400);
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
