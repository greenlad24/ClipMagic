/**
 * Sticker sourcing orchestration for the Meme/Sticker editor.
 *
 * Per emphasis moment the order is:
 *   1. FREE path — search Giphy + Tenor, then an AI fit-review picks the best
 *      candidate (or drops it). This is tried FIRST for every moment.
 *   2. PAID fallback — for moments the free path left WITHOUT a fitting sticker,
 *      generate one with OpenAI (gpt-image-1). This is HARD-CAPPED at
 *      MEME_OPENAI_MAX generations per video (default 2). When more moments need
 *      generation than the cap allows, the strongest/earliest moments win
 *      (deterministic prioritization) and the rest stay captions-only.
 *
 * The provider calls are INJECTED (search/review/generate/download), so this
 * whole orchestration — the source order, the per-video cap, the prioritization,
 * and the diagnostics — is unit-testable with mocks and no network.
 *
 * Every step is graceful: a moment that finds nothing usable simply yields no
 * sticker (captions-only for that beat) and records WHY in its diagnostic.
 */
import type { EmphasisMoment } from "./director.js";
import type { StickerCandidate } from "./stickerSearch.js";
import type { FitReviewResult } from "./stickerReview.js";
import type { MomentDiagnostic } from "./pipeline.js";
import type { EmphasisStickerClip } from "./sticker.js";

