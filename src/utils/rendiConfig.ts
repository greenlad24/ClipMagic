/**
 * Render backend configuration.
 *
 * ClipMagic can render against either:
 *   • the self-hosted ClipMagic server (recommended — one DigitalOcean droplet
 *     does upload + storage + FFmpeg, no per-render Rendi cost), or
 *   • Rendi's hosted API (the original setup).
 *
 * Both speak the same wire protocol: `POST /v1/run-ffmpeg-command` and
 * `GET /v1/commands/:id`. The self-hosted server implements that endpoint
 * exactly, so switching is just a base-URL change — no render-code rewrite.
 *
 * Selection (first match wins):
 *   1. CLIPMAGIC_RENDER_URL  → self-hosted server base URL
 *   2. RENDI_API_KEY         → Rendi hosted API
 */

const RENDI_API_BASE = 'https://api.rendi.dev';

export interface RenderBackendConfig {
  baseUrl: string;
  apiKey: string;
  selfHosted: boolean;
}

export function getRendiConfig(): RenderBackendConfig {
  const selfHostedUrl = process.env.CLIPMAGIC_RENDER_URL;
  if (selfHostedUrl) {
    return {
      baseUrl: selfHostedUrl.replace(/\/+$/, ''),
      // Token is optional; only needed if the droplet sets API_TOKEN.
      apiKey: process.env.CLIPMAGIC_API_TOKEN || '',
      selfHosted: true,
    };
  }

  const apiKey = process.env.RENDI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No render backend configured. Set CLIPMAGIC_RENDER_URL (self-hosted) ' +
        'or RENDI_API_KEY (Rendi).'
    );
  }
  return { baseUrl: RENDI_API_BASE, apiKey, selfHosted: false };
}

export function rendiHeaders(config: { apiKey: string }): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Self-hosted with no token leaves apiKey empty → no auth header (open API).
  if (config.apiKey) headers['X-API-KEY'] = config.apiKey;
  return headers;
}
