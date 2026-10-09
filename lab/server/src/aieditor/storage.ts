/**
 * Auto Editor — "Stored files": what the jobs keep on the 500 GB factory volume
 * (/mnt/factory_media/jobs on the host = /opt/aieditor-work/jobs = /aieditor-work/jobs here),
 * and deleting it for real (Jake 2026-10-09: "I want to be able to delete narrations and files
 * that were stored on the volume also").
 *
 * SPACE = ALLOCATED BYTES OF UNIQUE INODES — the same rule as the host storage-agent
 * (storage-agent/storage_agent.py: st_blocks × 512, one count per (st_dev, st_ino)), so this
 * view and the Storage page agree. A library narration and the source.mp4 of every job that
 * used it are HARD LINKS of one inode; a final-01.mp4 reused as a creative source is too.
 * Deleting one link frees nothing — space comes back only when the LAST link goes. So every
 * "frees" figure here is: the inodes whose every link (st_nlink) is inside what is deleted.
 * A link outside the jobs folder (st_nlink higher than the links we can see) is never counted
 * as freed.
 *
 * PROTECTION — never delete what a running or queued job needs:
 *   - a BUSY job (queue.json, or a status state that is not finished: running, queued …) —
 *     nothing of it is deleted (the same rule as storage_agent.job_busy);
 *   - a file another busy job will still materialise as its source (request.json "source" of a
 *     busy job that has no source.mp4 yet): a Lab edit's final/preview, an earlier job's
 *     source.mp4 (job_source) or a library upload (_uploads/<id>).
 *
 * Every delete is recorded in the job's deleted.json, so the job view says "deleted" instead
 * of silently losing a final.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
export const UPLOAD_DIR_RE = /^u[0-9a-f]{24}$/;
/** storage_agent.JOB_FINISHED (+ held: a held edit is a finished state, the worker is done with it) */
export const JOB_FINISHED = new Set(["done", "failed", "error", "cancelled", "canceled", "interrupted", "complete", "completed", "held"]);

export function jobsRoot(): string {
  return path.join(process.env.AIEDITOR_WORK || "/aieditor-work", "jobs");
}

export class StorageError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

// ── jobs and what they need ──

export interface JobInfo {
  id: string;
  dir: string;
  req: any;
  status: any;
  /** null = not busy; else why ("queued", "running" …) */
  busy: string | null;
  hasSource: boolean;
}

export async function jobBusy(dir: string, status?: any): Promise<string | null> {
  if (fs.existsSync(path.join(dir, "queue.json"))) return "queued";
  const st = status === undefined ? await readJson<any>(path.join(dir, "status.json")) : status;
  const s = st?.state ? String(st.state).toLowerCase() : null;
  if (st?.held === true) return null;
  return s && !JOB_FINISHED.has(s) ? s : null;
}

export async function readJobs(): Promise<JobInfo[]> {
  const root = jobsRoot();
  let names: string[] = [];
  try { names = await fsp.readdir(root); } catch { return []; }
  const out: JobInfo[] = [];
  for (const id of names.sort()) {
    if (!JOB_ID_RE.test(id)) continue;
    const dir = path.join(root, id);
    const req = await readJson<any>(path.join(dir, "request.json"));
    if (!req) continue;
    const status = await readJson<any>(path.join(dir, "status.json"));
    out.push({
      id, dir, req, status,
      busy: await jobBusy(dir, status),
      hasSource: !!(await fsp.lstat(path.join(dir, "source.mp4")).catch(() => null))?.isFile(),
    });
  }
  return out;
}

/**
 * Paths (relative to the jobs folder) that a busy job still has to materialise: a Lab edit's
 * video, an earlier job's source.mp4, a library upload folder. → the job that needs it.
 */
export function pendingNeeds(jobs: JobInfo[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const j of jobs) {
    if (!j.busy || j.hasSource) continue;
    const s = j.req?.source ?? {};
    if (s.kind === "job" && JOB_ID_RE.test(String(s.job)) && /^(final|preview)-\d{2}\.mp4$/.test(String(s.file))) {
      out.set(`${s.job}/${s.file}`, j.id);
    } else if (s.kind === "job_source" && JOB_ID_RE.test(String(s.job))) {
      out.set(`${s.job}/source.mp4`, j.id);
    } else if (s.kind === "upload" && UPLOAD_DIR_RE.test(String(s.upload))) {
      out.set(`_uploads/${s.upload}`, j.id);
    }
  }
  return out;
}

// ── what a file is ──

