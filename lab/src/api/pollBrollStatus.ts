import { z } from 'zod';
import { createEndpoint, Shots, Projects } from 'zite-integrations-backend-sdk';

/**
 * Single-pass B-Roll status checker. Called by the frontend every 5s after captureShots returns.
 * Makes one Kinovi API call per pending shot — no polling loop — returns in seconds.
 */
export default createEndpoint({
  authenticated: true,
  description: 'Check Kinovi task status for all B-Roll shots still in Capturing state. Single pass — no polling loop.',
  inputSchema: z.object({ projectId: z.string() }),
  outputSchema: z.object({
    pending: z.number(),
    done:    z.number(),
    failed:  z.number(),
  }),
  execute: async ({ input }) => {
    const { projectId } = input;
    const apiKey = (process.env.ZITE_KINOVI_API_KEY ?? '').trim();

    const { records: shots } = await Shots.findAll({ filters: { project: projectId }, limit: 200 });

    const capturingBroll = shots.filter(
      (s) => s.shotType === 'B-Roll' && s.captureStatus === 'Capturing',
    );

    if (!capturingBroll.length) {
      // Nothing pending — ensure project is marked Complete
      await Projects.update({ id: projectId, record: { status: 'Complete' } });
      return { pending: 0, done: 0, failed: 0 };
    }

    let done = 0, failed = 0, pending = 0;

    await Promise.all(capturingBroll.map(async (shot) => {
      const tag = `[pollBrollStatus:${shot.id}]`;
      let existingLabels: Record<string, any> = {};
      try { if (shot.uiLabelsJson) existingLabels = JSON.parse(shot.uiLabelsJson); } catch {}

      const taskId = existingLabels.kinoviTaskId;

      if (!taskId || !apiKey) {
        console.warn(`${tag} No kinoviTaskId stored — marking Error`);
        await Shots.update({ id: shot.id, record: { captureStatus: 'Error' } });
        failed++;
        return;
      }

      try {
        const pr = await fetch(`https://kinovi.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const rawText = await pr.text().catch(() => '(unreadable body)');
        console.log(`${tag} Poll — HTTP ${pr.status} | ${rawText.slice(0, 300)}`);

        if (!pr.ok) { pending++; return; }

        let pd: {
          status?: string; state?: string;
          video_url?: string; videoUrl?: string; output_url?: string;
          output?: Array<{ url?: string }> | { url?: string };
        } = {};
        try { pd = JSON.parse(rawText); } catch { pending++; return; }

        const st = (pd.status ?? pd.state ?? '').toLowerCase();
        const outputUrl = Array.isArray(pd.output) ? pd.output[0]?.url : (pd.output as any)?.url;
        const vu = pd.video_url ?? pd.videoUrl ?? pd.output_url ?? outputUrl;

        if (st === 'success' && vu) {
          await Shots.update({
            id: shot.id,
            record: {
              clipUrl: vu,
              captureStatus: 'Done',
              uiLabelsJson: JSON.stringify({ ...existingLabels, brollTrack: 'generated' }),
            },
          });
          console.log(`${tag} ✅ Done — clipUrl: ${vu}`);
          done++;
        } else if (st === 'fail') {
          await Shots.update({ id: shot.id, record: { captureStatus: 'Error' } });
          console.warn(`${tag} ❌ Kinovi reported failure`);
          failed++;
        } else {
          // Still processing (queued, processing, etc.)
          console.log(`${tag} ⏳ Still processing — status: "${st}"`);
          pending++;
        }
      } catch (e: any) {
        console.error(`${tag} Fetch error: ${e?.message}`);
        pending++; // Transient error — keep retrying
      }
    }));

    // When all resolved, mark project Complete so the status badge updates
    if (pending === 0) {
      await Projects.update({ id: projectId, record: { status: 'Complete' } });
      console.log(`[pollBrollStatus] All B-Roll shots resolved — project marked Complete`);
    }

    console.log(`[pollBrollStatus] pending=${pending} done=${done} failed=${failed}`);
    return { pending, done, failed };
  },
});
