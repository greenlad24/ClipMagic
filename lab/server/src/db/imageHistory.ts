/**
 * Typed CRUD over the `image_history` table (defined in db/index.ts) for the AI
 * Image Generator. Mirrors db/scriptRuns.ts: plain better-sqlite3 prepared
 * statements, nanoid() ids, Date.now() timestamps.
 *
 * Unlike the keyword/script tables, the payload here is an image FILE: the bytes
 * are written to disk under config.imageHistoryDir as <id>.<ext> and this table
 * indexes them. `persistImage` does both (write file + insert row) so callers
 * can't drift the two; `deleteImage` removes both. The serve URL is a RELATIVE
 * path (/api/image-history/<id>.<ext>) so the browser loads it same-origin with
 * the session cookie — never PUBLIC_BASE_URL.
 */
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "./index.js";
import { config } from "../config.js";

const now = () => Date.now();

/** Whether this image was generated from scratch or edited from reference(s). */
export type ImageKind = "generate" | "edit";

/** Raw image_history row shape (SQLite columns). */
interface ImageHistoryRow {
  id: string;
  prompt: string;
  file_path: string;
  mime: string;
  kind: string;
  model: string | null;
  created_at: number;
}

/** A hydrated history item for the API/UI (relative serve URL included). */
export interface ImageHistoryItem {
  id: string;
  prompt: string;
  url: string;
  mime: string;
  kind: ImageKind;
  model: string | null;
  createdAt: number;
}

/** Map a MIME type to a file extension (default png). */
function extForMime(mime: string): string {
  const m = (mime || "").toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  return "png";
}

/** Relative, same-origin serve URL for a stored image file. */
function urlFor(filePath: string): string {
  return `/api/image-history/${path.basename(filePath)}`;
}

function rowToItem(row: ImageHistoryRow): ImageHistoryItem {
  return {
    id: row.id,
    prompt: row.prompt,
    url: urlFor(row.file_path),
    mime: row.mime,
    kind: (row.kind === "edit" ? "edit" : "generate") as ImageKind,
    model: row.model,
    createdAt: row.created_at,
  };
}

/**
 * Persist a generated image: decode the base64, write it to disk as <id>.<ext>,
 * and insert its metadata row. Returns the hydrated history item (with relative
 * URL). Throws if the bytes are empty/invalid.
 */
export function persistImage(rec: {
  prompt: string;
  base64: string;
  mime: string;
  kind: ImageKind;
  model?: string | null;
}): ImageHistoryItem {
  const clean = (rec.base64 || "").replace(/^data:[^,]+,/, "").trim();
  if (!clean) throw new Error("No image data to persist.");
  const buf = Buffer.from(clean, "base64");
  if (buf.length === 0) throw new Error("Image data is empty or not valid base64.");

  const id = nanoid();
  const filePath = path.join(config.imageHistoryDir, `${id}.${extForMime(rec.mime)}`);
  fs.mkdirSync(config.imageHistoryDir, { recursive: true });
  fs.writeFileSync(filePath, buf);

  const t = now();
  db.prepare(
    `INSERT INTO image_history (id, prompt, file_path, mime, kind, model, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, rec.prompt, filePath, rec.mime, rec.kind, rec.model ?? null, t);

  return {
    id,
    prompt: rec.prompt,
    url: urlFor(filePath),
    mime: rec.mime,
    kind: rec.kind,
    model: rec.model ?? null,
    createdAt: t,
  };
}

/** History items, newest first. */
export function listImages(): ImageHistoryItem[] {
  const rows = db
    .prepare("SELECT * FROM image_history ORDER BY created_at DESC")
    .all() as ImageHistoryRow[];
  return rows.map(rowToItem);
}

/** One history item, or null if unknown. */
export function getImage(id: string): ImageHistoryItem | null {
  const row = db.prepare("SELECT * FROM image_history WHERE id = ?").get(id) as
    | ImageHistoryRow
    | undefined;
  return row ? rowToItem(row) : null;
}

/** Delete a history item: remove the row AND its file on disk. Idempotent. */
export function deleteImage(id: string): void {
  const row = db.prepare("SELECT * FROM image_history WHERE id = ?").get(id) as
    | ImageHistoryRow
    | undefined;
  if (row) {
    try {
      fs.rmSync(row.file_path, { force: true });
    } catch {
      /* already gone */
    }
  }
  db.prepare("DELETE FROM image_history WHERE id = ?").run(id);
}
