import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { config } from "../config.js";

/**
 * Write-only secrets store for the Postiz social-poster container.
 *
 * Postiz is a SEPARATE container that reads its configuration from environment
 * variables at startup. To let the suite manage those keys from the UI without
 * ever exposing them again, this module:
 *
 *   1. Persists the keys to the lab's own data dir as 0600 JSON
 *      (`<dataDir>/postiz-settings.json`) so they survive restarts. This file is
 *      git-ignored and NEVER committed.
 *   2. Re-writes a shared env file (`/postiz-config/postiz.env`, the
 *      `postiz-config` volume mounted into both the suite and Postiz) from the
 *      full stored set on every save. The Postiz container's entrypoint sources
 *      this file LAST at startup, so these values override the compose defaults.
 *   3. Restarts the Postiz container via the Docker Engine API (unix socket) so
 *      the new keys take effect with one click.
 *
 * WRITE-ONLY GUARANTEE: no function here returns a secret value. `getSettings`
 * reports only `configured: boolean` per key. Values are never logged.
 */

// ── Key registry (single source of truth) ───────────────────────────────────
// Grouped by what each key connects. `group` drives the UI sections; `connects`
// is the human label shown under each field.
export interface PostizKeyDef {
  key: string;
  label: string;
  group: string;
  /** Short hint: what configuring this enables. */
  connects: string;
}

