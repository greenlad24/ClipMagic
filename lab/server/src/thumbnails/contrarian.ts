/**
 * Contrarian originals — the second Thumbnail Designer workflow.
 *
 * Instead of recreating a top-performing thumbnail, this builds ORIGINAL
 * thumbnails from scratch, inspired by the bold "contrarian statement" style
 * (e.g. "DON'T RUN VIDEO ADS", "STOP POSTING DAILY"). Each original has exactly
 * THREE elements: an uploaded BACKGROUND, the uploaded CHARACTER, and a short
 * styled TEXT statement.
 *
 * Text style (rendered by the image model):
 *   - Most words: WHITE with a soft, blurred black drop shadow (~25% opacity).
 *   - The emphasis word(s): WHITE text inside a solid RED box with slightly
 *     rounded corners.
 *   - ≤7 words, ideally 2–4.
 *
 * HARD RULE: NO money claim anywhere (no "$", no dollar amounts, no revenue /
 * income figures) — enforced both in the writer prompt and by dropping any
 * statement that smells of money.
 *
 * The statement writer runs on the fast (Haiku) tier; the AI layer is injectable
 * so the assembly + normalization are unit-testable with a mocked model.
 */
import { claudeJSONForPurpose } from "../ai/claude.js";

export interface ContrarianStatement {
  /** The full statement (≤7 words, UPPERCASE-friendly). */
  text: string;
  /** The word(s) within `text` to render in the red emphasis box. */
  emphasis: string;
}

const SYSTEM =
  "You are an elite YouTube thumbnail copywriter. Given a video's topic/keyword, " +
  "write SHORT, BOLD, CONTRARIAN statements for a thumbnail — claims that " +
  "challenge the common belief and create curiosity (in the style of \"DON'T RUN " +
  "VIDEO ADS\", \"STOP POSTING DAILY\", \"NEW CUSTOMERS ARE OVERRATED\"). Rules: " +
  "each statement is 2–4 words ideally and NEVER more than 7 words; pick 1–2 words " +
  "as the emphasis (the punchy part). ABSOLUTELY NO money claims — no dollar signs, " +
  "no amounts, no revenue/profit/income/earnings figures, no numbers about money. " +
  "Keep it punchy, plain, and provocative.";

/** Pure, exported prompt builder so the contract is testable. */
export function buildContrarianWriterUserText(keyword: string, count: number): string {
  return (
    `The video's topic/keyword is: "${keyword}".\n\n` +
    `Write ${count} DISTINCT contrarian thumbnail statements. Return ONLY this JSON object:\n` +
    "{\n" +
    '  "statements": [ { "text": string, "emphasis": string }, ... ]\n' +
    "}\n\n" +
    "Each `text`: 2–4 words ideal, max 7, no surrounding quotes. Each `emphasis`: " +
    "1–2 words that appear inside `text` (the part to highlight). NO money claims, " +
    "no $ signs, no amounts, no numbers about money anywhere."
  );
}

