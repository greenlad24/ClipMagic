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
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Projects, Shots, MusicTracks, PromoVideos, NarrationCuts, MemeProjects, ZiteError } from "./store.js";
// Avatar Narrator (LAB tool)
import * as avatarStore from "../db/avatar.js";
import { listProviders as listAvatarProviders } from "../avatar/providers.js";
import {
  ttsConfigured,
  defaultVoice,
  GEMINI_VOICES,
  cloneVoice,
  designVoice,
  VOICE_AUDITION_TEXT,
  VOICE_SETTINGS,
  ELEVENLABS_MODELS,
  resolveVoiceSettings,
  synthesize as synthesizeNarration,
} from "../avatar/tts.js";
import { generatePortrait, editPortrait, generateCharacterSheet, placeInRoom, coercePortraitAspect, DEFAULT_SCENE_PROMPT } from "../avatar/portrait.js";
import { CAPTURE_MEDIUMS, FRAMINGS, LOOK_PRESETS, describeCharacter, findPreset } from "../avatar/look.js";
import { availableRooms } from "../avatar/rooms.js";
import {
  startVideo as startAvatarVideo,
  cancelVideo as cancelAvatarVideo,
  retryVideo as retryAvatarVideo,
} from "../avatar/pipeline.js";
import {
  estimateCost as estimateAvatarCost,
  coerceProvider as coerceAvatarProvider,
  coerceResolution as coerceAvatarResolution,
  coerceTtsProvider,
  TTS_PROVIDER_IDS,
  type TtsProviderId,
} from "../avatar/types.js";
import { listStorage, deleteStorageFiles, deleteStorageArea } from "./storage.js";
import { pruneSystemStorage } from "./systemStorage.js";
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
import { stickerSoundState, installCustomSfx, clearCustomSfx, setCustomSfxSpeed } from "../meme/sfx.js";
import {
  getSettings as getPostizSettingsStore,
  updateSettings as updatePostizSettingsStore,
  restartPostiz as restartPostizContainer,
  dockerSocketAvailable,
  getDataForSeoCreds,
} from "../settings/postizSecrets.js";
import {
  getStatus as bulkSchedulerStatus,
  listChannels as bulkSchedulerChannels,
  preview as bulkSchedulerPreview,
  schedule as bulkSchedulerSchedule,
} from "../postiz/bulkScheduler.js";
import { listCloudFolder, cloudProvidersConfigured } from "../postiz/cloudSources.js";
import {
  autoScreencast as runAutoScreencast,
  recaptureScreencastShot,
  autoScreencastPipelineStep,
} from "../capture/autoScreencast.js";
import { chromiumAvailable } from "../capture/chromium.js";
import { nanoBananaConfigured } from "../thumbnails/nanoBanana.js";
import { coerceMode } from "../thumbnails/imageProviders.js";
import {
  imageChatConfigured,
  optimizeImagePrompt,
  generateChatImage as runChatImage,
  coerceChatModel,
  coerceAspect,
  chatModelLabel,
} from "../imagechat/imageChat.js";
import { anthropicConfigured } from "../ai/claude.js";
import {
  persistImage,
  listImages as listImageHistoryItems,
  deleteImage as deleteImageHistoryRow,
} from "../db/imageHistory.js";
import { searchTopThumbnails, youtubeConfigured } from "../thumbnails/youtube.js";
import {
  listCharacters,
  saveCharacter,
  saveCustomCharacter,
  deleteCharacter,
  uploadedExpressions,
  isBuiltinExpression,
  isValidExpressionId,
} from "../thumbnails/characters.js";
import {
  listBackgrounds,
  saveBackground,
  deleteBackground,
  uploadedBackgrounds,
} from "../thumbnails/backgrounds.js";
import { fontStatus, saveFont, deleteFont } from "../thumbnails/fonts.js";
import {
  generateThumbnailVariants,
  startThumbnailJob,
  startContrarianJob,
  planContrarianVariations,
  planRecreations,
  planCustomEdit,
  recompositeContrarian,
} from "../thumbnails/orchestrate.js";
import { generateTitles } from "../thumbnails/titles.js";
import { probeCompositeAvailable } from "../thumbnails/composite.js";
import { restyleContrarianText as restyleContrarian, recompositeRecreation } from "../thumbnails/recreate.js";
import {
  getJob as getThumbnailJob,
  snapshot as thumbnailJobSnapshot,
  cancelJob as cancelThumbnailJobById,
  cancelAllJobs as cancelAllThumbnailJobs,
} from "../thumbnails/jobs.js";
import { analyzeScript } from "../thumbnails/scriptAnalysis.js";
import { isVideoType, type VideoType } from "../thumbnails/videoType.js";
import { startResearch, getResearchSnapshot, refreshRunVolume, fetchKeywordCompetitors } from "../keyword/run.js";
import {
  listRuns as listKeywordRuns,
  hydrateRun,
  deleteRun as deleteKeywordRun,
  updateRun as updateKeywordRun,
  setRunPinned,
} from "../db/keywordResearch.js";
import {
  listFolders as listFavFoldersDb,
  createFolder as createFavFolderDb,
  renameFolder as renameFavFolderDb,
  deleteFolder as deleteFavFolderDb,
  getFolder as getFavFolderDb,
  getFavoritesView,
  addTitle as addFavTitleDb,
  removeTitle as removeFavTitleDb,
  updateTitle as updateFavTitleDb,
  getTitle as getFavTitleDb,
  addKeyword as addFavKeywordDb,
  removeKeyword as removeFavKeywordDb,
  updateKeyword as updateFavKeywordDb,
} from "../db/favorites.js";
import { extractKeywordsFromTitles as aiExtractKeywordsFromTitles } from "../keyword/ai.js";
import type { FavKeyword, FavKeywordSource } from "../keyword/favorites.js";
import type { ResearchInput, ResearchMode } from "../keyword/types.js";
import { aiConfig } from "../ai/config.js";
import {
  startScript as runStartScript,
  continueScript as runContinueScript,
  getScriptSnapshot,
  refineParagraph as runRefineParagraph,
} from "../scriptgen/run.js";
import {
  getRun as getScriptRunDb,
  listRuns as listScriptRunsDb,
  deleteRun as deleteScriptRunDb,
} from "../db/scriptRuns.js";
import type { ScriptInput, ScriptSetup } from "../scriptgen/types.js";
import { startPlan as runStartPlan, planJobStatus as getPlanSnapshot } from "../planner/run.js";
import {
  startAudit as runStartAudit,
  resumeAudit as runResumeAudit,
  auditJobStatus as getAuditSnapshot,
  withAuditUsage,
} from "../audit/run.js";
import {
  getRun as getAuditRunRow,
  listRuns as listAuditRunRows,
  deleteRun as deleteAuditRunRow,
} from "../db/auditRuns.js";
import type { AuditInput, AuditRunResult, MarketProposal } from "../audit/types.js";
import { ytAnalyticsConfigured, ytAnalyticsConnected } from "../audit/analytics.js";
import { chatAboutAudit, refocusReport } from "../audit/chat.js";
import { buildSection } from "../audit/sections.js";
import {
  browserAvailable as skoolBrowserAvailable,
  checkSkoolLogin,
  closeSkool,
  importSkoolCookies,
  isSkoolOpen,
} from "../skool/browser.js";
import {
  finishInventory,
  getInventory,
  getSkoolSettings,
  latestCompleteInventory,
  latestInventory,
  saveSkoolSettings,
  setInventoryProgress,
  startInventory,
  setLessonProgress,
  updatePlanData,
  // Aliased: the long-form planner already owns startPlan/getPlan in this file.
  finishPlan as finishSkoolPlan,
  getPlan as getSkoolPlan,
  latestPlan as latestSkoolPlan,
  startPlan as startSkoolPlan,
} from "../db/skool.js";
import { readClassroom, readCourse, readFullClassroom } from "../skool/classroom.js";
import { probeSkool } from "../skool/probe.js";
import { readEmailNotify, setEmailNotify } from "../skool/emailNotify.js";
import { dryPublish } from "../skool/publishProbe.js";
import { attachToComposer } from "../skool/attachments.js";
import {
  writeLessonForNewVideo,
  nextVideoNeedingLesson,
  listVideoLessons,
} from "../skool/videoLessons.js";
import { isChannelVideo, youtubeUrl } from "../skool/channelVideos.js";
import * as skoolConsole from "../skool/console.js";
import * as skoolActions from "../skool/actions.js";
import { writePlanLessons } from "../skool/lessons.js";
import { buildRebuild } from "../skool/rebuild.js";
import { deleteRecipe, getRecipe, listRecipes, saveRecipe, type RecipeStep } from "../skool/recipes.js";
import { runPlan } from "../skool/planRun.js";
import { readFeed, readPost, unreadChatCount, SKOOL_CATEGORIES } from "../skool/community.js";
import { allLessons, classroomOutline, indexedCourses, retrieve } from "../skool/knowledge.js";
import { backfillTranscripts, transcriptCoverage } from "../skool/transcripts.js";
import { createPost, replyToComment, taughtPostAction } from "../skool/engageActions.js";
import { answerable, readComments } from "../skool/comments.js";
import { needingReply, readChannels, readMessages, sendDm, type DmChannel } from "../skool/dms.js";
import { draftPost, draftReply, styleExamplesFrom } from "../skool/engageGen.js";
import {
  getSchedule,
  listPinnedSubjects,
  pinSubject,
  setSchedule,
  unpinSubject,
  listSlots,
  publishSlot,
  tickNow,
  localNow,
  chooseSubject,
  emailDayFor,
  schedulerHealth,
  type Weekday,
} from "../skool/engageSchedule.js";
import { firstNameOf } from "../skool/engageGen.js";
import {
  getReplyConfig,
  setReplyConfig,
  replyAgentStatus,
  runReplySweep,
  collectTargets,
  sendDraftedReply,
  forgetReply,
  listReplies,
} from "../skool/engageReplies.js";
import {
  saveMarket as saveAuditMarket,
  listMarkets as listAuditMarkets,
  deleteMarket as deleteAuditMarket,
  recordApplied,
  unrecordApplied,
  listApplied,
  recordCheck,
} from "../db/auditMarkets.js";
import { fetchVideoStats } from "../thumbnails/youtube.js";
import { nanoid as auditNanoid } from "nanoid";
import { updateRun as updateAuditRun } from "../db/auditRuns.js";
import { PLANNER_MODEL } from "../planner/client.js";
import {
  getRun as getPlanRunDb,
  listRuns as listPlanRunsDb,
  deleteRun as deletePlanRunDb,
} from "../db/planRuns.js";
import type { PlanInput } from "../planner/types.js";
import {
  listChannels as listEngageChannels,
  setChannelMode as setEngageChannelMode,
  listInbox as listEngageInbox,
  listThreads as listEngageThreads,
  getInboxItem as getEngageInboxItem,
  getThread as getEngageThread,
  getReplyForInbox as getEngageReplyForInbox,
  getSettings as getEngageSettings,
  setSettings as setEngageSettings,
  countsByPlatform as engageCountsByPlatform,
  totalCount as engageTotalCount,
  newCount as engageNewCount,
  getChannel as getEngageChannel,
  createReply as createEngageReply,
  getReply as getEngageReply,
  updateReply as updateEngageReply,
  listReplies as listEngageReplies,
  hasReply as hasEngageReply,
  latestReplyFor as latestEngageReplyFor,
  setInboxReplyState as setEngageInboxReplyState,
} from "../engage/db.js";
import { youtubeConfigured as engageYoutubeConfigured } from "../engage/youtube.js";
import { metaConfigured as engageMetaConfigured } from "../engage/metaGraph.js";
import { tiktokConfigured as engageTiktokConfigured } from "../engage/tiktok.js";
import { seedChannelsFromConnected } from "../engage/seed.js";
import { pollOnce as engagePollOnce, refreshAllChannelStats as engageRefreshAllChannelStats } from "../engage/monitor.js";
import { getRegistry as getEngageRegistry } from "../engage/registry.js";
import { replyCycleNow, replyWorkerState } from "../engage/replyWorker.js";
import { dryRunEnabled as engageDryRun, sendReply as engageSendReplyNow } from "../engage/senders.js";
import {
  canSend as engageCanSend,
  recordSend as engageRecordSend,
  scheduleAt as engageScheduleAt,
  usage as engageThrottleUsage,
} from "../engage/throttle.js";
import { generateReply as engageGenerateReply, replyGenReady } from "../engage/replyGen.js";
import { VIEWPORT as ENGAGE_VIEWPORT, BROWSER_PLATFORMS, isBrowserPlatform } from "../engage/browser.js";
import * as engageConsole from "../engage/browserSession.js";
import { parseCookies } from "../engage/cookies.js";
import { anthropicConfigured as engageAiConfigured } from "../ai/claude.js";
import type {
  EngageStatus,
  ListInboxInput,
  ListThreadsInput,
  ThreadSort,
  ReplyMode,
  InboxKind,
  Platform as EngagePlatform,
  ReplyState,
  ReplyStatus,
  ReplyQueueEntry,
  ReplyStatusOutput,
  BrowserFrameOutput,
} from "../engage/types.js";

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
      // Per-video auto-screencast toggle (same pattern). Default ON; the pipeline
      // captures the director's Pending Screencast shots into real recordings
      // unless the user switched this off or SCREENCAST_DISABLED=1 globally.
      autoScreencast: input.autoScreencast === false ? false : true,
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
    // Auto-Screencast is usable when a real Chromium binary exists here (the same
    // browser Remotion uses) — the engine drives it via puppeteer-core.
    screencastConfigured: chromiumAvailable(),
    // Whether automatic in-pipeline screencast capture is globally force-disabled
    // (SCREENCAST_DISABLED=1). Default is on, gated per-video by the create toggle.
    autoScreencastDisabled: config.autoScreencastDisabled,
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

/**
 * captureShots assigns media to every shot. Just BEFORE it runs (and well before
 * the render reads each shot's clipUrl), we automatically capture the director's
 * Pending `Screencast` shots — and plan a few extra moments — into REAL website
 * recordings, mirroring the per-video motion-graphics gate.
 *
 * Why here, inline + awaited: the render manifest is built later from each shot's
 * captureStatus/clipUrl, so a real capture MUST finish first. A Screencast shot
 * we mark Done (with a clipUrl) is then SKIPPED by the bundled captureShots
 * (which short-circuits on captureStatus === 'Done'), so it never also receives
 * stock/Veo3 b-roll — that's the mutual exclusion, enforced for free. Any shot we
 * leave Pending/Error (site failed, Chromium absent, budget exceeded) flows
 * through captureShots' existing promo-retrieval / talking-head fallback exactly
 * as before this feature existed, so generation never breaks.
 *
 * Best-effort: gated by the per-video toggle + global SCREENCAST_DISABLED + a
 * Chromium probe, bounded by an overall budget, and wrapped so any failure is
 * logged and generation proceeds.
 */
const captureShots: Handler = async (input, userId) => {
  // Capture the director's Pending Screencast shots (and a few planned moments)
  // into real recordings BEFORE the bundled captureShots assigns media. Isolated:
  // never throws, no-ops when off/unconfigured. See autoScreencastPipelineStep.
  await autoScreencastPipelineStep(input?.projectId, userId, {
    chromiumAvailable,
    findProject: (id) => Projects.findOne({ id }),
  });
  return runBundled("captureShots", input, userId);
};
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

  // Batch-wide feature toggles (both default OFF). createProject persists `false`
  // only when explicitly false, so pass the booleans straight through per video.
  const motionGraphics = input?.motionGraphics === true;
  const autoScreencast = input?.autoScreencast === true;

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
        motionGraphics,
        autoScreencast,
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

// ── The sticker SOUND ────────────────────────────────────────────────────────
// The pop that plays as each sticker slaps on. There is a generated default, and
// the user can upload their own instead — the upload goes through the ordinary
// /api/uploads route first, then this hands the resulting URL to installCustomSfx,
// which conforms it to the mix (48kHz stereo, trimmed, peak-normalised). Storing
// only a conformed copy means a render can never be broken by an odd sample rate
// or a twenty-second file.

const getStickerSound: Handler = async () => ({ sound: await stickerSoundState() });

