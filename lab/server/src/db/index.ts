import Database from "better-sqlite3";
import { config, ensureDirs } from "../config.js";

/**
 * Single SQLite database for all metadata. Keeping it to SQLite means the whole
 * stack ("upload → store → render → bulk") runs in one process on one droplet —
 * no separate database service to pay for or operate. WAL mode comfortably
 * handles the concurrent reads/writes from the HTTP layer and the render worker.
 */
ensureDirs();

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
-- Uploaded source media (narration videos, overlays, music, images).
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  original    TEXT NOT NULL,
  stored      TEXT NOT NULL,          -- filename on disk inside uploadsDir
  mime        TEXT,
  kind        TEXT,                   -- video | image | audio | other
  size        INTEGER NOT NULL,
  duration    REAL,                   -- seconds (video/audio), from ffprobe
  width       INTEGER,
  height      INTEGER,
  created_at  INTEGER NOT NULL
);

-- Projects (mirrors the Zite "Projects" table; one short = one project).
CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'Uploading',
  context_hint        TEXT,
  narration_url       TEXT,
  output_url          TEXT,
  accent_color        TEXT,
  duration_seconds    REAL,
  transcript          TEXT,
  music_track_id      TEXT,
  music_volume        REAL DEFAULT 0.18,
  beat_structure_json TEXT,
  director_json       TEXT,
  validation_errors   TEXT,
  audio_url           TEXT,
  video_chunks_json   TEXT,
  subtitles_json      TEXT,
  animation_map_json  TEXT,
  render_command_id   TEXT,           -- last render job id (Rendi parity)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Shots (mirrors the Zite "Shots" table). Stored loosely as a JSON 'data'
-- column plus the few columns the timeline/render path queries directly.
CREATE TABLE IF NOT EXISTS shots (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL DEFAULT 0,
  start_time  REAL,
  end_time    REAL,
  shot_type   TEXT,
  clip_url    TEXT,
  caption     TEXT,
  data        TEXT NOT NULL DEFAULT '{}',   -- full shot record as JSON
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS music_tracks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  bpm         REAL,
  volume      REAL DEFAULT 0.18,
  created_at  INTEGER NOT NULL
);

-- Bulk batches: one batch = many videos rendered from a shared/per-item manifest.
CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batch_items (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  job_id      TEXT,
  created_at  INTEGER NOT NULL
);

-- The render queue. One row = one FFmpeg invocation. The worker pool polls this
-- table; rows survive restarts so a reboot mid-batch resumes cleanly.
CREATE TABLE IF NOT EXISTS render_jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,          -- 'command' (Rendi-style) | 'manifest'
  status           TEXT NOT NULL,          -- queued | active | paused | completed | failed | canceled
  progress         REAL NOT NULL DEFAULT 0,
  -- For kind='command': raw ffmpeg argv template + input file map.
  command          TEXT,
  input_files_json TEXT,                   -- { key: fileId-or-url-or-path }
  output_name      TEXT NOT NULL DEFAULT 'output.mp4',
  -- For kind='manifest': the RenderManifest JSON.
  manifest_json    TEXT,
  -- Results / bookkeeping.
  output_file      TEXT,                   -- filename inside outputsDir
  duration_sec     REAL,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 2,
  project_id       TEXT,
  batch_item_id    TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_status      ON render_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created      ON render_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_shots_project     ON shots(project_id);
