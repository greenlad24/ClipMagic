/**
 * Replaying what the operator demonstrated.
 *
 * ⚠️⚠️ NOTHING REPLAYED A RECIPE BEFORE THIS FILE EXISTED. The teach console has
 * saved recordings since the classroom rebuild, but `actions.ts` opens by saying
 * recordings "are EVIDENCE, not scripts, and replaying them literally would be
 * wrong" — so every classroom action was hand-written from what the recordings
 * showed. That was the right call there, and it is worth being explicit about
 * why it is NOT the right call here, because the two look like the same problem.
 *
 * A classroom rebuild runs the same action across sixty courses whose cards move
 * as the grid grows. A recording of it carries the operator's own mis-clicks,
 * their backtracking, and positions that stop being true on the second course.
 * Publishing a post is the opposite shape: ONE composer, on ONE page, reached
 * the same way every time. There is nothing to generalise, and the one thing
 * that keeps going wrong is precisely what a recording fixes — WHICH element is
 * the submit button, when several things on the page say "Post".
 *
 * ⚠️ REPLAY GOES THROUGH THE SAME PRIMITIVES THE RECORDING WENT THROUGH.
 * `clickAt`, `typeText`, `pressKey` and `pressCombo` are the console's own, so a
 * step replays through the exact code that captured it — including the real
 * mouse (Skool's menus ignore synthetic clicks) and the ⌘ → Ctrl translation.
 * A second implementation would drift from the first, and the drift would show
 * up as a recipe that worked when taught and fails a fortnight later.
 *
 * ⚠️ AND IT REPORTS WHICH HANDLE EACH STEP MATCHED ON. The failure this guards
 * against is not "the selector was not found" — that one is loud. It is the
 * selector matching the WRONG element and the click landing somewhere plausible.
 * A step that used to match on `testId` and now matches on `path` is a step
 * about to break, and that is worth knowing before it writes to a live
 * community rather than after.
 */
import { appendBody } from "./actions.js";
import { withSkoolPage } from "./browser.js";
import { clearFocusedField, clickAt, hover, navigate, pressCombo, pressKey, scrollBy, typeText } from "./console.js";
import { getRecipe, RESOLVER_SOURCE, type MatchHandle, type RecipeStep, type ResolveResult } from "./recipes.js";

/** Values for the `{{placeholders}}` in a recipe's typed steps. */
export type ReplayVars = Record<string, string>;

export interface ReplayStepReport {
  /** 1-based, so it lines up with the numbered list the operator recorded. */
  index: number;
  kind: RecipeStep["kind"];
  label: string;
  ok: boolean;
  /** Which handle found the element. Null for steps that act on no element. */
  handle: MatchHandle;
  /** What the matched element actually says — for confirming it was the right one. */
  matched: string;
  detail: string;
}

export interface ReplayResult {
  ok: boolean;
  detail: string;
  steps: ReplayStepReport[];
  /**
   * Handles that are one Skool redeploy away from breaking, and ambiguous
   * matches. Not fatal — surfaced so drift is visible while it is still cheap.
   */
  warnings: string[];
}

export interface ReplayOptions {
  /**
   * Placeholders whose value is PASTED rather than typed.
   *
   * ⚠️ A POST BODY MUST NOT BE REPLAYED AS KEYSTROKES. It is markdown, and the
   * composer is a ProseMirror document: typing it puts the literal `#` and `**`
   * characters on the page, which is the exact defect the lesson writer's paste
   * path was built to avoid. So the body goes through `appendBody` — a real
   * paste event carrying a DataTransfer — however the operator demonstrated it.
   */
  pasteVars?: string[];
  /**
   * Checked before each step runs. A returned string aborts the replay with it.
   *
   * ⚠️ THIS EXISTS SO A CALLER'S GUARDS CAN SIT INSIDE THE SEQUENCE, WHICH IS
   * THE ONLY PLACE SOME OF THEM MEAN ANYTHING. "Is the composer empty?" cannot
   * be asked before the replay (the composer is not open yet) or after it (the
   * post is already published) — it has to be asked immediately before the body
   * is written. The publisher uses it for exactly that.
   */
  guard?: (step: RecipeStep, index: number) => Promise<string | null>;
}

