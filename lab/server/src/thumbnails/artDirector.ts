/**
 * Thumbnail "art-director" pass — a smart YouTube thumbnail designer.
 *
 * The first two recreation steps (replace character, change outfit to a t-shirt)
 * ALWAYS run. The optional steps are design-dependent, so we let Claude vision
 * LOOK at the STEP-2 RESULT image (the working image AFTER the character +
 * t-shirt edits — NOT the raw source thumbnail) and decide which genuinely
 * improve click-through. recreate.ts then runs only the chosen steps, sending
 * each FINAL prompt string verbatim.
 *
 * The optional steps it may return (each individually skippable):
 *   device-screen — change the character/screen inside an on-screen device.
 *   font          — restyle the headline text's font, keeping color + shape.
 *   bold-text     — make a specific text string bold.
 *   text-rewrite  — rewrite the headline to a punchier, higher-CTR version,
 *                   ALWAYS keeping the brand/subject term (the keyword) intact.
 *   logo          — swap a GENERIC/unrelated stock icon for another of the same
 *                   type. The brand/subject's own logo or mascot is NEVER swapped.
 *
 * The structured steps device-screen / font / bold-text / logo are built from
 * EXACT templates — only the bracket contents may be substituted; the
 * surrounding text is never reworded. text-rewrite assembles a fixed-shape
 * instruction from the old + new headline. The art-director assembles the final
 * string itself (filling brackets) so the chain can emit it untouched.
 *
 * Conservative by design: each applied edit re-renders the whole frame and can
 * soften it, so the director applies ONLY what helps and NEVER touches the brand
 * subject (its mascot/logo or its name).
 *
 * Best-effort: any failure throws to the caller, which simply skips the optional
 * steps (the two mandatory edits already happened). Uses claudeVisionLabeledJSON
 * so usage is attributed to the "thumbnail-art-director" purpose in the report.
 */
import { claudeVisionLabeledJSON } from "../ai/claude.js";
import type { VideoType } from "./videoType.js";

export interface ArtDirectorStep {
  /** Stable id used in the chain record. */
  id: "device-screen" | "font" | "bold-text" | "text-rewrite" | "logo";
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
  "text-rewrite": "Rewrite headline text",
  logo: "Swap logo",
};

/**
 * The EXACT structured optional-step templates. Only the bracket contents may be
 * substituted; the surrounding wording is verbatim per the user's spec.
 * Exported so tests can assert the chain emits these untouched.
 *   device-screen / font / bold-text / text-rewrite / logo
 */
export const STEP_TEMPLATES = {
  "device-screen": "change the [character/screen] inside of the [device] - it needs to be a [content]",
  font: "I want to change the font of the [text] but keep it in the same [color] color the same simple text shape - just the font",
  "bold-text": 'I want to make the "[text]" in bold font',
  "text-rewrite": 'change the headline text from "[old]" to "[new]", keeping it in the same place, size and style',
  logo: "change the [icon/company] logo to another type of a [icon/company] logo",
} as const;

const SYSTEM =
  "You are a smart, elite YouTube thumbnail designer. You are shown the CURRENT " +
  "working image of a thumbnail recreation: the character and outfit have ALREADY " +
  "been replaced (the character now wears a plain t-shirt). Look at the image and " +
  "decide which optional polish edits would GENUINELY improve its click-through, " +
  "applying ONLY what helps. Be conservative: every edit you apply re-renders the " +
  "whole frame and can soften or distort it, so do NOT over-edit — skip an edit " +
  "unless it clearly makes the thumbnail better.\n\n" +
  "The video's brand/subject is given to you (the keyword). This is the SACRED " +
  "subject of the thumbnail. You must NEVER touch it: never rewrite away its name, " +
  "and never swap, restyle or replace its own logo or mascot. The logo swap is " +
  "ONLY for a generic, unrelated stock icon (e.g. a plain gear, bell, or generic " +
  "app glyph) — if an icon/logo/mascot IS the subject brand, set apply:false for " +
  "the logo step and leave it untouched.\n\n" +
  "Apply an edit only when the image clearly warrants it (e.g. don't swap a logo " +
  "if there is no generic logo, don't edit a device screen if there is no " +
  "on-screen device, don't restyle or rewrite text if there is no editable " +
  "headline). For text-rewrite, you may propose a punchier, higher-CTR headline " +
  "ONLY when there is editable headline text AND a better version genuinely helps " +
  "— and the rewritten headline MUST still contain the brand/subject word exactly. " +
  "For the structured edits, fill the bracketed placeholders in each FIXED " +
  "template with short, literal values describing what you SEE in the image. Never " +
  "reword the template text outside the brackets. Keep every edit brand-safe and " +
  "faithful to the composition.";

/**
 * Build the JSON-shaping user prompt. Pure + exported so the contract is
 * testable. The model fills the bracket slots of each template; we assemble the
 * final verbatim instruction from those slots in parseDirectorResponse.
 */
