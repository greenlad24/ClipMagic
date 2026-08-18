/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  MODEL PRICING — single source of truth for the Optimization Report's $ math.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Every figure below is a REAL, published per-token / per-minute rate. Cost is
 *  always computed as (real tokens from the API `usage` field) × (rate here).
 *  Nothing is estimated. To update a price, edit the number AND its citation.
 *
 *  SOURCES (verified 2026-06-02; Anthropic rates re-verified 2026-07-30):
 *   • Anthropic Claude — official pricing page
 *     https://platform.claude.com/docs/en/about-claude/pricing
 *       Opus 5      : $5.00 in  / $25.00 out  per MTok
 *                     cache write (5m) $6.25 ; cache read (hit) $0.50
 *       Opus 4.8    : $5.00 in  / $25.00 out  per MTok
 *                     cache write (5m) $6.25 ; cache read (hit) $0.50
 *       Sonnet 4.6  : $3.00 in  / $15.00 out  per MTok
 *                     cache write (5m) $3.75 ; cache read (hit) $0.30
 *       Haiku 4.5   : $1.00 in  / $5.00  out  per MTok
 *                     cache write (5m) $1.25 ; cache read (hit) $0.10
 *     (Prompt-cache multipliers: 5m write = 1.25× base input, read = 0.10× base.)
 *     Opus 5 lists at the same rate as Opus 4.8. Its FAST mode is priced
 *     separately ($10/$50) and is deliberately absent here — nothing in the lab
 *     requests `speed: "fast"`, so pricing it would invite a wrong attribution.
 *
 *   • OpenAI — pricing (corroborated 2026-06-02 across openai.com/api/pricing and
 *     cloudzero.com/blog/openai-pricing). These rates have been stable.
 *       gpt-4o      : $2.50 in / $10.00 out per MTok
 *       gpt-4o-mini : $0.15 in / $0.60  out per MTok
 *       whisper-1   : $0.006 per minute of audio  ($0.36 / hour)
 *
 *   • Groq — whisper-large-v3-turbo
 *     https://groq.com/pricing  (corroborated by tokenmix.ai/blog/whisper-api-pricing)
 *       $0.04 per HOUR of audio  =  $0.000667 per minute.
 *
 *  The main app's code path (repo-root src/) uses the OpenAI rates above
 *  (whisper-1 + gpt-4o + gpt-4o-mini). The lab routes those same calls to Claude
 *  (Opus/Sonnet/Haiku) + Groq Whisper, so both rate tables live here and the
 *  baseline comparison is apples-to-apples on the SAME input.
 */

export const PRICING_SOURCE_DATE = "2026-06-02";

/** Per-MTok token rates ($/1,000,000 tokens). */
export interface TokenRate {
  /** Standard (uncached) input tokens. */
  input: number;
  /** Output tokens. */
  output: number;
  /** Prompt-cache WRITE per MTok (5-minute ephemeral). Optional. */
  cacheWrite?: number;
  /** Prompt-cache READ (hit) per MTok. Optional. */
  cacheRead?: number;
}

/**
 * Anthropic model rates, keyed by the exact model ID the lab sends. Keep these
 * keyed by the literal `model` string so a price lookup can never silently
 * mis-attribute (an unknown model returns undefined → cost marked n/a, never
 * guessed).
 */
