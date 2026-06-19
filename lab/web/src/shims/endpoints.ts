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
export const getPostizSettings = endpoint("getPostizSettings");
export const updatePostizSettings = endpoint("updatePostizSettings");
export const restartPostiz = endpoint("restartPostiz");
// Bulk Scheduler (Postiz public API)
export const getBulkSchedulerStatus = endpoint("getBulkSchedulerStatus");
export const getBulkSchedulerChannels = endpoint("getBulkSchedulerChannels");
export const previewBulkSchedule = endpoint("previewBulkSchedule");
export const runBulkSchedule = endpoint("runBulkSchedule");
export const listCloudFolder = endpoint("listCloudFolder");
export const getShots = endpoint("getShots");
export const getWaveform = endpoint("getWaveform");
export const indexPromoVideo = endpoint("indexPromoVideo");
export const importPromoIndex = endpoint("importPromoIndex");
export const reindexAllPromos = endpoint("reindexAllPromos");
export const getReindexProgress = endpoint("getReindexProgress");
export const getPromoIndex = endpoint("getPromoIndex");
export const exportPromoIndexes = endpoint("exportPromoIndexes");
export const createBulkNarration = endpoint("createBulkNarration");
export const getBulkRun = endpoint("getBulkRun");
export const createBulkCut = endpoint("createBulkCut");
export const getCutRun = endpoint("getCutRun");
export const getNarrationCuts = endpoint("getNarrationCuts");
export const analyzeCut = endpoint("analyzeCut");
export const getAnalyzeCut = endpoint("getAnalyzeCut");
export const findShortCut = endpoint("findShortCut");
export const renderManualCut = endpoint("renderManualCut");
export const getCutJob = endpoint("getCutJob");
export const listJobs = endpoint("listJobs");
export const pauseJob = endpoint("pauseJob");
export const resumeJob = endpoint("resumeJob");
export const cancelJob = endpoint("cancelJob");
export const createMeme = endpoint("createMeme");
export const getMemeRun = endpoint("getMemeRun");
export const getMemeProjects = endpoint("getMemeProjects");
export const pollBrollStatus = endpoint("pollBrollStatus");
export const recaptureShot = endpoint("recaptureShot");
// Auto-Screencast: plan + capture real website screencasts into the timeline.
export const autoScreencast = endpoint<AutoScreencastInputType, AutoScreencastOutputType>("autoScreencast");
export const recaptureScreencast = endpoint<{ shotId: string }, RecaptureScreencastOutputType>("recaptureScreencast");
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
export const listStorage = endpoint("listStorage");
export const deleteStorageFiles = endpoint("deleteStorageFiles");
export const deleteStorageArea = endpoint("deleteStorageArea");
export const reviewEdit = endpoint("reviewEdit");
// Thumbnail Designer (LAB tool)
export const thumbnailStatus = endpoint<Record<string, never>, ThumbnailStatusOutputType>("thumbnailStatus");
export const analyzeThumbnailScript =
  endpoint<{ script: string }, ThumbnailScriptAnalysisOutputType>("analyzeThumbnailScript");
export const searchThumbnails = endpoint<{ keyword: string }, SearchThumbnailsOutputType>("searchThumbnails");
export const generateThumbnails =
  endpoint<{ keyword: string; videoType: ThumbnailVideoType; picks: string[]; mode?: ThumbnailMode }, GenerateThumbnailsOutputType>("generateThumbnails");
export const startThumbnailGeneration =
  endpoint<
    { keyword: string; videoType: ThumbnailVideoType; picks: string[]; mode?: ThumbnailMode; imageSize?: string; plans?: RecreationPlan[] },
    { jobId: string }
  >("startThumbnailGeneration");
/** PLAN every per-thumbnail decision (cast + background + text) for review/edit. */
export const planThumbnailRecreations =
  endpoint<
    { keyword: string; videoType: ThumbnailVideoType; picks: string[]; titles?: string[] },
    { plans: RecreationPlan[] }
  >("planThumbnailRecreations");

