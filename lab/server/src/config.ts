import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Central configuration. Everything is overridable via environment variables so
 * the same build runs on a laptop or a DigitalOcean droplet with no code edits.
 */
// Resolve the server root from import.meta.url when available. The AI pipeline
// is bundled by esbuild (CJS), where import.meta is stripped; fall back to an
// env override or cwd so the bundle never crashes at load. SERVER_ROOT only
// affects font/frontend defaults, which the bundle never uses (its data paths
// come from DATA_DIR), so the fallback is harmless there.
function resolveServerRoot(): string {
  try {
    const u = (import.meta as { url?: string }).url;
    if (u) return path.resolve(path.dirname(fileURLToPath(u)), "..");
  } catch {
    /* bundled as CJS — import.meta unavailable */
  }
  return process.env.SERVER_ROOT || process.cwd();
}
const SERVER_ROOT = resolveServerRoot();

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
   * AI Image Generator history. Each generated image is written here as
   * <id>.<ext> and served read-only at /api/image-history/<id>.<ext> (behind the
   * auth gate, like the thumbnail libraries). Metadata lives in the image_history
   * DB table.
   */
  imageHistoryDir: process.env.IMAGE_HISTORY_DIR || path.join(DATA_DIR, "image-history"),

  /**
   * Where Remotion caches the Chromium it may download. In Docker this is
   * REMOTION_BROWSER_CACHE_DIR=/data/.remotion-chromium. With a pre-baked
   * Chromium (remotionBrowserExecutable) it stays empty, but an old run may
   * have left a downloaded browser here — surfaced in Storage so it can be
   * reclaimed. Defaults under DATA_DIR so the Storage manager can locate it.
   */
  remotionBrowserCacheDir:
    process.env.REMOTION_BROWSER_CACHE_DIR || path.join(DATA_DIR, ".remotion-chromium"),

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

  // ── Google Sign-In auth gate (Engagement Manager + whole-app protection) ────
  /**
   * Google OAuth 2.0 "Web application" client used to LOG IN to the whole lab.
   * When BOTH the client id/secret AND a session secret are set, a global
   * middleware requires a valid Google session whose verified email is in
   * `authAllowedEmails`; every other request is redirected to sign-in (documents)
   * or 401'd (XHR). When unset the gate is a PASS-THROUGH (loudly logged at boot)
   * so the existing open deployment is never broken before creds are provisioned
   * — mirrors the `apiToken`-empty-is-open convention above.
   */
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  /** HMAC key that signs the session cookie. Any long random string. */
  sessionSecret: process.env.SESSION_SECRET || "",
  /**
   * Exact redirect URI registered on the Google OAuth client, e.g.
   * `https://<LAB_DOMAIN>/auth/callback`. If empty it is derived from
   * PUBLIC_BASE_URL + "/auth/callback".
   */
  oauthRedirectUrl: process.env.OAUTH_REDIRECT_URL || "",
  /**
   * Comma-separated allow-list of Google emails permitted into the app. Anyone
   * else — even with a valid Google login — gets a hard 403. Defaults to the two
   * authorized operators.
   */
  authAllowedEmails: (process.env.ALLOWED_EMAILS ||
    "jakedawsonbusiness@gmail.com,keith.graham244@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  /** Session cookie lifetime (days). */
  sessionTtlDays: envInt("SESSION_TTL_DAYS", 7),

  /** Public base URL used to build absolute links to outputs/uploads. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",

  /** Render job retry attempts before marking failed. */
  jobAttempts: envInt("JOB_ATTEMPTS", 2),

  // ── Motion graphics (Remotion) ──────────────────────────────────────────────
  /**
   * Default ON. Short-form motion graphics now run by default — the director
   * plans tasteful overlays and the render step composites them — controlled
   * per-video by a UI toggle (default on) rather than a global env flag. Even
   * when on, every stage falls back gracefully if Remotion/Chromium is missing.
   *
   * ESCAPE HATCH: set MOTION_GRAPHICS=0 to FORCE-DISABLE globally (e.g. for
   * resource control on a tiny box) regardless of the per-video toggle. Any
   * other value (including unset) leaves the default-on behavior intact.
   */
  motionGraphicsForceDisabled: (process.env.MOTION_GRAPHICS || "") === "0",

  // ── Auto-Screencast (headless Chromium capture) ─────────────────────────────
  /**
   * Default ON. The AI director already decides screencast moments (Pending
   * Screencast shots with a researched targetUrl); the capture engine records
   * those real sites automatically inside the generation pipeline, controlled
   * per-video by a UI toggle (default on) — mirroring the motion-graphics toggle.
   *
   * ESCAPE HATCH: set SCREENCAST_DISABLED=1 to FORCE-DISABLE globally (e.g. for
   * resource control on a tiny box) regardless of the per-video toggle. Even when
   * on, capture falls back gracefully when Chromium is absent or a site fails.
   */
  autoScreencastDisabled: (process.env.SCREENCAST_DISABLED || "") === "1",
  /**
   * Max NEW AI-planned screencast moments per video (existing director-created
   * Pending Screencast shots are always attempted). Keeps the inline capture step
   * bounded so generation never stalls. SCREENCAST_MAX_MOMENTS overrides.
   */
  autoScreencastMaxMoments: envInt("SCREENCAST_MAX_MOMENTS", 3),
  /**
   * Overall wall-clock budget (ms) for the automatic in-pipeline screencast step.
   * The render reads captureStatus/clipUrl, so captures run INLINE before the
   * manifest is built; this ceiling guarantees a hung site can never stall
   * generation forever. Once exceeded, remaining moments are abandoned and left
   * Pending — handled exactly as before (promo retrieval / talking-head fallback).
   */
  autoScreencastBudgetMs: envInt("SCREENCAST_BUDGET_MS", 90_000),
  /**
   * Pre-baked Chromium executable for Remotion. In the Docker image this is set
   * to the apt-installed /usr/bin/chromium so Remotion NEVER needs a runtime
   * download (the server's network may block Remotion's Chromium CDN — the real
   * reliability risk). When empty, Remotion falls back to its own ensureBrowser
   * download path (fine for local dev with network). Passed through to
   * openBrowser/selectComposition/renderMedia as `browserExecutable`.
   */
  remotionBrowserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE || "",
  /**
   * How many Remotion (headless-Chromium) renders may run at once across the
   * whole process. Each browser render is RAM- and CPU-heavy and competes with
   * ffmpeg on a 4 vCPU / 8 GB droplet, so this is deliberately tiny (default 1).
   */
  motionConcurrency: Math.max(1, envInt("MOTION_CONCURRENCY", 1)),
  /**
   * Per-Remotion-render Chromium concurrency (tabs/threads). 2 keeps a single
   * graphic render from monopolizing the box while ffmpeg jobs also run.
   */
  motionChromiumConcurrency: Math.max(1, envInt("MOTION_CHROMIUM_CONCURRENCY", 2)),
  /** Built Remotion bundle dir (created on first render, cached thereafter). */
  motionBundleDir: process.env.MOTION_BUNDLE_DIR || path.join(DATA_DIR, "motion-bundle"),
  /** Remotion project entry (the React Root that registers the compositions). */
  motionEntryPoint:
    process.env.MOTION_ENTRY_POINT ||
    path.resolve(SERVER_ROOT, "..", "remotion", "src", "index.ts"),
};

/**
 * The Google Sign-In gate is ACTIVE only when the OAuth client and a session
 * secret are all present. Otherwise the app stays open (legacy behavior) and the
 * middleware is a pass-through — logged loudly at boot.
 */
export function authConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret && config.sessionSecret);
}

/** The redirect URI registered on the Google client (explicit or derived). */
export function oauthRedirectUri(): string {
  if (config.oauthRedirectUrl) return config.oauthRedirectUrl;
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "") + "/auth/callback";
  return "";
}

export function ensureDirs(): void {
  for (const dir of [
    config.dataDir,
    config.uploadsDir,
    config.outputsDir,
    config.tmpDir,
    config.imageHistoryDir,
    path.dirname(config.dbPath),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