CREATE INDEX IF NOT EXISTS idx_items_batch       ON batch_items(batch_id);
`);

/**
 * Additive migration: a human stage label the worker publishes for the CURRENT
 * sub-stage of a render ("Rendering stickers 3/6", "Compositing video…"). Lets
 * the panel + Meme page narrate the post-render Remotion stage instead of
 * sitting at "Rendering" while the bar is parked at 100%. Nullable so existing
 * rows and non-manifest jobs are unaffected.
 */
{
  const cols = db.prepare("PRAGMA table_info(render_jobs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "stage_label")) {
    db.exec("ALTER TABLE render_jobs ADD COLUMN stage_label TEXT");
  }
}

export type JobStatus = "queued" | "active" | "paused" | "completed" | "failed" | "canceled";

/**
 * YouTube Keyword Research tool. A PERSISTENT cache of keyword metrics,
 * competitors and per-keyword dominance so runs update information over time
 * instead of refetching from scratch. `kw_keywords` is keyed by the normalized
 * keyword text (global cache, refreshed on a TTL); `kw_runs` records each
 * research run + its ordered keyword list for the saved-runs history.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS kw_keywords (
  keyword            TEXT PRIMARY KEY,      -- normalized (lowercase, single-spaced)
  display            TEXT NOT NULL,         -- original casing to show
  demand_score       REAL,
  competition_score  REAL,
  opportunity_score  REAL,
  trends_score       REAL,
  autocomplete_score REAL,
  yt_result_count    INTEGER,
  top_view_median    INTEGER,
  top_view_max       INTEGER,
  avg_channel_subs   INTEGER,
  top_video_age_days INTEGER,
  gap_flags_json     TEXT,                  -- GapFlags
  sources_json       TEXT,                  -- string[]
  last_fetched_at    INTEGER
);

-- YouTube channels that rank for keywords (cached channel stats).
CREATE TABLE IF NOT EXISTS kw_competitors (
  channel_id        TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  subscriber_count  INTEGER,
  video_count       INTEGER,
  view_count        INTEGER,
  last_fetched_at   INTEGER
);

-- Who dominates each keyword: one row per (keyword, rank).
CREATE TABLE IF NOT EXISTS kw_dominance (
  keyword            TEXT NOT NULL,
  rank               INTEGER NOT NULL,      -- 1 = top result
  channel_id         TEXT,
  channel_title      TEXT,
  subscriber_count   INTEGER,
  video_id           TEXT,
  video_title        TEXT,
  video_views        INTEGER,
  video_published_at TEXT,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (keyword, rank)
);

-- One research run (the saved-runs history).
CREATE TABLE IF NOT EXISTS kw_runs (
  id                TEXT PRIMARY KEY,
  niche             TEXT NOT NULL DEFAULT '',
  mode              TEXT NOT NULL,          -- seeds | topic | competitors | ai
  input_json        TEXT NOT NULL,          -- ResearchInput
  status            TEXT NOT NULL,          -- running | completed | failed
  keyword_list_json TEXT,                   -- ordered normalized keyword strings
  clusters_json     TEXT,                   -- KeywordCluster[]
  market_json       TEXT,                   -- MarketAnalysis | null
  summary_json      TEXT,                   -- ResearchRunSummary
  error             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kw_runs_created ON kw_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_kw_dom_keyword  ON kw_dominance(keyword);
CREATE INDEX IF NOT EXISTS idx_kw_kw_fetched   ON kw_keywords(last_fetched_at);

-- Keyword Research FAVORITES: folders (one per project/report) holding saved
-- winning titles + a personal favorite-keywords database. Titles/keywords carry
-- an optional note + tags.
CREATE TABLE IF NOT EXISTS kw_fav_folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kw_fav_titles (
  id               TEXT PRIMARY KEY,
  folder_id        TEXT NOT NULL REFERENCES kw_fav_folders(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  video_id         TEXT,
  channel_title    TEXT,
  views            INTEGER,
  subscriber_count INTEGER,
  published_at     TEXT,
  source_keyword   TEXT,
  note             TEXT,
  tags_json        TEXT,
  created_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kw_fav_keywords (
  id              TEXT PRIMARY KEY,
  folder_id       TEXT NOT NULL REFERENCES kw_fav_folders(id) ON DELETE CASCADE,
  keyword         TEXT NOT NULL,       -- normalized (lowercase, single-spaced)
  display         TEXT NOT NULL,       -- original casing
  source          TEXT NOT NULL,       -- extracted | table | manual
  source_title_id TEXT,
  note            TEXT,
  tags_json       TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_favtitles_folder ON kw_fav_titles(folder_id);
CREATE INDEX IF NOT EXISTS idx_favkw_folder     ON kw_fav_keywords(folder_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_favkw_uniq ON kw_fav_keywords(folder_id, keyword);
`);

/**
 * Additive migration: real search-volume columns on the keyword cache, populated
 * by the optional DataForSEO provider (monthly Google search volume + CPC + paid
 * competition index). Nullable so existing rows and free-signal-only runs are
 * unaffected.
 */
{
  const cols = db.prepare("PRAGMA table_info(kw_keywords)").all() as Array<{ name: string }>;
  const add = (name: string, decl: string) => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE kw_keywords ADD COLUMN ${name} ${decl}`);
  };
  add("search_volume", "INTEGER");
  add("cpc", "REAL");
  add("paid_competition", "REAL");
  // Whether YouTube competitor data has been fetched (top-N upfront vs on-click).
  add("competition_fetched", "INTEGER");
}

/**
 * Additive migrations on kw_runs: the AI insights report (JSON) and a `pinned`
 * flag so favorite runs sort to the top of the history sidebar.
 */
{
  const cols = db.prepare("PRAGMA table_info(kw_runs)").all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("insights_json")) db.exec("ALTER TABLE kw_runs ADD COLUMN insights_json TEXT");
  if (!has("pinned")) db.exec("ALTER TABLE kw_runs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  // The user's own channel profile + the set of keywords they've already covered.
  if (!has("channel_json")) db.exec("ALTER TABLE kw_runs ADD COLUMN channel_json TEXT");
  if (!has("covered_json")) db.exec("ALTER TABLE kw_runs ADD COLUMN covered_json TEXT");
}
