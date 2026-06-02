/**
 * Storage management — list and delete the files the server keeps on disk so
 * the operator can free space (big renders, old uploads, the download cache).
 *
 * Three locations under DATA_DIR:
 *   - uploads/  → source media uploaded to the app (narration videos, music…)
 *   - outputs/  → finished renders (the big .mp4 files)
 *   - tmp/      → cache of remote downloads (always safe to delete)
 *
 * Deletes are path-traversal-safe (only flat files inside the three dirs) and,
 * for uploads, also drop the matching `files` table row.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";

type Category = "uploads" | "outputs" | "tmp";

const DIRS: Record<Category, string> = {
  uploads: config.uploadsDir,
  outputs: config.outputsDir,
  tmp: config.tmpDir,
};

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

/** Resolve a category+name to an absolute path, rejecting any traversal. */
function resolveSafe(category: Category, name: string): string | null {
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

  // Split uploads into role-based groups for the UI.
  const narratorUploads = uploads.filter((f) => f.kind === "narrator");
  const musicUploads = uploads.filter((f) => f.kind === "music");
  const promoUploads = uploads.filter((f) => f.kind === "promo");

  // Biggest first — that's what the operator wants to clear.
  const bySize = (a: StorageItem, b: StorageItem) => b.size - a.size;
  [uploads, outputs, tmp, narratorUploads, musicUploads, promoUploads].forEach((a) => a.sort(bySize));

  const sum = (arr: StorageItem[]) => arr.reduce((s, f) => s + f.size, 0);
  const totals = {
    uploads: sum(uploads),
    narrator: sum(narratorUploads),
    music: sum(musicUploads),
    promo: sum(promoUploads),
    outputs: sum(outputs),
    tmp: sum(tmp),
    all: sum(uploads) + sum(outputs) + sum(tmp),
  };

  // Disk usage for the data volume (Node 18.15+ has statfsSync).
  let disk: { total: number; free: number } | null = null;
  try {
    const anyFs = fs as unknown as {
      statfsSync?: (p: string) => { bsize: number; blocks: number; bavail: number };
    };
    if (typeof anyFs.statfsSync === "function") {
      const s = anyFs.statfsSync(config.dataDir);
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    }
  } catch {
    /* not fatal */
  }

  return {
    uploads,                 // all uploads (kept for back-compat)
    narratorUploads,         // narrator source videos only (not music/promo)
    musicUploads,            // background-music tracks
    promoUploads,            // promo-library videos
    outputs,
    tmp,
    totals,
    disk,
    counts: {
      uploads: uploads.length,
      narrator: narratorUploads.length,
      music: musicUploads.length,
      promo: promoUploads.length,
      outputs: outputs.length,
      tmp: tmp.length,
    },
  };
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
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        /* may already be gone */
      }
      fs.rmSync(abs, { force: true });
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
