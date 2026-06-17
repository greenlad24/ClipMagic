/**
 * Title / description / tags generation for the Thumbnail Designer.
 *
 * Produces, via Claude (attributed to the "thumbnail-metadata" purpose):
 *   - titles[3]   — each PUTS THE SEO KEYWORD FIRST, then a viral hook second
 *                   (SEO priority first, virality second, per spec).
 *   - description — a short, keyword-rich YouTube description.
 *   - hashtags[]  — #-prefixed tags for the description.
 *   - tags[]      — plain YouTube tags (no #).
 *
 * The AI layer is injectable so the assembly + SEO-first ordering can be
 * unit-tested with a mocked model (no network).
 */
import { claudeJSONForPurpose } from "../ai/claude.js";
import type { VideoType } from "./videoType.js";

export interface ThumbnailMetadata {
  titles: string[];
  description: string;
  hashtags: string[];
  tags: string[];
}

const SYSTEM =
  "You are a YouTube SEO + packaging expert. Given a keyword and a video type, " +
  "write metadata that ranks AND gets clicks. CRITICAL title rule: every title " +
  "must lead with the SEO keyword (or a very close variant) at the FRONT, then a " +
  "viral hook second — SEO priority first, virality second. Keep titles under ~70 " +
  "characters. Tags are plain (no #); hashtags are #-prefixed. Be specific and " +
  "brand-safe.";

/** Pure, exported prompt builder so the contract is testable. */
export function buildMetadataUserText(keyword: string, videoType: VideoType): string {
  return (
    `Keyword: "${keyword}"\nVideo type: ${videoType}\n\n` +
    "Return ONLY this JSON object:\n" +
    "{\n" +
    '  "titles": [string, string, string],\n' +
    '  "description": string,\n' +
    '  "hashtags": [string, ...],\n' +
    '  "tags": [string, ...]\n' +
    "}\n\n" +
    "titles: exactly 3, each starting with the keyword then a hook. " +
    "hashtags: 3-6 items, each starting with '#'. tags: 8-15 plain keywords."
  );
}

/**
 * Normalize a raw model object into the strict ThumbnailMetadata shape: arrays
 * coerced, hashtags forced to start with '#', tags stripped of '#', empties
 * dropped. Pure + exported for unit testing the assembly.
 */
export function normalizeMetadata(raw: any): ThumbnailMetadata {
  const asStrings = (v: any): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];
  const titles = asStrings(raw?.titles).slice(0, 3);
  const description = typeof raw?.description === "string" ? raw.description.trim() : "";
  const hashtags = asStrings(raw?.hashtags).map((h) => (h.startsWith("#") ? h : `#${h.replace(/^#+/, "")}`));
  const tags = asStrings(raw?.tags).map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
  return { titles, description, hashtags, tags };
}

/** Injectable model call (returns the raw JSON string) — mocked in tests. */
export type GenerateJsonFn = (opts: {
  system: string;
  userText: string;
}) => Promise<string>;

const defaultGenerate: GenerateJsonFn = (opts) =>
  claudeJSONForPurpose({
    tier: "research",
    purpose: "thumbnail-metadata",
    system: opts.system,
    messages: [{ role: "user", content: opts.userText }],
  });

export async function generateMetadata(
  keyword: string,
  videoType: VideoType,
  generate: GenerateJsonFn = defaultGenerate,
): Promise<ThumbnailMetadata> {
  const raw = await generate({ system: SYSTEM, userText: buildMetadataUserText(keyword, videoType) });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Metadata generation returned non-JSON.");
  }
  const meta = normalizeMetadata(parsed);
  if (meta.titles.length === 0) throw new Error("Metadata generation returned no titles.");
  return meta;
}
