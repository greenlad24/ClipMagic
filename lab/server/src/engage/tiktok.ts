/**
 * TikTok read-only ingestion for the Engagement Manager (Phase 1: MONITOR only).
 *
 * Unlike YouTube (Data API key) and Meta (Graph token), TikTok has no first-party
 * read API for a creator's comments, so we scrape them via the Apify actor
 * `scrapeforge/tiktok-comments-extractor` (a PROFILE-based actor: given a username
 * or profile URL it walks that profile's recent videos and returns their comments +
 * replies). It's read-only and gated behind a stored Apify token — the whole path
 * is INERT until one is configured (apifyConfigured()), exactly like the YouTube-key
 * / Meta-token patterns.
 *
 * Apify runs cost credits, so the monitor polls TikTok on a SEPARATE SLOW cadence
 * (ENGAGE_TIKTOK_POLL_INTERVAL_MS, default 6h → ~4 runs/day) rather than every
 * 10-min cycle, keeping usage inside the free monthly credit.
 *
 * The comment→InboxItem mapping is a PURE function (parseTikTokComments) so it's
 * unit-testable against a captured actor response. Field access is DEFENSIVE: the
 * actor's output isn't fully documented, so every field is read with fallbacks and
 * items without an id/text are skipped. The token is NEVER logged.
 */
import { getApifyToken } from "../settings/postizSecrets.js";
import type { InboxItem } from "./types.js";

/** True when an Apify token is configured (TikTok monitoring is inert until then). */
export { apifyConfigured as tiktokConfigured } from "../settings/postizSecrets.js";

/**
 * A TikTok/Apify request failure. Thrown on HTTP/actor errors so the caller
 * (the monitor) can log once + skip the channel this cycle. `isAuth` marks a bad
 * token (HTTP 401) so callers can surface a "re-configure the token" hint.
 */
export class TikTokError extends Error {
  readonly status?: number;
  readonly isAuth: boolean;
  constructor(message: string, opts: { status?: number; isAuth?: boolean } = {}) {
    super(message);
    this.name = "TikTokError";
    this.status = opts.status;
    this.isAuth = opts.isAuth ?? false;
  }
}

/**
 * Injectable POST fetch (so the mapper + run flow are testable without network).
 * Narrow shape mirroring thumbnails/youtube.ts's FetchFn, but with a POST body.
 */
export type PostFetchFn = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

/** Resolve the injectable fetch (real fetch wrapped to the narrow POST shape). */
function resolveFetch(fetchImpl?: PostFetchFn): PostFetchFn {
  return (
    fetchImpl ??
    (async (u, init) => {
      const r = await fetch(u, init);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    })
  );
}

const APIFY_BASE = process.env.APIFY_BASE_URL || "https://api.apify.com";
const ACTOR = "scrapeforge~tiktok-comments-extractor";

/** Comments requested per video (actor input) — env override, default 10. */
function commentsPerPostDefault(): number {
  const raw = Number(process.env.ENGAGE_TIKTOK_COMMENTS_PER_POST);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 10;
}

/**
 * TOTAL cap (account-wide) on how many comments one run ingests: after scanning
 * ALL the profile's videos we keep only the N NEWEST comments across the whole
 * account. Env override (ENGAGE_TIKTOK_MAX_ITEMS), default 10, floored at 1.
 */
function maxItemsPerRun(): number {
  const raw = Number(process.env.ENGAGE_TIKTOK_MAX_ITEMS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10;
}

export interface FetchTikTokOptions {
  /** Comments requested per video (actor input). Defaults to ENGAGE_TIKTOK_COMMENTS_PER_POST / 10. */
  commentsPerPost?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: PostFetchFn;
}

/**
 * Fetch a TikTok profile's recent-video comments (+ replies) via the Apify actor,
 * mapped to InboxItems. `handle` is a username (with or without a leading @) or a
 * full profile URL — the actor accepts either. Returns items shaped for
 * insertInboxItem (channelId left blank — the monitor stamps the real id).
 *
 * Throws TikTokError on a missing token, an Apify HTTP error (401 → bad token), or
 * an actor run failure; the caller catches + skips. NEVER logs the token.
 */
export async function fetchTikTokComments(
  handle: string,
  opts: FetchTikTokOptions = {},
): Promise<Array<Omit<InboxItem, "id" | "ingestedAt" | "replyState">>> {
  const token = getApifyToken();
  if (!token) throw new TikTokError("Apify token not configured.");
  const raw = (handle || "").trim();
  if (!raw) return [];
  // Normalize to a full TikTok profile URL — the scrapeforge actor accepts profile
  // URLs unambiguously. Handles "@user", "user", or an already-full URL.
  const profile = /^https?:\/\//i.test(raw)
    ? raw
    : `https://www.tiktok.com/@${raw.replace(/^@+/, "")}`;
  const doFetch = resolveFetch(opts.fetchImpl);

  const body = {
    profileURLs: [profile],
    // Scan the ENTIRE account — every video (no resultsPerPage restriction). The
    // account-wide TOTAL cap (10 newest) is applied after mapping, below.
    commentsPerPost: opts.commentsPerPost ?? commentsPerPostDefault(),
    maxRepliesPerComment: 3,
    excludePinnedPosts: false,
    proxy: { useApifyProxy: true },
    harvestMode: true,
  };
  // run-sync-get-dataset-items runs the actor and returns the dataset (the comment
  // array) in one call. The token rides in the query string — never logged.
  const url = `${APIFY_BASE}/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new TikTokError(`Could not reach Apify: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) {
      throw new TikTokError("Apify token invalid — re-configure it in Settings.", { status: 401, isAuth: true });
    }
    const msg =
      (json && typeof json === "object" && (json.error?.message || json.message)) ||
      `Apify run failed (HTTP ${res.status}).`;
    throw new TikTokError(String(msg), { status: res.status });
  }
  // Scanned ALL videos → keep only the N NEWEST comments account-wide (postedAt
  // DESC; undated sort last). The monitor persists via insertInboxItem (dedup on
  // (platform, commentId)), so each run saves only the new ones among these.
  const mapped = parseTikTokComments(json);
  mapped.sort((a, b) => (b.postedAt ?? -Infinity) - (a.postedAt ?? -Infinity));
  return mapped.slice(0, maxItemsPerRun());
}

