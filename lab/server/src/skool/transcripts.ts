/**
 * What is IN the videos the classroom attaches.
 *
 * Jake's instruction (2026-08-05): the agent should know "what's inside each
 * course including what's inside each video (transcription)". A lesson page and
 * the video on it are not the same content — the write-ups summarise, and the
 * video is where the actual walkthrough lives. An agent that has only read the
 * page can answer what a lesson covers but not what it SHOWS.
 *
 * ⚠️ TRANSCRIPTS ARE FETCHED ONCE AND STORED. `fetchTranscript` calls Apify and
 * has no cache of its own, so this is the cache — retrieval reads the table and
 * never the network. Backfilling is therefore an explicit, one-time operation
 * with a progress report, not something a query triggers by accident.
 *
 * ⚠️ AND IT COSTS REAL MONEY, unlike everything else in this feature. The model
 * calls run on the Max subscription precisely so this agent bills nothing; Apify
 * does not work that way. That is a reason to cache hard and to make the
 * backfill deliberate, not a reason to skip it.
 */
import { db } from "../db/index.js";
import { fetchTranscript } from "../audit/content.js";
import { getApifyToken } from "../settings/postizSecrets.js";

export type TranscriptStatus = "ok" | "empty" | "failed";

export interface TranscriptRow {
  videoId: string;
  text: string;
  chars: number;
  status: TranscriptStatus;
  fetchedAt: number;
}

/**
 * Pull the YouTube id out of whatever Skool stored.
 *
 * Skool's `metadata.videoLink` is not one shape — it holds watch URLs, youtu.be
 * short links and embeds. Returning null for an unrecognised one is deliberate:
 * a wrong id fetches a stranger's transcript and grounds a lesson in it, which
 * is far worse than having no transcript.
 */
export function youtubeIdFrom(url: string | null): string | null {
  if (!url) return null;
  const s = String(url);
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})\b/,
    /youtu\.be\/([A-Za-z0-9_-]{11})\b/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})\b/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})\b/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  // A bare id, which is what some of the plan's own rows carry.
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}

/**
 * YouTube's own captions, for free.
 *
 * Jake's call (2026-08-05): try this before spending Apify credit, since the
 * whole feature is meant to cost nothing. There is no public API for captions,
 * so this does what a browser does — load the watch page, read the caption
 * track list out of `ytInitialPlayerResponse`, and fetch the track.
 *
 * ⚠️ EXPECTED TO FAIL SOMETIMES, AND THAT IS WHY APIFY STAYS. YouTube serves
 * consent walls and bot checks to datacenter IPs — the same mitigation that
 * makes TikTok unusable from this box (see the engagement tool's scars). So
 * every failure here is a normal outcome, not an error, and the caller falls
 * through to the paid path rather than treating the video as caption-less.
 *
 * Returns null for "could not get it", which is deliberately distinct from
 * "this video genuinely has no captions" — only the second is worth caching.
 */
export async function fetchFreeCaptions(videoId: string): Promise<{ text: string | null; noCaptions: boolean }> {
  try {
    const watch = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: {
        // Without a real UA YouTube serves a stripped page with no player
        // response at all, which reads exactly like a video with no captions.
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!watch.ok) return { text: null, noCaptions: false };
    const html = await watch.text();

    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|const|let|<\/script>)/s);
    if (!m) return { text: null, noCaptions: false };

    let player: any;
    try {
      player = JSON.parse(m[1]);
    } catch {
      return { text: null, noCaptions: false };
    }

    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(tracks) || !tracks.length) {
      // The player answered and listed no captions — that IS the fact, and it
      // is worth caching rather than paying Apify to rediscover it.
      const playable = player?.playabilityStatus?.status;
      return { text: null, noCaptions: playable === "OK" };
    }

    const track =
      tracks.find((t: any) => String(t?.languageCode ?? "").startsWith("en")) ?? tracks[0];
    const baseUrl = String(track?.baseUrl ?? "");
    if (!baseUrl) return { text: null, noCaptions: false };

    const capRes = await fetch(`${baseUrl}&fmt=json3`, { signal: AbortSignal.timeout(30_000) });
    if (!capRes.ok) return { text: null, noCaptions: false };
    const cap: any = await capRes.json().catch(() => null);
    const text = (Array.isArray(cap?.events) ? cap.events : [])
      .flatMap((e: any) => (Array.isArray(e?.segs) ? e.segs.map((s: any) => String(s?.utf8 ?? "")) : []))
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    // Same 200-character floor as the Apify path: a handful of characters is
    // an artefact, not a transcript.
    return { text: text.length > 200 ? text : null, noCaptions: false };
  } catch {
    return { text: null, noCaptions: false };
  }
}

export function getTranscript(videoId: string): TranscriptRow | null {
  const row = db
    .prepare(`SELECT video_id, text, chars, status, fetched_at FROM skool_transcripts WHERE video_id = ?`)
    .get(videoId) as any;
  if (!row) return null;
  return {
    videoId: row.video_id,
    text: row.text,
    chars: row.chars,
    status: row.status as TranscriptStatus,
    fetchedAt: row.fetched_at,
  };
}

/** Every stored transcript, as a lookup. Read once per retrieval, not per lesson. */
export function transcriptMap(): Map<string, TranscriptRow> {
  const rows = db
    .prepare(`SELECT video_id, text, chars, status, fetched_at FROM skool_transcripts`)
    .all() as any[];
  return new Map(
    rows.map((r) => [
      r.video_id,
      { videoId: r.video_id, text: r.text, chars: r.chars, status: r.status, fetchedAt: r.fetched_at },
    ]),
  );
}

