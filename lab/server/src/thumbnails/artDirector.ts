/**
 * Thumbnail "art-director" pass.
 *
 * The first two recreation steps (replace character, change outfit) ALWAYS run.
 * Steps 3–6 are optional and design-dependent, so we let Claude vision LOOK at
 * the source thumbnail and decide which apply — emitting the exact gsk-style
 * instruction string for each. recreate.ts then runs only the chosen steps.
 *
 * The four optional steps it may return (each individually skippable):
 *   font          — restyle the headline text in a punchier font.
 *   bold-text     — make the headline bolder / higher-contrast for readability.
 *   logo          — swap a brand/channel logo (only if one is clearly present).
 *   device-screen — replace the content shown on an on-screen device/monitor.
 *
 * Best-effort: any failure throws to the caller, which simply skips the optional
 * steps (the two mandatory edits already happened). Uses claudeVisionLabeledJSON
 * so usage is attributed to the "thumbnail-art-director" purpose in the report.
 */
import { claudeVisionLabeledJSON } from "../ai/claude.js";
import type { VideoType } from "./videoType.js";

export interface ArtDirectorStep {
  /** Stable id used in the chain record. */
  id: "font" | "bold-text" | "logo" | "device-screen";
  /** UI label. */
  label: string;
  /** Whether this edit should be applied to THIS thumbnail. */
  apply: boolean;
  /** The exact Nano Banana instruction to run when apply is true. */
  instruction: string;
}

const STEP_META: Record<ArtDirectorStep["id"], string> = {
  font: "Restyle headline font",
  "bold-text": "Bolden headline text",
  logo: "Swap logo",
  "device-screen": "Replace device-screen content",
};

const SYSTEM =
  "You are an elite YouTube thumbnail art director. You are shown ONE source " +
  "thumbnail that is being recreated. The character and outfit have already been " +
  "replaced. Decide which of FOUR optional polish edits should be applied to make " +
  "the recreation cleaner and more click-worthy WITHOUT changing its core idea. " +
  "Only apply an edit when the source clearly warrants it (e.g. don't swap a logo " +
  "if there is no logo, don't edit a device screen if there is no device). For " +
  "each edit you apply, write a precise, literal image-edit instruction. Keep all " +
  "edits brand-safe and faithful to the original composition.";

/**
 * Build the JSON-shaping user prompt. Pure + exported so the contract is
 * testable. The model must return an object keyed by the four step ids.
 */
export function buildDirectorUserText(keyword: string, videoType: VideoType): string {
  return (
    `The video is a ${videoType} video about: "${keyword}".\n\n` +
    "Return ONLY this JSON object (no prose):\n" +
    "{\n" +
    '  "font": { "apply": boolean, "instruction": string },\n' +
    '  "bold-text": { "apply": boolean, "instruction": string },\n' +
    '  "logo": { "apply": boolean, "instruction": string },\n' +
    '  "device-screen": { "apply": boolean, "instruction": string }\n' +
    "}\n\n" +
    "Rules: instruction must be a single literal edit command (e.g. \"make the " +
    "headline text bold and high-contrast white with a thin black outline\"). " +
    "When apply is false, instruction may be an empty string."
  );
}

/**
 * Parse the director's JSON into an ordered, validated step list. Tolerates
 * missing keys (treated as apply:false). Pure + exported for unit testing.
 */
export function parseDirectorResponse(json: any): ArtDirectorStep[] {
  const ids: ArtDirectorStep["id"][] = ["font", "bold-text", "logo", "device-screen"];
  const out: ArtDirectorStep[] = [];
  for (const id of ids) {
    const node = json?.[id];
    const apply = node?.apply === true;
    const instruction = typeof node?.instruction === "string" ? node.instruction.trim() : "";
    out.push({ id, label: STEP_META[id], apply: apply && instruction.length > 0, instruction });
  }
  return out;
}

export async function artDirect(opts: {
  sourceBytes: Buffer;
  sourceMime: string;
  keyword: string;
  videoType: VideoType;
}): Promise<ArtDirectorStep[]> {
  const raw = await claudeVisionLabeledJSON({
    system: SYSTEM,
    userText: buildDirectorUserText(opts.keyword, opts.videoType),
    images: [
      {
        label: "Source thumbnail being recreated:",
        data: opts.sourceBytes.toString("base64"),
        mediaType: opts.sourceMime,
      },
    ],
    purpose: "thumbnail-art-director",
  });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("art-director returned non-JSON");
  }
  return parseDirectorResponse(parsed);
}
