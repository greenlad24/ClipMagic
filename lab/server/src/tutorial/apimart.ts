/**
 * apimart calls made by the LAB (not the sidecar): batch ideas, batch scripts,
 * and the per-video outfit/background variations.
 *
 * Why here and not in the Python package: these three steps are interactive.
 * The operator picks ideas, edits scripts and approves them before a single
 * paid video render starts, and that back-and-forth belongs in the tool's own
 * database, not in a job's working directory. Rendering stays in the sidecar.
 *
 * The script JSON produced here is written to match
 * scripts/make_tutorial_script.py EXACTLY ({title_small, title_main, script,
 * cta, keyword}) — the sidecar hands an approved script straight to the
 * pipeline in place of that stage, so a drift in shape is a drift in output.
 */
import { getApimartApiKey } from "../settings/postizSecrets.js";

const API = "https://api.apimart.ai/v1/chat/completions";

/** Same default as the Python package's STUDIO_PLAN_MODEL. */
const MODEL = process.env.STUDIO_PLAN_MODEL || "qwen3.8-max";

/** ~30s of speech, matching TARGET_SECONDS/WORDS in make_tutorial_script.py. */
const TARGET_SECONDS = 30;
const WORDS = Math.round(TARGET_SECONDS * 2.6);

export class ApimartError extends Error {}

export interface TutorialScript {
  /** Stored as a JSON column, so it has to be structurally a plain record. */
  [key: string]: unknown;
  title_small: string;
  title_main: string;
  script: string;
  cta: string;
  keyword: string;
  topic: string;
}

export interface TutorialIdea {
  topic: string;
  hook: string;
}

export interface LookVariation {
  outfit: string;
  scene: string;
}

function key(): string {
  const k = getApimartApiKey();
  if (!k) {
    throw new ApimartError(
      "No apimart API key — add it in Settings before generating ideas or scripts.",
    );
  }
  return k;
}

/** One Qwen chat call, returning the assistant's raw text. */
async function chat(system: string, user: string, maxTokens: number): Promise<string> {
  // Resolved BEFORE the try: a missing key is a configuration problem with its
  // own message, and must not be reported as "apimart is unreachable".
  const auth = `Bearer ${key()}`;
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch {
    throw new ApimartError("apimart is unreachable.");
  }
  const text = await res.text();
  if (!res.ok) {
    // A bad key is the common case and deserves to say so rather than "500".
    const hint = res.status === 401 ? " — the apimart key was rejected." : "";
    throw new ApimartError(`apimart returned ${res.status}${hint}`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApimartError("apimart returned a non-JSON response.");
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new ApimartError("apimart returned an empty response.");
  }
  return content;
}

/** Pull the first JSON value out of a model reply that may be fenced or chatty. */
function extractJson<T>(text: string, opener: "{" | "["): T {
  const closer = opener === "{" ? "}" : "]";
  const start = text.indexOf(opener);
  const end = text.lastIndexOf(closer);
  if (start < 0 || end <= start) {
    throw new ApimartError("could not find JSON in the model's reply.");
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    throw new ApimartError("the model's JSON could not be parsed.");
  }
}

const IDEAS_SYSTEM =
  "You are a short-form content strategist for a talking-head tutorial channel. " +
  "Given a theme, propose distinct video ideas that each teach ONE concrete, " +
  "practical thing in about 30 seconds. Every idea must be genuinely different — " +
  "no rephrasings of the same tip, no overlapping tools. Prefer specific, " +
  "searchable topics over vague advice.\n" +
  'OUTPUT: STRICT JSON only, an array of {"topic":"...","hook":"..."} where topic ' +
  "is the full teachable topic (a phrase, not a sentence) and hook is the first " +
  "line the video would open on.";

export async function generateIdeas(theme: string, count: number): Promise<TutorialIdea[]> {
  const n = Math.max(1, Math.min(60, Math.round(count)));
  const raw = await chat(
    IDEAS_SYSTEM,
    `Theme: ${theme}\nPropose exactly ${n} ideas. Return the JSON array now.`,
    Math.min(8000, 400 + n * 90),
  );
  const arr = extractJson<any[]>(raw, "[");
  return arr
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      topic: String(x.topic || "").trim().slice(0, 300),
      hook: String(x.hook || "").trim().slice(0, 300),
    }))
    .filter((x) => x.topic);
}

/**
 * Kept verbatim from scripts/make_tutorial_script.py — the pipeline reads the
 * result of this prompt, so the two must not drift apart.
 */
const SCRIPT_SYSTEM =
  "You are a top English short-form UGC scriptwriter for talking-head tutorial reels. " +
  `Write ONE continuous first-person spoken script for a single ~${TARGET_SECONDS}s clip ` +
  `(about ${WORDS} words) that teaches the topic. It will be SPOKEN by an AI avatar, so ` +
  "write only natural spoken words — no stage directions, emojis, or special characters.\n" +
  "STRUCTURE: 1) HOOK (first ~3s): open on the punch, no greeting. 2) VALUE: 2-3 concrete " +
  "steps. 3) CTA (last ~3s): one clear ask (comment a keyword / save / follow).\n" +
  "Also produce a TWO-PART TITLE: a short lead-in (title_small, e.g. 'how to make') and " +
  "the main title (title_main, e.g. 'carousels with Claude'), plus a short CTA line.\n" +
  'OUTPUT: STRICT JSON only: {"title_small":"...","title_main":"...","script":"...",' +
  '"cta":"...","keyword":"<one word to comment, else empty>"}';

export async function generateScript(topic: string): Promise<TutorialScript> {
  const raw = await chat(SCRIPT_SYSTEM, `Topic: ${topic}\nReturn the script JSON now.`, 5000);
  const obj = extractJson<any>(raw, "{");
  const script = String(obj.script || "").trim();
  if (!script) throw new ApimartError("the model returned an empty script.");
  return {
    title_small: String(obj.title_small || "").trim().slice(0, 120),
    title_main: String(obj.title_main || "").trim().slice(0, 160),
    script,
    cta: String(obj.cta || "").trim().slice(0, 200),
    keyword: String(obj.keyword || "").trim().slice(0, 40),
    topic,
  };
}

const LOOKS_SYSTEM =
  "You dress a single on-camera creator for a run of short videos, all shot in ONE " +
  "place. For each video give a different everyday outfit and a different corner of " +
  "that SAME place to sit in. The place never changes — only the outfit and where in " +
  "it she is sitting. Outfits are ordinary, comfortable and varied in colour and " +
  "texture; describe each in a few words. Scenes are short descriptions of a corner " +
  "of the stated place, each visibly different from the others but unmistakably the " +
  "same room.\n" +
  'OUTPUT: STRICT JSON only, an array of {"outfit":"...","scene":"..."}.';

export async function generateLooks(
  environment: string,
  count: number,
): Promise<LookVariation[]> {
  const n = Math.max(1, Math.min(60, Math.round(count)));
  const place = environment.trim() || "a warm cozy home";
  const raw = await chat(
    LOOKS_SYSTEM,
    `The place (never changes): ${place}\nGive exactly ${n} outfit + corner pairs. Return the JSON array now.`,
    Math.min(8000, 400 + n * 80),
  );
  const arr = extractJson<any[]>(raw, "[");
  return arr
    .filter((x) => x && typeof x === "object")
    .map((x) => ({
      outfit: String(x.outfit || "").trim().slice(0, 300),
      scene: String(x.scene || "").trim().slice(0, 400),
    }))
    .filter((x) => x.outfit && x.scene);
}
