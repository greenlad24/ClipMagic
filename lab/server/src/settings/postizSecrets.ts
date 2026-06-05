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

/** (Re)write the shared env file from the FULL stored set (0600). */
function writeEnvFile(map: SecretMap): { written: boolean; reason?: string } {
  const lines = [
    "# Postiz keys managed by the ClipMagic suite Settings page — DO NOT EDIT BY HAND.",
    "# This file is sourced by the Postiz container's entrypoint at startup and",
    "# overrides the compose `environment:` defaults. Regenerated on every save.",
    ...POSTIZ_KEY_DEFS.filter((d) => map[d.key]).map((d) => envLine(d.key, map[d.key]!)),
    "",
  ];
  try {
    fs.mkdirSync(POSTIZ_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(ENV_FILE_PATH, lines.join("\n"), { mode: 0o600 });
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
  return [
    "# Postiz keys managed by the ClipMagic suite Settings page — DO NOT EDIT BY HAND.",
    "# This file is sourced by the Postiz container's entrypoint at startup and",
    "# overrides the compose `environment:` defaults. Regenerated on every save.",
    ...POSTIZ_KEY_DEFS.filter((d) => map[d.key]).map((d) => envLine(d.key, map[d.key]!)),
    "",
  ].join("\n");
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
