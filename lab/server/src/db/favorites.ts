/**
 * Typed helpers over the Keyword Research FAVORITES tables (kw_fav_folders,
 * kw_fav_titles, kw_fav_keywords — defined in db/index.ts). Mirrors
 * db/keywordResearch.ts / db/jobs.ts: plain better-sqlite3 prepared statements,
 * nanoid() ids, Date.now() timestamps, tags persisted as a JSON string column.
 *
 * A folder is one project/report holding saved winning TITLES + a personal
 * favorite-KEYWORDS database. Keywords are deduped per folder on their NORMALIZED
 * text (a UNIQUE index on (folder_id, keyword) backs the INSERT OR IGNORE), with
 * the original casing kept in `display`. FKs cascade on folder delete
 * (foreign_keys pragma is ON), so deleteFolder wipes its titles + keywords too.
 */
import { nanoid } from "nanoid";
import { db } from "./index.js";
import { normalizeKeyword } from "../keyword/types.js";
import type {
  FavFolder,
  FavKeyword,
  FavKeywordSource,
  FavTitle,
  FavoritesView,
} from "../keyword/favorites.js";

const now = () => Date.now();

/** Parse a JSON tags column → string[] (defensive: never throws). */
function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Normalize an incoming tags value → a clean, deduped string[] for storage. */
function cleanTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

// ── kw_fav_folders ────────────────────────────────────────────────────────────

interface FolderRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  title_count: number;
  keyword_count: number;
}

