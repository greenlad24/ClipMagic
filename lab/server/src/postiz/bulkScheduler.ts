/**
 * Bulk Scheduler orchestration — the glue between the Postiz client, the caption
 * engine, the scheduling engine and the file-source bridge. Kept out of the big
 * endpoints.ts so the handlers stay thin (they just call into here).
 *
 * Flow:
 *   - status()   → is the API key set + how many channels are connected.
 *   - channels() → connected, short-form-relevant integrations.
 *   - preview()  → for each (file × connected platform): caption + hashtags +
 *                  scheduledAt + reason. NO posting.
 *   - schedule() → upload each file's media to Postiz, then createPost per item.
 *                  Returns per-item success/failure; never silently drops a file.
 */
import { listStorage } from "../zite/storage.js";
import { Projects } from "../zite/store.js";
import {
  createPostizClient,
  postizApiConfigured,
  PostizApiError,
  type PostizIntegration,
} from "./client.js";
import {
  createPostPeerClient,
  postPeerApiConfigured,
  PostPeerApiError,
  type PostPeerAccount,
  type PostPeerTikTokOptions,
} from "./postpeerClient.js";
import { toShortPlatform, buildProviderSettings, type ShortPlatform } from "./providerSettings.js";
import { generateCaptions, scoreCaption, scoreChecks, CTA_KEYWORD, type PlatformCaption, type CaptionPlatform } from "./captions.js";
import { buildSchedule, type Intent, type ScheduleItemInput, type ChannelStartState } from "./scheduling.js";
import {
  sequenceDrops,
  groupKeyForFilename,
  countLooks,
  rampPeakPerDay,
  rampRampUpDays,
  WARM_UP_RAMP,
  type CadencePhase,
  type DropFile,
} from "./dropSequencing.js";
import { POSITION_UNKNOWN } from "./renderPosition.js";
import { loadRenderPositions } from "./renderPositionStore.js";
import { getChannelState, recordScheduled, deriveChannelTimeline } from "./scheduleLedger.js";
import { getCaptions as getCachedCaptions, putCaption as putCachedCaption } from "../db/bulkPreview.js";
import { resolveSourceUrl, resolvePublicSourceUrl, resolveLocalPath, filenameFor, type FileSourceRef } from "./fileSources.js";
import { preflightVideo, type ProbeFn } from "./preflight.js";
import { isYouTubePost, youtubeShortsGate } from "./youtubeGate.js";
import { rendersToAutoHide, setRendersHidden } from "./hiddenRenders.js";
import { createTranscriptionCache, type TranscribeSourceDeps } from "./transcription.js";
import { readFile } from "node:fs/promises";
import { stripGrowthCta, stripAiTells, ctaSuppressedFileIds } from "./captionVoice.js";

/** Which API a channel posts through. */
export type Provider = "postiz" | "postpeer";

/** Sensible TikTok Direct-Post defaults (public, all interactions on, not commercial). */
export const DEFAULT_TIKTOK_OPTIONS: PostPeerTikTokOptions = {
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
  commercialContent: false,
};

// ── Growth Guardrails (per-post score = caption + pre-flight, merged) ─────────
// The combined check carries the union severity ("unknown" comes only from
// pre-flight). A `required` failure GATES scheduling (see schedule()); a
// `recommended`/`unknown` check never blocks — it only lowers the score.
export type GrowthSeverity = "required" | "recommended" | "unknown";

export interface GrowthCheckDto {
  id: string;
  label: string;
  /** null when unmeasured (pre-flight `unknown` checks). */
  pass: boolean | null;
  severity: GrowthSeverity;
  hint: string;
}

export interface GrowthDto {
  /** 0..100 combined Growth Score (caption + measured pre-flight checks). */
  score: number;
  checks: GrowthCheckDto[];
}

/**
 * Merge a caption score (always measured) with a pre-flight result (may contain
 * `unknown` checks) into ONE Growth result. The combined score weighs every
 * MEASURED check with the shared scoreChecks() weighting; `unknown` checks are
 * excluded from the score but kept in the list so the UI can show them as
 * advisory. PURE + exported so the gating + scoring is unit-tested.
 */
export function combineGrowth(
  captionChecks: GrowthCheckDto[],
  preflightChecks: GrowthCheckDto[],
): GrowthDto {
  const checks = [...captionChecks, ...preflightChecks];
  const measured = checks
    .filter((c) => c.severity !== "unknown" && c.pass !== null)
    .map((c) => ({ id: c.id, label: c.label, pass: c.pass === true, severity: c.severity as "required" | "recommended", hint: c.hint }));
  return { score: scoreChecks(measured), checks };
}

/** True when a Growth result has at least one MEASURED, FAILING required check. */
export function hasBlockingFailure(growth: GrowthDto): boolean {
  return growth.checks.some((c) => c.severity === "required" && c.pass === false);
}

// ── status / channels ────────────────────────────────────────────────────────
/**
 * Status is provider-aware: each posting provider (Postiz, PostPeer) reports its
 * own configured-boolean + channel count, and the channels list is the UNION of
 * both. `apiKeyConfigured` stays for backward-compat = "any provider configured".
 */
export interface ProviderStatus {
  configured: boolean;
  channelCount: number;
  /** Set when configured but the provider's API was unreachable / key invalid. */
  error?: string;
}

export async function getStatus(): Promise<{
  apiKeyConfigured: boolean;
  channelCount: number;
  channels: ChannelDto[];
  providers: { postiz: ProviderStatus; postpeer: ProviderStatus };
  /** The comment keyword captions ask for, so the review step can check for it. */
  ctaKeyword: string;
  error?: string;
}> {
  const [postiz, postpeer] = await Promise.all([listPostizChannels.safe(), listPostPeerChannels.safe()]);
  const channels = [...postiz.channels, ...postpeer.channels];
  const providers = {
    postiz: { configured: postizApiConfigured(), channelCount: postiz.channels.length, error: postiz.error },
    postpeer: { configured: postPeerApiConfigured(), channelCount: postpeer.channels.length, error: postpeer.error },
  };
  // First provider error (if any) surfaces as the top-level error for older UIs.
  const error = postiz.error || postpeer.error;
  return {
    apiKeyConfigured: providers.postiz.configured || providers.postpeer.configured,
    channelCount: channels.length,
    ctaKeyword: CTA_KEYWORD,
    channels,
    providers,
    ...(error ? { error } : {}),
  };
}

export interface ChannelDto {
  id: string;
  /** Which API this channel posts through. */
  provider: Provider;
  name: string;
  identifier: string;
  /** Our canonical short-form platform, or null if not a tuned short platform. */
  platform: ShortPlatform | null;
  picture?: string;
  profile?: string;
}

