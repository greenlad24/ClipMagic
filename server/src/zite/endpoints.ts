/**
 * Ported ClipMagic endpoints — Stage 1 (app shell + data).
 *
 * These reimplement the original Zite endpoints' request/response contracts
 * against the local SQLite document store, so the real frontend runs end-to-end
 * for everything that is pure data (projects, shots, music, settings).
 *
 * The AI / capture / render-pipeline endpoints (runPipeline, captureShots,
 * generateShot, recaptureShot, pollBrollStatus, testKinoviApi) are stubbed with
 * clear, structured responses so the UI works and shows where Stage 2 wiring
 * (OpenAI + Kinovi + capture service) will plug in.
 */
import { Projects, Shots, MusicTracks, PromoVideos, ZiteError } from "./store.js";
import type { Record_ } from "./store.js";
import { config } from "../config.js";
import { createJob, getJob } from "../db/jobs.js";
import { db } from "../db/index.js";
import { pump } from "../render/worker.js";

type Handler = (input: any, userId: string) => Promise<any>;

const sortByCreatedDesc = (a: Record_, b: Record_) =>
  (b.createdAt ?? "") > (a.createdAt ?? "") ? 1 : -1;

// ── Projects ────────────────────────────────────────────────────────────────
const createProject: Handler = async (input, userId) => {
  const project = await Projects.create({
    record: {
      title: "Processing…",
      status: "Uploading",
      narrationUrl: input.narrationUrl || undefined,
      contextHint: input.contextHint,
      accentColor: input.accentColor ?? "#FFD60A",
      musicTrack: input.musicTrackId ?? undefined,
      user: userId,
      audioUrl: input.audioUrl,
      videoChunksJson: input.videoChunksJson,
    },
  });
  return { projectId: project.id };
};

const getProjects: Handler = async (_input, userId) => {
  const { records } = await Projects.findAll({ filters: { user: userId }, limit: 200 });
  const projects = records.sort(sortByCreatedDesc).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    narrationUrl: p.narrationUrl,
    outputUrl: p.outputUrl,
    accentColor: p.accentColor,
    durationSeconds: p.durationSeconds,
    createdAt: p.createdAt,
  }));
  return { projects };
};

const getProject: Handler = async (input) => {
  const p = await Projects.findOne({ id: input.projectId ?? input.id });
  if (!p) throw new ZiteError({ code: "NOT_FOUND", message: "Project not found." });
  return { project: p };
};

const updateProjectSettings: Handler = async (input) => {
  const { projectId, ...rest } = input;
  await Projects.update({ id: projectId, record: rest });
  return { success: true };
};

const completeProject: Handler = async (input) => {
  await Projects.update({ id: input.projectId, record: { status: "Complete" } });
  return { success: true };
};

const deleteProject: Handler = async (input) => {
  const ids: string[] = input.projectIds ?? (input.projectId ? [input.projectId] : []);
  for (const id of ids) {
    const { records } = await Shots.findAll({ filters: { project: id } });
    for (const s of records) await Shots.delete({ id: s.id });
    await Projects.delete({ id });
  }
  return { deleted: ids.length };
};

// ── Shots ───────────────────────────────────────────────────────────────────
const getShots: Handler = async (input) => {
  const { records } = await Shots.findAll({ filters: { project: input.projectId }, limit: 1000 });
  const shots = records.sort((a, b) => ((a.startTime as number) ?? 0) - ((b.startTime as number) ?? 0));
  return { shots };
};

const updateShot: Handler = async (input) => {
  const { shotId, id, ...rest } = input;
  const record = input.record ?? rest;
  await Shots.update({ id: shotId ?? id, record });
  return { success: true };
};

const deleteShots: Handler = async (input) => {
  const ids: string[] = input.shotIds ?? [];
  let deleted = 0;
  for (const id of ids) {
    await Shots.delete({ id });
    deleted++;
  }
  return { success: deleted > 0, deleted };
};

// ── Music ───────────────────────────────────────────────────────────────────
const getMusicTracks: Handler = async (_input, userId) => {
  const { records } = await MusicTracks.findAll({ filters: { user: userId }, limit: 200 });
  const tracks = records.sort(sortByCreatedDesc).map((t) => ({
    id: t.id,
    trackName: t.trackName,
    audioUrl: t.audioUrl,
    bpm: t.bpm,
    durationSeconds: t.durationSeconds,
  }));
  return { tracks };
};

const saveMusicTrack: Handler = async (input, userId) => {
  const track = await MusicTracks.create({
    record: {
      trackName: input.trackName ?? input.name ?? "Untitled",
      audioUrl: input.audioUrl,
      bpm: input.bpm,
      durationSeconds: input.durationSeconds,
      user: userId,
    },
  });
  return { trackId: track.id };
};

