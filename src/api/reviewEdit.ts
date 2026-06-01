import { z } from 'zod';
import { createEndpoint, Projects, Shots, PromoVideos, ZiteError } from 'zite-integrations-backend-sdk';
import OpenAI from 'openai';
import {
  PromoVideoEntry, MatchContext, retrieveScreencast,
  buildTacticalPrompt, createSeedanceTask, computeOverlayDelay, WEAK_SCREENCAST_THRESHOLD,
} from '../utils/tacticalBroll';
import { searchPexelsVideo } from '../utils/pexels';

/**
 * Self-review pass — runs AFTER captureShots has assigned real clips and BEFORE
 * the editor/preview opens. The director re-watches its own edit (now that it
 * knows exactly what footage each beat got) and:
 *
 *   1. REVERTS overlays whose visual isn't genuinely accurate to the narration
 *      back to the narrator (always-safe fallback).
 *   2. ADDS a visual to a talking-head beat when an accurate one clearly fits —
 *      a promo screencast or stock clip (free), or an AI-generated situational
 *      clip (respecting the ≤2-generated budget).
 *
 * Cheap and bounded: one review LLM call, then a small number of retrieval /
 * stock / generation actions only for the beats the model flagged.
 */

const MAX_GENERATED_KINOVI = 2;

function describeAssignedVisual(labels: Record<string, any>): { shows: string; source: string; confidence?: number } {
  const track = labels.brollTrack;
  if (track === 'stock') return { shows: `Stock footage: "${labels.stockQuery ?? labels.caption ?? ''}"`, source: 'stock' };
  if (track === 'generated') return { shows: `AI-generated: "${(labels.promptUsed ?? labels.veo3Prompt ?? labels.brollPrompt ?? '').slice(0, 200)}"`, source: 'generated' };
  const seg = labels.segmentSummary ?? labels.matchReason ?? '';
  const conf = typeof labels.retrievalConfidence === 'number' ? labels.retrievalConfidence : undefined;
  return { shows: `Promo footage: "${String(seg).slice(0, 200)}"`, source: 'promo', confidence: conf };
}

const REVIEW_SYSTEM = `You are a senior short-form video editor doing a FINAL ACCURACY REVIEW of your own edit before it ships. You judge each beat and may also IMPROVE the edit.

You are given the full transcript and, per beat: the time, what the NARRATOR says, the current VISUAL (either "narrator" on camera, or an assigned cutaway with what it shows).

For EACH beat return one verdict:
- "keep" — leave the beat exactly as is.
- "revert" — (only for beats that currently have a cutaway) the visual is off-topic / misleading / contradicts the words → drop it and stay on the narrator.
- "add" — (only for beats currently on the narrator) an accurate cutaway clearly belongs here to reinforce the words. Specify what to add:
    "addType": "screencast" (real product/promo footage — use when the line names a product/feature you likely have footage for),
               "stock" (real stock footage of a real-world situation/scene),
               or "generated" (an AI situational clip — use sparingly, only when no real footage could exist).
    "query": 2–5 word concrete, filmable search query (for screencast/stock).
    "brollPrompt": an extensive situational generation prompt (only for "generated").

RULES:
- Accuracy first. If unsure, prefer "keep"/"revert" — staying on the narrator is never wrong.
- Don't over-edit: only "add" when it genuinely strengthens that exact moment. Most narrator beats should stay "keep".
- Never add to the very first hook beat or the final CTA beat.

Return ONLY valid JSON:
{"reviews":[{"shotId":"...","verdict":"keep|revert|add","addType":"screencast|stock|generated","query":"...","brollPrompt":"...","reason":"short reason"}]}`;

