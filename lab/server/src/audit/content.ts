/**
 * What the winning videos actually DO — and what their viewers said about it.
 *
 * Titles and thumbnails explain why someone clicks. They cannot explain why
 * anyone stays, which is the half that compounds on YouTube. So the audit reads
 * the transcripts of the market's best videos and the comments underneath them.
 *
 * GETTING A COMPETITOR'S TRANSCRIPT IS THE AWKWARD PART, and the obvious routes
 * do not work:
 *   - The YouTube Data API's captions.download requires OAuth from the VIDEO'S
 *     OWNER. There is no endpoint for anyone else's captions at any quota cost.
 *   - The public timedtext URLs embedded in a watch page return 200 with a
 *     zero-byte body from this host — tested with and without browser headers
 *     and a referer. That is YouTube's soft IP block, the same one that stops
 *     downloads here.
 * So transcripts come through Apify, whose token is already configured for the
 * Engagement Manager. No audio is fetched and nothing is transcribed: the
 * captions already exist, this is only a way to reach them from a blocked host.
 *
 * Comments come straight from the Data API, one quota unit a video.
 *
 * The reading is done on the FAST tier. Pulling a hook type and a structure out
 * of a transcript is extraction, not judgement, and it runs across thirty
 * videos — the same reasoning that keeps the thumbnail pass cheap.
 */
import { claudeJSONForPurpose } from "../ai/claude.js";
import { getApifyToken, getYoutubeDataApiKey } from "../settings/postizSecrets.js";

const APIFY_ACTOR = "pintostudio~youtube-transcript-scraper";

/** Transcript fetches in flight at once. Apify bills per run, not per second. */
const CONCURRENCY = 4;

export interface VideoContent {
  videoId: string;
  title: string;
  channelTitle: string;
  views: number;
  transcript?: string;
  comments?: string[];
}

export function transcriptsAvailable(): boolean {
  return Boolean(getApifyToken());
}

/**
 * One video's transcript, or null.
 *
 * Null is an ordinary outcome — plenty of videos have captions disabled — and
 * the analysis simply runs over fewer videos rather than failing.
 */
