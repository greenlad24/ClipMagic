import { z } from 'zod';
import { createEndpoint, Shots, PromoVideos, Projects, ZiteError } from 'zite-integrations-backend-sdk';
import OpenAI from 'openai';
import {
  PromoVideoEntry, MatchContext, TacticalBrollMetadata,
  retrieveScreencast, evaluateTacticalBrollGuard,
  buildTacticalPrompt, createSeedanceTask,
  WEAK_SCREENCAST_THRESHOLD,
} from '../utils/tacticalBroll';

// ── Endpoint ──────────────────────────────────────────────────────────────────

export default createEndpoint({
  authenticated: true,
  description: 'Re-capture a single shot. Screencast-first with segment-level retrieval + narrator-first pacing. B-Roll creates Kinovi task — poll via pollBrollStatus.',
  inputSchema: z.object({ shotId: z.string() }),
  outputSchema: z.object({
    success:      z.boolean(),
    clipUrl:      z.string().optional(),
    kinoviTaskId: z.string().optional(),
  }),
  execute: async ({ input }) => {
    const shot = await Shots.findOne({ id: input.shotId });
    if (!shot) throw new ZiteError({ code: 'NOT_FOUND', message: 'Shot not found' });

    const tag = `[recaptureShot:${input.shotId}]`;
    console.log(`${tag} Starting — shotType: "${shot.shotType}", caption: "${(shot.caption ?? '').slice(0, 60)}"`);

    if (shot.shotType === 'Talking Head') {
      await Shots.update({ id: input.shotId, record: { captureStatus: 'Done' } });
      return { success: true };
    }

    await Shots.update({ id: input.shotId, record: { captureStatus: 'Capturing' } });

    let promoPool: PromoVideoEntry[] = [];
    try {
      const { records } = await PromoVideos.findAll({ limit: 200 });
      promoPool = records.filter((r) => r.videoUrl).map((r) => ({
        label: r.productName ?? 'Promo', tags: r.keywords ?? r.productName ?? '', url: r.videoUrl!, description: r.description ?? undefined, contentIndexJson: r.contentIndexJson ?? undefined,
      }));
      console.log(`${tag} Loaded ${promoPool.length} promo videos`);
    } catch (e: any) { console.warn(`${tag} Failed to load promo pool: ${e?.message}`); }

    // Load project context for tactical prompt building
    let contextHint: string | undefined;
    const projectId = Array.isArray(shot.project) ? shot.project[0] : shot.project;
    if (projectId) {
      try {
        const proj = await Projects.findOne({ id: projectId });
        contextHint = proj?.contextHint ?? undefined;
      } catch { /* non-fatal */ }
    }

    try {
      const client = new OpenAI({ apiKey: process.env.ZITE_OPENAI_ACCESS_TOKEN });

      // ── Screencast ─────────────────────────────────────────────────────────
      if (shot.shotType === 'Screencast') {
        const usedPromoUrls = new Set<string>();
        if (projectId) {
          try {
            const { records: projectShots } = await Shots.findAll({ filters: { project: projectId }, limit: 200 });
            for (const s of projectShots) {
              if (s.shotType === 'Screencast' && s.clipUrl && s.id !== input.shotId) usedPromoUrls.add(s.clipUrl);
            }
            console.log(`${tag} Dedup: ${usedPromoUrls.size} URLs already used in project`);
          } catch (e: any) { console.warn(`${tag} Could not load project shots: ${e?.message}`); }
        }

        let existingLabels: Record<string, any> = {};
        try { if (shot.uiLabelsJson) existingLabels = JSON.parse(shot.uiLabelsJson); } catch {}
        const caption = shot.caption ?? shot.targetUrl ?? 'product demonstration';
        const beatDur = Math.max((shot.endTime ?? 4) - (shot.startTime ?? 0), 1);

        // ── Detect post-tactical-broll context ────────────────────────────
        let followsRequiredTacticalBroll = existingLabels.followsRequiredTacticalBroll === true;
        const intendedRole: 'proof' | 'demo' | 'workflow' | undefined = existingLabels.intendedRole ?? undefined;
        if (!followsRequiredTacticalBroll && projectId) {
          try {
            const { records: projectShots } = await Shots.findAll({ filters: { project: projectId }, limit: 200 });
            const sorted = projectShots.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
            const myIdx = sorted.findIndex(s => s.id === input.shotId);
            if (myIdx > 0) {
              const prev = sorted[myIdx - 1];
              let prevLabels: Record<string, any> = {};
              try { if (prev.uiLabelsJson) prevLabels = JSON.parse(prev.uiLabelsJson); } catch {}
              if (prev.shotType === 'B-Roll' && prevLabels.isRequiredTacticalBroll === true) {
                followsRequiredTacticalBroll = true;
                console.log(`${tag} 📌 Detected: this Screencast follows the required tactical B-roll opening (shot ${prev.id})`);
              }
            }
          } catch (e: any) { console.warn(`${tag} Could not check preceding shots: ${e?.message}`); }
        }
        if (followsRequiredTacticalBroll) {
          console.log(`${tag} 🎯 Post-tactical-broll Screencast — biasing toward proof/demo retrieval (role=${intendedRole ?? 'proof'})`);
        }

        const ctx: MatchContext = {
          targetUrl: shot.targetUrl ?? undefined,
          matchKeywords: Array.isArray(existingLabels.matchKeywords) ? existingLabels.matchKeywords : [],
          transcriptSnippet: existingLabels.transcriptSnippet ?? '',
          productEntity: existingLabels.productEntity ?? undefined,
          featureEntity: existingLabels.featureEntity ?? undefined,
          followsRequiredTacticalBroll,
          intendedRole,
        };

        let availablePool = promoPool.filter(p => !usedPromoUrls.has(p.url));
        if (availablePool.length === 0 && promoPool.length > 0) { console.warn(`${tag} All promos used — reusing from full pool`); availablePool = promoPool; }

        const result = await retrieveScreencast(client, caption, availablePool, beatDur, tag, ctx);
        if (result) {
          // Quality gate
          if (result.retrieval.confidence < WEAK_SCREENCAST_THRESHOLD) {
            console.log(`${tag} ⚠ Weak Screencast (conf=${result.retrieval.confidence.toFixed(2)}) → Talking Head`);
            await Shots.update({
              id: input.shotId,
              record: {
                shotType: 'Talking Head',
                captureStatus: 'Done',
                uiLabelsJson: JSON.stringify({ ...existingLabels, convertedFrom: 'Screencast', conversionReason: `Weak retrieval (confidence ${result.retrieval.confidence.toFixed(2)})` }),
              },
            });
            return { success: true };
          }

          await Shots.update({
            id: input.shotId,
            record: { clipUrl: result.retrieval.url, captureStatus: 'Done', uiLabelsJson: JSON.stringify({ ...existingLabels, ...result.labels }) },
          });
          console.log(`${tag} ✅ Screencast done — ${result.retrieval.url}, offset: ${result.labels.clipStartOffset}s, delay: ${result.labels.overlayDelaySeconds}s, conf: ${result.retrieval.confidence.toFixed(2)}`);
          return { success: true, clipUrl: result.retrieval.url };
        } else {
          await Shots.update({ id: input.shotId, record: { captureStatus: 'Error' } });
          throw new ZiteError({ code: 'NOT_FOUND', message: 'No matching promo video found. Upload promo videos to the library first.' });
        }
      }

      // ── B-Roll: tactical guard + Kinovi task ──────────────────────────────
      if (shot.shotType === 'B-Roll') {
        let existingLabels: Record<string, any> = {};
        try { if (shot.uiLabelsJson) existingLabels = JSON.parse(shot.uiLabelsJson); } catch {}

        const guard = evaluateTacticalBrollGuard(existingLabels, promoPool.length, tag);

        if (!guard.allowed) {
          console.log(`${tag} ⛔ Tactical guard REJECTED B-Roll: ${guard.reason}`);
          if (promoPool.length > 0) {
            const caption = shot.caption ?? 'product demonstration';
            const beatDur = Math.max((shot.endTime ?? 4) - (shot.startTime ?? 0), 1);
            const ctx: MatchContext = {
              matchKeywords: Array.isArray(existingLabels.matchKeywords) ? existingLabels.matchKeywords : [],
              transcriptSnippet: existingLabels.transcriptSnippet ?? '',
              productEntity: existingLabels.productEntity ?? undefined,
              featureEntity: existingLabels.featureEntity ?? undefined,
            };
            const result = await retrieveScreencast(client, caption, promoPool, beatDur, tag, ctx);
            if (result && result.retrieval.confidence >= WEAK_SCREENCAST_THRESHOLD) {
              await Shots.update({
                id: input.shotId,
                record: {
                  shotType: 'Screencast',
                  clipUrl: result.retrieval.url,
                  captureStatus: 'Done',
                  uiLabelsJson: JSON.stringify({ ...existingLabels, ...result.labels, convertedFrom: 'B-Roll', conversionReason: guard.reason }),
                },
              });
              console.log(`${tag} ✅ Converted B-Roll → Screencast: ${result.retrieval.url} conf=${result.retrieval.confidence.toFixed(2)}`);
              return { success: true, clipUrl: result.retrieval.url };
            }
          }
          // Fallback: Talking Head
          await Shots.update({
            id: input.shotId,
            record: {
              shotType: 'Talking Head',
              captureStatus: 'Done',
              uiLabelsJson: JSON.stringify({ ...existingLabels, convertedFrom: 'B-Roll', conversionReason: guard.reason }),
            },
          });
          console.log(`${tag} ✅ Converted B-Roll → Talking Head`);
          return { success: true };
        }

        // Guard passed — build tactical prompt
        console.log(`${tag} ✅ Tactical guard ALLOWED: ${guard.reason}`);
        const brollCtx = {
          beatType: existingLabels.beatType ?? 'demo',
          summary: existingLabels.veo3Prompt ?? shot.caption ?? 'Cinematic environment',
          emotionalIntent: existingLabels.emotionalIntent,
          transcriptSnippet: existingLabels.transcriptSnippet,
          matchKeywords: existingLabels.matchKeywords,
          contextHint,
          showNarrator: existingLabels.showNarrator,
          overlayDelaySeconds: existingLabels.overlayDelaySeconds,
        };

        const tacticalPrompt = await buildTacticalPrompt(client, brollCtx, tag);
        const clipDur = Math.max((shot.endTime ?? 4) - (shot.startTime ?? 0), 4);
        const result = await createSeedanceTask(tacticalPrompt, clipDur, tag);

        if (result) {
          const meta: TacticalBrollMetadata = {
            brollMode: 'tactical_broll',
            brollReason: guard.reason,
            avoidedScreencastBecause: guard.avoidedScreencastBecause,
            promptUsed: tacticalPrompt,
            overlayDelaySeconds: existingLabels.overlayDelaySeconds ?? 1.0,
            showNarratorFirst: existingLabels.showNarratorFirst ?? true,
            kinoviTaskId: result.taskId,
            brollTrack: 'generated',
          };
          await Shots.update({
            id: input.shotId,
            record: {
              captureStatus: 'Capturing',
              uiLabelsJson: JSON.stringify({ ...existingLabels, ...meta }),
            },
          });
          console.log(`${tag} ✅ Tactical B-Roll task created — ID: ${result.taskId}`);
          return { success: true, kinoviTaskId: result.taskId };
        } else {
          await Shots.update({ id: input.shotId, record: { captureStatus: 'Error' } });
          throw new ZiteError({ code: 'INTERNAL_ERROR', message: 'Seedance 2.0 task creation failed — check endpoint logs.' });
        }
      }

      await Shots.update({ id: input.shotId, record: { captureStatus: 'Error' } });
      return { success: false };
    } catch (err: any) {
      if (err?.code) throw err;
      console.error(`${tag} Unexpected error: ${err?.message ?? err}`);
      await Shots.update({ id: input.shotId, record: { captureStatus: 'Error' } }).catch(() => {});
      throw new ZiteError({ code: 'INTERNAL_ERROR', message: err?.message ?? 'Unexpected error during re-capture' });
    }
  },
});