export function buildDirectorUserText(keyword: string, videoType: VideoType): string {
  return (
    `The video is a ${videoType} video about: "${keyword}".\n\n` +
    `The brand/subject term is "${keyword}". This is sacred: NEVER rewrite it away, ` +
    "and NEVER swap or restyle its own logo or mascot. The logo swap is ONLY for a " +
    "GENERIC, unrelated stock icon — if a logo/icon/mascot IS this brand/subject, " +
    "set its apply to false.\n\n" +
    "For each optional edit, decide whether it GENUINELY improves click-through, " +
    "and if so, fill ONLY the bracketed slots of its fixed template (text-rewrite " +
    "uses old + new headline). Be conservative — skip edits that don't clearly " +
    "help. The templates are:\n" +
    `  device-screen: "${STEP_TEMPLATES["device-screen"]}"\n` +
    `  font:          "${STEP_TEMPLATES.font}"\n` +
    `  bold-text:     "${STEP_TEMPLATES["bold-text"]}"\n` +
    `  text-rewrite:  "${STEP_TEMPLATES["text-rewrite"]}"\n` +
    `  logo:          "${STEP_TEMPLATES.logo}"\n\n` +
    "Return ONLY this JSON object (no prose). Each slot is a short literal string " +
    "describing what you see; when apply is false, the slots may be empty:\n" +
    "{\n" +
    '  "device-screen": { "apply": boolean, "character_or_screen": string, "device": string, "content": string },\n' +
    '  "font": { "apply": boolean, "text": string, "color": string },\n' +
    '  "bold-text": { "apply": boolean, "text": string },\n' +
    '  "text-rewrite": { "apply": boolean, "old": string, "new": string },\n' +
    '  "logo": { "apply": boolean, "icon_or_company": string, "target_icon_or_company": string }\n' +
    "}\n\n" +
    'Example device-screen slots: character_or_screen="screen", device="phone", content="bright app dashboard".\n' +
    `For text-rewrite, "new" MUST still contain the brand/subject word "${keyword}" exactly ` +
    "(e.g. rewrite a flat headline into a punchier hook that keeps the brand term). " +
    "For logo, leave the brand's own logo/mascot untouched (apply false); only swap a generic icon."
  );
}

/** Case/space-insensitive "does `text` contain the brand/subject term?" check. */
function containsBrand(text: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return true; // no brand term to protect → don't block
  return text.toLowerCase().includes(k);
}

/**
 * Parse the director's JSON into an ordered, validated step list, assembling
 * each FINAL instruction from its EXACT template with only the bracket slots
 * substituted. Tolerates missing keys (treated as apply:false). A step only
 * applies when apply is true AND every required slot is a non-empty string (so
 * we never emit a template with leftover brackets). Pure + exported for unit
 * testing.
 *
 * `keyword` is the brand/subject term. It guards two brand-safety rules:
 *   - text-rewrite: the new headline MUST still contain the brand term, else the
 *     rewrite is rejected (apply:false) so we never erase the subject.
 *   - logo: a generic-icon swap is rejected when either the source OR target
 *     icon IS the subject brand, so the brand's own logo/mascot is never touched.
 */
export function parseDirectorResponse(json: any, keyword = ""): ArtDirectorStep[] {
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

  // bold-text — I want to make the "[text]" in bold font
  {
    const node = json?.["bold-text"];
    const text = str(node?.text);
    const apply = node?.apply === true && !!text;
    const inst = STEP_TEMPLATES["bold-text"].replace("[text]", text);
    pushStep("bold-text", apply, inst);
  }

  // text-rewrite — change the headline text from "[old]" to "[new]", ...
  // Brand guard: the NEW headline must still contain the brand/subject term, so a
  // punchier rewrite can never erase the subject. No editable text → apply:false.
  {
    const node = json?.["text-rewrite"];
    const oldText = str(node?.old);
    const newText = str(node?.new);
    const apply =
      node?.apply === true && !!oldText && !!newText && oldText !== newText && containsBrand(newText, keyword);
    const inst = STEP_TEMPLATES["text-rewrite"].replace("[old]", oldText).replace("[new]", newText);
    pushStep("text-rewrite", apply, inst);
  }

  // logo — change the [icon/company] logo to another type of a [icon/company] logo
  // Brand guard: only swap a GENERIC/unrelated stock icon. If either the source
  // or the proposed target IS the brand/subject (its own logo/mascot), reject it.
  {
    const node = json?.logo;
    const from = str(node?.icon_or_company);
    const to = str(node?.target_icon_or_company);
    const touchesBrand = containsBrand(from, keyword) || containsBrand(to, keyword);
    const apply = node?.apply === true && !!from && !!to && !(keyword.trim() && touchesBrand);
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
  return parseDirectorResponse(parsed, opts.keyword);
}