const DEFAULT_PASTE_VARS = ["body"];

/**
 * `{{name}}`, tolerating the spaces an operator will inevitably type.
 *
 * Defined once and exported with its reader, so the UI that records a
 * placeholder, the publisher that checks for one and the replay that fills it
 * all agree on what one looks like. Three spellings of this would be three
 * chances for a recording to read as "no placeholders" and post the same title
 * every week.
 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** Every placeholder named in a piece of text, in order, without duplicates. */
export function placeholdersIn(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) names.add(m[1]);
  return [...names];
}

interface Filled {
  text: string;
  /** Placeholders with no value supplied. Fatal — see below. */
  missing: string[];
}

/**
 * Substitute the placeholders in a recorded step.
 *
 * ⚠️ A MISSING VALUE IS FATAL, NOT AN EMPTY STRING. Leaving `{{title}}`
 * unfilled would type those eight characters into a live post; substituting ""
 * would publish an untitled one. Both are worse than refusing, and neither
 * announces itself — the recipe would replay "successfully" either way.
 */
function fill(text: string, vars: ReplayVars): Filled {
  const missing: string[] = [];
  const out = text.replace(PLACEHOLDER, (whole, name: string) => {
    const v = vars[name];
    if (typeof v !== "string" || v.length === 0) {
      missing.push(name);
      return whole;
    }
    return v;
  });
  return { text: out, missing };
}

/**
 * Is this class a name somebody chose, or a build artefact?
 *
 * ⚠️ NOT ALL CLASSES ARE EQUALLY DOOMED, AND WARNING ABOUT ALL OF THEM TRAINS
 * THE OPERATOR TO IGNORE THE WARNING. Skool ships both kinds side by side: the
 * composer's editor is `tiptap ProseMirror skool-editor` and its dropdown
 * options carry `skool-ui-dropdown-option` — names that survive a redeploy —
 * alongside `sc-c95338fa-0` and `eWFPRI`, which are styled-components hashes
 * and change without notice. A step resting on the first kind is fine; only the
 * second is a step about to break.
 *
 * Deliberately conservative — hyphen-separated lowercase words, and not the
 * `sc-` prefix styled-components uses — so a wrong guess over-warns.
 */
export function isSemanticClass(cls: string | undefined): boolean {
  if (!cls) return false;
  if (cls.startsWith("sc-")) return false;
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(cls);
}

/**
 * Find the step's element on the live page. Null when the browser is gone.
 *
 * ⚠️ A PLACEHOLDER CAN BE IN THE TARGET'S TEXT, NOT ONLY IN A TYPED STEP. The
 * post's category is CHOSEN, not typed: it is a menu item whose label is the
 * category name. Substituting only into typed steps would have left the
 * category as whatever was clicked while recording, so every post would land in
 * that one category and the recording would look entirely correct.
 *
 * The recorder drops the sharper handles from such a step (see the teach
 * console), so this resolves on text or fails — which is the point. A `testId`
 * or a tag path captured while recording names the item that WAS clicked, and
 * on replay that is precisely the wrong one.
 */
async function resolve(step: RecipeStep, vars: ReplayVars): Promise<{ result: ResolveResult | null; missing: string[] }> {
  if (!step.target) return { result: null, missing: [] };
  const wanted = step.target.text ?? "";
  const { text, missing } = fill(wanted, vars);
  if (missing.length > 0) return { result: null, missing };
  const target = text === wanted ? step.target : { ...step.target, text };
  const result = await withSkoolPage(async (page) => {
    try {
      return (await page.evaluate(`(${RESOLVER_SOURCE})(${JSON.stringify(target)})`)) as ResolveResult;
    } catch {
      return null;
    }
  });
  return { result, missing: [] };
}

