/**
 * AI News Stream — storage.
 *
 * Six tables, created from scratch in the Lab's own SQLite database, one per
 * record type the app works with: stories (the collected, clustered news),
 * news decks + news slides (the presentation built from chosen stories), live
 * sessions (the shared state every presenter/teleprompter device syncs to),
 * slide stats (time spent per slide) and the source cache (URLs already seen,
 * so a re-run only processes new items).
 *
 * Records are handed to the app in the same camelCase shape the pages use
 * (`deck`, `story`, `session`, `slide` are the linked record's id). Booleans
 * are stored as 0/1 and returned as true/false; unset values are omitted.
 */
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";

db.exec(`
CREATE TABLE IF NOT EXISTS news_stories (
  id TEXT PRIMARY KEY,
  headline TEXT,
  status TEXT,
  composite_score REAL,
  source_count REAL,
  first_seen_at TEXT,
  summary TEXT,
  has_official_blog INTEGER,
  blog_sources TEXT,
  article_sources TEXT,
  added_to_deck INTEGER,
  deck_date TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_stories_deck_date ON news_stories (deck_date);

CREATE TABLE IF NOT EXISTS news_decks (
  id TEXT PRIMARY KEY,
  deck_date TEXT,
  total_slides REAL,
  presented_at TEXT,
  total_duration_seconds REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_decks_deck_date ON news_decks (deck_date);

CREATE TABLE IF NOT EXISTS news_slides (
  id TEXT PRIMARY KEY,
  deck_id TEXT,
  story_id TEXT,
  topic_label TEXT,
  position REAL,
  sources_count REAL,
  best_source_type TEXT,
  best_source_name TEXT,
  best_source_handle TEXT,
  best_source_url TEXT,
  published_at TEXT,
  hero_image_url TEXT,
  full_content_html TEXT,
  embed_html TEXT,
  all_sources_json TEXT,
  avg_relevance_score REAL,
  why_it_matters TEXT,
  key_points TEXT,
  talking_angle TEXT,
  suggested_time_seconds REAL,
  teleprompter_script TEXT,
  favorited INTEGER,
  deleted INTEGER,
  notes_edited_at TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_slides_deck ON news_slides (deck_id);

CREATE TABLE IF NOT EXISTS news_live_sessions (
  id TEXT PRIMARY KEY,
  deck_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  current_slide_index REAL,
  blackout INTEGER,
  tp_revision INTEGER,
  tp_actor_id TEXT,
  tp_scroll_pct REAL,
  tp_speed REAL,
  tp_paused INTEGER,
  tp_updated_at TEXT,
  tp_font_size REAL,
  tp_line_height REAL,
  tp_width TEXT,
  tp_countdown REAL,
  tp_autoscroll INTEGER,
  tp_anchor_at INTEGER,
  tp_controller_id TEXT
);
CREATE INDEX IF NOT EXISTS news_live_sessions_deck ON news_live_sessions (deck_id, ended_at);

CREATE TABLE IF NOT EXISTS news_slide_stats (
  id TEXT PRIMARY KEY,
  slide_id TEXT,
  session_id TEXT,
  recorded_at TEXT,
  time_spent_seconds REAL,
  navigation_order REAL
);

CREATE TABLE IF NOT EXISTS news_source_cache (
  source_url TEXT PRIMARY KEY,
  item_type TEXT,
  last_seen_at TEXT,
  source_name TEXT
);
`);

/*
 * Columns added after the first release. SQLite has no ADD COLUMN IF NOT
 * EXISTS, so check the table first.
 *
 * ⚠️ first_seen_date IS WHAT KEEPS A SECOND REFRESH FROM GUTTING THE STORIES.
 * The cache used to drop every URL seen in the last 48 hours, and each run
 * replaces today's stories wholesale — so the day's second Refresh re-clustered
 * only the articles that had not been seen yet, and a story that had five
 * outlets at 9am came back at 11am with one (or not at all). Now a URL is only
 * skipped when it was first seen on an EARLIER show day: old news stays out,
 * today's sources all come back every run.
 */
