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

/** Collect the set of upload ids referenced as music / promo / narration. */
function referencedUploadIds(): { music: Set<string>; promo: Set<string>; narrator: Set<string> } {
  const music = new Set<string>();
  const promo = new Set<string>();
  const narrator = new Set<string>();
  const collect = (table: string, urlFields: string[], target: Set<string>) => {
    try {
      const rows = db.prepare(`SELECT doc FROM ${table}`).all() as Array<{ doc: string }>;
      for (const r of rows) {
        let doc: any;
        try { doc = JSON.parse(r.doc); } catch { continue; }
        for (const f of urlFields) {
          const id = uploadIdFromUrl(doc?.[f]);
          if (id) target.add(id);
        }
      }
    } catch { /* table may not exist */ }
  };
  collect("z_music_tracks", ["audioUrl"], music);
  collect("z_promo_videos", ["videoUrl"], promo);
  // Narrator = the source video/audio attached to projects.
  collect("z_projects", ["narrationUrl", "audioUrl"], narrator);
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
  // role (music / promo / narrator) by cross-referencing the app's records.
  const refs = referencedUploadIds();
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
      // Classify by the upload id (fall back to the on-disk name without ext).
      const fid = f.id ?? f.name.replace(/\.[a-z0-9]+$/i, "");
      if (refs.music.has(fid)) f.kind = "music";
      else if (refs.promo.has(fid)) f.kind = "promo";
      else f.kind = "narrator"; // everything else is narrator source media
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
