/**
 * Running a spine plan end to end.
 *
 * Gathers the two halves the planner reasons over — what is already in the
 * classroom, and what is on the channel but not in it — and hands them to the
 * model. Nothing here writes to Skool.
 *
 * The plan is stamped with the INVENTORY ID it was built from. A plan is only
 * as good as the snapshot under it, and the write path must refuse a plan whose
 * classroom has moved on rather than write to positions that no longer exist.
 */
import { fetchChannelProfile, fetchVideoStats, resolveChannelId } from "../thumbnails/youtube.js";
import type { SkoolInventory } from "./classroom.js";
import { buildItems, planSpine, youtubeIdOf, type RequiredTrack, type SpinePlan } from "./spine.js";

/** Anything at or below this is a Short, not a lesson. */
const SHORTS_MAX_SECONDS = 180;

/** The channel's uploads cap. Lift if a channel outgrows it — it is not a limit. */
const MAX_UPLOADS = 200;

export interface MissingVideo {
  videoId: string;
  title: string;
  views: number | null;
  publishedAt: string | null;
}

/**
 * Long-form uploads that are not already in the classroom.
 *
 * Matched by YouTube id, never by title: the classroom's titles have been
 * rewritten from the video titles ("How to Scrape UNLIMITED LinkedIn Leads" is
 * in there as "How to Scrape UNLIMITED LinkedIn Leads", but plenty are not),
 * and a title match would silently re-add lessons that already exist.
 */
export async function findMissingVideos(
  inventory: SkoolInventory,
  channelUrlOrId: string,
): Promise<{ missing: MissingVideo[]; longFormTotal: number; alreadyIn: number; error: string | null }> {
  const resolved = await resolveChannelId(channelUrlOrId);
  if (!resolved) {
    return { missing: [], longFormTotal: 0, alreadyIn: 0, error: `Could not resolve a channel from "${channelUrlOrId}".` };
  }

  const profile = await fetchChannelProfile(resolved.channelId, MAX_UPLOADS);
  if (!profile) {
    return { missing: [], longFormTotal: 0, alreadyIn: 0, error: "That channel returned no profile." };
  }

  const stats = await fetchVideoStats(profile.uploads.map((u) => u.videoId));
  const inClassroom = new Set<string>();
  for (const course of inventory.courses) {
    for (const unit of course.units) {
      const id = youtubeIdOf(unit.videoUrl);
      if (id) inClassroom.add(id);
    }
  }

  const longForm = profile.uploads
    .map((u) => ({ ...u, ...(stats.get(u.videoId) ?? {}) }))
    .filter((u: any) => (u.durationSeconds ?? 0) > SHORTS_MAX_SECONDS);

  const missing: MissingVideo[] = longForm
    .filter((u: any) => !inClassroom.has(u.videoId))
    .map((u: any) => ({
      videoId: u.videoId,
      title: u.title,
      views: u.views ?? null,
      publishedAt: (u.publishedAt ?? "").slice(0, 10) || null,
    }))
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));

  return {
    missing,
    longFormTotal: longForm.length,
    alreadyIn: longForm.length - missing.length,
    error: null,
  };
}

export interface PlanResult extends SpinePlan {
  /** What the plan was built from, so a stored plan can explain itself later. */
  source: {
    community: string | null;
    itemsFromClassroom: number;
    itemsFromChannel: number;
    longFormTotal: number;
    alreadyIn: number;
    channelError: string | null;
  };
}

export async function runPlan(opts: {
  inventory: SkoolInventory;
  channelUrl: string;
  roadmap: string;
  requiredTracks?: RequiredTrack[];
}): Promise<PlanResult> {
  const { inventory, channelUrl, roadmap, requiredTracks } = opts;

  // A channel that cannot be read is NOT fatal: a spine over the existing
  // classroom is still worth having. It is recorded so the plan cannot be
  // mistaken for one that considered the whole catalogue.
  const found = channelUrl.trim()
    ? await findMissingVideos(inventory, channelUrl)
    : { missing: [], longFormTotal: 0, alreadyIn: 0, error: "No channel is set, so no missing lessons were considered." };

  // Voice reference for authoring: the creator's own longest written lessons.
  // Longest rather than newest — a 30k-char companion shows structure and
  // formatting habits that a 3k one does not.
  const voiceSamples = inventory.courses
    .flatMap((c) => c.units)
    .filter((u) => u.contentChars > 2000)
    .sort((a, b) => b.contentChars - a.contentChars)
    .slice(0, 2)
    .map((u) => u.content.slice(0, 6000));

  const { items, emptyModulesDropped } = buildItems(inventory, found.missing);
  const plan = await planSpine(items, emptyModulesDropped, {
    communityName: inventory.community,
    roadmap,
    requiredTracks,
    voiceSamples,
  });

  return {
    ...plan,
    source: {
      community: inventory.community,
      itemsFromClassroom: items.filter((i) => i.kind === "unit").length,
      itemsFromChannel: items.filter((i) => i.kind === "video").length,
      longFormTotal: found.longFormTotal,
      alreadyIn: found.alreadyIn,
      channelError: found.error,
    },
  };
}
