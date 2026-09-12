/**
 * The Lab's view of the Hyperframes render queue.
 *
 * ⚠️ THIS MODULE IS A CONTROL PLANE, NOT A RUNNER. It never starts a render and
 * never touches Docker. It writes a job directory; the `hyperframes-worker`
 * systemd service on the HOST notices it, runs it, and writes progress back.
 * That split is the security boundary: a web app that could drive the Docker
 * daemon would be root on the host, so the Lab container is deliberately given
 * a directory and nothing else. Cancelling works the same way — a `cancel` file
 * the worker acts on, because only the worker owns the container.
 *
 * ⚠️ AND THE FILESYSTEM IS THE DATABASE. There is no table for jobs. The job
 * directory holds the request, the project, the cache, the output, the log and
 * the status, so "delete this video completely" is one `rm -rf` with nothing
 * left in a database to contradict it — which is exactly what Jake asked for.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { linkUploadInto } from "./uploads.js";

/** Shared with the host worker via a bind mount; see docker-compose.yml. */
const WORK = process.env.HYPERFRAMES_WORK || "/hyperframes-work";
const JOBS = path.join(WORK, "jobs");
const INBOX = path.join(WORK, "inbox");

/** A render the queue knows about. */
export interface HyperframesJob {
  id: string;
  name: string;
  /** The caller's own identifier, echoed back untouched. */
  clientRef: string | null;
  state: "queued" | "running" | "done" | "failed" | "cancelled" | "unknown";
  phase: string;
  step: string;
  framesCompleted: number | null;
  totalFrames: number | null;
  percent: number | null;
  attempt: number;
  message: string;
  output: string | null;
  outputBytes: number | null;
  /**
   * A joined video of the chunks that DID finish, when a chunked render stopped
   * early. Null when there is nothing to salvage.
   */
  partialOutput: string | null;
  partialSeconds: number | null;
  partialChunks: number | null;
  bytes: number;
  createdAt: number;
  updatedAt: number | null;
  elapsedSeconds: number | null;
  /**
   * Minutes left, from frames actually completed in this attempt.
   *
   * ⚠️ NULL UNTIL IT MEANS SOMETHING. A rate computed from three frames is
   * noise, and "4 minutes remaining" that becomes "40" a minute later is worse
   * than no estimate — so it stays null until enough of the render has been
   * measured to be worth quoting.
   */
  estimatedMinutesRemaining: number | null;
}

/** Frames that must be done before an estimate is offered at all. */
const ETA_MIN_FRAMES = 10;

function eta(done: number | null, total: number | null, elapsed: number | null): number | null {
  if (!done || !total || !elapsed || done < ETA_MIN_FRAMES || done >= total) return null;
  const perFrame = elapsed / done;
  return Math.max(1, Math.round(((total - done) * perFrame) / 60));
}

/** Something rsynced into the inbox, waiting to become a job. */
export interface InboxEntry {
  name: string;
  kind: "directory" | "archive";
  bytes: number;
  modifiedAt: number;
}

export interface HyperframesServiceStatus {
  ready: boolean;
  /** False when the worker has not written anything for a suspiciously long time. */
  workerHealthy: boolean;
  runtimeVersion: string | null;
  jobs: number;
  running: number;
  /** Waiting to start — NOT "everything that isn't running". */
  queued: number;
  diskFreeBytes: number;
  workBytes: number;
}

/* ────────────────────────── paths, guarded ────────────────────────── */

// ⚠️ NAMES COME FROM A BROWSER, SO THEY ARE NEVER TRUSTED AS PATHS. A job id or
// inbox entry of "../../etc" would otherwise escape the work directory on
// delete. Both are matched against a conservative pattern AND re-checked after
// resolution, because the pattern is easy to widen later and the resolve check
// is not.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

function safeJoin(root: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid name: ${name}`);
  const full = path.resolve(root, name);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Invalid name: ${name}`);
  }
  return full;
}

const jobDir = (id: string): string => safeJoin(JOBS, id);

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Recursive size. Used for "what is this costing me in disk". */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(full);
    else if (e.isFile()) {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        /* raced with a delete */
      }
    }
  }
  return total;
}

