/**
 * Writing to the community: publishing a post.
 *
 * The composer was mapped by probing the live page (2026-08-05):
 *
 *   feed → "Write something" (a plain div, no role, text runs together as
 *   "Write somethingGo Live") → "Title" input, found by PLACEHOLDER because its
 *   testid is the useless `input-component` every Skool input carries → a
 *   ProseMirror body, so the lesson writer's paste path applies unchanged →
 *   "Select a category" → the category → "Post".
 *
 * ⚠️ THAT MAP IS NOW THE FALLBACK. When the operator has taught a `createPost`
 * action in the teach console, its recording is replayed instead — see
 * `composeTaught`. The mapped path stays because it is what runs before anything
 * has been taught, and because it is the only description of the composer that
 * survives someone deleting the recipe.
 *
 * ⚠️⚠️ THE READ-BACK IS THE POINT, NOT THE CLICKS. The classroom rebuild's most
 * expensive lesson was that `addPage` reported success it had not earned: four
 * pages logged "is in the course" and two of them were not there, and a later
 * bug retitled an existing lesson and appended underneath it while reporting OK
 * every time. A click sequence completing is not a post existing. So this
 * finishes by re-reading the FEED and finding the post by title, and reports
 * failure when it cannot — even though every click "worked".
 */
import { clickButton, clickVisibleText, fillField, appendBody } from "./actions.js";
import { withSkoolPage } from "./browser.js";
import { communityFeedUrl, readFeed, type SkoolPost } from "./community.js";
import { getRecipe, type RecipeStep } from "./recipes.js";
import { isSemanticClass, placeholdersIn, replaySteps, type ReplayResult } from "./replay.js";

export interface PostResult {
  ok: boolean;
  detail: string;
  /** The post as read back from Skool, when it was found. */
  post: SkoolPost | null;
}

const OK = (detail: string, post: SkoolPost | null = null): PostResult => ({ ok: true, detail, post });
const FAIL = (detail: string): PostResult => ({ ok: false, detail, post: null });

const settle = (ms = 800): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Is the composer open? Its Title field is the tell. */
async function composerIsOpen(): Promise<boolean> {
  const found = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      return (Array.from(doc.querySelectorAll("input")) as any[]).some((el) => {
        const ph = (el.getAttribute("placeholder") || "").trim().toLowerCase();
        const r = el.getBoundingClientRect();
        return ph === "title" && r.width > 0 && r.height > 0;
      });
    }),
  );
  return !!found;
}

/**
 * How much text the composer body already holds.
 *
 * ⚠️ THE SAME GUARD AS `bodyMustBeEmpty` IN THE LESSON WRITER, AND FOR THE SAME
 * REASON. That one fired four times in ten pages and each fire was a lesson
 * saved from being overwritten. Skool keeps unsent drafts in the composer, so
 * "the composer opened" does not mean "the composer is blank" — and appending a
 * post underneath somebody's half-written draft publishes both.
 */
async function composerBodyChars(): Promise<number> {
  const n = await withSkoolPage(async (page) =>
    page.evaluate(() => {
      const doc: any = (globalThis as any).document;
      const editors = (Array.from(doc.querySelectorAll("[contenteditable='true']")) as any[]).filter(
        (el) => el.getBoundingClientRect().height > 20,
      );
      if (!editors.length) return -1;
      editors.sort((a: any, b: any) => b.getBoundingClientRect().height - a.getBoundingClientRect().height);
      return String(editors[0].textContent || "").trim().length;
    }),
  );
  return typeof n === "number" ? n : -1;
}

/** Close the composer without publishing. Used when a guard refuses. */
async function cancelComposer(): Promise<void> {
  await clickButton("Cancel").catch(() => undefined);
  await settle(500);
}

/**
 * The taught version of the composer flow, if the operator has recorded one.
 *
 * ⚠️⚠️ A RECORDING BEATS A GUESS AT EXACTLY ONE THING, AND IT IS THE THING THAT
 * KEPT FAILING. The built-in path finds the submit button by looking for a
 * clickable element whose text is "Post" — and every step below "succeeds"
 * merely by finding SOMETHING with that label. A recorded descriptor names the
 * element itself, so a page with several "Post"s on it stops being ambiguous.
 *
 * The guards are NOT part of the recording and run either way. A recording can
 * only carry what the operator did; it cannot carry "and refuse if this post is
 * already on the feed", which is the part that stops a retry double-posting.
 */
const POST_RECIPE = "createPost";

/** How much of the body must survive for the post to count as landed. */
const BODY_LANDED_RATIO = 0.6;

