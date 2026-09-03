/**
 * Video research: what the newest popular tutorials actually show on screen.
 *
 * Web research is good at what a tool IS and bad at where its buttons are — a
 * pricing page never says "click Settings, then Skills, then Browse". That gap is
 * why `stepScaffoldBlock` exists and why walkthroughs came out hedged behind
 * `[VERIFY ON SCREEN: …]` markers. A recent, heavily-watched tutorial is the one
 * source that does show the click path, because someone recorded themselves doing it.
 *
 * Two services, both already configured for other tools here:
 *   - YouTube Data API (getYoutubeDataApiKey) finds the videos.
 *   - An Apify actor pulls the transcript. YouTube blocks player requests from
 *     this server outright — LOGIN_REQUIRED on a datacenter IP — so scraping
 *     captions directly is not an option, and Apify is the same escape hatch
 *     engage/tiktok.ts and audit/content.ts already use.
 *
 * What comes back is fed to a model that extracts the PROCEDURE and never the
 * wording: menu names, the order of steps, the settings, the gotchas. Steps are
 * facts and facts are free; sentences belong to whoever wrote them, and a copied
 * sentence would break Jake's voice even where it broke nothing else.
 */
import { getApifyToken, getRapidApiKey, getYoutubeDataApiKey } from "../settings/postizSecrets.js";

const APIFY_BASE = process.env.APIFY_BASE_URL || "https://api.apify.com";
const TRANSCRIPT_ACTOR = process.env.SCRIPTGEN_TRANSCRIPT_ACTOR || "pintostudio~youtube-transcript-scraper";
const RAPIDAPI_HOST = "yt-api.p.rapidapi.com";

/** Jake's window: the newest tutorials, ranked by views. */
export const SEARCH_MONTHS = 3;
export const VIDEO_COUNT = 4;

/**
 * Under four minutes there is no workflow in the video — it is a Short, a teaser
 * or a "what is X" explainer. Those out-rank real tutorials on views (an 8.3M-view
 * "What is Claude Code?" beat every walkthrough on the topic), so length is the
 * filter that keeps view-ranking from selecting against the thing we came for.
 */
const MIN_SECONDS = 240;

/**
 * A live search for "Claude Code tutorial" returned, in the top four by views, a
 * 58-minute Japanese walkthrough and a video titled "Claude Code (Free Plan) +
 * YouTube = $77,000/Month". Neither is a source of click paths, and between them
 * they were most of the token budget.
 *
 * `relevanceLanguage` only biases the ranking, so language has to be filtered
 * afterwards on the video's own metadata. And an income-bait title is a reliable
 * marker of a video that never opens the product — plus Rule 6 bans money claims
 * outright, so a transcript full of them is the last thing this script needs
 * near its facts.
 */
const MONEY_BAIT = /\$\s?\d|\bincome\b|\bmake (?:money|\$)|\b\d+k\s*(?:\/|per |a )\s*(?:mo|month)|\bper month\b|\bpassive income\b/i;

/**
 * Does this video actually cover the topic, or is it just popular nearby?
 *
 * Every word of the topic that carries meaning has to appear in the title or
 * description. A one-word topic ("Blotato") must be named outright; a multi-word
 * one ("Claude Code") is allowed to have a word missing, because titles compress
 * — but not all of them.
 */
export function mentionsTopic(haystack: string, topic: string): boolean {
  const hay = haystack.toLowerCase();
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9.+]+/i)
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "how", "app", "ai"].includes(w));
  if (words.length === 0) return true;
  const hits = words.filter((w) => hay.includes(w)).length;
  return words.length === 1 ? hits === 1 : hits >= words.length - 1;
}

function isEnglish(lang: string | undefined): boolean {
  // Absent is common and not a reason to drop a video — only an explicit
  // non-English tag is. "en", "en-US" and "en-GB" all pass: they are English and
  // they all surface in a US search, and dropping en-GB would lose good
  // walkthroughs for no gain in what the viewer sees on screen.
  return !lang || /^en/i.test(lang);
}

