/**
 * Engagement Manager — shared contract (types only, no logic).
 *
 * Phase 1 scope: MONITOR connected social channels' comments/DMs into a single
 * inbox. YouTube is read-only (make.com already replies to YT comments). The
 * reply-side types (ReplyRecord, ReplyState, rate windows) are declared now so
 * later phases (IG/FB/TikTok auto-reply via the browser agent) add no migration.
 *
 * Mirrors the style of keyword/types.ts + scriptgen/types.ts.
 */

export type Platform = "youtube" | "instagram" | "facebook" | "tiktok";

export type InboxKind = "comment" | "dm";

/** How an item was fetched. */
export type IngestSource = "api" | "browser-scrape";

/** Per-channel autonomy: off = don't reply, suggest = draft for approval, auto = send. */
export type ReplyMode = "off" | "suggest" | "auto";

/** Lifecycle of an inbound item's reply. */
export type ReplyState = "new" | "queued" | "replied" | "skipped" | "failed";

/** Per-channel engagement snapshot shown at the top of a channel column. */
export interface ChannelStats {
  /** Subscribers (YouTube) or followers (IG/FB/TikTok). UI labels per platform. */
  audience: number | null;
  /** Comments across recent posts/videos (engagement read). */
  comments: number | null;
  /** Likes across recent posts/videos. */
  likes: number | null;
  /** Last refresh (epoch-ms), null if never fetched. */
  updatedAt: number | null;
}

/** A monitored social channel (seeded from the connected Postiz/PostPeer channels). */
export interface EngageChannel {
  /** Our id (nanoid). */
  id: string;
  platform: Platform;
  /** Platform-native id — YouTube channelId (UC…), IG user id, FB Page id, TikTok handle. */
  externalId: string;
  handle: string | null;
  displayName: string | null;
  picture: string | null;
  /** Per-channel monitor toggle. */
  enabled: boolean;
  /** Reply behavior (Phase 1: always 'off' for YouTube — monitor only). */
  replyMode: ReplyMode;
  /** Engagement snapshot (subs/followers · comments · likes). null until fetched. */
  stats: ChannelStats | null;
  createdAt: number;
  updatedAt: number;
}

/** One inbound comment or DM we've seen. */
export interface InboxItem {
  id: string;
  channelId: string;
  platform: Platform;
  kind: InboxKind;
  /** Platform-native id used for idempotent de-duplication (UNIQUE(platform,dedupKey)). */
  dedupKey: string;
  /** Top-level comment / conversation id. */
  threadId: string | null;
  /** Parent comment id for nested replies. */
  parentId: string | null;
  /** The video/post/media id the item sits on. */
  targetRef: string | null;
  /** Human-readable target (e.g. the video title) for context. */
  targetTitle: string | null;
  authorName: string | null;
  authorHandle: string | null;
  authorId: string | null;
  text: string;
  permalink: string | null;
  /** When THEY posted it (platform timestamp, epoch-ms). */
  postedAt: number | null;
  /** When WE ingested it (epoch-ms). */
  ingestedAt: number;
  source: IngestSource;
  replyState: ReplyState;
}

/** A generated/sent reply record (populated by later phases). */
export interface ReplyRecord {
  id: string;
  inboxId: string;
  channelId: string;
  platform: Platform;
  status: "pending" | "sent" | "failed" | "skipped";
  mechanism: "youtube-api" | "browser" | null;
  generatedText: string | null;
  decideReason: string | null;
  /** Earliest dispatch time (human-pacing), epoch-ms. */
  notBefore: number;
  attempts: number;
  externalReplyId: string | null;
  error: string | null;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

/** Per-platform rate caps (used by the throttle in later phases). */
export interface RateCaps {
  hour: number;
  day: number;
}

/** Human-pacing config. */
export interface Pacing {
  minDelaySec: number;
  maxDelaySec: number;
  /** Local active-hours window [startHour, endHour] (24h). */
  activeHours: [number, number];
}

/** Singleton settings row. */
export interface EngageSettings {
  /** Master safety switch — STARTS ON (true = autonomy disabled). */
  killSwitch: boolean;
  globalAutoreply: boolean;
  caps: Partial<Record<Platform, RateCaps>>;
  pacing: Pacing;
  /** The user-supplied reply prompt (.md), stored so it survives restarts. */
  replyPromptMd: string | null;
  updatedAt: number;
}

/** Live status for the UI (config + rolled-up counts). */
export interface EngageStatus {
  /** Is the YouTube Data API key present (monitoring needs it). */
  youtubeConfigured: boolean;
  channels: EngageChannel[];
  killSwitch: boolean;
  globalAutoreply: boolean;
  /** Rolled-up inbox counts. */
  counts: {
    total: number;
    new: number;
    byPlatform: Partial<Record<Platform, number>>;
  };
  /** Last successful monitor cycle (epoch-ms), null if never. */
  lastPollAt: number | null;
  /** Whether a monitor cycle is currently running. */
  polling: boolean;
  /** Non-fatal last-cycle error, surfaced to the UI. */
  lastError: string | null;
}

// ── Handler I/O (Phase 1) ────────────────────────────────────────────────────

export interface ListInboxInput {
  platform?: Platform;
  kind?: InboxKind;
  replyState?: ReplyState;
  channelId?: string;
  /** Free-text search over author/text. */
  q?: string;
  limit?: number;
  offset?: number;
}
export interface ListInboxOutput {
  items: InboxItem[];
  total: number;
}

export interface GetThreadInput {
  inboxId: string;
}
export interface GetThreadOutput {
  item: InboxItem | null;
  /** Sibling replies under the same thread (chronological). */
  thread: InboxItem[];
  reply: ReplyRecord | null;
}

/** A top-level comment plus its full reply tree — the unit a channel column renders. */
export interface InboxThread {
  /** The top-level comment (parentId null). */
  root: InboxItem;
  /** All replies under this thread, chronological (oldest → newest). */
  replies: InboxItem[];
  /** Total replies (== replies.length once fully ingested). */
  replyCount: number;
  /** Most recent activity in the thread (max postedAt of root+replies) for ordering. */
  lastActivityAt: number | null;
}
/**
 * Thread ordering:
 *  - 'newest'  — by the TOP-LEVEL (first) comment's postedAt, newest first (default).
 *  - 'oldest'  — by the top-level comment's postedAt, oldest first.
 *  - 'active'  — by most recent activity (any reply bumps the thread up).
 *  - 'replies' — most-replied threads first.
 */
export type ThreadSort = "newest" | "oldest" | "active" | "replies";

export interface ListThreadsInput {
  channelId?: string;
  platform?: Platform;
  kind?: InboxKind;
  q?: string;
  sort?: ThreadSort;
  limit?: number;
  offset?: number;
}
export interface ListThreadsOutput {
  threads: InboxThread[];
  /** Total top-level threads matching the filter. */
  total: number;
}

export interface SetChannelModeInput {
  channelId: string;
  enabled?: boolean;
  replyMode?: ReplyMode;
}

export interface KillSwitchInput {
  killSwitch: boolean;
}

export interface RefreshChannelsOutput {
  channels: EngageChannel[];
}

/** Trigger a monitor cycle now (in addition to the background loop). */
export interface PollNowOutput {
  started: boolean;
  message?: string;
}
