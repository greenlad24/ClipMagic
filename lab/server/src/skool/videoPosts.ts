/**
 * "One post a week about a new video, and never the same video twice."
 *
 * Jake, 2026-08-07: "at least one post per week should be about a new video I
 * posted. Never post about the same video twice and if there's no new video
 * posted don't post about it."
 *
 * That last clause is the load-bearing one, and it is the reason this is a
 * LEDGER rather than a counter. "Post about a new video weekly" implemented as
 * "every week, announce the most recent upload" would re-announce the same video
 * every week for as long as Jake did not upload — confidently, on schedule, to
 * everyone's inbox. The ledger makes the question "has THIS video been announced
 * yet", which answers itself correctly when there is nothing new.
 *
 * ⚠️ THE LEDGER IS WRITTEN WHEN THE POST LANDS, NOT WHEN IT IS DRAFTED. A slot
 * that drafts and then fails to publish would otherwise burn the video: the
 * retry would find it already announced, skip it, and the video would never get
 * its post. This is the same mistake the pinned-subject path made and had to fix
 * — a subject reserved against a slot that never delivered.
 */
import { db } from "../db/index.js";
import { channelVideos, type ChannelVideo } from "./channelVideos.js";

/**
 * How recently a video must have been published to still count as "new".
 *
 * ⚠️ WITHOUT A WINDOW, "not yet announced" WOULD MEAN THE ENTIRE BACK CATALOGUE.
 * The ledger starts empty, so on the first run every upload YouTube returns is
 * unannounced — and the agent would work backwards through months of old videos
 * announcing each as news, one a week, indefinitely. The window is what makes
 * "if there's no new video posted don't post about it" true on day one.
 *
 * 14 days: long enough that a video uploaded the day after a posting day still
 * gets its post, short enough that nothing stale is ever called new.
 */
export const NEW_VIDEO_DAYS = 14;

export interface AnnouncedVideo {
  videoId: string;
  title: string;
  slotKey: string;
  postedAt: number;
}

export function announcedVideos(): AnnouncedVideo[] {
  const rows = db
    .prepare(`SELECT video_id, title, slot_key, posted_at FROM skool_video_posts ORDER BY posted_at DESC`)
    .all() as Array<{ video_id: string; title: string; slot_key: string; posted_at: number }>;
  return rows.map((r) => ({ videoId: r.video_id, title: r.title, slotKey: r.slot_key, postedAt: r.posted_at }));
}

export function hasAnnounced(videoId: string): boolean {
  const row = db.prepare(`SELECT 1 AS n FROM skool_video_posts WHERE video_id = ?`).get(videoId) as
    | { n: number }
    | undefined;
  return !!row;
}

/** Record that a video's post actually went out. Idempotent. */
export function recordAnnounced(videoId: string, title: string, slotKey: string): void {
  db.prepare(
    `INSERT INTO skool_video_posts (video_id, title, slot_key, posted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(video_id) DO NOTHING`,
  ).run(videoId, title, slotKey, Date.now());
}

/**
 * The newest upload that is genuinely new and has never been announced.
 *
 * Null is the ordinary answer and means "write about a lesson instead" — not an
 * error, and never a reason to skip a posting day. Shorts are never the answer:
 * see the loop below.
 */
export async function nextVideoToAnnounce(now = Date.now()): Promise<ChannelVideo | null> {
  const videos = await channelVideos();
  if (videos.length === 0) return null;
  const cutoff = now - NEW_VIDEO_DAYS * 24 * 60 * 60 * 1000;

  // `channelVideos` is newest-first, so the first survivor is the right one.
  for (const v of videos) {
    if (!v.publishedAt || v.publishedAt < cutoff) break;
    // ⚠️⚠️ SHORTS ARE NOT "THE NEW VIDEO". Jake, 2026-08-28: "when you're taking
    // the last video, never use shorts — only long form videos (if there isn't
    // a new long form video just talk about a class)." This is not hypothetical
    // tidiness: measured the same day, his two most recent uploads were a 35s
    // and a 30s Short, so the next announcement due would have told 73 members
    // and their inboxes to go watch a thirty-second clip.
    //
    // Skipped rather than breaking the loop — a Short published on top of an
    // unannounced tutorial must not hide it.
    if (v.isShort) continue;
    if (!hasAnnounced(v.videoId)) return v;
  }
  return null;
}

/** Has a video announcement gone out since `since`? Drives the weekly rule. */
export function announcedSince(since: number): AnnouncedVideo[] {
  const rows = db
    .prepare(`SELECT video_id, title, slot_key, posted_at FROM skool_video_posts WHERE posted_at >= ? ORDER BY posted_at DESC`)
    .all(since) as Array<{ video_id: string; title: string; slot_key: string; posted_at: number }>;
  return rows.map((r) => ({ videoId: r.video_id, title: r.title, slotKey: r.slot_key, postedAt: r.posted_at }));
}

/**
 * The subject line for announcing a video.
 *
 * The drafter is given the video's real title and URL and told to write the post
 * around it; the URL is repeated here because the subject is what gets stored on
 * the slot and re-read on a retry.
 */
export function videoSubject(v: ChannelVideo): string {
  return (
    `Jake just published a new YouTube video: "${v.title}" (${v.url}). ` +
    `Tell the community it is out, what it covers and who should watch it, and point them at it. ` +
    `Write it from the video's title and the classroom material you have — do not invent details about what is in the video.`
  );
}