/* ────────────────────────── reading ────────────────────────── */

interface RawStatus {
  state?: string;
  phase?: string;
  step?: string;
  frames_completed?: number;
  total_frames?: number | null;
  percent?: number | null;
  attempt?: number;
  message?: string;
  output?: string | null;
  output_bytes?: number;
  partial_output?: string | null;
  partial_seconds?: number | null;
  partial_chunks?: number | null;
  updated_at?: number;
  elapsed_seconds?: number;
}

const STATES = ["queued", "running", "done", "failed", "cancelled"] as const;

async function toJob(id: string, withBytes: boolean): Promise<HyperframesJob> {
  const dir = jobDir(id);
  const spec = await readJson<{ name?: string; client_ref?: string }>(path.join(dir, "job.json"), {});
  const s = await readJson<RawStatus>(path.join(dir, "status.json"), {});
  const created = await fsp.stat(dir).then((st) => st.birthtimeMs || st.mtimeMs).catch(() => 0);
  const state = (STATES as readonly string[]).includes(s.state ?? "")
    ? (s.state as HyperframesJob["state"])
    : s.state === undefined
      ? "queued"
      : "unknown";
  return {
    id,
    name: spec.name || id,
    clientRef: spec.client_ref || null,
    state,
    phase: s.phase || "",
    step: s.step || "",
    framesCompleted: s.frames_completed ?? null,
    totalFrames: s.total_frames ?? null,
    percent: s.percent ?? null,
    attempt: s.attempt ?? 0,
    message: s.message || "",
    output: s.output ?? null,
    outputBytes: s.output_bytes ?? null,
    partialOutput: s.partial_output ?? null,
    partialSeconds: s.partial_seconds ?? null,
    partialChunks: s.partial_chunks ?? null,
    bytes: withBytes ? await dirBytes(dir) : 0,
    createdAt: created,
    updatedAt: s.updated_at ? s.updated_at * 1000 : null,
    elapsedSeconds: s.elapsed_seconds ?? null,
    estimatedMinutesRemaining:
      state === "running"
        ? eta(s.frames_completed ?? null, s.total_frames ?? null, s.elapsed_seconds ?? null)
        : null,
  };
}

export async function listJobs(): Promise<HyperframesJob[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(JOBS, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SAFE_NAME.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  const jobs = await Promise.all(names.map((n) => toJob(n, true)));
  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getJob(id: string, logBytes = 16000): Promise<{ job: HyperframesJob; log: string }> {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) throw new Error("No such job.");
  const job = await toJob(id, true);
  let log = "";
  try {
    const file = path.join(dir, "render.log");
    const { size } = await fsp.stat(file);
    const start = Math.max(0, size - logBytes);
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      // The renderer paints a progress bar with \r; without collapsing it the
      // tail is one unreadable line thousands of characters wide.
      log = buf.toString("utf8").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n");
    } finally {
      await fh.close();
    }
  } catch {
    log = "";
  }
  return { job, log };
}

