/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  PER-RUN AI / COMPUTE ACCOUNTING  →  the "Optimization Report"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Goal: for ONE pipeline run, record what ACTUALLY happened — every AI call
 *  (provider, model, purpose, REAL input/output tokens from the API `usage`
 *  field), transcription minutes, ffmpeg spawns, and wall-clock — then compute,
 *  from that real data, what the unoptimized MAIN-APP path would have cost on
 *  the same input. The dollar delta is itemized and never inflated with
 *  non-cost (speed/compute) wins.
 *
 *  Accuracy rules baked in here:
 *   • Costs come from real `usage` × the rates in pricing.ts. No estimates for
 *     calls that actually ran.
 *   • The only estimated quantity is the token size of a call the main app WOULD
 *     have made but the lab eliminated (the folded emphasis call). It is clearly
 *     labelled an assumption and uses a documented tokenizer approximation.
 *   • A saving is only counted when its optimization ACTUALLY fired this run.
 *   • Speed/compute wins (ffmpeg memoization etc.) are reported separately from
 *     dollars.
 *
 *  Plumbing: runPipeline calls beginRun(projectId) and (later) finishRun. The
 *  Claude/Groq shims call recordAnthropicUsage / recordGroqTranscription against
 *  the active run. Because the whole pipeline is bundled into one module graph
 *  and runs are sequential (single video, and bulk processes one at a time),
 *  a single "active run" pointer keyed by projectId attributes calls correctly.
 */
import {
  ANTHROPIC_RATES,
  OPENAI_RATES,
  OPENAI_WHISPER_PER_MINUTE,
  GROQ_WHISPER_PER_MINUTE,
  OPENAI_IMAGE_PER_IMAGE,
  PRICING_SOURCE_DATE,
  tokenCost,
  transcriptionCost,
  roundUsd,
  type TokenRate,
} from "./pricing.js";

// ── Purposes (one per distinct LLM/transcription call the pipeline makes) ─────
export type CallPurpose =
  | "transcription"
  | "url-research"
  | "director"
  | "emphasis-fallback"
  | "review"
  // Narration Cutter: duplicate-take grouping (cheap structured extraction).
  | "take-detection"
  // Sticker/Meme editor: picks the emphasis moments + writes the image prompts.
  | "emphasis-director"
  // Sticker/Meme editor: vision fit-review of fetched sticker candidates.
  | "sticker-review"
  // Sticker/Meme editor: one generated still image per emphasis moment.
  | "image-generation"
  // Bulk Scheduler: per-platform SEO caption + hashtag generation.
  | "caption"
  // Auto-Screencast: picks script moments + the real URLs worth showing.
  | "screencast";

export interface AiCallRecord {
  provider: "anthropic" | "groq" | "openai";
  model: string;
  purpose: CallPurpose;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** For transcription calls: minutes of audio (tokens are 0). */
  audioMinutes?: number;
  /** For image-generation calls: how many images were generated (tokens are 0). */
  images?: number;
  costUsd: number;
  ms: number;
}

interface RunState {
  projectId: string;
  startedAt: number;
  calls: AiCallRecord[];
  /** Flags describing which optimizations fired (set by the pipeline). */
  flags: {
    directorReturnedEmphasis?: boolean;
    emphasisFallbackUsed?: boolean;
    transcriptWordList?: string; // exact main-app emphasis prompt body
    transcriptWordCount?: number;
    audioMinutes?: number;
  };
}

// projectId → run; plus a pointer to the currently-active run for shim attribution.
const runs = new Map<string, RunState>();
let activeRun: RunState | null = null;

export function beginRun(projectId: string): void {
  const state: RunState = {
    projectId,
    startedAt: Date.now(),
    calls: [],
    flags: {},
  };
  runs.set(projectId, state);
  activeRun = state;
}

/** Re-point the active run (e.g. resuming a known projectId). Safe no-op if unknown. */
export function setActiveRun(projectId: string): void {
  const s = runs.get(projectId);
  if (s) activeRun = s;
}

