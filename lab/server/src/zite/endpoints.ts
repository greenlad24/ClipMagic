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
import { Projects, Shots, MusicTracks, PromoVideos, NarrationCuts, MemeProjects, ZiteError } from "./store.js";
import { listStorage, deleteStorageFiles, deleteStorageArea } from "./storage.js";
import type { Record_ } from "./store.js";
import { config } from "../config.js";
import { createJob, getJob, listJobs as listRenderJobs } from "../db/jobs.js";
import { pauseJob as pauseRenderJob, resumeJob as resumeRenderJob, cancelJob as cancelRenderJob } from "../render/jobActions.js";
import { db } from "../db/index.js";
import { pump } from "../render/worker.js";
import { resolveInput } from "../render/resolve.js";
import { probe } from "../render/ffmpeg.js";
import { extractAudioForTranscription, type CutSpec } from "../render/cut.js";
import { planCuts } from "../cutter/plan.js";
import { detectSilences, computeEnvelope } from "../cutter/silence.js";
import { segmentTakes, DEFAULT_SETTINGS, type Envelope, type Seg, type Take } from "../cutter/segments.js";
import { selectBestTakeDefaults } from "../cutter/bestTake.js";
import { selectCoherentShort } from "../cutter/findShort.js";
import { AGGRESSION_PRESETS, type Aggressiveness } from "../cutter/plan.js";
import { planTakeDecision } from "../cutter/takes.js";
import { transcribeWithGroq } from "../ai/transcribe.js";
import { withTimeout } from "../util/withTimeout.js";
import {
  createAnalyzeJob, getAnalyzeJob, setStage, setWarning, completeAnalyze, failAnalyze,
  pollSnapshot, listAnalyzeJobs, type AnalyzeJob,
} from "../cutter/analyzeJob.js";
import { beginRun, buildReport, finishRun, reportLogLine } from "../ai/runAccounting.js";
import { SUBTITLE_TEMPLATES, SUBTITLE_TEMPLATE_POOL, DEFAULT_SUBTITLE_STYLE, type SubtitleTemplate, type MotionGraphicClip } from "../render/manifest.js";
import { planMotionGraphics, motionGraphicsEnabledFor } from "../motion/director.js";
import { remotionRuntimeAvailable } from "../motion/render.js";
import { runMemePipeline } from "../meme/pipeline.js";
import {
  getSettings as getPostizSettingsStore,
  updateSettings as updatePostizSettingsStore,
  restartPostiz as restartPostizContainer,
  dockerSocketAvailable,
} from "../settings/postizSecrets.js";
import {
  getStatus as bulkSchedulerStatus,
  listChannels as bulkSchedulerChannels,
  preview as bulkSchedulerPreview,
  schedule as bulkSchedulerSchedule,
} from "../postiz/bulkScheduler.js";
import { listCloudFolder, cloudProvidersConfigured } from "../postiz/cloudSources.js";

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
      // Per-video motion-graphics toggle. Default ON; only persisted as false
      // when the user explicitly switched it off in the create flow.
      motionGraphics: input.motionGraphics === false ? false : true,
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
  const { projectId, musicTrackId, ...rest } = input;
  // Map musicTrackId → the project's musicTrack field (the "auto" picker and
  // the home dropdown both send musicTrackId).
  if (musicTrackId !== undefined) (rest as Record<string, unknown>).musicTrack = musicTrackId;
  await Projects.update({ id: projectId, record: rest });
  return { success: true };
};

const completeProject: Handler = async (input) => {
  const record: Record<string, unknown> = { status: "Complete" };
  if (input.outputUrl) record.outputUrl = input.outputUrl;
  await Projects.update({ id: input.projectId, record });
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
    bpm: t.bpm,
    key: t.key,
    durationSeconds: t.durationSeconds,
    mood: t.mood ?? [],
    analysisStatus: t.analysisStatus ?? "Ready",
    audioUrl: t.audioUrl,
  }));
  return { tracks };
};

const saveMusicTrack: Handler = async (input, userId) => {
  const track = await MusicTracks.create({
    record: {
      trackName: input.trackName ?? input.name ?? "Untitled",
      audioUrl: input.audioUrl,
      bpm: input.bpm,
      key: input.key,
      mood: input.mood,
      durationSeconds: input.durationSeconds,
      // The library/home dropdown only shows tracks with analysisStatus 'Ready'.
      // We have no separate analysis step, so a saved track is ready immediately.
      analysisStatus: "Ready",
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
  // Probe whether Remotion + Chromium are actually usable here (cached after the
  // first call), so the UI / curl can confirm motion graphics & stickers will
  // render — just like the AI keys are reported. This is the RUNTIME probe, so
  // it reflects real readiness regardless of the per-video toggle.
  const remotionReady = await remotionRuntimeAvailable();
  const browserExe = config.remotionBrowserExecutable || undefined;
  // Postiz (self-hosted social poster) runs as a SEPARATE container on its own
  // port, opt-in via the `postiz` compose profile. We surface enough for the hub
  // tile to decide whether to go live and where to point:
  //   - POSTIZ_URL: full origin, e.g. https://social.example.com or
  //     http://1.2.3.4:5000. When set, the tile links straight to it.
  //   - POSTIZ_PORT: just the port (default 5000). The frontend derives
  //     http://<current-host>:<port> at click time, so the same .env works on
  //     any host IP without hardcoding it server-side.
  // The tile only goes live when one of these is configured; otherwise it stays
  // "coming soon" so it never opens a dead link.
  const postizUrl = (process.env.POSTIZ_URL || "").trim() || undefined;
  const postizPortRaw = (process.env.POSTIZ_PORT || "").trim();
  const postizEnabled = /^(1|true|yes)$/i.test((process.env.POSTIZ_ENABLED || "").trim());
  const postizPort = postizPortRaw || (postizUrl || postizEnabled ? "5000" : undefined);
  // On the self-hosted server, render is always available locally.
  return {
    captureConfigured: !!process.env.ZITE_CAPTURE_SERVICE_URL,
    renderConfigured: true,
    veo3Configured: !!process.env.ZITE_KINOVI_API_KEY,
    // Remotion (motion graphics + stickers) is "configured" when Chromium is
    // actually launchable here, not merely when a flag is set.
    remotionConfigured: remotionReady,
    captureUrl: process.env.ZITE_CAPTURE_SERVICE_URL || undefined,
    renderUrl: "local (built-in FFmpeg)",
    veo3Url: process.env.ZITE_KINOVI_API_KEY ? "configured" : undefined,
    remotionUrl: remotionReady
      ? browserExe
        ? `chromium=${browserExe}`
        : "ready (bundled Chromium)"
      : undefined,
    // Whether the SHORT-FORM motion-graphics stage is globally force-disabled
    // (MOTION_GRAPHICS=0). Default is on, gated per-video by the create toggle.
    motionGraphicsForceDisabled: config.motionGraphicsForceDisabled,
    // AI pipeline configuration (so the UI / curl can confirm keys are live).
    transcriptionConfigured: !!process.env.GROQ_API_KEY,
    directorConfigured: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN),
    kinoviConfigured: !!process.env.ZITE_KINOVI_API_KEY,
    stockConfigured: !!process.env.PEXELS_API_KEY,
    // Postiz social poster (separate container, `postiz` compose profile).
    postizConfigured: !!(postizUrl || postizEnabled || postizPortRaw),
    postizUrl,
    postizPort,
  };
};

// ── Promo videos (library is global, not per-user — matches the original) ────
const getPromoVideos: Handler = async () => {
  const { records } = await PromoVideos.findAll({ limit: 200 });
  const videos = records
    .slice()
    .sort(sortByCreatedDesc)
    .map((r) => {
      let segmentCount: number | undefined;
      if (r.contentIndexJson) {
        try {
          const idx = JSON.parse(r.contentIndexJson as string);
          segmentCount = Array.isArray(idx.segments) ? idx.segments.length : undefined;
        } catch {
          /* ignore */
        }
      }
      return {
        id: r.id,
        productName: r.productName,
        keywords: r.keywords,
        description: r.description,
        videoUrl: r.videoUrl,
        addedAt: r.addedAt ?? r.createdAt,
        indexStatus: r.indexStatus,
        segmentCount,
        // true when the cached index is a vision index at the CURRENT standard
        // (so "Re-index all" will skip it). false = needs re-indexing.
        indexCurrent: isIndexCurrent(r.contentIndexJson),
        hasVideo: !!r.videoUrl,
      };
    });
  return { videos };
};

/** Return the full cached content index (segments + per-second captions) for
 *  one promo video, so the UI can show exactly what the AI sees each second. */
const getPromoIndex: Handler = async (input) => {
  const v = await PromoVideos.findOne({ id: input.videoId ?? input.id });
  if (!v) throw new ZiteError({ code: "NOT_FOUND", message: "Promo video not found" });
  let index: any = null;
  if (v.contentIndexJson) {
    try {
      index = JSON.parse(v.contentIndexJson as string);
    } catch {
      /* corrupt */
    }
  }
  return {
    id: v.id,
    productName: v.productName,
    videoUrl: v.videoUrl,
    indexStatus: v.indexStatus,
    mode: index?.mode ?? null,
    mediaKind: index?.mediaKind ?? v.mediaKind ?? null,
    perSecond: Array.isArray(index?.perSecond) ? index.perSecond : [],
    segments: Array.isArray(index?.segments) ? index.segments : [],
  };
};

/**
 * Export the FULL raw content-index JSON for review — all promo videos (or one
 * if videoId is given). Returns a single JSON object you can copy/paste.
 */
const exportPromoIndexes: Handler = async (input) => {
  const { records } = await PromoVideos.findAll({ limit: 1000 });
  const pick = input?.videoId ?? input?.id;
  const out = records
    .filter((v) => (pick ? v.id === pick : true))
    .map((v) => {
      let index: any = null;
      if (v.contentIndexJson) {
        try { index = JSON.parse(v.contentIndexJson as string); } catch { index = "<<unparseable>>"; }
      }
      return {
        id: v.id,
        productName: v.productName ?? null,
        videoUrl: v.videoUrl ?? null,
        indexStatus: v.indexStatus ?? null,
        mediaKind: v.mediaKind ?? null,
        keywords: v.keywords ?? null,
        indexMode: index && typeof index === "object" ? index.mode ?? null : null,
        index,
      };
    });
  return {
    exportedAt: new Date().toISOString(),
    count: out.length,
    videos: out,
  };
};
// savePromoVideo runs the original endpoint (it derives product metadata via an
// LLM, with a filename fallback) — wired through the bundle further below.
const updatePromoVideo: Handler = async (input) => {
  const { id, videoId, record, ...rest } = input;
  const targetId = id ?? videoId;
  if (!targetId) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "updatePromoVideo requires an id/videoId." });
  }
  await PromoVideos.update({ id: targetId, record: record ?? rest });
  return { success: true };
};
const deletePromoVideo: Handler = async (input) => {
  await PromoVideos.delete({ id: input.id ?? input.videoId });
  return { success: true };
};

