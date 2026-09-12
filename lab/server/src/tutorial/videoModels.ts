/**
 * The apimart models Tutorial Studio can render its talking-head clip with.
 *
 * MIRRORS tutorial-studio/scripts/video_models.py. This side offers the choice
 * and writes the script for it; the sidecar validates and renders it — so a
 * drift between the two tables is a model the UI offers and the pipeline
 * refuses (deliberately a 400, not a silent fallback to Wan).
 *
 * `seconds` is the ONE clip length a model renders here, not a ceiling the
 * operator may lower. MiniMax H3 caps a single clip at 15s while Wan 3.0 does
 * the 30s the reel format was built around, so PICKING THE MODEL PICKS THE
 * REEL'S LENGTH — and the scripter has to be told, or a 30s script gets cut off
 * halfway through the second step it was teaching.
 */

export interface VideoModelSpec {
  id: string;
  label: string;
  /** Clip length this model renders, and the length its script is written for. */
  seconds: number;
  resolutions: string[];
  defaultResolution: string;
  /** What to tell the operator about the trade-off, in one line. */
  note: string;
}

export const VIDEO_MODELS: VideoModelSpec[] = [
  {
    id: "wan3.0-video",
    label: "Wan 3.0",
    seconds: 30,
    resolutions: ["480P", "720P", "1080P"],
    defaultResolution: "720P",
    note: "The original path: one continuous 30s clip, about $2 of the ~$2.45 reel.",
  },
  {
    id: "MiniMax-H3",
    label: "MiniMax H3",
    seconds: 15,
    resolutions: ["768P", "2K"],
    defaultResolution: "768P",
    note: "Caps a clip at 15s, so its reels are 15s and their scripts are written that short.",
  },
];

export const DEFAULT_VIDEO_MODEL = "wan3.0-video";

export function videoModel(id: string): VideoModelSpec {
  return VIDEO_MODELS.find((m) => m.id === id) || VIDEO_MODELS[0];
}

/**
 * Settle a (model, resolution) pair to something the sidecar will accept.
 * Unknown values fall back rather than travelling on to apimart as a 400.
 */
export function normalizeVideoModel(
  id: string,
  resolution: string,
): { model: string; resolution: string; seconds: number } {
  const spec = videoModel(id);
  return {
    model: spec.id,
    resolution: spec.resolutions.includes(resolution) ? resolution : spec.defaultResolution,
    seconds: spec.seconds,
  };
}

/** The clip length a script for this model must be written for. */
export function targetSeconds(id: string): number {
  return videoModel(id).seconds;
}
