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

// Verbose API logging — every endpoint call, its timing, result and errors are
// printed to the browser console with a [ClipMagic] tag so they're easy to copy
// out for debugging. Toggle off by setting localStorage.clipmagicDebug = "0".
function debugOn(): boolean {
  try {
    return localStorage.getItem("clipmagicDebug") !== "0";
  } catch {
    return true;
  }
}

let callSeq = 0;

async function callFn<T = any>(name: string, input: unknown): Promise<T> {
  const id = ++callSeq;
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  if (debugOn()) {
    console.log(`%c[ClipMagic] → #${id} ${name}`, "color:#60a5fa;font-weight:bold", input ?? {});
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/fn/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
    });
  } catch (networkErr) {
    console.error(`[ClipMagic] ✗ #${id} ${name} — network error`, networkErr);
    throw new Error(`${name}: network error (is the server reachable?)`);
  }
  const ms = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    console.error(`[ClipMagic] ✗ #${id} ${name} (${ms}ms) — non-JSON response:`, text.slice(0, 500));
    throw new Error(`${name}: invalid response: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || json?.message || `${name} failed (${res.status})`;
    console.error(`[ClipMagic] ✗ #${id} ${name} (${ms}ms) HTTP ${res.status}:`, msg, json);
    throw new Error(msg);
  }
  if (debugOn()) {
    console.log(`%c[ClipMagic] ✓ #${id} ${name} (${ms}ms)`, "color:#34d399;font-weight:bold", json);
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
export const importPromoIndex = endpoint("importPromoIndex");
export const reindexAllPromos = endpoint("reindexAllPromos");
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