export type TextRewrite = { old: string; new: string };
export type PlanElement = { id: string; label: string; apply: boolean; instruction: string };
export type RecreationPlan = {
  videoId: string;
  sourceThumbnailUrl: string;
  expression: string;
  expressionLabel: string;
  busy: boolean;
  backgroundId: string | null;
  rewrites: TextRewrite[];
  elements: PlanElement[];
};
/** Free-text → precise edit element(s) for one picked thumbnail. */
export const planThumbnailCustomEdit =
  endpoint<{ videoId: string; keyword: string; request: string }, { elements: PlanElement[] }>("planThumbnailCustomEdit");
/** Turn the pasted script into viral + SEO titles (shown + used to ground copy). */
export const generateThumbnailTitles =
  endpoint<{ script: string }, { titles: ThumbnailTitles }>("generateThumbnailTitles");
/** PLAN the contrarian copy for review/edit before generation. */
export const planThumbnailContrarian =
  endpoint<{ keyword: string; titles?: string[]; script?: string }, { variations: PlannedContrarian[] }>("planThumbnailContrarian");
/** Start the parallel CONTRARIAN ORIGINALS workflow; accepts approved/edited copy. */
export const startContrarianGeneration =
  endpoint<
    { keyword: string; mode?: ThumbnailMode; titles?: string[]; script?: string; variations?: PlannedContrarian[] },
    { jobId: string }
  >("startContrarianGeneration");

export type ThumbnailTitles = { viral: string[]; seo: string[] };
export type PlannedContrarian = {
  templateId: string;
  templateLabel: string;
  text: string;
  emphasis: string;
  expressionId: string;
  expressionLabel: string;
  textScale: number;
  textOffsetY: number;
};
export const thumbnailJobStatus =
  endpoint<{ jobId: string }, ThumbnailJobStatus>("thumbnailJobStatus");
export const listThumbnailCharacters =
  endpoint<Record<string, never>, { characters: ThumbnailCharacterState[] }>("listThumbnailCharacters");
export const uploadThumbnailCharacter =
  endpoint<{ expression?: string; id?: string; name?: string; imageBase64: string }, ThumbnailCharacterMutationOutputType>("uploadThumbnailCharacter");
export const deleteThumbnailCharacter =
  endpoint<{ expression?: string; id?: string }, ThumbnailCharacterMutationOutputType>("deleteThumbnailCharacter");

// ── Background library SDK ───────────────────────────────────────────────────
export const listThumbnailBackgrounds =
  endpoint<Record<string, never>, { backgrounds: ThumbnailBackgroundState[] }>("listThumbnailBackgrounds");
export const uploadThumbnailBackground =
  endpoint<{ name: string; imageBase64: string }, { background: ThumbnailBackgroundState; backgrounds: ThumbnailBackgroundState[] }>("uploadThumbnailBackground");
export const deleteThumbnailBackground =
  endpoint<{ id: string }, { backgrounds: ThumbnailBackgroundState[] }>("deleteThumbnailBackground");

// ── Headline font (contrarian overlay) SDK ───────────────────────────────────
export const uploadThumbnailFont =
  endpoint<{ filename: string; fontBase64: string }, { font: ThumbnailFontState }>("uploadThumbnailFont");
export const deleteThumbnailFont =
  endpoint<Record<string, never>, { font: ThumbnailFontState }>("deleteThumbnailFont");

// ── Thumbnail Designer types ─────────────────────────────────────────────────
/** Expression id: a built-in name OR a custom slug. */
export type ThumbnailExpression = string;
/** The four built-in expression slots (custom ones are added on top). */
export const BUILTIN_THUMBNAIL_EXPRESSIONS = ['smile', 'surprise', 'secret', 'calm'] as const;
export type ThumbnailVideoType = 'Tutorial' | 'Viral' | 'Secret' | 'Review';
/** Image-edit provider that drives the recreation chain. */
export type ThumbnailProvider = 'gemini-pro' | 'gemini-flash-31';
/**
 * Generation mode = the single image provider. Default 'gemini-pro' (Nano Banana
 * Pro @ 4K, sharpest); 'gemini-flash' is the cheaper alternative.
 */
