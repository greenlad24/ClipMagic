import { z } from 'zod';
import { createEndpoint, Projects, Shots, PromoVideos, ZiteError } from 'zite-integrations-backend-sdk';
import OpenAI from 'openai';
import {
  PromoVideoEntry, MatchContext, TacticalBrollMetadata, ScreencastLabels,
  retrieveScreencast, matchPromoWithSegments, evaluateTacticalBrollGuard,
  buildTacticalPrompt, createSeedanceTask, computeOverlayDelay,
  WEAK_SCREENCAST_THRESHOLD,
} from '../utils/tacticalBroll';

const BATCH = 3;

// ── Endpoint ──────────────────────────────────────────────────────────────────

export default createEndpoint({
  authenticated: true,
  description: 'Capture media for all shots. Screencast-first with segment-level retrieval + narrator-first pacing. B-Roll creates Kinovi task — frontend polls pollBrollStatus.',
  inputSchema: z.object({ projectId: z.string() }),
  outputSchema: z.object({
    success:      z.boolean(),
    captured:     z.number(),
    mediaGenerated: z.number(),
    failed:       z.number(),
    pendingBroll: z.number(),
  }),
  execute: async ({ input }) => {
    const { projectId } = input;
    const client = new OpenAI({ apiKey: process.env.ZITE_OPENAI_ACCESS_TOKEN });

    const project = await Projects.findOne({ id: projectId });
    if (!project) throw new ZiteError({ code: 'NOT_FOUND', message: 'Project not found' });
    console.log(`[captureShots] Starting for project ${projectId}`);

    // Load promo video pool
    let promoPool: PromoVideoEntry[] = [];
    try {
      const { records: pvRecords } = await PromoVideos.findAll({ limit: 200 });
      promoPool = pvRecords.filter((r) => r.videoUrl).map((r) => ({
        label: r.productName ?? 'Promo',
        tags: r.keywords ?? r.productName ?? '',
        url: r.videoUrl!,
        description: r.description ?? undefined,
        contentIndexJson: r.contentIndexJson ?? undefined,
      }));
      console.log(`[captureShots] Loaded ${promoPool.length} promo videos`);
    } catch (e: any) {
      console.warn(`[captureShots] Failed to load promo pool: ${e?.message}`);
    }

    const { records: shots } = await Shots.findAll({ filters: { project: projectId }, limit: 200 });
    console.log(`[captureShots] Processing ${shots.length} shots`);

    // ── Pre-assign Screencast shots (sequential, dedup-aware) ─────────────────
    const usedPromoUrls = new Set<string>(
      shots.filter(s => s.shotType === 'Screencast' && s.captureStatus === 'Done' && s.clipUrl).map(s => s.clipUrl!)
    );

    const screenshotPending = shots
      .filter(s => s.shotType === 'Screencast' && s.captureStatus !== 'Done')
      .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));

    type Assignment = { url: string; labels: ScreencastLabels; confidence: number };
    const screenshotAssignments = new Map<string, Assignment>();

    for (const shot of screenshotPending) {
      let existingLabels: Record<string, any> = {};
      try { if (shot.uiLabelsJson) existingLabels = JSON.parse(shot.uiLabelsJson); } catch {}

      const caption = shot.caption ?? shot.targetUrl ?? 'product demonstration';
      const beatDur = Math.max((shot.endTime ?? 4) - (shot.startTime ?? 0), 1);
      const ctx: MatchContext = {
        targetUrl: shot.targetUrl ?? undefined,
        matchKeywords: Array.isArray(existingLabels.matchKeywords) ? existingLabels.matchKeywords : [],
        transcriptSnippet: existingLabels.transcriptSnippet ?? '',
        productEntity: existingLabels.productEntity ?? undefined,
        featureEntity: existingLabels.featureEntity ?? undefined,
      };

      let availablePool = promoPool.filter(p => !usedPromoUrls.has(p.url));
      if (availablePool.length === 0 && promoPool.length > 0) {
        console.warn(`[captureShots:${shot.id}] All ${promoPool.length} promo videos already used — reusing from full pool`);
        availablePool = promoPool;
      }

      const result = await retrieveScreencast(client, caption, availablePool, beatDur, `[captureShots:${shot.id}]`, ctx);
      if (result) {
        usedPromoUrls.add(result.retrieval.url);
        screenshotAssignments.set(shot.id, { url: result.retrieval.url, labels: result.labels, confidence: result.retrieval.confidence });
        console.log(`[captureShots:${shot.id}] Pre-assigned: "${result.retrieval.label}" [${result.labels.clipStartOffset}s–${result.labels.clipEndOffset}s] conf=${result.retrieval.confidence.toFixed(2)} delay=${result.labels.overlayDelaySeconds}s`);
      }
    }

    let captured = 0, mediaGenerated = 0, failed = 0, pendingBroll = 0;
    let tacticalBrollCount = 0;

    for (let i = 0; i < shots.length; i += BATCH) {
      const batch = shots.slice(i, i + BATCH);
      await Promise.all(batch.map(async (shot) => {
        const tag = `[captureShots:${shot.id}]`;

        if (shot.captureStatus === 'Done') { captured++; return; }

        if (shot.shotType === 'Talking Head') {
          await Shots.update({ id: shot.id, record: { captureStatus: 'Done' } });
          captured++;
          return;
        }

        console.log(`${tag} Processing "${shot.shotType}" — caption: "${(shot.caption ?? '').slice(0, 60)}"`);
        await Shots.update({ id: shot.id, record: { captureStatus: 'Capturing' } });

        try {
          // ── Screencast: use pre-assigned retrieval ───────────────────────────
          if (shot.shotType === 'Screencast') {
            const assignment = screenshotAssignments.get(shot.id);
            if (assignment) {
              // Quality gate: if confidence is too low, prefer Talking Head
              if (assignment.confidence < WEAK_SCREENCAST_THRESHOLD) {
                console.log(`${tag} ⚠ Weak Screencast (conf=${assignment.confidence.toFixed(2)}) → converting to Talking Head`);
                let existingLabels: Record<string, any> = {};
                try { if (shot.uiLabelsJson) existingLabels = JSON.parse(shot.uiLabelsJson); } catch {}
                await Shots.update({
                  id: shot.id,
                  record: {
                    shotType: 'Talking Head',
                    captureStatus: 'Done',
                    uiLabelsJson: JSON.stringify({ ...existingLabels, convertedFrom: 'Screencast', conversionReason: `Weak retrieval (confidence ${assignment.confidence.toFixed(2)})` }),
                  },
                });
                captured++;
                return;
              }

              let existingLabels: Record<string, any> = {};
              try { if (shot.uiLabelsJson) existingLabels = JSON.parse(shot.uiLabelsJson); } catch {}
              await Shots.update({
                id: shot.id,
                record: {
                  clipUrl: assignment.url,
                  captureStatus: 'Done',
                  uiLabelsJson: JSON.stringify({ ...existingLabels, ...assignment.labels }),
                },
              });
              console.log(`${tag} ✅ Screencast done — clipUrl: ${assignment.url}, offset: ${assignment.labels.clipStartOffset}s, delay: ${assignment.labels.overlayDelaySeconds}s, conf: ${assignment.confidence.toFixed(2)}`);
              captured++;
              mediaGenerated++;
            } else {
              console.warn(`${tag} Screencast: no pre-assigned promo — marking as Error`);
              await Shots.update({ id: shot.id, record: { captureStatus: 'Error' } });
              failed++;
            }
            return;
          }

          // ── B-Roll: tactical guard + Kinovi task ─────────────────────────────
          if (shot.shotType === 'B-Roll') {
            let existingLabels: Record<string, any> = {};
            try { if (shot.uiLabelsJson) existingLabels = JSON.parse(shot.uiLabelsJson); } catch {}

            // Tactical guard
            const guard = evaluateTacticalBrollGuard(existingLabels, promoPool.length, tag);

            if (!guard.allowed) {
              console.log(`${tag} ⛔ Tactical guard REJECTED B-Roll: ${guard.reason}`);
              // Try converting to Screencast via retrieval
              if (promoPool.length > 0) {
                const caption = shot.caption ?? 'product demonstration';
                const beatDur = Math.max((shot.endTime ?? 4) - (shot.startTime ?? 0), 1);
                const ctx: MatchContext = {
                  matchKeywords: Array.isArray(existingLabels.matchKeywords) ? existingLabels.matchKeywords : [],
                  transcriptSnippet: existingLabels.transcriptSnippet ?? '',
                  productEntity: existingLabels.productEntity ?? undefined,
                  featureEntity: existingLabels.featureEntity ?? undefined,
                };
                let availPool = promoPool.filter(p => !usedPromoUrls.has(p.url));
                if (availPool.length === 0) availPool = promoPool;
                const result = await retrieveScreencast(client, caption, availPool, beatDur, tag, ctx);
                if (result && result.retrieval.confidence >= WEAK_SCREENCAST_THRESHOLD) {
                  usedPromoUrls.add(result.retrieval.url);
                  await Shots.update({
                    id: shot.id,
                    record: {
                      shotType: 'Screencast',
                      clipUrl: result.retrieval.url,
                      captureStatus: 'Done',
                      uiLabelsJson: JSON.stringify({ ...existingLabels, ...result.labels, convertedFrom: 'B-Roll', conversionReason: guard.reason }),
                    },
                  });
                  console.log(`${tag} ✅ Converted B-Roll → Screencast: ${result.retrieval.url} conf=${result.retrieval.confidence.toFixed(2)}`);
                  captured++;
                  mediaGenerated++;
                  return;
                }
              }
              // No confident real-footage match. The director deliberately
              // planned a visual here for the "constant movement" rhythm, so
              // GENERATE a situational clip rather than downgrading to a static
              // talking head (which would remove the planned movement).
              console.log(`${tag} No confident screencast match — generating director-planned situational clip instead of holding on narrator`);
              // (fall through to the generation path below)
            } else {
              console.log(`${tag} ✅ Tactical guard ALLOWED: ${guard.reason}`);
            }

            // ── Generation path (guard allowed, OR rejected-but-no-screencast) ──
            const brollCtx = {
              beatType: existingLabels.beatType ?? 'demo',
              summary: existingLabels.veo3Prompt ?? shot.caption ?? 'Cinematic environment',
              emotionalIntent: existingLabels.emotionalIntent,
              transcriptSnippet: existingLabels.transcriptSnippet,
              matchKeywords: existingLabels.matchKeywords,
              contextHint: project.contextHint ?? undefined,
              showNarrator: existingLabels.showNarrator,
              overlayDelaySeconds: existingLabels.overlayDelaySeconds,
            };

            const tacticalPrompt = await buildTacticalPrompt(client, brollCtx, tag);
            const clipDur = Math.max((shot.endTime ?? 4) - (shot.startTime ?? 0), 4);
            const result = await createSeedanceTask(tacticalPrompt, clipDur, tag);

            if (result) {
              tacticalBrollCount++;
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
                id: shot.id,
                record: {
                  captureStatus: 'Capturing',
                  uiLabelsJson: JSON.stringify({ ...existingLabels, ...meta }),
                },
              });
              console.log(`${tag} ✅ Tactical B-Roll task created — ID: ${result.taskId}`);
              mediaGenerated++;
              pendingBroll++;
            } else {
              console.warn(`${tag} Seedance task creation failed — marking as Error`);
              await Shots.update({ id: shot.id, record: { captureStatus: 'Error' } });
              failed++;
            }
            return;
          }

          // Unrecognised shot type
          await Shots.update({ id: shot.id, record: { captureStatus: 'Error' } });
          failed++;
        } catch (err: any) {
          console.error(`${tag} Unexpected error: ${err?.message ?? err}`);
          await Shots.update({ id: shot.id, record: { captureStatus: 'Error' } });
          failed++;
        }
      }));
    }

    console.log(`[captureShots] Finished — captured: ${captured}, mediaGenerated: ${mediaGenerated}, failed: ${failed}, pendingBroll: ${pendingBroll}, tacticalBrollCount: ${tacticalBrollCount}`);

    if (pendingBroll === 0) {
      await Projects.update({ id: projectId, record: { status: 'Complete' } });
    }

    return { success: true, captured, mediaGenerated, failed, pendingBroll };
  },
});