const setStickerSound: Handler = async (input) => {
  const url: string = input?.url;
  const name: string = typeof input?.name === "string" && input.name.trim() ? input.name.trim() : "Custom sound";
  if (!url) throw new ZiteError({ code: "BAD_REQUEST", message: "url is required." });
  let sourceFile: string;
  try {
    sourceFile = await resolveInput(url);
  } catch (e) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: `Could not read that upload: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  try {
    // A rate may ride along with the upload, so replacing a sound keeps the
    // speed the page is already showing instead of silently snapping to 1×.
    await installCustomSfx(sourceFile, name, input?.speed);
  } catch (e) {
    // installCustomSfx throws messages written FOR the user (e.g. "no audio track").
    throw new ZiteError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
  }
  return { sound: await stickerSoundState() };
};

/** Change how fast the uploaded sound plays — re-derived from the kept original. */
const setStickerSoundSpeed: Handler = async (input) => {
  if (input?.speed === undefined || input?.speed === null) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "speed is required." });
  }
  try {
    await setCustomSfxSpeed(input.speed);
  } catch (e) {
    throw new ZiteError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
  }
  return { sound: await stickerSoundState() };
};

const resetStickerSound: Handler = async () => {
  clearCustomSfx();
  return { sound: await stickerSoundState() };
};

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


// ── Auto-Screencast (native, not bundled) ────────────────────────────────────
// Reads the narrator's transcript, plans which moments reference a real website/
// source/product, captures REAL website screencast footage with the container's
// Chromium (puppeteer-core), and inserts the shots into the timeline. The whole
// engine lives in src/capture/* and uses the native Shots store + claude.ts —
// NOT the esbuild AI bundle — so it needs no bundle and no Kinovi key. It does
// need the AI director (for planning) and Chromium (for capture).
const autoScreencast: Handler = async (input, userId) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "The AI director is not configured. Set ANTHROPIC_API_KEY on the server to enable Auto-Screencast planning.",
    });
  }
  if (!chromiumAvailable()) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "No Chromium browser is available to capture screencasts on this server.",
    });
  }
  return runAutoScreencast({ projectId: input.projectId, userId });
};

// Recapture a single Screencast shot using its current targetUrl (the editor's
// per-shot "Recapture" action). Chromium-only — no AI planning needed.
const recaptureScreencast: Handler = async (input) => {
  if (!chromiumAvailable()) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "No Chromium browser is available to capture screencasts on this server.",
    });
  }
  return recaptureScreencastShot({ shotId: input.shotId ?? input.id });
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
    videosPerDay: typeof input?.videosPerDay === "number" ? input.videosPerDay : undefined,
    minGapDays: typeof input?.minGapDays === "number" ? input.minGapDays : undefined,
    seed: typeof input?.seed === "number" ? input.seed : undefined,
  });

const runBulkSchedule: Handler = async (input) =>
  bulkSchedulerSchedule({ posts: Array.isArray(input?.posts) ? input.posts : [] });

// ── Thumbnail Designer (LAB tool) ────────────────────────────────────────────
// Recreates top-performing YouTube thumbnails with the user's character via the
// Nano Banana (Gemini 2.5 Flash Image) editing chain. The entry point is the
// user's pasted SCRIPT — an AI step extracts the search keyword + infers the
// video type. Gated behind: both API keys configured (write-only, server-only
// getters) + at least one character expression uploaded.

const VIDEO_TYPE_FALLBACK: VideoType = "Tutorial";
function coerceVideoType(x: unknown): VideoType {
  return isVideoType(x) ? x : VIDEO_TYPE_FALLBACK;
}

/** Gate the UI: which keys are set + which expressions/backgrounds are uploaded. No values. */
const thumbnailStatus: Handler = async () => ({
  geminiConfigured: nanoBananaConfigured(),
  youtubeConfigured: youtubeConfigured(),
  characters: listCharacters(),
  uploadedExpressions: uploadedExpressions(),
  backgrounds: listBackgrounds(),
  uploadedBackgrounds: uploadedBackgrounds(),
  font: fontStatus(),
  // Whether the contrarian character is composited from the REAL uploaded pixels
  // (1:1) vs. the AI fallback — both libs must load for the programmatic path.
  composite: await probeCompositeAvailable(),
});

/** Read the pasted script → extract the search keyword + infer the video type. */
const analyzeThumbnailScript: Handler = async (input) => {
  const analysis = await analyzeScript(String(input?.script ?? ""));
  return analysis;
};

/** Search YouTube for the top 20 most-viewed long-form English/US thumbnails for a keyword. */
const searchThumbnails: Handler = async (input) => {
  const results = await searchTopThumbnails(String(input?.keyword ?? ""));
  return { results };
};

function coercePicks(input: any): string[] {
  return (Array.isArray(input?.picks) ? input.picks : []).map((p: unknown) => String(p));
}

/**
 * Start generation: create a progress job (one variant per pick), kick the
 * recreation chains off in the BACKGROUND, and return the jobId IMMEDIATELY so
 * the UI can poll `thumbnailJobStatus` for live per-thumbnail progress. Mirrors
 * the Narration Cutter's analyzeCut start→poll pattern.
 */
function coerceRewrites(raw: any): { old: string; new: string }[] {
  return (Array.isArray(raw) ? raw : [])
    .map((r: any) => ({ old: String(r?.old ?? "").trim(), new: String(r?.new ?? "").trim() }))
    .filter((r: any) => r.old && r.new);
}

function coerceElements(raw: any): { id: string; label: string; apply: boolean; instruction: string }[] {
  return (Array.isArray(raw) ? raw : [])
    .map((e: any) => ({
      id: String(e?.id ?? "custom").trim() || "custom",
      label: String(e?.label ?? "Edit").trim() || "Edit",
      apply: e?.apply !== false,
      instruction: String(e?.instruction ?? "").trim(),
    }))
    .filter((e: any) => e.instruction);
}

/** Coerce the UI's edited per-pick plans into RecreationPlan[] (best-effort). */
function coercePlans(input: any): any[] | undefined {
  if (!Array.isArray(input?.plans)) return undefined;
  return input.plans
    .map((p: any) => ({
      videoId: String(p?.videoId ?? "").trim(),
      sourceThumbnailUrl: String(p?.sourceThumbnailUrl ?? ""),
      expression: String(p?.expression ?? "").trim(),
      expressionLabel: String(p?.expressionLabel ?? ""),
      busy: p?.busy === true,
      backgroundId: p?.backgroundId ? String(p.backgroundId) : null,
      rewrites: coerceRewrites(p?.rewrites),
      elements: coerceElements(p?.elements),
    }))
    .filter((p: any) => p.videoId && p.expression);
}

/** Live "text size" slider: re-render a contrarian headline on its base image. */
const restyleContrarianText: Handler = async (input) => {
  const baseUrl = String(input?.baseUrl ?? "").trim();
  if (!baseUrl) throw new ZiteError({ code: "BAD_REQUEST", message: "A base image is required." });
  return restyleContrarian({
    baseUrl,
    templateId: String(input?.templateId ?? "bottom-bar"),
    text: String(input?.text ?? ""),
    emphasis: String(input?.emphasis ?? ""),
    textScale: Number.isFinite(input?.textScale) ? Number(input.textScale) : 1,
    textOffsetY: Number.isFinite(input?.textOffsetY) ? Number(input.textOffsetY) : 0,
  });
};

/** Live character controls: re-composite a contrarian thumbnail (move/zoom/replace). */
const recompositeContrarianThumbnail: Handler = async (input) => {
  const backgroundId = String(input?.backgroundId ?? "").trim();
  const expressionId = String(input?.expressionId ?? "").trim();
  if (!backgroundId || !expressionId) throw new ZiteError({ code: "BAD_REQUEST", message: "background + character are required." });
  return recompositeContrarian({
    backgroundId,
    expressionId,
    templateId: String(input?.templateId ?? "bottom-bar"),
    placement: ["left", "center", "right"].includes(String(input?.placement)) ? (String(input.placement) as any) : undefined,
    charOffsetX: Number.isFinite(input?.charOffsetX) ? Math.min(0.45, Math.max(-0.45, Number(input.charOffsetX))) : 0,
    charOffsetY: Number.isFinite(input?.charOffsetY) ? Math.min(0.45, Math.max(-0.45, Number(input.charOffsetY))) : 0,
    charZoom: Number.isFinite(input?.charZoom) ? Math.min(2.2, Math.max(0.4, Number(input.charZoom))) : 1,
    text: String(input?.text ?? ""),
    emphasis: String(input?.emphasis ?? ""),
    textScale: Number.isFinite(input?.textScale) ? Number(input.textScale) : 1,
    textOffsetY: Number.isFinite(input?.textOffsetY) ? Number(input.textOffsetY) : 0,
  });
};

/** Live character handles: re-composite a recreation's character onto its scene. */
const recompositeRecreationThumbnail: Handler = async (input) => {
  const sceneUrl = String(input?.sceneUrl ?? "").trim();
  const expressionId = String(input?.expressionId ?? "").trim();
  if (!sceneUrl || !expressionId) throw new ZiteError({ code: "BAD_REQUEST", message: "scene + character are required." });
  return recompositeRecreation({
    sceneUrl,
    expressionId,
    placement: ["left", "center", "right"].includes(String(input?.placement)) ? (String(input.placement) as any) : "right",
    charOffsetX: Number.isFinite(input?.charOffsetX) ? Math.min(0.45, Math.max(-0.45, Number(input.charOffsetX))) : 0,
    charOffsetY: Number.isFinite(input?.charOffsetY) ? Math.min(0.45, Math.max(-0.45, Number(input.charOffsetY))) : 0,
    charZoom: Number.isFinite(input?.charZoom) ? Math.min(2.2, Math.max(0.4, Number(input.charZoom))) : 1,
  });
};

/** Free-text → precise edit element(s) for ONE picked thumbnail (review step). */
const planThumbnailCustomEdit: Handler = async (input) => {
  const videoId = String(input?.videoId ?? "").trim();
  const request = String(input?.request ?? "").trim();
  if (!videoId) throw new ZiteError({ code: "BAD_REQUEST", message: "A videoId is required." });
  if (!request) return { elements: [] };
  const elements = await planCustomEdit({ videoId, keyword: String(input?.keyword ?? ""), request });
  return { elements };
};

/**
 * PLAN every per-thumbnail decision for review/edit BEFORE generation: for each
 * picked source, the chosen character expression, the busy flag, the chosen
 * background, and the proposed text rewrites (grounded in the titles).
 */
const planThumbnailRecreations: Handler = async (input) => {
  const picks = coercePicks(input);
  if (picks.length === 0) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick at least one thumbnail to review." });
  const plans = await planRecreations({
    picks,
    keyword: String(input?.keyword ?? ""),
    videoType: coerceVideoType(input?.videoType),
    titles: coerceTitles(input),
  });
  return { plans };
};

/** Coerce the UI's Pro render resolution: "1K"|"2K"|"4K", "" (model default), else env default. */
function coerceImageSize(x: unknown): string | undefined {
  if (x === undefined || x === null) return undefined;
  const v = String(x).trim().toUpperCase();
  if (v === "1K" || v === "2K" || v === "4K") return v;
  if (v === "" || v === "AUTO" || v === "DEFAULT") return ""; // explicit no-size
  return undefined;
}

const startThumbnailGeneration: Handler = async (input) => {
  const picks = coercePicks(input);
  if (picks.length === 0) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick at least one thumbnail to recreate." });
  const job = startThumbnailJob({
    keyword: String(input?.keyword ?? ""),
    videoType: coerceVideoType(input?.videoType),
    picks,
    // `mode` selects the single image provider — default "gemini-pro" (Nano
    // Banana Pro @ 4K), or "gemini-flash". Falls back to the legacy `provider`.
    mode: coerceMode(input?.mode ?? input?.provider),
    // The UI's render-resolution toggle (Pro only).
    imageSize: coerceImageSize(input?.imageSize),
    // Reviewed/edited per-pick plans (character + background + text) when supplied.
    plans: coercePlans(input),
  });
  return { jobId: job.id };
};

/** Turn the pasted script into viral + SEO titles (shown + used to ground copy). */
const generateThumbnailTitles: Handler = async (input) => {
  const titles = await generateTitles(String(input?.script ?? ""));
  return { titles };
};

function coerceTitles(input: any): string[] {
  return (Array.isArray(input?.titles) ? input.titles : []).map((t: unknown) => String(t)).filter(Boolean);
}

/**
 * PLAN the contrarian copy for review/edit BEFORE generation: returns the 3
 * proposed statements (text + emphasis + cast) grounded in the titles + script.
 */
const planThumbnailContrarian: Handler = async (input) => {
  const keyword = String(input?.keyword ?? "").trim();
  if (!keyword) throw new ZiteError({ code: "BAD_REQUEST", message: "A keyword is required to plan contrarian copy." });
  const variations = await planContrarianVariations({
    keyword,
    titles: coerceTitles(input),
    context: typeof input?.script === "string" ? input.script : undefined,
  });
  return { variations };
};

function coerceContrarianVariations(input: any): { text: string; emphasis: string; expressionId: string }[] {
  return (Array.isArray(input?.variations) ? input.variations : [])
    .map((v: any) => ({
      text: String(v?.text ?? "").trim(),
      emphasis: String(v?.emphasis ?? "").trim(),
      expressionId: String(v?.expressionId ?? "").trim(),
      textScale: Number.isFinite(v?.textScale) ? Math.min(2, Math.max(0.4, Number(v.textScale))) : 1,
      textOffsetY: Number.isFinite(v?.textOffsetY) ? Math.min(0.45, Math.max(-0.45, Number(v.textOffsetY))) : 0,
    }))
    .filter((v: any) => v.text);
}

/**
 * Start the CONTRARIAN ORIGINALS workflow (the parallel second workflow): build 3
 * original thumbnails from the keyword + uploaded background(s) + character, with
 * a short styled contrarian statement (no money claims). Accepts approved/edited
 * `variations` from the review step. Returns a jobId polled with the SAME
 * `thumbnailJobStatus` endpoint, so it runs in parallel with a recreation job.
 */
const startContrarianGeneration: Handler = async (input) => {
  const keyword = String(input?.keyword ?? "").trim();
  if (!keyword) throw new ZiteError({ code: "BAD_REQUEST", message: "A keyword is required to write contrarian statements." });
  const job = startContrarianJob({
    keyword,
    mode: coerceMode(input?.mode ?? input?.provider),
    titles: coerceTitles(input),
    context: typeof input?.script === "string" ? input.script : undefined,
    variations: coerceContrarianVariations(input),
  });
  return { jobId: job.id };
};

/** Poll a generation job for its live progress snapshot (overall % + variants). */
const thumbnailJobStatus: Handler = async (input) => {
  const jobId: string = input?.jobId;
  if (!jobId) throw new ZiteError({ code: "BAD_REQUEST", message: "jobId is required." });
  const job = getThumbnailJob(jobId);
  if (!job) {
    // Expired (TTL/GC) or unknown — report done with a clear note so the UI stops
    // polling instead of spinning forever.
    return {
      jobId,
      percent: 100,
      done: true,
      error: "Generation job not found (it may have expired) — start a new generation.",
      variants: [],
    };
  }
  return thumbnailJobSnapshot(job);
};

/** Cancel ONE running generation job (stops between steps; marks it terminal). */
const cancelThumbnailJob: Handler = async (input) => {
  const jobId: string = input?.jobId;
  if (!jobId) throw new ZiteError({ code: "BAD_REQUEST", message: "jobId is required." });
  const cancelled = cancelThumbnailJobById(jobId);
  const job = getThumbnailJob(jobId);
  return { cancelled, job: job ? thumbnailJobSnapshot(job) : null };
};

/** Cancel EVERY running generation job in the queue. Returns how many were cancelled. */
const cancelAllThumbnailJobsEndpoint: Handler = async () => {
  const count = cancelAllThumbnailJobs();
  return { cancelled: count };
};

/**
 * Synchronous wrapper kept for back-compat (the original blocking contract).
 * The UI now uses the start→poll pair above; this returns all variants at once.
 */
const generateThumbnails: Handler = async (input) => {
  const picks = coercePicks(input);
  if (picks.length === 0) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick at least one thumbnail to recreate." });
  const variants = await generateThumbnailVariants({
    keyword: String(input?.keyword ?? ""),
    videoType: coerceVideoType(input?.videoType),
    picks,
    mode: coerceMode(input?.mode ?? input?.provider),
  });
  return { variants };
};

// Character library: list / upload / delete expression images. There are four
// built-in slots (smile/surprise/secret/calm) PLUS any number of custom,
// user-named expressions. A built-in is uploaded by id; a custom by `name`.
const listThumbnailCharacters: Handler = async () => ({ characters: listCharacters() });

const uploadThumbnailCharacter: Handler = async (input) => {
  const imageBase64 = String(input?.imageBase64 ?? "");
  const name = typeof input?.name === "string" ? input.name : "";
  const expr = input?.expression ?? input?.id;
  let character;
  if (name.trim()) {
    // Custom expression from a free-text name.
    character = saveCustomCharacter(name, imageBase64);
  } else if (isBuiltinExpression(expr)) {
    character = saveCharacter(expr, imageBase64);
  } else if (isValidExpressionId(expr)) {
    // Re-upload an existing custom expression by its id.
    character = saveCharacter(expr, imageBase64);
  } else {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Provide a built-in expression id or a name for a custom one." });
  }
  return { character, characters: listCharacters() };
};

const deleteThumbnailCharacter: Handler = async (input) => {
  const id = input?.expression ?? input?.id;
  if (!isValidExpressionId(id)) throw new ZiteError({ code: "BAD_REQUEST", message: `Invalid expression id: ${String(id)}` });
  const character = deleteCharacter(id);
  return { character, characters: listCharacters() };
};

// Background library: list / upload (by name) / delete background images.
const listThumbnailBackgrounds: Handler = async () => ({ backgrounds: listBackgrounds() });

const uploadThumbnailBackground: Handler = async (input) => {
  const background = saveBackground(String(input?.name ?? ""), String(input?.imageBase64 ?? ""));
  return { background, backgrounds: listBackgrounds() };
};

const deleteThumbnailBackground: Handler = async (input) => {
  const id = input?.id;
  if (typeof id !== "string" || !id) throw new ZiteError({ code: "BAD_REQUEST", message: "Background id is required." });
  deleteBackground(id);
  return { backgrounds: listBackgrounds() };
};

// Headline font (contrarian-originals overlay): upload / delete a custom font.
const uploadThumbnailFont: Handler = async (input) => {
  const filename = String(input?.filename ?? "");
  const font = saveFont(filename, String(input?.fontBase64 ?? ""));
  return { font };
};

const deleteThumbnailFont: Handler = async () => ({ font: deleteFont() });

// ── AI Image Generator (LAB tool) ─────────────────────────────────────────────
// A nano-banana-style chatbot. Ephemeral by design: images travel as base64 in
// the request/response and NOTHING is written to disk or the DB — "no memory of
// past chats should be saved". Reuses the SAME Gemini key as the Thumbnail
// Designer (configured at /settings/postiz).

/** Whether the image generator can run (Gemini key) + whether prompt optimization is on (Anthropic). */
const imageGeneratorStatus: Handler = async () => ({
  geminiConfigured: imageChatConfigured(),
  promptOptimizerConfigured: anthropicConfigured(),
});

/** Coerce the incoming reference images ([{ base64, mimeType }]) to EditImage buffers. */
function coerceChatImages(input: any): { data: Buffer; mimeType: string }[] {
  const arr = Array.isArray(input?.images) ? input.images : [];
  const out: { data: Buffer; mimeType: string }[] = [];
  for (const img of arr) {
    // Accept either a raw base64 string or an object { base64|data, mimeType }.
    let b64 = "";
    let mime = "image/png";
    if (typeof img === "string") {
      b64 = img;
    } else if (img && typeof img === "object") {
      b64 = String(img.base64 ?? img.data ?? "");
      if (typeof img.mimeType === "string" && img.mimeType) mime = img.mimeType;
    }
    // Tolerate a full data URL ("data:image/png;base64,....").
    const m = /^data:([^;]+);base64,(.*)$/s.exec(b64);
    if (m) {
      mime = m[1];
      b64 = m[2];
    }
    b64 = b64.trim();
    if (!b64) continue;
    out.push({ data: Buffer.from(b64, "base64"), mimeType: mime });
  }
  // Cap the number of reference images sent to the model to keep requests sane.
  return out.slice(0, 6);
}

/**
 * Optimize the user's words into a strong image prompt, then generate (or edit,
 * when reference images are supplied) with Nano Banana. Returns the image as
 * base64 plus the prompt actually sent, so the UI can show what it optimized to.
 */
const generateChatImage: Handler = async (input) => {
  const userPrompt = String(input?.prompt ?? "").trim();
  if (!userPrompt) throw new ZiteError({ code: "BAD_REQUEST", message: "Type a prompt to generate an image." });
  if (!imageChatConfigured()) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "Gemini API key not configured — add it in Settings → Thumbnail Designer first.",
    });
  }
  const images = coerceChatImages(input);
  const model = coerceChatModel(input?.model);
  const aspect = coerceAspect(input?.aspect);
  // Optimize by default; the UI can opt out (optimize:false) to send verbatim.
  const wantOptimize = input?.optimize !== false;
  const finalPrompt = wantOptimize ? await optimizeImagePrompt(userPrompt, images.length > 0) : userPrompt;

  const image = await runChatImage({ instruction: finalPrompt, images, model, aspect });

  // Persist the result to disk + the image_history table so it shows up in the
  // History panel. Best-effort: a persistence hiccup must never fail a
  // successful generation, so we still return the base64 the UI shows inline.
  let historyId: string | null = null;
  let historyUrl: string | null = null;
  try {
    const item = persistImage({
      prompt: finalPrompt,
      base64: image.base64,
      mime: image.mimeType,
      kind: images.length > 0 ? "edit" : "generate",
      model: chatModelLabel(model),
    });
    historyId = item.id;
    historyUrl = item.url;
  } catch (e) {
    console.error("[imagechat] could not persist to history:", e instanceof Error ? e.message : e);
  }

  return {
    image, // { base64, mimeType }
    prompt: finalPrompt,
    optimized: wantOptimize && finalPrompt !== userPrompt,
    model,
    modelLabel: chatModelLabel(model),
    historyId, // history row id (null if persistence failed)
    historyUrl, // relative /api/image-history/<id>.<ext> URL (null if failed)
  };
};

/** History (newest first) for the image generator's left panel. */
const listImageHistory: Handler = async () => ({
  items: listImageHistoryItems().map((it) => ({
    id: it.id,
    prompt: it.prompt,
    url: it.url,
    mime: it.mime,
    kind: it.kind,
    model: it.model,
    ts: it.createdAt,
  })),
});

/** Delete one saved image (row + file on disk). Idempotent. */
const deleteImageHistoryItem: Handler = async (input) => {
  const id = String(input?.id ?? "").trim();
  if (!id) throw new ZiteError({ code: "BAD_REQUEST", message: "An image id is required." });
  deleteImageHistoryRow(id);
  return { ok: true } as const;
};

// ── Keyword Research (LAB tool) ──────────────────────────────────────────────

/** Gate the UI: which signals are available for keyword research. */
const keywordResearchStatus: Handler = async () => ({
  youtubeConfigured: youtubeConfigured(),
  trendsAvailable: true, // best-effort; the runner tolerates Trends being blocked.
  keywordApiConfigured: !!getDataForSeoCreds(),
  promptOptimizerConfigured: anthropicConfigured(),
});

const RESEARCH_MODES: ReadonlySet<string> = new Set(["seeds", "topic", "competitors", "ai"]);

/** Coerce the raw request body into a validated ResearchInput. */
function coerceResearchInput(input: any): ResearchInput {
  const mode = String(input?.mode ?? "");
  if (!RESEARCH_MODES.has(mode)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "mode must be one of seeds | topic | competitors | ai." });
  }
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.map((x) => String(x)).map((s) => s.trim()).filter(Boolean) : undefined;
  const maxRaw = Number(input?.maxKeywords);
  return {
    mode: mode as ResearchMode,
    niche: typeof input?.niche === "string" ? input.niche : undefined,
    seeds: strArray(input?.seeds),
    topic: typeof input?.topic === "string" ? input.topic : undefined,
    competitors: strArray(input?.competitors),
    freeText: typeof input?.freeText === "string" ? input.freeText : undefined,
    channelUrl: typeof input?.channelUrl === "string" ? input.channelUrl : undefined,
    maxKeywords: Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : undefined,
    refresh: input?.refresh === true,
  };
}

/** Start a research run in the background; returns { jobId, runId } immediately. */
const startKeywordResearch: Handler = async (input) => startResearch(coerceResearchInput(input));

/** Live snapshot the UI polls while a run is in flight. */
const keywordResearchJobStatus: Handler = async (input) => {
  const jobId: string = input?.jobId;
  if (!jobId) throw new ZiteError({ code: "BAD_REQUEST", message: "jobId is required." });
  const snap = getResearchSnapshot(jobId);
  if (!snap) throw new ZiteError({ code: "NOT_FOUND", message: "Research job not found (it may have expired)." });
  return snap;
};

/** Saved-runs history (newest first). */
const listResearchRuns: Handler = async () => ({ runs: listKeywordRuns() });

/** The full, hydrated result of a saved run. */
const getResearchRun: Handler = async (input) => {
  const runId: string = input?.runId;
  if (!runId) throw new ZiteError({ code: "BAD_REQUEST", message: "runId is required." });
  const run = hydrateRun(runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Research run not found." });
  return run;
};

/** Delete a saved run from the history. */
const deleteResearchRun: Handler = async (input) => {
  const runId: string = input?.runId;
  if (!runId) throw new ZiteError({ code: "BAD_REQUEST", message: "runId is required." });
  deleteKeywordRun(runId);
  return { ok: true };
};

/** Rename a saved run (the niche/label shown in the history sidebar). */
const renameResearchRun: Handler = async (input) => {
  const runId: string = input?.runId;
  const niche = String(input?.niche ?? "").trim();
  if (!runId) throw new ZiteError({ code: "BAD_REQUEST", message: "runId is required." });
  if (!niche) throw new ZiteError({ code: "BAD_REQUEST", message: "A name is required." });
  if (!hydrateRun(runId)) throw new ZiteError({ code: "NOT_FOUND", message: "Research run not found." });
  updateKeywordRun(runId, { niche });
  return { ok: true };
};

/** Pin / unpin a saved run (pinned runs sort to the top of the sidebar). */
const pinResearchRun: Handler = async (input) => {
  const runId: string = input?.runId;
  if (!runId) throw new ZiteError({ code: "BAD_REQUEST", message: "runId is required." });
  if (!hydrateRun(runId)) throw new ZiteError({ code: "NOT_FOUND", message: "Research run not found." });
  setRunPinned(runId, !!input?.pinned);
  return { ok: true };
};

/** Backfill DataForSEO search volume onto an existing run (needs credentials). */
const refreshVolume: Handler = async (input) => {
  const runId: string = input?.runId;
  if (!runId) throw new ZiteError({ code: "BAD_REQUEST", message: "runId is required." });
  return refreshRunVolume(runId);
};

/** On-demand YouTube competition fetch for one keyword (beyond the upfront budget). */
const fetchKeywordCompetitorsHandler: Handler = async (input) => {
  const runId: string = input?.runId;
  const keyword = String(input?.keyword ?? "").trim();
  if (!runId) throw new ZiteError({ code: "BAD_REQUEST", message: "runId is required." });
  if (!keyword) throw new ZiteError({ code: "BAD_REQUEST", message: "keyword is required." });
  return fetchKeywordCompetitors(runId, keyword);
};

// ── Keyword Research FAVORITES (folders / titles / keywords) ─────────────────
const FAV_KEYWORD_SOURCES: ReadonlySet<string> = new Set(["extracted", "table", "manual"]);

/** All favorite folders (newest first) with live title/keyword counts. */
const listFavFolders: Handler = async () => ({ folders: listFavFoldersDb() });

const createFavFolder: Handler = async (input) => {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new ZiteError({ code: "BAD_REQUEST", message: "A folder name is required." });
  return { folder: createFavFolderDb(name) };
};

const renameFavFolder: Handler = async (input) => {
  const folderId = String(input?.folderId ?? "");
  const name = String(input?.name ?? "").trim();
  if (!folderId) throw new ZiteError({ code: "BAD_REQUEST", message: "folderId is required." });
  if (!name) throw new ZiteError({ code: "BAD_REQUEST", message: "A folder name is required." });
  if (!getFavFolderDb(folderId)) throw new ZiteError({ code: "NOT_FOUND", message: "Folder not found." });
  renameFavFolderDb(folderId, name);
  return { ok: true };
};

const deleteFavFolder: Handler = async (input) => {
  const folderId = String(input?.folderId ?? "");
  if (!folderId) throw new ZiteError({ code: "BAD_REQUEST", message: "folderId is required." });
  deleteFavFolderDb(folderId);
  return { ok: true };
};

/** The full contents of one folder (folder + titles + keywords). */
const getFavorites: Handler = async (input) => {
  const folderId = String(input?.folderId ?? "");
  if (!folderId) throw new ZiteError({ code: "BAD_REQUEST", message: "folderId is required." });
  const view = getFavoritesView(folderId);
  if (!view) throw new ZiteError({ code: "NOT_FOUND", message: "Folder not found." });
  return view;
};

const addFavTitle: Handler = async (input) => {
  const folderId = String(input?.folderId ?? "");
  const title = String(input?.title ?? "").trim();
  if (!folderId) throw new ZiteError({ code: "BAD_REQUEST", message: "folderId is required." });
  if (!title) throw new ZiteError({ code: "BAD_REQUEST", message: "A title is required." });
  if (!getFavFolderDb(folderId)) throw new ZiteError({ code: "NOT_FOUND", message: "Folder not found." });
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const savedTitle = addFavTitleDb({
    folderId,
    title,
    videoId: str(input?.videoId),
    channelTitle: str(input?.channelTitle),
    views: num(input?.views),
    subscriberCount: num(input?.subscriberCount),
    publishedAt: str(input?.publishedAt),
    sourceKeyword: str(input?.sourceKeyword),
  });
  return { title: savedTitle };
};

const removeFavTitle: Handler = async (input) => {
  const id = String(input?.id ?? "");
  if (!id) throw new ZiteError({ code: "BAD_REQUEST", message: "id is required." });
  removeFavTitleDb(id);
  return { ok: true };
};

const updateFavTitle: Handler = async (input) => {
  const id = String(input?.id ?? "");
  if (!id) throw new ZiteError({ code: "BAD_REQUEST", message: "id is required." });
  updateFavTitleDb(id, {
    note: typeof input?.note === "string" ? input.note : undefined,
    tags: Array.isArray(input?.tags) ? input.tags : undefined,
  });
  return { ok: true };
};

const addFavKeyword: Handler = async (input) => {
  const folderId = String(input?.folderId ?? "");
  const keyword = String(input?.keyword ?? "").trim();
  if (!folderId) throw new ZiteError({ code: "BAD_REQUEST", message: "folderId is required." });
  if (!keyword) throw new ZiteError({ code: "BAD_REQUEST", message: "A keyword is required." });
  if (!getFavFolderDb(folderId)) throw new ZiteError({ code: "NOT_FOUND", message: "Folder not found." });
  const rawSource = String(input?.source ?? "manual");
  const source: FavKeywordSource = FAV_KEYWORD_SOURCES.has(rawSource)
    ? (rawSource as FavKeywordSource)
    : "manual";
  const saved = addFavKeywordDb({
    folderId,
    keyword,
    source,
    sourceTitleId: typeof input?.sourceTitleId === "string" ? input.sourceTitleId : null,
    note: typeof input?.note === "string" ? input.note : null,
    tags: Array.isArray(input?.tags) ? input.tags : undefined,
  });
  return { keyword: saved };
};

const removeFavKeyword: Handler = async (input) => {
  const id = String(input?.id ?? "");
  if (!id) throw new ZiteError({ code: "BAD_REQUEST", message: "id is required." });
  removeFavKeywordDb(id);
  return { ok: true };
};

const updateFavKeyword: Handler = async (input) => {
  const id = String(input?.id ?? "");
  if (!id) throw new ZiteError({ code: "BAD_REQUEST", message: "id is required." });
  updateFavKeywordDb(id, {
    note: typeof input?.note === "string" ? input.note : undefined,
    tags: Array.isArray(input?.tags) ? input.tags : undefined,
  });
  return { ok: true };
};

/**
 * AI-extract searchable keywords from a folder's saved titles and add them to the
 * folder's keyword database (source "extracted"). The titles must belong to the
 * folder. When exactly one title is given, each new keyword is linked back to it
 * (sourceTitleId); for a multi-title batch there's no single source, so it's null.
 * Deduped via addKeyword (returns the existing/merged row for repeats).
 */
const extractKeywordsFromTitles: Handler = async (input) => {
  const folderId = String(input?.folderId ?? "");
  const titleIds: string[] = Array.isArray(input?.titleIds)
    ? input.titleIds.map((x: unknown) => String(x)).filter(Boolean)
    : [];
  if (!folderId) throw new ZiteError({ code: "BAD_REQUEST", message: "folderId is required." });
  if (!getFavFolderDb(folderId)) throw new ZiteError({ code: "NOT_FOUND", message: "Folder not found." });
  if (titleIds.length === 0) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "At least one titleId is required." });
  }

  // Load the requested titles; every one must exist AND belong to this folder.
  const titles = titleIds.map((id) => {
    const t = getFavTitleDb(id);
    if (!t || t.folderId !== folderId) {
      throw new ZiteError({ code: "NOT_FOUND", message: `Title not found in folder: ${id}` });
    }
    return t;
  });

  const phrases = await aiExtractKeywordsFromTitles(titles.map((t) => t.title));
  const sourceTitleId = titleIds.length === 1 ? titleIds[0] : null;
  const added: FavKeyword[] = phrases.map((keyword) =>
    addFavKeywordDb({ folderId, keyword, source: "extracted", sourceTitleId }),
  );
  return { added };
};

// ── Jake Dawson Script Generator (LAB tool) ──────────────────────────────────
// 7-stage YouTube-scripting methodology on Opus 4.8: Stage 0 classify (sync,
// with a type/title checkpoint), then Stages 1–7 as a polled background job.
const scriptGenStatus: Handler = async () => ({
  anthropicConfigured: anthropicConfigured(),
  model: aiConfig.models.director,
});

const startScript: Handler = async (input) => runStartScript(input as ScriptInput);

const continueScript: Handler = async (input) => {
  const runId: string | undefined = input?.runId;
  const setup: ScriptSetup | undefined = input?.setup;
  if (!runId || !setup) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "runId and setup are required to continue a script." });
  }
  return runContinueScript(runId, setup);
};

const scriptJobStatus: Handler = async (input) => {
  const snap = getScriptSnapshot(input?.jobId);
  if (!snap) throw new ZiteError({ code: "NOT_FOUND", message: "Script job not found." });
  return snap;
};

const getScriptRun: Handler = async (input) => {
  const run = getScriptRunDb(input?.runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Script run not found." });
  return run;
};

const listScriptRuns: Handler = async () => ({ runs: listScriptRunsDb() });

const deleteScriptRun: Handler = async (input) => {
  deleteScriptRunDb(input?.runId);
  return { ok: true };
};

// ── Video Planner (LAB tool) ────────────────────────────────────────────────
// Edited narration in, a timestamped visual plan out. Separate from the
// long-form editor: this is the planning step, and the editor builds on it.

const plannerStatus: Handler = async () => ({
  anthropicConfigured: Boolean((aiConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "").trim()),
  groqConfigured: Boolean(aiConfig.groqApiKey),
  model: PLANNER_MODEL,
});

const startPlan: Handler = async (input) => {
  const source: string | undefined = input?.source;
  if (!source) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "A Descript share link or an uploaded file is required." });
  }
  const sourceKind = input?.sourceKind === "upload" ? "upload" : "descript";
  if (sourceKind === "descript" && !/^https?:\/\/share\.descript\.com\//i.test(source)) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "That does not look like a Descript share link (expected https://share.descript.com/view/...).",
    });
  }
  const plan: PlanInput = {
    source,
    sourceKind,
    productUrls: Array.isArray(input?.productUrls) ? input.productUrls.filter(Boolean) : [],
    skipResearch: Boolean(input?.skipResearch),
    title: input?.title,
  };
  return runStartPlan(plan);
};

const planJobStatus: Handler = async (input) => {
  const snap = getPlanSnapshot(input?.runId);
  if (!snap) throw new ZiteError({ code: "NOT_FOUND", message: "Plan run not found." });
  return snap;
};

const getPlanRun: Handler = async (input) => {
  const run = getPlanRunDb(input?.runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Plan run not found." });
  return run;
};

const listPlanRuns: Handler = async () => ({ runs: listPlanRunsDb() });

const deletePlanRun: Handler = async (input) => {
  deletePlanRunDb(input?.runId);
  return { ok: true };
};

// Post-generation paragraph refinement: rewrite ONE pasted paragraph per Jake's
// instruction, grounded in the run's own research + fact sheet. Returns the full
// updated (persisted) chat thread plus the cost of this one call.
const refineScriptParagraph: Handler = async (input) => {
  const runId: string | undefined = input?.runId;
  if (!runId) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "runId is required to refine a paragraph." });
  }
  return runRefineParagraph(runId, String(input?.paragraph ?? ""), String(input?.instruction ?? ""));
};

// ── Channel Audit (LAB tool) ─────────────────────────────────────────────────
// Point it at a channel, get the niche, the competitors, what its titles and
// thumbnails have in common, where it sits, and a proposed title for every
// video. The run PAUSES after proposing a market so the operator can correct it
// before anything expensive is spent on the wrong comparison set.

const auditStatus: Handler = async () => ({
  youtubeConfigured: youtubeConfigured(),
  anthropicConfigured: Boolean((aiConfig.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "").trim()),
  // Paid/organic is available only for a channel whose owner has connected it.
  analyticsConfigured: ytAnalyticsConfigured(),
  analyticsConnected: ytAnalyticsConnected(),
});

const startAudit: Handler = async (input) => {
  const channel = String(input?.channel ?? "").trim();
  if (!channel) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "A channel URL, @handle or channel id is required." });
  }
  if (!youtubeConfigured()) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "The YouTube Data API key is not configured." });
  }
  const payload: AuditInput = {
    channel,
    mode: input?.mode === "teardown" ? "teardown" : "own",
    title: typeof input?.title === "string" ? input.title : undefined,
    angle: typeof input?.angle === "string" && input.angle.trim() ? input.angle.trim().slice(0, 1200) : undefined,
    marketId: typeof input?.marketId === "string" && input.marketId.trim() ? input.marketId.trim() : undefined,
    autoApprove: Boolean(input?.autoApprove),
  };
  return runStartAudit(payload);
};

const auditJobStatus: Handler = async (input) => {
  const snap = getAuditSnapshot(String(input?.runId ?? ""));
  if (!snap) throw new ZiteError({ code: "NOT_FOUND", message: "Audit run not found." });
  return snap;
};

/** Confirm (or correct) the proposed market and let the expensive half proceed. */
const approveAuditMarket: Handler = async (input) => {
  const runId = String(input?.runId ?? "");
  const run = getAuditRunRow(runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Audit run not found." });
  if (run.status !== "awaiting-approval") {
    throw new ZiteError({ code: "BAD_REQUEST", message: `This run is ${run.status}, not waiting for approval.` });
  }
  const edited = input?.market as MarketProposal | undefined;
  const market = edited && Array.isArray(edited.competitors) ? edited : run.proposal;
  if (!market) throw new ZiteError({ code: "BAD_REQUEST", message: "No market to approve." });
  if (!market.competitors.some((c) => c.include)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Keep at least one competitor — the market analysis needs something to compare against." });
  }
  const { ok } = runResumeAudit(runId, market);
  if (!ok) throw new ZiteError({ code: "BAD_REQUEST", message: "This run could not be resumed." });
  return { runId };
};

/** Undo a focus and put the whole-catalogue report back. */
const clearAuditFocus: Handler = async (input) => {
  const runId = String(input?.runId ?? "");
  const run = getAuditRunRow(runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Audit run not found." });
  if (!run.focus) return { cleared: false, reason: "This report is not focused." };
  if (!run.baseFindings) {
    // Runs focused before the original was preserved have nothing to restore.
    // Saying so is the only honest answer; re-running is the way back.
    return {
      cleared: false,
      reason:
        "This report was focused before the original was being kept, so there is nothing to restore. Re-run the audit for a full-catalogue report.",
    };
  }
  updateAuditRun(runId, { findings: run.baseFindings, focus: null });
  return { cleared: true };
};

// ── saved markets ───────────────────────────────────────────────────────────
// A market is a NAMED set of competitors, not a property of a channel: the same
// channel audited against two markets is two different questions.

const listAuditMarketsHandler: Handler = async () => ({ markets: listAuditMarkets() });

const saveAuditMarketHandler: Handler = async (input) => {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new ZiteError({ code: "BAD_REQUEST", message: "Give the market a name." });
  const runId = String(input?.runId ?? "");
  const run = runId ? getAuditRunRow(runId) : null;
  const market = run?.approved ?? run?.proposal ?? null;
  const competitors = Array.isArray(input?.competitors) ? input.competitors : market?.competitors;
  if (!competitors?.length) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "There are no competitors to save." });
  }
  return {
    market: saveAuditMarket({
      id: String(input?.id ?? "").trim() || auditNanoid(),
      name,
      niche: String(input?.niche ?? market?.niche ?? name),
      nicheDescription: market?.nicheDescription,
      audience: market?.audience,
      competitors: competitors.filter((c: any) => c?.include !== false),
      discoveredFrom: run?.subject?.channelId ?? null,
    }),
  };
};

const deleteAuditMarketHandler: Handler = async (input) => ({
  deleted: deleteAuditMarket(String(input?.id ?? "")),
});

// ── did the rename work? ────────────────────────────────────────────────────
// The audit advised and never found out. Marking one applied captures the view
// count at that moment; without that baseline a later check compares nothing.

const markRenameApplied: Handler = async (input) => {
  const runId = String(input?.runId ?? "");
  const videoId = String(input?.videoId ?? "");
  const run = getAuditRunRow(runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Audit run not found." });
  const video = run.videos.find((v) => v.videoId === videoId);
  if (!video?.rename) throw new ZiteError({ code: "BAD_REQUEST", message: "That video has no proposed title." });

  // The live count, not the one stored at audit time — the operator may be
  // applying this days later, and the baseline has to be true when it is set.
  let views = video.views;
  try {
    const stats = await fetchVideoStats([videoId]);
    views = stats.get(videoId)?.views ?? views;
  } catch {
    // A stale baseline is still better than none; it is off by whatever the
    // video gained since the audit, which the report shows anyway.
  }

  recordApplied({
    runId,
    videoId,
    originalTitle: video.title,
    proposedTitle: video.rename.proposed,
    appliedAt: Date.now(),
    viewsAtApply: views,
    eraMedianAtApply: video.eraMedian,
  });
  return { applied: true, viewsAtApply: views };
};

const unmarkRenameApplied: Handler = async (input) => ({
  removed: unrecordApplied(String(input?.runId ?? ""), String(input?.videoId ?? "")),
});

/**
 * Re-check every applied rename and report what happened.
 *
 * Growth is reported against the video's own era median as well as in raw
 * views, because a video that gained 2,000 views on a channel that has doubled
 * since is not evidence the title did anything.
 */
const checkAppliedRenames: Handler = async (input) => {
  const runId = String(input?.runId ?? "") || undefined;
  const applied = listApplied(runId);
  if (!applied.length) return { results: [] };

  const ids = applied.map((a) => a.videoId);
  let stats = new Map<string, { views: number }>();
  try {
    stats = (await fetchVideoStats(ids)) as any;
  } catch (err: any) {
    throw new ZiteError({ code: "BAD_REQUEST", message: `Could not read view counts: ${err?.message || err}` });
  }

  const results = applied.map((a) => {
    const nowViews = stats.get(a.videoId)?.views ?? null;
    if (nowViews !== null) recordCheck(a.runId, a.videoId, nowViews);
    const gained = nowViews === null ? null : nowViews - a.viewsAtApply;
    const days = Math.max(1, Math.round((Date.now() - a.appliedAt) / 86_400_000));
    return {
      ...a,
      viewsAtCheck: nowViews,
      gained,
      daysSince: days,
      perDay: gained === null ? null : Math.round((gained / days) * 10) / 10,
      // Against the era median it was measured in, so a growing channel does
      // not make every rename look like a success.
      vsEra: gained === null || !a.eraMedianAtApply ? null : Math.round((gained / a.eraMedianAtApply) * 100) / 100,
      // Under two weeks is too soon to read anything into.
      readable: days >= 14,
    };
  });
  return { results };
};

const getAuditRun: Handler = async (input) => {
  const run = getAuditRunRow(String(input?.runId ?? ""));
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Audit run not found." });
  return run;
};

const listAuditRuns: Handler = async (input) => ({
  runs: listAuditRunRows(Math.max(1, Math.min(200, Number(input?.limit) || 50))),
});

const deleteAuditRun: Handler = async (input) => ({
  deleted: deleteAuditRunRow(String(input?.runId ?? "")),
});

/**
 * Ask a question about a finished audit, on Opus 5.
 *
 * The model may answer with a REFOCUS action — narrowing which videos count as
 * evidence, for a channel that has changed direction since half its catalogue
 * was published. Applying it recomputes the findings (pure arithmetic over data
 * already stored) and rewrites the verdicts in one more call: no quota, nothing
 * re-scanned, and the videos themselves are untouched.
 */
const auditChat: Handler = async (input) => {
  const runId = String(input?.runId ?? "");
  const message = String(input?.message ?? "").trim();
  if (!message) throw new ZiteError({ code: "BAD_REQUEST", message: "Say something first." });
  const run = getAuditRunRow(runId);
  if (!run) throw new ZiteError({ code: "NOT_FOUND", message: "Audit run not found." });
  if (!run.findings) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "This audit has no report to discuss yet." });
  }

  // Bill the chat — and any refocus or new section it triggers — to this run.
  // Talking to a finished report spends real Opus tokens, and a total that
  // stopped at "completed" would understate the audit from the first question.
  return withAuditUsage(runId, run.calls ?? [], () => auditChatBody(runId, run, message));
};

async function auditChatBody(runId: string, run: AuditRunResult, message: string) {
  const history = (run.chat ?? []).map((m) => ({ role: m.role, content: m.content }));
  const { reply, action } = await chatAboutAudit(run, history, message);

  // Adding a section and re-aiming the report are opposites — one appends to
  // the document, the other rewrites what the document is about — so they never
  // share a path.
  if (action?.kind === "add-section") {
    const built = await buildSection(run, action.request);
    const at = Date.now();
    // A gatherer may have enriched the videos on the way (thumbnails nobody had
    // read). That is worth keeping whether or not the section itself worked.
    const enriched = {
      ...(built.videos ? { videos: built.videos } : {}),
      ...(built.marketVideos ? { marketVideos: built.marketVideos } : {}),
    };

    if (!built.section) {
      const note = `${reply}\n\n(I did not add that section. ${built.declined})`;
      updateAuditRun(runId, {
        ...enriched,
        chat: [
          ...(run.chat ?? []),
          { role: "user" as const, content: message, at },
          { role: "assistant" as const, content: note, at },
        ],
      });
      return { reply: note, refocused: null, section: null };
    }

    const s = built.section;
    const charts = s.charts.length;
    const note =
      `${reply}\n\nAdded "${s.title}" to the report — ${charts} chart${charts === 1 ? "" : "s"}` +
      `${s.gathered.length ? `, after fetching some data it needed (${s.gathered.join(" ")})` : ""}.`;
    updateAuditRun(runId, {
      ...enriched,
      sections: [...(run.sections ?? []), s],
      quotaUnits: (run.quotaUnits ?? 0) + s.quotaUnits,
      chat: [
        ...(run.chat ?? []),
        { role: "user" as const, content: message, at },
        { role: "assistant" as const, content: note, at },
      ],
    });
    return { reply: note, refocused: null, section: { id: s.id, title: s.title, charts } };
  }

  let refocused: { note: string; videoCount: number } | undefined;
  if (action?.kind === "refocus") {
    const { findings, focus, membershipKnown } = await refocusReport(run, action);
    // Audits recorded before topic membership was persisted can only match a
    // topic against three example titles, which silently produces a tiny,
    // misleading subset. Refuse rather than hand back a report drawn from a
    // dozen videos that looked authoritative.
    if (!membershipKnown && (action.includeTopics?.length || action.excludeTopics?.length)) {
      const note = `${reply}\n\n(I did not apply that. This audit predates the fix that records which videos are in each topic, so a topic filter here would match only a handful of example titles rather than the real set — which is exactly the bug that produced an empty titles section. Re-run the audit to filter by topic, or ask me to filter by date instead.)`;
      updateAuditRun(runId, {
        chat: [
          ...(run.chat ?? []),
          { role: "user" as const, content: message, at: Date.now() },
          { role: "assistant" as const, content: note, at: Date.now() },
        ],
      });
      return { reply: note, refocused: null, staleTopics: true };
    }
    // A filter that leaves almost nothing is a worse report, not a sharper one,
    // so it is refused rather than applied and explained away afterwards.
    if (focus.videoCount < 5) {
      const chat = [
        ...(run.chat ?? []),
        { role: "user" as const, content: message, at: Date.now() },
        {
          role: "assistant" as const,
          content: `${reply}\n\n(I did not apply that — it would leave only ${focus.videoCount} videos, too few to conclude anything from. Try a wider window.)`,
          at: Date.now(),
        },
      ];
      updateAuditRun(runId, { chat });
      return { reply, refocused: null, tooNarrow: focus.videoCount };
    }
    // Keep the whole-catalogue report the FIRST time a focus is applied, so
    // narrowing is reversible. Once set it is never overwritten — otherwise a
    // second refocus would save the already-narrowed version as the "original".
    const baseFindings = run.baseFindings ?? run.findings;
    updateAuditRun(runId, { findings, focus, baseFindings });
    refocused = { note: focus.note, videoCount: focus.videoCount };
    if (!findings.titles.winning.length && !findings.titles.losing.length) {
      console.warn(`[audit] ${runId}: refocus to ${focus.videoCount} videos left no title pattern above the sample floor`);
    }
  }

  const chat = [
    ...(run.chat ?? []),
    { role: "user" as const, content: message, at: Date.now() },
    { role: "assistant" as const, content: reply, at: Date.now(), ...(refocused ? { refocused } : {}) },
  ];
  updateAuditRun(runId, { chat });
  return { reply, refocused: refocused ?? null };
}

// ── Engagement Manager (LAB tool — Phase 1: MONITOR YouTube comments) ─────────

const ENGAGE_PLATFORMS: ReadonlySet<string> = new Set(["youtube", "instagram", "facebook", "tiktok"]);
const ENGAGE_KINDS: ReadonlySet<string> = new Set(["comment", "dm"]);
const ENGAGE_REPLY_STATES: ReadonlySet<string> = new Set(["new", "queued", "replied", "skipped", "failed"]);
const ENGAGE_THREAD_SORTS: ReadonlySet<string> = new Set(["newest", "oldest", "active", "replies"]);
const ENGAGE_REPLY_MODES: ReadonlySet<string> = new Set(["off", "suggest", "auto"]);

/** Live status card: config + channels + kill-switch + rolled-up counts + monitor state. */
const engageStatus: Handler = async (): Promise<EngageStatus> => {
  const settings = getEngageSettings();
  const reg = getEngageRegistry();
  return {
    youtubeConfigured: engageYoutubeConfigured(),
    channels: listEngageChannels(),
    killSwitch: settings.killSwitch,
    globalAutoreply: settings.globalAutoreply,
    counts: {
      total: engageTotalCount(),
      new: engageNewCount(),
      byPlatform: engageCountsByPlatform(),
    },
    lastPollAt: reg.lastPollAt,
    polling: reg.polling,
    lastError: reg.lastError,
  };
};

/** Filtered, paginated inbox read. */
const engageListInbox: Handler = async (input) => {
  const filters: ListInboxInput = {};
  if (input?.platform !== undefined) {
    if (!ENGAGE_PLATFORMS.has(String(input.platform))) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "Invalid platform filter." });
    }
    filters.platform = String(input.platform) as EngagePlatform;
  }
  if (input?.kind !== undefined) {
    if (!ENGAGE_KINDS.has(String(input.kind))) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "Invalid kind filter." });
    }
    filters.kind = String(input.kind) as InboxKind;
  }
  if (input?.replyState !== undefined) {
    if (!ENGAGE_REPLY_STATES.has(String(input.replyState))) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "Invalid replyState filter." });
    }
    filters.replyState = String(input.replyState) as ReplyState;
  }
  if (typeof input?.channelId === "string" && input.channelId) filters.channelId = input.channelId;
  if (typeof input?.q === "string") filters.q = input.q;
  const limit = Number(input?.limit);
  if (Number.isFinite(limit) && limit > 0) filters.limit = Math.floor(limit);
  const offset = Number(input?.offset);
  if (Number.isFinite(offset) && offset >= 0) filters.offset = Math.floor(offset);
  return listEngageInbox(filters);
};

/** Threaded, paginated inbox read — each top-level comment with its full reply tree. */
const engageListThreads: Handler = async (input) => {
  const filters: ListThreadsInput = {};
  if (input?.platform !== undefined) {
    if (!ENGAGE_PLATFORMS.has(String(input.platform))) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "Invalid platform filter." });
    }
    filters.platform = String(input.platform) as EngagePlatform;
  }
  if (input?.kind !== undefined) {
    if (!ENGAGE_KINDS.has(String(input.kind))) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "Invalid kind filter." });
    }
    filters.kind = String(input.kind) as InboxKind;
  }
  if (typeof input?.channelId === "string" && input.channelId) filters.channelId = input.channelId;
  if (typeof input?.q === "string") filters.q = input.q;
  // Thread ordering — validate against the 4 allowed modes; anything else
  // (missing or unknown) silently defaults to 'newest'.
  filters.sort = ENGAGE_THREAD_SORTS.has(String(input?.sort)) ? (String(input.sort) as ThreadSort) : "newest";
  const limit = Number(input?.limit);
  if (Number.isFinite(limit) && limit > 0) filters.limit = Math.floor(limit);
  const offset = Number(input?.offset);
  if (Number.isFinite(offset) && offset >= 0) filters.offset = Math.floor(offset);
  return listEngageThreads(filters);
};

/** One inbox item + its thread siblings (chronological) + any reply record. */
const engageGetThread: Handler = async (input) => {
  const inboxId = String(input?.inboxId ?? "").trim();
  if (!inboxId) throw new ZiteError({ code: "BAD_REQUEST", message: "inboxId is required." });
  const item = getEngageInboxItem(inboxId);
  const thread = item?.threadId ? getEngageThread(item.threadId) : [];
  const reply = getEngageReplyForInbox(inboxId);
  return { item, thread, reply };
};

/** Toggle a channel's monitor (enabled) and/or reply mode. Returns the updated channel. */
const engageSetChannelMode: Handler = async (input) => {
  const channelId = String(input?.channelId ?? "").trim();
  if (!channelId) throw new ZiteError({ code: "BAD_REQUEST", message: "channelId is required." });
  const patch: { enabled?: boolean; replyMode?: ReplyMode } = {};
  if (input?.enabled !== undefined) patch.enabled = !!input.enabled;
  if (input?.replyMode !== undefined) {
    if (!ENGAGE_REPLY_MODES.has(String(input.replyMode))) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "replyMode must be one of off | suggest | auto." });
    }
    patch.replyMode = String(input.replyMode) as ReplyMode;
  }
  const channel = setEngageChannelMode(channelId, patch);
  if (!channel) throw new ZiteError({ code: "NOT_FOUND", message: "Channel not found." });
  return channel;
};

/** Master safety switch (STARTS ON). Phase 1 monitor is read-only; this gates future auto-reply. */
const engageKillSwitch: Handler = async (input) => {
  if (typeof input?.killSwitch !== "boolean") {
    throw new ZiteError({ code: "BAD_REQUEST", message: "killSwitch (boolean) is required." });
  }
  const settings = setEngageSettings({ killSwitch: input.killSwitch });
  return { killSwitch: settings.killSwitch };
};

/**
 * Whether Meta (Instagram + Facebook) comment monitoring is configured (a Meta
 * user token is stored). Inert until then — mirrors the YouTube-key pattern.
 * Reports configured-state only, never the token.
 */
const metaStatus: Handler = async () => {
  return { configured: engageMetaConfigured() };
};

/**
 * Whether TikTok comment monitoring is configured (an Apify token is stored). Inert
 * until then — mirrors the YouTube-key / Meta-token pattern. Reports configured-state
 * only, never the token.
 */
const tiktokStatus: Handler = async () => {
  return { configured: engageTiktokConfigured() };
};

/** Re-seed the monitored channels from the connected YouTube + Meta + TikTok accounts, then return them. */
const engageRefreshChannels: Handler = async () => {
  await seedChannelsFromConnected();
  return { channels: listEngageChannels() };
};

/** Kick a monitor cycle now (skipped when one is already in flight). */
const engagePollNow: Handler = async () => {
  const { started } = engagePollOnce();
  return {
    started,
    message: started ? "Monitor cycle started." : "A monitor cycle is already running.",
  };
};

/**
 * Force-refresh every enabled channel's engagement stats now (bypasses the TTL —
 * the manual "refresh stats" button). Returns the updated channels so the UI can
 * re-render the per-channel subscriber/comment/like counts.
 */
const engageRefreshStats: Handler = async () => {
  const { refreshed } = await engageRefreshAllChannelStats();
  return { refreshed, channels: listEngageChannels() };
};


// ── Engagement Manager — replies (Phase 3: draft → approve → send) ───────────

const ENGAGE_REPLY_STATUSES: ReadonlySet<string> = new Set(["draft", "pending", "sent", "failed", "skipped"]);

/** Resolve + validate a browser-driven platform from untrusted input. */
function engageBrowserPlatform(input: any): "instagram" | "facebook" | "tiktok" {
  const platform = String(input?.platform ?? "");
  if (!isBrowserPlatform(platform as EngagePlatform)) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: `platform must be one of: ${BROWSER_PLATFORMS.join(", ")}.`,
    });
  }
  return platform as "instagram" | "facebook" | "tiktok";
}

/**
 * Everything the reply half of the UI needs: the three safety keys, whether a
 * voice prompt is stored, throttle usage per platform, and the login state of
 * each platform browser. Never returns the prompt text itself (see
 * engageGetReplyPrompt) so the 2s status poll stays small.
 */
const engageReplyStatus: Handler = async (): Promise<ReplyStatusOutput> => {
  const settings = getEngageSettings();
  const browsers = await engageConsole.listSessions();
  const counts = { draft: 0, pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const status of Object.keys(counts) as Array<keyof typeof counts>) {
    counts[status] = listEngageReplies({ status: status as ReplyStatus, limit: 1 }).total;
  }
  return {
    killSwitch: settings.killSwitch,
    globalAutoreply: settings.globalAutoreply,
    replyPromptSet: !!settings.replyPromptMd && settings.replyPromptMd.trim().length > 0,
    aiConfigured: engageAiConfigured(),
    dryRun: engageDryRun(),
    pacing: settings.pacing,
    usage: BROWSER_PLATFORMS.map((platform) => ({
      platform: platform as EngagePlatform,
      ...engageThrottleUsage(settings, platform as EngagePlatform),
    })),
    browsers: browsers.map((b) => ({ ...b, platform: b.platform as EngagePlatform })),
    counts,
  };
};

/** The review queue: reply rows joined with the item each one answers. */
const engageListReplies: Handler = async (input) => {
  const status = input?.status;
  if (status !== undefined && !ENGAGE_REPLY_STATUSES.has(String(status))) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Unknown reply status." });
  }
  const { replies, total } = listEngageReplies({
    status: status as ReplyStatus | undefined,
    platform: input?.platform as EngagePlatform | undefined,
    channelId: input?.channelId ? String(input.channelId) : undefined,
    limit: input?.limit,
    offset: input?.offset,
  });
  const entries: ReplyQueueEntry[] = replies.map((reply) => ({
    reply,
    item: getEngageInboxItem(reply.inboxId),
  }));
  return { entries, total };
};

/** The operator's voice prompt, for editing. */
const engageGetReplyPrompt: Handler = async () => {
  const settings = getEngageSettings();
  return { replyPromptMd: settings.replyPromptMd ?? "" };
};

/**
 * Update the operator-supplied reply settings. The voice prompt lives here (in
 * the DB, supplied through the UI) rather than in the repo or the image.
 */
const engageUpdateSettings: Handler = async (input) => {
  const patch: Record<string, unknown> = {};
  if (typeof input?.replyPromptMd === "string") patch.replyPromptMd = input.replyPromptMd;
  if (typeof input?.globalAutoreply === "boolean") patch.globalAutoreply = input.globalAutoreply;
  if (input?.caps && typeof input.caps === "object") patch.caps = input.caps;
  if (input?.pacing && typeof input.pacing === "object") {
    const p = input.pacing;
    const hours = Array.isArray(p.activeHours) ? p.activeHours : [8, 23];
    patch.pacing = {
      minDelaySec: Math.max(0, Number(p.minDelaySec) || 45),
      maxDelaySec: Math.max(0, Number(p.maxDelaySec) || 180),
      activeHours: [Number(hours[0]) || 0, Number(hours[1]) || 0],
    };
  }
  const settings = setEngageSettings(patch as any);
  return {
    globalAutoreply: settings.globalAutoreply,
    pacing: settings.pacing,
    caps: settings.caps,
    replyPromptSet: !!settings.replyPromptMd,
  };
};

/**
 * Draft a reply for one item on demand — ignores the channel's reply_mode so a
 * human can ask for a suggestion on anything, but still lands as a `draft` that
 * needs approving. Refuses if the item already has a reply row.
 */
const engageDraftReply: Handler = async (input) => {
  const inboxId = String(input?.inboxId ?? "");
  if (!inboxId) throw new ZiteError({ code: "BAD_REQUEST", message: "inboxId is required." });
  const item = getEngageInboxItem(inboxId);
  if (!item) throw new ZiteError({ code: "NOT_FOUND", message: "Inbox item not found." });
  // A previous decision is not a dead end when a PERSON asks for a draft. The
  // bot may have skipped this as spam, or written something Jake doesn't like —
  // "regenerate" is exactly the button for that. The old row is discarded first
  // so the item never carries two live decisions.
  const existing = hasEngageReply(inboxId) ? latestEngageReplyFor(inboxId) : null;
  if (existing) {
    if (input?.regenerate !== true) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "This item already has a reply decision." });
    }
    if (existing.status === "sent") {
      throw new ZiteError({ code: "BAD_REQUEST", message: "That reply has already been sent." });
    }
    updateEngageReply(existing.id, { status: "skipped", decideReason: "Replaced by a regenerated draft." });
  }
  const settings = getEngageSettings();
  if (!replyGenReady(settings.replyPromptMd)) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "No reply prompt is configured (or the Anthropic key is missing) — reply generation is inert.",
    });
  }
  const channel = getEngageChannel(item.channelId);
  // Never draft a reply to your own comment. The background worker filters
  // these out in SQL; this path doesn't, and without the guard we'd pay Opus
  // just to have it notice (which it does, reliably — but that's ~$0.006 a time).
  if (channel && item.authorId && item.authorId === channel.externalId) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That comment is your own — there's nothing to reply to." });
  }
  const thread = item.threadId ? getEngageThread(item.threadId) : [];
  const draft = await engageGenerateReply({
    item,
    thread,
    channelName: channel?.displayName ?? null,
    replyPromptMd: settings.replyPromptMd ?? "",
  });

  const reply = createEngageReply({
    inboxId: item.id,
    channelId: item.channelId,
    platform: item.platform,
    status: draft.shouldReply && draft.text ? "draft" : "skipped",
    mechanism: "browser",
    generatedText: draft.text,
    decideReason: draft.reason,
    notBefore: Date.now(),
    costUsd: draft.costUsd,
  });
  setEngageInboxReplyState(item.id, draft.shouldReply && draft.text ? "queued" : "skipped");
  return { reply };
};

/**
 * Approve a drafted reply (optionally with edited text) and queue it for
 * dispatch. This is the human gate for 'suggest'-mode channels.
 */
const engageApproveReply: Handler = async (input) => {
  const replyId = String(input?.replyId ?? "");
  if (!replyId) throw new ZiteError({ code: "BAD_REQUEST", message: "replyId is required." });
  const reply = getEngageReply(replyId);
  if (!reply) throw new ZiteError({ code: "NOT_FOUND", message: "Reply not found." });
  if (reply.status !== "draft" && reply.status !== "failed") {
    throw new ZiteError({ code: "BAD_REQUEST", message: `Only draft or failed replies can be approved (this one is ${reply.status}).` });
  }
  const text = typeof input?.text === "string" && input.text.trim() ? input.text.trim() : reply.generatedText;
  if (!text) throw new ZiteError({ code: "BAD_REQUEST", message: "Nothing to send — the reply has no text." });

  const settings = getEngageSettings();
  const updated = updateEngageReply(replyId, {
    status: "pending",
    generatedText: text,
    // Approving resets the retry budget — a human has looked at it.
    attempts: 0,
    error: null,
    notBefore: input?.now === true ? Date.now() : engageScheduleAt(settings.pacing),
  });
  setEngageInboxReplyState(reply.inboxId, "queued");
  // Tell the caller straight away if the throttle will hold it back, rather
  // than leaving them wondering why an approved reply hasn't appeared.
  const verdict = engageCanSend(settings, reply.platform, Date.now());
  return { reply: updated, willSend: verdict.allowed, holdReason: verdict.allowed ? null : verdict.reason };
};

/**
 * Send one reply NOW, on the operator's say-so — the "Send" button.
 *
 * This is deliberately NOT engageApproveReply. Approving hands a reply to the
 * background worker, which then waits for its pacing delay, re-checks the caps
 * and the active-hours window, and only sends if the kill-switch is off. All of
 * that exists to make an UNATTENDED replier behave; none of it should stand
 * between a person pressing Send and the message going out. So this dispatches
 * inline and reports what actually happened, rather than queueing and hoping.
 *
 * It overrides the dry run for the same reason: dry run exists because nobody
 * reads the bot's replies before they post. Somebody just read this one.
 *
 * The send is still RECORDED against the rate counters — a manual send is a real
 * message to the platform, and hiding it from the caps would let the autonomous
 * worker send its full allowance on top.
 */
const engageSendReply: Handler = async (input) => {
  const replyId = String(input?.replyId ?? "");
  const typed = typeof input?.text === "string" ? input.text.trim() : "";
  let reply = replyId ? getEngageReply(replyId) : null;
  if (replyId && !reply) throw new ZiteError({ code: "NOT_FOUND", message: "Reply not found." });

  // No reply row yet: the operator wrote this one themselves and never asked for
  // a draft. Their words still need a row to hang the outcome on, so make one.
  if (!reply) {
    const inboxId = String(input?.inboxId ?? "");
    if (!inboxId) throw new ZiteError({ code: "BAD_REQUEST", message: "replyId or inboxId is required." });
    if (!typed) throw new ZiteError({ code: "BAD_REQUEST", message: "Nothing to send — write a reply first." });
    const target = getEngageInboxItem(inboxId);
    if (!target) throw new ZiteError({ code: "NOT_FOUND", message: "Inbox item not found." });
    const prior = latestEngageReplyFor(inboxId);
    if (prior?.status === "sent") {
      throw new ZiteError({ code: "BAD_REQUEST", message: "That message has already been answered." });
    }
    if (prior) updateEngageReply(prior.id, { status: "skipped", decideReason: "Replaced by a reply you wrote." });
    reply = createEngageReply({
      inboxId,
      channelId: target.channelId,
      platform: target.platform,
      status: "draft",
      mechanism: null,
      generatedText: typed,
      decideReason: "Written by you.",
      notBefore: Date.now(),
      costUsd: 0,
    });
  }

  if (reply.status === "sent") {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That reply has already been sent." });
  }

  const text = typed || reply.generatedText;
  if (!text) throw new ZiteError({ code: "BAD_REQUEST", message: "Nothing to send — the reply is empty." });

  const item = getEngageInboxItem(reply.inboxId);
  if (!item) throw new ZiteError({ code: "NOT_FOUND", message: "The message this answers no longer exists." });
  if (!isBrowserPlatform(reply.platform)) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: `${reply.platform} is monitor-only here — replies to it are handled elsewhere.`,
    });
  }

  const result = await engageSendReplyNow(reply.platform, {
    permalink: item.permalink,
    text,
    channelId: reply.channelId,
    commentId: item.dedupKey,
    threadId: item.threadId,
    kind: item.kind,
    authorId: item.authorId,
    postedAt: item.postedAt,
    dryRun: false,
  });

  const updated = updateEngageReply(reply.id, {
    status: result.ok ? "sent" : "failed",
    generatedText: text,
    attempts: reply.attempts + 1,
    mechanism: result.mechanism,
    externalReplyId: result.externalId,
    error: result.error,
    sentAt: result.ok ? Date.now() : null,
  });
  setEngageInboxReplyState(reply.inboxId, result.ok ? "replied" : "failed");
  if (result.ok) engageRecordSend(reply.platform);

  return { reply: updated, ok: result.ok, error: result.error, mechanism: result.mechanism };
};

/** Reject a drafted/queued reply. Records it as skipped — it is never sent. */
const engageRejectReply: Handler = async (input) => {
  const replyId = String(input?.replyId ?? "");
  if (!replyId) throw new ZiteError({ code: "BAD_REQUEST", message: "replyId is required." });
  const reply = getEngageReply(replyId);
  if (!reply) throw new ZiteError({ code: "NOT_FOUND", message: "Reply not found." });
  if (reply.status === "sent") {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That reply has already been sent." });
  }
  const reason = typeof input?.reason === "string" && input.reason.trim() ? input.reason.trim() : "Rejected by operator.";
  const updated = updateEngageReply(replyId, { status: "skipped", decideReason: reason, error: null });
  setEngageInboxReplyState(reply.inboxId, "skipped");
  return { reply: updated };
};

/** Run a reply cycle now (draft + dispatch), in addition to the background loop. */
const engageReplyCycleNow: Handler = async () => {
  const settings = getEngageSettings();
  if (settings.killSwitch) {
    return { started: false, message: "Kill-switch is armed — the reply worker is paused." };
  }
  const { started } = replyCycleNow();
  const worker = replyWorkerState();
  return { started, message: started ? undefined : "A reply cycle is already running.", lastError: worker.lastError };
};

// ── Engagement Manager — browser login console (Phase 3) ─────────────────────

function engageFrame(out: { image: string | null; url: string | null; error: string | null }): BrowserFrameOutput {
  return { ...out, width: ENGAGE_VIEWPORT.width, height: ENGAGE_VIEWPORT.height };
}

/** Login state of each platform browser. */
const engageBrowserStatus: Handler = async () => {
  const sessions = await engageConsole.listSessions();
  return { sessions };
};

/** Launch (or re-check) a platform's browser and return the first frame. */
const engageBrowserOpen: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  const status = await engageConsole.openSession(platform);
  const frame = await engageConsole.frame(platform);
  return { status, frame: engageFrame(frame) };
};

/** Current frame — this is what the console polls while someone is logging in. */
const engageBrowserFrame: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  return { frame: engageFrame(await engageConsole.frame(platform)) };
};

/**
 * Click at a position given as a FRACTION of the rendered image, scaled here to
 * the real viewport — so the console works at whatever size the browser renders
 * it, and a bad coordinate can't be used to poke outside the page.
 */
const engageBrowserClick: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  const xFrac = Math.min(Math.max(Number(input?.xFrac) || 0, 0), 1);
  const yFrac = Math.min(Math.max(Number(input?.yFrac) || 0, 0), 1);
  const frame = await engageConsole.click(
    platform,
    Math.round(xFrac * ENGAGE_VIEWPORT.width),
    Math.round(yFrac * ENGAGE_VIEWPORT.height),
  );
  return { frame: engageFrame(frame) };
};

/** Type into whatever is focused in the console (e.g. the platform's login form). */
const engageBrowserType: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  const text = String(input?.text ?? "");
  if (!text) throw new ZiteError({ code: "BAD_REQUEST", message: "text is required." });
  if (text.length > 500) throw new ZiteError({ code: "BAD_REQUEST", message: "text is too long." });
  const frame = await engageConsole.type(platform, text);
  return { frame: engageFrame(frame) };
};

/** Press a single named key (Enter, Tab, Backspace…). */
const engageBrowserKey: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  const key = String(input?.key ?? "");
  if (!/^[A-Za-z0-9]+$/.test(key)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "key must be a simple key name (Enter, Tab, Backspace…)." });
  }
  const frame = await engageConsole.pressKey(platform, key);
  return { frame: engageFrame(frame) };
};

/**
 * Drag inside the console: press at one point, move, release at another. This
 * is what makes TikTok's slider captcha solvable — clicks alone can't do it.
 */
const engageBrowserDrag: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  const frac = (v: unknown) => Math.min(Math.max(Number(v) || 0, 0), 1);
  const frame = await engageConsole.drag(
    platform,
    { x: Math.round(frac(input?.fromXFrac) * ENGAGE_VIEWPORT.width), y: Math.round(frac(input?.fromYFrac) * ENGAGE_VIEWPORT.height) },
    { x: Math.round(frac(input?.toXFrac) * ENGAGE_VIEWPORT.width), y: Math.round(frac(input?.toYFrac) * ENGAGE_VIEWPORT.height) },
  );
  return { frame: engageFrame(frame) };
};

/** Scroll the console page. */
const engageBrowserScroll: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  const dy = Math.min(Math.max(Number(input?.dy) || 0, -2000), 2000);
  const frame = await engageConsole.scroll(platform, dy);
  return { frame: engageFrame(frame) };
};

/** Navigate the console. Allow-listed to the platform's own domains. */
const engageBrowserNavigate: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  const frame = await engageConsole.navigate(platform, String(input?.url ?? ""));
  return { frame: engageFrame(frame) };
};

/** Re-check whether the profile is still signed in (after finishing a login). */
const engageBrowserVerify: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  return { status: await engageConsole.verifySession(platform) };
};

/**
 * Import session cookies exported from a browser that's already logged in on the
 * operator's own device — TikTok's login fallback, since it refuses a fresh
 * login from the droplet. Accepts an extension JSON export, a Netscape
 * cookies.txt, or a raw Cookie header; parseCookies drops anything not on the
 * platform's own domains before it can reach the profile.
 */
const engageBrowserImportCookies: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  const raw = String(input?.cookies ?? "");
  if (!raw.trim()) throw new ZiteError({ code: "BAD_REQUEST", message: "Paste your exported cookies first." });
  if (raw.length > 500_000) throw new ZiteError({ code: "BAD_REQUEST", message: "That cookie export is too large." });
  const parsed = parseCookies(raw, platform);
  if (parsed.cookies.length === 0) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: `No ${platform} cookies found in what you pasted. Export cookies while logged in to ${platform}, then paste them here.`,
    });
  }
  const status = await engageConsole.importCookies(platform, parsed.cookies);
  return { status, imported: parsed.cookies.length, skipped: parsed.total - parsed.cookies.length };
};

/** Close a platform's browser. The logged-in profile on disk survives. */
const engageBrowserClose: Handler = async (input) => {
  const platform = engageBrowserPlatform(input);
  await engageConsole.closeSession(platform);
  return { ok: true };
};

// ── Skool manager ─────────────────────────────────────────────────────────────
// Skool has no public API, so every one of these is really a question about a
// headless browser: is one available, does its profile still hold a session,
// and which account is that session for.

const skoolStatus: Handler = async () => {
  const available = await skoolBrowserAvailable();
  const settings = getSkoolSettings();
  if (!available) {
    return {
      browserAvailable: false,
      loggedIn: false,
      account: null,
      url: null,
      error: "No headless browser on this server, so Skool cannot be driven at all.",
      open: false,
      settings,
    };
  }
  // Only report a session when one is genuinely open. Launching a browser on
  // every status poll would spend seconds and RAM to answer a question the
  // page asks on a timer.
  if (!isSkoolOpen()) {
    return { browserAvailable: true, loggedIn: false, account: null, url: null, error: null, open: false, settings };
  }
  const state = await checkSkoolLogin();
  return { browserAvailable: true, ...state, open: true, settings };
};

/** Force a live check — launches the browser if it isn't already up. */
const skoolCheckLogin: Handler = async () => {
  if (!(await skoolBrowserAvailable())) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "No headless browser available on this server." });
  }
  const state = await checkSkoolLogin();
  return { ...state, open: isSkoolOpen(), settings: getSkoolSettings() };
};

const skoolImportCookies: Handler = async (input) => {
  const raw = String(input?.cookies ?? "");
  if (!raw.trim()) throw new ZiteError({ code: "BAD_REQUEST", message: "Paste your exported cookies first." });
  // Same 500KB cap the engagement importer uses — a cookie export is a few KB,
  // and anything near this is a paste accident, not a session.
  if (raw.length > 500_000) throw new ZiteError({ code: "BAD_REQUEST", message: "That paste is too large to be a cookie export." });
  if (!(await skoolBrowserAvailable())) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "No headless browser available on this server." });
  }
  const result = await importSkoolCookies(raw);
  return { ...result, open: isSkoolOpen(), settings: getSkoolSettings() };
};

const skoolCloseBrowser: Handler = async () => {
  await closeSkool();
  return { closed: true };
};

/**
 * Read the live classroom.
 *
 * Read live every call, never cached: Jake can edit the classroom in another
 * tab, and a stale course list is wrong exactly when it matters — when we are
 * about to reorder or rewrite something in it.
 */
const skoolReadClassroom: Handler = async (input) => {
  const settings = getSkoolSettings();
  const url = String(input?.communityUrl ?? settings.communityUrl ?? "").trim();
  if (!url) throw new ZiteError({ code: "BAD_REQUEST", message: "Set the community URL first." });
  return { classroom: await readClassroom(url) };
};

/** Read one course's inner structure — what a reorganisation actually moves. */
const skoolReadCourse: Handler = async (input) => {
  const settings = getSkoolSettings();
  const url = String(input?.communityUrl ?? settings.communityUrl ?? "").trim();
  const slug = String(input?.slug ?? "").trim();
  if (!url || !slug) throw new ZiteError({ code: "BAD_REQUEST", message: "Community URL and course slug are both required." });
  return { course: await readCourse(url, slug) };
};

/**
 * Read the whole classroom — every course, and everything inside it.
 *
 * Kicked off in the background and polled, because it is minutes of sequential
 * browser work rather than a request. Returns immediately with the row id.
 *
 * One inventory at a time: a second concurrent read would drive the same single
 * browser page from two places and interleave two courses' navigations.
 */
const skoolBuildInventory: Handler = async (input) => {
  const settings = getSkoolSettings();
  const url = String(input?.communityUrl ?? settings.communityUrl ?? "").trim();
  if (!url) throw new ZiteError({ code: "BAD_REQUEST", message: "Set the community URL first." });

  const running = latestInventory();
  if (running?.status === "running") {
    return { inventory: running, alreadyRunning: true };
  }

  const id = startInventory(url);
  void (async () => {
    try {
      const data = await readFullClassroom(url, (read, total) => setInventoryProgress(id, read, total));
      finishInventory(id, data, data.error);
    } catch (err) {
      finishInventory(id, {}, String(err));
    }
  })();

  return { inventory: getInventory(id), alreadyRunning: false };
};

/** The newest snapshot — running or finished — for polling and for the planner. */
const skoolGetInventory: Handler = async (input) => {
  const id = Number(input?.id ?? 0);
  const inventory = id > 0 ? getInventory(id) : latestInventory();
  return { inventory };
};

/**
 * Design a new spine for the classroom.
 *
 * Reads nothing from Skool itself — it plans against the newest COMPLETE
 * inventory snapshot, and refuses if there isn't one. Planning against a
 * half-finished read is how a rebuild proposes creating things that exist.
 *
 * Background + polled: several director-tier calls is a minute or two.
 */
const skoolBuildPlan: Handler = async () => {
  const settings = getSkoolSettings();
  const snapshot = latestCompleteInventory();
  if (!snapshot || !snapshot.data?.courses?.length) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "Read the classroom first — a plan needs a complete inventory to work from.",
    });
  }

  const running = latestSkoolPlan();
  if (running?.status === "running") return { plan: running, alreadyRunning: true };

  const id = startSkoolPlan(snapshot.id);
  void (async () => {
    try {
      const plan = await runPlan({
        inventory: snapshot.data,
        channelUrl: settings.channelUrl,
        roadmap: settings.roadmapMd,
        requiredTracks: settings.requiredTracks,
      });
      finishSkoolPlan(id, plan, null);
    } catch (err) {
      finishSkoolPlan(id, {}, err instanceof Error ? err.message : String(err));
    }
  })();

  return { plan: getSkoolPlan(id), alreadyRunning: false };
};

/**
 * Write every page of the plan to the zero-to-advanced standard.
 *
 * Background and polled — 136 director-tier calls plus a transcript fetch for
 * each video without a write-up. Progress lands on the plan row so a run that
 * dies partway is visibly partial rather than silently short.
 */
const lessonRunsInFlight = new Set<number>();

const skoolWriteLessons: Handler = async (input) => {
  const id = Number(input?.planId ?? 0);
  const plan = id > 0 ? getSkoolPlan(id) : latestSkoolPlan();
  if (!plan || plan.status !== "done" || !plan.data?.tracks?.length) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Build a plan first — there are no pages to write." });
  }
  // ⚠️ A "running" ROW IS NOT PROOF OF A RUNNING JOB. The first real run died
  // at page 35 of 136 in a container restart and left this column saying
  // running forever, which locked the plan out of ever being written again.
  // The truth is in this process's own set: if the job were alive, it would be
  // here. A row that claims otherwise is a survivor of a dead process.
  if (plan.lessonsStatus === "running" && lessonRunsInFlight.has(plan.id)) return { plan, alreadyRunning: true };

  const snapshot = getInventory(plan.inventoryId);
  if (!snapshot?.data?.courses?.length) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "The inventory this plan was built from is missing, so existing write-ups cannot be read.",
    });
  }

  const data = plan.data;
  const total = data.tracks.reduce((n: number, t: any) => n + (t.modules?.length ?? 0), 0);
  const alreadyWritten = data.tracks.reduce(
    (n: number, t: any) => n + (t.modules ?? []).filter((m: any) => m.lesson?.body).length,
    0,
  );
  setLessonProgress(plan.id, "running", alreadyWritten, total);
  lessonRunsInFlight.add(plan.id);

  void (async () => {
    try {
      const stats = await writePlanLessons(data, snapshot.data, {
        onProgress: (done) => setLessonProgress(plan.id, "running", done, total),
        // Persisted per page. 136 director-tier calls is an hour of work and
        // real money; losing it to a restart once was enough.
        onCheckpoint: () => updatePlanData(plan.id, data),
        force: input?.force === true,
      });
      data.lessonStats = stats;
      updatePlanData(plan.id, data);
      setLessonProgress(plan.id, "done", total, total);
    } catch {
      // The pages already written stay written — the checkpoints kept them.
      setLessonProgress(plan.id, "failed", alreadyWritten, total);
    } finally {
      lessonRunsInFlight.delete(plan.id);
    }
  })();

  return { plan: getSkoolPlan(plan.id), alreadyRunning: false };
};

const skoolGetPlan: Handler = async (input) => {
  const id = Number(input?.id ?? 0);
  return { plan: id > 0 ? getSkoolPlan(id) : latestSkoolPlan() };
};

/* ── Skool teach console ───────────────────────────────────────────────────
   A live view of the Skool browser so the operator can DEMONSTRATE each admin
   action once. Skool's controls cannot be found by querying the DOM — they are
   plain divs that do not exist until hovered — so they are taught, not guessed.
   Clicks drive the real mouse; a synthetic click does nothing to Skool's menus. */

const skoolConsoleFrame: Handler = async () => ({ frame: await skoolConsole.frame() });

const skoolConsoleNavigate: Handler = async (input) => ({
  frame: await skoolConsole.navigate(String(input?.url ?? "")),
});

/** Hover, and — while teaching — report what was under the pointer. */
const skoolConsoleHover: Handler = async (input) => {
  const describe = input?.describe === true;
  return input?.xFrac !== undefined
    ? skoolConsole.hoverFrac(Number(input.xFrac), Number(input.yFrac ?? 0), { describe })
    : skoolConsole.hover(Number(input?.x ?? 0), Number(input?.y ?? 0), { describe });
};

/** Click, and — while teaching — report what was under the pointer. */
const skoolConsoleClick: Handler = async (input) => {
  const describe = input?.describe === true;
  return input?.xFrac !== undefined
    ? skoolConsole.clickFrac(Number(input.xFrac), Number(input.yFrac ?? 0), { describe })
    : skoolConsole.clickAt(Number(input?.x ?? 0), Number(input?.y ?? 0), { describe });
};

const skoolConsoleType: Handler = async (input) => ({
  frame: await skoolConsole.typeText(String(input?.text ?? "")),
});

const skoolConsoleKey: Handler = async (input) => {
  // A combo can arrive as ["Control","a"] or as "Control+a"; both mean the same
  // thing to an operator and should not be two different endpoints.
  if (Array.isArray(input?.combo)) {
    return { frame: await skoolConsole.pressCombo(input.combo.map((k: any) => String(k))) };
  }
  return { frame: await skoolConsole.pressKey(String(input?.key ?? "Enter")) };
};

const skoolConsoleScroll: Handler = async (input) => ({
  frame: await skoolConsole.scrollBy(Number(input?.dy ?? 0)),
});

/**
 * Run ONE learned action against the live classroom.
 *
 * Deliberately one action per call, not a batch: the first writes to a real
 * community should be individually invoked and individually inspected, and a
 * batch that fails halfway leaves a classroom in a state nobody chose.
 */
const communityUrlOrThrow = (): string => {
  const url = String(getSkoolSettings().communityUrl ?? "").trim();
  if (!url) throw new ZiteError({ code: "BAD_REQUEST", message: "Set the community URL first." });
  return url;
};

/**
 * The engagement half of the Skool Manager — reads and drafts only.
 *
 * Nothing here writes to Skool. Drafting is separated from posting on purpose:
 * Jake asked for full autonomy, so the only chance to look at what this agent
 * produces before a community of members does is while it is still a draft, and
 * that has to be reachable on its own.
 */
const skoolReadFeed: Handler = async (input) => {
  const maxPages = Math.max(1, Math.min(9, Number(input?.maxPages ?? 2)));
  return { feed: await readFeed(communityUrlOrThrow(), maxPages) };
};

const skoolReadPost: Handler = async (input) => {
  const slug = String(input?.slug ?? "").trim();
  if (!slug) throw new ZiteError({ code: "BAD_REQUEST", message: "Which post? Pass its slug." });
  return await readPost(communityUrlOrThrow(), slug);
};

/**
 * A post's comments, with their real ids, over Skool's own API.
 *
 * Distinct from `skoolReadPost`, which scrapes the DOM and cannot see an id.
 * `answerable` is what a reply worker acts on: top-level, not ours, not already
 * answered by us.
 */
const skoolReadComments: Handler = async (input) => {
  const slug = String(input?.slug ?? "").trim();
  if (!slug) throw new ZiteError({ code: "BAD_REQUEST", message: "Which post? Pass its slug." });
  const read = await readComments(communityUrlOrThrow(), slug);
  return { ...read, answerable: answerable(read.comments) };
};

const skoolUnreadChats: Handler = async () => {
  return { unreadChats: await unreadChatCount(communityUrlOrThrow()) };
};

/** What the agent knows: retrieval over the rebuilt classroom. No model call. */
const skoolKnowledge: Handler = async (input) => {
  const query = String(input?.query ?? "").trim();
  const communityUrl = communityUrlOrThrow();
  // No query = show what is indexed. `pages: true` itemises every page inside
  // every course, which is the level the agent actually cites at.
  if (!query) {
    if (input?.pages === true) return indexedCourses(communityUrl);
    const outline = classroomOutline(communityUrl);
    return { outline: outline.outline, courses: outline.courses, lessons: outline.lessons };
  }
  const { hits, searched, inventoryId, error } = retrieve(communityUrl, query, Math.min(10, Number(input?.limit ?? 5)));
  return {
    searched,
    inventoryId,
    error,
    hits: hits.map((h) => ({
      title: h.title,
      course: h.courseTitle,
      // Reported, because it decides whether this lesson may be LINKED in
      // anything published — see `Lesson.rebuilt`.
      rebuilt: h.rebuilt,
      url: h.url,
      score: Number(h.score.toFixed(2)),
      excerpt: h.excerpt,
    })),
  };
};

/**
 * Fetch the transcript of every video the indexed classroom attaches, and store
 * it. One-time; retrieval reads the table and never the network.
 *
 * ⚠️ THIS ONE SPENDS MONEY — Apify charges per transcript, unlike every model
 * call in this feature, which runs on the Max subscription. So it is an
 * explicit operation with a report, never a side effect of a query. Pass
 * `dryRun` to see what it WOULD fetch and what is already held.
 */
const skoolBackfillTranscripts: Handler = async (input) => {
  const communityUrl = communityUrlOrThrow();
  const { lessons } = allLessons(communityUrl);
  const videoIds = lessons.map((l) => l.videoId).filter((id): id is string => !!id);
  const coverage = transcriptCoverage(videoIds);

  if (input?.dryRun === true) {
    return {
      dryRun: true,
      lessons: lessons.length,
      lessonsWithVideo: videoIds.length,
      coverage,
    };
  }

  const result = await backfillTranscripts(videoIds, {
    refetchEmpty: input?.refetchEmpty === true,
    // ⚠️ MUST BE FORWARDED. Without it a caller asking for a free run gets the
    // free-then-paid default and spends money it explicitly declined to spend —
    // which is exactly what happened on the first attempt at this backfill.
    freeOnly: input?.freeOnly === true,
  });
  return { result, coverage: transcriptCoverage(videoIds) };
};

/**
 * Draft a post. Does NOT publish it — see the note on `skoolReadFeed`.
 *
 * The voice comes from the Engagement Manager's stored prompt, which is Jake's
 * choice (2026-08-05: "reuse the engagement tool's prompt"). Passed verbatim.
 */
const skoolDraftPost: Handler = async (input) => {
  const communityUrl = communityUrlOrThrow();
  const kind = String(input?.kind ?? "lesson") === "mcp" ? "mcp" : "lesson";
  const subject = String(input?.subject ?? "").trim();
  if (!subject) throw new ZiteError({ code: "BAD_REQUEST", message: "What should the post be about?" });

  const feed = await readFeed(communityUrl, 1);
  const { draft, error } = await draftPost({
    communityUrl,
    voicePrompt: getEngageSettings().replyPromptMd ?? "",
    kind,
    subject,
    recentTitles: feed.posts.filter((p) => p.byMe).slice(0, 12).map((p) => p.title).filter(Boolean),
    // His own posts, as the style spec for the body. From the SAME feed read —
    // a second one would be a second headless browser cycle for nothing.
    styleExamples: styleExamplesFrom(feed.posts),
    categories: feed.categories.length ? feed.categories : SKOOL_CATEGORIES,
    preferredCategory: input?.category ? String(input.category) : null,
  });
  return { draft, error };
};

/**
 * Publish a post to the community. THE FIRST ENDPOINT HERE THAT WRITES.
 *
 * Takes the finished text rather than a subject: drafting and publishing stay
 * separate so a draft can be looked at, and so a failed publish never silently
 * re-drafts into something different from what was reviewed.
 */
const skoolPublishPost: Handler = async (input) => {
  const title = String(input?.title ?? "").trim();
  const body = String(input?.body ?? "");
  if (!title || !body.trim()) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "A post needs both a title and a body." });
  }
  return await createPost({
    communityUrl: communityUrlOrThrow(),
    title,
    body,
    category: input?.category ? String(input.category) : null,
  });
};

/** Draft a reply to one comment or DM. Does NOT send it. */
const skoolDraftReply: Handler = async (input) => {
  const text = String(input?.text ?? "").trim();
  if (!text) throw new ZiteError({ code: "BAD_REQUEST", message: "Nothing to reply to." });
  const { reply, error } = await draftReply({
    communityUrl: communityUrlOrThrow(),
    voicePrompt: getEngageSettings().replyPromptMd ?? "",
    surface: String(input?.surface ?? "comment") === "dm" ? "dm" : "comment",
    authorName: String(input?.authorName ?? "a member"),
    // The bench passes a display name; the greeting needs the first name only.
    authorFirstName: String(input?.authorFirstName ?? "") || firstNameOf(String(input?.authorName ?? "")),
    text,
    context: String(input?.context ?? ""),
  });
  return { reply, error };
};

/**
 * Send a reply to one comment. THE SECOND ENDPOINT HERE THAT WRITES.
 *
 * ⚠️ IT TAKES THE COMMENT'S ID *AND* ITS TEXT, AND NEEDS BOTH. The id is what
 * Skool's API knows the comment by and is the dedupe key; the text is the only
 * handle the rendered page shares with it, because a comment has no id, no data
 * attribute and no permalink in the DOM. Reading happens over the API, writing
 * happens through the UI, and the text is the seam between them —
 * `skoolReadComments` returns both, so a caller never constructs either.
 */
const skoolReplyToComment: Handler = async (input) => {
  const slug = String(input?.slug ?? "").trim();
  const commentId = String(input?.commentId ?? "").trim();
  const commentBody = String(input?.commentBody ?? "");
  const text = String(input?.text ?? "");
  if (!slug) throw new ZiteError({ code: "BAD_REQUEST", message: "Which post is the comment on?" });
  if (!commentId) throw new ZiteError({ code: "BAD_REQUEST", message: "Which comment? Pass its id from skoolReadComments." });
  if (!commentBody.trim()) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message:
        "The comment's own text is required — it is how the reply button is found on the page, which carries no " +
        "comment id. Pass the `body` from skoolReadComments.",
    });
  }
  if (!text.trim()) throw new ZiteError({ code: "BAD_REQUEST", message: "There is no reply to send." });
  return await replyToComment({
    communityUrl: communityUrlOrThrow(),
    slug,
    commentId,
    commentBody,
    text,
    dryRun: input?.dryRun === true,
  });
};

/**
 * The DM threads, and which of them are waiting on an answer.
 *
 * ⚠️ "WAITING" IS DECIDED BY WHO SPOKE LAST, NOT BY THE UNREAD COUNT. A thread
 * that has been opened reads as 0 unread while still being unanswered, and
 * `self.metadata.unreadChats` being 0 is what previously led to the conclusion
 * that this account had no DMs at all. It has several.
 */
const skoolReadDms: Handler = async (input) => {
  const read = await readChannels(communityUrlOrThrow());
  const maxAgeDays = input?.maxAgeDays === undefined ? undefined : Number(input.maxAgeDays);
  return {
    ...read,
    needingReply: needingReply(read.channels, { maxAgeDays }),
    // Reported alongside, so "nothing to answer" can be told apart from
    // "nothing arrived" — the filters are doing visible work, not hiding it.
    lastFromThemTotal: read.channels.filter((c) => c.lastFromThem).length,
  };
};

/** One conversation, oldest message first. */
const skoolReadDmThread: Handler = async (input) => {
  const channelId = String(input?.channelId ?? "").trim();
  if (!channelId) throw new ZiteError({ code: "BAD_REQUEST", message: "Which thread? Pass its channelId." });
  const read = await readChannels(communityUrlOrThrow());
  if (read.error) return { messages: [], error: read.error };
  const channel = read.channels.find((c) => c.id === channelId);
  if (!channel) return { messages: [], error: `No DM thread with id ${channelId} is on this account.` };
  return { channel, ...(await readMessages(communityUrlOrThrow(), channel)) };
};

/**
 * Send a DM. THE THIRD ENDPOINT HERE THAT WRITES, and the least recoverable.
 *
 * ⚠️ THERE IS NO SEND BUTTON IN SKOOL'S DM COMPOSER — ENTER SENDS. So there is
 * no disabled-state to check and no second click to withhold: the keystroke is
 * the publish. `dryRun` therefore stops one keypress short, with the message
 * sitting in the real composer.
 */
const skoolSendDm: Handler = async (input) => {
  const channelId = String(input?.channelId ?? "").trim();
  const text = String(input?.text ?? "");
  if (!channelId) throw new ZiteError({ code: "BAD_REQUEST", message: "Which thread? Pass its channelId." });
  // `clearDraft` empties the composer instead of writing to it, so it is the
  // one path that legitimately has no message.
  if (!text.trim() && input?.clearDraft !== true) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "There is no message to send." });
  }
  const communityUrl = communityUrlOrThrow();
  const read = await readChannels(communityUrl);
  if (read.error) throw new ZiteError({ code: "BAD_REQUEST", message: read.error });
  const channel: DmChannel | undefined = read.channels.find((c) => c.id === channelId);
  if (!channel) throw new ZiteError({ code: "BAD_REQUEST", message: `No DM thread with id ${channelId} is on this account.` });
  return await sendDm({
    communityUrl,
    channel,
    text,
    dryRun: input?.dryRun === true,
    clearDraft: input?.clearDraft === true,
  });
};

/* ─────────────────── the autonomous poster's schedule ─────────────────── */

/**
 * Everything an operator needs to answer "is this thing armed, and what is it
 * about to do?" in one call: the settings, where the clock actually is in the
 * schedule's own timezone, and the queue.
 *
 * The local time is returned rather than left to the caller to compute, because
 * the whole class of bug this feature invites is a timezone one — the box is
 * UTC, Jake is in Asia/Bangkok, and the schedule is America/New_York. Three
 * zones, none of them the same, and a settings page that showed only "9:00"
 * would be telling nobody anything.
 */
const skoolEngageStatus: Handler = async () => {
  const schedule = getSchedule();
  return {
    schedule,
    // ⚠️ WHICH DAY CARRIES THE WEEK'S ONE EMAIL, DERIVED THE SAME WAY THE
    // PUBLISHER DERIVES IT. `schedule.emailNotify` alone now reads as "every
    // post emails", which stopped being true on 2026-08-12 — Skool disables the
    // switch for days after a broadcast, so only one slot a week can carry one.
    emailDay: schedule.emailNotify ? emailDayFor(schedule.days) : null,
    now: localNow(schedule.timezone),
    slots: listSlots(30),
    // Is the loop still ticking? Armed and quiet looks identical to stopped
    // from every other field on this screen — the queue is empty either way.
    health: schedulerHealth(),
    // Which credential the drafter spends (`SKOOL_AI_AUTH`). The operator needs
    // it because a rate-limit refusal reads completely differently under each:
    // on the subscription it costs nothing and may last a day, on API credits
    // it costs money and clears in seconds.
    aiAuth: aiConfig.skoolEngageAuth,
    pinnedSubjects: listPinnedSubjects(),
    // Whether the composer flow was TAUGHT or is the built-in map.
    //
    // ⚠️ WITHOUT THIS, RECORDING ONE IS AN ACT OF FAITH. The two paths click
    // different things and fail differently, and nothing else on this screen
    // would tell an operator which one is about to run — least of all after
    // teaching an action and getting the name slightly wrong.
    postRecipe: taughtPostAction(),
  };
};

const skoolEngageConfigure: Handler = async (input) => {
  const patch: Record<string, unknown> = {};
  if (input?.enabled !== undefined) patch.enabled = !!input.enabled;
  if (input?.dryRun !== undefined) patch.dryRun = !!input.dryRun;
  if (input?.timezone !== undefined) patch.timezone = String(input.timezone);
  if (input?.hour !== undefined) patch.hour = Number(input.hour);
  if (input?.maxPostsPerWeek !== undefined) patch.maxPostsPerWeek = Number(input.maxPostsPerWeek);
  if (input?.maxAttempts !== undefined) patch.maxAttempts = Number(input.maxAttempts);
  if (input?.retryMinutes !== undefined) patch.retryMinutes = Number(input.retryMinutes);
  if (input?.maxSlotAgeHours !== undefined) patch.maxSlotAgeHours = Number(input.maxSlotAgeHours);
  if (Array.isArray(input?.days)) patch.days = (input.days as unknown[]).map((d) => String(d).toLowerCase() as Weekday);
  try {
    return { schedule: setSchedule(patch as any) };
  } catch (e) {
    throw new ZiteError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
  }
};

/* ────────────────────────── the reply agent ────────────────────────── */

/**
 * Everything /skool/agent needs to render the reply half: the two switches, the
 * caps, the heartbeat, the counts by state and the recent rows.
 *
 * ⚠️ THE COUNTS ARE BY STATE RATHER THAN A TOTAL, because `unconfirmed` and
 * `failed` are the two that need a human and a total hides both.
 */
const skoolRepliesStatus: Handler = async () => replyAgentStatus();

const skoolRepliesConfigure: Handler = async (input) => {
  const patch: Record<string, unknown> = {};
  if (input?.enabled !== undefined) patch.enabled = !!input.enabled;
  if (input?.dryRun !== undefined) patch.dryRun = !!input.dryRun;
  if (input?.comments !== undefined) patch.comments = !!input.comments;
  if (input?.dms !== undefined) patch.dms = !!input.dms;
  if (input?.everyMinutes !== undefined) patch.everyMinutes = Number(input.everyMinutes);
  if (input?.maxPerSweep !== undefined) patch.maxPerSweep = Number(input.maxPerSweep);
  if (input?.maxPerDay !== undefined) patch.maxPerDay = Number(input.maxPerDay);
  if (input?.maxAgeDays !== undefined) patch.maxAgeDays = Number(input.maxAgeDays);
  if (input?.postsToScan !== undefined) patch.postsToScan = Number(input.postsToScan);
  return { config: setReplyConfig(patch as any) };
};

/**
 * What is waiting, without answering any of it.
 *
 * ⚠️ THIS IS THE ONE TO REACH FOR BEFORE ARMING ANYTHING. It runs the real
 * filters over the real community and spends no model call, so "who would it
 * write to?" is answerable without it writing to them.
 */
const skoolRepliesQueue: Handler = async () => {
  const collected = await collectTargets(communityUrlOrThrow(), getReplyConfig());
  return {
    ...collected,
    // Drop the post body from the wire — it is context for the drafter, not for
    // a screen, and it makes this response ten times its useful size.
    targets: collected.targets.map(({ context, ...t }) => t),
  };
};

/** Run a sweep now, ignoring the cadence but NOT the kill switch or the caps. */
const skoolRepliesSweep: Handler = async () =>
  runReplySweep(communityUrlOrThrow(), { force: true, trigger: "on-demand" });

/**
 * Send one drafted reply on a human's say-so.
 *
 * ⚠️ THE GATE THAT MAKES DRY-RUN USEFUL RATHER THAN MERELY SAFE. Without it a
 * dry run produces drafts nobody can act on, and the only way to answer anyone
 * is to arm the whole agent.
 */
const skoolRepliesSend: Handler = async (input) => {
  const id = String(input?.id ?? "").trim();
  if (!id) throw new ZiteError({ code: "BAD_REQUEST", message: "Which reply? Pass its id from skoolRepliesStatus." });
  return sendDraftedReply(communityUrlOrThrow(), id);
};

/**
 * Forget one message so it can be offered again.
 *
 * ⚠️ THE ONLY WAY OUT OF "ENGAGED WITH, IN ANY STATE". That rule is deliberately
 * strict enough to strand a message a crash interrupted, and this is the human
 * act that releases it. It does NOT unsend anything.
 */
const skoolRepliesForget: Handler = async (input) => {
  const id = String(input?.id ?? "").trim();
  if (!id) throw new ZiteError({ code: "BAD_REQUEST", message: "Which reply? Pass its id." });
  const forgotten = forgetReply(id);
  return { forgotten, replies: listReplies(25) };
};

/**
 * Subjects the operator wants posted, ahead of anything the agent would pick.
 *
 * ⚠️ THE SCHEDULER CANNOT BE ASKED FOR A SPECIFIC POST ANY OTHER WAY. It selects
 * from the lesson index, so a subject that is not a lesson — "the classroom was
 * rebuilt and now has learner journeys" — is unreachable by it. Pins are taken
 * oldest-first on the next posting day.
 */
const skoolEngagePin: Handler = async (input) => {
  const subject = String(input?.subject ?? "");
  try {
    return { pinned: pinSubject(subject), queue: listPinnedSubjects() };
  } catch (e) {
    throw new ZiteError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
  }
};

const skoolEngageUnpin: Handler = async (input) => {
  const id = String(input?.id ?? "").trim();
  if (!id) throw new ZiteError({ code: "BAD_REQUEST", message: "Which pinned subject? Pass its id." });
  return { removed: unpinSubject(id), queue: listPinnedSubjects() };
};

/** Run one scheduler cycle now, without waiting for the interval. */
const skoolEngageTick: Handler = async () => {
  const { started, result, detail } = await tickNow(communityUrlOrThrow());
  if (!started) return { started, result: null, detail: detail ?? "A cycle is already running." };
  return { started, result };
};

/**
 * Publish a slot that has been drafted and read. THIS WRITES TO THE COMMUNITY.
 *
 * Separate from the tick on purpose: with dry run on (the default) this is the
 * only way a post goes out, so the first thing this agent ever publishes is
 * something a human chose to publish.
 */
const skoolEngagePublish: Handler = async (input) => {
  const slotKey = String(input?.slotKey ?? "").trim();
  if (!slotKey) throw new ZiteError({ code: "BAD_REQUEST", message: "Which slot?" });
  return await publishSlot(communityUrlOrThrow(), slotKey);
};

/** What the scheduler would write about next — without spending the window on a draft. */
const skoolEngageSubject: Handler = async () => {
  return await chooseSubject(communityUrlOrThrow());
};

const skoolRunAction: Handler = async (input) => {
  const action = String(input?.action ?? "");
  const p = input?.params ?? {};
  // `pages` is optional because one action — pagesInOpenCourse — is a READ, and
  // its whole value is the structured list rather than the ok/detail line every
  // write returns. Carried through rather than flattened into `detail`: someone
  // inspecting an unexpected page order wants the array, not a sentence.
  const run = async (): Promise<{
    ok: boolean;
    detail: string;
    pages?: skoolActions.OpenCoursePage[] | null;
  }> => {
    switch (action) {
      case "openMenuFor":
        return skoolActions.openMenuFor(String(p.title ?? ""));
      case "chooseMenuItem":
        return skoolActions.chooseMenuItem(String(p.label ?? ""));
      case "fillField":
        return skoolActions.fillField(String(p.placeholder ?? ""), String(p.text ?? ""));
      case "clickButton":
        return skoolActions.clickButton(String(p.label ?? ""));
      case "editCourseSettings":
        return skoolActions.editCourseSettings(String(p.title ?? ""), {
          name: p.name ? String(p.name) : undefined,
          description: p.description ? String(p.description) : undefined,
        });
      case "addFolder":
        return skoolActions.addFolder(String(p.name ?? ""));
      case "addPage":
        return skoolActions.addPageToOpenCourse({
          title: String(p.title ?? ""),
          videoUrl: p.videoUrl ? String(p.videoUrl) : undefined,
          body: p.body ? String(p.body) : undefined,
        });
      case "openClassroom":
        return skoolActions.openClassroom(communityUrlOrThrow(), Number(p.gridPage ?? 1));
      case "openCourse":
        return skoolActions.openCourse(communityUrlOrThrow(), String(p.slug ?? ""));
      // Reads the open course's pages and reports them — no writing. What the
      // write path believes it is looking at, which is the thing worth being
      // able to see directly when a page lands somewhere unexpected.
      case "pagesInOpenCourse": {
        const pages = await skoolActions.pagesInOpenCourse();
        return pages
          ? { ok: true, detail: `${pages.length} page(s): ${pages.map((p) => `${p.title}${p.empty ? " (empty)" : ""}`).join(" · ")}`, pages }
          : { ok: false, detail: "The open course's contents could not be read.", pages: null };
      }
      // Replace an existing page's body — the re-runnable write. Reads the page
      // back from Skool before reporting success.
      case "rewritePage":
        return skoolActions.rewritePage({
          title: String(p.title ?? ""),
          videoUrl: p.videoUrl ? String(p.videoUrl) : null,
          body: String(p.body ?? ""),
        });
      case "openPageByTitle":
        return skoolActions.openPageByTitle(String(p.title ?? ""));
      case "openMenuOffering":
        return skoolActions.openMenuOffering(String(p.label ?? ""));
      case "openPageEditor":
        return skoolActions.openPageEditor();
      case "attachVideo":
        return skoolActions.attachVideo(String(p.videoUrl ?? ""));
      case "fillPageTitle":
        return skoolActions.fillPageTitle(String(p.title ?? ""));
      case "fillBody":
        return skoolActions.fillBody(String(p.body ?? ""));
      case "createCourse":
        return skoolActions.createCourse(communityUrlOrThrow(), String(p.name ?? ""), String(p.description ?? ""));
      case "courseExists":
        return skoolActions.courseExists(communityUrlOrThrow(), String(p.name ?? ""));
      case "deleteCourse":
        return skoolActions.deleteCourse(communityUrlOrThrow(), String(p.title ?? ""));
      case "editPageContent":
        return skoolActions.editPageContent({
          title: p.title ? String(p.title) : undefined,
          body: p.body ? String(p.body) : undefined,
        });
      case "deleteThing":
        return skoolActions.deleteThing(String(p.name ?? ""), p.kind === "folder" ? "folder" : "page");
      // Publishing a post through the SAME door the classroom was built with
      // (Jake, 2026-08-06: "the same way you've added courses you'll add a
      // post"), rather than opening a second one. `skoolPublishPost` takes the
      // same arguments but sits behind the sign-in gate, and widening the
      // loopback allowlist to reach it would go the wrong way — the allowlist's
      // own note says its write entries come OFF once a UI exists, and one now
      // does.
      //
      // This is the `createCourse` bargain exactly: a composed, guarded write
      // to the live community, invoked one at a time and looked at. The guards
      // live in `createPost` and are the point of routing through it instead of
      // driving fillField/clickButton by hand — it refuses a duplicate title,
      // refuses a composer holding someone's unsent draft, and confirms by
      // re-reading the feed rather than trusting that the clicks worked.
      //
      // ⚠️ `post` is dropped on purpose: `run()`'s return type has no room for
      // it, and `createPost` already writes the read-back — slug and landed
      // character count — into `detail`, which is the part a human checks.
      case "createPost": {
        const out = await createPost({
          communityUrl: communityUrlOrThrow(),
          title: String(p.title ?? ""),
          body: String(p.body ?? ""),
          category: p.category ? String(p.category) : null,
        });
        return { ok: out.ok, detail: out.detail };
      }
      default:
        return { ok: false, detail: `Unknown action "${action}".` };
    }
  };
  const result = await run();
  return { ...result, frame: await skoolConsole.frame() };
};

/* ── The rebuild ───────────────────────────────────────────────────────────
   The plan says what the classroom should become; these turn that into the
   individual writes and run them ONE AT A TIME. Deliberately not a single
   "rebuild" button: the first writes into a live community with 60 courses in
   it should each be invoked and each be looked at.                          */

/**
 * The operation list, WITHOUT touching Skool's editor.
 *
 * Reads the live classroom only to see which courses already exist, so that
 * running this twice does not propose creating everything twice.
 */
const skoolPlanRebuild: Handler = async (input) => {
  const id = Number(input?.planId ?? 0);
  const plan = id > 0 ? getSkoolPlan(id) : latestSkoolPlan();
  if (!plan?.data?.tracks?.length) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Build a plan first — there is nothing to rebuild from." });
  }
  const snapshot = getInventory(plan.inventoryId);
  if (!snapshot?.data?.courses?.length) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: "The inventory this plan was built from is missing, so nothing can be checked before deleting it.",
    });
  }
  const live = await readClassroom(communityUrlOrThrow());
  if (live.error) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: `The classroom could not be read, so the rebuild cannot tell what already exists: ${live.error}`,
    });
  }
  const rebuild = buildRebuild(
    plan.data,
    snapshot.data,
    live.courses.map((c: any) => c.title),
  );
  const unwritten = plan.data.tracks.reduce(
    (n: number, t: any) => n + (t.modules ?? []).filter((m: any) => !m.lesson?.body).length,
    0,
  );
  return { rebuild, planId: plan.id, pagesNotYetWritten: unwritten };
};

/**
 * Run ONE operation from the rebuild.
 *
 * ⚠️ EVERY OPERATION CHECKS THE LIVE CLASSROOM FIRST, and that is what makes a
 * half-finished run safe to resume. The truth about what exists is in Skool,
 * not in a status column here: a page that was written just before the process
 * died is written, whatever any table says. So a create whose course exists is
 * a no-op, and a page whose title is already in the course is a no-op — rather
 * than a second copy of it appearing next to the first.
 */
const skoolRunRebuildOp: Handler = async (input) => {
  const opId = String(input?.opId ?? "");
  const planned = (await skoolPlanRebuild(input, {} as any)) as any;
  const op = planned.rebuild.ops.find((o: any) => o.id === opId);
  if (!op) {
    throw new ZiteError({
      code: "BAD_REQUEST",
      message: `No operation called "${opId}" — it may already be done, since the list is derived from what is live.`,
    });
  }
  const community = communityUrlOrThrow();

  const run = async (): Promise<{ ok: boolean; detail: string }> => {
    if (op.kind === "createCourse") {
      return skoolActions.createCourse(community, op.trackTitle, op.description);
    }
    if (op.kind === "addPage") {
      const slug = await skoolActions.findCourseSlug(community, op.trackTitle);
      if (!slug) return { ok: false, detail: `The course "${op.trackTitle}" is not in the classroom yet.` };
      const opened = await skoolActions.openCourse(community, slug);
      if (!opened.ok) return opened;
      // Already-present and unreadable are both decided inside the action, so
      // that a re-run is a no-op by the same rule wherever it is invoked from.
      return skoolActions.addPageToOpenCourse({ title: op.title, videoUrl: op.videoUrl, body: op.body });
    }
    // ⚠️ THE DELETE. It is only ever reached for a course the operation list
    // decided was fully absorbed, and buildRebuild only decides that when
    // every lesson of it that carried content is placed in the new spine.
    return skoolActions.deleteCourse(community, op.title);
  };

  const result = await run();
  return { ...result, op };
};

/** Empty the focused field, refusing when focus is not in one. */
const skoolConsoleClearField: Handler = async () => {
  const result = await skoolConsole.clearFocusedField();
  return { ...result, frame: await skoolConsole.frame() };
};

/** Describe what sits at a point without touching it — the teach preview. */
const skoolDescribePoint: Handler = async (input) => ({
  descriptor: await skoolConsole.describePoint(Number(input?.x ?? 0), Number(input?.y ?? 0)),
});

const skoolSaveRecipe: Handler = async (input) => {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new ZiteError({ code: "BAD_REQUEST", message: "A recipe needs a name." });
  const steps = Array.isArray(input?.steps) ? (input.steps as RecipeStep[]) : [];
  if (steps.length === 0) throw new ZiteError({ code: "BAD_REQUEST", message: "A recipe needs at least one step." });
  return { recipe: saveRecipe(name, String(input?.description ?? ""), steps) };
};

const skoolListRecipes: Handler = async () => ({ recipes: listRecipes() });

const skoolGetRecipe: Handler = async (input) => ({ recipe: getRecipe(String(input?.name ?? "")) });

const skoolDeleteRecipe: Handler = async (input) => {
  deleteRecipe(String(input?.name ?? ""));
  return { deleted: true };
};

/**
 * DEVELOPMENT probe of Skool's editing DOM — see skool/probe.ts. Reading needs
 * no selectors; writing does, and they have to be learned from the real DOM.
 * Remove once the write path's selectors are settled.
 */
/**
 * Read — and optionally set — the composer's "Send email to all members" switch.
 *
 * ⚠️ THIS EXISTS TO PROVE IDEMPOTENCE, WHICH IS THE ONLY PROPERTY THAT MATTERS
 * HERE AND THE ONE A PUBLISH CANNOT DEMONSTRATE. Verifying the switch through a
 * real post would mean emailing 65 people per attempt; this reads it, sets it,
 * and reads it again with the composer open and nothing submitted. Remove it
 * with the probe.
 */
const skoolEmailNotify: Handler = async (input) => {
  if (input?.set === undefined) return { state: await readEmailNotify() };
  return { result: await setEmailNotify(input.set === true) };
};

/**
 * Put a video or poll into the OPEN composer, without submitting anything.
 *
 * ⚠️ SAME REASON AS `skoolEmailNotify`: the alternative way to find out whether
 * an attachment goes in is to publish a post, which emails the community. This
 * drives the two composer flows against the real modal and stops there. Remove
 * it with the probe.
 */
const skoolAttach: Handler = async (input) => {
  const kind = String(input?.kind ?? "");
  if (kind === "video") {
    const videoId = String(input?.videoId ?? "").trim();
    if (!(await isChannelVideo(videoId))) {
      throw new ZiteError({ code: "BAD_REQUEST", message: `${videoId} is not one of the channel's uploads.` });
    }
    return { result: await attachToComposer({ kind: "video", videoId, title: "", url: youtubeUrl(videoId) }) };
  }
  if (kind === "poll") {
    const options = (Array.isArray(input?.options) ? input.options : []).map(String);
    return { result: await attachToComposer({ kind: "poll", options }) };
  }
  if (kind === "gif") {
    return { result: await attachToComposer({ kind: "gif", query: String(input?.query ?? "") }) };
  }
  throw new ZiteError({ code: "BAD_REQUEST", message: 'kind must be "video", "gif" or "poll".' });
};

