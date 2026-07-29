/**
 * Stage 1 — turn a channel URL into a scored catalogue.
 *
 * Deliberately cheap. Resolving a channel, paging its uploads and fetching view
 * stats costs about 6 quota units for a 127-video channel (playlistItems is 1
 * unit per 50, videos.list 1 unit per 50) — versus 100 units for a single
 * search. Everything expensive happens later and only after the market has been
 * approved, so a mistyped handle costs almost nothing.
 */
import {
  resolveChannelId,
  fetchChannelProfile,
  fetchVideoStats,
  fetchChannelStats,
  hqThumbnailUrl,
} from "../thumbnails/youtube.js";
import { scoreCatalogue } from "./baseline.js";
import type { AuditChannel, AuditVideo } from "./types.js";

/** Nothing here is worth doing for a channel we cannot even identify. */
export class ChannelNotFoundError extends Error {
  constructor(input: string) {
    super(`Could not find a YouTube channel for "${input}".`);
    this.name = "ChannelNotFoundError";
  }
}

export interface IngestResult {
  channel: AuditChannel;
  videos: AuditVideo[];
  /** YouTube Data API units this cost, so the day's budget can be tracked. */
  quotaUnits: number;
}

/**
 * Fetch and score a whole channel.
 *
 * @param maxVideos guards against a pathological catalogue; 2000 is far above
 *   any realistic creator channel and exists only so a bad input cannot page
 *   forever.
 */
