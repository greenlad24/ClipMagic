import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Central configuration. Everything is overridable via environment variables so
 * the same build runs on a laptop or a DigitalOcean droplet with no code edits.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/ root (one level up from src/, or from dist/ after build)
const SERVER_ROOT = path.resolve(__dirname, "..");

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Root for all persisted data. In Docker this is a mounted volume.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(SERVER_ROOT, "..", "data");

export const config = {
  port: envInt("PORT", 8080),
  host: process.env.HOST || "0.0.0.0",

  serverRoot: SERVER_ROOT,
  dataDir: DATA_DIR,
  uploadsDir: process.env.UPLOADS_DIR || path.join(DATA_DIR, "uploads"),
  outputsDir: process.env.OUTPUTS_DIR || path.join(DATA_DIR, "outputs"),
  tmpDir: process.env.TMP_DIR || path.join(DATA_DIR, "tmp"),
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, "db", "clipmagic.db"),

  /**
   * Built Vite frontend (the full ClipMagic React app), served by this server
   * so one process answers UI + API. Built from /web into /web/dist.
   */
  frontendDir: process.env.FRONTEND_DIR || path.resolve(SERVER_ROOT, "..", "web", "dist"),

  /**
   * How many FFmpeg renders run in parallel. Defaults to the CPU count: FFmpeg
   * is already multi-threaded per job, so going much above vCPUs hurts overall
   * throughput. This is the knob that lets a droplet chew through 300+ jobs.
   */
  renderConcurrency: envInt("RENDER_CONCURRENCY", Math.max(1, os.cpus().length)),

  /**
   * Upload size cap in bytes. 0 = unlimited — this is what removes the old
   * 25MB ceiling. Default 5GB as a safety valve; set MAX_UPLOAD_BYTES=0 to lift.
   */
  maxUploadBytes: envInt("MAX_UPLOAD_BYTES", 5 * 1024 * 1024 * 1024),

  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",

  /** Default font for burned-in subtitles (drawtext). */
  fontFile:
    process.env.FONT_FILE || path.join(SERVER_ROOT, "assets", "fonts", "DejaVuSans-Bold.ttf"),

  /**
   * Optional shared secret. When set, /api and /v1 require
   * `Authorization: Bearer <token>` or `X-API-KEY: <token>`. Empty = open
   * (fine for a single-user, firewalled droplet).
   */
  apiToken: process.env.API_TOKEN || "",

  /** Public base URL used to build absolute links to outputs/uploads. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",

  /** Render job retry attempts before marking failed. */
  jobAttempts: envInt("JOB_ATTEMPTS", 2),
};

export function ensureDirs(): void {
  for (const dir of [
    config.dataDir,
    config.uploadsDir,
    config.outputsDir,
    config.tmpDir,
    path.dirname(config.dbPath),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
