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

  // ── Thumbnail Designer (LAB tool — recreate top YouTube thumbnails) ──────────
  // Both keys are consumed by THIS lab server (thumbnails/nanoBanana.ts +
  // thumbnails/youtube.ts), NOT by the Postiz container — so they're excluded
  // from the Postiz env file (buildEnvFileContents skips LAB_ONLY_KEYS) and read
  // internally via getGeminiApiKey() / getYoutubeDataApiKey(). Same write-only
  // guarantee as the rest: never returned through any HTTP response.
  { key: "GEMINI_API_KEY", label: "Gemini API key", group: "Thumbnail Designer", connects: "Powers the Thumbnail Designer's Nano Banana editing chain (Gemini 2.5 Flash Image AND Nano Banana Pro / Gemini 3 Pro Image) that recreates a top thumbnail with your character. Create a key in Google AI Studio (aistudio.google.com/apikey), then paste it here. Used only by this lab server — never sent to the browser." },
  { key: "YOUTUBE_DATA_API_KEY", label: "YouTube Data API key", group: "Thumbnail Designer", connects: "Lets the Thumbnail Designer search YouTube for the top-performing thumbnails for a keyword. Create an API key in Google Cloud Console (enable the YouTube Data API v3), then paste it here. Used only for search — server-only; never sent to the browser." },

  // ── Avatar Narrator (LAB tool — synthetic-presenter talking-head videos) ────
  // ONE key by design. Segmind hosts both halves of the tool — Seedance 2.5 for
  // the video and ElevenLabs for the voice and its cloning — so the alternative
  // engines (kie.ai InfiniteTalk, WaveSpeed, Higgsfield, a self-hosted worker)
  // and the direct ElevenLabs account were removed from this registry on
  // 2026-08-10 rather than left as fields nobody fills in. Their ADAPTERS are
  // still in avatar/providers.ts and avatar/tts.ts and still read their env
  // vars, so bringing one back is re-adding its line here — not a rewrite.
  // All consumed by THIS lab server (avatar/providers.ts + avatar/tts.ts), never
  // by the Postiz container, so they're excluded from the Postiz env file via
  // LAB_ONLY_KEYS. The tool needs exactly ONE video key (kie.ai by default) and
  // reuses GEMINI_API_KEY above for both the portrait and the narration voice —
  // so with Gemini already set, kie.ai is the only new account required.
  { key: "SEGMIND_API_KEY", label: "Segmind API key", group: "Avatar Narrator", connects: "The Avatar Narrator's default engine — Segmind hosts Seedance 2.5 (portrait + narration -> generated presenter) at $0.1065/sec at 480p and $0.2389/sec at 720p, roughly 24% under kie.ai for the same ByteDance model. Create a key at segmind.com (console -> API keys), then paste it here. Server-only; never sent to the browser." },

  // ── Video Planner motion graphics (LAB tool — the plan's full-screen cards) ─
  // Higgsfield authenticates with a KEY AND A SECRET in a single
  // `Authorization: Key <id>:<secret>` header, so one without the other cannot
  // sign a request — getHiggsfieldCredentials() returns null unless both are
  // set, and the tool reports itself unconfigured rather than offering to
  // generate and then failing at submit time. Consumed by this lab server
  // (planner/higgsfield.ts), never by the Postiz container, so both are in
  // LAB_ONLY_KEYS and excluded from the emitted Postiz env file.
  //
  // These were in this registry once before, as one of the Avatar Narrator's
  // alternative engines, and were removed with the rest of that cleanup on
  // 2026-08-10. They are back because a different tool needs them: the Video
  // Planner generates each full-screen text card as a still and then animates
  // it, both through Higgsfield's public REST API.
  { key: "HIGGSFIELD_API_KEY", label: "Higgsfield API key", group: "Video Planner motion graphics", connects: "Generates the plan's full-screen text cards — the still (nano-banana, which renders legible headlines) and the animation of it (Kling image-to-video). Create a key pair at higgsfield.ai (account -> API), then paste the key here and the secret below. Both are required. Server-only; never sent to the browser." },
  { key: "HIGGSFIELD_API_SECRET", label: "Higgsfield API secret", group: "Video Planner motion graphics", connects: "The secret half of the Higgsfield key pair. Sent together as a single `Key <id>:<secret>` authorization header — a key on its own cannot sign a request, so the motion stage stays switched off until both are set. Server-only; never sent to the browser." },

  // ── Tutorial Studio (LAB tool — topic -> finished talking-head reel) ────────
  // apimart is a single account fronting three models the reel pipeline needs:
  // Qwen (script), GPT Image 2 (start frame) and Wan 3.0 (the talking clip, the
  // ~$2 stage). Without it nothing past stage 0 runs, so the sidecar refuses to
  // queue rather than failing mid-render.
  //
  // Unlike every other LAB_ONLY key here, this one is not consumed by the lab
  // server itself — it is FORWARDED to the Tutorial Studio sidecar with the job
  // that needs it (tutorial/client.ts), which writes it into that job's 0600
  // .env. That keeps the key in one place, this store, instead of a second copy
  // in the container environment. Same write-only guarantee: never returned
  // through any HTTP response, and never emitted into the Postiz env file.
  { key: "APIMART_API_KEY", label: "apimart API key", group: "Tutorial Studio", connects: "Powers Tutorial Studio's paid stages — the script (Qwen), the start frame (GPT Image 2) and the talking-head clip (Wan 3.0, about $2 of the ~$2.45 per reel). Create a key at apimart.ai, then paste it here. Held by this lab server and handed to the render sidecar per job — never sent to the browser." },

  // ── Tutorial Studio ACCOUNTS (a separate posting identity) ─────────────────
  // Tutorial Studio publishes to a DIFFERENT set of social accounts than the
  // Bulk Scheduler does. The separation is credentials, not a filter: these are
  // a second Postiz account and a second PostPeer account, so a client built
  // with these keys authenticates as that identity and cannot see — let alone
  // post to — the channels the Bulk Scheduler's keys reach. Leave them unset and
  // Tutorial Studio simply has nowhere to post; it never falls back to the
  // Bulk Scheduler's accounts.
  { key: "STUDIO_POSTIZ_API_KEY", label: "Studio Postiz API key", group: "Tutorial Studio accounts", connects: "The Postiz public-API key for the SEPARATE account group Tutorial Studio posts to. Create a second Postiz account (or workspace), connect only that group's socials to it, then Settings → Developers → Public API there, and paste the key here. Never mixed with the Bulk Scheduler's Postiz account." },
  { key: "STUDIO_POSTPEER_API_KEY", label: "Studio PostPeer API key", group: "Tutorial Studio accounts", connects: "OPTIONAL. A second PostPeer account's key, for posting the batch's reels to that group's TikTok via Direct Post. Leave blank to post through Postiz only. Never mixed with the Bulk Scheduler's PostPeer account." },

  { key: "DATAFORSEO_LOGIN", label: "DataForSEO login (optional)", group: "Keyword Research", connects: "OPTIONAL. The Keyword Research tool works out of the box on free signals (YouTube autocomplete + Data API + Google Trends). Add your DataForSEO API login (the email you sign in with at dataforseo.com) here — together with the password — for exact monthly Google search volume, CPC and extra keyword ideas. Server-only; never sent to the browser." },
  { key: "DATAFORSEO_PASSWORD", label: "DataForSEO password (optional)", group: "Keyword Research", connects: "OPTIONAL. The API password from your DataForSEO dashboard (API Access), paired with the login above. Used server-side for HTTP Basic auth to DataForSEO; never sent to the browser." },

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

  // ── Engagement Manager — Meta (Instagram + Facebook) comment monitoring ──────
  // Distinct from FACEBOOK_APP_ID/SECRET above (which are Postiz's OAuth app
  // credentials). These are read by THIS lab server (engage/metaGraph.ts) to READ
  // comments via the Graph API, so they're LAB_ONLY (never emitted into Postiz's
  // env file) and read internally via getMetaCreds(). Same write-only guarantee as
  // every other key: never returned through any HTTP response, never logged.
  { key: "META_APP_ID", label: "Meta app ID", group: "Engagement (Meta)", connects: "App ID of the Meta app used to READ Instagram + Facebook comments in the Engagement Manager. Used with the app secret to exchange the pasted user token for a long-lived one. Server-only; never sent to the browser." },
  { key: "META_APP_SECRET", label: "Meta app secret", group: "Engagement (Meta)", connects: "App secret of the Meta app, paired with the app ID to mint a long-lived user token for comment monitoring. Server-only; never sent to the browser." },
  { key: "META_ACCESS_TOKEN", label: "Meta user access token", group: "Engagement (Meta)", connects: "A long-lived Meta USER access token (with pages_show_list, pages_read_engagement, instagram_basic + instagram_manage_comments) so the Engagement Manager can READ Facebook Page + Instagram business comments. Paste one generated in Graph API Explorer; the server exchanges it for a long-lived token. Server-only; never sent to the browser." },

  // ── Engagement Manager — TikTok comment monitoring (Apify) ───────────────────
  // Read by THIS lab server (engage/tiktok.ts) to READ a TikTok profile's video
  // comments via the Apify `scrapeforge/tiktok-comments-extractor` actor. LAB_ONLY
  // (never emitted into Postiz's env file) and read internally via getApifyToken().
  // Polled on a SLOW cadence (default 6h) to conserve Apify credits. Same write-only
  // guarantee as every other key: never returned through any HTTP response, never logged.
  { key: "APIFY_TOKEN", label: "Apify API token", group: "Engagement (TikTok)", connects: "An Apify API token so the Engagement Manager can READ your connected TikTok profile's comments via the scrapeforge/tiktok-comments-extractor actor. Create one at apify.com (Settings → Integrations → API token). TikTok is polled on a slow cadence (~4 runs/day) to conserve Apify credits. Server-only; never sent to the browser." },
  // ── Script Generator — transcript fallback (RapidAPI yt-api) ────────────────
  // The script generator reads recent tutorials to learn a tool's real click
  // paths. Apify is the primary transcript source; this is the fallback for when
  // an actor run fails or returns nothing. LAB_ONLY, read internally via
  // getRapidApiKey(), same write-only guarantee as the rest.
  { key: "RAPIDAPI_KEY", label: "RapidAPI key (yt-api)", group: "Script Generator", connects: "A RapidAPI key subscribed to yt-api (yt-api.p.rapidapi.com), used as the FALLBACK transcript source when Apify fails. The script generator reads the newest tutorials on a topic to learn a tool's real menu names and click paths. Server-only; never sent to the browser." },
  // ── Channel Audit — YouTube Analytics (paid vs organic views) ──────────────
  // A SEPARATE OAuth client from the sign-in one. Signing in to the lab must
  // never be able to read anyone's YouTube analytics, so the identity client
  // keeps its "openid email profile" scopes and this connection is granted
  // explicitly and separately.
  { key: "YT_ANALYTICS_CLIENT_ID", label: "YouTube Analytics client ID", group: "Channel Audit", connects: "OAuth client ID for reading YOUR OWN channel's analytics, so the audit can separate paid (advertised) views from organic ones. Requires the yt-analytics.readonly scope. Only ever reads the channel of whoever grants consent — no other channel's paid/organic split is available to anyone." },
  { key: "YT_ANALYTICS_CLIENT_SECRET", label: "YouTube Analytics client secret", group: "Channel Audit", connects: "Secret for the YouTube Analytics OAuth client above. Server-only; never sent to the browser." },
  { key: "YT_ANALYTICS_REFRESH_TOKEN", label: "YouTube Analytics refresh token", group: "Channel Audit", connects: "Written automatically when you connect your channel from the Channel Audit page. Grants read-only access to your own analytics; revoke any time at myaccount.google.com/permissions." },

  // Google Docs export (Script Generator). A THIRD Google client, separate from
  // sign-in and from Channel Audit, and the narrowest of the three: drive.file
  // reaches only the documents this app itself creates. It cannot read, edit or
  // delete anything else in the Drive, which is why connecting it is safe even
  // though the account holds everything else Jake owns.
  { key: "GDOCS_CLIENT_ID", label: "Google Docs client ID", group: "Script Generator", connects: "OAuth client ID for exporting a finished script into a Google Doc. Uses the drive.file scope: it can create documents and re-open the ones it created, and nothing else in your Drive is visible to it." },
  { key: "GDOCS_CLIENT_SECRET", label: "Google Docs client secret", group: "Script Generator", connects: "Secret for the Google Docs OAuth client above. Server-only; never sent to the browser." },
  { key: "GDOCS_REFRESH_TOKEN", label: "Google Docs refresh token", group: "Script Generator", connects: "Written automatically when you connect Google Docs from the Script Generator. Revoke any time at myaccount.google.com/permissions." },
  { key: "GDOCS_FOLDER_ID", label: "Google Docs export folder", group: "Script Generator", connects: "The Drive folder finished scripts are exported into. Paste the folder's URL or its id — open the folder in Drive and copy the address bar." },

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
 * Prefix for the per-folder Google Docs sequence counter. Dynamic (the folder
 * id is part of the key), so it is exempted from ALLOWED_KEYS by prefix in
 * readStore rather than listed. Deliberately NOT exported to the env file:
 * it is bookkeeping, not a credential.
 */
