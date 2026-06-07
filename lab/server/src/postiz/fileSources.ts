/**
 * File sources ("the bridge") for the Bulk Scheduler — how a selected video
 * becomes a media URL/buffer that Postiz can ingest.
 *
 * v1 providers:
 *   - "render"  : a finished server render listed by listStorage(). Postiz pulls
 *                 it via upload-from-url using the lab's INTERNAL URL (reachable
 *                 on the Docker network), so no public HTTPS is needed.
 *   - "upload"  : a file the user uploaded through the lab's existing upload
 *                 mechanism (served at /api/uploads/<id>); same internal-URL pull.
 *   - "cloud"   : a Dropbox or Google Drive SHARE link, normalized to a DIRECT
 *                 download URL and handed to Postiz's upload-from-url.
 *
 * The abstraction is intentionally small (resolve → a direct URL string) so
 * full OAuth pickers (Dropbox/Drive) can be layered in later as new providers
 * without changing callers.
 *
 * TODO(phase 2): OAuth pickers for Dropbox/Drive (lets users browse + pick files
 * instead of pasting a share link). Requires HTTPS callbacks — out of scope here.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { resolveInput } from "../render/resolve.js";

export type FileSourceKind = "render" | "upload" | "cloud";

export interface FileSourceRef {
  kind: FileSourceKind;
  /** For render/upload: the stored name / upload id. For cloud: the share link. */
  ref: string;
}

/**
 * Internal base URL the Postiz container uses to reach THIS lab server over the
 * Docker network. Default matches the lab's compose service name + port. Made
 * configurable so a different network name/port works without code changes.
 */
export function internalBaseUrl(): string {
  const base = (process.env.CLIPMAGIC_INTERNAL_URL || "http://clipmagic-lab:9090").trim().replace(/\/+$/, "");
  return base;
}

/**
 * PUBLIC base URL of THIS lab server on the internet, for EXTERNAL providers
 * (PostPeer) that can't reach the Docker-internal name. Reads PUBLIC_BASE_URL
 * (already an env var on the lab service). Returns "" when unset, so callers can
 * fail with a clear, actionable error instead of sending an unreachable URL.
 */
export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

/** Direct URL for a server render (served statically at /api/outputs/<name>). */
export function renderMediaUrl(name: string): string {
  return `${internalBaseUrl()}/api/outputs/${encodeURIComponent(name)}`;
}

/** Direct URL for a user upload (served at /api/uploads/<id>). */
export function uploadMediaUrl(id: string): string {
  return `${internalBaseUrl()}/api/uploads/${encodeURIComponent(id)}`;
}

/**
 * Normalize a Dropbox / Google Drive SHARE link to a DIRECT download URL Postiz
 * can fetch. Pure + exported for unit testing.
 *   - Dropbox: force `dl=1` (and the dl.dropboxusercontent.com host already
 *     serves the raw bytes — leave it but ensure dl=1).
 *   - Google Drive: extract the file id from any common share form and rewrite
 *     to https://drive.google.com/uc?export=download&id=<id>.
 * Any other URL is returned unchanged (assumed already direct).
 */
export function normalizeCloudLink(link: string): string {
  const url = link.trim();
  if (!url) return url;

  // ── Google Drive ───────────────────────────────────────────────────────────
  // Forms: /file/d/<id>/view, open?id=<id>, uc?id=<id>, ?id=<id>
  if (/drive\.google\.com|docs\.google\.com/i.test(url)) {
    const id =
      url.match(/\/file\/d\/([^/]+)/)?.[1] ||
      url.match(/[?&]id=([^&]+)/)?.[1] ||
      null;
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
    return url;
  }

  // ── Dropbox ──────────────────────────────────────────────────────────────────
  if (/dropbox\.com|dropboxusercontent\.com/i.test(url)) {
    try {
      const u = new URL(url);
      // dl.dropboxusercontent.com already serves raw bytes; just ensure dl=1.
      u.searchParams.set("dl", "1");
      return u.toString();
    } catch {
      // Fall back to a simple query swap if URL parsing fails.
      if (/[?&]dl=0/.test(url)) return url.replace(/([?&])dl=0/, "$1dl=1");
      return url.includes("?") ? `${url}&dl=1` : `${url}?dl=1`;
    }
  }

  return url;
}