export interface CreatePostInput {
  communityUrl: string;
  title: string;
  body: string;
  /** Must be one of the community's own categories; Skool will not invent one. */
  category: string | null;
}

/**
 * Every `{{field}}` a recording takes from outside.
 *
 * ⚠️ BOTH PLACES A PLACEHOLDER CAN LIVE, WHICH IS NOT ONLY THE TYPED STEPS. The
 * title and body are typed; the CATEGORY is clicked, because it is a menu item
 * labelled with the category name. A scan that looked at typed steps alone
 * would report a perfectly good recording as having no `{{category}}` and warn
 * about a problem that is not there.
 */
function recipeFields(steps: RecipeStep[]): string[] {
  const found = new Set<string>();
  for (const s of steps) {
    for (const p of placeholdersIn(s.text ?? "")) found.add(p);
    for (const p of placeholdersIn(s.target?.text ?? "")) found.add(p);
  }
  return [...found];
}

export interface TaughtPostAction {
  /** Whether a recording exists at all. False means the built-in map runs. */
  taught: boolean;
  /** The name it must be saved under for the publisher to find it. */
  name: string;
  steps: number;
  /** The `{{fields}}` the recording accepts from outside. */
  placeholders: string[];
  /** Fields the publisher supplies that the recording has no step for. */
  missing: string[];
  /**
   * Steps whose element can only be found by a styled-components class or a tag
   * path — the handles that change on Skool's next redeploy. Predicted from the
   * recording rather than measured, since the real handle is only known once a
   * step resolves against a live page; a non-zero count here is a recording
   * worth redoing before it is depended on.
   */
  fragileSteps: number;
  /**
   * Typed fields that were recorded as CLICK targets — a recording that cannot
   * work. See `composeTaught`: the publisher refuses on this, and saying so on
   * the screen means finding out before a posting day rather than during one.
   */
  unclickableFields: string[];
}

/** Typed values can never identify a clicked element. Only a chosen one can. */
function unclickableFieldsIn(steps: RecipeStep[]): string[] {
  return [
    ...new Set(
      steps
        .filter((s) => s.kind === "click" || s.kind === "hover")
        .flatMap((s) => placeholdersIn(s.target?.text ?? ""))
        .filter((f) => f === "title" || f === "body"),
    ),
  ];
}

/** What the publisher will actually do, for a screen that has to say so. */
export function taughtPostAction(): TaughtPostAction {
  const recipe = getRecipe(POST_RECIPE);
  if (!recipe) {
    return {
      taught: false,
      name: POST_RECIPE,
      steps: 0,
      placeholders: [],
      missing: [],
      fragileSteps: 0,
      unclickableFields: [],
    };
  }
  const placeholders = new Set(recipeFields(recipe.steps));
  // A step with no durable handle of its own. A SEMANTIC class counts as one —
  // `skool-editor` is a name somebody chose and survives a redeploy, unlike the
  // `sc-…` hashes beside it, and flagging it trains the reader to ignore this.
  const fragileSteps = recipe.steps.filter(
    (s) =>
      s.target &&
      !s.target.testId &&
      !s.target.ariaLabel &&
      !s.target.placeholder &&
      !s.target.text &&
      !isSemanticClass(s.target.classes?.[0]),
  ).length;
  return {
    taught: true,
    name: POST_RECIPE,
    steps: recipe.steps.length,
    placeholders: [...placeholders],
    missing: ["title", "body", "category"].filter((f) => !placeholders.has(f)),
    fragileSteps,
    unclickableFields: unclickableFieldsIn(recipe.steps),
  };
}

interface ComposeResult {
  ok: boolean;
  detail: string;
}

const COMPOSED = (): ComposeResult => ({ ok: true, detail: "" });
const NOT_COMPOSED = (detail: string): ComposeResult => ({ ok: false, detail });

/**
 * The blank-composer guard, as a replay hook.
 *
 * ⚠️ THE SAME SCAR AS `bodyMustBeEmpty` IN THE LESSON WRITER, WHICH FIRED FOUR
 * TIMES IN TEN PAGES. Skool keeps unsent drafts in the composer, so "the
 * composer opened" does not mean "the composer is blank" — and writing into one
 * publishes somebody's half-finished draft with this post underneath it.
 *
 * It has to run at the moment the body is about to be written: before the
 * replay the composer is not open yet, and after it the post is already gone.
 */
