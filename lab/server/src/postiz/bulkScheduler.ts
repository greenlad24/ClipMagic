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
import { generateCaptions, scoreCaption, scoreChecks, type PlatformCaption } from "./captions.js";
import { buildSchedule, type Intent, type ScheduleItemInput } from "./scheduling.js";
import { resolveSourceUrl, resolvePublicSourceUrl, type FileSourceRef } from "./fileSources.js";
import { preflightVideo, type ProbeFn } from "./preflight.js";

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
  platform: ShortPlatform;
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

export interface PreviewOutput {
  posts: PreviewPostDto[];
  /** Channels that were requested but skipped (not connected / not short-form). */
  skippedChannels: Array<{ id: string; reason: string }>;
}

export async function preview(input: PreviewInput): Promise<PreviewOutput> {
  const now = input.now ? new Date(input.now) : new Date();
  const channels = await listChannels();
  const byId = new Map(channels.map((c) => [c.id, c]));

  // Resolve target channels → only connected ones with a tuned short platform.
  const targets: ChannelDto[] = [];
  const skippedChannels: Array<{ id: string; reason: string }> = [];
  for (const id of input.channelIds) {
    const c = byId.get(id);
    if (!c) {
      skippedChannels.push({ id, reason: "Not a connected channel" });
      continue;
    }
    if (!c.platform) {
      skippedChannels.push({ id, reason: `No tuned caption/timing rules for ${c.identifier}` });
      continue;
    }
    targets.push(c);
  }

  const files = input.files.map((f, i) => ({
    ...f,
    fileId: f.fileId || `${f.source.kind}:${f.source.ref}` || `file-${i}`,
  }));

  // 1) Captions: one AI call per file, covering all distinct target platforms.
  const platformsNeeded = unique(targets.map((t) => t.platform!));
  const captionsByFile = new Map<string, Record<ShortPlatform, PlatformCaption>>();
  for (const f of files) {
    const brief = (f.brief ?? "").trim() || (await autoSeedBrief(f.source));
    const caps = await generateCaptions(brief, platformsNeeded);
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
    for (const c of targets) {
      items.push({ key: `${f.fileId}|${c.id}`, platform: c.platform! });
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
    for (const c of targets) {
      const cap = caps[c.platform!];
      const sched = scheduleByKey.get(`${f.fileId}|${c.id}`)!;
      const captionScore = scoreCaption(cap?.caption ?? "", cap?.hashtags ?? [], c.platform!);
      const growth = combineGrowth(captionScore.checks as GrowthCheckDto[], preflightChecks);
      posts.push({
        fileId: f.fileId,
        channelId: c.id,
        provider: c.provider,
        channelName: c.name,
        identifier: c.identifier,
        platform: c.platform!,
        caption: cap?.caption ?? "",
        firstLineHook: cap?.firstLineHook ?? "",
        hashtags: cap?.hashtags ?? [],
        scheduledAt: sched.scheduledAt,
        reason: sched.reason,
        growth,
        // Seed TikTok Direct-Post controls (PostPeer only) with sensible defaults
        // so the review UI can render the privacy/disclosure toggles.
        ...(c.provider === "postpeer" && c.platform === "tiktok"
          ? { tiktok: { ...DEFAULT_TIKTOK_OPTIONS } }
          : {}),
      });
    }
  }

  return { posts, skippedChannels };
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
 * Re-evaluate Growth Guardrails for one post SERVER-SIDE (we never trust a
 * client-supplied score — the caption/hashtags may have been edited after
 * preview). Caption is scored from the final text; pre-flight re-probes the
 * file. Platform is derived from the channel `identifier`. `probeFn` is injected
 * for tests. Returns the merged Growth result (or null if the channel isn't a
 * tuned short platform — then there's nothing to gate on).
 */
async function evaluatePostGrowth(p: SchedulePostInput, probeFn?: ProbeFn): Promise<GrowthDto | null> {
  const platform = toShortPlatform(p.identifier);
  if (!platform) return null; // no tuned rules → don't gate
  const captionScore = scoreCaption(p.caption ?? "", p.hashtags ?? [], platform);
  const pf = await preflightVideo(p.source, { probeFn, nameHint: p.fileId });
  return combineGrowth(captionScore.checks as GrowthCheckDto[], pf.checks as GrowthCheckDto[]);
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
export async function schedule(
  input: { posts: SchedulePostInput[] },
  opts: { probeFn?: ProbeFn } = {},
): Promise<ScheduleOutput> {
  const posts = Array.isArray(input.posts) ? input.posts : [];

  const allowed: SchedulePostInput[] = [];
  const blocked: ScheduleItemResult[] = [];
  for (const p of posts) {
    const growth = await evaluatePostGrowth(p, opts.probeFn);
    if (growth && hasBlockingFailure(growth) && !p.override) {
      const failing = growth.checks.filter((c) => c.severity === "required" && c.pass === false);
      blocked.push({
        fileId: p.fileId,
        channelId: p.channelId,
        ok: false,
        error: `Blocked by Growth Guardrails: ${failing.map((c) => c.label).join(", ")}. Fix the caption/video, or override to schedule anyway.`,
        blockedChecks: failing,
      });
    } else {
      allowed.push(p);
    }
  }

  const postizPosts = allowed.filter((p) => (p.provider ?? "postiz") === "postiz");
  const postPeerPosts = allowed.filter((p) => p.provider === "postpeer");

  const results: ScheduleItemResult[] = [
    ...blocked,
    ...(await schedulePostiz(postizPosts)),
    ...(await schedulePostPeer(postPeerPosts)),
  ];

  const scheduled = results.filter((r) => r.ok).length;
  return { results, scheduled, failed: results.length - scheduled };
}

/** Postiz leg: upload each file once (internal URL), then createPost per item. */
async function schedulePostiz(posts: SchedulePostInput[]): Promise<ScheduleItemResult[]> {
  if (posts.length === 0) return [];
  const client = createPostizClient();

  // Upload each distinct file's media to Postiz ONCE, then reuse the upload id
  // for every channel of that file (idempotent-ish: a failed upload fails only
  // that file's posts, and re-running re-uploads only what's missing).
  const uploadCache = new Map<string, { id: string; path: string } | { error: string }>();
  const sourceByFile = new Map<string, FileSourceRef>();
  for (const p of posts) if (!sourceByFile.has(p.fileId)) sourceByFile.set(p.fileId, p.source);

  for (const [fileId, source] of sourceByFile) {
    try {
      const url = resolveSourceUrl(source);
      const up = await client.uploadFromUrl(url);
      uploadCache.set(fileId, { id: up.id, path: up.path });
    } catch (e) {
      uploadCache.set(fileId, { error: errMsg(e) });
    }
  }

  const results: ScheduleItemResult[] = [];
  for (const p of posts) {
    const upload = uploadCache.get(p.fileId);
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
            value: [{ content, image: [{ id: upload.id }] }],
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
 * PostPeer leg: PostPeer pulls the media itself, so we send the PUBLIC URL (no
 * pre-upload). The public URL is resolved per file ONCE; a missing PUBLIC_BASE_URL
 * fails only that file's items with a clear, actionable message.
 */
async function schedulePostPeer(posts: SchedulePostInput[]): Promise<ScheduleItemResult[]> {
  if (posts.length === 0) return [];
  const client = createPostPeerClient();

  // Resolve each distinct file's PUBLIC media URL once (cache success or error).
  const urlCache = new Map<string, { url: string } | { error: string }>();
  const sourceByFile = new Map<string, FileSourceRef>();
  for (const p of posts) if (!sourceByFile.has(p.fileId)) sourceByFile.set(p.fileId, p.source);
  for (const [fileId, source] of sourceByFile) {
    try {
      urlCache.set(fileId, { url: resolvePublicSourceUrl(source) });
    } catch (e) {
      urlCache.set(fileId, { error: errMsg(e) });
    }
  }

  const results: ScheduleItemResult[] = [];
  for (const p of posts) {
    const resolved = urlCache.get(p.fileId);
    if (!resolved || "error" in resolved) {
      results.push({
        fileId: p.fileId,
        channelId: p.channelId,
        ok: false,
        error: resolved && "error" in resolved ? resolved.error : "Public media URL not resolved",
      });
      continue;
    }
    try {
      await client.createPost({
        accountId: p.channelId,
        mediaUrl: resolved.url,
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
