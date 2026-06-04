/**
 * Reaction-sticker search for the Meme/Sticker editor.
 *
 * The default sticker SOURCE. For each emphasis moment the director gives us a
 * short search query (e.g. "mind blown"); this module queries BOTH the Giphy and
 * Tenor sticker libraries, resolves each result to a TRANSPARENT STATIC still
 * (so it reads as a die-cut sticker and animates cleanly via the Remotion pop —
 * not a moving GIF), and merges the candidates from both providers. The caller
 * (an AI fit-review) then picks the best-fitting candidate or drops the sticker.
 *
 * Both providers are FREE (just an API key), so the per-image $ cost is $0.
 *
 *  • Giphy stickers — GET /v1/stickers/search. Each result carries a `*_still`
 *    rendition (a transparent PNG of the first frame). We use the still URL.
 *    https://developers.giphy.com/docs/api/endpoint#search
 *  • Tenor v2 — GET /v2/search with media_filter restricted to STATIC, TRANSPARENT
 *    sticker formats (transparent_webp / transparent_gif / png_transparent).
 *    https://developers.google.com/tenor/guides/endpoints#search
 *
 * Design (mirrors the imagegen module's "optional and safe" stance):
 *  • Graceful: no key for a provider → that provider yields zero candidates;
 *    no key for EITHER → zero candidates total, caller falls back / captions-only.
 *  • Any network / parse error for one provider never sinks the other.
 *  • Downloaded stills are persisted under the project's data dir and served via
 *    /api/outputs/stickers so Remotion's headless <Img> can fetch them.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { config } from "../config.js";

const GIPHY_BASE = process.env.GIPHY_BASE_URL || "https://api.giphy.com";
const TENOR_BASE = process.env.TENOR_BASE_URL || "https://tenor.googleapis.com";
/** How many candidates to pull per provider per moment (kept small for the review). */
const PER_PROVIDER_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.MEME_STICKER_CANDIDATES || "3", 10),
);

export function giphyConfigured(): boolean {
  return !!process.env.GIPHY_API_KEY;
}
export function tenorConfigured(): boolean {
  return !!process.env.TENOR_API_KEY;
}
/** True when at least one reaction-sticker provider has a key. */
export function stickerSearchConfigured(): boolean {
  return giphyConfigured() || tenorConfigured();
}

export interface StickerCandidate {
  /** "giphy" | "tenor" — which library it came from (logged / diagnostics). */
  provider: "giphy" | "tenor";
  /** Remote URL of the transparent STATIC still (PNG/WEBP/GIF first frame). */
  url: string;
  /** The provider's title/description, if any (helps the fit-review). */
  title?: string;
}