/**
 * Run a recorded recipe against the live page.
 *
 * Stops at the first step that fails. A recipe is a sequence — step 6 typing
 * into a field step 4 never opened does not "partly work", it types the body of
 * a post into whatever happens to have focus.
 */
export async function replaySteps(
  steps: RecipeStep[],
  vars: ReplayVars = {},
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const pasteVars = new Set(opts.pasteVars ?? DEFAULT_PASTE_VARS);
  const reports: ReplayStepReport[] = [];
  const warnings: string[] = [];

  const finish = (ok: boolean, detail: string): ReplayResult => ({ ok, detail, steps: reports, warnings });

  if (steps.length === 0) return finish(false, "That recipe has no steps.");

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const index = i + 1;
    const at = `Step ${index}/${steps.length} (${step.kind} — ${step.label})`;
    const add = (ok: boolean, detail: string, handle: MatchHandle = null, matched = ""): ReplayStepReport => {
      const r: ReplayStepReport = { index, kind: step.kind, label: step.label, ok, handle, matched, detail };
      reports.push(r);
      return r;
    };

    if (opts.guard) {
      const refusal = await opts.guard(step, i);
      if (refusal) {
        add(false, refusal);
        return finish(false, `${at}: ${refusal}`);
      }
    }

    if (step.kind === "wait") {
      const ms = Math.max(0, Math.min(30_000, step.ms ?? 500));
      await new Promise((r) => setTimeout(r, ms));
      add(true, `Waited ${ms}ms.`);
      continue;
    }

    if (step.kind === "scroll") {
      const dy = Math.max(-4000, Math.min(4000, step.dy ?? 400));
      const frame = await scrollBy(dy);
      if (frame.error) {
        add(false, frame.error);
        return finish(false, `${at}: ${frame.error}`);
      }
      add(true, `Scrolled ${dy > 0 ? "down" : "up"} ${Math.abs(dy)}px.`);
      continue;
    }

    if (step.kind === "navigate") {
      const url = (step.value ?? "").trim();
      if (!url) {
        add(false, "A navigate step with no URL.");
        return finish(false, `${at}: no URL was recorded.`);
      }
      const frame = await navigate(url);
      if (frame.error) {
        add(false, frame.error);
        return finish(false, `${at}: ${frame.error}`);
      }
      add(true, `Went to ${url}.`);
      continue;
    }

    if (step.kind === "key") {
      const value = (step.value ?? "").trim();
      if (!value) {
        add(false, "A key step with no key.");
        return finish(false, `${at}: no key was recorded.`);
      }
      if (value === "clearField") {
        const out = await clearFocusedField();
        // Refusing to clear is a real answer — the field it would have cleared
        // holds something it was not asked to destroy.
        if (!out.cleared) {
          add(false, out.reason);
          return finish(false, `${at}: ${out.reason}`);
        }
        add(true, "Cleared the focused field.");
        continue;
      }
      // A chord is "cmd+shift+z"; a bare "+" is the key itself, not a chord.
      const isChord = value.includes("+") && value.length > 1;
      const frame = isChord ? await pressCombo(value.split("+").map((p) => p.trim()).filter(Boolean)) : await pressKey(value);
      if (frame.error) {
        add(false, frame.error);
        return finish(false, `${at}: ${frame.error}`);
      }
      add(true, `Pressed ${value}.`);
      continue;
    }

    if (step.kind === "type") {
      const raw = step.text ?? "";
      const { text, missing } = fill(raw, vars);
      if (missing.length > 0) {
        const detail =
          `needs ${missing.map((m) => `{{${m}}}`).join(", ")}, which ${missing.length === 1 ? "was" : "were"} not supplied. ` +
          `Refusing rather than typing the placeholder itself into the page.`;
        add(false, detail);
        return finish(false, `${at}: ${detail}`);
      }

      // The body is pasted, never typed — see ReplayOptions.pasteVars.
      const named = placeholdersIn(raw);
      const wholeField = named.length === 1 && raw.trim() === `{{${named[0]}}}`;
      if (wholeField && pasteVars.has(named[0])) {
        const pasted = await appendBody(text);
        if (!pasted.ok) {
          add(false, pasted.detail);
          return finish(false, `${at}: ${pasted.detail}`);
        }
        add(true, `Pasted {{${named[0]}}} (${text.length} characters).`);
        continue;
      }

      const frame = await typeText(text);
      if (frame.error) {
        add(false, frame.error);
        return finish(false, `${at}: ${frame.error}`);
      }
      add(true, named.length ? `Typed ${named.map((n) => `{{${n}}}`).join(", ")} (${text.length} characters).` : `Typed ${text.length} characters.`);
      continue;
    }

    // What is left is click and hover, and both need an element.
    if (!step.target) {
      const detail =
        `has no recorded element. A ${step.kind} whose target could not be described was kept in the recording ` +
        `rather than dropped, so that this refusal happens here instead of the step being silently skipped. Re-record it.`;
      add(false, detail);
      return finish(false, `${at}: ${detail}`);
    }

    const { result: found, missing } = await resolve(step, vars);
    if (missing.length > 0) {
      const detail =
        `needs ${missing.map((m) => `{{${m}}}`).join(", ")}, which ${missing.length === 1 ? "was" : "were"} not supplied. ` +
        `Refusing rather than hunting the page for an element literally labelled that.`;
      add(false, detail);
      return finish(false, `${at}: ${detail}`);
    }
    if (!found) {
      add(false, "The browser could not be reached.");
      return finish(false, `${at}: the browser could not be reached.`);
    }
    if (!found.found) {
      const detail = `is not on the page. Recorded as "${step.target.text || step.target.tag}".`;
      add(false, detail);
      return finish(false, `${at}: ${detail}`);
    }
    if (!found.inViewport) {
      const detail = `resolved to (${found.x}, ${found.y}), which is off screen even after scrolling to it. Refusing to click it.`;
      add(false, detail, found.handle, found.text);
      return finish(false, `${at}: ${detail}`);
    }
    if (found.handle === "path" || (found.handle === "class" && !isSemanticClass(step.target.classes?.[0]))) {
      warnings.push(
        `${at} matched only on its ${found.handle === "class" ? "styling class" : "tag path"} — ` +
          `the most volatile handle it has. It will break on Skool's next redeploy; re-record it soon.`,
      );
    }
    if (found.matches > 1) {
      warnings.push(
        `${at} matched ${found.matches} elements on ${found.handle} and took ${step.target.nth === 0 ? "the first" : `number ${step.target.nth + 1}`}. ` +
          `It landed on "${found.text}" — check that is the one you meant.`,
      );
    }

    if (step.kind === "hover") {
      await hover(found.x, found.y);
      add(true, `Hovered "${found.text}".`, found.handle, found.text);
      continue;
    }

    await clickAt(found.x, found.y);
    add(true, `Clicked "${found.text}".`, found.handle, found.text);
  }

  const summary = `${reports.length} step${reports.length === 1 ? "" : "s"} replayed`;
  return finish(true, warnings.length ? `${summary}, with ${warnings.length} warning(s).` : `${summary}.`);
}

/** Look a recipe up by name and replay it. */
export async function replayRecipe(
  name: string,
  vars: ReplayVars = {},
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const recipe = getRecipe(name);
  if (!recipe) {
    return { ok: false, detail: `No action called "${name}" has been taught.`, steps: [], warnings: [] };
  }
  return replaySteps(recipe.steps, vars, opts);
}

/**
 * Which placeholders a taught recipe expects.
 *
 * Lets a caller check a recording carries the fields it is about to be handed,
 * BEFORE it opens a composer — so a recipe taught without a `{{category}}` step
 * is a sentence in the UI rather than a surprise halfway through publishing.
 */
export function recipePlaceholders(name: string): string[] {
  const recipe = getRecipe(name);
  if (!recipe) return [];
  const names = new Set<string>();
  for (const step of recipe.steps) {
    if (step.kind !== "type") continue;
    for (const n of placeholdersIn(step.text ?? "")) names.add(n);
  }
  return [...names];
}