export const POSTIZ_KEY_DEFS: PostizKeyDef[] = [
  // ── Core Postiz config ─────────────────────────────────────────────────────
  { key: "POSTIZ_JWT_SECRET", label: "JWT secret", group: "Postiz core", connects: "Signs Postiz login sessions. A long random string, unique per install (openssl rand -hex 32). Required for Postiz to run." },
  { key: "POSTIZ_URL", label: "Public URL", group: "Postiz core", connects: "The origin the browser uses to reach Postiz (e.g. https://social.example.com). Drives Postiz's MAIN_URL / FRONTEND_URL and the OAuth callbacks." },
  { key: "POSTIZ_POSTGRES_PASSWORD", label: "Postgres password", group: "Postiz core", connects: "Password for Postiz's database. Change it for anything internet-facing." },
  { key: "POSTIZ_DISABLE_REGISTRATION", label: "Disable registration", group: "Postiz core", connects: "Set to true after creating your account to lock down new sign-ups." },

  // ── Bulk Scheduler (this LAB tool calls Postiz's public API directly) ────────
  // Unlike every other key here — which is Postiz's OWN container config, re-emitted
  // into the shared env file Postiz sources at boot — this one is used BY THE LAB
  // SERVER ITSELF to authenticate to Postiz's /public/v1 API (to push scheduled
  // posts). It is therefore NOT emitted into the Postiz env file (buildEnvFileContents
  // skips it below); it's read internally via getPostizApiKey(). Same write-only
  // guarantee as the rest: never returned through any HTTP response.
  { key: "POSTIZ_API_KEY", label: "Postiz API key", group: "Bulk Scheduler", connects: "Lets the Bulk Scheduler push SEO-optimized, scheduled posts into Postiz via its public API. Create it in Postiz under Settings → Developers → Public API, then paste it here. Used only by this lab server — never sent to the browser." },
  // PostPeer is the SECOND Bulk Scheduler posting provider — a pre-approved
  // TikTok Direct Post API. Like POSTIZ_API_KEY it is consumed by THIS lab
  // server (postiz/postpeerClient.ts) to authenticate to PostPeer's public API,
  // NOT by the Postiz container — so it's excluded from the Postiz env file
  // (buildEnvFileContents skips it below) and read internally via
  // getPostPeerApiKey(). Same write-only guarantee: never returned via any HTTP response.
  { key: "POSTPEER_API_KEY", label: "PostPeer API key", group: "Bulk Scheduler", connects: "Lets the Bulk Scheduler post your Shorts to TikTok via PostPeer's pre-approved Direct Post API (no TikTok app review). Create the key in your PostPeer dashboard, connect a TikTok account there, then paste it here. Used only by this lab server — never sent to the browser." },

  // ── Cloud sources (browse + pick videos from a Drive/Dropbox FOLDER) ─────────
  // Like POSTIZ_API_KEY / POSTPEER_API_KEY these are consumed by THIS lab server
  // (postiz/cloudSources.ts) to LIST a cloud folder and resolve each video to a
  // direct media URL — they are NOT Postiz container config, so they're excluded
  // from the Postiz env file (buildEnvFileContents skips them below) and read
  // internally via getGoogleDriveApiKey() / getDropboxCredentials(). Same
  // write-only guarantee as the rest: never returned through any HTTP response.
  { key: "GOOGLE_DRIVE_API_KEY", label: "Google Drive API key", group: "Cloud sources", connects: "Lets the Bulk Scheduler browse a PUBLIC (\"anyone with the link\") Google Drive folder and pick videos from it. Create an API key in Google Cloud Console (enable the Drive API), then paste it here. Used only for listing — each picked file is fetched via its own direct download URL. Server-only; never sent to the browser." },
  { key: "DROPBOX_APP_KEY", label: "Dropbox app key", group: "Cloud sources", connects: "App key for your Dropbox app (App Console → your app → Settings). Used with the app secret + refresh token to browse a Dropbox folder and pick videos. Server-only; never sent to the browser." },
  { key: "DROPBOX_APP_SECRET", label: "Dropbox app secret", group: "Cloud sources", connects: "App secret for your Dropbox app (App Console → your app → Settings). Paired with the app key to mint a short-lived access token from your refresh token. Server-only; never sent to the browser." },
  { key: "DROPBOX_REFRESH_TOKEN", label: "Dropbox refresh token", group: "Cloud sources", connects: "Long-lived OAuth refresh token for your Dropbox account (generate once with the offline-access flow). The lab exchanges it for short-lived access tokens to list folders + mint temporary download links. Server-only; never sent to the browser." },

  // ── Per-platform OAuth app credentials ──────────────────────────────────────
  { key: "X_API_KEY", label: "X API key", group: "X (Twitter)", connects: "Connects X (Twitter) accounts for posting." },
  { key: "X_API_SECRET", label: "X API secret", group: "X (Twitter)", connects: "Connects X (Twitter) accounts for posting." },

  { key: "LINKEDIN_CLIENT_ID", label: "LinkedIn client ID", group: "LinkedIn", connects: "Connects LinkedIn accounts and pages." },
  { key: "LINKEDIN_CLIENT_SECRET", label: "LinkedIn client secret", group: "LinkedIn", connects: "Connects LinkedIn accounts and pages." },

  { key: "REDDIT_CLIENT_ID", label: "Reddit client ID", group: "Reddit", connects: "Connects Reddit accounts for posting to subreddits." },
  { key: "REDDIT_CLIENT_SECRET", label: "Reddit client secret", group: "Reddit", connects: "Connects Reddit accounts for posting to subreddits." },

  { key: "GITHUB_CLIENT_ID", label: "GitHub client ID", group: "GitHub", connects: "Connects GitHub for activity posts." },
  { key: "GITHUB_CLIENT_SECRET", label: "GitHub client secret", group: "GitHub", connects: "Connects GitHub for activity posts." },

  { key: "FACEBOOK_APP_ID", label: "Facebook app ID", group: "Facebook / Instagram", connects: "Connects Facebook Pages and Instagram business accounts." },
  { key: "FACEBOOK_APP_SECRET", label: "Facebook app secret", group: "Facebook / Instagram", connects: "Connects Facebook Pages and Instagram business accounts." },

  { key: "YOUTUBE_CLIENT_ID", label: "YouTube client ID", group: "YouTube", connects: "Connects YouTube channels for uploads/Shorts." },
  { key: "YOUTUBE_CLIENT_SECRET", label: "YouTube client secret", group: "YouTube", connects: "Connects YouTube channels for uploads/Shorts." },

  { key: "TIKTOK_CLIENT_ID", label: "TikTok client ID", group: "TikTok", connects: "Connects TikTok accounts for posting." },
  { key: "TIKTOK_CLIENT_SECRET", label: "TikTok client secret", group: "TikTok", connects: "Connects TikTok accounts for posting." },

  { key: "PINTEREST_CLIENT_ID", label: "Pinterest client ID", group: "Pinterest", connects: "Connects Pinterest boards for pins." },
  { key: "PINTEREST_CLIENT_SECRET", label: "Pinterest client secret", group: "Pinterest", connects: "Connects Pinterest boards for pins." },

  { key: "THREADS_APP_ID", label: "Threads app ID", group: "Threads", connects: "Connects Threads accounts for posting." },
  { key: "THREADS_APP_SECRET", label: "Threads app secret", group: "Threads", connects: "Connects Threads accounts for posting." },

  { key: "DISCORD_CLIENT_ID", label: "Discord client ID", group: "Discord", connects: "Connects Discord servers/channels for posting." },
  { key: "DISCORD_CLIENT_SECRET", label: "Discord client secret", group: "Discord", connects: "Connects Discord servers/channels for posting." },

  { key: "SLACK_ID", label: "Slack client ID", group: "Slack", connects: "Connects Slack workspaces for posting." },
  { key: "SLACK_SECRET", label: "Slack client secret", group: "Slack", connects: "Connects Slack workspaces for posting." },

  { key: "MASTODON_CLIENT_ID", label: "Mastodon client ID", group: "Mastodon", connects: "Connects a Mastodon instance for posting." },
  { key: "MASTODON_CLIENT_SECRET", label: "Mastodon client secret", group: "Mastodon", connects: "Connects a Mastodon instance for posting." },

  { key: "TELEGRAM_TOKEN", label: "Telegram bot token", group: "Telegram", connects: "Connects a Telegram bot for posting to channels." },
];