/**
 * Write a classroom page for a new upload, from its transcript.
 *
 * ⚠️ WRITES TO THE LIVE CLASSROOM unless `dryRun`. The page is placed in a
 * course the model chose from the courses that exist, and confirmed from
 * Skool's reloaded payload — not from the SAVE click landing.
 */
const skoolWriteVideoLesson: Handler = async (input) => {
  const communityUrl = communityUrlOrThrow();
  return {
    result: await writeLessonForNewVideo(communityUrl, {
      dryRun: input?.dryRun === true,
      videoId: input?.videoId ? String(input.videoId) : undefined,
    }),
  };
};

/** What would get a page next, and what already has one. Free, and writes nothing. */
const skoolVideoLessonStatus: Handler = async () => {
  const next = await nextVideoNeedingLesson(communityUrlOrThrow()).catch(() => null);
  return { next, written: listVideoLessons(50) };
};

/**
 * Run the real publish flow with Skool's writes blocked, and report the network.
 *
 * ⚠️ THE ONE QUESTION THE DOM CANNOT ANSWER: does the composer actually submit?
 * "Every click worked and the post is not there" has now been said by two
 * unrelated bugs, and neither was visible from inside the page. This drives the
 * genuine `createPost` — same recipe, same guards, same attachment and switch —
 * with every non-GET to `api2.skool.com` aborted, so the flow can be watched
 * without a single post or email reaching the community.
 *
 * The `post` result is EXPECTED to be a failure: the write it needs was blocked
 * on purpose. Read `requests` and `blocked` first — a run that blocked nothing
 * is a composer that never tried.
 */
