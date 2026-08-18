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
// printed to the browser console with a [The Lab] tag so they're easy to copy
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
    console.log(`%c[The Lab] → #${id} ${name}`, "color:#60a5fa;font-weight:bold", input ?? {});
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/fn/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input ?? {}),
      // Send the session cookie (same-origin sends it anyway; explicit for clarity).
      credentials: "include",
    });
  } catch (networkErr) {
    console.error(`[The Lab] ✗ #${id} ${name} — network error`, networkErr);
    throw new Error(`${name}: network error (is the server reachable?)`);
  }
  // Session expired / not signed in → bounce to Google sign-in.
  if (res.status === 401) {
    window.location.href = "/auth/google";
    throw new Error(`${name}: sign-in required`);
  }
  const ms = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    console.error(`[The Lab] ✗ #${id} ${name} (${ms}ms) — non-JSON response:`, text.slice(0, 500));
    throw new Error(`${name}: invalid response: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || json?.message || `${name} failed (${res.status})`;
    console.error(`[The Lab] ✗ #${id} ${name} (${ms}ms) HTTP ${res.status}:`, msg, json);
    throw new Error(msg);
  }
  if (debugOn()) {
    console.log(`%c[The Lab] ✓ #${id} ${name} (${ms}ms)`, "color:#34d399;font-weight:bold", json);
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
// The sticker slap sound: read the current one, replace it with an upload, or
// go back to the built-in.
export const getStickerSound = endpoint("getStickerSound");
export const setStickerSound = endpoint("setStickerSound");
export const setStickerSoundSpeed = endpoint("setStickerSoundSpeed");
export const resetStickerSound = endpoint("resetStickerSound");
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
export const pruneSystemStorage = endpoint("pruneSystemStorage");
export const reviewEdit = endpoint("reviewEdit");
// AI Image Generator (LAB tool) — ephemeral Nano Banana chat.
export const imageGeneratorStatus =
  endpoint<Record<string, never>, { geminiConfigured: boolean; promptOptimizerConfigured: boolean }>(
    "imageGeneratorStatus",
  );
export const generateChatImage = endpoint<
  {
    prompt: string;
    images?: { base64: string; mimeType: string }[];
    model?: string;
    aspect?: string;
    optimize?: boolean;
  },
  {
    image: { base64: string; mimeType: string };
    prompt: string;
    optimized: boolean;
    model: string;
    modelLabel: string;
    /** History row id + relative serve URL for the just-persisted image (null if persistence failed). */
    historyId: string | null;
    historyUrl: string | null;
  }
>("generateChatImage");

/** One saved image in the generator's History panel. `url` is same-origin & cookie-authed. */
export interface ImageHistoryItem {
  id: string;
  prompt: string;
  url: string;
  mime: string;
  kind: 'generate' | 'edit';
  model: string | null;
  ts: number;
}
export const listImageHistory =
  endpoint<Record<string, never>, { items: ImageHistoryItem[] }>("listImageHistory");
export const deleteImageHistoryItem =
  endpoint<{ id: string }, { ok: true }>("deleteImageHistoryItem");
// ── YouTube Keyword Research (LAB tool) ──────────────────────────────────────
// Local mirrors of server/src/keyword/types.ts (the frontend can't import server
// types — these are kept structurally identical so the page type-checks alone).
export type ResearchMode = "seeds" | "topic" | "competitors" | "ai";
export type ResearchRunStatus = "running" | "completed" | "failed";

export interface KeywordGapFlags {
  demandVsCompetition: boolean;
  smallChannelOutlier: boolean;
  underservedSubtopic: boolean;
  freshnessGap: boolean;
}
export interface KeywordCompetitorRef {
  channelId: string;
  channelTitle: string;
  subscriberCount: number | null;
  rank: number;
  videoId: string;
  videoTitle: string;
  videoViews: number;
  videoPublishedAt: string | null;
}
export interface KeywordMetrics {
  keyword: string;
  demandScore: number;
  competitionScore: number;
  opportunityScore: number;
  trendsScore: number | null;
  autocompleteScore: number;
  searchVolume: number | null;
  cpc: number | null;
  paidCompetition: number | null;
  ytResultCount: number | null;
  topViewMedian: number | null;
  topViewMax: number | null;
  avgChannelSubs: number | null;
  topVideoAgeDays: number | null;
  gapFlags: KeywordGapFlags;
  cluster: string | null;
  sources: string[];
  topCompetitors: KeywordCompetitorRef[];
  competitionFetched: boolean;
  alreadyCovered: boolean;
  lastFetchedAt: number;
}
export interface KeywordCluster {
  name: string;
  keywords: string[];
  rationale?: string;
}
export interface KeywordMarketAnalysis {
  overview: string;
  audience: string;
  topCompetitors: { name: string; note: string }[];
  contentAngles: string[];
}
export interface KeywordResearchSummary {
  totalKeywords: number;
  topOpportunities: string[];
  avgDemand: number;
  avgCompetition: number;
  gapCount: number;
}
export interface InsightsReport {
  summary: string;
  topOpportunities: { keyword: string; why: string }[];
  contentIdeas: { title: string; keyword: string; angle: string }[];
  avoid: { keyword: string; why: string }[];
  newAvenues: { topic: string; why: string }[];
  seriesStrategy: string;
}
export interface ChannelVideo {
  videoId: string;
  title: string;
  views: number;
  publishedAt: string | null;
}
export interface ChannelProfile {
  channelId: string;
  title: string;
  handle: string | null;
  url: string;
  subscriberCount: number | null;
  videoCount: number | null;
  viewCount: number | null;
  videos: ChannelVideo[];
  fetchedAt: number;
}
export interface ResearchRunResult {
  runId: string;
  niche: string;
  mode: ResearchMode;
  keywords: KeywordMetrics[];
  clusters: KeywordCluster[];
  market: KeywordMarketAnalysis | null;
  summary: KeywordResearchSummary;
  insights: InsightsReport | null;
  channel: ChannelProfile | null;
  status: ResearchRunStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface ResearchRunListItem {
  id: string;
  niche: string;
  mode: ResearchMode;
  totalKeywords: number;
  gapCount: number;
  status: ResearchRunStatus;
  pinned: boolean;
  createdAt: number;
}
export interface ResearchJobSnapshot {
  jobId: string;
  runId: string;
  status: ResearchRunStatus;
  phase: string;
  percent: number;
  keywordsFound: number;
  keywordsScored: number;
  error: string | null;
}
export interface KeywordResearchStatusOutput {
  youtubeConfigured: boolean;
  trendsAvailable: boolean;
  keywordApiConfigured: boolean;
  promptOptimizerConfigured: boolean;
}
export interface StartKeywordResearchInput {
  mode: ResearchMode;
  niche?: string;
  seeds?: string[];
  topic?: string;
  competitors?: string[];
  freeText?: string;
  maxKeywords?: number;
  refresh?: boolean;
  channelUrl?: string;
}
export const keywordResearchStatus =
  endpoint<Record<string, never>, KeywordResearchStatusOutput>("keywordResearchStatus");
export const startKeywordResearch =
  endpoint<StartKeywordResearchInput, { jobId: string; runId: string }>("startKeywordResearch");
export const keywordResearchJobStatus =
  endpoint<{ jobId: string }, ResearchJobSnapshot>("keywordResearchJobStatus");
export const listResearchRuns =
  endpoint<Record<string, never>, { runs: ResearchRunListItem[] }>("listResearchRuns");
export const getResearchRun =
  endpoint<{ runId: string }, ResearchRunResult>("getResearchRun");
export const refreshVolume =
  endpoint<{ runId: string }, ResearchRunResult>("refreshVolume");
export const deleteResearchRun =
  endpoint<{ runId: string }, { ok: true }>("deleteResearchRun");
export const renameResearchRun =
  endpoint<{ runId: string; niche: string }, { ok: true }>("renameResearchRun");
export const pinResearchRun =
  endpoint<{ runId: string; pinned: boolean }, { ok: true }>("pinResearchRun");
export const fetchKeywordCompetitors =
  endpoint<{ runId: string; keyword: string }, KeywordMetrics>("fetchKeywordCompetitors");

// ── Favorites (saved titles + personal keyword DB, organized in folders) ──────
export interface FavFolder {
  id: string;
  name: string;
  titleCount: number;
  keywordCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface FavTitle {
  id: string;
  folderId: string;
  title: string;
  videoId: string | null;
  channelTitle: string | null;
  views: number | null;
  subscriberCount: number | null;
  publishedAt: string | null;
  sourceKeyword: string | null;
  note: string | null;
  tags: string[];
  createdAt: number;
}
export type FavKeywordSource = "extracted" | "table" | "manual";
export interface FavKeyword {
  id: string;
  folderId: string;
  keyword: string;
  source: FavKeywordSource;
  sourceTitleId: string | null;
  note: string | null;
  tags: string[];
  createdAt: number;
}
export interface FavoritesView {
  folder: FavFolder;
  titles: FavTitle[];
  keywords: FavKeyword[];
}
export const listFavFolders = endpoint<Record<string, never>, { folders: FavFolder[] }>("listFavFolders");
export const createFavFolder = endpoint<{ name: string }, { folder: FavFolder }>("createFavFolder");
export const renameFavFolder = endpoint<{ folderId: string; name: string }, { ok: true }>("renameFavFolder");
export const deleteFavFolder = endpoint<{ folderId: string }, { ok: true }>("deleteFavFolder");
export const getFavorites = endpoint<{ folderId: string }, FavoritesView>("getFavorites");
export const addFavTitle = endpoint<
  {
    folderId: string;
    title: string;
    videoId?: string | null;
    channelTitle?: string | null;
    views?: number | null;
    subscriberCount?: number | null;
    publishedAt?: string | null;
    sourceKeyword?: string | null;
  },
  { title: FavTitle }
>("addFavTitle");
export const removeFavTitle = endpoint<{ id: string }, { ok: true }>("removeFavTitle");
export const updateFavTitle =
  endpoint<{ id: string; note?: string; tags?: string[] }, { ok: true }>("updateFavTitle");
export const addFavKeyword = endpoint<
  { folderId: string; keyword: string; source?: FavKeywordSource; sourceTitleId?: string | null; note?: string; tags?: string[] },
  { keyword: FavKeyword }
>("addFavKeyword");
export const removeFavKeyword = endpoint<{ id: string }, { ok: true }>("removeFavKeyword");
export const updateFavKeyword =
  endpoint<{ id: string; note?: string; tags?: string[] }, { ok: true }>("updateFavKeyword");
export const extractKeywordsFromTitles =
  endpoint<{ folderId: string; titleIds: string[] }, { added: FavKeyword[] }>("extractKeywordsFromTitles");

// ── Jake Dawson Script Generator (LAB tool) ──────────────────────────────────
export type SponsorshipMode = "organic" | "whole-video" | "mid-roll";
export interface Sponsorship {
  mode: SponsorshipMode;
  sponsorName: string | null;
}
export interface ScriptInput {
  idea: string;
  brief?: string;
  sponsorship?: Sponsorship;
  targetLength?: string;
}
export type ScriptVideoType = "Tutorial" | "List/Roundup" | "Tool Review" | "Business Guide" | "Opinion";
export interface Stage0Result {
  videoTypeDetailed: string;
  videoType: ScriptVideoType;
  titleOptions: string[];
  recommendedTitle: string;
  coreTopic: string;
  specificFocus: string;
}
export interface ScriptSetup {
  videoType: ScriptVideoType;
  title: string;
  coreTopic: string;
  specificFocus: string;
  sponsorship: Sponsorship;
  targetLength: string;
}
export interface ScriptSection {
  name: string;
  draft: string;
  final: string;
}
export interface BriefCheck {
  /** 0–100 coverage of the brief. */
  score: number;
  verdict: string;
  gaps: string[];
  editsApplied: string[];
  editsSkipped: string[];
}
/** One brief request, and what the outline did with it (Stage 2.5). */
export interface CoverageItem {
  item: string;
  status: 'covered' | 'added' | 'gap';
  where: string;
}
/** Stage 2.5 — brief coverage judged while a dropped request can still get its own section. */
export interface BriefCoverage {
  score: number;
  verdict: string;
  items: CoverageItem[];
  outlineRevised: boolean;
}
export interface ScriptSource { url: string; title: string }
export interface ReviewChecklist {
  shortHook: boolean; largeMeat: boolean; fourteenYearOld: boolean;
  noPunchSideways: boolean; noPunchDown: boolean; welcomeAtHookEnd: boolean;
  noIncomeClaims: boolean; demosNotDescribes: boolean;
}
export interface ClaimAudit {
  unsupportedNumbers: string[]; fencedTopicsMentioned: string[];
  experienceClaims: string[];
  excessSponsorPlugs: string[]; bannedWords: string[]; numbersChecked: number;
}
export interface ScriptQuality {
  words: number; sentences: number; meanSentenceWords: number; burstiness: number;
  repeatedPhraseCount: number; worstPhraseRepeats: number; worstPhrase: string | null;
  discourseMarkerOpenings: number;
}
export interface ScriptStages {
  research: string | null;
  /** Stage 1 — the pages the research rested on. */
  sources: ScriptSource[];
  /** Stage 1.5 — checkable facts distilled from the research, with verification dates. */
  factSheet: string | null;
  outline: string | null;
  /** Stage 2.5 — brief coverage judged at outline-time. Null when the run had no brief. */
  briefCoverage: BriefCoverage | null;
  hooks: string | null;
  sponsorSegment: string | null;
  sections: ScriptSection[];
  outro: string | null;
  /** Stage 5.5 — the four hooks with the subscribe clause tagged onto each welcome beat. */
  hooksWithCta: string | null;
  /** Stage 5.5 — sections + outro with the like/comment CTAs placed. */
  ctaScript: string | null;
  /** Stage 5.5 — what the CTA pass placed and removed. */
  ctaNotes: string[];
  /** Stage 6.5 — brief adherence score + applied edits. Null when the run had no brief. */
  briefCheck: BriefCheck | null;
  reviewNotes: string[];
  reviewChecklist: ReviewChecklist | null;
  quality: ScriptQuality | null;
  claimAudit: ClaimAudit | null;
}
export type ScriptRunStatus = "classifying" | "awaiting_confirmation" | "running" | "completed" | "failed";
/** One turn of the post-generation paragraph-refinement chat. */
export interface RefineMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
}
export interface ScriptRunResult {
  runId: string;
  title: string;
  input: ScriptInput;
  setup: ScriptSetup | null;
  stage0: Stage0Result | null;
  stages: ScriptStages;
  finalDocument: string | null;
  /** Post-generation paragraph-refinement chat, oldest first. */
  refineChat: RefineMessage[];
  status: ScriptRunStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  generationMs: number;
}
export interface ScriptRunListItem {
  id: string;
  title: string;
  videoType: ScriptVideoType | null;
  status: ScriptRunStatus;
  createdAt: number;
  generationMs: number;
}
export interface ScriptJobSnapshot {
  jobId: string;
  runId: string;
  status: ScriptRunStatus;
  phase: string;
  percent: number;
  error: string | null;
  costUsd: number;
}
export interface ScriptGenStatusOutput {
  anthropicConfigured: boolean;
  model: string;
}
export const scriptGenStatus =
  endpoint<Record<string, never>, ScriptGenStatusOutput>("scriptGenStatus");
/** Stage 0: classify + propose titles; creates the run (status awaiting_confirmation). */
export const startScript = endpoint<ScriptInput, { runId: string; stage0: Stage0Result }>("startScript");
/** Confirm the type/title checkpoint and kick off Stages 1–7 as a background job. */
export const continueScript =
  endpoint<{ runId: string; setup: ScriptSetup }, { jobId: string; runId: string }>("continueScript");
export const scriptJobStatus = endpoint<{ jobId: string }, ScriptJobSnapshot>("scriptJobStatus");
export const getScriptRun = endpoint<{ runId: string }, ScriptRunResult>("getScriptRun");
export const listScriptRuns = endpoint<Record<string, never>, { runs: ScriptRunListItem[] }>("listScriptRuns");
export const deleteScriptRun = endpoint<{ runId: string }, { ok: true }>("deleteScriptRun");
/** Rewrite ONE pasted paragraph per an instruction, grounded in the run's research + fact sheet. */
export const refineScriptParagraph =
  endpoint<{ runId: string; paragraph?: string; instruction: string }, { messages: RefineMessage[]; costUsd: number }>(
    "refineScriptParagraph",
  );

// Video Planner (LAB tool — infrastructure for the future long-form editor)
export type PlanRunStatus =
  | "ingesting" | "transcribing" | "researching" | "planning" | "completed" | "failed";
export interface PlanLine { start: number; end: number; kind: string; instruction: string }
export interface PlanMeasure {
  lines: number; coverStart: number | null; coverEnd: number | null; duration: number;
  gaps: { at: number; len: number }[]; overlaps: { at: number; len: number }[]; unknown: number;
  screencastPct: number; talkingHeadPct: number; stockPct: number;
  screencastHold: number; talkingHeadHold: number;
  shots: number; shotsPerMin: number;
  openingShotsPerMin: number | null; bodyShotsPerMin: number | null; hookBodyRatio: number | null;
  titles: number; titlesPerMin: number; altPct: number; maxScreencastRun: number;
  longGradient: string[]; gradientFullStop: number; chars: number;
}
export interface PlanBeat {
  i: number; start: number; end: number; dur: number; gapAfter: number; text: string; emphasis: string[];
}
export interface PlanInput {
  source: string; sourceKind: "descript" | "upload";
  productUrls?: string[]; skipResearch?: boolean; title?: string;
}
export interface PlanRunResult {
  runId: string; status: PlanRunStatus; title: string; input: PlanInput;
  durationSec: number | null; plan: string | null; parsed: PlanLine[];
  measure: PlanMeasure | null;
  rounds: { round: number; penalty: number; measure: PlanMeasure; deviations: string[] }[];
  beats: PlanBeat[]; research: string | null; costUsd: number; error: string | null;
  createdAt: number; updatedAt: number;
}
export interface PlanRunListItem {
  runId: string; title: string; status: PlanRunStatus;
  durationSec: number | null; lines: number; createdAt: number; updatedAt: number;
}
export interface PlanJobSnapshot {
  runId: string; status: PlanRunStatus; stage: string; progress: number; error: string | null;
}
export const plannerStatus =
  endpoint<Record<string, never>, { anthropicConfigured: boolean; groqConfigured: boolean; model: string }>("plannerStatus");
/** Kick off a run; the work continues in the background. Poll planJobStatus. */
export const startPlan = endpoint<PlanInput, { runId: string }>("startPlan");
export const planJobStatus = endpoint<{ runId: string }, PlanJobSnapshot>("planJobStatus");

// ── Channel Audit ───────────────────────────────────────────────────────────
// startAudit pauses at "awaiting-approval"; the page then calls
// approveAuditMarket with the (possibly edited) competitor set to continue.
export const auditStatus = endpoint<void, { youtubeConfigured: boolean; anthropicConfigured: boolean }>("auditStatus");
export const startAudit = endpoint<any, { runId: string }>("startAudit");
export const auditJobStatus = endpoint<{ runId: string }, any>("auditJobStatus");
export const approveAuditMarket = endpoint<{ runId: string; market?: any }, { runId: string }>("approveAuditMarket");
export const getAuditRun = endpoint<{ runId: string }, any>("getAuditRun");
export const listAuditRuns = endpoint<{ limit?: number }, { runs: any[] }>("listAuditRuns");
export const deleteAuditRun = endpoint<{ runId: string }, { deleted: boolean }>("deleteAuditRun");
/** Discuss a finished report (Opus 5); may re-aim it at part of the catalogue. */
export const auditChat = endpoint<
  { runId: string; message: string },
  {
    reply: string;
    refocused: { note: string; videoCount: number } | null;
    tooNarrow?: number;
    /** Set when the answer added a new section to the report rather than just replying. */
    section?: { id: string; title: string; charts: number } | null;
  }
>("auditChat");
/* ── Skool manager ────────────────────────────────────────────────────────
   Skool has no API, so the session is a headless browser holding a login.  */
export interface SkoolSettings { communityUrl: string; roadmapMd: string; updatedAt: number }
export interface SkoolStatus {
  browserAvailable: boolean;
  loggedIn: boolean;
  account: string | null;
  url: string | null;
  error: string | null;
  open: boolean;
  settings: SkoolSettings;
}
export const skoolStatus = endpoint<void, SkoolStatus>("skoolStatus");
export const skoolCheckLogin = endpoint<void, SkoolStatus>("skoolCheckLogin");
export const skoolImportCookies = endpoint<
  { cookies: string },
  SkoolStatus & { kept: number; total: number }
>("skoolImportCookies");
export interface SkoolCourse {
  id: string; slug: string; title: string; description: string;
  modules: number; position: number; coverImage: string | null;
  state: number; privacy: number; minTier: number; published: boolean;
  createdAt: string; updatedAt: string;
}
export interface SkoolClassroom {
  community: string | null;
  account: string | null;
  courses: SkoolCourse[];
  readAt: number;
  error: string | null;
}
export const skoolReadClassroom = endpoint<
  { communityUrl?: string },
  { classroom: SkoolClassroom }
>("skoolReadClassroom");
/** One node inside a course. `unitType` is "course" at the root, "module" within. */
export interface SkoolUnit {
  id: string; slug: string; title: string; unitType: string;
  depth: number; position: number; parentId: string | null;
  videoUrl: string | null; videoSeconds: number | null;
  content: string; contentChars: number;
  published: boolean; createdAt: string; updatedAt: string;
}
export interface SkoolCourseDetail {
  courseId: string; slug: string; title: string;
  units: SkoolUnit[]; error: string | null;
}
export const skoolReadCourse = endpoint<
  { slug: string; communityUrl?: string },
  { course: SkoolCourseDetail }
>("skoolReadCourse");

/** The classroom plus the inside of every course — the planner's input. */
export interface SkoolInventory {
  community: string | null;
  account: string | null;
  courses: (SkoolCourse & { units: SkoolUnit[]; readError: string | null })[];
  readAt: number;
  /** Courses whose contents could not be read — named, never silently dropped. */
  unreadable: string[];
  error: string | null;
}
export interface SkoolInventoryRow {
  id: number;
  communityUrl: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt: number | null;
  coursesTotal: number;
  coursesRead: number;
  community: string | null;
  account: string | null;
  error: string | null;
  data: SkoolInventory | Record<string, never>;
}
/** Minutes of browser work — starts a background read and returns the row to poll. */
export const skoolBuildInventory = endpoint<
  { communityUrl?: string },
  { inventory: SkoolInventoryRow | null; alreadyRunning: boolean }
>("skoolBuildInventory");
export const skoolGetInventory = endpoint<
  { id?: number },
  { inventory: SkoolInventoryRow | null }
>("skoolGetInventory");

/* ── Teach console ────────────────────────────────────────────────────────
   Skool's editing controls cannot be found by querying the DOM — they are
   plain divs that don't exist until hovered. So the operator demonstrates each
   action once here and the server records WHAT was clicked, as durable element
   descriptors rather than coordinates.
   Positions travel as FRACTIONS of the displayed image; the server scales them
   to the real viewport, so the panel can be any size.                        */
export interface SkoolConsoleFrame {
  image: string | null;
  url: string | null;
  title: string | null;
  width: number;
  height: number;
  error: string | null;
}
export interface SkoolDescriptor {
  tag: string;
  text: string;
  testId: string | null;
  ariaLabel: string | null;
  /** An input's placeholder — the only durable handle Skool's fields have. */
  placeholder: string | null;
  role: string | null;
  classes: string[];
  nth: number;
  path: string;
  neededHover: boolean;
}
export const skoolConsoleFrame = endpoint<void, { frame: SkoolConsoleFrame }>("skoolConsoleFrame");
export const skoolConsoleNavigate =
  endpoint<{ url: string }, { frame: SkoolConsoleFrame }>("skoolConsoleNavigate");
export const skoolConsoleHover = endpoint<
  { xFrac: number; yFrac: number; describe?: boolean },
  { frame: SkoolConsoleFrame; descriptor: SkoolDescriptor | null }
>("skoolConsoleHover");
export const skoolConsoleClick = endpoint<
  { xFrac: number; yFrac: number; describe?: boolean },
  { frame: SkoolConsoleFrame; descriptor: SkoolDescriptor | null }
>("skoolConsoleClick");
export const skoolConsoleType =
  endpoint<{ text: string }, { frame: SkoolConsoleFrame }>("skoolConsoleType");
/** `key` for a single key, `combo` for a chord. ⌘ is translated to Ctrl —
    the remote browser is Linux, where Meta does nothing. */
export const skoolConsoleKey =
  endpoint<{ key?: string; combo?: string[] }, { frame: SkoolConsoleFrame }>("skoolConsoleKey");
export const skoolConsoleScroll =
  endpoint<{ dy: number }, { frame: SkoolConsoleFrame }>("skoolConsoleScroll");
/** Empties the focused field. Refuses when focus is not in an editable one,
    rather than letting a missed click select the whole page. */
export const skoolConsoleClearField = endpoint<
  void,
  { cleared: boolean; reason: string; frame: SkoolConsoleFrame }
>("skoolConsoleClearField");

export interface SkoolRecipeStep {
  kind: "hover" | "click" | "type" | "key" | "navigate" | "wait" | "scroll";
  label: string;
  target?: SkoolDescriptor;
  text?: string;
  value?: string;
  ms?: number;
  /** For `scroll`: pixels, positive is down. */
  dy?: number;
}
export interface SkoolRecipe {
  name: string;
  description: string;
  steps: SkoolRecipeStep[];
  updatedAt: number;
}
export const skoolSaveRecipe = endpoint<
  { name: string; description?: string; steps: SkoolRecipeStep[] },
  { recipe: SkoolRecipe | null }
>("skoolSaveRecipe");
export const skoolListRecipes = endpoint<void, { recipes: SkoolRecipe[] }>("skoolListRecipes");
export const skoolDeleteRecipe = endpoint<{ name: string }, { deleted: boolean }>("skoolDeleteRecipe");

export const skoolCloseBrowser = endpoint<void, { closed: boolean }>("skoolCloseBrowser");
export const skoolSaveSettings = endpoint<
  { communityUrl?: string; roadmapMd?: string },
  { settings: SkoolSettings }
>("skoolSaveSettings");

/* ── The engagement agent ─────────────────────────────────────────────────
   Writes community posts on a schedule. Everything here is either a read or
   a draft EXCEPT `skoolPublishPost` and `skoolEngagePublish`, which are the
   two calls that put text in front of members.                             */

export type SkoolWeekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export type SkoolSlotState = "pending" | "drafted" | "posted" | "abandoned";

export interface SkoolEngageSchedule {
  enabled: boolean;
  dryRun: boolean;
  days: SkoolWeekday[];
  hour: number;
  timezone: string;
  maxPostsPerWeek: number;
  maxAttempts: number;
  retryMinutes: number;
  maxSlotAgeHours: number;
}

/**
 * One posting day. `slotKey` is the LOCAL CALENDAR DATE and the primary key —
 * which is what makes the retry loop safe, since "try again" and "post again"
 * would otherwise be the same operation.
 */
export interface SkoolSlot {
  slotKey: string;
  state: SkoolSlotState;
  subject: string;
  title: string | null;
  body: string | null;
  category: string | null;
  citedJson: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  slug: string | null;
  /**
   * Which shape the post was queued as — settled when the slot OPENED.
   *
   * Worth showing: this was hardcoded to "lesson" until 2026-08-08, so every
   * Tuesday slot was written as a classroom post and nothing on this screen
   * said so.
   */
  kind: "lesson" | "mcp";
  /**
   * The publisher's step log for this slot, kept whether it succeeded or not.
   * Where "⚠ Attachment SKIPPED" shows up — an attachment never blocks a post,
   * so a post with a missing video is otherwise indistinguishable from a clean one.
   */
  steps: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SkoolDraft {
  title: string;
  body: string;
  category: string | null;
  cited: { title: string; url: string }[];
  tokens: number | null;
  model: string;
}

/**
 * The clock in the SCHEDULE's timezone, returned by the server rather than
 * computed here. Three zones are in play — the box is UTC, Jake is in
 * Asia/Bangkok, the schedule is America/New_York — so a UI that showed only
 * "9:00" would be telling nobody anything.
 */
export const skoolEngageStatus = endpoint<
  void,
  {
    schedule: SkoolEngageSchedule;
    now: { date: string; weekday: SkoolWeekday; hour: number };
    slots: SkoolSlot[];
    /**
     * Which credential the drafter spends (`SKOOL_AI_AUTH` server-side). The UI
     * needs it because a rate-limit refusal is free-and-possibly-all-day on
     * `subscription` but billed-and-back-in-seconds on `api`, and the operator
     * cannot tell which from the error text alone.
     */
    aiAuth: 'api' | 'subscription';
    /**
     * Is the loop still ticking, and is the current cycle stuck?
     *
     * ⚠️ NOTHING ELSE ON THIS RESPONSE CAN ANSWER THAT. A tick with nothing due
     * writes nothing and logs nothing, so an empty queue is what both a healthy
     * idle scheduler and a dead one look like. `stuck` is the case worth
     * showing loudly: the overlap guard is holding against a cycle that will
     * never return, so no post can go out until the lab is restarted.
     */
    health: {
      armed: boolean;
      intervalMs: number;
      lastStartedAt: number | null;
      lastFinishedAt: number | null;
      lastOutcome: string;
      runningSinceMs: number | null;
      stuck: boolean;
    };
    /**
     * Whether the composer flow was taught in the Skool Manager's teach console,
     * or is the built-in map of guessed selectors. The two click different
     * things and fail differently, so which one is about to run is worth saying
     * on screen rather than leaving to be inferred from a failure.
     */
    postRecipe: {
      taught: boolean;
      name: string;
      steps: number;
      placeholders: string[];
      missing: string[];
      fragileSteps: number;
      /** Typed fields recorded as click targets — a recipe that cannot run. */
      unclickableFields: string[];
    };
  }
>("skoolEngageStatus");

export const skoolEngageConfigure = endpoint<
  Partial<SkoolEngageSchedule>,
  { schedule: SkoolEngageSchedule }
>("skoolEngageConfigure");

/** Run one scheduler cycle now instead of waiting for the interval. */
export const skoolEngageTick = endpoint<
  void,
  {
    started: boolean;
    result: { enqueued: string | null; processed: string[]; skipped: string | null } | null;
    detail?: string;
  }
>("skoolEngageTick");

/** ⚠️ WRITES TO THE COMMUNITY. Publishes a slot that has been drafted and read. */
export const skoolEngagePublish = endpoint<
  { slotKey: string },
  { ok: boolean; detail: string }
>("skoolEngagePublish");

/** What it would write about next — without spending the window on a full draft. */
export const skoolEngageSubject = endpoint<
  void,
  { subject: string; error: string | null }
>("skoolEngageSubject");

export const skoolDraftPost = endpoint<
  { kind?: "lesson" | "mcp"; subject: string; category?: string },
  { draft: SkoolDraft | null; error: string | null }
>("skoolDraftPost");

/** ⚠️ WRITES TO THE COMMUNITY. Takes finished text, never a subject. */
export const skoolPublishPost = endpoint<
  { title: string; body: string; category?: string | null },
  { ok: boolean; detail: string; post: any | null }
>("skoolPublishPost");

/** Undo a focus, restoring the whole-catalogue report. */
export const clearAuditFocus = endpoint<{ runId: string }, { cleared: boolean; reason?: string }>("clearAuditFocus");
/** Named, reusable competitor sets — switchable per run, even for one channel. */
export const listAuditMarkets = endpoint<void, { markets: any[] }>("listAuditMarkets");
export const saveAuditMarket = endpoint<{ runId?: string; name: string; id?: string; niche?: string; competitors?: any[] }, { market: any }>("saveAuditMarket");
export const deleteAuditMarket = endpoint<{ id: string }, { deleted: boolean }>("deleteAuditMarket");
/** Did the rename work? Marking one applied captures the baseline it is judged against. */
export const markRenameApplied = endpoint<{ runId: string; videoId: string }, { applied: boolean; viewsAtApply: number }>("markRenameApplied");
export const unmarkRenameApplied = endpoint<{ runId: string; videoId: string }, { removed: boolean }>("unmarkRenameApplied");
export const checkAppliedRenames = endpoint<{ runId?: string }, { results: any[] }>("checkAppliedRenames");
export const getPlanRun = endpoint<{ runId: string }, PlanRunResult>("getPlanRun");
export const listPlanRuns = endpoint<Record<string, never>, { runs: PlanRunListItem[] }>("listPlanRuns");
export const deletePlanRun = endpoint<{ runId: string }, { ok: true }>("deletePlanRun");

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
export const cancelThumbnailJob =
  endpoint<{ jobId: string }, { cancelled: boolean; job: ThumbnailJobStatus | null }>("cancelThumbnailJob");
export const cancelAllThumbnailJobs =
  endpoint<Record<string, never>, { cancelled: number }>("cancelAllThumbnailJobs");
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
  /** True once the job was cancelled by the user. */
  cancelled?: boolean;
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
  /** The video's visual "look" group (from its filename); same-look posts are spaced apart. */
  groupId: string;
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
  /** The video's visual "look" group key (derived from its filename). */
  groupId: string;
  /** Local day ("YYYY-MM-DD") this video drops on across all accounts; null if fully de-duped. */
  dropDate: string | null;
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
  /** The seed that produced this plan — pass it back to reproduce, change it to reshuffle. */
  seed: number;
  /** How many distinct visual "looks" the selected videos span. */
  lookCount: number;
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

// ── Engagement Manager (LAB tool) ────────────────────────────────────────────
// Local mirrors of server/src/engage/types.ts (the frontend can't import server
// types — these are kept structurally identical so the page type-checks alone).
// Phase 1: MONITOR connected channels' comments/DMs into a single inbox.
export type EngagePlatform = "youtube" | "instagram" | "facebook" | "tiktok";
export type EngageInboxKind = "comment" | "dm";
export type EngageIngestSource = "api" | "browser-scrape";
/** Per-channel autonomy: off = don't reply, suggest = draft for approval, auto = send. */
export type EngageReplyMode = "off" | "suggest" | "auto";
/** Lifecycle of an inbound item's reply. */
export type EngageReplyState = "new" | "queued" | "replied" | "skipped" | "failed";

/** Rolled-up audience/engagement stats for a channel (populated by the backend poll). */
export interface ChannelStats {
  /** Subscribers (YouTube) / followers (everything else). */
  audience: number | null;
  comments: number | null;
  likes: number | null;
  updatedAt: number | null;
}

/** A monitored social channel (seeded from the connected Postiz/PostPeer channels). */
export interface EngageChannel {
  id: string;
  platform: EngagePlatform;
  externalId: string;
  handle: string | null;
  displayName: string | null;
  picture: string | null;
  enabled: boolean;
  replyMode: EngageReplyMode;
  /** Audience/engagement stats, or null until first fetched. */
  stats: ChannelStats | null;
  createdAt: number;
  updatedAt: number;
}

/** One inbound comment or DM we've seen. */
export interface InboxItem {
  id: string;
  channelId: string;
  platform: EngagePlatform;
  kind: EngageInboxKind;
  dedupKey: string;
  threadId: string | null;
  parentId: string | null;
  targetRef: string | null;
  targetTitle: string | null;
  authorName: string | null;
  authorHandle: string | null;
  authorId: string | null;
  text: string;
  permalink: string | null;
  /** When THEY posted it (platform timestamp, epoch-ms). */
  postedAt: number | null;
  /** When WE ingested it (epoch-ms). */
  ingestedAt: number;
  source: EngageIngestSource;
  replyState: EngageReplyState;
}

/** A generated/sent reply record (populated by later phases). */
export interface ReplyRecord {
  id: string;
  inboxId: string;
  channelId: string;
  platform: EngagePlatform;
  status: "pending" | "sent" | "failed" | "skipped";
  mechanism: "youtube-api" | "browser" | null;
  generatedText: string | null;
  decideReason: string | null;
  notBefore: number;
  attempts: number;
  externalReplyId: string | null;
  error: string | null;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

/** Live status for the UI (config + rolled-up counts). */
export interface EngageStatus {
  youtubeConfigured: boolean;
  channels: EngageChannel[];
  killSwitch: boolean;
  globalAutoreply: boolean;
  counts: {
    total: number;
    new: number;
    byPlatform: Partial<Record<EngagePlatform, number>>;
  };
  lastPollAt: number | null;
  polling: boolean;
  lastError: string | null;
}

export interface EngageListInboxInput {
  platform?: EngagePlatform;
  kind?: EngageInboxKind;
  replyState?: EngageReplyState;
  channelId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}
export interface EngageListInboxOutput {
  items: InboxItem[];
  total: number;
}
/** A top-level comment/DM plus its full reply tree, chronologically ordered. */
export interface InboxThread {
  root: InboxItem;
  replies: InboxItem[];
  replyCount: number;
  lastActivityAt: number | null;
}
/** Thread ordering: newest/oldest by the top-level comment's postedAt, most-active, or most-replied. */
export type EngageThreadSort = "newest" | "oldest" | "active" | "replies";
export interface EngageListThreadsInput {
  channelId?: string;
  platform?: EngagePlatform;
  kind?: EngageInboxKind;
  q?: string;
  sort?: EngageThreadSort;
  limit?: number;
  offset?: number;
}
export interface EngageListThreadsOutput {
  threads: InboxThread[];
  total: number;
}
export interface EngageGetThreadOutput {
  item: InboxItem | null;
  thread: InboxItem[];
  reply: ReplyRecord | null;
}
export interface EngageSetChannelModeInput {
  channelId: string;
  enabled?: boolean;
  replyMode?: EngageReplyMode;
}

export const engageStatus = endpoint<Record<string, never>, EngageStatus>("engageStatus");
export const engageListInbox =
  endpoint<EngageListInboxInput, EngageListInboxOutput>("engageListInbox");
export const engageListThreads =
  endpoint<EngageListThreadsInput, EngageListThreadsOutput>("engageListThreads");
export const engageGetThread =
  endpoint<{ inboxId: string }, EngageGetThreadOutput>("engageGetThread");
export const engageSetChannelMode =
  endpoint<EngageSetChannelModeInput, EngageChannel>("engageSetChannelMode");
export const engageKillSwitch =
  endpoint<{ killSwitch: boolean }, { killSwitch: boolean }>("engageKillSwitch");
export const engageRefreshChannels =
  endpoint<Record<string, never>, { channels: EngageChannel[] }>("engageRefreshChannels");
export const engagePollNow =
  endpoint<Record<string, never>, { started: boolean; message?: string }>("engagePollNow");
/**
 * Optional: refresh per-channel audience/engagement stats. The backend handler
 * may not exist yet — callers should treat a rejection as a graceful no-op.
 */
export const engageRefreshStats =
  endpoint<Record<string, never>, { channels: EngageChannel[] }>("engageRefreshStats");

// ── Engagement Manager — replies + browser console (LAB tool, Phase 3) ───────
// Local mirrors of server/src/engage/types.ts (the frontend can't import server
// types — kept structurally identical so the page type-checks alone).

export type EngageReplyStatus = "draft" | "pending" | "sent" | "failed" | "skipped";

export interface EngageReplyRecord {
  id: string;
  inboxId: string;
  channelId: string;
  platform: EngagePlatform;
  status: EngageReplyStatus;
  mechanism: "youtube-api" | "browser" | null;
  generatedText: string | null;
  decideReason: string | null;
  notBefore: number;
  attempts: number;
  externalReplyId: string | null;
  error: string | null;
  costUsd: number;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export interface EngageReplyQueueEntry {
  reply: EngageReplyRecord;
  item: InboxItem | null;
}

export interface EngagePacing {
  minDelaySec: number;
  maxDelaySec: number;
  activeHours: [number, number];
}

export interface EngageThrottleUsage {
  platform: EngagePlatform;
  hour: { used: number; cap: number };
  day: { used: number; cap: number };
}

export interface EngageBrowserStatusEntry {
  platform: EngagePlatform;
  available: boolean;
  open: boolean;
  loggedIn: boolean | null;
  url: string | null;
  error: string | null;
  checkedAt: number | null;
}

export interface EngageReplyStatusOutput {
  killSwitch: boolean;
  globalAutoreply: boolean;
  replyPromptSet: boolean;
  aiConfigured: boolean;
  dryRun: boolean;
  pacing: EngagePacing;
  usage: EngageThrottleUsage[];
  browsers: EngageBrowserStatusEntry[];
  counts: { draft: number; pending: number; sent: number; failed: number; skipped: number };
}

export interface EngageBrowserFrame {
  image: string | null;
  url: string | null;
  error: string | null;
  width: number;
  height: number;
}

export const engageReplyStatus =
  endpoint<Record<string, never>, EngageReplyStatusOutput>("engageReplyStatus");
export const engageListReplies =
  endpoint<
    { status?: EngageReplyStatus; platform?: EngagePlatform; channelId?: string; limit?: number; offset?: number },
    { entries: EngageReplyQueueEntry[]; total: number }
  >("engageListReplies");
export const engageGetReplyPrompt =
  endpoint<Record<string, never>, { replyPromptMd: string }>("engageGetReplyPrompt");
export const engageUpdateSettings =
  endpoint<
    {
      replyPromptMd?: string;
      globalAutoreply?: boolean;
      caps?: Partial<Record<EngagePlatform, { hour: number; day: number }>>;
      pacing?: EngagePacing;
    },
    { globalAutoreply: boolean; pacing: EngagePacing; caps: Record<string, { hour: number; day: number }>; replyPromptSet: boolean }
  >("engageUpdateSettings");
export const engageDraftReply =
  endpoint<{ inboxId: string; regenerate?: boolean }, { reply: EngageReplyRecord }>("engageDraftReply");
/**
 * Send one reply immediately, on the operator's say-so. Unlike approve, this
 * dispatches inline — no pacing, no kill-switch, no dry run — and reports what
 * actually happened.
 */
export const engageSendReply =
  endpoint<
    { replyId?: string; inboxId?: string; text?: string },
    { reply: EngageReplyRecord | null; ok: boolean; error: string | null; mechanism: string | null }
  >("engageSendReply");
export const engageApproveReply =
  endpoint<
    { replyId: string; text?: string; now?: boolean },
    { reply: EngageReplyRecord | null; willSend: boolean; holdReason: string | null }
  >("engageApproveReply");
export const engageRejectReply =
  endpoint<{ replyId: string; reason?: string }, { reply: EngageReplyRecord | null }>("engageRejectReply");
export const engageReplyCycleNow =
  endpoint<Record<string, never>, { started: boolean; message?: string; lastError: string | null }>(
    "engageReplyCycleNow",
  );

// Browser login console.
export const engageBrowserStatus =
  endpoint<Record<string, never>, { sessions: EngageBrowserStatusEntry[] }>("engageBrowserStatus");
export const engageBrowserOpen =
  endpoint<{ platform: EngagePlatform }, { status: EngageBrowserStatusEntry; frame: EngageBrowserFrame }>(
    "engageBrowserOpen",
  );
export const engageBrowserFrame =
  endpoint<{ platform: EngagePlatform }, { frame: EngageBrowserFrame }>("engageBrowserFrame");
export const engageBrowserClick =
  endpoint<{ platform: EngagePlatform; xFrac: number; yFrac: number }, { frame: EngageBrowserFrame }>(
    "engageBrowserClick",
  );
export const engageBrowserType =
  endpoint<{ platform: EngagePlatform; text: string }, { frame: EngageBrowserFrame }>("engageBrowserType");
export const engageBrowserKey =
  endpoint<{ platform: EngagePlatform; key: string }, { frame: EngageBrowserFrame }>("engageBrowserKey");
export const engageBrowserScroll =
  endpoint<{ platform: EngagePlatform; dy: number }, { frame: EngageBrowserFrame }>("engageBrowserScroll");
export const engageBrowserDrag =
  endpoint<
    { platform: EngagePlatform; fromXFrac: number; fromYFrac: number; toXFrac: number; toYFrac: number },
    { frame: EngageBrowserFrame }
  >("engageBrowserDrag");
export const engageBrowserNavigate =
  endpoint<{ platform: EngagePlatform; url: string }, { frame: EngageBrowserFrame }>("engageBrowserNavigate");
export const engageBrowserVerify =
  endpoint<{ platform: EngagePlatform }, { status: EngageBrowserStatusEntry }>("engageBrowserVerify");
export const engageBrowserImportCookies =
  endpoint<
    { platform: EngagePlatform; cookies: string },
    { status: EngageBrowserStatusEntry; imported: number; skipped: number }
  >("engageBrowserImportCookies");
export const engageBrowserClose =
  endpoint<{ platform: EngagePlatform }, { ok: true }>("engageBrowserClose");

// ── Avatar Narrator (LAB tool) ───────────────────────────────────────────────
// Synthetic-presenter talking-head videos: a locked portrait + TTS driven
// through an audio-driven lipsync model (InfiniteTalk on kie.ai by default).

export type AvatarProviderId = "segmind" | "seedance" | "kie" | "wavespeed" | "selfhost";
export type AvatarResolution = "480p" | "720p";
export type TtsProviderId = "segmind" | "gemini" | "elevenlabs";
export type AvatarVideoState =
  | "queued" | "voicing" | "rendering" | "stitching" | "done" | "failed" | "canceled";

export interface AvatarVoiceOption { id: string; label: string; hint: string }

export interface AvatarPersona {
  id: string;
  name: string;
  lookPrompt: string;
  scenePrompt: string;
  portraitFile: string;
  portraitMime: string;
  ttsProvider: TtsProviderId;
  ttsVoice: string;
  /** The clip the voice was cloned from — the part of the voice you own. */
  voiceSampleFile: string;
  /** Room plate this persona is filmed in, or "" for none. */
  roomId: string;
  /** Character sheet on disk, or "" if one has never been made. */
  sheetFile: string;
  createdAt: number;
  portraitUrl: string;
  voiceSampleUrl: string | null;
  sheetUrl: string | null;
}

export interface AvatarSegment {
  id: string;
  videoId: string;
  idx: number;
  text: string;
  seconds: number;
  status: "pending" | "voicing" | "submitted" | "done" | "failed";
  providerTask: string | null;
  costUsd: number;
  error: string | null;
}

export interface AvatarVideo {
  id: string;
  personaId: string;
  personaName: string;
  title: string;
  script: string;
  status: AvatarVideoState;
  phase: string;
  progress: number;
  provider: AvatarProviderId;
  resolution: AvatarResolution;
  audioSeconds: number;
  costUsd: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  audioUrl: string | null;
  videoUrl: string | null;
  segments: AvatarSegment[];
}

export interface AvatarCostEstimate {
  seconds: number;
  segments: number;
  videoUsd: number;
  ttsUsd: number;
  totalUsd: number;
  perMinuteUsd: number;
}

/** How the footage was captured — the biggest single realism lever. */
export interface AvatarMedium { id: string; label: string; hint: string }

/** A complete starting character plus the medium it was designed for. */
export interface AvatarLookPreset {
  id: string;
  label: string;
  hint: string;
  mediumId: string;
  voice: string;
  /** The character spec rendered as prompt text — editable before generating. */
  description: string;
}

export const avatarStatus = endpoint<
  Record<string, never>,
  {
    providers: { id: AvatarProviderId; label: string; configured: boolean }[];
    ttsConfigured: Record<TtsProviderId, boolean>;
    geminiVoices: AvatarVoiceOption[];
    publicBaseUrlConfigured: boolean;
    defaultScenePrompt: string;
    /** The paragraph a voice is auditioned with — editable in the UI. */
    auditionText: string;
    voiceSettings: AvatarVoiceSettings;
    voiceModels: { id: string; label: string; hint: string }[];
    mediums: AvatarMedium[];
    /** How much of the person is in frame — decides whether they can gesture. */
    framings: AvatarMedium[];
    presets: AvatarLookPreset[];
    personas: AvatarPersona[];
    totalSpendUsd: number;
  }
>("avatarStatus");

export const avatarEstimate = endpoint<
  { script: string; provider: AvatarProviderId; resolution: AvatarResolution; tts: TtsProviderId; segmentSeconds: number },
  AvatarCostEstimate
>("avatarEstimate");

export const avatarPreviewPortrait = endpoint<
  {
    description?: string;
    aspect?: string;
    model?: string;
    /** Capture medium id. Omit to inherit the preset's, or fall back to the default. */
    mediumId?: string;
    framingId?: string;
    /** Start from a built-in look; `description` overrides it when both are sent. */
    presetId?: string;
    /** Fixed set to generate them into. Overrides mediumId/framingId entirely. */
    roomId?: string;
  },
  { file: string; url: string; mime: string; prompt: string }
>("avatarPreviewPortrait");

export const avatarCreatePersona = endpoint<
  {
    name: string;
    file: string;
    lookPrompt: string;
    scenePrompt: string;
    ttsProvider: TtsProviderId;
    ttsVoice: string;
    /** Basename of the archived voice sample, from avatarCloneVoice. */
    voiceSampleFile?: string;
    /** Room the portrait was made in — every video returns to it. */
    roomId?: string;
  },
  { persona: AvatarPersona }
>("avatarCreatePersona");

/**
 * Build (or rebuild) a persona's 20-view character sheet.
 *
 * The sheet is what lets the SAME face survive a change of room: one portrait
 * shows one angle, so a placement has to invent the rest, and inventing is
 * where a face drifts into someone else.
 */
export const avatarCharacterSheet = endpoint<
  { personaId: string },
  { persona: AvatarPersona; sheetUrl: string }
>("avatarCharacterSheet");

/**
 * Put a saved persona into a room. Returns a PREVIEW in the same shape as
 * avatarPreviewPortrait, so it can be re-rolled and then locked in as its own
 * persona rather than overwriting the one it came from.
 */
export const avatarPlaceInRoom = endpoint<
  { personaId: string; roomId: string },
  { file: string; url: string; mime: string; prompt: string; usedSheet: boolean; roomId: string }
>("avatarPlaceInRoom");

/**
 * Improve an existing roll. `instruction` is plain language ("warmer light",
 * "a little older") — the server composes the edit prompt, most of which is
 * spent forbidding the model from returning a different person.
 */
export const avatarEditPortrait = endpoint<
  { file: string; instruction: string; aspect?: string; mediumId?: string; quality?: string },
  { file: string; url: string; mime: string; prompt: string }
>("avatarEditPortrait");

export interface AvatarVoiceSample {
  file: string;
  url: string;
  createdAt: number;
  bytes: number;
  /** Length of the clip. What you compare voices on — bytes is noise. */
  seconds: number;
  inUse: boolean;
  /** Present for DESIGNED voices — the id that can still be spoken with. */
  voiceId: string | null;
  label: string;
  kind: "designed" | "sample";
}

/**
 * Past voice samples, newest first. Designed voices carry their `voiceId`, so a
 * design survives a refresh as a usable voice rather than just a recording.
 */
export const avatarListVoiceSamples = endpoint<{ limit?: number }, { samples: AvatarVoiceSample[] }>(
  "avatarListVoiceSamples",
);

export const avatarDeleteVoiceSample = endpoint<{ file: string }, { deleted: boolean }>("avatarDeleteVoiceSample");

export interface AvatarPortraitRoll {
  file: string;
  url: string;
  createdAt: number;
  bytes: number;
  /** True when a persona is already built on this face. */
  inUse: boolean;
}

/**
 * Every portrait rolled so far, newest first. Rolls cost money and 90 seconds,
 * so they outlive the page rather than living only in React state.
 */
export const avatarListPortraits = endpoint<{ limit?: number }, { portraits: AvatarPortraitRoll[] }>(
  "avatarListPortraits",
);

export const avatarDeletePortrait = endpoint<{ file: string }, { deleted: boolean }>("avatarDeletePortrait");

/** Roll a candidate voice — the audio equivalent of rolling a portrait. */
export interface AvatarVoiceSettings {
  model: string;
  speed: number;
  stability: number;
  similarityBoost: number;
  style: number;
  speakerBoost: boolean;
}

export const avatarPreviewVoice = endpoint<
  { text?: string; ttsProvider?: TtsProviderId; voice?: string; settings?: Partial<AvatarVoiceSettings> },
  { file: string; url: string; seconds: number; costUsd: number; text: string }
>("avatarPreviewVoice");

/**
 * Design a voice that does not exist yet, from a description. Cloning copies a
 * voice that already exists; this invents one. The clip is archived either way.
 */
export const avatarDesignVoice = endpoint<
  { description: string; text?: string },
  { file: string; url: string; seconds: number; voiceId: string | null }
>("avatarDesignVoice");

/**
 * Clone a voice from a sample and get the id to put on a persona. Pass `file`
 * for a sample this tool generated, or `sampleBase64` for one you recorded.
 * The sample is archived either way — the cloned model cannot be exported, so
 * the clip is the part of the voice you actually own.
 */
export const avatarCloneVoice = endpoint<
  { name: string; file?: string; sampleBase64?: string; sampleMime?: string; description?: string },
  { voiceId: string; sampleFile: string; sampleUrl: string }
>("avatarCloneVoice");

export const avatarUpdatePersona = endpoint<
  { id: string; name?: string; scenePrompt?: string; ttsProvider?: string; ttsVoice?: string },
  { persona: AvatarPersona }
>("avatarUpdatePersona");

export const avatarDeletePersona = endpoint<{ id: string }, { deleted: boolean }>("avatarDeletePersona");

export const avatarStartVideo = endpoint<
  {
    personaId: string;
    title: string;
    script: string;
    provider: AvatarProviderId;
    resolution: AvatarResolution;
    segmentSeconds: number;
    seed?: number;
  },
  { videoId: string }
>("avatarStartVideo");

export const avatarVideoStatus = endpoint<{ videoId: string }, { video: AvatarVideo }>("avatarVideoStatus");
export const avatarListVideos = endpoint<{ limit?: number }, { videos: AvatarVideo[]; totalSpendUsd: number }>("avatarListVideos");
export const avatarCancelVideo = endpoint<{ videoId: string }, { canceled: boolean }>("avatarCancelVideo");

/**
 * Retry a failed render. RESUMES rather than restarts — narration already paid
 * for is reused, and accepted provider jobs keep their ids.
 */
export const avatarRetryVideo = endpoint<{ videoId: string }, { retried: boolean }>("avatarRetryVideo");
export const avatarDeleteVideo = endpoint<{ videoId: string }, { deleted: boolean }>("avatarDeleteVideo");