export async function ingestChannel(
  input: string,
  {
    maxVideos = 2000,
    now = Date.now(),
    paidByVideo,
  }: { maxVideos?: number; now?: number; paidByVideo?: Map<string, number> } = {},
): Promise<IngestResult> {
  const resolved = await resolveChannelId(input);
  if (!resolved) throw new ChannelNotFoundError(input);

  const profile = await fetchChannelProfile(resolved.channelId, maxVideos);
  if (!profile) throw new ChannelNotFoundError(input);

  const ids = profile.uploads.map((u) => u.videoId);
  // fetchChannelProfile returns views but not durations, and the Shorts split
  // depends on duration — so stats are fetched again here in full. It is 1 unit
  // per 50 videos, which is cheaper than carrying a second code path.
  const stats = await fetchVideoStats(ids);

  const scorable = profile.uploads
    .map((u) => {
      const s = stats.get(u.videoId);
      if (!s || !u.publishedAt) return null;
      return {
        videoId: u.videoId,
        title: u.title,
        publishedAt: new Date(u.publishedAt).getTime(),
        views: s.views,
        durationSeconds: s.durationSeconds,
        likes: s.likes,
        comments: s.comments,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null && Number.isFinite(v.publishedAt));

  // SCORE ON ORGANIC VIEWS WHEN WE KNOW THEM. Paid views inflate the count, so
  // a promoted video would otherwise read as a packaging win, enter the outlier
  // set, and teach the renamer from a title that never earned its audience.
  // Falls back to total views when no channel is connected, which is every
  // teardown and any own-channel audit before the operator connects.
  const scorable2 = paidByVideo
    ? scorable.map((v) => ({ ...v, views: Math.max(0, v.views - Math.min(paidByVideo.get(v.videoId) ?? 0, v.views)) }))
    : scorable;

  // The subscriber count is what makes views-per-sub meaningful, so it has to
  // be known before scoring rather than attached afterwards.
  const scored = scoreCatalogue(scorable2, now, { subscriberCount: profile.subscriberCount });
  const extra = new Map(scorable.map((v) => [v.videoId, v]));

  const videos: AuditVideo[] = scored.map((v) => {
    const total = extra.get(v.videoId)?.views ?? v.views;
    const paid = paidByVideo ? Math.min(paidByVideo.get(v.videoId) ?? 0, total) : undefined;
    return {
      ...v,
      channelId: resolved.channelId,
      thumbnailUrl: hqThumbnailUrl(v.videoId),
      likes: extra.get(v.videoId)?.likes,
      comments: extra.get(v.videoId)?.comments,
      ...(paid !== undefined ? { paidViews: paid, organicViews: Math.max(0, total - paid) } : {}),
    };
  });

  const channel: AuditChannel = {
    channelId: resolved.channelId,
    handle: profile.handle ?? resolved.handle,
    title: profile.title,
    subscriberCount: profile.subscriberCount,
    videoCount: profile.videoCount,
    viewCount: profile.viewCount,
  };

  // channels.list 1 + playlistItems 1/page + videos.list 1/50, counted twice
  // because the profile helper fetches stats of its own.
  const pages = Math.ceil(ids.length / 50) || 1;
  const quotaUnits = 1 + pages + pages * 2;

  return { channel, videos, quotaUnits };
}

/**
 * Ingest several competitor channels, tolerating individual failures.
 *
 * One dead handle in a proposed set must not sink an audit that has already
 * spent quota — the report simply notes a smaller market. Errors are returned
 * rather than thrown so the caller can show which channels were dropped.
 */
export async function ingestCompetitors(
  channels: { channelId: string | null; handle: string | null; title: string }[],
  { maxVideos = 300, now = Date.now() }: { maxVideos?: number; now?: number } = {},
): Promise<{
  results: IngestResult[];
  failures: { title: string; reason: string }[];
  quotaUnits: number;
}> {
  const results: IngestResult[] = [];
  const failures: { title: string; reason: string }[] = [];
  let quotaUnits = 0;

  for (const c of channels) {
    const ref = c.channelId || (c.handle ? `@${c.handle.replace(/^@/, "")}` : c.title);
    try {
      const r = await ingestChannel(ref, { maxVideos, now });
      results.push(r);
      quotaUnits += r.quotaUnits;
    } catch (err: any) {
      // A quota error is different in kind: everything after it would fail too,
      // so stop rather than burning through the list producing empty failures.
      if (err?.name === "YoutubeQuotaError") throw err;
      failures.push({ title: c.title, reason: String(err?.message || err) });
    }
  }

  return { results, failures, quotaUnits };
}

/**
 * Check that proposed competitors actually exist, before anyone is asked to
 * approve them.
 *
 * A language model asked to name competitors will produce plausible handles it
 * has invented — the first real run proposed eight channels of which several
 * were not real. An approval step that shows a mix of real and imaginary
 * channels is worse than no approval step: it looks like a decision but the
 * operator has no way to tell them apart, and the invented ones silently
 * shrink the market the report is built on.
 *
 * So each is resolved against the API (about 1 quota unit each, against a
 * 10,000/day budget). Ones that resolve gain a real channel id and subscriber
 * count; ones that do not are marked `include: false` and kept visible with a
 * reason, rather than quietly deleted — seeing what was discarded is part of
 * judging whether the market was understood.
 */
export async function verifyProposedCompetitors(
  proposed: { channelId: string | null; handle: string | null; title: string; reason: string; include: boolean }[],
  /**
   * The subject's own subscriber count. A "competitor" two orders of magnitude
   * smaller is not one, and on the first real run that is exactly what came
   * back — invented handles resolved through YouTube's SEARCH fallback to
   * unrelated channels with 4, 76 and 82 subscribers. Resolving is not the same
   * as existing, and a channel that resolves to something implausible is worse
   * than one that fails outright, because it silently becomes market data.
   */
  subjectSubscribers?: number | null,
): Promise<{
  verified: {
    channelId: string | null;
    handle: string | null;
    title: string;
    reason: string;
    include: boolean;
    subscriberCount?: number | null;
  }[];
  quotaUnits: number;
}> {
  const verified: Awaited<ReturnType<typeof verifyProposedCompetitors>>["verified"] = [];
  let quotaUnits = 0;
  const seen = new Set<string>();

  for (const c of proposed) {
    const ref = c.channelId || (c.handle ? `@${c.handle.replace(/^@/, "")}` : c.title);
    try {
      const r = await resolveChannelId(ref);
      quotaUnits += 1;
      if (!r) {
        verified.push({ ...c, include: false, reason: `${c.reason} — could not be found on YouTube` });
        continue;
      }
      // The same channel proposed twice under different names would otherwise
      // be scanned twice and double-count in every market median.
      if (seen.has(r.channelId)) continue;
      seen.add(r.channelId);

      const stats = await fetchChannelStats([r.channelId]);
      quotaUnits += 1;
      const s: any = stats.get(r.channelId);
      const subs: number | null = s?.subscriberCount ?? null;

      // A channel under a twentieth of the subject's size is not a competitor,
      // it is a search-fallback accident. The floor scales with the subject so
      // it means the same thing for a 500-sub channel as for a 500k one.
      const floor = subjectSubscribers && subjectSubscribers > 0 ? subjectSubscribers / 20 : 0;
      if (floor && subs !== null && subs < floor) {
        verified.push({
          ...c,
          channelId: r.channelId,
          handle: r.handle ?? c.handle,
          title: s?.title || c.title,
          subscriberCount: subs,
          include: false,
          reason: `Resolved to "${s?.title || "an unrelated channel"}" with ${subs.toLocaleString()} subscribers — too small to be a competitor, so this handle was probably wrong`,
        });
        continue;
      }

      verified.push({
        ...c,
        channelId: r.channelId,
        handle: r.handle ?? c.handle,
        title: s?.title || c.title,
        subscriberCount: subs,
        include: true,
      });
    } catch (err: any) {
      if (err?.name === "YoutubeQuotaError") throw err;
      verified.push({ ...c, include: false, reason: `${c.reason} — lookup failed` });
    }
  }

  return { verified, quotaUnits };
}

/** Subscriber/view totals for channels we know only by id. */
export async function hydrateChannelStats(channelIds: string[]): Promise<Map<string, AuditChannel>> {
  const out = new Map<string, AuditChannel>();
  if (!channelIds.length) return out;
  const stats = await fetchChannelStats(channelIds);
  for (const [id, s] of stats) {
    out.set(id, {
      channelId: id,
      handle: null,
      title: (s as any).title ?? "",
      subscriberCount: (s as any).subscriberCount ?? null,
      videoCount: (s as any).videoCount ?? null,
      viewCount: (s as any).viewCount ?? null,
    });
  }
  return out;
}
