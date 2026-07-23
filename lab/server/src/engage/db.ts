/**
 * Typed CRUD over the Engagement Manager tables (engage_channels, engage_inbox,
 * engage_replies, engage_settings — defined in db/index.ts). Mirrors
 * db/scriptRuns.ts + db/keywordResearch.ts: plain better-sqlite3 prepared
 * statements, nanoid() ids, Date.now() timestamps, JSON columns hydrated back
 * into the camelCase contract types.
 *
 * Phase 1 is monitor-only: the inbox is written by the poll loop (idempotent on
 * (platform, dedup_key)) and read by the UI. Reply-side reads (getReplyForInbox)
 * are declared now so the thread view has no shape change in later phases.
 */
import { nanoid } from "nanoid";
import { db } from "../db/index.js";
import type {
  ChannelStats,
  EngageChannel,
  EngageSettings,
  InboxItem,
  InboxKind,
  Platform,
  Pacing,
  RateCaps,
  ReplyMode,
  ReplyRecord,
  ReplyState,
  ListInboxInput,
  ListThreadsInput,
  ThreadSort,
  InboxThread,
} from "./types.js";

const now = () => Date.now();

// ── engage_channels ───────────────────────────────────────────────────────────

interface ChannelRow {
  id: string;
  platform: string;
  external_id: string;
  handle: string | null;
  display_name: string | null;
  picture: string | null;
  enabled: number;
  reply_mode: string;
  uploads_playlist_id: string | null;
  audience_count: number | null;
  comment_count: number | null;
  like_count: number | null;
  stats_updated_at: number | null;
  access_token: string | null;
  meta_page_id: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Hydrate the stats null-object: `stats_updated_at` null = never fetched, so the
 * channel reads `stats: null`. Once refreshed, the three counts (individually
 * nullable — e.g. a hidden subscriber count) ride under a non-null snapshot.
 */
function rowToStats(row: ChannelRow): ChannelStats | null {
  if (row.stats_updated_at == null) return null;
  return {
    audience: row.audience_count,
    comments: row.comment_count,
    likes: row.like_count,
    updatedAt: row.stats_updated_at,
  };
}

function rowToChannel(row: ChannelRow): EngageChannel {
  return {
    id: row.id,
    platform: row.platform as Platform,
    externalId: row.external_id,
    handle: row.handle,
    displayName: row.display_name,
    picture: row.picture,
    enabled: !!row.enabled,
    replyMode: row.reply_mode as ReplyMode,
    stats: rowToStats(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertChannelInput {
  platform: Platform;
  externalId: string;
  handle?: string | null;
  displayName?: string | null;
  picture?: string | null;
  uploadsPlaylistId?: string | null;
}

/**
 * INSERT-or-UPDATE a monitored channel keyed on (platform, external_id). On a
 * repeat seed we refresh the profile fields (handle/name/picture/uploads) but
 * PRESERVE the user's per-channel enabled + reply_mode toggles. Returns the row.
 */
export function upsertChannel(input: UpsertChannelInput): EngageChannel {
  const t = now();
  const existing = db
    .prepare("SELECT * FROM engage_channels WHERE platform = ? AND external_id = ?")
    .get(input.platform, input.externalId) as ChannelRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE engage_channels
         SET handle = COALESCE(?, handle),
             display_name = COALESCE(?, display_name),
             picture = COALESCE(?, picture),
             uploads_playlist_id = COALESCE(?, uploads_playlist_id),
             updated_at = ?
       WHERE id = ?`,
    ).run(
      input.handle ?? null,
      input.displayName ?? null,
      input.picture ?? null,
      input.uploadsPlaylistId ?? null,
      t,
      existing.id,
    );
    const row = db.prepare("SELECT * FROM engage_channels WHERE id = ?").get(existing.id) as ChannelRow;
    return rowToChannel(row);
  }
  const id = nanoid();
  db.prepare(
    `INSERT INTO engage_channels
       (id, platform, external_id, handle, display_name, picture, enabled, reply_mode,
        uploads_playlist_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.platform,
    input.externalId,
    input.handle ?? null,
    input.displayName ?? null,
    input.picture ?? null,
    1,
    "off" as ReplyMode,
    input.uploadsPlaylistId ?? null,
    t,
    t,
  );
  const row = db.prepare("SELECT * FROM engage_channels WHERE id = ?").get(id) as ChannelRow;
  return rowToChannel(row);
}

/** All monitored channels (newest first). */
export function listChannels(): EngageChannel[] {
  const rows = db.prepare("SELECT * FROM engage_channels ORDER BY created_at DESC").all() as ChannelRow[];
  return rows.map(rowToChannel);
}

export function getChannel(channelId: string): EngageChannel | null {
  const row = db.prepare("SELECT * FROM engage_channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  return row ? rowToChannel(row) : null;
}

/** The enabled channels for a platform (the poll loop reads youtube). */
export function listEnabledChannels(platform: Platform): EngageChannel[] {
  const rows = db
    .prepare("SELECT * FROM engage_channels WHERE platform = ? AND enabled = 1 ORDER BY created_at DESC")
    .all(platform) as ChannelRow[];
  return rows.map(rowToChannel);
}

/** The cached uploads playlist id for a channel (null until resolved). */
export function getUploadsPlaylistId(channelId: string): string | null {
  const row = db
    .prepare("SELECT uploads_playlist_id FROM engage_channels WHERE id = ?")
    .get(channelId) as { uploads_playlist_id: string | null } | undefined;
  return row?.uploads_playlist_id ?? null;
}

/** Cache the resolved uploads playlist id on a channel (poll-loop lazy resolve). */
export function setUploadsPlaylistId(channelId: string, uploadsPlaylistId: string): void {
  db.prepare("UPDATE engage_channels SET uploads_playlist_id = ?, updated_at = ? WHERE id = ?").run(
    uploadsPlaylistId,
    now(),
    channelId,
  );
}

/**
 * Write a channel's engagement stats snapshot (subscribers/followers · comments ·
 * likes) + stamp stats_updated_at = now. Each count is individually nullable (a
 * hidden subscriber count, or a stat we couldn't read). Best-effort: called by
 * the monitor on the throttled stats cadence.
 */
export function setChannelStats(
  channelId: string,
  stats: { audience: number | null; comments: number | null; likes: number | null },
): void {
  db.prepare(
    `UPDATE engage_channels
       SET audience_count = ?, comment_count = ?, like_count = ?, stats_updated_at = ?
     WHERE id = ?`,
  ).run(stats.audience ?? null, stats.comments ?? null, stats.likes ?? null, now(), channelId);
}

/**
 * Store a per-channel access token (the Meta PAGE token, resolved during seed from
 * the operator's long-lived user token). Server-only secret — read internally by
 * the monitor via getChannelAuth(); NEVER returned through any HTTP response. A
 * null clears it.
 */
export function setChannelAuth(channelId: string, token: string | null): void {
  db.prepare("UPDATE engage_channels SET access_token = ?, updated_at = ? WHERE id = ?").run(
    token ?? null,
    now(),
    channelId,
  );
}

/**
 * INTERNAL, SERVER-ONLY read of a channel's stored access token (the Meta PAGE
 * token). Used by the monitor to READ that channel's comments. Must NEVER be wired
 * into an HTTP handler/response (the write-only secret guarantee). Returns null
 * when unset (e.g. YouTube channels, or a Meta channel whose token wasn't seeded).
 */
export function getChannelAuth(channelId: string): string | null {
  const row = db
    .prepare("SELECT access_token FROM engage_channels WHERE id = ?")
    .get(channelId) as { access_token: string | null } | undefined;
  return row?.access_token ?? null;
}

/**
 * Store the FB Page id a Meta channel's conversations (DMs) live on. Set by the
 * seeder to `account.fbPageId` on BOTH the facebook channel (== external_id) and
 * the linked instagram channel (whose external_id is the IG user id, not a page
 * id). A null clears it.
 */
export function setChannelMetaPageId(channelId: string, pageId: string | null): void {
  db.prepare("UPDATE engage_channels SET meta_page_id = ?, updated_at = ? WHERE id = ?").run(
    pageId ?? null,
    now(),
    channelId,
  );
}

/**
 * Read a Meta channel's FB Page id (for the DM /{pageId}/conversations read).
 * Returns null when unset (YouTube channels, or a Meta channel seeded before this
 * column existed — a "refresh channels" re-seed backfills it).
 */
export function getChannelMetaPageId(channelId: string): string | null {
  const row = db
    .prepare("SELECT meta_page_id FROM engage_channels WHERE id = ?")
    .get(channelId) as { meta_page_id: string | null } | undefined;
  return row?.meta_page_id ?? null;
}

/**
 * Read a TikTok channel's last Apify-poll timestamp (epoch-ms), or null if it's
 * never been polled. The monitor compares this against ENGAGE_TIKTOK_POLL_INTERVAL_MS
 * to throttle TikTok scraping to a slow cadence (conserving Apify credits).
 */
export function getTiktokPolledAt(channelId: string): number | null {
  const row = db
    .prepare("SELECT tiktok_polled_at FROM engage_channels WHERE id = ?")
    .get(channelId) as { tiktok_polled_at: number | null } | undefined;
  return row?.tiktok_polled_at ?? null;
}

/** Stamp a TikTok channel's last Apify-poll time = now (the slow-cadence throttle). */
export function setTiktokPolledAt(channelId: string, at: number = now()): void {
  db.prepare("UPDATE engage_channels SET tiktok_polled_at = ? WHERE id = ?").run(at, channelId);
}

/** Toggle a channel's monitor (enabled) and/or reply mode. Returns the updated row, or null. */
export function setChannelMode(
  channelId: string,
  patch: { enabled?: boolean; replyMode?: ReplyMode },
): EngageChannel | null {
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    vals.push(patch.enabled ? 1 : 0);
  }
  if (patch.replyMode !== undefined) {
    sets.push("reply_mode = ?");
    vals.push(patch.replyMode);
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    vals.push(now());
    vals.push(channelId);
    db.prepare(`UPDATE engage_channels SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getChannel(channelId);
}

// ── engage_inbox ──────────────────────────────────────────────────────────────

interface InboxRow {
  id: string;
  channel_id: string;
  platform: string;
  kind: string;
  dedup_key: string;
  thread_id: string | null;
  parent_id: string | null;
  target_ref: string | null;
  target_title: string | null;
  author_name: string | null;
  author_handle: string | null;
  author_id: string | null;
  text: string;
  permalink: string | null;
  posted_at: number | null;
  ingested_at: number;
  source: string;
  reply_state: string;
}

function rowToInbox(row: InboxRow): InboxItem {
  return {
    id: row.id,
    channelId: row.channel_id,
    platform: row.platform as Platform,
    kind: row.kind as InboxKind,
    dedupKey: row.dedup_key,
    threadId: row.thread_id,
    parentId: row.parent_id,
    targetRef: row.target_ref,
    targetTitle: row.target_title,
    authorName: row.author_name,
    authorHandle: row.author_handle,
    authorId: row.author_id,
    text: row.text,
    permalink: row.permalink,
    postedAt: row.posted_at,
    ingestedAt: row.ingested_at,
    source: row.source as InboxItem["source"],
    replyState: row.reply_state as ReplyState,
  };
}

/**
 * Insert an ingested item, idempotent on (platform, dedup_key): a comment we've
 * already stored is silently ignored (ON CONFLICT DO NOTHING). The caller passes
 * a fully-shaped InboxItem except id/ingestedAt/replyState, which we assign here.
 * Returns { inserted } so the poll loop can count NEW items.
 */
export function insertInboxItem(
  item: Omit<InboxItem, "id" | "ingestedAt" | "replyState">,
): { inserted: boolean } {
  const id = nanoid();
  const res = db
    .prepare(
      `INSERT INTO engage_inbox
         (id, channel_id, platform, kind, dedup_key, thread_id, parent_id, target_ref,
          target_title, author_name, author_handle, author_id, text, permalink,
          posted_at, ingested_at, source, reply_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(platform, dedup_key) DO NOTHING`,
    )
    .run(
      id,
      item.channelId,
      item.platform,
      item.kind,
      item.dedupKey,
      item.threadId ?? null,
      item.parentId ?? null,
      item.targetRef ?? null,
      item.targetTitle ?? null,
      item.authorName ?? null,
      item.authorHandle ?? null,
      item.authorId ?? null,
      item.text,
      item.permalink ?? null,
      item.postedAt ?? null,
      now(),
      item.source,
      "new" as ReplyState,
    );
  return { inserted: res.changes > 0 };
}

/** Filtered, paginated inbox read + a total count for the same filter (no paging). */
export function listInbox(filters: ListInboxInput): { items: InboxItem[]; total: number } {
  const where: string[] = [];
  const vals: any[] = [];
  if (filters.platform) {
    where.push("platform = ?");
    vals.push(filters.platform);
  }
  if (filters.kind) {
    where.push("kind = ?");
    vals.push(filters.kind);
  }
  if (filters.replyState) {
    where.push("reply_state = ?");
    vals.push(filters.replyState);
  }
  if (filters.channelId) {
    where.push("channel_id = ?");
    vals.push(filters.channelId);
  }
  if (filters.q && filters.q.trim()) {
    where.push("(text LIKE ? OR author_name LIKE ? OR author_handle LIKE ?)");
    const like = `%${filters.q.trim()}%`;
    vals.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM engage_inbox ${clause}`).get(...vals) as { n: number }).n;

  const limit = clampLimit(filters.limit);
  const offset = Math.max(0, Math.floor(filters.offset ?? 0));
  const rows = db
    .prepare(`SELECT * FROM engage_inbox ${clause} ORDER BY posted_at DESC, ingested_at DESC LIMIT ? OFFSET ?`)
    .all(...vals, limit, offset) as InboxRow[];
  return { items: rows.map(rowToInbox), total };
}

function clampLimit(limit: number | undefined): number {
  const n = Math.floor(limit ?? 50);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, n);
}

export function getInboxItem(id: string): InboxItem | null {
  const row = db.prepare("SELECT * FROM engage_inbox WHERE id = ?").get(id) as InboxRow | undefined;
  return row ? rowToInbox(row) : null;
}

/** All items sharing a thread id (the top-level comment + its replies), chronological. */
export function getThread(threadId: string): InboxItem[] {
  const rows = db
    .prepare("SELECT * FROM engage_inbox WHERE thread_id = ? ORDER BY posted_at ASC, ingested_at ASC")
    .all(threadId) as InboxRow[];
  return rows.map(rowToInbox);
}

/**
 * Threaded read: each matching top-level comment (parent_id IS NULL) with its
 * FULL reply tree attached. The same filter predicates as listInbox (channelId /
 * platform / kind / q) apply to the ROOT rows.
 *
 * Ordering + pagination are by most-recent-activity: last_activity = MAX(posted_at)
 * across the whole thread (root + replies), computed in SQL so an active thread
 * (fresh reply on an old comment) bubbles up and paginates correctly. Replies are
 * then fetched for the whole page in ONE query (thread_id IN (…)) and grouped in
 * JS — no N+1. total = count of matching roots.
 */
export function listThreads(filters: ListThreadsInput): { threads: InboxThread[]; total: number } {
  const where: string[] = ["parent_id IS NULL"];
  const vals: any[] = [];
  if (filters.platform) {
    where.push("platform = ?");
    vals.push(filters.platform);
  }
  if (filters.kind) {
    where.push("kind = ?");
    vals.push(filters.kind);
  }
  if (filters.channelId) {
    where.push("channel_id = ?");
    vals.push(filters.channelId);
  }
  if (filters.q && filters.q.trim()) {
    where.push("(text LIKE ? OR author_name LIKE ? OR author_handle LIKE ?)");
    const like = `%${filters.q.trim()}%`;
    vals.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM engage_inbox ${clause}`).get(...vals) as { n: number }).n;

  const limit = clampLimit(filters.limit);
  const offset = Math.max(0, Math.floor(filters.offset ?? 0));
  const sort: ThreadSort = filters.sort ?? "newest";
  // The roots query is what gets ordered + paginated, so the ORDER BY switches
  // per sort mode (SQLite sorts FALSE(0) before TRUE(1), so "x IS NULL" first
  // pushes undated roots to the bottom in every mode):
  //   newest  — root posted_at DESC (default)
  //   oldest  — root posted_at ASC
  //   active  — MAX(posted_at) across the whole thread DESC (a fresh reply bumps
  //             an old comment up — the original behavior)
  //   replies — reply-count DESC, root posted_at DESC as tiebreak
  // last_activity powers 'active'; reply_count powers 'replies' — both computed
  // as correlated subqueries so they honor thread_id regardless of the filters.
  const orderBy =
    sort === "oldest"
      ? "ORDER BY r.posted_at IS NULL, r.posted_at ASC, r.ingested_at ASC"
      : sort === "active"
        ? "ORDER BY last_activity IS NULL, last_activity DESC, r.ingested_at DESC"
        : sort === "replies"
          ? "ORDER BY reply_count DESC, r.posted_at IS NULL, r.posted_at DESC, r.ingested_at DESC"
          : "ORDER BY r.posted_at IS NULL, r.posted_at DESC, r.ingested_at DESC";
  const roots = db
    .prepare(
      `SELECT r.*,
              (SELECT MAX(t.posted_at) FROM engage_inbox t WHERE t.thread_id = r.thread_id) AS last_activity,
              (SELECT COUNT(*) FROM engage_inbox c WHERE c.thread_id = r.thread_id AND c.parent_id IS NOT NULL) AS reply_count
         FROM engage_inbox r
         ${clause}
        ${orderBy}
        LIMIT ? OFFSET ?`,
    )
    .all(...vals, limit, offset) as Array<InboxRow & { last_activity: number | null; reply_count: number }>;

  if (roots.length === 0) return { threads: [], total };

  // One query for all replies across this page's thread_ids, grouped in JS.
  const threadIds = roots.map((r) => r.thread_id).filter((id): id is string => !!id);
  const repliesByThread = new Map<string, InboxItem[]>();
  if (threadIds.length > 0) {
    const placeholders = threadIds.map(() => "?").join(",");
    const replyRows = db
      .prepare(
        `SELECT * FROM engage_inbox
          WHERE parent_id IS NOT NULL AND thread_id IN (${placeholders})
          ORDER BY posted_at ASC, ingested_at ASC`,
      )
      .all(...threadIds) as InboxRow[];
    for (const row of replyRows) {
      const key = row.thread_id;
      if (!key) continue;
      const list = repliesByThread.get(key) ?? [];
      list.push(rowToInbox(row));
      repliesByThread.set(key, list);
    }
  }

  const threads: InboxThread[] = roots.map((rootRow) => {
    const root = rowToInbox(rootRow);
    const replies = (root.threadId && repliesByThread.get(root.threadId)) || [];
    const times = [root.postedAt, ...replies.map((r) => r.postedAt)].filter(
      (t): t is number => typeof t === "number",
    );
    const lastActivityAt = times.length ? Math.max(...times) : null;
    return { root, replies, replyCount: replies.length, lastActivityAt };
  });

  // Keep the page's in-JS order consistent with the SQL sort (SQL already picked
  // + ordered this page; this just re-applies the same key over the hydrated
  // shape). NULL posted_at sorts last in every mode.
  if (sort === "oldest") {
    threads.sort((a, b) => (a.root.postedAt ?? Infinity) - (b.root.postedAt ?? Infinity));
  } else if (sort === "active") {
    threads.sort((a, b) => (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity));
  } else if (sort === "replies") {
    threads.sort(
      (a, b) => b.replyCount - a.replyCount || (b.root.postedAt ?? -Infinity) - (a.root.postedAt ?? -Infinity),
    );
  } else {
    threads.sort((a, b) => (b.root.postedAt ?? -Infinity) - (a.root.postedAt ?? -Infinity));
  }

  return { threads, total };
}

// ── engage_replies (read-only in Phase 1) ─────────────────────────────────────

interface ReplyRow {
  id: string;
  inbox_id: string;
  channel_id: string;
  platform: string;
  status: string;
  mechanism: string | null;
  generated_text: string | null;
  decide_reason: string | null;
  not_before: number;
  attempts: number;
  external_reply_id: string | null;
  error: string | null;
  cost_usd: number;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

function rowToReply(row: ReplyRow): ReplyRecord {
  return {
    id: row.id,
    inboxId: row.inbox_id,
    channelId: row.channel_id,
    platform: row.platform as Platform,
    status: row.status as ReplyRecord["status"],
    mechanism: row.mechanism as ReplyRecord["mechanism"],
    generatedText: row.generated_text,
    decideReason: row.decide_reason,
    notBefore: row.not_before,
    attempts: row.attempts,
    externalReplyId: row.external_reply_id,
    error: row.error,
    costUsd: row.cost_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
}

/** The reply record for an inbox item (Phase 1: always null until reply phases). */
export function getReplyForInbox(inboxId: string): ReplyRecord | null {
  const row = db
    .prepare("SELECT * FROM engage_replies WHERE inbox_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(inboxId) as ReplyRow | undefined;
  return row ? rowToReply(row) : null;
}

// ── engage_settings (singleton) ───────────────────────────────────────────────

interface SettingsRow {
  id: string;
  kill_switch: number;
  global_autoreply: number;
  caps_json: string | null;
  pacing_json: string | null;
  reply_prompt_md: string | null;
  updated_at: number;
}

/** Monitor-only defaults: caps 0 = n/a (no reply throttle in Phase 1). */
const DEFAULT_CAPS: Partial<Record<Platform, RateCaps>> = { youtube: { hour: 0, day: 0 } };
const DEFAULT_PACING: Pacing = { minDelaySec: 45, maxDelaySec: 180, activeHours: [8, 23] };

function parseCaps(json: string | null): Partial<Record<Platform, RateCaps>> {
  if (!json) return { ...DEFAULT_CAPS };
  try {
    const p = JSON.parse(json);
    return p && typeof p === "object" ? (p as Partial<Record<Platform, RateCaps>>) : { ...DEFAULT_CAPS };
  } catch {
    return { ...DEFAULT_CAPS };
  }
}

function parsePacing(json: string | null): Pacing {
  if (!json) return { ...DEFAULT_PACING };
  try {
    const p = JSON.parse(json) as Partial<Pacing>;
    const active = Array.isArray(p?.activeHours) && p.activeHours.length === 2 ? p.activeHours : DEFAULT_PACING.activeHours;
    return {
      minDelaySec: typeof p?.minDelaySec === "number" ? p.minDelaySec : DEFAULT_PACING.minDelaySec,
      maxDelaySec: typeof p?.maxDelaySec === "number" ? p.maxDelaySec : DEFAULT_PACING.maxDelaySec,
      activeHours: [Number(active[0]), Number(active[1])] as [number, number],
    };
  } catch {
    return { ...DEFAULT_PACING };
  }
}

function rowToSettings(row: SettingsRow): EngageSettings {
  return {
    killSwitch: !!row.kill_switch,
    globalAutoreply: !!row.global_autoreply,
    caps: parseCaps(row.caps_json),
    pacing: parsePacing(row.pacing_json),
    replyPromptMd: row.reply_prompt_md,
    updatedAt: row.updated_at,
  };
}

/**
 * Read the singleton settings row, creating it on first read with the safe
 * defaults (kill_switch ON, monitor-only caps, standard pacing).
 */
export function getSettings(): EngageSettings {
  let row = db.prepare("SELECT * FROM engage_settings WHERE id = 'singleton'").get() as SettingsRow | undefined;
  if (!row) {
    const t = now();
    db.prepare(
      `INSERT INTO engage_settings (id, kill_switch, global_autoreply, caps_json, pacing_json, reply_prompt_md, updated_at)
       VALUES ('singleton', 1, 0, ?, ?, NULL, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(JSON.stringify(DEFAULT_CAPS), JSON.stringify(DEFAULT_PACING), t);
    row = db.prepare("SELECT * FROM engage_settings WHERE id = 'singleton'").get() as SettingsRow;
  }
  return rowToSettings(row);
}

/** Patch the singleton settings row. Only provided fields are written. */
export function setSettings(patch: Partial<EngageSettings>): EngageSettings {
  getSettings(); // ensure the row exists.
  const sets: string[] = [];
  const vals: any[] = [];
  if (patch.killSwitch !== undefined) {
    sets.push("kill_switch = ?");
    vals.push(patch.killSwitch ? 1 : 0);
  }
  if (patch.globalAutoreply !== undefined) {
    sets.push("global_autoreply = ?");
    vals.push(patch.globalAutoreply ? 1 : 0);
  }
  if (patch.caps !== undefined) {
    sets.push("caps_json = ?");
    vals.push(JSON.stringify(patch.caps));
  }
  if (patch.pacing !== undefined) {
    sets.push("pacing_json = ?");
    vals.push(JSON.stringify(patch.pacing));
  }
  if (patch.replyPromptMd !== undefined) {
    sets.push("reply_prompt_md = ?");
    vals.push(patch.replyPromptMd);
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?");
    vals.push(now());
    db.prepare(`UPDATE engage_settings SET ${sets.join(", ")} WHERE id = 'singleton'`).run(...vals);
  }
  return getSettings();
}

// ── rolled-up counts (for the status card) ────────────────────────────────────

/** Inbox counts grouped by platform. */
export function countsByPlatform(): Partial<Record<Platform, number>> {
  const rows = db.prepare("SELECT platform, COUNT(*) AS n FROM engage_inbox GROUP BY platform").all() as Array<{
    platform: string;
    n: number;
  }>;
  const out: Partial<Record<Platform, number>> = {};
  for (const r of rows) out[r.platform as Platform] = r.n;
  return out;
}

/** Total inbox rows. */
export function totalCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM engage_inbox").get() as { n: number }).n;
}

/** Count of items still in the 'new' reply state. */
export function newCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM engage_inbox WHERE reply_state = 'new'").get() as { n: number }).n;
}

// ── engage_replies (Phase 3: draft → queue → send) ────────────────────────────

export interface CreateReplyInput {
  inboxId: string;
  channelId: string;
  platform: Platform;
  status: ReplyRecord["status"];
  mechanism: ReplyRecord["mechanism"];
  generatedText: string | null;
  decideReason: string | null;
  /** Earliest dispatch time (human pacing pushes this into the future). */
  notBefore: number;
  costUsd?: number;
}

/**
 * Record a reply decision. One row per (inbox item, attempt-cycle): a 'skipped'
 * row is written for items we deliberately don't answer, so the queue is an
 * audit trail of every decision rather than only the replies that went out.
 */
export function createReply(input: CreateReplyInput): ReplyRecord {
  const id = nanoid();
  const t = now();
  db.prepare(
    `INSERT INTO engage_replies
       (id, inbox_id, channel_id, platform, status, mechanism, generated_text, decide_reason,
        not_before, attempts, external_reply_id, error, cost_usd, created_at, updated_at, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?, NULL)`,
  ).run(
    id,
    input.inboxId,
    input.channelId,
    input.platform,
    input.status,
    input.mechanism,
    input.generatedText,
    input.decideReason,
    input.notBefore,
    input.costUsd ?? 0,
    t,
    t,
  );
  return getReply(id)!;
}

export function getReply(id: string): ReplyRecord | null {
  const row = db.prepare("SELECT * FROM engage_replies WHERE id = ?").get(id) as ReplyRow | undefined;
  return row ? rowToReply(row) : null;
}

export interface UpdateReplyPatch {
  status?: ReplyRecord["status"];
  generatedText?: string | null;
  decideReason?: string | null;
  notBefore?: number;
  attempts?: number;
  externalReplyId?: string | null;
  error?: string | null;
  costUsd?: number;
  sentAt?: number | null;
}

export function updateReply(id: string, patch: UpdateReplyPatch): ReplyRecord | null {
  const sets: string[] = [];
  const vals: any[] = [];
  const put = (col: string, v: any) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.status !== undefined) put("status", patch.status);
  if (patch.generatedText !== undefined) put("generated_text", patch.generatedText);
  if (patch.decideReason !== undefined) put("decide_reason", patch.decideReason);
  if (patch.notBefore !== undefined) put("not_before", patch.notBefore);
  if (patch.attempts !== undefined) put("attempts", patch.attempts);
  if (patch.externalReplyId !== undefined) put("external_reply_id", patch.externalReplyId);
  if (patch.error !== undefined) put("error", patch.error);
  if (patch.costUsd !== undefined) put("cost_usd", patch.costUsd);
  if (patch.sentAt !== undefined) put("sent_at", patch.sentAt);
  if (sets.length === 0) return getReply(id);
  put("updated_at", now());
  db.prepare(`UPDATE engage_replies SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  return getReply(id);
}

/** True when this inbox item already has a reply row (any status). */
export function hasReply(inboxId: string): boolean {
  const row = db.prepare("SELECT 1 AS n FROM engage_replies WHERE inbox_id = ? LIMIT 1").get(inboxId) as
    | { n: number }
    | undefined;
  return !!row;
}

/**
 * Replies that are due to be dispatched: pending, past their not_before, and
 * not yet exhausted their retries. Oldest first so the queue drains in order.
 */
export function dueReplies(limit = 5, at: number = now(), maxAttempts = 3): ReplyRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM engage_replies
        WHERE status = 'pending' AND not_before <= ? AND attempts < ?
        ORDER BY not_before ASC LIMIT ?`,
    )
    .all(at, maxAttempts, limit) as ReplyRow[];
  return rows.map(rowToReply);
}

export interface ListRepliesInput {
  status?: ReplyRecord["status"];
  platform?: Platform;
  channelId?: string;
  limit?: number;
  offset?: number;
}

/** The review queue: replies newest-first, with their inbox item joined in. */
export function listReplies(filters: ListRepliesInput = {}): { replies: ReplyRecord[]; total: number } {
  const where: string[] = [];
  const vals: any[] = [];
  if (filters.status) {
    where.push("status = ?");
    vals.push(filters.status);
  }
  if (filters.platform) {
    where.push("platform = ?");
    vals.push(filters.platform);
  }
  if (filters.channelId) {
    where.push("channel_id = ?");
    vals.push(filters.channelId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM engage_replies ${clause}`).get(...vals) as { n: number }).n;
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const rows = db
    .prepare(`SELECT * FROM engage_replies ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...vals, limit, offset) as ReplyRow[];
  return { replies: rows.map(rowToReply), total };
}

/** Move an inbox item through its reply lifecycle (new → queued → replied/skipped). */
export function setInboxReplyState(inboxId: string, state: ReplyState): void {
  db.prepare("UPDATE engage_inbox SET reply_state = ? WHERE id = ?").run(state, inboxId);
}

/**
 * Inbox items eligible for a reply decision: never seen by the reply worker,
 * on an enabled channel whose reply_mode is not 'off', and not authored by the
 * channel owner themselves (never reply to your own comment).
 */
export function replyCandidates(platform: Platform, limit = 10): InboxItem[] {
  const rows = db
    .prepare(
      `SELECT i.* FROM engage_inbox i
         JOIN engage_channels c ON c.id = i.channel_id
        WHERE i.platform = ?
          AND i.reply_state = 'new'
          AND c.enabled = 1
          AND c.reply_mode != 'off'
          AND NOT EXISTS (SELECT 1 FROM engage_replies r WHERE r.inbox_id = i.id)
          AND (c.external_id IS NULL OR i.author_id IS NULL OR i.author_id != c.external_id)
        ORDER BY i.posted_at DESC
        LIMIT ?`,
    )
    .all(platform, limit) as any[];
  return rows.map(rowToInbox);
}

// ── engage_rate_counters (fixed-window throttle) ──────────────────────────────

/** Count of replies sent on a platform in the given window. */
export function sentInWindow(platform: Platform, windowKind: "hour" | "day", windowStart: number): number {
  const row = db
    .prepare(
      "SELECT sent_count AS n FROM engage_rate_counters WHERE platform = ? AND window_kind = ? AND window_start = ?",
    )
    .get(platform, windowKind, windowStart) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Bump a window's counter by one (upsert). Called only after a real send. */
export function bumpRateCounter(platform: Platform, windowKind: "hour" | "day", windowStart: number): void {
  db.prepare(
    `INSERT INTO engage_rate_counters (platform, window_kind, window_start, sent_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(platform, window_kind, window_start)
     DO UPDATE SET sent_count = sent_count + 1`,
  ).run(platform, windowKind, windowStart);
}
