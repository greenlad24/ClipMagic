/**
 * Storage management — list and delete everything the server keeps on disk so
 * the operator can free space and see, at a glance, whether the data volume is
 * full (the usual cause of upload/render failures).
 *
 * Areas under DATA_DIR:
 *   - uploads/                 → source media (narration videos, music, promos)
 *   - outputs/                 → finished renders (the big .mp4 files)
 *   - outputs/stickers/        → generated/fetched sticker image cache (regenerates)
 *   - tmp/                     → remote-download cache (always safe to delete)
 *   - tmp/chunked-uploads/     → in-progress resumable-upload temp (regenerates)
 *   - .remotion-chromium/      → Remotion's Chromium browser cache (regenerates)
 *   - db/                      → sqlite — NEVER offered for deletion
 *
 * Per-file deletes are path-traversal-safe (resolveSafe), and the pure-cache
 * areas can be wiped wholesale ("Clear") — they are recreated on demand.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";

/**
 * Deletable categories. The first three are the original flat-file dirs; the
 * rest are the cache/temp areas now surfaced so they can be reclaimed.
 *   - stickers          → outputs/stickers  (generated sticker images)
 *   - chunked           → tmp/chunked-uploads (resumable-upload temp)
 *   - remotionChromium  → .remotion-chromium  (Chromium browser cache)
 */
type Category =
  | "uploads"
  | "outputs"
  | "tmp"
  | "stickers"
  | "chunked"
  | "remotionChromium";

const STICKERS_DIR = path.join(config.outputsDir, "stickers");
const CHUNKED_DIR = path.join(config.tmpDir, "chunked-uploads");

const DIRS: Record<Category, string> = {
  uploads: config.uploadsDir,
  outputs: config.outputsDir,
  tmp: config.tmpDir,
  stickers: STICKERS_DIR,
  chunked: CHUNKED_DIR,
  remotionChromium: config.remotionBrowserCacheDir,
};

/**
 * Pure-cache areas: every file regenerates on demand, so the whole area is safe
 * to wipe with one "Clear" action (deleteStorageArea). User content (uploads,
 * renders) is NOT here — those are deleted per-file only.
 */
const CACHE_CATEGORIES = new Set<Category>(["tmp", "stickers", "chunked", "remotionChromium"]);

export interface StorageItem {
  category: Category;
  name: string;        // stored filename on disk
  id?: string;         // files-table id (uploads only)
  original?: string;   // original upload filename
  mime?: string;
  size: number;        // bytes
  mtime: number;       // epoch ms
  url?: string;        // serve URL (for preview/download)
  /** Upload role: which part of the app references this file. */
  kind?: "music" | "promo" | "narrator";
}

/** One disk-consuming area in the breakdown. */
export interface StorageArea {
  category: Category;
  label: string;
  size: number;        // total bytes (recursive)
  count: number;       // file count (recursive)
  /** Pure cache that regenerates — safe to wipe wholesale. */
  cache: boolean;
}

/** Extract the upload id/token from an /api/uploads/<id> (or bare) URL. */
function uploadIdFromUrl(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  const m = url.match(/\/(?:api\/)?uploads\/([^/?#]+)/);
  const token = m ? decodeURIComponent(m[1]) : url;
  // token may be "<id>" or "<id>.<ext>" — strip an extension.
  return token.replace(/\.[a-z0-9]+$/i, "");
}

/** Normalize a name/filename for fuzzy matching (lowercase, alnum only). */
function normName(s: unknown): string {
  return typeof s === "string" ? s.toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9]+/g, "") : "";
}

/** Audio file? (music tracks). */
function isAudioFile(name: string, mime?: string): boolean {
  if (mime && mime.startsWith("audio/")) return true;
  return /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma)$/i.test(name);
}

/**
 * Recursively total the bytes and file count under a directory. Symlinks are
 * not followed (lstat) so a stray link can't escape the tree or double-count.
 * Missing dir → {size:0, count:0}. Pure + exported for unit testing.
 */