export type ThumbnailMode = ThumbnailProvider;
export type ThumbnailCharacterState = {
  /** Stable id (built-in name or custom slug). */
  id: ThumbnailExpression;
  /** @deprecated same as `id` (back-compat). */
  expression: ThumbnailExpression;
  /** Display name. */
  label: string;
  /** UI hint (which video type a built-in suits); empty for custom. */
  hint: string;
  /** Whether this is one of the four built-in slots. */
  builtin: boolean;
  uploaded: boolean;
  url: string | null;
  updatedAt: string | null;
};
export type ThumbnailBackgroundState = {
  id: string;
  label: string;
  url: string;
  updatedAt: string;
};
export type ThumbnailFontState = {
  uploaded: boolean;
  name: string | null;
  updatedAt: string | null;
};
export type ThumbnailStatusOutputType = {
  geminiConfigured: boolean;
  youtubeConfigured: boolean;
  characters: ThumbnailCharacterState[];
  uploadedExpressions: ThumbnailExpression[];
  backgrounds: ThumbnailBackgroundState[];
  uploadedBackgrounds: string[];
  font: ThumbnailFontState;
  /** Whether the contrarian character is composited 1:1 from real pixels vs. AI. */
  composite?: { canvas: boolean; removal: boolean; reason?: string };
};
export type ThumbnailScriptAnalysisOutputType = {
  keyword: string;
  videoType: ThumbnailVideoType;
  rationale?: string;
};
export type ThumbnailSearchResult = { videoId: string; title: string; thumbnailUrl: string };
export type SearchThumbnailsOutputType = { results: ThumbnailSearchResult[] };
export type ThumbnailChainStep = {
  id: string;
  label: string;
  instruction: string;
  applied: boolean;
  note?: string;
};
export type ThumbnailVariant = {
  videoId: string;
  sourceThumbnailUrl: string;
  outputUrl: string | null;
  expression: ThumbnailExpression;
  steps: ThumbnailChainStep[];
  error?: string;
};
export type GenerateThumbnailsOutputType = { variants: ThumbnailVariant[] };
/** One variant's live generation status (polled). */
export type ThumbnailJobVariant = {
  index: number;
  videoId: string;
  sourceThumbnailUrl: string;
  expression: ThumbnailExpression;
  /** The provider sub-run(s) — always exactly one now. */
  results: ThumbnailProviderResult[];
  /** Aggregate status across the sub-run (running until terminal). */
  status: 'queued' | 'running' | 'done' | 'error';
  /** Current step sentence ("Changing outfit", "Finalizing thumbnail", …). */
  stepLabel: string;
  /** 0..100, monotonic per variant. */
  percent: number;
  /** The successful sub-run's URL. */
  outputUrl?: string;
  /** Present when the sub-run errored. */
  error?: string;
  /** Contrarian only: re-render info for the live "text size" slider. */
  overlay?: ContrarianOverlay;
  /** Recreation (composite) only: live character-reposition info. */
  recompose?: RecomposeInfo;
};
export type ContrarianOverlay = {
  baseUrl: string;
  templateId: string;
  text: string;
  emphasis: string;
  textScale: number;
  textOffsetY: number;
  backgroundId: string;
  expressionId: string;
  placement: 'left' | 'center' | 'right';
  charOffsetX: number;
  charOffsetY: number;
  charZoom: number;
};
/** Live size/position sliders: re-render a contrarian headline on its base image. */
export const restyleContrarianText =
  endpoint<
    { baseUrl: string; templateId: string; text: string; emphasis: string; textScale: number; textOffsetY?: number },
    { outputUrl: string }
  >('restyleContrarianText');
