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
import { approvedLessonBlock } from "./lessons.js";

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
 * Three complete scripts Jake wrote himself, carried into EVERY stage.
 *
 * Everything else in this prompt set describes his voice — rules, slot lists,
 * word-swap tables, 3,000 lines of it. None of it shows a finished script. These
 * do, across three formats (listicle, tool review, build tutorial), and style
 * transfers by example far better than by description.
 *
 * They also carry the one number no rule was enforcing: all three run 2,498-2,888
 * words. Generated runs were landing at 3,913 and 4,538.
 *
 * They ride in the system prefix, which is byte-stable across a run, so they are
 * written to the cache once and read from it for every subsequent call.
 */
const EXEMPLAR_FRAME = [
  "# THREE FINISHED SCRIPTS BY JAKE — the target for everything you write",
  "",
  "Below are three complete videos Jake wrote and recorded himself: a listicle, a sponsored tool review, and a sponsored build tutorial. Every rule in this prompt set is an attempt to describe what these do. When a rule and these scripts disagree, THESE WIN — they are the artefact, the rules are the notes.",
  "",
  "Read them for:",
  "- **Length.** 2,672 / 2,498 / 2,888 words. Seventeen to nineteen minutes. That is what a finished Jake video weighs, and it is a ceiling as much as a target.",
  "- **How he demonstrates.** He points at the screen constantly, in his own voice, and says what CHANGED — not what a feature is for.",
  "- **How he is funny while teaching.** Almost always a wry clause of a few words riding inside a sentence that was already doing a job. He does not stop to tell a joke.",
  "- **How he handles the honest parts.** Pricing, limits and privacy are played completely straight in all three.",
  "- **How rough real spoken script is.** Half-sentences, restarts, asides. Do not out-polish him.",
  "",
  "## THE ONE HARD RULE ABOUT THESE SCRIPTS",
  "",
  "**Steal the MOVES. Never the SENTENCES.** These are published videos and the audience has already heard every line in them. Reusing a phrase from these — a joke especially — is worse than writing nothing, because it reads as a rerun to the people most likely to be watching. If a line you are about to write appears in one of these scripts, it is the wrong line. Write a new one that does the same job about the thing in front of you.",
  "",
  "The boilerplate is the single exception: the welcome line, the Skool plug, the subscribe ask, and the canonical end-card outro are meant to be the same every video.",
].join("\n");

const EXEMPLAR_FILES = [
  loadReference("exemplars/listicle-higgsfield"),
  loadReference("exemplars/review-topview"),
  loadReference("exemplars/tutorial-blotato"),
];

/**
 * The three scripts as SPOKEN TEXT ONLY, for the verbatim-reuse check.
 *
 * Each file opens with a few lines about format, sponsorship and length, then a
 * `---` rule. Those lines are not part of any video, and leaving them in made
 * the checker report "minutes written by jake start to finish note" as a lifted
 * line — my own header, quoted back at me.
 */
export const EXEMPLAR_SCRIPTS = EXEMPLAR_FILES.map((f) => {
  const i = f.indexOf("\n---\n");
  return i === -1 ? f : f.slice(i + 5);
});

export const EXEMPLARS =
  EXEMPLAR_FRAME +
  "\n\n---\n\n" +
  EXEMPLAR_FILES.join("\n\n---\n\n");

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
  "",
  // Jake's Stage 4 doc splits sponsorship into two cases, and the rule that a
  // WHOLE-video sponsorship carries no spoken disclosure lived only in the Stage 3
  // hook prompt. Every other stage that writes — the sections, the outro, the CTA
  // pass — could have opened with "quick heads up, this video is sponsored by…"
  // and nothing in its context said not to. This rule rides the system prefix, so
  // now they all see it.
  "**No spoken sponsorship disclosure.** Where the WHOLE video is the sponsored content, the disclosure is handled at upload — YouTube Studio's \"Paid promotion\" checkbox, the \"(sponsor)\" label on the description link, and an #ad / #sponsored hashtag if the sponsor asks for one. Never write a spoken one. No \"real quick, this video is sponsored by…\", no \"quick heads up, [brand] is paying for this one\", no version of it anywhere in the script. It costs retention and buys no legal protection that the checkbox doesn't already provide. Naming the tool and its offer, per the rule above, is not a disclosure — that is just saying what you're showing.",
  "",
  "A 60–90 second sponsor READ dropped into an otherwise organic video is the other case entirely, and that one DOES open with a single transparency sentence. It is written as its own segment, not here.",
].join("\n");

const ORGANIC_COMPETITOR_RULE = [
  "**This video is not sponsored, so competitor mentions are ALLOWED.**",
  "",
  "Naming other tools is useful, and Jake does it. \"You'll still want a real design tool like Figma or Photoshop for the final version.\" \"You don't need Tableau or Power BI for this anymore.\" That's honest, it helps the viewer place the tool, and it costs nothing.",
  "",
  "Name them when it really helps someone decide. Say what each is good at. Never write \"better than X\", never imply the people using X are behind, and never make another tool the butt of a joke.",
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
    // ⚠️ THE APPROVED EDIT LESSONS RIDE DIRECTLY BEHIND THE AMENDMENTS, and for
    // the same reason the amendments ride behind SOUL: they are the most recent
    // correction, and recency wins when a model reconciles two instructions.
    // Empty until Jake approves his first one, so today's prompt is unchanged
    // byte for byte. See scriptgen/lessons.ts for why nothing else reads them.
    approvedLessonBlock() +
    (includeShrapnel ? "\n\n---\n\n" + SHRAPNEL : "") +
    // Last, and every stage gets them: the rules above describe these scripts,
    // and where the two disagree the scripts are what Jake actually shipped.
    "\n\n---\n\n" +
    EXEMPLARS
  );
}
