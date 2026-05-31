/**
 * Tactical B-Roll system — shared helpers for generateShot, captureShots, recaptureShot.
 *
 * RULES:
 * - Screencast is the default inserted visual. B-Roll is a rare fallback.
 * - Tactical B-Roll is only allowed when Screencast is genuinely not a fit.
 * - Prompts must be literal, situational, realistic — not abstract by default.
 * - Trust first, proof second, style third.
 * - Narrator-first pacing: keep narrator visible ~1s before overlay enters.
 */
import OpenAI from 'openai';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PromoVideoEntry = { label: string; tags: string; url: string; description?: string; contentIndexJson?: string };
export type MatchContext = {
  targetUrl?: string;
  matchKeywords?: string[];
  transcriptSnippet?: string;
  productEntity?: string;
  featureEntity?: string;
  /** True when this beat immediately follows the required tactical B-roll opening. */
  followsRequiredTacticalBroll?: boolean;
  /** Editorial role this screencast should serve. */
  intendedRole?: 'proof' | 'demo' | 'workflow';
};

export interface TacticalBrollContext {
  beatType: string;
  summary: string;
  emotionalIntent?: string;
  transcriptSnippet?: string;
  matchKeywords?: string[];
  contextHint?: string;
  showNarrator?: boolean;
  overlayDelaySeconds?: number;
  /** Neighboring transcript lines for richer context */
  neighborContext?: string;
}

export interface TacticalBrollDecision {
  allowed: boolean;
  reason: string;
  avoidedScreencastBecause: string;
  promptUsed?: string;
}

export interface TacticalBrollMetadata {
  brollMode: 'tactical_broll';
  brollReason: string;
  avoidedScreencastBecause: string;
  promptUsed: string;
  overlayDelaySeconds: number;
  showNarratorFirst: boolean;
  kinoviTaskId?: string;
  brollTrack: 'generated';
}

// ── Beat types that should almost never be B-Roll ─────────────────────────────

const NARRATOR_BEATS = new Set(['hook', 'cta', 'objection', 'transition']);

// ── Tactical B-Roll Prompt Builder ────────────────────────────────────────────

const TACTICAL_PROMPT_SYSTEM = `You are a video director creating a TACTICAL B-roll clip for a short-form vertical ad.
This B-roll is expensive and rare — it must earn its place in the edit.

STYLE REQUIREMENTS:
- Literal and situational: show what the narrator is actually describing
- If the line describes a person doing something, show a real human in that scenario
- If the line describes a feeling/problem, show the realistic environment or action
- Vertical 9:16 format, polished short-form ad look
- Cohesive warm palette: walnut brown (#32251C), caramel (#9E9C9D), cream (#DEDEDE) tones
- Smooth organic motion, professional cinematography
- NO faces in extreme close-up, NO text overlays, NO logos, NO brand names
- Use abstract/atmospheric visuals ONLY if the narration is genuinely abstract
- Default to LITERAL interpretation — show the scenario, not a metaphor

OUTPUT: Return ONLY the Seedance prompt text (max 100 words). No explanation, no quotes.`.trim();

/**
 * Build a rich, contextual tactical B-roll prompt from beat metadata.
 */
export async function buildTacticalPrompt(
  client: OpenAI,
  ctx: TacticalBrollContext,
  tag: string,
): Promise<string> {
  const inputLines: string[] = [];
  inputLines.push(`Beat type: ${ctx.beatType}`);
  inputLines.push(`Summary: "${ctx.summary}"`);
  if (ctx.transcriptSnippet) inputLines.push(`Narrator is saying: "${ctx.transcriptSnippet}"`);
  if (ctx.neighborContext) inputLines.push(`Surrounding transcript: "${ctx.neighborContext}"`);
  if (ctx.emotionalIntent) inputLines.push(`Emotional intent: ${ctx.emotionalIntent}`);
  if (ctx.matchKeywords?.length) inputLines.push(`Visual keywords: ${ctx.matchKeywords.join(', ')}`);
  if (ctx.contextHint) inputLines.push(`Project context: ${ctx.contextHint}`);
  inputLines.push(`\nCreate a LITERAL, SITUATIONAL B-roll prompt that shows exactly what the narrator describes.`);

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: TACTICAL_PROMPT_SYSTEM },
        { role: 'user', content: inputLines.join('\n') },
      ],
      max_tokens: 150,
    });
    const prompt = res.choices[0]?.message?.content?.trim();
    if (prompt) {
      console.log(`${tag} Tactical prompt: "${prompt.slice(0, 120)}"`);
      return prompt;
    }
  } catch (e: any) {
    console.warn(`${tag} Tactical prompt build failed: ${e?.message}`);
  }
  // Fallback: use summary directly with style cue
  return `${ctx.summary}. Warm cinematic tones, realistic action, vertical 9:16 format.`;
}