export type RecomposeInfo = {
  sceneUrl: string;
  expressionId: string;
  placement: 'left' | 'center' | 'right';
  charOffsetX: number;
  charOffsetY: number;
  charZoom: number;
};
/** Live character handles: re-composite a recreation's character onto its scene. */
export const recompositeRecreationThumbnail =
  endpoint<
    {
      sceneUrl: string;
      expressionId: string;
      placement?: 'left' | 'center' | 'right';
      charOffsetX?: number;
      charOffsetY?: number;
      charZoom?: number;
    },
    { outputUrl: string }
  >('recompositeRecreationThumbnail');
/** Live character controls: re-composite a contrarian thumbnail (move/zoom/replace). */
export const recompositeContrarianThumbnail =
  endpoint<
    {
      backgroundId: string;
      expressionId: string;
      templateId: string;
      placement?: 'left' | 'center' | 'right';
      charOffsetX?: number;
      charOffsetY?: number;
      charZoom?: number;
      text: string;
      emphasis: string;
      textScale?: number;
      textOffsetY?: number;
    },
    { outputUrl: string; baseUrl: string }
  >('recompositeContrarianThumbnail');
/**
 * One provider sub-run within a variant — a variant now has exactly ONE (the
 * single chosen provider).
 */
export type ThumbnailProviderResult = {
  provider: string;
  /** Result label ("Nano Banana Pro · 4K", "Nano Banana (Flash)"). */
  label: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stepLabel: string;
  percent: number;
  outputUrl?: string;
  error?: string;
};
/** Live generation snapshot returned by `thumbnailJobStatus`. */
export type ThumbnailJobStatus = {
  jobId: string;
  /** Overall 0..100, monotonic. */
  percent: number;
  done: boolean;
  error: string | null;
  variants: ThumbnailJobVariant[];
};
export type ThumbnailCharacterMutationOutputType = {
  character: ThumbnailCharacterState | null;
  characters: ThumbnailCharacterState[];
};

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
  motionGraphicsForceDisabled?: boolean;
  transcriptionConfigured?: boolean;
  directorConfigured?: boolean;
  kinoviConfigured?: boolean;
  stockConfigured?: boolean;
  /** Auto-Screencast is usable here (a real Chromium binary exists). */
  screencastConfigured?: boolean;
  /** Postiz social poster (separate self-hosted container). */
  postizConfigured?: boolean;
  postizUrl?: string;
  postizPort?: string;
};
export type PostizKeyState = {
  key: string;
  label: string;
  group: string;
  connects: string;
  configured: boolean;
};
export type GetPostizSettingsOutputType = {
  keys: PostizKeyState[];
  envFileWritable: boolean;
  dockerSocketAvailable: boolean;
};
export type UpdatePostizSettingsOutputType = {
  keys: PostizKeyState[];
  envFileWritable: boolean;
  envWriteError?: string;
};
export type RestartPostizOutputType = { success: boolean; message: string };

// ── Bulk Scheduler ───────────────────────────────────────────────────────────
export type ShortPlatform = 'tiktok' | 'instagram' | 'youtube';
/** Effective caption/timing platform: the short trio PLUS "generic" (e.g. a Facebook Page). */
export type CaptionPlatform = ShortPlatform | 'generic';
/** Which API a channel posts through. */
export type BulkProvider = 'postiz' | 'postpeer';
/** TikTok Direct-Post controls (PostPeer-only). */
export type TikTokOptions = {
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  commercialContent: boolean;
};
export type BulkChannel = {
  id: string;
  provider: BulkProvider;
  name: string;
  identifier: string;
  platform: ShortPlatform | null;
  picture?: string;
  profile?: string;
};
export type BulkProviderStatus = {
  configured: boolean;
  channelCount: number;
  error?: string;
};
/** Which cloud-folder providers are configured (gates the Drive/Dropbox tabs). */
export type CloudProvidersStatus = { gdrive: boolean; dropbox: boolean };
export type GetBulkSchedulerStatusOutputType = {
  apiKeyConfigured: boolean;
  channelCount: number;
  channels: BulkChannel[];
  providers: { postiz: BulkProviderStatus; postpeer: BulkProviderStatus };
  /** Cloud folder browsing (Drive / Dropbox) availability. */
  cloudProviders: CloudProvidersStatus;
  error?: string;
};
export type GetBulkSchedulerChannelsOutputType = { channels: BulkChannel[] };