function postizToChannelDto(it: PostizIntegration): ChannelDto {
  return {
    id: it.id,
    provider: "postiz",
    name: it.name,
    identifier: it.identifier,
    platform: toShortPlatform(it.identifier),
    picture: it.picture,
    profile: it.profile,
  };
}

function postPeerToChannelDto(a: PostPeerAccount): ChannelDto {
  // PostPeer accounts we surface are TikTok only (filtered below).
  return {
    id: a.id,
    provider: "postpeer",
    name: a.name || a.username || a.id,
    identifier: a.platform,
    platform: toShortPlatform(a.platform),
    picture: a.picture,
    profile: a.username,
  };
}

/** Connected (non-disabled) Postiz channels. */
async function fetchPostizChannels(): Promise<ChannelDto[]> {
  if (!postizApiConfigured()) return [];
  const client = createPostizClient();
  const integrations = await client.listIntegrations();
  return integrations.filter((i) => !i.disabled).map(postizToChannelDto);
}

/** Connected PostPeer TikTok accounts. */
async function fetchPostPeerChannels(): Promise<ChannelDto[]> {
  if (!postPeerApiConfigured()) return [];
  const client = createPostPeerClient();
  const accounts = await client.listAccounts();
  return accounts.filter((a) => a.platform === "tiktok").map(postPeerToChannelDto);
}

/** Wrap a channel fetch so one provider's failure never hides the other's. */
function withSafe(fetch: () => Promise<ChannelDto[]>) {
  return {
    fetch,
    async safe(): Promise<{ channels: ChannelDto[]; error?: string }> {
      try {
        return { channels: await fetch() };
      } catch (e) {
        return { channels: [], error: errMsg(e) };
      }
    },
  };
}

const listPostizChannels = withSafe(fetchPostizChannels);
const listPostPeerChannels = withSafe(fetchPostPeerChannels);

/** Connected channels across BOTH providers (degrades to whichever is configured). */
export async function listChannels(): Promise<ChannelDto[]> {
  const [postiz, postpeer] = await Promise.all([listPostizChannels.safe(), listPostPeerChannels.safe()]);
  return [...postiz.channels, ...postpeer.channels];
}

// ── preview ──────────────────────────────────────────────────────────────────
export interface PreviewFileInput {
  /** Where the media comes from (render/upload/cloud). */
  source: FileSourceRef;
  /** User (or auto-seeded) brief / topic. */
  brief?: string;
  /** Stable id for this file in the UI (defaults to source.ref). */
  fileId?: string;
  /** Display label for the UI. */
  label?: string;
}

/** Cadence shape for a campaign: flat, or the new-account warm-up ramp. */
export type CadenceMode = "steady" | "warmup";

/** The ramp a mode runs on — `null` for "steady", which uses a flat cadence. */
export function rampForMode(mode: CadenceMode): readonly CadencePhase[] | null {
  return mode === "warmup" ? WARM_UP_RAMP : null;
}

export interface PreviewInput {
  files: PreviewFileInput[];
  /** Channel ids to target (must be currently connected). */
  channelIds: string[];
  intent?: Intent;
  timezone?: string;
  /** ISO string; defaults to server now. Lets the UI/tests pin "now". */
  now?: string;
  /** Max posts per channel per day (default 2). Continuity tops up partial days. */
  maxPerDay?: number;
  /**
   * How many DROPS (distinct videos) to release per day — each drop goes to all
   * selected accounts within the same 24h. Preferred over `maxPerDay`; when both
   * are set, this wins. Default 2.
   */
  videosPerDay?: number;
  /**
   * Minimum whole days between two videos of the SAME visual "look" (grouped by
   * filename). 0 = no spacing. Default 3 ("a look at most once every 3 days").
   */
  minGapDays?: number;
  /**
   * How the cadence behaves over the life of the campaign.
   *   - "steady"  (default) — `videosPerDay` every day, the original behavior.
   *   - "warmup"  — ramp up from a new account's standing start: 3 drops a week
   *     for 4 weeks, then 1/day for 4 weeks, then 2/day (see WARM_UP_RAMP).
   *     `videosPerDay` is ignored; the ramp decides every day's capacity.
   */
  cadenceMode?: CadenceMode;
  /**
   * Shuffle seed for the look-mixing + minute jitter. Same seed → same plan; a new
   * seed reshuffles. Default 1 (stable) so callers/tests are reproducible.
   */
  seed?: number;
  /**
   * An explicit drop order (fileIds), as produced by `randomizeOrder`. When the
   * UI's Randomize button has arranged the picked videos, it sends that exact
   * arrangement so the plan is the order the user was shown — not a second,
   * differently-seeded mix. Omit it and the seeded interleave runs as before.
   */
  fileOrder?: string[];
}

export interface PreviewPostDto {
  fileId: string;
  channelId: string;
  /** Which API this post routes through (postiz | postpeer). */
  provider: Provider;
  channelName: string;
  identifier: string;
  /** Effective caption/timing platform — "generic" for null-platform channels. */
  platform: CaptionPlatform;
  caption: string;
  firstLineHook: string;
  hashtags: string[];
  scheduledAt: string;
  reason: string;
  /** The video's visual "look" group (from its filename); posts of one look are spaced apart. */
  groupId: string;
  /**
   * This post deliberately ships WITHOUT the comment-keyword CTA — warm-up
   * weeks 1–4. The review step must not offer to "fix" it back in.
   */
  ctaSuppressed?: boolean;
  /** TikTok Direct-Post options (postpeer/tiktok only); defaults applied. */
  tiktok?: PostPeerTikTokOptions;
  /** Growth Guardrails: combined caption + pre-flight score + checklist. */
  growth: GrowthDto;
}

/** Max transcript chars surfaced to the UI per file (display, not the prompt). */
const MAX_TRANSCRIPT_PREVIEW_CHARS = 2000;

/** What the captions for one file were grounded in (shown in the review step). */
export interface PreviewFileDto {
  fileId: string;
  /**
   * The transcript the captions were generated from, trimmed for display. null
   * when no speech was detected / transcription was unavailable — the captions
   * then fell back to the brief/metadata.
   */
  transcript: string | null;
  /** The video's visual "look" group key (derived from its filename). */
  groupId: string;
  /** Local day ("YYYY-MM-DD") this video drops on across all accounts; null if fully de-duped. */
  dropDate: string | null;
}

/** One (file × channel) pair dropped from the plan because the ledger already has it. */
export interface SkippedPostDto {
  fileId: string;
  channelId: string;
  /** Human label for the channel (so the UI doesn't have to re-resolve it). */
  channelName: string;
  reason: string;
}

