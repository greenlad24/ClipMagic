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

/**
 * Caption platforms = the tuned short trio PLUS "generic". Channels whose
 * canonical platform is null (e.g. a Facebook Page) post as "generic": one
 * general-audience caption rule, reusing the scheduling engine's generic window.
 */
export type CaptionPlatform = ShortPlatform | "generic";

/** Output for one platform. */
export interface PlatformCaption {
  platform: CaptionPlatform;
  /** Keyword-rich first line — the SEO/search hook (also reused as YT title). */
  firstLineHook: string;
  /** Full caption (already includes the hook as its first line). */
  caption: string;
  /** Hashtags WITHOUT the leading '#'. */
  hashtags: string[];
}

/** Tunable per-platform best-practice guidance the prompt encodes. */
export interface PlatformRule {
  platform: CaptionPlatform;
  label: string;
  /** Target hashtag count range. */
  minTags: number;
  maxTags: number;
  /** Soft caption length cap (chars) used for trimming + prompt guidance. */
  maxCaptionChars: number;
  /** The best-practice instruction injected into the prompt for this platform. */
  guidance: string;
}

export const PLATFORM_RULES: Record<CaptionPlatform, PlatformRule> = {
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
  // Generic / general-audience (e.g. a Facebook Page). One untuned rule reused
  // for any channel without a tuned short-form platform — deliberately broad,
  // not per-network. Facebook allows long captions + outbound links (unlike IG).
  generic: {
    platform: "generic",
    label: "Facebook / general",
    minTags: 2,
    maxTags: 5,
    maxCaptionChars: 2000,
    guidance:
      "Write an engaging general-audience caption for a vertical short-form clip. Strong first-line hook that front-loads the topic, then 1–2 sentences of value, ending with a comment-driving CTA. Light hashtag use (2–5). Outbound links are allowed (unlike IG). Conversational and shareable.",
  },
};

export const SHORT_PLATFORMS: ShortPlatform[] = ["tiktok", "instagram", "youtube"];

/** Caption platforms we can generate/score for (short trio + generic). */
export const CAPTION_PLATFORMS: CaptionPlatform[] = [...SHORT_PLATFORMS, "generic"];

// ── Caption growth scoring (PURE — runs independently of the AI) ─────────────
// These encode 2026 short-form (TikTok-led) caption best-practices so a caption
// can be graded WHETHER the AI wrote it OR the user hand-edited it. The scorer
// never calls the model — it inspects the final text the way the platform would.
//
// `required` checks gate scheduling (the caption is missing a fundamental growth
// signal); `recommended` checks only lower the score (they're things a tool
// can't truly verify — e.g. whether a hook actually hooks — so they advise, not
// block). See bulkScheduler.ts for how `required` failures gate the schedule.

export type CheckSeverity = "required" | "recommended";

export interface GrowthCheck {
  id: string;
  label: string;
  pass: boolean;
  severity: CheckSeverity;
  /** Actionable, one-line fix shown in the review UI. */
  hint: string;
}

export interface CaptionScore {
  /** 0..100, weighted by severity (required checks weigh more than recommended). */
  score: number;
  checks: GrowthCheck[];
}