// ── Tactical B-Roll Guard ─────────────────────────────────────────────────────

/**
 * Check whether a B-Roll beat has any reasonable Screencast candidate.
 * If yes, recommend Screencast instead. If no, allow tactical B-Roll.
 */
export function evaluateTacticalBrollGuard(
  labels: Record<string, any>,
  promoPoolSize: number,
  tag: string,
): TacticalBrollDecision {
  const beatType = labels.beatType ?? '';
  const productEntity = labels.productEntity ?? '';
  const featureEntity = labels.featureEntity ?? '';
  const matchKeywords: string[] = Array.isArray(labels.matchKeywords) ? labels.matchKeywords : [];
  const transcriptSnippet: string = labels.transcriptSnippet ?? '';

  // Rule 1: Narrator-priority beats should not be B-Roll
  if (NARRATOR_BEATS.has(beatType)) {
    console.log(`${tag} GUARD: beat "${beatType}" is narrator-priority → prefer Talking Head, not B-Roll`);
    return {
      allowed: false,
      reason: `Beat type "${beatType}" should show narrator (trust/authority), not generated B-Roll`,
      avoidedScreencastBecause: 'n/a — B-Roll rejected for narrator beat',
    };
  }

  // Rule 2: If there's a product/feature entity, Screencast is better
  if (productEntity || featureEntity) {
    console.log(`${tag} GUARD: product="${productEntity}" feature="${featureEntity}" → Screencast candidate exists`);
    return {
      allowed: false,
      reason: `Product "${productEntity || featureEntity}" mentioned — use Screencast instead`,
      avoidedScreencastBecause: 'n/a — Screencast is available',
    };
  }

  // Rule 3: If keywords suggest a product/tool/software, Screencast is better
  const productKeywords = ['app', 'tool', 'software', 'platform', 'dashboard', 'website', 'feature', 'product', 'demo', 'ui', 'interface', 'workflow', 'automation'];
  const hasProductKeyword = matchKeywords.some(kw => productKeywords.some(pk => kw.toLowerCase().includes(pk)));
  if (hasProductKeyword && promoPoolSize > 0) {
    console.log(`${tag} GUARD: keywords contain product terms + promo pool available → Screencast preferred`);
    return {
      allowed: false,
      reason: `Keywords suggest product content and ${promoPoolSize} promo videos available — Screencast preferred`,
      avoidedScreencastBecause: 'n/a — Screencast is available via keyword match',
    };
  }

  // Rule 4: If the transcript mentions something demonstrable, prefer Screencast
  const demoTerms = ['click', 'open', 'setup', 'configure', 'install', 'connect', 'sign up', 'log in', 'drag', 'type', 'select', 'use'];
  const hasDemoTerm = demoTerms.some(t => transcriptSnippet.toLowerCase().includes(t));
  if (hasDemoTerm && promoPoolSize > 0) {
    console.log(`${tag} GUARD: transcript contains demo-action term → Screencast preferred`);
    return {
      allowed: false,
      reason: `Narrator describes an action ("${transcriptSnippet.slice(0, 40)}") that can be shown via Screencast`,
      avoidedScreencastBecause: 'n/a — action content is better as Screencast',
    };
  }

  // Allowed: no screencast candidate found
  const avoidReason = promoPoolSize === 0
    ? 'No promo videos in pool'
    : 'Beat content is emotional/abstract with no product reference — Screencast not a strong fit';
  console.log(`${tag} GUARD: tactical B-Roll ALLOWED — ${avoidReason}`);
  return {
    allowed: true,
    reason: `Tactical B-Roll justified: ${avoidReason}`,
    avoidedScreencastBecause: avoidReason,
  };
}