const skoolDryPublish: Handler = async (input) => {
  const title = String(input?.title ?? "").trim();
  const body = String(input?.body ?? "").trim();
  if (!title || body.length < 50) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "A dry publish needs the same title and body a real one would take." });
  }
  const videoId = input?.videoId ? String(input.videoId) : "";
  // ⚠️ `allowWrites` TURNS THIS INTO A REAL PUBLISH. Spelled out at the call
  // site rather than passed through, so the one input that changes what this
  // endpoint IS cannot be set by forwarding an options object by accident.
  const allowWrites = input?.allowWrites === true;
  return {
    allowWrites,
    result: await dryPublish(
      {
        communityUrl: communityUrlOrThrow(),
        title,
        body,
        category: input?.category ? String(input.category) : null,
        emailNotify: input?.emailNotify === true,
        attachment: videoId ? { kind: "video", videoId, title: "", url: youtubeUrl(videoId) } : null,
      },
      { allowWrites },
    ),
  };
};

const skoolProbe: Handler = async (input) => {
  const url = String(input?.url ?? "").trim();
  if (!/^https:\/\/(www\.)?skool\.com\//.test(url)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Probe URLs must be on skool.com." });
  }
  return {
    probe: await probeSkool({
      url,
      // `probeSkool` has always supported these three; the handler simply never
      // forwarded them, which made the whole icon half of Skool unreachable.
      // The chat surface opens from a header button with NO TEXT AT ALL
      // (`aria-label="Open chats"`), so clicking by visible text cannot get
      // there — the same lesson as "find controls by cursor, not by tag",
      // one layer up.
      hoverText: input?.hoverText ? String(input.hoverText) : undefined,
      clickText: input?.clickText ? String(input.clickText) : undefined,
      clickSelector: input?.clickSelector ? String(input.clickSelector) : undefined,
      clickIndex: input?.clickIndex === undefined ? undefined : Number(input.clickIndex),
      waitMs: Number(input?.waitMs ?? 2500),
      dumpHtml: input?.dumpHtml === true,
      // Third option, same rule as the two warnings below: forwarded in the
      // commit that added it. Without this line a caller asking for 250,000
      // characters silently receives 40,000 and cannot tell.
      htmlLimit: input?.htmlLimit === undefined ? undefined : Number(input.htmlLimit),
      elementLimit: input?.elementLimit === undefined ? undefined : Number(input.elementLimit),
      payloadPath: input?.payloadPath ? String(input.payloadPath) : undefined,
      // ⚠️ AND IT HAPPENED AGAIN, ONE OPTION LATER. `captureRequests` was added
      // to `probeSkool`, called with `captureRequests: true`, and silently
      // dropped here — so the probe reported "0 requests" for opening the chat
      // panel. That reads as a finding about Skool ("opening chats fetches
      // nothing") and it was a finding about this function. It cost three
      // rebuild cycles and was only caught by a CONTROL RUN against a post page
      // that is known to make the call, which also reported zero.
      //
      // The lesson is now twice-learned: an option this handler does not
      // forward does not fail, it returns a confident wrong answer. Anything
      // added to `probeSkool` gets a line here in the same commit.
      captureRequests: input?.captureRequests === true,
      apiGet: input?.apiGet ? String(input.apiGet) : undefined,
      thenClickText: input?.thenClickText ? String(input.thenClickText) : undefined,
      thenClickSelector: input?.thenClickSelector ? String(input.thenClickSelector) : undefined,
      thenWaitMs: input?.thenWaitMs === undefined ? undefined : Number(input.thenWaitMs),
    }),
  };
};

