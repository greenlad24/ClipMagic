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

export type JobStatus = "queued" | "active" | "paused" | "completed" | "failed" | "canceled";
