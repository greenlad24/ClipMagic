/**
 * Storage management — list and delete EVERYTHING the server keeps on disk so
 * the operator can free space and see, at a glance, whether the data volume is
 * full (the usual cause of upload/render failures).
 *
 * Every disk-consuming area lives in one place: the AREAS registry below. Each
 * area is either CONTENT (your media — deleted per-file) or CACHE (regenerates
 * on demand — safe to wipe wholesale with "Clear"). Adding a new area = one
 * registry entry; totals, counts, the breakdown and the UI all derive from it,
 * so nothing can silently go uncounted again.
 *
 * Physical areas under DATA_DIR:
 *   uploads/                  → source media (narration videos, music, promos)  [content]
 *   outputs/                  → finished renders + screencast captures (.mp4)    [content]
 *   outputs/thumbnails/       → edited thumbnail renders (Nano Banana Pro)       [content]
 *   thumbnail-fonts/          → custom fonts you uploaded for thumbnails         [content]
 *   outputs/stickers/         → generated/fetched sticker image cache            [cache]
 *   tmp/                      → remote-download cache                            [cache]
 *   tmp/chunked-uploads/      → in-progress resumable-upload temp               [cache]
 *   thumbnail-characters/     → cut-out character cache for thumbnails           [cache]
 *   thumbnail-backgrounds/    → generated background cache for thumbnails        [cache]
 *   thumbnail-cutouts/        → composited cut-out cache for thumbnails          [cache]
 *   motion-bundle/            → Remotion motion-graphics bundle cache            [cache]
 *   .remotion-chromium/       → Remotion's Chromium browser cache               [cache]
 *   db/                       → sqlite — NEVER offered for deletion
 *
 * Per-file deletes are path-traversal-safe (resolveSafe), and the pure-cache
 * areas can be wiped wholesale ("Clear") — they are recreated on demand.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db/index.js";

/**
 * Every physical directory the manager can inspect/delete. A Category maps 1:1
 * to a directory on disk (see DIRS). Display "cards" (AREAS) may sub-split one
 * category — e.g. `uploads` shows as narrator/music/promo — but deletes always
 * target the physical Category.
 */
export type Category =
  | "uploads"
  | "outputs"
  | "thumbnails"
  | "thumbnailFonts"
  | "tmp"
  | "stickers"
  | "chunked"
  | "remotionChromium"
  | "thumbnailCharacters"
  | "thumbnailBackgrounds"
  | "thumbnailCutouts"
  | "motionBundle";

const DIRS: Record<Category, string> = {
  uploads: config.uploadsDir,
  outputs: config.outputsDir,
  thumbnails: path.join(config.outputsDir, "thumbnails"),
  thumbnailFonts: path.join(config.dataDir, "thumbnail-fonts"),
  tmp: config.tmpDir,
  stickers: path.join(config.outputsDir, "stickers"),
  chunked: path.join(config.tmpDir, "chunked-uploads"),
  remotionChromium: config.remotionBrowserCacheDir,
  thumbnailCharacters: path.join(config.dataDir, "thumbnail-characters"),
  thumbnailBackgrounds: path.join(config.dataDir, "thumbnail-backgrounds"),
  thumbnailCutouts: path.join(config.dataDir, "thumbnail-cutouts"),
  motionBundle: config.motionBundleDir,
};

/**
 * Pure-cache areas: every file regenerates on demand, so the whole area is safe
 * to wipe with one "Clear" action (deleteStorageArea). User content (uploads,
 * renders, thumbnail renders, custom fonts) is NOT here — deleted per-file only.
 */
const CACHE_CATEGORIES = new Set<Category>([
  "tmp",
  "stickers",
  "chunked",
  "remotionChromium",
  "thumbnailCharacters",
  "thumbnailBackgrounds",
  "thumbnailCutouts",
  "motionBundle",
]);

/**
 * Areas whose contents are nested subdirs / opaque bundles (a webpack bundle, a
 * Chromium install, per-upload part folders). We don't list them file-by-file —
 * we show a recursive size + count and a single "Clear all" (cache) button.
 */
const FOLDER_ONLY = new Set<Category>(["chunked", "remotionChromium", "motionBundle"]);

/**
 * Serve-URL prefix per category, so a listed file gets a preview/download link.
 * Cache areas and folder-only areas have none.
 */
const URL_BASE: Partial<Record<Category, string>> = {
  outputs: "/api/outputs/",
  thumbnails: "/api/outputs/thumbnails/",
  stickers: "/api/outputs/stickers/",
  // uploads is special-cased (needs the files-table id) in listStorage.
};

/**
 * The display registry: the ordered list of cards the UI renders. Each card is
 * a "view" over one physical Category, optionally narrowed by `filter` to a
 * sub-role (uploads → narrator/music/promo; outputs → render/screencast). The
 * card's size/count derive from its (filtered) files, so the cards partition
 * every byte exactly once → summing them gives the true grand total.
 *
 *   group  : content = your media (per-file delete); cache = regenerates (Clear)
 *   danger : deleting this can break projects that reference it
 *   icon   : lucide-react icon name resolved on the client
 */