const skoolSaveSettings: Handler = async (input) => {
  const patch: {
    communityUrl?: string;
    roadmapMd?: string;
    channelUrl?: string;
    requiredTracks?: { title: string; note: string }[];
  } = {};
  if (input?.communityUrl !== undefined) patch.communityUrl = String(input.communityUrl).trim();
  if (input?.roadmapMd !== undefined) patch.roadmapMd = String(input.roadmapMd);
  if (input?.channelUrl !== undefined) patch.channelUrl = String(input.channelUrl).trim();
  if (Array.isArray(input?.requiredTracks)) {
    patch.requiredTracks = input.requiredTracks
      .map((t: any) => ({ title: String(t?.title ?? "").trim(), note: String(t?.note ?? "").trim() }))
      .filter((t: any) => t.title);
  }
  return { settings: saveSkoolSettings(patch) };
};

// ── Avatar Narrator (LAB tool — synthetic-presenter talking-head videos) ─────
// The tool's whole value proposition is that it is NOT a text-to-video model:
// a locked portrait plus TTS driven through an audio-driven lipsync model runs
// at ~$3.60 per finished minute instead of the ~$28 a Seedance-class model
// costs, speaks the script verbatim, and keeps one voice and one face across
// every video. See avatar/types.ts for the cost model behind the estimates.