const ALLOWED_KEYS = new Set(POSTIZ_KEY_DEFS.map((d) => d.key));

/**
 * Keys consumed by THIS lab server (never by the Postiz container), so they're
 * EXCLUDED from the emitted Postiz env file: the Bulk Scheduler's posting-provider
 * keys (Postiz / PostPeer public APIs) and the Cloud sources credentials
 * (Drive / Dropbox folder browsing). Read internally via the server-only getters.
 */
const LAB_ONLY_KEYS = new Set([
  "POSTIZ_API_KEY",
  "POSTPEER_API_KEY",
  "GOOGLE_DRIVE_API_KEY",
  "DROPBOX_APP_KEY",
  "DROPBOX_APP_SECRET",
  "DROPBOX_REFRESH_TOKEN",
]);

// ── Paths ────────────────────────────────────────────────────────────────────
/** 0600 JSON store inside the lab's own (isolated, git-ignored) data dir. */
const STORE_PATH = path.join(config.dataDir, "postiz-settings.json");
/**
 * The shared env file Postiz sources at startup. The `postiz-config` volume is
 * mounted at /postiz-config in the suite container and /config in Postiz, so the
 * suite writes here and Postiz reads it (the entrypoint sources /config/postiz.env).
 * Overridable for local dev / tests via POSTIZ_CONFIG_DIR.
 */
const POSTIZ_CONFIG_DIR = process.env.POSTIZ_CONFIG_DIR || "/postiz-config";
const ENV_FILE_PATH = path.join(POSTIZ_CONFIG_DIR, "postiz.env");

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

// ── Persistence (0600, never returns values) ─────────────────────────────────
type SecretMap = Record<string, string>;

function readStore(): SecretMap {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      // Keep only known keys with string values.
      const out: SecretMap = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (ALLOWED_KEYS.has(k) && typeof v === "string" && v.length > 0) out[k] = v;
      }
      return out;
    }
  } catch {
    /* missing or corrupt → empty */
  }
  return {};
}

