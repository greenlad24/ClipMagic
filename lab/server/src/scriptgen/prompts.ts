/**
 * Prompt + reference loader for the Jake Dawson Script Generator.
 *
 * The stage prompts (scriptgen/prompts/*.md) and persona references
 * (scriptgen/reference/*.md) are copied verbatim into dist/scriptgen/ by the
 * build's `copy:assets` step, so we resolve them RELATIVE TO THIS COMPILED
 * MODULE via import.meta.url — the same layout holds in src (tsx) and dist
 * (node). Reads are cached: the files never change at runtime.
 *
 * fill() does NOT blanket-replace bracket tokens (the prompts are full of
 * `[...]` example/instruction brackets that must stay verbatim). Instead the
 * caller passes an exact-token → value map and we replace ONLY those specific
 * tokens by string match. Everything else is preserved untouched.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const promptCache = new Map<string, string>();

/** Read a stage prompt (e.g. "stage1-research") from prompts/, cached. */
export function loadPrompt(name: string): string {
  const cached = promptCache.get(name);
  if (cached !== undefined) return cached;
  const path = fileURLToPath(new URL(`./prompts/${name}.md`, import.meta.url));
  const text = readFileSync(path, "utf8");
  promptCache.set(name, text);
  return text;
}

function loadReference(name: string): string {
  const path = fileURLToPath(new URL(`./reference/${name}.md`, import.meta.url));
  return readFileSync(path, "utf8");
}

/** Jake's persona ("who you are") — woven into the system prompt every stage. */
export const SOUL = loadReference("SOUL");
/** The credential/story fragment bank — added when a stage may weave one in. */
export const SHRAPNEL = loadReference("story-shrapnel-bank");

/**
 * Replace SPECIFIC known bracket tokens by exact string match. `vars` keys are
 * the literal tokens (e.g. "[INSERT VIDEO TITLE HERE]"); values are the text to
 * drop in. Tokens absent from `template` are a harmless no-op, so the same map
 * can be passed to any stage. Uses split/join (not regex) so tokens with regex
 * metacharacters (slashes, brackets, em-dashes) match literally.
 */
export function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [token, value] of Object.entries(vars)) {
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * The system prompt read at the top of every stage: the PRIORITIES + VOICE
 * preamble, then Jake's SOUL persona, and — for the drafting stages that may
 * weave in a backstory fragment — the story-shrapnel bank.
 */
export function systemPreamble(includeShrapnel: boolean): string {
  return (
    loadPrompt("stage-preamble") +
    "\n\n---\n\n" +
    SOUL +
    (includeShrapnel ? "\n\n---\n\n" + SHRAPNEL : "")
  );
}
