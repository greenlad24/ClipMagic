/**
 * Cloud FOLDER browsing for the Bulk Scheduler — no-OAuth (API key / refresh
 * token), server-side only.
 *
 * This is "phase 2" of the file-source bridge (see fileSources.ts): instead of
 * the user pasting one share link, they point at a public Google Drive FOLDER or
 * a Dropbox FOLDER PATH and pick videos from inside it. Each picked file becomes
 * a normal `cloud` FileSourceRef whose `ref` is a DIRECT, internet-fetchable
 * media URL, so it flows through the EXISTING preview/schedule path unchanged
 * (Postiz / PostPeer pull the bytes from that URL).
 *
 * Credentials are read via the write-only secrets store's server-only getters
 * (getGoogleDriveApiKey / getDropboxCredentials) and NEVER returned to the
 * browser or logged.
 *
 * ── Provider contracts (verified against the public docs, June 2026) ──────────
 *  Google Drive v3 (API key, public folder):
 *    GET https://www.googleapis.com/drive/v3/files
 *      ?q='<folderId>'+in+parents+and+mimeType+contains+'video/'+and+trashed=false
 *      &key=<KEY>&fields=files(id,name,mimeType,thumbnailLink,size),nextPageToken
 *      &pageSize=100
 *    Source: developers.google.com/drive/api/reference/rest/v3/files/list.
 *    Direct media URL per file:
 *      https://drive.usercontent.google.com/download?id=<id>&export=download&confirm=t
 *    The usercontent.google.com/download host with confirm=t bypasses the
 *    large-file virus-scan interstitial that plain drive.google.com/uc hits.
 *
 *  Dropbox (refresh token → short-lived access token):
 *    POST https://api.dropbox.com/oauth2/token  (grant_type=refresh_token,
 *      client_id/secret via HTTP Basic) → { access_token, expires_in }.
 *    POST https://api.dropboxapi.com/2/files/list_folder { path } (+ /continue).
 *    POST https://api.dropboxapi.com/2/files/get_temporary_link { path } → { link }.
 *    Source: dropbox.com/developers/documentation/http/documentation.
 */
import {
  getGoogleDriveApiKey,
  getDropboxCredentials,
  type DropboxCredentials,
} from "../settings/postizSecrets.js";
import type { FileSourceRef } from "./fileSources.js";

export type CloudProvider = "gdrive" | "dropbox";

/** One browsable video in a cloud folder + the cloud source the picker adds. */
export interface CloudFolderItem {
  /** Stable id within the provider (Drive file id / Dropbox path). */
  id: string;
  name: string;
  mimeType?: string;
  /** Optional preview thumbnail (Drive only). */
  thumbnailUrl?: string;
  sizeBytes?: number;
  /** A `cloud` FileSourceRef whose `ref` is a DIRECT, fetchable media URL. */
  source: FileSourceRef;
}

export class CloudSourceError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "CloudSourceError";
  }
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.CLOUD_API_TIMEOUT_MS || "20000", 10);

/** Video extensions we accept when a provider doesn't give a reliable MIME type. */
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

