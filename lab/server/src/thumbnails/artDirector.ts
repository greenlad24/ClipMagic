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
 *   text-rewrite  — rewrite EVERY editable text element (e.g. a headline AND a
 *                   secondary line like "24/7 AI EMPLOYEE") to a punchier,
 *                   higher-CTR version so the recreation's copy no longer mirrors
 *                   the original — ALWAYS keeping the brand/subject term (the
 *                   keyword) intact in at least the main text, and NEVER inventing
 *                   a different brand. The director returns an ARRAY of {old,new}
 *                   rewrites; each becomes its own edit instruction.
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
  "text-rewrite": "Rewrite text",
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
  "text-rewrite": 'change the text "[old]" to "[new]", keeping it in the same place, size and style',
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
  "text). For text-rewrite, rewrite EVERY editable text element in the thumbnail " +
  "(e.g. a main headline AND any secondary line like \"24/7 AI EMPLOYEE\") into " +
  "punchier, higher-CTR copy, so the recreation's text no longer mirrors the " +
  "original — return ONE {old,new} pair per distinct text block you want to " +
  "change. The MAIN text's new version MUST still contain the brand/subject word " +
  "exactly, and you must NEVER invent a different brand name in any rewrite. Only " +
  "rewrite text that genuinely exists and a better version helps. " +
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
    "returns an ARRAY of {old,new} pairs — one per editable text block). Be " +
    "conservative — skip edits that don't clearly help. The templates are:\n" +
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
    '  "text-rewrite": { "apply": boolean, "rewrites": [ { "old": string, "new": string } ] },\n' +
    '  "logo": { "apply": boolean, "icon_or_company": string, "target_icon_or_company": string }\n' +
    "}\n\n" +
    'Example device-screen slots: character_or_screen="screen", device="phone", content="bright app dashboard".\n' +
    `For text-rewrite, include ONE {old,new} pair for EACH editable text block you want to change ` +
    `(e.g. the headline AND a secondary line). At least the MAIN text's "new" MUST still contain the ` +
    `brand/subject word "${keyword}" exactly, and NO rewrite may introduce a different brand name. ` +
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
 *   - text-rewrite: rewrites EVERY editable text block (an array of {old,new}).
 *     At least one rewrite (the main text) MUST still contain the brand term, else
 *     the WHOLE text-rewrite is rejected so we never erase the subject. Each
 *     rewrite becomes its OWN step (so the chain runs one edit per text block);
 *     when none keeps the brand, none are emitted.
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

  // text-rewrite — change the text "[old]" to "[new]", ... (ONE per text block)
  // Brand guard: at least ONE rewrite's NEW text must still contain the brand/
  // subject term (the main text), so the recreation can never erase the subject.
  // Each valid rewrite becomes its OWN step; if none keeps the brand (or there is
  // no editable text), NONE are emitted and a disabled placeholder is recorded so
  // the step is still visible in the chain breakdown.
  {
    const node = json?.["text-rewrite"];
    // Accept the new array shape (rewrites: [{old,new}]) AND the legacy single
    // {old,new} for back-compat. Keep only well-formed, changing pairs.
    const rawList: any[] = Array.isArray(node?.rewrites)
      ? node.rewrites
      : node && (node.old !== undefined || node.new !== undefined)
        ? [{ old: node.old, new: node.new }]
        : [];
    const pairs = rawList
      .map((r) => ({ old: str(r?.old), new: str(r?.new) }))
      .filter((r) => !!r.old && !!r.new && r.old !== r.new);
    const keepsBrand = pairs.some((r) => containsBrand(r.new, keyword));
    const apply = node?.apply === true && pairs.length > 0 && keepsBrand;
    if (apply) {
      // Emit one instruction per text block, each verbatim from the template.
      for (const r of pairs) {
        const inst = STEP_TEMPLATES["text-rewrite"].replace("[old]", r.old).replace("[new]", r.new);
        out.push({ id: "text-rewrite", label: STEP_META["text-rewrite"], apply: true, instruction: inst });
      }
    } else {
      // Visible-but-skipped placeholder (mirrors pushStep's disabled shape).
      out.push({ id: "text-rewrite", label: STEP_META["text-rewrite"], apply: false, instruction: "" });
    }
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

/**
 * The "swap-director" vision pass — run on the CURRENT working image (the
 * post-background image, just BEFORE the final character swap). It reports the
 * on-camera person's BODY so the swap can make the body follow the new face: a
 * recreation often starts from someone with an oversized/costume/mascot build,
 * and the swapped-in man has a natural, average frame. Without this, the swap
 * keeps the original (mismatched) body and just pastes the new face on it.
 *
 * The assessment is identity-INDEPENDENT (it's about the original person's
 * build/framing, not who's about to be swapped in), so running it on the working
 * image before the swap is fine. It is best-effort — see analyzeForSwap.
 */
export interface SwapAssessment {
  /** Short literal description of the on-camera person's CURRENT build, e.g. "oversized/bulky mascot-costume torso" or "natural average build". */
  currentBuild: string;
  /** Is the person's body (not just a head/face) actually visible in the frame? */
  bodyVisible: boolean;
  /** Short literal framing note, e.g. "chest-up close-up" or "full-body, centred". */
  framing: string;
}

const SWAP_DIRECTOR_SYSTEM =
  "You are a thumbnail compositing assistant. You are shown the CURRENT working " +
  "image of a YouTube thumbnail recreation, taken just BEFORE the on-camera person " +
  "is replaced with a different man. Look ONLY at the on-camera person's BODY and " +
  "how they are framed — NOT their face or identity. We need to know whether the " +
  "current person has a normal, average human build or an unusually large, bulky, " +
  "costumed, mascot-like, muscular or otherwise oversized/mismatched build, because " +
  "the replacement man has a natural, medium, slightly-fit average frame and his " +
  "body must end up matching HIS face. Describe what you literally SEE in short, " +
  "plain words.";

/**
 * Build the swap-director's JSON-shaping user prompt. Pure + exported so the
 * contract is testable without the network.
 */
export function buildSwapDirectorUserText(): string {
  return (
    "Assess ONLY the on-camera person's body and framing. Return ONLY this JSON " +
    "object (no prose):\n" +
    "{\n" +
    '  "currentBuild": string,  // short literal description of the body, e.g. "oversized/bulky mascot-costume torso", "very muscular bodybuilder frame", or "natural average build"\n' +
    '  "bodyVisible": boolean,  // is the torso/body (not just a head) actually visible?\n' +
    '  "framing": string        // short literal framing note, e.g. "chest-up close-up" or "full-body, centred"\n' +
    "}\n"
  );
}

/** Coerce a raw model object into a safe SwapAssessment (tolerant of junk). */
export function parseSwapAssessment(json: any): SwapAssessment {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return {
    currentBuild: str(json?.currentBuild),
    bodyVisible: json?.bodyVisible === true,
    framing: str(json?.framing),
  };
}

/**
 * Heuristic: does the assessed build read as LARGE / mismatched relative to a
 * natural average man? When true, the final swap gets an EXPLICIT "do not keep
 * this body — resize it" clause; otherwise the static body clause is enough.
 * Pure + exported for unit testing.
 */
export function buildLooksOversized(currentBuild: string): boolean {
  const b = currentBuild.toLowerCase();
  if (!b) return false;
  return /oversiz|bulk|mascot|costume|muscul|massive|huge|large|wide|broad|hulk|giant|burly|stocky|heavy|fat|obese|big[\s-]?bod|barrel/.test(
    b,
  );
}

/**
 * Analyse the CURRENT working image (post-background, pre-swap) and return a
 * short structured body/framing assessment. Injectable for tests; best-effort in
 * the chain (the caller falls back to the static swap prompt on any throw). Uses
 * claudeVisionLabeledJSON so usage is attributed to "thumbnail-swap-director".
 */
export async function analyzeForSwap(opts: {
  imageBytes: Buffer;
  imageMime: string;
}): Promise<SwapAssessment> {
  const raw = await claudeVisionLabeledJSON({
    system: SWAP_DIRECTOR_SYSTEM,
    userText: buildSwapDirectorUserText(),
    images: [
      {
        label: "Current working image (the on-camera person about to be replaced):",
        data: opts.imageBytes.toString("base64"),
        mediaType: opts.imageMime,
      },
    ],
    purpose: "thumbnail-swap-director",
  });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("swap-director returned non-JSON");
  }
  return parseSwapAssessment(parsed);
}