export interface PreviewOutput {
  posts: PreviewPostDto[];
  /** Per-file transcript surfaced so the UI can show what captions are based on. */
  files: PreviewFileDto[];
  /** Channels that were requested but skipped (not connected / not short-form). */
  skippedChannels: Array<{ id: string; reason: string }>;
  /**
   * (file × channel) posts DROPPED as de-duplicates — already scheduled to that
   * channel by this tool (recorded in the ledger). Surfaced so the UI can show
   * an "already scheduled — skipped" note rather than silently dropping them.
   */
  skippedPosts: SkippedPostDto[];
  /**
   * Per-channel continuity hint: the local day a channel's NEW posts continue
   * from when the ledger pushed them past `now` (so the UI can say "continuing
   * your queue from <date>"). Only channels that were actually pushed appear.
   */
  continuedFrom: Array<{ channelId: string; channelName: string; fromLocalDay: string }>;
  /** The seed that produced this plan (echo it back to `preview` to reproduce; change it to reshuffle). */
  seed: number;
  /** The cadence shape this plan was built with (so the review step can say so). */
  cadenceMode: CadenceMode;
  /** How many distinct visual "looks" the selected videos span (UI hint). */
  lookCount: number;
}

/** How many videos are transcribed at once (download + ffmpeg each). */
const TRANSCRIBE_CONCURRENCY = Number.parseInt(process.env.BULK_TRANSCRIBE_CONCURRENCY || "4", 10);

/** How many caption calls are in flight at once. */
const CAPTION_CONCURRENCY = Number.parseInt(process.env.BULK_CAPTION_CONCURRENCY || "5", 10);

/** Progress ticks for a background plan build. */
export interface PreviewProgress {
  stage: string;
  done: number;
  total: number;
  cached: number;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Order of completion is
 * irrelevant here — every result is written into a Map keyed by file.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit || 1, items.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    }),
  );
}

