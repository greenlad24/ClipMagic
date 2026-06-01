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
  url: string;        // direct .mp4 link
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
    // VIDEO ONLY: we use the /videos/search endpoint, but each result's
    // video_files can include non-playable entries. Accept a file ONLY when its
    // MIME is video/* AND its link is a real video container — never an image
    // (.jpg/.png preview) and never a streaming manifest (.m3u8).
    const VIDEO_MIME = /^video\//i;
    const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;
    const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)(\?|$)/i;
    let best: StockClip | null = null;
    let bestScore = -Infinity;
    for (const v of videos) {
      const dur = typeof v.duration === "number" ? v.duration : 0;
      const files: any[] = Array.isArray(v.video_files) ? v.video_files : [];
      for (const f of files) {
        const w = f.width ?? 0;
        const h = f.height ?? 0;
        const link = (f.link as string | undefined) ?? "";
        const mime = (f.file_type as string | undefined) ?? "";
        // Must be a real downloadable video file.
        if (!link) continue;
        if (IMAGE_EXT.test(link)) continue;              // never an image
        if (/\.m3u8(\?|$)/i.test(link)) continue;        // skip HLS manifests
        const looksVideo = VIDEO_MIME.test(mime) || VIDEO_EXT.test(link);
        if (!looksVideo) continue;
        const isPortrait = h >= w && h > 0;
        let score = 0;
        if (isPortrait) score += 1000;
        if (dur >= minDurationSec) score += 200;
        // prefer ~720–1280 tall: close to 1280 is best, penalize tiny/huge
        score -= Math.abs(h - 1280) / 10;
        if (score > bestScore) {
          bestScore = score;
          best = { url: link, width: w, height: h, durationSec: dur, query: q, pexelsId: v.id };
        }
      }
    }
    if (best) {
      console.log(`${tag} Pexels match for "${q}": ${best.width}x${best.height} ${best.durationSec}s id=${best.pexelsId}`);
    }
    return best;
  } catch (e: any) {
    console.warn(`${tag} Pexels error: ${e?.message ?? e}`);
    return null;
  }
}
