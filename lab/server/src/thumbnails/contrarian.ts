/**
 * Contrarian originals — the second Thumbnail Designer workflow.
 *
 * Builds 3 ORIGINAL thumbnails from FIXED templates (see textOverlay.ts): an
 * uploaded BACKGROUND + the CHARACTER + a styled Helvetica headline. The image
 * model composes ONLY the background + character (no text); the headline is drawn
 * programmatically so each template lands in exact, repeatable positions.
 *
 * An "art-director copywriter" (one fast-tier call) returns, per variation:
 *   - text      — a curiosity/shock statement that does NOT damage the brand,
 *                 shaped to fit that template (≤7 words, 2–4 ideal).
 *   - emphasis  — the word(s) for the red box / strikethrough.
 *   - expression— which uploaded expression best EMPHASISES this statement.
 * The placement/layout is fixed by the template (the copywriter no longer picks
 * it); a placement directive in the chosen expression's NAME can still override
 * which side the character sits on.
 *
 * HARD RULE: NO money claim anywhere (no "$", no amounts, no revenue/income
 * figures). Percentages/stats like "99%" are fine. Enforced in the prompt AND by
 * dropping any money-smelling statement.
 */
import { claudeJSONForPurpose } from "../ai/claude.js";
import { CONTRARIAN_TEMPLATES } from "./textOverlay.js";

export interface ContrarianVariation {
  /** The full statement (≤7 words). */
  text: string;
  /** The word(s) to render in the red box / strikethrough. */
  emphasis: string;
  /** Chosen expression id (from the uploaded library) that fits the statement. */
  expressionId: string;
}

/** One available expression option offered to the copywriter. */
export interface AvailableExpressionOption {
  id: string;
  label: string;
}

const SYSTEM =
  "You are an elite YouTube thumbnail ART DIRECTOR and COPYWRITER. You design a " +
  "set of bold, high-CTR ORIGINAL thumbnails, each following a FIXED template. " +
  "Your COPY must invoke CURIOSITY or SHOCK and make people want to click, but it " +
  "must NEVER damage, insult or speak negatively about the brand/topic. Good " +
  "angles: an intriguing stat or secret (e.g. \"What 99% Don't Know\" with \"99%\" " +
  "emphasised), a bold promise, or — especially for tutorials — the BRAND NAME plus " +
  "a descriptor like \"FULL TUTORIAL\", \"BEGINNER TO PRO\", \"FULL GUIDE\". " +
  "Keep it SHORT and punchy — 2–4 words, NEVER more than 5; big bold thumbnails " +
  "use few words so the text can be huge. No filler, no \"+\" or symbols, no " +
  "subtitles. ABSOLUTELY NO money claims — no dollar signs, no amounts, no " +
  "revenue/profit/income/earnings figures (percentages like \"99%\" are fine). " +
  "You also CAST each thumbnail: from the provided expression list choose the one " +
  "that best EMPHASISES that statement's emotion (shock → a shocked/intense look; " +
  "a confident promise → a calm assured look) — vary them across the set.";