/** fetch with an abort timeout; throws CloudSourceError on network/timeout. */
async function timedFetch(url: string, init: RequestInit, label: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new CloudSourceError(
      aborted ? `${label} timed out after ${DEFAULT_TIMEOUT_MS}ms` : `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// ── Google Drive ──────────────────────────────────────────────────────────────
/**
 * Extract a Drive FOLDER id from a folder URL or a raw id. Mirrors the share-link
 * patterns in fileSources.normalizeCloudLink, plus the /folders/<id> form.
 * Returns the input trimmed when it already looks like a bare id.
 */
export function extractDriveFolderId(input: string): string | null {
  const v = (input || "").trim();
  if (!v) return null;
  if (/drive\.google\.com|docs\.google\.com/i.test(v)) {
    const id =
      v.match(/\/folders\/([^/?#]+)/)?.[1] ||
      v.match(/\/file\/d\/([^/?#]+)/)?.[1] ||
      v.match(/[?&]id=([^&]+)/)?.[1] ||
      null;
    return id || null;
  }
  // A bare folder id (Drive ids are URL-safe, no slashes/spaces).
  if (/^[A-Za-z0-9_-]{10,}$/.test(v)) return v;
  return null;
}

/**
 * Direct, internet-fetchable media URL for a Drive file. Uses the
 * usercontent.google.com/download host with confirm=t, which serves the raw
 * bytes and bypasses the large-file virus-scan interstitial that plain
 * drive.google.com/uc?export=download hits.
 *
 * TODO(live): VERY large files may still return a confirm-token HTML page on the
 * first hit; this confirm=t form handles the common case. If a giant file fails,
 * the provider's fetch error surfaces per-item and we'd add token-follow here.
 */
export function driveDirectUrl(id: string): string {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;
}

/** Parse one Drive file record into a CloudFolderItem (or null if unusable). */
function driveFileToItem(raw: unknown): CloudFolderItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : "";
  if (!id) return null;
  const name = typeof o.name === "string" ? o.name : id;
  const mimeType = typeof o.mimeType === "string" ? o.mimeType : undefined;
  const thumbnailUrl = typeof o.thumbnailLink === "string" ? o.thumbnailLink : undefined;
  // Drive returns `size` as a string of bytes (only for binary files).
  const sizeBytes =
    typeof o.size === "string" && /^\d+$/.test(o.size) ? Number.parseInt(o.size, 10) : undefined;
  return {
    id,
    name,
    mimeType,
    thumbnailUrl,
    sizeBytes,
    source: { kind: "cloud", ref: driveDirectUrl(id) },
  };
}

async function listDriveFolder(folder: string): Promise<CloudFolderItem[]> {
  const key = getGoogleDriveApiKey();
  if (!key) {
    throw new CloudSourceError(
      "Google Drive API key not configured. Add GOOGLE_DRIVE_API_KEY under Settings → Postiz (Cloud sources group).",
    );
  }
  const folderId = extractDriveFolderId(folder);
  if (!folderId) {
    throw new CloudSourceError(
      "Couldn't read a Drive folder from that input. Paste the folder's share link (…/folders/<id>) or its id.",
    );
  }

  const q = `'${folderId}' in parents and mimeType contains 'video/' and trashed=false`;
  const items: CloudFolderItem[] = [];
  let pageToken: string | undefined;
  // Bound the paging so a pathological folder can't loop forever.
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      q,
      key,
      fields: "nextPageToken,files(id,name,mimeType,thumbnailLink,size)",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await timedFetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { method: "GET" },
      "Drive folder listing",
    );
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new CloudSourceError("Drive returned an unreadable response.");
    }
    if (!res.ok) {
      // 403/404 from a private folder or a key without Drive API access.
      if (res.status === 403 || res.status === 404) {
        throw new CloudSourceError(
          "Folder not found or not shared 'anyone with the link'. Make the Drive folder link-shareable and check your API key has the Drive API enabled.",
          res.status,
        );
      }
      const msg =
        body && typeof body === "object" && "error" in body
          ? String(((body as { error: { message?: unknown } }).error?.message) ?? `HTTP ${res.status}`)
          : `HTTP ${res.status}`;
      throw new CloudSourceError(`Drive listing failed: ${msg}`, res.status);
    }
    const files = (body as { files?: unknown[] }).files;
    if (Array.isArray(files)) {
      for (const f of files) {
        const item = driveFileToItem(f);
        if (item) items.push(item);
      }
    }
    pageToken = (body as { nextPageToken?: string }).nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

// ── Dropbox ──────────────────────────────────────────────────────────────────
// Cache the minted access token in-memory (it lives ~4h). Refresh on demand once
// it's within a small skew of expiry. Keyed by refresh token so rotating creds
// invalidates the cache naturally.
interface CachedToken {
  refreshToken: string;
  accessToken: string;
  expiresAtMs: number;
}
let dropboxTokenCache: CachedToken | null = null;
const TOKEN_SKEW_MS = 60_000; // refresh a minute early

/** For tests: clear the in-memory Dropbox token cache. */
export function _resetDropboxTokenCache(): void {
  dropboxTokenCache = null;
}

/**
 * Mint (or reuse) a short-lived Dropbox access token from the refresh token.
 * Cached in-memory until ~1 min before expiry, then refreshed on demand.
 */
async function dropboxAccessToken(creds: DropboxCredentials): Promise<string> {
  const now = Date.now();
  if (
    dropboxTokenCache &&
    dropboxTokenCache.refreshToken === creds.refreshToken &&
    dropboxTokenCache.expiresAtMs - TOKEN_SKEW_MS > now
  ) {
    return dropboxTokenCache.accessToken;
  }
  const basic = Buffer.from(`${creds.appKey}:${creds.appSecret}`).toString("base64");
  const res = await timedFetch(
    "https://api.dropbox.com/oauth2/token",
    {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: creds.refreshToken }).toString(),
    },
    "Dropbox token mint",
  );
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new CloudSourceError("Dropbox returned an unreadable token response.");
  }
  if (!res.ok) {
    throw new CloudSourceError(
      "Couldn't get a Dropbox access token. Check your app key, app secret and refresh token in Settings → Postiz (Cloud sources group).",
      res.status,
    );
  }
  const accessToken = (body as { access_token?: unknown }).access_token;
  const expiresIn = (body as { expires_in?: unknown }).expires_in;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new CloudSourceError("Dropbox token response was missing an access token.");
  }
  const ttlMs = (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 14_400) * 1000;
  dropboxTokenCache = { refreshToken: creds.refreshToken, accessToken, expiresAtMs: now + ttlMs };
  return accessToken;
}

/** Authenticated POST to a Dropbox RPC endpoint with a JSON body. */
async function dropboxRpc<T>(token: string, path: string, json: unknown, label: string): Promise<T> {
  const res = await timedFetch(
    `https://api.dropboxapi.com/2/${path}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(json),
    },
    label,
  );
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!res.ok) {
    // Dropbox 409 conflict → bad path (folder not found / not a folder).
    if (res.status === 409) {
      throw new CloudSourceError(
        `Dropbox folder not found: check the folder path (e.g. /Videos/Shorts).`,
        res.status,
      );
    }
    const summary =
      body && typeof body === "object" && "error_summary" in body
        ? String((body as { error_summary: unknown }).error_summary)
        : `HTTP ${res.status}`;
    throw new CloudSourceError(`${label} failed: ${summary}`, res.status);
  }
  return body as T;
}