/** Hard cap on OpenAI generations per video (env-overridable, default 2). */
export function resolveOpenAiMax(): number {
  const raw = Number.parseInt(process.env.MEME_OPENAI_MAX || "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 2;
}

/** The provider hooks the orchestrator drives (real impls or test mocks). */
export interface StickerProviders {
  /** True if Giphy/Tenor are configured (the free path can run). */
  searchAvailable: boolean;
  /** True if an OpenAI image-gen key is present (the paid fallback can run). */
  openaiAvailable: boolean;
  /** Forced source: "openai" skips the free path entirely (legacy mode). */
  source: "giphy+tenor" | "openai";
  /** Search both libraries for a query → merged candidates. */
  search: (query: string) => Promise<StickerCandidate[]>;
  /** AI fit-review picks the best candidate (or drops). */
  review: (line: string, candidates: StickerCandidate[]) => Promise<FitReviewResult>;
  /** Download a chosen candidate's still → a servable URL (or null on failure). */
  download: (candidate: StickerCandidate) => Promise<{ url: string } | null>;
  /** Generate one OpenAI sticker for a prompt → a servable URL (or null). */
  generate: (prompt: string) => Promise<{ url: string } | null>;
}

export interface OrchestrationResult {
  /** The stickers to render (in moment order). */
  stickers: EmphasisStickerClip[];
  /** Per-moment trace (query, candidate counts, review verdict, final source). */
  diagnostics: MomentDiagnostic[];
  /** How many OpenAI generations were actually used this video. */
  openaiUsed: number;
  /** The per-video OpenAI cap that was in force. */
  openaiCap: number;
}

/**
 * Score a moment for OpenAI-generation priority when the cap forces a choice.
 * Stronger + earlier moments win. We use the original plan ORDER (the director
 * lists strongest first / sanitize keeps time order) and earliness as a tiebreak,
 * so the result is fully deterministic. Lower score = higher priority.
 */
function genPriority(m: EmphasisMoment, originalIndex: number): number {
  // Earliest start first (an early emphasis beat sets the tone), then plan order.
  return m.startTime * 1000 + originalIndex;
}

/**
 * Run the two-pass sticker sourcing for a video's emphasis moments.
 *
 * Pass 1 (free): try Giphy/Tenor + review for every moment. Pass 2 (paid):
 * generate for the still-unmatched moments, up to the per-video cap, prioritized.
 */
export async function orchestrateStickers(
  moments: EmphasisMoment[],
  providers: StickerProviders,
): Promise<OrchestrationResult> {
  const openaiCap = resolveOpenAiMax();
  const diags: MomentDiagnostic[] = moments.map((m) => ({
    phrase: m.phrase,
    searchQuery: m.searchQuery,
    candidates: { giphy: 0, tenor: 0 },
    review: { reviewed: false, chosen: false, reason: "" },
    appliedSource: "none",
    ok: false,
  }));
  // Resolved image URL per moment index (null until/unless one is applied).
  const applied: Array<string | null> = moments.map(() => null);

  // ── Pass 1: FREE path (Giphy/Tenor + fit-review) for every moment ──────────
  if (providers.searchAvailable && providers.source === "giphy+tenor") {
    for (let i = 0; i < moments.length; i++) {
      const m = moments[i];
      const diag = diags[i];
      const candidates = await providers.search(m.searchQuery);
      diag.candidates.giphy = candidates.filter((c) => c.provider === "giphy").length;
      diag.candidates.tenor = candidates.filter((c) => c.provider === "tenor").length;

      if (candidates.length === 0) {
        diag.review.reason = "no candidates found for query";
        continue;
      }
      const verdict = await providers.review(m.phrase || m.searchQuery, candidates);
      diag.review = { reviewed: verdict.reviewed, chosen: !!verdict.chosen, reason: verdict.reason };
      if (verdict.chosen) {
        const dl = await providers.download(verdict.chosen);
        if (dl) {
          applied[i] = dl.url;
          diag.appliedSource = "giphy+tenor";
        } else {
          diag.review.reason += " · download failed";
        }
      }
    }
  }

  // ── Pass 2: PAID fallback (OpenAI), capped + prioritized ───────────────────
  // Moments still without a sticker, ordered by generation priority. In the
  // legacy "openai" source the free path didn't run, so ALL moments are here.
  const needsGen = moments
    .map((m, i) => ({ m, i }))
    .filter(({ i }) => applied[i] === null)
    .sort((a, b) => genPriority(a.m, a.i) - genPriority(b.m, b.i));

  let openaiUsed = 0;
  if (providers.openaiAvailable && openaiCap > 0) {
    for (const { m, i } of needsGen) {
      if (openaiUsed >= openaiCap) {
        const capNote = `OpenAI gen cap (${openaiCap}/video) reached — captions-only`;
        diags[i].review.reason = diags[i].review.reason
          ? `${diags[i].review.reason} · ${capNote}`
          : capNote;
        continue;
      }
      const img = await providers.generate(m.imagePrompt);
      openaiUsed++; // count the attempt against the cap (an attempt costs/uses a slot)
      if (img) {
        applied[i] = img.url;
        diags[i].appliedSource = "openai";
        if (!diags[i].review.reason) diags[i].review.reason = "no library sticker — used OpenAI fallback";
      } else {
        diags[i].review.reason =
          (diags[i].review.reason ? diags[i].review.reason + " · " : "") + "OpenAI gen returned nothing";
      }
    }
  } else if (needsGen.length > 0) {
    // No paid fallback available — annotate the unmatched moments with WHY gen
    // didn't run (key missing or cap 0), appending to any free-path reason so the
    // diagnostic keeps both facts ("no candidates" AND "no OpenAI key").
    const why = providers.openaiAvailable
      ? `OpenAI gen disabled (cap ${openaiCap})`
      : "no library sticker and no OpenAI key — captions-only";
    for (const { i } of needsGen) {
      diags[i].review.reason = diags[i].review.reason
        ? `${diags[i].review.reason} · ${why}`
        : why;
    }
  }

  // ── Assemble the sticker clips in MOMENT order ─────────────────────────────
  const stickers: EmphasisStickerClip[] = [];
  for (let i = 0; i < moments.length; i++) {
    if (applied[i] === null) continue;
    diags[i].ok = true;
    stickers.push({
      startTime: moments[i].startTime,
      endTime: moments[i].endTime,
      imageUrl: applied[i]!,
      // Alternate the resting tilt so adjacent stickers don't all lean the same
      // way (the hand-placed feel). Index over APPLIED stickers, not all moments.
      restTiltDeg: stickers.length % 2 === 0 ? -4 : 4,
      phrase: moments[i].phrase,
    });
  }

  return { stickers, diagnostics: diags, openaiUsed, openaiCap };
}