async function refuseIfComposerHoldsADraft(): Promise<string | null> {
  const already = await composerBodyChars();
  if (already <= 40) return null;
  await cancelComposer();
  return (
    `The composer already holds ${already} characters — that is an unsent draft, not a blank post. ` +
    `Refusing to write: continuing would publish it with this post appended underneath.`
  );
}

/** The hand-written composer path. Used when nothing has been taught. */
async function composeBuiltIn(
  input: CreatePostInput,
  title: string,
  body: string,
  step: (s: string) => void,
): Promise<ComposeResult> {
  const opened = await clickVisibleText("Write something", { exact: false });
  if (!opened.ok) return NOT_COMPOSED(`Could not open the composer: ${opened.detail}`);
  await settle(1200);
  if (!(await composerIsOpen())) {
    return NOT_COMPOSED('Clicked "Write something" but no Title field appeared, so the composer is not open.');
  }
  step("Composer open");

  const draft = await refuseIfComposerHoldsADraft();
  if (draft) return NOT_COMPOSED(draft);

  const titled = await fillField("Title", title);
  if (!titled.ok) return NOT_COMPOSED(titled.detail);
  step("Title filled");

  // The composer body is a ProseMirror document, same as a lesson's, so this is
  // the proven paste path: a real `paste` event carrying a DataTransfer. Typing
  // is its fallback and puts raw markdown characters on the page.
  const written = await appendBody(body);
  if (!written.ok) return NOT_COMPOSED(written.detail);
  step("Body pasted");

  if (input.category) {
    const opensCategory = await clickButton("Select a category");
    if (opensCategory.ok) {
      await settle(600);
      const chose = await clickVisibleText(input.category, { exact: true });
      // ⚠️ NOT FATAL, AND SAID OUT LOUD. Skool will publish without a category;
      // an uncategorised post is untidy, a lost post is not recoverable.
      step(chose.ok ? `Category "${input.category}"` : `Category "${input.category}" NOT set: ${chose.detail}`);
      await settle(500);
    } else {
      step(`Category picker did not open: ${opensCategory.detail}`);
    }
  }

  const posted = await clickButton("Post");
  if (!posted.ok) return NOT_COMPOSED(posted.detail);
  step('Clicked "Post"');
  return COMPOSED();
}

/**
 * The taught composer path — replay what the operator demonstrated.
 *
 * ⚠️ THE RECIPE IS CHECKED FOR ITS PLACEHOLDERS BEFORE ANYTHING IS OPENED. A
 * recording made without a `{{title}}` step would replay the title the operator
 * demoed it with, every week, and look like it was working. Refusing up front
 * costs nothing; discovering it from the feed costs a post members can see.
 */
async function composeTaught(
  steps: RecipeStep[],
  input: CreatePostInput,
  title: string,
  body: string,
  step: (s: string) => void,
): Promise<ComposeResult> {
  // ⚠️⚠️ A TYPED FIELD USED AS A CLICK TARGET CAN NEVER RESOLVE, AND IT IS AN
  // EASY MISTAKE TO MAKE. A placeholder on a CLICK means "find the element whose
  // label is this value" — right for the category, whose menu item is labelled
  // with the category name, and impossible for the title or the body, which are
  // typed INTO an input that is empty at the moment it is clicked. The first
  // recording had four such steps and would have died on the first one.
  //
  // Caught here rather than mid-replay because mid-replay is after the composer
  // is open, which leaves a half-filled draft sitting in the community's editor.
  const unclickable = unclickableFieldsIn(steps);
  if (unclickable.length > 0) {
    const which = unclickable.map((f) => `{{${f}}}`).join(" and ");
    return NOT_COMPOSED(
      `The taught "${POST_RECIPE}" action clicks ${which}, which cannot work: a placeholder on a click means ` +
        `"the element labelled with this value", and the title and body are TYPED into a field that is empty when ` +
        `you click it. Mark those on the typing step instead — only the category is picked by clicking its label.`,
    );
  }

  const declared = new Set(recipeFields(steps));
  const missing = ["title", "body"].filter((f) => !declared.has(f));
  if (missing.length > 0) {
    return NOT_COMPOSED(
      `The taught "${POST_RECIPE}" action has no ${missing.map((m) => `{{${m}}}`).join(" or ")} step, so replaying it ` +
        `would publish whatever was typed when it was recorded. Re-record it with the placeholder buttons.`,
    );
  }
  // A category is optional in the composer, so a recording without one is a
  // choice rather than a mistake — but the post will be uncategorised and that
  // should not be a surprise.
  if (input.category && !declared.has("category")) {
    step(`Taught action has no {{category}} step, so "${input.category}" will not be set`);
  }

  const vars: Record<string, string> = { title, body };
  if (input.category) vars.category = input.category;

  const played: ReplayResult = await replaySteps(steps, vars, {
    guard: async (s) => ((s.text ?? "").trim() === "{{body}}" ? refuseIfComposerHoldsADraft() : null),
  });

  // Which handle each step matched on is the useful part of the log: a step
  // that used to match on a testId and now matches on a tag path is about to
  // break, and this is where that becomes visible.
  const weak = played.steps.filter((s) => s.handle === "class" || s.handle === "path").length;
  step(
    `Replayed the taught "${POST_RECIPE}": ${played.steps.filter((s) => s.ok).length}/${steps.length} steps` +
      (weak > 0 ? `, ${weak} on a fragile handle` : ""),
  );
  for (const w of played.warnings) step(`⚠ ${w}`);

  return played.ok ? COMPOSED() : NOT_COMPOSED(played.detail);
}

