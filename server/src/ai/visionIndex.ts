/**
 * Vision-based promo-video indexing.
 *
 * Extracts 1 frame/second from a promo video and asks Claude vision to describe
 * what is actually on screen each second, producing a per-second timeline plus
 * grouped segments. The result is cached on the PromoVideo's contentIndexJson
 * and reused by the director/retrieval on every render — this runs ONCE per
 * video (at index time / reindex), never during a render.
 *
 * The output keeps the fields the retrieval matcher already reads (segments[]
 * with start/end/summary/featureLabel/keywords/heroScore/proofScore) and adds:
 *   - perSecond[]: { t, caption } — what's visible at each second
 *   - mediaKind: "real_footage" | "screen_recording" | "ai_generated" | "mixed"
 *     (a hint the director can use; cached per video)
 */
import { claudeVisionJSON } from "./claude.js";
import { extractFramesPerSecond } from "./frames.js";

export interface PromoSegment {
  start: number;
  end: number;
  summary: string;
  featureLabel: string;
  keywords: string[];
  visualType: string;
  heroScore: number;
  proofScore: number;
  /** 0-100: how much the technology/product itself is actually being SHOWN
   *  (a live feature/UI in action), vs intro/brand/title cards. */
  techScore: number;
  /** True when this stretch is dominated by on-screen text (title/intro
   *  cards). We avoid these when inserting a promo. */
  hasText: boolean;
  embeddingText: string;
  confidence: number;
}

export interface VisionContentIndex {
  version: 3;
  indexedAt: string;
  mode: "vision";
  productName: string;
  mediaKind: "real_footage" | "screen_recording" | "ai_generated" | "mixed";
  perSecond: Array<{ t: number; caption: string }>;
  segments: PromoSegment[];
  bestFeatureMoments: Array<{ segmentIndex: number; reason: string }>;
  bestProofMoments: Array<{ segmentIndex: number; reason: string }>;
  bestHeroMoments: Array<{ segmentIndex: number; reason: string }>;
  totalKeywords: string[];
}

const SYSTEM = `You are a meticulous video content analyst for a short-form video editor.
You are given a sequence of frames sampled at 1 frame per second from a product promo video, each labeled "Frame at Ns:".
Describe what is ACTUALLY visible — do not invent features you cannot see. Read on-screen UI text, product names, and visible actions.

Return ONLY valid JSON with this exact shape:
{
  "mediaKind": "real_footage" | "screen_recording" | "ai_generated" | "mixed",
  "perSecond": [ { "t": 0, "caption": "<=12 words on exactly what's on screen at this second" }, ... one entry per frame ],
  "segments": [
    {
      "start": <sec>, "end": <sec>,
      "summary": "what this stretch shows (1 sentence)",
      "featureLabel": "the specific feature/screen/product shown",
      "keywords": ["8-15 searchable terms: product, feature, UI elements, use-cases"],
      "visualType": "dashboard|editor|settings|pricing|landing_page|feature_demo|brand_moment|workflow_step|title_card|talking_head|broll",
      "heroScore": <0-100 visually impressive / hero-shot worthy>,
      "proofScore": <0-100 how strongly it proves the product works / shows a real feature>,
      "techScore": <0-100 how much the ACTUAL technology/product is being SHOWN in action here (a live feature/UI/result). Title cards, logos, intros, and talking heads = LOW techScore>,
      "hasText": <true if this stretch is dominated by on-screen TEXT such as a title/intro card, lower-third heavy, or a mostly-text slide; false if it's the product/feature itself in action>,
      "embeddingText": "dense searchable description",
      "confidence": <0-1 how sure you are of this segment's content>
    }
  ],
  "bestFeatureMoments": [ { "segmentIndex": N, "reason": "..." } ],
  "bestProofMoments":   [ { "segmentIndex": N, "reason": "..." } ],
  "bestHeroMoments":    [ { "segmentIndex": N, "reason": "..." } ],
  "totalKeywords": ["union of the most useful keywords across the whole video"]
}

Rules:
- perSecond MUST have exactly one entry per frame given, with t = the frame's second.
- Group consecutive similar seconds into 3-12 segments covering the whole duration with no gaps.
- mediaKind: "screen_recording" if it's mostly software UI/screencast; "real_footage" if filmed real-world; "ai_generated" if it looks synthetically generated (uncanny motion, morphing, dreamlike); "mixed" otherwise.
- IMPORTANT — distinguish the TECHNOLOGY being shown from intro/title text. Many promos OPEN with a title card / logo / big on-screen text before the product appears. Mark those opening text stretches hasText=true and techScore LOW, and mark the stretches where the actual feature/UI/result is on screen techScore HIGH. The editor uses this to skip the intro text and cut straight to the technology in action.
- In each segment's keywords and featureLabel, name the SPECIFIC technology/feature shown (e.g. "image generation", "voice cloning", "code autocomplete", "video editor timeline") so it can be matched to what a narrator is saying.`;

export async function buildVisionIndex(opts: {
  videoRef: string;
  productName: string;
  keywords?: string;
  description?: string;
}): Promise<VisionContentIndex> {
  const { frames, duration } = await extractFramesPerSecond(opts.videoRef);
  if (frames.length === 0) {
    throw new Error("No frames could be extracted from the promo video.");
  }

  const userText =
    `Product: ${opts.productName}\n` +
    (opts.keywords ? `Known keywords: ${opts.keywords}\n` : "") +
    (opts.description ? `Description: ${opts.description}\n` : "") +
    `Frames given: ${frames.length} (sampled at 1/sec). Approx duration: ${Math.round(duration)}s.\n` +
    `Analyze every frame and produce the JSON index now.`;

  const raw = await claudeVisionJSON({ system: SYSTEM, userText, frames });
  const parsed = JSON.parse(raw) as Partial<VisionContentIndex>;

  const segments: PromoSegment[] = Array.isArray(parsed.segments)
    ? (parsed.segments as PromoSegment[]).map((s) => ({
        ...s,
        // Back-compat defaults for older index shapes / missing fields.
        techScore: typeof (s as any).techScore === "number" ? (s as any).techScore : (typeof s.proofScore === "number" ? s.proofScore : 50),
        hasText: typeof (s as any).hasText === "boolean"
          ? (s as any).hasText
          : /title|intro|text|logo|brand_moment|title_card/i.test(`${s.visualType ?? ""} ${s.summary ?? ""}`),
      }))
    : [];
  const perSecond = Array.isArray(parsed.perSecond) ? parsed.perSecond! : [];

  return {
    version: 3,
    indexedAt: new Date().toISOString(),
    mode: "vision",
    productName: opts.productName,
    mediaKind: (parsed.mediaKind as VisionContentIndex["mediaKind"]) ?? "mixed",
    perSecond,
    segments,
    bestFeatureMoments: parsed.bestFeatureMoments ?? [],
    bestProofMoments: parsed.bestProofMoments ?? [],
    bestHeroMoments: parsed.bestHeroMoments ?? [],
    totalKeywords: Array.isArray(parsed.totalKeywords) ? parsed.totalKeywords : [],
  };
}
