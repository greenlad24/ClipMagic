/**
 * YouTube read-only ingestion for the Engagement Manager (Phase 1: MONITOR only).
 *
 * Everything here uses the YouTube Data API KEY (no OAuth) — we only READ public
 * comments into the inbox; make.com already handles replies. Reuses the shared
 * key getter, the injectable FetchFn, and YoutubeQuotaError from
 * thumbnails/youtube.ts so quota accounting + testability stay identical.
 *
 * Quota per cycle is bounded: channels.list (1u) to resolve, playlistItems.list
 * (1u) for recent uploads, commentThreads.list (1u/video). A YoutubeQuotaError is
 * rethrown so the monitor can stop the cycle and resume next interval.
 *
 * The comment→InboxItem mapping is a PURE function (parseCommentThreads) so it's
 * unit-testable against a captured commentThreads.list response.
 */
import { getYoutubeDataApiKey } from "../settings/postizSecrets.js";
import {
  YoutubeQuotaError,
  fetchChannelStats,
  fetchVideoStats,
  type FetchFn,
} from "../thumbnails/youtube.js";
import type { InboxItem } from "./types.js";

export { YoutubeQuotaError } from "../thumbnails/youtube.js";
export { youtubeConfigured } from "../thumbnails/youtube.js";

const YT_BASE = process.env.YOUTUBE_BASE_URL || "https://www.googleapis.com";

const CHANNEL_ID_RE = /^UC[0-9A-Za-z_-]{22}$/;

/** True when a YouTube API error payload/status indicates quota exhaustion. */
function isQuotaError(json: any): boolean {
  const reason = json?.error?.errors?.[0]?.reason || json?.error?.status;
  return reason === "quotaExceeded" || reason === "rateLimitExceeded" || reason === "dailyLimitExceeded";
}

/** True when a video's comments are disabled / forbidden (skip, don't throw). */
function isCommentsDisabled(status: number, json: any): boolean {
  const reason = json?.error?.errors?.[0]?.reason || json?.error?.status;
  return reason === "commentsDisabled" || reason === "forbidden" || (status === 403 && !isQuotaError(json));
}

/** Resolve the injectable fetch once (real fetch wrapped to the narrow shape). */
function resolveFetch(fetchImpl?: FetchFn): FetchFn {
  return (
    fetchImpl ??
    // Reads only today, but forward `init` anyway — the sibling wrapper in
    // metaGraph.ts dropping it is what made every Meta write a silent GET.
    (async (u, init) => {
      const r = await fetch(u, init as RequestInit | undefined);
      return { ok: r.ok, status: r.status, json: () => r.json() };
    })
  );
}