const deleteMusicTrack: Handler = async (input) => {
  await MusicTracks.delete({ id: input.trackId ?? input.id });
  return { success: true };
};

// ── Service status (drives the /setup page) ──────────────────────────────────
const getServiceStatus: Handler = async () => {
  // On the self-hosted server, render is always available locally.
  return {
    captureConfigured: !!process.env.ZITE_CAPTURE_SERVICE_URL,
    renderConfigured: true,
    veo3Configured: !!process.env.ZITE_KINOVI_API_KEY,
    remotionConfigured: false,
    captureUrl: process.env.ZITE_CAPTURE_SERVICE_URL || undefined,
    renderUrl: "local (built-in FFmpeg)",
    veo3Url: process.env.ZITE_KINOVI_API_KEY ? "configured" : undefined,
    remotionUrl: undefined,
  };
};

// ── Promo videos ─────────────────────────────────────────────────────────────
const getPromoVideos: Handler = async (_input, userId) => {
  const { records } = await PromoVideos.findAll({ filters: { user: userId }, limit: 200 });
  return { promoVideos: records.sort(sortByCreatedDesc) };
};
const savePromoVideo: Handler = async (input, userId) => {
  const rec = await PromoVideos.create({ record: { ...input, user: userId } });
  return { id: rec.id };
};
const updatePromoVideo: Handler = async (input) => {
  await PromoVideos.update({ id: input.id, record: input.record ?? input });
  return { success: true };
};
const deletePromoVideo: Handler = async (input) => {
  await PromoVideos.delete({ id: input.id });
  return { success: true };
};

// ── Misc data helpers ────────────────────────────────────────────────────────
const getDownloadUrl: Handler = async (input) => {
  // Our uploads are already directly served URLs.
  return { url: input.url ?? input.fileUrl ?? "" };
};

// ── Final render via the local FFmpeg engine (Rendi-compatible contract) ─────
// Builds a manifest from the project's narration + shots and queues a render
// job; the frontend polls pollRendiStatus until terminal.
const submitRendiJob: Handler = async (input) => {
  const projectId: string = input.projectId;
  const project = await Projects.findOne({ id: projectId });
  if (!project) throw new ZiteError({ code: "NOT_FOUND", message: "Project not found." });

  const narrationUrl = (project.narrationUrl as string) || (project.audioUrl as string) || "";
  if (!narrationUrl) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Project has no narration video to render." });
  }

  const { records: shotRecords } = await Shots.findAll({ filters: { project: projectId }, limit: 1000 });
  const shots = shotRecords.sort((a, b) => ((a.startTime as number) ?? 0) - ((b.startTime as number) ?? 0));

  // Subtitles, if the project carries them.
  let subtitles: any[] = [];
  if (project.subtitlesJson) {
    try { subtitles = JSON.parse(project.subtitlesJson as string); } catch { /* */ }
  }

  // Music track (optional).
  let music: { audioUrl: string; volume: number } | null = null;
  const musicTrackId = (project.musicTrack as string) || undefined;
  if (musicTrackId) {
    const track = await MusicTracks.findOne({ id: musicTrackId });
    if (track?.audioUrl) {
      const vol = typeof project.musicVolume === "number" ? (project.musicVolume as number) / 100 : 0.08;
      music = { audioUrl: track.audioUrl as string, volume: vol };
    }
  }

  // Map shots -> manifest scenes (overlay clips for screencast/broll).
  const scenes = shots
    .filter((s) => s.startTime !== undefined && s.endTime !== undefined)
    .map((s) => {
      const type = String(s.shotType || "broll").toLowerCase().replace(/[\s_-]/g, "");
      const sceneType = type === "talkinghead" ? "talking-head" : type === "screencast" ? "screencast" : "broll";
      const clipUrl = (s.clipUrl as string) || "";
      const isImage = /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(clipUrl.split("?")[0]);
      return {
        shotId: s.id,
        type: sceneType,
        startTime: s.startTime as number,
        endTime: s.endTime as number,
        overlay:
          sceneType !== "talking-head" && clipUrl
            ? {
                mediaType: isImage ? "image" : "video",
                clipUrl,
                clipStartOffset: 0,
                clipEndOffset: 0,
                overlayDelaySeconds: 0,
                showNarratorFirst: false,
                returnToNarrator: false,
                narratorReturnLeadSeconds: 0,
                fadeInSeconds: 0.15,
                isTacticalBroll: false,
              }
            : null,
        transitionIn: null,
        sfxIn: null,
      };
    });

  const duration =
    (project.durationSeconds as number) ||
    scenes.reduce((max, s) => Math.max(max, s.endTime), 0) ||
    0;

  const manifest = {
    version: 1,
    projectId,
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: duration || 1,
    narration: { videoUrl: narrationUrl, chunkUrls: [] },
    music,
    scenes,
    subtitles,
    subtitleStyle: {
      fontFamily: "DejaVu Sans Bold",
      fontSize: 60,
      position: "bottom-center",
      outlineColor: "#000000",
      outlineWidth: 6,
      lineColor: "#FFFFFF",
      wordColor: "#c084fc",
      allCaps: true,
      maxWordsPerLine: 4,
    },
  };

  const jobId = createJob({
    kind: "manifest",
    manifest,
    outputName: `${(project.title as string) || projectId}.mp4`,
    projectId,
  });
  db.prepare("UPDATE render_jobs SET duration_sec=? WHERE id=?").run(manifest.durationSeconds, jobId);
  await Projects.update({ id: projectId, record: { status: "Rendering", renderJobId: jobId } });
  pump();

  return {
    jobId,
    renderJobRecordId: jobId,
    rendiCommandId: jobId,
    status: "Submitted",
    reused: false,
    diagnostics: {
      totalScenes: scenes.length,
      hasSubtitles: subtitles.length > 0,
      hasMusic: !!music,
      srtLineCount: subtitles.length,
      estimatedPayloadKB: Math.round(JSON.stringify(manifest).length / 1024),
    },
  };
};

