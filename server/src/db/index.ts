import Database from "better-sqlite3";
import { config, ensureDirs } from "../config.js";

/**
 * Single SQLite database for all metadata. A render runs for tens of minutes on
 * the provider's side, so run state has to survive a restart — that is what
 * this is for, and why `resumeInterrupted()` in avatar/pipeline.ts can re-attach
 * to a job that has already been paid for instead of abandoning it.
 */
ensureDirs();

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

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
  -- The fixed room plate the persona sits in ('' = no plate, text-described).
  room_id        TEXT NOT NULL DEFAULT '',
  -- The 20-view character sheet used to place them into a room ('' = none yet).
  sheet_file     TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_avatar_personas_created ON avatar_personas(created_at);

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
`);

/**
 * Additive column migrations, kept for databases created by an older build.
 * `voice_sample_file`, `room_id` and `sheet_file` are all in the CREATE above,
 * so a fresh database skips these entirely — they only fire on an existing file.
 * '' is the pre-feature behaviour in every case, so nobody's persona changes on
 * upgrade.
 */
{
  const cols = db.prepare("PRAGMA table_info(avatar_personas)").all() as Array<{ name: string }>;
  for (const col of ["voice_sample_file", "room_id", "sheet_file"]) {
    if (cols.length && !cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE avatar_personas ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }
}