export function getRun(projectId: string): RunState | undefined {
  return runs.get(projectId);
}

export function setRunFlags(projectId: string, flags: Partial<RunState["flags"]>): void {
  const s = runs.get(projectId);
  if (s) Object.assign(s.flags, flags);
}

/**
 * Record a real Anthropic Messages-API response's usage. Called by claude.ts
 * with the parsed `usage` object so every token figure is the provider's own.
 */
export function recordAnthropicUsage(args: {
  model: string;
  purpose: CallPurpose;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | undefined;
  ms: number;
}): void {
  if (!activeRun) return;
  const u = args.usage ?? {};
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const rate = ANTHROPIC_RATES[args.model];
  const cost = rate ? tokenCost(rate, input, output, cacheWrite, cacheRead) : 0;
  activeRun.calls.push({
    provider: "anthropic",
    model: args.model,
    purpose: args.purpose,
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    costUsd: roundUsd(cost),
    ms: args.ms,
  });
}

/** Record a real Groq Whisper transcription (priced per minute of audio). */
export function recordGroqTranscription(args: {
  model: string;
  audioSeconds: number;
  ms: number;
}): void {
  if (!activeRun) return;
  const minutes = Math.max(0, args.audioSeconds) / 60;
  const cost = transcriptionCost(minutes, GROQ_WHISPER_PER_MINUTE);
  activeRun.flags.audioMinutes = minutes;
  activeRun.calls.push({
    provider: "groq",
    model: args.model,
    purpose: "transcription",
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    audioMinutes: minutes,
    costUsd: roundUsd(cost),
    ms: args.ms,
  });
}

/**
 * Record generated still images for the Sticker/Meme editor. Each image is a
 * flat per-image OpenAI charge (no tokens). We aggregate one record per run with
 * the image count and total cost so the optimization report shows a single,
 * honest "N images × $rate" line. `model` is the image model actually used.
 */
export function recordImageGeneration(args: {
  model: string;
  images: number;
  ms: number;
}): void {
  if (!activeRun) return;
  if (args.images <= 0) return;
  const per = OPENAI_IMAGE_PER_IMAGE[args.model] ?? 0;
  const cost = per * args.images;
  // Fold into one running line per model so the report reads "N images".
  const existing = activeRun.calls.find(
    (c) => c.purpose === "image-generation" && c.model === args.model,
  );
  if (existing) {
    existing.images = (existing.images ?? 0) + args.images;
    existing.costUsd = roundUsd((existing.costUsd ?? 0) + cost);
    existing.ms += args.ms;
    return;
  }
  activeRun.calls.push({
    provider: "openai",
    model: args.model,
    purpose: "image-generation",
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    images: args.images,
    costUsd: roundUsd(cost),
    ms: args.ms,
  });
}

// ── Tokenizer approximation (ONLY for a call the lab eliminated) ──────────────
/**
 * Approximate OpenAI token count for a text string. Used solely to price the
 * standalone emphasis call the MAIN APP would make but the lab folded away —
 * there is no real `usage` for a call that never ran, so this is the one
 * explicitly-assumed quantity in the report (and it's labelled as such).
 *
 * ~4 characters per token is OpenAI's own published rule of thumb for English.
 * The emphasis prompt is a list of "index:word" tokens, which sits close to
 * this ratio, so the estimate is conservative and clearly documented.
 */
export function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ── Report shape ──────────────────────────────────────────────────────────────
export interface CostLineItem {
  label: string;
  /** What this run actually cost for this line (lab path). */
  labUsd: number;
  /** What the main app would have cost for the same work on the same input. */
  baselineUsd: number;
  /** baselineUsd − labUsd (>0 = saved, <0 = lab spent more). */
  savedUsd: number;
  /** Human note: model swap, folded call, etc. */
  note: string;
  /** True when any figure on this line is an estimate (not from real usage). */
  assumption?: boolean;
  /**
   * "saving"             — a genuine cost reduction (cheaper provider / eliminated call).
   * "quality-investment" — the lab deliberately spends MORE for higher quality
   *                        (e.g. Opus director vs gpt-4o). Shown transparently
   *                        and EXCLUDED from the like-for-like savings headline so
   *                        the saving figure is never inflated — but still counted
   *                        in the net delta.
   */
  kind: "saving" | "quality-investment";
}

