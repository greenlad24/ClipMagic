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

const REVIEW_SYSTEM = `You are a senior editor doing a FINAL QUALITY-CONTROL PASS on an edit that is already good. Your job is NOT to re-edit it — it is to catch the FEW CRITICAL MISTAKES and leave everything else alone.

You are given the full transcript and, per beat: the time, what the NARRATOR says, and the current VISUAL (either "narrator" on camera, or an assigned cutaway with what it shows).

DEFAULT TO "keep". The vast majority of beats — almost all of them — should be "keep". Only intervene on a CRITICAL MISMATCH, defined as:
  • the visual clearly CONTRADICTS or is unrelated to what the narrator is saying (e.g. footage of the wrong product/place/subject), or
  • a clearly WRONG/confusing clip that would make a viewer go "that doesn't match".
Stylistic preferences, "could be slightly better", pacing nitpicks, or a merely-okay-but-fine clip are NOT reasons to change anything → "keep".

Verdicts:
- "keep" — leave the beat exactly as is. (Use this for nearly everything — typically 90%+ of beats.)
- "replace" — PREFERRED fix for a critical mismatch: swap in a better, accurate cutaway (provide addType + query). Keep the beat VISUAL — do not drop to narrator.
- "revert" — LAST RESORT, and ONLY for a stock/generated b-roll clip that is critically wrong AND has no better replacement. NEVER revert a PROMO/SCREENCAST (product footage) — if a promo is wrong, use "replace", never "revert".
- "add" — RARE: only when a beat is on the narrator AND a critical, obviously-missing visual belongs there. Do not add for general "more motion".
    "addType": "screencast" (AI-tech / product footage) | "stock" (people/situations) | "generated" (sparingly).
    "query": 2–5 word concrete, filmable query inheriting the overall video's context (encode place/demographic/setting so generic words aren't ambiguous).
    "brollPrompt": extensive generation prompt (only for "generated").

HARD RULES:
- Aim to change as FEW beats as possible. If you're unsure, "keep". A clip that is on-topic and reasonable = "keep", even if not perfect.
- UNIQUENESS: the same clip must NEVER appear twice in the video. If two beats show the same visual, "replace" the later one with a different relevant clip.
- NEVER turn a product/promo/screencast beat into the narrator. Prefer "replace" over "revert" everywhere; "revert" is only for a clearly-wrong stock/generated clip.
- Never touch the hook beat or the final CTA beat.
- "critical mismatch" means the footage is about a DIFFERENT subject/product/place than the words — not "could be a bit more relevant".
- Do not revert a promo clip just because another clip might be marginally better — only on a real mismatch.

Return ONLY valid JSON:
{"reviews":[{"shotId":"...","verdict":"keep|revert|replace|add","addType":"screencast|stock|generated","query":"...","brollPrompt":"...","reason":"short reason"}]}`;

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

    // ── Uniqueness pass (deterministic): no clip may appear twice ─────────────
    // The reviewer must ensure every b-roll/screencast is UNIQUE. Scan overlays
    // in order; the first use of a clip is kept, any later duplicate is replaced
    // with a fresh clip (a new unique Pexels stock, or a different promo).
    let dedup = 0;
    {
      const seen = new Set<string>();
      for (const s of ordered) {
        if (s.shotType === 'Talking Head' || !s.clipUrl) continue;
        let labels: Record<string, any> = {};
        try { if (s.uiLabelsJson) labels = JSON.parse(s.uiLabelsJson); } catch {}
        if (!seen.has(s.clipUrl)) { seen.add(s.clipUrl); usedPromoUrls.add(s.clipUrl); continue; }

        // Duplicate — find a unique replacement.
        const beatDur = Math.max((s.endTime ?? 4) - (s.startTime ?? 0), 1);
        const isStock = labels.brollTrack === 'stock';
        const isPromo = s.shotType === 'Screencast' || labels.visualIntent === 'screencast';
        let replaced = false;

        if (isPromo && promoPool.length > 0) {
          // Try a different promo not yet used.
          const ctx: MatchContext = { matchKeywords: Array.isArray(labels.matchKeywords) ? labels.matchKeywords : [], transcriptSnippet: labels.transcriptSnippet ?? '', productEntity: labels.productEntity, featureEntity: labels.featureEntity };
          const pool = promoPool.filter((p) => !usedPromoUrls.has(p.url));
          if (pool.length > 0) {
            const result = await retrieveScreencast(client, labels.transcriptSnippet ?? s.caption ?? 'product', pool, beatDur, `[reviewEdit:dedup:${s.id}]`, ctx);
            if (result && result.retrieval.confidence >= WEAK_SCREENCAST_THRESHOLD && !seen.has(result.retrieval.url)) {
              usedPromoUrls.add(result.retrieval.url); seen.add(result.retrieval.url);
              await Shots.update({ id: s.id, record: { clipUrl: result.retrieval.url, uiLabelsJson: JSON.stringify({ ...labels, ...result.labels, dedupReplaced: true }) } });
              console.log(`[reviewEdit] 🔁 De-duplicated promo at ${(s.startTime ?? 0).toFixed(1)}s → ${result.retrieval.url}`);
              dedup++; replaced = true;
            }
          }
        }
        if (!replaced && (isStock || !isPromo)) {
          // Fetch a fresh unique stock clip for the same query.
          const q = labels.stockQuery || labels.transcriptSnippet || s.caption || '';
          const stock = await searchPexelsVideo(q, beatDur, `[reviewEdit:dedup:${s.id}]`, seen);
          if (stock && !seen.has(stock.url)) {
            seen.add(stock.url); usedPromoUrls.add(stock.url);
            await Shots.update({ id: s.id, record: { clipUrl: stock.url, uiLabelsJson: JSON.stringify({ ...labels, brollTrack: 'stock', brollSource: 'pexels', mediaType: 'video', stockQuery: q, dedupReplaced: true }) } });
            console.log(`[reviewEdit] 🔁 De-duplicated stock at ${(s.startTime ?? 0).toFixed(1)}s → ${stock.url}`);
            dedup++; replaced = true;
          }
        }
        if (!replaced) {
          // No unique replacement found — drop this duplicate to the narrator so
          // the same clip doesn't show twice (only for non-promo; promos never
          // revert, so keep it as a last resort but flag it).
          if (isPromo) {
            console.warn(`[reviewEdit] ⚠ Duplicate promo at ${(s.startTime ?? 0).toFixed(1)}s — no alternative; keeping (promos never revert)`);
            seen.add(s.clipUrl);
          } else {
            await Shots.update({ id: s.id, record: { shotType: 'Talking Head', clipUrl: null, uiLabelsJson: JSON.stringify({ ...labels, visualIntent: 'talking_head', showNarrator: true, overlayDelaySeconds: 0, dedupRevert: true }) } });
            console.log(`[reviewEdit] ⤵ Duplicate b-roll at ${(s.startTime ?? 0).toFixed(1)}s — no unique replacement, reverted to narrator`);
            dedup++;
          }
        }
      }
    }

    // Reload after dedup so the relevance review sees the updated clips.
    if (dedup > 0) {
      const fresh = await Shots.findAll({ filters: { project: projectId }, limit: 200 });
      ordered.length = 0;
      ordered.push(...[...fresh.records].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0)));
    }

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
      // RULE: a chosen PROMO/SCREENCAST is never reverted to the narrator (it
      // was chosen for a reason — rule 4). If the reviewer flags a promo as a
      // mismatch, we REPLACE it with a better clip if it provided one, but we
      // never drop it back to the narrator. Only stock/generated b-roll may
      // revert, and only on a genuine critical mismatch.
      const isPromoShot = s.shotType === 'Screencast' || labels.brollTrack === 'promo' || labels.visualIntent === 'screencast';
      if (r?.verdict === 'revert' && hasClip) {
        if (isPromoShot) {
          console.log(`[reviewEdit] ⛔ Ignored revert of PROMO at ${(s.startTime ?? 0).toFixed(1)}s (promos never revert to narrator)`);
          kept++;
          continue;
        }
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

      // ── ADD a visual to a narrator beat, or REPLACE a mismatched clip ──
      if ((r?.verdict === 'add' && !hasClip) || r?.verdict === 'replace') {
        const addType = r.addType ?? 'stock';
        // Enforce the minimum-visible rule on review-added/replaced overlays too
        // (these bypass the planning-stage guardrail). Promos need >=3s visible
        // (>=2s hard floor), stock >=1.6s — cap the narrator-first delay so the
        // clip is actually on screen long enough.
        const minVisible = addType === 'screencast' ? 3.0 : 1.6;
        let overlayDelay = computeOverlayDelay(beatDur);
        if (beatDur - overlayDelay < minVisible) {
          overlayDelay = Math.max(0, beatDur - minVisible);
        }
        const baseLabels = { ...labels, reviewAdded: true, reviewReason: r.reason ?? 'Added accurate visual', showNarratorFirst: overlayDelay > 0.05, overlayDelaySeconds: parseFloat(overlayDelay.toFixed(2)) };

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

    console.log(`[reviewEdit] Reviewed ${beats.length} — kept ${kept}, reverted ${reverted}, added ${added}, de-duplicated ${dedup} (pendingBroll ${pendingBroll})`);
    return { reviewed: beats.length, reverted, added, kept, pendingBroll };
  },
});