/** GET + parse a YouTube Data API URL. Throws YoutubeQuotaError on quota; Error otherwise. */
async function ytGetJson(url: string, doFetch: FetchFn): Promise<any> {
  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(url);
  } catch (e) {
    throw new Error(`Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (isQuotaError(json)) throw new YoutubeQuotaError(`YouTube API quota exceeded: ${json?.error?.message || res.status}`);
    throw new Error(`YouTube API HTTP ${res.status}: ${json?.error?.message || "request failed"}`);
  }
  return json;
}

// ── channel resolution ────────────────────────────────────────────────────────

export interface ResolvedChannel {
  channelId: string;
  uploadsPlaylistId: string | null;
  title: string;
  thumbnail: string | null;
}

/**
 * Resolve a @handle (or UC… channel id) to its channel id + uploads playlist +
 * profile, via channels.list?part=snippet,contentDetails. Accepts "@handle",
 * "handle", or a bare UCxxxx id. Returns null when nothing matches. Throws
 * YoutubeQuotaError on quota.
 */
export async function resolveChannel(handleOrId: string, fetchImpl?: FetchFn): Promise<ResolvedChannel | null> {
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  const raw = (handleOrId || "").trim();
  if (!raw) return null;
  const doFetch = resolveFetch(fetchImpl);

  const params = new URLSearchParams({ part: "snippet,contentDetails", key });
  if (CHANNEL_ID_RE.test(raw)) {
    params.set("id", raw);
  } else {
    params.set("forHandle", raw.replace(/^@/, ""));
  }
  const json = await ytGetJson(`${YT_BASE}/youtube/v3/channels?${params.toString()}`, doFetch);
  const item = json?.items?.[0];
  if (!item) return null;
  const channelId = typeof item?.id === "string" ? item.id : null;
  if (!channelId) return null;
  const uploads = item?.contentDetails?.relatedPlaylists?.uploads;
  const thumbs = item?.snippet?.thumbnails;
  const thumbnail =
    (typeof thumbs?.default?.url === "string" && thumbs.default.url) ||
    (typeof thumbs?.medium?.url === "string" && thumbs.medium.url) ||
    null;
  return {
    channelId,
    uploadsPlaylistId: typeof uploads === "string" && uploads ? uploads : null,
    title: typeof item?.snippet?.title === "string" ? item.snippet.title : "",
    thumbnail,
  };
}

// ── recent uploads ────────────────────────────────────────────────────────────

export interface RecentVideo {
  videoId: string;
  title: string;
  publishedAt: string | null;
}

/**
 * The most-recent uploads on a channel's uploads playlist (default 15), via
 * playlistItems.list?part=contentDetails. Ordered newest-first by the playlist.
 * Throws YoutubeQuotaError on quota.
 */
export async function recentVideoIds(uploadsPlaylistId: string, max = 15, fetchImpl?: FetchFn): Promise<RecentVideo[]> {
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  if (!uploadsPlaylistId) return [];
  const doFetch = resolveFetch(fetchImpl);
  const params = new URLSearchParams({
    part: "contentDetails,snippet",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.max(1, Math.min(50, max))),
    key,
  });
  const json = await ytGetJson(`${YT_BASE}/youtube/v3/playlistItems?${params.toString()}`, doFetch);
  return parseRecentVideos(json);
}

/** Pure: map a playlistItems.list response → recent videos. Exported for tests. */
export function parseRecentVideos(json: any): RecentVideo[] {
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  const out: RecentVideo[] = [];
  for (const it of items) {
    const videoId = it?.contentDetails?.videoId ?? it?.snippet?.resourceId?.videoId;
    if (typeof videoId !== "string" || !videoId) continue;
    out.push({
      videoId,
      title: typeof it?.snippet?.title === "string" ? it.snippet.title : "",
      publishedAt:
        typeof it?.contentDetails?.videoPublishedAt === "string"
          ? it.contentDetails.videoPublishedAt
          : typeof it?.snippet?.publishedAt === "string"
            ? it.snippet.publishedAt
            : null,
    });
  }
  return out;
}

// ── engagement stats (subscribers · comments · likes) ─────────────────────────

/** A channel's engagement snapshot (counts only; the DB stamps updatedAt). */
export interface ChannelEngagementStats {
  /** Subscriber count (null when the channel hides it). */
  audience: number | null;
  /** Σ commentCount across the channel's recent videos (null when none scanned). */
  comments: number | null;
  /** Σ likeCount across the channel's recent videos (null when none scanned). */
  likes: number | null;
}

/**
 * Fetch a channel's engagement snapshot using the API KEY (no OAuth):
 *   - audience  = subscriberCount via channels.list (1u) — reuses fetchChannelStats.
 *   - comments  = Σ commentCount, likes = Σ likeCount across the channel's recent
 *     videos — recentVideoIds(uploadsPlaylistId, 15) (1u) → fetchVideoStats (1u).
 * ~2 quota units/call; the monitor throttles this to ENGAGE_STATS_TTL_MS. Throws
 * YoutubeQuotaError on quota (the caller catches — stats are best-effort).
 */
export async function fetchChannelEngagementStats(
  channelId: string,
  uploadsPlaylistId: string | null,
  fetchImpl?: FetchFn,
): Promise<ChannelEngagementStats> {
  const chStats = await fetchChannelStats([channelId], fetchImpl);
  const audience = chStats.get(channelId)?.subscriberCount ?? null;

  let comments: number | null = null;
  let likes: number | null = null;
  if (uploadsPlaylistId) {
    const videos = await recentVideoIds(uploadsPlaylistId, 15, fetchImpl);
    const ids = videos.map((v) => v.videoId);
    if (ids.length > 0) {
      const vstats = await fetchVideoStats(ids, fetchImpl);
      comments = 0;
      likes = 0;
      for (const s of vstats.values()) {
        comments += s.comments;
        likes += s.likes;
      }
    }
  }
  return { audience, comments, likes };
}

// ── comments ──────────────────────────────────────────────────────────────────

const WATCH_BASE = "https://www.youtube.com/watch";

/** Build the deep-link permalink to a specific comment on a video. */
function commentPermalink(videoId: string, commentId: string): string {
  return `${WATCH_BASE}?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(commentId)}`;
}

/** Map one YouTube comment resource → the InboxItem fields we ingest. */
function mapComment(
  comment: any,
  ctx: { channelId: string; videoId: string; videoTitle: string; threadId: string; parentId: string | null },
): Omit<InboxItem, "id" | "ingestedAt" | "replyState"> | null {
  const commentId = comment?.id;
  const sn = comment?.snippet;
  if (typeof commentId !== "string" || !commentId || !sn) return null;
  // Prefer textOriginal (the raw typed text) over textDisplay (which carries HTML
  // tags + entities like &#39; / <a href>). Normalize either to clean plain text.
  const rawText =
    typeof sn?.textOriginal === "string" && sn.textOriginal.trim()
      ? sn.textOriginal
      : typeof sn?.textDisplay === "string"
      ? sn.textDisplay
      : "";
  const text = rawText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const postedRaw = typeof sn?.publishedAt === "string" ? Date.parse(sn.publishedAt) : NaN;
  return {
    channelId: ctx.channelId,
    platform: "youtube",
    kind: "comment",
    dedupKey: commentId,
    threadId: ctx.threadId,
    parentId: ctx.parentId,
    targetRef: ctx.videoId,
    targetTitle: ctx.videoTitle,
    authorName: typeof sn?.authorDisplayName === "string" ? sn.authorDisplayName : null,
    authorHandle: typeof sn?.authorDisplayName === "string" ? sn.authorDisplayName : null,
    authorId:
      typeof sn?.authorChannelId?.value === "string"
        ? sn.authorChannelId.value
        : typeof sn?.authorChannelId === "string"
          ? sn.authorChannelId
          : null,
    text,
    permalink: commentPermalink(ctx.videoId, commentId),
    postedAt: Number.isFinite(postedRaw) ? postedRaw : null,
    source: "api",
  };
}

/**
 * Pure: map a commentThreads.list (part=snippet,replies) response into inbox
 * items — the top-level comment of each thread PLUS its `replies.comments`.
 * threadId = topLevelComment id; a reply's parentId = that thread id. Exported so
 * the mapper is unit-testable against a captured response.
 */
export function parseCommentThreads(
  json: any,
  videoId: string,
  videoTitle: string,
  channelId: string,
): Array<Omit<InboxItem, "id" | "ingestedAt" | "replyState">> {
  const items: any[] = Array.isArray(json?.items) ? json.items : [];
  const out: Array<Omit<InboxItem, "id" | "ingestedAt" | "replyState">> = [];
  for (const thread of items) {
    const top = thread?.snippet?.topLevelComment;
    const threadId = typeof top?.id === "string" ? top.id : null;
    if (!threadId) continue;
    const topItem = mapComment(top, { channelId, videoId, videoTitle, threadId, parentId: null });
    if (topItem) out.push(topItem);
    const replies: any[] = Array.isArray(thread?.replies?.comments) ? thread.replies.comments : [];
    for (const reply of replies) {
      const r = mapComment(reply, { channelId, videoId, videoTitle, threadId, parentId: threadId });
      if (r) out.push(r);
    }
  }
  return out;
}

/** Max replies we page for under one top-level comment — bounds quota per thread. */
const MAX_REPLIES_PER_THREAD = 200;

/**
 * Fetch ALL replies under one top-level comment via comments.list?part=snippet&
 * parentId=<topLevelCommentId>, paging nextPageToken. Returns the raw YouTube
 * comment resources (the caller maps them with the thread's context). Bounded to
 * MAX_REPLIES_PER_THREAD to cap quota on a viral thread. Throws YoutubeQuotaError
 * on quota (so the monitor stops the cycle).
 */
export async function fetchReplies(parentId: string, fetchImpl?: FetchFn): Promise<any[]> {
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  if (!parentId) return [];
  const doFetch = resolveFetch(fetchImpl);

  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ part: "snippet", parentId, maxResults: "100", key });
    if (pageToken) params.set("pageToken", pageToken);
    const json = await ytGetJson(`${YT_BASE}/youtube/v3/comments?${params.toString()}`, doFetch);
    const items: any[] = Array.isArray(json?.items) ? json.items : [];
    for (const it of items) {
      out.push(it);
      if (out.length >= MAX_REPLIES_PER_THREAD) return out;
    }
    pageToken = typeof json?.nextPageToken === "string" ? json.nextPageToken : undefined;
  } while (pageToken);
  return out;
}

/**
 * Fetch up to `max` recent comment threads (+ their replies) on a video, mapped
 * to InboxItems. Uses commentThreads.list?part=snippet,replies&order=time.
 *
 * commentThreads returns only up to ~5 INLINE replies per thread. When a thread's
 * snippet.totalReplyCount exceeds the inline replies returned, we page the FULL
 * reply tree via fetchReplies (comments.list?parentId=…) so the channel column can
 * render the complete thread. The extra call is made ONLY for those threads
 * (totalReplyCount > inline count), so threads with ≤ inline replies cost nothing
 * extra. Newly-fetched replies are de-duped against the inline ones by comment id
 * (downstream insertInboxItem also dedups on (platform, dedup_key), so re-ingest
 * is safe).
 *
 * Comments-disabled / forbidden videos are SKIPPED (returns []) rather than
 * throwing, so one locked video can't stall a channel's poll. A quota error IS
 * thrown (YoutubeQuotaError) so the monitor stops the cycle.
 */
export async function fetchComments(
  videoId: string,
  videoTitle: string,
  channelId: string,
  max = 50,
  fetchImpl?: FetchFn,
): Promise<Array<Omit<InboxItem, "id" | "ingestedAt" | "replyState">>> {
  const key = getYoutubeDataApiKey();
  if (!key) throw new Error("YouTube Data API key not configured.");
  if (!videoId) return [];
  const doFetch = resolveFetch(fetchImpl);
  const params = new URLSearchParams({
    part: "snippet,replies",
    videoId,
    order: "time",
    maxResults: String(Math.max(1, Math.min(100, max))),
    key,
  });
  const url = `${YT_BASE}/youtube/v3/commentThreads?${params.toString()}`;

  let res: { ok: boolean; status: number; json: () => Promise<any> };
  try {
    res = await doFetch(url);
  } catch (e) {
    throw new Error(`Could not reach the YouTube Data API: ${e instanceof Error ? e.message : String(e)}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (isQuotaError(json)) throw new YoutubeQuotaError(`YouTube API quota exceeded: ${json?.error?.message || res.status}`);
    if (isCommentsDisabled(res.status, json)) return []; // locked video — skip gracefully.
    throw new Error(`YouTube commentThreads failed (video ${videoId}): ${json?.error?.message || `HTTP ${res.status}`}`);
  }

  const out = parseCommentThreads(json, videoId, videoTitle, channelId);

  // For any thread whose total reply count exceeds what came inline, page the
  // remaining replies so the tree is complete. Bounded: only fetch-all when
  // totalReplyCount > inline count.
  const seen = new Set(out.map((i) => i.dedupKey));
  const threads: any[] = Array.isArray(json?.items) ? json.items : [];
  for (const thread of threads) {
    const top = thread?.snippet?.topLevelComment;
    const threadId = typeof top?.id === "string" ? top.id : null;
    if (!threadId) continue;
    const inlineCount = Array.isArray(thread?.replies?.comments) ? thread.replies.comments.length : 0;
    const totalReplyCount =
      typeof thread?.snippet?.totalReplyCount === "number" ? thread.snippet.totalReplyCount : 0;
    if (totalReplyCount <= inlineCount) continue; // inline replies are complete.

    const replies = await fetchReplies(threadId, fetchImpl);
    for (const reply of replies) {
      const mapped = mapComment(reply, { channelId, videoId, videoTitle, threadId, parentId: threadId });
      if (mapped && !seen.has(mapped.dedupKey)) {
        seen.add(mapped.dedupKey);
        out.push(mapped);
      }
    }
  }

  return out;
}
