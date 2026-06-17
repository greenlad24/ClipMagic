/**
 * Thumbnail "art-director" pass.
 *
 * The first two recreation steps (replace character, change outfit to a t-shirt)
 * ALWAYS run. Steps 4–7 are optional and design-dependent, so we let Claude
 * vision LOOK at the STEP-2 RESULT image (the working image AFTER the character
 * + t-shirt edits — NOT the raw source thumbnail) and decide which apply,
 * filling the bracketed placeholders in four EXACT instruction templates.
 * recreate.ts then runs only the chosen steps, sending each FINAL prompt string
 * verbatim.
 *
 * The four optional steps it may return (each individually skippable):
 *   device-screen — change the character/screen inside an on-screen device.
 *   font          — restyle the headline text's font, keeping color + shape.
 *   bold-text     — make a specific text string bold.
 *   logo          — swap an icon/company logo for another of the same type.
 *
 * Each step's instruction MUST be built from its EXACT template — only the
 * bracket contents may be substituted; the surrounding text is never reworded.
 * The art-director assembles the final string itself (filling brackets) so the
 * chain can emit it untouched.
 *
 * Best-effort: any failure throws to the caller, which simply skips the optional
 * steps (the two mandatory edits already happened). Uses claudeVisionLabeledJSON
 * so usage is attributed to the "thumbnail-art-director" purpose in the report.
 */
import { claudeVisionLabeledJSON } from "../ai/claude.js";
import type { VideoType } from "./videoType.js";

export interface ArtDirectorStep {
  /** Stable id used in the chain record. */
  id: "device-screen" | "font" | "bold-text" | "logo";
  /** UI label. */
  label: string;
  /** Whether this edit should be applied to THIS thumbnail. */
  apply: boolean;
  /** The exact Nano Banana instruction to run when apply is true (template-filled). */
  instruction: string;
}

const STEP_META: Record<ArtDirectorStep["id"], string> = {
  "device-screen": "Replace device-screen content",
  font: "Restyle headline font",
  "bold-text": "Bolden headline text",
  logo: "Swap logo",
};

/**
 * The four EXACT optional-step templates (steps 4–7). Only the bracket contents
 * may be substituted; the surrounding wording is verbatim per the user's spec.
 * Exported so tests can assert the chain emits these untouched.
 *   4. device-screen
 *   5. font
 *   6. bold-text
 *   7. logo
 */
export const STEP_TEMPLATES = {
  "device-screen": "change the [character/screen] inside of the [device] - it needs to be a [content]",
  font: "I want to change the font of the [text] but keep it in the same [color] color the same simple text shape - just the font",
  "bold-text": 'I want to make the "[text]" in bold font',
  logo: "change the [icon/company] logo to another type of a [icon/company] logo",
} as const;

const SYSTEM =
  "You are an elite YouTube thumbnail art director. You are shown the CURRENT " +
  "working image of a thumbnail recreation: the character and outfit have ALREADY " +
  "been replaced (the character now wears a plain t-shirt). Decide which of FOUR " +
  "optional polish edits should be applied to make the recreation cleaner and more " +
  "click-worthy WITHOUT changing its core idea. Only apply an edit when the image " +
  "clearly warrants it (e.g. don't swap a logo if there is no logo, don't edit a " +
  "device screen if there is no on-screen device, don't restyle text if there is " +
  "no text). For each edit you apply, fill the bracketed placeholders in its FIXED " +
  "template with short, literal values describing what you SEE in the image. Never " +
  "reword the template text outside the brackets. Keep all edits brand-safe and " +
  "faithful to the composition.";

/**
 * Build the JSON-shaping user prompt. Pure + exported so the contract is
 * testable. The model fills the bracket slots of each template; we assemble the
 * final verbatim instruction from those slots in parseDirectorResponse.
 */