export type FileKind = "source" | "preview" | "final" | "edit" | "handoff" | "screencast" | "graphics" | "temp" | "data";
export const KINDS: { id: FileKind; title: string; deletable: boolean }[] = [
  { id: "source", title: "Source", deletable: true },
  { id: "preview", title: "Preview / listen", deletable: true },
  { id: "final", title: "Final", deletable: true },
  { id: "edit", title: "Edit", deletable: true },
  { id: "handoff", title: "Hand-off zip + folder", deletable: true },
  { id: "screencast", title: "Screencast recordings + segments", deletable: true },
  { id: "graphics", title: "Graphics", deletable: true },
  { id: "temp", title: "Temporary / intermediate", deletable: true },
  { id: "data", title: "Job data (plans, logs)", deletable: false },
];

const DATA_EXT = /\.(json|jsonl|txt|log|md|xml|srt|vtt)$/i;
const TEMP_TOP = /^(tmp-|chunks-)|\.part(\.mp4)?$|\.placing$|^source\.part$|^(audio16k|full48k|roomtone)\./;

/**
 * kind + the deletion root (the entry removed as a whole: a top-level file/folder, or one
 * entry inside an edit-NN/ folder). Every file under a root has the root's kind.
 */
export function classify(rel: string): { kind: FileKind; root: string } {
  const parts = rel.split("/");
  const top = parts[0];
  const leaf = parts.length === 1;
  if (TEMP_TOP.test(top)) return { kind: "temp", root: top };
  if (top === "source.mp4") return { kind: "source", root: top };
  if (/^(preview|listen)-\d{2}\.mp4$/.test(top)) return { kind: "preview", root: top };
  if (/^final-\d{2}\.mp4$/.test(top)) return { kind: "final", root: top };
  if (/^edit-\d{2}(\.[a-z0-9-]+)?\.mp4$/i.test(top)) return { kind: "edit", root: top };
  if (/^handoff/.test(top)) return { kind: "handoff", root: top };
  if (/^(gfx|gfx4k|gfx-long|graphics-|captions)/.test(top) && !(leaf && DATA_EXT.test(top))) return { kind: "graphics", root: top };
  if (/^(sc-|seg-|rec$|screencasts?$|profile$)/.test(top)) return { kind: "screencast", root: top };
  if (/^edit-\d{2}$/.test(top) && parts.length > 1) {
    const sub = parts[1];
    const root = `${top}/${sub}`;
    const subLeaf = parts.length === 2;
    if (/^(sc-|seg-)/.test(sub) && !(subLeaf && DATA_EXT.test(sub))) return { kind: "screencast", root };
    if (/^(rec|screencasts?|profile|recordings?)$/.test(sub)) return { kind: "screencast", root };
    if (/^handoff/.test(sub)) return { kind: "handoff", root };
    if (/^(gfx|gfx4k|gfx-long|textgrad|captions|overlays?)/.test(sub) && !(subLeaf && DATA_EXT.test(sub))) return { kind: "graphics", root };
    if (/^(tmp-|chunks-)|\.part(\.mp4)?$/.test(sub)) return { kind: "temp", root };
    if (subLeaf && DATA_EXT.test(sub)) return { kind: "data", root };
    return { kind: "temp", root };                 // facecam/, intermediate renders …
  }
  if (leaf && DATA_EXT.test(top)) return { kind: "data", root: top };
  if (/^(preprod|review)$/.test(top)) return { kind: "data", root: top };
  if (leaf && /\.(mp4|mov|mkv|wav|mp3|m4a|aac|ts|h264|png|jpg|webm)$/i.test(top)) return { kind: "temp", root: top };
  return { kind: "data", root: top };
}

// ── the walk + hard-link accounting ──

export interface FileRec {
  /** relative to the jobs folder: "<job>/…" or "_uploads/<id>/…" */
  rel: string;
  key: string;            // st_dev:st_ino
  nlink: number;
  bytes: number;          // allocated (st_blocks × 512)
  size: number;           // apparent
  /** a directory's own blocks (counted like storage-agent does; gone with its folder) */
  dir?: boolean;
}

/** every regular file under `dir` (no symlinks followed), rel to the jobs folder */
export async function walk(dir: string, relBase: string, out: FileRec[] = []): Promise<FileRec[]> {
  let ents: fs.Dirent[] = [];
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const st = await fsp.lstat(p).catch(() => null);
      if (!st?.isDirectory()) continue;
      out.push({ rel, key: `${st.dev}:${st.ino}`, nlink: 1, bytes: Number(st.blocks) * 512, size: 0, dir: true });
      await walk(p, rel, out);
    } else if (e.isFile()) {
      const st = await fsp.lstat(p).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({ rel, key: `${st.dev}:${st.ino}`, nlink: st.nlink, bytes: Number(st.blocks) * 512, size: st.size });
    }
  }
  return out;
}

