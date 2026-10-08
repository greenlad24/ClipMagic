/**
 * Auto Editor — a video uploaded from Jake's computer as the SOURCE of a creative edit.
 *
 * 3–12 GB 4K files go browser → Caddy → Express, so this is a RESUMABLE, OFFSET-based
 * chunked upload streamed straight to disk (express.json only parses JSON; an
 * application/octet-stream body is left for us to stream — never buffered):
 *
 *   POST   /api/aieditor/uploads              {name, size}  → {uploadId, received: 0, …}
 *   PUT    /api/aieditor/uploads/:id?offset=N  one chunk (~32 MB), application/octet-stream
 *   GET    /api/aieditor/uploads/:id           {received, size, complete} — resume from here
 *   POST   /api/aieditor/uploads/:id/complete  size check → complete
 *   DELETE /api/aieditor/uploads/:id           cancel (removes the folder)
 *
 * The invariant: upload.json "received" is the only truth for how many bytes are good. A
 * chunk is written at its offset into `data` and `received` moves only after the WHOLE
 * chunk landed (its Content-Length) — a chunk cut off mid-way leaves bytes past `received`
 * that the retry simply overwrites. A chunk whose offset ≠ received is refused with 409 +
 * the server's `received`, so a retried chunk that already landed can never be appended
 * twice. `complete` truncates `data` to exactly `size`.
 *
 * Files live in <AIEDITOR_WORK>/jobs/_uploads/<id>/{data, upload.json} — the SAME volume
 * as the jobs, so the worker hard-links `data` into the job as source.mp4 (aieditor/
 * sources.py) and then removes the folder. listJobs ignores `_uploads` (not a job id).
 * Abandoned uploads (no write for 2 days) are swept whenever a new upload starts.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type Request, type Response } from "express";

export const UPLOAD_ID_RE = /^u[0-9a-f]{24}$/;
export const MAX_UPLOAD_BYTES = 20 * 1024 ** 3;            // 20 GB
export const MAX_CHUNK_BYTES = 128 * 1024 ** 2;            // the client sends 32 MB
export const UPLOAD_TTL_MS = 2 * 24 * 3600 * 1000;         // 2 days without a write
export const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".mkv", ".webm"];
const DISK_HEADROOM = 5 * 1024 ** 3;

export class UploadError extends Error {
  status: number;
  extra: Record<string, unknown>;
  // (no parameter properties: the tests run under node's strip-only TypeScript)
  constructor(message: string, status = 400, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export interface UploadMeta {
  id: string;
  name: string;
  size: number;
  received: number;
  complete: boolean;
  created_at: number;
  updated_at: number;
  /** the job that will use it (createJob sets it): the sweep never removes it from under that job */
  job?: string;
}

/** read at call time (tests point AIEDITOR_WORK at a temp dir) */
export function uploadsRoot(): string {
  return path.join(process.env.AIEDITOR_WORK || "/aieditor-work", "jobs", "_uploads");
}

function dirOf(id: unknown): string {
  if (typeof id !== "string" || !UPLOAD_ID_RE.test(id)) throw new UploadError("Unknown upload.", 404);
  return path.join(uploadsRoot(), id);
}

/** name + size of a new upload: a video by extension, 1 byte … 20 GB. */
export function checkNewUpload(name: unknown, size: unknown): { name: string; size: number } {
  const n = path.basename(String(name ?? "")).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 200);
  if (!n) throw new UploadError("The file needs a name.");
  const ext = path.extname(n).toLowerCase();
  if (!VIDEO_EXTS.includes(ext)) {
    throw new UploadError(`Only video files: ${VIDEO_EXTS.join(", ")}.`);
  }
  const s = Number(size);
  if (!Number.isSafeInteger(s) || s <= 0) throw new UploadError("The file is empty.");
  if (s > MAX_UPLOAD_BYTES) throw new UploadError(`Up to ${MAX_UPLOAD_BYTES / 1024 ** 3} GB per file.`);
  return { name: n, size: s };
}

/**
 * May a chunk of `length` bytes (null = unknown) be written at `offset`? The 409 carries the
 * server's `received` so the client continues from there (a retried chunk that already
 * landed is skipped, never appended twice).
 */