/**
 * Bulk-import a promo-video metadata index (e.g. an exported pool from the old
 * Zite app). Each entry may carry path_lower / downloadUrl, but we DO NOT store
 * those — they're only used to match an entry to a promo video that's already in
 * the library (by base filename). Matched entries are enriched in place; the
 * rest are created as metadata-only records (videoUrl is set from downloadUrl so
 * retrieval still works, but the path_lower/downloadUrl fields themselves are
 * dropped from storage).
 *
 * Stored fields per video: productName, keywords, description, videoUrl,
 * contentIndexJson (stringified), indexStatus.
 */
const baseFileName = (p: string): string => {
  const last = String(p || "").split("/").pop() || "";
  return last.replace(/\.[^.]+$/, "").trim().toLowerCase();
};

const importPromoIndex: Handler = async (input) => {
  // Accept either a raw array or { entries: [...] } / { index: [...] }.
  const entries: any[] = Array.isArray(input)
    ? input
    : Array.isArray(input?.entries)
    ? input.entries
    : Array.isArray(input?.index)
    ? input.index
    : Array.isArray(input?.videos)
    ? input.videos
    : [];
  if (entries.length === 0) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "No index entries provided (expected a JSON array)." });
  }

  // Existing promo videos, keyed by the base filename we can recover from their
  // stored videoUrl or productName, so re-imports update rather than duplicate.
  const { records: existing } = await PromoVideos.findAll({ limit: 1000 });
  const byKey = new Map<string, Record_>();
  for (const v of existing) {
    const keys = [
      baseFileName((v.videoUrl as string) || ""),
      String(v.productName || "").trim().toLowerCase(),
    ].filter(Boolean);
    for (const k of keys) if (!byKey.has(k)) byKey.set(k, v);
  }

  let updated = 0;
  let created = 0;
  for (const e of entries) {
    // Strip path_lower / downloadUrl from what we persist; use them only to
    // derive a match key and a usable videoUrl.
    const { path_lower, downloadUrl, name, productName, keywords, description, contentIndexJson, videoUrl } = e;
    const matchKey = baseFileName(path_lower || "");
    const nameKey = String(name || productName || "").trim().toLowerCase();

    // contentIndexJson may be an object (as in the export) or already a string.
    const indexStr =
      contentIndexJson == null
        ? undefined
        : typeof contentIndexJson === "string"
        ? contentIndexJson
        : JSON.stringify(contentIndexJson);

    const record: Record<string, unknown> = {
      productName: name ?? productName,
      keywords,
      description,
      // Prefer an already-stored videoUrl; else fall back to the export's
      // downloadUrl so retrieval still resolves a clip. (downloadUrl itself is
      // not stored as a separate field — only as videoUrl.)
      videoUrl: videoUrl ?? downloadUrl,
      contentIndexJson: indexStr,
      indexStatus: indexStr ? "Indexed" : "Not Indexed",
    };

    const match =
      (matchKey && byKey.get(matchKey)) || (nameKey && byKey.get(nameKey)) || undefined;

    if (match) {
      // Don't clobber an existing local videoUrl with the export's downloadUrl.
      if (match.videoUrl) record.videoUrl = match.videoUrl;
      await PromoVideos.update({ id: match.id, record });
      updated++;
    } else {
      record.addedAt = new Date().toISOString();
      await PromoVideos.create({ record });
      created++;
    }
  }

  return { success: true, updated, created, total: entries.length };
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

  // Pick the subtitle style: a pinned project.subtitleTemplate wins; otherwise
  // rotate randomly across the 4 approved styles and remember the pick.
  let chosenTemplate: SubtitleTemplate =
    (project.subtitleTemplate as SubtitleTemplate) ||
    SUBTITLE_TEMPLATE_POOL[Math.floor(Math.random() * SUBTITLE_TEMPLATE_POOL.length)];
  if (!project.subtitleTemplate) {
    await Projects.update({ id: projectId, record: { subtitleTemplate: chosenTemplate } }).catch(() => {});
  }

  // Music track (optional).
  let music: { audioUrl: string; volume: number } | null = null;
  const musicTrackId = (project.musicTrack as string) || undefined;
  if (musicTrackId) {
    const track = await MusicTracks.findOne({ id: musicTrackId });
    if (track?.audioUrl) {
      // musicVolume is stored as a 0–1 gain; default to 8% (quiet bed).
      const raw = typeof project.musicVolume === "number" ? (project.musicVolume as number) : 0.08;
      const vol = Math.max(0, Math.min(1, raw));
      music = { audioUrl: track.audioUrl as string, volume: vol };
      console.log(`[submitRendiJob] Music: track=${musicTrackId} vol=${vol} url=${track.audioUrl}`);
    } else {
      console.warn(`[submitRendiJob] Music track ${musicTrackId} has no audioUrl — render will be silent music`);
    }
  } else {
    console.warn(`[submitRendiJob] Project ${projectId} has NO musicTrack set — no background music in render`);
  }

  // Map shots -> manifest scenes (overlay clips for screencast/broll).
  const scenes = shots
    .filter((s) => s.startTime !== undefined && s.endTime !== undefined)
    .map((s) => {
      const type = String(s.shotType || "broll").toLowerCase().replace(/[\s_-]/g, "");
      const sceneType = type === "talkinghead" ? "talking-head" : type === "screencast" ? "screencast" : "broll";
      const clipUrl = (s.clipUrl as string) || "";
      // Pull the overlay timing the director/retrieval computed (segment within
      // the promo clip, narrator-first delay, narrator-return) out of uiLabelsJson.
      let lbl: Record<string, any> = {};
      try { if (s.uiLabelsJson) lbl = JSON.parse(s.uiLabelsJson as string); } catch { /* */ }
      const num = (v: any, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
      // Trust the stored mediaType (stock/promo/generated clips are video); only
      // fall back to URL sniffing when the pipeline didn't record one.
      const isImage = lbl.mediaType === "image"
        ? true
        : lbl.mediaType === "video"
        ? false
        : /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(clipUrl.split("?")[0]);
      // Rule: overlays appear AFTER ~1s of narrator. Honor 1s as a floor (only a
      // very short beat may reduce it, handled upstream by computeOverlayDelay).
      const storedDelay = num(lbl.overlayDelaySeconds, 1.0);
      const beatLen = (s.endTime as number) - (s.startTime as number);
      const overlayDelay = beatLen > 2 ? Math.max(1.0, storedDelay) : storedDelay;
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
                clipStartOffset: num(lbl.clipStartOffset, 0),
                clipEndOffset: num(lbl.clipEndOffset, 0),
                overlayDelaySeconds: overlayDelay,
                showNarratorFirst: lbl.showNarratorFirst === true,
                returnToNarrator: lbl.returnToNarratorBeforeEnd === true,
                narratorReturnLeadSeconds: num(lbl.narratorReturnLeadSeconds, 0),
                fadeInSeconds: 0.15,
                isTacticalBroll: lbl.brollMode === "tactical_broll" || lbl.isRequiredTacticalSlot === true,
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

  // ── Motion graphics (default ON, per-video toggle) ─────────────────────────
  // Ask the director where (if anywhere) tasteful Remotion overlays are
  // motivated by the script. Default ON: graphics run unless the user switched
  // the per-video toggle OFF (project.motionGraphics === false) or the global
  // MOTION_GRAPHICS=0 escape hatch force-disables them. Best-effort even when
  // on: planMotionGraphics returns [] when Claude is unconfigured, Chromium
  // isn't usable, or nothing is warranted — the manifest is then identical to
  // before and the render is unaffected.
  let motionGraphics: MotionGraphicClip[] = [];
  if (motionGraphicsEnabledFor(project.motionGraphics)) {
    const beats = scenes.map((s) => ({ start: s.startTime, end: s.endTime }));
    motionGraphics = await planMotionGraphics({
      transcript: (project.transcript as string) || "",
      durationSeconds: duration || 1,
      beats,
    });
  }

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
    motionGraphics,
    // Subtitle template: if the project pinned one, use it; otherwise ROTATE
    // randomly across the 4 approved styles per video (persist the pick so the
    // editor preview and any re-render stay consistent).
    subtitleStyle:
      SUBTITLE_TEMPLATES[(project.subtitleTemplate as SubtitleTemplate)] ?? SUBTITLE_TEMPLATES[chosenTemplate],
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

const renderVideo: Handler = async (input) => submitRendiJob(input, "local");

// ── AI pipeline (Stage 2): transcription (Groq) + director (Claude) ──────────
// The heavy lifting lives in the esbuild bundle dist/ai/pipeline-bundle.js,
// which runs the ORIGINAL src/api/runPipeline.ts unchanged with the OpenAI SDK
// aliased to our Groq+Claude shim. Imported lazily so a missing bundle or
// missing API keys produces a clear error instead of crashing startup.
type PipelineCtx = { user: { id: string; email: string } };
type PipelineFn = (input: unknown, ctx: PipelineCtx) => Promise<unknown>;
let pipelineMod: {
  runPipeline: PipelineFn;
  captureShots: PipelineFn;
  recaptureShot: PipelineFn;
  reviewEdit: PipelineFn;
  indexPromoVideo: PipelineFn;
  savePromoVideo: PipelineFn;
  getWaveform: PipelineFn;
} | null = null;
async function loadPipeline() {
  if (pipelineMod) return pipelineMod;
  try {
    // @ts-ignore - bundle produced by the build:pipeline step (absent at tsc time)
    pipelineMod = (await import("../ai/pipeline-bundle.js")) as any;
  } catch (e) {
    // Surface the REAL reason (missing file vs. a load/runtime error inside the
    // bundle) instead of a generic "not found" — this is what we debug from.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[loadPipeline] failed to import dist/ai/pipeline-bundle.js:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    throw new ZiteError({
      code: "INTERNAL_ERROR",
      message: `AI pipeline bundle failed to load: ${msg}`,
    });
  }
  return pipelineMod!;
}

/**
 * Run a bundled AI endpoint (runPipeline / captureShots / recaptureShot /
 * indexPromoVideo). All require the AI providers; capture additionally uses
 * Kinovi for B-roll, but that key is checked inside the bundled logic so a
 * project with only screencast/talking-head shots still works without it.
 */
async function runBundled(name: "runPipeline" | "captureShots" | "recaptureShot" | "reviewEdit", input: unknown, userId: string) {
  if (!process.env.GROQ_API_KEY) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "Transcription is not configured. Set GROQ_API_KEY on the server to enable it.",
    });
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "The AI director is not configured. Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) on the server to enable it.",
    });
  }
  let mod;
  try {
    mod = await loadPipeline();
  } catch {
    throw new ZiteError({
      code: "INTERNAL_ERROR",
      message: "AI pipeline bundle not found. Run the server build (npm run build) to generate it.",
    });
  }
  return mod[name](input, { user: { id: userId, email: "you@clipmagic.local" } });
}