export default createEndpoint({
  authenticated: true,
  description: 'AI self-review of the assigned edit: reverts inaccurate overlays and can add accurate screencast/stock/generated visuals before preview.',
  inputSchema: z.object({ projectId: z.string() }),
  outputSchema: z.object({
    reviewed: z.number(),
    reverted: z.number(),
    added:    z.number(),
    kept:     z.number(),
    pendingBroll: z.number(),
  }),
  execute: async ({ input }) => {
    const { projectId } = input;
    const client = new OpenAI({ apiKey: process.env.ZITE_OPENAI_ACCESS_TOKEN });

    const project = await Projects.findOne({ id: projectId });
    if (!project) throw new ZiteError({ code: 'NOT_FOUND', message: 'Project not found' });

    const { records: shots } = await Shots.findAll({ filters: { project: projectId }, limit: 200 });
    const ordered = [...shots].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    if (ordered.length === 0) return { reviewed: 0, reverted: 0, added: 0, kept: 0, pendingBroll: 0 };

    // Promo pool for any "add screencast" actions.
    let promoPool: PromoVideoEntry[] = [];
    try {
      const { records: pv } = await PromoVideos.findAll({ limit: 200 });
      promoPool = pv.filter((r) => r.videoUrl).map((r) => ({
        label: r.productName ?? 'Promo', tags: r.keywords ?? r.productName ?? '',
        url: r.videoUrl!, description: r.description ?? undefined, contentIndexJson: r.contentIndexJson ?? undefined,
      }));
    } catch { /* */ }

    // Count generated clips already used so the budget is honored.
    let generatedUsed = ordered.filter((s) => {
      try { return s.uiLabelsJson && JSON.parse(s.uiLabelsJson).brollTrack === 'generated'; } catch { return false; }
    }).length;
    const usedPromoUrls = new Set<string>(
      ordered.filter((s) => s.shotType === 'Screencast' && s.clipUrl).map((s) => s.clipUrl!),
    );

    const lastIdx = ordered.length - 1;
    const beats = ordered.map((s, i) => {
      let labels: Record<string, any> = {};
      try { if (s.uiLabelsJson) labels = JSON.parse(s.uiLabelsJson); } catch {}
      const hasClip = s.shotType !== 'Talking Head' && !!s.clipUrl;
      const v = hasClip ? describeAssignedVisual(labels) : { shows: 'narrator on camera', source: 'narrator' as const };
      return {
        shotId: s.id,
        position: i === 0 ? 'first/hook' : i === lastIdx ? 'last/cta' : 'body',
        time: `${(s.startTime ?? 0).toFixed(1)}–${(s.endTime ?? 0).toFixed(1)}s`,
        narratorSays: (labels.transcriptSnippet ?? s.caption ?? '').toString().slice(0, 240),
        currentVisual: v.source === 'narrator' ? 'narrator' : `${v.source}: ${v.shows}`,
      };
    });

    let reviews: Array<{ shotId: string; verdict: string; addType?: string; query?: string; brollPrompt?: string; reason?: string }> = [];
    try {
      const res = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: REVIEW_SYSTEM },
          { role: 'user', content: `Video topic: ${project.contextHint ?? project.title ?? ''}\nTranscript:\n${(project.transcript ?? '').toString().slice(0, 4000)}\n\nBeats:\n${JSON.stringify(beats, null, 2)}` },
        ],
        response_format: { type: 'json_object' },
      });
      const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}');
      if (Array.isArray(parsed.reviews)) reviews = parsed.reviews;
    } catch (e: any) {
      console.warn(`[reviewEdit] Review call failed (non-fatal): ${e?.message}`);
      return { reviewed: beats.length, reverted: 0, added: 0, kept: beats.length, pendingBroll: 0 };
    }

    const byId = new Map(reviews.map((r) => [r.shotId, r]));
    let reverted = 0, added = 0, kept = 0, pendingBroll = 0;

    for (const s of ordered) {
      const r = byId.get(s.id);
      let labels: Record<string, any> = {};
      try { if (s.uiLabelsJson) labels = JSON.parse(s.uiLabelsJson); } catch {}
      const hasClip = s.shotType !== 'Talking Head' && !!s.clipUrl;
      const beatDur = Math.max((s.endTime ?? 4) - (s.startTime ?? 0), 1);

      // ── REVERT an inaccurate overlay → narrator ──
      if (r?.verdict === 'revert' && hasClip) {
        await Shots.update({
          id: s.id,
          record: {
            shotType: 'Talking Head', clipUrl: null,
            uiLabelsJson: JSON.stringify({ ...labels, visualIntent: 'talking_head', showNarrator: true, showNarratorFirst: true, overlayDelaySeconds: 0, revertedByReview: true, reviewReason: r.reason ?? 'Inaccurate visual' }),
          },
        });
        console.log(`[reviewEdit] ⤵ Reverted ${(s.startTime ?? 0).toFixed(1)}s → narrator: ${r.reason ?? ''}`);
        reverted++;
        continue;
      }

      // ── ADD an accurate visual to a narrator beat ──
      if (r?.verdict === 'add' && !hasClip) {
        const addType = r.addType ?? 'stock';
        const overlayDelay = computeOverlayDelay(beatDur);
        const baseLabels = { ...labels, reviewAdded: true, reviewReason: r.reason ?? 'Added accurate visual', showNarratorFirst: true, overlayDelaySeconds: overlayDelay };

        // 1) Screencast (promo retrieval)
        if (addType === 'screencast' && promoPool.length > 0) {
          const ctx: MatchContext = { matchKeywords: r.query ? r.query.split(/\s+/) : (labels.matchKeywords ?? []), transcriptSnippet: labels.transcriptSnippet ?? '', productEntity: labels.productEntity, featureEntity: labels.featureEntity };
          const pool = promoPool.filter((p) => !usedPromoUrls.has(p.url));
          const result = await retrieveScreencast(client, r.query ?? s.caption ?? 'product', pool.length ? pool : promoPool, beatDur, `[reviewEdit:${s.id}]`, ctx);
          if (result && result.retrieval.confidence >= WEAK_SCREENCAST_THRESHOLD) {
            usedPromoUrls.add(result.retrieval.url);
            await Shots.update({ id: s.id, record: { shotType: 'Screencast', clipUrl: result.retrieval.url, captureStatus: 'Done', uiLabelsJson: JSON.stringify({ ...baseLabels, ...result.labels, visualIntent: 'screencast' }) } });
            console.log(`[reviewEdit] ⤴ Added screencast at ${(s.startTime ?? 0).toFixed(1)}s: ${r.reason ?? ''}`);
            added++; continue;
          }
        }

        // 2) Stock (Pexels) — for screencast-with-no-match too
        if (addType === 'stock' || addType === 'screencast') {
          const stock = await searchPexelsVideo(r.query ?? s.caption ?? '', beatDur, `[reviewEdit:${s.id}]`);
          if (stock) {
            await Shots.update({ id: s.id, record: { shotType: 'B-Roll', clipUrl: stock.url, captureStatus: 'Done', uiLabelsJson: JSON.stringify({ ...baseLabels, visualIntent: 'tactical_broll', brollTrack: 'stock', brollSource: 'pexels', mediaType: 'video', stockQuery: r.query ?? '' }) } });
            console.log(`[reviewEdit] ⤴ Added stock at ${(s.startTime ?? 0).toFixed(1)}s: "${r.query}"`);
            added++; continue;
          }
        }

        // 3) Generated (Kinovi) — respect the budget
        if (addType === 'generated' && generatedUsed < MAX_GENERATED_KINOVI) {
          const prompt = await buildTacticalPrompt(client, { beatType: labels.beatType ?? 'demo', summary: r.brollPrompt || r.query || s.caption || 'situational scene', transcriptSnippet: labels.transcriptSnippet, matchKeywords: r.query ? r.query.split(/\s+/) : labels.matchKeywords, contextHint: project.contextHint ?? undefined }, `[reviewEdit:${s.id}]`);
          const task = await createSeedanceTask(prompt, Math.max(beatDur, 4), `[reviewEdit:${s.id}]`);
          if (task) {
            generatedUsed++;
            await Shots.update({ id: s.id, record: { shotType: 'B-Roll', captureStatus: 'Capturing', uiLabelsJson: JSON.stringify({ ...baseLabels, visualIntent: 'tactical_broll', brollMode: 'tactical_broll', brollTrack: 'generated', promptUsed: prompt, kinoviTaskId: task.taskId }) } });
            console.log(`[reviewEdit] ⤴ Added generated clip at ${(s.startTime ?? 0).toFixed(1)}s (task ${task.taskId})`);
            added++; pendingBroll++; continue;
          }
        }
        // Couldn't fulfill the add — leave on narrator.
        kept++;
        continue;
      }

      kept++;
    }

    // If we queued any new generated clips, the project is rendering b-roll again.
    if (pendingBroll > 0) {
      await Projects.update({ id: projectId, record: { status: 'Capturing' } });
    }

    console.log(`[reviewEdit] Reviewed ${beats.length} — kept ${kept}, reverted ${reverted}, added ${added} (pendingBroll ${pendingBroll})`);
    return { reviewed: beats.length, reverted, added, kept, pendingBroll };
  },
});
