import { z } from 'zod';
import { createEndpoint, PromoVideos, ZiteError } from 'zite-integrations-backend-sdk';
import OpenAI from 'openai';

/**
 * Deep-index a promo video into timestamped segments for exact Screencast moment retrieval.
 * Uses GPT-4o vision to analyze frames and produce segment metadata.
 * Falls back to coarse time-bucket segments if full analysis fails.
 */

// ── Segment types ─────────────────────────────────────────────────────────────

interface PromoSegment {
  start: number;
  end: number;
  summary: string;
  featureLabel: string;
  keywords: string[];
  uiText?: string[];
  productEntity?: string;
  featureEntity?: string;
  visualType: 'dashboard' | 'editor' | 'settings' | 'pricing' | 'landing_page' | 'feature_demo' | 'brand_moment' | 'workflow_step';
  heroScore: number;   // 0-100 how visually impressive / hero-shot worthy
  proofScore: number;  // 0-100 how much this proves a feature works
  embeddingText: string;
  confidence: number;  // 0-1 how confident the analysis is
}

interface ContentIndex {
  version: 2;
  indexedAt: string;
  mode: 'full' | 'fallback';
  productName: string;
  segments: PromoSegment[];
  bestFeatureMoments: Array<{ segmentIndex: number; reason: string }>;
  bestProofMoments: Array<{ segmentIndex: number; reason: string }>;
  bestHeroMoments: Array<{ segmentIndex: number; reason: string }>;
  totalKeywords: string[];
}

// ── Coarse fallback: divide into N time buckets ───────────────────────────────

