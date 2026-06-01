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
