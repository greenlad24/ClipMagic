/**
 * Typed client for the Postiz PUBLIC API (`/public/v1`).
 *
 * The Bulk Scheduler uses this to read connected channels, upload media, and
 * create scheduled posts inside the self-hosted Postiz container — server-side
 * only (the API key never reaches the browser).
 *
 * ── API contract (verified against Postiz docs + source, June 2026) ──────────
 *   Base URL  : `${POSTIZ_INTERNAL_URL || http://postiz:5000}/public/v1`
 *               (self-hosted: `${NEXT_PUBLIC_BACKEND_URL}/public/v1`; we reach
 *               Postiz over the Docker network, so the internal name/port.)
 *   Auth      : `Authorization: <apiKey>`  — RAW key, NO "Bearer" prefix.
 *               (OAuth tokens start with `pos_` and are sent the same way.)
 *               Source: docs.postiz.com/public-api/introduction.
 *
 *   GET  /integrations
 *     → Array<{ id, name, identifier, picture, disabled, profile, customer }>
 *       `identifier` is the platform key (x, instagram, tiktok, youtube, …) —
 *       NOT a UUID. `id` is the channel id used everywhere else.
 *       Source: docs.postiz.com/public-api/integrations/list.
 *
 *   POST /upload                 (multipart/form-data, field `file`)
 *   POST /upload-from-url        ({ url })
 *     → { id, name, path, organizationId, createdAt, updatedAt }
 *       `path` is an absolute media URL. Attach `{ id }` (and we also pass
 *       `path`) in a post's `image` array.
 *       Source: docs.postiz.com/public-api/uploads/{upload-file,upload-from-url}.
 *       ⚠ KNOWN ISSUE (gitroomhq/postiz-app#1147): upload-from-url can return a
 *       `path` with NO file extension, which the create-post validator then
 *       rejects (400, "valid file extension"). We mitigate by preferring the
 *       multipart `upload` for server renders (we control the filename/ext) and
 *       by surfacing the raw error so the caller can fall back. See uploadFromUrl.
 *
 *   POST /posts
 *     body: { type: "draft"|"schedule"|"now", date: ISO-UTC, shortLink: boolean,
 *             tags: Tag[], posts: PostPerChannel[] }
 *       PostPerChannel = { integration: { id }, value: [{ content, image: [{ id }] }],
 *                          group?: string, settings: { __type: <identifier>, … } }
 *       `shortLink` + `tags` are REQUIRED even though older docs omit them
 *       (gitroomhq/postiz-app#717) — we always send them.
 *     → typically { postId, … } per channel; shape varies by version, so we
 *       return the raw JSON and treat any 2xx as success.
 *       Source: docs.postiz.com/public-api/posts/create + issue #717.
 *
 *   GET  /analytics/:integrationId         (best-effort)
 *     → Array<{ label, percentageChange, data: [{ total, date }] }>
 *       May be EMPTY for new/unverified accounts (Postiz returns empty, not an
 *       error). Source: docs.postiz.com/public-api/analytics/platform.
 *
 * Where a shape is version-sensitive (create-post response, per-provider
 * `settings`), it is isolated behind a small adapter (postiz/providerSettings.ts)
 * and/or kept permissive here, with TODOs, so it's a one-line fix on the live
 * server.
 */
import { getPostizApiKey } from "../settings/postizSecrets.js";

/** A connected channel ("integration" in Postiz's API; "channel" in its UI). */
export interface PostizIntegration {
  id: string;
  name: string;
  /** Platform key: x, linkedin, instagram, tiktok, youtube, … */
  identifier: string;
  picture?: string;
  disabled?: boolean;
  profile?: string;
}

/** Result of an /upload or /upload-from-url call. */
export interface PostizUpload {
  id: string;
  name?: string;
  path: string;
}

/** One per-channel entry inside a create-post request. */
export interface PostizPostPerChannel {
  integration: { id: string };
  value: Array<{ content: string; image?: Array<{ id: string }> }>;
  /** Groups posts created together (Postiz uses it to relate multi-channel posts). */
  group?: string;
  /** Per-provider settings; always carries `__type` = the channel identifier. */
  settings: Record<string, unknown> & { __type: string };
}

export interface CreatePostInput {
  type: "draft" | "schedule" | "now";
  /** ISO-8601 UTC, e.g. "2026-06-09T12:10:00.000Z". */
  date: string;
  posts: PostizPostPerChannel[];
  shortLink?: boolean;
  tags?: Array<{ value: string; label: string }>;
}

/** One analytics series for a channel (best-effort; may be absent). */
export interface PostizAnalyticsSeries {
  label: string;
  percentageChange?: number;
  data: Array<{ total: string | number; date: string }>;
}

export class PostizApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "PostizApiError";
  }
}

/** Internal Postiz base, reachable over the Docker network. */
export function postizBaseUrl(): string {
  const base = (process.env.POSTIZ_INTERNAL_URL || "http://postiz:5000").trim().replace(/\/+$/, "");
  return `${base}/public/v1`;
}

