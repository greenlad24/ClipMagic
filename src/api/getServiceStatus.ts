import { z } from 'zod';
import { createEndpoint } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Check whether all four microservice URLs are configured as secrets',
  inputSchema: z.object({}),
  outputSchema: z.object({
    captureConfigured: z.boolean(),
    renderConfigured: z.boolean(),
    veo3Configured: z.boolean(),
    remotionConfigured: z.boolean(),
    captureUrl: z.string().optional(),
    renderUrl: z.string().optional(),
    veo3Url: z.string().optional(),
    remotionUrl: z.string().optional(),
  }),
  execute: async () => {
    const captureUrl  = process.env.ZITE_CAPTURE_SERVICE_URL  || '';
    const renderUrl   = process.env.ZITE_RENDER_SERVICE_URL   || '';
    const veo3Url     = process.env.ZITE_VEO3_SERVICE_URL     || '';
    const remotionUrl = process.env.ZITE_REMOTION_SERVICE_URL || '';
    return {
      captureConfigured:  captureUrl.length  > 0,
      renderConfigured:   renderUrl.length   > 0,
      veo3Configured:     veo3Url.length     > 0,
      remotionConfigured: remotionUrl.length > 0,
      captureUrl:  captureUrl  || undefined,
      renderUrl:   renderUrl   || undefined,
      veo3Url:     veo3Url     || undefined,
      remotionUrl: remotionUrl || undefined,
    };
  },
});