export async function createPost(input: CreatePostInput): Promise<PostResult> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) return FAIL("A post needs a title.");
  if (body.length < 50) return FAIL(`The body is only ${body.length} characters — refusing to publish that.`);

  const log: string[] = [];
  const step = (s: string): void => {
    log.push(s);
  };

  // ⚠️ REFUSE A DUPLICATE BEFORE OPENING ANYTHING. The agent posts on a timer
  // and a retry after an ambiguous failure is the normal case, so "did this
  // already go out?" has to be answered from Skool, not from our own log.
  const before = await readFeed(input.communityUrl, 1);
  if (before.error) return FAIL(`Could not read the feed first, so nothing was posted: ${before.error}`);
  if (before.posts.some((p) => p.title.trim() === title)) {
    return FAIL(`A post called "${title}" is already on the feed. Not posting it twice.`);
  }
  step(`Feed read: ${before.posts.length} post(s), no duplicate title`);

  // ⚠️⚠️ DO NOT RE-NAVIGATE TO THE PAGE WE ARE ALREADY ON. THIS IS WHY THE
  // FIRST EVER PUBLISH FAILED. `readFeed` above just loaded this exact URL, and
  // Skool is a Next.js SPA: a second `goto` to the identical URL does not commit
  // a fresh navigation, so `domcontentloaded` never fires and the call sits for
  // the full 60s and throws. The symptom is maximally misleading — the browser
  // is healthy and `skoolReadFeed` answers in 3s, so it reads as a dead session
  // or an expired cookie rather than a redundant navigation.
  //
  // Compared by NORMALISED url (trailing slash and #fragment stripped) because
  // Skool echoes the feed back without the slash we may have asked for, and an
  // over-strict compare silently reintroduces the hang.
  const feedUrl = communityFeedUrl(input.communityUrl, 1);
  const sameUrl = (a: string, b: string): boolean =>
    a.split("#")[0].replace(/\/+$/, "") === b.split("#")[0].replace(/\/+$/, "");

  const navigated = await withSkoolPage(async (page) => {
    if (sameUrl(page.url() || "", feedUrl)) return false;
    await page.goto(feedUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return true;
  });
  step(navigated ? "Navigated to the feed" : "Already on the feed");
  await settle(2500);

  const taught = getRecipe(POST_RECIPE);
  const composed = taught
    ? await composeTaught(taught.steps, input, title, body, step)
    : await composeBuiltIn(input, title, body, step);
  if (!composed.ok) return FAIL(`${log.join(" → ")} → ${composed.detail}`);
  await settle(4000);

  // ⚠️ THE ONLY EVIDENCE THAT COUNTS. Read the feed back and find it by title.
  const after = await readFeed(input.communityUrl, 1);
  if (after.error) {
    return FAIL(`${log.join(" → ")} → Posted, but the feed could not be re-read, so the post is UNCONFIRMED: ${after.error}`);
  }
  const landed = after.posts.find((p) => p.title.trim() === title);
  if (!landed) {
    return FAIL(
      `${log.join(" → ")} → Every click worked and "${title}" is NOT on the feed afterwards. ` +
        `Treat this as not posted — but check the community before re-running, because a post that landed late would duplicate.`,
    );
  }
  if (landed.body.trim().length < body.length * BODY_LANDED_RATIO) {
    return FAIL(
      `${log.join(" → ")} → "${title}" is on the feed but reads ${landed.body.trim().length} characters ` +
        `against ${body.length} written. The body did not land in full.`,
    );
  }

  return OK(
    `${log.join(" → ")} → Read back: "${landed.title}" at /${landed.slug}, ${landed.body.trim().length} characters.`,
    landed,
  );
}
