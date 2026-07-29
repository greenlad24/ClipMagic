/**
 * Finding the real competitors — from YouTube, not from the model's memory.
 *
 * THE FIRST DESIGN ASKED THE MODEL TO NAME COMPETITORS AND IT DID NOT WORK.
 * Two runs against the same channel produced two entirely different sets, and
 * of eight proposed handles only two resolved to a plausible channel: the rest
 * were fabrications that YouTube's search fallback then matched to unrelated
 * channels with 0, 26 and 106 subscribers. A model recalling channel names is
 * guessing, and a market built on guesses invalidates every comparison in the
 * report.
 *
 * So competitors are DISCOVERED instead: search for what this channel's best
 * videos are actually about, collect the channels that genuinely rank for those
 * searches, and keep the ones of a comparable size. The model's judgement is
 * still used — but to CHOOSE among real channels rather than to remember them,
 * which is a question it can answer.
 *
 * This costs search quota (100 units a query, against 10,000/day) and is the
 * single most expensive part of an audit. It buys the one thing the report
 * cannot be right without.
 */
import { searchKeywordVideos, fetchChannelStats } from "../thumbnails/youtube.js";

export interface DiscoveredChannel {
  channelId: string;
  title: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  /** How many of the searches this channel showed up in — a crude relevance signal. */
  appearances: number;
  /** Their titles that ranked, so the model has something concrete to judge. */
  rankingTitles: string[];
}

/**
 * A competitor is within this factor of the subject's size, either way.
 *
 * Twenty is deliberately generous: a channel five times bigger is a realistic
 * aspiration and worth learning from, while one a hundredth of the size shares
 * nothing about what works at this scale. Without a floor the discovery fills
 * with dormant channels that happen to rank for a long-tail phrase.
 */
const SIZE_FACTOR = 20;

export async function discoverCompetitors(
  queries: string[],
  subject: { channelId: string; subscriberCount: number | null },
  { maxQueries = 6, perQuery = 25 }: { maxQueries?: number; perQuery?: number } = {},
): Promise<{ channels: DiscoveredChannel[]; quotaUnits: number }> {
  const found = new Map<string, { appearances: number; titles: string[] }>();
  let quotaUnits = 0;

  for (const q of queries.slice(0, maxQueries)) {
    if (!q?.trim()) continue;
    try {
      // longOnly drops Shorts: a Shorts-first channel is not a competitor for a
      // long-form catalogue even when it ranks for the same phrase.
      const res = await searchKeywordVideos(q.trim(), perQuery, undefined, { longOnly: true });
      quotaUnits += 100; // search.list is the expensive call
      const items = res.hits;
      // A channel appearing for several different searches is far more likely to
      // be a real competitor than one that ranked once for a long-tail phrase.
      const seenThisQuery = new Set<string>();
      for (const it of items) {
        const cid = it?.channelId;
        if (typeof cid !== "string" || !cid || cid === subject.channelId) continue;
        if (seenThisQuery.has(cid)) continue;
        seenThisQuery.add(cid);
        const rec = found.get(cid) ?? { appearances: 0, titles: [] };
        rec.appearances += 1;
        if (it?.title && rec.titles.length < 4) rec.titles.push(String(it.title));
        found.set(cid, rec);
      }
    } catch (err: any) {
      if (err?.name === "YoutubeQuotaError") throw err;
      // One failed search is survivable; the others still describe the market.
    }
  }

  if (!found.size) return { channels: [], quotaUnits };

  const ids = [...found.keys()];
  const stats = await fetchChannelStats(ids);
  quotaUnits += Math.ceil(ids.length / 50);

  const subs = subject.subscriberCount ?? null;
  const lo = subs ? subs / SIZE_FACTOR : 0;
  const hi = subs ? subs * SIZE_FACTOR : Number.POSITIVE_INFINITY;

  const channels: DiscoveredChannel[] = [];
  for (const [cid, rec] of found) {
    const s: any = stats.get(cid);
    if (!s) continue;
    const sc: number | null = s.subscriberCount ?? null;
    // Unknown size is kept — hidden subscriber counts are common and a channel
    // that ranks repeatedly is worth showing even if we cannot size it.
    if (sc !== null && (sc < lo || sc > hi)) continue;
    channels.push({
      channelId: cid,
      title: s.title ?? "",
      subscriberCount: sc,
      videoCount: s.videoCount ?? null,
      viewCount: s.viewCount ?? null,
      appearances: rec.appearances,
      rankingTitles: rec.titles,
    });
  }

  // Most-corroborated first, then largest — the model reads this top-down.
  channels.sort((a, b) => b.appearances - a.appearances || (b.subscriberCount ?? 0) - (a.subscriberCount ?? 0));
  return { channels: channels.slice(0, 25), quotaUnits };
}