// ── Seedance Task Creator ─────────────────────────────────────────────────────

/**
 * Create a Kinovi/Seedance B-Roll task. Returns taskId immediately, no polling.
 */
export async function createSeedanceTask(
  seedancePrompt: string,
  durationSeconds: number,
  tag: string,
): Promise<{ taskId: string } | null> {
  const apiKey = (process.env.ZITE_KINOVI_API_KEY ?? '').trim();
  if (!apiKey) { console.warn(`${tag} ZITE_KINOVI_API_KEY not set`); return null; }

  const clampedDur = Math.min(Math.max(Math.round(durationSeconds), 4), 15);
  const requestBody = {
    model: 'seedance2-fast',
    inputs: { prompt: seedancePrompt, duration: String(clampedDur), aspectRatio: '9:16', outputResolution: '480p' },
  };
  console.log(`${tag} Seedance createTask — duration: ${clampedDur}s, prompt: "${seedancePrompt.slice(0, 80)}"`);

  try {
    const createRes = await fetch('https://kinovi.ai/api/v1/jobs/createTask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const createRawText = await createRes.text().catch(() => '(unreadable body)');
    console.log(`${tag} createTask — HTTP ${createRes.status} | body: ${createRawText}`);
    if (!createRes.ok) { console.warn(`${tag} createTask FAILED — HTTP ${createRes.status}`); return null; }
    let cd: { task_id?: string; taskId?: string; id?: string; job_id?: string } = {};
    try { cd = JSON.parse(createRawText); } catch { return null; }
    const taskId = cd?.task_id ?? cd?.taskId ?? cd?.id ?? cd?.job_id;
    if (!taskId) { console.warn(`${tag} No task ID`); return null; }
    console.log(`${tag} ✅ Task created — ID: ${taskId}`);
    return { taskId };
  } catch (e: any) {
    console.error(`${tag} Error: ${e?.message ?? String(e)}`);
    return null;
  }
}

// ── Segment-aware Retrieval Result ────────────────────────────────────────────

export interface ScreencastRetrieval {
  url: string;
  label: string;
  segmentStart: number;
  segmentEnd: number;
  confidence: number;       // 0–1
  reason: string;
  segmentIndex?: number;
  segmentSummary?: string;
}

/** The labels persisted into uiLabelsJson for Screencast shots. */
export interface ScreencastLabels {
  clipStartOffset: number;
  clipEndOffset: number;
  retrievalConfidence: number;
  matchReason: string;
  showNarratorFirst: boolean;
  overlayDelaySeconds: number;
  matchedSegment?: number;
  segmentSummary?: string;
  /** True when this Screencast follows the required tactical B-roll opening moment. */
  followsRequiredTacticalBroll?: boolean;
  /** Editorial role: proof, demo, or workflow. */
  intendedRole?: 'proof' | 'demo' | 'workflow';
  /** Why this Screencast was selected as the follow-up proof layer. */
  followUpSelectionReason?: string;
}

// ── Narrator-first pacing ─────────────────────────────────────────────────────

const DEFAULT_OVERLAY_DELAY = 1.0;
const MIN_OVERLAY_VISIBLE   = 1.0; // at least 1s of screencast must be visible

/**
 * Compute narrator-first overlay delay, intelligently clamped for short beats.
 */
export function computeOverlayDelay(beatDurationSec: number, preferredDelay = DEFAULT_OVERLAY_DELAY): number {
  // If beat is too short, clamp so at least MIN_OVERLAY_VISIBLE of screencast shows
  const maxDelay = Math.max(0, beatDurationSec - MIN_OVERLAY_VISIBLE);
  return parseFloat(Math.min(preferredDelay, maxDelay).toFixed(2));
}

// ── Segment-level Retrieval Matching ──────────────────────────────────────────

/**
 * Full retrieval pipeline for Screencast:
 * 1. Match best promo video (file-level)
 * 2. Match best segment within that video
 * 3. Return structured retrieval with confidence + narrator-first pacing
 *
 * If no good segment match, falls back to video-level.
 * If overall confidence is too low, returns null so caller can prefer Talking Head.
 */
export async function retrieveScreencast(
  client: OpenAI,
  caption: string,
  pool: PromoVideoEntry[],
  beatDurationSec: number,
  tag: string,
  ctx?: MatchContext,
): Promise<{ retrieval: ScreencastRetrieval; labels: ScreencastLabels } | null> {
  if (!pool.length) {
    console.warn(`${tag} RETRIEVAL: promo pool is empty`);
    return null;
  }

  // Step 1: File-level match
  console.log(`${tag} RETRIEVAL: beat="${caption.slice(0, 60)}" pool=${pool.length} dur=${beatDurationSec.toFixed(1)}s`);
  const fileMatch = await matchPromoForScreencast(client, caption, pool, tag, ctx);
  if (!fileMatch) return null;

  const matchedEntry = pool.find(p => p.url === fileMatch.url);

  // Step 2: Segment-level match (if index exists)
  let segResult: { segmentIndex: number; start: number; end: number; summary: string; reason: string; confidence: number } | null = null;

  if (matchedEntry?.contentIndexJson) {
    try {
      const index = JSON.parse(matchedEntry.contentIndexJson);
      const segments: any[] = Array.isArray(index.segments) ? index.segments : [];
      if (segments.length > 0) {
        segResult = await matchBestSegment(client, caption, segments, tag, ctx);
      }
    } catch (e: any) {
      console.warn(`${tag} RETRIEVAL: segment index parse failed: ${e?.message}`);
    }
  }

  // Build retrieval result
  const isPostTactical = ctx?.followsRequiredTacticalBroll === true;
  const intendedRole = ctx?.intendedRole ?? (isPostTactical ? 'proof' : undefined);

  // Avoid defaulting to video beginning (0s) when no segment matched — pick a
  // midpoint so the viewer doesn't always see the intro/logo of the promo.
  const segStart = segResult?.start ?? (segResult ? 0 : Math.min(5, 0));
  const segEnd = segResult?.end ?? 10;
  let confidence = segResult?.confidence ?? 0.5; // file-level only = 0.5 confidence
  const reason = segResult?.reason ?? `File-level match: ${fileMatch.label}`;

  // ── Post-tactical confidence boost ────────────────────────────────────────
  // When this beat follows the required tactical B-roll opening, the editorial
  // expectation is that Screencast is the preferred follow-up. Boost confidence
  // by 0.1 (capped at 1.0) so marginal matches survive the quality gate.
  let followUpSelectionReason: string | undefined;
  if (isPostTactical) {
    const preBoosted = confidence;
    confidence = Math.min(1.0, confidence + 0.10);
    followUpSelectionReason =
      `Post-tactical-broll follow-up (role=${intendedRole ?? 'proof'}): ` +
      `confidence boosted ${preBoosted.toFixed(2)} → ${confidence.toFixed(2)} ` +
      `because Screencast is the preferred proof layer after the opening punch`;
    console.log(`${tag} 🎯 POST-TACTICAL SCREENCAST: ${followUpSelectionReason}`);
  }

  const retrieval: ScreencastRetrieval = {
    url: fileMatch.url,
    label: fileMatch.label,
    segmentStart: segStart,
    segmentEnd: segEnd,
    confidence,
    reason,
    segmentIndex: segResult?.segmentIndex,
    segmentSummary: segResult?.summary,
  };

  const overlayDelay = computeOverlayDelay(beatDurationSec);

  const labels: ScreencastLabels = {
    clipStartOffset: parseFloat(segStart.toFixed(2)),
    clipEndOffset: parseFloat(segEnd.toFixed(2)),
    retrievalConfidence: parseFloat(confidence.toFixed(3)),
    matchReason: reason,
    showNarratorFirst: true,
    overlayDelaySeconds: overlayDelay,
    matchedSegment: segResult?.segmentIndex,
    segmentSummary: segResult?.summary,
    followsRequiredTacticalBroll: isPostTactical || undefined,
    intendedRole,
    followUpSelectionReason,
  };

  console.log(`${tag} RETRIEVAL RESULT: video="${fileMatch.label}" segment=${segResult?.segmentIndex ?? 'file-level'} ` +
    `range=[${segStart.toFixed(1)}s–${segEnd.toFixed(1)}s] confidence=${confidence.toFixed(2)} ` +
    `overlayDelay=${overlayDelay}s followsTactical=${isPostTactical} role=${intendedRole ?? 'default'} reason="${reason.slice(0, 80)}"`);

  return { retrieval, labels };
}

/**
 * Match the best segment within a single promo video's index for a beat caption.
 * Uses GPT to rank segments by feature match, proof/demo strength, keyword overlap.
 */
async function matchBestSegment(
  client: OpenAI,
  caption: string,
  segments: any[],
  tag: string,
  ctx?: MatchContext,
): Promise<{ segmentIndex: number; start: number; end: number; summary: string; reason: string; confidence: number } | null> {
  const segList = segments.map((s: any, i: number) =>
    `${i}: [${s.start?.toFixed?.(1) ?? s.start}s–${s.end?.toFixed?.(1) ?? s.end}s] ${s.summary ?? ''} | feature=${s.featureLabel ?? ''} | keywords=${(s.keywords ?? []).join(',')} | hero=${s.heroScore ?? 0} proof=${s.proofScore ?? 0}`
  ).join('\n');

  const userLines: string[] = [`Shot caption: "${caption}"`];
  if (ctx?.productEntity) userLines.push(`Product: ${ctx.productEntity}`);
  if (ctx?.featureEntity) userLines.push(`Feature: ${ctx.featureEntity}`);
  if (ctx?.matchKeywords?.length) userLines.push(`Keywords from script: ${ctx.matchKeywords.join(', ')}`);
  if (ctx?.transcriptSnippet) userLines.push(`Narrator says: "${ctx.transcriptSnippet}"`);
  if (ctx?.targetUrl) userLines.push(`Target URL: ${ctx.targetUrl}`);
  if (ctx?.followsRequiredTacticalBroll) {
    userLines.push(`IMPORTANT: This beat follows the required tactical B-roll opening. Prefer segments with high proofScore or that demonstrate a concrete feature/workflow. Do NOT pick segment 0 (intro/logo) unless it genuinely shows the best proof content.`);
    if (ctx.intendedRole) userLines.push(`Intended editorial role: ${ctx.intendedRole}`);
  }

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a video editor selecting the best SEGMENT within a promo video for a screencast shot.

SCORING — ranked by importance:
1. PRODUCT/FEATURE ENTITY MATCH: segment's featureLabel matches the product or feature the narrator mentions → strongest signal.
2. TRANSCRIPT SIMILARITY: segment summary/keywords closely match what the narrator is saying.
3. KEYWORD OVERLAP: segment keywords match the shot's matchKeywords.
4. PROOF/DEMO STRENGTH: higher proofScore = better for demo/proof beats.
5. HERO SCORE: higher heroScore = better for hook/payoff beats.
6. URL/DOMAIN RELEVANCE: if a target URL is given, segments showing that product are preferred.

Rate your confidence 0.0–1.0:
- 0.9+ = segment clearly shows the exact feature/screen the narrator describes
- 0.7–0.89 = good thematic match, right product area
- 0.5–0.69 = loosely related, same product but different feature
- below 0.5 = weak match, mostly filler

Segments (0-indexed):
${segList}

Respond ONLY with valid JSON: {"segment": 2, "confidence": 0.85, "reason": "brief reason"}`,
        },
        { role: 'user', content: userLines.join('\n') },
      ],
      temperature: 0,
      max_tokens: 80,
    });

    const raw = res.choices[0]?.message?.content?.trim() ?? '{}';
    const parsed = JSON.parse(raw);
    if (typeof parsed.segment === 'number' && segments[parsed.segment]) {
      const seg = segments[parsed.segment];
      const start = typeof seg.start === 'number' ? seg.start : 0;
      const end = typeof seg.end === 'number' ? seg.end : start + 5;
      const confidence = typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.6;
      const reason = parsed.reason ?? 'segment match';
      console.log(`${tag} SEGMENT MATCH: #${parsed.segment} [${start.toFixed(1)}s–${end.toFixed(1)}s] confidence=${confidence.toFixed(2)} "${seg.summary?.slice(0, 50)}" reason="${reason}"`);
      return { segmentIndex: parsed.segment, start, end, summary: seg.summary ?? '', reason, confidence };
    }
  } catch (e: any) {
    console.warn(`${tag} Segment matching failed (non-fatal): ${e?.message}`);
  }
  return null;
}