export async function listInbox(): Promise<InboxEntry[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(INBOX, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InboxEntry[] = [];
  for (const e of entries) {
    if (!SAFE_NAME.test(e.name)) continue;
    const full = path.join(INBOX, e.name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) continue;
    if (e.isDirectory()) {
      out.push({ name: e.name, kind: "directory", bytes: await dirBytes(full), modifiedAt: st.mtimeMs });
    } else if (/\.(zip|tar|tar\.gz|tgz)$/i.test(e.name)) {
      out.push({ name: e.name, kind: "archive", bytes: st.size, modifiedAt: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export async function serviceStatus(): Promise<HyperframesServiceStatus> {
  const jobs = await listJobs();
  const running = jobs.filter((j) => j.state === "running");
  // Counted, not inferred: `jobs.length - running` called a finished job queued.
  const queued = jobs.filter((j) => j.state === "queued").length;
  let diskFreeBytes = 0;
  try {
    const st = await fsp.statfs(WORK);
    diskFreeBytes = Number(st.bavail) * Number(st.bsize);
  } catch {
    /* statfs is best-effort */
  }
  // A running job whose status has not moved in five minutes means the worker
  // died without marking anything — the one failure a progress bar hides.
  const stale = running.some((j) => j.updatedAt !== null && Date.now() - j.updatedAt > 5 * 60_000);
  return {
    ready: fs.existsSync(JOBS),
    workerHealthy: !stale,
    runtimeVersion: process.env.HYPERFRAMES_VERSION || null,
    jobs: jobs.length,
    running: running.length,
    queued,
    diskFreeBytes,
    workBytes: jobs.reduce((n, j) => n + j.bytes, 0),
  };
}

/* ────────────────────────── writing ────────────────────────── */

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(4, 12);
  return `${base || "job"}-${stamp}`;
}

async function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exited ${code}`))));
  });
}

export interface CreateJobInput {
  name: string;
  /** An entry from `listInbox`. */
  source: string;
  outputName?: string;
  fps?: number;
  quality?: "draft" | "standard" | "high";
  workers?: number;
}

export async function createJob(input: CreateJobInput): Promise<HyperframesJob> {
  const source = safeJoin(INBOX, input.source);
  if (!fs.existsSync(source)) throw new Error(`Not in the inbox: ${input.source}`);

  const id = slug(input.name || input.source);
  const dir = jobDir(id);
  if (fs.existsSync(dir)) throw new Error("A job with that name was just created; try again.");
  await fsp.mkdir(path.join(dir, "output"), { recursive: true });
  await fsp.mkdir(path.join(dir, "cache"), { recursive: true });

  const project = path.join(dir, "project");
  const st = await fsp.stat(source);
  if (st.isDirectory()) {
    // ⚠️ MOVE, NOT COPY. A project with 5 GB of footage would otherwise exist
    // twice on a disk that has ~45 GB free, and the copy would take minutes for
    // no benefit — the inbox is a staging area, not an archive.
    await fsp.rename(source, project);
  } else {
    await fsp.mkdir(project, { recursive: true });
    if (/\.zip$/i.test(source)) await run("unzip", ["-q", "-o", source, "-d", project]);
    else await run("tar", ["-xf", source, "-C", project]);
    await fsp.rm(source, { force: true });
    // A zip of a folder unpacks one level deep; lift it so the project root is
    // where the renderer expects index.html.
    const kids = await fsp.readdir(project, { withFileTypes: true });
    if (kids.length === 1 && kids[0].isDirectory()) {
      const inner = path.join(project, kids[0].name);
      for (const child of await fsp.readdir(inner)) {
        await fsp.rename(path.join(inner, child), path.join(project, child));
      }
      await fsp.rmdir(inner);
    }
  }

  const spec = {
    name: input.name || id,
    output_name: (input.outputName || "render.mp4").replace(/[^A-Za-z0-9._-]/g, "-"),
    fps: cleanFps(input.fps),
    quality: input.quality || "high",
    workers: input.workers && input.workers > 0 ? Math.min(8, Math.round(input.workers)) : 1,
    created_at: Date.now(),
  };
  // job.json last: the worker claims a directory the moment this file exists, so
  // everything it needs must already be in place.
  await fsp.writeFile(path.join(dir, "job.json"), JSON.stringify(spec, null, 2) + "\n");
  return toJob(id, true);
}

/** Ask the worker to stop a running render. It owns the container, not us. */
export async function cancelJob(id: string): Promise<void> {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) throw new Error("No such job.");
  await fsp.writeFile(path.join(dir, "cancel"), "");
}

/** Put a failed or cancelled job back in the queue. */
export async function retryJob(id: string): Promise<HyperframesJob> {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) throw new Error("No such job.");
  await fsp.rm(path.join(dir, "cancel"), { force: true });
  const s = await readJson<RawStatus>(path.join(dir, "status.json"), {});
  await fsp.writeFile(
    path.join(dir, "status.json"),
    JSON.stringify({ ...s, state: "queued", phase: "requeued", message: "", attempt: 0 }, null, 2) + "\n",
  );
  return toJob(id, true);
}

/**
 * Delete a job's files.
 *
 * ⚠️ A RUNNING JOB IS CANCELLED, NOT DELETED UNDERNEATH ITSELF — removing the
 * directory while a container writes into it leaves the render writing to a
 * deleted mount. The caller gets told to wait rather than being quietly ignored.
 */
export async function deleteJob(id: string, keepOutput = false): Promise<{ freedBytes: number }> {
  const dir = jobDir(id);
  if (!fs.existsSync(dir)) throw new Error("No such job.");
  const before = await dirBytes(dir);
  const job = await toJob(id, false);
  if (job.state === "running") {
    await cancelJob(id);
    throw new Error("That render is still going. It is now cancelling — delete it again in a moment.");
  }
  if (keepOutput) {
    for (const child of await fsp.readdir(dir)) {
      if (child === "output" || child === "status.json" || child === "job.json") continue;
      await fsp.rm(path.join(dir, child), { recursive: true, force: true });
    }
    return { freedBytes: before - (await dirBytes(dir)) };
  }
  await fsp.rm(dir, { recursive: true, force: true });
  return { freedBytes: before };
}


/* ────────────────────────── the API's way in ────────────────────────── */

/**
 * An ffmpeg pass over a source before the render sees it.
 *
 * ⚠️ THE RENDERER IS NOT A TRANSCODER. Handing a 1080p clip to a 4K composition
 * makes Chrome upscale it per frame with whatever filtering it feels like; doing
 * it once here with lanczos is both better looking and cheaper. This is the
 * "4K preparation step" a caller cannot do for itself when the footage only
 * exists as a URL.
 */
export interface ApiSourcePrepare {
  /** Exact output frame size, e.g. "3840x2160". */
  scale?: string;
  fps?: number;
  /** Seconds into the source to start. */
  trimStart?: number;
  /** Seconds to keep. */
  trimDuration?: number;
}

export interface ApiSource {
  name: string;
  url: string;
  bytes?: number;
  prepare?: ApiSourcePrepare;
}

/** One file in an inline project: text, or binary carried as base64. */
export type ApiProjectFile = string | { text?: string; base64?: string };

export interface CreateApiJobInput {
  name: string;
  clientRef?: string;
  /** filename → text, or {base64} for binary. `index.html` is required. */
  projectFiles?: Record<string, ApiProjectFile>;
  /** …or an archive URL the worker downloads and unpacks. */
  projectUrl?: string;
  /** …or a bucket of already-uploaded assets, hard-linked in. */
  uploadId?: string;
  sources?: ApiSource[];
  /**
   * Frames per second: a number, or an ffmpeg-style rational string.
   *
   * ⚠️ RATIONALS MATTER AND USED TO BE DESTROYED HERE. This field was
   * `Math.round`ed, so 29.97 silently became 30 and "30000/1001" became NaN and
   * then 30 — while the renderer itself accepts rationals. Rendering 29.97
   * source at 30 duplicates roughly one frame a second, which reads as judder on
   * slow camera moves, and it contradicts "preserve source cadence".
   */
  fps?: number | string;
  quality?: "draft" | "standard" | "high";
  outputName?: string;
  /**
   * Seconds of timeline per rendered chunk. `chunkFrames` wins if both are given.
   *
   * ⚠️ STALE COMMENT REMOVED: chunking used to require the composition to opt in
   * with `data-hf-chunkable`. It no longer does — the worker re-times ordinary
   * compositions itself, so chunking is the DEFAULT and `data-hf-chunkable="false"`
   * opts out. The worker is authoritative; see its chunk_plan().
   */
  chunkSeconds?: number;
  /** Frames per chunk. Default 150 — see the worker's CHUNK_FRAMES_DEFAULT. */
  chunkFrames?: number;
}

/**
 * Total inline project bytes accepted, counted DECODED.
 *
 * ⚠️ Raised from 5 MB when binary files became legal, because the old ceiling
 * was sized for markup. It is deliberately not larger: a JSON body is parsed
 * into memory in one piece, so anything of real size belongs in an upload
 * bucket, which streams.
 */
const MAX_INLINE_PROJECT_BYTES = 24 * 1024 * 1024;

/**
 * Decode one inline project file.
 *
 * ⚠️ BASE64 IS VALIDATED BEFORE IT IS DECODED, because `Buffer.from(s,"base64")`
 * silently DISCARDS characters it does not recognise. A truncated or mangled
 * font would land as a slightly-too-short file, render as a fallback typeface,
 * and look like a styling bug rather than a transport bug.
 */
function decodeProjectFile(name: string, raw: ApiProjectFile): Buffer {
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  if (raw && typeof raw === "object") {
    if (typeof raw.base64 === "string") {
      const b64 = raw.base64.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        throw new Error(`project.files["${name}"].base64 is not valid base64.`);
      }
      return Buffer.from(b64, "base64");
    }
    if (typeof raw.text === "string") return Buffer.from(raw.text, "utf8");
  }
  throw new Error(`project.files["${name}"] must be a string, {text} or {base64}.`);
}

/** ⚠️ Every prepare value reaches an ffmpeg argv, so none of them are free-form. */
function cleanPrepare(raw: unknown, sourceName: string): ApiSourcePrepare | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: ApiSourcePrepare = {};
  if (r.scale !== undefined) {
    const scale = String(r.scale).trim().toLowerCase();
    if (!/^[0-9]{2,5}x[0-9]{2,5}$/.test(scale)) {
      throw new Error(`prepare.scale for ${sourceName} must look like "3840x2160".`);
    }
    out.scale = scale;
  }
  if (r.fps !== undefined) {
    const fps = Number(r.fps);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
      throw new Error(`prepare.fps for ${sourceName} must be between 1 and 240.`);
    }
    out.fps = Math.round(fps);
  }
  for (const key of ["trimStart", "trimDuration"] as const) {
    const snake = key === "trimStart" ? "trim_start" : "trim_duration";
    const value = r[key] ?? r[snake];
    if (value === undefined) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`prepare.${snake} for ${sourceName} must be a positive number of seconds.`);
    }
    out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * ⚠️ EVERY FILENAME IN A SUBMIT IS HOSTILE UNTIL PROVEN OTHERWISE. `project.files`
 * is a map whose keys become paths on this disk: "../../etc/cron.d/x" or
 * "/etc/passwd" would otherwise be written wherever the key says. Subdirectories
 * are allowed because compositions use them, so each segment is checked rather
 * than banning the separator.
 */
export function safeRelative(name: string): string {
  const clean = name.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = clean.split("/").filter(Boolean);
  if (!parts.length) throw new Error(`Empty filename in project.files`);
  for (const part of parts) {
    if (part === "." || part === ".." || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(part)) {
      throw new Error(`Unsafe filename: ${name}`);
    }
  }
  return parts.join("/");
}

/**
 * Normalise a frame rate, keeping rationals intact.
 *
 * Accepts 30, 29.97, or "30000/1001" (NTSC), "24000/1001" (23.976). A rational
 * is passed through verbatim so the renderer receives exactly what the source
 * uses; a bare number is kept as-is when it is a clean integer and otherwise
 * left alone rather than rounded, because rounding is the bug this replaced.
 */
function cleanFps(raw: number | string | undefined): number | string {
  if (raw === undefined || raw === null || raw === "") return 30;
  if (typeof raw === "string") {
    const rational = /^\s*(\d{1,7})\s*\/\s*(\d{1,7})\s*$/.exec(raw);
    if (rational) {
      const num = Number(rational[1]);
      const den = Number(rational[2]);
      const value = den > 0 ? num / den : 0;
      if (value <= 0 || value > 240) throw new Error(`render.fps out of range: ${raw}`);
      return `${num}/${den}`;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`render.fps is not a frame rate: ${raw}`);
    raw = parsed;
  }
  if (!Number.isFinite(raw) || raw <= 0 || raw > 240) {
    throw new Error(`render.fps out of range: ${raw}`);
  }
  return raw;
}

export async function createApiJob(input: CreateApiJobInput): Promise<HyperframesJob> {
  const files = input.projectFiles;
  const hasFiles = !!files && typeof files === "object" && Object.keys(files).length > 0;
  const uploadId = input.uploadId ? String(input.uploadId).trim() : "";
  if (!hasFiles && !input.projectUrl && !uploadId) {
    throw new Error("Supply project.files, project.upload_id or project.url.");
  }

  const sources: ApiSource[] = (input.sources ?? []).map((raw) => {
    const name = String(raw?.name || "").trim();
    const url = String(raw?.url || "").trim();
    if (!name || !url) throw new Error("Each source needs a name and a url.");
    if (name.includes("/") || name.startsWith(".")) throw new Error(`Unsafe source name: ${name}`);
    const prepare = cleanPrepare((raw as { prepare?: unknown }).prepare, name);
    // The URL is NOT validated for reachability here — the worker does that, at
    // fetch time, with the SSRF guard, because that is when the request happens.
    return {
      name,
      url,
      ...(raw.bytes ? { bytes: Number(raw.bytes) } : {}),
      ...(prepare ? { prepare } : {}),
    };
  });

  const id = slug(input.name);
  const dir = jobDir(id);
  if (fs.existsSync(dir)) throw new Error("A job with that name already exists; rename it.");
  const project = path.join(dir, "project");
  await fsp.mkdir(project, { recursive: true });
  await fsp.mkdir(path.join(dir, "output"), { recursive: true });
  await fsp.mkdir(path.join(dir, "cache"), { recursive: true });

  // ⚠️ FAILURES FROM HERE ON MUST NOT LEAVE A HALF-BUILT JOB DIRECTORY, because
  // `job.json` is written last and the worker claims the directory the instant
  // it appears — a partial project would render, and fail, rather than 400.
  try {
    // The bucket lands first so that inline files win on a name collision:
    // uploaded assets are the bulk, inline files are the edit.
    if (uploadId) await linkUploadInto(uploadId, project);

    if (hasFiles) {
      let total = 0;
      for (const [name, content] of Object.entries(files)) {
        const buf = decodeProjectFile(name, content);
        total += buf.length;
        if (total > MAX_INLINE_PROJECT_BYTES) {
          throw new Error(
            `Inline project exceeds ${MAX_INLINE_PROJECT_BYTES / 1024 ** 2} MB decoded; ` +
              "upload the large assets instead (POST /uploads).",
          );
        }
        const rel = safeRelative(name);
        const dest = path.join(project, rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, buf);
      }
    }

    // Checked on disk rather than in the request, so it holds however the
    // project arrived. `project.url` is the exception: the worker unpacks it
    // long after this returns, and checks there.
    if (!input.projectUrl && !fs.existsSync(path.join(project, "index.html"))) {
      throw new Error("The project has no index.html at its root.");
    }
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw err;
  }

  const spec = {
    name: input.name,
    client_ref: input.clientRef || "",
    output_name: (input.outputName || "render.mp4").replace(/[^A-Za-z0-9._-]/g, "-"),
    fps: cleanFps(input.fps),
    quality: input.quality || "high",
    workers: 1,
    ...(input.chunkFrames ? { chunk_frames: Math.max(1, Math.round(input.chunkFrames)) } : {}),
    ...(input.chunkSeconds ? { chunk_seconds: Math.max(2, Math.min(60, input.chunkSeconds)) } : {}),
    // job.json is read by the Python worker, so it speaks snake_case there.
    sources: sources.map((s) => ({
      name: s.name,
      url: s.url,
      ...(s.bytes ? { bytes: s.bytes } : {}),
      ...(s.prepare
        ? {
            prepare: {
              ...(s.prepare.scale ? { scale: s.prepare.scale } : {}),
              ...(s.prepare.fps ? { fps: s.prepare.fps } : {}),
              ...(s.prepare.trimStart !== undefined ? { trim_start: s.prepare.trimStart } : {}),
              ...(s.prepare.trimDuration !== undefined
                ? { trim_duration: s.prepare.trimDuration }
                : {}),
            },
          }
        : {}),
    })),
    ...(input.projectUrl ? { project_url: String(input.projectUrl) } : {}),
    created_at: Date.now(),
  };
  // Written last: the worker claims the directory the moment this exists.
  await fsp.writeFile(path.join(dir, "job.json"), JSON.stringify(spec, null, 2) + "\n");
  return toJob(id, false);
}
