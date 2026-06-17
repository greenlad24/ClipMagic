/**
 * Orchestration for the Thumbnail Designer endpoints: download source
 * thumbnails, pick a DISTINCT expression per variant, run the recreation chain
 * per pick with PER-ITEM isolation (one failure never kills the batch) and
 * BOUNDED concurrency (these are slow API chains, so we run them sequentially).
 */
import { maxresThumbnailUrl, hqThumbnailUrl } from "./youtube.js";
import { readCharacterImage, uploadedExpressions, type Expression } from "./characters.js";
import { expressionsForVariants, type VideoType } from "./videoType.js";
import { recreateThumbnail, type ChainStep } from "./recreate.js";

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
 * Download a video's best-available thumbnail: try maxresdefault, fall back to
 * hqdefault (which always exists). Returns bytes + mime.
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
    const hqUrl = hqThumbnailUrl(videoId);
    const r = await download(hqUrl);
    return { ...r, url: hqUrl };
  }
}

export interface GenerateInput {
  keyword: string;
  videoType: VideoType;
  /** Up to 3 picked video ids. */
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
  const picks = input.picks.slice(0, 3);
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