export function dirStats(dir: string): { size: number; count: number } {
  let size = 0;
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { size: 0, count: 0 };
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        const sub = dirStats(full);
        size += sub.size;
        count += sub.count;
      } else if (ent.isFile()) {
        size += fs.statSync(full).size;
        count += 1;
      }
      // skip symlinks / sockets / fifos
    } catch {
      /* unreadable entry — skip */
    }
  }
  return { size, count };
}

/**
 * Collect, per role, the upload ids AND normalized names referenced by the
 * app's records — so we can classify an upload by URL OR by filename match
 * (the URL match alone misses bulk-imported / re-uploaded promos).
 */
function referencedUploads(): {
  music: { ids: Set<string>; names: Set<string> };
  promo: { ids: Set<string>; names: Set<string> };
  narrator: { ids: Set<string> };
} {
  const music = { ids: new Set<string>(), names: new Set<string>() };
  const promo = { ids: new Set<string>(), names: new Set<string>() };
  const narrator = { ids: new Set<string>() };
  const rowsOf = (table: string): any[] => {
    try {
      return (db.prepare(`SELECT doc FROM ${table}`).all() as Array<{ doc: string }>)
        .map((r) => { try { return JSON.parse(r.doc); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  };
  for (const d of rowsOf("z_music_tracks")) {
    const id = uploadIdFromUrl(d?.audioUrl); if (id) music.ids.add(id);
    const n = normName(d?.trackName); if (n) music.names.add(n);
  }
  for (const d of rowsOf("z_promo_videos")) {
    const id = uploadIdFromUrl(d?.videoUrl); if (id) promo.ids.add(id);
    const n = normName(d?.productName); if (n) promo.names.add(n);
  }
  for (const d of rowsOf("z_projects")) {
    const a = uploadIdFromUrl(d?.narrationUrl); if (a) narrator.ids.add(a);
    const b = uploadIdFromUrl(d?.audioUrl); if (b) narrator.ids.add(b);
  }
  return { music, promo, narrator };
}

/**
 * Resolve a category+name to an absolute path, rejecting any traversal. The
 * name must resolve to a direct child of the category dir (no "..", no nested
 * subdirs, no absolute escape). The db lives outside every DIR, so it can never
 * be reached this way. Pure + exported for unit testing.
 */
export function resolveSafe(category: Category, name: string): string | null {
  const dir = DIRS[category];
  if (!dir || typeof name !== "string" || !name) return null;
  const resolved = path.resolve(dir, name);
  // Must be a direct child of the category dir (no subdirs, no "..").
  if (path.dirname(resolved) !== path.resolve(dir)) return null;
  return resolved;
}

function listDir(category: Category): StorageItem[] {
  const dir = DIRS[category];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: StorageItem[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ category, name, size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch {
      /* skip unreadable entries */
    }
  }
  return out;
}

/** List every stored file by category, with totals and disk usage. */
export async function listStorage() {
  const uploads = listDir("uploads");
  const outputs = listDir("outputs");
  const tmp = listDir("tmp");
  // Sticker cache + chunked-upload temp are flat enough to list individually,
  // letting the operator drop a single stale file rather than the whole area.
  const stickers = listDir("stickers");
  const chunked = listDir("chunked");

  // Enrich uploads from the files table (id / original name / mime) and tag the
  // role (music / promo / narrator) by cross-referencing the app's records —
  // matching on upload-id OR original filename, since bulk-imported / re-uploaded
  // promos won't have a URL pointing back at the upload id.
  const refs = referencedUploads();
  try {
    const rows = db
      .prepare("SELECT id, stored, original, mime FROM files")
      .all() as Array<{ id: string; stored: string; original: string | null; mime: string | null }>;
    const byStored = new Map(rows.map((r) => [r.stored, r]));
    for (const f of uploads) {
      const r = byStored.get(f.name);
      if (r) {
        f.id = r.id;
        f.original = r.original ?? undefined;
        f.mime = r.mime ?? undefined;
      }
      const fid = f.id ?? f.name.replace(/\.[a-z0-9]+$/i, "");
      const fname = normName(f.original ?? f.name);
      // Fuzzy name match: exact, or either side contains the other (>=4 chars)
      // so "veo31" matches the promo "Veo 3.1 NEW" → "veo31new".
      const nameMatches = (names: Set<string>) => {
        if (!fname) return false;
        if (names.has(fname)) return true;
        for (const n of names) {
          if (n.length >= 4 && fname.length >= 4 && (n.includes(fname) || fname.includes(n))) return true;
        }
        return false;
      };
      // Classify: explicit id/name reference wins; then audio→music; else narrator.
      if (refs.music.ids.has(fid) || nameMatches(refs.music.names) || isAudioFile(f.original ?? f.name, f.mime)) {
        f.kind = "music";
      } else if (refs.promo.ids.has(fid) || nameMatches(refs.promo.names)) {
        f.kind = "promo";
      } else {
        f.kind = "narrator";
      }
      f.url = `/api/uploads/${encodeURIComponent(f.id ?? f.name)}`;
    }
  } catch {
    /* files table optional */
  }
  for (const f of outputs) f.url = `/api/outputs/${encodeURIComponent(f.name)}`;
  for (const f of stickers) f.url = `/api/outputs/stickers/${encodeURIComponent(f.name)}`;
  // chunked-upload parts have no public serve URL — leave url undefined.

  // Split uploads into role-based groups for the UI.
  const narratorUploads = uploads.filter((f) => f.kind === "narrator");
  const musicUploads = uploads.filter((f) => f.kind === "music");
  const promoUploads = uploads.filter((f) => f.kind === "promo");

  // Biggest first — that's what the operator wants to clear.
  const bySize = (a: StorageItem, b: StorageItem) => b.size - a.size;
  [uploads, outputs, tmp, stickers, chunked, narratorUploads, musicUploads, promoUploads].forEach((a) =>
    a.sort(bySize),
  );

  const sum = (arr: StorageItem[]) => arr.reduce((s, f) => s + f.size, 0);

  // Recursive totals for areas that hold subdirs / are otherwise nested.
  const stickerStats = dirStats(STICKERS_DIR);
  const chunkedStats = dirStats(CHUNKED_DIR);
  const chromiumStats = dirStats(config.remotionBrowserCacheDir);
  // outputs total = flat renders only (stickers live in a subdir, counted apart).
  // tmp total = flat download cache only (chunked temp counted apart).
  const totals = {
    uploads: sum(uploads),
    narrator: sum(narratorUploads),
    music: sum(musicUploads),
    promo: sum(promoUploads),
    outputs: sum(outputs),
    tmp: sum(tmp),
    stickers: stickerStats.size,
    chunked: chunkedStats.size,
    remotionChromium: chromiumStats.size,
    all:
      sum(uploads) +
      sum(outputs) +
      sum(tmp) +
      stickerStats.size +
      chunkedStats.size +
      chromiumStats.size,
  };

  // A flat breakdown of every space consumer (for the UI's overview), biggest
  // first. The db is deliberately absent — never deletable.
  const breakdown: StorageArea[] = ([
    { category: "uploads", label: "Uploads", size: totals.uploads, count: uploads.length, cache: false },
    { category: "outputs", label: "Render outputs", size: totals.outputs, count: outputs.length, cache: false },
    { category: "stickers", label: "Sticker image cache", size: totals.stickers, count: stickerStats.count, cache: true },
    { category: "tmp", label: "Tmp / download cache", size: totals.tmp, count: tmp.length, cache: true },
    { category: "chunked", label: "Chunked-upload temp", size: totals.chunked, count: chunkedStats.count, cache: true },
    { category: "remotionChromium", label: "Remotion Chromium cache", size: totals.remotionChromium, count: chromiumStats.count, cache: true },
  ] as StorageArea[]).sort((a, b) => b.size - a.size);

  // Disk usage for the data volume (Node 18.15+ has statfsSync).
  const disk = readDiskUsage(config.dataDir);

  return {
    uploads,                 // all uploads (kept for back-compat)
    narratorUploads,         // narrator source videos only (not music/promo)
    musicUploads,            // background-music tracks
    promoUploads,            // promo-library videos
    outputs,
    tmp,
    stickers,                // generated sticker image cache (flat files)
    chunked,                 // chunked-upload temp parts (flat-listed)
    breakdown,               // every area: label + recursive size + count + cache flag
    totals,
    disk,
    counts: {
      uploads: uploads.length,
      narrator: narratorUploads.length,
      music: musicUploads.length,
      promo: promoUploads.length,
      outputs: outputs.length,
      tmp: tmp.length,
      stickers: stickerStats.count,
      chunked: chunkedStats.count,
      remotionChromium: chromiumStats.count,
    },
  };
}

/**
 * Free/used/total bytes for the volume backing `dir`, via statfsSync. Returns
 * null when statfs is unavailable. Pure-ish (only reads fs) + exported so the
 * shape can be unit-tested with a mocked statfs.
 */
export function readDiskUsage(dir: string): { total: number; free: number; used: number } | null {
  try {
    const anyFs = fs as unknown as {
      statfsSync?: (p: string) => { bsize: number; blocks: number; bavail: number };
    };
    if (typeof anyFs.statfsSync !== "function") return null;
    const s = anyFs.statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { total, free, used: Math.max(0, total - free) };
  } catch {
    return null;
  }
}

/** Delete a list of {category, name} files. Returns count + bytes freed. */
export async function deleteStorageFiles(input: any) {
  const items: Array<{ category: Category; name: string }> = Array.isArray(input?.items)
    ? input.items
    : [];
  let deleted = 0;
  let freed = 0;
  const errors: string[] = [];

  for (const it of items) {
    const abs = resolveSafe(it?.category, it?.name);
    if (!abs) {
      errors.push(`Invalid path: ${it?.category}/${it?.name}`);
      continue;
    }
    try {
      // Size before removal — recursive so deleting a chunked-upload dir (one
      // entry that contains parts) still reports the bytes it actually freed.
      let size = 0;
      try {
        const st = fs.statSync(abs);
        size = st.isDirectory() ? dirStats(abs).size : st.size;
      } catch {
        /* may already be gone */
      }
      fs.rmSync(abs, { recursive: true, force: true });
      if (it.category === "uploads") {
        try {
          db.prepare("DELETE FROM files WHERE stored = ?").run(it.name);
        } catch {
          /* row optional */
        }
      }
      deleted++;
      freed += size;
    } catch (e) {
      errors.push(`${it.category}/${it.name}: ${(e as Error).message}`);
    }
  }

  return { deleted, freed, errors };
}

/**
 * Wipe a whole cache area in one action ("Clear"). Only the pure-cache areas
 * are allowed — every file there regenerates on demand, so this can never lose
 * user content. The dir itself is recreated empty so the app keeps working.
 * Rejects any non-cache category (uploads / outputs are per-file only).
 */
export async function deleteStorageArea(input: any) {
  const category = input?.category as Category;
  const dir = DIRS[category];
  if (!dir || !CACHE_CATEGORIES.has(category)) {
    return { deleted: 0, freed: 0, errors: [`Not a clearable cache area: ${category}`] };
  }
  const before = dirStats(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    // Recreate the area empty so the next sticker/download/upload doesn't crash.
    fs.mkdirSync(dir, { recursive: true });
    return { deleted: before.count, freed: before.size, errors: [] };
  } catch (e) {
    return { deleted: 0, freed: 0, errors: [`${category}: ${(e as Error).message}`] };
  }
}