const runPipeline: Handler = (input, userId) => runBundled("runPipeline", input, userId);
const captureShots: Handler = (input, userId) => runBundled("captureShots", input, userId);
const recaptureShot: Handler = (input, userId) => runBundled("recaptureShot", input, userId);
const reviewEdit: Handler = (input, userId) => runBundled("reviewEdit", input, userId);

// ── Bulk narration → full pipeline + render, one project at a time ───────────
// Server-side orchestrator so a batch keeps running even if the browser closes.
// For each uploaded narration we create a project, then run the SAME chain the
// single-video flow uses: runPipeline → captureShots → (poll B-roll) →
// reviewEdit → (poll any new B-roll) → submitRendiJob → (poll render) → save
// outputUrl. Processed sequentially ("one at a time") to stay gentle on API
// limits. Progress is polled by the frontend via getBulkRun.

interface BulkItem {
  projectId: string;
  title: string;
  status: "Queued" | "Directing" | "Capturing" | "Reviewing" | "Rendering" | "Complete" | "Error";
  outputUrl: string | null;
  error: string | null;
}
interface BulkRun {
  id: string;
  running: boolean;
  total: number;
  doneCount: number;
  items: BulkItem[];
  startedAt: number;
  finishedAt: number | null;
}
let bulkRun: BulkRun | null = null;
let bulkRunning = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForBroll(projectId: string, userId: string): Promise<void> {
  // Poll pollBrollStatus until no B-roll is pending (or a safety timeout).
  for (let i = 0; i < 240; i++) { // ~20 min max at 5s
    const r = (await pollBrollStatus({ projectId }, userId)) as { pending?: number };
    if (!r || (r.pending ?? 0) === 0) return;
    await sleep(5000);
  }
}

async function waitForRender(jobId: string, userId: string): Promise<{ outputUrl: string | null; error: string | null }> {
  for (let i = 0; i < 600; i++) { // ~30 min max at 3s
    const r = (await pollRendiStatus({ renderJobRecordId: jobId }, userId)) as any;
    if (r?.terminal) return { outputUrl: r.outputUrl ?? null, error: r.errorMessage ?? null };
    await sleep(3000);
  }
  return { outputUrl: null, error: "Render timed out" };
}

async function runOneProject(item: BulkItem, userId: string): Promise<void> {
  try {
    // Mirror the single-video flow EXACTLY (ProcessingPage → finishToTimeline),
    // just synchronously and one at a time. Same handlers, same inputs, same
    // B-roll gating — only the final render step is added so the batch produces
    // a downloadable file (in the single flow the user exports from the editor).
    const projectId = item.projectId;

    // Phase 1–2: direct (transcribe + subtitles + beat plan) then capture media.
    item.status = "Directing";
    await runPipeline({ projectId }, userId);

    item.status = "Capturing";
    const cap = (await captureShots({ projectId }, userId)) as { pendingBroll?: number };
    // Only wait when capture actually queued B-roll generation — same as the
    // single-video page, which polls only if result.pendingBroll > 0.
    if ((cap?.pendingBroll ?? 0) > 0) await waitForBroll(projectId, userId);

    // Phase 3: AI self-review accuracy pass; may queue a few more B-roll clips.
    item.status = "Reviewing";
    const rev = (await reviewEdit({ projectId }, userId)) as { pendingBroll?: number };
    if ((rev?.pendingBroll ?? 0) > 0) await waitForBroll(projectId, userId);

    // Phase 4 (bulk-only): render to a downloadable MP4.
    item.status = "Rendering";
    const job = (await submitRendiJob({ projectId }, userId)) as { jobId?: string; renderJobRecordId?: string };
    const jobId = job.renderJobRecordId ?? job.jobId;
    if (!jobId) throw new Error("Render job was not created");
    const { outputUrl, error } = await waitForRender(jobId, userId);
    if (error || !outputUrl) throw new Error(error || "Render produced no output");

    // Persist the output on the project so it shows on the home grid too,
    // exactly like a single-video render that completes from the editor.
    await Projects.update({ id: projectId, record: { status: "Complete", outputUrl } }).catch(() => {});
    item.outputUrl = outputUrl;
    item.status = "Complete";
  } catch (e) {
    item.status = "Error";
    item.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    console.warn(`[bulkNarration] ${item.title} failed: ${item.error}`);
  }
}

// Create N projects from uploaded narration URLs and kick the background run.
const createBulkNarration: Handler = async (input, userId) => {
  if (bulkRunning) {
    return { started: false, message: "A bulk run is already in progress.", run: bulkRun };
  }
  const items: Array<{ narrationUrl: string; audioUrl?: string; title?: string }> = Array.isArray(input?.items)
    ? input.items
    : [];
  if (items.length === 0) throw new ZiteError({ code: "BAD_REQUEST", message: "No narration files provided." });

  // Create a project per narration through the SAME createProject handler the
  // single-video upload uses, with the same inputs (UploadZone sends exactly
  // these). This guarantees the project record — and therefore everything the
  // AI editing reads from it — is identical to a one-by-one upload. Fully
  // automatic: contextHint blank (AI auto-detects from audio), music auto,
  // subtitles rotate per video. No `bulk` flag, no special-casing anywhere.
  const bulkItems: BulkItem[] = [];
  for (const it of items) {
    if (!it.narrationUrl) continue;
    const { projectId } = (await createProject(
      {
        narrationUrl: it.narrationUrl,
        audioUrl: it.audioUrl,
        videoChunksJson: JSON.stringify([it.narrationUrl]),
        contextHint: undefined,
        accentColor: "#FFD60A",
        musicTrackId: undefined,
      },
      userId,
    )) as { projectId: string };
    bulkItems.push({ projectId, title: it.title || "Bulk video", status: "Queued", outputUrl: null, error: null });
  }

  bulkRun = {
    id: nanoidLike(),
    running: true,
    total: bulkItems.length,
    doneCount: 0,
    items: bulkItems,
    startedAt: Date.now(),
    finishedAt: null,
  };
  bulkRunning = true;

  // Fire-and-forget: process ONE AT A TIME so we don't overload the AI APIs.
  (async () => {
    for (const item of bulkRun!.items) {
      await runOneProject(item, userId);
      bulkRun!.doneCount++;
    }
    bulkRun!.running = false;
    bulkRun!.finishedAt = Date.now();
    bulkRunning = false;
    console.log(`[bulkNarration] done — ${bulkRun!.items.filter((x) => x.status === "Complete").length}/${bulkRun!.total} complete`);
  })().catch((e) => {
    if (bulkRun) { bulkRun.running = false; bulkRun.finishedAt = Date.now(); }
    bulkRunning = false;
    console.error("[bulkNarration] run crashed:", e);
  });

  return { started: true, run: bulkRun };
};

const getBulkRun: Handler = async () => ({ run: bulkRun });