/** Configuration + library snapshot the page loads on mount. */
const avatarStatus: Handler = async () => ({
  providers: listAvatarProviders(),
  // Built from the registry rather than listed by hand: a hardcoded pair is how
  // `segmind` came to be missing here, which left the UI showing its own
  // default voice as unavailable and the tool as "not ready" with a working key.
  ttsConfigured: Object.fromEntries(
    TTS_PROVIDER_IDS.map((id) => [id, ttsConfigured(id)]),
  ) as Record<TtsProviderId, boolean>,
  geminiVoices: GEMINI_VOICES,
  // Without a public origin the provider cannot fetch the portrait or the
  // narration, so surface it as a first-class readiness flag rather than
  // letting the first render fail with a confusing provider-side error.
  publicBaseUrlConfigured: !!config.publicBaseUrl,
  defaultScenePrompt: DEFAULT_SCENE_PROMPT,
  auditionText: VOICE_AUDITION_TEXT,
  voiceSettings: VOICE_SETTINGS,
  voiceModels: ELEVENLABS_MODELS,
  // The look layer: how the footage is captured, and two complete starting
  // characters. Naming a medium is the biggest realism lever the tool has, so
  // the UI offers it rather than leaving the model to guess.
  mediums: CAPTURE_MEDIUMS.map((m) => ({ id: m.id, label: m.label, hint: m.hint })),
  framings: FRAMINGS.map((f) => ({ id: f.id, label: f.label, hint: f.hint })),
  // The fixed sets. `ready` is false when the plate file is missing, which is
  // the difference between "pick this room" and "this room needs making".
  rooms: availableRooms().map((r) => ({ id: r.id, label: r.label, hint: r.hint, ready: r.ready })),
  presets: LOOK_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    hint: p.hint,
    mediumId: p.mediumId,
    voice: p.voice,
    description: describeCharacter(p.character),
  })),
  personas: avatarStore.listPersonas(),
  totalSpendUsd: avatarStore.totalSpendUsd(),
});