export interface SpeedLineItem {
  label: string;
  detail: string;
}

export interface OptimizationReport {
  version: number;
  projectId: string;
  generatedAt: string;
  pricingSourceDate: string;
  wallClockMs: number;

  /** Section 1 — what actually got optimized this run. */
  whatWasOptimized: string[];
  /** Section 2 — quality improvements in effect this run. */
  qualityImprovements: string[];

  /** Section 3 — itemized $ comparison. */
  cost: {
    lineItems: CostLineItem[];
    labTotalUsd: number;
    baselineTotalUsd: number;
    /**
     * Like-for-like savings: the sum of "saving" line items only (cheaper
     * provider + eliminated calls). The headline figure — NOT inflated with the
     * Opus quality upgrade.
     */
    savedUsd: number;
    savedPercent: number;
    /**
     * Net cost delta vs the main app across EVERY line, including the Opus
     * director quality investment. baselineTotal − labTotal. Honest bottom line:
     * positive = net cheaper, negative = the lab spent more (because it bought
     * Opus-grade directing).
     */
    netDeltaUsd: number;
    /** Sum of "quality-investment" extra spend (lab − baseline on those lines). */
    qualityInvestmentUsd: number;
    assumptions: string[];
  };

  /** Speed / compute wins (NOT dollars). */
  speed: SpeedLineItem[];

  /** Raw measured calls, for auditing / queryability. */
  calls: AiCallRecord[];
  ffmpegSpawns: number;
}

// Helper: which Anthropic model the lab used for a given purpose this run.
function labModelFor(run: RunState, purpose: CallPurpose): string | undefined {
  return run.calls.find((c) => c.purpose === purpose)?.model;
}

/**
 * Build the three-section report from a completed run's real data + the main-app
 * baseline derived per optimization. `usedFallbackDirector` etc. come from the
 * pipeline via setRunFlags.
 */
