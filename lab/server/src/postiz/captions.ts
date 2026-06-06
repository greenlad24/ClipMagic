/**
 * Per-platform SEO caption + hashtag engine for the Bulk Scheduler.
 *
 * Given a per-file brief (topic/description) and a target platform, generate a
 * DISTINCT, best-practice caption + hashtag set for that platform. Platform
 * rules live in a DATA TABLE (PLATFORM_RULES) so they're easy to tune; the
 * actual generation is one cost-aware Claude call per file (returning all the
 * connected platforms at once), routed to the fast tier.
 *
 * The AI call is injected (`generate`) so the assembly/validation is unit-tested
 * with a stub — no real network in tests.
 */
import { claudeJSONForPurpose } from "../ai/claude.js";
import type { ShortPlatform } from "./providerSettings.js";

/** Output for one platform. */
export interface PlatformCaption {
  platform: ShortPlatform;
  /** Keyword-rich first line — the SEO/search hook (also reused as YT title). */
  firstLineHook: string;
  /** Full caption (already includes the hook as its first line). */
  caption: string;
  /** Hashtags WITHOUT the leading '#'. */
  hashtags: string[];
}

/** Tunable per-platform best-practice guidance the prompt encodes. */
export interface PlatformRule {
  platform: ShortPlatform;
  label: string;
  /** Target hashtag count range. */
  minTags: number;
  maxTags: number;
  /** Soft caption length cap (chars) used for trimming + prompt guidance. */
  maxCaptionChars: number;
  /** The best-practice instruction injected into the prompt for this platform. */
  guidance: string;
}

export const PLATFORM_RULES: Record<ShortPlatform, PlatformRule> = {
  tiktok: {
    platform: "tiktok",
    label: "TikTok (US)",
    minTags: 3,
    maxTags: 5,
    maxCaptionChars: 300,
    guidance:
      "Short, punchy hook in the FIRST LINE that is keyword-rich for TikTok search/SEO. Trend-aware, conversational, native to TikTok. 3–5 hashtags mixing niche + broad. No links. Lead with the search keyword, not fluff.",
  },
  instagram: {
    platform: "instagram",
    label: "Instagram Reels (US)",
    minTags: 3,
    maxTags: 8,
    maxCaptionChars: 600,
    guidance:
      "Hook first line, then value, then a light CTA (save/share/follow). Use line breaks for readability. 3–8 hashtags mixing niche + medium-reach. No outbound links (IG suppresses them). Keep it warm and scannable.",
  },
  youtube: {
    platform: "youtube",
    label: "YouTube Shorts",
    minTags: 2,
    maxTags: 4,
    maxCaptionChars: 700,
    guidance:
      "First line is an SEO TITLE-STYLE phrase (this becomes the video title) — front-load the primary keyword. Follow with a keyword-dense 1–2 sentence description optimized for search/suggested. Include #Shorts plus 2–4 topical tags. Optimize for discovery, not chatter.",
  },
};

export const SHORT_PLATFORMS: ShortPlatform[] = ["tiktok", "instagram", "youtube"];

/** Injectable AI call — returns the model's raw JSON string. */
export type CaptionAiCall = (system: string, user: string) => Promise<string>;

/** Default AI call: cheap, fast-tier, attributed to the "caption" purpose. */
const defaultGenerate: CaptionAiCall = (system, user) =>
  claudeJSONForPurpose({
    tier: "fast",
    purpose: "caption",
    system,
    messages: [{ role: "user", content: user }],
  });

