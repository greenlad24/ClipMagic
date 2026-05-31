import { z } from 'zod';
import { createEndpoint, Shots, ZiteError } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Update editable fields of a shot. Resets captureStatus to Pending if targetUrl changes on a non-TH shot.',
  inputSchema: z.object({
    shotId: z.string(),
    caption: z.string().optional(),
    targetUrl: z.string().optional(),
    targetSelector: z.string().optional(),
    transitionIn: z.string().optional(),
    sfxIn: z.string().optional(),
    startTime: z.number().optional(),
    endTime: z.number().optional(),
    uiLabelsJson: z.string().optional(),
    /** Permanent clip URL — set by frontend after uploading generated media to Zite storage */
    clipUrl: z.string().optional(),
    /** Capture status — set by frontend after Zite upload completes */
    captureStatus: z.string().optional(),
  }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ input }) => {
    const shot = await Shots.findOne({ id: input.shotId });
    if (!shot) throw new ZiteError({ code: 'NOT_FOUND', message: 'Shot not found' });

    const isTH = shot.shotType === 'Talking Head';
    const urlChanged = input.targetUrl !== undefined && input.targetUrl !== shot.targetUrl;

    await Shots.update({
      id: input.shotId,
      record: {
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        ...(input.targetUrl !== undefined ? { targetUrl: input.targetUrl || undefined } : {}),
        ...(input.targetSelector !== undefined ? { targetSelector: input.targetSelector || undefined } : {}),
        ...(input.transitionIn !== undefined ? { transitionIn: input.transitionIn } : {}),
        ...(input.sfxIn !== undefined ? { sfxIn: input.sfxIn || undefined } : {}),
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
        ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
        ...(input.uiLabelsJson !== undefined ? { uiLabelsJson: input.uiLabelsJson } : {}),
        ...(input.clipUrl !== undefined ? { clipUrl: input.clipUrl } : {}),
        ...(input.captureStatus !== undefined ? { captureStatus: input.captureStatus } : {}),
        // If targetUrl changed on a non-TH shot, reset clip (unless explicitly setting clipUrl)
        ...(urlChanged && !isTH && input.clipUrl === undefined
          ? { captureStatus: 'Pending', clipUrl: undefined }
          : {}),
      },
    });

    return { success: true };
  },
});
