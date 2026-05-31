import { z } from 'zod';
import { createEndpoint, PromoVideos } from 'zite-integrations-backend-sdk';
import OpenAI from 'openai';

export default createEndpoint({
  authenticated: true,
  description: 'Save a new promo video. AI derives seed metadata from filename (fallback). Deep indexing runs automatically after save.',
  inputSchema: z.object({
    videoUrl: z.string().url(),
    fileName: z.string().min(1),
    /** Estimated duration in seconds — helps indexing produce better time buckets. Default 30. */
    durationEstimate: z.number().optional(),
  }),
  outputSchema: z.object({
    videoId: z.string(),
    productName: z.string().optional(),
    keywords: z.string().optional(),
    description: z.string().optional(),
    indexStatus: z.string().optional(),
  }),
  execute: async ({ input }) => {
    const tag = `[savePromoVideo]`;
    const rawName = input.fileName.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim();

    // Create record immediately so video is saved even if AI fails
    const record = await PromoVideos.create({
      record: {
        productName: rawName,
        videoUrl: input.videoUrl,
        indexStatus: 'Pending',
      },
    });

    let productName: string | undefined = rawName;
    let keywords: string | undefined;
    let description: string | undefined;

    // Phase 1: Quick filename-based seed metadata (fallback layer)
    try {
      const client = new OpenAI({ apiKey: process.env.ZITE_OPENAI_ACCESS_TOKEN });

      const res = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a video metadata assistant. Given a raw video filename, extract and return structured metadata as JSON.

Return ONLY a valid JSON object with these exact keys:
{
  "productName": "Clean, properly capitalised product or brand name (e.g. 'ChatGPT', 'Figma', 'Notion')",
  "keywords": "Comma-separated list of 10–15 matching keywords and phrases — include the brand name, abbreviations, product category, key features, use cases, and related topics a script might mention",
  "description": "One sentence (max 20 words) describing when the AI Director should pick this video — e.g. 'Use when the script mentions Figma, design tools, or UI prototyping.'"
}

No explanation, no markdown — JSON only.`,
          },
          {
            role: 'user',
            content: `Filename: "${input.fileName}"`,
          },
        ],
        max_tokens: 300,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const raw = res.choices[0]?.message?.content?.trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        productName = parsed.productName ?? rawName;
        keywords = parsed.keywords ?? undefined;
        description = parsed.description ?? undefined;
      }
    } catch (e: any) {
      console.warn(`${tag} AI seed metadata failed (non-fatal): ${e?.message}`);
    }

    // Write seed metadata
    await PromoVideos.update({
      id: record.id,
      record: { productName, keywords, description },
    });

    // Phase 2: Trigger deep indexing (non-blocking — we don't await completion)
    // The indexPromoVideo endpoint will run the full analysis and update contentIndexJson.
    // We call it inline here since it's fast enough and the user wants immediate feedback.
    const durEstimate = input.durationEstimate ?? 30;
    console.log(`${tag} Starting deep indexing for "${productName}" (id: ${record.id})`);

    try {
      const client = new OpenAI({ apiKey: process.env.ZITE_OPENAI_ACCESS_TOKEN });
      await PromoVideos.update({ id: record.id, record: { indexStatus: 'Indexing' } });

      // Build the same analysis inline to avoid cross-endpoint call
      const analysisPrompt = `You are a video content analyst for a short-form video production tool.

Analyze this promo video for a product called "${productName}".
Known keywords: ${keywords || 'none'}
Description: ${description || 'none'}
Estimated duration: ~${durEstimate} seconds

Break this video into TIMESTAMPED SEGMENTS (4-12 segments, each 2-8 seconds) representing distinct visual moments.

For each segment provide:
- start/end (seconds), summary, featureLabel, keywords (8-15), uiText (visible text), productEntity, featureEntity
- visualType: "dashboard" | "editor" | "settings" | "pricing" | "landing_page" | "feature_demo" | "brand_moment" | "workflow_step"
- heroScore (0-100), proofScore (0-100), embeddingText, confidence (0-1)

Also identify: bestFeatureMoments (top 3), bestProofMoments (top 3), bestHeroMoments (top 3) — each with segmentIndex + reason.

Return ONLY valid JSON:
{
  "segments": [...],
  "bestFeatureMoments": [...],
  "bestProofMoments": [...],
  "bestHeroMoments": [...],
  "totalKeywords": [...]
}`;

      const res = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: analysisPrompt },
          { role: 'user', content: `Analyze now.\nProduct: ${productName}\nKeywords: ${keywords}\nVideo URL: ${input.videoUrl}\nDuration: ${durEstimate}s` },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4000,
      });

      const rawJson = res.choices[0]?.message?.content?.trim() ?? '{}';
      const parsed = JSON.parse(rawJson);

      if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
        const contentIndex = {
          version: 2,
          indexedAt: new Date().toISOString(),
          mode: 'full' as const,
          productName: productName ?? rawName,
          segments: parsed.segments,
          bestFeatureMoments: Array.isArray(parsed.bestFeatureMoments) ? parsed.bestFeatureMoments.slice(0, 3) : [],
          bestProofMoments: Array.isArray(parsed.bestProofMoments) ? parsed.bestProofMoments.slice(0, 3) : [],
          bestHeroMoments: Array.isArray(parsed.bestHeroMoments) ? parsed.bestHeroMoments.slice(0, 3) : [],
          totalKeywords: Array.isArray(parsed.totalKeywords) ? parsed.totalKeywords : [],
        };

        const enrichedKw = contentIndex.totalKeywords.length > 0
          ? contentIndex.totalKeywords.join(', ')
          : keywords;

        await PromoVideos.update({
          id: record.id,
          record: {
            contentIndexJson: JSON.stringify(contentIndex),
            indexStatus: 'Indexed',
            keywords: enrichedKw,
          },
        });
        console.log(`${tag} ✅ Deep indexed — ${parsed.segments.length} segments, mode: full`);
      } else {
        throw new Error('Empty segments from GPT');
      }
    } catch (e: any) {
      console.warn(`${tag} ⚠ Deep indexing failed — creating fallback: ${e?.message}`);
      // Fallback: coarse time buckets
      const bucketCount = Math.max(3, Math.min(8, Math.round(durEstimate / 5)));
      const bucketDur = durEstimate / bucketCount;
      const kw = keywords ? keywords.split(',').map(k => k.trim()).filter(Boolean) : [productName ?? rawName];
      const segments = Array.from({ length: bucketCount }, (_, i) => ({
        start: parseFloat((i * bucketDur).toFixed(2)),
        end: parseFloat(((i + 1) * bucketDur).toFixed(2)),
        summary: i === 0 ? `Opening — ${productName}` : `${productName} segment ${i + 1}`,
        featureLabel: productName ?? rawName,
        keywords: kw,
        productEntity: productName ?? rawName,
        visualType: i === 0 ? 'landing_page' : 'feature_demo',
        heroScore: i === 0 ? 70 : 40,
        proofScore: 30,
        embeddingText: `${productName} ${description ?? ''} ${kw.join(' ')}`,
        confidence: 0.2,
      }));
      const fallback = {
        version: 2,
        indexedAt: new Date().toISOString(),
        mode: 'fallback' as const,
        productName: productName ?? rawName,
        segments,
        bestFeatureMoments: segments.length > 1 ? [{ segmentIndex: 1, reason: 'First content segment' }] : [],
        bestProofMoments: [],
        bestHeroMoments: [{ segmentIndex: 0, reason: 'Opening' }],
        totalKeywords: kw,
      };
      await PromoVideos.update({
        id: record.id,
        record: {
          contentIndexJson: JSON.stringify(fallback),
          indexStatus: 'Fallback',
        },
      });
      console.log(`${tag} 📊 Fallback index saved — ${segments.length} coarse segments`);
    }

    const final = await PromoVideos.findOne({ id: record.id });
    return {
      videoId: record.id,
      productName,
      keywords: final?.keywords ?? keywords,
      description,
      indexStatus: final?.indexStatus ?? 'Pending',
    };
  },
});
