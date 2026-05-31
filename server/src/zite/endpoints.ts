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
    // AI pipeline configuration (so the UI / curl can confirm keys are live).
    transcriptionConfigured: !!process.env.GROQ_API_KEY,
    directorConfigured: !!process.env.ANTHROPIC_API_KEY,
    kinoviConfigured: !!process.env.ZITE_KINOVI_API_KEY,
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
async function runBundled(name: "runPipeline" | "captureShots" | "recaptureShot", input: unknown, userId: string) {
  if (!process.env.GROQ_API_KEY) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "Transcription is not configured. Set GROQ_API_KEY on the server to enable it.",
    });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "The AI director is not configured. Set ANTHROPIC_API_KEY on the server to enable it.",
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
    return { success: true, mode: "fallback", segmentCount: segments.length, seconds: 0, mediaKind: "mixed" };
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

const reindexAllPromos: Handler = async (input, userId) => {
  if (bulkIndexRunning) {
    return { success: true, started: false, message: "Indexing is already running." };
  }
  const force = input?.force === true;
  const { records } = await PromoVideos.findAll({ limit: 1000 });

  // Decide the work set now, and mark them queued so the UI reflects it at once.
  const todo: string[] = [];
  for (const v of records) {
    let alreadyVision = false;
    if (!force && v.contentIndexJson) {
      try {
        alreadyVision = JSON.parse(v.contentIndexJson as string)?.mode === "vision";
      } catch {
        /* not vision */
      }
    }
    if (!alreadyVision) {
      todo.push(v.id);
      await PromoVideos.update({ id: v.id, record: { indexStatus: "Indexing" } });
    }
  }

  bulkIndexRunning = true;
  // Fire-and-forget: do NOT await — the HTTP response returns right away.
  (async () => {
    let indexed = 0;
    let failed = 0;
    for (const id of todo) {
      try {
        const r = (await indexPromoVideo({ videoId: id }, userId)) as { mode?: string };
        if (r?.mode === "vision") indexed++;
        else failed++;
      } catch (e) {
        failed++;
        try {
          await PromoVideos.update({ id, record: { indexStatus: "Error" } });
        } catch {
          /* */
        }
        console.warn(`[reindexAllPromos] ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    bulkIndexRunning = false;
    console.log(`[reindexAllPromos] done — indexed=${indexed} failed=${failed} of ${todo.length}`);
  })().catch((e) => {
    bulkIndexRunning = false;
    console.error("[reindexAllPromos] background run crashed:", e);
  });

  return { success: true, started: true, queued: todo.length, total: records.length };
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
  if (process.env.ANTHROPIC_API_KEY) {
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

// Poll Kinovi task status for any shots still generating in a project.
const pollBrollStatus: Handler = async (input) => {
  const key = process.env.ZITE_KINOVI_API_KEY;
  if (!key || !input.projectId) return { status: "idle", ready: false, shots: [] };
  const { records } = await Shots.findAll({ filters: { project: input.projectId } });
  const pending = records.filter((s) => s.kinoviTaskId && s.captureStatus !== "Done");
  const shots: Array<{ shotId: string; status: string; clipUrl?: string }> = [];
  for (const shot of pending) {
    try {
      const res = await fetch(`${kinoviBase()}/v1/tasks/${shot.kinoviTaskId}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      const data = (await res.json().catch(() => ({}))) as any;
      const status = data.status ?? "pending";
      if ((status === "completed" || status === "succeeded") && (data.videoUrl || data.url)) {
        const clipUrl = data.videoUrl || data.url;
        await Shots.update({ id: shot.id, record: { clipUrl, captureStatus: "Done" } });
        shots.push({ shotId: shot.id, status: "Done", clipUrl });
      } else if (status === "failed" || status === "error") {
        await Shots.update({ id: shot.id, record: { captureStatus: "Error" } });
        shots.push({ shotId: shot.id, status: "Error" });
      } else {
        shots.push({ shotId: shot.id, status: "Capturing" });
      }
    } catch {
      shots.push({ shotId: shot.id, status: "Capturing" });
    }
  }
  const stillPending = shots.some((u) => u.status === "Capturing");
  return { status: stillPending ? "capturing" : "idle", ready: !stillPending, shots };
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
  getPromoIndex,
  savePromoVideo,
  updatePromoVideo,
  deletePromoVideo,
  importPromoIndex,
  reindexAllPromos,
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
  indexPromoVideo,
  validateAssets: async () => ({ ok: true, errors: [] }),
  getWaveform,
};

void config;
