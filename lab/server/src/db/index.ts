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

-- Jake Dawson Script Generator: one row per generated script (saved-scripts
-- history). The stage outputs (research/outline/hooks/sections/outro) are large
-- text, stored as JSON docs. status drives the Stage-0 checkpoint flow.
CREATE TABLE IF NOT EXISTS script_runs (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  video_type     TEXT,
  status         TEXT NOT NULL,        -- classifying | awaiting_confirmation | running | completed | failed
  input_json     TEXT NOT NULL,        -- ScriptInput
  setup_json     TEXT,                 -- ScriptSetup (after checkpoint)
  stage0_json    TEXT,                 -- Stage0Result
  stages_json    TEXT,                 -- ScriptStages
  final_document TEXT,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_script_runs_created ON script_runs(created_at);

-- Video Planner: an edited narration in, a timestamped visual plan out.
-- Deliberately separate from the long-form editor — this is the planning step,
-- and the future editor builds on it.
CREATE TABLE IF NOT EXISTS plan_runs (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,        -- ingesting | transcribing | researching | planning | completed | failed
  input_json    TEXT NOT NULL,        -- PlanInput
  duration_sec  REAL,
  plan          TEXT,                 -- the deliverable, in "[M:SS to M:SS] - ..." form
  parsed_json   TEXT,                 -- PlanLine[]
  measure_json  TEXT,                 -- PlanMeasure of the winning round
  rounds_json   TEXT,                 -- per-round measurements from the repair loop
  beats_json    TEXT,                 -- Beat[] (pauses + emphasis)
  research      TEXT,                 -- verified UI fact sheet
  cost_usd      REAL NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_runs_created ON plan_runs(created_at);

-- Channel Audit: one row per audit. The heavy arrays (videos with their
-- scoring, thumbnail attributes and proposed renames) live in JSON columns —
-- a run is read whole by the report page and never queried across, so a table
-- per entity would buy nothing and cost a migration.
CREATE TABLE IF NOT EXISTS audit_runs (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,   -- ingesting|proposing|awaiting-approval|scanning|analysing|renaming|completed|failed
  input_json      TEXT NOT NULL,   -- AuditInput
  subject_json    TEXT,            -- AuditChannel
  proposal_json   TEXT,            -- MarketProposal as proposed
  approved_json   TEXT,            -- MarketProposal as the operator approved it
  competitors_json TEXT,           -- AuditChannel[]
  videos_json     TEXT,            -- AuditVideo[] (scoring + thumbnail + rename)
  market_json     TEXT,            -- AuditVideo[] kept as market evidence
  findings_json   TEXT,            -- AuditFindings
  calls_json      TEXT,            -- AuditCallUsage[]
  cost_usd        REAL NOT NULL DEFAULT 0,
  quota_units     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_runs_created ON audit_runs(created_at);

-- A named, reusable set of competitors. A market belongs to a SUBJECT, not to a
-- channel: the same channel can be audited against two different markets and
-- get different answers, which is the reason to keep them separate.
CREATE TABLE IF NOT EXISTS audit_markets (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  niche            TEXT NOT NULL DEFAULT '',
  niche_desc       TEXT,
  audience         TEXT,
  competitors_json TEXT NOT NULL,
  discovered_from  TEXT,            -- channelId it was first found from
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Proposed titles the operator actually applied, with the view count at that
-- moment. That baseline is the whole point: without it a later check has
-- nothing to compare against, which is why this only works going forward.
CREATE TABLE IF NOT EXISTS audit_applied_renames (
  run_id              TEXT NOT NULL,
  video_id            TEXT NOT NULL,
  original_title      TEXT NOT NULL,
  proposed_title      TEXT NOT NULL,
  applied_at          INTEGER NOT NULL,
  views_at_apply      INTEGER NOT NULL,
  era_median_at_apply INTEGER NOT NULL DEFAULT 0,
  checked_at          INTEGER,
  views_at_check      INTEGER,
  PRIMARY KEY (run_id, video_id)
);

-- Video Planner: the UI fact sheet keyed by the narration it was built from, so
-- re-planning the same video does not pay to research the same products twice.
CREATE TABLE IF NOT EXISTS plan_research_cache (
  narration_hash TEXT PRIMARY KEY,
  markdown       TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

-- AI Image Generator: one row per generated (or edited) image. The bytes live on
-- disk under config.imageHistoryDir as <id>.<ext>; this table is the metadata +
-- history index. kind distinguishes a from-scratch generation from an edit.
CREATE TABLE IF NOT EXISTS image_history (
  id          TEXT PRIMARY KEY,
  prompt      TEXT NOT NULL DEFAULT '',
  file_path   TEXT NOT NULL,        -- absolute path to the stored image on disk
  mime        TEXT NOT NULL,        -- e.g. image/png
  kind        TEXT NOT NULL DEFAULT 'generate',  -- generate | edit
  model       TEXT,                 -- model label used (e.g. Nano Banana)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_image_history_created ON image_history(created_at);
`);

// ── Engagement Manager (monitor social comments/DMs; reply in later phases) ───
db.exec(`
-- Monitored social channels, seeded from the connected Postiz/PostPeer channels.
CREATE TABLE IF NOT EXISTS engage_channels (
  id            TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,              -- youtube | instagram | facebook | tiktok
  external_id   TEXT NOT NULL,              -- YT channelId / IG user id / FB Page id / TikTok handle
  handle        TEXT,
  display_name  TEXT,
  picture       TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1, -- per-channel monitor toggle
  reply_mode    TEXT NOT NULL DEFAULT 'off',-- off | suggest | auto (Phase 1: off)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(platform, external_id)
);

-- Ingested comments + DMs (one row per inbound item; idempotent on dedup_key).
CREATE TABLE IF NOT EXISTS engage_inbox (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  platform      TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- comment | dm
  dedup_key     TEXT NOT NULL,             -- platform-native id
  thread_id     TEXT,
  parent_id     TEXT,
  target_ref    TEXT,                      -- videoId / postId / mediaId
  target_title  TEXT,
  author_name   TEXT,
  author_handle TEXT,
  author_id     TEXT,
  text          TEXT NOT NULL,
  permalink     TEXT,
  posted_at     INTEGER,
  ingested_at   INTEGER NOT NULL,
  source        TEXT NOT NULL,             -- api | browser-scrape
  reply_state   TEXT NOT NULL DEFAULT 'new',
  UNIQUE(platform, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_engage_inbox_channel ON engage_inbox(channel_id, ingested_at);
CREATE INDEX IF NOT EXISTS idx_engage_inbox_state   ON engage_inbox(reply_state);
CREATE INDEX IF NOT EXISTS idx_engage_inbox_ingested ON engage_inbox(ingested_at);

-- Reply records (populated by later phases; declared now to avoid a migration).
CREATE TABLE IF NOT EXISTS engage_replies (
  id            TEXT PRIMARY KEY,
  inbox_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  platform      TEXT NOT NULL,
  status        TEXT NOT NULL,             -- pending | sent | failed | skipped
  mechanism     TEXT,                      -- youtube-api | browser
  generated_text TEXT,
  decide_reason TEXT,
  not_before    INTEGER NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  external_reply_id TEXT,
  error         TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  sent_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_engage_replies_due ON engage_replies(status, not_before);

-- Per-platform fixed-window rate counters (throttle in later phases).
CREATE TABLE IF NOT EXISTS engage_rate_counters (
  platform      TEXT NOT NULL,
  window_kind   TEXT NOT NULL,             -- hour | day
  window_start  INTEGER NOT NULL,
  sent_count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (platform, window_kind, window_start)
);

-- Singleton settings + kill-switch (id='singleton'). kill_switch DEFAULTS ON (1).
CREATE TABLE IF NOT EXISTS engage_settings (
  id               TEXT PRIMARY KEY DEFAULT 'singleton',
  kill_switch      INTEGER NOT NULL DEFAULT 1,
  global_autoreply INTEGER NOT NULL DEFAULT 0,
  caps_json        TEXT,
  pacing_json      TEXT,
  reply_prompt_md  TEXT,
  updated_at       INTEGER NOT NULL
);
`);

/**
 * Additive migration: cache the resolved YouTube uploads playlist id on each
 * monitored channel, so the Engagement Manager's poll loop skips a channels.list
 * lookup (1 quota unit/channel/cycle) once it's been resolved by the seeder.
 * Nullable so a channel resolves it lazily on the first poll.
 */
{
  const cols = db.prepare("PRAGMA table_info(engage_channels)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "uploads_playlist_id")) {
    db.exec("ALTER TABLE engage_channels ADD COLUMN uploads_playlist_id TEXT");
  }
}

/**
 * Additive migration: per-channel engagement STATS snapshot (subscribers/
 * followers · comments · likes) shown atop each channel column. Refreshed on a
 * throttled cadence (ENGAGE_STATS_TTL_MS, default 1h) by the monitor; nullable so
 * a channel reads `stats: null` until its first refresh (stats_updated_at is the
 * "never fetched" sentinel).
 */
{
  const cols = db.prepare("PRAGMA table_info(engage_channels)").all() as Array<{ name: string }>;
  const add = (name: string, decl: string) => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE engage_channels ADD COLUMN ${name} ${decl}`);
  };
  add("audience_count", "INTEGER");
  add("comment_count", "INTEGER");
  add("like_count", "INTEGER");
  add("stats_updated_at", "INTEGER");
}

/**
 * Additive migration: a per-channel access token, used by the Engagement Manager's
 * Meta (Instagram + Facebook) monitoring to store each FB Page's PAGE access token
 * (resolved from the operator's long-lived user token during seed) so the poll
 * loop can READ that Page/IG account's comments. Nullable — only Meta channels set
 * it; YouTube channels leave it null (they read via the shared Data API key). This
 * is a server-only secret, never returned through any HTTP response.
 */
{
  const cols = db.prepare("PRAGMA table_info(engage_channels)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "access_token")) {
    db.exec("ALTER TABLE engage_channels ADD COLUMN access_token TEXT");
  }
}

/**
 * Additive migration: the FB Page id a Meta channel's conversations (DMs) live on.
 * DM monitoring reads /{pageId}/conversations, so BOTH the facebook channel (where
 * meta_page_id == external_id) and the linked instagram channel (whose external_id
 * is the IG user id, NOT a page id) need the FB Page id stored here. Nullable —
 * only Meta channels set it; YouTube channels leave it null.
 */
{
  const cols = db.prepare("PRAGMA table_info(engage_channels)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "meta_page_id")) {
    db.exec("ALTER TABLE engage_channels ADD COLUMN meta_page_id TEXT");
  }
}

/**
 * Additive migration: the last time a TikTok channel was polled via the Apify actor
 * (epoch-ms). TikTok scraping costs Apify credits, so the monitor polls it on a
 * SEPARATE SLOW cadence (ENGAGE_TIKTOK_POLL_INTERVAL_MS, default 6h) rather than
 * every 10-min cycle — this column is the throttle timestamp. Nullable ("never
 * polled" sentinel); only TikTok channels set it.
 */
{
  const cols = db.prepare("PRAGMA table_info(engage_channels)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "tiktok_polled_at")) {
    db.exec("ALTER TABLE engage_channels ADD COLUMN tiktok_polled_at INTEGER");
  }
}

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

/**
 * Additive migration on audit_runs: the report chat and the focus filter it can
 * set. Both arrived after the table, and an audit is expensive enough that
 * re-running one to gain a column would be a poor trade.
 */
{
  const cols = db.prepare("PRAGMA table_info(audit_runs)").all() as Array<{ name: string }>;
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has("chat_json")) db.exec("ALTER TABLE audit_runs ADD COLUMN chat_json TEXT");
  if (!has("focus_json")) db.exec("ALTER TABLE audit_runs ADD COLUMN focus_json TEXT");
  // The whole-catalogue findings, so a focus can be undone.
  if (!has("base_findings_json")) db.exec("ALTER TABLE audit_runs ADD COLUMN base_findings_json TEXT");
  // Sections the operator asked for after the report was written. Additive to
  // the report, so they live beside the findings rather than inside them — a
  // refocus rewrites findings and must not take these with it.
  if (!has("sections_json")) db.exec("ALTER TABLE audit_runs ADD COLUMN sections_json TEXT");
}

/**
 * Additive migration on plan_runs: per-call token usage, so a run's bill can be
 * decomposed into research, each planning round, and cache reads. Before this
 * only the run total was stored, which left "where did the money go"
 * unanswerable without re-running the whole thing.
 */
{
  const cols = db.prepare("PRAGMA table_info(plan_runs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "calls_json")) {
    db.exec("ALTER TABLE plan_runs ADD COLUMN calls_json TEXT");
  }
}

/**
 * Additive migration on script_runs: wall-clock generation time (Stages 1–7),
 * so the saved-scripts history can show how long each script took. A separate
 * column, not the stages blob, so the history list query can read it directly.
 * Accumulates across a resume — the time to finish a failed run adds to the time
 * already spent on it.
 */
{
  const cols = db.prepare("PRAGMA table_info(script_runs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "generation_ms")) {
    db.exec("ALTER TABLE script_runs ADD COLUMN generation_ms INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Additive migration on script_runs: the post-generation paragraph-refinement
 * chat (JSON array of RefineMessage). Nullable so existing rows hydrate to an
 * empty thread. Lives on the run row, not the stages blob, because it's edited
 * long after Stages 1–7 have finished writing that blob.
 */
{
  const cols = db.prepare("PRAGMA table_info(script_runs)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "refine_chat_json")) {
    db.exec("ALTER TABLE script_runs ADD COLUMN refine_chat_json TEXT");
  }
}
