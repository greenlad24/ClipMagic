/**
 * Script analysis for the Thumbnail Designer.
 *
 * The tool's entry point is a pasted video SCRIPT. This step asks Claude to read
 * the script and extract:
 *   - keyword   — the single best YouTube SEARCH keyword/topic for the video
 *                 (what the user would search to find similar top-performing
 *                  videos), kept short and search-friendly.
 *   - videoType — the inferred packaging style, one of Tutorial/Viral/Secret/
 *                 Review (aligned with videoType.ts's type→expression mapping).
 *   - rationale — a one-line explanation (optional), shown so the user trusts
 *                 the pre-filled values before they edit/search.
 *
 * The keyword + videoType are returned PRE-FILLED and stay editable in the UI —
 * the user can correct either before searching.
 *
 * Cheap structured extraction → runs on the fast (Haiku) tier and is attributed
 * to the "thumbnail-script-analysis" purpose in the optimization report. The AI
 * layer is injectable so the assembly + normalization can be unit-tested with a
 * mocked model (no network).
 */
import { claudeJSONForPurpose } from "../ai/claude.js";
import { VIDEO_TYPES, isVideoType, type VideoType } from "./videoType.js";

export interface ScriptAnalysis {
  keyword: string;
  videoType: VideoType;
  rationale?: string;
}

const SYSTEM =
  "You are a YouTube packaging strategist. You are given the full SCRIPT of a " +
  "video. Identify (1) the single best SEARCH keyword/topic for the video — what " +
  "a viewer would type to find videos like this, short and search-friendly (2-6 " +
  "words, no quotes) — and (2) the video's packaging TYPE. Choose exactly one " +
  "type: Tutorial (how-to / teaching), Viral (shock / big claim / reaction), " +
  "Secret (insider / little-known / 'nobody tells you'), or Review (calm " +
  "evaluation / comparison / verdict). Be decisive.";

/** Pure, exported prompt builder so the contract is testable. */
export function buildScriptAnalysisUserText(script: string): string {
  return (
    "SCRIPT:\n" +
    script.trim() +
    "\n\n" +
    "Return ONLY this JSON object:\n" +
    "{\n" +
    '  "keyword": string,\n' +
    `  "videoType": "${VIDEO_TYPES.join('" | "')}",\n` +
    '  "rationale": string\n' +
    "}\n\n" +
    "keyword: 2-6 words, no surrounding quotes. videoType: exactly one of the " +
    "four. rationale: one short sentence on why."
  );
}

/** Resolve a model string (any case) to a canonical VideoType, else null. */
function coerceVideoType(x: unknown): VideoType | null {
  if (typeof x !== "string") return null;
  const match = VIDEO_TYPES.find((t) => t.toLowerCase() === x.trim().toLowerCase());
  return match && isVideoType(match) ? match : null;
}

/**
 * Normalize a raw model object into the strict ScriptAnalysis shape: trims the
 * keyword, coerces the videoType (case-insensitive) to a known VideoType, keeps
 * an optional one-line rationale. Pure + exported for unit testing the assembly.
 * Throws when the keyword is missing or the type can't be resolved.
 */
export function normalizeScriptAnalysis(raw: any): ScriptAnalysis {
  const keyword =
    typeof raw?.keyword === "string" ? raw.keyword.trim().replace(/^["']|["']$/g, "").trim() : "";
  if (!keyword) throw new Error("Script analysis returned no keyword.");
  const videoType = coerceVideoType(raw?.videoType);
  if (!videoType) throw new Error(`Script analysis returned an unknown video type: ${String(raw?.videoType)}`);
  const rationale = typeof raw?.rationale === "string" && raw.rationale.trim() ? raw.rationale.trim() : undefined;
  return { keyword, videoType, rationale };
}

/** Injectable model call (returns the raw JSON string) — mocked in tests. */
export type GenerateJsonFn = (opts: { system: string; userText: string }) => Promise<string>;

const defaultGenerate: GenerateJsonFn = (opts) =>
  claudeJSONForPurpose({
    tier: "fast",
    purpose: "thumbnail-script-analysis",
    system: opts.system,
    messages: [{ role: "user", content: opts.userText }],
  });

export async function analyzeScript(
  script: string,
  generate: GenerateJsonFn = defaultGenerate,
): Promise<ScriptAnalysis> {
  const text = (script || "").trim();
  if (!text) throw new Error("Paste your video script to analyze.");
  const raw = await generate({ system: SYSTEM, userText: buildScriptAnalysisUserText(text) });
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Script analysis returned non-JSON.");
  }
  return normalizeScriptAnalysis(parsed);
}