export const ANTHROPIC_RATES: Record<string, TokenRate> = {
  // Opus 5 — the Channel Audit's report chat and section writer. Not a tier:
  // this model is asked for by name (see claudeJSONWithModel), so its rate has
  // to be keyed here or every audit chat prices at $0.
  "claude-opus-5": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  // Opus 4.8 — director tier.
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  // Sonnet 4.6 — research + review tier.
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  // Haiku 4.5 — fast tier (emphasis fallback).
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * OpenAI model rates, keyed by the exact model the MAIN APP sends. The lab's
 * runPipeline/reviewEdit pass these very strings ("whisper-1", "gpt-4o",
 * "gpt-4o-mini") before the shim re-routes them — so they are the genuine
 * main-app baseline models, used to price what the main app WOULD have spent.
 */
export const OPENAI_RATES: Record<string, TokenRate> = {
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

/** OpenAI Whisper transcription: $0.006 per minute of audio. */
export const OPENAI_WHISPER_PER_MINUTE = 0.006;

/**
 * OpenAI IMAGE generation — flat per-image price by model+size. Used by the
 * Sticker / Meme editor, which generates one funny still per emphasis moment.
 * These are real published rates (verified 2026-06-02):
 *   • gpt-image-1 — image pricing page, 1024×1024 "medium" quality = $0.04/image
 *     (the default we request; transparent-background PNG).
 *     https://platform.openai.com/docs/pricing  (image generation)
 *   • dall-e-3   — 1024×1024 standard = $0.04/image (fallback model).
 *     https://openai.com/api/pricing
 * Keyed by the exact model string we send so a price lookup can never silently
 * mis-attribute (unknown model → cost marked n/a, never guessed).
 */
export const OPENAI_IMAGE_PER_IMAGE: Record<string, number> = {
  "gpt-image-1": 0.04,
  "dall-e-3": 0.04,
};

/**
 * SEGMIND-hosted image generation — the Sticker/Meme editor's DEFAULT generator
 * and the reason its per-sticker cost fell ~6×. Segmind bills GPT Image 2 on
 * tokens ($5/MTok text in, $8/MTok image in, $30/MTok image out), which resolves
 * to these published per-image prices at 1024×1024 (verified 2026-08-13):
 *   low $0.01 · medium $0.06 · high $0.22
 *     https://www.segmind.com/models/gpt-image-2/pricing
 * We request "low" by default — see meme/imagegen.ts for why (and note that
 * "medium" would cost MORE than the $0.04 OpenAI path it replaced).
 *
 * These are only ever a FALLBACK estimate: Segmind returns the exact charge for
 * each call in its `x-cost` response header, and recordImageGeneration prefers
 * that real number whenever it is present.
 */
export const SEGMIND_IMAGE_PER_IMAGE: Record<string, number> = {
  "gpt-image-2:low": 0.01,
  "gpt-image-2:medium": 0.06,
  "gpt-image-2:high": 0.22,
};

/**
 * Estimated per-image price for a generator, by provider + model (+ quality for
 * the providers that price on it). Pure, and returns 0 for anything unknown so
 * an unpriced model is reported as $0 rather than silently guessed at.
 */
export function imagePricePerImage(
  model: string,
  provider = "openai",
  quality?: string,
): number {
  if (provider === "segmind") {
    return SEGMIND_IMAGE_PER_IMAGE[`${model}:${quality ?? "low"}`] ?? 0;
  }
  return OPENAI_IMAGE_PER_IMAGE[model] ?? 0;
}

/**
 * Reaction-sticker LIBRARIES used by the Sticker/Meme editor's DEFAULT source.
 * Both are FREE with a developer API key — there is no per-image charge, so the
 * per-image cost line for this source is $0. The only AI cost in this source is
 * the vision fit-review (priced via ANTHROPIC_RATES like any other vision call).
 *   • Giphy Developers — free API (rate-limited). https://developers.giphy.com/
 *   • Tenor (Google) API — free with an API key.  https://developers.google.com/tenor
 */
export const STICKER_LIBRARY_PER_IMAGE: Record<string, number> = {
  giphy: 0,
  tenor: 0,
};

/** Groq whisper-large-v3-turbo: $0.04/hour = $0.04/60 per minute. */
export const GROQ_WHISPER_PER_MINUTE = 0.04 / 60;

/**
 * Cost of one chat/LLM call from its REAL usage counts.
 *
 * @param rate           per-MTok rate table for the model used
 * @param inputTokens    uncached input tokens billed at the input rate
 * @param outputTokens   output tokens billed at the output rate
 * @param cacheWriteTokens tokens billed at the cache-write rate (Anthropic)
 * @param cacheReadTokens  tokens billed at the cache-read rate (Anthropic)
 *
 * Returns the dollar cost. If a cache rate is absent, those token buckets fall
 * back to the standard input rate (never silently dropped).
 */
export function tokenCost(
  rate: TokenRate,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
): number {
  const per = (tokens: number, pricePerMTok: number) => (tokens / 1_000_000) * pricePerMTok;
  return (
    per(inputTokens, rate.input) +
    per(outputTokens, rate.output) +
    per(cacheWriteTokens, rate.cacheWrite ?? rate.input) +
    per(cacheReadTokens, rate.cacheRead ?? rate.input)
  );
}

/** Audio transcription cost from minutes of audio. */
export function transcriptionCost(minutes: number, perMinute: number): number {
  return Math.max(0, minutes) * perMinute;
}

/** Round a dollar figure to 6 decimals (sub-cent precision for tiny per-call costs). */
export function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