export async function preview(
  input: PreviewInput,
  opts: {
    transcribeDeps?: TranscribeSourceDeps;
    /** Called as the plan progresses, for the background run record. */
    onProgress?: (p: PreviewProgress) => void;
  } = {},
): Promise<PreviewOutput> {
  const now = input.now ? new Date(input.now) : new Date();
  const channels = await listChannels();
  const byId = new Map(channels.map((c) => [c.id, c]));

  // Resolve target channels. A channel with a tuned short platform keeps it; a
  // null-platform channel (e.g. a Facebook Page) is targeted as "generic" rather
  // than skipped. Only genuinely unknown channel ids are dropped.
  const targets: Array<{ channel: ChannelDto; plat: CaptionPlatform }> = [];
  const skippedChannels: Array<{ id: string; reason: string }> = [];
  for (const id of input.channelIds) {
    const c = byId.get(id);
    if (!c) {
      skippedChannels.push({ id, reason: "Not a connected channel" });
      continue;
    }
    targets.push({ channel: c, plat: c.platform ?? "generic" });
  }

  // What must not repeat back-to-back is the SHOOTING POSITION: clips shot in one
  // setup look near-identical in the feed. A server render carries no position in
  // its (nanoid) filename, so it is recovered through the project that made it
  // (see renderPosition.ts); everything else keeps the filename-derived look, and
  // renders whose position can't be recovered share one POSITION_UNKNOWN group so
  // a run of them can't post consecutively either.
  //
  // The multi-day spacing rule stays on the filename look (`spacingId`) — see the
  // note on DropFile for why merging the two would blow the plan out to months.
  const positions = renderPositions();
  const files = input.files.map((f, i) => {
    const lookKey = groupKeyForFilename(f.label || f.source.ref) || `file-${i}`;
    const groupId =
      f.source.kind === "render" ? positions.get(f.source.ref) ?? POSITION_UNKNOWN : lookKey;
    return {
      ...f,
      fileId: f.fileId || `${f.source.kind}:${f.source.ref}` || `file-${i}`,
      groupId,
      spacingId: lookKey,
    };
  });
  const groupByFile = new Map(files.map((f) => [f.fileId, f.groupId]));

  // 1) Transcribe each file FIRST (in parallel across files, cached per resolved
  // file so we never transcribe the same video twice). Transcription NEVER throws
  // — a missing key / no speech / ffmpeg-or-download failure / timeout yields null
  // and that file simply falls back to its brief. One file's failure can't kill
  // the batch.
  const platformsNeeded = unique(targets.map((t) => t.plat));

  // 0) REUSE. A caption describes the VIDEO, not when it is posted, so a file
  // that already has captions and tags for every platform we need is finished
  // work: no transcription, no AI call, straight through to scheduling. Only
  // the remainder is built below. (Re-write one with clearBulkCaptions.)
  const captionsByFile = new Map<string, Record<CaptionPlatform, PlatformCaption>>();
  const transcriptByFile = new Map<string, string | null>();
  const todo: typeof files = [];
  for (const f of files) {
    const cached = getCachedCaptions(f.fileId);
    const complete = platformsNeeded.every((p) => cached.has(p));
    if (!complete) {
      todo.push(f);
      continue;
    }
    const caps = {} as Record<CaptionPlatform, PlatformCaption>;
    for (const p of platformsNeeded) {
      const c = cached.get(p)!;
      caps[p] = {
        platform: p,
        caption: c.caption,
        hashtags: c.hashtags,
        firstLineHook: c.firstLineHook,
      };
    }
    captionsByFile.set(f.fileId, caps);
    transcriptByFile.set(f.fileId, cached.get(platformsNeeded[0])?.transcript ?? null);
  }
  opts.onProgress?.({ stage: "reusing captions", done: files.length - todo.length, total: files.length, cached: files.length - todo.length });

  // 1) Transcribe what is left (in parallel across files, cached per resolved
  // file so we never transcribe the same video twice). Transcription NEVER throws
  // — a missing key / no speech / ffmpeg-or-download failure / timeout yields null
  // and that file simply falls back to its brief. One file's failure can't kill
  // the batch.
  const transcriber = createTranscriptionCache(opts.transcribeDeps);
  if (todo.length) {
    opts.onProgress?.({ stage: `transcribing ${todo.length}`, done: files.length - todo.length, total: files.length, cached: files.length - todo.length });
  }
  // Bounded, NOT Promise.all over everything: each transcription downloads the
  // video and runs ffmpeg, so firing 227 at once took this 4-core box to a load
  // average of 26 and the server stopped answering long enough for a poll to
  // come back 502 (2026-08-24). The work is the same; it just arrives in order.
  await mapWithConcurrency(todo, TRANSCRIBE_CONCURRENCY, async (f) => {
    const tr = await transcriber.get(f.source);
    transcriptByFile.set(f.fileId, tr?.text ?? null);
  });

  // 2) Captions: one AI call per file, covering all distinct target platforms,
  // grounded in the transcript when we have one (brief is supplementary context).
  //
  // Run a few at a time rather than strictly one after another: this loop was
  // the whole cost of a large plan (227 files took 31 minutes serially). The cap
  // is deliberately small — these are the same AI account the rest of the suite
  // uses, and a burst of 227 is how an account gets rate-limited.
  const cachedCount = files.length - todo.length;
  let captioned = 0;
  await mapWithConcurrency(todo, CAPTION_CONCURRENCY, async (f) => {
    const brief = (f.brief ?? "").trim() || (await autoSeedBrief(f.source));
    const transcript = transcriptByFile.get(f.fileId) ?? undefined;
    const caps = await generateCaptions(brief, platformsNeeded, { transcript });
    captionsByFile.set(f.fileId, caps);
    // Persist immediately: a plan that dies later must not throw away calls
    // that have already been paid for.
    for (const p of platformsNeeded) {
      const c = caps[p];
      if (c) putCachedCaption(f.fileId, c, transcript ?? null);
    }
    captioned++;
    opts.onProgress?.({
      stage: `writing captions (${captioned} of ${todo.length})`,
      done: cachedCount + captioned,
      total: files.length,
      cached: cachedCount,
    });
  });

  // 1b) Pre-flight: probe each file's video ONCE (same media across channels).
  // Cloud links / missing files degrade to `unknown` checks (never fail hard).
  const preflightByFile = new Map<string, GrowthCheckDto[]>();
  for (const f of files) {
    const pf = await preflightVideo(f.source, { nameHint: f.label || f.source.ref });
    preflightByFile.set(f.fileId, pf.checks as GrowthCheckDto[]);
  }

  // 2) DE-DUPE + CONTINUITY: read the per-channel ledger. For each target channel
  // we (a) drop any (channelId, fileId) already scheduled to it, and (b) derive a
  // starting state (furthest day + per-day counts + occupied instants) so the new
  // posts CONTINUE the channel's existing queue at ≤ maxPerDay/day rather than
  // restart from `now`. The ledger is read HERE (not in the pure engine).
  const timezone = input.timezone || "America/New_York";
  // Cadence = how many DROPS (videos) release per day; each goes to every account.
  // `videosPerDay` is preferred; `maxPerDay` kept for back-compat.
  const cadence = Math.max(1, Math.floor(input.videosPerDay ?? input.maxPerDay ?? 2));
  // Warm-up mode replaces the flat cadence with a ramp. The per-CHANNEL day cap
  // handed to the engine below must clear the ramp's BUSIEST day, or a pinned
  // drop would be pushed off its day and split its cohort across two dates.
  const cadenceMode: CadenceMode = input.cadenceMode === "warmup" ? "warmup" : "steady";
  const ramp = rampForMode(cadenceMode);
  const peakPerDay = ramp ? rampPeakPerDay(ramp) : cadence;
  const minGapDays = Math.max(0, Math.floor(input.minGapDays ?? 3));
  const seed = Number.isFinite(input.seed) ? (input.seed as number) >>> 0 : 1;
  const channelStates = new Map(targets.map((t) => [t.channel.id, getChannelState(t.channel.id)]));

  const todayLocalKey = localDayKeyInTz(now, timezone);
  const channelStartStates: Record<string, ChannelStartState> = {};
  const continuedFrom: PreviewOutput["continuedFrom"] = [];
  // Furthest existing scheduled day across ALL selected channels — the new drops
  // start the day AFTER it, so a drop's whole cohort lands on one empty day (no
  // channel overlaps its own existing future queue).
  let globalFurthestLocalDay: string | null = null;
  for (const { channel: c } of targets) {
    const state = channelStates.get(c.id)!;
    const { furthestLocalDay, countsByLocalDay } = deriveChannelTimeline(state.scheduledAt, timezone);
    channelStartStates[c.id] = {
      furthestLocalDay,
      countsByLocalDay,
      occupiedInstants: state.scheduledAt,
    };
    // Only surface "continuing your queue from X" when the existing queue actually
    // pushes the new posts forward (furthest day is today or later).
    if (furthestLocalDay && furthestLocalDay >= todayLocalKey) {
      continuedFrom.push({ channelId: c.id, channelName: c.name, fromLocalDay: furthestLocalDay });
      if (!globalFurthestLocalDay || furthestLocalDay > globalFurthestLocalDay) {
        globalFurthestLocalDay = furthestLocalDay;
      }
    }
  }
  // Drops begin the day AFTER any existing queue, and never today: a drop pinned
  // to today could split across today/tomorrow when some platforms' windows have
  // already passed but others' haven't. Starting at tomorrow (offset ≥ 1) keeps a
  // drop's whole cohort on one full future day (true same-24h across accounts).
  const startDayOffset = Math.max(
    1,
    globalFurthestLocalDay ? daysBetweenLocalKeys(todayLocalKey, globalFurthestLocalDay) + 1 : 0,
  );

  // DE-DUPE pass: which (file × channel) pairs are already in the ledger, and
  // which files still have at least one LIVE channel to post to.
  const skippedPosts: SkippedPostDto[] = [];
  const liveFileIds = new Set<string>();
  for (const f of files) {
    for (const t of targets) {
      if (channelStates.get(t.channel.id)!.fileIds.has(f.fileId)) {
        skippedPosts.push({
          fileId: f.fileId,
          channelId: t.channel.id,
          channelName: t.channel.name,
          reason: "Already scheduled to this channel",
        });
      } else {
        liveFileIds.add(f.fileId);
      }
    }
  }
  const skippedKeys = new Set(skippedPosts.map((s) => `${s.fileId}|${s.channelId}`));

  // DROP SEQUENCING: mix the looks and assign each LIVE video a local day so
  // same-look videos are spaced ≥ minGapDays apart, at most `cadence` videos/day.
  // Only live files consume day slots (fully de-duped files get no drop).
  const dropFiles: DropFile[] = files
    .filter((f) => liveFileIds.has(f.fileId))
    .map((f) => ({ fileId: f.fileId, groupId: f.groupId, spacingId: f.spacingId }));
  const assignments = sequenceDrops(dropFiles, {
    videosPerDay: cadence,
    ramp: ramp ?? undefined,
    minGapDays: minGapDays,
    seed,
    startDayOffset,
    fixedOrder: input.fileOrder,
  });
  const dropDateByFile = new Map<string, string>(
    assignments.map((a) => [a.fileId, addDaysToLocalKey(todayLocalKey, a.dayOffset)]),
  );
  // HOW OFTEN THE CAMPAIGN ASKS. Nothing asks for anything while the ramp is
  // still ramping (8 weeks on the warm-up ramp); after that one drop in three
  // carries the CTA and the other two are pure value. A brand-new account that
  // wants something on every post reads as a funnel rather than a person, and an
  // identical CTA line on 95% of posts is a template fingerprint louder than any
  // single caption.
  //
  // Captions are cached per (file, platform) while this depends on WHEN a post
  // lands, so the ask is stripped at assembly rather than never generated — one
  // cached caption stays usable whichever side of the line it falls.
  const ctaFreeFileIds = ramp
    ? ctaSuppressedFileIds(assignments, {
        quietUntilDayOffset: startDayOffset + rampRampUpDays(ramp),
      })
    : new Set<string>();

  // One scheduling ITEM per LIVE (file × channel). Each item is PINNED to its
  // video's drop day so all accounts post that video within the same 24h; the
  // engine still picks each platform's optimal HOUR on that day (collision-free).
  const items: ScheduleItemInput[] = [];
  for (const f of files) {
    const pinnedLocalDay = dropDateByFile.get(f.fileId);
    for (const t of targets) {
      if (skippedKeys.has(`${f.fileId}|${t.channel.id}`)) continue;
      items.push({
        key: `${f.fileId}|${t.channel.id}`,
        platform: t.plat,
        channelId: t.channel.id,
        pinnedLocalDay,
      });
    }
  }
  const schedule = buildSchedule(items, {
    now,
    timezone: input.timezone,
    intent: input.intent,
    startTomorrow: false,
    maxPerChannelPerDay: peakPerDay,
    channelStartStates,
    seed,
  });
  const scheduleByKey = new Map(schedule.map((s) => [s.key, s]));

  // 3) Assemble preview rows (skipping de-duplicated pairs).
  const posts: PreviewPostDto[] = [];
  for (const f of files) {
    const caps = captionsByFile.get(f.fileId)!;
    const preflightChecks = preflightByFile.get(f.fileId) ?? [];
    for (const { channel: c, plat } of targets) {
      if (skippedKeys.has(`${f.fileId}|${c.id}`)) continue;
      const cap = caps[plat];
      const sched = scheduleByKey.get(`${f.fileId}|${c.id}`)!;
      // De-tell here rather than only at generation time: captions are CACHED,
      // so the ones written before the voice existed would otherwise keep their
      // em-dashes forever. Idempotent, so a freshly-assembled caption (already
      // stripped) is unchanged. It cleans the phrasing; giving an old caption
      // the actual voice still needs a rewrite through the review step.
      const voiced = stripAiTells(cap?.caption ?? "");
      const ctaSuppressed = ctaFreeFileIds.has(f.fileId);
      const caption = ctaSuppressed ? stripGrowthCta(voiced, CTA_KEYWORD) : voiced;
      const captionScore = scoreCaption(caption, cap?.hashtags ?? [], plat, { ctaSuppressed });
      const growth = combineGrowth(captionScore.checks as GrowthCheckDto[], preflightChecks);
      posts.push({
        fileId: f.fileId,
        channelId: c.id,
        provider: c.provider,
        channelName: c.name,
        identifier: c.identifier,
        platform: plat,
        caption,
        ctaSuppressed,
        firstLineHook: cap?.firstLineHook ?? "",
        hashtags: cap?.hashtags ?? [],
        scheduledAt: sched.scheduledAt,
        reason: sched.reason,
        groupId: f.groupId,
        growth,
        // Seed TikTok Direct-Post controls (PostPeer only) with sensible defaults
        // so the review UI can render the privacy/disclosure toggles.
        ...(c.provider === "postpeer" && plat === "tiktok"
          ? { tiktok: { ...DEFAULT_TIKTOK_OPTIONS } }
          : {}),
      });
    }
  }

  const filesDto: PreviewFileDto[] = files.map((f) => {
    const t = transcriptByFile.get(f.fileId) ?? null;
    return {
      fileId: f.fileId,
      transcript: t ? t.slice(0, MAX_TRANSCRIPT_PREVIEW_CHARS) : null,
      groupId: f.groupId,
      dropDate: dropDateByFile.get(f.fileId) ?? null,
    };
  });

  return {
    posts,
    files: filesDto,
    skippedChannels,
    skippedPosts,
    continuedFrom,
    seed,
    cadenceMode,
    lookCount: countLooks(dropFiles),
  };
}