export function checkChunk(meta: UploadMeta, offset: number, length: number | null): void {
  if (meta.complete) throw new UploadError("This upload is already complete.", 409, { received: meta.received });
  if (!Number.isSafeInteger(offset) || offset < 0) throw new UploadError("Bad offset.");
  if (offset !== meta.received) {
    throw new UploadError(`Expected offset ${meta.received}, got ${offset}.`, 409, { received: meta.received });
  }
  if (length !== null) {
    if (!Number.isSafeInteger(length) || length <= 0) throw new UploadError("Empty chunk.");
    if (length > MAX_CHUNK_BYTES) throw new UploadError("Chunk too large.", 413);
    if (offset + length > meta.size) throw new UploadError("The chunk runs past the end of the file.");
  }
}

/** What the browser sees (no paths). */
export function publicMeta(m: UploadMeta) {
  return { uploadId: m.id, name: m.name, size: m.size, received: m.received, complete: m.complete, job: m.job ?? null };
}

async function readMeta(dir: string): Promise<UploadMeta | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, "upload.json"), "utf8")) as UploadMeta;
  } catch {
    return null;
  }
}

async function writeMeta(dir: string, m: UploadMeta) {
  const tmp = path.join(dir, `upload.json.tmp-${randomBytes(3).toString("hex")}`);
  await fsp.writeFile(tmp, JSON.stringify(m));
  await fsp.rename(tmp, path.join(dir, "upload.json"));
}

export async function getUpload(id: unknown): Promise<UploadMeta> {
  const m = await readMeta(dirOf(id));
  if (!m) throw new UploadError("Unknown upload — it may have expired. Choose the file again.", 404);
  return m;
}

/**
 * Remove uploads with no write for `ttl` (abandoned, or finished but never used). One a job
 * still waits for (its folder exists without a source.mp4 yet) is kept.
 */
export async function sweepUploads(now = Date.now(), ttl = UPLOAD_TTL_MS): Promise<string[]> {
  const root = uploadsRoot();
  let names: string[] = [];
  try { names = await fsp.readdir(root); } catch { return []; }
  const removed: string[] = [];
  for (const id of names) {
    const dir = path.join(root, id);
    const m = await readMeta(dir);
    let last = m?.updated_at ?? 0;
    if (!m) {
      try { last = (await fsp.stat(dir)).mtimeMs; } catch { continue; }
    }
    if (now - last < ttl) continue;
    if (m?.job) {
      const jobDir = path.join(root, "..", m.job);
      const waiting = await fsp.access(path.join(jobDir, "request.json")).then(() => true, () => false)
        && !(await fsp.access(path.join(jobDir, "source.mp4")).then(() => true, () => false));
      if (waiting) continue;
    }
    await fsp.rm(dir, { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

export async function createUpload(input: { name?: unknown; size?: unknown }): Promise<UploadMeta> {
  const { name, size } = checkNewUpload(input?.name, input?.size);
  const root = uploadsRoot();
  await fsp.mkdir(root, { recursive: true });
  await sweepUploads().catch(() => []);
  try {
    const st = await fsp.statfs(root);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < size + DISK_HEADROOM) {
      throw new UploadError(`Not enough disk space: ${(free / 1e9).toFixed(1)} GB free, the file needs ${(size / 1e9).toFixed(1)} GB.`, 507);
    }
  } catch (e) {
    if (e instanceof UploadError) throw e;          // statfs unsupported: carry on
  }
  const id = `u${randomBytes(12).toString("hex")}`;
  const dir = path.join(root, id);
  await fsp.mkdir(dir);
  await fsp.writeFile(path.join(dir, "data"), "");
  const now = Date.now();
  const m: UploadMeta = { id, name, size, received: 0, complete: false, created_at: now, updated_at: now };
  await writeMeta(dir, m);
  return m;
}

const busy = new Set<string>();

/**
 * Write one chunk at `offset`. `body` is the request stream; `contentLength` its declared
 * length (null when absent). `received` moves only when the whole chunk landed.
 */
export async function appendChunk(
  id: unknown, offset: number, body: NodeJS.ReadableStream, contentLength: number | null,
): Promise<UploadMeta> {
  const dir = dirOf(id);
  if (busy.has(dir)) throw new UploadError("Another chunk of this upload is still being written.", 409);
  busy.add(dir);
  try {
    const m = await getUpload(id);
    checkChunk(m, offset, contentLength);
    const limit = Math.min(MAX_CHUNK_BYTES, m.size - offset);
    let written = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        written += chunk.length;
        if (written > limit) cb(new UploadError("The chunk runs past the end of the file.", 400));
        else cb(null, chunk);
      },
    });
    // r+ at `offset`: bytes past `received` from an earlier, cut-off attempt are overwritten
    const out = fs.createWriteStream(path.join(dir, "data"), { flags: "r+", start: offset });
    try {
      await pipeline(body, counter, out);
    } catch (e) {
      if (e instanceof UploadError) throw e;
      throw new UploadError("The chunk was cut off — it will be sent again.", 400, { received: m.received });
    }
    if (written === 0) throw new UploadError("Empty chunk.", 400, { received: m.received });
    if (contentLength !== null && written !== contentLength) {
      throw new UploadError("The chunk was cut off — it will be sent again.", 400, { received: m.received });
    }
    const next: UploadMeta = { ...m, received: offset + written, updated_at: Date.now() };
    await writeMeta(dir, next);
    return next;
  } finally {
    busy.delete(dir);
  }
}