/** Pre-flight cost + duration estimate. Pure arithmetic — spends nothing. */
const avatarEstimate: Handler = async (input) => {
  const script = String(input?.script ?? "");
  return estimateAvatarCost({
    script,
    provider: coerceAvatarProvider(input?.provider),
    resolution: coerceAvatarResolution(input?.resolution),
    tts: coerceTtsProvider(input?.tts),
    segmentSeconds: Number.isFinite(Number(input?.segmentSeconds)) ? Number(input.segmentSeconds) : 0,
  });
};

/**
 * Generate a candidate portrait WITHOUT saving a persona. The portrait is the
 * one input that decides whether the finished video reads as a real person, so
 * the flow is deliberately "roll until you like it, then lock it in" rather
 * than committing the first result.
 */
const avatarPreviewPortrait: Handler = async (input) => {
  // A preset supplies both the character and the medium it was designed for, so
  // "use the explainer" is one click rather than a paragraph of typing. Anything
  // the caller states explicitly still wins over the preset.
  const preset = findPreset(input?.presetId ? String(input.presetId) : undefined);
  const description = String(input?.description ?? "").trim() || (preset ? describeCharacter(preset.character) : "");
  if (!description) throw new ZiteError({ code: "BAD_REQUEST", message: "Describe the presenter first." });
  const portrait = await generatePortrait({
    description,
    aspect: coercePortraitAspect(input?.aspect),
    model: input?.model === "flash" || input?.model === "flash-31" ? input.model : "pro",
    mediumId: String(input?.mediumId ?? preset?.mediumId ?? ""),
    framingId: String(input?.framingId ?? ""),
    // A room plate overrides the medium/framing entirely and forces Nano
    // Banana, because the plate has to ride along as an inline reference.
    roomId: String(input?.roomId ?? ""),
    engine: input?.engine === "nanobanana" ? "nanobanana" : "gptimage2",
    // Cheap rolls while hunting a face, full quality for the one that is kept.
    quality: input?.quality === "low" || input?.quality === "medium" ? input.quality : "high",
  });
  return {
    file: path.basename(portrait.file),
    url: `/api/avatar/${encodeURIComponent(path.basename(portrait.file))}`,
    mime: portrait.mime,
    prompt: portrait.prompt,
  };
};

/**
 * Produce a candidate VOICE sample — the audio equivalent of rolling a
 * portrait. Saved to the avatar library so it can be listened to, re-rolled,
 * and then cloned; the file that gets cloned is the one that gets archived on
 * the persona.
 */
const avatarPreviewVoice: Handler = async (input) => {
  // Default to the full audition paragraph, not a one-liner: a voice you will
  // listen to for forty minutes cannot be judged on eight words.
  const text = String(input?.text ?? "").trim() || VOICE_AUDITION_TEXT;
  const provider = coerceTtsProvider(input?.ttsProvider);
  const voice = String(input?.voice ?? "").trim() || defaultVoice(provider);

  fs.mkdirSync(config.avatarDir, { recursive: true });
  const file = path.join(config.avatarDir, `voice-${crypto.randomBytes(8).toString("hex")}.mp3`);
  const settings = resolveVoiceSettings(input?.settings as any);
  const result = await synthesizeNarration({ script: text, provider, voice, outFile: file, settings });
  writeVoiceSidecar(file, { voice, provider, text, seconds: result.seconds, settings, description: `Preset voice: ${voice}` });

  return {
    file: path.basename(file),
    url: `/api/avatar/${encodeURIComponent(path.basename(file))}`,
    seconds: result.seconds,
    costUsd: result.costUsd,
    text,
  };
};

/**
 * Design a voice that has never existed, from a description.
 *
 * This is what "a voice nobody else is using" actually requires — cloning only
 * ever copies something that already exists. The designed clip is archived like
 * any other sample, so it can then be cloned into a persistent voice id while
 * the audio stays ours.
 */
const avatarDesignVoice: Handler = async (input) => {
  const description = String(input?.description ?? "").trim();
  if (!description) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "Describe the voice you want — age, gender, accent, pace, texture." });
  }
  fs.mkdirSync(config.avatarDir, { recursive: true });
  const file = path.join(config.avatarDir, `voice-${crypto.randomBytes(8).toString("hex")}.mp3`);
  const res = await designVoice({ description, text: String(input?.text ?? "") || undefined, outFile: file });
  // The voice id appears exactly once, here. Persist it beside the audio or a
  // refresh loses the voice, not just the clip.
  writeVoiceSidecar(file, { voiceId: res.voiceId, description, provider: "segmind", seconds: res.seconds });
  return {
    file: path.basename(file),
    url: `/api/avatar/${encodeURIComponent(path.basename(file))}`,
    seconds: res.seconds,
    voiceId: res.voiceId,
  };
};

/**
 * Clone a voice from a sample and hand back the id to put on a persona.
 *
 * The sample is either one this tool generated (`file`) or one the operator
 * uploaded (`sampleBase64`) — a recording of their own voice, say. Both land in
 * the avatar library first, because the ARCHIVED CLIP is the durable asset: the
 * cloned model itself lives inside ElevenLabs and cannot be exported, so losing
 * the sample means the voice is only ever rentable from one vendor.
 */
