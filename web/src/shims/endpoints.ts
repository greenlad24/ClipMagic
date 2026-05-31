/**
 * Drop-in replacement for Zite's `zite-endpoints-sdk`.
 *
 * The original frontend imports each backend endpoint as a typed async function
 * (e.g. `getProjects({})`). Here every one of those names is generated as a
 * function that POSTs to `/api/fn/<name>` on the self-hosted server, which runs
 * the corresponding ported endpoint. This keeps all page/component code working
 * unchanged.
 */

const BASE = ""; // same origin as the served app

async function callFn<T = any>(name: string, input: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/fn/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${name}: invalid response: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || json?.message || `${name} failed (${res.status})`;
    throw new Error(msg);
  }
  return json as T;
}

function endpoint<I = any, O = any>(name: string) {
  return (input: I): Promise<O> => callFn<O>(name, input);
}

// ── Endpoint functions (must match server/src/zite/endpoints dispatch) ───────
export const captureShots = endpoint("captureShots");
export const completeProject = endpoint("completeProject");
export const createProject = endpoint("createProject");
export const deleteMusicTrack = endpoint("deleteMusicTrack");
export const deleteProject = endpoint("deleteProject");
export const deletePromoVideo = endpoint("deletePromoVideo");
export const deleteShots = endpoint("deleteShots");
export const generateShot = endpoint("generateShot");
export const getDownloadUrl = endpoint("getDownloadUrl");
export const getMusicTracks = endpoint("getMusicTracks");
export const getProject = endpoint("getProject");
export const getProjects = endpoint("getProjects");
export const getPromoVideos = endpoint("getPromoVideos");
export const getServiceStatus = endpoint("getServiceStatus");
export const getShots = endpoint("getShots");
export const getWaveform = endpoint("getWaveform");
export const indexPromoVideo = endpoint("indexPromoVideo");
export const pollBrollStatus = endpoint("pollBrollStatus");
export const recaptureShot = endpoint("recaptureShot");
export const runPipeline = endpoint("runPipeline");
export const saveMusicTrack = endpoint("saveMusicTrack");
export const savePromoVideo = endpoint("savePromoVideo");
export const testKinoviApi = endpoint("testKinoviApi");
export const updateProjectSettings = endpoint("updateProjectSettings");
export const updateProject = endpoint("updateProjectSettings");
export const updatePromoVideo = endpoint("updatePromoVideo");
export const updateShot = endpoint("updateShot");
export const validateAssets = endpoint("validateAssets");
export const submitRendiJob = endpoint("submitRendiJob");
export const pollRendiStatus = endpoint("pollRendiStatus");
export const renderVideo = endpoint("renderVideo");

// ── Output/Input types used by the frontend. The originals were generated from
// each endpoint's zod schema; the app only uses them as TS shapes, so permissive
// aliases keep type-checking happy without coupling to the server. ────────────
export type GetProjectsOutputType = { projects: any[] };
export type GetProjectOutputType = { project: any; shots?: any[] };
export type GetShotsOutputType = { shots: any[] };
export type GetMusicTracksOutputType = { tracks: any[] };
export type GetPromoVideosOutputType = { promoVideos: any[] };
export type GetServiceStatusOutputType = {
  captureConfigured: boolean;
  renderConfigured: boolean;
  veo3Configured: boolean;
  remotionConfigured: boolean;
  captureUrl?: string;
  renderUrl?: string;
  veo3Url?: string;
  remotionUrl?: string;
};
export type TestKinoviApiOutputType = {
  success: boolean;
  message?: string;
  [k: string]: any;
};
export type SubmitRendiJobOutputType = {
  jobId: string;
  renderJobRecordId: string;
  rendiCommandId: string;
  status: string;
  reused: boolean;
  diagnostics: {
    totalScenes: number;
    hasSubtitles: boolean;
    hasMusic: boolean;
    srtLineCount: number;
    estimatedPayloadKB: number;
  };
};
export type PollRendiStatusOutputType = {
  status: string;
  terminal: boolean;
  outputUrl: string | null;
  subtitleAssUrl: string | null;
  renderingTime: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  outputDuration: number | null;
  errorMessage: string | null;
  pollIntervalMs: number;
};
