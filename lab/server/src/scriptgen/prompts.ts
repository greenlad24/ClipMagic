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
 * What sponsorship changes: the rules, never the structure. A sponsored listicle
 * is still shaped like a listicle; a sponsored review is still shaped like a
 * review. Substituted into rule-amendments.md.
 */
const SPONSORED_COMPETITOR_RULE = [
  "**This video is sponsored.** That changes three rules. It does not change the shape of the video — a sponsored listicle is still a listicle, a sponsored review is still a review.",
  "",
  "**Competitor mentions are OFF.** Don't name a competing tool at all — not to compare, not to dismiss, not even neutrally. Talk about what THIS tool does. Where the older rules said 'no competitor mentions, ever', for a sponsored video that still holds exactly. If the brief asks you to characterise a competitor — even flatteringly, and especially unflatteringly — do not do it. Say so plainly in your notes instead of writing the line.",
  "",
  "**Name the tool early, with its offer.** Within the first minute, say what it's called and what it costs to start, and point at the link: \"the tool I'm showing today is called X, it's completely free to start, and I'll drop the link in the description if you want to follow along.\" One sentence. Not a pitch.",
  "",
  "**The link CTA points at the sponsor**, not only at Jake's own community. Somewhere natural — usually once early, once near the end — tell the viewer where to go and that it's free to start, if it is.",
].join("\n");

const ORGANIC_COMPETITOR_RULE = [
  "**This video is not sponsored, so competitor mentions are ALLOWED.**",
  "",
  "Naming other tools is useful, and Jake does it. \"You'll still want a real design tool like Figma or Photoshop for the final version.\" \"You don't need Tableau or Power BI for this anymore.\" That's honest, it helps the viewer place the tool, and it costs nothing.",
  "",
  "Name them when it genuinely helps someone decide. Say what each is good at. Never write \"better than X\", never imply the people using X are behind, and never make another tool the butt of a joke.",
].join("\n");

/**
 * The system prompt read at the top of every stage: the PRIORITIES + VOICE
 * preamble, then Jake's SOUL persona, then the rule amendments (which override
 * both), and — for drafting stages that may weave in a backstory fragment — the
 * story-shrapnel bank.
 *
 * The amendments come LAST among the rule text on purpose: they correct the
 * older rules, and recency wins when a model reconciles two instructions.
 *
 * `sponsored` gates the competitor rule, which is the one rule that genuinely
 * flips depending on the video rather than on the writer.
 */
export function systemPreamble(includeShrapnel: boolean, sponsored: boolean): string {
  const amendments = fill(loadPrompt("rule-amendments"), {
    "[SPONSORSHIP RULE]": sponsored ? SPONSORED_COMPETITOR_RULE : ORGANIC_COMPETITOR_RULE,
  });
  return (
    loadPrompt("stage-preamble") +
    "\n\n---\n\n" +
    SOUL +
    "\n\n---\n\n" +
    amendments +
    (includeShrapnel ? "\n\n---\n\n" + SHRAPNEL : "")
  );
}