/** Build the deep-link permalink to the video a comment sits on. */
function firstString(...vals: any[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return null;
}

/** Parse a created timestamp (unix seconds OR ISO string) → epoch-ms, or null. */
function toEpochMs(createTime: any, createTimeISO: any, timestamp: any): number | null {
  // Unix SECONDS (the actor's numeric createTime) → ms.
  if (typeof createTime === "number" && Number.isFinite(createTime)) {
    return createTime > 1e12 ? Math.floor(createTime) : Math.floor(createTime * 1000);
  }
  const iso = firstString(createTimeISO, timestamp);
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Some actors emit createTime as a numeric string.
  const asNum = Number(createTime);
  if (Number.isFinite(asNum) && asNum > 0) {
    return asNum > 1e12 ? Math.floor(asNum) : Math.floor(asNum * 1000);
  }
  return null;
}

/**
 * Map ONE raw actor comment object → the InboxItem fields we ingest. Defensive
 * about field names (the actor output isn't fully documented) — reads each field
 * with fallbacks. Returns null when the comment has no usable id or text.
 *
 * `ctx.threadId` / `ctx.parentId` carry the top-level comment id for replies
 * (parentId null + threadId = own id for top-level comments).
 */
function mapComment(
  raw: any,
  ctx: { threadId: string | null; parentId: string | null },
): Omit<InboxItem, "id" | "ingestedAt" | "replyState"> | null {
  if (!raw || typeof raw !== "object") return null;
  const commentId = firstString(raw.commentId, raw.cid, raw.id);
  const text = firstString(raw.text, raw.comment);
  if (!commentId || !text) return null;

  const user = raw.user && typeof raw.user === "object" ? raw.user : {};
  const uniqueId = firstString(raw.uniqueId, user.uniqueId, raw.username, user.username);
  const authorHandle = uniqueId ? (uniqueId.startsWith("@") ? uniqueId : `@${uniqueId}`) : null;

  const videoUrl = firstString(raw.videoUrl, raw.videoWebUrl, raw.submittedVideoUrl);
  // Prefer an explicit id; else parse /video/{id} from the url.
  const videoId =
    firstString(raw.videoId, raw.awemeId) ??
    (videoUrl ? (videoUrl.match(/\/video\/(\d+)/)?.[1] ?? null) : null);
  const threadId = ctx.threadId ?? commentId;
  const permalink = videoUrl
    ? `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}comment_id=${encodeURIComponent(commentId)}`
    : null;

  return {
    channelId: "", // stamped by the monitor before insert.
    platform: "tiktok",
    kind: "comment",
    dedupKey: commentId,
    threadId,
    parentId: ctx.parentId,
    targetRef: videoId,
    targetTitle: videoUrl ?? firstString(raw.videoDesc, raw.desc),
    authorName: firstString(raw.nickname, user.nickname),
    authorHandle,
    authorId: firstString(raw.uid, user.uid, user.id, raw.userId),
    text,
    permalink,
    postedAt: toEpochMs(raw.createTime, raw.createTimeISO, raw.timestamp),
    source: "api",
  };
}

/**
 * Pure: map an Apify actor dataset (a JSON ARRAY of comment objects) into inbox
 * items — each top-level comment PLUS its nested `replies` (when present). A
 * reply's threadId + parentId are the top-level comment's id. Bounded to
 * MAX_MAPPED_ITEMS. Exported so the mapper is unit-testable against a captured
 * response. Never throws — a malformed entry is skipped.
 */
export function parseTikTokComments(
  data: any,
): Array<Omit<InboxItem, "id" | "ingestedAt" | "replyState">> {
  const items: any[] = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const out: Array<Omit<InboxItem, "id" | "ingestedAt" | "replyState">> = [];
  // A defensive upper bound so a huge/malformed dataset can't spin unbounded. The
  // fetch caller applies the strict per-run ingest cap (maxItemsPerRun) on top.
  const HARD_LIMIT = 5000;
  for (const raw of items) {
    const top = mapComment(raw, { threadId: null, parentId: null });
    if (!top) continue;
    out.push(top);
    if (out.length >= HARD_LIMIT) break;
    const replies: any[] = Array.isArray(raw?.replies) ? raw.replies : [];
    for (const replyRaw of replies) {
      const reply = mapComment(replyRaw, { threadId: top.threadId, parentId: top.dedupKey });
      if (reply) out.push(reply);
      if (out.length >= HARD_LIMIT) break;
    }
    if (out.length >= HARD_LIMIT) break;
  }
  return out;
}
