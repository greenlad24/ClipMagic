/**
 * Engagement Manager — the always-on YouTube comment monitor.
 *
 * startMonitor() (called from index.ts near startWorker) runs a cycle every
 * ENGAGE_POLL_INTERVAL_MS (env, default 10 min): for each ENABLED YouTube
 * channel → resolve its uploads playlist (cached) → recent videos → comments →
 * insert into the inbox (idempotent on the comment id). It NEVER throws — every
 * failure is caught, logged, and recorded on the in-memory registry (exactly
 * like keyword/run.ts's runResearch). A YoutubeQuotaError stops the cycle early
 * (already-ingested comments are kept) and the loop resumes next interval.
 *
 * pollOnce() runs a single cycle on demand (the engagePollNow handler), guarded
 * by the same in-flight flag so an on-demand poll can't stack on the background
 * one.
 */
import {
  listEnabledChannels,
  getUploadsPlaylistId,
  setUploadsPlaylistId,
  getChannelAuth,
  getChannelMetaPageId,
  getTiktokPolledAt,
  setTiktokPolledAt,
  insertInboxItem,
  setChannelStats,
} from "./db.js";
import {
  resolveChannel,
  recentVideoIds,
  fetchComments,
  fetchChannelEngagementStats,
  YoutubeQuotaError,
  youtubeConfigured,
} from "./youtube.js";
import {
  fetchFacebookComments,
  fetchInstagramComments,
  fetchFacebookDMs,
  fetchInstagramDMs,
  fetchFacebookStats,
  fetchInstagramStats,
  metaConfigured,
  MetaGraphError,
  metaErrMsg,
} from "./metaGraph.js";
import { fetchTikTokComments, tiktokConfigured, TikTokError } from "./tiktok.js";
import { isPolling, setPolling, markPollSuccess, setLastError } from "./registry.js";
import type { EngageChannel } from "./types.js";

