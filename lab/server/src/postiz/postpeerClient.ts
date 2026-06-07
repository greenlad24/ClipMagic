/**
 * Typed client for the PostPeer PUBLIC API (`/v1`).
 *
 * PostPeer is the Bulk Scheduler's SECOND posting provider: a pre-approved
 * TikTok Direct Post API. Unlike Postiz (a self-hosted container we reach over
 * the Docker network) PostPeer is an EXTERNAL SaaS, so it must be handed a
 * PUBLIC media URL — see fileSources.resolvePublicSourceUrl. Server-side only:
 * the API key never reaches the browser (getPostPeerApiKey()).
 *
 * ── API contract (verified against postpeer.dev docs + research, June 2026) ───
 *   Base URL : `${POSTPEER_BASE_URL || https://api.postpeer.dev}/v1`
 *              Source: www.postpeer.dev/docs (Getting Started),
 *              www.postpeer.dev/social-media-posting-api.
 *   Auth     : header `x-access-key: <apiKey>` (per-account dashboard key).
 *              NOT a Bearer token. Source: www.postpeer.dev/docs/connect-accounts.
 *
 *   GET  /connect/integrations
 *     → Array<{ id, platform, username?/handle?, displayName?/name?, avatarUrl?/picture? }>
 *       `id` is the accountId used in a post's `platforms[].accountId`;
 *       `platform` is the network key (tiktok, youtube, instagram, …). We filter
 *       to TikTok. Source: www.postpeer.dev/docs/connect-accounts (the docs note
 *       "use the `id` field as the accountId when publishing").
 *
 *   POST /posts
 *     body: { content, mediaItems: [{ type, url }], platforms: [{ platform, accountId,
 *             platformSpecificData? }], publishNow?, scheduledFor?, timezone?, draft? }
 *       - publishNow:true posts immediately; scheduledFor (ISO) + timezone schedules;
 *         draft:true creates a draft. Source: www.postpeer.dev/docs/publishing.
 *       - TikTok options live under platforms[].platformSpecificData. PostPeer
 *         surfaces TikTok's Direct-Post fields (privacy level, comment/duet/stitch
 *         toggles, commercial-content disclosure). The EXACT key names for these
 *         under platformSpecificData are NOT fully documented publicly, so they're
 *         isolated in buildTikTokPlatformData() below with the documented
 *         assumption + a TODO(live), exactly like Postiz's providerSettings.ts.
 *     → typically { success, postId, status, platforms: [{ platform, status,
 *       platformPostId?, platformPostUrl?, error? }] }; shape varies, so we return
 *       the raw JSON and treat any 2xx as success.
 *       Source: www.postpeer.dev/tiktok-posting-api (response example).
 *
 * Where a shape is uncertain it is kept permissive here (or behind the TikTok
 * adapter) with a TODO, so it's a one-line fix on the live server.
 */
import { getPostPeerApiKey } from "../settings/postizSecrets.js";

/** A connected social account in PostPeer ("integration"). */
export interface PostPeerAccount {
  /** The accountId used in platforms[].accountId. */
  id: string;
  /** Network key: tiktok, youtube, instagram, … */
  platform: string;
  /** @handle / username, when present. */
  username?: string;
  /** Display name for the UI. */
  name?: string;
  /** Avatar URL for the UI. */
  picture?: string;
}

/** TikTok Direct-Post options exposed by PostPeer. */
export interface PostPeerTikTokOptions {
  /**
   * Privacy level. TikTok's own enum values:
   *   PUBLIC_TO_EVERYONE | MUTUAL_FOLLOW_FRIENDS | FOLLOWER_OF_CREATOR | SELF_ONLY
   * (Source: developers.tiktok.com content-posting-api.) An account is only
   * eligible for PUBLIC_TO_EVERYONE once approved; otherwise TikTok/PostPeer
   * rejects it and the per-item error surfaces.
   */
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** Commercial-content disclosure (your own brand / paid partnership). */
  commercialContent: boolean;
}

export interface PostPeerCreatePostInput {
  accountId: string;
  /** PUBLIC media URL (external SaaS — must be internet-reachable). */
  mediaUrl: string;
  caption: string;
  /** ISO-8601 UTC; when set the post is SCHEDULED, else published now. */
  scheduledAt?: string;
  tiktok: PostPeerTikTokOptions;
  /** Create as a draft instead of scheduling/publishing. */
  draft?: boolean;
}

export class PostPeerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PostPeerApiError";
  }
}

/** PostPeer public-API base (external SaaS). */
export function postPeerBaseUrl(): string {
  const base = (process.env.POSTPEER_BASE_URL || "https://api.postpeer.dev").trim().replace(/\/+$/, "");
  return `${base}/v1`;
}