const avatarCloneVoice: Handler = async (input) => {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new ZiteError({ code: "BAD_REQUEST", message: "Name the voice so you can find it later." });

  let sampleFile: string;
  if (input?.sampleBase64) {
    const raw = String(input.sampleBase64).replace(/^data:[^;]+;base64,/, "");
    const bytes = Buffer.from(raw, "base64");
    if (!bytes.length) throw new ZiteError({ code: "BAD_REQUEST", message: "That audio file is empty." });
    fs.mkdirSync(config.avatarDir, { recursive: true });
    const ext = String(input?.sampleMime ?? "").includes("wav") ? "wav" : "mp3";
    sampleFile = path.join(config.avatarDir, `voice-${crypto.randomBytes(8).toString("hex")}.${ext}`);
    fs.writeFileSync(sampleFile, bytes);
  } else {
    // A basename inside avatarDir, never a path — same rule as the portrait.
    const base = path.basename(String(input?.file ?? ""));
    sampleFile = path.join(config.avatarDir, base);
    if (!base || !fs.existsSync(sampleFile)) {
      throw new ZiteError({ code: "BAD_REQUEST", message: "That voice sample is no longer available — generate a new one." });
    }
  }

  const { voiceId } = await cloneVoice({ sampleFile, name, description: String(input?.description ?? "") || undefined });
  return {
    voiceId,
    sampleFile: path.basename(sampleFile),
    sampleUrl: `/api/avatar/${encodeURIComponent(path.basename(sampleFile))}`,
  };
};

/**
 * A voice sample's sidecar: what it is, and — critically — the voice id it
 * belongs to.
 *
 * The audio alone is not enough. A DESIGNED voice exists on the account under
 * an id that appears exactly once, in the response that created it; lose that
 * and the clip is just a recording of a voice you can no longer speak with.
 * The sidecar is what makes a past design still usable after a refresh.
 */
function writeVoiceSidecar(file: string, meta: Record<string, unknown>): void {
  try {
    fs.writeFileSync(`${file}.json`, JSON.stringify({ ...meta, createdAt: Date.now() }, null, 2));
  } catch {
    /* the sample is still usable without it — never fail a paid call over this */
  }
}

function readVoiceSidecar(file: string): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(`${file}.json`, "utf8"));
  } catch {
    return {};
  }
}

/** Every voice sample generated or designed so far, newest first. */
const avatarListVoiceSamples: Handler = async (input) => {
  const limit = Number.isFinite(Number(input?.limit)) ? Math.max(1, Number(input.limit)) : 40;
  if (!fs.existsSync(config.avatarDir)) return { samples: [] };

  const locked = new Set(
    avatarStore.listPersonas().map((p) => path.basename(p.voiceSampleFile || "")).filter(Boolean),
  );

  const samples = fs
    .readdirSync(config.avatarDir)
    .filter((f) => /^voice-[a-f0-9]+\.(mp3|wav)$/i.test(f))
    .map((f) => {
      const full = path.join(config.avatarDir, f);
      const stat = fs.statSync(full);
      const meta = readVoiceSidecar(full);
      return {
        file: f,
        url: `/api/avatar/${encodeURIComponent(f)}`,
        createdAt: meta.createdAt ?? stat.mtimeMs,
        bytes: stat.size,
        inUse: locked.has(f),
        // Length is what you actually compare voices on; bytes is noise.
        seconds: Number(meta.seconds ?? 0),
        voiceId: meta.voiceId ?? null,
        label: String(meta.description ?? meta.voice ?? "Voice sample"),
        kind: meta.voiceId ? "designed" : "sample",
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  return { samples };
};

const avatarDeleteVoiceSample: Handler = async (input) => {
  const base = path.basename(String(input?.file ?? ""));
  if (!/^voice-[a-f0-9]+\.(mp3|wav)$/i.test(base)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That is not a voice sample." });
  }
  if (avatarStore.listPersonas().some((p) => path.basename(p.voiceSampleFile || "") === base)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That sample belongs to a persona — delete the persona instead." });
  }
  fs.rmSync(path.join(config.avatarDir, base), { force: true });
  fs.rmSync(path.join(config.avatarDir, `${base}.json`), { force: true });
  return { deleted: true };
};

/**
 * Every portrait rolled so far, newest first.
 *
 * A roll costs real money and ninety seconds, and until now it existed only in
 * React state — a refresh threw away a face the operator had paid for and might
 * have wanted. The files were on disk the whole time; nothing was listing them.
 *
 * `inUse` marks the ones already locked into a persona so they are not offered
 * as if they were spare candidates.
 */
const avatarListPortraits: Handler = async (input) => {
  const limit = Number.isFinite(Number(input?.limit)) ? Math.max(1, Number(input.limit)) : 40;
  if (!fs.existsSync(config.avatarDir)) return { portraits: [] };

  const locked = new Set(avatarStore.listPersonas().map((p) => path.basename(p.portraitFile)));

  const portraits = fs
    .readdirSync(config.avatarDir)
    .filter((f) => /^persona-[a-f0-9]+\.(png|jpg|jpeg|webp)$/i.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(config.avatarDir, f));
      return {
        file: f,
        url: `/api/avatar/${encodeURIComponent(f)}`,
        createdAt: stat.mtimeMs,
        bytes: stat.size,
        inUse: locked.has(f),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  return { portraits };
};

/** Throw away a roll that is not locked into a persona. */
const avatarDeletePortrait: Handler = async (input) => {
  const base = path.basename(String(input?.file ?? ""));
  if (!/^persona-[a-f0-9]+\.(png|jpg|jpeg|webp)$/i.test(base)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That is not a portrait roll." });
  }
  // Refuse to delete a face a persona is still built on — the persona would be
  // left pointing at nothing and every future render would fail.
  if (avatarStore.listPersonas().some((p) => path.basename(p.portraitFile) === base)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That portrait belongs to a persona — delete the persona instead." });
  }
  fs.rmSync(path.join(config.avatarDir, base), { force: true });
  return { deleted: true };
};

/**
 * Improve a portrait you already like, instead of rolling the dice again.
 *
 * The operator says what they want changed in plain words; `buildEditPrompt`
 * turns that into an instruction that changes only that and defends the
 * identity of the face. The result is saved as a NEW roll, so the original
 * survives in the gallery and a bad edit costs one call, not a persona.
 */
const avatarEditPortrait: Handler = async (input) => {
  const instruction = String(input?.instruction ?? "").trim();
  if (!instruction) throw new ZiteError({ code: "BAD_REQUEST", message: "Say what you want changed." });

  const base = path.basename(String(input?.file ?? ""));
  const sourceFile = path.join(config.avatarDir, base);
  if (!base || !fs.existsSync(sourceFile)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That portrait is no longer available — pick another roll." });
  }

  const portrait = await editPortrait({
    sourceFile,
    instruction,
    aspect: coercePortraitAspect(input?.aspect),
    mediumId: String(input?.mediumId ?? ""),
    quality: input?.quality === "low" || input?.quality === "medium" ? input.quality : "high",
  });
  return {
    file: path.basename(portrait.file),
    url: `/api/avatar/${encodeURIComponent(path.basename(portrait.file))}`,
    mime: portrait.mime,
    prompt: portrait.prompt,
  };
};


// ── Persona → character sheet → any room ─────────────────────────────────────
// The point of the pair: a persona is ONE photograph, so putting them in a new
// room means inventing every angle the photograph does not show — and inventing
// is where a face drifts into someone else. The sheet turns "imagine this person
// from another angle" into "copy the one you were shown".

/** Build (or rebuild) the twenty-view sheet for a saved persona. */
const avatarCharacterSheet: Handler = async (input) => {
  const personaId = String(input?.personaId ?? "").trim();
  const persona = personaId ? avatarStore.getPersona(personaId) : null;
  if (!persona) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick a persona first." });
  try {
    const sheet = await generateCharacterSheet({ sourceFile: persona.portraitFile });
    // Replace rather than accumulate: one persona has one current sheet, and
    // the old file is dead weight the moment a new one exists.
    if (persona.sheetFile && persona.sheetFile !== sheet.file) {
      try { fs.rmSync(persona.sheetFile, { force: true }); } catch { /* already gone */ }
    }
    avatarStore.setPersonaSheet(persona.id, sheet.file);
    return { persona: avatarStore.getPersona(persona.id), sheetUrl: `/api/avatar/${encodeURIComponent(path.basename(sheet.file))}` };
  } catch (e) {
    throw new ZiteError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
  }
};

/**
 * Put a saved persona into a room — returns a PREVIEW, not a persona.
 *
 * Deliberately the same shape avatarPreviewPortrait returns, so a placement
 * drops into the existing roll-until-you-like-it flow and can be locked in as a
 * new persona. The alternative — mutating the persona's portrait in place —
 * would mean changing room destroys the version that worked.
 */
const avatarPlaceInRoom: Handler = async (input) => {
  const personaId = String(input?.personaId ?? "").trim();
  const roomId = String(input?.roomId ?? "").trim();
  const persona = personaId ? avatarStore.getPersona(personaId) : null;
  if (!persona) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick a persona first." });
  if (!roomId) throw new ZiteError({ code: "BAD_REQUEST", message: "Pick a room to put them in." });
  try {
    const placed = await placeInRoom({
      sheetFile: persona.sheetFile || null,
      portraitFile: persona.portraitFile,
      roomId,
    });
    return {
      file: path.basename(placed.file),
      url: `/api/avatar/${encodeURIComponent(path.basename(placed.file))}`,
      mime: placed.mime,
      prompt: placed.prompt,
      // Surfaced so the UI can say "made from the sheet" vs "made from the one
      // portrait" — the difference decides how much the face is likely to drift.
      usedSheet: placed.usedSheet,
      roomId,
    };
  } catch (e) {
    throw new ZiteError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });
  }
};

/** Lock a previewed portrait in as a reusable persona. */
const avatarCreatePersona: Handler = async (input) => {
  const name = String(input?.name ?? "").trim();
  const file = String(input?.file ?? "").trim();
  if (!name) throw new ZiteError({ code: "BAD_REQUEST", message: "Give the persona a name." });
  if (!file) throw new ZiteError({ code: "BAD_REQUEST", message: "Generate a portrait first." });

  // `file` comes from the browser, so it is only ever a basename inside
  // avatarDir — never a path. Anything else is rejected rather than resolved.
  const base = path.basename(file);
  const portraitFile = path.join(config.avatarDir, base);
  if (base !== file || !fs.existsSync(portraitFile)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That portrait is no longer available — generate a new one." });
  }

  const ttsProvider = coerceTtsProvider(input?.ttsProvider);
  return {
    persona: avatarStore.createPersona({
      name,
      lookPrompt: String(input?.lookPrompt ?? ""),
      // Kept on the persona so every future video returns to the same room.
      roomId: String(input?.roomId ?? ""),
      scenePrompt: String(input?.scenePrompt ?? "").trim() || DEFAULT_SCENE_PROMPT,
      portraitFile,
      portraitMime: base.endsWith(".jpg") ? "image/jpeg" : "image/png",
      ttsProvider,
      ttsVoice: String(input?.ttsVoice ?? "").trim() || defaultVoice(ttsProvider),
      // The clip the voice was cloned from. Stored on the persona so the voice
      // can be re-created elsewhere later — the cloned model itself is not ours.
      voiceSampleFile: input?.voiceSampleFile
        ? path.join(config.avatarDir, path.basename(String(input.voiceSampleFile)))
        : "",
    }),
  };
};

const avatarUpdatePersona: Handler = async (input) => {
  const id = String(input?.id ?? "");
  const persona = avatarStore.updatePersona(id, {
    name: input?.name !== undefined ? String(input.name).trim() : undefined,
    scenePrompt: input?.scenePrompt !== undefined ? String(input.scenePrompt) : undefined,
    ttsProvider: input?.ttsProvider !== undefined ? String(input.ttsProvider) : undefined,
    ttsVoice: input?.ttsVoice !== undefined ? String(input.ttsVoice) : undefined,
  });
  if (!persona) throw new ZiteError({ code: "NOT_FOUND", message: "Persona not found." });
  return { persona };
};

/** Deletes the persona AND every video made from it — the UI must confirm. */
const avatarDeletePersona: Handler = async (input) => ({
  deleted: avatarStore.deletePersona(String(input?.id ?? "")),
});

/** Start a render. Returns immediately; the UI polls avatarVideoStatus. */
const avatarStartVideo: Handler = async (input) => {
  const segRaw = Number(input?.segmentSeconds);
  try {
    const id = startAvatarVideo({
      personaId: String(input?.personaId ?? ""),
      title: String(input?.title ?? "").trim(),
      script: String(input?.script ?? ""),
      provider: coerceAvatarProvider(input?.provider),
      resolution: coerceAvatarResolution(input?.resolution),
      segmentSeconds: Number.isFinite(segRaw) && segRaw > 0 ? Math.floor(segRaw) : 0,
      seed: Number.isFinite(Number(input?.seed)) ? Number(input.seed) : undefined,
    });
    return { videoId: id };
  } catch (e: any) {
    // Everything startVideo throws is a precondition the operator can fix
    // (missing key, no persona, empty script) — surface it as BAD_REQUEST so
    // the UI shows the message instead of a generic failure.
    throw new ZiteError({ code: "BAD_REQUEST", message: String(e?.message ?? e) });
  }
};

const avatarVideoStatus: Handler = async (input) => {
  const video = avatarStore.getVideo(String(input?.videoId ?? ""));
  if (!video) throw new ZiteError({ code: "NOT_FOUND", message: "Render not found." });
  return { video };
};

const avatarListVideos: Handler = async (input) => ({
  videos: avatarStore.listVideos(Number.isFinite(Number(input?.limit)) ? Number(input.limit) : 100),
  totalSpendUsd: avatarStore.totalSpendUsd(),
});

/**
 * Retry a failed render. Resumes: the narration already paid for is reused and
 * segments that were accepted keep their provider task ids, so a run that died
 * on an out-of-credit error costs nothing extra to finish.
 */
const avatarRetryVideo: Handler = async (input) => {
  const id = String(input?.videoId ?? "");
  if (!retryAvatarVideo(id)) {
    throw new ZiteError({ code: "BAD_REQUEST", message: "That render is not in a state that can be retried." });
  }
  return { retried: true };
};

const avatarCancelVideo: Handler = async (input) => ({
  canceled: cancelAvatarVideo(String(input?.videoId ?? "")),
});

const avatarDeleteVideo: Handler = async (input) => ({
  deleted: avatarStore.deleteVideo(String(input?.videoId ?? "")),
});

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
  // Auto-Screencast (native browser capture)
  autoScreencast,
  recaptureScreencast,
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
  // sticker sound (built-in slap, or the user's own upload)
  getStickerSound,
  setStickerSound,
  setStickerSoundSpeed,
  resetStickerSound,
  validateAssets: async () => ({ ok: true, errors: [] }),
  getWaveform,
  // storage management
  listStorage,
  deleteStorageFiles,
  deleteStorageArea,
  pruneSystemStorage,
  // Thumbnail Designer (LAB tool)
  thumbnailStatus,
  analyzeThumbnailScript,
  searchThumbnails,
  startThumbnailGeneration,
  generateThumbnailTitles,
  planThumbnailRecreations,
  planThumbnailCustomEdit,
  restyleContrarianText,
  recompositeContrarianThumbnail,
  recompositeRecreationThumbnail,
  planThumbnailContrarian,
  startContrarianGeneration,
  thumbnailJobStatus,
  cancelThumbnailJob,
  cancelAllThumbnailJobs: cancelAllThumbnailJobsEndpoint,
  generateThumbnails,
  listThumbnailCharacters,
  uploadThumbnailCharacter,
  deleteThumbnailCharacter,
  listThumbnailBackgrounds,
  uploadThumbnailBackground,
  deleteThumbnailBackground,
  uploadThumbnailFont,
  deleteThumbnailFont,
  // AI Image Generator (LAB tool)
  imageGeneratorStatus,
  generateChatImage,
  listImageHistory,
  deleteImageHistoryItem,
  // Keyword Research (LAB tool)
  keywordResearchStatus,
  startKeywordResearch,
  keywordResearchJobStatus,
  fetchKeywordCompetitors: fetchKeywordCompetitorsHandler,
  refreshVolume,
  renameResearchRun,
  pinResearchRun,
  listResearchRuns,
  getResearchRun,
  deleteResearchRun,
  // Keyword Research favorites
  listFavFolders,
  createFavFolder,
  renameFavFolder,
  deleteFavFolder,
  getFavorites,
  addFavTitle,
  removeFavTitle,
  updateFavTitle,
  addFavKeyword,
  removeFavKeyword,
  updateFavKeyword,
  extractKeywordsFromTitles,
  // Jake Dawson Script Generator (LAB tool)
  scriptGenStatus,
  startScript,
  continueScript,
  scriptJobStatus,
  getScriptRun,
  listScriptRuns,
  deleteScriptRun,
  refineScriptParagraph,
  // Video Planner (LAB tool — infrastructure for the future long-form editor)
  plannerStatus,
  startPlan,
  planJobStatus,
  getPlanRun,
  listPlanRuns,
  deletePlanRun,
  auditStatus,
  startAudit,
  auditJobStatus,
  approveAuditMarket,
  getAuditRun,
  listAuditRuns,
  deleteAuditRun,
  skoolStatus,
  skoolCheckLogin,
  skoolImportCookies,
  skoolCloseBrowser,
  skoolSaveSettings,
  skoolReadClassroom,
  skoolReadCourse,
  skoolBuildInventory,
  skoolGetInventory,
  skoolBuildPlan,
  skoolGetPlan,
  skoolWriteLessons,
  skoolPlanRebuild,
  skoolRunRebuildOp,
  skoolProbe,
  skoolEmailNotify,
  skoolAttach,
  skoolDryPublish,
  skoolWriteVideoLesson,
  skoolVideoLessonStatus,
  skoolConsoleFrame,
  skoolConsoleNavigate,
  skoolConsoleHover,
  skoolConsoleClick,
  skoolConsoleType,
  skoolConsoleKey,
  skoolConsoleScroll,
  skoolConsoleClearField,
  skoolRunAction,
  // Engagement half — reads and drafts, no writes.
  skoolReadFeed,
  skoolReadPost,
  skoolReadComments,
  skoolRepliesStatus,
  skoolRepliesConfigure,
  skoolRepliesQueue,
  skoolRepliesSweep,
  skoolRepliesSend,
  skoolRepliesForget,
  skoolUnreadChats,
  skoolKnowledge,
  skoolBackfillTranscripts,
  skoolDraftPost,
  skoolDraftReply,
  skoolPublishPost,
  skoolReplyToComment,
  skoolReadDms,
  skoolReadDmThread,
  skoolSendDm,
  // The autonomous poster: schedule, queue, and the reviewed-publish path.
  skoolEngageStatus,
  skoolEngageConfigure,
  skoolEngageTick,
  skoolEngagePublish,
  skoolEngageSubject,
  skoolEngagePin,
  skoolEngageUnpin,
  skoolDescribePoint,
  skoolSaveRecipe,
  skoolListRecipes,
  skoolGetRecipe,
  skoolDeleteRecipe,
  auditChat,
  clearAuditFocus,
  listAuditMarkets: listAuditMarketsHandler,
  saveAuditMarket: saveAuditMarketHandler,
  deleteAuditMarket: deleteAuditMarketHandler,
  markRenameApplied,
  unmarkRenameApplied,
  checkAppliedRenames,
  // Engagement Manager (LAB tool — Phase 1: monitor)
  engageStatus,
  engageListInbox,
  engageListThreads,
  engageGetThread,
  engageSetChannelMode,
  engageKillSwitch,
  engageRefreshChannels,
  engagePollNow,
  engageRefreshStats,
  metaStatus,
  tiktokStatus,
  // Engagement Manager (LAB tool — Phase 3: replies + browser login console)
  engageReplyStatus,
  engageListReplies,
  engageGetReplyPrompt,
  engageUpdateSettings,
  engageDraftReply,
  engageApproveReply,
  engageSendReply,
  engageRejectReply,
  engageReplyCycleNow,
  engageBrowserStatus,
  engageBrowserOpen,
  engageBrowserFrame,
  engageBrowserClick,
  engageBrowserType,
  engageBrowserKey,
  engageBrowserScroll,
  engageBrowserDrag,
  engageBrowserNavigate,
  engageBrowserVerify,
  engageBrowserImportCookies,
  engageBrowserClose,
  // Avatar Narrator (LAB tool)
  avatarStatus,
  avatarEstimate,
  avatarPreviewPortrait,
  avatarEditPortrait,
  avatarPreviewVoice,
  avatarDesignVoice,
  avatarCloneVoice,
  avatarListPortraits,
  avatarListVoiceSamples,
  avatarDeleteVoiceSample,
  avatarDeletePortrait,
  avatarCharacterSheet,
  avatarPlaceInRoom,
  avatarCreatePersona,
  avatarUpdatePersona,
  avatarDeletePersona,
  avatarStartVideo,
  avatarVideoStatus,
  avatarListVideos,
  avatarCancelVideo,
  avatarRetryVideo,
  avatarDeleteVideo,
};

void config;