export interface TutorialVideo {
  videoId: string;
  /** The video's own language tag, where it declares one. */
  lang?: string;
  title: string;
  channel: string;
  publishedAt: string;
  views: number;
  seconds: number;
  url: string;
}

export interface TranscribedVideo extends TutorialVideo {
  /** Plain transcript text with a timestamp every few lines, for citation. */
  transcript: string;
}

export function videoResearchConfigured(): boolean {
  // Search is required. Either transcript source will do — Apify is tried first
  // and RapidAPI catches the runs where an actor fails or returns nothing.
  return getYoutubeDataApiKey() != null && (getApifyToken() != null || getRapidApiKey() != null);
}

/** "PT15M13S" → 913. Returns 0 for anything unparseable. */
export function parseIsoDuration(iso: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

/** mm:ss for a citation. */
export function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The newest heavily-watched tutorials on the topic.
 *
 * `order=viewCount` inside a `publishedAfter` window is what "latest videos with
 * a lot of views" means in one query — YouTube sorts by views, the window keeps
 * them recent. When the window is empty (a tool that shipped last week, a topic
 * nobody has covered) the caller is told, rather than the window being widened
 * behind Jake's back: a two-year-old click path presented as current is the exact
 * failure this whole feature exists to prevent.
 */
export async function findTutorialVideos(
  topic: string,
  opts: { months?: number; count?: number } = {},
): Promise<TutorialVideo[]> {
  const key = getYoutubeDataApiKey();
  if (!key) return [];
  const months = opts.months ?? SEARCH_MONTHS;
  const count = opts.count ?? VIDEO_COUNT;

  const after = new Date();
  after.setMonth(after.getMonth() - months);

  const search = new URLSearchParams({
    part: "snippet",
    q: `${topic} tutorial`,
    type: "video",
    // RELEVANCE, not viewCount. Asking YouTube to sort by views returns whatever
    // is popular near the topic rather than about it — a search for "Blotato"
    // came back with "Claude Design OS" and "1-Person Business", and one for
    // "Claude Code" with two AI-trading videos. So relevance is bought from
    // YouTube, and the view ranking is applied here, over results that are
    // actually on topic.
    order: "relevance",
    publishedAfter: after.toISOString(),
    // Over-fetch: the length filter below discards Shorts and explainers, and
    // those are exactly what ranks highest on views.
    maxResults: "25",
    // English-language, US results. relevanceLanguage only biases the ranking —
    // it let a 58-minute Japanese walkthrough take the top slot — so the language
    // tag is filtered properly below. regionCode is what actually scopes the
    // search to the US.
    relevanceLanguage: "en",
    regionCode: "US",
    key,
  });
  const sr = await fetch(`https://www.googleapis.com/youtube/v3/search?${search}`);
  if (!sr.ok) throw new Error(`YouTube search failed (${sr.status})`);
  const sj = (await sr.json()) as { items?: Array<{ id?: { videoId?: string } }> };
  const ids = (sj.items ?? []).map((i) => i.id?.videoId).filter((v): v is string => !!v);
  if (ids.length === 0) return [];

  const detail = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: ids.join(","),
    key,
  });
  const dr = await fetch(`https://www.googleapis.com/youtube/v3/videos?${detail}`);
  if (!dr.ok) throw new Error(`YouTube lookup failed (${dr.status})`);
  const dj = (await dr.json()) as {
    items?: Array<{
      id: string;
      snippet: {
        title: string;
        description: string;
        channelTitle: string;
        publishedAt: string;
        defaultAudioLanguage?: string;
        defaultLanguage?: string;
      };
      statistics: { viewCount?: string };
      contentDetails: { duration: string };
    }>;
  };

  const candidates = (dj.items ?? [])
    .map((v) => ({
      videoId: v.id,
      title: v.snippet.title,
      channel: v.snippet.channelTitle,
      publishedAt: v.snippet.publishedAt.slice(0, 10),
      views: Number(v.statistics.viewCount ?? 0),
      seconds: parseIsoDuration(v.contentDetails.duration),
      url: `https://www.youtube.com/watch?v=${v.id}`,
      lang: v.snippet.defaultAudioLanguage ?? v.snippet.defaultLanguage,
      haystack: `${v.snippet.title} ${v.snippet.description ?? ""}`,
    }))
    .filter((v) => v.seconds >= MIN_SECONDS)
    .filter((v) => isEnglish(v.lang))
    .filter((v) => !MONEY_BAIT.test(v.title))
    .filter((v) => mentionsTopic(v.haystack, topic));

  // A video that names the topic in its TITLE is about the topic. One that only
  // mentions it in the description is usually a roundup that lists the tool in
  // passing — real for "Blotato", where three of four description-matches turned
  // out to be videos about something else that mention it. Title matches go
  // first, and descriptions only fill the slots left over.
  const byViews = (a: { views: number }, b: { views: number }) => b.views - a.views;
  const titled = candidates.filter((v) => mentionsTopic(v.title, topic)).sort(byViews);
  const rest = candidates.filter((v) => !mentionsTopic(v.title, topic)).sort(byViews);
  return [...titled, ...rest].slice(0, count).map(({ haystack, ...v }) => v);
}

