/**
 * Headline FONT store for the Thumbnail Designer's contrarian-originals overlay.
 *
 * The contrarian headline is drawn programmatically (textOverlay.ts) in Helvetica.
 * Real Helvetica can't be bundled, so the creator can UPLOAD their own font file
 * here; it's stored under <dataDir>/thumbnail-fonts/ and used by the renderer in
 * preference to THUMBNAIL_FONT_PATH / the bundled Liberation Sans default.
 *
 * Only one headline font is kept at a time (uploading replaces it). Accepts
 * .ttf / .otf / .ttc / .woff / .woff2.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const ALLOWED_EXT = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);

function fontDir(): string {
  const d = path.join(config.dataDir, "thumbnail-fonts");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function metaPath(): string {
  return path.join(fontDir(), "meta.json");
}

interface FontMeta {
  /** Original filename (for display). */
  name: string;
  /** Stored filename (headline<ext>). */
  file: string;
  updatedAt: string;
}

function readMeta(): FontMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(metaPath(), "utf8"));
    if (m && typeof m.file === "string" && fs.existsSync(path.join(fontDir(), m.file))) {
      return { name: typeof m.name === "string" ? m.name : m.file, file: m.file, updatedAt: m.updatedAt || new Date().toISOString() };
    }
  } catch {
    /* missing / corrupt → none */
  }
  return null;
}

/** Absolute path to the uploaded headline font, or null when none is uploaded. */
export function uploadedFontPath(): string | null {
  const m = readMeta();
  return m ? path.join(fontDir(), m.file) : null;
}

export interface FontState {
  uploaded: boolean;
  /** Original filename, when uploaded. */
  name: string | null;
  updatedAt: string | null;
}

export function fontStatus(): FontState {
  const m = readMeta();
  return { uploaded: !!m, name: m?.name ?? null, updatedAt: m?.updatedAt ?? null };
}

/** Save (replace) the headline font from base64. Throws on a bad type/empty/oversized file. */
export function saveFont(filename: string, base64: string): FontState {
  const ext = path.extname(filename || "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error("Use a .ttf, .otf, .woff or .woff2 font file.");
  const clean = (base64 || "").replace(/^data:[^,]+,/, "").trim();
  if (!clean) throw new Error("No font data provided.");
  const buf = Buffer.from(clean, "base64");
  if (buf.length === 0) throw new Error("Font data is empty or not valid base64.");
  if (buf.length > 10 * 1024 * 1024) throw new Error("Font too large (max 10MB).");
  // Replace any existing font (clear the dir except we rewrite meta below).
  for (const f of fs.readdirSync(fontDir())) fs.rmSync(path.join(fontDir(), f), { force: true });
  const file = `headline${ext}`;
  fs.writeFileSync(path.join(fontDir(), file), buf);
  const meta: FontMeta = { name: path.basename(filename), file, updatedAt: new Date().toISOString() };
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
  return fontStatus();
}

/** Delete the uploaded headline font (revert to the env/bundled default). Idempotent. */
export function deleteFont(): FontState {
  try {
    for (const f of fs.readdirSync(fontDir())) fs.rmSync(path.join(fontDir(), f), { force: true });
  } catch {
    /* already gone */
  }
  return fontStatus();
}