/** Poll interval (ms). Default 10 min; overridable for a faster local loop. */
function pollIntervalMs(): number {
  const raw = Number(process.env.ENGAGE_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 600_000;
}

/**
 * TikTok poll cadence (ms). Apify actor runs cost credits, so TikTok is polled on a
 * SEPARATE SLOW cadence — NOT every 10-min cycle. Default 2h → ~12 runs/day, and
 * dedup means each run only persists NEW comments, keeping Apify usage minimal.
 * Overridable via env (ENGAGE_TIKTOK_POLL_INTERVAL_MS); floored at 1h.
 */
function tiktokPollIntervalMs(): number {
  const raw = Number(process.env.ENGAGE_TIKTOK_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 3_600_000 ? Math.floor(raw) : 7_200_000;
}

/** Recent uploads scanned per channel per cycle (bounds quota). */
const VIDEOS_PER_CHANNEL = 15;
/** Comment threads pulled per video per cycle (bounds quota). */
const COMMENTS_PER_VIDEO = 50;
/** Recent posts/media scanned per Meta channel per cycle (bounds Graph calls). */
const META_TARGETS_PER_CHANNEL = 10;

/**
 * How long a channel's engagement stats snapshot stays fresh (ms). Stats add ~2
 * quota units/channel/refresh (channels.list + videos.list), so we throttle them
 * far below the 10-min comment loop. Default 1h; override via env.
 */
function statsTtlMs(): number {
  const raw = Number(process.env.ENGAGE_STATS_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3_600_000;
}

/** True when a channel's stats are missing (never fetched) or older than the TTL. */
function statsAreStale(channel: EngageChannel): boolean {
  const updatedAt = channel.stats?.updatedAt ?? null;
  if (updatedAt == null) return true;
  return Date.now() - updatedAt > statsTtlMs();
}

/**
 * Best-effort refresh of ONE channel's engagement stats (subscribers · comments ·
 * likes). NEVER throws — stats are secondary to comment ingestion, so any error
 * (including quota) is caught + logged and the caller carries on.
 */
async function refreshChannelStats(channel: EngageChannel, uploadsPlaylistId: string | null): Promise<void> {
  try {
    const stats = await fetchChannelEngagementStats(channel.externalId, uploadsPlaylistId);
    setChannelStats(channel.id, stats);
  } catch (e) {
    console.warn(`[engage] stats refresh for "${channel.displayName ?? channel.externalId}" failed: ${errMsg(e)}`);
  }
}

let timer: NodeJS.Timeout | null = null;

/** Start the background loop (idempotent — a second call is a no-op). */
export function startMonitor(): void {
  if (timer) return;
  const interval = pollIntervalMs();
  console.log(`[engage] monitor started — polling every ${Math.round(interval / 1000)}s`);
  // Kick a first cycle shortly after boot (don't block app.listen), then repeat.
  setTimeout(() => void runCycle("startup"), 15_000);
  timer = setInterval(() => void runCycle("interval"), interval);
  // Don't keep the event loop alive solely for the poller.
  if (typeof timer.unref === "function") timer.unref();
}

/**
 * Run ONE cycle on demand. Returns whether a cycle was actually started (false
 * when one is already in flight). Used by the engagePollNow handler.
 */
export function pollOnce(): { started: boolean } {
  if (isPolling()) return { started: false };
  void runCycle("on-demand");
  return { started: true };
}

/**
 * One monitor cycle. NEVER throws. Sets the registry polling flag, then walks the
 * enabled channels of EACH configured provider (YouTube via the Data API key, Meta
 * IG/FB via the stored page tokens) independently — one provider being unconfigured
 * or erroring never stops the other. YouTube stops early on quota; Meta stops that
 * channel on an auth error (flags it in lastError) but keeps polling the rest.
 * The in-flight guard means an interval tick that lands mid-cycle just skips.
 */
async function runCycle(trigger: string): Promise<void> {
  if (isPolling()) return; // overlap guard — don't stack cycles.
  setPolling(true);
  try {
    const ytOn = youtubeConfigured();
    const metaOn = metaConfigured();
    const tiktokOn = tiktokConfigured();
    if (!ytOn && !metaOn && !tiktokOn) {
      setLastError("No monitoring providers configured (YouTube Data API key, Meta token, or Apify token).");
      return;
    }

    let ingested = 0;
    let hardError: string | null = null;

    if (ytOn) {
      const yt = await runYoutube();
      ingested += yt.ingested;
      if (yt.error) hardError = yt.error;
    }
    if (metaOn) {
      const meta = await runMeta();
      ingested += meta.ingested;
      // Surface a Meta error only if YouTube didn't already claim lastError.
      if (meta.error && !hardError) hardError = meta.error;
    }
    if (tiktokOn) {
      // TikTok is throttled to its own slow cadence INSIDE runTikTok — most cycles
      // it's a no-op (nothing due). Never surfaces a hard error (best-effort scrape).
      const tiktok = await runTikTok();
      ingested += tiktok.ingested;
    }

    if (hardError) setLastError(hardError);
    else markPollSuccess();
    if (ingested > 0) console.log(`[engage] cycle (${trigger}) ingested ${ingested} new comment(s)`);
  } catch (e) {
    // Defensive: the loop must never throw.
    setLastError(errMsg(e));
    console.warn(`[engage] monitor cycle error: ${errMsg(e)}`);
  } finally {
    setPolling(false);
  }
}

/** Poll all enabled YouTube channels. Stops early on quota. Never throws. */
async function runYoutube(): Promise<{ ingested: number; error: string | null }> {
  const channels = listEnabledChannels("youtube");
  let ingested = 0;
  let error: string | null = null;
  for (const channel of channels) {
    try {
      ingested += await pollChannel(channel);
    } catch (e) {
      if (e instanceof YoutubeQuotaError) {
        error = "YouTube quota reached — monitor paused until the next interval.";
        break;
      }
      console.warn(`[engage] channel "${channel.displayName ?? channel.externalId}" poll failed: ${errMsg(e)}`);
    }
  }
  return { ingested, error };
}

/**
 * Poll all enabled Meta (Facebook + Instagram) channels. Each channel is
 * best-effort: a missing/expired token logs + skips that channel (and records a
 * needs-reauth signal), never breaking the cycle or the YouTube path. Never throws.
 */
async function runMeta(): Promise<{ ingested: number; error: string | null }> {
  const channels = [...listEnabledChannels("facebook"), ...listEnabledChannels("instagram")];
  let ingested = 0;
  let needsReauth = false;
  for (const channel of channels) {
    try {
      ingested += await pollMetaChannel(channel);
    } catch (e) {
      if (e instanceof MetaGraphError && e.isAuth) {
        needsReauth = true;
        console.warn(`[engage] Meta channel "${channel.displayName ?? channel.externalId}" needs re-authorization — skipped.`);
        continue;
      }
      console.warn(`[engage] Meta channel "${channel.displayName ?? channel.externalId}" poll failed: ${metaErrMsg(e)}`);
    }
  }
  return {
    ingested,
    error: needsReauth ? "A Meta channel's token expired — reconnect it in Settings to resume monitoring." : null,
  };
}

/**
 * TikTok channels for which we've logged a token/scrape failure this process, so a
 * bad Apify token doesn't spam the log every slow-cadence tick. Cleared implicitly
 * on restart.
 */
const loggedTiktokError = new Set<string>();

/**
 * Poll enabled TikTok channels via the Apify actor, but ONLY those whose last poll
 * is older than the slow cadence (ENGAGE_TIKTOK_POLL_INTERVAL_MS, default 6h) — so
 * across the frequent 10-min cycles a TikTok channel is actually scraped only ~4×/
 * day, conserving Apify credits. Best-effort per channel: a TikTokError (bad token /
 * run failure) is logged ONCE and the channel is skipped; NEVER throws. On a
 * successful run the poll timestamp is stamped so the channel goes quiet again until
 * the interval elapses.
 */
async function runTikTok(): Promise<{ ingested: number }> {
  const channels = listEnabledChannels("tiktok");
  const interval = tiktokPollIntervalMs();
  const nowMs = Date.now();
  let ingested = 0;

  for (const channel of channels) {
    const last = getTiktokPolledAt(channel.id);
    if (last != null && nowMs - last < interval) continue; // not due yet — stay cheap.
    try {
      // Scans the whole profile (all videos), then keeps only the 10 NEWEST comments
      // account-wide (ENGAGE_TIKTOK_MAX_ITEMS). insertInboxItem dedups on
      // (platform, commentId), so each 2h run persists only the new ones — the DB
      // accumulates full history.
      const comments = await fetchTikTokComments(channel.externalId);
      for (const c of comments) {
        if (insertInboxItem({ ...c, channelId: channel.id }).inserted) ingested++;
      }
      // Stamp the poll time only on a successful run (so a failure retries next tick).
      setTiktokPolledAt(channel.id, nowMs);
      loggedTiktokError.delete(channel.id);
    } catch (e) {
      if (!loggedTiktokError.has(channel.id)) {
        loggedTiktokError.add(channel.id);
        const detail = e instanceof TikTokError ? e.message : errMsg(e);
        console.warn(`[engage] TikTok channel "${channel.displayName ?? channel.externalId}" poll skipped — ${detail}`);
      }
      // Back off a failed channel for the full interval so a bad token doesn't burn
      // credits every cycle; a restart or next interval retries.
      setTiktokPolledAt(channel.id, nowMs);
    }
  }
  return { ingested };
}

/**
 * Channels for which we've already logged that DM monitoring is off (a missing
 * messaging permission). Logged ONCE per channel per process so a token without
 * `instagram_manage_messages` / `pages_messaging` doesn't spam the log every cycle.
 */
const loggedDmDisabled = new Set<string>();

/**
 * Channels whose COMMENT read is failing for a non-auth reason (Jake's Facebook
 * Page: #10 `pages_read_user_content`, which his app's use case doesn't offer).
 * Same once-per-process logging as the DM set — the error is permanent, so
 * repeating it every cycle would bury everything else in the log.
 */
const loggedCommentDisabled = new Set<string>();

/** Log `message` the first time it happens for a channel, then stay quiet. */
function logOnce(seen: Set<string>, channelId: string, message: string): void {
  if (seen.has(channelId)) return;
  seen.add(channelId);
  console.warn(message);
}

/**
 * Ingest one Meta channel's DMs (read-only), best-effort. IG → fetchInstagramDMs,
 * FB → fetchFacebookDMs, both against the channel's stored FB Page id. Returns how
 * many NEW messages were inserted. Skips silently if the page id is missing (channel
 * seeded before the meta_page_id column — a "refresh channels" re-seed backfills it).
 * A genuine token failure (isAuth) is re-thrown so runMeta flags re-auth; ANY other
 * error (notably a missing messaging permission — code #10/#200, non-auth) is logged
 * ONCE and skipped, keeping DM monitoring inert until the scopes are granted.
 */
async function pollMetaDMs(channel: EngageChannel, token: string): Promise<number> {
  const pageId = getChannelMetaPageId(channel.id);
  if (!pageId) return 0;

  let dms;
  try {
    dms =
      channel.platform === "facebook"
        ? await fetchFacebookDMs(pageId, token)
        : await fetchInstagramDMs(pageId, token);
  } catch (e) {
    if (e instanceof MetaGraphError && e.isAuth) throw e; // genuine token failure → re-auth signal.
    logOnce(
      loggedDmDisabled,
      channel.id,
      `[engage] DM monitoring for "${channel.displayName ?? channel.externalId}" is off — ${metaErrMsg(e)}. ` +
        `Grant "${channel.platform === "facebook" ? "pages_messaging" : "instagram_manage_messages"}" on the Meta token to enable it.`,
    );
    return 0;
  }

  let inserted = 0;
  for (const d of dms) {
    if (insertInboxItem({ ...d, channelId: channel.id }).inserted) inserted++;
  }
  return inserted;
}

/**
 * Poll one Meta channel using its stored PAGE token: recent post/media comments,
 * DMs, and (on the throttled TTL) stats. A channel without a stored token is
 * skipped (logged).
 *
 * The three reads are INDEPENDENT. They used to run in sequence in one try, so
 * the FIRST failure skipped everything after it — and Jake's Facebook Page fails
 * its comment read every single cycle (code #10, `pages_read_user_content`, a
 * permission his app's use case doesn't even offer). That one expected,
 * permanent error meant his Facebook DMs were NEVER fetched: a real message sat
 * in the Graph API for a day while the inbox showed nothing. Each read now
 * stands on its own, so a dead comment path can't take the DMs down with it.
 *
 * A genuine auth failure (MetaGraphError.isAuth — an expired/revoked token)
 * still propagates so runMeta can raise the re-auth banner; that one really does
 * break every read on the channel.
 */
async function pollMetaChannel(channel: EngageChannel): Promise<number> {
  const token = getChannelAuth(channel.id);
  if (!token) {
    console.warn(`[engage] Meta channel "${channel.displayName ?? channel.externalId}" has no stored token — skipped (re-run "refresh channels").`);
    return 0;
  }

  let inserted = 0;

  // 1. COMMENTS. A permission error here is logged once and survived; it must
  //    not reach the DM read below.
  try {
    const comments =
      channel.platform === "facebook"
        ? await fetchFacebookComments(channel.externalId, token, META_TARGETS_PER_CHANNEL)
        : await fetchInstagramComments(channel.externalId, token, META_TARGETS_PER_CHANNEL);
    for (const c of comments) {
      // Stamp the real channel id (the mappers leave it as a placeholder).
      if (insertInboxItem({ ...c, channelId: channel.id }).inserted) inserted++;
    }
  } catch (e) {
    if (e instanceof MetaGraphError && e.isAuth) throw e; // dead token — the whole channel is down.
    logOnce(
      loggedCommentDisabled,
      channel.id,
      `[engage] comment monitoring for "${channel.displayName ?? channel.externalId}" is off — ${metaErrMsg(e)}`,
    );
  }

  // 2. DMs (read-only), independent of the comment read above.
  inserted += await pollMetaDMs(channel, token);

  // 3. STATS, on the throttled TTL. Secondary — never breaks ingestion.
  if (statsAreStale(channel)) {
    try {
      const stats =
        channel.platform === "facebook"
          ? await fetchFacebookStats(channel.externalId, token, META_TARGETS_PER_CHANNEL)
          : await fetchInstagramStats(channel.externalId, token, META_TARGETS_PER_CHANNEL);
      setChannelStats(channel.id, stats);
    } catch (e) {
      // Stats are secondary — an auth error here still shouldn't crash the channel.
      console.warn(`[engage] Meta stats refresh for "${channel.displayName ?? channel.externalId}" failed: ${metaErrMsg(e)}`);
    }
  }

  return inserted;
}

/**
 * Poll one channel: (lazily) resolve its uploads playlist, fetch recent videos,
 * fetch each video's comments, and insert them (deduped). Returns how many NEW
 * items were inserted. Propagates YoutubeQuotaError so the cycle can stop.
 */
async function pollChannel(channel: EngageChannel): Promise<number> {
  let uploads = getUploadsPlaylistId(channel.id);
  if (!uploads) {
    const resolved = await resolveChannel(channel.externalId);
    uploads = resolved?.uploadsPlaylistId ?? null;
    if (uploads) setUploadsPlaylistId(channel.id, uploads);
  }
  if (!uploads) return 0;

  const videos = await recentVideoIds(uploads, VIDEOS_PER_CHANNEL);
  let inserted = 0;
  for (const video of videos) {
    const comments = await fetchComments(video.videoId, video.title, channel.id, COMMENTS_PER_VIDEO);
    for (const c of comments) {
      if (insertInboxItem(c).inserted) inserted++;
    }
  }

  // After ingesting comments, refresh this channel's engagement stats — but only
  // on the throttled TTL cadence, and never letting a stats failure (incl. quota)
  // break the comment cycle.
  if (statsAreStale(channel)) await refreshChannelStats(channel, uploads);

  return inserted;
}

/**
 * Force-refresh EVERY enabled YouTube channel's engagement stats now, ignoring
 * the TTL (the manual "refresh stats" button). Best-effort per channel: resolves
 * the uploads playlist if needed and never throws. Returns how many channels were
 * refreshed (attempted).
 */
export async function refreshAllChannelStats(): Promise<{ refreshed: number }> {
  let refreshed = 0;

  if (youtubeConfigured()) {
    for (const channel of listEnabledChannels("youtube")) {
      try {
        let uploads = getUploadsPlaylistId(channel.id);
        if (!uploads) {
          const resolved = await resolveChannel(channel.externalId);
          uploads = resolved?.uploadsPlaylistId ?? null;
          if (uploads) setUploadsPlaylistId(channel.id, uploads);
        }
        await refreshChannelStats(channel, uploads);
        refreshed++;
      } catch (e) {
        console.warn(`[engage] force stats refresh for "${channel.displayName ?? channel.externalId}" failed: ${errMsg(e)}`);
      }
    }
  }

  if (metaConfigured()) {
    const metaChannels = [...listEnabledChannels("facebook"), ...listEnabledChannels("instagram")];
    for (const channel of metaChannels) {
      const token = getChannelAuth(channel.id);
      if (!token) continue;
      try {
        const stats =
          channel.platform === "facebook"
            ? await fetchFacebookStats(channel.externalId, token, META_TARGETS_PER_CHANNEL)
            : await fetchInstagramStats(channel.externalId, token, META_TARGETS_PER_CHANNEL);
        setChannelStats(channel.id, stats);
        refreshed++;
      } catch (e) {
        console.warn(`[engage] Meta force stats refresh for "${channel.displayName ?? channel.externalId}" failed: ${metaErrMsg(e)}`);
      }
    }
  }

  return { refreshed };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