interface TranscriptSegment {
  start?: string | number;
  text?: string;
}

/**
 * One video's transcript, timestamped every ~30 seconds.
 *
 * The stamps are not decoration: every step the extractor reports cites the video
 * and the moment it came from, so Jake can open the tab and check a click path
 * rather than taking the model's word for it.
 */
async function fetchViaApify(video: TutorialVideo): Promise<string | null> {
  const token = getApifyToken();
  if (!token) return null;
  const res = await fetch(
    `${APIFY_BASE}/v2/acts/${TRANSCRIPT_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoUrl: video.url }),
    },
  );
  if (!res.ok) return null;
  const items = (await res.json()) as Array<{ data?: TranscriptSegment[] }>;
  const segments = items?.[0]?.data;
  if (!Array.isArray(segments) || segments.length === 0) return null;
  return formatTranscript(segments);
}

/**
 * Fallback: RapidAPI's yt-api. Used when Apify fails, returns nothing, or has no
 * token — two independent providers, because a transcript that silently comes
 * back empty costs the run its click paths and nobody notices until the script
 * is hedged behind VERIFY markers again.
 *
 * The shape is read defensively on purpose. `/video/info` has been seen to return
 * the caption list under `subtitles`, under `subtitles.subtitles`, and as a bare
 * array; the track itself may carry `url` or `baseUrl`, and the file it points at
 * may be json3, XML timedtext or VTT. Anything unrecognised returns null and the
 * video is skipped rather than throwing the run away.
 */
async function fetchViaRapidApi(video: TutorialVideo): Promise<string | null> {
  const key = getRapidApiKey();
  if (!key) return null;
  const headers = { "x-rapidapi-key": key, "x-rapidapi-host": RAPIDAPI_HOST };

  const info = await fetch(`https://${RAPIDAPI_HOST}/video/info?id=${encodeURIComponent(video.videoId)}`, { headers });
  if (!info.ok) return null;
  const j = (await info.json()) as Record<string, unknown>;

  const tracks = pickSubtitleTracks(j);
  if (tracks.length === 0) return null;
  const track =
    tracks.find((t) => /^en/i.test(String(t.languageCode ?? t.language ?? ""))) ?? tracks[0];
  const url = String(track.url ?? track.baseUrl ?? "");
  if (!url) return null;

  // json3 parses cleanly into timed segments; ask for it where the URL allows.
  const jsonUrl = url.includes("fmt=") ? url : `${url}${url.includes("?") ? "&" : "?"}fmt=json3`;
  const cap = await fetch(jsonUrl);
  if (!cap.ok) return null;
  const body = await cap.text();
  const segments = parseCaptionBody(body);
  return segments.length > 0 ? formatTranscript(segments) : null;
}

/** The caption-track list, wherever this API decided to put it today. */
export function pickSubtitleTracks(payload: Record<string, unknown>): Array<Record<string, string>> {
  const candidates: unknown[] = [
    payload.subtitles,
    (payload.subtitles as Record<string, unknown> | undefined)?.subtitles,
    payload.captions,
    (payload.captions as Record<string, unknown> | undefined)?.captionTracks,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c as Array<Record<string, string>>;
  }
  return [];
}

/** json3, XML timedtext or VTT → timed segments. Unknown formats give []. */
export function parseCaptionBody(body: string): TranscriptSegment[] {
  const text = body.trim();
  if (!text) return [];

  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> };
      return (j.events ?? [])
        .map((e) => ({
          start: (e.tStartMs ?? 0) / 1000,
          text: (e.segs ?? []).map((sg) => sg.utf8 ?? "").join(""),
        }))
        .filter((seg) => seg.text.trim().length > 0);
    } catch {
      return [];
    }
  }

  if (text.startsWith("<")) {
    const out: TranscriptSegment[] = [];
    for (const m of text.matchAll(/<(?:text|p)[^>]*?(?:start|t)="([\d.]+)"[^>]*>([\s\S]*?)<\/(?:text|p)>/gi)) {
      const raw = Number(m[1]);
      out.push({ start: raw > 10000 ? raw / 1000 : raw, text: decodeXml(m[2]) });
    }
    return out.filter((seg) => String(seg.text).trim().length > 0);
  }

  if (/^WEBVTT/i.test(text)) {
    const out: TranscriptSegment[] = [];
    for (const block of text.split(/\n\n+/)) {
      const m = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/.exec(block);
      if (!m) continue;
      const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
      const line = block.split("\n").slice(1).join(" ").replace(/<[^>]+>/g, "").trim();
      if (line) out.push({ start, text: line });
    }
    return out;
  }

  return [];
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();
}