const GDOCS_SEQ_PREFIX = "GDOCS_SEQ_";

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
  // Thumbnail Designer (used by the lab server, never by Postiz).
  "GEMINI_API_KEY",
  "YOUTUBE_DATA_API_KEY",
  // Avatar Narrator — lipsync engines + optional voice, used by the lab server.
  "KIE_API_KEY",
  "SEGMIND_API_KEY",
  "WAVESPEED_API_KEY",
  "ELEVENLABS_API_KEY",
  "HIGGSFIELD_API_KEY",
  "HIGGSFIELD_API_SECRET",
  "INFINITETALK_SELFHOST_URL",
  "INFINITETALK_SELFHOST_KEY",
  // Tutorial Studio — forwarded to the render sidecar, never Postiz config.
  "APIMART_API_KEY",
  // Tutorial Studio's separate posting identity — used by the lab server to
  // authenticate AS that account group; never this container's own config.
  "STUDIO_POSTIZ_API_KEY",
  "STUDIO_POSTPEER_API_KEY",
  // Keyword Research (optional DataForSEO volume provider), used by the lab server.
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  // Engagement Manager — Meta (IG + FB) comment monitoring, used by the lab server.
  "META_APP_ID",
  "META_APP_SECRET",
  "META_ACCESS_TOKEN",
  // Engagement Manager — TikTok (Apify) comment monitoring, used by the lab server.
  "APIFY_TOKEN",
  // Script Generator — transcript fallback (lab server only).
  "RAPIDAPI_KEY",
  // Channel Audit — YouTube Analytics OAuth (lab server only).
  "YT_ANALYTICS_CLIENT_ID",
  "YT_ANALYTICS_CLIENT_SECRET",
  "YT_ANALYTICS_REFRESH_TOKEN",
  "GDOCS_CLIENT_ID",
  "GDOCS_CLIENT_SECRET",
  "GDOCS_REFRESH_TOKEN",
  "GDOCS_FOLDER_ID",
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
        // GDOCS_SEQ_<folderId> is a DYNAMIC key — one per export folder — so it
        // cannot appear in the static ALLOWED_KEYS built from POSTIZ_KEY_DEFS.
        // Without this prefix exemption the filter silently ate it on every
        // read: setGoogleDocsHighWater wrote the number to disk and
        // getGoogleDocsHighWater always read back 0, so the "never reuse a
        // number" guarantee the doc numbering rests on did not hold, and the
        // sequence could not be started at anything but 1.
        const allowed = ALLOWED_KEYS.has(k) || k.startsWith(GDOCS_SEQ_PREFIX);
        if (allowed && typeof v === "string" && v.length > 0) out[k] = v;
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