export interface AreaDef {
  key: string;
  category: Category;
  label: string;
  hint: string;
  icon: string;
  group: "content" | "cache";
  danger?: boolean;
  filter?: (it: StorageItem) => boolean;
}

const AREAS: AreaDef[] = [
  // ── Content: your media (deleted per file) ──────────────────────────────────
  {
    key: "narratorVideos", category: "uploads", group: "content", danger: true,
    icon: "Video", label: "Narrator videos",
    hint: "Source narration videos you uploaded (not music or promo). Deleting one breaks any project that uses it.",
    filter: (it) => it.kind === "narrator",
  },
  {
    key: "backgroundMusic", category: "uploads", group: "content", danger: true,
    icon: "Music", label: "Background music",
    hint: "Music tracks in your library (used as background music). Deleting one removes it from projects using it.",
    filter: (it) => it.kind === "music",
  },
  {
    key: "separatedAudio", category: "uploads", group: "content", danger: true,
    icon: "AudioLines", label: "Audio from videos",
    hint: "Audio files that aren't in your music library — e.g. audio separated/extracted from videos, or standalone narration audio. Deleting one breaks any project that uses it.",
    filter: (it) => it.kind === "audio",
  },
  {
    key: "promoVideos", category: "uploads", group: "content", danger: true,
    icon: "Film", label: "Promo videos",
    hint: "Promo-library videos. Deleting one removes it from the AI director's footage pool.",
    filter: (it) => it.kind === "promo",
  },
  {
    key: "renderOutputs", category: "outputs", group: "content",
    icon: "Clapperboard", label: "Render outputs",
    hint: "Finished export videos. Safe to delete — you can re-export.",
    filter: (it) => it.kind !== "screencast",
  },
  {
    key: "screencastCaptures", category: "outputs", group: "content",
    icon: "MonitorPlay", label: "Screencast captures",
    hint: "Recorded website screencasts used as B-roll. Re-captured on demand.",
    filter: (it) => it.kind === "screencast",
  },
  {
    key: "thumbnailRenders", category: "thumbnails", group: "content",
    icon: "Image", label: "Thumbnail renders",
    hint: "Finished thumbnail images you generated. Safe to delete — you can re-generate.",
  },
  {
    key: "thumbnailFonts", category: "thumbnailFonts", group: "content", danger: true,
    icon: "Type", label: "Custom thumbnail fonts",
    hint: "Fonts you uploaded for thumbnails. Deleting one removes it from thumbnails that use it.",
  },
  // ── Cache: regenerates on demand (safe to Clear) ────────────────────────────
  {
    key: "stickerCache", category: "stickers", group: "cache",
    icon: "Sticker", label: "Sticker image cache",
    hint: "Generated / fetched sticker images. Pure cache — regenerated on demand.",
  },
  {
    key: "downloadCache", category: "tmp", group: "cache",
    icon: "Database", label: "Download cache",
    hint: "Cached remote downloads. Always safe — re-fetched on demand.",
  },
  {
    key: "chunkedTemp", category: "chunked", group: "cache",
    icon: "FolderClock", label: "Chunked-upload temp",
    hint: "In-progress / abandoned resumable-upload parts. Safe to clear once uploads finish.",
  },
  {
    key: "thumbnailCharacterCache", category: "thumbnailCharacters", group: "cache",
    icon: "UserSquare", label: "Thumbnail character cache",
    hint: "Cut-out character images for thumbnails. Pure cache — regenerated on demand.",
  },
  {
    key: "thumbnailBackgroundCache", category: "thumbnailBackgrounds", group: "cache",
    icon: "Palette", label: "Thumbnail background cache",
    hint: "Generated thumbnail backgrounds. Pure cache — regenerated on demand.",
  },
  {
    key: "thumbnailCutoutCache", category: "thumbnailCutouts", group: "cache",
    icon: "Scissors", label: "Thumbnail cutout cache",
    hint: "Composited cut-outs for thumbnails. Pure cache — regenerated on demand.",
  },
  {
    key: "motionBundle", category: "motionBundle", group: "cache",
    icon: "Sparkles", label: "Motion-graphics bundle",
    hint: "Compiled Remotion motion-graphics bundle. Pure cache — rebuilt on demand.",
  },
  {
    key: "remotionChromium", category: "remotionChromium", group: "cache",
    icon: "Chrome", label: "Remotion Chromium cache",
    hint: "A Chromium browser Remotion may have downloaded. Not used in production (Chromium is pre-baked), so always safe to clear.",
  },
];

export interface StorageItem {
  category: Category;
  name: string;        // stored filename on disk
  id?: string;         // files-table id (uploads only)
  original?: string;   // original upload filename
  mime?: string;
  size: number;        // bytes
  mtime: number;       // epoch ms
  url?: string;        // serve URL (for preview/download)
  /** Sub-role used to split a physical area into cards (see AREAS). */
  kind?: "music" | "audio" | "promo" | "narrator" | "render" | "screencast";
}