interface DropboxEntry {
  ".tag"?: string;
  name?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
}

/** Mint a ~4h direct download link for one Dropbox file path. */
async function dropboxTemporaryLink(token: string, path: string): Promise<string | null> {
  try {
    const body = await dropboxRpc<{ link?: string }>(
      token,
      "files/get_temporary_link",
      { path },
      "Dropbox temporary link",
    );
    return typeof body.link === "string" ? body.link : null;
  } catch {
    // One file failing to mint a link shouldn't sink the whole listing.
    return null;
  }
}

async function listDropboxFolder(folder: string): Promise<CloudFolderItem[]> {
  const creds = getDropboxCredentials();
  if (!creds) {
    throw new CloudSourceError(
      "Dropbox isn't configured. Add your Dropbox app key, app secret and refresh token under Settings → Postiz (Cloud sources group).",
    );
  }
  // Dropbox wants a folder PATH; "" is the root. Normalize "/Videos/" → "/Videos".
  let path = (folder || "").trim();
  if (path && path !== "/") path = `/${path.replace(/^\/+|\/+$/g, "")}`;
  else path = ""; // root

  const token = await dropboxAccessToken(creds);

  // Collect entries, paging via list_folder/continue.
  const entries: DropboxEntry[] = [];
  let resp = await dropboxRpc<{ entries?: DropboxEntry[]; cursor?: string; has_more?: boolean }>(
    token,
    "files/list_folder",
    { path },
    "Dropbox folder listing",
  );
  for (let page = 0; page < 50; page++) {
    if (Array.isArray(resp.entries)) entries.push(...resp.entries);
    if (!resp.has_more || !resp.cursor) break;
    resp = await dropboxRpc<{ entries?: DropboxEntry[]; cursor?: string; has_more?: boolean }>(
      token,
      "files/list_folder/continue",
      { cursor: resp.cursor },
      "Dropbox folder listing",
    );
  }

  // Filter to video files, then mint a temporary direct link per file.
  //
  // ⚠ TODO(live): get_temporary_link URLs expire (~4h). If a post is scheduled
  // far in the future, the link could expire before the provider fetches it. This
  // is acceptable today because PostPeer/Postiz fetch + STORE the media at
  // SCHEDULE time (when we call create-post), not at publish time — so the link
  // only needs to be valid for the few seconds it takes to push the post.
  const videoFiles = entries.filter(
    (e) => e[".tag"] === "file" && typeof e.path_lower === "string" && VIDEO_EXT.test(e.name || ""),
  );
  const items: CloudFolderItem[] = [];
  for (const e of videoFiles) {
    const filePath = e.path_lower as string;
    const link = await dropboxTemporaryLink(token, filePath);
    if (!link) continue;
    items.push({
      id: filePath,
      name: e.name || filePath.split("/").pop() || filePath,
      mimeType: undefined,
      // Dropbox thumbnails (get_thumbnail) are heavy; a placeholder icon is used
      // in the UI instead.
      thumbnailUrl: undefined,
      sizeBytes: typeof e.size === "number" ? e.size : undefined,
      source: { kind: "cloud", ref: link },
    });
  }
  return items;
}

// ── Public entry point ─────────────────────────────────────────────────────────
/** Which cloud providers are configured (drives the UI tabs). NEVER leaks keys. */
export function cloudProvidersConfigured(): { gdrive: boolean; dropbox: boolean } {
  return { gdrive: !!getGoogleDriveApiKey(), dropbox: !!getDropboxCredentials() };
}

/**
 * Browse a cloud FOLDER and return its videos as ready-to-add cloud sources.
 * Routes by provider; surfaces missing-credential + bad-folder errors clearly.
 */
export async function listCloudFolder(provider: string, folder: string): Promise<CloudFolderItem[]> {
  switch (provider) {
    case "gdrive":
      return listDriveFolder(folder);
    case "dropbox":
      return listDropboxFolder(folder);
    default:
      throw new CloudSourceError(`Unknown cloud provider: ${provider}. Use "gdrive" or "dropbox".`);
  }
}
