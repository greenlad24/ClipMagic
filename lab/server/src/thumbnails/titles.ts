/**
 * Title generation for the Thumbnail Designer.
 *
 * BEFORE any thumbnail copy is written, we turn the pasted SCRIPT into a set of
 * strong titles — the most VIRAL/click-driving ones and the most SEO-optimized
 * ones. These are shown in the UI AND fed (as context) into both thumbnail
 * workflows, so the on-thumbnail text actually matches the video's real content
 * and packaging instead of generic filler.
 *
 * Cheap structured generation → runs on the fast (Haiku) tier; the AI layer is
 * injectable so assembly + normalization are unit-testable with a mocked model.
 */
import { claudeJSONForPurpose } from "../ai/claude.js";

export interface ThumbnailTitles {
  /** High-CTR, curiosity/shock titles. */
  viral: string[];
  /** Search-optimized titles (keyword-forward, clear). */
  seo: string[];
}

const SYSTEM =
  "You are a YouTube packaging strategist. Given the full SCRIPT of a video, write " +
  "two kinds of titles: (1) VIRAL titles — bold, curiosity- or shock-driven, " +
  "high-CTR, the kind that get clicks; and (2) SEO titles — clear, keyword-forward, " +
  "search-friendly, describing exactly what the video delivers. Titles must be " +
  "TRUE to the script's actual content (never invent claims), concise (ideally " +
  "≤70 characters), and must NOT contain money figures or dollar amounts.";

/** Pure, exported prompt builder so the contract is testable. */
export function buildTitlesUserText(script: string): string {
  return (
    "SCRIPT:\n" +
    script.trim().slice(0, 8000) +
    "\n\n" +
    "Return ONLY this JSON object:\n" +
    "{\n" +
    '  "viral": [ string, string, string ],\n' +
    '  "seo": [ string, string, string ]\n' +
    "}\n\n" +
    "3 viral + 3 SEO titles. Each ≤70 chars, true to the script, no money figures."
  );
}

function cleanTitle(s: unknown): string {
  return typeof s === "string" ? s.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim() : "";
}

/** Normalize a raw model object into deduped, trimmed title arrays. Pure + exported. */
export function normalizeTitles(raw: any): ThumbnailTitles {
  const arr = (v: unknown): string[] => {
    const list = Array.isArray(v) ? v : [];
    const out: string[] = [];
    for (const item of list) {
      const t = cleanTitle(item);
      if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    }
    return out.slice(0, 6);
  };
  return { viral: arr(raw?.viral), seo: arr(raw?.seo) };
}

/** Flatten titles into a single context list (viral first), for grounding copy. */
export function titlesAsContext(t: ThumbnailTitles): string[] {
  return [...t.viral, ...t.seo];
}

/** Injectable model call (returns the raw JSON string) — mocked in tests. */
export type GenerateJsonFn = (opts: { system: string; userText: string }) => Promise<string>;

const defaultGenerate: GenerateJsonFn = (opts) =>
  claudeJSONForPurpose({
    tier: "fast",
    purpose: "thumbnail-titles",
    system: opts.system,
    messages: [{ role: "user", content: opts.userText }],
  });

/**
 * Generate viral + SEO titles from a script. Best-effort: returns empty arrays on
 * any failure (the workflows then fall back to keyword-only grounding).
 */
export async function generateTitles(script: string, generate: GenerateJsonFn = defaultGenerate): Promise<ThumbnailTitles> {
  const text = (script || "").trim();
  if (!text) return { viral: [], seo: [] };
  try {
    const raw = await generate({ system: SYSTEM, userText: buildTitlesUserText(text) });
    return normalizeTitles(JSON.parse(raw));
  } catch {
    return { viral: [], seo: [] };
  }
}
