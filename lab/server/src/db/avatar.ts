/**
 * Typed helpers over the Avatar Narrator tables (avatar_personas,
 * avatar_videos, avatar_segments — defined in db/index.ts). Mirrors
 * db/favorites.ts / db/jobs.ts: plain better-sqlite3 prepared statements,
 * nanoid() ids, Date.now() timestamps.
 *
 * On-disk artefacts (portrait, narration MP3, finished MP4) are stored as
 * ABSOLUTE paths and surfaced to the browser as /api/avatar/<basename> URLs.
 * The rows are the index; the files are the payload. Deleting a row therefore
 * has to delete its files too — see deleteVideo/deletePersona, which are the
 * only correct way to remove either.
 */
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "./index.js";
import { config } from "../config.js";
import {
  coerceProvider,
  coerceResolution,
  coerceTtsProvider,
  type AvatarPersona,
  type AvatarSegment,
  type AvatarVideo,
  type AvatarVideoStatus,
} from "../avatar/types.js";

const now = () => Date.now();

/**
 * Server-relative URL for a file inside avatarDir. Returns null for anything
 * outside it, so a stray absolute path can never be turned into a URL that
 * escapes the served directory.
 */
function avatarUrl(file: string | null): string | null {
  if (!file) return null;
  const rel = path.relative(config.avatarDir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return `/api/avatar/${rel.split(path.sep).map(encodeURIComponent).join("/")}`;
}

/** Best-effort unlink — a missing file must never block a delete. */
function rm(file: string | null | undefined): void {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

// ── Personas ─────────────────────────────────────────────────────────────────

function rowToPersona(r: any): AvatarPersona {
  return {
    id: r.id,
    name: r.name,
    lookPrompt: r.look_prompt ?? "",
    scenePrompt: r.scene_prompt ?? "",
    portraitFile: r.portrait_file,
    portraitMime: r.portrait_mime ?? "image/png",
    ttsProvider: coerceTtsProvider(r.tts_provider),
    ttsVoice: r.tts_voice ?? "",
    voiceSampleFile: r.voice_sample_file ?? "",
    roomId: r.room_id ?? "",
    sheetFile: r.sheet_file ?? "",
    createdAt: r.created_at,
    portraitUrl: avatarUrl(r.portrait_file) ?? "",
    voiceSampleUrl: avatarUrl(r.voice_sample_file) ?? null,
    sheetUrl: avatarUrl(r.sheet_file) ?? null,
  };
}

export function createPersona(input: {
  name: string;
  lookPrompt: string;
  scenePrompt: string;
  portraitFile: string;
  portraitMime: string;
  ttsProvider: string;
  ttsVoice: string;
  /** The clip the voice was cloned from — kept so it can be re-cloned later. */
  voiceSampleFile?: string;
  /** Room plate the portrait was generated in (see avatar/rooms.ts). */
  roomId?: string;
}): AvatarPersona {
  const id = nanoid();
  db.prepare(
    `INSERT INTO avatar_personas
       (id, name, look_prompt, scene_prompt, portrait_file, portrait_mime, tts_provider, tts_voice, voice_sample_file, room_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.lookPrompt,
    input.scenePrompt,
    input.portraitFile,
    input.portraitMime,
    coerceTtsProvider(input.ttsProvider),
    input.ttsVoice,
    input.voiceSampleFile ?? "",
    input.roomId ?? "",
    now(),
  );
  return getPersona(id)!;
}

export function getPersona(id: string): AvatarPersona | null {
  const r = db.prepare("SELECT * FROM avatar_personas WHERE id = ?").get(id);
  return r ? rowToPersona(r) : null;
}

export function listPersonas(): AvatarPersona[] {
  return db
    .prepare("SELECT * FROM avatar_personas ORDER BY created_at DESC")
    .all()
    .map(rowToPersona);
}

export function updatePersona(
  id: string,
  patch: Partial<{ name: string; scenePrompt: string; ttsProvider: string; ttsVoice: string; voiceSampleFile: string }>,
): AvatarPersona | null {
  const cur = getPersona(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE avatar_personas SET name = ?, scene_prompt = ?, tts_provider = ?, tts_voice = ?, voice_sample_file = ? WHERE id = ?`,
  ).run(
    patch.name ?? cur.name,
    patch.scenePrompt ?? cur.scenePrompt,
    coerceTtsProvider(patch.ttsProvider ?? cur.ttsProvider),
    patch.ttsVoice ?? cur.ttsVoice,
    patch.voiceSampleFile ?? cur.voiceSampleFile,
    id,
  );
  return getPersona(id);
}

/**
 * Delete a persona and everything made from it. The FK cascade removes the video
 * and segment ROWS, but SQLite cannot unlink files — so the artefacts are
 * collected and removed here first, before the cascade makes them unreachable.
 */
/** Point a persona at its current character sheet (see characterSheet.ts). */
export function setPersonaSheet(id: string, sheetFile: string): void {
  db.prepare(`UPDATE avatar_personas SET sheet_file = ? WHERE id = ?`).run(sheetFile, id);
}

export function deletePersona(id: string): boolean {
  const persona = getPersona(id);
  if (!persona) return false;

  for (const v of db.prepare("SELECT id FROM avatar_videos WHERE persona_id = ?").all(id) as Array<{ id: string }>) {
    deleteVideoFiles(v.id);
  }
  rm(persona.portraitFile);
  // The sheet is a persona-level file like the portrait, so it dies with it —
  // the rows are the index, the files are the payload (see the header).
  rm(persona.sheetFile);
  db.prepare("DELETE FROM avatar_personas WHERE id = ?").run(id);
  return true;
}

// ── Videos ───────────────────────────────────────────────────────────────────

function rowToSegment(r: any): AvatarSegment {
  return {
    id: r.id,
    videoId: r.video_id,
    idx: r.idx,
    text: r.text ?? "",
    seconds: r.seconds ?? 0,
    status: r.status,
    providerTask: r.provider_task ?? null,
    costUsd: r.cost_usd ?? 0,
    error: r.error ?? null,
  };
}

function rowToVideo(r: any, segments: AvatarSegment[]): AvatarVideo {
  return {
    id: r.id,
    personaId: r.persona_id,
    personaName: r.persona_name ?? "",
    title: r.title ?? "",
    script: r.script ?? "",
    status: r.status as AvatarVideoStatus,
    phase: r.phase ?? "",
    progress: r.progress ?? 0,
    provider: coerceProvider(r.provider),
    resolution: coerceResolution(r.resolution),
    audioSeconds: r.audio_seconds ?? 0,
    costUsd: r.cost_usd ?? 0,
    error: r.error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    audioUrl: avatarUrl(r.audio_file ?? null),
    videoUrl: avatarUrl(r.video_file ?? null),
    segments,
  };
}

export function createVideo(input: {
  personaId: string;
  title: string;
  script: string;
  provider: string;
  resolution: string;
}): string {
  const id = nanoid();
  const t = now();
  db.prepare(
    `INSERT INTO avatar_videos (id, persona_id, title, script, status, phase, progress, provider, resolution, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 'Queued', 0, ?, ?, ?, ?)`,
  ).run(id, input.personaId, input.title, input.script, coerceProvider(input.provider), coerceResolution(input.resolution), t, t);
  return id;
}

export function updateVideo(
  id: string,
  patch: Partial<{
    status: AvatarVideoStatus;
    phase: string;
    progress: number;
    audioFile: string | null;
    audioSeconds: number;
    videoFile: string | null;
    costUsd: number;
    error: string | null;
  }>,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };

  if (patch.status !== undefined) put("status", patch.status);
  if (patch.phase !== undefined) put("phase", patch.phase);
  if (patch.progress !== undefined) put("progress", Math.max(0, Math.min(1, patch.progress)));
  if (patch.audioFile !== undefined) put("audio_file", patch.audioFile);
  if (patch.audioSeconds !== undefined) put("audio_seconds", patch.audioSeconds);
  if (patch.videoFile !== undefined) put("video_file", patch.videoFile);
  if (patch.costUsd !== undefined) put("cost_usd", patch.costUsd);
  if (patch.error !== undefined) put("error", patch.error);
  if (!sets.length) return;

  put("updated_at", now());
  db.prepare(`UPDATE avatar_videos SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

export function getVideo(id: string): AvatarVideo | null {
  const r = db
    .prepare(
      `SELECT v.*, p.name AS persona_name
         FROM avatar_videos v LEFT JOIN avatar_personas p ON p.id = v.persona_id
        WHERE v.id = ?`,
    )
    .get(id);
  if (!r) return null;
  const segments = (db.prepare("SELECT * FROM avatar_segments WHERE video_id = ? ORDER BY idx").all(id) as any[]).map(rowToSegment);
  return rowToVideo(r, segments);
}

/**
 * The history list. Segments are deliberately NOT hydrated here — a list of 200
 * runs would otherwise mean 200 extra queries to render rows that never show
 * them.
 */
export function listVideos(limit = 100): AvatarVideo[] {
  const rows = db
    .prepare(
      `SELECT v.*, p.name AS persona_name
         FROM avatar_videos v LEFT JOIN avatar_personas p ON p.id = v.persona_id
        ORDER BY v.created_at DESC LIMIT ?`,
    )
    .all(limit) as any[];
  return rows.map((r) => rowToVideo(r, []));
}

/** Unlink a run's artefacts (narration, clips, final MP4) without touching rows. */
function deleteVideoFiles(videoId: string): void {
  const v = db.prepare("SELECT audio_file, video_file FROM avatar_videos WHERE id = ?").get(videoId) as any;
  if (v) {
    rm(v.audio_file);
    rm(v.video_file);
  }
  for (const s of db.prepare("SELECT audio_file, clip_file FROM avatar_segments WHERE video_id = ?").all(videoId) as any[]) {
    rm(s.audio_file);
    rm(s.clip_file);
  }
}

export function deleteVideo(id: string): boolean {
  const exists = db.prepare("SELECT 1 FROM avatar_videos WHERE id = ?").get(id);
  if (!exists) return false;
  deleteVideoFiles(id);
  db.prepare("DELETE FROM avatar_videos WHERE id = ?").run(id);
  return true;
}

// ── Segments ─────────────────────────────────────────────────────────────────

export function createSegment(input: { videoId: string; idx: number; text: string }): string {
  const id = nanoid();
  db.prepare("INSERT INTO avatar_segments (id, video_id, idx, text, status) VALUES (?, ?, ?, ?, 'pending')").run(
    id,
    input.videoId,
    input.idx,
    input.text,
  );
  return id;
}

export function updateSegment(
  id: string,
  patch: Partial<{
    status: AvatarSegment["status"];
    audioFile: string | null;
    seconds: number;
    providerTask: string | null;
    clipFile: string | null;
    costUsd: number;
    error: string | null;
  }>,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };

  if (patch.status !== undefined) put("status", patch.status);
  if (patch.audioFile !== undefined) put("audio_file", patch.audioFile);
  if (patch.seconds !== undefined) put("seconds", patch.seconds);
  if (patch.providerTask !== undefined) put("provider_task", patch.providerTask);
  if (patch.clipFile !== undefined) put("clip_file", patch.clipFile);
  if (patch.costUsd !== undefined) put("cost_usd", patch.costUsd);
  if (patch.error !== undefined) put("error", patch.error);
  if (!sets.length) return;

  db.prepare(`UPDATE avatar_segments SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

/** Segment rows with their on-disk paths — the pipeline needs the files, not URLs. */
export function segmentRows(videoId: string): Array<AvatarSegment & { audioFile: string | null; clipFile: string | null }> {
  return (db.prepare("SELECT * FROM avatar_segments WHERE video_id = ? ORDER BY idx").all(videoId) as any[]).map((r) => ({
    ...rowToSegment(r),
    audioFile: r.audio_file ?? null,
    clipFile: r.clip_file ?? null,
  }));
}

/** Total spend across every run — shown in the UI so cost stays visible. */
export function totalSpendUsd(): number {
  const r = db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM avatar_videos").get() as any;
  return r?.total ?? 0;
}