function saveTranscript(videoId: string, text: string, status: TranscriptStatus, source: string): void {
  db.prepare(
    `INSERT INTO skool_transcripts (video_id, text, chars, status, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET text = excluded.text, chars = excluded.chars,
       status = excluded.status, source = excluded.source, fetched_at = excluded.fetched_at`,
  ).run(videoId, text, text.length, status, source, Date.now());
}

export interface BackfillResult {
  requested: number;
  alreadyHad: number;
  fetched: number;
  /** How many came from YouTube for free, and how many had to be bought. */
  fromYoutube: number;
  fromApify: number;
  empty: number;
  failed: number;
  chars: number;
  /** Videos that came back with nothing — worth checking, one of them is dead. */
  emptyIds: string[];
  error: string | null;
}

/**
 * Fetch and store every transcript that is missing.
 *
 * Sequential on purpose. Apify's run-sync endpoint is slow and this is a
 * one-time backfill of under a hundred videos — parallelising it would buy a
 * few minutes and risk rate-limiting a paid service mid-run, leaving a
 * half-filled table whose gaps look like videos without captions.
 *
 * `refetchEmpty` is off by default: a video with captions off will be empty
 * again tomorrow, and re-buying that answer every run is exactly what the cache
 * is for. Turn it on when a video is known to have gained captions.
 */
export async function backfillTranscripts(
  videoIds: string[],
  opts: {
    refetchEmpty?: boolean;
    /** Never touch Apify. The free path only, for a run that must cost nothing. */
    freeOnly?: boolean;
    onProgress?: (done: number, total: number, videoId: string, note: string) => void;
  } = {},
): Promise<BackfillResult> {
  const out: BackfillResult = {
    requested: videoIds.length,
    alreadyHad: 0,
    fetched: 0,
    fromYoutube: 0,
    fromApify: 0,
    empty: 0,
    failed: 0,
    chars: 0,
    emptyIds: [],
    error: null,
  };

  const token = opts.freeOnly ? "" : getApifyToken();
  if (!token && !opts.freeOnly) {
    // Not fatal any more: the free path needs no credentials, so a missing
    // Apify token degrades the run rather than ending it.
    out.error = "No Apify token is configured — the free YouTube path ran alone, so some videos may be missing.";
  }

  const wanted = Array.from(new Set(videoIds.filter(Boolean)));
  let done = 0;
  for (const videoId of wanted) {
    const have = getTranscript(videoId);
    if (have && (have.status === "ok" || (have.status === "empty" && !opts.refetchEmpty))) {
      out.alreadyHad++;
      done++;
      opts.onProgress?.(done, wanted.length, videoId, "cached");
      continue;
    }

    // 1. Free first — Jake's call, and the whole point of the feature is that
    //    it does not spend.
    const free = await fetchFreeCaptions(videoId);
    if (free.text) {
      saveTranscript(videoId, free.text, "ok", "youtube");
      out.fetched++;
      out.fromYoutube++;
      out.chars += free.text.length;
      done++;
      opts.onProgress?.(done, wanted.length, videoId, `youtube ${free.text.length}ch`);
      continue;
    }
    if (free.noCaptions) {
      // YouTube answered and said there are none. Paying Apify to be told the
      // same thing is the one case where the fallback is pure waste.
      saveTranscript(videoId, "", "empty", "youtube");
      out.empty++;
      out.emptyIds.push(videoId);
      done++;
      opts.onProgress?.(done, wanted.length, videoId, "no captions");
      continue;
    }

    // 2. Free path could not answer — blocked, bot-checked, or unparseable.
    if (!token) {
      saveTranscript(videoId, "", "failed", "youtube-blocked");
      out.failed++;
      done++;
      opts.onProgress?.(done, wanted.length, videoId, "free path failed, no paid fallback");
      continue;
    }

    let text: string | null = null;
    let failed = false;
    try {
      text = await fetchTranscript(videoId, token);
    } catch {
      failed = true;
    }

    if (failed) {
      // NOT stored as "empty" — a transport failure is a retryable unknown, and
      // recording it as "this video has no captions" would make it permanent.
      saveTranscript(videoId, "", "failed", "apify");
      out.failed++;
      opts.onProgress?.(++done, wanted.length, videoId, "apify failed");
    } else if (!text) {
      saveTranscript(videoId, "", "empty", "apify");
      out.empty++;
      out.emptyIds.push(videoId);
      opts.onProgress?.(++done, wanted.length, videoId, "apify empty");
    } else {
      saveTranscript(videoId, text, "ok", "apify");
      out.fetched++;
      out.fromApify++;
      out.chars += text.length;
      opts.onProgress?.(++done, wanted.length, videoId, `apify ${text.length}ch`);
    }
  }

  return out;
}

/** Coverage, for reporting: how much of the classroom's video is actually known. */
export function transcriptCoverage(videoIds: string[]): {
  videos: number;
  withText: number;
  empty: number;
  failed: number;
  missing: number;
  chars: number;
} {
  const map = transcriptMap();
  const wanted = Array.from(new Set(videoIds.filter(Boolean)));
  let withText = 0;
  let empty = 0;
  let failed = 0;
  let missing = 0;
  let chars = 0;
  for (const id of wanted) {
    const row = map.get(id);
    if (!row) missing++;
    else if (row.status === "ok") {
      withText++;
      chars += row.chars;
    } else if (row.status === "empty") empty++;
    else failed++;
  }
  return { videos: wanted.length, withText, empty, failed, missing, chars };
}
