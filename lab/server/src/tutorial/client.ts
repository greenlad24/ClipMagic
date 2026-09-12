/**
 * Client for the Tutorial Studio sidecar.
 *
 * The sidecar (see /opt/clipmagic/tutorial-studio) runs the Python reel
 * pipeline: ffmpeg, a headless Chromium and faster-whisper, none of which are
 * in this Node image. It publishes no port, so this is the only way in, and we
 * inject the shared Bearer token it also requires.
 *
 * Every call is best-effort: an unreachable or unconfigured sidecar becomes a
 * typed failure the handlers turn into a readable message, never a throw that
 * takes down an endpoint.
 */
import { config } from "../config.js";
import { getApimartApiKey } from "../settings/postizSecrets.js";

export interface TutorialJob {
  id: string;
  topic: string;
  outfit: string;
  scene: string;
  /** The room every video in this batch is shot in; blank = the packaged look. */
  environment: string;
  /** Uploaded avatar driving the face, or "" for the packaged creator sheet. */
  avatar_id: string;
  /** Groups the 30-odd jobs of one batch; "" for a one-off reel. */
  batch_id: string;
  /** apimart model that rendered and spoke the clip (see videoModels.ts). */
  video_model: string;
  video_resolution: string;
  /** Clip length, which the model decides: Wan 30s, MiniMax H3 15s. */
  seconds: number;
  reuse_base: boolean;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";
  error: string;
  created_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  size_bytes: number | null;
  has_reel: boolean;
}

export interface TutorialAvatar {
  id: string;
  name: string;
  /** The ONE place every video with this avatar is shot in. */
  environment: string;
  mime: string;
  bytes: number;
  /** A three-panel identity map was saved with this avatar. */
  has_map?: boolean;
  created_at: number | null;
}

export interface TutorialHealth {
  ok: boolean;
  has_apimart: boolean;
  has_anthropic: boolean;
  has_base_clip: boolean;
  queued: number;
}

export class TutorialUnavailable extends Error {}

function base(): string {
  if (!config.tutorialStudioUrl) {
    throw new TutorialUnavailable(
      "Tutorial Studio is not configured — set TUTORIAL_STUDIO_URL and start the sidecar.",
    );
  }
  return config.tutorialStudioUrl.replace(/\/+$/, "");
}

export function isConfigured(): boolean {
  return Boolean(config.tutorialStudioUrl);
}

/** Raw fetch against the sidecar, with the shared token attached. */
export async function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers || {}) };
  if (config.tutorialStudioToken) {
    headers.authorization = `Bearer ${config.tutorialStudioToken}`;
  }
  let body: string | undefined;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(base() + path, { method: init.method || "GET", headers, body });
  } catch {
    throw new TutorialUnavailable("Tutorial Studio is unreachable — is the sidecar running?");
  }
  return res;
}

async function json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await call(path, init);
  const text = await res.text();
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Tutorial Studio returned a non-JSON response (${res.status}).`);
  }
  if (!res.ok) throw new Error(parsed?.error || `Tutorial Studio error (${res.status}).`);
  return parsed as T;
}

export function health(): Promise<TutorialHealth> {
  return json<TutorialHealth>("/api/health");
}

export function listJobs(): Promise<{ jobs: TutorialJob[] }> {
  return json<{ jobs: TutorialJob[] }>("/api/jobs");
}

export function getJob(id: string): Promise<{ job: TutorialJob }> {
  return json<{ job: TutorialJob }>(`/api/jobs/${encodeURIComponent(id)}`);
}

export function getLog(id: string, offset: number): Promise<{ text: string; offset: number }> {
  return json<{ text: string; offset: number }>(
    `/api/jobs/${encodeURIComponent(id)}/log?offset=${offset}`,
  );
}

/**
 * True when the pipeline's paid stages can run at all — either the sidecar has
 * its own APIMART_API_KEY, or this server holds one to hand it.
 */
export function apimartAvailable(sidecarHasIt: boolean): boolean {
  return sidecarHasIt || Boolean(getApimartApiKey());
}

export function listAvatars(): Promise<{ avatars: TutorialAvatar[] }> {
  return json<{ avatars: TutorialAvatar[] }>("/api/avatars");
}

export function createAvatar(input: {
  name: string;
  environment: string;
  image_b64: string;
  /** Optional three-panel identity map, stored beside the reference image. */
  map_b64?: string;
}): Promise<{ avatar: TutorialAvatar }> {
  return json<{ avatar: TutorialAvatar }>("/api/avatars", { method: "POST", body: input });
}

export function updateAvatar(
  id: string,
  input: { name?: string; environment?: string },
): Promise<{ avatar: TutorialAvatar }> {
  return json<{ avatar: TutorialAvatar }>(`/api/avatars/${encodeURIComponent(id)}`, {
    method: "POST",
    body: input,
  });
}

export function deleteAvatar(id: string): Promise<{ deleted: boolean }> {
  return json<{ deleted: boolean }>(`/api/avatars/${encodeURIComponent(id)}/delete`, {
    method: "POST",
  });
}

export function startJob(input: {
  topic: string;
  outfit?: string;
  scene?: string;
  environment?: string;
  avatar_id?: string;
  batch_id?: string;
  /** An approved script — sending one skips the pipeline's own Qwen stage. */
  script?: Record<string, unknown>;
  /** Which model speaks it; omitted leaves the sidecar on its default (Wan). */
  video_model?: string;
  video_resolution?: string;
  reuse_base?: boolean;
}): Promise<{ job: TutorialJob }> {
  // The apimart key lives in the write-only settings store, not in the
  // sidecar's environment, so it rides along with the job that needs it. The
  // sidecar writes it into that job's 0600 .env and never persists it to the
  // job record. Anything it already has in its own env stays authoritative
  // there — this only fills a gap.
  const apimart = getApimartApiKey();
  const keys = apimart ? { APIMART_API_KEY: apimart } : undefined;
  return json<{ job: TutorialJob }>("/api/jobs", {
    method: "POST",
    body: keys ? { ...input, keys } : input,
  });
}

export function cancelJob(id: string): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}