export async function completeUpload(id: unknown): Promise<UploadMeta> {
  const dir = dirOf(id);
  const m = await getUpload(id);
  if (m.complete) return m;
  if (m.received !== m.size) {
    throw new UploadError(`Only ${m.received} of ${m.size} bytes arrived.`, 409, { received: m.received });
  }
  await fsp.truncate(path.join(dir, "data"), m.size);    // drop any bytes of a cut-off retry
  const st = await fsp.stat(path.join(dir, "data"));
  if (st.size !== m.size) throw new UploadError("The stored file has the wrong size.", 500);
  const next: UploadMeta = { ...m, complete: true, updated_at: Date.now() };
  await writeMeta(dir, next);
  return next;
}

export async function cancelUpload(id: unknown): Promise<void> {
  const dir = dirOf(id);
  const m = await readMeta(dir);
  if (m?.job) throw new UploadError("A job already uses this upload.", 409);
  await fsp.rm(dir, { recursive: true, force: true });
}

/** createJob: the upload must be complete and not taken by another job; marks it as this job's. */
export async function claimUpload(id: unknown, jobId: string): Promise<UploadMeta> {
  const dir = dirOf(id);
  const m = await getUpload(id);
  if (!m.complete) throw new UploadError("The upload has not finished yet.");
  if (m.job && m.job !== jobId) throw new UploadError("This upload is already used by another job — upload the file again.");
  const next: UploadMeta = { ...m, job: jobId, updated_at: Date.now() };
  await writeMeta(dir, next);
  return next;
}

function send(res: Response, fn: () => Promise<unknown>) {
  fn().then(
    (out) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(out);
    },
    (err) => {
      const status = err instanceof UploadError ? err.status : 500;
      const extra = err instanceof UploadError ? err.extra : {};
      res.status(status).json({ error: err instanceof Error ? err.message : String(err), ...extra });
    },
  );
}

/** Mounted at /api/aieditor/uploads behind the session gate (index.ts). */
export function aieditorUploadsRouter() {
  const r = express.Router();
  r.post("/", (req, res) => send(res, async () => publicMeta(await createUpload(req.body ?? {}))));
  r.get("/:id", (req, res) => send(res, async () => publicMeta(await getUpload(req.params.id))));
  r.put("/:id", (req: Request, res) => {
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    if (type !== "application/octet-stream") {
      res.status(415).json({ error: "Send the chunk as application/octet-stream." });
      return;
    }
    const len = req.headers["content-length"] !== undefined ? Number(req.headers["content-length"]) : null;
    send(res, async () => publicMeta(await appendChunk(req.params.id, Number(req.query.offset), req, len)));
  });
  r.post("/:id/complete", (req, res) => send(res, async () => publicMeta(await completeUpload(req.params.id))));
  r.delete("/:id", (req, res) => send(res, async () => {
    await cancelUpload(req.params.id);
    return { ok: true };
  }));
  return r;
}
