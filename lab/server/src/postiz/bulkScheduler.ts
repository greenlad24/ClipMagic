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
import { toShortPlatform, buildProviderSettings, type ShortPlatform } from "./providerSettings.js";
import { generateCaptions, type PlatformCaption } from "./captions.js";
import { buildSchedule, type Intent, type ScheduleItemInput } from "./scheduling.js";
import { resolveSourceUrl, type FileSourceRef } from "./fileSources.js";

// ── status / channels ────────────────────────────────────────────────────────
export async function getStatus(): Promise<{ apiKeyConfigured: boolean; channelCount: number; channels: ChannelDto[]; error?: string }> {
  const apiKeyConfigured = postizApiConfigured();
  if (!apiKeyConfigured) return { apiKeyConfigured: false, channelCount: 0, channels: [] };
  try {
    const channels = await listChannels();
    return { apiKeyConfigured: true, channelCount: channels.length, channels };
  } catch (e) {
    // Configured but Postiz unreachable / key invalid — report it without leaking the key.
    return { apiKeyConfigured: true, channelCount: 0, channels: [], error: errMsg(e) };
  }
}

export interface ChannelDto {
  id: string;
  name: string;
  identifier: string;
  /** Our canonical short-form platform, or null if not a tuned short platform. */
  platform: ShortPlatform | null;
  picture?: string;
  profile?: string;
}

function toChannelDto(it: PostizIntegration): ChannelDto {
  return {
    id: it.id,
    name: it.name,
    identifier: it.identifier,
    platform: toShortPlatform(it.identifier),
    picture: it.picture,
    profile: it.profile,
  };
}

/** Connected (non-disabled) channels. */
export async function listChannels(): Promise<ChannelDto[]> {
  const client = createPostizClient();
  const integrations = await client.listIntegrations();
  return integrations.filter((i) => !i.disabled).map(toChannelDto);
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
  channelName: string;
  identifier: string;
  platform: ShortPlatform;
  caption: string;
  firstLineHook: string;
  hashtags: string[];
  scheduledAt: string;
  reason: string;
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
    for (const c of targets) {
      const cap = caps[c.platform!];
      const sched = scheduleByKey.get(`${f.fileId}|${c.id}`)!;
      posts.push({
        fileId: f.fileId,
        channelId: c.id,
        channelName: c.name,
        identifier: c.identifier,
        platform: c.platform!,
        caption: cap?.caption ?? "",
        firstLineHook: cap?.firstLineHook ?? "",
        hashtags: cap?.hashtags ?? [],
        scheduledAt: sched.scheduledAt,
        reason: sched.reason,
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
  identifier: string;
  caption: string;
  hashtags: string[];
  /** SEO title/hook — used as the YouTube video title. */
  firstLineHook?: string;
  scheduledAt: string;
}

export interface ScheduleItemResult {
  fileId: string;
  channelId: string;
  ok: boolean;
  error?: string;
}

export interface ScheduleOutput {
  results: ScheduleItemResult[];
  scheduled: number;
  failed: number;
}

export async function schedule(input: { posts: SchedulePostInput[] }): Promise<ScheduleOutput> {
  const client = createPostizClient();
  const posts = Array.isArray(input.posts) ? input.posts : [];

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

  const scheduled = results.filter((r) => r.ok).length;
  return { results, scheduled, failed: results.length - scheduled };
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
  if (e instanceof PostizApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
