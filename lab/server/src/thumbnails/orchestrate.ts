/**
 * Orchestration for the Thumbnail Designer endpoints: download source
 * thumbnails, pick a DISTINCT expression per variant, run the recreation chain
 * per pick with PER-ITEM isolation (one failure never kills the batch) and
 * BOUNDED concurrency (these are slow API chains, so we run them sequentially).
 */
import { hqThumbnailUrl, maxresThumbnailUrl, mqThumbnailUrl } from "./youtube.js";
import { readCharacterImage, uploadedExpressions, type Expression } from "./characters.js";
import { expressionsForVariants, type VideoType } from "./videoType.js";
import { recreateThumbnail, type ChainStep, type RecreateDeps } from "./recreate.js";
import {
  createJob,
  updateVariant,
  finishVariant,
  completeJob,
  phasePercent,
  PHASE_LABEL,
  type ThumbnailJob,
} from "./jobs.js";

/** One generated variant returned to the UI. */
export interface ThumbnailVariant {
  videoId: string;
  /** The original YouTube thumbnail we recreated. */
  sourceThumbnailUrl: string;
  /** The generated 1920×1080 thumbnail (or null when this item failed). */
  outputUrl: string | null;
  expression: Expression;
  steps: ChainStep[];
  error?: string;
}

/** Fetch impl injectable for tests. Returns bytes + mime, or throws. */
export type DownloadFn = (url: string) => Promise<{ bytes: Buffer; mime: string }>;

const defaultDownload: DownloadFn = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`thumbnail download HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("thumbnail download returned no bytes");
  return { bytes, mime };
};

/**
 * Download a video's TRUE-16:9 source thumbnail for recreation: try maxresdefault
 * (1280×720, 16:9); if it isn't available, fall back to mqdefault (320×180, also
 * 16:9, always present). We NEVER feed hqdefault (4:3 letterboxed) into the chain
 * — that would bake black bars into every edit. Returns bytes + mime + URL used.
 */
export async function downloadSourceThumbnail(
  videoId: string,
  download: DownloadFn = defaultDownload,
): Promise<{ bytes: Buffer; mime: string; url: string }> {
  try {
    const maxUrl = maxresThumbnailUrl(videoId);
    const r = await download(maxUrl);
    return { ...r, url: maxUrl };
  } catch {
    const mqUrl = mqThumbnailUrl(videoId);
    const r = await download(mqUrl);
    return { ...r, url: mqUrl };
  }
}

export interface GenerateInput {
  keyword: string;
  videoType: VideoType;
  /** Picked video ids — any subset of the search results (no fixed cap). */
  picks: string[];
}

/**
 * Generate one recreated thumbnail per pick. Each pick gets a DISTINCT
 * expression (cycling through what's in the library, the video-type's primary
 * first). Runs sequentially with per-item try/catch so a single failure yields
 * an error variant instead of aborting the run.
 */
export async function generateThumbnailVariants(
  input: GenerateInput,
  download: DownloadFn = defaultDownload,
): Promise<ThumbnailVariant[]> {
  const picks = input.picks;
  const available = uploadedExpressions();
  const expressions = expressionsForVariants(input.videoType, picks.length, available);

  const variants: ThumbnailVariant[] = [];
  for (let i = 0; i < picks.length; i++) {
    const videoId = picks[i];
    const expression = expressions[i];
    try {
      if (!expression) throw new Error("No character expression available — upload at least one in the library.");
      const characterBytes = readCharacterImage(expression);
      if (!characterBytes) throw new Error(`Character image for "${expression}" is missing.`);

      const src = await downloadSourceThumbnail(videoId, download);
      const result = await recreateThumbnail({
        sourceBytes: src.bytes,
        sourceMime: src.mime,
        characterBytes,
        keyword: input.keyword,
        videoType: input.videoType,
        expression,
      });
      variants.push({
        videoId,
        sourceThumbnailUrl: src.url,
        outputUrl: result.outputUrl,
        expression,
        steps: result.steps,
      });
    } catch (e) {
      variants.push({
        videoId,
        sourceThumbnailUrl: hqThumbnailUrl(videoId),
        outputUrl: null,
        expression: expression ?? (available[0] as Expression),
        steps: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return variants;
}

// ── Async, observable generation ──────────────────────────────────────────────
// The endpoint creates a job (one variant per pick), returns its id IMMEDIATELY,
// then runs THIS in the background. It mirrors `generateThumbnailVariants`'
// per-pick, per-item-isolated, sequential flow — but drives the progress store
// instead of returning an array, so the UI can poll live status and see each
// thumbnail land the moment it finishes. `recreateDeps` is injectable so tests
// run with no network / AI / ffmpeg.

/** Start a generation job: create it, kick the runner off, return the job. */
export function startThumbnailJob(
  input: GenerateInput,
  download: DownloadFn = defaultDownload,
  recreateDeps?: RecreateDeps,
): ThumbnailJob {
  const available = uploadedExpressions();
  const expressions = expressionsForVariants(input.videoType, input.picks.length, available);
  // Seed one queued variant per pick. The source URL starts as the always-exists
  // hqdefault so the UI shows the original immediately; it's upgraded to the
  // actual downloaded URL (maxres when available) once the fetch phase runs.
  const job = createJob(
    input.picks.map((videoId, i) => ({
      videoId,
      sourceThumbnailUrl: hqThumbnailUrl(videoId),
      expression: expressions[i] ?? (available[0] as string) ?? "smile",
    })),
  );
  // Fire-and-forget. runThumbnailJob never throws (it records onto the job).
  void runThumbnailJob(job, input, expressions, available, download, recreateDeps);
  return job;
}

/**
 * Drive a generation job to completion. Sequential (one pick at a time) for
 * clear, coherent progress; per-pick try/catch so one failure becomes that
 * variant's error and the rest still finish. Never throws.
 */
export async function runThumbnailJob(
  job: ThumbnailJob,
  input: GenerateInput,
  expressions: Expression[],
  available: Expression[],
  download: DownloadFn = defaultDownload,
  recreateDeps?: RecreateDeps,
): Promise<void> {
  try {
    for (let i = 0; i < input.picks.length; i++) {
      const videoId = input.picks[i];
      const expression = expressions[i];
      updateVariant(job, i, { status: "running", stepLabel: PHASE_LABEL.fetch, percent: phasePercent("fetch", 0) });
      try {
        if (!expression) throw new Error("No character expression available — upload at least one in the library.");
        const characterBytes = readCharacterImage(expression);
        if (!characterBytes) throw new Error(`Character image for "${expression}" is missing.`);

        const src = await downloadSourceThumbnail(videoId, download);
        // Upgrade to the real source URL (maxres when it existed) + close the fetch band.
        updateVariant(job, i, {
          stepLabel: PHASE_LABEL.replaceCharacter,
          percent: phasePercent("fetch", 1),
        });
        job.variants[i].sourceThumbnailUrl = src.url;

        const result = await recreateThumbnail(
          {
            sourceBytes: src.bytes,
            sourceMime: src.mime,
            characterBytes,
            keyword: input.keyword,
            videoType: input.videoType,
            expression,
            onProgress: ({ stepLabel, percent }) => updateVariant(job, i, { stepLabel, percent }),
          },
          recreateDeps,
        );
        // Surface the output the MOMENT this variant finishes.
        finishVariant(job, i, { outputUrl: result.outputUrl });
      } catch (e) {
        finishVariant(job, i, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    completeJob(job);
  } catch (e) {
    // Defensive: the loop is fully guarded, but never leave a job un-terminated.
    completeJob(job, e instanceof Error ? e.message : String(e));
  }
}