export function buildReport(projectId: string): OptimizationReport | null {
  const run = runs.get(projectId);
  if (!run) return null;

  const wallClockMs = Date.now() - run.startedAt;
  const lineItems: CostLineItem[] = [];
  const assumptions: string[] = [];
  const whatWasOptimized: string[] = [];
  const qualityImprovements: string[] = [];
  const speed: SpeedLineItem[] = [];

  // ── Line item: transcription (provider swap Whisper-1 → Groq turbo) ─────────
  const tr = run.calls.find((c) => c.purpose === "transcription");
  if (tr && typeof tr.audioMinutes === "number") {
    const baseline = transcriptionCost(tr.audioMinutes, OPENAI_WHISPER_PER_MINUTE);
    lineItems.push({
      label: `Transcription · ${tr.audioMinutes.toFixed(2)} min audio`,
      labUsd: roundUsd(tr.costUsd),
      baselineUsd: roundUsd(baseline),
      savedUsd: roundUsd(baseline - tr.costUsd),
      note: `Groq ${tr.model} ($${(GROQ_WHISPER_PER_MINUTE * 60).toFixed(2)}/hr) vs OpenAI whisper-1 ($0.36/hr) — same audio`,
      kind: "saving",
    });
    whatWasOptimized.push(
      `Transcription ran on Groq ${tr.model} instead of OpenAI whisper-1 (~9× cheaper per minute of audio).`,
    );
  }

  // ── Line item: take-detection (Narration Cutter) ────────────────────────────
  // The cutter's duplicate-take grouping runs on the fast (Haiku) tier. The
  // main-app equivalent would be a gpt-4o call (it has no dedicated cheap tier
  // for this), so the baseline prices the SAME real tokens at gpt-4o.
  const take = run.calls.find((c) => c.purpose === "take-detection");
  if (take) {
    const baseline = tokenCost(OPENAI_RATES["gpt-4o"], take.inputTokens, take.outputTokens);
    const saved = baseline - take.costUsd;
    lineItems.push({
      label: "Duplicate-take detection (Narration Cutter)",
      labUsd: roundUsd(take.costUsd),
      baselineUsd: roundUsd(baseline),
      savedUsd: roundUsd(saved),
      note: `Claude ${take.model} (Haiku, fast tier) vs gpt-4o — same ${take.inputTokens} in / ${take.outputTokens} out tokens. Cheap structured extraction; skipped entirely when no phrase recurs in the transcript.`,
      kind: saved >= 0 ? "saving" : "quality-investment",
    });
    whatWasOptimized.push(
      `Duplicate-take grouping ran on Claude ${take.model} (fast tier) instead of a gpt-4o-class call, and is skipped outright when a cheap pre-filter finds no repeated phrase.`,
    );
  }

  // ── Line item: emphasis director (Sticker/Meme editor) ──────────────────────
  // This editor is a NEW tool with no main-app equivalent, so there is no
  // apples-to-apples "savings vs main app" to claim. We surface its ACTUAL cost
  // honestly: baseline = lab (no saving), counted toward the net spend.
  const emphasis = run.calls.find((c) => c.purpose === "emphasis-director");
  if (emphasis) {
    lineItems.push({
      label: "Emphasis director (Sticker editor)",
      labUsd: roundUsd(emphasis.costUsd),
      baselineUsd: roundUsd(emphasis.costUsd),
      savedUsd: 0,
      note: `Claude ${emphasis.model} picks the on-beat emphasis moments and writes each image prompt — ${emphasis.inputTokens} in / ${emphasis.outputTokens} out tokens. New capability with no main-app equivalent, so this is the editor's real added cost, not a saving.`,
      kind: "quality-investment",
    });
    qualityImprovements.push(
      "A content-driven director picks emphasis moments (~every 4s, sparing on hook/CTA) and writes a meme-style image prompt for each — captions stay clean while a funny sticker lands the point.",
    );
  }

  // ── Line item: sticker fit-review (vision quality gate) ─────────────────────
  // The Sticker editor's default source is FREE Giphy/Tenor reaction stickers
  // ($0/image), but the AI fit-review that picks/drops candidates IS a real
  // vision call — surfaced here honestly with its real per-call cost.
  const stickerReview = run.calls.find((c) => c.purpose === "sticker-review");
  if (stickerReview) {
    lineItems.push({
      label: "Sticker fit-review (vision quality gate)",
      labUsd: roundUsd(stickerReview.costUsd),
      baselineUsd: roundUsd(stickerReview.costUsd),
      savedUsd: 0,
      note:
        `Claude ${stickerReview.model} vision reviews the fetched Giphy/Tenor candidates per moment and picks the best fit (or drops it) — ` +
        `${stickerReview.inputTokens} in / ${stickerReview.outputTokens} out tokens, priced ${PRICING_SOURCE_DATE}. ` +
        `The reaction stickers themselves are FREE ($0/image); this review is the editor's only per-sticker AI cost. New capability, shown as real added cost, not a saving.`,
      kind: "quality-investment",
    });
    qualityImprovements.push(
      "Each fetched reaction sticker passes an AI VISION fit-review before it's used — off-topic or low-quality stickers are dropped, so a wrong sticker never ships.",
    );
    whatWasOptimized.push(
      "Sticker source switched to FREE Giphy + Tenor reaction stickers ($0/image) — only the per-moment vision fit-review carries any cost.",
    );
  }

  // ── Line item: image generation (Sticker/Meme editor) ───────────────────────
  const img = run.calls.find((c) => c.purpose === "image-generation");
  if (img && (img.images ?? 0) > 0) {
    const perImage = OPENAI_IMAGE_PER_IMAGE[img.model] ?? 0;
    lineItems.push({
      label: `Sticker image generation · ${img.images} image${img.images !== 1 ? "s" : ""}`,
      labUsd: roundUsd(img.costUsd),
      baselineUsd: roundUsd(img.costUsd),
      savedUsd: 0,
      note: `${img.images} × OpenAI ${img.model} still${img.images !== 1 ? "s" : ""} at $${perImage.toFixed(2)}/image (transparent PNG, 1024², priced ${PRICING_SOURCE_DATE}). FALLBACK source only — used when Giphy/Tenor returned nothing (or have no keys) and an OpenAI key is present. Added cost shown transparently.`,
      kind: "quality-investment",
    });
    whatWasOptimized.push(
      `Sticker editor used the OpenAI image-gen FALLBACK for ${img.images} moment${img.images !== 1 ? "s" : ""} (no free library sticker fit) — cached by prompt, rendered as bouncy stickers below the captions.`,
    );
  }

  // ── Line item: URL research (gpt-4o → Sonnet) ───────────────────────────────
  const research = run.calls.find((c) => c.purpose === "url-research");
  if (research) {
    const openaiRate = OPENAI_RATES["gpt-4o"];
    const baseline = tokenCost(openaiRate, research.inputTokens, research.outputTokens);
    const saved = baseline - research.costUsd;
    // Sonnet ($3/$15) is pricier than gpt-4o ($2.50/$10), so this is usually a
    // small quality upgrade, not a saving — let the sign decide (never inflate).
    const kind: CostLineItem["kind"] = saved >= 0 ? "saving" : "quality-investment";
    lineItems.push({
      label: "URL research call",
      labUsd: roundUsd(research.costUsd),
      baselineUsd: roundUsd(baseline),
      savedUsd: roundUsd(saved),
      note:
        `${research.model} (Sonnet) vs gpt-4o — same ${research.inputTokens} in / ${research.outputTokens} out tokens.` +
        (kind === "quality-investment"
          ? " Sonnet is slightly pricier than gpt-4o — counted as a quality upgrade, not a saving."
          : ""),
      kind,
    });
    whatWasOptimized.push(
      `URL/entity research used Claude ${research.model} (research tier) in place of gpt-4o.`,
    );
  }

  // ── Line item: director / beat planner (gpt-4o → Opus) ──────────────────────
  const director = run.calls.find((c) => c.purpose === "director");
  if (director) {
    const openaiRate = OPENAI_RATES["gpt-4o"];
    const baseline = tokenCost(openaiRate, director.inputTokens, director.outputTokens);
    const saved = baseline - director.costUsd;
    // Opus is the deliberate quality upgrade over the main app's gpt-4o. When it
    // costs MORE, that extra spend is a quality investment — shown honestly, but
    // NOT subtracted from the like-for-like savings headline.
    const isInvestment = saved < 0;
    lineItems.push({
      label: "AI director (semantic beat planner)",
      labUsd: roundUsd(director.costUsd),
      baselineUsd: roundUsd(baseline),
      savedUsd: roundUsd(saved),
      note:
        `${director.model} (Opus) vs gpt-4o — same ${director.inputTokens} in / ${director.outputTokens} out tokens. ${
          director.cacheWriteTokens + director.cacheReadTokens > 0
            ? `Prompt caching active (${director.cacheReadTokens} cached-read tokens).`
            : "Prompt caching enabled (no cache hit this run)."
        }` +
        (isInvestment
          ? " Lab spends MORE here on purpose — Opus-grade directing for better shot/beat quality. Counted as a quality investment, not a saving."
          : " Cheaper than the gpt-4o baseline this run."),
      kind: isInvestment ? "quality-investment" : "saving",
    });
    qualityImprovements.push(
      "AI director runs on Claude Opus (vs the main app's gpt-4o) — stronger rhetorical reasoning for shot planning, beat realism, and which words to emphasize.",
    );
  }

  // ── Line item: AI self-review (gpt-4o → Sonnet) ─────────────────────────────
  const review = run.calls.find((c) => c.purpose === "review");
  if (review) {
    const openaiRate = OPENAI_RATES["gpt-4o"];
    const baseline = tokenCost(openaiRate, review.inputTokens, review.outputTokens);
    const saved = baseline - review.costUsd;
    const kind: CostLineItem["kind"] = saved >= 0 ? "saving" : "quality-investment";
    lineItems.push({
      label: "AI accuracy self-review",
      labUsd: roundUsd(review.costUsd),
      baselineUsd: roundUsd(baseline),
      savedUsd: roundUsd(saved),
      note:
        `${review.model} (Sonnet) vs gpt-4o — same ${review.inputTokens} in / ${review.outputTokens} out tokens.` +
        (kind === "quality-investment"
          ? " Sonnet is slightly pricier than gpt-4o — counted as a quality upgrade, not a saving."
          : ""),
      kind,
    });
    qualityImprovements.push(
      "A final AI quality-control pass reverts overlays that contradict the narration — reducing wrong-footage mistakes the main app would ship.",
    );
  }

  // ── Line item: emphasis fold (eliminated call) — ONLY if the fold fired ──────
  // The main app ALWAYS makes a standalone gpt-4o-mini emphasis call. The lab
  // folds it into the director call. We only claim the saving when the director
  // actually returned emphasis AND the fallback did NOT run this run.
  const foldFired = run.flags.directorReturnedEmphasis === true && run.flags.emphasisFallbackUsed !== true;
  if (foldFired && run.flags.transcriptWordList) {
    const promptBody = run.flags.transcriptWordList;
    // Reconstruct the exact main-app emphasis prompt = system + user(word list).
    const MAIN_APP_EMPHASIS_SYSTEM =
      "Identify emotionally stressed, key, or impactful words for kinetic subtitle emphasis styling.\n" +
      'Return ONLY valid JSON: {"emphasis":[2,5,9,14]} — 0-based word indices.\n' +
      "Mark: product names, power verbs, key nouns, charged words, numbers, superlatives.\n" +
      "Do NOT mark: articles (a, the), prepositions, conjunctions, filler words.\n" +
      "Aim for ~15–25% of total words.";
    const inTok = approxTokens(MAIN_APP_EMPHASIS_SYSTEM) + approxTokens("WORDS (index:word):\n" + promptBody);
    // Output: a JSON array of ~20% of word indices, each ~3 chars + comma.
    const wordCount = run.flags.transcriptWordCount ?? 0;
    const outTok = approxTokens(JSON.stringify({ emphasis: Array(Math.round(wordCount * 0.2)).fill(0) }));
    const miniRate = OPENAI_RATES["gpt-4o-mini"];
    const baseline = tokenCost(miniRate, inTok, outTok);
    lineItems.push({
      label: "Folded-away subtitle-emphasis call (eliminated)",
      labUsd: 0,
      baselineUsd: roundUsd(baseline),
      savedUsd: roundUsd(baseline),
      note: `Main app makes a separate gpt-4o-mini emphasis call (~${inTok} in / ~${outTok} out tokens for THIS run's ${wordCount} words). The lab gets emphasis from the director call instead — 1 fewer round-trip.`,
      assumption: true,
      kind: "saving",
    });
    assumptions.push(
      `Folded emphasis call: the eliminated gpt-4o-mini call's tokens are estimated from THIS run's exact word list using ~4 chars/token (OpenAI's published rule of thumb), since the call never executed. Input ≈ ${inTok} tokens, output ≈ ${outTok} tokens, priced at gpt-4o-mini ($0.15/$0.60 per MTok).`,
    );
    whatWasOptimized.push(
      `Subtitle-emphasis selection was folded into the director call — the standalone gpt-4o-mini round-trip the main app makes was eliminated this run (director returned emphasis directly).`,
    );
    qualityImprovements.push(
      "Emphasis words are chosen by the director with full-script context (vs a generic 15–25% heuristic on an isolated word list), so the right words pop.",
    );
  } else if (run.flags.emphasisFallbackUsed === true) {
    // The fold did NOT fire — be honest: no emphasis-fold saving this run.
    whatWasOptimized.push(
      "Subtitle-emphasis fold did NOT apply this run (the director returned no usable emphasis, so the fallback emphasis call ran). No emphasis-fold cost saving is claimed.",
    );
  }

  // ── Always-on quality notes (in effect for every run via the render path) ────
  qualityImprovements.push(
    "Hormozi-style kinetic captions: short 2–3 word chunks with long-word guards so captions never overflow the 9:16 frame.",
  );
  qualityImprovements.push(
    "Cuts are beat-snapped to the music grid and overlays are pacing-guarded (2–4s holds, hook pattern-interrupt, narrator-return) for a viral-preset feel.",
  );

  // ── Speed / compute wins (NOT dollars) ───────────────────────────────────────
  // At AI-pipeline finalize the render hasn't happened yet, so the real
  // caption-memo hit/miss counts and ffmpeg spawn count are filled in by the
  // render worker via mergeRenderStats(). We seed an honest placeholder here.
  speed.push({
    label: "Caption-measurement memoization",
    detail:
      "Render-time caption sizing reuses identical (text, font, size) measurements instead of re-spawning ffmpeg for each — a compute/speed saving with $0 API impact. Exact hit/miss counts populate after the final render.",
  });
  speed.push({
    label: "ffmpeg invocations",
    detail: "Counted at render time (1 main render + 2 per caption measurement). Populates after the final render.",
  });
  whatWasOptimized.push(
    "Render reuses the local FFmpeg engine on one server (no Rendi/cloud render service) and memoizes caption measurements — a compute/speed win, separate from the API-cost savings above.",
  );

  // ── Totals ────────────────────────────────────────────────────────────────────
  // Methodology note so the headline number can't be misread.
  assumptions.push(
    'Baseline = the EXACT main-app code path (repo-root src/) for this run\'s real input: OpenAI whisper-1 + gpt-4o + a separate gpt-4o-mini emphasis call, priced at real OpenAI rates on the SAME token/audio amounts this run used. "Like-for-like saved" sums only genuine cost reductions (cheaper provider / eliminated call). The Opus director is a deliberate quality upgrade over gpt-4o; when it costs more it is shown as a "quality investment" and excluded from the saved headline, but included in "net delta".',
  );

  const labTotal = lineItems.reduce((s, li) => s + li.labUsd, 0);
  const baselineTotal = lineItems.reduce((s, li) => s + li.baselineUsd, 0);
  // Net delta across EVERY line (includes the Opus quality investment).
  const netDelta = baselineTotal - labTotal;
  // Like-for-like SAVINGS = only the genuine cost reductions. The headline that
  // is never inflated with the deliberate quality upgrade.
  const savingItems = lineItems.filter((li) => li.kind === "saving");
  const saved = savingItems.reduce((s, li) => s + li.savedUsd, 0);
  const savingsBaseline = savingItems.reduce((s, li) => s + li.baselineUsd, 0);
  const savedPercent = savingsBaseline > 0 ? (saved / savingsBaseline) * 100 : 0;
  // Extra spend on quality investments (lab − baseline on those lines).
  const qualityInvestment = lineItems
    .filter((li) => li.kind === "quality-investment")
    .reduce((s, li) => s + (li.labUsd - li.baselineUsd), 0);

  return {
    version: 1,
    projectId,
    generatedAt: new Date().toISOString(),
    pricingSourceDate: PRICING_SOURCE_DATE,
    wallClockMs,
    whatWasOptimized,
    qualityImprovements,
    cost: {
      lineItems: lineItems.map((li) => ({
        ...li,
        labUsd: roundUsd(li.labUsd),
        baselineUsd: roundUsd(li.baselineUsd),
        savedUsd: roundUsd(li.savedUsd),
      })),
      labTotalUsd: roundUsd(labTotal),
      baselineTotalUsd: roundUsd(baselineTotal),
      savedUsd: roundUsd(saved),
      savedPercent: Math.round(savedPercent * 10) / 10,
      netDeltaUsd: roundUsd(netDelta),
      qualityInvestmentUsd: roundUsd(qualityInvestment),
      assumptions,
    },
    speed,
    calls: run.calls,
    ffmpegSpawns: 0, // populated by the render worker via mergeRenderStats()
  };
}