/**
 * Space: each inode once. `frees` = allocated bytes of the inodes whose EVERY link
 * (st_nlink) is in `recs` (a link elsewhere — another job, the library, outside the jobs
 * folder — keeps the bytes on disk).
 */
export function spaceOf(recs: FileRec[]): { bytes: number; frees: number; shared: number } {
  const by = new Map<string, { n: number; nlink: number; bytes: number }>();
  for (const r of recs) {
    const g = by.get(r.key);
    if (g) g.n++;
    else by.set(r.key, { n: 1, nlink: r.nlink, bytes: r.bytes });
  }
  let bytes = 0, frees = 0;
  for (const g of by.values()) {
    bytes += g.bytes;
    if (g.n >= g.nlink) frees += g.bytes;
  }
  return { bytes, frees, shared: bytes - frees };
}

/** where else each inode lives (other jobs / the library), for "shared with …" */
function linkOwners(all: FileRec[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of all) {
    const owner = r.rel.startsWith("_uploads/") ? r.rel.split("/").slice(0, 2).join("/") : r.rel.split("/")[0];
    let s = m.get(r.key);
    if (!s) m.set(r.key, (s = new Set()));
    s.add(owner);
  }
  return m;
}

/** every file and folder of the jobs folder, the folder itself included (rel "") */
export async function walkAll(): Promise<FileRec[]> {
  const out: FileRec[] = [];
  const st = await fsp.lstat(jobsRoot()).catch(() => null);
  if (st?.isDirectory()) out.push({ rel: "", key: `${st.dev}:${st.ino}`, nlink: 1, bytes: Number(st.blocks) * 512, size: 0, dir: true });
  return walk(jobsRoot(), "", out);
}

export async function volumeOf(): Promise<{ total: number; used: number; free: number } | null> {
  try {
    const st = await fsp.statfs(jobsRoot());
    const bs = Number(st.bsize);
    const total = Number(st.blocks) * bs;
    const free = Number(st.bavail) * bs;
    return { total, used: total - Number(st.bfree) * bs, free };
  } catch {
    return null;
  }
}

// ── the "Stored files" listing ──

export interface KindRow { kind: FileKind; title: string; bytes: number; frees: number; files: number; deletable: boolean; blocked: string | null; sharedWith: string[] }
export interface JobStorage {
  id: string; title: string; state: string | null; busy: string | null; createdAt: number | null;
  bytes: number; frees: number; kinds: KindRow[]; blocked: string | null;
  deleted: DeletedEntry[];
}

function titleOf(j: JobInfo): string {
  return String(j.req?.title || j.id);
}

/** why a delete in this job is refused (null = allowed); `roots` = the deletion roots */
function blockedFor(j: JobInfo, roots: string[], needs: Map<string, string>): string | null {
  if (j.busy) return `the job is ${j.busy} — wait for it to finish or cancel it`;
  for (const r of roots) {
    const by = needs.get(`${j.id}/${r}`);
    if (by) return `${r} is the source of the ${by} job, which has not started yet`;
  }
  return null;
}