function buildSystemPrompt(platforms: ShortPlatform[]): string {
  const rules = platforms
    .map((p) => {
      const r = PLATFORM_RULES[p];
      return `- ${p} (${r.label}): ${r.guidance} Provide ${r.minTags}–${r.maxTags} hashtags. Caption ≤ ${r.maxCaptionChars} chars.`;
    })
    .join("\n");
  return [
    "You are a short-form social media SEO copywriter. You write DISTINCT, platform-native captions for the SAME video, optimized for each platform's search and discovery in 2025.",
    "Rules per platform:",
    rules,
    "",
    "For EACH requested platform return: a keyword-rich firstLineHook, a full caption (whose first line IS that hook), and a hashtags array (no leading '#', no spaces inside a tag).",
    "Make each platform's caption genuinely different in tone and structure — do NOT reuse the same text across platforms.",
    'Respond as JSON: { "platforms": { "<platform>": { "firstLineHook": string, "caption": string, "hashtags": string[] } } }',
  ].join("\n");
}

function buildUserPrompt(brief: string, platforms: ShortPlatform[]): string {
  return [
    `Video brief / topic: ${brief.trim() || "(no brief provided — infer a sensible generic topic from the filename context)"}`,
    `Platforms to write for: ${platforms.join(", ")}`,
  ].join("\n");
}

/** Normalize a single hashtag: strip '#', spaces, punctuation; keep alnum/underscore. */
export function normalizeHashtag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tag = raw.replace(/^#+/, "").replace(/[^A-Za-z0-9_]/g, "");
  return tag.length ? tag : null;
}

/**
 * Validate + clamp one platform's model output to its rule. Exported + pure so
 * the assembly is unit-tested without any AI. `youtube` always keeps #Shorts.
 */
export function assemblePlatformCaption(
  platform: ShortPlatform,
  raw: { firstLineHook?: unknown; caption?: unknown; hashtags?: unknown },
): PlatformCaption {
  const rule = PLATFORM_RULES[platform];
  const firstLineHook = typeof raw.firstLineHook === "string" ? raw.firstLineHook.trim() : "";
  let caption = typeof raw.caption === "string" ? raw.caption.trim() : firstLineHook;

  // Ensure the hook IS the first line of the caption.
  if (firstLineHook && !caption.startsWith(firstLineHook)) {
    caption = `${firstLineHook}\n\n${caption}`.trim();
  }
  if (caption.length > rule.maxCaptionChars) {
    caption = caption.slice(0, rule.maxCaptionChars).trimEnd();
  }

  // Hashtags: normalize, dedupe (case-insensitive), clamp to the rule's max.
  const seen = new Set<string>();
  const tags: string[] = [];
  const pushTag = (t: string | null) => {
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    tags.push(t);
  };
  if (Array.isArray(raw.hashtags)) for (const t of raw.hashtags) pushTag(normalizeHashtag(t));

  // YouTube must always carry #Shorts (front of the list).
  if (platform === "youtube" && !seen.has("shorts")) {
    tags.unshift("Shorts");
    seen.add("shorts");
  }
  const clamped = tags.slice(0, rule.maxTags);

  return {
    platform,
    firstLineHook: firstLineHook || caption.split("\n")[0] || "",
    caption,
    hashtags: clamped,
  };
}

/**
 * Generate captions for one brief across the requested platforms. Returns a map
 * keyed by platform. `generate` is injectable for tests.
 */
export async function generateCaptions(
  brief: string,
  platforms: ShortPlatform[],
  generate: CaptionAiCall = defaultGenerate,
): Promise<Record<ShortPlatform, PlatformCaption>> {
  const wanted = platforms.filter((p) => SHORT_PLATFORMS.includes(p));
  if (wanted.length === 0) return {} as Record<ShortPlatform, PlatformCaption>;

  const rawJson = await generate(buildSystemPrompt(wanted), buildUserPrompt(brief, wanted));
  let parsed: { platforms?: Record<string, unknown> } = {};
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = {};
  }
  const byPlatform = (parsed.platforms ?? {}) as Record<string, { firstLineHook?: unknown; caption?: unknown; hashtags?: unknown }>;

  const out = {} as Record<ShortPlatform, PlatformCaption>;
  for (const p of wanted) {
    out[p] = assemblePlatformCaption(p, byPlatform[p] ?? {});
  }
  return out;
}
