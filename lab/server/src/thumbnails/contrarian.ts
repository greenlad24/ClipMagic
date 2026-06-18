/**
 * Contrarian originals — the second Thumbnail Designer workflow.
 *
 * Builds ORIGINAL thumbnails from scratch in the bold "statement" style of the
 * reference designs: a big HELVETICA headline where most words are WHITE (soft
 * blurred black drop shadow ~25% opacity) and the emphasis word(s) sit in a solid
 * RED rounded box. Each original has exactly THREE elements: an uploaded
 * BACKGROUND, the uploaded CHARACTER, and the styled TEXT.
 *
 * An "art-director copywriter" (one fast-tier call) returns, per variation:
 *   - text      — a curiosity/shock statement that does NOT damage the brand
 *                 (e.g. "What 99% Don't Know", or for a tutorial the brand name +
 *                 "FULL TUTORIAL" / "BEGINNER TO PRO"). ≤7 words, 2–4 ideal.
 *   - emphasis  — the word(s) to put in the red box.
 *   - expression— which uploaded expression best EMPHASIZES this statement.
 *   - placement — left / center / right (varied across the batch).
 *
 * HARD RULE: NO money claim anywhere (no "$", no dollar amounts, no revenue /
 * income figures). Percentages/stats like "99%" are fine. Enforced in the prompt
 * AND by dropping any money-smelling statement.
 */
import { claudeJSONForPurpose } from "../ai/claude.js";

export type ContrarianPlacement = "left" | "center" | "right";

export interface ContrarianVariation {
  /** The full statement (≤7 words). */
  text: string;
  /** The word(s) within `text` to render in the red emphasis box. */
  emphasis: string;
  /** Chosen expression id (from the uploaded library) that fits the statement. */
  expressionId: string;
  /** Where the character sits in the frame (varied across the batch). */
  placement: ContrarianPlacement;
}

/** One available expression option offered to the copywriter. */
export interface AvailableExpressionOption {
  id: string;
  label: string;
}

const SYSTEM =
  "You are an elite YouTube thumbnail ART DIRECTOR and COPYWRITER. For a given " +
  "video topic you design bold, high-CTR ORIGINAL thumbnails in the style of the " +
  "reference designs: a big Helvetica headline, most words WHITE with a soft drop " +
  "shadow and the punchy word(s) inside a RED box. " +
  "Your COPY must invoke CURIOSITY or SHOCK and make people want to click, but it " +
  "must NEVER damage, insult or speak negatively about the brand/topic. Good " +
  "angles: an intriguing stat or secret (e.g. \"What 99% Don't Know\" with \"99%\" " +
  "emphasised), a bold promise, or — especially for tutorials — the BRAND NAME as " +
  "the headline plus a descriptor like \"FULL TUTORIAL\", \"BEGINNER TO PRO\", " +
  "\"FULL GUIDE\" (descriptor emphasised). Vary the angle across the set. " +
  "Each statement is 2–4 words ideally, NEVER more than 7. ABSOLUTELY NO money " +
  "claims — no dollar signs, no amounts, no revenue/profit/income/earnings figures " +
  "(percentages like \"99%\" are fine). " +
  "You also CAST and STAGE each thumbnail: choose, from the provided expression " +
  "list, the expression that best EMPHASISES that specific statement's emotion " +
  "(e.g. a shocking claim → a shocked/intense look; a confident promise → a calm, " +
  "assured look) — vary them across the set, don't reuse the same one every time. " +
  "And choose a placement (left, center, or right) for the person, varying it " +
  "across the set.";

/** Pure, exported prompt builder so the contract is testable. */
export function buildContrarianWriterUserText(
  keyword: string,
  count: number,
  available: AvailableExpressionOption[],
): string {
  const list = available.map((e) => `  - ${e.id}: ${e.label}`).join("\n");
  const ids = available.map((e) => e.id).join(", ");
  return (
    `The video's topic/keyword is: "${keyword}".\n\n` +
    `Available expressions to cast from (choose by id):\n${list}\n\n` +
    `Design ${count} DISTINCT thumbnail variations. Return ONLY this JSON object:\n` +
    "{\n" +
    '  "variations": [\n' +
    '    { "text": string, "emphasis": string, "expression": string, "placement": "left" | "center" | "right" }\n' +
    "  ]\n" +
    "}\n\n" +
    "Rules: `text` 2–4 words ideal (max 7), no surrounding quotes, no money claims. " +
    "`emphasis` = 1–2 words that appear inside `text`. " +
    `\`expression\` = one of: ${ids}. ` +
    "`placement` = left | center | right. VARY both the expression and the " +
    "placement across the variations; pick the expression that best fits each " +
    "statement's emotion; keep the brand portrayed positively."
  );
}

