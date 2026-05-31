import { z } from 'zod';
import { createEndpoint, MusicTracks, ZiteError } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Delete a music track owned by the current user',
  inputSchema: z.object({ trackId: z.string() }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async ({ input, context }) => {
    const track = await MusicTracks.findOne({ id: input.trackId });
    if (!track) throw new ZiteError({ code: 'NOT_FOUND', message: 'Track not found' });
    const userId = Array.isArray(track.user) ? track.user[0] : track.user;
    if (userId !== context.user.id) throw new ZiteError({ code: 'FORBIDDEN', message: 'Access denied' });
    await MusicTracks.delete({ id: input.trackId });
    return { success: true };
  },
});