/** Pure, exported prompt builder so the contract is testable. */
export function buildContrarianWriterUserText(keyword: string, available: AvailableExpressionOption[]): string {
  const exprList = available.map((e) => `  - ${e.id}: ${e.label}`).join("\n");
  const ids = available.map((e) => e.id).join(", ");
  const templateList = CONTRARIAN_TEMPLATES.map((t, i) => `  ${i + 1}. ${t.label}: ${t.copyHint}`).join("\n");
  return (
    `The video's topic/keyword is: "${keyword}".\n\n` +
    `Available expressions to cast from (choose by id):\n${exprList}\n\n` +
    `Design EXACTLY ${CONTRARIAN_TEMPLATES.length} variations, one per template IN THIS ORDER:\n` +
    `${templateList}\n\n` +
    "Return ONLY this JSON object:\n" +
    "{\n" +
    '  "variations": [\n' +
    '    { "text": string, "emphasis": string, "expression": string }\n' +
    "  ]\n" +
    "}\n\n" +
    "Rules: `text` 2–4 words ideal (max 7), no surrounding quotes, no money claims, brand kept positive. " +
    "`emphasis` = the word(s) inside `text` that this template highlights (see each template's note). " +
    `\`expression\` = one of: ${ids}. Vary the expression across the variations and fit it to each statement.`
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

/**
 * Normalize raw model variations: trim, enforce ≤7 words, DROP money claims, fix
 * the emphasis to be inside the text, and validate the expression id against the
 * available ones (else cleared for the pad step to assign). Pure + exported.
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
    if (!text || wordCount(text) > 6 || hasMoneyClaim(text)) continue;
    let emphasis = typeof v?.emphasis === "string" ? v.emphasis.trim().replace(/^["']|["']$/g, "").trim() : "";
    if (!emphasis || !text.toLowerCase().includes(emphasis.toLowerCase()) || hasMoneyClaim(emphasis)) {
      const words = text.split(/\s+/).filter(Boolean);
      emphasis = words[words.length - 1] ?? "";
    }
    const exprRaw = typeof v?.expression === "string" ? v.expression.trim() : "";
    const expressionId = availableIds.find((id) => id.toLowerCase() === exprRaw.toLowerCase()) ?? "";
    out.push({ text, emphasis, expressionId });
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

/**
 * Pad/trim to exactly `count`, and GUARANTEE every variation has a valid
 * expression id (cycled across the available ones). Pure + exported.
 */
export function padContrarianVariations(
  variations: ContrarianVariation[],
  count: number,
  availableIds: string[],
): ContrarianVariation[] {
  const out = [...variations];
  for (let i = 0; out.length < count; i++) {
    const f = FALLBACK_TEXTS[i % FALLBACK_TEXTS.length];
    out.push({ text: f.text, emphasis: f.emphasis, expressionId: "" });
  }
  return out.slice(0, count).map((v, i) => ({
    ...v,
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
    const raw = await generate({ system: SYSTEM, userText: buildContrarianWriterUserText(keyword, available) });
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

/** Normalize a name for matching (lowercase, alphanumerics only). */
function normName(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Resolve the background id a template should use: the uploaded background whose
 * NAME matches the template's `backgroundName` (by id or label, normalized), else
 * `fallbackId`. Pure + exported. Lets each template pin a specific named
 * background (e.g. "Black"), falling back to a cycled one when it isn't uploaded.
 */
export function resolveTemplateBackground(
  backgroundName: string,
  candidates: Array<{ id: string; label: string }>,
  fallbackId: string,
): string {
  const want = normName(backgroundName);
  const match = candidates.find((c) => normName(c.label) === want || normName(c.id) === want);
  return match ? match.id : fallbackId;
}

/**
 * Build the COMPOSE instruction: background + character ONLY, NO text (the
 * headline is drawn programmatically afterwards). `placement` is the character's
 * side; `textArea` names the region to leave clear for the headline. Pure +
 * exported so the (text-free) contract is testable.
 */
export function buildContrarianComposePrompt(
  placement: "left" | "center" | "right",
  textArea: string,
): string {
  const side =
    placement === "left"
      ? "all the way to the LEFT"
      : placement === "right"
        ? "all the way to the RIGHT"
        : "centred";
  return (
    "Create a 16:9 landscape image with exactly TWO elements: a background and a person — and NO text at all. " +
    "(1) BACKGROUND: use the FIRST image as the full background, scaled to fill the whole frame. " +
    "(2) PERSON: the subject must look EXACTLY like the man in the SECOND image — a 1:1 likeness: the same face, " +
    "head shape, hairstyle, hair colour, beard, skin tone and features (clearly THAT real man, do not restyle him). " +
    "Composite him naturally onto the background as a real head-and-shoulders/upper-chest shot — he must be WHOLE " +
    "and naturally integrated, NOT a cut-out or floating cropped head, with NO hard cut lines or visible edges. " +
    `Position him ${side}, looking toward the camera with a confident, intense expression. ` +
    "His face must be LARGE — filling AT LEAST 70% of the thumbnail's HEIGHT (a big, dominant face). " +
    `Keep ${textArea} relatively clean and uncluttered — a headline will be added there afterwards. ` +
    "CRITICAL: do NOT render ANY text, words, letters, numbers, captions, logos, watermarks or graphics anywhere — " +
    "output ONLY the background and the person, nothing else."
  );
}
