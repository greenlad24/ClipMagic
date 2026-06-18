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
 *   text-rewrite  — TWO jobs. (1) MANDATORY main-title→keyword: the source
 *                   thumbnail came from a DIFFERENT video, so its big title often
 *                   shows a different/older product name (e.g. "CLAWDBOT" when the
 *                   keyword is "OpenClaw"); that title is rewritten TO the keyword.
 *                   (2) PROACTIVE secondary rewrite: a tagline/sub-line (like "Full
 *                   Guide" or "24/7 AI EMPLOYEE") is rewritten to a fresh,
 *                   equally-relevant variant so the copy isn't an exact copy. A
 *                   brand OTHER than the keyword is NEVER invented. The director
 *                   returns an ARRAY of {old,new} rewrites; each becomes its own edit.
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
import { expressionForVideoType, type VideoType } from "./videoType.js";
import type { Expression } from "./characters.js";

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
  "The video's brand/subject is the KEYWORD given to you. The keyword — and ONLY " +
  "the keyword — is the sacred subject of THIS thumbnail. Its mascot/logo is also " +
  "sacred: never swap, restyle or replace the subject's own logo or mascot. The " +
  "logo swap is ONLY for a generic, unrelated stock icon (e.g. a plain gear, bell, " +
  "or generic app glyph) — if an icon/logo/mascot IS the subject, set apply:false " +
  "for the logo step and leave it untouched.\n\n" +
  "CRITICAL — the MAIN TITLE must be the keyword. You are recreating a thumbnail " +
  "that originally belonged to a DIFFERENT video, so its big main title often shows " +
  "a DIFFERENT or OLDER product/brand NAME (e.g. the title reads \"CLAWDBOT\" but " +
  "the keyword is \"OpenClaw\" — the same thing under a new name, or a competitor). " +
  "Because THIS video is about the keyword, you MUST rewrite that main title text " +
  "to the keyword EXACTLY whenever the displayed title is a product/brand name that " +
  "is not already the keyword. This title rewrite is the MOST IMPORTANT one — never " +
  "leave a different or old product name as the headline. Analyse the text first: " +
  "identify the main title, compare it to the keyword, and if they differ, rewrite " +
  "the title to the keyword.\n\n" +
  "Apply an edit only when the image clearly warrants it (e.g. don't swap a logo " +
  "if there is no generic logo, don't edit a device screen if there is no " +
  "on-screen device). TEXT-REWRITE IS THE EXCEPTION — be PROACTIVE and THOROUGH " +
  "with it. Beyond the mandatory main-title→keyword rewrite above, rewrite EVERY " +
  "OTHER distinct, readable text block in the thumbnail into a fresh, " +
  "equally-relevant, punchier variant so the recreation's wording is clearly a " +
  "little different from the original instead of an exact copy. This INCLUDES: " +
  "sub-headlines and taglines (e.g. \"Full Guide\" → \"Complete Breakdown\"), " +
  "corner badges (e.g. \"new\" → \"hot\"), AND — importantly — any text shown " +
  "INSIDE an on-screen device, app, chat bubble, button or computer/phone screen " +
  "(e.g. a typed message like \"Make me $100K\" or a reply like \"On it.\"). Do not " +
  "stop after one rewrite — return one {old,new} pair for EACH readable text block " +
  "you change, including the ones inside devices. Keep each rewrite the same intent " +
  "and roughly the same length so it fits the original's space. NEVER invent a " +
  "brand name OTHER than the keyword in any rewrite, and only rewrite text that " +
  "genuinely exists. " +
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
    `The brand/subject of THIS video is the keyword "${keyword}". Its mascot/logo is ` +
    "sacred: NEVER swap or restyle the subject's own logo or mascot (the logo swap " +
    "is ONLY for a GENERIC, unrelated stock icon — if a logo/icon/mascot IS this " +
    "subject, set its apply to false).\n\n" +
    `IMPORTANT — analyse the text first. The big MAIN TITLE in this image came from a ` +
    `DIFFERENT original video and may show a DIFFERENT or OLDER product/brand name ` +
    `than "${keyword}" (e.g. it reads "CLAWDBOT" while the keyword is "OpenClaw" — the ` +
    `same product, new name). If the main title's text is a product/brand name that is ` +
    `NOT already "${keyword}", you MUST rewrite that main title to "${keyword}" exactly ` +
    `via a text-rewrite {old,new} pair. This is the most important rewrite — the ` +
    `headline of the recreation must be "${keyword}", not the original's name.\n\n` +
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
    `For text-rewrite: FIRST, if the main title shows a product/brand name that is not "${keyword}", ` +
    `include a {old,new} pair rewriting it to "${keyword}" (the mandatory main-title→keyword rewrite). ` +
    `THEN be PROACTIVE and THOROUGH: rewrite EVERY other distinct readable text block into a fresh, ` +
    `equally-relevant variant — taglines/sub-lines (like "Full Guide" or "24/7 AI EMPLOYEE"), corner ` +
    `badges (like "new" → "hot"), AND any text inside an on-screen device/app/chat/button/computer screen ` +
    `(like a typed "Make me $100K" or a reply "On it."). Return one {old,new} pair PER block you change ` +
    `(don't stop after one). NO rewrite may introduce a brand name OTHER than "${keyword}". For logo, ` +
    `leave the subject's own logo/mascot untouched (apply false); only swap a generic icon.`
  );
}