function nanoidLike(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Narration Cutter (separate product) ──────────────────────────────────────
// Phase 1 (deterministic): for each raw clip we transcribe it (Groq, word-level
// timestamps), plan the cuts (remove >0.35s silences + "um"/"uh" fillers), then
// run a single ffmpeg trim+concat "cut" job. Processed one at a time so the AI
// API and the render queue stay gentle. Progress is polled via getCutRun.

interface CutStats {
  originalDuration: number;
  keptDuration: number;
  removedDuration: number;
  silenceCuts: number;
  fillerCuts: number;
  stutterCuts: number;
  takesRemoved: number;
}
interface CutItem {
  cutId: string;
  title: string;
  status: "Queued" | "Transcribing" | "Analyzing" | "Rendering" | "Complete" | "Error";
  outputUrl: string | null;
  error: string | null;
  stats: CutStats | null;
}
interface CutRun {
  id: string;
  running: boolean;
  total: number;
  doneCount: number;
  items: CutItem[];
  startedAt: number;
  finishedAt: number | null;
}
let cutRun: CutRun | null = null;
let cutRunning = false;

async function waitForCutJob(
  jobId: string,
  onProgress?: (status: string, progress: number, stageLabel: string | null) => void,
): Promise<{ outputUrl: string | null; error: string | null }> {
  for (let i = 0; i < 1200; i++) { // ~60 min max at 3s
    const job = getJob(jobId);
    if (!job) return { outputUrl: null, error: "Render job not found" };
    onProgress?.(job.status, job.progress ?? 0, job.stage_label ?? null);
    if (job.status === "completed") {
      return { outputUrl: job.output_file ? `/api/outputs/${job.output_file}` : null, error: null };
    }
    if (job.status === "failed" || job.status === "canceled") {
      return { outputUrl: null, error: job.error ?? "Render failed" };
    }
    await sleep(3000);
  }
  return { outputUrl: null, error: "Render timed out" };
}

async function runOneCut(item: CutItem, sourceUrl: string, aggressiveness: Aggressiveness): Promise<void> {
  // Account every AI call this cut makes (transcription + take-detection) so the
  // cutter's real cost/speed shows up honestly in the optimization report.
  beginRun(item.cutId);
  try {
    item.status = "Transcribing";
    const srcPath = await resolveInput(sourceUrl);
    const meta = await probe(srcPath);
    const duration = meta.duration ?? 0;
    if (!duration) throw new Error("Couldn't read the video — the file looks incomplete or unsupported (often a failed/partial upload). Re-upload and try again; MP4 or MOV work best.");
    const audio = await extractAudioForTranscription(srcPath);
    const tr = await transcribeWithGroq({ data: audio.buffer, name: audio.name, type: audio.type, wantWords: true });

    item.status = "Analyzing";
    // Phase 2: find repeated takes and keep only the best (vision + audio energy).
    // Best-effort — degrades to silence/filler-only if AI/analysis is unavailable.
    // In parallel, run ONE whole-file silencedetect pass to learn where speech
    // actually is (Whisper word timings are loose). Both legs are independent.
    const planDuration = tr.duration || duration;
    const [takeDecision, silences] = await Promise.all([
      planTakeDecision(srcPath, tr.words, planDuration)
        .catch(() => ({ groupsFound: 0, takesRemoved: 0, dropRanges: [] as { start: number; end: number }[] })),
      detectSilences(srcPath, planDuration, {
        noiseFloorDb: AGGRESSION_PRESETS[aggressiveness].noiseFloorDb,
      }).catch(() => []),
    ]);
    const plan = planCuts(tr.words, planDuration, {
      extraCuts: takeDecision.dropRanges,
      silences,
      aggressiveness,
    });
    // Per-cut diagnostics → server log so a misfiring region can be pinpointed.
    console.log(
      `[narrationCut] ${item.title}: ${aggressiveness}, ${silences.length} silent region(s), ` +
        `${plan.boundariesSnapped} boundary snap(s); ` +
        plan.diagnostics
          .map((d) => `${d.kind}[${d.start.toFixed(2)}-${d.end.toFixed(2)}${d.measuredDb != null ? ` ${d.measuredDb}dB` : ""}] ${d.reason}`)
          .join(" | "),
    );
    const stats: CutStats = {
      originalDuration: plan.originalDuration,
      keptDuration: plan.keptDuration,
      removedDuration: plan.removedDuration,
      silenceCuts: plan.silenceCuts,
      fillerCuts: plan.fillerCuts,
      stutterCuts: plan.stutterCuts,
      takesRemoved: takeDecision.takesRemoved,
    };
    item.stats = stats;

    // Snapshot the optimization report (transcription + take-detection savings)
    // onto the cut record before we hand off to the render queue.
    let optimizationReportJson: string | undefined;
    try {
      const report = buildReport(item.cutId);
      if (report) { console.log(reportLogLine(report)); optimizationReportJson = JSON.stringify(report); }
    } catch { /* reporting is best-effort, never blocks the cut */ }

    await NarrationCuts.update({
      id: item.cutId,
      record: {
        status: "Rendering",
        transcript: tr.text,
        stats,
        segments: plan.keep,
        // Persist the audio-energy breakdown so a misfiring region can be shared.
        diagnostics: plan.diagnostics,
        aggressiveness,
        silentRegions: silences.length,
        boundariesSnapped: plan.boundariesSnapped,
        ...(optimizationReportJson ? { optimizationReportJson } : {}),
      },
    }).catch(() => {});

    item.status = "Rendering";
    const spec: CutSpec = { source: srcPath, segments: plan.keep, hasAudio: meta.hasAudio };
    const jobId = createJob({
      kind: "cut",
      manifest: spec,
      outputName: `${item.title || "cut"}.mp4`,
      projectId: item.cutId,
    });
    db.prepare("UPDATE render_jobs SET duration_sec=? WHERE id=?").run(plan.keptDuration, jobId);
    await NarrationCuts.update({ id: item.cutId, record: { renderJobId: jobId } }).catch(() => {});
    pump();

    const { outputUrl, error } = await waitForCutJob(jobId);
    if (error || !outputUrl) throw new Error(error || "Render produced no output");

    await NarrationCuts.update({ id: item.cutId, record: { status: "Complete", outputUrl } }).catch(() => {});
    item.outputUrl = outputUrl;
    item.status = "Complete";
  } catch (e) {
    item.status = "Error";
    item.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    await NarrationCuts.update({ id: item.cutId, record: { status: "Error", error: item.error } }).catch(() => {});
    console.warn(`[narrationCut] ${item.title} failed: ${item.error}`);
  } finally {
    finishRun(item.cutId);
  }
}

// Create N cut records from uploaded raw clips and kick the background run.
const createBulkCut: Handler = async (input, userId) => {
  if (cutRunning) {
    return { started: false, message: "A cut run is already in progress.", run: cutRun };
  }
  const items: Array<{ sourceUrl: string; title?: string }> = Array.isArray(input?.items) ? input.items : [];
  if (items.length === 0) throw new ZiteError({ code: "BAD_REQUEST", message: "No videos provided." });
  // How much non-speech to cut (gentle/balanced/aggressive) — the subjective
  // "how much to cut" is the user's call; default conservative-balanced.
  const aggressiveness: Aggressiveness =
    input?.aggressiveness === "gentle" || input?.aggressiveness === "aggressive"
      ? input.aggressiveness
      : "balanced";

  const cutItems: CutItem[] = [];
  const sources: string[] = [];
  for (const it of items) {
    if (!it.sourceUrl) continue;
    const rec = await NarrationCuts.create({
      record: { title: it.title || "Cut", status: "Queued", sourceUrl: it.sourceUrl, outputUrl: null, user: userId },
    });
    cutItems.push({ cutId: rec.id, title: it.title || "Cut", status: "Queued", outputUrl: null, error: null, stats: null });
    sources.push(it.sourceUrl);
  }

  cutRun = {
    id: nanoidLike(),
    running: true,
    total: cutItems.length,
    doneCount: 0,
    items: cutItems,
    startedAt: Date.now(),
    finishedAt: null,
  };
  cutRunning = true;

  // Fire-and-forget: process ONE AT A TIME (gentle on the transcription API).
  (async () => {
    for (let i = 0; i < cutRun!.items.length; i++) {
      await runOneCut(cutRun!.items[i], sources[i], aggressiveness);
      cutRun!.doneCount++;
    }
    cutRun!.running = false;
    cutRun!.finishedAt = Date.now();
    cutRunning = false;
    console.log(`[narrationCut] done — ${cutRun!.items.filter((x) => x.status === "Complete").length}/${cutRun!.total} complete`);
  })().catch((e) => {
    if (cutRun) { cutRun.running = false; cutRun.finishedAt = Date.now(); }
    cutRunning = false;
    console.error("[narrationCut] run crashed:", e);
  });

  return { started: true, run: cutRun };
};

const getCutRun: Handler = async () => ({ run: cutRun });

const getNarrationCuts: Handler = async (_input, userId) => {
  const { records } = await NarrationCuts.findAll({ filters: { user: userId }, limit: 200 });
  const cuts = records.sort(sortByCreatedDesc).map((c) => ({
    id: c.id,
    title: c.title,
    status: c.status,
    outputUrl: c.outputUrl,
    sourceUrl: c.sourceUrl,
    stats: c.stats,
    diagnostics: c.diagnostics ?? null,
    aggressiveness: c.aggressiveness ?? null,
    boundariesSnapped: c.boundariesSnapped ?? null,
    error: c.error,
    createdAt: c.createdAt,
  }));
  return { cuts };
};

// ── Interactive timeline editor (single-clip, Descript-style) ────────────────
// The bulk auto path above is untouched. This pair of endpoints powers the
// manual timeline editor in the Narration Cutter: `analyzeCut` returns the data
// the browser needs to build the timeline (a dBFS energy envelope, word timings
// for transcript snippets, and an initial take segmentation), and
// `renderManualCut` renders the EXACT keep-segment list the editor computed —
// no re-detection — so what the user previewed is what gets produced. Parity is
// guaranteed because both sides derive segments from the same envelope via the
// shared `cutter/segments.ts` math and the render trims that explicit list.

// Per-step timeouts so the analyze job can NEVER hang forever. The Groq path is
// the historical offender (the whole file, no bound), so it gets the tightest
// budget and degrades to energy-only on timeout; the ffmpeg passes are fatal if
// they blow their (generous) budget. Overridable via env without a rebuild.
const envMs = (name: string, fallback: number): number => {
  const raw = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
const ANALYZE_TIMEOUTS = {
  resolve: () => envMs("ANALYZE_RESOLVE_MS", 60_000),
  probe: () => envMs("ANALYZE_PROBE_MS", 30_000),
  audio: () => envMs("ANALYZE_AUDIO_MS", 120_000),
  transcribe: () => envMs("ANALYZE_TRANSCRIBE_MS", 120_000),
  envelope: () => envMs("ANALYZE_ENVELOPE_MS", 180_000),
};

/**
 * Heuristic: is this a LONG, MESSY multi-take recording (where auto-finding the
 * coherent short is the right default), versus a short/simple clip (where the
 * existing keep-LAST per-part dedup is right and must not regress)? True when the
 * source is meaningfully longer than a short AND there are several big-block takes
 * — i.e. enough raw material that restarts / chatter are likely present. Tunable
 * via env so it can be calibrated on the server without a code change.
 */
function isLongMessyRecording(takes: Take[], duration: number): boolean {
  const minSeconds = envMs("FIND_SHORT_MIN_SOURCE_MS", 90_000) / 1000;
  const minTakes = Number.parseInt(process.env.FIND_SHORT_MIN_TAKES || "4", 10);
  const bigTakes = takes.filter((t) => t.enabled).length;
  return duration >= minSeconds && bigTakes >= minTakes;
}

/**
 * Drive the heavy analyze work for one job, narrating each stage onto the job
 * (which the editor polls) and into the server logs with elapsed ms. Transcription
 * is best-effort (timeout/failure → energy-only + a warning); resolve/probe/
 * envelope are fatal. Never throws — it records the outcome on the job.
 */
async function runAnalyzeJob(job: AnalyzeJob, sourceUrl: string): Promise<void> {
  const t0 = Date.now();
  const lap = (label: string, since: number) =>
    console.log(`[analyzeCut:${job.id}] ${label} (${Date.now() - since}ms, +${Date.now() - t0}ms)`);
  try {
    // ── resolve + probe (fatal) ──────────────────────────────────────────────
    setStage(job, "resolving");
    let ts = Date.now();
    const srcPath = await withTimeout(resolveInput(sourceUrl), ANALYZE_TIMEOUTS.resolve(), "loading the video");
    const meta = await withTimeout(probe(srcPath), ANALYZE_TIMEOUTS.probe(), "reading video metadata");
    const duration = meta.duration ?? 0;
    if (!duration) { failAnalyze(job, "Couldn't read the video — the file looks incomplete or unsupported (often a failed/partial upload). Re-upload and try again; MP4 or MOV work best."); return; }
    lap("resolved + probed", ts);

    // ── transcribe (best-effort: timeout/failure → energy-only + warning) ─────
    setStage(job, "transcribing");
    ts = Date.now();
    let words: { word: string; start: number; end: number }[] = [];
    let transcript = "";
    try {
      const audio = await withTimeout(
        extractAudioForTranscription(srcPath), ANALYZE_TIMEOUTS.audio(), "extracting audio");
      const tr = await withTimeout(
        transcribeWithGroq({ data: audio.buffer, name: audio.name, type: audio.type, wantWords: true }),
        ANALYZE_TIMEOUTS.transcribe(), "transcription (Groq)");
      words = tr.words;
      transcript = tr.text;
      lap(`transcribed ${words.length} words`, ts);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setWarning(job, `transcription unavailable: ${reason} — timeline has no transcript labels`);
      console.warn(`[analyzeCut:${job.id}] transcription unavailable (non-fatal, +${Date.now() - t0}ms): ${reason}`);
    }

    // ── waveform envelope (fatal) ─────────────────────────────────────────────
    setStage(job, "waveform");
    ts = Date.now();
    const envelope = await withTimeout(
      computeEnvelope(srcPath, duration), ANALYZE_TIMEOUTS.envelope(), "building the waveform");
    lap(`built waveform (${envelope.db.length} samples)`, ts);

    // ── initial segmentation ──────────────────────────────────────────────────
    setStage(job, "segmenting");
    const env: Envelope = { db: envelope.db, hop: envelope.hop, duration: envelope.duration };
    // Initial take segmentation at the defaults — the client re-segments live as
    // the user drags the controls, using the very same `segmentTakes` math. EVERY
    // detected take is returned (none dropped); short takes come back disabled.
    const takes = env.db.length > 0 ? segmentTakes(env, words, DEFAULT_SETTINGS) : [];

    // ── default selection: find the short (long/messy) OR keep-last dedup ───────
    // For a LONG, MESSY recording (many big takes covering a long source) the
    // single best default is the AUTO-DETECTED coherent short — one clean run of
    // the script with the earlier repeats, false starts and chatter dropped. For a
    // short/simple clip we keep the existing keep-LAST per-part dedup (no
    // regression). Either way this is just the server-computed DEFAULT disabled-set
    // the client merges with the live under-minTake rule + the user's toggles; the
    // user can re-run "Find the short" or fine-tune from the timeline. Best-effort:
    // any failure or missing key falls back to a deterministic text heuristic.
    setStage(job, "choosing");
    let takeDefaults: unknown[] = [];
    try {
      const ts2 = Date.now();
      // Always auto-run "Find the short" so the coherent final run is selected by
      // default on every clip (the user wants it automatic). selectCoherentShort
      // is a no-op for <2 takes and dedups cleanly for simple clips.
      const sel = await selectCoherentShort(takes);
      takeDefaults = sel.defaults;
      lap(`default selection (${sel.defaults.length} takes disabled, ${sel.usedAI ? "AI" : "heuristic"})`, ts2);
    } catch (e) {
      console.warn(`[analyzeCut:${job.id}] default selection failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    completeAnalyze(job, {
      sourceUrl,
      duration,
      hasAudio: meta.hasAudio,
      width: meta.width,
      height: meta.height,
      envelope: { db: envelope.db, hop: envelope.hop, floorDb: envelope.floorDb },
      words,
      transcript,
      takes,
      settings: DEFAULT_SETTINGS,
      takeDefaults,
    });
    console.log(
      `[analyzeCut:${job.id}] done in ${Date.now() - t0}ms — ${takes.length} takes, ` +
        `${words.length} words${job.warning ? " (energy-only: " + job.warning + ")" : ""}`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    failAnalyze(job, reason.slice(0, 200));
    console.error(`[analyzeCut:${job.id}] failed after ${Date.now() - t0}ms: ${reason}`);
  }
}

/**
 * Start analyzing one clip for the timeline editor. Returns a jobId IMMEDIATELY;
 * the heavy work (transcribe word timings, build a dBFS envelope, seed the take
 * segmentation) runs in the background with per-stage progress the editor polls
 * via `getAnalyzeCut`. Best-effort on transcription: with no GROQ key (or on a
 * timeout) it still returns the envelope + duration so the waveform, threshold
 * and gap controls work — just without transcript labels.
 */
const analyzeCut: Handler = async (input) => {
  const sourceUrl: string = input?.sourceUrl;
  if (!sourceUrl) throw new ZiteError({ code: "BAD_REQUEST", message: "sourceUrl is required." });
  const job = createAnalyzeJob();
  console.log(`[analyzeCut:${job.id}] queued for ${sourceUrl}`);
  // Fire-and-forget — runAnalyzeJob never throws (it records onto the job).
  void runAnalyzeJob(job, sourceUrl);
  return pollSnapshot(job);
};

/** Poll an analyze job for the timeline editor (stage, progress, warning, result). */
const getAnalyzeCut: Handler = async (input) => {
  const jobId: string = input?.jobId;
  if (!jobId) throw new ZiteError({ code: "BAD_REQUEST", message: "jobId is required." });
  const job = getAnalyzeJob(jobId);
  if (!job) {
    return {
      jobId, stage: "failed", stageLabel: "Failed", progress: 0, warning: null,
      result: null, error: "Analyze job not found (it may have expired) — reopen the editor to retry.",
    };
  }
  return pollSnapshot(job);
};

/**
 * Render the EXACT edit the timeline editor previewed. Accepts the explicit
 * ordered keep-segment list + the inter-take gap and renders precisely that
 * (the render path inserts the gap and applies the same micro-fades as the auto
 * path). No transcription, no take-detection, no silence re-detection — the
 * decision was already made client-side, so preview ↔ render parity is exact.
 */
const renderManualCut: Handler = async (input, userId) => {
  const sourceUrl: string = input?.sourceUrl;
  if (!sourceUrl) throw new ZiteError({ code: "BAD_REQUEST", message: "sourceUrl is required." });
  const rawSegs: Seg[] = Array.isArray(input?.segments) ? input.segments : [];
  const segments = rawSegs
    .filter((s) => Number.isFinite(s?.start) && Number.isFinite(s?.end) && s.end > s.start)
    .map((s) => ({ start: Math.max(0, s.start), end: s.end }))
    .sort((a, b) => a.start - b.start);
  if (segments.length === 0) throw new ZiteError({ code: "BAD_REQUEST", message: "No keep-segments to render." });
  const gap = Number.isFinite(input?.gap) ? Math.max(0, Math.min(2, input.gap)) : DEFAULT_SETTINGS.gap;
  const title: string = (input?.title && String(input.title)) || "Manual cut";

  const srcPath = await resolveInput(sourceUrl);
  const meta = await probe(srcPath);

  const rec = await NarrationCuts.create({
    record: { title, status: "Rendering", sourceUrl, outputUrl: null, user: userId, manual: true },
  });

  const spec: CutSpec = { source: srcPath, segments, hasAudio: meta.hasAudio, gap };
  const keptDuration = segments.reduce((s, seg) => s + (seg.end - seg.start), 0) + gap * Math.max(0, segments.length - 1);
  const jobId = createJob({ kind: "cut", manifest: spec, outputName: `${title}.mp4`, projectId: rec.id });
  db.prepare("UPDATE render_jobs SET duration_sec=? WHERE id=?").run(keptDuration, jobId);
  await NarrationCuts.update({ id: rec.id, record: { renderJobId: jobId, segments, gap } }).catch(() => {});
  pump();

  return { cutId: rec.id, jobId, expectedDuration: keptDuration };
};

/**
 * "Auto-cut / Find the short" — run the Stage-4 coherent-short selector over the
 * timeline's CURRENT big-chunk takes and return a DEFAULT disabled-set that keeps
 * only the single best coherent short (discarding earlier repeats, false starts,
 * and off-topic chatter), each excluded take tagged with a reason for the UI.
 *
 * The client sends the takes it already detected at the current settings (id +
 * span + text + whether each passed the Stage-1 big-block gate). The server runs
 * the AI pass (Claude, prompt-cached) and returns a `takeDefaults` list the client
 * applies through the SAME shared core (`applyDefaults`) — so the resulting
 * enabled-set is just a new default the user can fine-tune, and preview ↔ render
 * parity is preserved. Graceful: no Anthropic key (or any AI failure) falls back
 * to the deterministic keep-last selection, so the button always works.
 */
const findShortCut: Handler = async (input) => {
  const rawTakes: any[] = Array.isArray(input?.takes) ? input.takes : [];
  // Sanitize into the minimal Take shape the selector needs, in source order.
  const takes: Take[] = rawTakes
    .filter((t) => t && typeof t.id === "string" && Number.isFinite(t.start) && Number.isFinite(t.end) && t.end > t.start)
    .map((t) => ({
      id: t.id,
      start: t.start,
      end: t.end,
      text: typeof t.text === "string" ? t.text : "",
      enabled: t.enabled !== false,
    }))
    .sort((a, b) => a.start - b.start);
  if (takes.length === 0) {
    return { takeDefaults: [], usedAI: false, keptCount: 0 };
  }
  const { defaults, usedAI } = await selectCoherentShort(takes);
  const disabledIds = new Set(defaults.map((d) => d.id));
  const keptCount = takes.filter((t) => t.enabled && !disabledIds.has(t.id)).length;
  console.log(`[findShortCut] ${usedAI ? "AI" : "heuristic"} short: kept ${keptCount}/${takes.length} takes`);
  return { takeDefaults: defaults, usedAI, keptCount };
};

/** Poll a single manual-cut render job (by jobId) for the timeline editor. */
const getCutJob: Handler = async (input) => {
  const jobId: string = input?.jobId;
  if (!jobId) throw new ZiteError({ code: "BAD_REQUEST", message: "jobId is required." });
  const job = getJob(jobId);
  if (!job) return { status: "missing", progress: 0, outputUrl: null, error: "Job not found" };
  const outputUrl = job.status === "completed" && job.output_file ? `/api/outputs/${job.output_file}` : null;
  return {
    status: job.status,
    progress: job.progress ?? 0,
    outputUrl,
    error: job.status === "failed" || job.status === "canceled" ? (job.error ?? "Render failed") : null,
  };
};


// ── Background Jobs panel: list + Pause / Resume / Cancel ─────────────────────
// One global view over every background job. The render queue (render_jobs) has
// FULL pause/resume/cancel; the cutter's in-memory analyze jobs are SHOWN
// read-only (no controllable child here). The shapes are unified so the panel
// renders them the same way.

interface PanelJob {
  id: string;
  source: "render" | "analyze";
  type: string;
  title: string;
  status: "queued" | "active" | "paused" | "completed" | "failed" | "canceled";
  stage: string;
  progress: number;
  error: string | null;
  outputUrl: string | null;
  /** Which controls apply. Analyze jobs are read-only (all false). */
  controllable: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Map the analyze stage machine onto the unified panel status vocabulary. */
function analyzeStatus(stage: string): PanelJob["status"] {
  if (stage === "done") return "completed";
  if (stage === "failed") return "failed";
  if (stage === "queued") return "queued";
  return "active";
}

const listJobs: Handler = async (input) => {
  const recentLimit = Number.isFinite(input?.recentLimit) ? Math.max(1, Math.min(50, input.recentLimit)) : 12;
  const { active, recent } = listRenderJobs(recentLimit);

  const mapRender = (j: ReturnType<typeof listRenderJobs>["active"][number]): PanelJob => ({
    id: j.id,
    source: "render",
    type: j.type,
    title: j.title,
    status: j.status as PanelJob["status"],
    stage: j.stage,
    progress: j.progress,
    error: j.error,
    outputUrl: j.outputFile ? `/api/outputs/${j.outputFile}` : null,
    controllable: true,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  });

  const analyze = listAnalyzeJobs().map<PanelJob>((j) => {
    const status = analyzeStatus(j.stage);
    const terminal = status === "completed" || status === "failed" || status === "canceled";
    return {
      id: j.id,
      source: "analyze",
      type: "Narration analyze",
      title: "Analyzing clip",
      status,
      stage: j.stageLabel,
      progress: j.progress,
      error: j.error,
      outputUrl: null,
      controllable: false,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      _terminal: terminal,
    } as PanelJob & { _terminal: boolean };
  });

  const analyzeActive = (analyze as Array<PanelJob & { _terminal: boolean }>)
    .filter((j) => !j._terminal)
    .map(({ _terminal, ...j }) => j);
  const analyzeRecent = (analyze as Array<PanelJob & { _terminal: boolean }>)
    .filter((j) => j._terminal)
    .map(({ _terminal, ...j }) => j);

  return {
    active: [...active.map(mapRender), ...analyzeActive],
    recent: [...recent.map(mapRender), ...analyzeRecent]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, recentLimit),
    activeCount: active.length + analyzeActive.length,
  };
};

const pauseJob: Handler = async (input) => {
  const jobId: string = input?.jobId;
  if (!jobId) throw new ZiteError({ code: "BAD_REQUEST", message: "jobId is required." });
  const r = pauseRenderJob(jobId);
  if (!r.ok) throw new ZiteError({ code: "BAD_REQUEST", message: r.message ?? "Could not pause job." });
  return { ok: true, status: r.status };
};

const resumeJob: Handler = async (input) => {
  const jobId: string = input?.jobId;
  if (!jobId) throw new ZiteError({ code: "BAD_REQUEST", message: "jobId is required." });
  const r = resumeRenderJob(jobId);
  if (!r.ok) throw new ZiteError({ code: "BAD_REQUEST", message: r.message ?? "Could not resume job." });
  return { ok: true, status: r.status };
};

const cancelJob: Handler = async (input) => {
  const jobId: string = input?.jobId;
  if (!jobId) throw new ZiteError({ code: "BAD_REQUEST", message: "jobId is required." });
  const r = cancelRenderJob(jobId);
  if (!r.ok) throw new ZiteError({ code: "BAD_REQUEST", message: r.message ?? "Could not cancel job." });
  return { ok: true, status: r.status };
};


// ── Meme / Sticker editor (separate product) ─────────────────────────────────
// Lean pipeline: transcribe → popping captions (reused render path) → emphasis
// director (Claude picks ~1-sticker-per-4s moments + image prompts) → image gen
// (one funny static still per moment, cached) → manifest render that composites
// the stickers BELOW the captions via Remotion. No b-roll/screencast/stock/
// AI-video and runPipeline is never touched. Processed one at a time; polled via
// getMemeRun. AI cost is accounted per item (beginRun/finishRun) and surfaced in
// the Optimization Report (transcription + director + N images + sticker compute).

interface MemeItem {
  memeId: string;
  title: string;
  status: "Queued" | "Transcribing" | "Planning" | "Generating" | "Rendering" | "Complete" | "Error";
  outputUrl: string | null;
  error: string | null;
  momentsPlanned: number | null;
  stickers: number | null;
  captionsOnly: boolean;
  /** The randomly-chosen subtitle template for this render. */
  subtitleTemplate: string | null;
  /** User-visible reason stickers were skipped this run (or null). */
  skipReason: string | null;
  // ── Live progress (so the UI narrates every stage, not just a spinner) ──────
  /** Human sentence for the current stage ("Finding & reviewing stickers 3/8"). */
  stageLabel: string;
  /** 0..1 overall progress: the planning band, then the render job's own %. */
  progress: number;
  /** Structured per-moment counter for the active stage (or null). */
  stageDetail: { current: number; total: number } | null;
  /** Per-moment outcomes for the finished run (phrase + ok + reason). */
  momentResults: Array<{ phrase?: string; ok: boolean; reason?: string }>;
}
interface MemeRun {
  id: string;
  running: boolean;
  total: number;
  doneCount: number;
  items: MemeItem[];
  startedAt: number;
  finishedAt: number | null;
}
let memeRun: MemeRun | null = null;
let memeRunning = false;

async function runOneMeme(item: MemeItem, sourceUrl: string, userId: string): Promise<void> {
  beginRun(item.memeId);
  try {
    const result = await runMemePipeline({
      projectId: item.memeId,
      sourceUrl,
      userId,
      // Live progress: the pipeline narrates each stage + per-moment counter,
      // which we mirror straight onto the polled item so the UI shows it all.
      onStage: (p) => {
        item.status = p.stage;
        item.stageLabel = p.label;
        item.progress = Math.max(item.progress, p.progress); // monotonic
        item.stageDetail = p.detail ?? null;
      },
    });
    item.momentsPlanned = result.momentsPlanned;
    item.stickers = result.stickersWithImages;
    item.captionsOnly = result.captionsOnly;
    item.subtitleTemplate = result.subtitleTemplate;
    item.skipReason = result.diagnostics.skipReason;
    item.momentResults = result.diagnostics.imageResults;

    // Snapshot the optimization report (transcription + director + N images)
    // onto the meme record before the render queue runs. Render-time sticker
    // compute is merged in later by the worker (mergeRenderStats).
    let optimizationReportJson: string | undefined;
    try {
      const report = buildReport(item.memeId);
      if (report) { console.log(reportLogLine(report)); optimizationReportJson = JSON.stringify(report); }
    } catch { /* reporting is best-effort */ }

    await MemeProjects.update({
      id: item.memeId,
      record: {
        status: "Rendering",
        renderJobId: result.jobId,
        momentsPlanned: result.momentsPlanned,
        stickers: result.stickersWithImages,
        captionsOnly: result.captionsOnly,
        subtitleTemplate: result.subtitleTemplate,
        // Planning-stage diagnostics (moments, per-image outcomes, skip reason).
        // The render worker later overwrites stickerSkipReason with the COMPOSITE
        // outcome if the stage itself skipped (e.g. Chromium unavailable).
        stickerDiagnosticsJson: JSON.stringify(result.diagnostics),
        ...(result.diagnostics.skipReason ? { stickerSkipReason: result.diagnostics.skipReason } : {}),
        durationSeconds: result.durationSeconds,
        ...(optimizationReportJson ? { optimizationReportJson } : {}),
      },
    }).catch(() => {});

    item.status = "Rendering";
    // The render job's progress now spans the WHOLE pipeline: the main caption
    // render owns the front of the bar and the post-render sticker stage owns the
    // reserved tail (worker bands it). Map that 0..1 into the item's final
    // 0.95→1.0 band, and surface the worker's live sub-stage label ("Rendering
    // stickers 3/6" → "Compositing video…") so the bar keeps moving through the
    // slow compositing pass instead of parking at "Rendering & compositing 100%".
    const { outputUrl, error } = await waitForCutJob(result.jobId, (status, prog, stageLabel) => {
      item.stageLabel =
        status === "queued"
          ? "Rendering — waiting for a slot"
          : stageLabel || "Rendering captions";
      item.progress = Math.max(item.progress, 0.95 + 0.05 * Math.min(1, prog));
    });
    if (error || !outputUrl) throw new Error(error || "Render produced no output");

    await MemeProjects.update({ id: item.memeId, record: { status: "Complete", outputUrl } }).catch(() => {});
    item.outputUrl = outputUrl;
    item.status = "Complete";
    item.stageLabel = "Complete";
    item.progress = 1;
  } catch (e) {
    item.status = "Error";
    item.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    item.stageLabel = `Error: ${item.error}`;
    await MemeProjects.update({ id: item.memeId, record: { status: "Error", error: item.error } }).catch(() => {});
    console.warn(`[meme] ${item.title} failed: ${item.error}`);
  } finally {
    finishRun(item.memeId);
  }
}

// Create N meme records from uploaded narrations and kick the background run.
const createMeme: Handler = async (input, userId) => {
  if (memeRunning) {
    return { started: false, message: "A sticker run is already in progress.", run: memeRun };
  }
  const items: Array<{ sourceUrl: string; title?: string }> = Array.isArray(input?.items) ? input.items : [];
  if (items.length === 0) throw new ZiteError({ code: "BAD_REQUEST", message: "No videos provided." });

  const memeItems: MemeItem[] = [];
  const sources: string[] = [];
  for (const it of items) {
    if (!it.sourceUrl) continue;
    const rec = await MemeProjects.create({
      record: { title: it.title || "Meme short", status: "Queued", sourceUrl: it.sourceUrl, outputUrl: null, user: userId },
    });
    memeItems.push({
      memeId: rec.id, title: it.title || "Meme short", status: "Queued",
      outputUrl: null, error: null, momentsPlanned: null, stickers: null, captionsOnly: false,
      subtitleTemplate: null, skipReason: null,
      stageLabel: "Queued", progress: 0, stageDetail: null, momentResults: [],
    });
    sources.push(it.sourceUrl);
  }

  memeRun = {
    id: nanoidLike(),
    running: true,
    total: memeItems.length,
    doneCount: 0,
    items: memeItems,
    startedAt: Date.now(),
    finishedAt: null,
  };
  memeRunning = true;

  // Fire-and-forget: process ONE AT A TIME (gentle on the AI + image APIs).
  (async () => {
    for (let i = 0; i < memeRun!.items.length; i++) {
      await runOneMeme(memeRun!.items[i], sources[i], userId);
      memeRun!.doneCount++;
    }
    memeRun!.running = false;
    memeRun!.finishedAt = Date.now();
    memeRunning = false;
    console.log(`[meme] done — ${memeRun!.items.filter((x) => x.status === "Complete").length}/${memeRun!.total} complete`);
  })().catch((e) => {
    if (memeRun) { memeRun.running = false; memeRun.finishedAt = Date.now(); }
    memeRunning = false;
    console.error("[meme] run crashed:", e);
  });

  return { started: true, run: memeRun };
};

const getMemeRun: Handler = async () => ({ run: memeRun });

const getMemeProjects: Handler = async (_input, userId) => {
  const { records } = await MemeProjects.findAll({ filters: { user: userId }, limit: 200 });
  const memes = records.sort(sortByCreatedDesc).map((m) => ({
    id: m.id,
    title: m.title,
    status: m.status,
    outputUrl: m.outputUrl,
    sourceUrl: m.sourceUrl,
    momentsPlanned: m.momentsPlanned ?? null,
    stickers: m.stickers ?? null,
    stickersApplied: m.stickersApplied ?? null,
    captionsOnly: m.captionsOnly ?? false,
    subtitleTemplate: m.subtitleTemplate ?? null,
    stickerSkipReason: m.stickerSkipReason ?? null,
    durationSeconds: m.durationSeconds ?? null,
    error: m.error,
    createdAt: m.createdAt,
  }));
  return { memes };
};


/**
 * Deep-index a promo video using REAL frame analysis: extract 1 frame/second
 * and ask Claude vision what's actually on screen each second, then cache the
 * result on the video's contentIndexJson. Runs once per video (index/reindex),
 * never during a render — the director/retrieval reads the cached index.
 *
 * Falls back to coarse time-bucket segments if frame extraction or vision fails
 * (e.g. no ANTHROPIC key, unreachable video), so indexing never hard-blocks.
 */
const indexPromoVideo: Handler = async (input) => {
  const videoId: string = input.videoId ?? input.id;
  const video = await PromoVideos.findOne({ id: videoId });
  if (!video) throw new ZiteError({ code: "NOT_FOUND", message: "Promo video not found" });

  const productName = (video.productName as string) || "Unknown Product";
  const videoRef = (video.videoUrl as string) || "";
  if (!videoRef) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Promo video has no videoUrl to analyze." });
  }

  await PromoVideos.update({ id: videoId, record: { indexStatus: "Indexing" } });

  // Lazy import so tsc/runtime only load the vision modules when indexing runs.
  try {
    const { buildVisionIndex } = await import("../ai/visionIndex.js");
    const index = await buildVisionIndex({
      videoRef,
      productName,
      keywords: video.keywords as string | undefined,
      description: video.description as string | undefined,
    });
    const enrichedKw =
      index.totalKeywords.length > 0 ? index.totalKeywords.join(", ") : (video.keywords as string);
    await PromoVideos.update({
      id: videoId,
      record: {
        contentIndexJson: JSON.stringify(index),
        indexStatus: "Indexed",
        mediaKind: index.mediaKind,
        keywords: enrichedKw,
      },
    });
    console.log(
      `[indexPromoVideo:${videoId}] ✅ vision-indexed "${productName}" — ` +
        `${index.perSecond.length}s, ${index.segments.length} segments, mediaKind=${index.mediaKind}`
    );
    return {
      success: true,
      mode: "vision",
      segmentCount: index.segments.length,
      seconds: index.perSecond.length,
      mediaKind: index.mediaKind,
      bestFeatureMoments: index.bestFeatureMoments.length,
      bestProofMoments: index.bestProofMoments.length,
      bestHeroMoments: index.bestHeroMoments.length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[indexPromoVideo:${videoId}] vision indexing failed, using fallback: ${msg}`);
    // Coarse fallback: still give the retrieval usable segments.
    const dur = (video.durationSeconds as number) || input.durationEstimate || 30;
    const buckets = Math.max(3, Math.min(8, Math.round(dur / 5)));
    const bucketDur = dur / buckets;
    const kw = (video.keywords as string | undefined)?.split(",").map((k) => k.trim()).filter(Boolean) || [productName];
    const segments = Array.from({ length: buckets }, (_, i) => ({
      start: parseFloat((i * bucketDur).toFixed(2)),
      end: parseFloat(((i + 1) * bucketDur).toFixed(2)),
      summary: i === 0 ? `Opening — ${productName}` : `${productName} segment ${i + 1}`,
      featureLabel: productName,
      keywords: kw,
      visualType: i === 0 ? "landing_page" : "feature_demo",
      heroScore: i === 0 ? 70 : 40,
      proofScore: 40,
      embeddingText: `${productName} ${(video.description as string) || ""} ${kw.join(" ")}`.trim(),
      confidence: 0.3,
    }));
    await PromoVideos.update({
      id: videoId,
      record: {
        contentIndexJson: JSON.stringify({
          version: 3,
          indexedAt: new Date().toISOString(),
          mode: "fallback",
          productName,
          mediaKind: "mixed",
          perSecond: [],
          segments,
          bestFeatureMoments: [],
          bestProofMoments: [],
          bestHeroMoments: [],
          totalKeywords: kw,
        }),
        indexStatus: "Indexed",
      },
    });
    return { success: true, mode: "fallback", segmentCount: segments.length, seconds: 0, mediaKind: "mixed", error: msg };
  }
};

/**
 * Bulk vision-(re)index the whole promo library. Returns IMMEDIATELY and runs
 * the indexing in the background, flipping each video's indexStatus to
 * "Indexing" then "Indexed" as it goes — so the UI shows live per-video progress
 * (poll getPromoVideos) instead of one long blocking request. Sequential to keep
 * memory/cost bounded. By default skips already-vision-indexed videos; pass
 * { force: true } to redo all.
 */
let bulkIndexRunning = false;
// Live progress for the bulk re-index, polled by the promo dialog's progress bar.
interface ReindexProgress {
  running: boolean;
  total: number;       // videos in this run
  done: number;        // processed (indexed + failed)
  indexed: number;
  failed: number;
  current: string | null;   // product name being indexed now
  errors: Array<{ name: string; message: string }>;
  startedAt: number | null;
  finishedAt: number | null;
}
let reindexProgress: ReindexProgress = {
  running: false, total: 0, done: 0, indexed: 0, failed: 0,
  current: null, errors: [], startedAt: null, finishedAt: null,
};

const getReindexProgress: Handler = async () => ({ ...reindexProgress });

/**
 * Current vision-index standard. Bump this when the index shape/fields change
 * so older indexes are recognized as out-of-date and get re-indexed once.
 * v3 = vision mode with per-segment techScore + hasText (skip-intro-text).
 */
const INDEX_STANDARD_VERSION = 3;

/** True when a promo's cached index is a VISION index at the CURRENT standard
 *  (so it does not need re-indexing). Old/coarse/partial indexes return false. */
function isIndexCurrent(contentIndexJson: unknown): boolean {
  if (typeof contentIndexJson !== "string" || !contentIndexJson) return false;
  try {
    const idx = JSON.parse(contentIndexJson);
    if (idx?.mode !== "vision") return false;
    if ((idx?.version ?? 0) < INDEX_STANDARD_VERSION) return false;
    const segs = Array.isArray(idx?.segments) ? idx.segments : [];
    if (segs.length === 0) return false;
    // Every segment must carry the current-standard fields.
    return segs.every(
      (s: any) => typeof s?.techScore === "number" && typeof s?.hasText === "boolean"
    );
  } catch {
    return false;
  }
}

const reindexAllPromos: Handler = async (input, userId) => {
  if (bulkIndexRunning) {
    return { success: true, started: false, message: "Indexing is already running.", progress: { ...reindexProgress } };
  }
  const force = input?.force === true;
  const { records } = await PromoVideos.findAll({ limit: 1000 });

  // Decide the work set. Skip videos that are ALREADY at the current standard
  // (unless forced) and skip entries with no video to analyze.
  const todo: Array<{ id: string; name: string }> = [];
  let skippedCurrent = 0;
  let skippedNoVideo = 0;
  for (const v of records) {
    const name = (v.productName as string) || "Promo";
    if (!v.videoUrl) { skippedNoVideo++; continue; } // nothing to index
    if (!force && isIndexCurrent(v.contentIndexJson)) { skippedCurrent++; continue; }
    todo.push({ id: v.id, name });
    await PromoVideos.update({ id: v.id, record: { indexStatus: "Indexing" } });
  }
  console.log(`[reindexAllPromos] queued=${todo.length} skipped(current)=${skippedCurrent} skipped(no-video)=${skippedNoVideo} force=${force}`);

  // Nothing to do — everything is already at the current standard (or has no
  // video). Return immediately without spinning up a background run.
  if (todo.length === 0) {
    return { success: true, started: false, queued: 0, total: records.length, skippedCurrent, skippedNoVideo, upToDate: true };
  }

  bulkIndexRunning = true;
  reindexProgress = {
    running: true, total: todo.length, done: 0, indexed: 0, failed: 0,
    current: null, errors: [], startedAt: Date.now(), finishedAt: null,
  };

  // Fire-and-forget: do NOT await — the HTTP response returns right away.
  (async () => {
    for (const { id, name } of todo) {
      reindexProgress.current = name;
      try {
        const r = (await indexPromoVideo({ videoId: id }, userId)) as { mode?: string; error?: string };
        if (r?.mode === "vision") reindexProgress.indexed++;
        else {
          reindexProgress.failed++;
          reindexProgress.errors.push({ name, message: `Vision failed (used coarse index): ${r?.error ?? "unknown reason"}`.slice(0, 200) });
        }
      } catch (e) {
        reindexProgress.failed++;
        const message = e instanceof Error ? e.message : String(e);
        reindexProgress.errors.push({ name, message: message.slice(0, 160) });
        try {
          await PromoVideos.update({ id, record: { indexStatus: "Error" } });
        } catch {
          /* */
        }
        console.warn(`[reindexAllPromos] ${id} failed: ${message}`);
      }
      reindexProgress.done++;
      // Small stagger between videos so a big library doesn't hammer the API
      // (each video is many vision tokens) and trigger 529 overloads.
      await new Promise((r) => setTimeout(r, 600));
    }
    reindexProgress.running = false;
    reindexProgress.current = null;
    reindexProgress.finishedAt = Date.now();
    bulkIndexRunning = false;
    console.log(`[reindexAllPromos] done — indexed=${reindexProgress.indexed} failed=${reindexProgress.failed} of ${todo.length}`);
  })().catch((e) => {
    reindexProgress.running = false;
    reindexProgress.finishedAt = Date.now();
    bulkIndexRunning = false;
    console.error("[reindexAllPromos] background run crashed:", e);
  });

  return { success: true, started: todo.length > 0, queued: todo.length, total: records.length, skippedCurrent, skippedNoVideo };
};

/**
 * Save a promo video to the library.
 *
 * Library management must ALWAYS work (it's basic CRUD); the AI enrichment
 * (LLM keyword/description seeding + deep segment indexing) is a bonus. So we:
 *   1. create the record immediately from the filename (fast, never fails),
 *   2. then best-effort run the original endpoint via the bundle to enrich it.
 * If the bundle is unavailable or the AI keys are unset, the upload still
 * succeeds with filename-derived metadata.
 */
const savePromoVideo: Handler = async (input, userId) => {
  const fileName: string = input.fileName ?? input.filename ?? "promo.mp4";
  const rawName = fileName.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ").trim() || "Untitled";

  // 1. Always create the record so the library updates right away.
  const rec = await PromoVideos.create({
    record: {
      productName: rawName,
      videoUrl: input.videoUrl ?? input.url,
      addedAt: new Date().toISOString(),
      indexStatus: "Not Indexed",
    },
  });

  // 2. Best-effort AI enrichment (keywords, description, deep index). Never
  //    fails the upload — logs and moves on if the bundle/keys are missing.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    try {
      const mod = await loadPipeline();
      // The original endpoint creates its own record, so run it and adopt the
      // richer result; then remove our placeholder to avoid a duplicate.
      const enriched = (await mod.savePromoVideo(
        { ...input, fileName },
        { user: { id: userId, email: "you@clipmagic.local" } }
      )) as { videoId?: string } & Record<string, unknown>;
      if (enriched?.videoId && enriched.videoId !== rec.id) {
        await PromoVideos.delete({ id: rec.id });
        return enriched;
      }
      return enriched ?? { videoId: rec.id, productName: rawName, indexStatus: "Not Indexed" };
    } catch (e) {
      console.warn(
        `[savePromoVideo] AI enrichment skipped (kept basic record): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return { videoId: rec.id, productName: rawName, indexStatus: "Not Indexed" };
};

/**
 * Timeline waveform/beat-grid for a music track. The original endpoint
 * synthesizes peaks from the track's bpm/duration (no AI, no audio decode), so
 * we run it via the bundle with no key gate. If the bundle is unavailable, fall
 * back to a simple synthesized waveform so the timeline still renders.
 */
const getWaveform: Handler = async (input, userId) => {
  try {
    const mod = await loadPipeline();
    return await mod.getWaveform(input, { user: { id: userId, email: "you@clipmagic.local" } });
  } catch {
    const track = await MusicTracks.findOne({ id: input.trackId });
    const bpm = (track?.bpm as number) || 124;
    const duration = (track?.durationSeconds as number) || 60;
    const n = Math.max(60, Math.round(duration * 8));
    const peaks = Array.from({ length: n }, (_, i) =>
      Math.max(0.05, Math.min(1, 0.5 + 0.4 * Math.sin(i / 6) * Math.sin(i / 23)))
    );
    const beatDur = 60 / bpm;
    const beatGrid: number[] = [];
    for (let t = 0; t <= duration + beatDur; t += beatDur) beatGrid.push(parseFloat(t.toFixed(3)));
    return {
      peaks,
      bpm,
      duration,
      beatGrid,
      downbeats: beatGrid.filter((_, i) => i % 4 === 0),
      sectionMarkers: {},
    };
  }
};

// ── Kinovi B-roll generation (native port of src/api/generateShot.ts) ────────
const kinoviBase = () => process.env.ZITE_KINOVI_BASE_URL || "https://api.kinovi.ai";

const generateShot: Handler = async (input) => {
  const key = process.env.ZITE_KINOVI_API_KEY;
  if (!key) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Set ZITE_KINOVI_API_KEY to generate B-roll shots." });
  }
  const res = await fetch(`${kinoviBase()}/v1/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: input.prompt,
      model: input.kinoviModel || "kinovi-1",
      duration: input.durationSeconds || 5,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new ZiteError({
      code: "INTERNAL_ERROR",
      message: `Kinovi error (${res.status}): ${data?.error?.message || JSON.stringify(data)}`,
    });
  }
  const taskId = data.taskId ?? data.id;
  if (input.shotId && taskId) {
    await Shots.update({ id: input.shotId, record: { kinoviTaskId: taskId, captureStatus: "Capturing" } });
  }
  return { success: true, taskId, status: data.status ?? "pending" };
};

// Poll Kinovi task status for any B-Roll shots still generating in a project.
//
// IMPORTANT: B-roll tasks are created by the bundled captureShots via
// `createSeedanceTask` (POST https://kinovi.ai/api/v1/jobs/createTask) which
// returns a task_id stored INSIDE the shot's uiLabelsJson as `kinoviTaskId`.
// Status is read from `…/v1/jobs/recordInfo?taskId=…`. The previous version
// polled a different endpoint, read kinoviTaskId as a top-level column, and
// returned {status, ready, shots} — none of which matched, so the UI's
// `result.pending === 0` check never fired and it span on "checking every 5s…"
// forever even after Kinovi finished. The shape below matches the frontend
// (ProcessingPage reads result.pending/done/failed).
const kinoviJobsBase = () => process.env.ZITE_KINOVI_JOBS_URL || "https://kinovi.ai/api";

const pollBrollStatus: Handler = async (input) => {
  const key = (process.env.ZITE_KINOVI_API_KEY ?? "").trim();
  if (!input.projectId) return { pending: 0, done: 0, failed: 0 };

  const { records } = await Shots.findAll({ filters: { project: input.projectId }, limit: 200 });
  const capturing = records.filter(
    (s) => s.shotType === "B-Roll" && s.captureStatus === "Capturing"
  );

  if (capturing.length === 0) {
    // Nothing pending — make sure the project status reflects completion.
    await Projects.update({ id: input.projectId, record: { status: "Complete" } }).catch(() => {});
    return { pending: 0, done: 0, failed: 0 };
  }

  let pending = 0;
  let done = 0;
  let failed = 0;

  await Promise.all(
    capturing.map(async (shot) => {
      let labels: Record<string, any> = {};
      try {
        if (shot.uiLabelsJson) labels = JSON.parse(shot.uiLabelsJson as string);
      } catch {
        /* */
      }
      // captureShots stores the id in uiLabelsJson; tolerate a legacy top-level field too.
      const taskId = labels.kinoviTaskId ?? (shot as any).kinoviTaskId;

      if (!taskId || !key) {
        await Shots.update({ id: shot.id, record: { captureStatus: "Error" } });
        failed++;
        return;
      }

      try {
        const pr = await fetch(
          `${kinoviJobsBase()}/v1/jobs/recordInfo?taskId=${encodeURIComponent(String(taskId))}`,
          { headers: { Authorization: `Bearer ${key}` } }
        );
        const rawText = await pr.text().catch(() => "");
        if (!pr.ok) {
          pending++; // transient — keep polling
          return;
        }
        let pd: any = {};
        try {
          pd = JSON.parse(rawText);
        } catch {
          pending++;
          return;
        }
        const st = String(pd.status ?? pd.state ?? "").toLowerCase();
        const outputUrl = Array.isArray(pd.output) ? pd.output[0]?.url : pd.output?.url;
        const videoUrl = pd.video_url ?? pd.videoUrl ?? pd.output_url ?? outputUrl;

        if ((st === "success" || st === "succeeded" || st === "completed") && videoUrl) {
          await Shots.update({
            id: shot.id,
            record: {
              clipUrl: videoUrl,
              captureStatus: "Done",
              uiLabelsJson: JSON.stringify({ ...labels, brollTrack: "generated" }),
            },
          });
          done++;
        } else if (st === "fail" || st === "failed" || st === "error") {
          await Shots.update({ id: shot.id, record: { captureStatus: "Error" } });
          failed++;
        } else {
          pending++; // queued / processing
        }
      } catch {
        pending++; // transient network error — keep polling
      }
    })
  );

  if (pending === 0) {
    await Projects.update({ id: input.projectId, record: { status: "Complete" } }).catch(() => {});
  }
  return { pending, done, failed };
};

const testKinoviApi: Handler = async () => {
  const key = process.env.ZITE_KINOVI_API_KEY;
  if (!key) {
    return { success: false, message: "Kinovi API key not set. Add ZITE_KINOVI_API_KEY to enable shot generation." };
  }
  try {
    const res = await fetch(`${kinoviBase()}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    return { success: res.ok, message: res.ok ? "Kinovi API reachable." : `Kinovi returned HTTP ${res.status}.` };
  } catch (e) {
    return { success: false, message: "Could not reach Kinovi: " + (e instanceof Error ? e.message : String(e)) };
  }
};

// ── Postiz settings (write-only secrets for the social-poster container) ─────
// The suite manages the Postiz container's config + per-platform OAuth keys.
// WRITE-ONLY: no handler here ever returns a secret value — only configured-state.
const getPostizSettings: Handler = async () => {
  const { keys, envFileWritable } = getPostizSettingsStore();
  return { keys, envFileWritable, dockerSocketAvailable: dockerSocketAvailable() };
};

const updatePostizSettings: Handler = async (input) => {
  // Accepts { values: { KEY: "value" | "" | null }, remove?: [KEY] }. Empty
  // string = unchanged; null or `remove` = delete. Returns configured-state only.
  const result = updatePostizSettingsStore({
    values: input?.values ?? {},
    remove: Array.isArray(input?.remove) ? input.remove : [],
  });
  return result;
};

const restartPostiz: Handler = async () => restartPostizContainer();

// ── Bulk Scheduler (push SEO-optimized scheduled posts into Postiz) ──────────
// These talk to Postiz's PUBLIC API via the server-only API key (never sent to
// the browser). status gates the UI; channels lists connected integrations;
// preview returns the full plan WITHOUT posting; schedule actually creates the
// scheduled posts and reports per-item success/failure.
const getBulkSchedulerStatus: Handler = async () => {
  const status = await bulkSchedulerStatus();
  // Report which cloud-folder providers are configured (drives the Drive/Dropbox
  // browse tabs in the UI). Booleans only — no keys ever leave the server.
  return { ...status, cloudProviders: cloudProvidersConfigured() };
};

const getBulkSchedulerChannels: Handler = async () => {
  const channels = await bulkSchedulerChannels();
  return { channels };
};

/**
 * Browse a public Google Drive / Dropbox FOLDER and return its videos as
 * ready-to-add cloud sources (each `source.ref` is a DIRECT media URL). The
 * cloud client surfaces missing-credential / bad-folder errors with actionable
 * messages; never logs or returns the credentials themselves.
 */
const listCloudFolderHandler: Handler = async (input) => {
  const provider = String(input?.provider ?? "");
  const folder = String(input?.folder ?? "");
  const items = await listCloudFolder(provider, folder);
  return { items };
};

const previewBulkSchedule: Handler = async (input) =>
  bulkSchedulerPreview({
    files: Array.isArray(input?.files) ? input.files : [],
    channelIds: Array.isArray(input?.channelIds) ? input.channelIds : [],
    intent: input?.intent,
    timezone: input?.timezone,
    now: input?.now,
    maxPerDay: typeof input?.maxPerDay === "number" ? input.maxPerDay : undefined,
  });

const runBulkSchedule: Handler = async (input) =>
  bulkSchedulerSchedule({ posts: Array.isArray(input?.posts) ? input.posts : [] });

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
  getPostizSettings,
  updatePostizSettings,
  restartPostiz,
  // Bulk Scheduler
  getBulkSchedulerStatus,
  getBulkSchedulerChannels,
  previewBulkSchedule,
  runBulkSchedule,
  listCloudFolder: listCloudFolderHandler,
  getPromoVideos,
  getPromoIndex,
  exportPromoIndexes,
  savePromoVideo,
  updatePromoVideo,
  deletePromoVideo,
  importPromoIndex,
  reindexAllPromos,
  getReindexProgress,
  getDownloadUrl,
  // render
  submitRendiJob,
  pollRendiStatus,
  renderVideo,
  // pollers / status
  pollBrollStatus,
  testKinoviApi,
  // stage-2 AI
  runPipeline,
  generateShot,
  captureShots,
  recaptureShot,
  reviewEdit,
  indexPromoVideo,
  // bulk narration → full pipeline + render
  createBulkNarration,
  getBulkRun,
  createBulkCut,
  getCutRun,
  getNarrationCuts,
  analyzeCut,
  getAnalyzeCut,
  findShortCut,
  renderManualCut,
  getCutJob,
  // background jobs panel
  listJobs,
  pauseJob,
  resumeJob,
  cancelJob,
  createMeme,
  getMemeRun,
  getMemeProjects,
  validateAssets: async () => ({ ok: true, errors: [] }),
  getWaveform,
  // storage management
  listStorage,
  deleteStorageFiles,
  deleteStorageArea,
};

void config;