export function buildDirectorUserText(keyword: string, videoType: VideoType): string {
  return (
    `The video is a ${videoType} video about: "${keyword}".\n\n` +
    "For each optional edit, decide whether it applies to the image, and if so, " +
    "fill ONLY the bracketed slots of its fixed template. The templates are:\n" +
    `  device-screen: "${STEP_TEMPLATES["device-screen"]}"\n` +
    `  font:          "${STEP_TEMPLATES.font}"\n` +
    `  bold-text:     "${STEP_TEMPLATES["bold-text"]}"\n` +
    `  logo:          "${STEP_TEMPLATES.logo}"\n\n` +
    "Return ONLY this JSON object (no prose). Each slot is a short literal string " +
    "describing what you see; when apply is false, the slots may be empty:\n" +
    "{\n" +
    '  "device-screen": { "apply": boolean, "character_or_screen": string, "device": string, "content": string },\n' +
    '  "font": { "apply": boolean, "text": string, "color": string },\n' +
    '  "bold-text": { "apply": boolean, "text": string },\n' +
    '  "logo": { "apply": boolean, "icon_or_company": string, "target_icon_or_company": string }\n' +
    "}\n\n" +
    'Example device-screen slots: character_or_screen="screen", device="phone", content="bright app dashboard".'
  );
}

/**
 * Parse the director's JSON into an ordered, validated step list, assembling
 * each FINAL instruction from its EXACT template with only the bracket slots
 * substituted. Tolerates missing keys (treated as apply:false). A step only
 * applies when apply is true AND every required slot is a non-empty string (so
 * we never emit a template with leftover brackets). Pure + exported for unit
 * testing.
 */
export function parseDirectorResponse(json: any): ArtDirectorStep[] {
  const out: ArtDirectorStep[] = [];
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const pushStep = (id: ArtDirectorStep["id"], apply: boolean, instruction: string): void => {
    const ok = apply && instruction.length > 0;
    out.push({ id, label: STEP_META[id], apply: ok, instruction: ok ? instruction : "" });
  };

  // 4. device-screen — change the [character/screen] inside of the [device] - it needs to be a [content]
  {
    const node = json?.["device-screen"];
    const cs = str(node?.character_or_screen);
    const device = str(node?.device);
    const content = str(node?.content);
    const apply = node?.apply === true && !!cs && !!device && !!content;
    const inst = STEP_TEMPLATES["device-screen"]
      .replace("[character/screen]", cs)
      .replace("[device]", device)
      .replace("[content]", content);
    pushStep("device-screen", apply, inst);
  }

  // 5. font — I want to change the font of the [text] but keep it in the same [color] color ...
  {
    const node = json?.font;
    const text = str(node?.text);
    const color = str(node?.color);
    const apply = node?.apply === true && !!text && !!color;
    const inst = STEP_TEMPLATES.font.replace("[text]", text).replace("[color]", color);
    pushStep("font", apply, inst);
  }

  // 6. bold-text — I want to make the "[text]" in bold font
  {
    const node = json?.["bold-text"];
    const text = str(node?.text);
    const apply = node?.apply === true && !!text;
    const inst = STEP_TEMPLATES["bold-text"].replace("[text]", text);
    pushStep("bold-text", apply, inst);
  }

  // 7. logo — change the [icon/company] logo to another type of a [icon/company] logo
  {
    const node = json?.logo;
    const from = str(node?.icon_or_company);
    const to = str(node?.target_icon_or_company);
    const apply = node?.apply === true && !!from && !!to;
    // Two distinct [icon/company] slots: fill the first then the second.
    const inst = STEP_TEMPLATES.logo.replace("[icon/company]", from).replace("[icon/company]", to);
    pushStep("logo", apply, inst);
  }

  return out;
}

/**
 * Analyse the STEP-2 RESULT image (current working image) and return the ordered
 * optional steps. `imageBytes` is the post-outfit working image — NOT the source
 * thumbnail — so the director decides edits against what the recreation actually
 * looks like now. Injectable for tests.
 */
export async function artDirect(opts: {
  imageBytes: Buffer;
  imageMime: string;
  keyword: string;
  videoType: VideoType;
}): Promise<ArtDirectorStep[]> {
  const raw = await claudeVisionLabeledJSON({
    system: SYSTEM,
    userText: buildDirectorUserText(opts.keyword, opts.videoType),
    images: [
      {
        label: "Current working image (character + t-shirt already applied):",
        data: opts.imageBytes.toString("base64"),
        mediaType: opts.imageMime,
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
