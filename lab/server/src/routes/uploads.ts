import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { Request } from "express";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { probe } from "../render/ffmpeg.js";
import { asyncHandler } from "../middleware.js";
import { publicUrlFor } from "../lib/urls.js";
import {
  DEFAULT_CHUNK_BYTES,
  UPLOAD_TTL_MS,
  planChunks,
  createSession,
  validateChunk,
  recordChunk,
  assertComplete,
  missingChunks,
  isStale,
  type UploadSession,
} from "../lib/chunkedUpload.js";

/**
 * Streaming upload endpoint — the fix for the old 25MB ceiling.
 *
 * multer's disk storage writes the request body straight to disk in chunks, so
 * multi-gigabyte files never sit in memory and there is no framework body-size
 * limit in the way (the only cap is the configurable MAX_UPLOAD_BYTES, default
 * 5GB, or 0 for unlimited). Accepts up to 500 files per request so a 300-video
 * bulk drop lands in one shot.
 *
 * For LARGE single files there is also a chunked, resumable API
 * (init / append / complete / abort) below: the client splits the file into
 * chunks and retries each one independently, and the assembled file is only ever
 * exposed once every byte has arrived — so a dropped connection can never leave a
 * usable-but-truncated upload.
 */
const router = Router();

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|mpg|mpeg|wmv|flv|3gp)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|tiff?|svg)$/i;

/**
 * Classify an upload. Prefer the MIME type, but fall back to the file extension
 * — some upload paths send `application/octet-stream`, and we still want videos
 * and audio probed for duration so the bulk editor can show/trim them.
 */
function kindFor(mime: string, name: string): string {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (VIDEO_EXT.test(name)) return "video";
  if (AUDIO_EXT.test(name)) return "audio";
  if (IMAGE_EXT.test(name)) return "image";
  return "other";
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, config.uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${nanoid()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: config.maxUploadBytes > 0 ? { fileSize: config.maxUploadBytes } : undefined,
});

const insert = db.prepare(
  `INSERT INTO files (id, original, stored, mime, kind, size, duration, width, height, created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?)`
);

interface StoredFile {
  id: string;
  original: string;
  kind: string;
  mime: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  url: string;
}

/**
 * Probe (tolerating failure), insert the `files` row, and shape the response
 * the frontend expects — shared by the single-POST path and the chunked
 * `complete` finalizer so both return an identical `{ id, url, ... }`.
 */