async function fetchTranscript(videoId: string, token: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoUrl: `https://www.youtube.com/watch?v=${videoId}` }),
        signal: signal ?? AbortSignal.timeout(120_000),
      },
    );
    if (!r.ok) return null;
    const j: any = await r.json().catch(() => null);
    const rows: any[] = Array.isArray(j?.[0]?.data) ? j[0].data : [];
    const text = rows
      .map((d) => String(d?.text ?? ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

/** Top comments by relevance. 1 quota unit per video. */
async function fetchTopComments(videoId: string, max = 15): Promise<string[]> {
  const key = getYoutubeDataApiKey();
  if (!key) return [];
  try {
    const p = new URLSearchParams({
      part: "snippet",
      videoId,
      order: "relevance",
      maxResults: String(Math.min(50, max)),
      textFormat: "plainText",
      key,
    });
    const r = await fetch(`https://www.googleapis.com/youtube/v3/commentThreads?${p}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return []; // comments disabled is a 403 and is not an error here
    const j: any = await r.json().catch(() => null);
    return (Array.isArray(j?.items) ? j.items : [])
      .map((i: any) => String(i?.snippet?.topLevelComment?.snippet?.textDisplay ?? "").replace(/\s+/g, " ").trim())
      .filter((t: string) => t.length > 15)
      .slice(0, max);
  } catch {
    return [];
  }
}

/** Gather transcripts + comments for a set of videos, tolerating gaps. */
export async function gatherContent(
  videos: { videoId: string; title: string; channelTitle: string; views: number }[],
  { withComments = true }: { withComments?: boolean } = {},
): Promise<{ items: VideoContent[]; quotaUnits: number; transcripts: number }> {
  const token = getApifyToken();
  const out: VideoContent[] = [];
  let quotaUnits = 0;
  const queue = [...videos];

  async function worker() {
    for (;;) {
      const v = queue.shift();
      if (!v) return;
      const [transcript, comments] = await Promise.all([
        token ? fetchTranscript(v.videoId, token) : Promise.resolve(null),
        withComments ? fetchTopComments(v.videoId) : Promise.resolve([]),
      ]);
      if (withComments) quotaUnits += 1;
      out.push({ ...v, transcript: transcript ?? undefined, comments: comments.length ? comments : undefined });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, videos.length) }, worker));

  return { items: out, quotaUnits, transcripts: out.filter((i) => i.transcript).length };
}

const CONTENT_SYSTEM = `You read what a YouTube video actually DID, from its transcript, and what its viewers said, from its comments.

You are extracting, not judging. Report what is there.

For each video return:
{
  "videoId": "...",
  "hook": "what the first 30 seconds do to keep someone watching, in one line",
  "hookType": "a short label, e.g. 'result first', 'problem then promise', 'contrarian claim', 'story cold open'",
  "structure": "how the body is organised, in one line",
  "payoffAt": "roughly where the thing the title promised is actually delivered — 'immediately', 'a third in', 'the end', or 'never'",
  "viewerAsks": ["things commenters wanted, asked for, or complained was missing — quote or paraphrase, only what is actually there"],
  "praised": ["what commenters explicitly liked"]
}

Rules:
- If there is no transcript, set hook/structure to null and work from the comments alone.
- viewerAsks and praised must come from the comments given. Do not invent audience reactions; an empty list is a fine answer.
- No advice. No adjectives about quality. Say what happened.

Return {"videos": [ ... ] } with one object per video, in the order given.`;

export interface ContentRead {
  videoId: string;
  hook: string | null;
  hookType: string | null;
  structure: string | null;
  payoffAt: string | null;
  viewerAsks: string[];
  praised: string[];
}

/** Videos per extraction call. Transcripts are long; this keeps each call sane. */
const READ_BATCH = 3;

/** Excerpt a transcript: the open matters most, the close second, the middle least. */
function excerpt(t: string): string {
  if (t.length <= 6000) return t;
  return `${t.slice(0, 3500)}\n…[middle omitted]…\n${t.slice(-2000)}`;
}

export async function readContent(items: VideoContent[]): Promise<Map<string, ContentRead>> {
  const out = new Map<string, ContentRead>();
  const usable = items.filter((i) => i.transcript || (i.comments && i.comments.length));

  for (let i = 0; i < usable.length; i += READ_BATCH) {
    const batch = usable.slice(i, i + READ_BATCH);
    const body = batch
      .map(
        (b) =>
          `--- VIDEO ${b.videoId} — "${b.title}" (${b.channelTitle}, ${b.views.toLocaleString()} views)\n` +
          (b.transcript ? `TRANSCRIPT:\n${excerpt(b.transcript)}\n` : `TRANSCRIPT: none available\n`) +
          (b.comments?.length ? `TOP COMMENTS:\n${b.comments.map((c) => "  • " + c.slice(0, 300)).join("\n")}` : `TOP COMMENTS: none`),
      )
      .join("\n\n");

    try {
      const raw = await claudeJSONForPurpose({
        tier: "fast",
        purpose: "audit-content",
        system: CONTENT_SYSTEM,
        messages: [{ role: "user", content: body }],
      });
      const got = JSON.parse(raw);
      for (const v of Array.isArray(got?.videos) ? got.videos : []) {
        const id = String(v?.videoId ?? "");
        if (!batch.some((b) => b.videoId === id)) continue;
        out.set(id, {
          videoId: id,
          hook: v?.hook ? String(v.hook) : null,
          hookType: v?.hookType ? String(v.hookType) : null,
          structure: v?.structure ? String(v.structure) : null,
          payoffAt: v?.payoffAt ? String(v.payoffAt) : null,
          viewerAsks: Array.isArray(v?.viewerAsks) ? v.viewerAsks.map(String) : [],
          praised: Array.isArray(v?.praised) ? v.praised.map(String) : [],
        });
      }
    } catch {
      // One unreadable batch costs those videos, not the pass.
    }
  }
  return out;
}

/**
 * Roll the per-video reads into findings.
 *
 * Hook types are counted rather than averaged: "seven of the market's thirty
 * best open with the result" is a fact someone can act on, and it survives the
 * fact that we only ever look at winners.
 */
export function summariseContent(
  reads: Map<string, ContentRead>,
  byId: Map<string, { views: number; channelTitle: string }>,
): {
  hookTypes: { type: string; count: number; share: number; examples: string[] }[];
  payoff: { at: string; count: number }[];
  viewerAsks: string[];
  praised: string[];
  sampleSize: number;
} {
  const all = [...reads.values()];
  const n = all.length;
  const tally = (xs: (string | null)[]) => {
    const m = new Map<string, number>();
    for (const x of xs) {
      if (!x) continue;
      const k = x.trim().toLowerCase();
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const hookTypes = tally(all.map((r) => r.hookType))
    .slice(0, 8)
    .map(([type, count]) => ({
      type,
      count,
      share: n ? Math.round((count / n) * 100) / 100 : 0,
      examples: all
        .filter((r) => (r.hookType ?? "").toLowerCase() === type)
        .slice(0, 2)
        .map((r) => r.hook ?? "")
        .filter(Boolean),
    }));

  // Comments repeat themselves; the most-echoed asks are the signal, and the
  // long tail is noise from a handful of people.
  const askCounts = tally(all.flatMap((r) => r.viewerAsks));
  const praiseCounts = tally(all.flatMap((r) => r.praised));

  return {
    hookTypes,
    payoff: tally(all.map((r) => r.payoffAt)).map(([at, count]) => ({ at, count })),
    viewerAsks: askCounts.slice(0, 12).map(([t, c]) => (c > 1 ? `${t} (raised on ${c} videos)` : t)),
    praised: praiseCounts.slice(0, 8).map(([t, c]) => (c > 1 ? `${t} (on ${c} videos)` : t)),
    sampleSize: n,
  };
}