/** Case/space-insensitive "does `text` contain the brand/subject term?" check. */
function containsBrand(text: string, keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return true; // no brand term to protect → don't block
  return text.toLowerCase().includes(k);
}

/** One proposed text change on a thumbnail: rewrite `old` → `new`. */
export interface TextRewrite {
  old: string;
  new: string;
}

/** Assemble the EXACT text-rewrite instruction from a pair (verbatim template). */
export function buildTextRewriteInstruction(oldText: string, newText: string): string {
  return STEP_TEMPLATES["text-rewrite"].replace("[old]", oldText).replace("[new]", newText);
}

/**
 * Parse the text-rewrite node (the array shape `{ rewrites:[{old,new}] }`, or the
 * legacy single `{old,new}`) into validated, brand-safe pairs. The brand guard is
 * PER-REWRITE: a rewrite may never ERASE the brand from a block that contained it
 * (old has the brand → new must keep it); a rewrite of a line that never had the
 * brand is always allowed. Pure + exported; shared by the director + text planner.
 */
export function parseTextRewritePairs(node: any, keyword = ""): TextRewrite[] {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const rawList: any[] = Array.isArray(node?.rewrites)
    ? node.rewrites
    : node && (node.old !== undefined || node.new !== undefined)
      ? [{ old: node.old, new: node.new }]
      : [];
  return rawList
    .map((r) => ({ old: str(r?.old), new: str(r?.new) }))
    .filter((r) => !!r.old && !!r.new && r.old !== r.new)
    .filter((r) => !containsBrand(r.old, keyword) || containsBrand(r.new, keyword));
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
 *   - text-rewrite: rewrites editable text blocks (an array of {old,new}). The
 *     guard is PER-REWRITE — a rewrite may not ERASE the brand from a block that
 *     contained it (old has the brand → new must keep it), but a rewrite of a
 *     secondary line that never had the brand is always allowed. Each surviving
 *     rewrite becomes its OWN step; brand-erasing rewrites are dropped, and if
 *     none survive, none are emitted.
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
  // Brand guard is PER-REWRITE: a rewrite may NEVER ERASE the brand/subject term
  // from a block that contained it (old has the brand → new MUST keep it), so we
  // never strip the subject's name. A rewrite of a SECONDARY line that never
  // contained the brand (e.g. a "Full Guide" tagline) is always allowed — that's
  // how a recreation gets fresh, non-copied supporting copy while the brand text
  // stays put. Each surviving rewrite becomes its OWN step; if none survive (or
  // there is no editable text), a disabled placeholder is recorded so the step is
  // still visible in the chain breakdown.
  {
    const node = json?.["text-rewrite"];
    // Accept the new array shape (rewrites: [{old,new}]) AND the legacy single
    // {old,new}; keep only well-formed, changing, brand-safe pairs.
    const safe = parseTextRewritePairs(node, keyword);
    const apply = node?.apply === true && safe.length > 0;
    if (apply) {
      // Emit one instruction per surviving text block, verbatim from the template.
      for (const r of safe) {
        out.push({
          id: "text-rewrite",
          label: STEP_META["text-rewrite"],
          apply: true,
          instruction: buildTextRewriteInstruction(r.old, r.new),
        });
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

// ── Text planner (review step) ────────────────────────────────────────────────
// For the REVIEW step we plan the text changes UP FRONT, from the SOURCE
// thumbnail, so the user can see + edit every rewrite before any rendering. This
// is the text-rewrite portion of the art-director, run on the original image and
// grounded in the chosen titles so the new copy matches the video's packaging.
// Best-effort: any failure returns [] (generation then falls back to the in-chain
// art-director). Attributed to "thumbnail-art-director" in the report.

const TEXT_PLANNER_SYSTEM =
  "You are an elite YouTube thumbnail copy editor. You are shown the ORIGINAL " +
  "thumbnail being recreated for a DIFFERENT video. Identify EVERY distinct, " +
  "readable text block in it and propose a rewrite for each, so the recreation's " +
  "wording is fresh and on-topic instead of an exact copy.\n\n" +
  "Rules: (1) The MAIN TITLE must become the KEYWORD — the original often shows a " +
  "different/older product or brand name; if the main title is a brand/product name " +
  "that is not already the keyword, rewrite it TO the keyword exactly. This is the " +
  "most important rewrite. (2) Rewrite every OTHER readable block (sub-headlines, " +
  "taglines, corner badges, AND text inside on-screen devices/apps/chat bubbles/" +
  "buttons) into a fresh, equally-relevant, punchier variant of the SAME intent and " +
  "roughly the SAME length so it fits the original's space. (3) NEVER invent a brand " +
  "name OTHER than the keyword. (4) Only rewrite text that genuinely exists in the " +
  "image. Keep the copy true to what the video is actually about.";

/** Build the text-planner user prompt. Pure + exported so the contract is testable. */
export function buildTextPlannerUserText(keyword: string, videoType: VideoType, titles: string[] = []): string {
  const cleaned = titles.filter(Boolean).slice(0, 6);
  const titleBlock = cleaned.length
    ? `The chosen/working TITLES for this video (align the new copy with these — same angle + promise):\n` +
      cleaned.map((t) => `  - ${t}`).join("\n") +
      "\n\n"
    : "";
  return (
    `The video is a ${videoType} video about: "${keyword}".\n\n` +
    titleBlock +
    `Read the thumbnail's text. FIRST, if the main title is a product/brand name that is not "${keyword}", ` +
    `add a rewrite changing it to "${keyword}" exactly. THEN rewrite every other readable block (taglines, ` +
    `badges, and text inside any device/app/chat/button) into a fresh, equally-relevant variant of the same ` +
    `length. NO rewrite may introduce a brand name OTHER than "${keyword}". Return ONLY this JSON object:\n` +
    "{\n" +
    '  "rewrites": [ { "old": string, "new": string } ]\n' +
    "}\n"
  );
}

/**
 * Plan the text rewrites for a SOURCE thumbnail (review step). Returns the
 * brand-safe {old,new} pairs. Best-effort: any failure → []. Injectable vision
 * call for tests.
 */
export async function planTextRewrites(opts: {
  sourceBytes: Buffer;
  sourceMime: string;
  keyword: string;
  videoType: VideoType;
  titles?: string[];
  vision?: typeof claudeVisionLabeledJSON;
}): Promise<TextRewrite[]> {
  const vision = opts.vision ?? claudeVisionLabeledJSON;
  try {
    const raw = await vision({
      system: TEXT_PLANNER_SYSTEM,
      userText: buildTextPlannerUserText(opts.keyword, opts.videoType, opts.titles ?? []),
      images: [
        {
          label: "Original thumbnail being recreated:",
          data: opts.sourceBytes.toString("base64"),
          mediaType: opts.sourceMime || "image/jpeg",
        },
      ],
      purpose: "thumbnail-art-director",
    });
    return parseTextRewritePairs(JSON.parse(raw), opts.keyword);
  } catch {
    return [];
  }
}

// ── Expression director ───────────────────────────────────────────────────────
// Per-variant expression selection: rather than always using the video-type's
// single best-fit expression for every recreation, this vision pass LOOKS at the
// specific SOURCE thumbnail being recreated and picks the host expression (from
// the ones the user actually uploaded) that best matches its emotional tone /
// energy. So a shocking money reveal gets "surprise", a calm explainer gets
// "smile"/"calm", etc. — chosen per variation, not fixed by type. Best-effort:
// any failure falls back to the video-type's expression (see analyzeSourceThumbnail).

/** One available expression option: its id + a human description for the picker. */
export interface AvailableExpression {
  id: Expression;
  /** Display name / description used to describe the option to the model. */
  label: string;
}

/** Short, literal description of each BUILT-IN expression's vibe (custom ones use their label). */
const EXPRESSION_GUIDE: Record<string, string> = {
  smile: "warm, friendly, confident smile — upbeat, approachable, positive energy",
  surprise: "shocked / amazed, wide eyes, open mouth — high-energy 'wow' reaction (big reveals, shocking numbers, viral)",
  secret: "sly, knowing, leaning-in — an 'insider secret / they don't want you to know' look",
  calm: "calm, composed, serious — measured, trustworthy authority (reviews, explainers)",
};

/** Describe an option for the prompt: the built-in vibe, else the custom label. */
function describeExpression(opt: AvailableExpression): string {
  return EXPRESSION_GUIDE[opt.id] ?? opt.label;
}

export const EXPRESSION_DIRECTOR_SYSTEM =
  "You are an elite YouTube thumbnail director analysing the ORIGINAL thumbnail " +
  "being recreated. You do TWO things. (1) EXPRESSION: judge the thumbnail's " +
  "emotional tone, energy and intent and pick the ONE host expression — from ONLY " +
  "the available list you are given — that best matches it and would maximise " +
  "click-through. Guidance: a shocking result / big money or number reveal / hype " +
  "→ surprise; a warm, approachable how-to or explainer → smile; a sneaky 'insider " +
  "trick / secret' angle → secret; a serious, trustworthy review or analysis → " +
  "calm. Choose ONLY from the offered expressions. (2) BUSY: judge whether the " +
  "thumbnail is ELEMENT-HEAVY — i.e. it contains MANY distinct things besides the " +
  "person and the headline (props like stacks of money/cash, on-screen devices " +
  "like laptops/phones, app or chat UI panels, multiple separate text blocks, " +
  "badges, logos). A busy thumbnail degrades if it is re-rendered many times " +
  "(money turns to mush, screens warp), so it should be recreated in ONE pass. " +
  "Set busy=true when there are several such elements; false for a simple " +
  "person+headline(+background) thumbnail.";

/**
 * Build the JSON-shaping user prompt for the source director. Pure + exported so
 * the contract is testable without the network. Lists ONLY the available
 * expressions (with their vibe) and asks for the expression + the busy flag.
 */
export function buildExpressionDirectorUserText(opts: {
  keyword: string;
  videoType: VideoType;
  available: AvailableExpression[];
}): string {
  const list = opts.available.map((e) => `  - ${e.id}: ${describeExpression(e)}`).join("\n");
  const ids = opts.available.map((e) => e.id).join(", ");
  return (
    `The video is a ${opts.videoType} video about: "${opts.keyword}".\n\n` +
    `Available expressions (choose EXACTLY one, by its id):\n${list}\n\n` +
    "Look at the ORIGINAL thumbnail above and (1) pick the single expression id that " +
    "best fits its emotional tone/energy, and (2) decide whether it is element-heavy " +
    "(busy). Return ONLY this JSON object (no prose):\n" +
    `{ "expression": "<one of: ${ids}>", "busy": <true|false>, "reason": "<short>" }`
  );
}

/**
 * Coerce the model's choice into one of the AVAILABLE expression ids. Case/space
 * tolerant, and also matches the option's label; anything unrecognised →
 * `fallback`. Pure + exported for unit testing.
 */
export function parseExpressionChoice(
  json: any,
  available: AvailableExpression[],
  fallback: Expression,
): Expression {
  const raw = typeof json?.expression === "string" ? json.expression.trim().toLowerCase() : "";
  if (!raw) return fallback;
  const byId = available.find((e) => e.id.toLowerCase() === raw);
  if (byId) return byId.id;
  const byLabel = available.find((e) => e.label.toLowerCase() === raw);
  return byLabel ? byLabel.id : fallback;
}

/**
 * The best-fit fallback expression for a video type, restricted to what's
 * available: the type's primary when uploaded, else the first available id.
 * Pure + exported (also used by the orchestrator's best-effort wrapper).
 */
export function fallbackExpression(videoType: VideoType, available: AvailableExpression[]): Expression {
  const primary = expressionForVideoType(videoType);
  const ids = available.map((e) => e.id);
  return ids.includes(primary) ? primary : ids[0];
}

/** Result of the source-thumbnail analysis: the chosen expression + busy flag. */
export interface SourceAssessment {
  expression: Expression;
  /** True when the thumbnail is element-heavy → recreate it in ONE pass. */
  busy: boolean;
}

/**
 * Analyse the SOURCE thumbnail in ONE vision call: choose the best-fit expression
 * (from the uploaded ones) AND decide whether the thumbnail is element-heavy
 * (busy → the chain recreates it in a single pass to avoid multi-render
 * degradation). Injectable for tests; best-effort in the orchestrator (any throw
 * → the video-type expression + busy:false). Usage is attributed to
 * "thumbnail-expression-director" in the report.
 */
export async function analyzeSourceThumbnail(opts: {
  sourceBytes: Buffer;
  sourceMime: string;
  available: AvailableExpression[];
  videoType: VideoType;
  keyword: string;
}): Promise<SourceAssessment> {
  const fallback = fallbackExpression(opts.videoType, opts.available);
  const raw = await claudeVisionLabeledJSON({
    system: EXPRESSION_DIRECTOR_SYSTEM,
    userText: buildExpressionDirectorUserText({
      keyword: opts.keyword,
      videoType: opts.videoType,
      available: opts.available,
    }),
    images: [
      {
        label: "Original thumbnail being recreated:",
        data: opts.sourceBytes.toString("base64"),
        mediaType: opts.sourceMime || "image/jpeg",
      },
    ],
    purpose: "thumbnail-expression-director",
  });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { expression: fallback, busy: false };
  }
  return {
    expression: parseExpressionChoice(parsed, opts.available, fallback),
    busy: parsed?.busy === true,
  };
}

// ── Background director ───────────────────────────────────────────────────────
// When the creator has uploaded background images, this vision pass decides
// whether ANY of them CLEARLY fits a recreation of the source thumbnail — and if
// so, which. Conservative by design ("only if it fits"): when nothing is a clear,
// improving match it returns null and the chain keeps + pops the original
// background. Best-effort in the orchestrator (any throw → null → keep original).

/** One candidate background to consider (id + label + image bytes). */
export interface BackgroundCandidate {
  id: string;
  label: string;
  bytes: Buffer;
  mime: string;
}

export const BACKGROUND_DIRECTOR_SYSTEM =
  "You are an elite YouTube thumbnail director. You are shown the ORIGINAL " +
  "thumbnail being recreated, followed by a set of CANDIDATE background images the " +
  "creator uploaded. Decide whether swapping the original's background for ONE of " +
  "the candidates would CLEARLY improve this specific thumbnail while still suiting " +
  "its topic, mood and composition (the subject + text sit on top, so the " +
  "background must not fight them). Be CONSERVATIVE: only choose a candidate when " +
  "it is a clearly good, fitting match. If none clearly fits, choose none. Never " +
  "force a swap.";

/**
 * Build the background-director user prompt. Pure + exported. Lists the candidate
 * ids/labels (the images themselves are attached by the caller, in this order).
 */
export function buildBackgroundDirectorUserText(opts: {
  keyword: string;
  videoType: VideoType;
  candidates: Array<{ id: string; label: string }>;
}): string {
  const list = opts.candidates.map((c, i) => `  ${i + 1}. id="${c.id}" — ${c.label}`).join("\n");
  const ids = opts.candidates.map((c) => c.id).join(", ");
  return (
    `The video is a ${opts.videoType} video about: "${opts.keyword}".\n\n` +
    `Candidate backgrounds (in the order shown above):\n${list}\n\n` +
    "Decide whether ONE candidate clearly fits + improves a recreation of the " +
    "original thumbnail. Return ONLY this JSON object (no prose):\n" +
    `{ "backgroundId": <"one of: ${ids}" or null>, "reason": "<short>" }`
  );
}

/** Coerce the model's choice into an available id, or null. Pure + exported. */
export function parseBackgroundChoice(json: any, availableIds: string[]): string | null {
  const raw = typeof json?.backgroundId === "string" ? json.backgroundId.trim() : "";
  if (!raw) return null;
  const match = availableIds.find((id) => id.toLowerCase() === raw.toLowerCase());
  return match ?? null;
}

/**
 * Decide which uploaded background (if any) to swap in for THIS source. Returns
 * the chosen id or null. Injectable for tests; best-effort in the orchestrator.
 * Attributed to "thumbnail-background-director" in the report.
 */
export async function chooseBackground(opts: {
  sourceBytes: Buffer;
  sourceMime: string;
  candidates: BackgroundCandidate[];
  videoType: VideoType;
  keyword: string;
}): Promise<string | null> {
  if (opts.candidates.length === 0) return null;
  const images = [
    {
      label: "Original thumbnail being recreated:",
      data: opts.sourceBytes.toString("base64"),
      mediaType: opts.sourceMime || "image/jpeg",
    },
    ...opts.candidates.map((c, i) => ({
      label: `Candidate background ${i + 1} (id="${c.id}", ${c.label}):`,
      data: c.bytes.toString("base64"),
      mediaType: c.mime || "image/png",
    })),
  ];
  const raw = await claudeVisionLabeledJSON({
    system: BACKGROUND_DIRECTOR_SYSTEM,
    userText: buildBackgroundDirectorUserText({
      keyword: opts.keyword,
      videoType: opts.videoType,
      candidates: opts.candidates.map((c) => ({ id: c.id, label: c.label })),
    }),
    images,
    purpose: "thumbnail-background-director",
  });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseBackgroundChoice(parsed, opts.candidates.map((c) => c.id));
}