function rowToFolder(row: FolderRow): FavFolder {
  return {
    id: row.id,
    name: row.name,
    titleCount: row.title_count ?? 0,
    keywordCount: row.keyword_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SELECT one folder joined with its live title/keyword counts, or null. */
export function getFolder(id: string): FavFolder | null {
  const row = db
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM kw_fav_titles   t WHERE t.folder_id = f.id) AS title_count,
              (SELECT COUNT(*) FROM kw_fav_keywords k WHERE k.folder_id = f.id) AS keyword_count
         FROM kw_fav_folders f
        WHERE f.id = ?`,
    )
    .get(id) as FolderRow | undefined;
  return row ? rowToFolder(row) : null;
}

/** All folders, newest first, each with live title/keyword counts. */
export function listFolders(): FavFolder[] {
  const rows = db
    .prepare(
      `SELECT f.*,
              (SELECT COUNT(*) FROM kw_fav_titles   t WHERE t.folder_id = f.id) AS title_count,
              (SELECT COUNT(*) FROM kw_fav_keywords k WHERE k.folder_id = f.id) AS keyword_count
         FROM kw_fav_folders f
        ORDER BY f.created_at DESC`,
    )
    .all() as FolderRow[];
  return rows.map(rowToFolder);
}

export function createFolder(name: string): FavFolder {
  const id = nanoid();
  const t = now();
  db.prepare(
    `INSERT INTO kw_fav_folders (id, name, created_at, updated_at) VALUES (?,?,?,?)`,
  ).run(id, name.trim(), t, t);
  return { id, name: name.trim(), titleCount: 0, keywordCount: 0, createdAt: t, updatedAt: t };
}

export function renameFolder(id: string, name: string): void {
  db.prepare("UPDATE kw_fav_folders SET name = ?, updated_at = ? WHERE id = ?").run(
    name.trim(),
    now(),
    id,
  );
}

/** Delete a folder; its titles + keywords cascade away (FK ON DELETE CASCADE). */
export function deleteFolder(id: string): void {
  db.prepare("DELETE FROM kw_fav_folders WHERE id = ?").run(id);
}

/** Bump a folder's updated_at (called when its titles/keywords change). */
function touchFolder(id: string): void {
  db.prepare("UPDATE kw_fav_folders SET updated_at = ? WHERE id = ?").run(now(), id);
}

// ── kw_fav_titles ─────────────────────────────────────────────────────────────

interface TitleRow {
  id: string;
  folder_id: string;
  title: string;
  video_id: string | null;
  channel_title: string | null;
  views: number | null;
  subscriber_count: number | null;
  published_at: string | null;
  source_keyword: string | null;
  note: string | null;
  tags_json: string | null;
  created_at: number;
}

function rowToTitle(row: TitleRow): FavTitle {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    videoId: row.video_id,
    channelTitle: row.channel_title,
    views: row.views,
    subscriberCount: row.subscriber_count,
    publishedAt: row.published_at,
    sourceKeyword: row.source_keyword,
    note: row.note,
    tags: parseTags(row.tags_json),
    createdAt: row.created_at,
  };
}

export function addTitle(input: {
  folderId: string;
  title: string;
  videoId?: string | null;
  channelTitle?: string | null;
  views?: number | null;
  subscriberCount?: number | null;
  publishedAt?: string | null;
  sourceKeyword?: string | null;
}): FavTitle {
  const id = nanoid();
  const t = now();
  db.prepare(
    `INSERT INTO kw_fav_titles
       (id, folder_id, title, video_id, channel_title, views, subscriber_count,
        published_at, source_keyword, note, tags_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.folderId,
    input.title.trim(),
    input.videoId ?? null,
    input.channelTitle ?? null,
    input.views ?? null,
    input.subscriberCount ?? null,
    input.publishedAt ?? null,
    input.sourceKeyword ?? null,
    null,
    "[]",
    t,
  );
  touchFolder(input.folderId);
  return {
    id,
    folderId: input.folderId,
    title: input.title.trim(),
    videoId: input.videoId ?? null,
    channelTitle: input.channelTitle ?? null,
    views: input.views ?? null,
    subscriberCount: input.subscriberCount ?? null,
    publishedAt: input.publishedAt ?? null,
    sourceKeyword: input.sourceKeyword ?? null,
    note: null,
    tags: [],
    createdAt: t,
  };
}

export function removeTitle(id: string): void {
  const row = db.prepare("SELECT folder_id FROM kw_fav_titles WHERE id = ?").get(id) as
    | { folder_id: string }
    | undefined;
  db.prepare("DELETE FROM kw_fav_titles WHERE id = ?").run(id);
  if (row) touchFolder(row.folder_id);
}

/** Patch a title's note/tags. Only provided fields are written. */
export function updateTitle(id: string, patch: { note?: string; tags?: string[] }): void {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.note !== undefined) {
    sets.push("note = ?");
    vals.push(patch.note);
  }
  if (patch.tags !== undefined) {
    sets.push("tags_json = ?");
    vals.push(JSON.stringify(cleanTags(patch.tags)));
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE kw_fav_titles SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  const row = db.prepare("SELECT folder_id FROM kw_fav_titles WHERE id = ?").get(id) as
    | { folder_id: string }
    | undefined;
  if (row) touchFolder(row.folder_id);
}

export function listTitles(folderId: string): FavTitle[] {
  const rows = db
    .prepare("SELECT * FROM kw_fav_titles WHERE folder_id = ? ORDER BY created_at DESC")
    .all(folderId) as TitleRow[];
  return rows.map(rowToTitle);
}

export function getTitle(id: string): FavTitle | null {
  const row = db.prepare("SELECT * FROM kw_fav_titles WHERE id = ?").get(id) as
    | TitleRow
    | undefined;
  return row ? rowToTitle(row) : null;
}

// ── kw_fav_keywords ───────────────────────────────────────────────────────────

interface KeywordRow {
  id: string;
  folder_id: string;
  keyword: string;
  display: string;
  source: string;
  source_title_id: string | null;
  note: string | null;
  tags_json: string | null;
  created_at: number;
}

function rowToKeyword(row: KeywordRow): FavKeyword {
  return {
    id: row.id,
    folderId: row.folder_id,
    keyword: row.display,
    source: row.source as FavKeywordSource,
    sourceTitleId: row.source_title_id,
    note: row.note,
    tags: parseTags(row.tags_json),
    createdAt: row.created_at,
  };
}

/**
 * Add a favorite keyword, deduped per folder on the NORMALIZED text. INSERT OR
 * IGNORE (backed by the UNIQUE (folder_id, keyword) index) then SELECT, so a
 * duplicate returns the EXISTING row rather than erroring or inserting twice.
 */
export function addKeyword(input: {
  folderId: string;
  keyword: string;
  source: FavKeywordSource;
  sourceTitleId?: string | null;
  note?: string | null;
  tags?: string[];
}): FavKeyword {
  const normalized = normalizeKeyword(input.keyword);
  const id = nanoid();
  const t = now();
  db.prepare(
    `INSERT OR IGNORE INTO kw_fav_keywords
       (id, folder_id, keyword, display, source, source_title_id, note, tags_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.folderId,
    normalized,
    input.keyword.trim(),
    input.source,
    input.sourceTitleId ?? null,
    input.note ?? null,
    JSON.stringify(cleanTags(input.tags)),
    t,
  );
  touchFolder(input.folderId);
  // Return the row that now lives at (folderId, normalized) — the freshly
  // inserted one, or the pre-existing one when the INSERT was ignored.
  const row = db
    .prepare("SELECT * FROM kw_fav_keywords WHERE folder_id = ? AND keyword = ?")
    .get(input.folderId, normalized) as KeywordRow;
  return rowToKeyword(row);
}

export function removeKeyword(id: string): void {
  const row = db.prepare("SELECT folder_id FROM kw_fav_keywords WHERE id = ?").get(id) as
    | { folder_id: string }
    | undefined;
  db.prepare("DELETE FROM kw_fav_keywords WHERE id = ?").run(id);
  if (row) touchFolder(row.folder_id);
}

/** Patch a keyword's note/tags. Only provided fields are written. */
export function updateKeyword(id: string, patch: { note?: string; tags?: string[] }): void {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.note !== undefined) {
    sets.push("note = ?");
    vals.push(patch.note);
  }
  if (patch.tags !== undefined) {
    sets.push("tags_json = ?");
    vals.push(JSON.stringify(cleanTags(patch.tags)));
  }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE kw_fav_keywords SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  const row = db.prepare("SELECT folder_id FROM kw_fav_keywords WHERE id = ?").get(id) as
    | { folder_id: string }
    | undefined;
  if (row) touchFolder(row.folder_id);
}

export function listKeywords(folderId: string): FavKeyword[] {
  const rows = db
    .prepare("SELECT * FROM kw_fav_keywords WHERE folder_id = ? ORDER BY created_at DESC")
    .all(folderId) as KeywordRow[];
  return rows.map(rowToKeyword);
}

// ── Composite view ─────────────────────────────────────────────────────────────

/** Everything in one folder: the folder record + its titles + keywords. */
export function getFavoritesView(folderId: string): FavoritesView | null {
  const folder = getFolder(folderId);
  if (!folder) return null;
  return {
    folder,
    titles: listTitles(folderId),
    keywords: listKeywords(folderId),
  };
}