async function registerStoredFile(
  req: Request,
  args: { stored: string; original: string; mime: string; size: number },
): Promise<StoredFile> {
  const id = path.parse(args.stored).name;
  const kind = kindFor(args.mime, args.original);
  let duration: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  if (kind === "video" || kind === "audio" || kind === "image") {
    try {
      const info = await probe(path.join(config.uploadsDir, args.stored));
      duration = info.duration;
      width = info.width;
      height = info.height;
    } catch (e) {
      // A probe failure (truncated / odd-codec file) must NOT 500 the whole
      // upload — store the file with null metadata and let the editor surface
      // a clear, actionable error later. Log so the cause is visible server-side.
      console.warn(
        `[uploads] probe failed for "${args.original}" (${args.size} bytes) — stored without metadata: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }
  insert.run(id, args.original, args.stored, args.mime, kind, args.size, duration, width, height, Date.now());
  return {
    id,
    original: args.original,
    kind,
    mime: args.mime,
    size: args.size,
    duration,
    width,
    height,
    url: publicUrlFor(req, `/api/uploads/${id}`),
  };
}

router.post(
  "/",
  upload.array("files", 500),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ error: "No files uploaded (use form field name 'files')" });
      return;
    }

    const results: StoredFile[] = [];
    for (const f of files) {
      results.push(
        await registerStoredFile(req, {
          stored: f.filename,
          original: f.originalname,
          mime: f.mimetype,
          size: f.size,
        }),
      );
    }

    res.json({ files: results });
  })
);

// ── Chunked, resumable upload ──────────────────────────────────────────────
//
// Layout on disk: each in-flight upload owns a temp dir
//   <tmpDir>/chunked-uploads/<uploadId>/
// holding one file per chunk (`<index>.part`). Writing a chunk to its own file
// (rather than appending to a single growing file) makes a retried `append` of
// the same index naturally IDEMPOTENT — it just overwrites that one file — and
// removes any dependence on arrival order. `complete` concatenates the chunks
// 0..N-1 in order into the final uploads dir, but only after verifying every
// chunk is present and the byte total matches what `init` declared.

const CHUNK_ROOT = path.join(config.tmpDir, "chunked-uploads");
fs.mkdirSync(CHUNK_ROOT, { recursive: true });

/** In-memory session index. Source of truth for bytes-on-disk is the temp dir. */
const sessions = new Map<string, UploadSession>();

function chunkDir(uploadId: string): string {
  return path.join(CHUNK_ROOT, uploadId);
}
function chunkPath(uploadId: string, index: number): string {
  return path.join(chunkDir(uploadId), `${index}.part`);
}

async function rmDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

/**
 * init → allocate an uploadId + temp dir, echo the chunk size the client should
 * use. The client may propose a chunkSize; we accept it (it only affects how the
 * file is sliced) but clamp it to a sane range.
 */
router.post(
  "/chunked/init",
  asyncHandler(async (req, res) => {
    const { filename, size, chunkSize } = (req.body ?? {}) as {
      filename?: unknown;
      size?: unknown;
      chunkSize?: unknown;
    };
    if (typeof filename !== "string" || !filename.trim()) {
      res.status(400).json({ error: "filename is required" });
      return;
    }
    const totalSize = Number(size);
    if (!Number.isInteger(totalSize) || totalSize <= 0) {
      res.status(400).json({ error: "size must be a positive integer (bytes)" });
      return;
    }
    if (config.maxUploadBytes > 0 && totalSize > config.maxUploadBytes) {
      res.status(413).json({ error: `File exceeds the ${config.maxUploadBytes}-byte upload limit.` });
      return;
    }

    let cs = Number(chunkSize);
    if (!Number.isInteger(cs) || cs <= 0) cs = DEFAULT_CHUNK_BYTES;
    // Clamp to a sane band: at least 1 MB, at most 64 MB.
    cs = Math.min(Math.max(cs, 1024 * 1024), 64 * 1024 * 1024);

    const { totalChunks, chunkSize: finalChunkSize } = planChunks(totalSize, cs);
    const uploadId = nanoid();
    await fsp.mkdir(chunkDir(uploadId), { recursive: true });
    sessions.set(
      uploadId,
      createSession({
        uploadId,
        filename: filename.trim(),
        totalSize,
        totalChunks,
        chunkSize: finalChunkSize,
      }),
    );

    res.json({ uploadId, chunkSize: finalChunkSize, totalChunks });
  }),
);

/**
 * append → write one chunk's raw bytes. Idempotent: re-PUT of the same index
 * overwrites the same `.part` file, so a retry can never corrupt the assembly.
 * The chunk body is streamed to disk (never buffered in memory).
 */
router.put(
  "/chunked/:uploadId/:index",
  asyncHandler(async (req, res) => {
    const { uploadId } = req.params;
    const index = Number(req.params.index);
    const session = sessions.get(uploadId);
    if (!session) {
      res.status(404).json({ error: "Unknown or expired uploadId — re-init the upload." });
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      res.status(400).json({ error: `chunk index ${req.params.index} out of range` });
      return;
    }

    const dest = chunkPath(uploadId, index);
    const tmpDest = `${dest}.partial`;
    // Stream to a sidecar file first, then atomically rename — so an interrupted
    // append never leaves a half-written `.part` that complete() would trust.
    const out = fs.createWriteStream(tmpDest);
    let written = 0;
    req.on("data", (d: Buffer) => {
      written += d.length;
    });

    try {
      await new Promise<void>((resolve, reject) => {
        req.on("error", reject);
        out.on("error", reject);
        out.on("finish", () => resolve());
        req.pipe(out);
      });
    } catch (e) {
      await fsp.rm(tmpDest, { force: true });
      console.warn(`[uploads] chunk ${index} of ${uploadId} failed mid-write: ${e instanceof Error ? e.message : e}`);
      res.status(500).json({ error: "Failed to write chunk to disk." });
      return;
    }

    try {
      validateChunk(session, index, written);
    } catch (e) {
      await fsp.rm(tmpDest, { force: true });
      res.status(400).json({ error: e instanceof Error ? e.message : "invalid chunk" });
      return;
    }

    await fsp.rename(tmpDest, dest);
    recordChunk(session, index, written);
    res.json({ ok: true, index, received: session.received.size, totalChunks: session.totalChunks });
  }),
);

/**
 * complete → verify ALL chunks present and total size matches, assemble them in
 * order into the uploads dir under a nanoid name, probe, insert the row, and
 * return the SAME shape as the single-POST endpoint. Temp chunks are cleaned up.
 * The file is exposed ONLY after this succeeds, so a truncated upload is never
 * reachable.
 */
router.post(
  "/chunked/:uploadId/complete",
  asyncHandler(async (req, res) => {
    const { uploadId } = req.params;
    const session = sessions.get(uploadId);
    if (!session) {
      res.status(404).json({ error: "Unknown or expired uploadId — re-init the upload." });
      return;
    }

    try {
      assertComplete(session);
    } catch (e) {
      res.status(409).json({
        error: e instanceof Error ? e.message : "upload incomplete",
        missing: missingChunks(session),
      });
      return;
    }

    const ext = path.extname(session.filename) || "";
    const stored = `${nanoid()}${ext}`;
    const finalPath = path.join(config.uploadsDir, stored);

    // Assemble chunks 0..N-1 in order. Concatenation, never held in memory.
    const out = fs.createWriteStream(finalPath);
    try {
      for (let i = 0; i < session.totalChunks; i++) {
        const part = chunkPath(uploadId, i);
        await new Promise<void>((resolve, reject) => {
          const rs = fs.createReadStream(part);
          rs.on("error", reject);
          rs.on("end", () => resolve());
          out.on("error", reject);
          rs.pipe(out, { end: false });
        });
      }
      await new Promise<void>((resolve, reject) => {
        out.on("error", reject);
        out.end(() => resolve());
      });
    } catch (e) {
      await fsp.rm(finalPath, { force: true });
      console.error(`[uploads] failed to assemble ${uploadId}: ${e instanceof Error ? e.message : e}`);
      res.status(500).json({ error: "Failed to assemble the uploaded file on the server." });
      return;
    }

    // Final on-disk size guard — defends against a truncated/short chunk file
    // slipping past the byte bookkeeping.
    const actual = (await fsp.stat(finalPath)).size;
    if (actual !== session.totalSize) {
      await fsp.rm(finalPath, { force: true });
      console.error(`[uploads] assembled size mismatch for ${uploadId}: ${actual} vs ${session.totalSize}`);
      res.status(409).json({ error: `Assembled size ${actual} != expected ${session.totalSize}.` });
      return;
    }

    const mime = typeof req.body?.mime === "string" && req.body.mime ? req.body.mime : "application/octet-stream";
    const file = await registerStoredFile(req, {
      stored,
      original: session.filename,
      mime,
      size: session.totalSize,
    });

    // Clean up temp chunks + session.
    sessions.delete(uploadId);
    await rmDir(chunkDir(uploadId));

    // Match the single-POST `{ files: [...] }` shape so the client can read it
    // identically, and also expose the file directly for convenience.
    res.json({ files: [file], file });
  }),
);

/** abort → drop a partial upload's temp chunks. Best-effort, always 200. */
router.post(
  "/chunked/:uploadId/abort",
  asyncHandler(async (req, res) => {
    const { uploadId } = req.params;
    sessions.delete(uploadId);
    await rmDir(chunkDir(uploadId));
    res.json({ ok: true });
  }),
);

/**
 * Reap stale incomplete uploads: drop in-memory sessions past TTL and sweep any
 * orphaned temp dirs on disk (e.g. from a server restart) whose mtime is old.
 * Runs on an interval and once at startup; unref'd so it never holds the process
 * open.
 */
async function reapStaleUploads(): Promise<void> {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (isStale(session, UPLOAD_TTL_MS, now)) {
      sessions.delete(id);
      await rmDir(chunkDir(id)).catch(() => {});
      console.warn(`[uploads] reaped stale upload ${id} (idle > TTL)`);
    }
  }
  // Sweep orphaned dirs on disk not tracked by any session.
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(CHUNK_ROOT);
  } catch {
    return;
  }
  for (const name of entries) {
    if (sessions.has(name)) continue;
    const dir = path.join(CHUNK_ROOT, name);
    try {
      const st = await fsp.stat(dir);
      if (now - st.mtimeMs > UPLOAD_TTL_MS) {
        await rmDir(dir);
        console.warn(`[uploads] reaped orphaned chunk dir ${name}`);
      }
    } catch {
      /* ignore */
    }
  }
}

const reaper = setInterval(() => void reapStaleUploads(), 30 * 60 * 1000);
reaper.unref?.();
void reapStaleUploads();

/** Serve an uploaded file by id (used as input refs and for previews). */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id) as
      | { stored: string; mime: string | null }
      | undefined;
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (row.mime) res.type(row.mime);
    res.sendFile(path.join(config.uploadsDir, row.stored));
  })
);

export default router;