/**
 * Resolve a FileSourceRef to a DIRECT URL Postiz can ingest via
 * upload-from-url. (We deliberately use URL-pull for all three v1 providers so
 * the lab never has to stream large renders through itself.)
 */
export function resolveSourceUrl(src: FileSourceRef): string {
  switch (src.kind) {
    case "render":
      return renderMediaUrl(src.ref);
    case "upload":
      return uploadMediaUrl(src.ref);
    case "cloud":
      return normalizeCloudLink(src.ref);
    default:
      throw new Error(`Unknown file source kind: ${(src as FileSourceRef).kind}`);
  }
}

/** Thrown by resolvePublicSourceUrl when PUBLIC_BASE_URL is needed but unset. */
export class PublicUrlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicUrlUnavailableError";
  }
}

/**
 * Resolve a FileSourceRef to a PUBLIC, internet-reachable URL for EXTERNAL
 * providers (PostPeer). Renders/uploads served by this lab need an absolute
 * public origin (PUBLIC_BASE_URL); cloud share links are already public. If a
 * render/upload is requested but PUBLIC_BASE_URL is unset we fail LOUDLY rather
 * than send a Docker-internal URL PostPeer could never fetch.
 */
export function resolvePublicSourceUrl(src: FileSourceRef): string {
  switch (src.kind) {
    case "render":
    case "upload": {
      const base = publicBaseUrl();
      if (!base) {
        throw new PublicUrlUnavailableError(
          "PUBLIC_BASE_URL isn't set, so PostPeer can't fetch your render. Set PUBLIC_BASE_URL to this server's public origin (e.g. https://clips.example.com) and try again.",
        );
      }
      const path = src.kind === "render" ? "outputs" : "uploads";
      return `${base}/api/${path}/${encodeURIComponent(src.ref)}`;
    }
    case "cloud":
      return normalizeCloudLink(src.ref);
    default:
      throw new Error(`Unknown file source kind: ${(src as FileSourceRef).kind}`);
  }
}

/**
 * Resolve a FileSourceRef to a LOCAL absolute file path for deep inspection
 * (ffprobe in the pre-flight validator). Only render/upload items live on this
 * server's disk; CLOUD share-links are remote and have no local file, so we
 * return null (the caller degrades those checks to `unknown` rather than
 * downloading the whole video just to probe it).
 *
 *   - render : served from outputsDir/<name> (a direct child; traversal-safe).
 *   - upload : resolved via the shared resolveInput() (files table → uploadsDir).
 *   - cloud  : null (no local file).
 *
 * Returns null on any miss (unknown id, deleted file) so callers never crash —
 * pre-flight then reports `unknown` for that item.
 */
export async function resolveLocalPath(src: FileSourceRef): Promise<string | null> {
  try {
    switch (src.kind) {
      case "render": {
        // outputs are served as a flat dir; keep this a direct child (no "..").
        const abs = path.resolve(config.outputsDir, src.ref);
        if (path.dirname(abs) !== path.resolve(config.outputsDir)) return null;
        return fs.existsSync(abs) ? abs : null;
      }
      case "upload":
        return await resolveInput(src.ref);
      case "cloud":
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** A safe-ish filename for the multipart fallback upload path. */
export function filenameFor(src: FileSourceRef): string {
  if (src.kind === "render") return src.ref;
  if (src.kind === "upload") return src.ref.endsWith(".mp4") ? src.ref : `${src.ref}.mp4`;
  // Cloud: derive from the path, default to .mp4 (short-form is video).
  try {
    const u = new URL(normalizeCloudLink(src.ref));
    const last = u.pathname.split("/").filter(Boolean).pop();
    if (last && /\.[a-z0-9]{2,4}$/i.test(last)) return last;
  } catch {
    /* ignore */
  }
  return "video.mp4";
}
