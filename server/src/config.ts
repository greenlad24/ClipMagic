import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Central configuration. Everything is overridable via environment variables so
 * the same build runs on a laptop or a droplet with no code edits. Values are
 * read from the process environment; `npm run dev` loads a local `.env` first
 * (see index.ts), and `.env.example` documents every key.
 */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Root for all persisted data. In Docker this is a mounted volume. */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(SERVER_ROOT, "..", "data");

export const config = {
  port: envInt("PORT", 8080),
  host: process.env.HOST || "0.0.0.0",

  serverRoot: SERVER_ROOT,
  dataDir: DATA_DIR,
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, "db", "avatar.db"),

  /**
   * Scratch space. Holds the per-chunk TTS working files and any video a
   * provider returns synchronously as a response body rather than a URL. Safe
   * to delete when nothing is rendering.
   */
  tmpDir: process.env.TMP_DIR || path.join(DATA_DIR, "tmp"),

  /**
   * The persona library — locked portraits, character sheets, generated
   * narration audio and the finished talking-head MP4s. Served read-only at
   * /api/avatar/<file>.
   */
  avatarDir: process.env.AVATAR_DIR || path.join(DATA_DIR, "avatar"),

  /**
   * PUBLIC, UNAUTHENTICATED asset drop, and it exists for a single reason: the
   * avatar/lipsync APIs (kie.ai, WaveSpeed, Segmind) take the portrait and the
   * narration as URLs they fetch THEMSELVES, with their own HTTP client.
   *
   * The protection is unguessability: every file lands under a 32-hex-char
   * random token directory (128 bits) and is pruned after `publicAssetTtlMs`.
   * Only ever put provider INPUTS here — a portrait and a TTS clip that are
   * about to become a video anyway. Never anything else. See
   * avatar/publicAssets.ts.
   */
  publicAssetsDir: process.env.PUBLIC_ASSETS_DIR || path.join(DATA_DIR, "public-assets"),
  publicAssetTtlMs: envInt("PUBLIC_ASSET_TTL_MS", 24 * 60 * 60 * 1000),

  /**
   * Absolute, publicly reachable origin of THIS server, e.g.
   * https://avatar.example.com. Required before any render can run: it is what
   * the capability URLs above are built from, and a provider cannot fetch
   * `localhost`. For local development, expose the port with a tunnel
   * (cloudflared / ngrok) and put that hostname here.
   */
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",

  /** Built Vite frontend, served by this process so one origin answers UI + API. */
  frontendDir: process.env.FRONTEND_DIR || path.resolve(SERVER_ROOT, "..", "web", "dist"),

  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
};

export function ensureDirs(): void {
  for (const dir of [
    config.dataDir,
    config.avatarDir,
    config.tmpDir,
    config.publicAssetsDir,
    path.dirname(config.dbPath),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
