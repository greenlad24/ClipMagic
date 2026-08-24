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

/** Additive: page-writing progress on a plan, so a long run can be watched. */
{
  const cols = db.prepare("PRAGMA table_info(skool_plans)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "lessons_status")) {
    db.exec("ALTER TABLE skool_plans ADD COLUMN lessons_status TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE skool_plans ADD COLUMN lessons_done INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE skool_plans ADD COLUMN lessons_total INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Additive: where a transcript came from.
 *
 * The table shipped before the free YouTube path existed, so a database created
 * an hour ago has the column and one created five minutes earlier does not.
 */
{
  const cols = db.prepare("PRAGMA table_info(skool_transcripts)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "source")) {
    db.exec("ALTER TABLE skool_transcripts ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  }
}

/** Additive: the channel the Skool planner pulls missing lessons from, and the
 *  tracks the operator requires the spine to contain. */
{
  const cols = db.prepare("PRAGMA table_info(skool_settings)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "channel_url")) {
    db.exec("ALTER TABLE skool_settings ADD COLUMN channel_url TEXT NOT NULL DEFAULT ''");
  }
  if (cols.length > 0 && !cols.some((c) => c.name === "required_tracks_json")) {
    db.exec("ALTER TABLE skool_settings ADD COLUMN required_tracks_json TEXT NOT NULL DEFAULT '[]'");
  }
  // The autonomous poster's schedule, as one JSON blob rather than a column per
  // knob. It is read and written whole by `engageSchedule.ts` and never queried
  // by field, so columns would buy nothing and cost a migration per setting.
  // ⚠️ AN ABSENT BLOB MUST MEAN "OFF", NOT "DEFAULTS" — see getSchedule(),
  // where `enabled` and `dryRun` are the safe values. A database that upgrades
  // into this column must not start posting because of it.
  if (cols.length > 0 && !cols.some((c) => c.name === "engage_schedule_json")) {
    db.exec("ALTER TABLE skool_settings ADD COLUMN engage_schedule_json TEXT NOT NULL DEFAULT ''");
  }
  // The scheduler's heartbeat: when a cycle last started, last finished, and
  // how it went.
  //
  // ⚠️ WITHOUT IT, A DEAD SCHEDULER AND A QUIET ONE LOOK IDENTICAL. A tick that
  // finds nothing to do logs nothing and writes nothing, which is the correct
  // behaviour and also means silence carries no information — the process can
  // stop ticking entirely and every observable stays exactly as it was. The
  // container goes on reporting healthy, because the HTTP server is fine.
  //
  // Persisted rather than held in memory for the same reason: an in-memory
  // heartbeat is reset by the restart that a wedged scheduler needs, so it can
  // never answer "how long was it down?" — the one question worth asking after
  // a post fails to appear.
  if (cols.length > 0 && !cols.some((c) => c.name === "engage_tick_json")) {
    db.exec("ALTER TABLE skool_settings ADD COLUMN engage_tick_json TEXT NOT NULL DEFAULT ''");
  }
  // The reply agent's own settings, kept apart from the poster's blob on
  // purpose: they are armed separately, and one of them writes to a member's
  // private inbox. Sharing a blob would make "turn the poster on" and "start
  // messaging people" one edit away from each other.
  //
  // ⚠️ SAME RULE AS ABOVE — AN ABSENT BLOB MEANS OFF, NOT DEFAULTS.
  if (cols.length > 0 && !cols.some((c) => c.name === "engage_replies_json")) {
    db.exec("ALTER TABLE skool_settings ADD COLUMN engage_replies_json TEXT NOT NULL DEFAULT ''");
  }
  // The reply agent's heartbeat, and when its last sweep ran — the sweep is on
  // its own cadence, so the poster's heartbeat says nothing about it.
  if (cols.length > 0 && !cols.some((c) => c.name === "engage_replies_tick_json")) {
    db.exec("ALTER TABLE skool_settings ADD COLUMN engage_replies_tick_json TEXT NOT NULL DEFAULT ''");
  }
}

/** Additive: what a slot announces, and what it attaches.
 *
 * ⚠️ THE LIVE DATABASE ALREADY HAS THIS TABLE, so adding the columns to the
 * CREATE above reaches fresh installs only — and the fresh install here is the
 * one nobody runs. The scheduler is armed and posting against the existing file.
 */
{
  const cols = db.prepare("PRAGMA table_info(skool_engage_slots)").all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === "video_id")) {
    db.exec("ALTER TABLE skool_engage_slots ADD COLUMN video_id TEXT NOT NULL DEFAULT ''");
  }
  if (cols.length > 0 && !cols.some((c) => c.name === "attachment_json")) {
    db.exec("ALTER TABLE skool_engage_slots ADD COLUMN attachment_json TEXT NOT NULL DEFAULT ''");
  }
  // ⚠️ THE DEFAULT IS 'lesson' AND THAT IS THE PRE-EXISTING BEHAVIOUR, NOT A
  // CHOICE. Every slot written before this column existed was drafted as a
  // lesson because the scheduler hardcoded it; backfilling them to anything
  // else would rewrite history the drafts do not match.
  if (cols.length > 0 && !cols.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE skool_engage_slots ADD COLUMN kind TEXT NOT NULL DEFAULT 'lesson'");
  }
  // ⚠️ WITHOUT THIS, A SUCCESSFUL POST KEEPS NO RECORD OF HOW IT WENT. The
  // publisher's step log is where "⚠ Attachment SKIPPED" appears — and the
  // scheduler wrote that log to `last_error` on FAILURE and threw it away on
  // SUCCESS. A post that published perfectly except that its video did not
  // attach is a success by every stored measure, and the one line saying
  // otherwise went to a container log nobody reads.
  if (cols.length > 0 && !cols.some((c) => c.name === "steps")) {
    db.exec("ALTER TABLE skool_engage_slots ADD COLUMN steps TEXT NOT NULL DEFAULT ''");
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

-- Skool manager: one singleton row of operator settings. The classroom itself
-- is never mirrored here — it is read live from Skool, because a cached copy of
-- a community someone else can edit is a copy that is wrong by the time it is
-- read.
CREATE TABLE IF NOT EXISTS skool_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  community_url  TEXT NOT NULL DEFAULT '',
  -- The roadmap the operator wants members to move through. Free text: it is
  -- an input to the course planner, not a schema.
  roadmap_md     TEXT NOT NULL DEFAULT '',
  -- The creator's YouTube channel — the source of the lessons that are not in
  -- the classroom yet.
  channel_url    TEXT NOT NULL DEFAULT '',
  -- Tracks the operator requires the spine to contain, as JSON:
  -- [{"title":"...","note":"..."}]. These are a CONSTRAINT, not guidance —
  -- the planner has already shown it will override an instruction it is merely
  -- told, so required tracks are built into the structure instead.
  required_tracks_json TEXT NOT NULL DEFAULT '[]',
  -- ⚠️ THESE TWO MUST BE HERE *AND* IN THE ALTER BLOCK ABOVE, BECAUSE THE
  -- MIGRATIONS RUN BEFORE THIS SCHEMA DOES. On a database that already exists
  -- the ALTERs add them; on a fresh one PRAGMA table_info returns nothing, the
  -- "cols.length > 0" guard correctly declines to migrate a table that is
  -- not there yet — and then this CREATE is the only thing that can supply
  -- them. Listing them only above meant a fresh install built the table
  -- without them and every read threw "no such column" forever after. It went
  -- unnoticed because the live database was migrated long ago; a test on a
  -- throwaway DATA_DIR found it immediately (2026-08-09).
  engage_schedule_json TEXT NOT NULL DEFAULT '',
  engage_tick_json     TEXT NOT NULL DEFAULT '',
  engage_replies_json      TEXT NOT NULL DEFAULT '',
  engage_replies_tick_json TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL
);
INSERT OR IGNORE INTO skool_settings (id, community_url, roadmap_md, updated_at)
  VALUES (1, '', '', 0);

-- A SNAPSHOT of the whole classroom, contents and all.
--
-- This is not a contradiction of the "never mirror the classroom" rule above.
-- The course LIST is cheap and always read live. Reading the inside of every
-- course is minutes of browser work, and the planner needs to reason over the
-- whole thing across many steps — so it works from a snapshot with an explicit
-- timestamp on it. The rule that keeps this honest: the write path re-reads
-- live before it changes anything, and never trusts these ids.
CREATE TABLE IF NOT EXISTS skool_inventory (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  community_url  TEXT NOT NULL,
  -- running | done | failed. A crashed read stays 'running' with its partial
  -- progress visible, rather than reporting a complete snapshot it never took.
  status         TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  courses_total  INTEGER NOT NULL DEFAULT 0,
  courses_read   INTEGER NOT NULL DEFAULT 0,
  community      TEXT,
  account        TEXT,
  error          TEXT,
  data_json      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_skool_inventory_started ON skool_inventory(started_at);

-- A proposed spine for the classroom. Kept separately from the inventory it
-- was built from, and stamped with that inventory's id: a plan read against a
-- classroom that has since changed is a plan that would write to the wrong
-- place, and the write path checks this before it touches anything.
CREATE TABLE IF NOT EXISTS skool_plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_id  INTEGER NOT NULL,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  error         TEXT,
  data_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_skool_plans_created ON skool_plans(created_at);

-- Recorded recipes for Skool's editing UI, taught by demonstration.
--
-- Skool's admin controls cannot be found by querying the DOM: they are plain
-- divs, they do not exist until hovered, and every class is a build hash. So
-- the operator performs each action once in a live console and the steps are
-- recorded here as element DESCRIPTORS — never coordinates, which break the
-- moment a card moves or a list grows.

-- Video transcripts, keyed by YouTube id.
--
-- ⚠️ THIS TABLE EXISTS BECAUSE fetchTranscript HAS NO CACHE AND APIFY CHARGES
-- PER CALL. The engagement agent needs to know what is IN the videos its
-- lessons attach, and re-fetching ~90 of them on every retrieval would buy the
-- same transcripts over and over.
--
-- ⚠️ FAILURES ARE STORED TOO, and status is the reason. A video with captions
-- off and a video that could not be reached are both "no text", but only one is
-- worth retrying — and a missing row would send both back to Apify forever. An
-- empty transcript is also the tell for a DEAD video (memory: BD5NIcdMBQ4
-- returns 403 from oembed), so it is a fact worth keeping, not an absence.
CREATE TABLE IF NOT EXISTS skool_transcripts (
  video_id   TEXT PRIMARY KEY,
  text       TEXT NOT NULL DEFAULT '',
  chars      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'ok',
  -- Where it came from: youtube (free) or apify (paid). Worth recording because
  -- it is the only way to see whether the free path is actually working from
  -- this box, and the answer decides whether future runs cost anything.
  source     TEXT NOT NULL DEFAULT '',
  fetched_at INTEGER NOT NULL
);

-- One row per SCHEDULED POSTING SLOT — the autonomous poster's queue and its log.
--
-- ⚠️⚠️ slot_key IS THE LOCAL CALENDAR DATE AND IT IS THE PRIMARY KEY, WHICH IS
-- WHAT MAKES A RETRY SAFE. The scheduler ticks every ten minutes and retries a
-- rate-limited slot for hours; without a unique key per day, "try again" and
-- "post again" would be the same operation. The classroom rebuild already paid
-- for this lesson the expensive way — an op reporting OK is not a thing having
-- happened, and the only cure is that repeating it cannot double-write.
--
-- The states are deliberately four, not ok/failed:
--   pending   — queued, waiting on a retry. Usually the Max window being shut,
--               which is NOT a failure and must not read as one.
--   drafted   — written but deliberately not published (dry run, or awaiting a
--               human's go-ahead). The body sits here so that what is approved
--               is exactly what ships.
--   posted    — read back from the feed by createPost. The only success.
--   abandoned — out of attempts, or too late to be the post that was promised.
--               Recorded WITH its reason; a silent skip is indistinguishable
--               from "not a posting day".
CREATE TABLE IF NOT EXISTS skool_engage_slots (
  slot_key        TEXT PRIMARY KEY,
  state           TEXT NOT NULL DEFAULT 'pending',
  subject         TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL DEFAULT '',
  cited_json      TEXT NOT NULL DEFAULT '[]',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  slug            TEXT NOT NULL DEFAULT '',
  -- The upload this slot announces, when it is a new-video post. The ledger row
  -- in skool_video_posts is only written once the post actually lands, so this
  -- column is what carries the id from "slot opened" to "slot published".
  video_id        TEXT NOT NULL DEFAULT '',
  -- The video or poll the drafter chose to attach, as JSON. Stored so a retry
  -- attaches what was already approved rather than choosing again.
  attachment_json TEXT NOT NULL DEFAULT '',
  -- Which post this slot is: 'lesson' (the classroom post) or 'mcp' (Tuesday's
  -- automation idea, which has a fixed four-part shape). Decided when the slot
  -- OPENS, not when it drafts, for the same reason the title and body are kept:
  -- a retry must re-draft the post that was queued, not a different one because
  -- the retry happened to land on another weekday.
  kind            TEXT NOT NULL DEFAULT 'lesson',
  -- The publisher's step log, kept whether the post succeeded or failed. It is
  -- the only place an attachment that did not attach is recorded, and a post
  -- can succeed without one.
  steps           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skool_slots_due ON skool_engage_slots(state, next_attempt_at);

-- One row per upload that has been given a classroom page.
--
-- ⚠️ A LEDGER, NOT A COUNTER. The question is "has THIS video got a page", which
-- answers itself when nothing new has been uploaded. As a weekly counter it
-- would write a second page about the same video every week Jake did not post
-- one — and unlike a duplicate announcement, the recovery for that is deleting
-- pages out of a live classroom by hand.
--
-- The row is written when the page LANDS in the course, never when it is
-- drafted: a run that writes a body and then fails to place it must be able to
-- try again.
CREATE TABLE IF NOT EXISTS skool_video_lessons (
  video_id   TEXT PRIMARY KEY,
  course_slug TEXT NOT NULL DEFAULT '',
  page_title  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- Subjects the operator wants posted, ahead of anything the agent would pick.
--
-- The scheduler chooses its own subject from the lesson index, which is right
-- for a standing 3-a-week rhythm and useless when there is something specific
-- to say — "I rebuilt the classroom and it now has learner journeys" is not a
-- lesson in the index and could never be selected from it.
--
-- ⚠️ A PIN IS RESERVED, NOT CONSUMED, WHEN A SLOT TAKES IT. If it were deleted
-- at enqueue, a slot that later hit the staleness limit or ran out of attempts
-- would take the subject down with it and nobody would learn that the thing
-- they asked for never went out. The state goes back to 'queued' when a slot is
-- abandoned (a backtick here would close this template literal, which is a trap
-- this file has sprung before), so the pin outlives the slot that failed it.
CREATE TABLE IF NOT EXISTS skool_engage_pinned (
  id         TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  -- queued — waiting for the next posting day.
  -- used   — a slot has it; cleared back to queued if that slot is abandoned.
  -- posted — it actually went out. Kept as a record of what was asked for.
  state      TEXT NOT NULL DEFAULT 'queued',
  slot_key   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skool_pinned_state ON skool_engage_pinned(state, created_at);

-- Which of Jake's YouTube uploads have already had a post written about them.
--
-- Jake, 2026-08-07: "Never post about the same video twice." A video is
-- announced once, and this is the record that makes that true across restarts.
-- It stores the id and the title it had at the time, because a title can be
-- edited on YouTube and the id cannot, and a human reading this table later
-- needs to recognise the row.
--
-- 'announced' is written when the post actually lands, never when it is drafted
-- (a slot that drafts and fails to publish must not burn the video).
CREATE TABLE IF NOT EXISTS skool_video_posts (
  video_id   TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  slot_key   TEXT NOT NULL DEFAULT '',
  posted_at  INTEGER NOT NULL
);

-- Every member message the reply agent has ENGAGED WITH, and what came of it.
--
-- ⚠️⚠️ THE KEY IS THE MESSAGE, NOT THE PERSON OR THE THREAD. For a comment that
-- is Skool's comment id; for a DM it is the id of THEIR last message. Keying on
-- the channel would mean a member who asks a second question in the same thread
-- is never answered again, and keying on the member would mean it once, ever.
--
-- ⚠️⚠️ A ROW EXISTS FROM THE MOMENT ANYTHING IS SPENT ON A MESSAGE, and the
-- collector excludes any message that has one. That is deliberately stricter
-- than "exclude what was sent": a crash between the send and the read-back
-- leaves 'unconfirmed', and re-answering someone is the failure that cannot be
-- walked back, while failing to answer them is one a human can see and fix from
-- this table. Every state that is not 'sent' or 'skipped' is therefore a row
-- somebody should look at, which is exactly what /skool/agent shows.
--
--   drafted     — written, deliberately not sent (dry run, or awaiting approval)
--   sent        — read back from Skool's own API, with the reply's id
--   unconfirmed — the click went in and the read-back did not find it. DO NOT
--                 retry from here; look at the thread.
--   skipped     — the drafter declined, with its reason. Not a failure.
--   failed      — refused before anything was written. Retryable.
CREATE TABLE IF NOT EXISTS skool_reply_log (
  id           TEXT PRIMARY KEY,      -- "<surface>:<target_id>"
  surface      TEXT NOT NULL,         -- 'comment' | 'dm'
  target_id    TEXT NOT NULL,         -- comment id, or their last message id
  -- Where to go to look at it. A comment needs its post; a DM needs its channel.
  post_slug    TEXT NOT NULL DEFAULT '',
  channel_id   TEXT NOT NULL DEFAULT '',
  member_id    TEXT NOT NULL DEFAULT '',
  member_name  TEXT NOT NULL DEFAULT '',
  -- What they said, stored because the reply is unreadable without it and the
  -- API paginates the original away.
  their_text   TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL DEFAULT 'drafted',
  reply_text   TEXT NOT NULL DEFAULT '',
  skip_reason  TEXT NOT NULL DEFAULT '',
  cited_json   TEXT NOT NULL DEFAULT '[]',
  -- The id Skool gave the reply when it was read back. Empty unless 'sent'.
  reply_id     TEXT NOT NULL DEFAULT '',
  tokens       INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  -- The writer's step log, kept on success as well as failure: it is the only
  -- record of HOW a reply reached a member.
  steps        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skool_reply_log_state ON skool_reply_log(state, created_at);
CREATE INDEX IF NOT EXISTS idx_skool_reply_log_sent ON skool_reply_log(updated_at);

CREATE TABLE IF NOT EXISTS skool_recipes (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  steps_json  TEXT NOT NULL DEFAULT '[]',
  updated_at  INTEGER NOT NULL
);

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
 * Additive migration: what we know about WHO sent an inbox item, as JSON.
 *
 * Jake's reply rules turn on the sender, not just the message — a verified
 * account or one with a real following gets an answer, a throwaway account with
 * a badly-written pitch does not. The model cannot see any of that from the
 * message text, so the browser reads it off the sender's profile and it is
 * stored here: { verified, followers, following, posts, bio }.
 *
 * Nullable and free-form on purpose. It is only ever populated for browser-read
 * Instagram DMs today, and a signal we can't get is simply absent rather than
 * guessed at — an absent follower count must never read as zero followers.
 */
{
  const cols = db.prepare("PRAGMA table_info(engage_inbox)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "author_meta")) {
    db.exec("ALTER TABLE engage_inbox ADD COLUMN author_meta TEXT");
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

// ── Avatar Narrator (synthetic-presenter talking-head videos) ────────────────
// A PERSONA is the reusable half: one locked-in synthetic face plus the voice
// and the wardrobe/setting prompt that keep every video looking like the same
// person. A VIDEO is one narration run against a persona. SEGMENTS exist only
// because a run can be split into several provider jobs (fast mode) — they
// carry the per-job cost and clip so a partial failure is resumable and the
// spend is auditable per clip rather than per run.
db.exec(`
CREATE TABLE IF NOT EXISTS avatar_personas (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  look_prompt    TEXT NOT NULL DEFAULT '',   -- how the persona was described to the image model
  scene_prompt   TEXT NOT NULL DEFAULT '',   -- motion/behaviour hint passed to the avatar model
  portrait_file  TEXT NOT NULL,              -- absolute path to the locked portrait on disk
  portrait_mime  TEXT NOT NULL DEFAULT 'image/png',
  tts_provider   TEXT NOT NULL DEFAULT 'gemini',
  tts_voice      TEXT NOT NULL DEFAULT '',
  -- The reference clip the persona's voice was cloned FROM. Kept deliberately:
  -- a cloned voice model lives inside the vendor and cannot be exported, but
  -- the sample it was made from is ours, so the voice can be re-cloned into
  -- another provider later. This file is the durable asset, not the voice id.
  voice_sample_file TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avatar_personas_created ON avatar_personas(created_at);
-- (see the voice_sample_file migration below for databases created before it)

CREATE TABLE IF NOT EXISTS avatar_videos (
  id             TEXT PRIMARY KEY,
  persona_id     TEXT NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  script         TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued', -- queued|voicing|rendering|stitching|done|failed|canceled
  phase          TEXT NOT NULL DEFAULT '',       -- human-readable current step
  progress       REAL NOT NULL DEFAULT 0,        -- 0..1
  provider       TEXT NOT NULL DEFAULT 'kie',
  resolution     TEXT NOT NULL DEFAULT '720p',
  audio_file     TEXT,                           -- narration mp3 on disk
  audio_seconds  REAL NOT NULL DEFAULT 0,
  video_file     TEXT,                           -- finished mp4 on disk
  cost_usd       REAL NOT NULL DEFAULT 0,        -- actual, summed from segments + TTS
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (persona_id) REFERENCES avatar_personas(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_avatar_videos_created ON avatar_videos(created_at);
CREATE INDEX IF NOT EXISTS idx_avatar_videos_persona ON avatar_videos(persona_id);

CREATE TABLE IF NOT EXISTS avatar_segments (
  id             TEXT PRIMARY KEY,
  video_id       TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  text           TEXT NOT NULL DEFAULT '',
  audio_file     TEXT,
  seconds        REAL NOT NULL DEFAULT 0,
  provider_task  TEXT,                           -- the provider's task/prediction id
  clip_file      TEXT,                           -- downloaded segment mp4
  status         TEXT NOT NULL DEFAULT 'pending',-- pending|voicing|submitted|done|failed
  cost_usd       REAL NOT NULL DEFAULT 0,
  error          TEXT,
  FOREIGN KEY (video_id) REFERENCES avatar_videos(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_avatar_segments_video ON avatar_segments(video_id, idx);

-- Tutorial Studio batches: one theme in, ~30 finished reels out. The batch is a
-- REVIEW queue first and a render queue second — ideas are proposed, scripts are
-- written, and nothing paid happens until the operator approves each one. That
-- is why the items live here and not in the sidecar: they are edited for a while
-- before a job exists, and the edits must survive a container restart.
CREATE TABLE IF NOT EXISTS ts_batches (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  theme        TEXT NOT NULL DEFAULT '',
  avatar_id    TEXT NOT NULL DEFAULT '',   -- sidecar avatar id ('' = packaged look)
  environment  TEXT NOT NULL DEFAULT '',   -- the one room every video is shot in
  target_count INTEGER NOT NULL DEFAULT 30,
  status       TEXT NOT NULL,              -- ideas | scripting | review | rendering | done
  error        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ts_batches_created ON ts_batches(created_at);

-- One row per video in a batch, carrying it from idea to posted reel.
-- job_id is the sidecar job once rendering starts; before that it is ''.
CREATE TABLE IF NOT EXISTS ts_batch_items (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  topic       TEXT NOT NULL DEFAULT '',
  hook        TEXT NOT NULL DEFAULT '',
  picked      INTEGER NOT NULL DEFAULT 0,  -- operator chose this idea
  approved    INTEGER NOT NULL DEFAULT 0,  -- operator approved the script
  script_json TEXT,                        -- TutorialScript, editable until approved
  outfit      TEXT NOT NULL DEFAULT '',
  scene       TEXT NOT NULL DEFAULT '',
  job_id      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'idea', -- idea | scripted | approved | queued | rendering | done | failed
  error       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ts_items_batch ON ts_batch_items(batch_id, idx);

-- Bulk Scheduler CAPTION CACHE. Captions were regenerated from scratch on every
-- preview — one AI call per video, plus a transcription — so re-planning the
-- same library cost the same money and the same half hour every time. A file's
-- caption does not depend on WHEN it is scheduled, so it is cached here per
-- (file, platform) and reused until explicitly re-generated.
CREATE TABLE IF NOT EXISTS bulk_captions (
  file_id         TEXT NOT NULL,          -- "<kind>:<ref>"
  platform        TEXT NOT NULL,          -- tiktok | instagram | youtube | generic
  caption         TEXT NOT NULL DEFAULT '',
  hashtags_json   TEXT NOT NULL DEFAULT '[]',
  first_line_hook TEXT NOT NULL DEFAULT '',
  transcript      TEXT,                   -- what the caption was grounded in
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (file_id, platform)
);

-- Bulk Scheduler PREVIEW RUNS. Building a plan used to live entirely inside one
-- HTTP request: a 227-video plan took 31 minutes of silence, and when the
-- connection died the finished 2.5MB result had nowhere to go and every AI call
-- was wasted (2026-08-24). The plan is now built in the background against this
-- row, so the page can drop, reload and reconnect without re-spending.
CREATE TABLE IF NOT EXISTS bulk_preview_runs (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL,             -- running | done | failed | cancelled
  stage        TEXT NOT NULL DEFAULT '',  -- human-readable current stage
  done_count   INTEGER NOT NULL DEFAULT 0,
  total_count  INTEGER NOT NULL DEFAULT 0,
  cached_count INTEGER NOT NULL DEFAULT 0, -- files that reused a stored caption
  input_json   TEXT NOT NULL,
  result_json  TEXT,                      -- PreviewOutput, once finished
  error        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bulk_preview_created ON bulk_preview_runs(created_at);
`);

/**
 * Additive: which version of the caption VOICE wrote this row. NULL means it
 * predates the voice entirely (the 908 captions written before 2026-08-24) —
 * those read fine but are not in Jake's voice, and the deterministic tell-strip
 * hides the difference, so the text itself cannot be used to tell them apart.
 *
 * MUST sit after the db.exec() that CREATEs bulk_captions — a migration placed
 * above its own table crashes a FRESH database on boot with "no such table",
 * which an existing install never shows you.
 */
{
  const cols = db.prepare("PRAGMA table_info(bulk_captions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "voice_version")) {
    db.exec("ALTER TABLE bulk_captions ADD COLUMN voice_version INTEGER");
  }
}

/**
 * Additive: the reference clip a persona's voice was cloned from.
 *
 * Needed as a migration and not just in the CREATE above, because the avatar
 * tables already exist on the deployed lab. A cloned voice cannot be exported
 * from the vendor that hosts it — keeping the sample is what makes the voice
 * re-creatable somewhere else, so it is stored beside the portrait rather than
 * thrown away after the clone succeeds.
 */
{
  const cols = db.prepare("PRAGMA table_info(avatar_personas)").all() as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "voice_sample_file")) {
    db.exec("ALTER TABLE avatar_personas ADD COLUMN voice_sample_file TEXT NOT NULL DEFAULT ''");
  }
  // Room plates arrived later than personas. Existing rows default to '', which
  // means "no plate" and falls back to the text-described room — the behaviour
  // they were created with, so nobody's face moves house on upgrade.
  if (cols.length && !cols.some((c) => c.name === "room_id")) {
    db.exec("ALTER TABLE avatar_personas ADD COLUMN room_id TEXT NOT NULL DEFAULT ''");
  }
  // The character sheet: one persona, twenty angles, generated once and reused
  // for every placement into a room. '' means "not made yet" — placement then
  // falls back to the single portrait, which works but drifts more.
  if (cols.length && !cols.some((c) => c.name === "sheet_file")) {
    db.exec("ALTER TABLE avatar_personas ADD COLUMN sheet_file TEXT NOT NULL DEFAULT ''");
  }
}