/** One concise server log line summarizing the report. */
export function reportLogLine(r: OptimizationReport): string {
  return (
    `[OptimizationReport] project=${r.projectId} ` +
    `lab=$${r.cost.labTotalUsd.toFixed(5)} baseline=$${r.cost.baselineTotalUsd.toFixed(5)} ` +
    `like-for-like-saved=$${r.cost.savedUsd.toFixed(5)} (${r.cost.savedPercent.toFixed(1)}%) ` +
    `net-delta=$${r.cost.netDeltaUsd.toFixed(5)} quality-investment=$${r.cost.qualityInvestmentUsd.toFixed(5)} ` +
    `calls=${r.calls.length} wall=${(r.wallClockMs / 1000).toFixed(1)}s`
  );
}

/**
 * Merge real RENDER-TIME speed/compute stats into a persisted report. The final
 * render runs after the AI pipeline (and the run is already closed), so the
 * render worker calls this with the measured caption-memo hits/misses and ffmpeg
 * spawn count to complete the report's speed section — with real numbers, never
 * estimates. Returns the updated report object (caller persists it).
 */
export function mergeRenderStats(
  report: OptimizationReport,
  stats: {
    captionMeasureHits: number;
    captionMeasureMisses: number;
    ffmpegSpawns: number;
    /** Extra ffmpeg spawns from the motion-graphics composite pass (0 if off). */
    motionGraphicsSpawns?: number;
  },
): OptimizationReport {
  const speed: SpeedLineItem[] = report.speed.filter(
    (s) =>
      s.label !== "Caption-measurement memoization" &&
      s.label !== "ffmpeg invocations" &&
      s.label !== "Motion-graphics render",
  );
  if (stats.captionMeasureHits > 0) {
    // Each avoided measurement would have cost 2 ffmpeg spawns.
    const avoidedSpawns = stats.captionMeasureHits * 2;
    speed.push({
      label: "Caption-measurement memoization",
      detail: `${stats.captionMeasureHits} repeated caption measurements served from cache (${stats.captionMeasureMisses} computed) at render time — avoided ~${avoidedSpawns} extra ffmpeg measurement spawns. Compute/speed saving, $0 API impact.`,
    });
  }
  const motionSpawns = stats.motionGraphicsSpawns ?? 0;
  if (motionSpawns > 0) {
    // Honest compute cost — NOT a saving. Reflects the extra render time/compute
    // the Remotion motion-graphics composite pass added to this run.
    speed.push({
      label: "Motion-graphics render",
      detail: `Remotion motion graphics composited this run: +1 headless-Chromium render per graphic and ${motionSpawns} extra ffmpeg overlay spawn(s). This is added compute (more render time), surfaced honestly — not a cost saving.`,
    });
  }
  speed.push({
    label: "ffmpeg invocations",
    detail: `${stats.ffmpegSpawns} ffmpeg process spawn(s) measured for this run's render (1 main render + ${stats.captionMeasureMisses * 2} caption-measurement spawns${motionSpawns > 0 ? ` + ${motionSpawns} motion-graphics overlay spawn(s)` : ""}).`,
  });
  report.speed = speed;
  report.ffmpegSpawns = stats.ffmpegSpawns;
  return report;
}

/** Free a finished run's memory after persisting. */
export function finishRun(projectId: string): void {
  const s = runs.get(projectId);
  if (activeRun === s) activeRun = null;
  runs.delete(projectId);
}

// Re-export for callers that only import this module.
export type { TokenRate };