/**
 * One card in the storage manager: a labelled, sized view over a physical area
 * (possibly a sub-role of it). Everything the UI needs to render + delete is
 * here — the client is fully data-driven off `areas`.
 */
export interface StorageArea {
  key: string;
  category: Category;          // physical dir (used for per-file delete)
  label: string;
  hint: string;
  icon: string;               // lucide-react icon name
  group: "content" | "cache";
  cache: boolean;             // clearable wholesale via deleteStorageArea
  danger: boolean;            // deleting can break projects
  folderOnly: boolean;        // no per-file list; Clear-all only
  size: number;               // total bytes for this card
  count: number;              // file count for this card
  items: StorageItem[];       // listed files (empty for folder-only)
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

/**
 * List everything on disk as an ordered set of display cards (`areas`), with a
 * grand total, reclaimable-cache total, and disk usage. The whole UI derives
 * from `areas`, and because the cards partition every byte exactly once, the
 * totals can never drift from what's actually shown.
 */
export async function listStorage() {
  const bySize = (a: StorageItem, b: StorageItem) => b.size - a.size;

  // ── Gather + classify the physical (listable) categories ────────────────────
  const uploads = listDir("uploads");
  const outputs = listDir("outputs");

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
      // Classify by what actually references the file:
      //   music    → a track that IS in your music library (z_music_tracks). We
      //              match by upload id only: library membership is the whole
      //              point of "actual background music", and a stray audio file
      //              that merely shares a track's name is NOT in the library.
      //   promo    → a promo-library video (id or fuzzy name — promos are often
      //              bulk-imported without a URL back to the upload id)
      //   audio    → any OTHER audio file (extracted/separated from a video, or
      //              standalone narration audio) — grouped apart from music
      //   narrator → everything else = a source narration video
      if (refs.music.ids.has(fid)) {
        f.kind = "music";
      } else if (refs.promo.ids.has(fid) || nameMatches(refs.promo.names)) {
        f.kind = "promo";
      } else if (isAudioFile(f.original ?? f.name, f.mime)) {
        f.kind = "audio";
      } else {
        f.kind = "narrator";
      }
      f.url = `/api/uploads/${encodeURIComponent(f.id ?? f.name)}`;
    }
  } catch {
    /* files table optional */
  }
  // Split outputs into screencast captures vs render exports (by filename), the
  // same way uploads split by role — see AREAS.
  for (const f of outputs) {
    f.kind = f.name.startsWith("screencast_") ? "screencast" : "render";
    f.url = `/api/outputs/${encodeURIComponent(f.name)}`;
  }

  // Build the file list for every listable physical category exactly once.
  const filesByCategory: Partial<Record<Category, StorageItem[]>> = { uploads, outputs };
  const LISTABLE: Category[] = [
    "thumbnails", "thumbnailFonts", "tmp", "stickers",
    "thumbnailCharacters", "thumbnailBackgrounds", "thumbnailCutouts",
  ];
  for (const cat of LISTABLE) {
    const items = listDir(cat);
    const base = URL_BASE[cat];
    if (base) for (const f of items) f.url = `${base}${encodeURIComponent(f.name)}`;
    filesByCategory[cat] = items;
  }

  // Folder-only categories (nested bundles / part-dirs): recursive stats, no list.
  const folderStats: Partial<Record<Category, { size: number; count: number }>> = {};
  for (const cat of FOLDER_ONLY) folderStats[cat] = dirStats(DIRS[cat]);

  // ── Turn the registry into sized display cards ──────────────────────────────
  const areas: StorageArea[] = AREAS.map((def) => {
    const cache = CACHE_CATEGORIES.has(def.category);
    const folderOnly = FOLDER_ONLY.has(def.category);
    let items: StorageItem[] = [];
    let size = 0;
    let count = 0;
    if (folderOnly) {
      const st = folderStats[def.category] ?? dirStats(DIRS[def.category]);
      size = st.size;
      count = st.count;
    } else {
      const pool = filesByCategory[def.category] ?? [];
      items = (def.filter ? pool.filter(def.filter) : pool).slice().sort(bySize);
      size = items.reduce((s, f) => s + f.size, 0);
      count = items.length;
    }
    return {
      key: def.key,
      category: def.category,
      label: def.label,
      hint: def.hint,
      icon: def.icon,
      group: def.group,
      cache,
      danger: !!def.danger,
      folderOnly,
      size,
      count,
      items,
    };
  });

  // Cards partition every byte once, so the grand total is just their sum; the
  // reclaimable figure is the sum of the cache cards. The db is never a card.
  const all = areas.reduce((s, a) => s + a.size, 0);
  const cacheTotal = areas.reduce((s, a) => s + (a.cache ? a.size : 0), 0);

  const disk = readDiskUsage(config.dataDir);

  return {
    disk,
    totals: { all, cache: cacheTotal },
    areas,
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
