import { z } from 'zod';
import { createEndpoint } from 'zite-integrations-backend-sdk';

export default createEndpoint({
  authenticated: true,
  description: 'Probe the Kinovi/Seedance API and return full diagnostics — HTTP status, raw response body, parsed task ID, and a human-readable diagnosis.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    success: z.boolean(),
    apiKeyConfigured: z.boolean(),
    httpStatus: z.number().optional(),
    rawBody: z.string().optional(),
    taskId: z.string().optional(),
    diagnosis: z.string(),
  }),
  execute: async () => {
    const apiKey = (process.env.ZITE_KINOVI_API_KEY ?? '').trim();

    if (!apiKey) {
      return {
        success: false,
        apiKeyConfigured: false,
        diagnosis: 'ZITE_KINOVI_API_KEY is not set. Add this secret in the Zite Secrets panel (Settings → Secrets → Add secret).',
      };
    }

    const requestBody = {
      model: 'seedance2-fast',
      inputs: {
        prompt: 'Abstract warm amber light particles drifting softly, test request',
        duration: '4',
        aspectRatio: '9:16',
        outputResolution: '480p',
      },
    };

    try {
      const res = await fetch('https://kinovi.ai/api/v1/jobs/createTask', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      const rawBody = await res.text().catch(() => '(unreadable body)');

      let taskId: string | undefined;
      try {
        const parsed = JSON.parse(rawBody);
        taskId = parsed?.task_id ?? parsed?.taskId ?? parsed?.id ?? parsed?.job_id;
      } catch { /* not valid JSON */ }

      let diagnosis: string;
      if (res.status === 401 || res.status === 403) {
        diagnosis = `Authentication failed (HTTP ${res.status}) — your ZITE_KINOVI_API_KEY is invalid or expired. Check your Kinovi dashboard for a valid API key.`;
      } else if (res.status === 400) {
        diagnosis = `Bad request (HTTP 400) — Kinovi rejected the payload. The API contract may have changed: ${rawBody.slice(0, 300)}`;
      } else if (res.status === 429) {
        diagnosis = `Rate limited (HTTP 429) — too many requests. Wait a moment and try again.`;
      } else if (res.status >= 500) {
        diagnosis = `Kinovi server error (HTTP ${res.status}) — the service is temporarily unavailable. Try again in a few minutes.`;
      } else if (!res.ok) {
        diagnosis = `Unexpected HTTP ${res.status} from Kinovi — ${rawBody.slice(0, 300)}`;
      } else if (!taskId) {
        diagnosis = `HTTP ${res.status} OK but no task ID found in response. The API response format may have changed. Raw: ${rawBody.slice(0, 300)}`;
      } else {
        diagnosis = `✅ API is working — task created successfully (ID: ${taskId}). Seedance 2.0 video generation should work.`;
      }

      return { success: res.ok && !!taskId, apiKeyConfigured: true, httpStatus: res.status, rawBody, taskId, diagnosis };
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      let diagnosis: string;
      if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
        diagnosis = `DNS failure — cannot resolve "kinovi.ai". Check your network or whether the domain has changed.`;
      } else if (/ECONNREFUSED/i.test(msg)) {
        diagnosis = `Connection refused by kinovi.ai — the service may be down.`;
      } else if (/ETIMEDOUT|timeout/i.test(msg)) {
        diagnosis = `Connection timed out — kinovi.ai is not responding. The service may be overloaded.`;
      } else {
        diagnosis = `Network error reaching kinovi.ai: ${msg}`;
      }
      return { success: false, apiKeyConfigured: true, diagnosis, rawBody: msg };
    }
  },
});
