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
import { generateCaptions, scoreCaption, scoreChecks, type PlatformCaption, type CaptionPlatform } from "./captions.js";
import { buildSchedule, type Intent, type ScheduleItemInput } from "./scheduling.js";
import { resolveSourceUrl, resolvePublicSourceUrl, resolveLocalPath, filenameFor, type FileSourceRef } from "./fileSources.js";
import { preflightVideo, type ProbeFn } from "./preflight.js";
import { createTranscriptionCache, type TranscribeSourceDeps } from "./transcription.js";
import { readFile } from "node:fs/promises";

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

export interface PreviewInput {
  files: PreviewFileInput[];
  /** Channel ids to target (must be currently connected). */
  channelIds: string[];
  intent?: Intent;
  timezone?: string;
  /** ISO string; defaults to server now. Lets the UI/tests pin "now". */
  now?: string;
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
}

export interface PreviewOutput {
  posts: PreviewPostDto[];
  /** Per-file transcript surfaced so the UI can show what captions are based on. */
  files: PreviewFileDto[];
  /** Channels that were requested but skipped (not connected / not short-form). */
  skippedChannels: Array<{ id: string; reason: string }>;
}

export async function preview(
  input: PreviewInput,
  opts: { transcribeDeps?: TranscribeSourceDeps } = {},
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

  const files = input.files.map((f, i) => ({
    ...f,
    fileId: f.fileId || `${f.source.kind}:${f.source.ref}` || `file-${i}`,
  }));

  // 1) Transcribe each file FIRST (in parallel across files, cached per resolved
  // file so we never transcribe the same video twice). Transcription NEVER throws
  // — a missing key / no speech / ffmpeg-or-download failure / timeout yields null
  // and that file simply falls back to its brief. One file's failure can't kill
  // the batch.
  const transcriber = createTranscriptionCache(opts.transcribeDeps);
  const transcriptByFile = new Map<string, string | null>();
  await Promise.all(
    files.map(async (f) => {
      const tr = await transcriber.get(f.source);
      transcriptByFile.set(f.fileId, tr?.text ?? null);
    }),
  );

  // 2) Captions: one AI call per file, covering all distinct target platforms,
  // grounded in the transcript when we have one (brief is supplementary context).
  const platformsNeeded = unique(targets.map((t) => t.plat));
  const captionsByFile = new Map<string, Record<CaptionPlatform, PlatformCaption>>();
  for (const f of files) {
    const brief = (f.brief ?? "").trim() || (await autoSeedBrief(f.source));
    const transcript = transcriptByFile.get(f.fileId) ?? undefined;
    const caps = await generateCaptions(brief, platformsNeeded, { transcript });
    captionsByFile.set(f.fileId, caps);
  }

  // 1b) Pre-flight: probe each file's video ONCE (same media across channels).
  // Cloud links / missing files degrade to `unknown` checks (never fail hard).
  const preflightByFile = new Map<string, GrowthCheckDto[]>();
  for (const f of files) {
    const pf = await preflightVideo(f.source, { nameHint: f.label || f.source.ref });
    preflightByFile.set(f.fileId, pf.checks as GrowthCheckDto[]);
  }

  // 2) Schedule: one (file × channel) item per post, spread across channels.
  const items: ScheduleItemInput[] = [];
  for (const f of files) {
    for (const t of targets) {
      items.push({ key: `${f.fileId}|${t.channel.id}`, platform: t.plat });
    }
  }
  const schedule = buildSchedule(items, {
    now,
    timezone: input.timezone,
    intent: input.intent,
    startTomorrow: false,
  });
  const scheduleByKey = new Map(schedule.map((s) => [s.key, s]));

  // 3) Assemble preview rows.
  const posts: PreviewPostDto[] = [];
  for (const f of files) {
    const caps = captionsByFile.get(f.fileId)!;
    const preflightChecks = preflightByFile.get(f.fileId) ?? [];
    for (const { channel: c, plat } of targets) {
      const cap = caps[plat];
      const sched = scheduleByKey.get(`${f.fileId}|${c.id}`)!;
      const captionScore = scoreCaption(cap?.caption ?? "", cap?.hashtags ?? [], plat);
      const growth = combineGrowth(captionScore.checks as GrowthCheckDto[], preflightChecks);
      posts.push({
        fileId: f.fileId,
        channelId: c.id,
        provider: c.provider,
        channelName: c.name,
        identifier: c.identifier,
        platform: plat,
        caption: cap?.caption ?? "",
        firstLineHook: cap?.firstLineHook ?? "",
        hashtags: cap?.hashtags ?? [],
        scheduledAt: sched.scheduledAt,
        reason: sched.reason,
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
    };
  });

  return { posts, files: filesDto, skippedChannels };
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
}

export interface ScheduleOutput {
  results: ScheduleItemResult[];
  scheduled: number;
  failed: number;
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
  const allowed = Array.isArray(input.posts) ? input.posts : [];

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
    ...(await schedulePostiz(postizPosts, mediaByFile)),
    ...(await schedulePostPeer(postPeerPosts, mediaByFile)),
  ];

  const scheduled = results.filter((r) => r.ok).length;
  return { results, scheduled, failed: results.length - scheduled };
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