/** Cloud provider key for the folder-browse endpoint. */
export type CloudProvider = 'gdrive' | 'dropbox';
/** One browsable video in a cloud folder + the cloud source the picker adds. */
export type CloudFolderItem = {
  id: string;
  name: string;
  mimeType?: string;
  thumbnailUrl?: string;
  sizeBytes?: number;
  source: { kind: 'cloud'; ref: string };
};
export type ListCloudFolderOutputType = { items: CloudFolderItem[] };
/** Growth Guardrails: one graded check on a post (caption or video pre-flight). */
export type GrowthSeverity = 'required' | 'recommended' | 'unknown';
export type GrowthCheck = {
  id: string;
  label: string;
  /** null when the check couldn't be measured (e.g. cloud link / ffprobe failed). */
  pass: boolean | null;
  severity: GrowthSeverity;
  hint: string;
};
export type Growth = {
  /** 0..100 combined caption + measured pre-flight score. */
  score: number;
  checks: GrowthCheck[];
};
export type BulkPreviewPost = {
  fileId: string;
  channelId: string;
  provider: BulkProvider;
  channelName: string;
  identifier: string;
  platform: CaptionPlatform;
  caption: string;
  firstLineHook: string;
  hashtags: string[];
  scheduledAt: string;
  reason: string;
  tiktok?: TikTokOptions;
  /** Growth Guardrails score + checklist for this (file × channel) post. */
  growth: Growth;
};
/** What one file's captions were grounded in (the transcribe-first pipeline). */
export type BulkPreviewFile = {
  fileId: string;
  /**
   * Transcript the captions were generated from (trimmed for display), or null
   * when no speech was detected / transcription was unavailable and the captions
   * fell back to the brief.
   */
  transcript: string | null;
};
/** A (file × channel) post dropped as a de-duplicate (already in the ledger). */
export type BulkSkippedPost = {
  fileId: string;
  channelId: string;
  channelName: string;
  reason: string;
};
export type PreviewBulkScheduleOutputType = {
  posts: BulkPreviewPost[];
  files: BulkPreviewFile[];
  skippedChannels: Array<{ id: string; reason: string }>;
  /** (file × channel) posts skipped because they're already scheduled to that channel. */
  skippedPosts: BulkSkippedPost[];
  /** Per-channel "continuing your queue from <local day>" hints. */
  continuedFrom: Array<{ channelId: string; channelName: string; fromLocalDay: string }>;
};
export type BulkScheduleItemResult = {
  fileId: string;
  channelId: string;
  ok: boolean;
  error?: string;
  /** Set when blocked by Growth Guardrails: the failing required checks. */
  blockedChecks?: GrowthCheck[];
};
export type RunBulkScheduleOutputType = {
  results: BulkScheduleItemResult[];
  scheduled: number;
  failed: number;
};
/** Auto-Screencast input/output (plan + capture website footage into the timeline). */
export type AutoScreencastInputType = { projectId: string; maxMoments?: number };
export type AutoScreencastOutputType = {
  planned: number;
  captured: number;
  skipped: Array<{ reason: string; url?: string }>;
  failed: Array<{ error: string; url?: string; shotId?: string }>;
};
export type RecaptureScreencastOutputType = { success: boolean; clipUrl?: string; error?: string };
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