function stickersDir(): string {
  const dir = path.join(config.outputsDir, "stickers");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Giphy ──────────────────────────────────────────────────────────────────

/**
 * Parse a Giphy /v1/stickers/search response into transparent static-still
 * candidates. Exported for unit testing against realistic API JSON.
 *
 * Giphy renditions: we prefer the largest *_still that exists, since stills are
 * transparent PNGs of the first frame. We try a sensible order and skip results
 * with no usable still.
 */
export function parseGiphyStickers(json: unknown, limit = PER_PROVIDER_LIMIT): StickerCandidate[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: StickerCandidate[] = [];
  // Preference order: larger stills first, then any *_still as a catch-all.
  const stillKeys = [
    "original_still",
    "fixed_height_still",
    "fixed_width_still",
    "480w_still",
    "preview_still",
  ];
  for (const item of data) {
    const images = (item as { images?: Record<string, { url?: string }> })?.images;
    if (!images) continue;
    let url: string | undefined;
    for (const k of stillKeys) {
      const u = images[k]?.url;
      if (typeof u === "string" && u) { url = u; break; }
    }
    // Fallback: ANY rendition key ending in _still with a url.
    if (!url) {
      for (const [k, v] of Object.entries(images)) {
        if (k.endsWith("_still") && typeof v?.url === "string" && v.url) { url = v.url; break; }
      }
    }
    if (!url) continue;
    const title = (item as { title?: string })?.title;
    out.push({ provider: "giphy", url, title: typeof title === "string" ? title : undefined });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchGiphy(query: string, limit: number): Promise<StickerCandidate[]> {
  if (!giphyConfigured()) return [];
  try {
    const url =
      `${GIPHY_BASE}/v1/stickers/search?api_key=${encodeURIComponent(process.env.GIPHY_API_KEY!)}` +
      `&q=${encodeURIComponent(query)}&limit=${limit * 2}&rating=pg-13&bundle=messaging_non_clips`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`giphy ${res.status}`);
    const json = await res.json();
    return parseGiphyStickers(json, limit);
  } catch (e) {
    console.warn(`[meme] giphy search "${query}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

// ── Tenor ────────────────────────────────────────────────────────────────────

/**
 * Parse a Tenor v2 /search response into transparent STATIC-still candidates.
 * Exported for unit testing against realistic API JSON.
 *
 * We restrict the request to STATIC, TRANSPARENT formats and read them from each
 * result's media_formats in preference order. (The "_transparent" formats carry
 * alpha; png_transparent / *_transparent are stills, not animations.)
 */
export function parseTenorStickers(json: unknown, limit = PER_PROVIDER_LIMIT): StickerCandidate[] {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  const out: StickerCandidate[] = [];
  // Static + transparent formats, largest/most-reliable first.
  const formatKeys = [
    "png_transparent",
    "webp_transparent",
    "gif_transparent",
    "tinygif_transparent",
    "tinywebp_transparent",
  ];
  for (const item of results) {
    const formats = (item as { media_formats?: Record<string, { url?: string }> })?.media_formats;
    if (!formats) continue;
    let url: string | undefined;
    for (const k of formatKeys) {
      const u = formats[k]?.url;
      if (typeof u === "string" && u) { url = u; break; }
    }
    // Fallback: any format key containing "transparent".
    if (!url) {
      for (const [k, v] of Object.entries(formats)) {
        if (k.includes("transparent") && typeof v?.url === "string" && v.url) { url = v.url; break; }
      }
    }
    if (!url) continue;
    const title =
      (item as { content_description?: string })?.content_description ||
      (item as { title?: string })?.title;
    out.push({ provider: "tenor", url, title: typeof title === "string" ? title : undefined });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchTenor(query: string, limit: number): Promise<StickerCandidate[]> {
  if (!tenorConfigured()) return [];
  try {
    const url =
      `${TENOR_BASE}/v2/search?key=${encodeURIComponent(process.env.TENOR_API_KEY!)}` +
      `&q=${encodeURIComponent(query)}&limit=${limit * 2}&searchfilter=sticker` +
      `&media_filter=png_transparent,webp_transparent,gif_transparent&contentfilter=medium`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`tenor ${res.status}`);
    const json = await res.json();
    return parseTenorStickers(json, limit);
  } catch (e) {
    console.warn(`[meme] tenor search "${query}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Query BOTH providers for a moment and return the merged candidate list
 * (Giphy first, then Tenor). Each is a transparent static still URL. Errors in
 * one provider never sink the other; an empty list means nothing was found.
 */
export async function searchStickerCandidates(
  query: string,
  perProvider = PER_PROVIDER_LIMIT,
): Promise<StickerCandidate[]> {
  const [g, t] = await Promise.all([
    searchGiphy(query, perProvider),
    searchTenor(query, perProvider),
  ]);
  return [...g, ...t];
}

export interface DownloadedSticker {
  /** Local absolute path to the persisted still. */
  file: string;
  /** Public URL Remotion/manifest loads (/api/outputs/stickers/...). */
  url: string;
}

/**
 * Download a chosen candidate's still to the project data dir (cached by URL).
 * Returns null on any fetch error so the caller can fall back gracefully.
 * The on-disk extension follows the source content (png/webp/gif), all of which
 * carry alpha and load in Remotion's <Img>.
 */
export async function downloadSticker(candidate: StickerCandidate): Promise<DownloadedSticker | null> {
  const key = crypto.createHash("sha1").update(candidate.url).digest("hex").slice(0, 24);
  const ext = extFor(candidate.url);
  const file = path.join(stickersDir(), `${key}${ext}`);
  const url = `/api/outputs/stickers/${key}${ext}`;
  if (fs.existsSync(file)) return { file, url };
  try {
    const res = await fetch(candidate.url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) throw new Error("empty image");
    fs.writeFileSync(file, bytes);
    return { file, url };
  } catch (e) {
    console.warn(
      `[meme] sticker download failed (${candidate.provider}): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

function extFor(url: string): string {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".webp")) return ".webp";
  if (clean.endsWith(".gif")) return ".gif";
  return ".png";
}