/**
 * One video's transcript: Apify first, RapidAPI second. Either provider failing
 * is ordinary — only both failing means this video contributes nothing.
 */
export async function fetchTranscript(video: TutorialVideo): Promise<string | null> {
  try {
    const viaApify = await fetchViaApify(video);
    if (viaApify) return viaApify;
    console.warn(`[scriptgen:videos] apify returned nothing for ${video.videoId}, trying yt-api`);
  } catch (e) {
    console.warn(`[scriptgen:videos] apify failed for ${video.videoId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return await fetchViaRapidApi(video);
  } catch (e) {
    console.warn(`[scriptgen:videos] yt-api failed for ${video.videoId}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Pure: segments → readable text with a timestamp every ~30 seconds. */
export function formatTranscript(segments: TranscriptSegment[]): string {
  const out: string[] = [];
  let nextStamp = 0;
  for (const seg of segments) {
    const text = (seg.text ?? "").trim();
    if (!text) continue;
    const start = Number(seg.start ?? 0);
    if (start >= nextStamp) {
      out.push(`\n[${stamp(start)}] `);
      nextStamp = start + 30;
    }
    out.push(text, " ");
  }
  return out.join("").replace(/[ \t]+/g, " ").trim();
}

/** The videos that had a transcript, in view order. Failures are skipped, not fatal. */
export async function gatherTutorialTranscripts(
  topic: string,
  opts: { months?: number; count?: number } = {},
): Promise<TranscribedVideo[]> {
  const videos = await findTutorialVideos(topic, opts);
  const out: TranscribedVideo[] = [];
  for (const v of videos) {
    try {
      const transcript = await fetchTranscript(v);
      if (transcript && transcript.length > 400) out.push({ ...v, transcript });
    } catch {
      // A video without captions is a gap in the sheet, not a failed run.
    }
  }
  return out;
}

/** The block handed to the extractor: each transcript under its own heading. */
export function transcriptsBlock(videos: TranscribedVideo[]): string {
  return videos
    .map(
      (v, i) =>
        `### VIDEO ${i + 1} — ${v.title}\n` +
        `Channel: ${v.channel} · Published: ${v.publishedAt} · ${v.views.toLocaleString()} views · ${stamp(v.seconds)} long\n` +
        `URL: ${v.url}\n\n${v.transcript}`,
    )
    .join("\n\n---\n\n");
}