/** True when the text smells of a money claim (so we drop it). */
export function hasMoneyClaim(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (t.includes("$")) return true;
  // "$40M", "300k", "10 million", etc.
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
 * Normalize raw model statements: trim, enforce ≤7 words, DROP any with a money
 * claim, and ensure the emphasis is actually inside the text (else fall back to
 * the last word). Pure + exported for unit testing. Returns however many survive.
 */
export function normalizeContrarianStatements(raw: any): ContrarianStatement[] {
  const list: any[] = Array.isArray(raw?.statements) ? raw.statements : [];
  const out: ContrarianStatement[] = [];
  for (const s of list) {
    const text = typeof s?.text === "string" ? s.text.trim().replace(/^["']|["']$/g, "").trim() : "";
    if (!text) continue;
    if (wordCount(text) > 7) continue;
    if (hasMoneyClaim(text)) continue;
    let emphasis = typeof s?.emphasis === "string" ? s.emphasis.trim().replace(/^["']|["']$/g, "").trim() : "";
    // The emphasis must be a substring of the text (case-insensitive); else use
    // the last word so there's always a sensible red-box target.
    if (!emphasis || !text.toLowerCase().includes(emphasis.toLowerCase()) || hasMoneyClaim(emphasis)) {
      const words = text.split(/\s+/).filter(Boolean);
      emphasis = words[words.length - 1] ?? "";
    }
    out.push({ text, emphasis });
  }
  return out;
}

/** Generic, money-free contrarian fallbacks used to pad to `count`. */
const FALLBACK_STATEMENTS: ContrarianStatement[] = [
  { text: "YOU'RE DOING IT WRONG", emphasis: "WRONG" },
  { text: "STOP RIGHT NOW", emphasis: "STOP" },
  { text: "IT'S A TRAP", emphasis: "TRAP" },
  { text: "NOBODY TELLS YOU THIS", emphasis: "NOBODY" },
];

/** Pad/trim a list of statements to exactly `count`, reusing fallbacks if short. */
export function padContrarianStatements(statements: ContrarianStatement[], count: number): ContrarianStatement[] {
  const out = [...statements];
  for (let i = 0; out.length < count; i++) {
    out.push(FALLBACK_STATEMENTS[i % FALLBACK_STATEMENTS.length]);
  }
  return out.slice(0, count);
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
 * Write `count` contrarian statements for a keyword. Best-effort: on any failure
 * (or too few valid ones), pads with money-free generic fallbacks so the workflow
 * always has `count` statements.
 */
export async function generateContrarianStatements(
  keyword: string,
  count = 3,
  generate: GenerateJsonFn = defaultGenerate,
): Promise<ContrarianStatement[]> {
  let statements: ContrarianStatement[] = [];
  try {
    const raw = await generate({ system: SYSTEM, userText: buildContrarianWriterUserText(keyword, count) });
    statements = normalizeContrarianStatements(JSON.parse(raw));
  } catch {
    statements = [];
  }
  return padContrarianStatements(statements, count);
}

/**
 * Choose `count` background ids from the available ones, REUSING (cycling) when
 * fewer than `count` are uploaded so we always reach `count`. Distinct first.
 * Pure + exported.
 */
export function chooseContrarianBackgrounds(availableIds: string[], count: number): string[] {
  if (availableIds.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(availableIds[i % availableIds.length]);
  return out;
}

/**
 * Build the ONE-SHOT composition instruction for a contrarian original. Inputs to
 * the model are [BACKGROUND (first), CHARACTER (second)]. Pure + exported so the
 * exact contract (style + no-money rule) is unit-testable.
 */
export function buildContrarianPrompt(statement: ContrarianStatement, placement?: "left" | "right" | null): string {
  // Honour a placement directive parsed from the character's name; otherwise the
  // model is free to pick a side.
  const sideClause =
    placement === "left" || placement === "right"
      ? `positioned ALL THE WAY to the ${placement.toUpperCase()} side of the frame (he occupies the ${placement.toUpperCase()} ` +
        `portion; keep the ${placement === "left" ? "RIGHT" : "LEFT"} side clearer for the text)`
      : "positioned to ONE side so the opposite side stays clearer for the text";
  return (
    "Create a high-CTR YouTube thumbnail (16:9 landscape) FROM SCRATCH using EXACTLY three elements and nothing else: " +
    "a background, a person, and one short text statement. " +
    "(1) BACKGROUND: use the FIRST image as the full background, scaled to fill the whole frame. " +
    "(2) PERSON: place the man from the SECOND image as the subject — keep his EXACT face, head, hairstyle, hair " +
    "colour and beard (clearly THAT real man), with a medium, slightly-fit average build and a seamless, realistic " +
    "blend onto the background. Make him LARGE and prominent (his head/face filling a big portion of the height), " +
    `${sideClause}, looking toward the camera with an intense, confident, slightly serious expression. ` +
    `(3) TEXT: render this exact statement: "${statement.text}". Style it like a bold modern YouTube thumbnail — ` +
    "a big, heavy, condensed sans-serif in UPPERCASE. Most of the words are WHITE with a SOFT, BLURRED BLACK DROP " +
    "SHADOW at about 25% opacity (subtle, not harsh). " +
    `The emphasis word(s) "${statement.emphasis}" are WHITE text inside a SOLID RED BOX with slightly ROUNDED ` +
    "CORNERS, so they pop. Lay the text out on 1–2 lines on the clearer side / lower area, large and crisply " +
    "readable, NOT covering the person's face. " +
    "STRICT RULES: do NOT add any other element, logo, watermark, emoji or extra text. Absolutely NO money " +
    "anywhere — no dollar signs, no prices, no amounts, no revenue/income figures, and no numbers about money. " +
    "Keep it clean: only the background, the person, and this one styled statement."
  );
}