/** Question/explicit-CTA detection for the comment-driving check. */
const CTA_PROMPT_RE =
  /\b(comment|tell me|drop a|let me know|which|what'?s your|would you|tag (a|someone)|agree\??|thoughts\??|save this|share this|follow for)\b/i;

/** Weak openers that signal a slow intro rather than a 3-second hook. */
const WEAK_OPENERS = [
  "hi", "hey", "hello", "so", "today", "in this video", "i want to", "i wanted to",
  "welcome", "this is", "just", "um", "okay", "ok",
];

/** First non-empty line of a caption. */
function firstLine(caption: string): string {
  return caption.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/**
 * Score a caption + its hashtags for one platform. PURE: no AI, no IO. Used both
 * to seed the score on AI-written captions AND to re-validate user edits, so the
 * gate can't be bypassed by editing the caption after preview.
 *
 * Checks (severity in parens):
 *   - keyword-front (required): a real keyword sits in the first ~40 chars — the
 *     SEO/search hook. Front-loading the topic is the single biggest 2026 search
 *     ranking lever on TikTok/Shorts.
 *   - hook-strength (recommended/ADVISORY): the first line doesn't open with a
 *     slow filler word. A tool can't verify a hook truly hooks, so this advises.
 *   - comment-cta (required): the caption ends with a question or explicit prompt
 *     — comments are weighted heavily by the ranking systems.
 *   - hashtag-count (required): within the platform's niche+broad range (e.g.
 *     3–5 on TikTok). 0 kills discovery; a wall of 15 reads as spam.
 *   - hashtag-mix (recommended/ADVISORY): a spread of tag lengths ≈ niche+broad.
 *   - length-cap (required): within the platform's caption cap.
 */
export function scoreCaption(
  caption: string,
  hashtags: string[],
  platform: CaptionPlatform,
): CaptionScore {
  const rule = PLATFORM_RULES[platform];
  const text = (caption ?? "").trim();
  const line1 = firstLine(text);
  const head = line1.slice(0, 40);
  const tags = (hashtags ?? []).map((t) => normalizeHashtag(t)).filter((t): t is string => !!t);

  // keyword-front: ≥2 "word" tokens of ≥3 chars within the first 40 chars, i.e.
  // the line leads with substantive topic words, not a single emoji or "Hey 👋".
  const headWords = head.match(/[A-Za-z0-9][A-Za-z0-9'-]{2,}/g) ?? [];
  const keywordFront = headWords.length >= 2;

  // hook-strength (advisory): doesn't open with a known weak/slow opener.
  const firstWord = (line1.match(/[A-Za-z']+/)?.[0] ?? "").toLowerCase();
  const lowerHead = line1.toLowerCase();
  const weakOpen =
    WEAK_OPENERS.includes(firstWord) || WEAK_OPENERS.some((w) => w.includes(" ") && lowerHead.startsWith(w));
  const strongHook = line1.length > 0 && !weakOpen;

  // comment-cta: ends with a question, or contains an explicit comment/CTA prompt.
  const endsQuestion = /\?\s*$/.test(text);
  const hasCta = endsQuestion || CTA_PROMPT_RE.test(text);

  // hashtag count + mix.
  const countOk = tags.length >= rule.minTags && tags.length <= rule.maxTags;
  // niche+broad heuristic: at least one "broad" short tag AND one "niche" long
  // tag (length is a cheap proxy — broad tags like #fyp are short, niche ones
  // like #budgetmealprepideas are long). ADVISORY only.
  const hasBroad = tags.some((t) => t.length <= 6);
  const hasNiche = tags.some((t) => t.length >= 10);
  const goodMix = tags.length >= 2 && hasBroad && hasNiche;

  const withinCap = text.length > 0 && text.length <= rule.maxCaptionChars;

  const checks: GrowthCheck[] = [
    {
      id: "keyword-front",
      label: "Keyword in the first line",
      pass: keywordFront,
      severity: "required",
      hint: "Lead the first ~40 characters with the topic/search keyword, not an emoji or greeting.",
    },
    {
      id: "hook-strength",
      label: "3-second hook",
      pass: strongHook,
      severity: "recommended",
      hint: weakOpen
        ? `Don't open with "${firstWord}". Start with curiosity, a payoff, or a question.`
        : "Open with curiosity, a payoff, or a bold claim so the first line stops the scroll.",
    },
    {
      id: "comment-cta",
      label: "Comment-driving CTA",
      pass: hasCta,
      severity: "required",
      hint: "End with a question or an explicit prompt (e.g. \"Which would you pick?\") — comments are weighted heavily.",
    },
    {
      id: "hashtag-count",
      label: `${rule.minTags}–${rule.maxTags} hashtags`,
      pass: countOk,
      severity: "required",
      hint: `Use ${rule.minTags}–${rule.maxTags} hashtags — currently ${tags.length}. Too few hurts reach; too many reads as spam.`,
    },
    {
      id: "hashtag-mix",
      label: "Niche + broad hashtag mix",
      pass: goodMix,
      severity: "recommended",
      hint: "Mix at least one broad tag (e.g. #fyp) with a specific niche tag (e.g. #budgetmealprep).",
    },
    {
      id: "length-cap",
      label: `Within ${rule.maxCaptionChars}-char cap`,
      pass: withinCap,
      severity: "required",
      hint:
        text.length === 0
          ? "Caption is empty."
          : `Trim the caption to ≤ ${rule.maxCaptionChars} characters for ${rule.label}.`,
    },
  ];

  return { score: scoreChecks(checks), checks };
}

/**
 * Weighted 0..100 score over a check list. `required` checks count double so a
 * caption that satisfies the recommendeds but misses a required still scores
 * meaningfully below one that nails the fundamentals. Shared by caption +
 * pre-flight so the combined Growth Score uses one consistent formula.
 */
export function scoreChecks(checks: GrowthCheck[]): number {
  let got = 0;
  let total = 0;
  for (const c of checks) {
    const w = c.severity === "required" ? 2 : 1;
    total += w;
    if (c.pass) got += w;
  }
  if (total === 0) return 100;
  return Math.round((got / total) * 100);
}

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

/** Max transcript characters sent to the model (keeps the prompt cost-bounded). */
export const MAX_TRANSCRIPT_PROMPT_CHARS = 4000;

function buildSystemPrompt(platforms: CaptionPlatform[], hasTranscript: boolean): string {
  const rules = platforms
    .map((p) => {
      const r = PLATFORM_RULES[p];
      return `- ${p} (${r.label}): ${r.guidance} Provide ${r.minTags}–${r.maxTags} hashtags. Caption ≤ ${r.maxCaptionChars} chars.`;
    })
    .join("\n");
  return [
    "You are a short-form social media SEO copywriter. You write DISTINCT, platform-native captions for the SAME video, optimized for each platform's search and discovery in 2026.",
    hasTranscript
      ? "You are given a TRANSCRIPT of what is ACTUALLY SAID in the video. Base every caption on the real spoken content: pull the genuine hook, the key points, and the search keywords straight from the transcript. The brief is only SUPPLEMENTARY context — when the transcript and the brief disagree, trust the transcript. Never invent claims that aren't supported by what's said."
      : "",
    "Rules per platform:",
    rules,
    "",
    // These mirror the PURE growth scorer (scoreCaption) so generated captions
    // start with a high Growth Score. Keep this list in sync with the checks.
    "Every caption MUST satisfy these growth guardrails:",
    "- Front-load the primary keyword/topic in the FIRST ~40 characters of the first line (SEO/search). No greeting or emoji opener.",
    "- The first line must be a 3-second hook (curiosity, payoff, or bold claim) — never a slow intro like \"Hi\", \"So\", \"Today\", or \"In this video\".",
    "- END the caption with a question or an explicit comment-driving CTA (comments are weighted heavily).",
    "- Hashtags: stay within the per-platform count above and MIX broad reach tags (short, e.g. fyp) with specific niche tags (longer, e.g. budgetmealprep).",
    "",
    "For EACH requested platform return: a keyword-rich firstLineHook, a full caption (whose first line IS that hook and which ENDS with the CTA/question), and a hashtags array (no leading '#', no spaces inside a tag).",
    "Make each platform's caption genuinely different in tone and structure — do NOT reuse the same text across platforms.",
    'Respond as JSON: { "platforms": { "<platform>": { "firstLineHook": string, "caption": string, "hashtags": string[] } } }',
  ]
    .filter(Boolean)
    .join("\n");
}

function buildUserPrompt(brief: string, platforms: CaptionPlatform[], transcript?: string): string {
  const ts = (transcript ?? "").trim();
  const lines: string[] = [];
  if (ts) {
    const clipped = ts.length > MAX_TRANSCRIPT_PROMPT_CHARS ? ts.slice(0, MAX_TRANSCRIPT_PROMPT_CHARS) : ts;
    lines.push("Video transcript (what is actually said — ground the captions in this):", clipped, "");
  }
  lines.push(
    `Video brief / topic${ts ? " (supplementary context only)" : ""}: ${
      brief.trim() || "(no brief provided — infer a sensible topic from the transcript and/or filename context)"
    }`,
    `Platforms to write for: ${platforms.join(", ")}`,
  );
  return lines.join("\n");
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
  platform: CaptionPlatform,
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

/** Options for generateCaptions. */
export interface GenerateCaptionsOptions {
  /** Transcript of what's actually said in the video — grounds the captions. */
  transcript?: string;
  /** Injectable AI call (tests pass a stub). */
  generate?: CaptionAiCall;
}

/**
 * Generate captions for one brief across the requested platforms. Returns a map
 * keyed by platform.
 *
 * The 3rd argument is either the injectable AI call (legacy/positional form used
 * by existing tests) OR an options object `{ transcript?, generate? }`. When a
 * transcript is supplied the prompt is grounded in the ACTUAL spoken content;
 * otherwise behavior is exactly as before (brief/metadata only).
 */
export async function generateCaptions(
  brief: string,
  platforms: CaptionPlatform[],
  opts: GenerateCaptionsOptions | CaptionAiCall = {},
): Promise<Record<CaptionPlatform, PlatformCaption>> {
  const { transcript, generate } =
    typeof opts === "function" ? { transcript: undefined, generate: opts } : opts;
  const gen = generate ?? defaultGenerate;
  const ts = (transcript ?? "").trim();

  const wanted = platforms.filter((p) => CAPTION_PLATFORMS.includes(p));
  if (wanted.length === 0) return {} as Record<CaptionPlatform, PlatformCaption>;

  const rawJson = await gen(buildSystemPrompt(wanted, Boolean(ts)), buildUserPrompt(brief, wanted, ts));
  let parsed: { platforms?: Record<string, unknown> } = {};
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = {};
  }
  const byPlatform = (parsed.platforms ?? {}) as Record<string, { firstLineHook?: unknown; caption?: unknown; hashtags?: unknown }>;

  const out = {} as Record<CaptionPlatform, PlatformCaption>;
  for (const p of wanted) {
    out[p] = assemblePlatformCaption(p, byPlatform[p] ?? {});
  }
  return out;
}
