import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { db } from "../db/index.js";

/**
 * Resolve an input reference (as it appears in a manifest or a Rendi-style
 * input_files map) to an absolute local file path.
 *
 * Accepted forms, in priority order:
 *   - a known file id          -> uploadsDir/<stored>
 *   - "file:<id>"              -> uploadsDir/<stored>
 *   - "/uploads/<stored>" or "/api/uploads/<id>"  (our own URLs)
 *   - "http(s)://..."          -> downloaded once into tmpDir and cached
 *   - an existing local path   -> used as-is
 *
 * Downloads are cached by URL so the same remote asset reused across 300 jobs
 * is only fetched once.
 */

interface FileRow {
  id: string;
  stored: string;
}

function lookupFileById(id: string): string | null {
  const row = db.prepare("SELECT id, stored FROM files WHERE id = ?").get(id) as
    | FileRow
    | undefined;
  if (!row) return null;
  const abs = path.join(config.uploadsDir, row.stored);
  return fs.existsSync(abs) ? abs : null;
}

function safeName(url: string): string {
  return url.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-180);
}

async function downloadToCache(url: string): Promise<string> {
  const cacheName = `dl_${safeName(url)}`;
  const dest = path.join(config.tmpDir, cacheName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;

  // Abort a stalled download instead of hanging forever (a bad/slow remote URL
  // would otherwise freeze indexing/rendering with no recovery).
  const timeoutMs = Number.parseInt(process.env.DOWNLOAD_TIMEOUT_MS || "120000", 10);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download input ${url}: ${res.status}`);
    }
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    return dest;
  } catch (e) {
    try { fs.rmSync(`${dest}.part`, { force: true }); } catch { /* */ }
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`Download timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveInput(ref: string): Promise<string> {
  if (!ref) throw new Error("Empty input reference");

  // file:<id>
  if (ref.startsWith("file:")) {
    const p = lookupFileById(ref.slice(5));
    if (p) return p;
    throw new Error(`Unknown file id: ${ref}`);
  }

  // Our own upload URLs: /api/uploads/<id> or /uploads/<stored>
  const uploadsMatch = ref.match(/\/(?:api\/)?uploads\/([^/?#]+)/);
  if (uploadsMatch) {
    const token = decodeURIComponent(uploadsMatch[1]);
    const byId = lookupFileById(path.parse(token).name) || lookupFileById(token);
    if (byId) return byId;
    const byStored = path.join(config.uploadsDir, token);
    if (fs.existsSync(byStored)) return byStored;
    // fall through to remote download if it's actually absolute
  }

  // Remote URL
  if (/^https?:\/\//i.test(ref)) {
    return downloadToCache(ref);
  }

  // Bare file id
  const byId = lookupFileById(ref);
  if (byId) return byId;

  // Existing local path (absolute or relative to uploadsDir)
  if (fs.existsSync(ref)) return path.resolve(ref);
  const inUploads = path.join(config.uploadsDir, ref);
  if (fs.existsSync(inUploads)) return inUploads;

  throw new Error(`Could not resolve input reference: ${ref}`);
}