const hasColumn = (table: string, col: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
if (!hasColumn("news_stories", "category")) db.exec(`ALTER TABLE news_stories ADD COLUMN category TEXT`);
if (!hasColumn("news_source_cache", "first_seen_date")) {
  db.exec(`ALTER TABLE news_source_cache ADD COLUMN first_seen_date TEXT`);
  // Backfill with the SHOW-TIMEZONE date of the last sighting — the UTC date
  // (substr of the ISO string) put this morning's Bangkok runs on "yesterday"
  // and the next Refresh skipped 820 of 985 items as old news.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.NEWS_TIMEZONE || "Asia/Bangkok" });
  const set = db.prepare(`UPDATE news_source_cache SET first_seen_date = ? WHERE source_url = ?`);
  const rows = db.prepare(`SELECT source_url, last_seen_at FROM news_source_cache`).all() as { source_url: string; last_seen_at: string }[];
  db.transaction(() => {
    for (const r of rows) {
      const d = new Date(r.last_seen_at);
      if (!isNaN(d.getTime())) set.run(fmt.format(d), r.source_url);
    }
  })();
}

/* ── generic column <-> field mapping ─────────────────────────────────────── */

type Kind = "text" | "num" | "bool";
type Columns = Record<string, [column: string, kind: Kind]>;

function rowToRecord<T>(row: any, cols: Columns): T {
  if (!row) return row;
  const out: Record<string, unknown> = { id: row.id };
  for (const [field, [col, kind]] of Object.entries(cols)) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    out[field] = kind === "bool" ? v === 1 || v === true : v;
  }
  return out as T;
}

function toColumnValues(record: Record<string, unknown>, cols: Columns): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    const spec = cols[field];
    if (!spec) continue;
    const [col, kind] = spec;
    if (value === undefined) continue;
    if (value === null) out[col] = null;
    else if (kind === "bool") out[col] = value ? 1 : 0;
    else if (kind === "num") out[col] = Number(value);
    else out[col] = String(value);
  }
  return out;
}