const pollRendiStatus: Handler = async (input) => {
  const id = input.renderJobRecordId ?? input.jobId;
  const job = getJob(id);
  if (!job) throw new ZiteError({ code: "NOT_FOUND", message: "Render job not found." });

  const statusMap: Record<string, string> = {
    queued: "Submitted",
    active: "Processing",
    completed: "Done",
    failed: "Error",
    canceled: "Error",
  };
  const terminal = job.status === "completed" || job.status === "failed" || job.status === "canceled";
  const outputUrl = job.output_file ? `/api/outputs/${job.output_file}` : null;

  if (job.project_id && terminal) {
    await Projects.update({
      id: job.project_id,
      record: job.status === "completed" ? { status: "Complete", outputUrl } : { status: "Error" },
    });
  }

  return {
    status: statusMap[job.status] || "Processing",
    terminal,
    outputUrl,
    subtitleAssUrl: null,
    renderingTime: job.duration_sec ?? null,
    outputWidth: 1080,
    outputHeight: 1920,
    outputDuration: job.duration_sec ?? null,
    errorMessage: job.error ?? null,
    pollIntervalMs: 3000,
  };
};

const renderVideo: Handler = async (input) => submitRendiJob(input, LOCAL_USER);

// ── AI / capture / render-pipeline — Stage 2 stubs ───────────────────────────
function stageTwo(name: string): Handler {
  return async () => {
    throw new ZiteError({
      code: "NOT_IMPLEMENTED",
      message:
        `"${name}" is part of the AI pipeline, which is being wired up in the next ` +
        `stage (OpenAI transcription/director + Kinovi capture). The app shell, ` +
        `uploads, projects, shots, music and local rendering all work now.`,
    });
  };
}

// Pipeline status pollers return a benign "not running" so the UI can poll
// without erroring out.
const pollBrollStatus: Handler = async () => ({ status: "idle", ready: false, shots: [] });

const testKinoviApi: Handler = async () => {
  const configured = !!process.env.ZITE_KINOVI_API_KEY;
  return {
    success: configured,
    message: configured
      ? "Kinovi API key is configured (live calls land in the next stage)."
      : "Kinovi API key not set. Add ZITE_KINOVI_API_KEY to enable shot generation.",
  };
};

export const HANDLERS: Record<string, Handler> = {
  // data
  createProject,
  getProjects,
  getProject,
  updateProjectSettings,
  completeProject,
  deleteProject,
  getShots,
  updateShot,
  deleteShots,
  getMusicTracks,
  saveMusicTrack,
  deleteMusicTrack,
  getServiceStatus,
  getPromoVideos,
  savePromoVideo,
  updatePromoVideo,
  deletePromoVideo,
  getDownloadUrl,
  // render
  submitRendiJob,
  pollRendiStatus,
  renderVideo,
  // pollers / status
  pollBrollStatus,
  testKinoviApi,
  // stage-2 AI
  runPipeline: stageTwo("runPipeline"),
  captureShots: stageTwo("captureShots"),
  generateShot: stageTwo("generateShot"),
  recaptureShot: stageTwo("recaptureShot"),
  indexPromoVideo: stageTwo("indexPromoVideo"),
  validateAssets: async () => ({ ok: true, errors: [] }),
  getWaveform: async () => ({ peaks: [], duration: 0 }),
};

void config;
