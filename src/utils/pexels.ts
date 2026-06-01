/**
 * Pexels stock-footage source.
 *
 * A free, instant source of REAL situational footage (people, places, actions)
 * for conceptual b-roll beats that have no matching promo clip — tried BEFORE
 * paid AI generation so most situational cutaways use real footage instead of a
 * generated clip. Requires PEXELS_API_KEY in the server environment; if it's
 * not set, search returns null and the caller falls back to generation.
 *
 * Docs: https://www.pexels.com/api/documentation/#videos-search
 */

export interface StockClip {
  url: string;        // direct video link (.mp4/.webm/.mov/.m4v)
  mediaType: "video"; // always video — used so consumers never sniff the URL
  width: number;
  height: number;
  durationSec: number;
  query: string;
  pexelsId?: number;
}

export function pexelsConfigured(): boolean {
  return !!(process.env.PEXELS_API_KEY ?? "").trim();
}

/**
 * Derive a concise, concrete stock-search query for a beat. Prefers the
 * director's matchKeywords (it's instructed to write a filmable query there);
 * otherwise falls back to the caption / transcript snippet.
 *
 * This is the cheap, no-LLM fallback. Prefer buildContextualStockQuery() which
 * grounds the query in the WHOLE video so generic words don't pull off-topic
 * footage (e.g. "workers" returning the wrong country for a US-jobs video).
 */
export function pexelsQueryFromBeat(labels: Record<string, any>, caption: string): string {
  const kws = Array.isArray(labels?.matchKeywords)
    ? labels.matchKeywords.filter((k: any) => typeof k === "string" && k.trim())
    : [];
  if (kws.length) return kws.slice(0, 5).join(" ").slice(0, 100);
  const fallback = (caption || labels?.transcriptSnippet || labels?.veo3Prompt || "").toString();
  return fallback.split(/\s+/).slice(0, 6).join(" ").slice(0, 100);
}

/**
 * Build a stock-search query that is GROUNDED IN THE WHOLE VIDEO so generic
 * beat words inherit the right context (place, demographic, setting, subject).
 * E.g. a beat saying "workers" in a video about the US job market becomes
 * "american office workers" rather than an unrelated country's footage.
 *
 * Falls back to pexelsQueryFromBeat() if the LLM call fails.
 */
export async function buildContextualStockQuery(
  client: any,
  ctx: {
    videoTopic?: string;
    transcript?: string;
    beatText: string;        // caption / transcript snippet for this beat
    keywords?: string[];
  },
  tag: string,
): Promise<string> {
  const naive = pexelsQueryFromBeat({ matchKeywords: ctx.keywords }, ctx.beatText);
  try {
    // NOTE: this runs on the self-hosted server through the OpenAI->Claude shim,
    // where the model id "gpt-4o-mini" is mapped to the CHEAP+ACCURATE Claude
    // fast tier (Claude Haiku). So this is a Claude call, not OpenAI.
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You write SHORT stock-footage search queries for Pexels. Given the OVERALL video topic and the specific moment, output 2-5 concrete, filmable English words describing real footage to show. " +
            "CRITICAL: inherit context from the overall topic — if the video is about the US job market, 'workers' must become 'american office workers', not a generic/foreign scene. Encode place, setting, and people when the topic implies them. " +
            "No punctuation, no quotes, no abstract words. Output ONLY the query.",
        },
        {
          role: "user",
          content:
            `OVERALL VIDEO TOPIC: ${ctx.videoTopic || "(unknown)"}\n` +
            (ctx.transcript ? `TRANSCRIPT (context): ${ctx.transcript.slice(0, 1200)}\n` : "") +
            `THIS MOMENT (narration): "${ctx.beatText}"\n` +
            (ctx.keywords?.length ? `Beat keywords: ${ctx.keywords.join(", ")}\n` : "") +
            `\nStock search query:`,
        },
      ],
      temperature: 0.3,
      max_tokens: 24,
    });
    const q = (res.choices?.[0]?.message?.content ?? "").trim().replace(/["'\n]/g, " ").replace(/\s+/g, " ").slice(0, 100);
    if (q) {
      console.log(`${tag} Contextual stock query: "${q}" (naive was "${naive}")`);
      return q;
    }
  } catch (e: any) {
    console.warn(`${tag} Contextual query failed, using naive: ${e?.message}`);
  }
  return naive;
}