function makeTable<T extends { id: string }>(table: string, cols: Columns, extra: Record<string, () => unknown> = {}) {
  const insert = (record: Record<string, unknown>): T => {
    const id = randomUUID();
    const values: Record<string, unknown> = { ...toColumnValues(record, cols) };
    for (const [col, fn] of Object.entries(extra)) values[col] = fn();
    const names = ["id", ...Object.keys(values)];
    db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((n) => "@" + n).join(", ")})`).run({ id, ...values });
    return get(id)!;
  };
  const get = (id: string): T | undefined => rowToRecord<T>(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id), cols);
  const update = (id: string, record: Record<string, unknown>): void => {
    const values = toColumnValues(record, cols);
    const names = Object.keys(values);
    if (!names.length) return;
    db.prepare(`UPDATE ${table} SET ${names.map((n) => `${n} = @${n}`).join(", ")} WHERE id = @id`).run({ id, ...values });
  };
  const remove = (id: string): void => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  };
  const where = (sql: string, ...params: unknown[]): T[] =>
    (db.prepare(`SELECT * FROM ${table} WHERE ${sql}`).all(...params) as any[]).map((r) => rowToRecord<T>(r, cols));
  const insertMany = db.transaction((records: Record<string, unknown>[]) => records.map((r) => insert(r)));
  return { insert, insertMany, get, update, remove, where };
}

/* ── record types (as the pages see them) ─────────────────────────────────── */

export interface StoryRecord {
  id: string;
  headline?: string;
  status?: string;
  compositeScore?: number;
  sourceCount?: number;
  firstSeenAt?: string;
  summary?: string;
  hasOfficialBlog?: boolean;
  blogSources?: string;
  articleSources?: string;
  addedToDeck?: boolean;
  deckDate?: string;
  category?: string;
}

export interface DeckRecord {
  id: string;
  deckDate?: string;
  totalSlides?: number;
  presentedAt?: string;
  totalDurationSeconds?: number;
}

export interface SlideRecord {
  id: string;
  deck?: string;
  story?: string;
  topicLabel?: string;
  position?: number;
  sourcesCount?: number;
  bestSourceType?: string;
  bestSourceName?: string;
  bestSourceHandle?: string;
  bestSourceUrl?: string;
  publishedAt?: string;
  heroImageUrl?: string;
  fullContentHtml?: string;
  embedHtml?: string;
  allSourcesJson?: string;
  avgRelevanceScore?: number;
  whyItMatters?: string;
  keyPoints?: string;
  talkingAngle?: string;
  suggestedTimeSeconds?: number;
  teleprompterScript?: string;
  favorited?: boolean;
  deleted?: boolean;
  notesEditedAt?: string;
}

export interface SessionRecord {
  id: string;
  deck?: string;
  startedAt?: string;
  endedAt?: string;
  currentSlideIndex?: number;
  blackout?: boolean;
  tpRevision?: number;
  tpActorId?: string;
  tpScrollPct?: number;
  tpSpeed?: number;
  tpPaused?: boolean;
  tpUpdatedAt?: string;
  tpFontSize?: number;
  tpLineHeight?: number;
  tpWidth?: string;
  tpCountdown?: number;
  tpAutoscroll?: boolean;
  tpAnchorAt?: number;
  tpControllerId?: string;
}

export interface SlideStatRecord {
  id: string;
  slide?: string;
  session?: string;
  recordedAt?: string;
  timeSpentSeconds?: number;
  navigationOrder?: number;
}

const now = () => Date.now();

export const stories = makeTable<StoryRecord>(
  "news_stories",
  {
    headline: ["headline", "text"],
    status: ["status", "text"],
    compositeScore: ["composite_score", "num"],
    sourceCount: ["source_count", "num"],
    firstSeenAt: ["first_seen_at", "text"],
    summary: ["summary", "text"],
    hasOfficialBlog: ["has_official_blog", "bool"],
    blogSources: ["blog_sources", "text"],
    articleSources: ["article_sources", "text"],
    addedToDeck: ["added_to_deck", "bool"],
    deckDate: ["deck_date", "text"],
    category: ["category", "text"],
  },
  { created_at: now },
);

export const decks = makeTable<DeckRecord>(
  "news_decks",
  {
    deckDate: ["deck_date", "text"],
    totalSlides: ["total_slides", "num"],
    presentedAt: ["presented_at", "text"],
    totalDurationSeconds: ["total_duration_seconds", "num"],
  },
  { created_at: now },
);

export const slides = makeTable<SlideRecord>(
  "news_slides",
  {
    deck: ["deck_id", "text"],
    story: ["story_id", "text"],
    topicLabel: ["topic_label", "text"],
    position: ["position", "num"],
    sourcesCount: ["sources_count", "num"],
    bestSourceType: ["best_source_type", "text"],
    bestSourceName: ["best_source_name", "text"],
    bestSourceHandle: ["best_source_handle", "text"],
    bestSourceUrl: ["best_source_url", "text"],
    publishedAt: ["published_at", "text"],
    heroImageUrl: ["hero_image_url", "text"],
    fullContentHtml: ["full_content_html", "text"],
    embedHtml: ["embed_html", "text"],
    allSourcesJson: ["all_sources_json", "text"],
    avgRelevanceScore: ["avg_relevance_score", "num"],
    whyItMatters: ["why_it_matters", "text"],
    keyPoints: ["key_points", "text"],
    talkingAngle: ["talking_angle", "text"],
    suggestedTimeSeconds: ["suggested_time_seconds", "num"],
    teleprompterScript: ["teleprompter_script", "text"],
    favorited: ["favorited", "bool"],
    deleted: ["deleted", "bool"],
    notesEditedAt: ["notes_edited_at", "text"],
  },
  { created_at: now },
);

export const sessions = makeTable<SessionRecord>("news_live_sessions", {
  deck: ["deck_id", "text"],
  startedAt: ["started_at", "text"],
  endedAt: ["ended_at", "text"],
  currentSlideIndex: ["current_slide_index", "num"],
  blackout: ["blackout", "bool"],
  tpRevision: ["tp_revision", "num"],
  tpActorId: ["tp_actor_id", "text"],
  tpScrollPct: ["tp_scroll_pct", "num"],
  tpSpeed: ["tp_speed", "num"],
  tpPaused: ["tp_paused", "bool"],
  tpUpdatedAt: ["tp_updated_at", "text"],
  tpFontSize: ["tp_font_size", "num"],
  tpLineHeight: ["tp_line_height", "num"],
  tpWidth: ["tp_width", "text"],
  tpCountdown: ["tp_countdown", "num"],
  tpAutoscroll: ["tp_autoscroll", "bool"],
  tpAnchorAt: ["tp_anchor_at", "num"],
  tpControllerId: ["tp_controller_id", "text"],
});

export const slideStats = makeTable<SlideStatRecord>("news_slide_stats", {
  slide: ["slide_id", "text"],
  session: ["session_id", "text"],
  recordedAt: ["recorded_at", "text"],
  timeSpentSeconds: ["time_spent_seconds", "num"],
  navigationOrder: ["navigation_order", "num"],
});

/* ── source cache (keyed by URL) ──────────────────────────────────────────── */

export const sourceCache = {
  urlsSeenSince(cutoffIso: string): Set<string> {
    const rows = db.prepare(`SELECT source_url FROM news_source_cache WHERE last_seen_at >= ?`).all(cutoffIso) as { source_url: string }[];
    return new Set(rows.map((r) => r.source_url).filter(Boolean));
  },
  /** URLs first seen on a show day before `showDate` (YYYY-MM-DD) — yesterday's news. */
  urlsFirstSeenBefore(showDate: string): Set<string> {
    const rows = db.prepare(`SELECT source_url FROM news_source_cache WHERE first_seen_date < ?`).all(showDate) as { source_url: string }[];
    return new Set(rows.map((r) => r.source_url).filter(Boolean));
  },
  upsertMany: db.transaction((items: { sourceUrl: string; itemType: string; lastSeenAt: string; sourceName: string; firstSeenDate: string }[]) => {
    // first_seen_date is written once and never moved forward.
    const stmt = db.prepare(
      `INSERT INTO news_source_cache (source_url, item_type, last_seen_at, source_name, first_seen_date) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_url) DO UPDATE SET item_type = excluded.item_type, last_seen_at = excluded.last_seen_at, source_name = excluded.source_name`,
    );
    for (const i of items) stmt.run(i.sourceUrl, i.itemType, i.lastSeenAt, i.sourceName, i.firstSeenDate);
  }),
  clear(): number {
    return db.prepare(`DELETE FROM news_source_cache`).run().changes;
  },
};

/**
 * The teleprompter look and speed to carry into the NEXT show: whatever the
 * most recent session (ended or not, any deck) was left at. Jake's rule: a
 * setting, once changed, stays until he changes it again — a new show must not
 * reset him to 32px / medium / 2.5.
 */
export function lastTeleprompterSettings(): { tpFontSize: number; tpLineHeight: number; tpWidth: string; tpSpeed: number } {
  const row = db.prepare(`SELECT tp_font_size, tp_line_height, tp_width, tp_speed FROM news_live_sessions ORDER BY started_at DESC LIMIT 1`).get() as
    { tp_font_size?: number; tp_line_height?: number; tp_width?: string; tp_speed?: number } | undefined;
  return {
    tpFontSize: typeof row?.tp_font_size === "number" ? row.tp_font_size : 32,
    tpLineHeight: typeof row?.tp_line_height === "number" ? row.tp_line_height : 1.9,
    tpWidth: row?.tp_width && ["narrow", "medium", "wide"].includes(row.tp_width) ? row.tp_width : "medium",
    tpSpeed: typeof row?.tp_speed === "number" ? row.tp_speed : 2.5,
  };
}

/** The newest session for a deck that has not ended (or across all decks). */
export function latestOpenSession(deckId?: string): SessionRecord | undefined {
  const row = deckId
    ? db.prepare(`SELECT id FROM news_live_sessions WHERE deck_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).get(deckId)
    : db.prepare(`SELECT id FROM news_live_sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`).get();
  return row ? sessions.get((row as { id: string }).id) : undefined;
}

/**
 * "Today", in the show's own timezone.
 *
 * ⚠️ THIS USED TO BE THE UTC DATE, AND UTC IS NOT WHERE THE SHOW IS. Jake
 * presents from Bangkok (UTC+7) and this box runs UTC, so every day between
 * midnight and 07:00 his time, `new Date().toISOString()` still reads
 * YESTERDAY. Everything in the app keys off this — which stories count as
 * today's, which deck gets built, which deck the live session opens — so a run
 * at 1am Bangkok filed the night's stories under the previous day and then
 * "today's deck" came back empty, or worse, came back holding the deck he had
 * already presented.
 *
 * Wrong by a whole day for seven hours of every day, and only ever in the
 * hours a late edit actually happens.
 */
const SHOW_TIMEZONE = process.env.NEWS_TIMEZONE || "Asia/Bangkok";

export const todayDate = (): string =>
  // en-CA gives YYYY-MM-DD, which is the format every caller already compares.
  new Intl.DateTimeFormat("en-CA", { timeZone: SHOW_TIMEZONE }).format(new Date());
