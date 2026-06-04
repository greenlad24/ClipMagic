/**
 * AI fit-review (quality gate) for the Meme/Sticker editor.
 *
 * The search layer returns several reaction-sticker candidates per moment from
 * Giphy + Tenor. A keyword search alone often surfaces off-topic or low-quality
 * stickers, so before we animate one we let a VISION model actually LOOK at the
 * candidates and decide which one (if any) genuinely fits the line being said —
 * the same "reviewEdit" idea the short-form pipeline uses to revert wrong
 * overlays, applied here to pick/drop a sticker.
 *
 * It reuses the shared vision path (claudeVisionLabeledJSON → Claude vision with
 * a Groq-vision fallback), so it works on whatever vision provider is configured
 * and is attributed to the "sticker-review" purpose for honest cost reporting.
 *
 * Graceful: if no vision provider is configured, or the review call fails, we DO
 * NOT block the pipeline — we fall back to the first candidate (search already
 * ordered by relevance) and record that the review was skipped, so a missing
 * vision key never means "no stickers".
 */
import { claudeVisionLabeledJSON, type LabeledImage } from "../ai/claude.js";
import { anthropicConfigured } from "../ai/claude.js";
import { groqVisionConfigured } from "../ai/groqVision.js";
import type { StickerCandidate } from "./stickerSearch.js";

export function stickerReviewConfigured(): boolean {
  return anthropicConfigured() || groqVisionConfigured();
}

const SYSTEM = `You are the QUALITY-CONTROL reviewer for a short-form meme editor. A funny REACTION STICKER will slap on screen at one moment to emphasize a line. You are shown the line being said plus a few candidate stickers fetched from Giphy/Tenor. Decide which ONE candidate actually FITS that line — it MUST clearly RELATE TO WHAT THE LINE IS ABOUT (its subject, or the specific reaction the point genuinely warrants) and read clearly as a sticker. A candidate that is merely funny, or a generic reaction with no real connection to this line, does NOT fit. If none clearly relate (off-topic, only loosely related, confusing, blank, or bad), return null to drop it — a missing sticker is far better than an irrelevant one.

SAFETY (absolute, overrides everything else): DROP any candidate that is offensive, NSFW/sexual, nude, hateful (slurs/hate symbols), graphically violent or gory, drug-related, or otherwise shocking or disturbing — REGARDLESS of how well it fits the line. An offensive sticker is NEVER acceptable; a missing sticker is always better. If the only fitting candidate is unsafe, return null.

Return ONLY JSON: { "chosen": <0-based index of the best candidate, or null to drop>, "reason": "<short why>" }.`;

export interface FitReviewResult {
  /** The candidate the reviewer picked, or null to DROP this moment's sticker. */
  chosen: StickerCandidate | null;
  /** 0-based index into the candidates array, or null. */
  chosenIndex: number | null;
  /** Short human reason (chosen fit, or why all were dropped / why fallback). */
  reason: string;
  /** True when the vision gate actually ran (vs. a graceful fallback pick). */
  reviewed: boolean;
}

const ALLOWED_TYPES: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function mediaTypeFor(url: string): string {
  const clean = url.split("?")[0].toLowerCase();
  const dot = clean.lastIndexOf(".");
  const ext = dot >= 0 ? clean.slice(dot + 1) : "";
  return ALLOWED_TYPES[ext] || "image/png";
}

/** Fetch a candidate and base64-encode it as a labeled, typed vision image. */
async function toLabeledImage(c: StickerCandidate, i: number): Promise<LabeledImage | null> {
  try {
    const res = await fetch(c.url);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) return null;
    return {
      label: `Candidate ${i} (${c.provider}${c.title ? `, "${c.title}"` : ""}):`,
      data: bytes.toString("base64"),
      mediaType: mediaTypeFor(c.url),
    };
  } catch {
    return null;
  }
}

