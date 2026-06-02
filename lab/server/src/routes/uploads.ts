import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { probe } from "../render/ffmpeg.js";
import { asyncHandler } from "../middleware.js";
import { publicUrlFor } from "../lib/urls.js";

/**
 * Streaming upload endpoint — the fix for the old 25MB ceiling.
 *
 * multer's disk storage writes the request body straight to disk in chunks, so
 * multi-gigabyte files never sit in memory and there is no framework body-size
 * limit in the way (the only cap is the configurable MAX_UPLOAD_BYTES, default
 * 5GB, or 0 for unlimited). Accepts up to 500 files per request so a 300-video
 * bulk drop lands in one shot.
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

router.post(
  "/",
  upload.array("files", 500),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ error: "No files uploaded (use form field name 'files')" });
      return;
    }

    const results = [];
    for (const f of files) {
      const id = path.parse(f.filename).name;
      const kind = kindFor(f.mimetype, f.originalname);
      let duration: number | null = null;
      let width: number | null = null;
      let height: number | null = null;
      if (kind === "video" || kind === "audio" || kind === "image") {
        const info = await probe(f.path);
        duration = info.duration;
        width = info.width;
        height = info.height;
      }
      insert.run(id, f.originalname, f.filename, f.mimetype, kind, f.size, duration, width, height, Date.now());
      results.push({
        id,
        original: f.originalname,
        kind,
        mime: f.mimetype,
        size: f.size,
        duration,
        width,
        height,
        url: publicUrlFor(req, `/api/uploads/${id}`),
      });
    }

    res.json({ files: results });
  })
);

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