function writeStore(map: SecretMap): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  // Write 0600 so secrets aren't world-readable on the shared volume.
  fs.writeFileSync(STORE_PATH, JSON.stringify(map, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(STORE_PATH, 0o600);
  } catch {
    /* best-effort on filesystems that don't support chmod */
  }
}

/** Escape a value for safe `KEY=value` sourcing via `sh`'s `. file`. */
function envLine(key: string, value: string): string {
  // Single-quote and escape embedded single quotes so `set -a; . file` is safe
  // for any value (spaces, $, etc.). 'it'\''s' is the standard sh idiom.
  const escaped = value.replace(/'/g, `'\\''`);
  return `${key}='${escaped}'`;
}

/**
 * Map the suite's friendly POSTIZ_* core keys onto the *native* env var names
 * Postiz actually reads.
 *
 * This is essential, not cosmetic: compose bakes MAIN_URL / FRONTEND_URL /
 * NEXT_PUBLIC_BACKEND_URL / JWT_SECRET / DISABLE_REGISTRATION from the root .env
 * at `up` time (defaulting to http://localhost:5000), and Postiz never reads
 * "POSTIZ_URL" / "POSTIZ_JWT_SECRET". So emitting only the POSTIZ_* names is a
 * no-op — the UI value would silently never apply (the frontend keeps calling
 * localhost:5000). We therefore emit the native names here; the entrypoint
 * sources this file last, so these override the compose defaults.
 */
function nativeOverrides(map: SecretMap): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const url = map.POSTIZ_URL?.trim().replace(/\/+$/, ""); // strip trailing slash(es)
  if (url) {
    out.push(["MAIN_URL", url]);
    out.push(["FRONTEND_URL", url]);
    out.push(["NEXT_PUBLIC_BACKEND_URL", `${url}/api`]);
  }
  if (map.POSTIZ_JWT_SECRET) out.push(["JWT_SECRET", map.POSTIZ_JWT_SECRET]);
  if (map.POSTIZ_DISABLE_REGISTRATION) {
    out.push(["DISABLE_REGISTRATION", map.POSTIZ_DISABLE_REGISTRATION]);
  }
  // NOTE: POSTIZ_POSTGRES_PASSWORD is intentionally NOT translated to DATABASE_URL.
  // The Postgres container is initialized with the compose-time password; changing
  // only DATABASE_URL here would break the live DB connection. The DB password is a
  // provisioning concern (root .env at first `up`), not a hot-swappable UI value.
  return out;
}

/** (Re)write the shared env file from the FULL stored set (0600). */
function writeEnvFile(map: SecretMap): { written: boolean; reason?: string } {
  try {
    fs.mkdirSync(POSTIZ_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(ENV_FILE_PATH, buildEnvFileContents(map), { mode: 0o600 });
    try {
      fs.chmodSync(ENV_FILE_PATH, 0o600);
    } catch {
      /* best-effort */
    }
    return { written: true };
  } catch (e) {
    // The shared volume may not be mounted during local (non-Docker) dev.
    return { written: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// Exported for the env-file generation unit test.
export function buildEnvFileContents(map: SecretMap): string {
  const lines: string[] = [
    "# Postiz keys managed by the ClipMagic suite Settings page — DO NOT EDIT BY HAND.",
    "# This file is sourced by the Postiz container's entrypoint at startup and",
    "# overrides the compose `environment:` defaults. Regenerated on every save.",
    // Emit Postiz's OWN config keys only. The Bulk Scheduler / Cloud sources keys
    // (POSTIZ_API_KEY, POSTPEER_API_KEY, and the Drive/Dropbox credentials) are
    // consumed by THIS lab server, not by the Postiz container, so they must
    // never leak into Postiz's env file.
    ...POSTIZ_KEY_DEFS.filter((d) => !LAB_ONLY_KEYS.has(d.key) && map[d.key]).map((d) =>
      envLine(d.key, map[d.key]!),
    ),
  ];
  // The names Postiz ACTUALLY reads, derived from the friendly POSTIZ_* keys.
  // Without these the UI values never take effect (see nativeOverrides).
  const native = nativeOverrides(map);
  if (native.length) {
    lines.push("# Derived Postiz-native vars (what Postiz actually reads):");
    for (const [k, v] of native) lines.push(envLine(k, v));
  }
  lines.push("");
  return lines.join("\n");
}

// ── Public API (write-only) ──────────────────────────────────────────────────
export interface PostizKeyState {
  key: string;
  label: string;
  group: string;
  connects: string;
  configured: boolean;
}

/** Per-key configured-state (NO values) + whether the env file is writable. */
export function getSettings(): {
  keys: PostizKeyState[];
  envFileWritable: boolean;
} {
  const map = readStore();
  return {
    keys: POSTIZ_KEY_DEFS.map((d) => ({
      key: d.key,
      label: d.label,
      group: d.group,
      connects: d.connects,
      configured: !!map[d.key],
    })),
    envFileWritable: canWriteConfigDir(),
  };
}

/**
 * INTERNAL, SERVER-ONLY getter for the Postiz public-API key.
 *
 * This is the ONE deliberate read of a stored secret value — used by the Bulk
 * Scheduler's Postiz client (server/src/postiz/client.ts) to authenticate to
 * Postiz's /public/v1 API. It must NEVER be wired into an HTTP handler or any
 * response body; doing so would break the write-only guarantee. Returns the raw
 * value, or null when not configured. An env var (POSTIZ_API_KEY) takes
 * precedence so a server-managed deployment can inject it without the UI.
 */
export function getPostizApiKey(): string | null {
  const fromEnv = (process.env.POSTIZ_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.POSTIZ_API_KEY || null;
}

/**
 * INTERNAL, SERVER-ONLY getter for the PostPeer public-API key — the exact twin
 * of getPostizApiKey() for the Bulk Scheduler's PostPeer (TikTok Direct Post)
 * provider. Used by server/src/postiz/postpeerClient.ts to authenticate; it must
 * NEVER be wired into an HTTP handler or response body (write-only guarantee).
 * An env var (POSTPEER_API_KEY) takes precedence over the UI-managed store.
 */
export function getPostPeerApiKey(): string | null {
  const fromEnv = (process.env.POSTPEER_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.POSTPEER_API_KEY || null;
}

/**
 * INTERNAL, SERVER-ONLY getter for the Google Drive API key — used by
 * postiz/cloudSources.ts to LIST a public ("anyone with link") Drive folder.
 * Like the Postiz/PostPeer keys it must NEVER be wired into an HTTP response
 * (write-only guarantee). An env var (GOOGLE_DRIVE_API_KEY) takes precedence.
 */
export function getGoogleDriveApiKey(): string | null {
  const fromEnv = (process.env.GOOGLE_DRIVE_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.GOOGLE_DRIVE_API_KEY || null;
}

/** A configured set of Dropbox app credentials (all three required). */
export interface DropboxCredentials {
  appKey: string;
  appSecret: string;
  refreshToken: string;
}

/**
 * INTERNAL, SERVER-ONLY getter for the Dropbox app credentials — used by
 * postiz/cloudSources.ts to mint short-lived access tokens (from the refresh
 * token) for listing folders + minting temporary download links. Returns null
 * unless ALL THREE are configured. Env vars take precedence over the store.
 * Must NEVER be wired into an HTTP response (write-only guarantee).
 */
export function getDropboxCredentials(): DropboxCredentials | null {
  const map = readStore();
  const pick = (key: string) => (process.env[key] || "").trim() || map[key] || "";
  const appKey = pick("DROPBOX_APP_KEY");
  const appSecret = pick("DROPBOX_APP_SECRET");
  const refreshToken = pick("DROPBOX_REFRESH_TOKEN");
  if (!appKey || !appSecret || !refreshToken) return null;
  return { appKey, appSecret, refreshToken };
}

function canWriteConfigDir(): boolean {
  try {
    fs.mkdirSync(POSTIZ_CONFIG_DIR, { recursive: true });
    fs.accessSync(POSTIZ_CONFIG_DIR, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply an update map. Rules:
 *   - A key with a non-empty string value is SET.
 *   - A key whose value is `null` (or `""` when `remove` lists it) is REMOVED.
 *   - A key absent from the input, or empty-string and not in `remove`, is
 *     LEFT UNCHANGED (empty = unchanged, so a blank field never wipes a key).
 * Persists the store (0600) and rewrites the shared env file. Returns
 * configured-state only — never a value.
 */
export function updateSettings(input: {
  values?: Record<string, unknown>;
  remove?: string[];
}): { keys: PostizKeyState[]; envFileWritable: boolean; envWriteError?: string } {
  const map = readStore();
  const values = input.values ?? {};
  const remove = new Set(input.remove ?? []);

  for (const [k, v] of Object.entries(values)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (v === null) {
      delete map[k];
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) {
        map[k] = trimmed;
      }
      // empty string = unchanged (do nothing)
    }
  }
  for (const k of remove) {
    if (ALLOWED_KEYS.has(k)) delete map[k];
  }

  writeStore(map);
  const env = writeEnvFile(map);

  const state = getSettings();
  return {
    keys: state.keys,
    envFileWritable: env.written || state.envFileWritable,
    ...(env.written ? {} : { envWriteError: env.reason }),
  };
}

// ── Docker Engine API over the unix socket (restart Postiz) ──────────────────
function dockerRequest(
  method: string,
  pathName: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, method, path: pathName, timeout: 15_000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Docker socket request timed out")));
    req.end();
  });
}

/**
 * Restart the Postiz container so it re-sources the updated env file. Finds the
 * container by its compose service label, then POSTs /restart. Handles a missing
 * socket / stopped Postiz gracefully with a clear, non-leaking message.
 */
export async function restartPostiz(): Promise<{ success: boolean; message: string }> {
  if (!fs.existsSync(DOCKER_SOCKET)) {
    return {
      success: false,
      message:
        "Docker socket not available — can't restart Postiz from here. Restart it on the server: docker compose --profile postiz restart postiz",
    };
  }

  let list: { status: number; body: string };
  try {
    const filters = encodeURIComponent(
      JSON.stringify({ label: ["com.docker.compose.service=postiz"] }),
    );
    list = await dockerRequest("GET", `/containers/json?all=true&filters=${filters}`);
  } catch (e) {
    return {
      success: false,
      message: `Couldn't reach the Docker socket: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (list.status !== 200) {
    return { success: false, message: `Docker API returned ${list.status} listing containers.` };
  }

  let containers: Array<{ Id: string; State?: string }>;
  try {
    containers = JSON.parse(list.body);
  } catch {
    return { success: false, message: "Couldn't parse the Docker API response." };
  }

  if (!Array.isArray(containers) || containers.length === 0) {
    return {
      success: false,
      message:
        "Postiz container isn't running. Start it on the server (docker compose --profile postiz up -d), then your saved keys will apply.",
    };
  }

  const target = containers[0]!;
  try {
    const r = await dockerRequest("POST", `/containers/${target.Id}/restart?t=10`);
    if (r.status === 204) {
      return { success: true, message: "Postiz is restarting — your keys will be live in a few seconds." };
    }
    return { success: false, message: `Docker API returned ${r.status} on restart.` };
  } catch (e) {
    return {
      success: false,
      message: `Restart request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Whether the Docker socket is present (UI badge). */
export function dockerSocketAvailable(): boolean {
  try {
    return fs.existsSync(DOCKER_SOCKET);
  } catch {
    return false;
  }
}