/**
 * Apply a vision reviewer's raw JSON decision to the candidate list. Pure +
 * deterministic (no network) so the pick/drop/invalid logic is unit-testable.
 *
 * @param raw       the reviewer's JSON string ({ chosen, reason })
 * @param candidates the candidates that were SHOWN, in the order shown (the
 *                   reviewer's index refers to this array)
 */
export function applyReviewDecision(raw: string, candidates: StickerCandidate[]): FitReviewResult {
  let parsed: { chosen?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { chosen: candidates[0] ?? null, chosenIndex: candidates.length ? 0 : null, reason: "unparseable review — used top result", reviewed: false };
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 160) : "";

  if (parsed.chosen === null || parsed.chosen === undefined) {
    return { chosen: null, chosenIndex: null, reason: reason || "no candidate fit — dropped", reviewed: true };
  }
  const idx = Number(parsed.chosen);
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
    return { chosen: null, chosenIndex: null, reason: `review returned invalid index ${parsed.chosen} — dropped`, reviewed: true };
  }
  return { chosen: candidates[idx], chosenIndex: idx, reason: reason || `picked candidate ${idx}`, reviewed: true };
}

/**
 * Review the candidate stickers for one moment and pick the best fit (or drop).
 *
 * @param line       the transcript phrase/context this sticker emphasizes
 * @param candidates merged Giphy+Tenor candidates (already ordered by relevance)
 */
export async function reviewStickerFit(
  line: string,
  candidates: StickerCandidate[],
): Promise<FitReviewResult> {
  if (candidates.length === 0) {
    return { chosen: null, chosenIndex: null, reason: "no candidates to review", reviewed: false };
  }

  // No vision provider → don't block: take the top-ranked candidate from search.
  if (!stickerReviewConfigured()) {
    return {
      chosen: candidates[0],
      chosenIndex: 0,
      reason: "no vision provider — used top search result (review skipped)",
      reviewed: false,
    };
  }

  // Fetch the candidate images for the vision call. Drop any that fail to load.
  // `shown` is the subset actually presented (in order); the reviewer's index
  // refers to it, and applyReviewDecision maps that index back to a candidate.
  const labeled: LabeledImage[] = [];
  const shown: StickerCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const img = await toLabeledImage(candidates[i], i);
    if (img) {
      // Re-label with the SHOWN position so the model's index maps back cleanly.
      img.label = `Candidate ${shown.length} (${candidates[i].provider}${
        candidates[i].title ? `, "${candidates[i].title}"` : ""
      }):`;
      labeled.push(img);
      shown.push(candidates[i]);
    }
  }
  if (shown.length === 0) {
    return {
      chosen: candidates[0],
      chosenIndex: 0,
      reason: "candidate images failed to load — used top search result",
      reviewed: false,
    };
  }

  const userText =
    `The line being said: "${line || "(emphasis beat)"}".\n` +
    `There ${shown.length === 1 ? "is 1 candidate" : `are ${shown.length} candidates`} (indices 0..${shown.length - 1}). ` +
    `Pick the index that best fits, or null to drop.`;

  try {
    const raw = await claudeVisionLabeledJSON({
      system: SYSTEM,
      userText,
      images: labeled,
      purpose: "sticker-review",
    });
    // chosenIndex here is relative to `shown`; remap to the original list.
    const verdict = applyReviewDecision(raw, shown);
    if (verdict.chosen) {
      const originalIdx = candidates.indexOf(verdict.chosen);
      return { ...verdict, chosenIndex: originalIdx >= 0 ? originalIdx : verdict.chosenIndex };
    }
    return verdict;
  } catch (e) {
    // Review failed → don't block the whole feature; take the top search result.
    return {
      chosen: candidates[0],
      chosenIndex: 0,
      reason: `review failed (${e instanceof Error ? e.message.slice(0, 60) : "error"}) — used top search result`,
      reviewed: false,
    };
  }
}