/** Local "YYYY-MM-DD" for an instant in a zone (for the continuity hint). */
function localDayKeyInTz(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Whole days from one local "YYYY-MM-DD" key to another (≥0 when `to` ≥ `from`). */
function daysBetweenLocalKeys(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/** Add `n` calendar days to a local "YYYY-MM-DD" key, returning a new key. */
function addDaysToLocalKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  const mo = String(next.getUTCMonth() + 1).padStart(2, "0");
  const day = String(next.getUTCDate()).padStart(2, "0");
  return `${next.getUTCFullYear()}-${mo}-${day}`;
}

// ── schedule (actually post) ──────────────────────────────────────────────────
/** One (possibly user-edited) post the UI sends back to be scheduled. */
export interface SchedulePostInput {
  fileId: string;
  /** The media source for this file (so we can upload once per file). */
  source: FileSourceRef;
  channelId: string;
  /** Which API to route this item through. Defaults to "postiz" (backward-compat). */
  provider?: Provider;
  identifier: string;
  caption: string;
  hashtags: string[];
  /** SEO title/hook — used as the YouTube video title. */
  firstLineHook?: string;
  scheduledAt: string;
  /** TikTok Direct-Post options (postpeer/tiktok only); defaults applied if absent. */
  tiktok?: PostPeerTikTokOptions;
  /**
   * Explicit per-item bypass of the Growth Guardrails gate. When a `required`
   * check fails, the item is rejected UNLESS the user opts in with override:true.
   */
  override?: boolean;
}

export interface ScheduleItemResult {
  fileId: string;
  channelId: string;
  ok: boolean;
  error?: string;
  /** Set when the item was blocked by Growth Guardrails (the failing checks). */
  blockedChecks?: GrowthCheckDto[];
  /**
   * Set when the item was refused because this tool has ALREADY scheduled this
   * video to this channel. Not a failure to retry — retrying would post twice.
   */
  duplicate?: boolean;
}

export interface ScheduleOutput {
  results: ScheduleItemResult[];
  scheduled: number;
  failed: number;
  /** Items refused because they were already scheduled (not failures). */
  skippedDuplicates?: number;
  /** Render filenames this run parked in the picker's Hidden list (see below). */
  autoHidden: string[];
}


/**
 * Schedule each item through ITS channel's provider, aggregating per-item
 * success/failure across BOTH providers in one result. Postiz items upload the
 * media to Postiz first (internal URL pull); PostPeer items hand TikTok the
 * PUBLIC media URL (PostPeer pulls it externally + drives TikTok's upload/poll).
 * No item is ever lost — a provider/upload failure fails only the affected items.
 *
 * GROWTH GATE (server-side, authoritative): before any media is uploaded, every
 * post is re-scored. An item with a MEASURED, FAILING `required` check is
 * REJECTED with its failing checks UNLESS it carries override:true. The gate is
 * enforced here (not on the client) so an edited caption or a bad video can't be
 * scheduled by tampering with the request. `recommended`/`unknown` never block.
 */
/** Loads a source's bytes for Postiz's multipart upload. Injectable for tests. */
export type LoadMediaFn = (source: FileSourceRef) => Promise<{ data: Buffer; filename: string; contentType: string }>;

export async function schedule(
  input: { posts: SchedulePostInput[] },
  opts: { probeFn?: ProbeFn; loadMedia?: LoadMediaFn } = {},
): Promise<ScheduleOutput> {
  // Growth Guardrails are ADVISORY: the score guides the user in the review UI, but
  // it NEVER blocks scheduling (no override needed). We just post what was sent.
  const rawSubmitted = Array.isArray(input.posts) ? input.posts : [];

  // ALREADY-SCHEDULED GUARD. The plan builder drops (file × channel) pairs the
  // ledger already knows about, but that is a PLAN-time filter and the server
  // otherwise posts whatever it is handed — a stale tab, a re-submitted plan or
  // a retry that includes successes would post the same video to the same
  // channel twice. The ledger is the authority, so the check belongs here too.
  const duplicates: ScheduleItemResult[] = [];
  const submitted: SchedulePostInput[] = [];
  {
    const stateByChannel = new Map<string, ReturnType<typeof getChannelState>>();
    for (const p of rawSubmitted) {
      let state = stateByChannel.get(p.channelId);
      if (!state) {
        state = getChannelState(p.channelId);
        stateByChannel.set(p.channelId, state);
      }
      if (state.fileIds.has(p.fileId)) {
        duplicates.push({
          fileId: p.fileId,
          channelId: p.channelId,
          ok: false,
          duplicate: true,
          error: "Already scheduled to this channel — skipped so it isn't posted twice.",
        });
        continue;
      }
      submitted.push(p);
    }
  }

  // YouTube Shorts-only HARD GATE (vertical only — duration NOT gated): a YouTube
  // post is REJECTED before any upload unless its video is CONFIRMED vertical
  // (9:16), so a landscape clip can never be published as a regular long-form
  // video. We probe ONLY YouTube posts (same probe the pre-flight uses); cloud /
  // unprobeable videos can't be confirmed vertical and are blocked too. Bypass
  // with override:true. See postiz/youtubeGate.ts for the decision logic.
  const blocked: ScheduleItemResult[] = [];
  const allowed: SchedulePostInput[] = [];
  for (const p of submitted) {
    if (isYouTubePost(p) && !p.override) {
      const pf = await preflightVideo(p.source, { probeFn: opts.probeFn });
      const verticalPass = pf.checks.find((c) => c.id === "vertical")?.pass ?? null;
      const block = youtubeShortsGate(p, verticalPass);
      if (block) {
        blocked.push({ fileId: p.fileId, channelId: p.channelId, ok: false, error: block.error, blockedChecks: [block.check] });
        continue;
      }
    }
    allowed.push(p);
  }

  const postizPosts = allowed.filter((p) => (p.provider ?? "postiz") === "postiz");
  const postPeerPosts = allowed.filter((p) => p.provider === "postpeer");
  const loadMedia = opts.loadMedia ?? loadPostizMedia;

  // Upload each distinct file's BYTES to Postiz ONCE. Postiz needs {id, path} for
  // its own posts; PostPeer reuses `path` (a PUBLIC https URL Postiz serves, the
  // same one it hands social platforms) as the media URL for render/upload sources
  // — so external PostPeer can fetch the video without the lab being public.
  const needUpload = new Map<string, FileSourceRef>();
  for (const p of postizPosts) if (!needUpload.has(p.fileId)) needUpload.set(p.fileId, p.source);
  for (const p of postPeerPosts) if (p.source.kind !== "cloud" && !needUpload.has(p.fileId)) needUpload.set(p.fileId, p.source);

  const mediaByFile = new Map<string, { id: string; path: string } | { error: string }>();
  if (needUpload.size > 0 && postizApiConfigured()) {
    const client = createPostizClient();
    for (const [fileId, source] of needUpload) {
      try {
        const media = await loadMedia(source);
        const up = await client.upload(media.data, media.filename, media.contentType);
        mediaByFile.set(fileId, { id: up.id, path: up.path });
      } catch (e) {
        mediaByFile.set(fileId, { error: errMsg(e) });
      }
    }
  }

  const results: ScheduleItemResult[] = [
    ...duplicates,
    ...blocked,
    ...(await schedulePostiz(postizPosts, mediaByFile)),
    ...(await schedulePostPeer(postPeerPosts, mediaByFile)),
  ];

  // Record ONLY successful posts in the per-channel ledger, so continuity advances
  // for real posts and a re-run de-dupes them. Failures are never recorded (a
  // retry re-schedules only what truly didn't go out). Indexed by (file|channel)
  // so each result maps back to the instant that was actually requested.
  const postByKey = new Map(allowed.map((p) => [`${p.fileId}|${p.channelId}`, p]));
  for (const r of results) {
    if (!r.ok) continue;
    const p = postByKey.get(`${r.fileId}|${r.channelId}`);
    if (p) recordScheduled(p.channelId, p.fileId, new Date(p.scheduledAt).toISOString());
  }

  // Finished renders are NOT auto-hidden any more. Hidden is the operator's own
  // "not posting this" drawer; filling it automatically buried 241 renders they
  // never chose to hide (2026-08-24). The picker now filters finished videos out
  // via the ledger instead — see fullyScheduledRenders() — which keeps them out
  // of the way without taking over a manual control.
  const autoHidden: string[] = [];

  const scheduled = results.filter((r) => r.ok).length;
  // Duplicates are neither scheduled nor failed — they are work that was
  // already done, and counting them as failures would invite a retry loop.
  const skippedDuplicates = duplicates.length;
  return {
    results,
    scheduled,
    failed: results.length - scheduled - skippedDuplicates,
    skippedDuplicates,
    autoHidden,
  };
}

/** Postiz leg: createPost per item using the pre-uploaded media (id + path). */
async function schedulePostiz(
  posts: SchedulePostInput[],
  mediaByFile: Map<string, { id: string; path: string } | { error: string }>,
): Promise<ScheduleItemResult[]> {
  if (posts.length === 0) return [];
  const client = createPostizClient();

  const results: ScheduleItemResult[] = [];
  for (const p of posts) {
    const upload = mediaByFile.get(p.fileId);
    if (!upload || "error" in upload) {
      results.push({
        fileId: p.fileId,
        channelId: p.channelId,
        ok: false,
        error: upload && "error" in upload ? `Media upload failed: ${upload.error}` : "Media not uploaded",
      });
      continue;
    }
    try {
      const content = composeContent(p.caption, p.hashtags);
      await client.createPost({
        type: "schedule",
        date: new Date(p.scheduledAt).toISOString(),
        shortLink: false,
        tags: [],
        posts: [
          {
            integration: { id: p.channelId },
            // Postiz requires BOTH the upload id AND its path on the image entry.
            value: [{ content, image: [{ id: upload.id, path: upload.path }] }],
            settings: buildProviderSettings(p.identifier, { title: p.firstLineHook }),
          },
        ],
      });
      results.push({ fileId: p.fileId, channelId: p.channelId, ok: true });
    } catch (e) {
      results.push({ fileId: p.fileId, channelId: p.channelId, ok: false, error: errMsg(e) });
    }
  }
  return results;
}

/**
 * PostPeer leg: PostPeer (external) pulls the media from a URL, which TikTok
 * requires to be PUBLIC + HTTPS. We resolve each file's public media URL once:
 *   - cloud source → its own direct share link (already public);
 *   - render/upload → the PUBLIC https URL Postiz returned from the shared upload
 *     (`mediaByFile.path`) — Postiz serves it on its own domain, so no public lab
 *     is needed. Fallback: the lab's PUBLIC_BASE_URL (only if Postiz isn't set up).
 */
async function schedulePostPeer(
  posts: SchedulePostInput[],
  mediaByFile: Map<string, { id: string; path: string } | { error: string }>,
): Promise<ScheduleItemResult[]> {
  if (posts.length === 0) return [];
  const client = createPostPeerClient();

  const results: ScheduleItemResult[] = [];
  for (const p of posts) {
    let mediaUrl: string;
    try {
      if (p.source.kind === "cloud") {
        mediaUrl = resolvePublicSourceUrl(p.source);
      } else {
        const up = mediaByFile.get(p.fileId);
        if (up && "error" in up) throw new Error(up.error);
        mediaUrl = up?.path ?? resolvePublicSourceUrl(p.source);
      }
    } catch (e) {
      results.push({ fileId: p.fileId, channelId: p.channelId, ok: false, error: errMsg(e) });
      continue;
    }
    try {
      await client.createPost({
        accountId: p.channelId,
        mediaUrl,
        caption: composeContent(p.caption, p.hashtags),
        scheduledAt: new Date(p.scheduledAt).toISOString(),
        tiktok: p.tiktok ?? { ...DEFAULT_TIKTOK_OPTIONS },
      });
      results.push({ fileId: p.fileId, channelId: p.channelId, ok: true });
    } catch (e) {
      results.push({ fileId: p.fileId, channelId: p.channelId, ok: false, error: errMsg(e) });
    }
  }
  return results;
}

// ── helpers ────────────────────────────────────────────────────────────────────
/** Safety cap on bytes pulled into memory for a Postiz upload (short clips are small). */
const MAX_POSTIZ_MEDIA_BYTES = 300 * 1024 * 1024;

/** video/* content-type from a filename extension (defaults to mp4). */
function guessVideoContentType(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  if (ext === "m4v") return "video/x-m4v";
  return "video/mp4";
}

/**
 * Load a source's bytes for Postiz's multipart /upload. Local renders/uploads are
 * read from disk; cloud clips are downloaded from their (public) direct URL. We
 * always upload bytes (never a URL) because Postiz rejects internal/non-HTTPS
 * upload-from-url targets — and a real filename avoids its missing-extension bug.
 */
async function loadPostizMedia(
  source: FileSourceRef,
): Promise<{ data: Buffer; filename: string; contentType: string }> {
  const filename = filenameFor(source);
  const localPath = await resolveLocalPath(source);
  if (localPath) {
    return { data: await readFile(localPath), filename, contentType: guessVideoContentType(filename) };
  }
  // No local file (cloud) → download the direct URL into memory.
  const url = resolveSourceUrl(source);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`could not fetch media (HTTP ${res.status})`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_POSTIZ_MEDIA_BYTES) {
    throw new Error(`media is too large to upload (${Math.round(data.length / 1e6)} MB)`);
  }
  return { data, filename, contentType: res.headers.get("content-type") || guessVideoContentType(filename) };
}

