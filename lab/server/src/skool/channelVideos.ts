/**
 * Jake's real YouTube uploads — the only videos a post may point at.
 *
 * Jake, 2026-08-07: a post may attach "a YouTube video, GIF or a poll when it
 * fits", and he chose HIS OWN CHANNEL as the only source a video may come from.
 * Separately: "at least one post per week should be about a new video I posted.
 * Never post about the same video twice and if there's no new video posted don't
 * post about it." Both needs are served from here.
 *
 * ⚠️⚠️ THE FIRST VERSION OF THIS FILE READ `audit_runs.videos_json` AND WOULD
 * HAVE PUBLISHED A COMPETITOR'S VIDEOS AS JAKE'S OWN. That table holds whatever
 * the Channel Audit last measured, and the newest run (2026-07-30) audits
 * **Riley Brown's** channel — 208 videos, `channelId UCMcoud_ZW7cfxeIugBflSBw`,
 * handle `rileybrownai`. Jake's channel is `UCa5OAoQETuYHkx9Vh_TsMCg`. Nothing
 * about the column name says whose videos are in it, the ids are well-formed,
 * the titles are plausibly on-topic, and the drafts would have read perfectly.
 * It was caught only by reading `subject_json` beside it.
 *
 * So the source is the LIVE uploads playlist for the channel in settings, and
 * the channel identity is re-derived every time rather than remembered.
 *
 * ⚠️ AND WHEN THE API CANNOT ANSWER, THE ANSWER IS "NO VIDEO". Never a cached
 * guess, never the least-bad match: a post that publishes without an attachment
 * is fine, and a post carrying the wrong person's video is not recoverable —
 * it goes out to 65 inboxes at the same moment.
 */
import { getSkoolSettings } from "../db/skool.js";
import { recentVideoIds, resolveChannel } from "../engage/youtube.js";

export interface ChannelVideo {
  videoId: string;
  title: string;
  url: string;
  /** Epoch ms. 0 when YouTube did not say. */
  publishedAt: number;
}

/** A YouTube id is 11 characters of a known alphabet. Anything else is not one. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * How long the uploads list is reused before asking YouTube again.
 *
 * The scheduler ticks every 10 minutes and only drafts a few times a week, so
 * this is about not spending quota on ticks that do nothing, not about speed.
 */
const CACHE_MS = 30 * 60 * 1000;
let cache: { at: number; videos: ChannelVideo[] } | null = null;

/**
 * The channel's most recent uploads, newest first. Empty when unavailable.
 *
 * Costs 2 quota units (channels.list + playlistItems.list) at most twice an
 * hour. Never throws: every failure is "no videos", because every caller's
 * correct behaviour on failure is to attach nothing.
 */
export async function channelVideos(max = 25): Promise<ChannelVideo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.videos;

  const handle = (getSkoolSettings().channelUrl || "").trim();
  if (!handle) return [];

  try {
    // Accept a full URL, an @handle or a bare id — `resolveChannel` takes the
    // last path segment of a channel URL as its handle.
    const ref = handle.replace(/\/+$/, "").split("/").pop() || handle;
    const channel = await resolveChannel(ref);
    if (!channel?.uploadsPlaylistId) return [];

    const recent = await recentVideoIds(channel.uploadsPlaylistId, Math.max(1, Math.min(50, max)));
    const videos: ChannelVideo[] = [];
    const seen = new Set<string>();
    for (const v of recent) {
      const videoId = String(v?.videoId ?? "").trim();
      const title = String(v?.title ?? "").trim();
      if (!VIDEO_ID.test(videoId) || !title || seen.has(videoId)) continue;
      seen.add(videoId);
      const ms = v.publishedAt ? Date.parse(v.publishedAt) : NaN;
      videos.push({ videoId, title, url: youtubeUrl(videoId), publishedAt: Number.isFinite(ms) ? ms : 0 });
    }
    videos.sort((a, b) => b.publishedAt - a.publishedAt);
    cache = { at: Date.now(), videos };
    return videos;
  } catch {
    // Quota, key, network, a renamed channel — all the same answer.
    return [];
  }
}

/** Drop the memo, so a test or an operator can force a fresh read. */
export function forgetChannelVideos(): void {
  cache = null;
}

/** Is this id really one of the channel's uploads? The gate on every attachment. */
export async function isChannelVideo(videoId: string): Promise<boolean> {
  const all = await channelVideos();
  return all.some((v) => v.videoId === videoId);
}

const STOP = new Set([
  "the","a","an","and","or","but","for","with","without","from","into","your","you","my","me","it","its","this","that",
  "how","what","why","when","is","are","was","were","be","to","of","in","on","at","by","as","if","so","do","does","did",
  "not","no","new","best","top","full","guide","video","ai","just","get","make","step",
]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * The uploads worth OFFERING for a subject, best first.
 *
 * ⚠️ THIS RANKS, IT DOES NOT DECIDE. Word overlap is crude and exists only to
 * keep the candidate list cheap. The model picks from what it is shown and is
 * told plainly that "none" is a valid answer — a shortlist containing nothing
 * relevant must end in no attachment rather than the least-bad match.
 *
 * "ai" is a stop word deliberately: it is in most of the channel's titles and in
 * nearly every subject, so scoring on it ranks the catalogue by coincidence.
 */
export async function videosForSubject(subject: string, limit = 12): Promise<ChannelVideo[]> {
  const all = await channelVideos();
  if (all.length === 0) return [];

  const want = new Set(words(subject));
  const scored = all.map((v) => ({ v, overlap: want.size ? words(v.title).filter((w) => want.has(w)).length : 0 }));
  const hits = scored
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.v.publishedAt - a.v.publishedAt)
    .map((s) => s.v);

  // Always show a few of the newest even when nothing matches on words, so a
  // subject the titles do not name can still find its video. The model can see
  // they are unrelated and decline.
  const out: ChannelVideo[] = [];
  const seen = new Set<string>();
  for (const v of [...hits, ...all.slice(0, 5)]) {
    if (seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}
