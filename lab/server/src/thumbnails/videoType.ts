/**
 * Video type → character expression mapping for the Thumbnail Designer, plus the
 * per-variant expression rule used when generating multiple options.
 *
 * Mapping (per spec):
 *   Tutorial/How-to → smile · Viral/Shock → surprise · Secret/Insider → secret
 *   · Review/Calm → calm.
 *
 * Per-variant policy: every variant uses the SAME best-fit expression for the
 * video type. We do NOT force a distinct look per variation — the art director is
 * free to reuse the same character photo across variants. Variety comes from the
 * different source thumbnails being recreated, not from rotating the character's
 * expression. Pure functions so the selection logic is unit-testable.
 */
import type { Expression } from "./characters.js";

export const VIDEO_TYPES = ["Tutorial", "Viral", "Secret", "Review"] as const;
export type VideoType = (typeof VIDEO_TYPES)[number];

const TYPE_TO_EXPRESSION: Record<VideoType, Expression> = {
  Tutorial: "smile",
  Viral: "surprise",
  Secret: "secret",
  Review: "calm",
};

export function isVideoType(x: unknown): x is VideoType {
  return typeof x === "string" && (VIDEO_TYPES as readonly string[]).includes(x);
}

/** The primary expression a video type maps to. */
export function expressionForVideoType(videoType: VideoType): Expression {
  return TYPE_TO_EXPRESSION[videoType];
}

/**
 * Choose the character expression for each of `count` variants of a video type,
 * restricted to the expressions actually AVAILABLE in the library. Every variant
 * gets the SAME best-fit expression — we no longer force a distinct look per
 * variation, so the art director may reuse the same character photo across
 * variants. If the type's primary expression isn't available we fall back to the
 * first available one. Returns [] when nothing is available.
 */
export function expressionsForVariants(
  videoType: VideoType,
  count: number,
  available: Expression[],
): Expression[] {
  // `available` may include BOTH built-in and custom expression ids — don't
  // restrict to the built-ins, or a library of only custom expressions would
  // wrongly come back empty.
  if (available.length === 0) return [];
  const primary = expressionForVideoType(videoType);
  // Best-fit for the whole batch: the type's primary when available, else the
  // first available expression. Repeats are intentional — variety comes from the
  // different source thumbnails, not from rotating the character's look.
  const chosen = available.includes(primary) ? primary : available[0];
  return Array.from({ length: Math.max(0, count) }, () => chosen);
}