/** Append hashtags to the caption body (most platforms accept inline tags). */
export function composeContent(caption: string, hashtags: string[]): string {
  const tags = hashtags.filter(Boolean).map((t) => `#${t}`).join(" ");
  return tags ? `${caption}\n\n${tags}` : caption;
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Render positions, cached for a short while. The join is cheap (two indexed
 * reads) but preview calls it per request and the picker calls it per Randomize,
 * and a render's position never changes once it exists.
 */
let positionCache: { at: number; map: Map<string, string> } | null = null;
function renderPositions(): Map<string, string> {
  const now = Date.now();
  if (positionCache && now - positionCache.at < 60_000) return positionCache.map;
  const map = loadRenderPositions();
  positionCache = { at: now, map };
  return map;
}

/** Test seam: drop the memoized position map. */
export function resetRenderPositionCache(): void {
  positionCache = null;
}

/**
 * Arrange picked files into a mixed order where two clips shot in the SAME
 * position never sit next to each other, as far as the counts allow.
 *
 * This is the Randomize button. It deliberately runs the sequencer's own
 * interleave (cadence high enough that day-packing can't reorder anything) so
 * the arrangement the user is shown is produced by the exact algorithm that
 * would otherwise have planned it — there is no second shuffle to disagree with.
 *
 * `fileIds` are the UI's ids (`render:<name>`, `upload:<id>`, `cloud:<url>`).
 */
export function randomizeOrder(
  fileIds: readonly string[],
  seed: number,
): { fileIds: string[]; positions: Record<string, string>; positionCount: number; adjacentRepeats: number } {
  const positions = renderPositions();
  const groupOf = (fileId: string): string => {
    const i = fileId.indexOf(":");
    const kind = i === -1 ? "" : fileId.slice(0, i);
    const ref = i === -1 ? fileId : fileId.slice(i + 1);
    if (kind === "render") return positions.get(ref) ?? POSITION_UNKNOWN;
    return groupKeyForFilename(ref) || POSITION_UNKNOWN;
  };
  const dropFiles: DropFile[] = fileIds.map((id) => ({ fileId: id, groupId: groupOf(id) }));
  const assignments = sequenceDrops(dropFiles, {
    videosPerDay: Math.max(1, dropFiles.length),
    minGapDays: 0,
    seed: seed >>> 0,
  });
  const ordered = assignments.slice().sort((a, b) => a.order - b.order);
  // Report, never hide, the repeats the counts made unavoidable: one position
  // holding more than half the pile MUST touch itself somewhere.
  let adjacentRepeats = 0;
  for (let i = 1; i < ordered.length; i++) if (ordered[i].groupId === ordered[i - 1].groupId) adjacentRepeats++;
  return {
    fileIds: ordered.map((a) => a.fileId),
    positions: Object.fromEntries(dropFiles.map((f) => [f.fileId, f.groupId])),
    positionCount: new Set(dropFiles.map((f) => f.groupId)).size,
    adjacentRepeats,
  };
}

/**
 * Best-effort brief auto-seed for a server render: match the output filename to
 * a project's outputUrl and reuse its title (and any narration/context hint).
 * Returns "" when nothing is found — the caller's caption prompt handles that.
 */
async function autoSeedBrief(source: FileSourceRef): Promise<string> {
  if (source.kind !== "render") return "";
  try {
    const { records } = await Projects.findAll({ limit: 500 });
    const match = records.find(
      (p) => typeof p.outputUrl === "string" && (p.outputUrl as string).includes(source.ref),
    );
    if (!match) return "";
    const parts = [match.title, match.contextHint, match.narrationText]
      .filter((x) => typeof x === "string" && x && x !== "Processing…")
      .map((x) => String(x));
    return parts.join(" — ").slice(0, 500);
  } catch {
    return "";
  }
}

function errMsg(e: unknown): string {
  if (e instanceof PostizApiError || e instanceof PostPeerApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// ── filling in the blanks ────────────────────────────────────────────────────

export interface FillCaptionsInput {
  files: Array<{
    fileId: string;
    source: FileSourceRef;
    brief?: string;
    /** Platforms this file still needs a caption for. */
    platforms: CaptionPlatform[];
    /**
     * Rewrite even if a caption is already stored. Used when the CAPTION ITSELF
     * is the problem — one written before the current rules (a URL in it, an
     * old CTA, no CTA at all) is cached and would otherwise be handed straight
     * back unchanged.
     */
    force?: boolean;
  }>;
}

export interface FillCaptionsOutput {
  /** fileId -> platform -> the caption to drop into the post. */
  captions: Record<string, Record<string, PlatformCaption>>;
  /** How many files were written from the cache (free) vs freshly generated. */
  reused: number;
  generated: number;
  failures: Array<{ fileId: string; error: string }>;
}

/** Never write more than this in one click — keeps the request short. */
export const FILL_CAPTIONS_LIMIT = 40;

/**
 * Write captions for posts that came back blank.
 *
 * A caption can be missing because its AI call failed mid-plan, or because the
 * plan was built before a channel's platform was added. Rebuilding the whole
 * plan to recover a handful of them is wasteful, so this fills just the gaps:
 * the cache first (free), then a fresh call for whatever is genuinely missing,
 * transcribing only when no transcript is already on record.
 */
/** A second transcription attempt with its own cache, for a file that just failed. */
async function transcribeAgain(source: FileSourceRef) {
  try {
    return await createTranscriptionCache().get(source);
  } catch {
    return null;
  }
}

export async function fillCaptions(input: FillCaptionsInput): Promise<FillCaptionsOutput> {
  const files = (input.files ?? []).slice(0, FILL_CAPTIONS_LIMIT);
  const out: FillCaptionsOutput = { captions: {}, reused: 0, generated: 0, failures: [] };
  if (!files.length) return out;

  const transcriber = createTranscriptionCache();

  await mapWithConcurrency(files, CAPTION_CONCURRENCY, async (f) => {
    try {
      const cached = getCachedCaptions(f.fileId);
      const result: Record<string, PlatformCaption> = {};
      const missing: CaptionPlatform[] = [];

      for (const p of f.platforms) {
        const hit = f.force ? undefined : cached.get(p);
        // A cached BLANK is not a caption — treat it as missing, or the button
        // would report success and change nothing.
        if (hit && hit.caption.trim()) {
          result[p] = {
            platform: p,
            caption: hit.caption,
            hashtags: hit.hashtags,
            firstLineHook: hit.firstLineHook,
          };
        } else {
          missing.push(p);
        }
      }

      if (missing.length) {
        // Reuse a transcript we already paid for; only transcribe if there is none.
        let transcript = "";
        for (const c of cached.values()) {
          if (c.transcript && c.transcript.trim()) {
            transcript = c.transcript;
            break;
          }
        }
        if (!transcript) {
          // One retry: the transcripts missing from this plan were lost to a
          // 90s timeout while 227 videos transcribed at once, not because the
          // media is bad. A second, unhurried attempt usually lands.
          const tr = (await transcriber.get(f.source)) ?? (await transcribeAgain(f.source));
          transcript = tr?.text ?? "";
        }
        const brief = (f.brief ?? "").trim() || (await autoSeedBrief(f.source));

        // The caption writer has NOTHING to work from without one of these, and
        // returns an empty caption rather than inventing a video. That is how
        // these posts came to be blank in the first place (transcription timed
        // out under load), so say so instead of reporting a silent success.
        if (!transcript.trim() && !brief.trim()) {
          out.failures.push({
            fileId: f.fileId,
            error: "no transcript and no brief — could not read this video, so there is nothing to write from",
          });
          return;
        }

        const fresh = await generateCaptions(brief, missing, {
          transcript: transcript || undefined,
        });
        let wrote = 0;
        for (const p of missing) {
          const c = fresh[p];
          if (c && c.caption.trim()) {
            result[p] = c;
            putCachedCaption(f.fileId, c, transcript || null);
            wrote++;
          }
        }
        if (!wrote) {
          out.failures.push({ fileId: f.fileId, error: "the caption writer returned nothing" });
          return;
        }
        out.generated++;
      } else {
        out.reused++;
      }

      if (Object.keys(result).length) out.captions[f.fileId] = result;
    } catch (err) {
      out.failures.push({
        fileId: f.fileId,
        error: err instanceof Error ? err.message : "caption generation failed",
      });
    }
  });

  return out;
}

/**
 * Renders that have been scheduled to EVERY connected channel — i.e. there is
 * no posting left to do for them.
 *
 * The picker uses this to stop offering finished videos. It deliberately does
 * NOT hide them: Hidden is the operator's own "not posting this" drawer, and
 * filling it automatically buried 241 renders that the operator never chose to
 * hide (2026-08-24). Returns bare filenames, which is what the picker keys on.
 */
export async function fullyScheduledRenders(): Promise<string[]> {
  const channels = await listChannels();
  if (!channels.length) return [];
  const states = channels.map((c) => getChannelState(c.id));
  // A render counts as done only when every channel's ledger holds it, so a
  // video still owed to one account keeps showing up.
  const counts = new Map<string, number>();
  for (const state of states) {
    for (const fileId of state.fileIds) {
      counts.set(fileId, (counts.get(fileId) ?? 0) + 1);
    }
  }
  const done: string[] = [];
  for (const [fileId, n] of counts) {
    if (n < channels.length) continue;
    if (!fileId.startsWith("render:")) continue;
    done.push(fileId.slice("render:".length));
  }
  return done;
}