/**
 * INTERNAL, SERVER-ONLY getter for the Gemini (Nano Banana) API key — used by
 * thumbnails/nanoBanana.ts to run the Gemini 2.5 Flash Image editing chain. Like
 * the other LAB-only keys it must NEVER be wired into an HTTP response
 * (write-only guarantee). An env var (GEMINI_API_KEY) takes precedence.
 */
export function getGeminiApiKey(): string | null {
  const fromEnv = (process.env.GEMINI_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.GEMINI_API_KEY || null;
}

/**
 * INTERNAL, SERVER-ONLY getter for the YouTube Data API key — used by
 * thumbnails/youtube.ts to search for top-performing thumbnails. Must NEVER be
 * wired into an HTTP response (write-only guarantee). An env var
 * (YOUTUBE_DATA_API_KEY) takes precedence over the UI-managed store.
 */
export function getYoutubeDataApiKey(): string | null {
  const fromEnv = (process.env.YOUTUBE_DATA_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.YOUTUBE_DATA_API_KEY || null;
}

/**
 * INTERNAL, SERVER-ONLY getter for the RapidAPI key — used by
 * scriptgen/videoResearch.ts as the FALLBACK transcript source when an Apify
 * actor run fails or comes back empty. Must NEVER be wired into an HTTP response
 * or logged (write-only guarantee). An env var (RAPIDAPI_KEY) takes precedence
 * over the UI-managed store.
 */
export function getRapidApiKey(): string | null {
  const fromEnv = (process.env.RAPIDAPI_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.RAPIDAPI_KEY || null;
}

/**
 * INTERNAL, SERVER-ONLY getter for the apimart key — the paid engine behind
 * Tutorial Studio's script, start-frame and talking-head stages. Unlike its
 * siblings the value is not used here: it is forwarded to the render sidecar
 * with the job (tutorial/client.ts), which writes it into that job's 0600 .env.
 * It must NEVER be wired into an HTTP response (write-only guarantee). An env
 * var (APIMART_API_KEY) takes precedence over the UI-managed store.
 */
export function getApimartApiKey(): string | null {
  const fromEnv = (process.env.APIMART_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.APIMART_API_KEY || null;
}

/**
 * INTERNAL, SERVER-ONLY getters for Tutorial Studio's SEPARATE posting identity.
 * A client built with these authenticates as a different Postiz/PostPeer
 * account, which is what keeps that batch's videos away from the Bulk
 * Scheduler's channels. Never wire either into an HTTP response.
 */
export function getStudioPostizApiKey(): string | null {
  const fromEnv = (process.env.STUDIO_POSTIZ_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.STUDIO_POSTIZ_API_KEY || null;
}

export function getStudioPostPeerApiKey(): string | null {
  const fromEnv = (process.env.STUDIO_POSTPEER_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.STUDIO_POSTPEER_API_KEY || null;
}

/**
 * INTERNAL, SERVER-ONLY getters for the Avatar Narrator's engines. Same
 * write-only guarantee as every key above: none of these may ever be wired into
 * an HTTP response, and none is logged. Env vars take precedence over the
 * UI-managed store so a compose-level key wins on the droplet.
 */
export function getKieApiKey(): string | null {
  return (process.env.KIE_API_KEY || "").trim() || readStore().KIE_API_KEY || null;
}
export function getSegmindApiKey(): string | null {
  return (process.env.SEGMIND_API_KEY || "").trim() || readStore().SEGMIND_API_KEY || null;
}
export function getWaveSpeedApiKey(): string | null {
  return (process.env.WAVESPEED_API_KEY || "").trim() || readStore().WAVESPEED_API_KEY || null;
}
export function getElevenLabsApiKey(): string | null {
  return (process.env.ELEVENLABS_API_KEY || "").trim() || readStore().ELEVENLABS_API_KEY || null;
}
/**
 * Higgsfield credentials. Returned as a PAIR because the API authenticates with
 * both halves in one header — `Authorization: Key <id>:<secret>`. NOT HTTP
 * Basic, as this comment used to say: base64-encoding the pair returns a 401.
 * A key on its own cannot sign a request, so "configured" has to mean both are
 * present or the tool would offer itself and then fail at submit time.
 */
export function getHiggsfieldCredentials(): { key: string; secret: string } | null {
  const key = (process.env.HIGGSFIELD_API_KEY || "").trim() || readStore().HIGGSFIELD_API_KEY || "";
  const secret = (process.env.HIGGSFIELD_API_SECRET || "").trim() || readStore().HIGGSFIELD_API_SECRET || "";
  return key && secret ? { key, secret } : null;
}

export function getSelfHostAvatarUrl(): string | null {
  return (process.env.INFINITETALK_SELFHOST_URL || "").trim() || readStore().INFINITETALK_SELFHOST_URL || null;
}
export function getSelfHostAvatarKey(): string | null {
  return (process.env.INFINITETALK_SELFHOST_KEY || "").trim() || readStore().INFINITETALK_SELFHOST_KEY || null;
}

/**
 * INTERNAL, SERVER-ONLY getter for the OPTIONAL DataForSEO credentials used by
 * the Keyword Research tool for exact search volume + keyword ideas. Returns null
 * unless BOTH login and password are set (mirrors the Dropbox credential getter).
 * Env vars take precedence. Must NEVER be wired into an HTTP response.
 */
export function getDataForSeoCreds(): { login: string; password: string } | null {
  const login = (process.env.DATAFORSEO_LOGIN || "").trim() || readStore().DATAFORSEO_LOGIN || "";
  const password = (process.env.DATAFORSEO_PASSWORD || "").trim() || readStore().DATAFORSEO_PASSWORD || "";
  if (!login || !password) return null;
  return { login, password };
}

/** Configured Meta (Instagram + Facebook) Graph credentials for comment monitoring. */
export interface MetaCredentials {
  /** May be empty — only needed to exchange for a long-lived token. */
  appId: string;
  /** May be empty — only needed to exchange for a long-lived token. */
  appSecret: string;
  /** The long-lived Meta USER access token (required). */
  token: string;
}

/**
 * INTERNAL, SERVER-ONLY getter for the Meta (IG + FB) monitoring credentials —
 * used by engage/metaGraph.ts to READ comments via the Graph API. Returns null
 * unless the USER TOKEN is present (app id/secret are optional — only used to
 * exchange a short-lived token for a long-lived one). Env vars take precedence
 * over the UI-managed store. Must NEVER be wired into an HTTP response or logged
 * (write-only guarantee).
 */
export function getMetaCreds(): MetaCredentials | null {
  const map = readStore();
  const pick = (key: string) => (process.env[key] || "").trim() || map[key] || "";
  const token = pick("META_ACCESS_TOKEN");
  if (!token) return null;
  return { appId: pick("META_APP_ID"), appSecret: pick("META_APP_SECRET"), token };
}

/** True when a Meta user access token is configured (IG/FB monitoring is inert until then). */
export function metaConfigured(): boolean {
  return getMetaCreds() != null;
}

/**
 * INTERNAL, SERVER-ONLY getter for the Apify API token — used by engage/tiktok.ts
 * to READ a TikTok profile's comments via the scrapeforge/tiktok-comments-extractor
 * actor. Must NEVER be wired into an HTTP response or logged (write-only guarantee).
 * An env var (APIFY_TOKEN) takes precedence over the UI-managed store.
 */
export function getApifyToken(): string | null {
  const fromEnv = (process.env.APIFY_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const map = readStore();
  return map.APIFY_TOKEN || null;
}

/** True when an Apify token is configured (TikTok monitoring is inert until then). */
export function apifyConfigured(): boolean {
  return getApifyToken() != null;
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

/**
 * INTERNAL, SERVER-ONLY getter for the Channel Audit's YouTube Analytics OAuth
 * credentials.
 *
 * Separate from the sign-in client on purpose: signing in to the lab proves who
 * you are and nothing more, and must never carry the ability to read YouTube
 * data. The refresh token is written by the consent callback and is the only
 * way the audit can see a paid/organic split — which is available for the
 * granting channel alone. Must NEVER be wired into an HTTP response.
 */
export function getYtAnalyticsOAuth(): { clientId: string; clientSecret: string; refreshToken: string | null } | null {
  const map = readStore();
  const clientId = (process.env.YT_ANALYTICS_CLIENT_ID || "").trim() || map.YT_ANALYTICS_CLIENT_ID || "";
  const clientSecret = (process.env.YT_ANALYTICS_CLIENT_SECRET || "").trim() || map.YT_ANALYTICS_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  const refreshToken = (process.env.YT_ANALYTICS_REFRESH_TOKEN || "").trim() || map.YT_ANALYTICS_REFRESH_TOKEN || null;
  return { clientId, clientSecret, refreshToken };
}

/** The Google Docs export client. Same shape as the analytics one, different grant. */
export function getGoogleDocsOAuth(): { clientId: string; clientSecret: string; refreshToken: string | null } | null {
  const map = readStore();
  const clientId = (process.env.GDOCS_CLIENT_ID || "").trim() || map.GDOCS_CLIENT_ID || "";
  const clientSecret = (process.env.GDOCS_CLIENT_SECRET || "").trim() || map.GDOCS_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return null;
  const refreshToken = (process.env.GDOCS_REFRESH_TOKEN || "").trim() || map.GDOCS_REFRESH_TOKEN || null;
  return { clientId, clientSecret, refreshToken };
}

export function setGoogleDocsRefreshToken(token: string): void {
  const map = readStore();
  map.GDOCS_REFRESH_TOKEN = token;
  writeStore(map);
}

export function clearGoogleDocsRefreshToken(): void {
  const map = readStore();
  delete map.GDOCS_REFRESH_TOKEN;
  writeStore(map);
}

/** The folder finished scripts are exported into. */
export function getGoogleDocsFolder(): string {
  const map = readStore();
  return (process.env.GDOCS_FOLDER_ID || "").trim() || map.GDOCS_FOLDER_ID || "";
}

export function setGoogleDocsFolder(folderId: string): void {
  const map = readStore();
  map.GDOCS_FOLDER_ID = folderId;
  writeStore(map);
}

/**
 * The highest doc number used in a folder.
 *
 * Needed because the drive.file scope cannot list documents this app did not
 * create: without a stored floor, a doc Jake made by hand would be invisible
 * and its number handed out twice.
 */
export function getGoogleDocsHighWater(folderId: string): number {
  const map = readStore();
  const n = Number(map[`${GDOCS_SEQ_PREFIX}${folderId}`] || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function setGoogleDocsHighWater(folderId: string, n: number): void {
  const map = readStore();
  if (n > getGoogleDocsHighWater(folderId)) {
    map[`${GDOCS_SEQ_PREFIX}${folderId}`] = String(n);
    writeStore(map);
  }
}

/** Persist the refresh token obtained from the consent callback. */
export function setYtAnalyticsRefreshToken(token: string): void {
  const map = readStore();
  map.YT_ANALYTICS_REFRESH_TOKEN = token;
  writeStore(map);
}

/** Forget the connection (the user disconnecting their channel). */
export function clearYtAnalyticsRefreshToken(): void {
  const map = readStore();
  delete map.YT_ANALYTICS_REFRESH_TOKEN;
  writeStore(map);
}