/** True when the text smells of a money claim (so we drop it). Stats/%, are fine. */
export function hasMoneyClaim(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (t.includes("$")) return true;
  if (/\b\d+\s*(k|m|b|mm|million|billion|thousand|grand)\b/.test(t)) return true;
  if (/\b(million|billion|revenue|profit|income|salary|earnings?|roi|cash|dollars?|usd|payout|paycheck)\b/.test(t)) {
    return true;
  }
  return false;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isPlacement(x: unknown): x is ContrarianPlacement {
  return x === "left" || x === "center" || x === "right";
}

/**
 * Normalize raw model variations: trim, enforce ≤7 words, DROP money claims, fix
 * the emphasis to be inside the text, validate the expression id against the
 * available ones, and keep a valid placement (else left undefined for the pad
 * step to rotate). Pure + exported. `availableIds` gates the expression choice.
 */
export function normalizeContrarianVariations(raw: any, availableIds: string[]): ContrarianVariation[] {
  const list: any[] = Array.isArray(raw?.variations)
    ? raw.variations
    : Array.isArray(raw?.statements)
      ? raw.statements
      : [];
  const out: ContrarianVariation[] = [];
  for (const v of list) {
    const text = typeof v?.text === "string" ? v.text.trim().replace(/^["']|["']$/g, "").trim() : "";
    if (!text || wordCount(text) > 7 || hasMoneyClaim(text)) continue;
    let emphasis = typeof v?.emphasis === "string" ? v.emphasis.trim().replace(/^["']|["']$/g, "").trim() : "";
    if (!emphasis || !text.toLowerCase().includes(emphasis.toLowerCase()) || hasMoneyClaim(emphasis)) {
      const words = text.split(/\s+/).filter(Boolean);
      emphasis = words[words.length - 1] ?? "";
    }
    const exprRaw = typeof v?.expression === "string" ? v.expression.trim() : "";
    const expressionId = availableIds.find((id) => id.toLowerCase() === exprRaw.toLowerCase()) ?? "";
    const placement = isPlacement(v?.placement) ? v.placement : ("" as ContrarianPlacement | "");
    out.push({ text, emphasis, expressionId, placement: placement as ContrarianPlacement });
  }
  return out;
}

/** Generic, money-free, brand-safe fallbacks used to pad to `count`. */
const FALLBACK_TEXTS: Array<{ text: string; emphasis: string }> = [
  { text: "What 99% Don't Know", emphasis: "99%" },
  { text: "The Truth Revealed", emphasis: "TRUTH" },
  { text: "Watch This First", emphasis: "FIRST" },
  { text: "Nobody Tells You This", emphasis: "NOBODY" },
];

const PLACEMENT_ROTATION: ContrarianPlacement[] = ["left", "center", "right"];

/**
 * Pad/trim to exactly `count`, and GUARANTEE every variation has a valid
 * placement (rotated for variety) and a valid expression id (cycled across the
 * available ones). Pure + exported. `availableIds` must be non-empty.
 */
export function padContrarianVariations(
  variations: ContrarianVariation[],
  count: number,
  availableIds: string[],
): ContrarianVariation[] {
  const out = [...variations];
  for (let i = 0; out.length < count; i++) {
    const f = FALLBACK_TEXTS[i % FALLBACK_TEXTS.length];
    out.push({ text: f.text, emphasis: f.emphasis, expressionId: "", placement: "" as ContrarianPlacement });
  }
  return out.slice(0, count).map((v, i) => ({
    ...v,
    placement: isPlacement(v.placement) ? v.placement : PLACEMENT_ROTATION[i % PLACEMENT_ROTATION.length],
    expressionId:
      v.expressionId && availableIds.includes(v.expressionId)
        ? v.expressionId
        : availableIds[i % Math.max(1, availableIds.length)] ?? "",
  }));
}

/** Injectable model call (returns the raw JSON string) — mocked in tests. */
export type GenerateJsonFn = (opts: { system: string; userText: string }) => Promise<string>;

const defaultGenerate: GenerateJsonFn = (opts) =>
  claudeJSONForPurpose({
    tier: "fast",
    purpose: "thumbnail-contrarian-writer",
    system: opts.system,
    messages: [{ role: "user", content: opts.userText }],
  });

/**
 * Design `count` contrarian variations for a keyword. Best-effort: on any failure
 * (or too few valid ones), pads with brand-safe, money-free fallbacks so the
 * workflow always has `count` complete variations.
 */
export async function generateContrarianVariations(
  keyword: string,
  count: number,
  available: AvailableExpressionOption[],
  generate: GenerateJsonFn = defaultGenerate,
): Promise<ContrarianVariation[]> {
  const ids = available.map((a) => a.id);
  let variations: ContrarianVariation[] = [];
  try {
    const raw = await generate({ system: SYSTEM, userText: buildContrarianWriterUserText(keyword, count, available) });
    variations = normalizeContrarianVariations(JSON.parse(raw), ids);
  } catch {
    variations = [];
  }
  return padContrarianVariations(variations, count, ids);
}

/**
 * Choose `count` background ids from the available ones, REUSING (cycling) when
 * fewer than `count` are uploaded so we always reach `count`. Pure + exported.
 */
export function chooseContrarianBackgrounds(availableIds: string[], count: number): string[] {
  if (availableIds.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(availableIds[i % availableIds.length]);
  return out;
}

/** Describe where the person sits + where the text goes, given a placement. */
function layoutClause(placement: ContrarianPlacement): string {
  if (placement === "left") {
    return "positioned ALL THE WAY to the LEFT (he occupies the left portion); lay the text out on the RIGHT side";
  }
  if (placement === "right") {
    return "positioned ALL THE WAY to the RIGHT (he occupies the right portion); lay the text out on the LEFT side";
  }
  return (
    "positioned in the CENTER of the frame; lay the text out as a bold band across the BOTTOM (or top) of the frame, " +
    "spanning the width, NOT covering the face"
  );
}

/**
 * Build the ONE-SHOT composition instruction for a contrarian original. Inputs to
 * the model are [BACKGROUND (first), CHARACTER (second)]. The placement comes from
 * the variation (or a name directive, resolved by the caller). Pure + exported.
 */
export function buildContrarianPrompt(
  variation: { text: string; emphasis: string },
  placement: ContrarianPlacement = "right",
): string {
  return (
    "Create a high-CTR YouTube thumbnail (16:9 landscape) FROM SCRATCH in the style of a bold, modern statement " +
    "thumbnail, using EXACTLY three elements and nothing else: a background, a person, and one short text statement. " +
    "(1) BACKGROUND: use the FIRST image as the full background, scaled to fill the whole frame. " +
    "(2) PERSON: place the man from the SECOND image as the subject — keep his EXACT face, head, hairstyle, hair " +
    "colour and beard (clearly THAT real man), a medium slightly-fit average build, seamless realistic blend onto " +
    `the background, LARGE and prominent (head/face filling a big portion of the height), ${layoutClause(placement)}, ` +
    "looking toward the camera with an expression that matches the statement. " +
    `(3) TEXT: render this exact statement: "${variation.text}". Typeset it in HELVETICA BLACK / HELVETICA BOLD ` +
    "(a heavy, bold, geometric sans-serif), UPPERCASE, big and crisply readable. Most of the words are WHITE with a " +
    "SOFT, BLURRED BLACK DROP SHADOW at about 25% opacity (subtle, not harsh). " +
    `The emphasis word(s) "${variation.emphasis}" are WHITE text inside a SOLID RED BOX with slightly ROUNDED ` +
    "CORNERS, so they pop. Keep the text to 1–2 lines. " +
    "STRICT RULES: do NOT add any other element, logo, watermark, emoji or extra text. Absolutely NO money anywhere " +
    "— no dollar signs, no prices, no amounts, no revenue/income figures (a percentage like \"99%\" is fine). " +
    "Keep it clean: only the background, the person, and this one styled Helvetica statement."
  );
}