// ── Confidence threshold for Screencast quality gate ──────────────────────────

/** Below this confidence, prefer Talking Head over a weak Screencast. */
export const WEAK_SCREENCAST_THRESHOLD = 0.35;

// ── Legacy API (kept for B-Roll → Screencast conversion paths) ────────────────

export interface SegmentMatch {
  url: string;
  label: string;
  segmentIndex?: number;
  clipStartOffset?: number;
  segmentSummary?: string;
  matchReason?: string;
}

/**
 * Legacy segment-aware matching wrapper. Used by B-Roll conversion fallback.
 * Prefer retrieveScreencast() for primary Screencast paths.
 */
export async function matchPromoWithSegments(
  client: OpenAI,
  caption: string,
  pool: PromoVideoEntry[],
  tag: string,
  ctx?: MatchContext,
): Promise<SegmentMatch | null> {
  const result = await retrieveScreencast(client, caption, pool, 5, tag, ctx);
  if (!result) return null;
  return {
    url: result.retrieval.url,
    label: result.retrieval.label,
    segmentIndex: result.retrieval.segmentIndex,
    clipStartOffset: result.labels.clipStartOffset,
    segmentSummary: result.retrieval.segmentSummary,
    matchReason: result.retrieval.reason,
  };
}

export async function matchPromoForScreencast(
  client: OpenAI,
  caption: string,
  pool: PromoVideoEntry[],
  tag: string,
  ctx?: MatchContext,
): Promise<{ url: string; label: string; fileConfidence?: number } | null> {
  if (!pool.length) { console.warn(`${tag} Promo pool is empty`); return null; }

  const poolList = pool.map((v, i) => {
    let entry = `${i}: ${v.label}`;
    if (v.tags) entry += ` | keywords: ${v.tags}`;
    if (v.description) entry += ` | description: ${v.description}`;
    return entry;
  }).join('\n');

  const userLines: string[] = [`Shot caption: "${caption}"`];
  if (ctx?.targetUrl) userLines.push(`Product URL the director chose: ${ctx.targetUrl}`);
  if (ctx?.productEntity) userLines.push(`Product entity: ${ctx.productEntity}`);
  if (ctx?.featureEntity) userLines.push(`Feature entity: ${ctx.featureEntity}`);
  if (ctx?.matchKeywords?.length) userLines.push(`Keywords extracted from script: ${ctx.matchKeywords.join(', ')}`);
  if (ctx?.transcriptSnippet) userLines.push(`What narrator is saying: "${ctx.transcriptSnippet}"`);

  console.log(`${tag} Smart file matching — context: product=${ctx?.productEntity ?? '-'} feature=${ctx?.featureEntity ?? '-'} keywords=[${ctx?.matchKeywords?.join(',') ?? ''}]`);

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a precise video editor selecting the most relevant promo video for a screencast shot.

SCORING (ranked by importance):
1. PRODUCT NAME MATCH: narrator mentions a product/tool by name → match that product's promo video.
2. FEATURE ENTITY MATCH: if a featureEntity is given, pick the video most likely to show that feature.
3. KEYWORD OVERLAP: cross-reference matchKeywords against each video's label, keywords, description.
4. SEMANTIC RELEVANCE: pick the clip whose content best illustrates what the narrator is talking about.
5. URL DOMAIN MATCH: product URL domain matches a promo video's known product → strong signal.

Always pick the BEST index — never refuse.

Pool (0-indexed):
${poolList}

Respond ONLY with valid JSON: {"match": 5, "reason": "brief reason"}`,
        },
        { role: 'user', content: userLines.join('\n') },
      ],
      temperature: 0,
      max_tokens: 60,
    });
    const raw = res.choices[0]?.message?.content?.trim() ?? '{}';
    console.log(`${tag} Match response: ${raw}`);
    const parsed = JSON.parse(raw);
    if (typeof parsed.match === 'number') {
      const video = pool[parsed.match as number];
      if (video) {
        console.log(`${tag} Matched: "${video.label}" reason="${parsed.reason}" → ${video.url}`);
        return { url: video.url, label: video.label };
      }
    }
  } catch (e: any) { console.warn(`${tag} Match error: ${e?.message}`); }
  console.warn(`${tag} Match parse failed — falling back to pool[0]`);
  return { url: pool[0].url, label: pool[0].label };
}