export async function listStoredJobs(all?: FileRec[], jobs?: JobInfo[]): Promise<JobStorage[]> {
  all = all ?? await walkAll();
  jobs = jobs ?? await readJobs();
  const needs = pendingNeeds(jobs);
  const owners = linkOwners(all);
  const byJob = new Map<string, FileRec[]>();
  for (const r of all) {
    const top = r.rel.split("/")[0];
    let l = byJob.get(top);
    if (!l) byJob.set(top, (l = []));
    l.push(r);
  }
  const out: JobStorage[] = [];
  for (const j of jobs) {
    // (the job folder's own record, rel "<id>", has no kind: it only counts in the job total)
    const recs = byJob.get(j.id) ?? [];
    const groups = new Map<FileKind, { recs: FileRec[]; roots: Set<string> }>();
    for (const r of recs) {
      if (r.rel === j.id) continue;
      const c = classify(r.rel.slice(j.id.length + 1));
      let g = groups.get(c.kind);
      if (!g) groups.set(c.kind, (g = { recs: [], roots: new Set() }));
      g.recs.push(r);
      g.roots.add(c.root);
    }
    const kinds: KindRow[] = [];
    for (const k of KINDS) {
      const g = groups.get(k.id);
      if (!g) continue;
      const sp = spaceOf(g.recs);
      const shared = new Set<string>();
      for (const r of g.recs) for (const o of owners.get(r.key) ?? []) if (o !== j.id) shared.add(o);
      kinds.push({
        kind: k.id, title: k.title, bytes: sp.bytes, frees: sp.frees, files: g.recs.filter((r) => !r.dir).length, deletable: k.deletable,
        blocked: k.deletable ? blockedFor(j, [...g.roots], needs) : null, sharedWith: [...shared].sort(),
      });
    }
    const sp = spaceOf(recs);
    const allRoots = [...new Set(recs.filter((r) => r.rel !== j.id).map((r) => classify(r.rel.slice(j.id.length + 1)).root))];
    out.push({
      id: j.id, title: titleOf(j), state: j.status?.state ?? null, busy: j.busy,
      createdAt: Number(j.req?.created_at) > 1e11 ? Number(j.req.created_at) / 1000 : (j.req?.created_at ?? null),
      bytes: sp.bytes, frees: sp.frees, kinds, blocked: blockedFor(j, allRoots, needs),
      deleted: await readDeleted(j.dir),
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

// ── deleting ──

export interface DeletedEntry { kind: FileKind; files: string[]; at: number; bytes: number; freed: number }

export async function readDeleted(dir: string): Promise<DeletedEntry[]> {
  const d = await readJson<{ deleted?: DeletedEntry[] }>(path.join(dir, "deleted.json"));
  return Array.isArray(d?.deleted) ? d!.deleted! : [];
}

async function noteDeleted(dir: string, e: DeletedEntry) {
  const list = await readDeleted(dir);
  list.push(e);
  const tmp = path.join(dir, `deleted.json.tmp-${process.pid}`);
  await fsp.writeFile(tmp, JSON.stringify({ deleted: list.slice(-200) }, null, 1));
  await fsp.rename(tmp, path.join(dir, "deleted.json"));
}

async function freeNow(): Promise<number | null> {
  return (await volumeOf())?.free ?? null;
}

/**
 * Delete one kind of file of a finished job (all of its roots). Returns what was removed and
 * the bytes freed (hard links accounted for: computed before, and measured on the volume).
 */
export async function deleteJobKind(id: unknown, kind: unknown) {
  if (typeof id !== "string" || !JOB_ID_RE.test(id)) throw new StorageError("Unknown job.", 404);
  const k = KINDS.find((x) => x.id === kind);
  if (!k || !k.deletable) throw new StorageError("That kind of file cannot be deleted on its own.");
  const jobs = await readJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) throw new StorageError("Unknown job.", 404);
  const all = await walkAll();
  const recs = all.filter((r) => r.rel.startsWith(`${id}/`)).map((r) => ({ r, c: classify(r.rel.slice(id.length + 1)) }))
    .filter((x) => x.c.kind === k.id);
  if (!recs.length) return { ok: true, removed: [] as string[], freed: 0, expected: 0 };
  const roots = [...new Set(recs.map((x) => x.c.root))].sort();
  const why = blockedFor(j, roots, pendingNeeds(jobs));
  if (why) throw new StorageError(`Not deleted: ${why}.`, 409);
  const expected = spaceOf(recs.map((x) => x.r)).frees;
  const before = await freeNow();
  for (const r of roots) {
    const p = path.join(j.dir, r);
    if (path.relative(j.dir, p).startsWith("..")) continue;            // (roots are plain names)
    await fsp.rm(p, { recursive: true, force: true });
  }
  const after = await freeNow();
  const bytes = spaceOf(recs.map((x) => x.r)).bytes;
  await noteDeleted(j.dir, { kind: k.id, files: roots, at: Date.now() / 1000, bytes, freed: expected });
  return { ok: true, removed: roots, freed: expected, expected, measured: before !== null && after !== null ? Math.max(0, after - before) : null };
}

/** What deleting whole jobs frees (their links + `extra` records, e.g. a library upload). */
export function freedByJobs(all: FileRec[], ids: string[], extra: FileRec[] = []): number {
  const set = new Set(ids);
  return spaceOf([...all.filter((r) => set.has(r.rel.split("/")[0])), ...extra]).frees;
}

/** The checks before a whole job is deleted (autoEditorDelete): not busy, not a pending source. */
export async function assertJobDeletable(id: string, jobs?: JobInfo[]): Promise<void> {
  jobs = jobs ?? await readJobs();
  const j = jobs.find((x) => x.id === id);
  if (!j) return;
  if (j.busy) throw new StorageError(`Not deleted: the job ${id} is ${j.busy} — cancel it first.`, 409);
  for (const [rel, by] of pendingNeeds(jobs)) {
    if (rel.startsWith(`${id}/`) && by !== id) {
      throw new StorageError(`Not deleted: ${rel.slice(id.length + 1)} of ${id} is the source of the ${by} job, which has not started yet.`, 409);
    }
  }
}