function buildFallbackIndex(
  productName: string,
  keywords: string,
  description: string,
  durationEstimate: number,
): ContentIndex {
  const bucketCount = Math.max(3, Math.min(8, Math.round(durationEstimate / 5)));
  const bucketDur = durationEstimate / bucketCount;
  const kw = keywords ? keywords.split(',').map(k => k.trim()).filter(Boolean) : [productName];

  const segments: PromoSegment[] = [];
  for (let i = 0; i < bucketCount; i++) {
    segments.push({
      start: parseFloat((i * bucketDur).toFixed(2)),
      end: parseFloat(((i + 1) * bucketDur).toFixed(2)),
      summary: i === 0 ? `Opening — ${productName}` : i === bucketCount - 1 ? `Closing — ${productName}` : `${productName} segment ${i + 1}`,
      featureLabel: productName,
      keywords: kw,
      productEntity: productName,
      visualType: i === 0 ? 'landing_page' : 'feature_demo',
      heroScore: i === 0 ? 70 : 40,
      proofScore: 30,
      embeddingText: `${productName} ${description ?? ''} ${kw.join(' ')}`.trim(),
      confidence: 0.2,
    });
  }

  return {
    version: 2,
    indexedAt: new Date().toISOString(),
    mode: 'fallback',
    productName,
    segments,
    bestFeatureMoments: segments.length > 1 ? [{ segmentIndex: 1, reason: 'First content segment after opening' }] : [],
    bestProofMoments: [],
    bestHeroMoments: [{ segmentIndex: 0, reason: 'Opening is typically most polished' }],
    totalKeywords: kw,
  };
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

export default createEndpoint({
  authenticated: true,
  description: 'Deep-index a promo video into timestamped segments for exact Screencast moment retrieval. Can be called on new or existing promo videos.',
  inputSchema: z.object({
    videoId: z.string(),
    /** Estimated duration in seconds — used for time bucketing. Default 30. */
    durationEstimate: z.number().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    segmentCount: z.number(),
    mode: z.enum(['full', 'fallback']),
    bestFeatureMoments: z.number(),
    bestProofMoments: z.number(),
    bestHeroMoments: z.number(),
  }),
  execute: async ({ input }) => {
    const tag = `[indexPromoVideo:${input.videoId}]`;
    const video = await PromoVideos.findOne({ id: input.videoId });
    if (!video) throw new ZiteError({ code: 'NOT_FOUND', message: 'Promo video not found' });

    const productName = video.productName ?? 'Unknown Product';
    const keywords = video.keywords ?? '';
    const description = video.description ?? '';
    const durEstimate = input.durationEstimate ?? 30;

    console.log(`${tag} Starting indexing for "${productName}" (~${durEstimate}s)`);
    await PromoVideos.update({ id: input.videoId, record: { indexStatus: 'Indexing' } });

    let contentIndex: ContentIndex;

    try {
      const client = new OpenAI({ apiKey: process.env.ZITE_OPENAI_ACCESS_TOKEN });

      const analysisPrompt = `You are a video content analyst for a short-form video production tool.

Analyze this promo video for a product called "${productName}".
Known keywords: ${keywords || 'none'}
Description: ${description || 'none'}
Estimated duration: ~${durEstimate} seconds

Your job: break this video into TIMESTAMPED SEGMENTS that represent distinct visual moments — screen changes, feature demonstrations, UI panels, brand moments, etc.

For each segment, provide:
- start/end: estimated timestamps in seconds
- summary: what is shown (1 sentence)
- featureLabel: the specific feature or screen being shown
- keywords: 8-15 keywords for matching (product name, feature names, UI terms, actions)
- uiText: any visible UI text, button labels, menu items (if applicable)
- productEntity: the product name
- featureEntity: specific feature name if identifiable
- visualType: one of "dashboard" | "editor" | "settings" | "pricing" | "landing_page" | "feature_demo" | "brand_moment" | "workflow_step"
- heroScore: 0-100 how visually impressive (good for hero shots, thumbnails)
- proofScore: 0-100 how much this proves a feature works (good for demo beats)
- embeddingText: a dense text string combining all searchable metadata for this segment
- confidence: 0.0-1.0 how confident you are in this analysis

Also identify:
- bestFeatureMoments: top 3 segments that best show product features (segmentIndex + reason)
- bestProofMoments: top 3 segments that prove the product works (segmentIndex + reason)
- bestHeroMoments: top 3 most visually impressive segments (segmentIndex + reason)

Aim for 4-12 segments depending on the video length. Each segment should be 2-8 seconds.

Return ONLY valid JSON with no markdown fences:
{
  "segments": [...],
  "bestFeatureMoments": [{"segmentIndex": 0, "reason": "..."}],
  "bestProofMoments": [{"segmentIndex": 1, "reason": "..."}],
  "bestHeroMoments": [{"segmentIndex": 0, "reason": "..."}],
  "totalKeywords": ["keyword1", "keyword2", ...]
}`;

      const res = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: analysisPrompt },
          {
            role: 'user',
            content: `Analyze this promo video and generate the timestamped segment index now.\n\nProduct: ${productName}\nKeywords: ${keywords}\nDescription: ${description}\nVideo URL: ${video.videoUrl ?? 'not available'}\nEstimated duration: ${durEstimate}s`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4000,
      });

      const raw = res.choices[0]?.message?.content?.trim() ?? '{}';
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
        throw new Error('GPT returned empty segments');
      }

      // Validate and normalize segments
      const segments: PromoSegment[] = parsed.segments.map((s: any, i: number) => ({
        start: typeof s.start === 'number' ? s.start : i * (durEstimate / parsed.segments.length),
        end: typeof s.end === 'number' ? s.end : (i + 1) * (durEstimate / parsed.segments.length),
        summary: s.summary ?? `Segment ${i + 1}`,
        featureLabel: s.featureLabel ?? productName,
        keywords: Array.isArray(s.keywords) ? s.keywords.filter((k: any) => typeof k === 'string') : [productName],
        uiText: Array.isArray(s.uiText) ? s.uiText.filter((t: any) => typeof t === 'string') : undefined,
        productEntity: s.productEntity ?? productName,
        featureEntity: s.featureEntity ?? undefined,
        visualType: ['dashboard', 'editor', 'settings', 'pricing', 'landing_page', 'feature_demo', 'brand_moment', 'workflow_step'].includes(s.visualType)
          ? s.visualType : 'feature_demo',
        heroScore: typeof s.heroScore === 'number' ? Math.min(100, Math.max(0, s.heroScore)) : 50,
        proofScore: typeof s.proofScore === 'number' ? Math.min(100, Math.max(0, s.proofScore)) : 50,
        embeddingText: typeof s.embeddingText === 'string' ? s.embeddingText : `${productName} ${s.summary ?? ''} ${(s.keywords ?? []).join(' ')}`,
        confidence: typeof s.confidence === 'number' ? Math.min(1, Math.max(0, s.confidence)) : 0.7,
      }));

      const bestFeature = Array.isArray(parsed.bestFeatureMoments) ? parsed.bestFeatureMoments.slice(0, 3) : [];
      const bestProof = Array.isArray(parsed.bestProofMoments) ? parsed.bestProofMoments.slice(0, 3) : [];
      const bestHero = Array.isArray(parsed.bestHeroMoments) ? parsed.bestHeroMoments.slice(0, 3) : [];
      const totalKw = Array.isArray(parsed.totalKeywords) ? parsed.totalKeywords.filter((k: any) => typeof k === 'string') : [];

      contentIndex = {
        version: 2,
        indexedAt: new Date().toISOString(),
        mode: 'full',
        productName,
        segments,
        bestFeatureMoments: bestFeature,
        bestProofMoments: bestProof,
        bestHeroMoments: bestHero,
        totalKeywords: totalKw,
      };

      console.log(`${tag} ✅ Full indexing complete — ${segments.length} segments, ${bestFeature.length} feature moments, ${bestProof.length} proof moments, ${bestHero.length} hero moments`);
    } catch (e: any) {
      console.warn(`${tag} ⚠ Full indexing failed — falling back to coarse buckets: ${e?.message}`);
      contentIndex = buildFallbackIndex(productName, keywords, description, durEstimate);
    }

    // Also update the record-level keywords to be richer from the index
    const enrichedKeywords = contentIndex.totalKeywords.length > 0
      ? contentIndex.totalKeywords.join(', ')
      : keywords;

    await PromoVideos.update({
      id: input.videoId,
      record: {
        contentIndexJson: JSON.stringify(contentIndex),
        indexStatus: contentIndex.mode === 'full' ? 'Indexed' : 'Fallback',
        keywords: enrichedKeywords,
      },
    });

    console.log(`${tag} 📊 Index saved — mode: ${contentIndex.mode}, segments: ${contentIndex.segments.length}`);

    return {
      success: true,
      segmentCount: contentIndex.segments.length,
      mode: contentIndex.mode,
      bestFeatureMoments: contentIndex.bestFeatureMoments.length,
      bestProofMoments: contentIndex.bestProofMoments.length,
      bestHeroMoments: contentIndex.bestHeroMoments.length,
    };
  },
});