/** Whether a PostPeer API key is configured (does NOT expose it). */
export function postPeerApiConfigured(): boolean {
  return !!getPostPeerApiKey();
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = getPostPeerApiKey();
  if (!key) {
    throw new PostPeerApiError(
      "PostPeer API key not configured. Add it under Settings → Postiz (Bulk Scheduler group).",
      0,
    );
  }
  // PostPeer authenticates with the x-access-key header (NOT a Bearer token).
  return { "x-access-key": key, ...(extra ?? {}) };
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.POSTPEER_API_TIMEOUT_MS || "20000", 10);

async function request<T>(
  method: string,
  path: string,
  opts: { json?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${postPeerBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: authHeaders({
        ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      }),
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new PostPeerApiError(
      aborted
        ? `PostPeer request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : `PostPeer request failed: ${e instanceof Error ? e.message : String(e)}`,
      0,
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : typeof parsed === "string" && parsed
        ? parsed
        : `HTTP ${res.status}`;
    throw new PostPeerApiError(`PostPeer ${method} ${path} failed: ${msg}`, res.status, parsed);
  }
  return parsed as T;
}

/**
 * Build the `platformSpecificData` block for a TikTok post.
 *
 * ISOLATED here (like Postiz's providerSettings.ts) because PostPeer's exact
 * field names for TikTok's Direct-Post options aren't fully documented publicly.
 * We send the documented-intent shape: TikTok's own enum for `privacyLevel` and
 * the comment/duet/stitch + commercial-content toggles PostPeer says it exposes.
 *
 * TODO(live): confirm these key names against the running PostPeer account
 * (POST /v1/posts will 400 with a clear message if a name is off) and adjust.
 */
export function buildTikTokPlatformData(t: PostPeerTikTokOptions): Record<string, unknown> {
  return {
    privacyLevel: t.privacyLevel,
    allowComment: t.allowComment,
    allowDuet: t.allowDuet,
    allowStitch: t.allowStitch,
    // Commercial-content disclosure (TikTok requires it be declared up-front).
    commercialContent: t.commercialContent,
  };
}

export interface PostPeerClient {
  /** All connected accounts (optionally already filtered to TikTok). */
  listAccounts(): Promise<PostPeerAccount[]>;
  createPost(input: PostPeerCreatePostInput): Promise<unknown>;
}

/** Build a PostPeer public-API client bound to the configured key + base URL. */
export function createPostPeerClient(): PostPeerClient {
  return {
    async listAccounts() {
      const raw = await request<unknown>("GET", "/connect/integrations");
      // PostPeer wraps the list as { success, total, integrations: [...] }. Also
      // tolerate a bare array or a { data: [...] } envelope across versions.
      const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const arr = Array.isArray(raw)
        ? raw
        : obj && Array.isArray(obj.integrations)
        ? (obj.integrations as unknown[])
        : obj && Array.isArray(obj.data)
        ? (obj.data as unknown[])
        : [];
      return arr
        .map((it): PostPeerAccount | null => {
          if (!it || typeof it !== "object") return null;
          const o = it as Record<string, unknown>;
          const id = typeof o.id === "string" ? o.id : typeof o.accountId === "string" ? o.accountId : "";
          if (!id) return null;
          const platform = typeof o.platform === "string" ? o.platform.toLowerCase() : "unknown";
          // Field names vary; accept the common aliases for handle/name/avatar.
          const username =
            typeof o.username === "string" ? o.username : typeof o.handle === "string" ? o.handle : undefined;
          const name =
            typeof o.displayName === "string" ? o.displayName : typeof o.name === "string" ? o.name : username;
          const picture =
            typeof o.imageUrl === "string"
              ? o.imageUrl
              : typeof o.avatarUrl === "string"
              ? o.avatarUrl
              : typeof o.picture === "string"
              ? o.picture
              : undefined;
          return { id, platform, username, name, picture };
        })
        .filter((x): x is PostPeerAccount => x !== null);
    },

    async createPost(input) {
      // PostPeer's unified /posts endpoint: a video URL + per-platform routing.
      // PostPeer pulls the media and drives TikTok's multi-step upload/poll itself.
      const body: Record<string, unknown> = {
        content: input.caption,
        mediaItems: [{ type: "video", url: input.mediaUrl }],
        platforms: [
          {
            platform: "tiktok",
            accountId: input.accountId,
            platformSpecificData: buildTikTokPlatformData(input.tiktok),
          },
        ],
      };
      if (input.draft) {
        body.draft = true;
      } else if (input.scheduledAt) {
        // Schedule for a future instant. We always work in UTC ISO, so we pin the
        // timezone to UTC and let PostPeer schedule the exact instant.
        body.scheduledFor = new Date(input.scheduledAt).toISOString();
        body.timezone = "UTC";
      } else {
        body.publishNow = true;
      }
      return request<unknown>("POST", "/posts", { json: body });
    },
  };
}