/**
 * Search Pexels for a portrait (9:16-friendly) video clip matching `query`.
 * Returns the best vertical mp4 link, or null if nothing usable / not configured.
 */
export async function searchPexelsVideo(
  query: string,
  minDurationSec: number,
  tag: string,
): Promise<StockClip | null> {
  const key = (process.env.PEXELS_API_KEY ?? "").trim();
  if (!key) return null;
  const q = (query ?? "").trim();
  if (!q) return null;

  try {
    const u = new URL("https://api.pexels.com/videos/search");
    u.searchParams.set("query", q);
    u.searchParams.set("orientation", "portrait");
    u.searchParams.set("size", "medium");
    u.searchParams.set("per_page", "15");
    const res = await fetch(u.toString(), { headers: { Authorization: key } });
    if (!res.ok) {
      console.warn(`${tag} Pexels search HTTP ${res.status} for "${q}"`);
      return null;
    }
    const data: any = await res.json().catch(() => ({}));
    const videos: any[] = Array.isArray(data.videos) ? data.videos : [];
    if (!videos.length) {
      console.log(`${tag} Pexels: no results for "${q}"`);
      return null;
    }

    // Rank: prefer vertical clips long enough for the beat, then by how close
    // the height is to ~1280 (good quality without being huge).
    //
    // VIDEO ONLY — the definitive guard against "it returned an image":
    // a candidate file is accepted ONLY when its link is a real downloadable
    // VIDEO CONTAINER (.mp4/.webm/.mov/.m4v). We do NOT trust file_type alone
    // (Pexels sometimes mislabels it), and we explicitly reject image
    // extensions, HLS manifests, and Pexels' `video_pictures` (those are the
    // poster JPEGs — never put one in clipUrl).
    const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;
    const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|$)/i;
    let best: StockClip | null = null;
    let bestScore = -Infinity;
    let inspected = 0;
    let rejected = 0;
    for (const v of videos) {
      const dur = typeof v.duration === "number" ? v.duration : 0;
      const files: any[] = Array.isArray(v.video_files) ? v.video_files : [];
      for (const f of files) {
        inspected++;
        const w = f.width ?? 0;
        const h = f.height ?? 0;
        const link = (f.link as string | undefined) ?? "";
        if (!link) { rejected++; continue; }
        if (IMAGE_EXT.test(link)) { rejected++; continue; }       // never an image
        if (/\.m3u8(\?|$)/i.test(link)) { rejected++; continue; } // skip HLS manifests
        // The link itself MUST be a video container — this is what guarantees
        // we never hand back an image, regardless of how file_type is labelled.
        if (!VIDEO_EXT.test(link)) { rejected++; continue; }
        const isPortrait = h >= w && h > 0;
        let score = 0;
        if (isPortrait) score += 1000;
        if (dur >= minDurationSec) score += 200;
        // prefer ~720–1280 tall: close to 1280 is best, penalize tiny/huge
        score -= Math.abs(h - 1280) / 10;
        if (score > bestScore) {
          bestScore = score;
          best = { url: link, mediaType: "video", width: w, height: h, durationSec: dur, query: q, pexelsId: v.id };
        }
      }
    }
    if (best) {
      console.log(`${tag} Pexels VIDEO match for "${q}": ${best.url} (${best.width}x${best.height}, ${best.durationSec}s, id=${best.pexelsId})`);
    } else {
      console.warn(`${tag} Pexels: ${videos.length} results but no usable VIDEO file (inspected ${inspected}, rejected ${rejected}) for "${q}"`);
    }
    return best;
  } catch (e: any) {
    console.warn(`${tag} Pexels error: ${e?.message ?? e}`);
    return null;
  }
}
