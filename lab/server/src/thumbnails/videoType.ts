/**
 * Video type → character expression mapping for the Thumbnail Designer, plus the
 * "distinct expression per variant" rule used when generating multiple options.
 *
 * Mapping (per spec):
 *   Tutorial/How-to → smile · Viral/Shock → surprise · Secret/Insider → secret
 *   · Review/Calm → calm.
 * Pure functions so the selection logic is unit-testable.
 */
import { EXPRESSIONS, type Expression } from "./characters.js";

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
 * Choose distinct expressions for `count` variants of a video type, restricted
 * to the expressions actually AVAILABLE in the library. The type's primary
 * expression leads; the rest cycle through the remaining available ones so each
 * variant differs (for variety). When fewer expressions are available than
 * variants, it reuses from the front rather than failing.
 */
export function expressionsForVariants(
  videoType: VideoType,
  count: number,
  available: Expression[],
): Expression[] {
  const avail = EXPRESSIONS.filter((e) => available.includes(e));
  if (avail.length === 0) return [];
  const primary = expressionForVideoType(videoType);
  // Order: primary first (if available), then the rest in canonical order.
  const ordered: Expression[] = [];
  if (avail.includes(primary)) ordered.push(primary);
  for (const e of avail) if (!ordered.includes(e)) ordered.push(e);
  // Assign one per variant, cycling if there are more variants than expressions.
  const out: Expression[] = [];
  for (let i = 0; i < count; i++) out.push(ordered[i % ordered.length]);
  return out;
}