/** Whether an API key is configured (does NOT expose it). */
export function postizApiConfigured(): boolean {
  return !!getPostizApiKey();
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = getPostizApiKey();
  if (!key) {
    throw new PostizApiError(
      "Postiz API key not configured. Add it under Settings → Postiz (Bulk Scheduler group).",
      0,
    );
  }
  // RAW key — Postiz's public API does NOT use a Bearer prefix.
  return { Authorization: key, ...(extra ?? {}) };
}

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.POSTIZ_API_TIMEOUT_MS || "20000", 10);

async function request<T>(
  method: string,
  path: string,
  // `body` is a FormData (multipart upload); typed loosely since the server's TS
  // lib is ES2022-only (no DOM `BodyInit`) — fetch/FormData come from @types/node.
  opts: { json?: unknown; body?: FormData; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const url = `${postizBaseUrl()}${path}`;
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
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new PostizApiError(
      aborted ? `Postiz request timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : `Postiz request failed: ${e instanceof Error ? e.message : String(e)}`,
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
      (parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : typeof parsed === "string" && parsed
        ? parsed
        : `HTTP ${res.status}`);
    throw new PostizApiError(`Postiz ${method} ${path} failed: ${msg}`, res.status, parsed);
  }
  return parsed as T;
}

export interface PostizClient {
  listIntegrations(): Promise<PostizIntegration[]>;
  uploadFromUrl(url: string): Promise<PostizUpload>;
  upload(file: Buffer | Uint8Array, filename: string, contentType?: string): Promise<PostizUpload>;
  createPost(input: CreatePostInput): Promise<unknown>;
  getAnalytics(integrationId: string): Promise<PostizAnalyticsSeries[]>;
}

/** Build a Postiz public-API client bound to the configured key + internal URL. */
export function createPostizClient(): PostizClient {
  return {
    async listIntegrations() {
      const raw = await request<unknown>("GET", "/integrations");
      const arr = Array.isArray(raw) ? raw : [];
      // Tolerate extra/missing fields across Postiz versions; keep only what we use.
      return arr
        .map((it): PostizIntegration | null => {
          if (!it || typeof it !== "object") return null;
          const o = it as Record<string, unknown>;
          if (typeof o.id !== "string") return null;
          return {
            id: o.id,
            name: typeof o.name === "string" ? o.name : o.id,
            identifier: typeof o.identifier === "string" ? o.identifier : "unknown",
            picture: typeof o.picture === "string" ? o.picture : undefined,
            disabled: typeof o.disabled === "boolean" ? o.disabled : false,
            profile: typeof o.profile === "string" ? o.profile : undefined,
          };
        })
        .filter((x): x is PostizIntegration => x !== null);
    },

    async uploadFromUrl(mediaUrl: string) {
      // TODO(live): if Postiz rejects the resulting `path` for a missing file
      // extension (issue #1147), fall back to downloading + multipart upload().
      const r = await request<Record<string, unknown>>("POST", "/upload-from-url", {
        json: { url: mediaUrl },
      });
      return normalizeUpload(r);
    },

    async upload(file, filename, contentType) {
      const form = new FormData();
      const blob = new Blob([file], contentType ? { type: contentType } : undefined);
      form.append("file", blob, filename);
      // Let fetch set the multipart boundary; only pass the auth header.
      const r = await request<Record<string, unknown>>("POST", "/upload", {
        body: form,
      });
      return normalizeUpload(r);
    },

    async createPost(input) {
      // Always include shortLink + tags (required by the validator even when the
      // older docs omit them — issue #717).
      const body: CreatePostInput = {
        type: input.type,
        date: input.date,
        shortLink: input.shortLink ?? false,
        tags: input.tags ?? [],
        posts: input.posts,
      };
      return request<unknown>("POST", "/posts", { json: body });
    },

    async getAnalytics(integrationId) {
      // Best-effort: empty for new/unverified accounts. Never throw on an empty
      // body; only real HTTP errors propagate (the caller treats those as "no
      // analytics" too — see scheduling.refineWithAnalytics).
      const raw = await request<unknown>("GET", `/analytics/${encodeURIComponent(integrationId)}`);
      if (!Array.isArray(raw)) return [];
      return raw
        .map((s): PostizAnalyticsSeries | null => {
          if (!s || typeof s !== "object") return null;
          const o = s as Record<string, unknown>;
          const data = Array.isArray(o.data)
            ? o.data
                .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
                .map((d) => ({ total: (d.total as string | number) ?? 0, date: String(d.date ?? "") }))
            : [];
          return {
            label: typeof o.label === "string" ? o.label : "metric",
            percentageChange: typeof o.percentageChange === "number" ? o.percentageChange : undefined,
            data,
          };
        })
        .filter((x): x is PostizAnalyticsSeries => x !== null);
    },
  };
}

function normalizeUpload(r: Record<string, unknown>): PostizUpload {
  const id = typeof r.id === "string" ? r.id : "";
  const path = typeof r.path === "string" ? r.path : "";
  if (!id || !path) {
    throw new PostizApiError("Postiz upload returned no id/path", 0, r);
  }
  return { id, path, name: typeof r.name === "string" ? r.name : undefined };
}
